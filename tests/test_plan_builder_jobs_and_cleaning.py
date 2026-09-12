"""Job、Route、Clean 与 CJob Cycle 计划展开测试。"""

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
from realtime_scheduler.backend.algorithms.interface import discover_other_algorithms
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
from tests.support.plan_fixtures import DEVICE_PATH, job as _job, route as _route


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

class ConfigEditorPlanTests(unittest.TestCase):
    """Job、Route、Clean 与 CJob Cycle 计划展开。"""

    def setUp(self) -> None:
        """为每个案例提取同一份设备拓扑。"""
        self.recording = _device_recording()
        self.device = extract_init_data(self.recording)

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
        self.assertNotIn("Routes", update)
        runtime_route = update["ProcessJobs"][0]["OriginRoute"]
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
        # Material 内嵌 Route 是实例化 Route：首/末 LoadPort 步骤的 Visit 槽位
        # 必须等于该晶圆所在槽位，而不是 LP 展开的全部槽位。
        for material in update["Materials"]:
            expected_slot = [material["SlotID"]]
            route_steps = material["Route"]["RouteSteps"]
            self.assertEqual(expected_slot, route_steps[0]["Visits"][0]["SlotID"])
            self.assertEqual(expected_slot, route_steps[-1]["Visits"][0]["SlotID"])
        # Route 模板（OriginRoute）仍保留 LP 全部可用槽位。
        self.assertEqual(
            self.device["Stations"]["LP1"]["Slots"],
            update["ProcessJobs"][0]["OriginRoute"]["RouteSteps"][0]["Visits"][0]["SlotID"],
        )

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

    def test_cjob_cycle_replenishes_same_load_port_after_completion(self) -> None:
        """上一盒全部回到固定 LP 后，应清空端口并补入下一循环。"""
        plan = {
            "deviceName": DEVICE_PATH.name,
            "device": self.recording,
            "strategy": "heuristic",
            "roundCount": 1,
            "options": {},
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
            "rounds": [{
                "currentTime": 0,
                "cjobs": [{
                    "taskId": "1",
                    "loadPort": "LP1",
                    "cjobCycle": 3,
                    "jobType": "NormalLot",
                    "priority": 1,
                    "taskMode": "Smart",
                    "pjobs": [{
                        "jobName": "P1",
                        "routeRef": "Route12",
                        "loadPort": "LP1",
                        "waferCount": 2,
                        "priority": 1,
                    }],
                }],
            }],
        }

        result = execute_plan(plan)

        self.assertTrue(result["ok"])
        self.assertEqual(
            ["initial", "recompute", "recompute"],
            [row["kind"] for row in result["rounds"]],
        )
        self.assertTrue(all(
            row["trigger"] == "cjob-cycle" for row in result["rounds"][1:]
        ))
        self.assertEqual(2, len(result["output"]["RecomputePoints"]))
        self.assertIn("CJobCycle 补片", result["output"]["RecomputePoints"][0]["Reason"])
        self.assertEqual(
            {"1", "1-CYCLE-2", "1-CYCLE-3"},
            {
                str(material["TaskID"])
                for update in result["updates"]
                for material in update.get("Materials", [])
            },
        )
        self.assertTrue(any("清空 LoadPort=LP1" in line for line in result["logs"]))

    def test_parallel_cjob_cycles_replenish_in_completion_order(self) -> None:
        """双 LP 并发时，另一盒的已完成晶圆不得因跨代 MoveList 缺失而阻断补片。"""
        plan = {
            "deviceName": DEVICE_PATH.name,
            "device": self.recording,
            "strategy": "heuristic",
            "roundCount": 1,
            "options": {},
            "recipes": [{
                "name": "R12",
                "time": 8,
                "modules": "PM1,PM2",
                "weight": {},
            }],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
            "rounds": [{
                "currentTime": 0,
                "cjobs": [
                    {
                        "taskId": task_id,
                        "loadPort": load_port,
                        "cjobCycle": 3,
                        "jobType": "NormalLot",
                        "priority": 1,
                        "taskMode": "Smart",
                        "pjobs": [{
                            "jobName": "P1",
                            "routeRef": "Route12",
                            "loadPort": load_port,
                            "waferCount": 2,
                            "priority": 1,
                        }],
                    }
                    for task_id, load_port in (("1", "LP1"), ("2", "LP2"))
                ],
            }],
        }

        result = execute_plan(plan)

        self.assertTrue(result["ok"])
        self.assertEqual("passed", result["validation"])
        self.assertEqual(
            [
                "CJobCycle 补片（LP1 2/3）",
                "CJobCycle 补片（LP2 2/3）",
                "CJobCycle 补片（LP1 3/3）",
                "CJobCycle 补片（LP2 3/3）",
            ],
            [point["Reason"] for point in result["output"]["RecomputePoints"]],
        )

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
        built = build_route(route, {"R1": {"name": "R1", "time": 1}}, {}, {"ATR"})
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

    def test_aligner_route_step_always_requires_process(self) -> None:
        """AlgSchedule 中包含 Aligner 的 Step 必须下发 NeedProcess。"""
        route = {
            "name": "AlignRoute",
            "stages": [
                {"needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
                {"needProcess": False, "visits": [{"stationName": "ATR", "slotIds": "1"}]},
                {"needProcess": False, "visits": [{"stationName": "Aligner1", "slotIds": "1"}]},
                {"needProcess": False, "visits": [{"stationName": "ATR", "slotIds": "1"}]},
                {"needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
            ],
        }

        built = build_route(route, {}, {}, {"ATR"})

        self.assertTrue(built["RouteSteps"][2]["NeedProcess"])

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
        dummy = _runtime_clean({
            "name": "Dummy", "cleanType": "dummy", "recipeTime": 13,
            "triggerCount": 4,
        })
        dummy_wac = _runtime_clean({
            "name": "DummyWac", "cleanType": "dummywac",
            "recipeTime": 14, "wacRecipeTime": 6, "modules": ["PM1"],
        })

        self.assertEqual("PreClean", pre["taskName"])
        self.assertEqual("PostClean", post["taskName"])
        self.assertEqual(("ProcessCount", 7), (wac["stateVariable"], wac["lower"]))
        self.assertEqual(("WacClean", ["ProcessCount"]), (wac["taskName"], wac["updateStateVariables"]))
        self.assertEqual(("PreDummyClean", 4), (dummy["taskName"], dummy["materialCount"]))
        self.assertEqual(("PreWacClean", 2), (dummy_wac["taskName"], dummy_wac["materialCount"]))
        self.assertEqual(8, dummy_wac["dummyWaferCount"])
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

    def test_dummy_clean_adds_standard_dummy_count_recipe_weight(self) -> None:
        """Dummy 带片 Recipe 必须递增 CleanTask 声明的 DummyCount。"""
        recipes = [{
            "name": "DummyRecipe",
            "time": 20,
            "modules": ["PM1"],
            "weight": {},
        }]
        cleans = [{
            "name": "Dummy",
            "cleanType": "dummy",
            "recipeRef": "DummyRecipe",
            "modules": ["PM1"],
            "materialCount": 2,
            "updateStateVariables": ["IdleTime", "DummyCount"],
        }]

        built = build_process_recipes(recipes, [], cleans)

        self.assertEqual({"DummyCount": 1}, built[0]["Weight"])

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
        route["prePJobCleanRefs"] = ["DummyWac"]
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
        self.assertEqual(8, len(dummy_materials))
        self.assertEqual(list(range(1, 9)), [row["SlotID"] for row in dummy_materials])
        self.assertEqual(
            list(range(100000, 100008)),
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
        problem = compile_problem(self.device, update)
        dummy_wafers = [
            wafer for wafer in problem.wafers
            if wafer.pjob_name.startswith("dummy_")
        ]
        self.assertEqual(2, len(dummy_wafers))
        self.assertEqual(8, problem.dummy_wac[0].time)
        result = execute_plan(plan)
        self.assertTrue(result["ok"])
        self.assertGreater(result["makespan"], 0)

    def test_dummy_clean_uses_configured_dummy_port_inventory(self) -> None:
        """DummyPort 库存应采用独立配置，不与 Clean MaterialCount 混用。"""
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
                "materialCount": 2,
                "dummyWaferCount": 6,
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
        self.assertEqual(6, len(dummy_materials))
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

    def test_dummy_clean_defaults_dummy_port_inventory_to_eight(self) -> None:
        """旧 Clean 未配置 DummyPort 库存时应默认准备八片。"""
        route = _route("DummyReuseRoute", "PM1,PM2,PM3", "Recipe1")
        route["prePJobCleanRefs"] = ["DummyClean"]
        plan = {
            "device": self.device,
            "recipes": [{
                "name": "Recipe1", "time": 10,
                "modules": ["PM1", "PM2", "PM3"], "weight": {},
            }],
            "cleans": [{
                "name": "DummyClean", "cleanType": "dummy", "recipeTime": 6,
                "triggerCount": 2, "modules": ["PM1", "PM2", "PM3"],
            }],
            "routes": [route],
            "rounds": [{"currentTime": 0, "jobs": [_job("J1", "DummyReuseRoute", "LP1")]}],
        }

        update = build_round_update(
            plan,
            plan["rounds"][0],
            0.0,
            BuildState(),
        )
        dummy_materials = [
            material for material in update["Materials"]
            if material["CurrentModuleName"] == "DummyPort"
        ]
        self.assertEqual(8, len(dummy_materials))
