"""工作区设备、Route、测试组和测试集应用服务。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.time_utils import _workspace_timestamp
from realtime_scheduler.backend.workspace.repository import *
from realtime_scheduler.backend.execution.cjob_cycle import _cjob_cycle_count
from realtime_scheduler.backend.execution.batch_service import _invalidate_stale_device_baselines

def delete_workspace_device(device_id: str, path: Path = WORKSPACE_STORE_PATH) -> Dict[str, Any]:
    """从本地工作区删除一台设备及其全部测试集，并返回被删除设备的摘要。

    设备删除后不可恢复：目录模式会移除设备 UUID 目录及其中全部测试集。
    设备不存在时抛出明确错误；已被历史批量任务引用的设备不会
    改写历史记录。
    """
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        catalog["devices"] = [
            item for item in catalog["devices"]
            if not (isinstance(item, Mapping) and str(item.get("id")) == device_id)
        ]
        # 先物理删除设备目录再写目录：即使中途中断，下次扫描也不会复活该设备。
        _remove_directory_device_dir(path, device_id)
        _write_workspace_catalog_unlocked(path, catalog)
        return {
            "id": device_id,
            "name": str(device.get("name") or "未命名设备"),
            "testCount": len(device.get("tests") or []),
        }


def robot_available_slots(robot: Mapping[str, Any]) -> List[int]:
    """返回机器手可配置的 Arm 槽位编号。

    ``ArmInfo.*.SlotIDs`` 是实际 Arm 定义。只要存在 ArmInfo，编辑器就允许在单臂与
    双臂间切换；``CanMultiTrans`` 不参与臂数判断，Robot 本身也不写入 Slot。
    """
    slots: set[int] = set()

    def add_slots(raw_slots: Any, *, scalar_is_capacity: bool = False) -> None:
        """把一种槽位表达加入集合，忽略布尔值和非正整数。"""
        if isinstance(raw_slots, bool):
            return
        if isinstance(raw_slots, int):
            values = (
                range(FIRST_ROBOT_SLOT_ID, raw_slots + FIRST_ROBOT_SLOT_ID)
                if scalar_is_capacity else [raw_slots]
            )
        elif isinstance(raw_slots, Mapping):
            values = raw_slots.keys()
        elif isinstance(raw_slots, Sequence) and not isinstance(raw_slots, (str, bytes)):
            values = raw_slots
        else:
            return
        for value in values:
            try:
                slot_id = int(value)
            except (TypeError, ValueError):
                continue
            if slot_id >= FIRST_ROBOT_SLOT_ID:
                slots.add(slot_id)

    arm_info = robot.get("ArmInfo")
    if isinstance(arm_info, Mapping):
        for arm in arm_info.values():
            if isinstance(arm, Mapping):
                add_slots(arm.get("SlotIDs"))
        if any(isinstance(arm, Mapping) for arm in arm_info.values()):
            slots.update(range(FIRST_ROBOT_SLOT_ID, DUAL_ARM_SLOT_COUNT + FIRST_ROBOT_SLOT_ID))
    add_slots(robot.get("Capacity"), scalar_is_capacity=True)
    return sorted(slots or {FIRST_ROBOT_SLOT_ID})


def robot_default_slots(robot: Mapping[str, Any]) -> List[int]:
    """按原始 ``ArmInfo`` 返回设备文件默认启用的 Arm 槽位。"""
    selected: set[int] = set()
    available = robot_available_slots(robot)
    arm_info = robot.get("ArmInfo")
    if isinstance(arm_info, Mapping):
        for arm in arm_info.values():
            if not isinstance(arm, Mapping) or arm.get("IsEnable") is False:
                continue
            raw_slots = arm.get("SlotIDs")
            if not isinstance(raw_slots, Sequence) or isinstance(raw_slots, (str, bytes)):
                continue
            for value in raw_slots:
                try:
                    selected.add(int(value))
                except (TypeError, ValueError):
                    continue
    explicit = sorted(
        slot_id
        for slot_id in selected
        if slot_id >= FIRST_ROBOT_SLOT_ID and slot_id in available
    )
    return explicit or available[:1]


def _project_robot_arm_to_slots(
    arm_name: str,
    source_arm: Mapping[str, Any],
    slot_ids: Sequence[int],
) -> Dict[str, Any]:
    """复制一个物理 Arm，并保留所选的一个或多个 RobotSlot。"""
    arm = deepcopy(dict(source_arm))
    arm["Name"] = arm_name
    arm["IsEnable"] = True
    selected = sorted({int(slot_id) for slot_id in slot_ids})
    arm["SlotIDs"] = selected
    slot_station_map = arm.get("SlotsStationMap")
    if isinstance(slot_station_map, dict):
        for station_name, station_slots in list(slot_station_map.items()):
            if not isinstance(station_slots, Mapping) or not station_slots:
                continue
            fallback = next(iter(station_slots.values()))
            slot_station_map[station_name] = {
                str(slot_id): deepcopy(station_slots.get(str(slot_id), fallback))
                for slot_id in selected
            }
    return arm


def _generated_robot_arm_name(existing_names: Iterable[str], slot_id: int) -> str:
    """为设备文件缺少的第二个 Arm 生成稳定且不冲突的名称。"""
    occupied = {str(name) for name in existing_names}
    alphabetic_name = f"Arm{chr(ord('A') + slot_id - FIRST_ROBOT_SLOT_ID)}"
    if alphabetic_name not in occupied:
        return alphabetic_name
    numeric_name = f"Arm{slot_id}"
    if numeric_name not in occupied:
        return numeric_name
    suffix = slot_id
    while f"{numeric_name}_{suffix}" in occupied:
        suffix += 1
    return f"{numeric_name}_{suffix}"


def normalize_robot_slot_selection(
    device_data: Mapping[str, Any],
    raw_selection: Any,
) -> Dict[str, List[int]]:
    """校验并补齐每台机器手的槽位选择。

    未显式配置的机器手沿用原始 ``ArmInfo`` 默认模式。配置必须至少保留一个槽位，且不能
    引用设备能力之外的槽位或未知机器手。
    """
    robots = device_data.get("Robots")
    if not isinstance(robots, Mapping):
        raise ValueError("设备文件必须包含 Robots")
    selection = raw_selection if isinstance(raw_selection, Mapping) else {}
    unknown_names = sorted(str(name) for name in selection if str(name) not in robots)
    if unknown_names:
        raise ValueError(f"机器手不存在：{', '.join(unknown_names)}")
    normalized: Dict[str, List[int]] = {}
    for robot_name, raw_robot in robots.items():
        if not isinstance(raw_robot, Mapping):
            continue
        available = robot_available_slots(raw_robot)
        raw_slots = selection.get(robot_name, robot_default_slots(raw_robot))
        if not isinstance(raw_slots, Sequence) or isinstance(raw_slots, (str, bytes)):
            raise ValueError(f"{robot_name} 的槽位配置必须是数组")
        selected = sorted({
            int(slot_id)
            for slot_id in raw_slots
            if not isinstance(slot_id, bool)
            and isinstance(slot_id, (int, float))
            and float(slot_id).is_integer()
        })
        if not selected:
            raise ValueError(f"{robot_name} 至少需要保留一个可用槽位")
        unavailable = [slot_id for slot_id in selected if slot_id not in available]
        if unavailable:
            raise ValueError(
                f"{robot_name} 不支持槽位：{', '.join(map(str, unavailable))}"
            )
        normalized[str(robot_name)] = selected
    return normalized


def apply_robot_slot_selection(
    device_data: Dict[str, Any],
    raw_selection: Any,
) -> Dict[str, List[int]]:
    """将 Arm 槽位选择投影到运行时 ``ArmInfo`` 并返回规范化结果。

    同一原始 Arm 的多个 SlotID 保持在同一个 Arm 下，因此双腔设备的一条物理臂可继续
    同时承载两片晶圆。投影只调整 ``Capacity`` 与 ``ArmInfo``，不会创建 Robot.Slot，
    也不会改写与 Arm 数量无关的 ``CanMultiTrans``。
    """
    normalized = normalize_robot_slot_selection(device_data, raw_selection)
    robots = device_data.get("Robots")
    if not isinstance(robots, dict):
        return normalized
    for robot_name, selected in normalized.items():
        robot = robots.get(robot_name)
        if not isinstance(robot, dict):
            continue
        robot["Capacity"] = len(selected)
        arm_info = robot.get("ArmInfo")
        if not isinstance(arm_info, dict):
            continue
        source_arms = [
            (str(arm_name), arm)
            for arm_name, arm in arm_info.items()
            if isinstance(arm, Mapping)
        ]
        if not source_arms:
            continue
        projected_arms: Dict[str, Dict[str, Any]] = {}
        unmatched_slots = set(selected)
        for arm_name, source_arm in source_arms:
            source_slots = {
                int(value)
                for value in (source_arm.get("SlotIDs") or [])
                if isinstance(value, int) and not isinstance(value, bool)
            }
            retained_slots = sorted(unmatched_slots.intersection(source_slots))
            if not retained_slots:
                continue
            projected_arms[arm_name] = _project_robot_arm_to_slots(
                arm_name, source_arm, retained_slots,
            )
            unmatched_slots.difference_update(retained_slots)
        for slot_id in sorted(unmatched_slots):
            arm_name = _generated_robot_arm_name(
                [*arm_info.keys(), *projected_arms.keys()], slot_id,
            )
            projected_arms[arm_name] = _project_robot_arm_to_slots(
                arm_name, source_arms[0][1], [slot_id],
            )
        robot["ArmInfo"] = projected_arms
    return normalized


def update_workspace_robot_slots(
    device_id: str,
    raw_selection: Any,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, List[int]]:
    """保存设备级机器手槽位选择，并使依赖旧拓扑的 Baseline 失效。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        device_data = device.get("device")
        if not isinstance(device_data, Mapping):
            raise ValueError("设备拓扑无效")
        normalized = normalize_robot_slot_selection(device_data, raw_selection)
        device["robotSlots"] = normalized
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(normalized)


def _device_time_value(raw_value: Any, label: str) -> float:
    """把设备时间规范为非负有限秒数；无效值使用带字段上下文的错误拒绝。"""
    if isinstance(raw_value, bool):
        raise ValueError(f"{label} 必须是非负秒数")
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} 必须是非负秒数") from None
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} 必须是非负有限秒数")
    return value


def _apply_time_mapping_updates(
    target: Dict[str, Any],
    raw_values: Any,
    label: str,
) -> None:
    """校验并覆盖已有计时映射，禁止借时间接口新增未知 Robot、Station 或 Slot。"""
    if not isinstance(raw_values, Mapping):
        raise ValueError(f"{label} 必须是对象")
    unknown_keys = sorted(str(key) for key in raw_values if str(key) not in target)
    if unknown_keys:
        raise ValueError(f"{label} 包含未知项：{', '.join(unknown_keys)}")
    for key, raw_value in raw_values.items():
        normalized_key = str(key)
        target[normalized_key] = _device_time_value(
            raw_value,
            f"{label}.{normalized_key}",
        )


def _apply_time_sequence_updates(
    target: List[Any],
    raw_values: Any,
    label: str,
) -> None:
    """按原设备声明顺序覆盖转移时间，仅修改每条记录的 Time 并保留其余协议字段。"""
    if not isinstance(raw_values, Sequence) or isinstance(raw_values, (str, bytes)):
        raise ValueError(f"{label} 必须是数组")
    if len(raw_values) != len(target):
        raise ValueError(f"{label} 数量与设备定义不一致")
    for index, raw_value in enumerate(raw_values):
        row = target[index]
        if not isinstance(row, dict):
            raise ValueError(f"{label}[{index}] 不是有效计时记录")
        row["Time"] = _device_time_value(raw_value, f"{label}[{index}].Time")


def apply_device_timing_updates(device_data: Dict[str, Any], raw_timing: Any) -> None:
    """把页面提交的站点与机器手时间应用到设备拓扑，并严格限制可编辑字段。"""
    if not isinstance(raw_timing, Mapping):
        raise ValueError("设备时间配置必须是对象")
    sections = {
        "stations": (
            device_data.get("Stations"),
            STATION_TIME_MAPPING_FIELDS,
            STATION_TIME_SEQUENCE_FIELDS,
        ),
        "robots": (
            device_data.get("Robots"),
            ROBOT_TIME_MAPPING_FIELDS,
            ROBOT_TIME_SEQUENCE_FIELDS,
        ),
    }
    unknown_sections = sorted(str(key) for key in raw_timing if str(key) not in sections)
    if unknown_sections:
        raise ValueError(f"设备时间配置包含未知分类：{', '.join(unknown_sections)}")

    for section_name, raw_items in raw_timing.items():
        topology_items, mapping_fields, sequence_fields = sections[str(section_name)]
        if not isinstance(topology_items, dict):
            raise ValueError(f"设备缺少 {section_name} 定义")
        if not isinstance(raw_items, Mapping):
            raise ValueError(f"{section_name} 时间配置必须是对象")
        unknown_names = sorted(str(name) for name in raw_items if str(name) not in topology_items)
        if unknown_names:
            raise ValueError(f"{section_name} 包含未知设备：{', '.join(unknown_names)}")
        for item_name, raw_fields in raw_items.items():
            normalized_name = str(item_name)
            target_item = topology_items[normalized_name]
            if not isinstance(target_item, dict) or not isinstance(raw_fields, Mapping):
                raise ValueError(f"{section_name}.{normalized_name} 时间配置无效")
            supported_fields = mapping_fields | sequence_fields
            unknown_fields = sorted(
                str(field_name)
                for field_name in raw_fields
                if str(field_name) not in supported_fields
            )
            if unknown_fields:
                raise ValueError(
                    f"{section_name}.{normalized_name} 包含不可编辑字段："
                    f"{', '.join(unknown_fields)}"
                )
            for field_name, raw_values in raw_fields.items():
                normalized_field = str(field_name)
                current_values = target_item.get(normalized_field)
                label = f"{section_name}.{normalized_name}.{normalized_field}"
                if normalized_field in mapping_fields:
                    if not isinstance(current_values, dict):
                        raise ValueError(f"{label} 不存在或不是计时映射")
                    _apply_time_mapping_updates(current_values, raw_values, label)
                else:
                    if not isinstance(current_values, list):
                        raise ValueError(f"{label} 不存在或不是计时数组")
                    _apply_time_sequence_updates(current_values, raw_values, label)


def update_workspace_device_timing(
    device_id: str,
    raw_timing: Any,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """保存设备级时间参数、刷新拓扑镜像，并使基于旧时间计算的 Baseline 失效。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        device_data = device.get("device")
        if not isinstance(device_data, dict):
            raise ValueError("设备拓扑无效")
        apply_device_timing_updates(device_data, raw_timing)
        device["fingerprint"] = _device_fingerprint(device_data)
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(device_data)



def import_workspace_device(
    name: str,
    raw_device: Any,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], bool]:
    """导入设备 init；相同拓扑通过指纹复用已有设备及其测试集。"""
    device_data = extract_init_data(raw_device)
    fingerprint = _device_fingerprint(device_data)
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        existing = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and (
                item.get("fingerprint") == fingerprint
                or (
                    isinstance(item.get("device"), Mapping)
                    and _device_fingerprint(item["device"]) == fingerprint
                )
            )
        ), None)
        if existing is not None:
            requested_name = Path(name).name.strip() or str(existing.get("name") or "未命名设备")
            existing["name"] = _unique_workspace_name(
                requested_name,
                (
                    str(item.get("name") or "")
                    for item in catalog["devices"]
                    if isinstance(item, Mapping) and item is not existing
                ),
            )
            existing["fingerprint"] = fingerprint
            existing["device"] = device_data
            existing["updatedAt"] = _workspace_timestamp()
            _write_workspace_catalog_unlocked(path, catalog)
            return deepcopy(dict(existing)), False
        if len(catalog["devices"]) >= MAX_WORKSPACE_DEVICE_COUNT:
            raise ValueError(f"设备数量不能超过 {MAX_WORKSPACE_DEVICE_COUNT} 台")
        timestamp = _workspace_timestamp()
        device = {
            "id": uuid.uuid4().hex,
            "name": _unique_workspace_name(
                Path(name).name or "未命名设备",
                (str(item.get("name") or "") for item in catalog["devices"] if isinstance(item, Mapping)),
            ),
            "fingerprint": fingerprint,
            "device": device_data,
            "routes": [],
            "cleans": [],
            "testGroups": [],
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "tests": [],
        }
        catalog["devices"].append(device)
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(device), True


def _normalize_workspace_pjob(
    raw: Mapping[str, Any],
    index: int,
    task_id: str,
    assigned_load_port: str = "",
) -> Dict[str, Any]:
    """规范化页面 PJob，并生成只读 JobName、TaskID 与 MatList。"""
    wafer_count = max(1, min(MAX_WAFERS_PER_JOB, int(_finite_number(
        raw.get("waferCount"), len(raw.get("matList") or raw.get("MatList") or []) or 1,
    ))))
    job_name = f"P{index}"
    origin_route = raw.get("originRoute", raw.get("OriginRoute"))
    if isinstance(origin_route, Mapping):
        origin_route = origin_route.get("name") or origin_route.get("Name")
    normalized = {
        "jobName": job_name,
        "taskId": task_id,
        "waferCount": wafer_count,
        "matList": list(range(1, wafer_count + 1)),
        "routeRef": str(raw.get("routeRef") or origin_route or ""),
        "loadPort": assigned_load_port or str(
            raw.get("loadPort") or raw.get("LoadPort") or ""
        ),
        "priority": max(1, int(_finite_number(raw.get("priority", raw.get("Priority")), 1))),
    }
    if isinstance(raw.get("routeConfig"), Mapping):
        normalized["routeConfig"] = deepcopy(dict(raw["routeConfig"]))
    return normalized


def _normalize_workspace_round(
    raw: Mapping[str, Any],
    index: int,
    current_time: float,
    first_task_id: int = 1,
    load_ports: Sequence[str] = (),
) -> Dict[str, Any]:
    """规范化一轮 CJob/PJob；旧版 jobs 合并到该轮唯一默认 CJob。"""
    raw_cjobs = raw.get("cjobs")
    if isinstance(raw_cjobs, Sequence) and not isinstance(raw_cjobs, (str, bytes)):
        cjob_rows = [row for row in raw_cjobs if isinstance(row, Mapping)]
    else:
        legacy_jobs = [row for row in (raw.get("jobs") or []) if isinstance(row, Mapping)]
        first = legacy_jobs[0] if legacy_jobs else {}
        cjob_rows = [{
            "jobType": first.get("jobType", "NormalLot"),
            "priority": first.get("priority", 1),
            "taskMode": first.get("taskMode", "Smart"),
            "pjobs": legacy_jobs or [{}],
        }]
    if not cjob_rows:
        cjob_rows = [{"pjobs": [{}]}]
    if load_ports and len(cjob_rows) > len(load_ports):
        raise ValueError(
            f"第 {index} 轮包含 {len(cjob_rows)} 个 CJob，"
            f"超过可自动分配的 LoadPort 数量 {len(load_ports)}"
        )
    task_modes = [
        _workspace_task_mode_name(row.get("taskMode", row.get("TaskMode", "Smart")))
        for row in cjob_rows
    ]
    if len(cjob_rows) > 1 and any(
        task_mode in {"Pipeline", "Sequential"}
        for task_mode in task_modes
    ):
        raise ValueError(
            f"第 {index} 轮使用 Pipeline/Sequential 时只能配置一个 CJob"
        )
    cjobs: List[Dict[str, Any]] = []
    assigned_load_ports: set[str] = set()
    for cjob_index, row in enumerate(cjob_rows, start=1):
        task_id = str(first_task_id + cjob_index - 1)
        raw_job_type = row.get("jobType", row.get("JobType", "NormalLot"))
        try:
            job_type_value = _enum_value(raw_job_type, CJOB_TYPE_VALUES, "JobType", "NormalLot")
        except ValueError:
            job_type_value = CJOB_TYPE_VALUES["NormalLot"]
        task_mode_name = task_modes[cjob_index - 1]
        task_mode_value = TASK_MODE_VALUES[task_mode_name]
        pjob_rows = [item for item in (row.get("pjobs") or []) if isinstance(item, Mapping)] or [{}]
        fallback_load_port = str(
            row.get("loadPort")
            or pjob_rows[0].get("loadPort")
            or pjob_rows[0].get("LoadPort")
            or ""
        )
        if fallback_load_port and load_ports and fallback_load_port not in load_ports:
            raise ValueError(
                f"第 {index} 轮 CJob {cjob_index} 的 LoadPort 不存在："
                f"{fallback_load_port}"
            )
        load_port = fallback_load_port or _automatic_workspace_load_port(
            load_ports,
            first_task_id + cjob_index - 1,
        )
        if load_port in assigned_load_ports:
            raise ValueError(
                f"第 {index} 轮多个 CJob 不能同时占用 LoadPort：{load_port}"
            )
        if load_port:
            assigned_load_ports.add(load_port)
        cjob_cycle = _cjob_cycle_count(row)
        pjobs = [
            _normalize_workspace_pjob(item, pjob_index, task_id, load_port)
            for pjob_index, item in enumerate(pjob_rows, start=1)
        ]
        cjobs.append({
            "taskId": task_id,
            "loadPort": load_port,
            "cjobCycle": cjob_cycle,
            "jobType": CJOB_TYPE_NAMES[job_type_value],
            "priority": max(1, int(_finite_number(row.get("priority", row.get("Priority")), 1))) if job_type_value == 0 else -1,
            "taskMode": TASK_MODE_NAMES[task_mode_value],
            "pJobNameList": [pjob["jobName"] for pjob in pjobs],
            "pjobs": pjobs,
            "key": str(row.get("key") or f"C{cjob_index}"),
        })
    return {"currentTime": 0.0 if index == 1 else float(current_time), "cjobs": cjobs}


def _normalize_test_case(
    raw_test: Mapping[str, Any],
    test_id: Optional[str] = None,
    load_ports: Sequence[str] = (),
) -> Dict[str, Any]:
    """保存只含排程任务的测试集结构，并兼容迁移旧版扁平 Job。"""
    timestamp = _workspace_timestamp()
    raw_rounds = [row for row in (raw_test.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = max(1, int(_finite_number(raw_test.get("roundCount"), len(raw_rounds) or 1)))
    times = deepcopy(list(raw_test.get("times") or [0.0]))
    while len(raw_rounds) < round_count:
        raw_rounds.append({})
    while len(times) < round_count:
        times.append((float(times[-1]) if times else 0.0) + 70.0)
    rounds: List[Dict[str, Any]] = []
    next_task_id = 1
    for index in range(round_count):
        round_row = _normalize_workspace_round(
            raw_rounds[index],
            index + 1,
            _finite_number(
                raw_rounds[index].get("currentTime"),
                _finite_number(times[index], 0.0),
            ),
            next_task_id,
            load_ports,
        )
        rounds.append(round_row)
        next_task_id += len(round_row["cjobs"])
    next_material_id = 1
    for round_row in rounds:
        for cjob in round_row["cjobs"]:
            for pjob in cjob["pjobs"]:
                wafer_count = int(pjob["waferCount"])
                pjob["matList"] = list(range(next_material_id, next_material_id + wafer_count))
                next_material_id += wafer_count
    times = [round_row["currentTime"] for round_row in rounds]
    options = deepcopy(dict(raw_test.get("options") or {}))
    # LoadLock 交换候选始终启用；迁移旧测试集时丢弃已经废止的开关。
    options.pop("loadLockExchange", None)
    normalized = {
        "id": test_id or uuid.uuid4().hex,
        "name": str(raw_test.get("name") or "未命名测试集").strip() or "未命名测试集",
        "group": str(raw_test.get("group") or "").strip(),
        "strategy": (
            "other_alg:greedy"
            if str(raw_test.get("strategy") or "").strip().lower() == "greedy"
            else str(raw_test.get("strategy") or "heuristic")
        ),
        "roundCount": round_count,
        "times": times,
        "options": options,
        "routeConfigs": deepcopy(dict(raw_test.get("routeConfigs") or {})),
        "cleans": [
            deepcopy(dict(clean))
            for clean in (raw_test.get("cleans") or [])
            if isinstance(clean, Mapping)
        ],
        "rounds": rounds,
        "createdAt": str(raw_test.get("createdAt") or timestamp),
        "updatedAt": timestamp,
    }
    if isinstance(raw_test.get("baseline"), Mapping):
        normalized["baseline"] = deepcopy(dict(raw_test["baseline"]))
    return normalized


def _apply_device_library(device: Dict[str, Any], payload: Mapping[str, Any]) -> None:
    """兼容写入共享路径模板，并同步 Route 自动改名；Clean 归测试所有。"""
    raw_aliases = payload.get("routeNameChanges")
    aliases = {
        str(old_name): str(new_name)
        for old_name, new_name in (raw_aliases.items() if isinstance(raw_aliases, Mapping) else [])
        if str(old_name) and str(new_name) and str(old_name) != str(new_name)
    }
    if aliases:
        # Route 是设备共享数据，自动改名时必须同步所有测试，而不只更新当前编辑项。
        for test_case in device.get("tests") or []:
            for round_row in test_case.get("rounds") or []:
                cjobs = round_row.get("cjobs") or []
                for cjob in cjobs:
                    for pjob in cjob.get("pjobs") or []:
                        route_ref = str(pjob.get("routeRef") or "")
                        if route_ref in aliases:
                            pjob["routeRef"] = aliases[route_ref]
            route_configs = test_case.get("routeConfigs")
            if isinstance(route_configs, dict):
                for old_name, new_name in aliases.items():
                    if old_name in route_configs and new_name not in route_configs:
                        route_configs[new_name] = route_configs.pop(old_name)
    if isinstance(payload.get("routes"), list):
        device["routes"] = _normalized_workspace_routes(payload["routes"])
    else:
        device.setdefault("routes", [])
    device.setdefault("cleans", [])


def _fast_update_directory_workspace_routes_unlocked(
    device_id: str,
    payload: Mapping[str, Any],
    path: Path,
) -> Optional[Dict[str, Any]]:
    """快速保存模板及延迟别名，只触碰设备库文件而不遍历全部测试。"""
    if (
        path.suffix
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
        or not _workspace_store_is_current(path)
        or not isinstance(payload.get("routes"), list)
    ):
        return None
    readable_layout = _uses_readable_dataset_layout(path)
    device_dir = (
        _find_dataset_device_directory(path, device_id)
        if readable_layout else path / device_id
    )
    if device_dir is None:
        return None
    device_file = device_dir / ("routes.json" if readable_layout else "device.json")
    try:
        device = json.loads(device_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(device, dict):
        return None
    metadata: Optional[Dict[str, Any]] = None
    summaries: Any = None
    if readable_layout:
        try:
            raw_metadata = json.loads(
                (device_dir / "metadata.json").read_text(encoding="utf-8")
            )
            summaries = json.loads(
                _workspace_test_index_path(device_dir / "tests").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None
        if not isinstance(raw_metadata, dict) or not isinstance(summaries, list):
            return None
        metadata = raw_metadata
    routes = _normalized_workspace_routes(payload["routes"])
    topology_keys = [
        _workspace_route_topology_key(route)
        for route in routes
        if isinstance(route, Mapping)
    ]
    if len(topology_keys) != len(set(topology_keys)):
        # 合并重复模板需要检查每个测试参数是否冲突，保持原有安全逻辑。
        return None
    device["routes"] = routes
    device.setdefault("cleans", [])
    aliases = _normalized_route_aliases(payload.get("routeNameChanges"))
    if aliases:
        route_aliases = _normalized_route_aliases(device.get("routeAliases"))
        for old_name, new_name in aliases.items():
            for origin, current in list(route_aliases.items()):
                if current == old_name:
                    route_aliases[origin] = new_name
            route_aliases[old_name] = new_name
        device["routeAliases"] = route_aliases
    if readable_layout:
        device["schemaVersion"] = WORKSPACE_STORE_VERSION
    else:
        device["updatedAt"] = _workspace_timestamp()
    _write_json_atomic(device_file, device)
    if readable_layout:
        metadata["updatedAt"] = _workspace_timestamp()
        _write_json_if_changed(device_dir / "metadata.json", metadata)
    else:
        try:
            summaries = json.loads(
                _workspace_test_index_path(device_dir / "tests").read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            summaries = []
    test_count = len(summaries) if isinstance(summaries, list) else 0
    _write_workspace_store_version(path)
    return {"routes": deepcopy(routes), "testCount": test_count}


def update_workspace_routes(
    device_id: str,
    payload: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
    *,
    include_tests: bool = True,
) -> Dict[str, Any]:
    """保存设备级路径模板，并把自动改名同步到所有测试引用和配置键。

    HTTP 调用不需要回传每个完整测试集；设备测试较多时这会显著拖慢保存。
    保留 ``include_tests`` 以兼容服务端调用方和已有测试。
    """
    with _workspace_catalog_guard(path):
        fast_result = _fast_update_directory_workspace_routes_unlocked(
            device_id, payload, path,
        )
        if fast_result is not None:
            return fast_result
        catalog = _read_workspace_catalog_unlocked(path)
        device = next(
            (item for item in catalog["devices"] if item.get("id") == device_id),
            None,
        )
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        if not isinstance(payload.get("routes"), list):
            raise ValueError("routes 必须是数组")
        _apply_device_library(device, payload)
        _deduplicate_workspace_route_templates(device)
        _synchronize_workspace_test_route_configs(device)
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        result = {
            "routes": deepcopy(device.get("routes") or []),
            "testCount": len(device.get("tests") or []),
        }
        if include_tests:
            result["tests"] = deepcopy(device.get("tests") or [])
        return result


def create_workspace_test(
    device_id: str,
    raw_test: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """在指定设备下新增一个独立测试集，并自动消解同组重名。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        _apply_device_library(device, raw_test)
        normalized_input = dict(raw_test)
        normalized_input.setdefault(
            "routeConfigs", _workspace_route_config_map(device.get("routes") or []),
        )
        normalized_input.pop("baseline", None)
        requested_name = str(raw_test.get("name") or "").strip()
        if not requested_name:
            raise ValueError("测试集名称不能为空")
        test_case = _normalize_test_case(
            normalized_input,
            load_ports=_workspace_load_ports(device),
        )
        test_case["name"] = _unique_workspace_name(
            test_case["name"],
            (
                str(item.get("name") or "")
                for item in device.get("tests") or []
                if str(item.get("group") or "").strip() == test_case["group"]
            ),
        )
        if test_case["group"] and test_case["group"] not in device.setdefault("testGroups", []):
            device["testGroups"].append(test_case["group"])
        device.setdefault("tests", []).append(test_case)
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(test_case)


def _fast_update_readable_workspace_test_unlocked(
    device_id: str,
    test_id: str,
    raw_test: Mapping[str, Any],
    path: Path,
) -> Optional[Dict[str, Any]]:
    """在 v6 目录中只更新目标测试及其摘要，避免每次编辑扫描并重写整库。"""
    if (
        path.suffix
        or not _uses_readable_dataset_layout(path)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", test_id)
        or not _workspace_store_is_current(path)
        # 共享 Route 变更必须继续走全量路径，以同步所有测试引用。
        or isinstance(raw_test.get("routes"), list)
        or bool(_normalized_route_aliases(raw_test.get("routeNameChanges")))
    ):
        return None
    device_dir = _find_dataset_device_directory(path, device_id)
    if device_dir is None:
        return None
    test_file = _find_dataset_test_file(device_dir, test_id)
    if test_file is None:
        return None
    tests_dir = device_dir / "tests"
    index_file = _workspace_test_index_path(tests_dir)
    try:
        metadata = json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
        init_data = json.loads((device_dir / "device.json").read_text(encoding="utf-8"))
        routes_payload = json.loads((device_dir / "routes.json").read_text(encoding="utf-8"))
        groups_payload = json.loads((device_dir / "groups.json").read_text(encoding="utf-8"))
        summaries = json.loads(index_file.read_text(encoding="utf-8"))
        existing_test = json.loads(test_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(metadata, dict)
        or not isinstance(init_data, dict)
        or not isinstance(routes_payload, Mapping)
        or not isinstance(groups_payload, dict)
        or not isinstance(summaries, list)
        or not all(isinstance(summary, Mapping) for summary in summaries)
        or not isinstance(existing_test, dict)
        or str(existing_test.get("id") or "") != test_id
    ):
        return None

    requested_name = str(raw_test.get("name") or "").strip()
    if not requested_name:
        raise ValueError("测试集名称不能为空")
    requested_group = str(raw_test.get("group") or "").strip()
    duplicate = next((
        summary for summary in summaries
        if str(summary.get("id") or "") != test_id
        and str(summary.get("group") or "").strip() == requested_group
        and str(summary.get("name") or "") == requested_name
    ), None)
    if duplicate is not None:
        raise ValueError(f"测试集名称重复：{requested_name}")

    device = deepcopy(metadata)
    init_options = device.pop("initOptions", {})
    if isinstance(init_options, Mapping):
        init_data.update(deepcopy(dict(init_options)))
    device.update({
        "device": init_data,
        "routes": deepcopy(routes_payload.get("routes") or []),
        "cleans": deepcopy(routes_payload.get("cleans") or []),
        "routeAliases": deepcopy(routes_payload.get("routeAliases") or {}),
        "testGroups": deepcopy(groups_payload.get("testGroups") or []),
    })
    if "robotSlots" in groups_payload:
        device["robotSlots"] = deepcopy(groups_payload["robotSlots"])

    merged = dict(raw_test)
    merged.setdefault("routeConfigs", _workspace_route_config_map(device.get("routes") or []))
    merged.pop("baseline", None)
    merged["createdAt"] = existing_test.get("createdAt")
    if isinstance(existing_test.get("baseline"), Mapping):
        merged["baseline"] = deepcopy(existing_test["baseline"])
    test_case = _normalize_test_case(merged, test_id, _workspace_load_ports(device))
    _invalidate_stale_device_baselines({**device, "tests": [test_case]})

    groups = groups_payload.setdefault("testGroups", [])
    if test_case["group"] and test_case["group"] not in groups:
        groups.append(test_case["group"])
    timestamp = _workspace_timestamp()
    metadata["updatedAt"] = timestamp
    persisted_test = deepcopy(test_case)
    persisted_test["schemaVersion"] = WORKSPACE_STORE_VERSION
    updated_summaries = [
        _workspace_test_summary(test_case)
        if str(summary.get("id") or "") == test_id
        else _workspace_test_summary(summary)
        for summary in summaries
    ]
    _write_json_atomic(test_file, persisted_test)
    _write_json_if_changed(index_file, updated_summaries)
    _write_json_if_changed(device_dir / "groups.json", groups_payload)
    _write_json_if_changed(device_dir / "metadata.json", metadata)
    _write_workspace_store_version(path)
    return deepcopy(test_case)


def update_workspace_test(
    device_id: str,
    test_id: str,
    raw_test: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """覆盖保存一个测试集，同时保持创建时间和稳定 ID。"""
    with _workspace_catalog_guard(path):
        fast_result = _fast_update_readable_workspace_test_unlocked(
            device_id, test_id, raw_test, path,
        )
        if fast_result is not None:
            return fast_result
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        tests = device.get("tests") or []
        index = next((position for position, item in enumerate(tests) if item.get("id") == test_id), None)
        if index is None:
            raise ValueError(f"测试集不存在：{test_id}")
        requested_name = str(raw_test.get("name") or "").strip()
        if not requested_name:
            raise ValueError("测试集名称不能为空")
        requested_group = str(raw_test.get("group") or "").strip()
        duplicate = next((
            item for item in tests
            if item.get("id") != test_id
            and str(item.get("group") or "").strip() == requested_group
            and str(item.get("name") or "") == requested_name
        ), None)
        if duplicate is not None:
            raise ValueError(f"测试集名称重复：{requested_name}")
        _apply_device_library(device, raw_test)
        merged = dict(raw_test)
        merged.setdefault(
            "routeConfigs", _workspace_route_config_map(device.get("routes") or []),
        )
        merged.pop("baseline", None)
        merged["createdAt"] = tests[index].get("createdAt")
        if isinstance(tests[index].get("baseline"), Mapping):
            merged["baseline"] = deepcopy(tests[index]["baseline"])
        test_case = _normalize_test_case(
            merged,
            test_id,
            _workspace_load_ports(device),
        )
        if test_case["group"] and test_case["group"] not in device.setdefault("testGroups", []):
            device["testGroups"].append(test_case["group"])
        tests[index] = test_case
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(test_case)


def create_workspace_test_group(
    device_id: str,
    name: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> List[str]:
    """为设备新增可独立存在的测试组别，不隐式创建测试集。"""
    group = str(name or "").strip()
    if not group:
        raise ValueError("测试组别名称不能为空")
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        groups = device.setdefault("testGroups", [])
        if group in groups:
            raise ValueError(f"测试组别“{group}”已经存在")
        groups.append(group)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(groups)


def rename_workspace_test_group(
    device_id: str,
    old_name: str,
    name: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """重命名设备下的测试组，并同步组内测试的 group 字段。"""
    old_group = str(old_name or "").strip()
    group = str(name or "").strip()
    if not old_group:
        raise ValueError("默认“未分组”不能重命名")
    if not group:
        raise ValueError("测试组别名称不能为空")
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        groups = device.setdefault("testGroups", [])
        if old_group not in groups:
            raise ValueError(f"测试组别不存在：{old_group}")
        if group != old_group and group in groups:
            raise ValueError(f"测试组别“{group}”已经存在")
        if group != old_group:
            groups[groups.index(old_group)] = group
            for test_case in device.get("tests") or []:
                if str(test_case.get("group") or "").strip() == old_group:
                    test_case["group"] = group
            device["updatedAt"] = _workspace_timestamp()
            _write_workspace_catalog_unlocked(path, catalog)
        return {"groups": deepcopy(groups), "tests": deepcopy(device.get("tests") or [])}


def delete_workspace_test_group(
    device_id: str,
    name: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """删除一个测试组及其包含的测试集；空名称代表“未分组”。"""
    group = str(name or "").strip()
    with _workspace_catalog_guard(path):
        fast_result = _fast_delete_readable_workspace_test_group_unlocked(
            device_id, group, path,
        )
        if fast_result is not None:
            return fast_result
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        groups = device.setdefault("testGroups", [])
        has_group_tests = any(
            str(item.get("group") or "").strip() == group
            for item in device.get("tests") or []
        )
        if group and group not in groups:
            raise ValueError(f"测试组别不存在：{group}")
        if not group and not has_group_tests:
            raise ValueError("“未分组”中没有可删除的测试")
        deleted_tests = [
            item for item in device.get("tests") or []
            if str(item.get("group") or "").strip() == group
        ]
        if group:
            device["testGroups"] = [item for item in groups if item != group]
        device["tests"] = [
            item for item in device.get("tests") or []
            if str(item.get("group") or "").strip() != group
        ]
        _invalidate_stale_device_baselines(device)
        device["updatedAt"] = _workspace_timestamp()
        # 先物理删除测试集文件再写目录：即使中途中断，下次扫描也不会让已删测试复活。
        for deleted_test in deleted_tests:
            _remove_directory_test_file(path, device_id, str(deleted_test.get("id") or "").strip())
        _write_workspace_catalog_unlocked(path, catalog)
        return {
            "groups": deepcopy(device["testGroups"]),
            "tests": [
                _workspace_test_summary(test_case)
                for test_case in device["tests"]
                if isinstance(test_case, Mapping)
            ],
            "deletedTestCount": len(deleted_tests),
        }


def _fast_delete_readable_workspace_test_unlocked(
    device_id: str,
    test_id: str,
    path: Path,
) -> Optional[List[Dict[str, Any]]]:
    """仅凭测试摘要索引删除一个 v7 测试，并返回剩余摘要。

    该快速路径不解析任何完整 ``test.json``，也不重写其他测试。返回摘要而非
    完整测试，避免 HTTP 删除响应随设备测试总数据量线性膨胀。
    """
    if (
        path.suffix
        or not _uses_readable_dataset_layout(path)
        or not _workspace_store_is_current(path)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", test_id)
    ):
        return None
    device_dir = _find_dataset_device_directory(path, device_id)
    if device_dir is None:
        return None
    tests_dir = device_dir / "tests"
    index_file = _workspace_test_index_path(tests_dir)
    try:
        summaries = json.loads(index_file.read_text(encoding="utf-8"))
        metadata = json.loads(
            (device_dir / "metadata.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(summaries, list)
        or not all(isinstance(summary, Mapping) for summary in summaries)
        or not isinstance(metadata, dict)
    ):
        return None
    if len(summaries) <= 1:
        raise ValueError("设备至少需要保留一个测试集")
    if not any(str(summary.get("id") or "") == test_id for summary in summaries):
        raise ValueError(f"测试集不存在：{test_id}")
    test_file = _find_dataset_test_file(device_dir, test_id)
    if test_file is None:
        return None
    remaining = [
        _workspace_test_summary(summary)
        for summary in summaries
        if str(summary.get("id") or "") != test_id
    ]
    # 先删除目标目录再更新索引，防止中断后已删测试由索引之外的文件复活。
    shutil.rmtree(test_file.parent)
    metadata["updatedAt"] = _workspace_timestamp()
    _write_json_atomic(index_file, remaining)
    _write_json_if_changed(device_dir / "metadata.json", metadata)
    _write_workspace_store_version(path)
    return remaining


def _fast_delete_readable_workspace_test_group_unlocked(
    device_id: str,
    group: str,
    path: Path,
) -> Optional[Dict[str, Any]]:
    """仅凭组清单和测试摘要索引删除一个 v7 测试组。"""
    if (
        path.suffix
        or not _uses_readable_dataset_layout(path)
        or not _workspace_store_is_current(path)
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
    ):
        return None
    device_dir = _find_dataset_device_directory(path, device_id)
    if device_dir is None:
        return None
    tests_dir = device_dir / "tests"
    index_file = _workspace_test_index_path(tests_dir)
    groups_file = device_dir / "groups.json"
    metadata_file = device_dir / "metadata.json"
    try:
        summaries = json.loads(index_file.read_text(encoding="utf-8"))
        groups_payload = json.loads(groups_file.read_text(encoding="utf-8"))
        metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(summaries, list)
        or not all(isinstance(summary, Mapping) for summary in summaries)
        or not isinstance(groups_payload, dict)
        or not isinstance(groups_payload.get("testGroups"), list)
        or not isinstance(metadata, dict)
    ):
        return None
    groups = groups_payload["testGroups"]
    deleted_summaries = [
        summary
        for summary in summaries
        if str(summary.get("group") or "").strip() == group
    ]
    if group and group not in groups:
        raise ValueError(f"测试组别不存在：{group}")
    if not group and not deleted_summaries:
        raise ValueError("“未分组”中没有可删除的测试")
    deleted_test_files: List[Path] = []
    for summary in deleted_summaries:
        deleting_test_id = str(summary.get("id") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]+", deleting_test_id):
            return None
        test_file = _find_dataset_test_file(device_dir, deleting_test_id)
        if test_file is None:
            return None
        deleted_test_files.append(test_file)
    remaining = [
        _workspace_test_summary(summary)
        for summary in summaries
        if str(summary.get("group") or "").strip() != group
    ]
    if group:
        groups_payload["testGroups"] = [item for item in groups if item != group]
    # 全部目标验证完成后，把组内目录原子移出活动树。Windows 上同步递归删除
    # 数百个测试目录可能耗时数秒；隔离后先提交索引，再由后台回收文件。
    deletion_staging = tests_dir / f".deleting-{uuid.uuid4().hex}"
    if deleted_test_files:
        deletion_staging.mkdir()
        for test_file in deleted_test_files:
            test_file.parent.replace(deletion_staging / test_file.parent.name)
    metadata["updatedAt"] = _workspace_timestamp()
    _write_json_atomic(index_file, remaining)
    _write_json_if_changed(groups_file, groups_payload)
    _write_json_if_changed(metadata_file, metadata)
    _write_workspace_store_version(path)
    if deleted_test_files:
        _schedule_directory_cleanup(deletion_staging)
    return {
        "groups": deepcopy(groups_payload["testGroups"]),
        "tests": remaining,
        "deletedTestCount": len(deleted_summaries),
    }


def delete_workspace_test(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> List[Dict[str, Any]]:
    """删除指定测试集，并返回剩余测试摘要。"""
    with _workspace_catalog_guard(path):
        fast_result = _fast_delete_readable_workspace_test_unlocked(
            device_id, test_id, path,
        )
        if fast_result is not None:
            return fast_result
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        tests = device.get("tests") or []
        if len(tests) <= 1:
            raise ValueError("设备至少需要保留一个测试集")
        remaining = [item for item in tests if item.get("id") != test_id]
        if len(remaining) == len(tests):
            raise ValueError(f"测试集不存在：{test_id}")
        device["tests"] = remaining
        device["updatedAt"] = _workspace_timestamp()
        # 先物理删除测试集文件再写目录：即使中途中断，下次扫描也不会让已删测试复活。
        _remove_directory_test_file(path, device_id, test_id)
        _write_workspace_catalog_unlocked(path, catalog)
        return [
            _workspace_test_summary(test_case)
            for test_case in remaining
            if isinstance(test_case, Mapping)
        ]



__all__ = tuple(name for name in globals() if not name.startswith('__'))
