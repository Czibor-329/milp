"""工作区导入导出后台任务的状态、进度和制品下载服务。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.time_utils import _workspace_timestamp
from realtime_scheduler.backend.workspace.exchange_service import (
    export_workspace_device,
    export_workspace_test,
    import_workspace_device_archive,
    import_workspace_test_archive,
)

TRANSFER_JOB_LIMIT = 16

_WORKSPACE_TRANSFER_LOCK = threading.RLock()
_WORKSPACE_TRANSFERS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()


def _workspace_transfer_snapshot(transfer: Mapping[str, Any]) -> Dict[str, Any]:
    """返回可发送给浏览器的交换任务状态，隐藏归档二进制内容。"""
    snapshot = {
        key: deepcopy(value)
        for key, value in transfer.items()
        if key not in {"content", "downloadName"}
    }
    return snapshot


def _update_workspace_transfer(
    transfer_id: str,
    *,
    status: Optional[str] = None,
    phase: Optional[str] = None,
    progress: Optional[int] = None,
    message: Optional[str] = None,
    result: Any = None,
    content: Optional[bytes] = None,
    download_name: Optional[str] = None,
) -> None:
    """在线程安全边界内更新一次交换任务。"""
    with _WORKSPACE_TRANSFER_LOCK:
        transfer = _WORKSPACE_TRANSFERS.get(transfer_id)
        if transfer is None:
            return
        if status is not None:
            transfer["status"] = status
        if phase is not None:
            transfer["phase"] = phase
        if progress is not None:
            transfer["progress"] = max(0, min(100, int(progress)))
        if message is not None:
            transfer["message"] = message
        if result is not None:
            transfer["result"] = deepcopy(result)
        if content is not None:
            transfer["content"] = content
        if download_name is not None:
            transfer["downloadName"] = download_name
        transfer["updatedAt"] = _workspace_timestamp()


def create_workspace_transfer(
    direction: str,
    kind: str,
    device_id: str = "",
    test_id: str = "",
) -> Dict[str, Any]:
    """创建导入或导出后台任务；导出立即运行，导入等待上传归档。"""
    if direction not in {"import", "export"}:
        raise ValueError("交换方向必须是 import 或 export")
    if kind not in {"device", "test"}:
        raise ValueError("交换类型必须是 device 或 test")
    if direction == "export" and not device_id:
        raise ValueError("导出前必须选择设备")
    if kind == "test" and not device_id:
        raise ValueError("测试集交换前必须选择设备")
    if direction == "export" and kind == "test" and not test_id:
        raise ValueError("导出前必须选择测试集")
    transfer_id = uuid.uuid4().hex
    now = _workspace_timestamp()
    transfer = {
        "id": transfer_id,
        "direction": direction,
        "kind": kind,
        "deviceId": device_id,
        "testId": test_id,
        "status": "queued",
        "phase": "waiting-upload" if direction == "import" else "queued",
        "progress": 0,
        "message": "等待上传交换包" if direction == "import" else "等待开始导出",
        "createdAt": now,
        "updatedAt": now,
    }
    with _WORKSPACE_TRANSFER_LOCK:
        _WORKSPACE_TRANSFERS[transfer_id] = transfer
        while len(_WORKSPACE_TRANSFERS) > TRANSFER_JOB_LIMIT:
            _WORKSPACE_TRANSFERS.popitem(last=False)
    if direction == "export":
        threading.Thread(
            target=_run_workspace_export_transfer,
            args=(transfer_id,),
            name=f"workspace-export-{transfer_id[:8]}",
            daemon=True,
        ).start()
    return _workspace_transfer_snapshot(transfer)


def _run_workspace_export_transfer(transfer_id: str) -> None:
    """在后台读取并压缩指定设备或测试集，供状态接口轮询。"""
    with _WORKSPACE_TRANSFER_LOCK:
        transfer = deepcopy(_WORKSPACE_TRANSFERS.get(transfer_id))
    if transfer is None:
        return

    def report(phase: str, progress: int, message: str) -> None:
        """把导出服务阶段写入任务状态。"""
        _update_workspace_transfer(
            transfer_id,
            status="running",
            phase=phase,
            progress=progress,
            message=message,
        )

    try:
        report("reading", 2, "正在读取导出数据")
        if transfer["kind"] == "device":
            content, download_name = export_workspace_device(
                str(transfer["deviceId"]), progress_callback=report,
            )
        else:
            content, download_name = export_workspace_test(
                str(transfer["deviceId"]), str(transfer["testId"]),
            )
        _update_workspace_transfer(
            transfer_id,
            status="completed",
            phase="completed",
            progress=100,
            message="交换包已准备完成",
            content=content,
            download_name=download_name,
        )
    except Exception as error:  # noqa: BLE001
        _update_workspace_transfer(
            transfer_id,
            status="failed",
            phase="failed",
            message=str(error),
        )


def upload_workspace_transfer(transfer_id: str, content: bytes) -> Dict[str, Any]:
    """接收导入归档并启动后台校验与写入。"""
    with _WORKSPACE_TRANSFER_LOCK:
        transfer = _WORKSPACE_TRANSFERS.get(transfer_id)
        if transfer is None:
            raise ValueError("交换任务不存在或已过期")
        if transfer.get("direction") != "import":
            raise ValueError("导出任务不能上传内容")
        if transfer.get("status") != "queued":
            raise ValueError("交换任务已开始或已结束")
        transfer["status"] = "running"
        transfer["phase"] = "uploaded"
        transfer["progress"] = 20
        transfer["message"] = "上传完成，正在校验交换包"
        snapshot = _workspace_transfer_snapshot(transfer)
    threading.Thread(
        target=_run_workspace_import_transfer,
        args=(transfer_id, content),
        name=f"workspace-import-{transfer_id[:8]}",
        daemon=True,
    ).start()
    return snapshot


def _run_workspace_import_transfer(transfer_id: str, content: bytes) -> None:
    """在后台校验并导入上传的设备或测试集交换包。"""
    with _WORKSPACE_TRANSFER_LOCK:
        transfer = deepcopy(_WORKSPACE_TRANSFERS.get(transfer_id))
    if transfer is None:
        return

    def report(phase: str, progress: int, message: str) -> None:
        """把服务内部进度映射到上传后的 20% 至 100%。"""
        mapped_progress = 20 + round(max(0, min(100, progress)) * 0.79)
        _update_workspace_transfer(
            transfer_id,
            status="running",
            phase=phase,
            progress=mapped_progress,
            message=message,
        )

    try:
        if transfer["kind"] == "device":
            device, created_device, imported_tests = import_workspace_device_archive(
                content, progress_callback=report,
            )
            result = {
                "device": {
                    "id": device["id"],
                    "name": device.get("name") or "未命名设备",
                    "testCount": len(device.get("tests") or []),
                },
                "createdDevice": bool(created_device),
                "importedTests": imported_tests,
            }
        else:
            test_case, created = import_workspace_test_archive(
                str(transfer["deviceId"]), content,
            )
            result = {"created": created, "test": test_case}
        _update_workspace_transfer(
            transfer_id,
            status="completed",
            phase="completed",
            progress=100,
            message="导入完成",
            result=result,
        )
    except Exception as error:  # noqa: BLE001
        _update_workspace_transfer(
            transfer_id,
            status="failed",
            phase="failed",
            message=str(error),
        )


def read_workspace_transfer(transfer_id: str) -> Optional[Dict[str, Any]]:
    """读取一个交换任务快照；任务不存在或已淘汰时返回 ``None``。"""
    with _WORKSPACE_TRANSFER_LOCK:
        transfer = _WORKSPACE_TRANSFERS.get(transfer_id)
        return None if transfer is None else _workspace_transfer_snapshot(transfer)


def download_workspace_transfer(transfer_id: str) -> Tuple[bytes, str]:
    """读取已完成导出任务的归档内容与下载文件名。"""
    with _WORKSPACE_TRANSFER_LOCK:
        transfer = _WORKSPACE_TRANSFERS.get(transfer_id)
        if transfer is None:
            raise LookupError("交换任务不存在或已过期")
        if transfer.get("direction") != "export":
            raise ValueError("导入任务没有可下载内容")
        if transfer.get("status") != "completed" or not isinstance(transfer.get("content"), bytes):
            raise ValueError("交换包尚未准备完成")
        return transfer["content"], str(transfer.get("downloadName") or "ct-data.zip")




__all__ = tuple(name for name in globals() if not name.startswith('__'))
