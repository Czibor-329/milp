"""工作区目录跨进程事务锁的回归测试。"""

from __future__ import annotations

import json
import multiprocessing
import tempfile
import unittest
from pathlib import Path

from realtime_scheduler.backend import application as server


ROOT = Path(__file__).resolve().parents[1]
PSE300_PATH = ROOT / "alg" / "src" / "input_data" / "PSE300.json"


def _create_test_after_signal(
    store_path: str,
    device_id: str,
    test_name: str,
    start_signal: multiprocessing.synchronize.Event,
) -> None:
    """等待共同起跑信号后，在独立进程中执行一次读改写事务。"""
    start_signal.wait()
    server.create_workspace_test(
        device_id,
        {
            "name": test_name,
            "group": "跨进程锁",
            "strategy": "heuristic",
            "roundCount": 1,
            "rounds": [{"currentTime": 0, "cjobs": []}],
        },
        Path(store_path),
    )


class WorkspaceFileLockTests(unittest.TestCase):
    """验证两个服务进程不会拼坏 JSON 或相互覆盖新增测试。"""

    def test_concurrent_processes_preserve_both_transactions(self) -> None:
        """同时新增两个测试后，目录应保持有效且两项都存在。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            store_path = Path(temporary_directory) / "workspaces.json"
            raw_device = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
            device, _ = server.import_workspace_device(
                PSE300_PATH.name,
                raw_device,
                store_path,
            )
            context = multiprocessing.get_context("spawn")
            start_signal = context.Event()
            processes = [
                context.Process(
                    target=_create_test_after_signal,
                    args=(
                        str(store_path),
                        str(device["id"]),
                        test_name,
                        start_signal,
                    ),
                )
                for test_name in ("并发测试-A", "并发测试-B")
            ]
            for process in processes:
                process.start()
            start_signal.set()
            for process in processes:
                process.join(timeout=30)
                self.assertEqual(0, process.exitcode)

            catalog = json.loads(store_path.read_text(encoding="utf-8"))
            saved = server.get_workspace_device(str(device["id"]), store_path)
            self.assertEqual(2, len(catalog["devices"][0]["tests"]))
            self.assertEqual(
                {"并发测试-A", "并发测试-B"},
                {test_case["name"] for test_case in saved["tests"]},
            )


if __name__ == "__main__":
    unittest.main()
