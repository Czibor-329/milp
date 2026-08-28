"""实时重算的整机状态合并与标准 update 快照生成。

本模块承接平台物理状态回放后的协议转换：把新一轮物料合入上一代
``MachineState``、释放被新批次复用的 LoadPort 槽位、合并全量算法 update，
并将投影后的站点、机器人和物料状态写回企业标准接口。HTTP 服务只负责流程编排，
不在边界层解释 LoadLock 压力态或物料位置。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Mapping, Optional, Set

from realtime_scheduler.move_validation import (
    ATMOSPHERE,
    LoadLockState,
    MachineState,
    MaterialState,
    SlotPhase,
    SlotState,
)
from realtime_scheduler.plan_builder import FIRST_SLOT_ID


DEFAULT_ATMOSPHERE_LAST_ITEM = "ATR"
DEFAULT_VACUUM_LAST_ITEM = "VTR"


def _empty_dummy_route() -> Dict[str, Any]:
    """返回 Dummy 库存片回港后的标准空 Route。"""
    return {
        "Name": "",
        "RouteSteps": [],
        "BufferOption": -1,
        "BoundedStepIDs": [],
        "Group": "",
        "PrePJob": {},
        "PostPJob": {},
        "PostCJob": {},
    }


def _dummy_assignment_hints(
    update_params: Mapping[str, Any],
    algorithm_output: Mapping[str, Any],
) -> tuple[Dict[str, tuple[str, str]], Set[str]]:
    """从当前运行 Move 和已启动历史中推导在途 Dummy 的任务归属。

    返回值第一项按 MatID 保存 ``(TaskID, PJobName)``；第二项是当前仍有
    Running Move 的 MatID。Running Move 优先于同一片更早的历史动作。
    """
    running_move_ids = {
        int(state["MoveID"])
        for state in update_params.get("MoveStates") or []
        if (
            isinstance(state, Mapping)
            and state.get("MoveID") is not None
            and str(state.get("MoveState", "")).strip().casefold()
            in {"0", "running"}
        )
    }
    current_time = float(update_params.get("CurrentTime") or 0.0)
    candidates: List[tuple[int, float, int, Mapping[str, Any]]] = []
    for order, move in enumerate(algorithm_output.get("MoveList") or []):
        if not isinstance(move, Mapping) or move.get("MoveID") is None:
            continue
        try:
            move_id = int(move["MoveID"])
            start_time = float(move.get("StartTime") or 0.0)
        except (TypeError, ValueError):
            continue
        if move_id not in running_move_ids and start_time > current_time:
            continue
        candidates.append((move_id in running_move_ids, start_time, order, move))

    hints: Dict[str, tuple[str, str]] = {}
    running_material_ids: Set[str] = set()
    for is_running, _start_time, _order, move in sorted(candidates):
        material_ids = list(move.get("MatIDList") or [])
        task_ids = list(move.get("TaskID") or [])
        pjob_names = list(move.get("PJobName") or [])
        for index, material_id in enumerate(material_ids):
            material_key = str(material_id)
            task_id = str(task_ids[index] if index < len(task_ids) else "")
            pjob_name = str(
                pjob_names[index] if index < len(pjob_names) else ""
            )
            if task_id or pjob_name:
                hints[material_key] = (task_id, pjob_name)
            if is_running:
                running_material_ids.add(material_key)
    return hints, running_material_ids


def restore_dummy_routes_from_algorithm_output(
    update_params: Dict[str, Any],
    algorithm_output: Mapping[str, Any],
) -> List[Any]:
    """把算法返回的 Dummy 路径事务写回下一轮标准 update。

    ``DummyReturnInfo`` 是算法为具体 Dummy MatID 返回的实际路径。在途 Dummy
    保持该路径和任务归属；已经回到来源 DummyPort 且没有 Running Move 的库存片
    恢复默认 TaskID、PJobName、StepID、CurrentModuleName 和 Route。``Count`` 是
    物理片跨任务累计寿命，不在恢复默认状态时修改。

    参数:
        update_params: 即将再次发送给算法的全量标准 update，会被原地更新。
        algorithm_output: 上一轮算法的标准输出。

    返回:
        成功恢复路径的 Dummy MatID 列表。
    """
    return_info = algorithm_output.get("DummyReturnInfo") or {}
    if not isinstance(return_info, Mapping):
        return []
    assignment_hints, running_material_ids = _dummy_assignment_hints(
        update_params,
        algorithm_output,
    )
    materials = update_params.get("Materials") or []
    if isinstance(materials, Mapping):
        material_items = materials.values()
    elif isinstance(materials, list):
        material_items = materials
    else:
        return []

    restored: List[Any] = []
    for material in material_items:
        if not isinstance(material, dict) or material.get("ID") is None:
            continue
        material_id = material["ID"]
        raw_entries = return_info.get(str(material_id), return_info.get(material_id))
        if isinstance(raw_entries, Mapping):
            raw_entries = [raw_entries]
        if not isinstance(raw_entries, list):
            continue
        material_key = str(material_id)
        source_port = str(material.get("SrcPortName") or "DummyPort")
        current_module = str(material.get("CurrentModuleName") or "")
        if (
            current_module == source_port
            and material_key not in running_material_ids
        ):
            material["TaskID"] = ""
            material["PJobName"] = ""
            material["StepID"] = 0
            material["CurrentModuleName"] = source_port
            material["Route"] = _empty_dummy_route()
            restored.append(material_id)
            continue
        route = material.get("Route") or {}
        hinted_task_id, hinted_pjob_name = assignment_hints.get(
            material_key,
            ("", ""),
        )
        if isinstance(route, Mapping) and route.get("RouteSteps"):
            task_matches = (
                not hinted_task_id
                or str(material.get("TaskID") or "") == hinted_task_id
            )
            pjob_matches = (
                not hinted_pjob_name
                or str(material.get("PJobName") or "") == hinted_pjob_name
            )
            if task_matches and pjob_matches:
                continue
        current_step_id = material.get("StepID")
        candidates = [
            entry
            for entry in raw_entries
            if isinstance(entry, Mapping)
            and isinstance(entry.get("RouteRecipe"), Mapping)
            and entry["RouteRecipe"].get("RouteSteps")
        ]
        if not candidates:
            continue

        def route_score(entry: Mapping[str, Any]) -> int:
            """优先匹配在途 Move 的任务归属，再匹配现场 StepID 和模块。"""
            score = 0
            if hinted_task_id:
                score += (
                    1000
                    if str(entry.get("TaskID") or "") == hinted_task_id
                    else -1000
                )
            if hinted_pjob_name:
                score += (
                    1000
                    if str(entry.get("PJobName") or "") == hinted_pjob_name
                    else -1000
                )
            route_steps = entry["RouteRecipe"].get("RouteSteps") or []
            if isinstance(route_steps, Mapping):
                route_steps = route_steps.values()
            for step in route_steps:
                if not isinstance(step, Mapping):
                    continue
                visits = {
                    str(visit.get("StationName") or "")
                    for visit in step.get("Visits") or []
                    if isinstance(visit, Mapping)
                }
                if current_module in visits:
                    score = max(score, 10)
                    if str(step.get("StepID")) == str(current_step_id):
                        score = max(score, 100)
            return score

        selected = max(candidates, key=route_score)
        material["Route"] = deepcopy(dict(selected["RouteRecipe"]))
        material["PJobName"] = str(selected.get("PJobName") or "")
        material["TaskID"] = str(selected.get("TaskID") or "")
        restored.append(material_id)
    return restored


def _arm_slot_at_station(robot_state: Any, arm_name: Any) -> Optional[str]:
    """按臂的槽位级指向派生 SlotAtStation（双臂可横跨两站时取最小槽位指向）。"""
    arm_slots = sorted(robot_state.arm_slots.get(str(arm_name or ""), ()) if robot_state.arm_slots else ())
    if not arm_slots:
        arm_slots = sorted(robot_state.hands)
    for slot_id in arm_slots:
        target = robot_state.slot_targets.get(slot_id)
        if target is not None:
            return target[0]
    stations: Set[str] = set()
    for slot_id in arm_slots:
        for station, _ in robot_state.slot_options.get(slot_id, ()) or ():
            stations.add(station)
    return min(stations) if stations else robot_state.position


def _material_ids_in_machine_state(state: MachineState) -> set[Any]:
    """收集站点槽位和机器人手槽中已经存在的物料编号。"""
    material_ids = {
        slot.material.material_id
        for station in state.stations.values()
        for slot in station.slots.values()
        if slot.material is not None
    }
    material_ids.update(
        material.material_id
        for robot in state.robots.values()
        for material in robot.hands.values()
        if material is not None
    )
    return material_ids


def add_new_materials_to_machine_state(
    state: MachineState,
    update_params: Mapping[str, Any],
) -> None:
    """把下一轮首次出现的 LoadPort 物料补入上一轮稳定状态。"""
    known_material_ids = _material_ids_in_machine_state(state)
    for raw_material in update_params.get("Materials") or []:
        if not isinstance(raw_material, Mapping):
            continue
        material_id = raw_material.get("ID")
        if material_id is None or material_id in known_material_ids:
            continue
        station_name = str(raw_material.get("CurrentModuleName") or "")
        slot_id = raw_material.get("SlotID")
        if not station_name or not isinstance(slot_id, int) or slot_id < FIRST_SLOT_ID:
            raise ValueError(f"新增物料 {material_id} 缺少有效 CurrentModuleName/SlotID")
        station = state.ensure_station(station_name, slot_id)
        slot = station.slots[slot_id]
        if slot.material is not None:
            raise ValueError(
                f"新增物料 {material_id} 与 {station_name}#{slot_id} 的现有物料冲突"
            )
        station.slots[slot_id] = SlotState(
            SlotPhase.COMPLETED,
            MaterialState(
                material_id,
                str(raw_material.get("PJobName") or ""),
                raw_material.get("StepID"),
            ),
            material_process_count=slot.material_process_count,
        )
        known_material_ids.add(material_id)


def release_reused_source_slots(
    state: MachineState,
    new_round_update: Mapping[str, Any],
) -> set[Any]:
    """新片复用同一 LoadPort 槽位时，从投影状态卸载上一片成品。"""
    released_ids: set[Any] = set()
    for material in new_round_update.get("Materials") or []:
        if not isinstance(material, Mapping):
            continue
        station_name = str(material.get("CurrentModuleName") or "")
        slot_id = material.get("SlotID")
        if not station_name or not isinstance(slot_id, int):
            continue
        station = state.stations.get(station_name)
        slot = station.slots.get(slot_id) if station is not None else None
        if slot is None or slot.material is None:
            continue
        released_ids.add(slot.material.material_id)
        slot.phase = SlotPhase.EMPTY
        slot.material = None
    return released_ids


def merge_algorithm_update(
    previous_update: Mapping[str, Any],
    new_round_update: Mapping[str, Any],
    previous_output: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """把新一轮 Job 追加到上一轮全量 update，形成企业接口当前快照。

    ``previous_output`` 存在时同时消费上一轮 ``DummyReturnInfo``。把回填放在
    全量 update 的统一合并边界，确保内置算法和外部算法的两条重算路径都不会
    漏掉平台已收到的 Dummy Route。
    """
    merged = deepcopy(dict(previous_update))
    merged["Scenario"] = new_round_update.get("Scenario", merged.get("Scenario", 0))
    merged["CurrentTime"] = float(new_round_update.get("CurrentTime") or 0.0)
    merged["InitialMoveID"] = int(
        new_round_update.get("InitialMoveID", merged.get("InitialMoveID", 0)) or 0
    )
    merged["ProcessRecipes"] = deepcopy(
        list(new_round_update.get("ProcessRecipes") or [])
    )
    merged_routes = deepcopy(dict(merged.get("Routes") or {}))
    merged_routes.update(deepcopy(dict(new_round_update.get("Routes") or {})))
    merged["Routes"] = merged_routes

    material_by_id: Dict[Any, Dict[str, Any]] = {}
    for raw_material in [
        *(merged.get("Materials") or []),
        *(new_round_update.get("Materials") or []),
    ]:
        if isinstance(raw_material, Mapping) and raw_material.get("ID") is not None:
            material_by_id[raw_material["ID"]] = deepcopy(dict(raw_material))
    merged["Materials"] = list(material_by_id.values())

    process_job_by_name: Dict[str, Dict[str, Any]] = {}
    for raw_job in [
        *(merged.get("ProcessJobs") or []),
        *(new_round_update.get("ProcessJobs") or []),
    ]:
        if isinstance(raw_job, Mapping) and raw_job.get("JobName"):
            process_job_by_name[str(raw_job["JobName"])] = deepcopy(dict(raw_job))
    merged["ProcessJobs"] = list(process_job_by_name.values())
    merged["ControlJobs"] = [
        deepcopy(dict(control_job))
        for control_job in [
            *(merged.get("ControlJobs") or []),
            *(new_round_update.get("ControlJobs") or []),
        ]
        if isinstance(control_job, Mapping)
    ]
    merged["Robots"] = deepcopy(dict(new_round_update.get("Robots") or {}))
    merged["Stations"] = deepcopy(dict(new_round_update.get("Stations") or {}))
    merged["MoveStates"] = []
    merged["RemoveList"] = []
    if previous_output is not None:
        restore_dummy_routes_from_algorithm_output(merged, previous_output)
    return merged


def _remaining_seconds(ready_at: float, current_time: float) -> float:
    """把状态机绝对释放时间转换为企业 update 使用的剩余秒数。"""
    return max(0.0, float(ready_at) - float(current_time))


def _configured_loadlock_last_item(
    station: Mapping[str, Any],
    station_state: LoadLockState,
) -> str:
    """将内部压力态恢复成当前设备 ``PrePrepareTime`` 使用的精确侧名称。

    12kChamber 同时包含 ``ATR_1/VTR_1`` 和 ``VTR_1/VTR_2`` 两类 LoadLock。
    内部 ``ATM/VAC`` 只表示转换的两侧，不能直接序列化成通用 ``ATR/VTR``；
    否则重算会丢失桥接 LoadLock 的具体真空机器人侧。优先返回设备配置中的原始
    大小写，缺少配置别名时才兼容旧设备回退到通用名称。
    """
    for transition in station.get("PrePrepareTime") or []:
        if not isinstance(transition, Mapping):
            continue
        for field_name in ("LastItem", "CurrentItem"):
            configured_alias = str(transition.get(field_name) or "").strip()
            if (
                configured_alias
                and station_state.environment_aliases.get(configured_alias.upper())
                == station_state.environment
            ):
                return configured_alias

    for alias, environment in station_state.environment_aliases.items():
        if environment == station_state.environment:
            return str(alias)
    return (
        DEFAULT_ATMOSPHERE_LAST_ITEM
        if station_state.environment == ATMOSPHERE
        else DEFAULT_VACUUM_LAST_ITEM
    )


def apply_machine_state_to_update(
    update_params: Dict[str, Any],
    state: MachineState,
    current_time: float,
) -> None:
    """将 ``MachineState`` 的物料、机器人、站点和压力态写回标准 update。"""
    update_params["CurrentTime"] = float(current_time)
    materials = {
        material.get("ID"): material
        for material in update_params.get("Materials") or []
        if isinstance(material, dict) and material.get("ID") is not None
    }
    located_material_ids: set[Any] = set()

    stations = update_params.setdefault("Stations", {})
    for station_name, station_state in state.stations.items():
        station = stations.setdefault(station_name, {})
        shared_ready_at = max(
            station_state.door_busy_until,
            station_state.transfer_busy_until,
            station_state.environment_busy_until,
        )
        slot_times = station.setdefault("TimeToAvailableOfSlot", {})
        for slot_id, slot_state in station_state.slots.items():
            slot_times[str(slot_id)] = _remaining_seconds(
                max(shared_ready_at, slot_state.busy_until),
                current_time,
            )
            material = slot_state.material
            if material is None:
                continue
            raw_material = materials.get(material.material_id)
            if raw_material is None:
                raise ValueError(
                    f"状态机中的物料 {material.material_id} 不在当前 update.Materials"
                )
            raw_material["CurrentModuleName"] = station_name
            raw_material["SlotID"] = int(slot_id)
            if material.step_id is not None:
                raw_material["StepID"] = material.step_id
            if material.pjob_name:
                raw_material["PJobName"] = material.pjob_name
            located_material_ids.add(material.material_id)
        # 企业接口中的 MaterialCount 是逐槽累计加工次数，不是站内当前物料数。
        if "MaterialCount" in station:
            station["MaterialCount"] = {
                str(slot_id): slot_state.material_process_count
                for slot_id, slot_state in sorted(station_state.slots.items())
            }
        if isinstance(station_state, LoadLockState):
            station["LastItem"] = _configured_loadlock_last_item(
                station,
                station_state,
            )

    robots = update_params.setdefault("Robots", {})
    for robot_name, robot_state in state.robots.items():
        robot = robots.setdefault(robot_name, {})
        robot["TimeToAvailable"] = _remaining_seconds(
            robot_state.busy_until,
            current_time,
        )
        if robot_state.position or robot_state.slot_targets:
            arm_info = robot.get("ArmInfo") or {}
            if isinstance(arm_info, Mapping):
                for arm in arm_info.values():
                    if isinstance(arm, dict) and arm.get("IsEnable") is not False:
                        arm["SlotAtStation"] = _arm_slot_at_station(robot_state, arm.get("Name"))
        for slot_id, material in robot_state.hands.items():
            if material is None:
                continue
            raw_material = materials.get(material.material_id)
            if raw_material is None:
                raise ValueError(
                    f"机械手中的物料 {material.material_id} 不在当前 update.Materials"
                )
            raw_material["CurrentModuleName"] = robot_name
            raw_material["SlotID"] = int(slot_id)
            if material.step_id is not None:
                raw_material["StepID"] = material.step_id
            if material.pjob_name:
                raw_material["PJobName"] = material.pjob_name
            located_material_ids.add(material.material_id)

    # 本轮新增物料尚未进入上一代 MachineState，保留 build_round_update 给出的
    # LoadPort 位置；其余历史物料必须全部能由状态机定位。
    state_material_ids = _material_ids_in_machine_state(state)
    missing_material_ids = state_material_ids - located_material_ids
    if missing_material_ids:
        raise ValueError(
            f"机台快照存在无法定位的历史物料：{sorted(missing_material_ids)}"
        )
