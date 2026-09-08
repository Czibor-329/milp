"""死锁诊断包结构与下载内容测试。"""

from __future__ import annotations

import json
from pathlib import Path

from realtime_scheduler.backend.artifacts.deadlock_diagnostic import (
    build_deadlock_diagnostic_bundle,
    serialize_deadlock_diagnostic_bundle,
)


def test_bundle_collects_state_routes_recent_moves_and_exact_blocker() -> None:
    """诊断包应同时保留晶圆阶段、当前动作状态和带资源定位的拦截规则。"""
    route = {
        "RouteSteps": [
            {"StepID": 0, "Visits": [{"StationName": "LP1"}]},
            {"StepID": 1, "Visits": [{"StationName": "VTR"}]},
            {"StepID": 2, "Visits": [{"StationName": "PM1"}]},
        ]
    }
    moves = [
        {
            "MoveID": index,
            "MoveType": 0,
            "StartTime": float(index),
            "EndTime": float(index) + 0.5,
            "ModuleName": "VTR",
            "MatIDList": [101],
            "StepIDList": [1],
        }
        for index in range(1, 24)
    ]
    decision = {
        "actionDiagnosticsProvider": "heuristic-machine",
        "actionDiagnosticsSource": "algorithm",
        "actionCounts": {"enabled": 0, "physical-blocked": 1},
        "actionDiagnostics": [{
            "actionId": "place:101:VTR:1:LA:2",
            "kind": "place",
            "status": "physical-blocked",
            "reason": "晶圆下一工序仅允许 PM1/PM2/PM3",
            "robot": "VTR",
            "materialIds": ["101"],
            "source": "VTR",
            "sourceSlot": 1,
            "destination": "LA",
            "destinationSlot": 2,
        }],
    }

    bundle = build_deadlock_diagnostic_bundle(
        replay_time=22.25,
        plan={"strategy": "heuristic", "device": {}, "rounds": []},
        moves=moves,
        update_params={
            "CurrentTime": 20,
            "Materials": [{
                "ID": 101,
                "TaskID": "LP1.1",
                "StepID": 1,
                "CurrentModuleName": "VTR",
                "Route": route,
            }],
        },
        move_states=[{"MoveID": 22, "MoveState": "Running"}],
        decision=decision,
        recompute_round=3,
        playback_snapshot={
            "robots": [{"name": "VTR", "wafers": ["LP1.1"]}],
            "modules": [{"name": "LA", "wafers": ["LP1.2"]}],
        },
        result_id="result-1",
    )

    assert bundle["schemaVersion"] == 1
    assert bundle["replay"]["recomputeRound"] == 3
    assert bundle["replay"]["moveStates"] == [{"MoveID": 22, "MoveState": "Running"}]
    assert len(bundle["recentMoves"]) == 20
    assert bundle["recentMoves"][0]["MoveID"] == 22
    material = bundle["currentState"]["materials"][0]
    assert material["rawStepId"] == 1
    assert material["internalStageIndex"] == 1
    assert material["routeSteps"][2]["stations"] == ["PM1"]
    blocker = bundle["candidateActions"]["actions"][0]["blocker"]
    assert blocker == {
        "category": "physical-blocked",
        "rule": "晶圆下一工序仅允许 PM1/PM2/PM3",
        "materials": ["101"],
        "robot": "VTR",
        "source": "VTR",
        "sourceSlot": 1,
        "destination": "LA",
        "destinationSlot": 2,
    }


def test_bundle_serialization_uses_readable_download_name() -> None:
    """下载文件应为可读 UTF-8 JSON，并在名称中标识结果和回放毫秒。"""
    content, file_name = serialize_deadlock_diagnostic_bundle(
        {"schemaVersion": 1, "message": "死锁"},
        replay_time=43.1,
        result_id="test result/1",
    )

    assert file_name == "deadlock-diagnostic-test-result-1-43100ms.json"
    assert json.loads(content.decode("utf-8"))["message"] == "死锁"


def test_topology_toolbar_exposes_deadlock_diagnostic_download() -> None:
    """真实页面应提供诊断包按钮，前端通过专用分析接口下载文件。"""
    repository_root = Path(__file__).resolve().parents[1]
    html = (
        repository_root / "realtime_scheduler/frontend/config_editor.html"
    ).read_text(encoding="utf-8")
    client_source = (
        repository_root / "realtime_scheduler/frontend/src/api_client.ts"
    ).read_text(encoding="utf-8")

    assert 'id="visualExportDeadlockDiagnostic"' in html
    assert "/api/analysis/deadlock-diagnostic" in client_source
