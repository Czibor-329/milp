"""便捷封装：_expand → 腔分配寻优 → 定序 → solve_timing 的顶层入口。"""

from __future__ import annotations

from typing import Optional

from src.export import check_solution
from src.milp import SolveResult
from src.model import Durations, Problem

from .chambers import _chamber_opt_budgets, optimize_chambers
from .search import optimize_orders
from .sequencing import _sequence
from .solve import solve_timing


def _fixed_default(ir: Problem, tm: Durations, wafers, verbose: bool) -> SolveResult:
    """原始默认（backward）定序 + 驻留预留回退（不动 loadlock 分配）。"""
    res = solve_timing(ir, wafers, verbose=verbose)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        if verbose:
            print("[timing] 快序超驻留 → 回退驻留预留定序(reserve=True)重排。")
        orders = _sequence(ir, tm, wafers, reserve=True)
        res = solve_timing(ir, wafers, orders=orders, verbose=verbose)
    return res


def time_from_ir(ir: Problem, *, verbose: bool = True, cross_check: bool = True,
                 optimize_ll: bool = True, ll_budget: float = 1.0,
                 seed: int = 0, refine_budget: Optional[float] = None) -> SolveResult:
    """_expand → 腔分配寻优 → 默认定序 → solve_timing；可选 milp.check_solution 复核。

    optimize_ll=True（默认）：先 portfolio+贪心定【腔分配】（loadlock + 并行加工腔，最大杠杆，
    逼近 MILP 的 Z 决策），再在该基底上走默认 backward 定序。无可行分配时退回原始默认。
    optimize_ll=False ⇒ 原行为（纯 round-robin 默认腔，作快速/对照基线）。

    refine_budget：腔分配 SA-ILS 预算（秒）。缺省 None ⇒ 多 route(双 job)自动给 0.55s（墙钟总
    上限 1s）、单 route 给 0（见 _chamber_opt_budgets / optimize_chambers ④）。单调，零回归。

    快序（吞吐优先）因驻留(qtime)排不出时回退驻留预留定序（reserve=True）。"""
    tm = Durations(ir)
    wafers = ir.wafers
    if optimize_ll:
        b, rb, cap = _chamber_opt_budgets(wafers, ll_budget, refine_budget)
        _, wf, res = optimize_chambers(ir, tm, wafers, budget=b, seed=seed,
                                       refine_budget=rb, time_cap=cap)
        if res is None:                          # 无可行腔分配 → 原始默认（含 reserve 回退）
            res = _fixed_default(ir, tm, wafers, verbose)
        else:
            wafers = wf
        if verbose:
            print(f"[timing] 腔分配寻优 → makespan={res.makespan:.2f}"
                  if getattr(res, "feasible", False) else "[timing] 腔分配寻优：无可行")
    else:
        res = _fixed_default(ir, tm, wafers, verbose)
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


def optimize_from_ir(ir: Problem, *, budget: float = 2.0, seed: int = 0,
                     verbose: bool = True, cross_check: bool = True) -> SolveResult:
    """time_from_ir 的寻优版：局部搜索（占用序 + loadlock 选腔）逼近 MILP，再可选独立复核。
    单次定序仍由 time_from_ir 提供（快速基线）。"""
    wafers = ir.wafers
    res = optimize_orders(ir, wafers, budget=budget, seed=seed, verbose=verbose)
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
