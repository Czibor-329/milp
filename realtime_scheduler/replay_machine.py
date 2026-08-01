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
TRANSPORT_MOVE_TYPES = frozenset({0, 1, 2, 3, 4})
PICK_MOVE_TYPES = frozenset({0, 2})
PLACE_MOVE_TYPES = frozenset({1, 3})
SWAP_MOVE_TYPE = 4
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
        ``selectedActionId`` 是 E2E 当前推荐的下一条物理运输动作，
        ``executedActionId`` 是 MoveList 接下来实际执行的物理动作；完整事务 ID
        另存于 ``selectedIntentActionId`` 和 ``executedIntentActionId``。
        """
        from src.schedule.e2e_ctq import (
            build_resource_flow_context,
            build_resource_flow_observation,
        )
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
        selected_index = min(
            range(len(actions)),
            key=lambda index: (
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
        )
        return decision

    @classmethod
    def _physical_action_descriptor(cls, action: Any) -> Dict[str, Any]:
        """把完整搬运事务投影为当前下一条真实运输 Move。

        ``RobotAction`` 为了排程质量会预览 Pick、转位和 Place 的完整事务；回放
        面板需要展示的却是用户此刻能观察到的下一步。多个仅后续落点不同、但
        当前都执行同一次 Pick 的事务因此共享同一个物理动作键。
        """
        move = next(
            (
                candidate
                for candidate in action.move_preview
                if int(candidate.get("MoveType", -1)) in TRANSPORT_MOVE_TYPES
            ),
            None,
        )
        if move is None:
            source = str(action.source_station or action.robot)
            destination = str(action.destination_station)
            move_type = -1
            station_slot = int(action.destination_slot or 0)
            material_ids = tuple(str(value) for value in action.material_ids)
            kind = str(action.kind)
        else:
            move_type = int(move.get("MoveType", -1))
            robot = str(move.get("Robot") or move.get("ModuleName") or action.robot)
            material_ids = tuple(str(value) for value in cls._move_material_ids(move))
            if not material_ids:
                material_ids = tuple(str(value) for value in action.material_ids)
            if move_type in PICK_MOVE_TYPES:
                source = str((move.get("SrcStationList") or [action.source_station or ""])[0])
                destination = robot
                station_slot = int(
                    (move.get("SrcSlotList") or [action.source_slot or 0])[0]
                )
                kind = "pick"
            elif move_type in PLACE_MOVE_TYPES:
                source = robot
                destination = str(
                    (move.get("DestStationList") or [action.destination_station])[0]
                )
                station_slot = int(
                    (move.get("DestSlotList") or [action.destination_slot or 0])[0]
                )
                kind = "place"
            else:
                source = robot
                destination = str(
                    (move.get("StationList") or [action.destination_station])[0]
                )
                station_slot = int(
                    (move.get("StnRecvSlotList") or [action.destination_slot or 0])[0]
                )
                kind = "swap"
        robot_name = str(action.robot)
        group_key = (
            move_type,
            robot_name,
            material_ids,
            source,
            destination,
            station_slot,
        )
        action_id = ":".join((
            "physical",
            str(move_type),
            robot_name,
            source,
            destination,
            str(station_slot),
            ",".join(material_ids),
        ))
        return {
            "groupKey": group_key,
            "actionId": action_id,
            "kind": kind,
            "physicalMoveType": move_type,
            "robot": robot_name,
            "materialIds": material_ids,
            "source": source,
            "destination": destination,
            "stationSlot": station_slot,
            "earliestStart": float(
                move.get("StartTime", action.earliest_start)
                if move is not None
                else action.earliest_start
            ),
            "finishTime": float(
                move.get("EndTime", action.finish_time)
                if move is not None
                else action.finish_time
            ),
        }

    def _decision_payload(
        self,
        state: Any,
        actions: Sequence[Any],
        selected_index: int,
        logits: np.ndarray,
        quantiles: np.ndarray,
        replay_time: float,
        executed_action_id: str,
    ) -> Dict[str, Any]:
        """把完整事务评分按当前物理动作合并为稳定、有界的前端协议。"""
        score_values = np.asarray(logits, dtype=np.float64)
        shifted_scores = score_values - float(np.max(score_values))
        weights = np.exp(np.clip(shifted_scores, -60.0, 0.0))
        denominator = float(np.sum(weights))
        probabilities = (
            weights / denominator
            if np.isfinite(denominator) and denominator > 0.0
            else np.full(len(actions), 1.0 / len(actions), dtype=np.float64)
        )
        descriptors = [self._physical_action_descriptor(action) for action in actions]
        grouped_indices: Dict[tuple[Any, ...], list[int]] = {}
        for index, descriptor in enumerate(descriptors):
            grouped_indices.setdefault(descriptor["groupKey"], []).append(index)

        groups = []
        action_group_indices: Dict[int, int] = {}
        for indices in grouped_indices.values():
            group_index = len(groups)
            for action_index in indices:
                action_group_indices[action_index] = group_index
            group_probability = float(sum(probabilities[index] for index in indices))
            local_weights = np.asarray(
                [float(probabilities[index]) for index in indices],
                dtype=np.float64,
            )
            local_denominator = float(np.sum(local_weights))
            if not np.isfinite(local_denominator) or local_denominator <= 0.0:
                local_weights = np.full(len(indices), 1.0 / len(indices))
            else:
                local_weights /= local_denominator
            group_quantiles = np.average(
                np.asarray([quantiles[index] for index in indices], dtype=np.float64),
                axis=0,
                weights=local_weights,
            )
            representative_index = (
                selected_index
                if selected_index in indices
                else max(indices, key=lambda index: float(probabilities[index]))
            )
            maximum_score = max(float(score_values[index]) for index in indices)
            group_score = maximum_score + float(np.log(sum(
                np.exp(float(score_values[index]) - maximum_score)
                for index in indices
            )))
            groups.append({
                "indices": indices,
                "descriptor": descriptors[representative_index],
                "representativeIndex": representative_index,
                "probability": group_probability,
                "policyScore": group_score,
                "quantiles": group_quantiles,
                "remainingMean": float(np.mean(group_quantiles)),
            })

        selected_group_index = action_group_indices[selected_index]
        executed_raw_index = next(
            (
                index
                for index, action in enumerate(actions)
                if str(action.action_id) == executed_action_id
            ),
            None,
        )
        executed_group_index = (
            action_group_indices[executed_raw_index]
            if executed_raw_index is not None
            else None
        )
        best_remaining = min(group["remainingMean"] for group in groups)
        ranked_group_indices = sorted(
            range(len(groups)),
            key=lambda index: (
                -float(groups[index]["probability"]),
                float(groups[index]["descriptor"]["earliestStart"]),
                str(groups[index]["descriptor"]["actionId"]),
            ),
        )
        visible_group_indices = ranked_group_indices[:VISIBLE_CANDIDATE_LIMIT]
        required_group_indices = {selected_group_index}
        if executed_group_index is not None:
            required_group_indices.add(executed_group_index)
        for required_index in required_group_indices:
            if required_index in visible_group_indices:
                continue
            if len(visible_group_indices) >= VISIBLE_CANDIDATE_LIMIT:
                removable_index = next(
                    (
                        index
                        for index in reversed(visible_group_indices)
                        if index not in required_group_indices
                    ),
                    visible_group_indices[-1],
                )
                visible_group_indices[
                    visible_group_indices.index(removable_index)
                ] = required_index
            else:
                visible_group_indices.append(required_index)
        visible_group_indices = sorted(
            set(visible_group_indices),
            key=lambda index: ranked_group_indices.index(index),
        )

        candidates = []
        for group_index in visible_group_indices:
            group = groups[group_index]
            descriptor = group["descriptor"]
            representative_index = int(group["representativeIndex"])
            action = actions[representative_index]
            values = np.asarray(group["quantiles"], dtype=np.float64)
            margin = min(QUANTILE_MARGIN, max(len(values) - 1, 0))
            action_id = str(descriptor["actionId"])
            candidates.append({
                "actionId": action_id,
                "kind": str(descriptor["kind"]),
                "flowKind": str(action.flow_kind),
                "physicalMoveType": int(descriptor["physicalMoveType"]),
                "robot": str(descriptor["robot"]),
                "materialIds": list(descriptor["materialIds"]),
                "waferId": int(action.wafer_id),
                "stageIndex": int(action.stage_index),
                "source": str(descriptor["source"]),
                "sourceSlot": 0,
                "destination": str(descriptor["destination"]),
                "destinationSlot": 0,
                "stationSlot": int(descriptor["stationSlot"]),
                "intentCount": len(group["indices"]),
                "intentActionIds": [
                    str(actions[index].action_id) for index in group["indices"]
                ],
                "intentSource": str(action.source_station or ""),
                "intentDestination": str(action.destination_station),
                "intentDestinationSlot": int(action.destination_slot),
                "earliestStart": float(descriptor["earliestStart"]),
                "finishTime": float(descriptor["finishTime"]),
                "rank": ranked_group_indices.index(group_index) + 1,
                "selected": group_index == selected_group_index,
                "executed": group_index == executed_group_index,
                "policyScore": float(group["policyScore"]),
                "policyPreference": float(group["probability"]),
                "expectedRemainingMakespan": float(np.mean(values)),
                "medianRemainingMakespan": float(np.median(values)),
                "lowerRemainingMakespan": float(values[margin]),
                "upperRemainingMakespan": float(values[-margin - 1]),
                "makespanDelta": max(
                    0.0,
                    float(group["remainingMean"]) - best_remaining,
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
        return {
            "decisionIndex": completed_intents,
            "time": replay_time,
            "revision": int(state.revision),
            "selectedActionId": str(
                groups[selected_group_index]["descriptor"]["actionId"]
            ),
            "executedActionId": (
                str(groups[executed_group_index]["descriptor"]["actionId"])
                if executed_group_index is not None
                else ""
            ),
            "selectedIntentActionId": str(actions[selected_index].action_id),
            "executedIntentActionId": executed_action_id,
            "candidateCount": len(groups),
            "shownCandidateCount": len(candidates),
            "candidatesTruncated": len(groups) > len(candidates),
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
        """用后续运输 Move 序列识别原 MoveList 在当前状态选择的联合意图。"""
        future_moves = [
            move
            for move in sorted(
                self.moves,
                key=lambda item: (
                    float(item.get("StartTime") or 0.0),
                    int(item.get("MoveID") or 0),
                ),
            )
            if (
                int(move.get("MoveType", -1)) in TRANSPORT_MOVE_TYPES
                and float(move.get("StartTime") or 0.0)
                >= cutoff - TIME_TOLERANCE_SECONDS
            )
        ]
        for action in actions:
            preview = [
                dict(move)
                for move in action.move_preview
                if int(move.get("MoveType", -1)) in TRANSPORT_MOVE_TYPES
            ]
            if not preview:
                continue
            action_materials = {str(value) for value in action.material_ids}
            related_future = [
                move
                for move in future_moves
                if action_materials.intersection(
                    str(value) for value in self._move_material_ids(move)
                )
            ]
            comparison_count = min(2, len(preview), len(related_future))
            if comparison_count and all(
                self._transport_signature(preview[index])
                == self._transport_signature(related_future[index])
                for index in range(comparison_count)
            ):
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
        )
