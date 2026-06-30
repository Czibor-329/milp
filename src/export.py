from src.model import Chamber, Durations, Problem, Stage, Wafer
from src.milp import SolveResult, _ll_proc, _swap_candidates,_clean_specs
from typing import List, Tuple, Dict, Optional

def export_movelist(task: Problem, res: SolveResult) -> List[dict]:
    """把 MILP 排程展开成 MoveList（过 validate_movelist）。

    每段搬运在 [r, a_next] 窗口内按子动作顺序铺：
      源端 开门(6)→pick(0)→关门(7) → 走位(5) → 目标端 开门(6)→place(1)→关门(7)
    每个 stage 另铺 加工(9) / loadlock 抽充气(10)。窗口与 solve_milp 的时长口径一致，
    腔/机器手不重叠由 MILP 保证，故子动作天然串行、门成对。
    """
    tm = Durations(task)
    wafers = {w.wid: w for w in task.wafers}
    moves: List[dict] = []
    mid = 0
    # bug1：机器手 pick 前的空载转位（PreTransMove）；bug2：LL 连续两用间的空抽/空充
    robot_hops: Dict[str, List[Tuple[float, str, str]]] = {}   # robot -> [(r, src, prev_dst 由排序得)]
    ll_occs: Dict[str, List[Tuple[float, float, str]]] = {}    # LL -> [(occ_start, occ_end, ll_type)]

    # 解里取 1 的 swap：恢复 _SwapPair 以便把「出腔 pick + 进腔 place」合成一趟换料。
    # gov_in：w_in 进腔 hop(=j_in-1)；gov_out：w_out 出腔 hop(=j_out)。两 hop 不再各铺一遍。
    swap_set = set(res.swaps)
    swaps = {(p.chamber, p.w_out.wid, p.w_in.wid): p
             for p in _swap_candidates(task, [wafers[k] for k in sorted(wafers)])
             if (p.chamber, p.w_out.wid, p.w_in.wid) in swap_set}
    gov_in = {(p.w_in.wid, p.j_in - 1): p for p in swaps.values()}
    gov_out = {(p.w_out.wid, p.j_out): p for p in swaps.values()}

    def emit(mtype: int, start: float, end: float, *, station: str = "",
             robot: str = "", src: str = "", dst: str = "", cslot: int = 1,
             w: Optional[Wafer] = None, **extra) -> None:
        nonlocal mid
        mid += 1
        mv = {
            "MoveType": mtype, "MoveID": mid, "StartTime": start, "EndTime": end,
            "ModuleName": robot or station, "SlotList": [cslot],
        }
        if station:
            mv["Station"] = station
        if robot:
            mv["Robot"] = robot
            mv["RobotSlotList"] = [1]
        if src:
            mv["SrcStationList"] = [src]; mv["SrcSlotList"] = [cslot]
        if dst:
            mv["DestStationList"] = [dst]; mv["DestSlotList"] = [cslot]
        if w is not None:
            mv["MatIDList"] = [w.mat_id]; mv["PJobName"] = [w.pjob_name]
        mv.update(extra)
        moves.append(mv)

    def emit_hop(w: Wafer, j: int) -> None:
        """普通单片原子搬运 c→下一腔：源 开门(6)→pick(0)→关门(7) → 走位(5) → 目标 开门(6)→place(1)→关门(7)。"""
        rows = res.schedule[w.wid]
        c, rv = rows[j][1], rows[j][3]
        cs = w.stages[j].slot + 1
        R = w.transports[j]
        nxt_c, ns, a_next = rows[j + 1][1], w.stages[j + 1].slot + 1, rows[j + 1][2]
        robot_hops.setdefault(R, []).append((rv, c, nxt_c))  # (pick 时刻, 源, 目标)
        pre_c, pt, post_c = tm.pick_pre(R, c), tm.pick_t(R, c), tm.pick_post(R, c)
        pre_n, post_n = tm.place_pre(R, nxt_c), tm.place_post(R, nxt_c)
        arrive = rv + pt + tm.move(R)
        emit(6, rv - pre_c, rv, station=c, cslot=cs, w=w)                   # 源开门(pick 前，与到位并行)
        emit(0, rv, rv + pt, robot=R, src=c, cslot=cs, w=w)                 # pick
        emit(7, rv + pt, rv + pt + post_c, station=c, cslot=cs, w=w)        # 源关门(与走位并行)
        emit(5, rv + pt, arrive, robot=R, src=c, dst=nxt_c, cslot=cs, w=w)  # 走位
        emit(6, arrive - pre_n, arrive, station=nxt_c, cslot=ns, w=w)       # 目标开门(与走位并行)
        emit(1, arrive, a_next, robot=R, dst=nxt_c, cslot=ns, w=w)          # place
        emit(7, a_next, a_next + post_n, station=nxt_c, cslot=ns, w=w)      # 目标关门(与下一动作并行)

    def emit_swap(p: "_SwapPair") -> None:
        """双臂换料一趟：c_prev 取 w_in → 走位到 c → 腔门开一次：pick w_out、place w_in → 关门 →
        走位到 c_next 放 w_out。出腔 pick 与进腔 place 串行（先取后放），腔门只成对一次。"""
        R, c = p.robot, p.chamber
        w_in, w_out, pin = p.w_in, p.w_out, p.j_in - 1
        rin, rout = res.schedule[w_in.wid], res.schedule[w_out.wid]
        c_prev, cs_prev = rin[pin][1], w_in.stages[pin].slot + 1       # w_in 来源腔(如 LL)
        c_next, cs_next = rout[p.j_out + 1][1], w_out.stages[p.j_out + 1].slot + 1  # w_out 去向腔
        cs_in, cs_out = w_in.stages[p.j_in].slot + 1, w_out.stages[p.j_out].slot + 1
        r_in = rin[pin][3]                          # VTR 在 c_prev pick w_in
        a_in = rin[p.j_in][2]                       # w_in place 入 c 完成 = pick+place 末
        a_out_next = rout[p.j_out + 1][2]           # w_out place 入 c_next 完成
        pre_p, pt_p, post_p = tm.pick_pre(R, c_prev), tm.pick_t(R, c_prev), tm.pick_post(R, c_prev)
        pre_c, post_c = tm.pick_pre(R, c), tm.place_post(R, c)
        pt_out, plt_in = tm.pick_t(R, c), tm.place_t(R, c)
        pre_n, post_n = tm.place_pre(R, c_next), tm.place_post(R, c_next)
        mv = tm.move(R)
        arrive = r_in + pt_p + mv                   # 持 w_in 抵 c（= swap 起点）
        arrive2 = a_in + mv                          # 持 w_out 抵 c_next
        emit(6, r_in - pre_p, r_in, station=c_prev, cslot=cs_prev, w=w_in)             # 源开门
        emit(0, r_in, r_in + pt_p, robot=R, src=c_prev, cslot=cs_prev, w=w_in)         # pick w_in
        emit(7, r_in + pt_p, r_in + pt_p + post_p, station=c_prev, cslot=cs_prev, w=w_in)  # 源关门
        emit(5, r_in + pt_p, arrive, robot=R, src=c_prev, dst=c, cslot=cs_prev, w=w_in)    # 走位→c
        emit(6, arrive - pre_c, arrive, station=c, cslot=cs_out, w=w_out)              # 腔开门(一次)
        emit(0, arrive, arrive + pt_out, robot=R, src=c, cslot=cs_out, w=w_out)        # 先 pick w_out
        emit(1, arrive + pt_out, a_in, robot=R, dst=c, cslot=cs_in, w=w_in)            # 后 place w_in
        emit(7, a_in, a_in + post_c, station=c, cslot=cs_in, w=w_in)                   # 腔关门(一次)
        emit(5, a_in, arrive2, robot=R, src=c, dst=c_next, cslot=cs_out, w=w_out)      # 走位→c_next
        emit(6, arrive2 - pre_n, arrive2, station=c_next, cslot=cs_next, w=w_out)      # 目标开门
        emit(1, arrive2, a_out_next, robot=R, dst=c_next, cslot=cs_next, w=w_out)      # place w_out
        emit(7, a_out_next, a_out_next + post_n, station=c_next, cslot=cs_next, w=w_out)   # 目标关门
        robot_hops.setdefault(R, []).append((r_in, c_prev, c_next))   # 一趟净起于 c_prev、终于 c_next

    for wid, rows in res.schedule.items():
        w = wafers[wid]
        K = len(rows) - 1
        for j, (stype, c, av, rv) in enumerate(rows):
            s = w.stages[j]
            cs = s.slot + 1
            # stage 装饰：加工 / 抽充气，发生在 place 关门之后
            d0 = av + (tm.place_post(s.in_robot, c) if s.in_robot else 0.0)
            llp = _ll_proc(task, c, s.ll_type) if stype == "loadlock" else 0.0
            if stype == "process" and s.proc > 0:
                emit(9, d0, d0 + s.proc, station=c, cslot=cs, w=w)
            elif stype == "loadlock" and llp > 0:
                # type-10 抽充气：按 ll_type 记压力态转移（entry 抽气 ATM→VAC、exit 充气 VAC→ATM），
                # 与下方空抽/空充口径统一，使同一 LL 的 type-10 序列成 ATM/VAC 干净交替（可校验）。
                last, cur = ("ATM", "VAC") if s.ll_type == "entry" else ("VAC", "ATM")
                emit(10, d0, d0 + llp, station=c, cslot=cs, w=w,
                     LastState=last, CurState=cur)
                # 收集 LL 占用窗口（含门），供 bug2 的空抽/空充补铺
                occ_s = av - (tm.place_t(s.in_robot, c) + tm.place_pre(s.in_robot, c) if s.in_robot else 0.0)
                occ_e = rv + (tm.pick_t(s.out_robot, c) + tm.pick_post(s.out_robot, c) if s.out_robot else 0.0)
                ll_occs.setdefault(c, []).append((occ_s, occ_e, s.ll_type))
            if j >= K:
                continue
            # 出站搬运 c -> 下一腔。门动作与机器手行程并行（见 §6-1）。
            # swap 治理的两 hop（w_in 进腔 / w_out 出腔）合成一趟，由 emit_swap 在 w_in 进腔 hop 触发一次。
            if (wid, j) in gov_in:
                emit_swap(gov_in[(wid, j)])
            elif (wid, j) in gov_out:
                pass  # 已并入对应 swap，跳过避免重复铺设
            else:
                emit_hop(w, j)

    # bug1：空载转位（PreTransMove）。机器手 pick 前若指向上一目标≠本源，须先转过来。
    # 时长 = move，铺在 pick 前 [r-move, r]（与 MILP 的 (R) 空手 move 间隙一致，必落在空档内）。
    for R, hops in robot_hops.items():
        hops.sort()                       # 按 pick 时刻 = 机器手执行序
        mv = tm.move(R)
        prev_dst = None
        for rv, src, dst in hops:
            if prev_dst is not None and prev_dst != src:
                emit(5, rv - mv, rv, robot=R, src=prev_dst, dst=src)  # 空载转位，无晶圆
            prev_dst = dst

    # bug2：LL 连续两用间的空抽/空充。entry→entry 须空充(vent 回大气才能再接收大气片)，
    # exit→exit 须空抽(pump 回真空才能再接收真空片)。铺在下一次占用前 [occ_s-setup, occ_s]。
    for c, occs in ll_occs.items():
        occs.sort()
        ch = task.chambers.get(c)
        vent = float((ch.vent_time if ch else 0.0) or 0.0)
        pump = float((ch.pump_time if ch else 0.0) or 0.0)
        for (s0, e0, t0), (s1, e1, t1) in zip(occs, occs[1:]):
            # entry→entry 须空充(VAC→ATM 回大气才能再接收大气片)，exit→exit 须空抽(ATM→VAC)。
            # LastState=前态、CurState=目标态：与每片 type-10 串成 ATM/VAC 交替链；无片用空 MatIDList 标记。
            setup, last, cur = (vent, "VAC", "ATM") if (t0 == "entry" and t1 == "entry") else \
                               (pump, "ATM", "VAC") if (t0 == "exit" and t1 == "exit") else (0.0, "", "")
            if setup > 0:
                emit(10, s1 - setup, s1, station=c, MatIDList=[],
                     LastState=last, CurState=cur)

    # 清洁占腔（决策4）：type-9 无片，按解出的相邻片占用窗口定位
    def _occ_s(wid: int, j: int) -> float:
        s = wafers[wid].stages[j]; _, c, av, _ = res.schedule[wid][j]
        return av - (tm.place_t(s.in_robot, c) + tm.place_pre(s.in_robot, c) if s.in_robot else 0.0)

    def _occ_e(wid: int, j: int) -> float:
        s = wafers[wid].stages[j]; _, c, _, rv = res.schedule[wid][j]
        return rv + (tm.pick_t(s.out_robot, c) + tm.pick_post(s.out_robot, c) if s.out_robot else 0.0)

    for cl in _clean_specs(task, list(wafers.values())):
        if cl.kind == "pre":
            end = _occ_s(*cl.before); start = end - cl.dur
        else:  # post / wac 都跟在某片占用之后
            start = _occ_e(*cl.after); end = start + cl.dur
        emit(9, start, end, station=cl.chamber, cslot=cl.slot + 1,
             MatIDList=[], CleanRecipe=cl.recipe, CleanTaskName=cl.task)

    moves.sort(key=lambda m: (m["StartTime"], m["MoveID"]))
    return moves


def check_solution(task: Problem, res: SolveResult) -> List[str]:
    """独立复核：把解代回各约束，返回违例列表（空=通过）。验证 MILP 自身正确。"""
    tm = Durations(task)
    wafers = {w.wid: w for w in task.wafers}
    sched = res.schedule
    issues: List[str] = []
    eps = 1e-4
    # swap 对：腔内占用与 VTR 两手活按设计重叠，(C)/(R) 不计为违例；但重叠须恰是合法换料形态，
    # 故在此正向校验：同一趟 VTR 先 pick(w_out) 后 place(w_in)，进腔 place 紧接 swap=pick+place。
    swap_pair_set = {frozenset((o, i)) for _, o, i in res.swaps}
    swap_cham_set = {(frozenset((o, i)), c) for c, o, i in res.swaps}  # 合法重叠仅限被换腔
    swap_meta = {(p.chamber, p.w_out.wid, p.w_in.wid): p
                 for p in _swap_candidates(task, [wafers[k] for k in sorted(wafers)])}
    for c, o, i in res.swaps:
        p = swap_meta.get((c, o, i))
        if p is None:
            issues.append(f"swap 违例 腔{c}: ({o},{i}) 不是合法 swap 候选")
            continue
        r_out = sched[o][p.j_out][3]                 # VTR pick w_out 时刻
        a_in = sched[i][p.j_in][2]                   # w_in place 入腔完成
        swap_dur = tm.pick_t(p.robot, c) + tm.place_t(p.robot, c)
        if a_in + eps < r_out:                       # 须先取后放
            issues.append(f"swap 违例 腔{c}: w{i} place({a_in:.1f}) 早于 w{o} pick({r_out:.1f})")
        if abs((a_in - r_out) - swap_dur) > 1e-3:    # 一趟换料 = pick+place，时序须吻合
            issues.append(f"swap 违例 腔{c}: w{o}->w{i} 换料时长 {a_in - r_out:.2f} ≠ pick+place {swap_dur:.2f}")

    # (P) place 关门 + 加工 + pick 开门 完成才能取
    for wid, rows in sched.items():
        w = wafers[wid]
        for j in range(len(rows) - 1):
            _, c, av, rv = rows[j]
            s = w.stages[j]
            proc = _ll_proc(task, c, s.ll_type) if s.stage_type == "loadlock" else s.proc
            need = (av + (tm.place_post(s.in_robot, c) if s.in_robot else 0.0) + proc
                    + (tm.pick_pre(s.out_robot, c) if s.out_robot else 0.0))
            if rv + eps < need:
                issues.append(f"P 违例 w{wid} stage{j}: r={rv:.1f} < {need:.1f}")

    # (C) 每 (腔,槽位) 不重叠（跳过 loadport/buffer/dummyport 与 source/sink）
    skip_types = {"loadport", "buffer", "dummyport"}
    intervals: Dict[Tuple[str, int], List[Tuple[float, float, int]]] = {}
    for wid, rows in sched.items():
        w = wafers[wid]
        for j, (_, c, av, rv) in enumerate(rows):
            ch = task.chambers.get(c)
            s = w.stages[j]
            if ch is None or str(ch.type).lower() in skip_types or s.stage_type in ("source", "sink"):
                continue
            st = av - (tm.place_t(s.in_robot, c) + tm.place_pre(s.in_robot, c) if s.in_robot else 0.0)
            en = rv + (tm.pick_t(s.out_robot, c) + tm.pick_post(s.out_robot, c) if s.out_robot else 0.0)
            intervals.setdefault((c, s.slot), []).append((st, en, wid))
    for (c, slot), ivs in intervals.items():
        ivs.sort()
        for i in range(len(ivs) - 1):
            if (frozenset((ivs[i][2], ivs[i + 1][2])), c) in swap_cham_set:
                continue  # swap：仅被换腔上 w_in 随 w_out 同窗换入，占用重叠合法
            if ivs[i][1] > ivs[i + 1][0] + eps:
                issues.append(f"C 重叠 腔{c}#{slot}: w{ivs[i][2]}[..{ivs[i][1]:.1f}] 与 w{ivs[i+1][2]}[{ivs[i+1][0]:.1f}..]")

    # (R) 机器手不重叠
    rob_iv: Dict[str, List[Tuple[float, float, int]]] = {}
    for wid, rows in sched.items():
        w = wafers[wid]
        for j in range(len(rows) - 1):
            _, _, _, rv = rows[j]
            _, _, av_next, _ = rows[j + 1]
            rob_iv.setdefault(w.transports[j], []).append((rv, av_next, wid))
    for rob, ivs in rob_iv.items():
        ivs.sort()
        for i in range(len(ivs) - 1):
            if frozenset((ivs[i][2], ivs[i + 1][2])) in swap_pair_set:
                continue  # swap：进腔 hop 与出腔 hop 合成一趟，VTR 占用重叠合法
            if ivs[i][1] > ivs[i + 1][0] + eps:
                issues.append(f"R 重叠 手{rob}: w{ivs[i][2]}[..{ivs[i][1]:.1f}] 与 w{ivs[i+1][2]}[{ivs[i+1][0]:.1f}..]")

    # (LL) loadlock 抽充气状态机：按腔重建时序占用，校验连续用例间是否预留了空抽/空充(preprepare)
    # 间隙——补 MILP/movelist 未独立复核的 LL 状态。初始态按首用所需（preprepare：开机把 LL 预置到
    # 首用压力态，与 MILP 只建「连续同型」setup、不建初始 setup 的口径一致），故首段不计 setup。
    ll_occ: Dict[str, List[Tuple[float, float, str]]] = {}
    for wid, rows in sched.items():
        w = wafers[wid]
        for j, (stype, c, av, rv) in enumerate(rows):
            if stype != "loadlock":
                continue
            s = w.stages[j]
            st = av - (tm.place_t(s.in_robot, c) + tm.place_pre(s.in_robot, c) if s.in_robot else 0.0)
            en = rv + (tm.pick_t(s.out_robot, c) + tm.pick_post(s.out_robot, c) if s.out_robot else 0.0)
            ll_occ.setdefault(c, []).append((st, en, s.ll_type))
    for c, occs in ll_occ.items():
        occs.sort()
        ch = task.chambers.get(c)
        pump = float((ch.pump_time if ch else 0.0) or 0.0)
        vent = float((ch.vent_time if ch else 0.0) or 0.0)
        state, prev_en = None, None        # 初始态按首用所需（preprepare 免费），首段不计 setup
        for st, en, lt in occs:
            need = "ATM" if lt == "entry" else "VAC"   # entry 收大气片须 ATM；exit 收真空片须 VAC
            if state is not None and state != need:    # 须空 setup 翻态：ATM→VAC 空抽 / VAC→ATM 空充
                setup = pump if need == "VAC" else vent
                if (st - prev_en) + eps < setup:
                    issues.append(f"LL preprepare 间隙不足 腔{c}: {st:.1f} 前需空"
                                  f"{'抽' if need == 'VAC' else '充'} {setup:.1f}，仅 {st - prev_en:.1f}")
            state = "VAC" if lt == "entry" else "ATM"  # entry 抽到真空、exit 充到大气
            prev_en = en

    return issues