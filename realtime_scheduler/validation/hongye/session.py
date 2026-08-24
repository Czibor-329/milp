"""管理 HongYe 校验器的逐事件进程会话。

每次调度运行创建一个会话，把 AlgInit、AlgSchedule、AlgUpdateMove 和 AlgOutput
依次写入校验器标准输入。校验器只在收到 AlgOutput 时回放当前事件前缀并返回
结构化结果，因此不需要生成中间日志文件，也不会在并发批量运行间共享状态。
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any, Mapping, Optional


RUNTIME_DIR = Path(__file__).resolve().parent / "runtime"
VALIDATOR_EXE = RUNTIME_DIR / "HongYeValidator.exe"
PROCESS_SHUTDOWN_TIMEOUT_SECONDS = 2.0


class HongYeValidatorError(RuntimeError):
    """表示 HongYe 进程不可用、协议失败或内部回放异常。"""


class HongYeValidationSession:
    """持有一次调度运行对应的 HongYe 增量校验进程。"""

    def __init__(self, executable: Optional[Path] = None) -> None:
        """启动校验器；可通过 ``executable`` 注入测试用可执行文件。"""
        self._executable = Path(executable or VALIDATOR_EXE)
        if not self._executable.is_file():
            raise HongYeValidatorError(
                f"HongYe 校验器不存在：{self._executable}"
            )
        self._process = subprocess.Popen(
            [str(self._executable)],
            cwd=str(self._executable.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self._closed = False

    def add_event(self, event: Mapping[str, Any]) -> Optional[dict[str, Any]]:
        """发送一条标准日志事件；AlgOutput 返回校验摘要，其余事件返回 ``None``。"""
        if self._closed or self._process.poll() is not None:
            raise HongYeValidatorError(self._process_failure_message())
        if self._process.stdin is None or self._process.stdout is None:
            raise HongYeValidatorError("HongYe 校验器管道未建立")
        request = {"command": "event", "event": dict(event)}
        try:
            self._process.stdin.write(
                json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n"
            )
            self._process.stdin.flush()
            response_line = self._process.stdout.readline()
        except (BrokenPipeError, OSError) as error:
            raise HongYeValidatorError(self._process_failure_message()) from error
        if not response_line:
            raise HongYeValidatorError(self._process_failure_message())
        try:
            response = json.loads(response_line)
        except json.JSONDecodeError as error:
            raise HongYeValidatorError(
                f"HongYe 校验器返回了无效 JSON：{response_line[:240]}"
            ) from error
        if not isinstance(response, dict) or not response.get("ok"):
            message = (
                str(response.get("error") or "HongYe 校验器执行失败")
                if isinstance(response, dict)
                else "HongYe 校验器返回格式错误"
            )
            raise HongYeValidatorError(message)
        validation = response.get("validation")
        return dict(validation) if isinstance(validation, dict) else None

    def close(self) -> None:
        """正常结束子进程；异常退出时确保不会遗留校验进程。"""
        if self._closed:
            return
        self._closed = True
        process = self._process
        if process.poll() is None and process.stdin is not None:
            try:
                process.stdin.write('{"command":"close"}\n')
                process.stdin.flush()
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        try:
            process.wait(timeout=PROCESS_SHUTDOWN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    def _process_failure_message(self) -> str:
        """组合退出码与标准错误，生成可用于 API 的诊断信息。"""
        exit_code = self._process.poll()
        stderr_text = ""
        if exit_code is not None and self._process.stderr is not None:
            try:
                stderr_text = self._process.stderr.read().strip()
            except OSError:
                stderr_text = ""
        suffix = f"：{stderr_text[-500:]}" if stderr_text else ""
        return f"HongYe 校验器已退出（code={exit_code}）{suffix}"

    def __enter__(self) -> "HongYeValidationSession":
        """返回当前会话，供调度执行边界使用。"""
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        """离开调度执行边界时释放子进程。"""
        self.close()
