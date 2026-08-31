"""工作区目录、版本迁移、索引和原子文件存储。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.execution.cjob_cycle import _cjob_cycle_count
from realtime_scheduler.backend.time_utils import _workspace_timestamp

@contextmanager
def _workspace_catalog_guard(path: Path) -> Iterator[None]:
    """串行化跨线程、跨进程的工作区读改写事务。

    Python 的 ``RLock`` 只能保护当前服务进程。批量运行或桌面端误启第二个服务时，
    两个进程若共用固定 ``.tmp`` 文件会破坏 JSON，单靠原子替换也会发生后写覆盖。
    这里用一字节系统文件锁包住完整读改写事务；锁文件只承载互斥，不保存业务数据。
    """
    lock_path = (
        path.with_name(path.name + ".lock")
        if path.suffix == ""
        else path.with_suffix(path.suffix + ".lock")
    )
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with _WORKSPACE_STORE_LOCK, lock_path.open("a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            lock_file.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

def _device_fingerprint(device_data: Mapping[str, Any]) -> str:
    """计算设备语义指纹，将 JSON 中数值相同的整数和浮点数视为同一拓扑。"""
    pure_init_data, _ = _split_device_init_data(device_data)

    def normalize(value: Any) -> Any:
        """递归规范化 JSON 数值表示，不改变字段、数组顺序或非整数浮点精度。"""
        if isinstance(value, Mapping):
            return {str(key): normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, float) and math.isfinite(value) and value.is_integer():
            return int(value)
        return value

    canonical = json.dumps(
        normalize(pure_init_data), ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def _split_device_init_data(device_data: Any) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """将纯 Stations/Robots init 与兼容性初始化选项分开持久化。"""
    source = dict(device_data) if isinstance(device_data, Mapping) else {}
    pure = {
        key: deepcopy(source[key])
        for key in ("Stations", "Robots")
        if key in source
    }
    options = {
        str(key): deepcopy(value)
        for key, value in source.items()
        if key not in {"Stations", "Robots"}
    }
    return pure, options

def _legacy_workspace_directory_path() -> Path:
    """返回随 DATA_DIR 测试替换而变化的旧版工作区目录。"""
    return DATA_DIR / "workspaces"


def _has_separate_legacy_workspace_directory(path: Path) -> bool:
    """判断默认数据旁是否仍有一份不同路径的 v5 工作区。"""
    legacy_path = _legacy_workspace_directory_path()
    return legacy_path.is_dir() and legacy_path.absolute() != path.absolute()


def _empty_workspace_catalog() -> Dict[str, Any]:
    """创建当前版本的空设备工作区目录。"""
    return {"version": WORKSPACE_STORE_VERSION, "devices": []}


def _workspace_store_version_path(store_dir: Path) -> Path:
    """返回数据集根目录中面向用户可见的格式清单。"""
    return store_dir / WORKSPACE_STORE_VERSION_FILE


def _workspace_test_index_path(tests_dir: Path) -> Path:
    """返回测试摘要索引路径；索引与完整测试文件分开，避免切换设备时全量读取。"""
    return tests_dir / WORKSPACE_TEST_INDEX_FILE


def _read_workspace_store_version(store_dir: Path) -> int:
    """读取数据格式版本，并兼容旧目录中的隐藏版本标记。"""
    candidates = (
        _workspace_store_version_path(store_dir),
        store_dir / LEGACY_WORKSPACE_STORE_VERSION_FILE,
    )
    for candidate in candidates:
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(payload, Mapping):
                return int(payload.get("schemaVersion", payload.get("version")) or 0)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    return 0


def _workspace_store_is_current(path: Path = WORKSPACE_STORE_PATH) -> bool:
    """快速判断目录是否可走按需读取路径，不遍历业务数据文件。

    该判断只验证持久化格式标记和旧库迁移状态，供正常运行期间的高频 API
    使用。检测人工修改文件时间的完整扫描只保留在服务启动和显式迁移流程，
    避免每次读取单个测试都对整个数据目录执行 O(N) 的 ``stat``。

    Args:
        path: 工作区目录或兼容的旧单文件路径。

    Returns:
        当前格式已经完整落盘且没有待迁移旧库时返回 ``True``。
    """
    if path.suffix:
        return False
    if not path.is_dir() or _read_workspace_store_version(path) != WORKSPACE_STORE_VERSION:
        return False
    if path == WORKSPACE_STORE_PATH and (
        (DATA_DIR / "workspaces.json").is_file()
        or _has_separate_legacy_workspace_directory(path)
    ):
        return False
    return True


def _write_workspace_store_version(store_dir: Path) -> None:
    """在数据文件全部落盘后刷新可读的格式清单。"""
    if not _uses_readable_dataset_layout(store_dir):
        _write_json_atomic(
            store_dir / WORKSPACE_STORE_VERSION_FILE,
            {"version": WORKSPACE_STORE_VERSION},
        )
        return
    _write_json_atomic(
        _workspace_store_version_path(store_dir),
        {
            "kind": "ct-scheduler-datasets",
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "description": "请通过调度平台前端导入或导出设备与测试集。",
        },
    )


def _uuid_storage_segment(stable_id: str) -> str:
    """返回稳定 UUID 目录名；名称只保存在 JSON 和前端，不参与磁盘寻址。"""
    normalized_id = re.sub(r"[^A-Za-z0-9_-]", "", stable_id)
    return normalized_id or uuid.uuid4().hex


def _dataset_device_directory(store_dir: Path, device: Mapping[str, Any]) -> Path:
    """根据设备稳定 ID 返回新版数据集目录。"""
    return store_dir / _uuid_storage_segment(str(device.get("id") or ""))


def _find_dataset_device_directory(store_dir: Path, device_id: str) -> Optional[Path]:
    """扫描新版设备清单，根据内部 ID 定位 UUID 目录。"""
    if not store_dir.is_dir():
        return None
    for device_dir in store_dir.iterdir():
        if not device_dir.is_dir():
            continue
        try:
            metadata = json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
        if isinstance(metadata, Mapping) and str(metadata.get("id") or "") == device_id:
            return device_dir
    return None


def _dataset_test_directory(tests_dir: Path, test_case: Mapping[str, Any]) -> Path:
    """返回单个测试集的稳定 UUID 独立目录。"""
    return tests_dir / _uuid_storage_segment(str(test_case.get("id") or ""))


def _find_dataset_test_file(device_dir: Path, test_id: str) -> Optional[Path]:
    """根据测试内部 ID 定位新版独立测试集文件。"""
    tests_dir = device_dir / "tests"
    if not tests_dir.is_dir():
        return None
    # v6 目录名就是稳定测试 UUID。优先直接命中，避免大型设备每次读取一个测试时
    # 都解析 tests/ 下的全部 test.json；调用方读取后仍会校验文件内 ID，保留后面的
    # 扫描只用于目录名未直接命中的人工移动旧数据。
    direct_file = _dataset_test_directory(tests_dir, {"id": test_id}) / "test.json"
    if direct_file.is_file():
        return direct_file
    for test_dir in tests_dir.iterdir():
        test_file = test_dir / "test.json"
        if not test_file.is_file():
            continue
        try:
            test_case = json.loads(test_file.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
        if isinstance(test_case, Mapping) and str(test_case.get("id") or "") == test_id:
            return test_file
    return None


def _workspace_data_update_required(path: Path = WORKSPACE_STORE_PATH) -> bool:
    """仅在版本变化、旧库待迁移或外部文件更新后要求启动前整理数据。"""
    if path.suffix:
        if not path.is_file():
            return False
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            return int(payload.get("version") or 0) != WORKSPACE_STORE_VERSION
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return True
    if path == WORKSPACE_STORE_PATH and (
        (DATA_DIR / "workspaces.json").is_file()
        or _has_separate_legacy_workspace_directory(path)
    ):
        return True
    if not path.is_dir():
        if path != WORKSPACE_STORE_PATH:
            return False
        return any(candidate.is_file() for candidate in (
            DATA_DIR / "workspaces.json", LEGACY_WORKSPACE_STORE_PATH,
        )) or _has_separate_legacy_workspace_directory(path)
    marker = _workspace_store_version_path(path)
    if _read_workspace_store_version(path) != WORKSPACE_STORE_VERSION:
        return True
    try:
        marker_mtime = marker.stat().st_mtime_ns
        data_files = [
            *path.glob("*/metadata.json"),
            *path.glob("*/device.json"),
            *path.glob("*/routes.json"),
            *path.glob("*/groups.json"),
            *path.glob("*/tests/*/test.json"),
        ]
        return any(file.stat().st_mtime_ns > marker_mtime for file in data_files)
    except OSError:
        return True


def _prepare_workspace_data(path: Path = WORKSPACE_STORE_PATH) -> bool:
    """按需完成一次启动前数据迁移，并为目录格式升级保留可恢复备份。"""
    if not _workspace_data_update_required(path):
        return False
    list_workspace_devices(path)
    if path.suffix == "" and path.is_dir():
        with _workspace_catalog_guard(path):
            _write_workspace_store_version(path)
    return True


def _backup_workspace_directory_before_upgrade(path: Path) -> Optional[Path]:
    """在首次改写旧目录前创建一次完整备份；同一版本升级重复调用保持幂等。"""
    if path.suffix or not path.is_dir():
        return None
    source_version = _read_workspace_store_version(path)
    if source_version <= 0 or source_version >= WORKSPACE_STORE_VERSION:
        return None
    backup_root = (
        DATA_DIR / "migration-backups"
        if path == WORKSPACE_STORE_PATH
        else path.parent / "migration-backups"
    )
    backup_root.mkdir(parents=True, exist_ok=True)
    prefix = f"datasets-v{source_version}-to-v{WORKSPACE_STORE_VERSION}-"
    existing = next(backup_root.glob(f"{prefix}*"), None)
    if existing is not None:
        return existing
    backup_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = backup_root / f"{prefix}{backup_stamp}-{uuid.uuid4().hex[:8]}"
    shutil.copytree(path, backup_path)
    return backup_path


def _merge_named_assets(base: Sequence[Any], additions: Sequence[Any]) -> List[Dict[str, Any]]:
    """按名称合并 Route/Clean；同名项由后出现的数据覆盖且保持稳定位置。"""
    merged: List[Dict[str, Any]] = []
    positions: Dict[str, int] = {}
    for raw in [*base, *additions]:
        if not isinstance(raw, Mapping):
            continue
        item = deepcopy(dict(raw))
        name = str(item.get("name") or item.get("Name") or "").strip()
        key = name.casefold()
        if not key:
            continue
        if key in positions:
            merged[positions[key]] = item
        else:
            positions[key] = len(merged)
            merged.append(item)
    return merged


def _repair_workspace_route_recipes(
    routes: Sequence[Any],
    processing_modules: Iterable[str] = (),
) -> bool:
    """修复旧共享 Route 的加工标记，并补稳定 Recipe 名称和已有加工时间。

    早期导入数据可能只在第一道工序保存 ``processRecipe``，后续工序虽然
    ``needProcess=true`` 且已有 ``processTime``，却无法生成 ProcessRecipes。
    旧版页面还只识别 ProcessChamber，导致 Heater、Cooler 等设备即使保存了
    加工时长，也会被错误写成 ``needProcess=false``；迁移时根据设备拓扑纠正。
    """
    changed = False
    processing_module_names = {
        str(module_name).strip()
        for module_name in processing_modules
        if str(module_name).strip()
    }
    for raw_route in routes:
        if not isinstance(raw_route, dict):
            continue
        prefix = str(raw_route.get("group") or raw_route.get("name") or "Route").strip()
        for stage_index, raw_stage in enumerate(raw_route.get("stages") or []):
            if not isinstance(raw_stage, dict):
                continue
            raw_visits = raw_stage.get("visits") or raw_stage.get("Visits") or []
            topology_requires_process = any(
                isinstance(raw_visit, Mapping)
                and str(
                    raw_visit.get("stationName", raw_visit.get("ModuleName", ""))
                ).strip() in processing_module_names
                for raw_visit in raw_visits
            )
            need_process = bool(
                raw_stage.get("needProcess", raw_stage.get("NeedProcess", False))
            ) or topology_requires_process
            if topology_requires_process:
                need_process_key = (
                    "NeedProcess" if "NeedProcess" in raw_stage else "needProcess"
                )
                if raw_stage.get(need_process_key) is not True:
                    raw_stage[need_process_key] = True
                    changed = True
            if not need_process:
                continue
            step_id = int(_finite_number(
                raw_stage.get("stepId", raw_stage.get("StepID")),
                stage_index,
            ))
            recipe_name = f"{prefix}_Step{step_id}"
            for raw_visit in raw_visits:
                if not isinstance(raw_visit, dict):
                    continue
                recipe_key = "processRecipe" if "ProcessRecipe" not in raw_visit else "ProcessRecipe"
                if not str(raw_visit.get(recipe_key) or "").strip():
                    raw_visit[recipe_key] = recipe_name
                    changed = True
                time_key = "processTime" if "Time" not in raw_visit else "Time"
                if raw_visit.get(time_key) in (None, "") and raw_visit.get("recipeTime") not in (None, ""):
                    raw_visit[time_key] = raw_visit["recipeTime"]
                    changed = True
    return changed


def _natural_name_key(value: str) -> Tuple[Any, ...]:
    """把带数字的设备名称拆成自然排序键，例如 LP2 排在 LP10 前。"""
    return tuple(
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", value)
        if part
    )


def _workspace_load_ports(device: Mapping[str, Any]) -> List[str]:
    """按前端一致的自然顺序返回设备中的 LoadPort 名称。"""
    topology = device.get("device") if isinstance(device.get("device"), Mapping) else device
    stations = topology.get("Stations") if isinstance(topology, Mapping) else {}
    if not isinstance(stations, Mapping):
        return []
    return sorted(
        (
            str(name)
            for name, station in stations.items()
            if isinstance(station, Mapping)
            and str(station.get("Type") or "").strip().lower() == "loadport"
        ),
        key=_natural_name_key,
    )


def _workspace_processing_modules(device: Mapping[str, Any]) -> List[str]:
    """返回拓扑中需要生成加工事件和甘特图加工条的模块名称。"""
    topology = device.get("device") if isinstance(device.get("device"), Mapping) else device
    stations = topology.get("Stations") if isinstance(topology, Mapping) else {}
    if not isinstance(stations, Mapping):
        return []
    return sorted(
        (
            str(name)
            for name, station in stations.items()
            if isinstance(station, Mapping)
            and str(station.get("Type") or "").strip().lower()
            in PROCESSING_STATION_TYPES
        ),
        key=_natural_name_key,
    )


def _workspace_task_mode_name(raw_value: Any) -> str:
    """把页面或旧工作区中的 TaskMode 收敛为稳定枚举名称。"""
    try:
        value = _enum_value(raw_value, TASK_MODE_VALUES, "TaskMode", "Smart")
    except ValueError:
        value = TASK_MODE_VALUES["Smart"]
    return TASK_MODE_NAMES[value]


def _automatic_workspace_load_port(
    load_ports: Sequence[str],
    task_ordinal: int,
) -> str:
    """按盒子的全局 CJob 顺序轮转源 LoadPort。"""
    if not load_ports:
        return ""
    return str(load_ports[max(0, task_ordinal - 1) % len(load_ports)])


def _repair_workspace_job_layout(device: Dict[str, Any]) -> bool:
    """迁移已有测试的 TaskID、固定 LoadPort 与 CJobCycle。"""
    changed = False
    load_ports = _workspace_load_ports(device)
    for test in device.get("tests") or []:
        if not isinstance(test, dict):
            continue
        next_task_id = 1
        for round_index, round_row in enumerate(test.get("rounds") or [], start=1):
            if not isinstance(round_row, dict):
                continue
            cjobs = [
                item for item in (round_row.get("cjobs") or [])
                if isinstance(item, dict)
            ]
            for cjob_index, cjob in enumerate(cjobs, start=1):
                task_id = str(next_task_id)
                next_task_id += 1
                task_mode = _workspace_task_mode_name(cjob.get("taskMode", cjob.get("TaskMode")))
                fallback_load_port = str(cjob.get("loadPort") or "")
                pjobs = [
                    item for item in (cjob.get("pjobs") or [])
                    if isinstance(item, dict)
                ]
                if not fallback_load_port and pjobs:
                    fallback_load_port = str(
                        pjobs[0].get("loadPort") or pjobs[0].get("LoadPort") or ""
                    )
                load_port = (
                    fallback_load_port
                    if fallback_load_port in load_ports
                    else _automatic_workspace_load_port(load_ports, int(task_id))
                ) or fallback_load_port
                normalized_fields = {
                    "taskId": task_id,
                    "taskMode": task_mode,
                    "loadPort": load_port,
                    "cjobCycle": _cjob_cycle_count(cjob),
                    "pJobNameList": [f"P{index}" for index in range(1, len(pjobs) + 1)],
                }
                for key, value in normalized_fields.items():
                    if cjob.get(key) != value:
                        cjob[key] = value
                        changed = True
                for pjob_index, pjob in enumerate(pjobs, start=1):
                    pjob_fields = {
                        "jobName": f"P{pjob_index}",
                        "taskId": task_id,
                        "loadPort": load_port,
                    }
                    for key, value in pjob_fields.items():
                        if pjob.get(key) != value:
                            pjob[key] = value
                            changed = True
    return changed


def _repair_workspace_route_contracts(routes: Sequence[Any]) -> bool:
    """清除不支持的 PostCJob，并把旧 BufferOption 收敛到接口枚举范围。"""
    changed = False
    for route in routes:
        if not isinstance(route, dict):
            continue
        if "postCJobCleanRefs" in route and route.get("postCJobCleanRefs"):
            route["postCJobCleanRefs"] = []
            changed = True
        if "bufferOption" in route:
            raw_option = _finite_number(route.get("bufferOption"), 0)
            option = max(0, min(4, int(raw_option)))
            if route.get("bufferOption") != option:
                route["bufferOption"] = option
                changed = True
    return changed


def _workspace_route_test_config(route: Mapping[str, Any]) -> Dict[str, Any]:
    """从旧版共享 Route 提取时间、清洁和驻留等测试侧参数。"""
    def string_rows(value: Any) -> List[str]:
        """把旧版数组或逗号文本收敛为去重名称列表。"""
        rows = value if isinstance(value, list) else str(value or "").replace("，", ",").split(",")
        return list(dict.fromkeys(
            str(item).strip() for item in rows if str(item).strip()
        ))

    recipe_prefix = str(route.get("group") or route.get("name") or "Route").strip()
    route_config: Dict[str, Any] = {
        "bufferOption": max(0, min(4, int(_finite_number(
            route.get("bufferOption", route.get("BufferOption")), 0,
        )))),
        "prePJobCleanRefs": string_rows(route.get("prePJobCleanRefs")),
        "postPJobCleanRefs": string_rows(route.get("postPJobCleanRefs")),
        "postCJobCleanRefs": [],
        "stages": {},
    }
    for stage_index, stage in enumerate(route.get("stages") or []):
        if not isinstance(stage, Mapping):
            continue
        step_id = str(int(_finite_number(stage.get("stepId"), stage_index)))
        visits = [
            visit for visit in (stage.get("visits") or [])
            if isinstance(visit, Mapping)
        ]
        visit = visits[0] if visits else {}
        process_time = _finite_number(
            visit.get("processTime", visit.get("recipeTime")), 20,
        )
        route_config["stages"][step_id] = {
            "processTime": process_time,
            "recipeTime": process_time,
            "qTimeLimit": _finite_number(visit.get("qTimeLimit"), -1),
            "residencyConstraint": _finite_number(
                visit.get("residencyConstraint"), -1,
            ),
            "beforeCleanRefs": string_rows(visit.get("beforeCleanRefs")),
            "afterCleanRefs": string_rows(visit.get("afterCleanRefs")),
            "processRecipe": str(
                visit.get("processRecipe")
                or (f"{recipe_prefix}_Step{step_id}" if stage.get("needProcess") else "")
            ),
            "processType": str(visit.get("processType") or ""),
            "weight": deepcopy(visit.get("weight") or {}),
            "moveTimeOffset": deepcopy(visit.get("moveTimeOffset") or {}),
            "slotIds": str(visit.get("slotIds") or "1"),
        }
    return route_config


def _workspace_route_config_map(routes: Sequence[Any]) -> Dict[str, Any]:
    """按 Route 名称生成旧数据到测试侧参数的兼容迁移映射。"""
    return {
        str(route.get("name") or "").strip(): _workspace_route_test_config(route)
        for route in routes
        if isinstance(route, Mapping) and str(route.get("name") or "").strip()
    }


def _synchronize_workspace_test_route_configs(device: Dict[str, Any]) -> None:
    """让每个测试配置与最新模板 Step 对齐，并保留仍然有效的既有参数。"""
    defaults = _workspace_route_config_map(device.get("routes") or [])
    for test_case in device.get("tests") or []:
        existing = test_case.get("routeConfigs")
        existing = existing if isinstance(existing, Mapping) else {}
        normalized: Dict[str, Any] = {}
        for route_name, default_config in defaults.items():
            prior = existing.get(route_name)
            prior = prior if isinstance(prior, Mapping) else {}
            merged = deepcopy(default_config)
            for key in (
                "bufferOption", "prePJobCleanRefs", "postPJobCleanRefs",
                "postCJobCleanRefs",
            ):
                if key in prior:
                    merged[key] = deepcopy(prior[key])
            prior_stages = prior.get("stages")
            prior_stages = prior_stages if isinstance(prior_stages, Mapping) else {}
            for step_id, stage_config in merged["stages"].items():
                if isinstance(prior_stages.get(step_id), Mapping):
                    stage_config.update(deepcopy(dict(prior_stages[step_id])))
            normalized[route_name] = merged
        test_case["routeConfigs"] = normalized


def _migrate_workspace_pjob_route_configs(
    test_case: Dict[str, Any],
    route_configs: Mapping[str, Any],
) -> bool:
    """把旧版按模板共享的参数复制到每个 PJob，确保路径实例互不影响。"""
    changed = False
    for round_row in test_case.get("rounds") or []:
        if not isinstance(round_row, Mapping):
            continue
        for cjob in round_row.get("cjobs") or []:
            if not isinstance(cjob, Mapping):
                continue
            for pjob in cjob.get("pjobs") or []:
                if not isinstance(pjob, dict) or isinstance(pjob.get("routeConfig"), Mapping):
                    continue
                route_name = str(pjob.get("routeRef") or "").strip()
                config = route_configs.get(route_name)
                if isinstance(config, Mapping):
                    pjob["routeConfig"] = deepcopy(dict(config))
                    changed = True
    return changed


def _strip_workspace_route_parameters(route: Dict[str, Any]) -> None:
    """原地清除共享模板中的测试参数，仅保留 Step 与候选腔室拓扑。"""
    route.pop("bufferOption", None)
    route.pop("prePJobCleanRefs", None)
    route.pop("postPJobCleanRefs", None)
    route.pop("postCJobCleanRefs", None)
    if "stages" not in route:
        return
    stages = []
    for stage_index, raw_stage in enumerate(route.get("stages") or []):
        if not isinstance(raw_stage, Mapping):
            continue
        step_id = int(_finite_number(raw_stage.get("stepId"), stage_index))
        visits = [
            {"stationName": str(visit.get("stationName") or "")}
            for visit in (raw_stage.get("visits") or [])
            if isinstance(visit, Mapping)
        ]
        stages.append({
            "stepId": step_id,
            "postStepIds": [step_id + 1] if stage_index + 1 < len(route.get("stages") or []) else [],
            "needProcess": bool(raw_stage.get("needProcess")),
            "kind": str(raw_stage.get("kind") or ""),
            "visits": visits,
        })
    route["stages"] = stages


def _normalized_workspace_routes(raw_routes: Sequence[Any]) -> List[Any]:
    """校验并保存只含 Step 与候选腔室的共享路径模板。"""
    routes = deepcopy(list(raw_routes))
    for route in routes:
        if not isinstance(route, dict):
            continue
        if "bufferOption" in route:
            raw_option = route.get("bufferOption")
            try:
                numeric_option = float(raw_option)
            except (TypeError, ValueError):
                raise ValueError(f"BufferOption 必须是 0~4 的整数：{raw_option}") from None
            option = int(numeric_option)
            if not math.isfinite(numeric_option) or numeric_option != option or not 0 <= option <= 4:
                raise ValueError(f"BufferOption 必须是 0~4 的整数：{raw_option}")
            route["bufferOption"] = option
        _strip_workspace_route_parameters(route)
    return routes


def _workspace_route_topology_key(route: Mapping[str, Any]) -> str:
    """返回只描述 Step 与候选模块的稳定键；首尾模块由 CJob 决定，不参与区分。"""
    raw_stages = [stage for stage in (route.get("stages") or []) if isinstance(stage, Mapping)]
    stages = []
    for stage_index, stage in enumerate(raw_stages):
        fixed_endpoint = stage_index == 0 or stage_index == len(raw_stages) - 1
        candidates = [] if fixed_endpoint else sorted({
            str(visit.get("stationName") or "").strip()
            for visit in (stage.get("visits") or [])
            if isinstance(visit, Mapping) and str(visit.get("stationName") or "").strip()
        })
        stages.append({
            "kind": "endpoint" if fixed_endpoint else str(stage.get("kind") or ""),
            "needProcess": False if fixed_endpoint else bool(stage.get("needProcess")),
            "candidates": candidates,
        })
    return json.dumps(stages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _workspace_test_route_refs(test_case: Mapping[str, Any]) -> set[str]:
    """收集测试内实际被 PJob 引用的模板名称。"""
    return {
        str(pjob.get("routeRef") or "").strip()
        for round_row in (test_case.get("rounds") or [])
        if isinstance(round_row, Mapping)
        for cjob in (round_row.get("cjobs") or [])
        if isinstance(cjob, Mapping)
        for pjob in (cjob.get("pjobs") or [])
        if isinstance(pjob, Mapping) and str(pjob.get("routeRef") or "").strip()
    }


def _deduplicate_workspace_route_templates(device: Dict[str, Any]) -> int:
    """合并纯拓扑重复模板并迁移测试引用；参数冲突时保留模板以避免数据损失。"""
    routes = [route for route in (device.get("routes") or []) if isinstance(route, dict)]
    tests = [test for test in (device.get("tests") or []) if isinstance(test, dict)]
    canonical_by_key: Dict[str, Dict[str, Any]] = {}
    kept: List[Dict[str, Any]] = []
    removed_count = 0
    for route in routes:
        route_name = str(route.get("name") or "").strip()
        topology_key = _workspace_route_topology_key(route)
        canonical = canonical_by_key.get(topology_key)
        if canonical is None or not route_name:
            canonical_by_key[topology_key] = route
            kept.append(route)
            continue
        canonical_name = str(canonical.get("name") or "").strip()
        conflict = False
        for test_case in tests:
            refs = _workspace_test_route_refs(test_case)
            configs = test_case.get("routeConfigs")
            configs = configs if isinstance(configs, Mapping) else {}
            if (
                route_name in refs and canonical_name in refs
                and route_name in configs and canonical_name in configs
                and configs[route_name] != configs[canonical_name]
            ):
                conflict = True
                break
        if conflict:
            kept.append(route)
            continue

        for test_case in tests:
            refs_before = _workspace_test_route_refs(test_case)
            for round_row in (test_case.get("rounds") or []):
                if not isinstance(round_row, Mapping):
                    continue
                for cjob in (round_row.get("cjobs") or []):
                    if not isinstance(cjob, Mapping):
                        continue
                    for pjob in (cjob.get("pjobs") or []):
                        if isinstance(pjob, dict) and str(pjob.get("routeRef") or "") == route_name:
                            pjob["routeRef"] = canonical_name
            configs = test_case.get("routeConfigs")
            if isinstance(configs, dict) and route_name in configs:
                if canonical_name not in configs or (
                    route_name in refs_before and canonical_name not in refs_before
                ):
                    configs[canonical_name] = configs[route_name]
                configs.pop(route_name, None)
        removed_count += 1
    if removed_count:
        device["routes"] = kept
    return removed_count


def _migrate_workspace_catalog(catalog: Dict[str, Any]) -> bool:
    """迁移设备工作区结构，并为已有 PSE300 补齐 LC/LD LoadLock。"""
    source_version = int(catalog.get("version") or 0)
    changed = source_version != WORKSPACE_STORE_VERSION
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, dict):
            continue
        if source_version < 6:
            original_name = str(raw_device.get("name") or "").strip()
            normalized_name = Path(original_name).stem if original_name else "未命名设备"
            if normalized_name != original_name:
                raw_device["name"] = normalized_name
                changed = True
        routes = list(raw_device.get("routes") or [])
        cleans = list(raw_device.get("cleans") or [])
        tests = [item for item in (raw_device.get("tests") or []) if isinstance(item, dict)]
        test_groups = [
            str(item).strip() for item in (raw_device.get("testGroups") or [])
            if str(item).strip()
        ]
        for test in tests:
            group = str(test.get("group") or "").strip()
            if group and group not in test_groups:
                test_groups.append(group)
            if str(test.get("strategy") or "").strip().lower() == "greedy":
                test["strategy"] = "other_alg:greedy"
                changed = True
            options = test.get("options")
            if isinstance(options, dict) and "loadLockExchange" in options:
                options.pop("loadLockExchange")
                changed = True
        if raw_device.get("testGroups") != test_groups:
            raw_device["testGroups"] = test_groups
            changed = True
        raw_topology = raw_device.get("device")
        if isinstance(raw_topology, dict) and expand_pse300_loadlocks(raw_topology):
            raw_device["fingerprint"] = _device_fingerprint(raw_topology)
            changed = True
        # 旧数据按更新时间从早到晚合并；同时先把每个测试原有参数提取为独立配置。
        for test in sorted(tests, key=lambda item: str(item.get("updatedAt") or item.get("createdAt") or "")):
            if "routes" in test:
                legacy_test_routes = [
                    route for route in (test.get("routes") or [])
                    if isinstance(route, Mapping)
                ]
                if "routeConfigs" not in test:
                    test["routeConfigs"] = _workspace_route_config_map(
                        legacy_test_routes,
                    )
                routes = _merge_named_assets(routes, legacy_test_routes)
                test.pop("routes", None)
                changed = True
            if source_version < 5 and "cleans" in test:
                cleans = _merge_named_assets(cleans, test.get("cleans") or [])
        legacy_route_configs = _workspace_route_config_map(routes)
        for test in tests:
            if not isinstance(test.get("routeConfigs"), Mapping):
                test["routeConfigs"] = deepcopy(legacy_route_configs)
                changed = True
            if not isinstance(test.get("cleans"), list):
                test["cleans"] = deepcopy(cleans)
                changed = True
        if source_version < 5:
            if _repair_workspace_route_recipes(
                routes,
                _workspace_processing_modules(raw_device),
            ):
                changed = True
        if _repair_workspace_route_contracts(routes):
            changed = True
        normalized_templates = _normalized_workspace_routes(routes)
        if routes != normalized_templates:
            routes = normalized_templates
            changed = True
        if _repair_workspace_job_layout(raw_device):
            changed = True
        if raw_device.get("routes") != routes:
            raw_device["routes"] = routes
            changed = True
        if _deduplicate_workspace_route_templates(raw_device):
            routes = list(raw_device.get("routes") or [])
            changed = True
        previous_route_configs = [
            deepcopy(test.get("routeConfigs")) for test in tests
        ]
        _synchronize_workspace_test_route_configs(raw_device)
        if previous_route_configs != [test.get("routeConfigs") for test in tests]:
            changed = True
        if source_version < 7:
            for test in tests:
                configs = test.get("routeConfigs")
                if isinstance(configs, Mapping) and _migrate_workspace_pjob_route_configs(test, configs):
                    changed = True
        if raw_device.get("cleans") != cleans:
            raw_device["cleans"] = cleans
            changed = True
    catalog["version"] = WORKSPACE_STORE_VERSION
    return changed


def _read_workspace_catalog_unlocked(path: Path) -> Dict[str, Any]:
    """在调用方持锁时读取并校验设备工作区目录。

    目录模式（``path`` 无后缀）扫描拆分后的设备目录与测试集文件；文件模式
    保留旧单文件格式，供测试与历史数据使用。目录模式存储缺失但旧单文件
    存在时，先自动迁移为拆分目录再读取。
    """
    if path.suffix == "":
        # 目录模式；仅默认存储路径缺失或上次迁移未完成（旧单文件仍在）时重新迁移，
        # 其他目录路径缺失视为空。迁移本身幂等，可安全重入以恢复中断现场。
        if path == WORKSPACE_STORE_PATH and (
            (DATA_DIR / "workspaces.json").is_file()
            or _has_separate_legacy_workspace_directory(path)
        ):
            _migrate_legacy_workspace_store(path)
        elif not path.is_dir():
            if path != WORKSPACE_STORE_PATH:
                return _empty_workspace_catalog()
            legacy_candidates = (DATA_DIR / "workspaces.json", LEGACY_WORKSPACE_STORE_PATH)
            if (
                any(candidate.is_file() for candidate in legacy_candidates)
                or _has_separate_legacy_workspace_directory(path)
            ):
                _migrate_legacy_workspace_store(path)
            else:
                return _empty_workspace_catalog()
        catalog = _read_workspace_catalog_directory(path)
    else:
        if not path.is_file():
            return _empty_workspace_catalog()
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, Mapping) or not isinstance(raw.get("devices"), list):
            raise ValueError(f"设备测试集存储格式无效：{path}")
        catalog = deepcopy(dict(raw))
        changed = _migrate_workspace_catalog(catalog)
        if changed:
            _write_workspace_catalog_unlocked(path, catalog)
        return catalog
    # 已完成当前版本迁移且目录内容没有外部变更时，避免每次读取都遍历并
    # 规范化所有测试集。路径模板的快速保存依赖此分支只读取必要文件。
    if not _workspace_data_update_required(path):
        return catalog
    _backup_workspace_directory_before_upgrade(path)
    changed = _migrate_workspace_catalog(catalog)
    if changed:
        _write_workspace_catalog_unlocked(path, catalog)
    return catalog


def _uses_readable_dataset_layout(store_dir: Path) -> bool:
    """判断目录是否使用 v6 可读布局；测试和旧调用仍可读取 v5 目录。"""
    if store_dir == WORKSPACE_STORE_PATH or store_dir.name.startswith(f".{WORKSPACE_STORE_PATH.name}."):
        return True
    try:
        manifest = json.loads((store_dir / WORKSPACE_STORE_VERSION_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        manifest = {}
    return (
        isinstance(manifest, Mapping)
        and manifest.get("kind") == "ct-scheduler-datasets"
    ) or any(store_dir.glob("*/metadata.json"))


def _read_workspace_catalog_directory(store_dir: Path) -> Dict[str, Any]:
    """根据目录清单读取 v6 可读布局或兼容的 v5 UUID 布局。"""
    if not _uses_readable_dataset_layout(store_dir):
        return _read_legacy_workspace_catalog_directory(store_dir)
    return _read_readable_workspace_catalog_directory(store_dir)


def _read_readable_workspace_catalog_directory(store_dir: Path) -> Dict[str, Any]:
    """扫描新版分层目录，组装供现有业务逻辑使用的完整设备目录。"""
    catalog = _empty_workspace_catalog()
    catalog["version"] = _read_workspace_store_version(store_dir)
    if not store_dir.is_dir():
        return catalog
    for device_dir in sorted(store_dir.iterdir()):
        if not device_dir.is_dir():
            continue
        metadata_file = device_dir / "metadata.json"
        device_file = device_dir / "device.json"
        if not metadata_file.is_file() or not device_file.is_file():
            continue
        try:
            raw_device = json.loads(metadata_file.read_text(encoding="utf-8"))
            init_data = json.loads(device_file.read_text(encoding="utf-8"))
            routes_payload = json.loads(
                (device_dir / "routes.json").read_text(encoding="utf-8")
            ) if (device_dir / "routes.json").is_file() else {}
            groups_payload = json.loads(
                (device_dir / "groups.json").read_text(encoding="utf-8")
            ) if (device_dir / "groups.json").is_file() else {}
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"设备文件无效：{device_file}") from error
        if not isinstance(raw_device, dict) or not isinstance(init_data, dict):
            continue
        init_options = raw_device.pop("initOptions", {})
        if isinstance(init_options, Mapping):
            init_data.update(deepcopy(dict(init_options)))
        raw_device["device"] = init_data
        raw_device["routes"] = (
            deepcopy(routes_payload.get("routes") or [])
            if isinstance(routes_payload, Mapping) else []
        )
        raw_device["cleans"] = (
            deepcopy(routes_payload.get("cleans") or [])
            if isinstance(routes_payload, Mapping) else []
        )
        raw_device["routeAliases"] = (
            deepcopy(routes_payload.get("routeAliases") or {})
            if isinstance(routes_payload, Mapping) else {}
        )
        raw_device["testGroups"] = (
            deepcopy(groups_payload.get("testGroups") or [])
            if isinstance(groups_payload, Mapping) else []
        )
        if isinstance(groups_payload, Mapping) and "robotSlots" in groups_payload:
            raw_device["robotSlots"] = deepcopy(groups_payload["robotSlots"])
        tests = []
        tests_dir = device_dir / "tests"
        if tests_dir.is_dir():
            for test_file in sorted(tests_dir.glob("*/test.json")):
                try:
                    raw_test = json.loads(test_file.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    raise ValueError(f"测试集文件无效：{test_file}") from error
                if isinstance(raw_test, dict):
                    tests.append(raw_test)
        raw_device["tests"] = tests
        catalog["devices"].append(raw_device)
    return catalog


def _read_legacy_workspace_catalog_directory(store_dir: Path) -> Dict[str, Any]:
    """只读旧版 UUID 目录，作为 v5 到 v6 的迁移输入。"""
    catalog = {"version": _read_workspace_store_version(store_dir), "devices": []}
    for device_dir in sorted(store_dir.iterdir()) if store_dir.is_dir() else []:
        device_file = device_dir / "device.json"
        if not device_file.is_file():
            continue
        try:
            raw_device = json.loads(device_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"旧设备文件无效：{device_file}") from error
        if not isinstance(raw_device, dict) or "device" not in raw_device:
            continue
        tests = []
        for test_file in sorted((device_dir / "tests").glob("*.json")):
            if test_file.name == WORKSPACE_TEST_INDEX_FILE:
                continue
            try:
                raw_test = json.loads(test_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ValueError(f"旧测试集文件无效：{test_file}") from error
            if isinstance(raw_test, dict):
                tests.append(raw_test)
        raw_device["tests"] = tests
        catalog["devices"].append(raw_device)
    return catalog


def _migrate_legacy_workspace_store(store_dir: Path) -> None:
    """把旧单文件存储迁移为拆分目录，迁移后旧文件保留为 ``*.legacy.json``。

    持锁调用；只处理确实存在的旧文件。迁移是幂等的：先清理可能存在的残留
    目录再重建，因此上次迁移中断后可以安全重入。迁移成功后旧文件改名，
    避免重复迁移；确认数据无误后可手动删除旧文件。
    """
    legacy_workspace_directory = _legacy_workspace_directory_path()
    if _has_separate_legacy_workspace_directory(store_dir):
        if store_dir.is_dir():
            if (
                not _uses_readable_dataset_layout(store_dir)
                or _read_workspace_store_version(store_dir) != WORKSPACE_STORE_VERSION
            ):
                raise ValueError(f"目标数据目录已存在且格式不完整，拒绝覆盖：{store_dir}")
        else:
            catalog = _read_legacy_workspace_catalog_directory(legacy_workspace_directory)
            _migrate_workspace_catalog(catalog)
            temporary_store = store_dir.with_name(f".{store_dir.name}.{uuid.uuid4().hex}.tmp")
            _write_workspace_catalog_directory(temporary_store, catalog)
            temporary_store.replace(store_dir)
        backup_root = DATA_DIR / "migration-backups"
        backup_root.mkdir(parents=True, exist_ok=True)
        backup_stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        backup_name = f"workspaces-v5-{backup_stamp}"
        shutil.move(str(legacy_workspace_directory), str(backup_root / backup_name))
        legacy_device_mirrors = DATA_DIR / "devices"
        if legacy_device_mirrors.is_dir():
            shutil.move(
                str(legacy_device_mirrors),
                str(backup_root / f"device-mirrors-v5-{backup_stamp}"),
            )
        legacy_single_backup = DATA_DIR / "workspaces.json.legacy.json"
        if legacy_single_backup.is_file():
            shutil.move(
                str(legacy_single_backup),
                str(backup_root / f"workspaces-single-file-{backup_stamp}.legacy.json"),
            )
        return
    legacy_candidates = (DATA_DIR / "workspaces.json", LEGACY_WORKSPACE_STORE_PATH)
    for legacy_file in legacy_candidates:
        if not legacy_file.is_file():
            continue
        catalog = _read_workspace_catalog_unlocked(legacy_file)
        shutil.rmtree(store_dir, ignore_errors=True)
        _write_workspace_catalog_unlocked(store_dir, catalog)
        backup_path = legacy_file.with_name(f"{legacy_file.name}.legacy.json")
        legacy_file.replace(backup_path)
        return


def _write_text_atomic(path: Path, content: str) -> None:
    """原子写入 UTF-8 文本，避免异常退出留下半份文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp"
    )
    try:
        temporary_path.write_text(content, encoding="utf-8")
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _write_json_atomic(path: Path, payload: Any) -> None:
    """把 JSON 原子写入指定文件，避免异常退出留下半份配置。"""
    content = json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2)
    _write_text_atomic(path, content)


def save_model_checkpoint(filename: str, content: bytes) -> Path:
    """安全保存前端选取的模型文件，并返回算法运行时可读取的绝对路径。

    浏览器出于隐私保护不会提供用户选择文件的真实路径；因此将文件复制到本地
    服务的数据目录。文件名只保留 basename，避免请求头构造出目录穿越路径。
    """
    source_name = Path(filename).name.strip()
    suffix = Path(source_name).suffix.lower()
    if not source_name or suffix not in ALLOWED_CHECKPOINT_SUFFIXES:
        allowed = "、".join(sorted(ALLOWED_CHECKPOINT_SUFFIXES))
        raise ValueError(f"checkpoint 文件格式仅支持：{allowed}")
    if not content:
        raise ValueError("checkpoint 文件为空")
    if len(content) > MAX_CHECKPOINT_BYTES:
        raise ValueError("checkpoint 文件超过大小限制")
    safe_stem = re.sub(r"[^A-Za-z0-9._-]", "_", Path(source_name).stem).strip("._")
    if not safe_stem:
        safe_stem = "checkpoint"
    safe_name = f"{safe_stem[:96]}{suffix}"
    target = MODEL_CHECKPOINT_DIR / f"{uuid.uuid4().hex}-{safe_name}"
    with _MODEL_CHECKPOINT_LOCK:
        MODEL_CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.upload")
        try:
            temporary.write_bytes(content)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target.resolve()


def read_algorithm_metadata() -> Dict[str, Dict[str, str]]:
    """从算法仓库清单实时返回内置算法的名称和介绍。"""
    return {
        str(algorithm["strategy"]): {
            "name": str(algorithm["name"]),
            "introduction": str(algorithm["introduction"]),
        }
        for algorithm in discover_builtin_algorithms()
    }


def algorithm_metadata_for_health(
    builtin_algorithms: Optional[Sequence[Mapping[str, Any]]] = None,
    other_algorithms: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Dict[str, str]]:
    """返回健康检查使用的算法介绍，并补齐标准算法包的默认介绍。"""
    discovered_builtin_algorithms = (
        discover_builtin_algorithms()
        if builtin_algorithms is None
        else builtin_algorithms
    )
    metadata = {
        str(algorithm["strategy"]): {
            "name": str(algorithm["name"]),
            "introduction": str(algorithm["introduction"]),
        }
        for algorithm in discovered_builtin_algorithms
    }
    discovered_algorithms = (
        discover_other_algorithms()
        if other_algorithms is None
        else other_algorithms
    )
    for algorithm in discovered_algorithms:
        strategy = str(algorithm["strategy"])
        metadata.setdefault(strategy, {
            "name": str(algorithm["name"]),
            "introduction": "通过标准 init/update 接口接入的外部排程算法。",
        })
    return metadata


def format_reproduction_log(entries: Sequence[Mapping[str, Any]]) -> str:
    """生成顶层事件各占一行、同时保持可直接解析的 JSON 数组。"""
    event_lines = [
        json.dumps(entry, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        for entry in entries
    ]
    if not event_lines:
        return "[]"
    return "[\n" + ",\n".join(event_lines) + "\n]"


def _write_workspace_catalog_unlocked(path: Path, catalog: Mapping[str, Any]) -> None:
    """在调用方持锁时保存设备工作区目录。

    目录模式（``path`` 无后缀）把 catalog 拆分写为设备目录与测试集文件，
    便于单个测试集或设备直接拷贝分享；文件模式保留旧单文件格式。两种模式
    默认存储只维护 ``data/datasets`` 这一份设备事实来源。
    """
    if path.suffix == "":
        _write_workspace_catalog_directory(path, catalog)
        return
    _write_json_atomic(path, catalog)


def _write_json_if_changed(path: Path, payload: Any) -> None:
    """内容变化时才原子写入 JSON，避免全量重写覆盖他人刚更新的文件。"""
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        current = None
    if current != payload:
        _write_json_atomic(path, payload)


def _write_workspace_catalog_directory(store_dir: Path, catalog: Mapping[str, Any]) -> None:
    """按目录版本选择 v6 可读布局或兼容的 v5 UUID 布局。"""
    if not _uses_readable_dataset_layout(store_dir):
        _write_legacy_workspace_catalog_directory(store_dir, catalog)
        return
    _write_readable_workspace_catalog_directory(store_dir, catalog)


def _write_legacy_workspace_catalog_directory(
    store_dir: Path,
    catalog: Mapping[str, Any],
) -> None:
    """为旧测试夹具和显式非默认目录保留 v5 拆分写入能力。"""
    store_dir.mkdir(parents=True, exist_ok=True)
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, Mapping):
            continue
        device = deepcopy(dict(raw_device))
        device_id = str(device.get("id") or "").strip()
        if not device_id:
            continue
        tests = device.pop("tests", None)
        device_dir = store_dir / device_id
        device_dir.mkdir(parents=True, exist_ok=True)
        _write_json_if_changed(device_dir / "device.json", device)
        tests_dir = device_dir / "tests"
        tests_dir.mkdir(parents=True, exist_ok=True)
        for raw_test in tests or []:
            if not isinstance(raw_test, Mapping):
                continue
            test = dict(raw_test)
            test_id = str(test.get("id") or "").strip()
            if test_id:
                _write_json_if_changed(tests_dir / f"{test_id}.json", test)
        _write_json_if_changed(
            _workspace_test_index_path(tests_dir),
            [
                _workspace_test_summary(test_case)
                for test_case in tests or []
                if isinstance(test_case, Mapping)
            ],
        )
    _write_json_atomic(
        store_dir / WORKSPACE_STORE_VERSION_FILE,
        {"version": WORKSPACE_STORE_VERSION},
    )


def _write_readable_workspace_catalog_directory(
    store_dir: Path,
    catalog: Mapping[str, Any],
) -> None:
    """把目录写为“可读设备目录 + 纯 init + 路径 + 独立测试集”结构。"""
    store_dir.mkdir(parents=True, exist_ok=True)
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, Mapping):
            continue
        device = deepcopy(dict(raw_device))
        device_id = str(device.get("id") or "").strip()
        if not device_id:
            continue
        tests = device.pop("tests", None)
        existing_dir = _find_dataset_device_directory(store_dir, device_id)
        desired_dir = _dataset_device_directory(store_dir, device)
        if existing_dir is not None and existing_dir != desired_dir and not desired_dir.exists():
            existing_dir.replace(desired_dir)
        device_dir = desired_dir if desired_dir.exists() or existing_dir is None else existing_dir
        device_dir.mkdir(parents=True, exist_ok=True)
        init_data, init_options = _split_device_init_data(device.pop("device", {}))
        if init_options:
            device["initOptions"] = init_options
        else:
            device.pop("initOptions", None)
        routes_payload = {
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "routes": device.pop("routes", []),
            "cleans": device.pop("cleans", []),
            "routeAliases": device.pop("routeAliases", {}),
        }
        groups_payload = {
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "testGroups": device.pop("testGroups", []),
        }
        if "robotSlots" in device:
            groups_payload["robotSlots"] = device.pop("robotSlots")
        device["schemaVersion"] = WORKSPACE_STORE_VERSION
        _write_json_if_changed(device_dir / "metadata.json", device)
        _write_json_if_changed(device_dir / "device.json", init_data)
        _write_json_if_changed(device_dir / "routes.json", routes_payload)
        _write_json_if_changed(device_dir / "groups.json", groups_payload)
        tests_dir = device_dir / "tests"
        tests_dir.mkdir(parents=True, exist_ok=True)
        for raw_test in tests or []:
            if not isinstance(raw_test, Mapping):
                continue
            test = dict(raw_test)
            test_id = str(test.get("id") or "").strip()
            if not test_id:
                continue
            existing_test_file = _find_dataset_test_file(device_dir, test_id)
            desired_test_dir = _dataset_test_directory(tests_dir, test)
            if (
                existing_test_file is not None
                and existing_test_file.parent != desired_test_dir
                and not desired_test_dir.exists()
            ):
                existing_test_file.parent.replace(desired_test_dir)
            test_dir = (
                desired_test_dir
                if desired_test_dir.exists() or existing_test_file is None
                else existing_test_file.parent
            )
            test_dir.mkdir(parents=True, exist_ok=True)
            test["schemaVersion"] = WORKSPACE_STORE_VERSION
            _write_json_if_changed(test_dir / "test.json", test)
        _write_json_if_changed(
            _workspace_test_index_path(tests_dir),
            [
                _workspace_test_summary(test_case)
                for test_case in tests or []
                if isinstance(test_case, Mapping)
            ],
        )
    _write_workspace_store_version(store_dir)


def _remove_directory_test_file(store_dir: Path, device_id: str, test_id: str) -> None:
    """目录模式下物理删除单个测试集文件；文件模式为空操作。"""
    if store_dir.suffix == "":
        if _uses_readable_dataset_layout(store_dir):
            device_dir = _find_dataset_device_directory(store_dir, device_id)
            test_file = _find_dataset_test_file(device_dir, test_id) if device_dir else None
            if test_file is not None:
                shutil.rmtree(test_file.parent)
        else:
            (store_dir / device_id / "tests" / f"{test_id}.json").unlink(missing_ok=True)


def _schedule_directory_cleanup(directory: Path) -> None:
    """在后台清理已移出活动数据树的删除暂存目录。

    调用前必须保证目录不再被索引引用。清理失败或进程中断时目录保持隐藏，
    后续读取不会把其中的测试重新识别为有效数据。
    """
    def cleanup() -> None:
        """递归删除单个已隔离目录；失败时留待后续维护清理。"""
        for delay_seconds in WORKSPACE_DELETE_CLEANUP_RETRY_DELAYS_SECONDS:
            if delay_seconds:
                time.sleep(delay_seconds)
            shutil.rmtree(directory, ignore_errors=True)
            if not directory.exists():
                return

    threading.Thread(
        target=cleanup,
        name=f"workspace-delete-{directory.name}",
        daemon=True,
    ).start()


def _remove_directory_device_dir(store_dir: Path, device_id: str) -> None:
    """目录模式下物理删除整个设备目录（含全部测试集文件）；文件模式为空操作。"""
    if store_dir.suffix == "":
        if _uses_readable_dataset_layout(store_dir):
            device_dir = _find_dataset_device_directory(store_dir, device_id)
            if device_dir is not None:
                shutil.rmtree(device_dir)
        else:
            shutil.rmtree(store_dir / device_id, ignore_errors=True)


def list_workspace_devices(path: Path = WORKSPACE_STORE_PATH) -> List[Dict[str, Any]]:
    """列出本地保存的设备摘要，不返回体积较大的 init 和测试集内容。"""
    with _workspace_catalog_guard(path):
        fast_devices = _fast_list_workspace_devices_unlocked(path)
        if fast_devices is not None:
            return fast_devices
        catalog = _read_workspace_catalog_unlocked(path)
        return [{
            "id": str(device.get("id") or ""),
            "name": str(device.get("name") or "未命名设备"),
            "testCount": len(device.get("tests") or []),
            "updatedAt": device.get("updatedAt"),
        } for device in catalog["devices"] if isinstance(device, Mapping)]


def _fast_list_workspace_devices_unlocked(
    path: Path,
) -> Optional[List[Dict[str, Any]]]:
    """只读取设备元数据与测试摘要索引，生成设备列表。

    Args:
        path: 已由调用方加锁的工作区目录。

    Returns:
        当前 v6 目录可按需读取时返回设备摘要；目录不完整时返回 ``None``，
        由调用方进入兼容的完整读取与修复流程。
    """
    if not _workspace_store_is_current(path) or not _uses_readable_dataset_layout(path):
        return None
    devices: List[Dict[str, Any]] = []
    try:
        for device_dir in sorted(path.iterdir()):
            if not device_dir.is_dir():
                continue
            metadata = json.loads(
                (device_dir / "metadata.json").read_text(encoding="utf-8")
            )
            summaries = json.loads(
                _workspace_test_index_path(device_dir / "tests").read_text(
                    encoding="utf-8"
                )
            )
            if not isinstance(metadata, Mapping) or not isinstance(summaries, list):
                return None
            devices.append({
                "id": str(metadata.get("id") or ""),
                "name": str(metadata.get("name") or "未命名设备"),
                "testCount": len(summaries),
                "updatedAt": metadata.get("updatedAt"),
            })
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    return devices


def get_workspace_device(device_id: str, path: Path = WORKSPACE_STORE_PATH) -> Dict[str, Any]:
    """读取一个设备及其全部测试集，设备不存在时抛出明确错误。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        return deepcopy(dict(device))


def _workspace_test_summary(test_case: Mapping[str, Any]) -> Dict[str, Any]:
    """返回设备切换所需的测试选择信息，不携带完整排程数据。"""
    return {
        "id": str(test_case.get("id") or ""),
        "name": str(test_case.get("name") or "未命名测试集"),
        "group": str(test_case.get("group") or ""),
    }


def _normalized_route_aliases(raw_aliases: Any) -> Dict[str, str]:
    """规范化 Route 自动改名链，丢弃空值与无意义的自映射。"""
    return {
        str(old_name): str(new_name)
        for old_name, new_name in (
            raw_aliases.items() if isinstance(raw_aliases, Mapping) else []
        )
        if str(old_name) and str(new_name) and str(old_name) != str(new_name)
    }


def _resolve_route_alias(route_name: str, aliases: Mapping[str, str]) -> str:
    """沿自动改名链得到最新模板名；异常循环保持原名以避免破坏历史数据。"""
    current = route_name
    visited = {current}
    while current in aliases:
        next_name = str(aliases[current] or "")
        if not next_name or next_name in visited:
            return route_name
        visited.add(next_name)
        current = next_name
    return current


def _apply_route_aliases_to_test(test_case: Dict[str, Any], aliases: Mapping[str, str]) -> None:
    """在读取时延迟应用模板改名，避免保存时重写每个历史测试文件。"""
    if not aliases:
        return
    for round_row in test_case.get("rounds") or []:
        if not isinstance(round_row, Mapping):
            continue
        for cjob in round_row.get("cjobs") or []:
            if not isinstance(cjob, Mapping):
                continue
            for pjob in cjob.get("pjobs") or []:
                if not isinstance(pjob, dict):
                    continue
                route_ref = str(pjob.get("routeRef") or "")
                pjob["routeRef"] = _resolve_route_alias(route_ref, aliases)
    route_configs = test_case.get("routeConfigs")
    if not isinstance(route_configs, dict):
        return
    for old_name in list(route_configs):
        new_name = _resolve_route_alias(str(old_name), aliases)
        if new_name == old_name:
            continue
        if new_name not in route_configs:
            route_configs[new_name] = route_configs[old_name]
        route_configs.pop(old_name, None)


def _fast_workspace_device_overview_unlocked(
    device_id: str,
    path: Path,
) -> Optional[Dict[str, Any]]:
    """从已迁移的目录存储读取设备和测试摘要，不解析所有完整测试文件。"""
    if (
        path.suffix
        or not re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
        or not _workspace_store_is_current(path)
    ):
        return None
    readable_layout = _uses_readable_dataset_layout(path)
    device_dir = (
        _find_dataset_device_directory(path, device_id)
        if readable_layout else path / device_id
    )
    if device_dir is None:
        return None
    device_file = device_dir / "device.json"
    tests_dir = device_dir / "tests"
    try:
        if readable_layout:
            device = json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
            init_data = json.loads(device_file.read_text(encoding="utf-8"))
            routes_payload = json.loads((device_dir / "routes.json").read_text(encoding="utf-8"))
            groups_payload = json.loads((device_dir / "groups.json").read_text(encoding="utf-8"))
        else:
            device = json.loads(device_file.read_text(encoding="utf-8"))
        summaries = json.loads(
            _workspace_test_index_path(tests_dir).read_text(encoding="utf-8")
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(device, dict) or not isinstance(summaries, list):
        return None
    if not all(isinstance(summary, Mapping) for summary in summaries):
        return None
    if readable_layout:
        if not all(isinstance(value, Mapping) for value in (init_data, routes_payload, groups_payload)):
            return None
        init_options = device.pop("initOptions", {})
        if isinstance(init_options, Mapping):
            init_data.update(deepcopy(dict(init_options)))
        device["device"] = init_data
        device["routes"] = deepcopy(routes_payload.get("routes") or [])
        device["cleans"] = deepcopy(routes_payload.get("cleans") or [])
        device["routeAliases"] = deepcopy(routes_payload.get("routeAliases") or {})
        device["testGroups"] = deepcopy(groups_payload.get("testGroups") or [])
        if "robotSlots" in groups_payload:
            device["robotSlots"] = deepcopy(groups_payload["robotSlots"])
    device["tests"] = [
        _workspace_test_summary(summary) for summary in summaries
    ]
    return device


def get_workspace_device_overview(
    device_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """读取设备拓扑、共享模板和测试摘要；完整测试在选中时按需读取。"""
    with _workspace_catalog_guard(path):
        overview = _fast_workspace_device_overview_unlocked(device_id, path)
        if overview is not None:
            return overview
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        summaries = [
            _workspace_test_summary(test_case)
            for test_case in device.get("tests") or []
            if isinstance(test_case, Mapping)
        ]
        overview = deepcopy(dict(device))
        overview["tests"] = summaries
        return overview


def get_workspace_test(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """读取指定设备中的单个完整测试集，供前端延迟加载。"""
    with _workspace_catalog_guard(path):
        if (
            not path.suffix
            and re.fullmatch(r"[A-Za-z0-9_-]+", device_id)
            and _workspace_store_is_current(path)
            and re.fullmatch(r"[A-Za-z0-9_-]+", test_id)
        ):
            readable_layout = _uses_readable_dataset_layout(path)
            device_dir = (
                _find_dataset_device_directory(path, device_id)
                if readable_layout else path / device_id
            )
            try:
                test_file = (
                    _find_dataset_test_file(device_dir, test_id)
                    if readable_layout and device_dir is not None
                    else path / device_id / "tests" / f"{test_id}.json"
                )
                if test_file is None:
                    raise FileNotFoundError(test_id)
                test_case = json.loads(test_file.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                test_case = None
            if isinstance(test_case, dict) and str(test_case.get("id") or "") == test_id:
                try:
                    aliases_file = (
                        device_dir / "routes.json"
                        if readable_layout and device_dir is not None
                        else path / device_id / "device.json"
                    )
                    device = json.loads(aliases_file.read_text(encoding="utf-8"))
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    device = {}
                _apply_route_aliases_to_test(
                    test_case,
                    _normalized_route_aliases(device.get("routeAliases"))
                    if isinstance(device, Mapping) else {},
                )
                return test_case
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        test_case = next((
            item for item in device.get("tests") or []
            if isinstance(item, Mapping) and str(item.get("id") or "") == test_id
        ), None)
        if test_case is None:
            raise ValueError(f"测试集不存在：{test_id}")
        resolved = deepcopy(dict(test_case))
        _apply_route_aliases_to_test(
            resolved, _normalized_route_aliases(device.get("routeAliases")),
        )
        return resolved


def get_workspace_run_context(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """按需读取单测运行所需的设备概览和目标测试。

    参数 ``device_id`` 和 ``test_id`` 分别标识设备与测试；返回不含其他完整
    测试的设备上下文及目标测试。该边界供单测运行接口使用，避免点击运行时退回
    到读取整台设备全部 ``test.json`` 的旧目录路径。
    """
    device = get_workspace_device_overview(device_id, path)
    test_case = get_workspace_test(device_id, test_id, path)
    return device, test_case



__all__ = tuple(name for name in globals() if not name.startswith('__'))
