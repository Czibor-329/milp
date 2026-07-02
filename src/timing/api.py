"""便捷封装：_expand → 腔分配寻优 → 定序 → solve_timing 的顶层入口。"""

from __future__ import annotations

from typing import Optional, List

from src.export import check_solution
from src.milp import SolveResult
from src.model import Durations, Problem

from ._common import _DecodeDeadlock
from .chambers import _chamber_opt_budgets, optimize_chambers
from .solve import solve_timing
from .sequencing import _Cand, _DecodeState, _Chooser, decode_orders, decode_orders_choosing

def _fixed_default(ir: Problem, durations: Durations, wafers, verbose: bool) -> SolveResult:
    """原始默认（backward）定序 + 驻留预留回退（不动 loadlock 分配）。"""
    res = solve_timing(ir, wafers, verbose=verbose)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        if verbose:
            print("[timing] 快序超驻留 → 回退驻留预留定序(reserve=True)重排。")
        orders = decode_orders(ir, durations, wafers, reserve=True)
        res = solve_timing(ir, wafers, orders=orders, verbose=verbose)
    return res

def _greedy_chooser(policy) -> _Chooser:
    """策略 chooser：对每候选打分，返回分数降序的偏好序（Banker 在解码循环里再保证无死锁）。"""
    from src.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        scores = policy.score_step(step_features(state, cands))
        return sorted(range(len(cands)), key=lambda i: -float(scores[i]))

    return chooser


def _sampling_chooser(policy, rng, temp: float) -> _Chooser:
    """随机 rollout 的 chooser：分数/temp 加 Gumbel 噪声后排序（= 按 softmax(分数/temp) 抽偏好序）。
    多次 rollout 用 timing 精确评估取最优，逼近策略下的最好序——仍是纯 BC（推理期解码，不训练）。"""
    import numpy as np
    from src.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        s = policy.score_step(step_features(state, cands)) / temp
        g = rng.gumbel(size=len(s))
        return list(np.argsort(-(s + g)))

    return chooser

def start_schedule(ir: Problem, *, verbose: bool = True, cross_check: bool = True,
                   optimize_ll: bool = True, ll_budget: float = 1.0,
                   seed: int = 0, refine_budget: Optional[float] = None) -> SolveResult:
    """_expand → 腔分配寻优 → 默认定序 → solve_timing；可选 milp.check_solution 复核。

    optimize_ll=True（默认）：先 portfolio+贪心定【腔分配】（loadlock + 并行加工腔，最大杠杆，
    逼近 MILP 的 Z 决策），再在该基底上走默认 backward 定序。无可行分配时退回原始默认。
    optimize_ll=False ⇒ 原行为（纯 round-robin 默认腔，作快速/对照基线）。

    refine_budget：腔分配 SA-ILS 预算（秒）。缺省 None ⇒ 多 route(双 job)自动给 0.55s（墙钟总
    上限 1s）、单 route 给 0（见 _chamber_opt_budgets / optimize_chambers ④）。单调，零回归。

    快序（吞吐优先）因驻留(qtime)排不出时回退驻留预留定序（reserve=True）。"""
    durations = Durations(ir)
    wafers = ir.wafers
    if optimize_ll:
        chamber_budget, chamber_refine_budget, chamber_time_cap = _chamber_opt_budgets(
            wafers, ll_budget, refine_budget)
        _, assigned_wafers, res = optimize_chambers(
            ir, durations, wafers, budget=chamber_budget, seed=seed,
            refine_budget=chamber_refine_budget, time_cap=chamber_time_cap)
        if res is None:                          # 无可行腔分配 → 原始默认（含 reserve 回退）
            res = _fixed_default(ir, durations, wafers, verbose)
        else:
            wafers = assigned_wafers
        if verbose:
            print(f"[timing] 腔分配寻优 → makespan={res.makespan:.2f}"
                  if getattr(res, "feasible", False) else "[timing] 腔分配寻优：无可行")
    else:
        res = _fixed_default(ir, durations, wafers, verbose)
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

def start_schedule_by_policy(ir: Problem, policy, *, n_samples: int = 1, temp: float = 0.7, seed: int = 0) -> SolveResult:
    """BC 策略【联合选腔 + 定序】→ solve_timing。策略 chooser 在每步的多候选腔候选上打分，
    decode_orders_choosing 联合决定 (hop, 腔)，把选中腔写回 wafers 后原样喂 solve_timing
    （train/推理同口径：标签也跟随 MILP 选腔）。多 sample 取 makespan 最优可行。"""
    import numpy as np
    tm = Durations(ir)
    rng = np.random.default_rng(seed)
    wafers = ir.wafers

    choosers = [_greedy_chooser(policy)]
    choosers += [_sampling_chooser(policy, rng, temp) for _ in range(max(n_samples, 0))]
    best = None
    for ch in choosers:
        try:
            wf, orders = decode_orders_choosing(ir, tm, wafers, chooser=ch, reserve=False, banker=True)
        except (RuntimeError, _DecodeDeadlock):
            continue
        r = solve_timing(ir, wf, orders=orders)
        if getattr(r, "feasible", False) and (best is None or r.makespan < best.makespan):
            best = r

    res = best
    if res is not None:
        res.check_issues = check_solution(ir, res)             # type: ignore[attr-defined]
        return res
    else:
        return res