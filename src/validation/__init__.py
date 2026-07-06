"""MoveList validation 包的公共入口。

本包对外暴露 MoveList 完整校验函数和 PreMoveID 自动补齐函数，
内部模块分别负责共享字段解析、时间轴状态推进、PreMoveID 图校验和 raw init data 拓扑校验。
"""

from src.validation.premove import populate_premove_ids
from src.validation.api import validate_move_list

__all__ = ["populate_premove_ids", "validate_move_list"]
