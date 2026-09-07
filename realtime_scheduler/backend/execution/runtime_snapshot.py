"""AlgSchedule 的 Robot/Station 实时快照投影与平台校验展开。

设备 ``AlgInit`` 保留完整拓扑能力；每轮 ``AlgSchedule`` 只发送公司标准日志
中出现的 Robot 和 Station 运行时字段。本模块集中维护两种表示之间的转换，避免
调度输入重新混入容量、槽位和动作时间等稳定配置，同时让平台 MoveList 校验仍能
使用完整拓扑恢复 LoadLock 环境、物理槽位与 Robot 能力。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Mapping


_BASE_ROBOT_FIELDS = ("Type", "State", "TimeToAvailable", "ArmInfo")
_BASE_STATION_FIELDS = ("Type", "State", "TimeToAvailableOfSlot")
_PROCESS_STATION_TYPES = frozenset({"process", "processchamber"})
_MULTI_PROCESS_STATION_TYPES = frozenset({"multiprocesschamber"})
_LOAD_LOCK_STATION_TYPES = frozenset({"loadlock"})
_COOLER_STATION_TYPES = frozenset({"cooler"})


def _station_type(config: Mapping[str, Any]) -> str:
    """返回用于匹配公司接口子类型的标准化 Station 类型。"""
    return str(config.get("Type") or "").strip().casefold()


def _copy_present_fields(
    source: Mapping[str, Any],
    target: Dict[str, Any],
    fields: tuple[str, ...],
) -> None:
    """按指定顺序深拷贝源对象中实际存在的字段。"""
    for field_name in fields:
        if field_name in source:
            target[field_name] = deepcopy(source[field_name])


def compact_robot_snapshots(
    robots: Mapping[str, Any],
) -> Dict[str, Dict[str, Any]]:
    """将完整 Robot 配置投影为公司 AlgSchedule 的实时字段集。

    ``ArmInfo`` 完整保留。公司日志要求其中的可达站点、启用状态、槽位、当前指向、
    使用次数和 ``SlotsStationMap`` 同时存在，不能再做二次裁剪。
    """
    compacted: Dict[str, Dict[str, Any]] = {}
    for robot_name, raw_config in robots.items():
        if not isinstance(raw_config, Mapping):
            continue
        robot: Dict[str, Any] = {}
        _copy_present_fields(raw_config, robot, _BASE_ROBOT_FIELDS)
        compacted[str(robot_name)] = robot
    return compacted


def compact_station_snapshots(
    stations: Mapping[str, Any],
) -> Dict[str, Dict[str, Any]]:
    """将完整 Station 配置投影为公司 AlgSchedule 的实时字段集。

    参数:
        stations: 当前轮完整或已部分投影的 ``Stations`` 字典。

    返回:
        不含稳定拓扑字段的新字典。``DoorStatus`` 仅在原始 Station 已提供时保留；
        该可选字段在公司日志中随设备能力出现，不由平台凭空补造。
    """
    compacted: Dict[str, Dict[str, Any]] = {}
    for station_name, raw_config in stations.items():
        if not isinstance(raw_config, Mapping):
            continue
        station: Dict[str, Any] = {}
        _copy_present_fields(raw_config, station, _BASE_STATION_FIELDS)
        if "DoorStatus" in raw_config:
            station["DoorStatus"] = deepcopy(raw_config["DoorStatus"])

        station_type = _station_type(raw_config)
        if station_type in _LOAD_LOCK_STATION_TYPES:
            _copy_present_fields(raw_config, station, ("LastItem",))
        elif station_type in _PROCESS_STATION_TYPES:
            _copy_present_fields(
                raw_config,
                station,
                ("PJobName", "StateVariables", "LastItem", "ByChamberClean"),
            )
        elif station_type in _MULTI_PROCESS_STATION_TYPES:
            _copy_present_fields(
                raw_config,
                station,
                (
                    "PJobName",
                    "StateVariables",
                    "LastItem",
                    "ByChamberClean",
                    "MaterialCount",
                    "SlotPriority",
                ),
            )
        elif station_type in _COOLER_STATION_TYPES:
            _copy_present_fields(raw_config, station, ("MaterialCount",))
        compacted[str(station_name)] = station
    return compacted


def compact_runtime_snapshots(update_params: Dict[str, Any]) -> None:
    """原地将一轮 AlgSchedule 的 Robot 和 Station 收敛为公司实时快照。"""
    update_params["Robots"] = compact_robot_snapshots(update_params.get("Robots") or {})
    update_params["Stations"] = compact_station_snapshots(update_params.get("Stations") or {})


def _merge_topology_section(
    tool_topology: Mapping[str, Any],
    update_params: Mapping[str, Any],
    field_name: str,
) -> Dict[str, Dict[str, Any]]:
    """以 update 的动态字段覆盖 AlgInit 中同名 Robot 或 Station 配置。"""
    merged: Dict[str, Dict[str, Any]] = {}
    topology_items = tool_topology.get(field_name) or {}
    snapshot_items = update_params.get(field_name) or {}
    if isinstance(topology_items, Mapping):
        for item_name, raw_config in topology_items.items():
            if isinstance(raw_config, Mapping):
                merged[str(item_name)] = deepcopy(dict(raw_config))
    if isinstance(snapshot_items, Mapping):
        for item_name, raw_config in snapshot_items.items():
            if isinstance(raw_config, Mapping):
                merged.setdefault(str(item_name), {}).update(deepcopy(dict(raw_config)))
    return merged


def expand_runtime_snapshots_for_validation(
    tool_topology: Mapping[str, Any],
    update_params: Mapping[str, Any],
) -> Dict[str, Any]:
    """为平台状态机合并完整拓扑和已精简的 AlgSchedule 实时快照。

    返回的副本只供平台 MoveList 校验使用，不会回写或扩大实际发给算法、记录在
    复现日志中的 ``AlgSchedule``。实时字段覆盖初始化字段，保证重算现场优先。
    """
    expanded = deepcopy(dict(update_params))
    for field_name in ("Robots", "Stations"):
        expanded[field_name] = _merge_topology_section(
            tool_topology,
            update_params,
            field_name,
        )
    return expanded
