"""平台独立 MoveList 状态记录器的单腔与双腔物理回归测试。"""

from __future__ import annotations

from types import SimpleNamespace

from realtime_scheduler.move_validation import (
    ATMOSPHERE,
    VACUUM,
    LoadLockState,
    MoveStateReplay,
    SlotPhase,
    ValidationErrorCode,
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


def test_validation_error_codes_are_unique_and_non_object_moves_are_coded() -> None:
    """每类输出校验错误都必须有唯一稳定码，非法 Move 元素也不能抛普通异常。"""
    codes = [error_code.value for error_code in ValidationErrorCode]

    assert len(codes) == len(set(codes))
    assert validate_move_list(None, ["invalid"], {}) == [
        "[MVL-FMT-001] MoveList[0] 必须是 JSON 对象"
    ]


def test_dependency_rejects_missing_predecessor() -> None:
    """PreMoveID 引用不存在的 MoveID 必须在平台侧失败。"""
    moves = [
        _move(
            1,
            5,
            0,
            1,
            ModuleName="VACRobot",
            SrcStationList=["PM1"],
            DestStationList=["LL1"],
            RobotSlotList=[1],
            MatIDList=[],
            PreMoveID=[999],
        )
    ]

    issues = validate_move_list(None, moves, _dual_chamber_update())

    assert "不存在的 MoveID=999" in issues[0]


def test_dependency_rejects_cycle() -> None:
    """PreMoveID DAG 中的环不能依赖时间排序侥幸通过。"""
    moves = [
        _move(1, 10, 0, 0, ModuleName="LL1", MatIDList=[], PreMoveID=[2]),
        _move(2, 10, 0, 0, ModuleName="LL1", MatIDList=[], PreMoveID=[1]),
    ]

    issues = validate_move_list(None, moves, _dual_chamber_update())

    assert "依赖环" in issues[0]


def test_dependency_rejects_predecessor_finishing_after_child_starts() -> None:
    """即使拓扑无环，前驱未完成时也不能启动后继 Move。"""
    moves = [
        _move(1, 10, 0, 5, ModuleName="LL1", MatIDList=[]),
        _move(2, 10, 2, 3, ModuleName="LL1", MatIDList=[], PreMoveID=[1]),
    ]

    issues = validate_move_list(None, moves, _dual_chamber_update())

    assert "前驱 MoveID=1 尚未结束" in issues[0]


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
    assert issues == ["[MVL-ROBOT-003] MoveID=2 MoveType=5：VACRobot#1 持有物料与 Move 不匹配"]


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
    assert issues == ["[MVL-SWAP-001] MoveID=2 MoveType=4：SwapMove 必须引用同一个站点"]


def _three_slot_robot_update() -> dict:
    """三槽 VACRobot（SlotIDs=[1,2,3]）连接 PM1 与 LoadPort LP1，用于不对称换片测试。"""
    return {
        "Stations": {
            "PM1": {"Type": "MultiProcessChamber", "Capacity": 2},
            "LP1": {"Type": "LoadPort", "Capacity": 25},
        },
        "Robots": {
            "VTR": {
                "Type": "VTMRobot",
                "Capacity": 3,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2, 3],
                        "AccessibleStations": ["PM1", "LP1"],
                        "SlotAtStation": "PM1",
                        "SlotsStationMap": {
                            "PM1": {
                                "1": [{"Key": "PM1", "Value": 1}],
                                "2": [{"Key": "PM1", "Value": 2}],
                                "3": [{"Key": "PM1", "Value": 1}],
                            },
                            "LP1": {
                                "1": [{"Key": "LP1", "Value": 1}, {"Key": "LP1", "Value": 2}],
                                "2": [{"Key": "LP1", "Value": 1}, {"Key": "LP1", "Value": 2}],
                                "3": [{"Key": "LP1", "Value": 1}, {"Key": "LP1", "Value": 2}],
                            },
                        },
                    },
                },
            },
        },
        "Materials": [
            {"ID": 101, "CurrentModuleName": "PM1", "SlotID": 2, "StepID": 4},
            {"ID": 102, "CurrentModuleName": "PM1", "SlotID": 1, "StepID": 4},
            {"ID": 103, "CurrentModuleName": "LP1", "SlotID": 1, "StepID": 0},
        ],
    }


def test_swap_move_supports_asymmetric_exchange() -> None:
    """不对称换片：Send 1 片进腔室、Recv 2 片出腔室，两组长度不同合法。

    StnSendSlotList 是离开腔室晶圆用的站槽位（Recv 组），StnRecvSlotList 是
    进入腔室晶圆用的站槽位（Send 组）；同一槽位可同时承载一组 Send 与一组
    Recv（换片槽位，先取后放），具体槽位号信任算法声明。
    """
    update = _three_slot_robot_update()
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(2, 5, 1, 2, ModuleName="VTR", SrcStationList=["PM1"], DestStationList=["LP1"], RobotSlotList=[2]),
        _move(3, 0, 2, 3, ModuleName="VTR", MatIDList=[103], SrcStationList=["LP1"], SrcSlotList=[1], RobotSlotList=[2]),
        _move(4, 5, 3, 4, ModuleName="VTR", SrcStationList=["LP1"], DestStationList=["PM1", "PM1"], RobotSlotList=[2, 3]),
        _move(5, 4, 4, 5, ModuleName="VTR",
              StationList=["PM1"], StnSendSlotList=[2, 1], StnRecvSlotList=[1],
              RecvSlotList=[1, 3], SendSlotList=[2], RecvMatList=[101, 102], SendMatList=[103]),
        _move(6, 7, 5, 6, ModuleName="PM1"),
    ]
    assert validate_move_list(None, moves, update) == []


def test_swap_move_rejects_internal_field_length_mismatch() -> None:
    """Recv 组内部数组长度不一致仍报错（StnSendSlotList 数量与 RecvMatList 不符）。"""
    moves = [
        _move(1, 4, 0, 1, ModuleName="VACRobot",
              StationList=["PM1"], StnSendSlotList=[1, 2], StnRecvSlotList=[1],
              RecvSlotList=[1], SendSlotList=[2], RecvMatList=[101], SendMatList=[102]),
    ]
    issues = validate_move_list(None, moves, _dual_chamber_update())
    assert issues and "Recv 组数组数量不一致" in issues[0]


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
        _move(1, 5, 0, 1, ModuleName="ATM", SrcStationList=["P1"], DestStationList=["P1", "P2"], RobotSlotList=[1, 2]),
        _move(2, 0, 1, 2, ModuleName="ATM", MatIDList=[1, 2], SrcStationList=["P1", "P2"], SrcSlotList=[1, 1], RobotSlotList=[1, 2]),
        _move(3, 5, 2, 3, ModuleName="ATM", SrcStationList=["P1"], DestStationList=["PM1", "PM1"], RobotSlotList=[1, 2]),
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
        _move(1, 5, 0, 1, ModuleName="ATM", SrcStationList=["P1"], DestStationList=["P1", "P2"], RobotSlotList=[1, 2]),
        _move(2, 0, 1, 2, ModuleName="ATM", MatIDList=[1, 2], SrcStationList=["P1", "P1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2]),
    ]
    issues = validate_move_list(None, moves, update)
    assert issues and "无法对准" in issues[0]


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
