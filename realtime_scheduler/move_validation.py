"""兼容入口：平台物理校验已迁移至 ``realtime_scheduler.backend.validation``。

旧路径继续导出完整符号集，确保第三方脚本和历史结果中的 ``stateSource`` 标识
保持稳定；新代码应从 ``backend.validation.move_validation`` 导入。
"""

from realtime_scheduler.backend.validation.move_validation import *  # noqa: F401,F403
from realtime_scheduler.backend.validation.move_validation import __dict__ as _backend_namespace
from realtime_scheduler.backend.validation import move_validation_core as _core_namespace
from realtime_scheduler.backend.validation import move_validation_helpers as _helper_namespace

for _name, _value in _backend_namespace.items():
    if _name.startswith("_") and not _name.startswith("__"):
        globals()[_name] = _value
for _source_namespace in (_core_namespace.__dict__, _helper_namespace.__dict__):
    for _name, _value in _source_namespace.items():
        if not _name.startswith("__"):
            globals().setdefault(_name, _value)

# 结果诊断会将该类路径写入 JSON；将兼容导出类保留在旧模块名下，避免无关的
# 数据格式变化。函数实现仍由 backend 模块持有。
for _class_name in ("MachineState", "MoveStateReplay", "DoorState", "SlotPhase", "ValidationErrorCode"):
    _class = globals().get(_class_name)
    if _class is not None:
        _class.__module__ = __name__
