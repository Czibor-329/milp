"""CT 实时调度终端本地服务。

页面只负责编辑设备引用、设备级共享 Clean/Route 和各轮新增 Job；本服务把请求展开成
标准调度接口数据，依次运行首次排程与实时重算，并通过 backend.analysis 提供统一的
MoveList 性能分析 API。设备、共享工艺库、测试集、甘特图结果和复现日志统一保存在
realtime_scheduler 目录中。批处理、Baseline 与并发运行状态由 batch_service 模块负责，
本模块保留 HTTP 边界与兼容入口。

用法：
    python realtime_scheduler/server.py
    python realtime_scheduler/server.py --port 8765 --open

兼容入口：python scripts/config_editor_server.py
"""

from __future__ import annotations

import argparse
import base64
import hashlib
from io import BytesIO
import json
import math
import os
import re
import shutil
import sys
import threading
import time
import uuid
import webbrowser
from zipfile import ZIP_DEFLATED, ZipFile
from collections import OrderedDict
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
# 直接执行 ``python realtime_scheduler/server.py`` 时，脚本目录会排在仓库根目录
# 之前；若环境中恰好安装过旧版同名包，就可能读取到过期模块。始终把当前仓库
# 放到首位，确保服务端、Markdown 文档加载器与本次检出的源码保持一致。
if str(ROOT) in sys.path:
    sys.path.remove(str(ROOT))
sys.path.insert(0, str(ROOT))

# 算法实现位于独立仓库。开发环境默认放在父仓库的 alg/，部署时可通过
# CT_ALGORITHM_ROOT 指向任意独立检出的算法仓库。算法仓库是可选依赖：
# 交付环境可以只部署 other_alg 下的标准算法包。
ALGORITHM_ROOT = Path(
    os.environ.get("CT_ALGORITHM_ROOT", str(ROOT / "alg"))
).expanduser().resolve()
ALGORITHM_REPOSITORY_PRESENT = (
    (ALGORITHM_ROOT / "src" / "api.py").is_file()
    and (ALGORITHM_ROOT / "src").is_dir()
)
if ALGORITHM_REPOSITORY_PRESENT:
    # 保留平台根目录的最高优先级，但算法仓库必须早于当前工作
    # 目录及第三方路径，避免 other_alg 交付包中的同名 src 被选中。
    algorithm_root_text = str(ALGORITHM_ROOT)
    while algorithm_root_text in sys.path:
        sys.path.remove(algorithm_root_text)
    sys.path.insert(1, algorithm_root_text)

    # 外部算法可能在服务端之前已导入自己的 src 包。Python 会优先
    # 复用 sys.modules，仅调整 sys.path 无法纠正这种污染；启动内置算法前
    # 清理非当前算法仓库的 src 命名空间，使 src.api 始终绑定到配置根。
    loaded_src = sys.modules.get("src")
    loaded_src_file = getattr(loaded_src, "__file__", None)
    loaded_src_is_builtin = False
    if loaded_src_file:
        try:
            Path(str(loaded_src_file)).resolve().relative_to(
                (ALGORITHM_ROOT / "src").resolve()
            )
        except (OSError, ValueError):
            pass
        else:
            loaded_src_is_builtin = True
    if loaded_src is not None and not loaded_src_is_builtin:
        for module_name in tuple(sys.modules):
            if module_name == "src" or module_name.startswith("src."):
                sys.modules.pop(module_name, None)

BUILTIN_ALGORITHM_IMPORT_ERROR = ""
BUILTIN_ALGORITHM_AVAILABLE = False
if ALGORITHM_REPOSITORY_PRESENT:
    try:
        from src import api as builtin_algorithm_api
        from src.api import (
            SUPPORTED_ALGORITHMS as builtin_supported_algorithms,
            get_last_strategy_diagnostics as builtin_strategy_diagnostics,
            session as builtin_algorithm_session,
        )
        from src.compiler import compile_problem
        from src.paths import MODELS_DIR
        from src.schedule.realtime import (
            RealtimeRescheduler,
            TIME_TOLERANCE,
        )
        SearchCancelledError = None
        if "schedule-alphago" in builtin_supported_algorithms:
            from src.schedule.strategies.schedule_alphago.telemetry import (
                SearchCancelledError,
            )
    except Exception as error:  # noqa: BLE001
        BUILTIN_ALGORITHM_IMPORT_ERROR = f"{type(error).__name__}: {error}"
    else:
        BUILTIN_ALGORITHM_AVAILABLE = True

if not BUILTIN_ALGORITHM_AVAILABLE:
    # 标准协议常量属于平台与算法包之间的稳定边界。后备定义只用于打包算法
    # 的时间线通知，不包含任何调度策略或本地算法实现。
    TIME_TOLERANCE = 1e-6
    MODELS_DIR = ALGORITHM_ROOT / "results" / "models"
    builtin_supported_algorithms = frozenset()
from realtime_scheduler.algorithm_interface import (
    discover_other_algorithms,
    init as algorithm_init,
    register_algorithm,
    session as algorithm_session,
    update as algorithm_update,
)
from realtime_scheduler.backend.analysis import (
    analyze_schedule_performance,
    analyze_test_group_performance,
    build_schedule_analysis_context,
    normalize_move_payload,
    summarize_bottleneck_utilization,
)
from realtime_scheduler.plan_builder import (
    CJOB_TYPE_VALUES,
    MAX_WAFERS_PER_JOB,
    TASK_MODE_VALUES,
    BuildState,
    _enum_value,
    _finite_number,
    _round_cjob_rows,
    _round_pjob_count,
    _runtime_clean,
    _stage_visit_rows,
    _string_list,
    build_process_recipes,
    build_round_update,
    build_route,
    build_task_alg_init,
    expand_pse300_loadlocks,
    extract_init_data,
)
from realtime_scheduler.recompute_state import (
    add_new_materials_to_machine_state,
    apply_machine_state_to_update,
    merge_algorithm_update,
    release_reused_source_slots,
    restore_dummy_routes_from_algorithm_output,
)
from realtime_scheduler.move_validation import (
    COMPLETE_MOVE,
    DoorState,
    MachineState,
    MoveStateReplay,
    PICK_MOVE,
    PLACE_MOVE,
    PREPARE_MOVE,
    PRE_PREPARE_MOVE,
    PRE_TRANS_MOVE,
    SWAP_MOVE,
    SlotPhase,
    release_completed_load_port_materials,
    validate_move_list,
)
from realtime_scheduler.replay_machine import ReplayMachine
from realtime_scheduler.documentation import DocumentationError, load_documentation
from realtime_scheduler.validation.hongye import HongYeValidationSession


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_REQUEST_BYTES = 12 * 1024 * 1024
# 登记算法请求以 base64 传输源码，放宽到 32MB（约 24MB 原始文件）。
MAX_REGISTERED_ALGORITHM_BYTES = 32 * 1024 * 1024
MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024
MAX_SAVED_RESULTS = 8
MAX_SAVED_BATCH_RUNS = 8
MAX_SAVED_SINGLE_RUNS = 8
MAX_CJOB_CYCLE = 1000
MAX_WORKSPACE_DEVICE_COUNT = 10
CJOB_CYCLE_EVENT_EPSILON_MULTIPLIER = 2.0
WORKSPACE_STORE_VERSION = 7
WORKSPACE_STORE_VERSION_FILE = "manifest.json"
LEGACY_WORKSPACE_STORE_VERSION_FILE = ".workspace-version.json"
WORKSPACE_TEST_INDEX_FILE = ".tests-index.json"
DATA_EXCHANGE_MAX_BYTES = 64 * 1024 * 1024
DATA_EXCHANGE_KIND_DEVICE = "ct-device"
DATA_EXCHANGE_KIND_TEST = "ct-test"
API_SCHEMA_VERSION = "cjob-pjob-v3"
HEURISTIC_BASELINE_SCHEMA_VERSION = "petri-look-dynamic-v1"
ALGORITHM_FAILURE_FEEDBACK_PREFIX = "调度失败:"
FIRST_ROBOT_SLOT_ID = 1
DUAL_ARM_SLOT_COUNT = 2
STATION_TIME_MAPPING_FIELDS = frozenset({
    "PickPrepareTime",
    "PickCompleteTime",
    "PlacePrepareTime",
    "PlaceCompleteTime",
    "PostCompleteTime",
    "AlignmentTime",
})
STATION_TIME_SEQUENCE_FIELDS = frozenset({"PrePrepareTime"})
ROBOT_TIME_MAPPING_FIELDS = frozenset({"PickTime", "PlaceTime"})
ROBOT_TIME_SEQUENCE_FIELDS = frozenset({"PrepTransTime"})
PROCESSING_STATION_TYPES = frozenset({
    "processchamber",
    "multiprocesschamber",
    "heater",
    "cooler",
})
CJOB_TYPE_NAMES = {value: name for name, value in CJOB_TYPE_VALUES.items()}
TASK_MODE_NAMES = {value: name for name, value in TASK_MODE_VALUES.items()}
REALTIME_APP_DIR = ROOT / "realtime_scheduler"
FRONTEND_DIR = REALTIME_APP_DIR / "frontend"
DATA_DIR = Path(
    os.environ.get("CT_DATA_DIR", str(REALTIME_APP_DIR / "data"))
).expanduser().resolve()
EXPORT_DIR = REALTIME_APP_DIR / "exports"
EDITOR_PATH = FRONTEND_DIR / "config_editor.html"
VIEWER_PATH = FRONTEND_DIR / "movelist_gantt_viewer.html"
ROUTE_EDITOR_LOGIC_PATH = FRONTEND_DIR / "route_editor_logic.js"
FRONTEND_ASSET_DIR = FRONTEND_DIR / "assets"
DOCUMENTATION_DIR = DATA_DIR / "documentation"
ALGORITHM_DOCUMENTATION_DIR = ALGORITHM_ROOT / "docs" / "documentation"
E2E_CTQ_MODEL_PATH = ALGORITHM_ROOT / "results" / "models" / "e2e_ctq_policy.npz"
DUAL_ACTOR_MODEL_PATH = (
    ALGORITHM_ROOT / "results" / "dual_actor_primitive_v1_candidate.npz"
)
BUILTIN_ALGORITHM_CATALOG_PATH = ALGORITHM_ROOT / "algorithms.json"
ALGORITHM_CATALOG_SCHEMA_VERSION = 1
WORKSPACE_STORE_PATH = DATA_DIR / "datasets"
LEGACY_WORKSPACE_STORE_PATH = ALGORITHM_ROOT / "results" / "config_editor_workspaces.json"
RESULT_EXPORT_DIR = EXPORT_DIR / "results"
LOG_EXPORT_DIR = EXPORT_DIR / "logs"
MODEL_CHECKPOINT_DIR = DATA_DIR / "checkpoints"
ALLOWED_CHECKPOINT_SUFFIXES = frozenset({".npz", ".pt", ".pth", ".ckpt"})
_RESULTS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_RESULTS_LOCK = threading.Lock()
_REPRODUCTION_LOGS: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
_REPRODUCTION_LOGS_LOCK = threading.Lock()
_EXPORTS_LOCK = threading.RLock()
_MODEL_CHECKPOINT_LOCK = threading.RLock()
_WORKSPACE_STORE_LOCK = threading.RLock()
_BATCH_RUNS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_BATCH_RUNS_LOCK = threading.RLock()
_BATCH_CANCEL_EVENTS: Dict[str, threading.Event] = {}
_SINGLE_RUNS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_SINGLE_RUNS_LOCK = threading.RLock()
_SINGLE_RUN_CANCEL_EVENTS: Dict[str, threading.Event] = {}
_RUN_MONITOR = threading.local()

ALGORITHM_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
FALLBACK_BUILTIN_ALGORITHM_ID = "heuristic"


def _algorithm_catalog_rows() -> List[Mapping[str, Any]]:
    """读取算法仓库的展示清单；缺少配置时自动暴露运行时声明的算法。"""
    if not BUILTIN_ALGORITHM_CATALOG_PATH.is_file():
        discovered_ids = (
            sorted(builtin_supported_algorithms)
            if builtin_supported_algorithms
            else [FALLBACK_BUILTIN_ALGORITHM_ID]
        )
        return [
            {
                "id": algorithm_id,
                "name": algorithm_id,
                "introduction": "由本地算法仓库自动发现的调度算法。",
            }
            for algorithm_id in discovered_ids
        ]
    try:
        catalog = json.loads(
            BUILTIN_ALGORITHM_CATALOG_PATH.read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"无法读取算法清单 {BUILTIN_ALGORITHM_CATALOG_PATH}：{error}"
        ) from error
    if not isinstance(catalog, Mapping):
        raise ValueError("algorithms.json 顶层必须是 JSON object")
    if catalog.get("schemaVersion") != ALGORITHM_CATALOG_SCHEMA_VERSION:
        raise ValueError(
            "algorithms.json.schemaVersion 必须为 "
            f"{ALGORITHM_CATALOG_SCHEMA_VERSION}"
        )
    rows = catalog.get("algorithms")
    if not isinstance(rows, list):
        raise ValueError("algorithms.json 必须包含 algorithms 数组")
    if not all(isinstance(row, Mapping) for row in rows):
        raise ValueError("algorithms.json.algorithms 的每一项都必须是 JSON object")
    return rows


def discover_builtin_algorithms() -> List[Dict[str, Any]]:
    """返回算法仓库配置中启用的本地算法及其实时可用状态。

    清单在每次调用时重读，因此新增算法或调整 ``enabled`` 后无需修改前端，
    也无需重启本地服务。算法只有同时被运行时 ``SUPPORTED_ALGORITHMS`` 声明、
    且配置中的依赖文件存在时才可执行。
    """
    algorithms: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, row in enumerate(_algorithm_catalog_rows()):
        if row.get("enabled", True) is False:
            continue
        algorithm_id = str(row.get("id") or "").strip().lower()
        if not ALGORITHM_ID_PATTERN.fullmatch(algorithm_id):
            raise ValueError(
                f"algorithms.json 第 {index + 1} 项 id 不合法：{algorithm_id or '<empty>'}"
            )
        if algorithm_id in seen_ids:
            raise ValueError(f"algorithms.json 中算法 id 重复：{algorithm_id}")
        seen_ids.add(algorithm_id)
        required_files = row.get("requiredFiles") or []
        if not isinstance(required_files, list) or not all(
            isinstance(path, str) and path.strip() for path in required_files
        ):
            raise ValueError(f"{algorithm_id}.requiredFiles 必须是非空路径字符串数组")
        missing_files: List[str] = []
        for path in required_files:
            resolved_path = (ALGORITHM_ROOT / path).resolve()
            try:
                resolved_path.relative_to(ALGORITHM_ROOT)
            except ValueError as error:
                raise ValueError(
                    f"{algorithm_id}.requiredFiles 只能引用算法仓库内文件：{path}"
                ) from error
            if not resolved_path.is_file():
                missing_files.append(path)
        runtime_supported = algorithm_id in builtin_supported_algorithms
        available = bool(
            BUILTIN_ALGORITHM_AVAILABLE and runtime_supported and not missing_files
        )
        unavailable_reason = ""
        if not BUILTIN_ALGORITHM_AVAILABLE:
            unavailable_reason = (
                f"本地算法仓库加载失败：{BUILTIN_ALGORITHM_IMPORT_ERROR}"
                if BUILTIN_ALGORITHM_IMPORT_ERROR
                else "本地算法仓库未安装"
            )
        elif not runtime_supported:
            unavailable_reason = "算法未加入 src.api.SUPPORTED_ALGORITHMS"
        elif missing_files:
            unavailable_reason = "缺少依赖文件：" + "、".join(missing_files)
        option_groups = row.get("optionGroups") or []
        if not isinstance(option_groups, list) or not all(
            isinstance(group, str) and group.strip() for group in option_groups
        ):
            raise ValueError(f"{algorithm_id}.optionGroups 必须是字符串数组")
        algorithms.append({
            "id": algorithm_id,
            "strategy": algorithm_id,
            "name": str(row.get("name") or algorithm_id),
            "introduction": str(row.get("introduction") or "暂无算法简介"),
            "source": "builtin",
            "available": available,
            "unavailableReason": unavailable_reason,
            "optionGroups": [str(group) for group in option_groups],
            "defaultOptions": (
                dict(row["defaultOptions"])
                if isinstance(row.get("defaultOptions"), Mapping)
                else {}
            ),
        })
    return algorithms


def _builtin_algorithm_metadata_snapshot() -> Dict[str, Dict[str, str]]:
    """生成兼容旧调用方的元数据快照，实际健康检查仍会实时读取清单。"""
    return {
        str(algorithm["strategy"]): {
            "name": str(algorithm["name"]),
            "introduction": str(algorithm["introduction"]),
        }
        for algorithm in discover_builtin_algorithms()
    }


BUILTIN_ALGORITHM_METADATA = _builtin_algorithm_metadata_snapshot()


@contextmanager
def _workspace_catalog_guard(path: Path) -> Iterator[None]:
    """串行化跨线程、跨进程的工作区读改写事务。

    Python 的 ``RLock`` 只能保护当前服务进程。批量运行或桌面端误启第二个服务时，
    两个进程若共用固定 ``.tmp`` 文件会破坏 JSON，单靠原子替换也会发生后写覆盖。
    这里用一字节系统文件锁包住完整读改写事务；锁文件只承载互斥，不保存业务数据。
    """
    lock_path = (
        path.with_name(path.name + ".lock")
        if path.suffix == ""
        else path.with_suffix(path.suffix + ".lock")
    )
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with _WORKSPACE_STORE_LOCK, lock_path.open("a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            lock_file.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@dataclass
class RecoveryProjection:
    """一次重算请求需要保留的旧动作投影结果。"""

    recovery_end: float
    material_ready_times: Dict[int, float] = field(default_factory=dict)


@dataclass
class ReproductionLog:
    """收集一次运行的事件，并可同步推送给 HongYe 增量校验会话。"""

    entries: List[Dict[str, Any]] = field(default_factory=list)
    hongye_session: Optional[HongYeValidationSession] = None
    last_hongye_validation: Optional[Dict[str, Any]] = None

    def add(
        self,
        describe: str,
        info: Any,
        sim_time: float = 0.0,
        *,
        forward_to_validator: bool = True,
    ) -> None:
        """追加标准事件；启用 HongYe 时先逐条发送并在 AlgOutput 处校验。"""
        entry = {
            "Time": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            "Describe": describe,
            "SimTime": float(sim_time),
            "Info": deepcopy(info),
        }
        if self.hongye_session is not None and forward_to_validator:
            # AlgSchedule 是一代完整现场快照。HongYe 若跨代累积事件，会拿新一代
            # Material 状态回头重放旧 AlgOutput，制造历史占用和 Route 冲突。
            # 平台复现日志仍完整保留；校验器只在新代开始时重置并补发 AlgInit。
            starts_new_generation = (
                describe.casefold() == "algschedule"
                and any(
                    str(previous.get("Describe") or "").casefold() == "algoutput"
                    for previous in self.entries
                )
            )
            if starts_new_generation:
                self.hongye_session.reset()
                latest_init = next(
                    (
                        previous
                        for previous in reversed(self.entries)
                        if str(previous.get("Describe") or "").casefold() == "alginit"
                    ),
                    None,
                )
                if latest_init is not None:
                    self.hongye_session.add_event(latest_init)
            validation = self.hongye_session.add_event(entry)
            if validation is not None:
                self.last_hongye_validation = deepcopy(validation)
                if not validation.get("success"):
                    issues = _hongye_validation_issue_messages(
                        validation.get("issues") or []
                    )
                    output = info if isinstance(info, Mapping) else {}
                    message = (
                        "HongYe MoveList 状态校验失败："
                        + (issues[0] if issues else "存在未分类错误")
                    )
                    raise MoveListValidationError(
                        message,
                        output,
                        issues,
                        _build_validation_gantt_output(output, issues),
                        float(sim_time),
                    )
        self.entries.append(entry)


def _hongye_validation_issue_messages(
    issues: Sequence[Mapping[str, Any]],
) -> List[str]:
    """把 HongYe 结构化 issue 转成现有甘特图可定位的稳定文案。"""
    messages: List[str] = []
    for issue in issues:
        if not isinstance(issue, Mapping):
            messages.append(str(issue))
            continue
        move_id = issue.get("move_id")
        phase = str(issue.get("phase") or "")
        code = str(issue.get("code") or "HONGYE")
        detail = str(issue.get("message") or "HongYe 校验失败")
        messages.append(
            f"[{code}] MoveID={move_id} {phase}: {detail}".strip()
        )
    return messages


def _remove_released_materials_from_update(
    update_params: Dict[str, Any],
    released_material_ids: set[Any],
) -> None:
    """从标准算法全量 update 中移除已卸载晶圆及已经结束的空 PJob/CJob。"""
    if not released_material_ids:
        return
    update_params["Materials"] = [
        material
        for material in update_params.get("Materials") or []
        if not isinstance(material, Mapping)
        or material.get("ID") not in released_material_ids
    ]
    process_jobs: List[Dict[str, Any]] = []
    material_count_by_job: Dict[str, int] = {}
    for raw_job in update_params.get("ProcessJobs") or []:
        if not isinstance(raw_job, Mapping):
            continue
        job = deepcopy(dict(raw_job))
        job["MatList"] = [
            material_id
            for material_id in job.get("MatList") or []
            if material_id not in released_material_ids
        ]
        if not job["MatList"]:
            continue
        job_name = str(job.get("JobName") or "")
        material_count_by_job[job_name] = len(job["MatList"])
        process_jobs.append(job)
    update_params["ProcessJobs"] = process_jobs
    control_jobs: List[Dict[str, Any]] = []
    for raw_job in update_params.get("ControlJobs") or []:
        if not isinstance(raw_job, Mapping):
            continue
        job = deepcopy(dict(raw_job))
        pjob_names = [
            str(name)
            for name in job.get("PJobNameList") or []
            if str(name) in material_count_by_job
        ]
        if not pjob_names:
            continue
        job["PJobNameList"] = pjob_names
        job["MaterialCount"] = sum(material_count_by_job[name] for name in pjob_names)
        control_jobs.append(job)
    update_params["ControlJobs"] = control_jobs


class MoveListValidationError(RuntimeError):
    """携带原始算法输出和诊断甘特图数据的 MoveList 校验异常。"""

    def __init__(
        self,
        message: str,
        algorithm_output: Mapping[str, Any],
        validation_issues: Sequence[Any],
        gantt_output: Mapping[str, Any],
        sim_time: float,
    ) -> None:
        """保存失败现场，使接口仍能导出并展示问题 Move。"""
        super().__init__(message)
        self.algorithm_output = deepcopy(dict(algorithm_output))
        self.validation_issues = [str(issue) for issue in validation_issues]
        self.gantt_output = deepcopy(dict(gantt_output))
        self.sim_time = float(sim_time)


class UserRunCancelledError(RuntimeError):
    """用户通过单测状态接口请求停止当前运行。"""


def _single_run_snapshot(run_id: str) -> Optional[Dict[str, Any]]:
    """返回单测后台状态；运行时长由服务端单调时钟实时计算。"""
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None:
            return None
        snapshot = deepcopy(run)
        started_perf = float(snapshot.pop("_startedPerf", time.perf_counter()))
        if snapshot.get("status") in {"queued", "running", "cancelling"}:
            snapshot["elapsedMs"] = max(0.0, (time.perf_counter() - started_perf) * 1000.0)
        return snapshot


def _start_single_run(run_id: str, strategy: str, test_name: str) -> threading.Event:
    """登记由同步 ``/api/run`` 请求承载、但可独立轮询的单测状态。"""
    normalized_id = str(run_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", normalized_id):
        raise ValueError("clientRunId 格式不正确")
    cancel_event = threading.Event()
    now = _workspace_timestamp()
    initial = {
        "runId": normalized_id,
        "ok": True,
        "status": "running",
        "strategy": str(strategy or "heuristic"),
        "testName": str(test_name or "当前测试"),
        "createdAt": now,
        "startedAt": now,
        "elapsedMs": 0.0,
        "events": [],
        "_startedPerf": time.perf_counter(),
    }
    with _SINGLE_RUNS_LOCK:
        _SINGLE_RUNS[normalized_id] = initial
        _SINGLE_RUN_CANCEL_EVENTS[normalized_id] = cancel_event
        _SINGLE_RUNS.move_to_end(normalized_id)
        while len(_SINGLE_RUNS) > MAX_SAVED_SINGLE_RUNS:
            expired_id, _ = _SINGLE_RUNS.popitem(last=False)
            _SINGLE_RUN_CANCEL_EVENTS.pop(expired_id, None)
    return cancel_event


def _finish_single_run(run_id: str, status: str, error: str = "") -> None:
    """完成、失败或取消单测，并保留最终耗时与精简事件历史。"""
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None or run.get("status") == "cancelled":
            return
        run["status"] = status
        run["ok"] = status == "completed"
        run["elapsedMs"] = max(
            0.0,
            (time.perf_counter() - float(run.get("_startedPerf", time.perf_counter()))) * 1000.0,
        )
        run["finishedAt"] = _workspace_timestamp()
        if error:
            run["error"] = str(error)


def _cancel_single_run(run_id: str) -> Optional[Dict[str, Any]]:
    """请求停止单测；算法调用返回后将不再接纳输出或执行后续轮次。"""
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None:
            return None
        if run.get("status") in {"completed", "failed", "cancelled"}:
            return _single_run_snapshot(run_id)
        cancel_event = _SINGLE_RUN_CANCEL_EVENTS.get(run_id)
        if cancel_event is not None:
            cancel_event.set()
        run["ok"] = False
        run["status"] = "cancelled"
        run["elapsedMs"] = max(
            0.0,
            (time.perf_counter() - float(run.get("_startedPerf", time.perf_counter()))) * 1000.0,
        )
        run["finishedAt"] = _workspace_timestamp()
        run["error"] = "用户停止测试"
        for event in run.get("events") or []:
            if event.get("status") == "running":
                event["status"] = "cancelled"
                event["detail"] = "用户停止测试"
                event["updatedAt"] = run["finishedAt"]
        return _single_run_snapshot(run_id)


@contextmanager
def _monitor_single_run(run_id: str, strategy: str) -> Iterator[None]:
    """把当前 HTTP 请求的真实算法阶段关联到可轮询状态。"""
    previous = getattr(_RUN_MONITOR, "value", None)
    _RUN_MONITOR.value = {
        "runId": run_id,
        "strategy": str(strategy or "heuristic"),
        "scope": "selected",
    }
    try:
        yield
    finally:
        _RUN_MONITOR.value = previous


def _set_run_monitor_scope(strategy: str) -> None:
    """区分可选的 Baseline 调用和用户选择的策略调用。"""
    monitor = getattr(_RUN_MONITOR, "value", None)
    if monitor is not None:
        monitor["scope"] = (
            "selected"
            if str(strategy or "heuristic") == monitor.get("strategy")
            else "baseline"
        )


def _report_run_event(key: str, label: str, status: str, detail: str = "") -> None:
    """原子更新一个真实 init/update/output/validation 阶段。"""
    monitor = getattr(_RUN_MONITOR, "value", None)
    if monitor is None:
        return
    run_id = str(monitor.get("runId") or "")
    scope = str(monitor.get("scope") or "selected")
    event_key = f"{scope}:{key}"
    display_label = f"Baseline · {label}" if scope == "baseline" else label
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None or run.get("status") == "cancelled":
            return
        events = run.setdefault("events", [])
        event = next((item for item in events if item.get("key") == event_key), None)
        values = {
            "key": event_key,
            "label": display_label,
            "status": status,
            "detail": str(detail or ""),
            "updatedAt": _workspace_timestamp(),
        }
        if event is None:
            events.append(values)
        else:
            event.update(values)
        if len(events) > 16:
            del events[:-16]


def _raise_if_single_run_cancelled() -> None:
    """在算法边界检查停止标记，避免接纳迟到输出。"""
    monitor = getattr(_RUN_MONITOR, "value", None)
    if monitor is None:
        return
    cancel_event = _SINGLE_RUN_CANCEL_EVENTS.get(str(monitor.get("runId") or ""))
    if cancel_event is not None and cancel_event.is_set():
        raise UserRunCancelledError("运行已取消")


def _compile_external_validation_problem(
    tool_topology: Mapping[str, Any],
    update_params: Mapping[str, Any],
) -> Any:
    """为外部算法输出构造不重复合成 Dummy 的平台校验 Problem。

    标准外部算法已经消费 ``PreDummyClean`` 并返回具体 Dummy Route。平台这里只
    需要产品 Route 的时长与驻留约束；在校验副本中清空 ``PrePJob``，可阻止
    内置编译器再次按跨轮产品作业合成 Dummy PJob，同时不修改真正发送给算法、
    保存为下一轮基线的标准 update。
    """
    validation_update = deepcopy(dict(update_params))
    for process_job in validation_update.get("ProcessJobs") or []:
        if not isinstance(process_job, dict):
            continue
        origin_route = process_job.get("OriginRoute")
        if isinstance(origin_route, dict):
            origin_route["PrePJob"] = {}
    return compile_problem(tool_topology, validation_update)


class StandardAlgorithmRuntime:
    """用本仓库状态机维护标准算法当前计划和跨代执行历史。"""

    def __init__(
        self,
        tool_topo: Mapping[str, Any],
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        *,
        skip_validation: bool = False,
    ) -> None:
        """解析首轮完整 update，并把外部 MoveList 挂到实时状态回放器。

        ``skip_validation`` 为 True 时跳过 MoveList 合法性校验，直接回放算法
        原始输出（用户显式选择“跳过输出校验”）。
        """
        self.tool_topo = deepcopy(dict(tool_topo))
        self.current_update = deepcopy(dict(update_params))
        self.skip_validation = bool(skip_validation)
        self.problem = compile_problem(self.tool_topo, self.current_update)
        initial_state = MachineState.from_sources(self.problem, self.current_update)
        initial_moves = list(output.get("MoveList") or [])
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(
                self.problem,
                initial_moves,
                initial_state,
            )
        )
        if validation_issues:
            message = (
                "标准算法首次排程 MoveList 状态校验失败："
                f"{validation_issues[0]}"
            )
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(output, validation_issues),
                float(self.current_update.get("CurrentTime") or 0.0),
            )
        self._tracker = MoveStateReplay(
            self.problem,
            initial_moves,
            initial_state,
        )
        self._generation_initial_state = initial_state.clone()
        self._tracker.current_time = float(self.current_update.get("CurrentTime") or 0.0)
        self._history: List[dict] = []
        self._recompute_points: List[Dict[str, Any]] = []
        self._committed_recovery_end = float(
            self.current_update.get("CurrentTime") or 0.0
        )
        self._latest_output = _alg_output_info(output)

    @property
    def current_plan(self) -> List[dict]:
        """返回当前计划代次，供统一的安全切点投影函数消费。"""
        return [dict(move) for move in self._tracker.materialized_plan]

    @property
    def state(self) -> MachineState:
        """返回由平台物理状态记录器维护的隔离整机快照。"""
        return self._tracker.state.clone()

    @property
    def state_time(self) -> float:
        """返回已经回放到的绝对时间。"""
        return float(self._tracker.current_time)

    @property
    def committed_recovery_end(self) -> float:
        """返回此前重算已承诺、不能再被后续重算取消的最晚结束时刻。"""
        return float(self._committed_recovery_end)

    @property
    def running_move_ids(self) -> frozenset[int]:
        """返回当前计划中已开始但未完成的动作编号。"""
        return self._tracker.running_move_ids

    @property
    def executed_move_ids(self) -> frozenset[int]:
        """返回当前计划代次已经完成的动作编号。"""
        return frozenset(
            int(move["MoveID"])
            for move in self._tracker.executed_moves
            if isinstance(move.get("MoveID"), int)
        )

    @property
    def can_recompute(self) -> bool:
        """判断现场是否达到关门、空手且无运行 Move 的稳定重算点。"""
        if self._tracker.running_move_ids:
            return False
        if any(
            station.door is not DoorState.CLOSED
            for station in self._tracker.state.stations.values()
        ):
            return False
        return all(
            material is None
            for robot in self._tracker.state.robots.values()
            for material in robot.hands.values()
        )

    def release_completed_load_ports(
        self,
        load_port_names: Sequence[str],
    ) -> Tuple[set[Any], set[str]]:
        """卸载已完成晶圆，并同步裁剪标准算法下一轮使用的全量 update。"""
        released_ids, empty_ports = release_completed_load_port_materials(
            self.problem,
            self._tracker.state,
            load_port_names,
        )
        if released_ids:
            self.problem.wafers = [
                wafer for wafer in self.problem.wafers
                if wafer.mat_id not in released_ids
            ]
            _remove_released_materials_from_update(self.current_update, released_ids)
        return released_ids, empty_ports

    def update_move_state(
        self,
        notification: Mapping[str, Any],
        *,
        snapshot: bool = True,
        track_reservations: bool = True,
    ) -> Optional[MachineState]:
        """把模拟设备通知交给同一套 MoveList 状态回放器。"""
        return self._tracker.update_move_state(
            notification,
            snapshot=snapshot,
            track_reservations=track_reservations,
        )

    def robot_position(self, robot_name: str) -> Optional[str]:
        """只读返回 Robot 当前指向，不复制完整设备快照。"""
        robot = self._tracker.state.resolve_robot(robot_name)
        return robot.position if robot is not None else None

    def project_started_moves(
        self,
        cutoff: float,
        released_material_ids: Optional[set[Any]] = None,
    ) -> Tuple[MachineState, List[dict]]:
        """把重算时刻前已启动的 Move 全部投影到完成态。

        外部算法的 update 不由前端执行安全收尾，但标准接口要求现场快照体现
        已经启动、不可取消动作的完成态。这里从本代初始状态重新回放，只提交
        ``StartTime < cutoff`` 的动作；重算时刻及之后的动作留给 RemoveList。

        参数:
            cutoff: 用户请求的原始重算时刻。
            released_material_ids: 已在本轮卸载、不得重新写入快照的物料编号。

        返回:
            投影后的整机状态，以及本代所有已承诺动作的 MoveList。
        """
        committed_ids = {
            int(move["MoveID"])
            for move in self.current_plan
            if (
                isinstance(move.get("MoveID"), int)
                and float(move.get("StartTime") or 0.0)
                < float(cutoff) - TIME_TOLERANCE
            )
        }
        projection = MoveStateReplay(
            self.problem,
            self.current_plan,
            self._generation_initial_state,
        )
        started: set[int] = set()
        finished: set[int] = set()
        for group in _planned_event_groups(self.current_plan):
            for _, notification in group["priorFinishes"]:
                move_id = int(notification["MoveID"])
                if move_id in committed_ids and move_id in started and move_id not in finished:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
            for event_kind, _, notification in _planned_start_events(group):
                move_id = int(notification["MoveID"])
                if event_kind == "start" and move_id in committed_ids and move_id not in started:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    started.add(move_id)
                elif (
                    event_kind == "finish"
                    and move_id in committed_ids
                    and move_id in started
                    and move_id not in finished
                ):
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
        missing = committed_ids - finished
        if missing:
            raise ValueError(
                f"无法投影重算时刻前已启动的 Move：{sorted(missing)[:8]}"
            )

        projected_state = projection.state.clone()
        released_ids = set(released_material_ids or ())
        if released_ids:
            for station in projected_state.stations.values():
                for slot in station.slots.values():
                    if (
                        slot.material is not None
                        and slot.material.material_id in released_ids
                    ):
                        slot.phase = SlotPhase.EMPTY
                        slot.material = None
            for robot in projected_state.robots.values():
                for slot_id, material in robot.hands.items():
                    if (
                        material is not None
                        and material.material_id in released_ids
                    ):
                        robot.hands[slot_id] = None
        return projected_state, projection.executed_moves

    def replace_plan(
        self,
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        requested_time: float,
        effective_time: float,
        reason: str,
        *,
        initial_state: Optional[MachineState] = None,
        committed_moves: Optional[Sequence[Mapping[str, Any]]] = None,
        compile_for_validation: bool = True,
    ) -> None:
        """保存已执行历史，以调用方给定的重算快照装载下一代计划。

        外部标准算法已经按完整 update 编译过 Dummy 清洗作业；此时平台再次调用
        内置 ``compile_problem`` 会把跨轮 ProcessJobs 的 PreDummyClean 重新合成，
        导致同一个 Dummy MatID 被两份内部 PJob 重复占用。外部算法装载可关闭
        语义编译，仅用标准 update 和 MoveList 做平台物理校验。
        """
        next_state = (
            initial_state.clone()
            if initial_state is not None
            else self._tracker.state.clone()
        )
        add_new_materials_to_machine_state(next_state, update_params)
        next_update = deepcopy(dict(update_params))
        next_problem = (
            compile_problem(self.tool_topo, next_update)
            if compile_for_validation
            else _compile_external_validation_problem(self.tool_topo, next_update)
        )
        next_moves = list(output.get("MoveList") or [])
        committed = (
            deepcopy(list(committed_moves))
            if committed_moves is not None
            else self._tracker.executed_moves
        )
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(
                next_problem,
                next_moves,
                next_state,
                # 重算增量输出可引用旧代已提交/正在执行的 Move 作为前驱。
                external_predecessors=_committed_move_index(
                    [*self._history, *committed]
                ),
            )
        )
        if validation_issues:
            message = f"{reason} MoveList 状态校验失败：{validation_issues[0]}"
            recompute_point = {
                "Time": float(requested_time),
                "EffectiveTime": float(effective_time),
                "ScheduleStartTime": float(effective_time),
                "RecoveryEndTime": float(effective_time),
                "Index": len(self._recompute_points) + 1,
                "Reason": reason,
                "Validation": "failed",
            }
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(
                    output,
                    validation_issues,
                    prefix_moves=[*self._history, *committed],
                    recompute_points=[
                        *self._recompute_points,
                        recompute_point,
                    ],
                ),
                float(effective_time),
            )
        next_tracker = MoveStateReplay(
            next_problem,
            next_moves,
            next_state,
        )
        self._history.extend(committed)
        self.current_update = next_update
        self.problem = next_problem
        self._tracker = next_tracker
        self._generation_initial_state = next_state.clone()
        self._tracker.current_time = float(effective_time)
        self._committed_recovery_end = max(
            self._committed_recovery_end,
            float(effective_time),
        )
        self._latest_output = _alg_output_info(output)
        self._recompute_points.append({
            "Time": float(requested_time),
            "EffectiveTime": float(effective_time),
            "ScheduleStartTime": float(effective_time),
            "RecoveryEndTime": float(effective_time),
            "Index": len(self._recompute_points) + 1,
            "Reason": reason,
        })

    def combined_output(self) -> Dict[str, Any]:
        """拼接已完成历史与最后一代有效计划，并保留外部诊断字段。"""
        moves = [dict(move) for move in self._history]
        moves.extend(self._tracker.materialized_plan)
        moves.sort(key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move.get("MoveID") or 0),
        ))
        output = _alg_output_info(self._latest_output)
        output["MoveList"] = moves
        output["RecomputePoints"] = deepcopy(self._recompute_points)
        return output


class PackagedAlgorithmRuntime:
    """在没有本地算法仓库时用平台状态记录器维护跨轮时间线。"""

    def __init__(
        self,
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        *,
        skip_validation: bool = False,
    ) -> None:
        """以标准 update 建立首轮物理快照，并校验算法包输出。"""
        self.current_update = deepcopy(dict(update_params))
        self.skip_validation = bool(skip_validation)
        initial_state = MachineState.from_sources(None, self.current_update)
        initial_moves = deepcopy(list(output.get("MoveList") or []))
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(None, initial_moves, initial_state)
        )
        if validation_issues:
            message = (
                "标准算法首次排程 MoveList 状态校验失败："
                f"{validation_issues[0]}"
            )
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(output, validation_issues),
                float(self.current_update.get("CurrentTime") or 0.0),
            )
        self._tracker = MoveStateReplay(None, initial_moves, initial_state)
        self._generation_initial_state = initial_state.clone()
        self._tracker.current_time = float(
            self.current_update.get("CurrentTime") or 0.0
        )
        self._history: List[dict] = []
        self._recompute_points: List[Dict[str, Any]] = []
        self._latest_output = _alg_output_info(output)

    @property
    def current_plan(self) -> List[dict]:
        """返回当前算法代次的 MoveList 副本。"""
        return self._tracker.materialized_plan

    @property
    def state(self) -> MachineState:
        """返回平台记录器维护的隔离整机快照。"""
        return self._tracker.state.clone()

    @property
    def state_time(self) -> float:
        """返回已经推进到的物理状态时间。"""
        return float(self._tracker.current_time)

    def advance_to(self, cutoff: float) -> None:
        """在时间线上推进当前快照时刻。"""
        self._tracker.current_time = max(
            self._tracker.current_time,
            float(cutoff),
        )

    def update_move_state(
        self,
        notification: Mapping[str, Any],
        *,
        snapshot: bool = True,
        track_reservations: bool = True,
    ) -> Optional[MachineState]:
        """把算法包时间线通知交给平台物理状态记录器。"""
        return self._tracker.update_move_state(
            notification,
            snapshot=snapshot,
            track_reservations=track_reservations,
        )

    def release_completed_load_ports(
        self,
        load_port_names: Sequence[str],
    ) -> Tuple[set[Any], set[str]]:
        """根据当前代次的最终动作释放已完成物料及其 LoadPort。

        轻量模式不解释设备状态，只在某片物料的本代最后动作已经结束时认定
        该片完成。释放范围必须同时受调用方给出的 LoadPort 和物理快照约束；
        返回 DummyPort 的清洁片虽然本代动作已经结束，仍是可复用库存，不能
        作为产品成品从下一轮 Materials 中移除。只有同一 LoadPort 的历史物料
        全部完成后才允许槽位复用。
        """
        material_moves: Dict[Any, List[Mapping[str, Any]]] = {}
        for move in self.current_plan:
            for material_id in _move_material_ids(move):
                material_moves.setdefault(material_id, []).append(move)
        completed_material_ids = {
            material_id
            for material_id, moves in material_moves.items()
            if moves and max(
                float(move.get("EndTime") or move.get("StartTime") or 0.0)
                for move in moves
            ) <= self.state_time + TIME_TOLERANCE
        }
        requested_load_ports = {
            str(load_port_name)
            for load_port_name in load_port_names
            if str(load_port_name)
        }
        released_ids: set[Any] = set()
        for load_port_name in requested_load_ports:
            station = self._tracker.state.stations.get(load_port_name)
            if station is None:
                continue
            for slot in station.slots.values():
                material = slot.material
                if (
                    material is not None
                    and material.material_id in completed_material_ids
                ):
                    released_ids.add(material.material_id)
        if released_ids:
            _remove_released_materials_from_update(self.current_update, released_ids)

        empty_ports: set[str] = set()
        for load_port_name in requested_load_ports:
            station = self._tracker.state.stations.get(load_port_name)
            if station is None or all(
                slot.material is None
                or slot.material.material_id in released_ids
                for slot in station.slots.values()
            ):
                empty_ports.add(load_port_name)
        return released_ids, empty_ports

    def committed_moves(self, cutoff: float) -> List[dict]:
        """返回重算时刻前已经启动、不能从历史中删除的动作。"""
        return [
            deepcopy(move)
            for move in self.current_plan
            if float(move.get("StartTime") or 0.0)
            < float(cutoff) - TIME_TOLERANCE
        ]

    def project_started_moves(
        self,
        cutoff: float,
        released_material_ids: Optional[set[Any]] = None,
    ) -> Tuple[MachineState, List[dict]]:
        """把重算时刻前已启动的动作从代次初态完整投影到结束态。"""
        committed_ids = {
            int(move["MoveID"])
            for move in self.current_plan
            if (
                isinstance(move.get("MoveID"), int)
                and float(move.get("StartTime") or 0.0)
                < float(cutoff) - TIME_TOLERANCE
            )
        }
        projection = MoveStateReplay(
            None,
            self.current_plan,
            self._generation_initial_state,
        )
        started: set[int] = set()
        finished: set[int] = set()
        for group in _planned_event_groups(self.current_plan):
            for _, notification in group["priorFinishes"]:
                move_id = int(notification["MoveID"])
                if move_id in committed_ids and move_id in started and move_id not in finished:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
            for event_kind, _, notification in _planned_start_events(group):
                move_id = int(notification["MoveID"])
                if event_kind == "start" and move_id in committed_ids and move_id not in started:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    started.add(move_id)
                elif (
                    event_kind == "finish"
                    and move_id in committed_ids
                    and move_id in started
                    and move_id not in finished
                ):
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
        missing_ids = committed_ids - finished
        if missing_ids:
            raise ValueError(
                f"无法投影重算时刻前已启动的 Move：{sorted(missing_ids)[:8]}"
            )

        projected_state = projection.state.clone()
        released_ids = set(released_material_ids or ())
        if released_ids:
            for station in projected_state.stations.values():
                for slot in station.slots.values():
                    if (
                        slot.material is not None
                        and slot.material.material_id in released_ids
                    ):
                        slot.phase = SlotPhase.EMPTY
                        slot.material = None
            for robot in projected_state.robots.values():
                for slot_id, material in robot.hands.items():
                    if material is not None and material.material_id in released_ids:
                        robot.hands[slot_id] = None
        return projected_state, projection.executed_moves

    def replace_plan(
        self,
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        requested_time: float,
        reason: str,
        committed_moves: Sequence[Mapping[str, Any]],
        *,
        initial_state: Optional[MachineState] = None,
    ) -> None:
        """提交旧代历史，并从投影快照装载、校验新的计划代次。"""
        next_state = (
            initial_state.clone()
            if initial_state is not None
            else self._tracker.state.clone()
        )
        add_new_materials_to_machine_state(next_state, update_params)
        next_moves = deepcopy(list(output.get("MoveList") or []))
        committed = deepcopy(list(committed_moves))
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(
                None,
                next_moves,
                next_state,
                # 重算增量输出可引用旧代已提交/正在执行的 Move 作为前驱。
                external_predecessors=_committed_move_index(
                    [*self._history, *committed]
                ),
            )
        )
        if validation_issues:
            message = f"{reason} MoveList 状态校验失败：{validation_issues[0]}"
            recompute_point = {
                "Time": float(requested_time),
                "EffectiveTime": float(requested_time),
                "ScheduleStartTime": float(requested_time),
                "RecoveryEndTime": float(requested_time),
                "Index": len(self._recompute_points) + 1,
                "Reason": reason,
                "Validation": "failed",
            }
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(
                    output,
                    validation_issues,
                    prefix_moves=[*self._history, *committed],
                    recompute_points=[*self._recompute_points, recompute_point],
                ),
                float(requested_time),
            )
        self._history.extend(committed)
        self.current_update = deepcopy(dict(update_params))
        self._tracker = MoveStateReplay(None, next_moves, next_state)
        self._generation_initial_state = next_state.clone()
        self._tracker.current_time = float(requested_time)
        self._latest_output = _alg_output_info(output)
        self._recompute_points.append({
            "Time": float(requested_time),
            "EffectiveTime": float(requested_time),
            "ScheduleStartTime": float(requested_time),
            "RecoveryEndTime": float(requested_time),
            "Index": len(self._recompute_points) + 1,
            "Reason": reason,
        })

    def combined_output(self) -> Dict[str, Any]:
        """拼接旧代已承诺动作与最后一代有效计划。"""
        moves = [*deepcopy(self._history), *self._tracker.materialized_plan]
        moves.sort(key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move.get("MoveID") or 0),
        ))
        output = _alg_output_info(self._latest_output)
        output["MoveList"] = moves
        output["RecomputePoints"] = deepcopy(self._recompute_points)
        return output


class LoggedPlanError(RuntimeError):
    """携带可下载复现日志的排程异常。"""

    def __init__(
        self,
        message: str,
        reproduction_log: Sequence[Mapping[str, Any]],
        *,
        failure_output: Optional[Mapping[str, Any]] = None,
        validation_issues: Optional[Sequence[str]] = None,
    ) -> None:
        """保存错误日志，并可选携带供甘特图查看的失败 MoveList。"""
        super().__init__(message)
        self.reproduction_log = deepcopy(list(reproduction_log))
        self.failure_output = (
            deepcopy(dict(failure_output))
            if failure_output is not None
            else None
        )
        self.validation_issues = list(validation_issues or ())


def _committed_move_index(
    moves: Sequence[Mapping[str, Any]],
) -> Dict[int, Mapping[str, Any]]:
    """按 MoveID 建立已提交 Move 索引，供重算增量校验引用为合法前驱。"""
    indexed: Dict[int, Mapping[str, Any]] = {}
    for move in moves:
        raw_move_id = move.get("MoveID")
        if isinstance(raw_move_id, int) and not isinstance(raw_move_id, bool):
            indexed[int(raw_move_id)] = move
    return indexed


def _alg_output_info(
    output: Optional[Mapping[str, Any]] = None,
    feedback: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """生成与 input_data 中 AlgOutput 相同的顶层结构。"""
    source = output or {}
    normalized = {
        "MoveList": deepcopy(list(source.get("MoveList") or [])),
        "Feedback": deepcopy(list(feedback if feedback is not None else source.get("Feedback") or [])),
        "JobList": deepcopy(list(source.get("JobList") or [])),
        "DummyReturnInfo": deepcopy(dict(source.get("DummyReturnInfo") or {})),
        "MatIntoPM": deepcopy(dict(source.get("MatIntoPM") or {})),
    }
    diagnostic = source.get("DeadlockDiagnostic")
    if isinstance(diagnostic, Mapping) and diagnostic:
        normalized["DeadlockDiagnostic"] = deepcopy(dict(diagnostic))
    return normalized


def _deadlock_feedback(
    output: Mapping[str, Any],
) -> Optional[Dict[str, Any]]:
    """把算法失败 Feedback 规范化为平台内部死锁记录。

    内置算法和 MLP 都按公司接口返回 ``调度失败: <原因>`` 字符串。这里仍
    兼容旧版结构化记录，避免历史结果和已部署外部算法无法回放。
    """
    for raw_feedback in output.get("Feedback") or []:
        if isinstance(raw_feedback, str):
            message = raw_feedback.strip()
            if not message.startswith(ALGORITHM_FAILURE_FEEDBACK_PREFIX):
                continue
            reason = message[len(ALGORITHM_FAILURE_FEEDBACK_PREFIX):].strip()
            return {
                "Level": "Error",
                "Type": "MachineDeadlockError",
                "Code": "DEADLOCK.NO_EXECUTABLE_ACTION",
                "Category": "no-executable-action",
                "Message": reason or "算法规划进入死锁",
            }
        if not isinstance(raw_feedback, Mapping):
            continue
        code = str(raw_feedback.get("Code") or "").strip().upper()
        category = str(raw_feedback.get("Category") or "").strip().casefold()
        feedback_type = str(raw_feedback.get("Type") or "").strip().casefold()
        if (
            code.startswith("DEADLOCK.")
            or category.startswith("deadlock")
            or "deadlock" in feedback_type
        ):
            return deepcopy(dict(raw_feedback))
    return None


def _classify_deadlock_diagnostic(
    diagnostic: Mapping[str, Any],
) -> Optional[Dict[str, str]]:
    """按 Machine 权威现场识别可证明的死锁类型。

    分类只使用物料当前位置、下一站、站点占用、Robot 手槽和 Dummy 标记；
    证据不足时返回 ``None``，由调用方保留通用无动作类型。
    """
    pending = [
        dict(row)
        for row in diagnostic.get("PendingMaterials") or []
        if isinstance(row, Mapping)
    ]
    held_robots = [
        dict(row)
        for row in diagnostic.get("HeldRobots") or []
        if isinstance(row, Mapping)
    ]
    occupied_stations = {
        str(row.get("Station") or ""): dict(row)
        for row in diagnostic.get("OccupiedStations") or []
        if isinstance(row, Mapping) and row.get("Station")
    }
    load_lock_names = {
        str(row.get("Station") or "")
        for row in diagnostic.get("LoadLocks") or []
        if isinstance(row, Mapping) and row.get("Station")
    }
    pending_by_id = {
        str(row.get("MaterialID")): row
        for row in pending
        if row.get("MaterialID") is not None
    }

    def string_set(value: Any) -> set[str]:
        """把协议列表字段规范化为非空字符串集合。"""
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            return set()
        return {str(item) for item in value if str(item)}

    # Dummy 位于自己仍需服务的同一 PM 时，没有搬运能够推进清洗 Route。
    for row in pending:
        location = str(row.get("Location") or "")
        if row.get("IsDummy") and location in string_set(row.get("NextStations")):
            return {
                "Code": "DEADLOCK.CLEANING_SELF_BLOCKED",
                "Category": "cleaning-self-blocked",
                "Message": f"Dummy 清洗片 {row.get('MaterialID')} 位于 {location}，下一步仍要求同一腔室，清洗 Route 无法推进。",
            }

    for held_robot in held_robots:
        robot_name = str(held_robot.get("Robot") or "Robot")
        hands = held_robot.get("Hands")
        held_ids = {
            str(value)
            for value in (hands.values() if isinstance(hands, Mapping) else [])
        }
        capacity = max(1, int(held_robot.get("Capacity") or len(held_ids) or 1))
        for material_id in held_ids:
            material = pending_by_id.get(material_id)
            if material is None:
                continue
            targets = string_set(material.get("NextStations"))
            if not targets:
                continue
            if all(bool(occupied_stations.get(target, {}).get("Full")) for target in targets):
                if capacity <= 1:
                    code = "DEADLOCK.SINGLE_ARM_TARGET_FULL"
                    category = "single-arm-target-full"
                elif len(held_ids) >= capacity:
                    code = "DEADLOCK.DUAL_ARM_TARGETS_FULL"
                    category = "dual-arm-targets-full"
                else:
                    code = "DEADLOCK.DUAL_ARM_SINGLE_HELD_TARGET_FULL"
                    category = "dual-arm-single-held-target-full"
                return {
                    "Code": code,
                    "Category": category,
                    "Message": f"{robot_name} 持有晶圆 {material_id}，其目标 {', '.join(sorted(targets))} 均已满。",
                }
            cleaning_conflicts = [
                row for row in pending
                if row.get("IsDummy")
                and str(row.get("MaterialID")) not in held_ids
                and targets & string_set(row.get("RemainingProcessStations"))
            ]
            if cleaning_conflicts:
                dummy_ids = ", ".join(str(row.get("MaterialID")) for row in cleaning_conflicts)
                return {
                    "Code": "DEADLOCK.ROBOT_HELD_CLEANING_CONFLICT",
                    "Category": "robot-held-cleaning-conflict",
                    "Message": f"{robot_name} 持有晶圆 {material_id}，但目标 {', '.join(sorted(targets))} 必须先由 Dummy {dummy_ids} 完成清洗；Robot 无法同时推进清洗片。",
                }
            if targets & load_lock_names:
                return {
                    "Code": "DEADLOCK.ROBOT_HELD_LOADLOCK_BLOCKED",
                    "Category": "robot-held-loadlock-blocked",
                    "Message": f"{robot_name} 持有晶圆 {material_id}，目标 LoadLock {', '.join(sorted(targets & load_lock_names))} 无法接片或切换方向。",
                }
            return {
                "Code": "DEADLOCK.ROBOT_HELD_RESOURCE_WAIT",
                "Category": "robot-held-resource-wait",
                "Message": f"{robot_name} 持有晶圆 {material_id}，目标 {', '.join(sorted(targets))} 当前无法接片，Robot 也无法推进其他搬运。",
            }

    # 没有 Robot 持片时，从满载目标构造物料等待图；含 LoadLock 的环单独命名。
    dependency_edges: Dict[str, set[str]] = {}
    for row in pending:
        source_id = str(row.get("MaterialID"))
        for target in string_set(row.get("NextStations")):
            station = occupied_stations.get(target)
            if not station or not station.get("Full"):
                continue
            occupied = station.get("Occupied")
            if isinstance(occupied, Mapping):
                dependency_edges.setdefault(source_id, set()).update(
                    str(value) for value in occupied.values()
                )

    def find_cycle(node: str, path: list[str], completed: set[str]) -> set[str]:
        """深度优先返回等待图中的一组环节点；无环时返回空集。"""
        if node in path:
            return set(path[path.index(node):])
        if node in completed:
            return set()
        path.append(node)
        for target in dependency_edges.get(node, set()):
            cycle = find_cycle(target, path, completed)
            if cycle:
                return cycle
        path.pop()
        completed.add(node)
        return set()

    completed: set[str] = set()
    cycle_nodes = next((
        cycle
        for node in dependency_edges
        if (cycle := find_cycle(node, [], completed))
    ), set())
    if cycle_nodes:
        if any(
            str(pending_by_id.get(node, {}).get("Location") or "") in load_lock_names
            for node in cycle_nodes
        ):
            return {
                "Code": "DEADLOCK.LOADLOCK_DIRECTION_CYCLE",
                "Category": "loadlock-direction-cycle",
                "Message": "LoadLock 内外物料同时等待反向服务，当前压力方向与回程容量形成循环依赖。",
            }
        return {
            "Code": "DEADLOCK.RESOURCE_WAIT_CYCLE",
            "Category": "resource-wait-cycle",
            "Message": "多个晶圆的下一目标被彼此占用，形成满腔资源等待环。",
        }

    # LoadLock 的算法安全容量可能小于物理槽位，图中没有“物理满载”边时仍可确认方向环。
    if load_lock_names:
        leaves_load_lock = any(
            str(row.get("Location") or "") in load_lock_names
            and bool(string_set(row.get("NextStations")) - load_lock_names)
            for row in pending
        )
        enters_load_lock = any(
            str(row.get("Location") or "") not in load_lock_names
            and bool(string_set(row.get("NextStations")) & load_lock_names)
            for row in pending
        )
        if leaves_load_lock and enters_load_lock:
            return {
                "Code": "DEADLOCK.LOADLOCK_DIRECTION_CYCLE",
                "Category": "loadlock-direction-cycle",
                "Message": "LoadLock 内外物料同时等待反向服务，当前压力方向与回程容量形成循环依赖。",
            }
    return None


def _raise_deadlock_feedback(
    output: Mapping[str, Any],
    reproduction: ReproductionLog,
    *,
    sim_time: float = 0.0,
    context: str,
) -> None:
    """将算法死锁输出登记为可回放失败，而不是继续做完整计划校验。"""
    feedback = _deadlock_feedback(output)
    if feedback is None:
        return
    failure_output = _alg_output_info(output)
    diagnostic = deepcopy(dict(output.get("DeadlockDiagnostic") or {}))
    classification = _classify_deadlock_diagnostic(diagnostic)
    failure_output["FailureContext"] = {
        "Stage": "algorithm-deadlock",
        "Context": context,
        "Code": str((classification or feedback).get("Code") or "DEADLOCK.NO_EXECUTABLE_ACTION"),
        "Category": str((classification or feedback).get("Category") or "unknown"),
        "Message": str((classification or feedback).get("Message") or "算法规划进入死锁"),
        "Diagnostic": diagnostic,
    }
    reproduction.add(
        "AlgOutput",
        failure_output,
        sim_time,
        forward_to_validator=False,
    )
    raise LoggedPlanError(
        str(feedback.get("Message") or "算法规划进入死锁"),
        reproduction.entries,
        failure_output=failure_output,
    )


def _validation_issue_records(
    validation_issues: Sequence[Any],
) -> List[Dict[str, Any]]:
    """把带稳定错误码的校验文案转换成甘特图可定位记录。"""
    records: List[Dict[str, Any]] = []
    error_code_pattern = re.compile(
        r"^\[([A-Z0-9]+(?:(?:-|\.)[A-Z0-9_]+)+)\]"
    )
    move_id_pattern = re.compile(
        r"(?:\bMoveID\b|\bid\b)\s*[=:]\s*(-?\d+)",
        re.IGNORECASE,
    )
    for issue in validation_issues:
        message = str(issue)
        match = move_id_pattern.search(message)
        record: Dict[str, Any] = {"Message": message}
        error_code_match = error_code_pattern.match(message)
        if error_code_match is not None:
            record["Code"] = error_code_match.group(1)
        if match is not None:
            record["MoveID"] = int(match.group(1))
        records.append(record)
    return records


def _build_validation_gantt_output(
    algorithm_output: Mapping[str, Any],
    validation_issues: Sequence[Any],
    *,
    prefix_moves: Optional[Sequence[Mapping[str, Any]]] = None,
    recompute_points: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """生成包含错误 Move 标记的只读诊断甘特图数据。"""
    issue_records = _validation_issue_records(validation_issues)
    issues_by_move_id: Dict[int, List[str]] = {}
    for issue in issue_records:
        move_id = issue.get("MoveID")
        if isinstance(move_id, int):
            issues_by_move_id.setdefault(move_id, []).append(
                str(issue["Message"])
            )

    invalid_moves = deepcopy(list(algorithm_output.get("MoveList") or []))
    for move in invalid_moves:
        if not isinstance(move, dict):
            continue
        move_id = move.get("MoveID")
        if not isinstance(move_id, int) or move_id not in issues_by_move_id:
            continue
        move["ValidationFailed"] = True
        move["ValidationIssues"] = deepcopy(issues_by_move_id[move_id])

    combined_moves = [
        deepcopy(dict(move))
        for move in (prefix_moves or ())
        if isinstance(move, Mapping)
    ]
    combined_moves.extend(invalid_moves)
    combined_moves.sort(key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move.get("MoveID") or 0),
    ))
    output = _alg_output_info(algorithm_output)
    output["MoveList"] = combined_moves
    output["RecomputePoints"] = deepcopy(list(recompute_points or ()))
    output["Validation"] = {
        "Status": "failed",
        "Issues": issue_records,
        "InvalidMoveIDs": sorted(issues_by_move_id),
    }
    return output


def _schedule_log_info(device: Mapping[str, Any], update: Mapping[str, Any]) -> Dict[str, Any]:
    """把设备拓扑与一轮更新合成可单独回放的 AlgSchedule 输入。"""
    info = deepcopy(dict(update))
    info.setdefault("Robots", deepcopy(dict(device.get("Robots") or {})))
    info.setdefault("Stations", deepcopy(dict(device.get("Stations") or {})))
    return info


def _build_algorithm_recompute_update(
    runtime: StandardAlgorithmRuntime,
    new_round_update: Mapping[str, Any],
    requested_time: float,
    projected_state: MachineState,
    move_states: Sequence[Mapping[str, Any]] = (),
    previous_output: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """按原始重算时刻生成标准 update，并携带真实 Move 状态通知。"""
    update = merge_algorithm_update(
        runtime.current_update,
        new_round_update,
    )
    apply_machine_state_to_update(update, projected_state, requested_time)
    update["MoveStates"] = [
        deepcopy(dict(notification))
        for notification in move_states
    ]
    update["RemoveList"] = [
        int(move["MoveID"])
        for move in runtime.current_plan
        if isinstance(move.get("MoveID"), int)
        and float(move.get("StartTime") or 0.0)
        >= float(requested_time) - TIME_TOLERANCE
    ]
    if previous_output is not None:
        # 现场投影会重建 Material 字段；DummyReturnInfo 必须最后回填，避免刚恢复的
        # Route/PJobName/TaskID 又被状态机中上一份空值覆盖。
        restore_dummy_routes_from_algorithm_output(update, previous_output)
    return update


def _build_packaged_algorithm_recompute_update(
    runtime: PackagedAlgorithmRuntime,
    new_round_update: Mapping[str, Any],
    requested_time: float,
    move_states: Sequence[Mapping[str, Any]],
    projected_state: Optional[MachineState] = None,
    previous_output: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """用平台物理快照为算法包构造下一轮标准 update。"""
    update = merge_algorithm_update(
        runtime.current_update,
        new_round_update,
    )
    apply_machine_state_to_update(
        update,
        projected_state if projected_state is not None else runtime.state,
        requested_time,
    )
    update["MoveStates"] = [
        deepcopy(dict(notification))
        for notification in move_states
    ]
    _apply_packaged_running_resource_times(
        update,
        runtime.current_plan,
        requested_time,
        move_states,
    )
    update["RemoveList"] = [
        int(move["MoveID"])
        for move in runtime.current_plan
        if isinstance(move.get("MoveID"), int)
        and float(move.get("StartTime") or 0.0)
        >= float(requested_time) - TIME_TOLERANCE
    ]
    if previous_output is not None:
        # 与完整平台运行时保持同一协议边界：只在所有现场字段投影完成后消费
        # 算法返回的 Dummy 信息，确保发出的 AlgSchedule 保留恢复结果。
        restore_dummy_routes_from_algorithm_output(update, previous_output)
    return update


def _apply_packaged_running_resource_times(
    update: Dict[str, Any],
    moves: Sequence[Mapping[str, Any]],
    current_time: float,
    move_states: Sequence[Mapping[str, Any]],
) -> None:
    """把仍在运行的 Move 剩余时长写入算法包要求的资源快照。

    标准算法包会用 ``MoveStates`` 恢复动作语义，同时要求关联 Robot/Station
    的 ``TimeToAvailable`` 作为运行中动作结束时间证据。这里只写协议资源
    占用；物料和槽位状态由平台状态记录器统一提供。
    """
    started_ids = {
        int(item["MoveID"])
        for item in move_states
        if (
            isinstance(item.get("MoveID"), int)
            and item.get("MoveState") == MoveStateReplay.RUNNING
        )
    }
    finished_ids = {
        int(item["MoveID"])
        for item in move_states
        if (
            isinstance(item.get("MoveID"), int)
            and item.get("MoveState") == MoveStateReplay.DONE
        )
    }
    running_ids = started_ids - finished_ids
    if not running_ids:
        return

    robots = update.setdefault("Robots", {})
    stations = update.setdefault("Stations", {})
    for move in moves:
        move_id = move.get("MoveID")
        if move_id not in running_ids:
            continue
        remaining = max(
            0.0,
            float(move.get("EndTime") or current_time) - float(current_time),
        )
        module_name = str(move.get("ModuleName") or "")
        if module_name in robots and isinstance(robots[module_name], dict):
            robots[module_name]["TimeToAvailable"] = max(
                float(robots[module_name].get("TimeToAvailable") or 0.0),
                remaining,
            )

        station_slots: Dict[str, set[int]] = {}
        slot_groups = (
            ("SrcStationList", "SrcSlotList"),
            ("DestStationList", "DestSlotList"),
        )
        for station_key, slot_key in slot_groups:
            station_names = list(move.get(station_key) or [])
            slot_ids = list(move.get(slot_key) or [])
            for index, station_name in enumerate(station_names):
                slot_id = slot_ids[index] if index < len(slot_ids) else None
                if isinstance(slot_id, int):
                    station_slots.setdefault(str(station_name), set()).add(slot_id)
                else:
                    station_slots.setdefault(str(station_name), set())
        if module_name in stations:
            module_slots = {
                int(slot_id)
                for slot_id in (move.get("SlotList") or [])
                if isinstance(slot_id, int)
            }
            station_slots.setdefault(module_name, set()).update(module_slots)

        for station_name, slot_ids in station_slots.items():
            station = stations.get(station_name)
            if not isinstance(station, dict):
                continue
            slot_times = station.setdefault("TimeToAvailableOfSlot", {})
            if not slot_ids:
                slot_ids = {
                    int(slot_id)
                    for slot_id in slot_times
                    if str(slot_id).isdigit()
                }
            for slot_id in slot_ids:
                key = str(slot_id)
                slot_times[key] = max(
                    float(slot_times.get(key) or 0.0),
                    remaining,
                )


def _planned_event_groups(moves: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """把旧计划转换为按容差归并的事件组，完成事件在同刻新开始事件之前落地。"""
    groups: Dict[int, Dict[str, Any]] = {}
    for raw_move in moves:
        move = dict(raw_move)
        start = float(move.get("StartTime") or 0.0)
        end = float(move.get("EndTime") or start)
        move_id = int(move["MoveID"])
        start_bucket = int(round(start / TIME_TOLERANCE))
        end_bucket = int(round(end / TIME_TOLERANCE))
        start_group = groups.setdefault(start_bucket, {
            "time": start, "starts": [], "priorFinishes": [], "sameFinishes": [],
        })
        start_group["time"] = max(float(start_group["time"]), start)
        start_group["starts"].append((start, {
            "MoveID": move_id,
            "MoveState": MoveStateReplay.RUNNING,
            "StartTime": start,
            "EndTime": -1,
        }))
        end_group = groups.setdefault(end_bucket, {
            "time": end, "starts": [], "priorFinishes": [], "sameFinishes": [],
        })
        end_group["time"] = max(float(end_group["time"]), end)
        finish_key = "sameFinishes" if start_bucket == end_bucket else "priorFinishes"
        end_group[finish_key].append((end, {
            "MoveID": move_id,
            "MoveState": MoveStateReplay.DONE,
            "StartTime": start,
            "EndTime": end,
        }))
    ordered: List[Dict[str, Any]] = []
    for bucket in sorted(groups):
        group = groups[bucket]
        for key in ("starts", "priorFinishes", "sameFinishes"):
            group[key].sort(key=lambda item: (item[0], item[1]["MoveID"]))
        ordered.append(group)
    return ordered


def _planned_start_events(
    group: Mapping[str, Any],
) -> Iterator[Tuple[str, float, Dict[str, Any]]]:
    """按 MoveID 依次产生开始事件，并让零时长动作在下一动作开始前完成。"""
    same_finishes = {
        int(notification["MoveID"]): (event_time, notification)
        for event_time, notification in group["sameFinishes"]
    }
    for event_time, notification in group["starts"]:
        move_id = int(notification["MoveID"])
        yield "start", event_time, notification
        same_finish = same_finishes.pop(move_id, None)
        if same_finish is not None:
            yield "finish", same_finish[0], same_finish[1]
    for event_time, notification in group["sameFinishes"]:
        if int(notification["MoveID"]) in same_finishes:
            yield "finish", event_time, notification


def advance_packaged_algorithm_to_update(
    runtime: PackagedAlgorithmRuntime,
    cutoff: float,
) -> List[Dict[str, Any]]:
    """从 MoveList 时间线生成算法包重算所需的 Running/Done 通知。

    参数:
        runtime: 只保存标准协议事实的打包算法运行时。
        cutoff: 本轮原始重算时刻。

    返回:
        按计划事件顺序排列、严格发生在重算边界内的 MoveState 通知。
    """
    cutoff = max(float(cutoff), runtime.state_time)
    notifications: List[Dict[str, Any]] = []
    started: set[int] = set()
    finished: set[int] = set()
    for group in _planned_event_groups(runtime.current_plan):
        for event_time, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if (
                event_time <= cutoff + TIME_TOLERANCE
                and move_id in started
                and move_id not in finished
            ):
                notifications.append(deepcopy(notification))
                finished.add(move_id)
        for event_kind, event_time, notification in _planned_start_events(group):
            move_id = int(notification["MoveID"])
            if (
                event_kind == "start"
                and event_time < cutoff - TIME_TOLERANCE
                and move_id not in started
            ):
                notifications.append(deepcopy(notification))
                started.add(move_id)
            elif (
                event_kind == "finish"
                and event_time <= cutoff + TIME_TOLERANCE
                and move_id in started
                and move_id not in finished
            ):
                notifications.append(deepcopy(notification))
                finished.add(move_id)
    for notification in notifications:
        runtime.update_move_state(
            notification,
            snapshot=False,
            track_reservations=False,
        )
    runtime.advance_to(cutoff)
    running_ids = started - finished
    return [
        notification
        for notification in notifications
        if (
            notification.get("MoveState") == MoveStateReplay.RUNNING
            and int(notification["MoveID"]) in running_ids
        )
    ]


def _running_move_states(
    notifications: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """把完整执行通知压缩为标准算法包要求的当前 Running 集合。"""
    finished_ids = {
        int(notification["MoveID"])
        for notification in notifications
        if (
            isinstance(notification.get("MoveID"), int)
            and notification.get("MoveState") == MoveStateReplay.DONE
        )
    }
    return [
        deepcopy(dict(notification))
        for notification in notifications
        if (
            isinstance(notification.get("MoveID"), int)
            and notification.get("MoveState") == MoveStateReplay.RUNNING
            and int(notification["MoveID"]) not in finished_ids
        )
    ]


_RECOVERY_TRANSPORT_TYPES = frozenset({
    PICK_MOVE,
    PLACE_MOVE,
    SWAP_MOVE,
    PRE_TRANS_MOVE,
    PREPARE_MOVE,
    COMPLETE_MOVE,
})


def _move_material_ids(move: Mapping[str, Any]) -> set[int]:
    """返回普通搬运或 Swap 字段中引用的全部物料编号。"""
    material_ids: set[int] = set()
    for key in ("MatIDList", "RecvMatList", "SendMatList"):
        material_ids.update(
            int(value)
            for value in (move.get(key) or [])
            if isinstance(value, int)
        )
    return material_ids


def _move_accesses_station(move: Mapping[str, Any], station_name: str) -> bool:
    """判断一条取、放或换片 Move 是否访问指定站点。"""
    station_values = {
        str(move.get("Station") or ""),
        *(str(value) for value in (move.get("SrcStationList") or [])),
        *(str(value) for value in (move.get("DestStationList") or [])),
        *(str(value) for value in (move.get("StationList") or [])),
    }
    return station_name in station_values


def _following_close_id(
    moves: Sequence[Mapping[str, Any]],
    station_name: str,
    action_end: float,
) -> Optional[int]:
    """查找取放或换片结束后同站点的第一条关门 Move。"""
    candidates = [
        move for move in moves
        if move.get("MoveType") == COMPLETE_MOVE
        and str(move.get("Station") or move.get("ModuleName") or "") == station_name
        and float(move.get("StartTime") or 0.0) >= action_end - TIME_TOLERANCE
    ]
    if not candidates:
        return None
    return int(min(candidates, key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move["MoveID"]),
    ))["MoveID"])


def _transport_tail_ids(
    moves: Sequence[Mapping[str, Any]],
    material_id: int,
    cutoff: float,
    include_loadlock_environment: bool = False,
) -> set[int]:
    """返回在手机械手物料到下一次 Place 或 Swap 入站并关门的旧动作集合。"""
    terminal_actions = [
        move for move in moves
        if (
            (
                move.get("MoveType") == PLACE_MOVE
                and material_id in _move_material_ids(move)
            )
            or (
                move.get("MoveType") == SWAP_MOVE
                and material_id in {
                    int(value)
                    for value in (move.get("SendMatList") or [])
                    if isinstance(value, int)
                }
            )
        )
        and float(move.get("EndTime") or 0.0) > cutoff + TIME_TOLERANCE
    ]
    if not terminal_actions:
        raise ValueError(f"旧计划找不到 MatID={material_id} 的后续 Place 或 Swap 入站")
    terminal_action = min(terminal_actions, key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move["MoveID"]),
    ))
    if terminal_action.get("MoveType") == SWAP_MOVE:
        destination = str((terminal_action.get("StationList") or [""])[0])
    else:
        destination = str((terminal_action.get("DestStationList") or [""])[0])
    action_end = float(
        terminal_action.get("EndTime")
        or terminal_action.get("StartTime")
        or cutoff
    )
    close_id = _following_close_id(moves, destination, action_end)
    closure_end = action_end
    if close_id is not None:
        close_move = next(move for move in moves if int(move["MoveID"]) == close_id)
        closure_end = float(close_move.get("EndTime") or closure_end)
    # 晶圆放入 LoadLock 并关门后，带 MatID 的抽气/充气仍属于同一搬运收尾。
    # 若在这里停下，state.py 会正确保留 UNPROCESSED，但标准算法重算桥会把
    # 后续压力转换作为已承诺现场继续执行，下一代计划便会直接从另一侧开门。
    following_environment_moves = (
        [
            move
            for move in moves
            if move.get("MoveType") == PRE_PREPARE_MOVE
            and str(move.get("Station") or move.get("ModuleName") or "") == destination
            and material_id in _move_material_ids(move)
            and float(move.get("StartTime") or 0.0) >= closure_end - TIME_TOLERANCE
        ]
        if include_loadlock_environment
        else []
    )
    environment_move_id: Optional[int] = None
    if following_environment_moves:
        environment_move = min(following_environment_moves, key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move["MoveID"]),
        ))
        environment_move_id = int(environment_move["MoveID"])
        closure_end = max(
            closure_end,
            float(environment_move.get("EndTime") or closure_end),
        )

    required = {
        int(move["MoveID"])
        for move in moves
        if move.get("MoveType") in _RECOVERY_TRANSPORT_TYPES
        and material_id in _move_material_ids(move)
        and float(move.get("EndTime") or 0.0) > cutoff + TIME_TOLERANCE
        and float(move.get("StartTime") or 0.0) <= closure_end + TIME_TOLERANCE
    }
    # LoadLock 目标侧可能需要在 Place 前先做空抽/空充。它没有 MatID，不能仅靠
    # 晶圆字段命中，但属于该搬运链使目标门可访问的必要前置动作。
    place_prepare_start = min(
        (
            float(move.get("StartTime") or 0.0)
            for move in moves
            if move.get("MoveType") == PREPARE_MOVE
            and str(move.get("Station") or move.get("ModuleName") or "") == destination
            and material_id in _move_material_ids(move)
            and abs(
                float(move.get("EndTime") or 0.0)
                - float(terminal_action.get("StartTime") or 0.0)
            ) <= TIME_TOLERANCE
        ),
        default=action_end,
    )
    required.update(
        int(move["MoveID"])
        for move in moves
        if move.get("MoveType") == PRE_PREPARE_MOVE
        and str(move.get("Station") or move.get("ModuleName") or "") == destination
        and float(move.get("StartTime") or 0.0) >= cutoff - TIME_TOLERANCE
        and float(move.get("EndTime") or 0.0) <= place_prepare_start + TIME_TOLERANCE
    )
    # 旧计划可能在 Pick 前安排一条无 MatID 的空载转位。恢复链若只按晶圆
    # 筛选会漏掉它，导致 Robot 仍指向上一站点却直接 Pick。
    selected_picks = [
        move for move in moves
        if int(move["MoveID"]) in required and move.get("MoveType") == PICK_MOVE
    ]
    for pick in selected_picks:
        robot_name = str(pick.get("Robot") or pick.get("ModuleName") or "")
        pick_start = float(pick.get("StartTime") or 0.0)
        required.update(
            int(move["MoveID"])
            for move in moves
            if move.get("MoveType") == PRE_TRANS_MOVE
            and not _move_material_ids(move)
            and str(move.get("Robot") or move.get("ModuleName") or "") == robot_name
            and abs(float(move.get("EndTime") or 0.0) - pick_start) <= TIME_TOLERANCE
            and float(move.get("EndTime") or 0.0) > cutoff + TIME_TOLERANCE
        )
    if close_id is not None:
        required.add(close_id)
    if environment_move_id is not None:
        required.add(environment_move_id)
    return required


def _required_recovery_ids(
    scheduler: RealtimeRescheduler,
    moves: Sequence[Mapping[str, Any]],
    cutoff: float,
    include_loadlock_environment: bool = False,
) -> set[int]:
    """从请求时刻状态选择运行 Move 和必须完成的 Pick–Move–Place 收尾链。"""
    planned_by_id = {int(move["MoveID"]): move for move in moves}
    required = set(scheduler.running_move_ids)
    tail_materials: set[int] = set()
    running_swap_close_ids: set[int] = set()

    # 运行中的加工、清洁和抽充气只保留自身；搬运类动作还要把晶圆落到
    # 原计划下一目标。关门动作是否属于搬运中段由实时持片状态统一判断。
    for move_id in required:
        move = planned_by_id[move_id]
        move_type = move.get("MoveType")
        if move_type in {PREPARE_MOVE, PICK_MOVE, PLACE_MOVE, PRE_TRANS_MOVE}:
            tail_materials.update(_move_material_ids(move))
        elif move_type == SWAP_MOVE:
            tail_materials.update(
                int(value) for value in (move.get("RecvMatList") or []) if isinstance(value, int)
            )
            station_name = str(
                ((move.get("StationList") or [""])[0])
            )
            close_id = _following_close_id(
                moves,
                station_name,
                float(move.get("EndTime") or cutoff),
            )
            if close_id is not None:
                running_swap_close_ids.add(close_id)
    required.update(running_swap_close_ids)

    # 运行中的 SwapMove 在结束回调前，状态机仍把待放入的新片保留在 Robot 手槽。
    # 它实际上会在本次 swap 结束时进入 PM，不能被下面的“当前持片”扫描误判为
    # 还需沿旧计划继续运输；真正需要收尾的是 RecvMatList 中刚换出的旧片。
    running_swap_send_materials = {
        int(value)
        for move_id in required
        for value in (
            planned_by_id[move_id].get("SendMatList") or []
            if planned_by_id[move_id].get("MoveType") == SWAP_MOVE
            else []
        )
        if isinstance(value, int)
    }
    state = scheduler.state
    for robot in state.robots.values():
        tail_materials.update(
            int(material.material_id)
            for material in robot.hands.values()
            if (
                material is not None
                and isinstance(material.material_id, int)
                and int(material.material_id) not in running_swap_send_materials
            )
        )

    # 开门已完成但对应取放恰好从 cutoff 开始时，该 Move 尚未收到 Running。
    # 按用户口径继续原 Pick–Move–Place，而不是直接关回当前门。
    for station_name, station in state.stations.items():
        if station.door is DoorState.CLOSED:
            continue
        if any(
            _move_accesses_station(planned_by_id[move_id], station_name)
            for move_id in required
            if move_id in planned_by_id
        ):
            continue
        related = [
            move for move in moves
            if move.get("MoveType") in {PICK_MOVE, PLACE_MOVE, SWAP_MOVE}
            and float(move.get("StartTime") or 0.0) >= cutoff - TIME_TOLERANCE
            and _move_accesses_station(move, station_name)
        ]
        if not related:
            continue
        action = min(related, key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move["MoveID"]),
        ))
        required.add(int(action["MoveID"]))
        if action.get("MoveType") == SWAP_MOVE:
            tail_materials.update(
                int(value) for value in (action.get("RecvMatList") or []) if isinstance(value, int)
            )
            close_id = _following_close_id(
                moves,
                station_name,
                float(action.get("EndTime") or action.get("StartTime") or cutoff),
            )
            if close_id is not None:
                required.add(close_id)
        else:
            tail_materials.update(_move_material_ids(action))

    for material_id in tail_materials:
        required.update(_transport_tail_ids(
            moves,
            material_id,
            cutoff,
            include_loadlock_environment,
        ))
    return required


def advance_to_algorithm_update(
    runtime: StandardAlgorithmRuntime,
    cutoff: float,
    recorded_events: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """只回放到外部算法的原始重算时刻，不执行任何后续安全收尾。

    ``StartTime < cutoff`` 的动作会收到 Running；其中在 cutoff 前结束的动作
    同时收到 Done。仍在运行的动作保留在运行态，供投影快照计算资源剩余时间。
    ``StartTime >= cutoff`` 的动作完全不执行，随后统一进入 RemoveList。
    """
    cutoff = max(float(cutoff), runtime.state_time)
    planned_by_id = {
        int(move["MoveID"]): move
        for move in runtime.current_plan
    }
    started: set[int] = set()
    finished: set[int] = set()

    def apply_notification(notification: Mapping[str, Any]) -> None:
        """应用请求时刻前的一条真实通知，并按需写入复现日志。"""
        applied = dict(notification)
        move_id = int(applied["MoveID"])
        planned_move = planned_by_id[move_id]
        if (
            applied.get("MoveState") == MoveStateReplay.RUNNING
            and planned_move.get("MoveType") == PRE_TRANS_MOVE
            and not _move_material_ids(planned_move)
        ):
            robot_name = str(
                planned_move.get("Robot")
                or planned_move.get("ModuleName")
                or ""
            )
            robot_position = runtime.robot_position(robot_name)
            if robot_position:
                applied["SrcStationList"] = [robot_position]
        runtime.update_move_state(
            applied,
            snapshot=False,
            track_reservations=False,
        )
        if applied.get("MoveState") == MoveStateReplay.RUNNING:
            started.add(move_id)
        else:
            finished.add(move_id)
        if recorded_events is not None:
            recorded_events.append(deepcopy(applied))

    for group in _planned_event_groups(runtime.current_plan):
        for event_time, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if (
                event_time <= cutoff + TIME_TOLERANCE
                and move_id in started
                and move_id not in finished
            ):
                apply_notification(notification)
        for event_kind, event_time, notification in _planned_start_events(group):
            move_id = int(notification["MoveID"])
            if (
                event_kind == "start"
                and event_time < cutoff - TIME_TOLERANCE
                and move_id not in started
            ):
                apply_notification(notification)
            elif (
                event_kind == "finish"
                and event_time <= cutoff + TIME_TOLERANCE
                and move_id in started
                and move_id not in finished
            ):
                apply_notification(notification)


def advance_to_recompute(
    scheduler: RealtimeRescheduler,
    cutoff: float,
    recorded_events: Optional[List[Dict[str, Any]]] = None,
    *,
    include_loadlock_environment: bool = False,
) -> RecoveryProjection:
    """投影请求时刻状态，只执行运行 Move 和必要搬运收尾链。

    返回的 ``recovery_end`` 只是固定旧动作的最晚结束时间；新排程仍从 cutoff
    开始，并通过投影状态中的资源占用终点避免与这些旧动作冲突。
    """
    cutoff = max(float(cutoff), scheduler.state_time)
    moves = scheduler.current_plan
    groups = _planned_event_groups(moves)
    planned_by_id = {int(move["MoveID"]): move for move in moves}
    started: set[int] = set()
    finished: set[int] = set()
    material_ready_times: Dict[int, float] = {}

    def apply_notification(notification: Mapping[str, Any]) -> None:
        """发送一条计划通知，并同步维护执行集合、物料释放时间与复现日志。"""
        applied = dict(notification)
        move_id = int(applied["MoveID"])
        planned_move = planned_by_id[move_id]
        if (
            applied.get("MoveState") == MoveStateReplay.RUNNING
            and planned_move.get("MoveType") == PRE_TRANS_MOVE
            and not _move_material_ids(planned_move)
        ):
            robot_name = str(planned_move.get("Robot") or planned_move.get("ModuleName") or "")
            robot_position = scheduler.robot_position(robot_name)
            if robot_position:
                applied["SrcStationList"] = [robot_position]
        # 这里严格回放计划时间，不需要为每条通知复制整机状态，也不需要扫描所有
        # LoadPort 槽位记录“实际结束时间”修正字段。
        scheduler.update_move_state(
            applied,
            snapshot=False,
            track_reservations=False,
        )
        if applied.get("MoveState") == MoveStateReplay.RUNNING:
            started.add(move_id)
        else:
            finished.add(move_id)
            move = planned_by_id[move_id]
            end_time = float(applied.get("EndTime") or move.get("EndTime") or cutoff)
            for material_id in _move_material_ids(move):
                material_ready_times[material_id] = max(
                    material_ready_times.get(material_id, cutoff),
                    end_time,
                )
        if recorded_events is not None:
            recorded_events.append(deepcopy(applied))

    # 还原 t1：只启动严格早于请求时刻的 Move，同刻开始的动作由新调度取消。
    for group in groups:
        for event_time, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if event_time <= cutoff + TIME_TOLERANCE and move_id in started and move_id not in finished:
                apply_notification(notification)
        for event_kind, event_time, notification in _planned_start_events(group):
            move_id = int(notification["MoveID"])
            if (
                event_kind == "start"
                and event_time < cutoff - TIME_TOLERANCE
                and move_id not in started
            ):
                apply_notification(notification)
            elif (
                event_kind == "finish"
                and event_time <= cutoff + TIME_TOLERANCE
                and move_id in started
                and move_id not in finished
            ):
                apply_notification(notification)

    required = _required_recovery_ids(
        scheduler,
        moves,
        cutoff,
        include_loadlock_environment,
    )
    # 前一轮请求可能发生在更早一次恢复链结束之前。那条旧链已经进入历史、
    # 不再出现在 current_plan，但其动作仍是不可取消的物理承诺；本轮展示和
    # 下一段状态投影的 EffectiveTime 不能因此倒退。
    recovery_end = max(
        float(cutoff),
        float(scheduler.committed_recovery_end),
    )
    for group in groups:
        group_time = float(group["time"])
        if group_time < cutoff - TIME_TOLERANCE:
            continue
        for _, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if move_id in required and move_id in started and move_id not in finished:
                apply_notification(notification)
                recovery_end = max(recovery_end, group_time)
        for event_kind, _, notification in _planned_start_events(group):
            move_id = int(notification["MoveID"])
            if event_kind == "start" and move_id in required and move_id not in started:
                apply_notification(notification)
            elif (
                event_kind == "finish"
                and move_id in required
                and move_id in started
                and move_id not in finished
            ):
                apply_notification(notification)
                recovery_end = max(recovery_end, group_time)
        if required.issubset(finished):
            break

    if not required.issubset(finished) or not scheduler.can_recompute:
        open_doors = [
            name for name, station in scheduler.state.stations.items()
            if station.door is not DoorState.CLOSED
        ]
        held = [
            f"{robot.name}#{slot_id}"
            for robot in scheduler.state.robots.values()
            for slot_id, material in robot.hands.items()
            if material is not None
        ]
        running = sorted(scheduler.running_move_ids)
        missing = sorted(required - finished)
        raise ValueError(
            f"旧计划无法完成最小重算收尾：未完成={missing[:8]}，运行={running}，"
            f"开门={open_doors}，机械手持片={held}"
        )
    return RecoveryProjection(recovery_end, material_ready_times)


def _segment_end(moves: Iterable[Mapping[str, Any]]) -> float:
    """返回一组 Move 的最大结束时刻。"""
    return max((float(move.get("EndTime") or 0.0) for move in moves), default=0.0)


def _build_recompute_failure_output(
    runtime: Any,
    update: Mapping[str, Any],
    requested_time: float,
    reason: str,
    error: Exception,
) -> Dict[str, Any]:
    """构造重算调用失败时仍可查看的已保留计划。

    第二轮算法尚未返回新的 MoveList 时，当前代计划仍是上一轮算法的输出。
    本轮 ``RemoveList`` 已明确取消其中哪些未启动 Move；因此甘特图只能保留
    不在该列表中的旧 Move，不能把已取消的计划误展示为仍会执行。历史代次
    Move 必须全部保留；若其 MoveID 恰好与当前代被取消的 Move 复用，它也会
    被浅色标记，但不会从列表中删除。
    """
    removed_move_ids = {
        int(move_id)
        for move_id in (update.get("RemoveList") or [])
        if isinstance(move_id, int) and not isinstance(move_id, bool)
    }
    active_move_ids = {
        int(move["MoveID"])
        for move in runtime.current_plan
        if isinstance(move, Mapping)
        and isinstance(move.get("MoveID"), int)
        and not isinstance(move.get("MoveID"), bool)
    }
    output = runtime.combined_output()
    preserved_moves: List[Dict[str, Any]] = []
    for raw_move in output.get("MoveList") or []:
        if not isinstance(raw_move, Mapping):
            continue
        move = deepcopy(dict(raw_move))
        move_id = move.get("MoveID")
        if (
            isinstance(move_id, int)
            and not isinstance(move_id, bool)
            and move_id in active_move_ids
            and move_id in removed_move_ids
        ):
            # 取消的旧动作同样是失败现场的一部分。前端将其浅色绘制，
            # 并允许用户按需隐藏，避免误认为它仍属于可执行计划。
            move["RemovedByRecompute"] = True
        preserved_moves.append(move)
    output["MoveList"] = preserved_moves
    output["RecomputePoints"] = [
        *deepcopy(list(output.get("RecomputePoints") or [])),
        {
            "Time": float(requested_time),
            "EffectiveTime": float(requested_time),
            "ScheduleStartTime": float(requested_time),
            "RecoveryEndTime": float(requested_time),
            "Index": len(list(output.get("RecomputePoints") or [])) + 1,
            "Reason": reason,
            "Status": "algorithm-error",
        },
    ]
    output["Feedback"] = [
        *deepcopy(list(output.get("Feedback") or [])),
        {
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error) or type(error).__name__,
        },
    ]
    return output


def _build_prior_plan_failure_output(
    reproduction_entries: Sequence[Mapping[str, Any]],
    error: Exception,
) -> Optional[Dict[str, Any]]:
    """从复现日志恢复异常发生前的累计可回放计划。

    CJobCycle 或定时重算可能在旧计划推进、现场投影、update 构造阶段失败，
    此时还没有进入算法调用，也就没有常规重算失败快照。只要此前已有非空
    AlgOutput，就按后续 AlgSchedule 的绝对时刻提交各旧代已经启动的 Move，
    再拼接最后一代完整计划。这样即使跳过输出校验后在下一轮现场回放失败，
    诊断甘特图也不会丢失重算前缀；尚未发送的 RemoveList 不会被误标为已经
    取消。
    """
    generation_time = 0.0
    generation_outputs: List[Tuple[float, Mapping[str, Any]]] = []
    recompute_points: List[Dict[str, Any]] = []
    for entry in reproduction_entries:
        describe = str(entry.get("Describe") or "")
        if describe == "AlgSchedule":
            generation_time = float(entry.get("SimTime") or 0.0)
            continue
        if describe == "RecomputeControl":
            info = entry.get("Info")
            recompute_info = (
                info.get("RecomputeInfo")
                if isinstance(info, Mapping)
                and isinstance(info.get("RecomputeInfo"), Mapping)
                else {}
            )
            point_time = float(
                recompute_info.get("CurrentTime")
                or entry.get("SimTime")
                or 0.0
            )
            recompute_points.append({
                "Time": point_time,
                "EffectiveTime": float(
                    recompute_info.get("EffectiveTime") or point_time
                ),
                "ScheduleStartTime": point_time,
                "RecoveryEndTime": point_time,
                "Index": len(recompute_points) + 1,
                "Reason": str(recompute_info.get("Reason") or "重算"),
            })
            continue
        if describe != "AlgOutput":
            continue
        info = entry.get("Info")
        if isinstance(info, Mapping) and list(info.get("MoveList") or []):
            generation_outputs.append((generation_time, info))
    if not generation_outputs:
        return None

    latest_output = generation_outputs[-1][1]
    combined_moves: List[Dict[str, Any]] = []
    for index, (_schedule_time, generation_output) in enumerate(generation_outputs):
        moves = generation_output.get("MoveList") or []
        if index + 1 < len(generation_outputs):
            next_schedule_time = generation_outputs[index + 1][0]
            moves = [
                move
                for move in moves
                if isinstance(move, Mapping)
                and float(move.get("StartTime") or 0.0)
                < next_schedule_time - TIME_TOLERANCE
            ]
        combined_moves.extend(
            deepcopy(dict(move))
            for move in moves
            if isinstance(move, Mapping)
        )
    combined_moves.sort(key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move.get("MoveID") or 0),
    ))

    output = deepcopy(dict(latest_output))
    output["MoveList"] = combined_moves
    output["RecomputePoints"] = recompute_points
    output["Feedback"] = [
        *deepcopy(list(latest_output.get("Feedback") or [])),
        {
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error) or type(error).__name__,
        },
    ]
    output["FailureContext"] = {
        "Stage": "after-algorithm-output",
        "Message": str(error) or type(error).__name__,
    }
    return output


def _release_finished_load_ports(
    runtime: Any,
    build_state: BuildState,
    load_port_names: Optional[Sequence[str]] = None,
) -> Tuple[set[Any], set[str]]:
    """在新一轮装片前卸载指定范围的成品并重置已清空槽位计数。

    ``load_port_names`` 为空时检查当前计划使用的全部 LoadPort；CJobCycle
    事件应显式传入本次已经整盒完工的端口，避免一次重算提前清空其他循环。
    """
    requested_load_ports = tuple(
        load_port_names
        if load_port_names is not None
        else build_state.next_slot_by_port
    )
    released_ids, empty_ports = runtime.release_completed_load_ports(
        requested_load_ports,
    )
    for load_port_name in empty_ports:
        build_state.next_slot_by_port[load_port_name] = 0
    return released_ids, empty_ports


@dataclass
class CJobCycleRuntime:
    """记录一个固定 LoadPort CJob 当前运行到第几盒。"""

    template: Dict[str, Any]
    load_port: str
    total_cycles: int
    current_cycle: int
    current_task_id: str
    configured_round: int


def _cjob_cycle_product_material_ids(
    update_params: Mapping[str, Any],
    task_id: str,
    load_port: str,
) -> set[Any]:
    """返回一个 CJobCycle 当前盒的产品晶圆编号。

    ProcessJob.MatList 是 CJob 产品成员的权威集合，DummyReturnInfo 临时写入
    Dummy 的 TaskID 不会改变该集合。兼容缺少 ProcessJobs 的旧测试或外部快照
    时，才按 TaskID 与 SrcPortName 的组合从 Materials 回退识别。
    """
    matching_process_jobs = [
        process_job
        for process_job in update_params.get("ProcessJobs") or []
        if (
            isinstance(process_job, Mapping)
            and str(process_job.get("TaskID") or "") == str(task_id)
        )
    ]
    if matching_process_jobs:
        return {
            material_id
            for process_job in matching_process_jobs
            for material_id in (process_job.get("MatList") or [])
            if material_id is not None
        }
    return {
        material.get("ID", material.get("Name"))
        for material in update_params.get("Materials") or []
        if (
            isinstance(material, Mapping)
            and str(material.get("TaskID") or "") == str(task_id)
            and str(material.get("SrcPortName") or "") in {"", str(load_port)}
            and material.get("ID", material.get("Name")) is not None
        )
    }


def _completed_cycle_material_ids(
    update_params: Mapping[str, Any],
    completed_cycles: Sequence[CJobCycleRuntime],
) -> set[Any]:
    """返回已完成循环中应从真实 LoadPort 卸载的产品物料编号。

    DummyReturnInfo 会把清洁片临时绑定到产品 TaskID，但其物理来源仍是
    DummyPort。CJobCycle 完成只能卸载对应 TaskID 且 SrcPortName 与该循环
    LoadPort 一致的产品片，不能按 TaskID 连带删除可复用 Dummy 库存。
    """
    material_ids: set[Any] = set()
    for cycle_state in completed_cycles:
        material_ids.update(_cjob_cycle_product_material_ids(
            update_params,
            cycle_state.current_task_id,
            cycle_state.load_port,
        ))
    return material_ids


def _cjob_cycle_count(cjob: Mapping[str, Any]) -> int:
    """读取并校验 CJob 的总循环数；旧数据默认只运行一盒。"""
    raw_value = cjob.get(
        "cjobCycle",
        cjob.get("CJobCycle", cjob.get("jobCycle", cjob.get("JobCycle", 1))),
    )
    if isinstance(raw_value, bool):
        raise ValueError("CJobCycle 必须是整数")
    try:
        numeric = float(raw_value)
    except (TypeError, ValueError):
        raise ValueError("CJobCycle 必须是整数") from None
    if not math.isfinite(numeric):
        raise ValueError("CJobCycle 必须是有限整数")
    cycle_count = int(numeric)
    if abs(numeric - cycle_count) > TIME_TOLERANCE:
        raise ValueError("CJobCycle 必须是整数")
    if cycle_count < 1 or cycle_count > MAX_CJOB_CYCLE:
        raise ValueError(f"CJobCycle 必须为 1~{MAX_CJOB_CYCLE}")
    return cycle_count


def _cjob_load_port_name(cjob: Mapping[str, Any]) -> str:
    """读取 CJob 固定占用的 LoadPort，并兼容旧版 PJob 字段。"""
    configured = str(cjob.get("loadPort") or cjob.get("LoadPort") or "").strip()
    if configured:
        return configured
    pjobs = [row for row in (cjob.get("pjobs") or []) if isinstance(row, Mapping)]
    return str(
        (pjobs[0].get("loadPort") or pjobs[0].get("LoadPort") or "")
        if pjobs
        else ""
    ).strip()


def _cycle_task_id(base_task_id: str, cycle_index: int) -> str:
    """为补片循环生成稳定且不与普通轮次冲突的 TaskID。"""
    return base_task_id if cycle_index == 1 else f"{base_task_id}-CYCLE-{cycle_index}"


def _cycle_cjob(cjob: Mapping[str, Any], cycle_index: int) -> Dict[str, Any]:
    """复制一个 CJob 作为指定循环的独立标准 ControlJob。"""
    cloned = deepcopy(dict(cjob))
    base_task_id = str(cjob.get("taskId") or cjob.get("TaskID") or "").strip()
    if not base_task_id:
        raise ValueError("启用 CJobCycle 的 CJob 必须包含 TaskID")
    load_port = _cjob_load_port_name(cjob)
    if not load_port:
        raise ValueError(f"CJob TaskID={base_task_id} 必须选择 LoadPort")
    cloned["taskId"] = _cycle_task_id(base_task_id, cycle_index)
    cloned["loadPort"] = load_port
    cloned["cjobCycle"] = 1
    cloned["pjobs"] = [
        {**deepcopy(dict(pjob)), "loadPort": load_port}
        for pjob in (cjob.get("pjobs") or [])
        if isinstance(pjob, Mapping)
    ]
    return cloned


def _cycle_states_for_round(
    round_config: Mapping[str, Any],
    configured_round: int,
) -> List[CJobCycleRuntime]:
    """为一轮中需要补片的 CJob 建立运行状态。"""
    states: List[CJobCycleRuntime] = []
    for cjob in _round_cjob_rows(round_config):
        total_cycles = _cjob_cycle_count(cjob)
        if total_cycles <= 1:
            continue
        base_task_id = str(cjob.get("taskId") or cjob.get("TaskID") or "").strip()
        load_port = _cjob_load_port_name(cjob)
        if not base_task_id:
            raise ValueError("启用 CJobCycle 的 CJob 必须包含 TaskID")
        if not load_port:
            raise ValueError(f"CJob TaskID={base_task_id} 必须选择 LoadPort")
        states.append(CJobCycleRuntime(
            template=deepcopy(cjob),
            load_port=load_port,
            total_cycles=total_cycles,
            current_cycle=1,
            current_task_id=base_task_id,
            configured_round=configured_round,
        ))
    return states


def _material_finished_cjob_cycle(
    material: Mapping[str, Any],
    load_port: str,
) -> bool:
    """判断重算快照中的物料是否已经走到指定 LoadPort 的 Route 终点。"""
    current_module = str(material.get("CurrentModuleName") or "").strip()
    if current_module != load_port:
        return False
    current_step_id = material.get("StepID")
    if current_step_id is None:
        return False
    route = material.get("Route")
    route_steps = route.get("RouteSteps") if isinstance(route, Mapping) else []
    for step in route_steps or []:
        if (
            not isinstance(step, Mapping)
            or step.get("StepID") is None
            or str(step.get("StepID")) != str(current_step_id)
        ):
            continue
        if step.get("PostStepID"):
            return False
        terminal_stations = {
            str(visit.get("StationName") or "").strip()
            for visit in (step.get("Visits") or [])
            if isinstance(visit, Mapping)
        }
        return load_port in terminal_stations
    return False


def _cjob_cycle_completion_time(
    runtime: Any,
    cycle_state: CJobCycleRuntime,
) -> Optional[float]:
    """结合重算快照与当前代 MoveList 求出整盒晶圆返回后的最晚时刻。"""
    material_ids = _cjob_cycle_product_material_ids(
        runtime.current_update,
        cycle_state.current_task_id,
        cycle_state.load_port,
    )
    if not material_ids:
        return None
    materials = [
        material
        for material in (runtime.current_update.get("Materials") or [])
        if (
            isinstance(material, Mapping)
            and material.get("ID", material.get("Name")) in material_ids
        )
    ]
    # 其他 CJob 的完工事件可能已经触发过重算。此时本 CJob 先完成的晶圆仍在
    # current_update 的终点槽中，但不会再次出现在新一代 MoveList；它们应按
    # 当前状态时刻计为已完成，只让尚未回片的晶圆决定未来完工边界。
    latest_by_material: Dict[Any, float] = {}
    for material in materials:
        material_id = material.get("ID", material.get("Name"))
        if (
            material_id is not None
            and _material_finished_cjob_cycle(material, cycle_state.load_port)
        ):
            latest_by_material[material_id] = runtime.state_time
    for move in runtime.current_plan:
        end_time = _finite_number(
            move.get("EndTime"),
            _finite_number(move.get("StartTime"), runtime.state_time),
        )
        for material_id in _move_material_ids(move):
            if material_id in material_ids:
                latest_by_material[material_id] = max(
                    latest_by_material.get(material_id, runtime.state_time),
                    end_time,
                )
    if material_ids - set(latest_by_material):
        return None
    # 普通定时重算会取消恰好在 cutoff 启动的动作；补片事件则必须先消费同刻的
    # 零时长回片/完成动作。仅跨过状态机容差边界，不引入业务上的装卸时间。
    return (
        max(latest_by_material.values())
        + TIME_TOLERANCE * CJOB_CYCLE_EVENT_EPSILON_MULTIPLIER
    )


def _execute_standard_algorithm(
    plan: Mapping[str, Any],
    first_update: Mapping[str, Any],
    rounds: Sequence[Mapping[str, Any]],
    times: Sequence[float],
    build_state: BuildState,
    reproduction: ReproductionLog,
    started: float,
    algorithm_id: Optional[str] = None,
    *,
    builtin_strategy: Optional[str] = None,
    skip_validation: bool = False,
) -> Dict[str, Any]:
    """通过同一次标准 ``init/update`` 会话执行首排和多次实时重算。

    ``algorithm_id`` 选择 ``other_alg`` 包；``builtin_strategy`` 选择当前
    仓库内置算法。两者互斥，但共用完全相同的企业接口数据流。
    """
    if (algorithm_id is None) == (builtin_strategy is None):
        raise ValueError("标准算法执行必须且只能选择一种算法来源")
    use_hongye_validation = (
        not skip_validation and bool(plan.get("hongYeCheck", True))
    )
    skip_platform_validation = skip_validation or use_hongye_validation
    round_count = len(rounds)
    if builtin_strategy is not None:
        if not BUILTIN_ALGORITHM_AVAILABLE:
            detail = (
                f"（{BUILTIN_ALGORITHM_IMPORT_ERROR}）"
                if BUILTIN_ALGORITHM_IMPORT_ERROR
                else ""
            )
            raise RuntimeError(
                "当前部署未提供本地算法仓库，内置策略不可用"
                f"{detail}；请选择已安装的 other_alg 标准算法"
            )
        strategy = builtin_strategy
        backend = "src.api"
        display_name = builtin_strategy
        entry_name = "src.api.init/update"
        session_context = builtin_algorithm_session()

        def initialize(payload: Mapping[str, Any]) -> None:
            """通过公开 JSON 入口初始化内置算法。"""
            builtin_algorithm_api.init(
                json.dumps(dict(payload), ensure_ascii=False)
            )

        def run_update(payload: Mapping[str, Any]) -> Dict[str, Any]:
            """通过公开 JSON 入口执行内置算法并解析标准输出。"""
            raw_output = builtin_algorithm_api.update(
                json.dumps(dict(payload), ensure_ascii=False),
                builtin_strategy,
            )
            parsed = json.loads(raw_output)
            if not isinstance(parsed, dict):
                raise RuntimeError("内置算法 update 返回值不是 JSON 对象")
            if isinstance(parsed.get("Info"), dict):
                parsed = dict(parsed["Info"])
            return dict(parsed)

        prepared_first_update = deepcopy(dict(first_update))
        options = plan.get("options")
        if isinstance(options, Mapping):
            prepared_first_update["AlgorithmOptions"] = deepcopy(dict(options))
    else:
        strategy = f"other_alg:{algorithm_id}"
        backend = f"other_alg/{algorithm_id}"
        display_name = str(algorithm_id)
        discovered_entry = next(
            (
                item for item in discover_other_algorithms()
                if str(item.get("id") or "").casefold() == str(algorithm_id).casefold()
            ),
            None,
        )
        entry_name = (
            f"{str(discovered_entry.get('entry') or 'scheduler.py')} init/update"
            if discovered_entry is not None
            else "CT.infer.scheduler.init/update"
        )
        session_context = algorithm_session(str(algorithm_id))
        initialize = algorithm_init
        run_update = algorithm_update
        prepared_first_update = deepcopy(dict(first_update))

    summaries: List[Dict[str, Any]] = []
    update_snapshots: List[Dict[str, Any]] = [deepcopy(prepared_first_update)]
    logs = [
        f"设备：{plan.get('deviceName') or 'selected init'}",
        f"策略：{strategy}；调用：{entry_name}；总轮数：{round_count}",
    ]
    with session_context:
        round_started = time.perf_counter()
        _raise_if_single_run_cancelled()
        _report_run_event("init", "init", "running")
        try:
            initialize(plan["device"])
            _raise_if_single_run_cancelled()
        except Exception as error:
            _report_run_event("init", "init", "failed", str(error))
            raise
        _report_run_event("init", "init", "succeeded")
        _report_run_event("update-1", "update #1", "running")
        try:
            raw_output = run_update(prepared_first_update)
            _raise_if_single_run_cancelled()
        except Exception as error:
            _report_run_event("update-1", "update #1", "failed", str(error))
            raise
        _report_run_event("update-1", "update #1", "succeeded")
        elapsed_ms = (time.perf_counter() - round_started) * 1000.0
        output = _alg_output_info(raw_output)
        _report_run_event("output-1", "收到 output #1", "succeeded")
        _raise_deadlock_feedback(
            output,
            reproduction,
            context="initial",
        )
        _report_run_event("validation-1", "校验 output #1", "running")
        try:
            _ensure_algorithm_output(output, prepared_first_update)
        except Exception as error:
            _report_run_event("validation-1", "校验 output #1", "failed", str(error))
            raise
        uses_full_platform_runtime = BUILTIN_ALGORITHM_AVAILABLE
        runtime: Any
        try:
            if uses_full_platform_runtime:
                runtime = StandardAlgorithmRuntime(
                    plan["device"],
                    prepared_first_update,
                    output,
                    skip_validation=skip_platform_validation,
                )
                state_source = "realtime_scheduler.move_validation.MachineState"
            else:
                runtime = PackagedAlgorithmRuntime(
                    prepared_first_update,
                    output,
                    skip_validation=skip_platform_validation,
                )
                state_source = "realtime_scheduler.move_validation.MachineState"
        except Exception as error:
            _report_run_event("validation-1", "校验 output #1", "failed", str(error))
            raise
        _report_run_event(
            "validation-1",
            "校验 output #1" if not skip_validation else "跳过校验 output #1",
            "succeeded" if not skip_validation else "skipped",
        )
        reproduction.add("AlgOutput", output)
        summaries.append({
            "index": 1,
            "kind": "initial",
            "requestedTime": 0.0,
            "effectiveTime": 0.0,
            "scheduleStartTime": 0.0,
            "recoveryEndTime": 0.0,
            "jobCount": _round_pjob_count(rounds[0]),
            "elapsedMs": elapsed_ms,
            "segmentEnd": _segment_end(output["MoveList"]),
            "strategyDiagnostics": {
                "backend": backend,
                "entry": entry_name,
                "feedbackCount": len(output["Feedback"]),
                "removedMoveCount": 0,
                "stateSource": state_source,
                **(
                    builtin_strategy_diagnostics()
                    if builtin_strategy is not None
                    else {}
                ),
            },
        })
        logs.append(
            f"[1/{round_count}] {display_name} 首排完成："
            f"{elapsed_ms:.1f} ms，{len(output['MoveList'])} Moves"
        )

        active_cycles = _cycle_states_for_round(rounds[0], 1)

        def execute_recompute_event(
            round_config: Mapping[str, Any],
            requested_time: float,
            reason: str,
            trigger: str,
            configured_round: Optional[int] = None,
            completed_cycles: Sequence[CJobCycleRuntime] = (),
        ) -> Tuple[set[Any], set[str]]:
            """执行一次定时或补片重算，并更新当前算法代次。"""
            nonlocal output
            if uses_full_platform_runtime:
                notifications: List[Dict[str, Any]] = []
                advance_to_algorithm_update(
                    runtime,
                    requested_time,
                    notifications,
                )
            else:
                notifications = advance_packaged_algorithm_to_update(
                    runtime,
                    requested_time,
                )
            cycle_material_ids = (
                _completed_cycle_material_ids(
                    runtime.current_update,
                    completed_cycles,
                )
                if completed_cycles
                else set()
            )
            cycle_load_ports = (
                tuple(cycle_state.load_port for cycle_state in completed_cycles)
                if completed_cycles
                else None
            )
            released_ids, empty_ports = _release_finished_load_ports(
                runtime,
                build_state,
                cycle_load_ports,
            )
            if completed_cycles:
                # CJobCycle 的触发时刻已经由“该 TaskID 全部物料的最后一个 Move
                # 结束”推导得到。这里按 TaskID + 固定 LoadPort 明确卸载整盒，
                # 避免部分算法没有把回 LP 动作标成 sink stage 时，通用终点识别
                # 无法裁剪旧 CJob；同 TaskID 的 DummyPort 清洁库存必须保留。
                released_ids.update(cycle_material_ids)
                _remove_released_materials_from_update(
                    runtime.current_update,
                    cycle_material_ids,
                )
                if hasattr(runtime, "problem"):
                    runtime.problem.wafers = [
                        wafer for wafer in runtime.problem.wafers
                        if getattr(wafer, "mat_id", None) not in cycle_material_ids
                    ]
                for cycle_state in completed_cycles:
                    empty_ports.add(cycle_state.load_port)
                    build_state.next_slot_by_port[cycle_state.load_port] = 0
            projected_state, committed_moves = runtime.project_started_moves(
                requested_time,
                released_ids,
            )
            for notification in notifications:
                event_time = (
                    notification.get("EndTime")
                    if notification.get("MoveState") == MoveStateReplay.DONE
                    else notification.get("StartTime")
                )
                reproduction.add(
                    "AlgUpdateMove",
                    notification,
                    _finite_number(event_time, requested_time),
                )
            recompute_index = len(summaries) + 1
            reproduction.add("RecomputeControl", {
                "ControlInfo": {
                    "Round": recompute_index,
                    "ConfiguredRound": configured_round,
                    "Trigger": trigger,
                },
                "RecomputeInfo": {
                    "CurrentTime": requested_time,
                    "EffectiveTime": requested_time,
                    "Reason": reason,
                },
            }, requested_time)

            new_round_update = build_round_update(
                plan,
                round_config,
                requested_time,
                build_state,
            )
            if uses_full_platform_runtime:
                reused_slot_material_ids = release_reused_source_slots(
                    projected_state,
                    new_round_update,
                )
                if reused_slot_material_ids:
                    released_ids.update(reused_slot_material_ids)
                    _remove_released_materials_from_update(
                        runtime.current_update,
                        reused_slot_material_ids,
                    )
                protocol_move_states = (
                    notifications
                    if builtin_strategy is not None
                    else _running_move_states(notifications)
                )
                update = _build_algorithm_recompute_update(
                    runtime,
                    new_round_update,
                    requested_time,
                    projected_state,
                    protocol_move_states,
                    output,
                )
            else:
                update = _build_packaged_algorithm_recompute_update(
                    runtime,
                    new_round_update,
                    requested_time,
                    notifications,
                    projected_state=projected_state,
                    previous_output=output,
                )
            update_snapshots.append(deepcopy(update))
            reproduction.add(
                "AlgSchedule",
                _schedule_log_info(plan["device"], update),
                requested_time,
            )
            round_started = time.perf_counter()
            _raise_if_single_run_cancelled()
            _report_run_event(
                f"update-{recompute_index}",
                f"update #{recompute_index}",
                "running",
            )
            try:
                raw_output = run_update(update)
                _raise_if_single_run_cancelled()
            except Exception as error:  # noqa: BLE001
                _report_run_event(
                    f"update-{recompute_index}",
                    f"update #{recompute_index}",
                    "failed",
                    str(error),
                )
                cancelled_error_type = globals().get("SearchCancelledError")
                if (
                    isinstance(error, UserRunCancelledError)
                    or cancelled_error_type is not None
                    and isinstance(error, cancelled_error_type)
                ):
                    # 用户主动取消属于预期终止，不得伪装成算法失败快照。
                    raise
                failure_output = _build_recompute_failure_output(
                    runtime,
                    update,
                    requested_time,
                    reason,
                    error,
                )
                reproduction.add("AlgOutput", failure_output, requested_time)
                raise LoggedPlanError(
                    f"{reason} 算法执行失败：{str(error) or type(error).__name__}",
                    reproduction.entries,
                    failure_output=failure_output,
                ) from error
            _report_run_event(
                f"update-{recompute_index}",
                f"update #{recompute_index}",
                "succeeded",
            )
            elapsed_ms = (time.perf_counter() - round_started) * 1000.0
            output = _alg_output_info(raw_output)
            _report_run_event(
                f"output-{recompute_index}",
                f"收到 output #{recompute_index}",
                "succeeded",
            )
            _raise_deadlock_feedback(
                output,
                reproduction,
                sim_time=requested_time,
                context=reason,
            )
            _report_run_event(
                f"validation-{recompute_index}",
                f"校验 output #{recompute_index}",
                "running",
            )
            try:
                _ensure_algorithm_output(output, update)
                if uses_full_platform_runtime:
                    runtime.replace_plan(
                        update,
                        output,
                        requested_time,
                        requested_time,
                        reason,
                        initial_state=projected_state,
                        committed_moves=committed_moves,
                        compile_for_validation=builtin_strategy is not None,
                    )
                else:
                    runtime.replace_plan(
                        update,
                        output,
                        requested_time,
                        reason,
                        committed_moves,
                        initial_state=projected_state,
                    )
            except Exception as error:
                _report_run_event(
                    f"validation-{recompute_index}",
                    f"校验 output #{recompute_index}",
                    "failed",
                    str(error),
                )
                raise
            _report_run_event(
                f"validation-{recompute_index}",
                (
                    f"校验 output #{recompute_index}"
                    if not skip_validation
                    else f"跳过校验 output #{recompute_index}"
                ),
                "succeeded" if not skip_validation else "skipped",
            )
            reproduction.add("AlgOutput", output, requested_time)
            summaries.append({
                "index": recompute_index,
                "kind": "recompute",
                "trigger": trigger,
                "configuredRound": configured_round,
                "requestedTime": requested_time,
                "effectiveTime": requested_time,
                "scheduleStartTime": requested_time,
                "recoveryEndTime": requested_time,
                "jobCount": _round_pjob_count(round_config),
                "elapsedMs": elapsed_ms,
                "segmentEnd": _segment_end(output["MoveList"]),
                "strategyDiagnostics": {
                    "backend": backend,
                    "entry": entry_name,
                    "feedbackCount": len(output["Feedback"]),
                    "removedMoveCount": len(update["RemoveList"]),
                    "moveStateCount": len(update["MoveStates"]),
                    "stateSource": state_source,
                    **(
                        builtin_strategy_diagnostics()
                        if builtin_strategy is not None
                        else {}
                    ),
                },
            })
            logs.append(
                f"[重算 {recompute_index - 1}] @{requested_time:.2f}s {display_name} {reason}："
                f"{elapsed_ms:.1f} ms，移除 {len(update['RemoveList'])} 个旧 Move"
            )
            if released_ids:
                logs.append(
                    f"  已卸载 {len(released_ids)} 片成品；"
                    f"清空 LoadPort={','.join(sorted(empty_ports)) or '无'}"
                )
            return released_ids, empty_ports

        next_configured_round = 1
        while True:
            next_timed_time = (
                float(times[next_configured_round])
                if next_configured_round < round_count
                else math.inf
            )
            cycle_times = [
                (completion_time, cycle_state)
                for cycle_state in active_cycles
                if cycle_state.current_cycle < cycle_state.total_cycles
                for completion_time in [_cjob_cycle_completion_time(runtime, cycle_state)]
                if completion_time is not None
            ]
            next_cycle_time = min(
                (completion_time for completion_time, _state in cycle_times),
                default=math.inf,
            )
            if math.isinf(next_timed_time) and math.isinf(next_cycle_time):
                unresolved_cycles = [
                    state for state in active_cycles
                    if state.current_cycle < state.total_cycles
                ]
                if unresolved_cycles:
                    unresolved = ", ".join(
                        f"TaskID={state.current_task_id}@{state.load_port}"
                        for state in unresolved_cycles
                    )
                    raise ValueError(f"无法从当前 MoveList 确定 CJobCycle 完工时刻：{unresolved}")
                break

            # 暂不定义与定时重算同刻时的合并规则；同刻时先完成补片重算。
            if next_cycle_time <= next_timed_time + TIME_TOLERANCE:
                due_states = [
                    cycle_state
                    for completion_time, cycle_state in cycle_times
                    if completion_time <= next_cycle_time + TIME_TOLERANCE
                ]
                next_cjobs = [
                    _cycle_cjob(cycle_state.template, cycle_state.current_cycle + 1)
                    for cycle_state in due_states
                ]
                cycle_labels = ", ".join(
                    f"{cycle_state.load_port} {cycle_state.current_cycle + 1}/{cycle_state.total_cycles}"
                    for cycle_state in due_states
                )
                _released_ids, empty_ports = execute_recompute_event(
                    {"currentTime": next_cycle_time, "cjobs": next_cjobs},
                    next_cycle_time,
                    f"CJobCycle 补片（{cycle_labels}）",
                    "cjob-cycle",
                    completed_cycles=due_states,
                )
                missing_ports = {
                    cycle_state.load_port for cycle_state in due_states
                    if cycle_state.load_port not in empty_ports
                }
                if missing_ports:
                    raise ValueError(
                        "CJobCycle 到达补片时刻但 LoadPort 尚未清空："
                        + ",".join(sorted(missing_ports))
                    )
                for cycle_state in due_states:
                    cycle_state.current_cycle += 1
                    cycle_state.current_task_id = _cycle_task_id(
                        str(
                            cycle_state.template.get("taskId")
                            or cycle_state.template.get("TaskID")
                            or ""
                        ).strip(),
                        cycle_state.current_cycle,
                    )
                continue

            round_config = rounds[next_configured_round]
            configured_round = next_configured_round + 1
            requested_time = next_timed_time
            execute_recompute_event(
                round_config,
                requested_time,
                f"第 {configured_round} 轮新增 Job",
                "time",
                configured_round,
            )
            active_cycles.extend(
                _cycle_states_for_round(round_config, configured_round)
            )
            next_configured_round += 1

    combined_output = runtime.combined_output()

    search_telemetry: Optional[Dict[str, Any]] = None
    if builtin_strategy == "schedule-alphago":
        search_telemetry = dict(
            builtin_algorithm_api.get_search_telemetry()
        )
        search_telemetry.pop("committedMoves", None)
        combined_output["SearchTelemetry"] = deepcopy(search_telemetry)

    # 决策轨迹只进入可回放结果文件；运行摘要保留计数，避免 API 响应重复携带大数组。
    decision_trace: List[Dict[str, Any]] = []
    decision_trace_truncated = False
    for summary in summaries:
        strategy_diagnostics = summary.get("strategyDiagnostics")
        if not isinstance(strategy_diagnostics, dict):
            continue
        round_trace = strategy_diagnostics.pop("decisionTrace", [])
        decision_trace_truncated = bool(
            decision_trace_truncated
            or strategy_diagnostics.get("decisionTraceTruncated", False)
        )
        if isinstance(round_trace, list):
            for raw_decision in round_trace:
                if not isinstance(raw_decision, Mapping):
                    continue
                decision_trace.append({
                    **deepcopy(dict(raw_decision)),
                    "roundIndex": int(summary.get("index") or 0),
                    "roundKind": str(summary.get("kind") or ""),
                })
        strategy_diagnostics["decisionTraceCount"] = (
            len(round_trace) if isinstance(round_trace, list) else 0
        )
    if decision_trace:
        dual_actor_trace = strategy == "dual-actor-e2e"
        combined_output["DecisionTrace"] = decision_trace
        combined_output["DecisionTraceMeta"] = {
            "schema": (
                "dual-actor-primitive-decision-trace-v1"
                if dual_actor_trace
                else "e2e-ctq-decision-trace-v1"
            ),
            "model": "双 Actor 原子调度" if dual_actor_trace else "E2E-CTQ",
            "decisionCount": len(decision_trace),
            "truncated": decision_trace_truncated,
        }
    total_ms = (time.perf_counter() - started) * 1000.0
    makespan = _segment_end(combined_output["MoveList"])
    logs.append(
        f"完成：总耗时 {total_ms:.1f} ms，"
        f"makespan={makespan:.2f}s，Move={len(combined_output['MoveList'])}"
    )
    result = {
        "ok": True,
        "strategy": strategy,
        "rounds": summaries,
        "totalElapsedMs": total_ms,
        "makespan": makespan,
        "moveCount": len(combined_output["MoveList"]),
        "validation": "skipped" if skip_validation else "passed",
        "validationEngine": (
            "skipped"
            if skip_validation
            else "hongye"
            if use_hongye_validation
            else "platform"
        ),
        "logs": logs,
        "updates": update_snapshots,
        "output": combined_output,
    }
    if search_telemetry is not None:
        result["searchTelemetry"] = search_telemetry
    return result


def _ensure_algorithm_output(
    output: Mapping[str, Any],
    update_params: Mapping[str, Any],
) -> None:
    """把外部 Feedback 中的失败转换为带原始文案的服务端异常。"""
    move_list = list(output.get("MoveList") or [])
    if move_list or not update_params.get("ProcessJobs"):
        return
    feedback = list(output.get("Feedback") or [])
    message = next(
        (
            str(item.get("Message") or item)
            for item in feedback
            if isinstance(item, Mapping)
        ),
        "标准算法未生成 MoveList",
    )
    raise RuntimeError(message)


def _execute_plan(raw_plan: Mapping[str, Any], reproduction: ReproductionLog) -> Dict[str, Any]:
    """执行控制台提交的计划，并同步写入结构化复现事件。"""
    started = time.perf_counter()
    plan = deepcopy(dict(raw_plan))
    plan["device"] = extract_init_data(plan.get("device"))
    expand_pse300_loadlocks(plan["device"])
    plan["device"] = build_task_alg_init(
        plan["device"],
        [row for row in (plan.get("routes") or []) if isinstance(row, Mapping)],
        [row for row in (plan.get("rounds") or []) if isinstance(row, Mapping)],
        [row for row in (plan.get("cleans") or []) if isinstance(row, Mapping)],
    )
    reproduction.add("AlgInit", plan["device"])
    strategy = str(plan.get("strategy") or "heuristic").strip()
    normalized_strategy = strategy.lower()
    other_algorithm_id = (
        strategy.split(":", 1)[1]
        if normalized_strategy.startswith("other_alg:") and ":" in strategy
        else None
    )
    builtin_strategies = {
        str(algorithm["strategy"]): algorithm
        for algorithm in discover_builtin_algorithms()
    }
    if normalized_strategy not in builtin_strategies:
        if other_algorithm_id is None:
            supported = "、".join(sorted(builtin_strategies)) or "无"
            raise ValueError(
                f"本地策略只支持 {supported}，"
                "或 other_alg 下已发现的标准算法"
            )
        discovered_ids = {
            str(item["id"]).casefold()
            for item in discover_other_algorithms()
        }
        if other_algorithm_id.casefold() not in discovered_ids:
            supported = "、".join(sorted(builtin_strategies)) or "无"
            raise ValueError(
                f"本地策略只支持 {supported}，"
                "或 other_alg 下已发现的标准算法"
            )
    elif not builtin_strategies[normalized_strategy]["available"]:
        reason = str(
            builtin_strategies[normalized_strategy].get("unavailableReason")
            or "当前不可用"
        )
        raise RuntimeError(f"{normalized_strategy} 策略当前不可用：{reason}")
    strategy = normalized_strategy if normalized_strategy in builtin_strategies else strategy
    rounds = [row for row in (plan.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = int(_finite_number(plan.get("roundCount"), len(rounds)))
    if round_count < 1 or len(rounds) != round_count:
        raise ValueError("轮次数量与 roundCount 不一致")
    times = [_finite_number(row.get("currentTime"), 0.0) for row in rounds]
    if abs(times[0]) > TIME_TOLERANCE:
        raise ValueError("首次排程时间必须为 0")
    if any(right <= left + TIME_TOLERANCE for left, right in zip(times, times[1:])):
        raise ValueError("各轮重算时间必须严格递增")
    for round_index, round_config in enumerate(rounds, start=1):
        for cjob in _round_cjob_rows(round_config):
            cycle_count = _cjob_cycle_count(cjob)
            if cycle_count > 1 and not _cjob_load_port_name(cjob):
                task_id = str(cjob.get("taskId") or cjob.get("TaskID") or "?")
                raise ValueError(
                    f"第 {round_index} 轮 CJob TaskID={task_id} 启用 CJobCycle 时必须选择 LoadPort"
                )

    options = plan.get("options") if isinstance(plan.get("options"), Mapping) else {}
    default_loadlock_manager_mode = (
        "joint"
        if strategy in {"e2e-ctq", "dual-actor-e2e"}
        else "petri-look"
    )
    loadlock_manager_mode = str(
        options.get("loadLockManager") or default_loadlock_manager_mode
    ).strip().lower()
    supported_loadlock_managers = {
        "joint",
        "petri-look",
        "petri-eta",
        "collective-look",
        "round-robin",
        "dedicated-direction",
        "exchange-look",
    }
    if loadlock_manager_mode not in supported_loadlock_managers:
        raise ValueError(
            "LoadLock manager 只支持 joint、petri-eta、collective-look、"
            "round-robin、dedicated-direction 或 exchange-look"
        )
    build_state = BuildState()

    first_update = build_round_update(plan, rounds[0], 0.0, build_state)
    reproduction.add("AlgSchedule", _schedule_log_info(plan["device"], first_update))
    skip_validation = bool(plan.get("skipValidation"))
    if other_algorithm_id is not None:
        return _execute_standard_algorithm(
            plan,
            first_update,
            rounds,
            times,
            build_state,
            reproduction,
            started,
            other_algorithm_id,
            skip_validation=skip_validation,
        )
    return _execute_standard_algorithm(
        plan,
        first_update,
        rounds,
        times,
        build_state,
        reproduction,
        started,
        builtin_strategy=strategy,
        skip_validation=skip_validation,
    )

def execute_plan(raw_plan: Mapping[str, Any]) -> Dict[str, Any]:
    """执行计划；成功和失败都生成可重放的 input_data 格式日志。"""
    _set_run_monitor_scope(str(raw_plan.get("strategy") or "heuristic"))
    _raise_if_single_run_cancelled()
    use_hongye_validation = (
        not bool(raw_plan.get("skipValidation"))
        and bool(raw_plan.get("hongYeCheck", True))
    )
    hongye_session = (
        HongYeValidationSession() if use_hongye_validation else None
    )
    reproduction = ReproductionLog(hongye_session=hongye_session)
    # Input 是前端复现上下文，不属于 HongYe 的增量校验协议。把整份页面计划
    # 发送给校验子进程只会产生一次无效的 JSON 序列化和跨进程复制。
    reproduction.add(
        "Input",
        [deepcopy(dict(raw_plan))],
        forward_to_validator=False,
    )
    cpu_started = time.thread_time() if hasattr(time, "thread_time") else time.process_time()
    try:
        result = _execute_plan(raw_plan, reproduction)
    except LoggedPlanError:
        # 多轮重算的算法调用失败可能已附带按 RemoveList 裁剪的旧计划；
        # 不能再包装为普通异常，否则 /api/run 将丢失甘特图所需的结果。
        raise
    except Exception as error:  # noqa: BLE001
        # 用户主动取消属于预期终止而非运行失败，原样向上传播，
        # 由 /api/run 返回 cancelled 标记。
        cancelled_error_type = globals().get("SearchCancelledError")
        if (
            isinstance(error, UserRunCancelledError)
            or cancelled_error_type is not None
            and isinstance(error, cancelled_error_type)
        ):
            raise
        feedback = [{
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error),
        }]
        if isinstance(error, MoveListValidationError):
            reproduction.add(
                "AlgOutput",
                _alg_output_info(error.algorithm_output, feedback=feedback),
                error.sim_time,
                forward_to_validator=False,
            )
            raise LoggedPlanError(
                str(error),
                reproduction.entries,
                failure_output=error.gantt_output,
                validation_issues=error.validation_issues,
            ) from error
        prior_plan_output = _build_prior_plan_failure_output(
            reproduction.entries,
            error,
        )
        reproduction.add(
            "AlgOutput",
            _alg_output_info(feedback=feedback),
            forward_to_validator=False,
        )
        raise LoggedPlanError(
            str(error),
            reproduction.entries,
            failure_output=prior_plan_output,
        ) from error
    finally:
        if hongye_session is not None:
            hongye_session.close()
    cpu_finished = time.thread_time() if hasattr(time, "thread_time") else time.process_time()
    result["cpuTimeMs"] = max(0.0, (cpu_finished - cpu_started) * 1000.0)
    if reproduction.last_hongye_validation is not None:
        result["validationDetails"] = deepcopy(
            reproduction.last_hongye_validation
        )
    result["reproductionLog"] = deepcopy(reproduction.entries)
    return result


def _workspace_timestamp() -> str:
    """生成工作区记录使用的本地秒级时间。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _legacy_workspace_directory_path() -> Path:
    """返回随 DATA_DIR 测试替换而变化的旧版工作区目录。"""
    return DATA_DIR / "workspaces"


def _has_separate_legacy_workspace_directory(path: Path) -> bool:
    """判断默认数据旁是否仍有一份不同路径的 v5 工作区。"""
    legacy_path = _legacy_workspace_directory_path()
    return legacy_path.is_dir() and legacy_path.absolute() != path.absolute()


def _empty_workspace_catalog() -> Dict[str, Any]:
    """创建当前版本的空设备工作区目录。"""
    return {"version": WORKSPACE_STORE_VERSION, "devices": []}


def _workspace_store_version_path(store_dir: Path) -> Path:
    """返回数据集根目录中面向用户可见的格式清单。"""
    return store_dir / WORKSPACE_STORE_VERSION_FILE


def _workspace_test_index_path(tests_dir: Path) -> Path:
    """返回测试摘要索引路径；索引与完整测试文件分开，避免切换设备时全量读取。"""
    return tests_dir / WORKSPACE_TEST_INDEX_FILE


def _read_workspace_store_version(store_dir: Path) -> int:
    """读取数据格式版本，并兼容旧目录中的隐藏版本标记。"""
    candidates = (
        _workspace_store_version_path(store_dir),
        store_dir / LEGACY_WORKSPACE_STORE_VERSION_FILE,
    )
    for candidate in candidates:
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(payload, Mapping):
                return int(payload.get("schemaVersion", payload.get("version")) or 0)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    return 0


def _workspace_store_is_current(path: Path = WORKSPACE_STORE_PATH) -> bool:
    """快速判断目录是否可走按需读取路径，不遍历业务数据文件。

    该判断只验证持久化格式标记和旧库迁移状态，供正常运行期间的高频 API
    使用。检测人工修改文件时间的完整扫描只保留在服务启动和显式迁移流程，
    避免每次读取单个测试都对整个数据目录执行 O(N) 的 ``stat``。

    Args:
        path: 工作区目录或兼容的旧单文件路径。

    Returns:
        当前格式已经完整落盘且没有待迁移旧库时返回 ``True``。
    """
    if path.suffix:
        return False
    if not path.is_dir() or _read_workspace_store_version(path) != WORKSPACE_STORE_VERSION:
        return False
    if path == WORKSPACE_STORE_PATH and (
        (DATA_DIR / "workspaces.json").is_file()
        or _has_separate_legacy_workspace_directory(path)
    ):
        return False
    return True


def _write_workspace_store_version(store_dir: Path) -> None:
    """在数据文件全部落盘后刷新可读的格式清单。"""
    if not _uses_readable_dataset_layout(store_dir):
        _write_json_atomic(
            store_dir / WORKSPACE_STORE_VERSION_FILE,
            {"version": WORKSPACE_STORE_VERSION},
        )
        return
    _write_json_atomic(
        _workspace_store_version_path(store_dir),
        {
            "kind": "ct-scheduler-datasets",
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "description": "请通过调度平台前端导入或导出设备与测试集。",
        },
    )


def _uuid_storage_segment(stable_id: str) -> str:
    """返回稳定 UUID 目录名；名称只保存在 JSON 和前端，不参与磁盘寻址。"""
    normalized_id = re.sub(r"[^A-Za-z0-9_-]", "", stable_id)
    return normalized_id or uuid.uuid4().hex


def _dataset_device_directory(store_dir: Path, device: Mapping[str, Any]) -> Path:
    """根据设备稳定 ID 返回新版数据集目录。"""
    return store_dir / _uuid_storage_segment(str(device.get("id") or ""))


def _find_dataset_device_directory(store_dir: Path, device_id: str) -> Optional[Path]:
    """扫描新版设备清单，根据内部 ID 定位 UUID 目录。"""
    if not store_dir.is_dir():
        return None
    for device_dir in store_dir.iterdir():
        if not device_dir.is_dir():
            continue
        try:
            metadata = json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
        if isinstance(metadata, Mapping) and str(metadata.get("id") or "") == device_id:
            return device_dir
    return None


def _dataset_test_directory(tests_dir: Path, test_case: Mapping[str, Any]) -> Path:
    """返回单个测试集的稳定 UUID 独立目录。"""
    return tests_dir / _uuid_storage_segment(str(test_case.get("id") or ""))


def _find_dataset_test_file(device_dir: Path, test_id: str) -> Optional[Path]:
    """根据测试内部 ID 定位新版独立测试集文件。"""
    tests_dir = device_dir / "tests"
    if not tests_dir.is_dir():
        return None
    # v6 目录名就是稳定测试 UUID。优先直接命中，避免大型设备每次读取一个测试时
    # 都解析 tests/ 下的全部 test.json；调用方读取后仍会校验文件内 ID，保留后面的
    # 扫描只用于目录名未直接命中的人工移动旧数据。
    direct_file = _dataset_test_directory(tests_dir, {"id": test_id}) / "test.json"
    if direct_file.is_file():
        return direct_file
    for test_dir in tests_dir.iterdir():
        test_file = test_dir / "test.json"
        if not test_file.is_file():
            continue
        try:
            test_case = json.loads(test_file.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
        if isinstance(test_case, Mapping) and str(test_case.get("id") or "") == test_id:
            return test_file
    return None


def _workspace_data_update_required(path: Path = WORKSPACE_STORE_PATH) -> bool:
    """仅在版本变化、旧库待迁移或外部文件更新后要求启动前整理数据。"""
    if path.suffix:
        if not path.is_file():
            return False
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            return int(payload.get("version") or 0) != WORKSPACE_STORE_VERSION
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return True
    if path == WORKSPACE_STORE_PATH and (
        (DATA_DIR / "workspaces.json").is_file()
        or _has_separate_legacy_workspace_directory(path)
    ):
        return True
    if not path.is_dir():
        if path != WORKSPACE_STORE_PATH:
            return False
        return any(candidate.is_file() for candidate in (
            DATA_DIR / "workspaces.json", LEGACY_WORKSPACE_STORE_PATH,
        )) or _has_separate_legacy_workspace_directory(path)
    marker = _workspace_store_version_path(path)
    if _read_workspace_store_version(path) != WORKSPACE_STORE_VERSION:
        return True
    try:
        marker_mtime = marker.stat().st_mtime_ns
        data_files = [
            *path.glob("*/metadata.json"),
            *path.glob("*/device.json"),
            *path.glob("*/routes.json"),
            *path.glob("*/groups.json"),
            *path.glob("*/tests/*/test.json"),
        ]
        return any(file.stat().st_mtime_ns > marker_mtime for file in data_files)
    except OSError:
        return True


def _prepare_workspace_data(path: Path = WORKSPACE_STORE_PATH) -> bool:
    """按需完成一次启动前数据迁移，并为目录格式升级保留可恢复备份。"""
    if not _workspace_data_update_required(path):
        return False
    list_workspace_devices(path)
    if path.suffix == "" and path.is_dir():
        with _workspace_catalog_guard(path):
            _write_workspace_store_version(path)
    return True


def _backup_workspace_directory_before_upgrade(path: Path) -> Optional[Path]:
    """在首次改写旧目录前创建一次完整备份；同一版本升级重复调用保持幂等。"""
    if path.suffix or not path.is_dir():
        return None
    source_version = _read_workspace_store_version(path)
    if source_version <= 0 or source_version >= WORKSPACE_STORE_VERSION:
        return None
    backup_root = (
        DATA_DIR / "migration-backups"
        if path == WORKSPACE_STORE_PATH
        else path.parent / "migration-backups"
    )
    backup_root.mkdir(parents=True, exist_ok=True)
    prefix = f"datasets-v{source_version}-to-v{WORKSPACE_STORE_VERSION}-"
    existing = next(backup_root.glob(f"{prefix}*"), None)
    if existing is not None:
        return existing
    backup_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = backup_root / f"{prefix}{backup_stamp}-{uuid.uuid4().hex[:8]}"
    shutil.copytree(path, backup_path)
    return backup_path


def _merge_named_assets(base: Sequence[Any], additions: Sequence[Any]) -> List[Dict[str, Any]]:
    """按名称合并 Route/Clean；同名项由后出现的数据覆盖且保持稳定位置。"""
    merged: List[Dict[str, Any]] = []
    positions: Dict[str, int] = {}
    for raw in [*base, *additions]:
        if not isinstance(raw, Mapping):
            continue
        item = deepcopy(dict(raw))
        name = str(item.get("name") or item.get("Name") or "").strip()
        key = name.casefold()
        if not key:
            continue
        if key in positions:
            merged[positions[key]] = item
        else:
            positions[key] = len(merged)
            merged.append(item)
    return merged


def _repair_workspace_route_recipes(
    routes: Sequence[Any],
    processing_modules: Iterable[str] = (),
) -> bool:
    """修复旧共享 Route 的加工标记，并补稳定 Recipe 名称和已有加工时间。

    早期导入数据可能只在第一道工序保存 ``processRecipe``，后续工序虽然
    ``needProcess=true`` 且已有 ``processTime``，却无法生成 ProcessRecipes。
    旧版页面还只识别 ProcessChamber，导致 Heater、Cooler 等设备即使保存了
    加工时长，也会被错误写成 ``needProcess=false``；迁移时根据设备拓扑纠正。
    """
    changed = False
    processing_module_names = {
        str(module_name).strip()
        for module_name in processing_modules
        if str(module_name).strip()
    }
    for raw_route in routes:
        if not isinstance(raw_route, dict):
            continue
        prefix = str(raw_route.get("group") or raw_route.get("name") or "Route").strip()
        for stage_index, raw_stage in enumerate(raw_route.get("stages") or []):
            if not isinstance(raw_stage, dict):
                continue
            raw_visits = raw_stage.get("visits") or raw_stage.get("Visits") or []
            topology_requires_process = any(
                isinstance(raw_visit, Mapping)
                and str(
                    raw_visit.get("stationName", raw_visit.get("ModuleName", ""))
                ).strip() in processing_module_names
                for raw_visit in raw_visits
            )
            need_process = bool(
                raw_stage.get("needProcess", raw_stage.get("NeedProcess", False))
            ) or topology_requires_process
            if topology_requires_process:
                need_process_key = (
                    "NeedProcess" if "NeedProcess" in raw_stage else "needProcess"
                )
                if raw_stage.get(need_process_key) is not True:
                    raw_stage[need_process_key] = True
                    changed = True
            if not need_process:
                continue
            step_id = int(_finite_number(
                raw_stage.get("stepId", raw_stage.get("StepID")),
                stage_index,
            ))
            recipe_name = f"{prefix}_Step{step_id}"
            for raw_visit in raw_visits:
                if not isinstance(raw_visit, dict):
                    continue
                recipe_key = "processRecipe" if "ProcessRecipe" not in raw_visit else "ProcessRecipe"
                if not str(raw_visit.get(recipe_key) or "").strip():
                    raw_visit[recipe_key] = recipe_name
                    changed = True
                time_key = "processTime" if "Time" not in raw_visit else "Time"
                if raw_visit.get(time_key) in (None, "") and raw_visit.get("recipeTime") not in (None, ""):
                    raw_visit[time_key] = raw_visit["recipeTime"]
                    changed = True
    return changed


def _natural_name_key(value: str) -> Tuple[Any, ...]:
    """把带数字的设备名称拆成自然排序键，例如 LP2 排在 LP10 前。"""
    return tuple(
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", value)
        if part
    )


def _workspace_load_ports(device: Mapping[str, Any]) -> List[str]:
    """按前端一致的自然顺序返回设备中的 LoadPort 名称。"""
    topology = device.get("device") if isinstance(device.get("device"), Mapping) else device
    stations = topology.get("Stations") if isinstance(topology, Mapping) else {}
    if not isinstance(stations, Mapping):
        return []
    return sorted(
        (
            str(name)
            for name, station in stations.items()
            if isinstance(station, Mapping)
            and str(station.get("Type") or "").strip().lower() == "loadport"
        ),
        key=_natural_name_key,
    )


def _workspace_processing_modules(device: Mapping[str, Any]) -> List[str]:
    """返回拓扑中需要生成加工事件和甘特图加工条的模块名称。"""
    topology = device.get("device") if isinstance(device.get("device"), Mapping) else device
    stations = topology.get("Stations") if isinstance(topology, Mapping) else {}
    if not isinstance(stations, Mapping):
        return []
    return sorted(
        (
            str(name)
            for name, station in stations.items()
            if isinstance(station, Mapping)
            and str(station.get("Type") or "").strip().lower()
            in PROCESSING_STATION_TYPES
        ),
        key=_natural_name_key,
    )


def _workspace_task_mode_name(raw_value: Any) -> str:
    """把页面或旧工作区中的 TaskMode 收敛为稳定枚举名称。"""
    try:
        value = _enum_value(raw_value, TASK_MODE_VALUES, "TaskMode", "Smart")
    except ValueError:
        value = TASK_MODE_VALUES["Smart"]
    return TASK_MODE_NAMES[value]


def _automatic_workspace_load_port(
    load_ports: Sequence[str],
    task_ordinal: int,
) -> str:
    """按盒子的全局 CJob 顺序轮转源 LoadPort。"""
    if not load_ports:
        return ""
    return str(load_ports[max(0, task_ordinal - 1) % len(load_ports)])


def _repair_workspace_job_layout(device: Dict[str, Any]) -> bool:
    """迁移已有测试的 TaskID、固定 LoadPort 与 CJobCycle。"""
    changed = False
    load_ports = _workspace_load_ports(device)
    for test in device.get("tests") or []:
        if not isinstance(test, dict):
            continue
        next_task_id = 1
        for round_index, round_row in enumerate(test.get("rounds") or [], start=1):
            if not isinstance(round_row, dict):
                continue
            cjobs = [
                item for item in (round_row.get("cjobs") or [])
                if isinstance(item, dict)
            ]
            for cjob_index, cjob in enumerate(cjobs, start=1):
                task_id = str(next_task_id)
                next_task_id += 1
                task_mode = _workspace_task_mode_name(cjob.get("taskMode", cjob.get("TaskMode")))
                fallback_load_port = str(cjob.get("loadPort") or "")
                pjobs = [
                    item for item in (cjob.get("pjobs") or [])
                    if isinstance(item, dict)
                ]
                if not fallback_load_port and pjobs:
                    fallback_load_port = str(
                        pjobs[0].get("loadPort") or pjobs[0].get("LoadPort") or ""
                    )
                load_port = (
                    fallback_load_port
                    if fallback_load_port in load_ports
                    else _automatic_workspace_load_port(load_ports, int(task_id))
                ) or fallback_load_port
                normalized_fields = {
                    "taskId": task_id,
                    "taskMode": task_mode,
                    "loadPort": load_port,
                    "cjobCycle": _cjob_cycle_count(cjob),
                    "pJobNameList": [f"P{index}" for index in range(1, len(pjobs) + 1)],
                }
                for key, value in normalized_fields.items():
                    if cjob.get(key) != value:
                        cjob[key] = value
                        changed = True
                for pjob_index, pjob in enumerate(pjobs, start=1):
                    pjob_fields = {
                        "jobName": f"P{pjob_index}",
                        "taskId": task_id,
                        "loadPort": load_port,
                    }
                    for key, value in pjob_fields.items():
                        if pjob.get(key) != value:
                            pjob[key] = value
                            changed = True
    return changed


def _repair_workspace_route_contracts(routes: Sequence[Any]) -> bool:
    """清除不支持的 PostCJob，并把旧 BufferOption 收敛到接口枚举范围。"""
    changed = False
    for route in routes:
        if not isinstance(route, dict):
            continue
        if "postCJobCleanRefs" in route and route.get("postCJobCleanRefs"):
            route["postCJobCleanRefs"] = []
            changed = True
        if "bufferOption" in route:
            raw_option = _finite_number(route.get("bufferOption"), 0)
            option = max(0, min(4, int(raw_option)))
            if route.get("bufferOption") != option:
                route["bufferOption"] = option
                changed = True
    return changed


def _workspace_route_test_config(route: Mapping[str, Any]) -> Dict[str, Any]:
    """从旧版共享 Route 提取时间、清洁和驻留等测试侧参数。"""
    def string_rows(value: Any) -> List[str]:
        """把旧版数组或逗号文本收敛为去重名称列表。"""
        rows = value if isinstance(value, list) else str(value or "").replace("，", ",").split(",")
        return list(dict.fromkeys(
            str(item).strip() for item in rows if str(item).strip()
        ))

    recipe_prefix = str(route.get("group") or route.get("name") or "Route").strip()
    route_config: Dict[str, Any] = {
        "bufferOption": max(0, min(4, int(_finite_number(
            route.get("bufferOption", route.get("BufferOption")), 0,
        )))),
        "prePJobCleanRefs": string_rows(route.get("prePJobCleanRefs")),
        "postPJobCleanRefs": string_rows(route.get("postPJobCleanRefs")),
        "postCJobCleanRefs": [],
        "stages": {},
    }
    for stage_index, stage in enumerate(route.get("stages") or []):
        if not isinstance(stage, Mapping):
            continue
        step_id = str(int(_finite_number(stage.get("stepId"), stage_index)))
        visits = [
            visit for visit in (stage.get("visits") or [])
            if isinstance(visit, Mapping)
        ]
        visit = visits[0] if visits else {}
        process_time = _finite_number(
            visit.get("processTime", visit.get("recipeTime")), 20,
        )
        route_config["stages"][step_id] = {
            "processTime": process_time,
            "recipeTime": process_time,
            "qTimeLimit": _finite_number(visit.get("qTimeLimit"), -1),
            "residencyConstraint": _finite_number(
                visit.get("residencyConstraint"), -1,
            ),
            "beforeCleanRefs": string_rows(visit.get("beforeCleanRefs")),
            "afterCleanRefs": string_rows(visit.get("afterCleanRefs")),
            "processRecipe": str(
                visit.get("processRecipe")
                or (f"{recipe_prefix}_Step{step_id}" if stage.get("needProcess") else "")
            ),
            "processType": str(visit.get("processType") or ""),
            "weight": deepcopy(visit.get("weight") or {}),
            "moveTimeOffset": deepcopy(visit.get("moveTimeOffset") or {}),
            "slotIds": str(visit.get("slotIds") or "1"),
        }
    return route_config


def _workspace_route_config_map(routes: Sequence[Any]) -> Dict[str, Any]:
    """按 Route 名称生成旧数据到测试侧参数的兼容迁移映射。"""
    return {
        str(route.get("name") or "").strip(): _workspace_route_test_config(route)
        for route in routes
        if isinstance(route, Mapping) and str(route.get("name") or "").strip()
    }


def _synchronize_workspace_test_route_configs(device: Dict[str, Any]) -> None:
    """让每个测试配置与最新模板 Step 对齐，并保留仍然有效的既有参数。"""
    defaults = _workspace_route_config_map(device.get("routes") or [])
    for test_case in device.get("tests") or []:
        existing = test_case.get("routeConfigs")
        existing = existing if isinstance(existing, Mapping) else {}
        normalized: Dict[str, Any] = {}
        for route_name, default_config in defaults.items():
            prior = existing.get(route_name)
            prior = prior if isinstance(prior, Mapping) else {}
            merged = deepcopy(default_config)
            for key in (
                "bufferOption", "prePJobCleanRefs", "postPJobCleanRefs",
                "postCJobCleanRefs",
            ):
                if key in prior:
                    merged[key] = deepcopy(prior[key])
            prior_stages = prior.get("stages")
            prior_stages = prior_stages if isinstance(prior_stages, Mapping) else {}
            for step_id, stage_config in merged["stages"].items():
                if isinstance(prior_stages.get(step_id), Mapping):
                    stage_config.update(deepcopy(dict(prior_stages[step_id])))
            normalized[route_name] = merged
        test_case["routeConfigs"] = normalized


def _migrate_workspace_pjob_route_configs(
    test_case: Dict[str, Any],
    route_configs: Mapping[str, Any],
) -> bool:
    """把旧版按模板共享的参数复制到每个 PJob，确保路径实例互不影响。"""
    changed = False
    for round_row in test_case.get("rounds") or []:
        if not isinstance(round_row, Mapping):
            continue
        for cjob in round_row.get("cjobs") or []:
            if not isinstance(cjob, Mapping):
                continue
            for pjob in cjob.get("pjobs") or []:
                if not isinstance(pjob, dict) or isinstance(pjob.get("routeConfig"), Mapping):
                    continue
                route_name = str(pjob.get("routeRef") or "").strip()
                config = route_configs.get(route_name)
                if isinstance(config, Mapping):
                    pjob["routeConfig"] = deepcopy(dict(config))
                    changed = True
    return changed


def _strip_workspace_route_parameters(route: Dict[str, Any]) -> None:
    """原地清除共享模板中的测试参数，仅保留 Step 与候选腔室拓扑。"""
    route.pop("bufferOption", None)
    route.pop("prePJobCleanRefs", None)
    route.pop("postPJobCleanRefs", None)
    route.pop("postCJobCleanRefs", None)
    if "stages" not in route:
        return
    stages = []
    for stage_index, raw_stage in enumerate(route.get("stages") or []):
        if not isinstance(raw_stage, Mapping):
            continue
        step_id = int(_finite_number(raw_stage.get("stepId"), stage_index))
        visits = [
            {"stationName": str(visit.get("stationName") or "")}
            for visit in (raw_stage.get("visits") or [])
            if isinstance(visit, Mapping)
        ]
        stages.append({
            "stepId": step_id,
            "postStepIds": [step_id + 1] if stage_index + 1 < len(route.get("stages") or []) else [],
            "needProcess": bool(raw_stage.get("needProcess")),
            "kind": str(raw_stage.get("kind") or ""),
            "visits": visits,
        })
    route["stages"] = stages


def _normalized_workspace_routes(raw_routes: Sequence[Any]) -> List[Any]:
    """校验并保存只含 Step 与候选腔室的共享路径模板。"""
    routes = deepcopy(list(raw_routes))
    for route in routes:
        if not isinstance(route, dict):
            continue
        if "bufferOption" in route:
            raw_option = route.get("bufferOption")
            try:
                numeric_option = float(raw_option)
            except (TypeError, ValueError):
                raise ValueError(f"BufferOption 必须是 0~4 的整数：{raw_option}") from None
            option = int(numeric_option)
            if not math.isfinite(numeric_option) or numeric_option != option or not 0 <= option <= 4:
                raise ValueError(f"BufferOption 必须是 0~4 的整数：{raw_option}")
            route["bufferOption"] = option
        _strip_workspace_route_parameters(route)
    return routes


def _workspace_route_topology_key(route: Mapping[str, Any]) -> str:
    """返回只描述 Step 与候选模块的稳定键；首尾模块由 CJob 决定，不参与区分。"""
    raw_stages = [stage for stage in (route.get("stages") or []) if isinstance(stage, Mapping)]
    stages = []
    for stage_index, stage in enumerate(raw_stages):
        fixed_endpoint = stage_index == 0 or stage_index == len(raw_stages) - 1
        candidates = [] if fixed_endpoint else sorted({
            str(visit.get("stationName") or "").strip()
            for visit in (stage.get("visits") or [])
            if isinstance(visit, Mapping) and str(visit.get("stationName") or "").strip()
        })
        stages.append({
            "kind": "endpoint" if fixed_endpoint else str(stage.get("kind") or ""),
            "needProcess": False if fixed_endpoint else bool(stage.get("needProcess")),
            "candidates": candidates,
        })
    return json.dumps(stages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _workspace_test_route_refs(test_case: Mapping[str, Any]) -> set[str]:
    """收集测试内实际被 PJob 引用的模板名称。"""
    return {
        str(pjob.get("routeRef") or "").strip()
        for round_row in (test_case.get("rounds") or [])
        if isinstance(round_row, Mapping)
        for cjob in (round_row.get("cjobs") or [])
        if isinstance(cjob, Mapping)
        for pjob in (cjob.get("pjobs") or [])
        if isinstance(pjob, Mapping) and str(pjob.get("routeRef") or "").strip()
    }


def _deduplicate_workspace_route_templates(device: Dict[str, Any]) -> int:
    """合并纯拓扑重复模板并迁移测试引用；参数冲突时保留模板以避免数据损失。"""
    routes = [route for route in (device.get("routes") or []) if isinstance(route, dict)]
    tests = [test for test in (device.get("tests") or []) if isinstance(test, dict)]
    canonical_by_key: Dict[str, Dict[str, Any]] = {}
    kept: List[Dict[str, Any]] = []
    removed_count = 0
    for route in routes:
        route_name = str(route.get("name") or "").strip()
        topology_key = _workspace_route_topology_key(route)
        canonical = canonical_by_key.get(topology_key)
        if canonical is None or not route_name:
            canonical_by_key[topology_key] = route
            kept.append(route)
            continue
        canonical_name = str(canonical.get("name") or "").strip()
        conflict = False
        for test_case in tests:
            refs = _workspace_test_route_refs(test_case)
            configs = test_case.get("routeConfigs")
            configs = configs if isinstance(configs, Mapping) else {}
            if (
                route_name in refs and canonical_name in refs
                and route_name in configs and canonical_name in configs
                and configs[route_name] != configs[canonical_name]
            ):
                conflict = True
                break
        if conflict:
            kept.append(route)
            continue

        for test_case in tests:
            refs_before = _workspace_test_route_refs(test_case)
            for round_row in (test_case.get("rounds") or []):
                if not isinstance(round_row, Mapping):
                    continue
                for cjob in (round_row.get("cjobs") or []):
                    if not isinstance(cjob, Mapping):
                        continue
                    for pjob in (cjob.get("pjobs") or []):
                        if isinstance(pjob, dict) and str(pjob.get("routeRef") or "") == route_name:
                            pjob["routeRef"] = canonical_name
            configs = test_case.get("routeConfigs")
            if isinstance(configs, dict) and route_name in configs:
                if canonical_name not in configs or (
                    route_name in refs_before and canonical_name not in refs_before
                ):
                    configs[canonical_name] = configs[route_name]
                configs.pop(route_name, None)
        removed_count += 1
    if removed_count:
        device["routes"] = kept
    return removed_count


def _migrate_workspace_catalog(catalog: Dict[str, Any]) -> bool:
    """迁移设备工作区结构，并为已有 PSE300 补齐 LC/LD LoadLock。"""
    source_version = int(catalog.get("version") or 0)
    changed = source_version != WORKSPACE_STORE_VERSION
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, dict):
            continue
        if source_version < 6:
            original_name = str(raw_device.get("name") or "").strip()
            normalized_name = Path(original_name).stem if original_name else "未命名设备"
            if normalized_name != original_name:
                raw_device["name"] = normalized_name
                changed = True
        routes = list(raw_device.get("routes") or [])
        cleans = list(raw_device.get("cleans") or [])
        tests = [item for item in (raw_device.get("tests") or []) if isinstance(item, dict)]
        test_groups = [
            str(item).strip() for item in (raw_device.get("testGroups") or [])
            if str(item).strip()
        ]
        for test in tests:
            group = str(test.get("group") or "").strip()
            if group and group not in test_groups:
                test_groups.append(group)
            if str(test.get("strategy") or "").strip().lower() == "greedy":
                test["strategy"] = "other_alg:greedy"
                changed = True
            options = test.get("options")
            if isinstance(options, dict) and "loadLockExchange" in options:
                options.pop("loadLockExchange")
                changed = True
        if raw_device.get("testGroups") != test_groups:
            raw_device["testGroups"] = test_groups
            changed = True
        raw_topology = raw_device.get("device")
        if isinstance(raw_topology, dict) and expand_pse300_loadlocks(raw_topology):
            raw_device["fingerprint"] = _device_fingerprint(raw_topology)
            changed = True
        # 旧数据按更新时间从早到晚合并；同时先把每个测试原有参数提取为独立配置。
        for test in sorted(tests, key=lambda item: str(item.get("updatedAt") or item.get("createdAt") or "")):
            if "routes" in test:
                legacy_test_routes = [
                    route for route in (test.get("routes") or [])
                    if isinstance(route, Mapping)
                ]
                if "routeConfigs" not in test:
                    test["routeConfigs"] = _workspace_route_config_map(
                        legacy_test_routes,
                    )
                routes = _merge_named_assets(routes, legacy_test_routes)
                test.pop("routes", None)
                changed = True
            if source_version < 5 and "cleans" in test:
                cleans = _merge_named_assets(cleans, test.get("cleans") or [])
        legacy_route_configs = _workspace_route_config_map(routes)
        for test in tests:
            if not isinstance(test.get("routeConfigs"), Mapping):
                test["routeConfigs"] = deepcopy(legacy_route_configs)
                changed = True
            if not isinstance(test.get("cleans"), list):
                test["cleans"] = deepcopy(cleans)
                changed = True
        if source_version < 5:
            if _repair_workspace_route_recipes(
                routes,
                _workspace_processing_modules(raw_device),
            ):
                changed = True
        if _repair_workspace_route_contracts(routes):
            changed = True
        normalized_templates = _normalized_workspace_routes(routes)
        if routes != normalized_templates:
            routes = normalized_templates
            changed = True
        if _repair_workspace_job_layout(raw_device):
            changed = True
        if raw_device.get("routes") != routes:
            raw_device["routes"] = routes
            changed = True
        if _deduplicate_workspace_route_templates(raw_device):
            routes = list(raw_device.get("routes") or [])
            changed = True
        previous_route_configs = [
            deepcopy(test.get("routeConfigs")) for test in tests
        ]
        _synchronize_workspace_test_route_configs(raw_device)
        if previous_route_configs != [test.get("routeConfigs") for test in tests]:
            changed = True
        if source_version < 7:
            for test in tests:
                configs = test.get("routeConfigs")
                if isinstance(configs, Mapping) and _migrate_workspace_pjob_route_configs(test, configs):
                    changed = True
        if raw_device.get("cleans") != cleans:
            raw_device["cleans"] = cleans
            changed = True
    catalog["version"] = WORKSPACE_STORE_VERSION
    return changed


def _read_workspace_catalog_unlocked(path: Path) -> Dict[str, Any]:
    """在调用方持锁时读取并校验设备工作区目录。

    目录模式（``path`` 无后缀）扫描拆分后的设备目录与测试集文件；文件模式
    保留旧单文件格式，供测试与历史数据使用。目录模式存储缺失但旧单文件
    存在时，先自动迁移为拆分目录再读取。
    """
    if path.suffix == "":
        # 目录模式；仅默认存储路径缺失或上次迁移未完成（旧单文件仍在）时重新迁移，
        # 其他目录路径缺失视为空。迁移本身幂等，可安全重入以恢复中断现场。
        if path == WORKSPACE_STORE_PATH and (
            (DATA_DIR / "workspaces.json").is_file()
            or _has_separate_legacy_workspace_directory(path)
        ):
            _migrate_legacy_workspace_store(path)
        elif not path.is_dir():
            if path != WORKSPACE_STORE_PATH:
                return _empty_workspace_catalog()
            legacy_candidates = (DATA_DIR / "workspaces.json", LEGACY_WORKSPACE_STORE_PATH)
            if (
                any(candidate.is_file() for candidate in legacy_candidates)
                or _has_separate_legacy_workspace_directory(path)
            ):
                _migrate_legacy_workspace_store(path)
            else:
                return _empty_workspace_catalog()
        catalog = _read_workspace_catalog_directory(path)
    else:
        if not path.is_file():
            return _empty_workspace_catalog()
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, Mapping) or not isinstance(raw.get("devices"), list):
            raise ValueError(f"设备测试集存储格式无效：{path}")
        catalog = deepcopy(dict(raw))
        changed = _migrate_workspace_catalog(catalog)
        if changed:
            _write_workspace_catalog_unlocked(path, catalog)
        return catalog
    # 已完成当前版本迁移且目录内容没有外部变更时，避免每次读取都遍历并
    # 规范化所有测试集。路径模板的快速保存依赖此分支只读取必要文件。
    if not _workspace_data_update_required(path):
        return catalog
    _backup_workspace_directory_before_upgrade(path)
    changed = _migrate_workspace_catalog(catalog)
    if changed:
        _write_workspace_catalog_unlocked(path, catalog)
    return catalog


def _uses_readable_dataset_layout(store_dir: Path) -> bool:
    """判断目录是否使用 v6 可读布局；测试和旧调用仍可读取 v5 目录。"""
    if store_dir == WORKSPACE_STORE_PATH or store_dir.name.startswith(f".{WORKSPACE_STORE_PATH.name}."):
        return True
    try:
        manifest = json.loads((store_dir / WORKSPACE_STORE_VERSION_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        manifest = {}
    return (
        isinstance(manifest, Mapping)
        and manifest.get("kind") == "ct-scheduler-datasets"
    ) or any(store_dir.glob("*/metadata.json"))


def _read_workspace_catalog_directory(store_dir: Path) -> Dict[str, Any]:
    """根据目录清单读取 v6 可读布局或兼容的 v5 UUID 布局。"""
    if not _uses_readable_dataset_layout(store_dir):
        return _read_legacy_workspace_catalog_directory(store_dir)
    return _read_readable_workspace_catalog_directory(store_dir)


def _read_readable_workspace_catalog_directory(store_dir: Path) -> Dict[str, Any]:
    """扫描新版分层目录，组装供现有业务逻辑使用的完整设备目录。"""
    catalog = _empty_workspace_catalog()
    catalog["version"] = _read_workspace_store_version(store_dir)
    if not store_dir.is_dir():
        return catalog
    for device_dir in sorted(store_dir.iterdir()):
        if not device_dir.is_dir():
            continue
        metadata_file = device_dir / "metadata.json"
        device_file = device_dir / "device.json"
        if not metadata_file.is_file() or not device_file.is_file():
            continue
        try:
            raw_device = json.loads(metadata_file.read_text(encoding="utf-8"))
            init_data = json.loads(device_file.read_text(encoding="utf-8"))
            routes_payload = json.loads(
                (device_dir / "routes.json").read_text(encoding="utf-8")
            ) if (device_dir / "routes.json").is_file() else {}
            groups_payload = json.loads(
                (device_dir / "groups.json").read_text(encoding="utf-8")
            ) if (device_dir / "groups.json").is_file() else {}
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"设备文件无效：{device_file}") from error
        if not isinstance(raw_device, dict) or not isinstance(init_data, dict):
            continue
        init_options = raw_device.pop("initOptions", {})
        if isinstance(init_options, Mapping):
            init_data.update(deepcopy(dict(init_options)))
        raw_device["device"] = init_data
        raw_device["routes"] = (
            deepcopy(routes_payload.get("routes") or [])
            if isinstance(routes_payload, Mapping) else []
        )
        raw_device["cleans"] = (
            deepcopy(routes_payload.get("cleans") or [])
            if isinstance(routes_payload, Mapping) else []
        )
        raw_device["routeAliases"] = (
            deepcopy(routes_payload.get("routeAliases") or {})
            if isinstance(routes_payload, Mapping) else {}
        )
        raw_device["testGroups"] = (
            deepcopy(groups_payload.get("testGroups") or [])
            if isinstance(groups_payload, Mapping) else []
        )
        if isinstance(groups_payload, Mapping) and "robotSlots" in groups_payload:
            raw_device["robotSlots"] = deepcopy(groups_payload["robotSlots"])
        tests = []
        tests_dir = device_dir / "tests"
        if tests_dir.is_dir():
            for test_file in sorted(tests_dir.glob("*/test.json")):
                try:
                    raw_test = json.loads(test_file.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    raise ValueError(f"测试集文件无效：{test_file}") from error
                if isinstance(raw_test, dict):
                    tests.append(raw_test)
        raw_device["tests"] = tests
        catalog["devices"].append(raw_device)
    return catalog


def _read_legacy_workspace_catalog_directory(store_dir: Path) -> Dict[str, Any]:
    """只读旧版 UUID 目录，作为 v5 到 v6 的迁移输入。"""
    catalog = {"version": _read_workspace_store_version(store_dir), "devices": []}
    for device_dir in sorted(store_dir.iterdir()) if store_dir.is_dir() else []:
        device_file = device_dir / "device.json"
        if not device_file.is_file():
            continue
        try:
            raw_device = json.loads(device_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"旧设备文件无效：{device_file}") from error
        if not isinstance(raw_device, dict) or "device" not in raw_device:
            continue
        tests = []
        for test_file in sorted((device_dir / "tests").glob("*.json")):
            if test_file.name == WORKSPACE_TEST_INDEX_FILE:
                continue
            try:
                raw_test = json.loads(test_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ValueError(f"旧测试集文件无效：{test_file}") from error
            if isinstance(raw_test, dict):
                tests.append(raw_test)
        raw_device["tests"] = tests
        catalog["devices"].append(raw_device)
    return catalog


def _migrate_legacy_workspace_store(store_dir: Path) -> None:
    """把旧单文件存储迁移为拆分目录，迁移后旧文件保留为 ``*.legacy.json``。

    持锁调用；只处理确实存在的旧文件。迁移是幂等的：先清理可能存在的残留
    目录再重建，因此上次迁移中断后可以安全重入。迁移成功后旧文件改名，
    避免重复迁移；确认数据无误后可手动删除旧文件。
    """
    legacy_workspace_directory = _legacy_workspace_directory_path()
    if _has_separate_legacy_workspace_directory(store_dir):
        if store_dir.is_dir():
            if (
                not _uses_readable_dataset_layout(store_dir)
                or _read_workspace_store_version(store_dir) != WORKSPACE_STORE_VERSION
            ):
                raise ValueError(f"目标数据目录已存在且格式不完整，拒绝覆盖：{store_dir}")
        else:
            catalog = _read_legacy_workspace_catalog_directory(legacy_workspace_directory)
            _migrate_workspace_catalog(catalog)
            temporary_store = store_dir.with_name(f".{store_dir.name}.{uuid.uuid4().hex}.tmp")
            _write_workspace_catalog_directory(temporary_store, catalog)
            temporary_store.replace(store_dir)
        backup_root = DATA_DIR / "migration-backups"
        backup_root.mkdir(parents=True, exist_ok=True)
        backup_stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_name = f"workspaces-v5-{backup_stamp}"
        shutil.move(str(legacy_workspace_directory), str(backup_root / backup_name))
        legacy_device_mirrors = DATA_DIR / "devices"
        if legacy_device_mirrors.is_dir():
            shutil.move(
                str(legacy_device_mirrors),
                str(backup_root / f"device-mirrors-v5-{backup_stamp}"),
            )
        legacy_single_backup = DATA_DIR / "workspaces.json.legacy.json"
        if legacy_single_backup.is_file():
            shutil.move(
                str(legacy_single_backup),
                str(backup_root / f"workspaces-single-file-{backup_stamp}.legacy.json"),
            )
        return
    legacy_candidates = (DATA_DIR / "workspaces.json", LEGACY_WORKSPACE_STORE_PATH)
    for legacy_file in legacy_candidates:
        if not legacy_file.is_file():
            continue
        catalog = _read_workspace_catalog_unlocked(legacy_file)
        shutil.rmtree(store_dir, ignore_errors=True)
        _write_workspace_catalog_unlocked(store_dir, catalog)
        backup_path = legacy_file.with_name(f"{legacy_file.name}.legacy.json")
        legacy_file.replace(backup_path)
        return


def _write_text_atomic(path: Path, content: str) -> None:
    """原子写入 UTF-8 文本，避免异常退出留下半份文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        temporary_path.write_text(content, encoding="utf-8")
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _write_json_atomic(path: Path, payload: Any) -> None:
    """把 JSON 原子写入指定文件，避免异常退出留下半份配置。"""
    content = json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2)
    _write_text_atomic(path, content)


def save_model_checkpoint(filename: str, content: bytes) -> Path:
    """安全保存前端选取的模型文件，并返回算法运行时可读取的绝对路径。

    浏览器出于隐私保护不会提供用户选择文件的真实路径；因此将文件复制到本地
    服务的数据目录。文件名只保留 basename，避免请求头构造出目录穿越路径。
    """
    source_name = Path(filename).name.strip()
    suffix = Path(source_name).suffix.lower()
    if not source_name or suffix not in ALLOWED_CHECKPOINT_SUFFIXES:
        allowed = "、".join(sorted(ALLOWED_CHECKPOINT_SUFFIXES))
        raise ValueError(f"checkpoint 文件格式仅支持：{allowed}")
    if not content:
        raise ValueError("checkpoint 文件为空")
    if len(content) > MAX_CHECKPOINT_BYTES:
        raise ValueError("checkpoint 文件超过大小限制")
    safe_stem = re.sub(r"[^A-Za-z0-9._-]", "_", Path(source_name).stem).strip("._")
    if not safe_stem:
        safe_stem = "checkpoint"
    safe_name = f"{safe_stem[:96]}{suffix}"
    target = MODEL_CHECKPOINT_DIR / f"{uuid.uuid4().hex}-{safe_name}"
    with _MODEL_CHECKPOINT_LOCK:
        MODEL_CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.upload")
        try:
            temporary.write_bytes(content)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target.resolve()


def read_algorithm_metadata() -> Dict[str, Dict[str, str]]:
    """从算法仓库清单实时返回内置算法的名称和介绍。"""
    return {
        str(algorithm["strategy"]): {
            "name": str(algorithm["name"]),
            "introduction": str(algorithm["introduction"]),
        }
        for algorithm in discover_builtin_algorithms()
    }


def algorithm_metadata_for_health(
    builtin_algorithms: Optional[Sequence[Mapping[str, Any]]] = None,
    other_algorithms: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Dict[str, str]]:
    """返回健康检查使用的算法介绍，并补齐标准算法包的默认介绍。"""
    discovered_builtin_algorithms = (
        discover_builtin_algorithms()
        if builtin_algorithms is None
        else builtin_algorithms
    )
    metadata = {
        str(algorithm["strategy"]): {
            "name": str(algorithm["name"]),
            "introduction": str(algorithm["introduction"]),
        }
        for algorithm in discovered_builtin_algorithms
    }
    discovered_algorithms = (
        discover_other_algorithms()
        if other_algorithms is None
        else other_algorithms
    )
    for algorithm in discovered_algorithms:
        strategy = str(algorithm["strategy"])
        metadata.setdefault(strategy, {
            "name": str(algorithm["name"]),
            "introduction": "通过标准 init/update 接口接入的外部排程算法。",
        })
    return metadata


def format_reproduction_log(entries: Sequence[Mapping[str, Any]]) -> str:
    """生成顶层事件各占一行、同时保持可直接解析的 JSON 数组。"""
    event_lines = [
        json.dumps(entry, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        for entry in entries
    ]
    if not event_lines:
        return "[]"
    return "[\n" + ",\n".join(event_lines) + "\n]"


def _write_workspace_catalog_unlocked(path: Path, catalog: Mapping[str, Any]) -> None:
    """在调用方持锁时保存设备工作区目录。

    目录模式（``path`` 无后缀）把 catalog 拆分写为设备目录与测试集文件，
    便于单个测试集或设备直接拷贝分享；文件模式保留旧单文件格式。两种模式
    默认存储只维护 ``data/datasets`` 这一份设备事实来源。
    """
    if path.suffix == "":
        _write_workspace_catalog_directory(path, catalog)
        return
    _write_json_atomic(path, catalog)


def _write_json_if_changed(path: Path, payload: Any) -> None:
    """内容变化时才原子写入 JSON，避免全量重写覆盖他人刚更新的文件。"""
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        current = None
    if current != payload:
        _write_json_atomic(path, payload)


def _write_workspace_catalog_directory(store_dir: Path, catalog: Mapping[str, Any]) -> None:
    """按目录版本选择 v6 可读布局或兼容的 v5 UUID 布局。"""
    if not _uses_readable_dataset_layout(store_dir):
        _write_legacy_workspace_catalog_directory(store_dir, catalog)
        return
    _write_readable_workspace_catalog_directory(store_dir, catalog)


def _write_legacy_workspace_catalog_directory(
    store_dir: Path,
    catalog: Mapping[str, Any],
) -> None:
    """为旧测试夹具和显式非默认目录保留 v5 拆分写入能力。"""
    store_dir.mkdir(parents=True, exist_ok=True)
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, Mapping):
            continue
        device = deepcopy(dict(raw_device))
        device_id = str(device.get("id") or "").strip()
        if not device_id:
            continue
        tests = device.pop("tests", None)
        device_dir = store_dir / device_id
        device_dir.mkdir(parents=True, exist_ok=True)
        _write_json_if_changed(device_dir / "device.json", device)
        tests_dir = device_dir / "tests"
        tests_dir.mkdir(parents=True, exist_ok=True)
        for raw_test in tests or []:
            if not isinstance(raw_test, Mapping):
                continue
            test = dict(raw_test)
            test_id = str(test.get("id") or "").strip()
            if test_id:
                _write_json_if_changed(tests_dir / f"{test_id}.json", test)
        _write_json_if_changed(
            _workspace_test_index_path(tests_dir),
            [
                _workspace_test_summary(test_case)
                for test_case in tests or []
                if isinstance(test_case, Mapping)
            ],
        )
    _write_json_atomic(
        store_dir / WORKSPACE_STORE_VERSION_FILE,
        {"version": WORKSPACE_STORE_VERSION},
    )


def _write_readable_workspace_catalog_directory(
    store_dir: Path,
    catalog: Mapping[str, Any],
) -> None:
    """把目录写为“可读设备目录 + 纯 init + 路径 + 独立测试集”结构。"""
    store_dir.mkdir(parents=True, exist_ok=True)
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, Mapping):
            continue
        device = deepcopy(dict(raw_device))
        device_id = str(device.get("id") or "").strip()
        if not device_id:
            continue
        tests = device.pop("tests", None)
        existing_dir = _find_dataset_device_directory(store_dir, device_id)
        desired_dir = _dataset_device_directory(store_dir, device)
        if existing_dir is not None and existing_dir != desired_dir and not desired_dir.exists():
            existing_dir.replace(desired_dir)
        device_dir = desired_dir if desired_dir.exists() or existing_dir is None else existing_dir
        device_dir.mkdir(parents=True, exist_ok=True)
        init_data, init_options = _split_device_init_data(device.pop("device", {}))
        if init_options:
            device["initOptions"] = init_options
        else:
            device.pop("initOptions", None)
        routes_payload = {
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "routes": device.pop("routes", []),
            "cleans": device.pop("cleans", []),
            "routeAliases": device.pop("routeAliases", {}),
        }
        groups_payload = {
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "testGroups": device.pop("testGroups", []),
        }
        if "robotSlots" in device:
            groups_payload["robotSlots"] = device.pop("robotSlots")
        device["schemaVersion"] = WORKSPACE_STORE_VERSION
        _write_json_if_changed(device_dir / "metadata.json", device)
        _write_json_if_changed(device_dir / "device.json", init_data)
        _write_json_if_changed(device_dir / "routes.json", routes_payload)
        _write_json_if_changed(device_dir / "groups.json", groups_payload)
        tests_dir = device_dir / "tests"
        tests_dir.mkdir(parents=True, exist_ok=True)
        for raw_test in tests or []:
            if not isinstance(raw_test, Mapping):
                continue
            test = dict(raw_test)
            test_id = str(test.get("id") or "").strip()
            if not test_id:
                continue
            existing_test_file = _find_dataset_test_file(device_dir, test_id)
            desired_test_dir = _dataset_test_directory(tests_dir, test)
            if (
                existing_test_file is not None
                and existing_test_file.parent != desired_test_dir
                and not desired_test_dir.exists()
            ):
                existing_test_file.parent.replace(desired_test_dir)
            test_dir = (
                desired_test_dir
                if desired_test_dir.exists() or existing_test_file is None
                else existing_test_file.parent
            )
            test_dir.mkdir(parents=True, exist_ok=True)
            test["schemaVersion"] = WORKSPACE_STORE_VERSION
            _write_json_if_changed(test_dir / "test.json", test)
        _write_json_if_changed(
            _workspace_test_index_path(tests_dir),
            [
                _workspace_test_summary(test_case)
                for test_case in tests or []
                if isinstance(test_case, Mapping)
            ],
        )
    _write_workspace_store_version(store_dir)


def _remove_directory_test_file(store_dir: Path, device_id: str, test_id: str) -> None:
    """目录模式下物理删除单个测试集文件；文件模式为空操作。"""
    if store_dir.suffix == "":
        if _uses_readable_dataset_layout(store_dir):
            device_dir = _find_dataset_device_directory(store_dir, device_id)
            test_file = _find_dataset_test_file(device_dir, test_id) if device_dir else None
            if test_file is not None:
                shutil.rmtree(test_file.parent)
        else:
            (store_dir / device_id / "tests" / f"{test_id}.json").unlink(missing_ok=True)


def _remove_directory_device_dir(store_dir: Path, device_id: str) -> None:
    """目录模式下物理删除整个设备目录（含全部测试集文件）；文件模式为空操作。"""
    if store_dir.suffix == "":
        if _uses_readable_dataset_layout(store_dir):
            device_dir = _find_dataset_device_directory(store_dir, device_id)
            if device_dir is not None:
                shutil.rmtree(device_dir)
        else:
            shutil.rmtree(store_dir / device_id, ignore_errors=True)


def list_workspace_devices(path: Path = WORKSPACE_STORE_PATH) -> List[Dict[str, Any]]:
    """列出本地保存的设备摘要，不返回体积较大的 init 和测试集内容。"""
    with _workspace_catalog_guard(path):
        fast_devices = _fast_list_workspace_devices_unlocked(path)
        if fast_devices is not None:
            return fast_devices
        catalog = _read_workspace_catalog_unlocked(path)
        return [{
            "id": str(device.get("id") or ""),
            "name": str(device.get("name") or "未命名设备"),
            "testCount": len(device.get("tests") or []),
            "updatedAt": device.get("updatedAt"),
        } for device in catalog["devices"] if isinstance(device, Mapping)]


def _fast_list_workspace_devices_unlocked(
    path: Path,
) -> Optional[List[Dict[str, Any]]]:
    """只读取设备元数据与测试摘要索引，生成设备列表。

    Args:
        path: 已由调用方加锁的工作区目录。

    Returns:
        当前 v6 目录可按需读取时返回设备摘要；目录不完整时返回 ``None``，
        由调用方进入兼容的完整读取与修复流程。
    """
    if not _workspace_store_is_current(path) or not _uses_readable_dataset_layout(path):
        return None
    devices: List[Dict[str, Any]] = []
    try:
        for device_dir in sorted(path.iterdir()):
            if not device_dir.is_dir():
                continue
            metadata = json.loads(
                (device_dir / "metadata.json").read_text(encoding="utf-8")
            )
            summaries = json.loads(
                _workspace_test_index_path(device_dir / "tests").read_text(
                    encoding="utf-8"
                )
            )
            if not isinstance(metadata, Mapping) or not isinstance(summaries, list):
                return None
            devices.append({
                "id": str(metadata.get("id") or ""),
                "name": str(metadata.get("name") or "未命名设备"),
                "testCount": len(summaries),
                "updatedAt": metadata.get("updatedAt"),
            })
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    return devices


def get_workspace_device(device_id: str, path: Path = WORKSPACE_STORE_PATH) -> Dict[str, Any]:
    """读取一个设备及其全部测试集，设备不存在时抛出明确错误。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        return deepcopy(dict(device))


def _workspace_test_summary(test_case: Mapping[str, Any]) -> Dict[str, Any]:
    """返回设备切换所需的测试选择信息，不携带完整排程数据。"""
    return {
        "id": str(test_case.get("id") or ""),
        "name": str(test_case.get("name") or "未命名测试集"),
        "group": str(test_case.get("group") or ""),
    }


def _normalized_route_aliases(raw_aliases: Any) -> Dict[str, str]:
    """规范化 Route 自动改名链，丢弃空值与无意义的自映射。"""
    return {
        str(old_name): str(new_name)
        for old_name, new_name in (
            raw_aliases.items() if isinstance(raw_aliases, Mapping) else []
        )
        if str(old_name) and str(new_name) and str(old_name) != str(new_name)
    }


def _resolve_route_alias(route_name: str, aliases: Mapping[str, str]) -> str:
    """沿自动改名链得到最新模板名；异常循环保持原名以避免破坏历史数据。"""
    current = route_name
    visited = {current}
    while current in aliases:
        next_name = str(aliases[current] or "")
        if not next_name or next_name in visited:
            return route_name
        visited.add(next_name)
        current = next_name
    return current


def _apply_route_aliases_to_test(test_case: Dict[str, Any], aliases: Mapping[str, str]) -> None:
    """在读取时延迟应用模板改名，避免保存时重写每个历史测试文件。"""
    if not aliases:
        return
    for round_row in test_case.get("rounds") or []:
        if not isinstance(round_row, Mapping):
            continue
        for cjob in round_row.get("cjobs") or []:
            if not isinstance(cjob, Mapping):
                continue
            for pjob in cjob.get("pjobs") or []:
                if not isinstance(pjob, dict):
                    continue
                route_ref = str(pjob.get("routeRef") or "")
                pjob["routeRef"] = _resolve_route_alias(route_ref, aliases)
    route_configs = test_case.get("routeConfigs")
    if not isinstance(route_configs, dict):
        return
    for old_name in list(route_configs):
        new_name = _resolve_route_alias(str(old_name), aliases)
        if new_name == old_name:
            continue
        if new_name not in route_configs:
            route_configs[new_name] = route_configs[old_name]
        route_configs.pop(old_name, None)


def _fast_workspace_device_overview_unlocked(
    device_id: str,
    path: Path,
) -> Optional[Dict[str, Any]]:
    """从已迁移的目录存储读取设备和测试摘要，不解析所有完整测试文件。"""
    if (
        path.suffix
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
        or not _workspace_store_is_current(path)
    ):
        return None
    readable_layout = _uses_readable_dataset_layout(path)
    device_dir = (
        _find_dataset_device_directory(path, device_id)
        if readable_layout else path / device_id
    )
    if device_dir is None:
        return None
    device_file = device_dir / "device.json"
    tests_dir = device_dir / "tests"
    try:
        if readable_layout:
            device = json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
            init_data = json.loads(device_file.read_text(encoding="utf-8"))
            routes_payload = json.loads((device_dir / "routes.json").read_text(encoding="utf-8"))
            groups_payload = json.loads((device_dir / "groups.json").read_text(encoding="utf-8"))
        else:
            device = json.loads(device_file.read_text(encoding="utf-8"))
        summaries = json.loads(
            _workspace_test_index_path(tests_dir).read_text(encoding="utf-8")
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(device, dict) or not isinstance(summaries, list):
        return None
    if not all(isinstance(summary, Mapping) for summary in summaries):
        return None
    if readable_layout:
        if not all(isinstance(value, Mapping) for value in (init_data, routes_payload, groups_payload)):
            return None
        init_options = device.pop("initOptions", {})
        if isinstance(init_options, Mapping):
            init_data.update(deepcopy(dict(init_options)))
        device["device"] = init_data
        device["routes"] = deepcopy(routes_payload.get("routes") or [])
        device["cleans"] = deepcopy(routes_payload.get("cleans") or [])
        device["routeAliases"] = deepcopy(routes_payload.get("routeAliases") or {})
        device["testGroups"] = deepcopy(groups_payload.get("testGroups") or [])
        if "robotSlots" in groups_payload:
            device["robotSlots"] = deepcopy(groups_payload["robotSlots"])
    device["tests"] = [
        _workspace_test_summary(summary) for summary in summaries
    ]
    return device


def get_workspace_device_overview(
    device_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """读取设备拓扑、共享模板和测试摘要；完整测试在选中时按需读取。"""
    with _workspace_catalog_guard(path):
        overview = _fast_workspace_device_overview_unlocked(device_id, path)
        if overview is not None:
            return overview
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        summaries = [
            _workspace_test_summary(test_case)
            for test_case in device.get("tests") or []
            if isinstance(test_case, Mapping)
        ]
        overview = deepcopy(dict(device))
        overview["tests"] = summaries
        return overview


def get_workspace_test(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """读取指定设备中的单个完整测试集，供前端延迟加载。"""
    with _workspace_catalog_guard(path):
        if (
            not path.suffix
            and re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
            and _workspace_store_is_current(path)
            and re.fullmatch(r"[A-Za-z0-9_-]+", test_id)
        ):
            readable_layout = _uses_readable_dataset_layout(path)
            device_dir = (
                _find_dataset_device_directory(path, device_id)
                if readable_layout else path / device_id
            )
            try:
                test_file = (
                    _find_dataset_test_file(device_dir, test_id)
                    if readable_layout and device_dir is not None
                    else path / device_id / "tests" / f"{test_id}.json"
                )
                if test_file is None:
                    raise FileNotFoundError(test_id)
                test_case = json.loads(test_file.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                test_case = None
            if isinstance(test_case, dict) and str(test_case.get("id") or "") == test_id:
                try:
                    aliases_file = (
                        device_dir / "routes.json"
                        if readable_layout and device_dir is not None
                        else path / device_id / "device.json"
                    )
                    device = json.loads(aliases_file.read_text(encoding="utf-8"))
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    device = {}
                _apply_route_aliases_to_test(
                    test_case,
                    _normalized_route_aliases(device.get("routeAliases"))
                    if isinstance(device, Mapping) else {},
                )
                return test_case
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        test_case = next((
            item for item in device.get("tests") or []
            if isinstance(item, Mapping) and str(item.get("id") or "") == test_id
        ), None)
        if test_case is None:
            raise ValueError(f"测试集不存在：{test_id}")
        resolved = deepcopy(dict(test_case))
        _apply_route_aliases_to_test(
            resolved, _normalized_route_aliases(device.get("routeAliases")),
        )
        return resolved


def get_workspace_run_context(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """按需读取单测运行所需的设备概览和目标测试。

    参数 ``device_id`` 和 ``test_id`` 分别标识设备与测试；返回不含其他完整
    测试的设备上下文及目标测试。该边界供单测运行接口使用，避免点击运行时退回
    到读取整台设备全部 ``test.json`` 的旧目录路径。
    """
    device = get_workspace_device_overview(device_id, path)
    test_case = get_workspace_test(device_id, test_id, path)
    return device, test_case


def _zip_json_bytes(files: Mapping[str, Any]) -> bytes:
    """把若干 JSON 对象写入内存 ZIP，供设备和测试集交换。"""
    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        for filename, payload in files.items():
            archive.writestr(
                filename,
                json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2),
            )
    return stream.getvalue()


def _read_exchange_archive(content: bytes) -> Dict[str, Any]:
    """读取受限交换包；拒绝路径穿越、重复文件和超大解压内容。"""
    try:
        archive = ZipFile(BytesIO(content), "r")
    except Exception as error:  # noqa: BLE001
        raise ValueError("导入文件不是有效的 CT 数据包") from error
    files: Dict[str, Any] = {}
    total_size = 0
    with archive:
        for info in archive.infolist():
            normalized = info.filename.replace("\\", "/").strip("/")
            if (
                not normalized
                or normalized in files
                or normalized.startswith("../")
                or "/../" in f"/{normalized}/"
                or info.is_dir()
            ):
                raise ValueError("导入包包含无效或重复路径")
            total_size += info.file_size
            if total_size > DATA_EXCHANGE_MAX_BYTES:
                raise ValueError("导入包解压后超过 64 MB 限制")
            try:
                payload = json.loads(archive.read(info).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"导入包中的 JSON 无效：{normalized}") from error
            files[normalized] = payload
    manifest = files.get("manifest.json")
    if not isinstance(manifest, Mapping):
        raise ValueError("导入包缺少 manifest.json")
    version = int(manifest.get("schemaVersion") or 0)
    if version != WORKSPACE_STORE_VERSION:
        if version > WORKSPACE_STORE_VERSION:
            raise ValueError(f"数据包版本 v{version} 高于当前支持的 v{WORKSPACE_STORE_VERSION}")
        raise ValueError(f"不支持数据包版本 v{version}，请先用对应版本平台升级")
    files["manifest.json"] = dict(manifest)
    return files


def _exchange_metadata(device: Mapping[str, Any]) -> Dict[str, Any]:
    """提取设备元数据，排除 init、路径和测试内容。"""
    excluded = {"device", "routes", "cleans", "routeAliases", "testGroups", "robotSlots", "tests"}
    metadata = {
        key: deepcopy(value)
        for key, value in device.items()
        if key not in excluded
    }
    metadata["schemaVersion"] = WORKSPACE_STORE_VERSION
    return metadata


def _exchange_routes(device: Mapping[str, Any], route_names: Optional[set[str]] = None) -> Dict[str, Any]:
    """提取设备路径；测试集交换只携带实际引用的路径。"""
    routes = [
        deepcopy(route) for route in (device.get("routes") or [])
        if isinstance(route, Mapping)
        and (route_names is None or str(route.get("name") or "") in route_names)
    ]
    return {
        "schemaVersion": WORKSPACE_STORE_VERSION,
        "routes": routes,
        "cleans": deepcopy(device.get("cleans") or []) if route_names is None else [],
        "routeAliases": deepcopy(device.get("routeAliases") or {}) if route_names is None else {},
    }


def export_workspace_device(
    device_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[bytes, str]:
    """导出设备 init、路径、组别及全部测试集的自包含交换包。"""
    device = get_workspace_device(device_id, path)
    init_data, init_options = _split_device_init_data(device.get("device") or {})
    metadata = _exchange_metadata(device)
    if init_options:
        metadata["initOptions"] = init_options
    files: Dict[str, Any] = {
        "manifest.json": {
            "kind": DATA_EXCHANGE_KIND_DEVICE,
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "deviceId": device_id,
            "deviceFingerprint": _device_fingerprint(init_data),
        },
        "metadata.json": metadata,
        "device.json": init_data,
        "routes.json": _exchange_routes(device),
        "groups.json": {
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "testGroups": deepcopy(device.get("testGroups") or []),
            "robotSlots": deepcopy(device.get("robotSlots") or {}),
        },
    }
    for test_case in device.get("tests") or []:
        if not isinstance(test_case, Mapping):
            continue
        test_dir = _uuid_storage_segment(str(test_case.get("id") or ""))
        files[f"tests/{test_dir}/test.json"] = deepcopy(dict(test_case))
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(device.get("name") or "device")).strip("-") or "device"
    return _zip_json_bytes(files), f"ct-device-{safe_name}-v{WORKSPACE_STORE_VERSION}.zip"


def export_workspace_test(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[bytes, str]:
    """导出单个测试及其引用路径；导入时必须匹配设备 init 指纹。"""
    device = get_workspace_device(device_id, path)
    test_case = next((
        test for test in device.get("tests") or []
        if isinstance(test, Mapping) and str(test.get("id") or "") == test_id
    ), None)
    if test_case is None:
        raise ValueError(f"测试集不存在：{test_id}")
    route_names = _workspace_test_route_refs(test_case)
    files = {
        "manifest.json": {
            "kind": DATA_EXCHANGE_KIND_TEST,
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "deviceFingerprint": _device_fingerprint(device.get("device") or {}),
            "sourceDeviceName": str(device.get("name") or "未命名设备"),
        },
        "routes.json": _exchange_routes(device, route_names),
        "test.json": deepcopy(dict(test_case)),
    }
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(test_case.get("name") or "test")).strip("-") or "test"
    return _zip_json_bytes(files), f"ct-test-{safe_name}-v{WORKSPACE_STORE_VERSION}.zip"


def _merge_exchange_routes(device: Dict[str, Any], imported_routes: Any) -> None:
    """合并交换包路径；同名不同内容时拒绝，避免测试被静默改义。"""
    routes = [route for route in (device.get("routes") or []) if isinstance(route, Mapping)]
    by_name = {str(route.get("name") or ""): route for route in routes}
    for raw_route in imported_routes or []:
        if not isinstance(raw_route, Mapping):
            continue
        route = deepcopy(dict(raw_route))
        name = str(route.get("name") or "").strip()
        if not name:
            raise ValueError("导入包包含未命名路径")
        existing = by_name.get(name)
        if existing is not None and existing != route:
            raise ValueError(f"路径“{name}”与本地同名路径内容不同，已停止导入")
        if existing is None:
            routes.append(route)
            by_name[name] = route
    device["routes"] = routes


def _merge_exchange_named_assets(
    device: Dict[str, Any],
    field_name: str,
    imported_assets: Any,
    label: str,
) -> None:
    """按名称安全合并设备级资产，同名不同内容时停止导入。"""
    assets = [asset for asset in (device.get(field_name) or []) if isinstance(asset, Mapping)]
    by_name = {str(asset.get("name") or ""): asset for asset in assets}
    for raw_asset in imported_assets or []:
        if not isinstance(raw_asset, Mapping):
            continue
        asset = deepcopy(dict(raw_asset))
        name = str(asset.get("name") or "").strip()
        if not name:
            raise ValueError(f"导入包包含未命名{label}")
        existing = by_name.get(name)
        if existing is not None and existing != asset:
            raise ValueError(f"{label}“{name}”与本地同名内容不同，已停止导入")
        if existing is None:
            assets.append(asset)
            by_name[name] = asset
    device[field_name] = assets


def _append_imported_test(device: Dict[str, Any], raw_test: Mapping[str, Any]) -> Tuple[Dict[str, Any], bool]:
    """安全加入一个测试；相同内容跳过，ID 冲突时创建可读副本。"""
    imported = deepcopy(dict(raw_test))
    imported.pop("schemaVersion", None)
    tests = [test for test in (device.get("tests") or []) if isinstance(test, dict)]
    imported_id = str(imported.get("id") or "").strip() or uuid.uuid4().hex
    existing = next((test for test in tests if str(test.get("id") or "") == imported_id), None)
    if existing is not None:
        comparable_existing = deepcopy(existing)
        comparable_existing.pop("schemaVersion", None)
        if comparable_existing == imported:
            return deepcopy(existing), False
    if existing is not None:
        imported_id = uuid.uuid4().hex
        imported["name"] = _unique_workspace_name(
            str(imported.get("name") or "未命名测试集"),
            (str(test.get("name") or "") for test in tests),
        )
    imported["id"] = imported_id
    imported["updatedAt"] = _workspace_timestamp()
    imported.setdefault("createdAt", imported["updatedAt"])
    tests.append(imported)
    device["tests"] = tests
    return deepcopy(imported), True


def import_workspace_test_archive(
    device_id: str,
    content: bytes,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], bool]:
    """把测试交换包导入指定设备，并严格校验设备拓扑一致。"""
    files = _read_exchange_archive(content)
    manifest = files["manifest.json"]
    if manifest.get("kind") != DATA_EXCHANGE_KIND_TEST:
        raise ValueError("所选文件不是测试集交换包")
    test_case = files.get("test.json")
    routes_payload = files.get("routes.json") or {}
    if not isinstance(test_case, Mapping) or not isinstance(routes_payload, Mapping):
        raise ValueError("测试集交换包内容不完整")
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, dict) and str(item.get("id") or "") == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        fingerprint = _device_fingerprint(device.get("device") or {})
        if fingerprint != str(manifest.get("deviceFingerprint") or ""):
            raise ValueError("测试集所属设备与当前设备不一致，请先切换到相同设备")
        _merge_exchange_routes(device, routes_payload.get("routes"))
        imported, created = _append_imported_test(device, test_case)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return imported, created


def import_workspace_device_archive(
    content: bytes,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], int, int]:
    """导入完整设备包；相同设备合并路径、组别和测试，不静默覆盖冲突。"""
    files = _read_exchange_archive(content)
    manifest = files["manifest.json"]
    if manifest.get("kind") != DATA_EXCHANGE_KIND_DEVICE:
        raise ValueError("所选文件不是设备交换包")
    metadata = files.get("metadata.json")
    init_data = files.get("device.json")
    routes_payload = files.get("routes.json") or {}
    groups_payload = files.get("groups.json") or {}
    if not all(isinstance(item, Mapping) for item in (metadata, init_data, routes_payload, groups_payload)):
        raise ValueError("设备交换包内容不完整")
    pure_init_data, packaged_init_options = _split_device_init_data(init_data)
    metadata_init_options = metadata.get("initOptions") or {}
    if not isinstance(metadata_init_options, Mapping):
        raise ValueError("设备交换包的 initOptions 无效")
    init_options = {
        **deepcopy(dict(packaged_init_options)),
        **deepcopy(dict(metadata_init_options)),
    }
    fingerprint = _device_fingerprint(pure_init_data)
    if fingerprint != str(manifest.get("deviceFingerprint") or ""):
        raise ValueError("设备交换包的 init 指纹校验失败")
    imported_tests = [
        value for name, value in files.items()
        if name.startswith("tests/") and name.endswith("/test.json") and isinstance(value, Mapping)
    ]
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, dict)
            and _device_fingerprint(item.get("device") or {}) == fingerprint
        ), None)
        created_device = 0
        if device is None:
            if len(catalog["devices"]) >= MAX_WORKSPACE_DEVICE_COUNT:
                raise ValueError(
                    f"设备数量不能超过 {MAX_WORKSPACE_DEVICE_COUNT} 台"
                )
            device = deepcopy(dict(metadata))
            device.pop("schemaVersion", None)
            device.pop("initOptions", None)
            occupied_ids = {str(item.get("id") or "") for item in catalog["devices"] if isinstance(item, Mapping)}
            if not str(device.get("id") or "") or str(device.get("id")) in occupied_ids:
                device["id"] = uuid.uuid4().hex
            device["name"] = _unique_workspace_name(
                str(device.get("name") or "未命名设备"),
                (str(item.get("name") or "") for item in catalog["devices"] if isinstance(item, Mapping)),
            )
            device["device"] = {**deepcopy(pure_init_data), **init_options}
            device["routes"] = []
            device["cleans"] = deepcopy(routes_payload.get("cleans") or [])
            device["routeAliases"] = deepcopy(routes_payload.get("routeAliases") or {})
            device["testGroups"] = deepcopy(groups_payload.get("testGroups") or [])
            device["robotSlots"] = deepcopy(groups_payload.get("robotSlots") or {})
            device["tests"] = []
            catalog["devices"].append(device)
            created_device = 1
        elif init_options:
            local_init, local_options = _split_device_init_data(device.get("device") or {})
            for key, value in init_options.items():
                if key in local_options and local_options[key] != value:
                    raise ValueError(f"设备初始化选项“{key}”与本地定义不同，已停止导入")
                local_options[key] = deepcopy(value)
            device["device"] = {**local_init, **local_options}
        _merge_exchange_routes(device, routes_payload.get("routes"))
        _merge_exchange_named_assets(
            device, "cleans", routes_payload.get("cleans"), "Clean",
        )
        local_aliases = _normalized_route_aliases(device.get("routeAliases"))
        for old_name, new_name in _normalized_route_aliases(
            routes_payload.get("routeAliases")
        ).items():
            if old_name in local_aliases and local_aliases[old_name] != new_name:
                raise ValueError(f"路径别名“{old_name}”与本地定义不同，已停止导入")
            local_aliases[old_name] = new_name
        device["routeAliases"] = local_aliases
        for group in groups_payload.get("testGroups") or []:
            group_name = str(group).strip()
            if group_name and group_name not in device.setdefault("testGroups", []):
                device["testGroups"].append(group_name)
        imported_robot_slots = groups_payload.get("robotSlots")
        if imported_robot_slots:
            local_robot_slots = device.get("robotSlots")
            if local_robot_slots and local_robot_slots != imported_robot_slots:
                raise ValueError("设备包的 Robot 槽位配置与本地不同，已停止导入")
            device["robotSlots"] = deepcopy(imported_robot_slots)
        imported_count = 0
        for test_case in imported_tests:
            _, created = _append_imported_test(device, test_case)
            imported_count += int(created)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(device), created_device, imported_count


def delete_workspace_device(device_id: str, path: Path = WORKSPACE_STORE_PATH) -> Dict[str, Any]:
    """从本地工作区删除一台设备及其全部测试集，并返回被删除设备的摘要。

    设备删除后不可恢复：目录模式会移除设备 UUID 目录及其中全部测试集。
    设备不存在时抛出明确错误；已被历史批量任务引用的设备不会
    改写历史记录。
    """
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        catalog["devices"] = [
            item for item in catalog["devices"]
            if not (isinstance(item, Mapping) and str(item.get("id")) == device_id)
        ]
        # 先物理删除设备目录再写目录：即使中途中断，下次扫描也不会复活该设备。
        _remove_directory_device_dir(path, device_id)
        _write_workspace_catalog_unlocked(path, catalog)
        return {
            "id": device_id,
            "name": str(device.get("name") or "未命名设备"),
            "testCount": len(device.get("tests") or []),
        }


def robot_available_slots(robot: Mapping[str, Any]) -> List[int]:
    """返回机器手可配置的 Arm 槽位编号。

    ``ArmInfo.*.SlotIDs`` 是实际 Arm 定义。只要存在 ArmInfo，编辑器就允许在单臂与
    双臂间切换；``CanMultiTrans`` 不参与臂数判断，Robot 本身也不写入 Slot。
    """
    slots: set[int] = set()

    def add_slots(raw_slots: Any, *, scalar_is_capacity: bool = False) -> None:
        """把一种槽位表达加入集合，忽略布尔值和非正整数。"""
        if isinstance(raw_slots, bool):
            return
        if isinstance(raw_slots, int):
            values = (
                range(FIRST_ROBOT_SLOT_ID, raw_slots + FIRST_ROBOT_SLOT_ID)
                if scalar_is_capacity else [raw_slots]
            )
        elif isinstance(raw_slots, Mapping):
            values = raw_slots.keys()
        elif isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
            values = raw_slots
        else:
            return
        for value in values:
            try:
                slot_id = int(value)
            except (TypeError, ValueError):
                continue
            if slot_id >= FIRST_ROBOT_SLOT_ID:
                slots.add(slot_id)

    arm_info = robot.get("ArmInfo")
    if isinstance(arm_info, Mapping):
        for arm in arm_info.values():
            if isinstance(arm, Mapping):
                add_slots(arm.get("SlotIDs"))
        if any(isinstance(arm, Mapping) for arm in arm_info.values()):
            slots.update(range(FIRST_ROBOT_SLOT_ID, DUAL_ARM_SLOT_COUNT + FIRST_ROBOT_SLOT_ID))
    add_slots(robot.get("Capacity"), scalar_is_capacity=True)
    return sorted(slots or {FIRST_ROBOT_SLOT_ID})


def robot_default_slots(robot: Mapping[str, Any]) -> List[int]:
    """按原始 ``ArmInfo`` 返回设备文件默认启用的 Arm 槽位。"""
    selected: set[int] = set()
    available = robot_available_slots(robot)
    arm_info = robot.get("ArmInfo")
    if isinstance(arm_info, Mapping):
        for arm in arm_info.values():
            if not isinstance(arm, Mapping) or arm.get("IsEnable") is False:
                continue
            raw_slots = arm.get("SlotIDs")
            if not isinstance(raw_slots, Sequence) or isinstance(raw_slots, (str, bytes)):
                continue
            for value in raw_slots:
                try:
                    selected.add(int(value))
                except (TypeError, ValueError):
                    continue
    explicit = sorted(
        slot_id
        for slot_id in selected
        if slot_id >= FIRST_ROBOT_SLOT_ID and slot_id in available
    )
    return explicit or available[:1]


def _project_robot_arm_to_slots(
    arm_name: str,
    source_arm: Mapping[str, Any],
    slot_ids: Sequence[int],
) -> Dict[str, Any]:
    """复制一个物理 Arm，并保留所选的一个或多个 RobotSlot。"""
    arm = deepcopy(dict(source_arm))
    arm["Name"] = arm_name
    arm["IsEnable"] = True
    selected = sorted({int(slot_id) for slot_id in slot_ids})
    arm["SlotIDs"] = selected
    slot_station_map = arm.get("SlotsStationMap")
    if isinstance(slot_station_map, dict):
        for station_name, station_slots in list(slot_station_map.items()):
            if not isinstance(station_slots, Mapping) or not station_slots:
                continue
            fallback = next(iter(station_slots.values()))
            slot_station_map[station_name] = {
                str(slot_id): deepcopy(station_slots.get(str(slot_id), fallback))
                for slot_id in selected
            }
    return arm


def _generated_robot_arm_name(existing_names: Iterable[str], slot_id: int) -> str:
    """为设备文件缺少的第二个 Arm 生成稳定且不冲突的名称。"""
    occupied = {str(name) for name in existing_names}
    alphabetic_name = f"Arm{chr(ord('A') + slot_id - FIRST_ROBOT_SLOT_ID)}"
    if alphabetic_name not in occupied:
        return alphabetic_name
    numeric_name = f"Arm{slot_id}"
    if numeric_name not in occupied:
        return numeric_name
    suffix = slot_id
    while f"{numeric_name}_{suffix}" in occupied:
        suffix += 1
    return f"{numeric_name}_{suffix}"


def normalize_robot_slot_selection(
    device_data: Mapping[str, Any],
    raw_selection: Any,
) -> Dict[str, List[int]]:
    """校验并补齐每台机器手的槽位选择。

    未显式配置的机器手沿用原始 ``ArmInfo`` 默认模式。配置必须至少保留一个槽位，且不能
    引用设备能力之外的槽位或未知机器手。
    """
    robots = device_data.get("Robots")
    if not isinstance(robots, Mapping):
        raise ValueError("设备文件必须包含 Robots")
    selection = raw_selection if isinstance(raw_selection, Mapping) else {}
    unknown_names = sorted(str(name) for name in selection if str(name) not in robots)
    if unknown_names:
        raise ValueError(f"机器手不存在：{', '.join(unknown_names)}")
    normalized: Dict[str, List[int]] = {}
    for robot_name, raw_robot in robots.items():
        if not isinstance(raw_robot, Mapping):
            continue
        available = robot_available_slots(raw_robot)
        raw_slots = selection.get(robot_name, robot_default_slots(raw_robot))
        if not isinstance(raw_slots, Sequence) or isinstance(raw_slots, (str, bytes)):
            raise ValueError(f"{robot_name} 的槽位配置必须是数组")
        selected = sorted({
            int(slot_id)
            for slot_id in raw_slots
            if not isinstance(slot_id, bool)
            and isinstance(slot_id, (int, float))
            and float(slot_id).is_integer()
        })
        if not selected:
            raise ValueError(f"{robot_name} 至少需要保留一个可用槽位")
        unavailable = [slot_id for slot_id in selected if slot_id not in available]
        if unavailable:
            raise ValueError(
                f"{robot_name} 不支持槽位：{', '.join(map(str, unavailable))}"
            )
        normalized[str(robot_name)] = selected
    return normalized


def apply_robot_slot_selection(
    device_data: Dict[str, Any],
    raw_selection: Any,
) -> Dict[str, List[int]]:
    """将 Arm 槽位选择投影到运行时 ``ArmInfo`` 并返回规范化结果。

    同一原始 Arm 的多个 SlotID 保持在同一个 Arm 下，因此双腔设备的一条物理臂可继续
    同时承载两片晶圆。投影只调整 ``Capacity`` 与 ``ArmInfo``，不会创建 Robot.Slot，
    也不会改写与 Arm 数量无关的 ``CanMultiTrans``。
    """
    normalized = normalize_robot_slot_selection(device_data, raw_selection)
    robots = device_data.get("Robots")
    if not isinstance(robots, dict):
        return normalized
    for robot_name, selected in normalized.items():
        robot = robots.get(robot_name)
        if not isinstance(robot, dict):
            continue
        robot["Capacity"] = len(selected)
        arm_info = robot.get("ArmInfo")
        if not isinstance(arm_info, dict):
            continue
        source_arms = [
            (str(arm_name), arm)
            for arm_name, arm in arm_info.items()
            if isinstance(arm, Mapping)
        ]
        if not source_arms:
            continue
        projected_arms: Dict[str, Dict[str, Any]] = {}
        unmatched_slots = set(selected)
        for arm_name, source_arm in source_arms:
            source_slots = {
                int(value)
                for value in (source_arm.get("SlotIDs") or [])
                if isinstance(value, int) and not isinstance(value, bool)
            }
            retained_slots = sorted(unmatched_slots.intersection(source_slots))
            if not retained_slots:
                continue
            projected_arms[arm_name] = _project_robot_arm_to_slots(
                arm_name, source_arm, retained_slots,
            )
            unmatched_slots.difference_update(retained_slots)
        for slot_id in sorted(unmatched_slots):
            arm_name = _generated_robot_arm_name(
                [*arm_info.keys(), *projected_arms.keys()], slot_id,
            )
            projected_arms[arm_name] = _project_robot_arm_to_slots(
                arm_name, source_arms[0][1], [slot_id],
            )
        robot["ArmInfo"] = projected_arms
    return normalized


def update_workspace_robot_slots(
    device_id: str,
    raw_selection: Any,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, List[int]]:
    """保存设备级机器手槽位选择，并使依赖旧拓扑的 Baseline 失效。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        device_data = device.get("device")
        if not isinstance(device_data, Mapping):
            raise ValueError("设备拓扑无效")
        normalized = normalize_robot_slot_selection(device_data, raw_selection)
        device["robotSlots"] = normalized
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(normalized)


def _device_time_value(raw_value: Any, label: str) -> float:
    """把设备时间规范为非负有限秒数；无效值使用带字段上下文的错误拒绝。"""
    if isinstance(raw_value, bool):
        raise ValueError(f"{label} 必须是非负秒数")
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} 必须是非负秒数") from None
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} 必须是非负有限秒数")
    return value


def _apply_time_mapping_updates(
    target: Dict[str, Any],
    raw_values: Any,
    label: str,
) -> None:
    """校验并覆盖已有计时映射，禁止借时间接口新增未知 Robot、Station 或 Slot。"""
    if not isinstance(raw_values, Mapping):
        raise ValueError(f"{label} 必须是对象")
    unknown_keys = sorted(str(key) for key in raw_values if str(key) not in target)
    if unknown_keys:
        raise ValueError(f"{label} 包含未知项：{', '.join(unknown_keys)}")
    for key, raw_value in raw_values.items():
        normalized_key = str(key)
        target[normalized_key] = _device_time_value(
            raw_value,
            f"{label}.{normalized_key}",
        )


def _apply_time_sequence_updates(
    target: List[Any],
    raw_values: Any,
    label: str,
) -> None:
    """按原设备声明顺序覆盖转移时间，仅修改每条记录的 Time 并保留其余协议字段。"""
    if not isinstance(raw_values, Sequence) or isinstance(raw_values, (str, bytes)):
        raise ValueError(f"{label} 必须是数组")
    if len(raw_values) != len(target):
        raise ValueError(f"{label} 数量与设备定义不一致")
    for index, raw_value in enumerate(raw_values):
        row = target[index]
        if not isinstance(row, dict):
            raise ValueError(f"{label}[{index}] 不是有效计时记录")
        row["Time"] = _device_time_value(raw_value, f"{label}[{index}].Time")


def apply_device_timing_updates(device_data: Dict[str, Any], raw_timing: Any) -> None:
    """把页面提交的站点与机器手时间应用到设备拓扑，并严格限制可编辑字段。"""
    if not isinstance(raw_timing, Mapping):
        raise ValueError("设备时间配置必须是对象")
    sections = {
        "stations": (
            device_data.get("Stations"),
            STATION_TIME_MAPPING_FIELDS,
            STATION_TIME_SEQUENCE_FIELDS,
        ),
        "robots": (
            device_data.get("Robots"),
            ROBOT_TIME_MAPPING_FIELDS,
            ROBOT_TIME_SEQUENCE_FIELDS,
        ),
    }
    unknown_sections = sorted(str(key) for key in raw_timing if str(key) not in sections)
    if unknown_sections:
        raise ValueError(f"设备时间配置包含未知分类：{', '.join(unknown_sections)}")

    for section_name, raw_items in raw_timing.items():
        topology_items, mapping_fields, sequence_fields = sections[str(section_name)]
        if not isinstance(topology_items, dict):
            raise ValueError(f"设备缺少 {section_name} 定义")
        if not isinstance(raw_items, Mapping):
            raise ValueError(f"{section_name} 时间配置必须是对象")
        unknown_names = sorted(str(name) for name in raw_items if str(name) not in topology_items)
        if unknown_names:
            raise ValueError(f"{section_name} 包含未知设备：{', '.join(unknown_names)}")
        for item_name, raw_fields in raw_items.items():
            normalized_name = str(item_name)
            target_item = topology_items[normalized_name]
            if not isinstance(target_item, dict) or not isinstance(raw_fields, Mapping):
                raise ValueError(f"{section_name}.{normalized_name} 时间配置无效")
            supported_fields = mapping_fields | sequence_fields
            unknown_fields = sorted(
                str(field_name)
                for field_name in raw_fields
                if str(field_name) not in supported_fields
            )
            if unknown_fields:
                raise ValueError(
                    f"{section_name}.{normalized_name} 包含不可编辑字段："
                    f"{', '.join(unknown_fields)}"
                )
            for field_name, raw_values in raw_fields.items():
                normalized_field = str(field_name)
                current_values = target_item.get(normalized_field)
                label = f"{section_name}.{normalized_name}.{normalized_field}"
                if normalized_field in mapping_fields:
                    if not isinstance(current_values, dict):
                        raise ValueError(f"{label} 不存在或不是计时映射")
                    _apply_time_mapping_updates(current_values, raw_values, label)
                else:
                    if not isinstance(current_values, list):
                        raise ValueError(f"{label} 不存在或不是计时数组")
                    _apply_time_sequence_updates(current_values, raw_values, label)


def update_workspace_device_timing(
    device_id: str,
    raw_timing: Any,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """保存设备级时间参数、刷新拓扑镜像，并使基于旧时间计算的 Baseline 失效。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        device_data = device.get("device")
        if not isinstance(device_data, dict):
            raise ValueError("设备拓扑无效")
        apply_device_timing_updates(device_data, raw_timing)
        device["fingerprint"] = _device_fingerprint(device_data)
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(device_data)


def _unique_workspace_name(name: str, existing_names: Iterable[str]) -> str:
    """为设备或测试集生成易读且不重复的名称。"""
    normalized = name.strip() or "未命名"
    occupied = {str(item) for item in existing_names}
    if normalized not in occupied:
        return normalized
    suffix = 2
    while f"{normalized} ({suffix})" in occupied:
        suffix += 1
    return f"{normalized} ({suffix})"


def _device_fingerprint(device_data: Mapping[str, Any]) -> str:
    """计算设备语义指纹，将 JSON 中数值相同的整数和浮点数视为同一拓扑。"""
    pure_init_data, _ = _split_device_init_data(device_data)

    def normalize(value: Any) -> Any:
        """递归规范化 JSON 数值表示，不改变字段、数组顺序或非整数浮点精度。"""
        if isinstance(value, Mapping):
            return {str(key): normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, float) and math.isfinite(value) and value.is_integer():
            return int(value)
        return value

    canonical = json.dumps(
        normalize(pure_init_data), ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _split_device_init_data(device_data: Any) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """将纯 Stations/Robots init 与兼容性初始化选项分开持久化。"""
    source = dict(device_data) if isinstance(device_data, Mapping) else {}
    pure = {
        key: deepcopy(source[key])
        for key in ("Stations", "Robots")
        if key in source
    }
    options = {
        str(key): deepcopy(value)
        for key, value in source.items()
        if key not in {"Stations", "Robots"}
    }
    return pure, options


def import_workspace_device(
    name: str,
    raw_device: Any,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], bool]:
    """导入设备 init；相同拓扑通过指纹复用已有设备及其测试集。"""
    device_data = extract_init_data(raw_device)
    expand_pse300_loadlocks(device_data)
    fingerprint = _device_fingerprint(device_data)
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        existing = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and (
                item.get("fingerprint") == fingerprint
                or (
                    isinstance(item.get("device"), Mapping)
                    and _device_fingerprint(item["device"]) == fingerprint
                )
            )
        ), None)
        if existing is not None:
            requested_name = Path(name).name.strip() or str(existing.get("name") or "未命名设备")
            existing["name"] = _unique_workspace_name(
                requested_name,
                (
                    str(item.get("name") or "")
                    for item in catalog["devices"]
                    if isinstance(item, Mapping) and item is not existing
                ),
            )
            existing["fingerprint"] = fingerprint
            existing["device"] = device_data
            existing["updatedAt"] = _workspace_timestamp()
            _write_workspace_catalog_unlocked(path, catalog)
            return deepcopy(dict(existing)), False
        if len(catalog["devices"]) >= MAX_WORKSPACE_DEVICE_COUNT:
            raise ValueError(f"设备数量不能超过 {MAX_WORKSPACE_DEVICE_COUNT} 台")
        timestamp = _workspace_timestamp()
        device = {
            "id": uuid.uuid4().hex,
            "name": _unique_workspace_name(
                Path(name).name or "未命名设备",
                (str(item.get("name") or "") for item in catalog["devices"] if isinstance(item, Mapping)),
            ),
            "fingerprint": fingerprint,
            "device": device_data,
            "routes": [],
            "cleans": [],
            "testGroups": [],
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "tests": [],
        }
        catalog["devices"].append(device)
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(device), True


def _normalize_workspace_pjob(
    raw: Mapping[str, Any],
    index: int,
    task_id: str,
    assigned_load_port: str = "",
) -> Dict[str, Any]:
    """规范化页面 PJob，并生成只读 JobName、TaskID 与 MatList。"""
    wafer_count = max(1, min(MAX_WAFERS_PER_JOB, int(_finite_number(
        raw.get("waferCount"), len(raw.get("matList") or raw.get("MatList") or []) or 1,
    ))))
    job_name = f"P{index}"
    origin_route = raw.get("originRoute", raw.get("OriginRoute"))
    if isinstance(origin_route, Mapping):
        origin_route = origin_route.get("name") or origin_route.get("Name")
    normalized = {
        "jobName": job_name,
        "taskId": task_id,
        "waferCount": wafer_count,
        "matList": list(range(1, wafer_count + 1)),
        "routeRef": str(raw.get("routeRef") or origin_route or ""),
        "loadPort": assigned_load_port or str(
            raw.get("loadPort") or raw.get("LoadPort") or ""
        ),
        "priority": max(1, int(_finite_number(raw.get("priority", raw.get("Priority")), 1))),
    }
    if isinstance(raw.get("routeConfig"), Mapping):
        normalized["routeConfig"] = deepcopy(dict(raw["routeConfig"]))
    return normalized


def _normalize_workspace_round(
    raw: Mapping[str, Any],
    index: int,
    current_time: float,
    first_task_id: int = 1,
    load_ports: Sequence[str] = (),
) -> Dict[str, Any]:
    """规范化一轮 CJob/PJob；旧版 jobs 合并到该轮唯一默认 CJob。"""
    raw_cjobs = raw.get("cjobs")
    if isinstance(raw_cjobs, Sequence) and not isinstance(raw_cjobs, (str, bytes)):
        cjob_rows = [row for row in raw_cjobs if isinstance(row, Mapping)]
    else:
        legacy_jobs = [row for row in (raw.get("jobs") or []) if isinstance(row, Mapping)]
        first = legacy_jobs[0] if legacy_jobs else {}
        cjob_rows = [{
            "jobType": first.get("jobType", "NormalLot"),
            "priority": first.get("priority", 1),
            "taskMode": first.get("taskMode", "Smart"),
            "pjobs": legacy_jobs or [{}],
        }]
    if not cjob_rows:
        cjob_rows = [{"pjobs": [{}]}]
    if load_ports and len(cjob_rows) > len(load_ports):
        raise ValueError(
            f"第 {index} 轮包含 {len(cjob_rows)} 个 CJob，"
            f"超过可自动分配的 LoadPort 数量 {len(load_ports)}"
        )
    task_modes = [
        _workspace_task_mode_name(row.get("taskMode", row.get("TaskMode", "Smart")))
        for row in cjob_rows
    ]
    if len(cjob_rows) > 1 and any(
        task_mode in {"Pipeline", "Sequential"}
        for task_mode in task_modes
    ):
        raise ValueError(
            f"第 {index} 轮使用 Pipeline/Sequential 时只能配置一个 CJob"
        )
    cjobs: List[Dict[str, Any]] = []
    assigned_load_ports: set[str] = set()
    for cjob_index, row in enumerate(cjob_rows, start=1):
        task_id = str(first_task_id + cjob_index - 1)
        raw_job_type = row.get("jobType", row.get("JobType", "NormalLot"))
        try:
            job_type_value = _enum_value(raw_job_type, CJOB_TYPE_VALUES, "JobType", "NormalLot")
        except ValueError:
            job_type_value = CJOB_TYPE_VALUES["NormalLot"]
        task_mode_name = task_modes[cjob_index - 1]
        task_mode_value = TASK_MODE_VALUES[task_mode_name]
        pjob_rows = [item for item in (row.get("pjobs") or []) if isinstance(item, Mapping)] or [{}]
        fallback_load_port = str(
            row.get("loadPort")
            or pjob_rows[0].get("loadPort")
            or pjob_rows[0].get("LoadPort")
            or ""
        )
        if fallback_load_port and load_ports and fallback_load_port not in load_ports:
            raise ValueError(
                f"第 {index} 轮 CJob {cjob_index} 的 LoadPort 不存在："
                f"{fallback_load_port}"
            )
        load_port = fallback_load_port or _automatic_workspace_load_port(
            load_ports,
            first_task_id + cjob_index - 1,
        )
        if load_port in assigned_load_ports:
            raise ValueError(
                f"第 {index} 轮多个 CJob 不能同时占用 LoadPort：{load_port}"
            )
        if load_port:
            assigned_load_ports.add(load_port)
        cjob_cycle = _cjob_cycle_count(row)
        pjobs = [
            _normalize_workspace_pjob(item, pjob_index, task_id, load_port)
            for pjob_index, item in enumerate(pjob_rows, start=1)
        ]
        cjobs.append({
            "taskId": task_id,
            "loadPort": load_port,
            "cjobCycle": cjob_cycle,
            "jobType": CJOB_TYPE_NAMES[job_type_value],
            "priority": max(1, int(_finite_number(row.get("priority", row.get("Priority")), 1))) if job_type_value == 0 else -1,
            "taskMode": TASK_MODE_NAMES[task_mode_value],
            "pJobNameList": [pjob["jobName"] for pjob in pjobs],
            "pjobs": pjobs,
            "key": str(row.get("key") or f"C{cjob_index}"),
        })
    return {"currentTime": 0.0 if index == 1 else float(current_time), "cjobs": cjobs}


def _normalize_test_case(
    raw_test: Mapping[str, Any],
    test_id: Optional[str] = None,
    load_ports: Sequence[str] = (),
) -> Dict[str, Any]:
    """保存只含排程任务的测试集结构，并兼容迁移旧版扁平 Job。"""
    timestamp = _workspace_timestamp()
    raw_rounds = [row for row in (raw_test.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = max(1, int(_finite_number(raw_test.get("roundCount"), len(raw_rounds) or 1)))
    times = deepcopy(list(raw_test.get("times") or [0.0]))
    while len(raw_rounds) < round_count:
        raw_rounds.append({})
    while len(times) < round_count:
        times.append((float(times[-1]) if times else 0.0) + 70.0)
    rounds: List[Dict[str, Any]] = []
    next_task_id = 1
    for index in range(round_count):
        round_row = _normalize_workspace_round(
            raw_rounds[index],
            index + 1,
            _finite_number(
                raw_rounds[index].get("currentTime"),
                _finite_number(times[index], 0.0),
            ),
            next_task_id,
            load_ports,
        )
        rounds.append(round_row)
        next_task_id += len(round_row["cjobs"])
    next_material_id = 1
    for round_row in rounds:
        for cjob in round_row["cjobs"]:
            for pjob in cjob["pjobs"]:
                wafer_count = int(pjob["waferCount"])
                pjob["matList"] = list(range(next_material_id, next_material_id + wafer_count))
                next_material_id += wafer_count
    times = [round_row["currentTime"] for round_row in rounds]
    options = deepcopy(dict(raw_test.get("options") or {}))
    # LoadLock 交换候选始终启用；迁移旧测试集时丢弃已经废止的开关。
    options.pop("loadLockExchange", None)
    normalized = {
        "id": test_id or uuid.uuid4().hex,
        "name": str(raw_test.get("name") or "未命名测试集").strip() or "未命名测试集",
        "group": str(raw_test.get("group") or "").strip(),
        "strategy": (
            "other_alg:greedy"
            if str(raw_test.get("strategy") or "").strip().lower() == "greedy"
            else str(raw_test.get("strategy") or "heuristic")
        ),
        "roundCount": round_count,
        "times": times,
        "options": options,
        "routeConfigs": deepcopy(dict(raw_test.get("routeConfigs") or {})),
        "cleans": [
            deepcopy(dict(clean))
            for clean in (raw_test.get("cleans") or [])
            if isinstance(clean, Mapping)
        ],
        "rounds": rounds,
        "createdAt": str(raw_test.get("createdAt") or timestamp),
        "updatedAt": timestamp,
    }
    if isinstance(raw_test.get("baseline"), Mapping):
        normalized["baseline"] = deepcopy(dict(raw_test["baseline"]))
    return normalized


def _apply_device_library(device: Dict[str, Any], payload: Mapping[str, Any]) -> None:
    """兼容写入共享路径模板，并同步 Route 自动改名；Clean 归测试所有。"""
    raw_aliases = payload.get("routeNameChanges")
    aliases = {
        str(old_name): str(new_name)
        for old_name, new_name in (raw_aliases.items() if isinstance(raw_aliases, Mapping) else [])
        if str(old_name) and str(new_name) and str(old_name) != str(new_name)
    }
    if aliases:
        # Route 是设备共享数据，自动改名时必须同步所有测试，而不只更新当前编辑项。
        for test_case in device.get("tests") or []:
            for round_row in test_case.get("rounds") or []:
                cjobs = round_row.get("cjobs") or []
                for cjob in cjobs:
                    for pjob in cjob.get("pjobs") or []:
                        route_ref = str(pjob.get("routeRef") or "")
                        if route_ref in aliases:
                            pjob["routeRef"] = aliases[route_ref]
            route_configs = test_case.get("routeConfigs")
            if isinstance(route_configs, dict):
                for old_name, new_name in aliases.items():
                    if old_name in route_configs and new_name not in route_configs:
                        route_configs[new_name] = route_configs.pop(old_name)
    if isinstance(payload.get("routes"), list):
        device["routes"] = _normalized_workspace_routes(payload["routes"])
    else:
        device.setdefault("routes", [])
    device.setdefault("cleans", [])


def _fast_update_directory_workspace_routes_unlocked(
    device_id: str,
    payload: Mapping[str, Any],
    path: Path,
) -> Optional[Dict[str, Any]]:
    """快速保存模板及延迟别名，只触碰设备库文件而不遍历全部测试。"""
    if (
        path.suffix
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
        or not _workspace_store_is_current(path)
        or not isinstance(payload.get("routes"), list)
    ):
        return None
    readable_layout = _uses_readable_dataset_layout(path)
    device_dir = (
        _find_dataset_device_directory(path, device_id)
        if readable_layout else path / device_id
    )
    if device_dir is None:
        return None
    device_file = device_dir / ("routes.json" if readable_layout else "device.json")
    try:
        device = json.loads(device_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(device, dict):
        return None
    metadata: Optional[Dict[str, Any]] = None
    summaries: Any = None
    if readable_layout:
        try:
            raw_metadata = json.loads(
                (device_dir / "metadata.json").read_text(encoding="utf-8")
            )
            summaries = json.loads(
                _workspace_test_index_path(device_dir / "tests").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None
        if not isinstance(raw_metadata, dict) or not isinstance(summaries, list):
            return None
        metadata = raw_metadata
    routes = _normalized_workspace_routes(payload["routes"])
    topology_keys = [
        _workspace_route_topology_key(route)
        for route in routes
        if isinstance(route, Mapping)
    ]
    if len(topology_keys) != len(set(topology_keys)):
        # 合并重复模板需要检查每个测试参数是否冲突，保持原有安全逻辑。
        return None
    device["routes"] = routes
    device.setdefault("cleans", [])
    aliases = _normalized_route_aliases(payload.get("routeNameChanges"))
    if aliases:
        route_aliases = _normalized_route_aliases(device.get("routeAliases"))
        for old_name, new_name in aliases.items():
            for origin, current in list(route_aliases.items()):
                if current == old_name:
                    route_aliases[origin] = new_name
            route_aliases[old_name] = new_name
        device["routeAliases"] = route_aliases
    if readable_layout:
        device["schemaVersion"] = WORKSPACE_STORE_VERSION
    else:
        device["updatedAt"] = _workspace_timestamp()
    _write_json_atomic(device_file, device)
    if readable_layout:
        metadata["updatedAt"] = _workspace_timestamp()
        _write_json_if_changed(device_dir / "metadata.json", metadata)
    else:
        try:
            summaries = json.loads(
                _workspace_test_index_path(device_dir / "tests").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            summaries = []
    test_count = len(summaries) if isinstance(summaries, list) else 0
    _write_workspace_store_version(path)
    return {"routes": deepcopy(routes), "testCount": test_count}


def update_workspace_routes(
    device_id: str,
    payload: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
    *,
    include_tests: bool = True,
) -> Dict[str, Any]:
    """保存设备级路径模板，并把自动改名同步到所有测试引用和配置键。

    HTTP 调用不需要回传每个完整测试集；设备测试较多时这会显著拖慢保存。
    保留 ``include_tests`` 以兼容服务端调用方和已有测试。
    """
    with _workspace_catalog_guard(path):
        fast_result = _fast_update_directory_workspace_routes_unlocked(
            device_id, payload, path,
        )
        if fast_result is not None:
            return fast_result
        catalog = _read_workspace_catalog_unlocked(path)
        device = next(
            (item for item in catalog["devices"] if item.get("id") == device_id),
            None,
        )
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        if not isinstance(payload.get("routes"), list):
            raise ValueError("routes 必须是数组")
        _apply_device_library(device, payload)
        _deduplicate_workspace_route_templates(device)
        _synchronize_workspace_test_route_configs(device)
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        result = {
            "routes": deepcopy(device.get("routes") or []),
            "testCount": len(device.get("tests") or []),
        }
        if include_tests:
            result["tests"] = deepcopy(device.get("tests") or [])
        return result


def create_workspace_test(
    device_id: str,
    raw_test: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """在指定设备下新增一个独立测试集，并自动消解同组重名。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        _apply_device_library(device, raw_test)
        normalized_input = dict(raw_test)
        normalized_input.setdefault(
            "routeConfigs", _workspace_route_config_map(device.get("routes") or []),
        )
        normalized_input.pop("baseline", None)
        requested_name = str(raw_test.get("name") or "").strip()
        if not requested_name:
            raise ValueError("测试集名称不能为空")
        test_case = _normalize_test_case(
            normalized_input,
            load_ports=_workspace_load_ports(device),
        )
        test_case["name"] = _unique_workspace_name(
            test_case["name"],
            (
                str(item.get("name") or "")
                for item in device.get("tests") or []
                if str(item.get("group") or "").strip() == test_case["group"]
            ),
        )
        if test_case["group"] and test_case["group"] not in device.setdefault("testGroups", []):
            device["testGroups"].append(test_case["group"])
        device.setdefault("tests", []).append(test_case)
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(test_case)


def _fast_update_readable_workspace_test_unlocked(
    device_id: str,
    test_id: str,
    raw_test: Mapping[str, Any],
    path: Path,
) -> Optional[Dict[str, Any]]:
    """在 v6 目录中只更新目标测试及其摘要，避免每次编辑扫描并重写整库。"""
    if (
        path.suffix
        or not _uses_readable_dataset_layout(path)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", test_id)
        or not _workspace_store_is_current(path)
        # 共享 Route 变更必须继续走全量路径，以同步所有测试引用。
        or isinstance(raw_test.get("routes"), list)
        or bool(_normalized_route_aliases(raw_test.get("routeNameChanges")))
    ):
        return None
    device_dir = _find_dataset_device_directory(path, device_id)
    if device_dir is None:
        return None
    test_file = _find_dataset_test_file(device_dir, test_id)
    if test_file is None:
        return None
    tests_dir = device_dir / "tests"
    index_file = _workspace_test_index_path(tests_dir)
    try:
        metadata = json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
        init_data = json.loads((device_dir / "device.json").read_text(encoding="utf-8"))
        routes_payload = json.loads((device_dir / "routes.json").read_text(encoding="utf-8"))
        groups_payload = json.loads((device_dir / "groups.json").read_text(encoding="utf-8"))
        summaries = json.loads(index_file.read_text(encoding="utf-8"))
        existing_test = json.loads(test_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(metadata, dict)
        or not isinstance(init_data, dict)
        or not isinstance(routes_payload, Mapping)
        or not isinstance(groups_payload, dict)
        or not isinstance(summaries, list)
        or not all(isinstance(summary, Mapping) for summary in summaries)
        or not isinstance(existing_test, dict)
        or str(existing_test.get("id") or "") != test_id
    ):
        return None

    requested_name = str(raw_test.get("name") or "").strip()
    if not requested_name:
        raise ValueError("测试集名称不能为空")
    requested_group = str(raw_test.get("group") or "").strip()
    duplicate = next((
        summary for summary in summaries
        if str(summary.get("id") or "") != test_id
        and str(summary.get("group") or "").strip() == requested_group
        and str(summary.get("name") or "") == requested_name
    ), None)
    if duplicate is not None:
        raise ValueError(f"测试集名称重复：{requested_name}")

    device = deepcopy(metadata)
    init_options = device.pop("initOptions", {})
    if isinstance(init_options, Mapping):
        init_data.update(deepcopy(dict(init_options)))
    device.update({
        "device": init_data,
        "routes": deepcopy(routes_payload.get("routes") or []),
        "cleans": deepcopy(routes_payload.get("cleans") or []),
        "routeAliases": deepcopy(routes_payload.get("routeAliases") or {}),
        "testGroups": deepcopy(groups_payload.get("testGroups") or []),
    })
    if "robotSlots" in groups_payload:
        device["robotSlots"] = deepcopy(groups_payload["robotSlots"])

    merged = dict(raw_test)
    merged.setdefault("routeConfigs", _workspace_route_config_map(device.get("routes") or []))
    merged.pop("baseline", None)
    merged["createdAt"] = existing_test.get("createdAt")
    if isinstance(existing_test.get("baseline"), Mapping):
        merged["baseline"] = deepcopy(existing_test["baseline"])
    test_case = _normalize_test_case(merged, test_id, _workspace_load_ports(device))
    _invalidate_stale_device_baselines({**device, "tests": [test_case]})

    groups = groups_payload.setdefault("testGroups", [])
    if test_case["group"] and test_case["group"] not in groups:
        groups.append(test_case["group"])
    timestamp = _workspace_timestamp()
    metadata["updatedAt"] = timestamp
    persisted_test = deepcopy(test_case)
    persisted_test["schemaVersion"] = WORKSPACE_STORE_VERSION
    updated_summaries = [
        _workspace_test_summary(test_case)
        if str(summary.get("id") or "") == test_id
        else _workspace_test_summary(summary)
        for summary in summaries
    ]
    _write_json_atomic(test_file, persisted_test)
    _write_json_if_changed(index_file, updated_summaries)
    _write_json_if_changed(device_dir / "groups.json", groups_payload)
    _write_json_if_changed(device_dir / "metadata.json", metadata)
    _write_workspace_store_version(path)
    return deepcopy(test_case)


def update_workspace_test(
    device_id: str,
    test_id: str,
    raw_test: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """覆盖保存一个测试集，同时保持创建时间和稳定 ID。"""
    with _workspace_catalog_guard(path):
        fast_result = _fast_update_readable_workspace_test_unlocked(
            device_id, test_id, raw_test, path,
        )
        if fast_result is not None:
            return fast_result
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        tests = device.get("tests") or []
        index = next((position for position, item in enumerate(tests) if item.get("id") == test_id), None)
        if index is None:
            raise ValueError(f"测试集不存在：{test_id}")
        requested_name = str(raw_test.get("name") or "").strip()
        if not requested_name:
            raise ValueError("测试集名称不能为空")
        requested_group = str(raw_test.get("group") or "").strip()
        duplicate = next((
            item for item in tests
            if item.get("id") != test_id
            and str(item.get("group") or "").strip() == requested_group
            and str(item.get("name") or "") == requested_name
        ), None)
        if duplicate is not None:
            raise ValueError(f"测试集名称重复：{requested_name}")
        _apply_device_library(device, raw_test)
        merged = dict(raw_test)
        merged.setdefault(
            "routeConfigs", _workspace_route_config_map(device.get("routes") or []),
        )
        merged.pop("baseline", None)
        merged["createdAt"] = tests[index].get("createdAt")
        if isinstance(tests[index].get("baseline"), Mapping):
            merged["baseline"] = deepcopy(tests[index]["baseline"])
        test_case = _normalize_test_case(
            merged,
            test_id,
            _workspace_load_ports(device),
        )
        if test_case["group"] and test_case["group"] not in device.setdefault("testGroups", []):
            device["testGroups"].append(test_case["group"])
        tests[index] = test_case
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(test_case)


def create_workspace_test_group(
    device_id: str,
    name: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> List[str]:
    """为设备新增可独立存在的测试组别，不隐式创建测试集。"""
    group = str(name or "").strip()
    if not group:
        raise ValueError("测试组别名称不能为空")
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        groups = device.setdefault("testGroups", [])
        if group in groups:
            raise ValueError(f"测试组别“{group}”已经存在")
        groups.append(group)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(groups)


def rename_workspace_test_group(
    device_id: str,
    old_name: str,
    name: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """重命名设备下的测试组，并同步组内测试的 group 字段。"""
    old_group = str(old_name or "").strip()
    group = str(name or "").strip()
    if not old_group:
        raise ValueError("默认“未分组”不能重命名")
    if not group:
        raise ValueError("测试组别名称不能为空")
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        groups = device.setdefault("testGroups", [])
        if old_group not in groups:
            raise ValueError(f"测试组别不存在：{old_group}")
        if group != old_group and group in groups:
            raise ValueError(f"测试组别“{group}”已经存在")
        if group != old_group:
            groups[groups.index(old_group)] = group
            for test_case in device.get("tests") or []:
                if str(test_case.get("group") or "").strip() == old_group:
                    test_case["group"] = group
            device["updatedAt"] = _workspace_timestamp()
            _write_workspace_catalog_unlocked(path, catalog)
        return {"groups": deepcopy(groups), "tests": deepcopy(device.get("tests") or [])}


def delete_workspace_test_group(
    device_id: str,
    name: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """删除一个测试组及其包含的测试集；空名称代表“未分组”。"""
    group = str(name or "").strip()
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        groups = device.setdefault("testGroups", [])
        has_group_tests = any(
            str(item.get("group") or "").strip() == group
            for item in device.get("tests") or []
        )
        if group and group not in groups:
            raise ValueError(f"测试组别不存在：{group}")
        if not group and not has_group_tests:
            raise ValueError("“未分组”中没有可删除的测试")
        deleted_tests = [
            item for item in device.get("tests") or []
            if str(item.get("group") or "").strip() == group
        ]
        if group:
            device["testGroups"] = [item for item in groups if item != group]
        device["tests"] = [
            item for item in device.get("tests") or []
            if str(item.get("group") or "").strip() != group
        ]
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        # 先物理删除测试集文件再写目录：即使中途中断，下次扫描也不会让已删测试复活。
        for deleted_test in deleted_tests:
            _remove_directory_test_file(path, device_id, str(deleted_test.get("id") or "").strip())
        _write_workspace_catalog_unlocked(path, catalog)
        return {
            "groups": deepcopy(device["testGroups"]),
            "tests": deepcopy(device["tests"]),
            "deletedTestCount": len(deleted_tests),
        }


def delete_workspace_test(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> None:
    """删除指定测试集；设备至少保留一个测试集以维持可运行状态。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        tests = device.get("tests") or []
        if len(tests) <= 1:
            raise ValueError("设备至少需要保留一个测试集")
        remaining = [item for item in tests if item.get("id") != test_id]
        if len(remaining) == len(tests):
            raise ValueError(f"测试集不存在：{test_id}")
        device["tests"] = remaining
        device["updatedAt"] = _workspace_timestamp()
        # 先物理删除测试集文件再写目录：即使中途中断，下次扫描也不会让已删测试复活。
        _remove_directory_test_file(path, device_id, test_id)
        _write_workspace_catalog_unlocked(path, catalog)


def save_result(output: Dict[str, Any]) -> str:
    """把甘特图数据写入专用导出目录并放入有界内存缓存。"""
    result_id = uuid.uuid4().hex
    with _EXPORTS_LOCK:
        _write_json_atomic(RESULT_EXPORT_DIR / f"{result_id}.json", output)
        with _RESULTS_LOCK:
            _RESULTS[result_id] = output
            _RESULTS.move_to_end(result_id)
            while len(_RESULTS) > MAX_SAVED_RESULTS:
                _RESULTS.popitem(last=False)
    return result_id


def read_result(result_id: str) -> Optional[Dict[str, Any]]:
    """读取一次运行的甘特图数据；服务重启后可从磁盘恢复。"""
    with _RESULTS_LOCK:
        value = _RESULTS.get(result_id)
        if value is not None:
            return deepcopy(value)
    if len(result_id) == 32 and all(char in "0123456789abcdef" for char in result_id.lower()):
        path = RESULT_EXPORT_DIR / f"{result_id}.json"
        if path.is_file():
            value = json.loads(path.read_text(encoding="utf-8"))
            return deepcopy(value) if isinstance(value, Mapping) else None
    return None


def save_reproduction_log(entries: Sequence[Mapping[str, Any]]) -> str:
    """把 input_data 格式日志写入专用导出目录并放入有界内存缓存。"""
    log_id = uuid.uuid4().hex
    payload = deepcopy(list(entries))
    with _EXPORTS_LOCK:
        _write_text_atomic(LOG_EXPORT_DIR / f"{log_id}.json", format_reproduction_log(payload))
        with _REPRODUCTION_LOGS_LOCK:
            _REPRODUCTION_LOGS[log_id] = payload
            _REPRODUCTION_LOGS.move_to_end(log_id)
            while len(_REPRODUCTION_LOGS) > MAX_SAVED_RESULTS:
                _REPRODUCTION_LOGS.popitem(last=False)
    return log_id


def read_reproduction_log(log_id: str) -> Optional[List[Dict[str, Any]]]:
    """读取一次运行的可复现日志；服务重启后可从磁盘恢复。"""
    with _REPRODUCTION_LOGS_LOCK:
        value = _REPRODUCTION_LOGS.get(log_id)
        if value is not None:
            return deepcopy(value)
    if len(log_id) == 32 and all(char in "0123456789abcdef" for char in log_id.lower()):
        path = LOG_EXPORT_DIR / f"{log_id}.json"
        if path.is_file():
            value = json.loads(path.read_text(encoding="utf-8"))
            return deepcopy(value) if isinstance(value, list) else None
    return None


def build_workspace_batch_log_archive(batch_id: str) -> Tuple[bytes, str]:
    """打包一个批量任务中已生成的测试复现日志。

    参数 ``batch_id`` 为批量任务 ID。返回 ZIP 二进制内容及推荐下载文件名；每条
    日志采用与单条日志下载相同的逐行 JSON 格式，压缩包中的 ``manifest.json``
    记录测试集、运行状态及对应文件名。批量任务不存在或尚未生成任何日志时抛出异常。
    """
    batch = read_workspace_batch_run(batch_id)
    if batch is None:
        raise LookupError("批量任务不存在或已过期")

    manifest_items: List[Dict[str, Any]] = []
    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w", compression=ZIP_DEFLATED) as archive:
        for item in sorted(batch.get("items") or [], key=lambda value: int(value.get("index", 0))):
            if not isinstance(item, Mapping):
                continue
            log_url = str(item.get("logUrl") or "")
            log_id = log_url.rsplit("/", 1)[-1]
            reproduction_log = read_reproduction_log(log_id) if log_id else None
            manifest_item = {
                "index": int(item.get("index", 0)) + 1,
                "testId": str(item.get("testId") or ""),
                "testName": str(item.get("testName") or ""),
                "status": str(item.get("status") or "queued"),
                "logFile": "",
            }
            if reproduction_log is not None:
                safe_name = re.sub(
                    r'[\\/:*?"<>|\x00-\x1f]+', "_", manifest_item["testName"],
                ).strip(" ._") or f"测试{manifest_item['index']}"
                log_file = f"t{manifest_item['index']:02d}_{safe_name}.json"
                archive.writestr(log_file, format_reproduction_log(reproduction_log))
                manifest_item["logFile"] = log_file
            manifest_items.append(manifest_item)

        exported_count = sum(bool(item["logFile"]) for item in manifest_items)
        if not exported_count:
            raise ValueError("本批次尚无可导出的复现日志")
        archive.writestr(
            "manifest.json",
            json.dumps({
                "batchId": batch_id,
                "deviceName": str(batch.get("deviceName") or ""),
                "group": str(batch.get("group") or ""),
                "strategy": str(batch.get("strategy") or ""),
                "exportedLogCount": exported_count,
                "items": manifest_items,
            }, ensure_ascii=False, indent=2),
        )
    return archive_buffer.getvalue(), f"ct-batch-logs-{batch_id[:8]}.zip"


def clear_exported_artifacts() -> Dict[str, int]:
    """删除全部已导出的结果和复现日志，并同步清空内存缓存。

    返回值包含结果和日志各自删除的 JSON 文件数量。该操作只处理两个专用导出
    目录顶层的 JSON 文件，不会影响设备、测试集或其他运行数据。
    """
    deleted_counts = {"results": 0, "logs": 0}
    with _EXPORTS_LOCK:
        for name, directory in (("results", RESULT_EXPORT_DIR), ("logs", LOG_EXPORT_DIR)):
            if not directory.is_dir():
                continue
            for path in directory.glob("*.json"):
                if path.is_file():
                    path.unlink()
                    deleted_counts[name] += 1
        with _RESULTS_LOCK:
            _RESULTS.clear()
        with _REPRODUCTION_LOGS_LOCK:
            _REPRODUCTION_LOGS.clear()
    return deleted_counts


def _persist_workspace_baseline(
    device_id: str,
    test_id: str,
    baseline: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> bool:
    """保存某个测试的 Baseline；测试夹具不存在于目录时返回 False。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            return False
        test_case = next((item for item in (device.get("tests") or []) if item.get("id") == test_id), None)
        if test_case is None:
            return False
        test_case["baseline"] = deepcopy(dict(baseline))
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return True




# 批量运行是独立应用服务；旧模块继续导出同名函数，保持脚本和测试兼容。
from realtime_scheduler import batch_service as _batch_service

_batch_service.configure_batch_service(sys.modules[__name__])
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


class ConfigEditorHandler(BaseHTTPRequestHandler):
    """暴露调度控制台、设备测试集、甘特图和运行 API 的本地 HTTP 处理器。"""

    server_version = "CTConfigEditor/1.0"

    def handle_one_request(self) -> None:
        """记录单次 HTTP 请求起点，供统一响应性能头计算端到端服务耗时。"""
        self._request_started_performance = time.perf_counter()
        super().handle_one_request()

    def do_GET(self) -> None:
        """处理页面、健康检查和内存结果读取。"""
        parsed_url = urlparse(self.path)
        path = unquote(parsed_url.path)
        if path in {"/", "/config_editor.html"}:
            self._send_file(EDITOR_PATH, "text/html; charset=utf-8")
            return
        if path == "/movelist_gantt_viewer.html":
            self._send_file(VIEWER_PATH, "text/html; charset=utf-8")
            return
        if path == "/route_editor_logic.js":
            self._send_file(ROUTE_EDITOR_LOGIC_PATH, "text/javascript; charset=utf-8")
            return
        if path.startswith("/assets/"):
            self._send_frontend_asset(path.removeprefix("/assets/"))
            return
        if path == "/api/health":
            builtin_algorithms = discover_builtin_algorithms()
            other_algorithms = discover_other_algorithms()
            builtin_strategy_errors = {
                str(algorithm["strategy"]): str(algorithm["unavailableReason"])
                for algorithm in builtin_algorithms
                if not algorithm["available"]
            }
            strategy_availability = {
                str(algorithm["strategy"]): bool(algorithm["available"])
                for algorithm in builtin_algorithms
            }
            self._send_json({
                "ok": True,
                "service": "ct-config-editor",
                "schemaVersion": API_SCHEMA_VERSION,
                "algorithmRepositoryAvailable": BUILTIN_ALGORITHM_AVAILABLE,
                "strategies": strategy_availability,
                "strategyModels": {
                    "e2e-ctq": (
                        E2E_CTQ_MODEL_PATH.name if E2E_CTQ_MODEL_PATH.is_file() else ""
                    ),
                    "dual-actor-e2e": (
                        DUAL_ACTOR_MODEL_PATH.name
                        if DUAL_ACTOR_MODEL_PATH.is_file()
                        else ""
                    ),
                },
                "strategyErrors": builtin_strategy_errors,
                "algorithmMetadata": algorithm_metadata_for_health(
                    builtin_algorithms,
                    other_algorithms,
                ),
                "algorithms": [*builtin_algorithms, *other_algorithms],
                "otherAlgorithms": other_algorithms,
            })
            return
        if path == "/api/documentation":
            try:
                document = load_documentation((
                    DOCUMENTATION_DIR,
                    ALGORITHM_DOCUMENTATION_DIR,
                ))
            except DocumentationError as error:
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.NOT_FOUND,
                )
                return
            self._send_json({"ok": True, "document": document})
            return
        if path == "/api/search-telemetry":
            if not BUILTIN_ALGORITHM_AVAILABLE:
                self._send_json(
                    {"ok": False, "error": "本地算法仓库未加载，无法读取搜索遥测"},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            try:
                query = parse_qs(parsed_url.query)
                raw_revision = (query.get("since") or [None])[0]
                since_revision = (
                    None if raw_revision in {None, ""} else int(raw_revision)
                )
                self._send_json({
                    "ok": True,
                    "telemetry": builtin_algorithm_api.get_search_telemetry(
                        since_revision
                    ),
                })
            except (TypeError, ValueError) as error:
                self._send_json(
                    {"ok": False, "error": f"since 必须是整数：{error}"},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/workspaces":
            try:
                devices = list_workspace_devices()
                self._send_json({"ok": True, "devices": devices})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path.startswith("/api/workspaces/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "export":
                try:
                    content, download_name = export_workspace_device(parts[2])
                    self._send_bytes(content, "application/zip", download_name)
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            if (
                len(parts) == 6
                and parts[:2] == ["api", "workspaces"]
                and parts[3] == "tests"
                and parts[5] == "export"
            ):
                try:
                    content, download_name = export_workspace_test(parts[2], parts[4])
                    self._send_bytes(content, "application/zip", download_name)
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            if len(parts) == 5 and parts[:2] == ["api", "workspaces"] and parts[3] == "tests":
                try:
                    self._send_json({"ok": True, "test": get_workspace_test(parts[2], parts[4])})
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
                return
            if len(parts) == 3:
                try:
                    self._send_json({"ok": True, "device": get_workspace_device_overview(parts[2])})
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
                return
        if path.startswith("/api/results/"):
            result = read_result(path.rsplit("/", 1)[-1])
            if result is None:
                self._send_json({"ok": False, "error": "结果不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(result)
            return
        if path.startswith("/api/logs/"):
            log_id = path.rsplit("/", 1)[-1]
            reproduction_log = read_reproduction_log(log_id)
            if reproduction_log is None:
                self._send_json({"ok": False, "error": "日志不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(
                    reproduction_log,
                    download_name=f"ct-input-log-{log_id[:8]}.json",
                    top_level_item_per_line=True,
                )
            return
        run_parts = [part for part in path.split("/") if part]
        if len(run_parts) == 3 and run_parts[:2] == ["api", "runs"]:
            run = _single_run_snapshot(run_parts[2])
            if run is None:
                self._send_json({"ok": False, "error": "单测任务不存在或尚未开始"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(run)
            return
        batch_parts = run_parts
        if len(batch_parts) == 4 and batch_parts[:2] == ["api", "run-batches"] and batch_parts[3] == "logs":
            try:
                content, download_name = build_workspace_batch_log_archive(batch_parts[2])
                self._send_bytes(content, "application/zip", download_name)
            except LookupError as error:
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
            except ValueError as error:
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path.startswith("/api/run-batches/"):
            batch = read_workspace_batch_run(path.rsplit("/", 1)[-1])
            if batch is None:
                self._send_json({"ok": False, "error": "批量任务不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(batch)
            return
        self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        """接收控制台配置并同步运行后端策略。"""
        path = unquote(urlparse(self.path).path)
        if path == "/api/workspaces/import/device":
            try:
                device, created_device, imported_tests = import_workspace_device_archive(
                    self._read_binary_body(DATA_EXCHANGE_MAX_BYTES),
                )
                self._send_json({
                    "ok": True,
                    "device": {
                        "id": device["id"],
                        "name": device.get("name") or "未命名设备",
                        "testCount": len(device.get("tests") or []),
                    },
                    "createdDevice": bool(created_device),
                    "importedTests": imported_tests,
                })
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        import_test_parts = [part for part in path.split("/") if part]
        if (
            len(import_test_parts) == 4
            and import_test_parts[:2] == ["api", "workspaces"]
            and import_test_parts[3] == "import-test"
        ):
            try:
                test_case, created = import_workspace_test_archive(
                    import_test_parts[2],
                    self._read_binary_body(DATA_EXCHANGE_MAX_BYTES),
                )
                self._send_json({"ok": True, "created": created, "test": test_case})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/model-checkpoints":
            try:
                filename = unquote(str(self.headers.get("X-Checkpoint-Filename") or ""))
                checkpoint_path = save_model_checkpoint(
                    filename,
                    self._read_binary_body(MAX_CHECKPOINT_BYTES),
                )
                self._send_json({"ok": True, "modelPath": str(checkpoint_path)})
            except (OSError, ValueError) as error:
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/algorithms/register":
            self._handle_register_algorithm()
            return
        if path == "/api/search-control":
            try:
                if not BUILTIN_ALGORITHM_AVAILABLE:
                    raise RuntimeError("本地算法仓库未加载，无法控制搜索")
                payload = self._read_json_object()
                result = builtin_algorithm_api.control_search(
                    str(payload.get("command") or ""),
                    payload.get("actionKey"),
                )
                self._send_json({"ok": True, **result})
            except (RuntimeError, TypeError, ValueError) as error:
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/analysis/replay-decision":
            try:
                if not BUILTIN_ALGORITHM_AVAILABLE:
                    raise RuntimeError("当前部署未提供 Machine，无法评估回放动作")
                payload = self._read_json_object()
                result_id = str(payload.get("resultId") or "").strip()
                saved_result = read_result(result_id) if result_id else None
                if result_id and saved_result is None:
                    raise ValueError("结果不存在或已过期")
                moves = normalize_move_payload(
                    saved_result
                    if saved_result is not None
                    else payload.get("moves", payload.get("result")),
                )
                raw_plan = payload.get("plan")
                replay_context = (
                    saved_result.get("ReplayContext")
                    if isinstance(saved_result, Mapping)
                    else None
                )
                if not isinstance(raw_plan, Mapping) and isinstance(replay_context, Mapping):
                    raw_plan = replay_context.get("plan")
                if not isinstance(raw_plan, Mapping):
                    raise ValueError("缺少生成该 MoveList 的完整计划，无法重建 Machine")
                recommendation_model = str(
                    payload.get("recommendationModel") or "e2e-ctq"
                ).strip().lower()
                recommendation_models = {
                    "e2e-ctq": E2E_CTQ_MODEL_PATH,
                    "dual-actor-e2e": DUAL_ACTOR_MODEL_PATH,
                }
                if recommendation_model not in recommendation_models:
                    raise ValueError(
                        f"拓扑回放不支持推荐模型：{recommendation_model}"
                    )
                decision = ReplayMachine(
                    raw_plan,
                    moves,
                    recommendation_models[recommendation_model],
                    (
                        replay_context.get("updates") or []
                        if isinstance(replay_context, Mapping)
                        else []
                    ),
                    recommendation_model=recommendation_model,
                ).evaluate(_finite_number(payload.get("time"), 0.0))
                self._send_json({"ok": True, "decision": decision})
            except Exception as error:  # noqa: BLE001
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/analysis/schedule":
            try:
                payload = self._read_json_object()
                result_id = str(payload.get("resultId") or "").strip()
                if result_id:
                    saved_result = read_result(result_id)
                    if saved_result is None:
                        raise ValueError("结果不存在或已过期")
                    moves = normalize_move_payload(saved_result)
                    run_metrics = saved_result.get("RunMetricsMetadata")
                    if not isinstance(run_metrics, Mapping):
                        legacy_metadata = saved_result.get("ProductionMetricsMetadata")
                        run_metrics = {
                            "cpuTimeMs": (
                                _finite_number(legacy_metadata.get("calculationSeconds")) * 1000.0
                                if isinstance(legacy_metadata, Mapping)
                                else None
                            ),
                            "recomputeCount": len(list(saved_result.get("RecomputePoints") or [])),
                        }
                else:
                    moves = normalize_move_payload(
                        payload.get("moves", payload.get("result")),
                    )
                    run_metrics = {
                        "cpuTimeMs": payload.get("cpuTimeMs"),
                        "recomputeCount": payload.get("recomputeCount"),
                    }
                device = payload.get("device")
                if device is not None and not isinstance(device, Mapping):
                    raise ValueError("device 必须是 JSON 对象或 null")
                context = payload.get("context")
                if context is None:
                    routes = payload.get("routes")
                    rounds = payload.get("rounds")
                    if routes is not None or rounds is not None:
                        if routes is not None and not isinstance(routes, list):
                            raise ValueError("routes 必须是数组")
                        if rounds is not None and not isinstance(rounds, list):
                            raise ValueError("rounds 必须是数组")
                        context = build_schedule_analysis_context(routes, rounds)
                if context is not None and not isinstance(context, Mapping):
                    raise ValueError("context 必须是 JSON 对象或 null")
                analysis = analyze_schedule_performance(
                    moves,
                    device,
                    str(payload.get("windowMode") or "steady"),
                    context,
                    run_metrics,
                )
                self._send_json({
                    "ok": True,
                    "analysis": analysis,
                    "bottleneck": summarize_bottleneck_utilization(analysis),
                })
            except Exception as error:  # noqa: BLE001
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/analysis/test-group":
            try:
                payload = self._read_json_object()
                cases = payload.get("cases")
                if not isinstance(cases, list):
                    raise ValueError("cases 必须是数组")
                if not all(isinstance(item, Mapping) for item in cases):
                    raise ValueError("cases 的每一项都必须是 JSON 对象")
                self._send_json({
                    "ok": True,
                    "analysis": analyze_test_group_performance(cases),
                })
            except Exception as error:  # noqa: BLE001
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.BAD_REQUEST,
                )
            return
        if path == "/api/run-batch":
            try:
                payload = self._read_json_object()
                device_id = str(payload.get("deviceId") or "")
                strategy = str(payload.get("strategy") or "heuristic")
                options = payload.get("options")
                if not isinstance(options, Mapping):
                    options = {}
                test_ids = payload.get("testIds")
                if test_ids is not None and not isinstance(test_ids, list):
                    raise ValueError("testIds 必须是测试 ID 数组")
                result = start_workspace_test_batch(
                    device_id,
                    str(payload.get("group") or ""),
                    strategy,
                    options,
                    skip_validation=bool(payload.get("skipValidation")),
                    hongye_check=bool(payload.get("hongYeCheck", True)),
                    skip_baseline=bool(payload.get("skipBaseline")),
                    use_process_isolation=True,
                    test_ids=test_ids,
                )
                self._send_json(result, HTTPStatus.ACCEPTED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/workspaces/devices":
            try:
                payload = self._read_json_object()
                device, created = import_workspace_device(
                    str(payload.get("name") or "未命名设备"), payload.get("device"),
                )
                self._send_json({"ok": True, "created": created, "device": {
                    "id": device["id"],
                    "name": device["name"],
                    "testCount": len(device.get("tests") or []),
                }})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        workspace_parts = [part for part in path.split("/") if part]
        if len(workspace_parts) == 4 and workspace_parts[:2] == ["api", "workspaces"] and workspace_parts[3] == "groups":
            try:
                payload = self._read_json_object()
                groups = create_workspace_test_group(workspace_parts[2], str(payload.get("name") or ""))
                self._send_json({"ok": True, "groups": groups}, HTTPStatus.CREATED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(workspace_parts) == 4 and workspace_parts[:2] == ["api", "workspaces"] and workspace_parts[3] == "tests":
            try:
                payload = self._read_json_object()
                test_case = create_workspace_test(workspace_parts[2], payload)
                self._send_json({"ok": True, "test": test_case}, HTTPStatus.CREATED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path != "/api/run":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        payload: Any = None
        replay_plan: Optional[Dict[str, Any]] = None
        baseline_response: Optional[Dict[str, Any]] = None
        client_run_id = ""
        request_started = time.perf_counter()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("请求为空或超过大小限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("请求体必须是 JSON 对象")
            workspace_device_id = str(payload.get("workspaceDeviceId") or "")
            workspace_test_id = str(payload.get("workspaceTestId") or "")
            strategy = str(payload.get("strategy") or "heuristic")
            client_run_id = str(payload.get("clientRunId") or "").strip()
            if client_run_id:
                _start_single_run(
                    client_run_id,
                    strategy,
                    str(payload.get("testCaseName") or payload.get("deviceName") or "当前测试"),
                )
            if workspace_device_id and workspace_test_id:
                device, test_case = get_workspace_run_context(
                    workspace_device_id,
                    workspace_test_id,
                )
                selected_plan = deepcopy(dict(payload))
                runtime_device = deepcopy(device.get("device"))
                if isinstance(runtime_device, dict):
                    apply_robot_slot_selection(runtime_device, device.get("robotSlots"))
                    selected_plan["device"] = runtime_device
                replay_plan = deepcopy(selected_plan)
                if client_run_id:
                    with _monitor_single_run(client_run_id, strategy):
                        result, baseline, run_error = _execute_workspace_test_with_baseline(
                            device,
                            test_case,
                            strategy,
                            dict(payload.get("options") or {}),
                            selected_plan=selected_plan,
                            skip_validation=bool(payload.get("skipValidation")),
                            hongye_check=bool(payload.get("hongYeCheck", True)),
                            skip_baseline=bool(payload.get("skipBaseline")),
                        )
                else:
                    result, baseline, run_error = _execute_workspace_test_with_baseline(
                        device,
                        test_case,
                        strategy,
                        dict(payload.get("options") or {}),
                        selected_plan=selected_plan,
                        skip_validation=bool(payload.get("skipValidation")),
                        hongye_check=bool(payload.get("hongYeCheck", True)),
                        skip_baseline=bool(payload.get("skipBaseline")),
                    )
                baseline_response = deepcopy(baseline)
                if run_error is not None or result is None:
                    raise run_error or RuntimeError("运行未返回结果")
                result.update(_baseline_comparison(result, baseline))
            else:
                replay_plan = deepcopy(dict(payload))
                if client_run_id:
                    with _monitor_single_run(client_run_id, strategy):
                        result = execute_plan(payload)
                else:
                    result = execute_plan(payload)
            artifact = deepcopy(dict(result["output"]))
            artifact["RunMetricsMetadata"] = {
                "cpuTimeMs": max(
                    0.0,
                    float(result.get("cpuTimeMs", result.get("totalElapsedMs", 0.0))),
                ),
                "recomputeCount": sum(
                    1 for row in (result.get("rounds") or [])
                    if isinstance(row, Mapping) and row.get("kind") == "recompute"
                ),
            }
            if replay_plan is not None:
                artifact["ReplayContext"] = {
                    "schema": "machine-replay-context-v1",
                    "plan": replay_plan,
                    "updates": deepcopy(list(result.get("updates") or [])),
                }
            result_id = save_result(artifact)
            log_id = save_reproduction_log(result["reproductionLog"])
            response = {
                key: value
                for key, value in result.items()
                if key not in {"output", "reproductionLog"}
            }
            response["resultId"] = result_id
            response["ganttUrl"] = f"/movelist_gantt_viewer.html?src=/api/results/{result_id}"
            response.update(_log_response_fields(log_id))
            if client_run_id:
                _finish_single_run(client_run_id, "completed")
            self._send_json(response)
        except LoggedPlanError as error:
            if client_run_id:
                _finish_single_run(client_run_id, "failed", str(error))
            log_id = save_reproduction_log(error.reproduction_log)
            response = {"ok": False, "error": str(error)}
            if baseline_response is not None:
                response["baseline"] = baseline_response
            response.update(_log_response_fields(log_id))
            response.update(_logged_failure_result_fields(
                error,
                replay_plan=replay_plan,
            ))
            strategy = str(payload.get("strategy") or "") if isinstance(payload, Mapping) else ""
            if strategy.casefold().startswith("other_alg:"):
                elapsed_ms = (time.perf_counter() - request_started) * 1000.0
                moves = list((error.failure_output or {}).get("MoveList") or [])
                response.update({
                    "metricsAvailable": True,
                    "totalElapsedMs": elapsed_ms,
                    "cpuTimeMs": elapsed_ms,
                    "validation": "failed",
                    "robotWaferDwellTime": _robot_wafer_dwell_time(moves),
                })
                if baseline_response is not None and "makespan" in response:
                    response.update(_baseline_comparison(response, baseline_response))
            self._send_json(response, HTTPStatus.BAD_REQUEST)
        except Exception as error:  # noqa: BLE001
            reproduction = ReproductionLog()
            reproduction.add("Input", [deepcopy(dict(payload))] if isinstance(payload, Mapping) else [])
            reproduction.add("AlgOutput", _alg_output_info(feedback=[{
                "Level": "Error",
                "Type": type(error).__name__,
                "Message": str(error),
            }]))
            log_id = save_reproduction_log(reproduction.entries)
            cancelled_error_type = globals().get("SearchCancelledError")
            cancelled = (
                isinstance(error, UserRunCancelledError)
                or cancelled_error_type is not None
                and isinstance(error, cancelled_error_type)
            )
            if cancelled:
                response = {"ok": False, "cancelled": True, "error": "运行已取消"}
            else:
                response = {"ok": False, "error": str(error) or type(error).__name__}
            if client_run_id:
                _finish_single_run(
                    client_run_id,
                    "cancelled" if cancelled else "failed",
                    response["error"],
                )
            if baseline_response is not None:
                response["baseline"] = baseline_response
            response.update(_log_response_fields(log_id))
            self._send_json(response, HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:
        """保存测试、路径模板、机器手槽位或测试组别。"""
        path = unquote(urlparse(self.path).path)
        parts = [part for part in path.split("/") if part]
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "device-timing":
            try:
                payload = self._read_json_object()
                device_data = update_workspace_device_timing(
                    parts[2], payload.get("timing"),
                )
                self._send_json({"ok": True, "device": device_data})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "robot-slots":
            try:
                payload = self._read_json_object()
                robot_slots = update_workspace_robot_slots(
                    parts[2], payload.get("robotSlots"),
                )
                self._send_json({"ok": True, "robotSlots": robot_slots})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "routes":
            try:
                payload = self._read_json_object()
                result = update_workspace_routes(parts[2], payload, include_tests=False)
                self._send_json({"ok": True, **result})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "groups":
            try:
                payload = self._read_json_object()
                result = rename_workspace_test_group(
                    parts[2], str(payload.get("oldName") or ""), str(payload.get("name") or ""),
                )
                self._send_json({"ok": True, **result})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) != 5 or parts[:2] != ["api", "workspaces"] or parts[3] != "tests":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self._read_json_object()
            test_case = update_workspace_test(parts[2], parts[4], payload)
            self._send_json({"ok": True, "test": test_case})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_DELETE(self) -> None:
        """删除导出文件、设备下指定测试集或测试组，并返回剩余数据。"""
        path = unquote(urlparse(self.path).path)
        if path == "/api/exports":
            try:
                deleted_counts = clear_exported_artifacts()
                self._send_json({"ok": True, "deleted": deleted_counts})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path.startswith("/api/run-batches/"):
            batch = cancel_workspace_batch_run(path.rsplit("/", 1)[-1])
            if batch is None:
                self._send_json({"ok": False, "error": "批量任务不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(batch)
            return
        if path.startswith("/api/runs/"):
            run = _cancel_single_run(path.rsplit("/", 1)[-1])
            if run is None:
                self._send_json({"ok": False, "error": "单测任务不存在或尚未开始"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(run)
            return
        parts = [part for part in path.split("/") if part]
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[2] == "devices":
            try:
                deleted = delete_workspace_device(parts[3])
                self._send_json({"ok": True, "deleted": deleted})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "groups":
            try:
                payload = self._read_json_object()
                result = delete_workspace_test_group(parts[2], str(payload.get("name") or ""))
                self._send_json({"ok": True, **result})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) != 5 or parts[:2] != ["api", "workspaces"] or parts[3] != "tests":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            delete_workspace_test(parts[2], parts[4])
            device = get_workspace_device(parts[2])
            self._send_json({"ok": True, "tests": device["tests"]})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def _handle_register_algorithm(self) -> None:
        """登记管理员上传的包含 ``init/update`` 的单文件外部算法。

        请求体为 JSON：``filename`` 为原始文件名，``content`` 为源码的
        base64 文本，``name`` 为可选的显示名。登记结果永久保存在本地
        data 目录，刷新页面后算法卡片即可使用。
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_REGISTERED_ALGORITHM_BYTES:
                raise ValueError("请求为空或超过大小限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("请求体必须是 JSON 对象")
            filename = str(payload.get("filename") or "").strip()
            content = base64.b64decode(str(payload.get("content") or ""), validate=True)
            name = str(payload.get("name") or "").strip() or None
            algorithm = register_algorithm(content, filename, name)
            self._send_json({"ok": True, "algorithm": algorithm})
        except (ValueError, TypeError, UnicodeDecodeError) as error:
            self._send_json(
                {"ok": False, "error": str(error)},
                HTTPStatus.BAD_REQUEST,
            )
        except OSError as error:
            self._send_json(
                {"ok": False, "error": f"保存算法失败：{error}"},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )
        except Exception as error:  # noqa: BLE001
            self._send_json(
                {"ok": False, "error": f"登记算法失败：{error}"},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def log_message(self, format_string: str, *args: Any) -> None:
        """保留简洁的本地访问日志。"""
        sys.stdout.write(f"[config-editor] {self.address_string()} {format_string % args}\n")

    def _send_file(self, path: Path, content_type: str) -> None:
        """发送白名单中的静态文件。"""
        if not path.is_file():
            self._send_json({"ok": False, "error": f"文件不存在：{path}"}, HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self._send_performance_headers(len(content))
        self.end_headers()
        self.wfile.write(content)

    def _send_bytes(self, content: bytes, content_type: str, download_name: str) -> None:
        """发送一次性生成的二进制下载内容。"""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self._send_performance_headers(len(content))
        self.end_headers()
        self.wfile.write(content)

    def _send_frontend_asset(self, asset_name: str) -> None:
        """发送构建后的前端资源，并拒绝目录穿越和未知文件类型。"""
        content_types = {
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".map": "application/json; charset=utf-8",
        }
        asset_path = (FRONTEND_ASSET_DIR / asset_name).resolve()
        if asset_path.parent != FRONTEND_ASSET_DIR.resolve():
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        content_type = content_types.get(asset_path.suffix.lower())
        if content_type is None:
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        self._send_file(asset_path, content_type)

    def _read_json_object(self) -> Dict[str, Any]:
        """读取受大小限制的 JSON 对象请求体。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("请求为空或超过大小限制")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, Mapping):
            raise ValueError("请求体必须是 JSON 对象")
        return dict(payload)

    def _read_binary_body(self, maximum_bytes: int) -> bytes:
        """读取有明确上限的二进制请求体，供本机模型文件上传使用。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > maximum_bytes:
            raise ValueError("文件为空或超过大小限制")
        return self.rfile.read(length)

    def _send_performance_headers(self, response_bytes: int) -> None:
        """附加当前请求的服务耗时和响应体积，便于浏览器与基准工具采集。"""
        started = getattr(self, "_request_started_performance", time.perf_counter())
        elapsed_ms = max(0.0, (time.perf_counter() - started) * 1000.0)
        self.send_header("Server-Timing", f"app;dur={elapsed_ms:.3f}")
        self.send_header("X-Response-Bytes", str(max(0, int(response_bytes))))

    def _send_json(
        self,
        payload: Any,
        status: HTTPStatus = HTTPStatus.OK,
        download_name: Optional[str] = None,
        top_level_item_per_line: bool = False,
    ) -> None:
        """以 UTF-8 JSON 返回 API 结果。"""
        if top_level_item_per_line:
            content_text = format_reproduction_log(payload)
        else:
            content_text = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        content = content_text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self._send_performance_headers(len(content))
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    """启动仅监听本机的多线程调度控制台服务。"""
    parser = argparse.ArgumentParser(description="CT 调度控制台本地服务")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认仅本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口")
    parser.add_argument("--open", action="store_true", help="启动后打开默认浏览器")
    args = parser.parse_args()
    url = f"http://{args.host}:{args.port}/"
    # 仅在版本变化或检测到外部更新文件时整理工作区；完成标记使后续启动直接跳过。
    legacy_store = DATA_DIR / "workspaces.json"
    legacy_present = legacy_store.is_file()
    legacy_directory_present = _has_separate_legacy_workspace_directory(WORKSPACE_STORE_PATH)
    if _workspace_data_update_required():
        print("正在更新工作区数据…", end="", flush=True)
        _prepare_workspace_data()
        print(" 完成")
    if legacy_present:
        print(
            f"已自动迁移旧版工作区数据：{legacy_store.name} → {WORKSPACE_STORE_PATH.name}/ 拆分目录"
        )
        print(f"原文件备份为 {legacy_store.name}.legacy.json，确认无误后可删除。")
    if legacy_directory_present:
        print(
            f"已自动迁移旧版目录：workspaces/ + devices/ → {WORKSPACE_STORE_PATH.name}/ v{WORKSPACE_STORE_VERSION}"
        )
        print("原目录已移入 data/migration-backups/，确认新版数据正常后可清理。")
    print("正在预热算法缓存…", end="", flush=True)
    discover_other_algorithms()
    print(" 完成")
    # 数据迁移和缓存预热全部完成后才开始监听，避免浏览器读到半迁移状态。
    server = ThreadingHTTPServer((args.host, args.port), ConfigEditorHandler)
    print(f"CT 调度控制台：{url}")
    print("按 Ctrl+C 停止服务")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
