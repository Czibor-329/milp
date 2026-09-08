"""测试组结果分析后台任务。

本模块拥有分析任务的生命周期、进度、取消、时间预算和结果缓存。指标定义与计算仍由
``backend.analysis`` 负责，运行制品仍由 ``backend.artifacts`` 负责；HTTP 层只传递
任务请求和快照，不在请求线程中执行整组 MoveList 分析。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional, Sequence

from realtime_scheduler.backend.analysis import (
    analyze_schedule_performance,
    analyze_test_group_performance,
    build_schedule_analysis_context,
    normalize_move_payload,
)
from realtime_scheduler.backend.artifacts.repository import read_result

ANALYSIS_JOB_LIMIT = 32
ANALYSIS_CACHE_LIMIT = 256
MINIMUM_TIME_BUDGET_SECONDS = 10
MAXIMUM_TIME_BUDGET_SECONDS = 600
SUPPORTED_METRIC_GROUPS = frozenset({
    "basic", "throughput", "residence", "resources", "bottleneck", "loadlock",
})
METRIC_GROUP_BY_ID = {
    "validation": "basic",
    "makespan": "basic",
    "baseline_improvement": "basic",
    "cpu_time": "basic",
    "average_recompute_time": "basic",
    "throughput": "throughput",
    "departure_interval_cv": "throughput",
    "process_chamber_dwell": "residence",
    "robot_wafer_dwell": "residence",
    "system_residence": "residence",
    "system_residence_cv": "residence",
    # 组级“资源利用率”展示主要瓶颈候选的利用率；瓶颈阶段会复用资源占用计算。
    "resource_utilization": "bottleneck",
    "bottleneck_candidates": "bottleneck",
    "loadlock_wafers_per_cycle": "loadlock",
    "loadlock_full_cycle_ratio": "loadlock",
    "loadlock_empty_cycle_ratio": "loadlock",
}
STAGE_LABELS = {
    "prepare": "准备结果数据",
    "resources": "计算资源利用率",
    "bottleneck": "识别瓶颈候选",
    "throughput": "计算产能指标",
    "residence": "计算驻留指标",
    "loadlock": "计算 LoadLock 指标",
    "complete": "整理测试结果",
}

_ANALYSIS_JOBS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_ANALYSIS_JOBS_LOCK = threading.RLock()
_ANALYSIS_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_ANALYSIS_CACHE_LOCK = threading.RLock()


def _timestamp() -> str:
    """返回供前端展示的 UTC 时间戳。"""
    return datetime.now(timezone.utc).isoformat()


def _snapshot(job: Mapping[str, Any]) -> Dict[str, Any]:
    """复制可公开的任务字段，排除线程事件和原始请求。"""
    return deepcopy({key: value for key, value in job.items() if not key.startswith("_")})


def _update(job_id: str, **changes: Any) -> None:
    """在线程安全边界内更新任务状态。"""
    with _ANALYSIS_JOBS_LOCK:
        job = _ANALYSIS_JOBS.get(job_id)
        if job is None:
            return
        job.update(changes)
        job["updatedAt"] = _timestamp()


def _stable_hash(value: Any) -> str:
    """为分析上下文生成与 JSON 字段顺序无关的稳定摘要。"""
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _cache_key(
    result_id: str,
    device: Mapping[str, Any],
    routes: Sequence[Mapping[str, Any]],
    rounds: Sequence[Mapping[str, Any]],
    window_mode: str,
    metric_groups: Sequence[str],
) -> str:
    """组合结果、配置、窗口和指标选择，避免复用口径不同的分析。"""
    return _stable_hash({
        "resultId": result_id,
        "device": device,
        "routes": routes,
        "rounds": rounds,
        "windowMode": window_mode,
        "metricGroups": sorted(metric_groups),
        "analysisVersion": 1,
    })


def _read_cached(key: str) -> Optional[Dict[str, Any]]:
    """读取缓存并刷新最近使用顺序。"""
    with _ANALYSIS_CACHE_LOCK:
        value = _ANALYSIS_CACHE.get(key)
        if value is None:
            return None
        _ANALYSIS_CACHE.move_to_end(key)
        return deepcopy(value)


def _save_cached(key: str, value: Mapping[str, Any]) -> None:
    """保存一次单测分析，并限制进程内缓存大小。"""
    with _ANALYSIS_CACHE_LOCK:
        _ANALYSIS_CACHE[key] = deepcopy(dict(value))
        _ANALYSIS_CACHE.move_to_end(key)
        while len(_ANALYSIS_CACHE) > ANALYSIS_CACHE_LIMIT:
            _ANALYSIS_CACHE.popitem(last=False)


def create_test_group_analysis_job(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """校验请求、创建后台任务并立即返回初始快照。"""
    raw_cases = payload.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError("至少选择一个可分析测试")
    if not all(isinstance(item, Mapping) for item in raw_cases):
        raise ValueError("cases 的每一项都必须是 JSON 对象")
    device = payload.get("device")
    routes = payload.get("routes", [])
    if not isinstance(device, Mapping):
        raise ValueError("device 必须是 JSON 对象")
    if not isinstance(routes, list):
        raise ValueError("routes 必须是数组")
    raw_metric_ids = payload.get("metricIds")
    if raw_metric_ids is not None:
        if not isinstance(raw_metric_ids, list) or not all(isinstance(item, str) for item in raw_metric_ids):
            raise ValueError("metricIds 必须是字符串数组")
        unknown_metric_ids = set(raw_metric_ids) - set(METRIC_GROUP_BY_ID)
        if unknown_metric_ids:
            raise ValueError(f"不支持的分析指标：{', '.join(sorted(unknown_metric_ids))}")
        if not raw_metric_ids:
            raise ValueError("请至少选择一个计算指标")
        metric_groups = {METRIC_GROUP_BY_ID[metric_id] for metric_id in raw_metric_ids}
    else:
        metric_groups = set(payload.get("metricGroups") or ["basic"])
    unknown_groups = metric_groups - SUPPORTED_METRIC_GROUPS
    if unknown_groups:
        raise ValueError(f"不支持的分析指标组：{', '.join(sorted(unknown_groups))}")
    metric_groups.add("basic")
    time_budget = int(payload.get("timeBudgetSeconds") or 120)
    if not MINIMUM_TIME_BUDGET_SECONDS <= time_budget <= MAXIMUM_TIME_BUDGET_SECONDS:
        raise ValueError(
            f"分析时间预算必须在 {MINIMUM_TIME_BUDGET_SECONDS}~{MAXIMUM_TIME_BUDGET_SECONDS} 秒之间"
        )
    window_mode = str(payload.get("windowMode") or "steady")
    if window_mode not in {"steady", "full"}:
        raise ValueError("分析窗口只支持 steady 或 full")

    job_id = uuid.uuid4().hex
    now = _timestamp()
    job: Dict[str, Any] = {
        "id": job_id,
        "status": "queued",
        "phase": "queued",
        "progress": 0,
        "message": "等待开始分析",
        "completedCases": 0,
        "totalCases": len(raw_cases),
        "currentCaseName": "",
        "timeBudgetSeconds": time_budget,
        "elapsedSeconds": 0.0,
        "selectedMetricGroups": sorted(metric_groups),
        "selectedMetricIds": list(raw_metric_ids or []),
        "createdAt": now,
        "updatedAt": now,
        "result": None,
        "_cancel": threading.Event(),
        "_payload": deepcopy(dict(payload)),
    }
    with _ANALYSIS_JOBS_LOCK:
        _ANALYSIS_JOBS[job_id] = job
        while len(_ANALYSIS_JOBS) > ANALYSIS_JOB_LIMIT:
            _ANALYSIS_JOBS.popitem(last=False)
    threading.Thread(
        target=_run_test_group_analysis_job,
        args=(job_id,),
        name=f"group-analysis-{job_id[:8]}",
        daemon=True,
    ).start()
    return _snapshot(job)


def read_test_group_analysis_job(job_id: str) -> Optional[Dict[str, Any]]:
    """读取分析任务快照，并实时补充已用时间。"""
    with _ANALYSIS_JOBS_LOCK:
        job = _ANALYSIS_JOBS.get(job_id)
        if job is None:
            return None
        snapshot = _snapshot(job)
        started = job.get("_startedMonotonic")
    if isinstance(started, float) and snapshot["status"] in {"queued", "running"}:
        snapshot["elapsedSeconds"] = round(time.monotonic() - started, 1)
    return snapshot


def cancel_test_group_analysis_job(job_id: str) -> Dict[str, Any]:
    """请求协作式取消；当前指标阶段结束后任务会停止。"""
    with _ANALYSIS_JOBS_LOCK:
        job = _ANALYSIS_JOBS.get(job_id)
        if job is None:
            raise LookupError("分析任务不存在或已过期")
        if job["status"] in {"completed", "partial", "cancelled", "failed"}:
            return _snapshot(job)
        job["_cancel"].set()
        job["message"] = "正在取消分析"
        job["updatedAt"] = _timestamp()
        return _snapshot(job)


def _run_test_group_analysis_job(job_id: str) -> None:
    """逐测试计算所选指标，在截止时间到达时返回已完成的部分报告。"""
    with _ANALYSIS_JOBS_LOCK:
        job = _ANALYSIS_JOBS.get(job_id)
        if job is None:
            return
        payload = deepcopy(job["_payload"])
        cancel_event = job["_cancel"]
        job["_startedMonotonic"] = time.monotonic()
        started = job["_startedMonotonic"]
    deadline = started + float(job["timeBudgetSeconds"])
    raw_cases = list(payload["cases"])
    device = dict(payload["device"])
    routes = list(payload.get("routes") or [])
    metric_groups = list(job["selectedMetricGroups"])
    window_mode = str(payload.get("windowMode") or "steady")
    results = []
    cache_hits = 0
    timed_out = False
    _update(job_id, status="running", phase="prepare", progress=1, message="正在准备分析数据")

    try:
        for case_index, raw_case in enumerate(raw_cases):
            if cancel_event.is_set() or time.monotonic() >= deadline:
                timed_out = not cancel_event.is_set()
                break
            case = dict(raw_case)
            case_name = str(case.get("name") or f"测试 {case_index + 1}")
            result_row = {
                key: case.get(key)
                for key in (
                    "id", "name", "status", "validation", "makespan",
                    "baselineMakespan", "cpuTimeMs", "elapsedTimeMs", "error",
                    "comparisonKey",
                )
            }
            result_id = str(case.get("resultId") or "")
            rounds = case.get("rounds") or []
            if not result_id or not isinstance(rounds, list):
                result_row["performance"] = None
                result_row["analysisStatus"] = "unavailable"
                results.append(result_row)
                continue
            cache_key = _cache_key(result_id, device, routes, rounds, window_mode, metric_groups)
            performance = _read_cached(cache_key)
            if performance is not None:
                cache_hits += 1
            else:
                saved_result = read_result(result_id)
                if saved_result is None:
                    result_row["performance"] = None
                    result_row["analysisStatus"] = "expired"
                    result_row["error"] = "结果不存在或已过期"
                    results.append(result_row)
                    continue
                run_metrics = saved_result.get("RunMetricsMetadata")
                if not isinstance(run_metrics, Mapping):
                    run_metrics = {
                        "cpuTimeMs": case.get("cpuTimeMs"),
                        "recomputeCount": len(list(saved_result.get("RecomputePoints") or [])) + 1,
                    }
                stage_count = max(1, len(metric_groups) + 1)

                def report(stage: str) -> None:
                    """把单测指标阶段映射为整组任务百分比。"""
                    phase_index = min(
                        stage_count - 1,
                        list(STAGE_LABELS).index(stage) if stage in STAGE_LABELS else 0,
                    )
                    progress = round(
                        ((case_index + phase_index / stage_count) / len(raw_cases)) * 100
                    )
                    _update(
                        job_id,
                        phase=stage,
                        progress=max(1, min(99, progress)),
                        message=STAGE_LABELS.get(stage, "正在分析"),
                        currentCaseName=case_name,
                        completedCases=case_index,
                    )

                performance = analyze_schedule_performance(
                    normalize_move_payload(saved_result),
                    device,
                    window_mode,
                    build_schedule_analysis_context(routes, rounds),
                    run_metrics,
                    metric_groups=metric_groups,
                    progress_callback=report,
                    should_stop=lambda: cancel_event.is_set() or time.monotonic() >= deadline,
                )
                _save_cached(cache_key, performance)
            result_row["performance"] = performance
            result_row["analysisStatus"] = "completed"
            results.append(result_row)
            _update(
                job_id,
                completedCases=case_index + 1,
                progress=min(99, round((case_index + 1) / len(raw_cases) * 100)),
                currentCaseName=case_name,
            )
    except TimeoutError:
        timed_out = not cancel_event.is_set()
    except Exception as error:  # noqa: BLE001
        _update(
            job_id,
            status="failed",
            phase="failed",
            message=str(error),
            elapsedSeconds=round(time.monotonic() - started, 1),
        )
        return

    completed_ids = {str(item.get("id") or "") for item in results}
    for raw_case in raw_cases:
        if str(raw_case.get("id") or "") in completed_ids:
            continue
        pending = dict(raw_case)
        pending["performance"] = None
        pending["analysisStatus"] = "timeout" if timed_out else "cancelled"
        pending["error"] = "超过分析时间预算" if timed_out else "用户已取消分析"
        results.append(pending)
    summary = analyze_test_group_performance(
        results,
        str(payload.get("referenceCaseId") or ""),
    )
    summary["selectedMetricGroups"] = sorted(metric_groups)
    summary["selectedMetricIds"] = list(job["selectedMetricIds"])
    summary["cacheHitCount"] = cache_hits
    summary["timedOut"] = timed_out
    final_status = "cancelled" if cancel_event.is_set() else "partial" if timed_out else "completed"
    _update(
        job_id,
        status=final_status,
        phase=final_status,
        progress=100,
        completedCases=sum(item.get("analysisStatus") == "completed" for item in results),
        currentCaseName="",
        message=(
            "分析已取消，已保留完成部分"
            if final_status == "cancelled"
            else "达到时间预算，已生成部分结果"
            if final_status == "partial"
            else "分析完成"
        ),
        elapsedSeconds=round(time.monotonic() - started, 1),
        result=summary,
    )
