"""死锁诊断包的结构化组装与 JSON 导出。

本模块属于运行产物边界：它不重新判断动作是否合法，而是把算法在指定回放
时刻给出的动作分类、当前代输入、Move 状态和浏览器拓扑快照汇总为可复现文件。
诊断包保留完整 MoveList，并额外提供面向排障的最近动作与晶圆路径进度索引。
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import re
from typing import Any, Dict, Mapping, Sequence


DEADLOCK_DIAGNOSTIC_SCHEMA_VERSION = 1
RECENT_MOVE_LIMIT = 20
TIME_TOLERANCE_SECONDS = 1e-6


def build_deadlock_diagnostic_bundle(
    *,
    replay_time: float,
    plan: Mapping[str, Any],
    moves: Sequence[Mapping[str, Any]],
    update_params: Mapping[str, Any],
    move_states: Sequence[Mapping[str, Any]],
    decision: Mapping[str, Any],
    recompute_round: int,
    playback_snapshot: Mapping[str, Any] | None = None,
    result_id: str = "",
) -> Dict[str, Any]:
    """组装一份可独立分析的死锁诊断包。

    参数:
        replay_time: 用户在拓扑回放中选中的秒数。
        plan: 生成 MoveList 的完整计划，包含 device、routes 与 rounds。
        moves: 完整且已规范化的 MoveList。
        update_params: 当前时刻命中的算法 ``IUpdateParams``。
        move_states: 当前代已经发布给算法的 Move 状态。
        decision: 算法 ``get_replay_actions`` 返回并规范化后的动作分类。
        recompute_round: 当前 update 在已保存更新序列中的一基序号。
        playback_snapshot: 浏览器当前画面的模块、机器人和槽位快照。
        result_id: 平台保存结果的可选标识。

    返回:
        可直接序列化为 JSON 的诊断对象。函数不会修改任何输入。
    """
    normalized_moves = [deepcopy(dict(move)) for move in moves]
    diagnostics = list(decision.get("actionDiagnostics") or [])
    warnings: list[str] = []
    if not diagnostics:
        warnings.append("算法未返回候选动作明细；本文件仍可用于复现当前 Machine 输入。")
    if playback_snapshot is None:
        warnings.append("请求未携带浏览器拓扑快照；模块与机器手占位请以 UpdateParams 和 MoveList 为准。")

    return {
        "schema": "deadlock-diagnostic-bundle",
        "schemaVersion": DEADLOCK_DIAGNOSTIC_SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "resultId": result_id,
        "replay": {
            "time": float(replay_time),
            "recomputeRound": max(1, int(recompute_round)),
            "strategy": str(plan.get("strategy") or ""),
            "moveStates": deepcopy(list(move_states)),
        },
        "currentState": {
            "playbackSnapshot": deepcopy(dict(playback_snapshot))
            if isinstance(playback_snapshot, Mapping)
            else None,
            "materials": _material_progress(update_params, normalized_moves, replay_time),
        },
        "candidateActions": {
            "provider": str(decision.get("actionDiagnosticsProvider") or ""),
            "source": str(decision.get("actionDiagnosticsSource") or "unavailable"),
            "counts": deepcopy(dict(decision.get("actionCounts") or {})),
            "actions": [_diagnostic_action(action) for action in diagnostics],
        },
        "recentMoves": _recent_moves(normalized_moves, replay_time),
        "updateParams": deepcopy(dict(update_params)),
        "plan": deepcopy(dict(plan)),
        "moveList": normalized_moves,
        "warnings": warnings,
    }


def serialize_deadlock_diagnostic_bundle(
    bundle: Mapping[str, Any],
    *,
    replay_time: float,
    result_id: str = "",
) -> tuple[bytes, str]:
    """把诊断对象编码为可下载的 UTF-8 JSON，并生成稳定文件名。"""
    safe_result_id = re.sub(r"[^A-Za-z0-9_-]+", "-", result_id).strip("-")
    identity = safe_result_id or "local"
    timestamp_ms = max(0, round(float(replay_time) * 1000))
    download_name = f"deadlock-diagnostic-{identity}-{timestamp_ms}ms.json"
    text = json.dumps(bundle, ensure_ascii=False, allow_nan=False, indent=2)
    return text.encode("utf-8"), download_name


def _diagnostic_action(action: Any) -> Dict[str, Any]:
    """保留算法动作原文，并补充稳定的拦截类别和涉及资源索引。"""
    row = deepcopy(dict(action)) if isinstance(action, Mapping) else {}
    status = str(row.get("status") or "enabled")
    row["blocker"] = None if status == "enabled" else {
        "category": status,
        "rule": str(row.get("reason") or "算法未提供具体规则"),
        "materials": [str(value) for value in row.get("materialIds") or []],
        "robot": str(row.get("robot") or row.get("actor") or ""),
        "source": str(row.get("source") or ""),
        "sourceSlot": int(row.get("sourceSlot") or 0),
        "destination": str(row.get("destination") or ""),
        "destinationSlot": int(row.get("destinationSlot") or 0),
    }
    return row


def _recent_moves(
    moves: Sequence[Mapping[str, Any]],
    replay_time: float,
) -> list[Dict[str, Any]]:
    """返回目标时刻之前最近二十条已开始动作，并标记运行态。"""
    visible: list[Dict[str, Any]] = []
    for move in moves:
        start_time = _finite_number(move.get("StartTime"), math.inf)
        if start_time > replay_time + TIME_TOLERANCE_SECONDS:
            continue
        row = deepcopy(dict(move))
        end_time = _finite_number(move.get("EndTime"), start_time)
        row["DiagnosticMoveState"] = (
            "Done" if end_time <= replay_time + TIME_TOLERANCE_SECONDS else "Running"
        )
        visible.append(row)
    visible.sort(
        key=lambda move: (
            _finite_number(move.get("StartTime"), 0.0),
            _finite_number(move.get("EndTime"), 0.0),
            _finite_number(move.get("MoveID"), 0.0),
        ),
        reverse=True,
    )
    return visible[:RECENT_MOVE_LIMIT]


def _material_progress(
    update_params: Mapping[str, Any],
    moves: Sequence[Mapping[str, Any]],
    replay_time: float,
) -> list[Dict[str, Any]]:
    """索引每片晶圆的原始 StepID、Route 位置和最近动作，不推测算法规则。"""
    recent_by_material: dict[str, Mapping[str, Any]] = {}
    for move in moves:
        if _finite_number(move.get("EndTime"), math.inf) > replay_time + TIME_TOLERANCE_SECONDS:
            continue
        material_ids = _value_list(move.get("MatIDList"))
        for material_id in material_ids:
            key = str(material_id)
            previous = recent_by_material.get(key)
            if previous is None or _finite_number(move.get("EndTime"), 0.0) >= _finite_number(
                previous.get("EndTime"), 0.0
            ):
                recent_by_material[key] = move

    result: list[Dict[str, Any]] = []
    for raw_material in update_params.get("Materials") or []:
        if not isinstance(raw_material, Mapping):
            continue
        material = deepcopy(dict(raw_material))
        material_id = str(material.get("ID") or "")
        route = material.get("Route") if isinstance(material.get("Route"), Mapping) else {}
        route_steps = [
            step for step in route.get("RouteSteps") or [] if isinstance(step, Mapping)
        ]
        latest_move = recent_by_material.get(material_id)
        update_step_id = material.get("StepID")
        inferred_step_id, inferred_module = _move_material_progress(
            latest_move,
            material_id,
        )
        raw_step_id = inferred_step_id if inferred_step_id is not None else update_step_id
        stage_index = next(
            (
                index
                for index, step in enumerate(route_steps)
                if str(step.get("StepID")) == str(raw_step_id)
            ),
            -1,
        )
        result.append({
            "materialId": material_id,
            "taskId": str(material.get("TaskID") or ""),
            "currentModule": inferred_module or str(material.get("CurrentModuleName") or ""),
            "updateStepId": update_step_id,
            "rawStepId": raw_step_id,
            "internalStageIndex": stage_index,
            "internalStageNumber": stage_index + 1 if stage_index >= 0 else None,
            "routeStepCount": len(route_steps),
            "routeSteps": [
                {
                    "index": index,
                    "stepId": step.get("StepID"),
                    "stations": [
                        str(visit.get("StationName") or "")
                        for visit in step.get("Visits") or []
                        if isinstance(visit, Mapping)
                    ],
                }
                for index, step in enumerate(route_steps)
            ],
            "latestCompletedMove": deepcopy(dict(latest_move)) if latest_move else None,
        })
    return result


def _move_material_progress(
    move: Mapping[str, Any] | None,
    material_id: str,
) -> tuple[Any, str]:
    """从晶圆最近完成动作的对齐数组读取当前 StepID 与物理位置。"""
    if not isinstance(move, Mapping):
        return None, ""
    move_type = int(_finite_number(move.get("MoveType"), -1))
    if move_type == 4:
        recv_index = _material_index(move.get("RecvMatList"), material_id)
        if recv_index >= 0:
            return (
                _aligned_value(move.get("RecvMatStepIDList"), recv_index),
                str(move.get("ModuleName") or ""),
            )
        send_index = _material_index(move.get("SendMatList"), material_id)
        if send_index >= 0:
            return (
                _aligned_value(move.get("SendMatStepIDList"), send_index),
                str(_aligned_value(move.get("StationList"), send_index) or ""),
            )
        return None, ""

    material_index = _material_index(move.get("MatIDList"), material_id)
    step_id = _aligned_value(move.get("StepIDList"), material_index)
    if move_type in {0, 2}:
        return step_id, str(move.get("ModuleName") or "")
    if move_type in {1, 3}:
        destination = _aligned_value(move.get("DestStationList"), material_index)
        return step_id, str(destination or "")
    return step_id, str(move.get("ModuleName") or "")


def _material_index(value: Any, material_id: str) -> int:
    """返回并行数组中指定晶圆的位置，找不到时返回负一。"""
    return next(
        (index for index, item in enumerate(_value_list(value)) if str(item) == material_id),
        -1,
    )


def _aligned_value(value: Any, index: int) -> Any:
    """按晶圆索引读取 Move 并行数组，缺项时返回空值。"""
    values = _value_list(value)
    return values[index] if 0 <= index < len(values) else None


def _value_list(value: Any) -> list[Any]:
    """把标量或序列统一为列表，字符串视为单个值。"""
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return list(value)
    return [] if value is None else [value]


def _finite_number(value: Any, default: float) -> float:
    """读取有限浮点数，非法输入回退到调用方默认值。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


__all__ = (
    "build_deadlock_diagnostic_bundle",
    "serialize_deadlock_diagnostic_bundle",
)
