"""PSE300 的 L2D 训练实例生成与加工腔配置枚举。

本模块只负责生成固定机器的 ``Problem``：加工候选池按前缀构造，解析器再从合法的
严格递增 PM 路径中 round-robin 选择实际腔室。模型因此只学习操作顺序，不承担选腔。
第一阶段生成单 Job，第二阶段生成拥有互斥 PM 分区的双 Job。
"""

from __future__ import annotations

import hashlib
import json
import random
from itertools import product
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from src.parse.generator import (
    PROC_MAX,
    PROC_MIN,
    JobSpec,
    build_concurrent_update,
    build_update_params,
    job_process_recipes,
)
from src.parse.model import Problem
from src.parse import PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN, parse_task


PM_ORDER: Tuple[str, ...] = ("PM1", "PM2", "PM3", "PM4")
ONE_JOB_WAFER_RANGE = (5, 25)
TWO_JOB_WAFER_RANGE = (4, 12)
TWO_JOB_WAFER_PATTERNS: Tuple[Tuple[int, int], ...] = ((4, 8), (6, 6), (8, 4))
PSE300_TOPOLOGY_PATH = Path(__file__).resolve().parents[2] / "input_data" / "PSE300.json"


def prefix_candidate_pools(pm_pool: Sequence[str]) -> Tuple[Tuple[str, ...], ...]:
    """返回给定有序 PM 集合的所有非空前缀候选池。"""
    ordered_pool = tuple(pm_pool)
    return tuple(ordered_pool[:size] for size in range(1, len(ordered_pool) + 1))


def enumerate_increasing_paths(
    stage_pools: Sequence[Sequence[str]],
    pm_order: Sequence[str] = PM_ORDER,
) -> List[Tuple[str, ...]]:
    """枚举候选池笛卡尔积中 PM 不重复且按固定顺序严格递增的实际路径。"""
    order_index = {pm: index for index, pm in enumerate(pm_order)}
    unknown = sorted({pm for pool in stage_pools for pm in pool if pm not in order_index})
    if unknown:
        raise ValueError(f"候选池包含未出现在固定顺序中的 PM：{unknown}")
    return [
        tuple(path)
        for path in product(*stage_pools)
        if all(order_index[left] < order_index[right] for left, right in zip(path, path[1:]))
    ]


def candidate_pool_configurations(
    stage_count: int,
    pm_pool: Sequence[str] = PM_ORDER,
) -> List[Tuple[Tuple[str, ...], ...]]:
    """生成指定工序数的前缀候选池配置，并过滤不存在合法实际 PM 路径的配置。

    一道工序在 PSE300 全 PM 集合上恰好返回四种前缀；多道工序对每道工序独立选择
    前缀，即形成笛卡尔积。只要至少存在一条严格递增实际路径，配置就会保留。
    """
    if stage_count < 1 or stage_count > min(3, len(pm_pool)):
        raise ValueError("stage_count 必须在 1..min(3, PM数量) 范围内")
    prefixes = prefix_candidate_pools(pm_pool)
    return [
        tuple(tuple(pool) for pool in configuration)
        for configuration in product(prefixes, repeat=stage_count)
        if enumerate_increasing_paths(configuration, pm_pool)
    ]


def random_labeled_pm_partition(
    rng: random.Random,
    pm_order: Sequence[str] = PM_ORDER,
) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
    """随机生成两个有标签、非空、不重叠且并集完整的 PM 分区。"""
    ordered_pool = tuple(pm_order)
    if len(ordered_pool) < 2:
        raise ValueError("双 Job PM 分区至少需要两个 PM")
    maximum_mask = (1 << len(ordered_pool)) - 1
    first_mask = rng.randint(1, maximum_mask - 1)
    first = tuple(pm for index, pm in enumerate(ordered_pool) if first_mask & (1 << index))
    second = tuple(pm for index, pm in enumerate(ordered_pool) if not first_mask & (1 << index))
    return first, second


def load_pse300_topology(path: Optional[Path] = None) -> Dict[str, Any]:
    """读取 PSE300 原始拓扑 JSON；返回可由 ``parse_task`` 消费的字典。"""
    topology_path = path or PSE300_TOPOLOGY_PATH
    with topology_path.open(encoding="utf-8") as topology_file:
        topology = json.load(topology_file)
    if not isinstance(topology, dict) or "Robots" not in topology or "Stations" not in topology:
        raise ValueError(f"{topology_path} 不是有效的 PSE300 拓扑")
    return topology


def topology_digest(topology: Mapping[str, Any]) -> str:
    """计算稳定的拓扑 SHA-256 摘要，供 checkpoint 兼容性记录。"""
    encoded = json.dumps(topology, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _configured_job(
    index: int,
    rng: random.Random,
    pm_pool: Sequence[str],
    stage_count: int,
    wafer_count: int,
    process_range: Tuple[int, int],
) -> JobSpec:
    """构造一个无清洗 Job，并把随机工序候选池替换为 L2D 前缀配置。"""
    configurations = candidate_pool_configurations(stage_count, pm_pool)
    if not configurations:
        raise ValueError(f"PM集合 {list(pm_pool)} 无法生成 {stage_count} 道工序")
    configuration = rng.choice(configurations)
    job = JobSpec(
        index,
        rng,
        pm_pool=pm_pool,
        stage_range=(stage_count, stage_count),
        clean=False,
        proc_range=process_range,
        residency=-1,
    )
    job.stages = [list(pool) for pool in configuration]
    job.proc_times = [rng.randint(*process_range) for _ in range(stage_count)]
    job.n_wafer = int(wafer_count)
    job.priority = 1
    return job


def sample_one_job_problem(
    topology: Mapping[str, Any],
    rng: random.Random,
    *,
    wafer_count: Optional[int] = None,
    stage_count: Optional[int] = None,
    candidate_pool_sizes: Optional[Sequence[int]] = None,
    process_range: Tuple[int, int] = (PROC_MIN, PROC_MAX),
) -> Problem:
    """生成第一阶段的单 Job PSE300 Problem。

    默认在 5–25 片和 1–3 道工序间采样；实际 PM 由解析器按合法递增路径轮询固定，
    LA/LB 继续沿用按晶圆 rank 的轮询分配。
    """
    selected_wafer_count = wafer_count or rng.randint(*ONE_JOB_WAFER_RANGE)
    if candidate_pool_sizes is not None:
        selected_stage_count = len(candidate_pool_sizes)
        if stage_count is not None and stage_count != selected_stage_count:
            raise ValueError("stage_count 与 candidate_pool_sizes 长度不一致")
        if not 1 <= selected_stage_count <= 3:
            raise ValueError("candidate_pool_sizes 必须描述 1–3 道工序")
        if any(size < 1 or size > len(PM_ORDER) for size in candidate_pool_sizes):
            raise ValueError("每道工序的候选腔数量必须在 1–4 之间")
        selected_configuration = tuple(
            tuple(PM_ORDER[:size]) for size in candidate_pool_sizes
        )
        if not enumerate_increasing_paths(selected_configuration):
            raise ValueError(f"候选腔数量配置 {list(candidate_pool_sizes)} 没有合法递增 PM 路径")
    else:
        selected_stage_count = stage_count or rng.randint(1, 3)
        selected_configuration = None
    job = _configured_job(
        0,
        rng,
        PM_ORDER,
        selected_stage_count,
        selected_wafer_count,
        process_range,
    )
    if selected_configuration is not None:
        job.stages = [list(pool) for pool in selected_configuration]
    recipes = job_process_recipes(job, 1)
    update_params, _ = build_update_params(
        job,
        key=1,
        priority=1,
        lp="LP1",
        mat_id_start=0,
        current_time=0.0,
        process_recipes=recipes,
    )
    problem = parse_task(
        topology,
        update_params,
        process_assignment=PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN,
        process_pm_order=PM_ORDER,
    )
    problem._l2d_generation = {  # type: ignore[attr-defined]
        "phase": "one-job",
        "pm_partition": [list(PM_ORDER)],
        "stage_counts": [selected_stage_count],
        "wafer_counts": [selected_wafer_count],
        "candidate_pools": [[list(pool) for pool in job.stages]],
    }
    return problem


def sample_two_job_problem(
    topology: Mapping[str, Any],
    rng: random.Random,
    *,
    wafer_counts: Optional[Tuple[int, int]] = None,
    process_range: Tuple[int, int] = (PROC_MIN, PROC_MAX),
) -> Problem:
    """生成第二阶段的双 Job PSE300 Problem。

    两个 Job 使用随机有标签 PM 分区和不同 LoadPort，工序数不超过各自 PM 数量；默认
    从 4:8、6:6、8:4 中采样片数比例，覆盖平衡与不平衡负载。
    """
    first_pool, second_pool = random_labeled_pm_partition(rng)
    if wafer_counts is not None:
        selected_counts = wafer_counts
    elif rng.random() < 0.5:
        selected_counts = rng.choice(TWO_JOB_WAFER_PATTERNS)
    else:
        selected_counts = (
            rng.randint(*TWO_JOB_WAFER_RANGE),
            rng.randint(*TWO_JOB_WAFER_RANGE),
        )
    if any(count < TWO_JOB_WAFER_RANGE[0] or count > TWO_JOB_WAFER_RANGE[1]
           for count in selected_counts):
        raise ValueError(f"双 Job 每个 Job 的晶圆数必须在 {TWO_JOB_WAFER_RANGE} 内")

    pools = (first_pool, second_pool)
    jobs: List[JobSpec] = []
    stage_counts: List[int] = []
    for index, (pool, count) in enumerate(zip(pools, selected_counts)):
        stage_count = rng.randint(1, min(3, len(pool)))
        stage_counts.append(stage_count)
        jobs.append(
            _configured_job(index, rng, pool, stage_count, count, process_range)
        )
    update_params = build_concurrent_update(jobs, rng, lps=("LP1", "LP2"), n_levels=1)
    problem = parse_task(
        topology,
        update_params,
        process_assignment=PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN,
        process_pm_order=PM_ORDER,
    )
    problem._l2d_generation = {  # type: ignore[attr-defined]
        "phase": "two-job",
        "pm_partition": [list(first_pool), list(second_pool)],
        "stage_counts": stage_counts,
        "wafer_counts": list(selected_counts),
        "candidate_pools": [
            [list(stage_pool) for stage_pool in job.stages] for job in jobs
        ],
    }
    return problem
