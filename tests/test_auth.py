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

    def test_health_check_stays_open(self) -> None:
        """健康检查应保持无需登录，供监控探测。"""
        get_source = inspect.getsource(config_server.ConfigEditorHandler.do_GET)
        self.assertIn('path != "/api/health"', get_source)
