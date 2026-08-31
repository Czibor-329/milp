"""工作区设备与测试交换包的编解码、校验和导入导出规则。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.time_utils import _workspace_timestamp
from realtime_scheduler.backend.workspace.repository import *
from realtime_scheduler.backend.execution.cjob_cycle import _cjob_cycle_count
from realtime_scheduler.backend.execution.batch_service import _invalidate_stale_device_baselines

def _report_transfer_progress(
    callback: Any,
    phase: str,
    progress: int,
    message: str,
) -> None:
    """向可选的长任务观察者报告稳定阶段与百分比。"""
    if callback is not None:
        callback(phase, max(0, min(100, int(progress))), message)


def _zip_json_bytes(files: Mapping[str, Any], progress_callback: Any = None) -> bytes:
    """把若干 JSON 对象写入内存 ZIP，供设备和测试集交换。"""
    stream = BytesIO()
    total_files = max(1, len(files))
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        for file_index, (filename, payload) in enumerate(files.items(), start=1):
            archive.writestr(
                filename,
                json.dumps(
                    payload,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                ),
            )
            _report_transfer_progress(
                progress_callback,
                "compressing",
                10 + round(file_index / total_files * 80),
                f"正在压缩文件 {file_index}/{total_files}",
            )
    return stream.getvalue()


def _read_exchange_archive(content: bytes, progress_callback: Any = None) -> Dict[str, Any]:
    """读取受限交换包；拒绝路径穿越、重复文件和超大解压内容。"""
    try:
        archive = ZipFile(BytesIO(content), "r")
    except Exception as error:  # noqa: BLE001
        raise ValueError("导入文件不是有效的 CT 数据包") from error
    files: Dict[str, Any] = {}
    total_size = 0
    with archive:
        archive_entries = archive.infolist()
        total_entries = max(1, len(archive_entries))
        for entry_index, info in enumerate(archive_entries, start=1):
            normalized = info.filename.replace("\\", "/").strip("/")
            if (
                not normalized
                or normalized in files
                or normalized.startswith("../")
                or "/../" in f"/{normalized}/"
                or info.is_dir()
            ):
                raise ValueError("导入包包含无效或重复路径")
            total_size += info.file_size
            if total_size > DATA_EXCHANGE_MAX_UNCOMPRESSED_BYTES:
                raise ValueError("导入包解压后超过 512 MiB 限制")
            try:
                payload = json.loads(archive.read(info).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(f"导入包中的 JSON 无效：{normalized}") from error
            files[normalized] = payload
            _report_transfer_progress(
                progress_callback,
                "validating",
                10 + round(entry_index / total_entries * 45),
                f"正在校验文件 {entry_index}/{total_entries}",
            )
    manifest = files.get("manifest.json")
    if not isinstance(manifest, Mapping):
        raise ValueError("导入包缺少 manifest.json")
    version = int(manifest.get("schemaVersion") or 0)
    if version != WORKSPACE_STORE_VERSION:
        if version > WORKSPACE_STORE_VERSION:
            raise ValueError(f"数据包版本 v{version} 高于当前支持的 v{WORKSPACE_STORE_VERSION}")
        raise ValueError(f"不支持数据包版本 v{version}，请先用对应版本平台升级")
    files["manifest.json"] = dict(manifest)
    return files


def _exchange_metadata(device: Mapping[str, Any]) -> Dict[str, Any]:
    """提取设备元数据，排除 init、路径和测试内容。"""
    excluded = {"device", "routes", "cleans", "routeAliases", "testGroups", "robotSlots", "tests"}
    metadata = {
        key: deepcopy(value)
        for key, value in device.items()
        if key not in excluded
    }
    metadata["schemaVersion"] = WORKSPACE_STORE_VERSION
    return metadata


def _exchange_routes(device: Mapping[str, Any], route_names: Optional[set[str]] = None) -> Dict[str, Any]:
    """提取设备路径；测试集交换只携带实际引用的路径。"""
    routes = [
        deepcopy(route) for route in (device.get("routes") or [])
        if isinstance(route, Mapping)
        and (route_names is None or str(route.get("name") or "") in route_names)
    ]
    return {
        "schemaVersion": WORKSPACE_STORE_VERSION,
        "routes": routes,
        "cleans": deepcopy(device.get("cleans") or []) if route_names is None else [],
        "routeAliases": deepcopy(device.get("routeAliases") or {}) if route_names is None else {},
    }


def export_workspace_device(
    device_id: str,
    path: Path = WORKSPACE_STORE_PATH,
    progress_callback: Any = None,
) -> Tuple[bytes, str]:
    """导出设备 init、路径、组别及全部测试集的自包含交换包。"""
    _report_transfer_progress(progress_callback, "reading", 3, "正在读取设备数据")
    if not path.suffix and _workspace_store_is_current(path) and _uses_readable_dataset_layout(path):
        with _workspace_catalog_guard(path):
            device_dir = _find_dataset_device_directory(path, device_id)
            if device_dir is None:
                raise ValueError(f"设备不存在：{device_id}")
            try:
                metadata = json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
                init_data = json.loads((device_dir / "device.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ValueError(f"设备文件无效：{device_id}") from error
            if not isinstance(metadata, Mapping) or not isinstance(init_data, Mapping):
                raise ValueError(f"设备文件无效：{device_id}")
            test_files = sorted((device_dir / "tests").glob("*/test.json"))
            fixed_files = (
                device_dir / "metadata.json",
                device_dir / "device.json",
                device_dir / "routes.json",
                device_dir / "groups.json",
            )
            total_files = max(1, len(test_files) + len(fixed_files) + 1)
            stream = BytesIO()
            with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
                archive.writestr(
                    "manifest.json",
                    json.dumps({
                        "kind": DATA_EXCHANGE_KIND_DEVICE,
                        "schemaVersion": WORKSPACE_STORE_VERSION,
                        "deviceId": device_id,
                        "deviceFingerprint": _device_fingerprint(init_data),
                    }, ensure_ascii=False, separators=(",", ":")),
                )
                completed_files = 1
                for source_file in fixed_files:
                    if not source_file.is_file():
                        raise ValueError(f"设备文件缺失：{source_file.name}")
                    archive.write(source_file, source_file.name)
                    completed_files += 1
                    _report_transfer_progress(
                        progress_callback,
                        "compressing",
                        5 + round(completed_files / total_files * 90),
                        f"正在压缩文件 {completed_files}/{total_files}",
                    )
                for test_file in test_files:
                    archive.write(
                        test_file,
                        f"tests/{test_file.parent.name}/test.json",
                    )
                    completed_files += 1
                    _report_transfer_progress(
                        progress_callback,
                        "compressing",
                        5 + round(completed_files / total_files * 90),
                        f"正在压缩测试集 {completed_files - len(fixed_files) - 1}/{len(test_files)}",
                    )
            safe_name = re.sub(
                r"[^A-Za-z0-9._-]+", "-", str(metadata.get("name") or "device")
            ).strip("-") or "device"
            return stream.getvalue(), f"ct-device-{safe_name}-v{WORKSPACE_STORE_VERSION}.zip"
    device = get_workspace_device(device_id, path)
    init_data, init_options = _split_device_init_data(device.get("device") or {})
    metadata = _exchange_metadata(device)
    if init_options:
        metadata["initOptions"] = init_options
    files: Dict[str, Any] = {
        "manifest.json": {
            "kind": DATA_EXCHANGE_KIND_DEVICE,
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "deviceId": device_id,
            "deviceFingerprint": _device_fingerprint(init_data),
        },
        "metadata.json": metadata,
        "device.json": init_data,
        "routes.json": _exchange_routes(device),
        "groups.json": {
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "testGroups": deepcopy(device.get("testGroups") or []),
            "robotSlots": deepcopy(device.get("robotSlots") or {}),
        },
    }
    for test_case in device.get("tests") or []:
        if not isinstance(test_case, Mapping):
            continue
        test_dir = _uuid_storage_segment(str(test_case.get("id") or ""))
        files[f"tests/{test_dir}/test.json"] = deepcopy(dict(test_case))
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(device.get("name") or "device")).strip("-") or "device"
    return _zip_json_bytes(files, progress_callback), f"ct-device-{safe_name}-v{WORKSPACE_STORE_VERSION}.zip"


def export_workspace_test(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[bytes, str]:
    """导出单个测试及其引用路径；导入时必须匹配设备 init 指纹。"""
    device = get_workspace_device(device_id, path)
    test_case = next((
        test for test in device.get("tests") or []
        if isinstance(test, Mapping) and str(test.get("id") or "") == test_id
    ), None)
    if test_case is None:
        raise ValueError(f"测试集不存在：{test_id}")
    route_names = _workspace_test_route_refs(test_case)
    files = {
        "manifest.json": {
            "kind": DATA_EXCHANGE_KIND_TEST,
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "deviceFingerprint": _device_fingerprint(device.get("device") or {}),
            "sourceDeviceName": str(device.get("name") or "未命名设备"),
        },
        "routes.json": _exchange_routes(device, route_names),
        "test.json": deepcopy(dict(test_case)),
    }
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(test_case.get("name") or "test")).strip("-") or "test"
    return _zip_json_bytes(files), f"ct-test-{safe_name}-v{WORKSPACE_STORE_VERSION}.zip"


def _merge_exchange_routes(device: Dict[str, Any], imported_routes: Any) -> None:
    """合并交换包路径；同名不同内容时拒绝，避免测试被静默改义。"""
    routes = [route for route in (device.get("routes") or []) if isinstance(route, Mapping)]
    by_name = {str(route.get("name") or ""): route for route in routes}
    for raw_route in imported_routes or []:
        if not isinstance(raw_route, Mapping):
            continue
        route = deepcopy(dict(raw_route))
        name = str(route.get("name") or "").strip()
        if not name:
            raise ValueError("导入包包含未命名路径")
        existing = by_name.get(name)
        if existing is not None and existing != route:
            raise ValueError(f"路径“{name}”与本地同名路径内容不同，已停止导入")
        if existing is None:
            routes.append(route)
            by_name[name] = route
    device["routes"] = routes


def _merge_exchange_named_assets(
    device: Dict[str, Any],
    field_name: str,
    imported_assets: Any,
    label: str,
) -> None:
    """按名称安全合并设备级资产，同名不同内容时停止导入。"""
    assets = [asset for asset in (device.get(field_name) or []) if isinstance(asset, Mapping)]
    by_name = {str(asset.get("name") or ""): asset for asset in assets}
    for raw_asset in imported_assets or []:
        if not isinstance(raw_asset, Mapping):
            continue
        asset = deepcopy(dict(raw_asset))
        name = str(asset.get("name") or "").strip()
        if not name:
            raise ValueError(f"导入包包含未命名{label}")
        existing = by_name.get(name)
        if existing is not None and existing != asset:
            raise ValueError(f"{label}“{name}”与本地同名内容不同，已停止导入")
        if existing is None:
            assets.append(asset)
            by_name[name] = asset
    device[field_name] = assets


def _append_imported_test(device: Dict[str, Any], raw_test: Mapping[str, Any]) -> Tuple[Dict[str, Any], bool]:
    """安全加入一个测试；相同内容跳过，ID 冲突时创建可读副本。"""
    imported = deepcopy(dict(raw_test))
    imported.pop("schemaVersion", None)
    tests = [test for test in (device.get("tests") or []) if isinstance(test, dict)]
    imported_id = str(imported.get("id") or "").strip() or uuid.uuid4().hex
    existing = next((test for test in tests if str(test.get("id") or "") == imported_id), None)
    if existing is not None:
        comparable_existing = deepcopy(existing)
        comparable_existing.pop("schemaVersion", None)
        if comparable_existing == imported:
            return deepcopy(existing), False
    if existing is not None:
        imported_id = uuid.uuid4().hex
        imported["name"] = _unique_workspace_name(
            str(imported.get("name") or "未命名测试集"),
            (str(test.get("name") or "") for test in tests),
        )
    imported["id"] = imported_id
    imported["updatedAt"] = _workspace_timestamp()
    imported.setdefault("createdAt", imported["updatedAt"])
    tests.append(imported)
    device["tests"] = tests
    return deepcopy(imported), True


def import_workspace_test_archive(
    device_id: str,
    content: bytes,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], bool]:
    """把测试交换包导入指定设备，并严格校验设备拓扑一致。"""
    files = _read_exchange_archive(content)
    manifest = files["manifest.json"]
    if manifest.get("kind") != DATA_EXCHANGE_KIND_TEST:
        raise ValueError("所选文件不是测试集交换包")
    test_case = files.get("test.json")
    routes_payload = files.get("routes.json") or {}
    if not isinstance(test_case, Mapping) or not isinstance(routes_payload, Mapping):
        raise ValueError("测试集交换包内容不完整")
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, dict) and str(item.get("id") or "") == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        fingerprint = _device_fingerprint(device.get("device") or {})
        if fingerprint != str(manifest.get("deviceFingerprint") or ""):
            raise ValueError("测试集所属设备与当前设备不一致，请先切换到相同设备")
        _merge_exchange_routes(device, routes_payload.get("routes"))
        imported, created = _append_imported_test(device, test_case)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return imported, created


def import_workspace_device_archive(
    content: bytes,
    path: Path = WORKSPACE_STORE_PATH,
    progress_callback: Any = None,
) -> Tuple[Dict[str, Any], int, int]:
    """导入完整设备包；相同设备合并路径、组别和测试，不静默覆盖冲突。"""
    _report_transfer_progress(progress_callback, "validating", 5, "正在打开设备包")
    files = _read_exchange_archive(content, progress_callback)
    manifest = files["manifest.json"]
    if manifest.get("kind") != DATA_EXCHANGE_KIND_DEVICE:
        raise ValueError("所选文件不是设备交换包")
    metadata = files.get("metadata.json")
    init_data = files.get("device.json")
    routes_payload = files.get("routes.json") or {}
    groups_payload = files.get("groups.json") or {}
    if not all(isinstance(item, Mapping) for item in (metadata, init_data, routes_payload, groups_payload)):
        raise ValueError("设备交换包内容不完整")
    pure_init_data, packaged_init_options = _split_device_init_data(init_data)
    metadata_init_options = metadata.get("initOptions") or {}
    if not isinstance(metadata_init_options, Mapping):
        raise ValueError("设备交换包的 initOptions 无效")
    init_options = {
        **deepcopy(dict(packaged_init_options)),
        **deepcopy(dict(metadata_init_options)),
    }
    fingerprint = _device_fingerprint(pure_init_data)
    if fingerprint != str(manifest.get("deviceFingerprint") or ""):
        raise ValueError("设备交换包的 init 指纹校验失败")
    imported_tests = [
        value for name, value in files.items()
        if name.startswith("tests/") and name.endswith("/test.json") and isinstance(value, Mapping)
    ]
    if not path.suffix and _workspace_store_is_current(path) and _uses_readable_dataset_layout(path):
        return _import_workspace_device_archive_directory(
            metadata=dict(metadata),
            pure_init_data=pure_init_data,
            init_options=init_options,
            routes_payload=dict(routes_payload),
            groups_payload=dict(groups_payload),
            imported_tests=imported_tests,
            fingerprint=fingerprint,
            path=path,
            progress_callback=progress_callback,
        )
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, dict)
            and _device_fingerprint(item.get("device") or {}) == fingerprint
        ), None)
        created_device = 0
        if device is None:
            if len(catalog["devices"]) >= MAX_WORKSPACE_DEVICE_COUNT:
                raise ValueError(
                    f"设备数量不能超过 {MAX_WORKSPACE_DEVICE_COUNT} 台"
                )
            device = deepcopy(dict(metadata))
            device.pop("schemaVersion", None)
            device.pop("initOptions", None)
            occupied_ids = {str(item.get("id") or "") for item in catalog["devices"] if isinstance(item, Mapping)}
            if not str(device.get("id") or "") or str(device.get("id")) in occupied_ids:
                device["id"] = uuid.uuid4().hex
            device["name"] = _unique_workspace_name(
                str(device.get("name") or "未命名设备"),
                (str(item.get("name") or "") for item in catalog["devices"] if isinstance(item, Mapping)),
            )
            device["device"] = {**deepcopy(pure_init_data), **init_options}
            device["routes"] = []
            device["cleans"] = deepcopy(routes_payload.get("cleans") or [])
            device["routeAliases"] = deepcopy(routes_payload.get("routeAliases") or {})
            device["testGroups"] = deepcopy(groups_payload.get("testGroups") or [])
            device["robotSlots"] = deepcopy(groups_payload.get("robotSlots") or {})
            device["tests"] = []
            catalog["devices"].append(device)
            created_device = 1
        elif init_options:
            local_init, local_options = _split_device_init_data(device.get("device") or {})
            for key, value in init_options.items():
                if key in local_options and local_options[key] != value:
                    raise ValueError(f"设备初始化选项“{key}”与本地定义不同，已停止导入")
                local_options[key] = deepcopy(value)
            device["device"] = {**local_init, **local_options}
        _merge_exchange_routes(device, routes_payload.get("routes"))
        _merge_exchange_named_assets(
            device, "cleans", routes_payload.get("cleans"), "Clean",
        )
        local_aliases = _normalized_route_aliases(device.get("routeAliases"))
        for old_name, new_name in _normalized_route_aliases(
            routes_payload.get("routeAliases")
        ).items():
            if old_name in local_aliases and local_aliases[old_name] != new_name:
                raise ValueError(f"路径别名“{old_name}”与本地定义不同，已停止导入")
            local_aliases[old_name] = new_name
        device["routeAliases"] = local_aliases
        for group in groups_payload.get("testGroups") or []:
            group_name = str(group).strip()
            if group_name and group_name not in device.setdefault("testGroups", []):
                device["testGroups"].append(group_name)
        imported_robot_slots = groups_payload.get("robotSlots")
        if imported_robot_slots:
            local_robot_slots = device.get("robotSlots")
            if local_robot_slots and local_robot_slots != imported_robot_slots:
                raise ValueError("设备包的 Robot 槽位配置与本地不同，已停止导入")
            device["robotSlots"] = deepcopy(imported_robot_slots)
        imported_count = 0
        total_tests = max(1, len(imported_tests))
        for test_index, test_case in enumerate(imported_tests, start=1):
            _, created = _append_imported_test(device, test_case)
            imported_count += int(created)
            _report_transfer_progress(
                progress_callback,
                "saving",
                60 + round(test_index / total_tests * 35),
                f"正在保存测试集 {test_index}/{len(imported_tests)}",
            )
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(device), created_device, imported_count


def _import_workspace_device_archive_directory(
    *,
    metadata: Dict[str, Any],
    pure_init_data: Dict[str, Any],
    init_options: Dict[str, Any],
    routes_payload: Dict[str, Any],
    groups_payload: Dict[str, Any],
    imported_tests: Sequence[Mapping[str, Any]],
    fingerprint: str,
    path: Path,
    progress_callback: Any = None,
) -> Tuple[Dict[str, Any], int, int]:
    """在当前目录格式中只读写目标设备，避免导入时扫描并比较全部测试。"""
    with _workspace_catalog_guard(path):
        device_metadata_rows: List[Tuple[Path, Dict[str, Any]]] = []
        for device_dir in sorted(path.iterdir()):
            if not device_dir.is_dir():
                continue
            try:
                local_metadata = json.loads(
                    (device_dir / "metadata.json").read_text(encoding="utf-8")
                )
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(local_metadata, dict):
                device_metadata_rows.append((device_dir, local_metadata))
        matched_row = next((
            row for row in device_metadata_rows
            if str(row[1].get("fingerprint") or "") == fingerprint
        ), None)
        created_device = int(matched_row is None)
        if matched_row is None:
            if len(device_metadata_rows) >= MAX_WORKSPACE_DEVICE_COUNT:
                raise ValueError(f"设备数量不能超过 {MAX_WORKSPACE_DEVICE_COUNT} 台")
            device = deepcopy(metadata)
            device.pop("schemaVersion", None)
            device.pop("initOptions", None)
            occupied_ids = {str(row[1].get("id") or "") for row in device_metadata_rows}
            if not str(device.get("id") or "") or str(device.get("id")) in occupied_ids:
                device["id"] = uuid.uuid4().hex
            device["name"] = _unique_workspace_name(
                str(device.get("name") or "未命名设备"),
                (str(row[1].get("name") or "") for row in device_metadata_rows),
            )
            device["fingerprint"] = fingerprint
            device["device"] = {**deepcopy(pure_init_data), **deepcopy(init_options)}
            device["routes"] = []
            device["cleans"] = deepcopy(routes_payload.get("cleans") or [])
            device["routeAliases"] = deepcopy(routes_payload.get("routeAliases") or {})
            device["testGroups"] = deepcopy(groups_payload.get("testGroups") or [])
            device["robotSlots"] = deepcopy(groups_payload.get("robotSlots") or {})
            device["tests"] = []
            _merge_exchange_routes(device, routes_payload.get("routes"))
            total_tests = max(1, len(imported_tests))
            imported_count = 0
            for test_index, test_case in enumerate(imported_tests, start=1):
                _, created = _append_imported_test(device, test_case)
                imported_count += int(created)
                _report_transfer_progress(
                    progress_callback,
                    "saving",
                    60 + round(test_index / total_tests * 35),
                    f"正在保存测试集 {test_index}/{len(imported_tests)}",
                )
            device["updatedAt"] = _workspace_timestamp()
            device_dir = _dataset_device_directory(path, device)
            tests_dir = device_dir / "tests"
            tests_dir.mkdir(parents=True, exist_ok=True)
            pure_device_init, device_init_options = _split_device_init_data(
                device.get("device") or {}
            )
            metadata_payload = _exchange_metadata(device)
            metadata_payload["fingerprint"] = fingerprint
            if device_init_options:
                metadata_payload["initOptions"] = device_init_options
            _write_json_atomic(device_dir / "metadata.json", metadata_payload)
            _write_json_atomic(device_dir / "device.json", pure_device_init)
            _write_json_atomic(device_dir / "routes.json", _exchange_routes(device))
            groups_result = {
                "schemaVersion": WORKSPACE_STORE_VERSION,
                "testGroups": deepcopy(device.get("testGroups") or []),
                "robotSlots": deepcopy(device.get("robotSlots") or {}),
            }
            _write_json_atomic(device_dir / "groups.json", groups_result)
            summaries = []
            for raw_test in device.get("tests") or []:
                if not isinstance(raw_test, Mapping):
                    continue
                test_case = deepcopy(dict(raw_test))
                test_case["schemaVersion"] = WORKSPACE_STORE_VERSION
                _write_json_atomic(
                    _dataset_test_directory(tests_dir, test_case) / "test.json",
                    test_case,
                )
                summaries.append(_workspace_test_summary(test_case))
            _write_json_atomic(_workspace_test_index_path(tests_dir), summaries)
            _write_workspace_store_version(path)
            return deepcopy(device), 1, imported_count

        device_dir, local_metadata = matched_row
        device_id = str(local_metadata.get("id") or "")
        device = _fast_workspace_device_overview_unlocked(device_id, path)
        if device is None:
            raise ValueError(f"设备目录不完整：{device_id}")
        if init_options:
            local_init, local_options = _split_device_init_data(device.get("device") or {})
            for key, value in init_options.items():
                if key in local_options and local_options[key] != value:
                    raise ValueError(f"设备初始化选项“{key}”与本地定义不同，已停止导入")
                local_options[key] = deepcopy(value)
            device["device"] = {**local_init, **local_options}
        _merge_exchange_routes(device, routes_payload.get("routes"))
        _merge_exchange_named_assets(device, "cleans", routes_payload.get("cleans"), "Clean")
        local_aliases = _normalized_route_aliases(device.get("routeAliases"))
        for old_name, new_name in _normalized_route_aliases(
            routes_payload.get("routeAliases")
        ).items():
            if old_name in local_aliases and local_aliases[old_name] != new_name:
                raise ValueError(f"路径别名“{old_name}”与本地定义不同，已停止导入")
            local_aliases[old_name] = new_name
        device["routeAliases"] = local_aliases
        for group in groups_payload.get("testGroups") or []:
            group_name = str(group).strip()
            if group_name and group_name not in device.setdefault("testGroups", []):
                device["testGroups"].append(group_name)
        imported_robot_slots = groups_payload.get("robotSlots")
        if imported_robot_slots:
            local_robot_slots = device.get("robotSlots")
            if local_robot_slots and local_robot_slots != imported_robot_slots:
                raise ValueError("设备包的 Robot 槽位配置与本地不同，已停止导入")
            device["robotSlots"] = deepcopy(imported_robot_slots)

        tests_dir = device_dir / "tests"
        summaries = [
            _workspace_test_summary(summary)
            for summary in device.get("tests") or []
            if isinstance(summary, Mapping)
        ]
        occupied_names = [str(summary.get("name") or "") for summary in summaries]
        imported_count = 0
        total_tests = max(1, len(imported_tests))
        for test_index, raw_test in enumerate(imported_tests, start=1):
            imported = deepcopy(dict(raw_test))
            imported.pop("schemaVersion", None)
            imported_id = str(imported.get("id") or "").strip() or uuid.uuid4().hex
            existing_file = _find_dataset_test_file(device_dir, imported_id)
            if existing_file is not None:
                try:
                    existing = json.loads(existing_file.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as error:
                    raise ValueError(f"本地测试集文件无效：{imported_id}") from error
                comparable_existing = deepcopy(existing)
                comparable_existing.pop("schemaVersion", None)
                if comparable_existing == imported:
                    _report_transfer_progress(
                        progress_callback,
                        "saving",
                        60 + round(test_index / total_tests * 35),
                        f"正在合并测试集 {test_index}/{len(imported_tests)}",
                    )
                    continue
                imported_id = uuid.uuid4().hex
                imported["name"] = _unique_workspace_name(
                    str(imported.get("name") or "未命名测试集"), occupied_names,
                )
            imported["id"] = imported_id
            imported["updatedAt"] = _workspace_timestamp()
            imported.setdefault("createdAt", imported["updatedAt"])
            imported["schemaVersion"] = WORKSPACE_STORE_VERSION
            target_file = _dataset_test_directory(tests_dir, imported) / "test.json"
            _write_json_atomic(target_file, imported)
            summary = _workspace_test_summary(imported)
            summaries.append(summary)
            occupied_names.append(str(summary.get("name") or ""))
            imported_count += 1
            _report_transfer_progress(
                progress_callback,
                "saving",
                60 + round(test_index / total_tests * 35),
                f"正在保存测试集 {test_index}/{len(imported_tests)}",
            )

        device["updatedAt"] = _workspace_timestamp()
        pure_local_init, local_init_options = _split_device_init_data(device.get("device") or {})
        metadata_payload = _exchange_metadata(device)
        metadata_payload["fingerprint"] = fingerprint
        if local_init_options:
            metadata_payload["initOptions"] = local_init_options
        _write_json_if_changed(device_dir / "metadata.json", metadata_payload)
        _write_json_if_changed(device_dir / "device.json", pure_local_init)
        _write_json_if_changed(device_dir / "routes.json", _exchange_routes(device))
        groups_result = {
            "schemaVersion": WORKSPACE_STORE_VERSION,
            "testGroups": deepcopy(device.get("testGroups") or []),
        }
        if "robotSlots" in device:
            groups_result["robotSlots"] = deepcopy(device.get("robotSlots") or {})
        _write_json_if_changed(device_dir / "groups.json", groups_result)
        _write_json_if_changed(_workspace_test_index_path(tests_dir), summaries)
        device["tests"] = summaries
        return deepcopy(device), created_device, imported_count



__all__ = tuple(name for name in globals() if not name.startswith('__'))
