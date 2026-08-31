"""后端目录边界、依赖方向和单文件规模门禁。"""

from __future__ import annotations

import ast
from pathlib import Path

from realtime_scheduler.backend.execution import run_state


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "realtime_scheduler" / "backend"
MAXIMUM_RUNTIME_MODULE_LINES = 2000
FORBIDDEN_COMPATIBILITY_IMPORTS = (
    "realtime_scheduler.server",
    "from realtime_scheduler import server",
    "from realtime_scheduler.plan_builder",
    "from realtime_scheduler.recompute_state",
    "from realtime_scheduler.move_validation",
    "from realtime_scheduler.replay_machine",
    "from realtime_scheduler.documentation",
    "from realtime_scheduler.algorithm_interface",
    "from realtime_scheduler.batch_service",
)


def test_runtime_python_modules_stay_below_line_limit() -> None:
    """所有平台运行时 Python 文件必须保持在 2000 行硬上限内。"""
    violations = []
    for path in (ROOT / "realtime_scheduler").rglob("*.py"):
        if "frontend" in path.parts:
            continue
        line_count = len(path.read_text(encoding="utf-8-sig").splitlines())
        if line_count > MAXIMUM_RUNTIME_MODULE_LINES:
            violations.append(f"{path.relative_to(ROOT)}: {line_count}")
    assert violations == []


def test_backend_does_not_import_compatibility_layer() -> None:
    """真实后端不得反向依赖 server 或迁移前的兼容模块。"""
    violations = []
    for path in BACKEND_ROOT.rglob("*.py"):
        source = path.read_text(encoding="utf-8-sig")
        for forbidden in FORBIDDEN_COMPATIBILITY_IMPORTS:
            if forbidden in source:
                violations.append(f"{path.relative_to(ROOT)}: {forbidden}")
    assert violations == []


def test_backend_does_not_assemble_source_with_exec() -> None:
    """后端模块必须通过正常 import 协作，不能动态拼接源码绕过规模门禁。"""
    violations = []
    for path in BACKEND_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if node.func.id in {"exec", "compile"}:
                    violations.append(str(path.relative_to(ROOT)))
    assert violations == []


def test_single_run_status_has_timestamp_after_module_split() -> None:
    """带 clientRunId 的前端单次运行应能完成状态登记和事件更新时间写入。"""
    run_id = "split-regression-run"
    try:
        cancel_event = run_state._start_single_run(run_id, "heuristic", "拆分回归")
        assert cancel_event.is_set() is False

        with run_state._monitor_single_run(run_id, "heuristic"):
            run_state._report_run_event("init", "初始化", "completed")
        run_state._finish_single_run(run_id, "completed")

        snapshot = run_state._single_run_snapshot(run_id)
        assert snapshot is not None
        assert snapshot["createdAt"]
        assert snapshot["finishedAt"]
        assert snapshot["events"][0]["updatedAt"]
    finally:
        with run_state._SINGLE_RUNS_LOCK:
            run_state._SINGLE_RUNS.pop(run_id, None)
            run_state._SINGLE_RUN_CANCEL_EVENTS.pop(run_id, None)
