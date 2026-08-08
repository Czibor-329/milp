"""登录账号的本地文件存储与会话安全工具。

调度控制台对外提供网页服务后，任何能访问地址的人都能操作系统，
因此必须增加登录认证。本模块提供不依赖第三方库的认证基础能力：

- 账号保存在 data/users.json，密码使用 PBKDF2-HMAC-SHA256 加盐哈希存储，
  绝不保存明文；迭代次数取 OWASP 建议的 200_000。
- 会话由服务进程内存持有：登录成功后生成随机令牌（Cookie 值），
  校验时按令牌查会话并检查过期时间，重启服务即全部失效。
- 账号文件不存在时可通过 ensure_default_admin 自动创建默认管理员，
  方便首次部署；之后用 server.py 的命令行参数增删账号。

本模块只负责账号与会话，HTTP 路由与 Cookie 收发由 server.py 完成。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# PBKDF2 哈希参数：迭代次数越多越抗暴力破解，200_000 是常见建议下限。
PBKDF2_ITERATIONS = 200_000
HASH_ALGORITHM = "sha256"
SALT_BYTES = 16
# 账号文件相对 data 目录的文件名。
USER_FILE_NAME = "users.json"
# 首次部署自动创建的默认管理员账号，启动后应尽快修改密码。
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "admin123"
# 新账号密码的最短长度。
MIN_PASSWORD_LENGTH = 8
# 会话令牌的随机字节数与有效期（秒）。
SESSION_TOKEN_BYTES = 32
SESSION_TTL_SECONDS = 12 * 3600
# 会话 Cookie 的名称。
SESSION_COOKIE_NAME = "ct_session"


def hash_password(password: str, salt: str) -> str:
    """用给定盐对密码做 PBKDF2 哈希，返回十六进制摘要。

    盐以十六进制字符串传入，便于随账号一起存入 JSON 文件。
    """
    digest = hashlib.pbkdf2_hmac(
        HASH_ALGORITHM,
        password.encode("utf-8"),
        bytes.fromhex(salt),
        PBKDF2_ITERATIONS,
    )
    return digest.hex()


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    """常数时间比较密码与存储哈希，避免时序侧信道。"""
    actual = hash_password(password, salt)
    return hmac.compare_digest(actual, expected_hash)


def load_users(path: Path) -> Dict[str, Dict[str, Any]]:
    """从 JSON 文件加载账号表；文件缺失或损坏时返回空表。"""
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    users = payload.get("users") if isinstance(payload, dict) else None
    if not isinstance(users, dict):
        return {}
    return {
        str(name): record
        for name, record in users.items()
        if isinstance(record, dict) and record.get("passwordHash") and record.get("salt")
    }


def save_users(users: Dict[str, Dict[str, Any]], path: Path) -> None:
    """把账号表原子写入 JSON 文件，避免中途断电产生半截文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "users": users,
    }
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def add_user(username: str, password: str, path: Path) -> bool:
    """新增账号或重置已有账号密码，返回 True 表示新建、False 表示更新。

    密码在此处完成加盐哈希，盐为每次随机生成。
    """
    if not username or not password:
        raise ValueError("用户名和密码不能为空")
    users = load_users(path)
    created = username not in users
    salt = secrets.token_hex(SALT_BYTES)
    users[username] = {
        "passwordHash": hash_password(password, salt),
        "salt": salt,
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    save_users(users, path)
    return created


def remove_user(username: str, path: Path) -> bool:
    """删除账号，返回是否确实存在并被删除。"""
    users = load_users(path)
    if username not in users:
        return False
    del users[username]
    save_users(users, path)
    return True


def list_users(path: Path) -> List[str]:
    """返回全部用户名（不含任何密码信息），便于管理端展示。"""
    return sorted(load_users(path).keys())


def ensure_default_admin(path: Path) -> bool:
    """没有任何账号时创建默认管理员，返回 True 表示刚创建。

    首次部署后服务即可用默认账号登录；后续添加真实账号后建议删除它。
    """
    if load_users(path):
        return False
    add_user(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, path)
    return True


def verify_credentials(username: str, password: str, path: Path) -> bool:
    """校验用户名密码是否与账号文件匹配。"""
    users = load_users(path)
    record = users.get(username)
    if not record:
        # 执行一次等价的哈希计算，使耗时接近真实校验，降低用户名枚举风险。
        hash_password(password, secrets.token_hex(SALT_BYTES))
        return False
    return verify_password(
        password,
        str(record.get("salt") or ""),
        str(record.get("passwordHash") or ""),
    )


_SESSIONS: Dict[str, Dict[str, Any]] = {}
_SESSIONS_LOCK = threading.Lock()


def create_session(username: str) -> str:
    """为已通过认证的用户创建会话，返回令牌字符串。"""
    token = secrets.token_urlsafe(SESSION_TOKEN_BYTES)
    with _SESSIONS_LOCK:
        _purge_expired_sessions_locked()
        _SESSIONS[token] = {
            "username": username,
            "expiresAt": time.time() + SESSION_TTL_SECONDS,
        }
    return token


def get_session_username(token: Optional[str]) -> Optional[str]:
    """按令牌返回会话对应的用户名；无效或过期返回 None。"""
    if not token:
        return None
    with _SESSIONS_LOCK:
        record = _SESSIONS.get(token)
        if record is None:
            return None
        if time.time() >= float(record.get("expiresAt") or 0):
            del _SESSIONS[token]
            return None
        return str(record.get("username") or "")


def destroy_session(token: Optional[str]) -> None:
    """登出时删除指定会话。"""
    if not token:
        return
    with _SESSIONS_LOCK:
        _SESSIONS.pop(token, None)


def session_cookie(token: str) -> str:
    """生成会话 Cookie 的 Set-Cookie 响应头值。

    HttpOnly 防止脚本读取令牌，SameSite=Lax 阻止跨站表单携带 Cookie。
    """
    return (
        f"{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
        f"Max-Age={SESSION_TTL_SECONDS}"
    )


def _purge_expired_sessions_locked() -> None:
    """清理过期会话，调用方必须持有 _SESSIONS_LOCK。"""
    now = time.time()
    expired = [
        token
        for token, record in _SESSIONS.items()
        if now >= float(record.get("expiresAt") or 0)
    ]
    for token in expired:
        _SESSIONS.pop(token, None)
