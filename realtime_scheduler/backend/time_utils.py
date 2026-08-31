"""后端持久化与运行状态共用的时间工具。

本模块不依赖工作区、执行器或 HTTP 层，避免这些模块为了生成时间戳形成循环导入。
"""

from __future__ import annotations

from datetime import datetime


def _workspace_timestamp() -> str:
    """生成工作区记录和运行状态使用的本地秒级 ISO 时间。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


__all__ = ("_workspace_timestamp",)
