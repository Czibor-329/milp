"""批量测试结果项的组装与产物持久化。

本模块拥有批量成功、普通失败、可回放失败和取消项的统一响应格式。算法执行、
并发调度和 Baseline 计算不在这里实现；调用方通过明确回调提供指标与仓储能力。
"""

from __future__ import annotations

import time
from copy import deepcopy
from typing import Any, Callable, Dict, Mapping


class BatchResultAssembler:
    """使用批量服务提供的仓储与指标能力组装最终测试项。"""

    def __init__(
        self,
        *,
        save_result: Callable[[Dict[str, Any]], str],
        save_reproduction_log: Callable[[Any], str],
        log_response_fields: Callable[[str], Dict[str, str]],
        logged_failure_fields: Callable[..., Dict[str, Any]],
        baseline_comparison: Callable[..., Dict[str, Any]],
        robot_wafer_dwell_time: Callable[[Any], Dict[str, Any]],
        is_external_algorithm: Callable[[str], bool],
    ) -> None:
        self._save_result = save_result
        self._save_reproduction_log = save_reproduction_log
        self._log_response_fields = log_response_fields
        self._logged_failure_fields = logged_failure_fields
        self._baseline_comparison = baseline_comparison
        self._robot_wafer_dwell_time = robot_wafer_dwell_time
        self._is_external_algorithm = is_external_algorithm

    @staticmethod
    def _identity(index: int, test_case: Mapping[str, Any]) -> Dict[str, Any]:
        """生成所有结果状态共用的稳定测试标识。"""
        return {
            "index": index,
            "testId": str(test_case.get("id") or ""),
            "testName": str(test_case.get("name") or f"测试 {index + 1}"),
        }

    def cancelled(self, index: int, test_case: Mapping[str, Any]) -> Dict[str, Any]:
        """构造用户终止调度时的取消结果项。"""
        return {
            **self._identity(index, test_case),
            "ok": False,
            "status": "cancelled",
            "error": "用户终止调度",
        }

    def plain_failure(
        self,
        index: int,
        test_case: Mapping[str, Any],
        error: BaseException,
    ) -> Dict[str, Any]:
        """构造算法层未分类异常的结果项。"""
        return {
            **self._identity(index, test_case),
            "ok": False,
            "status": "failed",
            "error": str(error) or type(error).__name__,
        }

    def logged_failure(
        self,
        index: int,
        test_case: Mapping[str, Any],
        error: Any,
        baseline: Mapping[str, Any],
        selected_plan: Mapping[str, Any],
        strategy: str,
        run_started: float,
    ) -> Dict[str, Any]:
        """保存可回放失败产物，并保留外部算法的客观指标。"""
        log_id = self._save_reproduction_log(error.reproduction_log)
        failure = {
            **self._identity(index, test_case),
            "ok": False,
            "status": "failed",
            "error": str(error) or type(error).__name__,
            "baseline": deepcopy(baseline),
            **self._log_response_fields(log_id),
            **self._logged_failure_fields(error, replay_plan=selected_plan),
        }
        if self._is_external_algorithm(strategy) and error.validation_issues:
            elapsed_ms = (time.perf_counter() - run_started) * 1000.0
            moves = list((error.failure_output or {}).get("MoveList") or [])
            failure.update({
                "metricsAvailable": True,
                "totalElapsedMs": elapsed_ms,
                "cpuTimeMs": elapsed_ms,
                "robotWaferDwellTime": self._robot_wafer_dwell_time(moves),
            })
            failure.update(self._baseline_comparison(failure, baseline))
        return failure

    def success(
        self,
        index: int,
        test_case: Mapping[str, Any],
        result: Mapping[str, Any],
        baseline: Mapping[str, Any],
        selected_plan: Mapping[str, Any],
    ) -> Dict[str, Any]:
        """保存通过校验的结果、回放上下文和复现日志。"""
        artifact = deepcopy(dict(result["output"]))
        artifact["RunMetricsMetadata"] = {
            "cpuTimeMs": max(0.0, float(result.get("cpuTimeMs", result.get("totalElapsedMs", 0.0)))),
            "recomputeCount": len(list(result.get("updates") or [])),
        }
        artifact["ReplayContext"] = {
            "schema": "machine-replay-context-v1",
            "plan": deepcopy(selected_plan),
            "updates": deepcopy(list(result.get("updates") or [])),
        }
        result_id = self._save_result(artifact)
        log_id = self._save_reproduction_log(result["reproductionLog"])
        item = {
            **self._identity(index, test_case),
            "ok": True,
            "status": "succeeded",
            "totalElapsedMs": result["totalElapsedMs"],
            "cpuTimeMs": result.get("cpuTimeMs", result["totalElapsedMs"]),
            "makespan": result["makespan"],
            "moveCount": result["moveCount"],
            "validation": result["validation"],
            "robotWaferDwellTime": self._robot_wafer_dwell_time(
                list(result["output"].get("MoveList") or []),
            ),
            "resultUrl": f"/api/results/{result_id}",
            "ganttUrl": f"/movelist_gantt_viewer.html?src=/api/results/{result_id}",
            **self._log_response_fields(log_id),
            **self._baseline_comparison(result, baseline),
        }
        return item
