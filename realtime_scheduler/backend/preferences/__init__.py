"""本地运行与结果分析偏好的读取和保存入口。"""

from .repository import (
    read_analysis_preferences,
    read_run_preferences,
    update_analysis_preferences,
    update_run_preferences,
)

__all__ = [
    "read_analysis_preferences",
    "read_run_preferences",
    "update_analysis_preferences",
    "update_run_preferences",
]
