"""批量结果卡片所需轻量指标的响应格式测试。"""

from realtime_scheduler.backend.execution.batch_results import BatchResultAssembler


def test_success_exposes_average_recompute_time_for_result_card() -> None:
    """成功项应直接携带重算次数和平均重算时间，避免卡片等待完整分析。"""
    assembler = BatchResultAssembler(
        save_result=lambda _artifact: "result-id",
        save_reproduction_log=lambda _log: "log-id",
        log_response_fields=lambda _log_id: {"logUrl": "/log"},
        logged_failure_fields=lambda *_args, **_kwargs: {},
        baseline_comparison=lambda *_args: {},
        robot_wafer_dwell_time=lambda _moves: {},
        is_external_algorithm=lambda _strategy: False,
    )

    item = assembler.success(
        0,
        {"id": "test-id", "name": "测试一"},
        {
            "output": {"MoveList": []},
            "cpuTimeMs": 12.0,
            "totalElapsedMs": 15.0,
            "updates": [{}, {}, {}],
            "reproductionLog": [],
            "makespan": 100.0,
            "moveCount": 0,
            "validation": "passed",
        },
        {"status": "skipped"},
        {"device": {}, "rounds": []},
    )

    assert item["recomputeCount"] == 3
    assert item["averageRecomputeTimeMs"] == 4.0
