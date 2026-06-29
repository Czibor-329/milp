"""读取 input_data 录制日志（AlgInit/AlgSchedule）的小工具。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Tuple


def load_alg_entries(path: Path) -> Tuple[dict[str, Any], dict[str, Any]]:
    """从 input_data 日志数组中取出 AlgInit / AlgSchedule 的 Info。"""
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)
    alg_init = next((e["Info"] for e in entries if e.get("Describe") == "AlgInit"), None)
    alg_schedule = next((e["Info"] for e in entries if e.get("Describe") == "AlgSchedule"), None)
    if alg_init is None:
        raise ValueError(f"{path} 中没有 Describe==AlgInit 的条目")
    if alg_schedule is None:
        raise ValueError(f"{path} 中没有 Describe==AlgSchedule 的条目")
    return alg_init, alg_schedule
