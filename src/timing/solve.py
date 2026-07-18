"""主入口：给定顺序 → 建全图 → Bellman-Ford → SolveResult"""

import time
from typing import Dict, List, Optional, Tuple

from src.milp import SolveResult
from src.milp_clean import _clean_specs, _dummy_order_pairs
from src.model import Durations, Problem

from .graph import _Nodes, _bellman_ford_longest
from .sequencing import _Orders, decode_orders
from .spans import _hop_span, _ll_reuse_setup, _robot_switch_gap, _stage_dwell


def solve_timing(ir: Problem, wafers, orders: Optional[_Orders]=None) -> SolveResult:
    t_start = time.perf_counter()
    tm = Durations(ir)
    wmap = {w.wid: w for w in wafers}
    nodes = _Nodes(wafers)
    if orders is None:
        orders = decode_orders(ir, tm, wafers)

    edges: List[Tuple[int, int, float]] = []
    res_edges: List[Tuple[int, int, float]] = []   # 驻留后向边，单列以便诊断

    # 实时重算：投影状态可能要到未来才成立。排程仍从 t1=0 开始，但任何首次
    # 使用受影响站点、槽位、Robot 或物料的动作，都不能早于其相对释放时刻。
    availability = ir.runtime_availability
    if availability is not None:
        for w in wafers:
            material_floor = max(0.0, float(availability.material_ready.get(w.mat_id, 0.0)))
            for j, stage in enumerate(w.stages):
                station_floor = max(0.0, float(availability.station_ready.get(stage.chamber, 0.0)))
                slot_floor = max(
                    0.0,
                    float(availability.slot_ready.get((stage.chamber, stage.slot + 1), 0.0)),
                )
                resource_floor = max(station_floor, slot_floor)

                # 到站动作的最早实际资源占用从目标开门开始；续排首工序没有
                # in_robot，此时 a 本身就是加工/抽充气或源状态的时间锚点。
                arrival_floor = resource_floor
                if stage.in_robot:
                    arrival_floor += tm.place_t(stage.in_robot, stage.chamber)
                    arrival_floor += tm.place_pre(stage.in_robot, stage.chamber)
                if j == 0:
                    arrival_floor = max(arrival_floor, material_floor)
                if arrival_floor > 0.0:
                    edges.append((nodes.source, nodes.a(w.wid, j), arrival_floor))

                if j >= len(w.stages) - 1:
                    continue
                departure_floor = resource_floor + (
                    tm.pick_pre(stage.out_robot, stage.chamber) if stage.out_robot else 0.0
                )
                if j == 0:
                    departure_floor = max(
                        departure_floor,
                        material_floor + (
                            tm.pick_pre(stage.out_robot, stage.chamber) if stage.out_robot else 0.0
                        ),
                    )
                if departure_floor > 0.0:
                    edges.append((nodes.source, nodes.r(w.wid, j), departure_floor))

        # Robot 的互斥顺序保证后续 hop 晚于首个 hop，只需限制解码顺序中的
        # 第一次使用。若 Robot 投影位置不在首个来源站，还要为导出的空载转位留时。
        for robot_name, hops in orders.robots.items():
            ready = max(0.0, float(availability.robot_ready.get(robot_name, 0.0)))
            if ready <= 0.0 or not hops:
                continue
            first_wid, first_stage = hops[0]
            source_station = wmap[first_wid].stages[first_stage].chamber
            projected_position = availability.robot_positions.get(robot_name)
            if projected_position and projected_position != source_station:
                ready += tm.move(robot_name)
            edges.append((nodes.source, nodes.r(first_wid, first_stage), ready))

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
            edges.append((nodes.r(lo.wid, 0), nodes.r(hi.wid, 0), 0.0))

    # 同一路线同一加工工序按晶圆 rank 进入 PM，保证 round-robin 的腔分配顺序不会被
    # 下游资源空闲差异打乱。解码层已用相同规则阻止超车；这里再给差分图加权威边，
    # 覆盖不同机器手或后续 timing 下界导致的实际到站时间反转。
    process_visits: Dict[Tuple[str, int], List[Tuple[int, int, int]]] = {}
    for wafer in wafers:
        for stage_index, stage in enumerate(wafer.stages):
            if stage.stage_type != "process":
                continue
            absolute_stage_index = wafer.resume_stage_index + stage_index
            process_visits.setdefault((wafer.route_name, absolute_stage_index), []).append(
                (wafer.route_rank, wafer.wid, stage_index)
            )
    for visits in process_visits.values():
        visits.sort()
        for previous, current in zip(visits, visits[1:]):
            _, previous_wid, previous_stage = previous
            _, current_wid, current_stage = current
            edges.append((
                nodes.a(previous_wid, previous_stage),
                nodes.a(current_wid, current_stage),
                0.0,
            ))

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

    # loadlock swap 跨槽压力态：LL 双槽按方向分槽（上=entry 未加工 / 下=exit 已加工），异型占用
    # 可共存——如真空手先把已加工片放进下槽、再取走上槽的未加工片。上方腔互斥退化为同槽内
    # （同型复用，_ll_reuse_setup 兼作空抽/空充与异型夹层的转换时长，口径不变）；异型相邻占用
    # 按解码提交序补两条压力边（LL 整腔单一压力态）：
    #   ① 后片进腔开门前，前片的抽/充须已完成（异型 ⇒ 前片转换后的压力态恰是后片所需）：
    #      a(v) ≥ a(u) + place_post(u) + proc(u) + place(v) + place_pre(v)
    #   ② 后片的抽/充须等前片离腔关门（不能带着前片翻压力态）：
    #      r(v) ≥ r(u) + pick(u) + pick_post(u) + proc(v) + pick_pre(v)
    # 非共存（v 在 u 离腔后才进）时两边弱于常规 P/C 边，自动不 binding。
    for c, seq in orders.ll_seq.items():
        for (wu, ju), (wv, jv) in zip(seq, seq[1:]):
            su, sv = wmap[wu].stages[ju], wmap[wv].stages[jv]
            if wu == wv or su.ll_type == sv.ll_type:
                continue                       # 同片 precedence 已序；同型=同槽，上方 C 边已管
            w1 = ((tm.place_post(su.in_robot, c) if su.in_robot else 0.0) + su.proc
                  + (tm.place_t(sv.in_robot, c) + tm.place_pre(sv.in_robot, c) if sv.in_robot else 0.0))
            edges.append((nodes.a(wu, ju), nodes.a(wv, jv), w1))
            w2 = ((tm.pick_t(su.out_robot, c) + tm.pick_post(su.out_robot, c) if su.out_robot else 0.0)
                  + sv.proc + (tm.pick_pre(sv.out_robot, c) if sv.out_robot else 0.0))
            edges.append((nodes.r(wu, ju), nodes.r(wv, jv), w2))
            tagged.append((nodes.r(wu, ju), nodes.r(wv, jv), w2, "C", c, (wu, ju), (wv, jv)))

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

    # 清洁时间预留（与 MILP Part A 一一对应，只加时间边、不改占腔顺序/不加资源）：
    #   pre  → 源点绝对下界：a(首片) ≥ pre_dur + place（占腔起点不早于 pre_dur）
    #   wac / dummy-wac → 前后片占腔间隙：a(后片) ≥ r(前片) + (pick+place 门) + dur
    #   post → makespan 后调（占腔终点 + post_dur），在 _fill_schedule 之后统一取 max
    post_events = []
    for cl in _clean_specs(ir, wafers):
        c = cl.chamber
        if cl.kind == "pre":
            wb, jb = cl.before
            sb = wmap[wb].stages[jb]
            floor = cl.dur + (tm.place_t(sb.in_robot, c) + tm.place_pre(sb.in_robot, c) if sb.in_robot else 0.0)
            edges.append((nodes.source, nodes.a(wb, jb), floor))
        elif cl.kind == "post":
            post_events.append(cl)
        else:  # wac / dummy-wac：占腔终点(前片) + 门间隙 + dur ≤ 占腔起点(后片)
            wa, ja = cl.after
            wb, jb = cl.before
            sa, sb = wmap[wa].stages[ja], wmap[wb].stages[jb]
            gap = (tm.pick_t(sa.out_robot, c) + tm.pick_post(sa.out_robot, c)
                   + tm.place_t(sb.in_robot, c) + tm.place_pre(sb.in_robot, c) + cl.dur)
            edges.append((nodes.r(wa, ja), nodes.a(wb, jb), gap))

    # dummy 清洁段定序（与 MILP CLNdord 一一对应）：同腔 前一 job → dummy 段 → 本 job，
    # 纯定序时间边（仅门间隙，无清洁时长；dummy-wac 时长已在上方 wac 支路）。
    for (wa, ja), (wb, jb) in _dummy_order_pairs(ir, wafers):
        sa, sb = wmap[wa].stages[ja], wmap[wb].stages[jb]
        c = sa.chamber
        gap = (tm.pick_t(sa.out_robot, c) + tm.pick_post(sa.out_robot, c)
               + tm.place_t(sb.in_robot, c) + tm.place_pre(sb.in_robot, c))
        edges.append((nodes.r(wa, ja), nodes.a(wb, jb), gap))

    # 求解：含驻留后向边的全图
    dist, ok = _bellman_ford_longest(len(nodes), edges + res_edges)

    res = SolveResult(status=2 if ok else 3, makespan=float("nan"))
    res.runtime = time.perf_counter() - t_start
    res.feasible = ok                              # type: ignore[attr-defined]
    res.residency_violations = []                  # type: ignore[attr-defined]

    if ok:
        _fill_schedule(res, wafers, nodes, dist)
        for cl in post_events:                     # 后清洁计入 makespan（末片占腔终点 + post_dur）
            wa, ja = cl.after
            sa = wmap[wa].stages[ja]
            end = (dist[nodes.r(wa, ja)] + tm.pick_t(sa.out_robot, cl.chamber)
                   + tm.pick_post(sa.out_robot, cl.chamber) + cl.dur)
            res.makespan = max(res.makespan, end)
        res._dist = dist                           # type: ignore[attr-defined]
        res._tagged = tagged                       # type: ignore[attr-defined]
        return res

    # 不可行：去掉驻留边再求一次，用来区分「真死锁」和「纯粹驻留超限」
    dist0, ok0 = _bellman_ford_longest(len(nodes), edges)
    if not ok0:
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
