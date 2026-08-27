"""PSE300 真实批量测试的发布级墙钟性能门禁。

该测试默认跳过，固定 Windows 性能机设置
``CT_RUN_PSE300_BATCH_PERFORMANCE=1`` 后运行；它直接使用数据目录中的
“公司单腔示例集-130”、平台校验和生产进程隔离路径，并以产品预算判定结果。
"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path

from realtime_scheduler import server


ROOT = Path(__file__).resolve().parents[2]
BUDGET_PATH = ROOT / "performance" / "budgets.json"
PSE300_DEVICE_ID = "460fad299cda43298409d7ce16d54906"
PSE300_TEST_GROUP = "公司单腔示例集-130"


@unittest.skipUnless(
    os.environ.get("CT_RUN_PSE300_BATCH_PERFORMANCE") == "1",
    "仅在固定性能机运行 PSE300 真实批量门禁",
)
class Pse300BatchPerformanceTests(unittest.TestCase):
    """验证 130 项平台校验批量任务的完整后端墙钟耗时。"""

    def test_platform_validation_batch_finishes_within_product_budget(self) -> None:
        """算法单项约 2 秒时，130 项批量测试必须在 260 秒内结束。"""
        budget_ms = json.loads(BUDGET_PATH.read_text(encoding="utf-8"))[
            "absoluteMilliseconds"
        ]["batch130Maximum"]
        device = server.get_workspace_device(PSE300_DEVICE_ID)
        tests = [
            test_case
            for test_case in device.get("tests") or []
            if test_case.get("group") == PSE300_TEST_GROUP
        ]
        self.assertEqual(130, len(tests), "PSE300 性能测试组必须稳定包含 130 项")

        started = time.perf_counter()
        result = server._execute_workspace_test_batch(
            device,
            tests,
            PSE300_TEST_GROUP,
            "heuristic",
            {},
            skip_validation=False,
            hongye_check=False,
            skip_baseline=True,
            maximum_workers=4,
            use_process_isolation=True,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000.0

        self.assertEqual(130, result["completed"])
        self.assertTrue(result["processIsolation"])
        self.assertLessEqual(
            elapsed_ms,
            budget_ms,
            f"PSE300 130 项批量耗时 {elapsed_ms / 1000:.1f}s，超过 {budget_ms / 1000:.0f}s",
        )


if __name__ == "__main__":
    unittest.main()
