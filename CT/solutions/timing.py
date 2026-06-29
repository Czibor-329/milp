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
  · swap（换料，与 milp.py 现状一致：swap 暂关）。
  · 多容量【加工】腔的门簇互斥 (Cd)。命中多容量非 skip 加工腔时 makespan 可能偏乐观。

用法：
    from timing import time_from_ir
    res = time_from_ir(ir, verbose=True)        # res 是 SolveResult，且带 .feasible / .residency_violations
    issues = check_solution(ir, res)            # 直接复用 milp 的独立复核

导入路径按你的工程调整：下面从 `milp` 导入，若 milp.py 在包内请改成对应路径，
例如 `from CT.solutions.xxx.milp import ...`。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

# —— 按你的工程调整这一行 —— #
from CT.solutions.milp import _expand, _Timing, SolveResult, check_solution  # noqa: F401
from CT.solutions.preprocess.internal_data import PreprocessedTask


EPS = 1e-9
SKIP_TYPES = {"loadport", "buffer", "dummyport"}


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
def _pdur(tm: _Timing, w, j: int) -> float:
    """站内停留：place 关门 + 加工/抽充气 + pick 开门（s.proc 在 _expand 已置为 LL 的 pump/vent）。"""
    s = w.stages[j]
    pp = tm.place_post(s.in_robot, s.chamber) if s.in_robot else 0.0
    pre = tm.pick_pre(s.out_robot, s.chamber) if s.out_robot else 0.0
    return pp + s.proc + pre


def _L(tm: _Timing, w, j: int) -> float:
    """hop j→j+1 占机器手时长 = pick + move + place（门不占手）。"""
    rob = w.transports[j]
    return (tm.pick_t(rob, w.stages[j].chamber) + tm.move(rob)
            + tm.place_t(rob, w.stages[j + 1].chamber))


def _ll_setup(ir: PreprocessedTask, prev_stage, nxt_stage) -> float:
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


def _gap(ir: PreprocessedTask, tm: _Timing, rob: str, wa, ja: int, wb, jb: int) -> float:
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
def _resource(ir: PreprocessedTask, w, j: int) -> Optional[Tuple[str, int]]:
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


# —— 驻留(qtime)预留：单臂下，共享 loadlock 既进又出，新片的「进」易抢在在制片的「出」
# 之前，把片闷在加工腔里超驻留。对策：片一进入驻留腔（run），就把它出口去向资源（紧邻下一
# 跳 + 驻留 run 末端的落脚资源）预留下来，挡住别的片占用，保证其能按时离腔。仅 reserve=True
# 时启用（在快序驻留不可行时回退采用，见 time_from_ir）。
def _is_resid(w, k: int) -> bool:
    return (0 <= k < len(w.stages) and w.stages[k].stage_type == "process"
            and w.stages[k].residency > 0)


def _reserve_for(ir: PreprocessedTask, w, nj: int) -> set:
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


def _drain_completes(ir: PreprocessedTask, wmap: Dict[int, object], K: Dict[int, int],
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


def _sequence(ir: PreprocessedTask, tm: _Timing, wafers, reserve: bool = False) -> _Orders:
    """全局 backward 事件式构造：产出各 (腔,槽) 占用序与各机器手 hop 序（彼此自洽、无死锁）。
    reserve=True 时额外做驻留(qtime)预留（牺牲吞吐换驻留可行），仅在快序驻留不可行时回退采用。"""
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
        cands: List[Tuple[float, int, int, int, Optional[Tuple[str, int]], str]] = []
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
            cands.append((start, -j, wid, j, dest, rob))   # 最早可起；并列时下游(大 j)优先
        cands.sort()

        # Banker：取「保持状态安全」的最早候选；纯下游候选必安全 ⇒ 一定选得出
        chosen = None
        for c in cands:
            _, _, wid, j, dest, _ = c
            tpos = dict(pos)
            tocc = dict(occ)
            tresv = dict(resv) if reserve else {}
            src = _resource(ir, wmap[wid], j)
            if src is not None and tocc.get(src) == wid:
                del tocc[src]
            if dest is not None and tresv.get(dest) == wid:
                del tresv[dest]
            if dest is not None:
                tocc[dest] = wid
            if reserve:
                for er in _reserve_for(ir, wmap[wid], j + 1):
                    tresv[er] = wid
            tpos[wid] = j + 1
            if _drain_completes(ir, wmap, K, tpos, tocc, tresv, reserve):
                chosen = c
                break
        if chosen is None:                 # 理论不达：纯下游候选恒安全
            raise RuntimeError("[timing] 定序构造无安全候选（疑似拓扑无可行解）")

        start, _, wid, j, dest, rob = chosen
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


def default_orders(ir: PreprocessedTask, tm: _Timing, wafers, nodes: _Nodes = None) -> _Orders:
    """无死锁 backward 定序（替代旧的松弛最早时刻占位）。nodes 参数保留以兼容旧调用，未使用。"""
    return _sequence(ir, tm, wafers)


# --------------------------------------------------------------------------- #
# 主入口：给定顺序 → 建全图 → Bellman-Ford → SolveResult
# --------------------------------------------------------------------------- #
def solve_timing(ir: PreprocessedTask, wafers=None, *, orders: Optional[_Orders] = None,
                 release_interval: float = 0.0, verbose: bool = False) -> SolveResult:
    """对固定顺序求最早时刻。返回 SolveResult，并附加：
         res.feasible（bool）、res.residency_violations（[(wid,j,腔,实际驻留,上限)]）。

    release_interval：同 route 相邻两片发片(r0)的最小间隔。0=尽快发片；>0 用于节流发片
    （降低在制品 WIP），让驻留腔有时间被腾空——驻留(qtime)不可行时由 solve_timing_paced
    二分搜索最小可行间隔。"""
    t_start = time.perf_counter()
    tm = _Timing(ir)
    if wafers is None:
        wafers = _expand(ir, tm)
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
            edges.append((nodes.r(wlo, jlo), nodes.a(whi, jhi), wgt))

    # (R) 机器手互斥：固定次序里 op1 先 op2 后 → r[op2] ≥ a_next[op1] + gap
    for rob, ops in orders.robots.items():
        for (w1, j1), (w2, j2) in zip(ops, ops[1:]):
            if w1 == w2:
                continue
            wa, wb = wmap[w1], wmap[w2]
            g = _gap(ir, tm, rob, wa, j1, wb, j2)
            edges.append((nodes.a(w1, j1 + 1), nodes.r(w2, j2), g))

    # 求解：含驻留后向边的全图
    dist, ok = _bellman_ford_longest(len(nodes), edges + res_edges)

    res = SolveResult(status=2 if ok else 3, makespan=float("nan"))
    res.runtime = time.perf_counter() - t_start
    res.feasible = ok                              # type: ignore[attr-defined]
    res.residency_violations = []                  # type: ignore[attr-defined]

    if ok:
        _fill_schedule(res, wafers, nodes, dist)
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
# 便捷封装
# --------------------------------------------------------------------------- #
def time_from_ir(ir: PreprocessedTask, *, verbose: bool = True,
                 cross_check: bool = True) -> SolveResult:
    """_expand → 默认定序 → solve_timing；可选用 milp.check_solution 独立复核。

    若快序（吞吐优先）因驻留(qtime)排不出，自动回退到驻留预留定序（reserve=True，牺牲吞吐
    换驻留可行）再求一次。死锁所致的不可行不回退（预留无济于事）。"""
    tm = _Timing(ir)
    wafers = _expand(ir, tm)
    res = solve_timing(ir, wafers, verbose=verbose)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        if verbose:
            print("[timing] 快序超驻留 → 回退驻留预留定序(reserve=True)重排。")
        orders = _sequence(ir, tm, wafers, reserve=True)
        res = solve_timing(ir, wafers, orders=orders, verbose=verbose)
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


if __name__ == "__main__":
    # 示例（按你的工程改）：
    #   from CT.solutions.preprocess import preprocess_task
    #   ir = preprocess_task(...)
    #   res = time_from_ir(ir, verbose=True)
    #   print("makespan =", res.makespan, "feasible =", res.feasible)
    pass
