"""批量运行的 HongYe 校验并发资源控制。

本模块只负责创建和释放校验并发闸门。线程批量使用进程内信号量；启用算法
进程隔离时使用 ``multiprocessing.Manager`` 代理，使所有算法 worker 共享同一
配额。具体校验规则仍由 ``execution.service`` 和 ``validation.hongye`` 负责。
"""

from __future__ import annotations

import multiprocessing
import threading
from multiprocessing.managers import SyncManager
from typing import Any, Optional


DEFAULT_VALIDATION_WORKERS = 2
MAXIMUM_VALIDATION_WORKERS = 15


class BatchValidationLimiter:
    """持有一次批量运行的 HongYe 校验并发闸门及其进程管理器。

    参数：
        maximum_workers: 允许同时进入 HongYe 校验段的最大任务数。
        process_shared: 是否创建可跨 ``spawn`` 子进程传递的信号量代理。

    ``semaphore`` 可直接传给算法 worker；调用方必须在批量执行结束后调用
    ``close``，以释放进程共享模式创建的 Manager 子进程。
    """

    def __init__(self, maximum_workers: int, *, process_shared: bool) -> None:
        self.maximum_workers = max(
            1,
            min(int(maximum_workers), MAXIMUM_VALIDATION_WORKERS),
        )
        self._manager: Optional[SyncManager] = None
        if process_shared:
            context = multiprocessing.get_context("spawn")
            self._manager = context.Manager()
            self.semaphore: Any = self._manager.BoundedSemaphore(self.maximum_workers)
        else:
            self.semaphore = threading.BoundedSemaphore(self.maximum_workers)

    def close(self) -> None:
        """释放进程共享闸门的 Manager；线程模式无需额外处理。"""
        if self._manager is not None:
            self._manager.shutdown()
            self._manager = None
