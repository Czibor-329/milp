"""后端目录边界、依赖方向和单文件规模门禁。"""

from __future__ import annotations

import ast
from pathlib import Path
import subprocess
import sys

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
REMOVED_COMPATIBILITY_MODULES = (
    "algorithm_interface.py",
    "batch_service.py",
    "documentation.py",
    "move_validation.py",
    "plan_builder.py",
    "recompute_state.py",
    "replay_machine.py",
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


def test_repository_does_not_import_removed_compatibility_modules() -> None:
    """仓库 Python 代码不得继续依赖已经删除的根目录兼容模块。"""
    violations = []
    for source_root in (ROOT / "realtime_scheduler", ROOT / "scripts", ROOT / "tests"):
        for path in source_root.rglob("*.py"):
            if path == Path(__file__).resolve():
                continue
            source = path.read_text(encoding="utf-8-sig")
            for forbidden in FORBIDDEN_COMPATIBILITY_IMPORTS:
                if forbidden in source:
                    violations.append(f"{path.relative_to(ROOT)}: {forbidden}")
    assert violations == []


def test_root_compatibility_modules_are_removed() -> None:
    """根包只保留包标记，后端实现与入口必须位于 backend。"""
    package_root = ROOT / "realtime_scheduler"
    existing = [name for name in REMOVED_COMPATIBILITY_MODULES if (package_root / name).exists()]
    assert existing == []
    legacy_validation_modules = list((package_root / "validation").rglob("*.py"))
    assert legacy_validation_modules == []


def test_legacy_server_command_only_prints_migration_notice() -> None:
    """旧启动命令必须给出新命令提示，且不得重新成为后端兼容门面。"""
    legacy_entry = ROOT / "realtime_scheduler" / "server.py"
    source = legacy_entry.read_text(encoding="utf-8")
    tree = ast.parse(source)
    assert all(
        not (
            isinstance(node, (ast.Import, ast.ImportFrom))
            and "realtime_scheduler.backend" in ast.unparse(node)
        )
        for node in ast.walk(tree)
    )
    completed = subprocess.run(
        [sys.executable, "-X", "utf8", str(legacy_entry), "--open"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert completed.returncode == 0
    assert "已不再作为服务启动入口" in completed.stdout
    assert "python -m realtime_scheduler.backend.main --open" in completed.stdout


def test_workspace_modules_use_explicit_capability_names() -> None:
    """工作区不得恢复含糊的 service.py，也不得重新混合目录、交换和任务职责。"""
    workspace_root = BACKEND_ROOT / "workspace"
    assert not (workspace_root / "service.py").exists()
    assert (workspace_root / "catalog_service.py").is_file()
    assert (workspace_root / "exchange_service.py").is_file()
    assert (workspace_root / "transfer_jobs.py").is_file()


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


def test_validation_and_recompute_do_not_call_algorithm_repository_state() -> None:
    """输出校验和重算只能使用平台状态机，不能调用 alg 的状态或动作实现。"""
    checked_paths = (
        BACKEND_ROOT / "execution" / "algorithm_runtime.py",
        BACKEND_ROOT / "execution" / "run_state.py",
        BACKEND_ROOT / "execution" / "service.py",
        BACKEND_ROOT / "validation" / "move_validation_core.py",
    )
    forbidden = (
        "compile_problem",
        "StandardAlgorithmRuntime",
        "src.schedule.core",
        "from src.schedule",
    )
    violations = [
        f"{path.relative_to(ROOT)}: {item}"
        for path in checked_paths
        for item in forbidden
        if item in path.read_text(encoding="utf-8-sig")
    ]
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
