"""HongYe 增量输出校验器及平台选择开关的回归测试。"""

from __future__ import annotations

import os
from pathlib import Path
import unittest
from unittest.mock import Mock

from realtime_scheduler.batch_service import build_workspace_batch_plan
from realtime_scheduler.server import MoveListValidationError, ReproductionLog
from realtime_scheduler.validation.hongye import HongYeValidationSession


RUNTIME_DIR = (
    Path(__file__).resolve().parents[1]
    / "realtime_scheduler"
    / "validation"
    / "hongye"
    / "runtime"
)


def _minimal_events(move_list: list[dict]) -> list[dict]:
    """构造不依赖设备数据文件的最小合法事件前缀。"""
    return [
        {
            "Describe": "AlgInit",
            "SimTime": 0,
            "Info": {"Robots": {}, "Stations": {}},
        },
        {
            "Describe": "AlgSchedule",
            "SimTime": 0,
            "Info": {
                "CurrentTime": 0,
                "Robots": {},
                "Stations": {},
                "Materials": [],
            },
        },
        {
            "Describe": "AlgOutput",
            "SimTime": 0,
            "Info": {"MoveList": move_list},
        },
    ]


@unittest.skipUnless(os.name == "nt", "HongYe 运行包使用 .NET Framework x64")
class HongYeValidationSessionTests(unittest.TestCase):
    """验证最小运行包和逐事件协议。"""

    def test_runtime_contains_only_required_files(self) -> None:
        """运行目录不得重新引入旧 Python/日志/适配依赖。"""
        self.assertEqual(
            {path.name for path in RUNTIME_DIR.iterdir() if path.is_file()},
            {
                "HongYeValidator.exe",
                "HongYeValidator.exe.config",
                "Newtonsoft.Json.dll",
                "SchStateLib.dll",
            },
        )

    def test_events_are_validated_without_a_log_file(self) -> None:
        """逐条发送事件时，仅 AlgOutput 返回 module-parallel 摘要。"""
        with HongYeValidationSession() as session:
            results = [
                session.add_event(event)
                for event in _minimal_events([])
            ]
        self.assertEqual(results[:2], [None, None])
        self.assertEqual(results[2]["advance"], "module-parallel")
        self.assertTrue(results[2]["success"])
        self.assertEqual(results[2]["errors"], 0)

    def test_reproduction_log_converts_hongye_issue_for_gantt(self) -> None:
        """HongYe 错误应保留 MoveID，并沿用现有失败甘特图通道。"""
        invalid_move = {
            "MoveID": 7,
            "MoveType": 99,
            "ModuleName": "Unknown",
            "StartTime": 0,
            "EndTime": 1,
        }
        with HongYeValidationSession() as session:
            reproduction = ReproductionLog(hongye_session=session)
            events = _minimal_events([invalid_move])
            reproduction.add("AlgInit", events[0]["Info"])
            reproduction.add("AlgSchedule", events[1]["Info"])
            with self.assertRaises(MoveListValidationError) as raised:
                reproduction.add("AlgOutput", events[2]["Info"])
        self.assertIn("MoveID=7", raised.exception.validation_issues[0])
        self.assertEqual(
            raised.exception.gantt_output["Validation"]["InvalidMoveIDs"],
            [7],
        )
        self.assertEqual(
            raised.exception.gantt_output["Validation"]["Issues"][0]["Code"],
            "MOVE.TYPE",
        )

    def test_reproduction_input_is_not_forwarded_to_hongye(self) -> None:
        """前端完整计划只进入复现日志，不得增加校验进程的启动前传输耗时。"""
        validator = Mock()
        reproduction = ReproductionLog(hongye_session=validator)

        reproduction.add(
            "Input",
            [{"options": {"largeFrontendPayload": "x" * 10_000}}],
            forward_to_validator=False,
        )

        validator.add_event.assert_not_called()
        self.assertEqual("Input", reproduction.entries[0]["Describe"])


class HongYeSelectionDefaultsTests(unittest.TestCase):
    """验证后端生成的批量计划默认选择 HongYe。"""

    def test_batch_plan_enables_hongye_by_default(self) -> None:
        """缺省批量请求也必须使用新的默认校验器。"""
        device = {
            "name": "test",
            "device": {"Robots": {}, "Stations": {}},
            "routes": [],
            "cleans": [],
        }
        test_case = {"rounds": [], "options": {}}
        plan = build_workspace_batch_plan(device, test_case, "heuristic", {})
        self.assertIs(plan["hongYeCheck"], True)
        self.assertNotIn("skipValidation", plan)

    def test_frontend_enables_validation_and_hongye_by_default(self) -> None:
        """开始运行区域默认校验、默认 HongYe，仍保留显式跳过入口。"""
        template = (
            Path(__file__).resolve().parents[1]
            / "realtime_scheduler"
            / "frontend"
            / "config_editor.html"
        ).read_text(encoding="utf-8")
        self.assertIn('id="skipValidationInput" type="checkbox">', template)
        self.assertIn(
            'id="hongYeCheckInput" type="checkbox" checked',
            template,
        )


if __name__ == "__main__":
    unittest.main()
