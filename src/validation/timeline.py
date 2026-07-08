"""Timeline check for declared PreMoveID activation only."""

from typing import Any, List, Mapping, Optional, Set, Tuple

from src.model import Problem
from src.validation.common import num, sort_key


TIMELINE_TOLERANCE = 1e-6


def validate_premove_activation_timeline(
    task: Problem,
    moves: List[dict],
    init_data: Optional[Mapping[str, Any]] = None,
) -> List[str]:
    """Check that every declared PreMoveID is active before its move starts.

    A move becomes active when its EndTime is not later than the StartTime of
    the move currently being checked. Other validation types are intentionally
    not run here.
    """
    del task, init_data

    issues: List[str] = []
    active_move_ids: Set[int] = set()
    pending_moves: List[dict] = []

    for move in sorted(moves, key=sort_key):
        start_time = _time(move, "StartTime")
        if start_time is not None:
            _activate_finished_move_ids(pending_moves, active_move_ids, start_time)

        current_id = move.get("MoveID")
        previous_ids = move.get("PreMoveID", [])
        if not isinstance(previous_ids, list):
            issues.append(f"ML PreMoveID field violation id={current_id}: PreMoveID must be a list of ints")
            previous_ids = []

        for previous_id in previous_ids:
            if not isinstance(previous_id, int):
                issues.append(f"ML PreMoveID field violation id={current_id}: PreMoveID must be a list of ints")
                continue
            if previous_id not in active_move_ids:
                issues.append(f"ML PreMoveID not active id={previous_id}->{current_id}")

        if isinstance(current_id, int) and _time(move, "EndTime") is not None:
            pending_moves.append(move)

    return issues


def _activate_finished_move_ids(pending_moves: List[dict], active_move_ids: Set[int], timestamp: float) -> None:
    ready = [
        move
        for move in pending_moves
        if _time(move, "EndTime") is not None
        and _time(move, "EndTime") <= timestamp + TIMELINE_TOLERANCE
    ]
    if not ready:
        return

    for move in sorted(ready, key=_end_then_id_key):
        move_id = move.get("MoveID")
        if isinstance(move_id, int):
            active_move_ids.add(move_id)

    ready_objects = {id(move) for move in ready}
    pending_moves[:] = [move for move in pending_moves if id(move) not in ready_objects]


def _time(move: Mapping[str, Any], key: str) -> Optional[float]:
    return num(move.get(key))


def _end_then_id_key(move: Mapping[str, Any]) -> Tuple[float, int]:
    end_time = _time(move, "EndTime")
    move_id = move.get("MoveID")
    return (
        end_time if end_time is not None else 0.0,
        move_id if isinstance(move_id, int) else 0,
    )
