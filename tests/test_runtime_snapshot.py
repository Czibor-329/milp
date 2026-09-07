"""验证公司 AlgSchedule 的 Robot 与 Station 字段投影。"""

from realtime_scheduler.backend.execution.runtime_snapshot import (
    compact_robot_snapshots,
    compact_station_snapshots,
    expand_runtime_snapshots_for_validation,
)


def _station(station_type: str, **fields: object) -> dict:
    """构造带稳定字段的最小 Station，便于验证投影边界。"""
    return {
        "Type": station_type,
        "State": 0,
        "TimeToAvailableOfSlot": {"0": 0.0, "1": 2.0},
        "Name": f"{station_type}1",
        "Capacity": 2,
        "Slots": [1, 2],
        "PickPrepareTime": {"R": 1.0},
        "PrePrepareTime": [{"PrePrepareType": "PumpTime", "Time": 2.0}],
        **fields,
    }


def _robot(**fields: object) -> dict:
    """构造带完整初始化能力的最小 Robot。"""
    return {
        "Type": "VTMRobot",
        "State": 0,
        "TimeToAvailable": 3.0,
        "Name": "VTR",
        "Capacity": 2,
        "PickTime": {"PM1": 1.0},
        "PlaceTime": {"PM1": 1.0},
        "PrepTransTime": [],
        "ArmPointerPair": [],
        "CanMultiTrans": True,
        "ArmInfo": {
            "ArmA": {
                "Name": "ArmA",
                "IsEnable": True,
                "SlotIDs": [1],
                "AccessibleStations": ["PM1"],
                "SlotAtStation": "PM1",
                "UseCount": 2,
                "SlotsStationMap": {},
            },
        },
        **fields,
    }


def test_compact_robot_snapshots_match_company_alg_schedule_fields() -> None:
    """Robot 只保留公司日志的四个顶层字段，并完整保留 ArmInfo。"""
    compacted = compact_robot_snapshots({"VTR": _robot()})

    assert set(compacted["VTR"]) == {
        "Type", "State", "TimeToAvailable", "ArmInfo",
    }
    assert set(compacted["VTR"]["ArmInfo"]["ArmA"]) == {
        "Name", "IsEnable", "SlotIDs", "AccessibleStations", "SlotAtStation",
        "UseCount", "SlotsStationMap",
    }


def test_compact_station_snapshots_match_company_alg_schedule_fields() -> None:
    """各模块只保留两份公司日志出现的实时 Station 字段。"""
    stations = {
        "Aligner": _station("Aligner", DoorStatus=0),
        "LA": _station("LoadLock", LastItem="ATR", DoorStatus=1),
        "Cooler": _station("Cooler", MaterialCount={"1": 3}, DoorStatus=0),
        "PM1": _station(
            "ProcessChamber",
            PJobName="P1",
            StateVariables={"Count": {"Value": {"Value": 2}}},
            LastItem="VTR",
            ByChamberClean=[],
        ),
        "PM2": _station(
            "MultiProcessChamber",
            PJobName="P2",
            StateVariables={},
            LastItem="VTR",
            ByChamberClean=[],
            MaterialCount={"1": 4},
            SlotPriority=1,
            DoorStatus=0,
        ),
        "Buffer": _station("Buffer"),
    }

    compacted = compact_station_snapshots(stations)

    assert set(compacted["Aligner"]) == {
        "Type", "State", "TimeToAvailableOfSlot", "DoorStatus",
    }
    assert set(compacted["LA"]) == {
        "Type", "State", "TimeToAvailableOfSlot", "DoorStatus", "LastItem",
    }
    assert set(compacted["Cooler"]) == {
        "Type", "State", "TimeToAvailableOfSlot", "DoorStatus", "MaterialCount",
    }
    assert set(compacted["PM1"]) == {
        "Type", "State", "TimeToAvailableOfSlot", "PJobName", "StateVariables",
        "LastItem", "ByChamberClean",
    }
    assert set(compacted["PM2"]) == {
        "Type", "State", "TimeToAvailableOfSlot", "DoorStatus", "PJobName",
        "StateVariables", "LastItem", "ByChamberClean", "MaterialCount", "SlotPriority",
    }
    assert set(compacted["Buffer"]) == {
        "Type", "State", "TimeToAvailableOfSlot",
    }


def test_validation_expansion_keeps_static_topology_out_of_alg_schedule() -> None:
    """平台校验可恢复完整拓扑，但发送给算法的快照始终保持精简。"""
    compacted_station = compact_station_snapshots({
        "LA": _station("LoadLock", LastItem="VTR_1"),
    })
    compacted_robot = compact_robot_snapshots({"VTR": _robot(TimeToAvailable=6.0)})
    expanded = expand_runtime_snapshots_for_validation(
        {
            "Stations": {"LA": _station("LoadLock", LastItem="ATR_1")},
            "Robots": {"VTR": _robot(TimeToAvailable=0.0)},
        },
        {"Stations": compacted_station, "Robots": compacted_robot},
    )

    assert "Capacity" not in compacted_station["LA"]
    assert "Capacity" not in compacted_robot["VTR"]
    assert expanded["Stations"]["LA"]["Capacity"] == 2
    assert expanded["Stations"]["LA"]["LastItem"] == "VTR_1"
    assert expanded["Robots"]["VTR"]["Capacity"] == 2
    assert expanded["Robots"]["VTR"]["TimeToAvailable"] == 6.0
