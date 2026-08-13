"""验证 Heuristic 精简算法包不会夹带其他策略或其初始化依赖。"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from zipfile import ZipFile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.build_heuristic_package import build_archive  # noqa: E402


class BuildHeuristicPackageTests(TestCase):
    """覆盖精简包的目录排除和入口改写规则。"""

    def test_archive_excludes_schedule_alphago_and_removes_init_dependency(self) -> None:
        """导出结果不得包含 AlphaGo 文件，heuristic 初始化也不得再导入它。"""
        with TemporaryDirectory() as temporary_directory:
            temporary_root = Path(temporary_directory)
            source_root = temporary_root / "source"
            output_directory = temporary_root / "output"
            (source_root / "infer").mkdir(parents=True)
            heuristic_directory = (
                source_root / "src" / "schedule" / "strategies" / "heuristic"
            )
            heuristic_directory.mkdir(parents=True)
            schedule_alphago_directory = (
                source_root / "src" / "schedule" / "strategies" / "schedule_alphago"
            )
            schedule_alphago_directory.mkdir(parents=True)

            (source_root / "infer" / "function.py").write_text(
                "SUPPORTED_ALGORITHMS = frozenset({\n"
                '    "heuristic",\n'
                '    "schedule-alphago",\n'
                "})\n\n"
                "def init_framework():\n"
                "    with lock:\n"
                "        from src.schedule.strategies.schedule_alphago.telemetry import (\n"
                "            reset_schedule_alphago_telemetry,\n"
                "        )\n\n"
                "        reset_schedule_alphago_telemetry()\n",
                encoding="utf-8",
            )
            (source_root / "infer" / "scheduler.py").write_text(
                '"""入口。\n\n'
                "algorithm: 可选算法名，支持 ``heuristic``、``schedule-alphago``。\n"
                "            同一次会话不能切换算法。\n"
                '"""\n',
                encoding="utf-8",
            )
            (heuristic_directory / "selector.py").write_text(
                '"""Heuristic 选择器。"""\n',
                encoding="utf-8",
            )
            (schedule_alphago_directory / "telemetry.py").write_text(
                '"""搜索遥测。"""\n',
                encoding="utf-8",
            )
            schedule_alphago_model_path = (
                source_root
                / "src"
                / "schedule"
                / "strategies"
                / "schedule_alphago_model.py"
            )
            schedule_alphago_model_path.write_text(
                '"""搜索模型。"""\n',
                encoding="utf-8",
            )

            archive_path = build_archive(
                source_root,
                output_directory,
                date(2026, 8, 13),
                "a" * 40,
            )

            with ZipFile(archive_path) as archive:
                archive_names = archive.namelist()
                function_source = archive.read("alg/infer/function.py").decode("utf-8")

            self.assertFalse(
                any("schedule_alphago" in name for name in archive_names),
                archive_names,
            )
            self.assertIn(
                'SUPPORTED_ALGORITHMS = frozenset({"heuristic"})',
                function_source,
            )
            self.assertNotIn("schedule_alphago.telemetry", function_source)
            self.assertIn(
                "alg/src/schedule/strategies/heuristic/selector.py",
                archive_names,
            )
