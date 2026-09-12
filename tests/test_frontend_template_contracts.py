"""主控制台模板、可访问性与稳定前端边界测试。"""

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

class FrontendTemplateTests(unittest.TestCase):
    """验证不依赖算法数据夹具的前端模板与样式约束。"""

    def test_documentation_uses_a_standalone_page(self) -> None:
        """代码仓库只保留跳转页，文档正文由独立文档仓库负责。"""
        editor_template = EDITOR_PATH.read_text(encoding="utf-8")
        documentation_template = DOCUMENTATION_PAGE_PATH.read_text(encoding="utf-8")
        editor_source = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn('href="/documentation.html"', editor_template)
        self.assertIn('target="_blank"', editor_template)
        self.assertNotIn('data-tab-target="documentation"', editor_template)
        self.assertNotIn('data-tab-view="documentation"', editor_template)
        self.assertNotIn("createDocumentationView", editor_source)
        self.assertIn('id="documentationLink"', documentation_template)
        self.assertIn("http://127.0.0.1:8766/documentation.html", documentation_template)
        self.assertIn("location.replace(target.href)", documentation_template)
        self.assertNotIn('id="documentationRoot"', documentation_template)

    def test_workspace_switches_do_not_enter_global_pending_lock(self) -> None:
        """设备和测试组切换不得用全局等待锁重绘并禁用自身选择器。"""
        source = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")
        template = EDITOR_PATH.read_text(encoding="utf-8")

        self.assertNotIn("runWorkspaceInteraction", source)
        self.assertNotIn("workspaceInteractionPending", source)
        self.assertNotIn('id="pageActivity"', template)
        self.assertIn(
            'document.getElementById("testGroupSelect").addEventListener("change", '
            'event => selectWorkspaceGroup(event.target.value)',
            source,
        )
        self.assertIn(
            'document.getElementById("deviceSelect").addEventListener("change", '
            'event => (async () => {',
            source,
        )

    def test_data_transfer_uses_accessible_background_progress(self) -> None:
        """设备交换必须显示后台阶段、上传进度并提供可访问进度语义。"""
        html = _editor_source()

        self.assertIn('/api/workspace-transfers', html)
        self.assertIn('request.upload.onprogress', html)
        self.assertIn('id="dataTransferProgressBar"', html)
        self.assertIn('role="progressbar"', html)
        self.assertIn('aria-valuenow="0"', html)
        self.assertIn('data-transfer-progress-track', html)

    def test_frontend_registers_stable_deadlock_catalog(self) -> None:
        """前端登记回放和 Machine 现场可证明的死锁，未知现场保留兜底。"""
        script = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        for code in ("DEADLOCK.SINGLE_ARM_TARGET_FULL", "DEADLOCK.DUAL_ARM_TARGETS_FULL",
                     "DLK-ROB-001", "DLK-ROB-002", "DLK-UNK",
                     "当前现场不满足这两种类型，算法报告无法继续调度。"):
            self.assertIn(code, script)
        for code in ("DLK-ROB-003", "DLK-ROB-004", "DLK-ROB-005", "DLK-ROB-006",
                     "DLK-LL-001", "DLK-CLN-001", "DLK-RES-001"):
            self.assertNotIn(code, script)
        self.assertIn("function deadlockDisplay", script)
        self.assertIn("visualizationWorkspace.getTerminalDeadlock()", script)

    def test_deadlock_feedback_keeps_partial_output(self) -> None:
        """MLP 格式的失败 Feedback 不得进入完整计划校验或丢失部分计划。"""
        output = {
            "MoveList": [{
                "MoveID": 7,
                "MoveType": 9,
                "StartTime": 1.0,
                "EndTime": 2.0,
            }],
            "Feedback": ["调度失败: Machine 无可执行搬运意图"],
        }
        reproduction = config_server.ReproductionLog()

        with self.assertRaises(LoggedPlanError) as context:
            config_server._raise_deadlock_feedback(
                output,
                reproduction,
                context="initial",
            )

        failure = context.exception.failure_output
        self.assertEqual([7], [move["MoveID"] for move in failure["MoveList"]])
        self.assertEqual(
            "DEADLOCK.UNCLASSIFIED",
            failure["FailureContext"]["Code"],
        )
        self.assertEqual(
            "未死锁，但算法认为死锁",
            failure["FailureContext"]["Message"],
        )
        self.assertEqual("AlgOutput", reproduction.entries[-1]["Describe"])

    def test_machine_diagnostic_classifies_cleaning_and_loadlock_deadlocks(self) -> None:
        """平台不再识别清洗冲突、Dummy 自阻塞、LoadLock 及资源等待环。"""
        held_cleaning = {
            "PendingMaterials": [
                {"MaterialID": 1, "Location": "VTR", "NextStations": ["PM4"]},
                {"MaterialID": 100000, "Location": "LB", "IsDummy": True,
                 "RemainingProcessStations": ["PM4"]},
            ],
            "HeldRobots": [{"Robot": "VTR", "Capacity": 2, "Hands": {"2": 1}}],
            "OccupiedStations": [],
            "LoadLocks": [{"Station": "LB"}],
        }
        self.assertIsNone(config_server._classify_deadlock_diagnostic(held_cleaning))

        cleaning_self_blocked = {
            "PendingMaterials": [{
                "MaterialID": 100000, "Location": "PM2", "IsDummy": True,
                "NextStations": ["PM2"],
            }],
        }
        self.assertIsNone(config_server._classify_deadlock_diagnostic(cleaning_self_blocked))

        loadlock_cycle = {
            "PendingMaterials": [
                {"MaterialID": 1, "Location": "LA", "NextStations": ["PM1"]},
                {"MaterialID": 2, "Location": "PM1", "NextStations": ["LA"]},
            ],
            "LoadLocks": [{"Station": "LA"}],
        }
        self.assertIsNone(config_server._classify_deadlock_diagnostic(loadlock_cycle))

        process_cycle = {
            "PendingMaterials": [
                {"MaterialID": 1, "Location": "PM1", "NextStations": ["PM2"]},
                {"MaterialID": 2, "Location": "PM2", "NextStations": ["PM1"]},
            ],
            "OccupiedStations": [
                {"Station": "PM1", "Full": True, "Occupied": {"1": 1}},
                {"Station": "PM2", "Full": True, "Occupied": {"1": 2}},
            ],
        }
        self.assertIsNone(config_server._classify_deadlock_diagnostic(process_cycle))

    def test_machine_diagnostic_only_recognizes_full_hands_and_all_targets(self) -> None:
        """平台仅保留两种满手满腔类型，双臂必须检查两片的全部目标。"""
        diagnostic = {
            "PendingMaterials": [
                {"MaterialID": 1, "NextStations": ["PM1"]},
                {"MaterialID": 2, "NextStations": ["PM2"]},
            ],
            "HeldRobots": [{"Robot": "R", "Capacity": 1, "Hands": {"1": 1}}],
            "OccupiedStations": [{"Station": "PM1", "Full": True}, {"Station": "PM2", "Full": True}],
        }
        self.assertEqual("DEADLOCK.SINGLE_ARM_TARGET_FULL", config_server._classify_deadlock_diagnostic(diagnostic)["Code"])
        diagnostic["HeldRobots"][0]["Capacity"] = 2
        self.assertIsNone(config_server._classify_deadlock_diagnostic(diagnostic))
        diagnostic["HeldRobots"][0]["Hands"]["2"] = 2
        self.assertEqual("DEADLOCK.DUAL_ARM_TARGETS_FULL", config_server._classify_deadlock_diagnostic(diagnostic)["Code"])
        diagnostic["OccupiedStations"][1]["Full"] = False
        self.assertIsNone(config_server._classify_deadlock_diagnostic(diagnostic))

    def test_single_run_responds_before_preflight_and_reuses_pending_save(self) -> None:
        """单测点击应立即显示准备状态，且运行前只保存确有修改的测试。"""
        script = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        preparing = script.index('button.textContent = "正在准备…"')
        health_check = script.index('fetch("/api/health"', preparing)
        self.assertLess(preparing, health_check)
        self.assertIn("if (state.dirty) await saveCurrentTest(true);", script)
        self.assertIn("if (testSaveInFlight)", script)
        self.assertIn("revision === testEditRevision", script)

    def test_groups_search_tree_options_without_external_summary(self) -> None:
        """Search Tree 外层只保留模型入口，搜索预算由生产后端统一管理。"""
        template = EDITOR_PATH.read_text(encoding="utf-8")
        style = EDITOR_STYLE_PATH.read_text(encoding="utf-8")
        script = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn("策略价值模型", template)
        self.assertIn("选择 Search Tree 模型", template)
        self.assertIn("search-tree-settings-card", style)
        self.assertNotIn("searchTreeBeamWidth", template)
        self.assertNotIn("searchTreeDecisionSeconds", template)
        self.assertNotIn("search-treeSettingsSummary", template)
        self.assertNotIn("renderSearchTreeSettingsSummary", script)

    def test_keeps_scheduling_configuration_while_switching_tests(self) -> None:
        """同一页面会话切换测试时，策略与 checkpoint 不应被测试集默认值覆盖。"""
        script = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn("sessionSchedulingConfiguration", script)
        self.assertIn("retainSessionSchedulingConfiguration", script)
        self.assertIn("state.strategy = sessionSchedulingConfiguration.strategy", script)
        self.assertIn("state.options = structuredClone(sessionSchedulingConfiguration.options)", script)

    def test_cjob_exposes_fixed_load_port_and_cycle_controls(self) -> None:
        """CJob 卡片应直接编辑固定 LoadPort 和补片循环数。"""
        script = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")
        style = EDITOR_STYLE_PATH.read_text(encoding="utf-8")

        self.assertIn('data-key="loadPort"', script)
        self.assertIn('data-key="cjobCycle"', script)
        self.assertIn('min="1" max="1000" step="1"', script)
        self.assertIn("occupiedLoadPorts", script)
        self.assertIn("repeat(3, minmax(110px, 1fr))", style)
