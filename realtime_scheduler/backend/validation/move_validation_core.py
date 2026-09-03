"""平台侧 MoveList 物理状态记录与校验。

本模块属于调度平台，独立实现物理状态记录与校验，不依赖算法仓库的调度核心。它只检查设备在物理上
能否执行动作：门、压力、资源占用、槽位容量和物料位置必须一致；算法策略偏好不在
此处生效。尤其是多槽腔室、LoadLock 和机器人允许在容量范围内同时携带、加工或切换
环境中的多片晶圆。
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from enum import Enum
import math
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple


TIME_TOLERANCE = 1e-6
DEFAULT_SLOT_ID = 1
PICK_MOVE = 0
MULTI_PICK_MOVE = 2
PLACE_MOVE = 1
SWAP_MOVE = 4
PRE_TRANS_MOVE = 5
PREPARE_MOVE = 6
COMPLETE_MOVE = 7
PROCESS_MOVE = 9
PRE_PREPARE_MOVE = 10
ALIGN_MOVE = 11
ATMOSPHERE = "ATM"
VACUUM = "VAC"
LOAD_LOCK_TYPE = "loadlock"
LOAD_PORT_TYPE = "loadport"
DUMMY_PORT_TYPE = "dummyport"
BUFFER_TYPE = "buffer"
COMPLETED_ON_PLACE_STATION_TYPES = frozenset({
    LOAD_PORT_TYPE,
    DUMMY_PORT_TYPE,
    BUFFER_TYPE,
})
DOORLESS_STATION_NAMES = frozenset({"Cooler", "Cool"})
TWIN_LOAD_LOCK_PAIRS = frozenset({
    frozenset({"LA", "LB"}),
    frozenset({"LC", "LD"}),
})
# 运行设置和标准 Clean 定义共用的稳定类型。所有类型默认检查触发策略；调用者
# 只能显式跳过某一类的触发时机与次数义务，动作合法性和状态推进始终生效。
CLEAN_VALIDATION_TYPES = frozenset({
    "preclean", "postclean", "wacclean", "dummy", "dummywac",
})


class ValidationErrorCode(str, Enum):
    """MoveList 输出校验的稳定错误码。"""

    MOVE_ITEM_INVALID = "MVL-FMT-001"
    MOVE_ID_INVALID = "MVL-FMT-002"
    MOVE_ID_DUPLICATE = "MVL-FMT-003"
    MOVE_FIELD_INVALID = "MVL-FMT-004"
    PREDECESSOR_FORMAT_INVALID = "MVL-DEP-001"
    PREDECESSOR_VALUE_INVALID = "MVL-DEP-002"
    PREDECESSOR_SELF_REFERENCE = "MVL-DEP-003"
    PREDECESSOR_MISSING = "MVL-DEP-004"
    PREDECESSOR_TIME_CONFLICT = "MVL-DEP-005"
    DEPENDENCY_CYCLE = "MVL-DEP-006"
    TIME_INVALID = "MVL-TIME-001"
    TIME_REVERSED = "MVL-TIME-002"
    TIMING_CONFIG_MISSING = "MVL-TIME-003"
    TIMING_CONFIG_INVALID = "MVL-TIME-004"
    DURATION_MISMATCH = "MVL-TIME-005"
    POST_PROCESS_PICK_MISSING = "MVL-ROUTE-001"
    RESIDENCY_EXCEEDED = "MVL-ROUTE-002"
    QTIME_EXCEEDED = "MVL-ROUTE-003"
    INITIAL_MATERIAL_CONFLICT = "MVL-STATE-001"
    MOVE_TYPE_UNSUPPORTED = "MVL-MOVE-001"
    PARALLEL_ARRAY_INVALID = "MVL-MOVE-002"
    DUPLICATE_RESOURCE_REFERENCE = "MVL-MOVE-003"
    ROBOT_UNKNOWN = "MVL-RES-001"
    STATION_UNKNOWN = "MVL-RES-002"
    STATION_SLOT_UNKNOWN = "MVL-RES-003"
    ROBOT_BUSY = "MVL-ROBOT-001"
    ROBOT_SLOT_DISABLED = "MVL-ROBOT-002"
    ROBOT_HAND_STATE_INVALID = "MVL-ROBOT-003"
    ROBOT_SWAP_UNSUPPORTED = "MVL-ROBOT-004"
    ROBOT_UNREACHABLE = "MVL-ROBOT-005"
    ROBOT_ALIGNMENT_INVALID = "MVL-ROBOT-006"
    STATION_DOOR_STATE_INVALID = "MVL-STATION-001"
    STATION_TRANSFER_BUSY = "MVL-STATION-002"
    STATION_ENVIRONMENT_BUSY = "MVL-STATION-003"
    STATION_PROCESS_BUSY = "MVL-STATION-004"
    STATION_SLOT_BUSY = "MVL-STATION-005"
    PICK_SOURCE_INVALID = "MVL-PICK-001"
    PLACE_TARGET_INVALID = "MVL-PLACE-001"
    PRETRANS_STATE_INVALID = "MVL-PRETRANS-001"
    PROCESS_STATE_INVALID = "MVL-PROCESS-001"
    LOADLOCK_REQUIRED = "MVL-LL-001"
    LOADLOCK_ENVIRONMENT_INVALID = "MVL-LL-002"
    LOADLOCK_CONTENT_INVALID = "MVL-LL-003"
    SWAP_INPUT_INVALID = "MVL-SWAP-001"
    SWAP_STATE_INVALID = "MVL-SWAP-002"
    CLEAN_WAC_MISSING = "MVL-CLEAN-WAC-MISSING"
    CLEAN_WAC_EARLY = "MVL-CLEAN-WAC-EARLY"
    CLEAN_PRE_MISSING = "MVL-CLEAN-PRE-MISSING"
    CLEAN_DUMMY_MISSING = "MVL-CLEAN-DUMMY-MISSING"
    CLEAN_POST_MISSING = "MVL-CLEAN-POST-MISSING"
    CLEAN_RECIPE_INVALID = "MVL-CLEAN-RECIPE-INVALID"


class DoorState(str, Enum):
    """设备门的稳定开闭状态。"""

    CLOSED = "closed"
    OPEN = "open"


class SlotPhase(str, Enum):
    """槽位中物料在稳定时刻的加工状态。"""

    EMPTY = "empty"
    CLEANED = "cleaned"
    UNPROCESSED = "unprocessed"
    COMPLETED = "completed"


@dataclass
class MaterialState:
    """记录物料标识及其当前 PJob/Step 元数据。"""

    material_id: Any
    pjob_name: str = ""
    step_id: Any = None


@dataclass
class SlotState:
    """记录一个物理槽位的物料、占用窗口及累计加工次数。"""

    phase: SlotPhase = SlotPhase.EMPTY
    material: Optional[MaterialState] = None
    busy_until: float = 0.0
    busy_action: str = ""
    material_process_count: int = 0


@dataclass
class StationState:
    """记录腔室的门、槽位及共享取放资源。"""

    name: str
    station_type: str
    slots: Dict[int, SlotState] = field(default_factory=dict)
    door: DoorState = DoorState.CLOSED
    door_busy_until: float = 0.0
    transfer_busy_until: float = 0.0
    environment_busy_until: float = 0.0
    state_variables: Dict[str, float] = field(default_factory=dict)

    @property
    def is_load_lock(self) -> bool:
        """返回站点是否为 LoadLock。"""
        return self.station_type.lower() == LOAD_LOCK_TYPE

    @property
    def completes_material_on_place(self) -> bool:
        """返回物料放入后无需额外服务即可再次取出的库存或 Buffer 站点。"""
        return self.station_type.lower() in COMPLETED_ON_PLACE_STATION_TYPES


@dataclass
class LoadLockState(StationState):
    """记录 LoadLock 的压力态和设备标签映射。"""

    environment: str = ATMOSPHERE
    last_environment_transition_was_empty: bool = False
    environment_aliases: Dict[str, str] = field(default_factory=dict)
    #: ``PrePrepareTime`` 声明的合法状态标签集合（归一化大写）；空集表示未声明，退回宽松解析。
    environment_state_space: frozenset[str] = frozenset()
    #: 是否已行使“首条环境不匹配切换”豁免：外部算法的首条环境切换其 LastState
    #: 可与其初始压力态不符（如初始大气却先发 VentTime，或级联 LL 从 ATR_1 起始），
    #: 豁免放行并照常执行、落地到 CurState；后续违例照常报错。
    environment_exemption_used: bool = False


@dataclass
class RobotState:
    """记录机器人全部手槽、可达范围、指向与占用窗口。

    ``position`` 是站级兼容字段（外部 API/快照回写仍消费）；槽位级拓扑启用后
    各手槽的精确指向与候选集才是权威状态：双臂设备的一个臂可横跨两个站
    （如 ``SlotsStationMap`` 的 ``LALB`` 站组：槽位 1 伸 LA、槽位 2 伸 LB）。
    """

    name: str
    hands: Dict[int, Optional[MaterialState]] = field(default_factory=dict)
    scope: Set[str] = field(default_factory=set)
    position: Optional[str] = None
    #: 手槽当前精确指向的站槽位 ``(站名, 站槽位号)``；未对准时为 None。
    slot_targets: Dict[int, Optional[Tuple[str, int]]] = field(default_factory=dict)
    #: 手槽在当前站组下可对准的站槽位候选集；机器人配置了 ``SlotsStationMap``
    #: 时按候选集校验取放，空集表示该手槽当前够不到任何槽位。
    slot_options: Dict[int, Set[Tuple[str, int]]] = field(default_factory=dict)
    #: 静态拓扑：手槽 → 站组名 → 该站组下可对准的站槽位候选集（来自 ArmInfo.SlotsStationMap）。
    slot_map: Dict[int, Dict[str, Set[Tuple[str, int]]]] = field(default_factory=dict)
    #: 静态拓扑：Arm 名 → 该 Arm 的物理手槽（用于按臂回写 SlotAtStation）。
    arm_slots: Dict[str, Set[int]] = field(default_factory=dict)
    busy_until: float = 0.0
    can_swap: bool = False

    def swap_slot_error(self, receive_slot: int, send_slot: int) -> Optional[str]:
        """校验原子换片使用的两个机器人手槽。"""
        if not self.can_swap or len(self.hands) < 2:
            return _global_issue(ValidationErrorCode.ROBOT_SWAP_UNSUPPORTED, f"{self.name} 不支持双臂换片")
        if receive_slot == send_slot:
            return _global_issue(ValidationErrorCode.SWAP_INPUT_INVALID, f"{self.name} 换片的接收手槽和发送手槽必须不同")
        if receive_slot not in self.hands:
            return _global_issue(ValidationErrorCode.ROBOT_SLOT_DISABLED, f"{self.name} 未启用手槽 {receive_slot}")
        if send_slot not in self.hands:
            return _global_issue(ValidationErrorCode.ROBOT_SLOT_DISABLED, f"{self.name} 未启用手槽 {send_slot}")
        return None


@dataclass
class MachineState:
    """平台回放期间的独立整机物理快照。"""

    stations: Dict[str, StationState] = field(default_factory=dict)
    robots: Dict[str, RobotState] = field(default_factory=dict)
    robot_aliases: Dict[str, str] = field(default_factory=dict)
    process_recipe_weights: Dict[Tuple[str, str], Dict[str, float]] = field(default_factory=dict)
    clean_task_state_variables: Dict[str, Set[str]] = field(default_factory=dict)
    clean_wac_trigger_rules: Dict[Tuple[str, str], Tuple[Tuple[str, str, float, str], ...]] = field(default_factory=dict)
    clean_obligations: Dict[Tuple[str, str, str], Tuple[str, int, Tuple[str, ...]]] = field(default_factory=dict)
    #: 本次运行跳过的 Clean 触发/次数规则；物理状态回放与计数仍照常执行。
    skipped_clean_validation_types: Set[str] = field(default_factory=set)
    completed_clean_counts: Dict[Tuple[str, str, str], int] = field(default_factory=dict)
    product_clean_entries: Set[Tuple[str, str]] = field(default_factory=set)
    #: 外部算法可省略的零时长产品 ProcessMove；键为（物料、Route Step、PM）。
    zero_duration_process_steps: Set[Tuple[str, str, str]] = field(default_factory=set)

    @classmethod
    def from_sources(
        cls,
        task: Any,
        init_data: "Optional[Mapping[str, Any] | MachineState]",
    ) -> "MachineState":
        """合并标准 update 与解析任务，构造容量感知的初始快照。"""
        if isinstance(init_data, cls):
            return init_data.clone()
        payload = _initial_payload(init_data)
        state = cls()
        station_configs = _mapping(payload.get("Stations"))
        robot_configs = _mapping(payload.get("Robots"))
        task_stations = getattr(task, "chambers", {}) or {}
        task_robots = getattr(task, "robots", {}) or {}
        state.process_recipe_weights = _process_recipe_weights(payload)
        state.clean_task_state_variables = _clean_task_state_variables(payload)
        state.clean_wac_trigger_rules = _clean_wac_trigger_rules(payload)
        state.clean_obligations = _clean_obligation_specs(payload)

        for name, config in station_configs.items():
            task_station = task_stations.get(name)
            station_type = str(config.get("Type") or getattr(task_station, "type", ""))
            slots = {
                slot_id: SlotState(
                    material_process_count=_station_slot_material_count(config, slot_id),
                )
                for slot_id in _station_slot_ids(config, task_station)
            }
            if station_type.lower() == LOAD_LOCK_TYPE:
                aliases = _environment_aliases(config)
                aliases.update({
                    str(alias).strip().upper(): str(environment)
                    for alias, environment in dict(
                        getattr(task_station, "environment_by_robot", {}) or {}
                    ).items()
                    if alias
                })
                state.stations[name] = LoadLockState(
                    name=name,
                    station_type=station_type,
                    slots=slots,
                    environment=_environment_from_last_item(str(config.get("LastItem") or ""), aliases),
                    environment_aliases=aliases,
                    environment_state_space=_environment_state_space(config),
                    state_variables=_station_state_variables(config),
                )
            else:
                state.stations[name] = StationState(
                    name,
                    station_type,
                    slots,
                    state_variables=_station_state_variables(config),
                )

        for name, task_station in task_stations.items():
            station_name = str(name)
            if station_name not in state.stations:
                state.stations[station_name] = _station_from_task(station_name, task_station)

        for name, config in robot_configs.items():
            robot = _robot_from_config(name, config, task_robots.get(name))
            state.robots[name] = robot
            state.robot_aliases[name] = name
            if config.get("Name"):
                state.robot_aliases[str(config["Name"])] = name
        for name, task_robot in task_robots.items():
            robot_name = str(name)
            if robot_name not in state.robots:
                state.robots[robot_name] = _robot_from_task(robot_name, task_robot)
            state.robot_aliases.setdefault(robot_name, robot_name)

        # Route 可引用配置中遗漏的逻辑槽位；只扩容，不缩小显式物理容量。
        for wafer in getattr(task, "wafers", ()) or ():
            for stage in getattr(wafer, "stages", ()) or ():
                station_name = str(getattr(stage, "chamber", "") or "")
                if station_name:
                    state.ensure_station(station_name, int(getattr(stage, "slot", 0) or 0) + 1)

        # 标准输出可能省略零时长产品 ProcessMove。ProcessRecipes 是本轮运行计划
        # 的最终时长来源，优先于 Route 编译期默认值；保留可严格证明的三元组，
        # 后续 Pick 时仅为该类 PM 物料补齐已加工状态。
        recipe_durations = {
            (str(recipe.get("Name") or ""), str(recipe.get("ModuleName") or "")): recipe.get("Time")
            for recipe in payload.get("ProcessRecipes", []) or []
            if isinstance(recipe, Mapping)
        }
        state.zero_duration_process_steps = _zero_duration_product_process_steps(
            payload,
            recipe_durations,
        )
        for wafer in getattr(task, "wafers", ()) or ():
            material_id = str(getattr(wafer, "mat_id", ""))
            for stage in getattr(wafer, "stages", ()) or ():
                if str(getattr(stage, "stage_type", "")) != "process":
                    continue
                step_id = str(getattr(stage, "step_id", getattr(stage, "j", "")))
                process_times = dict(
                    getattr(stage, "process_time_by_chamber", {}) or {}
                )
                candidates = {
                    str(getattr(stage, "chamber", "") or ""),
                    *(
                        str(candidate)
                        for candidate in getattr(stage, "cands", ()) or ()
                    ),
                }
                for candidate in candidates - {""}:
                    try:
                        recipe_name = str(
                            dict(
                                getattr(stage, "process_recipe_by_chamber", {})
                                or {}
                            ).get(candidate, getattr(stage, "process_recipe", ""))
                            or ""
                        )
                        duration = float(
                            recipe_durations.get(
                                (recipe_name, candidate),
                                process_times.get(
                                    candidate,
                                    getattr(stage, "proc", 0.0),
                                ),
                            )
                        )
                    except (TypeError, ValueError):
                        continue
                    if math.isfinite(duration) and abs(duration) <= TIME_TOLERANCE:
                        state.zero_duration_process_steps.add(
                            (material_id, step_id, candidate)
                        )

        for station_name, slot_id, material in _initial_materials(task, payload):
            station = state.ensure_station(station_name, slot_id)
            if station.slots[slot_id].material is not None:
                raise ValueError(
                    _global_issue(
                        ValidationErrorCode.INITIAL_MATERIAL_CONFLICT,
                        f"初始物料在 {station_name}#{slot_id} 发生冲突",
                    )
                )
            station.slots[slot_id] = SlotState(
                SlotPhase.COMPLETED,
                material,
                material_process_count=station.slots[slot_id].material_process_count,
            )
        return state

    def ensure_station(self, name: str, slot_id: int) -> StationState:
        """返回站点，并为输入遗漏的合法引用补建槽位。"""
        station = self.stations.get(name)
        if station is None:
            station = StationState(name, "", {slot_id: SlotState()})
            self.stations[name] = station
        station.slots.setdefault(slot_id, SlotState())
        return station

    def resolve_robot(self, raw_name: str) -> Optional[RobotState]:
        """按标准名称或设备别名查找机器人。"""
        return self.robots.get(self.robot_aliases.get(raw_name, raw_name))

    def clone(self) -> "MachineState":
        """返回不共享可变状态的整机快照。"""
        return deepcopy(self)

    def refresh_validation_metadata(
        self,
        update_params: Mapping[str, Any],
    ) -> None:
        """按下一代标准 update 刷新校验元数据，但保留持续物理状态。

        重算代际切换后，PM 的 ``StateVariables``、槽位占用和机器人状态是已经
        发生 Move 的事实，不能被新 update 中的初始化值重置；但 Route/Recipe
        可能新增 PJob，因此 WAC 触发条件、清洁完成后的计数重置规则和 Recipe
        权重必须从下一代 update 重新解析。
        """
        payload = _initial_payload(update_params)
        self.process_recipe_weights = _process_recipe_weights(payload)
        self.clean_task_state_variables = _clean_task_state_variables(payload)
        self.clean_wac_trigger_rules = _clean_wac_trigger_rules(payload)
        self.clean_obligations = _clean_obligation_specs(payload)
        self.zero_duration_process_steps = _zero_duration_product_process_steps(
            payload,
            {
                (str(recipe.get("Name") or ""), str(recipe.get("ModuleName") or "")): recipe.get("Time")
                for recipe in payload.get("ProcessRecipes", []) or []
                if isinstance(recipe, Mapping)
            },
        )

        # 新一代可能首次声明某个状态变量。已有变量是已执行 Move 的累计事实，
        # 只能补缺，不能用 update 初值覆盖。
        for station_name, config in _mapping(payload.get("Stations")).items():
            station = self.stations.get(station_name)
            if station is None:
                continue
            for variable_name, value in _station_state_variables(config).items():
                station.state_variables.setdefault(variable_name, value)


def _zero_duration_product_process_steps(
    payload: Mapping[str, Any],
    recipe_durations: Mapping[Tuple[str, str], Any],
) -> Set[Tuple[str, str, str]]:
    """从当前 AlgSchedule 精确提取可省略 ProcessMove 的零时长产品工艺。"""
    zero_duration_steps: Set[Tuple[str, str, str]] = set()
    for material in payload.get("Materials", []) or []:
        if not isinstance(material, Mapping):
            continue
        material_id = str(material.get("ID", material.get("MatID", "")))
        route = material.get("Route") or {}
        for route_step in route.get("RouteSteps", []) or []:
            if not isinstance(route_step, Mapping) or not route_step.get("NeedProcess"):
                continue
            step_id = str(route_step.get("StepID", ""))
            for visit in route_step.get("Visits", []) or []:
                if not isinstance(visit, Mapping):
                    continue
                module_name = str(visit.get("StationName") or "")
                recipe_name = str(visit.get("ProcessRecipe") or "")
                if not recipe_name and module_name:
                    # 运行计划约定：产品 NeedProcess Visit 的 Recipe 为空即表示
                    # 零时长即时加工。清洗使用独立 CleanTaskName，不走本分支。
                    zero_duration_steps.add((material_id, step_id, module_name))
                    continue
                try:
                    duration = float(recipe_durations[(recipe_name, module_name)])
                except (KeyError, TypeError, ValueError):
                    continue
                if math.isfinite(duration) and abs(duration) <= TIME_TOLERANCE:
                    zero_duration_steps.add((material_id, step_id, module_name))
    return zero_duration_steps


@dataclass
class _ScheduledCompletion:
    """保存已经开始、等待在结束时落地的状态变更。"""

    end_time: float
    move_id: int
    complete: Callable[[], None]


class MoveStateReplay:
    """维护外部 Move 开始/结束通知对应的平台物理状态。"""

    RUNNING = 0
    DONE = 1
    ABORTED = 2

    def __init__(
        self,
        task: Any,
        moves: Sequence[Mapping[str, Any]],
        init_data: "Optional[Mapping[str, Any] | MachineState]" = None,
    ) -> None:
        """用计划和初始快照创建实时状态记录器。"""
        self.task = task
        self.moves = [dict(move) for move in sorted(moves, key=_sort_key)]
        self.state = MachineState.from_sources(task, init_data)
        _supplement_state_from_moves(self.state, self.moves)
        self.current_time = 0.0
        self._moves_by_id = {
            int(move["MoveID"]): move
            for move in self.moves
            if isinstance(move.get("MoveID"), int)
        }
        self._scheduled: List[_ScheduledCompletion] = []
        self._running: Dict[int, Dict[str, Any]] = {}
        self._executed: Dict[int, Dict[str, Any]] = {}

    @property
    def running_move_ids(self) -> frozenset[int]:
        """返回已经开始但尚未完成的 MoveID。"""
        return frozenset(self._running)

    @property
    def executed_moves(self) -> List[dict]:
        """按实际时间返回已完成动作副本。"""
        return [dict(move) for move in sorted(self._executed.values(), key=_sort_key)]

    @property
    def materialized_plan(self) -> List[dict]:
        """用实际执行记录覆盖原计划并返回当前代次。"""
        return [
            dict(self._executed.get(int(move.get("MoveID", -1)), move))
            for move in self.moves
        ]

    def update_move_state(
        self,
        notification: Mapping[str, Any],
        *,
        snapshot: bool = True,
        track_reservations: bool = True,
    ) -> Optional[MachineState]:
        """应用一条 Running/Done 通知；返回值按需复制当前快照。"""
        del track_reservations  # 平台状态按实际完成回调落地，不依赖算法资源回滚。
        move_id = notification.get("MoveID")
        if not isinstance(move_id, int) or move_id not in self._moves_by_id:
            raise ValueError(f"未知 MoveID={move_id}")
        move_state = _notification_state(notification)
        if move_state == self.RUNNING:
            if move_id in self._running or move_id in self._executed:
                raise ValueError(f"MoveID={move_id} 收到重复开始通知")
            planned = self._moves_by_id[move_id]
            move = dict(planned)
            planned_start = _number(planned.get("StartTime")) or 0.0
            planned_end = _number(planned.get("EndTime"))
            actual_start = _number(notification.get("StartTime"))
            actual_start = planned_start if actual_start is None else actual_start
            if isinstance(notification.get("SrcStationList"), list):
                move["SrcStationList"] = list(notification["SrcStationList"])
            move["StartTime"] = actual_start
            move["EndTime"] = actual_start + max(0.0, (planned_end or planned_start) - planned_start)
            error = _start_move(self.state, move, float(move["EndTime"]), self.moves, self._scheduled)
            if error:
                raise ValueError(error)
            self._running[move_id] = move
            self.current_time = max(self.current_time, actual_start)
        elif move_state == self.DONE:
            move = self._running.get(move_id)
            if move is None:
                raise ValueError(f"MoveID={move_id} 尚未开始，不能结束")
            actual_end = _number(notification.get("EndTime"))
            actual_end = float(move["EndTime"]) if actual_end is None else actual_end
            if actual_end + TIME_TOLERANCE < float(move["StartTime"]):
                raise ValueError(f"MoveID={move_id} 的 EndTime 早于 StartTime")
            completion = next((item for item in self._scheduled if item.move_id == move_id), None)
            if completion is None:
                raise ValueError(f"MoveID={move_id} 缺少待落地状态")
            completion.complete()
            self._scheduled.remove(completion)
            move["EndTime"] = actual_end
            self._executed[move_id] = dict(move)
            del self._running[move_id]
            self.current_time = max(self.current_time, actual_end)
        else:
            raise ValueError(f"MoveID={move_id} 已中止；请先完成设备恢复，再从稳定状态重算")
        return self.state.clone() if snapshot else None


def materialize_module_parallel_moves(
    moves: Sequence[Mapping[str, Any]],
    clock_floor: float = 0.0,
) -> List[dict]:
    """按 HongYe ``module-parallel`` 规则计算 Move 的实际时间。

    每个 ``ModuleName`` 是一条独立串行时间线；不同模块并行推进。同一模块的
    Move 按计划开始时刻和 MoveID 排序，实际开始时刻不得早于模块上一条 Move
    的结束时刻。当前 Move 引用的本代 ``PreMoveID`` 也必须全部结束，并把最晚
    前驱结束时刻作为开始下界。跨代前驱不在本 MoveList 中，其完成事实已经包含
    在本代初始快照里，因此不会阻塞。

    参数:
        moves: 当前代算法输出的 MoveList。
        clock_floor: 当前代现场时刻，所有 Move 的实际开始时间不得早于该值。

    返回:
        深拷贝后的 MoveList，其中 StartTime/EndTime 已替换为实际执行时间。
    """
    floor = _number(clock_floor)
    normalized_floor = max(0.0, floor if floor is not None else 0.0)
    copied = [deepcopy(dict(move)) for move in moves]
    known_ids = {
        int(move["MoveID"])
        for move in copied
        if isinstance(move.get("MoveID"), int)
    }
    queues: Dict[str, List[dict]] = {}
    for move in copied:
        module_name = str(move.get("ModuleName") or "").strip() or "__GLOBAL__"
        queues.setdefault(module_name, []).append(move)
    for queue in queues.values():
        queue.sort(key=_sort_key)

    module_available: Dict[str, float] = {
        module_name: normalized_floor for module_name in queues
    }
    actual_end_by_id: Dict[int, float] = {}
    ended_ids: Set[int] = set()
    materialized: List[dict] = []

    while queues:
        candidates: List[Tuple[float, str, int, dict]] = []
        blocked_heads: List[Tuple[float, str, int, dict]] = []
        for module_name, queue in queues.items():
            move = queue[0]
            move_id = int(move.get("MoveID")) if isinstance(move.get("MoveID"), int) else 0
            predecessors = {
                int(value)
                for value in (move.get("PreMoveID") or [])
                if isinstance(value, int) and int(value) in known_ids
            }
            planned_start = _number(move.get("StartTime")) or 0.0
            earliest_start = max(
                normalized_floor,
                planned_start,
                module_available[module_name],
                *(actual_end_by_id[value] for value in predecessors if value in actual_end_by_id),
            )
            candidate = (earliest_start, module_name, move_id, move)
            blocked_heads.append(candidate)
            if predecessors <= ended_ids:
                candidates.append(candidate)

        # 依赖环属于后续结构校验的职责。这里沿用 HongYe 的容错行为继续生成
        # 确定性时间线，使调用方仍能得到带稳定错误码的依赖环诊断。
        selected = min(candidates or blocked_heads, key=lambda item: item[:3])
        actual_start, module_name, move_id, move = selected
        planned_start = _number(move.get("StartTime")) or 0.0
        planned_end = _number(move.get("EndTime"))
        duration = max(0.0, (planned_end if planned_end is not None else planned_start) - planned_start)
        actual_end = actual_start + duration
        move["StartTime"] = actual_start
        move["EndTime"] = actual_end
        materialized.append(move)
        module_available[module_name] = actual_end
        if isinstance(move.get("MoveID"), int):
            actual_end_by_id[move_id] = actual_end
            ended_ids.add(move_id)
        queues[module_name].pop(0)
        if not queues[module_name]:
            del queues[module_name]

    return materialized


def validate_move_list(
    task: Any,
    moves: List[dict],
    init_data: "Optional[Mapping[str, Any] | MachineState]" = None,
    *,
    check_residency: bool = True,
    external_predecessors: "Optional[Mapping[int, Mapping[str, Any]]]" = None,
    skipped_clean_validation_types: "Optional[Iterable[str]]" = None,
) -> List[str]:
    """按时间线校验 MoveList；覆盖依赖 DAG、Route 时限与物理状态。

    ``external_predecessors`` 提供上一代已提交或正在执行的 Move（按 MoveID
    索引），供重算增量输出引用：其 MoveID 不属于本代 ``moves``，但可被本代
    ``PreMoveID`` 合法引用为已完成的前驱；首排校验不传该参数。
    """
    for index, move in enumerate(moves):
        if not isinstance(move, Mapping):
            return [
                _global_issue(
                    ValidationErrorCode.MOVE_ITEM_INVALID,
                    f"MoveList[{index}] 必须是 JSON 对象",
                )
            ]
    field_error = _validate_move_field_shapes(moves)
    if field_error:
        return [field_error]
    dependency_error = _validate_move_dependencies(moves, external_predecessors)
    if dependency_error:
        return [dependency_error]
    duration_error = _validate_configured_durations(task, moves, init_data)
    if duration_error:
        return [duration_error]
    if check_residency:
        route_time_error = _validate_route_time_limits(task, moves)
        if route_time_error:
            return [route_time_error]
    try:
        state = MachineState.from_sources(task, init_data)
    except ValueError as error:
        return [str(error)]
    state.skipped_clean_validation_types = {
        str(value).strip().lower()
        for value in (skipped_clean_validation_types or ())
        if str(value).strip().lower() in CLEAN_VALIDATION_TYPES
    }
    scheduled: List[_ScheduledCompletion] = []
    ordered_moves = sorted(moves, key=_sort_key)
    _supplement_state_from_moves(state, ordered_moves)
    for move in ordered_moves:
        start_time = _number(move.get("StartTime"))
        end_time = _number(move.get("EndTime"))
        if start_time is None or end_time is None:
            return [_issue(move, ValidationErrorCode.TIME_INVALID, "StartTime 和 EndTime 必须是有限数字")]
        if end_time + TIME_TOLERANCE < start_time:
            return [_issue(move, ValidationErrorCode.TIME_REVERSED, "EndTime 不能早于 StartTime")]
        _finish_until(scheduled, start_time)
        error = _start_move(state, move, end_time, ordered_moves, scheduled)
        if error:
            return [error]
    _finish_until(scheduled, float("inf"))
    clean_issue = _final_clean_obligation_issue(state)
    if clean_issue:
        return [clean_issue]
    return []


def _validate_move_field_shapes(moves: Sequence[Mapping[str, Any]]) -> Optional[str]:
    """校验 MoveType 与专属槽位字段的协议边界。"""
    for move in moves:
        if move.get("MoveType") in {PICK_MOVE, MULTI_PICK_MOVE} and "SlotList" in move:
            return _issue(
                move,
                ValidationErrorCode.MOVE_FIELD_INVALID,
                "PickMove 不允许携带 SlotList，请使用 SrcSlotList",
            )
    return None


def _validate_move_dependencies(
    moves: Sequence[Mapping[str, Any]],
    external_predecessors: "Optional[Mapping[int, Mapping[str, Any]]]" = None,
) -> Optional[str]:
    """校验 MoveID 唯一性、PreMoveID 引用、拓扑无环和时间先后。

    ``external_predecessors`` 提供上一代已提交或正在执行的 Move 索引（按
    MoveID）。重算增量输出的 ``PreMoveID`` 可引用这些旧代 MoveID 作为已完成
    前驱：仍要求其 EndTime 不晚于本动作 StartTime，但不参与本代拓扑环检测。
    """
    by_id: Dict[int, Mapping[str, Any]] = {}
    for move in moves:
        raw_move_id = move.get("MoveID")
        if isinstance(raw_move_id, bool) or not isinstance(raw_move_id, int):
            return _issue(move, ValidationErrorCode.MOVE_ID_INVALID, "MoveID 必须是整数")
        move_id = int(raw_move_id)
        if move_id in by_id:
            return _issue(move, ValidationErrorCode.MOVE_ID_DUPLICATE, f"MoveID={move_id} 重复")
        by_id[move_id] = move

    predecessors: Dict[int, Set[int]] = {}
    successors: Dict[int, Set[int]] = {move_id: set() for move_id in by_id}
    for move_id, move in by_id.items():
        raw_values = move.get("PreMoveID") or []
        if not isinstance(raw_values, Sequence) or isinstance(raw_values, (str, bytes)):
            return _issue(move, ValidationErrorCode.PREDECESSOR_FORMAT_INVALID, "PreMoveID 必须是整数数组")
        parsed: Set[int] = set()
        for raw_value in raw_values:
            if isinstance(raw_value, bool) or not isinstance(raw_value, int):
                return _issue(move, ValidationErrorCode.PREDECESSOR_VALUE_INVALID, f"PreMoveID 包含非整数引用: {raw_value}")
            predecessor_id = int(raw_value)
            if predecessor_id == move_id:
                return _issue(move, ValidationErrorCode.PREDECESSOR_SELF_REFERENCE, "PreMoveID 不能引用自身")
            predecessor = by_id.get(predecessor_id)
            external = (
                external_predecessors.get(predecessor_id)
                if predecessor is None and external_predecessors is not None
                else None
            )
            if predecessor is None and external is None:
                return _issue(move, ValidationErrorCode.PREDECESSOR_MISSING, f"PreMoveID 引用了不存在的 MoveID={predecessor_id}")
            predecessor_end = _number((predecessor or external).get("EndTime"))
            current_start = _number(move.get("StartTime"))
            if (
                predecessor_end is not None
                and current_start is not None
                and predecessor_end > current_start + TIME_TOLERANCE
            ):
                return _issue(
                    move,
                    ValidationErrorCode.PREDECESSOR_TIME_CONFLICT,
                    f"前驱 MoveID={predecessor_id} 尚未结束（EndTime={predecessor_end}）",
                )
            if predecessor is not None:
                parsed.add(predecessor_id)
                successors[predecessor_id].add(move_id)
        predecessors[move_id] = parsed

    ready = [move_id for move_id, values in predecessors.items() if not values]
    visited = 0
    while ready:
        current = ready.pop()
        visited += 1
        for successor in successors[current]:
            predecessors[successor].discard(current)
            if not predecessors[successor]:
                ready.append(successor)
    if visited != len(by_id):
        cyclic = sorted(move_id for move_id, values in predecessors.items() if values)
        return _global_issue(
            ValidationErrorCode.DEPENDENCY_CYCLE,
            f"MoveList 的 PreMoveID 存在依赖环: {cyclic}",
        )
    return None
def _validate_configured_durations(
    task: Any,
    moves: Sequence[Mapping[str, Any]],
    init_data: "Optional[Mapping[str, Any] | MachineState]",
) -> Optional[str]:
    """按设备四元组和 Route Visit 校验算法输出的原子动作时长。"""
    if isinstance(init_data, MachineState):
        payload: Mapping[str, Any] = {}
    else:
        payload = _initial_payload(init_data)
    robots = _mapping(payload.get("Robots"))

    for move in moves:
        move_type = move.get("MoveType")
        start_time = _number(move.get("StartTime"))
        end_time = _number(move.get("EndTime"))
        if start_time is None or end_time is None:
            continue
        actual = end_time - start_time
        robot_name = str(move.get("Robot") or move.get("ModuleName") or "")
        robot = robots.get(robot_name)
        expected: Optional[float] = None
        if move_type in {PICK_MOVE, PLACE_MOVE} and isinstance(robot, Mapping):
            station_field = "SrcStationList" if move_type == PICK_MOVE else "DestStationList"
            station_name = _first_text(move, station_field)
            timing_field = "PickTime" if move_type == PICK_MOVE else "PlaceTime"
            raw_timing = robot.get(timing_field)
            if isinstance(raw_timing, Mapping):
                if station_name not in raw_timing:
                    return _issue(
                        move,
                        ValidationErrorCode.TIMING_CONFIG_MISSING,
                        f"{robot_name} 缺少 {timing_field}[{station_name}]",
                    )
                expected = _number(raw_timing[station_name])
                if expected is None or expected < 0.0:
                    return _issue(
                        move,
                        ValidationErrorCode.TIMING_CONFIG_INVALID,
                        f"{robot_name} 的 {timing_field}[{station_name}] 必须是非负有限数字",
                    )
        elif move_type == PRE_TRANS_MOVE and isinstance(robot, Mapping):
            entries = robot.get("PrepTransTime")
            if isinstance(entries, Sequence) and not isinstance(entries, (str, bytes)) and entries:
                source = _first_text(move, "SrcStationList")
                destination = _first_text(move, "DestStationList")
                material_ids = _values(move, "MatIDList")
                robot_slots = _integer_values(move, "RobotSlotList")
                is_linked_empty = bool(material_ids) and all(
                    index < len(robot_slots)
                    and _pretrans_is_linked_empty_pick(
                        move,
                        moves,
                        index,
                        robot_slots[index],
                        material_id,
                    )
                    for index, material_id in enumerate(material_ids)
                )
                trans_type = 0 if not material_ids or is_linked_empty else 1
                transfer_index: Dict[Tuple[str, str, int], float] = {}
                for item in entries:
                    if not isinstance(item, Mapping) or "TransType" not in item:
                        return _issue(move, ValidationErrorCode.TIMING_CONFIG_INVALID, f"{robot_name} 的 PrepTransTime 缺少 TransType")
                    raw_transfer_type = item.get("TransType")
                    if isinstance(raw_transfer_type, bool) or not isinstance(raw_transfer_type, int):
                        return _issue(move, ValidationErrorCode.TIMING_CONFIG_INVALID, f"{robot_name} 的 PrepTransTime.TransType 必须是整数")
                    transfer_time = _number(item.get("Time"))
                    if transfer_time is None or transfer_time < 0.0:
                        return _issue(move, ValidationErrorCode.TIMING_CONFIG_INVALID, f"{robot_name} 的 PrepTransTime.Time 必须是非负有限数字")
                    key = (
                        str(item.get("SrcStation") or ""),
                        str(item.get("DestStation") or ""),
                        raw_transfer_type,
                    )
                    if key in transfer_index:
                        return _issue(move, ValidationErrorCode.TIMING_CONFIG_INVALID, f"{robot_name} 的 PrepTransTime 重复四元组 {key}")
                    transfer_index[key] = transfer_time
                lookup = (source, destination, trans_type)
                if lookup not in transfer_index:
                    return _issue(move, ValidationErrorCode.TIMING_CONFIG_MISSING, f"{robot_name} 缺少 PrepTransTime 四元组 {lookup}")
                expected = transfer_index[lookup]
        elif move_type == PROCESS_MOVE and task is not None:
            expected = _process_move_expected_duration(task, move)

        if expected is not None and abs(actual - expected) > TIME_TOLERANCE:
            return _issue(
                move,
                ValidationErrorCode.DURATION_MISMATCH,
                f"动作时长 {actual:.6f}s 与配置 {expected:.6f}s 不一致",
            )
    return None
def _process_move_expected_duration(task: Any, move: Mapping[str, Any]) -> Optional[float]:
    """按 MatID、原始 StepID 和模块定位 ProcessMove 的配置时长。"""
    material_ids = _values(move, "MatIDList")
    if not material_ids:
        return None
    material_key = str(material_ids[0])
    wafer = next(
        (
            item
            for item in getattr(task, "wafers", ()) or ()
            if str(getattr(item, "mat_id", "")) == material_key
        ),
        None,
    )
    if wafer is None:
        return None
    step_ids = _integer_values(move, "StepIDList")
    step_id = step_ids[0] if step_ids else None
    station_name = _station_name(move)
    stage = next(
        (
            item
            for item in getattr(wafer, "stages", ()) or ()
            if str(getattr(item, "stage_type", "")) == "process"
            and (
                step_id is None
                or int(getattr(item, "step_id", getattr(item, "j", -1))) == step_id
            )
            and (
                str(getattr(item, "chamber", "")) == station_name
                or station_name in {str(value) for value in getattr(item, "cands", ()) or ()}
            )
        ),
        None,
    )
    if stage is None:
        return None
    by_chamber = dict(getattr(stage, "process_time_by_chamber", {}) or {})
    return float(by_chamber.get(station_name, getattr(stage, "proc", 0.0)))


def _validate_route_time_limits(
    task: Any,
    moves: Sequence[Mapping[str, Any]],
) -> Optional[str]:
    """按 Problem 中保留的原始 StepID 校验 Residency 与相邻加工 Q-time。"""
    wafers = list(getattr(task, "wafers", ()) or ()) if task is not None else []
    if not wafers:
        return None
    wafer_by_material = {
        str(getattr(wafer, "mat_id", "")): wafer
        for wafer in wafers
    }
    ordered = sorted(moves, key=_sort_key)
    process_events: Dict[str, List[Tuple[Mapping[str, Any], Any]]] = {}
    for move in ordered:
        if move.get("MoveType") != PROCESS_MOVE:
            continue
        material_ids = _values(move, "MatIDList")
        step_ids = _integer_values(move, "StepIDList")
        station_name = _station_name(move)
        for index, material_id in enumerate(material_ids):
            material_key = str(material_id)
            wafer = wafer_by_material.get(material_key)
            if wafer is None:
                continue
            step_id = step_ids[index] if index < len(step_ids) else None
            stages = [
                stage
                for stage in getattr(wafer, "stages", ()) or ()
                if str(getattr(stage, "stage_type", "")) == "process"
                and (
                    step_id is None
                    or int(getattr(stage, "step_id", getattr(stage, "j", -1))) == step_id
                )
                and (
                    str(getattr(stage, "chamber", "")) == station_name
                    or station_name in {
                        str(value) for value in getattr(stage, "cands", ()) or ()
                    }
                )
            ]
            occurrence = len(process_events.get(material_key, ()))
            if not stages:
                continue
            stage = stages[min(occurrence, len(stages) - 1)]
            process_events.setdefault(material_key, []).append((move, stage))

    for material_key, events in process_events.items():
        for index, (process_move, stage) in enumerate(events):
            process_end = _number(process_move.get("EndTime"))
            if process_end is None:
                continue
            residency = float(getattr(stage, "residency", -1.0))
            if residency >= 0.0:
                source_station = _station_name(process_move)
                departure = next(
                    (
                        candidate
                        for candidate in ordered
                        if candidate.get("MoveType") == PICK_MOVE
                        and material_key in {
                            str(value) for value in _values(candidate, "MatIDList")
                        }
                        and source_station in {
                            str(value) for value in _values(candidate, "SrcStationList")
                        }
                        and (_number(candidate.get("StartTime")) or 0.0)
                        >= process_end - TIME_TOLERANCE
                    ),
                    None,
                )
                if departure is None:
                    return _issue(
                        process_move,
                        ValidationErrorCode.POST_PROCESS_PICK_MISSING,
                        f"加工完成后缺少物料 {material_key} 的取片动作",
                    )
                elapsed = (_number(departure.get("StartTime")) or process_end) - process_end
                if elapsed > residency + TIME_TOLERANCE:
                    return _issue(
                        departure,
                        ValidationErrorCode.RESIDENCY_EXCEEDED,
                        f"物料 {material_key} 驻留 {elapsed:.3f}s 超过上限 {residency:.3f}s",
                    )
            qtime = float(getattr(stage, "qtime", -1.0))
            if qtime >= 0.0 and index + 1 < len(events):
                next_move = events[index + 1][0]
                elapsed = (_number(next_move.get("StartTime")) or process_end) - process_end
                if elapsed > qtime + TIME_TOLERANCE:
                    return _issue(
                        next_move,
                        ValidationErrorCode.QTIME_EXCEEDED,
                        f"物料 {material_key} 相邻加工间隔 {elapsed:.3f}s 超过 Q-time {qtime:.3f}s",
                    )
    return None


def release_completed_load_port_materials(
    task: Any,
    state: MachineState,
    load_port_names: Sequence[str],
) -> Tuple[set[Any], set[str]]:
    """从平台快照卸载已经到达 Route 终点的晶圆。"""
    wafer_by_material = {
        getattr(wafer, "mat_id", None): wafer
        for wafer in getattr(task, "wafers", ()) or ()
    }
    released_ids: set[Any] = set()
    empty_ports: set[str] = set()
    for load_port_name in {str(name) for name in load_port_names if str(name)}:
        station = state.stations.get(load_port_name)
        if station is None:
            continue
        for slot in station.slots.values():
            material = slot.material
            if material is None:
                continue
            wafer = wafer_by_material.get(material.material_id)
            stages = list(getattr(wafer, "stages", ()) or ()) if wafer is not None else []
            if not stages:
                continue
            final_stage_index = len(stages) - 1
            final_stage = stages[final_stage_index]
            accepts_load_port = (
                str(getattr(final_stage, "chamber", "")) == load_port_name
                or load_port_name in {str(name) for name in getattr(final_stage, "cands", ()) or ()}
            )
            if (
                str(getattr(final_stage, "stage_type", "")) != "sink"
                or not accepts_load_port
                or material.step_id != final_stage_index
            ):
                continue
            released_ids.add(material.material_id)
            _set_slot(slot, SlotPhase.EMPTY, None)
        if all(slot.material is None for slot in station.slots.values()):
            empty_ports.add(load_port_name)
    return released_ids, empty_ports


def _robot_target_stations(robot: RobotState) -> Set[str]:
    """机器人当前可对准的站集合（槽位级模式）。"""
    stations: Set[str] = set()
    for options in robot.slot_options.values():
        stations.update(station for station, _ in options)
    return stations


def _robot_derived_position(robot: RobotState) -> Optional[str]:
    """从槽位候选派生站级 position（兼容外部 API 与快照回写）。"""
    stations = _robot_target_stations(robot)
    return min(stations) if stations else robot.position


def _robot_alignment_issue(
    robot: RobotState,
    move: Mapping[str, Any],
    station_refs: Sequence[Tuple[str, int, int]],
) -> Optional[str]:
    """校验机器人能否在取放/换片动作的目标站槽位上作业。

    ``station_refs`` 为逐行 ``(站名, 站槽位号, 手槽号)``。配置了 ``SlotsStationMap``
    的机器人按手槽候选的**站级可达**逐行校验（双臂可跨站）；具体槽位号信任算法
    动作声明，不构成硬约束。未配置的退回站级 position 校验。
    """
    if robot.slot_map:
        for station_name, station_slot_id, robot_slot_id in station_refs:
            options = robot.slot_options.get(robot_slot_id)
            if options is None:
                # 该手槽没有槽位级拓扑配置（如算法按 capacity 补全的逻辑槽位），
                # 不参与候选校验，退回调用方的宽松判定。
                continue
            if station_name not in {candidate[0] for candidate in options}:
                reachable = "、".join(sorted({candidate[0] for candidate in options}))
                return _issue(
                    move,
                    ValidationErrorCode.ROBOT_ALIGNMENT_INVALID,
                    f"{robot.name}#{robot_slot_id} 无法对准 {station_name}#{station_slot_id}（当前手槽可及站：{reachable or '无'}）",
                )
        return None
    station_names = {station_name for station_name, _, _ in station_refs}
    if robot.position is not None and robot.position not in station_names:
        return _issue(move, ValidationErrorCode.ROBOT_ALIGNMENT_INVALID, f"{robot.name} 当前指向 {robot.position}，不在组合站点 {sorted(station_names)}")
    return None


def _parallel_arrays_alignment_issue(move: Mapping[str, Any], fields: Sequence[str]) -> Optional[str]:
    """校验一组并行数组的非空长度一致（空字段忽略），对齐 MOVE.ARRAY_ALIGNMENT。"""
    lengths = {field: len(_values(move, field)) for field in fields}
    nonzero = {length for length in lengths.values() if length > 0}
    if len(nonzero) > 1:
        detail = ",".join(f"{field}={lengths[field]}" for field in fields)
        return _issue(move, ValidationErrorCode.PARALLEL_ARRAY_INVALID, f"Move 对应数组长度不一致: {detail}")
    return None


def _pretrans_source_issue(robot: RobotState, move: Mapping[str, Any]) -> Optional[str]:
    """校验转位起点：槽位级模式按涉及手槽是否跨站分两种语义比对。

    真空手双槽臂在孪生站组（LALB）下，本次转位涉及的不同手槽会指向不同站
    （槽1→LA、槽2→LB）：此时 SrcStationList 必须按槽与该手槽精确指向一致，对齐
    MoveStateSim 的 RequirePreTransSource 逐槽检查。其余情况（大气手整臂单站、
    单槽转位）退回候选站集合检查；未配置槽位级拓扑时退回站级 position。
    """
    sources = [str(value) for value in _values(move, "SrcStationList") if value]
    robot_slots = _integer_values(move, "RobotSlotList")
    if robot.slot_map:
        involved_stations = {
            robot.slot_targets[slot][0]
            for slot in robot_slots
            if slot in robot.slot_targets and robot.slot_targets[slot] and robot.slot_targets[slot][0]
        }
        if len(involved_stations) >= 2:
            n = max(len(sources), max(1, len(robot_slots)))
            for index in range(n):
                source = sources[index] if index < len(sources) else (sources[0] if len(sources) == 1 else "")
                slot = robot_slots[index] if index < len(robot_slots) else (robot_slots[0] if len(robot_slots) == 1 else None)
                if not source or slot is None:
                    continue
                target = robot.slot_targets.get(slot)
                if target is not None and target[0]:
                    if source != target[0]:
                        return _issue(
                            move,
                            ValidationErrorCode.PRETRANS_STATE_INVALID,
                            f"{robot.name}#{slot} 无法从 {source} 转位（当前指向 {target[0]}）",
                        )
                elif source not in _robot_target_stations(robot):
                    return _issue(
                        move,
                        ValidationErrorCode.PRETRANS_STATE_INVALID,
                        f"{robot.name} 无法从 {source} 转位（当前手槽指向站：{sorted(_robot_target_stations(robot))}）",
                    )
            return None
        source = sources[0] if sources else ""
        if source and source not in _robot_target_stations(robot):
            return _issue(
                move,
                ValidationErrorCode.PRETRANS_STATE_INVALID,
                f"{robot.name} 无法从 {source} 转位（当前手槽指向站：{sorted(_robot_target_stations(robot))}）",
            )
        return None
    source = sources[0] if sources else ""
    if robot.position is not None and source and robot.position != source:
        return _issue(move, ValidationErrorCode.PRETRANS_STATE_INVALID, f"{robot.name} 当前指向 {robot.position}，不是 {source}")
    return None


def _pretrans_target_group(robot: RobotState, dest_stations: Sequence[str]) -> Optional[str]:
    """从 DestStationList 反查覆盖全部目标站的 SlotsStationMap 站组名。"""
    target_stations = {str(value) for value in dest_stations if value}
    if not target_stations:
        return None
    for group_name, stations in _slot_map_group_stations(robot.slot_map).items():
        if target_stations.issubset(stations):
            return group_name
    return None


def _apply_pretrans_landing(robot: RobotState, move: Mapping[str, Any]) -> None:
    """转位落地：整条物理 Arm 先切到目标站组，再刷新动作声明的精确指向。

    ``SlotsStationMap`` 描述的是共享 Arm 的站组姿态。即使一条 PreTrans 只列出
    一个 ``RobotSlot``，Arm 上未参与本次取放的其他手槽也会随 Arm 一起转动；
    若只刷新声明槽位，后续双片转位会把其余手槽误判为仍指向旧站。
    """
    if robot.slot_map:
        dest_stations = [str(value) for value in _values(move, "DestStationList")]
        group = _pretrans_target_group(robot, dest_stations)
        if group is not None:
            for slot_id, groups in robot.slot_map.items():
                candidates = set(groups.get(group) or ())
                if not candidates:
                    continue
                robot.slot_options[slot_id] = candidates
                robot.slot_targets[slot_id] = next(iter(sorted(candidates)))
    robot_slots = _integer_values(move, "RobotSlotList")
    dest_stations = [str(value) for value in _values(move, "DestStationList")]
    dest_slots = _integer_values(move, "DestSlotList")
    for index, robot_slot in enumerate(robot_slots):
        station = dest_stations[index] if index < len(dest_stations) else (dest_stations[0] if dest_stations else None)
        station_slot = dest_slots[index] if index < len(dest_slots) else None
        if station:
            if station_slot is not None:
                robot.slot_targets[robot_slot] = (station, station_slot)
            else:
                candidates = sorted(
                    candidate
                    for candidate in robot.slot_options.get(robot_slot, ())
                    if candidate[0] == station
                )
                robot.slot_targets[robot_slot] = candidates[0] if candidates else None
    robot.position = _robot_derived_position(robot)


def _start_move(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """分派一条动作并登记其完成状态。"""
    handlers = {
        PICK_MOVE: _start_pick,
        PLACE_MOVE: _start_place,
        SWAP_MOVE: _start_swap,
        PRE_TRANS_MOVE: _start_pretrans,
        PREPARE_MOVE: _start_prepare,
        COMPLETE_MOVE: _start_complete,
        PROCESS_MOVE: _start_process,
        PRE_PREPARE_MOVE: _start_preprepare,
        ALIGN_MOVE: _start_align,
    }
    handler = handlers.get(move.get("MoveType"))
    if handler is None:
        return _issue(move, ValidationErrorCode.MOVE_TYPE_UNSUPPORTED, f"不支持 MoveType={move.get('MoveType')}")
    return handler(state, move, end_time, all_moves, scheduled)


def _supplement_state_from_moves(
    state: MachineState,
    moves: Sequence[Mapping[str, Any]],
) -> None:
    """为旧协议中省略的拓扑补齐动作已明确引用的资源与槽位。"""
    transport_move_types = {PICK_MOVE, PLACE_MOVE, SWAP_MOVE, PRE_TRANS_MOVE}
    controlled_station_names = {
        _station_name(move)
        for move in moves
        if move.get("MoveType") in {PREPARE_MOVE, COMPLETE_MOVE}
        and _station_name(move)
    }
    for move in moves:
        move_type = move.get("MoveType")
        for station_key, slot_key in (
            ("SrcStationList", "SrcSlotList"),
            ("DestStationList", "DestSlotList"),
        ):
            station_names = _values(move, station_key)
            slot_ids = _integer_values(move, slot_key)
            for index, station_name in enumerate(station_names):
                if station_name in {None, ""}:
                    continue
                slot_id = slot_ids[index] if index < len(slot_ids) else 1
                station = state.ensure_station(str(station_name), slot_id)
                if (
                    not station.station_type
                    and station.name not in controlled_station_names
                ):
                    station.door = DoorState.OPEN
        if move_type not in transport_move_types:
            continue
        robot_name = str(move.get("Robot") or move.get("ModuleName") or "")
        if not robot_name:
            continue
        robot_slot_ids = {
            *_integer_values(move, "RobotSlotList"),
            *_integer_values(move, "RecvRobotSlotList"),
            *_integer_values(move, "SendRobotSlotList"),
        }
        if not robot_slot_ids:
            robot_slot_ids.add(1)
        robot = state.resolve_robot(robot_name)
        if robot is None:
            robot = RobotState(
                name=robot_name,
                hands={slot_id: None for slot_id in sorted(robot_slot_ids)},
                can_swap=move_type == SWAP_MOVE,
            )
            state.robots[robot_name] = robot
            state.robot_aliases[robot_name] = robot_name
        else:
            for slot_id in robot_slot_ids:
                robot.hands.setdefault(slot_id, None)
            if move_type == SWAP_MOVE:
                robot.can_swap = True


def _is_omitted_zero_duration_process(
    state: MachineState,
    station_name: str,
    material: Optional[MaterialState],
) -> bool:
    """判断未输出 ProcessMove 的 PM 物料能否按零时长工艺完成。

    仅接受由当前任务 Route 明确声明的产品工艺、物料、Step 和 PM 三者完全匹配
    的零时长记录，避免把任何缺失 ProcessMove 的普通加工误判为已完成。
    """
    if material is None:
        return False
    return (
        str(material.material_id),
        str(material.step_id),
        station_name,
    ) in state.zero_duration_process_steps


def _start_pick(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验并执行可包含多片晶圆的原子 Pick。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    rows_or_error = _transport_rows(move, "SrcStationList", "SrcSlotList", "RobotSlotList", "MatIDList")
    if isinstance(rows_or_error, str):
        return rows_or_error
    rows = rows_or_error
    error = _validate_distinct_transport_rows(move, rows)
    if error:
        return error
    start_time = _start_time(move)
    if not _available(robot.busy_until, start_time):
        return _issue(move, ValidationErrorCode.ROBOT_BUSY, f"{robot.name} 正在执行其他动作")
    transfers: List[Tuple[StationState, SlotState, int, int, MaterialState]] = []
    for station_name, station_slot_id, robot_slot_id, material_id, index in rows:
        station = state.stations.get(station_name)
        if station is None:
            return _issue(move, ValidationErrorCode.STATION_UNKNOWN, f"未知站点 {station_name}")
        error = _station_access_error(robot, station, start_time, move)
        if error:
            return error
        slot = station.slots.get(station_slot_id)
        if slot is None:
            return _issue(move, ValidationErrorCode.STATION_SLOT_UNKNOWN, f"{station_name} 不存在槽位 {station_slot_id}")
        if robot_slot_id not in robot.hands:
            return _issue(move, ValidationErrorCode.ROBOT_SLOT_DISABLED, f"{robot.name} 未启用手槽 {robot_slot_id}")
        if robot.hands[robot_slot_id] is not None:
            return _issue(move, ValidationErrorCode.ROBOT_HAND_STATE_INVALID, f"{robot.name}#{robot_slot_id} 不是空手")
        if not _available(slot.busy_until, start_time):
            return _issue(move, ValidationErrorCode.STATION_SLOT_BUSY, f"{station_name}#{station_slot_id} 正在{slot.busy_action}")
        if (
            slot.phase is SlotPhase.UNPROCESSED
            and _is_omitted_zero_duration_process(
                state,
                station_name,
                slot.material,
            )
        ):
            # 算法已在内部完成零时长工艺，但标准输出不会带对应 ProcessMove。
            # 此处只按任务中可证明为零时长的 PM 工序补齐状态，不能放宽一般 Pick。
            _set_slot(slot, SlotPhase.COMPLETED, slot.material)
            slot.material_process_count += 1
            if slot.material is not None and slot.material.pjob_name:
                state.product_clean_entries.add(
                    (str(slot.material.pjob_name), station_name)
                )
        if slot.phase is not SlotPhase.COMPLETED or not _material_matches(slot.material, material_id):
            return _issue(move, ValidationErrorCode.PICK_SOURCE_INVALID, f"{station_name}#{station_slot_id} 没有匹配的已完成物料")
        transfers.append((station, slot, station_slot_id, robot_slot_id, _material_with_metadata(slot.material, move, index)))
    alignment_error = _robot_alignment_issue(robot, move, [(row[0], row[1], row[2]) for row in rows])
    if alignment_error:
        return alignment_error
    robot.busy_until = end_time
    for station in {row[0].name: row[0] for row in transfers}.values():
        station.transfer_busy_until = end_time
    for _, slot, _, _, _ in transfers:
        _reserve_slot(slot, end_time, "取片")

    def complete() -> None:
        """在 Pick 完成时一次性把全部晶圆移入对应手槽，并落地槽位级指向。"""
        for station, slot, station_slot_id, robot_slot_id, material in transfers:
            _set_slot(slot, SlotPhase.EMPTY, None)
            robot.hands[robot_slot_id] = material
            robot.slot_targets[robot_slot_id] = (station.name, station_slot_id)
        robot.position = _robot_derived_position(robot)

    _schedule(scheduled, move, end_time, complete)
    return None

# 运输和配置辅助函数位于独立模块；在本模块完成定义后导入，避免状态模型与
# 辅助实现形成循环导入，同时让旧的整体校验入口保持同一组全局函数。
from . import move_validation_helpers as _move_validation_helpers  # noqa: E402

globals().update(
    {
        _name: _value
        for _name, _value in vars(_move_validation_helpers).items()
        if _name.startswith("_") and not _name.startswith("__")
    }
)


def _start_place(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验并执行可包含多片晶圆的原子 Place。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    rows_or_error = _transport_rows(move, "DestStationList", "DestSlotList", "RobotSlotList", "MatIDList")
    if isinstance(rows_or_error, str):
        return rows_or_error
    rows = rows_or_error
    error = _validate_distinct_transport_rows(move, rows)
    if error:
        return error
    start_time = _start_time(move)
    if not _available(robot.busy_until, start_time):
        return _issue(move, ValidationErrorCode.ROBOT_BUSY, f"{robot.name} 正在执行其他动作")
    transfers: List[Tuple[StationState, SlotState, int, int, MaterialState]] = []
    for station_name, station_slot_id, robot_slot_id, material_id, index in rows:
        station = state.stations.get(station_name)
        if station is None:
            return _issue(move, ValidationErrorCode.STATION_UNKNOWN, f"未知站点 {station_name}")
        error = _station_access_error(robot, station, start_time, move)
        if error:
            return error
        slot = station.slots.get(station_slot_id)
        if slot is None:
            return _issue(move, ValidationErrorCode.STATION_SLOT_UNKNOWN, f"{station_name} 不存在槽位 {station_slot_id}")
        if robot_slot_id not in robot.hands:
            return _issue(move, ValidationErrorCode.ROBOT_SLOT_DISABLED, f"{robot.name} 未启用手槽 {robot_slot_id}")
        material = robot.hands.get(robot_slot_id)
        if material is None or not _material_matches(material, material_id):
            return _issue(move, ValidationErrorCode.ROBOT_HAND_STATE_INVALID, f"{robot.name}#{robot_slot_id} 没有匹配物料")
        if slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
            return _issue(move, ValidationErrorCode.PLACE_TARGET_INVALID, f"{station_name}#{station_slot_id} 不是可放片空槽")
        if not _available(slot.busy_until, start_time):
            return _issue(move, ValidationErrorCode.STATION_SLOT_BUSY, f"{station_name}#{station_slot_id} 正在{slot.busy_action}")
        transfers.append((station, slot, station_slot_id, robot_slot_id, _material_with_metadata(material, move, index)))
    alignment_error = _robot_alignment_issue(robot, move, [(row[0], row[1], row[2]) for row in rows])
    if alignment_error:
        return alignment_error
    robot.busy_until = end_time
    for station in {row[0].name: row[0] for row in transfers}.values():
        station.transfer_busy_until = end_time
    for _, slot, _, _, _ in transfers:
        _reserve_slot(slot, end_time, "放片")

    def complete() -> None:
        """在 Place 完成时一次性把全部晶圆放入目标槽位，并落地槽位级指向。"""
        for station, slot, station_slot_id, robot_slot_id, material in transfers:
            phase = (
                SlotPhase.COMPLETED
                if station.completes_material_on_place
                else SlotPhase.UNPROCESSED
            )
            _set_slot(slot, phase, material)
            robot.hands[robot_slot_id] = None
            robot.slot_targets[robot_slot_id] = (station.name, station_slot_id)
        robot.position = _robot_derived_position(robot)

    _schedule(scheduled, move, end_time, complete)
    return None
def _start_pretrans(state: MachineState, move: Mapping[str, Any], end_time: float, all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验机器人转位；兼容以未来晶圆 ID 标注的 Pick 前空载转位。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    sources = [str(value) for value in _values(move, "SrcStationList") if value]
    destination = _first_text(move, "DestStationList")
    if not destination:
        return _issue(move, ValidationErrorCode.PRETRANS_STATE_INVALID, "转位缺少 DestStationList")
    if not _available(robot.busy_until, _start_time(move)):
        return _issue(move, ValidationErrorCode.ROBOT_BUSY, f"{robot.name} 正在执行其他动作")
    source_error = _pretrans_source_issue(robot, move)
    if source_error:
        return source_error
    for station_name in (*sources, destination):
        if station_name and robot.scope and station_name not in robot.scope:
            return _issue(move, ValidationErrorCode.ROBOT_UNREACHABLE, f"{robot.name} 无法访问 {station_name}")
    robot_slots = _integer_values(move, "RobotSlotList")
    material_ids = _values(move, "MatIDList")
    if material_ids and len(robot_slots) != len(material_ids):
        return _issue(move, ValidationErrorCode.PARALLEL_ARRAY_INVALID, "MatIDList 与 RobotSlotList 数量不一致")
    for index, material_id in enumerate(material_ids):
        material = robot.hands.get(robot_slots[index])
        if material is None and _pretrans_is_linked_empty_pick(
            move,
            all_moves,
            index,
            robot_slots[index],
            material_id,
        ):
            continue
        if not _material_matches(material, material_id):
            return _issue(move, ValidationErrorCode.ROBOT_HAND_STATE_INVALID, f"{robot.name}#{robot_slots[index]} 持有物料与 Move 不匹配")
    robot.busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: _apply_pretrans_landing(robot, move))
    return None


def _pretrans_is_linked_empty_pick(
    pretrans: Mapping[str, Any],
    all_moves: Sequence[Mapping[str, Any]],
    index: int,
    robot_slot_id: int,
    material_id: Any,
) -> bool:
    """判断带物料标注的 PreTrans 是否是同片后继 Pick 的空载前置转位。"""
    pretrans_id = pretrans.get("MoveID")
    robot_name = str(pretrans.get("Robot") or pretrans.get("ModuleName") or "")
    destinations = [str(value) for value in _values(pretrans, "DestStationList")]
    destination_slots = _integer_values(pretrans, "DestSlotList")
    if pretrans_id is None or not robot_name or not destinations:
        return False
    destination = destinations[index] if index < len(destinations) else destinations[0]
    destination_slot = (
        destination_slots[index]
        if index < len(destination_slots)
        else destination_slots[0] if len(destination_slots) == 1 else None
    )
    pretrans_end = _number(pretrans.get("EndTime"))
    if pretrans_end is None:
        return False

    for candidate in all_moves:
        if candidate.get("MoveType") != PICK_MOVE:
            continue
        if str(candidate.get("Robot") or candidate.get("ModuleName") or "") != robot_name:
            continue
        if not any(str(value) == str(pretrans_id) for value in _values(candidate, "PreMoveID")):
            continue
        candidate_start = _number(candidate.get("StartTime"))
        if candidate_start is None or candidate_start + TIME_TOLERANCE < pretrans_end:
            continue
        rows = _transport_rows(
            candidate,
            "SrcStationList",
            "SrcSlotList",
            "RobotSlotList",
            "MatIDList",
        )
        if isinstance(rows, str):
            continue
        for station_name, station_slot_id, candidate_robot_slot, candidate_material_id, _ in rows:
            if (
                station_name == destination
                and candidate_robot_slot == robot_slot_id
                and str(candidate_material_id) == str(material_id)
                and (destination_slot is None or station_slot_id == destination_slot)
            ):
                return True
    return False


def _start_prepare(state: MachineState, move: Mapping[str, Any], end_time: float, all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验开门动作及 LoadLock 当前压力态；重复开门按幂等动作处理。"""
    alignment = _parallel_arrays_alignment_issue(move, ("MatIDList", "StepIDList", "SlotList"))
    if alignment:
        return alignment
    station_name = _station_name(move)
    station = state.stations.get(station_name)
    if station is None:
        return _issue(move, ValidationErrorCode.STATION_UNKNOWN, f"未知站点 {station_name or '<empty>'}")
    start_time = _start_time(move)
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, ValidationErrorCode.STATION_TRANSFER_BUSY, f"{station.name} 门机构或取放资源正在忙")
    if not _available(station.environment_busy_until, start_time):
        return _issue(move, ValidationErrorCode.STATION_ENVIRONMENT_BUSY, f"{station.name} 正在切换环境")
    if _has_active_process(station, start_time):
        return _issue(move, ValidationErrorCode.STATION_PROCESS_BUSY, f"{station.name} 存在尚未完成的加工或清洁")
    if isinstance(station, LoadLockState):
        related = _related_move(move, all_moves)
        expected = _required_environment(state, station, move, related)
        if expected is not None and station.environment != expected:
            return _issue(
                move,
                ValidationErrorCode.LOADLOCK_ENVIRONMENT_INVALID,
                f"{station.name}.CurState为{_environment_label(station, expected)}，不是{_environment_label(station, station.environment)}",
            )
        station.last_environment_transition_was_empty = False
    station.door_busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: setattr(station, "door", DoorState.OPEN))
    return None


def _start_complete(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验关门动作并登记完成状态；重复关门按幂等动作处理。"""
    alignment = _parallel_arrays_alignment_issue(move, ("MatIDList", "StepIDList", "SlotList"))
    if alignment:
        return alignment
    station_name = _station_name(move)
    station = state.stations.get(station_name)
    if station is None:
        return _issue(move, ValidationErrorCode.STATION_UNKNOWN, f"未知站点 {station_name or '<empty>'}")
    start_time = _start_time(move)
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, ValidationErrorCode.STATION_TRANSFER_BUSY, f"{station.name} 门机构或取放资源正在忙")
    station.door_busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: setattr(station, "door", DoorState.CLOSED))
    return None


def _start_process(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验多槽同步加工或无片清洁，并在结束时更新全部槽位。"""
    station_name = _station_name(move)
    material_ids = _values(move, "MatIDList")
    slot_ids = _integer_values(move, "SlotList")
    if not station_name and not slot_ids:
        # 旧版协议可能只用 ProcessMove 和 MatIDList 表示不带资源明细的时间窗。
        _schedule(scheduled, move, end_time, lambda: None)
        return None
    station = state.stations.get(station_name)
    if station is None:
        return _issue(move, ValidationErrorCode.STATION_UNKNOWN, f"未知站点 {station_name or '<empty>'}")
    start_time = _start_time(move)
    clean_task_name = str(move.get("CleanTaskName") or "").strip()
    matched_clean_obligations = [
        ((pjob_name, required_station, task_name), requirement)
        for (pjob_name, required_station, task_name), requirement in state.clean_obligations.items()
        if required_station == station_name
        and task_name == clean_task_name
        and (not _values(move, "PJobName") or pjob_name in {str(value) for value in _values(move, "PJobName")})
    ]
    clean_material_count = max(
        (requirement[1] for _key, requirement in matched_clean_obligations),
        default=0,
    )
    clean_type = (
        _clean_validation_type(clean_task_name, material_count=clean_material_count)
        if clean_task_name
        else ""
    )
    recipe_name = str(
        move.get("ProcessRecipe") or move.get("CleanRecipe") or ""
    ).strip()
    if clean_type in {"dummy", "dummywac"}:
        if material_ids:
            wrong_main_recipe = next((
                requirement[2][0]
                for _key, requirement in matched_clean_obligations
                if requirement[2] and recipe_name != requirement[2][0]
            ), None)
            if wrong_main_recipe is not None:
                return _issue(
                    move,
                    ValidationErrorCode.CLEAN_RECIPE_INVALID,
                    f"{clean_task_name} 带片阶段 Recipe={recipe_name or '<empty>'}，期望 {wrong_main_recipe}",
                )
        else:
            valid_empty_tail = clean_type == "dummywac" and any(
                len(requirement[2]) >= 2
                and recipe_name == requirement[2][-1]
                and state.completed_clean_counts.get(clean_key, 0) >= requirement[1]
                for clean_key, requirement in matched_clean_obligations
            )
            if not valid_empty_tail:
                return _issue(
                    move,
                    ValidationErrorCode.PROCESS_STATE_INVALID,
                    f"{clean_task_name} 必须先完成足量 Dummy 带片清洁",
                )
    if clean_type in {"preclean", "postclean", "wacclean"} and material_ids:
        return _issue(
            move,
            ValidationErrorCode.PROCESS_STATE_INVALID,
            f"{clean_task_name} 是空腔 Clean，不能携带物料",
        )
    clean_issue = _validate_clean_start(state, station, move, material_ids, clean_task_name)
    if clean_issue:
        return clean_issue
    if station.door is not DoorState.CLOSED:
        return _issue(move, ValidationErrorCode.STATION_DOOR_STATE_INVALID, f"{station.name} 加工或清洁时必须关门")
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, ValidationErrorCode.STATION_TRANSFER_BUSY, f"{station.name} 正在执行开关门或取放动作")
    if material_ids and len(slot_ids) != len(material_ids):
        return _issue(move, ValidationErrorCode.PARALLEL_ARRAY_INVALID, "MatIDList 与 SlotList 数量不一致")
    if not slot_ids:
        # 兼容只声明腔室占用窗口的旧版 ProcessMove；没有物料和槽位时无法产生
        # 逐槽状态变化，但仍可验证门与共享资源，供跨代计划保留该物理时间窗。
        if material_ids:
            return _issue(move, ValidationErrorCode.PROCESS_STATE_INVALID, "加工动作携带物料时必须提供 SlotList")
        _schedule(scheduled, move, end_time, lambda: None)
        return None
    if len(set(slot_ids)) != len(slot_ids):
        return _issue(move, ValidationErrorCode.DUPLICATE_RESOURCE_REFERENCE, "加工或清洁不能重复引用同一槽位")
    targets: List[Tuple[SlotState, Optional[MaterialState], int]] = []
    for index, slot_id in enumerate(slot_ids):
        slot = station.slots.get(slot_id)
        if slot is None:
            return _issue(move, ValidationErrorCode.STATION_SLOT_UNKNOWN, f"{station.name} 不存在槽位 {slot_id}")
        if not _available(slot.busy_until, start_time):
            return _issue(move, ValidationErrorCode.STATION_SLOT_BUSY, f"{station.name}#{slot_id} 正在{slot.busy_action}")
        material_id = material_ids[index] if material_ids else None
        if material_id is None:
            if slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
                return _issue(move, ValidationErrorCode.PROCESS_STATE_INVALID, f"{station.name}#{slot_id} 有物料，不能执行无片清洁")
            material = None
        else:
            if slot.phase is not SlotPhase.UNPROCESSED or not _material_matches(slot.material, material_id):
                return _issue(move, ValidationErrorCode.PROCESS_STATE_INVALID, f"{station.name}#{slot_id} 没有待加工的匹配物料")
            material = slot.material
        targets.append((slot, material, slot_id))
    for slot, material, _ in targets:
        _reserve_slot(slot, end_time, "清洁" if material is None else "加工")

    def complete() -> None:
        """同时完成槽位，并按 ProcessRecipe.Weight 累计站点状态变量。"""
        for slot, material, _ in targets:
            _set_slot(slot, SlotPhase.CLEANED if material is None else SlotPhase.COMPLETED, material)
            if material is not None:
                slot.material_process_count += 1
                pjob_name = str(material.pjob_name or "").strip()
                if pjob_name:
                    state.product_clean_entries.add((pjob_name, station.name))
        recipe_name = str(
            move.get("ProcessRecipe")
            or move.get("RecipeName")
            or move.get("CleanRecipe")
            or ""
        )
        for variable_name, increment in state.process_recipe_weights.get(
            (station.name, recipe_name),
            {},
        ).items():
            station.state_variables[variable_name] = (
                station.state_variables.get(variable_name, 0.0) + increment
            )
        clean_task_name = str(move.get("CleanTaskName") or "")
        if clean_task_name:
            for pjob_name in _values(move, "PJobName"):
                clean_key = (str(pjob_name).strip(), station.name, clean_task_name)
                obligation = state.clean_obligations.get(clean_key)
                if not clean_key[0] or obligation is None:
                    continue
                _phase, required_count, _recipes = obligation
                increment = (
                    len(material_ids)
                    if required_count > 0
                    else int(move.get("IsLastCleanTaskMove") is True)
                )
                if increment:
                    state.completed_clean_counts[clean_key] = (
                        state.completed_clean_counts.get(clean_key, 0) + increment
                    )
        if clean_task_name and move.get("IsLastCleanTaskMove") is True:
            for variable_name in state.clean_task_state_variables.get(
                clean_task_name,
                set(),
            ):
                station.state_variables[variable_name] = 0.0

    _schedule(scheduled, move, end_time, complete)
    return None
def _start_align(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验合法 AlignMove，并在完成时把待对准物料标记为可取。

    Align 是站点服务动作：物料在动作前后仍位于同一 Route Step，平台只检查
    站点、槽位、物料和占用窗口，不修改位置或 StepID；对准结束会把 Place
    产生的 ``UNPROCESSED`` 槽位推进为 ``COMPLETED``，供后续 Pick 校验。
    """
    alignment = _parallel_arrays_alignment_issue(
        move,
        ("MatIDList", "StepIDList", "SlotList"),
    )
    if alignment:
        return alignment
    station_name = _station_name(move)
    station = state.stations.get(station_name)
    if station is None:
        return _issue(
            move,
            ValidationErrorCode.STATION_UNKNOWN,
            f"未知站点 {station_name or '<empty>'}",
        )
    start_time = _start_time(move)
    if station.door is not DoorState.CLOSED:
        return _issue(
            move,
            ValidationErrorCode.STATION_DOOR_STATE_INVALID,
            f"{station.name} 对准时必须关门",
        )
    if not _available(station.door_busy_until, start_time) or not _available(
        station.transfer_busy_until,
        start_time,
    ):
        return _issue(
            move,
            ValidationErrorCode.STATION_TRANSFER_BUSY,
            f"{station.name} 正在执行开关门或取放动作",
        )
    if _has_active_process(station, start_time):
        return _issue(
            move,
            ValidationErrorCode.STATION_PROCESS_BUSY,
            f"{station.name} 正在执行其他站点服务",
        )

    material_ids = _values(move, "MatIDList")
    slot_ids = _integer_values(move, "SlotList")
    if material_ids and not slot_ids:
        slot_ids = [
            slot_id
            for material_id in material_ids
            for slot_id, slot in station.slots.items()
            if _material_matches(slot.material, material_id)
        ]
    if material_ids and len(slot_ids) != len(material_ids):
        return _issue(
            move,
            ValidationErrorCode.PARALLEL_ARRAY_INVALID,
            "AlignMove 的 MatIDList 与 SlotList 数量不一致",
        )
    if not material_ids and not slot_ids:
        # 无片对准仍占用整台 Aligner；按全部物理槽位登记服务窗口。
        slot_ids = sorted(station.slots)

    targets: List[SlotState] = []
    for index, slot_id in enumerate(slot_ids):
        slot = station.slots.get(slot_id)
        if slot is None:
            return _issue(
                move,
                ValidationErrorCode.STATION_SLOT_UNKNOWN,
                f"{station.name} 不存在槽位 {slot_id}",
            )
        if not _available(slot.busy_until, start_time):
            return _issue(
                move,
                ValidationErrorCode.STATION_SLOT_BUSY,
                f"{station.name}#{slot_id} 正在{slot.busy_action}",
            )
        if material_ids and not _material_matches(slot.material, material_ids[index]):
            return _issue(
                move,
                ValidationErrorCode.PROCESS_STATE_INVALID,
                f"{station.name}#{slot_id} 没有待对准的匹配物料",
            )
        targets.append(slot)
    for slot in targets:
        _reserve_slot(slot, end_time, "对准")

    def complete() -> None:
        """结束对准占用并完成待对准物料，但保持物料 Route Step。"""
        for slot in targets:
            if slot.material is not None and slot.phase is SlotPhase.UNPROCESSED:
                _set_slot(slot, SlotPhase.COMPLETED, slot.material)
            else:
                slot.busy_action = ""

    _schedule(scheduled, move, end_time, complete)
    return None


def _start_preprepare(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验 LoadLock 压力切换；满载到声明容量也属于物理合法状态。"""
    station_name = _station_name(move)
    station = state.stations.get(station_name)
    if not isinstance(station, LoadLockState):
        return _issue(move, ValidationErrorCode.LOADLOCK_REQUIRED, f"{station_name or '<empty>'} 不是 LoadLock，不能切换环境")
    start_time = _start_time(move)
    if station.door is not DoorState.CLOSED:
        return _issue(move, ValidationErrorCode.STATION_DOOR_STATE_INVALID, f"{station.name} 切换环境时必须关门")
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, ValidationErrorCode.STATION_TRANSFER_BUSY, f"{station.name} 正在开关门或取放物料")
    if not _available(station.environment_busy_until, start_time):
        return _issue(move, ValidationErrorCode.STATION_ENVIRONMENT_BUSY, f"{station.name} 正在切换环境")
    last_state = _environment_state(station, move.get("LastState"))
    current_state = _environment_state(station, move.get("CurState"))
    raw_last = str(move.get("LastState") or "").strip().upper()
    raw_current = str(move.get("CurState") or "").strip().upper()
    # 严格状态空间：配置了 PrePrepareTime 时，LastState/CurState 原始标签必须在该 LoadLock 声明内。
    state_space_violation = bool(
        station.environment_state_space
        and (
            raw_last not in station.environment_state_space
            or raw_current not in station.environment_state_space
        )
    )
    violation: Optional[str] = None
    if state_space_violation:
        violation = _issue(
            move,
            ValidationErrorCode.LOADLOCK_ENVIRONMENT_INVALID,
            f"{station.name} 的 LastState/CurState 不在其 PrePrepareTime 状态空间内：({raw_last}, {raw_current})",
        )
    elif last_state not in {ATMOSPHERE, VACUUM} or current_state not in {ATMOSPHERE, VACUUM}:
        violation = _issue(move, ValidationErrorCode.LOADLOCK_ENVIRONMENT_INVALID, "LastState 和 CurState 必须是有效压力态")
    elif station.environment != last_state:
        violation = _issue(
            move,
            ValidationErrorCode.LOADLOCK_ENVIRONMENT_INVALID,
            f"{station.name}.CurState为{_environment_label(station, last_state)}，不是{_environment_label(station, station.environment)}",
        )
    if violation is not None:
        if not station.environment_exemption_used:
            # 豁免：每个 LoadLock 仅放行首条环境不匹配的切换——无论 LastState/CurState
            # 越出 PrePrepareTime 状态空间，还是 LastState 与 LoadLock 当前压力态不符——
            # 但照常执行该 move，把 LoadLock 状态更新为对应的 CurState；后续违例照常报错。
            station.environment_exemption_used = True
            # CurState 必须可解析为标准压力态才能安全落地环境；陌生标签不豁免。
            if current_state in {ATMOSPHERE, VACUUM}:
                violation = None
        if violation is not None:
            return violation
    material_ids = _values(move, "MatIDList")
    slot_ids = _integer_values(move, "SlotList")
    if material_ids and slot_ids and len(material_ids) != len(slot_ids):
        return _issue(move, ValidationErrorCode.PARALLEL_ARRAY_INVALID, "MatIDList 与 SlotList 数量不一致")
    if material_ids and not slot_ids:
        inferred_slots = []
        for material_id in material_ids:
            inferred = next((slot_id for slot_id, slot in station.slots.items() if _material_matches(slot.material, material_id)), None)
            if inferred is None:
                return _issue(move, ValidationErrorCode.LOADLOCK_CONTENT_INVALID, f"{station.name} 中找不到物料 {material_id}")
            inferred_slots.append(inferred)
        slot_ids = inferred_slots
    targets = [station.slots[slot_id] for slot_id in slot_ids if slot_id in station.slots]
    if len(targets) != len(slot_ids):
        return _issue(move, ValidationErrorCode.LOADLOCK_CONTENT_INVALID, f"{station.name} 的 SlotList 包含无效槽位")
    for index, slot in enumerate(targets):
        material_id = material_ids[index] if material_ids else None
        if material_id is not None and not _material_matches(slot.material, material_id):
            return _issue(move, ValidationErrorCode.LOADLOCK_CONTENT_INVALID, f"{station.name}#{slot_ids[index]} 没有匹配物料")
        if not _available(slot.busy_until, start_time):
            return _issue(move, ValidationErrorCode.STATION_SLOT_BUSY, f"{station.name}#{slot_ids[index]} 正在{slot.busy_action}")
        _reserve_slot(slot, end_time, "抽充气")
    station.environment_busy_until = end_time

    def complete() -> None:
        """压力切换作用于整个 LoadLock，并完成其中所有待转换晶圆。"""
        station.environment = current_state
        station.last_environment_transition_was_empty = not any(slot.material for slot in station.slots.values())
        for slot in station.slots.values():
            if slot.material is not None and slot.phase is SlotPhase.UNPROCESSED:
                _set_slot(slot, SlotPhase.COMPLETED, slot.material)

    _schedule(scheduled, move, end_time, complete)
    return None


def _start_swap(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验同站或孪生 LoadLock 原子 Swap，并按站点逐组落地物料。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    stations = [str(value) for value in _values(move, "StationList")]
    if not stations:
        return _issue(move, ValidationErrorCode.SWAP_INPUT_INVALID, "SwapMove 缺少 StationList")
    distinct_station_names = set(stations)
    is_twin_load_lock_swap = (
        len(distinct_station_names) == 2
        and frozenset(name.upper() for name in distinct_station_names)
        in TWIN_LOAD_LOCK_PAIRS
    )
    if len(distinct_station_names) != 1 and not is_twin_load_lock_swap:
        return _issue(
            move,
            ValidationErrorCode.SWAP_INPUT_INVALID,
            "SwapMove 必须引用同一个站点或一组孪生 LoadLock（LA/LB、LC/LD）",
        )
    receive_materials = _values(move, "RecvMatList")
    send_materials = _values(move, "SendMatList")
    station_send_slots = _integer_values(move, "StnSendSlotList")
    station_receive_slots = _integer_values(move, "StnRecvSlotList")
    robot_receive_slots = _integer_values(move, "RecvSlotList")
    robot_send_slots = _integer_values(move, "SendSlotList")
    send_count = len(send_materials)
    recv_count = len(receive_materials)
    if not send_count and not recv_count:
        return _issue(move, ValidationErrorCode.SWAP_INPUT_INVALID, "SwapMove 必须声明至少一个 Send 或 Recv 晶圆")
    # Send 组：机器人送出晶圆进入腔室，站侧使用 StnRecvSlotList（进入槽位）。
    if len(robot_send_slots) != send_count or len(station_receive_slots) != send_count:
        lengths = (send_count, len(robot_send_slots), len(station_receive_slots))
        return _issue(move, ValidationErrorCode.SWAP_INPUT_INVALID, f"SwapMove 的 Send 组数组数量不一致：SendMatList={lengths[0]} SendSlotList={lengths[1]} StnRecvSlotList={lengths[2]}")
    # Recv 组：机器人拿回晶圆离开腔室，站侧使用 StnSendSlotList（离开槽位）。
    if len(robot_receive_slots) != recv_count or len(station_send_slots) != recv_count:
        lengths = (recv_count, len(robot_receive_slots), len(station_send_slots))
        return _issue(move, ValidationErrorCode.SWAP_INPUT_INVALID, f"SwapMove 的 Recv 组数组数量不一致：RecvMatList={lengths[0]} RecvSlotList={lengths[1]} StnSendSlotList={lengths[2]}")
    if is_twin_load_lock_swap:
        # 孪生 Swap 允许 Send/Recv 组不对称（如 LA 换入换出、LB 仅换入），
        # 组内第 i 项按下标对齐 StationList 的第 i 个站点，因此任一组数量
        # 都不能超过站点数。
        for group_name, group_count in (("Send", send_count), ("Recv", recv_count)):
            if group_count and group_count > len(stations):
                return _issue(
                    move,
                    ValidationErrorCode.SWAP_INPUT_INVALID,
                    f"孪生 LoadLock Swap 的 {group_name} 组数量不能超过 StationList",
                )
        for field_name, slot_ids in (
            ("StnRecvSlotList", station_receive_slots),
            ("StnSendSlotList", station_send_slots),
        ):
            if slot_ids and len(set(slot_ids)) != 1:
                return _issue(
                    move,
                    ValidationErrorCode.SWAP_INPUT_INVALID,
                    f"孪生 LoadLock Swap 的 {field_name} 必须使用同一层槽位",
                )
    start_time = _start_time(move)
    physical_stations: List[StationState] = []
    for station_name in stations:
        station = state.stations.get(station_name)
        if station is None:
            return _issue(move, ValidationErrorCode.STATION_UNKNOWN, f"未知站点 {station_name}")
        if is_twin_load_lock_swap and not isinstance(station, LoadLockState):
            return _issue(
                move,
                ValidationErrorCode.SWAP_INPUT_INVALID,
                f"孪生站点 {station_name} 不是 LoadLock",
            )
        error = _station_access_error(robot, station, start_time, move)
        if error:
            return error
        physical_stations.append(station)
    if not _available(robot.busy_until, start_time):
        return _issue(move, ValidationErrorCode.ROBOT_BUSY, f"{robot.name} 正在执行其他动作")
    send_stations = (
        physical_stations
        if is_twin_load_lock_swap
        else [physical_stations[0]] * send_count
    )
    recv_stations = (
        physical_stations
        if is_twin_load_lock_swap
        else [physical_stations[0]] * recv_count
    )
    send_rows = [
        (send_stations[i], send_materials[i], robot_send_slots[i], station_receive_slots[i], i)
        for i in range(send_count)
    ]
    recv_rows = [
        (recv_stations[j], receive_materials[j], robot_receive_slots[j], station_send_slots[j], j)
        for j in range(recv_count)
    ]
    send_robot_slots = {row[2] for row in send_rows}
    recv_robot_slots = {row[2] for row in recv_rows}
    if len(send_robot_slots) != send_count or len(recv_robot_slots) != recv_count:
        return _issue(move, ValidationErrorCode.SWAP_INPUT_INVALID, "SwapMove 的 Send/Recv 手槽不能重复")
    shared_robot_slots = send_robot_slots & recv_robot_slots
    swap_mode = int(move.get("SwapMode") or 0)
    place_first_shared_slots = {
        robot_slot_id
        for robot_slot_id in shared_robot_slots
        if swap_mode == 1
        and any(
            send_station.name == recv_station.name
            and len(send_station.slots) > 1
            and send_station_slot != recv_station_slot
            for send_station, _, send_slot, send_station_slot, _ in send_rows
            for recv_station, _, recv_slot, recv_station_slot, _ in recv_rows
            if send_slot == recv_slot == robot_slot_id
        )
    }
    if shared_robot_slots - place_first_shared_slots:
        return _issue(
            move,
            ValidationErrorCode.SWAP_INPUT_INVALID,
            "SwapMove 仅允许多槽目标腔室的 place-first 动作共用 Send/Recv 手槽",
        )
    if not place_first_shared_slots and (not robot.can_swap or len(robot.hands) < 2):
        return _issue(move, ValidationErrorCode.ROBOT_SWAP_UNSUPPORTED, f"{robot.name} 不支持双臂换片")
    for slot_id in send_robot_slots | recv_robot_slots:
        if slot_id not in robot.hands:
            return _issue(move, ValidationErrorCode.ROBOT_SLOT_DISABLED, f"{robot.name} 未启用手槽 {slot_id}")
    send_station_slots = {(row[0].name, row[3]) for row in send_rows}
    recv_station_slots = {(row[0].name, row[3]) for row in recv_rows}
    if len(send_station_slots) != send_count or len(recv_station_slots) != recv_count:
        return _issue(move, ValidationErrorCode.SWAP_INPUT_INVALID, "SwapMove 的站槽位不能重复使用")
    # Recv 组校验：站槽位有匹配的已完成物料、目标手槽为空。
    for station, material_id, robot_slot_id, station_slot_id, _ in recv_rows:
        slot = station.slots.get(station_slot_id)
        if slot is None:
            return _issue(move, ValidationErrorCode.STATION_SLOT_UNKNOWN, f"{station.name} 不存在槽位 {station_slot_id}")
        if slot.phase is not SlotPhase.COMPLETED or not _material_matches(slot.material, material_id):
            return _issue(move, ValidationErrorCode.SWAP_STATE_INVALID, f"{station.name}#{station_slot_id} 没有可换出的物料")
        if robot_slot_id not in place_first_shared_slots and robot.hands.get(robot_slot_id) is not None:
            return _issue(move, ValidationErrorCode.SWAP_STATE_INVALID, f"{robot.name}#{robot_slot_id} 不是空手")
        if not _available(slot.busy_until, start_time):
            return _issue(move, ValidationErrorCode.STATION_SLOT_BUSY, f"{station.name}#{station_slot_id} 正在{slot.busy_action}")
    # Send 组校验：手上有匹配物料；目标槽位可放（换片槽位由 Recv 组腾空，跳过空槽检查）。
    for station, material_id, robot_slot_id, station_slot_id, _ in send_rows:
        slot = station.slots.get(station_slot_id)
        if slot is None:
            return _issue(move, ValidationErrorCode.STATION_SLOT_UNKNOWN, f"{station.name} 不存在槽位 {station_slot_id}")
        material = robot.hands.get(robot_slot_id)
        if material is None or not _material_matches(material, material_id):
            return _issue(move, ValidationErrorCode.SWAP_STATE_INVALID, f"{robot.name}#{robot_slot_id} 没有可换入的物料")
        if (station.name, station_slot_id) not in recv_station_slots and slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
            return _issue(move, ValidationErrorCode.SWAP_STATE_INVALID, f"{station.name}#{station_slot_id} 不是可直接放片的空槽")
        if not _available(slot.busy_until, start_time):
            return _issue(move, ValidationErrorCode.STATION_SLOT_BUSY, f"{station.name}#{station_slot_id} 正在{slot.busy_action}")
    station_refs = [
        (row[0].name, row[3], row[2]) for row in send_rows
    ] + [
        (row[0].name, row[3], row[2]) for row in recv_rows
    ]
    alignment_error = _robot_alignment_issue(robot, move, station_refs)
    if alignment_error:
        return alignment_error
    robot.busy_until = end_time
    for station_item in {value.name: value for value in physical_stations}.values():
        station_item.transfer_busy_until = end_time
    for station, _, _, station_slot_id, _ in recv_rows:
        _reserve_slot(station.slots[station_slot_id], end_time, "换片")
    for station, _, _, station_slot_id, _ in send_rows:
        _reserve_slot(station.slots[station_slot_id], end_time, "换片")

    received_materials = [
        station.slots[station_slot_id].material
        for station, _, _, station_slot_id, _ in recv_rows
    ]
    sent_materials = [
        robot.hands[robot_slot_id]
        for _, _, robot_slot_id, _, _ in send_rows
    ]

    def complete() -> None:
        """同时落地 Swap 中所有进出晶圆，并落地槽位级指向。

        开始时已分别保存进出物料，因此统一按 Send 后 Recv 落地；这既兼容
        普通双臂换片，也支持 place-first 共用手槽。纯 Recv 槽位最后清空。
        """
        for row_index, (station, _, robot_slot_id, station_slot_id, index) in enumerate(send_rows):
            _set_slot(station.slots[station_slot_id], SlotPhase.UNPROCESSED, _material_with_metadata(sent_materials[row_index], move, index, "SendMatStepIDList"))
            robot.hands[robot_slot_id] = None
            robot.slot_targets[robot_slot_id] = (station.name, station_slot_id)
        for row_index, (station, _, robot_slot_id, station_slot_id, index) in enumerate(recv_rows):
            robot.hands[robot_slot_id] = _material_with_metadata(received_materials[row_index], move, index, "RecvMatStepIDList")
            robot.slot_targets[robot_slot_id] = (station.name, station_slot_id)
        for station, _, _, station_slot_id, _ in recv_rows:
            if (station.name, station_slot_id) not in send_station_slots:
                _set_slot(station.slots[station_slot_id], SlotPhase.EMPTY, None)
        robot.position = _robot_derived_position(robot)

    _schedule(scheduled, move, end_time, complete)
    return None
