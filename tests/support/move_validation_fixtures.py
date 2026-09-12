"""平台 MoveList 校验测试共享的最小快照与 Move builder。"""

from __future__ import annotations


def dual_chamber_update() -> dict:
    """创建两槽 PM、两槽 LoadLock 和双槽单 Arm 的最小设备快照。"""
    scope = ["PM1", "LL1"]
    return {
        "Stations": {
            "PM1": {"Type": "MultiProcessChamber", "Capacity": 2},
            "LL1": {
                "Type": "LoadLock",
                "Capacity": 2,
                "LastItem": "ATMRobot",
                "PrePrepareTime": [
                    {
                        "PrePrepareType": "PumpTime",
                        "LastItem": "ATMRobot",
                        "CurrentItem": "VACRobot",
                    },
                    {
                        "PrePrepareType": "VentTime",
                        "LastItem": "VACRobot",
                        "CurrentItem": "ATMRobot",
                    },
                ],
            },
        },
        "Robots": {
            "VACRobot": {
                "Type": "VTMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": scope,
                    },
                },
            },
            "ATMRobot": {
                "Type": "ATMRobot",
                "Capacity": 2,
                "ArmInfo": {
                    "ArmA": {
                        "Name": "ArmA",
                        "IsEnable": True,
                        "SlotIDs": [1, 2],
                        "AccessibleStations": ["LL1"],
                    },
                },
            },
        },
        "Materials": [
            {"ID": 101, "CurrentModuleName": "PM1", "SlotID": 1, "StepID": 4},
            {"ID": 102, "CurrentModuleName": "PM1", "SlotID": 2, "StepID": 4},
        ],
    }


def move(move_id: int, move_type: int, start: float, end: float, **fields: object) -> dict:
    """创建字段可显式覆盖的标准 Move 行。"""
    return {
        "MoveID": move_id,
        "MoveType": move_type,
        "StartTime": start,
        "EndTime": end,
        **fields,
    }


def dual_transfer_moves() -> list[dict]:
    """创建双片从 PM 搬到 LL、满载充气并由大气手取出的完整动作链。"""
    return [
        move(1, 10, 0, 1, ModuleName="LL1", LastState="ATMRobot", CurState="VACRobot", MatIDList=[]),
        move(2, 6, 0, 1, ModuleName="PM1", RelatedRobotType=1),
        move(3, 0, 1, 2, ModuleName="VACRobot", MatIDList=[101, 102], SrcStationList=["PM1", "PM1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2], StepIDList=[5, 5]),
        move(4, 7, 2, 3, ModuleName="PM1"),
        move(5, 5, 3, 4, ModuleName="VACRobot", MatIDList=[101, 102], SrcStationList=["PM1"], DestStationList=["LL1"], RobotSlotList=[1, 2]),
        move(6, 6, 4, 5, ModuleName="LL1", RelatedRobotType=1),
        move(7, 1, 5, 6, ModuleName="VACRobot", MatIDList=[101, 102], DestStationList=["LL1", "LL1"], DestSlotList=[1, 2], RobotSlotList=[1, 2], StepIDList=[6, 6]),
        move(8, 7, 6, 7, ModuleName="LL1"),
        move(9, 10, 7, 8, ModuleName="LL1", LastState="VACRobot", CurState="ATMRobot", MatIDList=[101, 102], SlotList=[1, 2]),
        move(10, 6, 8, 9, ModuleName="LL1", RelatedRobotType=0),
        move(11, 0, 9, 10, ModuleName="ATMRobot", MatIDList=[101, 102], SrcStationList=["LL1", "LL1"], SrcSlotList=[1, 2], RobotSlotList=[1, 2], StepIDList=[7, 7]),
    ]
