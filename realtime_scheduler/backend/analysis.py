"""服务端调度结果分析。

本模块是 MoveList 性能指标、瓶颈诊断和测试组统计的唯一实现。它只接收普通
Python 对象并返回可 JSON 序列化的字典，不读取 HTTP、文件、DOM 或进程全局状态。
HTTP 层负责解析请求和读取已保存结果，前端只负责展示本模块返回的结构化结果。
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


PERFORMANCE_TIME_TOLERANCE = 1e-6
MIDDLE_WINDOW_TRIM_RATIO = 0.1
MINIMUM_STEADY_WAFERS = 4
PICK_MOVE_TYPES = frozenset({0, 2})
PLACE_MOVE_TYPES = frozenset({1, 3})
SWAP_MOVE_TYPE = 4
PRE_TRANS_MOVE_TYPE = 5
PREPARE_MOVE_TYPE = 6
COMPLETE_MOVE_TYPE = 7
PROCESS_MOVE_TYPE = 9
PRE_PREPARE_MOVE_TYPE = 10
CLEAN_MOVE_TYPE = 14
VACUUM_MOVE_TYPE = 12
VENT_MOVE_TYPE = 13
SECONDS_PER_HOUR = 3600.0
COMPARISON_TOLERANCE_PERCENT = 1e-6
ACTIVITY_CATEGORIES = (
    "process", "clean", "door", "transfer", "environment", "other",
)
RESOURCE_KIND_ORDER = {
    "robot": 0,
    "loadlock": 1,
    "process": 2,
    "auxiliary": 3,
    "loadport": 4,
}


def _finite_number(value: Any, fallback: float = 0.0) -> float:
    """把未知值转换为有限浮点数，失败时返回指定默认值。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _finite_or_none(value: Any) -> Optional[float]:
    """把未知值转换为有限浮点数，无效值返回 ``None``。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _list_value(value: Any) -> List[Any]:
    """将协议列表字段规范为列表。"""
    return list(value) if isinstance(value, list) else []


def _natural_key(value: str) -> List[Any]:
    """生成兼容数字片段的自然排序键。"""
    return [
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", str(value))
    ]


def _material_ids(move: Mapping[str, Any], field: str = "MatIDList") -> List[str]:
    """返回动作指定字段中的非空物料 ID。"""
    return [str(value) for value in _list_value(move.get(field)) if str(value)]


def _first_station(move: Mapping[str, Any], field: str) -> str:
    """返回动作指定站点列表中的第一个站点。"""
    values = _list_value(move.get(field))
    return str(values[0]) if values else ""


def _move_robot_name(move: Mapping[str, Any]) -> str:
    """读取动作使用的机器人名称，兼容 Robot 和 ModuleName 字段。"""
    return str(move.get("Robot") or move.get("ModuleName") or "").strip()


def _is_robot_name(name: str) -> bool:
    """判断资源名是否表示机器人。"""
    return bool(re.match(r"^(ATR|VTR|TM\d*|ROBOT)", name, re.IGNORECASE))


def _is_dummy_port_name(name: str) -> bool:
    """判断资源名是否表示 Dummy Port。"""
    return "DUMMY" in name.upper() and "PORT" in name.upper()


def _is_load_port_name(name: str, resource_type: str = "") -> bool:
    """判断资源是否表示正常装载端口。"""
    return (
        not _is_dummy_port_name(name)
        and (
            resource_type.casefold() == "loadport"
            or bool(re.match(r"^(LP\d*|P\d+|.*PORT)$", name, re.IGNORECASE))
        )
    )


def _is_load_lock_name(name: str, resource_type: str = "") -> bool:
    """判断资源是否表示 LoadLock 或真空缓冲腔。"""
    return (
        resource_type.casefold() == "loadlock"
        or bool(re.match(r"^LL?[A-Z]$", name, re.IGNORECASE))
        or bool(re.match(r"^BUF_", name, re.IGNORECASE))
    )


def _is_process_module(name: str, resource_type: str = "") -> bool:
    """判断资源是否表示工艺腔室。"""
    return (
        bool(re.search(r"process|chamber", resource_type, re.IGNORECASE))
        or bool(re.match(r"^(PM|CH)\w*", name, re.IGNORECASE))
    )


def normalize_move_payload(payload: Any) -> List[Dict[str, Any]]:
    """从 MoveList 数组或带 MoveList 字段的对象提取动作副本。"""
    records = payload if isinstance(payload, list) else (
        payload.get("MoveList")
        if isinstance(payload, Mapping) and isinstance(payload.get("MoveList"), list)
        else None
    )
    if records is None:
        raise ValueError("数据必须是 MoveList 数组，或包含 MoveList 字段的 JSON 对象")
    return [dict(record) for record in records if isinstance(record, Mapping)]


def _normalize_moves(moves: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """规范化动作时间与编号，并返回稳定排序的副本。"""
    records: List[Dict[str, Any]] = []
    for index, raw_move in enumerate(moves):
        move = dict(raw_move)
        start_time = _finite_number(move.get("StartTime"))
        end_time = max(start_time, _finite_number(move.get("EndTime"), start_time))
        move.update({
            "MoveID": int(_finite_number(move.get("MoveID"), index + 1)),
            "MoveType": int(_finite_number(move.get("MoveType"), -1)),
            "ModuleName": str(move.get("ModuleName") or ""),
            "StartTime": start_time,
            "EndTime": end_time,
        })
        records.append(move)
    return sorted(
        records,
        key=lambda move: (move["StartTime"], move["EndTime"], move["MoveID"]),
    )


def _empty_category_times() -> Dict[str, float]:
    """创建各活动类别时间均为零的占用组成。"""
    return {category: 0.0 for category in ACTIVITY_CATEGORIES}


def _activity_category(move_type: int) -> str:
    """把 MoveType 映射为性能分析使用的物理活动类别。"""
    if move_type == PROCESS_MOVE_TYPE:
        return "process"
    if move_type == CLEAN_MOVE_TYPE:
        return "clean"
    if move_type in {PREPARE_MOVE_TYPE, COMPLETE_MOVE_TYPE}:
        return "door"
    if move_type in {PRE_PREPARE_MOVE_TYPE, VACUUM_MOVE_TYPE, VENT_MOVE_TYPE}:
        return "environment"
    if (
        move_type in PICK_MOVE_TYPES
        or move_type in PLACE_MOVE_TYPES
        or move_type in {SWAP_MOVE_TYPE, PRE_TRANS_MOVE_TYPE}
    ):
        return "transfer"
    return "other"


def _activity_resource_names(move: Mapping[str, Any]) -> List[str]:
    """返回一个动作实际占用的机器人和站点资源。"""
    names: set[str] = set()
    module_name = str(move.get("ModuleName") or "")
    if module_name:
        names.add(module_name)
    move_type = int(move.get("MoveType") or 0)
    if move_type in PICK_MOVE_TYPES:
        source = _first_station(move, "SrcStationList")
        if source:
            names.add(source)
    elif move_type in PLACE_MOVE_TYPES:
        destination = _first_station(move, "DestStationList")
        if destination:
            names.add(destination)
    elif move_type == SWAP_MOVE_TYPE:
        names.update(str(value) for value in _list_value(move.get("StationList")) if str(value))
    return list(names)


def _station_type(device: Optional[Mapping[str, Any]], name: str) -> str:
    """返回设备定义中指定站点的类型。"""
    stations = device.get("Stations") if isinstance(device, Mapping) else None
    definition = stations.get(name) if isinstance(stations, Mapping) else None
    return str(definition.get("Type") or "") if isinstance(definition, Mapping) else ""


def _resource_kind(name: str, resource_type: str) -> str:
    """将资源归入机器人、工艺腔、LoadLock 等稳定类别。"""
    if _is_robot_name(name):
        return "robot"
    if _is_process_module(name, resource_type):
        return "process"
    if _is_load_lock_name(name, resource_type):
        return "loadlock"
    if _is_load_port_name(name, resource_type):
        return "loadport"
    return "auxiliary"


def _performance_resource_definitions(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
) -> Dict[str, Dict[str, str]]:
    """收集性能表所需的资源定义。"""
    referenced = {
        name for move in moves for name in _activity_resource_names(move)
    }
    resources: Dict[str, Dict[str, str]] = {}
    stations = device.get("Stations") if isinstance(device, Mapping) else None
    for name, raw_definition in (stations.items() if isinstance(stations, Mapping) else []):
        definition = raw_definition if isinstance(raw_definition, Mapping) else {}
        resource_type = str(definition.get("Type") or "")
        if (
            name in referenced
            or _is_process_module(str(name), resource_type)
            or _is_load_lock_name(str(name), resource_type)
        ):
            resources[str(name)] = {
                "type": resource_type,
                "kind": _resource_kind(str(name), resource_type),
            }
    robots = device.get("Robots") if isinstance(device, Mapping) else None
    for name in (robots.keys() if isinstance(robots, Mapping) else []):
        resources[str(name)] = {"type": "Robot", "kind": "robot"}
    for name in referenced:
        if name not in resources:
            resource_type = _station_type(device, name)
            resources[name] = {
                "type": resource_type,
                "kind": _resource_kind(name, resource_type),
            }
    return resources


def _resource_activity_intervals(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """按资源建立完整 MoveList 的物理占用区间。"""
    intervals = {
        name: [] for name in _performance_resource_definitions(moves, device)
    }
    for move in moves:
        if move["EndTime"] <= move["StartTime"] + PERFORMANCE_TIME_TOLERANCE:
            continue
        interval = {
            "start": move["StartTime"],
            "end": move["EndTime"],
            "category": _activity_category(int(move["MoveType"])),
        }
        for name in _activity_resource_names(move):
            intervals.setdefault(name, []).append(interval)
    return intervals


def _summarize_intervals(
    intervals: Sequence[Mapping[str, Any]],
    window_start: float,
    window_end: float,
) -> Dict[str, Any]:
    """在统计窗口内合并重叠区间，并计算活跃期与最长空闲。"""
    category_times = _empty_category_times()
    clipped = [
        {
            **interval,
            "start": max(window_start, float(interval["start"])),
            "end": min(window_end, float(interval["end"])),
        }
        for interval in intervals
        if min(window_end, float(interval["end"]))
        > max(window_start, float(interval["start"])) + PERFORMANCE_TIME_TOLERANCE
    ]
    if window_end <= window_start + PERFORMANCE_TIME_TOLERANCE:
        return {
            "busyTime": 0.0,
            "averageActivePeriod": 0.0,
            "longestActivePeriod": 0.0,
            "longestIdlePeriod": 0.0,
            "activePeriodCount": 0,
            "categoryTimes": category_times,
        }
    points = sorted({
        window_start,
        window_end,
        *(float(interval["start"]) for interval in clipped),
        *(float(interval["end"]) for interval in clipped),
    })
    active_periods: List[List[float]] = []
    for start, end in zip(points, points[1:]):
        if end <= start + PERFORMANCE_TIME_TOLERANCE:
            continue
        active = [
            interval for interval in clipped
            if interval["start"] < end - PERFORMANCE_TIME_TOLERANCE
            and interval["end"] > start + PERFORMANCE_TIME_TOLERANCE
        ]
        if not active:
            continue
        category = next(
            (
                candidate for candidate in ACTIVITY_CATEGORIES
                if any(interval["category"] == candidate for interval in active)
            ),
            "other",
        )
        category_times[category] += end - start
        if active_periods and start <= active_periods[-1][1] + PERFORMANCE_TIME_TOLERANCE:
            active_periods[-1][1] = end
        else:
            active_periods.append([start, end])
    active_durations = [end - start for start, end in active_periods]
    busy_time = sum(active_durations)
    idle_durations: List[float] = []
    cursor = window_start
    for start, end in active_periods:
        if start > cursor + PERFORMANCE_TIME_TOLERANCE:
            idle_durations.append(start - cursor)
        cursor = max(cursor, end)
    if cursor < window_end - PERFORMANCE_TIME_TOLERANCE:
        idle_durations.append(window_end - cursor)
    return {
        "busyTime": busy_time,
        "averageActivePeriod": busy_time / len(active_durations) if active_durations else 0.0,
        "longestActivePeriod": max(active_durations, default=0.0),
        "longestIdlePeriod": max(idle_durations, default=0.0),
        "activePeriodCount": len(active_durations),
        "categoryTimes": category_times,
    }


def _wafer_boundary_times(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
) -> Tuple[Dict[str, float], Dict[str, float]]:
    """收集晶圆离开和返回 LoadPort 的时刻。"""
    entries: Dict[str, float] = {}
    completions: Dict[str, float] = {}
    for move in moves:
        move_type = int(move["MoveType"])
        if move_type in PICK_MOVE_TYPES:
            source = _first_station(move, "SrcStationList")
            if _is_load_port_name(source, _station_type(device, source)):
                for material in _material_ids(move):
                    entries.setdefault(material, float(move["EndTime"]))
        elif move_type in PLACE_MOVE_TYPES:
            destination = _first_station(move, "DestStationList")
            if _is_load_port_name(destination, _station_type(device, destination)):
                for material in _material_ids(move):
                    completions[material] = float(move["EndTime"])
        elif move_type == SWAP_MOVE_TYPE:
            station = _first_station(move, "StationList")
            if not _is_load_port_name(station, _station_type(device, station)):
                continue
            for material in _material_ids(move, "SendMatList"):
                entries.setdefault(material, float(move["EndTime"]))
            for material in _material_ids(move, "RecvMatList"):
                completions[material] = float(move["EndTime"])
    return entries, completions


def _performance_window(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
    mode: str,
) -> Dict[str, Any]:
    """按完整周期或稳态交叠规则建立统计窗口。"""
    schedule_start = min((move["StartTime"] for move in moves), default=0.0)
    schedule_end = max((move["EndTime"] for move in moves), default=0.0)
    schedule_duration = max(schedule_end - schedule_start, 0.0)
    if mode == "full" or schedule_duration <= PERFORMANCE_TIME_TOLERANCE:
        return {
            "mode": mode,
            "method": "full",
            "start": schedule_start,
            "end": schedule_end,
            "duration": schedule_duration,
            "scheduleStart": schedule_start,
            "scheduleEnd": schedule_end,
            "trimmedStart": 0.0,
            "trimmedEnd": 0.0,
            "label": "完整周期",
            "detail": "从第一条 Move 开始到最后一条 Move 结束，包含启动与收尾阶段。",
        }
    entries, completions = _wafer_boundary_times(moves, device)
    entry_times = list(entries.values())
    completion_times = list(completions.values())
    first_completion = min(completion_times, default=math.inf)
    last_entry = max(entry_times, default=-math.inf)
    has_steady_overlap = (
        len(entry_times) >= MINIMUM_STEADY_WAFERS
        and len(completion_times) >= MINIMUM_STEADY_WAFERS
        and math.isfinite(first_completion)
        and math.isfinite(last_entry)
        and last_entry > first_completion + PERFORMANCE_TIME_TOLERANCE
    )
    start = (
        first_completion
        if has_steady_overlap
        else schedule_start + schedule_duration * MIDDLE_WINDOW_TRIM_RATIO
    )
    end = (
        last_entry
        if has_steady_overlap
        else schedule_end - schedule_duration * MIDDLE_WINDOW_TRIM_RATIO
    )
    return {
        "mode": mode,
        "method": "steady-overlap" if has_steady_overlap else "middle-approximation",
        "start": start,
        "end": end,
        "duration": max(end - start, 0.0),
        "scheduleStart": schedule_start,
        "scheduleEnd": schedule_end,
        "trimmedStart": max(start - schedule_start, 0.0),
        "trimmedEnd": max(schedule_end - end, 0.0),
        "label": "稳态交叠窗" if has_steady_overlap else "中段近似窗",
        "detail": (
            "首片返回 LoadPort 后开始、末片离开 LoadPort 时结束，自动排除启动填充和末批排空。"
            if has_steady_overlap
            else "样本没有形成可靠的首片完工—末片投料交叠，暂按时间轴两端各剔除 10%。"
        ),
    }


def _coefficient_of_variation(values: Sequence[float]) -> float:
    """计算一组数值的总体变异系数。"""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    if mean <= PERFORMANCE_TIME_TOLERANCE:
        return 0.0
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return math.sqrt(variance) / mean


def _percentile(values: Sequence[float], probability: float) -> Optional[float]:
    """按线性插值计算分位数，空集合返回 ``None``。"""
    if not values:
        return None
    ordered = sorted(values)
    position = max(0.0, min(1.0, probability)) * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _summarize_durations(values: Iterable[float]) -> Dict[str, Any]:
    """汇总时长样本的总和、均值、中位数、最大值、CV 与样本数。"""
    durations = [
        max(0.0, value)
        for value in values
        if math.isfinite(value) and value >= -PERFORMANCE_TIME_TOLERANCE
    ]
    total_seconds = sum(durations)
    return {
        "totalSeconds": total_seconds,
        "meanSeconds": total_seconds / len(durations) if durations else 0.0,
        "medianSeconds": _percentile(durations, 0.5) or 0.0,
        "maxSeconds": max(durations, default=0.0),
        "coefficientOfVariation": _coefficient_of_variation(durations),
        "sampleCount": len(durations),
    }


def _completion_inside_window(completed_at: float, window: Mapping[str, Any]) -> bool:
    """判断一个完成事件是否属于统计窗口。"""
    return (
        completed_at >= window["start"] - PERFORMANCE_TIME_TOLERANCE
        and completed_at <= window["end"] + PERFORMANCE_TIME_TOLERANCE
    )


def _process_chamber_dwell_time(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
    window: Mapping[str, Any],
) -> Dict[str, Any]:
    """统计加工完成后至晶圆完全离开工艺腔的驻留时间。"""
    durations: List[float] = []
    for process_move in moves:
        chamber = str(process_move["ModuleName"])
        if (
            int(process_move["MoveType"]) != PROCESS_MOVE_TYPE
            or not _is_process_module(chamber, _station_type(device, chamber))
        ):
            continue
        for material in _material_ids(process_move):
            removal = next(
                (
                    candidate for candidate in moves
                    if candidate["EndTime"]
                    >= process_move["EndTime"] - PERFORMANCE_TIME_TOLERANCE
                    and (
                        (
                            int(candidate["MoveType"]) in PICK_MOVE_TYPES
                            and _first_station(candidate, "SrcStationList") == chamber
                            and material in _material_ids(candidate)
                        )
                        or (
                            int(candidate["MoveType"]) == SWAP_MOVE_TYPE
                            and _first_station(candidate, "StationList") == chamber
                            and material in _material_ids(candidate, "SendMatList")
                        )
                    )
                ),
                None,
            )
            if removal and _completion_inside_window(float(removal["EndTime"]), window):
                durations.append(float(removal["EndTime"]) - float(process_move["EndTime"]))
    return _summarize_durations(durations)


def _covered_duration(
    intervals: Sequence[Mapping[str, float]],
    boundary_start: float,
    boundary_end: float,
) -> float:
    """计算一组区间在指定边界内覆盖的时间并集。"""
    clipped = sorted(
        (
            max(float(interval["start"]), boundary_start),
            min(float(interval["end"]), boundary_end),
        )
        for interval in intervals
        if min(float(interval["end"]), boundary_end)
        > max(float(interval["start"]), boundary_start) + PERFORMANCE_TIME_TOLERANCE
    )
    total = 0.0
    active_start: Optional[float] = None
    active_end = 0.0
    for start, end in clipped:
        if active_start is None:
            active_start, active_end = start, end
        elif start <= active_end + PERFORMANCE_TIME_TOLERANCE:
            active_end = max(active_end, end)
        else:
            total += active_end - active_start
            active_start, active_end = start, end
    return total if active_start is None else total + active_end - active_start


def _robot_wafer_dwell_time(
    moves: Sequence[Mapping[str, Any]],
    window: Mapping[str, Any],
) -> Dict[str, Any]:
    """统计机器人持片期间的非运输等待时间。"""
    transport_by_robot: Dict[str, List[Dict[str, float]]] = defaultdict(list)
    for move in moves:
        if (
            int(move["MoveType"]) == PRE_TRANS_MOVE_TYPE
            and move["EndTime"] > move["StartTime"]
        ):
            robot = _move_robot_name(move)
            if robot:
                transport_by_robot[robot].append({
                    "start": float(move["StartTime"]),
                    "end": float(move["EndTime"]),
                })
    holding_started_at: Dict[Tuple[str, str], float] = {}
    durations: List[float] = []

    def finish_holding(robot: str, materials: Sequence[str], finished_at: float) -> None:
        """结束机器人持片区间并记录扣除运输后的时长。"""
        for material in materials:
            started_at = holding_started_at.pop((robot, material), None)
            if started_at is None or not _completion_inside_window(finished_at, window):
                continue
            raw_duration = max(finished_at - started_at, 0.0)
            transport_duration = _covered_duration(
                transport_by_robot.get(robot, []),
                started_at,
                finished_at,
            )
            durations.append(max(raw_duration - transport_duration, 0.0))

    for move in moves:
        robot = _move_robot_name(move)
        if not robot:
            continue
        move_type = int(move["MoveType"])
        if move_type in PICK_MOVE_TYPES:
            for material in _material_ids(move):
                holding_started_at[(robot, material)] = float(move["EndTime"])
        elif move_type in PLACE_MOVE_TYPES:
            finish_holding(robot, _material_ids(move), float(move["StartTime"]))
        elif move_type == SWAP_MOVE_TYPE:
            finish_holding(
                robot,
                _material_ids(move, "SendMatList"),
                float(move["StartTime"]),
            )
            for material in _material_ids(move, "RecvMatList"):
                holding_started_at[(robot, material)] = float(move["EndTime"])
    return _summarize_durations(durations)


def _wafer_system_residence_time(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
    window: Mapping[str, Any],
) -> Dict[str, Any]:
    """统计晶圆离开 LoadPort 到返回 LoadPort 的系统停留时间。"""
    entries, completions = _wafer_boundary_times(moves, device)
    return _summarize_durations(
        completed_at - entries[material]
        for material, completed_at in completions.items()
        if material in entries
        and completed_at >= entries[material] - PERFORMANCE_TIME_TOLERANCE
        and _completion_inside_window(completed_at, window)
    )


def _load_lock_transition_direction(move: Mapping[str, Any]) -> Optional[str]:
    """判断 LoadLock 环境动作是抽气还是充气。"""
    last_state = str(move.get("LastState") or "").upper()
    current_state = str(move.get("CurState") or "").upper()
    if last_state == "ATM" and current_state == "VAC":
        return "vacuum"
    if last_state == "VAC" and current_state == "ATM":
        return "vent"
    if int(move["MoveType"]) == VACUUM_MOVE_TYPE:
        return "vacuum"
    if int(move["MoveType"]) == VENT_MOVE_TYPE:
        return "vent"
    return None


def _build_load_lock_cycles(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """按时间把每个 LoadLock 的抽气与随后一次充气配成一行。"""
    cycles: List[Dict[str, Any]] = []
    pending: Dict[str, Dict[str, Any]] = {}
    for move in moves:
        direction = _load_lock_transition_direction(move)
        load_lock = str(move["ModuleName"])
        if not direction or not _is_load_lock_name(
            load_lock, _station_type(device, load_lock),
        ):
            continue
        if direction == "vacuum":
            cycle = {
                "index": 0,
                "loadLock": load_lock,
                "vacuumWafers": _material_ids(move),
                "ventWafers": [],
                "startedAt": float(move["StartTime"]),
            }
            cycles.append(cycle)
            pending[load_lock] = cycle
        elif load_lock in pending:
            pending.pop(load_lock)["ventWafers"] = _material_ids(move)
        else:
            cycles.append({
                "index": 0,
                "loadLock": load_lock,
                "vacuumWafers": [],
                "ventWafers": _material_ids(move),
                "startedAt": float(move["StartTime"]),
            })
    cycles.sort(key=lambda cycle: (cycle["startedAt"], _natural_key(cycle["loadLock"])))
    return [
        {
            "index": index + 1,
            "loadLock": cycle["loadLock"],
            "vacuumWafers": cycle["vacuumWafers"],
            "ventWafers": cycle["ventWafers"],
        }
        for index, cycle in enumerate(cycles)
    ]


def _short_job_name(value: Any) -> str:
    """把 PJob 全名压缩成稳定的末级名称。"""
    parts = [part for part in str(value or "").split(".") if part]
    return parts[-1] if parts else ""


def _process_step_id(move: Mapping[str, Any]) -> str:
    """读取 ProcessMove 的工序编号。"""
    direct = move.get("StepID")
    if direct is not None and str(direct):
        return str(direct)
    values = _list_value(move.get("StepIDList"))
    return str(values[0]) if values else ""


def _process_job_name(move: Mapping[str, Any]) -> str:
    """读取 ProcessMove 的 PJob 名称。"""
    value = move.get("PJobName")
    values = _list_value(value)
    return str(values[0]) if values else str(value or "")


def _stage_matches_move(stage: Mapping[str, Any], move: Mapping[str, Any]) -> bool:
    """判断配置工序是否对应一个实际 ProcessMove。"""
    configured_step = str(stage.get("stepId") or "")
    if configured_step and configured_step != _process_step_id(move):
        return False
    configured_job = _short_job_name(stage.get("pjobName"))
    move_job = _short_job_name(_process_job_name(move))
    return not configured_job or not move_job or configured_job == move_job


def _process_capacity_groups(
    moves: Sequence[Mapping[str, Any]],
    resources: Sequence[Mapping[str, Any]],
    context: Optional[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """将并行工艺腔折叠成不重复的容量组。"""
    process_names = {
        str(resource["name"])
        for resource in resources
        if resource["kind"] == "process"
    }
    observed = [
        move for move in moves
        if int(move["MoveType"]) == PROCESS_MOVE_TYPE
        and move["EndTime"] > move["StartTime"] + PERFORMANCE_TIME_TOLERANCE
        and move["ModuleName"] in process_names
    ]
    stages = [
        stage for stage in (
            context.get("processStages", [])
            if isinstance(context, Mapping)
            else []
        )
        if isinstance(stage, Mapping)
    ]
    groups: List[Tuple[set[str], set[str]]] = []
    for stage in stages:
        names = {
            str(name)
            for name in _list_value(stage.get("resourceNames"))
            if str(name) in process_names
        }
        if names:
            groups.append((names, {str(stage["label"])} if stage.get("label") else set()))
    unmatched: Dict[str, set[str]] = defaultdict(set)
    for move in observed:
        matching = [stage for stage in stages if _stage_matches_move(stage, move)]
        if not matching:
            move_job = _short_job_name(_process_job_name(move))
            matching = [
                stage for stage in stages
                if move["ModuleName"] in _list_value(stage.get("resourceNames"))
                and (
                    not _short_job_name(stage.get("pjobName"))
                    or _short_job_name(stage.get("pjobName")) == move_job
                )
            ]
        if not matching:
            key = f"{_process_job_name(move)}|{_process_step_id(move)}"
            unmatched[key].add(str(move["ModuleName"]))
    for key, names in unmatched.items():
        groups.append((names, {key.replace("|", " · 工序 ", 1)}))
    merged: Dict[Tuple[str, ...], set[str]] = {}
    for names, labels in groups:
        key = tuple(sorted(names, key=_natural_key))
        merged.setdefault(key, set()).update(labels)
    return [
        {
            "resourceNames": list(names),
            "contextLabels": sorted(labels, key=_natural_key),
        }
        for names, labels in merged.items()
    ]


def _rank_bottleneck_candidates(
    moves: Sequence[Mapping[str, Any]],
    resources: Sequence[Mapping[str, Any]],
    window: Mapping[str, Any],
    context: Optional[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """由容量占用、连续性和同类强度生成多资源瓶颈候选。"""
    if window["duration"] <= PERFORMANCE_TIME_TOLERANCE:
        return []
    by_name = {str(resource["name"]): resource for resource in resources}
    raw: List[Dict[str, Any]] = []
    for group in _process_capacity_groups(moves, resources, context):
        members = [
            by_name[name]
            for name in group["resourceNames"]
            if name in by_name
        ]
        busy_time = sum(float(resource["busyTime"]) for resource in members)
        if not members or busy_time <= PERFORMANCE_TIME_TOLERANCE:
            continue
        raw.append({
            "id": f"process:{'+'.join(group['resourceNames'])}",
            "label": f"工序容量组 · {' / '.join(group['resourceNames'])}",
            "kind": "process-group",
            "resourceNames": group["resourceNames"],
            "utilization": busy_time / (len(members) * window["duration"]),
            "continuity": sum(
                max(0.0, 1.0 - resource["longestIdlePeriod"] / window["duration"])
                for resource in members
            ) / len(members),
            "contextLabels": group["contextLabels"],
        })
    for resource in resources:
        if resource["kind"] == "robot" and resource["busyTime"] > PERFORMANCE_TIME_TOLERANCE:
            raw.append({
                "id": f"robot:{resource['name']}",
                "label": resource["name"],
                "kind": "robot",
                "resourceNames": [resource["name"]],
                "utilization": resource["utilization"],
                "continuity": max(
                    0.0,
                    1.0 - resource["longestIdlePeriod"] / window["duration"],
                ),
                "contextLabels": [],
            })
    load_locks = [
        resource for resource in resources
        if resource["kind"] == "loadlock"
        and resource["busyTime"] > PERFORMANCE_TIME_TOLERANCE
    ]
    if load_locks:
        names = sorted((resource["name"] for resource in load_locks), key=_natural_key)
        raw.append({
            "id": f"loadlock:{'+'.join(names)}",
            "label": f"LoadLock 容量组 · {' / '.join(names)}",
            "kind": "loadlock-group",
            "resourceNames": names,
            "utilization": sum(resource["busyTime"] for resource in load_locks)
            / (len(load_locks) * window["duration"]),
            "continuity": sum(
                max(0.0, 1.0 - resource["longestIdlePeriod"] / window["duration"])
                for resource in load_locks
            ) / len(load_locks),
            "contextLabels": [],
        })
    maximum_by_kind: Dict[str, float] = {}
    for candidate in raw:
        maximum_by_kind[candidate["kind"]] = max(
            maximum_by_kind.get(candidate["kind"], 0.0),
            candidate["utilization"],
        )
    ranked: List[Dict[str, Any]] = []
    for candidate in raw:
        relative = candidate["utilization"] / max(
            maximum_by_kind.get(candidate["kind"], 0.0),
            PERFORMANCE_TIME_TOLERANCE,
        )
        score = min(
            1.0,
            candidate["utilization"] * 0.82
            + candidate["continuity"] * 0.12
            + relative * 0.06,
        )
        confidence = "high" if score >= 0.72 else "medium" if score >= 0.45 else "low"
        evidence = [
            (
                "组平均容量占用" if len(candidate["resourceNames"]) > 1 else "资源占用"
            ) + f" {candidate['utilization'] * 100:.1f}%",
            f"最长空闲折算连续性 {candidate['continuity'] * 100:.1f}%",
        ]
        if len(candidate["resourceNames"]) > 1:
            evidence.append(f"并行/同类资源 {'、'.join(candidate['resourceNames'])}")
        if candidate["contextLabels"]:
            evidence.append(f"关联 {'、'.join(candidate['contextLabels'][:3])}")
        ranked.append({
            "id": candidate["id"],
            "label": candidate["label"],
            "kind": candidate["kind"],
            "resourceNames": candidate["resourceNames"],
            "utilization": max(0.0, min(candidate["utilization"], 1.0)),
            "continuity": max(0.0, min(candidate["continuity"], 1.0)),
            "score": score,
            "confidence": confidence,
            "evidence": evidence,
        })
    ranked.sort(
        key=lambda candidate: (
            -candidate["score"],
            -candidate["utilization"],
            _natural_key(candidate["label"]),
        ),
    )
    if not ranked:
        return []
    top_score = ranked[0]["score"]
    threshold = max(0.2, top_score * 0.72, top_score - 0.16)
    return [candidate for candidate in ranked if candidate["score"] >= threshold][:5]


def _diagnose_schedule(performance: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """将轨迹证据转成可证伪的诊断假设和下一步实验。"""
    diagnostics: List[Dict[str, Any]] = []
    for candidate in performance["bottleneckCandidates"][:2]:
        confidence = (
            "strong" if candidate["confidence"] == "high"
            else "moderate" if candidate["confidence"] == "medium"
            else "exploratory"
        )
        if candidate["kind"] == "process-group":
            diagnostics.append({
                "title": "优先验证工艺容量是否限制节拍",
                "confidence": confidence,
                "finding": (
                    f"{candidate['label']} 是当前最可能的容量约束；"
                    "先验证加工时长变化是否会同步改变总体完工时间。"
                ),
                "evidence": [
                    {
                        "label": "容量利用率",
                        "value": f"{max(0.0, candidate['utilization']) * 100:.1f}%",
                        "interpretation": "同组并行腔室在统计窗口内的平均忙碌程度。",
                    },
                    {
                        "label": "加工后驻留",
                        "value": (
                            f"{max(0.0, performance['processChamberDwellTime']['meanSeconds']):.2f} s"
                        ),
                        "interpretation": "若同时偏高，说明腔室释放还可能被下游搬运阻塞。",
                    },
                ],
                "nextExperiment": {
                    "id": "processing-time-compare",
                    "label": "对比加工时长变化",
                    "change": "复制当前测试，小幅调整加工与清洁时长后重新运行并对比。",
                    "expectedSignal": "若瓶颈判断成立，makespan 会敏感上升，且该资源仍保持主要候选。",
                },
                "limitation": "这是由执行轨迹重建的因果假设，不是算法内部候选动作打分。",
            })
        elif candidate["kind"] == "robot":
            diagnostics.append({
                "title": "优先验证搬运资源是否造成排队",
                "confidence": confidence,
                "finding": f"{candidate['label']} 的占用与连续忙碌证据最强，可能限制工艺腔及时上下片。",
                "evidence": [
                    {
                        "label": "容量利用率",
                        "value": f"{max(0.0, candidate['utilization']) * 100:.1f}%",
                        "interpretation": "传输动作占据该机器人可服务窗口的比例。",
                    },
                    {
                        "label": "手上驻留",
                        "value": (
                            f"{max(0.0, performance['robotWaferDwellTime']['meanSeconds']):.2f} s"
                        ),
                        "interpretation": "晶圆被取出后等待放置的平均时间，已剔除显式运输区间。",
                    },
                ],
                "nextExperiment": {
                    "id": "release-sequence-review",
                    "label": "对比搬运优先级",
                    "change": "复制当前测试，仅调整释放或派工优先级后重新运行。",
                    "expectedSignal": "若搬运次序是主因，机器手驻留和总体完工时间应同步下降。",
                },
                "limitation": "当前只能观察已执行动作，无法宣称算法当时没有评估其他可行动作。",
            })
        else:
            diagnostics.append({
                "title": "优先验证真空交接是否限制流量",
                "confidence": confidence,
                "finding": f"{candidate['label']} 在抽充气与交接阶段形成较高容量占用，可能放大真空端等待。",
                "evidence": [
                    {
                        "label": "容量利用率",
                        "value": f"{max(0.0, candidate['utilization']) * 100:.1f}%",
                        "interpretation": "LoadLock 组在统计窗口内处理交接工作的平均占用。",
                    },
                    {
                        "label": "连续性",
                        "value": f"{max(0.0, candidate['continuity']) * 100:.1f}%",
                        "interpretation": "反映 LoadLock 容量活动是否持续，越高表示空闲断点越少。",
                    },
                ],
                "nextExperiment": {
                    "id": "loadlock-policy-compare",
                    "label": "对比 LoadLock 管理策略",
                    "change": "保持测试组不变，仅切换 LoadLock 管理器后重新运行。",
                    "expectedSignal": "若交接策略是主因，真空等待与 makespan 应同时变化。",
                },
                "limitation": "LoadLock 占用可能是上游释放或下游加工拥塞的结果，需要配对实验区分。",
            })
    if performance["departureIntervalCv"] >= 0.25:
        diagnostics.append({
            "title": "出站节拍波动需要单独验证",
            "confidence": (
                "moderate" if performance["completedWaferCount"] >= 8 else "exploratory"
            ),
            "finding": (
                f"出站间隔 CV 为 {performance['departureIntervalCv']:.2f}，"
                "均值无法代表局部拥塞或饥饿。"
            ),
            "evidence": [
                {
                    "label": "出站间隔 CV",
                    "value": f"{performance['departureIntervalCv']:.2f}",
                    "interpretation": "越高表示相邻晶圆完成间隔越不均匀。",
                },
                {
                    "label": "完整晶圆样本",
                    "value": f"{performance['completedWaferCount']} 片",
                    "interpretation": "样本越少，波动判断越应视作探索性线索。",
                },
            ],
            "nextExperiment": {
                "id": "load-level-compare",
                "label": "补齐负载梯度测试",
                "change": "复制当前测试，分别降低与提高晶圆规模，再对比节拍 CV 与吞吐。",
                "expectedSignal": "若波动来自容量临界点，中高负载用例的 CV 会持续升高。",
            },
            "limitation": "CV 只描述波动，不直接说明调度策略或设备容量谁是根因。",
        })
    return diagnostics


def analyze_schedule_performance(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
    mode: str = "steady",
    context: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """计算服务端 MoveList 性能、瓶颈候选、驻留时间和诊断建议。

    参数:
        moves: MoveList 动作列表。
        device: 包含 Stations/Robots 的设备定义，可为空。
        mode: ``steady`` 或 ``full`` 统计窗口。
        context: 由 Route 和测试轮次生成的工序容量上下文。

    返回:
        可直接通过 JSON API 返回的完整性能分析。
    """
    if mode not in {"steady", "full"}:
        raise ValueError("分析窗口只支持 steady 或 full")
    records = _normalize_moves(moves)
    window = _performance_window(records, device, mode)
    definitions = _performance_resource_definitions(records, device)
    intervals_by_resource = _resource_activity_intervals(records, device)
    resources: List[Dict[str, Any]] = []
    for name, definition in definitions.items():
        summary = _summarize_intervals(
            intervals_by_resource.get(name, []),
            window["start"],
            window["end"],
        )
        resources.append({
            "name": name,
            "type": definition["type"],
            "kind": definition["kind"],
            "utilization": (
                summary["busyTime"] / window["duration"]
                if window["duration"] > PERFORMANCE_TIME_TOLERANCE
                else 0.0
            ),
            **summary,
            "isBottleneck": False,
            "bottleneckCandidateRank": None,
        })
    candidates = _rank_bottleneck_candidates(records, resources, window, context)
    primary = candidates[0] if candidates else None
    for candidate_index, candidate in enumerate(candidates):
        for resource_name in candidate["resourceNames"]:
            resource = next(
                (item for item in resources if item["name"] == resource_name),
                None,
            )
            if resource is None:
                continue
            rank = candidate_index + 1
            previous_rank = resource["bottleneckCandidateRank"]
            resource["bottleneckCandidateRank"] = (
                rank if previous_rank is None else min(previous_rank, rank)
            )
            if candidate_index == 0:
                resource["isBottleneck"] = True
    bottleneck = (
        next(
            (
                resource for resource in resources
                if resource["name"] in primary["resourceNames"]
            ),
            None,
        )
        if primary
        else None
    )
    resources.sort(
        key=lambda resource: (
            -int(resource["isBottleneck"]),
            RESOURCE_KIND_ORDER[resource["kind"]],
            -resource["utilization"],
            _natural_key(resource["name"]),
        ),
    )
    _, completions = _wafer_boundary_times(records, device)
    completion_times = sorted(
        completed_at
        for completed_at in completions.values()
        if _completion_inside_window(completed_at, window)
    )
    departure_intervals = [
        current - previous
        for previous, current in zip(completion_times, completion_times[1:])
    ]
    mean_departure_interval = (
        sum(departure_intervals) / len(departure_intervals)
        if departure_intervals
        else 0.0
    )
    performance = {
        "window": window,
        "resources": resources,
        "bottleneckCandidates": candidates,
        "primaryBottleneck": primary,
        "bottleneck": bottleneck,
        "completedWaferCount": len(completion_times),
        "throughputPerHour": (
            SECONDS_PER_HOUR / mean_departure_interval
            if mean_departure_interval > PERFORMANCE_TIME_TOLERANCE
            else 0.0
        ),
        "meanDepartureInterval": mean_departure_interval,
        "departureIntervalCv": _coefficient_of_variation(departure_intervals),
        "processChamberDwellTime": _process_chamber_dwell_time(
            records, device, window,
        ),
        "robotWaferDwellTime": _robot_wafer_dwell_time(records, window),
        "waferSystemResidenceTime": _wafer_system_residence_time(
            records, device, window,
        ),
        "loadLockCycles": _build_load_lock_cycles(records, device),
    }
    performance["diagnostics"] = _diagnose_schedule(performance)
    return performance


def summarize_bottleneck_utilization(
    performance: Mapping[str, Any],
) -> Optional[Dict[str, Any]]:
    """将完整性能分析压缩为结果预览所需的瓶颈摘要。"""
    candidate = performance.get("primaryBottleneck")
    if not isinstance(candidate, Mapping):
        return None
    window = performance.get("window")
    window_label = window.get("label") if isinstance(window, Mapping) else ""
    candidates = performance.get("bottleneckCandidates")
    return {
        "resourceName": candidate.get("label"),
        "utilization": candidate.get("utilization"),
        "windowLabel": window_label,
        "confidence": candidate.get("confidence"),
        "candidateCount": len(candidates) if isinstance(candidates, list) else 0,
        "score": candidate.get("score"),
    }


def build_schedule_analysis_context(
    routes: Optional[Sequence[Mapping[str, Any]]],
    rounds: Optional[Sequence[Mapping[str, Any]]],
) -> Dict[str, Any]:
    """从 Route/PJob 配置提取每道工序的完整并行腔室集合。"""
    route_by_name = {
        str(route.get("name") or ""): route
        for route in (routes or [])
        if isinstance(route, Mapping)
    }
    process_stages: List[Dict[str, Any]] = []
    for round_index, round_row in enumerate(rounds or []):
        for cjob_index, cjob in enumerate(_list_value(round_row.get("cjobs"))):
            if not isinstance(cjob, Mapping):
                continue
            for pjob in _list_value(cjob.get("pjobs")):
                if not isinstance(pjob, Mapping):
                    continue
                route = route_by_name.get(str(pjob.get("routeRef") or ""))
                if not isinstance(route, Mapping):
                    continue
                process_ordinal = 0
                for stage in _list_value(route.get("stages")):
                    if not isinstance(stage, Mapping) or not stage.get("needProcess"):
                        continue
                    process_ordinal += 1
                    resource_names = list(dict.fromkeys(
                        str(visit.get("stationName") or "").strip()
                        for visit in _list_value(stage.get("visits"))
                        if isinstance(visit, Mapping)
                        and str(visit.get("stationName") or "").strip()
                    ))
                    if not resource_names:
                        continue
                    task_id = str(round_index + 1)
                    cjob_key = str(cjob.get("key") or f"C{cjob_index + 1}")
                    job_name = str(pjob.get("jobName") or "P?")
                    process_stages.append({
                        "id": (
                            f"{task_id}.{cjob_key}.{job_name}:"
                            f"step-{stage.get('stepId')}"
                        ),
                        "label": f"{job_name} · 工序 {process_ordinal}",
                        "pjobName": f"{task_id}.{cjob_key}.{job_name}",
                        "stepId": stage.get("stepId"),
                        "resourceNames": resource_names,
                    })
    return {"processStages": process_stages}


def _normalize_group_case(input_case: Mapping[str, Any]) -> Dict[str, Any]:
    """把一条测试结果规范化为组级统计的稳定字段。"""
    makespan = _finite_or_none(input_case.get("makespan"))
    baseline_makespan = _finite_or_none(input_case.get("baselineMakespan"))
    status = str(input_case.get("status") or "unknown")
    comparable = (
        status == "succeeded"
        and makespan is not None
        and baseline_makespan is not None
        and baseline_makespan > 0
    )
    improvement = (
        (baseline_makespan - makespan) / baseline_makespan * 100
        if comparable and baseline_makespan is not None and makespan is not None
        else None
    )
    performance = (
        input_case.get("performance")
        if isinstance(input_case.get("performance"), Mapping)
        else None
    )
    primary = (
        performance.get("primaryBottleneck")
        if isinstance(performance, Mapping)
        and isinstance(performance.get("primaryBottleneck"), Mapping)
        else None
    )
    legacy = (
        performance.get("bottleneck")
        if isinstance(performance, Mapping)
        and isinstance(performance.get("bottleneck"), Mapping)
        else None
    )
    raw_candidates = (
        performance.get("bottleneckCandidates", [])
        if isinstance(performance, Mapping)
        else []
    )
    candidates = [
        {
            "resourceName": candidate.get("label"),
            "utilization": candidate.get("utilization"),
            "score": candidate.get("score"),
            "confidence": candidate.get("confidence"),
        }
        for candidate in raw_candidates
        if isinstance(candidate, Mapping)
    ]
    if not candidates and legacy:
        candidates = [{
            "resourceName": legacy.get("name"),
            "utilization": legacy.get("utilization"),
            "score": legacy.get("utilization"),
            "confidence": "",
        }]

    def sampled_metric(field: str, value: str) -> Optional[float]:
        """读取具有 sampleCount 的时长指标。"""
        metric = performance.get(field) if isinstance(performance, Mapping) else None
        return (
            _finite_or_none(metric.get(value))
            if isinstance(metric, Mapping) and metric.get("sampleCount")
            else None
        )

    window = performance.get("window") if isinstance(performance, Mapping) else None
    return {
        "id": str(input_case.get("id") or ""),
        "name": str(input_case.get("name") or ""),
        "status": status,
        "validation": str(input_case.get("validation") or "unknown"),
        "validationPassed": input_case.get("validation") == "passed",
        "makespan": makespan,
        "baselineMakespan": baseline_makespan,
        "comparable": comparable,
        "improvementPercent": improvement,
        "performanceRatio": (
            makespan / baseline_makespan
            if comparable and makespan is not None and baseline_makespan
            else None
        ),
        "cpuTimeMs": _finite_or_none(input_case.get("cpuTimeMs")),
        "elapsedTimeMs": _finite_or_none(input_case.get("elapsedTimeMs")),
        "bottleneckResource": str(
            (primary or {}).get("label") or (legacy or {}).get("name") or ""
        ),
        "bottleneckUtilization": _finite_or_none(
            (primary or {}).get("utilization", (legacy or {}).get("utilization"))
        ),
        "bottleneckCandidateCount": len(raw_candidates) if raw_candidates else int(bool(legacy)),
        "bottleneckCandidates": candidates,
        "throughputPerHour": (
            _finite_or_none(performance.get("throughputPerHour"))
            if isinstance(performance, Mapping)
            else None
        ),
        "departureIntervalCv": (
            _finite_or_none(performance.get("departureIntervalCv"))
            if isinstance(performance, Mapping)
            else None
        ),
        "processChamberDwellMeanSeconds": sampled_metric(
            "processChamberDwellTime", "meanSeconds",
        ),
        "robotWaferDwellMeanSeconds": sampled_metric(
            "robotWaferDwellTime", "meanSeconds",
        ),
        "waferSystemResidenceMeanSeconds": sampled_metric(
            "waferSystemResidenceTime", "meanSeconds",
        ),
        "waferSystemResidenceCv": sampled_metric(
            "waferSystemResidenceTime", "coefficientOfVariation",
        ),
        "windowMethod": str(window.get("method") or "") if isinstance(window, Mapping) else "",
        "error": str(input_case.get("error") or ""),
    }


def analyze_test_group_performance(
    inputs: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """生成完整测试组统计，不将不同量纲压成单一综合分数。"""
    cases = [_normalize_group_case(input_case) for input_case in inputs]
    succeeded = [item for item in cases if item["status"] == "succeeded"]
    comparable = [item for item in cases if item["comparable"]]
    improvements = [
        item["improvementPercent"]
        for item in comparable
        if item["improvementPercent"] is not None
    ]
    total_makespan = sum(item["makespan"] or 0.0 for item in comparable)
    total_baseline = sum(item["baselineMakespan"] or 0.0 for item in comparable)

    def succeeded_values(field: str, positive: bool = False) -> List[float]:
        """收集成功案例中的有效数值字段。"""
        values = [
            item[field] for item in succeeded
            if item[field] is not None
            and (not positive or item[field] > 0)
        ]
        return [float(value) for value in values]

    cpu_times = [
        float(item["cpuTimeMs"])
        for item in succeeded
        if item["cpuTimeMs"] is not None and item["cpuTimeMs"] >= 0
    ]
    frequency_map: Dict[str, List[float]] = defaultdict(list)
    window_method_counts: Dict[str, int] = defaultdict(int)
    for item in succeeded:
        for candidate in item["bottleneckCandidates"]:
            resource_name = str(candidate.get("resourceName") or "")
            utilization = _finite_or_none(candidate.get("utilization"))
            if resource_name and utilization is not None:
                frequency_map[resource_name].append(utilization)
        if item["windowMethod"]:
            window_method_counts[item["windowMethod"]] += 1
    frequencies = [
        {
            "resourceName": resource_name,
            "count": len(values),
            "share": len(values) / len(succeeded) if succeeded else 0.0,
            "medianUtilization": _percentile(values, 0.5) or 0.0,
        }
        for resource_name, values in frequency_map.items()
    ]
    frequencies.sort(
        key=lambda item: (
            -item["count"],
            -item["medianUtilization"],
            _natural_key(item["resourceName"]),
        ),
    )
    validation_passed_count = sum(
        1 for item in succeeded if item["validationPassed"]
    )
    return {
        "cases": cases,
        "totalCount": len(cases),
        "succeededCount": len(succeeded),
        "failedCount": len(cases) - len(succeeded),
        "validationPassedCount": validation_passed_count,
        "validationPassRate": (
            validation_passed_count / len(succeeded) if succeeded else 0.0
        ),
        "comparableCount": len(comparable),
        "winCount": sum(
            1 for value in improvements
            if value > COMPARISON_TOLERANCE_PERCENT
        ),
        "tieCount": sum(
            1 for value in improvements
            if abs(value) <= COMPARISON_TOLERANCE_PERCENT
        ),
        "regressionCount": sum(
            1 for value in improvements
            if value < -COMPARISON_TOLERANCE_PERCENT
        ),
        "weightedImprovementPercent": (
            (total_baseline - total_makespan) / total_baseline * 100
            if total_baseline > 0
            else None
        ),
        "medianImprovementPercent": _percentile(improvements, 0.5),
        "worstRegressionPercent": (
            min(improvements) if any(value < 0 for value in improvements) else None
        ),
        "medianCpuTimeMs": _percentile(cpu_times, 0.5),
        "p90CpuTimeMs": _percentile(cpu_times, 0.9),
        "totalCpuTimeMs": sum(cpu_times),
        "medianBottleneckUtilization": _percentile(
            succeeded_values("bottleneckUtilization"), 0.5,
        ),
        "medianThroughputPerHour": _percentile(
            succeeded_values("throughputPerHour", positive=True), 0.5,
        ),
        "medianDepartureIntervalCv": _percentile(
            succeeded_values("departureIntervalCv"), 0.5,
        ),
        "medianProcessChamberDwellMeanSeconds": _percentile(
            succeeded_values("processChamberDwellMeanSeconds"), 0.5,
        ),
        "medianRobotWaferDwellMeanSeconds": _percentile(
            succeeded_values("robotWaferDwellMeanSeconds"), 0.5,
        ),
        "medianWaferSystemResidenceMeanSeconds": _percentile(
            succeeded_values("waferSystemResidenceMeanSeconds"), 0.5,
        ),
        "medianWaferSystemResidenceCv": _percentile(
            succeeded_values("waferSystemResidenceCv"), 0.5,
        ),
        "bottleneckFrequencies": frequencies,
        "windowMethodCounts": dict(window_method_counts),
    }
