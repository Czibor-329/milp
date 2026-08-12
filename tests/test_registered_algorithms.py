"""“添加算法”登记功能测试：单文件 init/update 的校验、持久化、发现与调用。

覆盖 `realtime_scheduler/algorithm_interface.py` 的登记与加载，以及
`server.py` 的 `POST /api/algorithms/register` 端点。登记写入的 data
目录在测试中被替换为临时目录，避免污染真实运行数据。
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener
from unittest.mock import patch

import realtime_scheduler.algorithm_interface as algorithm_interface
import realtime_scheduler.server as config_server

SAMPLE_SOURCE = (
    "def init(topo_data_json):\n"
    "    return None\n"
    "def update(tool_json, algorithm=None):\n"
    "    return '{\"MoveList\": [], \"Feedback\": []}'\n"
)


class RegisteredAlgorithmStoreTestCase(unittest.TestCase):
    """把登记存储目录替换为临时目录的公共基类。"""

    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self._root = Path(self._temporary_directory.name)
        data_directory = self._root / "data"
        self._patch_registry_file = patch.object(
            algorithm_interface,
            "REGISTERED_ALGORITHMS_FILE",
            data_directory / "registered_algorithms.json",
        )
        self._patch_registry_dir = patch.object(
            algorithm_interface,
            "REGISTERED_ALGORITHMS_DIR",
            data_directory / "registered_algorithms",
        )
        self._patch_registry_file.start()
        self._patch_registry_dir.start()
        self.addCleanup(self._patch_registry_file.stop)
        self.addCleanup(self._patch_registry_dir.stop)
        self.addCleanup(self._temporary_directory.cleanup)


class RegisteredAlgorithmValidationTests(unittest.TestCase):
    """覆盖 init/update 顶层函数定义与语法校验。"""

    def test_requires_init_and_update_at_top_level(self) -> None:
        """缺少 init 或 update 时必须拒绝登记。"""
        cases = (
            ("def update(x):\n    return None\n", "init"),
            ("def init(x):\n    return None\n", "update"),
            ("def other(x):\n    return None\n", "init、update"),
        )
        for source, missing in cases:
            with self.assertRaises(ValueError) as caught:
                algorithm_interface.validate_algorithm_source(source)
            self.assertIn(missing, str(caught.exception))

    def test_rejects_syntax_errors(self) -> None:
        """语法错误的源码必须被拒绝。"""
        with self.assertRaises(ValueError):
            algorithm_interface.validate_algorithm_source("def init(:\n")

    def test_accepts_valid_source(self) -> None:
        """顶层包含 init 与 update 的源码可以通过校验。"""
        algorithm_interface.validate_algorithm_source(SAMPLE_SOURCE)


class RegisteredAlgorithmStoreTests(RegisteredAlgorithmStoreTestCase):
    """覆盖登记持久化、稳定 ID 与动态发现。"""

    def test_register_persists_source_and_registry(self) -> None:
        """登记后源文件与登记清单都永久写入 data 目录。"""
        item = algorithm_interface.register_algorithm(
            SAMPLE_SOURCE.encode("utf-8"),
            "my_alg.py",
            "My Algo",
        )
        self.assertEqual(item["id"], "my-algo")
        self.assertEqual(item["strategy"], "other_alg:my-algo")
        self.assertEqual(item["entryType"], "file")
        self.assertEqual(item["name"], "My Algo")
        registry_path = self._root / "data" / "registered_algorithms.json"
        self.assertTrue(registry_path.is_file())
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        self.assertEqual(len(registry["algorithms"]), 1)
        self.assertEqual(registry["algorithms"][0]["id"], "my-algo")
        stored_module = self._root / "data" / registry["algorithms"][0]["modulePath"]
        self.assertTrue(stored_module.is_file())
        self.assertEqual(stored_module.read_text(encoding="utf-8"), SAMPLE_SOURCE)

    def test_register_rejects_empty_or_wrong_extension(self) -> None:
        """空文件与非 .py 文件必须被拒绝。"""
        with self.assertRaises(ValueError):
            algorithm_interface.register_algorithm(b"", "empty.py", None)
        with self.assertRaises(ValueError):
            algorithm_interface.register_algorithm(
                SAMPLE_SOURCE.encode("utf-8"), "scheduler.txt", None
            )

    def test_register_id_conflict_gets_suffix(self) -> None:
        """同显示名重复登记时自动追加序号，避免覆盖已有算法。"""
        first = algorithm_interface.register_algorithm(
            SAMPLE_SOURCE.encode("utf-8"), "a.py", "demo"
        )
        second = algorithm_interface.register_algorithm(
            SAMPLE_SOURCE.encode("utf-8"), "b.py", "demo"
        )
        self.assertEqual(first["id"], "demo")
        self.assertEqual(second["id"], "demo-2")

    def test_register_avoids_collision_with_directory_algorithm(self) -> None:
        """登记 id 与 other_alg 目录式算法冲突时自动加后缀。"""
        with patch.object(
            algorithm_interface,
            "OTHER_ALGORITHM_ROOT",
            self._root / "other_alg",
        ):
            directory_root = self._root / "other_alg" / "demo" / "infer"
            directory_root.mkdir(parents=True)
            (directory_root / "scheduler.py").write_text(SAMPLE_SOURCE, encoding="utf-8")
            item = algorithm_interface.register_algorithm(
                SAMPLE_SOURCE.encode("utf-8"), "a.py", "demo"
            )
            self.assertEqual(item["id"], "demo-2")
            ids = {
                str(entry["id"])
                for entry in algorithm_interface.discover_other_algorithms()
            }
            self.assertIn("demo", ids)
            self.assertIn("demo-2", ids)

    def test_discover_includes_registered_algorithm(self) -> None:
        """登记算法出现在动态发现结果中，源文件删除后不再出现。"""
        item = algorithm_interface.register_algorithm(
            SAMPLE_SOURCE.encode("utf-8"), "scheduler.py", None
        )
        discovered = {
            str(entry["id"]): entry
            for entry in algorithm_interface.discover_other_algorithms()
        }
        self.assertIn(item["id"], discovered)
        self.assertEqual(discovered[item["id"]]["entryType"], "file")
        Path(item["path"]).unlink()
        discovered = {
            str(entry["id"]): entry
            for entry in algorithm_interface.discover_other_algorithms()
        }
        self.assertNotIn(item["id"], discovered)


class RegisteredAlgorithmExecutionTests(RegisteredAlgorithmStoreTestCase):
    """覆盖通过 session/init/update 实际调用登记的单文件算法。"""

    def test_init_update_run_registered_file_algorithm(self) -> None:
        """单文件算法通过标准调用链执行 init 与 update（dict 输出）。"""
        source = (
            "def init(topo_data_json):\n"
            "    return None\n"
            "def update(tool_json, algorithm=None):\n"
            "    return {'MoveList': [], 'Feedback': [], 'Algorithm': 'file-alg'}\n"
        )
        item = algorithm_interface.register_algorithm(
            source.encode("utf-8"), "file_alg.py", "文件算法"
        )
        with algorithm_interface.session(item["id"]):
            algorithm_interface.init({"Device": "topo"})
            output = algorithm_interface.update({"CurrentTime": 0})
        self.assertEqual(output["MoveList"], [])
        self.assertEqual(output["Algorithm"], "file-alg")

    def test_update_accepts_json_string_output(self) -> None:
        """登记算法也可以像目录算法一样返回 JSON 字符串。"""
        source = (
            "def init(topo_data_json):\n"
            "    return None\n"
            "def update(tool_json, algorithm=None):\n"
            "    import json\n"
            "    return json.dumps({'MoveList': [], 'Feedback': []})\n"
        )
        item = algorithm_interface.register_algorithm(
            source.encode("utf-8"), "json_alg.py", None
        )
        with algorithm_interface.session(item["id"]):
            algorithm_interface.init({})
            output = algorithm_interface.update({})
        self.assertEqual(output, {"MoveList": [], "Feedback": []})

    def test_rejects_import_failure_at_runtime(self) -> None:
        """登记时不执行源码；导入失败的算法在调用时给出明确错误。"""
        source = (
            "import not_a_real_dependency_xyz\n"
            "def init(topo_data_json):\n"
            "    return None\n"
            "def update(tool_json, algorithm=None):\n"
            "    return {}\n"
        )
        item = algorithm_interface.register_algorithm(
            source.encode("utf-8"), "broken_alg.py", None
        )
        with algorithm_interface.session(item["id"]):
            with self.assertRaises(RuntimeError) as caught:
                algorithm_interface.init({})
        self.assertIn("导入失败", str(caught.exception))

    def test_same_directory_dependency_is_unloaded_on_switch(self) -> None:
        """切换登记算法后，上一算法的同目录依赖模块必须从 sys.modules 卸载。"""
        first_source = (
            "import helper\n"
            "def init(topo_data_json):\n"
            "    return None\n"
            "def update(tool_json, algorithm=None):\n"
            "    return {'MoveList': [], 'Feedback': [], 'Value': helper.VALUE}\n"
        )
        first = algorithm_interface.register_algorithm(
            first_source.encode("utf-8"), "first_alg.py", "first"
        )
        helper_path = Path(first["path"]).parent / "helper.py"
        helper_path.write_text("VALUE = 1\n", encoding="utf-8")
        second = algorithm_interface.register_algorithm(
            "def init(topo_data_json):\n    return None\n"
            "def update(tool_json, algorithm=None):\n    return {'MoveList': []}\n".encode(
                "utf-8"
            ),
            "second_alg.py",
            "second",
        )
        with algorithm_interface.session(first["id"]):
            algorithm_interface.init({})
            output = algorithm_interface.update({})
        self.assertEqual(output["Value"], 1)
        self.assertIn("helper", sys.modules)
        with algorithm_interface.session(second["id"]):
            algorithm_interface.init({})
            algorithm_interface.update({})
        self.assertNotIn("helper", sys.modules)


class RegisteredAlgorithmHttpTests(RegisteredAlgorithmStoreTestCase):
    """覆盖 POST /api/algorithms/register 端点的请求处理。"""

    def setUp(self) -> None:
        super().setUp()
        self._http_server: ThreadingHTTPServer | None = None
        self._server_thread: threading.Thread | None = None

    def tearDown(self) -> None:
        if self._http_server is not None:
            self._http_server.shutdown()
            self._http_server.server_close()
            self._server_thread.join(timeout=5)
        super().tearDown()

    def _start_server(self) -> int:
        """启动本地测试服务器并返回端口号。"""
        self._http_server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            config_server.ConfigEditorHandler,
        )
        self._server_thread = threading.Thread(
            target=self._http_server.serve_forever,
            daemon=True,
        )
        self._server_thread.start()
        return self._http_server.server_address[1]

    def _post_register(self, port: int, payload: dict) -> dict:
        request = Request(
            f"http://127.0.0.1:{port}/api/algorithms/register",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        opener = build_opener(ProxyHandler({}))
        with opener.open(request, timeout=10) as response:
            return json.load(response)

    def _register_payload(self, filename: str, source: str) -> dict:
        """构造一个 base64 编码的登记请求体。"""
        return {
            "filename": filename,
            "content": base64.b64encode(source.encode("utf-8")).decode("ascii"),
        }

    def test_register_endpoint_persists_and_appears_in_health(self) -> None:
        """HTTP 登记成功后，健康检查的策略列表立即包含新算法。"""
        with patch.object(config_server, "AUTH_REQUIRED", False):
            port = self._start_server()
            payload = self._register_payload("http_alg.py", SAMPLE_SOURCE)
            payload["name"] = "HTTP Algo"
            result = self._post_register(port, payload)
            self.assertTrue(result["ok"])
            self.assertEqual(result["algorithm"]["id"], "http-algo")
            self.assertEqual(result["algorithm"]["strategy"], "other_alg:http-algo")
            health_opener = build_opener(ProxyHandler({}))
            with health_opener.open(
                f"http://127.0.0.1:{port}/api/health", timeout=5
            ) as response:
                health = json.load(response)
            strategies = {str(item["strategy"]) for item in health["algorithms"]}
            self.assertIn("other_alg:http-algo", strategies)

    def test_register_endpoint_rejects_invalid_source(self) -> None:
        """缺少 init/update 的文件经 HTTP 登记时返回 400。"""
        with patch.object(config_server, "AUTH_REQUIRED", False):
            port = self._start_server()
            payload = self._register_payload("bad_alg.py", "def only(x):\n    return x\n")
            with self.assertRaises(HTTPError) as caught:
                self._post_register(port, payload)
            self.assertEqual(caught.exception.code, 400)

    def test_register_endpoint_rejects_invalid_base64(self) -> None:
        """非法的 base64 内容经 HTTP 登记时返回 400。"""
        with patch.object(config_server, "AUTH_REQUIRED", False):
            port = self._start_server()
            payload = {"filename": "broken_alg.py", "content": "!!!not-base64!!!"}
            with self.assertRaises(HTTPError) as caught:
                self._post_register(port, payload)
            self.assertEqual(caught.exception.code, 400)

    def test_register_endpoint_requires_login(self) -> None:
        """强制登录且未登录时登记请求返回 401。"""
        with patch.object(config_server, "AUTH_REQUIRED", True):
            port = self._start_server()
            payload = self._register_payload("x.py", SAMPLE_SOURCE)
            with self.assertRaises(HTTPError) as caught:
                self._post_register(port, payload)
            self.assertEqual(caught.exception.code, 401)

    def test_register_endpoint_requires_admin_role(self) -> None:
        """非管理员调用登记接口时返回 403。"""
        with patch.object(config_server, "AUTH_REQUIRED", False), patch.object(
            config_server.ConfigEditorHandler,
            "_require_admin",
            return_value=None,
        ):
            port = self._start_server()
            payload = self._register_payload("x.py", SAMPLE_SOURCE)
            with self.assertRaises(HTTPError) as caught:
                self._post_register(port, payload)
            self.assertEqual(caught.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
