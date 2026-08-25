"""生产指标独立模块回归测试。"""

from __future__ import annotations

import unittest

from realtime_scheduler.production_metrics import calculate_production_metrics


def _fixture(recipe_override: dict[int, str] | None = None):
    moves = []
    overrides = recipe_override or {}
    for index in range(150):
        wafer = str(index + 1)
        process_start = index * 10 + 1
        if index == 16:
            process_start = 171
        elif index == 17:
            process_start = 161
        moves.extend([
            {
                "MoveType": 0,
                "ModuleName": "ATR",
                "StartTime": index * 10,
                "EndTime": index * 10 + 0.5,
                "SrcStationList": ["LP1"],
                "MatIDList": [wafer],
                "PJobName": ["1.C1.P1"],
            },
            {
                "MoveType": 9,
                "ModuleName": "PM1",
                "StartTime": process_start,
                "EndTime": process_start + 15,
                "MatIDList": [wafer],
                "PJobName": ["1.C1.P1"],
                "StepIDList": [4],
                "ProcessRecipe": overrides.get(index, "R1"),
            },
            {
                "MoveType": 1,
                "ModuleName": "ATR",
                "StartTime": index * 10 + 29,
                "EndTime": index * 10 + 30,
                "DestStationList": ["LP1"],
                "MatIDList": [wafer],
                "PJobName": ["1.C1.P1"],
            },
        ])
    return moves


DEVICE = {
    "Stations": {
        "LP1": {"Type": "LoadPort"},
        "PM1": {"Type": "ProcessChamber", "Capacity": 2, "Slots": [1, 2]},
        "PM2": {"Type": "ProcessChamber"},
    },
    "Robots": {"ATR": {}},
}
CONTEXT = {
    "processStages": [{
        "pjobName": "1.C1.P1",
        "routeRef": "RouteA",
        "stepId": 4,
        "resourceNames": ["PM1", "PM2"],
    }],
    "pjobRoutes": [{"pjobName": "1.C1.P1", "routeRef": "RouteA"}],
}


class ProductionMetricsTests(unittest.TestCase):
    def test_fixed_window_union_capacity_rpt_and_surpass(self) -> None:
        result = calculate_production_metrics(
            _fixture(), DEVICE, CONTEXT, calculation_seconds=0.75,
        )
        self.assertEqual("production-metrics-v1", result["schemaVersion"])
        self.assertEqual(120, result["sampleWindow"]["selectedWaferCount"])
        self.assertEqual("16", result["sampleWindow"]["waferIds"][0])
        self.assertEqual("135", result["sampleWindow"]["waferIds"][-1])
        self.assertTrue(result["applicability"]["sameRecipeAndPath"])
        self.assertAlmostEqual(3600 * 120 / 1190, result["overall"]["throughputPerHour"])
        self.assertEqual(2, result["overall"]["parallelChamberCount"])
        self.assertAlmostEqual(
            60 / (result["overall"]["throughputPerHour"] / 2),
            result["overall"]["rptMinutes"],
        )
        chamber = result["chambers"][0]
        self.assertEqual(119, chamber["k"])
        self.assertAlmostEqual(360, chamber["throughputPerHour"])
        self.assertAlmostEqual(0, chamber["entryIntervalStdSeconds"])
        self.assertEqual(1, chamber["surpassWaferCount"])
        self.assertAlmostEqual(1 / 120, chamber["surpassRate"])
        pm1 = next(item for item in result["modules"] if item["name"] == "PM1")
        self.assertEqual(1.0, pm1["utilization"])
        self.assertEqual(0.75, result["calculationSeconds"])

    def test_mixed_recipe_suppresses_dependent_metrics(self) -> None:
        result = calculate_production_metrics(
            _fixture({20: "R2"}), DEVICE, CONTEXT,
        )
        self.assertFalse(result["applicability"]["sameRecipeAndPath"])
        self.assertFalse(result["overall"]["available"])
        self.assertIsNone(result["overall"]["throughputPerHour"])
        self.assertEqual([], result["chambers"])
        self.assertTrue(result["modules"])

    def test_short_result_reports_required_sample(self) -> None:
        result = calculate_production_metrics(_fixture()[:30], DEVICE, CONTEXT)
        self.assertFalse(result["sampleWindow"]["available"])
        self.assertIn("150", result["sampleWindow"]["reason"])


if __name__ == "__main__":
    unittest.main()
