"""设备实际执行时间配置与 Move 时长解析。

本模块保存平台侧的执行时间语义：理论时间仍由设备标准字段提供给算法，
执行时间只在兼容推进阶段用于生成真实 Running/Done 时刻。固定模式按设备
字段逐项覆盖；波动模式以算法给出的 Move 理论时长为均值生成可复现样本。
"""

from __future__ import annotations

import hashlib
import math
from copy import deepcopy
from typing import Any, Dict, Mapping, Optional, Sequence


EXECUTION_TIMING_MODES = frozenset({"fixed", "fluctuation"})
FLUCTUATION_KINDS = frozenset({"ratio", "offset"})
STATION_MAPPING_FIELDS = (
    "PickPrepareTime", "PickCompleteTime", "PlacePrepareTime",
    "PlaceCompleteTime", "PostCompleteTime", "AlignmentTime",
)
STATION_SEQUENCE_FIELDS = ("PrePrepareTime",)
ROBOT_MAPPING_FIELDS = ("PickTime", "PlaceTime")
ROBOT_SEQUENCE_FIELDS = ("PrepTransTime",)


def _finite_nonnegative(value: Any, label: str) -> float:
    """把输入规范化为非负有限秒数，非法值给出带路径的错误。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} 必须是非负有限秒数") from None
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{label} 必须是非负有限秒数")
    return number


def _theoretical_timing_snapshot(device: Mapping[str, Any]) -> Dict[str, Any]:
    """从标准设备对象复制可配置时间，作为固定执行时间的默认值。"""
    snapshot: Dict[str, Any] = {"stations": {}, "robots": {}}
    for name, item in (device.get("Stations") or {}).items():
        if not isinstance(item, Mapping):
            continue
        fields: Dict[str, Any] = {}
        for field in STATION_MAPPING_FIELDS:
            if isinstance(item.get(field), Mapping):
                fields[field] = {
                    str(key): _finite_nonnegative(value, f"Stations.{name}.{field}.{key}")
                    for key, value in item[field].items()
                }
        for field in STATION_SEQUENCE_FIELDS:
            if isinstance(item.get(field), list):
                fields[field] = [
                    _finite_nonnegative(row.get("Time", 0), f"Stations.{name}.{field}[{index}]")
                    for index, row in enumerate(item[field]) if isinstance(row, Mapping)
                ]
        snapshot["stations"][str(name)] = fields
    for name, item in (device.get("Robots") or {}).items():
        if not isinstance(item, Mapping):
            continue
        fields = {}
        for field in ROBOT_MAPPING_FIELDS:
            if isinstance(item.get(field), Mapping):
                fields[field] = {
                    str(key): _finite_nonnegative(value, f"Robots.{name}.{field}.{key}")
                    for key, value in item[field].items()
                }
        for field in ROBOT_SEQUENCE_FIELDS:
            if isinstance(item.get(field), list):
                fields[field] = [
                    _finite_nonnegative(row.get("Time", 0), f"Robots.{name}.{field}[{index}]")
                    for index, row in enumerate(item[field]) if isinstance(row, Mapping)
                ]
        snapshot["robots"][str(name)] = fields
    return snapshot


def default_execution_timing(device: Mapping[str, Any]) -> Dict[str, Any]:
    """为设备建立不改变现有结果的执行时间默认配置。"""
    return {
        "mode": "fixed",
        "fluctuation": {
            "kind": "ratio",
            "ratio": 0.0,
            "minimumOffsetSeconds": 0.0,
            "maximumOffsetSeconds": 0.0,
        },
        **_theoretical_timing_snapshot(device),
    }


def _normalize_fixed_section(
    raw_section: Any,
    defaults: Mapping[str, Any],
    label: str,
) -> Dict[str, Any]:
    """按理论时间拓扑校验固定执行值，禁止新增未知字段或索引。"""
    raw = raw_section if isinstance(raw_section, Mapping) else {}
    unknown_items = set(map(str, raw)) - set(defaults)
    if unknown_items:
        raise ValueError(f"{label} 包含未知设备：{sorted(unknown_items)}")
    normalized = deepcopy(dict(defaults))
    for item_name, raw_fields in raw.items():
        if not isinstance(raw_fields, Mapping):
            raise ValueError(f"{label}.{item_name} 必须是对象")
        target_fields = normalized[str(item_name)]
        unknown_fields = set(map(str, raw_fields)) - set(target_fields)
        if unknown_fields:
            raise ValueError(f"{label}.{item_name} 包含未知字段：{sorted(unknown_fields)}")
        for field_name, raw_values in raw_fields.items():
            target = target_fields[str(field_name)]
            field_label = f"{label}.{item_name}.{field_name}"
            if isinstance(target, dict):
                if not isinstance(raw_values, Mapping) or set(map(str, raw_values)) - set(target):
                    raise ValueError(f"{field_label} 与设备定义不一致")
                for key, value in raw_values.items():
                    target[str(key)] = _finite_nonnegative(value, f"{field_label}.{key}")
            else:
                if not isinstance(raw_values, Sequence) or isinstance(raw_values, (str, bytes)) or len(raw_values) != len(target):
                    raise ValueError(f"{field_label} 数量与设备定义不一致")
                target[:] = [
                    _finite_nonnegative(value, f"{field_label}[{index}]")
                    for index, value in enumerate(raw_values)
                ]
    return normalized


def normalize_execution_timing(device: Mapping[str, Any], raw: Any = None) -> Dict[str, Any]:
    """校验设备执行时间配置，并补齐新增或缺失的理论计时字段。"""
    defaults = default_execution_timing(device)
    value = raw if isinstance(raw, Mapping) else {}
    mode = str(value.get("mode") or defaults["mode"])
    if mode not in EXECUTION_TIMING_MODES:
        raise ValueError(f"执行时间模式不支持：{mode}")
    fluctuation = value.get("fluctuation")
    fluctuation = fluctuation if isinstance(fluctuation, Mapping) else {}
    kind = str(fluctuation.get("kind") or "ratio")
    if kind not in FLUCTUATION_KINDS:
        raise ValueError(f"执行时间波动方式不支持：{kind}")
    ratio = _finite_nonnegative(fluctuation.get("ratio", 0), "fluctuation.ratio")
    if ratio > 1:
        raise ValueError("fluctuation.ratio 必须在 0 到 1 之间")
    minimum_offset = float(fluctuation.get("minimumOffsetSeconds", 0))
    maximum_offset = float(fluctuation.get("maximumOffsetSeconds", 0))
    if not math.isfinite(minimum_offset) or not math.isfinite(maximum_offset):
        raise ValueError("执行时间波动上下限必须是有限秒数")
    if minimum_offset > maximum_offset:
        raise ValueError("执行时间最小波动不能大于最大波动")
    return {
        "mode": mode,
        "fluctuation": {
            "kind": kind,
            "ratio": ratio,
            "minimumOffsetSeconds": minimum_offset,
            "maximumOffsetSeconds": maximum_offset,
        },
        "stations": _normalize_fixed_section(value.get("stations"), defaults["stations"], "stations"),
        "robots": _normalize_fixed_section(value.get("robots"), defaults["robots"], "robots"),
    }


def _stable_unit_sample(move: Mapping[str, Any], seed: int) -> float:
    """按 seed、代次和 MoveID 生成跨进程稳定的 [0, 1] 样本。"""
    identity = "|".join((
        str(seed), str(move.get("RequestID") or 0), str(move.get("MoveID") or 0),
        str(move.get("ModuleName") or ""), str(move.get("MoveType") or 0),
    ))
    digest = hashlib.sha256(identity.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float((1 << 64) - 1)


def _mapping_duration(fields: Mapping[str, Any], field: str, keys: Sequence[str]) -> Optional[float]:
    """从固定执行映射读取涉及对象的最大时长。"""
    values = fields.get(field)
    if not isinstance(values, Mapping):
        return None
    matched = [float(values[key]) for key in keys if key in values]
    return max(matched) if matched else None


def _station_field_duration(
    station: Mapping[str, Any],
    execution_fields: Mapping[str, Any],
    field_names: Sequence[str],
    planned_duration: float,
) -> Optional[float]:
    """先用理论值识别站点字段及 Robot key，再读取同路径固定执行值。"""
    candidates = []
    for field_name in field_names:
        theoretical_values = station.get(field_name)
        execution_values = execution_fields.get(field_name)
        if not isinstance(theoretical_values, Mapping) or not isinstance(execution_values, Mapping):
            continue
        for key, theoretical_value in theoretical_values.items():
            if str(key) in execution_values:
                candidates.append((
                    abs(float(theoretical_value) - planned_duration),
                    field_name,
                    str(key),
                ))
    if not candidates:
        return None
    _distance, field_name, key = min(candidates)
    return float(execution_fields[field_name][key])


def _fixed_execution_duration(
    move: Mapping[str, Any],
    device: Mapping[str, Any],
    timing: Mapping[str, Any],
    planned_duration: float,
) -> float:
    """把一个标准 Move 映射到设备固定执行字段；无法判定时保留理论时长。"""
    move_type = int(move.get("MoveType", -1))
    module_name = str(move.get("ModuleName") or "")
    station_fields = (timing.get("stations") or {}).get(module_name, {})
    robot_fields = (timing.get("robots") or {}).get(module_name, {})
    station = (device.get("Stations") or {}).get(module_name, {})
    if move_type in {0, 2}:
        configured = _mapping_duration(robot_fields, "PickTime", [str(value) for value in move.get("SrcStationList") or []])
        return planned_duration if configured is None else configured
    if move_type in {1, 3}:
        configured = _mapping_duration(robot_fields, "PlaceTime", [str(value) for value in move.get("DestStationList") or []])
        return planned_duration if configured is None else configured
    if move_type == 5:
        rows = (device.get("Robots") or {}).get(module_name, {}).get("PrepTransTime") or []
        fixed = robot_fields.get("PrepTransTime") or []
        source = str((move.get("SrcStationList") or [""])[0])
        destination = str((move.get("DestStationList") or [""])[0])
        loaded = bool(move.get("MatIDList"))
        matches = [
            float(fixed[index]) for index, row in enumerate(rows)
            if index < len(fixed) and isinstance(row, Mapping)
            and str(row.get("SrcStation") or "") == source
            and str(row.get("DestStation") or "") == destination
            and (int(row.get("TransType") or 0) == 1) == loaded
        ]
        return max(matches) if matches else planned_duration
    if move_type == 6:
        action = int(move.get("RelatedActionType", -1))
        field = "PickPrepareTime" if action == 1 else "PlacePrepareTime" if action == 0 else ""
        if field:
            configured = _station_field_duration(
                station, station_fields, (field,), planned_duration,
            )
            if configured is not None:
                return configured
    if move_type in {7, 8}:
        field_names = ("PickCompleteTime", "PlaceCompleteTime", "PostCompleteTime") if move_type == 7 else ("PostCompleteTime",)
        configured = _station_field_duration(
            station, station_fields, field_names, planned_duration,
        )
        if configured is not None:
            return configured
    if move_type == 10:
        rows = (device.get("Stations") or {}).get(module_name, {}).get("PrePrepareTime") or []
        fixed = station_fields.get("PrePrepareTime") or []
        matches = [
            float(fixed[index]) for index, row in enumerate(rows)
            if index < len(fixed) and isinstance(row, Mapping)
            and str(row.get("LastItem") or "") == str(move.get("LastState") or "")
            and str(row.get("CurrentItem") or "") == str(move.get("CurState") or "")
            and str(row.get("PrePrepareType") or "") == str(move.get("PrePrepareType") or "")
        ]
        return max(matches) if matches else planned_duration
    if move_type == 11:
        configured = _mapping_duration(station_fields, "AlignmentTime", [str(value) for value in move.get("SlotList") or []])
        return planned_duration if configured is None else configured
    return planned_duration


def execution_duration(
    move: Mapping[str, Any],
    device: Mapping[str, Any],
    execution_timing: Mapping[str, Any],
    seed: int,
) -> float:
    """返回一个 Move 的实际执行时长，结果始终非负且可复现。"""
    start = float(move.get("StartTime") or 0.0)
    end = float(move.get("EndTime") or start)
    planned_duration = max(0.0, end - start)
    if execution_timing.get("mode") == "fixed":
        return _fixed_execution_duration(move, device, execution_timing, planned_duration)
    fluctuation = execution_timing.get("fluctuation") or {}
    unit = _stable_unit_sample(move, seed)
    if fluctuation.get("kind") == "offset":
        minimum = float(fluctuation.get("minimumOffsetSeconds") or 0.0)
        maximum = float(fluctuation.get("maximumOffsetSeconds") or 0.0)
        return max(0.0, planned_duration + minimum + (maximum - minimum) * unit)
    ratio = float(fluctuation.get("ratio") or 0.0)
    return max(0.0, planned_duration * (1.0 - ratio + 2.0 * ratio * unit))
