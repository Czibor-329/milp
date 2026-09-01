"""批量 HongYe 校验闸门的线程与跨进程回归测试。"""

from __future__ import annotations

import multiprocessing

from realtime_scheduler.backend.execution.validation_limiter import (
    BatchValidationLimiter,
)


def _use_shared_semaphore(semaphore, result_queue) -> None:
    """在 spawn 子进程中获取并释放 Manager 信号量。"""
    semaphore.acquire()
    try:
        result_queue.put("entered")
    finally:
        semaphore.release()


def test_process_shared_limiter_can_be_used_by_spawn_worker() -> None:
    """进程隔离批量必须能把同一校验配额传给 Windows spawn worker。"""
    context = multiprocessing.get_context("spawn")
    limiter = BatchValidationLimiter(2, process_shared=True)
    result_queue = context.Queue()
    process = context.Process(
        target=_use_shared_semaphore,
        args=(limiter.semaphore, result_queue),
    )
    try:
        process.start()
        process.join(timeout=10)
        assert process.exitcode == 0
        assert result_queue.get(timeout=1) == "entered"
    finally:
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)
        result_queue.close()
        limiter.close()


def test_validation_limiter_clamps_to_fifteen_workers() -> None:
    """即使调用方传入更大数值，HongYe 同时运行数也不得超过十五。"""
    limiter = BatchValidationLimiter(99, process_shared=False)
    try:
        assert limiter.maximum_workers == 15
    finally:
        limiter.close()
