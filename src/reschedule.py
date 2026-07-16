"""实时重算：Move 通知驱动状态、截断旧计划并用 heuristic + timing 生成续排。

重算只在稳定切点执行：没有仍在运行的 Move、所有门已关闭、机械手不持片。这样旧计划中
尚未开始的 Move 可以立即作废，已完成 Move 与新计划可以无恢复动作地拼成统一 MoveList。
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from src.export import export_movelist
from src.model import Problem, Stage, Wafer
from src.parse import parse_task
from src.timing import start_schedule, start_schedule_by_rl
from src.validation import MoveStateReplay, populate_premove_ids, validate_move_list
from src.validation.move_fields import PREPARE_MOVE, PRE_PREPARE_MOVE, PROCESS_MOVE, sort_key
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
    def can_recompute(self) -> bool:
        """返回当前状态是否满足无运行 Move、门全关且 Robot 空手的安全切点条件。"""
        if self._tracker.running_move_ids:
            return False
        if any(station.door is not DoorState.CLOSED for station in self._tracker.state.stations.values()):
            return False
        return all(
            material is None
            for robot in self._tracker.state.robots.values()
            for material in robot.hands.values()
        )

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
    ) -> Dict[str, Any]:
        """在当前稳定状态加入新任务，取消旧计划未来 Move 并启发式续排。

        ``cutoff_time`` 是外部请求重算的时刻；调用方必须继续执行旧计划，直到
        ``current_time`` 所指的首个全局安全时刻。旧计划在该安全时刻之前的 Move 会保留，
        其余旧 Move 作废，新计划从 ``current_time`` 开始。甘特图重算线仍画在原始请求时刻。
        """
        timestamp = float(current_time)
        cutoff = timestamp if cutoff_time is None else float(cutoff_time)
        if cutoff > timestamp + TIME_TOLERANCE:
            raise ValueError("重算触发时间不能晚于状态稳定时间")
        self._ensure_safe_cut(timestamp, cutoff)
        snapshot = self._tracker.state.clone()
        new_problem = parse_task(self.tool_topo, new_update_params)
        _apply_material_start_slots(new_problem, new_update_params)
        combined_problem, next_state = _build_recompute_problem(self.problem, new_problem, snapshot)

        self._history.extend(self._tracker.executed_moves)
        self._points.append(RecomputePoint(cutoff, timestamp, len(self._points) + 1, reason))
        new_segment = self._schedule_segment(combined_problem, next_state, timestamp)
        new_segment, self._next_move_id = _renumber_segment(new_segment, self._next_move_id)

        self.problem = combined_problem
        self._current_plan = new_segment
        self._tracker = MoveStateReplay(combined_problem, new_segment, next_state)
        self._tracker.current_time = timestamp
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
        moves = _prepend_environment_setups(problem, moves, state)
        moves = _repair_loadlock_prepare_overlap(moves, state)
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
    for wafer in previous.wafers:
        location = locations.get(wafer.mat_id)
        if location is None:
            raise ValueError(f"状态中找不到旧任务物料 MatID={wafer.mat_id}")
        station_name, slot_id, slot = location
        stage_index = _current_stage_index(wafer, station_name, slot_id, slot.material)
        if stage_index == len(wafer.stages) - 1 and wafer.stages[stage_index].stage_type == "sink":
            continue
        residual.append(_trim_wafer(wafer, stage_index, station_name, slot.phase))
        if slot.material is not None:
            slot.material.step_id = 0

    incoming_wafers = [deepcopy(wafer) for wafer in incoming.wafers]
    _assign_incoming_loadlocks(incoming_wafers, next_state)
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


def _assign_incoming_loadlocks(wafers: Sequence[Wafer], state: MachineState) -> None:
    """新增晶圆优先使用空闲且处于大气态的 LoadLock，避开在机残留片。"""
    occupied = {
        station_name
        for station_name, station in state.stations.items()
        if any(slot.material is not None for slot in station.slots.values())
    }
    for wafer in wafers:
        loadlock_stages = [stage for stage in wafer.stages if stage.stage_type == "loadlock"]
        candidates = sorted({
            candidate
            for stage in loadlock_stages
            for candidate in (stage.cands or [stage.chamber])
            if isinstance(state.stations.get(candidate), LoadLockState)
        })
        if not candidates:
            continue
        preferred = [
            name for name in candidates
            if name not in occupied
            and isinstance(state.stations.get(name), LoadLockState)
            and state.stations[name].environment == ATMOSPHERE
        ]
        chosen = (preferred or [name for name in candidates if name not in occupied] or candidates)[0]
        for stage in loadlock_stages:
            stage.chamber = chosen
            stage.cands = [chosen]
            stage.slot = 0 if stage.ll_type == "entry" else 1
        occupied.add(chosen)


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
    """必要时在新段开头补 LoadLock 空抽/空充，并整体让出该准备窗口。"""
    setups: List[dict] = []
    for station_name, station in state.stations.items():
        if not isinstance(station, LoadLockState):
            continue
        first_pressure = next(
            (
                move for move in sorted(moves, key=sort_key)
                if move.get("MoveType") == PRE_PREPARE_MOVE
                and str(move.get("Station") or move.get("ModuleName") or "") == station_name
            ),
            None,
        )
        if first_pressure is None:
            continue
        required = str(first_pressure.get("LastState") or "").upper()
        if required not in {ATMOSPHERE, VACUUM} or required == station.environment:
            continue
        chamber = problem.chambers.get(station_name)
        duration = float(
            (chamber.vent_time if station.environment == VACUUM else chamber.pump_time) or 0.0
        ) if chamber is not None else 0.0
        setups.append({
            "MoveType": PRE_PREPARE_MOVE,
            "MoveID": 0,
            "StartTime": 0.0,
            "EndTime": duration,
            "ModuleName": station_name,
            "Station": station_name,
            "SlotList": [FIRST_SLOT_ID],
            "MatIDList": [],
            "LastState": station.environment,
            "CurState": required,
            "PreMoveID": [],
        })
    delay = max((float(move["EndTime"]) for move in setups), default=0.0)
    delayed = _shift_moves(moves, delay)
    delayed.extend(setups)
    renumbered, _ = _renumber_segment(delayed, 1)
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
