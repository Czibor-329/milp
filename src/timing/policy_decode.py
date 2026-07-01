"""BC 策略派工：用学到的候选打分器替换默认 chooser，经 Banker 安全解码 + solve_timing 求时刻。
策略不可行（驻留/无安全候选）时回退默认定序；最终取 min(策略, 默认) ⇒ 最坏不退化。
策略对象由 src.policy.load_policy 加载（需 torch）。
"""

from __future__ import annotations

from typing import List

from src.export import check_solution
from src.milp import SolveResult
from src.model import Durations, Problem

from .api import _fixed_default
from .chambers import _chamber_opt_budgets, optimize_chambers
from .sequencing import _Cand, _DecodeState, _Chooser, _decode_orders
from .solve import solve_timing


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


def time_from_policy(ir: Problem, policy, *, n_samples: int = 32, temp: float = 0.7,
                     seed: int = 0, verbose: bool = False, cross_check: bool = False,
                     ll_budget: float = 1.0) -> SolveResult:
    """BC 策略定序 → solve_timing（毫秒级精确评估器）。先把【腔分配】寻优定下（最大杠杆，与
    time_from_ir 同基底），再在该基底上：贪心解码 1 次 + n_samples 次策略随机 rollout，全部
    solve_timing 评估取可行最优。策略全不可行/更差时回退该基底默认定序——返回 min(策略, 默认)，
    **最坏不退化**。n_samples=0 ⇒ 只贪心。

    注：腔分配（loadlock + 并行加工腔）是结构性决策（MILP 的 Z），由毫秒级 portfolio 寻优负责；
    策略只决定该基底上的占用/派工【顺序】。否则策略困在 round-robin 坏默认上，必然 == 固定顺序。"""
    import numpy as np
    tm = Durations(ir)
    rng = np.random.default_rng(seed)

    # 腔分配基底寻优（与 time_from_ir 一致，多 route 自动开 ILS、总墙钟 ≤1s）；无可行则退 round-robin。
    b, rb, cap = _chamber_opt_budgets(ir.wafers, ll_budget, None)
    _, wafers, base = optimize_chambers(ir, tm, ir.wafers, budget=b, seed=seed,
                                        refine_budget=rb, time_cap=cap)
    if base is None:
        base = _fixed_default(ir, tm, ir.wafers, verbose=False)
        wafers = ir.wafers

    choosers = [_greedy_chooser(policy)]
    choosers += [_sampling_chooser(policy, rng, temp) for _ in range(max(n_samples, 0))]
    best = None
    for ch in choosers:
        try:
            orders = _decode_orders(ir, tm, wafers, chooser=ch, reserve=False, banker=True)
        except RuntimeError:
            continue
        r = solve_timing(ir, wafers, orders=orders)
        if getattr(r, "feasible", False) and (best is None or r.makespan < best.makespan):
            best = r

    if best is not None and best.makespan <= getattr(base, "makespan", float("inf")):
        res = best
    else:
        res = base
    if verbose:
        pm = best.makespan if best is not None else float("nan")
        print(f"[timing][policy] 策略最优={pm:.2f}  基底默认={getattr(base,'makespan',float('nan')):.2f}"
              f"  采用={res.makespan:.2f}")
    if cross_check and getattr(res, "feasible", False):
        res.check_issues = check_solution(ir, res)             # type: ignore[attr-defined]
    return res
