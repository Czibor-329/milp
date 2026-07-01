"""loadlock / 加工腔分配寻优（portfolio 种子 + 贪心下降 + SA-ILS，用快速 BF 评估）。

这是逼近 MILP 的【最大杠杆】：_expand 的 round-robin 让每片 entry+exit 用同一 loadlock
（按 rank 奇偶），把并行加工腔劈成各自串行的奇/偶两条流水（并行腔零收益）。MILP 则解耦
entry/exit（如 entry→LA、exit→LB）让系统真正流水。该解耦是实例相关决策，无单一静态方案普适
（全局轮转易死锁、parity 在单腔例反劣），故按实例快速寻优。评估器是毫秒级 BF，portfolio
几个种子 + 单事件贪心翻腔即可在多数例命中 MILP；解码内含 Banker ⇒ 候选恒无死锁。

genome：一个搜索候选 = 派工偏置 prio + loadlock 选腔 ll_assign。解码器仍走 sequencing.decode_orders
（内含 Banker 安全检查）⇒ 任意候选都解出无死锁占用序；空 genome ⇒ 与默认定序逐字节一致（零回归）。
loadlock 选腔对齐 MILP 的 (Z) 决策：可把某片从 round-robin 默认的 LA 改到 LB 以均衡瓶颈 loadlock 负载。
"""

from __future__ import annotations

import copy
import math
import random
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from src.milp import SolveResult, _ll_proc
from src.model import Durations, Problem

from ._common import EPS
from .sequencing import _DecodeDeadlock, _Orders, decode_orders
from .solve import solve_timing


@dataclass
class _Genome:
    prio: Dict[Tuple[int, int], float] = field(default_factory=dict)      # (wid,j) → 派工偏置
    ll_assign: Dict[Tuple[int, int], str] = field(default_factory=dict)   # (wid,j) → loadlock 选腔


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
    orders = decode_orders(ir, tm, wf, reserve=reserve, prio=genome.prio, banker=banker)
    return wf, orders


def _ll_seed_assignments(wafers) -> List[Dict[Tuple[int, int], str]]:
    """若干 loadlock 全分配种子（解耦 entry/exit 的不同模式）。空 dict = _expand 的 round-robin
    默认（entry/exit 同腔）。其余按 loadlock 占用事件序做不同步幅/相位轮转 + parity，覆盖
    「同片 entry/exit 拆到不同腔」「相邻片错腔」等利于流水的模式。"""
    ev = _chamber_assign_events(wafers)
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
    ev = _chamber_assign_events(wafers)
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


# —— loadlock 腔分配寻优：loadlock 选腔是 MILP 决策(Z)，加工腔(process) 按 round-robin 固定腔不寻优。
# 在 loadlock 专项寻优之上叠加联合种子 + 全 loadlock 事件贪心/ILS（均衡 loadlock 负载，双 job 关键杠杆）。
# 贪心从 loadlock-opt incumbent 起、只接受改进 ⇒ **永不劣于 optimize_loadlock**（单调）。
def _chamber_assign_events(wafers) -> List[Tuple[int, int, List[str]]]:
    """多候选 loadlock stage，按 (wid, j) 顺序：[(wid, j, 候选腔列表)]。
    加工腔(process) 按 round-robin 固定腔，不参与寻优。"""
    out: List[Tuple[int, int, List[str]]] = []
    for w in wafers:
        for j, s in enumerate(w.stages):
            if len(s.cands) > 1 and s.stage_type == "loadlock":
                out.append((w.wid, j, list(s.cands)))
    return out


def _apply_chamber_assign(ir: Problem, wafers, assign: Dict[Tuple[int, int], str]) -> List:
    """克隆 wafers 并套用 loadlock 选腔（process 按 round-robin 固定腔，assign 不含其键 ⇒ 不动）。
    loadlock 选腔后按腔重算 proc (pump/vent)；最后全局重算 slot。"""
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
    口径（loadlock 选腔；加工腔固定 round-robin）。返回 (有效 wafers, res 或 None)。"""
    wf = _apply_chamber_assign(ir, wafers, assign) if assign else wafers
    try:
        orders = decode_orders(ir, tm, wf, reserve=False, banker=True)
    except (RuntimeError, _DecodeDeadlock):
        return wf, None
    res = solve_timing(ir, wf, orders=orders)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        try:
            orders = decode_orders(ir, tm, wf, reserve=True, banker=True)
        except (RuntimeError, _DecodeDeadlock):
            return wf, None
        res = solve_timing(ir, wf, orders=orders)
    return (wf, res) if getattr(res, "feasible", False) else (wf, None)


def _joint_chamber_seeds(wafers) -> List[Dict[Tuple[int, int], str]]:
    """loadlock 分配种子（加工腔按 round-robin 固定腔，不入种子），两族并集：
      族 A：对【所有】loadlock 腔池统一按 (width, stride, offset) 轮转——entry/exit/相邻片细粒度
            错腔交错（深 flowline loadlock-bound 例如 3stage[2,2,1] 需要这种全局交错）。
      族 B：_ll_seed_assignments（含 parity）的 loadlock 专项模式。
    与 loadlock-opt incumbent 取并集 ⇒ 最坏不劣（见 optimize_chambers）。"""
    all_pools: Dict[Tuple[str, ...], List[Tuple[int, int]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            if len(s.cands) > 1 and s.stage_type == "loadlock":
                all_pools.setdefault(tuple(s.cands), []).append((w.wid, j))
    seeds: List[Dict[Tuple[int, int], str]] = []
    # 族 A：全 loadlock 池统一轮转
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
    # 族 B：loadlock 专项模式（parity 等）
    seeds += _ll_seed_assignments(wafers)
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
                      budget: float = 0.6, seed: int = 0, refine_budget: float = 0.0,
                      time_cap: Optional[float] = None
                      ) -> Tuple[Optional[Dict[Tuple[int, int], str]], List, Optional[SolveResult]]:
    """寻优【loadlock 多候选腔】分配——对齐 MILP 腔分配决策(Z)；加工腔按 round-robin 固定腔不寻优。
    返回 (best_assign, best_wafers, best_res)；全不可行返回 (None, wafers, None)。

    三段式（保证不劣于 optimize_loadlock）：① loadlock 专项寻优定 incumbent（已验证命中多数 MILP）；
    ② 叠加 loadlock 联合种子 + 全 loadlock 事件贪心下降（只接受改进）；③ refine_budget>0 时再做
    SA+重启 ILS 逃离贪心局部最优。best_res 走默认 backward 定序。

    refine_budget（秒）：贪心后的 SA-ILS 预算。**多 route 共享 loadlock（双 job）例的关键杠杆**——
    贪心常困在「entry/exit 同腔 round-robin」局部最优，使某 loadlock 过载成饱和瓶颈（此时定序无力，
    见 decode_orders 注），ILS 用单/双事件翻腔 + 回 best/随机重启逃出，找到均衡两 route 负载的不规则
    分配（逼近 MILP）。单调（best 只接受改进 ⇒ ≤ 贪心结果，零回归）。缺省 0 = 不做（单 job 用，已近最优）。
    每次评估 = 默认序一次 BF（makespan 对固定腔分配近似 order-invariant，故评估便宜、可上千次）。

    time_cap（秒）：整函数（含最终评估）墙钟硬上限。设了它，ILS 截止在 t0+time_cap−margin、留余量给
    收尾评估 ⇒ 保证总耗时 ≤ time_cap（满足「不超过 1s」类实时约束）。None=不限（离线高预算模式）。"""
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
    # ② loadlock 联合种子（限宽/错腔；含 incumbent 搞不定的结构）
    for s in _joint_chamber_seeds(wafers):
        wf, res = _eval_chamber_assign(ir, tm, wafers, s)
        if res is not None and res.makespan < best_mk - EPS:
            best_a, best_wf, best_res, best_mk = s, wf, res, res.makespan
    if best_res is None:
        return None, wafers, None
    # ③ 全 loadlock 事件贪心下降，从 incumbent 起、只接受改进 ⇒ ≤ LL-opt
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
        deadline = t0 + budget + refine_budget
        if time_cap is not None:                 # 留 0.2s 余量给收尾完整评估，保证总 ≤ time_cap
            deadline = min(deadline, t0 + time_cap - 0.2)
        best_a, best_wf, best_res, best_mk = _chamber_ils(
            ir, tm, wafers, ev, best_a, best_wf, best_res, best_mk,
            deadline=deadline, seed=seed + 7)
    return best_a, best_wf, best_res


def _chamber_opt_budgets(wafers, ll_budget: float, refine_override: Optional[float]
                         ) -> Tuple[float, float, Optional[float]]:
    """给 optimize_chambers 选 (budget, refine_budget, time_cap)。单 route：现状（贪心 ll_budget、无 ILS、
    无 cap，已近最优）。多 route(双 job 共享 loadlock)：默认 1s 实时档——贪心 0.3s + ILS、总墙钟硬上限 1.0s；
    refine_override 非 None 时按它作 ILS 预算且**不设 cap**（离线高预算档，gap 可压更低但更慢）。"""
    multi = len({w.route_name for w in wafers}) > 1
    if not multi:
        return ll_budget, 0.0, None
    if refine_override is not None:
        return 0.3, refine_override, None
    return 0.3, 0.55, 1.0


def _chamber_ils(ir: Problem, tm: Durations, wafers, ev, best_a, best_wf, best_res,
                 best_mk: float, *, deadline: float, seed: int):
    """从贪心 incumbent 起，对腔分配做 SA + 重启 ILS，跑到墙钟 deadline。每个分配用默认序 BF 快评
    （带 makespan 缓存）。单调：best 只接受改进 ⇒ 返回 ≤ 入参 best_mk。返回 (best_a, best_wf, best_res, best_mk)。"""
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
    span = max(deadline - t0, 1e-6)
    n = 0
    while time.perf_counter() < deadline:
        n += 1
        frac = (time.perf_counter() - t0) / span
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
