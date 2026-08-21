"""实时调度终端的批量运行与 Baseline 服务。

本模块负责把设备测试组展开为排程计划、并发执行测试、维护批量任务状态并生成
Heuristic Baseline。HTTP 传输和单次计划执行仍由 ``server`` 门面提供；通过显式配置的
服务边界进行协作，以保留旧入口的替换与测试能力。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from copy import deepcopy
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from realtime_scheduler.plan_builder import (
    _finite_number,
    _round_cjob_rows,
    _runtime_clean,
    _stage_visit_rows,
    _string_list,
)

_SERVER_SERVICES: Optional[ModuleType] = None

PICK_MOVE_TYPES = frozenset({0, 2})
PLACE_MOVE_TYPES = frozenset({1, 3})
SWAP_MOVE_TYPE = 4
PRE_TRANS_MOVE_TYPE = 5
TIME_TOLERANCE_SECONDS = 1e-9


def configure_batch_service(services: ModuleType) -> None:
    """绑定兼容门面及其共享缓存、常量和异常类型。"""
    global _SERVER_SERVICES, LoggedPlanError
    global API_SCHEMA_VERSION, HEURISTIC_BASELINE_SCHEMA_VERSION, MAX_SAVED_BATCH_RUNS
    global _BATCH_RUNS, _BATCH_RUNS_LOCK, _BATCH_CANCEL_EVENTS
    _SERVER_SERVICES = services
    LoggedPlanError = services.LoggedPlanError
    API_SCHEMA_VERSION = services.API_SCHEMA_VERSION
    HEURISTIC_BASELINE_SCHEMA_VERSION = services.HEURISTIC_BASELINE_SCHEMA_VERSION
    MAX_SAVED_BATCH_RUNS = services.MAX_SAVED_BATCH_RUNS
    _BATCH_RUNS = services._BATCH_RUNS
    _BATCH_RUNS_LOCK = services._BATCH_RUNS_LOCK
    _BATCH_CANCEL_EVENTS = services._BATCH_CANCEL_EVENTS


def _services() -> ModuleType:
    """返回已配置的服务门面；未配置表示模块初始化顺序错误。"""
    if _SERVER_SERVICES is None:
        raise RuntimeError("批量调度服务尚未配置")
    return _SERVER_SERVICES


def execute_plan(plan: Mapping[str, Any]) -> Dict[str, Any]:
    """通过门面执行单次计划，使运行时替换和测试桩保持生效。"""
    return _services().execute_plan(plan)


def get_workspace_device(device_id: str) -> Dict[str, Any]:
    """通过门面读取设备工作区。"""
    return _services().get_workspace_device(device_id)


def save_result(output: Dict[str, Any]) -> str:
    """通过门面保存 MoveList 结果。"""
    return _services().save_result(output)


def save_reproduction_log(entries: Sequence[Mapping[str, Any]]) -> str:
    """通过门面保存复现日志。"""
    return _services().save_reproduction_log(entries)


def _persist_workspace_baseline(
    device_id: str, test_id: str, baseline: Mapping[str, Any], path: Optional[Path] = None,
) -> bool:
    """通过门面持久化 Baseline，保留测试和调用方的动态替换能力。"""
    if path is None:
        return _services()._persist_workspace_baseline(device_id, test_id, baseline)
    return _services()._persist_workspace_baseline(device_id, test_id, baseline, path)


def _workspace_catalog_guard(path: Path):
    """通过门面取得跨进程工作区事务上下文。"""
    return _services()._workspace_catalog_guard(path)


def _read_workspace_catalog_unlocked(path: Path) -> Dict[str, Any]:
    """通过门面读取已持锁的工作区目录。"""
    return _services()._read_workspace_catalog_unlocked(path)


def _write_workspace_catalog_unlocked(path: Path, catalog: Mapping[str, Any]) -> None:
    """通过门面写入已持锁的工作区目录。"""
    _services()._write_workspace_catalog_unlocked(path, catalog)


def _workspace_timestamp() -> str:
    """通过门面生成统一工作区时间戳。"""
    return _services()._workspace_timestamp()


def _segment_end(moves: Sequence[Mapping[str, Any]]) -> float:
    """通过门面计算 MoveList 片段结束时间。"""
    return _services()._segment_end(moves)


def _move_robot_name(move: Mapping[str, Any]) -> str:
    """读取传输动作使用的机器人名称，兼容 Robot 和 ModuleName 两种输出。"""
    return str(move.get("Robot") or move.get("ModuleName") or "").strip()


def _move_material_ids(move: Mapping[str, Any], field: str = "MatIDList") -> List[str]:
    """把 MoveList 的晶圆编号字段规范化为可用于跨动作配对的字符串列表。"""
    values = move.get(field) or []
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
        return []
    return [str(value) for value in values]


def _median(values: Sequence[float]) -> float:
    """计算已排序或未排序数值序列的中位数，空序列返回零。"""
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _robot_wafer_dwell_time(moves: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    """统计晶圆在机器人手上的等待驻留时间。

    Pick 完成后开始计时，Place 开始时停止计时，因此不包含取放动作自身耗时；
    Swap 开始时结束机器人原持片，Swap 完成时为机器人新接收的晶圆开始计时。
    同一持片区间内显式 PreTrans 运输时间按区间并集扣除。返回所有完整驻留
    区间的总和、中位数、最大值和样本数。
    """
    ordered_moves = sorted(
        (move for move in moves if isinstance(move, Mapping)),
        key=lambda move: (
            float(move.get("StartTime") or 0.0),
            float(move.get("EndTime") or move.get("StartTime") or 0.0),
            int(move.get("MoveID") or 0),
        ),
    )
    transport_by_robot: Dict[str, List[Tuple[float, float]]] = {}
    for move in ordered_moves:
        if int(move.get("MoveType") or 0) != PRE_TRANS_MOVE_TYPE:
            continue
        robot_name = _move_robot_name(move)
        start_time = float(move.get("StartTime") or 0.0)
        end_time = float(move.get("EndTime") or start_time)
        if robot_name and end_time > start_time + TIME_TOLERANCE_SECONDS:
            transport_by_robot.setdefault(robot_name, []).append((start_time, end_time))
    holding_started_at: Dict[Tuple[str, str], float] = {}
    dwell_times: List[float] = []

    def covered_transport(robot_name: str, started_at: float, finished_at: float) -> float:
        """计算同一机器人在持片区间内执行的显式运输时间并集。"""
        clipped = sorted(
            (
                max(started_at, start_time),
                min(finished_at, end_time),
            )
            for start_time, end_time in transport_by_robot.get(robot_name, [])
            if min(finished_at, end_time)
            > max(started_at, start_time) + TIME_TOLERANCE_SECONDS
        )
        total = 0.0
        active_start: Optional[float] = None
        active_end = 0.0
        for start_time, end_time in clipped:
            if active_start is None:
                active_start, active_end = start_time, end_time
            elif start_time <= active_end + TIME_TOLERANCE_SECONDS:
                active_end = max(active_end, end_time)
            else:
                total += active_end - active_start
                active_start, active_end = start_time, end_time
        return total if active_start is None else total + active_end - active_start

    def finish_holding(robot_name: str, material_ids: Sequence[str], finished_at: float) -> None:
        """结束指定机器人和晶圆的持片区间，并记录非负驻留时长。"""
        for material_id in material_ids:
            started_at = holding_started_at.pop((robot_name, material_id), None)
            if started_at is None:
                continue
            duration = (
                finished_at
                - started_at
                - covered_transport(robot_name, started_at, finished_at)
            )
            if duration >= -TIME_TOLERANCE_SECONDS:
                dwell_times.append(max(0.0, duration))

    for move in ordered_moves:
        move_type = int(move.get("MoveType") or 0)
        robot_name = _move_robot_name(move)
        if not robot_name:
            continue
        start_time = float(move.get("StartTime") or 0.0)
        end_time = float(move.get("EndTime") or start_time)
        if move_type in PICK_MOVE_TYPES:
            for material_id in _move_material_ids(move):
                holding_started_at[(robot_name, material_id)] = end_time
        elif move_type in PLACE_MOVE_TYPES:
            finish_holding(robot_name, _move_material_ids(move), start_time)
        elif move_type == SWAP_MOVE_TYPE:
            # RecvMatList 是 Robot 换出后新接到手上的晶圆；SendMatList
            # 是原先在 Robot 手上、于 Swap 开始时送入站点的晶圆。
            finish_holding(robot_name, _move_material_ids(move, "SendMatList"), start_time)
            for material_id in _move_material_ids(move, "RecvMatList"):
                holding_started_at[(robot_name, material_id)] = end_time

    return {
        "totalSeconds": sum(dwell_times),
        "medianSeconds": _median(dwell_times),
        "maxSeconds": max(dwell_times, default=0.0),
        "sampleCount": len(dwell_times),
    }

def _log_response_fields(log_id: str) -> Dict[str, str]:
    """生成前端下载日志所需的稳定地址与文件名。"""
    filename = f"ct-input-log-{log_id[:8]}.json"
    return {"logUrl": f"/api/logs/{log_id}", "logFileName": filename}


def _logged_failure_result_fields(error: LoggedPlanError) -> Dict[str, Any]:
    """为带失败 MoveList 的异常保存诊断甘特图并生成响应字段。"""
    if error.failure_output is None:
        return {}
    result_id = save_result(error.failure_output)
    moves = list(error.failure_output.get("MoveList") or [])
    return {
        "resultId": result_id,
        "resultUrl": f"/api/results/{result_id}",
        "ganttUrl": (
            "/movelist_gantt_viewer.html?"
            f"src=/api/results/{result_id}"
        ),
        "validation": "failed",
        "validationIssues": deepcopy(error.validation_issues),
        "moveCount": len(moves),
        "makespan": _segment_end(moves),
    }


def _batch_test_routes(
    routes: Sequence[Mapping[str, Any]],
    rounds: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """只保留测试各轮 PJob 实际引用的共享 Route。"""
    referenced = {
        str(pjob.get("routeRef") or "").strip()
        for round_row in rounds
        for cjob in _round_cjob_rows(round_row)
        for pjob in (cjob.get("pjobs") or [])
        if isinstance(pjob, Mapping)
    }
    return [
        deepcopy(dict(route))
        for route in routes
        if str(route.get("name") or "").strip() in referenced
    ]


def _batch_apply_route_configs(
    routes: Sequence[Mapping[str, Any]],
    raw_configs: Any,
) -> List[Dict[str, Any]]:
    """把测试独有的时间、清洁和驻留参数合并到共享路径模板副本。"""
    configs = raw_configs if isinstance(raw_configs, Mapping) else {}
    merged_routes: List[Dict[str, Any]] = []
    for raw_route in routes:
        route = deepcopy(dict(raw_route))
        route_name = str(route.get("name") or "").strip()
        config = configs.get(route_name)
        if not isinstance(config, Mapping):
            merged_routes.append(route)
            continue
        route["bufferOption"] = int(_finite_number(config.get("bufferOption"), 0))
        for key in ("prePJobCleanRefs", "postPJobCleanRefs", "postCJobCleanRefs"):
            route[key] = _string_list(config.get(key))
        stage_configs = config.get("stages") if isinstance(config.get("stages"), Mapping) else {}
        for stage_index, stage in enumerate(route.get("stages") or []):
            if not isinstance(stage, dict):
                continue
            step_id = str(stage.get("stepId", stage_index))
            stage_config = stage_configs.get(step_id)
            if not isinstance(stage_config, Mapping):
                continue
            for visit in stage.get("visits") or []:
                if not isinstance(visit, dict):
                    continue
                process_time = _finite_number(stage_config.get("processTime"), 20)
                visit.update({
                    "processTime": process_time,
                    "recipeTime": process_time,
                    "qTimeLimit": _finite_number(stage_config.get("qTimeLimit"), -1),
                    "residencyConstraint": _finite_number(
                        stage_config.get("residencyConstraint"), -1,
                    ),
                    "beforeCleanRefs": _string_list(stage_config.get("beforeCleanRefs")),
                    "afterCleanRefs": _string_list(stage_config.get("afterCleanRefs")),
                    "processRecipe": str(stage_config.get("processRecipe") or ""),
                    "processType": str(stage_config.get("processType") or ""),
                    "weight": deepcopy(stage_config.get("weight") or {}),
                    "moveTimeOffset": deepcopy(stage_config.get("moveTimeOffset") or {}),
                    "slotIds": str(stage_config.get("slotIds") or "1"),
                })
        merged_routes.append(route)
    return merged_routes


def _batch_test_cleans(
    cleans: Sequence[Mapping[str, Any]],
    routes: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """只保留当前测试 Route 实际引用的设备级 Clean 模板。"""
    referenced: set[str] = set()
    for route in routes:
        for field_name in (
            "prePJobCleanRefs",
            "postPJobCleanRefs",
            "postCJobCleanRefs",
        ):
            referenced.update(_string_list(route.get(field_name)))
        for stage in route.get("stages") or []:
            if not isinstance(stage, Mapping):
                continue
            for visit in _stage_visit_rows(stage):
                referenced.update(_string_list(
                    visit.get("beforeCleanRefs") or visit.get("BeforeInPM")
                ))
                referenced.update(_string_list(
                    visit.get("afterCleanRefs") or visit.get("AfterOutPM")
                ))
    return [
        deepcopy(dict(clean))
        for clean in cleans
        if str(clean.get("name") or "").strip() in referenced
    ]


def _batch_test_recipes(
    routes: Sequence[Mapping[str, Any]],
    cleans: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """从共享 Route/Clean 派生与前端单次运行一致的 Recipe 列表。"""
    recipes: Dict[str, Dict[str, Any]] = {}

    def add(
        name: Any,
        duration: Any,
        modules: Any,
        process_type: Any = "",
        weight: Any = None,
    ) -> None:
        """将一条工艺定义合并进批处理 Recipe 索引。"""
        recipe_name = str(name or "").strip()
        if not recipe_name:
            return
        module_names = _string_list(modules)
        existing = recipes.get(recipe_name)
        if existing is None:
            recipes[recipe_name] = {
                "name": recipe_name,
                "time": _finite_number(duration, 0.0),
                "modules": module_names,
                "processType": str(process_type or ""),
                "weight": deepcopy(weight if weight is not None else {}),
            }
            return
        existing["modules"] = list(dict.fromkeys([*existing["modules"], *module_names]))

    for route in routes:
        for stage in route.get("stages") or []:
            if not isinstance(stage, Mapping):
                continue
            for visit in _stage_visit_rows(stage):
                module_name = str(
                    visit.get("stationName") or visit.get("StationName") or ""
                ).strip()
                process_recipe = (
                    visit.get("processRecipe") or visit.get("ProcessRecipe")
                )
                add(
                    process_recipe,
                    visit.get("processTime", visit.get("recipeTime", 0.0)),
                    [module_name],
                    visit.get("processType"),
                    visit.get("weight") or {},
                )
    for clean in cleans:
        runtime_clean = _runtime_clean(clean)
        modules = _string_list(runtime_clean.get("modules"))
        add(
            runtime_clean.get("recipeRef"),
            runtime_clean.get("recipeTime"),
            modules,
        )
        if runtime_clean.get("cleanType") == "dummywac":
            add(
                runtime_clean.get("emptyRecipeRef"),
                runtime_clean.get("wacRecipeTime"),
                modules,
            )
    return list(recipes.values())


def build_workspace_batch_plan(
    device: Mapping[str, Any],
    test_case: Mapping[str, Any],
    strategy: str,
    options: Mapping[str, Any],
    *,
    skip_validation: bool = False,
) -> Dict[str, Any]:
    """将持久化测试与设备共享库组合成可直接执行的单次请求。"""
    rounds = [
        deepcopy(dict(row))
        for row in (test_case.get("rounds") or [])
        if isinstance(row, Mapping)
    ]
    configured_routes = _batch_apply_route_configs(
        [row for row in (device.get("routes") or []) if isinstance(row, Mapping)],
        test_case.get("routeConfigs"),
    )
    routes = _batch_test_routes(
        configured_routes,
        rounds,
    )
    cleans = [
        _runtime_clean(clean)
        for clean in _batch_test_cleans(
            [
                row
                for row in (
                    test_case.get("cleans")
                    if isinstance(test_case.get("cleans"), list)
                    else device.get("cleans") or []
                )
                if isinstance(row, Mapping)
            ],
            routes,
        )
    ]
    merged_options = deepcopy(dict(test_case.get("options") or {}))
    merged_options.update(deepcopy(dict(options)))
    runtime_device = deepcopy(device.get("device"))
    if isinstance(runtime_device, dict):
        _services().apply_robot_slot_selection(
            runtime_device,
            device.get("robotSlots"),
        )
    plan = {
        "schemaVersion": API_SCHEMA_VERSION,
        "deviceName": str(device.get("name") or "selected init"),
        "device": runtime_device,
        "strategy": str(strategy or "heuristic"),
        "roundCount": len(rounds),
        "options": merged_options,
        "recipes": _batch_test_recipes(routes, cleans),
        "cleans": cleans,
        "routes": routes,
        "rounds": rounds,
    }
    if skip_validation:
        # 仅在显式跳过校验时写入该键，避免改变 Baseline 指纹并使其全部失效。
        plan["skipValidation"] = True
    return plan


def _workspace_baseline_fingerprint(
    device: Mapping[str, Any],
    test_case: Mapping[str, Any],
    options: Optional[Mapping[str, Any]] = None,
) -> str:
    """对实际 Heuristic 输入做稳定摘要，绑定测试及其引用的共享工艺配置。"""
    plan = build_workspace_batch_plan(
        device,
        test_case,
        "heuristic",
        options if options is not None else dict(test_case.get("options") or {}),
    )
    canonical = json.dumps(
        {
            "baselineSchema": HEURISTIC_BASELINE_SCHEMA_VERSION,
            "plan": plan,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _invalidate_stale_device_baselines(device: Dict[str, Any]) -> None:
    """设备共享配置或测试内容变化后，使不匹配的 Baseline 立即失效。"""
    for test_case in device.get("tests") or []:
        baseline = test_case.get("baseline")
        if not isinstance(baseline, Mapping):
            continue
        fingerprint = _workspace_baseline_fingerprint(device, test_case)
        if str(baseline.get("fingerprint") or "") == fingerprint:
            continue
        test_case["baseline"] = {
            "status": "invalid",
            "fingerprint": fingerprint,
            "error": "测试配置已修改，等待重新计算 Heuristic Baseline",
            "updatedAt": _workspace_timestamp(),
        }


def _successful_baseline(
    fingerprint: str,
    result: Mapping[str, Any],
) -> Dict[str, Any]:
    """把成功的 Heuristic 结果转换成可持久化基线。"""
    return {
        "status": "succeeded",
        "fingerprint": fingerprint,
        "makespan": float(result["makespan"]),
        "cpuTimeMs": float(result.get("cpuTimeMs", result.get("totalElapsedMs", 0.0))),
        "updatedAt": _workspace_timestamp(),
    }


def _failed_baseline(fingerprint: str, error: BaseException) -> Dict[str, Any]:
    """把基线计算异常转换成可持久化失败状态。"""
    return {
        "status": "failed",
        "fingerprint": fingerprint,
        "error": str(error) or type(error).__name__,
        "updatedAt": _workspace_timestamp(),
    }


def _baseline_comparison(
    result: Mapping[str, Any],
    baseline: Mapping[str, Any],
) -> Dict[str, Any]:
    """为前端生成当前值、Baseline 和改善比例。"""
    fields = {"baseline": deepcopy(dict(baseline))}
    if baseline.get("status") != "succeeded":
        return fields
    current_makespan = float(result["makespan"])
    baseline_makespan = float(baseline["makespan"])
    current_cpu = float(result.get("cpuTimeMs", result.get("totalElapsedMs", 0.0)))
    baseline_cpu = float(baseline["cpuTimeMs"])
    fields.update({
        "cpuTimeMs": current_cpu,
        "makespanDelta": current_makespan - baseline_makespan,
        "cpuTimeDeltaMs": current_cpu - baseline_cpu,
        "improvementPercent": (
            (baseline_makespan - current_makespan) / baseline_makespan * 100.0
            if abs(baseline_makespan) > 1e-12 else 0.0
        ),
    })
    return fields


def _is_external_algorithm(strategy: str) -> bool:
    """判断策略是否来自 ``other_alg`` 标准算法包。"""
    return str(strategy or "").strip().casefold().startswith("other_alg:")


def _skipped_baseline(fingerprint: str) -> Dict[str, Any]:
    """构造用户显式跳过 Baseline 时的占位记录。"""
    return {
        "status": "skipped",
        "fingerprint": fingerprint,
        "updatedAt": _workspace_timestamp(),
    }


def _execute_workspace_test_with_baseline(
    device: Mapping[str, Any],
    test_case: Mapping[str, Any],
    strategy: str,
    options: Mapping[str, Any],
    *,
    selected_plan: Optional[Mapping[str, Any]] = None,
    skip_validation: bool = False,
    skip_baseline: bool = False,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any], Optional[Exception]]:
    """确保 Baseline 有效并执行所选策略；Baseline 失败不复用旧值。

    ``skip_baseline`` 为 True 时既不计算也不复用 Baseline，返回 ``skipped``
    占位记录，避免因缺失 Baseline 连带运行本地 heuristic 触发其自身校验。
    """
    fingerprint = _workspace_baseline_fingerprint(device, test_case, options)
    existing = test_case.get("baseline")
    if skip_baseline:
        # 显式跳过：即使存在指纹匹配的旧基线也不读取，统一按缺失处理。
        baseline = None
    else:
        baseline = (
            deepcopy(dict(existing))
            if isinstance(existing, Mapping)
            and existing.get("status") == "succeeded"
            and str(existing.get("fingerprint") or "") == fingerprint
            else None
        )
    device_id = str(device.get("id") or "")
    test_id = str(test_case.get("id") or "")

    def record(value: Mapping[str, Any]) -> Dict[str, Any]:
        """同步更新内存测试项与工作区中的基线记录。"""
        stored = deepcopy(dict(value))
        if isinstance(test_case, dict):
            test_case["baseline"] = deepcopy(stored)
        _persist_workspace_baseline(device_id, test_id, stored)
        return stored

    if strategy == "heuristic":
        plan = dict(selected_plan) if selected_plan is not None else build_workspace_batch_plan(
            device, test_case, "heuristic", options, skip_validation=skip_validation,
        )
        try:
            result = execute_plan(plan)
        except Exception as error:  # noqa: BLE001
            return None, record(_failed_baseline(fingerprint, error)), error
        if skip_baseline:
            return result, _skipped_baseline(fingerprint), None
        baseline = record(_successful_baseline(fingerprint, result))
        return result, baseline, None

    if baseline is None and not skip_baseline:
        try:
            baseline_result = execute_plan(build_workspace_batch_plan(
                device, test_case, "heuristic", options, skip_validation=skip_validation,
            ))
            baseline = record(_successful_baseline(fingerprint, baseline_result))
        except Exception as error:  # noqa: BLE001
            baseline = record(_failed_baseline(fingerprint, error))
    if baseline is None:
        baseline = _skipped_baseline(fingerprint)

    plan = dict(selected_plan) if selected_plan is not None else build_workspace_batch_plan(
        device, test_case, strategy, options, skip_validation=skip_validation,
    )
    try:
        return execute_plan(plan), baseline, None
    except Exception as error:  # noqa: BLE001
        return None, baseline, error


def _workspace_group_tests(
    device: Mapping[str, Any],
    group: str,
) -> Tuple[str, List[Mapping[str, Any]]]:
    """返回规范化组名及该组按工作区顺序排列的测试。"""
    normalized_group = str(group or "").strip()
    tests = [
        row for row in (device.get("tests") or [])
        if isinstance(row, Mapping)
        and str(row.get("group") or "").strip() == normalized_group
    ]
    if not tests:
        raise ValueError(f"当前测试组“{normalized_group or '未分组'}”没有可运行测试")
    return normalized_group, tests


def _execute_workspace_test_batch(
    device: Mapping[str, Any],
    tests: Sequence[Mapping[str, Any]],
    group: str,
    strategy: str,
    options: Mapping[str, Any],
    *,
    skip_validation: bool = False,
    skip_baseline: bool = False,
    maximum_workers: int = 4,
    progress_callback: Optional[Any] = None,
    cancel_event: Optional[threading.Event] = None,
) -> Dict[str, Any]:
    """执行已解析的批量测试，并通过回调报告每项状态变化。"""
    worker_count = max(1, min(int(maximum_workers), 4, len(tests)))
    started = time.perf_counter()

    def run_one(index: int, test_case: Mapping[str, Any]) -> Dict[str, Any]:
        """执行单个测试并生成统一的批处理结果项。"""
        if cancel_event is not None and cancel_event.is_set():
            return {
                "index": index,
                "ok": False,
                "status": "cancelled",
                "testId": str(test_case.get("id") or ""),
                "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                "error": "用户终止调度",
            }
        if progress_callback is not None:
            progress_callback(index, {"status": "running", "startedAt": _workspace_timestamp()})
        run_started = time.perf_counter()
        try:
            selected_plan = build_workspace_batch_plan(
                device, test_case, strategy, options,
                skip_validation=skip_validation,
            )
            result, baseline, run_error = _execute_workspace_test_with_baseline(
                device,
                test_case,
                strategy,
                options,
                selected_plan=selected_plan,
                skip_validation=skip_validation,
                skip_baseline=skip_baseline,
            )
            if run_error is not None or result is None:
                error = run_error or RuntimeError("运行未返回结果")
                failure = {
                    "index": index,
                    "ok": False,
                    "status": "failed",
                    "testId": str(test_case.get("id") or ""),
                    "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                    "error": str(error) or type(error).__name__,
                    "baseline": deepcopy(baseline),
                }
                if isinstance(error, LoggedPlanError):
                    log_id = save_reproduction_log(error.reproduction_log)
                    failure.update(_log_response_fields(log_id))
                    failure.update(_logged_failure_result_fields(error))
                    # 外部算法的 MoveList 即使未通过平台校验，仍是该算法的原始
                    # 输出。保留其客观指标、Baseline 对比和诊断入口；状态仍为
                    # failed，避免误把无效计划计入校验通过的成功结果。
                    if _is_external_algorithm(strategy) and error.validation_issues:
                        elapsed_ms = (time.perf_counter() - run_started) * 1000.0
                        moves = list((error.failure_output or {}).get("MoveList") or [])
                        failure.update({
                            "metricsAvailable": True,
                            "totalElapsedMs": elapsed_ms,
                            "cpuTimeMs": elapsed_ms,
                            "robotWaferDwellTime": _robot_wafer_dwell_time(moves),
                        })
                        failure.update(_baseline_comparison(failure, baseline))
                return failure
            if cancel_event is not None and cancel_event.is_set():
                return {
                    "index": index,
                    "ok": False,
                    "status": "cancelled",
                    "testId": str(test_case.get("id") or ""),
                    "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                    "error": "用户终止调度",
                }
            artifact = deepcopy(dict(result["output"]))
            artifact["ReplayContext"] = {
                "schema": "machine-replay-context-v1",
                "plan": deepcopy(selected_plan),
                "updates": deepcopy(list(result.get("updates") or [])),
            }
            result_id = save_result(artifact)
            log_id = save_reproduction_log(result["reproductionLog"])
            robot_wafer_dwell_time = _robot_wafer_dwell_time(
                list(result["output"].get("MoveList") or []),
            )
            item = {
                "index": index,
                "ok": True,
                "status": "succeeded",
                "testId": str(test_case.get("id") or ""),
                "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                "totalElapsedMs": result["totalElapsedMs"],
                "cpuTimeMs": result.get("cpuTimeMs", result["totalElapsedMs"]),
                "makespan": result["makespan"],
                "moveCount": result["moveCount"],
                "validation": result["validation"],
                "robotWaferDwellTime": robot_wafer_dwell_time,
                "resultUrl": f"/api/results/{result_id}",
                "ganttUrl": f"/movelist_gantt_viewer.html?src=/api/results/{result_id}",
                **_log_response_fields(log_id),
                **_baseline_comparison(result, baseline),
            }
            return item
        except Exception as error:  # noqa: BLE001
            return {
                "index": index,
                "ok": False,
                "status": "failed",
                "testId": str(test_case.get("id") or ""),
                "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                "error": str(error) or type(error).__name__,
            }

    items: List[Dict[str, Any]] = []
    executor = ThreadPoolExecutor(max_workers=worker_count)
    futures = {
        executor.submit(run_one, index, test_case): index
        for index, test_case in enumerate(tests)
    }
    pending = set(futures)
    cancelled = False
    try:
        while pending:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            done, pending = wait(pending, timeout=0.1, return_when=FIRST_COMPLETED)
            for future in done:
                item = future.result()
                items.append(item)
                if progress_callback is not None:
                    progress_callback(int(item["index"]), item)
    finally:
        if cancelled:
            for future in pending:
                future.cancel()
            executor.shutdown(wait=False, cancel_futures=True)
        else:
            executor.shutdown(wait=True)
    items.sort(key=lambda item: int(item["index"]))
    succeeded = sum(bool(item["ok"]) for item in items)
    batch_result = {
        "ok": not cancelled and succeeded == len(items),
        "strategy": strategy,
        "group": group,
        "status": "cancelled" if cancelled else "completed",
        "completed": len(items),
        "testCount": len(items),
        "succeeded": succeeded,
        "failed": len(items) - succeeded,
        "cancelled": len(tests) - len(items) if cancelled else 0,
        "workerCount": worker_count,
        "totalElapsedMs": (time.perf_counter() - started) * 1000.0,
        "items": items,
    }
    return batch_result


def run_workspace_test_batch(
    device_id: str,
    group: str,
    strategy: str,
    options: Mapping[str, Any],
    *,
    skip_validation: bool = False,
    skip_baseline: bool = False,
    maximum_workers: int = 4,
) -> Dict[str, Any]:
    """同步运行当前测试组；保留给测试和非 HTTP 调用方。"""
    device = get_workspace_device(device_id)
    normalized_group, tests = _workspace_group_tests(device, group)
    result = _execute_workspace_test_batch(
        device,
        tests,
        normalized_group,
        strategy,
        options,
        skip_validation=skip_validation,
        skip_baseline=skip_baseline,
        maximum_workers=maximum_workers,
    )
    result.update({
        "deviceId": device_id,
        "deviceName": str(device.get("name") or ""),
    })
    return result


def read_workspace_batch_run(batch_id: str) -> Optional[Dict[str, Any]]:
    """读取后台批量任务的当前快照。"""
    with _BATCH_RUNS_LOCK:
        batch = _BATCH_RUNS.get(batch_id)
        return deepcopy(batch) if batch is not None else None


def cancel_workspace_batch_run(batch_id: str) -> Optional[Dict[str, Any]]:
    """终止批量任务；排队和运行项立即进入终止状态。"""
    with _BATCH_RUNS_LOCK:
        batch = _BATCH_RUNS.get(batch_id)
        if batch is None:
            return None
        if batch.get("status") in {"completed", "failed", "cancelled"}:
            return deepcopy(batch)
        cancel_event = _BATCH_CANCEL_EVENTS.get(batch_id)
        if cancel_event is not None:
            cancel_event.set()
        for item in batch.get("items") or []:
            if item.get("status") in {"queued", "running"}:
                item.update({
                    "ok": False,
                    "status": "cancelled",
                    "error": "用户终止调度",
                })
        batch["ok"] = False
        batch["status"] = "cancelled"
        batch["completed"] = len(batch.get("items") or [])
        batch["succeeded"] = sum(item.get("status") == "succeeded" for item in batch.get("items") or [])
        batch["failed"] = sum(item.get("status") == "failed" for item in batch.get("items") or [])
        batch["cancelled"] = sum(item.get("status") == "cancelled" for item in batch.get("items") or [])
        batch["finishedAt"] = _workspace_timestamp()
        return deepcopy(batch)


def start_workspace_test_batch(
    device_id: str,
    group: str,
    strategy: str,
    options: Mapping[str, Any],
    *,
    skip_validation: bool = False,
    skip_baseline: bool = False,
    maximum_workers: int = 4,
) -> Dict[str, Any]:
    """创建后台批量任务并立即返回可轮询的初始状态。"""
    device = get_workspace_device(device_id)
    normalized_group, tests = _workspace_group_tests(device, group)
    batch_id = uuid.uuid4().hex
    worker_count = max(1, min(int(maximum_workers), 4, len(tests)))
    initial = {
        "batchId": batch_id,
        "ok": True,
        "status": "queued",
        "strategy": strategy,
        "group": normalized_group,
        "deviceId": device_id,
        "deviceName": str(device.get("name") or ""),
        "testCount": len(tests),
        "completed": 0,
        "succeeded": 0,
        "failed": 0,
        "cancelled": 0,
        "workerCount": worker_count,
        "totalElapsedMs": 0.0,
        "createdAt": _workspace_timestamp(),
        "items": [{
            "index": index,
            "ok": None,
            "status": "queued",
            "testId": str(test_case.get("id") or ""),
            "testName": str(test_case.get("name") or f"测试 {index + 1}"),
        } for index, test_case in enumerate(tests)],
    }
    cancel_event = threading.Event()
    with _BATCH_RUNS_LOCK:
        _BATCH_RUNS[batch_id] = initial
        _BATCH_CANCEL_EVENTS[batch_id] = cancel_event
        _BATCH_RUNS.move_to_end(batch_id)
        while len(_BATCH_RUNS) > MAX_SAVED_BATCH_RUNS:
            expired_id, _ = _BATCH_RUNS.popitem(last=False)
            _BATCH_CANCEL_EVENTS.pop(expired_id, None)

    def update_item(index: int, values: Mapping[str, Any]) -> None:
        """原子更新批处理条目与汇总计数。"""
        with _BATCH_RUNS_LOCK:
            batch = _BATCH_RUNS.get(batch_id)
            if batch is None or cancel_event.is_set() or batch.get("status") == "cancelled":
                return
            batch["status"] = "running"
            batch["items"][index].update(deepcopy(dict(values)))
            batch["completed"] = sum(
                item.get("status") in {"succeeded", "failed"}
                for item in batch["items"]
            )
            batch["succeeded"] = sum(item.get("status") == "succeeded" for item in batch["items"])
            batch["failed"] = sum(item.get("status") == "failed" for item in batch["items"])

    def background() -> None:
        """在后台执行批处理并提交最终运行状态。"""
        try:
            result = _execute_workspace_test_batch(
                device,
                tests,
                normalized_group,
                strategy,
                options,
                skip_validation=skip_validation,
                skip_baseline=skip_baseline,
                maximum_workers=worker_count,
                progress_callback=update_item,
                cancel_event=cancel_event,
            )
            with _BATCH_RUNS_LOCK:
                batch = _BATCH_RUNS.get(batch_id)
                if batch is not None and not cancel_event.is_set() and batch.get("status") != "cancelled":
                    batch.update(result)
                    batch["batchId"] = batch_id
                    batch["finishedAt"] = _workspace_timestamp()
        except Exception as error:  # noqa: BLE001
            with _BATCH_RUNS_LOCK:
                batch = _BATCH_RUNS.get(batch_id)
                if batch is not None and not cancel_event.is_set() and batch.get("status") != "cancelled":
                    batch["ok"] = False
                    batch["status"] = "failed"
                    batch["error"] = str(error) or type(error).__name__
                    batch["finishedAt"] = _workspace_timestamp()

    threading.Thread(
        target=background,
        name=f"batch-run-{batch_id[:8]}",
        daemon=True,
    ).start()
    return deepcopy(initial)
