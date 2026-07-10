"""MoveList 状态校验和导出依赖补全的公开入口。

``validate_move_list`` 回放设备当前状态，不检查 ``PreMoveID``；
``populate_premove_ids`` 仅为导出流程补充显示和存储所需的依赖字段。
"""

from src.validation.move_dependencies import populate_premove_ids
from src.validation.replay import validate_move_list

__all__ = ["populate_premove_ids", "validate_move_list"]
