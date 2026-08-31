"""通过原始 MoveStateSim 对完整调度日志执行 HongYe 校验。

本模块只负责文件协议边界：把一次运行的全部日志事件写入临时 JSON，调用
``MoveStateSim.exe`` 的 ``module-parallel`` 推进，再读取它生成的结构化结果。
校验进程不参与平台状态推进，也不维护跨请求会话。
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
from typing import Any, Mapping, Optional, Sequence


RUNTIME_DIR = Path(__file__).resolve().parent / "runtime"
VALIDATOR_EXE = RUNTIME_DIR / "MoveStateSim.exe"
VALIDATION_TIMEOUT_SECONDS = 300.0
WARNING_CODES = frozenset({
    "WARN",
    "LL.PRESSURE_LASTITEM_MISMATCH",
    "CLEAN.IDLE_GATE",
    "DOOR.OPEN_WHILE_OPEN",
    "DOOR.CLOSE_WHILE_CLOSED",
})


class HongYeValidatorError(RuntimeError):
    """表示原始 HongYe 校验模块缺失、执行失败或没有生成有效结果。"""


class HongYeLogValidator:
    """把完整复现日志一次性交给原始 MoveStateSim 校验。"""

    def __init__(
        self,
        executable: Optional[Path] = None,
        *,
        timeout_seconds: float = VALIDATION_TIMEOUT_SECONDS,
    ) -> None:
        """配置校验器路径与单次最长运行时间，但不提前启动子进程。"""
        self._executable = Path(executable or VALIDATOR_EXE)
        self._timeout_seconds = float(timeout_seconds)
        if not self._executable.is_file():
            raise HongYeValidatorError(
                f"HongYe 原始校验器不存在：{self._executable}"
            )

    def validate(
        self,
        entries: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """校验完整日志并返回 ``module-parallel`` 的结构化摘要。

        参数 ``entries`` 必须是平台生成的标准事件序列。方法会创建独立临时目录，
        因而并发运行之间不会共享输入或 MoveStateSim 产物。
        """
        return self._run_original_validator(entries)

    def _run_original_validator(
        self,
        entries: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """将指定日志原样写入文件并调用一次原始 MoveStateSim。"""
        with tempfile.TemporaryDirectory(prefix="milp_hongye_") as temporary:
            temporary_dir = Path(temporary)
            log_path = temporary_dir / "input_data.json"
            output_dir = temporary_dir / "output"
            output_dir.mkdir()
            log_path.write_text(
                json.dumps(list(entries), ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            command = [
                str(self._executable),
                "--log",
                str(log_path),
                "--out",
                str(output_dir),
                "--run-dir",
                str(self._executable.parent),
                "--advance",
                "module-parallel",
            ]
            try:
                process = subprocess.run(
                    command,
                    cwd=str(self._executable.parent),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self._timeout_seconds,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise HongYeValidatorError(
                    f"HongYe 原始校验器执行失败：{error}"
                ) from error

            validation = _load_module_parallel_validation(output_dir)
            if validation is None:
                diagnostic = (process.stderr or process.stdout or "").strip()
                suffix = f"：{diagnostic[-1000:]}" if diagnostic else ""
                raise HongYeValidatorError(
                    "HongYe 原始校验器未生成 module-parallel 结果"
                    f"（code={process.returncode}）{suffix}"
                )
            return _normalize_validation(validation)


def _load_module_parallel_validation(
    output_dir: Path,
) -> Optional[dict[str, Any]]:
    """按原始 ``check_log.py`` 的优先级读取 module-parallel 结果。"""
    modes_path = output_dir / "replay_modes.json"
    if modes_path.is_file():
        payload = json.loads(modes_path.read_text(encoding="utf-8-sig"))
        module_parallel = payload.get("module-parallel")
        if (
            isinstance(module_parallel, Mapping)
            and isinstance(module_parallel.get("validation"), Mapping)
        ):
            return dict(module_parallel["validation"])

    validation_path = output_dir / "validation.module_parallel.json"
    if validation_path.is_file():
        payload = json.loads(validation_path.read_text(encoding="utf-8-sig"))
        if isinstance(payload, Mapping):
            return dict(payload)
    return None


def _normalize_validation(validation: Mapping[str, Any]) -> dict[str, Any]:
    """统一成功字段；计划时长差异和 warning 不改变 CheckMinLog 的成败。"""
    normalized = dict(validation)
    raw_issues = [
        dict(issue)
        for issue in normalized.get("issues") or []
        if isinstance(issue, Mapping)
    ]
    error_issues = [
        issue
        for issue in raw_issues
        if str(issue.get("code") or "") not in WARNING_CODES
        and not str(issue.get("code") or "").startswith("MOVE.DURATION")
    ]
    raw_errors = normalized.get("movelist_errors")
    if raw_errors is None:
        raw_errors = normalized.get("errors")
    try:
        error_count = int(raw_errors)
    except (TypeError, ValueError):
        error_count = len(error_issues)
    normalized["advance"] = "module-parallel"
    normalized["errors"] = error_count
    normalized["error_issues"] = error_issues
    normalized["success"] = error_count == 0
    return normalized
