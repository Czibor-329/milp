"""平台 MoveID、前驱关系与增量历史校验测试。"""

from __future__ import annotations

from types import SimpleNamespace

from realtime_scheduler.backend.validation.move_validation import (
    ATMOSPHERE,
    VACUUM,
    DoorState,
    LoadLockState,
    MachineState,
    MaterialState,
    MoveStateReplay,
    RobotState,
    SlotPhase,
    SlotState,
    ValidationErrorCode,
    validate_move_list,
)
from tests.support.move_validation_fixtures import (
    dual_chamber_update as _dual_chamber_update,
    move as _move,
)

def test_validation_error_codes_are_unique_and_non_object_moves_are_coded() -> None:
    """每类输出校验错误都必须有唯一稳定码，非法 Move 元素也不能抛普通异常。"""
    codes = [error_code.value for error_code in ValidationErrorCode]

    assert len(codes) == len(set(codes))
    assert validate_move_list(None, ["invalid"], {}) == [
        "[MVL-FMT-001] MoveList[0] 必须是 JSON 对象"
    ]

def test_dependency_rejects_missing_predecessor() -> None:
    """PreMoveID 引用不存在的 MoveID 必须在平台侧失败。"""
    moves = [
        _move(
            1,
            5,
            0,
            1,
            ModuleName="VACRobot",
            SrcStationList=["PM1"],
            DestStationList=["LL1"],
            RobotSlotList=[1],
            MatIDList=[],
            PreMoveID=[999],
        )
    ]

    issues = validate_move_list(None, moves, _dual_chamber_update())

    assert "不存在的 MoveID=999" in issues[0]

def test_dependency_rejects_cycle() -> None:
    """PreMoveID DAG 中的环不能依赖时间排序侥幸通过。"""
    moves = [
        _move(1, 10, 0, 0, ModuleName="LL1", MatIDList=[], PreMoveID=[2]),
        _move(2, 10, 0, 0, ModuleName="LL1", MatIDList=[], PreMoveID=[1]),
    ]

    issues = validate_move_list(None, moves, _dual_chamber_update())

    assert "依赖环" in issues[0]

def test_dependency_rejects_predecessor_finishing_after_child_starts() -> None:
    """即使拓扑无环，前驱未完成时也不能启动后继 Move。"""
    moves = [
        _move(1, 10, 0, 5, ModuleName="LL1", MatIDList=[]),
        _move(2, 10, 2, 3, ModuleName="LL1", MatIDList=[], PreMoveID=[1]),
    ]

    issues = validate_move_list(None, moves, _dual_chamber_update())

    assert "前驱 MoveID=1 尚未结束" in issues[0]

def _single_pm_update() -> dict:
    """创建单 PM、无机器人的最小设备快照。"""
    return {
        "Stations": {
            "PM1": {"Type": "ProcessChamber", "Capacity": 1},
        },
        "Robots": {},
        "Materials": [],
    }

def test_recompute_incremental_output_may_reference_committed_predecessors() -> None:
    """重算增量输出引用旧代已提交 Move 作为前驱必须通过校验。"""
    moves = [
        _move(101, 6, 4, 5, ModuleName="PM1", PreMoveID=[1]),
        _move(102, 6, 5, 6, ModuleName="PM1", PreMoveID=[101, 2]),
    ]
    external_predecessors = {
        1: _move(1, 6, 0, 1, ModuleName="PM1"),
        2: _move(2, 6, 1, 2, ModuleName="PM1"),
    }

    issues = validate_move_list(
        None,
        moves,
        _single_pm_update(),
        external_predecessors=external_predecessors,
    )

    assert issues == []

def test_recompute_external_predecessor_does_not_join_dependency_cycle() -> None:
    """外部前驱是已完成历史，不能因为其 ID 不在本代而误报依赖环。"""
    moves = [
        _move(101, 6, 4, 5, ModuleName="PM1", PreMoveID=[1]),
        _move(102, 6, 5, 6, ModuleName="PM1", PreMoveID=[101]),
    ]
    external_predecessors = {
        1: _move(1, 6, 0, 1, ModuleName="PM1"),
    }

    issues = validate_move_list(
        None,
        moves,
        _single_pm_update(),
        external_predecessors=external_predecessors,
    )

    assert issues == []

def test_recompute_external_predecessor_still_requires_finished_time() -> None:
    """外部前驱虽合法，但其 EndTime 晚于本动作 StartTime 时仍须报时间冲突。"""
    moves = [
        _move(101, 6, 2, 3, ModuleName="PM1", PreMoveID=[1]),
    ]
    external_predecessors = {
        1: _move(1, 6, 0, 5, ModuleName="PM1"),
    }

    issues = validate_move_list(
        None,
        moves,
        _single_pm_update(),
        external_predecessors=external_predecessors,
    )

    assert issues
    assert "前驱 MoveID=1 尚未结束" in issues[0]

def test_recompute_still_rejects_reference_outside_committed_history() -> None:
    """即使允许外部前驱，引用既不在本代也不在已提交历史的 ID 仍须失败。"""
    moves = [
        _move(101, 6, 2, 3, ModuleName="PM1", PreMoveID=[999]),
    ]
    external_predecessors = {
        1: _move(1, 6, 0, 1, ModuleName="PM1"),
    }

    issues = validate_move_list(
        None,
        moves,
        _single_pm_update(),
        external_predecessors=external_predecessors,
    )

    assert issues
    assert "不存在的 MoveID=999" in issues[0]
