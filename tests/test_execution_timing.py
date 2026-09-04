"""设备实际执行时间配置与兼容推进回归测试。"""

from __future__ import annotations

from realtime_scheduler.backend.execution.move_timing import (
    execution_duration,
    normalize_execution_timing,
)
from realtime_scheduler.backend.validation.move_validation import (
    materialize_module_parallel_moves,
)
from realtime_scheduler.backend.workspace.repository import _migrate_workspace_catalog


def _device() -> dict:
    """构造包含一项机器手理论取片时间的最小设备。"""
    return {
        "Stations": {"PM1": {}},
        "Robots": {
            "VTR": {
                "PickTime": {"PM1": 10.0},
                "PlaceTime": {"PM1": 8.0},
                "PrepTransTime": [],
            },
        },
    }


def test_fixed_execution_time_delays_premove_successor() -> None:
    """固定执行值应替代理论时长，并把延迟传播给其他模块的后继 Move。"""
    device = _device()
    timing = normalize_execution_timing(device, {
        "mode": "fixed",
        "robots": {"VTR": {"PickTime": {"PM1": 15.0}}},
    })
    moves = [
        {"MoveID": 1, "MoveType": 0, "ModuleName": "VTR", "SrcStationList": ["PM1"], "StartTime": 0.0, "EndTime": 10.0},
        {"MoveID": 2, "MoveType": 9, "ModuleName": "PM1", "PreMoveID": [1], "StartTime": 5.0, "EndTime": 7.0},
    ]
    actual = materialize_module_parallel_moves(
        moves,
        duration_resolver=lambda move: execution_duration(move, device, timing, 7),
    )
    by_id = {move["MoveID"]: move for move in actual}
    assert (by_id[1]["StartTime"], by_id[1]["EndTime"]) == (0.0, 15.0)
    assert (by_id[2]["StartTime"], by_id[2]["EndTime"]) == (15.0, 17.0)


def test_ratio_fluctuation_is_seeded_and_within_configured_range() -> None:
    """比例波动应以理论时长为均值范围，并在相同 seed 下完全可复现。"""
    device = _device()
    timing = normalize_execution_timing(device, {
        "mode": "fluctuation",
        "fluctuation": {"kind": "ratio", "ratio": 0.2},
    })
    move = {"MoveID": 11, "RequestID": 3, "MoveType": 9, "ModuleName": "PM1", "StartTime": 2.0, "EndTime": 12.0}
    first = execution_duration(move, device, timing, 42)
    second = execution_duration(move, device, timing, 42)
    assert first == second
    assert 8.0 <= first <= 12.0


def test_offset_fluctuation_rejects_reversed_bounds() -> None:
    """绝对波动的最小值不得大于最大值。"""
    device = _device()
    try:
        normalize_execution_timing(device, {
            "mode": "fluctuation",
            "fluctuation": {
                "kind": "offset",
                "minimumOffsetSeconds": 2,
                "maximumOffsetSeconds": -1,
            },
        })
    except ValueError as error:
        assert "最小波动不能大于最大波动" in str(error)
    else:
        raise AssertionError("反向波动上下限应被拒绝")


def test_v7_workspace_migration_adds_safe_execution_defaults_idempotently() -> None:
    """v7 设备应补齐等于理论值的执行配置，重复迁移不得继续改写。"""
    catalog = {
        "version": 7,
        "devices": [{"id": "device-1", "device": _device(), "routes": [], "tests": []}],
    }
    assert _migrate_workspace_catalog(catalog)
    execution = catalog["devices"][0]["device"]["ExecutionTiming"]
    assert execution["mode"] == "fixed"
    assert execution["robots"]["VTR"]["PickTime"]["PM1"] == 10.0
    assert not _migrate_workspace_catalog(catalog)
