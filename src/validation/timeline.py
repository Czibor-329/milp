"""按时间轴推进的 MoveList 状态校验。

本模块实现文档中的主校验流程：按 StartTime/EndTime/MoveID 扫描 MoveList，
在扫描当前 move 前维护 active/enable 状态表，随后按 check_attr、check_topo、
check_enable 三段校验当前 move，并维护轻量的材料位置、机器人槽位和模块状态。
拓扑与时长的静态校验仍由 `raw_topology.py` 负责。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from src.model import Problem
from src.validation.common import (
    MOVE_TYPES,
    STATION_TYPES,
    as_list,
    dest_ref,
    mat_key,
    num,
    same_mat,
    sort_key,
    source_ref,
    station_name,
    station_ref,
    station_slot_refs,
    slot_values,
)
from src.validation.raw_topology import (
    TopologyContext,
    build_topology_context,
    raw_robots,
    raw_stations,
    validate_move_topology_and_duration,
)


TIMELINE_TOLERANCE = 1e-6

StationSlot = Tuple[str, int]
RobotSlot = Tuple[str, int]
MaterialTuple = Tuple[int, ...]


@dataclass
class TimelineState:
    """时间轴扫描过程中的轻量设备状态。"""

    station_slots: Dict[StationSlot, List[int]] = field(default_factory=dict)
    trusted_station_slots: Set[StationSlot] = field(default_factory=set)
    robot_slots: Dict[RobotSlot, List[int]] = field(default_factory=dict)
    robot_positions: Dict[str, str] = field(default_factory=dict)
    station_states: Dict[str, str] = field(default_factory=dict)
    enabled_moves: Set[int] = field(default_factory=set)


@dataclass
class StaticValidationIndexes:
    """主校验循环开始前建立的静态索引。"""

    by_id: Dict[int, dict]
    duplicate_ids: Set[int]
    topology: TopologyContext


def validate_timeline(
    task: Problem,
    moves: List[dict],
    init_data: Optional[Mapping[str, Any]] = None,
) -> List[str]:
    """运行完整的时间轴 MoveList 校验，并返回所有问题。

    参数:
        task: 解析后的内部 Problem，用于读取设备和晶圆语义。
        moves: 待校验 MoveList。
        init_data: 原始接口数据。存在时用于读取初始 material、robot/station 可用时间、
            拓扑、槽位和动作时长。

    返回:
        中文问题列表。函数不修改传入的 MoveList。
    """
    issues: List[str] = []
    static = _build_static_indexes(moves, init_data)
    state = _initial_state(task, init_data)
    timeline = sorted(moves, key=sort_key)
    active_moves: List[dict] = []
    history: List[dict] = []

    for move_index, move in enumerate(timeline):
        start_time = _time(move, "StartTime")
        if start_time is not None:
            update_move_state(state, active_moves, start_time)

        field_issues = check_attr(task, move, move_index, init_data, static)
        issues.extend(field_issues)

        if not _can_validate_on_timeline(move):
            continue

        issues.extend(check_topo(move, state, active_moves, static, init_data))
        issues.extend(check_enable(move, history, state.enabled_moves, static))

        register_active_move(active_moves, move)
        history.append(move)

    update_move_state(state, active_moves, float("inf"))
    issues.extend(_validate_pressure_state(task, moves))
    return issues


def _build_static_indexes(moves: List[dict], init_data: Optional[Mapping[str, Any]]) -> StaticValidationIndexes:
    """建立 MoveID、重复 ID 和拓扑/时长上下文索引。"""
    seen_ids: Set[int] = set()
    duplicate_ids: Set[int] = set()
    by_id: Dict[int, dict] = {}
    for move in moves:
        move_id = move.get("MoveID")
        if not isinstance(move_id, int):
            continue
        if move_id in seen_ids:
            duplicate_ids.add(move_id)
            continue
        seen_ids.add(move_id)
        by_id[move_id] = move
    return StaticValidationIndexes(
        by_id=by_id,
        duplicate_ids=duplicate_ids,
        topology=build_topology_context(init_data, moves),
    )


def _can_validate_on_timeline(move: dict) -> bool:
    """判断 move 是否具备进入时间轴状态/依赖校验的最低字段条件。"""
    return (
        isinstance(move.get("MoveID"), int)
        and move.get("MoveType") in MOVE_TYPES
        and _time(move, "StartTime") is not None
        and _time(move, "EndTime") is not None
    )


def check_attr(
    task: Problem,
    move: dict,
    move_index: int,
    init_data: Optional[Mapping[str, Any]],
    static: StaticValidationIndexes,
) -> List[str]:
    """根据 Problem 和可选原始 init data 校验当前 move 的基础字段。"""
    issues: List[str] = []
    robots = raw_robots(init_data)
    stations = raw_stations(init_data)
    # 先校验所有 move 共有的身份、时间和基础列表字段。
    move_id = move.get("MoveID")
    move_type = move.get("MoveType")
    if not isinstance(move_id, int) or move_id <= 0:
        issues.append(f"ML 字段违例 idx={move_index}: MoveID 必须为正整数")
    elif move_id in static.duplicate_ids:
        issues.append(f"ML 字段违例 id={move_id}: MoveID 重复")
    if move_type not in MOVE_TYPES:
        issues.append(f"ML 字段违例 id={move_id}: MoveType 非法 {move_type}")
    start_time = num(move.get("StartTime"))
    end_time = num(move.get("EndTime"))
    if start_time is None or end_time is None:
        issues.append(f"ML 字段违例 id={move_id}: StartTime/EndTime 必须为有限数字")
    elif end_time + TIMELINE_TOLERANCE < start_time:
        issues.append(f"ML 字段违例 id={move_id}: EndTime {end_time:.6g} < StartTime {start_time:.6g}")
    if not move.get("ModuleName"):
        issues.append(f"ML 字段违例 id={move_id}: ModuleName 为空")
    previous_ids = move.get("PreMoveID", [])
    if not isinstance(move.get("PreMoveID"), list) or not all(isinstance(previous_id, int) for previous_id in previous_ids):
        issues.append(f"ML 字段违例 id={move_id}: PreMoveID 必须为整数列表")

    # 再按 MoveType 校验机器人、站点、槽位和晶圆字段的组合约束。
    if move_type in (0, 1, 4, 5):
        robot = _move_robot(move)
        robot_known = robot in robots if init_data is not None else robot in task.robots
        if not robot or not robot_known:
            issues.append(f"ML 字段违例 id={move_id}: Robot 非法 {robot}")
        if move_type != 4 and not slot_values(move, "RobotSlotList"):
            issues.append(f"ML 字段违例 id={move_id}: RobotSlotList 必须为正整数列表")
    if move_type == 0:
        if not as_list(move, "SrcStationList") or not slot_values(move, "SrcSlotList"):
            issues.append(f"ML 字段违例 id={move_id}: Pick 缺少 SrcStationList/SrcSlotList")
        if not mat_key(move):
            issues.append(f"ML 字段违例 id={move_id}: Pick 必须有非空 MatIDList")
    elif move_type == 1:
        if not as_list(move, "DestStationList") or not slot_values(move, "DestSlotList"):
            issues.append(f"ML 字段违例 id={move_id}: Place 缺少 DestStationList/DestSlotList")
        if not mat_key(move):
            issues.append(f"ML 字段违例 id={move_id}: Place 必须有非空 MatIDList")
    elif move_type == 5:
        if not as_list(move, "SrcStationList") or not as_list(move, "DestStationList"):
            issues.append(f"ML 字段违例 id={move_id}: PreTrans 缺少 SrcStationList/DestStationList")
    elif move_type == 4:
        if not as_list(move, "StationList"):
            issues.append(f"ML 字段违例 id={move_id}: Swap 缺少 StationList")
        if not slot_values(move, "StnRecvSlotList") or not slot_values(move, "StnSendSlotList"):
            issues.append(f"ML 字段违例 id={move_id}: Swap 缺少 StnRecvSlotList/StnSendSlotList")
        if not as_list(move, "RecvMatList") or not as_list(move, "SendMatList"):
            issues.append(f"ML 字段违例 id={move_id}: Swap 缺少 RecvMatList/SendMatList")
    elif move_type in STATION_TYPES:
        station = station_name(move)
        station_known = station in stations if init_data is not None else station in task.chambers
        if not station or not station_known:
            issues.append(f"ML 字段违例 id={move_id}: Station 非法 {station}")
        if move_type in {6, 9} and not slot_values(move):
            issues.append(f"ML 字段违例 id={move_id}: SlotList 必须为正整数列表")
        if move.get("Robot"):
            issues.append(f"ML 字段违例 id={move_id}: station move 不应包含 Robot")
    if move_type == 10 and _is_loadlock_pressure_move(move):
        if move.get("LastState") not in {"ATM", "VAC"} or move.get("CurState") not in {"ATM", "VAC"}:
            issues.append(f"ML 字段违例 id={move_id}: PrePrepare 压力状态必须为 ATM/VAC")
    return issues


def check_topo(
    move: dict,
    state: TimelineState,
    active_moves: List[dict],
    static: StaticValidationIndexes,
    init_data: Optional[Mapping[str, Any]],
) -> List[str]:
    """检查当前 move 的拓扑、时长、可用时间、资源占用和位置状态。"""
    issues: List[str] = []
    issues.extend(validate_move_topology_and_duration(static.topology, move))
    issues.extend(_validate_resource_overlap(move, active_moves))
    issues.extend(_validate_time_to_available(move, init_data))
    issues.extend(_validate_position_state(move, state))
    return issues


def check_enable(
    move: dict,
    history: List[dict],
    enabled_moves: Set[int],
    static: StaticValidationIndexes,
) -> List[str]:
    """检查当前 move 的必需前置是否已声明并且已经完成。"""
    issues: List[str] = []
    current_id = move.get("MoveID")
    declared = set(as_list(move, "PreMoveID"))
    for previous_move in _required_predecessors_for_move(move, history):
        previous_id = previous_move.get("MoveID")
        if not isinstance(previous_id, int):
            continue
        if previous_id not in declared:
            issues.append(f"ML PreMoveID 不完整 id={current_id}: 缺少 [{previous_id}]")
        elif previous_id not in enabled_moves:
            issues.append(f"ML PreMoveID 必需前置未完成 id={previous_id}->{current_id}")
    return issues


def register_active_move(active_moves: List[dict], move: dict) -> None:
    """登记已经开始但尚未完成的 move。"""
    active_moves.append(move)


def _validate_pressure_state(task: Problem, moves: List[dict]) -> List[str]:
    """校验 LoadLock type-10 压力转换与机器人访问时的压力侧一致性。"""
    issues: List[str] = []
    robot_pressure_side = {}
    # 从 Problem 的 loadlock stage 推导每个机器人访问 LoadLock 时要求的压力侧。
    for wafer in task.wafers:
        for stage in wafer.stages:
            if stage.stage_type != "loadlock":
                continue
            pairs = ((stage.in_robot, "ATM"), (stage.out_robot, "VAC")) if stage.ll_type == "entry" \
                else ((stage.in_robot, "VAC"), (stage.out_robot, "ATM"))
            for robot, pressure_state in pairs:
                if robot:
                    robot_pressure_side[robot] = pressure_state

    loadlock_names = {
        str(move.get("ModuleName"))
        for move in moves
        if _is_loadlock_pressure_move(move) and move.get("ModuleName")
    }
    for chamber in sorted(loadlock_names):
        # 以单个 LoadLock 为单位，收集压力转换 move 和会占用该 LoadLock 的访问 move。
        pressure_moves = sorted(
            (move for move in moves if _is_loadlock_pressure_move(move) and move.get("ModuleName") == chamber),
            key=sort_key,
        )
        access_moves = [
            move for move in moves
            if (move.get("MoveType") in (6, 7) and move.get("ModuleName") == chamber)
            or (move.get("MoveType") == 0 and chamber in (move.get("SrcStationList") or []))
            or (move.get("MoveType") == 1 and chamber in (move.get("DestStationList") or []))
        ]
        # 压力转换期间不允许发生开关门或机器人取放访问。
        for pressure_move in pressure_moves:
            for access_move in access_moves:
                pressure_start = _time(pressure_move, "StartTime")
                pressure_end = _time(pressure_move, "EndTime")
                access_start = _time(access_move, "StartTime")
                access_end = _time(access_move, "EndTime")
                if None in (pressure_start, pressure_end, access_start, access_end):
                    continue
                if (
                    pressure_start < access_end - TIMELINE_TOLERANCE
                    and access_start < pressure_end - TIMELINE_TOLERANCE
                ):
                    issues.append(f"ML type-10 重叠 腔{chamber}: id={pressure_move.get('MoveID')}"
                                  f"[{pressure_start:.1f},{pressure_end:.1f}] "
                                  f"与 type-{access_move.get('MoveType')} id={access_move.get('MoveID')}"
                                  f"[{access_start:.1f},{access_end:.1f}]")
        # 同一 LoadLock 的连续压力转换必须首尾状态衔接。
        for previous_move, next_move in zip(pressure_moves, pressure_moves[1:]):
            if previous_move["CurState"] != next_move["LastState"]:
                issues.append(f"ML type-10 链断裂 腔{chamber}: id={previous_move.get('MoveID')}→{next_move.get('MoveID')} "
                              f"{previous_move['CurState']}→{next_move['LastState']}")

        def state_at(timestamp: float) -> str:
            """返回给定时刻 LoadLock 的压力态，转换过程中返回中文状态。"""
            pressure_state = pressure_moves[0]["LastState"] if pressure_moves else ""
            for move in pressure_moves:
                move_start = _time(move, "StartTime")
                move_end = _time(move, "EndTime")
                if move_end is None or move_start is None:
                    continue
                if move_end <= timestamp + TIMELINE_TOLERANCE:
                    pressure_state = move["CurState"]
                elif move_start < timestamp - TIMELINE_TOLERANCE:
                    return "转换中"
            return pressure_state

        # 机器人取放 LoadLock 时，实际压力态必须匹配该机器人所在侧。
        for access_move in access_moves:
            access_robot = _move_robot(access_move)
            required_state = robot_pressure_side.get(access_robot)
            access_start = _time(access_move, "StartTime")
            access_end = _time(access_move, "EndTime")
            if access_move.get("MoveType") not in (0, 1) or required_state is None:
                continue
            if access_start is None or access_end is None:
                continue
            actual_state = state_at((access_start + access_end) / 2.0)
            if actual_state != required_state:
                issues.append(f"ML 压力态违例 腔{chamber}: {access_robot} id={access_move.get('MoveID')}"
                              f"[{access_start:.1f},{access_end:.1f}] "
                              f"需 {required_state} 实为 {actual_state}")
    return issues


def _is_loadlock_pressure_move(move: dict) -> bool:
    """判断 type-10 是否使用 ATM/VAC 压力态字段。"""
    return (
        move.get("MoveType") == 10
        and move.get("LastState") in {"ATM", "VAC"}
        and move.get("CurState") in {"ATM", "VAC"}
    )


def _time(move: dict, key: str) -> Optional[float]:
    """读取 move 时间字段，字段不是数字时返回 None。"""
    value = move.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def _move_robot(move: dict) -> str:
    """返回 move 使用的机器人名，SwapMove 使用 ModuleName 表示执行机器人。"""
    return str(move.get("Robot") or move.get("ModuleName") or "")


def _initial_state(task: Problem, init_data: Optional[Mapping[str, Any]]) -> TimelineState:
    """从 init_data 或 Problem 恢复初始 station/robot 状态。"""
    state = TimelineState()
    _load_material_positions_from_init(state, init_data)
    if not state.station_slots:
        _load_material_positions_from_problem(state, task)
    _load_robot_positions(state, init_data)
    _load_station_states(state, init_data)
    return state


def _load_material_positions_from_init(
    state: TimelineState,
    init_data: Optional[Mapping[str, Any]],
) -> None:
    """读取 init_data.Materials 中的材料初始位置。"""
    if not isinstance(init_data, Mapping):
        return
    for material in init_data.get("Materials") or []:
        if not isinstance(material, Mapping):
            continue
        material_id = material.get("ID")
        module = material.get("CurrentModuleName")
        slot = material.get("SlotID")
        if isinstance(material_id, int) and module and isinstance(slot, int) and slot > 0:
            _add_station_material(state, (str(module), int(slot)), int(material_id), trusted=True)


def _load_material_positions_from_problem(state: TimelineState, task: Problem) -> None:
    """从 Problem 的每片 wafer 首站恢复材料初始位置。"""
    for wafer in task.wafers:
        if not wafer.stages:
            continue
        first_stage = wafer.stages[0]
        slot = int(first_stage.slot) + 1
        if first_stage.chamber and slot > 0:
            _add_station_material(state, (first_stage.chamber, slot), int(wafer.mat_id), trusted=False)


def _load_robot_positions(state: TimelineState, init_data: Optional[Mapping[str, Any]]) -> None:
    """读取机器人 arm 当前指向位置，作为 PreTrans 的初始位置参考。"""
    for robot_name, robot_entry in raw_robots(init_data).items():
        if not isinstance(robot_entry, Mapping):
            continue
        for arm_entry in (robot_entry.get("ArmInfo") or {}).values():
            if not isinstance(arm_entry, Mapping) or arm_entry.get("IsEnable") is False:
                continue
            slot_at_station = arm_entry.get("SlotAtStation")
            if slot_at_station:
                state.robot_positions.setdefault(str(robot_name), str(slot_at_station))


def _load_station_states(state: TimelineState, init_data: Optional[Mapping[str, Any]]) -> None:
    """读取模块 LastItem 作为 PrePrepare 的初始状态参考。"""
    for station, station_entry in raw_stations(init_data).items():
        if isinstance(station_entry, Mapping) and station_entry.get("LastItem"):
            state.station_states[str(station)] = str(station_entry["LastItem"])


def update_move_state(state: TimelineState, active_moves: List[dict], timestamp: float) -> None:
    """把结束时间不晚于 timestamp 的 active move 应用到状态并加入使能表。"""
    ready = [
        move for move in active_moves
        if _time(move, "EndTime") is not None
        and _time(move, "EndTime") <= timestamp + TIMELINE_TOLERANCE
    ]
    if not ready:
        return
    for move in sorted(ready, key=lambda item: (_time(item, "EndTime") or 0.0, int(item.get("MoveID") or 0))):
        _apply_move_end(state, move)
        if isinstance(move.get("MoveID"), int):
            state.enabled_moves.add(int(move["MoveID"]))
    ready_ids = {id(move) for move in ready}
    active_moves[:] = [move for move in active_moves if id(move) not in ready_ids]


def _apply_move_end(state: TimelineState, move: dict) -> None:
    """根据一个 move 的完成事件更新材料位置和模块状态。"""
    move_type = move.get("MoveType")
    if move_type == 0:
        for material_id, source, robot_slot in _aligned_pick_items(move):
            _remove_station_material(state, source, material_id)
            _add_robot_material(state, robot_slot, material_id)
            state.robot_positions[robot_slot[0]] = source[0]
    elif move_type == 1:
        for material_id, destination, robot_slot in _aligned_place_items(move):
            _remove_robot_material(state, robot_slot, material_id)
            _add_station_material(state, destination, material_id)
            state.robot_positions[robot_slot[0]] = destination[0]
    elif move_type == 5:
        robot = str(move.get("Robot") or "")
        destination = dest_ref(move)
        if robot and destination:
            state.robot_positions[robot] = destination[0]
    elif move_type == 4:
        for recv_mat, station_send, recv_slot in _aligned_swap_recv_items(move):
            _remove_station_material(state, station_send, recv_mat)
            _add_robot_material(state, recv_slot, recv_mat)
            state.robot_positions[recv_slot[0]] = station_send[0]
        for send_mat, station_recv, send_slot in _aligned_swap_send_items(move):
            _remove_robot_material(state, send_slot, send_mat)
            _add_station_material(state, station_recv, send_mat)
            state.robot_positions[send_slot[0]] = station_recv[0]
    elif move_type == 10:
        station = station_name(move)
        current_state = move.get("CurState")
        if station and current_state:
            state.station_states[station] = str(current_state)


def _validate_resource_overlap(move: dict, pending: List[dict]) -> List[str]:
    """检查当前 move 与尚未完成 move 的机器人和站点槽位占用是否冲突。"""
    issues: List[str] = []
    current_id = move.get("MoveID")
    robot = _move_robot(move) if move.get("MoveType") in {0, 1, 4, 5} else ""
    if robot:
        for previous_move in pending:
            if _move_robot(previous_move) == robot:
                issues.append(
                    f"ML 时间轴资源重叠 Robot={robot}: "
                    f"id={previous_move.get('MoveID')} 与 id={current_id}"
                )
    current_station_refs = _station_resource_refs(move)
    if current_station_refs:
        for previous_move in pending:
            overlap = current_station_refs & _station_resource_refs(previous_move)
            if overlap:
                issues.append(
                    f"ML 时间轴槽位重叠 id={previous_move.get('MoveID')} 与 id={current_id}: "
                    f"{sorted(overlap)}"
                )
    return issues


def _station_resource_refs(move: dict) -> Set[StationSlot]:
    """返回会实际占用 station slot 的引用，PreTrans 不计 station 占用。"""
    move_type = move.get("MoveType")
    if move_type == 0:
        return set(_source_refs(move))
    if move_type == 1:
        return set(_dest_refs(move))
    if move_type == 4:
        return set(_swap_station_refs(move))
    if move_type in STATION_TYPES:
        return set(_station_refs(move))
    return set()


def _validate_time_to_available(
    move: dict,
    init_data: Optional[Mapping[str, Any]],
) -> List[str]:
    """检查 init data 中的机器人和模块最早可用时间。"""
    issues: List[str] = []
    start_time = _time(move, "StartTime")
    if start_time is None or not isinstance(init_data, Mapping):
        return issues
    robot = str(move.get("Robot") or "")
    robot_entry = raw_robots(init_data).get(robot)
    if isinstance(robot_entry, Mapping):
        available = _number(robot_entry.get("TimeToAvailable"))
        if available is not None and available > start_time + TIMELINE_TOLERANCE:
            issues.append(
                f"ML 时间轴可用时间违例 id={move.get('MoveID')}: "
                f"Robot {robot} TimeToAvailable={available:.6g} 晚于 StartTime={start_time:.6g}"
            )
    for station, slot in station_slot_refs(move):
        station_entry = raw_stations(init_data).get(station)
        if not isinstance(station_entry, Mapping):
            continue
        module_available = _slot_available_time(station_entry, 0)
        slot_available = _slot_available_time(station_entry, slot)
        for label, available in (("module", module_available), (f"slot {slot}", slot_available)):
            if available is not None and available > start_time + TIMELINE_TOLERANCE:
                issues.append(
                    f"ML 时间轴可用时间违例 id={move.get('MoveID')}: "
                    f"{station} {label} TimeToAvailable={available:.6g} 晚于 StartTime={start_time:.6g}"
                )
    return issues


def _validate_position_state(move: dict, state: TimelineState) -> List[str]:
    """检查当前 move 在时间轴状态中的材料位置是否合法。"""
    move_type = move.get("MoveType")
    if move_type == 0:
        return _validate_pick_state(move, state)
    if move_type == 1:
        return _validate_place_state(move, state)
    if move_type == 9:
        return _validate_process_state(move, state)
    if move_type == 10:
        return _validate_preprepare_state(move, state)
    if move_type == 4:
        return _validate_swap_state(move, state)
    return []


def _validate_pick_state(move: dict, state: TimelineState) -> List[str]:
    """检查 Pick 开始时源槽有片且机器人槽位可接收。"""
    issues: List[str] = []
    for material_id, source, robot_slot in _aligned_pick_items(move):
        station_materials = state.station_slots.get(source)
        robot_materials = state.robot_slots.get(robot_slot, [])
        if source in state.trusted_station_slots and station_materials is not None and material_id not in station_materials:
            issues.append(
                f"ML 时间轴位置违例 id={move.get('MoveID')}: "
                f"Pick 源站槽 {source} 不含 MatID {material_id}"
            )
        if robot_materials and material_id not in robot_materials:
            issues.append(
                f"ML 时间轴位置违例 id={move.get('MoveID')}: "
                f"Pick 机器人槽 {robot_slot} 已占用 {robot_materials}"
            )
    return issues


def _validate_place_state(move: dict, state: TimelineState) -> List[str]:
    """检查 Place 开始时机器人槽有片且目标槽可放入。"""
    issues: List[str] = []
    for material_id, _destination, robot_slot in _aligned_place_items(move):
        robot_materials = state.robot_slots.get(robot_slot)
        if robot_materials is not None and material_id not in robot_materials:
            issues.append(
                f"ML 时间轴位置违例 id={move.get('MoveID')}: "
                f"Place 机器人槽 {robot_slot} 不含 MatID {material_id}"
            )
    return issues


def _validate_process_state(move: dict, state: TimelineState) -> List[str]:
    """检查 Process 开始时站点槽位持有对应材料。"""
    issues: List[str] = []
    material_ids = _material_ids(move)
    if not material_ids:
        return issues
    refs = _station_refs(move)
    for material_id, station_slot in zip(material_ids, _repeat_last(refs, len(material_ids))):
        station_materials = state.station_slots.get(station_slot)
        if (
            station_slot in state.trusted_station_slots
            and station_materials is not None
            and material_id not in station_materials
        ):
            issues.append(
                f"ML 时间轴位置违例 id={move.get('MoveID')}: "
                f"Process 站槽 {station_slot} 不含 MatID {material_id}"
            )
    return issues


def _validate_preprepare_state(move: dict, state: TimelineState) -> List[str]:
    """检查 PrePrepare 的 LastState 是否衔接时间轴中已知模块状态。"""
    # 当前输出中 type-10 同时承载 LoadLock 压力态和机器人访问侧切换，LastState/CurState
    # 不总是同一状态域。连续 type-10 的严格链路仍由 premove 边一致性和压力态专项校验负责。
    return []


def _validate_swap_state(move: dict, state: TimelineState) -> List[str]:
    """检查 Swap 开始时模块发送槽和机器人发送槽中的材料状态。"""
    issues: List[str] = []
    for recv_mat, station_send, _recv_slot in _aligned_swap_recv_items(move):
        station_materials = state.station_slots.get(station_send)
        if station_send in state.trusted_station_slots and station_materials is not None and recv_mat not in station_materials:
            issues.append(
                f"ML 时间轴位置违例 id={move.get('MoveID')}: "
                f"Swap 发送站槽 {station_send} 不含 MatID {recv_mat}"
            )
    for send_mat, _station_recv, send_slot in _aligned_swap_send_items(move):
        robot_materials = state.robot_slots.get(send_slot)
        if robot_materials is not None and send_mat not in robot_materials:
            issues.append(
                f"ML 时间轴位置违例 id={move.get('MoveID')}: "
                f"Swap 机器人槽 {send_slot} 不含 MatID {send_mat}"
            )
    return issues


def _required_predecessors_for_move(current_move: dict, history: List[dict]) -> List[dict]:
    """按业务规则从已扫描历史中推导当前 move 必需声明的前置 move。"""
    required: List[dict] = []
    move_type = current_move.get("MoveType")

    def add(previous_move: Optional[dict]) -> None:
        if previous_move is None:
            return
        if previous_move.get("MoveID") == current_move.get("MoveID"):
            return
        if previous_move not in required:
            required.append(previous_move)

    if move_type == 0:
        for source in _source_refs(current_move):
            add(_latest(_by_station_slot(history, source, {6}, current_move)))
    elif move_type == 1:
        for destination in _dest_refs(current_move):
            add(_latest(_by_station_slot(history, destination, {6}, current_move)))
    elif move_type == 5:
        # 录制日志中的 PreTrans 常作为可并行的机器人定位/转向动作，正确输出不强制
        # 声明同机器人的上一条取放动作；这里只校验显式声明的必需消费方动作。
        pass
    elif move_type == 6:
        for ref in _station_refs(current_move):
            add(_latest(_by_station_slot(history, ref, {7, 10})))
    elif move_type == 7:
        for ref in _station_refs(current_move):
            add(_latest(_by_station_slot(history, ref, {0, 1}, current_move)))
            add(_latest(_by_station_slot(history, ref, {6}, current_move)))
    elif move_type == 9:
        material_move = current_move if mat_key(current_move) else None
        for ref in _station_refs(current_move):
            add(_latest(_by_station_slot(history, ref, {7}, material_move)))
    elif move_type == 10:
        material_move = current_move if mat_key(current_move) else None
        for ref in _station_refs(current_move):
            add(_latest(_by_pressure(history, ref[0])))
            add(_latest(_by_station_slot(history, ref, {7, 0, 1}, material_move)))
    return required


def _by_station_slot(
    history: Iterable[dict],
    station_slot: StationSlot,
    move_types: Set[int],
    material_move: Optional[dict] = None,
) -> List[dict]:
    """在历史 move 中查找引用指定站点槽位和类型的候选前置。"""
    candidates = []
    for previous_move in history:
        if previous_move.get("MoveType") not in move_types:
            continue
        if station_slot not in station_slot_refs(previous_move):
            continue
        if material_move is not None and mat_key(previous_move) and not same_mat(previous_move, material_move):
            continue
        candidates.append(previous_move)
    return candidates


def _by_robot(
    history: Iterable[dict],
    robot: str,
    move_types: Set[int],
    material_move: Optional[dict] = None,
) -> List[dict]:
    """在历史 move 中查找同一机器人和指定类型的候选前置。"""
    candidates = []
    for previous_move in history:
        if previous_move.get("MoveType") not in move_types or _move_robot(previous_move) != robot:
            continue
        if material_move is not None and mat_key(previous_move) and not same_mat(previous_move, material_move):
            continue
        candidates.append(previous_move)
    return candidates


def _by_pressure(history: Iterable[dict], station: str) -> List[dict]:
    """在历史 move 中查找指定站点的 PrePrepareMove。"""
    return [
        previous_move
        for previous_move in history
        if previous_move.get("MoveType") == 10 and station_name(previous_move) == station
    ]


def _latest(candidates: List[dict]) -> Optional[dict]:
    """返回候选中时间上最新的一条，不要求其已完成。"""
    return max(
        candidates,
        key=lambda move: (_time(move, "EndTime") or 0.0, int(move.get("MoveID") or 0)),
    ) if candidates else None


def _aligned_pick_items(move: dict) -> List[Tuple[int, StationSlot, RobotSlot]]:
    """按 MatIDList 对齐 Pick 的源站槽和机器人槽。"""
    material_ids = _material_ids(move)
    sources = _repeat_last(_source_refs(move), len(material_ids))
    robot_slots = _repeat_last(_robot_slots(move), len(material_ids))
    return [
        (material_id, source, robot_slot)
        for material_id, source, robot_slot in zip(material_ids, sources, robot_slots)
        if source and robot_slot
    ]


def _aligned_place_items(move: dict) -> List[Tuple[int, StationSlot, RobotSlot]]:
    """按 MatIDList 对齐 Place 的目标站槽和机器人槽。"""
    material_ids = _material_ids(move)
    destinations = _repeat_last(_dest_refs(move), len(material_ids))
    robot_slots = _repeat_last(_robot_slots(move), len(material_ids))
    return [
        (material_id, destination, robot_slot)
        for material_id, destination, robot_slot in zip(material_ids, destinations, robot_slots)
        if destination and robot_slot
    ]


def _source_refs(move: dict) -> List[StationSlot]:
    """读取 move 的所有源站槽引用。"""
    return _station_slot_pairs(as_list(move, "SrcStationList"), slot_values(move, "SrcSlotList"))


def _dest_refs(move: dict) -> List[StationSlot]:
    """读取 move 的所有目标站槽引用。"""
    return _station_slot_pairs(as_list(move, "DestStationList"), slot_values(move, "DestSlotList"))


def _station_refs(move: dict) -> List[StationSlot]:
    """读取 station move 的所有模块槽位引用。"""
    if move.get("MoveType") not in STATION_TYPES:
        return []
    station = station_name(move)
    return [(station, slot) for slot in slot_values(move) if station]


def _robot_slots(move: dict) -> List[RobotSlot]:
    """读取 move 的机器人槽位引用。"""
    robot = _move_robot(move)
    return [(robot, slot) for slot in slot_values(move, "RobotSlotList") if robot]


def _swap_recv_robot_slots(move: dict) -> List[RobotSlot]:
    """读取 Swap 从模块取片时使用的机器人槽位。"""
    robot = _move_robot(move)
    return [(robot, slot) for slot in slot_values(move, "RecvSlotList") if robot]


def _swap_send_robot_slots(move: dict) -> List[RobotSlot]:
    """读取 Swap 向模块放片时使用的机器人槽位。"""
    robot = _move_robot(move)
    return [(robot, slot) for slot in slot_values(move, "SendSlotList") if robot]


def _swap_station_refs(move: dict) -> List[StationSlot]:
    """读取 Swap 涉及的所有模块槽位。"""
    return _swap_recv_refs(move) + _swap_send_refs(move)


def _swap_recv_refs(move: dict) -> List[StationSlot]:
    """读取 Swap 模块接收换入片的槽位。"""
    return _station_slot_pairs(as_list(move, "StationList"), slot_values(move, "StnRecvSlotList"))


def _swap_send_refs(move: dict) -> List[StationSlot]:
    """读取 Swap 模块发送换出片的槽位。"""
    return _station_slot_pairs(as_list(move, "StationList"), slot_values(move, "StnSendSlotList"))


def _aligned_swap_recv_items(move: dict) -> List[Tuple[int, StationSlot, RobotSlot]]:
    """按 RecvMatList 对齐 Swap 的模块发送槽和机器人接收槽。"""
    material_ids = tuple(value for value in as_list(move, "RecvMatList") if isinstance(value, int))
    station_sends = _repeat_last(_swap_send_refs(move), len(material_ids))
    robot_recvs = _repeat_last(_swap_recv_robot_slots(move), len(material_ids))
    return [
        (material_id, station_send, robot_recv)
        for material_id, station_send, robot_recv in zip(material_ids, station_sends, robot_recvs)
        if station_send and robot_recv
    ]


def _aligned_swap_send_items(move: dict) -> List[Tuple[int, StationSlot, RobotSlot]]:
    """按 SendMatList 对齐 Swap 的模块接收槽和机器人发送槽。"""
    material_ids = tuple(value for value in as_list(move, "SendMatList") if isinstance(value, int))
    station_recvs = _repeat_last(_swap_recv_refs(move), len(material_ids))
    robot_sends = _repeat_last(_swap_send_robot_slots(move), len(material_ids))
    return [
        (material_id, station_recv, robot_send)
        for material_id, station_recv, robot_send in zip(material_ids, station_recvs, robot_sends)
        if station_recv and robot_send
    ]


def _station_slot_pairs(stations: List[Any], slots: Tuple[int, ...]) -> List[StationSlot]:
    """把 station 列表和 slot 列表按 index 对齐成站槽引用。"""
    if not stations or not slots:
        return []
    station_names = [str(station) for station in stations if station]
    if not station_names:
        return []
    width = max(len(station_names), len(slots))
    station_values = _repeat_last(station_names, width)
    slot_values_list = _repeat_last(list(slots), width)
    return [
        (station, int(slot))
        for station, slot in zip(station_values, slot_values_list)
        if station and isinstance(slot, int) and slot > 0
    ]


def _material_ids(move: dict) -> MaterialTuple:
    """读取 MatIDList 中的整数材料 ID。"""
    return tuple(value for value in as_list(move, "MatIDList") if isinstance(value, int))


def _repeat_last(values: List[Any], count: int) -> List[Any]:
    """把列表扩展到 count 长度，短列表重复最后一个元素。"""
    if count <= 0:
        return []
    if not values:
        return []
    if len(values) >= count:
        return values[:count]
    return values + [values[-1]] * (count - len(values))


def _add_station_material(
    state: TimelineState,
    station_slot: StationSlot,
    material_id: int,
    *,
    trusted: bool = True,
) -> None:
    """向 station slot 登记材料。"""
    materials = state.station_slots.setdefault(station_slot, [])
    if material_id not in materials:
        materials.append(material_id)
    if trusted:
        state.trusted_station_slots.add(station_slot)


def _remove_station_material(state: TimelineState, station_slot: StationSlot, material_id: int) -> None:
    """从 station slot 移除材料；缺失时保持状态不变。"""
    materials = state.station_slots.get(station_slot)
    if materials and material_id in materials:
        materials.remove(material_id)
    state.trusted_station_slots.add(station_slot)


def _add_robot_material(state: TimelineState, robot_slot: RobotSlot, material_id: int) -> None:
    """向 robot slot 登记材料。"""
    materials = state.robot_slots.setdefault(robot_slot, [])
    if material_id not in materials:
        materials.append(material_id)


def _remove_robot_material(state: TimelineState, robot_slot: RobotSlot, material_id: int) -> None:
    """从 robot slot 移除材料；缺失时保持状态不变。"""
    materials = state.robot_slots.get(robot_slot)
    if materials and material_id in materials:
        materials.remove(material_id)


def _slot_available_time(station_entry: Mapping[str, Any], slot: int) -> Optional[float]:
    """读取模块或槽位最早可用时间，slot=0 表示模块级。"""
    values = station_entry.get("TimeToAvailableOfSlot") or {}
    if not isinstance(values, Mapping):
        return None
    raw_value = values.get(slot)
    if raw_value is None:
        raw_value = values.get(str(slot))
    return _number(raw_value)


def _number(value: Any) -> Optional[float]:
    """读取数字值，非数字返回 None。"""
    return float(value) if isinstance(value, (int, float)) else None
