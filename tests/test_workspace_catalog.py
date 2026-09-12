"""工作区目录、迁移、分组与单测试读写测试。"""

from __future__ import annotations

import copy
from concurrent.futures import Future
import inspect
import json
import os
import re
import tempfile
import threading
import time
import unittest
import zipfile
from io import BytesIO
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

import realtime_scheduler.backend.application as config_server
from realtime_scheduler.backend.algorithms.interface import discover_other_algorithms
from realtime_scheduler.backend.execution.plan_builder import _runtime_clean, build_process_recipes
from src.compiler import compile_problem
from realtime_scheduler.backend.application import (
    BuildState,
    LoggedPlanError,
    build_round_update,
    build_route,
    create_workspace_test,
    delete_workspace_device,
    delete_workspace_test,
    execute_plan,
    extract_init_data,
    get_workspace_device,
    import_workspace_device,
    list_workspace_devices,
    update_workspace_test,
)
from scripts.replay_config_log import load_plan_from_log
from tests.support.plan_fixtures import DEVICE_PATH, job as _job, route as _route


ROOT = Path(__file__).resolve().parents[1]
EDITOR_PATH = ROOT / "realtime_scheduler" / "frontend" / "config_editor.html"
DOCUMENTATION_PAGE_PATH = ROOT / "realtime_scheduler" / "frontend" / "documentation.html"
EDITOR_STYLE_PATH = ROOT / "realtime_scheduler" / "frontend" / "assets" / "config_editor.css"
EDITOR_SCRIPT_PATH = ROOT / "realtime_scheduler" / "frontend" / "src" / "config_editor.ts"
DOCUMENTATION_SCRIPT_PATH = ROOT / "realtime_scheduler" / "frontend" / "src" / "documentation_page.ts"


def _editor_source() -> str:
    """合并页面模板、样式和 TypeScript 源码，供前端结构回归断言使用。"""
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in (EDITOR_PATH, EDITOR_STYLE_PATH, EDITOR_SCRIPT_PATH)
    )


def _device_recording() -> list[dict]:
    """读取包含 AlgInit 的项目内实时重算小设备案例。"""
    return json.loads(DEVICE_PATH.read_text(encoding="utf-8"))

class WorkspaceCatalogTests(unittest.TestCase):
    """工作区目录、迁移、分组与单测试读写。"""

    def setUp(self) -> None:
        """为每个案例提取同一份设备拓扑。"""
        self.recording = _device_recording()
        self.device = extract_init_data(self.recording)

    def test_device_workspace_persists_independent_test_cases(self) -> None:
        """同一设备的多套 Route/Clean/重算配置应独立保存并可复制、修改、删除。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, created = import_workspace_device("device-a.json", self.recording, store_path)
            duplicate, duplicate_created = import_workspace_device("renamed.json", self.device, store_path)
            self.assertTrue(created)
            self.assertFalse(duplicate_created)
            self.assertEqual(device["id"], duplicate["id"])
            self.assertEqual("renamed.json", duplicate["name"])

            base = {
                "name": "基础案例",
                "strategy": "heuristic",
                "roundCount": 1,
                "times": [0],
                "options": {"loadLockExchange": "disabled"},
                "cleans": [{"name": "CleanA"}],
                "routes": [{"name": "RouteA"}],
                "rounds": [{"jobs": [{"name": "Initial"}]}],
            }
            first = create_workspace_test(device["id"], base, store_path)
            self.assertNotIn("loadLockExchange", first["options"])
            second = create_workspace_test(device["id"], {**base, "name": "复制案例"}, store_path)
            updated_second = update_workspace_test(device["id"], second["id"], {
                **base,
                "name": "复制案例-PM34",
                "routes": [{"name": "RoutePM34"}],
                "roundCount": 2,
                "times": [0, 100],
                "rounds": [{"jobs": []}, {"jobs": [{"name": "Added"}]}],
            }, store_path)

            loaded = get_workspace_device(device["id"], store_path)
            self.assertEqual(2, len(loaded["tests"]))
            self.assertEqual([{"name": "RoutePM34"}], loaded["routes"])
            self.assertEqual([], loaded["cleans"])
            self.assertTrue(all("routes" not in item for item in loaded["tests"]))
            self.assertTrue(all(item["cleans"] == [{"name": "CleanA"}] for item in loaded["tests"]))
            self.assertTrue(all("routeConfigs" in item for item in loaded["tests"]))
            self.assertNotIn("routes", updated_second)
            self.assertEqual(2, updated_second["roundCount"])
            migrated = updated_second["rounds"][1]["cjobs"][0]
            self.assertEqual("2", migrated["taskId"])
            self.assertEqual(["P1"], migrated["pJobNameList"])
            self.assertNotIn("foupId", migrated["pjobs"][0])
            self.assertNotIn("weight", migrated["pjobs"][0])
            self.assertEqual(2, list_workspace_devices(store_path)[0]["testCount"])

            delete_workspace_test(device["id"], first["id"], store_path)
            remaining = get_workspace_device(device["id"], store_path)["tests"]
            self.assertEqual([second["id"]], [item["id"] for item in remaining])
            with self.assertRaises(ValueError):
                delete_workspace_test(device["id"], second["id"], store_path)

    def test_device_workspace_delete_removes_device_and_its_tests(self) -> None:
        """删除设备应从目录中移除设备及其全部测试集，删除后无法再读取。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            first, _ = import_workspace_device("device-a.json", self.recording, store_path)
            # 构造一台拓扑有差异的第二台设备，验证删除只影响目标设备。
            second_device = copy.deepcopy(self.device)
            second_device["Stations"]["PM1"]["Name"] = "PM1x"
            second, _ = import_workspace_device("device-b.json", second_device, store_path)
            self.assertNotEqual(first["id"], second["id"])
            self.assertEqual(2, len(list_workspace_devices(store_path)))

            deleted = delete_workspace_device(first["id"], store_path)
            self.assertEqual(first["id"], deleted["id"])
            self.assertEqual("device-a.json", deleted["name"])
            self.assertEqual(0, deleted["testCount"])
            self.assertEqual([second["id"]], [item["id"] for item in list_workspace_devices(store_path)])
            with self.assertRaises(ValueError):
                get_workspace_device(first["id"], store_path)

            delete_workspace_device(second["id"], store_path)
            self.assertEqual([], list_workspace_devices(store_path))
            with self.assertRaises(ValueError):
                delete_workspace_device(first["id"], store_path)

    def test_directory_store_splits_tests_into_shareable_files(self) -> None:
        """拆分目录下每个测试集是独立文件，放入分享文件后无需重启即可读取。"""
        with tempfile.TemporaryDirectory() as directory:
            store_dir = Path(directory) / "workspaces"
            device, _ = import_workspace_device("device-a.json", self.recording, store_dir)
            test = create_workspace_test(device["id"], {
                "name": "基础案例", "strategy": "heuristic", "roundCount": 1,
                "times": [0], "rounds": [{"jobs": [{"name": "Initial"}]}],
            }, store_dir)
            device_dir = store_dir / device["id"]
            self.assertTrue((device_dir / "device.json").is_file())
            test_file = device_dir / "tests" / f"{test['id']}.json"
            self.assertTrue(test_file.is_file())
            self.assertNotIn("tests", json.loads((device_dir / "device.json").read_text(encoding="utf-8")))

            # 把同事分享的测试集文件放入 tests 目录，读取时直接生效。
            shared = copy.deepcopy(test)
            shared["id"] = "shared-test-0001"
            shared["name"] = "同事分享的测试"
            shared["group"] = "冒烟"
            (device_dir / "tests" / "shared-test-0001.json").write_text(
                json.dumps(shared, ensure_ascii=False), encoding="utf-8",
            )
            loaded = get_workspace_device(device["id"], store_dir)
            self.assertEqual(
                {"基础案例", "同事分享的测试"},
                {item["name"] for item in loaded["tests"]},
            )

            # 删除测试集与设备后，对应文件与目录一并清理。
            delete_workspace_test(device["id"], test["id"], store_dir)
            self.assertFalse(test_file.exists())
            delete_workspace_device(device["id"], store_dir)
            self.assertFalse(device_dir.exists())
            self.assertEqual([], list_workspace_devices(store_dir))

    def test_directory_workspace_migration_runs_once_per_store_version(self) -> None:
        """迁移完成标记存在时后续启动应直接跳过数据更新。"""
        with tempfile.TemporaryDirectory() as directory:
            store_dir = Path(directory) / "workspaces"
            import_workspace_device("device-a.json", self.recording, store_dir)
            marker = store_dir / config_server.WORKSPACE_STORE_VERSION_FILE
            self.assertTrue(marker.is_file())
            self.assertFalse(config_server._workspace_data_update_required(store_dir))

            marker.unlink()
            self.assertTrue(config_server._workspace_data_update_required(store_dir))
            with patch.object(
                config_server,
                "_migrate_workspace_catalog",
                wraps=config_server._migrate_workspace_catalog,
            ) as migrate:
                self.assertTrue(config_server._prepare_workspace_data(store_dir))
                self.assertFalse(config_server._prepare_workspace_data(store_dir))
            self.assertEqual(1, migrate.call_count)
            self.assertFalse(config_server._workspace_data_update_required(store_dir))

    def test_directory_store_migrates_legacy_single_file(self) -> None:
        """旧单文件存储首次以目录模式读取时自动迁移为拆分目录，旧文件保留备份。"""
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            fake_data = tmp / "data"
            fake_data.mkdir()
            legacy_file = fake_data / "workspaces.json"
            device, _ = import_workspace_device("device-a.json", self.recording, legacy_file)
            create_workspace_test(device["id"], {
                "name": "迁移案例", "roundCount": 1, "rounds": [{}],
            }, legacy_file)

            store_dir = tmp / "workspaces"
            with (
                patch.object(config_server, "DATA_DIR", fake_data),
                patch.object(config_server, "WORKSPACE_STORE_PATH", store_dir),
            ):
                catalog = config_server._read_workspace_catalog_unlocked(store_dir)
            self.assertEqual([device["id"]], [item["id"] for item in catalog["devices"]])
            self.assertTrue((store_dir / device["id"] / "tests").is_dir())
            self.assertTrue((fake_data / "workspaces.json.legacy.json").is_file())
            self.assertFalse(legacy_file.exists())
            # 迁移后的目录重启读取仍然正常。
            loaded = get_workspace_device(device["id"], store_dir)
            self.assertEqual("迁移案例", loaded["tests"][0]["name"])

    def test_directory_store_retries_interrupted_migration(self) -> None:
        """迁移中断（目录残留且旧单文件未改名）后再次读取应重新迁移补齐数据。"""
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            fake_data = tmp / "data"
            fake_data.mkdir()
            legacy_file = fake_data / "workspaces.json"
            device, _ = import_workspace_device("device-a.json", self.recording, legacy_file)
            create_workspace_test(device["id"], {
                "name": "迁移案例", "roundCount": 1, "rounds": [{}],
            }, legacy_file)

            store_dir = tmp / "workspaces"
            # 模拟上次迁移只写了一部分就中断：目录残留 + 旧文件未改名。
            store_dir.mkdir()
            (store_dir / "stale-device-dir").mkdir()
            with (
                patch.object(config_server, "DATA_DIR", fake_data),
                patch.object(config_server, "WORKSPACE_STORE_PATH", store_dir),
            ):
                catalog = config_server._read_workspace_catalog_unlocked(store_dir)
            # 残留目录被幂等重建，数据完整且旧文件保留备份。
            self.assertEqual([device["id"]], [item["id"] for item in catalog["devices"]])
            self.assertFalse((store_dir / "stale-device-dir").exists())
            self.assertTrue((fake_data / "workspaces.json.legacy.json").is_file())
            loaded = get_workspace_device(device["id"], store_dir)
            self.assertEqual("迁移案例", loaded["tests"][0]["name"])

    def test_different_groups_allow_same_test_name(self) -> None:
        """测试名称只需在组内唯一，不同组可以使用完全相同的名称。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            first = create_workspace_test(device["id"], {
                "name": "r1", "group": "R1", "roundCount": 1, "rounds": [{}],
            }, store_path)
            second = create_workspace_test(device["id"], {
                "name": "r1", "group": "R2", "roundCount": 1, "rounds": [{}],
            }, store_path)

            self.assertEqual("r1", first["name"])
            self.assertEqual("r1", second["name"])
            self.assertNotEqual(first["id"], second["id"])

    def test_workspace_test_group_persists_across_create_and_update(self) -> None:
        """测试集分组应独立保存，旧的空分组也保持兼容。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            created = create_workspace_test(device["id"], {
                "name": "吞吐验证", "group": "吞吐对比", "roundCount": 1, "rounds": [{}],
            }, store_path)
            self.assertEqual("吞吐对比", created["group"])

            updated = update_workspace_test(device["id"], created["id"], {
                **created, "group": "回归测试",
            }, store_path)
            self.assertEqual("回归测试", updated["group"])
            loaded = get_workspace_device(device["id"], store_path)
            self.assertEqual("回归测试", loaded["tests"][0]["group"])
            self.assertEqual(["吞吐对比", "回归测试"], loaded["testGroups"])

    def test_readable_dataset_reads_and_updates_one_test_without_full_catalog_scan(self) -> None:
        """v6 目录的常用读取与测试保存不能退化为解析、比较全部测试文件。"""
        with tempfile.TemporaryDirectory() as directory:
            store_dir = Path(directory) / "datasets"
            store_dir.mkdir()
            config_server._write_json_atomic(
                store_dir / config_server.WORKSPACE_STORE_VERSION_FILE,
                {
                    "kind": "ct-scheduler-datasets",
                    "schemaVersion": config_server.WORKSPACE_STORE_VERSION,
                },
            )
            device_id = "device-fast-path"
            first = config_server._normalize_test_case({
                "name": "快速案例", "group": "回归", "roundCount": 1, "rounds": [{}],
            }, "test-fast-path", ["LP1"])
            second = config_server._normalize_test_case({
                "name": "保持不变", "group": "回归", "roundCount": 1, "rounds": [{}],
            }, "test-untouched", ["LP1"])
            catalog = {
                "version": config_server.WORKSPACE_STORE_VERSION,
                "devices": [{
                    "id": device_id,
                    "name": "性能测试设备",
                    "device": copy.deepcopy(self.device),
                    "routes": [],
                    "cleans": [],
                    "routeAliases": {},
                    "testGroups": ["回归"],
                    "tests": [first, second],
                }],
            }
            config_server._write_readable_workspace_catalog_directory(store_dir, catalog)
            device_dir = config_server._find_dataset_device_directory(store_dir, device_id)
            untouched_file = config_server._find_dataset_test_file(device_dir, second["id"])
            untouched_before = untouched_file.read_bytes()

            with patch.object(
                config_server,
                "_read_workspace_catalog_unlocked",
                side_effect=AssertionError("不应读取完整工作区目录"),
            ):
                overview = config_server.get_workspace_device_overview(device_id, store_dir)
                loaded = config_server.get_workspace_test(device_id, first["id"], store_dir)
                updated = config_server.update_workspace_test(device_id, first["id"], {
                    **loaded,
                    "name": "快速案例-已修改",
                    "group": "即时保存",
                }, store_dir)

            self.assertEqual(2, len(overview["tests"]))
            self.assertEqual("快速案例-已修改", updated["name"])
            self.assertEqual("即时保存", updated["group"])
            self.assertEqual(untouched_before, untouched_file.read_bytes())
            summaries = json.loads(
                config_server._workspace_test_index_path(device_dir / "tests").read_text(
                    encoding="utf-8",
                )
            )
            self.assertEqual(
                "快速案例-已修改",
                next(item for item in summaries if item["id"] == first["id"])["name"],
            )

    def test_workspace_group_can_exist_without_creating_test(self) -> None:
        """点击组别加号只应增加空组，不应隐式增加测试。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            groups = config_server.create_workspace_test_group(device["id"], "性能测试", store_path)
            loaded = get_workspace_device(device["id"], store_path)
            self.assertEqual(["性能测试"], groups)
            self.assertEqual(["性能测试"], loaded["testGroups"])
            self.assertEqual([], loaded["tests"])

    def test_workspace_group_can_rename_and_delete_its_tests(self) -> None:
        """组别改名应同步测试；删除组别必须一并移除组内测试。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            config_server.create_workspace_test_group(device["id"], "回归", store_path)
            config_server.create_workspace_test_group(device["id"], "保留", store_path)
            created = create_workspace_test(device["id"], {
                "name": "回归案例", "group": "回归", "roundCount": 1, "rounds": [{}],
            }, store_path)
            create_workspace_test(device["id"], {
                "name": "保留案例", "group": "保留", "roundCount": 1, "rounds": [{}],
            }, store_path)

            renamed = config_server.rename_workspace_test_group(device["id"], "回归", "冒烟", store_path)
            self.assertEqual(["冒烟", "保留"], renamed["groups"])
            self.assertEqual("冒烟", next(test for test in renamed["tests"] if test["id"] == created["id"])["group"])

            deleted = config_server.delete_workspace_test_group(device["id"], "冒烟", store_path)
            self.assertEqual(1, deleted["deletedTestCount"])
            self.assertEqual(["保留"], deleted["groups"])
            self.assertEqual(["保留案例"], [test["name"] for test in deleted["tests"]])
            ungrouped = create_workspace_test(device["id"], {
                "name": "未分组案例", "roundCount": 1, "rounds": [{}],
            }, store_path)
            deleted_ungrouped = config_server.delete_workspace_test_group(device["id"], "", store_path)
            self.assertEqual(1, deleted_ungrouped["deletedTestCount"])
            self.assertNotIn(ungrouped["id"], [test["id"] for test in deleted_ungrouped["tests"]])
