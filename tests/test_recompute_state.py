"""实时重算状态快照生成的单元与架构边界测试。

覆盖传统 ATR/VTR LoadLock、带编号的 ATR_1/VTR_1 LoadLock，以及两侧均为
真空机器人的 VTR_1/VTR_2 桥接 LoadLock，确保 MachineState 回写不会丢失
设备协议中的精确 ``LastItem`` 名称。
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path

from realtime_scheduler.move_validation import (
    ATMOSPHERE,
    MachineState,
    MoveStateReplay,
    SlotPhase,
    VACUUM,
)
from realtime_scheduler.recompute_state import (
    apply_machine_state_to_update,
    merge_algorithm_update,
    restore_dummy_routes_from_algorithm_output,
)
from realtime_scheduler.server import _compile_external_validation_problem


ROOT = Path(__file__).resolve().parents[1]


def _loadlock(last_item: str, current_item: str) -> dict:
    """构造一组可双向切换的最小 LoadLock 标准配置。"""
    return {
        "Type": "LoadLock",
        "Capacity": 2,
        "Slots": [1, 2],
        "LastItem": "",
        "PrePrepareTime": [
            {
                "LastItem": last_item,
                "CurrentItem": current_item,
                "Time": 1.0,
                "PrePrepareType": "PumpTime",
            },
            {
                "LastItem": current_item,
                "CurrentItem": last_item,
                "Time": 1.0,
                "PrePrepareType": "VentTime",
            },
        ],
    }


def test_loadlock_snapshot_restores_configured_side_names() -> None:
    """状态快照应按各站点配置恢复带编号或双真空侧的 LastItem。"""
    update = {
        "CurrentTime": 0.0,
        "Materials": [],
        "Robots": {},
        "Stations": {
            "LA": _loadlock("ATR_1", "VTR_1"),
            "LB": _loadlock("ATR_1", "VTR_1"),
            "UBR": _loadlock("VTR_1", "VTR_2"),
            "DBR": _loadlock("VTR_1", "VTR_2"),
        },
    }
    state = MachineState.from_sources(None, update)
    state.stations["LA"].environment = VACUUM
    state.stations["LB"].environment = ATMOSPHERE
    state.stations["UBR"].environment = ATMOSPHERE
    state.stations["DBR"].environment = VACUUM

    apply_machine_state_to_update(update, state, 70.0)

    assert update["Stations"]["LA"]["LastItem"] == "VTR_1"
    assert update["Stations"]["LB"]["LastItem"] == "ATR_1"
    assert update["Stations"]["UBR"]["LastItem"] == "VTR_1"
    assert update["Stations"]["DBR"]["LastItem"] == "VTR_2"


def test_loadlock_snapshot_preserves_legacy_atr_vtr_names() -> None:
    """传统设备仍应输出原有 ATR/VTR 名称，保持标准接口向后兼容。"""
    update = {
        "CurrentTime": 0.0,
        "Materials": [],
        "Robots": {},
        "Stations": {"LA": _loadlock("ATR", "VTR")},
    }
    state = MachineState.from_sources(None, update)
    state.stations["LA"].environment = VACUUM

    apply_machine_state_to_update(update, state, 10.0)

    assert update["Stations"]["LA"]["LastItem"] == "VTR"


def test_station_material_count_remains_slot_mapping_in_snapshot() -> None:
    """重算快照不得把 Cooler 的逐槽加工次数退化成站内物料总数。"""
    update = {
        "CurrentTime": 0.0,
        "Materials": [],
        "Robots": {},
        "Stations": {
            "Cooler": {
                "Type": "Cooler",
                "Capacity": 2,
                "Slots": [1, 2],
                "MaterialCount": {"1": 3, "2": 5},
            },
        },
    }
    state = MachineState.from_sources(None, update)

    apply_machine_state_to_update(update, state, 70.0)

    assert update["Stations"]["Cooler"]["MaterialCount"] == {"1": 3, "2": 5}


def test_completed_process_increments_station_slot_material_count() -> None:
    """带片 ProcessMove 完成后应只累计实际加工槽位的 MaterialCount。"""
    update = {
        "CurrentTime": 0.0,
        "Materials": [{
            "ID": 101,
            "PJobName": "P1",
            "StepID": 1,
            "CurrentModuleName": "Cooler",
            "SlotID": 1,
        }],
        "Robots": {},
        "Stations": {
            "Cooler": {
                "Type": "Cooler",
                "Capacity": 2,
                "Slots": [1, 2],
                "MaterialCount": {"1": 3, "2": 5},
            },
        },
    }
    state = MachineState.from_sources(None, update)
    state.stations["Cooler"].slots[1].phase = SlotPhase.UNPROCESSED
    move = {
        "MoveID": 1,
        "MoveType": 9,
        "StartTime": 10.0,
        "EndTime": 30.0,
        "ModuleName": "Cooler",
        "MatIDList": [101],
        "SlotList": [1],
    }
    replay = MoveStateReplay(None, [move], state)
    replay.update_move_state({"MoveID": 1, "MoveState": MoveStateReplay.RUNNING})
    replay.update_move_state({"MoveID": 1, "MoveState": MoveStateReplay.DONE})

    apply_machine_state_to_update(update, replay.state, 30.0)

    assert update["Stations"]["Cooler"]["MaterialCount"] == {"1": 4, "2": 5}


def test_dummy_route_returned_by_algorithm_is_sent_back_on_recompute() -> None:
    """平台应把上一轮 DummyReturnInfo 原样回填到在途 Dummy Material。"""
    route_recipe = {
        "Name": "dummy-pm1-route",
        "RouteSteps": [{
            "StepID": 4,
            "Visits": [{"StationName": "PM1"}],
            "NeedProcess": True,
        }],
    }
    update = {
        "Materials": [{
            "ID": 100000,
            "TaskID": "",
            "PJobName": "",
            "Route": {},
            "CurrentModuleName": "PM1",
            "StepID": 4,
            "SrcPortName": "DummyPort",
            "AccessiblePM": ["PM1"],
        }],
    }
    output = {
        "DummyReturnInfo": {
            "100000": [{
                "TaskID": "1",
                "PJobName": "1.C1.P1",
                "RouteRecipe": route_recipe,
            }],
        },
    }

    restored = restore_dummy_routes_from_algorithm_output(update, output)

    assert restored == [100000]
    assert update["Materials"][0]["Route"] == route_recipe
    assert update["Materials"][0]["TaskID"] == "1"
    assert update["Materials"][0]["PJobName"] == "1.C1.P1"
    assert update["Materials"][0]["CurrentModuleName"] == "PM1"
    assert update["Materials"][0]["StepID"] == 4


def test_merge_algorithm_update_consumes_previous_dummy_return_info() -> None:
    """统一重算合并边界必须直接消费上一轮算法返回的 Dummy Route。"""
    route_recipe = {
        "Name": "dummy-pm1-route",
        "RouteSteps": [{
            "StepID": 4,
            "Visits": [{"StationName": "PM1"}],
            "NeedProcess": True,
        }],
    }
    previous_update = {
        "CurrentTime": 0.0,
        "Materials": [{
            "ID": 100000,
            "TaskID": "",
            "PJobName": "",
            "Route": {},
            "CurrentModuleName": "PM1",
            "SlotID": 1,
            "StepID": 4,
            "SrcPortName": "DummyPort",
            "AccessiblePM": ["PM1"],
        }],
        "ProcessJobs": [],
        "ControlJobs": [],
        "Route": {"legacy": {}},
        "Routes": {},
    }
    new_round_update = {
        "CurrentTime": 70.0,
        "Materials": [],
        "ProcessJobs": [],
        "ControlJobs": [],
        "ProcessRecipes": [],
        "Routes": {},
        "Robots": {},
        "Stations": {},
    }
    previous_output = {
        "DummyReturnInfo": {
            "100000": [{
                "TaskID": "1",
                "PJobName": "1.C1.P1",
                "RouteRecipe": route_recipe,
            }],
        },
    }

    merged = merge_algorithm_update(
        previous_update,
        new_round_update,
        previous_output,
    )

    material = merged["Materials"][0]
    assert "Route" not in merged
    assert "Routes" not in merged
    assert material["Route"] == route_recipe
    assert material["PJobName"] == "1.C1.P1"
    assert material["TaskID"] == "1"


def test_idle_dummy_at_source_port_returns_to_default_state() -> None:
    """Dummy 位于来源端口且没有 Running Move 时应恢复库存默认状态。"""
    update = {
        "Materials": [{
            "ID": 100000,
            "TaskID": "",
            "PJobName": "",
            "Route": {},
            "CurrentModuleName": "DummyPort",
            "StepID": 0,
            "SrcPortName": "DummyPort",
            "AccessiblePM": ["PM1"],
            "Count": 7,
        }],
    }
    output = {
        "DummyReturnInfo": {
            "100000": [{
                "TaskID": "1",
                "PJobName": "1.C1.P1",
                "RouteRecipe": {
                    "Name": "unstarted-route",
                    "RouteSteps": [{"StepID": 0, "Visits": []}],
                },
            }],
        },
    }

    restored = restore_dummy_routes_from_algorithm_output(update, output)

    assert restored == [100000]
    material = update["Materials"][0]
    assert material["Route"]["RouteSteps"] == []
    assert material["TaskID"] == ""
    assert material["PJobName"] == ""
    assert material["StepID"] == 0
    assert material["CurrentModuleName"] == "DummyPort"
    assert material["Count"] == 7


def test_only_dummy_ids_present_in_return_info_are_normalized() -> None:
    """只处理算法返回过的 Dummy MatID，其余库存保持原样。"""
    update = {
        "Materials": [
            {
                "ID": 100000 + index,
                "TaskID": "",
                "PJobName": "",
                "Route": {},
                "CurrentModuleName": "DummyPort",
                "StepID": 0,
                "SrcPortName": "DummyPort",
            }
            for index in range(5)
        ],
    }
    returned_route = {
        "Name": "returned-route",
        "RouteSteps": [{"StepID": 0, "Visits": [{"StationName": "DummyPort"}]}],
    }
    output = {
        "DummyReturnInfo": {
            str(material_id): [{
                "TaskID": "1",
                "PJobName": "1.C1.P1",
                "RouteRecipe": returned_route,
            }]
            for material_id in (100000, 100001)
        },
    }

    restored = restore_dummy_routes_from_algorithm_output(update, output)

    assert restored == [100000, 100001]
    assert [
        bool((material.get("Route") or {}).get("RouteSteps"))
        for material in update["Materials"]
    ] == [False, False, False, False, False]


def test_inflight_dummy_uses_running_move_task_assignment() -> None:
    """共享中间工步不能覆盖 Running Move 已确定的 Dummy 任务归属。"""
    task1_route = {
        "Name": "task-1-route",
        "RouteSteps": [{
            "StepID": 2,
            "Visits": [{"StationName": "LA"}],
            "PostStepID": [3],
        }],
    }
    task2_route = {
        "Name": "task-2-route",
        "RouteSteps": [{
            "StepID": 2,
            "Visits": [{"StationName": "LA"}],
            "PostStepID": [3],
        }],
    }
    update = {
        "CurrentTime": 100.0,
        "MoveStates": [{"MoveID": 20, "MoveState": 0}],
        "Materials": [{
            "ID": 100001,
            "TaskID": "1",
            "PJobName": "1.C1.P1",
            "Route": task1_route,
            "CurrentModuleName": "LA",
            "StepID": 2,
            "SrcPortName": "DummyPort",
            "AccessiblePM": ["PM1"],
            "Count": 9,
        }],
    }
    output = {
        "MoveList": [{
            "MoveID": 20,
            "StartTime": 99.0,
            "MatIDList": [100001],
            "TaskID": ["2"],
            "PJobName": ["2.C2.P1"],
        }],
        "DummyReturnInfo": {
            "100001": [
                {
                    "TaskID": "1",
                    "PJobName": "1.C1.P1",
                    "RouteRecipe": task1_route,
                },
                {
                    "TaskID": "2",
                    "PJobName": "2.C2.P1",
                    "RouteRecipe": task2_route,
                },
            ],
        },
    }

    restored = restore_dummy_routes_from_algorithm_output(update, output)

    assert restored == [100001]
    material = update["Materials"][0]
    assert material["TaskID"] == "2"
    assert material["PJobName"] == "2.C2.P1"
    assert material["Route"]["Name"] == "task-2-route"
    assert material["CurrentModuleName"] == "LA"
    assert material["StepID"] == 2
    assert material["Count"] == 9


def test_dummy_projected_to_source_with_running_move_is_still_inflight() -> None:
    """回片 Move 尚在 Running 时，即使投影到 DummyPort 也不得提前清空归属。"""
    route = {
        "Name": "returning-route",
        "RouteSteps": [{
            "StepID": 8,
            "Visits": [{"StationName": "DummyPort"}],
            "PostStepID": [],
        }],
    }
    update = {
        "CurrentTime": 50.0,
        "MoveStates": [{"MoveID": 8, "MoveState": "Running"}],
        "Materials": [{
            "ID": 100002,
            "TaskID": "2",
            "PJobName": "2.C2.P1",
            "Route": {},
            "CurrentModuleName": "DummyPort",
            "StepID": 8,
            "SrcPortName": "DummyPort",
            "Count": 4,
        }],
    }
    output = {
        "MoveList": [{
            "MoveID": 8,
            "StartTime": 49.0,
            "MatIDList": [100002],
            "TaskID": ["2"],
            "PJobName": ["2.C2.P1"],
        }],
        "DummyReturnInfo": {
            "100002": [{
                "TaskID": "2",
                "PJobName": "2.C2.P1",
                "RouteRecipe": route,
            }],
        },
    }

    restore_dummy_routes_from_algorithm_output(update, output)

    material = update["Materials"][0]
    assert material["TaskID"] == "2"
    assert material["Route"]["Name"] == "returning-route"
    assert material["StepID"] == 8
    assert material["Count"] == 4


def test_external_validation_compile_clears_predummy_only_in_copy(monkeypatch) -> None:
    """外部算法计划的校验副本应禁止二次合成 Dummy，且不能修改真实 update。"""
    route = {
        "Name": "product-route",
        "RouteSteps": [],
        "PrePJob": {"PM1": [{"CheckConditions": {"Dummy": []}}]},
    }
    update = {
        "ProcessJobs": [{"JobName": "1.C1.P1", "OriginRoute": deepcopy(route)}],
    }
    captured = {}

    def capture_compile(tool_topology, validation_update):
        """捕获平台实际交给内置编译器的校验副本。"""
        captured["tool"] = tool_topology
        captured["update"] = validation_update
        return "validation-problem"

    monkeypatch.setattr("realtime_scheduler.server.compile_problem", capture_compile)

    result = _compile_external_validation_problem({"Stations": {}}, update)

    assert result == "validation-problem"
    assert captured["update"]["ProcessJobs"][0]["OriginRoute"]["PrePJob"] == {}
    assert update["ProcessJobs"][0]["OriginRoute"]["PrePJob"]


def test_server_does_not_implement_machine_state_snapshot_replay() -> None:
    """HTTP 服务边界不得重新承载 MachineState 到 update 的回写实现。"""
    server_source = (
        ROOT / "realtime_scheduler" / "server.py"
    ).read_text(encoding="utf-8")

    assert "def _apply_machine_state_to_update" not in server_source
    assert "from realtime_scheduler.recompute_state import (" in server_source
    assert "apply_machine_state_to_update(update" in server_source
