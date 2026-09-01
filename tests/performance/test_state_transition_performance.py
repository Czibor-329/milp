"""平台状态推进的确定性性能门禁。

本测试只计量平台 MoveList 状态机推进，不包含算法、HongYe、文件访问或前端。预算
来自 ``docs/performance/budgets.json``；超过预算即 pytest 失败，不能进入提交。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from realtime_scheduler.backend.execution.algorithm_runtime import (
    PlatformMoveListRuntime,
)
from realtime_scheduler.backend.execution.run_state import (
    advance_platform_move_list_to_update,
)


ROOT = Path(__file__).resolve().parents[2]
MOVE_COUNT = 1000
SAMPLE_COUNT = 5


def _state_transition_fixture() -> tuple[dict, dict]:
    """构造固定规模、物理合法的空腔 ProcessMove 时间线。"""
    update = {
        "CurrentTime": 0.0,
        "Materials": [],
        "ProcessJobs": [],
        "ControlJobs": [],
        "Routes": {},
        "Robots": {},
        "Stations": {"PM1": {"Type": "ProcessChamber", "Slots": [1]}},
    }
    moves = [{
        "MoveID": move_id,
        "MoveType": 9,
        "ModuleName": "PM1",
        "MatIDList": [],
        "SlotList": [1],
        "StartTime": float(move_id * 2),
        "EndTime": float(move_id * 2 + 1),
    } for move_id in range(1, MOVE_COUNT + 1)]
    return update, {"MoveList": moves, "Feedback": []}


def test_state_transition_1000_moves_p95_stays_within_budget() -> None:
    """1000 个 Move 的平台状态推进 P95 必须低于提交门禁预算。"""
    budget_ms = json.loads(
        (ROOT / "docs" / "performance" / "budgets.json").read_text(encoding="utf-8")
    )["absoluteMilliseconds"]["stateTransition1000MovesP95"]
    samples: list[float] = []
    for _ in range(SAMPLE_COUNT):
        update, output = _state_transition_fixture()
        runtime = PlatformMoveListRuntime(update, output)
        started = time.perf_counter()
        advance_platform_move_list_to_update(runtime, MOVE_COUNT * 2 + 2)
        samples.append((time.perf_counter() - started) * 1000.0)
    p95 = sorted(samples)[int((len(samples) - 1) * 0.95)]
    assert p95 <= budget_ms, f"状态推进 P95={p95:.1f} ms，超过预算 {budget_ms} ms"
