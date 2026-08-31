"""调度结果、复现日志、Baseline 与批量服务装配。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.time_utils import _workspace_timestamp
from realtime_scheduler.backend.execution.run_state import *
from realtime_scheduler.backend.execution.service import execute_plan
from realtime_scheduler.backend.workspace.repository import *
from realtime_scheduler.backend.workspace.service import *

def save_result(output: Dict[str, Any]) -> str:
    """把甘特图数据写入专用导出目录并放入有界内存缓存。"""
    result_id = uuid.uuid4().hex
    with _EXPORTS_LOCK:
        _write_json_atomic(RESULT_EXPORT_DIR / f"{result_id}.json", output)
        with _RESULTS_LOCK:
            _RESULTS[result_id] = output
            _RESULTS.move_to_end(result_id)
            while len(_RESULTS) > MAX_SAVED_RESULTS:
                _RESULTS.popitem(last=False)
    return result_id


def read_result(result_id: str) -> Optional[Dict[str, Any]]:
    """读取一次运行的甘特图数据；服务重启后可从磁盘恢复。"""
    with _RESULTS_LOCK:
        value = _RESULTS.get(result_id)
        if value is not None:
            return deepcopy(value)
    if len(result_id) == 32 and all(char in "0123456789abcdef" for char in result_id.lower()):
        path = RESULT_EXPORT_DIR / f"{result_id}.json"
        if path.is_file():
            value = json.loads(path.read_text(encoding="utf-8"))
            return deepcopy(value) if isinstance(value, Mapping) else None
    return None


def save_reproduction_log(entries: Sequence[Mapping[str, Any]]) -> str:
    """把 input_data 格式日志写入专用导出目录并放入有界内存缓存。"""
    log_id = uuid.uuid4().hex
    payload = deepcopy(list(entries))
    with _EXPORTS_LOCK:
        _write_text_atomic(LOG_EXPORT_DIR / f"{log_id}.json", format_reproduction_log(payload))
        with _REPRODUCTION_LOGS_LOCK:
            _REPRODUCTION_LOGS[log_id] = payload
            _REPRODUCTION_LOGS.move_to_end(log_id)
            while len(_REPRODUCTION_LOGS) > MAX_SAVED_RESULTS:
                _REPRODUCTION_LOGS.popitem(last=False)
    return log_id


def read_reproduction_log(log_id: str) -> Optional[List[Dict[str, Any]]]:
    """读取一次运行的可复现日志；服务重启后可从磁盘恢复。"""
    with _REPRODUCTION_LOGS_LOCK:
        value = _REPRODUCTION_LOGS.get(log_id)
        if value is not None:
            return deepcopy(value)
    if len(log_id) == 32 and all(char in "0123456789abcdef" for char in log_id.lower()):
        path = LOG_EXPORT_DIR / f"{log_id}.json"
        if path.is_file():
            value = json.loads(path.read_text(encoding="utf-8"))
            return deepcopy(value) if isinstance(value, list) else None
    return None


def build_workspace_batch_log_archive(batch_id: str) -> Tuple[bytes, str]:
    """打包一个批量任务中已生成的测试复现日志。

    参数 ``batch_id`` 为批量任务 ID。返回 ZIP 二进制内容及推荐下载文件名；每条
    日志采用与单条日志下载相同的逐行 JSON 格式，压缩包中的 ``manifest.json``
    记录测试集、运行状态及对应文件名。批量任务不存在或尚未生成任何日志时抛出异常。
    """
    # 装配模块依赖本制品仓库，因此在调用期读取批量状态，避免模块初始化环。
    from realtime_scheduler.backend.wiring import read_workspace_batch_run

    batch = read_workspace_batch_run(batch_id)
    if batch is None:
        raise LookupError("批量任务不存在或已过期")

    manifest_items: List[Dict[str, Any]] = []
    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w", compression=ZIP_DEFLATED) as archive:
        for item in sorted(batch.get("items") or [], key=lambda value: int(value.get("index", 0))):
            if not isinstance(item, Mapping):
                continue
            log_url = str(item.get("logUrl") or "")
            log_id = log_url.rsplit("/", 1)[-1]
            reproduction_log = read_reproduction_log(log_id) if log_id else None
            manifest_item = {
                "index": int(item.get("index", 0)) + 1,
                "testId": str(item.get("testId") or ""),
                "testName": str(item.get("testName") or ""),
                "status": str(item.get("status") or "queued"),
                "logFile": "",
            }
            if reproduction_log is not None:
                safe_name = re.sub(
                    r'[\\/:*?"<>|\x00-\x1f]+', "_", manifest_item["testName"],
                ).strip(" ._") or f"测试{manifest_item['index']}"
                log_file = f"t{manifest_item['index']:02d}_{safe_name}.json"
                archive.writestr(log_file, format_reproduction_log(reproduction_log))
                manifest_item["logFile"] = log_file
            manifest_items.append(manifest_item)

        exported_count = sum(bool(item["logFile"]) for item in manifest_items)
        if not exported_count:
            raise ValueError("本批次尚无可导出的复现日志")
        archive.writestr(
            "manifest.json",
            json.dumps({
                "batchId": batch_id,
                "deviceName": str(batch.get("deviceName") or ""),
                "group": str(batch.get("group") or ""),
                "strategy": str(batch.get("strategy") or ""),
                "exportedLogCount": exported_count,
                "items": manifest_items,
            }, ensure_ascii=False, indent=2),
        )
    return archive_buffer.getvalue(), f"ct-batch-logs-{batch_id[:8]}.zip"


def clear_exported_artifacts() -> Dict[str, int]:
    """删除全部已导出的结果和复现日志，并同步清空内存缓存。

    返回值包含结果和日志各自删除的 JSON 文件数量。该操作只处理两个专用导出
    目录顶层的 JSON 文件，不会影响设备、测试集或其他运行数据。
    """
    deleted_counts = {"results": 0, "logs": 0}
    with _EXPORTS_LOCK:
        for name, directory in (("results", RESULT_EXPORT_DIR), ("logs", LOG_EXPORT_DIR)):
            if not directory.is_dir():
                continue
            for path in directory.glob("*.json"):
                if path.is_file():
                    path.unlink()
                    deleted_counts[name] += 1
        with _RESULTS_LOCK:
            _RESULTS.clear()
        with _REPRODUCTION_LOGS_LOCK:
            _REPRODUCTION_LOGS.clear()
    return deleted_counts


def _persist_workspace_baseline(
    device_id: str,
    test_id: str,
    baseline: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> bool:
    """保存某个测试的 Baseline；测试夹具不存在于目录时返回 False。"""
    with _workspace_catalog_guard(path):
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            return False
        test_case = next((item for item in (device.get("tests") or []) if item.get("id") == test_id), None)
        if test_case is None:
            return False
        test_case["baseline"] = deepcopy(dict(baseline))
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return True




__all__ = tuple(name for name in globals() if not name.startswith('__'))
