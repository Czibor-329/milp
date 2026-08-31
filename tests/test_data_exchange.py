"""验证 v6 单源数据目录和设备/测试集交换包。"""

from __future__ import annotations

import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from realtime_scheduler.backend import application as server


def _device(station_name: str = "LP1") -> dict:
    """创建足以通过工作区归一化的最小设备 init。"""
    return {
        "Robots": {
            "R1": {
                "Name": "R1",
                "Type": "ATMRobot",
                "Capacity": 1,
                "ArmInfo": {"ArmA": {"SlotIDs": [1]}},
            },
        },
        "Stations": {
            station_name: {
                "Name": station_name,
                "Type": "LoadPort",
                "Capacity": 1,
                "Slots": [1],
            },
        },
    }


def _create_store(store_dir: Path, data_dir: Path) -> tuple[dict, dict]:
    """建立一台设备及一个测试集，并返回两者。"""
    with (
        patch.object(server, "WORKSPACE_STORE_PATH", store_dir),
        patch.object(server, "DATA_DIR", data_dir),
    ):
        device, _ = server.import_workspace_device("PSE300.json", _device(), store_dir)
        test = server.create_workspace_test(device["id"], {"name": "基础测试"}, store_dir)
    return device, test


def test_v6_layout_keeps_single_pure_device_init() -> None:
    """默认 v6 目录用 UUID 寻址，device.json 不再嵌入路径和测试。"""
    with tempfile.TemporaryDirectory() as directory:
        data_dir = Path(directory) / "data"
        store_dir = data_dir / "datasets"
        device, test = _create_store(store_dir, data_dir)

        device_dir = store_dir / device["id"]
        test_dir = device_dir / "tests" / test["id"]
        assert (store_dir / "manifest.json").is_file()
        assert (device_dir / "metadata.json").is_file()
        assert (device_dir / "device.json").is_file()
        assert (device_dir / "routes.json").is_file()
        assert (device_dir / "groups.json").is_file()
        assert (test_dir / "test.json").is_file()
        init_data = server.json.loads((device_dir / "device.json").read_text(encoding="utf-8"))
        assert set(init_data) == {"Robots", "Stations"}


def test_v6_layout_moves_legacy_init_options_out_of_device_json() -> None:
    """兼容旧 init 扩展字段，但磁盘上的 device.json 始终保持纯净。"""
    with tempfile.TemporaryDirectory() as directory:
        data_dir = Path(directory) / "data"
        store_dir = data_dir / "datasets"
        source = _device()
        source["InitialMoveID"] = 7
        with (
            patch.object(server, "WORKSPACE_STORE_PATH", store_dir),
            patch.object(server, "DATA_DIR", data_dir),
        ):
            device, _ = server.import_workspace_device("PSE300.json", source, store_dir)

        device_dir = store_dir / device["id"]
        init_data = server.json.loads((device_dir / "device.json").read_text(encoding="utf-8"))
        metadata = server.json.loads((device_dir / "metadata.json").read_text(encoding="utf-8"))
        restored = server.get_workspace_device(device["id"], store_dir)

        assert set(init_data) == {"Robots", "Stations"}
        assert metadata["initOptions"] == {"InitialMoveID": 7}
        assert restored["device"]["InitialMoveID"] == 7


def test_device_archive_round_trip_includes_all_tests() -> None:
    """设备包可在另一份数据目录中还原设备和全部测试。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source.json"
        target = root / "target.json"
        init_data = _device()
        init_data["InitialMoveID"] = 7
        device, _ = server.import_workspace_device("PSE300.json", init_data, source)
        server.create_workspace_test(device["id"], {"name": "基础测试"}, source)
        content, filename = server.export_workspace_device(device["id"], source)
        files = server._read_exchange_archive(content)

        imported, created_device, imported_tests = server.import_workspace_device_archive(content, target)

        assert set(files["device.json"]) == {"Robots", "Stations"}
        assert files["metadata.json"]["initOptions"] == {"InitialMoveID": 7}
        assert filename.endswith(".zip")
        assert created_device == 1
        assert imported_tests == 1
        assert imported["name"] == "PSE300.json"
        assert imported["device"]["InitialMoveID"] == 7
        assert [test["name"] for test in imported["tests"]] == ["基础测试"]


def test_exchange_archive_has_separate_upload_and_uncompressed_limits() -> None:
    """高压缩率合法包可超过上传上限，解压总量仍受独立上限保护。"""
    content = server._zip_json_bytes({
        "manifest.json": {
            "kind": server.DATA_EXCHANGE_KIND_DEVICE,
            "schemaVersion": server.WORKSPACE_STORE_VERSION,
        },
        "payload.json": {"value": "x" * 2048},
    })

    assert server.DATA_EXCHANGE_MAX_ARCHIVE_BYTES == 64 * 1024 * 1024
    assert server.DATA_EXCHANGE_MAX_UNCOMPRESSED_BYTES == 512 * 1024 * 1024
    with patch.object(server, "DATA_EXCHANGE_MAX_UNCOMPRESSED_BYTES", 4096):
        assert server._read_exchange_archive(content)["payload.json"]["value"] == "x" * 2048
    with (
        patch.object(server, "DATA_EXCHANGE_MAX_UNCOMPRESSED_BYTES", 1024),
        pytest.raises(ValueError, match="解压后超过 512 MiB 限制"),
    ):
        server._read_exchange_archive(content)


def test_test_archive_requires_matching_device() -> None:
    """测试集包只能导入 init 指纹完全相同的设备。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source.json"
        matching = root / "matching.json"
        mismatch = root / "mismatch.json"
        source_device, test = _create_store(source, root / "source-data")
        content, _ = server.export_workspace_test(source_device["id"], test["id"], source)

        matching_device, _ = server.import_workspace_device("same.json", _device(), matching)
        imported, created = server.import_workspace_test_archive(matching_device["id"], content, matching)
        assert created is True
        assert imported["name"] == "基础测试"

        mismatch_device, _ = server.import_workspace_device("other.json", _device("LP2"), mismatch)
        with pytest.raises(ValueError, match="当前设备不一致"):
            server.import_workspace_test_archive(mismatch_device["id"], content, mismatch)


def test_completed_v6_store_archives_leftover_v5_directory() -> None:
    """迁移已写完但备份移动中断时，下次读取只归档旧目录而不覆盖 v6。"""
    with tempfile.TemporaryDirectory() as directory:
        data_dir = Path(directory) / "data"
        store_dir = data_dir / "datasets"
        legacy_dir = data_dir / "workspaces"
        device, _ = _create_store(store_dir, data_dir)
        legacy_catalog = {
            "version": 5,
            "devices": [{**device, "tests": []}],
        }
        server._write_legacy_workspace_catalog_directory(legacy_dir, legacy_catalog)

        with (
            patch.object(server, "WORKSPACE_STORE_PATH", store_dir),
            patch.object(server, "DATA_DIR", data_dir),
        ):
            loaded = server._read_workspace_catalog_unlocked(store_dir)

        assert len(loaded["devices"]) == 1
        assert not legacy_dir.exists()
        assert list((data_dir / "migration-backups").glob("workspaces-v5-*"))


def test_current_directory_device_export_skips_full_catalog_read() -> None:
    """当前目录导出直接压缩目标设备文件，不回退到全目录解析。"""
    with tempfile.TemporaryDirectory() as directory:
        store_dir = Path(directory) / "datasets"
        server._write_json_atomic(store_dir / "manifest.json", {
            "kind": "ct-scheduler-datasets",
            "schemaVersion": server.WORKSPACE_STORE_VERSION,
        })
        device, _ = server.import_workspace_device("PSE300.json", _device(), store_dir)
        server.create_workspace_test(device["id"], {"name": "基础测试"}, store_dir)

        with patch.object(
            server,
            "get_workspace_device",
            side_effect=AssertionError("不应读取完整目录"),
        ):
            content, _ = server.export_workspace_device(device["id"], store_dir)

        files = server._read_exchange_archive(content)
        assert files["manifest.json"]["deviceId"] == device["id"]
        assert len([name for name in files if name.endswith("/test.json")]) == 1


def test_current_directory_device_import_only_updates_target_device() -> None:
    """当前目录导入使用定向写入，不读取并重写其他设备的完整测试。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source.json"
        target = root / "datasets"
        source_device, _ = server.import_workspace_device("source.json", _device("LP2"), source)
        server.create_workspace_test(source_device["id"], {"name": "导入测试"}, source)
        content, _ = server.export_workspace_device(source_device["id"], source)

        server._write_json_atomic(target / "manifest.json", {
            "kind": "ct-scheduler-datasets",
            "schemaVersion": server.WORKSPACE_STORE_VERSION,
        })
        local_device, _ = server.import_workspace_device("local.json", _device(), target)
        local_test = server.create_workspace_test(local_device["id"], {"name": "本地测试"}, target)
        with patch.object(
            server,
            "_read_workspace_catalog_unlocked",
            side_effect=AssertionError("不应读取完整目录"),
        ):
            imported, created_device, imported_tests = server.import_workspace_device_archive(
                content, target,
            )

        assert created_device == 1
        assert imported_tests == 1
        assert server.get_workspace_test(local_device["id"], local_test["id"], target)["name"] == "本地测试"


def test_current_directory_device_import_merges_matching_device_directly() -> None:
    """相同指纹设备只合并新增测试，并保留目标设备原有测试文件。"""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source.json"
        target = root / "datasets"
        source_device, _ = server.import_workspace_device("source.json", _device(), source)
        source_test = server.create_workspace_test(
            source_device["id"], {"name": "导入测试"}, source,
        )
        content, _ = server.export_workspace_device(source_device["id"], source)

        server._write_json_atomic(target / "manifest.json", {
            "kind": "ct-scheduler-datasets",
            "schemaVersion": server.WORKSPACE_STORE_VERSION,
        })
        local_device, _ = server.import_workspace_device("local.json", _device(), target)
        local_test = server.create_workspace_test(
            local_device["id"], {"name": "本地测试"}, target,
        )

        imported, created_device, imported_tests = server.import_workspace_device_archive(
            content, target,
        )

        assert created_device == 0
        assert imported_tests == 1
        assert {test["id"] for test in imported["tests"]} == {
            local_test["id"], source_test["id"],
        }
        assert server.get_workspace_test(
            local_device["id"], local_test["id"], target,
        )["name"] == "本地测试"


def test_workspace_transfer_reports_progress_and_download() -> None:
    """后台导出任务可轮询至完成，并保留可下载归档。"""
    archive = b"PK-test"
    with patch.object(
        server,
        "export_workspace_device",
        return_value=(archive, "device.zip"),
    ):
        transfer = server.create_workspace_transfer("export", "device", "device-id")
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            snapshot = server.read_workspace_transfer(transfer["id"])
            if snapshot and snapshot["status"] in {"completed", "failed"}:
                break
            time.sleep(0.01)

    assert snapshot is not None
    assert snapshot["status"] == "completed"
    assert snapshot["progress"] == 100
    assert server.download_workspace_transfer(transfer["id"]) == (archive, "device.zip")


def test_workspace_import_transfer_finishes_with_result() -> None:
    """后台导入任务在上传后返回设备摘要，供前端完成刷新。"""
    imported_device = {"id": "device-id", "name": "设备", "tests": [{"id": "test-id"}]}
    with patch.object(
        server,
        "import_workspace_device_archive",
        return_value=(imported_device, 1, 1),
    ):
        transfer = server.create_workspace_transfer("import", "device")
        uploaded = server.upload_workspace_transfer(transfer["id"], b"archive")
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            snapshot = server.read_workspace_transfer(transfer["id"])
            if snapshot and snapshot["status"] in {"completed", "failed"}:
                break
            time.sleep(0.01)

    assert uploaded["progress"] == 20
    assert snapshot is not None
    assert snapshot["status"] == "completed"
    assert snapshot["result"]["device"]["id"] == "device-id"
    assert snapshot["result"]["importedTests"] == 1
