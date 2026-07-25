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
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from realtime_scheduler.plan_builder import (
    _finite_number,
    _round_cjob_rows,
    _runtime_clean,
    _stage_visit_rows,
    _string_list,
)

_SERVER_SERVICES: Optional[ModuleType] = None


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

    clean_modules: Dict[str, List[str]] = {}

    def add_clean_modules(names: Any, modules: Iterable[Any]) -> None:
        """记录清洗配方可使用的腔室集合。"""
        module_names = _string_list(list(modules))
        for clean_name in _string_list(names):
            targets = clean_modules.setdefault(clean_name, [])
            for module_name in module_names:
                if module_name not in targets:
                    targets.append(module_name)

    for route in routes:
        route_modules: List[str] = []
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
                if process_recipe and module_name and module_name not in route_modules:
                    route_modules.append(module_name)
                if module_name:
                    add_clean_modules(
                        visit.get("beforeCleanRefs") or visit.get("BeforeInPM"),
                        [module_name],
                    )
                    add_clean_modules(
                        visit.get("afterCleanRefs") or visit.get("AfterOutPM"),
                        [module_name],
                    )
        for field_name in (
            "prePJobCleanRefs",
            "postPJobCleanRefs",
            "postCJobCleanRefs",
        ):
            add_clean_modules(route.get(field_name), route_modules)
    for clean in cleans:
        runtime_clean = _runtime_clean(clean)
        modules = clean_modules.get(str(runtime_clean.get("name") or ""), [])
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
) -> Dict[str, Any]:
    """将持久化测试与设备共享库组合成可直接执行的单次请求。"""
    rounds = [
        deepcopy(dict(row))
        for row in (test_case.get("rounds") or [])
        if isinstance(row, Mapping)
    ]
    routes = _batch_test_routes(
        [row for row in (device.get("routes") or []) if isinstance(row, Mapping)],
        rounds,
    )
    cleans = [
        _runtime_clean(clean)
        for clean in _batch_test_cleans(
            [
                row
                for row in (device.get("cleans") or [])
                if isinstance(row, Mapping)
            ],
            routes,
        )
    ]
    merged_options = deepcopy(dict(test_case.get("options") or {}))
    merged_options.update(deepcopy(dict(options)))
    return {
        "schemaVersion": API_SCHEMA_VERSION,
        "deviceName": str(device.get("name") or "selected init"),
        "device": deepcopy(device.get("device")),
        "strategy": str(strategy or "heuristic"),
        "roundCount": len(rounds),
        "options": merged_options,
        "recipes": _batch_test_recipes(routes, cleans),
        "cleans": cleans,
        "routes": routes,
        "rounds": rounds,
    }


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


def _execute_workspace_test_with_baseline(
    device: Mapping[str, Any],
    test_case: Mapping[str, Any],
    strategy: str,
    options: Mapping[str, Any],
    *,
    selected_plan: Optional[Mapping[str, Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any], Optional[Exception]]:
    """确保 Baseline 有效并执行所选策略；Baseline 失败不复用旧值。"""
    fingerprint = _workspace_baseline_fingerprint(device, test_case, options)
    existing = test_case.get("baseline")
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
            device, test_case, "heuristic", options,
        )
        try:
            result = execute_plan(plan)
        except Exception as error:  # noqa: BLE001
            return None, record(_failed_baseline(fingerprint, error)), error
        baseline = record(_successful_baseline(fingerprint, result))
        return result, baseline, None

    if baseline is None:
        try:
            baseline_result = execute_plan(build_workspace_batch_plan(
                device, test_case, "heuristic", options,
            ))
            baseline = record(_successful_baseline(fingerprint, baseline_result))
        except Exception as error:  # noqa: BLE001
            baseline = record(_failed_baseline(fingerprint, error))

    plan = dict(selected_plan) if selected_plan is not None else build_workspace_batch_plan(
        device, test_case, strategy, options,
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
        try:
            result, baseline, run_error = _execute_workspace_test_with_baseline(
                device, test_case, strategy, options,
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
            result_id = save_result(result["output"])
            log_id = save_reproduction_log(result["reproductionLog"])
            return {
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
                "resultUrl": f"/api/results/{result_id}",
                "ganttUrl": f"/movelist_gantt_viewer.html?src=/api/results/{result_id}",
                **_log_response_fields(log_id),
                **_baseline_comparison(result, baseline),
            }
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
    return {
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


def run_workspace_test_batch(
    device_id: str,
    group: str,
    strategy: str,
    options: Mapping[str, Any],
    *,
    maximum_workers: int = 4,
) -> Dict[str, Any]:
    """同步运行当前测试组；保留给测试和非 HTTP 调用方。"""
    device = get_workspace_device(device_id)
    normalized_group, tests = _workspace_group_tests(device, group)
    return _execute_workspace_test_batch(
        device,
        tests,
        normalized_group,
        strategy,
        options,
        maximum_workers=maximum_workers,
    )


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
