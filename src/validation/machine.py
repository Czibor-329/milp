"""面向调度策略的整机抽象。

本模块把物理状态、机器人搬运候选、增量定时和 MoveList 生成收敛到
``Machine``。调度策略只读取不可变快照和搬运意图，并返回选中的
``action_id``；开关门、机器人转位、LoadLock 压力转换和加工事件均由
Machine 自动生成。

当前实现使用“投影式排程”语义：提交一个搬运意图后，物料在规划状态中
投影到该意图及其自动加工完成后的状态，同时各资源保留绝对释放时间。
因此多个 Robot 仍可在同一排程起点并行工作，而策略无需维护事件日历。
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Callable, Dict, Mapping, Optional, Protocol, Sequence, Tuple

from src.parse.model import Durations, Problem, Stage, Wafer
from src.validation.move_fields import (
    COMPLETE_MOVE,
    PICK_MOVE,
    PLACE_MOVE,
    PREPARE_MOVE,
    PRE_PREPARE_MOVE,
    PRE_TRANS_MOVE,
    PROCESS_MOVE,
    SWAP_MOVE,
)
from src.validation.state import (
    ATMOSPHERE,
    VACUUM,
    DoorState,
    LoadLockState,
    MachineState,
    MaterialState,
    SlotPhase,
    is_doorless_station,
)


TIME_TOLERANCE = 1e-6
FIRST_SLOT_ID = 1
RELATED_ACTION_PLACE = 0
RELATED_ACTION_PICK = 1
RELATED_ACTION_SWAP = 2
RELATED_ROBOT_ATMOSPHERE = 0
RELATED_ROBOT_VACUUM = 1
DEFAULT_ROBOT_SLOT = 1
MAXIMUM_DECISIONS = 1_000_000


def _freeze(value: Any) -> Any:
    """递归复制并冻结公开视图，阻止策略修改 Machine 内部数据。"""
    if isinstance(value, Mapping):
        return MappingProxyType({
            key: _freeze(item)
            for key, item in value.items()
        })
    if isinstance(value, (list, tuple, set, frozenset)):
        return tuple(_freeze(item) for item in value)
    return deepcopy(value)


def _thaw(value: Any) -> Any:
    """把公开只读预览还原成 MoveList 需要的可变列表结构。"""
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return deepcopy(value)


@dataclass(frozen=True)
class MaterialView:
    """供策略读取的单片物料位置和路线进度。"""

    material_id: Any
    pjob_name: str
    step_id: Optional[int]
    location: str
    slot_id: int
    phase: str
    ready_at: float


@dataclass(frozen=True)
class StationView:
    """供策略读取的站点物理摘要。"""

    name: str
    station_type: str
    door: str
    environment: Optional[str]
    ready_at: float
    slots: Mapping[int, Optional[Any]]


@dataclass(frozen=True)
class RobotView:
    """供策略读取的机器人指向、手槽和释放时间。"""

    name: str
    position: Optional[str]
    ready_at: float
    hands: Mapping[int, Optional[Any]]


@dataclass(frozen=True)
class MachineSnapshot:
    """调度策略可见的不可变整机快照。"""

    revision: int
    time: float
    materials: Mapping[Any, MaterialView]
    stations: Mapping[str, StationView]
    robots: Mapping[str, RobotView]
    active_moves: Tuple[Mapping[str, Any], ...]
    completed_action_count: int


@dataclass(frozen=True)
class RobotAction:
    """一个可由策略选择的完整机器人搬运意图。"""

    revision: int
    action_id: str
    kind: str
    robot: str
    material_ids: Tuple[Any, ...]
    source_station: Optional[str]
    source_slot: Optional[int]
    destination_station: str
    destination_slot: int
    robot_slots: Tuple[int, ...]
    earliest_start: float
    finish_time: float
    move_preview: Tuple[Mapping[str, Any], ...]
    wafer_id: int
    stage_index: int


@dataclass(frozen=True)
class MachineRunResult:
    """Machine 完成一次策略运行后的稳定结果。"""

    moves: Tuple[Mapping[str, Any], ...]
    makespan: float
    action_count: int
    snapshot: MachineSnapshot


class MachineSelector(Protocol):
    """调度策略的最小协议。"""

    def choose(
        self,
        state: MachineSnapshot,
        actions: Sequence[RobotAction],
    ) -> str:
        """从当前候选集合返回一个 ``action_id``。"""


class StaleRobotActionError(RuntimeError):
    """提交了来自旧 Machine revision 的动作。"""


class UnknownRobotActionError(KeyError):
    """提交了当前候选集合中不存在的动作。"""


class MachineDeadlockError(RuntimeError):
    """仍有未完成物料，但 Machine 无法生成合法机器人动作。"""


class Machine:
    """统一管理设备物理语义、增量定时、状态投影和 MoveList。

    参数:
        task: 已解析的设备拓扑与任务。
        init_data: 初始接口快照或现有 ``MachineState``。
        current_time: 本轮排程的绝对起点。
        initial_move_id: 新生成 MoveID 的前一个值。

    调度策略不应修改 ``state``，也不应自行生成门、压力或加工 Move。
    """

    def __init__(
        self,
        task: Problem,
        init_data: "Optional[Mapping[str, Any] | MachineState]" = None,
        *,
        current_time: float = 0.0,
        initial_move_id: int = 0,
    ) -> None:
        self.task = task
        self.state = MachineState.from_sources(task, init_data)
        self.current_time = float(current_time)
        self._initial_state = self.state.clone()
        self._durations = Durations(task)
        self._wafer_by_material = {wafer.mat_id: wafer for wafer in task.wafers}
        self._moves: list[dict] = []
        self._active_moves: Dict[int, dict] = {}
        self._revision = 0
        self._next_move_id = int(initial_move_id) + 1
        self._committed_action_count = 0
        self._current_actions: Dict[str, RobotAction] = {}
        self._replay: Any = None
        self._process_visits: Dict[tuple[str, int], int] = {}
        self._post_clean_scheduled = False
        self._apply_runtime_availability()
        self._schedule_pre_cleaning()
        self._schedule_pending_services()

    @property
    def revision(self) -> int:
        """返回当前候选版本。"""
        return self._revision

    @property
    def action_count(self) -> int:
        """返回当前计划已经提交的搬运意图数量。"""
        return self._committed_action_count

    def get_state(self) -> MachineSnapshot:
        """返回当前投影状态的不可变快照。"""
        material_views: Dict[Any, MaterialView] = {}
        station_views: Dict[str, StationView] = {}
        for station_name, station in sorted(self.state.stations.items()):
            slot_materials: Dict[int, Optional[Any]] = {}
            for slot_id, slot in sorted(station.slots.items()):
                material = slot.material
                slot_materials[slot_id] = (
                    material.material_id if material is not None else None
                )
                if material is not None:
                    material_views[material.material_id] = MaterialView(
                        material_id=material.material_id,
                        pjob_name=material.pjob_name,
                        step_id=(
                            int(material.step_id)
                            if isinstance(material.step_id, int)
                            else None
                        ),
                        location=station_name,
                        slot_id=slot_id,
                        phase=slot.phase.value,
                        ready_at=float(slot.busy_until),
                    )
            station_views[station_name] = StationView(
                name=station_name,
                station_type=station.station_type,
                door=station.door.value,
                environment=(
                    station.environment
                    if isinstance(station, LoadLockState)
                    else None
                ),
                ready_at=max(
                    float(station.door_busy_until),
                    float(station.transfer_busy_until),
                    float(station.environment_busy_until),
                    *(float(slot.busy_until) for slot in station.slots.values()),
                ),
                slots=MappingProxyType(slot_materials),
            )

        robot_views: Dict[str, RobotView] = {}
        for robot_name, robot in sorted(self.state.robots.items()):
            hands = {
                slot_id: (
                    material.material_id if material is not None else None
                )
                for slot_id, material in sorted(robot.hands.items())
            }
            for slot_id, material in robot.hands.items():
                if material is None:
                    continue
                material_views[material.material_id] = MaterialView(
                    material_id=material.material_id,
                    pjob_name=material.pjob_name,
                    step_id=(
                        int(material.step_id)
                        if isinstance(material.step_id, int)
                        else None
                    ),
                    location=robot_name,
                    slot_id=slot_id,
                    phase="held",
                    ready_at=float(robot.busy_until),
                )
            robot_views[robot_name] = RobotView(
                name=robot_name,
                position=robot.position,
                ready_at=float(robot.busy_until),
                hands=MappingProxyType(hands),
            )
        return MachineSnapshot(
            revision=self._revision,
            time=self.current_time,
            materials=MappingProxyType(material_views),
            stations=MappingProxyType(station_views),
            robots=MappingProxyType(robot_views),
            active_moves=tuple(
                _freeze(move)
                for _, move in sorted(self._active_moves.items())
            ),
            completed_action_count=self._committed_action_count,
        )

    def get_robot_actions(self) -> Tuple[RobotAction, ...]:
        """返回当前状态下合法搬运意图及其最早完整时间窗口。"""
        actions: list[RobotAction] = []
        locations = self._material_locations()
        for material_id, wafer in sorted(
            self._wafer_by_material.items(),
            key=lambda item: int(item[1].wid),
        ):
            location = locations.get(material_id)
            if location is None:
                continue
            location_kind, owner_name, slot_id, material, phase = location
            stage_index = self._stage_index(wafer, material, owner_name)
            if stage_index >= len(wafer.stages) - 1:
                continue
            if location_kind == "station" and phase is not SlotPhase.COMPLETED:
                continue

            robot_name = str(wafer.transports[stage_index])
            robot = self.state.resolve_robot(robot_name)
            if robot is None:
                continue
            if location_kind == "robot" and owner_name != robot.name:
                continue
            source_station = (
                owner_name if location_kind == "station" else robot.position
            )
            source_slot = slot_id if location_kind == "station" else None
            following = wafer.stages[stage_index + 1]
            destinations = list(dict.fromkeys(following.cands or [following.chamber]))
            for destination in destinations:
                target_slot_id = int(following.slot) + FIRST_SLOT_ID
                target = self.state.stations.get(str(destination))
                if target is None:
                    continue
                target_slot = target.slots.get(target_slot_id)
                if target_slot is None:
                    continue
                if robot.scope and (
                    (source_station and source_station not in robot.scope)
                    or destination not in robot.scope
                ):
                    continue
                robot_slot = (
                    slot_id
                    if location_kind == "robot"
                    else self._empty_robot_slot(robot.hands)
                )
                if robot_slot is None:
                    continue
                swap_material: Optional[MaterialState] = None
                receive_robot_slot: Optional[int] = None
                if target_slot.material is not None:
                    if (
                        not robot.can_swap
                        or target_slot.phase is not SlotPhase.COMPLETED
                    ):
                        continue
                    outgoing_wafer = self._wafer_by_material.get(
                        target_slot.material.material_id
                    )
                    if outgoing_wafer is None:
                        continue
                    outgoing_stage = self._stage_index(
                        outgoing_wafer,
                        target_slot.material,
                        str(destination),
                    )
                    if (
                        outgoing_stage >= len(outgoing_wafer.transports)
                        or outgoing_wafer.transports[outgoing_stage] != robot.name
                    ):
                        continue
                    receive_robot_slot = next(
                        (
                            hand_slot
                            for hand_slot, hand_material in sorted(robot.hands.items())
                            if hand_slot != int(robot_slot) and hand_material is None
                        ),
                        None,
                    )
                    if receive_robot_slot is None:
                        continue
                    swap_material = target_slot.material
                action = self._preview_transfer(
                    wafer=wafer,
                    stage_index=stage_index,
                    robot_name=robot.name,
                    robot_slot=int(robot_slot),
                    material=material,
                    source_station=source_station,
                    source_slot=source_slot,
                    destination_station=str(destination),
                    destination_slot=target_slot_id,
                    already_held=location_kind == "robot",
                    swap_material=swap_material,
                    receive_robot_slot=receive_robot_slot,
                )
                if action is not None:
                    actions.append(action)
        actions.sort(
            key=lambda action: (
                action.earliest_start,
                action.finish_time,
                action.robot,
                action.wafer_id,
                action.destination_station,
                action.destination_slot,
            )
        )
        self._current_actions = {action.action_id: action for action in actions}
        return tuple(actions)

    def apply_robot_action(
        self,
        action_id: str,
        *,
        expected_revision: Optional[int] = None,
    ) -> RobotAction:
        """原子提交当前候选中的一个搬运意图。"""
        if expected_revision is not None and expected_revision != self._revision:
            raise StaleRobotActionError(
                f"动作版本过期：expected={expected_revision}, current={self._revision}"
            )
        normalized_action_id = str(action_id)
        revision_prefix = normalized_action_id.split(":", 1)[0]
        if revision_prefix.startswith("r"):
            try:
                action_revision = int(revision_prefix[1:])
            except ValueError:
                action_revision = self._revision
            if action_revision != self._revision:
                raise StaleRobotActionError(
                    f"动作版本过期：action={action_revision}, current={self._revision}"
                )
        action = self._current_actions.get(normalized_action_id)
        if action is None:
            self.get_robot_actions()
            action = self._current_actions.get(normalized_action_id)
        if action is None:
            raise UnknownRobotActionError(normalized_action_id)
        if action.revision != self._revision:
            raise StaleRobotActionError(
                f"动作版本过期：action={action.revision}, current={self._revision}"
            )

        committed_moves = []
        for preview in action.move_preview:
            move = _thaw(preview)
            move["MoveID"] = self._next_move_id
            self._next_move_id += 1
            committed_moves.append(move)
        self._moves.extend(committed_moves)
        self._apply_projected_action(action, committed_moves)
        self._schedule_periodic_cleaning(action)
        self._committed_action_count += 1
        self._revision += 1
        self._current_actions = {}
        return action

    def run(
        self,
        selector: "MachineSelector | Callable[[MachineSnapshot, Sequence[RobotAction]], str]",
        *,
        maximum_decisions: int = MAXIMUM_DECISIONS,
    ) -> MachineRunResult:
        """反复调用策略直至所有物料到达 Route 终点。"""
        for _ in range(maximum_decisions):
            if self._is_done():
                self._close_orphan_doors()
                self._schedule_post_cleaning()
                moves = self.export_movelist()
                makespan = max(
                    (float(move.get("EndTime") or 0.0) for move in moves),
                    default=self.current_time,
                )
                return MachineRunResult(
                    moves=tuple(MappingProxyType(deepcopy(move)) for move in moves),
                    makespan=makespan,
                    action_count=self._committed_action_count,
                    snapshot=self.get_state(),
                )
            actions = self.get_robot_actions()
            if not actions:
                raise MachineDeadlockError(self._deadlock_message())
            snapshot = self.get_state()
            choose = getattr(selector, "choose", None)
            action_id = (
                choose(snapshot, actions)
                if callable(choose)
                else selector(snapshot, actions)  # type: ignore[misc,operator]
            )
            self.apply_robot_action(
                str(action_id),
                expected_revision=snapshot.revision,
            )
        raise RuntimeError(f"Machine 超过最大决策次数 {maximum_decisions}")

    def export_movelist(self) -> list[dict]:
        """返回按统一时间轴排序、MoveID 稳定的 MoveList 副本。"""
        return [
            deepcopy(move)
            for move in sorted(
                self._moves,
                key=lambda move: (
                    float(move.get("StartTime") or 0.0),
                    int(move.get("MoveID") or 0),
                ),
            )
        ]

    def update_move_state(
        self,
        notification: Mapping[str, Any],
        *,
        snapshot: bool = True,
    ) -> Optional[MachineSnapshot]:
        """接收真实 Move 开始/结束通知并更新 Machine 的现场状态。

        第一次通知到达时，Machine 使用本代初始状态和已导出的 MoveList 创建
        兼容回放器。之后的重算可以直接保留其中 Running 的原子 Move。
        """
        from src.validation.replay import MoveStateReplay

        if self._replay is None:
            self._replay = MoveStateReplay(
                self.task,
                self.export_movelist(),
                self._initial_state,
            )
            self._replay.current_time = self.current_time
        self._replay.update_move_state(notification, snapshot=False)
        self.state = self._replay.state.clone()
        self.current_time = float(self._replay.current_time)
        self._active_moves = {
            move_id: deepcopy(self._replay._running[move_id])
            for move_id in self._replay.running_move_ids
        }
        self._revision += 1
        self._current_actions = {}
        return self.get_state() if snapshot else None

    def recompute(
        self,
        task: Problem,
        current_time: float,
        selector: "MachineSelector | Callable[[MachineSnapshot, Sequence[RobotAction]], str]",
        *,
        initial_state: Optional[MachineState] = None,
    ) -> MachineRunResult:
        """从当前通知现场取消未开始旧 Move，并立即生成下一代计划。

        Running Move 只投影自身完成效果；Machine 不执行其旧计划后继，也不
        要求切点达到关门或空手状态。新任务 ``task`` 必须已经包含仍在机的
        旧物料和本轮新增物料。实时层合入新物料后，可通过 ``initial_state``
        提供同一切点的扩展状态；这不会替换已提交 Move 历史或 MoveID 序列。
        """
        from src.validation.replay import MoveStateReplay

        cutoff = float(current_time)
        committed: list[dict] = []
        next_state = self.state.clone()
        if self._replay is not None:
            planned_by_id = {
                int(move["MoveID"]): move
                for move in self._replay.materialized_plan
                if isinstance(move.get("MoveID"), int)
            }
            for move_id in sorted(self._replay.running_move_ids):
                move = planned_by_id[move_id]
                self._replay.update_move_state(
                    {
                        "MoveID": move_id,
                        "MoveState": MoveStateReplay.DONE,
                        "EndTime": float(move.get("EndTime") or cutoff),
                    },
                    snapshot=False,
                )
            committed = self._replay.executed_moves
            next_state = self._replay.state.clone()
        else:
            committed = [
                deepcopy(move)
                for move in self._moves
                if float(move.get("StartTime") or 0.0) < cutoff - TIME_TOLERANCE
            ]
        if initial_state is not None:
            next_state = initial_state.clone()

        last_move_id = max(
            (
                int(move.get("MoveID") or 0)
                for move in [*self._moves, *committed]
            ),
            default=self._next_move_id - 1,
        )
        self.task = task
        self.state = next_state
        self.current_time = cutoff
        self._initial_state = next_state.clone()
        self._durations = Durations(task)
        self._wafer_by_material = {wafer.mat_id: wafer for wafer in task.wafers}
        self._moves = deepcopy(committed)
        self._active_moves = {}
        self._next_move_id = last_move_id + 1
        self._replay = None
        self._process_visits = {}
        self._post_clean_scheduled = False
        self._revision += 1
        self._current_actions = {}
        self._apply_runtime_availability()
        self._schedule_pre_cleaning()
        self._schedule_pending_services()
        return self.run(selector)

    def fork(self) -> "Machine":
        """复制完整规划状态，供 RL rollout 或前瞻搜索使用。"""
        cloned = Machine.__new__(Machine)
        cloned.task = deepcopy(self.task)
        cloned.state = self.state.clone()
        cloned.current_time = self.current_time
        cloned._initial_state = self._initial_state.clone()
        cloned._durations = Durations(cloned.task)
        cloned._wafer_by_material = {
            wafer.mat_id: wafer for wafer in cloned.task.wafers
        }
        cloned._moves = deepcopy(self._moves)
        cloned._active_moves = deepcopy(self._active_moves)
        cloned._revision = self._revision
        cloned._next_move_id = self._next_move_id
        cloned._committed_action_count = self._committed_action_count
        # 候选属于旧对象的只读预览；分支首次决策时按克隆状态重新枚举。
        cloned._current_actions = {}
        cloned._replay = None
        cloned._process_visits = deepcopy(self._process_visits)
        cloned._post_clean_scheduled = self._post_clean_scheduled
        return cloned

    def replace_problem(self, task: Problem, *, current_time: float) -> None:
        """在保留当前物理投影和资源日历的前提下切换任务集合。"""
        self.task = task
        self.current_time = float(current_time)
        self._durations = Durations(task)
        self._wafer_by_material = {wafer.mat_id: wafer for wafer in task.wafers}
        for wafer in task.wafers:
            for stage in wafer.stages:
                self.state.ensure_station(
                    stage.chamber,
                    int(stage.slot) + FIRST_SLOT_ID,
                )
        self._revision += 1
        self._current_actions = {}

    def preserve_running_moves(
        self,
        moves: Sequence[Mapping[str, Any]],
        *,
        cutoff: float,
    ) -> None:
        """在重算切点保留已经开始且尚未结束的原子 Move。

        未开始旧 Move 不进入 Machine；Running Move 的资源释放时间和预期物理
        效果投影到完成态，但 ``current_time`` 保持原始切点。
        """
        from src.validation.replay import MoveStateReplay

        running = [
            deepcopy(dict(move))
            for move in moves
            if float(move.get("StartTime") or 0.0) < float(cutoff) - TIME_TOLERANCE
            and float(move.get("EndTime") or 0.0) > float(cutoff) + TIME_TOLERANCE
        ]
        if not running:
            return
        replay = MoveStateReplay(self.task, running, self.state)
        for move in sorted(running, key=lambda item: float(item.get("StartTime") or 0.0)):
            replay.update_move_state(
                {
                    "MoveID": int(move["MoveID"]),
                    "MoveState": MoveStateReplay.RUNNING,
                    "StartTime": float(move.get("StartTime") or cutoff),
                },
                snapshot=False,
            )
        for move in sorted(running, key=lambda item: float(item.get("EndTime") or 0.0)):
            replay.update_move_state(
                {
                    "MoveID": int(move["MoveID"]),
                    "MoveState": MoveStateReplay.DONE,
                    "EndTime": float(move.get("EndTime") or cutoff),
                },
                snapshot=False,
            )
        self.state = replay.state.clone()
        self._active_moves = {int(move["MoveID"]): move for move in running}
        self._moves.extend(running)
        self._next_move_id = max(
            self._next_move_id,
            max((int(move["MoveID"]) for move in running), default=0) + 1,
        )
        self.current_time = float(cutoff)
        self._revision += 1

    def _material_locations(
        self,
    ) -> Dict[Any, Tuple[str, str, int, MaterialState, Optional[SlotPhase]]]:
        """建立物料到站点或机器人手槽的位置索引。"""
        result: Dict[
            Any,
            Tuple[str, str, int, MaterialState, Optional[SlotPhase]],
        ] = {}
        for station_name, station in self.state.stations.items():
            for slot_id, slot in station.slots.items():
                if slot.material is not None:
                    result[slot.material.material_id] = (
                        "station",
                        station_name,
                        slot_id,
                        slot.material,
                        slot.phase,
                    )
        for robot in self.state.robots.values():
            for slot_id, material in robot.hands.items():
                if material is not None:
                    result[material.material_id] = (
                        "robot",
                        robot.name,
                        slot_id,
                        material,
                        None,
                    )
        return result

    def _apply_runtime_availability(self) -> None:
        """把实时重算的相对释放下界写入 Machine 绝对资源日历。"""
        availability = self.task.runtime_availability
        if availability is None:
            return
        for station_name, ready_after in availability.station_ready.items():
            station = self.state.stations.get(station_name)
            if station is None:
                continue
            ready_at = self.current_time + max(float(ready_after), 0.0)
            station.door_busy_until = max(station.door_busy_until, ready_at)
            station.transfer_busy_until = max(station.transfer_busy_until, ready_at)
            station.environment_busy_until = max(
                station.environment_busy_until,
                ready_at,
            )
        for (station_name, slot_id), ready_after in availability.slot_ready.items():
            station = self.state.stations.get(station_name)
            if station is None:
                continue
            slot = station.slots.get(int(slot_id))
            if slot is not None:
                slot.busy_until = max(
                    slot.busy_until,
                    self.current_time + max(float(ready_after), 0.0),
                )
        for robot_name, ready_after in availability.robot_ready.items():
            robot = self.state.resolve_robot(robot_name)
            if robot is not None:
                robot.busy_until = max(
                    robot.busy_until,
                    self.current_time + max(float(ready_after), 0.0),
                )
        for robot_name, position in availability.robot_positions.items():
            robot = self.state.resolve_robot(robot_name)
            if robot is not None and position:
                robot.position = str(position)
        for material_id, ready_after in availability.material_ready.items():
            ready_at = self.current_time + max(float(ready_after), 0.0)
            for station in self.state.stations.values():
                for slot in station.slots.values():
                    if (
                        slot.material is not None
                        and slot.material.material_id == material_id
                    ):
                        slot.busy_until = max(slot.busy_until, ready_at)
        for station_name, environment in availability.loadlock_environment.items():
            station = self.state.stations.get(station_name)
            if isinstance(station, LoadLockState) and environment in {
                ATMOSPHERE,
                VACUUM,
            }:
                station.environment = environment

    @staticmethod
    def _empty_robot_slot(
        hands: Mapping[int, Optional[MaterialState]],
    ) -> Optional[int]:
        """返回编号最小的空机器人手槽。"""
        return next(
            (slot_id for slot_id, material in sorted(hands.items()) if material is None),
            None,
        )

    @staticmethod
    def _stage_index(
        wafer: Wafer,
        material: MaterialState,
        location: str,
    ) -> int:
        """由 StepID 或物理位置确定物料当前 Route 工序。"""
        if isinstance(material.step_id, int) and 0 <= material.step_id < len(wafer.stages):
            return int(material.step_id)
        matches = [
            index
            for index, stage in enumerate(wafer.stages)
            if stage.chamber == location or location in (stage.cands or ())
        ]
        if not matches:
            raise ValueError(
                f"MatID={wafer.mat_id} 的当前位置 {location} 不在 Route 中"
            )
        return max(matches)

    def _preview_transfer(
        self,
        *,
        wafer: Wafer,
        stage_index: int,
        robot_name: str,
        robot_slot: int,
        material: MaterialState,
        source_station: Optional[str],
        source_slot: Optional[int],
        destination_station: str,
        destination_slot: int,
        already_held: bool,
        swap_material: Optional[MaterialState],
        receive_robot_slot: Optional[int],
    ) -> Optional[RobotAction]:
        """在隔离资源日历上计算一个搬运意图的完整 Move 预览。"""
        robot = self.state.resolve_robot(robot_name)
        destination = self.state.stations[destination_station]
        following = wafer.stages[stage_index + 1]
        if robot is None:
            return None
        moves: list[dict] = []
        cursor = max(self.current_time, float(robot.busy_until))
        first_start: Optional[float] = None
        robot_position = robot.position

        def emit(move_type: int, start: float, end: float, **fields: Any) -> None:
            """向预览追加协议 Move，并记录事务首个起点。"""
            nonlocal first_start
            if first_start is None:
                first_start = start
            move = {
                "MoveType": move_type,
                "MoveID": self._next_move_id + len(moves),
                "StartTime": float(start),
                "EndTime": float(end),
                **fields,
            }
            moves.append(move)

        if not already_held:
            if not source_station or source_slot is None:
                return None
            source = self.state.stations.get(source_station)
            if source is None:
                return None
            source_state = source.slots[source_slot]
            cursor = max(
                cursor,
                float(source_state.busy_until),
                float(source.door_busy_until),
                float(source.transfer_busy_until),
                float(source.environment_busy_until),
            )
            if robot_position and robot_position != source_station:
                duration = self._durations.move(robot_name)
                emit(
                    PRE_TRANS_MOVE,
                    cursor,
                    cursor + duration,
                    ModuleName=robot_name,
                    Robot=robot_name,
                    RobotSlotList=[robot_slot],
                    SlotList=[source_slot],
                    SrcStationList=[robot_position],
                    DestStationList=[source_station],
                    MatIDList=[],
                )
                cursor += duration
            source_environment_changed = self._environment_change_required(
                source,
                robot_name,
            )
            cursor = self._append_environment_setup(
                moves,
                source,
                robot_name,
                source_slot,
                cursor,
                material_id=None,
            )
            if (
                not is_doorless_station(source_station)
                and (
                    source.door is DoorState.CLOSED
                    or source_environment_changed
                )
            ):
                duration = self._durations.pick_pre(robot_name, source_station)
                emit(
                    PREPARE_MOVE,
                    cursor,
                    cursor + duration,
                    ModuleName=source_station,
                    Station=source_station,
                    SlotList=[source_slot],
                    MatIDList=[material.material_id],
                    PJobName=[material.pjob_name],
                    RelatedActionType=RELATED_ACTION_PICK,
                    RelatedRobotType=self._related_robot_type(robot_name),
                )
                cursor += duration
            duration = self._durations.pick_t(robot_name, source_station)
            emit(
                PICK_MOVE,
                cursor,
                cursor + duration,
                ModuleName=robot_name,
                Robot=robot_name,
                RobotSlotList=[robot_slot],
                SlotList=[source_slot],
                SrcStationList=[source_station],
                SrcSlotList=[source_slot],
                MatIDList=[material.material_id],
                PJobName=[material.pjob_name],
            )
            cursor += duration
            if not is_doorless_station(source_station):
                duration = self._durations.pick_post(robot_name, source_station)
                emit(
                    COMPLETE_MOVE,
                    cursor,
                    cursor + duration,
                    ModuleName=source_station,
                    Station=source_station,
                    SlotList=[source_slot],
                    MatIDList=[material.material_id],
                    PJobName=[material.pjob_name],
                )
                cursor += duration
            robot_position = source_station

        cursor = max(
            cursor,
            float(destination.door_busy_until),
            float(destination.transfer_busy_until),
            float(destination.environment_busy_until),
            float(destination.slots[destination_slot].busy_until),
        )
        if robot_position and robot_position != destination_station:
            duration = self._durations.move(robot_name)
            emit(
                PRE_TRANS_MOVE,
                cursor,
                cursor + duration,
                ModuleName=robot_name,
                Robot=robot_name,
                RobotSlotList=[robot_slot],
                SlotList=[destination_slot],
                SrcStationList=[robot_position],
                DestStationList=[destination_station],
                MatIDList=[material.material_id],
                PJobName=[material.pjob_name],
            )
            cursor += duration
        destination_environment_changed = self._environment_change_required(
            destination,
            robot_name,
        )
        cursor = self._append_environment_setup(
            moves,
            destination,
            robot_name,
            destination_slot,
            cursor,
            material_id=None,
        )
        if (
            not is_doorless_station(destination_station)
            and (
                destination.door is DoorState.CLOSED
                or destination_environment_changed
            )
        ):
            duration = self._durations.place_pre(robot_name, destination_station)
            emit(
                PREPARE_MOVE,
                cursor,
                cursor + duration,
                ModuleName=destination_station,
                Station=destination_station,
                SlotList=[destination_slot],
                MatIDList=[material.material_id],
                PJobName=[material.pjob_name],
                RelatedActionType=(
                    RELATED_ACTION_SWAP
                    if swap_material is not None
                    else RELATED_ACTION_PLACE
                ),
                RelatedRobotType=self._related_robot_type(robot_name),
            )
            cursor += duration
        if swap_material is None:
            duration = self._durations.place_t(robot_name, destination_station)
            emit(
                PLACE_MOVE,
                cursor,
                cursor + duration,
                ModuleName=robot_name,
                Robot=robot_name,
                RobotSlotList=[robot_slot],
                SlotList=[destination_slot],
                DestStationList=[destination_station],
                DestSlotList=[destination_slot],
                MatIDList=[material.material_id],
                PJobName=[material.pjob_name],
                StepID=stage_index + 1,
            )
        else:
            if receive_robot_slot is None:
                return None
            duration = (
                self._durations.place_t(robot_name, destination_station)
                + self._durations.pick_t(robot_name, destination_station)
            )
            emit(
                SWAP_MOVE,
                cursor,
                cursor + duration,
                ModuleName=robot_name,
                Robot=robot_name,
                SlotList=[destination_slot],
                MatIDList=[swap_material.material_id, material.material_id],
                PJobName=[swap_material.pjob_name, material.pjob_name],
                StepIDList=[
                    swap_material.step_id,
                    stage_index + 1,
                ],
                StationList=[destination_station, destination_station],
                StnRecvSlotList=[destination_slot],
                StnSendSlotList=[destination_slot],
                RecvMatList=[swap_material.material_id],
                SendMatList=[material.material_id],
                RecvSlotList=[receive_robot_slot],
                SendSlotList=[robot_slot],
                SwapMode=0,
            )
        cursor += duration
        if not is_doorless_station(destination_station):
            duration = self._durations.place_post(robot_name, destination_station)
            emit(
                COMPLETE_MOVE,
                cursor,
                cursor + duration,
                ModuleName=destination_station,
                Station=destination_station,
                SlotList=[destination_slot],
                MatIDList=[material.material_id],
                PJobName=[material.pjob_name],
            )
            cursor += duration
        transfer_finish = cursor
        self._append_automatic_service(
            moves,
            following,
            destination,
            destination_slot,
            material,
            cursor,
            stage_index + 1,
        )
        action_id = (
            f"r{self._revision}:w{wafer.wid}:s{stage_index}:"
            f"{robot_name}:{source_station or 'held'}:{destination_station}:"
            f"{destination_slot}"
        )
        return RobotAction(
            revision=self._revision,
            action_id=action_id,
            kind=(
                "swap"
                if swap_material is not None
                else "held_place"
                if already_held
                else "transfer"
            ),
            robot=robot_name,
            material_ids=(
                (material.material_id, swap_material.material_id)
                if swap_material is not None
                else (material.material_id,)
            ),
            source_station=source_station,
            source_slot=source_slot,
            destination_station=destination_station,
            destination_slot=destination_slot,
            robot_slots=(
                (robot_slot, int(receive_robot_slot))
                if receive_robot_slot is not None
                else (robot_slot,)
            ),
            earliest_start=(
                float(first_start) if first_start is not None else self.current_time
            ),
            finish_time=float(transfer_finish),
            move_preview=tuple(_freeze(move) for move in moves),
            wafer_id=int(wafer.wid),
            stage_index=stage_index,
        )

    def _append_environment_setup(
        self,
        moves: list[dict],
        station: Any,
        robot_name: str,
        slot_id: int,
        cursor: float,
        *,
        material_id: Optional[Any],
    ) -> float:
        """按机器人所在侧为 LoadLock 自动补空抽或空充。"""
        if not isinstance(station, LoadLockState):
            return cursor
        required = (
            ATMOSPHERE
            if self._related_robot_type(robot_name) == RELATED_ROBOT_ATMOSPHERE
            else VACUUM
        )
        if station.environment == required:
            return cursor
        if station.door is DoorState.OPEN:
            close_duration = self._durations.pick_post(robot_name, station.name)
            moves.append({
                "MoveType": COMPLETE_MOVE,
                "MoveID": self._next_move_id + len(moves),
                "StartTime": float(cursor),
                "EndTime": float(cursor + close_duration),
                "ModuleName": station.name,
                "Station": station.name,
                "SlotList": [slot_id],
                "MatIDList": [],
            })
            cursor += close_duration
        chamber = self.task.chambers.get(station.name)
        duration = (
            float(chamber.vent_time or 0.0)
            if required == ATMOSPHERE and chamber is not None
            else float(chamber.pump_time or 0.0)
            if chamber is not None
            else 0.0
        )
        moves.append(
            {
                "MoveType": PRE_PREPARE_MOVE,
                "MoveID": self._next_move_id + len(moves),
                "StartTime": float(cursor),
                "EndTime": float(cursor + duration),
                "ModuleName": station.name,
                "Station": station.name,
                "SlotList": [slot_id],
                "MatIDList": [] if material_id is None else [material_id],
                "LastState": station.environment,
                "CurState": required,
            }
        )
        return cursor + duration

    def _environment_change_required(
        self,
        station: Any,
        robot_name: str,
    ) -> bool:
        """判断当前 Robot 访问 LoadLock 前是否必须切换压力态。"""
        if not isinstance(station, LoadLockState):
            return False
        required = (
            ATMOSPHERE
            if self._related_robot_type(robot_name) == RELATED_ROBOT_ATMOSPHERE
            else VACUUM
        )
        return station.environment != required

    def _append_automatic_service(
        self,
        moves: list[dict],
        stage: Stage,
        station: Any,
        slot_id: int,
        material: MaterialState,
        start: float,
        step_id: int,
    ) -> None:
        """放片后自动追加加工或带片压力转换。"""
        duration = max(float(stage.proc), 0.0)
        if duration <= TIME_TOLERANCE:
            return
        common = {
            "MoveID": self._next_move_id + len(moves),
            "StartTime": float(start),
            "EndTime": float(start + duration),
            "ModuleName": station.name,
            "Station": station.name,
            "SlotList": [slot_id],
            "MatIDList": [material.material_id],
            "PJobName": [material.pjob_name],
            "StepID": step_id,
        }
        if isinstance(station, LoadLockState):
            target = VACUUM if stage.ll_type == "entry" else ATMOSPHERE
            moves.append(
                {
                    "MoveType": PRE_PREPARE_MOVE,
                    **common,
                    "LastState": (
                        ATMOSPHERE if target == VACUUM else VACUUM
                    ),
                    "CurState": target,
                }
            )
        else:
            moves.append({"MoveType": PROCESS_MOVE, **common})

    def _apply_projected_action(
        self,
        action: RobotAction,
        committed_moves: Sequence[Mapping[str, Any]],
    ) -> None:
        """把已提交搬运及其自动服务投影到完成态和资源日历。"""
        material_id = action.material_ids[0]
        locations = self._material_locations()
        location = locations[material_id]
        material = location[3]
        if location[0] == "station":
            source = self.state.stations[location[1]]
            source_slot = source.slots[location[2]]
            source_slot.material = None
            source_slot.phase = SlotPhase.EMPTY
        else:
            source_robot = self.state.robots[location[1]]
            source_robot.hands[location[2]] = None

        destination = self.state.stations[action.destination_station]
        target_slot = destination.slots[action.destination_slot]
        outgoing_material = target_slot.material if action.kind == "swap" else None
        target_slot.material = MaterialState(
            material.material_id,
            material.pjob_name,
            action.stage_index + 1,
        )
        target_slot.phase = SlotPhase.COMPLETED
        target_slot.busy_until = max(
            target_slot.busy_until,
            max(
                (
                    float(move.get("EndTime") or action.finish_time)
                    for move in committed_moves
                    if str(move.get("Station") or "") == action.destination_station
                ),
                default=action.finish_time,
            ),
        )
        target_slot.busy_action = ""

        robot = self.state.resolve_robot(action.robot)
        if robot is not None:
            if action.kind == "swap" and outgoing_material is not None:
                send_slot, receive_slot = action.robot_slots
                robot.hands[send_slot] = None
                robot.hands[receive_slot] = outgoing_material
            robot.position = action.destination_station
            robot.busy_until = max(
                robot.busy_until,
                max(
                    (
                        float(move.get("EndTime") or action.finish_time)
                        for move in committed_moves
                        if str(move.get("Robot") or "") == action.robot
                    ),
                    default=action.finish_time,
                ),
            )
        for station_name in {
            str(move.get("Station") or "")
            for move in committed_moves
            if move.get("Station")
        }:
            station = self.state.stations.get(station_name)
            if station is None:
                continue
            related = [
                move
                for move in committed_moves
                if str(move.get("Station") or "") == station_name
            ]
            station.door = DoorState.CLOSED
            station.door_busy_until = max(
                station.door_busy_until,
                max(
                    (
                        float(move.get("EndTime") or 0.0)
                        for move in related
                        if move.get("MoveType") in {PREPARE_MOVE, COMPLETE_MOVE}
                    ),
                    default=0.0,
                ),
            )
            station.transfer_busy_until = max(
                station.transfer_busy_until,
                max(
                    (
                        float(move.get("EndTime") or 0.0)
                        for move in committed_moves
                        if (
                            move.get("MoveType") in {PICK_MOVE, PLACE_MOVE}
                            and station_name
                            in {
                                *(str(value) for value in move.get("SrcStationList") or []),
                                *(str(value) for value in move.get("DestStationList") or []),
                            }
                        )
                    ),
                    default=0.0,
                ),
            )
            environment_moves = [
                move
                for move in related
                if move.get("MoveType") == PRE_PREPARE_MOVE
            ]
            if isinstance(station, LoadLockState) and environment_moves:
                last = max(
                    environment_moves,
                    key=lambda move: float(move.get("EndTime") or 0.0),
                )
                station.environment = str(last.get("CurState") or station.environment)
                station.environment_busy_until = max(
                    station.environment_busy_until,
                    float(last.get("EndTime") or 0.0),
                )

    def _schedule_empty_clean(
        self,
        station_name: str,
        duration: float,
        *,
        recipe: str = "",
    ) -> None:
        """在指定站点最早空闲时追加一次无片清洁。"""
        station = self.state.stations.get(station_name)
        if station is None or duration <= TIME_TOLERANCE:
            return
        empty_slot = next(
            (
                (slot_id, slot)
                for slot_id, slot in sorted(station.slots.items())
                if slot.material is None
            ),
            None,
        )
        if empty_slot is None:
            return
        slot_id, slot = empty_slot
        start = max(
            self.current_time,
            station.door_busy_until,
            station.transfer_busy_until,
            slot.busy_until,
        )
        end = start + float(duration)
        self._moves.append({
            "MoveType": PROCESS_MOVE,
            "MoveID": self._next_move_id,
            "StartTime": start,
            "EndTime": end,
            "ModuleName": station_name,
            "Station": station_name,
            "SlotList": [slot_id],
            "MatIDList": [],
            "RecipeName": recipe,
        })
        self._next_move_id += 1
        slot.phase = SlotPhase.CLEANED
        slot.busy_until = end
        slot.busy_action = ""

    def _schedule_pre_cleaning(self) -> None:
        """把 PJob 前清洁作为 Machine 初始自动事件写入资源日历。"""
        for clean in self.task.pre_clean:
            for station_name in clean.visits:
                self._schedule_empty_clean(
                    str(station_name),
                    float(clean.time),
                    recipe=str(clean.recipe or ""),
                )

    def _schedule_pending_services(self) -> None:
        """为非稳定初态中已放入但尚未加工的物料补关门和自动服务。"""
        for station in self.state.stations.values():
            for slot_id, slot in station.slots.items():
                material = slot.material
                if material is None or slot.phase is not SlotPhase.UNPROCESSED:
                    continue
                wafer = self._wafer_by_material.get(material.material_id)
                if wafer is None:
                    continue
                stage_index = self._stage_index(wafer, material, station.name)
                stage = wafer.stages[stage_index]
                cursor = max(
                    self.current_time,
                    station.door_busy_until,
                    station.transfer_busy_until,
                    station.environment_busy_until,
                    slot.busy_until,
                )
                if (
                    station.door is DoorState.OPEN
                    and not is_doorless_station(station.name)
                ):
                    robot_name = str(stage.in_robot or stage.out_robot or "")
                    duration = (
                        self._durations.place_post(robot_name, station.name)
                        if robot_name
                        else 0.0
                    )
                    self._moves.append({
                        "MoveType": COMPLETE_MOVE,
                        "MoveID": self._next_move_id,
                        "StartTime": cursor,
                        "EndTime": cursor + duration,
                        "ModuleName": station.name,
                        "Station": station.name,
                        "SlotList": [slot_id],
                        "MatIDList": [material.material_id],
                        "PJobName": [material.pjob_name],
                    })
                    self._next_move_id += 1
                    cursor += duration
                    station.door = DoorState.CLOSED
                    station.door_busy_until = cursor
                automatic_moves: list[dict] = []
                self._append_automatic_service(
                    automatic_moves,
                    stage,
                    station,
                    slot_id,
                    material,
                    cursor,
                    stage_index,
                )
                self._moves.extend(automatic_moves)
                self._next_move_id += len(automatic_moves)
                service_end = max(
                    (
                        float(move.get("EndTime") or cursor)
                        for move in automatic_moves
                    ),
                    default=cursor,
                )
                slot.phase = SlotPhase.COMPLETED
                slot.busy_until = max(slot.busy_until, service_end)
                if isinstance(station, LoadLockState) and automatic_moves:
                    station.environment = str(
                        automatic_moves[-1].get(
                            "CurState",
                            station.environment,
                        )
                    )
                    station.environment_busy_until = max(
                        station.environment_busy_until,
                        service_end,
                    )

    def _schedule_post_cleaning(self) -> None:
        """所有物料完成后自动追加 PJob 后清洁。"""
        if self._post_clean_scheduled:
            return
        self._post_clean_scheduled = True
        for clean in self.task.post_clean:
            for station_name in clean.visits:
                self._schedule_empty_clean(
                    str(station_name),
                    float(clean.time),
                    recipe=str(clean.recipe or ""),
                )

    def _schedule_periodic_cleaning(self, action: RobotAction) -> None:
        """物料离开触发工序后，自动追加 dummy-WAC 或周期 WAC。"""
        wafer = next(
            (
                item
                for item in self.task.wafers
                if int(item.wid) == int(action.wafer_id)
            ),
            None,
        )
        if wafer is None or action.stage_index >= len(wafer.stages):
            return
        stage = wafer.stages[action.stage_index]
        if action.source_station and wafer.pjob_name in self.task.dummy_owner:
            for clean in self.task.dummy_wac:
                if action.source_station in clean.visits:
                    self._schedule_empty_clean(
                        action.source_station,
                        float(clean.time),
                        recipe=str(clean.recipe or ""),
                    )
        if (
            stage.stage_type != "process"
            or float(stage.clean_time) <= TIME_TOLERANCE
            or int(stage.clean_trigger) <= 0
            or not action.source_station
        ):
            return
        key = (action.source_station, int(stage.slot) + FIRST_SLOT_ID)
        visits = self._process_visits.get(key, 0) + 1
        self._process_visits[key] = visits
        if visits % int(stage.clean_trigger) != 0:
            return
        self._schedule_empty_clean(
            action.source_station,
            float(stage.clean_time),
            recipe=str(stage.clean_recipe or ""),
        )

    def _related_robot_type(self, robot_name: str) -> int:
        """返回 MoveList 使用的大气侧或真空侧 Robot 类型。"""
        return (
            RELATED_ROBOT_ATMOSPHERE
            if robot_name in self._durations.atm_robots
            else RELATED_ROBOT_VACUUM
        )

    def _is_done(self) -> bool:
        """判断所有已知任务物料是否位于 Route 终点。"""
        locations = self._material_locations()
        for material_id, wafer in self._wafer_by_material.items():
            location = locations.get(material_id)
            if location is None:
                return False
            if self._stage_index(wafer, location[3], location[1]) < len(wafer.stages) - 1:
                return False
        return True

    def _close_orphan_doors(self) -> None:
        """在终态为没有后继意图的开门站补关门动作。"""
        for station in self.state.stations.values():
            if is_doorless_station(station.name) or station.door is DoorState.CLOSED:
                continue
            start = max(
                self.current_time,
                station.door_busy_until,
                station.transfer_busy_until,
            )
            duration = max(
                (
                    self._durations.pick_post(robot.name, station.name)
                    for robot in self.state.robots.values()
                    if not robot.scope or station.name in robot.scope
                ),
                default=0.0,
            )
            self._moves.append(
                {
                    "MoveType": COMPLETE_MOVE,
                    "MoveID": self._next_move_id,
                    "StartTime": start,
                    "EndTime": start + duration,
                    "ModuleName": station.name,
                    "Station": station.name,
                    "SlotList": [FIRST_SLOT_ID],
                    "MatIDList": [],
                }
            )
            self._next_move_id += 1
            station.door = DoorState.CLOSED
            station.door_busy_until = start + duration

    def _deadlock_message(self) -> str:
        """生成包含物料位置和阶段的可诊断死锁信息。"""
        pending = []
        for material_id, wafer in self._wafer_by_material.items():
            location = self._material_locations().get(material_id)
            if location is None:
                pending.append(f"{material_id}:missing")
                continue
            stage = self._stage_index(wafer, location[3], location[1])
            if stage < len(wafer.stages) - 1:
                pending.append(
                    f"{material_id}:{location[1]}#{location[2]}@step{stage}"
                )
        return f"Machine 无可执行搬运意图：{pending[:12]}"


__all__ = [
    "Machine",
    "MachineDeadlockError",
    "MachineRunResult",
    "MachineSelector",
    "MachineSnapshot",
    "MaterialView",
    "RobotAction",
    "RobotView",
    "StaleRobotActionError",
    "StationView",
    "UnknownRobotActionError",
]
