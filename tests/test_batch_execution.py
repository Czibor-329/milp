"""批量运行、校验配额、Baseline 与取消状态测试。"""

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

class BatchExecutionTests(unittest.TestCase):
    """批量运行、校验配额、Baseline 与取消状态。"""

    def setUp(self) -> None:
        """为每个案例提取同一份设备拓扑。"""
        self.recording = _device_recording()
        self.device = extract_init_data(self.recording)

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
                "device-batch", "回归", "e2e-ctq", {"seed": 9}, maximum_workers=2, hongye_check=False,
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

    def test_batch_test_selection_filters_but_preserves_workspace_order(self) -> None:
        """调用方即使倒序提交测试 ID，执行队列也必须保持名称自然顺序。"""
        tests = [
            {"id": "test-a", "name": "案例 A", "group": "回归"},
            {"id": "test-b", "name": "案例 B", "group": "回归"},
            {"id": "test-c", "name": "案例 C", "group": "回归"},
            {"id": "test-x", "name": "其他组", "group": "性能"},
        ]
        group, selected = config_server._workspace_group_tests(
            {"tests": tests},
            "回归",
            ["test-c", "test-a"],
        )

        self.assertEqual("回归", group)
        self.assertEqual(["test-a", "test-c"], [test["id"] for test in selected])
        _, naturally_ordered = config_server._workspace_group_tests(
            {"tests": [
                {"id": "id-10", "name": "test10", "group": "回归"},
                {"id": "id-2", "name": "test2", "group": "回归"},
                {"id": "id-1", "name": "test1", "group": "回归"},
            ]},
            "回归",
        )
        self.assertEqual(["test1", "test2", "test10"], [test["name"] for test in naturally_ordered])
        with self.assertRaisesRegex(ValueError, "不属于当前测试组"):
            config_server._workspace_group_tests(
                {"tests": tests},
                "回归",
                ["test-x"],
            )

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
            # Baseline 持久化会全量解析工作区数据集目录，本测试只验证批量
            # 编排状态机，不验证文件写入，mock 掉以避免慢 I/O 拖垮断言时限。
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
        ):
            initial = config_server.start_workspace_test_batch(
                "device-progress", "回归", "heuristic", {}, maximum_workers=1, hongye_check=False,
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

    def test_large_batch_uses_configured_isolated_algorithm_processes(self) -> None:
        """8 项批量任务应使用配置的隔离进程数，不能被算法会话锁串行化。"""
        device = {
            "id": "device-process-batch", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [],
            "tests": [
                {
                    "id": f"test-{index}", "name": f"案例 {index}", "group": "回归",
                    "roundCount": 1, "options": {},
                    "rounds": [{"currentTime": 0, "jobs": [_job(f"J{index}", "BatchRoute", "LP1")]}],
                }
                for index in range(8)
            ],
        }
        executor_options = []
        submitted_process_devices = []

        class ImmediateProcessExecutor:
            """在当前进程执行任务，以确定性验证生产并发路由。"""

            def __init__(self, **options):
                executor_options.append(options)

            def submit(self, function, *args):
                submitted_process_devices.append(args[0])
                future = Future()
                try:
                    future.set_result(function(*args))
                except Exception as error:  # noqa: BLE001
                    future.set_exception(error)
                return future

            def shutdown(self, **_options):
                return None

        def fake_execute(_plan):
            return {
                "ok": True, "totalElapsedMs": 10.0, "cpuTimeMs": 8.0,
                "makespan": 20.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server._batch_service, "ProcessPoolExecutor", ImmediateProcessExecutor),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
        ):
            result = config_server._execute_workspace_test_batch(
                device,
                device["tests"],
                "回归",
                "heuristic",
                {},
                hongye_check=False,
                skip_baseline=True,
                maximum_workers=8,
                use_process_isolation=True,
            )

        self.assertTrue(result["processIsolation"])
        self.assertEqual(8, result["workerCount"])
        self.assertEqual(8, result["succeeded"])
        self.assertEqual(8, executor_options[0]["max_workers"])
        self.assertTrue(all("tests" not in device for device in submitted_process_devices))

    def _parallel_worker_device(self, device_id: str, count: int = 3) -> dict:
        """构造并发配置测试共用的批量设备与测试组。"""
        return {
            "id": device_id, "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [],
            "tests": [
                {
                    "id": f"test-{index}", "name": f"案例 {index}", "group": "回归",
                    "roundCount": 1, "options": {},
                    "rounds": [{"currentTime": 0, "jobs": [_job(f"J{index}", "BatchRoute", "LP1")]}],
                }
                for index in range(1, count + 1)
            ],
        }

    def test_validation_limiter_is_shared_by_all_algorithm_workers(self) -> None:
        """同一批算法 worker 必须收到同一个 HongYe 校验闸门。"""
        device = self._parallel_worker_device("device-validation-limit")
        received_limiters = []

        def fake_execute(plan, **kwargs):
            received_limiters.append(kwargs.get("hongye_validation_limiter"))
            return {
                "ok": True, "totalElapsedMs": 10.0, "cpuTimeMs": 8.0,
                "makespan": 20.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
        ):
            result = config_server.run_workspace_test_batch(
                "device-validation-limit", "回归", "heuristic", {},
                maximum_workers=3, validation_workers=2, hongye_check=True,
            )

        self.assertEqual(3, result["workerCount"])
        self.assertEqual(2, result["validationWorkers"])
        self.assertEqual(3, result["succeeded"])
        self.assertIsNotNone(received_limiters[0])
        self.assertTrue(all(item is received_limiters[0] for item in received_limiters))

    def test_automatic_baseline_uses_same_validation_limiter(self) -> None:
        """外部策略补算 Baseline 时不得绕过配置的 HongYe 校验配额。"""
        device = self._parallel_worker_device("device-baseline-limit", count=1)
        received = []

        def fake_execute(plan, **kwargs):
            received.append((plan["strategy"], kwargs.get("hongye_validation_limiter")))
            return {
                "ok": True, "totalElapsedMs": 10.0, "cpuTimeMs": 8.0,
                "makespan": 20.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", side_effect=fake_execute),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
        ):
            result = config_server.run_workspace_test_batch(
                "device-baseline-limit", "回归", "other_alg:demo", {},
                maximum_workers=1, validation_workers=1, hongye_check=True,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(["heuristic", "other_alg:demo"], [row[0] for row in received])
        self.assertIs(received[0][1], received[1][1])

    def test_worker_configuration_is_clamped_to_server_limits(self) -> None:
        """后端必须独立限制算法与校验并行数，不能信任 HTTP 输入。"""
        device = self._parallel_worker_device("device-worker-clamp", count=31)
        with (
            patch.object(config_server, "get_workspace_device", return_value=device),
            patch.object(config_server, "execute_plan", return_value={
                "ok": True, "totalElapsedMs": 10.0, "cpuTimeMs": 8.0,
                "makespan": 20.0, "moveCount": 3, "validation": "passed",
                "output": {"MoveList": []}, "reproductionLog": [],
            }),
            patch.object(config_server, "save_result", return_value="result-id"),
            patch.object(config_server, "save_reproduction_log", return_value="log-id"),
            patch.object(config_server, "_persist_workspace_baseline", return_value=True),
        ):
            result = config_server.run_workspace_test_batch(
                "device-worker-clamp", "回归", "heuristic", {},
                maximum_workers=99, validation_workers=99, hongye_check=True,
            )
        self.assertEqual(30, result["workerCount"])
        self.assertEqual(15, result["validationWorkers"])

    def test_skip_baseline_failure_does_not_persist_from_parallel_worker(self) -> None:
        """跳过 Baseline 后算法失败也不得抢占工作区写锁保存失败基线。"""
        test_case = {
            "id": "test-failed-skip", "name": "跳过失败基线", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-failed-skip", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }
        with (
            patch.object(config_server, "execute_plan", side_effect=RuntimeError("算法失败")),
            patch.object(config_server, "_persist_workspace_baseline") as persist,
        ):
            result, baseline, error = config_server._execute_workspace_test_with_baseline(
                device,
                test_case,
                "heuristic",
                {},
                skip_baseline=True,
                hongye_check=False,
            )

        self.assertIsNone(result)
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual("skipped", baseline["status"])
        persist.assert_not_called()

    def test_batch_compatibility_mode_reaches_selected_plan(self) -> None:
        """批量执行链路应将显式关闭的兼容模式写入最终执行计划。"""
        test_case = {
            "id": "test-compatibility-mode", "name": "兼容模式链路", "group": "回归",
            "roundCount": 1, "options": {},
            "rounds": [{"currentTime": 0, "jobs": [_job("A", "BatchRoute", "LP1")]}],
        }
        device = {
            "id": "device-compatibility-mode", "name": "fixture.json", "device": self.device,
            "routes": [_route("BatchRoute", "PM1,PM2", "BatchRecipe")],
            "cleans": [], "tests": [test_case],
        }
        captured_plans = []

        def fake_execute(plan):
            captured_plans.append(plan)
            return {
                "ok": True, "totalElapsedMs": 1.0, "makespan": 2.0,
                "moveCount": 0, "validation": "skipped",
                "output": {"MoveList": []}, "reproductionLog": [],
            }

        with patch.object(config_server, "execute_plan", side_effect=fake_execute):
            result, _baseline, error = config_server._execute_workspace_test_with_baseline(
                device, test_case, "heuristic", {},
                skip_baseline=True, hongye_check=False, compatibility_mode=False,
            )

        self.assertIsNone(error)
        self.assertIsNotNone(result)
        self.assertEqual(1, len(captured_plans))
        self.assertFalse(captured_plans[0]["compatibilityMode"])

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

        self.assertRegex(filename, r"^批量复现日志-fixture-回归-\d{8}-\d{6}\.zip$")
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
                "device-baseline", "回归", "e2e-ctq", {}, maximum_workers=1, hongye_check=False,
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
                "状态推进失败|MVL-STATE-UNKNOWN|无效动作",
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
                "device-external-invalid", "回归", "other_alg:demo", {}, maximum_workers=1, hongye_check=False,
            )

        item = result["items"][0]
        self.assertEqual("failed", item["status"])
        self.assertTrue(item["metricsAvailable"])
        self.assertEqual("failed", item["validation"])
        self.assertEqual(80.0, item["makespan"])
        self.assertEqual(20.0, item["improvementPercent"])
        self.assertEqual("/api/results/result-id", item["resultUrl"])

    def test_legacy_skip_validation_flag_cannot_bypass_move_list_checks(self) -> None:
        """遗留请求字段不能绕过平台状态推进校验。"""
        pse300 = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": "PSE300",
            "device": pse300,
            "strategy": "heuristic",
            "hongYeCheck": False,
            "roundCount": 1,
            "options": {},
            "recipes": [{"name": "R1", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("R1", "PM1,PM2", "R1")],
            "rounds": [{"currentTime": 0, "cjobs": [{"taskId": "1", "jobType": "NormalLot", "priority": 1, "taskMode": "Smart", "pjobs": [
                {"jobName": "P1", "routeRef": "R1", "loadPort": "LP1", "waferCount": 2, "priority": 1},
            ]}]}],
        }
        with patch.object(config_server, "validate_move_list", return_value=["[MVL-TEST] 无效动作"]):
            with self.assertRaisesRegex(LoggedPlanError, "状态推进失败\\|MVL-TEST\\|无效动作"):
                execute_plan({**plan, "skipValidation": True})

    def test_batch_plan_does_not_emit_legacy_skip_validation_flag(self) -> None:
        """批量计划不再生成跳过平台状态推进校验的配置。"""
        pse300 = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
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
        self.assertTrue(default_plan["compatibilityMode"])
        explicit_incompatible_plan = config_server.build_workspace_batch_plan(
            device, test_case, "heuristic", {}, compatibility_mode=False,
        )
        self.assertFalse(explicit_incompatible_plan["compatibilityMode"])

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
                skip_baseline=True, maximum_workers=1, hongye_check=False,
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
                "device-refresh", "回归", "heuristic", {}, maximum_workers=1, hongye_check=False,
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
                "device-failed-base", "回归", "e2e-ctq", {}, maximum_workers=1, hongye_check=False,
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
                "device-cancel", "回归", "heuristic", {}, maximum_workers=1, hongye_check=False,
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

    def test_batch_run_api_forwards_algorithm_and_validation_workers(self) -> None:
        """批量 HTTP 入口必须把两个独立并发配置传给后台任务。"""
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)
        self.assertIn('payload.get("maximumWorkers", DEFAULT_BATCH_WORKERS)', post_source)
        self.assertIn('payload.get("validationWorkers", DEFAULT_VALIDATION_WORKERS)', post_source)

    def test_run_settings_preferences_have_get_and_put_routes(self) -> None:
        """运行与分析习惯必须通过各自偏好 API 读写同一本地数据。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        put_source = inspect.getsource(config_server.ConfigEditorHandler.do_PUT)
        self.assertIn('path == "/api/preferences/run-settings"', get_source)
        self.assertIn("read_run_preferences()", get_source)
        self.assertIn('path == "/api/preferences/run-settings"', put_source)
        self.assertIn("update_run_preferences", put_source)
        self.assertIn('path == "/api/preferences/analysis-settings"', get_source)
        self.assertIn("read_analysis_preferences()", get_source)
        self.assertIn('path == "/api/preferences/analysis-settings"', put_source)
        self.assertIn("update_analysis_preferences", put_source)

    def test_single_external_failure_keeps_elapsed_time_and_baseline_visible(self) -> None:
        """单次外部算法失败也应返回并绘制耗时及 Baseline 对比。"""
        html = _editor_source()
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)

        self.assertIn('"metricsAvailable": True', post_source)
        self.assertIn('strategy.casefold().startswith("other_alg:")', post_source)
        self.assertIn("showFailedResultMetrics(runResult)", html)
        self.assertIn('setResultMetric("Time", "失败前耗时"', html)
        self.assertIn('setResultMetric("Makespan", "Makespan / Baseline"', html)

    def test_single_failure_result_keeps_machine_replay_context(self) -> None:
        """单次算法失败的部分 MoveList 应保存计划与 update，供拓扑回放。"""
        error = LoggedPlanError(
            "Machine 死锁",
            [{
                "Describe": "AlgSchedule",
                "Info": {"CurrentTime": 0, "Materials": [{"ID": 101}]},
            }],
            failure_output={
                "MoveList": [{"MoveID": 1, "StartTime": 0, "EndTime": 8}],
                "Feedback": ["调度失败: Machine 无可执行搬运意图"],
                "FailureContext": {
                    "Stage": "algorithm-deadlock",
                    "Code": "DEADLOCK.NO_EXECUTABLE_ACTION",
                    "Category": "no-executable-action",
                    "Message": "Machine 无可执行搬运意图",
                },
            },
        )
        replay_plan = {"strategy": "heuristic", "rounds": [{"currentTime": 0}]}
        saved_artifacts = []

        def fake_save_result(artifact):
            """捕获单次失败结果文件，避免写入真实导出目录。"""
            saved_artifacts.append(artifact)
            return "deadlock-result"

        with patch.object(config_server, "save_result", side_effect=fake_save_result):
            fields = config_server._logged_failure_result_fields(
                error,
                replay_plan=replay_plan,
            )

        self.assertEqual("/api/results/deadlock-result", fields["resultUrl"])
        self.assertEqual(1, fields["moveCount"])
        self.assertEqual(
            "DEADLOCK.NO_EXECUTABLE_ACTION",
            fields["deadlock"]["Code"],
        )
        artifact = saved_artifacts[0]
        self.assertEqual("heuristic", artifact["ReplayContext"]["plan"]["strategy"])
        self.assertEqual(101, artifact["ReplayContext"]["updates"][0]["Materials"][0]["ID"])
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)
        self.assertIn("replay_plan=replay_plan", post_source)

        editor_source = _editor_source()
        self.assertLess(
            editor_source.index("prepareWorkspaceView(runResult)"),
            editor_source.index("if (!response.ok || !runResult.ok)"),
        )
