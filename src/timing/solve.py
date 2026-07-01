"""主入口：给定顺序 → 建全图 → Bellman-Ford → SolveResult"""

import time
from typing import Dict, List, Optional, Tuple

from src.milp import SolveResult
from src.model import Durations, Problem

from .graph import _Nodes, _bellman_ford_longest
from .sequencing import _Orders, default_orders
from .spans import _hop_span, _ll_reuse_setup, _robot_switch_gap, _stage_dwell


def solve_timing(ir: Problem, wafers=None, *, orders: Optional[_Orders] = None,
                 release_interval: float = 0.0, verbose: bool = False) -> SolveResult:
    """对固定顺序求最早时刻。返回 SolveResult，并附加：
         res.feasible（bool）、res.residency_violations（[(wid,j,腔,实际驻留,上限)]）。

    release_interval：同 route 相邻两片发片(r0)的最小间隔。0=尽快发片；>0 用于节流发片
    （降低在制品 WIP），让驻留腔有时间被腾空。"""
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
            pdur, Lj = _stage_dwell(tm, w, j), _hop_span(tm, w, j)
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

    # 腔互斥：顺序确定后，先离腔的片(leave)让出腔位后，后进腔的片(enter)才能到站
    # a[wafer1, enter stage] ≥ r[wafer2, leave stage] + gap
    # 对于腔室来说 gap = 2door + pick + place
    # 对于LoadLock gap = 2door + pick + place + vent/pump
    for (chamber, _slot), occupants in orders.chambers.items():
        # 按照顺序依次构造约束关系
        for (wid_leave, j_leave), (wid_enter, j_enter) in zip(occupants, occupants[1:]):
            if wid_leave == wid_enter:
                continue                            # 同片重访：precedence 已序
            stage_leave = wmap[wid_leave].stages[j_leave]
            stage_enter = wmap[wid_enter].stages[j_enter]
            # gap = pick + post_prepare + place + post_prepare + ll time
            gap = (tm.pick_t(stage_leave.out_robot, chamber) + tm.pick_post(stage_leave.out_robot, chamber)
                   + tm.place_t(stage_enter.in_robot, chamber) + tm.place_pre(stage_enter.in_robot, chamber)
                   + _ll_reuse_setup(ir, stage_leave, stage_enter))
            tail, head = nodes.r(wid_leave, j_leave), nodes.a(wid_enter, j_enter)
            # tail + gap <= head
            edges.append((tail, head, gap))
            tagged.append((tail, head, gap, "C", chamber, (wid_leave, j_leave), (wid_enter, j_enter)))

    # 机器手互斥：顺序确定后，前一跳(prev)把片落位后，机器手隔 gap 才能开始下一跳(next)的取片
    # r[next] ≥ a[prev] + gap
    # 两跳去向不同腔 / 同腔但非多槽 skip 站：gap = 两个不同腔室之间机器手旋转的时长
    # 两跳连续去向同一个多槽 skip 站(如 heater/cooler，capacity>1)：gap = 关门(place_post) + 开门(pick_pre)
    for rob, hops in orders.robots.items():
        # 按照顺序依次构造约束关系
        for (wid_prev, j_prev), (wid_next, j_next) in zip(hops, hops[1:]):
            if wid_prev == wid_next:
                continue                            # 同片重访：precedence 已序
            wafer_prev, wafer_next = wmap[wid_prev], wmap[wid_next]
            gap = _robot_switch_gap(ir, tm, rob, wafer_prev, j_prev, wafer_next, j_next)
            tail, head = nodes.a(wid_prev, j_prev + 1), nodes.r(wid_next, j_next)
            # tail + gap <= head
            edges.append((tail, head, gap))
            tagged.append((tail, head, gap, "R", rob, (wid_prev, j_prev), (wid_next, j_next)))

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

    # 不可行：去掉驻留边再求一次，用来区分「真死锁」和「纯粹驻留超限」
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
                limit = _stage_dwell(tm, w, j) + s.residency
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
