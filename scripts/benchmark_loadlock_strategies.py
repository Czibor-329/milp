"""在 PSE300 双槽 LoadLock 场景上比较交换模式与群控策略。

脚本构造单路线与高低速混流场景，统一调用生产调度入口，并记录 makespan、
同门 place→pick 交换次数、最终选中路径和完整约束复核结果。输出 JSON 可供后续
绘图或论文表格使用；不依赖测试模块。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from realtime_scheduler.plan_builder import BuildState, build_round_update
from src.export import check_solution, export_movelist
from src.parse import parse_task
from src.parse.model import Durations, Problem
from src.schedule.api import start_schedule
from src.validation import validate_move_list


PSE300_PATH = ROOT / "src" / "input_data" / "PSE300.json"
DEFAULT_OUTPUT = ROOT / "results" / "loadlock_strategy_benchmark.json"
MANAGER_MODES = (
    "fixed",
    "petri-eta",
    "collective-look",
    "round-robin",
    "dedicated-direction",
    "exchange-look",
)
EXCHANGE_MODES = ("disabled", "enabled")
TIME_TOLERANCE = 1e-4


def _route(name: str, modules: str, recipe: str) -> dict:
    """创建一条 LP→LoadLock→PM→LoadLock→LP 的完整路线。"""
    return {
        "name": name,
        "group": name,
        "bufferOption": 0,
        "prePJobCleanRefs": [],
        "postPJobCleanRefs": [],
        "postCJobCleanRefs": [],
        "stages": [
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": modules, "recipeRef": recipe, "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
        ],
    }


def _job(name: str, route: str, load_port: str, wafer_count: int) -> dict:
    """创建一个使用指定路线和 LoadPort 的普通批次。"""
    return {
        "name": name,
        "routeRef": route,
        "loadPort": load_port,
        "waferCount": wafer_count,
        "priority": 1,
        "weight": 1,
        "jobType": 0,
        "taskMode": 0,
        "foupId": name,
    }


def _scenarios() -> List[dict]:
    """返回覆盖快工艺、慢工艺和高低速混流的基准场景。"""
    return [
        {
            "name": "single-fast-12",
            "recipes": [
                {
                    "name": "FastRecipe",
                    "time": 20,
                    "modules": ["PM1", "PM2"],
                    "weight": {},
                }
            ],
            "routes": [_route("FastRoute", "PM1,PM2", "FastRecipe")],
            "jobs": [_job("FastLot", "FastRoute", "LP1", 12)],
        },
        {
            "name": "single-slow-12",
            "recipes": [
                {
                    "name": "SlowRecipe",
                    "time": 70,
                    "modules": ["PM1", "PM2"],
                    "weight": {},
                }
            ],
            "routes": [_route("SlowRoute", "PM1,PM2", "SlowRecipe")],
            "jobs": [_job("SlowLot", "SlowRoute", "LP1", 12)],
        },
        {
            "name": "mixed-fast-slow-8x8",
            "recipes": [
                {
                    "name": "FastRecipe",
                    "time": 20,
                    "modules": ["PM1", "PM2"],
                    "weight": {},
                },
                {
                    "name": "SlowRecipe",
                    "time": 70,
                    "modules": ["PM3", "PM4"],
                    "weight": {},
                },
            ],
            "routes": [
                _route("FastRoute", "PM1,PM2", "FastRecipe"),
                _route("SlowRoute", "PM3,PM4", "SlowRecipe"),
            ],
            "jobs": [
                _job("FastLot", "FastRoute", "LP1", 8),
                _job("SlowLot", "SlowRoute", "LP2", 8),
            ],
        },
    ]


def _build_problem(device: Mapping[str, Any], scenario: Mapping[str, Any]) -> Problem:
    """把一个轻量场景展开为生产调度器使用的 Problem。"""
    plan = {
        "device": device,
        "recipes": scenario["recipes"],
        "cleans": [],
        "routes": scenario["routes"],
    }
    update = build_round_update(
        plan,
        {"currentTime": 0, "jobs": scenario["jobs"]},
        0.0,
        BuildState(),
    )
    return parse_task(device, update)


def _same_door_exchange_count(problem: Problem, result: Any) -> int:
    """按 MoveList 门合并的同一判据统计 place→pick 交换对。"""
    wafer_map = {wafer.wid: wafer for wafer in problem.wafers}
    visits = []
    for wafer_id, rows in result.schedule.items():
        for stage_index, (stage_type, chamber, available, release) in enumerate(rows):
            if stage_type != "loadlock":
                continue
            stage = wafer_map[wafer_id].stages[stage_index]
            visits.append(
                (
                    chamber,
                    stage.ll_type,
                    stage.in_robot,
                    stage.out_robot,
                    float(available),
                    float(release),
                )
            )
    durations = Durations(problem)
    return sum(
        placed is not picked
        and placed[0] == picked[0]
        and placed[1] != picked[1]
        and bool(placed[2])
        and placed[2] == picked[3]
        and abs(picked[5] - (placed[4] + durations.move(placed[2])))
        <= TIME_TOLERANCE
        for placed in visits
        for picked in visits
    )


def run_benchmark(
    device: Mapping[str, Any],
    scenarios: Iterable[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """运行全部“交换模式 × manager”组合并返回逐场景明细。"""
    rows: List[Dict[str, Any]] = []
    for scenario in scenarios:
        scenario_rows: List[Dict[str, Any]] = []
        for exchange_mode in EXCHANGE_MODES:
            for manager_mode in MANAGER_MODES:
                problem = _build_problem(device, scenario)
                started = time.perf_counter()
                result = start_schedule(
                    problem,
                    verbose=False,
                    loadlock_manager=(
                        None if manager_mode == "fixed" else manager_mode
                    ),
                    loadlock_exchange=exchange_mode,
                )
                elapsed_ms = (time.perf_counter() - started) * 1000.0
                moves = export_movelist(problem, result)
                issues = [
                    *check_solution(problem, result),
                    *validate_move_list(problem, moves),
                ]
                scenario_rows.append(
                    {
                        "scenario": scenario["name"],
                        "exchangeMode": exchange_mode,
                        "manager": manager_mode,
                        "makespan": float(result.makespan),
                        "sameDoorExchanges": _same_door_exchange_count(
                            problem,
                            result,
                        ),
                        "selectedManagerPath": result.loadlock_manager_selected,
                        "selectedExchangePath": result.loadlock_exchange_selected,
                        "elapsedMs": elapsed_ms,
                        "moveCount": len(moves),
                        "feasible": bool(result.feasible),
                        "validationIssues": issues,
                    }
                )
        baseline = next(
            row
            for row in scenario_rows
            if row["exchangeMode"] == "disabled" and row["manager"] == "fixed"
        )
        for row in scenario_rows:
            row["makespanDeltaVsLegacy"] = (
                row["makespan"] - baseline["makespan"]
            )
            row["improvementPercentVsLegacy"] = (
                (baseline["makespan"] - row["makespan"])
                / baseline["makespan"]
                * 100.0
            )
        rows.extend(scenario_rows)
    return rows


def _print_summary(rows: Iterable[Mapping[str, Any]]) -> None:
    """打印每个场景各组合的紧凑 Markdown 表。"""
    print(
        "| 场景 | 交换 | manager | makespan | 改善 | 同门交换 | 选中路径 |"
    )
    print("|---|---|---|---:|---:|---:|---|")
    for row in rows:
        print(
            f"| {row['scenario']} | {row['exchangeMode']} | {row['manager']} "
            f"| {row['makespan']:.2f} "
            f"| {row['improvementPercentVsLegacy']:.2f}% "
            f"| {row['sameDoorExchanges']} "
            f"| {row['selectedManagerPath']} |"
        )


def main() -> None:
    """解析命令行、运行基准并保存结构化结果。"""
    parser = argparse.ArgumentParser(
        description="比较 PSE300 LoadLock 交换模式与群控策略",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="JSON 输出路径",
    )
    arguments = parser.parse_args()
    device = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
    rows = run_benchmark(device, _scenarios())
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    _print_summary(rows)
    print(f"\n已写入 {arguments.output}")


if __name__ == "__main__":
    main()
