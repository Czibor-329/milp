"""服务端本地运行偏好仓库。

本模块负责 ``data/run_preferences.json`` 的版本、校验和原子写入。该文件保存
当前安装实例共享的运行与结果分析习惯，不属于设备/测试集主数据，也不进入交换包。
"""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from realtime_scheduler.backend.bootstrap import DATA_DIR
from realtime_scheduler.backend.execution.batch_service import (
    DEFAULT_BATCH_WORKERS,
    MAXIMUM_BATCH_WORKERS,
)
from realtime_scheduler.backend.execution.validation_limiter import (
    DEFAULT_VALIDATION_WORKERS,
    MAXIMUM_VALIDATION_WORKERS,
)
from realtime_scheduler.backend.workspace.repository import _write_json_atomic


RUN_PREFERENCES_SCHEMA_VERSION = 5
RUN_PREFERENCES_PATH = DATA_DIR / "run_preferences.json"
_RUN_PREFERENCES_LOCK = threading.RLock()
_BOOLEAN_FIELDS = (
    "hongYeCheck",
    "skipBaseline",
    "executionTimingEnabled",
)
_CLEAN_VALIDATION_TYPES = (
    "preclean", "postclean", "wacclean", "dummy", "dummywac",
)
_DEFAULT_RUN_SETTINGS = {
    "hongYeCheck": True,
    "skipBaseline": True,
    "executionTimingEnabled": False,
    "maximumWorkers": DEFAULT_BATCH_WORKERS,
    "validationWorkers": DEFAULT_VALIDATION_WORKERS,
    "cleanValidationTypes": list(_CLEAN_VALIDATION_TYPES),
}
_ANALYSIS_METRIC_IDS = (
    "validation", "makespan", "baseline_improvement", "cpu_time",
    "average_recompute_time", "throughput", "departure_interval_cv",
    "process_chamber_dwell", "robot_wafer_dwell", "system_residence",
    "system_residence_cv", "resource_utilization", "bottleneck_candidates",
    "loadlock_wafers_per_cycle", "loadlock_full_cycle_ratio",
    "loadlock_empty_cycle_ratio",
)
_DEFAULT_ANALYSIS_SETTINGS = {
    "metricIds": list(_ANALYSIS_METRIC_IDS),
    "windowMode": "steady",
    "timeBudgetSeconds": 120,
}


def _validate_run_settings(value: Mapping[str, Any]) -> Dict[str, Any]:
    """校验并规范化 API 提交的完整运行设置，非法字段抛出 ValueError。"""
    normalized: Dict[str, Any] = {}
    for field in _BOOLEAN_FIELDS:
        field_value = value.get(field)
        if not isinstance(field_value, bool):
            raise ValueError(f"{field} 必须是布尔值")
        normalized[field] = field_value
    for field, minimum, maximum in (
        ("maximumWorkers", 1, MAXIMUM_BATCH_WORKERS),
        ("validationWorkers", 1, MAXIMUM_VALIDATION_WORKERS),
    ):
        field_value = value.get(field)
        if isinstance(field_value, bool) or not isinstance(field_value, int):
            raise ValueError(f"{field} 必须是整数")
        if not minimum <= field_value <= maximum:
            raise ValueError(f"{field} 必须在 {minimum} 到 {maximum} 之间")
        normalized[field] = field_value
    clean_validation_types = value.get("cleanValidationTypes")
    if not isinstance(clean_validation_types, list) or not all(isinstance(item, str) for item in clean_validation_types):
        raise ValueError("cleanValidationTypes 必须是字符串数组")
    unknown_types = set(clean_validation_types) - set(_CLEAN_VALIDATION_TYPES)
    if unknown_types:
        raise ValueError(f"cleanValidationTypes 包含不支持的类型：{sorted(unknown_types)}")
    normalized["cleanValidationTypes"] = [
        clean_type for clean_type in _CLEAN_VALIDATION_TYPES
        if clean_type in clean_validation_types
    ]
    return normalized


def _validate_analysis_settings(value: Mapping[str, Any]) -> Dict[str, Any]:
    """校验并规范化结果分析指标、统计窗口和时间预算。"""
    metric_ids = value.get("metricIds")
    if not isinstance(metric_ids, list) or not all(isinstance(item, str) for item in metric_ids):
        raise ValueError("metricIds 必须是字符串数组")
    unknown_ids = set(metric_ids) - set(_ANALYSIS_METRIC_IDS)
    if unknown_ids:
        raise ValueError(f"metricIds 包含不支持的指标：{sorted(unknown_ids)}")
    window_mode = value.get("windowMode")
    if window_mode not in {"steady", "full"}:
        raise ValueError("windowMode 只支持 steady 或 full")
    time_budget = value.get("timeBudgetSeconds")
    if isinstance(time_budget, bool) or not isinstance(time_budget, int):
        raise ValueError("timeBudgetSeconds 必须是整数")
    if time_budget not in {30, 120, 300}:
        raise ValueError("timeBudgetSeconds 只支持 30、120 或 300 秒")
    return {
        "metricIds": [metric_id for metric_id in _ANALYSIS_METRIC_IDS if metric_id in metric_ids],
        "windowMode": str(window_mode),
        "timeBudgetSeconds": time_budget,
    }


def _migrate_run_preferences(payload: Mapping[str, Any], path: Path, source_version: int) -> Dict[str, Any]:
    """逐版补齐运行与分析偏好，并保留可恢复的原始备份。"""
    settings = payload.get("runSettings")
    if not isinstance(settings, Mapping):
        raise ValueError("本地运行偏好缺少 runSettings")
    migrated = dict(settings)
    if source_version < 2:
        migrated["cleanValidationTypes"] = list(_CLEAN_VALIDATION_TYPES)
    if source_version < 3:
        migrated["executionTimingEnabled"] = False
    normalized_run = _validate_run_settings(migrated)
    raw_analysis = payload.get("analysisSettings")
    normalized_analysis = (
        _validate_analysis_settings(raw_analysis)
        if isinstance(raw_analysis, Mapping)
        else deepcopy(_DEFAULT_ANALYSIS_SETTINGS)
    )
    backup_path = path.with_suffix(f"{path.suffix}.v{source_version}.bak")
    if not backup_path.exists():
        _write_json_atomic(backup_path, dict(payload))
    normalized = {
        "schemaVersion": RUN_PREFERENCES_SCHEMA_VERSION,
        "runSettings": normalized_run,
        "analysisSettings": normalized_analysis,
    }
    _write_json_atomic(path, normalized)
    return normalized


def read_run_preferences(path: Optional[Path] = None) -> Dict[str, Any]:
    """读取本地运行偏好；文件不存在时返回默认设置，不主动创建文件。"""
    path = path or RUN_PREFERENCES_PATH
    with _RUN_PREFERENCES_LOCK:
        if not path.is_file():
            return deepcopy(_DEFAULT_RUN_SETTINGS)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"本地运行偏好无法读取：{error}") from error
        if not isinstance(payload, Mapping):
            raise ValueError("本地运行偏好必须是 JSON 对象")
        schema_version = payload.get("schemaVersion")
        if schema_version in {1, 2, 3, 4}:
            return _migrate_run_preferences(payload, path, int(schema_version))["runSettings"]
        if schema_version != RUN_PREFERENCES_SCHEMA_VERSION:
            if isinstance(schema_version, int) and schema_version > RUN_PREFERENCES_SCHEMA_VERSION:
                raise ValueError(f"本地运行偏好版本过新：{schema_version}")
            raise ValueError(f"不支持的本地运行偏好版本：{schema_version}")
        settings = payload.get("runSettings")
        if not isinstance(settings, Mapping):
            raise ValueError("本地运行偏好缺少 runSettings")
        return _validate_run_settings(settings)


def read_analysis_preferences(path: Optional[Path] = None) -> Dict[str, Any]:
    """读取个人结果分析偏好；旧版文件会迁移并补齐默认分析设置。"""
    path = path or RUN_PREFERENCES_PATH
    with _RUN_PREFERENCES_LOCK:
        if not path.is_file():
            return deepcopy(_DEFAULT_ANALYSIS_SETTINGS)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"本地运行偏好无法读取：{error}") from error
        if not isinstance(payload, Mapping):
            raise ValueError("本地运行偏好必须是 JSON 对象")
        schema_version = payload.get("schemaVersion")
        if schema_version in {1, 2, 3, 4}:
            return _migrate_run_preferences(payload, path, int(schema_version))["analysisSettings"]
        if schema_version != RUN_PREFERENCES_SCHEMA_VERSION:
            if isinstance(schema_version, int) and schema_version > RUN_PREFERENCES_SCHEMA_VERSION:
                raise ValueError(f"本地运行偏好版本过新：{schema_version}")
            raise ValueError(f"不支持的本地运行偏好版本：{schema_version}")
        settings = payload.get("analysisSettings")
        if not isinstance(settings, Mapping):
            raise ValueError("本地运行偏好缺少 analysisSettings")
        return _validate_analysis_settings(settings)


def update_run_preferences(
    value: Mapping[str, Any],
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """校验并原子保存完整运行设置，返回实际落盘的规范化副本。"""
    path = path or RUN_PREFERENCES_PATH
    if not isinstance(value, Mapping):
        raise ValueError("runSettings 必须是 JSON 对象")
    settings = _validate_run_settings(value)
    with _RUN_PREFERENCES_LOCK:
        analysis_settings = read_analysis_preferences(path)
        _write_json_atomic(path, {
            "schemaVersion": RUN_PREFERENCES_SCHEMA_VERSION,
            "runSettings": settings,
            "analysisSettings": analysis_settings,
        })
    return deepcopy(settings)


def update_analysis_preferences(
    value: Mapping[str, Any],
    path: Optional[Path] = None,
) -> Dict[str, Any]:
    """校验并原子保存个人结果分析设置，同时保留现有运行设置。"""
    path = path or RUN_PREFERENCES_PATH
    if not isinstance(value, Mapping):
        raise ValueError("analysisSettings 必须是 JSON 对象")
    settings = _validate_analysis_settings(value)
    with _RUN_PREFERENCES_LOCK:
        run_settings = read_run_preferences(path)
        _write_json_atomic(path, {
            "schemaVersion": RUN_PREFERENCES_SCHEMA_VERSION,
            "runSettings": run_settings,
            "analysisSettings": settings,
        })
    return deepcopy(settings)
