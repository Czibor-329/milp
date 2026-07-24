"""精确 MILP 调度，并用已证明安全的资源顺序执行双臂 PM 换片重定时。"""

import copy
from typing import Dict, List, Optional, Tuple

import gurobipy as gp
from gurobipy import GRB

from src.parse.clean_constraints import _clean_specs, _dummy_order_pairs
from src.parse.model import Durations, Problem, Stage, Wafer
from src.timing.solve import SolveResult
from src.timing.spans import _ll_proc


def _retime_milp_order_with_process_swaps(
    task: Problem,
    result: SolveResult,
) -> SolveResult:
    """从 MILP 解恢复资源顺序，并尝试双臂 PM 换片的最早时刻重排。

    MILP 仍负责选腔与全局析取顺序；重排只对同一顺序内相邻的 PM 出入片做原子换片，
    因而不会把启发式选择偷偷带入精确求解结果。若换片图不可行或没有改善，保留原解。
    选中重排结果时会把 MILP 的实际 LoadLock 腔分配同步回 ``task.wafers``，供导出一致使用。
    """
    if not result.schedule:
        return result

    from src.schedule.sequencing import _Orders, _resource
    from src.timing.solve import solve_timing

    candidate_task = copy.copy(task)
    candidate_task.wafers = copy.deepcopy(task.wafers)
    tm = Durations(candidate_task)

    for wafer in candidate_task.wafers:
        for stage_index, row in enumerate(result.schedule[wafer.wid]):
            actual_chamber = row[1]
            stage = wafer.stages[stage_index]
            stage.chamber = actual_chamber
            if stage.stage_type == "loadlock":
                stage.proc = _ll_proc(candidate_task, actual_chamber, stage.ll_type)

    chamber_rows: Dict[
        Tuple[str, int],
        List[Tuple[float, Tuple[int, int]]],
    ] = {}
    robot_rows: Dict[str, List[Tuple[float, Tuple[int, int]]]] = {}
    loadlock_rows: Dict[str, List[Tuple[float, Tuple[int, int]]]] = {}
    for wafer in candidate_task.wafers:
        rows = result.schedule[wafer.wid]
        for stage_index, (_stage_type, chamber, arrival, release) in enumerate(rows):
            stage = wafer.stages[stage_index]
            resource = _resource(candidate_task, wafer, stage_index)
            occupancy_start = arrival - (
                tm.place_t(stage.in_robot, chamber)
                + tm.place_pre(stage.in_robot, chamber)
                if stage.in_robot
                else 0.0
            )
            if resource is not None:
                chamber_rows.setdefault(resource, []).append(
                    (occupancy_start, (wafer.wid, stage_index))
                )
            if stage.stage_type == "loadlock":
                loadlock_rows.setdefault(chamber, []).append(
                    (occupancy_start, (wafer.wid, stage_index))
                )
            if stage_index < len(rows) - 1:
                robot_rows.setdefault(wafer.transports[stage_index], []).append(
                    (release, (wafer.wid, stage_index))
                )

    orders = _Orders(
        chambers={
            resource: [visit for _start, visit in sorted(sequence)]
            for resource, sequence in chamber_rows.items()
        },
        robots={
            robot: [hop for _start, hop in sorted(sequence)]
            for robot, sequence in robot_rows.items()
        },
        ll_seq={
            chamber: [visit for _start, visit in sorted(sequence)]
            for chamber, sequence in loadlock_rows.items()
        },
    )
    retimed = solve_timing(candidate_task, candidate_task.wafers, orders)
    if (
        not retimed.schedule
        or not getattr(retimed, "process_swaps", ())
        or retimed.makespan > result.makespan + 1e-4
    ):
        return result

    retimed.status = result.status
    retimed.gap = result.gap
    retimed.runtime = result.runtime
    retimed.milp_base_makespan = result.makespan  # type: ignore[attr-defined]
    task.wafers = candidate_task.wafers
    return retimed

# --------------------------------------------------------------------------- #
# 工作数据类位于 src.parse.model；晶圆展开见 src.parse。
# 本模块只消费 Problem（task.wafers / task.pre_clean / task.post_clean）。
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# 建模 + 求解
# --------------------------------------------------------------------------- #
def solve_milp(task: Problem, *, time_limit: float = 10.0, verbose: bool = False) -> SolveResult:
    """求解原 MILP 模型，并在其可行资源顺序上尝试双臂 PM 换片重定时。"""

    tm = Durations(task)
    wafers = task.wafers
    M = 5600 # Big-M（既作变量上界又作大-M 系数）。

    m = gp.Model("ct_case_milp")
    if not verbose:
        m.Params.OutputFlag = 0
    m.Params.TimeLimit = float(time_limit)

    # 决策变量 r[w,j]（j=0..K-1，pick 起始）；a[w,j] 为线性表达式
    r: Dict[Tuple[int, int], gp.Var] = {}
    for w in wafers:
        for j in range(len(w.stages) - 1):
            r[w.wid, j] = m.addVar(lb=0.0, ub=M, name=f"r_{w.wid}_{j}")

    def L(w: Wafer, j: int) -> float:
        """stage j→j+1 机器手占用时长 = pick + move + place（门动作不占机器手，见 §6-1）。"""
        rob = w.transports[j]
        return tm.pick_t(rob, w.stages[j].chamber) + tm.move(rob) + tm.place_t(rob, w.stages[j + 1].chamber)

    # a[w,j] 全部建成变量；每个 hop 直接 a[j+1]==r[j]+L（原子搬运）。
    a: Dict[Tuple[int, int], gp.Var] = {}
    for w in wafers:
        for j in range(len(w.stages)):
            a[w.wid, j] = m.addVar(lb=0.0, ub=M, name=f"a_{w.wid}_{j}")
        m.addConstr(a[w.wid, 0] == 0.0, name=f"a0_{w.wid}")
    for w in wafers:
        for j in range(len(w.stages) - 1):
            m.addConstr(a[w.wid, j + 1] == r[w.wid, j] + L(w, j), name=f"chain_{w.wid}_{j}")

    # loadlock 腔分配决策（放开 round-robin）：只 loadlock 建选腔变量；
    #   z[w,j,c]∈{0,1}, Σ_c z=1。
    sel_z: Dict[Tuple[int, int], Dict[str, gp.Var]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type == "loadlock" and len(s.cands) > 1:
                zc = {c: m.addVar(vtype=GRB.BINARY, name=f"z_{w.wid}_{j}_{c}") for c in s.cands}
                m.addConstr(gp.quicksum(zc.values()) == 1, name=f"zsum_{w.wid}_{j}")
                sel_z[w.wid, j] = zc

    def cdep(w: Wafer, j: int, fn):
        """选腔相关标量 → float（写死腔）或 LinExpr（放开选腔的腔，按 z 加权）。"""
        zc = sel_z.get((w.wid, j))
        if zc is None:
            return fn(w.stages[j].chamber)
        return gp.quicksum(v * fn(c) for c, v in zc.items())

    def proc_val(w: Wafer, j: int):
        """停留时长：loadlock 按选中腔的 pump/vent；其余用静态 proc。"""
        s = w.stages[j]
        if s.stage_type == "loadlock":
            return cdep(w, j, lambda c: _ll_proc(task, c, s.ll_type))
        return s.proc

    # (P) 站内停留：place 后关门 → 加工/抽充气 → pick 前开门 → 才能 pick
    #     r[w,j] ≥ a[w,j] + place_post(进站,c) + proc + pick_pre(出站,c)
    def proc_done(w: Wafer, j: int) -> gp.LinExpr:
        s = w.stages[j]
        pp = cdep(w, j, lambda c: tm.place_post(s.in_robot, c)) if s.in_robot else 0.0
        return a[w.wid, j] + pp + proc_val(w, j)
    for w in wafers:
        for j in range(len(w.stages) - 1):
            s = w.stages[j]
            pre = cdep(w, j, lambda c: tm.pick_pre(s.out_robot, c)) if s.out_robot else 0.0
            m.addConstr(r[w.wid, j] >= proc_done(w, j) + pre, name=f"P_{w.wid}_{j}")
            if s.stage_type == "process" and s.residency > 0:
                m.addConstr(r[w.wid, j] <= proc_done(w, j) + pre + s.residency,
                            name=f"D_{w.wid}_{j}")

    # 占用区间（cap=1 腔互斥用）：含门动作（站点整段串行）。
    #   start = 进站 place 开门起点 = a − place − place_pre
    #   end   = 出站 pick  关门终点 = r + pick + pick_post
    def occ_start(w: Wafer, j: int) -> gp.LinExpr:
        s = w.stages[j]
        if not s.in_robot:
            return a[w.wid, j]
        return a[w.wid, j] - cdep(w, j, lambda c: tm.place_t(s.in_robot, c)
                                   + tm.place_pre(s.in_robot, c))

    def occ_end(w: Wafer, j: int) -> gp.LinExpr:
        s = w.stages[j]
        if not s.out_robot:
            return r[w.wid, j]
        return r[w.wid, j] + cdep(w, j, lambda c: tm.pick_t(s.out_robot, c)
                                  + tm.pick_post(s.out_robot, c))

    def ll_setup(prev: Stage, nxt: Stage) -> float:
        """同一 LL 连续两次使用的状态相关 setup（空抽/空充）。"""
        if not prev.ll_type or not nxt.ll_type:
            return 0.0
        ch = task.chambers.get(nxt.chamber)
        if prev.ll_type == "entry" and nxt.ll_type == "entry":   # 真空→需大气：空充
            return float((ch.vent_time if ch else 0.0) or 0.0)
        if prev.ll_type == "exit" and nxt.ll_type == "exit":     # 大气→需真空：空抽
            return float((ch.pump_time if ch else 0.0) or 0.0)
        return 0.0

    # (C) 腔互斥（按 (腔,槽位) 分组 → 每槽 cap-1；多容量腔 round-robin 槽位天然并行）
    # 跳过 loadport/buffer/dummyport（容量≥片数，非瓶颈）与 source/sink
    # loadlock 腔分配为决策 → 不能按静态腔分组，移到下方 (C-LL) 按候选腔条件化。
    # process 按 round-robin 固定腔（静态 s.chamber）→ 直接进静态分组，不条件化。
    skip_types = {"loadport", "buffer", "dummyport"}
    slot_occ: Dict[Tuple[str, int], List[Tuple[Wafer, int]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            ch = task.chambers.get(s.chamber)
            if ch is None or str(ch.type).lower() in skip_types:
                continue
            if s.stage_type in ("source", "sink", "loadlock"):
                continue
            slot_occ.setdefault((s.chamber, s.slot), []).append((w, j))

    for (c, _slot), occs in slot_occ.items():
        for p in range(len(occs)):
            for q in range(p + 1, len(occs)):
                w1, j1 = occs[p]; w2, j2 = occs[q]
                if w1.wid == w2.wid:
                    continue  # 同片重访：precedence 已序
                s1, s2 = w1.stages[j1], w2.stages[j2]
                # FIFO 一边倒只在「同 route 同一 stage-visit」成立（更正①：id 升序加工）。
                # 同腔不同 visit（如 LL 的 entry vs exit）无固有先后 → 必须用 0/1，否则会
                # 把 w_hi 的 entry 强行排到 w_lo 的 exit 之后，逼 LL 按整趟串行（2x 瓶颈）。
                if w1.route_name == w2.route_name and j1 == j2:
                    lo, jlo, slo, hi, jhi, shi = (
                        (w1, j1, s1, w2, j2, s2) if w1.wid < w2.wid else (w2, j2, s2, w1, j1, s1))
                    m.addConstr(occ_start(hi, jhi) >= occ_end(lo, jlo) + ll_setup(slo, shi),
                                name=f"C_{c}_{lo.wid}_{hi.wid}")
                else:
                    # 跨 route 或 同 route 不同 visit：0/1 析取
                    x = m.addVar(vtype=GRB.BINARY, name=f"x_{c}_{w1.wid}_{j1}_{w2.wid}_{j2}")
                    m.addConstr(occ_start(w2, j2) >= occ_end(w1, j1) + ll_setup(s1, s2) - M * (1 - x))
                    m.addConstr(occ_start(w1, j1) >= occ_end(w2, j2) + ll_setup(s2, s1) - M * x)

    # (C-LL) loadlock 互斥（腔分配为决策 → 按候选腔条件化）。一对占用仅当「都选中腔 c」时互斥：
    #   都选中 c ⟺ e1c+e2c==2，relax=M*(2-e1c-e2c)（任一未选 c 即放松）。同 route 同 visit
    #   用条件 FIFO（省 0/1），entry/exit 等不同 visit 用 0/1 析取。空抽/空充 setup 按选中腔取。
    def ecoef(w: Wafer, j: int, c: str):
        zc = sel_z.get((w.wid, j))
        if zc is None:
            return 1.0 if w.stages[j].chamber == c else 0.0
        return zc.get(c, 0.0)

    def ll_setup_c(prev_lt: str, nxt_lt: str, c: str) -> float:
        ch = task.chambers.get(c)
        if prev_lt == "entry" and nxt_lt == "entry":     # 真空→需大气：空充
            return float((ch.vent_time if ch else 0.0) or 0.0)
        if prev_lt == "exit" and nxt_lt == "exit":       # 大气→需真空：空抽
            return float((ch.pump_time if ch else 0.0) or 0.0)
        return 0.0

    ll_visits = [(w, j) for w in wafers for j, s in enumerate(w.stages) if s.stage_type == "loadlock"]
    for p in range(len(ll_visits)):
        for q in range(p + 1, len(ll_visits)):
            w1, j1 = ll_visits[p]; w2, j2 = ll_visits[q]
            if w1.wid == w2.wid:
                continue  # 同片重访：precedence 已序
            s1, s2 = w1.stages[j1], w2.stages[j2]
            shared = [c for c in s1.cands if c in s2.cands]
            if not shared:
                continue
            if w1.route_name == w2.route_name and j1 == j2:
                lo, jlo, hi, jhi = ((w1, j1, w2, j2) if w1.wid < w2.wid
                                    else (w2, j2, w1, j1))
                slo, shi = lo.stages[jlo], hi.stages[jhi]
                for c in shared:    # 条件 FIFO：lo 先（仅当两者都选 c 时生效）
                    relax = M * (2 - ecoef(lo, jlo, c) - ecoef(hi, jhi, c))
                    m.addConstr(occ_start(hi, jhi) >= occ_end(lo, jlo)
                                + ll_setup_c(slo.ll_type, shi.ll_type, c) - relax,
                                name=f"CLL_{c}_{lo.wid}_{hi.wid}")
            else:
                # 不同 visit：0/1 析取定先后。一对至多同选一腔 → 一个 x 管所有候选腔
                # （未同选 c 时该 c 的 relax≥M 自行放松，不与 x 冲突），省去逐腔 0/1。
                x = m.addVar(vtype=GRB.BINARY,
                             name=f"xll_{w1.wid}_{j1}_{w2.wid}_{j2}")
                for c in shared:
                    relax = M * (2 - ecoef(w1, j1, c) - ecoef(w2, j2, c))
                    m.addConstr(occ_start(w2, j2) >= occ_end(w1, j1)
                                + ll_setup_c(s1.ll_type, s2.ll_type, c) - M * (1 - x) - relax)
                    m.addConstr(occ_start(w1, j1) >= occ_end(w2, j2)
                                + ll_setup_c(s2.ll_type, s1.ll_type, c) - M * x - relax)

    # (Cd) 多容量腔的「门」整站串行：加工可跨槽并行，但开关门(MoveType 6/7)共用一套门机构，
    # 必须站级互斥（validator 规则）。把每次访问的 进站门簇/出站门簇 两两不重叠。
    # 多容量「加工」腔(heater/cooler 等非 skip)的门整站串行：加工跨槽并行、开关门(6/7)共用门机构。
    # 多槽 skip 站(loadport/buffer/dummyport)由单臂访问，门序由 (R) 同站门间隙保证(下方)，不在此建簇。
    door_clusters: Dict[str, List[Tuple[gp.LinExpr, gp.LinExpr]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            ch = task.chambers.get(s.chamber)
            if ch is None or int(ch.capacity) <= 1 or str(ch.type).lower() in skip_types:
                continue
            if s.stage_type in ("source", "sink"):
                continue
            cl = door_clusters.setdefault(s.chamber, [])
            if s.in_robot:    # 进站门簇 [开门起, place 关门止]
                cl.append((occ_start(w, j), a[w.wid, j] + tm.place_post(s.in_robot, s.chamber)))
            if s.out_robot:   # 出站门簇 [pick 开门起, 关门止]
                cl.append((r[w.wid, j] - tm.pick_pre(s.out_robot, s.chamber), occ_end(w, j)))
    for c, cls in door_clusters.items():
        for p in range(len(cls)):
            for q in range(p + 1, len(cls)):
                z = m.addVar(vtype=GRB.BINARY, name=f"Cd_{c}_{p}_{q}")
                m.addConstr(cls[q][0] >= cls[p][1] - M * (1 - z))
                m.addConstr(cls[p][0] >= cls[q][1] - M * z)

    # (R) 机器手互斥 + 空手 move
    robot_ops: Dict[str, List[Tuple[Wafer, int]]] = {}
    for w in wafers:
        for j in range(len(w.stages) - 1):
            robot_ops.setdefault(w.transports[j], []).append((w, j))

    for rob, ops in robot_ops.items():
        # TODO 运输时间不是固定的
        mv = tm.move(rob)

        def gap(wa: Wafer, ja: int, wb: Wafer, jb: int) -> float:
            """wa 的 hop 紧接 wb 的 hop 时机器手所需间隙。wa 放进的腔 == wb 取出的腔 且为
            多槽 skip 站(loadport/buffer/dummyport，单门)时 → 须先关门再开门(place_post+pick_pre)
            而非转位 move（同站不转位、但门共用须串行）。否则 = move（转位）。"""
            dst, src = wa.stages[ja + 1].chamber, wb.stages[jb].chamber
            ch = task.chambers.get(dst)
            if dst == src and ch and int(ch.capacity) > 1 and str(ch.type).lower() in skip_types:
                return tm.place_post(rob, dst) + tm.pick_pre(rob, src)
            return mv

        for p in range(len(ops)):
            for q in range(p + 1, len(ops)):
                w1, j1 = ops[p]; w2, j2 = ops[q]
                if w1.wid == w2.wid:
                    continue  # 同片：precedence 已序
                y = m.addVar(vtype=GRB.BINARY, name=f"y_{rob}_{w1.wid}_{j1}_{w2.wid}_{j2}")
                m.addConstr(r[w2.wid, j2] >= a[w1.wid, j1 + 1] + gap(w1, j1, w2, j2) - M * (1 - y))
                m.addConstr(r[w1.wid, j1] >= a[w2.wid, j2 + 1] + gap(w2, j2, w1, j1) - M * y)

    # FIFO 发片
    by_route: Dict[str, List[Wafer]] = {}
    for w in wafers:
        by_route.setdefault(w.route_name, []).append(w)
    for ws in by_route.values():
        ws.sort(key=lambda w: w.wid)
        for i in range(len(ws) - 1):
            m.addConstr(r[ws[i].wid, 0] <= r[ws[i + 1].wid, 0], name=f"FIFO_{ws[i].wid}")

    # 目标：makespan
    Cmax = m.addVar(lb=0.0, ub=M, name="Cmax")
    for w in wafers:
        m.addConstr(Cmax >= a[w.wid, len(w.stages) - 1], name=f"cmax_{w.wid}")

    # 清洁时间预留：pre/post/wac 折成占腔时间约束（腔固定、锚点固定 → 无 0/1，不改搜索结构）。
    #   pre  : 首片占腔起点 ≥ pre_dur（腔在前清洁完成前不可放片，清洁从 t=0 起）
    #   wac  : 后片占腔起点 ≥ 前片占腔终点 + wac_dur（两片间预留无片清洗；dummy-wac 同走此支）
    #   post : makespan ≥ 末片占腔终点 + post_dur（后清洁计入 makespan）
    #   dummy 清洁本身是合成 dummy 晶圆、随 wafers 正常排；占腔窗口用已定义的 occ_start/occ_end。
    wmap = {w.wid: w for w in wafers}
    for cl in _clean_specs(task, wafers):
        if cl.kind == "pre":
            wb, jb = cl.before
            m.addConstr(occ_start(wmap[wb], jb) >= cl.dur, name=f"CLNpre_{cl.chamber}_{wb}")
        elif cl.kind == "post":
            wa, ja = cl.after
            m.addConstr(Cmax >= occ_end(wmap[wa], ja) + cl.dur, name=f"CLNpost_{cl.chamber}_{wa}")
        else:  # wac / dummy-wac
            wa, ja = cl.after
            wb, jb = cl.before
            m.addConstr(occ_start(wmap[wb], jb) >= occ_end(wmap[wa], ja) + cl.dur,
                        name=f"CLNwac_{cl.chamber}_{wa}_{wb}")

    # dummy 清洁段定序：每腔 前一 job 占用 → dummy 段 → 本 job 占用（d(P1)→P1→d(P2)→P2）。
    # 纯定序（无额外时长）；dummy-wac 的时长间隙已由上方 CLNwac 约束承担。
    for (wa, ja), (wb, jb) in _dummy_order_pairs(task, wafers):
        m.addConstr(occ_start(wmap[wb], jb) >= occ_end(wmap[wa], ja),
                    name=f"CLNdord_{wa}_{ja}_{wb}_{jb}")

    m.setObjective(Cmax, GRB.MINIMIZE)
    m.optimize()

    res = SolveResult(status=m.Status, makespan=float("nan"))
    res.runtime = float(m.Runtime)
    if m.SolCount > 0:
        res.makespan = float(Cmax.X)
        res.gap = float(m.MIPGap) if m.Status != GRB.OPTIMAL else 0.0
        # loadlock 选中腔（放开分配）：取 z=1 的腔，回写进 schedule 供 export/check 用真实腔时长。
        chosen = {(wid, j): max(zc, key=lambda c: zc[c].X) for (wid, j), zc in sel_z.items()}
        for w in wafers:
            row = []
            for j, s in enumerate(w.stages):
                av = a[w.wid, j].X
                rv = r[w.wid, j].X if (w.wid, j) in r else av
                row.append((s.stage_type, chosen.get((w.wid, j), s.chamber), av, rv))
            res.schedule[w.wid] = row
        rel = [(r[w.wid, 0].X, w.route_name, w.wid) for w in wafers]
        res.releases = sorted(rel)
    return _retime_milp_order_with_process_swaps(task, res)
