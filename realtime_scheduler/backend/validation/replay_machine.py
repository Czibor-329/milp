"""拓扑回放动作接口的上下文构造与返回值规范化。

本模块不判断动作可行性，也不运行推荐模型。它按回放时刻选择当前代
``IUpdateParams``，并把算法可选 ``get_replay_actions`` 接口的结果限制为
Pick、Place、Swap 与三个稳定状态。算法未实现接口时返回空动作列表。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Mapping, Sequence

from realtime_scheduler.backend.execution.plan_builder import BuildState, build_round_update


TIME_TOLERANCE_SECONDS = 1e-6
COMPLETED_PRIMITIVE_MOVE_TYPES = frozenset({0, 1, 2, 3, 4})
ACTION_KINDS = frozenset({"pick", "place", "swap"})
ACTION_STATUSES = frozenset({
    "enabled",
    "physical-blocked",
    "deadlock-blocked",
})


class ReplayMachine:
    """保存回放上下文并生成算法动作接口所需的当前代 update。

    参数:
        plan: 生成 MoveList 的完整计划。
        moves: 标准 MoveList。
        updates: 调度运行时保存的逐代标准 update。
        algorithm_action_diagnostics: 算法动作接口返回对象。

    类名为已有 HTTP 边界保留；实例不再承担 Machine 或模型评估职责。
    """

    def __init__(
        self,
        plan: Mapping[str, Any],
        moves: Sequence[Mapping[str, Any]],
        updates: Sequence[Mapping[str, Any]] = (),
        *,
        algorithm_action_diagnostics: Mapping[str, Any] | None = None,
    ) -> None:
        if not isinstance(plan.get("device"), Mapping):
            raise ValueError("拓扑回放缺少设备配置 device")
        if not isinstance(plan.get("rounds"), Sequence):
            raise ValueError("拓扑回放缺少轮次配置 rounds")
        self.plan = deepcopy(dict(plan))
        self.moves = [deepcopy(dict(move)) for move in moves]
        self.updates = [deepcopy(dict(update)) for update in updates]
        self.algorithm_action_diagnostics = (
            deepcopy(dict(algorithm_action_diagnostics))
            if isinstance(algorithm_action_diagnostics, Mapping)
            else None
        )

    def replay_update_at(self, cutoff: float) -> Dict[str, Any]:
        """返回算法动作接口在目标回放时刻应使用的当前代 update。

        已保存的实际 update 优先；旧结果没有 update 时，再由计划轮次重建。
        后续轮次不会提前进入当前动作上下文。
        """
        replay_time = max(0.0, float(cutoff))
        available_updates = [
            update
            for update in self.updates
            if float(update.get("CurrentTime") or 0.0)
            <= replay_time + TIME_TOLERANCE_SECONDS
        ]
        if available_updates:
            latest = max(
                available_updates,
                key=lambda update: float(update.get("CurrentTime") or 0.0),
            )
            return deepcopy(dict(latest))

        build_state = BuildState()
        round_updates: list[Dict[str, Any]] = []
        for raw_round in self.plan.get("rounds") or []:
            if not isinstance(raw_round, Mapping):
                continue
            round_time = float(raw_round.get("currentTime") or 0.0)
            if round_time > replay_time + TIME_TOLERANCE_SECONDS:
                break
            round_updates.append(
                build_round_update(
                    self.plan,
                    raw_round,
                    round_time,
                    build_state,
                )
            )
        if not round_updates:
            raise ValueError("当前回放时刻之前没有已发布的调度轮次")

        combined = deepcopy(round_updates[0])
        for update in round_updates[1:]:
            for field_name in ("Materials", "ProcessJobs", "ControlJobs"):
                combined[field_name].extend(deepcopy(update.get(field_name) or []))
        combined["CurrentTime"] = 0.0
        return combined

    def evaluate_actions(self, cutoff: float) -> Dict[str, Any]:
        """返回算法接口提供的原子动作分类，不执行平台兜底或推荐模型。"""
        replay_time = max(0.0, float(cutoff))
        normalized = self._normalize_algorithm_action_diagnostics(
            self.algorithm_action_diagnostics,
        )
        if normalized is None:
            diagnostics: list[Dict[str, Any]] = []
            provider_name = ""
            source = "unavailable"
        else:
            diagnostics, provider_name = normalized
            source = "algorithm"
        counts = {
            status: sum(
                1 for action in diagnostics if action["status"] == status
            )
            for status in sorted(ACTION_STATUSES)
        }
        return {
            "model": "actions",
            "modelLabel": "动作状态",
            "decisionIndex": sum(
                1
                for move in self.moves
                if int(move.get("MoveType", -1))
                in COMPLETED_PRIMITIVE_MOVE_TYPES
                and float(move.get("EndTime") or 0.0)
                <= replay_time + TIME_TOLERANCE_SECONDS
            ),
            "time": replay_time,
            "revision": 0,
            "selectedActionId": "",
            "executedActionId": "",
            "candidateCount": 0,
            "shownCandidateCount": 0,
            "candidatesTruncated": False,
            "modelEvaluated": False,
            "replayEvaluated": True,
            "candidates": [],
            "candidateGroups": [],
            "actionDiagnosticsSource": source,
            "actionDiagnosticsProvider": provider_name,
            "actionCounts": counts,
            "actionDiagnostics": diagnostics,
        }

    @staticmethod
    def _normalize_algorithm_action_diagnostics(
        payload: Mapping[str, Any] | None,
    ) -> tuple[list[Dict[str, Any]], str] | None:
        """校验算法动作诊断，只接受三类动作与三个稳定状态。"""
        if not isinstance(payload, Mapping):
            return None
        raw_actions = payload.get("actions")
        if not isinstance(raw_actions, Sequence) or isinstance(
            raw_actions,
            (str, bytes),
        ):
            return None
        diagnostics: list[Dict[str, Any]] = []
        for raw_action in raw_actions:
            if not isinstance(raw_action, Mapping):
                continue
            kind = str(raw_action.get("kind") or "").strip().lower()
            status = str(raw_action.get("status") or "enabled").strip().lower()
            if kind not in ACTION_KINDS or status not in ACTION_STATUSES:
                continue
            diagnostics.append({
                "actionId": str(raw_action.get("actionId") or ""),
                "kind": kind,
                "status": status,
                "reason": str(raw_action.get("reason") or ""),
                "actor": str(raw_action.get("actor") or ""),
                "robot": str(raw_action.get("robot") or ""),
                "materialIds": [
                    str(value) for value in raw_action.get("materialIds") or []
                ],
                "source": str(raw_action.get("source") or ""),
                "sourceSlot": int(raw_action.get("sourceSlot") or 0),
                "destination": str(raw_action.get("destination") or ""),
                "destinationSlot": int(raw_action.get("destinationSlot") or 0),
                "earliestStart": float(raw_action.get("earliestStart") or 0.0),
                "finishTime": float(raw_action.get("finishTime") or 0.0),
            })
        return diagnostics, str(payload.get("provider") or "algorithm")

    # 旧调用点在迁移期仍可调用 evaluate；语义已经收敛为动作分类。
    evaluate = evaluate_actions
