"""CJob Cycle 多周期任务展开与完成边界计算。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.execution.run_state import *

@dataclass
class CJobCycleRuntime:
    """记录一个固定 LoadPort CJob 当前运行到第几盒。"""

    template: Dict[str, Any]
    load_port: str
    total_cycles: int
    current_cycle: int
    current_task_id: str
    configured_round: int


def _cjob_cycle_product_material_ids(
    update_params: Mapping[str, Any],
    task_id: str,
    load_port: str,
) -> set[Any]:
    """返回一个 CJobCycle 当前盒的产品晶圆编号。

    ProcessJob.MatList 是 CJob 产品成员的权威集合，DummyReturnInfo 临时写入
    Dummy 的 TaskID 不会改变该集合。兼容缺少 ProcessJobs 的旧测试或外部快照
    时，才按 TaskID 与 SrcPortName 的组合从 Materials 回退识别。
    """
    matching_process_jobs = [
        process_job
        for process_job in update_params.get("ProcessJobs") or []
        if (
            isinstance(process_job, Mapping)
            and str(process_job.get("TaskID") or "") == str(task_id)
        )
    ]
    if matching_process_jobs:
        return {
            material_id
            for process_job in matching_process_jobs
            for material_id in (process_job.get("MatList") or [])
            if material_id is not None
        }
    return {
        material.get("ID", material.get("Name"))
        for material in update_params.get("Materials") or []
        if (
            isinstance(material, Mapping)
            and str(material.get("TaskID") or "") == str(task_id)
            and str(material.get("SrcPortName") or "") in {"", str(load_port)}
            and material.get("ID", material.get("Name")) is not None
        )
    }


def _completed_cycle_material_ids(
    update_params: Mapping[str, Any],
    completed_cycles: Sequence[CJobCycleRuntime],
) -> set[Any]:
    """返回已完成循环中应从真实 LoadPort 卸载的产品物料编号。

    DummyReturnInfo 会把清洁片临时绑定到产品 TaskID，但其物理来源仍是
    DummyPort。CJobCycle 完成只能卸载对应 TaskID 且 SrcPortName 与该循环
    LoadPort 一致的产品片，不能按 TaskID 连带删除可复用 Dummy 库存。
    """
    material_ids: set[Any] = set()
    for cycle_state in completed_cycles:
        material_ids.update(_cjob_cycle_product_material_ids(
            update_params,
            cycle_state.current_task_id,
            cycle_state.load_port,
        ))
    return material_ids


def _cjob_cycle_count(cjob: Mapping[str, Any]) -> int:
    """读取并校验 CJob 的总循环数；旧数据默认只运行一盒。"""
    raw_value = cjob.get(
        "cjobCycle",
        cjob.get("CJobCycle", cjob.get("jobCycle", cjob.get("JobCycle", 1))),
    )
    if isinstance(raw_value, bool):
        raise ValueError("CJobCycle 必须是整数")
    try:
        numeric = float(raw_value)
    except (TypeError, ValueError):
        raise ValueError("CJobCycle 必须是整数") from None
    if not math.isfinite(numeric):
        raise ValueError("CJobCycle 必须是有限整数")
    cycle_count = int(numeric)
    if abs(numeric - cycle_count) > TIME_TOLERANCE:
        raise ValueError("CJobCycle 必须是整数")
    if cycle_count < 1 or cycle_count > MAX_CJOB_CYCLE:
        raise ValueError(f"CJobCycle 必须为 1~{MAX_CJOB_CYCLE}")
    return cycle_count


def _cjob_load_port_name(cjob: Mapping[str, Any]) -> str:
    """读取 CJob 固定占用的 LoadPort，并兼容旧版 PJob 字段。"""
    configured = str(cjob.get("loadPort") or cjob.get("LoadPort") or "").strip()
    if configured:
        return configured
    pjobs = [row for row in (cjob.get("pjobs") or []) if isinstance(row, Mapping)]
    return str(
        (pjobs[0].get("loadPort") or pjobs[0].get("LoadPort") or "")
        if pjobs
        else ""
    ).strip()


def _cycle_task_id(base_task_id: str, cycle_index: int) -> str:
    """为补片循环生成稳定且不与普通轮次冲突的 TaskID。"""
    return base_task_id if cycle_index == 1 else f"{base_task_id}-CYCLE-{cycle_index}"


def _cycle_cjob(cjob: Mapping[str, Any], cycle_index: int) -> Dict[str, Any]:
    """复制一个 CJob 作为指定循环的独立标准 ControlJob。"""
    cloned = deepcopy(dict(cjob))
    base_task_id = str(cjob.get("taskId") or cjob.get("TaskID") or "").strip()
    if not base_task_id:
        raise ValueError("启用 CJobCycle 的 CJob 必须包含 TaskID")
    load_port = _cjob_load_port_name(cjob)
    if not load_port:
        raise ValueError(f"CJob TaskID={base_task_id} 必须选择 LoadPort")
    cloned["taskId"] = _cycle_task_id(base_task_id, cycle_index)
    cloned["loadPort"] = load_port
    cloned["cjobCycle"] = 1
    cloned["pjobs"] = [
        {**deepcopy(dict(pjob)), "loadPort": load_port}
        for pjob in (cjob.get("pjobs") or [])
        if isinstance(pjob, Mapping)
    ]
    return cloned


def _cycle_states_for_round(
    round_config: Mapping[str, Any],
    configured_round: int,
) -> List[CJobCycleRuntime]:
    """为一轮中需要补片的 CJob 建立运行状态。"""
    states: List[CJobCycleRuntime] = []
    for cjob in _round_cjob_rows(round_config):
        total_cycles = _cjob_cycle_count(cjob)
        if total_cycles <= 1:
            continue
        base_task_id = str(cjob.get("taskId") or cjob.get("TaskID") or "").strip()
        load_port = _cjob_load_port_name(cjob)
        if not base_task_id:
            raise ValueError("启用 CJobCycle 的 CJob 必须包含 TaskID")
        if not load_port:
            raise ValueError(f"CJob TaskID={base_task_id} 必须选择 LoadPort")
        states.append(CJobCycleRuntime(
            template=deepcopy(cjob),
            load_port=load_port,
            total_cycles=total_cycles,
            current_cycle=1,
            current_task_id=base_task_id,
            configured_round=configured_round,
        ))
    return states


def _material_finished_cjob_cycle(
    material: Mapping[str, Any],
    load_port: str,
) -> bool:
    """判断重算快照中的物料是否已经走到指定 LoadPort 的 Route 终点。"""
    current_module = str(material.get("CurrentModuleName") or "").strip()
    if current_module != load_port:
        return False
    current_step_id = material.get("StepID")
    if current_step_id is None:
        return False
    route = material.get("Route")
    route_steps = route.get("RouteSteps") if isinstance(route, Mapping) else []
    for step in route_steps or []:
        if (
            not isinstance(step, Mapping)
            or step.get("StepID") is None
            or str(step.get("StepID")) != str(current_step_id)
        ):
            continue
        if step.get("PostStepID"):
            return False
        terminal_stations = {
            str(visit.get("StationName") or "").strip()
            for visit in (step.get("Visits") or [])
            if isinstance(visit, Mapping)
        }
        return load_port in terminal_stations
    return False


def _cjob_cycle_completion_time(
    runtime: Any,
    cycle_state: CJobCycleRuntime,
) -> Optional[float]:
    """求整盒回片且本代可复用 Dummy 回库后的最晚补片时刻。

    产品完成后，下一段 Dummy 清洁可能已经与产品尾片并行启动。若此时立即
    重算并再次追加同一物理 Dummy 的 Route，会把在途清洁片重复并入新任务。
    因而 CJobCycle 还需等待当前代实际参与动作的 Dummy 完成本代路线。
    """
    material_ids = _cjob_cycle_product_material_ids(
        runtime.current_update,
        cycle_state.current_task_id,
        cycle_state.load_port,
    )
    if not material_ids:
        return None
    materials = [
        material
        for material in (runtime.current_update.get("Materials") or [])
        if (
            isinstance(material, Mapping)
            and material.get("ID", material.get("Name")) in material_ids
        )
    ]
    # 其他 CJob 的完工事件可能已经触发过重算。此时本 CJob 先完成的晶圆仍在
    # current_update 的终点槽中，但不会再次出现在新一代 MoveList；它们应按
    # 当前状态时刻计为已完成，只让尚未回片的晶圆决定未来完工边界。
    latest_by_material: Dict[Any, float] = {}
    for material in materials:
        material_id = material.get("ID", material.get("Name"))
        if (
            material_id is not None
            and _material_finished_cjob_cycle(material, cycle_state.load_port)
        ):
            latest_by_material[material_id] = runtime.state_time
    for move in runtime.current_plan:
        end_time = _finite_number(
            move.get("EndTime"),
            _finite_number(move.get("StartTime"), runtime.state_time),
        )
        for material_id in _move_material_ids(move):
            if material_id in material_ids:
                latest_by_material[material_id] = max(
                    latest_by_material.get(material_id, runtime.state_time),
                    end_time,
                )
    if material_ids - set(latest_by_material):
        return None
    reusable_dummy_ids = {
        material.get("ID", material.get("Name"))
        for material in (runtime.current_update.get("Materials") or [])
        if (
            isinstance(material, Mapping)
            and str(material.get("SrcPortName") or "") == "DummyPort"
            and material.get("ID", material.get("Name")) is not None
        )
    }
    dummy_return_time = max(
        (
            _finite_number(
                move.get("EndTime"),
                _finite_number(move.get("StartTime"), runtime.state_time),
            )
            for move in runtime.current_plan
            if _move_material_ids(move) & reusable_dummy_ids
        ),
        default=runtime.state_time,
    )
    # 普通定时重算会取消恰好在 cutoff 启动的动作；补片事件则必须先消费同刻的
    # 零时长回片/完成动作。仅跨过状态机容差边界，不引入业务上的装卸时间。
    return (
        max(max(latest_by_material.values()), dummy_return_time)
        + TIME_TOLERANCE * CJOB_CYCLE_EVENT_EPSILON_MULTIPLIER
    )



__all__ = tuple(name for name in globals() if not name.startswith('__'))
