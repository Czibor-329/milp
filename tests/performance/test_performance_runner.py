"""验证性能报告计算、相对门禁和迁移夹具本身的正确性。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from realtime_scheduler import server
from scripts.run_performance_suite import (
    _evaluate_absolute_budgets,
    _evaluate_relative_budgets,
)
from tests.performance.fixture_factory import generate_v5_workspace_file


ROOT = Path(__file__).resolve().parents[2]


class RelativeBudgetTests(unittest.TestCase):
    """验证相对门禁同时应用比例和绝对差值。"""

    def setUp(self) -> None:
        """加载仓库中的试运行预算。"""
        self.budgets = json.loads(
            (ROOT / "performance" / "budgets.json").read_text(encoding="utf-8")
        )

    def _report(self, p50: float, p95: float, response_bytes: int) -> dict:
        """创建最小的同场景性能报告。"""
        return {
            "profile": "small",
            "peakRssBytes": 1000,
            "metrics": {
                "workspaceList": {
                    "p50Ms": p50,
                    "p95Ms": p95,
                    "maximumResponseBytes": response_bytes,
                },
            },
        }

    def test_small_absolute_jitter_does_not_block(self) -> None:
        """比例虽高但绝对差值很小时不得误报。"""
        evaluation = _evaluate_relative_budgets(
            self._report(12, 24, 1000),
            self._report(10, 20, 1000),
            self.budgets,
        )

        self.assertTrue(all(item["passed"] for item in evaluation))

    def test_material_latency_and_payload_regressions_block(self) -> None:
        """超过比例及绝对差值，或响应体积超预算时必须失败。"""
        current = self._report(150, 240, 1200)
        baseline = self._report(100, 150, 1000)
        evaluation = _evaluate_relative_budgets(current, baseline, self.budgets)
        failed_ids = {item["id"] for item in evaluation if not item["passed"]}

        self.assertIn("workspaceList.p50Ms", failed_ids)
        self.assertIn("workspaceList.p95Ms", failed_ids)
        self.assertIn("workspaceList.maximumResponseBytes", failed_ids)

    def test_absolute_budget_includes_test_and_group_delete(self) -> None:
        """绝对预算必须分别门禁单测试和测试组删除的最大耗时。"""
        metric = {
            "p50Ms": 10,
            "p95Ms": 20,
            "maximumMs": 20,
            "maximumResponseBytes": 100,
        }
        metrics = {
            name: dict(metric)
            for name in (
                "health",
                "workspaceList",
                "deviceOverview",
                "singleTestRead",
                "singleTestDelete",
                "testGroupDelete",
                "singleTestSave",
            )
        }

        evaluation = _evaluate_absolute_budgets(
            metrics,
            100,
            self.budgets,
            migration=False,
        )

        delete_evaluation = next(
            item for item in evaluation if item["id"] == "testGroupDeleteMaximum"
        )
        self.assertEqual(20, delete_evaluation["actualMs"])
        self.assertEqual(300, delete_evaluation["budgetMs"])
        self.assertTrue(delete_evaluation["passed"])

        single_delete_evaluation = next(
            item for item in evaluation if item["id"] == "singleTestDeleteMaximum"
        )
        self.assertEqual(20, single_delete_evaluation["actualMs"])
        self.assertEqual(300, single_delete_evaluation["budgetMs"])
        self.assertTrue(single_delete_evaluation["passed"])


class MigrationPerformanceFixtureTests(unittest.TestCase):
    """验证性能迁移夹具可由正式迁移器恢复且后续启动幂等。"""

    def test_v5_fixture_migrates_with_backup_and_current_marker(self) -> None:
        """v5 单文件应迁移为可按需读取的 v6 目录并保留备份。"""
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            store_dir = data_dir / "datasets"
            legacy_file = data_dir / "workspaces.json"
            generate_v5_workspace_file(
                legacy_file,
                device_count=1,
                tests_per_device=3,
                payload_bytes_per_test=128,
                round_count=2,
            )
            with (
                patch.object(server, "DATA_DIR", data_dir),
                patch.object(server, "WORKSPACE_STORE_PATH", store_dir),
            ):
                server._migrate_legacy_workspace_store(store_dir)
                overview = server.get_workspace_device_overview(
                    "performance-device-00",
                    store_dir,
                )
                second_start_changed = server._prepare_workspace_data(store_dir)

            self.assertEqual(3, len(overview["tests"]))
            self.assertTrue((store_dir / "manifest.json").is_file())
            self.assertTrue((data_dir / "workspaces.json.legacy.json").is_file())
            self.assertFalse(second_start_changed)


if __name__ == "__main__":
    unittest.main()
