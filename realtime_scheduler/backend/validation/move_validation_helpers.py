"""MoveList 校验的运输、设备配置和数据解析辅助函数。"""

import math
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from .move_validation_core import (
    DoorState,
    LoadLockState,
    MachineState,
    MaterialState,
    RobotState,
    SlotPhase,
    SlotState,
    StationState,
    ValidationErrorCode,
    _ScheduledCompletion,
)
# 配置常量（例如 DEFAULT_SLOT_ID、站点类型）与状态模型同属核心契约；使用显式
# 模块导入补齐辅助函数需要的常量，不复制第二份协议定义。
from .move_validation_core import *  # noqa: F401,F403,E402


def _issue(
    move: Mapping[str, Any],
    error_code: ValidationErrorCode,
    message: str,
) -> str:
    """生成包含错误码、MoveID 和动作类型的稳定错误文本。"""
    return (
        f"[{error_code.value}] MoveID={move.get('MoveID', '?')} "
        f"MoveType={move.get('MoveType', '?')}：{message}"
    )


def _transport_rows(move: Mapping[str, Any], station_key: str, station_slot_key: str, robot_slot_key: str, material_key: str) -> "List[Tuple[str, int, int, Any, int]] | str":
    """把并行运输字段规范为逐片行，并检查数组长度。"""
    materials = _values(move, material_key)
    stations = [str(value) for value in _values(move, station_key)]
    station_slots = _integer_values(move, station_slot_key)
    robot_slots = _integer_values(move, robot_slot_key)
    count = len(materials)
    if not count:
        return _issue(move, ValidationErrorCode.PARALLEL_ARRAY_INVALID, f"{material_key} 不能为空")
    if len(stations) == 1 and count > 1:
        stations *= count
    if any(len(values) != count for values in (stations, station_slots, robot_slots)):
        return _issue(move, ValidationErrorCode.PARALLEL_ARRAY_INVALID, f"{material_key} 与站点/槽位数组数量不一致")
    return [(stations[index], station_slots[index], robot_slots[index], materials[index], index) for index in range(count)]


def _validate_distinct_transport_rows(move: Mapping[str, Any], rows: Sequence[Tuple[str, int, int, Any, int]]) -> Optional[str]:
    """保证一个原子运输动作不会重复占用物理槽位或物料。"""
    station_refs = [(row[0], row[1]) for row in rows]
    robot_slots = [row[2] for row in rows]
    materials = [str(row[3]) for row in rows]
    if len(set(station_refs)) != len(station_refs):
        return _issue(move, ValidationErrorCode.DUPLICATE_RESOURCE_REFERENCE, "同一动作不能重复引用站点槽位")
    if len(set(robot_slots)) != len(robot_slots):
        return _issue(move, ValidationErrorCode.DUPLICATE_RESOURCE_REFERENCE, "同一动作不能重复引用机器人手槽")
    if len(set(materials)) != len(materials):
        return _issue(move, ValidationErrorCode.DUPLICATE_RESOURCE_REFERENCE, "同一动作不能重复引用物料")
    return None


def _station_access_error(robot: RobotState, station: StationState, start_time: float, move: Mapping[str, Any]) -> Optional[str]:
    """校验机器人可达性、腔门和站点共享取放资源。"""
    if robot.scope and station.name not in robot.scope:
        return _issue(move, ValidationErrorCode.ROBOT_UNREACHABLE, f"{robot.name} 无法访问 {station.name}")
    if not _is_doorless(station) and station.door is not DoorState.OPEN:
        return _issue(move, ValidationErrorCode.STATION_DOOR_STATE_INVALID, f"{station.name} 门当前为关门")
    if not _available(station.transfer_busy_until, start_time):
        return _issue(move, ValidationErrorCode.STATION_TRANSFER_BUSY, f"{station.name} 正在执行取放动作")
    return None


def _related_move(move: Mapping[str, Any], moves: Sequence[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    """查找紧接开门动作、访问同一站点的运输动作。"""
    end_time = _number(move.get("EndTime"))
    station_name = _station_name(move)
    if end_time is None:
        return None
    for candidate in moves:
        if abs((_number(candidate.get("StartTime")) or float("inf")) - end_time) > TIME_TOLERANCE:
            continue
        move_type = candidate.get("MoveType")
        stations = (
            _values(candidate, "SrcStationList") if move_type == PICK_MOVE
            else _values(candidate, "DestStationList") if move_type == PLACE_MOVE
            else _values(candidate, "StationList") if move_type == SWAP_MOVE
            else []
        )
        if station_name in {str(value) for value in stations}:
            return candidate
    return None


def _required_environment(state: MachineState, station: LoadLockState, move: Mapping[str, Any], related: Optional[Mapping[str, Any]]) -> Optional[str]:
    """从关联机器人和协议枚举推导 LoadLock 开门侧。

    RelatedRobotType 是机器人的全局分类，无法表达 VTR_1 在 LA 中位于真空侧、
    在 UBR/DBR 中又位于抽气来源侧的串联真空腔结构；因此优先用当前 LoadLock
    的 PrePrepareTime 映射解析关联机器人，旧设备没有映射时再退回全局分类。
    """
    if related is not None:
        robot = state.resolve_robot(str(related.get("Robot") or related.get("ModuleName") or ""))
        if robot is not None:
            configured = _environment_state(station, robot.name)
            if configured in {ATMOSPHERE, VACUUM}:
                return configured
    related_type = move.get("RelatedRobotType")
    if related_type == 0:
        return ATMOSPHERE
    if related_type == 1:
        return VACUUM
    if related is None:
        return None
    robot = state.resolve_robot(str(related.get("Robot") or related.get("ModuleName") or ""))
    if robot is None:
        return None
    upper_name = robot.name.upper()
    if "ATM" in upper_name or "ATR" in upper_name:
        return ATMOSPHERE
    if "VAC" in upper_name or "VTR" in upper_name:
        return VACUUM
    return ATMOSPHERE if any(
        state.stations.get(name) and state.stations[name].station_type.lower() == LOAD_PORT_TYPE
        for name in robot.scope
    ) else VACUUM


def _initial_payload(init_data: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    """拆开标准接口的可选 Info/InitData 外壳。"""
    if not isinstance(init_data, Mapping):
        return {}
    value: Any = init_data
    if isinstance(value.get("Info"), Mapping):
        value = value["Info"]
    if isinstance(value.get("InitData"), Mapping):
        value = value["InitData"]
    return value


def _mapping(value: Any) -> Mapping[str, Mapping[str, Any]]:
    """把接口对象收敛为字符串键配置映射。"""
    if not isinstance(value, Mapping):
        return {}
    return {str(name): config for name, config in value.items() if isinstance(config, Mapping)}


def _station_slot_ids(config: Mapping[str, Any], task_station: Any) -> Set[int]:
    """从显式槽位或 Capacity 解析一基物理槽位。"""
    raw_slots = config.get("Slots")
    if isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
        slots = {_positive_integer(value) for value in raw_slots}
        slots.discard(None)
        if slots:
            return {int(value) for value in slots}
    capacity = _positive_integer(config.get("Capacity"))
    if capacity is None:
        capacity = _positive_integer(getattr(task_station, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    return set(range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID))


def _station_slot_material_count(config: Mapping[str, Any], slot_id: int) -> int:
    """读取 Station.MaterialCount 中指定槽位的累计加工次数。"""
    raw_counts = config.get("MaterialCount")
    if not isinstance(raw_counts, Mapping):
        return 0
    raw_count = raw_counts.get(slot_id, raw_counts.get(str(slot_id), 0))
    count = _number(raw_count)
    if count is None or count < 0:
        return 0
    return int(count)


def _station_from_task(name: str, task_station: Any) -> StationState:
    """用解析任务补建标准 update 中缺失的站点。"""
    station_type = str(getattr(task_station, "type", ""))
    capacity = _positive_integer(getattr(task_station, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    slots = {slot_id: SlotState() for slot_id in range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID)}
    if station_type.lower() == LOAD_LOCK_TYPE:
        return LoadLockState(name, station_type, slots)
    return StationState(name, station_type, slots)


def _slot_station_entries(entries: Any) -> Set[Tuple[str, int]]:
    """解析 SlotsStationMap 中一个手槽的候选列表 [{Key, Value}...]。"""
    candidates: Set[Tuple[str, int]] = set()
    if not isinstance(entries, Sequence) or isinstance(entries, (str, bytes)):
        return candidates
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        station_name = str(entry.get("Key") or "").strip()
        station_slot = _positive_integer(entry.get("Value"))
        if station_name and station_slot is not None:
            candidates.add((station_name, station_slot))
    return candidates


def _robot_from_config(name: str, config: Mapping[str, Any], task_robot: Any) -> RobotState:
    """保留 ArmInfo 中每个启用 Arm 的全部物理手槽，并解析槽位级指向拓扑。"""
    hands: Dict[int, Optional[MaterialState]] = {}
    scope: Set[str] = set()
    positions: Set[str] = set()
    slot_map: Dict[int, Dict[str, Set[Tuple[str, int]]]] = {}
    arm_slots: Dict[str, Set[int]] = {}
    for arm in _mapping(config.get("ArmInfo")).values():
        if arm.get("IsEnable") is False:
            continue
        arm_slot_ids: Set[int] = set()
        for slot_id in arm.get("SlotIDs") or ():
            normalized = _positive_integer(slot_id)
            if normalized is not None:
                hands[normalized] = None
                arm_slot_ids.add(normalized)
        if arm_slot_ids:
            arm_slots[str(arm.get("Name") or "")] = arm_slot_ids
        scope.update(str(station) for station in arm.get("AccessibleStations") or () if station)
        if arm.get("SlotAtStation"):
            positions.add(str(arm["SlotAtStation"]))
        raw_map = arm.get("SlotsStationMap")
        if not isinstance(raw_map, Mapping):
            continue
        for group_name, group_slots in raw_map.items():
            if not isinstance(group_slots, Mapping):
                continue
            for raw_slot, entries in group_slots.items():
                slot_id = _positive_integer(raw_slot)
                if slot_id is None:
                    continue
                candidates = _slot_station_entries(entries)
                if candidates:
                    slot_map.setdefault(slot_id, {})[str(group_name)] = candidates
    explicit_slots = _configured_robot_slots(config)
    configured_capacity = _positive_integer(config.get("Capacity")) or len(hands) or DEFAULT_SLOT_ID
    task_capacity = _positive_integer(getattr(task_robot, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    if explicit_slots is not None:
        hands = {slot_id: hands.get(slot_id) for slot_id in sorted(explicit_slots)}
        capacity = len(hands)
    else:
        capacity = max(configured_capacity, task_capacity)
        for slot_id in range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID):
            hands.setdefault(slot_id, None)
    scope.update(str(station) for station in getattr(task_robot, "scope", ()) or () if station)
    position = next(iter(positions)) if len(positions) == 1 else None
    slot_targets, slot_options = _initial_slot_alignment(hands, slot_map, position)
    return RobotState(
        name=name,
        hands=hands,
        scope=scope,
        position=position,
        slot_targets=slot_targets,
        slot_options=slot_options,
        slot_map=slot_map,
        arm_slots=arm_slots,
        can_swap=(bool(config.get("CanMultiTrans")) or bool(getattr(task_robot, "can_swap", False)) or len(hands) >= 2) and len(hands) >= 2,
    )


def _slot_map_group_stations(slot_map: Mapping[int, Mapping[str, Set[Tuple[str, int]]]]) -> Dict[str, Set[str]]:
    """汇总 SlotsStationMap 各站组覆盖的站名集合。"""
    group_stations: Dict[str, Set[str]] = {}
    for groups in slot_map.values():
        for group_name, candidates in groups.items():
            stations = group_stations.setdefault(group_name, set())
            stations.update(station for station, _ in candidates)
    return group_stations


def _initial_slot_alignment(
    hands: Mapping[int, Optional[MaterialState]],
    slot_map: Mapping[int, Mapping[str, Set[Tuple[str, int]]]],
    slot_at_station: Optional[str],
) -> Tuple[Dict[int, Optional[Tuple[str, int]]], Dict[int, Set[Tuple[str, int]]]]:
    """按 SlotAtStation 站名反查站组，初始化各手槽的精确指向与候选集。"""
    targets: Dict[int, Optional[Tuple[str, int]]] = {}
    options: Dict[int, Set[Tuple[str, int]]] = {}
    if not slot_map or not slot_at_station:
        return targets, options
    target_group = next(
        (group for group, stations in _slot_map_group_stations(slot_map).items() if slot_at_station in stations),
        None,
    )
    if target_group is None:
        return targets, options
    for slot_id in hands:
        groups = slot_map.get(slot_id)
        candidates = groups.get(target_group) if groups else None
        if not candidates:
            continue
        options[slot_id] = set(candidates)
        targets[slot_id] = next(iter(sorted(candidates)))
    return targets, options


def _configured_robot_slots(config: Mapping[str, Any]) -> Optional[Set[int]]:
    """读取运行快照显式限制的 Robot.Slot；字段缺失时返回 None。"""
    if "Slot" not in config:
        return None
    raw_slots = config.get("Slot")
    if isinstance(raw_slots, Mapping):
        candidates: Iterable[Any] = raw_slots.keys()
    elif isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
        candidates = raw_slots
    else:
        count = _positive_integer(raw_slots) or DEFAULT_SLOT_ID
        return set(range(DEFAULT_SLOT_ID, count + DEFAULT_SLOT_ID))
    slots = {_positive_integer(value) for value in candidates}
    slots.discard(None)
    return {int(value) for value in slots} or {DEFAULT_SLOT_ID}


def _robot_from_task(name: str, task_robot: Any) -> RobotState:
    """用解析任务补建标准 update 中缺失的机器人。"""
    capacity = _positive_integer(getattr(task_robot, "capacity", DEFAULT_SLOT_ID)) or DEFAULT_SLOT_ID
    return RobotState(
        name=name,
        hands={slot_id: None for slot_id in range(DEFAULT_SLOT_ID, capacity + DEFAULT_SLOT_ID)},
        scope={str(station) for station in getattr(task_robot, "scope", ()) or ()},
        can_swap=bool(getattr(task_robot, "can_swap", False)) and capacity >= 2,
    )


def _environment_aliases(config: Mapping[str, Any]) -> Dict[str, str]:
    """从 PrePrepareTime 建立设备标签与标准压力态映射。"""
    aliases: Dict[str, str] = {}
    transitions = config.get("PrePrepareTime")
    if not isinstance(transitions, Sequence) or isinstance(transitions, (str, bytes)):
        return aliases
    for transition in transitions:
        if not isinstance(transition, Mapping):
            continue
        transition_type = str(transition.get("PrePrepareType") or "").strip().lower()
        if transition_type.startswith("pump"):
            last_environment, current_environment = ATMOSPHERE, VACUUM
        elif transition_type.startswith("vent"):
            last_environment, current_environment = VACUUM, ATMOSPHERE
        else:
            continue
        for key, environment in (("LastItem", last_environment), ("CurrentItem", current_environment)):
            alias = str(transition.get(key) or "").strip().upper()
            if alias:
                aliases[alias] = environment
    return aliases


def _environment_state_space(config: Mapping[str, Any]) -> frozenset[str]:
    """从 ``PrePrepareTime`` 提取该 LoadLock 的合法状态标签集合（归一化大写）。

    只统计 pump/vent 压力切换条目的 ``LastItem/CurrentItem``；``PrePrepareTime``
    缺失或为空时返回空集，由调用方退回“可解析为标准压力态”的宽松校验。
    """
    labels: Set[str] = set()
    transitions = config.get("PrePrepareTime")
    if not isinstance(transitions, Sequence) or isinstance(transitions, (str, bytes)):
        return frozenset()
    for transition in transitions:
        if not isinstance(transition, Mapping):
            continue
        transition_type = str(transition.get("PrePrepareType") or "").strip().lower()
        if not (transition_type.startswith("pump") or transition_type.startswith("vent")):
            continue
        for key in ("LastItem", "CurrentItem"):
            alias = str(transition.get(key) or "").strip().upper()
            if alias:
                labels.add(alias)
    return frozenset(labels)


def _station_state_variables(config: Mapping[str, Any]) -> Dict[str, float]:
    """读取站点 StateVariables 中可按数值累计的当前值。"""
    result: Dict[str, float] = {}
    variables = config.get("StateVariables") or {}
    if not isinstance(variables, Mapping):
        return result
    for variable_name, variable in variables.items():
        if not isinstance(variable, Mapping):
            continue
        value = variable.get("Value") or {}
        raw_value = value.get("Value") if isinstance(value, Mapping) else None
        number = _number(raw_value)
        if number is not None:
            result[str(variable_name)] = number
    return result


def _process_recipe_weights(payload: Mapping[str, Any]) -> Dict[Tuple[str, str], Dict[str, float]]:
    """按 ``(ModuleName, RecipeName)`` 索引 Counter 状态变量增量。"""
    result: Dict[Tuple[str, str], Dict[str, float]] = {}
    recipes = payload.get("ProcessRecipes") or []
    if not isinstance(recipes, Sequence) or isinstance(recipes, (str, bytes)):
        return result
    for recipe in recipes:
        if not isinstance(recipe, Mapping):
            continue
        station_name = str(recipe.get("ModuleName") or "")
        recipe_name = str(recipe.get("Name") or "")
        raw_weights = recipe.get("Weight") or {}
        if not isinstance(raw_weights, Mapping):
            continue
        weights: Dict[str, float] = {}
        for variable_name, raw_increment in raw_weights.items():
            increment = _number(raw_increment)
            if increment is not None:
                weights[str(variable_name)] = increment
        if station_name and recipe_name and weights:
            result[(station_name, recipe_name)] = weights
    return result


def _clean_task_state_variables(payload: Mapping[str, Any]) -> Dict[str, Set[str]]:
    """递归收集 CleanTask 完成后需要归零的状态变量。"""
    result: Dict[str, Set[str]] = {}

    def visit(value: Any) -> None:
        """遍历标准 Update 中嵌套的 Route 与 CleanCondition 对象。"""
        if isinstance(value, Mapping):
            task_name = str(value.get("TaskName") or "")
            raw_variables = value.get("UpdateStateVariables")
            if task_name and isinstance(raw_variables, Sequence) and not isinstance(raw_variables, (str, bytes)):
                result.setdefault(task_name, set()).update(
                    str(variable_name)
                    for variable_name in raw_variables
                    if str(variable_name)
                )
            for child in value.values():
                visit(child)
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            for child in value:
                visit(child)

    visit(payload.get("ProcessJobs") or [])
    return result


def _clean_wac_trigger_rules(
    payload: Mapping[str, Any],
) -> Dict[Tuple[str, str], Tuple[Tuple[str, str, float, str], ...]]:
    """读取按腔室和工艺 Recipe 生效的 WAC 计数阈值。

    标准 update 把 WAC 条件放在 ``ProcessJobs[].OriginRoute`` 的
    ``AfterOutPM`` 中，而状态值放在 ``Stations[].StateVariables`` 中。将两者
    在初始化时按 ``(PJobName, ModuleName, ProcessRecipe)`` 关联，校验器就能
    在产品 ``ProcessMove`` 开始前判断清洁是否已经到期。
    """
    result: Dict[Tuple[str, str], List[Tuple[str, str, float, str]]] = {}

    def rows(value: Any) -> Sequence[Any]:
        """把标准接口中可能是数组或对象的集合统一为可遍历序列。"""
        if isinstance(value, Mapping):
            return tuple(value.values())
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            return value
        return ()

    def number(value: Any) -> Optional[float]:
        """读取有限的数值阈值，忽略不完整的条件。"""
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        return parsed if math.isfinite(parsed) else None

    for process_job in rows(payload.get("ProcessJobs") or []):
        if not isinstance(process_job, Mapping):
            continue
        pjob_name = str(process_job.get("JobName") or "").strip()
        route = process_job.get("OriginRoute") or process_job.get("Route") or {}
        if not isinstance(route, Mapping):
            continue
        for step in rows(route.get("RouteSteps") or []):
            if not isinstance(step, Mapping):
                continue
            for visit in rows(step.get("Visits") or []):
                if not isinstance(visit, Mapping):
                    continue
                station_name = str(
                    visit.get("StationName") or visit.get("ModuleName") or ""
                ).strip()
                recipe_name = str(
                    visit.get("ProcessRecipe") or visit.get("RecipeName") or ""
                ).strip()
                if not station_name:
                    continue
                for after_clean in rows(visit.get("AfterOutPM") or []):
                    if not isinstance(after_clean, Mapping):
                        continue
                    conditions = after_clean.get("CheckConditions") or {}
                    execute_orders = rows(after_clean.get("ExecuteOrder") or [])
                    if not isinstance(conditions, Mapping):
                        continue
                    for _clean_alias, clean_rows in conditions.items():
                        for clean in rows(clean_rows):
                            if not isinstance(clean, Mapping):
                                continue
                            clean_task_name = str(clean.get("TaskName") or "").strip()
                            if "wac" not in clean_task_name.casefold():
                                continue
                            update_variables = {
                                str(name).strip()
                                for name in (clean.get("UpdateStateVariables") or [])
                                if str(name).strip()
                            }
                            for execute in execute_orders:
                                if not isinstance(execute, Mapping):
                                    continue
                                variable_name = str(
                                    execute.get("StateVariableName") or ""
                                ).strip()
                                if not variable_name or (
                                    update_variables
                                    and variable_name not in update_variables
                                ):
                                    continue
                                thresholds = rows(
                                    execute.get("ThresholdValueList") or []
                                )
                                lower = number(thresholds[0]) if thresholds else None
                                if lower is None:
                                    continue
                                key = (station_name, recipe_name)
                                rule = (
                                    pjob_name,
                                    variable_name,
                                    lower,
                                    clean_task_name,
                                )
                                if rule not in result.setdefault(key, []):
                                    result[key].append(rule)
    return {key: tuple(rules) for key, rules in result.items()}


def _wac_rules_for_clean_move(
    state: MachineState,
    station_name: str,
    pjob_names: Set[str],
    clean_task_name: str,
) -> Tuple[Tuple[str, str, float, str], ...]:
    """反查当前无片 WAC 清洁对应的产品工艺阈值规则。

    WAC 条件由产品 Recipe 索引，而无片清洁 Move 仅携带 CleanTaskName；因此按
    PM、PJob 和任务名关联。对多个 Route Visit 的重复规则去重，保证一个非法
    清洁 Move 只生成一条稳定诊断。
    """
    matched: List[Tuple[str, str, float, str]] = []
    for (rule_station_name, _recipe_name), rules in (
        state.clean_wac_trigger_rules.items()
    ):
        if rule_station_name != station_name:
            continue
        for rule in rules:
            rule_pjob_name, _variable_name, _lower, rule_task_name = rule
            if rule_task_name != clean_task_name:
                continue
            if rule_pjob_name and rule_pjob_name not in pjob_names:
                continue
            if rule not in matched:
                matched.append(rule)
    return tuple(matched)


def _clean_obligation_specs(
    payload: Mapping[str, Any],
) -> Dict[Tuple[str, str, str], Tuple[str, int, Tuple[str, ...]]]:
    """解析各 PJob/PM 的 Pre、Post 与带片 Dummy 清洁义务。

    返回值为 ``(PJob, PM, TaskName) -> (阶段, MaterialCount, Recipe)``。平台状态机
    只保存这个标准接口语义，不依赖 alg 编译后的 Problem 或动作对象。
    """
    result: Dict[Tuple[str, str, str], Tuple[str, int, Tuple[str, ...]]] = {}

    def rows(value: Any) -> Sequence[Any]:
        if isinstance(value, Mapping):
            return tuple(value.values())
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            return value
        return ()

    for process_job in rows(payload.get("ProcessJobs") or []):
        if not isinstance(process_job, Mapping):
            continue
        pjob_name = str(process_job.get("JobName") or "").strip()
        route = process_job.get("OriginRoute") or process_job.get("Route") or {}
        if not pjob_name or not isinstance(route, Mapping):
            continue
        for phase, field_name in (("pre", "PrePJob"), ("post", "PostPJob")):
            by_station = route.get(field_name) or {}
            if not isinstance(by_station, Mapping):
                continue
            for station_name, conditions in by_station.items():
                for condition in rows(conditions):
                    if not isinstance(condition, Mapping):
                        continue
                    checks = condition.get("CheckConditions") or {}
                    if not isinstance(checks, Mapping):
                        continue
                    for check_rows in checks.values():
                        for check in rows(check_rows):
                            if not isinstance(check, Mapping):
                                continue
                            task_name = str(check.get("TaskName") or "").strip()
                            if not task_name:
                                continue
                            try:
                                material_count = int(float(check.get("MaterialCount") or 0))
                            except (TypeError, ValueError):
                                material_count = 0
                            recipes = tuple(
                                recipe_name
                                for recipe_name in (
                                    str(check.get("CleanRecipe") or "").strip(),
                                    str(check.get("EmptyCleanRecipeAfterMaterial") or "").strip(),
                                )
                                if recipe_name
                            )
                            result[(pjob_name, str(station_name), task_name)] = (
                                phase,
                                max(0, material_count),
                                recipes,
                            )
        # 周期 WAC 位于具体 Visit 的 AfterOutPM，不属于 Route 顶层 Pre/Post；
        # 同样纳入任务元数据，供动作 Recipe 校验和类型识别使用，但不形成
        # PJob 前后义务。
        for step in rows(route.get("RouteSteps") or []):
            if not isinstance(step, Mapping):
                continue
            for visit in rows(step.get("Visits") or []):
                if not isinstance(visit, Mapping):
                    continue
                station_name = str(
                    visit.get("StationName") or visit.get("ModuleName") or ""
                ).strip()
                if not station_name:
                    continue
                for condition in rows(visit.get("AfterOutPM") or []):
                    if not isinstance(condition, Mapping):
                        continue
                    checks = condition.get("CheckConditions") or {}
                    if not isinstance(checks, Mapping):
                        continue
                    for check_rows in checks.values():
                        for check in rows(check_rows):
                            if not isinstance(check, Mapping):
                                continue
                            task_name = str(check.get("TaskName") or "").strip()
                            if not task_name:
                                continue
                            recipes = tuple(
                                recipe_name
                                for recipe_name in (
                                    str(check.get("CleanRecipe") or "").strip(),
                                    str(check.get("EmptyCleanRecipeAfterMaterial") or "").strip(),
                                )
                                if recipe_name
                            )
                            result.setdefault(
                                (pjob_name, station_name, task_name),
                                ("wac", 0, recipes),
                            )
    return result


def _missing_pre_clean_obligation(
    state: MachineState,
    pjob_name: str,
    station_name: str,
) -> Optional[Tuple[str, int, int, bool]]:
    """检查未被跳过的 PJob 前空腔或带片清洁是否已经完成。"""
    for (required_pjob, required_station, task_name), (phase, required_count, _recipe) in (
        state.clean_obligations.items()
    ):
        if phase != "pre" or required_pjob != pjob_name or required_station != station_name:
            continue
        clean_key = (required_pjob, required_station, task_name)
        actual_count = state.completed_clean_counts.get(clean_key, 0)
        expected_count = max(1, required_count)
        clean_type = _clean_validation_type(
            task_name,
            material_count=expected_count if required_count > 0 else 0,
        )
        if (
            actual_count < expected_count
            and clean_type not in state.skipped_clean_validation_types
        ):
            return task_name, expected_count, actual_count, required_count > 0
    return None


def _clean_validation_type(task_name: str, *, material_count: int = 0) -> str:
    """由标准 CleanTask 名称和带片要求还原页面中的 Clean 类型。"""
    normalized = task_name.casefold().replace("-", "").replace("_", "")
    if "wac" in normalized and (
        "dummy" in normalized or normalized.startswith("prewac")
    ):
        return "dummywac"
    if material_count > 0 or "dummy" in normalized:
        return "dummy"
    if "wac" in normalized:
        return "wacclean"
    if "post" in normalized:
        return "postclean"
    return "preclean"


def _validate_clean_start(
    state: MachineState,
    station: StationState,
    move: Mapping[str, Any],
    material_ids: Sequence[Any],
    clean_task_name: str,
) -> Optional[str]:
    """校验 Clean 动作本身，并按运行设置检查触发与次数义务。"""
    def skipped(clean_type: str) -> bool:
        """判断平台校验是否跳过指定 Clean 类型的触发策略。"""
        return clean_type in state.skipped_clean_validation_types

    pjob_names = _values(move, "PJobName")
    pjob_name = str(pjob_names[0]) if pjob_names else ""
    if material_ids and not clean_task_name:
        recipe_name = str(move.get("ProcessRecipe") or move.get("RecipeName") or "").strip()
        rules = state.clean_wac_trigger_rules.get((station.name, recipe_name), ()) or state.clean_wac_trigger_rules.get((station.name, ""), ())
        for rule_pjob_name, variable_name, lower, task_name in rules:
            if rule_pjob_name and rule_pjob_name != pjob_name:
                continue
            value = float(station.state_variables.get(variable_name, 0.0))
            if value + TIME_TOLERANCE >= lower and not skipped(
                _clean_validation_type(task_name)
            ):
                shown = str(int(value)) if value.is_integer() else str(value)
                return _issue(move, ValidationErrorCode.CLEAN_WAC_MISSING, f"{task_name} 到期后仍开始产品工艺 count={shown} PJob={pjob_name}")
        if (pjob_name, station.name) not in state.product_clean_entries:
            missing = _missing_pre_clean_obligation(state, pjob_name, station.name)
            if missing is not None:
                task_name, required, actual, is_dummy = missing
                code = ValidationErrorCode.CLEAN_DUMMY_MISSING if is_dummy else ValidationErrorCode.CLEAN_PRE_MISSING
                return _issue(move, code, f"{task_name} 未完成就开始产品工艺 required={required} actual={actual} PJob={pjob_name}")
        return None
    if clean_task_name:
        recipe_name = str(move.get("ProcessRecipe") or move.get("CleanRecipe") or "").strip()
        selected_pjobs = {str(name) for name in pjob_names}
        for (required_pjob, required_station, task_name), requirement in state.clean_obligations.items():
            if (
                required_station == station.name
                and task_name == clean_task_name
                and (not selected_pjobs or required_pjob in selected_pjobs)
                and requirement[2]
                and recipe_name not in requirement[2]
            ):
                return _issue(move, ValidationErrorCode.CLEAN_RECIPE_INVALID, f"{clean_task_name} Recipe={recipe_name or '<empty>'}，期望 {list(requirement[2])} PJob={required_pjob}")
    if not clean_task_name or "wac" not in clean_task_name.casefold() or skipped(
        _clean_validation_type(clean_task_name)
    ):
        return None
    names = {str(name).strip() for name in pjob_names if str(name).strip()}
    for _pjob, variable_name, lower, task_name in _wac_rules_for_clean_move(state, station.name, names, clean_task_name):
        value = float(station.state_variables.get(variable_name, 0.0))
        if value + TIME_TOLERANCE < lower:
            shown = str(int(value)) if value.is_integer() else str(value)
            return _issue(move, ValidationErrorCode.CLEAN_WAC_EARLY, f"{task_name} 未达到 Wac 阈值就执行 count={shown} PJob={next(iter(sorted(names)), '')}")
    return None


def _final_clean_obligation_issue(state: MachineState) -> Optional[str]:
    """在当前代计划回放完成后验证已加工 PJob 的 PostClean 义务。"""
    for (pjob_name, station_name, task_name), (phase, required_count, _recipe) in state.clean_obligations.items():
        if phase != "post" or "postclean" in state.skipped_clean_validation_types or (pjob_name, station_name) not in state.product_clean_entries:
            continue
        actual_count = state.completed_clean_counts.get((pjob_name, station_name, task_name), 0)
        expected_count = max(1, required_count)
        if actual_count < expected_count:
            return f"[{ValidationErrorCode.CLEAN_POST_MISSING.value}] {task_name} 未完成 required={expected_count} actual={actual_count} PJob={pjob_name} PM={station_name}"
    return None


def _environment_side_labels(aliases: Mapping[str, str]) -> Tuple[str, str]:
    """由 LoadLock 的“标签→标准压力态”映射反推输出侧名称。

    每侧存在多个候选标签时按名称排序取第一个；未声明标签时回退标准压力态。
    """
    by_environment: Dict[str, List[str]] = {}
    for alias, environment in dict(aliases or {}).items():
        by_environment.setdefault(str(environment), []).append(str(alias))
    atmosphere = sorted(by_environment.get(ATMOSPHERE, ()))
    vacuum = sorted(by_environment.get(VACUUM, ()))
    return (
        atmosphere[0] if atmosphere else ATMOSPHERE,
        vacuum[0] if vacuum else VACUUM,
    )


def _environment_label(station: StationState, environment: str) -> str:
    """把标准压力态映射回该 LoadLock 的配置标签（无配置时保持标准态）。"""
    atmosphere_label, vacuum_label = _environment_side_labels(
        getattr(station, "environment_aliases", {})
    )
    if environment == ATMOSPHERE:
        return atmosphere_label
    if environment == VACUUM:
        return vacuum_label
    return environment


def _environment_from_last_item(last_item: str, aliases: Mapping[str, str]) -> str:
    """由最近访问侧推导 LoadLock 初始压力态。"""
    normalized = last_item.strip().upper()
    if aliases.get(normalized) in {ATMOSPHERE, VACUUM}:
        return aliases[normalized]
    return VACUUM if "VAC" in normalized or "VTR" in normalized else ATMOSPHERE


def _environment_state(station: LoadLockState, value: Any) -> str:
    """把标准值、机器人侧名称或设备标签统一成 ATM/VAC。"""
    raw = str(value or "").strip().upper()
    if raw in {ATMOSPHERE, "ATR", "ATMROBOT"}:
        return ATMOSPHERE
    if raw in {VACUUM, "VTR", "VACROBOT"}:
        return VACUUM
    configured = station.environment_aliases.get(raw)
    if configured in {ATMOSPHERE, VACUUM}:
        return configured
    # PrePrepareTime 未声明的设备标签按手类型启发式归类：级联 LoadLock 只配置
    # VTR_1/VTR_2 两侧，但首个抽真空可从大气手 ATR_1 起始（对应 State=0/LastItem=""）。
    if "VAC" in raw or "VTR" in raw:
        return VACUUM
    if "ATM" in raw or "ATR" in raw:
        return ATMOSPHERE
    return raw


def _initial_materials(task: Any, payload: Mapping[str, Any]) -> Iterable[Tuple[str, int, MaterialState]]:
    """优先读取 update.Materials，否则从解析任务恢复首工序物料。"""
    materials = payload.get("Materials")
    if isinstance(materials, Sequence) and not isinstance(materials, (str, bytes)):
        loaded = [
            (
                str(entry.get("CurrentModuleName") or ""),
                _positive_integer(entry.get("SlotID")) or DEFAULT_SLOT_ID,
                MaterialState(entry.get("ID"), str(entry.get("PJobName") or ""), entry.get("StepID")),
            )
            for entry in materials
            if isinstance(entry, Mapping) and entry.get("CurrentModuleName") and entry.get("ID") is not None
        ]
        if loaded:
            return loaded
    return [
        (
            str(stages[0].chamber),
            int(getattr(stages[0], "slot", 0) or 0) + 1,
            MaterialState(getattr(wafer, "mat_id", None), str(getattr(wafer, "pjob_name", "") or ""), getattr(stages[0], "j", None)),
        )
        for wafer in getattr(task, "wafers", ()) or ()
        for stages in [list(getattr(wafer, "stages", ()) or ())]
        if stages and getattr(wafer, "mat_id", None) is not None and getattr(stages[0], "chamber", "")
    ]


def _values(move: Mapping[str, Any], key: str) -> List[Any]:
    """读取标准并行数组，并兼容物料单值字段。"""
    value = move.get(key)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return list(value)
    if key == "MatIDList":
        scalar = move.get("MatID", move.get("MaterialID"))
        return [] if scalar is None else [scalar]
    return [] if value is None else [value]


def _integer_values(move: Mapping[str, Any], key: str) -> List[int]:
    """读取动作中的正整数槽位数组。"""
    result = []
    for value in _values(move, key):
        normalized = _positive_integer(value)
        if normalized is not None:
            result.append(normalized)
    return result


def _positive_integer(value: Any) -> Optional[int]:
    """把正整数协议值规范为 int，非法值返回 None。"""
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= DEFAULT_SLOT_ID and float(value) == number else None


def _number(value: Any) -> Optional[float]:
    """读取有限数值，非法值返回 None。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _sort_key(move: Mapping[str, Any]) -> Tuple[float, int, float]:
    """生成 MoveList 的稳定时间排序键。"""
    return (
        _number(move.get("StartTime")) or 0.0,
        int(move.get("MoveID")) if isinstance(move.get("MoveID"), int) else 0,
        _number(move.get("EndTime")) or 0.0,
    )


def _notification_state(notification: Mapping[str, Any]) -> int:
    """把数字或字符串 MoveState 统一成协议枚举。"""
    raw = notification.get("MoveState", notification.get("State"))
    if isinstance(raw, int) and raw in {MoveStateReplay.RUNNING, MoveStateReplay.DONE, MoveStateReplay.ABORTED}:
        return raw
    names = {
        "running": MoveStateReplay.RUNNING,
        "start": MoveStateReplay.RUNNING,
        "done": MoveStateReplay.DONE,
        "finished": MoveStateReplay.DONE,
        "end": MoveStateReplay.DONE,
        "aborted": MoveStateReplay.ABORTED,
        "abort": MoveStateReplay.ABORTED,
    }
    normalized = str(raw or "").strip().lower()
    if normalized not in names:
        raise ValueError(f"不支持 MoveState={raw}")
    return names[normalized]


def _robot(state: MachineState, move: Mapping[str, Any]) -> "RobotState | str":
    """读取动作引用的机器人，缺失时返回统一错误。"""
    name = str(move.get("Robot") or move.get("ModuleName") or "")
    robot = state.resolve_robot(name)
    return robot if robot is not None else _issue(
        move,
        ValidationErrorCode.ROBOT_UNKNOWN,
        f"未知机器人 {name or '<empty>'}",
    )


def _station_name(move: Mapping[str, Any]) -> str:
    """读取非运输动作使用的站点名。"""
    return str(move.get("Station") or move.get("ModuleName") or _first_text(move, "StationList") or "")


def _first_text(move: Mapping[str, Any], key: str) -> str:
    """返回协议数组的第一个非空文本值。"""
    values = _values(move, key)
    return str(values[0]) if values and values[0] is not None else ""


def _start_time(move: Mapping[str, Any]) -> float:
    """返回动作开始时刻，非法值按零处理。"""
    return _number(move.get("StartTime")) or 0.0


def _material_matches(material: Optional[MaterialState], material_id: Any) -> bool:
    """用字符串兼容数字/文本物料编号。"""
    return material is not None and str(material.material_id) == str(material_id)


def _material_with_metadata(material: Optional[MaterialState], move: Mapping[str, Any], index: int, step_key: str = "StepIDList") -> MaterialState:
    """复制物料并按并行下标写入 PJob/Step 元数据。"""
    if material is None:
        raise ValueError("状态转移缺少物料")
    step_ids = _values(move, step_key)
    pjob_names = _values(move, "PJobNameList")
    return MaterialState(
        material.material_id,
        str(pjob_names[index]) if index < len(pjob_names) else material.pjob_name,
        step_ids[index] if index < len(step_ids) else material.step_id,
    )


def _is_doorless(station: StationState) -> bool:
    """返回站点是否不产生物理开关门动作。"""
    return (
        station.station_type.lower() == LOAD_PORT_TYPE
        or station.name in DOORLESS_STATION_NAMES
    )


def _has_active_process(station: StationState, timestamp: float) -> bool:
    """返回站点是否还有未结束的加工或清洁。"""
    return any(
        slot.busy_action in {"加工", "清洁", "对准"} and not _available(slot.busy_until, timestamp)
        for slot in station.slots.values()
    )


def _available(busy_until: float, timestamp: float) -> bool:
    """按统一容差判断资源在指定时刻是否可用。"""
    return float(busy_until) <= float(timestamp) + TIME_TOLERANCE


def _reserve_slot(slot: SlotState, end_time: float, action: str) -> None:
    """占用一个物理槽位到动作结束。"""
    slot.busy_until = end_time
    slot.busy_action = action


def _set_slot(slot: SlotState, phase: SlotPhase, material: Optional[MaterialState]) -> None:
    """写入槽位稳定状态并清除动作标签。"""
    slot.phase = phase
    slot.material = material
    slot.busy_action = ""


def _schedule(scheduled: List[_ScheduledCompletion], move: Mapping[str, Any], end_time: float, complete: Callable[[], None]) -> None:
    """登记动作结束回调。"""
    move_id = move.get("MoveID")
    scheduled.append(_ScheduledCompletion(end_time, int(move_id) if isinstance(move_id, int) else -1, complete))


def _finish_until(scheduled: List[_ScheduledCompletion], timestamp: float) -> None:
    """按结束时间落地指定时刻之前完成的动作。"""
    ready = sorted(
        (item for item in scheduled if item.end_time <= timestamp + TIME_TOLERANCE),
        key=lambda item: (item.end_time, item.move_id),
    )
    for item in ready:
        item.complete()
        scheduled.remove(item)


def _global_issue(error_code: ValidationErrorCode, message: str) -> str:
    """生成不绑定具体 Move 的稳定错误文本。"""
    return f"[{error_code.value}] {message}"


def _issue(
    move: Mapping[str, Any],
    error_code: ValidationErrorCode,
    message: str,
) -> str:
    """生成包含错误码、MoveID 和动作类型的稳定错误文本。"""
    return (
        f"[{error_code.value}] MoveID={move.get('MoveID', '?')} "
        f"MoveType={move.get('MoveType', '?')}：{message}"
    )


__all__ = [
    name for name in globals()
    if name.startswith("_") and not name.startswith("__")
]
