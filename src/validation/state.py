"""MoveList 回放使用的设备当前状态。

本模块只保存已经完成的 Move 带来的稳定状态，以及开始后尚未结束动作占用的资源时间。
时间线推进和 MoveType 字段解释由 ``src.validation.move_replay`` 负责；这里不读取
MoveList，也不承载动作编排逻辑。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Iterable, Mapping, Optional, Sequence, Set

from src.model import Problem


DEFAULT_SLOT_ID = 1
ZERO_BASED_SLOT_OFFSET = 1
ATMOSPHERE = "ATM"
VACUUM = "VAC"
LOAD_LOCK_TYPE = "loadlock"
LOAD_PORT_TYPE = "loadport"


class DoorState(str, Enum):
    """设备门的稳定开闭状态。"""

    CLOSED = "closed"
    OPEN = "open"


class SlotPhase(str, Enum):
    """槽位在已完成 Move 后可观察到的稳定物料状态。"""

    EMPTY = "empty"
    CLEANED = "cleaned"
    UNPROCESSED = "unprocessed"
    COMPLETED = "completed"


@dataclass
class MaterialState:
    """保存在槽位或机器人手槽中的物料标识及路线元数据。"""

    material_id: Any
    pjob_name: str = ""
    step_id: Any = None


@dataclass
class SlotState:
    """一个设备槽位的物料状态和当前占用窗口。"""

    phase: SlotPhase = SlotPhase.EMPTY
    material: Optional[MaterialState] = None
    busy_until: float = 0.0
    busy_action: str = ""


@dataclass
class StationState:
    """普通腔室的门、槽位及门机构和取放访问资源。"""

    name: str
    station_type: str
    slots: Dict[int, SlotState] = field(default_factory=dict)
    door: DoorState = DoorState.CLOSED
    door_busy_until: float = 0.0
    transfer_busy_until: float = 0.0
    environment_busy_until: float = 0.0

    @property
    def is_load_lock(self) -> bool:
        """判断当前站点是否为 LoadLock。"""
        return self.station_type.lower() == LOAD_LOCK_TYPE


@dataclass
class LoadLockState(StationState):
    """带有大气或真空环境状态的 LoadLock。"""

    environment: str = ATMOSPHERE


@dataclass
class RobotState:
    """一个机器人当前指向、手槽物料、可达范围和忙碌时间。"""

    name: str
    hands: Dict[int, Optional[MaterialState]] = field(default_factory=dict)
    scope: Set[str] = field(default_factory=set)
    position: Optional[str] = None
    busy_until: float = 0.0


@dataclass
class MachineState:
    """MoveList 回放期间的整机状态。

    ``stations`` 和 ``robots`` 只记录已经结束动作产生的状态；各 ``busy_until`` 字段
    用于在状态尚未落地的执行窗口内阻止冲突 Move。
    """

    stations: Dict[str, StationState] = field(default_factory=dict)
    robots: Dict[str, RobotState] = field(default_factory=dict)
    robot_aliases: Dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_sources(
        cls,
        task: Problem,
        init_data: Optional[Mapping[str, Any]],
    ) -> "MachineState":
        """从 ``init_data`` 与 ``Problem`` 构建验证用初始状态。

        参数:
            task: 解析后的静态拓扑和任务首工序信息。
            init_data: 可选的 AlgInit payload，也兼容一层 ``Info`` 外壳。

        返回:
            已填充站点、机器人、初始物料和机器人初始指向的整机状态。
        """
        payload = _initial_payload(init_data)
        state = cls()
        station_configs = _mapping(payload.get("Stations"))
        robot_configs = _mapping(payload.get("Robots"))

        for name, config in station_configs.items():
            task_station = getattr(task, "chambers", {}).get(str(name))
            station_type = str(config.get("Type") or getattr(task_station, "type", ""))
            slots = {slot: SlotState() for slot in _station_slots(config, task_station)}
            last_item = str(config.get("LastItem") or "")
            if station_type.lower() == LOAD_LOCK_TYPE:
                state.stations[str(name)] = LoadLockState(
                    name=str(name),
                    station_type=station_type,
                    slots=slots,
                    environment=_environment_from_last_item(last_item),
                )
            else:
                state.stations[str(name)] = StationState(str(name), station_type, slots)

        for name, task_station in getattr(task, "chambers", {}).items():
            if str(name) not in state.stations:
                state.stations[str(name)] = _station_from_task(str(name), task_station)

        for name, config in robot_configs.items():
            robot = _robot_from_config(str(name), config)
            state.robots[robot.name] = robot
            state.robot_aliases[robot.name] = robot.name
            if config.get("Name"):
                state.robot_aliases[str(config["Name"])] = robot.name

        for name, task_robot in getattr(task, "robots", {}).items():
            robot_name = str(name)
            if robot_name not in state.robots:
                state.robots[robot_name] = _robot_from_task(robot_name, task_robot)
            state.robot_aliases.setdefault(robot_name, robot_name)
            raw_name = str(getattr(task_robot, "name", "") or "")
            if raw_name:
                state.robot_aliases.setdefault(raw_name, robot_name)

        for station_name, slot_id, material in _initial_materials(task, payload):
            station = state.ensure_station(station_name, slot_id)
            station.slots[slot_id] = SlotState(SlotPhase.COMPLETED, material)
        return state

    def ensure_station(self, name: str, slot_id: int) -> StationState:
        """返回站点并在初始数据遗漏时补建引用槽位。"""
        station = self.stations.get(name)
        if station is None:
            station = StationState(name, "", {slot_id: SlotState()})
            self.stations[name] = station
        station.slots.setdefault(slot_id, SlotState())
        return station

    def resolve_robot(self, raw_name: str) -> Optional[RobotState]:
        """通过 init data 名称别名查找机器人状态。"""
        return self.robots.get(self.robot_aliases.get(raw_name, raw_name))


def _initial_payload(init_data: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    """拆开可选 ``Info`` 外壳，并兼容单元素的接口数组。"""
    if not isinstance(init_data, Mapping):
        return {}
    info = init_data.get("Info")
    if isinstance(info, Mapping):
        return info
    if isinstance(info, Sequence) and not isinstance(info, (str, bytes)):
        return info[0] if info and isinstance(info[0], Mapping) else {}
    return init_data


def _mapping(value: Any) -> Mapping[str, Mapping[str, Any]]:
    """把接口对象收敛为字符串键的配置映射。"""
    if not isinstance(value, Mapping):
        return {}
    return {
        str(name): config
        for name, config in value.items()
        if isinstance(config, Mapping)
    }


def _station_slots(config: Mapping[str, Any], task_station: Any) -> Set[int]:
    """从显式槽位、接口容量或任务容量解析一基槽位编号。"""
    raw_slots = config.get("Slots")
    if isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
        slots = {int(value) for value in raw_slots if isinstance(value, int) and value >= DEFAULT_SLOT_ID}
        if slots:
            return slots
    capacity = config.get("Capacity")
    if not isinstance(capacity, int):
        capacity = int(getattr(task_station, "capacity", DEFAULT_SLOT_ID) or DEFAULT_SLOT_ID)
    return set(range(DEFAULT_SLOT_ID, max(capacity, DEFAULT_SLOT_ID) + ZERO_BASED_SLOT_OFFSET))


def _station_from_task(name: str, task_station: Any) -> StationState:
    """用 ``Problem`` 中缺失的站点补建默认关门状态。"""
    station_type = str(getattr(task_station, "type", ""))
    slots = {
        slot: SlotState()
        for slot in range(
            DEFAULT_SLOT_ID,
            max(int(getattr(task_station, "capacity", DEFAULT_SLOT_ID) or DEFAULT_SLOT_ID), DEFAULT_SLOT_ID)
            + ZERO_BASED_SLOT_OFFSET,
        )
    }
    if station_type.lower() == LOAD_LOCK_TYPE:
        return LoadLockState(name, station_type, slots)
    return StationState(name, station_type, slots)


def _robot_from_config(name: str, config: Mapping[str, Any]) -> RobotState:
    """从机器人手臂配置读取手槽、可达范围和共同初始指向。"""
    hands: Dict[int, Optional[MaterialState]] = {}
    scope: Set[str] = set()
    positions: Set[str] = set()
    for arm in _mapping(config.get("ArmInfo")).values():
        if arm.get("IsEnable") is False:
            continue
        hands.update({int(slot): None for slot in arm.get("SlotIDs") or [] if isinstance(slot, int) and slot >= DEFAULT_SLOT_ID})
        scope.update(str(station) for station in arm.get("AccessibleStations") or [] if station)
        if arm.get("SlotAtStation"):
            positions.add(str(arm["SlotAtStation"]))
    if not hands:
        capacity = int(config.get("Capacity", DEFAULT_SLOT_ID) or DEFAULT_SLOT_ID)
        hands = {slot: None for slot in range(DEFAULT_SLOT_ID, max(capacity, DEFAULT_SLOT_ID) + ZERO_BASED_SLOT_OFFSET)}
    return RobotState(name, hands, scope, next(iter(positions)) if len(positions) == 1 else None)


def _robot_from_task(name: str, task_robot: Any) -> RobotState:
    """从 ``Problem`` 机器人补建没有 init data 的初始状态。"""
    capacity = max(int(getattr(task_robot, "capacity", DEFAULT_SLOT_ID) or DEFAULT_SLOT_ID), DEFAULT_SLOT_ID)
    return RobotState(
        name,
        {slot: None for slot in range(DEFAULT_SLOT_ID, capacity + ZERO_BASED_SLOT_OFFSET)},
        {str(station) for station in getattr(task_robot, "scope", [])},
    )


def _environment_from_last_item(last_item: str) -> str:
    """由 LoadLock 最近访问对象推断初始环境，缺失时默认大气。"""
    return VACUUM if "VAC" in last_item.upper() or "VTR" in last_item.upper() else ATMOSPHERE


def _initial_materials(task: Problem, payload: Mapping[str, Any]) -> Iterable[tuple[str, int, MaterialState]]:
    """优先读取 init data 物料，否则使用任务首工序物料。"""
    materials = payload.get("Materials")
    if isinstance(materials, Sequence) and not isinstance(materials, (str, bytes)):
        loaded = [
            (
                str(entry.get("CurrentModuleName") or ""),
                int(entry.get("SlotID")) if isinstance(entry.get("SlotID"), int) else DEFAULT_SLOT_ID,
                MaterialState(entry.get("ID"), str(entry.get("PJobName") or ""), entry.get("StepID")),
            )
            for entry in materials
            if isinstance(entry, Mapping) and entry.get("CurrentModuleName") and entry.get("ID") is not None
        ]
        if loaded:
            return loaded
    return [
        (
            str(getattr(stages[0], "chamber", "")),
            int(getattr(stages[0], "slot", 0) or 0) + ZERO_BASED_SLOT_OFFSET,
            MaterialState(
                getattr(wafer, "mat_id", None),
                str(getattr(wafer, "pjob_name", "") or ""),
                getattr(stages[0], "j", None),
            ),
        )
        for wafer in getattr(task, "wafers", [])
        for stages in [list(getattr(wafer, "stages", []) or [])]
        if stages and getattr(wafer, "mat_id", None) is not None and getattr(stages[0], "chamber", "")
    ]
