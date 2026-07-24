"""双臂 Robot 在单槽加工腔执行原子换片的端到端回归测试。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from realtime_scheduler.server import execute_plan


ROOT = Path(__file__).resolve().parents[1]
PSE300_PATH = ROOT / "src" / "input_data" / "PSE300.json"
WAFER_COUNT = 4
TIME_TOLERANCE = 1e-6


def _single_process_plan(
    strategy: str,
    wafer_count: int = WAFER_COUNT,
) -> dict:
    """构造与前端“单次重算-1Job / t1”等价的 PM1 单腔计划。"""
    return {
        "deviceName": PSE300_PATH.name,
        "device": json.loads(PSE300_PATH.read_text(encoding="utf-8")),
        "strategy": strategy,
        "roundCount": 1,
        "options": {
            "loadLockManager": "petri-look",
            "loadLockExchange": "auto",
            "milpTimeLimit": 30,
        },
        "recipes": [
            {
                "name": "PM1_40",
                "time": 40,
                "modules": ["PM1"],
                "weight": {},
            }
        ],
        "cleans": [],
        "routes": [
            {
                "name": "PM1(40s)",
                "group": "PM1(40s)",
                "bufferOption": 0,
                "prePJobCleanRefs": [],
                "postPJobCleanRefs": [],
                "postCJobCleanRefs": [],
                "stages": [
                    {"stations": "LP1", "recipeRef": "", "slots": "1"},
                    {"stations": "ATR", "recipeRef": "", "slots": "1"},
                    {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
                    {"stations": "VTR", "recipeRef": "", "slots": "1"},
                    {"stations": "PM1", "recipeRef": "PM1_40", "slots": "1"},
                    {"stations": "VTR", "recipeRef": "", "slots": "1"},
                    {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
                    {"stations": "ATR", "recipeRef": "", "slots": "1"},
                    {"stations": "LP1", "recipeRef": "", "slots": "1"},
                ],
            }
        ],
        "rounds": [
            {
                "currentTime": 0,
                "jobs": [
                    {
                        "name": "P1",
                        "routeRef": "PM1(40s)",
                        "loadPort": "LP1",
                        "waferCount": wafer_count,
                        "priority": 1,
                        "weight": 1,
                        "jobType": 0,
                        "taskMode": 0,
                        "foupId": "P1",
                    }
                ],
            }
        ],
    }


class ProcessChamberSwapTests(unittest.TestCase):
    """验证共享定时路径和 MILP 后处理都能导出合法 PM SwapMove。"""

    def _assert_pm_swaps(
        self,
        strategy: str,
        wafer_count: int = WAFER_COUNT,
    ) -> None:
        """断言指定内置策略为相邻晶圆生成完整的 PM1 换片链。"""
        result = execute_plan(_single_process_plan(strategy, wafer_count))
        process_swaps = [
            move
            for move in result["output"]["MoveList"]
            if int(move.get("MoveType", -1)) == 4
            and move.get("StationList") == ["PM1", "PM1"]
        ]
        self.assertEqual("passed", result["validation"])
        self.assertEqual(wafer_count - 1, len(process_swaps))
        self.assertEqual(
            list(range(1, wafer_count)),
            [move["RecvMatList"][0] for move in process_swaps],
        )
        self.assertEqual(
            list(range(2, wafer_count + 1)),
            [move["SendMatList"][0] for move in process_swaps],
        )
        for move in process_swaps:
            self.assertNotEqual(move["RecvSlotList"], move["SendSlotList"])

    def test_shared_decoder_path_emits_process_swaps(self) -> None:
        """四种共享解码路径都应在最小两片场景生成一次 PM 换片。"""
        for strategy in ("heuristic", "neural", "rl"):
            with self.subTest(strategy=strategy):
                self._assert_pm_swaps(strategy, wafer_count=2)

    def test_milp_order_is_retimed_with_process_swaps(self) -> None:
        """MILP 的两片资源顺序也应在求解后提升为一次双臂 PM 换片。"""
        self._assert_pm_swaps("milp", wafer_count=2)

    def test_two_and_three_wafers_have_exact_swap_boundaries(self) -> None:
        """用最小 2/3 片流水逐边验证 PM 换片前后没有隐藏等待或资源重叠。"""
        previous_makespan = 0.0
        for wafer_count in (2, 3):
            with self.subTest(wafer_count=wafer_count):
                plan = _single_process_plan("heuristic", wafer_count)
                result = execute_plan(plan)
                moves = result["output"]["MoveList"]
                process_swaps = [
                    move
                    for move in moves
                    if int(move.get("MoveType", -1)) == 4
                    and move.get("StationList") == ["PM1", "PM1"]
                ]
                expected_swap_duration = (
                    float(plan["device"]["Robots"]["VTR"]["PickTime"]["PM1"])
                    + float(plan["device"]["Robots"]["VTR"]["PlaceTime"]["PM1"])
                )

                self.assertEqual("passed", result["validation"])
                self.assertEqual(wafer_count - 1, len(process_swaps))
                self.assertGreater(result["makespan"], previous_makespan)
                previous_makespan = result["makespan"]

                for swap in process_swaps:
                    outgoing_material = swap["RecvMatList"][0]
                    incoming_material = swap["SendMatList"][0]
                    self.assertAlmostEqual(
                        expected_swap_duration,
                        swap["EndTime"] - swap["StartTime"],
                        delta=TIME_TOLERANCE,
                    )

                    incoming_travel = next(
                        move
                        for move in moves
                        if int(move.get("MoveType", -1)) == 5
                        and move.get("DestStationList") == ["PM1"]
                        and move.get("MatIDList") == [incoming_material]
                    )
                    outgoing_travel = next(
                        move
                        for move in moves
                        if int(move.get("MoveType", -1)) == 5
                        and move.get("SrcStationList") == ["PM1"]
                        and move.get("MatIDList") == [outgoing_material]
                    )
                    opening = next(
                        move
                        for move in moves
                        if int(move.get("MoveType", -1)) == 6
                        and move.get("ModuleName") == "PM1"
                        and abs(move["EndTime"] - swap["StartTime"]) <= TIME_TOLERANCE
                    )
                    closing = next(
                        move
                        for move in moves
                        if int(move.get("MoveType", -1)) == 7
                        and move.get("ModuleName") == "PM1"
                        and abs(move["StartTime"] - swap["EndTime"]) <= TIME_TOLERANCE
                    )
                    outgoing_process = next(
                        move
                        for move in moves
                        if int(move.get("MoveType", -1)) == 9
                        and move.get("ModuleName") == "PM1"
                        and move.get("MatIDList") == [outgoing_material]
                    )
                    incoming_process = next(
                        move
                        for move in moves
                        if int(move.get("MoveType", -1)) == 9
                        and move.get("ModuleName") == "PM1"
                        and move.get("MatIDList") == [incoming_material]
                    )

                    self.assertAlmostEqual(
                        incoming_travel["EndTime"],
                        swap["StartTime"],
                        delta=TIME_TOLERANCE,
                    )
                    self.assertAlmostEqual(
                        outgoing_process["EndTime"],
                        opening["StartTime"],
                        delta=TIME_TOLERANCE,
                    )
                    self.assertAlmostEqual(
                        outgoing_travel["StartTime"],
                        swap["EndTime"],
                        delta=TIME_TOLERANCE,
                    )
                    self.assertAlmostEqual(
                        incoming_process["StartTime"],
                        closing["EndTime"],
                        delta=TIME_TOLERANCE,
                    )
                    self.assertNotEqual(
                        swap["RecvSlotList"],
                        swap["SendSlotList"],
                    )


if __name__ == "__main__":
    unittest.main()
