"""无死锁定序（backward 节拍，面向单臂机器手）+ 可搜索候选解码器。

单臂机器手一次只持一片：要把上游片搬进某腔，该腔必须先空。于是对一条流水顺序
LA→PM1→LB，唯一无死锁的机器手节拍是「先把 PM1 的片搬到 LB（清空 PM1），再退回
LA 把片搬进 PM1」——下游 hop 先于上游 hop 的 backward 节拍。

旧占位定序（按「松弛最早时刻」给各资源各自独立排序）在 ≥2 片时会让某资源的
「装入序」与腔的「占用序」互相矛盾 → 差分图出现正环 → 报死锁。这里改成一次全局
事件式构造，产出彼此自洽的各资源占用序，结构上即无死锁：
  · 流水线性（吞吐）：按「最早可起」派工，腔加工期间机器手回头发上游片；
  · 无死锁（正确性）：Banker 安全检查——仅当「仍保留一条能让所有片完工的纯下游
    清空序」时才提交该派工，否则退而取次优候选。纯下游清空（每步总挑最下游可动
    hop）对单臂可证无死锁，用作安全谕示(oracle)；故每步至少有一个安全候选，必有进展。

资源粒度：每个 (腔,槽) 视作容量 1 的占用单元（与 _expand 的 round-robin 定槽、与
milp.py 的腔互斥口径一致）；source/sink 与 loadport/buffer/dummyport 不占资源。

把定死的 backward 规则改成「可搜索」：解码器 _decode_orders 每步把「合法候选 hop」交给
chooser 排序，循环再套 Banker 安全掩码提交。同一候选合法性供三方共用：默认(start+bias
排序，_make_default_chooser)、teacher(MILP 序，标签提取)、policy(网络打分，推理)。
"""

from __future__ import annotations

from dataclasses import dataclass
from collections import namedtuple
from typing import Callable, Dict, List, Optional, Tuple

from src.model import Durations, Problem

from ._common import SKIP_TYPES, _DecodeDeadlock
from .spans import _hop_span, _stage_dwell


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
    if s.stage_type in ("source", "sink"):
        return None
    c = s.chamber
    if c not in ir.chambers or c in _skip_chambers(ir):
        return None
    return (c, s.slot)


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


def _build_resource_map(ir: Problem, wmap: Dict[int, object]) -> Dict[Tuple[int, int], Optional[Tuple[str, int]]]:
    """预算每片每 stage 的 (腔,槽) 资源键一次。解码内热点 _drain_completes 被调数万次、每次 O(剩余)
    遍历，原先每格重算 _resource（数百万次）；预算后改 dict 查表，是解码提速的大头。"""
    return {(w.wid, j): _resource(ir, w, j)
            for w in wmap.values() for j in range(len(w.stages))}


def _drain_completes(ir: Problem, wmap: Dict[int, object], K: Dict[int, int],
                     pos: Dict[int, int], occ: Dict[Tuple[str, int], int],
                     resv: Dict[Tuple[str, int], int], reserve: bool = False,
                     res_map: Optional[Dict[Tuple[int, int], Optional[Tuple[str, int]]]] = None) -> bool:
    """安全谕示：从 (pos, occ, resv) 起，用纯下游清空（每步挑剩余最下游、去向未被占/预留的 hop）
    能否把所有片送完？能 ⇒ 当前状态安全（无死锁）。纯下游清空对单臂流水可证无死锁，故
    「存在完工序」当且仅当它能跑完。预留只挡新进、不挡在制片出腔，故不致死锁。
    res_map：预算好的 (wid,j)→资源键表（_decode_orders 传入共享、避免重算）；None 时本地建一次。"""
    if res_map is None:
        res_map = _build_resource_map(ir, wmap)
    pos = dict(pos)
    occ = dict(occ)
    resv = dict(resv)
    remaining = sum(K[wid] - pos[wid] for wid in pos)
    while remaining > 0:
        pick = None                       # (-j, wid)：最下游优先
        for wid, j in pos.items():
            if j >= K[wid]:
                continue
            dest = res_map[(wid, j + 1)]
            if _blocked(dest, occ, resv, wid):
                continue
            cand = (-j, wid)
            if pick is None or cand < pick:
                pick = cand
        if pick is None:
            return False                  # 无可动 hop 却未完工 = 死锁
        wid = pick[1]
        j = pos[wid]
        src = res_map[(wid, j)]
        if src is not None and occ.get(src) == wid:
            del occ[src]
        dest = res_map[(wid, j + 1)]
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
    res_map = _build_resource_map(ir, wmap)      # (wid,j)→资源键，预算一次供候选/Banker 复用（热点提速）
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
            dest = res_map[(wid, j + 1)]
            if _blocked(dest, occ, resv if reserve else {}, wid):
                continue
            if j == 0 and route_wids[w.route_name][next_rel[w.route_name]] != wid:
                continue
            rob = w.transports[j]
            start = max(place_t[wid] + _stage_dwell(tm, w, j), robot_free.get(rob, 0.0))
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
                src = res_map[(c.wid, c.j)]
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
                if _drain_completes(ir, wmap, K, tpos, tocc, tresv, reserve, res_map):
                    chosen = c
                    break
            if chosen is None:             # 理论不达：纯下游候选恒安全
                raise RuntimeError("[timing] 定序构造无安全候选（疑似拓扑无可行解）")

        wid, j, dest, rob, start = chosen
        w = wmap[wid]
        src = res_map[(wid, j)]
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
        place_t[wid] = start + _hop_span(tm, w, j)
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


def default_orders(ir: Problem, tm: Durations, wafers) -> _Orders:
    """无死锁 backward 定序（替代旧的松弛最早时刻占位）。"""
    return _sequence(ir, tm, wafers)
