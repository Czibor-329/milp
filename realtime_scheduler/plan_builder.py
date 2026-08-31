"""兼容入口：计划构建器已迁移至 ``realtime_scheduler.backend.execution``。"""

from realtime_scheduler.backend.execution.plan_builder import *  # noqa: F401,F403
from realtime_scheduler.backend.execution.plan_builder import __dict__ as _backend_namespace

for _name, _value in _backend_namespace.items():
    if _name.startswith("_") and not _name.startswith("__"):
        globals()[_name] = _value
