"""CJob Cycle 补片、卸片与输入边界测试。"""

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

class CJobCycleUnitTests(unittest.TestCase):
    """验证不依赖算法执行的 CJobCycle 展开与事件时刻计算。"""

    def test_cycle_clone_keeps_fixed_load_port_and_uses_unique_task_id(self) -> None:
        """补片实例应固定使用模板 LP，同时获得独立 TaskID。"""
        template = {
            "taskId": "7",
            "loadPort": "LP2",
            "cjobCycle": 3,
            "pjobs": [{"jobName": "P1", "loadPort": "LP1", "waferCount": 2}],
        }

        cloned = config_server._cycle_cjob(template, 2)

        self.assertEqual("7-CYCLE-2", cloned["taskId"])
        self.assertEqual("LP2", cloned["loadPort"])
        self.assertEqual("LP2", cloned["pjobs"][0]["loadPort"])
        self.assertEqual(1, cloned["cjobCycle"])
        self.assertEqual("LP1", template["pjobs"][0]["loadPort"])

    def test_cycle_completion_uses_latest_move_of_every_material(self) -> None:
        """只有整盒所有物料的最后动作都完成后才允许补片。"""
        class FakeRuntime:
            """提供完工时刻计算所需的当前 update 和 MoveList。"""

            state_time = 0.0
            current_update = {"Materials": [
                {"ID": 11, "TaskID": "7"},
                {"ID": 12, "TaskID": "7"},
                {"ID": 99, "TaskID": "8"},
            ]}
            current_plan = [
                {"MatIDList": [11], "StartTime": 1.0, "EndTime": 5.0},
                {"MatIDList": [12], "StartTime": 2.0, "EndTime": 7.0},
                {"MatIDList": [11], "StartTime": 8.0, "EndTime": 12.5},
                {"MatIDList": [99], "StartTime": 1.0, "EndTime": 30.0},
            ]

        state = config_server.CJobCycleRuntime(
            template={}, load_port="LP2", total_cycles=3, current_cycle=1,
            current_task_id="7", configured_round=1,
        )

        self.assertAlmostEqual(
            12.5 + config_server.TIME_TOLERANCE * config_server.CJOB_CYCLE_EVENT_EPSILON_MULTIPLIER,
            config_server._cjob_cycle_completion_time(FakeRuntime(), state),
        )

    def test_cycle_completion_keeps_terminal_materials_across_recompute(self) -> None:
        """其他 CJob 触发重算后，已回 LP 的晶圆不必再次出现在新 MoveList。"""
        class FakeRuntime:
            """模拟一片已回 LP、另一片仍按新计划收尾的跨代状态。"""

            state_time = 20.0
            current_update = {"Materials": [
                {
                    "ID": 21,
                    "TaskID": "8",
                    "StepID": 2,
                    "CurrentModuleName": "LP2",
                    "Route": {"RouteSteps": [{
                        "StepID": 2,
                        "PostStepID": [],
                        "Visits": [{"StationName": "LP2"}],
                    }]},
                },
                {
                    "ID": 22,
                    "TaskID": "8",
                    "StepID": 1,
                    "CurrentModuleName": "ATR",
                    "Route": {"RouteSteps": [
                        {
                            "StepID": 1,
                            "PostStepID": [2],
                            "Visits": [{"StationName": "ATR"}],
                        },
                        {
                            "StepID": 2,
                            "PostStepID": [],
                            "Visits": [{"StationName": "LP2"}],
                        },
                    ]},
                },
            ]}
            current_plan = [
                {"MatIDList": [22], "StartTime": 20.0, "EndTime": 25.0},
            ]

        state = config_server.CJobCycleRuntime(
            template={}, load_port="LP2", total_cycles=3, current_cycle=1,
            current_task_id="8", configured_round=1,
        )

        self.assertAlmostEqual(
            25.0 + config_server.TIME_TOLERANCE * config_server.CJOB_CYCLE_EVENT_EPSILON_MULTIPLIER,
            config_server._cjob_cycle_completion_time(FakeRuntime(), state),
        )

    def test_cycle_completion_uses_process_job_products_not_dummy_task_id(self) -> None:
        """同 TaskID 的历史 Dummy 不得阻断 CJob 产品晶圆完工判定。"""
        class FakeRuntime:
            """模拟两片产品有完整计划、历史 Dummy 已回 DummyPort 的现场。"""

            state_time = 10.0
            current_update = {
                "Materials": [
                    {"ID": 1, "TaskID": "2", "SrcPortName": "LP2"},
                    {"ID": 2, "TaskID": "2", "SrcPortName": "LP2"},
                    {
                        "ID": 100001,
                        "TaskID": "2",
                        "SrcPortName": "DummyPort",
                        "CurrentModuleName": "DummyPort",
                    },
                ],
                "ProcessJobs": [{
                    "JobName": "2.C2.P1",
                    "TaskID": "2",
                    "MatList": [1, 2],
                }],
            }
            current_plan = [
                {"MatIDList": [1], "StartTime": 11.0, "EndTime": 20.0},
                {"MatIDList": [2], "StartTime": 12.0, "EndTime": 25.0},
            ]

        state = config_server.CJobCycleRuntime(
            template={}, load_port="LP2", total_cycles=4, current_cycle=1,
            current_task_id="2", configured_round=1,
        )

        self.assertAlmostEqual(
            25.0 + config_server.TIME_TOLERANCE * config_server.CJOB_CYCLE_EVENT_EPSILON_MULTIPLIER,
            config_server._cjob_cycle_completion_time(FakeRuntime(), state),
        )

    def test_cycle_event_only_checks_its_completed_load_port(self) -> None:
        """一个循环事件不得顺带清空其他尚未推进循环状态的 LoadPort。"""
        class FakeRuntime:
            """记录平台要求卸载的 LoadPort 范围。"""

            requested_load_ports = ()

            def release_completed_load_ports(self, load_port_names):
                """保存调用范围并模拟 LP1 已清空。"""
                self.requested_load_ports = tuple(load_port_names)
                return {1}, {"LP1"}

        runtime = FakeRuntime()
        build_state = BuildState(next_slot_by_port={"LP1": 25, "LP2": 25})

        released_ids, empty_ports = config_server._release_finished_load_ports(
            runtime,
            build_state,
            ["LP1"],
        )

        self.assertEqual(("LP1",), runtime.requested_load_ports)
        self.assertEqual({1}, released_ids)
        self.assertEqual({"LP1"}, empty_ports)
        self.assertEqual(0, build_state.next_slot_by_port["LP1"])
        self.assertEqual(25, build_state.next_slot_by_port["LP2"])

    def test_cycle_count_rejects_fractional_and_out_of_range_values(self) -> None:
        """循环数必须是 1~1000 的整数。"""
        for value in (0, 1001, 1.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                config_server._cjob_cycle_count({"cjobCycle": value})

    def test_cycle_completion_does_not_unload_dummy_with_same_task_id(self) -> None:
        """CJobCycle 卸载产品时必须保留临时绑定同一 TaskID 的 Dummy。"""
        completed_cycle = config_server.CJobCycleRuntime(
            template={},
            load_port="LP1",
            total_cycles=3,
            current_cycle=1,
            current_task_id="7",
            configured_round=1,
        )
        update = {
            "Materials": [
                {"ID": 1, "TaskID": "7", "SrcPortName": "LP1"},
                {
                    "ID": 100000,
                    "TaskID": "7",
                    "SrcPortName": "DummyPort",
                    "AccessiblePM": ["PM1"],
                },
                {"ID": 2, "TaskID": "8", "SrcPortName": "LP2"},
            ]
        }

        material_ids = config_server._completed_cycle_material_ids(
            update,
            [completed_cycle],
        )

        self.assertEqual({1}, material_ids)
