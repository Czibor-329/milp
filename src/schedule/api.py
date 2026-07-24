"""启发式策略入口及 RL 训练使用的 BC 兼容评估函数。

生产 RL 搜索位于 ``rl.py``；定序、评估内核和 chooser 位于 ``heuristic.py``。
"""

from __future__ import annotations

from src.export import check_solution
from src.parse.model import Durations, Problem
from src.timing.solve import SolveResult, solve_timing

from src.timing._common import _DecodeDeadlock
from .loadlock_dispatch import (
    EXCHANGE_DISABLED,
    LoadLockDispatchManager,
    resolve_loadlock_exchange_mode,
    resolve_loadlock_manager,
)
from .sequencing import decode_orders, decode_orders_choosing
from .heuristic import (_greedy_chooser, _heuristic_schedule, _pick_best,
                        _random_rollouts, _sampling_chooser,
                        _two_job_timed_search)

# BC 选腔解码先由 Petri 终态可达性掩码约束动作。默认多采样 rollout（greedy + N 个温度采样）
# 扩大找到更优解码的机会，
# 并以启发式(round-robin 腔，恒可行)为可行性地板：取「最优可行」⇒ 单调不劣于启发式、且保证可行。
_BC_DEFAULT_SAMPLES = 64


def start_schedule(ir: Problem, *, verbose: bool = True, seed: int = 0,
                   random_orders: int = 0, search_seconds: float = 0.0,
                   loadlock_manager: LoadLockDispatchManager | str | None = "petri-eta",
                   loadlock_exchange: str | bool | None = "auto",
                   ) -> SolveResult:
    """快速启发式定序 to solve_timing；可选 milp.check_solution 复核。

    heuristic：单 job 喂片优先(让 LL 常装未加工片、填满并行 PM)；2+ job 在几种
    交替发片配比里小规模搜索；含清洁例改排空优先(避免 LL 满死锁)。加工腔沿用 round-robin 固定分配，
    启发式只决定顺序，且每候选另试 LL swap 变体取优（单调不劣）。不做全局组合寻优 ⇒ 快。

    random_orders：随机定序策略的 rollout 次数。每次在同一腔分配基底上按随机顺序派工——每步
    从 Petri 安全候选里均匀随机选；解出的整序
    经 solve_timing 精确评估，仅当可行且 makespan 更优才替换启发式结果（单调不劣）。0=关（默认）。

    search_seconds：2-job 结构化搜索的墙钟预算。搜索两条 route 的 FIFO 发片交织，精确定时取优，
    并按驻留违例定向修复；0=关闭（保持原快速启发式行为），推荐限时模式传 7.0。

    快序（吞吐优先）因驻留(qtime)排不出时回退驻留预留定序（reserve=True）。"""
    manager = resolve_loadlock_manager(loadlock_manager)
    exchange_mode = resolve_loadlock_exchange_mode(loadlock_exchange)
    durations = Durations(ir)
    wafers = ir.wafers
    res = _heuristic_schedule(
        ir,
        durations,
        wafers,
        verbose,
        loadlock_manager=manager,
        loadlock_exchange_mode=exchange_mode,
    )

    # 启发式不可行（多为超驻留 qtime 排不出）→ 回退驻留预留定序（reserve=True，牺牲吞吐换可行）
    if res is None or not getattr(res, "feasible", False):
        if verbose:
            print("[timing] 启发式不可行（疑似超驻留）→ 回退驻留预留定序(reserve=True)")
        orders = decode_orders(
            ir,
            durations,
            wafers,
            reserve=True,
            swap=exchange_mode != EXCHANGE_DISABLED,
        )
        fb = solve_timing(ir, wafers, orders=orders)
        fb.loadlock_exchange = (  # type: ignore[attr-defined]
            "enabled"
            if exchange_mode != EXCHANGE_DISABLED
            else EXCHANGE_DISABLED
        )
        res = _pick_best(res, fb) or fb

    if random_orders > 0:
        res = _random_rollouts(ir, durations, wafers, res,
                               n=random_orders, seed=seed, verbose=verbose,
                               swap=exchange_mode != EXCHANGE_DISABLED)
    if search_seconds > 0:
        res = _two_job_timed_search(ir, durations, wafers, res,
                                    seconds=search_seconds, seed=seed, verbose=verbose,
                                    loadlock_exchange_mode=exchange_mode)
    if getattr(res, "feasible", False):
        issues = check_solution(ir, res)
        if issues:
            if verbose:
                print("MoveList Conflict")
            res.check_issues = issues  # type: ignore[attr-defined]
    if res is not None:
        res.loadlock_manager_requested = (  # type: ignore[attr-defined]
            manager.name if manager is not None else "none"
        )
        res.loadlock_manager_selected = getattr(  # type: ignore[attr-defined]
            res,
            "loadlock_manager",
            "fixed-baseline",
        )
        res.loadlock_exchange_requested = exchange_mode  # type: ignore[attr-defined]
        res.loadlock_exchange_selected = getattr(  # type: ignore[attr-defined]
            res,
            "loadlock_exchange",
            "unknown",
        )
    return res


def start_schedule_by_policy(ir: Problem, policy, *, n_samples: int = _BC_DEFAULT_SAMPLES,
                             temp: float = 0.7, seed: int = 0, fallback: bool = True,
                             verbose: bool = False,
                             loadlock_manager: LoadLockDispatchManager | str | None = "petri-eta",
                             ) -> SolveResult:
    """BC 策略【联合选腔 + 定序】→ solve_timing。策略 chooser 在每步的多候选腔候选上打分，
    decode_orders_choosing 联合决定 (hop, 腔)，把选中腔写回 wafers 后原样喂 solve_timing
    （train/推理同口径：标签也跟随 MILP 选腔）。

    n_samples：greedy 之外再叠 N 次温度采样 rollout（各按 policy 分布抽偏好序、精确评估），取最优
    可行。多 job 时多采样可探索不同安全序列并改善 makespan。fallback=True：再以启发式
    (round-robin 腔，恒可行)为可行性地板，取「最优可行」
    ⇒ 保证可行(与启发式同 64/64)且单调不劣于启发式；纯 BC 评测可传 fallback=False。"""
    import numpy as np
    manager = resolve_loadlock_manager(loadlock_manager)
    tm = Durations(ir)
    rng = np.random.default_rng(seed)
    wafers = ir.wafers

    choosers = [_greedy_chooser(policy)]
    choosers += [_sampling_chooser(policy, rng, temp) for _ in range(max(n_samples, 0))]
    best = None
    for ch in choosers:
        if manager is not None:
            # 旧 BC checkpoint 仍在物理候选上训练，使用 manager 的兼容折叠；
            # 新的逻辑候选 checkpoint 可改用严格 ``separate_loadlock_choice``。
            ch = (
                lambda base: (
                    lambda state, candidates: manager.rank_preferred_candidates(
                        state,
                        candidates,
                        base(state, candidates),
                    )
                )
            )(ch)
        try:
            wf, orders = decode_orders_choosing(ir, tm, wafers, chooser=ch, reserve=False)
        except (RuntimeError, _DecodeDeadlock):
            continue
        r = solve_timing(ir, wf, orders=orders)
        if getattr(r, "feasible", False) and (best is None or r.makespan < best.makespan):
            best = r

    if fallback:                                               # 启发式可行性地板（含 reserve 兜底，恒可行）
        floor = start_schedule(
            ir,
            verbose=verbose,
            loadlock_manager=manager,
        )                                                       # 单调不劣于启发式、保证可行
        best = _pick_best(best, floor)

    res = best
    if res is not None:
        res.check_issues = check_solution(ir, res)             # type: ignore[attr-defined]
        res.loadlock_manager_requested = (  # type: ignore[attr-defined]
            manager.name if manager is not None else "none"
        )
        res.loadlock_manager_selected = getattr(  # type: ignore[attr-defined]
            res,
            "loadlock_manager",
            "policy-or-fixed-floor",
        )
    return res


