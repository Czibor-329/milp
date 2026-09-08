"""测试组后台分析任务回归测试。"""

from __future__ import annotations

import time
import unittest
from unittest.mock import patch

from realtime_scheduler.backend.analysis_jobs import (
    create_test_group_analysis_job,
    read_test_group_analysis_job,
)


class AnalysisJobTests(unittest.TestCase):
    """验证分析任务能够报告进度并返回参考测试比较结果。"""

    def test_job_completes_selected_metrics_and_reference_comparison(self) -> None:
        """任务应读取运行制品、限制指标并生成严格可比的参考差异。"""
        saved_results = {
            "r1": {
                "MoveList": [{"MoveType": 9, "ModuleName": "PM1", "StartTime": 0, "EndTime": 10}],
                "RunMetricsMetadata": {"cpuTimeMs": 5, "recomputeCount": 1},
            },
            "r2": {
                "MoveList": [{"MoveType": 9, "ModuleName": "PM1", "StartTime": 0, "EndTime": 12}],
                "RunMetricsMetadata": {"cpuTimeMs": 7, "recomputeCount": 1},
            },
        }
        payload = {
            "device": {"Stations": {"PM1": {"Type": "ProcessChamber"}}, "Robots": {}},
            "routes": [],
            "metricIds": ["makespan", "average_recompute_time"],
            "referenceCaseId": "one",
            "timeBudgetSeconds": 10,
            "cases": [
                {"id": "one", "name": "一", "status": "succeeded", "validation": "passed", "makespan": 10, "resultId": "r1", "rounds": [], "comparisonKey": "same"},
                {"id": "two", "name": "二", "status": "succeeded", "validation": "passed", "makespan": 12, "resultId": "r2", "rounds": [], "comparisonKey": "same"},
            ],
        }

        with patch(
            "realtime_scheduler.backend.analysis_jobs.read_result",
            side_effect=lambda result_id: saved_results.get(result_id),
        ):
            job = create_test_group_analysis_job(payload)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                snapshot = read_test_group_analysis_job(job["id"])
                if snapshot and snapshot["status"] not in {"queued", "running"}:
                    break
                time.sleep(0.01)
            else:
                self.fail("分析任务未在预期时间内结束")

        self.assertEqual("completed", snapshot["status"])
        self.assertEqual(100, snapshot["progress"])
        self.assertEqual(["basic"], snapshot["result"]["selectedMetricGroups"])
        self.assertEqual(
            ["makespan", "average_recompute_time"],
            snapshot["result"]["selectedMetricIds"],
        )
        self.assertEqual(6, snapshot["result"]["medianAverageRecomputeTimeMs"])
        compared = snapshot["result"]["cases"][1]
        self.assertTrue(compared["referenceComparable"])
        self.assertEqual(20, compared["referenceDeltas"]["makespan"]["percent"])


if __name__ == "__main__":
    unittest.main()
