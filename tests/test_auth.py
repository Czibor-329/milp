"""登录认证模块与 HTTP 鉴权接入的单元测试。"""

from __future__ import annotations

import inspect
import json
import tempfile
import time
import unittest
from pathlib import Path

from realtime_scheduler import auth
import realtime_scheduler.server as config_server


class PasswordHashTests(unittest.TestCase):
    """密码加盐哈希的往返与一致性。"""

    def test_verify_password_matches_stored_hash(self) -> None:
        """正确密码应通过校验，错误密码应被拒绝。"""
        salt = auth.secrets.token_hex(auth.SALT_BYTES)
        password_hash = auth.hash_password("Secret-123", salt)
        self.assertTrue(auth.verify_password("Secret-123", salt, password_hash))
        self.assertFalse(auth.verify_password("wrong", salt, password_hash))

    def test_same_password_hashes_differ_with_different_salts(self) -> None:
        """不同盐下同一密码的哈希必须不同，防止撞库。"""
        salt_a = auth.secrets.token_hex(auth.SALT_BYTES)
        salt_b = auth.secrets.token_hex(auth.SALT_BYTES)
        self.assertNotEqual(
            auth.hash_password("Secret-123", salt_a),
            auth.hash_password("Secret-123", salt_b),
        )


class AccountStoreTests(unittest.TestCase):
    """账号文件的新增、更新、删除与默认管理员创建。"""

    def _temporary_store(self) -> Path:
        """返回一个空的临时账号文件路径。"""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return Path(temporary.name) / "users.json"

    def test_add_user_stores_only_hashed_password(self) -> None:
        """账号文件不得保存明文密码。"""
        store = self._temporary_store()
        auth.add_user("alice", "Alice-12345", store)
        raw = store.read_text(encoding="utf-8")
        self.assertNotIn("Alice-12345", raw)
        users = auth.load_users(store)
        self.assertIn("alice", users)
        self.assertIn("passwordHash", users["alice"])
        self.assertIn("salt", users["alice"])

    def test_add_user_returns_created_and_updates_existing(self) -> None:
        """同一用户名第二次添加应视为重置密码而非新建。"""
        store = self._temporary_store()
        self.assertTrue(auth.add_user("alice", "Alice-12345", store))
        self.assertFalse(auth.add_user("alice", "Alice-54321", store))
        self.assertTrue(
            auth.verify_credentials("alice", "Alice-54321", store)
        )
        self.assertFalse(
            auth.verify_credentials("alice", "Alice-12345", store)
        )

    def test_remove_user_and_list_users(self) -> None:
        """删除账号后列表不应再包含该用户名。"""
        store = self._temporary_store()
        auth.add_user("alice", "Alice-12345", store)
        auth.add_user("bob", "Bob-12345", store)
        self.assertEqual(["alice", "bob"], auth.list_users(store))
        self.assertTrue(auth.remove_user("alice", store))
        self.assertFalse(auth.remove_user("alice", store))
        self.assertEqual(["bob"], auth.list_users(store))

    def test_ensure_default_admin_creates_only_once(self) -> None:
        """首次创建默认管理员，已有账号后不再覆盖。"""
        store = self._temporary_store()
        self.assertTrue(auth.ensure_default_admin(store))
        self.assertFalse(auth.ensure_default_admin(store))
        self.assertTrue(
            auth.verify_credentials(
                auth.DEFAULT_ADMIN_USERNAME,
                auth.DEFAULT_ADMIN_PASSWORD,
                store,
            )
        )

    def test_corrupted_store_falls_back_to_empty(self) -> None:
        """损坏的账号文件不应导致服务崩溃，按空账号表处理。"""
        store = self._temporary_store()
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text("{not valid json", encoding="utf-8")
        self.assertEqual({}, auth.load_users(store))
        self.assertFalse(auth.verify_credentials("alice", "x", store))


class SessionTests(unittest.TestCase):
    """会话令牌的创建、校验、过期与销毁。"""

    def _expire_all_sessions(self) -> None:
        """把全部会话标记为已过期，便于测试清理逻辑。"""
        with auth._SESSIONS_LOCK:
            for record in auth._SESSIONS.values():
                record["expiresAt"] = time.time() - 1

    def test_session_round_trip(self) -> None:
        """创建会话后应能按令牌取回用户名。"""
        token = auth.create_session("alice")
        self.assertEqual("alice", auth.get_session_username(token))
        auth.destroy_session(token)
        self.assertIsNone(auth.get_session_username(token))

    def test_expired_session_is_rejected_and_cleaned(self) -> None:
        """过期会话应被拒绝并从内存清理。"""
        token = auth.create_session("alice")
        self._expire_all_sessions()
        self.assertIsNone(auth.get_session_username(token))
        with auth._SESSIONS_LOCK:
            self.assertNotIn(token, auth._SESSIONS)

    def test_destroy_user_sessions_revokes_all_sessions(self) -> None:
        """删除账号时应同时销毁该用户的所有会话。"""
        token_a = auth.create_session("alice")
        token_b = auth.create_session("alice")
        other = auth.create_session("bob")
        auth.destroy_user_sessions("alice")
        self.assertIsNone(auth.get_session_username(token_a))
        self.assertIsNone(auth.get_session_username(token_b))
        self.assertEqual("bob", auth.get_session_username(other))

    def test_cookie_header_value(self) -> None:
        """会话 Cookie 必须包含 HttpOnly 与 SameSite=Lax。"""
        cookie = auth.session_cookie("token123")
        self.assertIn("ct_session=token123", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)


class HttpAuthIntegrationTests(unittest.TestCase):
    """HTTP 处理器必须对所有页面与 API 强制登录（源码级回归断言）。"""

    def test_pages_redirect_to_login_when_anonymous(self) -> None:
        """未登录访问页面应转向 /login.html。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        self.assertIn('self._redirect("/login.html")', get_source)
        self.assertIn('self._current_username() is None', get_source)
        self.assertIn('"/login.html"', get_source)

    def test_api_returns_401_when_anonymous(self) -> None:
        """未登录调用业务 API 应返回 401，且 login/logout 不需要登录。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)
        put_source = inspect.getsource(config_server.ConfigEditorHandler.do_PUT)
        delete_source = inspect.getsource(config_server.ConfigEditorHandler.do_DELETE)
        self.assertIn("HTTPStatus.UNAUTHORIZED", get_source)
        self.assertIn("HTTPStatus.UNAUTHORIZED", post_source)
        self.assertIn("HTTPStatus.UNAUTHORIZED", put_source)
        self.assertIn("HTTPStatus.UNAUTHORIZED", delete_source)
        self.assertIn('path == "/api/login"', post_source)
        self.assertIn('path == "/api/logout"', post_source)

    def test_login_page_is_served_anonymously(self) -> None:
        """登录页本身不应要求登录。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        self.assertIn('if path == "/login.html":', get_source)
        self.assertTrue(config_server.LOGIN_PATH.is_file())

    def test_admin_users_page_is_login_protected_and_served(self) -> None:
        """用户管理页应在登录保护之列，且文件存在。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        self.assertIn('"/admin_users.html"', get_source)
        self.assertTrue(config_server.ADMIN_USERS_PATH.is_file())


class PermissionModelTests(unittest.TestCase):
    """用户角色与算法/设备权限的判定语义。"""

    def _temporary_store(self) -> Path:
        """返回一个空的临时账号文件路径。"""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return Path(temporary.name) / "users.json"

    def test_admin_sees_everything_while_user_is_restricted(self) -> None:
        """admin 的权限列表为 None（全部），普通用户按分配列表判定。"""
        store = self._temporary_store()
        auth.add_user(
            "boss", "Boss-12345", store, role=auth.ROLE_ADMIN,
            allowed_algorithms=["heuristic"], allowed_devices=["dev-a"],
        )
        auth.add_user(
            "worker", "Worker-12345", store, role=auth.ROLE_USER,
            allowed_algorithms=["heuristic"], allowed_devices=["dev-a"],
        )
        self.assertTrue(auth.is_admin("boss", store))
        self.assertFalse(auth.is_admin("worker", store))
        self.assertIsNone(auth.user_strategies("boss", store))
        self.assertIsNone(auth.user_devices("boss", store))
        self.assertEqual(["heuristic"], auth.user_strategies("worker", store))
        self.assertEqual(["dev-a"], auth.user_devices("worker", store))
        self.assertTrue(auth.user_allows_algorithm("boss", "other_alg:x", store))
        self.assertTrue(auth.user_allows_device("boss", "dev-b", store))
        self.assertTrue(auth.user_allows_algorithm("worker", "heuristic", store))
        self.assertFalse(auth.user_allows_algorithm("worker", "other_alg:x", store))
        self.assertFalse(auth.user_allows_device("worker", "dev-b", store))

    def test_legacy_account_without_role_defaults_to_admin(self) -> None:
        """升级前的旧账号缺少 role 字段时按管理员处理，保持兼容。"""
        store = self._temporary_store()
        auth.add_user("olduser", "Old-12345", store)
        raw = json.loads(store.read_text(encoding="utf-8"))
        del raw["users"]["olduser"]["role"]
        store.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        self.assertTrue(auth.is_admin("olduser", store))
        self.assertIsNone(auth.user_strategies("olduser", store))

    def test_user_with_empty_permissions_has_nothing(self) -> None:
        """权限为空的普通用户不允许任何算法与设备（fail-closed）。"""
        store = self._temporary_store()
        auth.add_user("worker", "Worker-12345", store, role=auth.ROLE_USER)
        self.assertEqual([], auth.user_strategies("worker", store))
        self.assertEqual([], auth.user_devices("worker", store))
        self.assertFalse(auth.user_allows_algorithm("worker", "heuristic", store))
        self.assertFalse(auth.user_allows_device("worker", "dev-a", store))

    def test_update_user_and_set_password_preserve_fields(self) -> None:
        """改权限与改密码应只影响对应字段，其他字段保留。"""
        store = self._temporary_store()
        auth.add_user(
            "worker", "Worker-12345", store, role=auth.ROLE_USER,
            allowed_algorithms=["heuristic"], allowed_devices=["dev-a"],
        )
        self.assertTrue(auth.update_user(
            "worker", store, role=auth.ROLE_USER,
            allowed_algorithms=["e2e-ctq"], allowed_devices=["dev-a", "dev-b"],
        ))
        self.assertEqual(
            ["e2e-ctq"], auth.user_strategies("worker", store)
        )
        self.assertEqual(
            ["dev-a", "dev-b"], auth.user_devices("worker", store)
        )
        self.assertTrue(auth.set_user_password("worker", "New-Pass-99", store))
        self.assertTrue(auth.verify_credentials("worker", "New-Pass-99", store))
        self.assertFalse(auth.verify_credentials("worker", "Worker-12345", store))
        self.assertEqual(
            ["e2e-ctq"], auth.user_strategies("worker", store)
        )
        self.assertFalse(auth.update_user("nobody", store, role=auth.ROLE_USER))
        self.assertFalse(auth.set_user_password("nobody", "New-Pass-99", store))

    def test_list_user_infos_exposes_no_secrets(self) -> None:
        """管理信息列表不得包含密码哈希或盐。"""
        store = self._temporary_store()
        auth.add_user(
            "worker", "Worker-12345", store, role=auth.ROLE_USER,
            allowed_algorithms=["heuristic"], allowed_devices=["dev-a"],
        )
        infos = auth.list_user_infos(store)
        self.assertEqual(1, len(infos))
        self.assertEqual("worker", infos[0]["username"])
        self.assertEqual(auth.ROLE_USER, infos[0]["role"])
        self.assertEqual(["heuristic"], infos[0]["allowedAlgorithms"])
        self.assertNotIn("passwordHash", infos[0])
        self.assertNotIn("salt", infos[0])

    def test_unknown_role_is_rejected(self) -> None:
        """未知角色应被拒绝，避免误写脏数据。"""
        store = self._temporary_store()
        with self.assertRaises(ValueError):
            auth.add_user("x", "X-12345", store, role="superuser")
        with self.assertRaises(ValueError):
            auth.update_user("x", store, role="superuser")


class HttpPermissionIntegrationTests(unittest.TestCase):
    """HTTP 层权限过滤与用户管理路由（源码级回归断言）。"""

    def test_session_and_admin_user_routes_exist(self) -> None:
        """/api/session 与 /api/admin/users 路由必须存在且仅管理员可用。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)
        put_source = inspect.getsource(config_server.ConfigEditorHandler.do_PUT)
        delete_source = inspect.getsource(config_server.ConfigEditorHandler.do_DELETE)
        self.assertIn('path == "/api/session"', get_source)
        self.assertIn('path == "/api/admin/users"', get_source)
        self.assertIn('path == "/api/admin/users"', post_source)
        self.assertIn('"api", "admin", "users"', put_source)
        self.assertIn('"api", "admin", "users"', delete_source)
        self.assertIn('"仅管理员可管理用户"', post_source + put_source + delete_source)

    def test_health_and_workspaces_are_filtered_by_permission(self) -> None:
        """健康检查与工作区列表必须按当前用户权限过滤。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        self.assertIn("user_strategies", get_source)
        self.assertIn("user_devices", get_source)
        self.assertIn('self._deny_device(parts[2])', get_source)

    def test_run_and_batch_validate_permissions(self) -> None:
        """运行接口必须校验设备与算法权限。"""
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)
        self.assertIn("self._deny_device(device_id)", post_source)
        self.assertIn("self._deny_strategy(strategy)", post_source)
        self.assertIn("设备不在当前账号权限内", post_source)
        self.assertIn("算法", post_source)

    def test_device_import_and_export_cleanup_are_admin_only(self) -> None:
        """导入/删除设备与清理导出数据必须仅管理员可操作。"""
        post_source = inspect.getsource(config_server.ConfigEditorHandler.do_POST)
        delete_source = inspect.getsource(config_server.ConfigEditorHandler.do_DELETE)
        self.assertIn("仅管理员可导入设备", post_source)
        self.assertIn("仅管理员可删除设备", delete_source)
        self.assertIn("仅管理员可清理导出数据", delete_source)

    def test_deleted_account_session_is_revoked(self) -> None:
        """删除账号必须销毁其会话，/api/session 不得再返回该用户信息。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        delete_source = inspect.getsource(config_server.ConfigEditorHandler.do_DELETE)
        self.assertIn("destroy_user_sessions", get_source)
        self.assertIn("destroy_user_sessions", delete_source)
        self.assertIn('"账号不存在或已删除"', get_source)

    def test_anonymous_health_hides_algorithm_catalog(self) -> None:
        """未登录的健康检查不应暴露算法清单（仅用于监控可用性）。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        self.assertIn("不暴露算法清单", get_source)

    def test_login_failure_is_delayed(self) -> None:
        """登录失败应有固定延迟以拖慢暴力破解。"""
        source = inspect.getsource(config_server.ConfigEditorHandler._handle_login)
        self.assertIn("LOGIN_FAILURE_DELAY", source)

    def test_health_check_stays_open(self) -> None:
        """健康检查应保持无需登录，供监控探测。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        self.assertIn('path != "/api/health"', get_source)
