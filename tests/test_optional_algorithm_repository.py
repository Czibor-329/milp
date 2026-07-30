"""验证平台在完整算法仓库缺席时仍可启动并驱动标准算法包。"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class OptionalAlgorithmRepositoryTests(unittest.TestCase):
    """覆盖无 alg、独立 other_alg 和轻量多轮协议三种交付场景。"""

    def _run_isolated_server_script(
        self,
        script: str,
        *,
        packaged_root: Path,
    ) -> subprocess.CompletedProcess[str]:
        """在新进程中屏蔽本地 alg，并执行一段服务端断言脚本。"""
        environment = os.environ.copy()
        environment["CT_ALGORITHM_ROOT"] = str(
            packaged_root.parent / "missing-private-alg"
        )
        environment["CT_OTHER_ALGORITHM_ROOT"] = str(packaged_root)
        return subprocess.run(
            [sys.executable, "-c", textwrap.dedent(script)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def test_server_imports_without_any_algorithm(self) -> None:
        """算法目录为空时服务端模块应正常导入，并把内置策略标为不可用。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            packaged_root = Path(temporary_directory) / "other_alg"
            packaged_root.mkdir()
            completed = self._run_isolated_server_script(
                """
                import json
                import threading
                from http.server import ThreadingHTTPServer
                from urllib.request import urlopen

                import realtime_scheduler.server as server

                assert server.BUILTIN_ALGORITHM_AVAILABLE is False
                assert server.discover_other_algorithms() == []
                http_server = ThreadingHTTPServer(
                    ("127.0.0.1", 0),
                    server.ConfigEditorHandler,
                )
                thread = threading.Thread(
                    target=http_server.serve_forever,
                    daemon=True,
                )
                thread.start()
                try:
                    port = http_server.server_address[1]
                    with urlopen(
                        f"http://127.0.0.1:{port}/api/health",
                        timeout=5,
                    ) as response:
                        health = json.load(response)
                    assert health["ok"] is True
                    assert health["algorithmRepositoryAvailable"] is False
                    assert health["strategies"]["heuristic"] is False
                finally:
                    http_server.shutdown()
                    http_server.server_close()
                    thread.join(timeout=5)
                """,
                packaged_root=packaged_root,
            )
        self.assertEqual(
            0,
            completed.returncode,
            completed.stdout + completed.stderr,
        )

    def test_discovers_standalone_packaged_algorithm(self) -> None:
        """独立 other_alg 目录不依赖完整算法仓库即可参与动态发现。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            packaged_root = Path(temporary_directory) / "other_alg"
            entry = packaged_root / "Delivered" / "infer" / "scheduler.py"
            entry.parent.mkdir(parents=True)
            entry.write_text(
                "def init(payload):\n    return None\n"
                "def update(payload):\n"
                "    return '{\"MoveList\": [], \"Feedback\": []}'\n",
                encoding="utf-8",
            )
            completed = self._run_isolated_server_script(
                """
                import realtime_scheduler.server as server
                from realtime_scheduler.algorithm_interface import (
                    init,
                    session,
                    update,
                )

                algorithms = server.discover_other_algorithms()
                assert server.BUILTIN_ALGORITHM_AVAILABLE is False
                assert [item["id"] for item in algorithms] == ["Delivered"]
                assert algorithms[0]["entry"] == "infer/scheduler.py"
                with session("delivered"):
                    init({})
                    output = update({})
                assert output["MoveList"] == []
                assert output["Feedback"] == []
                """,
                packaged_root=packaged_root,
            )
        self.assertEqual(
            0,
            completed.returncode,
            completed.stdout + completed.stderr,
        )

    def test_packaged_runtime_builds_recompute_facts(self) -> None:
        """轻量运行时应按时间线生成通知、删除尾段并拼接代次历史。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            packaged_root = Path(temporary_directory) / "other_alg"
            packaged_root.mkdir()
            completed = self._run_isolated_server_script(
                """
                import realtime_scheduler.server as server

                first_update = {
                    "CurrentTime": 0,
                    "Materials": [{
                        "ID": 1,
                        "CurrentModuleName": "LP1",
                        "PJobName": "P1",
                    }],
                    "ProcessJobs": [{"JobName": "P1", "MatList": [1]}],
                    "ControlJobs": [{
                        "JobName": "C1",
                        "PJobNameList": ["P1"],
                        "MaterialCount": 1,
                    }],
                    "Routes": {},
                    "Robots": {},
                    "Stations": {},
                }
                first_output = {
                    "MoveList": [
                        {
                            "MoveID": 1,
                            "MoveType": 0,
                            "ModuleName": "ATR",
                            "MatIDList": [1],
                            "RobotSlotList": [1],
                            "SrcStationList": ["LP1"],
                            "SrcSlotList": [1],
                            "StepIDList": [1],
                            "StartTime": 1,
                            "EndTime": 5,
                        },
                        {
                            "MoveID": 2,
                            "MoveType": 9,
                            "MatIDList": [1],
                            "StartTime": 10,
                            "EndTime": 12,
                        },
                    ],
                    "Feedback": [],
                }
                runtime = server.PackagedAlgorithmRuntime(
                    first_update,
                    first_output,
                )
                notifications = server.advance_packaged_algorithm_to_update(
                    runtime,
                    3,
                )
                assert [
                    (item["MoveID"], item["MoveState"])
                    for item in notifications
                ] == [(1, 0)]
                next_update = {
                    "CurrentTime": 3,
                    "Materials": [],
                    "ProcessJobs": [],
                    "ControlJobs": [],
                    "Routes": {},
                    "Robots": {"ATR": {"TimeToAvailable": 0}},
                    "Stations": {
                        "LP1": {
                            "TimeToAvailableOfSlot": {"1": 0},
                        },
                    },
                }
                update = server._build_packaged_algorithm_recompute_update(
                    runtime,
                    next_update,
                    3,
                    notifications,
                )
                assert update["RemoveList"] == [2]
                assert len(update["MoveStates"]) == 1
                assert update["Robots"]["ATR"]["TimeToAvailable"] == 2
                assert update["Materials"][0]["CurrentModuleName"] == "LP1"
                assert [move["MoveID"] for move in runtime.committed_moves(3)] == [1]
                """,
                packaged_root=packaged_root,
            )
        self.assertEqual(
            0,
            completed.returncode,
            completed.stdout + completed.stderr,
        )


if __name__ == "__main__":
    unittest.main()
