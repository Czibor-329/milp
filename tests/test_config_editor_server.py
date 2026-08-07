"""调度终端本地服务的请求展开与多轮重算测试。"""

from __future__ import annotations

import copy
import inspect
import json
import tempfile
import threading
import time
import unittest
import zipfile
from io import BytesIO
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

import realtime_scheduler.server as config_server
from realtime_scheduler.algorithm_interface import discover_other_algorithms
from realtime_scheduler.plan_builder import _runtime_clean
from src.parse import parse_task
from scripts.config_editor_server import (
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


ROOT = Path(__file__).resolve().parents[1]
ALGORITHM_ROOT = ROOT / "alg"
DEVICE_PATH = ALGORITHM_ROOT / "src" / "input_data" / "s1-1c2p-reschedule.json"
PSE300_PATH = ALGORITHM_ROOT / "src" / "input_data" / "PSE300.json"
EDITOR_PATH = ROOT / "realtime_scheduler" / "frontend" / "config_editor.html"
EDITOR_STYLE_PATH = ROOT / "realtime_scheduler" / "frontend" / "assets" / "config_editor.css"
EDITOR_SCRIPT_PATH = ROOT / "realtime_scheduler" / "frontend" / "src" / "config_editor.ts"


def _editor_source() -> str:
    """合并页面模板、样式和 TypeScript 源码，供前端结构回归断言使用。"""
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in (EDITOR_PATH, EDITOR_STYLE_PATH, EDITOR_SCRIPT_PATH)
    )


def _device_recording() -> list[dict]:
    """读取包含 AlgInit 的项目内实时重算小设备案例。"""
    return json.loads(DEVICE_PATH.read_text(encoding="utf-8"))


def _route(name: str, modules: str, recipe: str) -> dict:
    """创建测试用的完整源—加工—汇 Route。"""
    return {
        "name": name,
        "group": name,
        "bufferOption": 0,
        "prePJobCleanRefs": [],
        "postPJobCleanRefs": [],
        "postCJobCleanRefs": [],
        "stages": [
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": modules, "recipeRef": recipe, "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
        ],
    }


def _job(name: str, route: str, load_port: str) -> dict:
    """创建测试用单片 Job。"""
    return {
        "name": name,
        "routeRef": route,
        "loadPort": load_port,
        "waferCount": 1,
        "priority": 1,
        "weight": 1,
        "jobType": 0,
        "taskMode": 0,
        "foupId": name,
    }


class ConfigEditorServerTests(unittest.TestCase):
    """验证设备选择、Route 引用和两次重算的统一输出。"""

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
        """input_data 录制数组应只提取 AlgInit 的设备字段。"""
        self.assertIn("Stations", self.device)

    def test_discovers_standard_algorithms_below_other_alg(self) -> None:
        """后端应把 other_alg 下具有 infer/scheduler.py 的目录暴露给前端。"""
        algorithms = discover_other_algorithms()
        greedy = next(item for item in algorithms if item["id"] == "greedy")
        self.assertEqual("other_alg:greedy", greedy["strategy"])
        self.assertEqual("infer/scheduler.py", greedy["entry"])
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
        """页面应提供可扩展设备配置入口，并独立保存机器手单臂/双臂配置。"""
        source = _editor_source()
        for marker in (
            'data-tab-target="device-config"',
            'data-tab-view="device-config"',
            "设备配置分类",
            "机器手槽位",
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

    def test_frontend_limits_buffer_and_hides_automatic_load_port(self) -> None:
        """页面应限制 BufferOption，但不展示由系统自动分配的 LoadPort。"""
        source = _editor_source()
        buffer_input = source.split('data-key="bufferOption"', 1)[0].rsplit("<input", 1)[1]
        self.assertIn('min="0"', buffer_input)
        self.assertIn('max="4"', buffer_input)
        self.assertIn('step="1"', buffer_input)
        clean_placements = source.split("function cleanPlacementDefinitions(scope)", 1)[1]
        clean_placements = clean_placements.split("/** 返回当前 Route", 1)[0]
        self.assertIn('key: "prePJobCleanRefs"', clean_placements)
        self.assertIn('key: "postPJobCleanRefs"', clean_placements)
        self.assertNotIn("postCJobCleanRefs", clean_placements)
        self.assertNotIn("LoadPort（自动）", source)
        self.assertNotIn("LoadPort ${escapeHtml(cjob.loadPort", source)
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
        self.assertEqual(self.device["Robots"], update["Robots"])
        self.assertEqual(self.device["Stations"], update["Stations"])
        self.assertEqual(
            int(self.device.get("InitialMoveID") or 0),
            update["InitialMoveID"],
        )

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

    def test_pse300_expands_lc_and_ld_from_la_and_lb(self) -> None:
        """PSE300 应完整复制 LoadLock 及两台 Robot 的相关访问和计时参数。"""
        device = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        original_transfer_counts = {
            name: len(robot["PrepTransTime"]) for name, robot in device["Robots"].items()
        }

        self.assertTrue(config_server.expand_pse300_loadlocks(device))
        self.assertFalse(config_server.expand_pse300_loadlocks(device))
        for target, source in (("LC", "LA"), ("LD", "LB")):
            expected_station = json.loads(json.dumps(device["Stations"][source]).replace(source, target))
            self.assertEqual(expected_station, device["Stations"][target])
            for robot in device["Robots"].values():
                self.assertEqual(robot["PlaceTime"][source], robot["PlaceTime"][target])
                self.assertEqual(robot["PickTime"][source], robot["PickTime"][target])
                for arm in robot["ArmInfo"].values():
                    self.assertIn(target, arm["AccessibleStations"])
                    self.assertIn(target, arm["SlotsStationMap"])
                    self.assertTrue(all(
                        item["Key"] == target
                        for slots in arm["SlotsStationMap"][target].values()
                        for item in slots
                    ))
        self.assertIn(["LC", "LC"], device["Robots"]["VTR"]["ArmPointerPair"])
        self.assertIn(["LD", "LD"], device["Robots"]["VTR"]["ArmPointerPair"])
        for name, robot in device["Robots"].items():
            self.assertGreater(len(robot["PrepTransTime"]), original_transfer_counts[name])
            transfer_keys = {
                (item["SrcStation"], item["DestStation"], item["TransType"])
                for item in robot["PrepTransTime"]
            }
            self.assertTrue(all(
                (source, destination, transfer_type) in transfer_keys
                for source in ("LA", "LB", "LC", "LD")
                for destination in ("LA", "LB", "LC", "LD")
                for transfer_type in (0, 1)
            ))

    def test_pse300_loadlock_does_not_switch_environment_twice_without_opening(self) -> None:
        """PSE300 多槽换片时，两次抽充气之间必须存在一次真实开门访问。"""
        device = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
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

    def test_e2e_ctq_persists_decision_trace_for_topology_playback(self) -> None:
        """E2E 候选评分应进入结果文件，运行摘要只保留轨迹计数。"""
        from src.schedule.e2e_ctq import DEFAULT_MODEL_PATH, load_e2e_ctq_policy

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

        with patch("infer.function._load_policy", return_value=policy):
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
            patch.object(config_server, "algorithm_session", return_value=nullcontext()),
            patch.object(config_server, "algorithm_init") as init_entry,
            patch.object(config_server, "algorithm_update", return_value=external_output) as update_entry,
        ):
            result = execute_plan(plan)

        init_entry.assert_called_once()
        init_payload = init_entry.call_args.args[0]
        self.assertEqual(self.device["Stations"]["PM1"], init_payload["Stations"]["PM1"])
        self.assertIn("LC", init_payload["Stations"])
        self.assertIn("LD", init_payload["Stations"])
        update_payload = update_entry.call_args.args[0]
        self.assertEqual(init_payload["Robots"], update_payload["Robots"])
        self.assertEqual(init_payload["Stations"], update_payload["Stations"])
        self.assertEqual("other_alg:greedy", result["strategy"])
        self.assertEqual(1, result["moveCount"])
        self.assertEqual("CT.infer.scheduler.init/update", result["rounds"][0]["strategyDiagnostics"]["entry"])

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
        self.assertEqual("src.validation.state.MachineState", result["rounds"][1]["strategyDiagnostics"]["stateSource"])
        self.assertEqual(3, len(result["updates"]))
        self.assertEqual(2, len(result["output"]["RecomputePoints"]))

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

    def test_job_route_is_bound_to_selected_load_port(self) -> None:
        """Job 复用公共 Route 时应生成独立 Route 并改写首尾 LoadPort。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        update = build_round_update(
            plan,
            {"jobs": [_job("Incoming", "Route12", "LP3")]},
            10.0,
            BuildState(),
        )
        runtime_route = update["Routes"]["Route12__Incoming"]
        self.assertEqual("LP3", runtime_route["RouteSteps"][0]["Visits"][0]["StationName"])
        self.assertEqual("LP3", runtime_route["RouteSteps"][-1]["Visits"][0]["StationName"])
        self.assertEqual("Route12__Incoming", update["ProcessJobs"][0]["OriginRoute"]["Name"])

    def test_round_supports_multiple_cjobs_and_pjobs(self) -> None:
        """同一轮多个 CJob 应使用唯一 TaskID、独立 LoadPort 和稳定枚举。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        round_config = {
            "currentTime": 70,
            "cjobs": [
                {
                    "taskId": "2", "jobType": "NormalLot", "priority": 3, "taskMode": "Smart",
                    "pjobs": [
                        {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 2, "priority": 1},
                        {"jobName": "P2", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 1, "priority": 2},
                    ],
                },
                {
                    "taskId": "3", "jobType": "HighestLot", "priority": 99, "taskMode": "Concurrent",
                    "pjobs": [{"jobName": "P1", "routeRef": "Route12", "loadPort": "LP3", "waferCount": 1}],
                },
            ],
        }
        update = build_round_update(plan, round_config, 70.0, BuildState())
        self.assertEqual(2, len(update["ControlJobs"]))
        self.assertEqual(3, len(update["ProcessJobs"]))
        self.assertEqual(["2", "3"], [item["TaskID"] for item in update["ControlJobs"]])
        self.assertEqual(["2.C1.P1", "2.C1.P2"], update["ControlJobs"][0]["PJobNameList"])
        self.assertEqual(["3.C2.P1"], update["ControlJobs"][1]["PJobNameList"])
        self.assertEqual(3, update["ControlJobs"][0]["Priority"])
        self.assertEqual(-1, update["ControlJobs"][1]["Priority"])
        self.assertEqual(2, update["ControlJobs"][1]["JobType"])
        self.assertEqual(3, update["ControlJobs"][1]["TaskMode"])
        self.assertEqual([1, 2], update["ProcessJobs"][0]["MatList"])
        self.assertTrue(all("Weight" not in pjob for pjob in update["ProcessJobs"]))

    def test_same_cjob_pjobs_use_continuous_material_ids_and_load_port_slots(self) -> None:
        """同一 CJob 的第二个 PJob 应接续前一个 PJob 的物料编号和 LoadPort 槽位。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        update = build_round_update(plan, {"cjobs": [{"taskId": "1", "pjobs": [
            {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 5},
            {"jobName": "P2", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 5},
        ]}]}, 0.0, BuildState())
        self.assertEqual(list(range(1, 6)), update["ProcessJobs"][0]["MatList"])
        self.assertEqual(list(range(6, 11)), update["ProcessJobs"][1]["MatList"])
        self.assertEqual(list(range(1, 11)), [material["SlotID"] for material in update["Materials"]])

    def test_same_cjob_rejects_different_load_ports(self) -> None:
        """同一 CJob 的全部 PJob 必须属于同一个 LoadPort。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        with self.assertRaisesRegex(ValueError, "必须使用同一个 LoadPort"):
            build_round_update(plan, {"cjobs": [{"taskId": "1", "pjobs": [
                {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 5},
                {"jobName": "P2", "routeRef": "Route12", "loadPort": "LP2", "waferCount": 5},
            ]}]}, 0.0, BuildState())

    def test_round_rejects_duplicate_task_ids_and_control_job_load_ports(self) -> None:
        """绕过页面的输入也不能把重复 TaskID 或共用 LoadPort 送入算法。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        duplicate_task_ids = {"cjobs": [
            {"taskId": "1", "pjobs": [
                {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 1},
            ]},
            {"taskId": "1", "pjobs": [
                {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP2", "waferCount": 1},
            ]},
        ]}
        with self.assertRaisesRegex(ValueError, "TaskID.*重复"):
            build_round_update(plan, duplicate_task_ids, 0.0, BuildState())

        duplicate_load_ports = {"cjobs": [
            {"taskId": "1", "pjobs": [
                {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 1},
            ]},
            {"taskId": "2", "pjobs": [
                {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 1},
            ]},
        ]}
        with self.assertRaisesRegex(ValueError, "不同 ControlJob 不能使用同一个 LoadPort"):
            build_round_update(plan, duplicate_load_ports, 0.0, BuildState())

        serial_multi_cjob = {"cjobs": [
            {"taskId": "1", "taskMode": "Pipeline", "pjobs": [
                {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 1},
            ]},
            {"taskId": "2", "taskMode": "Pipeline", "pjobs": [
                {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP2", "waferCount": 1},
            ]},
        ]}
        with self.assertRaisesRegex(ValueError, "每轮只能配置一个 ControlJob"):
            build_round_update(plan, serial_multi_cjob, 0.0, BuildState())

    def test_task_ids_are_unique_across_rounds(self) -> None:
        """TaskID 的唯一性覆盖整个测试，而不是只覆盖单轮。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        state = BuildState()
        one_job = {"cjobs": [{"taskId": "1", "pjobs": [
            {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 1},
        ]}]}
        build_round_update(plan, one_job, 0.0, state)
        with self.assertRaisesRegex(ValueError, "TaskID.*重复"):
            build_round_update(plan, one_job, 10.0, state)

    def test_fifth_round_reuses_lp1_after_completed_materials_are_unloaded(self) -> None:
        """四端口轮转回 LP1 时，已完成的首轮晶圆应卸载并从 1 号槽重新装片。"""
        route = _route("Route1", "PM1", "Recipe1")
        rotations = [
            (0, "LP1"),
            (100, "LP2"),
            (200, "LP3"),
            (300, "LP4"),
            (400, "LP1"),
        ]
        result = execute_plan({
            "deviceName": "fixture",
            "device": self.device,
            "strategy": "heuristic",
            "options": {},
            "recipes": [{"name": "Recipe1", "time": 8, "modules": "PM1", "weight": {}}],
            "cleans": [],
            "routes": [route],
            "roundCount": len(rotations),
            "rounds": [
                {"currentTime": current_time, "jobs": [_job(f"J{index}", "Route1", load_port)]}
                for index, (current_time, load_port) in enumerate(rotations, start=1)
            ],
        })
        schedules = [
            entry["Info"]
            for entry in result["reproductionLog"]
            if entry["Describe"] == "AlgSchedule"
        ]

        self.assertEqual(5, len(schedules))
        latest_material = max(
            schedules[-1]["Materials"],
            key=lambda material: int(material["ID"]),
        )
        self.assertEqual("LP1", latest_material["CurrentModuleName"])
        self.assertEqual(1, latest_material["SlotID"])
        self.assertTrue(any("清空 LoadPort" in line for line in result["logs"]))

    def test_route_step_and_visit_fields_are_preserved(self) -> None:
        """显式 StepID/PostStepID/NeedProcess 和 IVisit 字段应进入标准 Route。"""
        route = {
            "name": "ExplicitRoute",
            "group": "ExplicitRoute",
            "stages": [
                {"stepId": 10, "postStepIds": [20], "needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
                {"stepId": 20, "postStepIds": [30], "needProcess": False, "visits": [{"stationName": "ATR", "slotIds": "1"}]},
                {"stepId": 30, "postStepIds": [40], "needProcess": True, "visits": [{
                    "stationName": "PM1",
                    "slotIds": "1,2",
                    "processRecipe": "R1",
                    "moveTimeOffset": {"2": 1.5},
                    "qTimeLimit": 12,
                    "residencyConstraint": 34,
                }]},
                {"stepId": 40, "postStepIds": [50], "needProcess": False, "visits": [{"stationName": "ATR", "slotIds": "1"}]},
                {"stepId": 50, "postStepIds": [], "needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
            ],
        }
        built = build_route(route, {"R1": {"name": "R1"}}, {}, {"ATR"})
        process_step = built["RouteSteps"][2]
        process_visit = process_step["Visits"][0]
        self.assertEqual(30, process_step["StepID"])
        self.assertEqual([40], process_step["PostStepID"])
        self.assertTrue(process_step["NeedProcess"])
        self.assertEqual("PM1", process_visit["StationName"])
        self.assertEqual([1, 2], process_visit["SlotID"])
        self.assertEqual("R1", process_visit["ProcessRecipe"])
        self.assertEqual({"2": 1.5}, process_visit["MoveTimeOffset"])
        self.assertEqual(12, process_visit["QTimeLimit"])
        self.assertEqual(34, process_visit["ResidencyConstraint"])

    def test_route_default_slot_expands_for_dual_chamber_and_multi_slot_robot(self) -> None:
        """手动 Route 的默认槽位应按 PM 容量和 Arm 手槽容量一并展开。"""
        route = {
            "name": "TwinRoute",
            "stages": [
                {"stepId": 0, "needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
                {"stepId": 1, "needProcess": False, "visits": [{"stationName": "VACRobot", "slotIds": "1"}]},
                {"stepId": 2, "needProcess": True, "visits": [{"stationName": "PM1", "slotIds": "1", "processRecipe": "TwinRecipe"}]},
                {"stepId": 3, "needProcess": False, "visits": [{"stationName": "VACRobot", "slotIds": "1"}]},
                {"stepId": 4, "needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
            ],
        }
        built = build_route(
            route,
            {"TwinRecipe": {"name": "TwinRecipe"}},
            {},
            {"VACRobot"},
            {"VACRobot": [1, 2, 3, 4], "PM1": [1, 2]},
        )
        self.assertEqual([1, 2, 3, 4], built["RouteSteps"][1]["Visits"][0]["SlotID"])
        self.assertEqual([1, 2], built["RouteSteps"][2]["Visits"][0]["SlotID"])

    def test_route_rejects_buffer_option_outside_interface_range(self) -> None:
        """BufferOption 只接受算法接口定义的 0~4 整数。"""
        for invalid in (-1, 5, 1.5, "bad"):
            route = _route("Route12", "PM1,PM2", "R12")
            route["bufferOption"] = invalid
            with self.subTest(bufferOption=invalid):
                with self.assertRaisesRegex(ValueError, "BufferOption.*0~4"):
                    build_route(
                        route,
                        {"R12": {"name": "R12"}},
                        {},
                        set(self.device["Robots"]),
                    )

    def test_clean_types_expand_to_scheduler_conditions(self) -> None:
        """五类精简 Clean 应展开为正确任务、触发变量和 Dummy 参数。"""
        pre = _runtime_clean({"name": "Pre", "cleanType": "preclean", "recipeTime": 10})
        post = _runtime_clean({"name": "Post", "cleanType": "postclean", "recipeTime": 11})
        wac = _runtime_clean({
            "name": "Wac", "cleanType": "wacclean",
            "recipeTime": 12, "triggerCount": 7,
        })
        dummy = _runtime_clean({"name": "Dummy", "cleanType": "dummy", "recipeTime": 13})
        dummy_wac = _runtime_clean({
            "name": "DummyWac", "cleanType": "dummywac",
            "recipeTime": 14, "wacRecipeTime": 6, "modules": ["PM1"],
        })

        self.assertEqual("PreClean", pre["taskName"])
        self.assertEqual("PostClean", post["taskName"])
        self.assertEqual(("ProcessCount", 7), (wac["stateVariable"], wac["lower"]))
        self.assertEqual(("WacClean", ["ProcessCount"]), (wac["taskName"], wac["updateStateVariables"]))
        self.assertEqual(("PreDummyClean", 2), (dummy["taskName"], dummy["materialCount"]))
        self.assertEqual(("PreWacClean", 2), (dummy_wac["taskName"], dummy_wac["materialCount"]))
        self.assertEqual("DummyWac-Recipe-WAC", dummy_wac["emptyRecipeRef"])
        self.assertEqual(6, dummy_wac["wacRecipeTime"])
        self.assertEqual(["PM1"], dummy_wac["modules"])

    def test_wac_clean_adds_standard_process_count_recipe_weight(self) -> None:
        """WAC 条件引用 ProcessCount 时，产品 Recipe 必须按公司标准递增该变量。"""
        route = _route("WacRoute", "PM1", "ProductRecipe")
        route["stages"][4]["afterCleanRefs"] = ["Wac"]
        plan = {
            "device": self.device,
            "recipes": [{
                "name": "ProductRecipe",
                "time": 40,
                "modules": ["PM1"],
                "weight": {},
            }],
            "cleans": [{
                "name": "Wac",
                "cleanType": "wacclean",
                "recipeTime": 30,
                "triggerCount": 2,
                "modules": ["PM1"],
            }],
            "routes": [route],
        }
        update = build_round_update(
            plan,
            {"currentTime": 0, "jobs": [_job("J1", "WacRoute", "LP1")]},
            0.0,
            BuildState(),
        )

        product_recipe = next(
            recipe
            for recipe in update["ProcessRecipes"]
            if recipe["Name"] == "ProductRecipe" and recipe["ModuleName"] == "PM1"
        )
        self.assertEqual({"ProcessCount": 1}, product_recipe["Weight"])

    def test_standard_clean_weight_preserves_explicit_recipe_value(self) -> None:
        """自动补齐标准计数器时不得覆盖用户显式配置的 Recipe 权重。"""
        route = _route("WacRoute", "PM1", "ProductRecipe")
        route["stages"][4]["afterCleanRefs"] = ["Wac"]
        plan = {
            "device": self.device,
            "recipes": [{
                "name": "ProductRecipe",
                "time": 40,
                "modules": ["PM1"],
                "weight": {"ProcessCount": 2, "CustomCount": 3},
            }],
            "cleans": [{"name": "Wac", "cleanType": "wacclean", "recipeTime": 30}],
            "routes": [route],
        }
        update = build_round_update(
            plan,
            {"currentTime": 0, "jobs": [_job("J1", "WacRoute", "LP1")]},
            0.0,
            BuildState(),
        )

        product_recipe = next(
            recipe for recipe in update["ProcessRecipes"]
            if recipe["Name"] == "ProductRecipe" and recipe["ModuleName"] == "PM1"
        )
        self.assertEqual(
            {"ProcessCount": 2, "CustomCount": 3},
            product_recipe["Weight"],
        )

    def test_step_clean_references_only_bind_to_explicit_modules(self) -> None:
        """Step 同时包含 Heater 和 PM 时，Clean 只应挂到显式选择的 PM。"""
        route = _route("CleanRoute", "heater,PM1", "Recipe1")
        route["stages"][4]["beforeCleanRefs"] = ["DummyWac"]
        route["stages"][4]["afterCleanRefs"] = ["Post", "Wac"]
        clean_rows = [
            _runtime_clean({
                "name": "DummyWac", "cleanType": "dummywac",
                "recipeTime": 30, "modules": ["PM1"],
            }),
            _runtime_clean({
                "name": "Post", "cleanType": "postclean",
                "recipeTime": 20, "modules": ["PM1"],
            }),
            _runtime_clean({
                "name": "Wac", "cleanType": "wacclean",
                "recipeTime": 8, "triggerCount": 5, "modules": ["PM1"],
            }),
        ]
        clean_by_name = {clean["name"]: clean for clean in clean_rows}

        built = build_route(
            route,
            {"Recipe1": {"name": "Recipe1"}},
            clean_by_name,
            {"ATR", "VTR"},
        )

        dummy_task = built["PrePJob"]["PM1"][0]["CheckConditions"]["DummyWac"][0]
        post_task = built["PostPJob"]["PM1"][0]["CheckConditions"]["Post"][0]
        process_visits = built["RouteSteps"][4]["Visits"]
        heater_visit = next(visit for visit in process_visits if visit["StationName"] == "heater")
        process_visit = next(visit for visit in process_visits if visit["StationName"] == "PM1")
        wac_condition = process_visit["AfterOutPM"][0]
        self.assertNotIn("heater", built["PrePJob"])
        self.assertNotIn("heater", built["PostPJob"])
        self.assertEqual([], heater_visit["AfterOutPM"])
        self.assertEqual((2, "DummyWac-Recipe-WAC"), (
            dummy_task["MaterialCount"],
            dummy_task["EmptyCleanRecipeAfterMaterial"],
        ))
        self.assertEqual("PostClean", post_task["TaskName"])
        self.assertEqual(
            [5.0, 9999.0],
            wac_condition["ExecuteOrder"][0]["ThresholdValueList"],
        )
        self.assertEqual([], process_visit["BeforeInPM"])

    def test_route_clean_references_only_bind_to_explicit_modules(self) -> None:
        """Route 级 Clean 不得自动扩散到同路径中未勾选的 Heater。"""
        route = _route("CleanRoute", "heater,PM1", "Recipe1")
        route["prePJobCleanRefs"] = ["Pre"]
        clean = _runtime_clean({
            "name": "Pre",
            "cleanType": "preclean",
            "recipeTime": 20,
            "modules": ["PM1"],
        })

        built = build_route(
            route,
            {
                "Recipe1": {"name": "Recipe1"},
                "Pre-Recipe": {"name": "Pre-Recipe", "modules": ["PM1"]},
            },
            {"Pre": clean},
            {"ATR", "VTR"},
        )

        self.assertEqual(["PM1"], list(built["PrePJob"]))
        self.assertNotIn("heater", built["PrePJob"])

    def test_dummy_wac_batch_plan_derives_recipes_and_dummy_port_material(self) -> None:
        """Dummy WAC 应从 Route PM 自动生成两段 Recipe，并准备可复用 DummyPort 晶圆。"""
        route = _route("DummyRoute", "PM1", "Recipe1")
        route["stages"][4]["recipeTime"] = 10
        route["stages"][4]["beforeCleanRefs"] = ["DummyWac"]
        device = {
            "name": "device.json",
            "device": self.device,
            "routes": [route],
            "cleans": [{
                "name": "DummyWac",
                "cleanType": "dummywac",
                "recipeTime": 30,
                "wacRecipeTime": 8,
                "modules": ["PM1"],
            }],
        }
        test_case = {
            "rounds": [{
                "currentTime": 0,
                "jobs": [_job("J1", "DummyRoute", "LP1")],
            }],
        }

        plan = config_server.build_workspace_batch_plan(
            device,
            test_case,
            "heuristic",
            {},
        )
        clean_recipes = {
            recipe["name"]: recipe
            for recipe in plan["recipes"]
            if recipe["name"].startswith("DummyWac")
        }
        self.assertEqual({"DummyWac-Recipe", "DummyWac-Recipe-WAC"}, set(clean_recipes))
        self.assertEqual(["PM1"], clean_recipes["DummyWac-Recipe"]["modules"])
        self.assertEqual(8, clean_recipes["DummyWac-Recipe-WAC"]["time"])

        update = build_round_update(
            plan,
            test_case["rounds"][0],
            0.0,
            BuildState(),
        )
        dummy_materials = [
            material
            for material in update["Materials"]
            if material["CurrentModuleName"] == "DummyPort"
        ]
        self.assertEqual(5, len(dummy_materials))
        self.assertEqual([1, 2, 3, 4, 5], [row["SlotID"] for row in dummy_materials])
        self.assertEqual(
            [100000, 100001, 100002, 100003, 100004],
            [row["ID"] for row in dummy_materials],
        )
        expected_template = {
            "Name": "1",
            "AccessiblePM": ["PM1"],
            "TaskID": "",
            "FoupID": "",
            "ID": 100000,
            "LimitLevel1": 10000,
            "LimitLevel2": 10000,
            "Priority": -1,
            "StepID": 0,
            "LotID": "",
            "SlotID": 1,
            "NeedSchedule": True,
            "CurrentModuleName": "DummyPort",
            "PJobName": "",
            "SrcPortName": "DummyPort",
            "Usage": 2,
            "Count": 0,
            "Route": {
                "Name": "", "RouteSteps": [], "BufferOption": -1,
                "BoundedStepIDs": [], "Group": "", "PrePJob": {},
                "PostPJob": {}, "PostCJob": {},
            },
        }
        self.assertEqual(expected_template, dummy_materials[0])
        problem = parse_task(self.device, update)
        dummy_wafers = [
            wafer for wafer in problem.wafers
            if wafer.pjob_name.startswith("dummy_")
        ]
        self.assertEqual(2, len(dummy_wafers))
        self.assertEqual(8, problem.dummy_wac[0].time)
        result = execute_plan(plan)
        self.assertTrue(result["ok"])
        self.assertGreater(result["makespan"], 0)

    def test_dummy_clean_adds_fixed_material_template_and_per_pm_route_conditions(self) -> None:
        """Dummy Clean 应固定准备五片库存，并按绑定腔室写入物料权限与 Route 条件。"""
        route = _route("DummyRoute", "PM1,PM2", "Recipe1")
        route["prePJobCleanRefs"] = ["DummyClean"]
        plan = {
            "device": self.device,
            "recipes": [{
                "name": "Recipe1", "time": 10,
                "modules": ["PM1", "PM2"], "weight": {},
            }],
            "cleans": [{
                "name": "DummyClean",
                "cleanType": "dummy",
                "recipeTime": 6,
                "modules": ["PM1", "PM2"],
            }],
            "routes": [route],
        }

        update = build_round_update(
            plan,
            {"currentTime": 0, "jobs": [_job("J1", "DummyRoute", "LP1")]},
            0.0,
            BuildState(),
        )

        dummy_materials = [
            material
            for material in update["Materials"]
            if material["CurrentModuleName"] == "DummyPort"
        ]
        self.assertEqual(5, len(dummy_materials))
        self.assertTrue(all(
            material["AccessiblePM"] == ["PM1", "PM2"]
            for material in dummy_materials
        ))
        origin_route = update["ProcessJobs"][0]["OriginRoute"]
        self.assertEqual(["PM1", "PM2"], list(origin_route["PrePJob"]))
        for module in ("PM1", "PM2"):
            condition = origin_route["PrePJob"][module][0]
            task = next(iter(condition["CheckConditions"].values()))[0]
            self.assertEqual("PreDummyClean", task["TaskName"])
            self.assertEqual("DummyClean-Recipe", task["CleanRecipe"])
            self.assertEqual(["IdleTime", "DummyCount"], task["UpdateStateVariables"])
            self.assertEqual(2, task["MaterialCount"])
            self.assertEqual("", task["EmptyCleanRecipeAfterMaterial"])

    def test_editor_uses_persistent_route_table_and_step_drawer(self) -> None:
        """路径按工艺结构折叠，Route 和 Step 都提供 Clean 弹窗入口。"""
        html = _editor_source()
        drawer_editor = html.split("function renderStepDrawer()", 1)[1]
        drawer_editor = drawer_editor.split("/** 打开指定 Step", 1)[0]
        self.assertIn('data-tab-target="schedule"', html)
        self.assertIn('data-tab-target="route"', html)
        self.assertNotIn('data-tab-target="clean"', html)
        self.assertIn("<span>结果分析</span>", html)
        self.assertIn("<span>路径配置</span>", html)
        self.assertNotIn('data-tab-view="clean"', html)
        self.assertIn('class="frontend-version">前端 v1.1.0</span>', html)
        self.assertIn('data-option="residencyGuardSeconds"', html)
        self.assertIn('data-option="maximumRobotHoldingSeconds"', html)
        self.assertIn('data-option="maximumSystemResidenceCv"', html)
        self.assertIn("校验 / 多指标", html)
        self.assertIn('<span id="metricMovesLabel">瓶颈利用率</span>', html)
        self.assertNotIn('<span id="metricMovesLabel">Move 数</span>', html)
        self.assertNotIn("renderDatasetCatalog", html)
        self.assertNotIn("按加工工序数量分组，名称由候选腔室、加工时间和清洁配置自动生成。", html)
        self.assertNotIn("generate-example-routes", html)
        self.assertIn('id="stepDrawer"', html)
        self.assertIn('class="route-table"', html)
        self.assertIn('data-scope="stage-candidate-toggle"', html)
        self.assertIn('class="step-overview-card"', html)
        self.assertIn('class="step-edit-grid"', html)
        self.assertIn('class="step-clean-section"', html)
        self.assertIn('class="step-system-details"', html)
        self.assertIn('data-action="open-context-clean"', html)
        self.assertIn('data-clean-scope="step"', html)
        for label, field in (
            ("Process Time", "processTime"),
            ("QTime", "qTimeLimit"),
            ("Residency", "residencyConstraint"),
        ):
            self.assertIn(f'renderStepNumberField("{label}", "{field}"', drawer_editor)
        self.assertNotIn('data-key="recipeTime"', drawer_editor)
        self.assertNotIn('data-key="beforeCleanRefs"', drawer_editor)
        for field in ("Recipe Time", "Process Recipe", "Process Type", "Slot IDs", "Weight", "Move Time Offset"):
            self.assertIn(field, drawer_editor)
        self.assertIn('if (key === "processTime") stage.visits[0].recipeTime = Number(value);', html)
        self.assertIn("width: min(760px, 100vw)", html)

    def test_clean_editor_is_embedded_in_route_and_uses_parameter_dialog(self) -> None:
        """独立 Clean 页面应删除，Route/Step 通过弹窗配置参数和适用腔室。"""
        html = _editor_source()
        template = EDITOR_PATH.read_text(encoding="utf-8")

        self.assertNotIn('data-tab-target="clean"', template)
        self.assertNotIn('id="cleanList"', template)
        self.assertIn('id="cleanDialog"', template)
        for label in ("PreClean", "PostClean", "WAC Clean", "Dummy", "Dummy WAC"):
            self.assertIn(label, html)
        self.assertIn("function automaticCleanName(clean)", html)
        self.assertIn("主清洁", html)
        self.assertIn("renameCleanReferences", html)
        for label in ("执行位置", "清洁类别", "清洁时间（秒）", "触发次数", "WAC 清洁长度（秒）", "适用腔室"):
            self.assertIn(label, template)
        self.assertIn('data-clean-scope="route"', html)
        self.assertIn('data-clean-scope="step"', html)
        self.assertIn("function openCleanDialog(", html)
        self.assertIn("function saveCleanDialog()", html)
        self.assertIn("Clean 只会出现在这里勾选的腔室", template)
        self.assertIn("modules: value.modules", html)
        self.assertIn("scheduleAutoSave", html)
        self.assertIn('window.addEventListener("pagehide"', html)
        self.assertIn("StepID", html)
        self.assertIn("PostStepID", html)
        self.assertIn("NeedProcess", html)
        self.assertIn('data-scope="visit-shared"', html)
        self.assertIn('src="/assets/config_editor.js?v=', html)
        self.assertIn('id="routeProcessFilter"', template)
        self.assertIn('id="routeParallelFilter"', template)
        self.assertIn('data-compact-label="工序数"', template)
        self.assertIn('data-compact-label="并行机器数"', template)
        self.assertIn('class="route-flat-list"', html)
        self.assertIn("function renderRoutePropertyTags(route)", html)
        self.assertIn("No Buffer", html)
        self.assertIn("buffer-forced", html)
        self.assertIn("buffer-optional", html)
        self.assertIn('class="field route-group-field"', html)
        self.assertIn('class="field route-buffer-field"', html)
        self.assertIn('data-key="bufferOption"', html)
        self.assertIn('data-compact-label="BufferOption"', html)
        self.assertNotIn('class="route-summary-secondary"', html)
        self.assertIn('data-action="toggle-route"', html)
        self.assertIn('data-action="copy-route"', html)
        self.assertIn("候选腔室的可编辑参数不一致", html)
        self.assertIn("sync-stage-visits", html)
        self.assertIn("state.stationNames", html)
        self.assertIn('id="autoExportLog"', html)
        self.assertIn('id="logButton"', html)
        self.assertIn("algorithm-hover-info", html)
        self.assertIn("metadata.introduction", html)
        self.assertNotIn('data-tab-target="algorithm-history"', html)
        self.assertNotIn("renderAlgorithmHistory", html)
        self.assertNotIn("/api/algorithm-metadata/", html)
        self.assertNotIn("other_alg · init/update", html)
        self.assertNotIn('id="neuralStrategyHint"', html)
        self.assertNotIn('id="rlStrategyHint"', html)
        self.assertIn('id="otherAlgorithmOptions"', html)
        self.assertIn("status.algorithms", html)
        self.assertIn('id="deviceSelect"', html)
        self.assertIn('id="testCaseSelect"', html)
        self.assertIn('id="copyTestButton"', html)
        self.assertIn('id="saveTestButton"', html)
        self.assertIn("saveCurrentTest(true)", html)
        self.assertIn('data-action="add-cjob"', html)
        self.assertIn('data-action="add-pjob"', html)
        self.assertIn('data-scope="cjob"', html)
        self.assertIn('data-scope="pjob"', html)
        self.assertIn("PJobNameList", html)
        page_template = EDITOR_PATH.read_text(encoding="utf-8")
        for removed_text in (
            "设备保存共享工艺库，测试集只保存排程任务。",
            "重算轮次 → CJob → PJob",
            "集中查看总体进度、批量状态、结果入口与运行日志。",
            "可使用内置策略，也可以自动读取 other_alg 下采用 init/update 标准接口的算法包。",
            "单独运行当前测试，或用所选策略并行运行当前测试组。",
        ):
            self.assertNotIn(removed_text, page_template)
        self.assertNotIn('data-scope="pjob-route-group"', html)
        self.assertIn('data-action="open-pjob-route-picker"', html)
        self.assertIn('data-action="select-pjob-route"', html)
        self.assertIn('class="pjob-route-open"', html)
        self.assertNotIn('class="pjob-route-specific"', html)
        self.assertIn('id="pjobRouteDialog"', page_template)
        self.assertIn('id="pjobRouteProcess"', page_template)
        self.assertNotIn('id="pjobRouteSearch"', page_template)
        self.assertIn("function routePickerCompactPath", html)
        self.assertIn("function routePickerProcessSummary", html)
        self.assertIn("function renderPJobRouteDialogGroup", html)
        self.assertIn("function routePickerSpecialCleanSummary", html)
        self.assertIn("function routePickerCleanSummary", html)
        self.assertIn("Buffer Option", html)
        self.assertIn('class="pjob-route-card-meta"', html)
        self.assertIn('class="route-summary-primary"', html)
        self.assertIn('class="route-summary-secondary"', html)
        picker_style = EDITOR_STYLE_PATH.read_text(encoding="utf-8")
        self.assertIn('.pjob-route-card-path { min-width: 0; color: #273750; font-family: inherit;', picker_style)
        self.assertIn('.route-summary-primary strong { min-width: 0; color: #273750; font-family: inherit;', picker_style)
        self.assertNotIn('grid-template-columns: repeat(2, minmax(0, 1fr))', picker_style)
        self.assertIn("<th>Material</th>", html)
        self.assertNotIn("晶圆数量 / LoadPort 槽位", html)
        self.assertNotIn("<th>TaskID</th>", html)
        self.assertNotIn("<th>FoupID</th>", html)
        self.assertNotIn("<th>Weight</th>", html)
        self.assertIn("$ 运行失败：${error.message", html)
        self.assertIn("EXPECTED_API_SCHEMA", html)
        self.assertIn("失败也会生成", html)
        self.assertIn('id="testGroupSelect"', html)
        self.assertIn('id="newGroupButton"', html)
        self.assertIn('id="batchRunButton"', html)
        self.assertIn('id="openParameterComparisonDialogButton"', html)
        self.assertIn("运行对比测试", html)
        self.assertIn('id="parameterComparisonDialog"', html)
        self.assertIn('id="parameterComparisonPanel"', html)
        self.assertIn('id="runParameterComparisonButton"', html)
        self.assertIn("runParameterComparison", html)
        self.assertIn('id="batchResults"', html)
        self.assertIn('id="batchProgress"', html)
        self.assertIn('id="batchGanttButton"', html)
        self.assertIn('id="batchLogButton"', html)
        self.assertIn("function updateBatchLogDownload", html)
        self.assertIn("/api/run-batches/${encodeURIComponent(result.batchId)}/logs", html)
        self.assertIn("/api/run-batch", html)
        self.assertIn("/api/run-batches/", html)
        self.assertIn('method: "DELETE"', html)
        self.assertIn("■ 终止调度", html)
        self.assertIn('cancelled: "已终止"', html)
        viewer = (ROOT / "realtime_scheduler" / "frontend" / "movelist_gantt_viewer.html").read_text(encoding="utf-8")
        self.assertIn('getAll("src")', viewer)
        self.assertIn("Promise.allSettled", viewer)
        self.assertNotIn('id="recipeList"', html)

    def test_gantt_cleaning_process_uses_sky_blue(self) -> None:
        """甘特图应把无片或带清洁元数据的 ProcessMove 显示为天蓝色。"""
        viewer = (
            ROOT / "realtime_scheduler" / "frontend" / "movelist_gantt_viewer.html"
        ).read_text(encoding="utf-8")

        self.assertIn('const CLEAN_PROCESS_COLOR = "#38BDF8";', viewer)
        self.assertIn("function isCleaningProcess(raw)", viewer)
        self.assertIn("explicitlyEmpty || cleanMetadata", viewer)
        self.assertIn("if (isCleaningProcess(bar.rec.raw))", viewer)

    def test_gantt_keeps_and_renders_zero_duration_moves(self) -> None:
        """甘特图应保留零时长动作，并将其绘制为边界内可点击的最小宽度标记。"""
        viewer = (
            ROOT / "realtime_scheduler" / "frontend" / "movelist_gantt_viewer.html"
        ).read_text(encoding="utf-8")

        self.assertIn("rec.end >= rec.start", viewer)
        self.assertNotIn(
            "let records = dataset.records.filter((rec) => Number.isFinite(rec.start) "
            "&& Number.isFinite(rec.end) && rec.end > rec.start + 1e-9);",
            viewer,
        )
        self.assertIn("const ZERO_DURATION_MARKER_WIDTH = 3;", viewer)
        self.assertIn(
            "Math.abs(bar.end - bar.start) <= ZERO_DURATION_EPSILON_SECONDS",
            viewer,
        )
        self.assertIn("markerCenter - w / 2", viewer)

    def test_result_preview_and_group_analysis_use_main_area(self) -> None:
        """结果预览应保持简洁，并提供独立的测试组分析入口。"""
        html = _editor_source()
        schedule = html.split('<div class="tab-view active" data-tab-view="schedule">', 1)[1]
        schedule = schedule.split('<div class="tab-view" data-tab-view="route">', 1)[0]
        sidebar = html.split('<aside class="side" id="scheduleSide">', 1)[1]
        sidebar = sidebar.split("</aside>", 1)[0]

        self.assertLess(schedule.index("重算任务"), schedule.index("结果预览"))
        self.assertIn('class="panel result-panel"', schedule)
        self.assertIn("运行策略", sidebar)
        self.assertNotIn("结果预览", sidebar)
        self.assertIn("container-name: result-area", html)
        self.assertIn(".batch-results { display: grid; grid-template-columns: repeat(4", html)
        self.assertIn("@container result-area (max-width: 1100px)", html)
        self.assertIn("@container result-area (max-width: 720px)", html)
        self.assertIn("@container result-area (max-width: 520px)", html)
        self.assertNotIn('class="terminal-section"', html)
        self.assertNotIn('id="clearButton"', html)
        self.assertIn('id="resultErrorPanel" role="alert" hidden', html)
        self.assertIn("只有错误才显示", html)
        self.assertIn('class="batch-result-summary"', html)
        self.assertIn('class="batch-metric-tags"', html)
        self.assertIn("batch-metric-tag cpu", html)
        self.assertNotIn('class="batch-result-metrics"', html)
        self.assertIn('const displayId = `t${index + 1}`', html)
        self.assertIn("CPU Time ${finished", html)
        self.assertIn('id="batchOverviewButton"', html)
        self.assertIn('id="testGroupAnalysisButton"', html)
        self.assertIn('id="testGroupAnalysisPanel"', html)
        self.assertIn("renderTestGroupAnalysis", html)
        self.assertIn("analyzeTestGroupPerformance", html)
        self.assertIn('data-batch-item-index="${index}"', html)
        self.assertIn("loadBatchItemBottleneck", html)
        self.assertIn("正在计算稳态瓶颈", html)
        self.assertNotIn("机器手持片驻留", html)
        self.assertNotIn('id="batchProgressText"', html)
        self.assertIn('id="batchProgressCount">0%</span>', html)
        self.assertIn('role="progressbar"', html)
        self.assertIn("overflow-wrap: anywhere", html)
        self.assertIn("item.testId", html)
        for label in ("测试名称", "等待中", "运行中", "成功", "失败", "Makespan", "Move", "耗时"):
            self.assertIn(label, html)

    def test_result_analysis_and_topology_playback_use_separate_views(self) -> None:
        """结果分析与拓扑回放应使用独立主界面，并共享同一份 MoveList。"""
        page = EDITOR_PATH.read_text(encoding="utf-8")
        workspace_source = (
            ROOT
            / "realtime_scheduler"
            / "frontend"
            / "src"
            / "workspace_visualizer.ts"
        ).read_text(encoding="utf-8")
        group_view_source = (
            ROOT
            / "realtime_scheduler"
            / "frontend"
            / "src"
            / "group_analysis_view.ts"
        ).read_text(encoding="utf-8")
        editor_source = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn('data-tab-target="playback"', page)
        self.assertIn('data-tab-view="playback"', page)
        self.assertIn('id="visualPlaybackEmpty"', page)
        self.assertNotIn('id="visualTopologyToggle"', page)
        self.assertIn('id="visualTopologyPlayback" hidden', page)
        analysis_view = page.split('data-tab-view="workspace"', 1)[1].split('data-tab-view="playback"', 1)[0]
        self.assertNotIn('id="visualTopologyPlayback"', analysis_view)
        topology_playback = page.split('id="visualTopologyPlayback"', 1)[1]
        self.assertIn('id="visualTimeline"', topology_playback)
        self.assertIn('id="visualDeviceStage"', topology_playback)
        self.assertIn('id="visualDecisionLens"', topology_playback)
        self.assertIn('id="visualPauseOnDecisionChangeButton"', topology_playback)
        self.assertIn("合法动作空间", topology_playback)
        self.assertNotIn('id="visualTransitionButtons"', topology_playback)
        self.assertIn("decisionBoundaryTimes", workspace_source)
        self.assertNotIn("未来单轨迹", workspace_source)
        self.assertNotIn("调度结果分析", page)
        self.assertNotIn("按设备俯视拓扑回放晶圆流转", page)

        self.assertIn("showGroupAnalysis(markup: string)", workspace_source)
        self.assertIn("this.elements.content.hidden = true", workspace_source)
        self.assertIn("this.elements.groupAnalysis.hidden = false", workspace_source)
        self.assertIn("private showSingleResult()", workspace_source)
        self.assertIn("this.elements.groupAnalysis.hidden = true", workspace_source)
        self.assertIn("visualizationWorkspace.showGroupAnalysis(panelMarkup)", editor_source)

        for removed_content in (
            "逐例对比 · 不做综合打分",
            "瓶颈候选出现频次",
            "如何解读",
            '<span class="eyebrow">测试组结果分析</span>',
        ):
            self.assertNotIn(removed_content, group_view_source)

    def test_schedule_analysis_is_reusable_without_frontend_dependencies(self) -> None:
        """MoveList 与测试组统计应由无 DOM 的后端层统一计算，页面只请求 API。"""
        analysis_root = ROOT / "realtime_scheduler" / "analysis"
        movelist_source = (analysis_root / "movelist_performance.ts").read_text(
            encoding="utf-8",
        )
        group_source = (analysis_root / "group_performance.ts").read_text(
            encoding="utf-8",
        )
        context_source = (analysis_root / "schedule_context.ts").read_text(
            encoding="utf-8",
        )
        workspace_source = (
            ROOT
            / "realtime_scheduler"
            / "frontend"
            / "src"
            / "workspace_visualizer.ts"
        ).read_text(encoding="utf-8")
        api_source = (
            ROOT
            / "realtime_scheduler"
            / "frontend"
            / "src"
            / "api_client.ts"
        ).read_text(encoding="utf-8")

        self.assertIn("requestScheduleAnalysis", workspace_source)
        self.assertIn("/api/analysis/schedule", api_source)
        self.assertIn("/api/analysis/test-group", api_source)
        self.assertNotIn("../../analysis/", workspace_source)
        self.assertIn("analyzeSchedulePerformance", movelist_source)
        self.assertIn("analyzeTestGroupPerformance", group_source)
        self.assertIn("buildScheduleAnalysisContext", context_source)
        for browser_dependency in ("document.", "globalThis.window", "fetch("):
            self.assertNotIn(browser_dependency, movelist_source)
            self.assertNotIn(browser_dependency, group_source)
            self.assertNotIn(browser_dependency, context_source)

    def test_device_workspace_persists_independent_test_cases(self) -> None:
        """同一设备的多套 Route/Clean/重算配置应独立保存并可复制、修改、删除。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, created = import_workspace_device("device-a.json", self.recording, store_path)
            duplicate, duplicate_created = import_workspace_device("renamed.json", self.device, store_path)
            self.assertTrue(created)
            self.assertFalse(duplicate_created)
            self.assertEqual(device["id"], duplicate["id"])
            self.assertEqual("renamed.json", duplicate["name"])

            base = {
                "name": "基础案例",
                "strategy": "heuristic",
                "roundCount": 1,
                "times": [0],
                "options": {"loadLockExchange": "disabled"},
                "cleans": [{"name": "CleanA"}],
                "routes": [{"name": "RouteA"}],
                "rounds": [{"jobs": [{"name": "Initial"}]}],
            }
            first = create_workspace_test(device["id"], base, store_path)
            self.assertNotIn("loadLockExchange", first["options"])
            second = create_workspace_test(device["id"], {**base, "name": "复制案例"}, store_path)
            updated_second = update_workspace_test(device["id"], second["id"], {
                **base,
                "name": "复制案例-PM34",
                "routes": [{"name": "RoutePM34"}],
                "roundCount": 2,
                "times": [0, 100],
                "rounds": [{"jobs": []}, {"jobs": [{"name": "Added"}]}],
            }, store_path)

            loaded = get_workspace_device(device["id"], store_path)
            self.assertEqual(2, len(loaded["tests"]))
            self.assertEqual([{"name": "RoutePM34"}], loaded["routes"])
            self.assertEqual([{"name": "CleanA"}], loaded["cleans"])
            self.assertTrue(all("routes" not in item and "cleans" not in item for item in loaded["tests"]))
            self.assertNotIn("routes", updated_second)
            self.assertEqual(2, updated_second["roundCount"])
            migrated = updated_second["rounds"][1]["cjobs"][0]
            self.assertEqual("2", migrated["taskId"])
            self.assertEqual(["P1"], migrated["pJobNameList"])
            self.assertNotIn("foupId", migrated["pjobs"][0])
            self.assertNotIn("weight", migrated["pjobs"][0])
            self.assertEqual(2, list_workspace_devices(store_path)[0]["testCount"])

            delete_workspace_test(device["id"], first["id"], store_path)
            remaining = get_workspace_device(device["id"], store_path)["tests"]
            self.assertEqual([second["id"]], [item["id"] for item in remaining])
            with self.assertRaises(ValueError):
                delete_workspace_test(device["id"], second["id"], store_path)

    def test_device_workspace_delete_removes_device_and_its_tests(self) -> None:
        """删除设备应从目录中移除设备及其全部测试集，删除后无法再读取。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            first, _ = import_workspace_device("device-a.json", self.recording, store_path)
            # 构造一台拓扑有差异的第二台设备，验证删除只影响目标设备。
            second_device = copy.deepcopy(self.device)
            second_device["Stations"]["PM1"]["Name"] = "PM1x"
            second, _ = import_workspace_device("device-b.json", second_device, store_path)
            self.assertNotEqual(first["id"], second["id"])
            self.assertEqual(2, len(list_workspace_devices(store_path)))

            deleted = delete_workspace_device(first["id"], store_path)
            self.assertEqual(first["id"], deleted["id"])
            self.assertEqual("device-a.json", deleted["name"])
            self.assertEqual(0, deleted["testCount"])
            self.assertEqual([second["id"]], [item["id"] for item in list_workspace_devices(store_path)])
            with self.assertRaises(ValueError):
                get_workspace_device(first["id"], store_path)

            delete_workspace_device(second["id"], store_path)
            self.assertEqual([], list_workspace_devices(store_path))
            with self.assertRaises(ValueError):
                delete_workspace_device(first["id"], store_path)

    def test_directory_store_splits_tests_into_shareable_files(self) -> None:
        """拆分目录下每个测试集是独立文件，放入分享文件后无需重启即可读取。"""
        with tempfile.TemporaryDirectory() as directory:
            store_dir = Path(directory) / "workspaces"
            device, _ = import_workspace_device("device-a.json", self.recording, store_dir)
            test = create_workspace_test(device["id"], {
                "name": "基础案例", "strategy": "heuristic", "roundCount": 1,
                "times": [0], "rounds": [{"jobs": [{"name": "Initial"}]}],
            }, store_dir)
            device_dir = store_dir / device["id"]
            self.assertTrue((device_dir / "device.json").is_file())
            test_file = device_dir / "tests" / f"{test['id']}.json"
            self.assertTrue(test_file.is_file())
            self.assertNotIn("tests", json.loads((device_dir / "device.json").read_text(encoding="utf-8")))

            # 把同事分享的测试集文件放入 tests 目录，读取时直接生效。
            shared = copy.deepcopy(test)
            shared["id"] = "shared-test-0001"
            shared["name"] = "同事分享的测试"
            shared["group"] = "冒烟"
            (device_dir / "tests" / "shared-test-0001.json").write_text(
                json.dumps(shared, ensure_ascii=False), encoding="utf-8",
            )
            loaded = get_workspace_device(device["id"], store_dir)
            self.assertEqual(
                {"基础案例", "同事分享的测试"},
                {item["name"] for item in loaded["tests"]},
            )

            # 删除测试集与设备后，对应文件与目录一并清理。
            delete_workspace_test(device["id"], test["id"], store_dir)
            self.assertFalse(test_file.exists())
            delete_workspace_device(device["id"], store_dir)
            self.assertFalse(device_dir.exists())
            self.assertEqual([], list_workspace_devices(store_dir))

    def test_directory_store_migrates_legacy_single_file(self) -> None:
        """旧单文件存储首次以目录模式读取时自动迁移为拆分目录，旧文件保留备份。"""
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            fake_data = tmp / "data"
            fake_data.mkdir()
            legacy_file = fake_data / "workspaces.json"
            device, _ = import_workspace_device("device-a.json", self.recording, legacy_file)
            create_workspace_test(device["id"], {
                "name": "迁移案例", "roundCount": 1, "rounds": [{}],
            }, legacy_file)

            store_dir = tmp / "workspaces"
            with (
                patch.object(config_server, "DATA_DIR", fake_data),
                patch.object(config_server, "WORKSPACE_STORE_PATH", store_dir),
            ):
                catalog = config_server._read_workspace_catalog_unlocked(store_dir)
            self.assertEqual([device["id"]], [item["id"] for item in catalog["devices"]])
            self.assertTrue((store_dir / device["id"] / "tests").is_dir())
            self.assertTrue((fake_data / "workspaces.json.legacy.json").is_file())
            self.assertFalse(legacy_file.exists())
            # 迁移后的目录重启读取仍然正常。
            loaded = get_workspace_device(device["id"], store_dir)
            self.assertEqual("迁移案例", loaded["tests"][0]["name"])

    def test_directory_store_retries_interrupted_migration(self) -> None:
        """迁移中断（目录残留且旧单文件未改名）后再次读取应重新迁移补齐数据。"""
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            fake_data = tmp / "data"
            fake_data.mkdir()
            legacy_file = fake_data / "workspaces.json"
            device, _ = import_workspace_device("device-a.json", self.recording, legacy_file)
            create_workspace_test(device["id"], {
                "name": "迁移案例", "roundCount": 1, "rounds": [{}],
            }, legacy_file)

            store_dir = tmp / "workspaces"
            # 模拟上次迁移只写了一部分就中断：目录残留 + 旧文件未改名。
            store_dir.mkdir()
            (store_dir / "stale-device-dir").mkdir()
            with (
                patch.object(config_server, "DATA_DIR", fake_data),
                patch.object(config_server, "WORKSPACE_STORE_PATH", store_dir),
            ):
                catalog = config_server._read_workspace_catalog_unlocked(store_dir)
            # 残留目录被幂等重建，数据完整且旧文件保留备份。
            self.assertEqual([device["id"]], [item["id"] for item in catalog["devices"]])
            self.assertFalse((store_dir / "stale-device-dir").exists())
            self.assertTrue((fake_data / "workspaces.json.legacy.json").is_file())
            loaded = get_workspace_device(device["id"], store_dir)
            self.assertEqual("迁移案例", loaded["tests"][0]["name"])

    def test_different_groups_allow_same_test_name(self) -> None:
        """测试名称只需在组内唯一，不同组可以使用完全相同的名称。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            first = create_workspace_test(device["id"], {
                "name": "r1", "group": "R1", "roundCount": 1, "rounds": [{}],
            }, store_path)
            second = create_workspace_test(device["id"], {
                "name": "r1", "group": "R2", "roundCount": 1, "rounds": [{}],
            }, store_path)

            self.assertEqual("r1", first["name"])
            self.assertEqual("r1", second["name"])
            self.assertNotEqual(first["id"], second["id"])

    def test_workspace_test_group_persists_across_create_and_update(self) -> None:
        """测试集分组应独立保存，旧的空分组也保持兼容。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            created = create_workspace_test(device["id"], {
                "name": "吞吐验证", "group": "吞吐对比", "roundCount": 1, "rounds": [{}],
            }, store_path)
            self.assertEqual("吞吐对比", created["group"])

            updated = update_workspace_test(device["id"], created["id"], {
                **created, "group": "回归测试",
            }, store_path)
            self.assertEqual("回归测试", updated["group"])
            loaded = get_workspace_device(device["id"], store_path)
            self.assertEqual("回归测试", loaded["tests"][0]["group"])
            self.assertEqual(["吞吐对比", "回归测试"], loaded["testGroups"])

    def test_workspace_group_can_exist_without_creating_test(self) -> None:
        """点击组别加号只应增加空组，不应隐式增加测试。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            groups = config_server.create_workspace_test_group(device["id"], "性能测试", store_path)
            loaded = get_workspace_device(device["id"], store_path)
            self.assertEqual(["性能测试"], groups)
            self.assertEqual(["性能测试"], loaded["testGroups"])
            self.assertEqual([], loaded["tests"])

    def test_workspace_group_can_rename_and_delete_its_tests(self) -> None:
        """组别改名应同步测试；删除组别必须一并移除组内测试。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            config_server.create_workspace_test_group(device["id"], "回归", store_path)
            config_server.create_workspace_test_group(device["id"], "保留", store_path)
            created = create_workspace_test(device["id"], {
                "name": "回归案例", "group": "回归", "roundCount": 1, "rounds": [{}],
            }, store_path)
            create_workspace_test(device["id"], {
                "name": "保留案例", "group": "保留", "roundCount": 1, "rounds": [{}],
            }, store_path)

            renamed = config_server.rename_workspace_test_group(device["id"], "回归", "冒烟", store_path)
            self.assertEqual(["冒烟", "保留"], renamed["groups"])
            self.assertEqual("冒烟", next(test for test in renamed["tests"] if test["id"] == created["id"])["group"])

            deleted = config_server.delete_workspace_test_group(device["id"], "冒烟", store_path)
            self.assertEqual(1, deleted["deletedTestCount"])
            self.assertEqual(["保留"], deleted["groups"])
            self.assertEqual(["保留案例"], [test["name"] for test in deleted["tests"]])
            ungrouped = create_workspace_test(device["id"], {
                "name": "未分组案例", "roundCount": 1, "rounds": [{}],
            }, store_path)
            deleted_ungrouped = config_server.delete_workspace_test_group(device["id"], "", store_path)
            self.assertEqual(1, deleted_ungrouped["deletedTestCount"])
            self.assertNotIn(ungrouped["id"], [test["id"] for test in deleted_ungrouped["tests"]])

    def test_batch_run_uses_selected_strategy_for_every_test_in_current_group(self) -> None:
        """批量运行应筛选当前组，并把同一策略应用到组内全部测试。"""
        routes = [_route("BatchRoute", "PM1,PM2", "BatchRecipe")]
        grouped_tests = [
            {
                "id": "test-a", "name": "案例 A", "group": "回归",
                "roundCount": 1, "options": {"seed": 1},
                "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
            },
            {
                "id": "test-b", "name": "案例 B", "group": "回归",
                "roundCount": 1, "options": {"seed": 2},
                "rounds": [{"currentTime": 0, "jobs": [_job("B", "BatchRoute", "LP2")]}],
            },
            {
                "id": "test-c", "name": "其他组", "group": "性能",
                "roundCount": 1, "options": {},
                "rounds": [{"currentTime": 0, "jobs": [_job("C", "BatchRoute", "LP1")]}],
            },
        ]
        device = {
            "id": "device-batch",
            "name": "fixture.json",
            "device": self.device,
            "routes": routes,
            "cleans": [],
            "tests": grouped_tests,
        }
        submitted = []

        def fake_execute(plan):
            submitted.append(plan)
            return {
                "ok": True,
                "totalElapsedMs": 10.0,
                "makespan": 20.0,
                "moveCount": 3,
                "validation": "passed",
                "output": {"MoveList": []},
                "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server.run_workspace_test_batch(
                "device-batch", "回归", "e2e-ctq", {"seed": 9}, maximum_workers=2,
            )

        self.assertEqual(2, result["testCount"])
        self.assertEqual(2, result["succeeded"])
        self.assertEqual({"案例 A", "案例 B"}, {item["testName"] for item in result["items"]})
        self.assertEqual(4, len(submitted))
        self.assertEqual(2, sum(plan["strategy"] == "heuristic" for plan in submitted))
        self.assertEqual(2, sum(plan["strategy"] == "e2e-ctq" for plan in submitted))
        self.assertTrue(all(plan["options"]["seed"] == 9 for plan in submitted))
        self.assertTrue(all([route["name"] for route in plan["routes"]] == ["BatchRoute"] for plan in submitted))
        self.assertTrue(all(item["baseline"]["status"] == "succeeded" for item in result["items"]))
        self.assertTrue(all(item["improvementPercent"] == 0 for item in result["items"]))

    def test_background_batch_exposes_queued_running_and_completed_item_status(self) -> None:
        """后台批量任务应在运行期间暴露逐项状态，并在结束后返回全部结果 URL。"""
        device = {
            "id": "device-progress",
            "name": "fixture.json",
            "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [],
            "tests": [
                {
                    "id": f"test-{index}", "name": f"案例 {index}", "group": "回归",
                    "roundCount": 1, "options": {},
                    "rounds": [{"currentTime": 0, "jobs": [_job(f"J{index}", "BatchRoute", "LP1")]}],
                }
                for index in (1, 2)
            ],
        }
        first_started = threading.Event()
        release = threading.Event()

        def fake_execute(_plan):
            first_started.set()
            self.assertTrue(release.wait(2))
            return {
                "ok": True, "totalElapsedMs": 10.0, "makespan": 20.0,
                "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            initial = config_server.start_workspace_test_batch(
                "device-progress", "回归", "heuristic", {}, maximum_workers=1,
            )
            self.assertTrue(first_started.wait(2))
            running = config_server.read_workspace_batch_run(initial["batchId"])
            self.assertEqual(["running", "queued"], [item["status"] for item in running["items"]])
            release.set()
            deadline = time.time() + 3
            while time.time() < deadline:
                completed = config_server.read_workspace_batch_run(initial["batchId"])
                if completed["status"] == "completed":
                    break
                time.sleep(0.01)
            else:
                self.fail("后台批量任务未在时限内完成")

        self.assertEqual(2, completed["completed"])
        self.assertEqual(["succeeded", "succeeded"], [item["status"] for item in completed["items"]])
        self.assertTrue(all(item["resultUrl"] == "/api/results/result-id" for item in completed["items"]))

    def test_batch_log_archive_contains_each_available_test_log_and_manifest(self) -> None:
        """批量日志下载应将各测试日志及其测试集映射一次性打包。"""
        batch_id = "a" * 32
        config_server._BATCH_RUNS[batch_id] = {
            "batchId": batch_id,
            "deviceName": "fixture.json",
            "group": "回归",
            "strategy": "heuristic",
            "items": [
                {"index": 0, "testId": "test-a", "testName": "案例/A", "status": "succeeded", "logUrl": "/api/logs/log-a"},
                {"index": 1, "testId": "test-b", "testName": "案例 B", "status": "cancelled"},
                {"index": 2, "testId": "test-c", "testName": "案例 C", "status": "failed", "logUrl": "/api/logs/log-c"},
            ],
        }
        try:
            with patch.object(config_server, "read_reproduction_log", side_effect=lambda log_id: [{"Type": log_id}]):
                content, filename = config_server.build_workspace_batch_log_archive(batch_id)
        finally:
            config_server._BATCH_RUNS.pop(batch_id, None)

        self.assertEqual(f"ct-batch-logs-{batch_id[:8]}.zip", filename)
        with zipfile.ZipFile(BytesIO(content)) as archive:
            self.assertEqual(["t01_案例_A.json", "t03_案例 C.json", "manifest.json"], archive.namelist())
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(2, manifest["exportedLogCount"])
        self.assertEqual("t01_案例_A.json", manifest["items"][0]["logFile"])
        self.assertEqual("", manifest["items"][1]["logFile"])

    def test_non_heuristic_batch_creates_baseline_and_reports_improvement(self) -> None:
        """其他策略首次运行时应先补算 Heuristic，并返回相对改善。"""
        test_case = {
            "id": "test-baseline", "name": "Baseline 案例", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-baseline", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }

        def fake_execute(plan):
            makespan = 100.0 if plan["strategy"] == "heuristic" else 80.0
            return {
                "ok": True, "totalElapsedMs": 12.0, "cpuTimeMs": 7.0,
                "makespan": makespan, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server.run_workspace_test_batch(
                "device-baseline", "回归", "e2e-ctq", {}, maximum_workers=1,
            )

        item = result["items"][0]
        self.assertEqual("succeeded", item["baseline"]["status"])
        self.assertEqual(100.0, item["baseline"]["makespan"])
        self.assertEqual(80.0, item["makespan"])
        self.assertEqual(-20.0, item["makespanDelta"])
        self.assertEqual(20.0, item["improvementPercent"])
        self.assertEqual(0, item["robotWaferDwellTime"]["sampleCount"])

    def test_external_validation_failure_keeps_metrics_and_baseline_comparison(self) -> None:
        """外部算法校验失败后仍应保留原始指标和 Baseline 对比。"""
        test_case = {
            "id": "test-external-invalid", "name": "外部校验失败案例", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")] }],
        }
        device = {
            "id": "device-external-invalid", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }

        def fake_execute(plan):
            if plan["strategy"] == "heuristic":
                return {
                    "ok": True, "totalElapsedMs": 12.0, "cpuTimeMs": 7.0,
                    "makespan": 100.0, "moveCount": 3, "validation": "passed",
                    "output": {"MoveList": []}, "reproductionLog": [],
                }
            raise LoggedPlanError(
                "MoveList 状态校验失败：无效动作",
                [],
                failure_output={"MoveList": [{"MoveID": 1, "StartTime": 0, "EndTime": 80}]},
                validation_issues=["MoveID=1 无效动作"],
            )

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server.run_workspace_test_batch(
                "device-external-invalid", "回归", "other_alg:demo", {}, maximum_workers=1,
            )

        item = result["items"][0]
        self.assertEqual("failed", item["status"])
        self.assertTrue(item["metricsAvailable"])
        self.assertEqual("failed", item["validation"])
        self.assertEqual(80.0, item["makespan"])
        self.assertEqual(20.0, item["improvementPercent"])
        self.assertEqual("/api/results/result-id", item["resultUrl"])

    def test_skip_validation_bypasses_move_list_checks(self) -> None:
        """勾选“跳过输出校验”后不再调用 MoveList 校验，结果标记为 skipped。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 1,
            "options": {},
            "recipes": [{"name": "R1", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("R1", "PM1,PM2", "R1")],
            "rounds": [{"currentTime": 0, "cjobs": [{"taskId": "1", "jobType": "NormalLot", "priority": 1, "taskMode": "Smart", "pjobs": [
                {"jobName": "P1", "routeRef": "R1", "loadPort": "LP1", "waferCount": 2, "priority": 1},
            ]}]}],
        }
        with patch.object(config_server, "validate_move_list", return_value=["Mock 无效动作"]):
            with self.assertRaisesRegex(LoggedPlanError, "MoveList 状态校验失败"):
                execute_plan(plan)
        with patch.object(config_server, "validate_move_list", return_value=["Mock 无效动作"]) as mocked:
            result = execute_plan({**plan, "skipValidation": True})
        self.assertTrue(result["ok"])
        self.assertEqual("skipped", result["validation"])
        self.assertEqual(1, len(result["rounds"]))
        mocked.assert_not_called()

    def test_batch_skip_validation_bypasses_move_list_checks(self) -> None:
        """批量运行勾选“跳过输出校验”后，每项结果标记为 skipped 且不再校验。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        test_case = {
            "id": "test-skip-batch", "name": "跳过校验批量案例", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "cjobs": [{"taskId": "1", "jobType": "NormalLot", "priority": 1, "taskMode": "Smart", "pjobs": [
                {"jobName": "P1", "routeRef": "R1", "loadPort": "LP1", "waferCount": 2, "priority": 1},
            ]}]}],
        }
        device = {
            "id": "device-skip-batch", "name": "fixture.json", "device": pse300,
            "routes": [_route("R1", "PM1,PM2", "R1")],
            "cleans": [], "tests": [test_case],
        }
        # 默认不写 skipValidation 键，保证 Baseline 指纹与旧版本一致。
        default_plan = config_server.build_workspace_batch_plan(device, test_case, "heuristic", {})
        self.assertNotIn("skipValidation", default_plan)
        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "validate_move_list", return_value=["Mock 无效动作"]) as mocked,
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server.run_workspace_test_batch(
                "device-skip-batch", "回归", "heuristic", {}, skip_validation=True, maximum_workers=1,
            )
        item = result["items"][0]
        self.assertEqual("succeeded", item["status"])
        self.assertEqual("skipped", item["validation"])
        mocked.assert_not_called()

    def test_batch_skip_baseline_skips_heuristic(self) -> None:
        """勾选“跳过Baseline”后批量运行不再连带执行本地 heuristic。"""
        test_case = {
            "id": "test-skip-baseline", "name": "跳过基线案例", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-skip-baseline", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }
        executed_strategies: list = []

        def fake_execute(plan):
            executed_strategies.append(str(plan["strategy"]))
            return {
                "ok": True, "totalElapsedMs": 12.0, "cpuTimeMs": 7.0,
                "makespan": 80.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server.run_workspace_test_batch(
                "device-skip-baseline", "回归", "other_alg:demo", {},
                skip_baseline=True, maximum_workers=1,
            )

        # 只执行主策略，不再补算 heuristic baseline。
        self.assertEqual(["other_alg:demo"], executed_strategies)
        item = result["items"][0]
        self.assertEqual("succeeded", item["status"])
        self.assertEqual("skipped", item["baseline"]["status"])
        self.assertNotIn("improvementPercent", item)
        self.assertNotIn("baseline", test_case)

    def test_skip_baseline_ignores_existing_baseline(self) -> None:
        """跳过 Baseline 时不读取已有基线记录，统一返回 skipped 占位。"""
        test_case = {
            "id": "test-skip-baseline-existing", "name": "已有基线跳过案例", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-skip-baseline-existing", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }
        # 放入指纹匹配的有效旧基线，验证跳过时不读取它。
        matching_fingerprint = config_server._workspace_baseline_fingerprint(device, test_case)
        test_case["baseline"] = {
            "status": "succeeded", "fingerprint": matching_fingerprint, "makespan": 1.0,
        }
        executed_strategies: list = []

        def fake_execute(plan):
            executed_strategies.append(str(plan["strategy"]))
            return {
                "ok": True, "totalElapsedMs": 12.0, "cpuTimeMs": 7.0,
                "makespan": 80.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
        ):
            result, baseline, error = config_server._execute_workspace_test_with_baseline(
                device, test_case, "other_alg:demo", {}, skip_baseline=True,
            )

        self.assertEqual(["other_alg:demo"], executed_strategies)
        self.assertIsNotNone(result)
        self.assertIsNone(error)
        self.assertEqual("skipped", baseline["status"])
        self.assertEqual(matching_fingerprint, test_case["baseline"]["fingerprint"])

    def test_skip_baseline_heuristic_keeps_result_without_persisting(self) -> None:
        """heuristic 主策略 + 跳过 Baseline：照常执行，但不回写基线记录。"""
        test_case = {
            "id": "test-skip-baseline-heuristic", "name": "启发式跳过基线案例", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-skip-baseline-heuristic", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }
        executed_strategies: list = []

        def fake_execute(plan):
            executed_strategies.append(str(plan["strategy"]))
            return {
                "ok": True, "totalElapsedMs": 12.0, "cpuTimeMs": 7.0,
                "makespan": 80.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True) as persist_mock,
        ):
            result, baseline, error = config_server._execute_workspace_test_with_baseline(
                device, test_case, "heuristic", {}, skip_baseline=True,
            )

        self.assertIsNotNone(result)
        self.assertIsNone(error)
        # 只执行一次 heuristic 主策略；结果不落库、不写入工作区基线。
        self.assertEqual(["heuristic"], executed_strategies)
        self.assertEqual("skipped", baseline["status"])
        persist_mock.assert_not_called()
        self.assertNotIn("baseline", test_case)

    def test_robot_wafer_dwell_time_tracks_pick_place_and_swap_waits(self) -> None:
        """机器人持片驻留应统计 Pick/Place 间隙，并正确衔接 Swap 的收发晶圆。"""
        moves = [
            {"MoveID": 1, "MoveType": 0, "Robot": "VTR", "MatIDList": [1], "StartTime": 0, "EndTime": 2},
            {"MoveID": 8, "MoveType": 5, "Robot": "VTR", "StartTime": 3, "EndTime": 5},
            {"MoveID": 2, "MoveType": 1, "Robot": "VTR", "MatIDList": [1], "StartTime": 7, "EndTime": 9},
            {"MoveID": 3, "MoveType": 2, "ModuleName": "ATR", "MatIDList": [2], "StartTime": 8, "EndTime": 10},
            {"MoveID": 4, "MoveType": 3, "ModuleName": "ATR", "MatIDList": [2], "StartTime": 13, "EndTime": 15},
            {"MoveID": 5, "MoveType": 0, "Robot": "VTR", "MatIDList": [3], "StartTime": 18, "EndTime": 20},
            {"MoveID": 6, "MoveType": 4, "Robot": "VTR", "RecvMatList": [4], "SendMatList": [3], "StartTime": 22, "EndTime": 24},
            {"MoveID": 7, "MoveType": 1, "Robot": "VTR", "MatIDList": [4], "StartTime": 28, "EndTime": 30},
        ]

        metrics = config_server._robot_wafer_dwell_time(moves)

        self.assertEqual(4, metrics["sampleCount"])
        self.assertAlmostEqual(12.0, metrics["totalSeconds"])
        self.assertAlmostEqual(3.0, metrics["medianSeconds"])
        self.assertAlmostEqual(4.0, metrics["maxSeconds"])

    def test_heuristic_refreshes_changed_baseline_result(self) -> None:
        """再次运行 Heuristic 时，应以本次 makespan 和 CPU Time 覆盖旧值。"""
        test_case = {
            "id": "test-refresh", "name": "刷新案例", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-refresh", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }
        fingerprint = config_server._workspace_baseline_fingerprint(device, test_case)
        test_case["baseline"] = {
            "status": "succeeded", "fingerprint": fingerprint,
            "makespan": 90.0, "cpuTimeMs": 4.0,
        }
        refreshed = {
            "ok": True, "totalElapsedMs": 13.0, "cpuTimeMs": 8.0,
            "makespan": 100.0, "moveCount": 3, "validation": "passed",
            "output": {"MoveList": []}, "reproductionLog": [],
        }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", return_value=refreshed),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server.run_workspace_test_batch(
                "device-refresh", "回归", "heuristic", {}, maximum_workers=1,
            )

        baseline = result["items"][0]["baseline"]
        self.assertEqual(100.0, baseline["makespan"])
        self.assertEqual(8.0, baseline["cpuTimeMs"])

    def test_failed_baseline_replaces_old_data_and_reports_reason(self) -> None:
        """Baseline 重算失败时不能继续返回旧数据，但其他策略结果仍可展示。"""
        test_case = {
            "id": "test-failed-base", "name": "失败案例", "group": "回归",
            "roundCount": 1, "options": {"seed": 2},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
            "baseline": {
                "status": "succeeded", "fingerprint": "stale",
                "makespan": 50.0, "cpuTimeMs": 2.0,
            },
        }
        device = {
            "id": "device-failed-base", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }

        def fake_execute(plan):
            if plan["strategy"] == "heuristic":
                raise LoggedPlanError("Baseline 无可行解", [])
            return {
                "ok": True, "totalElapsedMs": 12.0, "cpuTimeMs": 7.0,
                "makespan": 80.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server.run_workspace_test_batch(
                "device-failed-base", "回归", "e2e-ctq", {}, maximum_workers=1,
            )

        item = result["items"][0]
        self.assertTrue(item["ok"])
        self.assertEqual("failed", item["baseline"]["status"])
        self.assertIn("Baseline 无可行解", item["baseline"]["error"])
        self.assertNotIn("improvementPercent", item)
        self.assertNotIn("makespan", item["baseline"])

    def test_configuration_change_invalidates_baseline_fingerprint(self) -> None:
        """测试配置变化后，旧 Baseline 应立即变为 invalid。"""
        test_case = {
            "id": "test-invalid", "name": "失效案例", "group": "回归",
            "roundCount": 1, "options": {"seed": 1},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-invalid", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }
        test_case["baseline"] = {
            "status": "succeeded",
            "fingerprint": config_server._workspace_baseline_fingerprint(device, test_case),
            "makespan": 100.0,
            "cpuTimeMs": 5.0,
        }
        test_case["options"]["seed"] = 9
        config_server._invalidate_stale_device_baselines(device)

        self.assertEqual("invalid", test_case["baseline"]["status"])
        self.assertNotIn("makespan", test_case["baseline"])
        self.assertIn("配置已修改", test_case["baseline"]["error"])

    def test_background_batch_can_be_cancelled_without_overwriting_status(self) -> None:
        """取消后排队和运行项都应立即终止，迟到的算法结果不能覆盖状态。"""
        device = {
            "id": "device-cancel",
            "name": "fixture.json",
            "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [],
            "tests": [
                {
                    "id": f"test-{index}", "name": f"案例 {index}", "group": "回归",
                    "roundCount": 1, "options": {},
                    "rounds": [{"currentTime": 0, "jobs": [_job(f"J{index}", "BatchRoute", "LP1")]}],
                }
                for index in (1, 2)
            ],
        }
        started = threading.Event()
        release = threading.Event()

        def fake_execute(_plan):
            started.set()
            self.assertTrue(release.wait(2))
            return {
                "ok": True, "totalElapsedMs": 10.0, "makespan": 20.0,
                "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
        ):
            initial = config_server.start_workspace_test_batch(
                "device-cancel", "回归", "heuristic", {}, maximum_workers=1,
            )
            self.assertTrue(started.wait(2))
            cancelled = config_server.cancel_workspace_batch_run(initial["batchId"])
            self.assertEqual("cancelled", cancelled["status"])
            self.assertEqual(2, cancelled["cancelled"])
            self.assertEqual(["cancelled", "cancelled"], [item["status"] for item in cancelled["items"]])
            release.set()
            time.sleep(0.2)

        final = config_server.read_workspace_batch_run(initial["batchId"])
        self.assertEqual("cancelled", final["status"])
        self.assertEqual(["cancelled", "cancelled"], [item["status"] for item in final["items"]])

    def test_batch_status_route_is_served_by_get_and_cancelled_by_delete(self) -> None:
        """轮询必须走 GET；DELETE 用于终止同一批量任务。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)
        delete_source = inspect.getsource(config_server.ConfigEditorHandler.do_DELETE)
        self.assertIn('path.startswith("/api/run-batches/")', get_source)
        self.assertNotIn('path.startswith("/api/run-batches/")', post_source)
        self.assertIn("cancel_workspace_batch_run", delete_source)
        self.assertIn('parts[2] == "devices"', delete_source)
        self.assertIn("delete_workspace_device", delete_source)

    def test_single_external_failure_keeps_elapsed_time_and_baseline_visible(self) -> None:
        """单次外部算法失败也应返回并绘制耗时及 Baseline 对比。"""
        html = _editor_source()
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)

        self.assertIn('"metricsAvailable": True', post_source)
        self.assertIn('strategy.casefold().startswith("other_alg:")', post_source)
        self.assertIn("showFailedResultMetrics(runResult)", html)
        self.assertIn('setResultMetric("Time", "失败前耗时"', html)
        self.assertIn('setResultMetric("Makespan", "Makespan / Baseline"', html)

    def test_automatic_route_rename_updates_every_test_reference(self) -> None:
        """共享 Route 自动改名后，设备下所有测试的 PJob 引用都应同步迁移。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            base = {
                "strategy": "heuristic", "roundCount": 1, "routes": [{"name": "R1"}],
                "rounds": [{"cjobs": [{"pjobs": [{"routeRef": "R1", "loadPort": "LP1"}]}]}],
            }
            first = create_workspace_test(device["id"], {**base, "name": "测试一"}, store_path)
            create_workspace_test(device["id"], {**base, "name": "测试二"}, store_path)

            update_workspace_test(device["id"], first["id"], {
                **first,
                "routes": [{"name": "1道工序 · PM1/PM2"}],
                "routeNameChanges": {"R1": "1道工序 · PM1/PM2"},
                "rounds": [{"cjobs": [{"pjobs": [{
                    "routeRef": "1道工序 · PM1/PM2", "loadPort": "LP1",
                }]}]}],
            }, store_path)

            loaded = get_workspace_device(device["id"], store_path)
            references = [
                test["rounds"][0]["cjobs"][0]["pjobs"][0]["routeRef"]
                for test in loaded["tests"]
            ]
            self.assertEqual(["1道工序 · PM1/PM2", "1道工序 · PM1/PM2"], references)

    def test_workspace_batch_only_includes_cleans_referenced_by_selected_routes(self) -> None:
        """未被当前 Route 引用的共享 Clean 不应污染执行输入或 Baseline 指纹。"""
        first_route = _route("R1", "PM1", "Recipe1")
        first_route["prePJobCleanRefs"] = ["Clean1"]
        second_route = _route("R2", "PM2", "Recipe2")
        second_route["prePJobCleanRefs"] = ["Clean2"]
        device = {
            "name": "device.json",
            "device": self.device,
            "routes": [first_route, second_route],
            "cleans": [
                {
                    "name": "Clean1",
                    "recipeName": "CleanRecipe1",
                    "recipeTime": 30,
                    "modules": ["PM1"],
                },
                {
                    "name": "Clean2",
                    "recipeName": "CleanRecipe2",
                    "recipeTime": 45,
                    "modules": ["PM2"],
                },
            ],
        }
        test_case = {
            "rounds": [{
                "currentTime": 0,
                "cjobs": [{
                    "pjobs": [{
                        "routeRef": "R1",
                        "loadPort": "LP1",
                        "waferCount": 1,
                    }],
                }],
            }],
        }

        plan = config_server.build_workspace_batch_plan(
            device,
            test_case,
            "heuristic",
            {},
        )

        self.assertEqual(["R1"], [route["name"] for route in plan["routes"]])
        self.assertEqual(["Clean1"], [clean["name"] for clean in plan["cleans"]])
        recipe_names = {recipe["name"] for recipe in plan["recipes"]}
        self.assertIn("CleanRecipe1", recipe_names)
        self.assertNotIn("CleanRecipe2", recipe_names)

    def test_legacy_test_routes_merge_into_shared_device_library(self) -> None:
        """Test3 有两条 Route、Test4 仅一条时，迁移后两者应使用设备的两条共享 Route。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            legacy = {
                "version": 1,
                "devices": [{
                    "id": "device-1", "name": "PSE300.json", "device": self.device,
                    "tests": [
                        {"id": "test3", "name": "Test3", "updatedAt": "2026-01-01T00:00:00+08:00",
                         "routes": [{"name": "R1"}, {"name": "R2"}], "cleans": [{"name": "C1"}]},
                        {"id": "test4", "name": "Test4", "updatedAt": "2026-01-02T00:00:00+08:00",
                         "routes": [{"name": "R1"}], "cleans": []},
                    ],
                }],
            }
            store_path.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")

            loaded = get_workspace_device("device-1", store_path)

            self.assertEqual(["R1", "R2"], [route["name"] for route in loaded["routes"]])
            self.assertEqual(["C1"], [clean["name"] for clean in loaded["cleans"]])
            self.assertTrue(all("routes" not in test and "cleans" not in test for test in loaded["tests"]))
            migrated = json.loads(store_path.read_text(encoding="utf-8"))
            self.assertEqual(3, migrated["version"])

    def test_nested_rounds_persist_without_reordering(self) -> None:
        """多轮、多 CJob/PJob 保存后重新读取，应保留时间与归属并重算只读字段。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            nested = {
                "name": "三级结构", "strategy": "heuristic", "roundCount": 3,
                "times": [0, 70, 160], "options": {}, "cleans": [], "routes": [{"name": "Route12"}],
                "rounds": [
                    {"currentTime": 0, "cjobs": [{"pjobs": [{"routeRef": "Route12", "loadPort": "LP1", "waferCount": 2}]}]},
                    {"currentTime": 70, "cjobs": [
                        {"jobType": "NormalLot", "priority": 2, "pjobs": [
                            {"routeRef": "Route12", "loadPort": "LP2", "waferCount": 3},
                            {"routeRef": "Route12", "loadPort": "LP3", "waferCount": 1},
                        ]},
                        {"jobType": "HigherLot", "priority": 8, "taskMode": "Concurrent", "pjobs": [
                            {"routeRef": "Route12", "loadPort": "LP4", "waferCount": 4},
                        ]},
                    ]},
                    {"currentTime": 160, "cjobs": [{"pjobs": [{"routeRef": "Route12", "loadPort": "LP1", "waferCount": 1}]}]},
                ],
            }
            created = create_workspace_test(device["id"], nested, store_path)
            loaded = get_workspace_device(device["id"], store_path)["tests"][0]
            self.assertEqual([0.0, 70.0, 160.0], loaded["times"])
            self.assertEqual(created["id"], loaded["id"])
            second = loaded["rounds"][1]
            self.assertEqual(2, len(second["cjobs"]))
            self.assertEqual(["2", "3"], [item["taskId"] for item in second["cjobs"]])
            self.assertEqual(["LP2", "LP3"], [
                item["loadPort"] for item in second["cjobs"]
            ])
            self.assertTrue(all(
                pjob["loadPort"] == cjob["loadPort"]
                for cjob in second["cjobs"]
                for pjob in cjob["pjobs"]
            ))
            self.assertEqual(["P1", "P2"], second["cjobs"][0]["pJobNameList"])
            self.assertEqual([3, 4, 5], second["cjobs"][0]["pjobs"][0]["matList"])
            self.assertEqual([6], second["cjobs"][0]["pjobs"][1]["matList"])
            self.assertEqual([7, 8, 9, 10], second["cjobs"][1]["pjobs"][0]["matList"])
            self.assertEqual(-1, second["cjobs"][1]["priority"])
            self.assertEqual("Concurrent", second["cjobs"][1]["taskMode"])

    def test_task_modes_automatically_assign_load_ports(self) -> None:
        """Smart 同轮铺满端口；Pipeline/Sequential 每轮单盒并依次轮转。"""
        smart = config_server._normalize_test_case({
            "name": "smart",
            "roundCount": 2,
            "rounds": [
                {"cjobs": [
                    {"taskMode": "Smart", "pjobs": [{}]},
                    {"taskMode": "Smart", "pjobs": [{}]},
                    {"taskMode": "Smart", "pjobs": [{}]},
                ]},
                {"currentTime": 10, "cjobs": [
                    {"taskMode": "Smart", "pjobs": [{}]},
                ]},
            ],
        }, load_ports=["LP1", "LP2", "LP3"])
        self.assertEqual(
            ["LP1", "LP2", "LP3", "LP1"],
            [
                cjob["loadPort"]
                for round_row in smart["rounds"]
                for cjob in round_row["cjobs"]
            ],
        )

        for mode in ("Pipeline", "Sequential"):
            with self.subTest(taskMode=mode):
                serial = config_server._normalize_test_case({
                    "name": mode,
                    "roundCount": 3,
                    "rounds": [
                        {"cjobs": [{"taskMode": mode, "pjobs": [{}]}]},
                        {"currentTime": 10, "cjobs": [{"taskMode": mode, "pjobs": [{}]}]},
                        {"currentTime": 20, "cjobs": [{"taskMode": mode, "pjobs": [{}]}]},
                    ],
                }, load_ports=["LP1", "LP2", "LP3"])
                self.assertEqual(
                    ["LP1", "LP2", "LP3"],
                    [row["cjobs"][0]["loadPort"] for row in serial["rounds"]],
                )
                with self.assertRaisesRegex(ValueError, "只能配置一个 CJob"):
                    config_server._normalize_test_case({
                        "name": f"invalid-{mode}",
                        "rounds": [{"cjobs": [
                            {"taskMode": mode, "pjobs": [{}]},
                            {"taskMode": mode, "pjobs": [{}]},
                        ]}],
                    }, load_ports=["LP1", "LP2", "LP3"])

    def test_test3_nested_jobs_run_successfully(self) -> None:
        """test3 形状的两轮、首轮双 PJob 配置应完成真实重算。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 2,
            "options": {},
            "recipes": [{"name": "R1", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("R1", "PM1,PM2", "R1")],
            "rounds": [
                {"currentTime": 0, "cjobs": [{"taskId": "1", "jobType": "NormalLot", "priority": 1, "taskMode": "Smart", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP1", "waferCount": 5, "priority": 1},
                    {"jobName": "P2", "routeRef": "R1", "loadPort": "LP1", "waferCount": 5, "priority": 1},
                ]}]},
                {"currentTime": 500, "cjobs": [{"taskId": "2", "jobType": "NormalLot", "priority": 1, "taskMode": "Smart", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP2", "waferCount": 5, "priority": 1},
                ]}]},
            ],
        }
        result = execute_plan(plan)
        self.assertTrue(result["ok"])
        self.assertEqual("passed", result["validation"])
        self.assertEqual(2, len(result["rounds"]))
        self.assertEqual(3, sum(round_row["jobCount"] for round_row in result["rounds"]))

    def test_recompute_balances_loadlocks_and_starts_with_earlier_released_pm(self) -> None:
        """上一轮最后使用 PM1 时，下一轮应从更早释放的 PM2 开始并同时使用 LA/LB。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 2,
            "options": {},
            "recipes": [{"name": "R1", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("R1", "PM1,PM2", "R1")],
            "rounds": [
                {"currentTime": 0, "cjobs": [{"taskId": "1", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP1", "waferCount": 3},
                    {"jobName": "P2", "routeRef": "R1", "loadPort": "LP1", "waferCount": 2},
                ]}]},
                {"currentTime": 500, "cjobs": [{"taskId": "2", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP2", "waferCount": 5},
                ]}]},
            ],
        }

        result = execute_plan(plan)
        process_moves = [
            move for move in result["output"]["MoveList"]
            if move.get("MoveType") == 9 and move.get("MatIDList")
        ]
        last_initial = max(
            (move for move in process_moves if "1.C1.P2" in (move.get("PJobName") or [])),
            key=lambda move: float(move["EndTime"]),
        )
        first_added = min(
            (move for move in process_moves if "2.C1.P1" in (move.get("PJobName") or [])),
            key=lambda move: float(move["StartTime"]),
        )
        added_loadlocks = {
            move.get("ModuleName")
            for move in result["output"]["MoveList"]
            if "2.C1.P1" in (move.get("PJobName") or [])
            and move.get("ModuleName") in {"LA", "LB"}
        }

        self.assertEqual("PM1", last_initial["ModuleName"])
        self.assertEqual("PM2", first_added["ModuleName"])
        self.assertEqual({"LA", "LB"}, added_loadlocks)

    def test_recompute_selects_relaxed_wip_fifo_by_real_movelist_makespan(self) -> None:
        """同 Route 续排应比较保留/解除在机片伪 FIFO，并按真实 MoveList 选择。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 2,
            "options": {},
            "recipes": [{
                "name": "CadenceRecipe",
                "time": 40,
                "modules": ["PM1"],
                "weight": {},
            }],
            "cleans": [],
            "routes": [_route("CadenceRoute", "PM1", "CadenceRecipe")],
            "rounds": [
                {
                    "currentTime": 0,
                    "jobs": [{
                        **_job("CadenceJob1", "CadenceRoute", "LP1"),
                        "waferCount": 6,
                    }],
                },
                {
                    "currentTime": 300,
                    "jobs": [{
                        **_job("CadenceJob2", "CadenceRoute", "LP2"),
                        "waferCount": 6,
                    }],
                },
            ],
        }

        result = execute_plan(plan)
        diagnostics = result["rounds"][1]["strategyDiagnostics"]
        process_moves = sorted(
            (
                move
                for move in result["output"]["MoveList"]
                if move.get("MoveType") == 9
                and move.get("ModuleName") == "PM1"
            ),
            key=lambda move: float(move["StartTime"]),
        )
        maximum_process_gap = max(
            float(current["StartTime"]) - float(previous["EndTime"])
            for previous, current in zip(process_moves, process_moves[1:])
        )

        self.assertEqual("relaxed", diagnostics["resumedRouteFifoSelected"])
        self.assertLess(maximum_process_gap, 100.0)
        self.assertLess(result["makespan"], 861.0)

    def test_equal_normal_lots_run_concurrently_with_complete_pm_rotation(self) -> None:
        """同优 NormalLot 应并发，并按物料顺序完整轮转各自的加工腔池。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 2,
            "options": {},
            "recipes": [
                {"name": "R1", "time": 20, "modules": "PM1,PM2", "weight": {}},
                {"name": "R2", "time": 70, "modules": "PM3,PM4", "weight": {}},
            ],
            "cleans": [],
            "routes": [
                _route("R1", "PM1,PM2", "R1"),
                _route("R2", "PM3,PM4", "R2"),
            ],
            "rounds": [
                {"currentTime": 0, "cjobs": [{
                    "taskId": "1", "jobType": "NormalLot", "priority": 1,
                    "taskMode": "Smart", "pjobs": [{
                        "jobName": "P1", "routeRef": "R1", "loadPort": "LP1",
                        "waferCount": 10, "priority": 1,
                    }],
                }]},
                {"currentTime": 200, "cjobs": [{
                    "taskId": "2", "jobType": "NormalLot", "priority": 1,
                    "taskMode": "Smart", "pjobs": [{
                        "jobName": "P1", "routeRef": "R2", "loadPort": "LP2",
                        "waferCount": 10, "priority": 1,
                    }],
                }]},
            ],
        }

        result = execute_plan(plan)
        self.assertEqual("passed", result["validation"])
        process_by_job = {}
        for job_name in ("1.C1.P1", "2.C1.P1"):
            process_by_job[job_name] = sorted(
                [(
                    int(move["MatIDList"][0]),
                    str(move["ModuleName"]),
                    float(move["StartTime"]),
                    float(move["EndTime"]),
                )
                for move in result["output"]["MoveList"]
                if move.get("MoveType") == 9
                and move.get("MatIDList")
                and job_name in (move.get("PJobName") or [])
                ],
                key=lambda row: row[2],
            )

        self.assertEqual(list(range(1, 11)), [row[0] for row in process_by_job["1.C1.P1"]])
        self.assertEqual(list(range(11, 21)), [row[0] for row in process_by_job["2.C1.P1"]])
        self.assertEqual(["PM1", "PM2"] * 5, [row[1] for row in process_by_job["1.C1.P1"]])
        self.assertEqual(["PM3", "PM4"] * 5, [row[1] for row in process_by_job["2.C1.P1"]])
        self.assertTrue(any(
            max(c1[2], c2[2]) < min(c1[3], c2[3]) - 1e-6
            for c1 in process_by_job["1.C1.P1"]
            for c2 in process_by_job["2.C1.P1"]
        ))

    def test_pse300_arbitrary_recompute_uses_bounded_recovery_window(self) -> None:
        """任意时刻重算只保留在途收尾，新计划从请求时间带资源下界续排。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        initial_job = _job("InitialJob", "Route12", "LP1")
        initial_job["waferCount"] = 5
        added_job = _job("AddedJob1", "Route12", "LP2")
        added_job["waferCount"] = 5
        pending_job = _job("AddedJob2", "Route12", "LP3")
        pending_job["waferCount"] = 5
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 3,
            "options": {},
            "recipes": [{"name": "R12", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
            "rounds": [
                {"currentTime": 0, "jobs": [initial_job]},
                {"currentTime": 100, "jobs": [added_job]},
                {"currentTime": 200, "jobs": [pending_job]},
            ],
        }
        result = execute_plan(plan)
        self.assertTrue(result["ok"])
        self.assertEqual(3, len(result["rounds"]))
        effective_time = result["rounds"][1]["effectiveTime"]
        self.assertGreater(effective_time, 100.0)
        self.assertLess(effective_time, result["rounds"][0]["segmentEnd"])
        self.assertEqual(100.0, result["rounds"][1]["scheduleStartTime"])
        self.assertEqual(effective_time, result["rounds"][1]["recoveryEndTime"])
        second_effective_time = result["rounds"][2]["effectiveTime"]
        # 若请求点恰好空闲可以立即重排；若仍有在途动作则只延到其收尾时刻。
        self.assertGreaterEqual(second_effective_time, 200.0)
        self.assertLess(second_effective_time, result["rounds"][1]["segmentEnd"])
        self.assertEqual(200.0, result["rounds"][2]["scheduleStartTime"])
        self.assertEqual(
            second_effective_time,
            result["rounds"][2]["recoveryEndTime"],
        )
        points = result["output"]["RecomputePoints"]
        point = points[0]
        self.assertEqual(100.0, point["Time"])
        self.assertEqual(effective_time, point["EffectiveTime"])
        self.assertEqual(100.0, point["ScheduleStartTime"])
        self.assertEqual(effective_time, point["RecoveryEndTime"])
        self.assertEqual(200.0, points[1]["Time"])
        self.assertEqual(second_effective_time, points[1]["EffectiveTime"])

        first_output = next(
            entry["Info"] for entry in result["reproductionLog"]
            if entry["Describe"] == "AlgOutput"
        )
        initial_move_ids = {int(move["MoveID"]) for move in first_output["MoveList"]}
        final_moves = result["output"]["MoveList"]
        # 双槽交换可能让请求时刻落在“门已开、下一动作尚未开始”的短间隙；
        # 此时没有单个 Move 横跨 100 s，但仍必须保留旧计划的稳定化收尾。
        self.assertTrue(any(
            int(move["MoveID"]) in initial_move_ids
            and (
                float(move["StartTime"]) < 100.0 < float(move["EndTime"])
                or 100.0 <= float(move["StartTime"]) < effective_time
            )
            and float(move["EndTime"]) <= effective_time + 1e-6
            for move in final_moves
        ))
        self.assertTrue(all(
            float(move["StartTime"]) >= 100.0 - 1e-6
            for move in final_moves
            if int(move["MoveID"]) not in initial_move_ids
        ))

    def test_pse300_numeric_format_reuses_and_renames_existing_device(self) -> None:
        """仅 0/0.0 表示不同的提取版 init 应复用测试集并采用 PSE300 文件名。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            original, created = import_workspace_device("legacy-recording.json", self.recording, store_path)
            renamed, renamed_created = import_workspace_device(PSE300_PATH.name, pse300, store_path)
            self.assertTrue(created)
            self.assertFalse(renamed_created)
            self.assertEqual(original["id"], renamed["id"])
            self.assertEqual(PSE300_PATH.name, renamed["name"])

    def test_failed_plan_keeps_input_data_reproduction_log(self) -> None:
        """后端校验失败时也应携带可重新提交的完整 Input 日志。"""
        plan = {"deviceName": "missing.json", "device": None, "roundCount": 1, "rounds": []}
        with self.assertRaises(LoggedPlanError) as context:
            execute_plan(plan)
        entries = context.exception.reproduction_log
        self.assertGreaterEqual(len(entries), 2)
        self.assertEqual("Input", entries[0]["Describe"])
        self.assertEqual(plan, load_plan_from_log(entries))
        self.assertEqual("AlgOutput", entries[-1]["Describe"])
        self.assertEqual("Error", entries[-1]["Info"]["Feedback"][0]["Level"])
        for entry in entries:
            self.assertEqual({"Time", "Describe", "SimTime", "Info"}, set(entry))
        with self.assertRaises(LoggedPlanError):
            execute_plan(load_plan_from_log(entries))

    def test_results_and_reproduction_logs_survive_memory_cache_reset(self) -> None:
        """甘特图结果与复现日志应写入专用目录，服务内存清空后仍可读取。"""
        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            with (
                patch.object(config_server, "RESULT_EXPORT_DIR", export_root / "results"),
                patch.object(config_server, "LOG_EXPORT_DIR", export_root / "logs"),
            ):
                result_id = config_server.save_result({"MoveList": [], "RecomputePoints": []})
                log_entries = [
                    {"Describe": "Input", "Info": {"value": 1}},
                    {"Describe": "AlgInit", "Info": {"value": 2}},
                    {"Describe": "AlgSchedule", "Info": {"value": 3}},
                    {"Describe": "AlgOutput", "Info": {"value": 4}},
                ]
                log_id = config_server.save_reproduction_log(log_entries)
                config_server._RESULTS.clear()
                config_server._REPRODUCTION_LOGS.clear()

                self.assertEqual([], config_server.read_result(result_id)["MoveList"])
                self.assertEqual("Input", config_server.read_reproduction_log(log_id)[0]["Describe"])
                self.assertTrue((export_root / "results" / f"{result_id}.json").is_file())
                log_path = export_root / "logs" / f"{log_id}.json"
                self.assertTrue(log_path.is_file())
                log_lines = log_path.read_text(encoding="utf-8").splitlines()
                self.assertEqual(len(log_entries) + 2, len(log_lines))
                self.assertEqual("[", log_lines[0])
                self.assertEqual("]", log_lines[-1])
                for index, entry in enumerate(log_entries, start=1):
                    self.assertEqual(entry, json.loads(log_lines[index].removesuffix(",")))

    def test_clear_exported_artifacts_removes_files_and_memory_cache(self) -> None:
        """清理导出数据应只删除结果和日志，并让旧链接立即失效。"""
        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            with (
                patch.object(config_server, "RESULT_EXPORT_DIR", export_root / "results"),
                patch.object(config_server, "LOG_EXPORT_DIR", export_root / "logs"),
            ):
                result_id = config_server.save_result({"MoveList": [], "RecomputePoints": []})
                log_id = config_server.save_reproduction_log([{"Describe": "Input", "Info": {}}])

                deleted = config_server.clear_exported_artifacts()

                self.assertEqual({"results": 1, "logs": 1}, deleted)
                self.assertIsNone(config_server.read_result(result_id))
                self.assertIsNone(config_server.read_reproduction_log(log_id))
                self.assertFalse((export_root / "results" / f"{result_id}.json").exists())
                self.assertFalse((export_root / "logs" / f"{log_id}.json").exists())

    def test_two_recomputes_merge_movelist_and_markers(self) -> None:
        """首次排程加两次重算应合并 MoveList，并保留两条重算线。"""
        plan = {
            "deviceName": DEVICE_PATH.name,
            "device": self.recording,
            "strategy": "heuristic",
            "roundCount": 3,
            "options": {},
            "recipes": [
                {"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}},
                {"name": "R34", "time": 8, "modules": "PM3,PM4", "weight": {}},
            ],
            "cleans": [],
            "routes": [
                _route("Route12", "PM1,PM2", "R12"),
                _route("Route34", "PM3,PM4", "R34"),
            ],
            "rounds": [
                {"currentTime": 0, "jobs": [_job("Initial", "Route12", "LP1")]},
                {"currentTime": 1000, "jobs": [_job("FirstRecompute", "Route12", "LP2")]},
                {"currentTime": 2000, "jobs": [_job("SecondRecompute", "Route34", "LP3")]},
            ],
        }
        result = execute_plan(plan)
        output = result["output"]
        self.assertTrue(result["ok"])
        self.assertEqual(3, len(result["rounds"]))
        self.assertEqual([1000.0, 2000.0], [item["Time"] for item in output["RecomputePoints"]])
        self.assertGreater(len(output["MoveList"]), 0)
        reproduction = result["reproductionLog"]
        descriptions = [entry["Describe"] for entry in reproduction]
        self.assertEqual("Input", descriptions[0])
        self.assertEqual(1, descriptions.count("AlgInit"))
        self.assertEqual(3, descriptions.count("AlgSchedule"))
        self.assertEqual(3, descriptions.count("AlgOutput"))
        self.assertEqual(2, descriptions.count("RecomputeControl"))
        self.assertIn("AlgUpdateMove", descriptions)
        self.assertTrue(all(set(entry) == {"Time", "Describe", "SimTime", "Info"} for entry in reproduction))

    def test_frontend_exposes_available_dual_actor_strategy(self) -> None:
        """双 Actor 清单、健康检查和介绍必须使用同一个稳定策略名。"""
        html = _editor_source()
        workspace_source = (
            ROOT
            / "realtime_scheduler"
            / "frontend"
            / "src"
            / "workspace_visualizer.ts"
        ).read_text(encoding="utf-8")
        metadata = config_server.read_algorithm_metadata()

        self.assertIn("renderOtherAlgorithmOptions(status.algorithms", html)
        self.assertIn("algorithm.strategy", html)
        self.assertIn('status.strategies?.["dual-actor-e2e"]', html)
        self.assertIn('"校验 / 双 Actor"', html)
        self.assertIn('id="visualRecommendationModel"', html)
        self.assertIn('双 Actor · 分域原子动作', html)
        self.assertIn('candidateGroups', workspace_source)
        self.assertIn('双 Actor · ${decision.replayEvaluated ? "回放重评估" : "原始模型决策"}', workspace_source)
        self.assertIn("Pick、Place、Swap", metadata["dual-actor-e2e"]["introduction"])
        self.assertEqual(
            {"name", "introduction"},
            set(metadata["dual-actor-e2e"]),
        )

    def test_algorithm_metadata_only_contains_name_and_introduction(self) -> None:
        """算法展示信息只保留名称和介绍，不再包含版本记录字段。"""
        metadata = config_server.read_algorithm_metadata()

        self.assertIn("端到端资源流", metadata["e2e-ctq"]["introduction"])
        self.assertEqual({"name", "introduction"}, set(metadata["e2e-ctq"]))


if __name__ == "__main__":
    unittest.main()
