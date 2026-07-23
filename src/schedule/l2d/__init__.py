"""PSE300 L2D 动态析取图调度策略。

Torch 是可选依赖。核心 MILP/timing 路径不会导入本包；只有实际访问 L2D 公开接口时才
加载网络实现，并在缺少 Torch 时给出明确的独立安装提示。
"""

from __future__ import annotations

from typing import Any


__all__ = ["load_l2d_policy", "start_schedule_l2d"]


def __getattr__(name: str) -> Any:
    """延迟加载 Torch 相关公开接口，保持核心求解器依赖不变。"""
    if name not in __all__:
        raise AttributeError(name)
    try:
        from .api import load_l2d_policy, start_schedule_l2d
    except ImportError as error:
        if error.name == "torch":
            raise ImportError(
                "L2D 需要可选依赖 PyTorch；请先执行 `pip install -r requirements-l2d.txt`"
            ) from error
        raise
    return {
        "load_l2d_policy": load_l2d_policy,
        "start_schedule_l2d": start_schedule_l2d,
    }[name]
