"""后端启动配置、共享常量、算法可用性和进程内状态容器。


页面只负责编辑设备引用、设备级共享 Clean/Route 和各轮新增 Job；本服务把请求展开成
标准调度接口数据，依次运行首次排程与实时重算，并通过 backend.analysis 提供统一的
MoveList 性能分析 API。设备、共享工艺库、测试集、甘特图结果和复现日志统一保存在
realtime_scheduler 目录中。批处理、Baseline 与并发运行状态由 batch_service 模块负责，
本模块只保存跨后端模块共享的启动配置和进程状态。

用法：
    python -m realtime_scheduler.backend.main
    python -m realtime_scheduler.backend.main --port 8765 --open
"""

from __future__ import annotations

import argparse
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


ROOT = Path(__file__).resolve().parents[2]
# 始终把当前仓库放到模块搜索首位，避免环境中安装的旧版同名包遮蔽当前源码。
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
from realtime_scheduler.backend.algorithms.interface import (
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
from realtime_scheduler.backend.execution.plan_builder import (
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
from realtime_scheduler.backend.execution.recompute_state import (
    add_new_materials_to_machine_state,
    apply_machine_state_to_update,
    merge_algorithm_update,
    release_reused_source_slots,
    restore_dummy_routes_from_algorithm_output,
)
from realtime_scheduler.backend.validation.move_validation import (
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
    materialize_module_parallel_moves,
    release_completed_load_port_materials,
    validate_move_list,
)
from realtime_scheduler.backend.validation.replay_machine import ReplayMachine
from realtime_scheduler.backend.api.documentation import DocumentationError, load_documentation
from realtime_scheduler.backend.validation.hongye import HongYeValidationSession
from realtime_scheduler.backend.observability import (
    configure_logging,
    log_http_access,
    log_run_event,
    log_startup,
)


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024
MAX_SAVED_RESULTS = 8
MAX_SAVED_BATCH_RUNS = 8
MAX_SAVED_SINGLE_RUNS = 8
MAX_CJOB_CYCLE = 1000
WORKSPACE_DELETE_CLEANUP_RETRY_DELAYS_SECONDS = (0.0, 0.05, 0.2, 0.5, 1.0)
MAX_WORKSPACE_DEVICE_COUNT = 10
CJOB_CYCLE_EVENT_EPSILON_MULTIPLIER = 2.0
WORKSPACE_STORE_VERSION = 7
WORKSPACE_STORE_VERSION_FILE = "manifest.json"
LEGACY_WORKSPACE_STORE_VERSION_FILE = ".workspace-version.json"
WORKSPACE_TEST_INDEX_FILE = ".tests-index.json"
# 交换包上传体积与解压体积必须分别限制：设备 JSON 重复结构较多，合法包的
# 压缩率可能很高，不能把 HTTP 上传上限误用为解压后总量上限。
DATA_EXCHANGE_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
DATA_EXCHANGE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
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

__all__ = tuple(name for name in globals() if not name.startswith('__'))
