"""PreMoveID dependency inference and population."""

from typing import Dict, List, Optional, Set, Tuple

from src.validation.common import (
    as_list,
    dest_ref,
    latest,
    mat_key,
    same_mat,
    sort_key,
    source_ref,
    station_name,
    station_ref,
    station_slot_refs,
)


def required_premove_ids(moves: List[dict], tolerance: float = 1e-6) -> Dict[int, Set[int]]:
    """Infer the PreMoveID set each move should carry."""
    required_ids: Dict[int, Set[int]] = {
        int(move["MoveID"]): set()
        for move in moves
        if isinstance(move.get("MoveID"), int)
    }
    seen: List[dict] = []

    def add(current_move: dict, previous_move: Optional[dict]) -> None:
        if previous_move is not None and previous_move.get("MoveID") != current_move.get("MoveID"):
            required_ids.setdefault(int(current_move["MoveID"]), set()).add(int(previous_move["MoveID"]))

    def by_station_slot(
        station_slot: Optional[Tuple[str, int]],
        move_types: Set[int],
        material_move: Optional[dict] = None,
    ) -> List[dict]:
        if station_slot is None:
            return []
        candidates = []
        for previous_move in seen:
            if previous_move.get("MoveType") not in move_types or station_slot not in station_slot_refs(previous_move):
                continue
            if material_move is not None and mat_key(previous_move) and not same_mat(previous_move, material_move):
                continue
            candidates.append(previous_move)
        return candidates

    def by_robot(robot: str, move_types: Set[int], material_move: Optional[dict] = None) -> List[dict]:
        candidates = []
        for previous_move in seen:
            if previous_move.get("MoveType") not in move_types or previous_move.get("Robot") != robot:
                continue
            if material_move is not None and mat_key(previous_move) and not same_mat(previous_move, material_move):
                continue
            candidates.append(previous_move)
        return candidates

    def by_pressure(station: str) -> List[dict]:
        return [
            previous_move
            for previous_move in seen
            if previous_move.get("MoveType") == 10 and station_name(previous_move) == station
        ]

    for current_move in sorted(moves, key=sort_key):
        if not isinstance(current_move.get("MoveID"), int):
            seen.append(current_move)
            continue

        move_type = current_move.get("MoveType")
        if move_type == 0:
            source = source_ref(current_move)
            add(current_move, latest(by_station_slot(source, {6}, current_move), current_move, tolerance))
            add(
                current_move,
                latest(
                    [move for move in by_robot(str(current_move.get("Robot") or ""), {5}) if dest_ref(move) == source],
                    current_move,
                    tolerance,
                ),
            )
            if source:
                add(current_move, latest(by_pressure(source[0]), current_move, tolerance))
        elif move_type == 1:
            destination = dest_ref(current_move)
            add(current_move, latest(by_station_slot(destination, {6}, current_move), current_move, tolerance))
            add(
                current_move,
                latest(
                    [
                        move
                        for move in by_robot(str(current_move.get("Robot") or ""), {5}, current_move)
                        if dest_ref(move) == destination
                    ],
                    current_move,
                    tolerance,
                ),
            )
            if destination:
                add(current_move, latest(by_pressure(destination[0]), current_move, tolerance))
        elif move_type == 5:
            robot = str(current_move.get("Robot") or "")
            if mat_key(current_move):
                add(
                    current_move,
                    latest(
                        [
                            move
                            for move in by_robot(robot, {0}, current_move)
                            if source_ref(move) == source_ref(current_move)
                        ],
                        current_move,
                        tolerance,
                    ),
                )
            else:
                add(current_move, latest(by_robot(robot, {0, 1}), current_move, tolerance))
        elif move_type == 6:
            add(current_move, latest(by_station_slot(station_ref(current_move), {7, 9, 10}), current_move, tolerance))
        elif move_type == 7:
            station_slot = station_ref(current_move)
            add(current_move, latest(by_station_slot(station_slot, {0, 1}, current_move), current_move, tolerance))
            add(current_move, latest(by_station_slot(station_slot, {6}, current_move), current_move, tolerance))
        elif move_type == 9:
            material_move = current_move if mat_key(current_move) else None
            add(current_move, latest(by_station_slot(station_ref(current_move), {7}, material_move), current_move, tolerance))
        elif move_type == 10:
            station_slot = station_ref(current_move)
            if station_slot:
                add(current_move, latest(by_pressure(station_slot[0]), current_move, tolerance))
            material_move = current_move if mat_key(current_move) else None
            add(current_move, latest(by_station_slot(station_slot, {7, 0, 1}, material_move), current_move, tolerance))

        seen.append(current_move)

    return required_ids


def populate_premove_ids(moves: List[dict]) -> None:
    """Populate each move's PreMoveID field in place."""
    required_ids = required_premove_ids(moves)
    for move in moves:
        previous_ids = set(as_list(move, "PreMoveID"))
        if isinstance(move.get("MoveID"), int):
            previous_ids.update(required_ids.get(move["MoveID"], set()))
        move["PreMoveID"] = sorted(move_id for move_id in previous_ids if isinstance(move_id, int))
