"""服务端本地运行偏好仓库。

本模块负责 ``data/run_preferences.json`` 的版本、校验和原子写入。该文件保存
当前安装实例共享的页面运行习惯，不属于设备/测试集主数据，也不进入交换包。
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


RUN_PREFERENCES_SCHEMA_VERSION = 1
RUN_PREFERENCES_PATH = DATA_DIR / "run_preferences.json"
_RUN_PREFERENCES_LOCK = threading.RLock()
_BOOLEAN_FIELDS = (
    "compatibilityMode",
    "hongYeCheck",
    "skipBaseline",
    "skipValidation",
)
_DEFAULT_RUN_SETTINGS = {
    "compatibilityMode": True,
    "hongYeCheck": True,
    "skipBaseline": True,
    "skipValidation": False,
    "maximumWorkers": DEFAULT_BATCH_WORKERS,
    "validationWorkers": DEFAULT_VALIDATION_WORKERS,
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
        if schema_version != RUN_PREFERENCES_SCHEMA_VERSION:
            if isinstance(schema_version, int) and schema_version > RUN_PREFERENCES_SCHEMA_VERSION:
                raise ValueError(f"本地运行偏好版本过新：{schema_version}")
            raise ValueError(f"不支持的本地运行偏好版本：{schema_version}")
        settings = payload.get("runSettings")
        if not isinstance(settings, Mapping):
            raise ValueError("本地运行偏好缺少 runSettings")
        return _validate_run_settings(settings)


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
        _write_json_atomic(path, {
            "schemaVersion": RUN_PREFERENCES_SCHEMA_VERSION,
            "runSettings": settings,
        })
    return deepcopy(settings)
