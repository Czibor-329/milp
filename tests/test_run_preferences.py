"""本地运行设置偏好的格式、校验与持久化回归测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from realtime_scheduler.backend.preferences.repository import (
    read_analysis_preferences,
    read_run_preferences,
    update_analysis_preferences,
    update_run_preferences,
)


def _settings(**overrides) -> dict:
    """构造一份完整有效的运行设置，并允许覆盖目标字段。"""
    value = {
        "compatibilityMode": True,
        "hongYeCheck": True,
        "skipBaseline": True,
        "executionTimingEnabled": False,
        "maximumWorkers": 4,
        "validationWorkers": 2,
        "cleanValidationTypes": ["preclean", "postclean", "wacclean", "dummy", "dummywac"],
    }
    value.update(overrides)
    return value


def _analysis_settings(**overrides) -> dict:
    """构造一份完整有效的个人结果分析设置。"""
    value = {
        "metricIds": [
            "validation", "makespan", "baseline_improvement", "cpu_time",
            "average_recompute_time", "throughput", "departure_interval_cv",
            "process_chamber_dwell", "robot_wafer_dwell", "system_residence",
            "system_residence_cv", "resource_utilization", "bottleneck_candidates",
            "loadlock_wafers_per_cycle", "loadlock_full_cycle_ratio",
            "loadlock_empty_cycle_ratio",
        ],
        "windowMode": "steady",
        "timeBudgetSeconds": 120,
    }
    value.update(overrides)
    return value


def test_missing_run_preferences_use_defaults_without_creating_file(tmp_path: Path) -> None:
    """首次启动应返回安全默认值，读取操作本身不得产生文件写入。"""
    path = tmp_path / "run_preferences.json"
    assert read_run_preferences(path) == _settings()
    assert read_analysis_preferences(path) == _analysis_settings()
    assert not path.exists()


def test_run_preferences_are_versioned_and_persisted_atomically(tmp_path: Path) -> None:
    """保存后应写入 schemaVersion 4，并保留默认分析设置。"""
    path = tmp_path / "run_preferences.json"
    expected = _settings(
        compatibilityMode=False,
        skipBaseline=True,
        maximumWorkers=30,
        validationWorkers=15,
    )
    assert update_run_preferences(expected, path) == expected
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload == {
        "schemaVersion": 4,
        "runSettings": expected,
        "analysisSettings": _analysis_settings(),
    }
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
        json.dumps({"schemaVersion": 5, "runSettings": _settings()}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="版本过新：5"):
        read_run_preferences(path)


def test_run_preferences_migrate_v1_and_keep_recoverable_backup(tmp_path: Path) -> None:
    """旧偏好首次读取时应补齐 Clean 类型并保留原文件副本。"""
    path = tmp_path / "run_preferences.json"
    old_settings = _settings()
    old_settings.pop("cleanValidationTypes")
    path.write_text(json.dumps({"schemaVersion": 1, "runSettings": old_settings}), encoding="utf-8")

    assert read_run_preferences(path) == _settings()
    assert json.loads((tmp_path / "run_preferences.json.v1.bak").read_text(encoding="utf-8"))["schemaVersion"] == 1


def test_run_preferences_migrate_v2_with_execution_time_disabled(tmp_path: Path) -> None:
    """v2 偏好升级后应默认关闭执行时间模拟并保留原始备份。"""
    path = tmp_path / "run_preferences.json"
    old_settings = _settings()
    old_settings.pop("executionTimingEnabled")
    path.write_text(json.dumps({"schemaVersion": 2, "runSettings": old_settings}), encoding="utf-8")

    assert read_run_preferences(path) == _settings()
    assert json.loads((tmp_path / "run_preferences.json.v2.bak").read_text(encoding="utf-8"))["schemaVersion"] == 2


def test_run_preferences_migrate_v3_and_add_analysis_settings(tmp_path: Path) -> None:
    """v3 偏好升级后应补齐分析设置，并保留可恢复的原始文件。"""
    path = tmp_path / "run_preferences.json"
    fixture = Path(__file__).parent / "fixtures" / "run_preferences_v3.json"
    path.write_text(fixture.read_text(encoding="utf-8"), encoding="utf-8")

    assert read_analysis_preferences(path) == _analysis_settings()
    assert json.loads(path.read_text(encoding="utf-8"))["schemaVersion"] == 4
    assert json.loads((tmp_path / "run_preferences.json.v3.bak").read_text(encoding="utf-8"))["schemaVersion"] == 3


def test_analysis_preferences_persist_without_overwriting_run_settings(tmp_path: Path) -> None:
    """保存个人分析习惯时应逐指标规范化，并完整保留运行设置。"""
    path = tmp_path / "run_preferences.json"
    run_settings = _settings(maximumWorkers=8)
    update_run_preferences(run_settings, path)
    expected = _analysis_settings(
        metricIds=["throughput", "makespan"],
        windowMode="full",
        timeBudgetSeconds=300,
    )

    assert update_analysis_preferences(expected, path) == _analysis_settings(
        metricIds=["makespan", "throughput"],
        windowMode="full",
        timeBudgetSeconds=300,
    )
    assert read_run_preferences(path) == run_settings


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"metricIds": ["unknown"]}, "metricIds 包含不支持的指标"),
        ({"windowMode": "recent"}, "windowMode 只支持 steady 或 full"),
        ({"timeBudgetSeconds": 60}, "timeBudgetSeconds 只支持 30、120 或 300 秒"),
    ],
)
def test_analysis_preferences_reject_invalid_values(
    tmp_path: Path,
    overrides: dict,
    message: str,
) -> None:
    """分析偏好的指标和时间控制必须由服务端校验。"""
    with pytest.raises(ValueError, match=message):
        update_analysis_preferences(
            _analysis_settings(**overrides),
            tmp_path / "run_preferences.json",
        )
