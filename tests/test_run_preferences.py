"""本地运行设置偏好的格式、校验与持久化回归测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from realtime_scheduler.backend.preferences.repository import (
    read_run_preferences,
    update_run_preferences,
)


def _settings(**overrides) -> dict:
    """构造一份完整有效的运行设置，并允许覆盖目标字段。"""
    value = {
        "compatibilityMode": True,
        "hongYeCheck": True,
        "skipBaseline": True,
        "maximumWorkers": 4,
        "validationWorkers": 2,
    }
    value.update(overrides)
    return value


def test_missing_run_preferences_use_defaults_without_creating_file(tmp_path: Path) -> None:
    """首次启动应返回安全默认值，读取操作本身不得产生文件写入。"""
    path = tmp_path / "run_preferences.json"
    assert read_run_preferences(path) == _settings()
    assert not path.exists()


def test_run_preferences_are_versioned_and_persisted_atomically(tmp_path: Path) -> None:
    """保存后应写入 schemaVersion 1，并可在服务重启语义下重新读取。"""
    path = tmp_path / "run_preferences.json"
    expected = _settings(
        compatibilityMode=False,
        skipBaseline=True,
        maximumWorkers=30,
        validationWorkers=15,
    )
    assert update_run_preferences(expected, path) == expected
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {"schemaVersion": 1, "runSettings": expected}
    assert read_run_preferences(path) == expected


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"maximumWorkers": 31}, "maximumWorkers 必须在 1 到 30 之间"),
        ({"validationWorkers": 16}, "validationWorkers 必须在 1 到 15 之间"),
        ({"hongYeCheck": 1}, "hongYeCheck 必须是布尔值"),
    ],
)
def test_run_preferences_reject_invalid_values(
    tmp_path: Path,
    overrides: dict,
    message: str,
) -> None:
    """服务端不得把越界或错误类型的页面输入写入本地数据。"""
    with pytest.raises(ValueError, match=message):
        update_run_preferences(_settings(**overrides), tmp_path / "run_preferences.json")


def test_run_preferences_reject_newer_schema(tmp_path: Path) -> None:
    """较新版本偏好文件必须显式拒绝，不能按旧格式静默覆盖。"""
    path = tmp_path / "run_preferences.json"
    path.write_text(
        json.dumps({"schemaVersion": 2, "runSettings": _settings()}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="版本过新：2"):
        read_run_preferences(path)
