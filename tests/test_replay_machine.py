"""拓扑回放算法动作接口与返回值规范化测试。"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from realtime_scheduler.backend.validation.replay_machine import ReplayMachine
from realtime_scheduler.backend.algorithms import interface as algorithm_interface
from realtime_scheduler.backend.execution.plan_builder import extract_init_data
from tests.test_config_editor_server import DEVICE_PATH, _job, _route


def test_missing_algorithm_action_interface_keeps_action_card_empty() -> None:
    """算法未提供动作接口时不得使用平台状态机补算候选。"""
    machine = ReplayMachine(
        _heuristic_replay_plan(),
        [],
    )

    decision = machine.evaluate_actions(0.0)

    assert decision["actionDiagnosticsSource"] == "unavailable"
    assert decision["actionDiagnostics"] == []
    assert decision["actionCounts"] == {
        "deadlock-blocked": 0,
        "enabled": 0,
        "physical-blocked": 0,
    }


def test_algorithm_action_interface_accepts_only_three_action_kinds() -> None:
    """回放协议只保留 Pick、Place、Swap 及稳定的拦截分类。"""
    machine = ReplayMachine(
        _heuristic_replay_plan(),
        [],
        algorithm_action_diagnostics={
            "provider": "fixture",
            "actions": [
                {"actionId": "p1", "kind": "pick", "status": "enabled"},
                {
                    "actionId": "p2",
                    "kind": "place",
                    "status": "physical-blocked",
                    "reason": "目标槽已满",
                },
                {
                    "actionId": "s1",
                    "kind": "swap",
                    "status": "deadlock-blocked",
                    "reason": "无回程槽",
                },
                {"actionId": "x1", "kind": "process", "status": "enabled"},
            ],
        },
    )

    decision = machine.evaluate_actions(0.0)

    assert decision["actionDiagnosticsSource"] == "algorithm"
    assert decision["actionDiagnosticsProvider"] == "fixture"
    assert [row["kind"] for row in decision["actionDiagnostics"]] == [
        "pick",
        "place",
        "swap",
    ]
    assert decision["actionCounts"] == {
        "deadlock-blocked": 1,
        "enabled": 1,
        "physical-blocked": 1,
    }


def test_optional_algorithm_action_function_returns_none_when_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """旧算法入口不含新函数时适配层应显式返回 None。"""
    monkeypatch.setattr(
        algorithm_interface,
        "_load_entry_module",
        lambda: SimpleNamespace(),
    )

    assert algorithm_interface.get_replay_actions({"CurrentTime": 0}) is None


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
