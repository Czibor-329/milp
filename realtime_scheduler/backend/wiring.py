"""后端应用服务装配边界。

本模块负责把批量执行所需的函数、状态容器和持久化能力显式组装起来。执行层不再
反向导入 ``server``，多进程 worker 也通过本装配边界恢复依赖。
"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import (
    API_SCHEMA_VERSION,
    HEURISTIC_BASELINE_SCHEMA_VERSION,
    MAX_SAVED_BATCH_RUNS,
    _BATCH_CANCEL_EVENTS,
    _BATCH_RUNS,
    _BATCH_RUNS_LOCK,
)
from realtime_scheduler.backend.execution import batch_service as _batch_service
from realtime_scheduler.backend.execution.run_state import LoggedPlanError, _segment_end
from realtime_scheduler.backend.execution.service import execute_plan
from realtime_scheduler.backend.workspace.repository import (
    _read_workspace_catalog_unlocked,
    _workspace_catalog_guard,
    _write_workspace_catalog_unlocked,
)
from realtime_scheduler.backend.time_utils import _workspace_timestamp
from realtime_scheduler.backend.workspace.service import (
    apply_robot_slot_selection,
    get_workspace_device,
)
from realtime_scheduler.backend.artifacts.repository import (
    _persist_workspace_baseline,
    save_reproduction_log,
    save_result,
)


def build_batch_service_dependencies() -> _batch_service.BatchServiceDependencies:
    """构造批量服务所需的显式、可重建依赖集合。"""
    return _batch_service.BatchServiceDependencies(
        execute_plan=execute_plan,
        get_workspace_device=get_workspace_device,
        save_result=save_result,
        save_reproduction_log=save_reproduction_log,
        persist_workspace_baseline=_persist_workspace_baseline,
        workspace_catalog_guard=_workspace_catalog_guard,
        read_workspace_catalog_unlocked=_read_workspace_catalog_unlocked,
        write_workspace_catalog_unlocked=_write_workspace_catalog_unlocked,
        workspace_timestamp=_workspace_timestamp,
        segment_end=_segment_end,
        apply_robot_slot_selection=apply_robot_slot_selection,
        logged_plan_error=LoggedPlanError,
        api_schema_version=API_SCHEMA_VERSION,
        heuristic_baseline_schema_version=HEURISTIC_BASELINE_SCHEMA_VERSION,
        maximum_saved_batch_runs=MAX_SAVED_BATCH_RUNS,
        batch_runs=_BATCH_RUNS,
        batch_runs_lock=_BATCH_RUNS_LOCK,
        batch_cancel_events=_BATCH_CANCEL_EVENTS,
    )


def configure_batch_service() -> None:
    """为当前进程绑定批量服务依赖，供主进程和 worker 共用。"""
    _batch_service.configure_batch_service(build_batch_service_dependencies())


configure_batch_service()

_log_response_fields = _batch_service._log_response_fields
_logged_failure_result_fields = _batch_service._logged_failure_result_fields
_batch_test_routes = _batch_service._batch_test_routes
_batch_test_cleans = _batch_service._batch_test_cleans
_batch_test_recipes = _batch_service._batch_test_recipes
build_workspace_batch_plan = _batch_service.build_workspace_batch_plan
_workspace_baseline_fingerprint = _batch_service._workspace_baseline_fingerprint
_invalidate_stale_device_baselines = _batch_service._invalidate_stale_device_baselines
_successful_baseline = _batch_service._successful_baseline
_failed_baseline = _batch_service._failed_baseline
_baseline_comparison = _batch_service._baseline_comparison
_robot_wafer_dwell_time = _batch_service._robot_wafer_dwell_time
_execute_workspace_test_with_baseline = _batch_service._execute_workspace_test_with_baseline
_workspace_group_tests = _batch_service._workspace_group_tests
_execute_workspace_test_batch = _batch_service._execute_workspace_test_batch
run_workspace_test_batch = _batch_service.run_workspace_test_batch
read_workspace_batch_run = _batch_service.read_workspace_batch_run
cancel_workspace_batch_run = _batch_service.cancel_workspace_batch_run
start_workspace_test_batch = _batch_service.start_workspace_test_batch

__all__ = tuple(name for name in globals() if not name.startswith("__"))
