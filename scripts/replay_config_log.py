"""回放调度控制台导出的 input_data 复现日志。

日志的 Input 事件保留页面提交给后端的完整配置，因此成功案例和失败案例都能走同一条
执行路径复现。失败时本脚本打印原始错误并返回非零退出码。

用法：
    python scripts/replay_config_log.py path/to/ct-input-log-xxxxxxxx.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.config_editor_server import LoggedPlanError, execute_plan


def load_plan_from_log(raw: Any) -> Dict[str, Any]:
    """从控制台复现日志的 Input 事件中提取原始执行计划。"""
    if isinstance(raw, Mapping):
        return dict(raw)
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise ValueError("复现日志必须是 JSON 数组")
    entry = next((
        item for item in raw
        if isinstance(item, Mapping) and str(item.get("Describe") or "").lower() == "input"
    ), None)
    if entry is None:
        raise ValueError("日志中找不到 Describe=Input；请使用调度控制台新导出的复现日志")
    info = entry.get("Info")
    if isinstance(info, Mapping):
        return dict(info)
    if isinstance(info, Sequence) and not isinstance(info, (str, bytes)):
        plan = next((item for item in info if isinstance(item, Mapping)), None)
        if plan is not None:
            return dict(plan)
    raise ValueError("Input.Info 中找不到完整的控制台计划")


def main() -> None:
    """读取日志并重新执行其中记录的控制台计划。"""
    parser = argparse.ArgumentParser(description="回放调度控制台导出的复现日志")
    parser.add_argument("input", type=Path, help="ct-input-log-*.json 文件")
    args = parser.parse_args()
    raw = json.loads(args.input.read_text(encoding="utf-8"))
    plan = load_plan_from_log(raw)
    try:
        result = execute_plan(plan)
    except LoggedPlanError as error:
        print(f"复现失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(
        f"复现成功：{len(result['rounds'])} 轮，"
        f"{result['moveCount']} Moves，makespan={result['makespan']:.2f}s"
    )


if __name__ == "__main__":
    main()
