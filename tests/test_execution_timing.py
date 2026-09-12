"""设备实际执行时间配置、波动开关与依赖推进回归测试。"""

from __future__ import annotations

import pytest

from realtime_scheduler.backend.execution.move_timing import (
    execution_duration,
    normalize_execution_timing,
    sample_init_execution_timing,
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


@pytest.mark.parametrize("enabled", [False, True])
def test_runtime_uses_execution_timing_as_only_materialization_switch(monkeypatch, enabled: bool) -> None:
    """首排和重算均只根据实际时间配置推进，不需要独立兼容参数。"""
    from realtime_scheduler.backend.execution.algorithm_runtime import PlatformMoveListRuntime

    calls = []

    def capture_materialization(self, moves, clock_floor):
        """记录是否跨过实际时间边界，空计划避免混入物理动作校验语义。"""
        calls.append(clock_floor)
        return moves

    monkeypatch.setattr(PlatformMoveListRuntime, "_materialize_moves", capture_materialization)
    runtime = PlatformMoveListRuntime(
        {"CurrentTime": 0}, {"MoveList": []},
        execution_timing={"mode": "fluctuation"} if enabled else None,
    )
    runtime.replace_plan({"CurrentTime": 12}, {"MoveList": []}, 12, "time", [])
    assert runtime.module_parallel is enabled
    assert calls == ([0.0, 12.0] if enabled else [])


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
    move = {"MoveID": 11, "RequestID": 3, "MoveType": 0, "ModuleName": "VTR", "SrcStationList": ["PM1"], "StartTime": 2.0, "EndTime": 12.0}
    first = execution_duration(move, device, timing, 42)
    second = execution_duration(move, device, timing, 42)
    assert first == second
    assert 8.0 <= first <= 12.0


def test_runtime_materialization_preserves_plan_for_gantt() -> None:
    """运行时应用固定偏移后应保留原始起止时间，且不修改算法输出。"""
    from realtime_scheduler.backend.execution.algorithm_runtime import PlatformMoveListRuntime

    runtime = PlatformMoveListRuntime.__new__(PlatformMoveListRuntime)
    runtime.device = _device()
    runtime.execution_timing = normalize_execution_timing(runtime.device, {
        "mode": "fluctuation",
        "fluctuation": {"kind": "offset", "minimumOffsetSeconds": 2, "maximumOffsetSeconds": 2},
    })
    runtime.execution_timing_seed = 42
    moves = [{"MoveID": 1, "MoveType": 0, "ModuleName": "VTR", "SrcStationList": ["PM1"], "StartTime": 10.0, "EndTime": 20.0}]
    actual = runtime._materialize_moves(moves, 12.0)
    assert (actual[0]["StartTime"], actual[0]["EndTime"]) == (12.0, 24.0)
    assert (actual[0]["PlannedStartTime"], actual[0]["PlannedEndTime"]) == (10.0, 20.0)
    assert moves[0]["StartTime"] == 10.0
    assert "PlannedStartTime" not in moves[0]


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


def test_fluctuation_only_changes_init_durations_and_shifts_route_process() -> None:
    """设备取片可变慢；依赖它的 Route 加工只平移，不能改变加工长度。"""
    device = _device()
    moves = [
        {"MoveID": 1, "MoveType": 0, "ModuleName": "VTR", "SrcStationList": ["PM1"], "StartTime": 0, "EndTime": 10},
        {"MoveID": 2, "MoveType": 9, "ModuleName": "PM1", "PreMoveID": [1], "StartTime": 10, "EndTime": 30},
    ]
    for fluctuation in [
        {"kind": "offset", "minimumOffsetSeconds": 2, "maximumOffsetSeconds": 2},
        {"kind": "ratio", "ratio": 0.5},
    ]:
        timing = normalize_execution_timing(device, {"mode": "fluctuation", "fluctuation": fluctuation})
        assert execution_duration(moves[1], device, timing, 7) == 20
        unknown = {**moves[0], "SrcStationList": ["UNKNOWN"]}
        assert execution_duration(unknown, device, timing, 7) == 10
        actual = materialize_module_parallel_moves(
            moves, duration_resolver=lambda move: execution_duration(move, device, timing, 7),
        )
        process = next(move for move in actual if move["MoveID"] == 2)
        assert process["EndTime"] - process["StartTime"] == 20
        if fluctuation["kind"] == "offset":
            assert (process["StartTime"], process["EndTime"]) == (12, 32)


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


def test_ratio_per_init_reuses_field_across_moves_and_generations() -> None:
    """init 固定抽样只依赖字段和 seed，重新排程不会换值，也不读取固定模式覆盖值。"""
    device = _device()
    timing = normalize_execution_timing(device, {
        "mode": "fluctuation", "fluctuation": {"kind": "ratio", "ratio": 0.3, "samplingMode": "per-init"},
        "robots": {"VTR": {"PickTime": {"PM1": 999}}},
    })
    sampled = sample_init_execution_timing(device, timing, 42)
    assert sampled == sample_init_execution_timing(device, timing, 42)
    assert sampled != sample_init_execution_timing(device, timing, 43)
    expected = sampled["robots"]["VTR"]["PickTime"]["PM1"]
    assert 7 <= expected <= 13
    for request, move_id in [(1, 1), (1, 20), (2, 40)]:
        move = {"MoveID": move_id, "RequestID": request, "ModuleName": "VTR", "MoveType": 0,
                "SrcStationList": ["PM1"], "StartTime": 0, "EndTime": 10}
        assert execution_duration(move, device, sampled, 42) == expected
        assert execution_duration(move, device, timing, 42) == expected
    process = {"MoveID": 100, "ModuleName": "PM1", "MoveType": 9, "StartTime": 0, "EndTime": 50}
    assert execution_duration(process, device, sampled, 42) == 50
    timing["fluctuation"]["samplingMode"] = "per-move"
    first = execution_duration(move, device, timing, 42)
    assert execution_duration({**move, "MoveID": 999}, device, timing, 42) != first
    assert device["Robots"]["VTR"]["PickTime"]["PM1"] == 10


def test_shorter_moves_advance_successors_without_changing_process_duration() -> None:
    """缩短动作解锁多个后继，同模块串行、多前驱和重算下界仍生效。"""
    moves = [
        {"MoveID": 1, "ModuleName": "A", "StartTime": 10, "EndTime": 20},
        {"MoveID": 2, "ModuleName": "B", "StartTime": 20, "EndTime": 30, "PreMoveID": [1]},
        {"MoveID": 3, "ModuleName": "A", "StartTime": 20, "EndTime": 22},
        {"MoveID": 4, "ModuleName": "C", "StartTime": 30, "EndTime": 35, "PreMoveID": [2, 3]},
    ]
    actual = materialize_module_parallel_moves(moves, 12, lambda move: 5 if move["MoveID"] == 1 else move["EndTime"] - move["StartTime"])
    times = {move["MoveID"]: (move["StartTime"], move["EndTime"]) for move in actual}
    assert times == {1: (12, 17), 2: (17, 27), 3: (17, 19), 4: (27, 32)}
    assert moves[1]["StartTime"] == 20


def test_v8_sampling_migration_defaults_to_per_move_and_is_idempotent() -> None:
    """v8 的比例和执行值保留，v9 仅补抽样口径且可重复执行。"""
    device = _device()
    timing = normalize_execution_timing(device, {"mode": "fluctuation", "fluctuation": {"ratio": 0.2}})
    timing["fluctuation"].pop("samplingMode")
    device["ExecutionTiming"] = timing
    catalog = {"version": 8, "devices": [{"id": "test", "device": device, "routes": [], "tests": []}]}
    assert _migrate_workspace_catalog(catalog)
    assert catalog["version"] == 9
    assert timing["fluctuation"]["samplingMode"] == "per-move"
    assert timing["fluctuation"]["ratio"] == 0.2
    assert not _migrate_workspace_catalog(catalog)


def test_v8_directory_upgrade_keeps_single_recoverable_backup(tmp_path) -> None:
    """v8 目录在改写之前整体备份，重复备份不会覆盖原始配置。"""
    import json
    from realtime_scheduler.backend.workspace.repository import _backup_workspace_directory_before_upgrade

    directory = tmp_path / "datasets"
    directory.mkdir()
    manifest = {"kind": "ct-scheduler-datasets", "schemaVersion": 8}
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    metadata = {"ExecutionTiming": {"fluctuation": {"kind": "ratio", "ratio": 0.2}}}
    (directory / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    backup = _backup_workspace_directory_before_upgrade(directory)
    assert backup is not None
    assert _backup_workspace_directory_before_upgrade(directory) == backup
    assert json.loads((backup / "metadata.json").read_text(encoding="utf-8")) == metadata


def test_unknown_sampling_mode_is_rejected() -> None:
    """错误口径不能静默退回逐动作抽样。"""
    import pytest

    with pytest.raises(ValueError, match="抽样口径"):
        normalize_execution_timing(_device(), {"fluctuation": {"samplingMode": "unknown"}})


def test_early_execution_preserves_planned_wait_after_predecessor() -> None:
    """缩短前驱允许提前，但不可消除原计划中前驱完成后的等待。"""
    moves = [
        {"MoveID": 1, "ModuleName": "A", "StartTime": 0, "EndTime": 10},
        {"MoveID": 2, "ModuleName": "B", "StartTime": 15, "EndTime": 25, "PreMoveID": [1]},
    ]
    result = materialize_module_parallel_moves(moves, duration_resolver=lambda move: 5 if move["MoveID"] == 1 else 10)
    assert (result[1]["StartTime"], result[1]["EndTime"]) == (10, 20)
