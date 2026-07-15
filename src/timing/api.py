"""对外顶层入口：启发式、BC、RL 顶层定序 → ``solve_timing`` 精确定时。

只放对外函数；定序策略、评估内核、各类 chooser 等内部件在 heuristic.py。
"""

from __future__ import annotations

import time

from src.export import check_solution
from src.milp import SolveResult
from src.model import Durations, Problem

from ._common import _DecodeDeadlock
from .solve import solve_timing
from .sequencing import decode_orders, decode_orders_choosing
from .heuristic import (_greedy_chooser, _heuristic_schedule, _pick_best,
                        _random_rollouts, _sampling_chooser,
                        _two_job_timed_search)
from .paper import paper_task_pool_search

# BC 选腔解码可能因某步 loadlock 选腔提交后无安全候选而死锁（Banker 只能重排 hop、无法回退已提交
# 的选腔）→ 整例判不可行。默认多采样 rollout（greedy + N 个温度采样）扩大找到可行且更优解码的机会，
# 并以启发式(round-robin 腔，恒可行)为可行性地板：取「最优可行」⇒ 单调不劣于启发式、且保证可行。
_BC_DEFAULT_SAMPLES = 64
_RL_DEFAULT_SEARCH_SECONDS = 4.0
# 给一次已开始的解码、结果封装和调用方校验预留余量，使 run.py 的策略墙钟时间稳定低于 5 秒。
_RL_MAX_SEARCH_SECONDS = 4.5
_RL_DEFAULT_MAX_ROLLOUTS = 256
_RL_MIN_ROLLOUT_GUARD_SECONDS = 0.02


def start_schedule(ir: Problem, *, verbose: bool = True, seed: int = 0,
                   random_orders: int = 0, search_seconds: float = 0.0) -> SolveResult:
    """快速启发式定序 to solve_timing；可选 milp.check_solution 复核。

    heuristic：单 job 喂片优先(让 LL 常装未加工片、填满并行 PM)；2+ job 在几种
    交替发片配比里小规模搜索；含清洁例改排空优先(避免 LL 满死锁)。加工腔沿用 round-robin 固定分配，
    启发式只决定顺序，且每候选另试 LL swap 变体取优（单调不劣）。不做全局组合寻优 ⇒ 快。

    random_orders：随机定序策略的 rollout 次数。每次在同一腔分配基底上按随机顺序派工——每步
    从合法候选里均匀随机选，不满足要求（会死锁）则由 Banker 回退到下一个安全候选；解出的整序
    经 solve_timing 精确评估，仅当可行且 makespan 更优才替换启发式结果（单调不劣）。0=关（默认）。

    search_seconds：2-job 结构化搜索的墙钟预算。搜索两条 route 的 FIFO 发片交织，精确定时取优，
    并按驻留违例定向修复；0=关闭（保持原快速启发式行为），推荐限时模式传 7.0。

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
    if search_seconds > 0:
        res = _two_job_timed_search(ir, durations, wafers, res,
                                    seconds=search_seconds, seed=seed, verbose=verbose)
    if getattr(res, "feasible", False):
        issues = check_solution(ir, res)
        if issues:
            print("MoveList Conflict")
            res.check_issues = issues  # type: ignore[attr-defined]
    return res


def start_schedule_paper(ir: Problem, *, search_seconds: float = 7.0,
                         seed: int = 0, verbose: bool = False) -> SolveResult:
    """论文式加工仓任务池调度入口。

    先运行快速启发式获得可行性地板，再按论文第 4 节生成加工仓任务池初始序，搜索实际
    ``LoadLock → PM`` 加工端顺序；每个候选均由 ``solve_timing`` 精确验证。返回结果保证不劣于
    快速启发式，``search_seconds`` 只计算任务池搜索阶段。
    """
    durations = Durations(ir)
    base = start_schedule(ir, verbose=False)
    result = paper_task_pool_search(
        ir, durations, ir.wafers, base, seconds=search_seconds,
        seed=seed, verbose=verbose)
    if result is not None and getattr(result, "feasible", False):
        result.check_issues = check_solution(ir, result)  # type: ignore[attr-defined]
    return result


def start_schedule_by_policy(ir: Problem, policy, *, n_samples: int = _BC_DEFAULT_SAMPLES,
                             temp: float = 0.7, seed: int = 0, fallback: bool = True,
                             verbose: bool = False) -> SolveResult:
    """BC 策略【联合选腔 + 定序】→ solve_timing。策略 chooser 在每步的多候选腔候选上打分，
    decode_orders_choosing 联合决定 (hop, 腔)，把选中腔写回 wafers 后原样喂 solve_timing
    （train/推理同口径：标签也跟随 MILP 选腔）。

    n_samples：greedy 之外再叠 N 次温度采样 rollout（各按 policy 分布抽偏好序、精确评估），取最优
    可行。多 job 时单条 greedy 选腔常在中途死锁（Banker 无法回退已提交的选腔）⇒ 多采样显著提升
    可行率与 makespan。fallback=True：再以启发式(round-robin 腔，恒可行)为可行性地板，取「最优可行」
    ⇒ 保证可行(与启发式同 64/64)且单调不劣于启发式；纯 BC 评测可传 fallback=False。"""
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

    if fallback:                                               # 启发式可行性地板（含 reserve 兜底，恒可行）
        floor = start_schedule(ir, verbose=verbose)            # 单调不劣于启发式、保证可行
        best = _pick_best(best, floor)

    res = best
    if res is not None:
        res.check_issues = check_solution(ir, res)             # type: ignore[attr-defined]
    return res


def start_schedule_by_rl(ir: Problem, policy, *,
                         search_seconds: float = _RL_DEFAULT_SEARCH_SECONDS,
                         max_rollouts: int = _RL_DEFAULT_MAX_ROLLOUTS,
                         temp: float = 0.7, seed: int = 0,
                         fallback: bool = True,
                         verbose: bool = False) -> SolveResult:
    """RL 顶层顺序搜索，底层统一交给 ``solve_timing`` 精确定时。

    RL 策略只给当前合法 ``(hop, 目标腔)`` 候选排序；``decode_orders_choosing`` 的 Banker
    检查相当于参考 Petri 环境的动作掩码，负责拒绝会导致死锁的动作。先评估策略 greedy 序，
    再用 Gumbel/softmax 采样多个候选序，并由 ``solve_timing`` 选择 makespan 最小的可行解。
    候选共享网络与相对/容量归一化特征都不依赖固定晶圆数，因此同一 checkpoint 可从 5 片
    训练外推到 25 片或更多晶圆。

    ``search_seconds`` 是包含启发式可行性地板在内的墙钟预算，内部硬限制为 4.5 秒；每轮会按
    已观测到的最慢 rollout 预留收尾时间，避免在截止点前启动来不及完成的新候选。返回结果始终
    是已经过 ``solve_timing`` 验证的完整可行排程。
    """
    if search_seconds < 0:
        raise ValueError("search_seconds 不能为负数")
    if max_rollouts < 0:
        raise ValueError("max_rollouts 不能为负数")
    if temp <= 0:
        raise ValueError("temp 必须为正数")

    import numpy as np

    budget = min(float(search_seconds), _RL_MAX_SEARCH_SECONDS)
    search_start = time.perf_counter()
    deadline = search_start + budget
    durations = Durations(ir)
    wafers = ir.wafers
    rng = np.random.default_rng(seed)
    best = start_schedule(ir, verbose=False) if fallback else None
    rollout_count = 0
    improvement_count = 0
    longest_rollout = 0.0

    choosers = [_greedy_chooser(policy)]
    choosers.extend(
        _sampling_chooser(policy, rng, temp)
        for _ in range(max_rollouts)
    )
    for chooser in choosers:
        now = time.perf_counter()
        guard = max(_RL_MIN_ROLLOUT_GUARD_SECONDS, longest_rollout * 1.25)
        if budget <= 0 or now + guard >= deadline:
            break
        rollout_start = now
        try:
            selected_wafers, orders = decode_orders_choosing(
                ir, durations, wafers, chooser=chooser,
                reserve=False, banker=True,
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
        best.rl_search_runtime = runtime              # type: ignore[attr-defined]
        best.rl_search_budget = budget                # type: ignore[attr-defined]
        best.rl_rollouts = rollout_count              # type: ignore[attr-defined]
        best.rl_improvements = improvement_count      # type: ignore[attr-defined]
        best.check_issues = check_solution(ir, best)  # type: ignore[attr-defined]
    if verbose:
        makespan = (best.makespan if best is not None and getattr(best, "feasible", False)
                    else float("nan"))
        print(f"[timing] RL 限时搜索 {runtime:.3f}s/{budget:.3f}s："
              f"rollout={rollout_count}，改进={improvement_count}，makespan={makespan:.2f}")
    return best
