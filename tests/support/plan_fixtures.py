"""构造平台计划测试使用的最小设备路径与 Job。

本模块只拥有跨测试复用的只读路径和纯数据 builder，不读取或修改工作区主数据。
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ALGORITHM_ROOT = ROOT / "alg"
DEVICE_PATH = ALGORITHM_ROOT / "dataset" / "input_data" / "s1-1c2p-reschedule.json"
DATASET_ROOT = ROOT / "realtime_scheduler" / "data" / "datasets"


def dataset_device_path(device_name: str) -> Path:
    """按元数据中的设备名定位唯一的主数据 ``device.json``。"""
    matches = []
    for metadata_path in DATASET_ROOT.glob("*/metadata.json"):
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("name") == device_name:
            matches.append(metadata_path.parent / "device.json")
    if len(matches) != 1:
        raise RuntimeError(f"设备 {device_name!r} 应唯一，实际找到 {len(matches)} 个")
    return matches[0]


PSE300_DEVICE_PATH = dataset_device_path("PSE300")


def route(name: str, modules: str, recipe: str) -> dict:
    """创建 source—加工—sink 的完整平台 Route。"""
    return {
        "name": name,
        "group": name,
        "bufferOption": 0,
        "prePJobCleanRefs": [],
        "postPJobCleanRefs": [],
        "postCJobCleanRefs": [],
        "stages": [
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": modules, "recipeRef": recipe, "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
        ],
    }


def job(name: str, route_name: str, load_port: str) -> dict:
    """创建一片晶圆的最小平台 Job。"""
    return {
        "name": name,
        "routeRef": route_name,
        "loadPort": load_port,
        "waferCount": 1,
        "priority": 1,
        "weight": 1,
        "jobType": 0,
        "taskMode": 0,
        "foupId": name,
    }
