"""MoveList 状态校验的公开入口。

``validate_move_list`` 回放设备当前状态，不检查 ``PreMoveID``。
"""

from src.validation.replay import MoveStateReplay, validate_move_list

__all__ = ["MoveStateReplay", "validate_move_list"]
