"""服务端分析层回归测试。

这些测试直接调用后端分析模块，确保指标不依赖浏览器、DOM 或网络请求。
"""

from __future__ import annotations

import unittest

from realtime_scheduler.backend.analysis import (
    analyze_schedule_performance,
    analyze_test_group_performance,
    build_schedule_analysis_context,
)


class BackendAnalysisTests(unittest.TestCase):
    """验证服务端单结果、工序上下文和测试组统计。"""

    def test_schedule_analysis_returns_structured_server_result(self) -> None:
        """服务端应从 MoveList 生成窗口、资源和瓶颈字段。"""
        moves = [
            {
                "MoveType": 0,
                "ModuleName": "ATR",
                "StartTime": 0,
                "EndTime": 1,
                "SrcStationList": ["LP1"],
                "MatIDList": ["1"],
            },
            {
                "MoveType": 9,
                "ModuleName": "PM1",
                "StartTime": 1,
                "EndTime": 4,
                "MatIDList": ["1"],
            },
            {
                "MoveType": 1,
                "ModuleName": "ATR",
                "StartTime": 4,
                "EndTime": 5,
                "DestStationList": ["LP1"],
                "MatIDList": ["1"],
            },
        ]
        result = analyze_schedule_performance(
            moves,
            {
                "Stations": {
                    "LP1": {"Type": "LoadPort"},
                    "PM1": {"Type": "ProcessModule"},
                },
                "Robots": {"ATR": {}},
            },
            mode="full",
        )
        self.assertEqual("full", result["window"]["method"])
        self.assertEqual(1, result["completedWaferCount"])
        self.assertIn("PM1", {resource["name"] for resource in result["resources"]})
        self.assertIn("diagnostics", result)

    def test_context_is_built_on_backend_from_routes_and_rounds(self) -> None:
        """工序容量上下文应由后端从原始 Route/PJob 配置构建。"""
        context = build_schedule_analysis_context(
            [
                {
                    "name": "RouteA",
                    "stages": [
                        {
                            "stepId": 2,
                            "needProcess": True,
                            "visits": [
                                {"stationName": "PM1"},
                                {"stationName": "PM2"},
                            ],
                        }
                    ],
                }
            ],
            [
                {
                    "cjobs": [
                        {
                            "key": "C1",
                            "pjobs": [{"jobName": "P1", "routeRef": "RouteA"}],
                        }
                    ]
                }
            ],
        )
        self.assertEqual(["PM1", "PM2"], context["processStages"][0]["resourceNames"])

    def test_group_analysis_reports_comparison_and_cpu_metrics(self) -> None:
        """测试组统计应在服务端统一计算比较指标与 CPU 分位数。"""
        result = analyze_test_group_performance(
            [
                {
                    "id": "case-1",
                    "name": "测试一",
                    "status": "succeeded",
                    "validation": "passed",
                    "makespan": 90,
                    "baselineMakespan": 100,
                    "cpuTimeMs": 10,
                },
                {
                    "id": "case-2",
                    "name": "测试二",
                    "status": "failed",
                    "validation": "failed",
                    "makespan": None,
                    "baselineMakespan": 100,
                    "cpuTimeMs": None,
                },
            ]
        )
        self.assertEqual(1, result["succeededCount"])
        self.assertEqual(1, result["winCount"])
        self.assertEqual(10, result["weightedImprovementPercent"])
        self.assertEqual(10, result["medianCpuTimeMs"])


if __name__ == "__main__":
    unittest.main()
