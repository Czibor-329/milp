"""重算失败输出与失败页面契约测试。"""

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

class RecomputeFailureOutputTests(unittest.TestCase):
    """验证重算算法异常时仍可供前端回放的部分结果。"""

    def test_recompute_algorithm_error_keeps_only_moves_not_in_remove_list(self) -> None:
        """重算调用报错时，诊断甘特图不得继续显示已取消的旧 Move。"""
        class FakeRuntime:
            """提供失败快照构造所需的最小运行时计划。"""

            current_plan = [
                {"MoveID": 11, "StartTime": 0, "EndTime": 5},
                {"MoveID": 12, "StartTime": 5, "EndTime": 10},
                {"MoveID": 13, "StartTime": 10, "EndTime": 15},
            ]

            @staticmethod
            def combined_output() -> dict:
                """模拟上一轮已拼接的甘特图数据。"""
                return {
                    "MoveList": [
                        {"MoveID": 9, "StartTime": -5, "EndTime": 0},
                        *FakeRuntime.current_plan,
                    ],
                    "Feedback": [{"Level": "Info", "Message": "首排完成"}],
                    "RecomputePoints": [],
                }

        output = config_server._build_recompute_failure_output(
            FakeRuntime(),
            {"RemoveList": [12, 13]},
            5.0,
            "第 2 轮新增 Job",
            RuntimeError("第二轮算法异常"),
        )

        self.assertEqual([9, 11, 12, 13], [move["MoveID"] for move in output["MoveList"]])
        self.assertFalse(output["MoveList"][1].get("RemovedByRecompute", False))
        self.assertTrue(output["MoveList"][2]["RemovedByRecompute"])
        self.assertTrue(output["MoveList"][3]["RemovedByRecompute"])
        self.assertEqual("algorithm-error", output["RecomputePoints"][-1]["Status"])
        self.assertEqual("第二轮算法异常", output["Feedback"][-1]["Message"])

    def test_gantt_viewer_marks_and_can_hide_removed_moves(self) -> None:
        """甘特图应浅色显示重算取消 Move，并提供独立开关。"""
        viewer = (
            ROOT / "realtime_scheduler" / "frontend" / "movelist_gantt_viewer.html"
        ).read_text(encoding="utf-8")

        self.assertIn('id="showRemovedMovesToggle"', viewer)
        self.assertIn("removedByRecompute: raw.RemovedByRecompute === true", viewer)
        self.assertIn("showRemovedMoves: true", viewer)
        self.assertIn("!rec.removedByRecompute", viewer)
        self.assertIn('fillOpacity = bar.rec.removedByRecompute ? "0.24" : "1"', viewer)

    def test_frontend_version_and_cache_keys_are_1_5_50(self) -> None:
        """前端显示版本、包版本和主资源缓存键必须同步。"""
        frontend_root = ROOT / "realtime_scheduler" / "frontend"
        template = (frontend_root / "config_editor.html").read_text(encoding="utf-8")
        package = json.loads((frontend_root / "package.json").read_text(encoding="utf-8"))
        package_lock = json.loads((frontend_root / "package-lock.json").read_text(encoding="utf-8"))

        self.assertEqual("1.5.50", package["version"])
        self.assertEqual("1.5.50", package_lock["version"])
        self.assertEqual("1.5.50", package_lock["packages"][""]["version"])
        self.assertIn('class="frontend-version">V1.5.50</span>', template)
        self.assertIn('/assets/config_editor.css?v=1.5.50', template)
        self.assertIn('/assets/config_editor.js?v=1.5.50', template)

    def test_single_run_failure_card_does_not_duplicate_validation_issue(self) -> None:
        """状态推进校验失败只展示一条完整错误，不再重复渲染问题列表。"""
        source = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn("const validationFailure = validationIssues.length > 0;", source)
        # 校验失败时摘要行直接显示完整 errorMessage，不叠加 meta 徽标。
        self.assertIn("const summaryMarkup = validationFailure", source)
        # 校验失败时不再渲染“MoveList 校验问题”重复分区。
        self.assertIn("const validationSection = validationFailure ? \"\" : (issueRows ?", source)

    def test_run_options_live_in_compact_settings_dialog(self) -> None:
        """运行选项应收纳到设置弹窗，齿轮按钮与状态灯保持紧凑。"""
        template = EDITOR_PATH.read_text(encoding="utf-8")
        style = EDITOR_STYLE_PATH.read_text(encoding="utf-8")

        self.assertIn('id="openRunSettingsButton"', template)
        self.assertIn('id="runSettingsDialog"', template)
        self.assertNotIn('id="compatibilityModeInput"', template)
        self.assertIn('id="hongYeCheckInput" type="checkbox" checked', template)
        self.assertIn('id="skipBaselineInput" type="checkbox" checked', template)
        self.assertNotIn('id="skipValidationInput"', template)
        self.assertIn("width: 34px; min-width: 34px; height: 34px", style)
        self.assertIn("top: 3px; right: 3px; width: 5px; height: 5px", style)

    def test_heuristic_weights_accept_arbitrary_decimal_values(self) -> None:
        """自定义权重应允许后端支持的任意有限小数，包括默认的 0.25。"""
        template = EDITOR_PATH.read_text(encoding="utf-8")

        weight_inputs = re.findall(r'<input data-heuristic-weight="[^"]+"[^>]*>', template)
        self.assertEqual(10, len(weight_inputs))
        self.assertTrue(all('type="number"' in item and 'step="any"' in item for item in weight_inputs))

    def test_batch_status_refresh_obeys_frontend_performance_limit(self) -> None:
        """批量状态最多每秒轮询一次，且明细未变化时不得重建整组 DOM。"""
        source = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn("const BATCH_STATUS_POLL_MILLISECONDS = 1000;", source)
        self.assertIn("window.setTimeout(resolve, BATCH_STATUS_POLL_MILLISECONDS)", source)
        self.assertIn("renderSignature !== lastBatchItemsRenderSignature", source)
        self.assertNotIn("window.setTimeout(resolve, 450)", source)

    def test_batch_selection_dialog_and_scrollable_ordered_cards_exist(self) -> None:
        """批量入口应支持范围、勾选和全量运行，结果卡片保持顺序并限制高度。"""
        template = EDITOR_PATH.read_text(encoding="utf-8")
        source = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")
        style = EDITOR_STYLE_PATH.read_text(encoding="utf-8")

        for element_id in (
            "batchTestSelectionDialog",
            "batchSelectionRangeStart",
            "batchSelectionRangeEnd",
            "batchSelectionList",
            "batchSelectionRunSelected",
            "batchSelectionRunAll",
        ):
            self.assertIn(f'id="{element_id}"', template)
        self.assertIn("testIds: tests.map(test => test.id)", source)
        self.assertIn("function orderedBatchItems(items)", source)
        self.assertIn("result.items = orderedBatchItems", source)
        self.assertRegex(style, r"\.batch-results\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto")

    def test_batch_result_card_opens_topology_playback(self) -> None:
        """批量结果卡片应提供回放入口，并在载入结果后进入拓扑回放。"""
        source = EDITOR_SCRIPT_PATH.read_text(encoding="utf-8")

        self.assertIn('data-playback-result="${escapeHtml(item.resultUrl)}"', source)
        self.assertIn(">回放</button>", source)
        self.assertNotIn(">工作台</button>", source)
        self.assertIn('event.target.closest("[data-playback-result]")', source)
        self.assertIn(".then(() => visualizationWorkspace.showPlayback())", source)

    def test_recompute_preparation_error_keeps_last_successful_movelist(self) -> None:
        """算法调用前的旧计划回放异常也应返回上一代诊断甘特图。"""
        previous_moves = [
            {"MoveID": 1, "StartTime": 0.0, "EndTime": 5.0},
            {"MoveID": 2, "StartTime": 5.0, "EndTime": 9.0},
        ]

        def fail_after_initial_output(_plan, reproduction):
            """模拟首排已保存、CJobCycle 旧计划回放随后失败。"""
            reproduction.add("AlgOutput", {"MoveList": previous_moves, "Feedback": []})
            raise ValueError("旧计划回放失败")

        with patch.object(config_server, "_execute_plan", side_effect=fail_after_initial_output):
            with self.assertRaises(LoggedPlanError) as context:
                execute_plan({"rounds": [], "hongYeCheck": False})

        failure_output = context.exception.failure_output
        self.assertIsNotNone(failure_output)
        self.assertEqual([1, 2], [move["MoveID"] for move in failure_output["MoveList"]])
        self.assertEqual("after-algorithm-output", failure_output["FailureContext"]["Stage"])
        self.assertEqual("旧计划回放失败", failure_output["Feedback"][-1]["Message"])

    def test_recompute_preparation_error_combines_committed_prefix_and_latest_plan(self) -> None:
        """跨代现场回放失败时，甘特图必须拼接旧代已启动前缀与最新计划。"""
        entries = [
            {
                "Describe": "AlgSchedule",
                "SimTime": 0.0,
                "Info": {},
            },
            {
                "Describe": "AlgOutput",
                "SimTime": 0.0,
                "Info": {
                    "MoveList": [
                        {"MoveID": 1, "StartTime": 0.0, "EndTime": 5.0},
                        {"MoveID": 2, "StartTime": 5.0, "EndTime": 12.0},
                        {"MoveID": 3, "StartTime": 12.0, "EndTime": 20.0},
                    ],
                    "Feedback": [],
                },
            },
            {
                "Describe": "RecomputeControl",
                "SimTime": 10.0,
                "Info": {
                    "RecomputeInfo": {
                        "CurrentTime": 10.0,
                        "EffectiveTime": 10.0,
                        "Reason": "CJobCycle 补片（LP1 2/4）",
                    }
                },
            },
            {
                "Describe": "AlgSchedule",
                "SimTime": 10.0,
                "Info": {},
            },
            {
                "Describe": "AlgOutput",
                "SimTime": 10.0,
                "Info": {
                    "MoveList": [
                        {"MoveID": 4, "StartTime": 10.0, "EndTime": 15.0},
                        {"MoveID": 5, "StartTime": 15.0, "EndTime": 25.0},
                    ],
                    "Feedback": [],
                },
            },
        ]

        output = config_server._build_prior_plan_failure_output(
            entries,
            RuntimeError("第二代现场回放失败"),
        )

        self.assertIsNotNone(output)
        self.assertEqual([1, 2, 4, 5], [move["MoveID"] for move in output["MoveList"]])
        self.assertEqual(0.0, output["MoveList"][0]["StartTime"])
        self.assertEqual(25.0, output["MoveList"][-1]["EndTime"])
        self.assertEqual(1, len(output["RecomputePoints"]))
        self.assertEqual(10.0, output["RecomputePoints"][0]["Time"])
        self.assertIn("CJobCycle 补片", output["RecomputePoints"][0]["Reason"])
