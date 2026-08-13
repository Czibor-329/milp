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
    assert material["Route"] == route_recipe
    assert material["PJobName"] == "1.C1.P1"
    assert material["TaskID"] == "1"


def test_idle_dummy_consumes_returned_route_by_material_id() -> None:
    """算法已按 MatID 返回信息时，即使 Dummy 未出发也必须直接回填。"""
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
    assert update["Materials"][0]["Route"]["Name"] == "unstarted-route"
    assert update["Materials"][0]["PJobName"] == "1.C1.P1"


def test_only_dummy_ids_present_in_return_info_are_restored() -> None:
    """一组空 Dummy 中只回填算法实际返回的 MatID，其余库存保持为空。"""
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
    ] == [True, True, False, False, False]


def test_external_validation_compile_clears_predummy_only_in_copy(monkeypatch) -> None:
    """外部算法计划的校验副本应禁止二次合成 Dummy，且不能修改真实 update。"""
    route = {
        "Name": "product-route",
        "RouteSteps": [],
        "PrePJob": {"PM1": [{"CheckConditions": {"Dummy": []}}]},
    }
    update = {
        "Routes": {"product-route": deepcopy(route)},
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
    assert captured["update"]["Routes"]["product-route"]["PrePJob"] == {}
    assert update["ProcessJobs"][0]["OriginRoute"]["PrePJob"]
    assert update["Routes"]["product-route"]["PrePJob"]


def test_server_does_not_implement_machine_state_snapshot_replay() -> None:
    """HTTP 服务边界不得重新承载 MachineState 到 update 的回写实现。"""
    server_source = (
        ROOT / "realtime_scheduler" / "server.py"
    ).read_text(encoding="utf-8")

    assert "def _apply_machine_state_to_update" not in server_source
    assert "from realtime_scheduler.recompute_state import (" in server_source
    assert "apply_machine_state_to_update(update" in server_source
