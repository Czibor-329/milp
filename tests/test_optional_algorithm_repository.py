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
        """在新进程中屏蔽本地 alg，并执行一段服务端断言脚本。

        登记数据目录同样被重定向到临时目录，使测试不依赖真实
        ``data/registered_algorithms.json`` 中已存在的登记条目。
        """
        environment = os.environ.copy()
        environment["CT_ALGORITHM_ROOT"] = str(
            packaged_root.parent / "missing-private-alg"
        )
        environment["CT_OTHER_ALGORITHM_ROOT"] = str(packaged_root)
        # 屏蔽本机代理：测试直连 127.0.0.1，避免 HTTP_PROXY 等环境变量
        # 把 /api/health 请求转发到代理端口导致 502。
        environment["NO_PROXY"] = "*"
        environment["no_proxy"] = "*"
        with tempfile.TemporaryDirectory() as registry_directory:
            environment["CT_REGISTERED_ALGORITHMS_DATA_DIR"] = registry_directory
            isolation = (
                "import os\n"
                "from pathlib import Path\n"
                "import realtime_scheduler.algorithm_interface as _algorithm_interface\n"
                "_registered_data = Path(os.environ['CT_REGISTERED_ALGORITHMS_DATA_DIR'])\n"
                "_algorithm_interface.REGISTERED_ALGORITHMS_FILE = (\n"
                "    _registered_data / 'registered_algorithms.json'\n"
                ")\n"
                "_algorithm_interface.REGISTERED_ALGORITHMS_DIR = (\n"
                "    _registered_data / 'registered_algorithms'\n"
                ")\n"
            )
            completed = subprocess.run(
                [sys.executable, "-c", isolation + textwrap.dedent(script)],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        return completed

    def test_builtin_repository_replaces_preloaded_external_src_package(self) -> None:
        """内置算法必须替换启动前已缓存的外部 src 同名包。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            algorithm_root = temporary_root / "alg"
            source_root = algorithm_root / "src"
            (source_root / "schedule").mkdir(parents=True)
            (source_root / "__init__.py").write_text("", encoding="utf-8")
            (source_root / "api.py").write_text(
                "from contextlib import contextmanager\n"
                "SUPPORTED_ALGORITHMS = frozenset({'heuristic'})\n"
                "def get_last_strategy_diagnostics():\n    return {}\n"
                "@contextmanager\n"
                "def session():\n    yield\n",
                encoding="utf-8",
            )
            (source_root / "compiler.py").write_text(
                "def compile_problem(payload):\n    return payload\n",
                encoding="utf-8",
            )
            (source_root / "paths.py").write_text(
                "from pathlib import Path\nMODELS_DIR = Path('.')\n",
                encoding="utf-8",
            )
            (source_root / "schedule" / "__init__.py").write_text(
                "", encoding="utf-8"
            )
            (source_root / "schedule" / "realtime.py").write_text(
                "TIME_TOLERANCE = 1e-6\nclass RealtimeRescheduler:\n    pass\n",
                encoding="utf-8",
            )

            # 真实冲突包位于 alg/other_alg 内；仅判断模块是否在
            # ALGORITHM_ROOT 下会把它误认为内置 alg/src。
            external_root = algorithm_root / "other_alg" / "framework"
            external_src = external_root / "src"
            external_src.mkdir(parents=True)
            (external_src / "__init__.py").write_text(
                "EXTERNAL_PACKAGE = True\n", encoding="utf-8"
            )

            environment = os.environ.copy()
            environment["CT_ALGORITHM_ROOT"] = str(algorithm_root)
            environment["CT_OTHER_ALGORITHM_ROOT"] = str(algorithm_root / "other_alg")
            completed = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    textwrap.dedent(
                        f"""
                        import sys
                        from pathlib import Path

                        sys.path.insert(0, {str(external_root)!r})
                        import src
                        assert Path(src.__file__).resolve().is_relative_to(
                            Path({str(external_root)!r}).resolve()
                        )

                        import realtime_scheduler.server as server
                        assert server.BUILTIN_ALGORITHM_AVAILABLE is True
                        assert server.BUILTIN_ALGORITHM_IMPORT_ERROR == ""
                        assert Path(server.builtin_algorithm_api.__file__).resolve() == (
                            Path({str(source_root)!r}) / "api.py"
                        ).resolve()
                        """
                    ),
                ],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        self.assertEqual(
            0,
            completed.returncode,
            completed.stdout + completed.stderr,
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

    def test_discovers_and_runs_src_layout_algorithm(self) -> None:
        """公司端 ``src/infer/scheduler.py`` 布局可被自动发现并调用。

        入口转发文件按真实算法惯例先尝试绝对导入 ``src.infer.function``，
        再回退到相对导入 ``.function``；两种写法都必须在平台下可用。
        """
        with tempfile.TemporaryDirectory() as temporary_directory:
            packaged_root = Path(temporary_directory) / "other_alg"
            algorithm_root = packaged_root / "SrcAlgo"
            src_infer = algorithm_root / "src" / "infer"
            src_infer.mkdir(parents=True)
            (algorithm_root / "src" / "__init__.py").write_text("", encoding="utf-8")
            (algorithm_root / "src" / "infer" / "__init__.py").write_text(
                "", encoding="utf-8"
            )
            (src_infer / "function.py").write_text(
                "def init_framework(topo_data):\n    return None\n"
                "def update_framework(tool_json):\n"
                "    return '{\"MoveList\": [], \"Feedback\": []}'\n",
                encoding="utf-8",
            )
            (src_infer / "scheduler.py").write_text(
                "try:\n"
                "    from src.infer.function import init_framework, update_framework\n"
                "except ModuleNotFoundError:\n"
                "    from .function import init_framework, update_framework\n"
                "def init(topo_data):\n    return init_framework(topo_data)\n"
                "def update(tool_json):\n    return update_framework(tool_json)\n",
                encoding="utf-8",
            )
            completed = self._run_isolated_server_script(
                """
                import sys
                import realtime_scheduler.server as server
                from realtime_scheduler.algorithm_interface import (
                    init,
                    session,
                    update,
                )

                algorithms = server.discover_other_algorithms()
                assert [item["id"] for item in algorithms] == ["SrcAlgo"]
                assert algorithms[0]["entry"] == "src/infer/scheduler.py"
                with session("srcalgo"):
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

    def test_src_layout_algorithm_coexists_with_platform_src_package(self) -> None:
        """平台已加载内置 src 包时，src 布局算法仍可加载且互不干扰。

        真实平台启动即 ``from src.compiler import …`` 占用顶层 ``src`` 包名
        （alg/src）；算法目录的 src/ 通过追加 ``src.__path__`` 参与解析，
        不能替换或删除平台 src 包对象。
        """
        with tempfile.TemporaryDirectory() as temporary_directory:
            packaged_root = Path(temporary_directory) / "other_alg"
            src_infer = packaged_root / "SrcAlgo" / "src" / "infer"
            src_infer.mkdir(parents=True)
            (packaged_root / "SrcAlgo" / "src" / "__init__.py").write_text(
                "", encoding="utf-8"
            )
            (packaged_root / "SrcAlgo" / "src" / "infer" / "__init__.py").write_text(
                "", encoding="utf-8"
            )
            (src_infer / "function.py").write_text(
                "def init_framework(topo_data):\n    return None\n"
                "def update_framework(tool_json):\n"
                "    return '{\"MoveList\": [], \"Feedback\": []}'\n",
                encoding="utf-8",
            )
            (src_infer / "scheduler.py").write_text(
                "from src.infer.function import init_framework, update_framework\n"
                "def init(topo_data):\n    return init_framework(topo_data)\n"
                "def update(tool_json):\n    return update_framework(tool_json)\n",
                encoding="utf-8",
            )
            plain_entry = packaged_root / "Plain" / "infer" / "scheduler.py"
            plain_entry.parent.mkdir(parents=True)
            plain_entry.write_text(
                "def init(payload):\n    return None\n"
                "def update(payload):\n"
                "    return '{\"MoveList\": []}'\n",
                encoding="utf-8",
            )
            completed = self._run_isolated_server_script(
                """
                import os
                import sys
                import tempfile
                import types
                from pathlib import Path

                # 模拟平台内置算法：启动即占用顶层 src 包（alg/src）。
                with tempfile.TemporaryDirectory() as fake_alg_text:
                    fake_src = Path(fake_alg_text) / "src"
                    fake_src.mkdir()
                    (fake_src / "__init__.py").write_text("", encoding="utf-8")
                    platform_src = types.ModuleType("src")
                    platform_src.__package__ = "src"
                    platform_src.__file__ = str(fake_src / "__init__.py")
                    platform_src.__path__ = [str(fake_src)]
                    sys.modules["src"] = platform_src

                    from realtime_scheduler.algorithm_interface import (
                        init,
                        session,
                        update,
                    )

                    with session("srcalgo"):
                        init({})
                        output = update({})
                    assert output["MoveList"] == []
                    # 平台 src 包对象与原始路径条目必须保留。
                    assert sys.modules["src"] is platform_src
                    algorithm_src_text = str(
                        Path(os.environ["CT_OTHER_ALGORITHM_ROOT"])
                        / "SrcAlgo" / "src"
                    )
                    assert algorithm_src_text in sys.modules["src"].__path__
                    assert str(fake_src) in sys.modules["src"].__path__

                    # 切换算法后，算法 src 目录条目被移除且平台包不受影响。
                    with session("plain"):
                        init({})
                    assert sys.modules["src"] is platform_src
                    assert algorithm_src_text not in sys.modules["src"].__path__
                    assert str(fake_src) in sys.modules["src"].__path__
                """,
                packaged_root=packaged_root,
            )
        self.assertEqual(
            0,
            completed.returncode,
            completed.stdout + completed.stderr,
        )

    def test_switching_away_from_src_layout_unloads_src_package(self) -> None:
        """从 src 布局算法切换到普通布局后，sys.modules 不留 src 残留。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            packaged_root = Path(temporary_directory) / "other_alg"
            src_infer = packaged_root / "SrcAlgo" / "src" / "infer"
            src_infer.mkdir(parents=True)
            (packaged_root / "SrcAlgo" / "src" / "__init__.py").write_text(
                "", encoding="utf-8"
            )
            (packaged_root / "SrcAlgo" / "src" / "infer" / "__init__.py").write_text(
                "", encoding="utf-8"
            )
            (src_infer / "function.py").write_text(
                "def init_framework(topo_data):\n    return None\n"
                "def update_framework(tool_json):\n"
                "    return '{\"MoveList\": []}'\n",
                encoding="utf-8",
            )
            (src_infer / "scheduler.py").write_text(
                "from src.infer.function import init_framework, update_framework\n"
                "def init(topo_data):\n    return init_framework(topo_data)\n"
                "def update(tool_json):\n    return update_framework(tool_json)\n",
                encoding="utf-8",
            )
            plain_entry = packaged_root / "Plain" / "infer" / "scheduler.py"
            plain_entry.parent.mkdir(parents=True)
            plain_entry.write_text(
                "def init(payload):\n    return None\n"
                "def update(payload):\n"
                "    return '{\"MoveList\": []}'\n",
                encoding="utf-8",
            )
            completed = self._run_isolated_server_script(
                """
                import sys
                from realtime_scheduler.algorithm_interface import (
                    init,
                    session,
                    update,
                )

                with session("srcalgo"):
                    init({})
                    update({})
                assert "src" in sys.modules and "src.infer" in sys.modules
                with session("plain"):
                    init({})
                    update({})
                assert "src" not in sys.modules
                assert "src.infer" not in sys.modules
                assert "src.infer.scheduler" not in sys.modules
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

    def test_packaged_runtime_keeps_completed_dummy_port_inventory(self) -> None:
        """轻量运行时只能卸载真实 LoadPort 成品，不能删除已回港 Dummy。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            packaged_root = Path(temporary_directory) / "other_alg"
            packaged_root.mkdir()
            completed = self._run_isolated_server_script(
                """
                import realtime_scheduler.server as server

                first_update = {
                    "CurrentTime": 0,
                    "Materials": [
                        {
                            "ID": 1,
                            "CurrentModuleName": "LP1",
                            "SlotID": 1,
                            "PJobName": "P1",
                            "SrcPortName": "LP1",
                        },
                        {
                            "ID": 100000,
                            "CurrentModuleName": "DummyPort",
                            "SlotID": 1,
                            "PJobName": "P1",
                            "SrcPortName": "DummyPort",
                            "AccessiblePM": ["PM1"],
                        },
                    ],
                    "ProcessJobs": [{"JobName": "P1", "MatList": [1]}],
                    "ControlJobs": [{
                        "TaskID": "C1",
                        "PJobNameList": ["P1"],
                        "MaterialCount": 1,
                    }],
                    "Routes": {},
                    "Robots": {},
                    "Stations": {
                        "LP1": {"Slots": [1]},
                        "DummyPort": {"Slots": [1]},
                    },
                }
                first_output = {
                    "MoveList": [
                        {
                            "MoveID": 1,
                            "MoveType": 9,
                            "MatIDList": [1],
                            "StartTime": 1,
                            "EndTime": 10,
                        },
                        {
                            "MoveID": 2,
                            "MoveType": 9,
                            "MatIDList": [100000],
                            "StartTime": 2,
                            "EndTime": 9,
                        },
                    ],
                    "Feedback": [],
                }
                runtime = server.PackagedAlgorithmRuntime(
                    first_update,
                    first_output,
                    skip_validation=True,
                )
                runtime.advance_to(20)

                released_ids, empty_ports = runtime.release_completed_load_ports(
                    ["LP1"]
                )

                assert released_ids == {1}
                assert empty_ports == {"LP1"}
                assert [
                    material["ID"] for material in runtime.current_update["Materials"]
                ] == [100000]
                assert (
                    runtime.state.stations["DummyPort"].slots[1].material.material_id
                    == 100000
                )
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
