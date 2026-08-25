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
        self.assertEqual(
            [
                {
                    "wafer": "1",
                    "enteredAt": 1.0,
                    "completedAt": 5.0,
                    "duration": 4.0,
                    "chamberDwellSeconds": 0.0,
                    "robotDwellSeconds": 3.0,
                }
            ],
            result["waferSystemResidenceTimes"],
        )
        self.assertNotIn("diagnostics", result)
        self.assertEqual(0, result["throughputPerHour"])
        self.assertEqual(0, result["throughputSampleCount"])
        self.assertIn("大于 150", result["throughputReason"])
        self.assertIsNone(result["cpuTimeMs"])
        self.assertIsNone(result["averageRecomputeTimeMs"])

    def test_production_throughput_requires_more_than_150_completed_wafers(self) -> None:
        """产能必须超过 150 片才按剔除前 15、固定 120 片的新口径计算。"""
        def moves_for(count: int) -> list[dict]:
            rows = []
            for index in range(count):
                wafer = f"W{index + 1}"
                completed_at = float((index + 1) * 10)
                rows.extend([
                    {"MoveType": 0, "ModuleName": "ATR", "SrcStationList": ["LP1"], "MatIDList": [wafer], "StartTime": completed_at - 9, "EndTime": completed_at - 8},
                    {"MoveType": 9, "ModuleName": "PM1", "MatIDList": [wafer], "PJobName": ["1.C1.P1"], "StepID": 1, "ProcessRecipe": "R1", "StartTime": completed_at - 7, "EndTime": completed_at - 2},
                    {"MoveType": 1, "ModuleName": "ATR", "DestStationList": ["LP1"], "MatIDList": [wafer], "StartTime": completed_at - 1, "EndTime": completed_at},
                ])
            return rows

        device = {"Stations": {"LP1": {"Type": "LoadPort"}, "PM1": {"Type": "ProcessModule"}}, "Robots": {"ATR": {}}}
        context = {"pjobRoutes": [{"pjobName": "1.C1.P1", "routeRef": "RouteA"}]}
        unavailable = analyze_schedule_performance(moves_for(150), device, "full", context)
        available = analyze_schedule_performance(
            moves_for(151),
            device,
            "full",
            context,
            {"cpuTimeMs": 900.0, "recomputeCount": 3},
        )

        self.assertEqual(0, unavailable["throughputPerHour"])
        self.assertAlmostEqual(3600 * 120 / 1190, available["throughputPerHour"])
        self.assertEqual(120, available["throughputSampleCount"])
        self.assertEqual(900.0, available["cpuTimeMs"])
        self.assertEqual(3, available["recomputeCount"])
        self.assertEqual(300.0, available["averageRecomputeTimeMs"])

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
        self.assertEqual("RouteA", context["processStages"][0]["routeRef"])
        self.assertEqual(
            [{"pjobName": "1.C1.P1", "routeRef": "RouteA"}],
            context["pjobRoutes"],
        )

    def test_load_lock_efficiency_counts_completed_cycles_and_repeated_loads(self) -> None:
        """同一晶圆跨多个抽充气周期时，每个周期都应贡献一次载荷。"""
        result = analyze_schedule_performance(
            [
                {"MoveType": 12, "ModuleName": "LA", "MatIDList": ["W1"], "StartTime": 0, "EndTime": 1},
                {"MoveType": 13, "ModuleName": "LA", "MatIDList": ["W1"], "StartTime": 2, "EndTime": 3},
                {"MoveType": 12, "ModuleName": "LA", "MatIDList": ["W1", "W2"], "StartTime": 4, "EndTime": 5},
                {"MoveType": 13, "ModuleName": "LA", "MatIDList": ["W1"], "StartTime": 6, "EndTime": 7},
                {"MoveType": 12, "ModuleName": "LA", "MatIDList": [], "StartTime": 8, "EndTime": 9},
                {"MoveType": 13, "ModuleName": "LA", "MatIDList": [], "StartTime": 10, "EndTime": 11},
                {"MoveType": 12, "ModuleName": "LA", "MatIDList": ["W3"], "StartTime": 12, "EndTime": 13},
            ],
            {"Stations": {"LA": {"Type": "LoadLock", "Capacity": 2}}},
            mode="full",
        )
        self.assertEqual(
            {
                "cycleCount": 3,
                "waferCycleCount": 3,
                "wafersPerCycle": 1,
                "fullLoadCycleCount": 1,
                "emptyLoadCycleCount": 1,
                "fullLoadCycleRatio": 1 / 3,
                "emptyLoadCycleRatio": 1 / 3,
            },
            result["loadLockEfficiency"],
        )

    def test_load_lock_efficiency_recognizes_pse300_atr_vtr_transitions(self) -> None:
        """PSE300 以 ATR/VTR（而非 ATM/VAC）记录 MoveType=10 环境切换。"""
        result = analyze_schedule_performance(
            [
                {"MoveType": 10, "ModuleName": "LA", "LastState": "ATR", "CurState": "VTR", "MatIDList": ["W1"], "StartTime": 0, "EndTime": 1},
                {"MoveType": 10, "ModuleName": "LA", "LastState": "VTR", "CurState": "ATR", "MatIDList": ["W1"], "StartTime": 2, "EndTime": 3},
            ],
            {"Stations": {"LA": {"Type": "LoadLock", "Capacity": 2}}},
            mode="full",
        )
        self.assertEqual(1, result["loadLockEfficiency"]["cycleCount"])
        self.assertEqual(1, result["loadLockEfficiency"]["waferCycleCount"])

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
