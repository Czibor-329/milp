"""timing 包内公共常量与异常，供各子模块复用（避免循环 import）。"""

from __future__ import annotations

EPS = 1e-9
SKIP_TYPES = {"loadport", "buffer", "dummyport"}


class _DecodeDeadlock(Exception):
    """快速解码(banker=False)中途无可动 hop = 该 genome 的占用序死锁。搜索里判负、跳过。"""
