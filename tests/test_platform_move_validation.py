"""平台独立 MoveList 状态记录器的单腔与双腔物理回归测试。"""

from __future__ import annotations

from realtime_scheduler.move_validation import (
    ATMOSPHERE,
    VACUUM,
    LoadLockState,
    MoveStateReplay,
    SlotPhase,
    validate_move_list,
)


def _dual_chamber_update() -> dict:
    """创建两槽 PM、两槽 LoadLock 和双槽单 Arm 的最小设备快照。"""
    scope = ["PM1", "LL1"]
    return {
        "Stations": {
            "PM1": {"Type": "MultiProcessChamber", "Capacity": 2},
            "LL1": {
                "Type": "LoadLock",
                "Capacity": 2,
                "LastItem": "ATMRobot",
                "PrePrepareTime": [
                    {
                        "PrePrepareType": "PumpTime",
                        "LastItem": "ATMRobot",
                        "CurrentItem": "VACRobot",
                    },
                    {
                        "PrePrepareType": "VentTime",
                        "LastItem": "VACRobot",
                        "CurrentItem": "ATMRobot",
                    },
                ],
            },
        },
        "Robots": {
            "VACRobot": {
                "Type": "VTMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": scope,
                    },
                },
            },
            "ATMRobot": {
                "Type": "ATMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": ["LL1"],
                    },
                },
            },
        },
        "Materials": [
            {"ID": 101, "CurrentModuleName": "PM1", "SlotID": 1, "StepID": 4},
            {"ID": 102, "CurrentModuleName": "PM1", "SlotID": 2, "StepID": 4},
        ],
    }


def _move(move_id: int, move_type: int, start: float, end: float, **fields) -> dict:
    """创建测试使用的标准 Move 行。"""
    return {
        "MoveID": move_id,
        "MoveType": move_type,
        "StartTime": start,
        "EndTime": end,
        **fields,
    }


def _dual_transfer_moves() -> list[dict]:
    """创建双片从 PM 搬到 LL、满载充气并由大气手取出的完整动作链。"""
    return [
        _move(1, 10, 0, 1, ModuleName="LL1", LastState=ATMOSPHERE, CurState=VACUUM, MatIDList=[]),
        _move(2, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(
            3, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
            StepIDList=[5, 5],
        ),
        _move(4, 7, 2, 3, ModuleName="PM1"),
        _move(
            5, 5, 3, 4, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1"], DestStationList=["LL1"], RobotSlotList=[1, 2],
        ),
        _move(6, 6, 4, 5, ModuleName="LL1", RelatedRobotType=1),
        _move(
            7, 1, 5, 6, ModuleName="VACRobot", MatIDList=[101, 102],
            DestStationList=["LL1", "LL1"], DestSlotList=[1, 2], RobotSlotList=[1, 2],
            StepIDList=[6, 6],
        ),
        _move(8, 7, 6, 7, ModuleName="LL1"),
        _move(
            9, 10, 7, 8, ModuleName="LL1", LastState=VACUUM, CurState=ATMOSPHERE,
            MatIDList=[101, 102], SlotList=[1, 2],
        ),
        _move(10, 6, 8, 9, ModuleName="LL1", RelatedRobotType=0),
        _move(
            11, 0, 9, 10, ModuleName="ATMRobot", MatIDList=[101, 102],
            SrcStationList=["LL1", "LL1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
            StepIDList=[7, 7],
        ),
    ]


def test_dual_slot_pick_place_and_full_loadlock_transition_are_physically_valid() -> None:
    """同一 Arm 双槽搬两片、LL 满载充气都应通过平台校验。"""
    assert validate_move_list(None, _dual_transfer_moves(), _dual_chamber_update()) == []


def test_replay_tracks_both_robot_slots_and_both_loadlock_slots() -> None:
    """实时通知回放后，两片晶圆必须分别落到两个机器人手槽。"""
    moves = _dual_transfer_moves()
    replay = MoveStateReplay(None, moves, _dual_chamber_update())
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)

    loadlock = replay.state.stations["LL1"]
    assert isinstance(loadlock, LoadLockState)
    assert loadlock.environment == ATMOSPHERE
    assert [loadlock.slots[index].material for index in (1, 2)] == [None, None]
    assert [replay.state.robots["ATMRobot"].hands[index].material_id for index in (1, 2)] == [101, 102]


def test_independent_second_pick_is_allowed_while_another_hand_slot_holds_wafer() -> None:
    """策略可偏好 Swap，但物理校验不能禁止机器人用另一个空手槽继续 Pick。"""
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(2, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101], SrcStationList=["PM1"], SrcSlotList=[1], RobotSlotList=[1]),
        _move(3, 0, 2, 3, ModuleName="VACRobot", MatIDList=[102], SrcStationList=["PM1"], SrcSlotList=[2], RobotSlotList=[2]),
    ]
    assert validate_move_list(None, moves, _dual_chamber_update()) == []


def test_dual_chamber_process_updates_both_physical_slots() -> None:
    """一条双片 ProcessMove 应同时占用并完成双腔的两个物理槽位。"""
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(
            2, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
        ),
        _move(
            3, 1, 2, 3, ModuleName="VACRobot", MatIDList=[101, 102],
            DestStationList=["PM1", "PM1"], DestSlotList=[1, 2], RobotSlotList=[1, 2],
        ),
        _move(4, 7, 3, 4, ModuleName="PM1"),
        _move(5, 9, 4, 8, ModuleName="PM1", MatIDList=[101, 102], SlotList=[1, 2]),
    ]
    assert validate_move_list(None, moves, _dual_chamber_update()) == []

    replay = MoveStateReplay(None, moves, _dual_chamber_update())
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert [replay.state.stations["PM1"].slots[index].phase for index in (1, 2)] == [
        SlotPhase.COMPLETED,
        SlotPhase.COMPLETED,
    ]
