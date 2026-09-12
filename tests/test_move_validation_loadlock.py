"""平台级联 LoadLock、环境与槽位映射校验测试。"""

from __future__ import annotations

from types import SimpleNamespace

from realtime_scheduler.backend.validation.move_validation import (
    ATMOSPHERE,
    VACUUM,
    DoorState,
    LoadLockState,
    MachineState,
    MaterialState,
    MoveStateReplay,
    RobotState,
    SlotPhase,
    SlotState,
    ValidationErrorCode,
    validate_move_list,
)
from tests.support.move_validation_fixtures import (
    dual_chamber_update as _dual_chamber_update,
    move as _move,
)

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

def _atm_vac_robot_loadlock_update() -> dict:
    """LA 型 LoadLock：PrePrepareTime 声明 ATMRobot/VACRobot 两侧，初始 LastItem 为空（大气）。"""
    return {
        "Stations": {
            "LL1": {
                "Type": "LoadLock",
                "Capacity": 2,
                "LastItem": "",
                "PrePrepareTime": [
                    {"PrePrepareType": "PumpTime", "LastItem": "ATMRobot", "CurrentItem": "VACRobot"},
                    {"PrePrepareType": "VentTime", "LastItem": "VACRobot", "CurrentItem": "ATMRobot"},
                ],
            },
        },
        "Robots": {},
        "Materials": [],
    }

def test_first_environment_move_exemption_covers_internal_state_mismatch() -> None:
    """首条切换的 LastState 与 LoadLock 实际压力态不符、但标签合法时，豁免照常放行。

    复刻真实报错场景：LA 初始大气（LastItem=""），算法首条发出 VentTime
    （LastState=VACRobot→CurState=ATMRobot），LastState 声称真空与初始大气矛盾；
    但 VACROBOT/ATMROBOT 均在 PrePrepareTime 状态空间内（非越界），扩宽后的首条
    豁免应放行并把环境落地到 CurState（大气）。
    """
    update = _atm_vac_robot_loadlock_update()
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="VACRobot", CurState="ATMRobot", MatIDList=[]),
    ]
    assert validate_move_list(None, moves, update) == []

    replay = MoveStateReplay(None, moves, update)
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["LL1"].environment == ATMOSPHERE

def test_first_environment_move_exemption_internal_mismatch_lands_curstate() -> None:
    """首条不匹配切换豁免后照常执行，环境落地为 CurState 对应压力态（而非停在初始大气）。"""
    update = _atm_vac_robot_loadlock_update()
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="VACRobot", CurState="VACRobot", MatIDList=[]),
    ]
    assert validate_move_list(None, moves, update) == []

    replay = MoveStateReplay(None, moves, update)
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["LL1"].environment == VACUUM

def test_environment_exemption_internal_mismatch_only_once() -> None:
    """首条不匹配切换豁免只生效一次；第二条同款 LastState 不符仍报错。"""
    update = _atm_vac_robot_loadlock_update()
    moves = [
        _move(1, 10, 0, 2, ModuleName="LL1", LastState="VACRobot", CurState="ATMRobot", MatIDList=[]),
        _move(2, 10, 2, 4, ModuleName="LL1", LastState="VACRobot", CurState="ATMRobot", MatIDList=[]),
    ]
    issues = validate_move_list(None, moves, update)
    assert issues and "不是" in issues[0]

def _dual_arm_slot_map_update() -> dict:
    """双臂机器人带 SlotsStationMap：站组 PM1（单站）与 P1P2（横跨两个 LoadPort）。"""
    return {
        "Stations": {
            "PM1": {"Type": "MultiProcessChamber", "Capacity": 2},
            "P1": {"Type": "LoadPort", "Capacity": 25},
            "P2": {"Type": "LoadPort", "Capacity": 25},
        },
        "Robots": {
            "ATM": {
                "Type": "ATMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": ["PM1", "P1", "P2"],
                        "SlotAtStation": "P1",
                        "SlotsStationMap": {
                            "PM1": {
                                "1": [{"Key": "PM1", "Value": 1}],
                                "2": [{"Key": "PM1", "Value": 2}],
                            },
                            "P1P2": {
                                "1": [{"Key": "P1", "Value": 1}, {"Key": "P1", "Value": 2}],
                                "2": [{"Key": "P2", "Value": 1}, {"Key": "P2", "Value": 2}],
                            },
                        },
                    },
                },
            },
        },
        "Materials": [
            {"ID": 1, "CurrentModuleName": "P1", "SlotID": 1, "StepID": 0},
            {"ID": 2, "CurrentModuleName": "P2", "SlotID": 1, "StepID": 0},
        ],
    }

def test_dual_arm_cross_station_pick_uses_slot_level_alignment() -> None:
    """双臂跨站取放按手槽候选集校验：一个臂的两个槽位可分别对准不同站。

    初始 SlotAtStation=P1 时手槽 1/2 候选均为 P1 槽位；转位到 P1P2 站组后
    手槽 1 只能对准 P1、手槽 2 只能对准 P2，跨站 Pick 逐行校验通过；
    转位回 PM1 后手槽候选恢复为 PM1 槽位，顺配对 Place 通过。
    """
    update = _dual_arm_slot_map_update()
    moves = [
        _move(1, 5, 0, 1, ModuleName="ATM", SrcStationList=["P1", "P2"], DestStationList=["P1", "P2"], RobotSlotList=[1, 2]),
        _move(2, 0, 1, 2, ModuleName="ATM", MatIDList=[1, 2], SrcStationList=["P1", "P2"], SrcSlotList=[1, 1], RobotSlotList=[1, 2]),
        _move(3, 5, 2, 3, ModuleName="ATM", SrcStationList=["P1", "P2"], DestStationList=["PM1", "PM1"], RobotSlotList=[1, 2]),
        _move(4, 6, 3, 4, ModuleName="PM1", RelatedRobotType=1),
        _move(5, 1, 4, 5, ModuleName="ATM", MatIDList=[1, 2], DestStationList=["PM1", "PM1"], DestSlotList=[1, 2], RobotSlotList=[1, 2]),
        _move(6, 7, 5, 6, ModuleName="PM1"),
    ]
    assert validate_move_list(None, moves, update) == []

    replay = MoveStateReplay(None, moves, update)
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    robot = replay.state.robots["ATM"]
    assert robot.slot_targets == {1: ("PM1", 1), 2: ("PM1", 2)}
    assert robot.slot_options[1] == {("PM1", 1)}
    assert robot.slot_options[2] == {("PM1", 2)}

def test_dual_arm_cross_station_rejects_misaligned_slot() -> None:
    """槽位级校验下，手槽候选未覆盖目标槽位时报错（转位到 P1P2 后手槽 2 够不到 P1）。"""
    update = _dual_arm_slot_map_update()
    update["Materials"] = [
        {"ID": 1, "CurrentModuleName": "P1", "SlotID": 1, "StepID": 0},
        {"ID": 2, "CurrentModuleName": "P1", "SlotID": 2, "StepID": 0},
    ]
    moves = [
        _move(1, 5, 0, 1, ModuleName="ATM", SrcStationList=["P1", "P2"], DestStationList=["P1", "P2"], RobotSlotList=[1, 2]),
        _move(2, 0, 1, 2, ModuleName="ATM", MatIDList=[1, 2], SrcStationList=["P1", "P1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2]),
    ]
    issues = validate_move_list(None, moves, update)
    assert issues and "无法对准" in issues[0]

def test_single_arm_station_change_updates_unlisted_sibling_slot_pointer() -> None:
    """单条 Arm 转位时未列出的兄弟手槽也必须随整臂切换站组。

    复现双腔循环测试：#2 先到 LA，随后只用 #1 转到 LB；此时整条 ATM Arm
    已位于 LB，下一条双槽 ``LB -> P1`` 转位不应把 #2 误报为仍指向 LA。
    """
    station_groups = {
        station: {
            "1": [{"Key": station, "Value": 1}],
            "2": [{"Key": station, "Value": 1}],
        }
        for station in ("P1", "LA", "LB")
    }
    update = {
        "Stations": {
            "P1": {"Type": "LoadPort", "Capacity": 2},
            "LA": {"Type": "LoadLock", "Capacity": 1},
            "LB": {"Type": "LoadLock", "Capacity": 1},
        },
        "Robots": {
            "ATMRobot": {
                "Type": "ATMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": ["P1", "LA", "LB"],
                        "SlotAtStation": "P1",
                        "SlotsStationMap": station_groups,
                    },
                },
            },
        },
        "Materials": [],
    }
    moves = [
        _move(
            1, 5, 0, 1, ModuleName="ATMRobot", RobotSlotList=[2],
            SrcStationList=["P1"], DestStationList=["LA"], DestSlotList=[1],
        ),
        _move(
            2, 5, 1, 2, ModuleName="ATMRobot", RobotSlotList=[1],
            SrcStationList=["LA"], DestStationList=["LB"], DestSlotList=[1],
        ),
        _move(
            3, 5, 2, 3, ModuleName="ATMRobot", RobotSlotList=[1, 2],
            SrcStationList=["LB", "LB"], DestStationList=["P1", "P1"],
            DestSlotList=[2, 1],
        ),
    ]

    assert validate_move_list(None, moves, update) == []

    replay = MoveStateReplay(None, moves, update)
    for move in moves:
        replay.update_move_state(
            {"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING},
            snapshot=False,
        )
        replay.update_move_state(
            {"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE},
            snapshot=False,
        )
    assert replay.state.robots["ATMRobot"].slot_targets == {
        1: ("P1", 2),
        2: ("P1", 1),
    }

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

def test_cascade_loadlock_omits_zero_duration_preprepare() -> None:
    """DBR/UBR 零时长抽充气省略 Move 后仍应切换压力态并允许 Pick。

    标准算法会省略零时长 ``PrePrepareMove``。级联 LoadLock 不能因此保留
    旧压力态，否则 VTR_2 随后的开门和 Pick 会被错误拒绝。
    """
    update = _cascade_dbr_update()
    transitions = update["Stations"]["DBR"]["PrePrepareTime"]
    transitions[0]["Time"] = 0.0
    transitions[1]["Time"] = 0.0
    moves = [
        # 初态为 VTR_1 侧；省略 VTR_1→VTR_2 的零时长 Pump。
        _move(1, 6, 0, 1, ModuleName="DBR", RelatedRobotType=2),
        _move(
            2,
            0,
            1,
            2,
            ModuleName="VTR_2",
            MatIDList=[1],
            SrcStationList=["DBR"],
            SrcSlotList=[1],
            RobotSlotList=[1],
            StepIDList=[5],
        ),
        _move(3, 7, 2, 3, ModuleName="DBR"),
        # 省略 VTR_2→VTR_1 的零时长 Vent；下一条 Pump 应先补齐该状态。
        _move(
            4,
            10,
            3,
            3,
            ModuleName="DBR",
            LastState="VTR_1",
            CurState="VTR_2",
            MatIDList=[],
        ),
    ]

    assert validate_move_list(None, moves, update) == []

    replay = MoveStateReplay(None, moves, update)
    for move in moves:
        replay.update_move_state(
            {"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING},
            snapshot=False,
        )
        replay.update_move_state(
            {"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE},
            snapshot=False,
        )
    assert replay.state.stations["DBR"].environment == VACUUM

def test_cascade_loadlock_prepare_resolves_dependent_transport_after_pretrans() -> None:
    """Prepare 应通过 PreMoveID 找到经 PreTrans 延后的 VTR_1 运输动作。

    复现公司示例集-Post test7：DBR 完成零时长 VTR_2→VTR_1 后，Prepare
    与 PreTrans 同时开始，实际 Place 稍后执行。此时 RelatedRobotType 仍是全局
    真空分类，不能覆盖 DBR 配置声明的 VTR_1 局部访问侧。
    """
    update = _cascade_dbr_update()
    update["Stations"]["DBR"]["LastItem"] = "VTR_2"
    update["Stations"]["DBR"]["PrePrepareTime"][0]["Time"] = 0.4
    update["Stations"]["DBR"]["PrePrepareTime"][1]["Time"] = 0.0
    update["Materials"] = [
        {"ID": 1, "CurrentModuleName": "PM1", "SlotID": 1, "StepID": 4},
    ]
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(
            2,
            0,
            1,
            2,
            ModuleName="VTR_1",
            MatIDList=[1],
            SrcStationList=["PM1"],
            SrcSlotList=[1],
            RobotSlotList=[1],
            StepIDList=[5],
        ),
        _move(3, 7, 2, 2.5, ModuleName="PM1"),
        _move(
            4,
            10,
            2.5,
            2.5,
            ModuleName="DBR",
            LastState="VTR_2",
            CurState="VTR_1",
            MatIDList=[],
        ),
        _move(
            5,
            6,
            3,
            3.1,
            ModuleName="DBR",
            RelatedRobotType=1,
            RelatedActionType=0,
            MatIDList=[1],
            SlotList=[1],
            PreMoveID=[4],
        ),
        _move(
            6,
            5,
            3,
            5,
            ModuleName="VTR_1",
            MatIDList=[1],
            SrcStationList=["PM1"],
            SrcSlotList=[1],
            DestStationList=["DBR"],
            DestSlotList=[1],
            RobotSlotList=[1],
            PreMoveID=[2, 4],
        ),
        _move(
            7,
            1,
            5,
            6,
            ModuleName="VTR_1",
            MatIDList=[1],
            SrcStationList=[],
            SrcSlotList=[],
            DestStationList=["DBR"],
            DestSlotList=[1],
            RobotSlotList=[1],
            StepIDList=[6],
            PreMoveID=[5, 6],
        ),
    ]

    assert validate_move_list(None, moves, update) == []

def test_cascade_loadlock_prepare_does_not_guess_ambiguous_dependency() -> None:
    """同一 Prepare 关联多个运输动作时保持严格校验，不任意选择机器人侧。"""
    update = _cascade_dbr_update()
    moves = [
        _move(
            1,
            6,
            0,
            1,
            ModuleName="DBR",
            RelatedRobotType=1,
            RelatedActionType=1,
            MatIDList=[],
        ),
        _move(
            2,
            0,
            2,
            3,
            ModuleName="VTR_1",
            MatIDList=[1],
            SrcStationList=["DBR"],
            SrcSlotList=[1],
            RobotSlotList=[1],
            StepIDList=[5],
            PreMoveID=[1],
        ),
        _move(
            3,
            0,
            2,
            3,
            ModuleName="VTR_2",
            MatIDList=[2],
            SrcStationList=["DBR"],
            SrcSlotList=[2],
            RobotSlotList=[1],
            StepIDList=[5],
            PreMoveID=[1],
        ),
    ]

    issues = validate_move_list(None, moves, update)

    assert len(issues) == 1
    assert "MVL-LL-002" in issues[0]

def test_platform_rejects_slot_list_on_pick_move() -> None:
    """平台校验器应拒绝 PickMove 上错误的通用 SlotList 字段。"""
    move = _move(
        1,
        0,
        0,
        1,
        ModuleName="VACRobot",
        RobotSlotList=[1],
        SrcStationList=["PM1"],
        SrcSlotList=[1],
        SlotList=[1],
        MatIDList=[101],
    )

    issues = validate_move_list(None, [move], _dual_chamber_update())

    assert issues[0].startswith("[MVL-FMT-004]")
    assert "PickMove 不允许携带 SlotList" in issues[0]
