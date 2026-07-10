"""MoveList 状态回放验证的回归测试。"""

import unittest

from src.model import Chamber, Problem, Robot, Stage, Wafer
from src.validation import validate_move_list


def _stage(index: int, station: str, slot: int = 0) -> Stage:
    """构造仅用于初始物料落位的最小工序。"""
    return Stage(index, station, "source" if index == 0 else "process", 0.0, "", "R", 0.0, slot=slot)


def _problem(*, robot_capacity: int = 1, wafers=None, pm_capacity: int = 1) -> Problem:
    """构造含装载口、工艺腔、LoadLock 和一个机器人的验证拓扑。"""
    wafers = list(wafers or [Wafer(0, 1, "route", 0, [_stage(0, "LP")], [], "P")])
    return Problem(
        chambers={
            "LP": Chamber("LP", "LoadPort", 2),
            "PM1": Chamber("PM1", "ProcessChamber", pm_capacity),
            "LL": Chamber("LL", "LoadLock", 1),
        },
        robots={"R": Robot("R", ["LP", "PM1", "LL"], robot_capacity, robot_capacity >= 2)},
        wafers=wafers,
    )


def _move(move_id: int, move_type: int, start: float, end: float, **fields) -> dict:
    """构造带有公共时间字段的 MoveList 行。"""
    return {"MoveID": move_id, "MoveType": move_type, "StartTime": start, "EndTime": end, **fields}


class ValidationStateTests(unittest.TestCase):
    """覆盖状态类驱动的主要合法和非法 Move 组合。"""

    def test_valid_pick_place_process_and_pick_completed_material(self) -> None:
        """物料放入后需加工完成，才能再次开门取走。"""
        moves = [
            _move(1, 6, 0, 1, ModuleName="LP", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
            _move(2, 0, 1, 2, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], SrcSlotList=[1], MatIDList=[1]),
            _move(3, 7, 2, 3, ModuleName="LP"),
            _move(4, 5, 2, 4, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], DestStationList=["PM1"], MatIDList=[1]),
            _move(5, 6, 3, 4, ModuleName="PM1", SlotList=[1], RelatedActionType=0, MatIDList=[1]),
            _move(6, 1, 4, 5, Robot="R", RobotSlotList=[1], DestStationList=["PM1"], DestSlotList=[1], MatIDList=[1]),
            _move(7, 7, 5, 6, ModuleName="PM1"),
            _move(8, 9, 6, 8, ModuleName="PM1", SlotList=[1], MatIDList=[1]),
            _move(9, 6, 8, 9, ModuleName="PM1", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
            _move(10, 0, 9, 10, Robot="R", RobotSlotList=[1], SrcStationList=["PM1"], SrcSlotList=[1], MatIDList=[1]),
        ]
        self.assertEqual(validate_move_list(_problem(), moves), [])

    def test_pick_requires_open_door(self) -> None:
        """门关着时不能直接取片。"""
        issues = validate_move_list(_problem(), [_move(1, 0, 0, 1, Robot="R", SrcStationList=["LP"], SrcSlotList=[1], MatIDList=[1])])
        self.assertIn("门当前为关门", issues[0])

    def test_open_for_pick_requires_completed_material(self) -> None:
        """放入但未加工完成的物料不能作为开门取片目标。"""
        moves = [
            _move(1, 6, 0, 1, ModuleName="LP", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
            _move(2, 0, 1, 2, Robot="R", SrcStationList=["LP"], SrcSlotList=[1], MatIDList=[1]),
            _move(3, 7, 2, 3, ModuleName="LP"),
            _move(4, 5, 2, 4, Robot="R", SrcStationList=["LP"], DestStationList=["PM1"], MatIDList=[1]),
            _move(5, 6, 3, 4, ModuleName="PM1", SlotList=[1], RelatedActionType=0, MatIDList=[1]),
            _move(6, 1, 4, 5, Robot="R", DestStationList=["PM1"], DestSlotList=[1], MatIDList=[1]),
            _move(7, 7, 5, 6, ModuleName="PM1"),
            _move(8, 6, 6, 7, ModuleName="PM1", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
        ]
        issues = validate_move_list(_problem(), moves)
        self.assertIn("没有可取的已完成物料", issues[0])

    def test_place_requires_empty_hand_and_empty_slot(self) -> None:
        """空手放片和向非空槽放片都必须报错。"""
        empty_hand = [
            _move(1, 6, 0, 1, ModuleName="PM1", SlotList=[1], RelatedActionType=0, MatIDList=[1]),
            _move(2, 1, 1, 2, Robot="R", DestStationList=["PM1"], DestSlotList=[1], MatIDList=[1]),
        ]
        self.assertIn("没有匹配物料", validate_move_list(_problem(), empty_hand)[0])

        wafer = Wafer(0, 2, "route", 0, [_stage(0, "PM1")], [], "P")
        occupied = [_move(1, 6, 0, 1, ModuleName="PM1", SlotList=[1], RelatedActionType=0, MatIDList=[1])]
        self.assertIn("不是可放片空槽", validate_move_list(_problem(wafers=[wafer]), occupied)[0])

    def test_cleaning_blocks_open_until_completion_and_preserves_cleaned_state(self) -> None:
        """清洁占用期间不能开门，结束后已清洁槽位可接收物料。"""
        blocked = [
            _move(1, 9, 0, 5, ModuleName="PM1", SlotList=[1], MatIDList=[]),
            _move(2, 6, 1, 2, ModuleName="PM1", SlotList=[1], RelatedActionType=0, MatIDList=[1]),
        ]
        self.assertIn("尚未完成的加工或清洁", validate_move_list(_problem(), blocked)[0])
        self.assertEqual(validate_move_list(_problem(), [_move(1, 9, 0, 1, ModuleName="PM1", SlotList=[1], MatIDList=[])]), [])

        other_slot = [
            _move(1, 9, 0, 5, ModuleName="PM1", SlotList=[1], MatIDList=[]),
            _move(2, 6, 1, 2, ModuleName="PM1", SlotList=[2], RelatedActionType=0, MatIDList=[1]),
        ]
        self.assertEqual(validate_move_list(_problem(pm_capacity=2), other_slot), [])

        same_start = [
            _move(1, 9, 2, 5, ModuleName="PM1", SlotList=[2], MatIDList=[]),
            _move(2, 6, 2, 3, ModuleName="PM1", SlotList=[1], RelatedActionType=0, MatIDList=[1]),
        ]
        self.assertEqual(validate_move_list(_problem(pm_capacity=2), same_start), [])

    def test_initial_materials_from_init_data_override_task_slots(self) -> None:
        """init data 的 Materials 应覆盖任务首工序中给出的初始落位。"""
        init_data = {
            "Robots": {"R": {"ArmInfo": {"ArmA": {"SlotIDs": [1], "AccessibleStations": ["LP"]}}}},
            "Stations": {"LP": {"Type": "LoadPort", "Slots": [1, 2]}},
            "Materials": [{"ID": 1, "CurrentModuleName": "LP", "SlotID": 2, "PJobName": "P", "StepID": 0}],
        }
        moves = [
            _move(1, 6, 0, 1, ModuleName="LP", SlotList=[2], RelatedActionType=1, MatIDList=[1]),
            _move(2, 0, 1, 2, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], SrcSlotList=[2], MatIDList=[1]),
        ]
        self.assertEqual(validate_move_list(_problem(), moves, init_data), [])

    def test_load_lock_environment_must_match_opening_robot(self) -> None:
        """LoadLock 在真空时不能向大气机器人开门。"""
        moves = [
            _move(1, 10, 0, 1, ModuleName="LL", LastState="ATM", CurState="VAC"),
            _move(2, 6, 1, 2, ModuleName="LL", SlotList=[1], RelatedActionType=0, RelatedRobotType=0, MatIDList=[1]),
        ]
        issues = validate_move_list(_problem(), moves)
        self.assertIn("当前环境为 VAC，不是 ATM", issues[0])

    def test_environment_chain_must_continue(self) -> None:
        """抽充气必须从当前环境连续转换。"""
        moves = [
            _move(1, 10, 0, 1, ModuleName="LL", LastState="ATM", CurState="VAC"),
            _move(2, 10, 1, 2, ModuleName="LL", LastState="ATM", CurState="VAC"),
        ]
        self.assertIn("当前环境为 VAC，不是 ATM", validate_move_list(_problem(), moves)[0])

        self.assertEqual(
            validate_move_list(_problem(), [_move(1, 10, 0, 1, ModuleName="LL", LastState="ATR", CurState="VTR")]),
            [],
        )

    def test_load_lock_preprepare_completes_material(self) -> None:
        """LoadLock 抽充气完成后，槽内物料应可被真空侧取出。"""
        moves = [
            _move(1, 6, 0, 1, ModuleName="LP", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
            _move(2, 0, 1, 2, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], SrcSlotList=[1], MatIDList=[1]),
            _move(3, 7, 2, 3, ModuleName="LP"),
            _move(4, 5, 2, 4, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], DestStationList=["LL"], MatIDList=[1]),
            _move(5, 6, 3, 4, ModuleName="LL", SlotList=[1], RelatedActionType=0, RelatedRobotType=0, MatIDList=[1]),
            _move(6, 1, 4, 5, Robot="R", RobotSlotList=[1], DestStationList=["LL"], DestSlotList=[1], MatIDList=[1]),
            _move(7, 7, 5, 6, ModuleName="LL"),
            _move(8, 10, 6, 8, ModuleName="LL", MatIDList=[1], LastState="ATM", CurState="VAC"),
            _move(9, 6, 8, 9, ModuleName="LL", SlotList=[1], RelatedActionType=1, RelatedRobotType=1, MatIDList=[1]),
            _move(10, 0, 9, 10, Robot="R", RobotSlotList=[1], SrcStationList=["LL"], SrcSlotList=[1], MatIDList=[1]),
        ]
        self.assertEqual(validate_move_list(_problem(), moves), [])

    def test_robot_initial_position_and_pretrans_are_checked(self) -> None:
        """init data 的 SlotAtStation 应限制首个转位动作的来源。"""
        init_data = {
            "Robots": {"R": {"ArmInfo": {"ArmA": {"SlotIDs": [1], "SlotAtStation": "LP", "AccessibleStations": ["LP", "PM1"]}}}},
            "Stations": {"LP": {"Slots": [1]}, "PM1": {"Slots": [1]}},
        }
        moves = [_move(1, 5, 0, 1, Robot="R", RobotSlotList=[1], SrcStationList=["PM1"], DestStationList=["LP"])]
        self.assertIn("当前指向 LP，不是 PM1", validate_move_list(_problem(), moves, init_data)[0])

        blank_source = [_move(1, 5, 0, 1, Robot="R", RobotSlotList=[1], SrcStationList=[""], DestStationList=["LP"])]
        self.assertEqual(validate_move_list(_problem(), blank_source, init_data), [])

    def test_robot_and_station_transfer_overlaps_are_rejected(self) -> None:
        """同一机器人和同一站点的取放动作不能在执行窗口重叠。"""
        robot_overlap = [
            _move(1, 5, 0, 3, Robot="R", SrcStationList=["LP"], DestStationList=["PM1"]),
            _move(2, 5, 1, 2, Robot="R", SrcStationList=["PM1"], DestStationList=["LP"]),
        ]
        self.assertIn("正在执行其他动作", validate_move_list(_problem(), robot_overlap)[0])

    def test_pick_rejects_full_or_disabled_robot_hand(self) -> None:
        """已持片手槽和未启用手槽都不能作为新的取片目标。"""
        wafers = [
            Wafer(0, 1, "route", 0, [_stage(0, "LP", 0)], [], "P"),
            Wafer(1, 2, "route", 1, [_stage(0, "LP", 1)], [], "P"),
        ]
        full_hand = [
            _move(1, 6, 0, 1, ModuleName="LP", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
            _move(2, 0, 1, 2, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], SrcSlotList=[1], MatIDList=[1]),
            _move(3, 7, 2, 3, ModuleName="LP"),
            _move(4, 6, 3, 4, ModuleName="LP", SlotList=[2], RelatedActionType=1, MatIDList=[2]),
            _move(5, 0, 4, 5, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], SrcSlotList=[2], MatIDList=[2]),
        ]
        self.assertIn("不是空手", validate_move_list(_problem(wafers=wafers), full_hand)[0])

        disabled_hand = [_move(1, 5, 0, 1, Robot="R", RobotSlotList=[2], SrcStationList=["LP"], DestStationList=["PM1"])]
        self.assertIn("未启用手槽", validate_move_list(_problem(), disabled_hand)[0])

    def test_processing_can_run_on_multiple_slots_in_parallel(self) -> None:
        """多槽腔室在门关闭时允许不同槽位并行加工。"""
        wafers = [
            Wafer(0, 1, "route", 0, [_stage(0, "LP", 0)], [], "P"),
            Wafer(1, 2, "route", 1, [_stage(0, "LP", 1)], [], "P"),
        ]
        moves = [
            _move(1, 6, 0, 1, ModuleName="LP", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
            _move(2, 0, 1, 2, Robot="R", SrcStationList=["LP"], SrcSlotList=[1], MatIDList=[1]),
            _move(3, 7, 2, 3, ModuleName="LP"),
            _move(4, 5, 2, 4, Robot="R", SrcStationList=["LP"], DestStationList=["PM1"], MatIDList=[1]),
            _move(5, 6, 3, 4, ModuleName="PM1", SlotList=[1], RelatedActionType=0, MatIDList=[1]),
            _move(6, 1, 4, 5, Robot="R", DestStationList=["PM1"], DestSlotList=[1], MatIDList=[1]),
            _move(7, 7, 5, 6, ModuleName="PM1"),
            _move(8, 5, 5, 7, Robot="R", SrcStationList=["PM1"], DestStationList=["LP"]),
            _move(9, 6, 6, 7, ModuleName="LP", SlotList=[2], RelatedActionType=1, MatIDList=[2]),
            _move(10, 0, 7, 8, Robot="R", SrcStationList=["LP"], SrcSlotList=[2], MatIDList=[2]),
            _move(11, 7, 8, 9, ModuleName="LP"),
            _move(12, 5, 8, 10, Robot="R", SrcStationList=["LP"], DestStationList=["PM1"]),
            _move(13, 6, 9, 10, ModuleName="PM1", SlotList=[2], RelatedActionType=0, MatIDList=[2]),
            _move(14, 1, 10, 11, Robot="R", DestStationList=["PM1"], DestSlotList=[2], MatIDList=[2]),
            _move(15, 7, 11, 12, ModuleName="PM1"),
            _move(16, 9, 12, 17, ModuleName="PM1", SlotList=[1], MatIDList=[1]),
            _move(17, 9, 13, 16, ModuleName="PM1", SlotList=[2], MatIDList=[2]),
        ]
        self.assertEqual(validate_move_list(_problem(pm_capacity=2, wafers=wafers), moves), [])

    def test_swap_updates_station_and_robot_at_completion(self) -> None:
        """同站换片应把站内完成物料换到空手，并把手中物料放回槽位。"""
        wafers = [
            Wafer(0, 1, "route", 0, [_stage(0, "LP")], [], "P"),
            Wafer(1, 2, "route", 1, [_stage(0, "PM1")], [], "P"),
        ]
        moves = [
            _move(1, 6, 0, 1, ModuleName="LP", SlotList=[1], RelatedActionType=1, MatIDList=[1]),
            _move(2, 0, 1, 2, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], SrcSlotList=[1], MatIDList=[1]),
            _move(3, 7, 2, 3, ModuleName="LP"),
            _move(4, 5, 2, 3, Robot="R", RobotSlotList=[1], SrcStationList=["LP"], DestStationList=["PM1"], MatIDList=[1]),
            _move(5, 6, 3, 4, ModuleName="PM1", SlotList=[1], RelatedActionType=2, MatIDList=[1, 2]),
            _move(6, 4, 4, 5, Robot="R", StationList=["PM1", "PM1"], StnRecvSlotList=[1], StnSendSlotList=[1], RecvSlotList=[2], SendSlotList=[1], RecvMatList=[2], SendMatList=[1]),
        ]
        self.assertEqual(validate_move_list(_problem(robot_capacity=2, wafers=wafers), moves), [])

    def test_premove_ids_do_not_affect_validation(self) -> None:
        """PreMoveID 即使不合法也不能改变状态校验结果。"""
        moves = [_move(1, 9, 0, 1, ModuleName="PM1", SlotList=[1], MatIDList=[], PreMoveID=[999])]
        self.assertEqual(validate_move_list(_problem(), moves), [])


if __name__ == "__main__":
    unittest.main()
