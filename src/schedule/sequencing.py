"""Petri 标识图定序（兼容单臂与双臂换片）+ 可搜索候选解码器。

单臂机器手一次只持一片：要把上游片搬进某腔，该腔必须先空。于是对一条流水顺序
LA→PM1→LB，唯一无死锁的机器手节拍是「先把 PM1 的片搬到 LB（清空 PM1），再退回
LA 把片搬进 PM1」——下游 hop 先于上游 hop 的 backward 节拍。

旧占位定序（按「松弛最早时刻」给各资源各自独立排序）在 ≥2 片时会让某资源的
「装入序」与腔的「占用序」互相矛盾 → 差分图出现正环 → 报死锁。这里改成一次全局
事件式构造，产出彼此自洽的各资源占用序，结构上即无死锁：
  · 流水线性（吞吐）：按「最早可起」派工，腔加工期间机器手回头发上游片；
  · 无死锁（正确性）：把晶圆、腔槽和 hop 分别表示成 token、容量库所和变迁；候选
    变迁模拟发射后，只有仍能到达「所有 token 完工」终态的动作才进入动作掩码。

资源粒度：每个 (腔,槽) 视作容量 1 的占用单元（与 _expand 的 round-robin 定槽、与
milp.py 的腔互斥口径一致）；source/sink 与 loadport/buffer/dummyport 不占资源。

把定死的 backward 规则改成「可搜索」：解码器 decode_orders 每步先用 Petri 可达性生成
安全动作掩码，再把候选 hop 交给 chooser 排序。同一候选合法性供默认规则、teacher 和 policy 共用。

固定腔走 decode_orders；动态选腔走 decode_orders_choosing；两者确定顺序后均交给 solve_timing 定时。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from collections import namedtuple
from types import MappingProxyType
from typing import Callable, Dict, List, Mapping, Optional, Tuple

from src.parse.model import Durations, Problem

from src.timing._common import SKIP_TYPES, _DecodeDeadlock
from src.timing.spans import _hop_span, _stage_dwell


# --------------------------------------------------------------------------- #
# 资源键：每片每 stage 占用的 (腔,槽)
# --------------------------------------------------------------------------- #
def _skip_chambers(ir: Problem) -> set:
    """跳过类（loadport/buffer/dummyport）或不存在的腔名集合，按 ir 缓存一次（热点 _resource 每解码
    被调数百万次，原先每次 ir.chambers.get + str(type).lower() 是大头）。口径同 SKIP_TYPES 判定。"""
    s = getattr(ir, "_skip_chambers_cache", None)
    if s is None:
        s = {name for name, ch in ir.chambers.items()
             if str(ch.type).lower() in SKIP_TYPES}
        ir._skip_chambers_cache = s                # type: ignore[attr-defined]
    return s


def _resource(ir: Problem, w, j: int) -> Optional[Tuple[str, int]]:
    """晶圆 w 在 stage j 占用的 (腔,槽)；不计资源（源/汇/跳过类站点）返回 None。
    用预算好的跳过腔集合快速判定（行为与原 ir.chambers.get + type.lower() 完全一致）。"""
    s = w.stages[j]
    if s.stage_type == "sink" or (s.stage_type == "source" and not w.already_released):
        return None
    c = s.chamber
    if c not in ir.chambers or c in _skip_chambers(ir):
        return None
    return (c, s.slot)


@dataclass
class _Orders:
    chambers: Dict[Tuple[str, int], List[Tuple[int, int]]]
    robots: Dict[str, List[Tuple[int, int]]]
    # loadlock 每腔跨槽合并的占用提交序 腔→[(wid, stage)]：entry/exit 分槽共存（swap）后，
    # 同槽序管不到异型相邻占用，solve_timing 靠它补跨槽压力态边。
    ll_seq: Dict[str, List[Tuple[int, int]]] = field(default_factory=dict)
    # 双臂加工腔原子换片，由 solve_timing 从既有安全顺序中识别并填充：
    # [((入片 wid, 入片前 stage), (出片 wid, PM stage), PM 名)]。
    process_swaps: List[
        Tuple[Tuple[int, int], Tuple[int, int], str]
    ] = field(default_factory=list)


# —— 可注入决策的解码：每步先做 Petri 可达性掩码，再把安全候选交给 chooser 排序提交。
# 同一候选合法性供三方共用：默认(start+bias 排序)、teacher(MILP 序，标签提取)、policy(网络打分，推理)。
# _Cand.start 是真实最早可起（不含 bias，提交时直接用）；chooser 只决定偏好序，不改时刻。
_Cand = namedtuple("_Cand", "wid j dest rob start")


@dataclass
class _DecodeState:
    """解码到某一步时的全局状态快照（只读，供 chooser/特征提取用）。"""
    ir: Problem
    tm: Durations
    wmap: Dict[int, object]
    K: Dict[int, int]
    pos: Dict[int, int]
    occ: Dict[Tuple[str, int], int]
    resv: Dict[Tuple[str, int], int]
    place_t: Dict[int, float]
    robot_free: Dict[str, float]
    placed: int
    total: int
    reserve: bool
    # 选腔模式下（labels/policy）各腔累计被派入的片数，供 step_features 的选腔均衡特征用；
    # 默认/backward 定序不选腔 ⇒ None（特征退化为 0，对这些路径零影响）。
    ch_used: Optional[Dict[str, int]] = None
    # 已提交的资源顺序以不可变快照暴露。策略可据此增加析取边，但不能改写解码器状态。
    chamber_orders: Mapping[Tuple[str, int], Tuple[Tuple[int, int], ...]] = field(
        default_factory=dict
    )
    robot_orders: Mapping[str, Tuple[Tuple[int, int], ...]] = field(default_factory=dict)
    loadlock_orders: Mapping[str, Tuple[Tuple[int, int], ...]] = field(default_factory=dict)
    # 轻量 LoadLock manager 只需要每把锁最后一次服务及累计次数，不必在每个动作
    # 复制完整历史序列。两个映射均为当前事件边界的不可变快照。
    loadlock_last_services: Mapping[str, Tuple[int, int]] = field(default_factory=dict)
    loadlock_service_counts: Mapping[str, int] = field(default_factory=dict)
    # 各锁最近一次已提交服务（含关门、抽/充气、开门）的近似完成时刻。
    # LoadLock manager 用它计算动态 ETA；缺省空映射保持旧 chooser 兼容。
    loadlock_ready_at: Mapping[str, float] = field(default_factory=dict)
    # 动态选腔解码器维护的增量路线统计。策略特征优先读取它们，避免每个动作都重新扫描
    # 全部晶圆；未提供时仍可从 pos 回算，保持其他调用方兼容。
    route_released: Optional[Mapping[str, int]] = None
    route_wip: Optional[Mapping[str, int]] = None


# chooser(state, cands) → 候选索引的偏好序（最优在前）。
_Chooser = Callable[[_DecodeState, List[_Cand]], List[int]]


@dataclass
class _PetriMarking:
    """定序 Petri 网的标识：token 位置、容量库所占用和驻留预留。"""

    pos: Dict[int, int]
    occ: Dict[Tuple[str, int], int]
    resv: Dict[Tuple[str, int], int]
    ll_age: Optional[Dict[Tuple[str, int], int]]

    def clone(self) -> "_PetriMarking":
        return _PetriMarking(
            dict(self.pos),
            dict(self.occ),
            dict(self.resv),
            dict(self.ll_age) if self.ll_age is not None else None,
        )


# —— 驻留(qtime)预留：单臂下，共享 loadlock 既进又出，新片的「进」易抢在在制片的「出」
# 之前，把片闷在加工腔里超驻留。对策：片一进入驻留腔（run），就把它出口去向资源（紧邻下一
# 跳 + 驻留 run 末端的落脚资源）预留下来，挡住别的片占用，保证其能按时离腔。仅 reserve=True
# 时启用（在快序驻留不可行时回退采用，见 start_schedule）。
def _is_resid(w, k: int) -> bool:
    return (0 <= k < len(w.stages) and w.stages[k].stage_type == "process"
            and w.stages[k].residency > 0)


def _reserve_for(ir: Problem, w, nj: int, res_map=None) -> set:
    """片放入 stage nj 后应预留的资源：紧邻下一跳 + 驻留 run（连续驻留腔）末端的落脚资源。
    res_map：解码用的 (wid,j)→资源键表（含 swap 并槽口径），传入保证预留键与占用键一致。"""
    if not _is_resid(w, nj):
        return set()

    def _res(j: int):
        return res_map[(w.wid, j)] if res_map is not None else _resource(ir, w, j)

    out = set()
    K = len(w.stages) - 1
    if nj + 1 <= K:                              # 紧邻下一跳去向
        r = _res(nj + 1)
        if r is not None:
            out.add(r)
    k = nj
    while _is_resid(w, k):                       # 跨过连续驻留腔，预留 run 出口
        k += 1
    if k <= K:
        r = _res(k)
        if r is not None:
            out.add(r)
    return out


def _blocked(dest, occ: dict, resv: dict, wid: int) -> bool:
    """去向资源被占用、或被别的片预留 ⇒ 当前片不可放入。"""
    if dest is None:
        return False
    return dest in occ or (dest in resv and resv[dest] != wid)


def _deadlock_diagnostic(
    ir: Problem,
    wmap: Mapping[int, object],
    K: Mapping[int, int],
    pos: Mapping[int, int],
    occ: Mapping[Tuple[str, int], int],
    *,
    placed: int,
    total: int,
) -> str:
    """给失败恢复留下紧凑的 Petri 标识，便于定位实时续排结构性死锁。"""
    unfinished = []
    for wid in sorted(pos):
        j = pos[wid]
        if j >= K[wid]:
            continue
        wafer = wmap[wid]
        source = _resource(ir, wafer, j)
        destination = wafer.stages[j + 1]
        unfinished.append(
            f"{wid}@{j}:{source}->{destination.stage_type}/"
            f"{destination.chamber}#{destination.slot}"
        )
        if len(unfinished) >= 12:
            break
    occupied_items = []
    for resource, wid in sorted(occ.items()):
        wafer = wmap.get(wid)
        if wafer is None:
            occupied_items.append(f"{resource[0]}#{resource[1]}={wid}")
            continue
        j = pos.get(wid, -1)
        if 0 <= j < K.get(wid, 0):
            destination = wafer.stages[j + 1]
            occupied_items.append(
                f"{resource[0]}#{resource[1]}={wid}@{j}/{K[wid]}"
                f"->{destination.stage_type}/{destination.chamber}"
            )
        else:
            occupied_items.append(f"{resource[0]}#{resource[1]}={wid}@{j}/{K.get(wid)}")
    occupied = ", ".join(occupied_items)
    return (
        f"placed={placed}/{total}; occ=[{occupied}]; "
        f"unfinished=[{', '.join(unfinished)}]"
    )


def _build_resource_map(ir: Problem, wmap: Dict[int, object], swap: bool = False
                        ) -> Dict[Tuple[int, int], Optional[Tuple[str, int]]]:
    """预算每片每 stage 的 (腔,槽) 资源键一次。解码内热点 _drain_completes 被调数万次、每次 O(剩余)
    遍历，原先每格重算 _resource（数百万次）；预算后改 dict 查表，是解码提速的大头。
    swap=False（默认）：loadlock 并槽为 (腔,0)——entry/exit 整腔互斥（旧口径，逐字节复现）；
    swap=True：容量至少 2 时按 s.slot 分槽（entry=0/exit=1），异型占用可共存；
    单槽 LoadLock 仍合并到槽 0，不能生成不存在的第二物理槽。"""
    out: Dict[Tuple[int, int], Optional[Tuple[str, int]]] = {}
    for w in wmap.values():
        for j in range(len(w.stages)):
            r = _resource(ir, w, j)
            chamber = ir.chambers.get(r[0]) if r is not None else None
            if (
                r is not None
                and chamber is not None
                and str(chamber.type).lower() == "loadlock"
                and (
                    not swap
                    or int(getattr(chamber, "capacity", 1) or 1) < 2
                )
            ):
                r = (r[0], 0)
            out[(w.wid, j)] = r
    return out


def _process_predecessors(wafers) -> Dict[Tuple[int, int], Tuple[int, int]]:
    """建立同一路线同一加工工序的前片约束，禁止后片越过前片进入 PM。

    重算会裁掉每片已经完成的路线前缀，因此使用 ``resume_stage_index + j`` 恢复原始
    工序编号；已经越过该加工工序的晶圆不会进入当前分组，也不会错误阻塞剩余晶圆。
    """
    grouped: Dict[Tuple[str, int], List[Tuple[int, int, int]]] = {}
    for wafer in wafers:
        for stage_index, stage in enumerate(wafer.stages):
            if stage.stage_type != "process":
                continue
            absolute_stage_index = wafer.resume_stage_index + stage_index
            grouped.setdefault((wafer.route_name, absolute_stage_index), []).append(
                (wafer.route_rank, wafer.wid, stage_index)
            )
    predecessors: Dict[Tuple[int, int], Tuple[int, int]] = {}
    for visits in grouped.values():
        visits.sort()
        for previous, current in zip(visits, visits[1:]):
            _, previous_wid, previous_stage = previous
            _, current_wid, current_stage = current
            predecessors[(current_wid, current_stage)] = (previous_wid, previous_stage)
    return predecessors


def _process_entry_blocked(
    process_predecessors: Dict[Tuple[int, int], Tuple[int, int]],
    pos: Dict[int, int],
    wid: int,
    destination_stage: int,
) -> bool:
    """判断前一片是否尚未进入同一加工工序。"""
    predecessor = process_predecessors.get((wid, destination_stage))
    return predecessor is not None and pos[predecessor[0]] < predecessor[1]


def _ll_elder_blocked(src: Optional[Tuple[str, int]], occ: dict,
                      ll_age: Optional[Dict[Tuple[str, int], int]]) -> bool:
    """LL swap 的「先进先出」规则：片在 LL 某槽、兄弟槽被【更早进腔】的片占着 ⇒ 本片不可离腔。
    压力态按占用顺序服务（elder 的抽/充先完成、先被取走），Edge②(solve_timing) 也按此建边；
    解码提交序遵守同一规则才不会与压力边成环。ll_age 只在 swap 模式登记 LL 槽 ⇒ 其余恒 False。"""
    if ll_age is None or src is None or src not in ll_age:
        return False
    sib = (src[0], 1 - src[1])
    return sib in occ and ll_age.get(sib, 1 << 60) < ll_age[src]


def _seed_initial_loadlock_order(
    ir: Problem,
    wafers,
    K: Mapping[int, int],
    resources: Mapping[int, Optional[Tuple[str, int]]],
    ll_seq: Dict[str, List[Tuple[int, int]]],
    ll_age: Optional[Dict[Tuple[str, int], int]],
) -> None:
    """按剩余拓扑距离恢复重算切点的 LoadLock 槽间服务顺序。

    实时状态只保存两槽当前占用，并不保存它们的历史入腔序。直接按本轮临时 ``wid``
    猜测 FIFO 会把出站槽误判为较新，从而在 LL 与 PM 全满时人为制造闭锁。对无回流
    路线，距离 sink 更近的 token 必须先排空；同距离再沿用业务路线顺序，得到稳定且
    与 backward blocking-flow 定序一致的初始压力边。
    """
    occupied = []
    for wafer in wafers:
        if not wafer.already_released:
            continue
        source = resources.get(wafer.wid)
        if source is None:
            continue
        chamber = ir.chambers.get(source[0])
        if chamber is None or str(chamber.type).lower() != "loadlock":
            continue
        first = wafer.stages[0]
        occupied.append(
            (
                source[0],
                int(first.ll_type != "exit"),
                int(K[wafer.wid]),
                int(wafer.route_rank),
                int(wafer.wid),
                source,
            )
        )

    ordered = sorted(occupied)
    for age, item in enumerate(ordered, start=-len(ordered)):
        loadlock, _direction, _remaining, _rank, wid, source = item
        ll_seq.setdefault(loadlock, []).append((wid, 0))
        if ll_age is not None:
            ll_age[source] = age


class _PetriFeasibility:
    """只处理动作可行性与可达性，不处理时间。

    每个晶圆是一个 token，``pos`` 是其工艺库所；容量为一的 ``(腔, 槽)``
    是资源库所；候选 hop 是变迁。动作掩码先发射候选变迁，再用
    下游优先的消空序验证终态是否仍可达。时间统一留给 :func:`solve_timing`。
    """

    def __init__(self, ir: Problem, wmap, K, res_map, *, reserve: bool,
                 process_predecessors, release_predecessors):
        self.ir = ir
        self.wmap = wmap
        self.K = K
        self.res_map = res_map
        self.reserve = reserve
        self.process_predecessors = process_predecessors
        self.release_predecessors = release_predecessors

    def fire(self, marking: _PetriMarking, candidate: _Cand,
             age: int) -> _PetriMarking:
        """在副本上发射一个原子 pick-place 变迁。"""
        out = marking.clone()
        self._fire_in_place(out, candidate, age)
        return out

    def _fire_in_place(
        self,
        marking: _PetriMarking,
        candidate: _Cand,
        age: int,
    ) -> None:
        """在隔离的模拟标识上原地发射，避免终态搜索每一步重复复制字典。"""
        wid, j, dest = candidate.wid, candidate.j, candidate.dest
        src = self.res_map[(wid, j)]
        if src is not None and marking.occ.get(src) == wid:
            del marking.occ[src]
            if marking.ll_age is not None:
                marking.ll_age.pop(src, None)
        if dest is not None and marking.resv.get(dest) == wid:
            del marking.resv[dest]
        if dest is not None:
            marking.occ[dest] = wid
            if (marking.ll_age is not None
                    and self.wmap[wid].stages[j + 1].stage_type == "loadlock"):
                marking.ll_age[dest] = age
        if self.reserve:
            for resource in _reserve_for(
                self.ir, self.wmap[wid], j + 1, self.res_map
            ):
                marking.resv[resource] = wid
        marking.pos[wid] = j + 1

    def _transition_enabled(self, marking: _PetriMarking, wid: int) -> bool:
        j = marking.pos[wid]
        if j >= self.K[wid]:
            return False
        wafer = self.wmap[wid]
        if j == 0:
            predecessor = self.release_predecessors.get(wid)
            if predecessor is not None and marking.pos[predecessor] < 1:
                return False
            if any(
                any(other.cjob_id == blocker
                    and marking.pos[other.wid] < self.K[other.wid]
                    for other in self.wmap.values())
                for blocker in wafer.dispatch_after
            ):
                return False
        if (wafer.stages[j + 1].stage_type == "process"
                and _process_entry_blocked(
                    self.process_predecessors, marking.pos, wid, j + 1
                )):
            return False
        dest = self.res_map[(wid, j + 1)]
        if _blocked(dest, marking.occ, marking.resv, wid):
            return False
        return not _ll_elder_blocked(
            self.res_map[(wid, j)], marking.occ, marking.ll_age
        )

    def can_reach_final(self, marking: _PetriMarking, age: int) -> bool:
        """验证该标识能否沿纯下游发射序到达所有 token 的终态。"""
        marking = marking.clone()
        remaining = sum(self.K[wid] - marking.pos[wid] for wid in marking.pos)
        while remaining:
            enabled = [wid for wid in marking.pos
                       if self._transition_enabled(marking, wid)]
            if not enabled:
                return False
            wid = min(enabled, key=lambda item: (-marking.pos[item], item))
            j = marking.pos[wid]
            wafer = self.wmap[wid]
            candidate = _Cand(wid, j, self.res_map[(wid, j + 1)],
                              wafer.transports[j], 0.0)
            self._fire_in_place(marking, candidate, age)
            age += 1
            remaining -= 1
        return True

    def safe_candidates(self, marking: _PetriMarking,
                        candidates: List[_Cand], age: int) -> List[_Cand]:
        """Petri 动作掩码：只保留发射后终态仍可达的变迁。"""
        return [candidate for candidate in candidates
                if self.can_reach_final(self.fire(marking, candidate, age), age + 1)]


def decode_orders(ir: Problem,
                  tm: Durations,
                  wafers,
                  *,
                  chooser: Optional[_Chooser] = None,
                  reserve: bool = False,
                  swap: bool = False,
                  first_safe_by_preference: bool = False,
                  trust_preferred_path: bool = False,
                  enforce_resumed_route_fifo: bool = True) -> _Orders:
    """全局事件式构造：产出各 (腔,槽) 占用序与各机器手 hop 序（彼此自洽、无死锁）。每步生成
    合法候选(去向资源未占/未预留、j==0 满足发片 FIFO)，再经 Petri 终态可达性掩码后交
    chooser 排偏好序。换 chooser 不会绕过动作可行性约束。

    本模块唯一的对外入口，覆盖三种用法：
      · decode_orders(ir, tm, wafers)                         —— 默认 backward 定序
      · decode_orders(ir, tm, wafers, reserve=True)            —— 启用驻留出口预留
      · decode_orders(ir, tm, wafers, chooser=自定义) —— teacher/policy 等自定义候选打分
    chooser 缺省 None 时按「近似最早可起、下游优先、wid」排序。

    reserve=True 时额外做驻留(qtime)预留（牺牲吞吐换驻留可行），仅在快序驻留不可行时回退采用。
    候选的首选动作会直接提交；中途卡死抛 _DecodeDeadlock 由调用方判负。
    swap：True=loadlock 双槽按方向分槽（entry=0/exit=1），异型占用可共存——真空手可先放已加工片
    再取未加工片（压力态时序由 solve_timing 按 ll_seq 补边）；False（默认）=LL 整腔互斥（旧口径）。
    first_safe_by_preference：按 chooser 偏好依次检查候选，找到第一个安全动作即停止。适用于
    偏好不依赖安全候选集合的启发式，可避免为最终不会选择的动作重复做完整终态可达性搜索。
    trust_preferred_path：直接提交 chooser 的首选动作；调用方必须在死锁时用完整安全检查重试。
    若首选路径能走到终态，则路径上的每个动作本身即有该后续路径作为可达性证明。
    enforce_resumed_route_fifo：默认保持历史行为，让实时续排晶圆的裁剪后首跳也按 Route FIFO；
    L2D 设为 False，只对尚未发片晶圆应用真正的 LoadPort 发片 FIFO。
    """
    if chooser is None:
        def chooser(_state: _DecodeState, candidates: List[_Cand]) -> List[int]:
            return sorted(range(len(candidates)), key=lambda i: (
                candidates[i].start, -candidates[i].j, candidates[i].wid
            ))
    wmap = {w.wid: w for w in wafers}
    K = {w.wid: len(w.stages) - 1 for w in wafers}
    res_map = _build_resource_map(ir, wmap, swap)  # (wid,j)→资源键，预算一次供候选/可达性模拟复用
    pos = {w.wid: 0 for w in wafers}            # 各片当前所在 stage
    process_predecessors = _process_predecessors(wafers)
    place_t = {w.wid: 0.0 for w in wafers}      # 各片落位到当前 stage 的（近似）时刻
    occ: Dict[Tuple[str, int], int] = {}        # (腔,槽) → 当前占用片
    resv: Dict[Tuple[str, int], int] = {}       # (腔,槽) → 为其出口预留该资源的片
    robot_free: Dict[str, float] = {}           # 机器手下次空闲（近似）时刻
    # swap 模式：LL 槽 → 进腔序号（提交计数）。离腔须遵守先进先出（_ll_elder_blocked），
    # 保证提交序与 solve_timing 的跨槽压力边同向、结构上无正环。非 swap 恒空。
    ll_age: Optional[Dict[Tuple[str, int], int]] = {} if swap else None

    # 同 route 按 wid 先来先发（与 solve_timing 的发片 FIFO 一致）
    route_wids: Dict[str, List[int]] = {}
    for w in wafers:
        if enforce_resumed_route_fifo or not w.already_released:
            route_wids.setdefault(w.route_name, []).append(w.wid)
    for v in route_wids.values():
        v.sort()
    next_rel = {r: 0 for r in route_wids}
    release_predecessors = {
        current: previous
        for route in route_wids.values()
        for previous, current in zip(route, route[1:])
    }
    petri = _PetriFeasibility(
        ir, wmap, K, res_map, reserve=reserve,
        process_predecessors=process_predecessors,
        release_predecessors=release_predecessors,
    )

    # 多容量加工腔的门簇互斥(Cd)未建模——与旧版口径一致，命中时告警
    multi_cap_proc = sorted({s.chamber for w in wafers for s in w.stages
                             if s.stage_type == "process"
                             and (ir.chambers.get(s.chamber) is not None)
                             and int(ir.chambers[s.chamber].capacity) > 1})
    if multi_cap_proc:
        print(f"[timing][告警] 多容量加工腔 {multi_cap_proc} 的门簇互斥(Cd)未建模，"
              f"makespan 可能偏乐观。")

    chambers: Dict[Tuple[str, int], List[Tuple[int, int]]] = {}
    robots: Dict[str, List[Tuple[int, int]]] = {}
    ll_seq: Dict[str, List[Tuple[int, int]]] = {}
    initial_age = 0
    for w in wafers:
        if not w.already_released:
            continue
        source = res_map[(w.wid, 0)]
        if source is None:
            continue
        if source in occ:
            raise RuntimeError(f"[timing] 初始资源 {source} 同时被多片晶圆占用")
        occ[source] = w.wid
        chambers.setdefault(source, []).append((w.wid, 0))
        if str(ir.chambers[source[0]].type).lower() == "loadlock":
            ll_seq.setdefault(source[0], []).append((w.wid, 0))
            if ll_age is not None:
                ll_age[source] = initial_age
                initial_age += 1

    total = sum(K.values())
    placed = 0
    # ============== 主循环 ==================
    # total: 晶圆总共需要移动的次数
    while placed < total:
        # 候选 hop：去向腔未被占/预留（单臂可放）、且 j==0 时满足发片 FIFO
        cands: List[_Cand] = []
        for w in wafers:
            wid = w.wid
            j = pos[wid]
            # 晶圆已经加工完成
            if j >= K[wid]:
                continue
            if j == 0 and not w.already_released and any(
                any(x.cjob_id == blocker and pos[x.wid] < K[x.wid] for x in wafers)
                for blocker in w.dispatch_after
            ):
                continue
            # 若下一道工序是加工，不允许超片
            if (w.stages[j + 1].stage_type == "process" and _process_entry_blocked(process_predecessors, pos, wid, j + 1)):
                continue
            dest = res_map[(wid, j + 1)]
            # 去向资源被占用、或被别的片预留 ⇒ 当前片不可放入。
            if _blocked(dest, occ, resv if reserve else {}, wid):
                continue
            if _ll_elder_blocked(res_map[(wid, j)], occ, ll_age):
                continue
            if (
                j == 0
                and (enforce_resumed_route_fifo or not w.already_released)
                and route_wids[w.route_name][next_rel[w.route_name]] != wid
            ):
                continue
            rob = w.transports[j]
            start = max(place_t[wid] + _stage_dwell(tm, w, j), robot_free.get(rob, 0.0))
            cands.append(_Cand(wid, j, dest, rob, start))

        if not cands:                      # 无可动 hop 却未完工
            raise _DecodeDeadlock(
                _deadlock_diagnostic(
                    ir,
                    wmap,
                    K,
                    pos,
                    occ,
                    placed=placed,
                    total=total,
                )
            )                              # 该候选序死锁，搜索判负

        state = _DecodeState(
            ir,
            tm,
            wmap,
            K,
            pos,
            occ,
            resv,
            place_t,
            robot_free,
            placed,
            total,
            reserve,
            chamber_orders=MappingProxyType(
                {resource: tuple(sequence) for resource, sequence in chambers.items()}
            ),
            robot_orders=MappingProxyType(
                {robot: tuple(sequence) for robot, sequence in robots.items()}
            ),
            loadlock_orders=MappingProxyType(
                {loadlock: tuple(sequence) for loadlock, sequence in ll_seq.items()}
            ),
        )

        marking = _PetriMarking(pos, occ, resv if reserve else {}, ll_age)
        if trust_preferred_path:
            order = chooser(state, cands)
            if not order:
                raise ValueError("chooser 必须返回至少一个候选索引")
            if any(index < 0 or index >= len(cands) for index in order):
                raise IndexError("chooser 返回了超出候选范围的索引")
            chosen = cands[order[0]]
        elif first_safe_by_preference:
            # 启发式的偏好键不依赖安全候选集合，因此“先排序、再取首个安全”
            # 与“先筛出全部安全候选、再排序”的最终选择完全一致。
            order = chooser(state, cands)
            chosen = next(
                (
                    cands[index]
                    for index in order
                    if 0 <= index < len(cands)
                    and petri.can_reach_final(
                        petri.fire(marking, cands[index], placed),
                        placed + 1,
                    )
                ),
                None,
            )
            if chosen is None:
                if any(index < 0 or index >= len(cands) for index in order):
                    raise IndexError("chooser 返回了超出候选范围的索引")
                raise RuntimeError("[timing] Petri 标识无可达终态的使能变迁")
        else:
            # 策略模型可能依赖完整安全动作集合，仍保持先生成动作掩码的原有口径。
            cands = petri.safe_candidates(marking, cands, placed)
            if not cands:
                raise RuntimeError("[timing] Petri 标识无可达终态的使能变迁")
            order = chooser(state, cands)
            if not order:
                raise ValueError("chooser 必须返回至少一个候选索引")
            if any(index < 0 or index >= len(cands) for index in order):
                raise IndexError("chooser 返回了超出候选范围的索引")
            chosen = cands[order[0]]

        if not order:
            raise ValueError("chooser 必须返回至少一个候选索引")

        wid, j, dest, rob, start = chosen
        w = wmap[wid]
        src = res_map[(wid, j)]
        if src is not None and occ.get(src) == wid:
            del occ[src]
            if ll_age is not None:
                ll_age.pop(src, None)
        if dest is not None and resv.get(dest) == wid:
            del resv[dest]
        if dest is not None:
            occ[dest] = wid
            chambers.setdefault(dest, []).append((wid, j + 1))   # 到站 stage = j+1
            if w.stages[j + 1].stage_type == "loadlock":
                ll_seq.setdefault(dest[0], []).append((wid, j + 1))
                if ll_age is not None:
                    ll_age[dest] = placed
        if reserve:
            for er in _reserve_for(ir, w, j + 1, res_map):
                resv[er] = wid
        robots.setdefault(rob, []).append((wid, j))
        place_t[wid] = start + _hop_span(tm, w, j)
        robot_free[rob] = place_t[wid]
        if j == 0 and (enforce_resumed_route_fifo or not w.already_released):
            next_rel[w.route_name] += 1
        pos[wid] = j + 1
        placed += 1

    return _Orders(chambers=chambers, robots=robots, ll_seq=ll_seq)


# --------------------------------------------------------------------------- #
# 选腔解码：把「去向腔」也做成每步决策（loadlock LA/LB、并行 PM）。候选按去向 stage 的候选腔
# 分裂，chooser 联合选 (hop, 腔)；提交把选中腔写回 stage（chamber/slot/loadlock proc）。与固定腔
# 的 decode_orders 分开实现——后者是热点、口径严格零回归，不掺动态腔分支。labels 的 teacher 复现
# 走同一候选口径（跟随 MILP 腔），policy 推理走本函数（网络打分选腔）。
# --------------------------------------------------------------------------- #
def _chamber_pool(nxt) -> List[str]:
    """去向 stage 的候选腔池（供 BC 选腔解码与标签 teacher 统一口径）：
    仅 loadlock 放开多候选让策略选腔；加工腔按 round-robin 固定单候选（加工腔不选腔）。
    source/sink/skip 去向由 _resource 返回 None 提前拦掉，不进本函数。"""
    if nxt.stage_type == "loadlock" and len(nxt.cands) > 1:
        return list(nxt.cands)
    return [nxt.chamber]


def _free_slot(ir: Problem, occ: dict, cc: str, nxt, swap: bool = False) -> Optional[int]:
    """去向 stage nxt 落腔 cc 的可用槽位，无空槽返回 None。

    LoadLock 容量至少 2 且 ``swap=True`` 时按方向分槽；单槽锁或 ``swap=False``
    始终使用槽 0，防止导出不存在的物理槽。其余腔取最小空槽。
    """
    if nxt.stage_type == "loadlock":
        chamber = ir.chambers.get(cc)
        capacity = int(getattr(chamber, "capacity", 1) or 1)
        s = (
            0 if nxt.ll_type == "entry" else 1
        ) if swap and capacity >= 2 else 0
        return None if (cc, s) in occ else s
    ch = ir.chambers.get(cc)
    cap = int(ch.capacity) if ch else 1
    return next((s for s in range(max(cap, 1)) if (cc, s) not in occ), None)


def _dynamic_petri_reaches_final(
    ir: Problem, wmap, K, marking: _PetriMarking,
    selected: Dict[Tuple[int, int], Tuple[str, int]], *, swap: bool,
    process_predecessors, release_predecessors, age: int,
) -> bool:
    """选腔版 Petri 可达性：未来未定的 LL 变迁可落任一空候选库所。"""
    marking = marking.clone()
    selected = dict(selected)

    def current_resource(wid: int):
        j = marking.pos[wid]
        return selected.get((wid, j), _resource(ir, wmap[wid], j))

    remaining = sum(K[wid] - marking.pos[wid] for wid in marking.pos)
    while remaining:
        enabled = []
        for wid, j in marking.pos.items():
            if j >= K[wid]:
                continue
            wafer = wmap[wid]
            if j == 0:
                predecessor = release_predecessors.get(wid)
                if predecessor is not None and marking.pos[predecessor] < 1:
                    continue
                if any(
                    any(other.cjob_id == blocker
                        and marking.pos[other.wid] < K[other.wid]
                        for other in wmap.values())
                    for blocker in wafer.dispatch_after
                ):
                    continue
            if (wafer.stages[j + 1].stage_type == "process"
                    and _process_entry_blocked(
                        process_predecessors, marking.pos, wid, j + 1
                    )):
                continue
            if _ll_elder_blocked(current_resource(wid), marking.occ, marking.ll_age):
                continue
            base = _resource(ir, wafer, j + 1)
            destinations = [None]
            if base is not None:
                nxt = wafer.stages[j + 1]
                destinations = []
                for chamber in _chamber_pool(nxt):
                    slot = _free_slot(ir, marking.occ, chamber, nxt, swap)
                    if slot is not None:
                        destinations.append((chamber, slot))
            if destinations:
                enabled.append((wid, destinations))
        if not enabled:
            return False

        wid, destinations = min(
            enabled, key=lambda item: (-marking.pos[item[0]], item[0])
        )
        j = marking.pos[wid]
        dest = destinations[0]
        src = current_resource(wid)
        if src is not None and marking.occ.get(src) == wid:
            del marking.occ[src]
            if marking.ll_age is not None:
                marking.ll_age.pop(src, None)
        if dest is not None:
            marking.occ[dest] = wid
            selected[(wid, j + 1)] = dest
            if (marking.ll_age is not None
                    and wmap[wid].stages[j + 1].stage_type == "loadlock"):
                marking.ll_age[dest] = age
        marking.pos[wid] = j + 1
        age += 1
        remaining -= 1
    return True


def _dynamic_petri_safe_candidates(
    ir: Problem, wmap, K, pos, occ, ll_age, candidates, *, swap: bool,
    process_predecessors, release_predecessors, age: int,
) -> List[_Cand]:
    """模拟候选变迁发射，生成动态选腔解码的安全动作掩码。"""
    safe = []
    for candidate in candidates:
        marking = _PetriMarking(dict(pos), dict(occ), {},
                                dict(ll_age) if ll_age is not None else None)
        src = _resource(ir, wmap[candidate.wid], candidate.j)
        if src is not None and marking.occ.get(src) == candidate.wid:
            del marking.occ[src]
            if marking.ll_age is not None:
                marking.ll_age.pop(src, None)
        selected = {}
        if candidate.dest is not None:
            marking.occ[candidate.dest] = candidate.wid
            selected[(candidate.wid, candidate.j + 1)] = candidate.dest
            if (marking.ll_age is not None
                    and wmap[candidate.wid].stages[candidate.j + 1].stage_type == "loadlock"):
                marking.ll_age[candidate.dest] = age
        marking.pos[candidate.wid] = candidate.j + 1
        if _dynamic_petri_reaches_final(
            ir, wmap, K, marking, selected, swap=swap,
            process_predecessors=process_predecessors,
            release_predecessors=release_predecessors, age=age + 1,
        ):
            safe.append(candidate)
    return safe


def decode_orders_choosing(ir: Problem, tm: Durations, wafers, *,
                           chooser: _Chooser, reserve: bool = False,
                           swap: bool = False,
                           trust_preferred_path: bool = False,
                           include_order_snapshots: bool = True) -> Tuple[List, _Orders]:
    """选腔解码：返回 (有效 wafers, _Orders)。有效 wafers 已把选中腔写回各 stage，必须原样喂
    solve_timing（腔分配口径一致）。候选/特征/提交口径与 labels 的 teacher 复现一致，仅 chooser 不同：
    每步候选按去向 stage 的多候选腔（有空槽）分裂，chooser 联合决定 (hop, 腔)。
    swap：口径同 decode_orders——默认 False 保持 LL 整腔互斥（策略网按此分布训练）。
    trust_preferred_path：跳过逐候选终态搜索，直接提交 chooser 首选动作；若最终走到终态，
    整条已完成路径本身就是每一步的可达性证明。调用方必须在死锁时用完整 Petri 掩码重试。
    include_order_snapshots=False 供不读取历史序列的策略使用，避免长批量下每步复制累计历史。"""
    from src.timing.spans import _ll_proc

    wafers = [copy.copy(w) for w in wafers]              # 克隆：提交要改 stage.chamber，不污染 ir.wafers
    for w in wafers:
        w.stages = [copy.copy(s) for s in w.stages]
    wmap = {w.wid: w for w in wafers}
    K = {w.wid: len(w.stages) - 1 for w in wafers}
    pos = {w.wid: 0 for w in wafers}
    process_predecessors = _process_predecessors(wafers)
    place_t = {w.wid: 0.0 for w in wafers}
    occ: Dict[Tuple[str, int], int] = {}
    resv: Dict[Tuple[str, int], int] = {}
    robot_free: Dict[str, float] = {}
    ch_used: Dict[str, int] = {}                         # 各腔累计派入片数（选腔均衡特征）
    ll_age: Optional[Dict[Tuple[str, int], int]] = {} if swap else None   # LL 先进先出（swap）

    route_wids: Dict[str, List[int]] = {}
    for w in wafers:
        # 实时续排会把在机晶圆的当前位置裁成新的 stage 0；它们已经越过 LoadPort
        # 发片顺序，不能再被尚未发片的路线头阻塞。
        if not w.already_released:
            route_wids.setdefault(w.route_name, []).append(w.wid)
    for v in route_wids.values():
        v.sort()
    next_rel = {r: 0 for r in route_wids}
    release_predecessors = {
        current: previous
        for route in route_wids.values()
        for previous, current in zip(route, route[1:])
    }
    wafer_order = {wafer.wid: index for index, wafer in enumerate(wafers)}
    # 只需考察“已经在设备内的片”和“每条路线下一片待发片”。旧实现每次动作扫描全部
    # 晶圆，复杂度随批量近似二次增长；这个事件前沿与旧候选集合完全等价。
    active_wids = {wafer.wid for wafer in wafers if wafer.already_released}
    remaining_by_cjob: Dict[int, int] = {}
    route_released: Dict[str, int] = {}
    route_wip: Dict[str, int] = {}
    for wafer in wafers:
        remaining_by_cjob[wafer.cjob_id] = (
            remaining_by_cjob.get(wafer.cjob_id, 0) + 1
        )
        if wafer.already_released:
            route_released[wafer.route_name] = (
                route_released.get(wafer.route_name, 0) + 1
            )
            if K[wafer.wid] > 0:
                route_wip[wafer.route_name] = (
                    route_wip.get(wafer.route_name, 0) + 1
                )

    chambers: Dict[Tuple[str, int], List[Tuple[int, int]]] = {}
    robots: Dict[str, List[Tuple[int, int]]] = {}
    ll_seq: Dict[str, List[Tuple[int, int]]] = {}
    runtime = getattr(ir, "runtime_availability", None)
    loadlock_ready_at: Dict[str, float] = {
        str(loadlock): float(ready_at)
        for loadlock, ready_at in (
            getattr(runtime, "station_ready", {}) if runtime is not None else {}
        ).items()
        if (
            loadlock in ir.chambers
            and str(ir.chambers[loadlock].type).lower() == "loadlock"
        )
    }
    initial_resources = _build_resource_map(ir, wmap, swap)
    initial_loadlock_resources: Dict[int, Optional[Tuple[str, int]]] = {}
    for w in wafers:
        if not w.already_released:
            continue
        source = initial_resources[(w.wid, 0)]
        if source is None:
            continue
        if source in occ:
            raise RuntimeError(f"[timing] 初始资源 {source} 同时被多片晶圆占用")
        occ[source] = w.wid
        chambers.setdefault(source, []).append((w.wid, 0))
        if str(ir.chambers[source[0]].type).lower() == "loadlock":
            initial_loadlock_resources[w.wid] = source
    _seed_initial_loadlock_order(
        ir,
        wafers,
        K,
        initial_loadlock_resources,
        ll_seq,
        ll_age,
    )
    total = sum(K.values())
    placed = 0
    while placed < total:
        cands: List[_Cand] = []
        frontier = set(active_wids)
        for route_name, route in route_wids.items():
            release_index = next_rel[route_name]
            if release_index < len(route):
                frontier.add(route[release_index])
        for wid in sorted(frontier, key=wafer_order.__getitem__):
            w = wmap[wid]
            wid = w.wid
            j = pos[wid]
            if j >= K[wid]:
                continue
            if (
                j == 0
                and not w.already_released
                and any(remaining_by_cjob.get(blocker, 0) > 0 for blocker in w.dispatch_after)
            ):
                continue
            if (
                w.stages[j + 1].stage_type == "process"
                and _process_entry_blocked(process_predecessors, pos, wid, j + 1)
            ):
                continue
            if (
                j == 0
                and not w.already_released
                and route_wids[w.route_name][next_rel[w.route_name]] != wid
            ):
                continue
            if _ll_elder_blocked(_resource(ir, w, j), occ, ll_age):
                continue
            rob = w.transports[j]
            start = max(place_t[wid] + _stage_dwell(tm, w, j), robot_free.get(rob, 0.0))
            base = _resource(ir, w, j + 1)              # None=去向为 source/sink/skip（无资源、不选腔）
            if base is None:
                cands.append(_Cand(wid, j, None, rob, start))
                continue
            nxt = w.stages[j + 1]
            pool = _chamber_pool(nxt)
            for cc in pool:
                s = _free_slot(ir, occ, cc, nxt, swap)
                if s is not None:
                    cands.append(_Cand(wid, j, (cc, s), rob, start))
        if not cands:
            raise _DecodeDeadlock(
                _deadlock_diagnostic(
                    ir,
                    wmap,
                    K,
                    pos,
                    occ,
                    placed=placed,
                    total=total,
                )
            )

        if not trust_preferred_path:
            cands = _dynamic_petri_safe_candidates(
                ir, wmap, K, pos, occ, ll_age, cands, swap=swap,
                process_predecessors=process_predecessors,
                release_predecessors=release_predecessors, age=placed,
            )
            if not cands:
                raise RuntimeError("[timing] 动态选腔 Petri 标识无可达终态的使能变迁")

        if include_order_snapshots:
            chamber_order_snapshot = MappingProxyType(
                {resource: tuple(sequence) for resource, sequence in chambers.items()}
            )
            robot_order_snapshot = MappingProxyType(
                {robot: tuple(sequence) for robot, sequence in robots.items()}
            )
            loadlock_order_snapshot = MappingProxyType(
                {loadlock: tuple(sequence) for loadlock, sequence in ll_seq.items()}
            )
        else:
            chamber_order_snapshot = {}
            robot_order_snapshot = {}
            loadlock_order_snapshot = {}
        state = _DecodeState(
            ir,
            tm,
            wmap,
            K,
            pos,
            occ,
            resv,
            place_t,
            robot_free,
            placed,
            total,
            reserve,
            ch_used,
            chamber_orders=chamber_order_snapshot,
            robot_orders=robot_order_snapshot,
            loadlock_orders=loadlock_order_snapshot,
            loadlock_last_services=MappingProxyType({
                loadlock: sequence[-1]
                for loadlock, sequence in ll_seq.items()
                if sequence
            }),
            loadlock_service_counts=MappingProxyType({
                loadlock: len(sequence)
                for loadlock, sequence in ll_seq.items()
            }),
            loadlock_ready_at=MappingProxyType(loadlock_ready_at),
            route_released=MappingProxyType(route_released),
            route_wip=MappingProxyType(route_wip),
        )
        order = chooser(state, cands)

        if not order:
            raise ValueError("chooser 必须返回至少一个候选索引")
        if any(index < 0 or index >= len(cands) for index in order):
            raise IndexError("chooser 返回了超出候选范围的索引")
        chosen = cands[order[0]]

        wid, j, dest, rob, start = chosen
        w = wmap[wid]
        was_wip = (j > 0 or bool(w.already_released)) and j < K[wid]
        src = _resource(ir, w, j)
        if src is not None and occ.get(src) == wid:
            del occ[src]
            if ll_age is not None:
                ll_age.pop(src, None)
        if dest is not None:                            # 把选中的腔写回 stage（资源键/后续 dwell 一致）
            cc, slot = dest
            nxt = w.stages[j + 1]
            nxt.chamber, nxt.slot = cc, slot
            if nxt.stage_type == "loadlock":
                nxt.proc = _ll_proc(ir, cc, nxt.ll_type)
                ll_seq.setdefault(cc, []).append((wid, j + 1))
                loadlock_ready_at[cc] = (
                    start
                    + _hop_span(tm, w, j)
                    + _stage_dwell(tm, w, j + 1)
                )
                if ll_age is not None:
                    ll_age[dest] = placed
            occ[dest] = wid
            ch_used[cc] = ch_used.get(cc, 0) + 1
            chambers.setdefault(dest, []).append((wid, j + 1))
        robots.setdefault(rob, []).append((wid, j))
        robot_free[rob] = start + _hop_span(tm, w, j)
        place_t[wid] = robot_free[rob]
        if j == 0 and not w.already_released:
            next_rel[w.route_name] += 1
            route_released[w.route_name] = (
                route_released.get(w.route_name, 0) + 1
            )
            if j + 1 < K[wid]:
                route_wip[w.route_name] = route_wip.get(w.route_name, 0) + 1
            if j + 1 < K[wid]:
                active_wids.add(wid)
        pos[wid] = j + 1
        if pos[wid] >= K[wid]:
            active_wids.discard(wid)
            remaining_by_cjob[w.cjob_id] -= 1
            if was_wip and route_wip.get(w.route_name, 0) > 0:
                route_wip[w.route_name] -= 1
        placed += 1

    return wafers, _Orders(chambers=chambers, robots=robots, ll_seq=ll_seq)
