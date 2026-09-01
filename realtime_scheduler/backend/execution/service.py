"""单次计划执行、算法多轮调用、校验和复现日志编排。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.execution.run_state import *
from realtime_scheduler.backend.execution.algorithm_runtime import *
from realtime_scheduler.backend.execution.cjob_cycle import *

def _execute_standard_algorithm(
    plan: Mapping[str, Any],
    first_update: Mapping[str, Any],
    rounds: Sequence[Mapping[str, Any]],
    times: Sequence[float],
    build_state: BuildState,
    reproduction: ReproductionLog,
    started: float,
    algorithm_id: Optional[str] = None,
    *,
    builtin_strategy: Optional[str] = None,
) -> Dict[str, Any]:
    """通过同一次标准 ``init/update`` 会话执行首排和多次实时重算。

    ``algorithm_id`` 选择 ``other_alg`` 包；``builtin_strategy`` 选择当前
    仓库内置算法。两者互斥，但共用完全相同的企业接口数据流。
    """
    if (algorithm_id is None) == (builtin_strategy is None):
        raise ValueError("标准算法执行必须且只能选择一种算法来源")
    use_hongye_validation = bool(plan.get("hongYeCheck", True))
    compatibility_mode = bool(plan.get("compatibilityMode", True))
    round_count = len(rounds)
    if builtin_strategy is not None:
        if not BUILTIN_ALGORITHM_AVAILABLE:
            detail = (
                f"（{BUILTIN_ALGORITHM_IMPORT_ERROR}）"
                if BUILTIN_ALGORITHM_IMPORT_ERROR
                else ""
            )
            raise RuntimeError(
                "当前部署未提供本地算法仓库，内置策略不可用"
                f"{detail}；请选择已安装的 other_alg 标准算法"
            )
        strategy = builtin_strategy
        backend = "src.api"
        display_name = builtin_strategy
        entry_name = "src.api.init/update"
        session_context = builtin_algorithm_session()

        def initialize(payload: Mapping[str, Any]) -> None:
            """通过公开 JSON 入口初始化内置算法。"""
            builtin_algorithm_api.init(
                json.dumps(dict(payload), ensure_ascii=False)
            )

        def run_update(payload: Mapping[str, Any]) -> Dict[str, Any]:
            """通过公开 JSON 入口执行内置算法并解析标准输出。"""
            raw_output = builtin_algorithm_api.update(
                json.dumps(dict(payload), ensure_ascii=False),
                builtin_strategy,
            )
            parsed = json.loads(raw_output)
            if not isinstance(parsed, dict):
                raise RuntimeError("内置算法 update 返回值不是 JSON 对象")
            if isinstance(parsed.get("Info"), dict):
                parsed = dict(parsed["Info"])
            return dict(parsed)

        prepared_first_update = deepcopy(dict(first_update))
        options = plan.get("options")
        if isinstance(options, Mapping):
            prepared_first_update["AlgorithmOptions"] = deepcopy(dict(options))
    else:
        strategy = f"other_alg:{algorithm_id}"
        backend = f"other_alg/{algorithm_id}"
        display_name = str(algorithm_id)
        discovered_entry = next(
            (
                item for item in discover_other_algorithms()
                if str(item.get("id") or "").casefold() == str(algorithm_id).casefold()
            ),
            None,
        )
        entry_name = (
            f"{str(discovered_entry.get('entry') or 'scheduler.py')} init/update"
            if discovered_entry is not None
            else "CT.infer.scheduler.init/update"
        )
        session_context = algorithm_session(str(algorithm_id))
        initialize = algorithm_init
        run_update = algorithm_update
        prepared_first_update = deepcopy(dict(first_update))

    summaries: List[Dict[str, Any]] = []
    update_snapshots: List[Dict[str, Any]] = [deepcopy(prepared_first_update)]
    logs = [
        f"设备：{plan.get('deviceName') or 'selected init'}",
        f"策略：{strategy}；调用：{entry_name}；总轮数：{round_count}",
    ]
    with session_context:
        round_started = time.perf_counter()
        _raise_if_single_run_cancelled()
        _report_run_event("init", "init", "running")
        try:
            initialize(plan["device"])
            _raise_if_single_run_cancelled()
        except Exception as error:
            _report_run_event("init", "init", "failed", str(error))
            raise
        _report_run_event("init", "init", "succeeded")
        _report_run_event("update-1", "update #1", "running")
        try:
            raw_output = run_update(prepared_first_update)
            _raise_if_single_run_cancelled()
        except Exception as error:
            _report_run_event("update-1", "update #1", "failed", str(error))
            raise
        _report_run_event("update-1", "update #1", "succeeded")
        elapsed_ms = (time.perf_counter() - round_started) * 1000.0
        output = _alg_output_info(raw_output)
        _report_run_event("output-1", "收到 output #1", "succeeded")
        _raise_deadlock_feedback(
            output,
            reproduction,
            context="initial",
        )
        _report_run_event("validation-1", "校验 output #1", "running")
        try:
            _ensure_algorithm_output(output, prepared_first_update)
        except Exception as error:
            _report_run_event("validation-1", "校验 output #1", "failed", str(error))
            raise
        runtime: Any
        try:
            runtime = PlatformMoveListRuntime(
                prepared_first_update,
                output,
            compatibility_mode=compatibility_mode,
            )
            state_source = "realtime_scheduler.backend.validation.move_validation.MachineState"
        except Exception as error:
            _report_run_event("validation-1", "校验 output #1", "failed", str(error))
            raise
        _report_run_event(
            "validation-1",
            "状态推进校验 #1",
            "succeeded",
        )
        reproduction.add("AlgOutput", output)
        summaries.append({
            "index": 1,
            "kind": "initial",
            "requestedTime": 0.0,
            "effectiveTime": 0.0,
            "scheduleStartTime": 0.0,
            "recoveryEndTime": 0.0,
            "jobCount": _round_pjob_count(rounds[0]),
            "elapsedMs": elapsed_ms,
            "segmentEnd": _segment_end(runtime.current_plan),
            "strategyDiagnostics": {
                "backend": backend,
                "entry": entry_name,
                "feedbackCount": len(output["Feedback"]),
                "removedMoveCount": 0,
                "stateSource": state_source,
                **(
                    builtin_strategy_diagnostics()
                    if builtin_strategy is not None
                    else {}
                ),
            },
        })
        logs.append(
            f"[1/{round_count}] {display_name} 首排完成："
            f"{elapsed_ms:.1f} ms，{len(output['MoveList'])} Moves"
        )

        active_cycles = _cycle_states_for_round(rounds[0], 1)

        def execute_recompute_event(
            round_config: Mapping[str, Any],
            requested_time: float,
            reason: str,
            trigger: str,
            configured_round: Optional[int] = None,
            completed_cycles: Sequence[CJobCycleRuntime] = (),
        ) -> Tuple[set[Any], set[str]]:
            """执行一次定时或补片重算，并更新当前算法代次。"""
            nonlocal output
            notifications = advance_platform_move_list_to_update(
                runtime,
                requested_time,
            )
            cycle_material_ids = (
                _completed_cycle_material_ids(
                    runtime.current_update,
                    completed_cycles,
                )
                if completed_cycles
                else set()
            )
            cycle_load_ports = (
                tuple(cycle_state.load_port for cycle_state in completed_cycles)
                if completed_cycles
                else None
            )
            released_ids, empty_ports = _release_finished_load_ports(
                runtime,
                build_state,
                cycle_load_ports,
            )
            if completed_cycles:
                # CJobCycle 的触发时刻已经由“该 TaskID 全部物料的最后一个 Move
                # 结束”推导得到。这里按 TaskID + 固定 LoadPort 明确卸载整盒，
                # 避免部分算法没有把回 LP 动作标成 sink stage 时，通用终点识别
                # 无法裁剪旧 CJob；同 TaskID 的 DummyPort 清洁库存必须保留。
                released_ids.update(cycle_material_ids)
                _remove_released_materials_from_update(
                    runtime.current_update,
                    cycle_material_ids,
                )
                for cycle_state in completed_cycles:
                    empty_ports.add(cycle_state.load_port)
                    build_state.next_slot_by_port[cycle_state.load_port] = 0
            projected_state, committed_moves = runtime.project_started_moves(
                requested_time,
                released_ids,
            )
            for notification in notifications:
                event_time = (
                    notification.get("EndTime")
                    if notification.get("MoveState") == MoveStateReplay.DONE
                    else notification.get("StartTime")
                )
                reproduction.add(
                    "AlgUpdateMove",
                    notification,
                    _finite_number(event_time, requested_time),
                )
            recompute_index = len(summaries) + 1
            reproduction.add("RecomputeControl", {
                "ControlInfo": {
                    "Round": recompute_index,
                    "ConfiguredRound": configured_round,
                    "Trigger": trigger,
                },
                "RecomputeInfo": {
                    "CurrentTime": requested_time,
                    "EffectiveTime": requested_time,
                    "Reason": reason,
                },
            }, requested_time)

            new_round_update = build_round_update(
                plan,
                round_config,
                requested_time,
                build_state,
            )
            reused_slot_material_ids = release_reused_source_slots(
                projected_state,
                new_round_update,
            )
            if reused_slot_material_ids:
                released_ids.update(reused_slot_material_ids)
                _remove_released_materials_from_update(
                    runtime.current_update,
                    reused_slot_material_ids,
                )
            update = _build_platform_recompute_update(
                runtime,
                new_round_update,
                requested_time,
                (
                    notifications
                    if builtin_strategy is not None
                    else _running_move_states(notifications)
                ),
                projected_state=projected_state,
                previous_output=output,
            )
            update_snapshots.append(deepcopy(update))
            reproduction.add(
                "AlgSchedule",
                _schedule_log_info(plan["device"], update),
                requested_time,
            )
            round_started = time.perf_counter()
            _raise_if_single_run_cancelled()
            _report_run_event(
                f"update-{recompute_index}",
                f"update #{recompute_index}",
                "running",
            )
            try:
                raw_output = run_update(update)
                _raise_if_single_run_cancelled()
            except Exception as error:  # noqa: BLE001
                _report_run_event(
                    f"update-{recompute_index}",
                    f"update #{recompute_index}",
                    "failed",
                    str(error),
                )
                cancelled_error_type = globals().get("SearchCancelledError")
                if (
                    isinstance(error, UserRunCancelledError)
                    or cancelled_error_type is not None
                    and isinstance(error, cancelled_error_type)
                ):
                    # 用户主动取消属于预期终止，不得伪装成算法失败快照。
                    raise
                failure_output = _build_recompute_failure_output(
                    runtime,
                    update,
                    requested_time,
                    reason,
                    error,
                )
                reproduction.add("AlgOutput", failure_output, requested_time)
                raise LoggedPlanError(
                    f"{reason} 算法执行失败：{str(error) or type(error).__name__}",
                    reproduction.entries,
                    failure_output=failure_output,
                ) from error
            _report_run_event(
                f"update-{recompute_index}",
                f"update #{recompute_index}",
                "succeeded",
            )
            elapsed_ms = (time.perf_counter() - round_started) * 1000.0
            output = _alg_output_info(raw_output)
            _report_run_event(
                f"output-{recompute_index}",
                f"收到 output #{recompute_index}",
                "succeeded",
            )
            _raise_deadlock_feedback(
                output,
                reproduction,
                sim_time=requested_time,
                context=reason,
            )
            _report_run_event(
                f"validation-{recompute_index}",
                f"校验 output #{recompute_index}",
                "running",
            )
            try:
                _ensure_algorithm_output(output, update)
                runtime.replace_plan(
                    update,
                    output,
                    requested_time,
                    reason,
                    committed_moves,
                    initial_state=projected_state,
                )
            except Exception as error:
                _report_run_event(
                    f"validation-{recompute_index}",
                    f"校验 output #{recompute_index}",
                    "failed",
                    str(error),
                )
                raise
            _report_run_event(
                f"validation-{recompute_index}",
                f"状态推进校验 #{recompute_index}",
                "succeeded",
            )
            reproduction.add("AlgOutput", output, requested_time)
            summaries.append({
                "index": recompute_index,
                "kind": "recompute",
                "trigger": trigger,
                "configuredRound": configured_round,
                "requestedTime": requested_time,
                "effectiveTime": requested_time,
                "scheduleStartTime": requested_time,
                "recoveryEndTime": requested_time,
                "jobCount": _round_pjob_count(round_config),
                "elapsedMs": elapsed_ms,
                "segmentEnd": _segment_end(runtime.current_plan),
                "strategyDiagnostics": {
                    "backend": backend,
                    "entry": entry_name,
                    "feedbackCount": len(output["Feedback"]),
                    "removedMoveCount": len(update["RemoveList"]),
                    "moveStateCount": len(update["MoveStates"]),
                    "stateSource": state_source,
                    **(
                        builtin_strategy_diagnostics()
                        if builtin_strategy is not None
                        else {}
                    ),
                },
            })
            logs.append(
                f"[重算 {recompute_index - 1}] @{requested_time:.2f}s {display_name} {reason}："
                f"{elapsed_ms:.1f} ms，移除 {len(update['RemoveList'])} 个旧 Move"
            )
            if released_ids:
                logs.append(
                    f"  已卸载 {len(released_ids)} 片成品；"
                    f"清空 LoadPort={','.join(sorted(empty_ports)) or '无'}"
                )
            return released_ids, empty_ports

        next_configured_round = 1
        while True:
            next_timed_time = (
                float(times[next_configured_round])
                if next_configured_round < round_count
                else math.inf
            )
            cycle_times = [
                (completion_time, cycle_state)
                for cycle_state in active_cycles
                if cycle_state.current_cycle < cycle_state.total_cycles
                for completion_time in [_cjob_cycle_completion_time(runtime, cycle_state)]
                if completion_time is not None
            ]
            next_cycle_time = min(
                (completion_time for completion_time, _state in cycle_times),
                default=math.inf,
            )
            if math.isinf(next_timed_time) and math.isinf(next_cycle_time):
                unresolved_cycles = [
                    state for state in active_cycles
                    if state.current_cycle < state.total_cycles
                ]
                if unresolved_cycles:
                    unresolved = ", ".join(
                        f"TaskID={state.current_task_id}@{state.load_port}"
                        for state in unresolved_cycles
                    )
                    raise ValueError(f"无法从当前 MoveList 确定 CJobCycle 完工时刻：{unresolved}")
                break

            # 暂不定义与定时重算同刻时的合并规则；同刻时先完成补片重算。
            if next_cycle_time <= next_timed_time + TIME_TOLERANCE:
                due_states = [
                    cycle_state
                    for completion_time, cycle_state in cycle_times
                    if completion_time <= next_cycle_time + TIME_TOLERANCE
                ]
                next_cjobs = [
                    _cycle_cjob(cycle_state.template, cycle_state.current_cycle + 1)
                    for cycle_state in due_states
                ]
                cycle_labels = ", ".join(
                    f"{cycle_state.load_port} {cycle_state.current_cycle + 1}/{cycle_state.total_cycles}"
                    for cycle_state in due_states
                )
                _released_ids, empty_ports = execute_recompute_event(
                    {"currentTime": next_cycle_time, "cjobs": next_cjobs},
                    next_cycle_time,
                    f"CJobCycle 补片（{cycle_labels}）",
                    "cjob-cycle",
                    completed_cycles=due_states,
                )
                missing_ports = {
                    cycle_state.load_port for cycle_state in due_states
                    if cycle_state.load_port not in empty_ports
                }
                if missing_ports:
                    raise ValueError(
                        "CJobCycle 到达补片时刻但 LoadPort 尚未清空："
                        + ",".join(sorted(missing_ports))
                    )
                for cycle_state in due_states:
                    cycle_state.current_cycle += 1
                    cycle_state.current_task_id = _cycle_task_id(
                        str(
                            cycle_state.template.get("taskId")
                            or cycle_state.template.get("TaskID")
                            or ""
                        ).strip(),
                        cycle_state.current_cycle,
                    )
                continue

            round_config = rounds[next_configured_round]
            configured_round = next_configured_round + 1
            requested_time = next_timed_time
            execute_recompute_event(
                round_config,
                requested_time,
                f"第 {configured_round} 轮新增 Job",
                "time",
                configured_round,
            )
            active_cycles.extend(
                _cycle_states_for_round(round_config, configured_round)
            )
            next_configured_round += 1

    combined_output = runtime.combined_output()

    search_telemetry: Optional[Dict[str, Any]] = None
    if builtin_strategy == "schedule-alphago":
        search_telemetry = dict(
            builtin_algorithm_api.get_search_telemetry()
        )
        search_telemetry.pop("committedMoves", None)
        combined_output["SearchTelemetry"] = deepcopy(search_telemetry)

    # 决策轨迹只进入可回放结果文件；运行摘要保留计数，避免 API 响应重复携带大数组。
    decision_trace: List[Dict[str, Any]] = []
    decision_trace_truncated = False
    for summary in summaries:
        strategy_diagnostics = summary.get("strategyDiagnostics")
        if not isinstance(strategy_diagnostics, dict):
            continue
        round_trace = strategy_diagnostics.pop("decisionTrace", [])
        decision_trace_truncated = bool(
            decision_trace_truncated
            or strategy_diagnostics.get("decisionTraceTruncated", False)
        )
        if isinstance(round_trace, list):
            for raw_decision in round_trace:
                if not isinstance(raw_decision, Mapping):
                    continue
                decision_trace.append({
                    **deepcopy(dict(raw_decision)),
                    "roundIndex": int(summary.get("index") or 0),
                    "roundKind": str(summary.get("kind") or ""),
                })
        strategy_diagnostics["decisionTraceCount"] = (
            len(round_trace) if isinstance(round_trace, list) else 0
        )
    if decision_trace:
        dual_actor_trace = strategy == "dual-actor-e2e"
        combined_output["DecisionTrace"] = decision_trace
        combined_output["DecisionTraceMeta"] = {
            "schema": (
                "dual-actor-primitive-decision-trace-v1"
                if dual_actor_trace
                else "e2e-ctq-decision-trace-v1"
            ),
            "model": "双 Actor 原子调度" if dual_actor_trace else "E2E-CTQ",
            "decisionCount": len(decision_trace),
            "truncated": decision_trace_truncated,
        }
    total_ms = (time.perf_counter() - started) * 1000.0
    makespan = _segment_end(combined_output["MoveList"])
    logs.append(
        f"完成：总耗时 {total_ms:.1f} ms，"
        f"makespan={makespan:.2f}s，Move={len(combined_output['MoveList'])}"
    )
    result = {
        "ok": True,
        "strategy": strategy,
        "rounds": summaries,
        "totalElapsedMs": total_ms,
        "makespan": makespan,
        "moveCount": len(combined_output["MoveList"]),
        "validation": "passed",
        "compatibilityMode": compatibility_mode,
        "validationEngine": (
            "platform+hongye" if use_hongye_validation else "platform"
        ),
        "logs": logs,
        "updates": update_snapshots,
        "output": combined_output,
    }
    if search_telemetry is not None:
        result["searchTelemetry"] = search_telemetry
    return result


def _ensure_algorithm_output(
    output: Mapping[str, Any],
    update_params: Mapping[str, Any],
) -> None:
    """把外部 Feedback 中的失败转换为带原始文案的服务端异常。"""
    move_list = list(output.get("MoveList") or [])
    if move_list or not update_params.get("ProcessJobs"):
        return
    feedback = list(output.get("Feedback") or [])
    message = next(
        (
            str(item.get("Message") or item)
            for item in feedback
            if isinstance(item, Mapping)
        ),
        "标准算法未生成 MoveList",
    )
    raise RuntimeError(message)


def _execute_plan(raw_plan: Mapping[str, Any], reproduction: ReproductionLog) -> Dict[str, Any]:
    """执行控制台提交的计划，并同步写入结构化复现事件。"""
    started = time.perf_counter()
    plan = deepcopy(dict(raw_plan))
    plan["device"] = extract_init_data(plan.get("device"))
    plan["device"] = build_task_alg_init(
        plan["device"],
        [row for row in (plan.get("routes") or []) if isinstance(row, Mapping)],
        [row for row in (plan.get("rounds") or []) if isinstance(row, Mapping)],
        [row for row in (plan.get("cleans") or []) if isinstance(row, Mapping)],
    )
    reproduction.add("AlgInit", plan["device"])
    strategy = str(plan.get("strategy") or "heuristic").strip()
    normalized_strategy = strategy.lower()
    other_algorithm_id = (
        strategy.split(":", 1)[1]
        if normalized_strategy.startswith("other_alg:") and ":" in strategy
        else None
    )
    builtin_strategies = {
        str(algorithm["strategy"]): algorithm
        for algorithm in discover_builtin_algorithms()
    }
    if normalized_strategy not in builtin_strategies:
        if other_algorithm_id is None:
            supported = "、".join(sorted(builtin_strategies)) or "无"
            raise ValueError(
                f"本地策略只支持 {supported}，"
                "或 other_alg 下已发现的标准算法"
            )
        discovered_ids = {
            str(item["id"]).casefold()
            for item in discover_other_algorithms()
        }
        if other_algorithm_id.casefold() not in discovered_ids:
            supported = "、".join(sorted(builtin_strategies)) or "无"
            raise ValueError(
                f"本地策略只支持 {supported}，"
                "或 other_alg 下已发现的标准算法"
            )
    elif not builtin_strategies[normalized_strategy]["available"]:
        reason = str(
            builtin_strategies[normalized_strategy].get("unavailableReason")
            or "当前不可用"
        )
        raise RuntimeError(f"{normalized_strategy} 策略当前不可用：{reason}")
    strategy = normalized_strategy if normalized_strategy in builtin_strategies else strategy
    rounds = [row for row in (plan.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = int(_finite_number(plan.get("roundCount"), len(rounds)))
    if round_count < 1 or len(rounds) != round_count:
        raise ValueError("轮次数量与 roundCount 不一致")
    times = [_finite_number(row.get("currentTime"), 0.0) for row in rounds]
    if abs(times[0]) > TIME_TOLERANCE:
        raise ValueError("首次排程时间必须为 0")
    if any(right <= left + TIME_TOLERANCE for left, right in zip(times, times[1:])):
        raise ValueError("各轮重算时间必须严格递增")
    for round_index, round_config in enumerate(rounds, start=1):
        for cjob in _round_cjob_rows(round_config):
            cycle_count = _cjob_cycle_count(cjob)
            if cycle_count > 1 and not _cjob_load_port_name(cjob):
                task_id = str(cjob.get("taskId") or cjob.get("TaskID") or "?")
                raise ValueError(
                    f"第 {round_index} 轮 CJob TaskID={task_id} 启用 CJobCycle 时必须选择 LoadPort"
                )

    options = plan.get("options") if isinstance(plan.get("options"), Mapping) else {}
    default_loadlock_manager_mode = (
        "joint"
        if strategy in {"e2e-ctq", "dual-actor-e2e"}
        else "petri-look"
    )
    loadlock_manager_mode = str(
        options.get("loadLockManager") or default_loadlock_manager_mode
    ).strip().lower()
    supported_loadlock_managers = {
        "joint",
        "petri-look",
        "petri-eta",
        "collective-look",
        "round-robin",
        "dedicated-direction",
        "exchange-look",
    }
    if loadlock_manager_mode not in supported_loadlock_managers:
        raise ValueError(
            "LoadLock manager 只支持 joint、petri-eta、collective-look、"
            "round-robin、dedicated-direction 或 exchange-look"
        )
    build_state = BuildState()

    first_update = build_round_update(plan, rounds[0], 0.0, build_state)
    reproduction.add("AlgSchedule", _schedule_log_info(plan["device"], first_update))
    if other_algorithm_id is not None:
        return _execute_standard_algorithm(
            plan,
            first_update,
            rounds,
            times,
            build_state,
            reproduction,
            started,
            other_algorithm_id,
        )
    return _execute_standard_algorithm(
        plan,
        first_update,
        rounds,
        times,
        build_state,
        reproduction,
        started,
        builtin_strategy=strategy,
    )

def validate_reproduction_log(
    entries: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """对完整复现日志执行 HongYe 校验；失败时抛出 LoggedPlanError。

    ``execute_plan`` 与批量两阶段校验共用同一校验路径，保证失败语义一致：
    成功返回校验结果字典，失败抛出携带甘特图失败输出与校验问题的
    ``LoggedPlanError``，供批量层保存复现日志并生成诊断入口。
    """
    hongye_validation = HongYeLogValidator().validate(entries)
    if hongye_validation.get("success"):
        return hongye_validation
    # 原始 MoveStateSim 直接消费完整日志。各代 AlgOutput 必须保持算法当时
    # 返回的计划，不能替换成甘特图累计历史，否则最新 AlgSchedule 的现场
    # 会被错误地套到早期 Move 上，制造槽位物料不匹配等假错误。
    raw_issues = (
        hongye_validation.get("error_issues")
        or hongye_validation.get("issues")
        or []
    )
    issues = _hongye_validation_issue_messages(raw_issues)
    output_index, output_entry = next(
        (
            (index, entry)
            for index, entry in reversed(list(enumerate(entries)))
            if str(entry.get("Describe") or "").casefold() == "algoutput"
        ),
        (-1, {}),
    )
    terminal_output = (
        output_entry.get("Info")
        if isinstance(output_entry.get("Info"), Mapping)
        else {}
    )
    prefix_moves, recompute_points = (
        _reproduction_history_before_current_output(entries[:output_index])
    )
    message = _state_advance_error_message(
        issues[0] if issues else "HongYe 存在未分类错误"
    )
    raise LoggedPlanError(
        message,
        entries,
        failure_output=_build_validation_gantt_output(
            terminal_output,
            issues,
            prefix_moves=prefix_moves,
            recompute_points=recompute_points,
        ),
        validation_issues=issues,
    )


def execute_plan(
    raw_plan: Mapping[str, Any],
    *,
    hongye_validation_limiter: Any = None,
) -> Dict[str, Any]:
    """执行计划；成功和失败都生成可重放的 input_data 格式日志。

    ``hongye_validation_limiter`` 是批量运行可选的跨线程或跨进程信号量，
    只包围内存占用较高的 MoveStateSim 校验段，不限制算法本身的并行度。
    """
    _set_run_monitor_scope(str(raw_plan.get("strategy") or "heuristic"))
    _raise_if_single_run_cancelled()
    use_hongye_validation = bool(raw_plan.get("hongYeCheck", True))
    reproduction = ReproductionLog()
    reproduction.add("Input", [deepcopy(dict(raw_plan))])
    cpu_started = time.thread_time() if hasattr(time, "thread_time") else time.process_time()
    hongye_validation: Optional[Dict[str, Any]] = None
    try:
        result = _execute_plan(raw_plan, reproduction)
        if use_hongye_validation:
            if hongye_validation_limiter is None:
                hongye_validation = validate_reproduction_log(
                    reproduction.entries,
                )
            else:
                hongye_validation_limiter.acquire()
                try:
                    hongye_validation = validate_reproduction_log(
                        reproduction.entries,
                    )
                finally:
                    hongye_validation_limiter.release()
    except LoggedPlanError:
        # 多轮重算的算法调用失败可能已附带按 RemoveList 裁剪的旧计划；
        # 不能再包装为普通异常，否则 /api/run 将丢失甘特图所需的结果。
        raise
    except Exception as error:  # noqa: BLE001
        # 用户主动取消属于预期终止而非运行失败，原样向上传播，
        # 由 /api/run 返回 cancelled 标记。
        cancelled_error_type = globals().get("SearchCancelledError")
        if (
            isinstance(error, UserRunCancelledError)
            or cancelled_error_type is not None
            and isinstance(error, cancelled_error_type)
        ):
            raise
        feedback = [{
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error),
        }]
        if isinstance(error, MoveListValidationError):
            reproduction.add(
                "AlgOutput",
                _alg_output_info(error.algorithm_output, feedback=feedback),
                error.sim_time,
            )
            raise LoggedPlanError(
                str(error),
                reproduction.entries,
                failure_output=error.gantt_output,
                validation_issues=error.validation_issues,
            ) from error
        prior_plan_output = _build_prior_plan_failure_output(
            reproduction.entries,
            error,
        )
        reproduction.add(
            "AlgOutput",
            _alg_output_info(feedback=feedback),
        )
        raise LoggedPlanError(
            str(error),
            reproduction.entries,
            failure_output=prior_plan_output,
        ) from error
    cpu_finished = time.thread_time() if hasattr(time, "thread_time") else time.process_time()
    result["cpuTimeMs"] = max(0.0, (cpu_finished - cpu_started) * 1000.0)
    if hongye_validation is not None:
        result["validationDetails"] = deepcopy(hongye_validation)
    result["reproductionLog"] = deepcopy(reproduction.entries)
    return result



__all__ = tuple(name for name in globals() if not name.startswith('__'))
