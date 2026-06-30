from src.model import Chamber, Durations, Problem, Stage, Wafer
from src.milp import SolveResult, _ll_proc
from src.milp_clean import _clean_specs
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