"""平台双腔、Swap 与多槽 Robot 校验测试。"""

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

def _zero_duration_pm_route(step_id: int = 4, station: str = "PM1") -> dict:
    """构造 NeedProcess 且 Recipe 为空的零时长产品 Route。"""
    return {
        "RouteSteps": [
            {
                "StepID": step_id,
                "NeedProcess": True,
                "Visits": [{"StationName": station, "ProcessRecipe": ""}],
            }
        ]
    }

def test_dual_chamber_omitted_zero_duration_process_allows_paired_pick() -> None:
    """双腔两片 0s 工艺省略 ProcessMove 后，关门即应成对完成并允许双片 Pick。"""
    update = _dual_chamber_update()
    zero_route = _zero_duration_pm_route()
    for material in update["Materials"]:
        material["Route"] = zero_route
        material["PJobName"] = "P1"
    update["ProcessJobs"] = [{
        "JobName": "P1",
        "MatList": [101, 102],
        "OriginRoute": zero_route,
    }]
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(
            2, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
        ),
        _move(
            3, 1, 2, 3, ModuleName="VACRobot", MatIDList=[101, 102],
            DestStationList=["PM1", "PM1"], DestSlotList=[1, 2], RobotSlotList=[1, 2],
            StepIDList=[4, 4],
        ),
        _move(4, 7, 3, 4, ModuleName="PM1"),
        _move(5, 6, 4, 5, ModuleName="PM1", RelatedRobotType=1, RelatedActionType=1),
        _move(
            6, 0, 5, 6, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
        ),
    ]
    assert validate_move_list(None, moves, update) == []

def test_dual_chamber_omitted_zero_duration_process_from_pjob_matlist() -> None:
    """仅 OriginRoute/MatList 声明 0s 时，物理第二片也应能省略 ProcessMove。"""
    update = _dual_chamber_update()
    zero_route = _zero_duration_pm_route()
    update["Materials"] = [update["Materials"][0]]
    update["Materials"][0]["Route"] = {}
    update["ProcessJobs"] = [{
        "JobName": "P1",
        "MatList": [101, 102],
        "OriginRoute": zero_route,
    }]
    update["Materials"].append({
        "ID": 102,
        "CurrentModuleName": "PM1",
        "SlotID": 2,
        "StepID": 4,
    })
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
        _move(5, 6, 4, 5, ModuleName="PM1", RelatedRobotType=1, RelatedActionType=1),
        _move(
            6, 0, 5, 6, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
        ),
    ]
    assert validate_move_list(None, moves, update) == []

def test_dual_chamber_mixed_process_times_still_require_process_move() -> None:
    """双腔一槽 0s、一槽非零时，不能省略覆盖两片的 ProcessMove。"""
    update = _dual_chamber_update()
    update["Materials"][0]["Route"] = _zero_duration_pm_route()
    update["Materials"][1]["Route"] = {
        "RouteSteps": [{
            "StepID": 4,
            "NeedProcess": True,
            "Visits": [{"StationName": "PM1", "ProcessRecipe": "LongRecipe"}],
        }]
    }
    update["ProcessRecipes"] = [{
        "Name": "LongRecipe",
        "ModuleName": "PM1",
        "Time": 10.0,
    }]
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(
            2, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
        ),
        _move(
            3, 1, 2, 3, ModuleName="VACRobot", MatIDList=[101, 102],
            DestStationList=["PM1", "PM1"], DestSlotList=[1, 2], RobotSlotList=[1, 2],
            StepIDList=[4, 4],
        ),
        _move(4, 7, 3, 4, ModuleName="PM1"),
        _move(5, 6, 4, 5, ModuleName="PM1", RelatedRobotType=1, RelatedActionType=1),
        _move(
            6, 0, 5, 6, ModuleName="VACRobot", MatIDList=[101, 102],
            SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2],
        ),
    ]
    issues = validate_move_list(None, moves, update)
    assert issues
    assert "没有匹配的已完成物料" in issues[0]

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
    """普通原子 Swap 不能把无关的 PM 与 LoadLock 合成跨站动作。"""
    moves = [
        _move(1, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        _move(2, 4, 1, 2, ModuleName="VACRobot",
              StationList=["PM1", "LL1"], StnRecvSlotList=[1], StnSendSlotList=[1],
              RecvSlotList=[1], SendSlotList=[2], RecvMatList=[101], SendMatList=[102]),
    ]
    issues = validate_move_list(None, moves, _dual_chamber_update())
    assert issues == [
        "[MVL-SWAP-001] MoveID=2 MoveType=4："
        "SwapMove 必须引用同一个站点或一组孪生 LoadLock（LA/LB、LC/LD）"
    ]

def test_twin_loadlock_swap_maps_each_station_and_same_layer() -> None:
    """真空四槽手应能在 LA/LB 同层同步换出两片并换入两片。"""
    state = MachineState(
        stations={
            "LA": LoadLockState(
                "LA",
                "LoadLock",
                {1: SlotState(SlotPhase.COMPLETED, MaterialState(7, "P", 3))},
                door=DoorState.OPEN,
                environment=VACUUM,
            ),
            "LB": LoadLockState(
                "LB",
                "LoadLock",
                {1: SlotState(SlotPhase.COMPLETED, MaterialState(8, "P", 3))},
                door=DoorState.OPEN,
                environment=VACUUM,
            ),
        },
        robots={
            "VACRobot": RobotState(
                "VACRobot",
                hands={
                    1: None,
                    2: None,
                    3: MaterialState(5, "P", 5),
                    4: MaterialState(6, "P", 5),
                },
                scope={"LA", "LB"},
                can_swap=True,
            ),
        },
        robot_aliases={"VACRobot": "VACRobot"},
    )
    move = _move(
        201,
        4,
        402.29,
        419.09,
        ModuleName="VACRobot",
        StationList=["LA", "LB"],
        StnRecvSlotList=[1, 1],
        StnSendSlotList=[1, 1],
        RecvSlotList=[1, 2],
        SendSlotList=[3, 4],
        RecvMatList=[7, 8],
        SendMatList=[5, 6],
        RecvMatStepIDList=[3, 3],
        SendMatStepIDList=[6, 6],
    )

    assert validate_move_list(None, [move], state) == []
    replay = MoveStateReplay(None, [move], state)
    replay.update_move_state({"MoveID": 201, "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
    replay.update_move_state({"MoveID": 201, "MoveState": MoveStateReplay.DONE}, snapshot=False)

    assert replay.state.stations["LA"].slots[1].material.material_id == 5
    assert replay.state.stations["LB"].slots[1].material.material_id == 6
    assert replay.state.robots["VACRobot"].hands[1].material_id == 7
    assert replay.state.robots["VACRobot"].hands[2].material_id == 8
    assert replay.state.robots["VACRobot"].hands[3] is None
    assert replay.state.robots["VACRobot"].hands[4] is None

    invalid_layer = dict(move, StnRecvSlotList=[1, 2], StnSendSlotList=[1, 2])
    issues = validate_move_list(None, [invalid_layer], state)
    assert issues and "必须使用同一层槽位" in issues[0]

def test_twin_loadlock_swap_supports_asymmetric_groups() -> None:
    """孪生 LoadLock 允许不对称换片：LA 换入换出、LB 仅换入。"""
    state = MachineState(
        stations={
            "LA": LoadLockState(
                "LA",
                "LoadLock",
                {1: SlotState(SlotPhase.COMPLETED, MaterialState(25, "P", 3))},
                door=DoorState.OPEN,
                environment=VACUUM,
            ),
            "LB": LoadLockState(
                "LB",
                "LoadLock",
                {1: SlotState(SlotPhase.EMPTY, None)},
                door=DoorState.OPEN,
                environment=VACUUM,
            ),
        },
        robots={
            "VACRobot": RobotState(
                "VACRobot",
                hands={
                    1: MaterialState(21, "P", 8),
                    2: MaterialState(22, "P", 8),
                    3: None,
                    4: None,
                },
                scope={"LA", "LB"},
                can_swap=True,
            ),
        },
        robot_aliases={"VACRobot": "VACRobot"},
    )
    move = _move(
        527,
        4,
        1380.94,
        1397.74,
        ModuleName="VACRobot",
        StationList=["LA", "LB"],
        StnRecvSlotList=[1, 1],
        StnSendSlotList=[1],
        RecvSlotList=[3],
        SendSlotList=[1, 2],
        RecvMatList=[25],
        SendMatList=[21, 22],
        RecvMatStepIDList=[3],
        SendMatStepIDList=[8, 8],
    )

    assert validate_move_list(None, [move], state) == []
    replay = MoveStateReplay(None, [move], state)
    replay.update_move_state({"MoveID": 527, "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
    replay.update_move_state({"MoveID": 527, "MoveState": MoveStateReplay.DONE}, snapshot=False)

    assert replay.state.stations["LA"].slots[1].material.material_id == 21
    assert replay.state.stations["LB"].slots[1].material.material_id == 22
    assert replay.state.robots["VACRobot"].hands[3].material_id == 25
    assert replay.state.robots["VACRobot"].hands[1] is None
    assert replay.state.robots["VACRobot"].hands[2] is None

def test_twin_loadlock_swap_rejects_group_longer_than_stations() -> None:
    """孪生 Swap 任一组数量超过 StationList 站点数时报错。"""
    state = MachineState(
        stations={
            "LA": LoadLockState(
                "LA",
                "LoadLock",
                {1: SlotState(SlotPhase.COMPLETED, MaterialState(25, "P", 3))},
                door=DoorState.OPEN,
                environment=VACUUM,
            ),
            "LB": LoadLockState(
                "LB",
                "LoadLock",
                {1: SlotState(SlotPhase.EMPTY, None)},
                door=DoorState.OPEN,
                environment=VACUUM,
            ),
        },
        robots={
            "VACRobot": RobotState(
                "VACRobot",
                hands={
                    1: MaterialState(21, "P", 8),
                    2: MaterialState(22, "P", 8),
                    4: MaterialState(23, "P", 8),
                    3: None,
                },
                scope={"LA", "LB"},
                can_swap=True,
            ),
        },
        robot_aliases={"VACRobot": "VACRobot"},
    )
    move = _move(
        600,
        4,
        10.0,
        27.0,
        ModuleName="VACRobot",
        StationList=["LA", "LB"],
        StnRecvSlotList=[1, 1, 1],
        StnSendSlotList=[1],
        RecvSlotList=[3],
        SendSlotList=[1, 2, 4],
        RecvMatList=[25],
        SendMatList=[21, 22, 23],
    )
    issues = validate_move_list(None, [move], state)
    assert issues and "Send 组数量不能超过 StationList" in issues[0]

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

def test_place_first_swap_can_reuse_one_robot_slot_for_multi_slot_station() -> None:
    """多槽腔室可先放后取，因此 SwapMode=1 允许收发共用同一 Robot 槽。"""
    update = {
        "Stations": {
            "LP1": {"Type": "LoadPort", "Capacity": 1},
            "PM1": {"Type": "MultiProcessChamber", "Capacity": 2},
        },
        "Robots": {"R": {"Capacity": 1, "CanMultiTrans": False}},
        "Materials": [
            {"ID": 1, "CurrentModuleName": "LP1", "SlotID": 1},
            {"ID": 2, "CurrentModuleName": "PM1", "SlotID": 1},
        ],
    }
    moves = [
        _move(1, 6, 0, 1, ModuleName="LP1"),
        _move(2, 0, 1, 2, ModuleName="R", MatIDList=[1], SrcStationList=["LP1"], SrcSlotList=[1], RobotSlotList=[1]),
        _move(3, 7, 2, 3, ModuleName="LP1"),
        _move(4, 6, 3, 4, ModuleName="PM1"),
        _move(
            5, 4, 4, 5, ModuleName="R", StationList=["PM1", "PM1"],
            StnRecvSlotList=[2], StnSendSlotList=[1], RecvSlotList=[1],
            SendSlotList=[1], RecvMatList=[2], SendMatList=[1], SwapMode=1,
        ),
    ]

    assert validate_move_list(None, moves, update) == []
    replay = MoveStateReplay(None, moves, update)
    for move in moves:
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.RUNNING}, snapshot=False)
        replay.update_move_state({"MoveID": move["MoveID"], "MoveState": MoveStateReplay.DONE}, snapshot=False)
    assert replay.state.stations["PM1"].slots[2].material.material_id == 1
    assert replay.state.robots["R"].hands[1].material_id == 2
