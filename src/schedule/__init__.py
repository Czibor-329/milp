"""调度策略层。

本包集中四种生产策略：启发式、RL 搜索、L2D 图策略和 MILP。策略负责产生资源顺序
或直接求解，固定顺序的精确定时统一交给 ``src.timing``。
"""

from typing import Any

from .api import start_schedule
from .milp import solve_milp
from .realtime import RealtimeRescheduler
from .rl import start_schedule_by_rl

__all__ = [
    "RealtimeRescheduler",
    "solve_milp",
    "start_schedule",
    "start_schedule_by_rl",
    "start_schedule_l2d",
    "load_l2d_policy",
]


def __getattr__(name: str) -> Any:
    """按需暴露需要 PyTorch 的 L2D 策略入口。"""
    if name not in {"load_l2d_policy", "start_schedule_l2d"}:
        raise AttributeError(name)
    from .l2d import load_l2d_policy, start_schedule_l2d

    return {
        "load_l2d_policy": load_l2d_policy,
        "start_schedule_l2d": start_schedule_l2d,
    }[name]
