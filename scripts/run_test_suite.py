"""在隔离进程中运行平台、算法和前端测试套件。

父仓库与 ``alg`` 子仓库都包含顶层 ``tests`` 包，不能交给同一个 pytest
进程收集。本入口保持各自工作目录和导入路径，并在临时目录编译前端测试入口，
避免测试依赖仓库中可能过期的构建产物。
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Sequence


ROOT = Path(__file__).resolve().parents[1]
ALGORITHM_ROOT = ROOT / "alg"
FRONTEND_ROOT = ROOT / "realtime_scheduler" / "frontend"
AVAILABLE_SUITES = ("platform", "algorithm", "frontend")


def _run(command: Sequence[str], *, cwd: Path, environment: dict[str, str] | None = None) -> int:
    """运行一个测试子进程并原样返回退出码。"""
    print(f"\n=== {cwd.name}: {' '.join(command)} ===", flush=True)
    completed = subprocess.run(
        list(command),
        cwd=cwd,
        env=environment,
        check=False,
    )
    return int(completed.returncode)


def _python_environment(*paths: Path) -> dict[str, str]:
    """构造显式 Python 导入路径，不污染调用进程的模块缓存。"""
    environment = os.environ.copy()
    existing = environment.get("PYTHONPATH", "")
    entries = [str(path) for path in paths]
    if existing:
        entries.append(existing)
    environment["PYTHONPATH"] = os.pathsep.join(entries)
    environment["PYTHONUTF8"] = "1"
    return environment


def _run_pytest(
    suite_root: Path,
    *,
    collect_only: bool,
    fail_fast: bool,
    extra_arguments: Sequence[str],
) -> int:
    """在指定仓库根目录运行该仓库自己的 pytest 套件。"""
    command = [sys.executable, "-m", "pytest", "tests", "-q"]
    if collect_only:
        command.append("--collect-only")
    if fail_fast:
        command.append("-x")
    command.extend(extra_arguments)
    import_paths = (suite_root, ROOT) if suite_root == ALGORITHM_ROOT else (ROOT,)
    return _run(command, cwd=suite_root, environment=_python_environment(*import_paths))


def _run_frontend(*, fail_fast: bool) -> int:
    """检查 TypeScript，并从当前源码临时生成 Node 测试模块后运行测试。"""
    check_result = _run(["npm.cmd", "run", "check"], cwd=FRONTEND_ROOT)
    if check_result:
        return check_result

    esbuild = FRONTEND_ROOT / "node_modules" / ".bin" / "esbuild.cmd"
    if not esbuild.is_file():
        print("前端依赖缺失，请先在 realtime_scheduler/frontend 运行 npm install。")
        return 2
    with tempfile.TemporaryDirectory(prefix="ct-frontend-tests-") as directory:
        build_root = Path(directory)
        workspace_output = build_root / "workspace_visualizer_logic.js"
        route_output = build_root / "route_editor_logic.js"
        entries = (
            (FRONTEND_ROOT / "src" / "workspace_visualizer_test_entry.ts", workspace_output),
            (FRONTEND_ROOT / "src" / "route_editor_logic.ts", route_output),
        )
        for source, destination in entries:
            result = _run(
                [
                    str(esbuild),
                    str(source),
                    "--bundle",
                    "--format=cjs",
                    "--platform=node",
                    "--target=node18",
                    f"--outfile={destination}",
                ],
                cwd=FRONTEND_ROOT,
            )
            if result:
                return result

        environment = os.environ.copy()
        environment["CT_WORKSPACE_VISUALIZER_TEST_BUILD"] = str(workspace_output)
        environment["CT_ROUTE_EDITOR_TEST_BUILD"] = str(route_output)
        command = [
            "node",
            "--test",
            *[str(path) for path in sorted((ROOT / "tests").glob("frontend_*.test.js"))],
        ]
        if fail_fast:
            print("Node 测试运行器不提供可靠的 fail-fast；前端套件仍完整执行。")
        return _run(command, cwd=ROOT, environment=environment)


def main(argv: Sequence[str] | None = None) -> int:
    """解析套件选择，依次运行并汇总所有非零退出码。"""
    parser = argparse.ArgumentParser(description="运行隔离的 CT 调度测试套件")
    parser.add_argument(
        "--suite",
        action="append",
        choices=AVAILABLE_SUITES,
        help="只运行指定套件；可重复传入，默认运行全部",
    )
    parser.add_argument("--collect-only", action="store_true", help="仅收集 Python 测试")
    parser.add_argument("--fail-fast", action="store_true", help="每个套件首个失败后停止")
    parser.add_argument(
        "pytest_arguments",
        nargs=argparse.REMAINDER,
        help="传给 pytest 的附加参数，放在 -- 之后",
    )
    arguments = parser.parse_args(argv)
    suites = tuple(arguments.suite or AVAILABLE_SUITES)
    extra_arguments = list(arguments.pytest_arguments)
    if extra_arguments[:1] == ["--"]:
        extra_arguments = extra_arguments[1:]

    results: list[tuple[str, int]] = []
    for suite in suites:
        if suite == "platform":
            code = _run_pytest(
                ROOT,
                collect_only=arguments.collect_only,
                fail_fast=arguments.fail_fast,
                extra_arguments=extra_arguments,
            )
        elif suite == "algorithm":
            code = _run_pytest(
                ALGORITHM_ROOT,
                collect_only=arguments.collect_only,
                fail_fast=arguments.fail_fast,
                extra_arguments=extra_arguments,
            )
        elif arguments.collect_only:
            print("前端 Node 测试不支持 --collect-only，已跳过。")
            code = 0
        else:
            code = _run_frontend(fail_fast=arguments.fail_fast)
        results.append((suite, code))

    print("\n=== 测试套件汇总 ===")
    for suite, code in results:
        print(f"{suite}: {'通过' if code == 0 else f'失败（退出码 {code}）'}")
    return 0 if all(code == 0 for _, code in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
