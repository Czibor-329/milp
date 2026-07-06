"""MoveList 总体验证入口。

本文件只保留对外入口 `validate_move_list`。完整校验逻辑由
`src.validation.timeline.validate_timeline` 统一编排：字段检查、时间轴状态推进、
init data 拓扑/时长检查、PreMoveID 图检查和 LoadLock 压力态检查都收敛到同一条
时间轴校验主流程下，避免入口层出现多套并列校验器。
"""

from typing import Any, List, Mapping, Optional

from src.model import Problem
from src.validation.timeline import validate_timeline


def validate_move_list(task: Problem, moves: List[dict], init_data: Optional[Mapping[str, Any]] = None) -> List[str]:
    """运行完整 MoveList 校验，并返回所有发现的问题描述。"""
    return validate_timeline(task, moves, init_data)

