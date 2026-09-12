"""工作区引用同步、结果制品与完整场景回归测试。"""

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

class WorkspaceArtifactTests(unittest.TestCase):
    """工作区引用同步、结果制品与完整场景回归。"""

    def setUp(self) -> None:
        """为每个案例提取同一份设备拓扑。"""
        self.recording = _device_recording()
        self.device = extract_init_data(self.recording)

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
        """旧测试内没有拓扑差异的 Route 应在迁移时自动去重。"""
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

            self.assertEqual(["R1"], [route["name"] for route in loaded["routes"]])
            self.assertEqual(["C1"], [clean["name"] for clean in loaded["cleans"]])
            self.assertTrue(all("routes" not in test for test in loaded["tests"]))
            self.assertTrue(all("routeConfigs" in test and "cleans" in test for test in loaded["tests"]))
            migrated = json.loads(store_path.read_text(encoding="utf-8"))
            self.assertEqual(config_server.WORKSPACE_STORE_VERSION, migrated["version"])

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
                        {"jobType": "HigherLot", "priority": 8, "taskMode": "Concurrent", "cjobCycle": 2, "pjobs": [
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
            self.assertEqual(["LP2", "LP4"], [
                item["loadPort"] for item in second["cjobs"]
            ])
            self.assertEqual([1, 2], [item["cjobCycle"] for item in second["cjobs"]])
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
        pse300 = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": "PSE300",
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
        """重算任务应继续使用可选 PM 池，并同时利用 LA/LB。"""
        pse300 = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": "PSE300",
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
        added_process_modules = {
            move.get("ModuleName")
            for move in process_moves
            if "2.C1.P1" in (move.get("PJobName") or [])
        }
        added_loadlocks = {
            move.get("ModuleName")
            for move in result["output"]["MoveList"]
            if "2.C1.P1" in (move.get("PJobName") or [])
            and move.get("ModuleName") in {"LA", "LB"}
        }

        self.assertEqual({"PM1", "PM2"}, added_process_modules)
        self.assertEqual({"LA", "LB"}, added_loadlocks)

    def test_recompute_selects_relaxed_wip_fifo_by_real_movelist_makespan(self) -> None:
        """同 Route 续排应比较保留/解除在机片伪 FIFO，并按真实 MoveList 选择。"""
        pse300 = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": "PSE300",
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

        self.assertEqual("passed", result["validation"])
        self.assertLess(maximum_process_gap, 100.0)
        self.assertLess(result["makespan"], 861.0)

    def test_equal_normal_lots_run_concurrently_across_pm_pools(self) -> None:
        """同优 NormalLot 应并发，且各自只使用并覆盖声明的加工腔池。"""
        pse300 = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": "PSE300",
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
        self.assertEqual({"PM1", "PM2"}, {row[1] for row in process_by_job["1.C1.P1"]})
        self.assertEqual({"PM3", "PM4"}, {row[1] for row in process_by_job["2.C1.P1"]})
        self.assertTrue(any(
            max(c1[2], c2[2]) < min(c1[3], c2[3]) - 1e-6
            for c1 in process_by_job["1.C1.P1"]
            for c2 in process_by_job["2.C1.P1"]
        ))

    def test_pse300_arbitrary_recompute_uses_bounded_recovery_window(self) -> None:
        """任意时刻重算只保留在途收尾，新计划从请求时间带资源下界续排。"""
        pse300 = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        initial_job = _job("InitialJob", "Route12", "LP1")
        initial_job["waferCount"] = 5
        added_job = _job("AddedJob1", "Route12", "LP2")
        added_job["waferCount"] = 5
        pending_job = _job("AddedJob2", "Route12", "LP3")
        pending_job["waferCount"] = 5
        plan = {
            "deviceName": "PSE300",
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
        self.assertGreaterEqual(effective_time, 100.0)
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
        if effective_time > 100.0 + 1e-6:
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
        pse300 = copy.deepcopy(extract_init_data(self.recording))

        def replace_first_zero(value: object) -> bool:
            """把首个整数零改成浮点零，构造只含数字格式差异的等价设备。"""
            if isinstance(value, dict):
                for key, item in value.items():
                    if type(item) is int and item == 0:
                        value[key] = 0.0
                        return True
                    if replace_first_zero(item):
                        return True
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    if type(item) is int and item == 0:
                        value[index] = 0.0
                        return True
                    if replace_first_zero(item):
                        return True
            return False

        self.assertTrue(replace_first_zero(pse300))
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            original, created = import_workspace_device("legacy-recording.json", self.recording, store_path)
            renamed, renamed_created = import_workspace_device("PSE300", pse300, store_path)
            self.assertTrue(created)
            self.assertFalse(renamed_created)
            self.assertEqual(original["id"], renamed["id"])
            self.assertEqual("PSE300", renamed["name"])

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

    def test_expired_artifacts_are_removed_without_touching_recent_files(self) -> None:
        """自动清理只移除超过保留期的结果和日志，并同步淘汰对应缓存。"""
        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            with (
                patch.object(config_server, "RESULT_EXPORT_DIR", export_root / "results"),
                patch.object(config_server, "LOG_EXPORT_DIR", export_root / "logs"),
            ):
                old_result_id = config_server.save_result({"MoveList": [{"old": True}]})
                old_log_id = config_server.save_reproduction_log([{"Describe": "Input", "Info": {"old": True}}])
                recent_result_id = config_server.save_result({"MoveList": [{"recent": True}]})
                recent_log_id = config_server.save_reproduction_log([{"Describe": "Input", "Info": {"recent": True}}])
                current_time = time.time()
                expired_time = current_time - config_server.ARTIFACT_RETENTION_SECONDS - 1
                os.utime(export_root / "results" / f"{old_result_id}.json", (expired_time, expired_time))
                os.utime(export_root / "logs" / f"{old_log_id}.json", (expired_time, expired_time))

                deleted = config_server.remove_expired_artifacts(current_time=current_time)

                self.assertEqual({"results": 1, "logs": 1}, deleted)
                self.assertIsNone(config_server.read_result(old_result_id))
                self.assertIsNone(config_server.read_reproduction_log(old_log_id))
                self.assertIsNotNone(config_server.read_result(recent_result_id))
                self.assertIsNotNone(config_server.read_reproduction_log(recent_log_id))
                config_server.clear_exported_artifacts()

    def test_saving_new_artifact_automatically_removes_expired_files(self) -> None:
        """写入新结果时应自动执行过期制品清理，无需用户触发。"""
        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            with (
                patch.object(config_server, "RESULT_EXPORT_DIR", export_root / "results"),
                patch.object(config_server, "LOG_EXPORT_DIR", export_root / "logs"),
            ):
                old_result_id = config_server.save_result({"MoveList": [{"old": True}]})
                old_path = export_root / "results" / f"{old_result_id}.json"
                expired_time = time.time() - config_server.ARTIFACT_RETENTION_SECONDS - 1
                os.utime(old_path, (expired_time, expired_time))

                recent_result_id = config_server.save_result({"MoveList": [{"recent": True}]})

                self.assertFalse(old_path.exists())
                self.assertIsNone(config_server.read_result(old_result_id))
                self.assertIsNotNone(config_server.read_result(recent_result_id))
                config_server.clear_exported_artifacts()

    def test_frontend_uses_automatic_artifact_cleanup_and_readable_log_names(self) -> None:
        """结果区不再要求手动清理，复现日志下载名应包含测试名称。"""
        source = _editor_source()
        self.assertNotIn('id="clearExportsButton"', source)
        self.assertNotIn("function clearExportedArtifacts", source)
        self.assertIn("function readableLogFileName", source)
        self.assertIn("复现日志-${readableTestName}.json", source)

    def test_download_header_supports_readable_chinese_filename(self) -> None:
        """下载响应头应兼顾 ASCII 后备名称与 UTF-8 中文展示名称。"""
        disposition = config_server._download_content_disposition("批量复现日志-设备-回归.zip")
        self.assertIn('filename="download.zip"', disposition)
        self.assertIn("filename*=UTF-8''%E6%89%B9%E9%87%8F", disposition)

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
        self.assertGreater(descriptions.count("AlgUpdateMove"), 0)
        self.assertTrue(result["updates"][1]["MoveStates"])
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
        self.assertIn('"Validation / Dual Actor"', html)
        self.assertIn('data-action-status-filter value="enabled" checked', html)
        self.assertIn('data-action-status-filter value="physical-blocked" checked', html)
        self.assertIn('data-action-status-filter value="deadlock-blocked" checked', html)
        self.assertNotIn('id="visualRecommendationModel"', html)
        self.assertIn('actionDiagnostics', workspace_source)
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
