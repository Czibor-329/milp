"""MoveList 校验共享常量和字段解析工具。

本文件集中定义 validation 包内复用的 MoveType 集合、PreMoveID 类型约束，
以及从 MoveList 记录中提取站点、槽位、晶圆和排序键的轻量 helper。
这些函数不负责产生校验错误，只提供可复用的结构化读取逻辑。
"""

import math
from typing import Dict, List, Optional, Set, Tuple


# MoveType values come from docs/interface_doc.txt, SHEET: Move类, MoveType(Enum).
PICK_MOVE = 0
PLACE_MOVE = 1
MULTI_PICK_MOVE = 2
MULTI_PLACE_MOVE = 3
SWAP_MOVE = 4
PRE_TRANS_MOVE = 5
PREPARE_MOVE = 6
COMPLETE_MOVE = 7
POST_COMPLETE_MOVE = 8
PROCESS_MOVE = 9
PRE_PREPARE_MOVE = 10
ALIGN_MOVE = 11

DEFAULT_FLOAT_TOLERANCE = 1e-4
MIN_SLOT_ID = 1
SORT_FALLBACK_TIME = 0.0
SORT_FALLBACK_MOVE_ID = 0

MOVE_TYPES = {
    PICK_MOVE,
    PLACE_MOVE,
    SWAP_MOVE,
    PRE_TRANS_MOVE,
    PREPARE_MOVE,
    COMPLETE_MOVE,
    PROCESS_MOVE,
    PRE_PREPARE_MOVE,
}
STATION_TYPES = {
    PREPARE_MOVE,
    COMPLETE_MOVE,
    PROCESS_MOVE,
    PRE_PREPARE_MOVE,
}
ALLOWED_PRE_TYPES: Dict[int, Set[int]] = {
    PICK_MOVE: {PRE_TRANS_MOVE, PREPARE_MOVE, PRE_PREPARE_MOVE},
    PLACE_MOVE: {PRE_TRANS_MOVE, PREPARE_MOVE, PRE_PREPARE_MOVE},
    PRE_TRANS_MOVE: {PICK_MOVE, PLACE_MOVE},
    PREPARE_MOVE: {PICK_MOVE, PLACE_MOVE, COMPLETE_MOVE, PROCESS_MOVE, PRE_PREPARE_MOVE},
    COMPLETE_MOVE: {PICK_MOVE, PLACE_MOVE, PREPARE_MOVE, PRE_PREPARE_MOVE},
    PROCESS_MOVE: {COMPLETE_MOVE},
    PRE_PREPARE_MOVE: {PICK_MOVE, PLACE_MOVE, COMPLETE_MOVE, PRE_PREPARE_MOVE},
}


def as_list(move: dict, key: str) -> list:
    """读取 MoveList 字段，并在字段不是列表时返回空列表。"""
    value = move.get(key)
    return value if isinstance(value, list) else []


def first(move: dict, key: str) -> Optional[object]:
    """返回列表字段的第一个元素，字段缺失或非列表时返回 None。"""
    values = as_list(move, key)
    return values[0] if values else None


def num(value: object) -> Optional[float]:
    """将有限数字转换为 float，非数字或非有限值返回 None。"""
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def duration(move: dict) -> Optional[float]:
    """计算 move 的 EndTime 与 StartTime 差值，时间非法时返回 None。"""
    start_time = num(move.get("StartTime"))
    end_time = num(move.get("EndTime"))
    return None if start_time is None or end_time is None else end_time - start_time


def close(left_value: float, right_value: float, tolerance: float = DEFAULT_FLOAT_TOLERANCE) -> bool:
    """判断两个浮点值是否在给定容差内相等。"""
    return abs(left_value - right_value) <= tolerance


def mat_key(move: dict) -> Tuple[object, ...]:
    """返回用于比较晶圆身份的 MatIDList 元组。"""
    return tuple(as_list(move, "MatIDList"))


def pjob_key(move: dict) -> Tuple[object, ...]:
    """返回用于比较工艺作业身份的 PJobName 元组。"""
    return tuple(as_list(move, "PJobName"))


def slot_values(move: dict, key: str = "SlotList") -> Tuple[int, ...]:
    """读取槽位字段中的正整数值，并保持原始顺序。"""
    return tuple(value for value in as_list(move, key) if isinstance(value, int) and value >= MIN_SLOT_ID)


def station_name(move: dict) -> str:
    """返回 move 关联的站点名称，优先使用 Station，其次 ModuleName。"""
    return str(move.get("Station") or move.get("ModuleName") or "")


def station_slot_refs(move: dict) -> Set[Tuple[str, int]]:
    """提取 move 直接引用的站点槽位集合。"""
    move_type = move.get("MoveType")
    refs: Set[Tuple[str, int]] = set()
    if move_type in STATION_TYPES:
        station = station_name(move)
        refs.update((station, slot) for slot in slot_values(move) if station)
    if move_type in (PICK_MOVE, PRE_TRANS_MOVE):
        refs.update(
            (str(station), slot)
            for station in as_list(move, "SrcStationList")
            for slot in slot_values(move, "SrcSlotList")
        )
    if move_type in (PLACE_MOVE, PRE_TRANS_MOVE):
        refs.update(
            (str(station), slot)
            for station in as_list(move, "DestStationList")
            for slot in slot_values(move, "DestSlotList")
        )
    if move_type == SWAP_MOVE:
        stations = [str(station) for station in as_list(move, "StationList") if station]
        recv_slots = slot_values(move, "StnRecvSlotList")
        send_slots = slot_values(move, "StnSendSlotList")
        if stations:
            refs.update((station, slot) for station in stations for slot in recv_slots + send_slots)
    return refs


def station_names(move: dict) -> Set[str]:
    """提取 move 直接引用的站点名称集合。"""
    move_type = move.get("MoveType")
    names: Set[str] = set()
    if move_type in STATION_TYPES and station_name(move):
        names.add(station_name(move))
    if move_type in (PICK_MOVE, PRE_TRANS_MOVE):
        names.update(str(station) for station in as_list(move, "SrcStationList") if station)
    if move_type in (PLACE_MOVE, PRE_TRANS_MOVE):
        names.update(str(station) for station in as_list(move, "DestStationList") if station)
    if move_type == SWAP_MOVE:
        names.update(str(station) for station in as_list(move, "StationList") if station)
    return names


def source_ref(move: dict) -> Optional[Tuple[str, int]]:
    """返回 move 的源站槽位引用，字段不完整时返回 None。"""
    station = first(move, "SrcStationList")
    slot = first(move, "SrcSlotList")
    return (str(station), int(slot)) if isinstance(slot, int) and station else None


def dest_ref(move: dict) -> Optional[Tuple[str, int]]:
    """返回 move 的目标站槽位引用，字段不完整时返回 None。"""
    station = first(move, "DestStationList")
    slot = first(move, "DestSlotList")
    return (str(station), int(slot)) if isinstance(slot, int) and station else None


def station_ref(move: dict) -> Optional[Tuple[str, int]]:
    """返回 station move 的站点槽位引用，字段不完整时返回 None。"""
    station = station_name(move)
    slot = first(move, "SlotList")
    return (station, int(slot)) if isinstance(slot, int) and station else None


def same_mat(left_move: dict, right_move: dict) -> bool:
    """判断两个 move 是否带有相同且非空的 MatIDList。"""
    left_material = mat_key(left_move)
    right_material = mat_key(right_move)
    return bool(left_material and right_material and left_material == right_material)


def same_pjob_if_present(left_move: dict, right_move: dict) -> bool:
    """在两个 move 都带有 PJobName 时判断其是否一致。"""
    left_job = pjob_key(left_move)
    right_job = pjob_key(right_move)
    return not (left_job and right_job) or left_job == right_job


def sort_key(move: dict) -> Tuple[float, float, int]:
    """返回按开始时间、结束时间、MoveID 排序的稳定键。"""
    start_time = num(move.get("StartTime"))
    end_time = num(move.get("EndTime"))
    move_id = move.get("MoveID")
    return (
        start_time if start_time is not None else SORT_FALLBACK_TIME,
        end_time if end_time is not None else SORT_FALLBACK_TIME,
        move_id if isinstance(move_id, int) else SORT_FALLBACK_MOVE_ID,
    )


def latest(candidates: List[dict], current_move: dict, tolerance: float) -> Optional[dict]:
    """从候选 move 中选择在 current_move 开始前结束的最后一个 move。"""
    ready_moves = [
        move
        for move in candidates
        if float(move["EndTime"]) <= float(current_move["StartTime"]) + tolerance
    ]
    return max(ready_moves, key=lambda move: (float(move["EndTime"]), int(move["MoveID"]))) if ready_moves else None
