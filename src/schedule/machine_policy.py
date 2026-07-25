"""本地调度策略与 ``Machine`` 搬运候选之间的兼容层。

本模块将 Machine 的公开快照和 ``RobotAction`` 映射成既有策略特征所需的
``_DecodeState``/``_Cand`` 等价视图，从而保持 Neural 与 RL checkpoint 的
schema 和特征维度不变。策略只负责候选排序，不读取门、压力或 MoveList。
"""

from __future__ import annotations

from collections import namedtuple
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Sequence

import numpy as np

from src.parse.model import Durations, Problem
from src.timing.solve import SolveResult
from src.validation.state import (
    Machine,
    MachineSnapshot,
    MachineState,
    RobotAction,
)


_Candidate = namedtuple("_Candidate", "wid j dest rob start")


@dataclass
class _PolicyState:
    """保持既有候选特征访问字段的只读兼容状态。"""

    ir: Problem
    tm: Durations
    wmap: Dict[int, Any]
    K: Dict[int, int]
    pos: Dict[int, int]
    occ: Dict[tuple[str, int], int]
    resv: Dict[tuple[str, int], int]
    place_t: Dict[int, float]
    robot_free: Dict[str, float]
    placed: int
    total: int
    reserve: bool
    ch_used: Dict[str, int]
    route_released: Dict[str, int]
    route_wip: Dict[str, int]


def _policy_inputs(
    problem: Problem,
    state: MachineSnapshot,
    actions: Sequence[RobotAction],
) -> tuple[_PolicyState, list[_Candidate]]:
    """把公开 Machine 决策点转换成旧 checkpoint 的输入口径。"""
    wmap = {int(wafer.wid): wafer for wafer in problem.wafers}
    by_material = {wafer.mat_id: wafer for wafer in problem.wafers}
    positions: Dict[int, int] = {}
    occupancy: Dict[tuple[str, int], int] = {}
    place_times: Dict[int, float] = {}
    chamber_usage: Dict[str, int] = {}
    route_released: Dict[str, int] = {}
    route_wip: Dict[str, int] = {}
    for material_id, material in state.materials.items():
        wafer = by_material.get(material_id)
        if wafer is None:
            continue
        step_id = int(material.step_id or 0)
        positions[int(wafer.wid)] = step_id
        place_times[int(wafer.wid)] = max(
            state.time,
            float(material.ready_at)
            - max(float(wafer.stages[step_id].proc), 0.0),
        )
        if step_id > 0 or wafer.already_released:
            route_released[wafer.route_name] = (
                route_released.get(wafer.route_name, 0) + 1
            )
        if (step_id > 0 or wafer.already_released) and step_id < len(wafer.stages) - 1:
            route_wip[wafer.route_name] = route_wip.get(wafer.route_name, 0) + 1
        if material.location in problem.chambers:
            stage = wafer.stages[step_id]
            if stage.stage_type not in {"source", "sink"}:
                occupancy[(material.location, material.slot_id - 1)] = int(wafer.wid)
            chamber_usage[material.location] = chamber_usage.get(material.location, 0) + 1
    for wafer in problem.wafers:
        positions.setdefault(int(wafer.wid), 0)
        place_times.setdefault(int(wafer.wid), state.time)
    compatibility_state = _PolicyState(
        ir=problem,
        tm=Durations(problem),
        wmap=wmap,
        K={int(wafer.wid): len(wafer.stages) - 1 for wafer in problem.wafers},
        pos=positions,
        occ=occupancy,
        resv={},
        place_t=place_times,
        robot_free={
            robot_name: float(robot.ready_at)
            for robot_name, robot in state.robots.items()
        },
        placed=sum(positions.values()),
        total=sum(max(len(wafer.stages) - 1, 0) for wafer in problem.wafers),
        reserve=False,
        ch_used=chamber_usage,
        route_released=route_released,
        route_wip=route_wip,
    )
    candidates = [
        _Candidate(
            action.wafer_id,
            action.stage_index,
            (action.destination_station, action.destination_slot - 1),
            action.robot,
            action.earliest_start,
        )
        for action in actions
    ]
    return compatibility_state, candidates


class HeuristicMachineSelector:
    """按节拍、驻留风险和交换收益选择搬运意图。

    ``Machine`` 同时保留单向送片与 LoadLock 交换候选。本策略决定是否继续
    投料：若一条送片事务结束前已经有 PM 晶圆需要离腔，则先安排出片，避免
    短加工、多并行腔室场景把真空区堆满后触发驻留超时。
    """

    def __init__(self, problem: Problem | None = None) -> None:
        self.problem = problem
        self._wafer_by_id = (
            {int(wafer.wid): wafer for wafer in problem.wafers}
            if problem is not None
            else {}
        )

    def choose(
        self,
        state: MachineSnapshot,
        actions: Sequence[RobotAction],
    ) -> str:
        """返回确定性的节拍感知首选动作。"""
        residency_limited_departures = [
            action
            for action in actions
            if self._current_stage_type(action) == "process"
            and action.residency_deadline is not None
        ]
        earliest_process_departure = min(
            (
                action.earliest_start
                for action in residency_limited_departures
            ),
            default=float("inf"),
        )

        def priority(action: RobotAction) -> tuple:
            """计算一个候选的驻留风险、流向收益和稳定业务顺序。"""
            current_type = self._current_stage_type(action)
            following_type = self._following_stage_type(action)
            is_process_departure = current_type == "process"
            blocks_ready_output = (
                action.flow_kind == "feed"
                and earliest_process_departure
                <= action.projected_ready_time
            )
            residency_slack = (
                float(action.residency_deadline) - action.earliest_start
                if action.residency_deadline is not None
                else float("inf")
            )
            flow_priority = (
                0
                if action.kind == "ll_exchange"
                else 1
                if is_process_departure
                else 2
                if following_type == "process"
                else 3
                if action.flow_kind == "drain"
                else 4
                if following_type == "sink"
                else 6
                if action.flow_kind == "feed"
                else 5
            )
            return (
                1 if blocks_ready_output else 0,
                min(residency_slack, 0.0),
                action.earliest_start,
                flow_priority,
                residency_slack,
                action.finish_time,
                -action.stage_index,
                action.wafer_id,
                action.destination_station,
            )

        selected = min(
            actions,
            key=priority,
        )
        return selected.action_id

    def _current_stage_type(self, action: RobotAction) -> str:
        """返回候选主晶圆当前工序类型。"""
        wafer = self._wafer_by_id.get(int(action.wafer_id))
        if wafer is None or action.stage_index >= len(wafer.stages):
            return ""
        return str(wafer.stages[action.stage_index].stage_type)

    def _following_stage_type(self, action: RobotAction) -> str:
        """返回候选主晶圆下一工序类型。"""
        wafer = self._wafer_by_id.get(int(action.wafer_id))
        next_index = action.stage_index + 1
        if wafer is None or next_index >= len(wafer.stages):
            return ""
        return str(wafer.stages[next_index].stage_type)


class NeuralMachineSelector:
    """使用现有 SetAttentionNetwork checkpoint 排序 Machine 候选。"""

    def __init__(self, problem: Problem, network: Any) -> None:
        self.problem = problem
        self.network = network
        from src.schedule.neural import _feature_context

        self.context = _feature_context(problem)
        self.decision_count = 0

    def choose(
        self,
        state: MachineSnapshot,
        actions: Sequence[RobotAction],
    ) -> str:
        """按既有候选特征维度和网络分数选择动作。"""
        if len(actions) == 1:
            return actions[0].action_id
        from src.schedule.neural import _candidate_features

        policy_state, candidates = _policy_inputs(self.problem, state, actions)
        scores = self.network.score(
            _candidate_features(policy_state, candidates, self.context)
        )
        self.decision_count += 1
        index = min(
            range(len(actions)),
            key=lambda item: (
                -float(scores[item]),
                actions[item].earliest_start,
                actions[item].wafer_id,
                actions[item].destination_station,
            ),
        )
        return actions[index].action_id


class RlMachineSelector:
    """使用现有 RL/BC ``score_step`` checkpoint 排序 Machine 候选。"""

    def __init__(
        self,
        problem: Problem,
        policy: Any,
        *,
        rng: Any = None,
        temperature: float = 0.7,
    ) -> None:
        self.problem = problem
        self.policy = policy
        self.rng = rng
        self.temperature = float(temperature)

    def choose(
        self,
        state: MachineSnapshot,
        actions: Sequence[RobotAction],
    ) -> str:
        """按原 25 维 step feature 贪心或带 Gumbel 噪声选择动作。"""
        if len(actions) == 1:
            return actions[0].action_id
        from src.schedule.features import step_features

        policy_state, candidates = _policy_inputs(self.problem, state, actions)
        scores = np.asarray(
            self.policy.score_step(step_features(policy_state, candidates)),
            dtype=np.float64,
        )
        if self.rng is not None:
            scores = scores / self.temperature + self.rng.gumbel(size=len(scores))
        index = min(
            range(len(actions)),
            key=lambda item: (
                -float(scores[item]),
                actions[item].earliest_start,
                actions[item].wafer_id,
            ),
        )
        return actions[index].action_id


def _schedule_rows(
    problem: Problem,
    moves: Sequence[Mapping[str, Any]],
    current_time: float,
) -> Dict[int, list[tuple[str, str, float, float]]]:
    """从 Machine MoveList 合成兼容 ``SolveResult.schedule`` 的工序行。"""
    rows: Dict[int, list[list[Any]]] = {
        int(wafer.wid): [
            [
                stage.stage_type,
                stage.chamber,
                float(current_time if index == 0 else 0.0),
                float(current_time if index == 0 else 0.0),
            ]
            for index, stage in enumerate(wafer.stages)
        ]
        for wafer in problem.wafers
    }
    wafer_by_material = {wafer.mat_id: wafer for wafer in problem.wafers}
    current_step = {wafer.mat_id: 0 for wafer in problem.wafers}
    for move in sorted(
        moves,
        key=lambda item: (
            float(item.get("StartTime") or 0.0),
            int(item.get("MoveID") or 0),
        ),
    ):
        material_ids = list(move.get("MatIDList") or [])
        if not material_ids:
            continue
        material_id = material_ids[0]
        wafer = wafer_by_material.get(material_id)
        if wafer is None:
            continue
        if move.get("MoveType") == 0:
            step = current_step[material_id]
            rows[int(wafer.wid)][step][3] = float(move.get("StartTime") or 0.0)
        elif move.get("MoveType") == 1:
            raw_step = move.get("StepID")
            step = (
                int(raw_step)
                if isinstance(raw_step, int)
                else min(current_step[material_id] + 1, len(wafer.stages) - 1)
            )
            destination = str((move.get("DestStationList") or [wafer.stages[step].chamber])[0])
            rows[int(wafer.wid)][step][1] = destination
            rows[int(wafer.wid)][step][2] = float(move.get("EndTime") or 0.0)
            current_step[material_id] = step
    normalized: Dict[int, list[tuple[str, str, float, float]]] = {}
    for wafer in problem.wafers:
        wafer_rows = rows[int(wafer.wid)]
        for index, row in enumerate(wafer_rows):
            if index == len(wafer_rows) - 1:
                row[3] = row[2]
            elif row[3] < row[2]:
                row[3] = row[2]
        normalized[int(wafer.wid)] = [tuple(row) for row in wafer_rows]  # type: ignore[list-item]
    return normalized


def schedule_with_machine(
    problem: Problem,
    selector: Any,
    *,
    initial_state: "MachineState | Mapping[str, Any] | None" = None,
    current_time: float = 0.0,
    initial_move_id: int = 0,
    allow_loadlock_exchange: bool = True,
) -> SolveResult:
    """运行 Machine 并返回保持旧接口兼容的 ``SolveResult``。

    ``allow_loadlock_exchange`` 只控制候选是否可见；是否实际选择交换仍由
    ``selector`` 决定。
    """
    machine = Machine(
        problem,
        initial_state,
        current_time=current_time,
        initial_move_id=initial_move_id,
        allow_loadlock_exchange=allow_loadlock_exchange,
    )
    run_result = machine.run(selector)
    moves = [dict(move) for move in run_result.moves]
    result = SolveResult(
        status=0,
        makespan=run_result.makespan,
        schedule=_schedule_rows(problem, moves, current_time),
        releases=[],
        machine_moves=moves,
        machine_result=run_result,
        machine=machine,
    )
    result.feasible = True  # type: ignore[attr-defined]
    return result


__all__ = [
    "HeuristicMachineSelector",
    "NeuralMachineSelector",
    "RlMachineSelector",
    "schedule_with_machine",
]
