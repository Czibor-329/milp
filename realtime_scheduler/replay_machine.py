"""拓扑回放使用的整机状态重建与 E2E 动作评估。

本模块把编辑器计划、任意来源的 MoveList 和回放时刻组合成算法层 ``Machine``。
它只重放已经发生的物理 Move，不沿用结果文件中的静态决策轨迹；随后枚举当前
合法搬运意图并调用生产 E2E-CTQ checkpoint 评分。这样启发式、MILP 或外部算法
的结果也能在同一物理状态下获得可比较的模型解释。
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import threading
from typing import Any, Dict, Iterable, Mapping, Sequence

import numpy as np

from realtime_scheduler.plan_builder import BuildState, build_round_update


TIME_TOLERANCE_SECONDS = 1e-6
COMPLETED_INTENT_MOVE_TYPES = frozenset({1, 3, 4})
VISIBLE_CANDIDATE_LIMIT = 24
QUANTILE_MARGIN = 1
_POLICY_CACHE: Dict[str, tuple[int, Any]] = {}
_POLICY_LOCK = threading.RLock()


def _load_cached_policy(model_path: Path) -> Any:
    """按 checkpoint 修改时间缓存生产模型，避免回放事件重复读取磁盘。"""
    from src.schedule.e2e_ctq import load_e2e_ctq_policy

    resolved_path = model_path.resolve()
    modified_time = resolved_path.stat().st_mtime_ns
    cache_key = str(resolved_path)
    with _POLICY_LOCK:
        cached = _POLICY_CACHE.get(cache_key)
        if cached is None or cached[0] != modified_time:
            cached = (modified_time, load_e2e_ctq_policy(resolved_path))
            _POLICY_CACHE[cache_key] = cached
        return cached[1]


class ReplayMachine:
    """从 MoveList 投影当前整机状态，并实时评估合法搬运意图。

    参数:
        plan: 编辑器完整计划，必须包含 device、routes、recipes 和 rounds。
        moves: 任意调度策略输出的标准 MoveList。
        model_path: 生产 E2E-CTQ checkpoint 路径。
        updates: 可选的逐轮实际 Machine update，用于精确恢复多轮重算切点。

    实例不修改输入对象。每次 ``evaluate`` 都以目标时刻之前已发布的轮次构造
    Problem，避免尚未上线的后续批次提前出现在候选集合中。
    """

    def __init__(
        self,
        plan: Mapping[str, Any],
        moves: Sequence[Mapping[str, Any]],
        model_path: Path,
        updates: Sequence[Mapping[str, Any]] = (),
    ) -> None:
        if not isinstance(plan.get("device"), Mapping):
            raise ValueError("回放 E2E 评估缺少设备配置 device")
        if not isinstance(plan.get("rounds"), Sequence):
            raise ValueError("回放 E2E 评估缺少轮次配置 rounds")
        if not Path(model_path).is_file():
            raise RuntimeError("E2E-CTQ 模型不存在，无法实时评估动作")
        self.plan = deepcopy(dict(plan))
        self.moves = [deepcopy(dict(move)) for move in moves]
        self.model_path = Path(model_path)
        self.updates = [deepcopy(dict(update)) for update in updates]

    def evaluate(self, cutoff: float) -> Dict[str, Any]:
        """返回目标回放时刻的全部合法意图、E2E 评分和原计划选择。

        ``cutoff`` 为绝对秒数。返回值遵循前端 ``DecisionTraceStep`` 契约；
        ``selectedActionId`` 是 E2E 推荐的完整 Pick + Place / Swap 事务，
        ``executedActionId`` 是 MoveList 接下来实际执行的完整事务。兼容字段
        ``selectedIntentActionId`` 和 ``executedIntentActionId`` 返回相同 ID。
        """
        from src.schedule.e2e_ctq import (
            build_resource_flow_context,
            build_resource_flow_observation,
        )
        from src.schedule.machine_policy import ReentrantFlowPriority
        from src.validation import Machine, MoveStateReplay
        from src.validation.state import MachineState

        replay_time = max(0.0, float(cutoff))
        problem, initial_update, generation_start = self._problem_at(replay_time)
        initial_state = MachineState.from_sources(problem, initial_update)
        applicable_moves = self._moves_started_by(replay_time, generation_start)
        replay = MoveStateReplay(problem, applicable_moves, initial_state)

        # MoveList 已通过调度输出校验。这里按开始顺序提交，并只结束 cutoff 前
        # 已完成的 Move；跨过 cutoff 的 Move 保持 Running，使资源占用进入候选屏蔽。
        for move in applicable_moves:
            move_id = move.get("MoveID")
            if not isinstance(move_id, int):
                raise ValueError("MoveList 包含缺少整数 MoveID 的动作")
            replay.update_move_state(
                {
                    "MoveID": move_id,
                    "MoveState": MoveStateReplay.RUNNING,
                    "StartTime": float(move.get("StartTime") or 0.0),
                },
                snapshot=False,
                track_reservations=False,
            )
            if float(move.get("EndTime") or 0.0) <= replay_time + TIME_TOLERANCE_SECONDS:
                replay.update_move_state(
                    {
                        "MoveID": move_id,
                        "MoveState": MoveStateReplay.DONE,
                        "EndTime": float(move.get("EndTime") or 0.0),
                    },
                    snapshot=False,
                    track_reservations=False,
                )

        machine = Machine(problem, replay.state, current_time=replay_time)
        state = machine.get_state()
        actions = machine.get_robot_actions()
        if not actions:
            return {
                "decisionIndex": int(state.completed_action_count),
                "time": replay_time,
                "revision": int(state.revision),
                "selectedActionId": "",
                "executedActionId": "",
                "candidateCount": 0,
                "shownCandidateCount": 0,
                "candidatesTruncated": False,
                "modelEvaluated": False,
                "replayEvaluated": True,
                "candidates": [],
            }

        policy = _load_cached_policy(self.model_path)
        context = build_resource_flow_context(problem)
        observation = build_resource_flow_observation(
            problem,
            state,
            actions,
            context,
        )
        logits, quantiles = policy.score(observation)
        deferred_action_ids = ReentrantFlowPriority(
            problem
        ).deferred_action_ids(state, actions)
        selected_index = min(
            range(len(actions)),
            key=lambda index: (
                int(str(actions[index].action_id) in deferred_action_ids),
                -float(logits[index]),
                float(np.mean(quantiles[index])),
                float(actions[index].earliest_start),
                int(actions[index].wafer_id),
                int(actions[index].stage_index),
                str(actions[index].destination_station),
                int(actions[index].destination_slot),
            ),
        )
        executed_action_id = self._match_next_action(actions, replay_time)
        decision = self._decision_payload(
            state,
            actions,
            selected_index,
            logits,
            quantiles,
            replay_time,
            executed_action_id,
            deferred_action_ids,
        )
        return decision

    def _decision_payload(
        self,
        state: Any,
        actions: Sequence[Any],
        selected_index: int,
        logits: np.ndarray,
        quantiles: np.ndarray,
        replay_time: float,
        executed_action_id: str,
        deferred_action_ids: set[str],
    ) -> Dict[str, Any]:
        """把完整 Pick + Place / Swap 事务输出为稳定、有界的前端协议。"""
        score_values = np.asarray(logits, dtype=np.float64)
        shifted_scores = score_values - float(np.max(score_values))
        weights = np.exp(np.clip(shifted_scores, -60.0, 0.0))
        denominator = float(np.sum(weights))
        probabilities = (
            weights / denominator
            if np.isfinite(denominator) and denominator > 0.0
            else np.full(len(actions), 1.0 / len(actions), dtype=np.float64)
        )
        remaining_means = [
            float(np.mean(np.asarray(values, dtype=np.float64)))
            for values in quantiles
        ]
        ranked_indices = sorted(
            range(len(actions)),
            key=lambda index: (
                int(str(actions[index].action_id) in deferred_action_ids),
                -float(probabilities[index]),
                float(actions[index].earliest_start),
                str(actions[index].action_id),
            ),
        )
        executed_index = next(
            (
                index
                for index, action in enumerate(actions)
                if str(action.action_id) == executed_action_id
            ),
            None,
        )
        visible_indices = ranked_indices[:VISIBLE_CANDIDATE_LIMIT]
        required_indices = {selected_index}
        if executed_index is not None:
            required_indices.add(executed_index)
        for required_index in required_indices:
            if required_index in visible_indices:
                continue
            if len(visible_indices) >= VISIBLE_CANDIDATE_LIMIT:
                removable_index = next(
                    (
                        index
                        for index in reversed(visible_indices)
                        if index not in required_indices
                    ),
                    visible_indices[-1],
                )
                visible_indices[
                    visible_indices.index(removable_index)
                ] = required_index
            else:
                visible_indices.append(required_index)
        visible_indices = sorted(
            set(visible_indices),
            key=lambda index: ranked_indices.index(index),
        )

        best_remaining = min(remaining_means)
        candidates = []
        for action_index in visible_indices:
            action = actions[action_index]
            values = np.asarray(quantiles[action_index], dtype=np.float64)
            margin = min(QUANTILE_MARGIN, max(len(values) - 1, 0))
            action_id = str(action.action_id)
            candidates.append({
                "actionId": action_id,
                "kind": str(action.kind),
                "flowKind": str(action.flow_kind),
                "robot": str(action.robot),
                "materialIds": [
                    str(value) for value in action.material_ids
                ],
                "waferId": int(action.wafer_id),
                "stageIndex": int(action.stage_index),
                "source": str(action.source_station or action.robot),
                "sourceSlot": int(action.source_slot or 0),
                "destination": str(action.destination_station),
                "destinationSlot": int(action.destination_slot or 0),
                "earliestStart": float(action.earliest_start),
                "finishTime": float(action.finish_time),
                "rank": ranked_indices.index(action_index) + 1,
                "selected": action_index == selected_index,
                "priorityDeferred": action_id in deferred_action_ids,
                "executed": action_index == executed_index,
                "policyScore": float(score_values[action_index]),
                "policyPreference": float(probabilities[action_index]),
                "expectedRemainingMakespan": remaining_means[action_index],
                "medianRemainingMakespan": float(np.median(values)),
                "lowerRemainingMakespan": float(values[margin]),
                "upperRemainingMakespan": float(values[-margin - 1]),
                "makespanDelta": max(
                    0.0,
                    remaining_means[action_index] - best_remaining,
                ),
            })
        completed_intents = sum(
            1
            for move in self.moves
            if (
                int(move.get("MoveType", -1)) in COMPLETED_INTENT_MOVE_TYPES
                and float(move.get("EndTime") or 0.0)
                <= replay_time + TIME_TOLERANCE_SECONDS
            )
        )
        selected_action_id = str(actions[selected_index].action_id)
        matched_executed_action_id = (
            str(actions[executed_index].action_id)
            if executed_index is not None
            else ""
        )
        return {
            "decisionIndex": completed_intents,
            "time": replay_time,
            "revision": int(state.revision),
            "selectedActionId": selected_action_id,
            "executedActionId": matched_executed_action_id,
            "selectedIntentActionId": selected_action_id,
            "executedIntentActionId": matched_executed_action_id,
            "candidateCount": len(actions),
            "shownCandidateCount": len(candidates),
            "candidatesTruncated": len(actions) > len(candidates),
            "modelEvaluated": True,
            "replayEvaluated": True,
            "candidates": candidates,
        }

    def _problem_at(self, cutoff: float):
        """构造 cutoff 所在计划代次的 Problem、初态 update 和代次起点。"""
        from src.parse import parse_task

        available_updates = [
            update
            for update in self.updates
            if float(update.get("CurrentTime") or 0.0)
            <= cutoff + TIME_TOLERANCE_SECONDS
        ]
        if available_updates:
            initial_update = max(
                available_updates,
                key=lambda update: float(update.get("CurrentTime") or 0.0),
            )
            generation_start = float(initial_update.get("CurrentTime") or 0.0)
            return (
                parse_task(self.plan["device"], initial_update),
                deepcopy(initial_update),
                generation_start,
            )

        build_state = BuildState()
        updates: list[Dict[str, Any]] = []
        for raw_round in self.plan.get("rounds") or []:
            if not isinstance(raw_round, Mapping):
                continue
            round_time = float(raw_round.get("currentTime") or 0.0)
            if round_time > cutoff + TIME_TOLERANCE_SECONDS:
                break
            updates.append(
                build_round_update(self.plan, raw_round, round_time, build_state)
            )
        if not updates:
            raise ValueError("当前回放时刻之前没有已发布的调度轮次")

        combined = deepcopy(updates[0])
        for update in updates[1:]:
            combined["Routes"].update(deepcopy(update.get("Routes") or {}))
            for field_name in ("Materials", "ProcessJobs", "ControlJobs"):
                combined[field_name].extend(deepcopy(update.get(field_name) or []))
        combined["CurrentTime"] = 0.0
        return parse_task(self.plan["device"], combined), combined, 0.0

    def _moves_started_by(
        self,
        cutoff: float,
        generation_start: float,
    ) -> list[Dict[str, Any]]:
        """返回当前计划代次内 cutoff 前已开始的 Move，并保持稳定排序。"""
        return sorted(
            (
                deepcopy(move)
                for move in self.moves
                if (
                    float(move.get("StartTime") or 0.0)
                    >= generation_start - TIME_TOLERANCE_SECONDS
                    and float(move.get("StartTime") or 0.0)
                    < cutoff - TIME_TOLERANCE_SECONDS
                )
            ),
            key=lambda move: (
                float(move.get("StartTime") or 0.0),
                int(move.get("MoveID") or 0),
            ),
        )

    def _match_next_action(self, actions: Sequence[Any], cutoff: float) -> str:
        """用紧邻的完整事务终点识别原 MoveList 当前选择的联合意图。"""
        future_completions = [
            move
            for move in sorted(
                self.moves,
                key=lambda item: (
                    float(item.get("EndTime") or 0.0),
                    int(item.get("MoveID") or 0),
                ),
            )
            if (
                int(move.get("MoveType", -1)) in COMPLETED_INTENT_MOVE_TYPES
                and float(move.get("EndTime") or 0.0)
                > cutoff + TIME_TOLERANCE_SECONDS
            )
        ]
        if not future_completions:
            return ""
        expected_signature = self._transport_signature(future_completions[0])
        for action in actions:
            preview_completions = [
                dict(move)
                for move in action.move_preview
                if int(move.get("MoveType", -1)) in COMPLETED_INTENT_MOVE_TYPES
            ]
            if not preview_completions:
                continue
            terminal_preview = max(
                preview_completions,
                key=lambda move: (
                    float(move.get("EndTime") or 0.0),
                    int(move.get("MoveID") or 0),
                ),
            )
            if self._transport_signature(terminal_preview) == expected_signature:
                return str(action.action_id)
        return ""

    @staticmethod
    def _move_material_ids(move: Mapping[str, Any]) -> Iterable[Any]:
        """兼容标准 Move 中的复数与单数物料字段。"""
        values = move.get("MatIDList", move.get("MaterialList", []))
        if isinstance(values, Sequence) and not isinstance(values, (str, bytes)):
            return tuple(values)
        value = move.get("MatID", move.get("MaterialID"))
        return () if value is None else (value,)

    @classmethod
    def _transport_signature(cls, move: Mapping[str, Any]) -> tuple[Any, ...]:
        """生成忽略时间和 MoveID 的稳定运输动作签名。"""
        return (
            int(move.get("MoveType", -1)),
            str(move.get("Robot") or move.get("ModuleName") or ""),
            tuple(str(value) for value in cls._move_material_ids(move)),
            tuple(str(value) for value in move.get("SrcStationList") or ()),
            tuple(str(value) for value in move.get("DestStationList") or ()),
            tuple(str(value) for value in move.get("StationList") or ()),
            tuple(str(value) for value in move.get("RecvMatList") or ()),
            tuple(str(value) for value in move.get("SendMatList") or ()),
        )
