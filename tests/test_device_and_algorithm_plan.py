"""设备投影、算法入口与基础计划构建测试。"""

from __future__ import annotations

import copy
from concurrent.futures import Future
import inspect
import json
import os
import re
import tempfile
import threading
import time
import unittest
import zipfile
from io import BytesIO
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

import realtime_scheduler.backend.application as config_server
import realtime_scheduler.backend.algorithms.interface as algorithm_interface
from realtime_scheduler.backend.execution.plan_builder import _runtime_clean, build_process_recipes
from src.compiler import compile_problem
from realtime_scheduler.backend.application import (
    BuildState,
    LoggedPlanError,
    build_round_update,
    build_route,
    create_workspace_test,
    delete_workspace_device,
    delete_workspace_test,
    execute_plan,
    extract_init_data,
    get_workspace_device,
    import_workspace_device,
    list_workspace_devices,
    update_workspace_test,
)
from scripts.replay_config_log import load_plan_from_log
from tests.support.plan_fixtures import DEVICE_PATH, PSE300_DEVICE_PATH, job as _job, route as _route


ROOT = Path(__file__).resolve().parents[1]
EDITOR_PATH = ROOT / "realtime_scheduler" / "frontend" / "config_editor.html"
DOCUMENTATION_PAGE_PATH = ROOT / "realtime_scheduler" / "frontend" / "documentation.html"
EDITOR_STYLE_PATH = ROOT / "realtime_scheduler" / "frontend" / "assets" / "config_editor.css"
EDITOR_SCRIPT_PATH = ROOT / "realtime_scheduler" / "frontend" / "src" / "config_editor.ts"
DOCUMENTATION_SCRIPT_PATH = ROOT / "realtime_scheduler" / "frontend" / "src" / "documentation_page.ts"


def _editor_source() -> str:
    """合并页面模板、样式和 TypeScript 源码，供前端结构回归断言使用。"""
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in (EDITOR_PATH, EDITOR_STYLE_PATH, EDITOR_SCRIPT_PATH)
    )


def _device_recording() -> list[dict]:
    """读取包含 AlgInit 的项目内实时重算小设备案例。"""
    return json.loads(DEVICE_PATH.read_text(encoding="utf-8"))

class ConfigEditorDeviceTests(unittest.TestCase):
    """设备投影、算法入口与基础计划构建。"""

    def setUp(self) -> None:
        """为每个案例提取同一份设备拓扑。"""
        self.recording = _device_recording()
        self.device = extract_init_data(self.recording)

    def test_zero_duration_move_finishes_before_next_same_time_move_starts(self) -> None:
        """零时长动作应在同刻更大 MoveID 的动作开始前完成。"""
        groups = config_server._planned_event_groups([
            {"MoveID": 59, "MoveType": 7, "StartTime": 103.65, "EndTime": 103.65},
            {"MoveID": 60, "MoveType": 6, "StartTime": 103.65, "EndTime": 103.78},
        ])
        group = next(item for item in groups if abs(item["time"] - 103.65) < 1e-9)

        events = [
            (event_kind, notification["MoveID"])
            for event_kind, _, notification in config_server._planned_start_events(group)
        ]
        self.assertEqual([("start", 59), ("finish", 59), ("start", 60)], events)

    def test_extract_init_data_from_recording(self) -> None:
        """input_data 录制数组应提取设备字段并丢弃非标准顶层 Route。"""
        self.assertIn("Stations", self.device)
        recording = _device_recording()
        recording[0]["Info"]["Routes"] = {"Legacy": {}}
        self.assertNotIn("Routes", extract_init_data(recording))

    def test_discovers_standard_algorithms_below_other_alg(self) -> None:
        """后端应按当前目录契约发现算法，不依赖开发机上的可选交付物。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            algorithm_root = Path(temporary_directory) / "other_alg"
            entry = algorithm_root / "sample" / "src" / "infer" / "scheduler.py"
            entry.parent.mkdir(parents=True)
            entry.write_text(
                "def init(data):\n    return None\n"
                "def update(data):\n    return {'MoveList': []}\n",
                encoding="utf-8",
            )
            with patch.object(
                algorithm_interface,
                "OTHER_ALGORITHM_ROOT",
                algorithm_root,
            ):
                algorithms = algorithm_interface.discover_other_algorithms()

        self.assertEqual(1, len(algorithms))
        self.assertEqual("sample", algorithms[0]["id"])
        self.assertEqual("other_alg:sample", algorithms[0]["strategy"])
        self.assertEqual("src/infer/scheduler.py", algorithms[0]["entry"])
        self.assertIn("Robots", self.device)
        self.assertIn("PM1", self.device["Stations"])
        self.assertIn("LP1", self.device["Stations"])

    def test_frontend_contains_search_strategy_controls(self) -> None:
        """页面应动态生成算法选择，但不显示宏周期的旧兼容参数。"""
        source = _editor_source()
        for marker in (
            "status.algorithms",
            "updateStrategyOptionVisibility",
            "algorithm?.optionGroups",
        ):
            self.assertIn(marker, source)
        self.assertNotIn('data-option="loadLockMacroSearchSeconds"', source)
        self.assertNotIn('data-option="loadLockMacroRollouts"', source)
        self.assertNotIn("兼容参数：旧前瞻秒数", source)
        self.assertNotIn('data-option="loadLockExchange"', source)
        self.assertNotIn("禁用交换", source)

    def test_frontend_exposes_three_heuristic_loadlock_radios(self) -> None:
        """Heuristic 只暴露与算法配置同名的三个 LoadLock 单选参数，并复用仓库既有的勾选样式。"""
        source = _editor_source()
        self.assertIn('class="heuristic-loadlock-options"', source)
        for option in ("loadLockDirection", "loadLockCapacity", "loadLockBindBatch"):
            self.assertIn(f'data-heuristic-dialog-option="{option}" type="radio"', source)
        self.assertIn('class="run-setting-option heuristic-loadlock-choice"', source)
        self.assertIn(".heuristic-loadlock-choice", source)
        self.assertIn(".run-setting-option:has(input:checked)", source)
        self.assertIn('state.strategy !== "heuristic"', EDITOR_SCRIPT_PATH.read_text(encoding="utf-8"))

    def test_frontend_does_not_expose_removed_milp_strategy(self) -> None:
        """页面、状态和健康检查不再暴露已移除的 MILP 策略。"""
        source = _editor_source()

        self.assertNotIn('id="milpStrategyInput"', source)
        self.assertNotIn('value="milp"', source)
        self.assertNotIn("status.strategies?.milp", source)
        self.assertNotIn("configuredWaferCount", source)
        self.assertNotIn("milpTimeLimit", source)
        self.assertNotIn("milp", config_server.BUILTIN_ALGORITHM_METADATA)

    def test_discovers_builtin_algorithms_from_repository_catalog(self) -> None:
        """算法仓库清单新增策略后，服务应直接返回其前端卡片定义。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            catalog_path = Path(temporary_directory) / "algorithms.json"
            catalog_path.write_text(json.dumps({
                "schemaVersion": 1,
                "algorithms": [{
                    "id": "new-search",
                    "name": "新搜索算法",
                    "introduction": "用于验证动态算法目录。",
                    "optionGroups": ["loadlock"],
                }],
            }, ensure_ascii=False), encoding="utf-8")
            with (
                patch.object(config_server, "BUILTIN_ALGORITHM_CATALOG_PATH", catalog_path),
                patch.object(config_server, "builtin_supported_algorithms", frozenset({"new-search"})),
                patch.object(config_server, "BUILTIN_ALGORITHM_AVAILABLE", True),
            ):
                algorithms = config_server.discover_builtin_algorithms()

                catalog_path.write_text(json.dumps({
                    "schemaVersion": 1,
                    "algorithms": [{"id": "new-search", "enabled": False}],
                }), encoding="utf-8")
                algorithms_after_disable = config_server.discover_builtin_algorithms()

        self.assertEqual(["new-search"], [item["strategy"] for item in algorithms])
        self.assertEqual("新搜索算法", algorithms[0]["name"])
        self.assertTrue(algorithms[0]["available"])
        self.assertEqual(["loadlock"], algorithms[0]["optionGroups"])
        self.assertEqual([], algorithms_after_disable)

    def test_frontend_contains_extensible_device_config_and_robot_slot_save(self) -> None:
        """设备配置页应提供站点时间、机器手时间和独立槽位配置。"""
        source = _editor_source()
        for marker in (
            'data-tab-target="device-config"',
            'data-tab-view="device-config"',
            "设备配置分类",
            "设备时间",
            "机器手时间",
            "机器手槽位",
            'id="deviceStationTimingEditor"',
            'id="deviceRobotTimingEditor"',
            'id="previousDeviceStationButton"',
            'id="nextDeviceStationButton"',
            'id="previousDeviceRobotButton"',
            'id="nextDeviceRobotButton"',
            'id="saveDeviceTimingButton"',
            '"device-timing-target":',
            'data-robot-transfer-axis=',
            'data-robot-transfer-station=',
            'data-robot-transfer-fill="0"',
            'data-robot-transfer-fill="1"',
            'data-robot-transfer-fill="all"',
            "Station action fields",
            "PickPrepareTime",
            "PickCompleteTime",
            "PlacePrepareTime",
            "PlaceCompleteTime",
            "PostCompleteTime",
            "Robot action fields",
            "PickTime",
            "PlaceTime",
            "PrepTransTime",
            "SrcStation",
            "DestStation",
            "TransType=0",
            "TransType=1",
            "/device-timing",
            'id="robotSlotList"',
            'data-robot-arm-count="1"',
            'data-robot-arm-count="2"',
            'data-robot-slot-default=',
            "恢复默认",
            "/robot-slots",
            "ArmInfo",
            "parseDeviceFileText",
            "JSON.parse(`[${records}]`)",
        ):
            self.assertIn(marker, source)
        self.assertNotIn("所有数值单位均为秒。这里只编辑设备文件已经声明的计时项", source)
        self.assertNotIn("机器手的取放片时间按目标站点配置", source)

    def test_robot_slot_selection_projects_single_and_dual_arm_fields(self) -> None:
        """单/双臂只投影为独立 Arm，不创建 Robot.Slot 或改写 CanMultiTrans。"""
        single_arm_device = json.loads(json.dumps(self.device))
        original_vtr_multi_trans = single_arm_device["Robots"]["VTR"]["CanMultiTrans"]
        selected = config_server.apply_robot_slot_selection(
            single_arm_device,
            {"ATR": [1], "VTR": [1]},
        )
        self.assertEqual([1], selected["VTR"])
        self.assertNotIn("Slot", single_arm_device["Robots"]["VTR"])
        self.assertEqual(1, single_arm_device["Robots"]["VTR"]["Capacity"])
        self.assertEqual(
            original_vtr_multi_trans,
            single_arm_device["Robots"]["VTR"]["CanMultiTrans"],
        )
        self.assertEqual(
            {"ArmA": [1]},
            {
                arm_name: arm["SlotIDs"]
                for arm_name, arm in single_arm_device["Robots"]["VTR"]["ArmInfo"].items()
            },
        )

        dual_arm_device = json.loads(json.dumps(self.device))
        config_server.apply_robot_slot_selection(
            dual_arm_device,
            {"ATR": [1, 2], "VTR": [1, 2]},
        )
        dual_atr = dual_arm_device["Robots"]["ATR"]
        self.assertNotIn("Slot", dual_atr)
        self.assertEqual(2, dual_atr["Capacity"])
        self.assertEqual(self.device["Robots"]["ATR"]["CanMultiTrans"], dual_atr["CanMultiTrans"])
        self.assertEqual(
            {"ArmA": [1], "ArmB": [2]},
            {arm_name: arm["SlotIDs"] for arm_name, arm in dual_atr["ArmInfo"].items()},
        )
        dual_false_device = json.loads(json.dumps(self.device))
        dual_false_device["Robots"]["VTR"]["CanMultiTrans"] = False
        config_server.apply_robot_slot_selection(
            dual_false_device,
            {"ATR": [1], "VTR": [1, 2]},
        )
        self.assertFalse(dual_false_device["Robots"]["VTR"]["CanMultiTrans"])
        self.assertEqual(
            {"ArmA": [1], "ArmB": [2]},
            {
                arm_name: arm["SlotIDs"]
                for arm_name, arm in dual_false_device["Robots"]["VTR"]["ArmInfo"].items()
            },
        )

        defaults = config_server.normalize_robot_slot_selection(
            self.device,
            {},
        )
        self.assertEqual([1], defaults["ATR"])
        self.assertEqual([1, 2], defaults["VTR"])

        restored_device = json.loads(json.dumps(self.device))
        config_server.apply_robot_slot_selection(restored_device, defaults)
        for robot_name, original_robot in self.device["Robots"].items():
            self.assertEqual(
                original_robot["ArmInfo"],
                restored_device["Robots"][robot_name]["ArmInfo"],
            )

    def test_multi_slot_arm_is_not_split_when_projecting_dual_chamber_robot(self) -> None:
        """双腔设备的一条物理 Arm 可保留两个槽位，不能被投影成两条假 Arm。"""
        device = {
            "Robots": {
                "VACRobot": {
                    "Capacity": 4,
                    "CanMultiTrans": False,
                    "ArmInfo": {
                        "ArmA": {"Name": "ArmA", "IsEnable": True, "SlotIDs": [1, 2]},
                        "ArmB": {"Name": "ArmB", "IsEnable": True, "SlotIDs": [3, 4]},
                    },
                },
            },
        }
        single_arm = json.loads(json.dumps(device))
        config_server.apply_robot_slot_selection(single_arm, {"VACRobot": [1, 2]})
        self.assertEqual(2, single_arm["Robots"]["VACRobot"]["Capacity"])
        self.assertEqual(
            {"ArmA": [1, 2]},
            {
                name: arm["SlotIDs"]
                for name, arm in single_arm["Robots"]["VACRobot"]["ArmInfo"].items()
            },
        )

        dual_arm = json.loads(json.dumps(device))
        config_server.apply_robot_slot_selection(dual_arm, {"VACRobot": [1, 2, 3, 4]})
        self.assertEqual(4, dual_arm["Robots"]["VACRobot"]["Capacity"])
        self.assertEqual(
            {"ArmA": [1, 2], "ArmB": [3, 4]},
            {
                name: arm["SlotIDs"]
                for name, arm in dual_arm["Robots"]["VACRobot"]["ArmInfo"].items()
            },
        )

    def test_workspace_robot_slot_selection_is_persisted_and_used_by_batch_plan(self) -> None:
        """设备级槽位设置应持久保存，并进入批量计划与 Baseline 指纹输入。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            workspace_device, _ = import_workspace_device(
                "device.json", self.device, store_path,
            )
            selection = {
                robot_name: [config_server.robot_available_slots(robot)[0]]
                for robot_name, robot in self.device["Robots"].items()
            }
            saved = config_server.update_workspace_robot_slots(
                workspace_device["id"], selection, store_path,
            )
            reloaded = get_workspace_device(workspace_device["id"], store_path)
            plan = config_server.build_workspace_batch_plan(
                reloaded,
                {"rounds": [], "options": {}},
                "heuristic",
                {},
            )

        self.assertEqual(selection, saved)
        self.assertEqual(selection, reloaded["robotSlots"])
        for robot_name, selected_slots in selection.items():
            planned_robot = plan["device"]["Robots"][robot_name]
            self.assertNotIn("Slot", planned_robot)
            self.assertEqual(1, planned_robot["Capacity"])
            self.assertEqual(
                self.device["Robots"][robot_name]["CanMultiTrans"],
                planned_robot["CanMultiTrans"],
            )
            self.assertEqual(
                selected_slots,
                [slot_id for arm in planned_robot["ArmInfo"].values() for slot_id in arm["SlotIDs"]],
            )
        with self.assertRaisesRegex(ValueError, "不支持槽位"):
            config_server.normalize_robot_slot_selection(
                self.device,
                {**selection, "VTR": [999]},
            )

    def test_workspace_device_timing_is_validated_and_persisted(self) -> None:
        """站点与机器手时间应持久化，且未知拓扑项和负数必须被拒绝。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            workspace_device, _ = import_workspace_device(
                "device.json", self.device, store_path,
            )
            imported_device = workspace_device["device"]
            station_name, station = next(
                (name, item)
                for name, item in imported_device["Stations"].items()
                if item.get("PickPrepareTime")
            )
            station_robot = next(iter(station["PickPrepareTime"]))
            robot_name, robot = next(
                (name, item)
                for name, item in imported_device["Robots"].items()
                if item.get("PickTime") and item.get("PrepTransTime")
            )
            robot_station = next(iter(robot["PickTime"]))
            transfer_times = [float(row["Time"]) for row in robot["PrepTransTime"]]
            transfer_times[0] = 8.75
            timing = {
                "stations": {
                    station_name: {"PickPrepareTime": {station_robot: 6.25}},
                },
                "robots": {
                    robot_name: {
                        "PickTime": {robot_station: 7.5},
                        "PrepTransTime": transfer_times,
                    },
                },
            }
            saved = config_server.update_workspace_device_timing(
                workspace_device["id"], timing, store_path,
            )
            reloaded = get_workspace_device(workspace_device["id"], store_path)
            with self.assertRaisesRegex(ValueError, "未知设备"):
                config_server.update_workspace_device_timing(
                    workspace_device["id"],
                    {"stations": {"UNKNOWN": {}}},
                    store_path,
                )
            with self.assertRaisesRegex(ValueError, "非负有限秒数"):
                config_server.update_workspace_device_timing(
                    workspace_device["id"],
                    {"robots": {robot_name: {"PickTime": {robot_station: -1}}}},
                    store_path,
                )

        self.assertEqual(6.25, saved["Stations"][station_name]["PickPrepareTime"][station_robot])
        self.assertEqual(7.5, saved["Robots"][robot_name]["PickTime"][robot_station])
        self.assertEqual(8.75, reloaded["device"]["Robots"][robot_name]["PrepTransTime"][0]["Time"])
        self.assertEqual(
            imported_device["Stations"][station_name]["Capacity"],
            reloaded["device"]["Stations"][station_name]["Capacity"],
        )

    def test_frontend_limits_buffer_and_edits_cjob_load_port(self) -> None:
        """页面应限制 BufferOption，并只在 CJob 层编辑固定 LoadPort。"""
        source = _editor_source()
        buffer_select = source.split('data-key="bufferOption"', 1)[1].split("</select>", 1)[0]
        self.assertIn('const bufferModes = ["No Buffer",', source)
        self.assertIn("Math.max(0, Math.min(4", source)
        self.assertIn('<option value="${value}"', buffer_select)
        clean_placements = source.split("function cleanPlacementDefinitions(scope)", 1)[1]
        clean_placements = clean_placements.split("/** 返回当前 Route", 1)[0]
        self.assertIn('key: "prePJobCleanRefs"', clean_placements)
        self.assertIn('key: "postPJobCleanRefs"', clean_placements)
        self.assertIn('key: "afterCleanRefs", label: "离开腔室后", types: ["wacclean"]', clean_placements)
        self.assertNotIn('key: "beforeCleanRefs"', clean_placements)
        self.assertNotIn("postCJobCleanRefs", clean_placements)
        self.assertNotIn("LoadPort（自动）", source)
        self.assertIn('data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="loadPort"', source)
        self.assertNotIn('data-scope="pjob" data-key="loadPort"', source)

    def test_frontend_treats_heater_and_cooler_as_processing_modules(self) -> None:
        """热处理多槽腔室应生成 Recipe 和可见的加工时间条。"""
        source = _editor_source()
        self.assertIn("const PROCESSING_STATION_TYPES = new Set([", source)
        for station_type in (
            '"processchamber"',
            '"multiprocesschamber"',
            '"heater"',
            '"cooler"',
        ):
            self.assertIn(station_type, source)
        self.assertIn(
            "PROCESSING_STATION_TYPES.has(String(item.Type || \"\").trim().toLowerCase())",
            source,
        )

    def test_same_recipe_name_supports_module_specific_parameters(self) -> None:
        """同名 Recipe 在不同 PM 上可以使用不同加工时间，且仍由 Route 统一引用。"""
        plan = {
            "device": self.device,
            "recipes": [
                {"name": "SharedRecipe", "time": 60, "modules": ["PM1"], "weight": {}},
                {"name": "SharedRecipe", "time": 20, "modules": ["PM2"], "weight": {}},
            ],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "SharedRecipe")],
        }

        update = build_round_update(
            plan, {"jobs": [_job("Incoming", "Route12", "LP1")]}, 0.0, BuildState(),
        )

        recipe_times = {
            recipe["ModuleName"]: recipe["Time"] for recipe in update["ProcessRecipes"]
        }
        self.assertEqual({"PM1": 60.0, "PM2": 20.0}, recipe_times)
        self.assertEqual(set(self.device["Robots"]), set(update["Robots"]))
        self.assertEqual(set(self.device["Stations"]), set(update["Stations"]))

    def test_workspace_migration_repairs_empty_process_recipe(self) -> None:
        """旧 Route 的后续加工 Step 应根据稳定分组名补齐 Recipe。"""
        routes = [{
            "name": "显示名称",
            "group": "Route7",
            "stages": [{
                "stepId": 6,
                "needProcess": True,
                "visits": [{
                    "stationName": "PM2",
                    "processRecipe": "",
                    "processTime": 300,
                }],
            }],
        }]
        self.assertTrue(config_server._repair_workspace_route_recipes(routes))
        self.assertEqual("Route7_Step6", routes[0]["stages"][0]["visits"][0]["processRecipe"])
        self.assertFalse(config_server._repair_workspace_route_recipes(routes))

    def test_workspace_migration_restores_heater_and_cooler_process_steps(self) -> None:
        """旧页面漏写加工标记时，迁移应保留时长并恢复 Heater、Cooler 工序。"""
        routes = [{
            "name": "t1",
            "group": "PM1/PM2/PM3/PM4(60s)",
            "stages": [
                {
                    "stepId": 4,
                    "needProcess": False,
                    "visits": [{
                        "stationName": "heater",
                        "processRecipe": "",
                        "processTime": 20,
                        "recipeTime": 20,
                    }],
                },
                {
                    "stepId": 10,
                    "needProcess": False,
                    "visits": [{
                        "stationName": "Cooler",
                        "processRecipe": "",
                        "processTime": 20,
                        "recipeTime": 20,
                    }],
                },
            ],
        }]

        self.assertTrue(config_server._repair_workspace_route_recipes(
            routes,
            ["heater", "Cooler"],
        ))
        stages = routes[0]["stages"]
        self.assertEqual([True, True], [stage["needProcess"] for stage in stages])
        self.assertEqual(
            [
                "PM1/PM2/PM3/PM4(60s)_Step4",
                "PM1/PM2/PM3/PM4(60s)_Step10",
            ],
            [stage["visits"][0]["processRecipe"] for stage in stages],
        )
        self.assertEqual(
            [20, 20],
            [stage["visits"][0]["processTime"] for stage in stages],
        )
        self.assertFalse(config_server._repair_workspace_route_recipes(
            routes,
            ["heater", "Cooler"],
        ))

    def test_same_recipe_name_rejects_overlapping_modules(self) -> None:
        """同名 Recipe 只有模块范围重叠时才属于真正的重复定义。"""
        plan = {
            "device": self.device,
            "recipes": [
                {"name": "SharedRecipe", "time": 60, "modules": ["PM1", "PM2"], "weight": {}},
                {"name": "SharedRecipe", "time": 20, "modules": ["PM2"], "weight": {}},
            ],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "SharedRecipe")],
        }

        with self.assertRaisesRegex(ValueError, "Recipe 名称和模块重复：SharedRecipe"):
            build_round_update(
                plan, {"jobs": [_job("Incoming", "Route12", "LP1")]}, 0.0, BuildState(),
            )

    def test_task_alg_init_removes_every_unreferenced_module(self) -> None:
        """任务级 AlgInit 应同步移除 PM5/PM6 等所有未引用模块信息。"""
        device = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        route = _route("R1", "PM1", "R1_Step4")
        rounds = [{"jobs": [{**_job("P1", "R1", "LP1"), "waferCount": 1}]}]

        alg_init = config_server.build_task_alg_init(device, [route], rounds)

        used_stations = {"LP1", "LA", "LB", "PM1"}
        self.assertEqual(used_stations, set(alg_init["Stations"]))
        self.assertEqual({"ATR", "VTR"}, set(alg_init["Robots"]))
        for robot in alg_init["Robots"].values():
            self.assertTrue(set(robot.get("PickTime", {})) <= used_stations)
            self.assertTrue(set(robot.get("PlaceTime", {})) <= used_stations)
            self.assertTrue(all(
                row["SrcStation"] in used_stations
                and row["DestStation"] in used_stations
                for row in robot.get("PrepTransTime", [])
            ))
            for arm in robot.get("ArmInfo", {}).values():
                self.assertTrue(set(arm.get("AccessibleStations", [])) <= used_stations)
                self.assertTrue(all(
                    candidate["Key"] in used_stations
                    for slots in arm.get("SlotsStationMap", {}).values()
                    for candidates in slots.values()
                    for candidate in candidates
                ))

    def test_pse300_loadlock_does_not_switch_environment_twice_without_opening(self) -> None:
        """PSE300 多槽换片时，两次抽充气之间必须存在一次真实开门访问。"""
        device = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": "PSE300",
            "device": device,
            "strategy": "heuristic",
            "roundCount": 1,
            "options": {},
            "recipes": [
                {"name": "R3_Step4", "time": 60, "modules": ["PM1"], "weight": {}},
                {"name": "R3_Step4", "time": 20, "modules": ["PM2", "PM3", "PM4"], "weight": {}},
            ],
            "cleans": [],
            "routes": [_route("R3", "PM1,PM2,PM3,PM4", "R3_Step4")],
            "rounds": [{"currentTime": 0, "jobs": [{
                **_job("P1", "R3", "LP1"), "waferCount": 15,
            }]}],
        }

        moves = execute_plan(plan)["output"]["MoveList"]

        for loadlock in ("LA", "LB"):
            last_event_type = None
            for move in sorted(moves, key=lambda item: (item["StartTime"], item["MoveID"])):
                if move.get("ModuleName") != loadlock or move.get("MoveType") not in {6, 10}:
                    continue
                self.assertFalse(
                    last_event_type == 10 and move["MoveType"] == 10,
                    f"{loadlock} 未开门便连续切换环境：MoveID={move['MoveID']}",
                )
                last_event_type = move["MoveType"]

    @unittest.skipUnless(
        (ROOT / "alg" / "results" / "models" / "e2e_ctq_policy.npz").is_file(),
        "默认 E2E 模型未随仓库交付",
    )
    def test_e2e_ctq_persists_decision_trace_for_topology_playback(self) -> None:
        """E2E 候选评分应进入结果文件，运行摘要只保留轨迹计数。"""
        from src.schedule.strategies.e2e_ctq import DEFAULT_MODEL_PATH, load_e2e_ctq_policy

        plan = {
            "deviceName": DEVICE_PATH.name,
            "device": self.device,
            "strategy": "e2e-ctq",
            "roundCount": 1,
            "options": {},
            "recipes": [{
                "name": "DecisionTraceRecipe",
                "time": 40,
                "modules": ["PM1", "PM2"],
                "weight": {},
            }],
            "cleans": [],
            "routes": [_route(
                "DecisionTraceRoute",
                "PM1,PM2",
                "DecisionTraceRecipe",
            )],
            "rounds": [{
                "currentTime": 0,
                "jobs": [{
                    **_job("DecisionTraceJob", "DecisionTraceRoute", "LP1"),
                    "waferCount": 2,
                }],
            }],
        }
        policy = load_e2e_ctq_policy(DEFAULT_MODEL_PATH)

        with patch("src.api._load_policy", return_value=policy):
            result = execute_plan(plan)

        trace = result["output"]["DecisionTrace"]
        self.assertGreater(len(trace), 0)
        self.assertEqual("e2e-ctq-decision-trace-v1", result["output"]["DecisionTraceMeta"]["schema"])
        self.assertGreaterEqual(trace[0]["candidateCount"], 1)
        self.assertIn("policyPreference", trace[0]["candidates"][0])
        diagnostics = result["rounds"][0]["strategyDiagnostics"]
        self.assertNotIn("decisionTrace", diagnostics)
        self.assertEqual(len(trace), diagnostics["decisionTraceCount"])

    def test_local_standard_algorithm_calls_formal_init_and_update(self) -> None:
        """前端选择 other_alg 算法后应通过本地正式 init/update 入口完成首排。"""
        plan = {
            "deviceName": "fixture.json",
            "device": self.device,
            "strategy": "other_alg:greedy",
            "roundCount": 1,
            "options": {},
            "recipes": [{
                "name": "GreedyRecipe",
                "time": 20,
                "modules": ["PM1", "PM2"],
                "weight": {},
            }],
            "cleans": [],
            "routes": [_route("GreedyRoute", "PM1,PM2", "GreedyRecipe")],
            "rounds": [{
                "currentTime": 0,
                "jobs": [_job("GreedyJob", "GreedyRoute", "LP1")],
            }],
        }
        external_output = {
            "MoveList": [{
                "MoveID": 1,
                "MoveType": 9,
                "StartTime": 2.0,
                "EndTime": 22.0,
                "ModuleName": "PM1",
            }],
            "Feedback": [],
            "JobList": [{"JobName": "GreedyJob.P1"}],
            "DummyReturnInfo": {},
            "MatIntoPM": {"1": ["PM1"]},
        }

        with (
            patch("realtime_scheduler.backend.execution.service.discover_other_algorithms", return_value=[{"id": "greedy", "strategy": "other_alg:greedy"}]),
            patch.object(config_server, "algorithm_session", return_value=nullcontext()),
            patch.object(config_server, "algorithm_init") as init_entry,
            patch.object(config_server, "algorithm_update", return_value=external_output) as update_entry,
        ):
            result = execute_plan(plan)

        init_entry.assert_called_once()
        init_payload = init_entry.call_args.args[0]
        self.assertEqual(self.device["Stations"]["PM1"], init_payload["Stations"]["PM1"])
        self.assertNotIn("LC", init_payload["Stations"])
        self.assertNotIn("LD", init_payload["Stations"])
        update_payload = update_entry.call_args.args[0]
        self.assertEqual(set(init_payload["Robots"]), set(update_payload["Robots"]))
        self.assertEqual(set(init_payload["Stations"]), set(update_payload["Stations"]))
        self.assertEqual("other_alg:greedy", result["strategy"])
        self.assertEqual(1, result["moveCount"])
        self.assertEqual("scheduler.py init/update", result["rounds"][0]["strategyDiagnostics"]["entry"])

    def test_local_standard_algorithm_uses_machine_state_for_two_recomputes(self) -> None:
        """两次重算应返回全量 update，并按状态机填写旧计划 RemoveList。"""
        plan = {
            "device": self.device,
            "strategy": "other_alg:greedy",
            "roundCount": 3,
            "recipes": [{"name": "R", "time": 20, "modules": ["PM1"], "weight": {}}],
            "cleans": [],
            "routes": [_route("R", "PM1", "R")],
            "rounds": [
                {"currentTime": 0, "jobs": [_job("J1", "R", "LP1")]},
                {"currentTime": 10, "jobs": [_job("J2", "R", "LP2")]},
                {"currentTime": 20, "jobs": [_job("J3", "R", "LP3")]},
            ],
        }
        external_outputs = [
            {
                "MoveList": [{
                    "MoveID": 1, "MoveType": 9,
                    "StartTime": 100.0, "EndTime": 120.0, "ModuleName": "PM1",
                }],
                "Feedback": [],
            },
            {
                "MoveList": [{
                    "MoveID": 1, "MoveType": 9,
                    "StartTime": 200.0, "EndTime": 220.0, "ModuleName": "PM1",
                }],
                "Feedback": [],
            },
            {
                "MoveList": [{
                    "MoveID": 1, "MoveType": 9,
                    "StartTime": 300.0, "EndTime": 320.0, "ModuleName": "PM1",
                }],
                "Feedback": [],
            },
        ]

        with (
            patch("realtime_scheduler.backend.execution.service.discover_other_algorithms", return_value=[{"id": "greedy", "strategy": "other_alg:greedy"}]),
            patch.object(config_server, "algorithm_session", return_value=nullcontext()),
            patch.object(config_server, "algorithm_init") as init_entry,
            patch.object(
                config_server,
                "algorithm_update",
                side_effect=external_outputs,
            ) as update_entry,
        ):
            result = execute_plan(plan)

        init_entry.assert_called_once()
        self.assertEqual(3, update_entry.call_count)
        second_update = update_entry.call_args_list[1].args[0]
        third_update = update_entry.call_args_list[2].args[0]
        self.assertEqual([1], second_update["RemoveList"])
        self.assertEqual([], second_update["MoveStates"])
        self.assertEqual(2, len(second_update["Materials"]))
        self.assertEqual(2, len(second_update["ProcessJobs"]))
        self.assertEqual(2, len(second_update["ControlJobs"]))
        self.assertEqual(3, len(third_update["Materials"]))
        self.assertEqual(3, len(third_update["ProcessJobs"]))
        self.assertEqual(3, len(third_update["ControlJobs"]))
        self.assertEqual("ATR", second_update["Stations"]["LA"]["LastItem"])
        self.assertEqual(
            "realtime_scheduler.backend.validation.move_validation.MachineState",
            result["rounds"][1]["strategyDiagnostics"]["stateSource"],
        )
        self.assertEqual(3, len(result["updates"]))
        self.assertEqual(2, len(result["output"]["RecomputePoints"]))

    def test_standard_algorithm_recompute_returns_dummy_route_from_previous_output(self) -> None:
        """平台应在调用下一轮 update 前回填上一轮返回的 DummyReturnInfo。"""
        plan = {
            "device": self.device,
            "strategy": "other_alg:greedy",
            "roundCount": 2,
            "recipes": [{"name": "R", "time": 20, "modules": ["PM1"], "weight": {}}],
            "cleans": [],
            "routes": [_route("R", "PM1", "R")],
            "rounds": [
                {"currentTime": 0, "jobs": [_job("J1", "R", "LP1")]},
                {"currentTime": 10, "jobs": [_job("J2", "R", "LP2")]},
            ],
        }
        route_recipe = {
            "Name": "dummy-pm1-route",
            "RouteSteps": [{
                "StepID": 4,
                "Visits": [{"StationName": "PM1"}],
                "NeedProcess": True,
            }],
        }
        first_output = {
            "MoveList": [{
                "MoveID": 1,
                "MoveType": 9,
                "StartTime": 100.0,
                "EndTime": 120.0,
                "ModuleName": "PM1",
            }],
            "Feedback": [],
            "DummyReturnInfo": {
                "100000": [{
                    "TaskID": "1",
                    "PJobName": "1.C1.P1",
                    "RouteRecipe": route_recipe,
                }],
            },
        }
        second_output = {
            "MoveList": [{
                "MoveID": 2,
                "MoveType": 9,
                "StartTime": 200.0,
                "EndTime": 220.0,
                "ModuleName": "PM1",
            }],
            "Feedback": [],
        }

        def add_dummy_to_first_update(update):
            payload = copy.deepcopy(update)
            payload["Materials"].append({
                "ID": 100000,
                "TaskID": "",
                "PJobName": "",
                "Route": {},
                "CurrentModuleName": "PM1",
                "SlotID": 1,
                "StepID": 4,
                "SrcPortName": "DummyPort",
                "AccessiblePM": ["PM1"],
            })
            return payload

        original_builder = config_server.build_round_update
        with (
            patch("realtime_scheduler.backend.execution.service.discover_other_algorithms", return_value=[{"id": "greedy", "strategy": "other_alg:greedy"}]),
            patch.object(config_server, "algorithm_session", return_value=nullcontext()),
            patch.object(config_server, "algorithm_init"),
            patch.object(config_server, "algorithm_update", side_effect=[first_output, second_output]) as update_entry,
            patch.object(
                config_server,
                "build_round_update",
                side_effect=lambda *args, **kwargs: (
                    add_dummy_to_first_update(original_builder(*args, **kwargs))
                    if float(args[2]) == 0.0
                    else original_builder(*args, **kwargs)
                ),
            ),
        ):
            execute_plan(plan)

        second_update = update_entry.call_args_list[1].args[0]
        dummy = next(
            material
            for material in second_update["Materials"]
            if material["ID"] == 100000
        )
        self.assertEqual(route_recipe, dummy["Route"])
        self.assertEqual("1.C1.P1", dummy["PJobName"])
        self.assertEqual("1", dummy["TaskID"])

    def test_standard_algorithm_recovery_completes_loadlock_environment(self) -> None:
        """标准算法收尾应执行 LoadLock 关门后的带片压力转换。"""
        moves = [
            {
                "MoveID": 1, "MoveType": 1, "MatIDList": [1],
                "StartTime": 10.0, "EndTime": 12.0,
                "DestStationList": ["LA"],
            },
            {
                "MoveID": 2, "MoveType": 7, "MatIDList": [1],
                "StartTime": 12.0, "EndTime": 13.0, "ModuleName": "LA",
            },
            {
                "MoveID": 3, "MoveType": 10, "MatIDList": [1],
                "StartTime": 13.0, "EndTime": 30.0, "ModuleName": "LA",
            },
        ]

        normal_tail = config_server._transport_tail_ids(moves, 1, 11.0)
        algorithm_tail = config_server._transport_tail_ids(
            moves,
            1,
            11.0,
            include_loadlock_environment=True,
        )

        self.assertNotIn(3, normal_tail)
        self.assertIn(3, algorithm_tail)
