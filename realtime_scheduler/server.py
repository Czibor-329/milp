"""CT 调度平台兼容启动入口；实际实现位于 ``realtime_scheduler.backend``。

历史测试、脚本和第三方维护工具会临时替换本模块中的路径、算法入口或存储函数。
兼容模块把这类赋值同步到真实后端模块，使迁移期间仍可使用旧入口；新代码应直接
导入对应的 ``backend`` 模块。
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType

# 兼容 ``python realtime_scheduler/server.py``：脚本模式只会把包目录加入 sys.path。
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from realtime_scheduler.backend.application import *  # noqa: F401,F403
from realtime_scheduler.backend.application import __dict__ as _backend_namespace
from realtime_scheduler.backend import bootstrap as _bootstrap
from realtime_scheduler.backend.algorithms import interface as _algorithm_interface
from realtime_scheduler.backend.api import http as _http
from realtime_scheduler.backend.artifacts import repository as _artifacts
from realtime_scheduler.backend.execution import algorithm_runtime as _algorithm_runtime
from realtime_scheduler.backend.execution import batch_service as _batch_service
from realtime_scheduler.backend.execution import cjob_cycle as _cjob_cycle
from realtime_scheduler.backend.execution import run_state as _run_state
from realtime_scheduler.backend.execution import service as _execution_service
from realtime_scheduler.backend import wiring as _wiring
from realtime_scheduler.backend.workspace import repository as _workspace_repository
from realtime_scheduler.backend.workspace import service as _workspace_service

# 兼容历史脚本与测试访问的私有协作符号；新代码应导入所属 backend 模块。
for _name, _value in _backend_namespace.items():
    if _name.startswith('_') and not _name.startswith('__'):
        globals()[_name] = _value


_COMPATIBILITY_MODULES = (
    _bootstrap,
    _algorithm_interface,
    _run_state,
    _algorithm_runtime,
    _cjob_cycle,
    _execution_service,
    _workspace_repository,
    _workspace_service,
    _artifacts,
    _wiring,
    _http,
)
_BATCH_DEPENDENCY_NAMES = frozenset({
    "execute_plan",
    "get_workspace_device",
    "save_result",
    "save_reproduction_log",
    "_persist_workspace_baseline",
    "_workspace_catalog_guard",
    "_read_workspace_catalog_unlocked",
    "_write_workspace_catalog_unlocked",
    "_workspace_timestamp",
    "_segment_end",
    "apply_robot_slot_selection",
})


class _ServerCompatibilityModule(ModuleType):
    """把旧门面的运行时替换同步到真实后端实现。"""

    def __setattr__(self, name, value):
        """同步测试桩和临时配置，同时刷新批量服务的显式依赖。"""
        super().__setattr__(name, value)
        for backend_module in _COMPATIBILITY_MODULES:
            if name in vars(backend_module):
                setattr(backend_module, name, value)
        if name in _BATCH_DEPENDENCY_NAMES:
            _batch_service.configure_batch_service(
                _wiring.build_batch_service_dependencies()
            )


sys.modules[__name__].__class__ = _ServerCompatibilityModule

if __name__ == '__main__':
    main()
