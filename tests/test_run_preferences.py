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
        "cleanValidationTypes": ["preclean", "postclean", "wacclean", "dummy", "dummywac"],
    }
    value.update(overrides)
    return value


def test_missing_run_preferences_use_defaults_without_creating_file(tmp_path: Path) -> None:
    """首次启动应返回安全默认值，读取操作本身不得产生文件写入。"""
    path = tmp_path / "run_preferences.json"
    assert read_run_preferences(path) == _settings()
    assert not path.exists()


def test_run_preferences_are_versioned_and_persisted_atomically(tmp_path: Path) -> None:
    """保存后应写入 schemaVersion 2，并可在服务重启语义下重新读取。"""
    path = tmp_path / "run_preferences.json"
    expected = _settings(
        compatibilityMode=False,
        skipBaseline=True,
        maximumWorkers=30,
        validationWorkers=15,
    )
    assert update_run_preferences(expected, path) == expected
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {"schemaVersion": 2, "runSettings": expected}
    assert read_run_preferences(path) == expected


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"maximumWorkers": 31}, "maximumWorkers 必须在 1 到 30 之间"),
        ({"validationWorkers": 16}, "validationWorkers 必须在 1 到 15 之间"),
        ({"hongYeCheck": 1}, "hongYeCheck 必须是布尔值"),
        ({"cleanValidationTypes": ["unknown"]}, "cleanValidationTypes 包含不支持的类型"),
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
        json.dumps({"schemaVersion": 3, "runSettings": _settings()}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="版本过新：3"):
        read_run_preferences(path)


def test_run_preferences_migrate_v1_and_keep_recoverable_backup(tmp_path: Path) -> None:
    """旧偏好首次读取时应补齐 Clean 类型并保留原文件副本。"""
    path = tmp_path / "run_preferences.json"
    old_settings = _settings()
    old_settings.pop("cleanValidationTypes")
    path.write_text(json.dumps({"schemaVersion": 1, "runSettings": old_settings}), encoding="utf-8")

    assert read_run_preferences(path) == _settings()
    assert json.loads((tmp_path / "run_preferences.json.v1.bak").read_text(encoding="utf-8"))["schemaVersion"] == 1
