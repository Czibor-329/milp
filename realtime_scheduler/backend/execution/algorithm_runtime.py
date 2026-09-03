"""平台 MoveList 校验与跨轮重算状态运行时。

本模块只依赖平台的标准 ``update``、MoveList 和本地状态机。算法仓库仅在
``execution.service`` 的 ``init/update`` 调用边界参与调度决策；算法输出一旦
返回，校验、现场投影、重算快照和 CJob 卸载均不再调用或构造 alg 仓库对象。
"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.execution.run_state import *


class PlatformMoveListRuntime:
    """用平台状态机维护标准算法输出的跨轮时间线。

    参数:
        update_params: 当前轮算法标准输入快照。
        output: 当前轮算法返回的标准输出。
        compatibility_mode: 是否按 HongYe module-parallel 语义物化计划时间。

    所有状态均由 ``validation.move_validation`` 维护，不读取 alg 的 Problem、
    Machine 或动作枚举实现。
    """

    def __init__(self, update_params: Mapping[str, Any], output: Mapping[str, Any], *, compatibility_mode: bool = False, skipped_clean_validation_types: Optional[Sequence[str]] = None) -> None:
        """以标准 update 建立首轮物理快照，并校验算法输出。"""
        self.current_update = deepcopy(dict(update_params))
        self.compatibility_mode = bool(compatibility_mode)
        self.skipped_clean_validation_types = tuple(skipped_clean_validation_types or ())
        initial_state = MachineState.from_sources(None, self.current_update)
        initial_state.skipped_clean_validation_types = set(self.skipped_clean_validation_types)
        initial_moves = deepcopy(list(output.get("MoveList") or []))
        if self.compatibility_mode:
            initial_moves = materialize_module_parallel_moves(initial_moves, float(self.current_update.get("CurrentTime") or 0.0))
        validation_issues = validate_move_list(None, initial_moves, initial_state, skipped_clean_validation_types=self.skipped_clean_validation_types)
        if validation_issues:
            raise MoveListValidationError(
                _state_advance_error_message(validation_issues[0]),
                output, validation_issues,
                _build_validation_gantt_output(output, validation_issues),
                float(self.current_update.get("CurrentTime") or 0.0),
            )
        self._tracker = MoveStateReplay(None, initial_moves, initial_state)
        self._generation_initial_state = initial_state.clone()
        self._tracker.current_time = float(self.current_update.get("CurrentTime") or 0.0)
        self._history: List[dict] = []
        self._recompute_points: List[Dict[str, Any]] = []
        self._latest_output = _alg_output_info(output)

    @property
    def current_plan(self) -> List[dict]:
        """返回当前算法代次的 MoveList 副本。"""
        return self._tracker.materialized_plan

    @property
    def state(self) -> MachineState:
        """返回平台记录器维护的隔离整机快照。"""
        return self._tracker.state.clone()

    @property
    def state_time(self) -> float:
        """返回已经推进到的物理状态时间。"""
        return float(self._tracker.current_time)

    def advance_to(self, cutoff: float) -> None:
        """在时间线上推进当前快照时刻。"""
        self._tracker.current_time = max(self._tracker.current_time, float(cutoff))

    def update_move_state(self, notification: Mapping[str, Any], *, snapshot: bool = True, track_reservations: bool = True) -> Optional[MachineState]:
        """把算法时间线通知交给平台物理状态记录器。"""
        return self._tracker.update_move_state(notification, snapshot=snapshot, track_reservations=track_reservations)

    def robot_position(self, robot_name: str) -> Optional[str]:
        """返回平台快照中指定机器人的当前对准站点。"""
        robot = self._tracker.state.resolve_robot(robot_name)
        return robot.position if robot is not None else None

    def release_completed_load_ports(self, load_port_names: Sequence[str]) -> Tuple[set[Any], set[str]]:
        """根据已完成 Move 和平台快照释放产品晶圆及 LoadPort。"""
        material_moves: Dict[Any, List[Mapping[str, Any]]] = {}
        for move in self.current_plan:
            for material_id in _move_material_ids(move):
                material_moves.setdefault(material_id, []).append(move)
        completed_material_ids = {
            material_id for material_id, moves in material_moves.items()
            if moves and max(float(move.get("EndTime") or move.get("StartTime") or 0.0) for move in moves) <= self.state_time + TIME_TOLERANCE
        }
        requested_load_ports = {str(name) for name in load_port_names if str(name)}
        released_ids: set[Any] = set()
        for load_port_name in requested_load_ports:
            station = self._tracker.state.stations.get(load_port_name)
            if station is None:
                continue
            for slot in station.slots.values():
                material = slot.material
                if material is not None and material.material_id in completed_material_ids:
                    released_ids.add(material.material_id)
        if released_ids:
            _remove_released_materials_from_update(self.current_update, released_ids)
        empty_ports = {
            name for name in requested_load_ports
            if (station := self._tracker.state.stations.get(name)) is None
            or all(slot.material is None or slot.material.material_id in released_ids for slot in station.slots.values())
        }
        return released_ids, empty_ports

    def committed_moves(self, cutoff: float) -> List[dict]:
        """返回重算时刻前已经启动、不能从历史中删除的动作。"""
        return [
            deepcopy(move)
            for move in self.current_plan
            if float(move.get("StartTime") or 0.0) < float(cutoff) - TIME_TOLERANCE
        ]

    def project_started_moves(self, cutoff: float, released_material_ids: Optional[set[Any]] = None) -> Tuple[MachineState, List[dict]]:
        """把重算时刻前已启动的动作投影到完成态并返回已承诺动作。"""
        committed_ids = {
            int(move["MoveID"]) for move in self.current_plan
            if isinstance(move.get("MoveID"), int) and float(move.get("StartTime") or 0.0) < float(cutoff) - TIME_TOLERANCE
        }
        projection = MoveStateReplay(None, self.current_plan, self._generation_initial_state)
        started: set[int] = set()
        finished: set[int] = set()
        for event_kind, _, notification in _planned_events(self.current_plan, module_parallel=self.compatibility_mode):
            move_id = int(notification["MoveID"])
            if event_kind == "start" and move_id in committed_ids and move_id not in started:
                projection.update_move_state(notification, snapshot=False, track_reservations=False)
                started.add(move_id)
            elif event_kind == "finish" and move_id in committed_ids and move_id in started and move_id not in finished:
                projection.update_move_state(notification, snapshot=False, track_reservations=False)
                finished.add(move_id)
        missing_ids = committed_ids - finished
        if missing_ids:
            raise ValueError(f"无法投影重算时刻前已启动的 Move：{sorted(missing_ids)[:8]}")
        projected_state = projection.state.clone()
        released_ids = set(released_material_ids or ())
        if released_ids:
            for station in projected_state.stations.values():
                for slot in station.slots.values():
                    if slot.material is not None and slot.material.material_id in released_ids:
                        slot.phase = SlotPhase.EMPTY
                        slot.material = None
            for robot in projected_state.robots.values():
                for slot_id, material in robot.hands.items():
                    if material is not None and material.material_id in released_ids:
                        robot.hands[slot_id] = None
        return projected_state, projection.executed_moves

    def replace_plan(self, update_params: Mapping[str, Any], output: Mapping[str, Any], requested_time: float, reason: str, committed_moves: Sequence[Mapping[str, Any]], *, initial_state: Optional[MachineState] = None) -> None:
        """提交旧代历史，并以平台校验器装载新的计划代次。"""
        next_state = initial_state.clone() if initial_state is not None else self._tracker.state.clone()
        add_new_materials_to_machine_state(next_state, update_params)
        next_state.refresh_validation_metadata(update_params)
        next_moves = deepcopy(list(output.get("MoveList") or []))
        if self.compatibility_mode:
            next_moves = materialize_module_parallel_moves(next_moves, float(requested_time))
        committed = deepcopy(list(committed_moves))
        validation_issues = validate_move_list(
            None, next_moves, next_state,
            external_predecessors=_committed_move_index([*self._history, *committed]),
            skipped_clean_validation_types=self.skipped_clean_validation_types,
        )
        if validation_issues:
            recompute_point = {
                "Time": float(requested_time), "EffectiveTime": float(requested_time),
                "ScheduleStartTime": float(requested_time), "RecoveryEndTime": float(requested_time),
                "Index": len(self._recompute_points) + 1, "Reason": reason, "Validation": "failed",
            }
            raise MoveListValidationError(
                _state_advance_error_message(validation_issues[0]), output, validation_issues,
                _build_validation_gantt_output(output, validation_issues, prefix_moves=[*self._history, *committed], recompute_points=[*self._recompute_points, recompute_point]),
                float(requested_time),
            )
        self._history.extend(committed)
        self.current_update = deepcopy(dict(update_params))
        self._tracker = MoveStateReplay(None, next_moves, next_state)
        self._generation_initial_state = next_state.clone()
        self._tracker.current_time = float(requested_time)
        self._latest_output = _alg_output_info(output)
        self._recompute_points.append({
            "Time": float(requested_time), "EffectiveTime": float(requested_time),
            "ScheduleStartTime": float(requested_time), "RecoveryEndTime": float(requested_time),
            "Index": len(self._recompute_points) + 1, "Reason": reason,
        })

    def combined_output(self) -> Dict[str, Any]:
        """拼接旧代已承诺动作与最后一代有效计划。"""
        moves = [*deepcopy(self._history), *self._tracker.materialized_plan]
        moves.sort(key=lambda move: (float(move.get("StartTime") or 0.0), int(move.get("MoveID") or 0)))
        output = _alg_output_info(self._latest_output)
        output["MoveList"] = moves
        output["RecomputePoints"] = deepcopy(self._recompute_points)
        return output


__all__ = tuple(name for name in globals() if not name.startswith("__"))
