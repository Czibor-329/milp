"""独立的 MoveList 生产指标计算。

本模块只依赖 Python 标准库，输入、输出均为普通字典/列表，便于把整个
``production_metrics`` 文件夹复制到其他项目中复用。
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


SECONDS_PER_HOUR = 3600.0
MINIMUM_TOTAL_WAFERS = 150
STEADY_SAMPLE_SIZE = 120
TRIMMED_HEAD_WAFERS = 15
TRIMMED_TAIL_WAFERS = 15
TIME_TOLERANCE = 1e-6
PICK_MOVE_TYPES = frozenset({0, 2})
PLACE_MOVE_TYPES = frozenset({1, 3})
SWAP_MOVE_TYPE = 4
PROCESS_MOVE_TYPE = 9


def _finite_number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _finite_or_none(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _list_value(value: Any) -> List[Any]:
    return list(value) if isinstance(value, list) else []


def _natural_key(value: str) -> List[Any]:
    return [
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", str(value))
    ]


def _material_ids(move: Mapping[str, Any], field: str = "MatIDList") -> List[str]:
    return [str(value) for value in _list_value(move.get(field)) if str(value)]


def _first_value(move: Mapping[str, Any], field: str) -> str:
    values = _list_value(move.get(field))
    return str(values[0]) if values else ""


def _normalize_moves(moves: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    for index, raw_move in enumerate(moves):
        move = dict(raw_move)
        start = _finite_number(move.get("StartTime"))
        end = max(start, _finite_number(move.get("EndTime"), start))
        move.update({
            "MoveID": int(_finite_number(move.get("MoveID"), index + 1)),
            "MoveType": int(_finite_number(move.get("MoveType"), -1)),
            "ModuleName": str(move.get("ModuleName") or ""),
            "StartTime": start,
            "EndTime": end,
        })
        records.append(move)
    return sorted(records, key=lambda item: (item["StartTime"], item["EndTime"], item["MoveID"]))


def _station_type(device: Optional[Mapping[str, Any]], name: str) -> str:
    stations = device.get("Stations") if isinstance(device, Mapping) else None
    definition = stations.get(name) if isinstance(stations, Mapping) else None
    return str(definition.get("Type") or "") if isinstance(definition, Mapping) else ""


def _is_load_port(device: Optional[Mapping[str, Any]], name: str) -> bool:
    station_type = _station_type(device, name).casefold()
    return station_type == "loadport" or bool(re.match(r"^(LP\d*|P\d+)$", name, re.IGNORECASE))


def _wafer_boundary_times(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]],
) -> Tuple[Dict[str, float], Dict[str, float]]:
    entries: Dict[str, float] = {}
    completions: Dict[str, float] = {}
    for move in moves:
        move_type = int(move["MoveType"])
        if move_type in PICK_MOVE_TYPES:
            source = _first_value(move, "SrcStationList")
            if _is_load_port(device, source):
                for wafer in _material_ids(move):
                    entries.setdefault(wafer, float(move["EndTime"]))
        elif move_type in PLACE_MOVE_TYPES:
            destination = _first_value(move, "DestStationList")
            if _is_load_port(device, destination):
                for wafer in _material_ids(move):
                    completions[wafer] = float(move["EndTime"])
        elif move_type == SWAP_MOVE_TYPE:
            station = _first_value(move, "StationList")
            if not _is_load_port(device, station):
                continue
            for wafer in _material_ids(move, "SendMatList"):
                entries.setdefault(wafer, float(move["EndTime"]))
            for wafer in _material_ids(move, "RecvMatList"):
                completions[wafer] = float(move["EndTime"])
    return entries, completions


def _process_step(move: Mapping[str, Any]) -> str:
    if move.get("StepID") is not None and str(move.get("StepID")):
        return str(move.get("StepID"))
    return _first_value(move, "StepIDList")


def _process_job(move: Mapping[str, Any]) -> str:
    value = move.get("PJobName")
    values = _list_value(value)
    return str(values[0]) if values else str(value or "")


def _process_events(
    moves: Sequence[Mapping[str, Any]],
    selected_wafers: set[str],
) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    for move in moves:
        if int(move["MoveType"]) != PROCESS_MOVE_TYPE:
            continue
        chamber = str(move.get("ModuleName") or "")
        if not chamber:
            continue
        for wafer in _material_ids(move):
            if wafer not in selected_wafers:
                continue
            events.append({
                "wafer": wafer,
                "chamber": chamber,
                "startedAt": float(move["StartTime"]),
                "endedAt": float(move["EndTime"]),
                "stepId": _process_step(move),
                "recipe": str(move.get("ProcessRecipe") or ""),
                "pjobName": _process_job(move),
            })
    return sorted(
        events,
        key=lambda event: (event["startedAt"], event["endedAt"], _natural_key(event["wafer"])),
    )


def _route_by_pjob(context: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    rows = context.get("pjobRoutes") if isinstance(context, Mapping) else None
    return {
        str(row.get("pjobName") or ""): str(row.get("routeRef") or "")
        for row in _list_value(rows)
        if isinstance(row, Mapping) and str(row.get("pjobName") or "")
    }


def _flow_signatures(
    events: Sequence[Mapping[str, Any]],
    wafer_ids: Sequence[str],
    context: Optional[Mapping[str, Any]],
) -> Dict[str, Tuple[Any, ...]]:
    events_by_wafer: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
    for event in events:
        events_by_wafer[str(event["wafer"])].append(event)
    route_by_job = _route_by_pjob(context)
    signatures: Dict[str, Tuple[Any, ...]] = {}
    for wafer in wafer_ids:
        wafer_events = events_by_wafer.get(wafer, [])
        route_refs = tuple(sorted({
            route_by_job.get(str(event.get("pjobName") or ""), "")
            for event in wafer_events
            if route_by_job.get(str(event.get("pjobName") or ""), "")
        }))
        process_path = tuple(
            (str(event.get("stepId") or ""), str(event.get("recipe") or ""))
            for event in wafer_events
        )
        signatures[wafer] = (route_refs, process_path)
    return signatures


def _population_std(values: Sequence[float]) -> Optional[float]:
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))


def _merge_duration(
    intervals: Iterable[Tuple[float, float]],
    window_start: float,
    window_end: float,
) -> float:
    clipped = sorted(
        (max(start, window_start), min(end, window_end))
        for start, end in intervals
        if min(end, window_end) > max(start, window_start) + TIME_TOLERANCE
    )
    total = 0.0
    active_start: Optional[float] = None
    active_end = 0.0
    for start, end in clipped:
        if active_start is None:
            active_start, active_end = start, end
        elif start <= active_end + TIME_TOLERANCE:
            active_end = max(active_end, end)
        else:
            total += active_end - active_start
            active_start, active_end = start, end
    return total if active_start is None else total + active_end - active_start


def _module_utilization(
    moves: Sequence[Mapping[str, Any]],
    window_start: float,
    window_end: float,
) -> List[Dict[str, Any]]:
    intervals: Dict[str, List[Tuple[float, float]]] = defaultdict(list)
    for move in moves:
        name = str(move.get("ModuleName") or "")
        start = float(move["StartTime"])
        end = float(move["EndTime"])
        if name and end > start + TIME_TOLERANCE:
            intervals[name].append((start, end))
    duration = max(window_end - window_start, 0.0)
    rows = []
    for name, resource_intervals in intervals.items():
        busy_time = _merge_duration(resource_intervals, window_start, window_end)
        if busy_time <= TIME_TOLERANCE:
            continue
        rows.append({
            "name": name,
            "busyTimeSeconds": busy_time,
            "utilization": min(busy_time / duration, 1.0) if duration > TIME_TOLERANCE else 0.0,
        })
    return sorted(rows, key=lambda row: (-row["utilization"], _natural_key(row["name"])))


def _surpass_count(
    actual_entries: Sequence[Tuple[str, float]],
    expected_wafers: Sequence[str],
) -> int:
    """统计至少越过一片前序晶圆的后序晶圆数量。

    同一时刻开始加工的晶圆视为同时进腔，彼此不构成超片。
    """
    expected_rank = {wafer: index for index, wafer in enumerate(expected_wafers)}
    remaining = set(expected_rank)
    count = 0
    index = 0
    while index < len(actual_entries):
        started_at = actual_entries[index][1]
        batch: List[str] = []
        while (
            index < len(actual_entries)
            and abs(actual_entries[index][1] - started_at) <= TIME_TOLERANCE
        ):
            batch.append(actual_entries[index][0])
            index += 1
        outside_batch = remaining.difference(batch)
        for wafer in batch:
            if wafer not in remaining:
                continue
            rank = expected_rank[wafer]
            if any(expected_rank[pending] < rank for pending in outside_batch):
                count += 1
        remaining.difference_update(batch)
    return count


def _chamber_metrics(
    events: Sequence[Mapping[str, Any]],
    expected_order: Sequence[str],
) -> List[Dict[str, Any]]:
    grouped: Dict[Tuple[str, str, str], List[Mapping[str, Any]]] = defaultdict(list)
    for event in events:
        grouped[(
            str(event["chamber"]),
            str(event.get("stepId") or ""),
            str(event.get("recipe") or ""),
        )].append(event)
    rows: List[Dict[str, Any]] = []
    for (chamber, step_id, recipe), group_events in grouped.items():
        ordered = sorted(
            group_events,
            key=lambda event: (float(event["startedAt"]), _natural_key(str(event["wafer"]))),
        )
        start_times = [float(event["startedAt"]) for event in ordered]
        intervals = [current - previous for previous, current in zip(start_times, start_times[1:])]
        k = len(start_times) - 1
        elapsed = start_times[-1] - start_times[0] if k > 0 else 0.0
        actual_wafers = [str(event["wafer"]) for event in ordered]
        group_set = set(actual_wafers)
        expected = [wafer for wafer in expected_order if wafer in group_set]
        surpass_count = _surpass_count(
            [(str(event["wafer"]), float(event["startedAt"])) for event in ordered],
            expected,
        )
        denominator = len(actual_wafers)
        rows.append({
            "chamber": chamber,
            "stepId": step_id,
            "recipe": recipe,
            "waferCount": len(actual_wafers),
            "k": k,
            "throughputPerHour": SECONDS_PER_HOUR * k / elapsed if elapsed > TIME_TOLERANCE else None,
            "entryIntervalStdSeconds": _population_std(intervals),
            "surpassWaferCount": surpass_count,
            "surpassRate": surpass_count / denominator if denominator else None,
        })
    return sorted(
        rows,
        key=lambda row: (_natural_key(row["chamber"]), _natural_key(row["stepId"]), row["recipe"]),
    )


def _parallel_chamber_count(
    events: Sequence[Mapping[str, Any]],
    context: Optional[Mapping[str, Any]],
) -> int:
    if not events:
        return 0
    step_id = str(events[0].get("stepId") or "")
    pjob_names = {str(event.get("pjobName") or "") for event in events}
    configured: set[str] = set()
    stages = context.get("processStages") if isinstance(context, Mapping) else None
    for stage in _list_value(stages):
        if not isinstance(stage, Mapping):
            continue
        if str(stage.get("stepId") or "") != step_id:
            continue
        stage_job = str(stage.get("pjobName") or "")
        if stage_job and pjob_names and stage_job not in pjob_names:
            continue
        configured.update(str(name) for name in _list_value(stage.get("resourceNames")) if str(name))
    return len(configured) or len({str(event["chamber"]) for event in events})


def calculate_production_metrics(
    moves: Sequence[Mapping[str, Any]],
    device: Optional[Mapping[str, Any]] = None,
    context: Optional[Mapping[str, Any]] = None,
    calculation_seconds: Any = None,
) -> Dict[str, Any]:
    """计算本次新增的独立指标集合。"""
    records = _normalize_moves(moves)
    entries, completions = _wafer_boundary_times(records, device)
    completed = sorted(
        completions.items(),
        key=lambda item: (item[1], _natural_key(item[0])),
    )
    selected = completed[
        TRIMMED_HEAD_WAFERS:TRIMMED_HEAD_WAFERS + STEADY_SAMPLE_SIZE
    ] if len(completed) >= MINIMUM_TOTAL_WAFERS else []
    selected_ids = [wafer for wafer, _ in selected]
    selected_set = set(selected_ids)
    process_events = _process_events(records, selected_set)
    signatures = _flow_signatures(process_events, selected_ids, context)
    signature_values = list(signatures.values())
    has_process_path = bool(signature_values) and all(signature[1] for signature in signature_values)
    homogeneous = has_process_path and len(set(signature_values)) == 1
    calculation = _finite_or_none(calculation_seconds)
    calculation = max(calculation, 0.0) if calculation is not None else None

    result: Dict[str, Any] = {
        "schemaVersion": "production-metrics-v1",
        "configuration": {
            "sampleSize": STEADY_SAMPLE_SIZE,
            "trimmedHeadWafers": TRIMMED_HEAD_WAFERS,
            "trimmedTailWafers": TRIMMED_TAIL_WAFERS,
            "minimumTotalWafers": MINIMUM_TOTAL_WAFERS,
        },
        "calculationSeconds": calculation,
        "sampleWindow": {
            "available": bool(selected),
            "totalCompletedWafers": len(completed),
            "selectedWaferCount": len(selected),
            "waferIds": selected_ids,
            "start": selected[0][1] if selected else None,
            "end": selected[-1][1] if selected else None,
            "durationSeconds": selected[-1][1] - selected[0][1] if len(selected) > 1 else None,
            "reason": "" if selected else f"至少需要 {MINIMUM_TOTAL_WAFERS} 片完工晶圆，才能剔除前后各 15 片并固定选取中间 120 片。",
        },
        "applicability": {
            "sameRecipeAndPath": homogeneous,
            "reason": "" if homogeneous else (
                "选中的 120 片没有完整工艺记录。"
                if selected and not has_process_path
                else "选中的 120 片并非相同 Recipe 和路径，按约定不计算产能、RPT、进腔节拍和超片率。"
                if selected
                else "样本窗口不可用。"
            ),
        },
        "overall": {
            "available": False,
            "throughputPerHour": None,
            "rptMinutes": None,
            "parallelChamberCount": None,
            "reason": "",
        },
        "chambers": [],
        "modules": [],
    }
    if not selected:
        result["overall"]["reason"] = result["sampleWindow"]["reason"]
        return result

    window_start = float(selected[0][1])
    window_end = float(selected[-1][1])
    result["modules"] = _module_utilization(records, window_start, window_end)
    if not homogeneous:
        result["overall"]["reason"] = result["applicability"]["reason"]
        return result

    duration = window_end - window_start
    throughput = (
        SECONDS_PER_HOUR * STEADY_SAMPLE_SIZE / duration
        if duration > TIME_TOLERANCE
        else None
    )
    expected_order = [
        wafer for wafer, _ in sorted(
            ((wafer, entries[wafer]) for wafer in selected_ids if wafer in entries),
            key=lambda item: (item[1], _natural_key(item[0])),
        )
    ]
    result["chambers"] = _chamber_metrics(process_events, expected_order)

    common_signature = signature_values[0][1]
    rpt_reason = ""
    rpt_minutes: Optional[float] = None
    parallel_count: Optional[int] = None
    if len(common_signature) != 1:
        rpt_reason = "RPT 仅适用于单工艺节点的并行腔室路径。"
    elif throughput is None or throughput <= TIME_TOLERANCE:
        rpt_reason = "整体产能不可用，无法计算 RPT。"
    else:
        parallel_count = _parallel_chamber_count(process_events, context)
        if parallel_count > 0:
            rpt_minutes = 60.0 / (throughput / parallel_count)
        else:
            rpt_reason = "未识别到并行腔室数量。"
    result["overall"] = {
        "available": throughput is not None,
        "throughputPerHour": throughput,
        "rptMinutes": rpt_minutes,
        "parallelChamberCount": parallel_count,
        "reason": rpt_reason,
    }
    return result
