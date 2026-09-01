"""单次运行状态、输出诊断与实时重算时间线投影。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.time_utils import _workspace_timestamp

@dataclass
class RecoveryProjection:
    """一次重算请求需要保留的旧动作投影结果。"""

    recovery_end: float
    material_ready_times: Dict[int, float] = field(default_factory=dict)


@dataclass
class ReproductionLog:
    """按发生顺序收集一次运行的完整标准日志。"""

    entries: List[Dict[str, Any]] = field(default_factory=list)

    def add(
        self,
        describe: str,
        info: Any,
        sim_time: float = 0.0,
    ) -> None:
        """追加一条可直接交给 MoveStateSim 的标准日志事件。"""
        entry = {
            "Time": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            "Describe": describe,
            "SimTime": float(sim_time),
            "Info": deepcopy(info),
        }
        self.entries.append(entry)


def _hongye_validation_issue_messages(
    issues: Sequence[Mapping[str, Any]],
) -> List[str]:
    """把 HongYe 结构化 issue 转成现有甘特图可定位的稳定文案。"""
    messages: List[str] = []
    for issue in issues:
        if not isinstance(issue, Mapping):
            messages.append(str(issue))
            continue
        move_id = issue.get("move_id")
        phase = str(issue.get("phase") or "")
        code = str(issue.get("code") or "HONGYE")
        detail = str(issue.get("message") or "HongYe 校验失败")
        messages.append(
            f"[{code}] MoveID={move_id} {phase}: {detail}".strip()
        )
    return messages


def _remove_released_materials_from_update(
    update_params: Dict[str, Any],
    released_material_ids: set[Any],
) -> None:
    """从标准算法全量 update 中移除已卸载晶圆及已经结束的空 PJob/CJob。"""
    if not released_material_ids:
        return
    update_params["Materials"] = [
        material
        for material in update_params.get("Materials") or []
        if not isinstance(material, Mapping)
        or material.get("ID") not in released_material_ids
    ]
    process_jobs: List[Dict[str, Any]] = []
    material_count_by_job: Dict[str, int] = {}
    for raw_job in update_params.get("ProcessJobs") or []:
        if not isinstance(raw_job, Mapping):
            continue
        job = deepcopy(dict(raw_job))
        job["MatList"] = [
            material_id
            for material_id in job.get("MatList") or []
            if material_id not in released_material_ids
        ]
        if not job["MatList"]:
            continue
        job_name = str(job.get("JobName") or "")
        material_count_by_job[job_name] = len(job["MatList"])
        process_jobs.append(job)
    update_params["ProcessJobs"] = process_jobs
    control_jobs: List[Dict[str, Any]] = []
    for raw_job in update_params.get("ControlJobs") or []:
        if not isinstance(raw_job, Mapping):
            continue
        job = deepcopy(dict(raw_job))
        pjob_names = [
            str(name)
            for name in job.get("PJobNameList") or []
            if str(name) in material_count_by_job
        ]
        if not pjob_names:
            continue
        job["PJobNameList"] = pjob_names
        job["MaterialCount"] = sum(material_count_by_job[name] for name in pjob_names)
        control_jobs.append(job)
    update_params["ControlJobs"] = control_jobs


def _state_advance_error_message(issue: Any) -> str:
    """把平台或补充校验的问题统一为状态推进失败的用户错误格式。"""
    text = str(issue or "存在未分类错误").strip()
    if text.startswith("[") and "]" in text:
        code, detail = text[1:].split("]", 1)
        return f"状态推进失败|{code}|{detail.lstrip('： ').strip()}"
    return f"状态推进失败|MVL-STATE-UNKNOWN|{text}"


class MoveListValidationError(RuntimeError):
    """携带原始算法输出和诊断甘特图数据的 MoveList 校验异常。"""

    def __init__(
        self,
        message: str,
        algorithm_output: Mapping[str, Any],
        validation_issues: Sequence[Any],
        gantt_output: Mapping[str, Any],
        sim_time: float,
    ) -> None:
        """保存失败现场，使接口仍能导出并展示问题 Move。"""
        super().__init__(message)
        self.algorithm_output = deepcopy(dict(algorithm_output))
        self.validation_issues = [str(issue) for issue in validation_issues]
        self.gantt_output = deepcopy(dict(gantt_output))
        self.sim_time = float(sim_time)


class UserRunCancelledError(RuntimeError):
    """用户通过单测状态接口请求停止当前运行。"""


def _single_run_snapshot(run_id: str) -> Optional[Dict[str, Any]]:
    """返回单测后台状态；运行时长由服务端单调时钟实时计算。"""
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None:
            return None
        snapshot = deepcopy(run)
        started_perf = float(snapshot.pop("_startedPerf", time.perf_counter()))
        if snapshot.get("status") in {"queued", "running", "cancelling"}:
            snapshot["elapsedMs"] = max(0.0, (time.perf_counter() - started_perf) * 1000.0)
        return snapshot


def _start_single_run(run_id: str, strategy: str, test_name: str) -> threading.Event:
    """登记由同步 ``/api/run`` 请求承载、但可独立轮询的单测状态。"""
    normalized_id = str(run_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,80}", normalized_id):
        raise ValueError("clientRunId 格式不正确")
    cancel_event = threading.Event()
    now = _workspace_timestamp()
    initial = {
        "runId": normalized_id,
        "ok": True,
        "status": "running",
        "strategy": str(strategy or "heuristic"),
        "testName": str(test_name or "当前测试"),
        "createdAt": now,
        "startedAt": now,
        "elapsedMs": 0.0,
        "events": [],
        "_startedPerf": time.perf_counter(),
    }
    with _SINGLE_RUNS_LOCK:
        _SINGLE_RUNS[normalized_id] = initial
        _SINGLE_RUN_CANCEL_EVENTS[normalized_id] = cancel_event
        _SINGLE_RUNS.move_to_end(normalized_id)
        while len(_SINGLE_RUNS) > MAX_SAVED_SINGLE_RUNS:
            expired_id, _ = _SINGLE_RUNS.popitem(last=False)
            _SINGLE_RUN_CANCEL_EVENTS.pop(expired_id, None)
    log_run_event(normalized_id, "selected", "开始测试", "running", f"策略={strategy or 'heuristic'}，测试={test_name or '当前测试'}")
    return cancel_event


def _finish_single_run(run_id: str, status: str, error: str = "") -> None:
    """完成、失败或取消单测，并保留最终耗时与精简事件历史。"""
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None or run.get("status") == "cancelled":
            return
        run["status"] = status
        run["ok"] = status == "completed"
        run["elapsedMs"] = max(
            0.0,
            (time.perf_counter() - float(run.get("_startedPerf", time.perf_counter()))) * 1000.0,
        )
        run["finishedAt"] = _workspace_timestamp()
        if error:
            run["error"] = str(error)
    log_run_event(run_id, "selected", "测试完成", status, error)


def _cancel_single_run(run_id: str) -> Optional[Dict[str, Any]]:
    """请求停止单测；算法调用返回后将不再接纳输出或执行后续轮次。"""
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None:
            return None
        if run.get("status") in {"completed", "failed", "cancelled"}:
            return _single_run_snapshot(run_id)
        cancel_event = _SINGLE_RUN_CANCEL_EVENTS.get(run_id)
        if cancel_event is not None:
            cancel_event.set()
        run["ok"] = False
        run["status"] = "cancelled"
        run["elapsedMs"] = max(
            0.0,
            (time.perf_counter() - float(run.get("_startedPerf", time.perf_counter()))) * 1000.0,
        )
        run["finishedAt"] = _workspace_timestamp()
        run["error"] = "用户停止测试"
        for event in run.get("events") or []:
            if event.get("status") == "running":
                event["status"] = "cancelled"
                event["detail"] = "用户停止测试"
                event["updatedAt"] = run["finishedAt"]
        return _single_run_snapshot(run_id)


@contextmanager
def _monitor_single_run(run_id: str, strategy: str) -> Iterator[None]:
    """把当前 HTTP 请求的真实算法阶段关联到可轮询状态。"""
    previous = getattr(_RUN_MONITOR, "value", None)
    _RUN_MONITOR.value = {
        "runId": run_id,
        "strategy": str(strategy or "heuristic"),
        "scope": "selected",
    }
    try:
        yield
    finally:
        _RUN_MONITOR.value = previous


def _set_run_monitor_scope(strategy: str) -> None:
    """区分可选的 Baseline 调用和用户选择的策略调用。"""
    monitor = getattr(_RUN_MONITOR, "value", None)
    if monitor is not None:
        monitor["scope"] = (
            "selected"
            if str(strategy or "heuristic") == monitor.get("strategy")
            else "baseline"
        )


def _report_run_event(key: str, label: str, status: str, detail: str = "") -> None:
    """原子更新一个真实 init/update/output/validation 阶段。"""
    monitor = getattr(_RUN_MONITOR, "value", None)
    if monitor is None:
        return
    run_id = str(monitor.get("runId") or "")
    scope = str(monitor.get("scope") or "selected")
    event_key = f"{scope}:{key}"
    display_label = f"Baseline · {label}" if scope == "baseline" else label
    with _SINGLE_RUNS_LOCK:
        run = _SINGLE_RUNS.get(run_id)
        if run is None or run.get("status") == "cancelled":
            return
        events = run.setdefault("events", [])
        event = next((item for item in events if item.get("key") == event_key), None)
        values = {
            "key": event_key,
            "label": display_label,
            "status": status,
            "detail": str(detail or ""),
            "updatedAt": _workspace_timestamp(),
        }
        if event is None:
            events.append(values)
        else:
            event.update(values)
        if len(events) > 16:
            del events[:-16]
    log_run_event(run_id, scope, display_label, status, detail)


def _raise_if_single_run_cancelled() -> None:
    """在算法边界检查停止标记，避免接纳迟到输出。"""
    monitor = getattr(_RUN_MONITOR, "value", None)
    if monitor is None:
        return
    cancel_event = _SINGLE_RUN_CANCEL_EVENTS.get(str(monitor.get("runId") or ""))
    if cancel_event is not None and cancel_event.is_set():
        raise UserRunCancelledError("运行已取消")


class LoggedPlanError(RuntimeError):
    """携带可下载复现日志的排程异常。"""

    def __init__(
        self,
        message: str,
        reproduction_log: Sequence[Mapping[str, Any]],
        *,
        failure_output: Optional[Mapping[str, Any]] = None,
        validation_issues: Optional[Sequence[str]] = None,
    ) -> None:
        """保存错误日志，并可选携带供甘特图查看的失败 MoveList。"""
        super().__init__(message)
        self.reproduction_log = deepcopy(list(reproduction_log))
        self.failure_output = (
            deepcopy(dict(failure_output))
            if failure_output is not None
            else None
        )
        self.validation_issues = list(validation_issues or ())


def _committed_move_index(
    moves: Sequence[Mapping[str, Any]],
) -> Dict[int, Mapping[str, Any]]:
    """按 MoveID 建立已提交 Move 索引，供重算增量校验引用为合法前驱。"""
    indexed: Dict[int, Mapping[str, Any]] = {}
    for move in moves:
        raw_move_id = move.get("MoveID")
        if isinstance(raw_move_id, int) and not isinstance(raw_move_id, bool):
            indexed[int(raw_move_id)] = move
    return indexed


def _alg_output_info(
    output: Optional[Mapping[str, Any]] = None,
    feedback: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """生成与 input_data 中 AlgOutput 相同的顶层结构。"""
    source = output or {}
    normalized = {
        "MoveList": deepcopy(list(source.get("MoveList") or [])),
        "Feedback": deepcopy(list(feedback if feedback is not None else source.get("Feedback") or [])),
        "JobList": deepcopy(list(source.get("JobList") or [])),
        "DummyReturnInfo": deepcopy(dict(source.get("DummyReturnInfo") or {})),
        "MatIntoPM": deepcopy(dict(source.get("MatIntoPM") or {})),
    }
    diagnostic = source.get("DeadlockDiagnostic")
    if isinstance(diagnostic, Mapping) and diagnostic:
        normalized["DeadlockDiagnostic"] = deepcopy(dict(diagnostic))
    return normalized


def _deadlock_feedback(
    output: Mapping[str, Any],
) -> Optional[Dict[str, Any]]:
    """把算法失败 Feedback 规范化为平台内部死锁记录。

    内置算法和 MLP 都按公司接口返回 ``调度失败: <原因>`` 字符串。这里仍
    兼容旧版结构化记录，避免历史结果和已部署外部算法无法回放。
    """
    for raw_feedback in output.get("Feedback") or []:
        if isinstance(raw_feedback, str):
            message = raw_feedback.strip()
            if not message.startswith(ALGORITHM_FAILURE_FEEDBACK_PREFIX):
                continue
            reason = message[len(ALGORITHM_FAILURE_FEEDBACK_PREFIX):].strip()
            return {
                "Level": "Error",
                "Type": "MachineDeadlockError",
                "Code": "DEADLOCK.NO_EXECUTABLE_ACTION",
                "Category": "no-executable-action",
                "Message": reason or "算法规划进入死锁",
            }
        if not isinstance(raw_feedback, Mapping):
            continue
        code = str(raw_feedback.get("Code") or "").strip().upper()
        category = str(raw_feedback.get("Category") or "").strip().casefold()
        feedback_type = str(raw_feedback.get("Type") or "").strip().casefold()
        if (
            code.startswith("DEADLOCK.")
            or category.startswith("deadlock")
            or "deadlock" in feedback_type
        ):
            return deepcopy(dict(raw_feedback))
    return None


def _classify_deadlock_diagnostic(
    diagnostic: Mapping[str, Any],
) -> Optional[Dict[str, str]]:
    """按 Machine 权威现场识别可证明的死锁类型。

    分类只使用物料当前位置、下一站、站点占用、Robot 手槽和 Dummy 标记；
    证据不足时返回 ``None``，由调用方保留通用无动作类型。
    """
    pending = [
        dict(row)
        for row in diagnostic.get("PendingMaterials") or []
        if isinstance(row, Mapping)
    ]
    held_robots = [
        dict(row)
        for row in diagnostic.get("HeldRobots") or []
        if isinstance(row, Mapping)
    ]
    occupied_stations = {
        str(row.get("Station") or ""): dict(row)
        for row in diagnostic.get("OccupiedStations") or []
        if isinstance(row, Mapping) and row.get("Station")
    }
    load_lock_names = {
        str(row.get("Station") or "")
        for row in diagnostic.get("LoadLocks") or []
        if isinstance(row, Mapping) and row.get("Station")
    }
    pending_by_id = {
        str(row.get("MaterialID")): row
        for row in pending
        if row.get("MaterialID") is not None
    }

    def string_set(value: Any) -> set[str]:
        """把协议列表字段规范化为非空字符串集合。"""
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            return set()
        return {str(item) for item in value if str(item)}

    # Dummy 位于自己仍需服务的同一 PM 时，没有搬运能够推进清洗 Route。
    for row in pending:
        location = str(row.get("Location") or "")
        if row.get("IsDummy") and location in string_set(row.get("NextStations")):
            return {
                "Code": "DEADLOCK.CLEANING_SELF_BLOCKED",
                "Category": "cleaning-self-blocked",
                "Message": f"Dummy 清洗片 {row.get('MaterialID')} 位于 {location}，下一步仍要求同一腔室，清洗 Route 无法推进。",
            }

    for held_robot in held_robots:
        robot_name = str(held_robot.get("Robot") or "Robot")
        hands = held_robot.get("Hands")
        held_ids = {
            str(value)
            for value in (hands.values() if isinstance(hands, Mapping) else [])
        }
        capacity = max(1, int(held_robot.get("Capacity") or len(held_ids) or 1))
        for material_id in held_ids:
            material = pending_by_id.get(material_id)
            if material is None:
                continue
            targets = string_set(material.get("NextStations"))
            if not targets:
                continue
            if all(bool(occupied_stations.get(target, {}).get("Full")) for target in targets):
                if capacity <= 1:
                    code = "DEADLOCK.SINGLE_ARM_TARGET_FULL"
                    category = "single-arm-target-full"
                elif len(held_ids) >= capacity:
                    code = "DEADLOCK.DUAL_ARM_TARGETS_FULL"
                    category = "dual-arm-targets-full"
                else:
                    code = "DEADLOCK.DUAL_ARM_SINGLE_HELD_TARGET_FULL"
                    category = "dual-arm-single-held-target-full"
                return {
                    "Code": code,
                    "Category": category,
                    "Message": f"{robot_name} 持有晶圆 {material_id}，其目标 {', '.join(sorted(targets))} 均已满。",
                }
            cleaning_conflicts = [
                row for row in pending
                if row.get("IsDummy")
                and str(row.get("MaterialID")) not in held_ids
                and targets & string_set(row.get("RemainingProcessStations"))
            ]
            if cleaning_conflicts:
                dummy_ids = ", ".join(str(row.get("MaterialID")) for row in cleaning_conflicts)
                return {
                    "Code": "DEADLOCK.ROBOT_HELD_CLEANING_CONFLICT",
                    "Category": "robot-held-cleaning-conflict",
                    "Message": f"{robot_name} 持有晶圆 {material_id}，但目标 {', '.join(sorted(targets))} 必须先由 Dummy {dummy_ids} 完成清洗；Robot 无法同时推进清洗片。",
                }
            if targets & load_lock_names:
                return {
                    "Code": "DEADLOCK.ROBOT_HELD_LOADLOCK_BLOCKED",
                    "Category": "robot-held-loadlock-blocked",
                    "Message": f"{robot_name} 持有晶圆 {material_id}，目标 LoadLock {', '.join(sorted(targets & load_lock_names))} 无法接片或切换方向。",
                }
            return {
                "Code": "DEADLOCK.ROBOT_HELD_RESOURCE_WAIT",
                "Category": "robot-held-resource-wait",
                "Message": f"{robot_name} 持有晶圆 {material_id}，目标 {', '.join(sorted(targets))} 当前无法接片，Robot 也无法推进其他搬运。",
            }

    # 没有 Robot 持片时，从满载目标构造物料等待图；含 LoadLock 的环单独命名。
    dependency_edges: Dict[str, set[str]] = {}
    for row in pending:
        source_id = str(row.get("MaterialID"))
        for target in string_set(row.get("NextStations")):
            station = occupied_stations.get(target)
            if not station or not station.get("Full"):
                continue
            occupied = station.get("Occupied")
            if isinstance(occupied, Mapping):
                dependency_edges.setdefault(source_id, set()).update(
                    str(value) for value in occupied.values()
                )

    def find_cycle(node: str, path: list[str], completed: set[str]) -> set[str]:
        """深度优先返回等待图中的一组环节点；无环时返回空集。"""
        if node in path:
            return set(path[path.index(node):])
        if node in completed:
            return set()
        path.append(node)
        for target in dependency_edges.get(node, set()):
            cycle = find_cycle(target, path, completed)
            if cycle:
                return cycle
        path.pop()
        completed.add(node)
        return set()

    completed: set[str] = set()
    cycle_nodes = next((
        cycle
        for node in dependency_edges
        if (cycle := find_cycle(node, [], completed))
    ), set())
    if cycle_nodes:
        if any(
            str(pending_by_id.get(node, {}).get("Location") or "") in load_lock_names
            for node in cycle_nodes
        ):
            return {
                "Code": "DEADLOCK.LOADLOCK_DIRECTION_CYCLE",
                "Category": "loadlock-direction-cycle",
                "Message": "LoadLock 内外物料同时等待反向服务，当前压力方向与回程容量形成循环依赖。",
            }
        return {
            "Code": "DEADLOCK.RESOURCE_WAIT_CYCLE",
            "Category": "resource-wait-cycle",
            "Message": "多个晶圆的下一目标被彼此占用，形成满腔资源等待环。",
        }

    # LoadLock 的算法安全容量可能小于物理槽位，图中没有“物理满载”边时仍可确认方向环。
    if load_lock_names:
        leaves_load_lock = any(
            str(row.get("Location") or "") in load_lock_names
            and bool(string_set(row.get("NextStations")) - load_lock_names)
            for row in pending
        )
        enters_load_lock = any(
            str(row.get("Location") or "") not in load_lock_names
            and bool(string_set(row.get("NextStations")) & load_lock_names)
            for row in pending
        )
        if leaves_load_lock and enters_load_lock:
            return {
                "Code": "DEADLOCK.LOADLOCK_DIRECTION_CYCLE",
                "Category": "loadlock-direction-cycle",
                "Message": "LoadLock 内外物料同时等待反向服务，当前压力方向与回程容量形成循环依赖。",
            }
    return None


def _raise_deadlock_feedback(
    output: Mapping[str, Any],
    reproduction: ReproductionLog,
    *,
    sim_time: float = 0.0,
    context: str,
) -> None:
    """将算法死锁输出登记为可回放失败，而不是继续做完整计划校验。"""
    feedback = _deadlock_feedback(output)
    if feedback is None:
        return
    failure_output = _alg_output_info(output)
    diagnostic = deepcopy(dict(output.get("DeadlockDiagnostic") or {}))
    classification = _classify_deadlock_diagnostic(diagnostic)
    failure_output["FailureContext"] = {
        "Stage": "algorithm-deadlock",
        "Context": context,
        "Code": str((classification or feedback).get("Code") or "DEADLOCK.NO_EXECUTABLE_ACTION"),
        "Category": str((classification or feedback).get("Category") or "unknown"),
        "Message": str((classification or feedback).get("Message") or "算法规划进入死锁"),
        "Diagnostic": diagnostic,
    }
    reproduction.add(
        "AlgOutput",
        failure_output,
        sim_time,
    )
    raise LoggedPlanError(
        str(feedback.get("Message") or "算法规划进入死锁"),
        reproduction.entries,
        failure_output=failure_output,
    )


def _validation_issue_records(
    validation_issues: Sequence[Any],
) -> List[Dict[str, Any]]:
    """把带稳定错误码的校验文案转换成甘特图可定位记录。"""
    records: List[Dict[str, Any]] = []
    error_code_pattern = re.compile(
        r"^\[([A-Z0-9]+(?:(?:-|\.)[A-Z0-9_]+)+)\]"
    )
    move_id_pattern = re.compile(
        r"(?:\bMoveID\b|\bid\b)\s*[=:]\s*(-?\d+)",
        re.IGNORECASE,
    )
    for issue in validation_issues:
        message = str(issue)
        match = move_id_pattern.search(message)
        record: Dict[str, Any] = {"Message": message}
        error_code_match = error_code_pattern.match(message)
        if error_code_match is not None:
            record["Code"] = error_code_match.group(1)
        if match is not None:
            record["MoveID"] = int(match.group(1))
        records.append(record)
    return records


def _build_validation_gantt_output(
    algorithm_output: Mapping[str, Any],
    validation_issues: Sequence[Any],
    *,
    prefix_moves: Optional[Sequence[Mapping[str, Any]]] = None,
    recompute_points: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """生成包含错误 Move 标记的只读诊断甘特图数据。"""
    issue_records = _validation_issue_records(validation_issues)
    issues_by_move_id: Dict[int, List[str]] = {}
    for issue in issue_records:
        move_id = issue.get("MoveID")
        if isinstance(move_id, int):
            issues_by_move_id.setdefault(move_id, []).append(
                str(issue["Message"])
            )

    invalid_moves = deepcopy(list(algorithm_output.get("MoveList") or []))
    for move in invalid_moves:
        if not isinstance(move, dict):
            continue
        move_id = move.get("MoveID")
        if not isinstance(move_id, int) or move_id not in issues_by_move_id:
            continue
        move["ValidationFailed"] = True
        move["ValidationIssues"] = deepcopy(issues_by_move_id[move_id])

    combined_moves = [
        deepcopy(dict(move))
        for move in (prefix_moves or ())
        if isinstance(move, Mapping)
    ]
    combined_moves.extend(invalid_moves)
    combined_moves.sort(key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move.get("MoveID") or 0),
    ))
    output = _alg_output_info(algorithm_output)
    output["MoveList"] = combined_moves
    output["RecomputePoints"] = deepcopy(list(recompute_points or ()))
    output["Validation"] = {
        "Status": "failed",
        "Issues": issue_records,
        "InvalidMoveIDs": sorted(issues_by_move_id),
    }
    return output


def _schedule_log_info(device: Mapping[str, Any], update: Mapping[str, Any]) -> Dict[str, Any]:
    """把设备拓扑与一轮更新合成可单独回放的 AlgSchedule 输入。"""
    info = deepcopy(dict(update))
    info.setdefault("Robots", deepcopy(dict(device.get("Robots") or {})))
    info.setdefault("Stations", deepcopy(dict(device.get("Stations") or {})))
    return info


def _build_platform_recompute_update(
    runtime: PlatformMoveListRuntime,
    new_round_update: Mapping[str, Any],
    requested_time: float,
    move_states: Sequence[Mapping[str, Any]],
    projected_state: Optional[MachineState] = None,
    previous_output: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """用平台物理快照为下一轮算法调用构造标准 update。"""
    update = merge_algorithm_update(
        runtime.current_update,
        new_round_update,
    )
    apply_machine_state_to_update(
        update,
        projected_state if projected_state is not None else runtime.state,
        requested_time,
    )
    update["MoveStates"] = [
        deepcopy(dict(notification))
        for notification in move_states
    ]
    _apply_running_resource_times(
        update,
        runtime.current_plan,
        requested_time,
        move_states,
    )
    update["RemoveList"] = [
        int(move["MoveID"])
        for move in runtime.current_plan
        if isinstance(move.get("MoveID"), int)
        and float(move.get("StartTime") or 0.0)
        >= float(requested_time) - TIME_TOLERANCE
    ]
    if previous_output is not None:
        # 与完整平台运行时保持同一协议边界：只在所有现场字段投影完成后消费
        # 算法返回的 Dummy 信息，确保发出的 AlgSchedule 保留恢复结果。
        restore_dummy_routes_from_algorithm_output(update, previous_output)
    return update


def _apply_running_resource_times(
    update: Dict[str, Any],
    moves: Sequence[Mapping[str, Any]],
    current_time: float,
    move_states: Sequence[Mapping[str, Any]],
) -> None:
    """把仍在运行的 Move 剩余时长写入下一轮调用的资源快照。

    标准接口会用 ``MoveStates`` 恢复动作语义，同时要求关联 Robot/Station
    的 ``TimeToAvailable`` 作为运行中动作结束时间证据。这里只写协议资源
    占用；物料和槽位状态由平台状态记录器统一提供。
    """
    started_ids = {
        int(item["MoveID"])
        for item in move_states
        if (
            isinstance(item.get("MoveID"), int)
            and item.get("MoveState") == MoveStateReplay.RUNNING
        )
    }
    finished_ids = {
        int(item["MoveID"])
        for item in move_states
        if (
            isinstance(item.get("MoveID"), int)
            and item.get("MoveState") == MoveStateReplay.DONE
        )
    }
    running_ids = started_ids - finished_ids
    if not running_ids:
        return

    robots = update.setdefault("Robots", {})
    stations = update.setdefault("Stations", {})
    for move in moves:
        move_id = move.get("MoveID")
        if move_id not in running_ids:
            continue
        remaining = max(
            0.0,
            float(move.get("EndTime") or current_time) - float(current_time),
        )
        module_name = str(move.get("ModuleName") or "")
        if module_name in robots and isinstance(robots[module_name], dict):
            robots[module_name]["TimeToAvailable"] = max(
                float(robots[module_name].get("TimeToAvailable") or 0.0),
                remaining,
            )

        station_slots: Dict[str, set[int]] = {}
        slot_groups = (
            ("SrcStationList", "SrcSlotList"),
            ("DestStationList", "DestSlotList"),
        )
        for station_key, slot_key in slot_groups:
            station_names = list(move.get(station_key) or [])
            slot_ids = list(move.get(slot_key) or [])
            for index, station_name in enumerate(station_names):
                slot_id = slot_ids[index] if index < len(slot_ids) else None
                if isinstance(slot_id, int):
                    station_slots.setdefault(str(station_name), set()).add(slot_id)
                else:
                    station_slots.setdefault(str(station_name), set())
        if module_name in stations:
            module_slots = {
                int(slot_id)
                for slot_id in (move.get("SlotList") or [])
                if isinstance(slot_id, int)
            }
            station_slots.setdefault(module_name, set()).update(module_slots)

        for station_name, slot_ids in station_slots.items():
            station = stations.get(station_name)
            if not isinstance(station, dict):
                continue
            slot_times = station.setdefault("TimeToAvailableOfSlot", {})
            if not slot_ids:
                slot_ids = {
                    int(slot_id)
                    for slot_id in slot_times
                    if str(slot_id).isdigit()
                }
            for slot_id in slot_ids:
                key = str(slot_id)
                slot_times[key] = max(
                    float(slot_times.get(key) or 0.0),
                    remaining,
                )


def _planned_event_groups(moves: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """把旧计划转换为按容差归并的事件组，完成事件在同刻新开始事件之前落地。"""
    groups: Dict[int, Dict[str, Any]] = {}
    for raw_move in moves:
        move = dict(raw_move)
        start = float(move.get("StartTime") or 0.0)
        end = float(move.get("EndTime") or start)
        move_id = int(move["MoveID"])
        start_bucket = int(round(start / TIME_TOLERANCE))
        end_bucket = int(round(end / TIME_TOLERANCE))
        start_group = groups.setdefault(start_bucket, {
            "time": start, "starts": [], "priorFinishes": [], "sameFinishes": [],
        })
        start_group["time"] = max(float(start_group["time"]), start)
        start_group["starts"].append((start, {
            "MoveID": move_id,
            "MoveState": MoveStateReplay.RUNNING,
            "StartTime": start,
            "EndTime": -1,
        }))
        end_group = groups.setdefault(end_bucket, {
            "time": end, "starts": [], "priorFinishes": [], "sameFinishes": [],
        })
        end_group["time"] = max(float(end_group["time"]), end)
        finish_key = "sameFinishes" if start_bucket == end_bucket else "priorFinishes"
        end_group[finish_key].append((end, {
            "MoveID": move_id,
            "MoveState": MoveStateReplay.DONE,
            "StartTime": start,
            "EndTime": end,
        }))
    ordered: List[Dict[str, Any]] = []
    for bucket in sorted(groups):
        group = groups[bucket]
        for key in ("starts", "priorFinishes", "sameFinishes"):
            group[key].sort(key=lambda item: (item[0], item[1]["MoveID"]))
        ordered.append(group)
    return ordered


def _planned_start_events(
    group: Mapping[str, Any],
) -> Iterator[Tuple[str, float, Dict[str, Any]]]:
    """按 MoveID 依次产生开始事件，并让零时长动作在下一动作开始前完成。"""
    same_finishes = {
        int(notification["MoveID"]): (event_time, notification)
        for event_time, notification in group["sameFinishes"]
    }
    for event_time, notification in group["starts"]:
        move_id = int(notification["MoveID"])
        yield "start", event_time, notification
        same_finish = same_finishes.pop(move_id, None)
        if same_finish is not None:
            yield "finish", same_finish[0], same_finish[1]
    for event_time, notification in group["sameFinishes"]:
        if int(notification["MoveID"]) in same_finishes:
            yield "finish", event_time, notification


def _planned_events(
    moves: Sequence[Mapping[str, Any]],
    *,
    module_parallel: bool = False,
) -> Iterator[Tuple[str, float, Dict[str, Any]]]:
    """按平台时间线或 HongYe 模块并行规则产生完整开始/结束事件。

    模块并行时间已经由 ``materialize_module_parallel_moves`` 写回 Move。这里继续
    对齐 HongYe 的同刻顺序：先结束此前已运行的 Move，再按 ModuleName 启动各
    模块当前队首；零时长 Move 随后结束，解锁的同模块后继进入下一波。
    """
    groups = _planned_event_groups(moves)
    if not module_parallel:
        for group in groups:
            for event_time, notification in group["priorFinishes"]:
                yield "finish", event_time, notification
            yield from _planned_start_events(group)
        return

    planned_by_id = {
        int(move["MoveID"]): dict(move)
        for move in moves
        if isinstance(move.get("MoveID"), int)
    }
    known_ids = set(planned_by_id)
    module_previous: Dict[int, Optional[int]] = {}
    module_name_by_id: Dict[int, str] = {}
    module_queues: Dict[str, List[dict]] = {}
    for move in planned_by_id.values():
        module_name = str(move.get("ModuleName") or "").strip() or "__GLOBAL__"
        module_name_by_id[int(move["MoveID"])] = module_name
        module_queues.setdefault(module_name, []).append(move)
    for queue in module_queues.values():
        queue.sort(key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move.get("MoveID") or 0),
        ))
        previous_id: Optional[int] = None
        for move in queue:
            move_id = int(move["MoveID"])
            module_previous[move_id] = previous_id
            previous_id = move_id

    started: set[int] = set()
    ended: set[int] = set()
    for group in groups:
        for event_time, notification in sorted(
            group["priorFinishes"],
            key=lambda item: int(item[1]["MoveID"]),
        ):
            move_id = int(notification["MoveID"])
            yield "finish", event_time, notification
            ended.add(move_id)

        pending = {
            int(notification["MoveID"]): (event_time, notification)
            for event_time, notification in group["starts"]
        }
        same_finishes = {
            int(notification["MoveID"]): (event_time, notification)
            for event_time, notification in group["sameFinishes"]
        }
        while pending:
            ready: List[Tuple[str, int, float, Dict[str, Any]]] = []
            for move_id, (event_time, notification) in pending.items():
                previous_id = module_previous.get(move_id)
                predecessors = {
                    int(value)
                    for value in (planned_by_id[move_id].get("PreMoveID") or [])
                    if isinstance(value, int) and int(value) in known_ids
                }
                if previous_id is not None and previous_id not in ended:
                    continue
                if not predecessors <= ended:
                    continue
                ready.append((
                    module_name_by_id[move_id],
                    move_id,
                    event_time,
                    notification,
                ))
            if not ready:
                # 依赖环会由 MoveList 结构校验报告；保持确定性事件输出，避免
                # 跳过剩余 Move 后把诊断误报成物料凭空消失。
                ready = [
                    (
                        module_name_by_id[move_id],
                        move_id,
                        event_time,
                        notification,
                    )
                    for move_id, (event_time, notification) in pending.items()
                ]

            selected_by_module: Dict[str, Tuple[str, int, float, Dict[str, Any]]] = {}
            for candidate in sorted(ready, key=lambda item: (item[0], item[1])):
                selected_by_module.setdefault(candidate[0], candidate)
            selected = list(selected_by_module.values())
            for _module_name, move_id, event_time, notification in selected:
                yield "start", event_time, notification
                started.add(move_id)
                pending.pop(move_id, None)
            for _module_name, move_id, _event_time, _notification in sorted(
                selected,
                key=lambda item: item[1],
            ):
                same_finish = same_finishes.pop(move_id, None)
                if same_finish is None:
                    continue
                yield "finish", same_finish[0], same_finish[1]
                ended.add(move_id)


def advance_platform_move_list_to_update(
    runtime: PlatformMoveListRuntime,
    cutoff: float,
) -> List[Dict[str, Any]]:
    """从 MoveList 时间线生成重算边界前的全部 Running/Done 通知。

    参数:
        runtime: 只保存标准协议事实的平台 MoveList 运行时。
        cutoff: 本轮原始重算时刻。

    返回:
        按计划事件顺序排列、严格发生在重算边界内的完整 MoveState 通知。
        调用方写入 ``AlgUpdateMove`` 日志时必须保留完整集合，使 HongYe 在
        下一次 ``AlgSchedule`` 中能恢复已经完成的 PreClean/Dummy Clean；发给
        只接受在途 Move 的外部算法前，由调用方另行筛选。
    """
    cutoff = max(float(cutoff), runtime.state_time)
    notifications: List[Dict[str, Any]] = []
    started: set[int] = set()
    finished: set[int] = set()
    for event_kind, event_time, notification in _planned_events(
        runtime.current_plan,
        module_parallel=runtime.compatibility_mode,
    ):
        move_id = int(notification["MoveID"])
        if (
            event_kind == "start"
            and event_time < cutoff - TIME_TOLERANCE
            and move_id not in started
        ):
            notifications.append(deepcopy(notification))
            started.add(move_id)
        elif (
            event_kind == "finish"
            and event_time <= cutoff + TIME_TOLERANCE
            and move_id in started
            and move_id not in finished
        ):
            notifications.append(deepcopy(notification))
            finished.add(move_id)
    for notification in notifications:
        runtime.update_move_state(
            notification,
            snapshot=False,
            track_reservations=False,
        )
    runtime.advance_to(cutoff)
    return notifications


def _running_move_states(
    notifications: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """把完整执行通知压缩为标准算法包要求的当前 Running 集合。"""
    finished_ids = {
        int(notification["MoveID"])
        for notification in notifications
        if (
            isinstance(notification.get("MoveID"), int)
            and notification.get("MoveState") == MoveStateReplay.DONE
        )
    }
    return [
        deepcopy(dict(notification))
        for notification in notifications
        if (
            isinstance(notification.get("MoveID"), int)
            and notification.get("MoveState") == MoveStateReplay.RUNNING
            and int(notification["MoveID"]) not in finished_ids
        )
    ]


_RECOVERY_TRANSPORT_TYPES = frozenset({
    PICK_MOVE,
    PLACE_MOVE,
    SWAP_MOVE,
    PRE_TRANS_MOVE,
    PREPARE_MOVE,
    COMPLETE_MOVE,
})


def _move_material_ids(move: Mapping[str, Any]) -> set[int]:
    """返回普通搬运或 Swap 字段中引用的全部物料编号。"""
    material_ids: set[int] = set()
    for key in ("MatIDList", "RecvMatList", "SendMatList"):
        material_ids.update(
            int(value)
            for value in (move.get(key) or [])
            if isinstance(value, int)
        )
    return material_ids


def _move_accesses_station(move: Mapping[str, Any], station_name: str) -> bool:
    """判断一条取、放或换片 Move 是否访问指定站点。"""
    station_values = {
        str(move.get("Station") or ""),
        *(str(value) for value in (move.get("SrcStationList") or [])),
        *(str(value) for value in (move.get("DestStationList") or [])),
        *(str(value) for value in (move.get("StationList") or [])),
    }
    return station_name in station_values


def _following_close_id(
    moves: Sequence[Mapping[str, Any]],
    station_name: str,
    action_end: float,
) -> Optional[int]:
    """查找取放或换片结束后同站点的第一条关门 Move。"""
    candidates = [
        move for move in moves
        if move.get("MoveType") == COMPLETE_MOVE
        and str(move.get("Station") or move.get("ModuleName") or "") == station_name
        and float(move.get("StartTime") or 0.0) >= action_end - TIME_TOLERANCE
    ]
    if not candidates:
        return None
    return int(min(candidates, key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move["MoveID"]),
    ))["MoveID"])


def _transport_tail_ids(
    moves: Sequence[Mapping[str, Any]],
    material_id: int,
    cutoff: float,
    include_loadlock_environment: bool = False,
) -> set[int]:
    """返回在手机械手物料到下一次 Place 或 Swap 入站并关门的旧动作集合。"""
    terminal_actions = [
        move for move in moves
        if (
            (
                move.get("MoveType") == PLACE_MOVE
                and material_id in _move_material_ids(move)
            )
            or (
                move.get("MoveType") == SWAP_MOVE
                and material_id in {
                    int(value)
                    for value in (move.get("SendMatList") or [])
                    if isinstance(value, int)
                }
            )
        )
        and float(move.get("EndTime") or 0.0) > cutoff + TIME_TOLERANCE
    ]
    if not terminal_actions:
        raise ValueError(f"旧计划找不到 MatID={material_id} 的后续 Place 或 Swap 入站")
    terminal_action = min(terminal_actions, key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move["MoveID"]),
    ))
    if terminal_action.get("MoveType") == SWAP_MOVE:
        destination = str((terminal_action.get("StationList") or [""])[0])
    else:
        destination = str((terminal_action.get("DestStationList") or [""])[0])
    action_end = float(
        terminal_action.get("EndTime")
        or terminal_action.get("StartTime")
        or cutoff
    )
    close_id = _following_close_id(moves, destination, action_end)
    closure_end = action_end
    if close_id is not None:
        close_move = next(move for move in moves if int(move["MoveID"]) == close_id)
        closure_end = float(close_move.get("EndTime") or closure_end)
    # 晶圆放入 LoadLock 并关门后，带 MatID 的抽气/充气仍属于同一搬运收尾。
    # 若在这里停下，state.py 会正确保留 UNPROCESSED，但标准算法重算桥会把
    # 后续压力转换作为已承诺现场继续执行，下一代计划便会直接从另一侧开门。
    following_environment_moves = (
        [
            move
            for move in moves
            if move.get("MoveType") == PRE_PREPARE_MOVE
            and str(move.get("Station") or move.get("ModuleName") or "") == destination
            and material_id in _move_material_ids(move)
            and float(move.get("StartTime") or 0.0) >= closure_end - TIME_TOLERANCE
        ]
        if include_loadlock_environment
        else []
    )
    environment_move_id: Optional[int] = None
    if following_environment_moves:
        environment_move = min(following_environment_moves, key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move["MoveID"]),
        ))
        environment_move_id = int(environment_move["MoveID"])
        closure_end = max(
            closure_end,
            float(environment_move.get("EndTime") or closure_end),
        )

    required = {
        int(move["MoveID"])
        for move in moves
        if move.get("MoveType") in _RECOVERY_TRANSPORT_TYPES
        and material_id in _move_material_ids(move)
        and float(move.get("EndTime") or 0.0) > cutoff + TIME_TOLERANCE
        and float(move.get("StartTime") or 0.0) <= closure_end + TIME_TOLERANCE
    }
    # LoadLock 目标侧可能需要在 Place 前先做空抽/空充。它没有 MatID，不能仅靠
    # 晶圆字段命中，但属于该搬运链使目标门可访问的必要前置动作。
    place_prepare_start = min(
        (
            float(move.get("StartTime") or 0.0)
            for move in moves
            if move.get("MoveType") == PREPARE_MOVE
            and str(move.get("Station") or move.get("ModuleName") or "") == destination
            and material_id in _move_material_ids(move)
            and abs(
                float(move.get("EndTime") or 0.0)
                - float(terminal_action.get("StartTime") or 0.0)
            ) <= TIME_TOLERANCE
        ),
        default=action_end,
    )
    required.update(
        int(move["MoveID"])
        for move in moves
        if move.get("MoveType") == PRE_PREPARE_MOVE
        and str(move.get("Station") or move.get("ModuleName") or "") == destination
        and float(move.get("StartTime") or 0.0) >= cutoff - TIME_TOLERANCE
        and float(move.get("EndTime") or 0.0) <= place_prepare_start + TIME_TOLERANCE
    )
    # 旧计划可能在 Pick 前安排一条无 MatID 的空载转位。恢复链若只按晶圆
    # 筛选会漏掉它，导致 Robot 仍指向上一站点却直接 Pick。
    selected_picks = [
        move for move in moves
        if int(move["MoveID"]) in required and move.get("MoveType") == PICK_MOVE
    ]
    for pick in selected_picks:
        robot_name = str(pick.get("Robot") or pick.get("ModuleName") or "")
        pick_start = float(pick.get("StartTime") or 0.0)
        required.update(
            int(move["MoveID"])
            for move in moves
            if move.get("MoveType") == PRE_TRANS_MOVE
            and not _move_material_ids(move)
            and str(move.get("Robot") or move.get("ModuleName") or "") == robot_name
            and abs(float(move.get("EndTime") or 0.0) - pick_start) <= TIME_TOLERANCE
            and float(move.get("EndTime") or 0.0) > cutoff + TIME_TOLERANCE
        )
    if close_id is not None:
        required.add(close_id)
    if environment_move_id is not None:
        required.add(environment_move_id)
    return required


def _required_recovery_ids(
    scheduler: RealtimeRescheduler,
    moves: Sequence[Mapping[str, Any]],
    cutoff: float,
    include_loadlock_environment: bool = False,
) -> set[int]:
    """从请求时刻状态选择运行 Move 和必须完成的 Pick–Move–Place 收尾链。"""
    planned_by_id = {int(move["MoveID"]): move for move in moves}
    required = set(scheduler.running_move_ids)
    tail_materials: set[int] = set()
    running_swap_close_ids: set[int] = set()

    # 运行中的加工、清洁和抽充气只保留自身；搬运类动作还要把晶圆落到
    # 原计划下一目标。关门动作是否属于搬运中段由实时持片状态统一判断。
    for move_id in required:
        move = planned_by_id[move_id]
        move_type = move.get("MoveType")
        if move_type in {PREPARE_MOVE, PICK_MOVE, PLACE_MOVE, PRE_TRANS_MOVE}:
            tail_materials.update(_move_material_ids(move))
        elif move_type == SWAP_MOVE:
            tail_materials.update(
                int(value) for value in (move.get("RecvMatList") or []) if isinstance(value, int)
            )
            station_name = str(
                ((move.get("StationList") or [""])[0])
            )
            close_id = _following_close_id(
                moves,
                station_name,
                float(move.get("EndTime") or cutoff),
            )
            if close_id is not None:
                running_swap_close_ids.add(close_id)
    required.update(running_swap_close_ids)

    # 运行中的 SwapMove 在结束回调前，状态机仍把待放入的新片保留在 Robot 手槽。
    # 它实际上会在本次 swap 结束时进入 PM，不能被下面的“当前持片”扫描误判为
    # 还需沿旧计划继续运输；真正需要收尾的是 RecvMatList 中刚换出的旧片。
    running_swap_send_materials = {
        int(value)
        for move_id in required
        for value in (
            planned_by_id[move_id].get("SendMatList") or []
            if planned_by_id[move_id].get("MoveType") == SWAP_MOVE
            else []
        )
        if isinstance(value, int)
    }
    state = scheduler.state
    for robot in state.robots.values():
        tail_materials.update(
            int(material.material_id)
            for material in robot.hands.values()
            if (
                material is not None
                and isinstance(material.material_id, int)
                and int(material.material_id) not in running_swap_send_materials
            )
        )

    # 开门已完成但对应取放恰好从 cutoff 开始时，该 Move 尚未收到 Running。
    # 按用户口径继续原 Pick–Move–Place，而不是直接关回当前门。
    for station_name, station in state.stations.items():
        if station.door is DoorState.CLOSED:
            continue
        if any(
            _move_accesses_station(planned_by_id[move_id], station_name)
            for move_id in required
            if move_id in planned_by_id
        ):
            continue
        related = [
            move for move in moves
            if move.get("MoveType") in {PICK_MOVE, PLACE_MOVE, SWAP_MOVE}
            and float(move.get("StartTime") or 0.0) >= cutoff - TIME_TOLERANCE
            and _move_accesses_station(move, station_name)
        ]
        if not related:
            continue
        action = min(related, key=lambda move: (
            float(move.get("StartTime") or 0.0),
            int(move["MoveID"]),
        ))
        required.add(int(action["MoveID"]))
        if action.get("MoveType") == SWAP_MOVE:
            tail_materials.update(
                int(value) for value in (action.get("RecvMatList") or []) if isinstance(value, int)
            )
            close_id = _following_close_id(
                moves,
                station_name,
                float(action.get("EndTime") or action.get("StartTime") or cutoff),
            )
            if close_id is not None:
                required.add(close_id)
        else:
            tail_materials.update(_move_material_ids(action))

    for material_id in tail_materials:
        required.update(_transport_tail_ids(
            moves,
            material_id,
            cutoff,
            include_loadlock_environment,
        ))
    return required


def advance_to_platform_update(
    runtime: PlatformMoveListRuntime,
    cutoff: float,
    recorded_events: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """只回放到外部算法的原始重算时刻，不执行任何后续安全收尾。

    ``StartTime < cutoff`` 的动作会收到 Running；其中在 cutoff 前结束的动作
    同时收到 Done。仍在运行的动作保留在运行态，供投影快照计算资源剩余时间。
    ``StartTime >= cutoff`` 的动作完全不执行，随后统一进入 RemoveList。
    """
    cutoff = max(float(cutoff), runtime.state_time)
    planned_by_id = {
        int(move["MoveID"]): move
        for move in runtime.current_plan
    }
    started: set[int] = set()
    finished: set[int] = set()

    def apply_notification(notification: Mapping[str, Any]) -> None:
        """应用请求时刻前的一条真实通知，并按需写入复现日志。"""
        applied = dict(notification)
        move_id = int(applied["MoveID"])
        planned_move = planned_by_id[move_id]
        if (
            applied.get("MoveState") == MoveStateReplay.RUNNING
            and planned_move.get("MoveType") == PRE_TRANS_MOVE
            and not _move_material_ids(planned_move)
        ):
            robot_name = str(
                planned_move.get("Robot")
                or planned_move.get("ModuleName")
                or ""
            )
            robot_position = runtime.robot_position(robot_name)
            if robot_position:
                applied["SrcStationList"] = [robot_position]
        runtime.update_move_state(
            applied,
            snapshot=False,
            track_reservations=False,
        )
        if applied.get("MoveState") == MoveStateReplay.RUNNING:
            started.add(move_id)
        else:
            finished.add(move_id)
        if recorded_events is not None:
            recorded_events.append(deepcopy(applied))

    for event_kind, event_time, notification in _planned_events(
        runtime.current_plan,
        module_parallel=runtime.compatibility_mode,
    ):
        move_id = int(notification["MoveID"])
        if (
            event_kind == "start"
            and event_time < cutoff - TIME_TOLERANCE
            and move_id not in started
        ):
            apply_notification(notification)
        elif (
            event_kind == "finish"
            and event_time <= cutoff + TIME_TOLERANCE
            and move_id in started
            and move_id not in finished
        ):
            apply_notification(notification)


def advance_to_recompute(
    scheduler: RealtimeRescheduler,
    cutoff: float,
    recorded_events: Optional[List[Dict[str, Any]]] = None,
    *,
    include_loadlock_environment: bool = False,
) -> RecoveryProjection:
    """投影请求时刻状态，只执行运行 Move 和必要搬运收尾链。

    返回的 ``recovery_end`` 只是固定旧动作的最晚结束时间；新排程仍从 cutoff
    开始，并通过投影状态中的资源占用终点避免与这些旧动作冲突。
    """
    cutoff = max(float(cutoff), scheduler.state_time)
    moves = scheduler.current_plan
    groups = _planned_event_groups(moves)
    planned_by_id = {int(move["MoveID"]): move for move in moves}
    started: set[int] = set()
    finished: set[int] = set()
    material_ready_times: Dict[int, float] = {}

    def apply_notification(notification: Mapping[str, Any]) -> None:
        """发送一条计划通知，并同步维护执行集合、物料释放时间与复现日志。"""
        applied = dict(notification)
        move_id = int(applied["MoveID"])
        planned_move = planned_by_id[move_id]
        if (
            applied.get("MoveState") == MoveStateReplay.RUNNING
            and planned_move.get("MoveType") == PRE_TRANS_MOVE
            and not _move_material_ids(planned_move)
        ):
            robot_name = str(planned_move.get("Robot") or planned_move.get("ModuleName") or "")
            robot_position = scheduler.robot_position(robot_name)
            if robot_position:
                applied["SrcStationList"] = [robot_position]
        # 这里严格回放计划时间，不需要为每条通知复制整机状态，也不需要扫描所有
        # LoadPort 槽位记录“实际结束时间”修正字段。
        scheduler.update_move_state(
            applied,
            snapshot=False,
            track_reservations=False,
        )
        if applied.get("MoveState") == MoveStateReplay.RUNNING:
            started.add(move_id)
        else:
            finished.add(move_id)
            move = planned_by_id[move_id]
            end_time = float(applied.get("EndTime") or move.get("EndTime") or cutoff)
            for material_id in _move_material_ids(move):
                material_ready_times[material_id] = max(
                    material_ready_times.get(material_id, cutoff),
                    end_time,
                )
        if recorded_events is not None:
            recorded_events.append(deepcopy(applied))

    # 还原 t1：只启动严格早于请求时刻的 Move，同刻开始的动作由新调度取消。
    for group in groups:
        for event_time, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if event_time <= cutoff + TIME_TOLERANCE and move_id in started and move_id not in finished:
                apply_notification(notification)
        for event_kind, event_time, notification in _planned_start_events(group):
            move_id = int(notification["MoveID"])
            if (
                event_kind == "start"
                and event_time < cutoff - TIME_TOLERANCE
                and move_id not in started
            ):
                apply_notification(notification)
            elif (
                event_kind == "finish"
                and event_time <= cutoff + TIME_TOLERANCE
                and move_id in started
                and move_id not in finished
            ):
                apply_notification(notification)

    required = _required_recovery_ids(
        scheduler,
        moves,
        cutoff,
        include_loadlock_environment,
    )
    # 前一轮请求可能发生在更早一次恢复链结束之前。那条旧链已经进入历史、
    # 不再出现在 current_plan，但其动作仍是不可取消的物理承诺；本轮展示和
    # 下一段状态投影的 EffectiveTime 不能因此倒退。
    recovery_end = max(
        float(cutoff),
        float(scheduler.committed_recovery_end),
    )
    for group in groups:
        group_time = float(group["time"])
        if group_time < cutoff - TIME_TOLERANCE:
            continue
        for _, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if move_id in required and move_id in started and move_id not in finished:
                apply_notification(notification)
                recovery_end = max(recovery_end, group_time)
        for event_kind, _, notification in _planned_start_events(group):
            move_id = int(notification["MoveID"])
            if event_kind == "start" and move_id in required and move_id not in started:
                apply_notification(notification)
            elif (
                event_kind == "finish"
                and move_id in required
                and move_id in started
                and move_id not in finished
            ):
                apply_notification(notification)
                recovery_end = max(recovery_end, group_time)
        if required.issubset(finished):
            break

    if not required.issubset(finished) or not scheduler.can_recompute:
        open_doors = [
            name for name, station in scheduler.state.stations.items()
            if station.door is not DoorState.CLOSED
        ]
        held = [
            f"{robot.name}#{slot_id}"
            for robot in scheduler.state.robots.values()
            for slot_id, material in robot.hands.items()
            if material is not None
        ]
        running = sorted(scheduler.running_move_ids)
        missing = sorted(required - finished)
        raise ValueError(
            f"旧计划无法完成最小重算收尾：未完成={missing[:8]}，运行={running}，"
            f"开门={open_doors}，机械手持片={held}"
        )
    return RecoveryProjection(recovery_end, material_ready_times)


def _segment_end(moves: Iterable[Mapping[str, Any]]) -> float:
    """返回一组 Move 的最大结束时刻。"""
    return max((float(move.get("EndTime") or 0.0) for move in moves), default=0.0)


def _build_recompute_failure_output(
    runtime: Any,
    update: Mapping[str, Any],
    requested_time: float,
    reason: str,
    error: Exception,
) -> Dict[str, Any]:
    """构造重算调用失败时仍可查看的已保留计划。

    第二轮算法尚未返回新的 MoveList 时，当前代计划仍是上一轮算法的输出。
    本轮 ``RemoveList`` 已明确取消其中哪些未启动 Move；因此甘特图只能保留
    不在该列表中的旧 Move，不能把已取消的计划误展示为仍会执行。历史代次
    Move 必须全部保留；若其 MoveID 恰好与当前代被取消的 Move 复用，它也会
    被浅色标记，但不会从列表中删除。
    """
    removed_move_ids = {
        int(move_id)
        for move_id in (update.get("RemoveList") or [])
        if isinstance(move_id, int) and not isinstance(move_id, bool)
    }
    active_move_ids = {
        int(move["MoveID"])
        for move in runtime.current_plan
        if isinstance(move, Mapping)
        and isinstance(move.get("MoveID"), int)
        and not isinstance(move.get("MoveID"), bool)
    }
    output = runtime.combined_output()
    preserved_moves: List[Dict[str, Any]] = []
    for raw_move in output.get("MoveList") or []:
        if not isinstance(raw_move, Mapping):
            continue
        move = deepcopy(dict(raw_move))
        move_id = move.get("MoveID")
        if (
            isinstance(move_id, int)
            and not isinstance(move_id, bool)
            and move_id in active_move_ids
            and move_id in removed_move_ids
        ):
            # 取消的旧动作同样是失败现场的一部分。前端将其浅色绘制，
            # 并允许用户按需隐藏，避免误认为它仍属于可执行计划。
            move["RemovedByRecompute"] = True
        preserved_moves.append(move)
    output["MoveList"] = preserved_moves
    output["RecomputePoints"] = [
        *deepcopy(list(output.get("RecomputePoints") or [])),
        {
            "Time": float(requested_time),
            "EffectiveTime": float(requested_time),
            "ScheduleStartTime": float(requested_time),
            "RecoveryEndTime": float(requested_time),
            "Index": len(list(output.get("RecomputePoints") or [])) + 1,
            "Reason": reason,
            "Status": "algorithm-error",
        },
    ]
    output["Feedback"] = [
        *deepcopy(list(output.get("Feedback") or [])),
        {
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error) or type(error).__name__,
        },
    ]
    return output


def _build_prior_plan_failure_output(
    reproduction_entries: Sequence[Mapping[str, Any]],
    error: Exception,
) -> Optional[Dict[str, Any]]:
    """从复现日志恢复异常发生前的累计可回放计划。

    CJobCycle 或定时重算可能在旧计划推进、现场投影、update 构造阶段失败，
    此时还没有进入算法调用，也就没有常规重算失败快照。只要此前已有非空
    AlgOutput，就按后续 AlgSchedule 的绝对时刻提交各旧代已经启动的 Move，
    再拼接最后一代完整计划。这样即使跳过输出校验后在下一轮现场回放失败，
    诊断甘特图也不会丢失重算前缀；尚未发送的 RemoveList 不会被误标为已经
    取消。
    """
    generation_time = 0.0
    generation_outputs: List[Tuple[float, Mapping[str, Any]]] = []
    recompute_points: List[Dict[str, Any]] = []
    for entry in reproduction_entries:
        describe = str(entry.get("Describe") or "")
        if describe == "AlgSchedule":
            generation_time = float(entry.get("SimTime") or 0.0)
            continue
        if describe == "RecomputeControl":
            info = entry.get("Info")
            recompute_info = (
                info.get("RecomputeInfo")
                if isinstance(info, Mapping)
                and isinstance(info.get("RecomputeInfo"), Mapping)
                else {}
            )
            point_time = float(
                recompute_info.get("CurrentTime")
                or entry.get("SimTime")
                or 0.0
            )
            recompute_points.append({
                "Time": point_time,
                "EffectiveTime": float(
                    recompute_info.get("EffectiveTime") or point_time
                ),
                "ScheduleStartTime": point_time,
                "RecoveryEndTime": point_time,
                "Index": len(recompute_points) + 1,
                "Reason": str(recompute_info.get("Reason") or "重算"),
            })
            continue
        if describe != "AlgOutput":
            continue
        info = entry.get("Info")
        if isinstance(info, Mapping) and list(info.get("MoveList") or []):
            generation_outputs.append((generation_time, info))
    if not generation_outputs:
        return None

    latest_output = generation_outputs[-1][1]
    combined_moves: List[Dict[str, Any]] = []
    for index, (_schedule_time, generation_output) in enumerate(generation_outputs):
        moves = generation_output.get("MoveList") or []
        if index + 1 < len(generation_outputs):
            next_schedule_time = generation_outputs[index + 1][0]
            moves = [
                move
                for move in moves
                if isinstance(move, Mapping)
                and float(move.get("StartTime") or 0.0)
                < next_schedule_time - TIME_TOLERANCE
            ]
        combined_moves.extend(
            deepcopy(dict(move))
            for move in moves
            if isinstance(move, Mapping)
        )
    combined_moves.sort(key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move.get("MoveID") or 0),
    ))

    output = deepcopy(dict(latest_output))
    output["MoveList"] = combined_moves
    output["RecomputePoints"] = recompute_points
    output["Feedback"] = [
        *deepcopy(list(latest_output.get("Feedback") or [])),
        {
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error) or type(error).__name__,
        },
    ]
    output["FailureContext"] = {
        "Stage": "after-algorithm-output",
        "Message": str(error) or type(error).__name__,
    }
    return output


def _reproduction_history_before_current_output(
    reproduction_entries: Sequence[Mapping[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """恢复当前 AlgOutput 之前已经承诺的跨代 Move 与重算点。

    HongYe 在新代 ``AlgSchedule`` 时会重置校验上下文，因此校验失败只返回本代
    Move。平台复现日志仍保存全部代次；这里按下一次 Schedule 时刻截断上一代
    尚未启动的未来 Move，供失败甘特图拼回真实历史，而不复活已被重算替换的
    动作。
    """
    schedule_time = 0.0
    latest_schedule_time = 0.0
    generation_outputs: List[Tuple[float, Mapping[str, Any]]] = []
    recompute_points: List[Dict[str, Any]] = []
    for entry in reproduction_entries:
        describe = str(entry.get("Describe") or "")
        if describe == "AlgSchedule":
            schedule_time = float(entry.get("SimTime") or 0.0)
            latest_schedule_time = schedule_time
            continue
        if describe == "RecomputeControl":
            info = entry.get("Info")
            recompute_info = (
                info.get("RecomputeInfo")
                if isinstance(info, Mapping)
                and isinstance(info.get("RecomputeInfo"), Mapping)
                else {}
            )
            point_time = float(
                recompute_info.get("CurrentTime")
                or entry.get("SimTime")
                or 0.0
            )
            recompute_points.append({
                "Time": point_time,
                "EffectiveTime": float(
                    recompute_info.get("EffectiveTime") or point_time
                ),
                "ScheduleStartTime": point_time,
                "RecoveryEndTime": point_time,
                "Index": len(recompute_points) + 1,
                "Reason": str(recompute_info.get("Reason") or "重算"),
            })
            continue
        if describe != "AlgOutput":
            continue
        info = entry.get("Info")
        if isinstance(info, Mapping):
            generation_outputs.append((schedule_time, info))

    history: List[Dict[str, Any]] = []
    for index, (generation_time, output) in enumerate(generation_outputs):
        next_generation_time = (
            generation_outputs[index + 1][0]
            if index + 1 < len(generation_outputs)
            else latest_schedule_time
            if latest_schedule_time > generation_time + TIME_TOLERANCE
            else math.inf
        )
        history.extend(
            deepcopy(dict(move))
            for move in (output.get("MoveList") or [])
            if isinstance(move, Mapping)
            and float(move.get("StartTime") or 0.0)
            < next_generation_time - TIME_TOLERANCE
        )
    history.sort(key=lambda move: (
        float(move.get("StartTime") or 0.0),
        int(move.get("MoveID") or 0),
    ))
    return history, recompute_points


def _release_finished_load_ports(
    runtime: Any,
    build_state: BuildState,
    load_port_names: Optional[Sequence[str]] = None,
) -> Tuple[set[Any], set[str]]:
    """在新一轮装片前卸载指定范围的成品并重置已清空槽位计数。

    ``load_port_names`` 为空时检查当前计划使用的全部 LoadPort；CJobCycle
    事件应显式传入本次已经整盒完工的端口，避免一次重算提前清空其他循环。
    """
    requested_load_ports = tuple(
        load_port_names
        if load_port_names is not None
        else build_state.next_slot_by_port
    )
    released_ids, empty_ports = runtime.release_completed_load_ports(
        requested_load_ports,
    )
    for load_port_name in empty_ports:
        build_state.next_slot_by_port[load_port_name] = 0
    return released_ids, empty_ports

__all__ = tuple(name for name in globals() if not name.startswith('__'))
