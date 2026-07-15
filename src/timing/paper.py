"""论文式加工仓任务池启发式。

复现《基于 JIT 精益生产的半导体设备调度系统设计》第 4~6 节可由论文正文确定的流程：
  1. 以 ``(wid, process_stage)`` 建立加工仓任务；
  2. 由晶圆顺序、工序顺序生成贪心任务池；
  3. 对多 route 使用顺序、整体交叉和分组交叉构造初始顺序；
  4. 将加工端顺序编码为 ``LoadLock → PM`` hop 偏置，由 Banker 解码生成机械臂任务池；
  5. 在墙钟预算内用块插入/交换继续优化，并由 ``solve_timing`` 精确验证 JIT 和资源约束。

论文的 MIP1/MIP2 没有公开源码和完整实现参数，本模块复现其任务池初始化与两级定序思想，
使用项目现有差分约束定时器替代 Gurobi 两阶段模型，不声称逐变量复现论文 MIP。
"""

from __future__ import annotations

import random
import time
from typing import Dict, List, Optional, Sequence, Tuple

from src.milp import SolveResult
from src.model import Durations, Problem

from ._common import EPS, _DecodeDeadlock
from .sequencing import decode_orders
from .solve import solve_timing


_PROCESS_SPACINGS = (2.0, 5.0, 10.0, 20.0, 40.0)
_GROUP_SIZES = (1, 2, 3, 4, 5)
_NO_SWAP_PERIOD = 8
_MAX_BLOCK_SIZE = 5
_REPAIR_LOW = 0.7
_REPAIR_HIGH = 1.3
_PORTFOLIO_FRACTION = 0.70
_MAX_PORTFOLIO_SECONDS = 5.0
_LARGE_TASK_THRESHOLD = 25

Hop = Tuple[int, int]  # (wid, source_stage)，目标 stage 是 process


def _process_entry_hops(wafers) -> List[Hop]:
    """返回全部进入加工仓的 hop，按论文贪心键 ``(晶圆序号, 工序序号)`` 排序。"""
    hops = []
    for wafer in wafers:
        for source_stage in range(len(wafer.stages) - 1):
            if wafer.stages[source_stage + 1].stage_type == "process":
                hops.append((wafer.wid, source_stage))
    return sorted(hops, key=lambda hop: (hop[0], hop[1]))


def _route_hops(wafers, hops: Sequence[Hop]) -> Dict[str, List[Hop]]:
    """按 route 拆分加工仓任务，route 内维持晶圆编号和工序编号升序。"""
    route_by_wid = {wafer.wid: wafer.route_name for wafer in wafers}
    grouped: Dict[str, List[Hop]] = {}
    for hop in hops:
        grouped.setdefault(route_by_wid[hop[0]], []).append(hop)
    return grouped


def _cross_routes(grouped: Dict[str, List[Hop]], group_size: int,
                  route_order: Sequence[str]) -> List[Hop]:
    """按论文的分组交叉生成加工任务序；group_size=1 退化为整体逐项交叉。"""
    offsets = {route: 0 for route in route_order}
    result: List[Hop] = []
    remaining = sum(len(grouped[route]) for route in route_order)
    while remaining:
        for route in route_order:
            start = offsets[route]
            end = min(start + group_size, len(grouped[route]))
            if end <= start:
                continue
            result.extend(grouped[route][start:end])
            offsets[route] = end
            remaining -= end - start
    return result


def _initial_sequences(wafers) -> List[List[Hop]]:
    """构造论文式初始任务池：贪心序、route 顺序序以及多种分组/整体交叉序。"""
    greedy = _process_entry_hops(wafers)
    grouped = _route_hops(wafers, greedy)
    routes = sorted(grouped)
    candidates: List[List[Hop]] = []
    if len(routes) <= 1:
        return [greedy]

    for route_order in (routes, list(reversed(routes))):
        for group_size in _GROUP_SIZES:
            candidates.append(_cross_routes(grouped, group_size, route_order))
        candidates.append([hop for route in route_order for hop in grouped[route]])
    candidates.append(greedy)

    unique: List[List[Hop]] = []
    seen = set()
    for sequence in candidates:
        signature = tuple(sequence)
        if signature not in seen:
            seen.add(signature)
            unique.append(sequence)
    return unique


def _sequence_priorities(sequence: Sequence[Hop], spacing: float) -> Dict[Hop, float]:
    """把加工任务池顺序绑定到 PM 进入和离开 hop；不改变 source 发片 FIFO。

    ``sequence`` 中的 hop 指向 process stage。论文的加工仓任务同时约束晶圆进入、占用和离开 PM，
    因此相同任务秩也写到紧随其后的 ``PM → downstream`` hop，近似 MIP1 输出的机械臂任务池顺序。
    """
    priorities: Dict[Hop, float] = {}
    release_rank = 0
    released = set()
    for rank, (wid, entry_source) in enumerate(sequence):
        bias = rank * spacing
        if wid not in released:
            # 论文 4.1 的出片序服务于后续加工仓任务池；只取每片首次加工任务的相对次序。
            priorities[(wid, 0)] = release_rank * spacing
            released.add(wid)
            release_rank += 1
        priorities[(wid, entry_source)] = bias
        priorities[(wid, entry_source + 1)] = bias
    return priorities


def _evaluate(ir: Problem, durations: Durations, wafers, sequence: Sequence[Hop],
              spacing: float, swap: bool) -> Tuple[Optional[SolveResult], Dict[Hop, float]]:
    """解码并精确定时一个加工任务序，返回结果和可供驻留修复的偏置表。"""
    priorities = _sequence_priorities(sequence, spacing)
    try:
        orders = decode_orders(ir, durations, wafers, prio=priorities, swap=swap)
    except (RuntimeError, _DecodeDeadlock):
        return None, priorities
    return solve_timing(ir, wafers, orders=orders), priorities


def _evaluate_priorities(ir: Problem, durations: Durations, wafers,
                         priorities: Dict[Hop, float], swap: bool) -> Optional[SolveResult]:
    """评估驻留修复后的 hop 偏置表。"""
    try:
        orders = decode_orders(ir, durations, wafers, prio=priorities, swap=swap)
    except (RuntimeError, _DecodeDeadlock):
        return None
    return solve_timing(ir, wafers, orders=orders)


def _repair_residency(priorities: Dict[Hop, float], result: SolveResult,
                      rng: random.Random) -> bool:
    """根据精确定时诊断提前 ``PM → 下游`` hop，修复论文 JIT 驻留约束。"""
    violations = getattr(result, "residency_violations", [])
    if not violations:
        return False
    for wid, stage, _chamber, hold, limit in violations:
        hop = (wid, stage)
        excess = max(hold - limit, 1.0)
        priorities[hop] = priorities.get(hop, 0.0) - excess * rng.uniform(
            _REPAIR_LOW, _REPAIR_HIGH)
    return True


def _mutate_sequence(sequence: Sequence[Hop], rng: random.Random) -> List[Hop]:
    """在加工任务池上执行相邻交换、单任务插入或连续块插入邻域。"""
    candidate = list(sequence)
    if len(candidate) < 2:
        return candidate
    move = rng.randrange(3)
    if move == 0:
        index = rng.randrange(len(candidate) - 1)
        candidate[index], candidate[index + 1] = candidate[index + 1], candidate[index]
        return candidate
    if move == 1:
        source = rng.randrange(len(candidate))
        task = candidate.pop(source)
        candidate.insert(rng.randrange(len(candidate) + 1), task)
        return candidate

    block_size = rng.randint(2, min(_MAX_BLOCK_SIZE, len(candidate)))
    source = rng.randrange(len(candidate) - block_size + 1)
    block = candidate[source:source + block_size]
    del candidate[source:source + block_size]
    target = rng.randrange(len(candidate) + 1)
    candidate[target:target] = block
    return candidate


def _take_best(best: Optional[SolveResult], candidate: Optional[SolveResult]) -> Optional[SolveResult]:
    """取两个结果中 makespan 更小的可行解。"""
    if candidate is None or not getattr(candidate, "feasible", False):
        return best
    if best is None or not getattr(best, "feasible", False):
        return candidate
    return candidate if candidate.makespan < best.makespan - EPS else best


def paper_task_pool_search(ir: Problem, durations: Durations, wafers,
                           base: Optional[SolveResult], *, seconds: float,
                           seed: int, verbose: bool) -> Optional[SolveResult]:
    """运行论文式加工仓任务池初始化和限时局部搜索。

    参数：
      · base：原启发式可行性地板，搜索结果保证单调不劣；
      · seconds：本搜索阶段的墙钟预算；
      · seed：初始序遍历和邻域扰动随机种子；
      · verbose：是否打印候选数、改进次数和最终 makespan。
    """
    if seconds <= 0:
        return base
    initial_sequences = _initial_sequences(wafers)
    if not initial_sequences or not initial_sequences[0]:
        return base

    rng = random.Random(seed)
    search_start = time.perf_counter()
    deadline = search_start + seconds
    portfolio_seconds = (seconds if seconds <= 1.0 else min(
        _MAX_PORTFOLIO_SECONDS, seconds * _PORTFOLIO_FRACTION))
    portfolio_deadline = search_start + portfolio_seconds
    best = base
    best_sequence = initial_sequences[0]
    trials = 0
    improvements = 0

    # 论文任务池初始化 portfolio：顺序、整体交叉、分组交叉 × 多个优先级时间尺度。
    swap_modes = (True,) if len(initial_sequences[0]) >= _LARGE_TASK_THRESHOLD else (True, False)
    primary = [(sequence, 5.0, True) for sequence in initial_sequences]
    primary_signatures = {(tuple(sequence), spacing, swap)
                          for sequence, spacing, swap in primary}
    secondary = [(sequence, spacing, swap)
                 for sequence in initial_sequences
                 for spacing in _PROCESS_SPACINGS
                 for swap in swap_modes
                 if (tuple(sequence), spacing, swap) not in primary_signatures]
    rng.shuffle(secondary)
    portfolio = primary + secondary
    for sequence, spacing, swap in portfolio:
        if time.perf_counter() >= portfolio_deadline:
            break
        result, priorities = _evaluate(ir, durations, wafers, sequence, spacing, swap)
        trials += 1
        if result is not None and getattr(result, "feasible", False):
            previous = best
            best = _take_best(best, result)
            if best is result and best is not previous:
                best_sequence = list(sequence)
                improvements += 1
        elif result is not None and _repair_residency(priorities, result, rng):
            repaired = _evaluate_priorities(ir, durations, wafers, priorities, swap)
            trials += 1
            if repaired is not None and getattr(repaired, "feasible", False):
                previous = best
                best = _take_best(best, repaired)
                if best is repaired and best is not previous:
                    best_sequence = list(sequence)
                    improvements += 1

    # 剩余预算只在加工端顺序上搜索，不枚举 25~75 片的全排列。
    current_sequence = list(best_sequence)
    while time.perf_counter() < deadline:
        candidate_sequence = _mutate_sequence(current_sequence, rng)
        spacing = rng.choice(_PROCESS_SPACINGS)
        swap = (trials % _NO_SWAP_PERIOD) != 0
        result, priorities = _evaluate(
            ir, durations, wafers, candidate_sequence, spacing, swap)
        trials += 1
        if result is not None and getattr(result, "feasible", False):
            previous = best
            best = _take_best(best, result)
            if best is result and best is not previous:
                current_sequence = candidate_sequence
                best_sequence = candidate_sequence
                improvements += 1
        elif result is not None and _repair_residency(priorities, result, rng):
            if time.perf_counter() >= deadline:
                break
            repaired = _evaluate_priorities(ir, durations, wafers, priorities, swap)
            trials += 1
            if repaired is not None and getattr(repaired, "feasible", False):
                previous = best
                best = _take_best(best, repaired)
                if best is repaired and best is not previous:
                    current_sequence = candidate_sequence
                    best_sequence = candidate_sequence
                    improvements += 1

    if verbose:
        makespan = (best.makespan if best is not None and getattr(best, "feasible", False)
                    else float("nan"))
        print(f"[timing] 论文任务池搜索 {seconds:.2f}s：评估 {trials} 个候选，"
              f"改进 {improvements} 次 → makespan={makespan:.2f}")
    return best
