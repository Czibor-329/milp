"""调度请求数据建模。

本模块负责设备初始化数据归一化、任务级 AlgInit 裁剪、PSE300 LoadLock 扩展、
Route/Recipe 构造以及各轮 CJob/PJob 请求展开。它不执行调度算法，也不处理 HTTP
或工作区持久化。
"""

from __future__ import annotations

import json
import math
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence


FIRST_SLOT_ID = 1
MAX_WAFERS_PER_JOB = 25
DEFAULT_TRIGGER_UPPER = 9999.0
# 旧 Clean 未提供库存配置时使用的 DummyPort wafer 数量。
DEFAULT_DUMMY_WAFER_COUNT = 8
DUMMY_MATERIAL_ID_START = 100000
DUMMY_MATERIAL_LIMIT_LEVEL = 10000
DUMMY_MATERIAL_USAGE_MIX = 2
CJOB_TYPE_VALUES = {"NormalLot": 0, "HighestLot": 2, "HigherLot": 3}
TASK_MODE_VALUES = {"Smart": 0, "Pipeline": 1, "Sequential": 2, "Concurrent": 3}
PSE300_REQUIRED_STATIONS = {
    "PM1", "PM2", "PM3", "PM4", "Buffer1", "Buffer2", "Buffer3", "Buffer4",
    "LA", "LB", "LP1", "LP2", "LP3", "LP4",
}
PSE300_REQUIRED_ROBOTS = {"ATR", "VTR"}
PSE300_LOADLOCK_COPIES = {"LC": "LA", "LD": "LB"}


@dataclass
class BuildState:
    """跨轮生成 Job 接口对象时使用的全局编号和 LoadPort 槽位状态。"""

    next_material_id: int = 1
    next_slot_by_port: Dict[str, int] = field(default_factory=dict)
    job_names: set[str] = field(default_factory=set)
    task_ids: set[str] = field(default_factory=set)
    dummy_material_count: int = 0


def extract_init_data(raw: Any) -> Dict[str, Any]:
    """兼容原始 init_data、AlgInit 录制数组和一层 Info 包装。

    标准 ``IToolTopo`` 不包含顶层 Route；旧录制或导入文件即使携带
    ``Route/Routes`` 兼容字段，也不能继续透传给算法 ``init``。
    """
    value = raw
    if isinstance(value, list):
        entry = next(
            (
                item for item in value
                if isinstance(item, Mapping) and str(item.get("Describe") or "").lower() == "alginit"
            ),
            None,
        )
        if entry is None:
            raise ValueError("设备文件数组中找不到 Describe=AlgInit")
        value = entry.get("Info")
    if isinstance(value, Mapping) and isinstance(value.get("InitData"), Mapping):
        value = value["InitData"]
    if isinstance(value, Mapping) and isinstance(value.get("Info"), Mapping):
        value = value["Info"]
    if not isinstance(value, Mapping):
        raise ValueError("设备文件不是有效 JSON 对象")
    if not isinstance(value.get("Stations"), Mapping) or not isinstance(value.get("Robots"), Mapping):
        raise ValueError("设备文件必须包含 Stations 和 Robots")
    return {
        str(key): deepcopy(item)
        for key, item in value.items()
        if str(key).casefold() not in {"route", "routes"}
    }


def _clone_station_references(value: Any, source: str, target: str) -> Any:
    """深复制一段设备配置，并把值中精确匹配的 Station 名称替换为新名称。"""
    if isinstance(value, Mapping):
        return {
            (target if str(key) == source else str(key)): _clone_station_references(item, source, target)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_clone_station_references(item, source, target) for item in value]
    return target if value == source else deepcopy(value)


def _expand_robot_loadlocks(robot: Dict[str, Any]) -> None:
    """为一台 PSE300 Robot 补齐 LC/LD 的时间矩阵、可达站点和手臂槽位映射。"""
    for field_name in ("PlaceTime", "PickTime"):
        station_times = robot.get(field_name)
        if not isinstance(station_times, dict):
            continue
        for target, source in PSE300_LOADLOCK_COPIES.items():
            if target not in station_times and source in station_times:
                station_times[target] = deepcopy(station_times[source])

    raw_transfers = robot.get("PrepTransTime")
    if isinstance(raw_transfers, list):
        original_transfers = [item for item in raw_transfers if isinstance(item, Mapping)]
        known_transfers = {
            (
                str(item.get("SrcStation") or ""), str(item.get("DestStation") or ""),
                item.get("TransType"),
            )
            for item in original_transfers
        }
        copies_by_source = {source: target for target, source in PSE300_LOADLOCK_COPIES.items()}
        for transfer in original_transfers:
            source_station = str(transfer.get("SrcStation") or "")
            destination_station = str(transfer.get("DestStation") or "")
            source_variants = [source_station]
            destination_variants = [destination_station]
            if source_station in copies_by_source:
                source_variants.append(copies_by_source[source_station])
            if destination_station in copies_by_source:
                destination_variants.append(copies_by_source[destination_station])
            for new_source in source_variants:
                for new_destination in destination_variants:
                    # ITransferInfo 的查找键不包含 Time；设备已经显式配置目标站时，
                    # 即使时间与源 LoadLock 不同也必须保留原值，不能追加重复四元组。
                    key = (new_source, new_destination, transfer.get("TransType"))
                    if key in known_transfers:
                        continue
                    new_transfer = deepcopy(dict(transfer))
                    new_transfer["SrcStation"] = new_source
                    new_transfer["DestStation"] = new_destination
                    raw_transfers.append(new_transfer)
                    known_transfers.add(key)

    arm_pairs = robot.get("ArmPointerPair")
    if isinstance(arm_pairs, list):
        for target, source in PSE300_LOADLOCK_COPIES.items():
            copied_pairs = [
                _clone_station_references(pair, source, target)
                for pair in list(arm_pairs)
                if isinstance(pair, list) and source in pair
            ]
            for pair in copied_pairs:
                if pair not in arm_pairs:
                    arm_pairs.append(pair)

    arm_info = robot.get("ArmInfo")
    if not isinstance(arm_info, Mapping):
        return
    for arm in arm_info.values():
        if not isinstance(arm, dict):
            continue
        accessible = arm.get("AccessibleStations")
        if isinstance(accessible, list):
            for target, source in PSE300_LOADLOCK_COPIES.items():
                if source in accessible and target not in accessible:
                    accessible.append(target)
        slot_map = arm.get("SlotsStationMap")
        if isinstance(slot_map, dict):
            for target, source in PSE300_LOADLOCK_COPIES.items():
                if target not in slot_map and source in slot_map:
                    slot_map[target] = _clone_station_references(slot_map[source], source, target)


def expand_pse300_loadlocks(device: Dict[str, Any]) -> bool:
    """识别 PSE300 拓扑并新增 LC/LD；LC 复制 LA，LD 复制 LB，返回是否发生修改。"""
    stations = device.get("Stations")
    robots = device.get("Robots")
    if not isinstance(stations, dict) or not isinstance(robots, dict):
        return False
    if not PSE300_REQUIRED_STATIONS.issubset(stations) or not PSE300_REQUIRED_ROBOTS.issubset(robots):
        return False
    changed = any(target not in stations for target in PSE300_LOADLOCK_COPIES)
    for target, source in PSE300_LOADLOCK_COPIES.items():
        if target not in stations:
            stations[target] = _clone_station_references(stations[source], source, target)
    for robot in robots.values():
        if isinstance(robot, dict):
            _expand_robot_loadlocks(robot)
    return changed


def _task_module_names(
    routes: Sequence[Mapping[str, Any]],
    rounds: Sequence[Mapping[str, Any]],
    cleans: Sequence[Mapping[str, Any]],
) -> set[str]:
    """汇总当前任务通过 Route、固定 LoadPort 和已引用 Clean 使用的模块。"""
    module_names: set[str] = set()
    clean_names: set[str] = set()
    for route in routes:
        for field_name in ("prePJobCleanRefs", "postPJobCleanRefs", "postCJobCleanRefs"):
            clean_names.update(_string_list(route.get(field_name)))
        for stage in route.get("stages") or []:
            if not isinstance(stage, Mapping):
                continue
            for visit in _stage_visit_rows(stage):
                module_name = str(
                    visit.get("stationName") or visit.get("StationName") or ""
                ).strip()
                if module_name:
                    module_names.add(module_name)
                for field_name in ("beforeCleanRefs", "afterCleanRefs"):
                    clean_names.update(_string_list(visit.get(field_name)))
    for round_config in rounds:
        for control_job in _round_cjob_rows(round_config):
            load_port = str(
                control_job.get("loadPort") or control_job.get("LoadPort") or ""
            ).strip()
            if load_port:
                module_names.add(load_port)
            for process_job in control_job.get("pjobs") or []:
                if not isinstance(process_job, Mapping):
                    continue
                load_port = str(
                    process_job.get("loadPort") or process_job.get("LoadPort") or ""
                ).strip()
                if load_port:
                    module_names.add(load_port)
    for clean in cleans:
        if not isinstance(clean, Mapping):
            continue
        clean_name = str(clean.get("name") or clean.get("Name") or "").strip()
        if clean_name not in clean_names:
            continue
        module_names.update(_string_list(clean.get("modules") or clean.get("Modules")))
        clean_type = str(clean.get("cleanType") or clean.get("CleanType") or "")
        if clean_type.casefold().replace("-", "").replace("_", "") in {"dummy", "dummywac"}:
            module_names.add("DummyPort")
    return module_names


def _filtered_arm_station_map(raw_map: Any, station_names: set[str]) -> Dict[str, Any]:
    """裁剪 SlotsStationMap 候选，并保留仍覆盖实际 Station 的组合站名。"""
    if not isinstance(raw_map, Mapping):
        return {}
    result: Dict[str, Any] = {}
    for group_name, raw_slots in raw_map.items():
        if not isinstance(raw_slots, Mapping):
            continue
        slots: Dict[str, Any] = {}
        for slot_id, raw_candidates in raw_slots.items():
            if not isinstance(raw_candidates, list):
                continue
            candidates = [
                deepcopy(dict(candidate))
                for candidate in raw_candidates
                if isinstance(candidate, Mapping)
                and str(candidate.get("Key") or "") in station_names
            ]
            if candidates:
                slots[str(slot_id)] = candidates
        if slots:
            result[str(group_name)] = slots
    return result


def build_task_alg_init(
    device: Mapping[str, Any],
    routes: Sequence[Mapping[str, Any]],
    rounds: Sequence[Mapping[str, Any]],
    cleans: Sequence[Mapping[str, Any]] = (),
) -> Dict[str, Any]:
    """构造仅包含当前任务所用模块及其 Robot 引用的 AlgInit 副本。"""
    result = extract_init_data(device)
    stations = result.get("Stations") or {}
    robots = result.get("Robots") or {}
    requested_names = _task_module_names(routes, rounds, cleans)

    # Route 可以引用 SlotsStationMap 的组合站名，需要展开到实际 Station。
    for robot in robots.values():
        if not isinstance(robot, Mapping):
            continue
        for arm in (robot.get("ArmInfo") or {}).values():
            if not isinstance(arm, Mapping):
                continue
            for group_name, station_slots in (arm.get("SlotsStationMap") or {}).items():
                if str(group_name) not in requested_names or not isinstance(station_slots, Mapping):
                    continue
                for candidates in station_slots.values():
                    if isinstance(candidates, list):
                        requested_names.update(
                            str(candidate.get("Key") or "")
                            for candidate in candidates
                            if isinstance(candidate, Mapping) and candidate.get("Key")
                        )
    if "DummyPort" in requested_names:
        requested_names.update(
            str(name)
            for name, station in stations.items()
            if isinstance(station, Mapping)
            and str(station.get("Type") or "").casefold() == "dummyport"
        )

    used_stations = requested_names & {str(name) for name in stations}
    used_robots = requested_names & {str(name) for name in robots}
    result["Stations"] = {
        str(name): deepcopy(station)
        for name, station in stations.items()
        if str(name) in used_stations
    }
    result["Robots"] = {
        str(name): deepcopy(robot)
        for name, robot in robots.items()
        if str(name) in used_robots
    }

    for station in result["Stations"].values():
        if not isinstance(station, dict):
            continue
        for field_name in (
            "PickPrepareTime", "PickCompleteTime", "PlacePrepareTime",
            "PlaceCompleteTime", "PostCompleteTime",
        ):
            timing = station.get(field_name)
            if isinstance(timing, Mapping):
                station[field_name] = {
                    str(name): deepcopy(value)
                    for name, value in timing.items()
                    if str(name) in used_robots
                }

    for robot in result["Robots"].values():
        if not isinstance(robot, dict):
            continue
        for field_name in ("PickTime", "PlaceTime"):
            timing = robot.get(field_name)
            if isinstance(timing, Mapping):
                robot[field_name] = {
                    str(name): deepcopy(value)
                    for name, value in timing.items()
                    if str(name) in used_stations
                }
        transfers = robot.get("PrepTransTime")
        if isinstance(transfers, list):
            robot["PrepTransTime"] = [
                deepcopy(dict(row))
                for row in transfers
                if isinstance(row, Mapping)
                and str(row.get("SrcStation") or "") in used_stations
                and str(row.get("DestStation") or "") in used_stations
            ]
        retained_groups: set[str] = set()
        arm_info = robot.get("ArmInfo")
        if isinstance(arm_info, Mapping):
            for arm in arm_info.values():
                if not isinstance(arm, dict):
                    continue
                arm["AccessibleStations"] = [
                    str(name)
                    for name in arm.get("AccessibleStations") or []
                    if str(name) in used_stations
                ]
                arm["SlotsStationMap"] = _filtered_arm_station_map(
                    arm.get("SlotsStationMap"), used_stations,
                )
                retained_groups.update(arm["SlotsStationMap"])
                current_station = str(arm.get("SlotAtStation") or "")
                if current_station not in used_stations and current_station not in retained_groups:
                    arm["SlotAtStation"] = (
                        arm["AccessibleStations"][0] if arm["AccessibleStations"] else ""
                    )
        pointer_names = used_stations | retained_groups
        if isinstance(robot.get("ArmPointerPair"), list):
            robot["ArmPointerPair"] = [
                deepcopy(pair)
                for pair in robot["ArmPointerPair"]
                if isinstance(pair, list)
                and all(str(name) in pointer_names for name in pair)
            ]
    return result


def _name_index(rows: Sequence[Mapping[str, Any]], label: str) -> Dict[str, Dict[str, Any]]:
    """按唯一 Name 建立通用配置索引。"""
    result: Dict[str, Dict[str, Any]] = {}
    for index, row in enumerate(rows, start=1):
        name = str(row.get("name") or "").strip()
        if not name:
            raise ValueError(f"{label} 第 {index} 项缺少名称")
        if name in result:
            raise ValueError(f"{label} 名称重复：{name}")
        result[name] = deepcopy(dict(row))
    return result


def _recipe_index(rows: Sequence[Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """按 Recipe 名称建立引用索引，允许同名 Recipe 为不同模块定义不同参数。"""
    result: Dict[str, Dict[str, Any]] = {}
    modules_by_name: Dict[str, set[str]] = {}
    for index, row in enumerate(rows, start=1):
        name = str(row.get("name") or "").strip()
        if not name:
            raise ValueError(f"Recipe 第 {index} 项缺少名称")
        module_list = _string_list(row.get("modules"))
        modules = set(module_list)
        if name not in result:
            result[name] = deepcopy(dict(row))
            result[name]["modules"] = module_list
            modules_by_name[name] = modules
            continue
        occupied_modules = modules_by_name[name]
        duplicate_modules = sorted(occupied_modules & modules)
        if duplicate_modules or not occupied_modules or not modules:
            detail = f"（模块：{','.join(duplicate_modules)}）" if duplicate_modules else ""
            raise ValueError(f"Recipe 名称和模块重复：{name}{detail}")
        occupied_modules.update(modules)
        result[name]["modules"] = [
            *result[name]["modules"],
            *(module for module in module_list if module not in result[name]["modules"]),
        ]
    return result


def _string_list(value: Any) -> List[str]:
    """把数组或逗号分隔文本收敛为去重字符串列表。"""
    if isinstance(value, str):
        items = value.replace("，", ",").split(",")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        items = value
    else:
        items = []
    result: List[str] = []
    for item in items:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def _slot_list(value: Any) -> List[int]:
    """解析 Route Visit 使用的一基槽位列表。"""
    slots: List[int] = []
    for item in _string_list(value):
        try:
            slot = int(item)
        except ValueError:
            continue
        if slot >= FIRST_SLOT_ID and slot not in slots:
            slots.append(slot)
    return slots or [FIRST_SLOT_ID]


def _station_slot_ids(station: Mapping[str, Any]) -> List[int]:
    """从站点配置读取真实物理槽位编号。"""
    raw_slots = station.get("Slots")
    if isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
        return [int(item) for item in raw_slots]
    capacity = _finite_number(station.get("Capacity"), 0)
    if capacity >= 1:
        return list(range(1, int(capacity) + 1))
    return [FIRST_SLOT_ID]


def _robot_slot_ids(robot: Mapping[str, Any]) -> List[int]:
    """从启用 Arm 收集机器人全部物理手槽，缺失时按 Capacity 补齐。"""
    slots: set[int] = set()
    arm_info = robot.get("ArmInfo")
    if isinstance(arm_info, Mapping):
        for arm in arm_info.values():
            if not isinstance(arm, Mapping) or arm.get("IsEnable") is False:
                continue
            for value in arm.get("SlotIDs") or []:
                try:
                    slot_id = int(value)
                except (TypeError, ValueError):
                    continue
                if slot_id >= FIRST_SLOT_ID:
                    slots.add(slot_id)
    if slots:
        return sorted(slots)
    capacity = int(_finite_number(robot.get("Capacity"), 0))
    return list(range(FIRST_SLOT_ID, capacity + FIRST_SLOT_ID)) if capacity >= 1 else [FIRST_SLOT_ID]


def _finite_number(value: Any, default: float) -> float:
    """读取有限浮点数，非法值回退默认值。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _clean_type(clean: Mapping[str, Any]) -> str:
    """识别精简 Clean 类别，并兼容旧版任务字段。"""
    explicit = "".join(
        char
        for char in str(clean.get("cleanType") or clean.get("category") or "").lower()
        if char not in "-_ "
    )
    aliases = {
        "preclean": "preclean",
        "postclean": "postclean",
        "wacclean": "wacclean",
        "dummy": "dummy",
        "dummyclean": "dummy",
        "dummywac": "dummywac",
        "dummywacclean": "dummywac",
    }
    if explicit in aliases:
        return aliases[explicit]
    signature = (
        f"{clean.get('taskName') or ''} {clean.get('name') or ''}"
    ).lower()
    if (
        ("dummy" in signature and "wac" in signature)
        or "prewac" in signature
        or clean.get("emptyRecipeRef")
    ):
        return "dummywac"
    if int(_finite_number(clean.get("materialCount"), 0)) > 0 or "dummy" in signature:
        return "dummy"
    if (
        str(clean.get("stateVariable") or "").lower() == "processcount"
        or "wac" in signature
    ):
        return "wacclean"
    if "post" in signature:
        return "postclean"
    return "preclean"


def _runtime_clean(clean: Mapping[str, Any]) -> Dict[str, Any]:
    """把精简编辑字段展开为标准 Clean 模板，同时保留显式适用腔室。"""
    value = deepcopy(dict(clean))
    name = str(value.get("name") or "").strip()
    clean_type = _clean_type(value)
    recipe_name = str(
        value.get("recipeRef") or value.get("recipeName") or f"{name}-Recipe"
    ).strip()
    trigger_count = max(
        1,
        int(_finite_number(
            value.get("triggerCount", value.get("lower")),
            5,
        )),
    )
    is_wac = clean_type == "wacclean"
    is_dummy = clean_type in {"dummy", "dummywac"}
    material_count = max(
        1,
        int(_finite_number(value.get("materialCount", value.get("triggerCount")), 2)),
    ) if is_dummy else 0
    task_names = {
        "preclean": "PreClean",
        "postclean": "PostClean",
        "wacclean": "WacClean",
        "dummy": "PreDummyClean",
        "dummywac": "PreWacClean",
    }
    value.update({
        "name": name,
        "cleanType": clean_type,
        "recipeName": recipe_name,
        "recipeRef": recipe_name,
        "recipeTime": max(0.0, _finite_number(value.get("recipeTime"), 0.0)),
        "modules": _string_list(value.get("modules")),
        "taskName": task_names[clean_type],
        "stateVariable": "ProcessCount" if is_wac else "IdleTime",
        "lower": trigger_count if is_wac else 0,
        "upper": DEFAULT_TRIGGER_UPPER,
        "triggerCount": material_count if is_dummy else trigger_count,
        "updateStateVariables": (
            ["ProcessCount"]
            if is_wac
            else ["IdleTime", "DummyCount"]
            if is_dummy
            else ["IdleTime"]
            if clean_type == "preclean"
            else []
        ),
        "materialCount": material_count,
        "dummyWaferCount": (
            max(1, int(_finite_number(
                value.get("dummyWaferCount"),
                DEFAULT_DUMMY_WAFER_COUNT,
            )))
            if is_dummy
            else 0
        ),
        "preJudge": False,
        "emptyRecipeRef": (
            str(value.get("emptyRecipeRef") or f"{recipe_name}-WAC").strip()
            if clean_type == "dummywac"
            else ""
        ),
        "wacRecipeTime": max(
            0.0,
            _finite_number(
                value.get("wacRecipeTime", value.get("emptyRecipeTime")),
                20.0,
            ),
        ),
    })
    return value


def _clean_condition(clean: Mapping[str, Any]) -> Dict[str, Any]:
    """把一个通用 Clean 模板展开成标准 ICleanCondition。"""
    clean = _runtime_clean(clean)
    alias = str(clean.get("name") or "").strip()
    state_variable = str(clean.get("stateVariable") or "IdleTime").strip() or "IdleTime"
    lower = _finite_number(clean.get("lower"), 0.0)
    upper = _finite_number(clean.get("upper"), DEFAULT_TRIGGER_UPPER)
    if upper < lower:
        raise ValueError(f"Clean {alias} 的触发上限小于下限")
    task = {
        "TaskName": str(clean.get("taskName") or alias).strip() or alias,
        "CleanRecipe": str(clean.get("recipeRef") or "").strip(),
        "UpdateStateVariables": _string_list(clean.get("updateStateVariables")),
        "MaterialCount": max(0, int(_finite_number(clean.get("materialCount"), 0))),
        "EmptyCleanRecipeAfterMaterial": str(clean.get("emptyRecipeRef") or "").strip(),
    }
    return {
        "CheckConditions": {alias: [task]},
        "ExecuteOrder": [{
            "StateVariableName": state_variable,
            "ThresholdValueList": [lower, upper],
            "PreJuge": bool(clean.get("preJudge", False)),
            "Alias": alias,
        }],
    }


def _clean_conditions(names: Any, clean_by_name: Mapping[str, Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """按引用名称复制 Clean 条件，引用不存在时立即报错。"""
    conditions: List[Dict[str, Any]] = []
    for name in _string_list(names):
        clean = clean_by_name.get(name)
        if clean is None:
            raise ValueError(f"Route 引用了不存在的 Clean：{name}")
        conditions.append(_clean_condition(clean))
    return conditions


def _clean_names_for_types(
    names: Any,
    clean_by_name: Mapping[str, Mapping[str, Any]],
    allowed_types: set[str],
) -> List[str]:
    """按清洁类别筛选引用，防止挂到不兼容的 Route 位置。"""
    result: List[str] = []
    for name in _string_list(names):
        clean = clean_by_name.get(name)
        if clean is None:
            raise ValueError(f"Route 引用了不存在的 Clean：{name}")
        if _clean_type(clean) in allowed_types:
            result.append(name)
    return result


def _clean_names_for_module(
    names: Any,
    clean_by_name: Mapping[str, Mapping[str, Any]],
    module: str,
) -> List[str]:
    """按 Clean 显式配置的适用腔室筛选引用。"""
    result: List[str] = []
    for name in _string_list(names):
        clean = clean_by_name.get(name)
        if clean is None:
            raise ValueError(f"Route 引用了不存在的 Clean：{name}")
        if module in _string_list(clean.get("modules")):
            result.append(name)
    return result


def _append_module_clean_conditions(
    table: Dict[str, List[Dict[str, Any]]],
    module: str,
    clean_names: Any,
    clean_by_name: Mapping[str, Mapping[str, Any]],
) -> None:
    """向指定腔室追加 Clean 条件并去重。"""
    if not module:
        return
    module_clean_names = _clean_names_for_module(
        clean_names,
        clean_by_name,
        module,
    )
    conditions = _clean_conditions(module_clean_names, clean_by_name)
    if not conditions:
        return
    target = table.setdefault(module, [])
    for condition in conditions:
        if condition not in target:
            target.append(condition)


def _dummy_accessible_pms(route: Mapping[str, Any]) -> List[str]:
    """按 Route 的带片清洁条件收集 Dummy 晶圆允许进入的腔室。"""
    modules: List[str] = []
    for module, conditions in (route.get("PrePJob") or {}).items():
        has_dummy_clean = any(
            int(_finite_number(task.get("MaterialCount"), 0)) > 0
            for condition in conditions or []
            if isinstance(condition, Mapping)
            for tasks in (condition.get("CheckConditions") or {}).values()
            for task in tasks or []
            if isinstance(task, Mapping)
        )
        module_name = str(module)
        if has_dummy_clean and module_name not in modules:
            modules.append(module_name)
    return modules


def _dummy_wafer_count(
    route: Mapping[str, Any],
    clean_by_name: Mapping[str, Mapping[str, Any]],
) -> int:
    """返回 Route 引用的 Dummy Clean 所配置的最大 DummyPort 库存数。"""
    counts = [
        max(1, int(_finite_number(
            clean_by_name[name].get("dummyWaferCount"),
            DEFAULT_DUMMY_WAFER_COUNT,
        )))
        for name in _string_list(route.get("prePJobCleanRefs"))
        if name in clean_by_name
        and _clean_type(clean_by_name[name]) in {"dummy", "dummywac"}
    ]
    return max(counts, default=0)


def _dummy_material(
    slot_id: int,
    dummy_port: str,
    accessible_pms: Sequence[str],
) -> Dict[str, Any]:
    """使用企业接口模板创建一片可复用的 DummyPort 库存晶圆。"""
    material_id = DUMMY_MATERIAL_ID_START + slot_id - FIRST_SLOT_ID
    return {
        "Name": str(slot_id),
        "AccessiblePM": list(accessible_pms),
        "TaskID": "",
        "FoupID": "",
        "ID": material_id,
        "LimitLevel1": DUMMY_MATERIAL_LIMIT_LEVEL,
        "LimitLevel2": DUMMY_MATERIAL_LIMIT_LEVEL,
        "Priority": -1,
        "StepID": 0,
        "LotID": "",
        "SlotID": slot_id,
        "NeedSchedule": True,
        "CurrentModuleName": dummy_port,
        "PJobName": "",
        "SrcPortName": dummy_port,
        "Usage": DUMMY_MATERIAL_USAGE_MIX,
        "Count": 0,
        "Route": {
            "Name": "",
            "RouteSteps": [],
            "BufferOption": -1,
            "BoundedStepIDs": [],
            "Group": "",
            "PrePJob": {},
            "PostPJob": {},
            "PostCJob": {},
        },
    }


def _integer_list(value: Any) -> List[int]:
    """把数组或逗号文本解析为去重整数列表。"""
    result: List[int] = []
    for item in _string_list(value):
        try:
            number = int(item)
        except ValueError:
            raise ValueError(f"无法解析整数列表项：{item}") from None
        if number not in result:
            result.append(number)
    return result


def _stage_visit_rows(stage: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """读取新 IVisit 编辑结构，并兼容旧版 Step 聚合字段。"""
    raw_visits = stage.get("visits")
    if isinstance(raw_visits, Sequence) and not isinstance(raw_visits, (str, bytes)):
        return [deepcopy(dict(visit)) for visit in raw_visits if isinstance(visit, Mapping)]
    return [{
        "stationName": station,
        "slotIds": stage.get("slots"),
        "processRecipe": stage.get("recipeRef"),
        "processTime": stage.get("processTime", stage.get("recipeTime", 0.0)),
        "recipeTime": stage.get("recipeTime", stage.get("processTime", 0.0)),
        "moveTimeOffset": {},
        "qTimeLimit": stage.get("qTime"),
        "residencyConstraint": stage.get("residency"),
        "afterCleanRefs": stage.get("afterCleanRefs"),
        "beforeCleanRefs": stage.get("beforeCleanRefs"),
    } for station in _string_list(stage.get("stations"))]


def _clean_target_modules(
    clean_names: Any,
    clean_by_name: Mapping[str, Mapping[str, Any]],
    recipe_by_name: Mapping[str, Mapping[str, Any]],
) -> List[str]:
    """读取 Clean 显式配置的 Route 顶层清洁目标。"""
    targets: List[str] = []
    for clean_name in _string_list(clean_names):
        clean = clean_by_name.get(clean_name)
        if clean is None:
            raise ValueError(f"Route 引用了不存在的 Clean：{clean_name}")
        recipe_name = str(clean.get("recipeRef") or "").strip()
        recipe = recipe_by_name.get(recipe_name)
        modules = _string_list(clean.get("modules"))
        if not modules and recipe:
            modules = _string_list(recipe.get("modules"))
        for module in modules:
            if module not in targets:
                targets.append(module)
    return targets


def _route_clean_dict(
    clean_names: Any,
    clean_by_name: Mapping[str, Mapping[str, Any]],
    recipe_by_name: Mapping[str, Mapping[str, Any]],
    allowed_types: Optional[set[str]] = None,
) -> Dict[str, List[Dict[str, Any]]]:
    """把 Route 顶层 Clean 引用展开为 PM 到条件列表的标准字典。"""
    if allowed_types is not None:
        clean_names = _clean_names_for_types(
            clean_names,
            clean_by_name,
            allowed_types,
        )
    conditions = _clean_conditions(clean_names, clean_by_name)
    return {
        module: deepcopy(conditions)
        for module in _clean_target_modules(clean_names, clean_by_name, recipe_by_name)
    }


def build_route(
    route: Mapping[str, Any],
    recipe_by_name: Mapping[str, Mapping[str, Any]],
    clean_by_name: Mapping[str, Mapping[str, Any]],
    robot_names: Optional[set[str]] = None,
    station_slots: Optional[Mapping[str, List[int]]] = None,
) -> Dict[str, Any]:
    """把控制台 Route 展开成解析器接受的标准 Route。"""
    route_name = str(route.get("name") or "").strip()
    stages = [stage for stage in (route.get("stages") or []) if isinstance(stage, Mapping)]
    if len(stages) < 2:
        raise ValueError(f"Route {route_name} 至少需要源和汇两个 Step")
    if len(stages) < 3 or len(stages) % 2 == 0:
        raise ValueError(f"Route {route_name} 的 Step 数必须是大于等于 3 的奇数")
    pre_pjob = _route_clean_dict(
        route.get("prePJobCleanRefs"),
        clean_by_name,
        recipe_by_name,
        {"preclean", "dummy", "dummywac"},
    )
    post_pjob = _route_clean_dict(
        route.get("postPJobCleanRefs"),
        clean_by_name,
        recipe_by_name,
        {"postclean"},
    )
    post_cjob = _route_clean_dict(
        route.get("postCJobCleanRefs"),
        clean_by_name,
        recipe_by_name,
        {"postclean"},
    )
    route_steps: List[Dict[str, Any]] = []
    for index, stage in enumerate(stages):
        visit_rows = _stage_visit_rows(stage)
        stations = [
            str(visit.get("stationName") or visit.get("StationName") or "").strip()
            for visit in visit_rows
        ]
        if not stations or any(not station for station in stations):
            raise ValueError(f"Route {route_name} 的 Step {index} 没有完整 Visit StationName")
        if robot_names is not None:
            contains_robot = [station in robot_names for station in stations]
            expected_robot = index % 2 == 1
            if any(contains_robot) != all(contains_robot):
                raise ValueError(f"Route {route_name} 的 Step {index} 混用了 Robot 和 Station")
            if bool(contains_robot[0]) != expected_robot:
                expected = "Robot" if expected_robot else "Station"
                raise ValueError(f"Route {route_name} 的 Step {index} 必须填写 {expected}")
        visits: List[Dict[str, Any]] = []
        for visit_index, (station, visit) in enumerate(zip(stations, visit_rows)):
            recipe_name = str(visit.get("processRecipe") or visit.get("ProcessRecipe") or "").strip()
            if index % 2 == 1 and recipe_name:
                raise ValueError(f"Route {route_name} 的 Robot Step {index} Visit 不能引用 Recipe")
            if recipe_name and recipe_name not in recipe_by_name:
                raise ValueError(f"Route {route_name} Visit 引用了不存在的 Recipe：{recipe_name}")
            move_offsets = visit.get("moveTimeOffset") or visit.get("MoveTimeOffset") or {}
            if isinstance(move_offsets, str):
                try:
                    move_offsets = json.loads(move_offsets or "{}")
                except json.JSONDecodeError:
                    raise ValueError(
                        f"Route {route_name} Step {index} Visit {visit_index} 的 MoveTimeOffset 不是有效 JSON"
                    ) from None
            if not isinstance(move_offsets, Mapping):
                raise ValueError(f"Route {route_name} Step {index} Visit {visit_index} 的 MoveTimeOffset 必须是对象")
            before_names = visit.get("beforeCleanRefs") or visit.get("BeforeInPM")
            after_names = visit.get("afterCleanRefs") or visit.get("AfterOutPM")
            before_pjob_names = _clean_names_for_types(
                before_names,
                clean_by_name,
                {"preclean", "dummy", "dummywac"},
            )
            after_pjob_names = _clean_names_for_types(
                after_names,
                clean_by_name,
                {"postclean"},
            )
            after_wac_names = _clean_names_for_types(
                after_names,
                clean_by_name,
                {"wacclean"},
            )
            after_wac_names = _clean_names_for_module(
                after_wac_names,
                clean_by_name,
                station,
            )
            if recipe_name:
                _append_module_clean_conditions(
                    pre_pjob,
                    station,
                    before_pjob_names,
                    clean_by_name,
                )
                _append_module_clean_conditions(
                    post_pjob,
                    station,
                    after_pjob_names,
                    clean_by_name,
                )
            slot_id = _slot_list(visit.get("slotIds") or visit.get("SlotID"))
            if station_slots and str(station) in station_slots and sorted(slot_id) == [FIRST_SLOT_ID]:
                slot_id = list(station_slots[str(station)])
            visits.append({
                "SlotID": slot_id,
                "StationName": station,
                "ProcessRecipe": recipe_name,
                "MoveTimeOffset": deepcopy(dict(move_offsets)),
                "QTimeLimit": _finite_number(visit.get("qTimeLimit", visit.get("QTimeLimit")), -1.0),
                "ResidencyConstraint": _finite_number(
                    visit.get("residencyConstraint", visit.get("ResidencyConstraint")), -1.0,
                ),
                "AfterOutPM": _clean_conditions(after_wac_names, clean_by_name),
                "BeforeInPM": [],
            })
        step_id = int(_finite_number(stage.get("stepId", stage.get("StepID")), index))
        explicit_post = stage.get("postStepIds", stage.get("PostStepID"))
        post_step_ids = (
            _integer_list(explicit_post)
            if explicit_post is not None
            else ([index + 1] if index + 1 < len(stages) else [])
        )
        need_process = bool(stage.get("needProcess", stage.get("NeedProcess", any(
            visit["ProcessRecipe"] for visit in visits
        ))))
        route_steps.append({
            "StepID": step_id,
            "PostStepID": post_step_ids,
            "NeedProcess": need_process,
            "Visits": visits,
        })
    step_ids = [step["StepID"] for step in route_steps]
    if len(step_ids) != len(set(step_ids)):
        raise ValueError(f"Route {route_name} 的 StepID 重复")
    unknown_posts = sorted({post for step in route_steps for post in step["PostStepID"] if post not in step_ids})
    if unknown_posts:
        raise ValueError(f"Route {route_name} 的 PostStepID 不存在：{unknown_posts}")
    raw_buffer_option = route.get("bufferOption", 0)
    try:
        numeric_buffer_option = float(raw_buffer_option)
    except (TypeError, ValueError):
        raise ValueError(
            f"Route {route_name} 的 BufferOption 必须是 0~4 的整数"
        ) from None
    buffer_option = int(numeric_buffer_option)
    if (
        not math.isfinite(numeric_buffer_option)
        or numeric_buffer_option != buffer_option
        or not 0 <= buffer_option <= 4
    ):
        raise ValueError(f"Route {route_name} 的 BufferOption 必须是 0~4 的整数")
    return {
        "Name": route_name,
        "RouteSteps": route_steps,
        "BufferOption": buffer_option,
        "BoundedStepIDs": [],
        "Group": str(route.get("group") or route_name).strip() or route_name,
        "PrePJob": pre_pjob,
        "PostPJob": post_pjob,
        "PostCJob": post_cjob,
    }


def build_process_recipes(
    recipes: Sequence[Mapping[str, Any]],
    routes: Sequence[Mapping[str, Any]],
    cleans: Sequence[Mapping[str, Any]] = (),
) -> List[Dict[str, Any]]:
    """把通用 Recipe 按适用模块展开成标准 IProcessRecipe 列表。

    公司标准用 ``ProcessRecipe.Weight`` 更新 CleanCondition 引用的计数器。
    页面只编辑 Clean 类别，因此这里根据 Route 的 Clean 引用为产品 Recipe
    补齐相应计数器；用户显式提供的权重优先，绝不覆盖。
    """
    derived_modules: Dict[str, List[str]] = {}
    required_weights: Dict[Tuple[str, str], set[str]] = {}
    clean_by_name = {
        str(clean.get("name") or "").strip(): _runtime_clean(clean)
        for clean in cleans
        if str(clean.get("name") or "").strip()
    }
    for route in routes:
        for stage in route.get("stages") or []:
            if not isinstance(stage, Mapping):
                continue
            visit_rows = _stage_visit_rows(stage)
            for visit in visit_rows:
                recipe_name = str(
                    visit.get("processRecipe") or visit.get("ProcessRecipe") or ""
                ).strip()
                module = str(visit.get("stationName") or visit.get("StationName") or "").strip()
                if not recipe_name or not module:
                    continue
                derived_modules.setdefault(recipe_name, [])
                if module not in derived_modules[recipe_name]:
                    derived_modules[recipe_name].append(module)
                clean_names = [
                    *_string_list(visit.get("beforeCleanRefs") or visit.get("BeforeInPM")),
                    *_string_list(visit.get("afterCleanRefs") or visit.get("AfterOutPM")),
                ]
                for clean_name in clean_names:
                    clean = clean_by_name.get(clean_name)
                    if clean is None:
                        continue
                    if module not in _string_list(clean.get("modules")):
                        continue
                    state_variable = str(clean.get("stateVariable") or "").strip()
                    # IdleTime 由设备空闲时钟维护，不属于产品 Recipe 的增量。
                    if state_variable and state_variable != "IdleTime":
                        required_weights.setdefault((recipe_name, module), set()).add(
                            state_variable
                        )
    result: List[Dict[str, Any]] = []
    for recipe in recipes:
        name = str(recipe.get("name") or "").strip()
        modules = _string_list(recipe.get("modules")) or derived_modules.get(name, [])
        if not modules:
            continue
        weight = recipe.get("weight") or {}
        if isinstance(weight, str):
            try:
                weight = json.loads(weight or "{}")
            except json.JSONDecodeError:
                raise ValueError(f"Recipe {name} 的 Weight 不是有效 JSON") from None
        if not isinstance(weight, Mapping):
            raise ValueError(f"Recipe {name} 的 Weight 必须是对象")
        for module in modules:
            module_weight = deepcopy(dict(weight))
            for variable_name in sorted(required_weights.get((name, module), set())):
                module_weight.setdefault(variable_name, 1)
            result.append({
                "Time": max(0.0, _finite_number(recipe.get("time"), 0.0)),
                "ModuleName": module,
                "Name": name,
                "ProcessType": str(recipe.get("processType") or ""),
                "Weight": module_weight,
            })
    return result


def _load_port_capacity(tool_topo: Mapping[str, Any], name: str) -> int:
    """读取所选 LoadPort 容量，接口缺失时使用 25。"""
    station = (tool_topo.get("Stations") or {}).get(name) or {}
    try:
        return max(1, int(station.get("Capacity") or MAX_WAFERS_PER_JOB))
    except (TypeError, ValueError):
        return MAX_WAFERS_PER_JOB


def _enum_value(raw: Any, values: Mapping[str, int], field_name: str, default: str) -> int:
    """把页面枚举名称或兼容的整数值转换成后端枚举。"""
    if raw is None or raw == "":
        return values[default]
    if isinstance(raw, str) and raw in values:
        return values[raw]
    try:
        numeric = int(raw)
    except (TypeError, ValueError):
        numeric = -999
    if numeric in values.values():
        return numeric
    raise ValueError(f"{field_name} 不支持：{raw}")


def _round_cjob_rows(round_config: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """读取新 CJob/PJob 层级，并把旧版扁平 Job 兼容为一 Job 一 CJob。"""
    raw_cjobs = round_config.get("cjobs")
    if isinstance(raw_cjobs, Sequence) and not isinstance(raw_cjobs, (str, bytes)):
        return [deepcopy(dict(row)) for row in raw_cjobs if isinstance(row, Mapping)]
    rows: List[Dict[str, Any]] = []
    for index, job in enumerate(round_config.get("jobs") or [], start=1):
        if not isinstance(job, Mapping):
            continue
        name = str(job.get("name") or f"Job{index}").strip()
        pjob = deepcopy(dict(job))
        pjob["jobName"] = "P1"
        rows.append({
            "taskId": name,
            "jobType": job.get("jobType", 0),
            "priority": job.get("priority", 1),
            "taskMode": job.get("taskMode", 0),
            "pjobs": [pjob],
            "_legacyName": name,
        })
    return rows


def _round_pjob_count(round_config: Mapping[str, Any]) -> int:
    """返回一轮内的 PJob 数量，兼容旧版 jobs。"""
    cjobs = round_config.get("cjobs")
    if isinstance(cjobs, Sequence) and not isinstance(cjobs, (str, bytes)):
        return sum(len(cjob.get("pjobs") or []) for cjob in cjobs if isinstance(cjob, Mapping))
    return len([job for job in (round_config.get("jobs") or []) if isinstance(job, Mapping)])


def _instantiate_load_port_slots(route: Mapping[str, Any], slot_id: int) -> None:
    """把 Material 内嵌 Route 的首/末 LoadPort 步骤槽位实例化为晶圆所在槽位。

    标准 update 中 ``Material.Route`` 是实例化 Route：首站/末站（LoadPort）的
    ``Visits.SlotID`` 必须等于该晶圆当前所在槽位，而不是 Route 模板展开的站点
    全部槽位。``ProcessJob.OriginRoute`` 仍是模板，保持全量槽位不变；只有随
    Material 下发的实例化 Route 需要逐片改写。
    """
    route_steps = route.get("RouteSteps") or []
    for step_index in (0, len(route_steps) - 1):
        if 0 <= step_index < len(route_steps):
            for visit in route_steps[step_index].get("Visits") or []:
                if isinstance(visit, dict):
                    visit["SlotID"] = [int(slot_id)]


def build_round_update(
    plan: Mapping[str, Any],
    round_config: Mapping[str, Any],
    current_time: float,
    build_state: BuildState,
) -> Dict[str, Any]:
    """把一轮 ``CJob → PJob`` 展开成标准 IUpdateParams。"""
    recipes = [row for row in (plan.get("recipes") or []) if isinstance(row, Mapping)]
    cleans = [
        _runtime_clean(row)
        for row in (plan.get("cleans") or [])
        if isinstance(row, Mapping)
    ]
    routes = [row for row in (plan.get("routes") or []) if isinstance(row, Mapping)]
    recipe_by_name = _recipe_index(recipes)
    clean_by_name = _name_index(cleans, "Clean")
    route_by_name = _name_index(routes, "Route")
    tool_topo = plan["device"]
    robot_names = {str(name) for name in (tool_topo.get("Robots") or {})}
    station_slots_map = {
        str(station_name): _station_slot_ids(station_data)
        for station_name, station_data in (tool_topo.get("Stations") or {}).items()
        if isinstance(station_data, Mapping)
    }
    station_slots_map.update({
        str(robot_name): _robot_slot_ids(robot_data)
        for robot_name, robot_data in (tool_topo.get("Robots") or {}).items()
        if isinstance(robot_data, Mapping)
    })
    built_routes = {
        name: build_route(route, recipe_by_name, clean_by_name, robot_names, station_slots_map)
        for name, route in route_by_name.items()
    }
    dummy_wafer_count_by_route = {
        name: _dummy_wafer_count(route, clean_by_name)
        for name, route in route_by_name.items()
    }
    dummy_accessible_pms: List[str] = []
    for route in built_routes.values():
        for module in _dummy_accessible_pms(route):
            if module not in dummy_accessible_pms:
                dummy_accessible_pms.append(module)
    cjobs = _round_cjob_rows(round_config)
    if not cjobs:
        raise ValueError("每一轮至少需要一个 CJob")
    if len(cjobs) > 1 and any(
        _enum_value(
            cjob.get("taskMode", cjob.get("TaskMode")),
            TASK_MODE_VALUES,
            "TaskMode",
            "Smart",
        ) in {TASK_MODE_VALUES["Pipeline"], TASK_MODE_VALUES["Sequential"]}
        for cjob in cjobs
    ):
        raise ValueError("Pipeline/Sequential 每轮只能配置一个 ControlJob")

    materials: List[Dict[str, Any]] = []
    process_jobs: List[Dict[str, Any]] = []
    control_jobs: List[Dict[str, Any]] = []
    round_uses_dummy_material = False
    round_dummy_wafer_count = 0
    used_control_load_ports: Dict[str, str] = {}
    for cjob_index, cjob in enumerate(cjobs, start=1):
        task_id = str(cjob.get("taskId") or cjob.get("TaskID") or cjob_index).strip()
        if task_id in build_state.task_ids:
            raise ValueError(f"ControlJob TaskID 跨轮或同轮重复：{task_id}")
        build_state.task_ids.add(task_id)
        pjobs = [row for row in (cjob.get("pjobs") or []) if isinstance(row, Mapping)]
        if not pjobs:
            raise ValueError(f"CJob {cjob_index} 至少需要一个 PJob")
        job_type = _enum_value(cjob.get("jobType", cjob.get("JobType")), CJOB_TYPE_VALUES, "JobType", "NormalLot")
        task_mode = _enum_value(cjob.get("taskMode", cjob.get("TaskMode")), TASK_MODE_VALUES, "TaskMode", "Smart")
        cjob_priority = max(1, int(_finite_number(cjob.get("priority"), 1))) if job_type == 0 else -1
        runtime_pjob_names: List[str] = []
        cjob_material_count = 0
        cjob_load_port = str(
            cjob.get("loadPort")
            or cjob.get("LoadPort")
            or ""
        ).strip()
        if cjob_load_port:
            load_port_definition = (tool_topo.get("Stations") or {}).get(cjob_load_port)
            if not isinstance(load_port_definition, Mapping):
                raise ValueError(f"CJob {cjob_index} 的 LoadPort 不存在：{cjob_load_port}")
            if str(load_port_definition.get("Type") or "").strip().lower() != "loadport":
                raise ValueError(f"CJob {cjob_index} 选择的站点不是 LoadPort：{cjob_load_port}")
        legacy_name = str(cjob.get("_legacyName") or "").strip()

        for pjob_index, pjob in enumerate(pjobs, start=1):
            display_name = str(pjob.get("jobName") or pjob.get("name") or f"P{pjob_index}").strip()
            pjob_name = f"{legacy_name}.P1" if legacy_name else f"{task_id}.C{cjob_index}.{display_name}"
            if pjob_name in build_state.job_names:
                raise ValueError(f"PJob 名称跨轮重复：{pjob_name}")
            build_state.job_names.add(pjob_name)
            runtime_pjob_names.append(pjob_name)
            origin_route = pjob.get("originRoute")
            if isinstance(origin_route, Mapping):
                origin_route = origin_route.get("name") or origin_route.get("Name")
            route_name = str(pjob.get("routeRef") or origin_route or "").strip()
            route = built_routes.get(route_name)
            if route is None:
                raise ValueError(f"PJob {display_name} 引用了不存在的 Route：{route_name}")
            pjob_load_port = str(
                pjob.get("loadPort")
                or pjob.get("LoadPort")
                or ""
            ).strip()
            load_port = cjob_load_port or pjob_load_port
            if load_port not in (tool_topo.get("Stations") or {}):
                raise ValueError(f"PJob {display_name} 的 LoadPort 不存在：{load_port}")
            if cjob_load_port and pjob_load_port and pjob_load_port != cjob_load_port:
                raise ValueError(
                    f"ControlJob TaskID={task_id} 的 PJob 必须使用同一个 LoadPort："
                    f"{cjob_load_port}、{pjob_load_port}"
                )
            cjob_load_port = load_port
            wafer_count = int(_finite_number(pjob.get("waferCount"), len(pjob.get("matList") or []) or 1))
            if wafer_count < 1 or wafer_count > MAX_WAFERS_PER_JOB:
                raise ValueError(f"PJob {display_name} 晶圆数必须为 1~{MAX_WAFERS_PER_JOB}")
            priority = max(1, int(_finite_number(pjob.get("priority"), 1)))
            runtime_route_name = f"{route_name}__{legacy_name or pjob_name}"
            runtime_route = deepcopy(route)
            round_uses_dummy_material = (
                round_uses_dummy_material
                or bool(_dummy_accessible_pms(runtime_route))
            )
            round_dummy_wafer_count = max(
                round_dummy_wafer_count,
                dummy_wafer_count_by_route.get(route_name, 0),
            )
            runtime_route["Name"] = runtime_route_name
            route_steps = runtime_route.get("RouteSteps") or []
            for step_index in (0, len(route_steps) - 1):
                if 0 <= step_index < len(route_steps):
                    for visit in route_steps[step_index].get("Visits") or []:
                        visit["StationName"] = load_port
            material_ids: List[int] = []
            next_slot = build_state.next_slot_by_port.get(load_port, 0)
            capacity = _load_port_capacity(tool_topo, load_port)
            if next_slot + wafer_count > capacity:
                raise ValueError(f"{load_port} 总片数超过容量 {capacity}")
            for _ in range(wafer_count):
                next_slot += 1
                material_id = build_state.next_material_id
                build_state.next_material_id += 1
                material_ids.append(material_id)
                material_route = deepcopy(runtime_route)
                # Material 内嵌 Route 是实例化 Route：首/末 LoadPort 步骤的
                # Visit 槽位必须指向该晶圆所在槽位，而不是模板展开的全部槽位。
                _instantiate_load_port_slots(material_route, next_slot)
                materials.append({
                    "Name": str(material_id), "ID": material_id, "TaskID": task_id,
                    "LotID": f"{task_id}.C{cjob_index}",
                    "FoupID": f"{task_id}-C{cjob_index}-{display_name}",
                    "Priority": priority, "StepID": 0, "CurrentModuleName": load_port,
                    "SlotID": next_slot, "NeedSchedule": True, "PJobName": pjob_name,
                    "SrcPortName": load_port, "Route": material_route,
                })
            build_state.next_slot_by_port[load_port] = next_slot
            process_jobs.append({
                "JobName": pjob_name, "TaskID": task_id, "Priority": priority,
                "State": 0, "OriginRoute": deepcopy(runtime_route), "MatList": material_ids,
            })
            cjob_material_count += wafer_count

        if cjob_load_port in used_control_load_ports:
            raise ValueError(
                f"不同 ControlJob 不能使用同一个 LoadPort：{cjob_load_port} "
                f"(TaskID={used_control_load_ports[cjob_load_port]}、{task_id})"
            )
        used_control_load_ports[cjob_load_port] = task_id
        control_jobs.append({
            "TaskID": task_id, "JobType": job_type, "Priority": cjob_priority,
            "TaskMode": task_mode, "PJobNameList": runtime_pjob_names,
            "MaterialCount": cjob_material_count,
        })
    # DummyPort 库存与 Clean 的 MaterialCount 独立，采用当前轮所引用的页面配置。
    dummy_material_count = round_dummy_wafer_count
    if round_uses_dummy_material and build_state.dummy_material_count < dummy_material_count:
        dummy_port = next(
            (
                str(name)
                for name, station in (tool_topo.get("Stations") or {}).items()
                if str((station or {}).get("Type") or "").lower() == "dummyport"
            ),
            "",
        )
        if not dummy_port:
            raise ValueError("Dummy / Dummy WAC 清洁需要设备配置 DummyPort")
        capacity = _load_port_capacity(tool_topo, dummy_port)
        if dummy_material_count > capacity:
            raise ValueError(
                f"DummyPort 容量不足：需要 {dummy_material_count} 片，容量 {capacity}"
            )
        for slot_id in range(
            build_state.dummy_material_count + FIRST_SLOT_ID,
            dummy_material_count + FIRST_SLOT_ID,
        ):
            materials.append(_dummy_material(slot_id, dummy_port, dummy_accessible_pms))
        build_state.dummy_material_count = dummy_material_count
    return {
        "Scenario": 0,
        "ProcessRecipes": build_process_recipes(recipes, routes, cleans),
        "Materials": materials, "ProcessJobs": process_jobs, "ControlJobs": control_jobs,
        "RemoveList": [], "MoveStates": [], "CurrentTime": float(current_time),
        # 标准 update 是当前设备快照而不只是新增 Job。首排时动态状态与 init 相同；
        # 重算调用方必须在发送前以真实执行现场覆盖这些字段。
        "Robots": deepcopy(dict(tool_topo.get("Robots") or {})),
        "Stations": deepcopy(dict(tool_topo.get("Stations") or {})),
        "InitialMoveID": int(tool_topo.get("InitialMoveID") or 0),
    }
