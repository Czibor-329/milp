"""MoveList validation entry point."""

from typing import Any, List, Mapping, Optional

from src.model import Problem
from src.validation.timeline import validate_premove_activation_timeline


def validate_move_list(task: Problem, moves: List[dict], init_data: Optional[Mapping[str, Any]] = None) -> List[str]:
    """Check only whether each move's declared PreMoveID values are active."""
    return validate_premove_activation_timeline(task, moves, init_data)

