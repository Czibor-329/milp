"""后端运行日志与 HTTP 访问日志配置。

运行阶段日志面向调度业务，统一输出启动、计划构建、Baseline、算法调用、校验
和完成状态；HTTP 访问日志默认关闭，避免浏览器轮询淹没业务信息。页面运行事件
仍由 server 的内存状态维护，本模块只负责把相同事件同步到终端。
"""

from __future__ import annotations

import logging
import sys
from typing import Any


LOGGER_NAME = "realtime_scheduler"
DEFAULT_LOG_LEVEL = "INFO"

logger = logging.getLogger(LOGGER_NAME)
_access_log_enabled = False


class _DynamicStdoutHandler(logging.StreamHandler):
    """每次输出时读取当前 stdout，兼容测试捕获和后台线程。"""

    def emit(self, record: logging.LogRecord) -> None:
        """避免长期持有已被测试框架关闭的临时输出流。"""
        self.stream = sys.stdout
        super().emit(record)


def configure_logging(level: str = DEFAULT_LOG_LEVEL, access_log: bool = False) -> None:
    """配置终端日志级别和 HTTP 访问日志开关。"""
    global _access_log_enabled
    normalized_level = str(level or DEFAULT_LOG_LEVEL).upper()
    numeric_level = getattr(logging, normalized_level, None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"不支持的日志级别：{level}")
    logger.setLevel(numeric_level)
    logger.handlers.clear()
    handler = _DynamicStdoutHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.propagate = False
    _access_log_enabled = bool(access_log)


def access_log_enabled() -> bool:
    """返回当前是否输出逐条 HTTP 访问日志。"""
    return _access_log_enabled


def log_http_access(message: str) -> None:
    """在启用访问日志时输出一条 HTTP 请求记录。"""
    if _access_log_enabled:
        logger.info("[HTTP] %s", message)


def log_startup(message: str) -> None:
    """输出服务启动和数据准备阶段信息。"""
    logger.info("[启动] %s", message)


def log_run_event(run_id: str, scope: str, label: str, status: str, detail: Any = "") -> None:
    """输出单测或 Baseline 的可读阶段事件。"""
    prefix = "Baseline" if scope == "baseline" else "运行"
    display_status = {
        "queued": "等待",
        "running": "开始",
        "succeeded": "完成",
        "completed": "完成",
        "failed": "失败",
        "cancelled": "取消",
    }.get(str(status), str(status))
    suffix = f"：{detail}" if detail else ""
    logger.info("[%s][%s] %s：%s%s", prefix, run_id or "-", label, display_status, suffix)


# 作为导入模块使用时也保持默认配置；服务启动参数会再次显式设置级别。
configure_logging()
