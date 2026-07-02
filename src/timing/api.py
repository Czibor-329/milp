"""对外顶层入口：快速启发式定序 / BC 策略定序 → solve_timing。

只放对外函数；定序策略、评估内核、各类 chooser 等内部件在 heuristic.py。
"""

from __future__ import annotations

from src.export import check_solution
from src.milp import SolveResult
from src.model import Durations, Problem

from ._common import _DecodeDeadlock
from .solve import solve_timing
from .sequencing import decode_orders, decode_orders_choosing
from .heuristic import (_greedy_chooser, _heuristic_schedule, _pick_best,
                        _random_rollouts, _sampling_chooser)


def start_schedule(ir: Problem, *, verbose: bool = True, seed: int = 0, random_orders: int = 0) -> SolveResult:
    """快速启发式定序 → solve_timing；可选 milp.check_solution 复核。

    启发式(_heuristic_schedule)：单 job 喂片优先(让 LL 常装未加工片、填满并行 PM)；2+ job 在几种
    交替发片配比里小规模搜索；含清洁例改排空优先(避免 LL 满死锁)。加工腔沿用 round-robin 固定分配，
    启发式只决定顺序，且每候选另试 LL swap 变体取优（单调不劣）。不做全局组合寻优 ⇒ 快。

    random_orders：随机定序策略的 rollout 次数。每次在同一腔分配基底上按随机顺序派工——每步
    从合法候选里均匀随机选，不满足要求（会死锁）则由 Banker 回退到下一个安全候选；解出的整序
    经 solve_timing 精确评估，仅当可行且 makespan 更优才替换启发式结果（单调不劣）。0=关（默认）。

    快序（吞吐优先）因驻留(qtime)排不出时回退驻留预留定序（reserve=True）。"""
    durations = Durations(ir)
    wafers = ir.wafers
    res = _heuristic_schedule(ir, durations, wafers, verbose)

    # 启发式不可行（多为超驻留 qtime 排不出）→ 回退驻留预留定序（reserve=True，牺牲吞吐换可行）
    if res is None or not getattr(res, "feasible", False):
        if verbose:
            print("[timing] 启发式不可行（疑似超驻留）→ 回退驻留预留定序(reserve=True)")
        orders = decode_orders(ir, durations, wafers, reserve=True)
        fb = solve_timing(ir, wafers, orders=orders)
        res = _pick_best(res, fb) or fb

    if random_orders > 0:
        res = _random_rollouts(ir, durations, wafers, res,
                               n=random_orders, seed=seed, verbose=verbose)
    if getattr(res, "feasible", False):
        issues = check_solution(ir, res)
        if issues:
            print("MoveList Conflict")
            res.check_issues = issues  # type: ignore[attr-defined]
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
