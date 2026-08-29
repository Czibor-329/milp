"""在独立服务进程中运行调度平台 HTTP 性能预算。

脚本生成确定性的 v7 数据目录，通过 ``CT_DATA_DIR`` 启动隔离服务，测量冷启动、
健康检查、设备列表、设备概览、单测试读取和保存，以及单测试与整组测试删除。报告
同时保存 P50、P95、最大值与响应字节数；``--enforce`` 用于固定 Windows 环境中的
发布门禁。
"""

from __future__ import annotations

import argparse
import ctypes
from concurrent.futures import ThreadPoolExecutor
import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.error import URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.performance.fixture_factory import (  # noqa: E402
    generate_v5_workspace_file,
    generate_v7_dataset,
    load_performance_profiles,
)


DEFAULT_PROFILE_PATH = ROOT / "performance" / "profiles.json"
DEFAULT_BUDGET_PATH = ROOT / "performance" / "budgets.json"
DEFAULT_REPORT_PATH = ROOT / "output" / "performance-report.json"


class _WindowsProcessMemoryCounters(ctypes.Structure):
    """映射 Windows ``PROCESS_MEMORY_COUNTERS`` 的稳定前缀字段。"""

    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def _process_peak_rss_bytes(process_id: int) -> int | None:
    """读取子进程峰值常驻内存；平台不支持时返回 ``None``。"""
    if os.name == "nt":
        process_query_information = 0x0400
        process_vm_read = 0x0010
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(
            process_query_information | process_vm_read,
            False,
            process_id,
        )
        if not handle:
            return None
        try:
            counters = _WindowsProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            if not ctypes.windll.psapi.GetProcessMemoryInfo(
                handle,
                ctypes.byref(counters),
                counters.cb,
            ):
                return None
            return int(counters.PeakWorkingSetSize)
        finally:
            kernel32.CloseHandle(handle)
    status_path = Path(f"/proc/{process_id}/status")
    if status_path.is_file():
        for line in status_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) * 1024
    return None


def _percentile(values: list[float], quantile: float) -> float:
    """使用线性插值返回有序样本的指定分位数。"""
    if not values:
        raise ValueError("性能样本不能为空")
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _free_local_port() -> int:
    """申请一个当前可用的本机 TCP 端口。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _request_json(
    url: str,
    *,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
    timeout: float = 10.0,
) -> tuple[dict[str, Any], int]:
    """发送 JSON 请求并返回解析结果和响应字节数。"""
    content = None
    headers = {}
    if payload is not None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = Request(url, data=content, headers=headers, method=method)
    with urlopen(request, timeout=timeout) as response:
        body = response.read()
    return json.loads(body.decode("utf-8")), len(body)


def _read_observability_headers(url: str) -> dict[str, str]:
    """读取服务性能响应头，验证线上诊断信号没有被移除。"""
    with urlopen(url, timeout=10.0) as response:
        response.read()
        return {
            "serverTiming": str(response.headers.get("Server-Timing") or ""),
            "responseBytes": str(response.headers.get("X-Response-Bytes") or ""),
        }


def _measure(
    operation: Callable[[], tuple[dict[str, Any], int]],
    *,
    warmup_count: int,
    sample_count: int,
) -> dict[str, Any]:
    """预热后重复执行操作，汇总耗时与响应大小。"""
    for _ in range(warmup_count):
        operation()
    durations: list[float] = []
    response_sizes: list[int] = []
    for _ in range(sample_count):
        started = time.perf_counter()
        _, response_bytes = operation()
        durations.append((time.perf_counter() - started) * 1000.0)
        response_sizes.append(response_bytes)
    return {
        "sampleCount": sample_count,
        "p50Ms": statistics.median(durations),
        "p95Ms": _percentile(durations, 0.95),
        "maximumMs": max(durations),
        "medianResponseBytes": statistics.median(response_sizes),
        "maximumResponseBytes": max(response_sizes),
    }


def _wait_until_ready(base_url: str, process: subprocess.Popen[Any]) -> float:
    """等待隔离服务健康，并返回从进程启动到首次成功的毫秒数。"""
    started = time.perf_counter()
    deadline = started + 20.0
    last_error = ""
    while time.perf_counter() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"性能测试服务提前退出，退出码 {process.returncode}")
        try:
            payload, _ = _request_json(f"{base_url}/api/health", timeout=1.0)
            if payload.get("ok"):
                return (time.perf_counter() - started) * 1000.0
        except (OSError, URLError, ValueError) as error:
            last_error = str(error)
        time.sleep(0.05)
    raise TimeoutError(f"性能测试服务启动超时：{last_error}")


def _evaluate_absolute_budgets(
    metrics: Mapping[str, Mapping[str, Any]],
    startup_ms: float,
    budgets: Mapping[str, Any],
    *,
    migration: bool,
) -> list[dict[str, Any]]:
    """根据试运行绝对预算生成逐项通过结果。"""
    absolute = budgets["absoluteMilliseconds"]
    startup_budget_name = (
        "migrationV5MediumP95" if migration else "startupWithoutMigrationP95"
    )
    cases = [
        (startup_budget_name, startup_ms, absolute[startup_budget_name]),
        ("healthWarmP95", metrics["health"]["p95Ms"], absolute["healthWarmP95"]),
        ("workspaceListP95", metrics["workspaceList"]["p95Ms"], absolute["workspaceListP95"]),
        ("deviceOverviewP95", metrics["deviceOverview"]["p95Ms"], absolute["deviceOverviewP95"]),
        ("singleTestReadP95", metrics["singleTestRead"]["p95Ms"], absolute["singleTestReadP95"]),
        (
            "singleTestDeleteMaximum",
            metrics["singleTestDelete"]["maximumMs"],
            absolute["singleTestDeleteMaximum"],
        ),
        (
            "testGroupDeleteMaximum",
            metrics["testGroupDelete"]["maximumMs"],
            absolute["testGroupDeleteMaximum"],
        ),
        ("singleTestSaveP95", metrics["singleTestSave"]["p95Ms"], absolute["singleTestSaveP95"]),
    ]
    optional_metrics = {
        "concurrentRead": "concurrentReadP95",
        "moveAnalysis10000": "moveAnalysis10000P95",
        "moveAnalysis50000": "moveAnalysis50000P95",
        "moveAnalysis100000": "moveAnalysis100000P95",
    }
    for metric_name, budget_name in optional_metrics.items():
        if metric_name in metrics:
            cases.append((budget_name, metrics[metric_name]["p95Ms"], absolute[budget_name]))
    return [
        {
            "id": name,
            "actualMs": actual,
            "budgetMs": budget,
            "passed": actual <= budget,
        }
        for name, actual, budget in cases
    ]


def _evaluate_relative_budgets(
    current: Mapping[str, Any],
    baseline: Mapping[str, Any],
    budgets: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """比较同场景基准报告，同时应用比例和绝对差值降噪。"""
    if current.get("profile") != baseline.get("profile"):
        raise ValueError("相对性能基准必须使用相同 profile")
    rules = budgets["relativeRegression"]
    evaluations: list[dict[str, Any]] = []
    for operation, current_metric in current["metrics"].items():
        baseline_metric = baseline["metrics"].get(operation)
        if not isinstance(baseline_metric, Mapping):
            raise ValueError(f"基准报告缺少指标：{operation}")
        for field, percent_key, minimum_key in (
            ("p50Ms", "medianPercent", "medianMinimumMilliseconds"),
            ("p95Ms", "p95Percent", "p95MinimumMilliseconds"),
        ):
            actual = float(current_metric[field])
            expected = float(baseline_metric[field])
            delta = actual - expected
            threshold_percent = float(rules[percent_key])
            regression_percent = (
                delta / expected * 100.0 if expected > 0 else (100.0 if delta > 0 else 0.0)
            )
            blocked = (
                delta > float(rules[minimum_key])
                and regression_percent > threshold_percent
            )
            evaluations.append({
                "id": f"{operation}.{field}",
                "baseline": expected,
                "actual": actual,
                "delta": delta,
                "regressionPercent": regression_percent,
                "passed": not blocked,
            })
        actual_bytes = float(current_metric["maximumResponseBytes"])
        expected_bytes = float(baseline_metric["maximumResponseBytes"])
        byte_regression = (
            (actual_bytes - expected_bytes) / expected_bytes * 100.0
            if expected_bytes > 0 else (100.0 if actual_bytes > 0 else 0.0)
        )
        evaluations.append({
            "id": f"{operation}.maximumResponseBytes",
            "baseline": expected_bytes,
            "actual": actual_bytes,
            "regressionPercent": byte_regression,
            "passed": byte_regression <= float(rules["responseBytesPercent"]),
        })
    current_memory = current.get("peakRssBytes")
    baseline_memory = baseline.get("peakRssBytes")
    if isinstance(current_memory, (int, float)) and isinstance(baseline_memory, (int, float)):
        memory_regression = (
            (float(current_memory) - float(baseline_memory)) / float(baseline_memory) * 100.0
            if baseline_memory > 0 else 0.0
        )
        evaluations.append({
            "id": "process.peakRssBytes",
            "baseline": baseline_memory,
            "actual": current_memory,
            "regressionPercent": memory_regression,
            "passed": memory_regression <= float(rules["memoryPercent"]),
        })
    return evaluations


def run_suite(
    profile_name: str,
    profiles_path: Path,
    budgets_path: Path,
    *,
    migration: bool = False,
) -> dict[str, Any]:
    """运行一个规模场景并返回完整机器可读报告。"""
    profiles = load_performance_profiles(profiles_path)
    profile = profiles["profiles"].get(profile_name)
    if profile is None:
        raise ValueError(f"未知性能场景：{profile_name}")
    budgets = json.loads(budgets_path.read_text(encoding="utf-8"))
    sample_count = int(budgets["sampleCount"])
    warmup_count = int(budgets["warmupCount"])

    with tempfile.TemporaryDirectory() as directory:
        temporary_root = Path(directory)
        data_dir = temporary_root / "data"
        generator = generate_v5_workspace_file if migration else generate_v7_dataset
        fixture_destination = (
            data_dir / "workspaces.json" if migration else data_dir / "datasets"
        )
        fixture_summary = generator(
            fixture_destination,
            device_count=int(profile["deviceCount"]),
            tests_per_device=int(profile["testsPerDevice"]),
            payload_bytes_per_test=int(profile["payloadBytesPerTest"]),
            round_count=int(profile["roundCount"]),
        )
        port = _free_local_port()
        base_url = f"http://127.0.0.1:{port}"
        environment = os.environ.copy()
        environment["CT_DATA_DIR"] = str(data_dir)
        environment["CT_ALGORITHM_ROOT"] = str(temporary_root / "no-algorithm")
        process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "realtime_scheduler" / "server.py"),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            startup_ms = _wait_until_ready(base_url, process)
            observability_headers = _read_observability_headers(
                f"{base_url}/api/health"
            )
            device_id = "performance-device-00"
            test_id = "performance-test-00-0000"
            test_payload, _ = _request_json(
                f"{base_url}/api/workspaces/{device_id}/tests/{test_id}"
            )
            saved_test = dict(test_payload["test"])
            save_revision = 0

            def save_test() -> tuple[dict[str, Any], int]:
                """交替修改名称，确保每次 PUT 都执行真实原子写入。"""
                nonlocal save_revision
                save_revision += 1
                payload = dict(saved_test)
                payload["name"] = f"性能测试-{save_revision % 2}"
                return _request_json(
                    f"{base_url}/api/workspaces/{device_id}/tests/{test_id}",
                    method="PUT",
                    payload=payload,
                )

            metrics = {
                "health": _measure(
                    lambda: _request_json(f"{base_url}/api/health"),
                    warmup_count=warmup_count,
                    sample_count=sample_count,
                ),
                "workspaceList": _measure(
                    lambda: _request_json(f"{base_url}/api/workspaces"),
                    warmup_count=warmup_count,
                    sample_count=sample_count,
                ),
                "deviceOverview": _measure(
                    lambda: _request_json(f"{base_url}/api/workspaces/{device_id}"),
                    warmup_count=warmup_count,
                    sample_count=sample_count,
                ),
                "singleTestRead": _measure(
                    lambda: _request_json(
                        f"{base_url}/api/workspaces/{device_id}/tests/{test_id}"
                    ),
                    warmup_count=warmup_count,
                    sample_count=sample_count,
                ),
                "singleTestSave": _measure(
                    save_test,
                    warmup_count=warmup_count,
                    sample_count=sample_count,
                ),
            }
            worker_count = int(profile.get("workerCount") or 0)
            if worker_count:
                concurrent_urls = [
                    f"{base_url}/api/workspaces",
                    f"{base_url}/api/workspaces/{device_id}",
                    f"{base_url}/api/workspaces/{device_id}/tests/{test_id}",
                    f"{base_url}/api/health",
                ]

                def concurrent_read() -> tuple[dict[str, Any], int]:
                    """同时执行四条常用只读链路并合并响应体积。"""
                    with ThreadPoolExecutor(max_workers=worker_count) as executor:
                        responses = list(executor.map(_request_json, concurrent_urls))
                    return {"ok": all(item[0].get("ok") for item in responses)}, sum(
                        item[1] for item in responses
                    )

                metrics["concurrentRead"] = _measure(
                    concurrent_read,
                    warmup_count=warmup_count,
                    sample_count=sample_count,
                )
            move_counts = [int(value) for value in profile.get("moveCounts") or []]
            for move_count in move_counts:
                moves = [
                    {
                        "MoveType": 0,
                        "StartTime": float(index),
                        "EndTime": float(index) + 0.5,
                    }
                    for index in range(move_count)
                ]

                def analyze_moves(
                    move_payload: list[dict[str, Any]] = moves,
                ) -> tuple[dict[str, Any], int]:
                    """提交固定规模 MoveList，测量服务端分析和 JSON 往返。"""
                    return _request_json(
                        f"{base_url}/api/analysis/schedule",
                        method="POST",
                        payload={"moves": move_payload, "windowMode": "full"},
                        timeout=30.0,
                    )

                metrics[f"moveAnalysis{move_count}"] = _measure(
                    analyze_moves,
                    warmup_count=1,
                    sample_count=int(budgets["nightlySampleCount"]),
                )
            # 两种删除都是不可重复的破坏性操作，必须在其他指标完成后执行。
            # 先删除夹具最后一个测试，再删除仍包含其余测试的完整“性能”组。
            # 单次端到端耗时使用 maximumMs 门禁，避免用一个样本伪装 P95。
            deleting_test_id = (
                f"performance-test-00-{int(profile['testsPerDevice']) - 1:04d}"
            )

            def delete_single_test() -> tuple[dict[str, Any], int]:
                """删除单测试并读取前端随后载入的下一测试，覆盖完整等待链路。"""
                delete_result, delete_response_bytes = _request_json(
                    f"{base_url}/api/workspaces/{device_id}/tests/{deleting_test_id}",
                    method="DELETE",
                )
                remaining_tests = delete_result.get("tests") or []
                next_test = remaining_tests[0] if remaining_tests else {}
                next_test_id = str(next_test.get("id") or "")
                if not next_test_id:
                    return delete_result, delete_response_bytes
                next_result, next_response_bytes = _request_json(
                    f"{base_url}/api/workspaces/{device_id}/tests/{next_test_id}"
                )
                return next_result, delete_response_bytes + next_response_bytes

            metrics["singleTestDelete"] = _measure(
                delete_single_test,
                warmup_count=0,
                sample_count=1,
            )
            metrics["testGroupDelete"] = _measure(
                lambda: _request_json(
                    f"{base_url}/api/workspaces/{device_id}/groups",
                    method="DELETE",
                    payload={"name": "性能"},
                ),
                warmup_count=0,
                sample_count=1,
            )
            # 暂存目录的后台物理回收不计入用户等待时间，但隔离性能夹具退出前
            # 必须等待它结束，避免 Windows 在服务进程终止时留下占用中的文件。
            cleanup_deadline = time.perf_counter() + 30.0
            while (
                any(data_dir.glob("datasets/*/tests/.deleting-*"))
                and time.perf_counter() < cleanup_deadline
            ):
                time.sleep(0.05)
            peak_rss_bytes = _process_peak_rss_bytes(process.pid)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

        migration_verified = (
            (data_dir / "datasets" / "manifest.json").is_file()
            and (data_dir / "workspaces.json.legacy.json").is_file()
        ) if migration else None
    evaluation = _evaluate_absolute_budgets(
        metrics,
        startup_ms,
        budgets,
        migration=migration,
    )
    if migration:
        evaluation.append({
            "id": "migrationCompletedWithBackup",
            "actual": migration_verified,
            "target": True,
            "passed": migration_verified is True,
        })
    evaluation.append({
        "id": "performanceResponseHeaders",
        "actual": observability_headers,
        "target": "Server-Timing 与 X-Response-Bytes 非空",
        "passed": bool(
            observability_headers["serverTiming"]
            and observability_headers["responseBytes"].isdigit()
        ),
    })
    return {
        "schemaVersion": 1,
        "profile": profile_name,
        "migration": migration,
        "budgetStatus": budgets.get("status"),
        "python": sys.version,
        "platform": sys.platform,
        "fixture": fixture_summary,
        "startupMs": startup_ms,
        "metrics": metrics,
        "peakRssBytes": peak_rss_bytes,
        "observabilityHeaders": observability_headers,
        "evaluation": evaluation,
        "passed": all(item["passed"] for item in evaluation),
    }


def main() -> int:
    """解析命令行、执行性能场景并写入 JSON 报告。"""
    parser = argparse.ArgumentParser(description="运行调度平台性能预算")
    parser.add_argument("--profile", default="small", help="profiles.json 中的场景名")
    parser.add_argument("--profiles", type=Path, default=DEFAULT_PROFILE_PATH)
    parser.add_argument("--budgets", type=Path, default=DEFAULT_BUDGET_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_REPORT_PATH)
    parser.add_argument("--baseline", type=Path, help="同 profile 的历史 JSON 报告")
    parser.add_argument("--migration", action="store_true", help="先生成 v5 数据并测量启动迁移")
    parser.add_argument("--enforce", action="store_true", help="预算失败时返回非零退出码")
    args = parser.parse_args()

    report = run_suite(
        args.profile,
        args.profiles,
        args.budgets,
        migration=args.migration,
    )
    if args.baseline:
        budgets = json.loads(args.budgets.read_text(encoding="utf-8"))
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
        relative_evaluation = _evaluate_relative_budgets(report, baseline, budgets)
        report["relativeEvaluation"] = relative_evaluation
        report["passed"] = report["passed"] and all(
            item["passed"] for item in relative_evaluation
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({
        "profile": report["profile"],
        "passed": report["passed"],
        "startupMs": round(report["startupMs"], 2),
        "p95Ms": {
            name: round(metric["p95Ms"], 2)
            for name, metric in report["metrics"].items()
        },
        "report": str(args.output),
    }, ensure_ascii=False, indent=2))
    return 1 if args.enforce and not report["passed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
