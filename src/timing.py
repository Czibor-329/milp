"""定时层（timing layer）：给定一个固定顺序，用差分约束图 + Bellman-Ford 求时刻。

设计见《调度实时重算优化方案》§3。要点：
  顺序固定后，模型里每条约束都退化成「动作 b 至少比动作 a 晚 w」即 t_b ≥ t_a + w，
  这是一条带权有向边。所有约束摆在一起就是一张图：
    · 求最早时刻 = 从源点求最长路（critical path）。
    · 驻留是「取出不能比放入晚太多」的【上界】，对应一条【往回指】的负权边。
    · 正环 = 绕一圈回到自己却要求它更早 = 该顺序在驻留下排不出来 → 报不可行。
  本层不含任何 0/1 变量，复杂度多项式（近 DAG，Bellman-Ford 几趟即收敛）。

顺序来自哪里：本文件用一个「无死锁 backward 定序」(见 _sequence)——全局事件式构造，
一次产出彼此自洽的各资源占用序。面向单臂机器手：下游 hop 先于上游 hop（清空腔再装入），
并用 Banker 安全检查保证无死锁。定时引擎 solve_timing 与定序解耦——你也可以传入自己的
orders。

未建模（v1 已知缺口，命中时会打印告警）：
  · swap（双臂换料）：本解码层无 swap 原语，每跳都是单次原子 pick+move+place。MILP 默认建模
    swap（solve_milp(enable_swap=True)），故训练/评测数据须用 enable_swap=False 生成（见
    scripts/gen_test.py），使 MILP 解落在本层可表示空间内、teacher 序可被复现。
  · 多容量【加工】腔的门簇互斥 (Cd)。命中多容量非 skip 加工腔时 makespan 可能偏乐观。

用法：
    from src.timing import time_from_ir
    res = time_from_ir(task, verbose=True)       # res 是 SolveResult，且带 .feasible / .residency_violations
    issues = check_solution(task, res)           # 直接复用 milp 的独立复核
"""

from __future__ import annotations

import copy
import math
import random
import time
from collections import namedtuple
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

# —— 按你的工程调整这一行 —— #
from src.milp import SolveResult, check_solution, _ll_proc  # noqa: F401
from src.model import Durations, Problem


EPS = 1e-9
SKIP_TYPES = {"loadport", "buffer", "dummyport"}


class _DecodeDeadlock(Exception):
    """快速解码(banker=False)中途无可动 hop = 该 genome 的占用序死锁。搜索里判负、跳过。"""


# --------------------------------------------------------------------------- #
# Bellman-Ford（最长路版）：dist[b] = max(dist[b], dist[a] + w)
#   feasible 时返回每个节点的最早时刻；存在正环（无法满足的上下界）返回 ok=False。
# --------------------------------------------------------------------------- #
def _bellman_ford_longest(n: int, edges: List[Tuple[int, int, float]]
                          ) -> Tuple[List[float], bool]:
    dist = [0.0] * n          # 所有时刻 ≥ 0（隐含源点 → 各节点权 0）
    # 近 DAG：通常几趟就稳。最多 n 趟；第 n 趟仍能松弛 ⇒ 正环。
    for it in range(n):
        changed = False
        for a, b, w in edges:
            nb = dist[a] + w
            if nb > dist[b] + EPS:
                dist[b] = nb
                changed = True
        if not changed:
            return dist, True
    # 跑满 n 趟还在变 → 正环
    for a, b, w in edges:
        if dist[a] + w > dist[b] + EPS:
            return dist, False
    return dist, True


# --------------------------------------------------------------------------- #
# 节点编号：每片每 stage 有 a[j]（放入/到站时刻）与 r[j]（pick 起始，j<K）
# --------------------------------------------------------------------------- #
class _Nodes:
    def __init__(self, wafers):
        self.id: Dict[Tuple[int, str, int], int] = {}
        self.label: List[Tuple[int, str, int]] = []
        for w in wafers:
            K = len(w.stages) - 1
            for j in range(K + 1):
                self._add(w.wid, "a", j)
            for j in range(K):
                self._add(w.wid, "r", j)

    def _add(self, wid: int, kind: str, j: int) -> None:
        key = (wid, kind, j)
        if key not in self.id:
            self.id[key] = len(self.label)
            self.label.append(key)

    def a(self, wid: int, j: int) -> int:
        return self.id[(wid, "a", j)]

    def r(self, wid: int, j: int) -> int:
        return self.id[(wid, "r", j)]

    def __len__(self) -> int:
        return len(self.label)


# --------------------------------------------------------------------------- #
# 时长口径（与 milp.py 完全一致）
# --------------------------------------------------------------------------- #
def _pdur(tm: Durations, w, j: int) -> float:
    """站内停留：place 关门 + 加工/抽充气 + pick 开门（s.proc 在 _expand 已置为 LL 的 pump/vent）。"""
    s = w.stages[j]
    pp = tm.place_post(s.in_robot, s.chamber) if s.in_robot else 0.0
    pre = tm.pick_pre(s.out_robot, s.chamber) if s.out_robot else 0.0
    return pp + s.proc + pre


def _L(tm: Durations, w, j: int) -> float:
    """hop j→j+1 占机器手时长 = pick + move + place（门不占手）。"""
    rob = w.transports[j]
    return (tm.pick_t(rob, w.stages[j].chamber) + tm.move(rob)
            + tm.place_t(rob, w.stages[j + 1].chamber))


def _ll_setup(ir: Problem, prev_stage, nxt_stage) -> float:
    """同一 LL 连续两用的状态相关 setup：entry→entry 须空充(vent)，exit→exit 须空抽(pump)。"""
    pt, nt = prev_stage.ll_type, nxt_stage.ll_type
    if not pt or not nt:
        return 0.0
    ch = ir.chambers.get(nxt_stage.chamber)
    if pt == "entry" and nt == "entry":
        return float((ch.vent_time if ch else 0.0) or 0.0)
    if pt == "exit" and nt == "exit":
        return float((ch.pump_time if ch else 0.0) or 0.0)
    return 0.0


def _gap(ir: Problem, tm: Durations, rob: str, wa, ja: int, wb, jb: int) -> float:
    """wa 的 hop 紧接 wb 的 hop 时机器手所需间隙：同一多槽 skip 站须关门+开门，否则 = 转位 move。"""
    dst, src = wa.stages[ja + 1].chamber, wb.stages[jb].chamber
    ch = ir.chambers.get(dst)
    if dst == src and ch and int(ch.capacity) > 1 and str(ch.type).lower() in SKIP_TYPES:
        return tm.place_post(rob, dst) + tm.pick_pre(rob, src)
    return tm.move(rob)


# --------------------------------------------------------------------------- #
# 无死锁定序（backward 节拍，面向单臂机器手）
#
# 单臂机器手一次只持一片：要把上游片搬进某腔，该腔必须先空。于是对一条流水顺序
# LA→PM1→LB，唯一无死锁的机器手节拍是「先把 PM1 的片搬到 LB（清空 PM1），再退回
# LA 把片搬进 PM1」——下游 hop 先于上游 hop 的 backward 节拍。
#
# 旧占位定序（按「松弛最早时刻」给各资源各自独立排序）在 ≥2 片时会让某资源的
# 「装入序」与腔的「占用序」互相矛盾 → 差分图出现正环 → 报死锁。这里改成一次全局
# 事件式构造，产出彼此自洽的各资源占用序，结构上即无死锁：
#   · 流水线性（吞吐）：按「最早可起」派工，腔加工期间机器手回头发上游片；
#   · 无死锁（正确性）：Banker 安全检查——仅当「仍保留一条能让所有片完工的纯下游
#     清空序」时才提交该派工，否则退而取次优候选。纯下游清空（每步总挑最下游可动
#     hop）对单臂可证无死锁，用作安全谕示(oracle)；故每步至少有一个安全候选，必有进展。
#
# 资源粒度：每个 (腔,槽) 视作容量 1 的占用单元（与 _expand 的 round-robin 定槽、与
# milp.py 的腔互斥口径一致）；source/sink 与 loadport/buffer/dummyport 不占资源。
# --------------------------------------------------------------------------- #
def _resource(ir: Problem, w, j: int) -> Optional[Tuple[str, int]]:
    """晶圆 w 在 stage j 占用的 (腔,槽)；不计资源（源/汇/跳过类站点）返回 None。"""
    s = w.stages[j]
    ch = ir.chambers.get(s.chamber)
    if ch is None or str(ch.type).lower() in SKIP_TYPES:
        return None
    if s.stage_type in ("source", "sink"):
        return None
    return (s.chamber, s.slot)


@dataclass
class _Orders:
    chambers: Dict[Tuple[str, int], List[Tuple[int, int]]]
    robots: Dict[str, List[Tuple[int, int]]]


# —— 可注入决策的解码：每步把「合法候选 hop」交给 chooser 排序，循环再套 Banker 安全掩码提交。
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


# chooser(state, cands) → 候选索引的偏好序（最优在前）。banker 时循环取序里第一个安全候选。
_Chooser = Callable[[_DecodeState, List[_Cand]], List[int]]


# —— 驻留(qtime)预留：单臂下，共享 loadlock 既进又出，新片的「进」易抢在在制片的「出」
# 之前，把片闷在加工腔里超驻留。对策：片一进入驻留腔（run），就把它出口去向资源（紧邻下一
# 跳 + 驻留 run 末端的落脚资源）预留下来，挡住别的片占用，保证其能按时离腔。仅 reserve=True
# 时启用（在快序驻留不可行时回退采用，见 time_from_ir）。
def _is_resid(w, k: int) -> bool:
    return (0 <= k < len(w.stages) and w.stages[k].stage_type == "process"
            and w.stages[k].residency > 0)


def _reserve_for(ir: Problem, w, nj: int) -> set:
    """片放入 stage nj 后应预留的资源：紧邻下一跳 + 驻留 run（连续驻留腔）末端的落脚资源。"""
    if not _is_resid(w, nj):
        return set()
    out = set()
    K = len(w.stages) - 1
    if nj + 1 <= K:                              # 紧邻下一跳去向
        r = _resource(ir, w, nj + 1)
        if r is not None:
            out.add(r)
    k = nj
    while _is_resid(w, k):                       # 跨过连续驻留腔，预留 run 出口
        k += 1
    if k <= K:
        r = _resource(ir, w, k)
        if r is not None:
            out.add(r)
    return out


def _blocked(dest, occ: dict, resv: dict, wid: int) -> bool:
    """去向资源被占用、或被别的片预留 ⇒ 当前片不可放入。"""
    if dest is None:
        return False
    return dest in occ or (dest in resv and resv[dest] != wid)


def _drain_completes(ir: Problem, wmap: Dict[int, object], K: Dict[int, int],
                     pos: Dict[int, int], occ: Dict[Tuple[str, int], int],
                     resv: Dict[Tuple[str, int], int], reserve: bool = False) -> bool:
    """安全谕示：从 (pos, occ, resv) 起，用纯下游清空（每步挑剩余最下游、去向未被占/预留的 hop）
    能否把所有片送完？能 ⇒ 当前状态安全（无死锁）。纯下游清空对单臂流水可证无死锁，故
    「存在完工序」当且仅当它能跑完。预留只挡新进、不挡在制片出腔，故不致死锁。"""
    pos = dict(pos)
    occ = dict(occ)
    resv = dict(resv)
    remaining = sum(K[wid] - pos[wid] for wid in pos)
    while remaining > 0:
        pick = None                       # (-j, wid)：最下游优先
        for wid, j in pos.items():
            if j >= K[wid]:
                continue
            dest = _resource(ir, wmap[wid], j + 1)
            if _blocked(dest, occ, resv, wid):
                continue
            cand = (-j, wid)
            if pick is None or cand < pick:
                pick = cand
        if pick is None:
            return False                  # 无可动 hop 却未完工 = 死锁
        wid = pick[1]
        j = pos[wid]
        src = _resource(ir, wmap[wid], j)
        if src is not None and occ.get(src) == wid:
            del occ[src]
        dest = _resource(ir, wmap[wid], j + 1)
        if dest is not None and resv.get(dest) == wid:
            del resv[dest]
        if dest is not None:
            occ[dest] = wid
        if reserve:
            for er in _reserve_for(ir, wmap[wid], j + 1):
                resv[er] = wid
        pos[wid] = j + 1
        remaining -= 1
    return True


def _make_default_chooser(prio: Optional[Dict[Tuple[int, int], float]]
                          ) -> _Chooser:
    """定死 backward 规则的 chooser：按 (最早可起+bias, 下游优先, wid) 排序。
    bias 缺省 0 ⇒ 与旧 _sequence 逐字节同序（wid 唯一 ⇒ 决出全序，不触及 dest/rob 比较）。"""
    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        def key(i: int):
            c = cands[i]
            bias = prio.get((c.wid, c.j), 0.0) if prio else 0.0
            return (c.start + bias, -c.j, c.wid)
        return sorted(range(len(cands)), key=key)
    return chooser


def _decode_orders(ir: Problem, tm: Durations, wafers, *, chooser: _Chooser,
                   reserve: bool = False, banker: bool = True) -> _Orders:
    """全局事件式构造：产出各 (腔,槽) 占用序与各机器手 hop 序（彼此自洽、无死锁）。每步生成
    合法候选(去向资源未占/未预留、j==0 满足发片 FIFO)，交 chooser 排偏好序，循环再套 Banker
    安全掩码提交。候选合法性 + Banker 安全 + 提交逻辑三方共用——换 chooser 不改这些（零回归）。

    reserve=True 时额外做驻留(qtime)预留（牺牲吞吐换驻留可行），仅在快序驻留不可行时回退采用。
    banker：True=每步 Banker 安全检查(保证无死锁，默认/基线/换腔)；False=直接取偏好序首位
    (快~50×，搜索批量评估)，中途卡死抛 _DecodeDeadlock 由调用方判负。"""
    wmap = {w.wid: w for w in wafers}
    K = {w.wid: len(w.stages) - 1 for w in wafers}
    pos = {w.wid: 0 for w in wafers}            # 各片当前所在 stage
    place_t = {w.wid: 0.0 for w in wafers}      # 各片落位到当前 stage 的（近似）时刻
    occ: Dict[Tuple[str, int], int] = {}        # (腔,槽) → 当前占用片
    resv: Dict[Tuple[str, int], int] = {}       # (腔,槽) → 为其出口预留该资源的片
    robot_free: Dict[str, float] = {}           # 机器手下次空闲（近似）时刻

    # 同 route 按 wid 先来先发（与 solve_timing 的发片 FIFO 一致）
    route_wids: Dict[str, List[int]] = {}
    for w in wafers:
        route_wids.setdefault(w.route_name, []).append(w.wid)
    for v in route_wids.values():
        v.sort()
    next_rel = {r: 0 for r in route_wids}

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
    total = sum(K.values())
    placed = 0
    while placed < total:
        # 候选 hop：去向腔未被占/预留（单臂可放）、且 j==0 时满足发片 FIFO
        cands: List[_Cand] = []
        for w in wafers:
            wid = w.wid
            j = pos[wid]
            if j >= K[wid]:
                continue
            dest = _resource(ir, w, j + 1)
            if _blocked(dest, occ, resv if reserve else {}, wid):
                continue
            if j == 0 and route_wids[w.route_name][next_rel[w.route_name]] != wid:
                continue
            rob = w.transports[j]
            start = max(place_t[wid] + _pdur(tm, w, j), robot_free.get(rob, 0.0))
            cands.append(_Cand(wid, j, dest, rob, start))

        if not cands:                      # 无可动 hop 却未完工
            if banker:                     # 理论不达：纯下游候选恒安全
                raise RuntimeError("[timing] 定序构造无安全候选（疑似拓扑无可行解）")
            raise _DecodeDeadlock()        # 快速解码卡死 → 该 genome 死锁，搜索判负

        state = _DecodeState(ir, tm, wmap, K, pos, occ, resv, place_t, robot_free,
                             placed, total, reserve)
        order = chooser(state, cands)      # 候选索引的偏好序（最优在前）

        if not banker:
            chosen = cands[order[0]]       # 直接取偏好序首位
        else:
            # Banker：取偏好序里第一个「保持状态安全」的候选；纯下游候选必安全 ⇒ 一定选得出
            chosen = None
            for idx in order:
                c = cands[idx]
                tpos = dict(pos)
                tocc = dict(occ)
                tresv = dict(resv) if reserve else {}
                src = _resource(ir, wmap[c.wid], c.j)
                if src is not None and tocc.get(src) == c.wid:
                    del tocc[src]
                if c.dest is not None and tresv.get(c.dest) == c.wid:
                    del tresv[c.dest]
                if c.dest is not None:
                    tocc[c.dest] = c.wid
                if reserve:
                    for er in _reserve_for(ir, wmap[c.wid], c.j + 1):
                        tresv[er] = c.wid
                tpos[c.wid] = c.j + 1
                if _drain_completes(ir, wmap, K, tpos, tocc, tresv, reserve):
                    chosen = c
                    break
            if chosen is None:             # 理论不达：纯下游候选恒安全
                raise RuntimeError("[timing] 定序构造无安全候选（疑似拓扑无可行解）")

        wid, j, dest, rob, start = chosen
        w = wmap[wid]
        src = _resource(ir, w, j)
        if src is not None and occ.get(src) == wid:
            del occ[src]
        if dest is not None and resv.get(dest) == wid:
            del resv[dest]
        if dest is not None:
            occ[dest] = wid
            chambers.setdefault(dest, []).append((wid, j + 1))   # 到站 stage = j+1
        if reserve:
            for er in _reserve_for(ir, w, j + 1):
                resv[er] = wid
        robots.setdefault(rob, []).append((wid, j))
        place_t[wid] = start + _L(tm, w, j)
        robot_free[rob] = place_t[wid]
        if j == 0:
            next_rel[w.route_name] += 1
        pos[wid] = j + 1
        placed += 1

    return _Orders(chambers=chambers, robots=robots)


def _sequence(ir: Problem, tm: Durations, wafers, reserve: bool = False,
              prio: Optional[Dict[Tuple[int, int], float]] = None,
              banker: bool = True) -> _Orders:
    """定死 backward 定序（默认 chooser）。prio={(wid,j):bias} 注入派工偏置；bias 缺省 0 ⇒ 零回归。
    薄封装 _decode_orders——候选/Banker/提交口径在那里统一，仅决策规则不同。"""
    return _decode_orders(ir, tm, wafers, chooser=_make_default_chooser(prio),
                          reserve=reserve, banker=banker)


def default_orders(ir: Problem, tm: Durations, wafers, nodes: _Nodes = None) -> _Orders:
    """无死锁 backward 定序（替代旧的松弛最早时刻占位）。nodes 参数保留以兼容旧调用，未使用。"""
    return _sequence(ir, tm, wafers)


# --------------------------------------------------------------------------- #
# 搜索候选（genome）与解码器 _decode
#
# 把定死的 backward 规则改成「可搜索」：一个候选 = 派工偏置 prio + loadlock 选腔 ll_assign。
# 解码器 _decode 仍走 _sequence（内含 Banker 安全检查）⇒ 任意候选都解出无死锁占用序；
# 空 genome ⇒ 与默认定序逐字节一致（零回归）。loadlock 选腔对齐 MILP 的 (Z) 决策：可把某片
# 从 round-robin 默认的 LA 改到 LB 以均衡瓶颈 loadlock 负载。
# --------------------------------------------------------------------------- #
@dataclass
class _Genome:
    prio: Dict[Tuple[int, int], float] = field(default_factory=dict)      # (wid,j) → 派工偏置
    ll_assign: Dict[Tuple[int, int], str] = field(default_factory=dict)   # (wid,j) → loadlock 选腔


def _ll_genes(ir: Problem, wafers) -> List[Tuple[int, int, List[str]]]:
    """可选腔的 loadlock stage（候选腔 >1，口径同 MILP 的 (Z)）：[(wid, j, 候选腔列表)]。"""
    out: List[Tuple[int, int, List[str]]] = []
    for w in wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type == "loadlock" and len(s.cands) > 1:
                out.append((w.wid, j, list(s.cands)))
    return out


def _recompute_slots(ir: Problem, wafers) -> None:
    """按 _expand 的全局 round-robin 重算各 stage 槽位（换 loadlock 腔后须重算 (腔,槽) 资源键）。
    腔/顺序不变时复现 _expand 的槽位 ⇒ 默认无回归。就地改 s.slot。"""
    counter: Dict[str, int] = {}
    for w in wafers:
        for s in w.stages:
            ch = ir.chambers.get(s.chamber)
            cap = int(ch.capacity) if ch else 1
            s.slot = counter.get(s.chamber, 0) % max(cap, 1)
            counter[s.chamber] = counter.get(s.chamber, 0) + 1


def _apply_ll_assign(ir: Problem, wafers,
                     ll_assign: Dict[Tuple[int, int], str]) -> List:
    """克隆 wafers 并套用 loadlock 选腔：改 chamber、按选中腔重算 proc(pump/vent)、全局重算 slot。
    口径照抄 _expand（entry→pump_time，exit→vent_time）。返回新 wafers 列表。"""
    wf = [copy.copy(w) for w in wafers]
    for w in wf:
        w.stages = [copy.copy(s) for s in w.stages]
    for w in wf:
        for j, s in enumerate(w.stages):
            c = ll_assign.get((w.wid, j))
            if c is not None and s.stage_type == "loadlock":
                s.chamber = c
        # loadlock 停留时长随选中腔的 pump/vent 变化（ll_type 不随选腔改变）
        for s in w.stages:
            if s.stage_type == "loadlock":
                s.proc = _ll_proc(ir, s.chamber, s.ll_type)
    _recompute_slots(ir, wf)
    return wf


def _decode(ir: Problem, tm: Durations, wafers, genome: _Genome,
            reserve: bool = False, banker: bool = True) -> Tuple[List, _Orders]:
    """genome → (有效 wafers, 占用序)。空 genome+banker=True ⇒ 默认定序（零回归）。
    返回的 wafers 必须原样喂给 solve_timing，使占用序与腔分配口径一致。
    banker=False 走快速贪心解码（搜索用），中途死锁抛 _DecodeDeadlock。"""
    wf = _apply_ll_assign(ir, wafers, genome.ll_assign) if genome.ll_assign else wafers
    orders = _sequence(ir, tm, wf, reserve=reserve, prio=genome.prio, banker=banker)
    return wf, orders


# --------------------------------------------------------------------------- #
# loadlock 分配寻优（portfolio 种子 + 贪心下降，用快速 BF 评估）
#
# 这是逼近 MILP 的【最大杠杆】：_expand 的 round-robin 让每片 entry+exit 用同一 loadlock
# （按 rank 奇偶），把并行加工腔劈成各自串行的奇/偶两条流水（并行腔零收益）。MILP 则解耦
# entry/exit（如 entry→LA、exit→LB）让系统真正流水。该解耦是实例相关决策，无单一静态方案普适
# （全局轮转易死锁、parity 在单腔例反劣），故按实例快速寻优。评估器是毫秒级 BF，portfolio
# 几个种子 + 单事件贪心翻腔即可在多数例命中 MILP；解码内含 Banker ⇒ 候选恒无死锁。
# --------------------------------------------------------------------------- #
def _ll_assign_events(wafers) -> List[Tuple[int, int, List[str]]]:
    """可选腔 loadlock stage（候选 >1），按 (wid, j) 顺序：[(wid, j, 候选腔列表)]。"""
    out: List[Tuple[int, int, List[str]]] = []
    for w in wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type == "loadlock" and len(s.cands) > 1:
                out.append((w.wid, j, list(s.cands)))
    return out


def _ll_seed_assignments(wafers) -> List[Dict[Tuple[int, int], str]]:
    """若干 loadlock 全分配种子（解耦 entry/exit 的不同模式）。空 dict = _expand 的 round-robin
    默认（entry/exit 同腔）。其余按 loadlock 占用事件序做不同步幅/相位轮转 + parity，覆盖
    「同片 entry/exit 拆到不同腔」「相邻片错腔」等利于流水的模式。"""
    ev = _ll_assign_events(wafers)
    seeds: List[Dict[Tuple[int, int], str]] = [{}]
    if not ev:
        return seeds
    for stride in (1, 2):
        for off in (0, 1):
            seeds.append({(wid, j): cands[(k * stride + off) % len(cands)]
                          for k, (wid, j, cands) in enumerate(ev)})
    parity: Dict[Tuple[int, int], str] = {}
    for w in wafers:
        js = [j for j, s in enumerate(w.stages)
              if s.stage_type == "loadlock" and len(s.cands) > 1]
        for k, j in enumerate(js):
            cands = w.stages[j].cands
            parity[(w.wid, j)] = cands[(w.wid + k) % len(cands)]
    seeds.append(parity)
    return seeds


def _eval_ll_assign(ir: Problem, tm: Durations, wafers,
                    assign: Dict[Tuple[int, int], str]) -> Tuple[List, Optional[SolveResult]]:
    """给定 loadlock 全分配 → Banker 解码 + solve_timing（驻留不可行回退 reserve）。
    口径与 _eval_genome 一致。返回 (有效 wafers, res 或 None若不可行)。"""
    g = _Genome(ll_assign=assign)
    try:
        wf, orders = _decode(ir, tm, wafers, g, reserve=False, banker=True)
    except (RuntimeError, _DecodeDeadlock):
        return wafers, None
    res = solve_timing(ir, wf, orders=orders)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        try:
            wf, orders = _decode(ir, tm, wafers, g, reserve=True, banker=True)
        except (RuntimeError, _DecodeDeadlock):
            return wafers, None
        res = solve_timing(ir, wf, orders=orders)
    return (wf, res) if getattr(res, "feasible", False) else (wf, None)


def optimize_loadlock(ir: Problem, tm: Optional[Durations] = None, wafers=None, *,
                      budget: float = 0.4, seed: int = 0
                      ) -> Tuple[Optional[Dict[Tuple[int, int], str]], List, Optional[SolveResult]]:
    """寻优 loadlock 分配：portfolio 种子取最优可行作 incumbent，再单事件贪心下降。
    返回 (best_assign, best_wafers, best_res)；全不可行返回 (None, wafers, None)。
    best_res 走默认（backward）定序——顺序由调用方（默认/policy/SA）另行决定。"""
    if tm is None:
        tm = Durations(ir)
    if wafers is None:
        wafers = ir.wafers
    ev = _ll_assign_events(wafers)
    t0 = time.perf_counter()
    best_a: Optional[Dict[Tuple[int, int], str]] = None
    best_wf, best_res, best_mk = wafers, None, float("inf")
    for a in _ll_seed_assignments(wafers):
        wf, res = _eval_ll_assign(ir, tm, wafers, a)
        if res is not None and res.makespan < best_mk - EPS:
            best_a, best_wf, best_res, best_mk = dict(a), wf, res, res.makespan
    if best_res is None or not ev:
        return best_a, best_wf, best_res
    rng = random.Random(seed)
    improved = True
    while improved and time.perf_counter() - t0 < budget:
        improved = False
        order = list(range(len(ev)))
        rng.shuffle(order)
        for idx in order:
            wid, j, cands = ev[idx]
            cur = best_a.get((wid, j)) if best_a else None
            for c in cands:
                if c == cur:
                    continue
                trial = dict(best_a or {})
                trial[(wid, j)] = c
                wf, res = _eval_ll_assign(ir, tm, wafers, trial)
                if res is not None and res.makespan < best_mk - EPS:
                    best_a, best_wf, best_res, best_mk = trial, wf, res, res.makespan
                    improved = True
            if time.perf_counter() - t0 >= budget:
                break
    return best_a, best_wf, best_res


# —— 全腔分配寻优（process + loadlock）：loadlock 只是腔分配的一类；并行【加工】腔的分配同样是
# MILP 决策(Z)。loadlock-bound 多 PM 例（#loadlock < #PM）里 MILP 实际只用 ≤2 个加工腔（其余空转），
# round-robin 却摊到全部 PM，使 wafer→PM 与 wafer→loadlock 周期错位、backward 定序无法细粒度流水。
# 故在 loadlock 寻优之上，再加「限制 process 腔用量」的种子 + 全事件贪心。贪心从 loadlock-opt incumbent
# 起、只接受改进 ⇒ **永不劣于 optimize_loadlock**（单调）。
def _chamber_assign_events(wafers) -> List[Tuple[int, int, List[str]]]:
    """全部多候选腔 stage（process + loadlock），按 (wid, j) 顺序：[(wid, j, 候选腔列表)]。"""
    out: List[Tuple[int, int, List[str]]] = []
    for w in wafers:
        for j, s in enumerate(w.stages):
            if len(s.cands) > 1 and s.stage_type in ("process", "loadlock"):
                out.append((w.wid, j, list(s.cands)))
    return out


def _apply_chamber_assign(ir: Problem, wafers, assign: Dict[Tuple[int, int], str]) -> List:
    """克隆 wafers 并套用任意 stage 的选腔（process + loadlock）。loadlock 选腔后按腔重算 proc
    (pump/vent)，process 选腔不改 proc；最后全局重算 slot。是 _apply_ll_assign 的超集。"""
    wf = [copy.copy(w) for w in wafers]
    for w in wf:
        w.stages = [copy.copy(s) for s in w.stages]
    for w in wf:
        for j, s in enumerate(w.stages):
            c = assign.get((w.wid, j))
            if c is not None and c in s.cands:
                s.chamber = c
        for s in w.stages:
            if s.stage_type == "loadlock":
                s.proc = _ll_proc(ir, s.chamber, s.ll_type)
    _recompute_slots(ir, wf)
    return wf


def _eval_chamber_assign(ir: Problem, tm: Durations, wafers,
                         assign: Dict[Tuple[int, int], str]) -> Tuple[List, Optional[SolveResult]]:
    """给定全腔分配 → 默认 backward 定序 + solve_timing（驻留不可行回退 reserve）。同 _eval_ll_assign
    口径，但允许 process 选腔。返回 (有效 wafers, res 或 None)。"""
    wf = _apply_chamber_assign(ir, wafers, assign) if assign else wafers
    try:
        orders = _sequence(ir, tm, wf, reserve=False, banker=True)
    except (RuntimeError, _DecodeDeadlock):
        return wf, None
    res = solve_timing(ir, wf, orders=orders)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        try:
            orders = _sequence(ir, tm, wf, reserve=True, banker=True)
        except (RuntimeError, _DecodeDeadlock):
            return wf, None
        res = solve_timing(ir, wf, orders=orders)
    return (wf, res) if getattr(res, "feasible", False) else (wf, None)


def _joint_chamber_seeds(wafers) -> List[Dict[Tuple[int, int], str]]:
    """全腔（process + loadlock）联合分配种子，两族并集（各覆盖单一模式拼不出的结构）：
      族 A：对【所有】腔池统一按 (width, stride, offset) 轮转——entry/exit/相邻片细粒度错腔交错
            （深 flowline loadlock-bound 例如 3stage[2,2,1] 需要这种全局交错）。
      族 B：加工腔限 width × loadlock 模式(_ll_seed_assignments，含 parity)的【叉积】——
            「只用 2 加工腔 + parity loadlock」（如 1stage 3PM 例 MILP 实际只用 2 腔 + parity）。
    与 loadlock-opt incumbent 取并集 ⇒ 最坏不劣（见 optimize_chambers）。"""
    all_pools: Dict[Tuple[str, ...], List[Tuple[int, int]]] = {}
    proc_pools: Dict[Tuple[str, ...], List[Tuple[int, int]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            if len(s.cands) > 1 and s.stage_type in ("process", "loadlock"):
                all_pools.setdefault(tuple(s.cands), []).append((w.wid, j))
                if s.stage_type == "process":
                    proc_pools.setdefault(tuple(s.cands), []).append((w.wid, j))
    seeds: List[Dict[Tuple[int, int], str]] = []
    # 族 A：全池统一轮转
    if all_pools:
        maxw = max(len(p) for p in all_pools)
        for width in sorted({2, 3, maxw}):
            for stride in (1, 2):
                for off in (0, 1):
                    a: Dict[Tuple[int, int], str] = {}
                    for pool, evs in all_pools.items():
                        w_eff = max(min(width, len(pool)), 1)
                        for k, (wid, j) in enumerate(evs):
                            a[(wid, j)] = pool[(k * stride + off) % w_eff]
                    seeds.append(a)
    # 族 B：加工腔限宽 × loadlock 模式 叉积
    ll_pats = _ll_seed_assignments(wafers)
    if proc_pools:
        maxw = max(len(p) for p in proc_pools)
        for width in sorted({2, maxw}):
            for stride in (1, 2):
                pa: Dict[Tuple[int, int], str] = {}
                for pool, evs in proc_pools.items():
                    w_eff = max(min(width, len(pool)), 1)
                    for k, (wid, j) in enumerate(evs):
                        pa[(wid, j)] = pool[(k * stride) % w_eff]
                for ll in ll_pats:
                    m = dict(pa)
                    m.update(ll)
                    seeds.append(m)
    else:
        seeds += ll_pats
    # 去重（不同 (width,stride) 常生成同一分配）
    out: List[Dict[Tuple[int, int], str]] = []
    seen: set = set()
    for m in seeds:
        key = tuple(sorted(m.items()))
        if key not in seen:
            seen.add(key)
            out.append(m)
    return out


def optimize_chambers(ir: Problem, tm: Optional[Durations] = None, wafers=None, *,
                      budget: float = 0.6, seed: int = 0, refine_budget: float = 0.0
                      ) -> Tuple[Optional[Dict[Tuple[int, int], str]], List, Optional[SolveResult]]:
    """寻优【全部多候选腔】(process + loadlock) 分配——对齐 MILP 腔分配决策(Z)。返回
    (best_assign, best_wafers, best_res)；全不可行返回 (None, wafers, None)。

    三段式（保证不劣于 optimize_loadlock）：① loadlock 专项寻优定 incumbent（已验证命中多数 MILP）；
    ② 叠加「限 process 腔用量」种子 + 全事件贪心下降（只接受改进）；③ refine_budget>0 时再做
    SA+重启 ILS 逃离贪心局部最优。best_res 走默认 backward 定序。

    refine_budget（秒）：贪心后的 SA-ILS 预算。**多 route 共享 loadlock（双 job）例的关键杠杆**——
    贪心常困在「entry/exit 同腔 round-robin」局部最优，使某 loadlock 过载成饱和瓶颈（此时定序无力，
    见 _decode_orders 注），ILS 用单/双事件翻腔 + 回 best/随机重启逃出，找到均衡两 route 负载的不规则
    分配（逼近 MILP）。单调（best 只接受改进 ⇒ ≤ 贪心结果，零回归）。缺省 0 = 不做（单 job 用，已近最优）。
    每次评估 = 默认序一次 BF（makespan 对固定腔分配近似 order-invariant，故评估便宜、可上千次）。"""
    if tm is None:
        tm = Durations(ir)
    if wafers is None:
        wafers = ir.wafers
    t0 = time.perf_counter()
    # ① loadlock 专项 → incumbent（≥ LL-opt 质量，保证单调不劣）
    ll_assign, ll_wf, ll_res = optimize_loadlock(ir, tm, wafers, budget=budget * 0.35, seed=seed)
    best_a: Dict[Tuple[int, int], str] = dict(ll_assign) if ll_assign else {}
    best_wf, best_res = ll_wf, ll_res
    best_mk = ll_res.makespan if ll_res is not None else float("inf")
    # ② 全腔联合种子（process+loadlock 限宽/错腔；含 incumbent 搞不定的结构）
    for s in _joint_chamber_seeds(wafers):
        wf, res = _eval_chamber_assign(ir, tm, wafers, s)
        if res is not None and res.makespan < best_mk - EPS:
            best_a, best_wf, best_res, best_mk = s, wf, res, res.makespan
    if best_res is None:
        return None, wafers, None
    # ③ 全事件贪心下降（process + loadlock），从 incumbent 起、只接受改进 ⇒ ≤ LL-opt
    ev = _chamber_assign_events(wafers)
    rng = random.Random(seed + 1)
    improved = True
    while ev and improved and time.perf_counter() - t0 < budget:
        improved = False
        order = list(range(len(ev)))
        rng.shuffle(order)
        for idx in order:
            wid, j, cands = ev[idx]
            cur = best_a.get((wid, j))
            for c in cands:
                if c == cur:
                    continue
                trial = dict(best_a)
                trial[(wid, j)] = c
                wf, res = _eval_chamber_assign(ir, tm, wafers, trial)
                if res is not None and res.makespan < best_mk - EPS:
                    best_a, best_wf, best_res, best_mk = trial, wf, res, res.makespan
                    improved = True
            if time.perf_counter() - t0 >= budget:
                break
    # ④ SA + 重启 ILS（逃离贪心局部最优；多 route 共享 loadlock 例的关键）。monotone：best 只接受改进。
    if ev and refine_budget > 0 and best_res is not None:
        best_a, best_wf, best_res, best_mk = _chamber_ils(
            ir, tm, wafers, ev, best_a, best_wf, best_res, best_mk,
            budget=refine_budget, seed=seed + 7)
    return best_a, best_wf, best_res


def _auto_refine_budget(wafers, override: Optional[float]) -> float:
    """多 route（双 job 共享 loadlock）时默认给腔分配 ILS 6s 预算；单 route 给 0（已近最优、不浪费）。
    override 非 None 则照用（调用方显式控制）。"""
    if override is not None:
        return override
    return 6.0 if len({w.route_name for w in wafers}) > 1 else 0.0


def _chamber_ils(ir: Problem, tm: Durations, wafers, ev, best_a, best_wf, best_res,
                 best_mk: float, *, budget: float, seed: int):
    """从贪心 incumbent 起，对腔分配做 SA + 重启 ILS。每个分配用默认序 BF 快评（带 makespan 缓存）。
    单调：best 只接受改进 ⇒ 返回 ≤ 入参 best_mk。返回 (best_a, best_wf, best_res, best_mk)。"""
    keys = [(wid, j) for wid, j, _ in ev]
    cmap = {(wid, j): cs for wid, j, cs in ev}
    cache: Dict[tuple, float] = {tuple(sorted(best_a.items())): best_mk}

    def mk_of(assign) -> float:
        key = tuple(sorted(assign.items()))
        if key in cache:
            return cache[key]
        _, r = _eval_chamber_assign(ir, tm, wafers, assign)
        v = r.makespan if r is not None else float("inf")
        cache[key] = v
        return v

    rng = random.Random(seed)
    cur, cur_mk = dict(best_a), best_mk
    T0 = max(best_mk * 0.04, 1.0)
    t0 = time.perf_counter()
    n = 0
    while time.perf_counter() - t0 < budget:
        n += 1
        frac = (time.perf_counter() - t0) / budget
        T = max(T0 * (1.0 - frac), 1e-6)
        trial = dict(cur)
        for _ in range(rng.choice([1, 1, 2])):          # 翻 1~2 个事件
            k = rng.choice(keys)
            trial[k] = rng.choice(cmap[k])
        mk = mk_of(trial)
        if mk < cur_mk - EPS or (mk < float("inf")
                                 and rng.random() < math.exp(-(mk - cur_mk) / T)):
            cur, cur_mk = trial, mk
            if mk < best_mk - EPS:
                best_a, best_mk = dict(trial), mk
        if n % 150 == 0:                                 # 重启：半数回 best 深挖、半数随机跳基
            if rng.random() < 0.5:
                cur, cur_mk = dict(best_a), best_mk
            else:
                cur = {(wid, j): rng.choice(cmap[(wid, j)]) for wid, j in keys}
                cur_mk = mk_of(cur)
    # 用最终 best_a 完整评估一次拿 wf/res（带 schedule）
    wf, res = _eval_chamber_assign(ir, tm, wafers, best_a)
    if res is not None and res.makespan <= best_mk + EPS:
        best_wf, best_res, best_mk = wf, res, res.makespan
    return best_a, best_wf, best_res, best_mk


# --------------------------------------------------------------------------- #
# 主入口：给定顺序 → 建全图 → Bellman-Ford → SolveResult
# --------------------------------------------------------------------------- #
def solve_timing(ir: Problem, wafers=None, *, orders: Optional[_Orders] = None,
                 release_interval: float = 0.0, verbose: bool = False) -> SolveResult:
    """对固定顺序求最早时刻。返回 SolveResult，并附加：
         res.feasible（bool）、res.residency_violations（[(wid,j,腔,实际驻留,上限)]）。

    release_interval：同 route 相邻两片发片(r0)的最小间隔。0=尽快发片；>0 用于节流发片
    （降低在制品 WIP），让驻留腔有时间被腾空——驻留(qtime)不可行时由 solve_timing_paced
    二分搜索最小可行间隔。"""
    t_start = time.perf_counter()
    tm = Durations(ir)
    if wafers is None:
        wafers = ir.wafers
    wmap = {w.wid: w for w in wafers}
    nodes = _Nodes(wafers)
    if orders is None:
        orders = default_orders(ir, tm, wafers)

    edges: List[Tuple[int, int, float]] = []
    res_edges: List[Tuple[int, int, float]] = []   # 驻留后向边，单列以便诊断

    # 片内：P / 链式（正反向，等价于 a=r+L）/ 驻留上界
    for w in wafers:
        K = len(w.stages) - 1
        for j in range(K):
            ai, ri, an = nodes.a(w.wid, j), nodes.r(w.wid, j), nodes.a(w.wid, j + 1)
            pdur, Lj = _pdur(tm, w, j), _L(tm, w, j)
            edges.append((ai, ri, pdur))            # (P)   r ≥ a + 停留
            edges.append((ri, an, Lj))              # 链正  a_next ≥ r + L
            edges.append((an, ri, -Lj))             # 链反  r ≥ a_next − L（下一腔被占则推迟 pick）
            s = w.stages[j]
            if s.stage_type == "process" and s.residency > 0:
                # (D) r ≤ a + 停留 + 驻留 ⟺ a ≥ r − (停留+驻留)：往回指的负权边
                res_edges.append((ri, ai, -(pdur + s.residency)))

    # 同 route FIFO 发片
    by_route: Dict[str, List] = {}
    for w in wafers:
        by_route.setdefault(w.route_name, []).append(w)
    for ws in by_route.values():
        ws.sort(key=lambda x: x.wid)
        for lo, hi in zip(ws, ws[1:]):
            edges.append((nodes.r(lo.wid, 0), nodes.r(hi.wid, 0), release_interval))

    # tagged：带「资源键 + 两端 op」标注的 cross-wafer 互斥边，供 _critical_resources 提瓶颈。
    tagged: List[Tuple[int, int, float, str, str, Tuple[int, int], Tuple[int, int]]] = []

    # (C) 腔互斥：固定次序里 lo 先 hi 后 → a[hi] ≥ r[lo] + (pick口径 + place口径 + ll_setup)
    for (c, _slot), occ in orders.chambers.items():
        for (wlo, jlo), (whi, jhi) in zip(occ, occ[1:]):
            if wlo == whi:
                continue                            # 同片重访：precedence 已序
            slo = wmap[wlo].stages[jlo]
            shi = wmap[whi].stages[jhi]
            wgt = (tm.pick_t(slo.out_robot, c) + tm.pick_post(slo.out_robot, c)
                   + tm.place_t(shi.in_robot, c) + tm.place_pre(shi.in_robot, c)
                   + _ll_setup(ir, slo, shi))
            a, b = nodes.r(wlo, jlo), nodes.a(whi, jhi)
            edges.append((a, b, wgt))
            tagged.append((a, b, wgt, "C", c, (wlo, jlo), (whi, jhi)))

    # (R) 机器手互斥：固定次序里 op1 先 op2 后 → r[op2] ≥ a_next[op1] + gap
    for rob, ops in orders.robots.items():
        for (w1, j1), (w2, j2) in zip(ops, ops[1:]):
            if w1 == w2:
                continue
            wa, wb = wmap[w1], wmap[w2]
            g = _gap(ir, tm, rob, wa, j1, wb, j2)
            a, b = nodes.a(w1, j1 + 1), nodes.r(w2, j2)
            edges.append((a, b, g))
            tagged.append((a, b, g, "R", rob, (w1, j1), (w2, j2)))

    # 求解：含驻留后向边的全图
    dist, ok = _bellman_ford_longest(len(nodes), edges + res_edges)

    res = SolveResult(status=2 if ok else 3, makespan=float("nan"))
    res.runtime = time.perf_counter() - t_start
    res.feasible = ok                              # type: ignore[attr-defined]
    res.residency_violations = []                  # type: ignore[attr-defined]

    if ok:
        _fill_schedule(res, wafers, nodes, dist)
        res._dist = dist                           # type: ignore[attr-defined]
        res._tagged = tagged                       # type: ignore[attr-defined]
        if verbose:
            print(f"[timing] 可行  makespan={res.makespan:.2f}  "
                  f"用时={res.runtime*1000:.1f} ms  节点={len(nodes)}  边={len(edges)+len(res_edges)}")
        return res

    # 不可行：去掉驻留边再求一次（仍可能因资源次序自相矛盾而成环 = 死锁）
    dist0, ok0 = _bellman_ford_longest(len(nodes), edges)
    if not ok0:
        if verbose:
            print(f"[timing] 不可行：资源次序自相矛盾(疑似死锁)，非驻留所致。用时={res.runtime*1000:.1f} ms")
        return res
    viols = []
    for w in wafers:
        for j in range(len(w.stages) - 1):
            s = w.stages[j]
            if s.stage_type == "process" and s.residency > 0:
                hold = dist0[nodes.r(w.wid, j)] - dist0[nodes.a(w.wid, j)]
                limit = _pdur(tm, w, j) + s.residency
                if hold > limit + 1e-4:
                    viols.append((w.wid, j, s.chamber, round(hold, 2), round(limit, 2)))
    res.residency_violations = viols               # type: ignore[attr-defined]
    if verbose:
        print(f"[timing] 不可行：{len(viols)} 处超驻留。用时={res.runtime*1000:.1f} ms")
        for wid, j, c, hold, lim in viols[:10]:
            print(f"         w{wid} stage{j} 腔{c}: 实际占用 {hold} > 上限 {lim}")
    return res


def _fill_schedule(res: SolveResult, wafers, nodes: _Nodes, dist: List[float]) -> None:
    """把时刻填进 SolveResult.schedule（格式同 milp，便于 check_solution/export_movelist 复用）。"""
    mk = 0.0
    for w in wafers:
        K = len(w.stages) - 1
        row = []
        for j, s in enumerate(w.stages):
            av = dist[nodes.a(w.wid, j)]
            rv = dist[nodes.r(w.wid, j)] if j < K else av
            row.append((s.stage_type, s.chamber, av, rv))
        res.schedule[w.wid] = row
        mk = max(mk, dist[nodes.a(w.wid, K)])
    res.makespan = mk
    res.releases = sorted((dist[nodes.r(w.wid, 0)], w.route_name, w.wid) for w in wafers)
    res.swaps = []


# --------------------------------------------------------------------------- #
# 关键路径瓶颈提取 + 局部搜索寻优（占用序 + loadlock 选腔）
#
# solve_timing 已把各 cross-wafer 互斥边打标(res._tagged)并存最早时刻(res._dist)。一条互斥边
# 「紧」(dist[a]+w ≈ dist[b]) ⟺ 它绑住后继 = 落在关键路径上。把扰动集中在这些瓶颈资源（尤其
# 瓶颈 loadlock）上，是逼近 MILP 的高 ROI 部分。搜索用 SA：解码内含 Banker ⇒ 候选恒无死锁；
# 始终保留可行 incumbent(初始=默认定序) ⇒ 最坏不退化、anytime 返回 best。
# --------------------------------------------------------------------------- #
def _critical_resources(res: SolveResult, tol: float = 1e-6):
    """从 res 的紧边提瓶颈：返回落在关键路径上的 cross-wafer 互斥边，按权重降序。
    每条 = (kind, key, op_lo, op_hi, w)；kind='C'腔/'R'手，key=腔名/手名，op=(wid,j)。"""
    dist = getattr(res, "_dist", None)
    tagged = getattr(res, "_tagged", None)
    if not dist or not tagged:
        return []
    tight = [(kind, key, op_lo, op_hi, w)
             for a, b, w, kind, key, op_lo, op_hi in tagged
             if dist[a] + w >= dist[b] - tol]
    tight.sort(key=lambda e: -e[4])
    return tight


def _infeasible() -> SolveResult:
    r = SolveResult(status=3, makespan=float("nan"))
    r.feasible = False                             # type: ignore[attr-defined]
    r.residency_violations = []                    # type: ignore[attr-defined]
    return r


def _eval_genome(ir: Problem, tm: Durations, wafers, genome: _Genome,
                 banker: Optional[bool] = None) -> Tuple[SolveResult, List]:
    """解码 genome → 求时刻。residency 不可行时按需 reserve=True 重解一次。返回 (res, 有效 wafers)。
    banker=False（搜索快路径）解码死锁直接判负（infeasible），不再调 solve_timing。
    banker=None（自动）：含 loadlock 选腔变更时必用 Banker（换腔后贪心序几乎必死锁），否则走快路径。"""
    if banker is None:
        banker = bool(genome.ll_assign)
    try:
        wf, orders = _decode(ir, tm, wafers, genome, reserve=False, banker=banker)
    except _DecodeDeadlock:
        return _infeasible(), wafers
    res = solve_timing(ir, wf, orders=orders)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        # 驻留不可行 → 预留重排（带 Banker）。被扰动 genome 的预留可能反致无安全候选 → 判负。
        try:
            wf, orders = _decode(ir, tm, wafers, genome, reserve=True, banker=True)
        except (_DecodeDeadlock, RuntimeError):
            return _infeasible(), wafers
        res = solve_timing(ir, wf, orders=orders)
    return res, wf


def _neighbor(cur: _Genome, cur_res: SolveResult, wafers,
              ll_cand: Dict[Tuple[int, int], List[str]],
              ll_default: Dict[Tuple[int, int], str], rng: random.Random,
              mk: float) -> _Genome:
    """从当前 genome 派生一个邻居（克隆后扰动）。算子按瓶颈类型分流：
      · loadlock 瓶颈（关键路径上 'C' 边落在有候选腔的 loadlock）→ 优先「换腔」：把某 loadlock 占用挪到
        其它候选腔（对齐 MILP 的 Z 决策，均衡 LA/LB；用 Banker 评估保证可行）。一半挑瓶颈紧边上的占用
        （定向均衡），一半随机挑任意可换腔 loadlock（覆盖不在当前紧边上的改进）。
      · 机器手/其它瓶颈 → 「瓶颈翻序」prio 偏置（走快路径评估），不触发 loadlock 换腔。
    这样 loadlock 瓶颈集中用换腔这把关键钥匙，机器手瓶颈则廉价快搜。"""
    g = _Genome(prio=dict(cur.prio), ll_assign=dict(cur.ll_assign))
    step = max(mk * rng.uniform(0.03, 0.2), 1.0)
    tight = _critical_resources(cur_res)
    # 落在「有候选腔 loadlock」上的紧腔互斥边 = 可重指派的 loadlock 瓶颈
    c_edges = [e for e in tight if e[0] == "C"
               and any(op in ll_cand and e[1] in ll_cand[op] for op in (e[2], e[3]))]
    r = rng.random()
    # (1) loadlock 换腔（仅当 loadlock 确在关键路径）
    if c_edges and ll_cand and r < 0.7:
        if rng.random() < 0.5:                         # 定向：瓶颈紧边上的占用
            _, key, op_lo, op_hi, _ = rng.choice(c_edges[:max(1, len(c_edges) // 2)])
            op = rng.choice([op_lo, op_hi])
        else:                                          # 随机：任意可换腔 loadlock
            op = rng.choice(list(ll_cand))
        cur_c = g.ll_assign.get(op, ll_default.get(op))
        alt = [c for c in ll_cand.get(op, []) if c != cur_c]
        if alt:
            g.ll_assign[op] = rng.choice(alt)
            return g
    # (2) 瓶颈制导翻序（prio，快路径）：提前后继占用、推后前驱占用，试图翻转占用序。
    #   prio 键是「hop」(按源 stage j)；腔互斥边的 op=(wid,j) 是「占用」(到站 stage j)，控制它到站
    #   早晚的是 hop (wid, j-1)；机器手互斥边的 op 本身即 hop → 键就是 (wid,j)。故按 kind 映射。
    if tight and r < 0.92:
        kind, key, op_lo, op_hi, w = rng.choice(tight[:max(1, len(tight) // 2)])
        hop_hi = (op_hi[0], op_hi[1] - 1) if kind == "C" else op_hi
        hop_lo = (op_lo[0], op_lo[1] - 1) if kind == "C" else op_lo
        if hop_hi[1] >= 0:
            g.prio[hop_hi] = g.prio.get(hop_hi, 0.0) - step   # 后继提前
        if hop_lo[1] >= 0:
            g.prio[hop_lo] = g.prio.get(hop_lo, 0.0) + step   # 前驱推后
        return g
    # (3) 随机偏置一个 hop（多样化，快路径）
    wf = rng.choice(wafers)
    if len(wf.stages) > 1:
        j = rng.randrange(len(wf.stages) - 1)
        g.prio[(wf.wid, j)] = g.prio.get((wf.wid, j), 0.0) + rng.uniform(-step, step)
    return g


def optimize_orders(ir: Problem, wafers=None, *, budget: float = 2.0,
                    iters: Optional[int] = None, seed: int = 0,
                    verbose: bool = False) -> SolveResult:
    """局部搜索（SA）寻优占用序 + loadlock 选腔，用 solve_timing 评估。返回 best 可行 SolveResult
    （schedule 已反映所选 loadlock 腔）。budget=墙钟秒数；iters 设定则按迭代数停。

    先用 portfolio+贪心把 loadlock 分配定下（最大杠杆——单基因 SA 跳不出 round-robin 坏默认的
    LL 局部最优），再在该 LL-opt 基底上做顺序 SA。incumbent 初始 = LL-opt 基底默认定序 ⇒ 最坏
    不退化。"""
    t0 = time.perf_counter()
    tm = Durations(ir)
    if wafers is None:
        wafers = ir.wafers
    rng = random.Random(seed)

    # 腔分配寻优（loadlock + 并行加工腔）→ 基底；顺序 SA 在该基底上跑（仍可经 _neighbor 微调 LL）。
    ll_budget = min(budget * 0.5, 1.2) if iters is None else 0.8
    _, wf, ll_res = optimize_chambers(ir, tm, wafers, budget=ll_budget, seed=seed,
                                      refine_budget=_auto_refine_budget(wafers, None))
    if ll_res is not None:
        wafers = wf

    ll_genes = _ll_genes(ir, wafers)
    ll_cand = {(w, j): cs for w, j, cs in ll_genes}                 # (wid,j) → 候选腔
    ll_default = {(w.wid, j): w.stages[j].chamber for w in wafers
                  for j, s in enumerate(w.stages)
                  if (w.wid, j) in ll_cand}                         # (wid,j) → 当前基底腔

    cur = _Genome()
    cur_res = ll_res if ll_res is not None else _eval_genome(ir, tm, wafers, cur, banker=True)[0]
    if not getattr(cur_res, "feasible", False):
        if verbose:
            print("[timing] 默认定序即不可行，放弃搜索。")
        return cur_res
    best, best_res, best_mk = cur, cur_res, cur_res.makespan
    base_mk = best_mk                               # LL-opt 基底基线（仅供日志）
    cur_mk = best_mk
    # 贪心为主的低温 SA：Banker 评估贵、迭代少，故偏向爬山；停滞则回到 best 重启以跳出局部。
    T0 = max(best_mk * 0.02, 1.0)
    stale = 0
    it = 0
    while iters is None or it < iters:
        elapsed = time.perf_counter() - t0
        if iters is None and elapsed >= budget:
            break
        it += 1
        cand = _neighbor(cur, cur_res, wafers, ll_cand, ll_default, rng, cur_mk)
        res, _ = _eval_genome(ir, tm, wafers, cand)   # 自动选 banker：含换腔→Banker，纯偏置→快路径
        if not getattr(res, "feasible", False):
            stale += 1
            continue
        mk = res.makespan
        frac = (elapsed / budget) if (iters is None and budget > 0) else (it / max(iters, 1))
        T = max(T0 * (1.0 - frac), 1e-6)
        if mk < cur_mk - EPS or rng.random() < math.exp(-(mk - cur_mk) / T):
            cur, cur_res, cur_mk = cand, res, mk
            if mk < best_mk - EPS:
                best, best_res, best_mk = cand, res, mk
                stale = 0
            else:
                stale += 1
        else:
            stale += 1
        if stale >= 40:                            # 停滞 → 回到 best 重启
            cur, cur_res, cur_mk = best, best_res, best_mk
            stale = 0
    if verbose:
        gain = (1.0 - best_mk / base_mk) * 100 if base_mk else 0.0
        print(f"[timing][search] 迭代 {it} 次，用时 {(time.perf_counter()-t0)*1000:.0f} ms，"
              f"best makespan={best_mk:.2f}（较基线 {gain:+.1f}%），"
              f"loadlock 选腔变更 {len(best.ll_assign)} 处。")
    # best_res 自带 schedule/_dist/_tagged，直接返回（避免对空 genome 用快路径重解可能死锁）
    return best_res


# --------------------------------------------------------------------------- #
# 便捷封装
# --------------------------------------------------------------------------- #
def _fixed_default(ir: Problem, tm: Durations, wafers, verbose: bool) -> SolveResult:
    """原始默认（backward）定序 + 驻留预留回退（不动 loadlock 分配）。"""
    res = solve_timing(ir, wafers, verbose=verbose)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        if verbose:
            print("[timing] 快序超驻留 → 回退驻留预留定序(reserve=True)重排。")
        orders = _sequence(ir, tm, wafers, reserve=True)
        res = solve_timing(ir, wafers, orders=orders, verbose=verbose)
    return res


def time_from_ir(ir: Problem, *, verbose: bool = True, cross_check: bool = True,
                 optimize_ll: bool = True, ll_budget: float = 1.0,
                 seed: int = 0, refine_budget: Optional[float] = None) -> SolveResult:
    """_expand → 腔分配寻优 → 默认定序 → solve_timing；可选 milp.check_solution 复核。

    optimize_ll=True（默认）：先 portfolio+贪心定【腔分配】（loadlock + 并行加工腔，最大杠杆，
    逼近 MILP 的 Z 决策），再在该基底上走默认 backward 定序。无可行分配时退回原始默认。
    optimize_ll=False ⇒ 原行为（纯 round-robin 默认腔，作快速/对照基线）。

    refine_budget：腔分配 SA-ILS 预算（秒）。缺省 None ⇒ 多 route(双 job)自动给 6s、单 route 给 0
    （见 _auto_refine_budget / optimize_chambers ④）。单调，零回归。

    快序（吞吐优先）因驻留(qtime)排不出时回退驻留预留定序（reserve=True）。"""
    tm = Durations(ir)
    wafers = ir.wafers
    if optimize_ll:
        rb = _auto_refine_budget(wafers, refine_budget)
        _, wf, res = optimize_chambers(ir, tm, wafers, budget=ll_budget, seed=seed,
                                       refine_budget=rb)
        if res is None:                          # 无可行腔分配 → 原始默认（含 reserve 回退）
            res = _fixed_default(ir, tm, wafers, verbose)
        else:
            wafers = wf
        if verbose:
            print(f"[timing] 腔分配寻优 → makespan={res.makespan:.2f}"
                  if getattr(res, "feasible", False) else "[timing] 腔分配寻优：无可行")
    else:
        res = _fixed_default(ir, tm, wafers, verbose)
    if cross_check and getattr(res, "feasible", False):
        issues = check_solution(ir, res)
        if verbose:
            if issues:
                print(f"[timing][复核] check_solution 报 {len(issues)} 处违例（前 10）：")
                for s in issues[:10]:
                    print("   ", s)
            else:
                print("[timing][复核] check_solution 通过，无违例。")
        res.check_issues = issues                  # type: ignore[attr-defined]
    return res


def optimize_from_ir(ir: Problem, *, budget: float = 2.0, seed: int = 0,
                     verbose: bool = True, cross_check: bool = True) -> SolveResult:
    """time_from_ir 的寻优版：局部搜索（占用序 + loadlock 选腔）逼近 MILP，再可选独立复核。
    单次定序仍由 time_from_ir 提供（快速基线）。"""
    tm = Durations(ir)
    wafers = ir.wafers
    res = optimize_orders(ir, wafers, budget=budget, seed=seed, verbose=verbose)
    if cross_check and getattr(res, "feasible", False):
        issues = check_solution(ir, res)
        if verbose:
            if issues:
                print(f"[timing][复核] check_solution 报 {len(issues)} 处违例（前 10）：")
                for s in issues[:10]:
                    print("   ", s)
            else:
                print("[timing][复核] check_solution 通过，无违例。")
        res.check_issues = issues                  # type: ignore[attr-defined]
    return res


# --------------------------------------------------------------------------- #
# BC 策略派工：用学到的候选打分器替换默认 chooser，经 Banker 安全解码 + solve_timing 求时刻。
# 策略不可行（驻留/无安全候选）时回退默认定序；最终取 min(策略, 默认) ⇒ 最坏不退化。
# 策略对象由 src.policy.load_policy 加载（需 torch）。
# --------------------------------------------------------------------------- #
def _greedy_chooser(policy) -> _Chooser:
    """策略 chooser：对每候选打分，返回分数降序的偏好序（Banker 在解码循环里再保证无死锁）。"""
    from src.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        scores = policy.score_step(step_features(state, cands))
        return sorted(range(len(cands)), key=lambda i: -float(scores[i]))

    return chooser


def _sampling_chooser(policy, rng, temp: float) -> _Chooser:
    """随机 rollout 的 chooser：分数/temp 加 Gumbel 噪声后排序（= 按 softmax(分数/temp) 抽偏好序）。
    多次 rollout 用 timing 精确评估取最优，逼近策略下的最好序——仍是纯 BC（推理期解码，不训练）。"""
    import numpy as np
    from src.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        s = policy.score_step(step_features(state, cands)) / temp
        g = rng.gumbel(size=len(s))
        return list(np.argsort(-(s + g)))

    return chooser


def time_from_policy(ir: Problem, policy, *, n_samples: int = 32, temp: float = 0.7,
                     seed: int = 0, verbose: bool = False, cross_check: bool = False,
                     ll_budget: float = 1.0) -> SolveResult:
    """BC 策略定序 → solve_timing（毫秒级精确评估器）。先把【腔分配】寻优定下（最大杠杆，与
    time_from_ir 同基底），再在该基底上：贪心解码 1 次 + n_samples 次策略随机 rollout，全部
    solve_timing 评估取可行最优。策略全不可行/更差时回退该基底默认定序——返回 min(策略, 默认)，
    **最坏不退化**。n_samples=0 ⇒ 只贪心。

    注：腔分配（loadlock + 并行加工腔）是结构性决策（MILP 的 Z），由毫秒级 portfolio 寻优负责；
    策略只决定该基底上的占用/派工【顺序】。否则策略困在 round-robin 坏默认上，必然 == 固定顺序。"""
    import numpy as np
    tm = Durations(ir)
    rng = np.random.default_rng(seed)

    # 腔分配基底寻优（与 time_from_ir 一致，多 route 自动开 ILS）；无可行则退原始 round-robin 默认。
    _, wafers, base = optimize_chambers(ir, tm, ir.wafers, budget=ll_budget, seed=seed,
                                        refine_budget=_auto_refine_budget(ir.wafers, None))
    if base is None:
        base = _fixed_default(ir, tm, ir.wafers, verbose=False)
        wafers = ir.wafers

    choosers = [_greedy_chooser(policy)]
    choosers += [_sampling_chooser(policy, rng, temp) for _ in range(max(n_samples, 0))]
    best: Optional[SolveResult] = None
    for ch in choosers:
        try:
            orders = _decode_orders(ir, tm, wafers, chooser=ch, reserve=False, banker=True)
        except RuntimeError:
            continue
        r = solve_timing(ir, wafers, orders=orders)
        if getattr(r, "feasible", False) and (best is None or r.makespan < best.makespan):
            best = r

    if best is not None and best.makespan <= getattr(base, "makespan", float("inf")):
        res = best
    else:
        res = base
    if verbose:
        pm = best.makespan if best is not None else float("nan")
        print(f"[timing][policy] 策略最优={pm:.2f}  基底默认={getattr(base,'makespan',float('nan')):.2f}"
              f"  采用={res.makespan:.2f}")
    if cross_check and getattr(res, "feasible", False):
        res.check_issues = check_solution(ir, res)             # type: ignore[attr-defined]
    return res


if __name__ == "__main__":
    # 示例：
    #   from src.parse import parse_task
    #   task = parse_task(tool_topo, update_params)
    #   res = time_from_ir(task, verbose=True)
    #   print("makespan =", res.makespan, "feasible =", res.feasible)
    pass
