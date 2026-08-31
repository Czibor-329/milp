"""兼容入口：批量执行实现已迁移至 ``realtime_scheduler.backend.execution``。"""

from realtime_scheduler.backend.execution.batch_service import *  # noqa: F401,F403
from realtime_scheduler.backend.execution.batch_service import (
    __dict__ as _backend_namespace,
)

# 旧测试和脚本仍访问若干以下划线开头的协作函数；显式保留这些名字，避免
# 使用 ``import *`` 的 Python 规则丢弃兼容符号。
for _name, _value in _backend_namespace.items():
    if _name.startswith("_") and not _name.startswith("__"):
        globals()[_name] = _value
