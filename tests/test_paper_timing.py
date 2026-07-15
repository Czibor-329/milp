"""论文式加工仓任务池启发式的纯函数测试。"""

from __future__ import annotations

import random

from src.model import Stage, Wafer
from src.timing.paper import (_cross_routes, _mutate_sequence,
                              _process_entry_hops, _sequence_priorities)


def _wafer(wid: int, route: str) -> Wafer:
    """构造 source→loadlock→process→loadlock→sink 的最小测试 wafer。"""
    stages = [
        Stage(0, "LP1", "source", 0, "", "ATR", -1),
        Stage(1, "LA", "loadlock", 10, "ATR", "VTR", -1, ll_type="entry"),
        Stage(2, "PM1", "process", 100, "VTR", "VTR", 30),
        Stage(3, "LA", "loadlock", 10, "VTR", "ATR", -1, ll_type="exit"),
        Stage(4, "LP1", "sink", 0, "ATR", "", -1),
    ]
    return Wafer(wid, wid, route, wid, stages, ["ATR", "VTR", "VTR", "ATR"])


def test_process_entry_hops_are_sorted_by_wafer_then_stage():
    """加工仓任务使用论文的晶圆序号、工序序号贪心顺序。"""
    assert _process_entry_hops([_wafer(2, "B"), _wafer(0, "A")]) == [(0, 1), (2, 1)]


def test_group_crossing_preserves_each_route_order():
    """分组交叉不能破坏任一 route 内部任务的原始顺序。"""
    grouped = {"A": [(0, 1), (1, 1), (2, 1)], "B": [(3, 1), (4, 1)]}
    crossed = _cross_routes(grouped, 2, ["A", "B"])
    assert crossed == [(0, 1), (1, 1), (3, 1), (4, 1), (2, 1)]


def test_task_rank_binds_release_entry_and_exit_hops():
    """同一加工任务秩同时约束最小必要发片、进入 PM 和离开 PM。"""
    priorities = _sequence_priorities([(3, 1), (7, 1)], spacing=5.0)
    assert priorities[(3, 0)] == 0.0
    assert priorities[(3, 1)] == 0.0
    assert priorities[(3, 2)] == 0.0
    assert priorities[(7, 0)] == 5.0
    assert priorities[(7, 1)] == 5.0
    assert priorities[(7, 2)] == 5.0


def test_sequence_mutation_keeps_exact_task_multiset():
    """所有邻域动作只能重排加工任务，不能丢失或复制任务。"""
    sequence = [(wid, 1) for wid in range(12)]
    for seed in range(30):
        candidate = _mutate_sequence(sequence, random.Random(seed))
        assert sorted(candidate) == sorted(sequence)
        assert len(candidate) == len(sequence)
