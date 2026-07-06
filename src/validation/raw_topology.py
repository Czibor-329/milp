"""基于原始 init data 的 MoveList 拓扑和时长校验。

本文件从 raw init data 中读取机器人、站点、可达范围、槽位和动作时长，
用于验证导出的 MoveList 是否违反设备拓扑或配置时长。它只依赖原始字典结构，
避免把 `Problem` 中已经规整过的信息反向映射回原始字段。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Set, Tuple

from src.validation.common import (
    STATION_TYPES,
    SWAP_MOVE,
    as_list,
    close,
    dest_ref,
    duration,
    source_ref,
    station_name,
    station_ref,
    slot_values,
)


@dataclass
class TopologyContext:
    """单条 move 拓扑/时长校验所需的静态索引。"""

    init_data: Optional[Mapping[str, Any]]
    by_id: Dict[int, dict] = field(default_factory=dict)
    consumers: Dict[int, List[dict]] = field(default_factory=dict)


def raw_robots(init_data: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    """从 init data 中读取 Robots 映射，缺失或格式不符时返回空映射。"""
    return init_data.get("Robots") or {} if isinstance(init_data, Mapping) else {}


def move_robot(move: Mapping[str, Any]) -> str:
    """返回 move 使用的机器人名，接口输出常用 ModuleName 表示机器人动作执行者。"""
    return str(move.get("Robot") or move.get("ModuleName") or "")


def raw_stations(init_data: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    """从 init data 中读取 Stations 映射，缺失或格式不符时返回空映射。"""
    return init_data.get("Stations") or {} if isinstance(init_data, Mapping) else {}


def raw_robot_scope(robot_entry: Mapping[str, Any]) -> Set[str]:
    """读取机器人各 arm 的可达站点集合。"""
    scope: Set[str] = set()
    for arm in (robot_entry.get("ArmInfo") or {}).values():
        if isinstance(arm, Mapping):
            scope.update(str(station) for station in (arm.get("AccessibleStations") or []))
    return scope


def raw_station_slots(station_entry: Mapping[str, Any]) -> Set[int]:
    """读取站点合法槽位集合，未显式配置 Slots 时按 Capacity 生成。"""
    slots = station_entry.get("Slots")
    if isinstance(slots, list) and slots:
        return {int(slot) for slot in slots if isinstance(slot, int) and slot > 0}
    capacity = int(station_entry.get("Capacity", 1) or 1)
    return set(range(1, capacity + 1))


def raw_station_time(init_data: Optional[Mapping[str, Any]], station: str, field: str, robot: str) -> Optional[float]:
    """读取站点上按机器人区分的准备或完成时长。"""
    entry = raw_stations(init_data).get(station)
    if not isinstance(entry, Mapping):
        return None
    times = entry.get(field) or {}
    if not isinstance(times, Mapping) or robot not in times:
        return None
    return float(times[robot])


def raw_pick_time(init_data: Optional[Mapping[str, Any]], robot: str, station: str) -> Optional[float]:
    """读取机器人从指定站点 pick 的时长。"""
    robot_entry = raw_robots(init_data).get(robot)
    times = robot_entry.get("PickTime") or {} if isinstance(robot_entry, Mapping) else {}
    return float(times[station]) if isinstance(times, Mapping) and station in times else None


def raw_place_time(init_data: Optional[Mapping[str, Any]], robot: str, station: str) -> Optional[float]:
    """读取机器人向指定站点 place 的时长。"""
    robot_entry = raw_robots(init_data).get(robot)
    times = robot_entry.get("PlaceTime") or {} if isinstance(robot_entry, Mapping) else {}
    return float(times[station]) if isinstance(times, Mapping) and station in times else None


def raw_move_time(init_data: Optional[Mapping[str, Any]], robot: str, source: str, destination: str) -> Optional[float]:
    """读取机器人从源站到目标站的预转移时长。"""
    robot_entry = raw_robots(init_data).get(robot)
    if not isinstance(robot_entry, Mapping):
        return None
    matches = [
        float(entry.get("Time", 0.0))
        for entry in (robot_entry.get("PrepTransTime") or [])
        if isinstance(entry, Mapping)
        and str(entry.get("SrcStation", "")) == source
        and str(entry.get("DestStation", "")) == destination
    ]
    if matches:
        positive_times = [move_time for move_time in matches if move_time > 0]
        return min(positive_times) if positive_times else 0.0
    prep = robot_entry.get("PrepTransTime") or []
    return float(prep[0].get("Time", 0.0)) if prep else None


def raw_ll_duration(
    init_data: Optional[Mapping[str, Any]],
    station: str,
    last_state: str,
    current_state: str,
) -> Optional[float]:
    """读取 LoadLock 在两个压力态之间转换所需的时长。"""
    entry = raw_stations(init_data).get(station)
    if not isinstance(entry, Mapping):
        return None
    if last_state == "ATM" and current_state == "VAC":
        kind = "pump"
    elif last_state == "VAC" and current_state == "ATM":
        kind = "vent"
    else:
        return None
    explicit = entry.get("PumpTime") if kind == "pump" else entry.get("VentTime")
    if explicit is not None:
        return float(explicit)
    for pp in entry.get("PrePrepareTime") or []:
        if isinstance(pp, Mapping) and pp.get("Time") is not None:
            if str(pp.get("PrePrepareType") or "").lower().startswith(kind):
                return float(pp["Time"])
    return None


def build_topology_context(init_data: Optional[Mapping[str, Any]], moves: List[dict]) -> TopologyContext:
    """建立原始 init data 拓扑/时长校验需要的静态索引。"""
    by_id = {move.get("MoveID"): move for move in moves if isinstance(move.get("MoveID"), int)}
    consumers: Dict[int, List[dict]] = {}
    for move in moves:
        for previous_id in as_list(move, "PreMoveID"):
            if isinstance(previous_id, int):
                consumers.setdefault(previous_id, []).append(move)
    return TopologyContext(init_data=init_data, by_id=by_id, consumers=consumers)


def validate_move_topology_and_duration(context: TopologyContext, move: dict) -> List[str]:
    """根据原始 init data 校验单条 move 的拓扑可达性、槽位和动作时长。"""
    init_data = context.init_data
    if init_data is None:
        return []

    issues: List[str] = []
    robots = raw_robots(init_data)
    stations = raw_stations(init_data)

    def check_slots(move_id: object, station: str, slots: Tuple[int, ...], label: str) -> None:
        """校验给定站点槽位是否都在 init data 允许集合内。"""
        entry = stations.get(station)
        if not isinstance(entry, Mapping):
            return
        allowed = raw_station_slots(entry)
        for slot in slots:
            if slot not in allowed:
                issues.append(f"ML 拓扑违例 id={move_id}: {label} {station} slot {slot} 不在 init Slots {sorted(allowed)}")

    def check_robot_access(move: dict, station: str, label: str) -> None:
        """校验 move 使用的机器人是否可达指定站点。"""
        robot = move_robot(move)
        robot_entry = robots.get(robot)
        if isinstance(robot_entry, Mapping) and station and station not in raw_robot_scope(robot_entry):
            issues.append(f"ML 拓扑违例 id={move.get('MoveID')}: 机器手 {robot} 不可达 {label} {station}")

    def check_duration(move: dict, expected: Optional[float], label: str) -> None:
        """校验 move 实际时长是否等于 init data 中的期望时长。"""
        actual_duration = duration(move)
        if expected is not None and actual_duration is not None and not close(actual_duration, expected):
            issues.append(f"ML 时长违例 id={move.get('MoveID')}: "
                          f"{label} 时长 {actual_duration:.6g} != init {expected:.6g}")

    move_id = move.get("MoveID")
    move_type = move.get("MoveType")
    # 先按 move 引用的站点和槽位，校验槽位存在且机器人可达。
    if move_type in STATION_TYPES:
        check_slots(move_id, station_name(move), slot_values(move), "Station")
    if move_type in (0, 5):
        for station in as_list(move, "SrcStationList"):
            check_slots(move_id, str(station), slot_values(move, "SrcSlotList"), "SrcStation")
            check_robot_access(move, str(station), "SrcStation")
    if move_type in (1, 5):
        for station in as_list(move, "DestStationList"):
            check_slots(move_id, str(station), slot_values(move, "DestSlotList"), "DestStation")
            check_robot_access(move, str(station), "DestStation")
    if move_type == SWAP_MOVE:
        for station in as_list(move, "StationList"):
            check_slots(move_id, str(station), slot_values(move, "StnRecvSlotList"), "SwapRecvStation")
            check_slots(move_id, str(station), slot_values(move, "StnSendSlotList"), "SwapSendStation")
            check_robot_access(move, str(station), "SwapStation")

    # 再按 MoveType 从 init data 读取期望时长，并和 MoveList 实际时长比较。
    if move_type == 0 and source_ref(move):
        source = source_ref(move)
        check_duration(move, raw_pick_time(init_data, move_robot(move), source[0]), "Pick")
    elif move_type == 1 and dest_ref(move):
        destination = dest_ref(move)
        check_duration(move, raw_place_time(init_data, move_robot(move), destination[0]), "Place")
    elif move_type == 5 and source_ref(move) and dest_ref(move):
        source = source_ref(move)
        destination = dest_ref(move)
        check_duration(
            move,
            raw_move_time(init_data, move_robot(move), source[0], destination[0]),
            "PreTrans",
        )
    elif move_type == 6 and station_ref(move):
        # Prepare 的期望时长取决于后续消费它的 Pick 或 Place。
        station_slot = station_ref(move)
        expected = None
        for next_move in context.consumers.get(int(move_id), []) if isinstance(move_id, int) else []:
            if next_move.get("MoveType") == 0 and source_ref(next_move) == station_slot:
                expected = raw_station_time(
                    init_data,
                    station_slot[0],
                    "PickPrepareTime",
                    move_robot(next_move),
                )
                break
            if next_move.get("MoveType") == 1 and dest_ref(next_move) == station_slot:
                expected = raw_station_time(
                    init_data,
                    station_slot[0],
                    "PlacePrepareTime",
                    move_robot(next_move),
                )
                break
        check_duration(move, expected, "Prepare")
    elif move_type == 7 and station_ref(move):
        # Complete 的期望时长取决于它前置的 Pick 或 Place。
        station_slot = station_ref(move)
        expected = None
        for previous_id in as_list(move, "PreMoveID"):
            previous_move = context.by_id.get(previous_id)
            if not previous_move:
                continue
            if previous_move.get("MoveType") == 0 and source_ref(previous_move) == station_slot:
                expected = raw_station_time(
                    init_data,
                    station_slot[0],
                    "PickCompleteTime",
                    move_robot(previous_move),
                )
                break
            if previous_move.get("MoveType") == 1 and dest_ref(previous_move) == station_slot:
                expected = raw_station_time(
                    init_data,
                    station_slot[0],
                    "PlaceCompleteTime",
                    move_robot(previous_move),
                )
                break
        check_duration(move, expected, "Complete")
    elif move_type == 10:
        check_duration(
            move,
            raw_ll_duration(
                init_data,
                station_name(move),
                str(move.get("LastState") or ""),
                str(move.get("CurState") or ""),
            ),
            "PrePrepare",
        )
    return issues


def validate_topology_and_durations(init_data: Optional[Mapping[str, Any]], moves: List[dict]) -> List[str]:
    """根据原始 init data 校验 MoveList 的拓扑可达性、槽位和动作时长。"""
    context = build_topology_context(init_data, moves)
    issues: List[str] = []
    for move in moves:
        issues.extend(validate_move_topology_and_duration(context, move))
    return issues
