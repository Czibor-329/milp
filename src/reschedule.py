"""实时重算：投影在途动作状态，从请求时刻并行生成带资源释放下界的续排。

重算保留已经运行的 Move 和必要搬运收尾链，投影到门关闭、Robot 空手的状态；新计划仍从
原请求时刻开始，受旧动作影响的站点、槽位、Robot 和晶圆分别等待各自的释放时刻。
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from src.export import export_movelist
from src.model import Durations, Problem, RuntimeAvailability, Stage, Wafer
from src.parse import parse_task
from src.timing import start_schedule, start_schedule_by_rl
from src.validation import MoveStateReplay, populate_premove_ids, validate_move_list
from src.validation.move_fields import (
    COMPLETE_MOVE, PICK_MOVE, PLACE_MOVE, PREPARE_MOVE, PRE_PREPARE_MOVE,
    PROCESS_MOVE, SWAP_MOVE, sort_key,
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
)


TIME_TOLERANCE = 1e-6
FIRST_SLOT_ID = 1


@dataclass(frozen=True)
class RecomputePoint:
    """一次重算在统一时间轴上的显示信息。"""

    time: float
    effective_time: float
    index: int
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        """转换成 MoveList 文件中的 ``RecomputePoints`` 行。"""
        return {
            "Time": self.time,
            "EffectiveTime": self.effective_time,
            "ScheduleStartTime": self.time,
            "RecoveryEndTime": self.effective_time,
            "Index": self.index,
            "Reason": self.reason,
        }


class RealtimeRescheduler:
    """维护一台设备的当前计划，并提供通知更新与新增任务重算接口。"""

    def __init__(
        self,
        tool_topo: Mapping[str, Any],
        update_params: Mapping[str, Any],
        init_data: Optional[Mapping[str, Any]] = None,
        *,
        strategy: str = "heuristic",
        policy: Any = None,
        rl_search_seconds: float = 4.0,
        rl_rollouts: int = 256,
        rl_temperature: float = 0.7,
        seed: int = 0,
    ) -> None:
        """解析首批任务，并用所选顶层策略立即生成第一段计划。"""
        if strategy not in {"heuristic", "rl"}:
            raise ValueError(f"实时重算只支持 heuristic/rl，收到 strategy={strategy}")
        if strategy == "rl" and policy is None:
            raise ValueError("RL 实时重算缺少已加载策略模型")
        self.tool_topo = deepcopy(dict(tool_topo))
        self.strategy = strategy
        self.policy = policy
        self.rl_search_seconds = float(rl_search_seconds)
        self.rl_rollouts = int(rl_rollouts)
        self.rl_temperature = float(rl_temperature)
        self.seed = int(seed)
        self.problem = parse_task(self.tool_topo, update_params)
        _apply_material_start_slots(self.problem, update_params)
        start_time = float(update_params.get("CurrentTime") or 0.0)
        initial_state = MachineState.from_sources(self.problem, init_data)
        self._history: List[dict] = []
        self._points: List[RecomputePoint] = []
        self._current_plan = self._schedule_segment(self.problem, initial_state, start_time)
        self._next_move_id = max((int(move["MoveID"]) for move in self._current_plan), default=0) + 1
        self._tracker = MoveStateReplay(self.problem, self._current_plan, initial_state)
        self._tracker.current_time = start_time

    @property
    def current_plan(self) -> List[dict]:
        """返回当前有效计划；调用方不应再执行此前被重算取消的 Move。"""
        return [dict(move) for move in self._tracker.materialized_plan]

    @property
    def state(self) -> MachineState:
        """返回当前整机状态的隔离快照。"""
        return self._tracker.state.clone()

    @property
    def state_time(self) -> float:
        """返回当前状态已经推进到的绝对时间，不允许后续重算回退到该时刻之前。"""
        return float(self._tracker.current_time)

    @property
    def running_move_ids(self) -> frozenset[int]:
        """返回当前计划中已经开始但尚未完成的 MoveID。"""
        return self._tracker.running_move_ids

    @property
    def can_recompute(self) -> bool:
        """返回当前状态是否满足无运行 Move、门全关且 Robot 空手。"""
        if self._tracker.running_move_ids:
            return False
        if any(station.door is not DoorState.CLOSED for station in self._tracker.state.stations.values()):
            return False
        robots_empty = all(
            material is None
            for robot in self._tracker.state.robots.values()
            for material in robot.hands.values()
        )
        return robots_empty

    def update_move_state(self, notification: Mapping[str, Any]) -> MachineState:
        """接收外部 Move 开始/结束通知并更新 ``src.validation.state`` 状态。"""
        return self._tracker.update_move_state(notification)

    def recompute(
        self,
        new_update_params: Mapping[str, Any],
        current_time: float,
        *,
        reason: str = "new_job",
        cutoff_time: Optional[float] = None,
        schedule_start_time: Optional[float] = None,
        material_ready_times: Optional[Mapping[int, float]] = None,
    ) -> Dict[str, Any]:
        """在投影稳定状态加入新任务，并从请求时刻带资源释放下界续排。

        ``cutoff_time`` 是外部请求重算的时刻；调用方必须继续执行旧计划，直到
        ``current_time`` 所指的收尾完成时刻。``schedule_start_time`` 是新计划时间原点，
        通常等于请求时刻；受收尾动作影响的资源和物料由运行时下界推迟，其余资源可在
        请求时刻后立即工作。甘特图重算线仍画在原始请求时刻。
        """
        timestamp = float(current_time)
        cutoff = timestamp if cutoff_time is None else float(cutoff_time)
        schedule_start = timestamp if schedule_start_time is None else float(schedule_start_time)
        if cutoff > timestamp + TIME_TOLERANCE:
            raise ValueError("重算触发时间不能晚于状态稳定时间")
        if schedule_start < cutoff - TIME_TOLERANCE or schedule_start > timestamp + TIME_TOLERANCE:
            raise ValueError("新计划起点必须位于重算触发时间与收尾完成时间之间")
        self._ensure_safe_cut(timestamp, cutoff)
        snapshot = self._tracker.state.clone()
        new_problem = parse_task(self.tool_topo, new_update_params)
        _apply_material_start_slots(new_problem, new_update_params)
        combined_problem, next_state = _build_recompute_problem(self.problem, new_problem, snapshot)
        combined_problem.runtime_availability = _runtime_availability(
            next_state,
            schedule_start,
            material_ready_times or {},
        )

        self._history.extend(self._tracker.executed_moves)
        self._points.append(RecomputePoint(cutoff, timestamp, len(self._points) + 1, reason))
        new_segment = self._schedule_segment(combined_problem, next_state, schedule_start)
        new_segment, self._next_move_id = _renumber_segment(new_segment, self._next_move_id)

        self.problem = combined_problem
        self._current_plan = new_segment
        self._tracker = MoveStateReplay(combined_problem, new_segment, next_state)
        self._tracker.current_time = schedule_start
        return self.combined_output()

    def combined_output(self) -> Dict[str, Any]:
        """返回已执行历史和当前有效计划拼成的统一 MoveList。"""
        moves = [dict(move) for move in self._history]
        moves.extend(self._tracker.materialized_plan)
        moves.sort(key=sort_key)
        for move in moves:
            move["PreMoveID"] = []
        populate_premove_ids(moves)
        return {
            "MoveList": moves,
            "RecomputePoints": [point.to_dict() for point in self._points],
        }

    def _ensure_safe_cut(self, timestamp: float, execution_cutoff: float) -> None:
        """确认触发点前通知完整，且稳定时刻可直接作为 timing 新起点。"""
        if self._tracker.running_move_ids:
            running = sorted(self._tracker.running_move_ids)
            raise ValueError(f"重算点仍有运行中 Move：{running}；请先发送结束通知")
        if timestamp + TIME_TOLERANCE < self._tracker.current_time:
            raise ValueError("重算时间不能早于最后一条 Move 通知")
        executed_ids = {int(done["MoveID"]) for done in self._tracker.executed_moves}
        missing = [
            int(move["MoveID"])
            for move in self._current_plan
            if float(move.get("StartTime") or 0.0) < execution_cutoff - TIME_TOLERANCE
            and int(move.get("MoveID", -1)) not in executed_ids
        ]
        if missing:
            raise ValueError(f"重算点之前存在未上报 Move：{missing[:8]}")
        open_doors = [name for name, station in self._tracker.state.stations.items()
                      if station.door is not DoorState.CLOSED]
        held = [f"{robot.name}#{slot_id}" for robot in self._tracker.state.robots.values()
                for slot_id, material in robot.hands.items() if material is not None]
        if open_doors or held:
            raise ValueError(f"重算点不是稳定状态：开门={open_doors}，机械手持片={held}")

    def _schedule_segment(self, problem: Problem, state: MachineState, offset: float) -> List[dict]:
        """用所选顶层策略和 timing 定时生成一段绝对时间计划。"""
        if self.strategy == "rl":
            result = start_schedule_by_rl(
                problem,
                self.policy,
                seed=self.seed,
                search_seconds=self.rl_search_seconds,
                max_rollouts=self.rl_rollouts,
                temp=self.rl_temperature,
                verbose=False,
            )
        else:
            result = start_schedule(problem, verbose=False)
        if not getattr(result, "feasible", False):
            raise RuntimeError(f"{self.strategy} 重算未找到可行计划")
        moves = export_movelist(problem, result, state)
        moves = _serialize_initial_processing(moves, state)
        moves = _repair_loadlock_prepare_overlap(moves, state)
        moves = _prepend_environment_setups(problem, moves, state)
        shifted = _shift_moves(moves, offset)
        issues = validate_move_list(problem, shifted, state)
        if issues:
            raise RuntimeError(f"重算 MoveList 状态校验失败：{issues[0]}")
        return shifted


def _build_recompute_problem(
    previous: Problem,
    incoming: Problem,
    state: MachineState,
) -> Tuple[Problem, MachineState]:
    """从稳定状态裁剪旧晶圆前缀，并与新任务合成下一轮 Problem。"""
    next_state = state.clone()
    locations = _material_locations(next_state)
    residual: List[Wafer] = []
    started_cjobs = set()
    old_locations = []
    for wafer in previous.wafers:
        location = locations.get(wafer.mat_id)
        if location is None:
            raise ValueError(f"状态中找不到旧任务物料 MatID={wafer.mat_id}")
        station_name, slot_id, slot = location
        stage_index = _current_stage_index(wafer, station_name, slot_id, slot.material)
        old_locations.append((wafer, stage_index))
        if stage_index > 0 or wafer.already_released:
            started_cjobs.add(wafer.cjob_id)
        if stage_index == len(wafer.stages) - 1 and wafer.stages[stage_index].stage_type == "sink":
            continue
        residual.append(_trim_wafer(wafer, stage_index, station_name, slot.phase))
        if slot.material is not None:
            slot.material.step_id = 0

    incoming_wafers = [deepcopy(wafer) for wafer in incoming.wafers]
    highest_ids = {
        wafer.cjob_id for wafer in incoming_wafers if wafer.cjob_job_type == 2
    }
    higher_ids = {
        wafer.cjob_id for wafer in incoming_wafers if wafer.cjob_job_type == 3
    }
    for wafer in residual:
        blockers = set(wafer.dispatch_after)
        if wafer.cjob_id not in started_cjobs:
            blockers.update(highest_ids)
            blockers.update(higher_ids)
        wafer.dispatch_after = tuple(sorted(blockers))
    for wafer in incoming_wafers:
        blockers = set(wafer.dispatch_after)
        if wafer.cjob_job_type == 3:
            blockers.update(cjob for cjob in started_cjobs if cjob)
        wafer.dispatch_after = tuple(sorted(blockers))
    _assign_incoming_resources(incoming_wafers, next_state, previous.chambers)
    existing_material_ids = set(locations)
    new_material_ids = {wafer.mat_id for wafer in incoming_wafers}
    duplicates = sorted(existing_material_ids & new_material_ids)
    if duplicates:
        raise ValueError(f"新增任务 MatID 与在机物料重复：{duplicates[:8]}")
    _add_incoming_materials(next_state, incoming_wafers)

    wafers = residual + incoming_wafers
    for wid, wafer in enumerate(wafers):
        wafer.wid = wid
    problem = Problem(
        chambers=previous.chambers,
        robots=previous.robots,
        wafers=wafers,
        pre_clean=list(incoming.pre_clean),
        post_clean=list(previous.post_clean) + list(incoming.post_clean),
        dummy_wac=list(previous.dummy_wac) + list(incoming.dummy_wac),
        dummy_owner={**previous.dummy_owner, **incoming.dummy_owner},
    )
    for wafer in problem.wafers:
        for stage in wafer.stages:
            next_state.ensure_station(stage.chamber, stage.slot + FIRST_SLOT_ID)
    return problem, next_state


def _apply_material_start_slots(problem: Problem, update_params: Mapping[str, Any]) -> None:
    """把接口 Materials.SlotID 写回实时任务的源/汇槽，避免多轮新增片占用同一槽。"""
    slots_by_material = {
        material.get("ID"): int(material["SlotID"]) - FIRST_SLOT_ID
        for material in (update_params.get("Materials") or [])
        if isinstance(material, Mapping)
        and material.get("ID") is not None
        and isinstance(material.get("SlotID"), int)
        and int(material["SlotID"]) >= FIRST_SLOT_ID
    }
    for wafer in problem.wafers:
        slot = slots_by_material.get(wafer.mat_id)
        if slot is None or not wafer.stages:
            continue
        source = wafer.stages[0]
        source.slot = slot
        sink = wafer.stages[-1]
        if sink.stage_type == "sink" and sink.chamber == source.chamber:
            sink.slot = slot


def _material_locations(state: MachineState) -> Dict[Any, Tuple[str, int, SlotState]]:
    """建立稳定状态中的 MatID 到站点槽位索引，并拒绝机械手持片切点。"""
    locations: Dict[Any, Tuple[str, int, SlotState]] = {}
    for robot in state.robots.values():
        if any(material is not None for material in robot.hands.values()):
            raise ValueError(f"{robot.name} 仍持片，不能直接构造续排 Problem")
    for station_name, station in state.stations.items():
        for slot_id, slot in station.slots.items():
            if slot.material is None:
                continue
            material_id = slot.material.material_id
            if material_id in locations:
                raise ValueError(f"MatID={material_id} 同时出现在多个槽位")
            locations[material_id] = (station_name, slot_id, slot)
    return locations


def _current_stage_index(
    wafer: Wafer,
    station_name: str,
    slot_id: int,
    material: Optional[MaterialState],
) -> int:
    """优先按 StepID，缺失时按当前站点和槽位恢复晶圆所在工序。"""
    if material is not None and isinstance(material.step_id, int):
        index = material.step_id
        if 0 <= index < len(wafer.stages) and wafer.stages[index].chamber == station_name:
            return index
    slot_index = slot_id - FIRST_SLOT_ID
    matches = [
        index for index, stage in enumerate(wafer.stages)
        if stage.chamber == station_name and stage.slot == slot_index
    ]
    if not matches:
        matches = [index for index, stage in enumerate(wafer.stages) if stage.chamber == station_name]
    if not matches:
        raise ValueError(f"MatID={wafer.mat_id} 的当前站点 {station_name} 不在剩余路线中")
    return max(matches)


def _trim_wafer(wafer: Wafer, stage_index: int, station_name: str, phase: SlotPhase) -> Wafer:
    """把旧晶圆已经完成的路线前缀裁掉，并以当前槽位作为新起点。"""
    stages = [deepcopy(stage) for stage in wafer.stages[stage_index:]]
    first = stages[0]
    first.chamber = station_name
    first.in_robot = ""
    first.cands = [station_name]
    if phase is SlotPhase.COMPLETED:
        first.stage_type = "source"
        first.proc = 0.0
        first.residency = -1.0
        first.ll_type = ""
        first.clean_time = 0.0
        first.clean_trigger = 0
        first.clean_recipe = ""
    elif phase is not SlotPhase.UNPROCESSED:
        raise ValueError(f"MatID={wafer.mat_id} 当前槽位状态 {phase} 不能续排")
    for index, stage in enumerate(stages):
        stage.j = index
    transports = list(wafer.transports[stage_index:])
    return Wafer(
        wid=wafer.wid,
        mat_id=wafer.mat_id,
        route_name=wafer.route_name,
        route_rank=wafer.route_rank,
        stages=stages,
        transports=transports,
        pjob_name=wafer.pjob_name,
        cjob_id=wafer.cjob_id,
        cjob_job_type=wafer.cjob_job_type,
        cjob_priority=wafer.cjob_priority,
        already_released=wafer.already_released or stage_index > 0,
        resume_stage_index=wafer.resume_stage_index + stage_index,
        dispatch_after=tuple(wafer.dispatch_after),
    )


def _add_incoming_materials(state: MachineState, wafers: Sequence[Wafer]) -> None:
    """把新增任务的首工序物料放入当前状态，供续排 MoveList 校验。"""
    for wafer in wafers:
        if not wafer.stages:
            continue
        first = wafer.stages[0]
        slot_id = first.slot + FIRST_SLOT_ID
        station = state.ensure_station(first.chamber, slot_id)
        slot = station.slots[slot_id]
        if slot.material is not None:
            raise ValueError(f"新增 MatID={wafer.mat_id} 的起始槽位 {first.chamber}#{slot_id} 已占用")
        station.slots[slot_id] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(wafer.mat_id, wafer.pjob_name, 0),
        )


def _station_release_time(state: MachineState, station_name: str) -> float:
    """返回实时状态中站点最后一次释放资源的绝对时刻。"""
    station = state.stations.get(station_name)
    if station is None:
        return 0.0
    return max(
        float(station.door_busy_until),
        float(station.transfer_busy_until),
        float(station.environment_busy_until),
        *(float(slot.busy_until) for slot in station.slots.values()),
    )


def _station_material_count(state: MachineState, station_name: str) -> int:
    """返回站点当前仍未搬出的物料数，作为续排初始负载。"""
    station = state.stations.get(station_name)
    if station is None:
        return 0
    return sum(slot.material is not None for slot in station.slots.values())


def _assign_incoming_resources(
    wafers: Sequence[Wafer],
    state: MachineState,
    chambers: Mapping[str, Any],
) -> None:
    """让新增任务延续实时设备的并行腔负载，而不是从候选列表首项重新开始。

    解析单轮任务时的 round-robin 会从零开始；重算若直接沿用，上一轮最后使用 PM1 后，
    下一轮第一片仍会再次落到 PM1。这里以实时状态中的当前占用量和最后释放时刻为基线，
    对同一候选池连续轮转：负载相同时优先选择更早释放的腔室。LoadLock 的进/出 stage
    对同一晶圆保持同腔，同时保留完整候选集，避免把整批新增片永久绑定到 LA。
    """
    assigned: Dict[Tuple[str, Tuple[str, ...]], Dict[str, int]] = {}

    def choose(kind: str, candidates: Sequence[str], *, prefer_atmosphere: bool = False) -> str:
        pool = tuple(sorted(dict.fromkeys(str(name) for name in candidates if name)))
        if not pool:
            return ""
        key = (kind, pool)
        loads = assigned.setdefault(
            key,
            {
                name: _station_material_count(state, name)
                + int(
                    prefer_atmosphere
                    and isinstance(state.stations.get(name), LoadLockState)
                    and state.stations[name].environment != ATMOSPHERE
                )
                for name in pool
            },
        )
        chosen = min(pool, key=lambda name: (loads[name], _station_release_time(state, name), name))
        loads[chosen] += 1
        return chosen

    for wafer in wafers:
        loadlock_stages = [stage for stage in wafer.stages if stage.stage_type == "loadlock"]
        if loadlock_stages:
            common_candidates = set(loadlock_stages[0].cands or [loadlock_stages[0].chamber])
            for stage in loadlock_stages[1:]:
                common_candidates &= set(stage.cands or [stage.chamber])
            candidates = [
                name for name in common_candidates
                if isinstance(state.stations.get(name), LoadLockState)
            ]
            chosen = choose("loadlock", candidates, prefer_atmosphere=True)
            if chosen:
                for stage in loadlock_stages:
                    stage.chamber = chosen
                    # 保留 Route 的完整候选集；RL/后续 timing 仍可在合法候选中决策。
                    stage.cands = list(stage.cands or [chosen])
                    stage.slot = 0 if stage.ll_type == "entry" else 1
                    chamber = chambers.get(chosen)
                    if chamber is not None:
                        duration = chamber.pump_time if stage.ll_type == "entry" else chamber.vent_time
                        if duration is not None:
                            stage.proc = float(duration)

        for stage in wafer.stages:
            if stage.stage_type != "process":
                continue
            candidates = [name for name in (stage.cands or [stage.chamber]) if name in chambers]
            chosen = choose("process", candidates)
            if chosen:
                stage.chamber = chosen
                stage.cands = list(stage.cands or [chosen])


def _runtime_availability(
    state: MachineState,
    schedule_start: float,
    material_ready_times: Mapping[int, float],
) -> RuntimeAvailability:
    """把投影状态中的绝对占用终点转换成相对新计划起点的下界。

    站点共享资源与槽位占用分别保留，避免一个槽位的在途加工无谓锁死同模块
    的其他槽；Robot 位置同时传给 timing，用于判断首个空载转位是否需要留时。
    """
    origin = float(schedule_start)

    def relative(timestamp: float) -> float:
        """把绝对释放时刻转换为不小于零的相对秒数。"""
        return max(0.0, float(timestamp) - origin)

    station_ready = {
        name: relative(max(
            float(station.door_busy_until),
            float(station.transfer_busy_until),
            float(station.environment_busy_until),
        ))
        for name, station in state.stations.items()
    }
    slot_ready = {
        (name, slot_id): relative(slot.busy_until)
        for name, station in state.stations.items()
        for slot_id, slot in station.slots.items()
    }
    robot_ready = {
        name: relative(robot.busy_until)
        for name, robot in state.robots.items()
    }
    robot_positions = {
        name: str(robot.position)
        for name, robot in state.robots.items()
        if robot.position
    }
    material_ready = {
        int(material_id): relative(timestamp)
        for material_id, timestamp in material_ready_times.items()
    }
    return RuntimeAvailability(
        station_ready={name: value for name, value in station_ready.items() if value > TIME_TOLERANCE},
        slot_ready={key: value for key, value in slot_ready.items() if value > TIME_TOLERANCE},
        robot_ready={name: value for name, value in robot_ready.items() if value > TIME_TOLERANCE},
        robot_positions=robot_positions,
        material_ready={key: value for key, value in material_ready.items() if value > TIME_TOLERANCE},
    )


def _shift_moves(moves: Sequence[Mapping[str, Any]], offset: float) -> List[dict]:
    """把 timing 的相对时间平移到实时调度绝对时间轴。"""
    shifted: List[dict] = []
    for raw_move in moves:
        move = dict(raw_move)
        move["StartTime"] = float(move.get("StartTime") or 0.0) + offset
        move["EndTime"] = float(move.get("EndTime") or 0.0) + offset
        shifted.append(move)
    return shifted


def _prepend_environment_setups(
    problem: Problem,
    moves: Sequence[Mapping[str, Any]],
    state: MachineState,
) -> List[dict]:
    """补齐 LoadLock 整段时间线中的环境转换，并为转换后的动作让出窗口。

    续排首 stage 可能是已经留在 LoadLock 内的 source，timing 的常规相邻占用
    看不到它此前形成的 ATM/VAC 状态。这里按时间回放每次开门和抽充气；发现
    当前环境不满足下一动作时，在该动作原起点插入空抽/空充，并把此后的全局
    动作顺延相应时长，从而保持既有资源先后关系。
    """
    repaired = [dict(move) for move in moves]
    loadlocks = {
        name: station
        for name, station in state.stations.items()
        if isinstance(station, LoadLockState)
    }
    if not loadlocks:
        return repaired

    while True:
        environments = {name: station.environment for name, station in loadlocks.items()}
        events: List[Tuple[float, int, str, str, Optional[str]]] = []
        for move in repaired:
            station_name = str(move.get("Station") or move.get("ModuleName") or "")
            if station_name not in loadlocks:
                continue
            move_type = move.get("MoveType")
            if move_type == PREPARE_MOVE:
                related_robot_type = move.get("RelatedRobotType")
                required = (
                    ATMOSPHERE if related_robot_type == 0
                    else VACUUM if related_robot_type == 1
                    else ""
                )
                if required:
                    events.append((float(move.get("StartTime") or 0.0), 1,
                                   station_name, required, None))
            elif move_type == PRE_PREPARE_MOVE:
                last_state = str(move.get("LastState") or "").upper()
                current_state = str(move.get("CurState") or "").upper()
                if last_state in {ATMOSPHERE, VACUUM} and current_state in {ATMOSPHERE, VACUUM}:
                    events.append((float(move.get("StartTime") or 0.0), 1,
                                   station_name, last_state, None))
                    events.append((float(move.get("EndTime") or 0.0), 0,
                                   station_name, last_state, current_state))

        mismatch: Optional[Tuple[float, str, str, str]] = None
        for event_time, priority, station_name, required, resulting in sorted(events):
            current = environments[station_name]
            if priority == 0:
                environments[station_name] = resulting or required
                continue
            if current != required:
                mismatch = (event_time, station_name, current, required)
                break
        if mismatch is None:
            break

        cut_time, station_name, last_state, required_state = mismatch
        chamber = problem.chambers.get(station_name)
        duration = 0.0
        if chamber is not None:
            duration = float(
                (chamber.vent_time if last_state == VACUUM else chamber.pump_time) or 0.0
            )
        if duration <= TIME_TOLERANCE:
            raise RuntimeError(
                f"{station_name} 缺少 {last_state}->{required_state} 的环境转换时长"
            )

        def uses_station(move: Mapping[str, Any]) -> bool:
            """判断 Move 是否占用当前待修复 LoadLock。"""
            return station_name in {
                str(move.get("Station") or move.get("ModuleName") or ""),
                *(str(value) for value in (move.get("SrcStationList") or [])),
                *(str(value) for value in (move.get("DestStationList") or [])),
                *(str(value) for value in (move.get("StationList") or [])),
            }

        availability = problem.runtime_availability
        previous_end = float(
            availability.station_ready.get(station_name, 0.0)
            if availability is not None else 0.0
        )
        previous_end = max(
            previous_end,
            max(
                (
                    float(move.get("EndTime") or 0.0)
                    for move in repaired
                    if uses_station(move)
                    and float(move.get("StartTime") or 0.0) < cut_time - TIME_TOLERANCE
                ),
                default=previous_end,
            ),
        )
        # 若当前环境下的门事务跨过 mismatch 时刻，必须先保留其关门动作，
        # 再做空抽/空充；该关门不能随待修复的新动作一起后移。
        blocking_close_ids: set[int] = set()
        for prepare in repaired:
            if prepare.get("MoveType") != PREPARE_MOVE or not uses_station(prepare):
                continue
            if float(prepare.get("StartTime") or 0.0) >= cut_time - TIME_TOLERANCE:
                continue
            close_candidates = [
                move for move in repaired
                if move.get("MoveType") == COMPLETE_MOVE
                and uses_station(move)
                and float(move.get("StartTime") or 0.0)
                >= float(prepare.get("EndTime") or 0.0) - TIME_TOLERANCE
            ]
            if not close_candidates:
                continue
            close = min(close_candidates, key=sort_key)
            close_end = float(close.get("EndTime") or 0.0)
            if close_end > cut_time + TIME_TOLERANCE:
                blocking_close_ids.add(int(close.get("MoveID") or 0))
                previous_end = max(previous_end, close_end)
        setup_start = max(previous_end, cut_time - duration)
        delay = max(0.0, setup_start + duration - cut_time)
        if delay > TIME_TOLERANCE:
            for move in repaired:
                if (
                    float(move.get("StartTime") or 0.0) >= cut_time - TIME_TOLERANCE
                    and int(move.get("MoveID") or 0) not in blocking_close_ids
                ):
                    move["StartTime"] = float(move.get("StartTime") or 0.0) + delay
                    move["EndTime"] = float(move.get("EndTime") or 0.0) + delay
        repaired.append({
            "MoveType": PRE_PREPARE_MOVE,
            "MoveID": 0,
            "StartTime": setup_start,
            "EndTime": setup_start + duration,
            "ModuleName": station_name,
            "Station": station_name,
            "SlotList": [FIRST_SLOT_ID],
            "MatIDList": [],
            "LastState": last_state,
            "CurState": required_state,
            "PreMoveID": [],
        })

    renumbered, _ = _renumber_segment(repaired, 1)
    return renumbered


def _serialize_initial_processing(
    moves: Sequence[Mapping[str, Any]],
    state: MachineState,
) -> List[dict]:
    """先完成切点时已落腔但未加工的首工序，再开放新段其他动作。"""
    unprocessed_ids = {
        slot.material.material_id
        for station in state.stations.values()
        for slot in station.slots.values()
        if slot.phase is SlotPhase.UNPROCESSED and slot.material is not None
    }
    warmup_ids = {
        int(move["MoveID"])
        for move in moves
        if move.get("MoveType") in {PROCESS_MOVE, PRE_PREPARE_MOVE}
        and any(material_id in unprocessed_ids for material_id in (move.get("MatIDList") or []))
        and abs(float(move.get("StartTime") or 0.0)) <= TIME_TOLERANCE
        and isinstance(move.get("MoveID"), int)
    }
    if not warmup_ids:
        return [dict(move) for move in moves]
    delay = max(
        float(move.get("EndTime") or 0.0)
        for move in moves
        if int(move.get("MoveID", -1)) in warmup_ids
    )
    serialized: List[dict] = []
    for raw_move in moves:
        move = dict(raw_move)
        if int(move.get("MoveID", -1)) not in warmup_ids:
            move["StartTime"] = float(move.get("StartTime") or 0.0) + delay
            move["EndTime"] = float(move.get("EndTime") or 0.0) + delay
        serialized.append(move)
    renumbered, _ = _renumber_segment(serialized, 1)
    return renumbered


def _repair_loadlock_prepare_overlap(
    moves: Sequence[Mapping[str, Any]],
    state: MachineState,
) -> List[dict]:
    """把 timing 允许的泵气末尾门准备重叠收紧为实时状态机要求的严格串行。"""
    repaired = [dict(move) for move in moves]
    loadlocks = {
        name for name, station in state.stations.items()
        if isinstance(station, LoadLockState)
    }
    while True:
        conflict: Optional[Tuple[float, float]] = None
        pressures = [
            move for move in repaired
            if move.get("MoveType") == PRE_PREPARE_MOVE
            and str(move.get("Station") or move.get("ModuleName") or "") in loadlocks
        ]
        for prepare in sorted(repaired, key=sort_key):
            station_name = str(prepare.get("Station") or prepare.get("ModuleName") or "")
            if prepare.get("MoveType") != PREPARE_MOVE or station_name not in loadlocks:
                continue
            prepare_start = float(prepare.get("StartTime") or 0.0)
            blocking_end = max(
                (
                    float(pressure.get("EndTime") or 0.0)
                    for pressure in pressures
                    if str(pressure.get("Station") or pressure.get("ModuleName") or "") == station_name
                    and float(pressure.get("StartTime") or 0.0) <= prepare_start + TIME_TOLERANCE
                    and float(pressure.get("EndTime") or 0.0) > prepare_start + TIME_TOLERANCE
                ),
                default=prepare_start,
            )
            if blocking_end > prepare_start + TIME_TOLERANCE:
                conflict = (prepare_start, blocking_end - prepare_start)
                break
        if conflict is None:
            break
        cut_time, delay = conflict
        for move in repaired:
            if float(move.get("StartTime") or 0.0) >= cut_time - TIME_TOLERANCE:
                move["StartTime"] = float(move.get("StartTime") or 0.0) + delay
                move["EndTime"] = float(move.get("EndTime") or 0.0) + delay
    renumbered, _ = _renumber_segment(repaired, 1)
    return renumbered


def _renumber_segment(moves: Sequence[Mapping[str, Any]], first_move_id: int) -> Tuple[List[dict], int]:
    """为新计划分配从未使用过的 MoveID，避免与已取消旧计划混淆。"""
    renumbered: List[dict] = []
    next_move_id = int(first_move_id)
    for raw_move in sorted(moves, key=sort_key):
        move = dict(raw_move)
        move["MoveID"] = next_move_id
        move["PreMoveID"] = []
        renumbered.append(move)
        next_move_id += 1
    populate_premove_ids(renumbered)
    return renumbered, next_move_id


__all__ = ["RealtimeRescheduler", "RecomputePoint"]
