"""生成 v7 性能测试数据目录。

本模块只为测试和基准运行创建确定性数据，不参与生产数据读写。生成结果遵循
``data/datasets`` 的 v7 布局，并用固定名称和内容保证相同配置产生相同哈希。
设备数量受平台性能标准约束，任何夹具都不得超过十台设备。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


PERFORMANCE_PROFILE_SCHEMA_VERSION = 1
DATASET_SCHEMA_VERSION = 7
MAXIMUM_DEVICE_COUNT = 10


def _write_json(path: Path, payload: Any) -> None:
    """以稳定格式写入一个性能夹具 JSON 文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2),
        encoding="utf-8",
    )


def load_performance_profiles(path: Path) -> Mapping[str, Any]:
    """读取并校验性能规模配置。

    Args:
        path: ``performance/profiles.json`` 路径。

    Returns:
        已校验的完整配置对象。

    Raises:
        ValueError: 配置版本或任一场景的设备数量不符合标准。
    """
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != PERFORMANCE_PROFILE_SCHEMA_VERSION:
        raise ValueError("不支持的性能规模配置版本")
    configured_maximum = int(payload.get("maximumDeviceCount") or 0)
    if configured_maximum != MAXIMUM_DEVICE_COUNT:
        raise ValueError("性能规模配置的设备上限必须为 10")
    for name, profile in (payload.get("profiles") or {}).items():
        device_count = int(profile.get("deviceCount") or 0)
        if not 1 <= device_count <= MAXIMUM_DEVICE_COUNT:
            raise ValueError(f"性能场景 {name} 的设备数量必须为 1~10")
    return payload


def generate_v7_dataset(
    destination: Path,
    *,
    device_count: int,
    tests_per_device: int,
    payload_bytes_per_test: int,
    round_count: int,
) -> dict[str, Any]:
    """生成一份确定性的 v7 数据集并返回规模摘要。

    Args:
        destination: 新数据集根目录，调用前应为空或不存在。
        device_count: 设备数量，硬限制为 1~10。
        tests_per_device: 每台设备的测试数量。
        payload_bytes_per_test: 每个测试在 ``options`` 中携带的填充字节数。
        round_count: 每个测试的重算轮次数。

    Returns:
        包含设备数、测试数、文件数、字节数和内容哈希的摘要。

    Raises:
        ValueError: 数量越界或目标目录不是空目录。
    """
    if not 1 <= device_count <= MAXIMUM_DEVICE_COUNT:
        raise ValueError("设备数量必须为 1~10")
    if tests_per_device < 1 or payload_bytes_per_test < 0 or round_count < 1:
        raise ValueError("测试数量、负载字节数和轮次数必须有效")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError(f"性能夹具目录必须为空：{destination}")

    destination.mkdir(parents=True, exist_ok=True)
    total_tests = 0
    padding = "x" * payload_bytes_per_test
    for device_index in range(device_count):
        device_id = f"performance-device-{device_index:02d}"
        device_dir = destination / device_id
        tests_dir = device_dir / "tests"
        _write_json(device_dir / "metadata.json", {
            "id": device_id,
            "name": f"性能设备 {device_index + 1}",
            "schemaVersion": DATASET_SCHEMA_VERSION,
            "createdAt": "2026-01-01T00:00:00+08:00",
            "updatedAt": "2026-01-01T00:00:00+08:00",
        })
        _write_json(device_dir / "device.json", {
            "Stations": {
                "LP1": {"Name": "LP1", "Type": "LoadPort", "Capacity": 25, "Slots": list(range(1, 26))},
                "PM1": {"Name": "PM1", "Type": "ProcessChamber", "Capacity": 1, "Slots": [1]},
            },
            "Robots": {
                "R1": {"Name": "R1", "Type": "ATMRobot", "Capacity": 1, "ArmInfo": {"ArmA": {"SlotIDs": [1]}}},
            },
        })
        _write_json(device_dir / "routes.json", {
            "schemaVersion": DATASET_SCHEMA_VERSION,
            "routes": [],
            "cleans": [],
            "routeAliases": {},
        })
        _write_json(device_dir / "groups.json", {
            "schemaVersion": DATASET_SCHEMA_VERSION,
            "testGroups": ["性能"],
        })
        summaries = []
        for test_index in range(tests_per_device):
            test_id = f"performance-test-{device_index:02d}-{test_index:04d}"
            test_name = f"测试 {test_index + 1}"
            test_payload = {
                "schemaVersion": DATASET_SCHEMA_VERSION,
                "id": test_id,
                "name": test_name,
                "group": "性能",
                "strategy": "heuristic",
                "roundCount": round_count,
                "times": [float(index * 70) for index in range(round_count)],
                "options": {"fixturePayload": padding},
                "routeConfigs": {},
                "cleans": [],
                "rounds": [
                    {"currentTime": float(index * 70), "cjobs": []}
                    for index in range(round_count)
                ],
                "createdAt": "2026-01-01T00:00:00+08:00",
                "updatedAt": "2026-01-01T00:00:00+08:00",
            }
            _write_json(tests_dir / test_id / "test.json", test_payload)
            summaries.append({"id": test_id, "name": test_name, "group": "性能"})
            total_tests += 1
        _write_json(tests_dir / ".tests-index.json", summaries)

    # 完成标记最后落盘，确保服务启动把夹具识别为已迁移的当前版本。
    _write_json(destination / "manifest.json", {
        "kind": "ct-scheduler-datasets",
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "description": "确定性性能测试夹具",
    })

    files = sorted(path for path in destination.rglob("*") if path.is_file())
    digest = hashlib.sha256()
    total_bytes = 0
    for file_path in files:
        relative = file_path.relative_to(destination).as_posix().encode("utf-8")
        content = file_path.read_bytes()
        digest.update(relative)
        digest.update(b"\0")
        digest.update(content)
        total_bytes += len(content)
    return {
        "schemaVersion": PERFORMANCE_PROFILE_SCHEMA_VERSION,
        "deviceCount": device_count,
        "testCount": total_tests,
        "fileCount": len(files),
        "totalBytes": total_bytes,
        "sha256": digest.hexdigest(),
    }


def generate_v5_workspace_file(
    destination: Path,
    *,
    device_count: int,
    tests_per_device: int,
    payload_bytes_per_test: int,
    round_count: int,
) -> dict[str, Any]:
    """生成供 v5→v6 启动迁移基准使用的确定性单文件工作区。

    Args:
        destination: 旧版 ``workspaces.json`` 文件路径。
        device_count: 设备数量，范围为 1~10。
        tests_per_device: 每台设备的测试数量。
        payload_bytes_per_test: 每个测试携带的确定性填充字节数。
        round_count: 每个测试的轮次数。

    Returns:
        旧文件规模、字节数与 SHA-256 摘要。
    """
    if not 1 <= device_count <= MAXIMUM_DEVICE_COUNT:
        raise ValueError("设备数量必须为 1~10")
    padding = "x" * payload_bytes_per_test
    devices = []
    for device_index in range(device_count):
        device_id = f"performance-device-{device_index:02d}"
        tests = []
        for test_index in range(tests_per_device):
            test_id = f"performance-test-{device_index:02d}-{test_index:04d}"
            tests.append({
                "id": test_id,
                "name": f"测试 {test_index + 1}",
                "group": "性能",
                "strategy": "heuristic",
                "roundCount": round_count,
                "times": [float(index * 70) for index in range(round_count)],
                "options": {"fixturePayload": padding},
                "routeConfigs": {},
                "cleans": [],
                "rounds": [
                    {"currentTime": float(index * 70), "cjobs": []}
                    for index in range(round_count)
                ],
                "createdAt": "2026-01-01T00:00:00+08:00",
                "updatedAt": "2026-01-01T00:00:00+08:00",
            })
        devices.append({
            "id": device_id,
            "name": f"性能设备 {device_index + 1}",
            "device": {
                "Stations": {
                    "LP1": {"Name": "LP1", "Type": "LoadPort", "Capacity": 25, "Slots": list(range(1, 26))},
                    "PM1": {"Name": "PM1", "Type": "ProcessChamber", "Capacity": 1, "Slots": [1]},
                },
                "Robots": {
                    "R1": {"Name": "R1", "Type": "ATMRobot", "Capacity": 1, "ArmInfo": {"ArmA": {"SlotIDs": [1]}}},
                },
            },
            "routes": [],
            "cleans": [],
            "testGroups": ["性能"],
            "tests": tests,
            "createdAt": "2026-01-01T00:00:00+08:00",
            "updatedAt": "2026-01-01T00:00:00+08:00",
        })
    payload = {"version": 5, "devices": devices}
    _write_json(destination, payload)
    content = destination.read_bytes()
    return {
        "schemaVersion": PERFORMANCE_PROFILE_SCHEMA_VERSION,
        "sourceSchemaVersion": 5,
        "deviceCount": device_count,
        "testCount": device_count * tests_per_device,
        "fileCount": 1,
        "totalBytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
