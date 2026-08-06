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
        _move(1, 10, 0, 1, ModuleName="LL1", LastState="ATMRobot", CurState="VACRobot", MatIDList=[]),
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
            9, 10, 7, 8, ModuleName="LL1", LastState="VACRobot", CurState="ATMRobot",
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


def test_empty_pretrans_may_carry_future_pick_material_id() -> None:
    """Pick 明确引用的空载 PreTrans 可用 MatIDList 标注将要运输的晶圆。"""
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1, MatIDList=[101]),
        _move(
            2, 5, 1, 1, ModuleName="VACRobot", MatIDList=[101],
            SrcStationList=["PM1"], DestStationList=["PM1"],
            DestSlotList=[1], RobotSlotList=[1],
        ),
        _move(
            3, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101],
            SrcStationList=["PM1"], SrcSlotList=[1], RobotSlotList=[1],
            PreMoveID=[1, 2],
        ),
    ]

    assert validate_move_list(None, moves, _dual_chamber_update()) == []

    replay = MoveStateReplay(None, moves, _dual_chamber_update())
    for move in moves:
        replay.update_move_state(
            {"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING},
            snapshot=False,
        )
        replay.update_move_state(
            {"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE},
            snapshot=False,
        )
    assert replay.state.robots["VACRobot"].hands[1].material_id == 101


def test_empty_pretrans_material_annotation_requires_matching_linked_pick() -> None:
    """没有匹配后继 Pick 的物料标注仍按带片 PreTrans 校验并报错。"""
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1, MatIDList=[101]),
        _move(
            2, 5, 1, 1, ModuleName="VACRobot", MatIDList=[101],
            SrcStationList=["PM1"], DestStationList=["PM1"],
            DestSlotList=[1], RobotSlotList=[1],
        ),
        _move(
            3, 0, 1, 2, ModuleName="VACRobot", MatIDList=[102],
            SrcStationList=["PM1"], SrcSlotList=[2], RobotSlotList=[1],
            PreMoveID=[1, 2],
        ),
    ]

    issues = validate_move_list(None, moves, _dual_chamber_update())
    assert issues == ["MoveID=2 MoveType=5：VACRobot#1 持有物料与 Move 不匹配"]


def test_standard_algorithm_swap_move_with_repeated_station_passes() -> None:
    """标准算法导出的 SwapMove（StationList 同一站点重复两条、物料槽位单组）应通过校验。

    双臂 PM 换片导出为 StationList=[chamber, chamber]（一进一出各占一条），而
    RecvMatList/SendMatList/槽位数组都只有一组；站点数量不得参与数组数量判定。
    """
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(2, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101], SrcStationList=["PM1"], SrcSlotList=[1], RobotSlotList=[1]),
        _move(3, 1, 2, 3, ModuleName="VACRobot", MatIDList=[101], DestStationList=["PM1"], DestSlotList=[1], RobotSlotList=[1]),
        _move(4, 7, 3, 4, ModuleName="PM1"),
        _move(5, 9, 4, 8, ModuleName="PM1", MatIDList=[101], SlotList=[1]),
        _move(6, 6, 8, 9, ModuleName="PM1", RelatedRobotType=1),
        _move(7, 0, 9, 10, ModuleName="VACRobot", MatIDList=[102], SrcStationList=["PM1"], SrcSlotList=[2], RobotSlotList=[2]),
        _move(8, 4, 10, 11, ModuleName="VACRobot",
              StationList=["PM1", "PM1"], StnRecvSlotList=[1], StnSendSlotList=[1],
              RecvSlotList=[1], SendSlotList=[2], RecvMatList=[101], SendMatList=[102]),
    ]
    assert validate_move_list(None, moves, _dual_chamber_update()) == []


def test_swap_move_rejects_distinct_stations() -> None:
    """原子 Swap 必须作用于同一个站点，跨站组合应报错。"""
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(2, 4, 1, 2, ModuleName="VACRobot",
              StationList=["PM1", "LL1"], StnRecvSlotList=[1], StnSendSlotList=[1],
              RecvSlotList=[1], SendSlotList=[2], RecvMatList=[101], SendMatList=[102]),
    ]
    issues = validate_move_list(None, moves, _dual_chamber_update())
    assert issues == ["MoveID=2 MoveType=4：SwapMove 必须引用同一个站点"]


def _cascade_loadlock_update() -> dict:
    """级联 LoadLock：连接 VTR_1/VTR_2 两个真空手，初始 LastItem 为空、State=0（大气态）。"""
    return {
        "Stations": {
            "PM1": {"Type": "MultiProcessChamber", "Capacity": 2},
            "LL1": {
                "Type": "LoadLock",
                "Capacity": 2,
                "LastItem": "",
                "State": 0,
                "PrePrepareTime": [
                    {"PrePrepareType": "PumpTime", "LastItem": "VTR_1", "CurrentItem": "VTR_2"},
                    {"PrePrepareType": "VentTime", "LastItem": "VTR_2", "CurrentItem": "VTR_1"},
                ],
            },
        },
        "Robots": {
            robot_name: {
                "Type": "VTMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": ["PM1", "LL1"],
                    },
                },
            }
            for robot_name in ("VTR_1", "VTR_2")
        },
        "Materials": [],
    }


def test_cascade_loadlock_first_prepare_transitions_atr_to_vtr() -> None:
    """级联 LoadLock 初始 LastItem 为空判定大气；首条 pre_prepare 从 ATR_1 切到 VTR_1。

    设备只配置 VTR_1/VTR_2 两侧，但第一个抽真空动作可以从大气手 ATR_1 起始
    （对应 State=0/LastItem="" 的初始大气态），LastState=ATR_1 应被识别为大气；
    之后才在 VTR_1（pump 前侧）与 VTR_2（pump 后侧）之间切换。
    """
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="ATR_1", CurState="VTR_1", MatIDList=[]),
        _move(2, 10, 2, 4, ModuleName="LL1", LastState="VTR_1", CurState="VTR_2", MatIDList=[]),
    ]
    assert validate_move_list(None, moves, _cascade_loadlock_update()) == []

    replay = MoveStateReplay(None, moves, _cascade_loadlock_update())
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["LL1"].environment == VACUUM


def test_first_environment_move_exemption_allows_atr_start() -> None:
    """级联 LoadLock 的首条切换可从未声明的初始大气手 ATR_1 起始（豁免放行）。

    第一条 ATR_1→VTR_1 不在 PrePrepareTime 状态空间 {VTR_1, VTR_2} 内，平台豁免
    该条校验但照常执行；第二条 VTR_1→VTR_2 属合法状态空间，正常执行并把环境切到真空。
    """
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="ATR_1", CurState="VTR_1", MatIDList=[]),
        _move(2, 10, 2, 4, ModuleName="LL1", LastState="VTR_1", CurState="VTR_2", MatIDList=[]),
    ]
    assert validate_move_list(None, moves, _cascade_loadlock_update()) == []

    replay = MoveStateReplay(None, moves, _cascade_loadlock_update())
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["LL1"].environment == VACUUM


def test_first_environment_move_exemption_executes_and_updates_state() -> None:
    """豁免的首条越界切换不再跳过，而是执行并把 LoadLock 状态更新为 CurState。

    首条 ATR_1→VTR_2 的 LastState 不在状态空间，但 CurState=VTR_2 对应真空侧；
    豁免执行后环境应立即更新为 VACUUM（而不是停留在初始大气）。
    """
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="ATR_1", CurState="VTR_2", MatIDList=[]),
    ]
    assert validate_move_list(None, moves, _cascade_loadlock_update()) == []

    replay = MoveStateReplay(None, moves, _cascade_loadlock_update())
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["LL1"].environment == VACUUM


def test_exempted_first_switch_with_material_marks_slot_completed() -> None:
    """豁免的首条越界切换带片时，照常完成槽位物料转换并更新环境。"""
    update = _cascade_loadlock_update()
    update["Materials"] = [{"ID": 1, "CurrentModuleName": "LL1", "SlotID": 1, "StepID": 4}]
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="ATR_1", CurState="VTR_2", MatIDList=[1], SlotList=[1]),
    ]
    assert validate_move_list(None, moves, update) == []

    replay = MoveStateReplay(None, moves, update)
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["LL1"].environment == VACUUM
    assert replay.state.stations["LL1"].slots[1].phase == SlotPhase.COMPLETED


def test_exempted_first_switch_rejects_unresolvable_curstate() -> None:
    """豁免不适用于 CurState 无法解析为压力态的陌生标签（避免污染环境）。"""
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="ATR_1", CurState="Foo", MatIDList=[]),
    ]
    issues = validate_move_list(None, moves, _cascade_loadlock_update())
    assert issues and "状态空间" in issues[0]
    """豁免只覆盖第一条；第二条起 LastState/CurState 不在状态空间仍报错。"""
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="ATR_1", CurState="VTR_1", MatIDList=[]),
        _move(2, 10, 2, 4, ModuleName="LL1", LastState="ATR_1", CurState="VTR_1", MatIDList=[]),
    ]
    issues = validate_move_list(None, moves, _cascade_loadlock_update())
    assert issues and "状态空间" in issues[0]


def test_environment_exemption_is_per_loadlock_and_once_only() -> None:
    """豁免机会按 LoadLock 独立且只生效一次：两个级联 LL 各可豁免首条。"""
    update = _cascade_loadlock_update()
    update["Stations"]["LL2"] = dict(update["Stations"]["LL1"])
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="ATR_1", CurState="VTR_1", MatIDList=[]),
        _move(2, 10, 0, 2, ModuleName="LL2", LastState="ATR_1", CurState="VTR_1", MatIDList=[]),
    ]
    assert validate_move_list(None, moves, update) == []
    # 两个 LL 的豁免都已消耗，第三条任意 LL 的越界切换仍报错。
    moves.append(_move(3, 10, 2, 4, ModuleName="LL1", LastState="ATR_1", CurState="VTR_1", MatIDList=[]))
    issues = validate_move_list(None, moves, update)
    assert issues and "状态空间" in issues[0]


def _cascade_dbr_update() -> dict:
    """12kChamber 的 DBR 桥接 LoadLock：连接 VTR_1/VTR_2 两个真空手，初始大气。"""
    return {
        "Stations": {
            "PM1": {"Type": "MultiProcessChamber", "Capacity": 2},
            "DBR": {
                "Type": "LoadLock",
                "Capacity": 2,
                "LastItem": "",
                "State": 0,
                "PrePrepareTime": [
                    {"PrePrepareType": "PumpTime", "LastItem": "VTR_1", "CurrentItem": "VTR_2"},
                    {"PrePrepareType": "VentTime", "LastItem": "VTR_2", "CurrentItem": "VTR_1"},
                ],
            },
        },
        "Robots": {
            robot_name: {
                "Type": "VTMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": ["PM1", "DBR"],
                    },
                },
            }
            for robot_name in ("VTR_1", "VTR_2")
        },
        "Materials": [
            {"ID": 1, "CurrentModuleName": "DBR", "SlotID": 1, "StepID": 4},
            {"ID": 2, "CurrentModuleName": "DBR", "SlotID": 2, "StepID": 4},
        ],
    }


def test_cascade_dbr_open_pressure_uses_preprepare_side_mapping() -> None:
    """DBR 开门压力判定应使用 PrePrepareTime 侧映射，而非 RelatedRobotType 全局分类。

    复现真实 12kChamber MoveList：首个空抽 ATR_1→VTR_1 后，VTR_1 开门
    （RelatedRobotType=1）要求抽气来源侧（内部 ATM）；VTR_1→VTR_2 带片转换后，
    VTR_2 开门（RelatedRobotType=2）要求抽气目标侧（内部 VAC）。
    """
    moves = [
        _move(1, 10, 0, 2, ModuleName="DBR", LastState="ATR_1", CurState="VTR_1", MatIDList=[]),
        _move(2, 6, 2, 3, ModuleName="DBR", RelatedRobotType=1),
        _move(3, 0, 3, 8, ModuleName="VTR_1", MatIDList=[1], SrcStationList=["DBR"], SrcSlotList=[1], RobotSlotList=[1], StepIDList=[5]),
        _move(4, 7, 8, 10, ModuleName="DBR"),
        _move(5, 10, 10, 12, ModuleName="DBR", LastState="VTR_1", CurState="VTR_2", MatIDList=[]),
        _move(6, 6, 12, 13, ModuleName="DBR", RelatedRobotType=2),
        _move(7, 0, 13, 18, ModuleName="VTR_2", MatIDList=[2], SrcStationList=["DBR"], SrcSlotList=[2], RobotSlotList=[1], StepIDList=[6]),
        _move(8, 7, 18, 20, ModuleName="DBR"),
    ]
    assert validate_move_list(None, moves, _cascade_dbr_update()) == []

    replay = MoveStateReplay(None, moves, _cascade_dbr_update())
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["DBR"].environment == VACUUM
