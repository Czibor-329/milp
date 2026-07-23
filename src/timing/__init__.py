"""固定资源顺序的定时层。

本包不选择调度策略，只负责构造差分约束图并计算最早可行时刻。资源顺序由
``src.schedule`` 中的启发式、RL 或 L2D 策略产生；MILP 也复用统一结果结构。
"""

from .graph import _Nodes, _bellman_ford_longest
from .solve import SolveResult, _fill_schedule, solve_timing
from .spans import (
    _hop_span,
    _ll_proc,
    _ll_reuse_setup,
    _robot_switch_gap,
    _stage_dwell,
)

__all__ = [
    "SolveResult",
    "_Nodes",
    "_bellman_ford_longest",
    "_fill_schedule",
    "_hop_span",
    "_ll_proc",
    "_ll_reuse_setup",
    "_robot_switch_gap",
    "_stage_dwell",
    "solve_timing",
]
