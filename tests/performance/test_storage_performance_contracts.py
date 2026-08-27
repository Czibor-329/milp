"""验证工作区高频操作的确定性复杂度与性能夹具约束。

墙钟时间容易受共享机器抖动影响，本文件优先检查业务文件访问集合：设备列表和
设备概览不得读取完整测试，单测试读写不得触碰其他测试。毫秒预算由独立性能
运行器在固定 Windows 环境执行。
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from realtime_scheduler import server
from tests.performance.fixture_factory import (
    generate_v7_dataset,
    load_performance_profiles,
)


ROOT = Path(__file__).resolve().parents[2]
PROFILE_PATH = ROOT / "performance" / "profiles.json"
BUDGET_PATH = ROOT / "performance" / "budgets.json"


def _test_file_hashes(store_dir: Path) -> dict[Path, str]:
    """返回数据集中每个完整测试文件的 SHA-256。"""
    return {
        path: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in store_dir.glob("*/tests/*/test.json")
    }


class PerformanceFixtureTests(unittest.TestCase):
    """验证规模配置与合成数据的稳定性。"""

    def test_profiles_never_exceed_ten_devices(self) -> None:
        """所有性能场景必须遵守最多十台设备的产品边界。"""
        profiles = load_performance_profiles(PROFILE_PATH)

        self.assertEqual(10, profiles["maximumDeviceCount"])
        self.assertTrue(all(
            1 <= int(profile["deviceCount"]) <= 10
            for profile in profiles["profiles"].values()
        ))

    def test_fixture_generation_is_deterministic(self) -> None:
        """相同参数生成的数据规模和内容哈希必须完全相同。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            arguments = {
                "device_count": 2,
                "tests_per_device": 3,
                "payload_bytes_per_test": 128,
                "round_count": 2,
            }
            first = generate_v7_dataset(root / "first", **arguments)
            second = generate_v7_dataset(root / "second", **arguments)

        self.assertEqual(first, second)
        self.assertEqual(2, first["deviceCount"])
        self.assertEqual(6, first["testCount"])

    def test_fixture_rejects_more_than_ten_devices(self) -> None:
        """生成器必须拒绝超出产品上限的规模定义。"""
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "1~10"):
                generate_v7_dataset(
                    Path(directory) / "datasets",
                    device_count=11,
                    tests_per_device=1,
                    payload_bytes_per_test=0,
                    round_count=1,
                )


class WorkspaceStorageComplexityTests(unittest.TestCase):
    """验证 v6 工作区常用操作不会随完整测试数量线性退化。"""

    def setUp(self) -> None:
        """为每项测试创建包含多设备、多测试的可读数据目录。"""
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store_dir = Path(self.temporary_directory.name) / "datasets"
        generate_v7_dataset(
            self.store_dir,
            device_count=3,
            tests_per_device=12,
            payload_bytes_per_test=512,
            round_count=2,
        )
        self.device_id = "performance-device-00"
        self.test_id = "performance-test-00-0000"

    def tearDown(self) -> None:
        """清理当前测试的临时数据目录。"""
        self.temporary_directory.cleanup()

    def _record_json_reads(self):
        """返回记录 ``Path.read_text`` 调用的补丁上下文和结果列表。"""
        reads: list[Path] = []
        original_read_text = Path.read_text

        def tracked_read_text(path: Path, *args, **kwargs):
            """记录被读取路径后调用 pathlib 原实现。"""
            reads.append(path)
            return original_read_text(path, *args, **kwargs)

        return patch.object(Path, "read_text", tracked_read_text), reads

    def test_device_list_reads_only_metadata_and_indexes(self) -> None:
        """设备列表不得读取任何完整测试文件。"""
        context, reads = self._record_json_reads()
        with context, patch.object(
            server,
            "_read_workspace_catalog_unlocked",
            side_effect=AssertionError("设备列表不得读取完整目录"),
        ):
            devices = server.list_workspace_devices(self.store_dir)

        self.assertEqual(3, len(devices))
        self.assertFalse(any(path.name == "test.json" for path in reads))
        self.assertEqual([12, 12, 12], [device["testCount"] for device in devices])

    def test_device_overview_does_not_read_test_files(self) -> None:
        """设备概览只能读取设备文件和测试摘要索引。"""
        context, reads = self._record_json_reads()
        with context, patch.object(
            server,
            "_workspace_data_update_required",
            side_effect=AssertionError("高频读取不得扫描数据文件时间戳"),
        ):
            overview = server.get_workspace_device_overview(
                self.device_id,
                self.store_dir,
            )

        self.assertEqual(12, len(overview["tests"]))
        self.assertFalse(any(path.name == "test.json" for path in reads))

    def test_single_test_read_opens_only_target_test(self) -> None:
        """读取单个测试时不得解析同设备的其他完整测试。"""
        context, reads = self._record_json_reads()
        with context, patch.object(
            server,
            "_workspace_data_update_required",
            side_effect=AssertionError("高频读取不得扫描数据文件时间戳"),
        ):
            test_case = server.get_workspace_test(
                self.device_id,
                self.test_id,
                self.store_dir,
            )

        read_test_files = [path for path in reads if path.name == "test.json"]
        self.assertEqual(self.test_id, test_case["id"])
        self.assertEqual(1, len(read_test_files))
        self.assertEqual(self.test_id, read_test_files[0].parent.name)

    def test_single_run_context_opens_only_target_test(self) -> None:
        """前端点击运行时只能读取目标测试，不能加载同设备的全部测试。"""
        context, reads = self._record_json_reads()
        with context, patch.object(
            server,
            "_read_workspace_catalog_unlocked",
            side_effect=AssertionError("单测运行不得读取完整工作区目录"),
        ), patch.object(
            server,
            "_workspace_data_update_required",
            side_effect=AssertionError("单测运行不得扫描数据文件时间戳"),
        ):
            device, test_case = server.get_workspace_run_context(
                self.device_id,
                self.test_id,
                self.store_dir,
            )

        read_test_files = [path for path in reads if path.name == "test.json"]
        self.assertEqual(self.device_id, device["id"])
        self.assertEqual(self.test_id, test_case["id"])
        self.assertEqual(1, len(read_test_files))
        self.assertEqual(self.test_id, read_test_files[0].parent.name)

    def test_single_run_preparation_p95_stays_within_frontend_budget(self) -> None:
        """运行准备 P95 必须满足前端点击到算法启动前的附加耗时预算。"""
        budget = json.loads(BUDGET_PATH.read_text(encoding="utf-8"))[
            "absoluteMilliseconds"
        ]["singleRunPreparationP95"]
        durations: list[float] = []
        for _ in range(20):
            started = time.perf_counter()
            device, test_case = server.get_workspace_run_context(
                self.device_id,
                self.test_id,
                self.store_dir,
            )
            durations.append((time.perf_counter() - started) * 1000.0)
            self.assertEqual(self.device_id, device["id"])
            self.assertEqual(self.test_id, test_case["id"])

        ordered = sorted(durations)
        p95 = ordered[int((len(ordered) - 1) * 0.95)]
        self.assertLessEqual(
            p95,
            budget,
            f"单测运行准备 P95={p95:.1f} ms，超过预算 {budget} ms",
        )

    def test_single_test_save_keeps_other_test_hashes(self) -> None:
        """保存目标测试不得改写或规范化其他测试文件。"""
        before = _test_file_hashes(self.store_dir)
        test_case = server.get_workspace_test(
            self.device_id,
            self.test_id,
            self.store_dir,
        )
        with patch.object(
            server,
            "_read_workspace_catalog_unlocked",
            side_effect=AssertionError("单测试保存不得读取完整目录"),
        ), patch.object(
            server,
            "_workspace_data_update_required",
            side_effect=AssertionError("单测试保存不得扫描数据文件时间戳"),
        ):
            updated = server.update_workspace_test(
                self.device_id,
                self.test_id,
                {**test_case, "name": "已更新性能测试"},
                self.store_dir,
            )
        after = _test_file_hashes(self.store_dir)

        target_path = next(
            path for path in before if path.parent.name == self.test_id
        )
        self.assertEqual("已更新性能测试", updated["name"])
        self.assertNotEqual(before[target_path], after[target_path])
        self.assertEqual(
            {path: digest for path, digest in before.items() if path != target_path},
            {path: digest for path, digest in after.items() if path != target_path},
        )

    def test_route_save_does_not_read_or_rewrite_tests(self) -> None:
        """保存无冲突模板时只能修改设备级 routes 和元数据。"""
        before = _test_file_hashes(self.store_dir)
        context, reads = self._record_json_reads()
        with context, patch.object(
            server,
            "_read_workspace_catalog_unlocked",
            side_effect=AssertionError("普通 Route 保存不得读取完整目录"),
        ):
            result = server.update_workspace_routes(
                self.device_id,
                {
                    "routes": [{
                        "name": "性能路径",
                        "group": "性能路径",
                        "stages": [
                            {"stepId": 0, "needProcess": False, "visits": [{"stationName": "LP1"}]},
                            {"stepId": 1, "needProcess": True, "visits": [{"stationName": "PM1"}]},
                        ],
                    }],
                },
                self.store_dir,
                include_tests=False,
            )
        after = _test_file_hashes(self.store_dir)

        self.assertEqual(12, result["testCount"])
        self.assertEqual(before, after)
        self.assertFalse(any(path.name == "test.json" for path in reads))


class WorkspaceDeviceLimitTests(unittest.TestCase):
    """验证生产工作区与性能夹具使用同一个十设备上限。"""

    def test_import_rejects_eleventh_distinct_device(self) -> None:
        """第十一台不同拓扑设备必须在写入前被拒绝。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            for index in range(10):
                server.import_workspace_device(
                    f"device-{index}.json",
                    {
                        "Stations": {
                            f"LP{index}": {
                                "Name": f"LP{index}",
                                "Type": "LoadPort",
                                "Capacity": 1,
                                "Slots": [1],
                            },
                        },
                        "Robots": {},
                    },
                    store_path,
                )

            with self.assertRaisesRegex(ValueError, "不能超过 10 台"):
                server.import_workspace_device(
                    "device-10.json",
                    {
                        "Stations": {
                            "LP10": {
                                "Name": "LP10",
                                "Type": "LoadPort",
                                "Capacity": 1,
                                "Slots": [1],
                            },
                        },
                        "Robots": {},
                    },
                    store_path,
                )


if __name__ == "__main__":
    unittest.main()
