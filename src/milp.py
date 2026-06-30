"""Case 级 MILP oracle（Gurobi）：吃 Problem IR，求 makespan 最优排程。

见 milp_design.md。iter-1 实现：路径先后(P) / 驻留(D) / 腔互斥(C) / 机器手互斥(R) /
LoadLock 状态 setup(LL) / 同 route id FIFO，round-robin 定腔，双臂换料(swap，决策 B)。
swap 由 solve_milp(enable_swap=) 控制：默认开；生成 timing 训练集时置 False（timing 解码层无
swap 原语，关掉可保 MILP 解落在 timing 可表示空间内、teacher 序可被复现）。

用法见 scripts/run_milp.py。求解结果 SolveResult.makespan / schedule（每片每 stage 的
进站 a、取走 r）便于核对与后续 movelist 导出。
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import gurobipy as gp
from gurobipy import GRB

from src.model import Durations, Problem, Stage, Wafer


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
# 固定 loadlock 计划（消爆点）：从一条可行排程（warm，通常是 timing 解）读出每个 loadlock 事件的
# 选腔 + 同腔定序，喂给 (Z) 钉腔 + (C-LL) 定序链，消去 z 析取与全部 xll 二元——短 proc loadlock
# 饱和时正是这堆两两析取同时收紧导致组合爆炸。交替 entry/exit 是 loadlock 吞吐下界最优（pump+vent
# 地板，与容量无关），故固定它无 makespan 损失，仅去掉搜索（参见 milp_design / 论文 MIP1→MIP2）。
# --------------------------------------------------------------------------- #
def _fixed_ll_plan(task: Problem, wafers: List[Wafer], warm: Optional[SolveResult]):
    """warm.schedule → (ll_assign, ll_order)。
       ll_assign: {(wid, j): chamber} 每个 loadlock 访问的选腔（取 warm 选中腔）。
       ll_order:  {chamber: [(wid, j), …]} 每个物理 loadlock 按 occ_start 升序的固定服务序。
    warm 缺失或 schedule 不完整 → (None, None)（自动退回原 pairwise 模型，不引入不可行）。"""
    if warm is None or not warm.schedule:
        return None, None
    tm = Durations(task)
    ll_assign: Dict[Tuple[int, int], str] = {}
    events: Dict[str, List[Tuple[float, int, int]]] = {}
    for w in wafers:
        rows = warm.schedule.get(w.wid)
        if not rows or len(rows) != len(w.stages):
            return None, None                      # warm 不完整 → 禁用固定模式
        for j, s in enumerate(w.stages):
            if s.stage_type != "loadlock":
                continue
            cham = rows[j][1]
            av = float(rows[j][2])
            # occ_start 口径与 solve_milp.occ_start 一致（开门起点 = a − place − place_pre）
            ostart = av - (tm.place_t(s.in_robot, cham) + tm.place_pre(s.in_robot, cham)) if s.in_robot else av
            ll_assign[(w.wid, j)] = cham
            events.setdefault(cham, []).append((ostart, w.wid, j))
    ll_order: Dict[str, List[Tuple[int, int]]] = {}
    for c, lst in events.items():
        lst.sort()
        ll_order[c] = [(wid, j) for _, wid, j in lst]
    return ll_assign, ll_order


# --------------------------------------------------------------------------- #
# 建模 + 求解
# --------------------------------------------------------------------------- #
def solve_milp(task: Problem, *, time_limit: float = 300.0,
               verbose: bool = False, ub: Optional[float] = None,
               enable_swap: bool = True, warm: Optional[SolveResult] = None,
               fix_loadlock: bool = False, tune: bool = True,
               stall_limit: Optional[float] = None) -> SolveResult:
    """ub: 一条可行排程的 makespan 上界（如 run_greedy 的 finished makespan）。给定则用
    tight Big-M=2·ub+1 收紧 LP 松弛（方案 §6.2）；None 时退回 loose-M（所有动作时长之和）。

    enable_swap: 是否建模双臂换料（决策 B）。False ⇒ 不建 swap 候选，所有 hop 原子搬运、
    res.swaps 恒空（供 timing 训练集生成：timing 解码层无 swap 原语）。

    fix_loadlock: 固定 loadlock 选腔 + 同腔定序到 warm（通常 timing 解）的交替 entry/exit 计划，消去
    z 析取与全部 xll 二元（短 proc loadlock 饱和时的组合爆炸源），仅当 warm 可用时生效，否则无操作。
    交替是 loadlock 吞吐下界最优 ⇒ 无 makespan 损失，只去搜索（论文 MIP1→MIP2：固定序、MILP 精修时序）。

    tune: 置 Gurobi 参数 MIPFocus=1（重心放在更快找到/改进 incumbent；标签即 incumbent，big-M 下界
    无望、不值得为证明最优耗时）。实测对中/难例「找到好解」更快、对易例中性；关 ⇒ Gurobi 默认（A/B 基准）。
    （注：早先试过的同型加工腔值对称破除 = Gurobi 自带对称检测已覆盖、无增益；MIPFocus=2/Cuts=2 反伤——均弃。）

    stall_limit: incumbent 连续该秒数无改进即早停（None=关）。big-M makespan 下界极弱、难例久证不出最优，
    而 incumbent（配 MIPFocus=1）秒级即达 ≤timing 质量 ⇒ 早停砍掉徒劳的证明尾段、墙钟大降，**不改
    incumbent/标签**（仅放弃 status==OPTIMAL）。诊断见说明：难例 incumbent 早达、下界几乎不动；改进型
    难例须配 MIPFocus=1 先快速逼近最优 incumbent 再早停，方不回归。用于 gen_test 这类批量求标签。"""
    tm = Durations(task)
    wafers = task.wafers
    cap = {n: int(c.capacity) for n, c in task.chambers.items()}

    # 固定 loadlock 计划（仅当 fix_loadlock 且 warm 可用时生效；否则 (None,None) 退回原 pairwise）。
    ll_assign, ll_order = (_fixed_ll_plan(task, wafers, warm) if fix_loadlock else (None, None))

    # Big-M（既作变量上界又作大-M 系数）。
    M = 4000

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

    # (Z) loadlock 腔分配决策（放开 round-robin）：只 loadlock 建选腔变量；加工腔(process) 按 parse 期
    #   round-robin 固定腔（用静态 s.chamber，不建 z）。
    #   z[w,j,c]∈{0,1}, Σ_c z=1。候选腔 pick/place 行程时长相等（marathon_gen 克隆 PM 同 PickTime/
    #   PlaceTime、move 按手取与腔无关）→ L、a=r+L 链、(R) 机器手互斥全不依赖选腔；仅 proc(pump/vent)、
    #   门微动作、(C) 互斥分组依赖 → 下方条件化。
    sel_z: Dict[Tuple[int, int], Dict[str, gp.Var]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type == "loadlock" and len(s.cands) > 1:
                zc = {c: m.addVar(vtype=GRB.BINARY, name=f"z_{w.wid}_{j}_{c}") for c in s.cands}
                m.addConstr(gp.quicksum(zc.values()) == 1, name=f"zsum_{w.wid}_{j}")
                sel_z[w.wid, j] = zc
                # 固定模式：钉 loadlock 选腔到 warm 选中腔（presolve 消去该二元；PM 选腔仍自由）
                if ll_assign is not None and s.stage_type == "loadlock":
                    fc = ll_assign.get((w.wid, j))
                    if fc in zc:
                        m.addConstr(zc[fc] == 1, name=f"zfix_{w.wid}_{j}")

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

    if ll_order is not None:
        # 固定模式：每个物理 loadlock 一条定序链（warm occ_start 升序），无 z 析取、无 xll。
        # 同腔相邻事件 occ_start(next) ≥ occ_end(prev) + 状态 setup（交替 entry/exit ⇒ setup=0）。
        wmap_ll = {w.wid: w for w in wafers}
        for c, seq in ll_order.items():
            for (w1, j1), (w2, j2) in zip(seq, seq[1:]):
                s1 = wmap_ll[w1].stages[j1]; s2 = wmap_ll[w2].stages[j2]
                m.addConstr(occ_start(wmap_ll[w2], j2) >= occ_end(wmap_ll[w1], j1)
                            + ll_setup_c(s1.ll_type, s2.ll_type, c),
                            name=f"CLLfix_{c}_{w1}_{w2}")
    # ll_visits 在固定模式下置空 ⇒ 下方 pairwise 析取（xll）一条不建（消爆点）。
    ll_visits = ([] if ll_order is not None else
                 [(w, j) for w in wafers
                  for j, s in enumerate(w.stages) if s.stage_type == "loadlock"])
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

    # 停滞早停（stall_limit）：incumbent 连续 stall_limit 秒无改进即终止。big-M makespan 松弛下界极弱
    # （根节点整型间隙常 ~60%、久攻不下），而 incumbent 往往秒级即达 ≤timing 质量；剩余时间纯属证明最优
    # 的徒劳。早停只放弃「证明最优」、不改 incumbent/标签（schedule 不变），换取墙钟大降。诊断见
    # scratchpad：难例 incumbent 0s 命中、45s 下界几乎不动。None=不早停（保留原「跑满时限」行为）。
    if stall_limit is not None and stall_limit > 0:
        _stall = {"best": float("inf"), "t": 0.0}

        def _cb(model, where):
            if where == GRB.Callback.MIP:
                bst = model.cbGet(GRB.Callback.MIP_OBJBST)
                now = model.cbGet(GRB.Callback.RUNTIME)
                if bst < _stall["best"] - 1e-6:
                    _stall["best"], _stall["t"] = bst, now
                elif _stall["best"] < float("inf") and now - _stall["t"] > stall_limit:
                    model.terminate()
        m.optimize(_cb)
    else:
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
        res.swaps = [(p.chamber, p.w_out.wid, p.w_in.wid)
                     for k, p in enumerate(swap_pairs) if sw[k].X > 0.5]
    return res