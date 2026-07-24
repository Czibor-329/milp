"""CT 实时调度终端本地服务。

页面只负责编辑设备引用、设备级共享 Clean/Route 和各轮新增 Job；本服务把请求展开成
标准调度接口数据，依次运行首次排程与实时重算。设备、共享工艺库、测试集、甘特图结果和
复现日志统一保存在 realtime_scheduler 目录中。

用法：
    python realtime_scheduler/server.py
    python realtime_scheduler/server.py --port 8765 --open

兼容入口：python scripts/config_editor_server.py
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import sys
import threading
import time
import uuid
import webbrowser
from collections import OrderedDict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.parse import parse_task
from src.paths import MODELS_DIR
from src.schedule.realtime import (
    RealtimeRescheduler,
    TIME_TOLERANCE,
    release_completed_load_port_materials,
)
from src.validation import MoveStateReplay
from src.validation.move_fields import (
    COMPLETE_MOVE, PICK_MOVE, PLACE_MOVE, PREPARE_MOVE, PRE_PREPARE_MOVE,
    PRE_TRANS_MOVE, SWAP_MOVE,
)
from src.validation.state import (
    ATMOSPHERE,
    DoorState,
    LoadLockState,
    MachineState,
    MaterialState,
    SlotPhase,
    SlotState,
)
from realtime_scheduler.algorithm_interface import (
    discover_other_algorithms,
    init as algorithm_init,
    session as algorithm_session,
    update as algorithm_update,
)
from realtime_scheduler.plan_builder import (
    CJOB_TYPE_VALUES,
    FIRST_SLOT_ID,
    MAX_WAFERS_PER_JOB,
    PSE300_REQUIRED_ROBOTS,
    PSE300_REQUIRED_STATIONS,
    TASK_MODE_VALUES,
    BuildState,
    _enum_value,
    _finite_number,
    _round_cjob_rows,
    _round_pjob_count,
    _stage_visit_rows,
    _string_list,
    build_process_recipes,
    build_round_update,
    build_route,
    expand_pse300_loadlocks,
    extract_init_data,
)


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_L2D_CHECKPOINT_BYTES = 8 * 1024 * 1024
MAX_SAVED_RESULTS = 8
MAX_SAVED_BATCH_RUNS = 8
WORKSPACE_STORE_VERSION = 2
API_SCHEMA_VERSION = "cjob-pjob-v3"
HEURISTIC_BASELINE_SCHEMA_VERSION = "petri-look-dynamic-v1"
MAX_MILP_WAFERS = 12
DEFAULT_MILP_TIME_LIMIT_SECONDS = 120.0
CJOB_TYPE_NAMES = {value: name for name, value in CJOB_TYPE_VALUES.items()}
TASK_MODE_NAMES = {value: name for name, value in TASK_MODE_VALUES.items()}
REALTIME_APP_DIR = ROOT / "realtime_scheduler"
FRONTEND_DIR = REALTIME_APP_DIR / "frontend"
DATA_DIR = REALTIME_APP_DIR / "data"
EXPORT_DIR = REALTIME_APP_DIR / "exports"
EDITOR_PATH = FRONTEND_DIR / "config_editor.html"
VIEWER_PATH = FRONTEND_DIR / "movelist_gantt_viewer.html"
ROUTE_EDITOR_LOGIC_PATH = FRONTEND_DIR / "route_editor_logic.js"
FRONTEND_ASSET_DIR = FRONTEND_DIR / "assets"
RL_MODEL_PATH = MODELS_DIR / "bc_policy_rl.pt"
NEURAL_MODEL_PATH = ROOT / "src" / "schedule" / "neural_policy.npz"
L2D_MODEL_CANDIDATES = (
    MODELS_DIR / "l2d_pse300_2job.pt",
    ROOT / "l2d_pse300_2job.pt",
    MODELS_DIR / "l2d_pse300_1job.pt",
    ROOT / "l2d_pse300_1job.pt",
)
WORKSPACE_STORE_PATH = DATA_DIR / "workspaces.json"
LEGACY_WORKSPACE_STORE_PATH = ROOT / "results" / "config_editor_workspaces.json"
DEVICE_INIT_DIR = DATA_DIR / "devices"
RESULT_EXPORT_DIR = EXPORT_DIR / "results"
LOG_EXPORT_DIR = EXPORT_DIR / "logs"
_RESULTS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_RESULTS_LOCK = threading.Lock()
_REPRODUCTION_LOGS: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
_REPRODUCTION_LOGS_LOCK = threading.Lock()
_WORKSPACE_STORE_LOCK = threading.RLock()
_BATCH_RUNS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_BATCH_RUNS_LOCK = threading.RLock()
_BATCH_CANCEL_EVENTS: Dict[str, threading.Event] = {}
_RL_POLICY: Any = None
_RL_POLICY_LOCK = threading.Lock()
_NEURAL_POLICY: Any = None
_NEURAL_POLICY_SIGNATURE: Optional[Tuple[str, int, int]] = None
_NEURAL_POLICY_LOCK = threading.Lock()
_L2D_POLICY: Any = None
_L2D_POLICY_SIGNATURE: Optional[Tuple[str, int, int]] = None
_L2D_POLICY_LOCK = threading.Lock()


@contextmanager
def _workspace_catalog_guard(path: Path) -> Iterator[None]:
    """串行化跨线程、跨进程的工作区读改写事务。

    Python 的 ``RLock`` 只能保护当前服务进程。批量验收或桌面端误启第二个服务时，
    两个进程若共用固定 ``.tmp`` 文件会破坏 JSON，单靠原子替换也会发生后写覆盖。
    这里用一字节系统文件锁包住完整读改写事务；锁文件只承载互斥，不保存业务数据。
    """
    lock_path = path.with_suffix(path.suffix + ".lock")
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


class StandardAlgorithmRuntime:
    """用本仓库状态机维护标准算法当前计划和跨代执行历史。"""

    def __init__(
        self,
        tool_topo: Mapping[str, Any],
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
    ) -> None:
        """解析首轮完整 update，并把外部 MoveList 挂到实时状态回放器。"""
        self.tool_topo = deepcopy(dict(tool_topo))
        self.current_update = deepcopy(dict(update_params))
        self.problem = parse_task(self.tool_topo, self.current_update)
        initial_state = MachineState.from_sources(self.problem, self.current_update)
        self._tracker = MoveStateReplay(
            self.problem,
            list(output.get("MoveList") or []),
            initial_state,
        )
        self._tracker.current_time = float(self.current_update.get("CurrentTime") or 0.0)
        self._history: List[dict] = []
        self._recompute_points: List[Dict[str, Any]] = []
        self._latest_output = _alg_output_info(output)

    @property
    def current_plan(self) -> List[dict]:
        """返回当前计划代次，供统一的安全切点投影函数消费。"""
        return [dict(move) for move in self._tracker.materialized_plan]

    @property
    def state(self) -> MachineState:
        """返回由 ``src.validation.state`` 维护的隔离整机快照。"""
        return self._tracker.state.clone()

    @property
    def state_time(self) -> float:
        """返回已经回放到的绝对时间。"""
        return float(self._tracker.current_time)

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

    def replace_plan(
        self,
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        requested_time: float,
        effective_time: float,
        reason: str,
    ) -> None:
        """保存已执行历史，以当前稳定状态和新增物料装载下一代计划。"""
        next_state = self._tracker.state.clone()
        _add_new_materials_to_machine_state(next_state, update_params)
        self._history.extend(self._tracker.executed_moves)
        self.current_update = deepcopy(dict(update_params))
        self.problem = parse_task(self.tool_topo, self.current_update)
        self._tracker = MoveStateReplay(
            self.problem,
            list(output.get("MoveList") or []),
            next_state,
        )
        self._tracker.current_time = float(effective_time)
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


class LoggedPlanError(RuntimeError):
    """携带可下载复现日志的排程异常。"""

    def __init__(self, message: str, reproduction_log: Sequence[Mapping[str, Any]]) -> None:
        super().__init__(message)
        self.reproduction_log = deepcopy(list(reproduction_log))


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


def _schedule_log_info(device: Mapping[str, Any], update: Mapping[str, Any]) -> Dict[str, Any]:
    """把设备拓扑与一轮更新合成可单独回放的 AlgSchedule 输入。"""
    info = deepcopy(dict(update))
    info.setdefault("Robots", deepcopy(dict(device.get("Robots") or {})))
    info.setdefault("Stations", deepcopy(dict(device.get("Stations") or {})))
    return info


def _material_ids_in_machine_state(state: MachineState) -> set[Any]:
    """收集站点槽位和机器人手槽中已经存在的物料编号。"""
    material_ids = {
        slot.material.material_id
        for station in state.stations.values()
        for slot in station.slots.values()
        if slot.material is not None
    }
    material_ids.update(
        material.material_id
        for robot in state.robots.values()
        for material in robot.hands.values()
        if material is not None
    )
    return material_ids


def _add_new_materials_to_machine_state(
    state: MachineState,
    update_params: Mapping[str, Any],
) -> None:
    """把下一轮首次出现的 LoadPort 物料补入上一轮稳定状态。"""
    known_material_ids = _material_ids_in_machine_state(state)
    for raw_material in update_params.get("Materials") or []:
        if not isinstance(raw_material, Mapping):
            continue
        material_id = raw_material.get("ID")
        if material_id is None or material_id in known_material_ids:
            continue
        station_name = str(raw_material.get("CurrentModuleName") or "")
        slot_id = raw_material.get("SlotID")
        if not station_name or not isinstance(slot_id, int) or slot_id < FIRST_SLOT_ID:
            raise ValueError(f"新增物料 {material_id} 缺少有效 CurrentModuleName/SlotID")
        station = state.ensure_station(station_name, slot_id)
        slot = station.slots[slot_id]
        if slot.material is not None:
            raise ValueError(
                f"新增物料 {material_id} 与 {station_name}#{slot_id} 的现有物料冲突"
            )
        station.slots[slot_id] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(
                material_id,
                str(raw_material.get("PJobName") or ""),
                raw_material.get("StepID"),
            ),
        )
        known_material_ids.add(material_id)


def _merge_algorithm_update(
    previous_update: Mapping[str, Any],
    new_round_update: Mapping[str, Any],
) -> Dict[str, Any]:
    """把新一轮 Job 追加到上一轮全量 update，形成企业接口当前快照。"""
    merged = deepcopy(dict(previous_update))
    merged["Scenario"] = new_round_update.get("Scenario", merged.get("Scenario", 0))
    merged["CurrentTime"] = float(new_round_update.get("CurrentTime") or 0.0)
    merged["InitialMoveID"] = int(
        new_round_update.get("InitialMoveID", merged.get("InitialMoveID", 0)) or 0
    )
    merged["ProcessRecipes"] = deepcopy(list(new_round_update.get("ProcessRecipes") or []))
    merged_routes = deepcopy(dict(merged.get("Routes") or {}))
    merged_routes.update(deepcopy(dict(new_round_update.get("Routes") or {})))
    merged["Routes"] = merged_routes

    material_by_id: Dict[Any, Dict[str, Any]] = {}
    for raw_material in [
        *(merged.get("Materials") or []),
        *(new_round_update.get("Materials") or []),
    ]:
        if isinstance(raw_material, Mapping) and raw_material.get("ID") is not None:
            material_by_id[raw_material["ID"]] = deepcopy(dict(raw_material))
    merged["Materials"] = list(material_by_id.values())

    process_job_by_name: Dict[str, Dict[str, Any]] = {}
    for raw_job in [
        *(merged.get("ProcessJobs") or []),
        *(new_round_update.get("ProcessJobs") or []),
    ]:
        if isinstance(raw_job, Mapping) and raw_job.get("JobName"):
            process_job_by_name[str(raw_job["JobName"])] = deepcopy(dict(raw_job))
    merged["ProcessJobs"] = list(process_job_by_name.values())
    merged["ControlJobs"] = [
        deepcopy(dict(control_job))
        for control_job in [
            *(merged.get("ControlJobs") or []),
            *(new_round_update.get("ControlJobs") or []),
        ]
        if isinstance(control_job, Mapping)
    ]
    merged["Robots"] = deepcopy(dict(new_round_update.get("Robots") or {}))
    merged["Stations"] = deepcopy(dict(new_round_update.get("Stations") or {}))
    merged["MoveStates"] = []
    merged["RemoveList"] = []
    return merged


def _remaining_seconds(ready_at: float, current_time: float) -> float:
    """把状态机绝对释放时间转换为企业 update 使用的剩余秒数。"""
    return max(0.0, float(ready_at) - float(current_time))


def _apply_machine_state_to_update(
    update_params: Dict[str, Any],
    state: MachineState,
    current_time: float,
) -> None:
    """将 ``MachineState`` 的物料、机械手、腔室和压力态写回标准 update。"""
    update_params["CurrentTime"] = float(current_time)
    materials = {
        material.get("ID"): material
        for material in update_params.get("Materials") or []
        if isinstance(material, dict) and material.get("ID") is not None
    }
    located_material_ids: set[Any] = set()

    stations = update_params.setdefault("Stations", {})
    for station_name, station_state in state.stations.items():
        station = stations.setdefault(station_name, {})
        shared_ready_at = max(
            station_state.door_busy_until,
            station_state.transfer_busy_until,
            station_state.environment_busy_until,
        )
        slot_times = station.setdefault("TimeToAvailableOfSlot", {})
        material_count = 0
        for slot_id, slot_state in station_state.slots.items():
            slot_times[str(slot_id)] = _remaining_seconds(
                max(shared_ready_at, slot_state.busy_until),
                current_time,
            )
            material = slot_state.material
            if material is None:
                continue
            material_count += 1
            raw_material = materials.get(material.material_id)
            if raw_material is None:
                raise ValueError(
                    f"状态机中的物料 {material.material_id} 不在当前 update.Materials"
                )
            raw_material["CurrentModuleName"] = station_name
            raw_material["SlotID"] = int(slot_id)
            if material.step_id is not None:
                raw_material["StepID"] = material.step_id
            if material.pjob_name:
                raw_material["PJobName"] = material.pjob_name
            located_material_ids.add(material.material_id)
        if "MaterialCount" in station:
            station["MaterialCount"] = material_count
        if isinstance(station_state, LoadLockState):
            station["LastItem"] = "ATR" if station_state.environment == ATMOSPHERE else "VTR"

    robots = update_params.setdefault("Robots", {})
    for robot_name, robot_state in state.robots.items():
        robot = robots.setdefault(robot_name, {})
        robot["TimeToAvailable"] = _remaining_seconds(
            robot_state.busy_until,
            current_time,
        )
        if robot_state.position:
            arm_info = robot.get("ArmInfo") or {}
            if isinstance(arm_info, Mapping):
                for arm in arm_info.values():
                    if isinstance(arm, dict) and arm.get("IsEnable") is not False:
                        arm["SlotAtStation"] = robot_state.position
        for slot_id, material in robot_state.hands.items():
            if material is None:
                continue
            raw_material = materials.get(material.material_id)
            if raw_material is None:
                raise ValueError(
                    f"机械手中的物料 {material.material_id} 不在当前 update.Materials"
                )
            raw_material["CurrentModuleName"] = robot_name
            raw_material["SlotID"] = int(slot_id)
            if material.step_id is not None:
                raw_material["StepID"] = material.step_id
            if material.pjob_name:
                raw_material["PJobName"] = material.pjob_name
            located_material_ids.add(material.material_id)

    # 本轮新增物料尚未进入上一代 MachineState，保留 build_round_update 给出的
    # LoadPort 位置；其余历史物料必须全部能由状态机定位。
    state_material_ids = _material_ids_in_machine_state(state)
    missing_material_ids = state_material_ids - located_material_ids
    if missing_material_ids:
        raise ValueError(f"机台快照存在无法定位的历史物料：{sorted(missing_material_ids)}")


def _build_algorithm_recompute_update(
    runtime: StandardAlgorithmRuntime,
    new_round_update: Mapping[str, Any],
    effective_time: float,
) -> Dict[str, Any]:
    """根据当前状态和旧计划执行分区生成下一次标准算法 update。"""
    update = _merge_algorithm_update(runtime.current_update, new_round_update)
    _apply_machine_state_to_update(update, runtime.state, effective_time)
    executed_ids = runtime.executed_move_ids
    update["MoveStates"] = []
    update["RemoveList"] = [
        int(move["MoveID"])
        for move in runtime.current_plan
        if isinstance(move.get("MoveID"), int)
        and int(move["MoveID"]) not in executed_ids
    ]
    return update


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
    """返回指定在手机械手物料到下一次 Place 并关门为止的旧动作集合。"""
    places = [
        move for move in moves
        if move.get("MoveType") == PLACE_MOVE
        and material_id in _move_material_ids(move)
        and float(move.get("EndTime") or 0.0) > cutoff + TIME_TOLERANCE
    ]
    if not places:
        raise ValueError(f"旧计划找不到 MatID={material_id} 的后续 Place")
    place = min(places, key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move["MoveID"]),
    ))
    destination = str((place.get("DestStationList") or [""])[0])
    place_end = float(place.get("EndTime") or place.get("StartTime") or cutoff)
    close_id = _following_close_id(moves, destination, place_end)
    closure_end = place_end
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
                - float(place.get("StartTime") or 0.0)
            ) <= TIME_TOLERANCE
        ),
        default=place_end,
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

    state = scheduler.state
    for robot in state.robots.values():
        tail_materials.update(
            int(material.material_id)
            for material in robot.hands.values()
            if material is not None and isinstance(material.material_id, int)
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
        for event_time, notification in group["starts"]:
            move_id = int(notification["MoveID"])
            if event_time < cutoff - TIME_TOLERANCE and move_id not in started:
                apply_notification(notification)
        for event_time, notification in group["sameFinishes"]:
            move_id = int(notification["MoveID"])
            if event_time <= cutoff + TIME_TOLERANCE and move_id in started and move_id not in finished:
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
        for _, notification in group["starts"]:
            move_id = int(notification["MoveID"])
            if move_id in required and move_id not in started:
                apply_notification(notification)
        for _, notification in group["sameFinishes"]:
            move_id = int(notification["MoveID"])
            if move_id in required and move_id in started and move_id not in finished:
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


def _load_neural_inference_policy() -> Any:
    """按需加载纯 NumPy 神经模型，并在离线训练覆盖文件后自动刷新。"""
    global _NEURAL_POLICY, _NEURAL_POLICY_SIGNATURE
    with _NEURAL_POLICY_LOCK:
        if not NEURAL_MODEL_PATH.is_file():
            raise ValueError(
                f"深层神经派工模型不存在：{NEURAL_MODEL_PATH}；"
                "请先运行 python scripts/train_neural.py"
            )
        stat = NEURAL_MODEL_PATH.stat()
        signature = (
            str(NEURAL_MODEL_PATH.resolve()),
            stat.st_mtime_ns,
            stat.st_size,
        )
        if _NEURAL_POLICY is not None and _NEURAL_POLICY_SIGNATURE == signature:
            return _NEURAL_POLICY
        from src.schedule.neural import load_neural_policy

        _NEURAL_POLICY = load_neural_policy(NEURAL_MODEL_PATH)
        _NEURAL_POLICY_SIGNATURE = signature
        return _NEURAL_POLICY


def _load_rl_policy() -> Any:
    """按需加载并缓存 RL 模型，文件缺失时给出可操作错误。"""
    global _RL_POLICY
    with _RL_POLICY_LOCK:
        if _RL_POLICY is not None:
            return _RL_POLICY
        if not RL_MODEL_PATH.exists():
            raise ValueError(f"RL 模型不存在：{RL_MODEL_PATH}")
        from src.schedule.policy import load_policy

        _RL_POLICY = load_policy(RL_MODEL_PATH)
        return _RL_POLICY


def _resolve_l2d_model_path() -> Optional[Path]:
    """按“双 Job 优先、标准模型目录优先”的顺序查找 L2D checkpoint。"""
    return next((path for path in L2D_MODEL_CANDIDATES if path.is_file()), None)


def _load_l2d_inference_policy() -> Any:
    """按需加载 L2D 策略，并在 checkpoint 被重新训练覆盖后自动刷新缓存。"""
    global _L2D_POLICY, _L2D_POLICY_SIGNATURE
    with _L2D_POLICY_LOCK:
        model_path = _resolve_l2d_model_path()
        if model_path is None:
            searched = "、".join(str(path) for path in L2D_MODEL_CANDIDATES)
            raise ValueError(f"L2D 模型不存在；已检查：{searched}")
        stat = model_path.stat()
        signature = (str(model_path.resolve()), stat.st_mtime_ns, stat.st_size)
        if _L2D_POLICY is not None and _L2D_POLICY_SIGNATURE == signature:
            return _L2D_POLICY
        from src.schedule.l2d import load_l2d_policy

        _L2D_POLICY = load_l2d_policy(model_path, device="cpu")
        _L2D_POLICY_SIGNATURE = signature
        return _L2D_POLICY


def import_l2d_checkpoint(encoded_data: str) -> Dict[str, Any]:
    """校验并保存页面导入的 L2D checkpoint，返回可展示的模型摘要。"""
    global _L2D_POLICY, _L2D_POLICY_SIGNATURE
    try:
        checkpoint_bytes = base64.b64decode(encoded_data, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("L2D checkpoint 不是有效的 Base64 数据") from error
    if not checkpoint_bytes:
        raise ValueError("L2D checkpoint 为空")
    if len(checkpoint_bytes) > MAX_L2D_CHECKPOINT_BYTES:
        raise ValueError("L2D checkpoint 超过 8MB 限制")

    from src.schedule.l2d import load_l2d_policy

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path = MODELS_DIR / ".l2d_pse300_import.pt.tmp"
    temporary_path.write_bytes(checkpoint_bytes)
    try:
        policy = load_l2d_policy(temporary_path, device="cpu")
        metadata = dict(getattr(policy, "checkpoint_metadata", {}) or {})
        phase = str(metadata.get("training_phase") or "one-job")
        filename = "l2d_pse300_2job.pt" if phase == "two-job" else "l2d_pse300_1job.pt"
        destination = MODELS_DIR / filename
        temporary_path.replace(destination)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise

    signature = (str(destination.resolve()), destination.stat().st_mtime_ns, destination.stat().st_size)
    with _L2D_POLICY_LOCK:
        _L2D_POLICY = policy
        _L2D_POLICY_SIGNATURE = signature
    return {
        "path": str(destination),
        "filename": destination.name,
        "phase": phase,
        "featureVersion": metadata.get("feature_version"),
    }


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
    algorithm_id: str,
) -> Dict[str, Any]:
    """通过同一次标准 ``init/update`` 会话执行首排和多次实时重算。"""
    round_count = len(rounds)
    strategy = f"other_alg:{algorithm_id}"
    backend = f"other_alg/{algorithm_id}"
    display_name = algorithm_id
    summaries: List[Dict[str, Any]] = []
    update_snapshots: List[Dict[str, Any]] = [deepcopy(dict(first_update))]
    logs = [
        f"设备：{plan.get('deviceName') or 'selected init'}",
        f"策略：{strategy}；调用：CT.infer.scheduler.init/update；总轮数：{round_count}",
    ]
    with algorithm_session(algorithm_id):
        round_started = time.perf_counter()
        algorithm_init(plan["device"])
        raw_output = algorithm_update(first_update)
        elapsed_ms = (time.perf_counter() - round_started) * 1000.0
        output = _alg_output_info(raw_output)
        _ensure_algorithm_output(output, first_update)
        runtime = StandardAlgorithmRuntime(plan["device"], first_update, output)
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
                "entry": "CT.infer.scheduler.init/update",
                "feedbackCount": len(output["Feedback"]),
                "removedMoveCount": 0,
                "stateSource": "src.validation.state.MachineState",
            },
        })
        logs.append(
            f"[1/{round_count}] {display_name} 首排完成："
            f"{elapsed_ms:.1f} ms，{len(output['MoveList'])} Moves"
        )

        for index, round_config in enumerate(rounds[1:], start=2):
            requested_time = float(times[index - 1])
            notifications: List[Dict[str, Any]] = []
            recovery = advance_to_recompute(
                runtime,
                requested_time,
                notifications,
                include_loadlock_environment=True,
            )
            effective_time = float(recovery.recovery_end)
            released_ids, empty_ports = _release_finished_load_ports(runtime, build_state)
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
                    "EffectiveTime": effective_time,
                    "Reason": reason,
                },
            }, requested_time)

            new_round_update = build_round_update(
                plan,
                round_config,
                effective_time,
                build_state,
            )
            update = _build_algorithm_recompute_update(
                runtime,
                new_round_update,
                effective_time,
            )
            update_snapshots.append(deepcopy(update))
            reproduction.add(
                "AlgSchedule",
                _schedule_log_info(plan["device"], update),
                requested_time,
            )
            round_started = time.perf_counter()
            raw_output = algorithm_update(update)
            elapsed_ms = (time.perf_counter() - round_started) * 1000.0
            output = _alg_output_info(raw_output)
            _ensure_algorithm_output(output, update)
            runtime.replace_plan(
                update,
                output,
                requested_time,
                effective_time,
                reason,
            )
            reproduction.add("AlgOutput", output, effective_time)
            summaries.append({
                "index": index,
                "kind": "recompute",
                "requestedTime": requested_time,
                "effectiveTime": effective_time,
                "scheduleStartTime": effective_time,
                "recoveryEndTime": effective_time,
                "jobCount": _round_pjob_count(round_config),
                "elapsedMs": elapsed_ms,
                "segmentEnd": _segment_end(output["MoveList"]),
                "strategyDiagnostics": {
                    "backend": backend,
                    "entry": "CT.infer.scheduler.init/update",
                    "feedbackCount": len(output["Feedback"]),
                    "removedMoveCount": len(update["RemoveList"]),
                    "moveStateCount": len(update["MoveStates"]),
                    "stateSource": "src.validation.state.MachineState",
                },
            })
            suffix = (
                f"，安全收尾至 {effective_time:.2f}s"
                if effective_time > requested_time + TIME_TOLERANCE
                else ""
            )
            logs.append(
                f"[{index}/{round_count}] @{requested_time:.2f}s {display_name} 重算完成："
                f"{elapsed_ms:.1f} ms，移除 {len(update['RemoveList'])} 个旧 Move"
                f"{suffix}"
            )
            if released_ids:
                logs.append(
                    f"  已卸载 {len(released_ids)} 片成品；"
                    f"清空 LoadPort={','.join(sorted(empty_ports)) or '无'}"
                )

    combined_output = runtime.combined_output()
    total_ms = (time.perf_counter() - started) * 1000.0
    makespan = _segment_end(combined_output["MoveList"])
    logs.append(
        f"完成：总耗时 {total_ms:.1f} ms，"
        f"makespan={makespan:.2f}s，Move={len(combined_output['MoveList'])}"
    )
    return {
        "ok": True,
        "strategy": strategy,
        "rounds": summaries,
        "totalElapsedMs": total_ms,
        "makespan": makespan,
        "moveCount": len(combined_output["MoveList"]),
        "validation": "passed",
        "logs": logs,
        "updates": update_snapshots,
        "output": combined_output,
    }


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
    builtin_strategies = {"heuristic", "neural", "rl", "l2d", "milp"}
    discovered_ids = {
        str(item["id"])
        for item in discover_other_algorithms()
    }
    if normalized_strategy not in builtin_strategies and other_algorithm_id not in discovered_ids:
        raise ValueError(
            "策略只支持 heuristic、neural、rl、l2d、milp，"
            "或 other_alg 下已发现的标准算法"
        )
    strategy = normalized_strategy if normalized_strategy in builtin_strategies else strategy
    if strategy == "l2d" and (
        not PSE300_REQUIRED_STATIONS.issubset(plan["device"].get("Stations") or {})
        or not PSE300_REQUIRED_ROBOTS.issubset(plan["device"].get("Robots") or {})
    ):
        raise ValueError("L2D checkpoint 仅适用于 PSE300（PM1–PM4、ATR、VTR）")
    rounds = [row for row in (plan.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = int(_finite_number(plan.get("roundCount"), len(rounds)))
    if round_count < 1 or len(rounds) != round_count:
        raise ValueError("轮次数量与 roundCount 不一致")
    if strategy == "milp" and round_count != 1:
        raise ValueError("MILP 策略只支持首次排程，不能选择多次重算")
    times = [_finite_number(row.get("currentTime"), 0.0) for row in rounds]
    if abs(times[0]) > TIME_TOLERANCE:
        raise ValueError("首次排程时间必须为 0")
    if any(right <= left + TIME_TOLERANCE for left, right in zip(times, times[1:])):
        raise ValueError("各轮重算时间必须严格递增")

    if strategy == "neural":
        policy = _load_neural_inference_policy()
    elif strategy == "rl":
        policy = _load_rl_policy()
    elif strategy == "l2d":
        policy = _load_l2d_inference_policy()
    else:
        policy = None
    options = plan.get("options") if isinstance(plan.get("options"), Mapping) else {}
    default_loadlock_manager_mode = (
        "joint" if strategy == "neural" else "petri-look"
    )
    loadlock_manager_mode = str(
        options.get("loadLockManager") or default_loadlock_manager_mode
    ).strip().lower()
    if loadlock_manager_mode not in {"joint", "petri-look"}:
        raise ValueError("LoadLock manager 只支持 joint 或 petri-look")
    contains_multi_process_route = any(
        sum(
            bool(stage.get("needProcess"))
            for stage in (route.get("stages") or [])
            if isinstance(stage, Mapping)
        ) > 1
        for route in (plan.get("routes") or [])
        if isinstance(route, Mapping)
    )
    build_state = BuildState()
    logs: List[str] = [
        f"设备：{plan.get('deviceName') or 'selected init'}",
        f"策略：{strategy}；总轮数：{round_count}",
    ]
    summaries: List[Dict[str, Any]] = []

    first_update = build_round_update(plan, rounds[0], 0.0, build_state)
    if strategy == "milp":
        wafer_count = sum(
            len(process_job.get("MatList") or [])
            for process_job in (first_update.get("ProcessJobs") or [])
        )
        if wafer_count > MAX_MILP_WAFERS:
            raise ValueError(
                f"MILP 策略总晶圆数量不能超过 {MAX_MILP_WAFERS} 片，当前为 {wafer_count} 片"
            )
    reproduction.add("AlgSchedule", _schedule_log_info(plan["device"], first_update))
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
        )
    round_started = time.perf_counter()
    scheduler = RealtimeRescheduler(
        plan["device"],
        first_update,
        first_update,
        strategy=strategy,
        policy=policy,
        loadlock_manager_mode=loadlock_manager_mode,
        neural_force_quality_floor=contains_multi_process_route,
        rl_search_seconds=_finite_number(options.get("rlSearchSeconds"), 4.0),
        rl_rollouts=max(0, int(_finite_number(options.get("rlRollouts"), 256))),
        rl_temperature=max(0.01, _finite_number(options.get("rlTemperature"), 0.7)),
        milp_time_limit=max(
            0.1,
            _finite_number(options.get("milpTimeLimit"), DEFAULT_MILP_TIME_LIMIT_SECONDS),
        ),
        seed=int(_finite_number(options.get("seed"), 0)),
    )
    elapsed_ms = (time.perf_counter() - round_started) * 1000.0
    first_diagnostics = scheduler.last_strategy_diagnostics
    summaries.append({
        "index": 1,
        "kind": "initial",
        "requestedTime": 0.0,
        "effectiveTime": 0.0,
        "scheduleStartTime": 0.0,
        "recoveryEndTime": 0.0,
        "jobCount": _round_pjob_count(rounds[0]),
        "elapsedMs": elapsed_ms,
        "segmentEnd": _segment_end(scheduler.current_plan),
        "strategyDiagnostics": first_diagnostics,
    })
    logs.append(f"[1/{round_count}] 首次排程完成：{elapsed_ms:.1f} ms，{len(scheduler.current_plan)} Moves")
    if strategy == "milp":
        proof = "已证明最优" if first_diagnostics.get("optimal") else "达到时限，返回当前最优可行解"
        logs.append(
            f"  MILP：{proof}；gap={float(first_diagnostics.get('gap', 0.0)) * 100:.3f}%；"
            f"求解 {float(first_diagnostics.get('runtimeSeconds', 0.0)):.2f}s"
        )
    elif strategy == "neural":
        wavefront_summary = (
            f"；同步波前={int(first_diagnostics.get('wavefrontFamilies') or 0)} 路线族"
            if first_diagnostics.get("inductiveBias")
            == "balanced-disjoint-route-wavefront"
            else ""
        )
        logs.append(
            "  Neural："
            f"{first_diagnostics.get('architecture', 'unknown')}；"
            f"{int(first_diagnostics.get('parameterCount') or 0)} 参数；"
            f"{int(first_diagnostics.get('forwardPasses') or 0)} 次候选集合前向；"
            f"结果来源={first_diagnostics.get('selectedSource', 'unknown')}"
            f"；LoadLock={first_diagnostics.get('loadLockManager', 'joint-network')}"
            f"{wavefront_summary}"
        )
    reproduction.add("AlgOutput", _alg_output_info(scheduler.combined_output()))

    for index, round_config in enumerate(rounds[1:], start=2):
        requested_time = times[index - 1]
        notifications: List[Dict[str, Any]] = []
        recovery = advance_to_recompute(scheduler, requested_time, notifications)
        effective_time = recovery.recovery_end
        released_ids, empty_ports = _release_finished_load_ports(scheduler, build_state)
        for notification in notifications:
            event_time = (
                notification.get("EndTime")
                if notification.get("MoveState") == MoveStateReplay.DONE
                else notification.get("StartTime")
            )
            reproduction.add("AlgUpdateMove", notification, _finite_number(event_time, requested_time))
        reproduction.add("RecomputeControl", {
            "ControlInfo": {"Round": index},
            "RecomputeInfo": {
                "CurrentTime": requested_time,
                "EffectiveTime": effective_time,
                "Reason": f"第 {index} 轮新增 Job",
            },
        }, requested_time)
        update = build_round_update(plan, round_config, requested_time, build_state)
        reproduction.add("AlgSchedule", _schedule_log_info(plan["device"], update), requested_time)
        round_started = time.perf_counter()
        try:
            scheduler.recompute(
                update,
                effective_time,
                cutoff_time=requested_time,
                schedule_start_time=requested_time,
                material_ready_times=recovery.material_ready_times,
                reason=f"第 {index} 轮新增 Job",
            )
        except Exception as error:
            raise RuntimeError(f"第 {index} 轮重算失败：{error}") from error
        elapsed_ms = (time.perf_counter() - round_started) * 1000.0
        summaries.append({
            "index": index,
            "kind": "recompute",
            "requestedTime": requested_time,
            "effectiveTime": effective_time,
            "scheduleStartTime": requested_time,
            "recoveryEndTime": effective_time,
            "jobCount": _round_pjob_count(round_config),
            "elapsedMs": elapsed_ms,
            "segmentEnd": _segment_end(scheduler.current_plan),
            "strategyDiagnostics": scheduler.last_strategy_diagnostics,
        })
        suffix = (
            f"，固定旧动作最晚执行至 {effective_time:.2f}s；新计划从请求时刻并行开始"
            if effective_time > requested_time + TIME_TOLERANCE else ""
        )
        logs.append(
            f"[{index}/{round_count}] @{requested_time:.2f}s 重算完成：{elapsed_ms:.1f} ms，"
            f"新增 {_round_pjob_count(round_config)} PJobs{suffix}"
        )
        if released_ids:
            logs.append(
                f"  已卸载 {len(released_ids)} 片成品；"
                f"清空 LoadPort={','.join(sorted(empty_ports)) or '无'}"
            )
        reproduction.add("AlgOutput", _alg_output_info(scheduler.combined_output()), effective_time)

    output = scheduler.combined_output()
    total_ms = (time.perf_counter() - started) * 1000.0
    makespan = _segment_end(output["MoveList"])
    logs.append(f"完成：总耗时 {total_ms:.1f} ms，makespan={makespan:.2f}s，Move={len(output['MoveList'])}")
    return {
        "ok": True,
        "strategy": strategy,
        "rounds": summaries,
        "totalElapsedMs": total_ms,
        "makespan": makespan,
        "moveCount": len(output["MoveList"]),
        "validation": "passed",
        "logs": logs,
        "output": output,
    }


def execute_plan(raw_plan: Mapping[str, Any]) -> Dict[str, Any]:
    """执行计划；成功和失败都生成可重放的 input_data 格式日志。"""
    reproduction = ReproductionLog()
    reproduction.add("Input", [deepcopy(dict(raw_plan))])
    cpu_started = time.thread_time() if hasattr(time, "thread_time") else time.process_time()
    try:
        result = _execute_plan(raw_plan, reproduction)
    except Exception as error:  # noqa: BLE001
        reproduction.add("AlgOutput", _alg_output_info(feedback=[{
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error),
        }]))
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


def _repair_workspace_route_recipes(routes: Sequence[Any]) -> bool:
    """为旧共享 Route 中加工 Step 的空 Recipe 补稳定名称和已有加工时间。

    早期导入数据可能只在第一道工序保存 ``processRecipe``，后续工序虽然
    ``needProcess=true`` 且已有 ``processTime``，却无法生成 ProcessRecipes。
    """
    changed = False
    for raw_route in routes:
        if not isinstance(raw_route, dict):
            continue
        prefix = str(raw_route.get("group") or raw_route.get("name") or "Route").strip()
        for stage_index, raw_stage in enumerate(raw_route.get("stages") or []):
            if not isinstance(raw_stage, dict) or not bool(
                raw_stage.get("needProcess", raw_stage.get("NeedProcess", False))
            ):
                continue
            step_id = int(_finite_number(
                raw_stage.get("stepId", raw_stage.get("StepID")),
                stage_index,
            ))
            recipe_name = f"{prefix}_Step{step_id}"
            for raw_visit in raw_stage.get("visits") or raw_stage.get("Visits") or []:
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
        if _repair_workspace_route_recipes(routes):
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
    """在调用方持锁时读取并校验设备工作区目录。"""
    source_path = path
    if path == WORKSPACE_STORE_PATH and not path.is_file() and LEGACY_WORKSPACE_STORE_PATH.is_file():
        source_path = LEGACY_WORKSPACE_STORE_PATH
    if not source_path.is_file():
        return _empty_workspace_catalog()
    raw = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping) or not isinstance(raw.get("devices"), list):
        raise ValueError(f"设备测试集存储格式无效：{source_path}")
    catalog = deepcopy(dict(raw))
    changed = _migrate_workspace_catalog(catalog)
    if changed or source_path != path:
        _write_workspace_catalog_unlocked(path, catalog)
    return catalog


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
    """在调用方持锁时以原子替换方式保存设备工作区目录。"""
    _write_json_atomic(path, catalog)
    if path == WORKSPACE_STORE_PATH:
        for device in catalog.get("devices") or []:
            if not isinstance(device, Mapping) or not isinstance(device.get("device"), Mapping):
                continue
            device_id = str(device.get("id") or "").strip()
            if device_id:
                _write_json_atomic(DEVICE_INIT_DIR / f"{device_id}.json", device["device"])


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


def _normalize_workspace_pjob(raw: Mapping[str, Any], index: int, task_id: str) -> Dict[str, Any]:
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
        "loadPort": str(raw.get("loadPort") or raw.get("LoadPort") or ""),
        "priority": max(1, int(_finite_number(raw.get("priority", raw.get("Priority")), 1))),
    }


def _normalize_workspace_round(raw: Mapping[str, Any], index: int, current_time: float) -> Dict[str, Any]:
    """规范化一轮 CJob/PJob；旧版 jobs 合并到该轮唯一默认 CJob。"""
    task_id = str(index)
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
    cjobs: List[Dict[str, Any]] = []
    for cjob_index, row in enumerate(cjob_rows, start=1):
        raw_job_type = row.get("jobType", row.get("JobType", "NormalLot"))
        try:
            job_type_value = _enum_value(raw_job_type, CJOB_TYPE_VALUES, "JobType", "NormalLot")
        except ValueError:
            job_type_value = CJOB_TYPE_VALUES["NormalLot"]
        raw_task_mode = row.get("taskMode", row.get("TaskMode", "Smart"))
        try:
            task_mode_value = _enum_value(raw_task_mode, TASK_MODE_VALUES, "TaskMode", "Smart")
        except ValueError:
            task_mode_value = TASK_MODE_VALUES["Smart"]
        pjob_rows = [item for item in (row.get("pjobs") or []) if isinstance(item, Mapping)] or [{}]
        pjobs = [
            _normalize_workspace_pjob(item, pjob_index, task_id)
            for pjob_index, item in enumerate(pjob_rows, start=1)
        ]
        cjobs.append({
            "taskId": task_id,
            "jobType": CJOB_TYPE_NAMES[job_type_value],
            "priority": max(1, int(_finite_number(row.get("priority", row.get("Priority")), 1))) if job_type_value == 0 else -1,
            "taskMode": TASK_MODE_NAMES[task_mode_value],
            "pJobNameList": [pjob["jobName"] for pjob in pjobs],
            "pjobs": pjobs,
            "key": str(row.get("key") or f"C{cjob_index}"),
        })
    return {"currentTime": 0.0 if index == 1 else float(current_time), "cjobs": cjobs}


def _normalize_test_case(raw_test: Mapping[str, Any], test_id: Optional[str] = None) -> Dict[str, Any]:
    """保存只含排程任务的测试集结构，并兼容迁移旧版扁平 Job。"""
    timestamp = _workspace_timestamp()
    raw_rounds = [row for row in (raw_test.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = max(1, int(_finite_number(raw_test.get("roundCount"), len(raw_rounds) or 1)))
    times = deepcopy(list(raw_test.get("times") or [0.0]))
    while len(raw_rounds) < round_count:
        raw_rounds.append({})
    while len(times) < round_count:
        times.append((float(times[-1]) if times else 0.0) + 70.0)
    rounds = [
        _normalize_workspace_round(
            raw_rounds[index], index + 1,
            _finite_number(raw_rounds[index].get("currentTime"), _finite_number(times[index], 0.0)),
        )
        for index in range(round_count)
    ]
    next_material_id = 1
    for round_row in rounds:
        for cjob in round_row["cjobs"]:
            for pjob in cjob["pjobs"]:
                wafer_count = int(pjob["waferCount"])
                pjob["matList"] = list(range(next_material_id, next_material_id + wafer_count))
                next_material_id += wafer_count
    times = [round_row["currentTime"] for round_row in rounds]
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
        "options": deepcopy(dict(raw_test.get("options") or {})),
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
        device["routes"] = deepcopy(payload["routes"])
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
        test_case = _normalize_test_case(normalized_input)
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
        test_case = _normalize_test_case(merged, test_id)
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
        _write_workspace_catalog_unlocked(path, catalog)


def save_result(output: Dict[str, Any]) -> str:
    """把甘特图数据写入专用导出目录并放入有界内存缓存。"""
    result_id = uuid.uuid4().hex
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


def _log_response_fields(log_id: str) -> Dict[str, str]:
    """生成前端下载日志所需的稳定地址与文件名。"""
    filename = f"ct-input-log-{log_id[:8]}.json"
    return {"logUrl": f"/api/logs/{log_id}", "logFileName": filename}


def _batch_test_routes(
    routes: Sequence[Mapping[str, Any]],
    rounds: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """只保留测试各轮 PJob 实际引用的共享 Route。"""
    referenced = {
        str(pjob.get("routeRef") or "").strip()
        for round_row in rounds
        for cjob in _round_cjob_rows(round_row)
        for pjob in (cjob.get("pjobs") or [])
        if isinstance(pjob, Mapping)
    }
    return [
        deepcopy(dict(route))
        for route in routes
        if str(route.get("name") or "").strip() in referenced
    ]


def _batch_test_cleans(
    cleans: Sequence[Mapping[str, Any]],
    routes: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """只保留当前测试 Route 实际引用的设备级 Clean 模板。"""
    referenced: set[str] = set()
    for route in routes:
        for field_name in (
            "prePJobCleanRefs",
            "postPJobCleanRefs",
            "postCJobCleanRefs",
        ):
            referenced.update(_string_list(route.get(field_name)))
        for stage in route.get("stages") or []:
            if not isinstance(stage, Mapping):
                continue
            for visit in _stage_visit_rows(stage):
                referenced.update(_string_list(
                    visit.get("beforeCleanRefs") or visit.get("BeforeInPM")
                ))
                referenced.update(_string_list(
                    visit.get("afterCleanRefs") or visit.get("AfterOutPM")
                ))
    return [
        deepcopy(dict(clean))
        for clean in cleans
        if str(clean.get("name") or "").strip() in referenced
    ]


def _batch_test_recipes(
    routes: Sequence[Mapping[str, Any]],
    cleans: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """从共享 Route/Clean 派生与前端单次运行一致的 Recipe 列表。"""
    recipes: Dict[str, Dict[str, Any]] = {}

    def add(
        name: Any,
        duration: Any,
        modules: Any,
        process_type: Any = "",
        weight: Any = None,
    ) -> None:
        recipe_name = str(name or "").strip()
        if not recipe_name:
            return
        module_names = _string_list(modules)
        existing = recipes.get(recipe_name)
        if existing is None:
            recipes[recipe_name] = {
                "name": recipe_name,
                "time": _finite_number(duration, 0.0),
                "modules": module_names,
                "processType": str(process_type or ""),
                "weight": deepcopy(weight if weight is not None else {}),
            }
            return
        existing["modules"] = list(dict.fromkeys([*existing["modules"], *module_names]))

    for route in routes:
        for stage in route.get("stages") or []:
            if not isinstance(stage, Mapping):
                continue
            for visit in _stage_visit_rows(stage):
                add(
                    visit.get("processRecipe") or visit.get("ProcessRecipe"),
                    visit.get("processTime", visit.get("recipeTime", 0.0)),
                    [visit.get("stationName") or visit.get("StationName")],
                    visit.get("processType"),
                    visit.get("weight") or {},
                )
    for clean in cleans:
        add(
            clean.get("recipeName") or clean.get("recipeRef"),
            clean.get("recipeTime"),
            clean.get("modules"),
        )
    return list(recipes.values())


def build_workspace_batch_plan(
    device: Mapping[str, Any],
    test_case: Mapping[str, Any],
    strategy: str,
    options: Mapping[str, Any],
) -> Dict[str, Any]:
    """将持久化测试与设备共享库组合成可直接执行的单次请求。"""
    rounds = [
        deepcopy(dict(row))
        for row in (test_case.get("rounds") or [])
        if isinstance(row, Mapping)
    ]
    routes = _batch_test_routes(
        [row for row in (device.get("routes") or []) if isinstance(row, Mapping)],
        rounds,
    )
    cleans = _batch_test_cleans(
        [row for row in (device.get("cleans") or []) if isinstance(row, Mapping)],
        routes,
    )
    merged_options = deepcopy(dict(test_case.get("options") or {}))
    merged_options.update(deepcopy(dict(options)))
    return {
        "schemaVersion": API_SCHEMA_VERSION,
        "deviceName": str(device.get("name") or "selected init"),
        "device": deepcopy(device.get("device")),
        "strategy": str(strategy or "heuristic"),
        "roundCount": len(rounds),
        "options": merged_options,
        "recipes": _batch_test_recipes(routes, cleans),
        "cleans": cleans,
        "routes": routes,
        "rounds": rounds,
    }


def _workspace_baseline_fingerprint(
    device: Mapping[str, Any],
    test_case: Mapping[str, Any],
    options: Optional[Mapping[str, Any]] = None,
) -> str:
    """对实际 Heuristic 输入做稳定摘要，绑定测试及其引用的共享工艺配置。"""
    plan = build_workspace_batch_plan(
        device,
        test_case,
        "heuristic",
        options if options is not None else dict(test_case.get("options") or {}),
    )
    canonical = json.dumps(
        {
            "baselineSchema": HEURISTIC_BASELINE_SCHEMA_VERSION,
            "plan": plan,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _invalidate_stale_device_baselines(device: Dict[str, Any]) -> None:
    """设备共享配置或测试内容变化后，使不匹配的 Baseline 立即失效。"""
    for test_case in device.get("tests") or []:
        baseline = test_case.get("baseline")
        if not isinstance(baseline, Mapping):
            continue
        fingerprint = _workspace_baseline_fingerprint(device, test_case)
        if str(baseline.get("fingerprint") or "") == fingerprint:
            continue
        test_case["baseline"] = {
            "status": "invalid",
            "fingerprint": fingerprint,
            "error": "测试配置已修改，等待重新计算 Heuristic Baseline",
            "updatedAt": _workspace_timestamp(),
        }


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


def _successful_baseline(
    fingerprint: str,
    result: Mapping[str, Any],
) -> Dict[str, Any]:
    return {
        "status": "succeeded",
        "fingerprint": fingerprint,
        "makespan": float(result["makespan"]),
        "cpuTimeMs": float(result.get("cpuTimeMs", result.get("totalElapsedMs", 0.0))),
        "updatedAt": _workspace_timestamp(),
    }


def _failed_baseline(fingerprint: str, error: BaseException) -> Dict[str, Any]:
    return {
        "status": "failed",
        "fingerprint": fingerprint,
        "error": str(error) or type(error).__name__,
        "updatedAt": _workspace_timestamp(),
    }


def _baseline_comparison(
    result: Mapping[str, Any],
    baseline: Mapping[str, Any],
) -> Dict[str, Any]:
    """为前端生成当前值、Baseline 和改善比例。"""
    fields = {"baseline": deepcopy(dict(baseline))}
    if baseline.get("status") != "succeeded":
        return fields
    current_makespan = float(result["makespan"])
    baseline_makespan = float(baseline["makespan"])
    current_cpu = float(result.get("cpuTimeMs", result.get("totalElapsedMs", 0.0)))
    baseline_cpu = float(baseline["cpuTimeMs"])
    fields.update({
        "cpuTimeMs": current_cpu,
        "makespanDelta": current_makespan - baseline_makespan,
        "cpuTimeDeltaMs": current_cpu - baseline_cpu,
        "improvementPercent": (
            (baseline_makespan - current_makespan) / baseline_makespan * 100.0
            if abs(baseline_makespan) > 1e-12 else 0.0
        ),
    })
    return fields


def _execute_workspace_test_with_baseline(
    device: Mapping[str, Any],
    test_case: Mapping[str, Any],
    strategy: str,
    options: Mapping[str, Any],
    *,
    selected_plan: Optional[Mapping[str, Any]] = None,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any], Optional[Exception]]:
    """确保 Baseline 有效并执行所选策略；Baseline 失败不复用旧值。"""
    fingerprint = _workspace_baseline_fingerprint(device, test_case, options)
    existing = test_case.get("baseline")
    baseline = (
        deepcopy(dict(existing))
        if isinstance(existing, Mapping)
        and existing.get("status") == "succeeded"
        and str(existing.get("fingerprint") or "") == fingerprint
        else None
    )
    device_id = str(device.get("id") or "")
    test_id = str(test_case.get("id") or "")

    def record(value: Mapping[str, Any]) -> Dict[str, Any]:
        stored = deepcopy(dict(value))
        if isinstance(test_case, dict):
            test_case["baseline"] = deepcopy(stored)
        _persist_workspace_baseline(device_id, test_id, stored)
        return stored

    if strategy == "heuristic":
        plan = dict(selected_plan) if selected_plan is not None else build_workspace_batch_plan(
            device, test_case, "heuristic", options,
        )
        try:
            result = execute_plan(plan)
        except Exception as error:  # noqa: BLE001
            return None, record(_failed_baseline(fingerprint, error)), error
        baseline = record(_successful_baseline(fingerprint, result))
        return result, baseline, None

    if baseline is None:
        try:
            baseline_result = execute_plan(build_workspace_batch_plan(
                device, test_case, "heuristic", options,
            ))
            baseline = record(_successful_baseline(fingerprint, baseline_result))
        except Exception as error:  # noqa: BLE001
            baseline = record(_failed_baseline(fingerprint, error))

    plan = dict(selected_plan) if selected_plan is not None else build_workspace_batch_plan(
        device, test_case, strategy, options,
    )
    try:
        return execute_plan(plan), baseline, None
    except Exception as error:  # noqa: BLE001
        return None, baseline, error


def _workspace_group_tests(
    device: Mapping[str, Any],
    group: str,
) -> Tuple[str, List[Mapping[str, Any]]]:
    """返回规范化组名及该组按工作区顺序排列的测试。"""
    normalized_group = str(group or "").strip()
    tests = [
        row for row in (device.get("tests") or [])
        if isinstance(row, Mapping)
        and str(row.get("group") or "").strip() == normalized_group
    ]
    if not tests:
        raise ValueError(f"当前测试组“{normalized_group or '未分组'}”没有可运行测试")
    return normalized_group, tests


def _execute_workspace_test_batch(
    device: Mapping[str, Any],
    tests: Sequence[Mapping[str, Any]],
    group: str,
    strategy: str,
    options: Mapping[str, Any],
    *,
    maximum_workers: int = 4,
    progress_callback: Optional[Any] = None,
    cancel_event: Optional[threading.Event] = None,
) -> Dict[str, Any]:
    """执行已解析的批量测试，并通过回调报告每项状态变化。"""
    worker_count = max(1, min(int(maximum_workers), 4, len(tests)))
    started = time.perf_counter()

    def run_one(index: int, test_case: Mapping[str, Any]) -> Dict[str, Any]:
        if cancel_event is not None and cancel_event.is_set():
            return {
                "index": index,
                "ok": False,
                "status": "cancelled",
                "testId": str(test_case.get("id") or ""),
                "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                "error": "用户终止调度",
            }
        if progress_callback is not None:
            progress_callback(index, {"status": "running", "startedAt": _workspace_timestamp()})
        try:
            result, baseline, run_error = _execute_workspace_test_with_baseline(
                device, test_case, strategy, options,
            )
            if run_error is not None or result is None:
                error = run_error or RuntimeError("运行未返回结果")
                failure = {
                    "index": index,
                    "ok": False,
                    "status": "failed",
                    "testId": str(test_case.get("id") or ""),
                    "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                    "error": str(error) or type(error).__name__,
                    "baseline": deepcopy(baseline),
                }
                if isinstance(error, LoggedPlanError):
                    log_id = save_reproduction_log(error.reproduction_log)
                    failure.update(_log_response_fields(log_id))
                return failure
            if cancel_event is not None and cancel_event.is_set():
                return {
                    "index": index,
                    "ok": False,
                    "status": "cancelled",
                    "testId": str(test_case.get("id") or ""),
                    "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                    "error": "用户终止调度",
                }
            result_id = save_result(result["output"])
            log_id = save_reproduction_log(result["reproductionLog"])
            return {
                "index": index,
                "ok": True,
                "status": "succeeded",
                "testId": str(test_case.get("id") or ""),
                "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                "totalElapsedMs": result["totalElapsedMs"],
                "cpuTimeMs": result.get("cpuTimeMs", result["totalElapsedMs"]),
                "makespan": result["makespan"],
                "moveCount": result["moveCount"],
                "validation": result["validation"],
                "resultUrl": f"/api/results/{result_id}",
                "ganttUrl": f"/movelist_gantt_viewer.html?src=/api/results/{result_id}",
                **_log_response_fields(log_id),
                **_baseline_comparison(result, baseline),
            }
        except Exception as error:  # noqa: BLE001
            return {
                "index": index,
                "ok": False,
                "status": "failed",
                "testId": str(test_case.get("id") or ""),
                "testName": str(test_case.get("name") or f"测试 {index + 1}"),
                "error": str(error) or type(error).__name__,
            }

    items: List[Dict[str, Any]] = []
    executor = ThreadPoolExecutor(max_workers=worker_count)
    futures = {
        executor.submit(run_one, index, test_case): index
        for index, test_case in enumerate(tests)
    }
    pending = set(futures)
    cancelled = False
    try:
        while pending:
            if cancel_event is not None and cancel_event.is_set():
                cancelled = True
                break
            done, pending = wait(pending, timeout=0.1, return_when=FIRST_COMPLETED)
            for future in done:
                item = future.result()
                items.append(item)
                if progress_callback is not None:
                    progress_callback(int(item["index"]), item)
    finally:
        if cancelled:
            for future in pending:
                future.cancel()
            executor.shutdown(wait=False, cancel_futures=True)
        else:
            executor.shutdown(wait=True)
    items.sort(key=lambda item: int(item["index"]))
    succeeded = sum(bool(item["ok"]) for item in items)
    return {
        "ok": not cancelled and succeeded == len(items),
        "strategy": strategy,
        "group": group,
        "status": "cancelled" if cancelled else "completed",
        "completed": len(items),
        "testCount": len(items),
        "succeeded": succeeded,
        "failed": len(items) - succeeded,
        "cancelled": len(tests) - len(items) if cancelled else 0,
        "workerCount": worker_count,
        "totalElapsedMs": (time.perf_counter() - started) * 1000.0,
        "items": items,
    }


def run_workspace_test_batch(
    device_id: str,
    group: str,
    strategy: str,
    options: Mapping[str, Any],
    *,
    maximum_workers: int = 4,
) -> Dict[str, Any]:
    """同步运行当前测试组；保留给测试和非 HTTP 调用方。"""
    device = get_workspace_device(device_id)
    normalized_group, tests = _workspace_group_tests(device, group)
    return _execute_workspace_test_batch(
        device,
        tests,
        normalized_group,
        strategy,
        options,
        maximum_workers=maximum_workers,
    )


def read_workspace_batch_run(batch_id: str) -> Optional[Dict[str, Any]]:
    """读取后台批量任务的当前快照。"""
    with _BATCH_RUNS_LOCK:
        batch = _BATCH_RUNS.get(batch_id)
        return deepcopy(batch) if batch is not None else None


def cancel_workspace_batch_run(batch_id: str) -> Optional[Dict[str, Any]]:
    """终止批量任务；排队和运行项立即进入终止状态。"""
    with _BATCH_RUNS_LOCK:
        batch = _BATCH_RUNS.get(batch_id)
        if batch is None:
            return None
        if batch.get("status") in {"completed", "failed", "cancelled"}:
            return deepcopy(batch)
        cancel_event = _BATCH_CANCEL_EVENTS.get(batch_id)
        if cancel_event is not None:
            cancel_event.set()
        for item in batch.get("items") or []:
            if item.get("status") in {"queued", "running"}:
                item.update({
                    "ok": False,
                    "status": "cancelled",
                    "error": "用户终止调度",
                })
        batch["ok"] = False
        batch["status"] = "cancelled"
        batch["completed"] = len(batch.get("items") or [])
        batch["succeeded"] = sum(item.get("status") == "succeeded" for item in batch.get("items") or [])
        batch["failed"] = sum(item.get("status") == "failed" for item in batch.get("items") or [])
        batch["cancelled"] = sum(item.get("status") == "cancelled" for item in batch.get("items") or [])
        batch["finishedAt"] = _workspace_timestamp()
        return deepcopy(batch)


def start_workspace_test_batch(
    device_id: str,
    group: str,
    strategy: str,
    options: Mapping[str, Any],
    *,
    maximum_workers: int = 4,
) -> Dict[str, Any]:
    """创建后台批量任务并立即返回可轮询的初始状态。"""
    device = get_workspace_device(device_id)
    normalized_group, tests = _workspace_group_tests(device, group)
    batch_id = uuid.uuid4().hex
    worker_count = max(1, min(int(maximum_workers), 4, len(tests)))
    initial = {
        "batchId": batch_id,
        "ok": True,
        "status": "queued",
        "strategy": strategy,
        "group": normalized_group,
        "testCount": len(tests),
        "completed": 0,
        "succeeded": 0,
        "failed": 0,
        "cancelled": 0,
        "workerCount": worker_count,
        "totalElapsedMs": 0.0,
        "createdAt": _workspace_timestamp(),
        "items": [{
            "index": index,
            "ok": None,
            "status": "queued",
            "testId": str(test_case.get("id") or ""),
            "testName": str(test_case.get("name") or f"测试 {index + 1}"),
        } for index, test_case in enumerate(tests)],
    }
    cancel_event = threading.Event()
    with _BATCH_RUNS_LOCK:
        _BATCH_RUNS[batch_id] = initial
        _BATCH_CANCEL_EVENTS[batch_id] = cancel_event
        _BATCH_RUNS.move_to_end(batch_id)
        while len(_BATCH_RUNS) > MAX_SAVED_BATCH_RUNS:
            expired_id, _ = _BATCH_RUNS.popitem(last=False)
            _BATCH_CANCEL_EVENTS.pop(expired_id, None)

    def update_item(index: int, values: Mapping[str, Any]) -> None:
        with _BATCH_RUNS_LOCK:
            batch = _BATCH_RUNS.get(batch_id)
            if batch is None or cancel_event.is_set() or batch.get("status") == "cancelled":
                return
            batch["status"] = "running"
            batch["items"][index].update(deepcopy(dict(values)))
            batch["completed"] = sum(
                item.get("status") in {"succeeded", "failed"}
                for item in batch["items"]
            )
            batch["succeeded"] = sum(item.get("status") == "succeeded" for item in batch["items"])
            batch["failed"] = sum(item.get("status") == "failed" for item in batch["items"])

    def background() -> None:
        try:
            result = _execute_workspace_test_batch(
                device,
                tests,
                normalized_group,
                strategy,
                options,
                maximum_workers=worker_count,
                progress_callback=update_item,
                cancel_event=cancel_event,
            )
            with _BATCH_RUNS_LOCK:
                batch = _BATCH_RUNS.get(batch_id)
                if batch is not None and not cancel_event.is_set() and batch.get("status") != "cancelled":
                    batch.update(result)
                    batch["batchId"] = batch_id
                    batch["finishedAt"] = _workspace_timestamp()
        except Exception as error:  # noqa: BLE001
            with _BATCH_RUNS_LOCK:
                batch = _BATCH_RUNS.get(batch_id)
                if batch is not None and not cancel_event.is_set() and batch.get("status") != "cancelled":
                    batch["ok"] = False
                    batch["status"] = "failed"
                    batch["error"] = str(error) or type(error).__name__
                    batch["finishedAt"] = _workspace_timestamp()

    threading.Thread(
        target=background,
        name=f"batch-run-{batch_id[:8]}",
        daemon=True,
    ).start()
    return deepcopy(initial)


class ConfigEditorHandler(BaseHTTPRequestHandler):
    """暴露调度控制台、设备测试集、甘特图和运行 API 的本地 HTTP 处理器。"""

    server_version = "CTConfigEditor/1.0"

    def do_GET(self) -> None:
        """处理页面、健康检查和内存结果读取。"""
        path = unquote(urlparse(self.path).path)
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
            l2d_model_path = _resolve_l2d_model_path()
            other_algorithms = discover_other_algorithms()
            self._send_json({
                "ok": True,
                "service": "ct-config-editor",
                "schemaVersion": API_SCHEMA_VERSION,
                "strategies": {
                    "heuristic": True,
                    "neural": NEURAL_MODEL_PATH.is_file(),
                    "rl": RL_MODEL_PATH.is_file(),
                    "l2d": l2d_model_path is not None,
                    "milp": True,
                },
                "strategyModels": {
                    "neural": str(NEURAL_MODEL_PATH) if NEURAL_MODEL_PATH.is_file() else "",
                    "l2d": str(l2d_model_path) if l2d_model_path is not None else "",
                },
                "strategyErrors": {},
                "otherAlgorithms": other_algorithms,
            })
            return
        if path == "/api/workspaces":
            try:
                self._send_json({"ok": True, "devices": list_workspace_devices()})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path.startswith("/api/workspaces/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) == 3:
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
        if path == "/api/models/l2d":
            try:
                payload = self._read_json_object()
                model = import_l2d_checkpoint(str(payload.get("data") or ""))
                self._send_json({"ok": True, "model": model}, HTTPStatus.CREATED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/run-batch":
            try:
                payload = self._read_json_object()
                options = payload.get("options")
                if not isinstance(options, Mapping):
                    options = {}
                result = start_workspace_test_batch(
                    str(payload.get("deviceId") or ""),
                    str(payload.get("group") or ""),
                    str(payload.get("strategy") or "heuristic"),
                    options,
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
        baseline_response: Optional[Dict[str, Any]] = None
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("请求为空或超过大小限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("请求体必须是 JSON 对象")
            workspace_device_id = str(payload.get("workspaceDeviceId") or "")
            workspace_test_id = str(payload.get("workspaceTestId") or "")
            if workspace_device_id and workspace_test_id:
                device = get_workspace_device(workspace_device_id)
                test_case = next((
                    item for item in (device.get("tests") or [])
                    if str(item.get("id") or "") == workspace_test_id
                ), None)
                if test_case is None:
                    raise ValueError(f"测试集不存在：{workspace_test_id}")
                result, baseline, run_error = _execute_workspace_test_with_baseline(
                    device,
                    test_case,
                    str(payload.get("strategy") or "heuristic"),
                    dict(payload.get("options") or {}),
                    selected_plan=payload,
                )
                baseline_response = deepcopy(baseline)
                if run_error is not None or result is None:
                    raise run_error or RuntimeError("运行未返回结果")
                result.update(_baseline_comparison(result, baseline))
            else:
                result = execute_plan(payload)
            result_id = save_result(result["output"])
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
            response = {"ok": False, "error": str(error) or type(error).__name__}
            if baseline_response is not None:
                response["baseline"] = baseline_response
            response.update(_log_response_fields(log_id))
            self._send_json(response, HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:
        """保存测试集或重命名设备下的测试组别。"""
        path = unquote(urlparse(self.path).path)
        parts = [part for part in path.split("/") if part]
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
        """删除设备下指定测试集或测试组，并返回剩余数据。"""
        path = unquote(urlparse(self.path).path)
        if path.startswith("/api/run-batches/"):
            batch = cancel_workspace_batch_run(path.rsplit("/", 1)[-1])
            if batch is None:
                self._send_json({"ok": False, "error": "批量任务不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(batch)
            return
        parts = [part for part in path.split("/") if part]
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


def main() -> None:
    """启动仅监听本机的多线程调度控制台服务。"""
    parser = argparse.ArgumentParser(description="CT 调度控制台本地服务")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认仅本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口")
    parser.add_argument("--open", action="store_true", help="启动后打开默认浏览器")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), ConfigEditorHandler)
    url = f"http://{args.host}:{args.port}/"
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
