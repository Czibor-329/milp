"""幂等扩展 PSE300 单 Job 腔室驻留测试集。

脚本只保存带正驻留上限的 Route 和测试，不创建无约束对照。新增案例覆盖
并行同工时、短长串行、短工序后接并行长工序、反向不平衡和高并行短工艺。
重复执行时按“组名 + 测试名”更新原案例，并保留稳定测试 ID。
"""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from realtime_scheduler.backend import application as scheduler_server


PSE300_DEVICE_NAME = "PSE300.json"
TARGET_GROUP = "单次重算-1job-驻留"
ROUTE_GROUP = "腔室驻留"
DEFAULT_STRATEGY = "loadlock-macro"
DEFAULT_LOAD_PORT = "LP1"
DEFAULT_LOAD_LOCK_MANAGER = "petri-look"
DEFAULT_MACRO_SEARCH_SECONDS = 4
DEFAULT_MACRO_ROLLOUTS = 96
DEFAULT_RESIDENCY_GUARD_SECONDS = 10.0
UNCONSTRAINED_LIMIT = -1.0
DEFAULT_NON_PROCESS_TIME = 20.0


@dataclass(frozen=True)
class ResidencyScenario:
    """描述一个只包含单 Job 的腔室驻留扩展场景。"""

    name: str
    process_steps: tuple[tuple[tuple[str, ...], float], ...]
    wafer_count: int
    residency_seconds: float


SCENARIOS = (
    ResidencyScenario(
        "并行同工时-2PM-40s-W25-R15",
        ((('PM1', 'PM2'), 40.0),),
        25,
        15.0,
    ),
    ResidencyScenario(
        "并行同工时-3PM-40s-W25-R15",
        ((('PM1', 'PM2', 'PM3'), 40.0),),
        25,
        15.0,
    ),
    ResidencyScenario(
        "短长串行-10s至80s-W13-R15",
        ((('PM1',), 10.0), (('PM2',), 80.0)),
        13,
        15.0,
    ),
    ResidencyScenario(
        "短长串行-30s至120s-W25-R25",
        ((('PM1',), 30.0), (('PM2',), 120.0)),
        25,
        25.0,
    ),
    ResidencyScenario(
        "短并长串行-10s至2PM80s-W13-R15",
        ((('PM1',), 10.0), (('PM2', 'PM3'), 80.0)),
        13,
        15.0,
    ),
    ResidencyScenario(
        "短并长串行-20s至3PM100s-W25-R20",
        ((('PM1',), 20.0), (('PM2', 'PM3', 'PM4'), 100.0)),
        25,
        20.0,
    ),
    ResidencyScenario(
        "反向不平衡-3PM100s至PM4-20s-W13-R20",
        ((('PM1', 'PM2', 'PM3'), 100.0), (('PM4',), 20.0)),
        13,
        20.0,
    ),
    ResidencyScenario(
        "反向不平衡-2PM120s至PM3-30s-W25-R20",
        ((('PM1', 'PM2'), 120.0), (('PM3',), 30.0)),
        25,
        20.0,
    ),
    ResidencyScenario(
        "反向不平衡-3PM80s至PM4-10s-W13-R15",
        ((('PM1', 'PM2', 'PM3'), 80.0), (('PM4',), 10.0)),
        13,
        15.0,
    ),
    ResidencyScenario(
        "高并行短工艺-4PM-10s-W25-R20",
        ((('PM1', 'PM2', 'PM3', 'PM4'), 10.0),),
        25,
        20.0,
    ),
    ResidencyScenario(
        "高并行短工艺-4PM-12s-W25-R15",
        ((('PM1', 'PM2', 'PM3', 'PM4'), 12.0),),
        25,
        15.0,
    ),
    ResidencyScenario(
        "高并行短工艺-4PM-15s-W25-R15",
        ((('PM1', 'PM2', 'PM3', 'PM4'), 15.0),),
        25,
        15.0,
    ),
)


def _visit(
    station_name: str,
    *,
    recipe_name: str = "",
    process_time: float = DEFAULT_NON_PROCESS_TIME,
    residency_seconds: float = UNCONSTRAINED_LIMIT,
) -> dict[str, Any]:
    """构造 Route 中的单个站点访问定义。"""
    return {
        "stationName": station_name,
        "slotIds": "1",
        "processRecipe": recipe_name,
        "processTime": float(process_time),
        "recipeTime": float(process_time),
        "processType": "",
        "weight": "{}",
        "moveTimeOffset": "{}",
        "qTimeLimit": UNCONSTRAINED_LIMIT,
        "residencyConstraint": float(residency_seconds),
        "beforeCleanRefs": [],
        "afterCleanRefs": [],
    }


def _stage(
    stations: Sequence[str],
    *,
    recipe_name: str = "",
    process_time: float = DEFAULT_NON_PROCESS_TIME,
    residency_seconds: float = UNCONSTRAINED_LIMIT,
) -> dict[str, Any]:
    """构造共享同一工艺参数的线性 Route 阶段。"""
    return {
        "stepId": 0,
        "postStepIds": [],
        "needProcess": bool(recipe_name),
        "visits": [
            _visit(
                station_name,
                recipe_name=recipe_name,
                process_time=process_time,
                residency_seconds=residency_seconds,
            )
            for station_name in stations
        ],
        "kind": (
            "robot"
            if stations and stations[0] in {"ATR", "VTR"}
            else "station"
        ),
    }


def _route(scenario: ResidencyScenario) -> dict[str, Any]:
    """构造 LP1—LoadLock—PM 工序—LoadLock—LP1 的完整驻留 Route。"""
    stages = [
        _stage(("LP1",)),
        _stage(("ATR",)),
        _stage(("LA", "LB")),
        _stage(("VTR",)),
    ]
    for process_index, (modules, process_time) in enumerate(
        scenario.process_steps,
        start=1,
    ):
        recipe_name = f"Residency_{scenario.name}_Step{process_index}"
        stages.extend((
            _stage(
                modules,
                recipe_name=recipe_name,
                process_time=process_time,
                residency_seconds=scenario.residency_seconds,
            ),
            _stage(("VTR",)),
        ))
    stages.extend((
        _stage(("LA", "LB")),
        _stage(("ATR",)),
        _stage(("LP1",)),
    ))
    for stage_index, stage in enumerate(stages):
        stage["stepId"] = stage_index
        stage["postStepIds"] = (
            [stage_index + 1]
            if stage_index + 1 < len(stages)
            else []
        )
    return {
        "name": scenario.name,
        "group": ROUTE_GROUP,
        "bufferOption": 0,
        "prePJobCleanRefs": [],
        "postPJobCleanRefs": [],
        "postCJobCleanRefs": [],
        "stages": stages,
    }


def _test_case(scenario: ResidencyScenario) -> dict[str, Any]:
    """构造引用指定驻留 Route 的单轮、单 Job 测试。"""
    return {
        "name": scenario.name,
        "group": TARGET_GROUP,
        "strategy": DEFAULT_STRATEGY,
        "roundCount": 1,
        "times": [0.0],
        "options": {
            "loadLockManager": DEFAULT_LOAD_LOCK_MANAGER,
            "loadLockMacroSearchSeconds": DEFAULT_MACRO_SEARCH_SECONDS,
            "loadLockMacroRollouts": DEFAULT_MACRO_ROLLOUTS,
            "residencyGuardSeconds": DEFAULT_RESIDENCY_GUARD_SECONDS,
        },
        "rounds": [{
            "currentTime": 0.0,
            "cjobs": [{
                "key": "C1",
                "jobType": "NormalLot",
                "priority": 1,
                "taskMode": "Smart",
                "pjobs": [{
                    "routeRef": scenario.name,
                    "loadPort": DEFAULT_LOAD_PORT,
                    "waferCount": scenario.wafer_count,
                    "priority": 1,
                }],
            }],
        }],
    }


def _merge_routes(
    existing_routes: Sequence[Mapping[str, Any]],
    additions: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """按 Route 名称更新扩展资产，并保持其他共享 Route 原顺序。"""
    merged = [deepcopy(dict(route)) for route in existing_routes]
    index_by_name = {
        str(route.get("name") or ""): index
        for index, route in enumerate(merged)
    }
    for addition in additions:
        route = deepcopy(dict(addition))
        route_name = str(route.get("name") or "")
        if route_name in index_by_name:
            merged[index_by_name[route_name]] = route
        else:
            index_by_name[route_name] = len(merged)
            merged.append(route)
    return merged


def _pse300_device(store_path: Path) -> dict[str, Any]:
    """按设备名称读取当前 PSE300 工作区。"""
    summary = next(
        (
            item
            for item in scheduler_server.list_workspace_devices(store_path)
            if str(item.get("name") or "") == PSE300_DEVICE_NAME
        ),
        None,
    )
    if summary is None:
        raise RuntimeError(f"工作区缺少设备 {PSE300_DEVICE_NAME}")
    return scheduler_server.get_workspace_device(
        str(summary["id"]),
        store_path,
    )


def _assert_positive_residency(routes: Sequence[Mapping[str, Any]]) -> None:
    """确保每条新增 Route 的全部加工访问都设置了正驻留上限。"""
    for route in routes:
        process_visits = [
            visit
            for stage in route.get("stages") or []
            if bool(stage.get("needProcess"))
            for visit in stage.get("visits") or []
        ]
        if not process_visits or any(
            float(visit.get("residencyConstraint") or 0.0) <= 0.0
            for visit in process_visits
        ):
            raise AssertionError(
                f"Route {route.get('name')} 存在未设置正驻留上限的加工访问"
            )


def install_residency_tests(
    store_path: Path = scheduler_server.WORKSPACE_STORE_PATH,
) -> dict[str, Any]:
    """幂等写入扩展 Route 和测试，并返回安装摘要。"""
    device = _pse300_device(store_path)
    device_id = str(device["id"])
    if TARGET_GROUP not in (device.get("testGroups") or []):
        scheduler_server.create_workspace_test_group(
            device_id,
            TARGET_GROUP,
            store_path,
        )
        device = _pse300_device(store_path)

    additions = [_route(scenario) for scenario in SCENARIOS]
    _assert_positive_residency(additions)
    merged_routes = _merge_routes(device.get("routes") or [], additions)
    written = []
    for scenario_index, scenario in enumerate(SCENARIOS):
        device = _pse300_device(store_path)
        existing = next(
            (
                test
                for test in (device.get("tests") or [])
                if str(test.get("group") or "") == TARGET_GROUP
                and str(test.get("name") or "") == scenario.name
            ),
            None,
        )
        payload = _test_case(scenario)
        if scenario_index == 0:
            payload["routes"] = merged_routes
            payload["cleans"] = deepcopy(device.get("cleans") or [])
        if existing is None:
            saved = scheduler_server.create_workspace_test(
                device_id,
                payload,
                store_path,
            )
            action = "created"
        else:
            saved = scheduler_server.update_workspace_test(
                device_id,
                str(existing["id"]),
                payload,
                store_path,
            )
            action = "updated"
        written.append({
            "id": str(saved["id"]),
            "name": str(saved["name"]),
            "action": action,
        })

    final_device = _pse300_device(store_path)
    group_tests = [
        test
        for test in (final_device.get("tests") or [])
        if str(test.get("group") or "") == TARGET_GROUP
    ]
    return {
        "deviceId": device_id,
        "group": TARGET_GROUP,
        "written": written,
        "groupTestCount": len(group_tests),
    }


if __name__ == "__main__":
    print(json.dumps(install_residency_tests(), ensure_ascii=False, indent=2))
