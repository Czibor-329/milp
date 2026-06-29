"""推理适配器：用训练好的 GNN 模型对外暴露标准算法模块入口。"""

from importlib import import_module
from typing import Any


__all__ = ["init", "update"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        scheduler = import_module(".scheduler", __name__)
        return getattr(scheduler, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
