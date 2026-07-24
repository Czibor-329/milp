"""实时重算：投影在途动作状态，从请求时刻并行生成带资源释放下界的续排。

重算保留已经运行的 Move 和必要搬运收尾链，投影到门关闭、Robot 空手的状态；新计划仍从
原请求时刻开始，受旧动作影响的站点、槽位、Robot 和晶圆分别等待各自的释放时刻。
"""

from __future__ import annotations

import math
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from src.export import export_movelist
from src.parse.model import Durations, Problem, RuntimeAvailability, Stage, Wafer
from src.parse import PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN, parse_task
from src.schedule.api import start_schedule
from src.schedule.neural import start_schedule_neural
from src.schedule.rl import start_schedule_by_rl
from src.validation import MoveStateReplay, validate_move_list
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
L2D_PSE300_PM_ORDER = ("PM1", "PM2", "PM3", "PM4")
DEFAULT_MILP_TIME_LIMIT_SECONDS = 120.0
GUROBI_OPTIMAL_STATUS = 2
MAX_MILP_TOTAL_WAFERS = 12
NEURAL_REALIZED_MINIMUM_GAIN = 0.01


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
        loadlock_manager_mode: Optional[str] = None,
        neural_force_quality_floor: bool = False,
        rl_search_seconds: float = 4.0,
        rl_rollouts: int = 256,
        rl_temperature: float = 0.7,
        milp_time_limit: float = DEFAULT_MILP_TIME_LIMIT_SECONDS,
        seed: int = 0,
    ) -> None:
        """解析首批任务，并用所选顶层策略立即生成第一段计划。"""
        if strategy not in {"heuristic", "neural", "rl", "l2d", "milp"}:
            raise ValueError(
                f"实时重算只支持 heuristic/neural/rl/l2d/milp，收到 strategy={strategy}"
            )
        if strategy in {"neural", "rl", "l2d"} and policy is None:
            raise ValueError(f"{strategy.upper()} 实时重算缺少已加载策略模型")
        self.tool_topo = deepcopy(dict(tool_topo))
        self.strategy = strategy
        self.policy = policy
        self.loadlock_manager_mode = str(
            loadlock_manager_mode
            or ("joint" if strategy == "neural" else "petri-look")
        )
        self.neural_force_quality_floor = bool(neural_force_quality_floor)
        self.rl_search_seconds = float(rl_search_seconds)
        self.rl_rollouts = int(rl_rollouts)
        self.rl_temperature = float(rl_temperature)
        self.milp_time_limit = float(milp_time_limit)
        self.seed = int(seed)
        self._last_strategy_diagnostics: Dict[str, Any] = {}
        parse_options = (
            {
                "process_assignment": PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN,
                "process_pm_order": L2D_PSE300_PM_ORDER,
            }
            if strategy == "l2d" else {}
        )
        self.problem = parse_task(self.tool_topo, update_params, **parse_options)
        if strategy == "milp" and len(self.problem.wafers) > MAX_MILP_TOTAL_WAFERS:
            raise ValueError(
                f"MILP 策略包含清洁片在内的总晶圆数量不能超过 "
                f"{MAX_MILP_TOTAL_WAFERS} 片，当前为 {len(self.problem.wafers)} 片"
            )
        _apply_material_start_slots(self.problem, update_params)
        start_time = float(update_params.get("CurrentTime") or 0.0)
        initial_state = MachineState.from_sources(self.problem, init_data)
        initial_availability = (
            self.problem.runtime_availability or RuntimeAvailability()
        )
        initial_availability.loadlock_environment = {
            name: station.environment
            for name, station in initial_state.stations.items()
            if isinstance(station, LoadLockState)
        }
        self.problem.runtime_availability = initial_availability
        self._history: List[dict] = []
        self._points: List[RecomputePoint] = []
        self._committed_recovery_end = start_time
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
    def committed_recovery_end(self) -> float:
        """返回此前重算已经承诺、因而不能取消的旧动作最晚结束时刻。"""
        return float(self._committed_recovery_end)

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

    @property
    def last_strategy_diagnostics(self) -> Dict[str, Any]:
        """返回最近一段排程的求解诊断副本；当前主要用于展示 MILP 最优性。"""
        return dict(self._last_strategy_diagnostics)

    def update_move_state(
        self,
        notification: Mapping[str, Any],
        *,
        snapshot: bool = True,
        track_reservations: bool = True,
    ) -> Optional[MachineState]:
        """接收外部 Move 开始/结束通知并更新 ``src.validation.state`` 状态。"""
        return self._tracker.update_move_state(
            notification,
            snapshot=snapshot,
            track_reservations=track_reservations,
        )

    def robot_position(self, robot_name: str) -> Optional[str]:
        """只读返回 Robot 当前指向，避免高频回放为查询一个字段复制整机状态。"""
        robot = self._tracker.state.resolve_robot(robot_name)
        return robot.position if robot is not None else None

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
        if self.strategy == "milp":
            raise ValueError("MILP 策略只支持首次排程，不能执行实时重算")
        timestamp = float(current_time)
        cutoff = timestamp if cutoff_time is None else float(cutoff_time)
        schedule_start = timestamp if schedule_start_time is None else float(schedule_start_time)
        if cutoff > timestamp + TIME_TOLERANCE:
            raise ValueError("重算触发时间不能晚于状态稳定时间")
        if schedule_start < cutoff - TIME_TOLERANCE or schedule_start > timestamp + TIME_TOLERANCE:
            raise ValueError("新计划起点必须位于重算触发时间与收尾完成时间之间")
        self._ensure_safe_cut(timestamp, cutoff)
        snapshot = self._tracker.state.clone()
        # “上一次环境转换为空片”只用于拒绝同一计划内无意义的往返抽充气，
        # 不是设备的物理状态。重算时，旧计划可能有一条在 cutoff 前已经启动、
        # 因而必须收尾的空转换；新计划取消了它原本的后继后，可能合法地需要
        # 反向转换。跨计划保留该意图标记会把这种必要恢复误判为连续空转换。
        for station in snapshot.stations.values():
            if isinstance(station, LoadLockState):
                station.last_environment_transition_was_empty = False
        parse_options = (
            {
                "process_assignment": PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN,
                "process_pm_order": L2D_PSE300_PM_ORDER,
            }
            if self.strategy == "l2d" else {}
        )
        new_problem = parse_task(self.tool_topo, new_update_params, **parse_options)
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
        self._committed_recovery_end = max(
            self._committed_recovery_end,
            timestamp,
        )
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
        self._last_strategy_diagnostics = {}
        if self.strategy == "neural":
            result = start_schedule_neural(
                problem,
                policy=self.policy,
                fallback_on_failure=True,
                loadlock_manager_mode=self.loadlock_manager_mode,
                force_quality_floor=self.neural_force_quality_floor,
            )
            self._last_strategy_diagnostics = dict(
                getattr(result, "neural_diagnostics", {}) or {}
            )
        elif self.strategy == "rl":
            result = start_schedule_by_rl(
                problem,
                self.policy,
                seed=self.seed,
                search_seconds=self.rl_search_seconds,
                max_rollouts=self.rl_rollouts,
                temp=self.rl_temperature,
                verbose=False,
                loadlock_manager=self.loadlock_manager_mode,
            )
        elif self.strategy == "l2d":
            # 延迟导入，确保未安装 Torch 时 heuristic/RL 旧路径仍可独立使用。
            from src.schedule.l2d import start_schedule_l2d

            result = start_schedule_l2d(problem, self.policy)
        elif self.strategy == "milp":
            # 延迟导入，确保不使用 MILP 时无需初始化 Gurobi 运行时与许可证。
            from src.schedule.milp import solve_milp

            result = solve_milp(
                problem,
                time_limit=self.milp_time_limit,
                verbose=False,
            )
            result.feasible = bool(result.schedule) and math.isfinite(result.makespan)  # type: ignore[attr-defined]
            self._last_strategy_diagnostics = {
                "status": int(result.status),
                "optimal": bool(result.status == GUROBI_OPTIMAL_STATUS),
                "gap": float(result.gap),
                "runtimeSeconds": float(result.runtime),
                "timeLimitSeconds": self.milp_time_limit,
            }
        else:
            result = start_schedule(
                problem,
                verbose=False,
                loadlock_manager=self.loadlock_manager_mode,
            )
        if self.strategy in {"heuristic", "rl"}:
            self._last_strategy_diagnostics.update({
                "loadLockManagerRequested": getattr(
                    result,
                    "loadlock_manager_requested",
                    self.loadlock_manager_mode,
                ),
                "loadLockSelectedPath": getattr(
                    result,
                    "loadlock_manager_selected",
                    "unknown",
                ),
            })
        if not getattr(result, "feasible", False):
            raise RuntimeError(f"{self.strategy} 重算未找到可行计划")

        def materialize(selected_result: Any, source_strategy: str) -> List[dict]:
            """把 timing 结果兑现成经真实初态复核的绝对时间 MoveList。"""
            moves = export_movelist(problem, selected_result, state)
            moves = _serialize_initial_processing(moves, state)
            moves = _repair_loadlock_prepare_overlap(moves, state)
            # export 已包含完整且可执行的环境动作时，不再插入随后又会被删除的
            # 空抽/空充。旧流程会在删除冗余动作后保留整体平移，扭曲 makespan。
            if (
                source_strategy not in {"milp", "neural"}
                or validate_move_list(problem, moves, state)
            ):
                moves = _prepend_environment_setups(problem, moves, state)
                moves = _remove_redundant_empty_environment_cycles(moves, state)
            shifted = _shift_moves(moves, offset)
            issues = validate_move_list(problem, shifted, state)
            if issues:
                raise RuntimeError(f"重算 MoveList 状态校验失败：{issues[0]}")
            return shifted

        materialize_strategy = self.strategy
        if (
            self.strategy == "neural"
            and self._last_strategy_diagnostics.get("selectedSource")
            in {
                "failure-fallback",
                "quality-floor-fallback",
            }
        ):
            materialize_strategy = "heuristic"
        try:
            candidate_moves = materialize(result, materialize_strategy)
            if self.strategy == "neural" and self.neural_force_quality_floor:
                # timing makespan 不含从真实 Robot/LoadLock 初态兑现时追加的全部恢复
                # 动作。对已知分布外的多工序计划，在 MoveList 层再比较一次实际段终点，
                # 只有至少 1% 的明确收益才接受 Neural 轨迹，避免微小抽象优势换来下一
                # 轮更差的压力相位。
                floor_result = start_schedule(
                    problem,
                    verbose=False,
                    loadlock_manager=self.loadlock_manager_mode,
                )
                if getattr(floor_result, "feasible", False):
                    floor_moves = materialize(
                        floor_result,
                        "heuristic",
                    )
                    candidate_end = max(
                        (float(move.get("EndTime") or 0.0) for move in candidate_moves),
                        default=offset,
                    )
                    floor_end = max(
                        (float(move.get("EndTime") or 0.0) for move in floor_moves),
                        default=offset,
                    )
                    floor_duration = max(floor_end - offset, TIME_TOLERANCE)
                    realized_gain = (
                        floor_end - candidate_end
                    ) / floor_duration
                    if realized_gain < NEURAL_REALIZED_MINIMUM_GAIN:
                        self._last_strategy_diagnostics.update({
                            "selectedSource": "quality-floor-fallback",
                            "actionMask": "baseline-fallback",
                            "decisionSpace": "baseline-fallback",
                            "realizedMoveListGain": float(realized_gain),
                        })
                        return floor_moves
                    self._last_strategy_diagnostics["realizedMoveListGain"] = float(
                        realized_gain
                    )
            return candidate_moves
        except RuntimeError as neural_state_error:
            if self.strategy != "neural":
                raise
            # timing/Petri 检查只覆盖抽象资源序；真实初态还含门、压力和槽位相位。
            # Neural 兑现失败时用已验证的启发式轨迹恢复，而不是把非法 MoveList
            # 交给设备。诊断明确记录这条状态级安全地板。
            fallback = start_schedule(
                problem,
                verbose=False,
                loadlock_manager=self.loadlock_manager_mode,
            )
            if not getattr(fallback, "feasible", False):
                raise neural_state_error
            self._last_strategy_diagnostics.update({
                "selectedSource": "state-validation-fallback",
                "actionMask": "baseline-fallback",
                "decisionSpace": "baseline-fallback",
                "stateValidationFailure": str(neural_state_error),
            })
            return materialize(fallback, "heuristic")


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
        residual.append(
            _trim_wafer(
                wafer,
                stage_index,
                station_name,
                slot_id,
                slot.phase,
            )
        )
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
    _assign_incoming_resources(
        incoming_wafers,
        next_state,
        previous.chambers,
        residual,
    )
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
    def accepts_station(stage: Stage) -> bool:
        # 神经策略会在完整候选池中动态选择 LoadLock；Problem 中的 chamber 只是解析期
        # 默认值，实时状态中的实际腔只要属于该 stage.cands 就是同一道工序。
        return stage.chamber == station_name or station_name in (stage.cands or [])

    if material is not None and isinstance(material.step_id, int):
        index = material.step_id
        if 0 <= index < len(wafer.stages) and accepts_station(wafer.stages[index]):
            return index
    slot_index = slot_id - FIRST_SLOT_ID
    matches = [
        index for index, stage in enumerate(wafer.stages)
        if accepts_station(stage) and stage.slot == slot_index
    ]
    if not matches:
        matches = [
            index for index, stage in enumerate(wafer.stages)
            if accepts_station(stage)
        ]
    if not matches:
        raise ValueError(f"MatID={wafer.mat_id} 的当前站点 {station_name} 不在剩余路线中")
    return max(matches)


def _trim_wafer(
    wafer: Wafer,
    stage_index: int,
    station_name: str,
    slot_id: int,
    phase: SlotPhase,
) -> Wafer:
    """把旧晶圆已经完成的路线前缀裁掉，并以当前槽位作为新起点。"""
    stages = [deepcopy(stage) for stage in wafer.stages[stage_index:]]
    first = stages[0]
    first.chamber = station_name
    first.slot = slot_id - FIRST_SLOT_ID
    first.in_robot = ""
    first.cands = [station_name]
    if phase is SlotPhase.COMPLETED:
        first.stage_type = "source"
        first.proc = 0.0
        first.residency = -1.0
        # 已完成的 LoadLock stage 不再重复抽/充气，但保留 entry/exit 方向元数据；
        # timing 的双槽压力顺序和 MoveList 的同门换片识别仍需要它。
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
    residual_wafers: Sequence[Wafer] = (),
) -> None:
    """按残余工作量让新增任务延续并行腔负载，而不是从候选列表首项重新开始。

    解析单轮任务时的 round-robin 会从零开始；重算若直接沿用，上一轮最后使用 PM1 后，
    下一轮第一片仍会再次落到 PM1。这里只看切点瞬时占用同样不够：已经离开 PM、但
    后续仍要进入该 PM 的旧晶圆会被漏掉，使新增片出现 1/3/2 一类静态失衡。这里以
    残余路线的剩余加工工时为 PM 基线，并用实时占用和最后释放时刻处理 LoadLock
    与平局。LoadLock 的进/出 stage 对同一晶圆保持同腔，同时保留完整候选集。
    """
    assigned: Dict[Tuple[str, Tuple[str, ...]], Dict[str, float]] = {}
    residual_loads: Dict[Tuple[str, Tuple[str, ...]], Dict[str, float]] = {}

    for wafer in residual_wafers:
        for stage in wafer.stages:
            if stage.stage_type != "process":
                continue
            pool = tuple(sorted(dict.fromkeys(
                str(name) for name in (stage.cands or [stage.chamber]) if name
            )))
            if stage.chamber not in pool:
                continue
            key = ("process", pool)
            loads = residual_loads.setdefault(
                key,
                {name: 0.0 for name in pool},
            )
            loads[stage.chamber] += max(float(stage.proc), TIME_TOLERANCE)

    def choose(
        kind: str,
        candidates: Sequence[str],
        workload: float,
        *,
        prefer_atmosphere: bool = False,
    ) -> str:
        """从同一候选池选择累计剩余工时最小的资源。"""
        pool = tuple(sorted(dict.fromkeys(str(name) for name in candidates if name)))
        if not pool:
            return ""
        key = (kind, pool)
        loads = assigned.setdefault(
            key,
            {
                name: residual_loads.get(key, {}).get(name, 0.0)
                + (
                    float(_station_material_count(state, name))
                    if kind == "loadlock"
                    else 0.0
                )
                + (
                    1.0
                    if (
                        prefer_atmosphere
                        and isinstance(state.stations.get(name), LoadLockState)
                        and state.stations[name].environment != ATMOSPHERE
                    )
                    else 0.0
                )
                for name in pool
            },
        )
        chosen = min(pool, key=lambda name: (loads[name], _station_release_time(state, name), name))
        loads[chosen] += max(float(workload), TIME_TOLERANCE)
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
            chosen = choose(
                "loadlock",
                candidates,
                sum(max(float(stage.proc), TIME_TOLERANCE) for stage in loadlock_stages),
                prefer_atmosphere=True,
            )
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
            chosen = choose("process", candidates, float(stage.proc))
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
    loadlock_environment = {
        name: station.environment
        for name, station in state.stations.items()
        if isinstance(station, LoadLockState)
    }
    return RuntimeAvailability(
        station_ready={name: value for name, value in station_ready.items() if value > TIME_TOLERANCE},
        slot_ready={key: value for key, value in slot_ready.items() if value > TIME_TOLERANCE},
        robot_ready={name: value for name, value in robot_ready.items() if value > TIME_TOLERANCE},
        robot_positions=robot_positions,
        material_ready={key: value for key, value in material_ready.items() if value > TIME_TOLERANCE},
        loadlock_environment=loadlock_environment,
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

    station_reference_cache: Dict[int, set[str]] = {}

    def uses_station(move: Mapping[str, Any], station_name: str) -> bool:
        """用缓存后的动作站点集合判断是否占用指定 LoadLock。"""
        cache_key = id(move)
        station_references = station_reference_cache.get(cache_key)
        if station_references is None:
            station_references = {
                str(move.get("Station") or move.get("ModuleName") or ""),
                *(str(value) for value in (move.get("SrcStationList") or [])),
                *(str(value) for value in (move.get("DestStationList") or [])),
                *(str(value) for value in (move.get("StationList") or [])),
            }
            station_reference_cache[cache_key] = station_references
        return station_name in station_references

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
        station_moves = [
            move for move in repaired
            if uses_station(move, station_name)
        ]
        # 若最近一次无片转换之后没有开门，而它恰好把环境从下一次开门所需状态
        # 翻走，则这条转换本身就是多槽占用排序产生的冗余 setup。删除它并重新
        # 回放，比再补一条反向 setup 更符合真实 LoadLock 行为。
        last_access_time = max(
            (
                float(move.get("StartTime") or 0.0)
                for move in station_moves
                if move.get("MoveType") == PREPARE_MOVE
                and str(move.get("Station") or move.get("ModuleName") or "") == station_name
                and float(move.get("StartTime") or 0.0) < cut_time - TIME_TOLERANCE
            ),
            default=float("-inf"),
        )
        redundant_setups = [
            move for move in station_moves
            if move.get("MoveType") == PRE_PREPARE_MOVE
            and str(move.get("Station") or move.get("ModuleName") or "") == station_name
            and not (move.get("MatIDList") or [])
            and str(move.get("LastState") or "").upper() == required_state
            and str(move.get("CurState") or "").upper() == last_state
            and float(move.get("EndTime") or 0.0) <= cut_time + TIME_TOLERANCE
            and float(move.get("StartTime") or 0.0) >= last_access_time - TIME_TOLERANCE
        ]
        if redundant_setups:
            redundant = max(redundant_setups, key=sort_key)
            repaired.remove(redundant)
            continue

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
                    for move in station_moves
                    if float(move.get("StartTime") or 0.0) < cut_time - TIME_TOLERANCE
                ),
                default=previous_end,
            ),
        )
        # 若当前环境下的门事务跨过 mismatch 时刻，必须先保留其关门动作，
        # 再做空抽/空充；该关门不能随待修复的新动作一起后移。
        blocking_close_ids: set[int] = set()
        prior_prepares = [
            move for move in station_moves
            if move.get("MoveType") == PREPARE_MOVE
            and float(move.get("StartTime") or 0.0)
            < cut_time - TIME_TOLERANCE
        ]
        if prior_prepares:
            # 合法门时间线上最多只有最近一次开门事务可能跨过当前 mismatch；
            # 旧实现为每个历史开门再扫描一次全部 Move，长批量退化为 O(M²)。
            prepare = max(prior_prepares, key=sort_key)
            close_candidates = [
                move for move in station_moves
                if move.get("MoveType") == COMPLETE_MOVE
                and float(move.get("StartTime") or 0.0)
                >= float(prepare.get("EndTime") or 0.0) - TIME_TOLERANCE
            ]
            if close_candidates:
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
    if not loadlocks:
        renumbered, _ = _renumber_segment(repaired, 1)
        return renumbered

    # 扫描时间线并累计插入的串行化间隙。旧实现每发现一个冲突就重新扫描、排序并
    # 平移全部 Move；长批量有数千个门事务时退化为 O(M²)。这里每个动作只访问一次：
    # 已开始的压力转换保留原结束时刻，冲突 Prepare 及其后续动作统一吃掉累计 delay。
    pressure_end_by_station: Dict[str, float] = {}

    def repair_order(item: Tuple[int, dict]) -> Tuple[float, int, int]:
        index, move = item
        move_type = move.get("MoveType")
        priority = (
            0 if move_type == PRE_PREPARE_MOVE
            else 1 if move_type == PREPARE_MOVE
            else 2
        )
        return (
            float(move.get("StartTime") or 0.0),
            priority,
            int(move.get("MoveID") or index),
        )

    cumulative_delay = 0.0
    for _index, move in sorted(enumerate(repaired), key=repair_order):
        original_start = float(move.get("StartTime") or 0.0)
        original_end = float(move.get("EndTime") or 0.0)
        station_name = str(move.get("Station") or move.get("ModuleName") or "")
        move_type = move.get("MoveType")
        shifted_start = original_start + cumulative_delay

        if move_type == PREPARE_MOVE and station_name in loadlocks:
            blocking_end = pressure_end_by_station.get(station_name, shifted_start)
            if blocking_end > shifted_start + TIME_TOLERANCE:
                cumulative_delay += blocking_end - shifted_start
                shifted_start = blocking_end

        move["StartTime"] = shifted_start
        move["EndTime"] = original_end + cumulative_delay
        if move_type == PRE_PREPARE_MOVE and station_name in loadlocks:
            pressure_end_by_station[station_name] = max(
                pressure_end_by_station.get(station_name, float("-inf")),
                float(move["EndTime"]),
            )
    renumbered, _ = _renumber_segment(repaired, 1)
    return renumbered


def _remove_redundant_empty_environment_cycles(
    moves: Sequence[Mapping[str, Any]],
    state: MachineState,
) -> List[dict]:
    """删除两次开门之间成对抵消的无片抽气/充气动作。"""
    repaired = [dict(move) for move in moves]
    loadlocks = {
        name for name, station in state.stations.items()
        if isinstance(station, LoadLockState)
    }
    for station_name in loadlocks:
        station_events = sorted(
            (
                move for move in repaired
                if str(move.get("Station") or move.get("ModuleName") or "") == station_name
                and move.get("MoveType") in {PREPARE_MOVE, PRE_PREPARE_MOVE}
            ),
            key=sort_key,
        )
        removable_ids: set[int] = set()
        retained_events: List[dict] = []
        for current in station_events:
            previous = retained_events[-1] if retained_events else None
            can_cancel = (
                previous is not None
                and previous.get("MoveType") == PRE_PREPARE_MOVE
                and current.get("MoveType") == PRE_PREPARE_MOVE
                and not (previous.get("MatIDList") or [])
                and not (current.get("MatIDList") or [])
                and str(previous.get("LastState") or "").upper()
                == str(current.get("CurState") or "").upper()
                and str(previous.get("CurState") or "").upper()
                == str(current.get("LastState") or "").upper()
            )
            if can_cancel:
                retained_events.pop()
                removable_ids.update({
                    int(previous.get("MoveID") or 0), int(current.get("MoveID") or 0),
                })
            else:
                retained_events.append(current)
        if removable_ids:
            repaired = [
                move for move in repaired
                if int(move.get("MoveID") or 0) not in removable_ids
            ]
    renumbered, _ = _renumber_segment(repaired, 1)
    return renumbered


def _repair_loadlock_door_overlap(
    moves: Sequence[Mapping[str, Any]],
    state: MachineState,
) -> List[dict]:
    """串行化 LoadLock 跨槽共享门事务及环境转换。

    timing 的 swap 模式允许 entry/exit 两个槽位同时占片，但两个槽位仍共用一扇物理门。
    当相邻事务落在不同槽位时，压力态约束不足以保证 ``Complete → Prepare`` 严格串行；
    抽气/充气也必须位于完整关门区间。修复时只移动冲突动作及其依赖后继，保留可以在
    另一个槽位先完成的 VAC/ATM 取放事务。
    """
    repaired = [dict(move) for move in moves]
    loadlocks = {
        name for name, station in state.stations.items()
        if isinstance(station, LoadLockState)
    }
    descendant_cache: Dict[int, set[int]] = {}

    def descendant_ids(root_id: int) -> set[int]:
        """返回指定动作及全部 PreMove 依赖后继。"""
        if root_id in descendant_cache:
            return descendant_cache[root_id]
        descendants = {root_id}
        changed = True
        while changed:
            changed = False
            for move in repaired:
                move_id = int(move.get("MoveID") or 0)
                if move_id in descendants:
                    continue
                if any(int(value) in descendants for value in (move.get("PreMoveID") or [])):
                    descendants.add(move_id)
                    changed = True
        descendant_cache[root_id] = descendants
        return descendants

    while True:
        conflict: Optional[Tuple[float, float, set[int]]] = None
        for station_name in sorted(loadlocks):
            station_moves = [
                move for move in repaired
                if str(move.get("Station") or move.get("ModuleName") or "") == station_name
            ]
            prepares = sorted(
                (move for move in station_moves if move.get("MoveType") == PREPARE_MOVE),
                key=sort_key,
            )
            completes = [move for move in station_moves if move.get("MoveType") == COMPLETE_MOVE]
            for previous_prepare, next_prepare in zip(prepares, prepares[1:]):
                previous_end = float(previous_prepare.get("EndTime") or 0.0)
                close_candidates = [
                    move for move in completes
                    if float(move.get("StartTime") or 0.0) >= previous_end - TIME_TOLERANCE
                ]
                if not close_candidates:
                    continue
                previous_close = min(close_candidates, key=sort_key)
                close_end = float(previous_close.get("EndTime") or 0.0)
                next_start = float(next_prepare.get("StartTime") or 0.0)
                if close_end > next_start + TIME_TOLERANCE:
                    conflict = (
                        next_start,
                        close_end - next_start,
                        {int(previous_close.get("MoveID") or 0)},
                    )
                    break
            if conflict is not None:
                break
            pressures = sorted(
                (move for move in station_moves if move.get("MoveType") == PRE_PREPARE_MOVE),
                key=sort_key,
            )
            transactions: List[Tuple[dict, dict]] = []
            for prepare in prepares:
                prepare_end = float(prepare.get("EndTime") or 0.0)
                close_candidates = [
                    move for move in completes
                    if float(move.get("StartTime") or 0.0) >= prepare_end - TIME_TOLERANCE
                ]
                if close_candidates:
                    transactions.append((prepare, min(close_candidates, key=sort_key)))
            for pressure in pressures:
                pressure_start = float(pressure.get("StartTime") or 0.0)
                pressure_end = float(pressure.get("EndTime") or 0.0)
                for prepare, close in transactions:
                    prepare_start = float(prepare.get("StartTime") or 0.0)
                    close_end = float(close.get("EndTime") or 0.0)
                    if (
                        pressure_start >= close_end - TIME_TOLERANCE
                        or pressure_end <= prepare_start + TIME_TOLERANCE
                    ):
                        continue
                    required_environment = (
                        ATMOSPHERE if prepare.get("RelatedRobotType") == 0
                        else VACUUM if prepare.get("RelatedRobotType") == 1
                        else ""
                    )
                    pressure_last = str(pressure.get("LastState") or "").upper()
                    pressure_current = str(pressure.get("CurState") or "").upper()
                    if required_environment == pressure_last:
                        transaction_ids = {
                            move_id for move_id in descendant_ids(int(prepare.get("MoveID") or 0))
                            if any(
                                int(candidate.get("MoveID") or 0) == move_id
                                and float(candidate.get("StartTime") or 0.0) < close_end + TIME_TOLERANCE
                                for candidate in repaired
                            )
                        }
                        conflict = (
                            pressure_start,
                            close_end - pressure_start,
                            transaction_ids,
                        )
                    elif required_environment == pressure_current:
                        conflict = (
                            prepare_start,
                            pressure_end - prepare_start,
                            {int(pressure.get("MoveID") or 0)},
                        )
                    else:
                        if pressure_start <= prepare_start:
                            conflict = (
                                prepare_start,
                                pressure_end - prepare_start,
                                {int(pressure.get("MoveID") or 0)},
                            )
                        else:
                            conflict = (pressure_start, close_end - pressure_start, set())
                    break
                if conflict is not None:
                    break
            if conflict is not None:
                break
        if conflict is None:
            break
        cut_time, delay, excluded_ids = conflict
        for move in repaired:
            if (
                float(move.get("StartTime") or 0.0) >= cut_time - TIME_TOLERANCE
                and int(move.get("MoveID") or 0) not in excluded_ids
            ):
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
    return renumbered, next_move_id


__all__ = ["RealtimeRescheduler", "RecomputePoint"]
