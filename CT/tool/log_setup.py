"""集中式 logger 配置。

scheduler 链路被 C# 宿主通过 pythonnet 调用时不在终端运行，print(...) 看不到，
异常的 Python 端 traceback 也会丢失。本模块把日志同时落地到 **文件 + 控制台**：

    from CT.infer.log_setup import get_logger
    log = get_logger(__name__)

- 文件：results/logs/scheduler.log（RotatingFileHandler，utf-8，含中文不乱码）。
- 控制台：StreamHandler，run_once 在终端跑时仍可见。

配置是惰性且幂等的：pythonnet 可能多次 import 本包，handler 只会挂一次，
不会出现重复日志行。日志级别默认 INFO，可用环境变量 SCHED_LOG_LEVEL 调高到 DEBUG。
"""

from __future__ import annotations

import logging
import logging.handlers
import os

from CT.config.paths import log_path

# 整个 infer 包共享的父 logger 名；各子模块用 get_logger(__name__) 取到其子 logger。
_ROOT_LOGGER_NAME = "infer"
_CONFIGURED = False

_FILE_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
_FILE_BACKUP_COUNT = 5
# ANSI 颜色代码
_COLORS = {
    "DEBUG": "\033[90m",     # 灰色 - 调试信息，低调
    "INFO": "\033[32m",      # 绿色 - 正常信息
    "WARNING": "\033[33m",   # 黄色 - 警告
    "ERROR": "\033[31m",     # 红色 - 错误
    "CRITICAL": "\033[1;31m" # 粗体红色 - 严重错误
}
_RESET = "\033[0m"

# 控制台：精简格式，通过颜色区分层级
_CONSOLE_FORMAT = "%(levelname)-8s %(message)s"

# 文件：保留完整信息便于排查
_FILE_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"


class _ColoredFormatter(logging.Formatter):
    """为不同日志级别添加 ANSI 颜色。"""

    def format(self, record: logging.LogRecord) -> str:
        color = _COLORS.get(record.levelname, "")
        # 先调用父类 format 得到完整字符串，再给 levelname 上色
        original_levelname = record.levelname
        record.levelname = f"{color}{record.levelname}{_RESET}"
        result = super().format(record)
        record.levelname = original_levelname
        return result


def _resolve_level() -> int:
    raw = os.environ.get("SCHED_LOG_LEVEL", "INFO").strip().upper()
    return getattr(logging, raw, logging.INFO)


def _configure_root() -> logging.Logger:
    """惰性、幂等地配置 infer 包级 logger。"""
    global _CONFIGURED
    root = logging.getLogger(_ROOT_LOGGER_NAME)
    if _CONFIGURED or root.handlers:
        return root

    level = _resolve_level()
    root.setLevel(level)
    root.propagate = False  # 避免与 Python 根 logger 重复输出

    console_fmt = _ColoredFormatter(_CONSOLE_FORMAT)
    file_fmt = logging.Formatter(_FILE_FORMAT)

    # 文件 handler：失败（如目录不可写）也不能让算法挂掉，降级为仅控制台。
    try:
        file_handler = logging.handlers.RotatingFileHandler(
            log_path("scheduler.log"),
            maxBytes=_FILE_MAX_BYTES,
            backupCount=_FILE_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setFormatter(file_fmt)
        file_handler.setLevel(level)
        root.addHandler(file_handler)
    except Exception:  # noqa: BLE001 - 日志初始化不应阻断主流程
        logging.getLogger(__name__).warning("文件日志初始化失败，仅使用控制台", exc_info=True)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(console_fmt)
    stream_handler.setLevel(level)
    root.addHandler(stream_handler)

    _CONFIGURED = True
    return root


def get_logger(name: str) -> logging.Logger:
    """返回已配置好的 logger（infer 包级父 logger 的子 logger）。

    若 name 不在 infer 命名空间下（如 C# 部署把模块 import 为 src.hc_alg.scheduler），
    则挂到 infer.* 之下，保证继承到已配置的 handler。
    """
    _configure_root()
    if name == _ROOT_LOGGER_NAME or name.startswith(_ROOT_LOGGER_NAME + "."):
        return logging.getLogger(name)
    return logging.getLogger(f"{_ROOT_LOGGER_NAME}.{name}")
