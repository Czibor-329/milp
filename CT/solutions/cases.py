"""Case1/Case2 验证用例：两条 route 共享同一下游腔室 PM3（分层拉式调度的最小检验场景）。

  Case1  R1: PM1[300]→PM3[100]   R2: PM2[50]→PM3[100]   期望放片配比 1:2（涌现）
  Case2  R1: PM1[200]→PM3[150]   R2: PM2[50]→PM3[100]   期望 R1 放片间隔≈250（非 200）

物理拓扑复用 s1-1c1p（含 PM1/2/3、LP1-4、LA/LB、ATR/VTR 及全部传输时间）。
两条 route 同优先级（可并发发片）、各占一个 LP（R1→LP1, R2→LP2）、无清洗。
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Sequence, Tuple

from CT.infer.marathon_gen import _proc_recipe, _recipe_entry, _route_steps
from CT.config.input_loader import load_alg_entries
from CT.config.paths import input_data_path

_BASE_TOPO = "s1-1c1p-preclean"


class _CaseJob:
    """_route_steps / 加工 recipe 生成所需的最小 job 视图（无清洗）。"""
    def __init__(self, stages: List[List[str]], procs: List[float]):
        self.stages = stages
        self.proc_times = procs
        self.clean_type = "none"
        self.residency = -1          # 加工腔驻留上限(s)，-1=无（对齐 marathon_gen.Job 默认）


def _case_process_recipes(job: _CaseJob, key: int) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i, stage_pms in enumerate(job.stages):
        proc = _proc_recipe(key, i)
        out += [_recipe_entry(proc, pm, job.proc_times[i]) for pm in stage_pms]
    return out


def _route_update(job: _CaseJob, key: int, priority: int, lp: str,
                  mat_id_start: int, n_wafer: int) -> Tuple[Dict[str, Any], List[Dict], List[int], str, str, int]:
    rname = f"R_{key}"
    pjob = f"{key}.P1-1"
    task_id = f"job{key}"
    steps = _route_steps(job, key, lp)
    route = {
        "Name": rname, "RouteSteps": steps, "BufferOption": 0, "BoundedStepIDs": [],
        "Group": f"G{key}", "PrePJob": {}, "PostPJob": {}, "PostCJob": {},
    }
    materials: List[Dict[str, Any]] = []
    mat_ids: List[int] = []
    mid = mat_id_start
    for slot in range(1, n_wafer + 1):
        materials.append({
            "Name": str(mid), "ID": mid, "TaskID": task_id, "LotID": task_id,
            "FoupID": f"F{key}", "Priority": priority, "StepID": 0,
            "CurrentModuleName": lp, "SlotID": slot, "NeedSchedule": True,
            "PJobName": pjob, "SrcPortName": lp, "Route": copy.deepcopy(route),
        })
        mat_ids.append(mid)
        mid += 1
    return route, materials, mat_ids, pjob, task_id, mid


def build_case(specs: Sequence[Dict[str, Any]], n_wafer: List[int] = [12,12],
               base_topo: str = _BASE_TOPO) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """specs: [{stages, procs, lp, priority}, ...] → (alg_init, alg_schedule)."""
    alg_init, _ = load_alg_entries(input_data_path(base_topo))

    routes: Dict[str, Any] = {}
    materials: List[Dict[str, Any]] = []
    pjobs: List[Dict[str, Any]] = []
    cjobs: List[Dict[str, Any]] = []
    recipes: List[Dict[str, Any]] = []
    mat_id = 0
    for i, spec in enumerate(specs):
        key = i + 1
        job = _CaseJob(spec["stages"], spec["procs"])
        prio = int(spec.get("priority", 1))
        lp = str(spec["lp"])
        recipes += _case_process_recipes(job, key)
        route, mats, mat_ids, pjob, task_id, mat_id = _route_update(
            job, key, prio, lp, mat_id, int(spec.get("n_wafer", n_wafer[i])))
        routes[route["Name"]] = copy.deepcopy(route)
        materials += mats
        pjobs.append({"JobName": pjob, "TaskID": task_id, "Priority": prio,
                      "State": 0, "OriginRoute": copy.deepcopy(route), "MatList": mat_ids})
        cjobs.append({"TaskID": task_id, "JobType": 0, "Priority": prio, "TaskMode": 0,
                      "PJobNameList": [pjob], "MaterialCount": n_wafer[i]})

    alg_schedule = {
        "Scenario": 0, "Routes": routes, "ProcessRecipes": recipes,
        "Materials": materials, "ProcessJobs": pjobs, "ControlJobs": cjobs,
        "RemoveList": [], "MoveStates": [], "CurrentTime": 0.0,
    }
    return alg_init, alg_schedule


def case1(n_wafer: List[int] = [12,12]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    return build_case([
        {"stages": [["PM1"], ["PM3"]], "procs": [300, 100], "lp": "LP1", "priority": 1},
        {"stages": [["PM2"], ["PM3"]], "procs": [50, 100], "lp": "LP2", "priority": 1},
    ], n_wafer=n_wafer)


def case2(n_wafer: List[int] = [12,12]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    return build_case([
        {"stages": [["PM1"], ["PM3"]], "procs": [200, 150], "lp": "LP1", "priority": 1},
        {"stages": [["PM2"], ["PM3"]], "procs": [50, 100], "lp": "LP2", "priority": 1},
    ], n_wafer=n_wafer)

def case3(n_wafer: List[int] = [12,12]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    return build_case([
        {"stages": [["PM1"], ["PM3"]], "procs": [300, 100], "lp": "LP1", "priority": 1},
        {"stages": [["PM3"]], "procs": [75], "lp": "LP1", "priority": 1},
    ], n_wafer=n_wafer)