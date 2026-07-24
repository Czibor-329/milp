"""复现六腔共享路线与三条双腔路线的严格质量 A/B。

除每个 PJob 引用的加工腔集合外，两组使用相同设备、三个 LoadPort、三个 CJob、
晶圆数量、优先级和加工时间。默认每个 Job 25 片、加工 300 秒。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Mapping
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from unittest.mock import patch

import realtime_scheduler.server as scheduler_server
from src.parse.generator import PM_POOL_6, expand_topo_pms
import src.schedule.neural as neural_scheduler
from src.schedule.neural import DEFAULT_MODEL_PATH, load_neural_policy


DEVICE_PATH = ROOT / "src" / "input_data" / "PSE300.json"
PAIR_POOLS = ("PM1,PM2", "PM3,PM4", "PM5,PM6")


def _route(name: str, modules: str, recipe: str) -> Dict[str, Any]:
    """创建 LP—双 LoadLock—PM—双 LoadLock—LP 的单工序路线。"""
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


def six_pm_device() -> Dict[str, Any]:
    """从正式 PSE300 克隆同构 PM5/PM6，并补齐 VTR 访问与搬运时间。"""
    device = json.loads(DEVICE_PATH.read_text(encoding="utf-8"))
    return expand_topo_pms(device, PM_POOL_6)


def build_plan(
    strategy: str,
    *,
    split: bool,
    wafer_count: int = 25,
    process_seconds: float = 300.0,
) -> Dict[str, Any]:
    """构造 reference 或拆分组；两者只改变加工腔候选集合。"""
    recipes = []
    routes = []
    if split:
        route_refs = []
        for index, modules in enumerate(PAIR_POOLS, start=1):
            name = f"Pair{index}"
            route_refs.append(name)
            recipes.append({
                "name": name,
                "time": process_seconds,
                "modules": modules.split(","),
                "weight": {},
            })
            routes.append(_route(name, modules, name))
    else:
        route_refs = ["FullSix"] * 3
        recipes.append({
            "name": "FullSix",
            "time": process_seconds,
            "modules": list(PM_POOL_6),
            "weight": {},
        })
        routes.append(_route("FullSix", ",".join(PM_POOL_6), "FullSix"))

    cjobs = []
    for index, (load_port, route_ref) in enumerate(
        zip(("LP1", "LP2", "LP3"), route_refs),
        start=1,
    ):
        cjobs.append({
            "taskId": str(index),
            "jobType": "NormalLot",
            "priority": 1,
            "taskMode": "Smart",
            "pjobs": [{
                "jobName": "P1",
                "routeRef": route_ref,
                "loadPort": load_port,
                "waferCount": wafer_count,
                "priority": 1,
            }],
        })
    return {
        "deviceName": "PSE300-six-PM-route-decomposition",
        "device": six_pm_device(),
        "strategy": strategy,
        "roundCount": 1,
        "options": {},
        "recipes": recipes,
        "cleans": [],
        "routes": routes,
        "rounds": [{"currentTime": 0, "cjobs": cjobs}],
    }


def summarize_result(
    label: str,
    result: Mapping[str, Any],
    wall_seconds: float,
) -> Dict[str, Any]:
    """提取 makespan、PM 均衡、Job 完工和神经来源等验收指标。"""
    process_moves = [
        move
        for move in result["output"]["MoveList"]
        if move.get("MoveType") == 9
        and str(move.get("ModuleName") or "").startswith("PM")
    ]
    pm_counts = Counter(str(move["ModuleName"]) for move in process_moves)
    pm_busy = defaultdict(float)
    job_ends = defaultdict(float)
    for move in process_moves:
        module = str(move["ModuleName"])
        pm_busy[module] += float(move["EndTime"]) - float(move["StartTime"])
        for job_name in move.get("PJobName") or []:
            job_ends[str(job_name)] = max(
                job_ends[str(job_name)],
                float(move["EndTime"]),
            )
    diagnostics = result["rounds"][0].get("strategyDiagnostics") or {}
    makespan = float(result["makespan"])
    return {
        "label": label,
        "makespanSeconds": round(makespan, 3),
        "wallSeconds": round(wall_seconds, 3),
        "validation": result["validation"],
        "moveCount": int(result["moveCount"]),
        "pmCounts": dict(sorted(pm_counts.items())),
        "aggregatePmUtilization": round(
            sum(pm_busy.values()) / max(makespan * len(PM_POOL_6), 1.0),
            6,
        ),
        "jobProcessEnd": {
            name: round(value, 3)
            for name, value in sorted(job_ends.items())
        },
        "selectedSource": diagnostics.get("selectedSource"),
        "inductiveBias": diagnostics.get("inductiveBias"),
        "wavefrontFamilies": diagnostics.get("wavefrontFamilies", 0),
    }


def run_benchmark(
    *,
    wafer_count: int = 25,
    process_seconds: float = 300.0,
    model_path: Path = DEFAULT_MODEL_PATH,
    diagnose_no_wavefront: bool = False,
) -> Dict[str, Any]:
    """运行四组完整后端计划，并可观察移除结构波前后的纯网络表现。"""
    policy = load_neural_policy(model_path)
    rows: Dict[str, Dict[str, Any]] = {}
    for split in (False, True):
        for strategy in ("heuristic", "neural"):
            label = f"{'split' if split else 'full'}-{strategy}"
            plan = build_plan(
                strategy,
                split=split,
                wafer_count=wafer_count,
                process_seconds=process_seconds,
            )
            started = time.perf_counter()
            if strategy == "neural":
                with patch.object(
                    scheduler_server,
                    "_load_neural_inference_policy",
                    return_value=policy,
                ):
                    result = scheduler_server.execute_plan(plan)
            else:
                result = scheduler_server.execute_plan(plan)
            rows[label] = summarize_result(
                label,
                result,
                time.perf_counter() - started,
            )

    if diagnose_no_wavefront:
        label = "split-neural-no-wavefront-observation"
        plan = build_plan(
            "neural",
            split=True,
            wafer_count=wafer_count,
            process_seconds=process_seconds,
        )
        started = time.perf_counter()
        with (
            patch.object(
                scheduler_server,
                "_load_neural_inference_policy",
                return_value=policy,
            ),
            patch.object(
                neural_scheduler,
                "_balanced_disjoint_wavefront",
                return_value=None,
            ),
        ):
            result = scheduler_server.execute_plan(plan)
        rows[label] = summarize_result(
            label,
            result,
            time.perf_counter() - started,
        )

    split_neural = rows["split-neural"]
    full_neural = rows["full-neural"]
    split_baseline = rows["split-heuristic"]
    quality = {
        "splitNeuralVsFullNeural": round(
            split_neural["makespanSeconds"]
            / full_neural["makespanSeconds"],
            6,
        ),
        "splitNeuralVsSplitBaseline": round(
            split_neural["makespanSeconds"]
            / split_baseline["makespanSeconds"],
            6,
        ),
        "baselineMakespanReduction": round(
            1.0
            - split_neural["makespanSeconds"]
            / split_baseline["makespanSeconds"],
            6,
        ),
        "baselineWallSpeedup": round(
            split_baseline["wallSeconds"]
            / max(split_neural["wallSeconds"], 1e-9),
            3,
        ),
    }
    no_wavefront = rows.get(
        "split-neural-no-wavefront-observation"
    )
    if no_wavefront is not None:
        quality.update({
            "noWavefrontVsFullNeural": round(
                no_wavefront["makespanSeconds"]
                / full_neural["makespanSeconds"],
                6,
            ),
            "noWavefrontVsSplitBaseline": round(
                no_wavefront["makespanSeconds"]
                / split_baseline["makespanSeconds"],
                6,
            ),
        })
    return {
        "case": {
            "jobs": 3,
            "wafersPerJob": wafer_count,
            "totalWafers": wafer_count * 3,
            "processSeconds": process_seconds,
            "referencePool": list(PM_POOL_6),
            "splitPools": [modules.split(",") for modules in PAIR_POOLS],
        },
        "results": rows,
        "quality": quality,
    }


def main() -> None:
    """解析规模参数并打印严格 JSON A/B 报告。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--wafer-count", type=int, default=25)
    parser.add_argument("--process-seconds", type=float, default=300.0)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument(
        "--diagnose-no-wavefront",
        action="store_true",
        help="额外运行移除同步波前的纯深网观察项，不改变正式验收结果",
    )
    args = parser.parse_args()
    if not 2 <= args.wafer_count <= 25:
        parser.error("--wafer-count 必须位于 2~25；严格验收使用默认 25")
    if args.process_seconds <= 0.0:
        parser.error("--process-seconds 必须为正数")
    print(
        json.dumps(
            run_benchmark(
                wafer_count=args.wafer_count,
                process_seconds=args.process_seconds,
                model_path=args.model,
                diagnose_no_wavefront=args.diagnose_no_wavefront,
            ),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
