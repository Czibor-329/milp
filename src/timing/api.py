"""便捷封装：_expand → 腔分配寻优 → 定序 → solve_timing 的顶层入口。"""

from __future__ import annotations

from typing import Optional, List

import random

from src.export import check_solution
from src.milp import SolveResult
from src.model import Durations, Problem

from ._common import EPS, _DecodeDeadlock
from .solve import solve_timing
from .sequencing import _Cand, _DecodeState, _Chooser, decode_orders, decode_orders_choosing

def _fixed_default(ir: Problem, durations: Durations, wafers, verbose: bool) -> SolveResult:
    """原始默认（backward）定序 + 驻留预留回退（不动 loadlock 分配）。"""
    res = solve_timing(ir, wafers)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        if verbose:
            print("[timing] 快序超驻留 → 回退驻留预留定序(reserve=True)重排。")
        orders = decode_orders(ir, durations, wafers, reserve=True)
        res = solve_timing(ir, wafers, orders=orders)
    return res


def _pick_best(a: Optional[SolveResult], b: Optional[SolveResult]) -> Optional[SolveResult]:
    """两个候选结果取 makespan 更优的可行者；都不可行/None 时保 a。"""
    if b is None or not getattr(b, "feasible", False):
        return a
    if a is None or not getattr(a, "feasible", False):
        return b
    return b if b.makespan < a.makespan - EPS else a


def _decode_eval(ir: Problem, durations: Durations, wafers, *, swap: bool = False,
                 chooser: Optional[_Chooser] = None) -> Optional[SolveResult]:
    """一次「解码 → solve_timing 精确评估」：可行返回结果，解码死锁/排不出返回 None。"""
    try:
        orders = decode_orders(ir, durations, wafers, chooser=chooser, swap=swap)
    except (RuntimeError, _DecodeDeadlock):
        return None
    r = solve_timing(ir, wafers, orders=orders)
    return r if getattr(r, "feasible", False) else None

def _greedy_chooser(policy) -> _Chooser:
    """策略 chooser：对每候选打分，返回分数降序的偏好序（Banker 在解码循环里再保证无死锁）。"""
    from src.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        scores = policy.score_step(step_features(state, cands))
        return sorted(range(len(cands)), key=lambda i: -float(scores[i]))

    return chooser


def _random_chooser(rng: random.Random) -> _Chooser:
    """随机定序 chooser：每步给合法候选一个均匀随机偏好序。解码循环的 Banker 安全掩码会沿
    该序回退——随机首选会导致死锁时自动跳到下一个安全候选，故任意随机序都解出可行占用序。"""
    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        order = list(range(len(cands)))
        rng.shuffle(order)
        return order
    return chooser


def _random_rollouts(ir: Problem, durations: Durations, wafers, base: Optional[SolveResult],
                     *, n: int, seed: int, verbose: bool) -> Optional[SolveResult]:
    """在给定腔分配基底上做 n 次随机定序 rollout（Banker 保证无死锁；放开 LL swap 空间——
    它严格包含 no-swap 的可行序），solve_timing 精确评估，与 base 取 makespan 最优可行
    （不满足要求——死锁/驻留超限/更差——即回退到已有最优）。"""
    rng = random.Random(seed)
    best = base
    picked = 0
    for _ in range(max(n, 0)):
        r = _decode_eval(ir, durations, wafers, swap=True, chooser=_random_chooser(rng))
        if r is not None and (best is None or not getattr(best, "feasible", False)
                              or r.makespan < best.makespan - EPS):
            best, picked = r, picked + 1
    if verbose and n > 0:
        mk = best.makespan if best is not None and getattr(best, "feasible", False) else float("nan")
        print(f"[timing] 随机定序 rollout ×{n}：采纳 {picked} 次改进 → makespan={mk:.2f}")
    return best


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

def start_schedule(ir: Problem, *, verbose: bool = True, seed: int = 0, random_orders: int = 0) -> SolveResult:
    """_expand → 腔分配寻优 → 默认定序 → solve_timing；可选 milp.check_solution 复核。

    random_orders：随机定序策略的 rollout 次数。每次在同一腔分配基底上按随机顺序派工——每步
    从合法候选里均匀随机选，不满足要求（会死锁）则由 Banker 回退到下一个安全候选；解出的整序
    经 solve_timing 精确评估，仅当可行且 makespan 更优才替换默认序结果（单调不劣）。0=关（默认）。

    LL swap：定完腔分配后额外解一条放开 loadlock 双槽共存（上槽 entry 未加工/下槽 exit 已加工，
    真空手可先放已加工片再取未加工片）的 backward 序，与 no-swap 基线取 makespan 更优（单调不劣）。

    快序（吞吐优先）因驻留(qtime)排不出时回退驻留预留定序（reserve=True）。"""
    durations = Durations(ir)
    wafers = ir.wafers
    res = _fixed_default(ir, durations, wafers, verbose)

    # swap 定序变体：同一腔分配基底上放开 LL 双槽共存（真空手先放已加工片再取未加工片）重解一序，
    # 与 no-swap 基线取优。基线口径未动 ⇒ 单调不劣；swap 空间在 LL 瓶颈例上常省往返跳。
    swap_res = _decode_eval(ir, durations, wafers, swap=True)
    res = _pick_best(res, swap_res)
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