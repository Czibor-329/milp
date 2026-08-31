"""验证重算快照的清洁过程变量与 HongYe 跨代对账。"""

from realtime_scheduler.backend import application as server


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
