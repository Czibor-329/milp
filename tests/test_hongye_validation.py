"""HongYe 完整日志校验、兼容推进与运行设置的回归测试。"""

from pathlib import Path
from unittest.mock import patch

from realtime_scheduler.backend import application as scheduler_application
from realtime_scheduler.backend.execution import service as execution_service
from realtime_scheduler.backend.execution.batch_service import build_workspace_batch_plan
from realtime_scheduler.backend.execution.run_state import ReproductionLog, _planned_events
from realtime_scheduler.backend.validation.move_validation import materialize_module_parallel_moves
from realtime_scheduler.backend.validation.hongye.log_validator import HongYeLogValidator

ROOT = Path(__file__).resolve().parents[1]


def test_runtime_contains_original_checkminlog_module() -> None:
    """运行目录包含原始 MoveStateSim 及 CheckMinLog 所需依赖。"""
    runtime = ROOT / "realtime_scheduler" / "backend" / "validation" / "hongye" / "runtime"
    required = {"MoveStateSim.exe", "MoveStateSim.exe.config", "Newtonsoft.Json.dll", "SchedulerStandardInterface.dll", "SchStateLib.dll"}
    assert required == {path.name for path in runtime.iterdir() if path.is_file()}


def test_complete_log_is_sent_to_new_validator_once() -> None:
    """新版原始模块应直接校验完整多代日志，不再截取末代二次复核。"""
    entries = [
        {"Describe": "AlgInit", "Info": {"Robots": {}, "Stations": {}}},
        {"Describe": "AlgSchedule", "Info": {"CurrentTime": 0}},
        {"Describe": "AlgOutput", "Info": {"MoveList": [{"MoveID": 1}]}},
        {"Describe": "AlgUpdateMove", "Info": {"MoveID": 1, "MoveState": 1}},
        {"Describe": "AlgSchedule", "Info": {"CurrentTime": 10}},
        {"Describe": "AlgOutput", "Info": {"MoveList": [{"MoveID": 578}]}},
    ]
    validator = HongYeLogValidator.__new__(HongYeLogValidator)
    with patch.object(
        validator,
        "_run_original_validator",
        return_value={"success": True, "errors": 0},
    ) as run_original:
        result = validator.validate(entries)

    assert result == {"success": True, "errors": 0}
    run_original.assert_called_once_with(entries)


def test_reproduction_log_keeps_all_events_for_full_log_check() -> None:
    """完整日志应保留 Input、重算通知和所有 AlgUpdateMove。"""
    reproduction = ReproductionLog()
    reproduction.add("Input", [{"skipValidation": False}])
    reproduction.add("AlgInit", {"Stations": {}, "Robots": {}})
    reproduction.add("AlgSchedule", {"CurrentTime": 0})
    reproduction.add("AlgUpdateMove", {"MoveID": 1, "MoveState": 1})
    assert [entry["Describe"] for entry in reproduction.entries] == ["Input", "AlgInit", "AlgSchedule", "AlgUpdateMove"]


def test_hongye_receives_original_terminal_generation_output() -> None:
    """甘特图累计历史不得覆盖最后一代算法输出后再交给原始校验器。"""
    captured: list[dict] = []

    class RecordingValidator:
        """记录传入 MoveStateSim 的完整日志。"""

        def validate(self, entries):
            """保存深层字段足够本测试断言，并返回成功摘要。"""
            captured.extend(entries)
            return {"success": True, "errors": 0, "advance": "module-parallel"}

    def fake_execute(_plan, reproduction):
        """模拟末代原始输出与包含历史动作的甘特图累计输出。"""
        reproduction.add("AlgOutput", {"MoveList": [{"MoveID": 200}]}, 10)
        return {
            "ok": True,
            "output": {"MoveList": [{"MoveID": 1}, {"MoveID": 200}]},
        }

    with (
        patch.object(execution_service, "_execute_plan", side_effect=fake_execute),
        patch.object(execution_service, "HongYeLogValidator", RecordingValidator),
    ):
        result = execution_service.execute_plan({"hongYeCheck": True})

    terminal = next(entry for entry in reversed(captured) if entry["Describe"] == "AlgOutput")
    assert terminal["Info"]["MoveList"] == [{"MoveID": 200}]
    assert result["output"]["MoveList"] == [{"MoveID": 1}, {"MoveID": 200}]


def test_module_parallel_delays_module_lane_and_premove_successor() -> None:
    """同模块及 PreMoveID 后继必须等待前序实际结束。"""
    moves = [{"MoveID": 1, "ModuleName": "A", "StartTime": 0, "EndTime": 10}, {"MoveID": 2, "ModuleName": "B", "StartTime": 1, "EndTime": 3, "PreMoveID": [1]}, {"MoveID": 3, "ModuleName": "A", "StartTime": 2, "EndTime": 4}, {"MoveID": 4, "ModuleName": "C", "StartTime": 1, "EndTime": 2}]
    times = {move["MoveID"]: (move["StartTime"], move["EndTime"]) for move in materialize_module_parallel_moves(moves)}
    assert times == {1: (0, 10), 2: (10, 12), 3: (10, 12), 4: (1, 2)}


def test_module_parallel_same_time_order_is_deterministic() -> None:
    """同刻先推进各 Module 队首，零时长结束后再解锁后继。"""
    moves = materialize_module_parallel_moves([
        {"MoveID": 3, "ModuleName": "A", "StartTime": 0, "EndTime": 0},
        {"MoveID": 2, "ModuleName": "B", "StartTime": 0, "EndTime": 1},
        {"MoveID": 4, "ModuleName": "A", "StartTime": 0, "EndTime": 1, "PreMoveID": [3]},
    ])
    events = [(kind, notification["MoveID"]) for kind, _time, notification in _planned_events(moves, module_parallel=True)]
    assert events == [("start", 3), ("start", 2), ("finish", 3), ("start", 4), ("finish", 2), ("finish", 4)]


def test_batch_plan_defaults_to_hongye_and_compatibility() -> None:
    """批量计划默认打开 HongYe Check 与兼容模式。"""
    device = {"name": "test", "device": {"Robots": {}, "Stations": {}}, "routes": [], "cleans": []}
    plan = build_workspace_batch_plan(device, {"rounds": [], "options": {}}, "heuristic", {})
    assert plan["hongYeCheck"] is True
    assert plan["compatibilityMode"] is True


def test_frontend_moves_run_options_into_settings_dialog() -> None:
    """开始运行区只保留设置按钮，四个选项在可访问 dialog 中。"""
    template = (ROOT / "realtime_scheduler" / "frontend" / "config_editor.html").read_text(encoding="utf-8")
    assert 'id="openRunSettingsButton"' in template
    assert 'id="runSettingsDialog"' in template
    assert 'id="compatibilityModeInput" type="checkbox" checked' in template
    assert "模块并行推进；按 PreMoveID 延后动作；缺失的开关门动作自动补齐。" in template
    assert "HongYe Check <em>（推荐）</em>" in template
    assert "Baseline 使用 Heuristic 结果作为性能基线" in template
    assert "不执行任何输出校验，仅用于调试。" in template


def test_all_recompute_notifications_are_recorded() -> None:
    """服务实现不应再按兼容模式抑制 AlgUpdateMove。"""
    source = (ROOT / "realtime_scheduler" / "backend" / "execution" / "service.py").read_text(encoding="utf-8")
    assert "if not compatibility_mode:\n                for notification" not in source
    assert 'reproduction.add(\n                    "AlgUpdateMove"' in source
