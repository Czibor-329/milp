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
import getpass
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
    (ALGORITHM_ROOT / "infer" / "scheduler.py").is_file()
    and (ALGORITHM_ROOT / "src").is_dir()
)
if ALGORITHM_REPOSITORY_PRESENT and str(ALGORITHM_ROOT) not in sys.path:
    # 保留父仓库自身 tests/scripts 等包的解析优先级，算法仓库只提供
    # 父仓库中不存在的 infer/src 命名空间。
    sys.path.append(str(ALGORITHM_ROOT))

BUILTIN_ALGORITHM_IMPORT_ERROR = ""
BUILTIN_ALGORITHM_AVAILABLE = False
if ALGORITHM_REPOSITORY_PRESENT:
    try:
        from infer import scheduler as builtin_algorithm_scheduler
        from infer.function import (
            SUPPORTED_ALGORITHMS as builtin_supported_algorithms,
            get_last_strategy_diagnostics as builtin_strategy_diagnostics,
            session as builtin_algorithm_session,
        )
        from src.parse import parse_task
        from src.paths import MODELS_DIR
        from src.schedule.realtime import (
            RealtimeRescheduler,
            TIME_TOLERANCE,
        )
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
    expand_pse300_loadlocks,
    extract_init_data,
)
from realtime_scheduler.recompute_state import (
    add_new_materials_to_machine_state,
    apply_machine_state_to_update,
    merge_algorithm_update,
    release_reused_source_slots,
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
from realtime_scheduler import auth as _auth
from realtime_scheduler.documentation import DocumentationError, load_documentation


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
# 登录失败后的固定延迟（秒），用于拖慢针对已知用户名的暴力破解。
LOGIN_FAILURE_DELAY = 0.5
# 是否强制登录认证。默认免登录，便于本地/直接分发使用（本机管理员身份，
# 页面与接口全量可用）；对外部署（公网网址、多人共用）必须设置
# CT_REQUIRE_AUTH=1 开启登录，否则任何能访问地址的人都能操作系统。
AUTH_REQUIRED = os.environ.get("CT_REQUIRE_AUTH", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024
MAX_SAVED_RESULTS = 8
MAX_SAVED_BATCH_RUNS = 8
WORKSPACE_STORE_VERSION = 3
API_SCHEMA_VERSION = "cjob-pjob-v3"
HEURISTIC_BASELINE_SCHEMA_VERSION = "petri-look-dynamic-v1"
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
DATA_DIR = REALTIME_APP_DIR / "data"
EXPORT_DIR = REALTIME_APP_DIR / "exports"
EDITOR_PATH = FRONTEND_DIR / "config_editor.html"
VIEWER_PATH = FRONTEND_DIR / "movelist_gantt_viewer.html"
ROUTE_EDITOR_LOGIC_PATH = FRONTEND_DIR / "route_editor_logic.js"
LOGIN_PATH = FRONTEND_DIR / "login.html"
ADMIN_USERS_PATH = FRONTEND_DIR / "admin_users.html"
FRONTEND_ASSET_DIR = FRONTEND_DIR / "assets"
USERS_PATH = DATA_DIR / _auth.USER_FILE_NAME
DOCUMENTATION_DIR = DATA_DIR / "documentation"
E2E_CTQ_MODEL_PATH = ALGORITHM_ROOT / "results" / "models" / "e2e_ctq_policy.npz"
DUAL_ACTOR_MODEL_PATH = (
    ALGORITHM_ROOT / "results" / "dual_actor_primitive_v1_candidate.npz"
)
BUILTIN_ALGORITHM_CATALOG_PATH = ALGORITHM_ROOT / "algorithms.json"
ALGORITHM_CATALOG_SCHEMA_VERSION = 1
WORKSPACE_STORE_PATH = DATA_DIR / "workspaces"
LEGACY_WORKSPACE_STORE_PATH = ALGORITHM_ROOT / "results" / "config_editor_workspaces.json"
DEVICE_INIT_DIR = DATA_DIR / "devices"
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
            unavailable_reason = "算法未加入 infer.function.SUPPORTED_ALGORITHMS"
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
    """按 input_data 录制格式收集一次控制台运行的全部事件。"""

    entries: List[Dict[str, Any]] = field(default_factory=list)

    def add(self, describe: str, info: Any, sim_time: float = 0.0) -> None:
        """追加带墙钟时间和仿真时间的标准日志项。"""
        self.entries.append({
            "Time": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            "Describe": describe,
            "SimTime": float(sim_time),
            "Info": deepcopy(info),
        })


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
        self.problem = parse_task(self.tool_topo, self.current_update)
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
    ) -> None:
        """保存已执行历史，以调用方给定的重算快照装载下一代计划。"""
        next_state = (
            initial_state.clone()
            if initial_state is not None
            else self._tracker.state.clone()
        )
        add_new_materials_to_machine_state(next_state, update_params)
        next_update = deepcopy(dict(update_params))
        next_problem = parse_task(self.tool_topo, next_update)
        next_moves = list(output.get("MoveList") or [])
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(
                next_problem,
                next_moves,
                next_state,
            )
        )
        if validation_issues:
            message = f"{reason} MoveList 状态校验失败：{validation_issues[0]}"
            committed = (
                deepcopy(list(committed_moves))
                if committed_moves is not None
                else self._tracker.executed_moves
            )
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
        self._history.extend(
            deepcopy(list(committed_moves))
            if committed_moves is not None
            else self._tracker.executed_moves
        )
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
        该片完成。只有同一 LoadPort 的历史物料全部完成后才允许槽位复用。
        """
        material_moves: Dict[Any, List[Mapping[str, Any]]] = {}
        for move in self.current_plan:
            for material_id in _move_material_ids(move):
                material_moves.setdefault(material_id, []).append(move)
        released_ids = {
            material_id
            for material_id, moves in material_moves.items()
            if moves and max(
                float(move.get("EndTime") or move.get("StartTime") or 0.0)
                for move in moves
            ) <= self.state_time + TIME_TOLERANCE
        }
        if released_ids:
            _remove_released_materials_from_update(self.current_update, released_ids)

        remaining_ports = {
            str(material.get("CurrentModuleName") or "")
            for material in (self.current_update.get("Materials") or [])
            if isinstance(material, Mapping)
        }
        empty_ports = {
            str(load_port_name)
            for load_port_name in load_port_names
            if str(load_port_name) not in remaining_ports
        }
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
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(None, next_moves, next_state)
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
                    prefix_moves=[*self._history, *deepcopy(list(committed_moves))],
                    recompute_points=[*self._recompute_points, recompute_point],
                ),
                float(requested_time),
            )
        self._history.extend(deepcopy(list(committed_moves)))
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


def _alg_output_info(
    output: Optional[Mapping[str, Any]] = None,
    feedback: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """生成与 input_data 中 AlgOutput 相同的顶层结构。"""
    source = output or {}
    return {
        "MoveList": deepcopy(list(source.get("MoveList") or [])),
        "Feedback": deepcopy(list(feedback if feedback is not None else source.get("Feedback") or [])),
        "JobList": deepcopy(list(source.get("JobList") or [])),
        "DummyReturnInfo": deepcopy(dict(source.get("DummyReturnInfo") or {})),
        "MatIntoPM": deepcopy(dict(source.get("MatIntoPM") or {})),
    }


def _validation_issue_records(
    validation_issues: Sequence[Any],
) -> List[Dict[str, Any]]:
    """把校验文案转换成甘特图可定位的结构化错误记录。"""
    records: List[Dict[str, Any]] = []
    move_id_pattern = re.compile(
        r"(?:\bMoveID\b|\bid\b)\s*[=:]\s*(-?\d+)",
        re.IGNORECASE,
    )
    for issue in validation_issues:
        message = str(issue)
        match = move_id_pattern.search(message)
        record: Dict[str, Any] = {"Message": message}
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
) -> Dict[str, Any]:
    """按原始重算时刻生成标准 update，并携带真实 Move 状态通知。"""
    update = merge_algorithm_update(runtime.current_update, new_round_update)
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
    return update


def _build_packaged_algorithm_recompute_update(
    runtime: PackagedAlgorithmRuntime,
    new_round_update: Mapping[str, Any],
    requested_time: float,
    move_states: Sequence[Mapping[str, Any]],
    projected_state: Optional[MachineState] = None,
) -> Dict[str, Any]:
    """用平台物理快照为算法包构造下一轮标准 update。"""
    update = merge_algorithm_update(runtime.current_update, new_round_update)
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


def _release_finished_load_ports(
    runtime: Any,
    build_state: BuildState,
) -> Tuple[set[Any], set[str]]:
    """在新一轮装片前卸载成品，并重置已经清空的 LoadPort 槽位计数。"""
    released_ids, empty_ports = runtime.release_completed_load_ports(
        tuple(build_state.next_slot_by_port),
    )
    for load_port_name in empty_ports:
        build_state.next_slot_by_port[load_port_name] = 0
    return released_ids, empty_ports


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
        backend = "infer.scheduler"
        display_name = builtin_strategy
        entry_name = "infer.scheduler.init/update"
        session_context = builtin_algorithm_session()

        def initialize(payload: Mapping[str, Any]) -> None:
            """通过公开 JSON 入口初始化内置算法。"""
            builtin_algorithm_scheduler.init(
                json.dumps(dict(payload), ensure_ascii=False)
            )

        def run_update(payload: Mapping[str, Any]) -> Dict[str, Any]:
            """通过公开 JSON 入口执行内置算法并解析标准输出。"""
            raw_output = builtin_algorithm_scheduler.update(
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
        entry_name = "CT.infer.scheduler.init/update"
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
        initialize(plan["device"])
        raw_output = run_update(prepared_first_update)
        elapsed_ms = (time.perf_counter() - round_started) * 1000.0
        output = _alg_output_info(raw_output)
        _ensure_algorithm_output(output, prepared_first_update)
        uses_full_platform_runtime = BUILTIN_ALGORITHM_AVAILABLE
        runtime: Any
        if uses_full_platform_runtime:
            runtime = StandardAlgorithmRuntime(
                plan["device"],
                prepared_first_update,
                output,
                skip_validation=skip_validation,
            )
            state_source = "realtime_scheduler.move_validation.MachineState"
        else:
            runtime = PackagedAlgorithmRuntime(
                prepared_first_update,
                output,
                skip_validation=skip_validation,
            )
            state_source = "realtime_scheduler.move_validation.MachineState"
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

        for index, round_config in enumerate(rounds[1:], start=2):
            requested_time = float(times[index - 1])
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
            released_ids, empty_ports = _release_finished_load_ports(runtime, build_state)
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
            reason = f"第 {index} 轮新增 Job"
            reproduction.add("RecomputeControl", {
                "ControlInfo": {"Round": index},
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
                )
            else:
                update = _build_packaged_algorithm_recompute_update(
                    runtime,
                    new_round_update,
                    requested_time,
                    notifications,
                    projected_state=projected_state,
                )
            update_snapshots.append(deepcopy(update))
            reproduction.add(
                "AlgSchedule",
                _schedule_log_info(plan["device"], update),
                requested_time,
            )
            round_started = time.perf_counter()
            raw_output = run_update(update)
            elapsed_ms = (time.perf_counter() - round_started) * 1000.0
            output = _alg_output_info(raw_output)
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
            reproduction.add("AlgOutput", output, requested_time)
            summaries.append({
                "index": index,
                "kind": "recompute",
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
                f"[{index}/{round_count}] @{requested_time:.2f}s {display_name} 重算完成："
                f"{elapsed_ms:.1f} ms，移除 {len(update['RemoveList'])} 个旧 Move"
            )
            if released_ids:
                logs.append(
                    f"  已卸载 {len(released_ids)} 片成品；"
                    f"清空 LoadPort={','.join(sorted(empty_ports)) or '无'}"
                )

    combined_output = runtime.combined_output()

    search_telemetry: Optional[Dict[str, Any]] = None
    if builtin_strategy == "schedule-alphago":
        search_telemetry = dict(
            builtin_algorithm_scheduler.get_search_telemetry()
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
    reproduction = ReproductionLog()
    reproduction.add("Input", [deepcopy(dict(raw_plan))])
    cpu_started = time.thread_time() if hasattr(time, "thread_time") else time.process_time()
    try:
        result = _execute_plan(raw_plan, reproduction)
    except Exception as error:  # noqa: BLE001
        # 用户主动取消属于预期终止而非运行失败，原样向上传播，
        # 由 /api/run 返回 cancelled 标记。
        cancelled_error_type = globals().get("SearchCancelledError")
        if (
            cancelled_error_type is not None
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
            )
            raise LoggedPlanError(
                str(error),
                reproduction.entries,
                failure_output=error.gantt_output,
                validation_issues=error.validation_issues,
            ) from error
        reproduction.add("AlgOutput", _alg_output_info(feedback=feedback))
        raise LoggedPlanError(str(error), reproduction.entries) from error
    cpu_finished = time.thread_time() if hasattr(time, "thread_time") else time.process_time()
    result["cpuTimeMs"] = max(0.0, (cpu_finished - cpu_started) * 1000.0)
    result["reproductionLog"] = deepcopy(reproduction.entries)
    return result


def _workspace_timestamp() -> str:
    """生成工作区记录使用的本地秒级时间。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _empty_workspace_catalog() -> Dict[str, Any]:
    """创建当前版本的空设备工作区目录。"""
    return {"version": WORKSPACE_STORE_VERSION, "devices": []}


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
    """迁移已有测试的唯一 TaskID，并统一每个 CJob 下所有 PJob 的 LoadPort。"""
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
                load_port = _automatic_workspace_load_port(
                    load_ports,
                    int(task_id),
                ) or fallback_load_port
                normalized_fields = {
                    "taskId": task_id,
                    "taskMode": task_mode,
                    "loadPort": load_port,
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


def _normalized_workspace_routes(raw_routes: Sequence[Any]) -> List[Any]:
    """校验页面 Route 的 BufferOption，并清除不可编辑的 PostCJob Clean。"""
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
        if "postCJobCleanRefs" in route:
            route["postCJobCleanRefs"] = []
    return routes


def _migrate_workspace_catalog(catalog: Dict[str, Any]) -> bool:
    """迁移设备工作区结构，并为已有 PSE300 补齐 LC/LD LoadLock。"""
    changed = int(catalog.get("version") or 0) != WORKSPACE_STORE_VERSION
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, dict):
            continue
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
        # 旧数据按更新时间从早到晚合并，因此最近编辑的同名定义成为设备共享定义。
        for test in sorted(tests, key=lambda item: str(item.get("updatedAt") or item.get("createdAt") or "")):
            if "routes" in test:
                routes = _merge_named_assets(routes, test.get("routes") or [])
                test.pop("routes", None)
                changed = True
            if "cleans" in test:
                cleans = _merge_named_assets(cleans, test.get("cleans") or [])
                test.pop("cleans", None)
                changed = True
        if _repair_workspace_route_recipes(
            routes,
            _workspace_processing_modules(raw_device),
        ):
            changed = True
        if _repair_workspace_route_contracts(routes):
            changed = True
        if _repair_workspace_job_layout(raw_device):
            changed = True
        if raw_device.get("routes") != routes:
            raw_device["routes"] = routes
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
        if path == WORKSPACE_STORE_PATH and (DATA_DIR / "workspaces.json").is_file():
            _migrate_legacy_workspace_store(path)
        elif not path.is_dir():
            if path != WORKSPACE_STORE_PATH:
                return _empty_workspace_catalog()
            legacy_candidates = (DATA_DIR / "workspaces.json", LEGACY_WORKSPACE_STORE_PATH)
            if any(candidate.is_file() for candidate in legacy_candidates):
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
    changed = _migrate_workspace_catalog(catalog)
    if changed:
        _write_workspace_catalog_unlocked(path, catalog)
    return catalog


def _read_workspace_catalog_directory(store_dir: Path) -> Dict[str, Any]:
    """在调用方持锁时扫描拆分目录，组装完整设备工作区目录。

    目录布局为 ``<store_dir>/<device_id>/device.json`` 与
    ``<store_dir>/<device_id>/tests/<test_id>.json``；设备目录或测试集文件
    可直接拷贝分享，放入后下次读取即生效。
    """
    catalog = _empty_workspace_catalog()
    if not store_dir.is_dir():
        return catalog
    for device_dir in sorted(store_dir.iterdir()):
        if not device_dir.is_dir():
            continue
        device_file = device_dir / "device.json"
        if not device_file.is_file():
            continue
        try:
            raw_device = json.loads(device_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"设备文件无效：{device_file}") from error
        if not isinstance(raw_device, dict):
            continue
        tests = []
        tests_dir = device_dir / "tests"
        if tests_dir.is_dir():
            for test_file in sorted(tests_dir.glob("*.json")):
                try:
                    raw_test = json.loads(test_file.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    raise ValueError(f"测试集文件无效：{test_file}") from error
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
    都会在默认存储路径下刷新 ``data/devices/<id>.json`` 设备拓扑镜像。
    """
    if path.suffix == "":
        _write_workspace_catalog_directory(path, catalog)
        if path == WORKSPACE_STORE_PATH:
            _write_device_init_mirrors(catalog)
        return
    _write_json_atomic(path, catalog)
    if path == WORKSPACE_STORE_PATH:
        _write_device_init_mirrors(catalog)


def _write_device_init_mirrors(catalog: Mapping[str, Any]) -> None:
    """把每台设备的拓扑镜像写入 data/devices/，供外部工具读取。"""
    for device in catalog.get("devices") or []:
        if not isinstance(device, Mapping) or not isinstance(device.get("device"), Mapping):
            continue
        device_id = str(device.get("id") or "").strip()
        if device_id:
            _write_json_atomic(DEVICE_INIT_DIR / f"{device_id}.json", device["device"])


def _write_json_if_changed(path: Path, payload: Any) -> None:
    """内容变化时才原子写入 JSON，避免全量重写覆盖他人刚更新的文件。"""
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        current = None
    if current != payload:
        _write_json_atomic(path, payload)


def _write_workspace_catalog_directory(store_dir: Path, catalog: Mapping[str, Any]) -> None:
    """在调用方持锁时把完整目录拆分写为设备目录与测试集文件。

    每个设备写 ``<store_dir>/<device_id>/device.json``（不含 tests），每个测试集
    写 ``<store_dir>/<device_id>/tests/<test_id>.json``；内容未变的文件跳过写入，
    使共享目录下他人刚放入的文件不被覆盖。本函数只负责写入，不删除磁盘上的
    任何文件——测试集与设备的物理删除由对应的 delete_* 操作显式完成，从而保证
    通过拷贝分享进来的文件在任意后续写入后仍然保留。
    """
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
            if not test_id:
                continue
            _write_json_if_changed(tests_dir / f"{test_id}.json", test)


def _remove_directory_test_file(store_dir: Path, device_id: str, test_id: str) -> None:
    """目录模式下物理删除单个测试集文件；文件模式为空操作。"""
    if store_dir.suffix == "":
        (store_dir / device_id / "tests" / f"{test_id}.json").unlink(missing_ok=True)


def _remove_directory_device_dir(store_dir: Path, device_id: str) -> None:
    """目录模式下物理删除整个设备目录（含全部测试集文件）；文件模式为空操作。"""
    if store_dir.suffix == "":
        shutil.rmtree(store_dir / device_id, ignore_errors=True)


def list_workspace_devices(path: Path = WORKSPACE_STORE_PATH) -> List[Dict[str, Any]]:
    """列出本地保存的设备摘要，不返回体积较大的 init 和测试集内容。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        return [{
            "id": str(device.get("id") or ""),
            "name": str(device.get("name") or "未命名设备"),
            "testCount": len(device.get("tests") or []),
            "updatedAt": device.get("updatedAt"),
        } for device in catalog["devices"] if isinstance(device, Mapping)]


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


def delete_workspace_device(device_id: str, path: Path = WORKSPACE_STORE_PATH) -> Dict[str, Any]:
    """从本地工作区删除一台设备及其全部测试集，并返回被删除设备的摘要。

    设备删除后不可恢复：拆分目录模式会移除 ``<store>/<device_id>/`` 设备目录
    （含其中全部测试集文件），设备初始文件（``DEVICE_INIT_DIR/<id>.json``）
    也会一并清理。设备不存在时抛出明确错误；已被历史批量任务引用的设备不会
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
        # 先物理删除设备目录与初始文件再写目录：即使中途中断，下次扫描也不会复活该设备。
        _remove_directory_device_dir(path, device_id)
        if path == WORKSPACE_STORE_PATH:
            try:
                (DEVICE_INIT_DIR / f"{device_id}.json").unlink(missing_ok=True)
            except OSError:
                # 设备初始文件只是工作区拓扑的镜像缓存，删除失败不影响工作区移除。
                pass
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
        normalize(device_data), ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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
    return {
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
        load_port = _automatic_workspace_load_port(
            load_ports,
            first_task_id + cjob_index - 1,
        ) or fallback_load_port
        pjobs = [
            _normalize_workspace_pjob(item, pjob_index, task_id, load_port)
            for pjob_index, item in enumerate(pjob_rows, start=1)
        ]
        cjobs.append({
            "taskId": task_id,
            "loadPort": load_port,
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
        "rounds": rounds,
        "createdAt": str(raw_test.get("createdAt") or timestamp),
        "updatedAt": timestamp,
    }
    if isinstance(raw_test.get("baseline"), Mapping):
        normalized["baseline"] = deepcopy(dict(raw_test["baseline"]))
    return normalized


def _apply_device_library(device: Dict[str, Any], payload: Mapping[str, Any]) -> None:
    """将前端随保存请求提交的 Route/Clean 写入设备级共享库。"""
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
    if isinstance(payload.get("routes"), list):
        device["routes"] = _normalized_workspace_routes(payload["routes"])
    else:
        device.setdefault("routes", [])
    if isinstance(payload.get("cleans"), list):
        device["cleans"] = deepcopy(payload["cleans"])
    else:
        device.setdefault("cleans", [])


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


def update_workspace_test(
    device_id: str,
    test_id: str,
    raw_test: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """覆盖保存一个测试集，同时保持创建时间和稳定 ID。"""
    with _workspace_catalog_guard(path):
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

    def do_GET(self) -> None:
        """处理页面、健康检查和内存结果读取。"""
        parsed_url = urlparse(self.path)
        path = unquote(parsed_url.path)
        if path == "/login.html":
            self._send_file(LOGIN_PATH, "text/html; charset=utf-8")
            return
        if path in {"/", "/config_editor.html"}:
            self._send_file(EDITOR_PATH, "text/html; charset=utf-8")
            return
        if path in {"/", "/config_editor.html", "/movelist_gantt_viewer.html", "/admin_users.html"}:
            # 页面必须登录后才能访问，未登录一律转向登录页。
            if self._current_username() is None:
                self._redirect("/login.html")
                return
            if path == "/movelist_gantt_viewer.html":
                self._send_file(VIEWER_PATH, "text/html; charset=utf-8")
            elif path == "/admin_users.html":
                self._send_file(ADMIN_USERS_PATH, "text/html; charset=utf-8")
            else:
                self._send_file(EDITOR_PATH, "text/html; charset=utf-8")
            return
        if path == "/route_editor_logic.js":
            self._send_file(ROUTE_EDITOR_LOGIC_PATH, "text/javascript; charset=utf-8")
            return
        if path.startswith("/assets/"):
            self._send_frontend_asset(path.removeprefix("/assets/"))
            return
        if path.startswith("/api/"):
            # 健康检查用于监控，不要求登录；其余 API 一律需要有效会话。
            if path != "/api/health" and self._current_username() is None:
                self._send_json(
                    {"ok": False, "error": "未登录或会话已过期"},
                    HTTPStatus.UNAUTHORIZED,
                )
                return
        if path == "/api/health":
            builtin_algorithms = discover_builtin_algorithms()
            other_algorithms = discover_other_algorithms()
            # 已登录用户只能看到分配给自己的算法；未登录（监控探测）不暴露算法清单。
            username = self._current_username()
            if AUTH_REQUIRED and username is None:
                # 强制登录且未登录（监控探测）不暴露算法清单。
                builtin_algorithms = []
                other_algorithms = []
            elif AUTH_REQUIRED:
                allowed_strategies = _auth.user_strategies(username, USERS_PATH)
                if allowed_strategies is not None:
                    allowed_set = set(allowed_strategies)
                    builtin_algorithms = [
                        item for item in builtin_algorithms
                        if str(item.get("strategy")) in allowed_set
                    ]
                    other_algorithms = [
                        item for item in other_algorithms
                        if str(item.get("strategy")) in allowed_set
                    ]
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
        if path == "/api/session":
            if not AUTH_REQUIRED:
                # 免登录模式：返回本机管理员身份，供前端展示入口。
                self._send_json({
                    "ok": True,
                    "username": "local",
                    "role": "admin",
                    "allowedAlgorithms": None,
                    "allowedDevices": None,
                })
                return
            username = self._current_username()
            if username is None:
                self._send_json(
                    {"ok": False, "error": "未登录或会话已过期"},
                    HTTPStatus.UNAUTHORIZED,
                )
                return
            info = next((
                item for item in _auth.list_user_infos(USERS_PATH)
                if item["username"] == username
            ), None)
            if info is None:
                # 账号已被删除：会话视为无效，不允许继续使用系统。
                _auth.destroy_user_sessions(username)
                self._send_json(
                    {"ok": False, "error": "账号不存在或已删除"},
                    HTTPStatus.UNAUTHORIZED,
                )
                return
            self._send_json({"ok": True, **info})
            return
        if path == "/api/documentation":
            try:
                document = load_documentation(DOCUMENTATION_DIR)
            except DocumentationError as error:
                self._send_json(
                    {"ok": False, "error": str(error)},
                    HTTPStatus.NOT_FOUND,
                )
                return
            self._send_json({"ok": True, "document": document})
            return
        if path == "/api/admin/users":
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可管理用户"},
                    HTTPStatus.FORBIDDEN,
                )
                return
            self._send_json({"ok": True, "users": _auth.list_user_infos(USERS_PATH)})
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
                    "telemetry": builtin_algorithm_scheduler.get_search_telemetry(
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
                # 强制登录时普通用户只能看到分配给自己的设备；免登录模式看到全部。
                username = self._current_username()
                allowed_devices = None
                if AUTH_REQUIRED:
                    allowed_devices = (
                        None
                        if username is None
                        else _auth.user_devices(username, USERS_PATH)
                    )
                if allowed_devices is not None:
                    allowed_set = set(allowed_devices)
                    devices = [
                        item for item in devices
                        if str(item.get("id")) in allowed_set
                    ]
                self._send_json({"ok": True, "devices": devices})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path.startswith("/api/workspaces/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) == 3:
                if self._deny_device(parts[2]):
                    self._send_json(
                        {"ok": False, "error": "设备不存在"},
                        HTTPStatus.NOT_FOUND,
                    )
                    return
                try:
                    self._send_json({"ok": True, "device": get_workspace_device(parts[2])})
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
        batch_parts = [part for part in path.split("/") if part]
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
        if path == "/api/login":
            self._handle_login()
            return
        if path == "/api/logout":
            self._handle_logout()
            return
        if path == "/api/admin/users":
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可管理用户"},
                    HTTPStatus.FORBIDDEN,
                )
                return
            try:
                payload = self._read_json_object()
                username = str(payload.get("username") or "").strip()
                password = str(payload.get("password") or "")
                role = str(payload.get("role") or _auth.ROLE_USER)
                allowed_algorithms = payload.get("allowedAlgorithms")
                allowed_devices = payload.get("allowedDevices")
                if not username:
                    raise ValueError("用户名不能为空")
                if role not in {_auth.ROLE_ADMIN, _auth.ROLE_USER}:
                    raise ValueError(f"未知角色：{role}")
                if len(password) < _auth.MIN_PASSWORD_LENGTH:
                    raise ValueError(
                        f"密码长度必须不少于 {_auth.MIN_PASSWORD_LENGTH} 位"
                    )
                if not isinstance(allowed_algorithms, list) or not isinstance(
                    allowed_devices, list
                ):
                    raise ValueError("allowedAlgorithms 与 allowedDevices 必须是数组")
                created = _auth.add_user(
                    username,
                    password,
                    USERS_PATH,
                    role=role,
                    allowed_algorithms=[str(item) for item in allowed_algorithms],
                    allowed_devices=[str(item) for item in allowed_devices],
                )
                self._send_json({"ok": True, "created": created})
            except (ValueError, TypeError) as error:
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        admin_parts = [part for part in path.split("/") if part]
        if (
            len(admin_parts) == 5
            and admin_parts[:3] == ["api", "admin", "users"]
            and admin_parts[4] == "password"
        ):
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可管理用户"},
                    HTTPStatus.FORBIDDEN,
                )
                return
            try:
                payload = self._read_json_object()
                password = str(payload.get("password") or "")
                if len(password) < _auth.MIN_PASSWORD_LENGTH:
                    raise ValueError(
                        f"密码长度必须不少于 {_auth.MIN_PASSWORD_LENGTH} 位"
                    )
                if not _auth.set_user_password(admin_parts[3], password, USERS_PATH):
                    raise ValueError("账号不存在")
                self._send_json({"ok": True})
            except ValueError as error:
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
        if self._current_username() is None:
            self._send_json(
                {"ok": False, "error": "未登录或会话已过期"},
                HTTPStatus.UNAUTHORIZED,
            )
            return
        if path == "/api/search-control":
            # search-control 可暂停求解或指定实际执行的动作，需要登录保护。
            try:
                if not BUILTIN_ALGORITHM_AVAILABLE:
                    raise RuntimeError("本地算法仓库未加载，无法控制搜索")
                payload = self._read_json_object()
                result = builtin_algorithm_scheduler.control_search(
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
                else:
                    moves = normalize_move_payload(
                        payload.get("moves", payload.get("result")),
                    )
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
                if self._deny_device(device_id):
                    raise ValueError("设备不在当前账号权限内")
                if self._deny_strategy(strategy):
                    raise ValueError(f"算法 {strategy} 不在当前账号权限内")
                options = payload.get("options")
                if not isinstance(options, Mapping):
                    options = {}
                result = start_workspace_test_batch(
                    device_id,
                    str(payload.get("group") or ""),
                    strategy,
                    options,
                    skip_validation=bool(payload.get("skipValidation")),
                    skip_baseline=bool(payload.get("skipBaseline")),
                )
                self._send_json(result, HTTPStatus.ACCEPTED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/workspaces/devices":
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可导入设备"},
                    HTTPStatus.FORBIDDEN,
                )
                return
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
            if self._deny_device(workspace_parts[2]):
                self._send_json(
                    {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
                )
                return
            try:
                payload = self._read_json_object()
                groups = create_workspace_test_group(workspace_parts[2], str(payload.get("name") or ""))
                self._send_json({"ok": True, "groups": groups}, HTTPStatus.CREATED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(workspace_parts) == 4 and workspace_parts[:2] == ["api", "workspaces"] and workspace_parts[3] == "tests":
            if self._deny_device(workspace_parts[2]):
                self._send_json(
                    {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
                )
                return
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
            if workspace_device_id and self._deny_device(workspace_device_id):
                raise ValueError("设备不在当前账号权限内")
            if self._deny_strategy(strategy):
                raise ValueError(f"算法 {strategy} 不在当前账号权限内")
            if workspace_device_id and workspace_test_id:
                device = get_workspace_device(workspace_device_id)
                test_case = next((
                    item for item in (device.get("tests") or [])
                    if str(item.get("id") or "") == workspace_test_id
                ), None)
                if test_case is None:
                    raise ValueError(f"测试集不存在：{workspace_test_id}")
                selected_plan = deepcopy(dict(payload))
                runtime_device = deepcopy(device.get("device"))
                if isinstance(runtime_device, dict):
                    apply_robot_slot_selection(runtime_device, device.get("robotSlots"))
                    selected_plan["device"] = runtime_device
                replay_plan = deepcopy(selected_plan)
                result, baseline, run_error = _execute_workspace_test_with_baseline(
                    device,
                    test_case,
                    str(payload.get("strategy") or "heuristic"),
                    dict(payload.get("options") or {}),
                    selected_plan=selected_plan,
                    skip_validation=bool(payload.get("skipValidation")),
                    skip_baseline=bool(payload.get("skipBaseline")),
                )
                baseline_response = deepcopy(baseline)
                if run_error is not None or result is None:
                    raise run_error or RuntimeError("运行未返回结果")
                result.update(_baseline_comparison(result, baseline))
            else:
                replay_plan = deepcopy(dict(payload))
                result = execute_plan(payload)
            artifact = deepcopy(dict(result["output"]))
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
            self._send_json(response)
        except LoggedPlanError as error:
            log_id = save_reproduction_log(error.reproduction_log)
            response = {"ok": False, "error": str(error)}
            if baseline_response is not None:
                response["baseline"] = baseline_response
            response.update(_log_response_fields(log_id))
            response.update(_logged_failure_result_fields(error))
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
            if cancelled_error_type is not None and isinstance(error, cancelled_error_type):
                response = {"ok": False, "cancelled": True, "error": "运行已取消"}
            else:
                response = {"ok": False, "error": str(error) or type(error).__name__}
            if baseline_response is not None:
                response["baseline"] = baseline_response
            response.update(_log_response_fields(log_id))
            self._send_json(response, HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:
        """保存测试集、机器手槽位或重命名设备下的测试组别。"""
        if self._current_username() is None:
            self._send_json(
                {"ok": False, "error": "未登录或会话已过期"},
                HTTPStatus.UNAUTHORIZED,
            )
            return
        path = unquote(urlparse(self.path).path)
        parts = [part for part in path.split("/") if part]
        if (
            len(parts) == 4
            and parts[:3] == ["api", "admin", "users"]
            and parts[3] != "password"
        ):
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可管理用户"},
                    HTTPStatus.FORBIDDEN,
                )
                return
            try:
                payload = self._read_json_object()
                role = str(payload.get("role") or "")
                allowed_algorithms = payload.get("allowedAlgorithms")
                allowed_devices = payload.get("allowedDevices")
                if role not in {_auth.ROLE_ADMIN, _auth.ROLE_USER}:
                    raise ValueError(f"未知角色：{role}")
                if not isinstance(allowed_algorithms, list) or not isinstance(
                    allowed_devices, list
                ):
                    raise ValueError("allowedAlgorithms 与 allowedDevices 必须是数组")
                target_name = parts[3]
                if role == _auth.ROLE_USER:
                    infos = _auth.list_user_infos(USERS_PATH)
                    target_is_admin = any(
                        item["username"] == target_name
                        and item["role"] == _auth.ROLE_ADMIN
                        for item in infos
                    )
                    remaining_admins = [
                        item for item in infos
                        if item["username"] != target_name
                        and item["role"] == _auth.ROLE_ADMIN
                    ]
                    if target_is_admin and not remaining_admins:
                        raise ValueError("至少需要保留一名管理员")
                updated = _auth.update_user(
                    target_name,
                    USERS_PATH,
                    role=role,
                    allowed_algorithms=[str(item) for item in allowed_algorithms],
                    allowed_devices=[str(item) for item in allowed_devices],
                )
                if not updated:
                    raise ValueError("账号不存在")
                self._send_json({"ok": True})
            except (ValueError, TypeError) as error:
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "device-timing":
            if self._deny_device(parts[2]):
                self._send_json(
                    {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
                )
                return
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
            if self._deny_device(parts[2]):
                self._send_json(
                    {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
                )
                return
            try:
                payload = self._read_json_object()
                robot_slots = update_workspace_robot_slots(
                    parts[2], payload.get("robotSlots"),
                )
                self._send_json({"ok": True, "robotSlots": robot_slots})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "groups":
            if self._deny_device(parts[2]):
                self._send_json(
                    {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
                )
                return
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
        if self._deny_device(parts[2]):
            self._send_json(
                {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
            )
            return
        try:
            payload = self._read_json_object()
            test_case = update_workspace_test(parts[2], parts[4], payload)
            self._send_json({"ok": True, "test": test_case})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_DELETE(self) -> None:
        """删除导出文件、设备下指定测试集或测试组，并返回剩余数据。"""
        if self._current_username() is None:
            self._send_json(
                {"ok": False, "error": "未登录或会话已过期"},
                HTTPStatus.UNAUTHORIZED,
            )
            return
        path = unquote(urlparse(self.path).path)
        admin_parts = [part for part in path.split("/") if part]
        if (
            len(admin_parts) == 4
            and admin_parts[:3] == ["api", "admin", "users"]
        ):
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可管理用户"},
                    HTTPStatus.FORBIDDEN,
                )
                return
            username = admin_parts[3]
            if username == self._current_username():
                self._send_json(
                    {"ok": False, "error": "不能删除当前登录的账号"},
                    HTTPStatus.BAD_REQUEST,
                )
                return
            infos = _auth.list_user_infos(USERS_PATH)
            target_is_admin = any(
                item["username"] == username and item["role"] == _auth.ROLE_ADMIN
                for item in infos
            )
            if target_is_admin:
                remaining_admins = [
                    item for item in infos
                    if item["username"] != username
                    and item["role"] == _auth.ROLE_ADMIN
                ]
                if not remaining_admins:
                    self._send_json(
                        {"ok": False, "error": "至少需要保留一名管理员"},
                        HTTPStatus.BAD_REQUEST,
                    )
                    return
            if not _auth.remove_user(username, USERS_PATH):
                self._send_json(
                    {"ok": False, "error": "账号不存在"}, HTTPStatus.NOT_FOUND
                )
                return
            # 删除账号后立即销毁其全部会话，防止已登录会话继续使用系统。
            _auth.destroy_user_sessions(username)
            self._send_json({"ok": True})
            return
        if path == "/api/exports":
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可清理导出数据"},
                    HTTPStatus.FORBIDDEN,
                )
                return
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
        parts = [part for part in path.split("/") if part]
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[2] == "devices":
            if self._require_admin() is None:
                self._send_json(
                    {"ok": False, "error": "仅管理员可删除设备"},
                    HTTPStatus.FORBIDDEN,
                )
                return
            try:
                deleted = delete_workspace_device(parts[3])
                self._send_json({"ok": True, "deleted": deleted})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if len(parts) == 4 and parts[:2] == ["api", "workspaces"] and parts[3] == "groups":
            if self._deny_device(parts[2]):
                self._send_json(
                    {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
                )
                return
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
        if self._deny_device(parts[2]):
            self._send_json(
                {"ok": False, "error": "设备不存在"}, HTTPStatus.NOT_FOUND
            )
            return
        try:
            delete_workspace_test(parts[2], parts[4])
            device = get_workspace_device(parts[2])
            self._send_json({"ok": True, "tests": device["tests"]})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def _request_token(self) -> Optional[str]:
        """从 Cookie 请求头解析会话令牌，没有则返回 None。"""
        cookie_header = self.headers.get("Cookie") or ""
        for part in cookie_header.split(";"):
            name, _, value = part.strip().partition("=")
            if name == _auth.SESSION_COOKIE_NAME:
                return value
        return None

    def _current_username(self) -> Optional[str]:
        """返回当前请求会话对应的用户名；未登录或会话过期返回 None。

        免登录模式下直接返回本机管理员身份，页面与接口全量可用。
        """
        if not AUTH_REQUIRED:
            return "local"
        token = self._request_token()
        if not token:
            return None
        return _auth.get_session_username(token)

    def _require_admin(self) -> Optional[str]:
        """返回当前用户名（须为管理员）；未登录或非管理员返回 None。

        免登录模式下返回本机管理员身份，管理员操作全部放行。
        """
        if not AUTH_REQUIRED:
            return "local"
        username = self._current_username()
        if username is None:
            return None
        return username if _auth.is_admin(username, USERS_PATH) else None

    def _deny_device(self, device_id: str) -> bool:
        """设备不在当前用户权限内时返回 True，调用方应返回 404。

        免登录模式下放行全部设备。
        """
        if not AUTH_REQUIRED:
            return False
        return not _auth.user_allows_device(
            str(self._current_username() or ""), str(device_id), USERS_PATH
        )

    def _deny_strategy(self, strategy: str) -> bool:
        """算法不在当前用户权限内时返回 True，调用方应返回 403。

        免登录模式下放行全部算法。
        """
        if not AUTH_REQUIRED:
            return False
        return not _auth.user_allows_algorithm(
            str(self._current_username() or ""), str(strategy), USERS_PATH
        )

    def _redirect(self, location: str) -> None:
        """发送 302 跳转，用于未登录时转向登录页。"""
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _handle_login(self) -> None:
        """校验账号密码，成功则种下会话 Cookie。"""
        try:
            payload = self._read_json_object()
        except (ValueError, json.JSONDecodeError) as error:
            self._send_json(
                {"ok": False, "error": str(error)},
                HTTPStatus.BAD_REQUEST,
            )
            return
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        if not username or not password:
            self._send_json(
                {"ok": False, "error": "请输入用户名和密码"},
                HTTPStatus.BAD_REQUEST,
            )
            return
        if not _auth.verify_credentials(username, password, USERS_PATH):
            time.sleep(LOGIN_FAILURE_DELAY)
            self._send_json(
                {"ok": False, "error": "用户名或密码错误"},
                HTTPStatus.UNAUTHORIZED,
            )
            return
        token = _auth.create_session(username)
        content = json.dumps(
            {"ok": True, "username": username}, ensure_ascii=False
        ).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Set-Cookie", _auth.session_cookie(token))
        self.end_headers()
        self.wfile.write(content)

    def _handle_logout(self) -> None:
        """删除当前会话令牌并返回成功。"""
        _auth.destroy_session(self._request_token())
        self._send_json({"ok": True})

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
        self.end_headers()
        self.wfile.write(content)

    def _send_bytes(self, content: bytes, content_type: str, download_name: str) -> None:
        """发送一次性生成的二进制下载内容。"""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
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
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(content)


def _run_account_command(args: argparse.Namespace) -> None:
    """执行账号管理命令后退出（不启动服务）。"""
    if args.add_user:
        username = args.add_user
        password = getpass.getpass(
            f"为账号 {username} 设置密码（至少 {_auth.MIN_PASSWORD_LENGTH} 位）："
        )
        if len(password) < _auth.MIN_PASSWORD_LENGTH:
            print(f"密码长度必须不少于 {_auth.MIN_PASSWORD_LENGTH} 位")
            return
        if password != getpass.getpass("再次输入密码确认："):
            print("两次输入不一致，未保存")
            return
        created = _auth.add_user(username, password, USERS_PATH)
        print(f"账号 {username} 已{'新建' if created else '重置密码'}")
        return
    if args.remove_user:
        removed = _auth.remove_user(args.remove_user, USERS_PATH)
        if removed:
            print(f"账号 {args.remove_user} 已删除")
        else:
            print(f"账号 {args.remove_user} 不存在")
        return
    if args.list_users:
        users = _auth.list_users(USERS_PATH)
        print("当前账号：" + ("、".join(users) if users else "无"))


def main() -> None:
    """启动仅监听本机的多线程调度控制台服务。"""
    parser = argparse.ArgumentParser(description="CT 调度控制台本地服务")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认仅本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口")
    parser.add_argument("--open", action="store_true", help="启动后打开默认浏览器")
    parser.add_argument(
        "--add-user", metavar="USERNAME", help="新建账号或重置密码后退出（不启动服务）"
    )
    parser.add_argument(
        "--remove-user", metavar="USERNAME", help="删除账号后退出（不启动服务）"
    )
    parser.add_argument(
        "--list-users", action="store_true", help="列出全部账号后退出（不启动服务）"
    )
    args = parser.parse_args()
    if args.add_user or args.remove_user or args.list_users:
        _run_account_command(args)
        return
    default_admin_created = _auth.ensure_default_admin(USERS_PATH)
    if default_admin_created:
        print(
            f"已创建默认账号 {_auth.DEFAULT_ADMIN_USERNAME}/"
            f"{_auth.DEFAULT_ADMIN_PASSWORD}，上线后请立即修改密码"
        )
    server = ThreadingHTTPServer((args.host, args.port), ConfigEditorHandler)
    url = f"http://{args.host}:{args.port}/"
    print(f"CT 调度控制台：{url}")
    if AUTH_REQUIRED:
        print("已启用强制登录（CT_REQUIRE_AUTH=1），页面与接口需要登录。")
    else:
        print(
            "当前为免登录模式：打开即用，无需登录；"
            "对外部署请设置环境变量 CT_REQUIRE_AUTH=1 开启登录保护。"
        )
    # 预热工作区：旧版单文件（data/workspaces.json）存在时自动迁移为拆分目录。
    legacy_store = DATA_DIR / "workspaces.json"
    legacy_present = legacy_store.is_file()
    list_workspace_devices()
    if legacy_present:
        print(
            f"已自动迁移旧版工作区数据：{legacy_store.name} → {WORKSPACE_STORE_PATH.name}/ 拆分目录"
        )
        print(f"原文件备份为 {legacy_store.name}.legacy.json，确认无误后可删除。")
    print("正在预热算法缓存…", end="", flush=True)
    discover_other_algorithms()
    print(" 完成")
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
