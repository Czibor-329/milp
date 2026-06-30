"""Case 级 MILP oracle（Gurobi）：吃 Problem IR，求 makespan 最优排程。

见 milp_design.md。iter-1 实现：路径先后(P) / 驻留(D) / 腔互斥(C) / 机器手互斥(R) /
LoadLock 状态 setup(LL) / 同 route id FIFO，round-robin 定腔，双臂换料(swap，决策 B)。
swap 由 solve_milp(enable_swap=) 控制：默认开；生成 timing 训练集时置 False（timing 解码层无
swap 原语，关掉可保 MILP 解落在 timing 可表示空间内、teacher 序可被复现）。

用法见 scripts/run_milp.py。求解结果 SolveResult.makespan / schedule（每片每 stage 的
进站 a、取走 r）便于核对与后续 movelist 导出。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import gurobipy as gp
from gurobipy import GRB

from src.model import Chamber, Durations, Problem, Stage, Wafer


# --------------------------------------------------------------------------- #
# 工作数据类（Stage / Wafer / Durations）已迁到 src.model；晶圆展开见 src.parse。
# 本模块只消费 Problem（task.wafers / task.pre_clean / task.post_clean）。
# --------------------------------------------------------------------------- #
def _ll_proc(task: Problem, chamber: str, ll_type: str) -> float:
    """loadlock 在某具体腔的停留时长：entry→pump，exit→vent（放开分配后按选中腔取）。"""
    ch = task.chambers.get(chamber)
    if ch is None or ll_type not in ("entry", "exit"):
        return 0.0
    return float((ch.pump_time if ll_type == "entry" else ch.vent_time) or 0.0)


@dataclass
class _SwapPair:
    """相邻同腔占用 (w_out 出腔, w_in 进腔) 的双臂换料候选（决策 B / milp_design §4-S）。"""
    chamber: str
    j_out: int              # w_out 在该腔的 stage（出腔 hop = j_out）
    j_in: int               # w_in 在该腔的 stage（进腔 hop = j_in-1）
    robot: str              # 执行 swap 的手（出腔 pick 与进腔 place 同一手）
    w_out: Wafer = None    # type: ignore
    w_in: Wafer = None     # type: ignore


def _swap_candidates(task: Problem, wafers: List[Wafer]) -> List[_SwapPair]:
    """单容量腔上相邻两片，若「出腔 pick 手 == 进腔 place 手」且该手双臂 → 一个 swap 候选。

    VTR 一趟在腔 c 把 w_out 取出、w_in 放入（swap=pick(c)+place(c)），省掉两次往返。
    只取单容量加工腔（grid 瓶颈 = PM；多容量腔的门簇/槽位另算，暂不建 swap）。"""
    # 只在「加工腔」上建 swap（每片在加工腔仅一次访问 → 占用序即不同片的发片序）。
    # LL/LP 的多物理槽单臂 combine 是另一套模型（共享压力态 + physical_cap，暂不建）。
    occ: Dict[Tuple[str, int], List[Tuple[int, Wafer, int]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            ch = task.chambers.get(s.chamber)
            if ch is None or s.stage_type != "process" or int(ch.capacity) != 1:
                continue
            occ.setdefault((s.chamber, s.slot), []).append((w.wid, w, j))
    pairs: List[_SwapPair] = []
    for (c, _slot), lst in occ.items():
        lst.sort()
        for (_, w_out, j_out), (_, w_in, j_in) in zip(lst, lst[1:]):
            if w_out.wid == w_in.wid or j_in == 0 or j_out + 1 >= len(w_out.stages):
                continue  # 须两片、进腔有前一跳、出腔有后一跳
            R = w_out.stages[j_out].out_robot
            if not R or R != w_in.stages[j_in].in_robot:
                continue  # 取出/放入须同一手才能合成一趟
            rb = task.robots.get(R)
            if rb is None or not rb.can_swap:
                continue
            pairs.append(_SwapPair(c, j_out, j_in, R, w_out, w_in))
    return pairs


# --------------------------------------------------------------------------- #
# 清洁展开（决策4）：pre/post/wac 折成固定占腔事件（无片、无搬运），不进 0/1。
#   dummy 清洁已由 synthesize_dummy_routes 合成为 dummy 晶圆，随 task.pjobs 正常流转。
# --------------------------------------------------------------------------- #
@dataclass
class _Clean:
    chamber: str
    slot: int
    dur: float
    recipe: str
    task: str
    kind: str                          # 'pre' / 'post' / 'wac'
    before: Optional[Tuple[int, int]] = None   # 须早于此 (wid, j) 的占腔
    after: Optional[Tuple[int, int]] = None    # 须晚于此 (wid, j) 的占腔


def _clean_specs(task: Problem, wafers: List[Wafer]) -> List[_Clean]:
    """从 IR 的 route.clean 与 wac stage 字段，按 round-robin 的腔分配展开清洁事件。"""
    wmap = {w.wid: w for w in wafers}
    # 每个 process 腔按 wid 升序的占用 (wid, j)
    by_ch: Dict[str, List[Tuple[int, int]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type == "process" and s.chamber:
                by_ch.setdefault(s.chamber, []).append((w.wid, j))
    for occ in by_ch.values():
        occ.sort()

    # 顶层 pre/post 清洁按 PM 聚合（来源 Problem.pre_clean / post_clean，按 route 序拼接）
    pre_by_ch: Dict[str, Tuple[float, str, str]] = {}
    post_by_ch: Dict[str, Tuple[float, str, str]] = {}
    for spec in task.pre_clean:
        for c in spec.visits:
            pre_by_ch.setdefault(c, (float(spec.time), spec.recipe, spec.task))
    for spec in task.post_clean:
        for c in spec.visits:
            post_by_ch.setdefault(c, (float(spec.time), spec.recipe, spec.task))

    cleans: List[_Clean] = []
    for c, occ in by_ch.items():
        if not occ:
            continue
        slot = wmap[occ[0][0]].stages[occ[0][1]].slot
        if c in pre_by_ch:
            t, rec, task = pre_by_ch[c]
            if t > 0:
                cleans.append(_Clean(c, slot, t, rec, task, "pre", before=occ[0]))
        if c in post_by_ch:
            t, rec, task = post_by_ch[c]
            if t > 0:
                cleans.append(_Clean(c, slot, t, rec, task, "post", after=occ[-1]))
        # wac：每 trigger 片后插一次无片清洗（按 wid 序 = 发片序）
        st0 = wmap[occ[0][0]].stages[occ[0][1]]
        if st0.clean_trigger > 0 and st0.clean_time > 0:
            for k in range(st0.clean_trigger - 1, len(occ) - 1, st0.clean_trigger):
                cleans.append(_Clean(c, slot, st0.clean_time, st0.clean_recipe, "",
                                     "wac", after=occ[k], before=occ[k + 1]))
    return cleans


# --------------------------------------------------------------------------- #
# 求解结果
# --------------------------------------------------------------------------- #
@dataclass
class SolveResult:
    status: int
    makespan: float
    # wid -> [(stage_type, chamber, a 进站, r 取走)]
    schedule: Dict[int, List[Tuple[str, str, float, float]]] = field(default_factory=dict)
    releases: List[Tuple[float, str, int]] = field(default_factory=list)  # (发片时刻, route, wid)
    swaps: List[Tuple[str, int, int]] = field(default_factory=list)  # (腔, w_out, w_in) 解里取 1 的 swap
    gap: float = 0.0
    runtime: float = 0.0


# --------------------------------------------------------------------------- #
# 建模 + 求解
# --------------------------------------------------------------------------- #
def solve_milp(task: Problem, *, time_limit: float = 300.0,
               verbose: bool = False, ub: Optional[float] = None,
               enable_swap: bool = True, warm: Optional[SolveResult] = None) -> SolveResult:
    """ub: 一条可行排程的 makespan 上界（如 run_greedy 的 finished makespan）。给定则用
    tight Big-M=2·ub+1 收紧 LP 松弛（方案 §6.2）；None 时退回 loose-M（所有动作时长之和）。

    enable_swap: 是否建模双臂换料（决策 B）。False ⇒ 不建 swap 候选，所有 hop 原子搬运、
    res.swaps 恒空（供 timing 训练集生成：timing 解码层无 swap 原语）。"""
    tm = Durations(task)
    wafers = task.wafers
    cap = {n: int(c.capacity) for n, c in task.chambers.items()}

    # Big-M（既作变量上界又作大-M 系数）。
    # loose：所有片所有动作时长之和——够大但极松，LP 松弛差、分支树爆。
    big = 0.0
    for w in wafers:
        for s in w.stages:
            big += s.proc
            if s.in_robot:
                big += tm.place(s.in_robot, s.chamber) + tm.move(s.in_robot)
            if s.out_robot:
                big += tm.pick(s.out_robot, s.chamber)
    # tight：给定可行 makespan 上界 ub 时 M=2·ub+1（方案 §6.2）。正确性：所有时刻变量
    # ∈[0, 最优 makespan]≤ub；任一大-M 松弛项最坏间隙 ≤ horizon+max(L,setup) ≤ ub+ub=2·ub
    # （makespan ≥ 任一单动作/换气 setup），故 2·ub+1 既收紧又不割最优解。tight 偏小只会令
    # 大-M 误绑 → 不可行/偏大，绝不伪最优；下方 optimize 后对不可行做 loose 回退。
    used_tight = ub is not None and math.isfinite(ub) and ub > 0
    M = (2.0 * float(ub) + 1.0) if used_tight else (big + 1.0)

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
        return (tm.pick_t(rob, w.stages[j].chamber) + tm.move(rob)
                + tm.place_t(rob, w.stages[j + 1].chamber))

    # swap 候选（决策 B）：每对 → 一个 0/1；其涉及的两个 hop 的链式 a=r+L 改为条件约束。
    swap_pairs = _swap_candidates(task, wafers) if enable_swap else []
    sw: Dict[int, gp.Var] = {k: m.addVar(vtype=GRB.BINARY, name=f"sw_{p.chamber}_{p.w_out.wid}_{p.w_in.wid}")
                             for k, p in enumerate(swap_pairs)}
    # hop (wid, j) → 由哪个 swap 决定：进腔 hop = j_in-1（受 sw 控 a 链），出腔 hop = j_out（受 sw 控 r 与 a 链）
    gov_in = {(p.w_in.wid, p.j_in - 1): k for k, p in enumerate(swap_pairs)}
    gov_out = {(p.w_out.wid, p.j_out): k for k, p in enumerate(swap_pairs)}

    # a[w,j] 全部建成变量；非 swap 治理的 hop 直接 a[j+1]==r[j]+L（与原子搬运等价）。
    a: Dict[Tuple[int, int], gp.Var] = {}
    for w in wafers:
        for j in range(len(w.stages)):
            a[w.wid, j] = m.addVar(lb=0.0, ub=M, name=f"a_{w.wid}_{j}")
        m.addConstr(a[w.wid, 0] == 0.0, name=f"a0_{w.wid}")
    for w in wafers:
        for j in range(len(w.stages) - 1):
            if (w.wid, j) in gov_in or (w.wid, j) in gov_out:
                continue  # 条件链由 swap 约束块给出
            m.addConstr(a[w.wid, j + 1] == r[w.wid, j] + L(w, j), name=f"chain_{w.wid}_{j}")

    # (Z) 腔分配决策（放开 round-robin）：loadlock + 加工腔(process) 均建选腔变量。
    #   z[w,j,c]∈{0,1}, Σ_c z=1。候选腔 pick/place 行程时长相等（marathon_gen 克隆 PM 同 PickTime/
    #   PlaceTime、move 按手取与腔无关）→ L、a=r+L 链、(R) 机器手互斥全不依赖选腔；仅 proc(pump/vent)、
    #   门微动作、(C) 互斥分组依赖 → 下方条件化。process 的 proc 各候选腔同值（路由模板每 stage 一个
    #   process_time），故 proc 也不依赖选腔；只需把 (C) 的静态分组改为 (C-PM) 条件互斥。
    sel_z: Dict[Tuple[int, int], Dict[str, gp.Var]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type in ("loadlock", "process") and len(s.cands) > 1:
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

    # (S) swap 约束块（milp_design §4-S）。sw=1：VTR 一趟 pick(c,w_out)+place(c,w_in)；
    # sw=0：退回两趟原子搬运（链式 a=r+L），并由 (C)(R) 正常排序（下方按 swap_fifo/swap_rpair 放松）。
    swap_fifo: Dict[Tuple[int, int, str], gp.Var] = {}  # (lo.wid, hi.wid, 腔) → sw：仅放松被换腔的 FIFO 占用序
    swap_rpair: Dict[frozenset, gp.Var] = {}         # {(w_in,p),(w_out,j_out)} → sw：放松两手活互斥
    for k, p in enumerate(swap_pairs):
        v = sw[k]
        R, c = p.robot, p.chamber
        pin = p.j_in - 1                                       # w_in 进腔 hop
        c_prev = p.w_in.stages[pin].chamber                   # w_in 来源腔（如 LL）
        c_next = p.w_out.stages[p.j_out + 1].chamber          # w_out 去向腔（如 LL）
        swap_dur = tm.pick_t(R, c) + tm.place_t(R, c)         # 同口径于 model_builder.swap_time
        arrive = r[p.w_in.wid, pin] + tm.pick_t(R, c_prev) + tm.move(R)   # VTR 持 w_in 抵 c
        # w_in 进腔链：sw=0 → 原子 a=r+L；sw=1 → a = 抵腔 + swap（先取后放，末端落位）
        Lin = r[p.w_in.wid, pin] + L(p.w_in, pin)
        a_in = a[p.w_in.wid, p.j_in]
        m.addConstr(a_in >= Lin - M * v); m.addConstr(a_in <= Lin + M * v)
        m.addConstr(a_in >= arrive + swap_dur - M * (1 - v))
        m.addConstr(a_in <= arrive + swap_dur + M * (1 - v))
        # w_out 出腔链：sw=0 → 原子；sw=1 → pick 起于 swap 起点，置 c_next 在 swap 后 move+place
        Lout = r[p.w_out.wid, p.j_out] + L(p.w_out, p.j_out)
        a_out = a[p.w_out.wid, p.j_out + 1]
        m.addConstr(a_out >= Lout - M * v); m.addConstr(a_out <= Lout + M * v)
        m.addConstr(r[p.w_out.wid, p.j_out] >= arrive - M * (1 - v))
        m.addConstr(r[p.w_out.wid, p.j_out] <= arrive + M * (1 - v))
        a_out_sw = arrive + swap_dur + tm.move(R) + tm.place_t(R, c_next)
        m.addConstr(a_out >= a_out_sw - M * (1 - v))
        m.addConstr(a_out <= a_out_sw + M * (1 - v))
        lo, hi = (p.w_out, p.w_in) if p.w_out.wid < p.w_in.wid else (p.w_in, p.w_out)
        # 只放松「被换腔 c」上的 FIFO 占用序：同一对晶圆在其它同序单腔(如 PM1/PM2)上仍须互斥，
        # 否则换料松弛会泄漏到没有发生换料的腔，产生假重叠（bug1）。
        swap_fifo[lo.wid, hi.wid, c] = v
        swap_rpair[frozenset({(p.w_in.wid, pin), (p.w_out.wid, p.j_out)})] = v

    # (P) 站内停留：place 后关门 → 加工/抽充气 → pick 前开门 → 才能 pick
    #     r[w,j] ≥ a[w,j] + place_post(进站,c) + proc + pick_pre(出站,c)
    #     门动作（关/开）与机器手行程并行，但与本片加工串行（提前开门不能早于加工完成）
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
    skip_types = {"loadport", "buffer", "dummyport"}
    slot_occ: Dict[Tuple[str, int], List[Tuple[Wafer, int]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            ch = task.chambers.get(s.chamber)
            if ch is None or str(ch.type).lower() in skip_types:
                continue
            if s.stage_type in ("source", "sink", "loadlock"):
                continue
            if s.stage_type == "process" and len(s.cands) > 1:
                continue  # 放开选腔的 process → 不能按静态腔分组，移到下方 (C-PM) 条件化
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
                    # swap=1 时 w_in 随 w_out 离开同窗进腔 → 仅放松「被换腔 c」上该对的占用序。
                    relax = M * swap_fifo[lo.wid, hi.wid, c] if (lo.wid, hi.wid, c) in swap_fifo else 0.0
                    m.addConstr(occ_start(hi, jhi) >= occ_end(lo, jlo) + ll_setup(slo, shi) - relax,
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

    ll_visits = [(w, j) for w in wafers
                 for j, s in enumerate(w.stages) if s.stage_type == "loadlock"]
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

    # (C-PM) process 腔互斥（腔分配为决策 → 按候选腔条件化，与 (C-LL) 同构但无抽充气 setup）。
    #   一对占用仅当「都选中腔 c」时互斥：relax=M*(2−e1c−e2c)（任一未选 c 即放松）。同 route 同 stage
    #   用条件 FIFO（id 升序，省 0/1）；跨 route 不同 visit 用 0/1 析取（一个 x 管所有同选候选腔）。
    pm_visits = [(w, j) for w in wafers
                 for j, s in enumerate(w.stages)
                 if s.stage_type == "process" and len(s.cands) > 1]
    for p in range(len(pm_visits)):
        for q in range(p + 1, len(pm_visits)):
            w1, j1 = pm_visits[p]; w2, j2 = pm_visits[q]
            if w1.wid == w2.wid:
                continue  # 同片重访：precedence 已序
            s1, s2 = w1.stages[j1], w2.stages[j2]
            shared = [c for c in s1.cands if c in s2.cands]
            if not shared:
                continue
            if w1.route_name == w2.route_name and j1 == j2:
                lo, jlo, hi, jhi = ((w1, j1, w2, j2) if w1.wid < w2.wid
                                    else (w2, j2, w1, j1))
                for c in shared:    # 条件 FIFO：lo 先（仅当两者都选 c 时生效）
                    relax = M * (2 - ecoef(lo, jlo, c) - ecoef(hi, jhi, c))
                    m.addConstr(occ_start(hi, jhi) >= occ_end(lo, jlo) - relax,
                                name=f"CPM_{c}_{lo.wid}_{hi.wid}")
            else:
                x = m.addVar(vtype=GRB.BINARY,
                             name=f"xpm_{w1.wid}_{j1}_{w2.wid}_{j2}")
                for c in shared:
                    relax = M * (2 - ecoef(w1, j1, c) - ecoef(w2, j2, c))
                    m.addConstr(occ_start(w2, j2) >= occ_end(w1, j1) - M * (1 - x) - relax)
                    m.addConstr(occ_start(w1, j1) >= occ_end(w2, j2) - M * x - relax)

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
                # 这两手活恰为某 swap 的「进腔 hop + 出腔 hop」时，sw=1 合成一趟 → 放松互斥；
                # sw=0 仍走标准析取（其余手活照常避开两段并集，无需改动）。
                sv = swap_rpair.get(frozenset({(w1.wid, j1), (w2.wid, j2)}))
                relax = M * sv if sv is not None else 0.0
                y = m.addVar(vtype=GRB.BINARY, name=f"y_{rob}_{w1.wid}_{j1}_{w2.wid}_{j2}")
                m.addConstr(r[w2.wid, j2] >= a[w1.wid, j1 + 1] + gap(w1, j1, w2, j2) - M * (1 - y) - relax)
                m.addConstr(r[w1.wid, j1] >= a[w2.wid, j2 + 1] + gap(w2, j2, w1, j1) - M * y - relax)

    # FIFO 发片（更正①）：同 route id 升序
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

    # 清洁占腔（决策4，无 0/1）：pre 早于首片、post 晚于末片(撑 Cmax)、wac 夹在两片间
    wmap = {w.wid: w for w in wafers}
    for cl in _clean_specs(task, wafers):
        if cl.kind == "pre":
            wb, jb = cl.before
            m.addConstr(occ_start(wmap[wb], jb) >= cl.dur, name=f"preclean_{cl.chamber}")
        elif cl.kind == "post":
            wa, ja = cl.after
            m.addConstr(Cmax >= occ_end(wmap[wa], ja) + cl.dur, name=f"postclean_{cl.chamber}")
        elif cl.kind == "wac":
            wb, jb = cl.before; wa, ja = cl.after
            m.addConstr(occ_start(wmap[wb], jb) >= occ_end(wmap[wa], ja) + cl.dur,
                        name=f"wac_{cl.chamber}_{wa}")

    # 暖启动（MIPStart）：给定一条可行排程（如 timing 解）→ 设 a/r/选腔/swap 起始值，Gurobi 自带一个
    # ≤该排程 makespan 的初始 incumbent。两重保证：(1) 一定有可行解（放开 PM 选腔后难例也不 nan/丢标）；
    # (2) 最终 incumbent ≤ warm makespan（喂 timing ⇒ gap 不为负）。并从好点出发加速收敛。
    if warm is not None and warm.schedule:
        for w in wafers:
            rows = warm.schedule.get(w.wid)
            if not rows or len(rows) != len(w.stages):
                continue
            for j, (_st, cham, av, rv) in enumerate(rows):
                if (w.wid, j) in a:
                    a[w.wid, j].Start = float(av)
                if (w.wid, j) in r:
                    r[w.wid, j].Start = float(rv)
                zc = sel_z.get((w.wid, j))
                if zc is not None:
                    for c, v in zc.items():
                        v.Start = 1.0 if c == cham else 0.0
        for v in sw.values():
            v.Start = 0.0

    m.setObjective(Cmax, GRB.MINIMIZE)

    m.optimize()

    # tight-M 兜底：若 tight 上界过小割掉了可行域（不可行/无界），退回 loose-M 重解一次。
    if (used_tight and m.SolCount == 0
            and m.Status in (GRB.INFEASIBLE, GRB.INF_OR_UNBD, GRB.UNBOUNDED)):
        return solve_milp(task, time_limit=max(1.0, float(time_limit) - float(m.Runtime)),
                          verbose=verbose, ub=None, warm=warm)

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
        res.swaps = [(p.chamber, p.w_out.wid, p.w_in.wid)
                     for k, p in enumerate(swap_pairs) if sw[k].X > 0.5]
    return res


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
