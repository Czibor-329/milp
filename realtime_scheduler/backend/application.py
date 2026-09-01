"""后端应用公共门面与模块装配入口。

仓库脚本和集成测试可从本模块访问完整后端能力；对门面属性的临时替换会同步到
实际实现模块，便于注入测试依赖并保持批量 worker 的装配一致性。
"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.execution.run_state import *
from realtime_scheduler.backend.execution.algorithm_runtime import *
from realtime_scheduler.backend.execution.cjob_cycle import *
from realtime_scheduler.backend.execution.service import *
from realtime_scheduler.backend.workspace.repository import *
from realtime_scheduler.backend.workspace.catalog_service import *
from realtime_scheduler.backend.workspace.exchange_service import *
from realtime_scheduler.backend.workspace.transfer_jobs import *
from realtime_scheduler.backend.artifacts.repository import *
from realtime_scheduler.backend.preferences.repository import *
from realtime_scheduler.backend.wiring import *
from realtime_scheduler.backend.api.http import *
from realtime_scheduler.backend.main import main

__all__ = tuple(name for name in globals() if not name.startswith('__'))


# 应用门面是正式的依赖注入边界。运行时替换只同步已由目标模块拥有的名字，避免
# 聚合模块形成第二份实现状态。
import sys as _sys
from types import ModuleType as _ModuleType

from realtime_scheduler.backend import bootstrap as _bootstrap_module
from realtime_scheduler.backend.algorithms import interface as _algorithm_interface_module
from realtime_scheduler.backend.api import http as _http_module
from realtime_scheduler.backend.artifacts import repository as _artifacts_module
from realtime_scheduler.backend.preferences import repository as _preferences_module
from realtime_scheduler.backend.execution import algorithm_runtime as _algorithm_runtime_module
from realtime_scheduler.backend.execution import batch_service as _batch_service_module
from realtime_scheduler.backend.execution import cjob_cycle as _cjob_cycle_module
from realtime_scheduler.backend.execution import run_state as _run_state_module
from realtime_scheduler.backend.execution import service as _execution_service_module
from realtime_scheduler.backend import wiring as _wiring_module
from realtime_scheduler.backend.workspace import repository as _workspace_repository_module
from realtime_scheduler.backend.workspace import catalog_service as _workspace_catalog_service_module
from realtime_scheduler.backend.workspace import exchange_service as _workspace_exchange_module
from realtime_scheduler.backend.workspace import transfer_jobs as _workspace_transfer_jobs_module


_APPLICATION_MODULES = (
    _bootstrap_module,
    _algorithm_interface_module,
    _run_state_module,
    _algorithm_runtime_module,
    _cjob_cycle_module,
    _execution_service_module,
    _workspace_repository_module,
    _workspace_catalog_service_module,
    _workspace_exchange_module,
    _workspace_transfer_jobs_module,
    _artifacts_module,
    _preferences_module,
    _wiring_module,
    _http_module,
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


class _ApplicationModule(_ModuleType):
    """把门面上的依赖替换同步到实现模块。"""

    def __setattr__(self, name, value):
        """同步测试桩和临时配置，并在必要时刷新批量服务依赖。"""
        super().__setattr__(name, value)
        for backend_module in _APPLICATION_MODULES:
            if name in vars(backend_module):
                setattr(backend_module, name, value)
        if name in _BATCH_DEPENDENCY_NAMES:
            _batch_service_module.configure_batch_service(
                _wiring_module.build_batch_service_dependencies()
            )


_sys.modules[__name__].__class__ = _ApplicationModule
