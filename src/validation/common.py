"""Small helpers shared by PreMoveID population and activation checking."""

import math
from typing import List, Optional, Set, Tuple


PICK_MOVE = 0
PLACE_MOVE = 1
SWAP_MOVE = 4
PRE_TRANS_MOVE = 5
PREPARE_MOVE = 6
COMPLETE_MOVE = 7
PROCESS_MOVE = 9
PRE_PREPARE_MOVE = 10

STATION_TYPES = {
    PREPARE_MOVE,
    COMPLETE_MOVE,
    PROCESS_MOVE,
    PRE_PREPARE_MOVE,
}

MIN_SLOT_ID = 1
SORT_FALLBACK_TIME = 0.0
SORT_FALLBACK_MOVE_ID = 0


def as_list(move: dict, key: str) -> list:
    value = move.get(key)
    return value if isinstance(value, list) else []


def first(move: dict, key: str) -> Optional[object]:
    values = as_list(move, key)
    return values[0] if values else None


def num(value: object) -> Optional[float]:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def mat_key(move: dict) -> Tuple[object, ...]:
    return tuple(as_list(move, "MatIDList"))


def slot_values(move: dict, key: str = "SlotList") -> Tuple[int, ...]:
    return tuple(value for value in as_list(move, key) if isinstance(value, int) and value >= MIN_SLOT_ID)


def station_name(move: dict) -> str:
    return str(move.get("Station") or move.get("ModuleName") or "")


def station_slot_refs(move: dict) -> Set[Tuple[str, int]]:
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
        refs.update((station, slot) for station in stations for slot in recv_slots + send_slots)
    return refs


def source_ref(move: dict) -> Optional[Tuple[str, int]]:
    station = first(move, "SrcStationList")
    slot = first(move, "SrcSlotList")
    return (str(station), int(slot)) if isinstance(slot, int) and station else None


def dest_ref(move: dict) -> Optional[Tuple[str, int]]:
    station = first(move, "DestStationList")
    slot = first(move, "DestSlotList")
    return (str(station), int(slot)) if isinstance(slot, int) and station else None


def station_ref(move: dict) -> Optional[Tuple[str, int]]:
    station = station_name(move)
    slot = first(move, "SlotList")
    return (station, int(slot)) if isinstance(slot, int) and station else None


def same_mat(left_move: dict, right_move: dict) -> bool:
    left_material = mat_key(left_move)
    right_material = mat_key(right_move)
    return bool(left_material and right_material and left_material == right_material)


def sort_key(move: dict) -> Tuple[float, float, int]:
    start_time = num(move.get("StartTime"))
    end_time = num(move.get("EndTime"))
    move_id = move.get("MoveID")
    return (
        start_time if start_time is not None else SORT_FALLBACK_TIME,
        end_time if end_time is not None else SORT_FALLBACK_TIME,
        move_id if isinstance(move_id, int) else SORT_FALLBACK_MOVE_ID,
    )


def latest(candidates: List[dict], current_move: dict, tolerance: float) -> Optional[dict]:
    ready_moves = [
        move
        for move in candidates
        if float(move["EndTime"]) <= float(current_move["StartTime"]) + tolerance
    ]
    return max(ready_moves, key=lambda move: (float(move["EndTime"]), int(move["MoveID"]))) if ready_moves else None
