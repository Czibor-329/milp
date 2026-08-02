"""拓扑回放 Machine 与 E2E 实时评估的集成测试。

测试使用普通启发式 MoveList，证明候选和模型评分不依赖调度结果预先携带
DecisionTrace，同时覆盖生产 checkpoint 的真实前向。
"""

from __future__ import annotations

import json

import pytest

from realtime_scheduler.replay_machine import ReplayMachine
from realtime_scheduler.plan_builder import extract_init_data
from realtime_scheduler.server import E2E_CTQ_MODEL_PATH, execute_plan
from tests.test_config_editor_server import DEVICE_PATH, _job, _route


def _heuristic_replay_plan() -> dict:
    """构造包含两个并行 PM 候选的单轮启发式计划。"""
    return {
        "deviceName": DEVICE_PATH.name,
        "device": extract_init_data(
            json.loads(DEVICE_PATH.read_text(encoding="utf-8")),
        ),
        "strategy": "heuristic",
        "roundCount": 1,
        "options": {},
        "recipes": [{
            "name": "ReplayRecipe",
            "time": 40,
            "modules": ["PM1", "PM2"],
            "weight": {},
        }],
        "cleans": [],
        "routes": [_route("ReplayRoute", "PM1,PM2", "ReplayRecipe")],
        "rounds": [{
            "currentTime": 0,
            "jobs": [{
                **_job("ReplayJob", "ReplayRoute", "LP1"),
                "waferCount": 2,
            }],
        }],
    }


@pytest.mark.skipif(
    not E2E_CTQ_MODEL_PATH.is_file(),
    reason="生产 E2E-CTQ checkpoint 不存在",
)
def test_heuristic_movelist_is_evaluated_by_live_e2e_machine() -> None:
    """非 E2E 输出也应在完整事务边界得到合法意图和真实模型分数。"""
    plan = _heuristic_replay_plan()
    result = execute_plan(plan)
    assert "DecisionTrace" not in result["output"]
    moves = result["output"]["MoveList"]
    machine = ReplayMachine(plan, moves, E2E_CTQ_MODEL_PATH)

    decision = machine.evaluate(0.0)

    assert decision["replayEvaluated"] is True
    assert decision["modelEvaluated"] is True
    assert decision["decisionIndex"] == 0
    assert decision["candidateCount"] == 2
    assert decision["selectedActionId"]
    assert decision["executedActionId"]
    assert sum(
        candidate["policyPreference"]
        for candidate in decision["candidates"]
    ) == pytest.approx(1.0)
    assert {
        (candidate["source"], candidate["destination"])
        for candidate in decision["candidates"]
    } == {("LP1", "LA"), ("LP1", "LB")}
    assert all(
        candidate["source"] != candidate["robot"]
        and candidate["destination"] != candidate["robot"]
        and candidate["destinationSlot"] > 0
        for candidate in decision["candidates"]
    )

    first_pick = min(
        (
            move for move in moves
            if int(move.get("MoveType", -1)) in {0, 2}
        ),
        key=lambda move: float(move.get("EndTime") or 0.0),
    )
    first_place = min(
        (
            move for move in moves
            if int(move.get("MoveType", -1)) in {1, 3}
        ),
        key=lambda move: float(move.get("EndTime") or 0.0),
    )
    during_transaction = machine.evaluate(float(first_pick["EndTime"]))
    next_decision = machine.evaluate(float(first_place["EndTime"]))

    assert during_transaction["decisionIndex"] == 0
    assert next_decision["decisionIndex"] == 1
    assert next_decision["time"] == pytest.approx(first_place["EndTime"])
    assert {
        (candidate["source"], candidate["destination"])
        for candidate in next_decision["candidates"]
    } == {("LP1", "LA"), ("LB", "PM1"), ("LB", "PM2")}


@pytest.mark.skipif(
    not E2E_CTQ_MODEL_PATH.is_file(),
    reason="生产 E2E-CTQ checkpoint 不存在",
)
def test_live_candidates_keep_full_intents_with_distinct_place_targets() -> None:
    """相同 Pick 但 Place 目标不同的完整事务必须保留为独立候选。"""
    plan = _heuristic_replay_plan()
    result = execute_plan(plan)
    decision = ReplayMachine(
        plan,
        result["output"]["MoveList"],
        E2E_CTQ_MODEL_PATH,
    ).evaluate(0.0)

    assert {
        (candidate["source"], candidate["destination"])
        for candidate in decision["candidates"]
    } == {("LP1", "LA"), ("LP1", "LB")}
    assert decision["candidateCount"] == 2
    assert len({
        candidate["actionId"]
        for candidate in decision["candidates"]
    }) == 2
    assert all(
        "physicalMoveType" not in candidate
        and "intentCount" not in candidate
        for candidate in decision["candidates"]
    )
    assert sum(
        candidate["policyPreference"]
        for candidate in decision["candidates"]
    ) == pytest.approx(1.0)


@pytest.mark.skipif(
    not E2E_CTQ_MODEL_PATH.is_file(),
    reason="生产 E2E-CTQ checkpoint 不存在",
)
def test_recompute_uses_saved_machine_update_as_replay_boundary() -> None:
    """多轮结果应从第二代真实 Machine update 继续回放，而不重复首轮 Move。"""
    plan = _heuristic_replay_plan()
    plan["roundCount"] = 2
    plan["rounds"].append({
        "currentTime": 70,
        "jobs": [{
            **_job("ReplayJob2", "ReplayRoute", "LP2"),
            "waferCount": 1,
        }],
    })
    result = execute_plan(plan)
    assert len(result["updates"]) == 2

    decision = ReplayMachine(
        plan,
        result["output"]["MoveList"],
        E2E_CTQ_MODEL_PATH,
        result["updates"],
    ).evaluate(float(result["updates"][1]["CurrentTime"]))

    assert decision["replayEvaluated"] is True
    assert decision["candidateCount"] >= 1
