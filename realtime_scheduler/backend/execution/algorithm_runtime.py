"""内置算法与标准外部算法的跨代运行时。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.execution.run_state import *

class StandardAlgorithmRuntime:
    """用本仓库状态机维护标准算法当前计划和跨代执行历史。"""

    def __init__(
        self,
        tool_topo: Mapping[str, Any],
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        *,
        skip_validation: bool = False,
    ) -> None:
        """解析首轮完整 update，并把外部 MoveList 挂到实时状态回放器。

        ``skip_validation`` 为 True 时跳过 MoveList 合法性校验，直接回放算法
        原始输出（用户显式选择“跳过输出校验”）。
        """
        self.tool_topo = deepcopy(dict(tool_topo))
        self.current_update = deepcopy(dict(update_params))
        self.skip_validation = bool(skip_validation)
        self.problem = compile_problem(self.tool_topo, self.current_update)
        initial_state = MachineState.from_sources(self.problem, self.current_update)
        initial_moves = list(output.get("MoveList") or [])
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(
                self.problem,
                initial_moves,
                initial_state,
            )
        )
        if validation_issues:
            message = (
                "标准算法首次排程 MoveList 状态校验失败："
                f"{validation_issues[0]}"
            )
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(output, validation_issues),
                float(self.current_update.get("CurrentTime") or 0.0),
            )
        self._tracker = MoveStateReplay(
            self.problem,
            initial_moves,
            initial_state,
        )
        self._generation_initial_state = initial_state.clone()
        self._tracker.current_time = float(self.current_update.get("CurrentTime") or 0.0)
        self._history: List[dict] = []
        self._recompute_points: List[Dict[str, Any]] = []
        self._committed_recovery_end = float(
            self.current_update.get("CurrentTime") or 0.0
        )
        self._latest_output = _alg_output_info(output)

    @property
    def current_plan(self) -> List[dict]:
        """返回当前计划代次，供统一的安全切点投影函数消费。"""
        return [dict(move) for move in self._tracker.materialized_plan]

    @property
    def state(self) -> MachineState:
        """返回由平台物理状态记录器维护的隔离整机快照。"""
        return self._tracker.state.clone()

    @property
    def state_time(self) -> float:
        """返回已经回放到的绝对时间。"""
        return float(self._tracker.current_time)

    @property
    def committed_recovery_end(self) -> float:
        """返回此前重算已承诺、不能再被后续重算取消的最晚结束时刻。"""
        return float(self._committed_recovery_end)

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

    def project_started_moves(
        self,
        cutoff: float,
        released_material_ids: Optional[set[Any]] = None,
    ) -> Tuple[MachineState, List[dict]]:
        """把重算时刻前已启动的 Move 全部投影到完成态。

        外部算法的 update 不由前端执行安全收尾，但标准接口要求现场快照体现
        已经启动、不可取消动作的完成态。这里从本代初始状态重新回放，只提交
        ``StartTime < cutoff`` 的动作；重算时刻及之后的动作留给 RemoveList。

        参数:
            cutoff: 用户请求的原始重算时刻。
            released_material_ids: 已在本轮卸载、不得重新写入快照的物料编号。

        返回:
            投影后的整机状态，以及本代所有已承诺动作的 MoveList。
        """
        committed_ids = {
            int(move["MoveID"])
            for move in self.current_plan
            if (
                isinstance(move.get("MoveID"), int)
                and float(move.get("StartTime") or 0.0)
                < float(cutoff) - TIME_TOLERANCE
            )
        }
        projection = MoveStateReplay(
            self.problem,
            self.current_plan,
            self._generation_initial_state,
        )
        started: set[int] = set()
        finished: set[int] = set()
        for group in _planned_event_groups(self.current_plan):
            for _, notification in group["priorFinishes"]:
                move_id = int(notification["MoveID"])
                if move_id in committed_ids and move_id in started and move_id not in finished:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
            for event_kind, _, notification in _planned_start_events(group):
                move_id = int(notification["MoveID"])
                if event_kind == "start" and move_id in committed_ids and move_id not in started:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    started.add(move_id)
                elif (
                    event_kind == "finish"
                    and move_id in committed_ids
                    and move_id in started
                    and move_id not in finished
                ):
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
        missing = committed_ids - finished
        if missing:
            raise ValueError(
                f"无法投影重算时刻前已启动的 Move：{sorted(missing)[:8]}"
            )

        projected_state = projection.state.clone()
        released_ids = set(released_material_ids or ())
        if released_ids:
            for station in projected_state.stations.values():
                for slot in station.slots.values():
                    if (
                        slot.material is not None
                        and slot.material.material_id in released_ids
                    ):
                        slot.phase = SlotPhase.EMPTY
                        slot.material = None
            for robot in projected_state.robots.values():
                for slot_id, material in robot.hands.items():
                    if (
                        material is not None
                        and material.material_id in released_ids
                    ):
                        robot.hands[slot_id] = None
        return projected_state, projection.executed_moves

    def replace_plan(
        self,
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        requested_time: float,
        effective_time: float,
        reason: str,
        *,
        initial_state: Optional[MachineState] = None,
        committed_moves: Optional[Sequence[Mapping[str, Any]]] = None,
        compile_for_validation: bool = True,
    ) -> None:
        """保存已执行历史，以调用方给定的重算快照装载下一代计划。

        外部标准算法已经按完整 update 编译过 Dummy 清洗作业；此时平台再次调用
        内置 ``compile_problem`` 会把跨轮 ProcessJobs 的 PreDummyClean 重新合成，
        导致同一个 Dummy MatID 被两份内部 PJob 重复占用。外部算法装载可关闭
        语义编译，仅用标准 update 和 MoveList 做平台物理校验。
        """
        next_state = (
            initial_state.clone()
            if initial_state is not None
            else self._tracker.state.clone()
        )
        add_new_materials_to_machine_state(next_state, update_params)
        next_update = deepcopy(dict(update_params))
        next_problem = (
            compile_problem(self.tool_topo, next_update)
            if compile_for_validation
            else _compile_external_validation_problem(self.tool_topo, next_update)
        )
        next_moves = list(output.get("MoveList") or [])
        committed = (
            deepcopy(list(committed_moves))
            if committed_moves is not None
            else self._tracker.executed_moves
        )
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(
                next_problem,
                next_moves,
                next_state,
                # 重算增量输出可引用旧代已提交/正在执行的 Move 作为前驱。
                external_predecessors=_committed_move_index(
                    [*self._history, *committed]
                ),
            )
        )
        if validation_issues:
            message = f"{reason} MoveList 状态校验失败：{validation_issues[0]}"
            recompute_point = {
                "Time": float(requested_time),
                "EffectiveTime": float(effective_time),
                "ScheduleStartTime": float(effective_time),
                "RecoveryEndTime": float(effective_time),
                "Index": len(self._recompute_points) + 1,
                "Reason": reason,
                "Validation": "failed",
            }
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(
                    output,
                    validation_issues,
                    prefix_moves=[*self._history, *committed],
                    recompute_points=[
                        *self._recompute_points,
                        recompute_point,
                    ],
                ),
                float(effective_time),
            )
        next_tracker = MoveStateReplay(
            next_problem,
            next_moves,
            next_state,
        )
        self._history.extend(committed)
        self.current_update = next_update
        self.problem = next_problem
        self._tracker = next_tracker
        self._generation_initial_state = next_state.clone()
        self._tracker.current_time = float(effective_time)
        self._committed_recovery_end = max(
            self._committed_recovery_end,
            float(effective_time),
        )
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


class PackagedAlgorithmRuntime:
    """在没有本地算法仓库时用平台状态记录器维护跨轮时间线。"""

    def __init__(
        self,
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        *,
        skip_validation: bool = False,
    ) -> None:
        """以标准 update 建立首轮物理快照，并校验算法包输出。"""
        self.current_update = deepcopy(dict(update_params))
        self.skip_validation = bool(skip_validation)
        initial_state = MachineState.from_sources(None, self.current_update)
        initial_moves = deepcopy(list(output.get("MoveList") or []))
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(None, initial_moves, initial_state)
        )
        if validation_issues:
            message = (
                "标准算法首次排程 MoveList 状态校验失败："
                f"{validation_issues[0]}"
            )
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(output, validation_issues),
                float(self.current_update.get("CurrentTime") or 0.0),
            )
        self._tracker = MoveStateReplay(None, initial_moves, initial_state)
        self._generation_initial_state = initial_state.clone()
        self._tracker.current_time = float(
            self.current_update.get("CurrentTime") or 0.0
        )
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
        self._tracker.current_time = max(
            self._tracker.current_time,
            float(cutoff),
        )

    def update_move_state(
        self,
        notification: Mapping[str, Any],
        *,
        snapshot: bool = True,
        track_reservations: bool = True,
    ) -> Optional[MachineState]:
        """把算法包时间线通知交给平台物理状态记录器。"""
        return self._tracker.update_move_state(
            notification,
            snapshot=snapshot,
            track_reservations=track_reservations,
        )

    def release_completed_load_ports(
        self,
        load_port_names: Sequence[str],
    ) -> Tuple[set[Any], set[str]]:
        """根据当前代次的最终动作释放已完成物料及其 LoadPort。

        轻量模式不解释设备状态，只在某片物料的本代最后动作已经结束时认定
        该片完成。释放范围必须同时受调用方给出的 LoadPort 和物理快照约束；
        返回 DummyPort 的清洁片虽然本代动作已经结束，仍是可复用库存，不能
        作为产品成品从下一轮 Materials 中移除。只有同一 LoadPort 的历史物料
        全部完成后才允许槽位复用。
        """
        material_moves: Dict[Any, List[Mapping[str, Any]]] = {}
        for move in self.current_plan:
            for material_id in _move_material_ids(move):
                material_moves.setdefault(material_id, []).append(move)
        completed_material_ids = {
            material_id
            for material_id, moves in material_moves.items()
            if moves and max(
                float(move.get("EndTime") or move.get("StartTime") or 0.0)
                for move in moves
            ) <= self.state_time + TIME_TOLERANCE
        }
        requested_load_ports = {
            str(load_port_name)
            for load_port_name in load_port_names
            if str(load_port_name)
        }
        released_ids: set[Any] = set()
        for load_port_name in requested_load_ports:
            station = self._tracker.state.stations.get(load_port_name)
            if station is None:
                continue
            for slot in station.slots.values():
                material = slot.material
                if (
                    material is not None
                    and material.material_id in completed_material_ids
                ):
                    released_ids.add(material.material_id)
        if released_ids:
            _remove_released_materials_from_update(self.current_update, released_ids)

        empty_ports: set[str] = set()
        for load_port_name in requested_load_ports:
            station = self._tracker.state.stations.get(load_port_name)
            if station is None or all(
                slot.material is None
                or slot.material.material_id in released_ids
                for slot in station.slots.values()
            ):
                empty_ports.add(load_port_name)
        return released_ids, empty_ports

    def committed_moves(self, cutoff: float) -> List[dict]:
        """返回重算时刻前已经启动、不能从历史中删除的动作。"""
        return [
            deepcopy(move)
            for move in self.current_plan
            if float(move.get("StartTime") or 0.0)
            < float(cutoff) - TIME_TOLERANCE
        ]

    def project_started_moves(
        self,
        cutoff: float,
        released_material_ids: Optional[set[Any]] = None,
    ) -> Tuple[MachineState, List[dict]]:
        """把重算时刻前已启动的动作从代次初态完整投影到结束态。"""
        committed_ids = {
            int(move["MoveID"])
            for move in self.current_plan
            if (
                isinstance(move.get("MoveID"), int)
                and float(move.get("StartTime") or 0.0)
                < float(cutoff) - TIME_TOLERANCE
            )
        }
        projection = MoveStateReplay(
            None,
            self.current_plan,
            self._generation_initial_state,
        )
        started: set[int] = set()
        finished: set[int] = set()
        for group in _planned_event_groups(self.current_plan):
            for _, notification in group["priorFinishes"]:
                move_id = int(notification["MoveID"])
                if move_id in committed_ids and move_id in started and move_id not in finished:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
            for event_kind, _, notification in _planned_start_events(group):
                move_id = int(notification["MoveID"])
                if event_kind == "start" and move_id in committed_ids and move_id not in started:
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    started.add(move_id)
                elif (
                    event_kind == "finish"
                    and move_id in committed_ids
                    and move_id in started
                    and move_id not in finished
                ):
                    projection.update_move_state(
                        notification,
                        snapshot=False,
                        track_reservations=False,
                    )
                    finished.add(move_id)
        missing_ids = committed_ids - finished
        if missing_ids:
            raise ValueError(
                f"无法投影重算时刻前已启动的 Move：{sorted(missing_ids)[:8]}"
            )

        projected_state = projection.state.clone()
        released_ids = set(released_material_ids or ())
        if released_ids:
            for station in projected_state.stations.values():
                for slot in station.slots.values():
                    if (
                        slot.material is not None
                        and slot.material.material_id in released_ids
                    ):
                        slot.phase = SlotPhase.EMPTY
                        slot.material = None
            for robot in projected_state.robots.values():
                for slot_id, material in robot.hands.items():
                    if material is not None and material.material_id in released_ids:
                        robot.hands[slot_id] = None
        return projected_state, projection.executed_moves

    def replace_plan(
        self,
        update_params: Mapping[str, Any],
        output: Mapping[str, Any],
        requested_time: float,
        reason: str,
        committed_moves: Sequence[Mapping[str, Any]],
        *,
        initial_state: Optional[MachineState] = None,
    ) -> None:
        """提交旧代历史，并从投影快照装载、校验新的计划代次。"""
        next_state = (
            initial_state.clone()
            if initial_state is not None
            else self._tracker.state.clone()
        )
        add_new_materials_to_machine_state(next_state, update_params)
        next_moves = deepcopy(list(output.get("MoveList") or []))
        committed = deepcopy(list(committed_moves))
        validation_issues = (
            []
            if self.skip_validation
            else validate_move_list(
                None,
                next_moves,
                next_state,
                # 重算增量输出可引用旧代已提交/正在执行的 Move 作为前驱。
                external_predecessors=_committed_move_index(
                    [*self._history, *committed]
                ),
            )
        )
        if validation_issues:
            message = f"{reason} MoveList 状态校验失败：{validation_issues[0]}"
            recompute_point = {
                "Time": float(requested_time),
                "EffectiveTime": float(requested_time),
                "ScheduleStartTime": float(requested_time),
                "RecoveryEndTime": float(requested_time),
                "Index": len(self._recompute_points) + 1,
                "Reason": reason,
                "Validation": "failed",
            }
            raise MoveListValidationError(
                message,
                output,
                validation_issues,
                _build_validation_gantt_output(
                    output,
                    validation_issues,
                    prefix_moves=[*self._history, *committed],
                    recompute_points=[*self._recompute_points, recompute_point],
                ),
                float(requested_time),
            )
        self._history.extend(committed)
        self.current_update = deepcopy(dict(update_params))
        self._tracker = MoveStateReplay(None, next_moves, next_state)
        self._generation_initial_state = next_state.clone()
        self._tracker.current_time = float(requested_time)
        self._latest_output = _alg_output_info(output)
        self._recompute_points.append({
            "Time": float(requested_time),
            "EffectiveTime": float(requested_time),
            "ScheduleStartTime": float(requested_time),
            "RecoveryEndTime": float(requested_time),
            "Index": len(self._recompute_points) + 1,
            "Reason": reason,
        })

    def combined_output(self) -> Dict[str, Any]:
        """拼接旧代已承诺动作与最后一代有效计划。"""
        moves = [*deepcopy(self._history), *self._tracker.materialized_plan]
        moves.sort(key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move.get("MoveID") or 0),
        ))
        output = _alg_output_info(self._latest_output)
        output["MoveList"] = moves
        output["RecomputePoints"] = deepcopy(self._recompute_points)
        return output



__all__ = tuple(name for name in globals() if not name.startswith('__'))
