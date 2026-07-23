"""L2D checkpoint 在固定 PSE300 场景上的评测入口。

评测报告模型相对默认 timing 启发式的 makespan、gap 和推理耗时，并对模型结果执行
``check_solution`` 与 MoveList 状态回放。单 Job 固定覆盖 5/25 片；双 Job 固定覆盖 1+3、
2+2 PM 分区形状。
"""

from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from src.export.export import check_solution, export_movelist
from src.parse.model import Durations, Problem
from src.schedule.sequencing import decode_orders
from src.timing.solve import solve_timing
from src.validation import validate_move_list

from .api import load_l2d_policy, start_schedule_l2d
from .problems import (
    load_pse300_topology,
    sample_one_job_problem,
    sample_two_job_problem,
)


def _two_job_case_with_partition_shape(
    topology: Dict[str, Any],
    rng: random.Random,
    shape: Tuple[int, int],
) -> Problem:
    """重复确定性采样，直到得到指定的有标签 PM 分区大小。"""
    maximum_attempts = 1000
    for _attempt in range(maximum_attempts):
        problem = sample_two_job_problem(topology, rng)
        partition = problem._l2d_generation["pm_partition"]  # type: ignore[attr-defined]
        if tuple(len(pool) for pool in partition) == shape:
            return problem
    raise RuntimeError(f"在 {maximum_attempts} 次采样内未得到 PM 分区形状 {shape}")


def _validation_cases(
    phase: str,
    topology: Dict[str, Any],
    rng: random.Random,
) -> List[Tuple[str, Problem]]:
    """构造与训练阶段匹配的固定规模验证集。"""
    if phase == "two-job":
        return [
            ("two-job-1+3", _two_job_case_with_partition_shape(topology, rng, (1, 3))),
            ("two-job-2+2", _two_job_case_with_partition_shape(topology, rng, (2, 2))),
        ]
    cases = [
        (
            f"one-job-1stage-{chamber_count}ch-12w",
            sample_one_job_problem(
                topology,
                rng,
                wafer_count=12,
                candidate_pool_sizes=(chamber_count,),
                process_range=(120, 120),
            ),
        )
        for chamber_count in range(1, 5)
    ]
    cases.extend([
        ("one-job-5", sample_one_job_problem(topology, rng, wafer_count=5)),
        ("one-job-25", sample_one_job_problem(topology, rng, wafer_count=25)),
    ])
    return cases


def evaluate_checkpoint(
    checkpoint: Path,
    *,
    device: str = "cpu",
    seed: int = 2026,
) -> List[Dict[str, Any]]:
    """评测 checkpoint，并返回每个验证场景的结构化指标。"""
    policy = load_l2d_policy(checkpoint, device=device)
    metadata = getattr(policy, "checkpoint_metadata", {})
    phase = str(metadata.get("training_phase") or "one-job")
    topology = load_pse300_topology()
    rng = random.Random(seed)
    reports: List[Dict[str, Any]] = []

    for case_name, problem in _validation_cases(phase, topology, rng):
        durations = Durations(problem)
        baseline_started = time.perf_counter()
        baseline_orders = decode_orders(problem, durations, problem.wafers)
        baseline = solve_timing(problem, problem.wafers, baseline_orders)
        baseline_runtime = time.perf_counter() - baseline_started

        model = start_schedule_l2d(problem, policy)
        solution_issues = check_solution(problem, model)
        move_list = export_movelist(problem, model)
        move_issues = validate_move_list(problem, move_list)
        gap = (
            100.0 * (model.makespan - baseline.makespan) / baseline.makespan
            if baseline.makespan > 0.0
            else 0.0
        )
        report = {
            "case": case_name,
            "generation": getattr(problem, "_l2d_generation", {}),
            "l2d_makespan": model.makespan,
            "heuristic_makespan": baseline.makespan,
            "gap_percent": gap,
            "l2d_runtime_seconds": model.l2d_inference_runtime,  # type: ignore[attr-defined]
            "heuristic_runtime_seconds": baseline_runtime,
            "decision_count": len(model.l2d_decisions),  # type: ignore[attr-defined]
            "feasible": bool(getattr(model, "feasible", False)),
            "solution_issues": solution_issues,
            "move_list_issues": move_issues,
        }
        reports.append(report)
        print(
            f"{case_name}: L2D={model.makespan:.2f}s heuristic={baseline.makespan:.2f}s "
            f"gap={gap:+.2f}% runtime={model.l2d_inference_runtime:.4f}s "  # type: ignore[attr-defined]
            f"valid={not solution_issues and not move_issues}"
        )
    return reports


def _argument_parser() -> argparse.ArgumentParser:
    """创建评测 CLI 参数解析器。"""
    parser = argparse.ArgumentParser(description="评测 PSE300 L2D checkpoint")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--output", type=Path, help="可选 JSON 报告路径")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> None:
    """运行固定验证集并按需写出 JSON 报告。"""
    args = _argument_parser().parse_args(argv)
    reports = evaluate_checkpoint(args.checkpoint, device=args.device, seed=args.seed)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"评测报告已保存：{args.output}")


if __name__ == "__main__":
    main()
