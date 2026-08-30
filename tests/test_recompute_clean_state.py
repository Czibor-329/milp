"""验证重算快照的清洁过程变量与 HongYe 跨代对账。"""

from realtime_scheduler import server


def _process_variable(value: int) -> dict:
    """构造标准 StateVariable 当前值。"""
    return {
        "Name": "ProcessCount",
        "ComputeRule": "",
        "Type": 1,
        "Value": {"Value": value},
    }


def test_committed_process_moves_update_next_generation_snapshot() -> None:
    """产品工艺累计且 Wac 归零后，应写入下一代 ProcessCount。"""
    previous_update = {
        "Stations": {
            "PM1": {"StateVariables": {"ProcessCount": _process_variable(1)}},
        },
    }
    update = {
        "Stations": {
            "PM1": {"StateVariables": {"ProcessCount": _process_variable(0)}},
        },
    }
    moves = [
        {"MoveID": 1, "MoveType": 9, "StartTime": 2, "EndTime": 3,
         "ModuleName": "PM1", "MatIDList": [11]},
        {"MoveID": 2, "MoveType": 9, "StartTime": 4, "EndTime": 5,
         "ModuleName": "PM1", "CleanTaskName": "WacClean", "MatIDList": []},
        {"MoveID": 3, "MoveType": 9, "StartTime": 6, "EndTime": 7,
         "ModuleName": "PM1", "MatIDList": [12]},
    ]

    server._apply_committed_process_variables(
        update,
        previous_update,
        moves,
        8.0,
        {},
    )

    assert update["Stations"]["PM1"]["StateVariables"]["ProcessCount"]["Value"]["Value"] == 1


def test_hongye_reconciles_only_committed_running_preclean() -> None:
    """上一代已启动 PreClean 可对账，其他真实缺失边界必须保留。"""
    entries = [
        {"Describe": "AlgOutput", "Info": {"MoveList": [{
            "MoveID": 10,
            "MoveType": 9,
            "StartTime": 9.0,
            "EndTime": 11.0,
            "ModuleName": "PM1",
            "PJobName": ["P1"],
            "CleanTaskName": "PreClean",
        }]}},
        {"Describe": "AlgSchedule", "SimTime": 10.0, "Info": {}},
    ]
    validation = {
        "success": False,
        "errors": 2,
        "issues": [
            {"code": "CLEAN.PRE_MISSING", "message": "PJob=P1 PM=PM1"},
            {"code": "CLEAN.PRE_MISSING", "message": "PJob=P2 PM=PM2"},
        ],
    }

    reconciled = server._reconcile_hongye_generation_issues(
        validation,
        entries,
        10.0,
    )

    assert reconciled["success"] is False
    assert reconciled["errors"] == 1
    assert reconciled["issues"][0]["message"] == "PJob=P2 PM=PM2"
    assert reconciled["generationReconciliations"][0]["message"] == "PJob=P1 PM=PM1"
