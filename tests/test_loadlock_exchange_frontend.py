"""前端六腔短工艺测试集的 LoadLock 交换节拍质量回归。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from realtime_scheduler import server as scheduler_server
from realtime_scheduler.batch_service import build_workspace_batch_plan
from scripts.seed_neural_recompute_workspaces import (
    LOADLOCK_CADENCE_GROUP,
    LOADLOCK_CADENCE_TEST,
    SINGLE_TWO_JOB_GROUP,
    seed_workspace_matrix,
)
from src.schedule.core.move_fields import (
    PICK_MOVE,
    PLACE_MOVE,
    PRE_PREPARE_MOVE,
    PROCESS_MOVE,
    SWAP_MOVE,
)


RESIDENCY_LIMIT_SECONDS = 30.0
MINIMUM_MAKESPAN_IMPROVEMENT_RATIO = 0.05


class _LegacyOneWaySelector:
    """复现改造前只做单向 LoadLock 搬运的最早窗口规则。"""

    def __init__(self, _problem=None) -> None:
        """兼容生产启发式 selector 的构造签名。"""

    def choose(self, _state, actions) -> str:
        """过滤交换候选后按旧排序选择动作。"""
        one_way_actions = [
            action
            for action in actions
            if action.kind != "ll_exchange"
        ] or list(actions)
        return min(
            one_way_actions,
            key=lambda action: (
                action.earliest_start,
                -action.stage_index,
                action.finish_time,
                action.wafer_id,
                action.destination_station,
            ),
        ).action_id


def _residency_violations(moves: list[dict]) -> list[tuple[object, float]]:
    """统计 PM 加工完成到晶圆离腔之间超过测试上限的晶圆。"""
    process_end: dict[object, float] = {}
    departure_start: dict[object, float] = {}
    for move in moves:
        if (
            move.get("MoveType") == PROCESS_MOVE
            and str(move.get("ModuleName") or "").startswith("PM")
            and move.get("MatIDList")
        ):
            process_end[move["MatIDList"][0]] = float(move["EndTime"])
        if (
            move.get("MoveType") == PICK_MOVE
            and str((move.get("SrcStationList") or [""])[0]).startswith("PM")
            and move.get("MatIDList")
        ):
            departure_start[move["MatIDList"][0]] = float(move["StartTime"])
        if (
            move.get("MoveType") == SWAP_MOVE
            and str((move.get("StationList") or [""])[0]).startswith("PM")
            and move.get("RecvMatList")
        ):
            departure_start[move["RecvMatList"][0]] = float(move["StartTime"])
    return [
        (material_id, departure_start[material_id] - completed_at)
        for material_id, completed_at in process_end.items()
        if material_id in departure_start
        and departure_start[material_id] - completed_at
        > RESIDENCY_LIMIT_SECONDS + 1e-6
    ]


def _robot_transfer_pairs(moves: list[dict], robot_name: str) -> list[tuple[dict, dict]]:
    """按执行顺序返回指定 Robot 相邻的取、放、换片动作。"""
    transfers = sorted(
        (
            move
            for move in moves
            if move.get("MoveType") in {PICK_MOVE, PLACE_MOVE, SWAP_MOVE}
            and str(move.get("Robot") or move.get("ModuleName") or "")
            == robot_name
        ),
        key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move.get("MoveID") or 0),
        ),
    )
    return list(zip(transfers, transfers[1:]))


def _transfer_station(move: dict) -> str:
    """读取取、放或换片动作的首个目标站点。"""
    for key in ("StationList", "DestStationList", "SrcStationList"):
        values = move.get(key) or []
        if values:
            return str(values[0])
    return ""


class LoadLockExchangeFrontendTests(unittest.TestCase):
    """从前端持久化测试集执行新旧策略并比较真实 MoveList。"""

    def test_short_process_exchange_beats_previous_one_way_result(self) -> None:
        """5 秒六腔场景应缩短总时长、消除驻留超时并减少空压力循环。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            report = seed_workspace_matrix(store_path)
            device = scheduler_server.get_workspace_device(
                str(report["sixPmDeviceId"]),
                store_path,
            )
            test_case = next(
                test
                for test in device["tests"]
                if test.get("group") == LOADLOCK_CADENCE_GROUP
                and test.get("name") == LOADLOCK_CADENCE_TEST
            )
            plan = build_workspace_batch_plan(
                device,
                test_case,
                "heuristic",
                test_case.get("options") or {},
            )

            current_result = scheduler_server.execute_plan(plan)
            with patch(
                "src.schedule.machine_policy.HeuristicMachineSelector",
                _LegacyOneWaySelector,
            ):
                previous_result = scheduler_server.execute_plan(plan)

            current_moves = current_result["output"]["MoveList"]
            previous_moves = previous_result["output"]["MoveList"]
            current_empty_cycles = sum(
                move.get("MoveType") == PRE_PREPARE_MOVE
                and not move.get("MatIDList")
                for move in current_moves
            )
            previous_empty_cycles = sum(
                move.get("MoveType") == PRE_PREPARE_MOVE
                and not move.get("MatIDList")
                for move in previous_moves
            )

            self.assertEqual("passed", current_result["validation"])
            self.assertEqual([], _residency_violations(current_moves))
            self.assertTrue(_residency_violations(previous_moves))
            self.assertLess(current_empty_cycles, previous_empty_cycles)
            self.assertLessEqual(
                float(current_result["makespan"]),
                float(previous_result["makespan"])
                * (1.0 - MINIMUM_MAKESPAN_IMPROVEMENT_RATIO),
            )

    def test_t1_identical_jobs_use_loadlock_swap_without_double_place(self) -> None:
        """前端 t1 应以原子 Swap 换片，且优于禁用交换的旧式单向结果。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            report = seed_workspace_matrix(store_path)
            device = scheduler_server.get_workspace_device(
                str(report["fourPmDeviceId"]),
                store_path,
            )
            test_case = next(
                test
                for test in device["tests"]
                if test.get("group") == SINGLE_TWO_JOB_GROUP
                and test.get("name") == "t1"
            )
            plan = build_workspace_batch_plan(
                device,
                test_case,
                "heuristic",
                test_case.get("options") or {},
            )

            current_result = scheduler_server.execute_plan(plan)
            with patch(
                "src.schedule.machine_policy.HeuristicMachineSelector",
                _LegacyOneWaySelector,
            ):
                previous_result = scheduler_server.execute_plan(plan)

            current_moves = current_result["output"]["MoveList"]
            vtr_pairs = _robot_transfer_pairs(current_moves, "VTR")
            loadlock_names = {"LA", "LB"}
            loadlock_swaps = [
                move
                for move in current_moves
                if move.get("MoveType") == SWAP_MOVE
                and str(move.get("Robot") or move.get("ModuleName") or "") == "VTR"
                and _transfer_station(move) in loadlock_names
            ]
            loadlock_place_pick = [
                (left, right)
                for left, right in vtr_pairs
                if left.get("MoveType") == PLACE_MOVE
                and right.get("MoveType") == PICK_MOVE
                and _transfer_station(left) == _transfer_station(right)
                and _transfer_station(left) in loadlock_names
            ]
            consecutive_places = [
                (left, right)
                for left, right in vtr_pairs
                if left.get("MoveType") == PLACE_MOVE
                and right.get("MoveType") == PLACE_MOVE
            ]

            self.assertEqual("passed", current_result["validation"])
            self.assertTrue(loadlock_swaps)
            self.assertEqual([], loadlock_place_pick)
            self.assertEqual([], consecutive_places)
            self.assertLess(
                float(current_result["makespan"]),
                float(previous_result["makespan"]),
            )


if __name__ == "__main__":
    unittest.main()
