"""主控制台结果、甘特图与分析界面稳定契约测试。"""

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

class ConfigEditorFrontendTests(unittest.TestCase):
    """主控制台结果、甘特图与分析界面稳定契约。"""

    def setUp(self) -> None:
        """为每个案例提取同一份设备拓扑。"""
        self.recording = _device_recording()
        self.device = extract_init_data(self.recording)

    def test_editor_uses_persistent_route_table_and_step_drawer(self) -> None:
        """路径按工艺结构折叠，Route 和 Step 都提供 Clean 弹窗入口。"""
        html = _editor_source()
        drawer_editor = html.split("function renderStepDrawer()", 1)[1]
        drawer_editor = drawer_editor.split("/** 从测试的路径引用面板", 1)[0]
        self.assertIn('data-tab-target="schedule"', html)
        self.assertIn('data-tab-target="route"', html)
        self.assertNotIn('data-tab-target="clean"', html)
        self.assertIn("<span>结果分析</span>", html)
        self.assertIn("<span>路径配置</span>", html)
        self.assertNotIn('data-tab-view="clean"', html)
        self.assertRegex(html, r'class="frontend-version">V\d+\.\d+\.\d+</span>')
        self.assertIn('"residencyGuardSeconds"', html)
        self.assertIn('"maximumRobotHoldingSeconds"', html)
        self.assertIn('"maximumSystemResidenceCv"', html)
        self.assertIn("Validation / Multi-metric", html)
        self.assertIn('<span id="metricMovesLabel">Bottleneck Utilization</span>', html)
        self.assertNotIn('<span id="metricMovesLabel">Move 数</span>', html)
        self.assertNotIn("renderDatasetCatalog", html)
        self.assertNotIn("按加工工序数量分组，名称由候选腔室、加工时间和清洁配置自动生成。", html)
        self.assertNotIn("generate-example-routes", html)
        self.assertIn('id="stepDrawer"', html)
        self.assertIn('class="route-table"', html)
        self.assertIn('data-scope="stage-candidate-toggle"', html)
        self.assertNotIn('class="step-overview-card"', html)
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
        self.assertIn('if (key === "processTime") stageConfig.recipeTime = Number(value);', html)
        self.assertIn("width: min(560px, 100vw)", html)

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
        self.assertIn('data-scope="test-step"', html)
        self.assertNotIn('data-scope="visit-shared"', html)
        self.assertIn('src="/assets/config_editor.js?v=', html)
        self.assertIn('id="routeProcessFilter"', template)
        self.assertIn('id="routeParallelFilter"', template)
        self.assertNotIn('id="routeCleanFilter"', template)
        self.assertNotIn('id="routeResidencyFilter"', template)
        self.assertNotIn('id="routeQTimeFilter"', template)
        self.assertIn('data-compact-label="工序数"', template)
        self.assertIn('data-compact-label="并行腔室结构"', template)
        self.assertIn('class="route-flat-list"', html)
        self.assertIn("function renderRoutePropertyTags(route)", html)
        self.assertIn("No Buffer", html)
        self.assertIn("buffer-forced", html)
        self.assertIn("buffer-optional", html)
        self.assertNotIn('class="field route-group-field"', html)
        self.assertNotIn('class="field route-buffer-field"', html)
        self.assertIn('class="route-update-card"', template)
        self.assertNotIn("路径模板只配置加工腔室", template)
        self.assertNotIn('class="route-summary-secondary"', html)
        self.assertNotIn('data-action="toggle-route"', html)
        self.assertIn('data-action="save-route"', html)
        self.assertIn('data-action="cancel-route-edit"', html)
        self.assertIn('data-action="copy-route"', html)
        self.assertNotIn("候选腔室的可编辑参数不一致", html)
        self.assertNotIn("sync-stage-visits", html)
        self.assertIn("state.stationNames", html)
        self.assertNotIn('id="autoExportLog"', html)
        self.assertNotIn("自动下载日志", template)
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
        self.assertNotIn('id="pjobRouteCleanFilter"', page_template)
        self.assertNotIn('id="pjobRouteResidencyFilter"', page_template)
        self.assertNotIn('id="pjobRouteQTimeFilter"', page_template)
        self.assertNotIn('id="pjobRouteSearch"', page_template)
        self.assertIn("function routePickerCompactPath", html)
        self.assertIn("function routePickerProcessSummary", html)
        self.assertIn("function renderPJobRouteDialogGroup", html)
        self.assertIn("function routePickerSpecialCleanSummary", html)
        self.assertIn("function routePickerCleanSummary", html)
        self.assertIn("function routeHasTimeConstraint", html)
        self.assertIn("单次清洁带片数（MaterialCount）", html)
        self.assertIn("DEFAULT_DUMMY_WAFER_COUNT = 8", html)
        self.assertIn('id="cleanDummyWaferCountField" hidden', page_template)
        self.assertIn('id="cleanDummyWaferCount" type="number" min="1" step="1" value="8"', page_template)
        self.assertIn('cleanDummyWaferCountField").hidden = !isDummyClean', html)
        self.assertIn('cleanDummyWaferCount").disabled = !isDummyClean', html)
        self.assertNotIn("Dummy wafer 投入数量不可配置", page_template)
        self.assertIn("Buffer Option", html)
        self.assertNotIn('class="pjob-route-card-meta"', html)
        self.assertIn('class="route-summary-primary"', html)
        self.assertNotIn('class="route-summary-secondary"', html)
        picker_style = EDITOR_STYLE_PATH.read_text(encoding="utf-8")
        self.assertIn('.pjob-route-card-path { min-width: 0; flex: 1 1 auto;', picker_style)
        self.assertIn('.route-summary-primary strong { min-width: 0; flex: 1 1 auto;', picker_style)
        self.assertNotIn("<th>Material</th>", html)
        self.assertNotIn("晶圆数量 / LoadPort 槽位", html)
        self.assertNotIn("<th>TaskID</th>", html)
        self.assertNotIn("<th>FoupID</th>", html)
        self.assertNotIn("<th>Weight</th>", html)
        self.assertIn("renderRunFailureCard({", html)
        self.assertIn("EXPECTED_API_SCHEMA", html)
        self.assertIn('id="testGroupSelect"', html)
        self.assertIn('id="newGroupButton"', html)
        self.assertIn('id="batchRunButton"', html)
        self.assertNotIn('openParameterComparisonDialogButton', html)
        self.assertNotIn('parameterComparison', html)
        self.assertNotIn('运行对比测试', html)
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

    def test_gantt_reconstructs_recompute_log_prefix(self) -> None:
        """甘特图导入 input_data 日志时应拼回重算前已开始的动作。"""
        viewer = (
            ROOT / "realtime_scheduler" / "frontend" / "movelist_gantt_viewer.html"
        ).read_text(encoding="utf-8")

        self.assertIn("function reconstructInputLogMoveList(entries)", viewer)
        self.assertIn('describe === "AlgSchedule"', viewer)
        self.assertIn('describe === "RecomputeControl"', viewer)
        self.assertIn("start < cutoff - 1e-9", viewer)
        self.assertIn("function extractGanttPayload(payload)", viewer)

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
        self.assertIn(".batch-results { display: grid;", html)
        self.assertIn("grid-template-columns: repeat(4, minmax(0, 1fr))", html)
        self.assertIn("@container result-area (max-width: 1100px)", html)
        self.assertIn("@container result-area (max-width: 720px)", html)
        self.assertIn("@container result-area (max-width: 520px)", html)
        self.assertNotIn('class="terminal-section"', html)
        self.assertNotIn('id="clearButton"', html)
        self.assertIn('id="resultErrorPanel" role="alert" hidden', html)
        self.assertIn('id="resultErrorDetails" class="result-error-details" hidden', html)
        self.assertIn(".error-summary-line", html)
        self.assertIn("error-summary-meta", html)
        self.assertIn("[${escapeHtml(informationType)}", html)
        self.assertIn("deadlock?.message", html)
        self.assertNotIn("error-artifact-strip", html)
        self.assertIn("只有错误才显示", html)
        self.assertIn('class="batch-result-summary"', html)
        self.assertIn('class="batch-metric-tags"', html)
        self.assertIn("batch-metric-tag production", html)
        self.assertIn("batch-metric-tag recompute", html)
        self.assertNotIn('class="batch-result-metrics"', html)
        self.assertIn('const displayId = `t${index + 1}`', html)
        self.assertIn("产能 ${throughput.toFixed(1)} 片/h", html)
        self.assertIn("平均重算 ${hasMetrics && hasAverageRecomputeTime", html)
        self.assertNotIn("已跳过基线", html)
        self.assertIn('id="batchOverviewButton"', html)
        self.assertIn('id="testGroupAnalysisButton"', html)
        self.assertIn('id="testGroupAnalysisPanel"', html)
        self.assertIn("renderTestGroupAnalysis", html)
        self.assertIn("testGroupSummaryCsv", html)
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
        self.assertNotIn('id="searchTelemetryPanel"', topology_playback)
        self.assertNotIn('id="searchTelemetryPauseButton"', topology_playback)
        self.assertNotIn('id="searchTelemetryStepButton"', topology_playback)
        self.assertNotIn('id="searchTelemetryContinueButton"', topology_playback)
        self.assertIn('id="visualDeviceStage"', topology_playback)
        self.assertIn('id="visualDecisionLens"', topology_playback)
        self.assertNotIn('id="visualPauseOnDecisionChangeButton"', topology_playback)
        self.assertIn("合法动作空间", topology_playback)
        self.assertNotIn('id="visualTransitionButtons"', topology_playback)
        self.assertIn("decisionBoundaryTimes", workspace_source)
        self.assertIn("beginLiveSolve(", workspace_source)
        self.assertIn("updateLiveMoves(", workspace_source)
        self.assertIn("seekTo(time", workspace_source)
        self.assertIn("showPlayback()", workspace_source)
        self.assertNotIn("未来单轨迹", workspace_source)
        self.assertNotIn("调度结果分析", page)
        self.assertNotIn("按设备俯视拓扑回放晶圆流转", page)

        self.assertIn("showGroupAnalysis(markup: string)", workspace_source)
        self.assertIn("this.elements.content.hidden = true", workspace_source)
        self.assertIn("this.elements.groupAnalysis.hidden = false", workspace_source)
        self.assertIn("private showSingleResult()", workspace_source)
        self.assertIn("this.elements.groupAnalysis.hidden = true", workspace_source)
        self.assertIn("visualizationWorkspace.showGroupAnalysis(panelMarkup)", editor_source)
        self.assertIn('requestSearchControl(command)', editor_source)
        self.assertIn("async function controlSearchTelemetry(command)", editor_source)
        self.assertNotIn("visualizationWorkspace.beginLiveSolve", editor_source)
        self.assertIn("visualizationWorkspace.showPlayback()", editor_source)

        for removed_content in (
            "逐例对比 · 不做综合打分",
            "瓶颈候选出现频次",
            "如何解读",
            '<span class="eyebrow">测试组结果分析</span>',
        ):
            self.assertNotIn(removed_content, group_view_source)
        self.assertIn('class="group-analysis-table-head"', group_view_source)
        self.assertNotIn('<div class="group-kpi-grid">', group_view_source)
        self.assertIn('<section class="group-analysis-table-wrap">', group_view_source)
        self.assertIn("逐测试指标对比", group_view_source)
        self.assertNotIn("function throughputChart", group_view_source)
        self.assertIn("<th>产能</th>", group_view_source)
        self.assertNotIn("<th>吞吐</th>", group_view_source)
        self.assertNotIn("出站表现中位数", group_view_source)

    def test_schedule_analysis_is_server_owned_without_frontend_dependencies(self) -> None:
        """MoveList 与测试组统计应由后端统一计算，页面只能请求 API。"""
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
        self.assertNotIn("test_support", workspace_source)
