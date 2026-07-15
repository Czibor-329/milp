"""RL 顶层搜索的任务缩放与墙钟预算回归测试。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from src.marathon_gen import PM_POOL_6, expand_topo_pms
from src.parse import load_alg_entries, parse_task, resize_task_materials
from src.paths import input_data_path
from src.policy import _load_numpy_policy
from src.timing import api

_ROOT = Path(__file__).resolve().parents[1]


def _material(material_id: int, job: str, port: str, slot: int) -> dict:
    """构造缩放测试所需的最小接口物料。"""
    return {
        "ID": material_id,
        "Name": str(material_id),
        "PJobName": job,
        "CurrentModuleName": port,
        "SrcPortName": port,
        "SlotID": slot,
        "Route": {"Name": f"route-{job}", "RouteSteps": []},
    }


def _two_job_payload() -> dict:
    """构造两个等规模 PJob 的原始任务。"""
    materials = [
        *[_material(index, "P1", "LP1", index + 1) for index in range(6)],
        *[_material(index + 6, "P2", "LP2", index + 1) for index in range(6)],
    ]
    return {
        "ProcessJobs": [
            {"JobName": "P1", "MatList": list(range(6))},
            {"JobName": "P2", "MatList": list(range(6, 12))},
        ],
        "ControlJobs": [
            {"PJobNameList": ["P1"], "MaterialCount": 6},
            {"PJobNameList": ["P2"], "MaterialCount": 6},
        ],
        "Materials": materials,
    }


def test_resize_task_materials_preserves_jobs_from_five_to_twenty_five():
    """5 片训练和 25 片推理都应保留两个 PJob，且物料编号、槽位连续。"""
    train = resize_task_materials(_two_job_payload(), 5)
    assert [len(job["MatList"]) for job in train["ProcessJobs"]] == [3, 2]
    assert [job["MaterialCount"] for job in train["ControlJobs"]] == [3, 2]
    assert [material["ID"] for material in train["Materials"]] == list(range(5))

    inference = resize_task_materials(_two_job_payload(), 25)
    assert [len(job["MatList"]) for job in inference["ProcessJobs"]] == [13, 12]
    assert [material["SlotID"] for material in inference["Materials"][:13]] == list(range(1, 14))
    assert [material["SlotID"] for material in inference["Materials"][13:]] == list(range(1, 13))


def test_twenty_five_wafers_keep_unique_home_slots():
    """25 片单 Job 的 source 槽位必须唯一，sink 返回同一物理槽位。"""
    topology, _ = load_alg_entries(input_data_path("s1-1c1p-preclean"))
    topology = expand_topo_pms(topology, PM_POOL_6)
    with open(_ROOT / "dataset" / "train" / "1stage" / "inst_0000.json",
              encoding="utf-8") as file:
        data = json.load(file)
    update_params = resize_task_materials(data["update_params"], 25)
    problem = parse_task(topology, update_params)

    source_slots = [(wafer.stages[0].chamber, wafer.stages[0].slot) for wafer in problem.wafers]
    assert len(source_slots) == len(set(source_slots)) == 25
    assert all(wafer.stages[-1].slot == wafer.stages[0].slot for wafer in problem.wafers)


def test_rl_checkpoint_supports_numpy_only_inference():
    """生产环境不装 Torch 时仍应能受限读取 RL checkpoint 并完成共享 MLP 前向。"""
    policy = _load_numpy_policy(_ROOT / "results" / "models" / "bc_policy_rl.pt")
    scores = policy.score_step(np.zeros((3, 25), dtype=np.float32))
    assert scores.shape == (3,)
    assert all(float(score) == float(score) for score in scores)


def test_rl_search_clamps_budget_and_uses_timing_result():
    """过大的外部预算必须钳为 4.5 秒，候选仍由 solve_timing 评估后取优。"""
    floor = SimpleNamespace(feasible=True, makespan=100.0, schedule=[object()])
    candidate = SimpleNamespace(feasible=True, makespan=90.0, schedule=[object()])
    clock = [0.0, 0.0, 0.1, 4.49, 4.49]

    with (
        patch.object(api, "Durations", return_value=object()),
        patch.object(api, "start_schedule", return_value=floor),
        patch.object(api, "_greedy_chooser", return_value=object()),
        patch.object(api, "_sampling_chooser", return_value=object()),
        patch.object(api, "decode_orders_choosing", return_value=([], object())),
        patch.object(api, "solve_timing", return_value=candidate) as solve,
        patch.object(api, "check_solution", return_value=[]),
        patch.object(api.time, "perf_counter", side_effect=clock),
    ):
        result = api.start_schedule_by_rl(
            SimpleNamespace(wafers=[]), object(),
            search_seconds=99.0, max_rollouts=1,
        )

    assert result is candidate
    assert result.rl_search_budget == 4.5
    assert result.rl_rollouts == 1
    assert result.rl_search_runtime == 4.49
    solve.assert_called_once()


def test_rl_search_rejects_invalid_budget():
    """负墙钟预算应在开始搜索前直接拒绝。"""
    try:
        api.start_schedule_by_rl(SimpleNamespace(wafers=[]), object(), search_seconds=-0.1)
    except ValueError as error:
        assert "search_seconds" in str(error)
    else:
        raise AssertionError("负预算未被拒绝")
