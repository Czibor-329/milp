"""实时重算状态快照生成的单元与架构边界测试。

覆盖传统 ATR/VTR LoadLock、带编号的 ATR_1/VTR_1 LoadLock，以及两侧均为
真空机器人的 VTR_1/VTR_2 桥接 LoadLock，确保 MachineState 回写不会丢失
设备协议中的精确 ``LastItem`` 名称。
"""

from __future__ import annotations

from pathlib import Path

from realtime_scheduler.move_validation import ATMOSPHERE, MachineState, VACUUM
from realtime_scheduler.recompute_state import apply_machine_state_to_update


ROOT = Path(__file__).resolve().parents[1]


def _loadlock(last_item: str, current_item: str) -> dict:
    """构造一组可双向切换的最小 LoadLock 标准配置。"""
    return {
        "Type": "LoadLock",
        "Capacity": 2,
        "Slots": [1, 2],
        "LastItem": "",
        "PrePrepareTime": [
            {
                "LastItem": last_item,
                "CurrentItem": current_item,
                "Time": 1.0,
                "PrePrepareType": "PumpTime",
            },
            {
                "LastItem": current_item,
                "CurrentItem": last_item,
                "Time": 1.0,
                "PrePrepareType": "VentTime",
            },
        ],
    }


def test_loadlock_snapshot_restores_configured_side_names() -> None:
    """状态快照应按各站点配置恢复带编号或双真空侧的 LastItem。"""
    update = {
        "CurrentTime": 0.0,
        "Materials": [],
        "Robots": {},
        "Stations": {
            "LA": _loadlock("ATR_1", "VTR_1"),
            "LB": _loadlock("ATR_1", "VTR_1"),
            "UBR": _loadlock("VTR_1", "VTR_2"),
            "DBR": _loadlock("VTR_1", "VTR_2"),
        },
    }
    state = MachineState.from_sources(None, update)
    state.stations["LA"].environment = VACUUM
    state.stations["LB"].environment = ATMOSPHERE
    state.stations["UBR"].environment = ATMOSPHERE
    state.stations["DBR"].environment = VACUUM

    apply_machine_state_to_update(update, state, 70.0)

    assert update["Stations"]["LA"]["LastItem"] == "VTR_1"
    assert update["Stations"]["LB"]["LastItem"] == "ATR_1"
    assert update["Stations"]["UBR"]["LastItem"] == "VTR_1"
    assert update["Stations"]["DBR"]["LastItem"] == "VTR_2"


def test_loadlock_snapshot_preserves_legacy_atr_vtr_names() -> None:
    """传统设备仍应输出原有 ATR/VTR 名称，保持标准接口向后兼容。"""
    update = {
        "CurrentTime": 0.0,
        "Materials": [],
        "Robots": {},
        "Stations": {"LA": _loadlock("ATR", "VTR")},
    }
    state = MachineState.from_sources(None, update)
    state.stations["LA"].environment = VACUUM

    apply_machine_state_to_update(update, state, 10.0)

    assert update["Stations"]["LA"]["LastItem"] == "VTR"


def test_server_does_not_implement_machine_state_snapshot_replay() -> None:
    """HTTP 服务边界不得重新承载 MachineState 到 update 的回写实现。"""
    server_source = (
        ROOT / "realtime_scheduler" / "server.py"
    ).read_text(encoding="utf-8")

    assert "def _apply_machine_state_to_update" not in server_source
    assert "from realtime_scheduler.recompute_state import (" in server_source
    assert "apply_machine_state_to_update(update" in server_source
