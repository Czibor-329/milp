"""RL 顶层顺序搜索策略。

普通本地排程中，策略网络只对 ``Machine`` 暴露的安全搬运候选排序；每个 rollout
均在独立 Machine 分支上运行，并保留导出 MoveList makespan 最小的结果。旧
Petri/``solve_timing`` 代码只供非 ``Problem`` 测试适配使用。
"""

from __future__ import annotations

import time

from src.export import check_solution
from src.parse.model import Durations, Problem
from src.timing._common import _DecodeDeadlock
from src.timing.solve import SolveResult, solve_timing

from .api import start_schedule
from .heuristic import _greedy_chooser, _pick_best, _sampling_chooser
from .loadlock_dispatch import (
    EXCHANGE_DISABLED,
    LoadLockDispatchManager,
    resolve_loadlock_exchange_mode,
    resolve_loadlock_manager,
)
from .sequencing import decode_orders_choosing


_DEFAULT_SEARCH_SECONDS = 4.0
_MAX_SEARCH_SECONDS = 4.5
_DEFAULT_MAX_ROLLOUTS = 256
_MIN_ROLLOUT_GUARD_SECONDS = 0.02


def start_schedule_by_rl(
    ir: Problem,
    policy,
    *,
    search_seconds: float = _DEFAULT_SEARCH_SECONDS,
    max_rollouts: int = _DEFAULT_MAX_ROLLOUTS,
    temp: float = 0.7,
    seed: int = 0,
    fallback: bool = True,
    verbose: bool = False,
    loadlock_manager: LoadLockDispatchManager | str | None = "petri-eta",
    loadlock_exchange: str | bool | None = "auto",
) -> SolveResult:
    """在限时 Machine 分支中搜索搬运顺序，并按真实 MoveList makespan 选优。"""
    if search_seconds < 0:
        raise ValueError("search_seconds 不能为负数")
    if max_rollouts < 0:
        raise ValueError("max_rollouts 不能为负数")
    if temp <= 0:
        raise ValueError("temp 必须为正数")

    import numpy as np

    budget = min(float(search_seconds), _MAX_SEARCH_SECONDS)
    manager = resolve_loadlock_manager(loadlock_manager)
    exchange_mode = resolve_loadlock_exchange_mode(loadlock_exchange)
    search_start = time.perf_counter()
    deadline = search_start + budget
    durations = Durations(ir)
    wafers = ir.wafers
    rng = np.random.default_rng(seed)
    if isinstance(ir, Problem):
        from src.schedule.machine_policy import (
            HeuristicMachineSelector,
            RlMachineSelector,
            schedule_with_machine,
        )
        from src.validation.state import MachineDeadlockError

        machine_best = None
        if fallback:
            machine_best = schedule_with_machine(
                ir,
                HeuristicMachineSelector(),
            )
        rollout_count = 0
        improvement_count = 0
        selectors = [RlMachineSelector(ir, policy)]
        selectors.extend(
            RlMachineSelector(
                ir,
                policy,
                rng=rng,
                temperature=temp,
            )
            for _ in range(max_rollouts)
        )
        for selector in selectors:
            if budget <= 0 or time.perf_counter() >= deadline:
                break
            try:
                candidate = schedule_with_machine(ir, selector)
            except (MachineDeadlockError, ValueError):
                rollout_count += 1
                continue
            rollout_count += 1
            if (
                machine_best is None
                or candidate.makespan < machine_best.makespan
            ):
                machine_best = candidate
                improvement_count += 1
        if machine_best is None:
            raise RuntimeError("RL Machine rollout 未找到可行计划")
        runtime = time.perf_counter() - search_start
        machine_best.rl_search_runtime = runtime  # type: ignore[attr-defined]
        machine_best.rl_search_budget = budget  # type: ignore[attr-defined]
        machine_best.rl_rollouts = rollout_count  # type: ignore[attr-defined]
        machine_best.rl_improvements = improvement_count  # type: ignore[attr-defined]
        machine_best.loadlock_manager_requested = (  # type: ignore[attr-defined]
            manager.name if manager is not None else "none"
        )
        machine_best.loadlock_manager_selected = "machine"  # type: ignore[attr-defined]
        machine_best.loadlock_exchange_requested = exchange_mode  # type: ignore[attr-defined]
        machine_best.loadlock_exchange_selected = "disabled"  # type: ignore[attr-defined]
        machine_best.check_issues = check_solution(ir, machine_best)  # type: ignore[attr-defined]
        return machine_best

    best = (
        start_schedule(
            ir,
            verbose=False,
            loadlock_manager=manager,
            loadlock_exchange=exchange_mode,
        )
        if fallback
        else None
    )
    rollout_count = 0
    improvement_count = 0
    longest_rollout = 0.0

    choosers = [_greedy_chooser(policy)]
    choosers.extend(_sampling_chooser(policy, rng, temp) for _ in range(max_rollouts))
    for chooser in choosers:
        if manager is not None:
            base_chooser = chooser

            def chooser(state, candidates, base=base_chooser):
                """让旧物理候选策略经公共 manager 绑定 LoadLock。"""
                return manager.rank_preferred_candidates(
                    state,
                    candidates,
                    base(state, candidates),
                )
        now = time.perf_counter()
        guard = max(_MIN_ROLLOUT_GUARD_SECONDS, longest_rollout * 1.25)
        if budget <= 0 or now + guard >= deadline:
            break
        rollout_start = now
        try:
            selected_wafers, orders = decode_orders_choosing(
                ir,
                durations,
                wafers,
                chooser=chooser,
                reserve=False,
                swap=exchange_mode != EXCHANGE_DISABLED,
            )
        except (RuntimeError, _DecodeDeadlock):
            longest_rollout = max(longest_rollout, time.perf_counter() - rollout_start)
            rollout_count += 1
            continue

        result = solve_timing(ir, selected_wafers, orders=orders)
        rollout_count += 1
        longest_rollout = max(longest_rollout, time.perf_counter() - rollout_start)
        previous = best
        best = _pick_best(best, result)
        improvement_count += int(best is result and best is not previous)

    runtime = time.perf_counter() - search_start
    if best is not None:
        best.rl_search_runtime = runtime  # type: ignore[attr-defined]
        best.rl_search_budget = budget  # type: ignore[attr-defined]
        best.loadlock_manager_requested = (  # type: ignore[attr-defined]
            manager.name if manager is not None else "none"
        )
        best.loadlock_manager_selected = getattr(  # type: ignore[attr-defined]
            best,
            "loadlock_manager",
            "policy-or-fixed-floor",
        )
        best.loadlock_exchange_requested = exchange_mode  # type: ignore[attr-defined]
        best.loadlock_exchange_selected = getattr(  # type: ignore[attr-defined]
            best,
            "loadlock_exchange",
            "enabled" if exchange_mode != EXCHANGE_DISABLED else EXCHANGE_DISABLED,
        )
        best.rl_rollouts = rollout_count  # type: ignore[attr-defined]
        best.rl_improvements = improvement_count  # type: ignore[attr-defined]
        best.check_issues = check_solution(ir, best)  # type: ignore[attr-defined]
    if verbose:
        makespan = (
            best.makespan
            if best is not None and getattr(best, "feasible", False)
            else float("nan")
        )
        print(
            f"[schedule] RL 限时搜索 {runtime:.3f}s/{budget:.3f}s："
            f"rollout={rollout_count}，改进={improvement_count}，makespan={makespan:.2f}"
        )
    return best
