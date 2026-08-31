"""从终端运行本地设备测试集，并输出适合 AI 调试的逐项结果。

脚本直接读取 ``realtime_scheduler/data/datasets`` 的单一数据源，调用与前端
批量运行相同的计划构造和执行逻辑。默认使用平台内置 MoveList 校验器；传入
``--hongye-check`` 时改用 HongYe 校验器。运行结果和复现日志仍按平台现有规则保存。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
from collections import Counter
from pathlib import Path
from typing import Any, Mapping, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def _argument_parser() -> argparse.ArgumentParser:
    """构建测试集终端入口的参数解析器。"""
    parser = argparse.ArgumentParser(
        description="运行调度平台本地测试集；默认使用内置校验器，不使用 HongYe。",
    )
    parser.add_argument("--device", help="设备 ID 或完整设备名称，例如 12kChamber")
    parser.add_argument("--group", help="完整测试组名称，例如 公司示例集")
    parser.add_argument(
        "--test",
        action="append",
        default=[],
        help="只运行指定测试 ID 或完整名称；可重复传入",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="按自然顺序只运行前 N 项，适合快速复现",
    )
    parser.add_argument("--strategy", default="heuristic", help="算法策略，默认 heuristic")
    parser.add_argument("--workers", type=int, default=1, help="并发数 1-4，默认 1 便于复现")
    parser.add_argument(
        "--with-baseline",
        action="store_true",
        help="同时计算 Heuristic Baseline；默认跳过以缩短调试时间",
    )
    parser.add_argument(
        "--hongye-check",
        action="store_true",
        help="使用 HongYe SchStateLib 校验；默认使用平台内置 MoveList 校验器",
    )
    parser.add_argument("--json-output", type=Path, help="把完整批量结果另存为 JSON")
    parser.add_argument(
        "--list",
        action="store_true",
        help="列出设备；同时指定 --device 时列出其测试组，指定 --group 时列出测试",
    )
    return parser


def _select_unique(
    rows: Sequence[Mapping[str, Any]],
    selector: str,
    *,
    kind: str,
) -> Mapping[str, Any]:
    """按稳定 ID 或完整名称选择唯一对象，避免模糊匹配跑错测试。"""
    normalized = str(selector or "").strip().casefold()
    matches = [
        row
        for row in rows
        if normalized
        and normalized
        in {
            str(row.get("id") or "").strip().casefold(),
            str(row.get("name") or "").strip().casefold(),
        }
    ]
    if not matches:
        raise ValueError(f"找不到{kind}：{selector}")
    if len(matches) > 1:
        raise ValueError(f"{kind}名称不唯一，请改用 ID：{selector}")
    return matches[0]


def _natural_test_order(test: Mapping[str, Any]) -> tuple[Any, ...]:
    """生成与前端批量结果一致的测试名称自然排序键。"""
    label = str(test.get("name") or test.get("id") or "")
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", label)
        if part
    )


def _selected_test_ids(
    tests: Sequence[Mapping[str, Any]],
    selectors: Sequence[str],
    limit: int | None,
) -> list[str] | None:
    """解析测试筛选条件；无筛选时返回 ``None`` 表示运行整组。"""
    selected = sorted(tests, key=_natural_test_order)
    if selectors:
        selected = [
            _select_unique(tests, selector, kind="测试")
            for selector in selectors
        ]
    if limit is not None:
        if limit <= 0:
            raise ValueError("--limit 必须大于 0")
        selected = selected[:limit]
    if not selectors and limit is None:
        return None
    return [str(test.get("id") or "") for test in selected]


def _print_catalog(
    devices: Sequence[Mapping[str, Any]],
    *,
    device: Mapping[str, Any] | None = None,
    group: str | None = None,
) -> None:
    """打印设备、组别或测试清单，供后续命令复制稳定选择器。"""
    if device is None:
        for row in devices:
            print(f"{row.get('id')}\t{row.get('name')}\t{row.get('testCount', 0)} tests")
        return
    tests = [row for row in (device.get("tests") or []) if isinstance(row, Mapping)]
    if group is None:
        for name, count in sorted(Counter(str(row.get("group") or "") for row in tests).items()):
            print(f"{name or '<未分组>'}\t{count} tests")
        return
    for row in sorted(tests, key=_natural_test_order):
        if str(row.get("group") or "").strip() == str(group).strip():
            print(f"{row.get('id')}\t{row.get('name')}")


def main(argv: Sequence[str] | None = None) -> int:
    """解析终端参数、运行测试集并以进程退出码表达整体成败。"""
    # Windows 管道默认代码页会让 Codex 等 UTF-8 日志消费者看到乱码。
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")
    args = _argument_parser().parse_args(argv)
    if not args.list and (not args.device or args.group is None):
        raise ValueError("运行测试集必须同时指定 --device 和 --group；可先用 --list 查询")
    if not 1 <= args.workers <= 4:
        raise ValueError("--workers 必须在 1 到 4 之间")

    from realtime_scheduler.backend import application as scheduler_server

    devices = scheduler_server.list_workspace_devices()
    if args.list and not args.device:
        _print_catalog(devices)
        return 0
    selected_device_summary = _select_unique(devices, args.device, kind="设备")
    selected_device = scheduler_server.get_workspace_device(
        str(selected_device_summary.get("id") or ""),
    )
    if args.list:
        _print_catalog(devices, device=selected_device, group=args.group)
        return 0

    group_tests = [
        row
        for row in (selected_device.get("tests") or [])
        if isinstance(row, Mapping)
        and str(row.get("group") or "").strip() == str(args.group).strip()
    ]
    test_ids = _selected_test_ids(group_tests, args.test, args.limit)
    expected_count = len(test_ids) if test_ids is not None else len(group_tests)
    print(
        f"设备={selected_device.get('name')} 组={args.group or '<未分组>'} "
        f"策略={args.strategy} 测试={expected_count} "
        f"校验={'HongYe' if args.hongye_check else '内置'}",
        flush=True,
    )
    print_lock = threading.Lock()

    def report(index: int, item: Mapping[str, Any]) -> None:
        """按固定单行格式报告进度，使终端日志便于人和 AI 搜索。"""
        status = str(item.get("status") or "unknown")
        label = str(item.get("testName") or item.get("testId") or index + 1)
        suffix = f"：{item.get('error')}" if item.get("error") else ""
        with print_lock:
            print(f"[{index + 1}/{expected_count}] {status.upper()} {label}{suffix}", flush=True)

    result = scheduler_server.run_workspace_test_batch(
        str(selected_device.get("id") or ""),
        str(args.group or ""),
        args.strategy,
        {},
        skip_validation=False,
        hongye_check=args.hongye_check,
        skip_baseline=not args.with_baseline,
        maximum_workers=args.workers,
        test_ids=test_ids,
        progress_callback=report,
    )
    print(
        f"完成：通过 {result.get('succeeded', 0)}，失败 {result.get('failed', 0)}，"
        f"耗时 {float(result.get('totalElapsedMs') or 0.0) / 1000.0:.2f}s",
    )
    if args.json_output is not None:
        output_path = args.json_output.expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"JSON={output_path}")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(2) from error
