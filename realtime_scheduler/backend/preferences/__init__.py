"""本地用户偏好的读取与保存入口。"""

from .repository import read_run_preferences, update_run_preferences

__all__ = ["read_run_preferences", "update_run_preferences"]
