"""六腔共享路线拆成三条双腔路线后的神经泛化验收。"""

from __future__ import annotations

import math
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import realtime_scheduler.server as scheduler_server
from scripts.benchmark_neural_route_decomposition import (
    build_plan,
    run_benchmark,
)
from src.schedule.neural import DEFAULT_MODEL_PATH, load_neural_policy


PROCESS_SECONDS = 300.0
WAFERS_PER_JOB = 25
MAXIMUM_PROCESS_LOWER_BOUND_RATIO = 1.25
MAXIMUM_FULL_ROUTE_REFERENCE_RATIO = 1.05
MAXIMUM_SPLIT_BASELINE_RATIO = 0.70


class NeuralRouteDecompositionTests(unittest.TestCase):
    """验证网络能并行推进三个互不共享加工腔的路线族。"""

    def test_hard_split_case_uses_direct_neural_wavefront(self) -> None:
        """75 片拆分案例应直接推理完成，并接近纯 PM 容量下界。"""
        policy = load_neural_policy(DEFAULT_MODEL_PATH)
        with patch.object(
            scheduler_server,
            "_load_neural_inference_policy",
            return_value=policy,
        ):
            result = scheduler_server.execute_plan(
                build_plan(
                    "neural",
                    split=True,
                    wafer_count=WAFERS_PER_JOB,
                    process_seconds=PROCESS_SECONDS,
                )
            )

        diagnostics = result["rounds"][0]["strategyDiagnostics"]
        process_moves = [
            move
            for move in result["output"]["MoveList"]
            if move.get("MoveType") == 9
            and str(move.get("ModuleName") or "").startswith("PM")
        ]
        counts = {
            module: sum(move["ModuleName"] == module for move in process_moves)
            for module in (f"PM{index}" for index in range(1, 7))
        }
        process_lower_bound = (
            math.ceil(WAFERS_PER_JOB / 2) * PROCESS_SECONDS
        )

        self.assertEqual("passed", result["validation"])
        self.assertEqual("neural", diagnostics["selectedSource"])
        self.assertEqual(
            "balanced-disjoint-route-wavefront",
            diagnostics["inductiveBias"],
        )
        self.assertEqual(3, diagnostics["wavefrontFamilies"])
        self.assertGreater(diagnostics["forwardPasses"], 0)
        self.assertEqual("complete-path-certificate", diagnostics["actionMask"])
        self.assertTrue(
            any("同步波前=3 路线族" in line for line in result["logs"])
        )
        self.assertEqual(
            [12, 12, 12, 13, 13, 13],
            sorted(counts.values()),
        )
        self.assertLessEqual(
            result["makespan"],
            process_lower_bound * MAXIMUM_PROCESS_LOWER_BOUND_RATIO,
        )

    @unittest.skipUnless(
        os.environ.get("RUN_NEURAL_QUALITY_AB") == "1",
        "设置 RUN_NEURAL_QUALITY_AB=1 执行 75 片四组质量 A/B",
    )
    def test_split_matches_full_route_reference_and_beats_baseline(self) -> None:
        """完整四组实验必须同时守住原路线标准和 baseline 改善。"""
        report = run_benchmark(
            wafer_count=WAFERS_PER_JOB,
            process_seconds=PROCESS_SECONDS,
            model_path=Path(
                os.environ.get(
                    "NEURAL_QUALITY_MODEL",
                    str(DEFAULT_MODEL_PATH),
                )
            ),
        )
        quality = report["quality"]
        split_neural = report["results"]["split-neural"]

        self.assertEqual("passed", split_neural["validation"])
        self.assertEqual("neural", split_neural["selectedSource"])
        self.assertLessEqual(
            quality["splitNeuralVsFullNeural"],
            MAXIMUM_FULL_ROUTE_REFERENCE_RATIO,
        )
        self.assertLessEqual(
            quality["splitNeuralVsSplitBaseline"],
            MAXIMUM_SPLIT_BASELINE_RATIO,
        )
        print(
            "[route-decomposition] "
            f"referenceRatio={quality['splitNeuralVsFullNeural']:.4f} "
            f"baselineRatio={quality['splitNeuralVsSplitBaseline']:.4f} "
            f"baselineReduction={quality['baselineMakespanReduction']:.2%} "
            f"wallSpeedup={quality['baselineWallSpeedup']:.2f}x",
            flush=True,
        )


if __name__ == "__main__":
    unittest.main()
