"""神经训练实时残差状态增强器的内存采样回归测试。"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from realtime_scheduler import server as scheduler_server
from scripts.train_neural import (
    ACCEPTANCE_RECOMPUTE_GAPS,
    ACCEPTANCE_WAFER_COUNTS,
    FEATURE_DIMENSION,
    REALTIME_RESIDUAL_RECOMPUTE_GAPS,
    REALTIME_RESIDUAL_WAFER_COUNTS,
    SIX_PM_LONG_PROCESS_TIMES,
    SIX_PM_LONG_RECOMPUTE_GAPS,
    SIX_PM_LONG_WAFER_COUNTS,
    ACCEPTANCE_LONG_PROCESS_TIME,
    ACCEPTANCE_LONG_RECOMPUTE_GAP,
    ACCEPTANCE_LONG_WAFER_COUNT,
    _collect_realtime_residual_instances,
    _collect_six_pm_long_residual_instances,
)


class NeuralRealtimeResidualAugmentationTests(unittest.TestCase):
    """确认增强样本确实来自多轮运行态，且采集过程不写工作区。"""

    def test_collector_returns_ranked_runtime_instance_in_memory(self) -> None:
        """限量采样应产生带压力态和资源下界的完整候选排序。"""
        with patch.object(
            scheduler_server,
            "_write_workspace_catalog_unlocked",
            side_effect=AssertionError("残差采集器不应写前端工作区"),
        ):
            instances = _collect_realtime_residual_instances(seed=3, limit=1)

        self.assertEqual(1, len(instances))
        instance = instances[0]
        self.assertEqual(1, instance.recompute_index)
        availability = instance.runtime_availability
        self.assertTrue(availability.loadlock_environment)
        self.assertTrue(
            availability.station_ready
            or availability.slot_ready
            or availability.robot_ready
            or availability.material_ready
        )
        self.assertTrue(instance.records)
        features, ranking = instance.records[0]
        self.assertEqual(FEATURE_DIMENSION, features.shape[1])
        self.assertEqual(features.shape[0], ranking.shape[0])
        self.assertEqual(
            list(range(features.shape[0])),
            sorted(int(value) for value in ranking),
        )

        self.assertFalse(
            ACCEPTANCE_RECOMPUTE_GAPS.intersection(
                REALTIME_RESIDUAL_RECOMPUTE_GAPS
            )
        )
        self.assertFalse(
            ACCEPTANCE_WAFER_COUNTS.intersection(
                REALTIME_RESIDUAL_WAFER_COUNTS
            )
        )

    def test_six_pm_long_collector_uses_non_acceptance_strong_teacher(self) -> None:
        """六腔长途增强应在非验收域逐残差态选择较强教师。"""
        with patch.object(
            scheduler_server,
            "_write_workspace_catalog_unlocked",
            side_effect=AssertionError("长途残差采集器不应写前端工作区"),
        ):
            instances = _collect_six_pm_long_residual_instances(
                seed=3,
                limit=1,
            )

        self.assertEqual(1, len(instances))
        self.assertEqual("six-pm-long", instances[0].structure)
        self.assertIn(
            instances[0].teacher,
            {"heuristic", "neural-wavefront"},
        )
        self.assertNotIn(
            ACCEPTANCE_LONG_PROCESS_TIME,
            SIX_PM_LONG_PROCESS_TIMES,
        )
        self.assertNotIn(
            ACCEPTANCE_LONG_RECOMPUTE_GAP,
            SIX_PM_LONG_RECOMPUTE_GAPS,
        )
        self.assertNotIn(
            ACCEPTANCE_LONG_WAFER_COUNT,
            SIX_PM_LONG_WAFER_COUNTS,
        )


if __name__ == "__main__":
    unittest.main()
