"""平台侧 MoveList 物理状态记录与校验。

本模块属于调度平台，不依赖算法仓库的 ``src.validation``。它只检查设备在物理上
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
PLACE_MOVE = 1
SWAP_MOVE = 4
PRE_TRANS_MOVE = 5
PREPARE_MOVE = 6
COMPLETE_MOVE = 7
PROCESS_MOVE = 9
PRE_PREPARE_MOVE = 10
ATMOSPHERE = "ATM"
VACUUM = "VAC"
LOAD_LOCK_TYPE = "loadlock"
LOAD_PORT_TYPE = "loadport"
DOORLESS_STATION_NAMES = frozenset({"Cooler", "Cool"})


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
    """记录一个物理槽位的物料与占用窗口。"""

    phase: SlotPhase = SlotPhase.EMPTY
    material: Optional[MaterialState] = None
    busy_until: float = 0.0
    busy_action: str = ""


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

    @property
    def is_load_lock(self) -> bool:
        """返回站点是否为 LoadLock。"""
        return self.station_type.lower() == LOAD_LOCK_TYPE


@dataclass
class LoadLockState(StationState):
    """记录 LoadLock 的压力态和设备标签映射。"""

    environment: str = ATMOSPHERE
    last_environment_transition_was_empty: bool = False
    environment_aliases: Dict[str, str] = field(default_factory=dict)


@dataclass
class RobotState:
    """记录机器人全部手槽、可达范围、指向与占用窗口。"""

    name: str
    hands: Dict[int, Optional[MaterialState]] = field(default_factory=dict)
    scope: Set[str] = field(default_factory=set)
    position: Optional[str] = None
    busy_until: float = 0.0
    can_swap: bool = False

    def swap_slot_error(self, receive_slot: int, send_slot: int) -> Optional[str]:
        """校验原子换片使用的两个机器人手槽。"""
        if not self.can_swap or len(self.hands) < 2:
            return f"{self.name} 不支持双臂换片"
        if receive_slot == send_slot:
            return f"{self.name} 换片的接收手槽和发送手槽必须不同"
        if receive_slot not in self.hands:
            return f"{self.name} 未启用手槽 {receive_slot}"
        if send_slot not in self.hands:
            return f"{self.name} 未启用手槽 {send_slot}"
        return None


@dataclass
class MachineState:
    """平台回放期间的独立整机物理快照。"""

    stations: Dict[str, StationState] = field(default_factory=dict)
    robots: Dict[str, RobotState] = field(default_factory=dict)
    robot_aliases: Dict[str, str] = field(default_factory=dict)

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

        for name, config in station_configs.items():
            task_station = task_stations.get(name)
            station_type = str(config.get("Type") or getattr(task_station, "type", ""))
            slots = {slot_id: SlotState() for slot_id in _station_slot_ids(config, task_station)}
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
                )
            else:
                state.stations[name] = StationState(name, station_type, slots)

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

        for station_name, slot_id, material in _initial_materials(task, payload):
            station = state.ensure_station(station_name, slot_id)
            if station.slots[slot_id].material is not None:
                raise ValueError(f"初始物料在 {station_name}#{slot_id} 发生冲突")
            station.slots[slot_id] = SlotState(SlotPhase.COMPLETED, material)
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


def validate_move_list(
    task: Any,
    moves: List[dict],
    init_data: "Optional[Mapping[str, Any] | MachineState]" = None,
    *,
    check_residency: bool = False,
) -> List[str]:
    """按时间线校验 MoveList；仅返回首个物理状态违例。"""
    del check_residency  # 驻留上限是策略约束，不属于平台物理可执行性边界。
    try:
        state = MachineState.from_sources(task, init_data)
    except ValueError as error:
        return [str(error)]
    scheduled: List[_ScheduledCompletion] = []
    ordered_moves = sorted(moves, key=_sort_key)
    _supplement_state_from_moves(state, ordered_moves)
    for move in ordered_moves:
        start_time = _number(move.get("StartTime"))
        end_time = _number(move.get("EndTime"))
        if start_time is None or end_time is None:
            return [_issue(move, "StartTime 和 EndTime 必须是有限数字")]
        if end_time + TIME_TOLERANCE < start_time:
            return [_issue(move, "EndTime 不能早于 StartTime")]
        _finish_until(scheduled, start_time)
        error = _start_move(state, move, end_time, ordered_moves, scheduled)
        if error:
            return [error]
    _finish_until(scheduled, float("inf"))
    return []


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
    }
    handler = handlers.get(move.get("MoveType"))
    if handler is None:
        return _issue(move, f"不支持 MoveType={move.get('MoveType')}")
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
    station_names = {row[0] for row in rows}
    if len(station_names) != 1:
        return _issue(move, "一次 PickMove 只能访问一个站点")
    start_time = _start_time(move)
    if not _available(robot.busy_until, start_time):
        return _issue(move, f"{robot.name} 正在执行其他动作")
    transfers: List[Tuple[StationState, SlotState, int, int, MaterialState]] = []
    for station_name, station_slot_id, robot_slot_id, material_id, index in rows:
        station = state.stations.get(station_name)
        if station is None:
            return _issue(move, f"未知站点 {station_name}")
        error = _station_access_error(robot, station, start_time, move)
        if error:
            return error
        slot = station.slots.get(station_slot_id)
        if slot is None:
            return _issue(move, f"{station_name} 不存在槽位 {station_slot_id}")
        if robot_slot_id not in robot.hands:
            return _issue(move, f"{robot.name} 未启用手槽 {robot_slot_id}")
        if robot.hands[robot_slot_id] is not None:
            return _issue(move, f"{robot.name}#{robot_slot_id} 不是空手")
        if not _available(slot.busy_until, start_time):
            return _issue(move, f"{station_name}#{station_slot_id} 正在{slot.busy_action}")
        if slot.phase is not SlotPhase.COMPLETED or not _material_matches(slot.material, material_id):
            return _issue(move, f"{station_name}#{station_slot_id} 没有匹配的已完成物料")
        transfers.append((station, slot, station_slot_id, robot_slot_id, _material_with_metadata(slot.material, move, index)))
    station = transfers[0][0]
    if robot.position is not None and robot.position != station.name:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {station.name}")
    robot.busy_until = end_time
    station.transfer_busy_until = end_time
    for _, slot, _, _, _ in transfers:
        _reserve_slot(slot, end_time, "取片")

    def complete() -> None:
        """在 Pick 完成时一次性把全部晶圆移入对应手槽。"""
        for _, slot, _, robot_slot_id, material in transfers:
            _set_slot(slot, SlotPhase.EMPTY, None)
            robot.hands[robot_slot_id] = material
        robot.position = station.name

    _schedule(scheduled, move, end_time, complete)
    return None


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
    station_names = {row[0] for row in rows}
    if len(station_names) != 1:
        return _issue(move, "一次 PlaceMove 只能访问一个站点")
    start_time = _start_time(move)
    if not _available(robot.busy_until, start_time):
        return _issue(move, f"{robot.name} 正在执行其他动作")
    transfers: List[Tuple[StationState, SlotState, int, int, MaterialState]] = []
    for station_name, station_slot_id, robot_slot_id, material_id, index in rows:
        station = state.stations.get(station_name)
        if station is None:
            return _issue(move, f"未知站点 {station_name}")
        error = _station_access_error(robot, station, start_time, move)
        if error:
            return error
        slot = station.slots.get(station_slot_id)
        if slot is None:
            return _issue(move, f"{station_name} 不存在槽位 {station_slot_id}")
        if robot_slot_id not in robot.hands:
            return _issue(move, f"{robot.name} 未启用手槽 {robot_slot_id}")
        material = robot.hands.get(robot_slot_id)
        if material is None or not _material_matches(material, material_id):
            return _issue(move, f"{robot.name}#{robot_slot_id} 没有匹配物料")
        if slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
            return _issue(move, f"{station_name}#{station_slot_id} 不是可放片空槽")
        if not _available(slot.busy_until, start_time):
            return _issue(move, f"{station_name}#{station_slot_id} 正在{slot.busy_action}")
        transfers.append((station, slot, station_slot_id, robot_slot_id, _material_with_metadata(material, move, index)))
    station = transfers[0][0]
    if robot.position is not None and robot.position != station.name:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {station.name}")
    robot.busy_until = end_time
    station.transfer_busy_until = end_time
    for _, slot, _, _, _ in transfers:
        _reserve_slot(slot, end_time, "放片")

    def complete() -> None:
        """在 Place 完成时一次性把全部晶圆放入目标槽位。"""
        for _, slot, _, robot_slot_id, material in transfers:
            _set_slot(slot, SlotPhase.UNPROCESSED, material)
            robot.hands[robot_slot_id] = None
        robot.position = station.name

    _schedule(scheduled, move, end_time, complete)
    return None


def _start_pretrans(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验机器人转位；允许其多个已占用手槽共同随动。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    source = _first_text(move, "SrcStationList")
    destination = _first_text(move, "DestStationList")
    if not destination:
        return _issue(move, "转位缺少 DestStationList")
    if not _available(robot.busy_until, _start_time(move)):
        return _issue(move, f"{robot.name} 正在执行其他动作")
    if robot.position is not None and source and robot.position != source:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {source}")
    for station_name in (source, destination):
        if station_name and robot.scope and station_name not in robot.scope:
            return _issue(move, f"{robot.name} 无法访问 {station_name}")
    robot_slots = _integer_values(move, "RobotSlotList")
    material_ids = _values(move, "MatIDList")
    if material_ids and len(robot_slots) != len(material_ids):
        return _issue(move, "MatIDList 与 RobotSlotList 数量不一致")
    for index, material_id in enumerate(material_ids):
        material = robot.hands.get(robot_slots[index])
        if material is None or not _material_matches(material, material_id):
            return _issue(move, f"{robot.name}#{robot_slots[index]} 持有物料与 Move 不匹配")
    robot.busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: setattr(robot, "position", destination))
    return None


def _start_prepare(state: MachineState, move: Mapping[str, Any], end_time: float, all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验开门动作及 LoadLock 当前压力态。"""
    station_name = _station_name(move)
    station = state.stations.get(station_name)
    if station is None:
        return _issue(move, f"未知站点 {station_name or '<empty>'}")
    start_time = _start_time(move)
    if station.door is not DoorState.CLOSED:
        return _issue(move, f"{station.name} 当前不是关门状态")
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, f"{station.name} 门机构或取放资源正在忙")
    if not _available(station.environment_busy_until, start_time):
        return _issue(move, f"{station.name} 正在切换环境")
    if _has_active_process(station, start_time):
        return _issue(move, f"{station.name} 存在尚未完成的加工或清洁")
    if isinstance(station, LoadLockState):
        related = _related_move(move, all_moves)
        expected = _required_environment(state, station, move, related)
        if expected is not None and station.environment != expected:
            return _issue(move, f"{station.name} 当前环境为 {station.environment}，不是 {expected}")
        station.last_environment_transition_was_empty = False
    station.door_busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: setattr(station, "door", DoorState.OPEN))
    return None


def _start_complete(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验关门动作并登记关门完成状态。"""
    station_name = _station_name(move)
    station = state.stations.get(station_name)
    if station is None:
        return _issue(move, f"未知站点 {station_name or '<empty>'}")
    if not _is_doorless(station) and station.door is not DoorState.OPEN:
        return _issue(move, f"{station.name} 当前不是开门状态")
    start_time = _start_time(move)
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, f"{station.name} 门机构或取放资源正在忙")
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
        return _issue(move, f"未知站点 {station_name or '<empty>'}")
    start_time = _start_time(move)
    if station.door is not DoorState.CLOSED:
        return _issue(move, f"{station.name} 加工或清洁时必须关门")
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, f"{station.name} 正在执行开关门或取放动作")
    if material_ids and len(slot_ids) != len(material_ids):
        return _issue(move, "MatIDList 与 SlotList 数量不一致")
    if not slot_ids:
        # 兼容只声明腔室占用窗口的旧版 ProcessMove；没有物料和槽位时无法产生
        # 逐槽状态变化，但仍可验证门与共享资源，供跨代计划保留该物理时间窗。
        if material_ids:
            return _issue(move, "加工动作携带物料时必须提供 SlotList")
        _schedule(scheduled, move, end_time, lambda: None)
        return None
    if len(set(slot_ids)) != len(slot_ids):
        return _issue(move, "加工或清洁不能重复引用同一槽位")
    targets: List[Tuple[SlotState, Optional[MaterialState], int]] = []
    for index, slot_id in enumerate(slot_ids):
        slot = station.slots.get(slot_id)
        if slot is None:
            return _issue(move, f"{station.name} 不存在槽位 {slot_id}")
        if not _available(slot.busy_until, start_time):
            return _issue(move, f"{station.name}#{slot_id} 正在{slot.busy_action}")
        material_id = material_ids[index] if material_ids else None
        if material_id is None:
            if slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
                return _issue(move, f"{station.name}#{slot_id} 有物料，不能执行无片清洁")
            material = None
        else:
            if slot.phase is not SlotPhase.UNPROCESSED or not _material_matches(slot.material, material_id):
                return _issue(move, f"{station.name}#{slot_id} 没有待加工的匹配物料")
            material = slot.material
        targets.append((slot, material, slot_id))
    for slot, material, _ in targets:
        _reserve_slot(slot, end_time, "清洁" if material is None else "加工")

    def complete() -> None:
        """同时完成本动作引用的全部槽位。"""
        for slot, material, _ in targets:
            _set_slot(slot, SlotPhase.CLEANED if material is None else SlotPhase.COMPLETED, material)

    _schedule(scheduled, move, end_time, complete)
    return None


def _start_preprepare(state: MachineState, move: Mapping[str, Any], end_time: float, _all_moves: Sequence[Mapping[str, Any]], scheduled: List[_ScheduledCompletion]) -> Optional[str]:
    """校验 LoadLock 压力切换；满载到声明容量也属于物理合法状态。"""
    station_name = _station_name(move)
    station = state.stations.get(station_name)
    if not isinstance(station, LoadLockState):
        return _issue(move, f"{station_name or '<empty>'} 不是 LoadLock，不能切换环境")
    start_time = _start_time(move)
    if station.door is not DoorState.CLOSED:
        return _issue(move, f"{station.name} 切换环境时必须关门")
    if not _available(station.door_busy_until, start_time) or not _available(station.transfer_busy_until, start_time):
        return _issue(move, f"{station.name} 正在开关门或取放物料")
    if not _available(station.environment_busy_until, start_time):
        return _issue(move, f"{station.name} 正在切换环境")
    last_state = _environment_state(station, move.get("LastState"))
    current_state = _environment_state(station, move.get("CurState"))
    if last_state not in {ATMOSPHERE, VACUUM} or current_state not in {ATMOSPHERE, VACUUM}:
        return _issue(move, "LastState 和 CurState 必须是有效压力态")
    if station.environment != last_state:
        return _issue(move, f"{station.name} 当前环境为 {station.environment}，不是 {last_state}")
    material_ids = _values(move, "MatIDList")
    slot_ids = _integer_values(move, "SlotList")
    if material_ids and slot_ids and len(material_ids) != len(slot_ids):
        return _issue(move, "MatIDList 与 SlotList 数量不一致")
    if material_ids and not slot_ids:
        inferred_slots = []
        for material_id in material_ids:
            inferred = next((slot_id for slot_id, slot in station.slots.items() if _material_matches(slot.material, material_id)), None)
            if inferred is None:
                return _issue(move, f"{station.name} 中找不到物料 {material_id}")
            inferred_slots.append(inferred)
        slot_ids = inferred_slots
    targets = [station.slots[slot_id] for slot_id in slot_ids if slot_id in station.slots]
    if len(targets) != len(slot_ids):
        return _issue(move, f"{station.name} 的 SlotList 包含无效槽位")
    for index, slot in enumerate(targets):
        material_id = material_ids[index] if material_ids else None
        if material_id is not None and not _material_matches(slot.material, material_id):
            return _issue(move, f"{station.name}#{slot_ids[index]} 没有匹配物料")
        if not _available(slot.busy_until, start_time):
            return _issue(move, f"{station.name}#{slot_ids[index]} 正在{slot.busy_action}")
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
    """校验同站原子 Swap；单次动作可并行交换多组槽位。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    stations = [str(value) for value in _values(move, "StationList")]
    if not stations or len(set(stations)) != 1:
        return _issue(move, "SwapMove 必须引用同一个站点")
    station = state.stations.get(stations[0])
    if station is None:
        return _issue(move, f"未知站点 {stations[0]}")
    receive_materials = _values(move, "RecvMatList")
    send_materials = _values(move, "SendMatList")
    station_send_slots = _integer_values(move, "StnSendSlotList")
    station_receive_slots = _integer_values(move, "StnRecvSlotList")
    robot_receive_slots = _integer_values(move, "RecvSlotList")
    robot_send_slots = _integer_values(move, "SendSlotList")
    count = len(receive_materials)
    if not count or any(len(values) != count for values in (send_materials, station_send_slots, station_receive_slots, robot_receive_slots, robot_send_slots)):
        return _issue(move, "SwapMove 的物料与槽位数组数量不一致")
    start_time = _start_time(move)
    error = _station_access_error(robot, station, start_time, move)
    if error:
        return error
    if not _available(robot.busy_until, start_time):
        return _issue(move, f"{robot.name} 正在执行其他动作")
    if robot.position is not None and robot.position != station.name:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {station.name}")
    exchanges = []
    for index in range(count):
        receive_robot_slot = robot_receive_slots[index]
        send_robot_slot = robot_send_slots[index]
        error = robot.swap_slot_error(receive_robot_slot, send_robot_slot)
        if error:
            return _issue(move, error)
        send_station_slot = station.slots.get(station_send_slots[index])
        receive_station_slot = station.slots.get(station_receive_slots[index])
        if send_station_slot is None or receive_station_slot is None:
            return _issue(move, f"{station.name} 的 SwapMove 引用了无效槽位")
        outgoing = send_station_slot.material
        incoming = robot.hands.get(send_robot_slot)
        if send_station_slot.phase is not SlotPhase.COMPLETED or not _material_matches(outgoing, receive_materials[index]):
            return _issue(move, f"{station.name}#{station_send_slots[index]} 没有可换出的物料")
        if robot.hands.get(receive_robot_slot) is not None:
            return _issue(move, f"{robot.name}#{receive_robot_slot} 不是空手")
        if incoming is None or not _material_matches(incoming, send_materials[index]):
            return _issue(move, f"{robot.name}#{send_robot_slot} 没有可换入的物料")
        if receive_station_slot is not send_station_slot and receive_station_slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
            return _issue(move, f"{station.name}#{station_receive_slots[index]} 不是可换入空槽")
        exchanges.append((send_station_slot, receive_station_slot, receive_robot_slot, send_robot_slot, outgoing, incoming, index))
    robot.busy_until = end_time
    station.transfer_busy_until = end_time
    for send_station_slot, receive_station_slot, *_ in exchanges:
        _reserve_slot(send_station_slot, end_time, "换片")
        if receive_station_slot is not send_station_slot:
            _reserve_slot(receive_station_slot, end_time, "换片")

    def complete() -> None:
        """同时落地 Swap 中所有进出晶圆。"""
        for send_station_slot, receive_station_slot, receive_robot_slot, send_robot_slot, outgoing, incoming, index in exchanges:
            _set_slot(receive_station_slot, SlotPhase.UNPROCESSED, _material_with_metadata(incoming, move, index, "SendMatStepIDList"))
            if receive_station_slot is not send_station_slot:
                _set_slot(send_station_slot, SlotPhase.EMPTY, None)
            robot.hands[send_robot_slot] = None
            robot.hands[receive_robot_slot] = _material_with_metadata(outgoing, move, index, "RecvMatStepIDList")
        robot.position = station.name

    _schedule(scheduled, move, end_time, complete)
    return None


def _transport_rows(move: Mapping[str, Any], station_key: str, station_slot_key: str, robot_slot_key: str, material_key: str) -> "List[Tuple[str, int, int, Any, int]] | str":
    """把并行运输字段规范为逐片行，并检查数组长度。"""
    materials = _values(move, material_key)
    stations = [str(value) for value in _values(move, station_key)]
    station_slots = _integer_values(move, station_slot_key)
    robot_slots = _integer_values(move, robot_slot_key)
    count = len(materials)
    if not count:
        return _issue(move, f"{material_key} 不能为空")
    if len(stations) == 1 and count > 1:
        stations *= count
    if any(len(values) != count for values in (stations, station_slots, robot_slots)):
        return _issue(move, f"{material_key} 与站点/槽位数组数量不一致")
    return [(stations[index], station_slots[index], robot_slots[index], materials[index], index) for index in range(count)]


def _validate_distinct_transport_rows(move: Mapping[str, Any], rows: Sequence[Tuple[str, int, int, Any, int]]) -> Optional[str]:
    """保证一个原子运输动作不会重复占用物理槽位或物料。"""
    station_refs = [(row[0], row[1]) for row in rows]
    robot_slots = [row[2] for row in rows]
    materials = [str(row[3]) for row in rows]
    if len(set(station_refs)) != len(station_refs):
        return _issue(move, "同一动作不能重复引用站点槽位")
    if len(set(robot_slots)) != len(robot_slots):
        return _issue(move, "同一动作不能重复引用机器人手槽")
    if len(set(materials)) != len(materials):
        return _issue(move, "同一动作不能重复引用物料")
    return None


def _station_access_error(robot: RobotState, station: StationState, start_time: float, move: Mapping[str, Any]) -> Optional[str]:
    """校验机器人可达性、腔门和站点共享取放资源。"""
    if robot.scope and station.name not in robot.scope:
        return _issue(move, f"{robot.name} 无法访问 {station.name}")
    if not _is_doorless(station) and station.door is not DoorState.OPEN:
        return _issue(move, f"{station.name} 门当前为关门")
    if not _available(station.transfer_busy_until, start_time):
        return _issue(move, f"{station.name} 正在执行取放动作")
    return None


def _related_move(move: Mapping[str, Any], moves: Sequence[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    """查找紧接开门动作、访问同一站点的运输动作。"""
    end_time = _number(move.get("EndTime"))
    station_name = _station_name(move)
    if end_time is None:
        return None
    for candidate in moves:
        if abs((_number(candidate.get("StartTime")) or float("inf")) - end_time) > TIME_TOLERANCE:
            continue
        move_type = candidate.get("MoveType")
        stations = (
            _values(candidate, "SrcStationList") if move_type == PICK_MOVE
            else _values(candidate, "DestStationList") if move_type == PLACE_MOVE
            else _values(candidate, "StationList") if move_type == SWAP_MOVE
            else []
        )
        if station_name in {str(value) for value in stations}:
            return candidate
    return None


def _required_environment(state: MachineState, station: LoadLockState, move: Mapping[str, Any], related: Optional[Mapping[str, Any]]) -> Optional[str]:
    """从关联机器人和协议枚举推导 LoadLock 开门侧。"""
    related_type = move.get("RelatedRobotType")
    if related_type == 0:
        return ATMOSPHERE
    if related_type == 1:
        return VACUUM
    if related is None:
        return None
    robot = state.resolve_robot(str(related.get("Robot") or related.get("ModuleName") or ""))
    if robot is None:
        return None
    configured = _environment_state(station, robot.name)
    if configured in {ATMOSPHERE, VACUUM}:
        return configured
    upper_name = robot.name.upper()
    if "ATM" in upper_name or "ATR" in upper_name:
        return ATMOSPHERE
    if "VAC" in upper_name or "VTR" in upper_name:
        return VACUUM
    return ATMOSPHERE if any(
        state.stations.get(name) and state.stations[name].station_type.lower() == LOAD_PORT_TYPE
        for name in robot.scope
    ) else VACUUM


def _initial_payload(init_data: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    """拆开标准接口的可选 Info/InitData 外壳。"""
    if not isinstance(init_data, Mapping):
        return {}
    value: Any = init_data
    if isinstance(value.get("Info"), Mapping):
        value = value["Info"]
    if isinstance(value.get("InitData"), Mapping):
        value = value["InitData"]
    return value


def _mapping(value: Any) -> Mapping[str, Mapping[str, Any]]:
    """把接口对象收敛为字符串键配置映射。"""
    if not isinstance(value, Mapping):
        return {}
    return {str(name): config for name, config in value.items() if isinstance(config, Mapping)}


def _station_slot_ids(config: Mapping[str, Any], task_station: Any) -> Set[int]:
    """从显式槽位或 Capacity 解析一基物理槽位。"""
    raw_slots = config.get("Slots")
    if isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
        slots = {_positive_integer(value) for value in raw_slots}
        slots.discard(None)
        if slots:
            return {int(value) for value in slots}
    capacity = _positive_integer(config.get("Capacity"))
    if capacity is None:
        capacity = _positive_integer(getattr(task_station, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    return set(range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID))


def _station_from_task(name: str, task_station: Any) -> StationState:
    """用解析任务补建标准 update 中缺失的站点。"""
    station_type = str(getattr(task_station, "type", ""))
    capacity = _positive_integer(getattr(task_station, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    slots = {slot_id: SlotState() for slot_id in range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID)}
    if station_type.lower() == LOAD_LOCK_TYPE:
        return LoadLockState(name, station_type, slots)
    return StationState(name, station_type, slots)


def _robot_from_config(name: str, config: Mapping[str, Any], task_robot: Any) -> RobotState:
    """保留 ArmInfo 中每个启用 Arm 的全部物理手槽。"""
    hands: Dict[int, Optional[MaterialState]] = {}
    scope: Set[str] = set()
    positions: Set[str] = set()
    for arm in _mapping(config.get("ArmInfo")).values():
        if arm.get("IsEnable") is False:
            continue
        for slot_id in arm.get("SlotIDs") or ():
            normalized = _positive_integer(slot_id)
            if normalized is not None:
                hands[normalized] = None
        scope.update(str(station) for station in arm.get("AccessibleStations") or () if station)
        if arm.get("SlotAtStation"):
            positions.add(str(arm["SlotAtStation"]))
    explicit_slots = _configured_robot_slots(config)
    configured_capacity = _positive_integer(config.get("Capacity")) or len(hands) or DEFAULT_SLOT_ID
    task_capacity = _positive_integer(getattr(task_robot, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    if explicit_slots is not None:
        hands = {slot_id: hands.get(slot_id) for slot_id in sorted(explicit_slots)}
        capacity = len(hands)
    else:
        capacity = max(configured_capacity, task_capacity)
        for slot_id in range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID):
            hands.setdefault(slot_id, None)
    scope.update(str(station) for station in getattr(task_robot, "scope", ()) or () if station)
    return RobotState(
        name=name,
        hands=hands,
        scope=scope,
        position=next(iter(positions)) if len(positions) == 1 else None,
        can_swap=(bool(config.get("CanMultiTrans")) or bool(getattr(task_robot, "can_swap", False)) or len(hands) >= 2) and len(hands) >= 2,
    )


def _configured_robot_slots(config: Mapping[str, Any]) -> Optional[Set[int]]:
    """读取运行快照显式限制的 Robot.Slot；字段缺失时返回 None。"""
    if "Slot" not in config:
        return None
    raw_slots = config.get("Slot")
    if isinstance(raw_slots, Mapping):
        candidates: Iterable[Any] = raw_slots.keys()
    elif isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
        candidates = raw_slots
    else:
        count = _positive_integer(raw_slots) or DEFAULT_SLOT_ID
        return set(range(DEFAULT_SLOT_ID, count + DEFAULT_SLOT_ID))
    slots = {_positive_integer(value) for value in candidates}
    slots.discard(None)
    return {int(value) for value in slots} or {DEFAULT_SLOT_ID}


def _robot_from_task(name: str, task_robot: Any) -> RobotState:
    """用解析任务补建标准 update 中缺失的机器人。"""
    capacity = _positive_integer(getattr(task_robot, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    return RobotState(
        name=name,
        hands={slot_id: None for slot_id in range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID)},
        scope={str(station) for station in getattr(task_robot, "scope", ()) or ()},
        can_swap=bool(getattr(task_robot, "can_swap", False)) and capacity >= 2,
    )


def _environment_aliases(config: Mapping[str, Any]) -> Dict[str, str]:
    """从 PrePrepareTime 建立设备标签与标准压力态映射。"""
    aliases: Dict[str, str] = {}
    transitions = config.get("PrePrepareTime")
    if not isinstance(transitions, Sequence) or isinstance(transitions, (str, bytes)):
        return aliases
    for transition in transitions:
        if not isinstance(transition, Mapping):
            continue
        transition_type = str(transition.get("PrePrepareType") or "").strip().lower()
        if transition_type.startswith("pump"):
            last_environment, current_environment = ATMOSPHERE, VACUUM
        elif transition_type.startswith("vent"):
            last_environment, current_environment = VACUUM, ATMOSPHERE
        else:
            continue
        for key, environment in (("LastItem", last_environment), ("CurrentItem", current_environment)):
            alias = str(transition.get(key) or "").strip().upper()
            if alias:
                aliases[alias] = environment
    return aliases


def _environment_from_last_item(last_item: str, aliases: Mapping[str, str]) -> str:
    """由最近访问侧推导 LoadLock 初始压力态。"""
    normalized = last_item.strip().upper()
    if aliases.get(normalized) in {ATMOSPHERE, VACUUM}:
        return aliases[normalized]
    return VACUUM if "VAC" in normalized or "VTR" in normalized else ATMOSPHERE


def _environment_state(station: LoadLockState, value: Any) -> str:
    """把标准值、机器人侧名称或设备标签统一成 ATM/VAC。"""
    raw = str(value or "").strip().upper()
    if raw in {ATMOSPHERE, "ATR", "ATMROBOT"}:
        return ATMOSPHERE
    if raw in {VACUUM, "VTR", "VACROBOT"}:
        return VACUUM
    return station.environment_aliases.get(raw, raw)


def _initial_materials(task: Any, payload: Mapping[str, Any]) -> Iterable[Tuple[str, int, MaterialState]]:
    """优先读取 update.Materials，否则从解析任务恢复首工序物料。"""
    materials = payload.get("Materials")
    if isinstance(materials, Sequence) and not isinstance(materials, (str, bytes)):
        loaded = [
            (
                str(entry.get("CurrentModuleName") or ""),
                _positive_integer(entry.get("SlotID")) or DEFAULT_SLOT_ID,
                MaterialState(entry.get("ID"), str(entry.get("PJobName") or ""), entry.get("StepID")),
            )
            for entry in materials
            if isinstance(entry, Mapping) and entry.get("CurrentModuleName") and entry.get("ID") is not None
        ]
        if loaded:
            return loaded
    return [
        (
            str(stages[0].chamber),
            int(getattr(stages[0], "slot", 0) or 0) + 1,
            MaterialState(getattr(wafer, "mat_id", None), str(getattr(wafer, "pjob_name", "") or ""), getattr(stages[0], "j", None)),
        )
        for wafer in getattr(task, "wafers", ()) or ()
        for stages in [list(getattr(wafer, "stages", ()) or ())]
        if stages and getattr(wafer, "mat_id", None) is not None and getattr(stages[0], "chamber", "")
    ]


def _values(move: Mapping[str, Any], key: str) -> List[Any]:
    """读取标准并行数组，并兼容物料单值字段。"""
    value = move.get(key)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return list(value)
    if key == "MatIDList":
        scalar = move.get("MatID", move.get("MaterialID"))
        return [] if scalar is None else [scalar]
    return [] if value is None else [value]


def _integer_values(move: Mapping[str, Any], key: str) -> List[int]:
    """读取动作中的正整数槽位数组。"""
    result = []
    for value in _values(move, key):
        normalized = _positive_integer(value)
        if normalized is not None:
            result.append(normalized)
    return result


def _positive_integer(value: Any) -> Optional[int]:
    """把正整数协议值规范为 int，非法值返回 None。"""
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= DEFAULT_SLOT_ID and float(value) == number else None


def _number(value: Any) -> Optional[float]:
    """读取有限数值，非法值返回 None。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _sort_key(move: Mapping[str, Any]) -> Tuple[float, int, float]:
    """生成 MoveList 的稳定时间排序键。"""
    return (
        _number(move.get("StartTime")) or 0.0,
        int(move.get("MoveID")) if isinstance(move.get("MoveID"), int) else 0,
        _number(move.get("EndTime")) or 0.0,
    )


def _notification_state(notification: Mapping[str, Any]) -> int:
    """把数字或字符串 MoveState 统一成协议枚举。"""
    raw = notification.get("MoveState", notification.get("State"))
    if isinstance(raw, int) and raw in {MoveStateReplay.RUNNING, MoveStateReplay.DONE, MoveStateReplay.ABORTED}:
        return raw
    names = {
        "running": MoveStateReplay.RUNNING,
        "start": MoveStateReplay.RUNNING,
        "done": MoveStateReplay.DONE,
        "finished": MoveStateReplay.DONE,
        "end": MoveStateReplay.DONE,
        "aborted": MoveStateReplay.ABORTED,
        "abort": MoveStateReplay.ABORTED,
    }
    normalized = str(raw or "").strip().lower()
    if normalized not in names:
        raise ValueError(f"不支持 MoveState={raw}")
    return names[normalized]


def _robot(state: MachineState, move: Mapping[str, Any]) -> "RobotState | str":
    """读取动作引用的机器人，缺失时返回统一错误。"""
    name = str(move.get("Robot") or move.get("ModuleName") or "")
    robot = state.resolve_robot(name)
    return robot if robot is not None else _issue(move, f"未知机器人 {name or '<empty>'}")


def _station_name(move: Mapping[str, Any]) -> str:
    """读取非运输动作使用的站点名。"""
    return str(move.get("Station") or move.get("ModuleName") or _first_text(move, "StationList") or "")


def _first_text(move: Mapping[str, Any], key: str) -> str:
    """返回协议数组的第一个非空文本值。"""
    values = _values(move, key)
    return str(values[0]) if values and values[0] is not None else ""


def _start_time(move: Mapping[str, Any]) -> float:
    """返回动作开始时刻，非法值按零处理。"""
    return _number(move.get("StartTime")) or 0.0


def _material_matches(material: Optional[MaterialState], material_id: Any) -> bool:
    """用字符串兼容数字/文本物料编号。"""
    return material is not None and str(material.material_id) == str(material_id)


def _material_with_metadata(material: Optional[MaterialState], move: Mapping[str, Any], index: int, step_key: str = "StepIDList") -> MaterialState:
    """复制物料并按并行下标写入 PJob/Step 元数据。"""
    if material is None:
        raise ValueError("状态转移缺少物料")
    step_ids = _values(move, step_key)
    pjob_names = _values(move, "PJobNameList")
    return MaterialState(
        material.material_id,
        str(pjob_names[index]) if index < len(pjob_names) else material.pjob_name,
        step_ids[index] if index < len(step_ids) else material.step_id,
    )


def _is_doorless(station: StationState) -> bool:
    """返回站点是否不产生物理开关门动作。"""
    return (
        station.station_type.lower() == LOAD_PORT_TYPE
        or station.name in DOORLESS_STATION_NAMES
    )


def _has_active_process(station: StationState, timestamp: float) -> bool:
    """返回站点是否还有未结束的加工或清洁。"""
    return any(
        slot.busy_action in {"加工", "清洁"} and not _available(slot.busy_until, timestamp)
        for slot in station.slots.values()
    )


def _available(busy_until: float, timestamp: float) -> bool:
    """按统一容差判断资源在指定时刻是否可用。"""
    return float(busy_until) <= float(timestamp) + TIME_TOLERANCE


def _reserve_slot(slot: SlotState, end_time: float, action: str) -> None:
    """占用一个物理槽位到动作结束。"""
    slot.busy_until = end_time
    slot.busy_action = action


def _set_slot(slot: SlotState, phase: SlotPhase, material: Optional[MaterialState]) -> None:
    """写入槽位稳定状态并清除动作标签。"""
    slot.phase = phase
    slot.material = material
    slot.busy_action = ""


def _schedule(scheduled: List[_ScheduledCompletion], move: Mapping[str, Any], end_time: float, complete: Callable[[], None]) -> None:
    """登记动作结束回调。"""
    move_id = move.get("MoveID")
    scheduled.append(_ScheduledCompletion(end_time, int(move_id) if isinstance(move_id, int) else -1, complete))


def _finish_until(scheduled: List[_ScheduledCompletion], timestamp: float) -> None:
    """按结束时间落地指定时刻之前完成的动作。"""
    ready = sorted(
        (item for item in scheduled if item.end_time <= timestamp + TIME_TOLERANCE),
        key=lambda item: (item.end_time, item.move_id),
    )
    for item in ready:
        item.complete()
        scheduled.remove(item)


def _issue(move: Mapping[str, Any], message: str) -> str:
    """生成包含 MoveID 和动作类型的稳定错误文本。"""
    return f"MoveID={move.get('MoveID', '?')} MoveType={move.get('MoveType', '?')}：{message}"


__all__ = [
    "ATMOSPHERE",
    "COMPLETE_MOVE",
    "DoorState",
    "LoadLockState",
    "MachineState",
    "MaterialState",
    "MoveStateReplay",
    "PICK_MOVE",
    "PLACE_MOVE",
    "PREPARE_MOVE",
    "PRE_PREPARE_MOVE",
    "PRE_TRANS_MOVE",
    "PROCESS_MOVE",
    "SWAP_MOVE",
    "SlotPhase",
    "SlotState",
    "release_completed_load_port_materials",
    "validate_move_list",
]
