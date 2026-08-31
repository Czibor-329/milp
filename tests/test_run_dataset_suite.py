"""验证终端测试集入口的选择规则和内置校验默认值。"""

from __future__ import annotations

from unittest.mock import patch

from scripts import run_dataset_suite


def _device() -> dict:
    """构造包含两个测试的最小设备目录。"""
    return {
        "id": "device-1",
        "name": "12kChamber",
        "tests": [
            {"id": "test-1", "name": "case1", "group": "公司示例集"},
            {"id": "test-2", "name": "case2", "group": "公司示例集"},
        ],
    }


def test_select_unique_accepts_id_or_exact_name() -> None:
    """设备和测试选择器只接受稳定 ID 或完整名称。"""
    rows = _device()["tests"]

    assert run_dataset_suite._select_unique(rows, "test-1", kind="测试")["name"] == "case1"
    assert run_dataset_suite._select_unique(rows, "CASE2", kind="测试")["id"] == "test-2"


def test_terminal_suite_uses_builtin_validation_and_selected_limit() -> None:
    """终端运行默认关闭 HongYe，并把筛选后的 ID 交给批量服务。"""
    device = _device()
    captured = {}

    def fake_run(*args, **kwargs):
        """记录批量参数并返回成功摘要。"""
        captured.update(kwargs)
        return {
            "ok": True,
            "succeeded": 1,
            "failed": 0,
            "totalElapsedMs": 12.0,
            "items": [],
        }

    from realtime_scheduler.backend import application as scheduler_server

    with (
        patch.object(
            scheduler_server,
            "list_workspace_devices",
            return_value=[{"id": device["id"], "name": device["name"], "testCount": 2}],
        ),
        patch.object(scheduler_server, "get_workspace_device", return_value=device),
        patch.object(scheduler_server, "run_workspace_test_batch", side_effect=fake_run),
    ):
        exit_code = run_dataset_suite.main([
            "--device", "12kChamber",
            "--group", "公司示例集",
            "--limit", "1",
        ])

    assert exit_code == 0
    assert captured["skip_validation"] is False
    assert captured["hongye_check"] is False
    assert captured["skip_baseline"] is True
    assert captured["test_ids"] == ["test-1"]


def test_terminal_suite_can_enable_hongye_validation() -> None:
    """显式开关应把测试组交给 HongYe 校验器。"""
    device = _device()
    captured = {}

    def fake_run(*args, **kwargs):
        """记录批量参数并返回成功摘要。"""
        captured.update(kwargs)
        return {
            "ok": True,
            "succeeded": 2,
            "failed": 0,
            "totalElapsedMs": 12.0,
            "items": [],
        }

    from realtime_scheduler.backend import application as scheduler_server

    with (
        patch.object(
            scheduler_server,
            "list_workspace_devices",
            return_value=[{"id": device["id"], "name": device["name"], "testCount": 2}],
        ),
        patch.object(scheduler_server, "get_workspace_device", return_value=device),
        patch.object(scheduler_server, "run_workspace_test_batch", side_effect=fake_run),
    ):
        exit_code = run_dataset_suite.main([
            "--device", "12kChamber",
            "--group", "公司示例集",
            "--hongye-check",
        ])

    assert exit_code == 0
    assert captured["hongye_check"] is True
