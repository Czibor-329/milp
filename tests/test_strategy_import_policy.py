"""外部策略仅允许通过 ``alg/other_alg`` 目录自动发现的边界测试。"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from unittest.mock import patch

import realtime_scheduler.backend.algorithms.interface as algorithm_interface
import realtime_scheduler.server as config_server


class StrategyImportPolicyTests(unittest.TestCase):
    """确保目录扫描是外部策略进入平台的唯一方式。"""

    def test_discovery_only_reads_algorithm_directories(self) -> None:
        """根目录中的单文件不应被当作策略，合法子目录应正常发现。"""
        with tempfile.TemporaryDirectory() as temporary_directory:
            other_algorithm_root = Path(temporary_directory) / "other_alg"
            entry_directory = other_algorithm_root / "directory-alg" / "infer"
            entry_directory.mkdir(parents=True)
            (entry_directory / "scheduler.py").write_text(
                "def init(data):\n    return None\n"
                "def update(data):\n    return {'MoveList': []}\n",
                encoding="utf-8",
            )
            (other_algorithm_root / "uploaded.py").write_text(
                "def init(data):\n    return None\n"
                "def update(data):\n    return {'MoveList': []}\n",
                encoding="utf-8",
            )
            with patch.object(
                algorithm_interface, "OTHER_ALGORITHM_ROOT", other_algorithm_root
            ):
                discovered = algorithm_interface.discover_other_algorithms()

        self.assertEqual([item["id"] for item in discovered], ["directory-alg"])

    def test_register_endpoint_is_not_available(self) -> None:
        """旧的前端直传接口必须返回 404，且不能重新登记算法。"""
        http_server = ThreadingHTTPServer(
            ("127.0.0.1", 0), config_server.ConfigEditorHandler
        )
        server_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
        server_thread.start()
        self.addCleanup(http_server.server_close)
        self.addCleanup(server_thread.join, 5)
        self.addCleanup(http_server.shutdown)

        request = Request(
            f"http://127.0.0.1:{http_server.server_address[1]}/api/algorithms/register",
            data=json.dumps({"filename": "uploaded.py", "content": "ignored"}).encode(
                "utf-8"
            ),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as caught:
            build_opener(ProxyHandler({})).open(request, timeout=5)
        self.assertEqual(caught.exception.code, 404)

    def test_frontend_has_no_direct_import_control(self) -> None:
        """页面骨架和源码均不得暴露上传算法文件的入口。"""
        frontend_root = Path(config_server.FRONTEND_DIR)
        template = (frontend_root / "config_editor.html").read_text(encoding="utf-8")
        source = (frontend_root / "src" / "config_editor.ts").read_text(
            encoding="utf-8"
        )
        built_script = (frontend_root / "assets" / "config_editor.js").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("addAlgorithmButton", template)
        self.assertNotIn("/api/algorithms/register", source)
        self.assertNotIn("/api/algorithms/register", built_script)


if __name__ == "__main__":
    unittest.main()
