"""平台动作时长、驻留和 Q-time 校验测试。"""

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
    dual_transfer_moves as _dual_transfer_moves,
    move as _move,
)

def test_platform_rejects_pick_duration_different_from_robot_config() -> None:
    """平台 validator 必须独立拒绝算法任意填写的 Pick 时长。"""
    update = _dual_chamber_update()
    update["Robots"]["VACRobot"]["PickTime"] = {"PM1": 2.0}
    moves = [
        _move(
            1,
            0,
            0,
            3,
            ModuleName="VACRobot",
            MatIDList=[101],
            SrcStationList=["PM1"],
            SrcSlotList=[1],
            RobotSlotList=[1],
        )
    ]

    issues = validate_move_list(None, moves, update)

    assert "动作时长 3.000000s 与配置 2.000000s 不一致" in issues[0]

def test_platform_reports_invalid_pick_timing_config_with_error_code() -> None:
    """非法设备计时应返回可查询错误码，不得在 float 转换处崩溃。"""
    update = _dual_chamber_update()
    update["Robots"]["VACRobot"]["PickTime"] = {"PM1": "invalid"}
    moves = [
        _move(
            1,
            0,
            0,
            2,
            ModuleName="VACRobot",
            MatIDList=[101],
            SrcStationList=["PM1"],
            SrcSlotList=[1],
            RobotSlotList=[1],
        )
    ]

    issues = validate_move_list(None, moves, update)

    assert issues[0].startswith("[MVL-TIME-004]")
    assert "必须是非负有限数字" in issues[0]

def test_platform_rejects_process_duration_different_from_selected_visit() -> None:
    """ProcessMove 时长必须匹配 MatID/StepID/候选模块对应的 Visit。"""
    stage = SimpleNamespace(
        stage_type="process",
        step_id=30,
        j=1,
        chamber="PM1",
        cands=["PM1", "PM2"],
        proc=10.0,
        process_time_by_chamber={"PM1": 10.0, "PM2": 20.0},
        residency=-1.0,
        qtime=-1.0,
    )
    task = SimpleNamespace(
        wafers=[SimpleNamespace(mat_id=101, stages=[stage])]
    )
    moves = [
        _move(
            1,
            9,
            0,
            15,
            ModuleName="PM1",
            MatIDList=[101],
            StepIDList=[30],
            SlotList=[1],
        )
    ]

    issues = validate_move_list(task, moves, _dual_chamber_update())

    assert "动作时长 15.000000s 与配置 10.000000s 不一致" in issues[0]

def test_platform_rejects_pretrans_duration_different_from_exact_quadruple() -> None:
    """PreTrans 必须按 Src/Dest/TransType 精确匹配，不能取任意首行。"""
    update = _dual_chamber_update()
    update["Robots"]["VACRobot"]["PrepTransTime"] = [
        {
            "SrcStation": "PM1",
            "DestStation": "LL1",
            "TransType": 0,
            "Time": 2.5,
        }
    ]
    moves = [
        _move(
            1,
            5,
            0,
            4,
            ModuleName="VACRobot",
            Robot="VACRobot",
            SrcStationList=["PM1"],
            DestStationList=["LL1"],
            RobotSlotList=[1],
            MatIDList=[],
        )
    ]

    issues = validate_move_list(None, moves, update)

    assert "动作时长 4.000000s 与配置 2.500000s 不一致" in issues[0]

def test_platform_rejects_residency_limit_violation() -> None:
    """加工结束到取片开始超过 Visit Residency 时必须失败。"""
    stage = SimpleNamespace(
        stage_type="process",
        step_id=30,
        j=1,
        chamber="PM1",
        cands=["PM1"],
        proc=10.0,
        process_time_by_chamber={"PM1": 10.0},
        residency=2.0,
        qtime=-1.0,
    )
    task = SimpleNamespace(wafers=[SimpleNamespace(mat_id=101, stages=[stage])])
    moves = [
        _move(1, 9, 0, 10, ModuleName="PM1", MatIDList=[101], StepIDList=[30]),
        _move(
            2,
            0,
            13,
            14,
            ModuleName="VACRobot",
            Robot="VACRobot",
            SrcStationList=["PM1"],
            SrcSlotList=[1],
            RobotSlotList=[1],
            MatIDList=[101],
            PreMoveID=[1],
        ),
    ]

    issues = validate_move_list(task, moves, _dual_chamber_update())

    assert "驻留 3.000s 超过上限 2.000s" in issues[0]

def test_platform_rejects_qtime_between_adjacent_process_steps() -> None:
    """相邻加工步骤的开始间隔超过 Q-time 时必须失败。"""
    first_stage = SimpleNamespace(
        stage_type="process",
        step_id=30,
        j=1,
        chamber="PM1",
        cands=["PM1"],
        proc=10.0,
        process_time_by_chamber={"PM1": 10.0},
        residency=-1.0,
        qtime=2.0,
    )
    second_stage = SimpleNamespace(
        stage_type="process",
        step_id=40,
        j=2,
        chamber="PM2",
        cands=["PM2"],
        proc=10.0,
        process_time_by_chamber={"PM2": 10.0},
        residency=-1.0,
        qtime=-1.0,
    )
    task = SimpleNamespace(
        wafers=[SimpleNamespace(mat_id=101, stages=[first_stage, second_stage])]
    )
    moves = [
        _move(1, 9, 0, 10, ModuleName="PM1", MatIDList=[101], StepIDList=[30]),
        _move(
            2,
            9,
            13,
            23,
            ModuleName="PM2",
            MatIDList=[101],
            StepIDList=[40],
            PreMoveID=[1],
        ),
    ]

    issues = validate_move_list(task, moves, _dual_chamber_update())

    assert "相邻加工间隔 3.000s 超过 Q-time 2.000s" in issues[0]

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
