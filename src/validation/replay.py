"""按时间线回放 MoveList 的状态验证。

本模块将 Move 的开始视为使能检查和资源占用，将结束视为唯一的状态落地点。
``state`` 模块保存当前机台状态；本模块解释 MoveType 字段并在首个状态违例时停止。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from src.parse.model import Problem
from src.validation.move_fields import (
    COMPLETE_MOVE,
    PICK_MOVE,
    PLACE_MOVE,
    PREPARE_MOVE,
    PRE_PREPARE_MOVE,
    PRE_TRANS_MOVE,
    PROCESS_MOVE,
    SWAP_MOVE,
    as_list,
    num,
    sort_key,
)
from src.validation.state import (
    ATMOSPHERE,
    VACUUM,
    DoorState,
    LoadLockState,
    MachineState,
    MaterialState,
    SlotPhase,
    SlotState,
    is_doorless_station,
)


TIME_TOLERANCE = 1e-6
RELATED_ROBOT_ATMOSPHERE = 0
RELATED_ROBOT_VACUUM = 1
ACTION_PLACE = 0
ACTION_PICK = 1
ACTION_SWAP = 2
DEFAULT_SLOT_ID = 1


@dataclass
class _ScheduledCompletion:
    """已经通过使能检查、等待在结束时刻写入状态的一条 Move。"""

    end_time: float
    move_id: int
    complete: Callable[[], None]


class MoveStateReplay:
    """接收外部 Move 开始/结束通知并维护实时设备状态。

    ``MoveState`` 兼容接口枚举值 ``0=Running``、``1=Done``、``2=Aborted``，也接受
    对应英文字符串。开始通知执行使能检查并占用资源，结束通知才真正落地物料、门和环境状态。
    重算方可以读取 ``state`` 快照，并通过 ``running_move_ids`` 判断是否处于安全切点。
    """

    RUNNING = 0
    DONE = 1
    ABORTED = 2

    def __init__(
        self,
        task: Problem,
        moves: Sequence[Mapping[str, Any]],
        init_data: "Optional[Mapping[str, Any] | MachineState]" = None,
    ) -> None:
        """用当前计划和初始整机状态创建实时回放器。"""
        self.task = task
        self.moves = [dict(move) for move in sorted(moves, key=sort_key)]
        self.state = MachineState.from_sources(task, init_data)
        self.current_time = 0.0
        self._moves_by_id = {
            int(move["MoveID"]): move
            for move in self.moves
            if isinstance(move.get("MoveID"), int)
        }
        self._scheduled: List[_ScheduledCompletion] = []
        self._running: Dict[int, Dict[str, Any]] = {}
        self._reservations: Dict[int, List[Tuple[Any, str]]] = {}
        self._executed: Dict[int, Dict[str, Any]] = {}

    @property
    def running_move_ids(self) -> frozenset[int]:
        """返回已经开始、尚未收到结束通知的 MoveID。"""
        return frozenset(self._running)

    @property
    def executed_moves(self) -> List[dict]:
        """返回按实际开始时间排序的已完成 Move，不暴露内部可变对象。"""
        return [
            dict(move)
            for move in sorted(self._executed.values(), key=sort_key)
        ]

    @property
    def materialized_plan(self) -> List[dict]:
        """以实际完成记录覆盖原计划，返回当前段可拼接的 MoveList。"""
        return [
            dict(self._executed.get(int(move.get("MoveID", -1)), move))
            for move in self.moves
        ]

    def update_move_state(self, notification: Mapping[str, Any]) -> MachineState:
        """应用一条 Move 开始或结束通知并返回当前状态快照。

        通知至少包含 ``MoveID`` 和 ``MoveState``；开始通知可带 ``StartTime``，结束通知可带
        ``EndTime``。未提供的时间沿用计划值。Abort 无法从稳定状态安全回滚，因此明确报错并要求
        上层先执行设备恢复流程。
        """
        move_id = notification.get("MoveID")
        if not isinstance(move_id, int) or move_id not in self._moves_by_id:
            raise ValueError(f"未知 MoveID={move_id}")
        move_state = self._notification_state(notification)
        if move_state == self.RUNNING:
            self._start_notified_move(move_id, notification)
        elif move_state == self.DONE:
            self._finish_notified_move(move_id, notification)
        else:
            raise ValueError(f"MoveID={move_id} 已中止；请先完成设备恢复，再从稳定状态重算")
        return self.state.clone()

    @classmethod
    def _notification_state(cls, notification: Mapping[str, Any]) -> int:
        """把数字或字符串 MoveState 归一成接口枚举值。"""
        raw = notification.get("MoveState", notification.get("State"))
        if isinstance(raw, int) and raw in {cls.RUNNING, cls.DONE, cls.ABORTED}:
            return raw
        name = str(raw or "").strip().lower()
        states = {"running": cls.RUNNING, "start": cls.RUNNING, "done": cls.DONE,
                  "finished": cls.DONE, "end": cls.DONE, "aborted": cls.ABORTED,
                  "abort": cls.ABORTED}
        if name not in states:
            raise ValueError(f"不支持 MoveState={raw}")
        return states[name]

    def _start_notified_move(self, move_id: int, notification: Mapping[str, Any]) -> None:
        """按开始通知执行使能检查并登记结束回调。"""
        if move_id in self._running or move_id in self._executed:
            raise ValueError(f"MoveID={move_id} 收到重复开始通知")
        planned = self._moves_by_id[move_id]
        move = dict(planned)
        planned_start = float(num(planned.get("StartTime")) or 0.0)
        planned_end = float(num(planned.get("EndTime")) or planned_start)
        actual_start = float(num(notification.get("StartTime")) if num(notification.get("StartTime")) is not None else planned_start)
        # 重算取消了原计划中间动作后，恢复链的空载转位可能需要从 Robot
        # 实际投影位置出发。通知可精确覆盖来源站点，执行历史也保留该实际字段。
        if isinstance(notification.get("SrcStationList"), list):
            move["SrcStationList"] = list(notification["SrcStationList"])
        move["StartTime"] = actual_start
        move["EndTime"] = actual_start + max(0.0, planned_end - planned_start)
        before = {
            (id(owner), field_name): float(getattr(owner, field_name))
            for owner, field_name in _busy_resource_refs(self.state)
        }
        error = _start_move(self.state, move, float(move["EndTime"]), self.moves, self._scheduled)
        if error:
            raise ValueError(error)
        self._reservations[move_id] = [
            (owner, field_name)
            for owner, field_name in _busy_resource_refs(self.state)
            if abs(float(getattr(owner, field_name)) - before[(id(owner), field_name)]) > TIME_TOLERANCE
        ]
        self._running[move_id] = move
        self.current_time = max(self.current_time, actual_start)

    def _finish_notified_move(self, move_id: int, notification: Mapping[str, Any]) -> None:
        """按结束通知只落地对应 Move 的状态更新。"""
        move = self._running.get(move_id)
        if move is None:
            raise ValueError(f"MoveID={move_id} 尚未开始，不能结束")
        actual_end_value = num(notification.get("EndTime"))
        actual_end = float(actual_end_value if actual_end_value is not None else move["EndTime"])
        if actual_end + TIME_TOLERANCE < float(move["StartTime"]):
            raise ValueError(f"MoveID={move_id} 的 EndTime 早于 StartTime")
        completion = next((item for item in self._scheduled if item.move_id == move_id), None)
        if completion is None:
            raise ValueError(f"MoveID={move_id} 缺少待落地状态")
        planned_end = completion.end_time
        for owner, field_name in self._reservations.pop(move_id, []):
            if abs(float(getattr(owner, field_name)) - planned_end) <= TIME_TOLERANCE:
                setattr(owner, field_name, actual_end)
        completion.complete()
        self._scheduled.remove(completion)
        move["EndTime"] = actual_end
        self._executed[move_id] = dict(move)
        del self._running[move_id]
        self.current_time = max(self.current_time, actual_end)


def validate_move_list(
    task: Problem,
    moves: List[dict],
    init_data: Optional[Mapping[str, Any]] = None,
) -> List[str]:
    """按时间线校验 MoveList，并返回首个状态违例。

    参数:
        task: 解析后的设备拓扑、机器人和任务物料。
        moves: 待校验的 MoveList 行。
        init_data: 可选的运行时初始状态数据。

    返回:
        无违例时返回空列表；首条非法 Move 或到期动作无法落地时返回单条错误。

    副作用:
        只创建函数内部的 ``MachineState``，不会修改输入 MoveList。
    """
    state = MachineState.from_sources(task, init_data)
    scheduled: List[_ScheduledCompletion] = []
    ordered_moves = sorted(moves, key=sort_key)

    for move in ordered_moves:
        start_time = num(move.get("StartTime"))
        end_time = num(move.get("EndTime"))
        if start_time is None or end_time is None:
            return [_issue(move, "StartTime 和 EndTime 必须是有限数字")]
        if end_time + TIME_TOLERANCE < start_time:
            return [_issue(move, "EndTime 不能早于 StartTime")]

        # 先应用当前 Move 开始前已经结束的状态变更，再检查本次使能。
        _finish_until(scheduled, start_time)
        error = _start_move(state, move, end_time, ordered_moves, scheduled)
        if error:
            return [error]

    _finish_until(scheduled, float("inf"))
    return []


def _finish_until(scheduled: List[_ScheduledCompletion], timestamp: float) -> None:
    """按结束时间和 MoveID 顺序应用所有已经到期的状态更新。"""
    scheduled.sort(key=lambda item: (item.end_time, item.move_id))
    completed = 0
    for item in scheduled:
        if item.end_time > timestamp + TIME_TOLERANCE:
            break
        item.complete()
        completed += 1
    if completed:
        del scheduled[:completed]


def _busy_resource_refs(state: MachineState) -> List[Tuple[Any, str]]:
    """列出状态机中所有资源占用终点字段，供单条实时 Move 精确改时。"""
    references: List[Tuple[Any, str]] = []
    for station in state.stations.values():
        for field_name in ("door_busy_until", "transfer_busy_until", "environment_busy_until"):
            references.append((station, field_name))
        for slot in station.slots.values():
            references.append((slot, "busy_until"))
    for robot in state.robots.values():
        references.append((robot, "busy_until"))
    return references


def _start_move(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """检查一条 Move 是否使能，并登记其结束时的状态更新。"""
    handlers = {
        PREPARE_MOVE: _start_prepare,
        COMPLETE_MOVE: _start_complete,
        PICK_MOVE: _start_pick,
        PLACE_MOVE: _start_place,
        PRE_TRANS_MOVE: _start_pretrans,
        PROCESS_MOVE: _start_process,
        PRE_PREPARE_MOVE: _start_preprepare,
        SWAP_MOVE: _start_swap,
    }
    handler = handlers.get(move.get("MoveType"))
    if handler is None:
        return _issue(move, f"不支持 MoveType={move.get('MoveType')}")
    return handler(state, move, end_time, all_moves, scheduled)


def _start_prepare(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验开门动作，并在结束时把门写为开门。"""
    station = _station(state, move, _station_name(move))
    if isinstance(station, str):
        return station
    if station.door is not DoorState.CLOSED:
        return _issue(move, f"{station.name} 当前不是关门状态")
    if not _available(station.door_busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 门机构正在执行其他动作")
    if not _available(station.transfer_busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 正在取放物料")
    if not _available(station.environment_busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 正在切换环境", environment=True)
    action, related = _prepare_action(move, all_moves)
    slot_id = _prepare_slot(move, related)
    if _has_active_process(station, _start_time(move), slot_id):
        return _issue(move, f"{station.name} 存在尚未完成的加工或清洁")
    if action == ACTION_PICK:
        slot = _slot(station, slot_id, move)
        if isinstance(slot, str):
            return slot
        if slot.phase is not SlotPhase.COMPLETED or not _material_matches(slot.material, _first_value(move, "MatIDList")):
            return _issue(move, f"{station.name}#{slot_id} 没有可取的已完成物料")
    elif action == ACTION_PLACE:
        slot = _slot(station, slot_id, move)
        if isinstance(slot, str):
            return slot
        if slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
            return _issue(move, f"{station.name}#{slot_id} 不是可放片空槽")

    if isinstance(station, LoadLockState):
        expected = _required_environment(state, move, related)
        if expected is None:
            return _issue(move, f"无法确定 {station.name} 开门所需环境", environment=True)
        if station.environment != expected:
            return _issue(move, f"{station.name} 当前环境为 {station.environment}，不是 {expected}", environment=True)
        station.last_environment_transition_was_empty = False

    station.door_busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: setattr(station, "door", DoorState.OPEN))
    return None


def _start_complete(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    _all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验关门动作，并在结束时把门写为关门。"""
    station = _station(state, move, _station_name(move))
    if isinstance(station, str):
        return station
    if not is_doorless_station(station.name) and station.door is not DoorState.OPEN:
        return _issue(move, f"{station.name} 当前不是开门状态")
    if not _available(station.door_busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 门机构正在执行其他动作")
    if not _available(station.transfer_busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 正在取放物料")
    station.door_busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: setattr(station, "door", DoorState.CLOSED))
    return None


def _start_pick(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    _all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验取片的门、物料、机器人手槽和指向，并在结束时转移物料。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    station_name = _first_text(move, "SrcStationList")
    station = _station(state, move, station_name)
    if isinstance(station, str):
        return station
    slot_id = _first_slot(move, "SrcSlotList")
    robot_slot = _robot_slot(robot, move)
    error = _robot_slot_error(robot, robot_slot, move)
    if error:
        return error
    slot = _slot(station, slot_id, move)
    if isinstance(slot, str):
        return slot
    error = _robot_station_access_error(robot, station_name, move)
    if error:
        return error
    if not is_doorless_station(station.name) and station.door is not DoorState.OPEN:
        return _issue(move, f"{station.name} 门当前为关门")
    if not _available(robot.busy_until, _start_time(move)) or (
        not is_doorless_station(station.name) and not _available(station.transfer_busy_until, _start_time(move))
    ):
        return _issue(move, f"{robot.name} 或 {station.name} 正在执行取放动作")
    if not _available(slot.busy_until, _start_time(move)):
        return _issue(move, f"{station.name}#{slot_id} 正在{slot.busy_action}")
    if robot.hands.get(robot_slot) is not None:
        return _issue(move, f"{robot.name}#{robot_slot} 不是空手")
    material_id = _first_value(move, "MatIDList")
    if slot.phase is not SlotPhase.COMPLETED or not _material_matches(slot.material, material_id):
        return _issue(move, f"{station.name}#{slot_id} 没有匹配的已完成物料")
    if robot.position is not None and robot.position != station_name:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {station_name}")

    material = slot.material
    robot.busy_until = end_time
    if not is_doorless_station(station.name):
        station.transfer_busy_until = end_time
    _reserve_slot(slot, end_time, "取片")

    def complete() -> None:
        slot.phase = SlotPhase.EMPTY
        slot.material = None
        robot.hands[robot_slot] = material
        robot.position = station_name

    _schedule(scheduled, move, end_time, complete)
    return None


def _start_place(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    _all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验放片的门、空槽、机器人手槽和指向，并在结束时转移物料。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    station_name = _first_text(move, "DestStationList")
    station = _station(state, move, station_name)
    if isinstance(station, str):
        return station
    slot_id = _first_slot(move, "DestSlotList")
    robot_slot = _robot_slot(robot, move)
    error = _robot_slot_error(robot, robot_slot, move)
    if error:
        return error
    slot = _slot(station, slot_id, move)
    if isinstance(slot, str):
        return slot
    error = _robot_station_access_error(robot, station_name, move)
    if error:
        return error
    if not is_doorless_station(station.name) and station.door is not DoorState.OPEN:
        return _issue(move, f"{station.name} 门当前为关门")
    if not _available(robot.busy_until, _start_time(move)) or (
        not is_doorless_station(station.name) and not _available(station.transfer_busy_until, _start_time(move))
    ):
        return _issue(move, f"{robot.name} 或 {station.name} 正在执行取放动作")
    if not _available(slot.busy_until, _start_time(move)):
        return _issue(move, f"{station.name}#{slot_id} 正在{slot.busy_action}")
    if slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
        return _issue(move, f"{station.name}#{slot_id} 不是可放片空槽")
    material = robot.hands.get(robot_slot)
    if material is None or not _material_matches(material, _first_value(move, "MatIDList")):
        return _issue(move, f"{robot.name}#{robot_slot} 没有匹配物料")
    if robot.position is not None and robot.position != station_name:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {station_name}")

    robot.busy_until = end_time
    if not is_doorless_station(station.name):
        station.transfer_busy_until = end_time
    _reserve_slot(slot, end_time, "放片")

    def complete() -> None:
        slot.phase = SlotPhase.UNPROCESSED
        slot.material = _material_with_move_metadata(material, move)
        robot.hands[robot_slot] = None
        robot.position = station_name

    _schedule(scheduled, move, end_time, complete)
    return None


def _start_pretrans(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    _all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验空载或负载转位，并在结束时更新机器人指向。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    source = _first_text(move, "SrcStationList")
    destination = _first_text(move, "DestStationList")
    robot_slot = _robot_slot(robot, move)
    error = _robot_slot_error(robot, robot_slot, move)
    if error:
        return error
    material = robot.hands.get(robot_slot)
    material_id = _first_value(move, "MatIDList")
    if not destination:
        return _issue(move, "转位缺少 DestStationList")
    if not _available(robot.busy_until, _start_time(move)):
        return _issue(move, f"{robot.name} 正在执行其他动作")
    if robot.position is not None and source and robot.position != source:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {source}")
    if material is not None and material_id is not None and not _material_matches(material, material_id):
        return _issue(move, f"{robot.name}#{robot_slot} 持有物料与 Move 不匹配")
    for station_name in (source, destination):
        if not station_name:
            continue
        error = _robot_station_access_error(robot, station_name, move)
        if error:
            return error

    robot.busy_until = end_time
    _schedule(scheduled, move, end_time, lambda: setattr(robot, "position", destination))
    return None


def _start_process(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    _all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验加工或无片清洁，并在结束时写入槽位完成状态。"""
    station = _station(state, move, _station_name(move))
    if isinstance(station, str):
        return station
    slot_id = _first_slot(move, "SlotList")
    slot = _slot(station, slot_id, move)
    if isinstance(slot, str):
        return slot
    if station.door is not DoorState.CLOSED:
        return _issue(move, f"{station.name} 加工或清洁时必须关门")
    if not is_doorless_station(station.name) and (
        not _available(station.door_busy_until, _start_time(move))
        or not _available(station.transfer_busy_until, _start_time(move))
    ):
        return _issue(move, f"{station.name} 正在执行开关门或取放动作")
    if not _available(slot.busy_until, _start_time(move)):
        return _issue(move, f"{station.name}#{slot_id} 正在{slot.busy_action}")
    material_id = _first_value(move, "MatIDList")
    if material_id is None:
        if slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
            return _issue(move, f"{station.name}#{slot_id} 有物料，不能执行无片清洁")
        _reserve_slot(slot, end_time, "清洁")
        _schedule(scheduled, move, end_time, lambda: _set_slot(slot, SlotPhase.CLEANED, None))
        return None
    if slot.phase is not SlotPhase.UNPROCESSED or not _material_matches(slot.material, material_id):
        return _issue(move, f"{station.name}#{slot_id} 没有待加工的匹配物料")
    material = slot.material
    _reserve_slot(slot, end_time, "加工")
    _schedule(scheduled, move, end_time, lambda: _set_slot(slot, SlotPhase.COMPLETED, material))
    return None


def _start_preprepare(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    _all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验 LoadLock 抽气或充气的环境链，并在结束时更新环境。"""
    station = _station(state, move, _station_name(move))
    if isinstance(station, str):
        return station
    if not isinstance(station, LoadLockState):
        return _issue(move, f"{station.name} 不是 LoadLock，不能切换环境", environment=True)
    if station.door is not DoorState.CLOSED:
        return _issue(move, f"{station.name} 切换环境时必须关门", environment=True)
    if not _available(station.door_busy_until, _start_time(move)) or not _available(station.transfer_busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 正在开关门或取放物料", environment=True)
    if not _available(station.environment_busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 正在切换环境", environment=True)
    last_state = _environment_state(move.get("LastState"))
    current_state = _environment_state(move.get("CurState"))
    if last_state not in {ATMOSPHERE, VACUUM} or current_state not in {ATMOSPHERE, VACUUM}:
        return _issue(move, "LastState 和 CurState 必须为 ATM/VAC 或 ATR/VTR", environment=True)
    if station.environment != last_state:
        return _issue(move, f"{station.name} 当前环境为 {station.environment}，不是 {last_state}", environment=True)

    material_id = _first_value(move, "MatIDList")
    is_empty_transition = material_id is None
    if is_empty_transition and station.last_environment_transition_was_empty:
        return _issue(move, f"{station.name} 未开门便连续执行无片抽气或充气", environment=True)
    slot: Optional[SlotState] = None
    material: Optional[MaterialState] = None
    if material_id is not None:
        slot_id = _first_slot(move, "SlotList")
        if slot_id is None:
            inferred = _slot_with_material(station, material_id)
            if inferred is None:
                return _issue(move, "缺少有效槽位", environment=True)
            slot_id, slot = inferred
        else:
            slot_or_error = _slot(station, slot_id, move)
            if isinstance(slot_or_error, str):
                return slot_or_error
            slot = slot_or_error
        if not _available(slot.busy_until, _start_time(move)):
            return _issue(move, f"{station.name}#{slot_id} 正在{slot.busy_action}", environment=True)
        if slot.phase is not SlotPhase.UNPROCESSED or not _material_matches(slot.material, material_id):
            return _issue(move, f"{station.name}#{slot_id} 没有待抽充气的匹配物料", environment=True)
        material = slot.material
        _reserve_slot(slot, end_time, "抽充气")

    station.environment_busy_until = end_time

    def complete() -> None:
        station.environment = current_state
        station.last_environment_transition_was_empty = is_empty_transition
        if slot is not None:
            _set_slot(slot, SlotPhase.COMPLETED, material)

    _schedule(scheduled, move, end_time, complete)
    return None


def _start_swap(
    state: MachineState,
    move: Mapping[str, Any],
    end_time: float,
    _all_moves: Sequence[Mapping[str, Any]],
    scheduled: List[_ScheduledCompletion],
) -> Optional[str]:
    """校验同站原子换片，并在结束时同时更新机器人和站点槽位。"""
    robot = _robot(state, move)
    if isinstance(robot, str):
        return robot
    stations = [str(value) for value in as_list(dict(move), "StationList") if value]
    if not stations or len(set(stations)) != 1:
        return _issue(move, "SwapMove 必须引用同一个站点")
    station_name = stations[0]
    station = _station(state, move, station_name)
    if isinstance(station, str):
        return station
    station_receive_slot_id = _first_slot(move, "StnRecvSlotList")
    station_send_slot_id = _first_slot(move, "StnSendSlotList")
    robot_receive_slot = _first_slot(move, "RecvSlotList")
    robot_send_slot = _first_slot(move, "SendSlotList")
    station_receive_slot = _slot(station, station_receive_slot_id, move)
    station_send_slot = _slot(station, station_send_slot_id, move)
    if isinstance(station_receive_slot, str):
        return station_receive_slot
    if isinstance(station_send_slot, str):
        return station_send_slot
    if robot_receive_slot is None or robot_send_slot is None:
        return _issue(move, "SwapMove 缺少机器人接收或发送槽位")
    error = _robot_slot_error(robot, robot_receive_slot, move)
    if error:
        return error
    error = _robot_slot_error(robot, robot_send_slot, move)
    if error:
        return error
    error = _robot_station_access_error(robot, station_name, move)
    if error:
        return error
    if not is_doorless_station(station.name) and station.door is not DoorState.OPEN:
        return _issue(move, f"{station.name} 门当前为关门")
    if robot.position is not None and robot.position != station_name:
        return _issue(move, f"{robot.name} 当前指向 {robot.position}，不是 {station_name}")
    if not _available(robot.busy_until, _start_time(move)) or (
        not is_doorless_station(station.name) and not _available(station.transfer_busy_until, _start_time(move))
    ):
        return _issue(move, f"{robot.name} 或 {station.name} 正在执行取放动作")
    if not _available(station_receive_slot.busy_until, _start_time(move)) or not _available(station_send_slot.busy_until, _start_time(move)):
        return _issue(move, f"{station.name} 换片槽位正在执行其他动作")
    robot_receive_material_id = _first_value(move, "RecvMatList")
    robot_send_material_id = _first_value(move, "SendMatList")
    robot_send_material = robot.hands.get(robot_send_slot)
    if station_send_slot.phase is not SlotPhase.COMPLETED or not _material_matches(station_send_slot.material, robot_receive_material_id):
        return _issue(move, f"{station.name}#{station_send_slot_id} 没有可换出的已完成物料")
    if robot.hands.get(robot_receive_slot) is not None:
        return _issue(move, f"{robot.name}#{robot_receive_slot} 不是空手")
    if robot_send_material is None or not _material_matches(robot_send_material, robot_send_material_id):
        return _issue(move, f"{robot.name}#{robot_send_slot} 没有可换入的匹配物料")
    if station_receive_slot is not station_send_slot and station_receive_slot.phase not in {SlotPhase.EMPTY, SlotPhase.CLEANED}:
        return _issue(move, f"{station.name}#{station_receive_slot_id} 不是可换入空槽")

    station_send_material = station_send_slot.material
    robot.busy_until = end_time
    if not is_doorless_station(station.name):
        station.transfer_busy_until = end_time
    _reserve_slot(station_receive_slot, end_time, "换片")
    if station_send_slot is not station_receive_slot:
        _reserve_slot(station_send_slot, end_time, "换片")

    def complete() -> None:
        _set_slot(station_receive_slot, SlotPhase.UNPROCESSED, _material_with_move_metadata(robot_send_material, move))
        if station_send_slot is not station_receive_slot:
            _set_slot(station_send_slot, SlotPhase.EMPTY, None)
        robot.hands[robot_send_slot] = None
        robot.hands[robot_receive_slot] = station_send_material
        robot.position = station_name

    _schedule(scheduled, move, end_time, complete)
    return None


def _prepare_action(
    move: Mapping[str, Any],
    all_moves: Sequence[Mapping[str, Any]],
) -> Tuple[Optional[int], Optional[Mapping[str, Any]]]:
    """读取开门关联动作；字段缺失时从开门结束时刻的取放或换片推断。"""
    action = move.get("RelatedActionType")
    if isinstance(action, int):
        return action, _related_move(move, all_moves)
    related = _related_move(move, all_moves)
    if related is None:
        return None, None
    move_type = related.get("MoveType")
    return (
        ACTION_PICK if move_type == PICK_MOVE else ACTION_PLACE if move_type == PLACE_MOVE else ACTION_SWAP if move_type == SWAP_MOVE else None,
        related,
    )


def _related_move(move: Mapping[str, Any], all_moves: Sequence[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    """查找在开门结束时刻衔接、且访问同一站点的取放或换片动作。"""
    end_time = num(move.get("EndTime"))
    station_name = _station_name(move)
    if end_time is None:
        return None
    for candidate in all_moves:
        if abs((num(candidate.get("StartTime")) or float("inf")) - end_time) > TIME_TOLERANCE:
            continue
        if candidate.get("MoveType") == PICK_MOVE and _first_text(candidate, "SrcStationList") == station_name:
            return candidate
        if candidate.get("MoveType") == PLACE_MOVE and _first_text(candidate, "DestStationList") == station_name:
            return candidate
        if candidate.get("MoveType") == SWAP_MOVE and station_name in {str(value) for value in as_list(dict(candidate), "StationList")}:
            return candidate
    return None


def _required_environment(
    state: MachineState,
    move: Mapping[str, Any],
    related: Optional[Mapping[str, Any]],
) -> Optional[str]:
    """解析 LoadLock 开门动作所需的大气或真空环境。"""
    related_type = move.get("RelatedRobotType")
    if related_type == RELATED_ROBOT_ATMOSPHERE:
        return ATMOSPHERE
    if related_type == RELATED_ROBOT_VACUUM:
        return VACUUM
    if related is None:
        return None
    robot = state.resolve_robot(str(related.get("Robot") or related.get("ModuleName") or ""))
    if robot is None:
        return None
    upper_name = robot.name.upper()
    if "ATM" in upper_name:
        return ATMOSPHERE
    if "VAC" in upper_name or "VTR" in upper_name:
        return VACUUM
    return ATMOSPHERE if any(
        state.stations.get(station_name) and state.stations[station_name].station_type.lower() == "loadport"
        for station_name in robot.scope
    ) else VACUUM


def _environment_state(value: Any) -> str:
    """把接口中的压力态或机器人侧标签统一成 ATM/VAC。"""
    raw = str(value or "").upper()
    if raw in {ATMOSPHERE, "ATR"}:
        return ATMOSPHERE
    if raw in {VACUUM, "VTR"}:
        return VACUUM
    return raw


def _station(state: MachineState, move: Mapping[str, Any], name: str) -> "StationState | str":
    """读取被引用站点，并把缺失站点转换为统一错误文案。"""
    station = state.stations.get(name)
    return station if station is not None else _issue(move, f"未知站点 {name or '<empty>'}")


def _robot(state: MachineState, move: Mapping[str, Any]) -> "RobotState | str":
    """读取 Move 引用的机器人，并把缺失机器人转换为统一错误文案。"""
    raw_name = str(move.get("Robot") or move.get("ModuleName") or "")
    robot = state.resolve_robot(raw_name)
    return robot if robot is not None else _issue(move, f"未知机器人 {raw_name or '<empty>'}")


def _slot(station: "StationState", slot_id: Optional[int], move: Mapping[str, Any]) -> "SlotState | str":
    """读取有效槽位，并为缺失槽位返回统一错误文案。"""
    if slot_id is None:
        return _issue(move, "缺少有效槽位")
    slot = station.slots.get(slot_id)
    return slot if slot is not None else _issue(move, f"{station.name} 不存在槽位 {slot_id}")


def _slot_with_material(station: "StationState", material_id: Any) -> Optional[Tuple[int, SlotState]]:
    """在字段缺槽位时，从站内唯一匹配的未处理物料反推槽位。"""
    matches = [
        (slot_id, slot)
        for slot_id, slot in station.slots.items()
        if slot.phase is SlotPhase.UNPROCESSED and _material_matches(slot.material, material_id)
    ]
    return matches[0] if len(matches) == 1 else None


def _robot_slot(robot: "RobotState", move: Mapping[str, Any]) -> int:
    """读取机器人槽位；字段缺失时选择最小已启用手槽。"""
    slot_id = _first_slot(move, "RobotSlotList")
    return slot_id if slot_id is not None else min(robot.hands) if robot.hands else DEFAULT_SLOT_ID


def _robot_slot_error(robot: "RobotState", slot_id: int, move: Mapping[str, Any]) -> Optional[str]:
    """校验 Move 指定的机器人手槽已在初始设备配置中启用。"""
    if slot_id not in robot.hands:
        return _issue(move, f"{robot.name} 不存在或未启用手槽 {slot_id}")
    return None


def _robot_station_access_error(robot: "RobotState", station_name: str, move: Mapping[str, Any]) -> Optional[str]:
    """校验机器人静态可达范围；空范围表示接口未提供限制。"""
    if robot.scope and station_name not in robot.scope:
        return _issue(move, f"{robot.name} 无法访问 {station_name}")
    return None


def _prepare_slot(move: Mapping[str, Any], related: Optional[Mapping[str, Any]]) -> Optional[int]:
    """读取开门槽位；缺失时使用衔接取放或换片动作的对应槽位。"""
    slot_id = _first_slot(move, "SlotList")
    if slot_id is not None or related is None:
        return slot_id
    if related.get("MoveType") == PICK_MOVE:
        return _first_slot(related, "SrcSlotList")
    if related.get("MoveType") == PLACE_MOVE:
        return _first_slot(related, "DestSlotList")
    return _first_slot(related, "StnSendSlotList")


def _has_active_process(station: "StationState", timestamp: float, slot_id: Optional[int] = None) -> bool:
    """判断是否仍有加工或清洁占用，开门前必须等待它们结束。"""
    slots = [station.slots[slot_id]] if slot_id in station.slots else station.slots.values()
    return any(slot.busy_action in {"加工", "清洁"} and not _available(slot.busy_until, timestamp) for slot in slots)


def _available(busy_until: float, timestamp: float) -> bool:
    """判断资源是否已经在当前逻辑时刻前释放。"""
    return timestamp + TIME_TOLERANCE >= busy_until


def _reserve_slot(slot: "SlotState", end_time: float, action: str) -> None:
    """登记槽位在 Move 结束前不可被其他动作使用。"""
    slot.busy_until = end_time
    slot.busy_action = action


def _set_slot(slot: "SlotState", phase: SlotPhase, material: Optional[MaterialState]) -> None:
    """在 Move 结束时写入槽位的稳定物料状态。"""
    slot.phase = phase
    slot.material = material


def _schedule(
    scheduled: List[_ScheduledCompletion],
    move: Mapping[str, Any],
    end_time: float,
    complete: Callable[[], None],
) -> None:
    """登记一条已使能 Move 的结束状态更新。"""
    move_id = move.get("MoveID")
    scheduled.append(_ScheduledCompletion(end_time, move_id if isinstance(move_id, int) else 0, complete))


def _material_matches(material: Optional[MaterialState], material_id: Any) -> bool:
    """判断物料存在且与 Move 明示的物料编号一致。"""
    return material is not None and (material_id is None or material.material_id == material_id)


def _material_with_move_metadata(material: MaterialState, move: Mapping[str, Any]) -> MaterialState:
    """复制转移物料，并在 Move 明示时更新步骤和 PJob 元数据。"""
    pjob = _first_text(move, "PJobName") or material.pjob_name
    step_id = _first_value(move, "StepIDList")
    return MaterialState(material.material_id, pjob, material.step_id if step_id is None else step_id)


def _start_time(move: Mapping[str, Any]) -> float:
    """读取已经通过时间格式校验的开始时刻。"""
    return float(num(move.get("StartTime")) or 0.0)


def _station_name(move: Mapping[str, Any]) -> str:
    """读取站点侧 Move 的 Station 或 ModuleName。"""
    return str(move.get("Station") or move.get("ModuleName") or "")


def _first_value(move: Mapping[str, Any], key: str) -> Any:
    """读取列表字段的第一个值。"""
    values = as_list(dict(move), key)
    return values[0] if values else None


def _first_text(move: Mapping[str, Any], key: str) -> str:
    """读取列表字段的第一个字符串值。"""
    value = _first_value(move, key)
    return str(value) if value is not None else ""


def _first_slot(move: Mapping[str, Any], key: str) -> Optional[int]:
    """读取列表字段中的第一个有效一基槽位。"""
    value = _first_value(move, key)
    return value if isinstance(value, int) and value >= DEFAULT_SLOT_ID else None


def _issue(move: Mapping[str, Any], message: str, *, environment: bool = False) -> str:
    """统一构造带 MoveID 的中文状态违例文案。"""
    category = "环境状态" if environment else "状态"
    return f"ML {category}违例 id={move.get('MoveID')}: {message}"
