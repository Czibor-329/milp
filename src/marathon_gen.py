"""随机 job 生成：基于 s1-1c1p 拓扑构造随机 update_params。

两种用法：
  - 单 job 重算马拉松（run_marathon）：每轮一个裁剪版 s1-1c1p 路径，逐轮喂 scheduler.update。
    默认单工序、PM 候选 ⊆ {PM1,PM2,PM3}，priority=key 唯一（跨 job 串行）。
  - 并发混 job（run_greedy --mix）：一次性多 job 共存于同一 update（冷启动），多工序（2~6 道）、
    6 个腔室（PM1~PM6，拓扑经 expand_topo_pms 现合成）、priority 带重复（同优并发）——用于检验
    发片/节拍控制在并发混 job 下的价值。

命名（route/pjob/recipe/alias）按 key 唯一；调度 priority 是独立的整数字段（可重复 → 并发）。
清洗时长经 ProcessRecipes[(recipe, PM)].Time 解析；host 须把所有 job 的 recipe 汇总进首轮
ProcessRecipes（见 all_process_recipes）。
"""

from __future__ import annotations

import copy
import random
from typing import Any, Dict, List, Sequence, Tuple

PM_CANDIDATES = ["PM1", "PM2", "PM3"]          # 单 job 马拉松默认腔室池
PM_POOL_6 = ["PM1", "PM2", "PM3", "PM4", "PM5", "PM6"]  # 并发混 job 腔室池
LP_POOL = ["LP1", "LP2", "LP3", "LP4"]
LL_CANDIDATES = ["LA", "LB"]
CLEAN_TYPES = ["preclean", "postclean", "dummyclean", "dummywacclean", "wacclean"]
PROC_MIN, PROC_MAX = 40, 120          # 加工时长范围（s）
CLEAN_MIN, CLEAN_MAX = 40, 300        # 清洗时长范围（s）
WAFER_PER_JOB = 25                    # 每 job 片数（满 FOUP）
DUMMY_PER_PM = 2                      # 带片清洁每 PM 需要的 dummy 片数
_TINY = 2.2250738585072014e-308       # IdleTime 阈值下界（同模板）


def _partition(items: List[str], k: int, rng: random.Random) -> List[List[str]]:
    """把 items 切成 k 个非空连续组（k ≤ len）——每个加工 stage 一组候选腔室（组间不重用）。"""
    k = max(1, min(k, len(items)))
    cuts = sorted(rng.sample(range(1, len(items)), k - 1)) if k > 1 else []
    groups, prev = [], 0
    for c in list(cuts) + [len(items)]:
        groups.append(items[prev:c])
        prev = c
    return groups


class JobSpec:
    """一个随机 job 的全部随机参数（仿真前一次性抽定，保证确定性与 recipe 汇总）。

    stages：每道工序一组候选腔室（组间不重用）；proc_times：每道工序加工时长。
    清洁挂在 stage 0 的腔室上。priority 由组装方（run_marathon / build_concurrent_update）赋值。
    """
    __slots__ = ("idx", "clean_type", "stages", "proc_times", "clean_time",
                 "empty_time", "trigger", "n_dummy", "n_wafer", "priority", "residency")

    def __init__(self, idx: int, rng: random.Random, *,
                 pm_pool: Sequence[str] = PM_CANDIDATES, stage_range: Tuple[int, int] = (1, 1),
                 clean: bool = True, proc_range: Tuple[int, int] = (PROC_MIN, PROC_MAX),
                 residency: int = -1):
        self.idx = idx
        self.clean_type = rng.choice(CLEAN_TYPES) if clean else "none"
        self.residency = int(residency)            # 加工腔驻留上限(s)，-1=无；挂到 process PM 步
        pool = list(pm_pool)
        rng.shuffle(pool)
        n_stage = min(rng.randint(*stage_range), len(pool))
        self.stages = _partition(pool, n_stage, rng)
        self.proc_times = [rng.randint(*proc_range) for _ in self.stages]
        self.clean_time = rng.randint(CLEAN_MIN, CLEAN_MAX)
        self.empty_time = rng.randint(CLEAN_MIN, CLEAN_MAX)  # dummywac 片间 wac 时长
        self.trigger = rng.randint(1, 3)                     # wac 触发片数
        self.n_dummy = DUMMY_PER_PM                           # 每 PM dummy 片数（带片清洁）
        self.n_wafer = WAFER_PER_JOB
        self.priority: int = idx + 1

    @property
    def clean_pms(self) -> List[str]:
        """清洁挂载的腔室 = 第一道工序的候选腔室。"""
        return self.stages[0]


# --------------------------------------------------------------------------- #
# 路径模子（裁剪版 s1-1c1p，单 VTR 直达各 PM；多工序 = LL→VTR→PM→VTR→PM→…→VTR→LL）
# --------------------------------------------------------------------------- #
def _visit(station: str, *, recipe: str = "", after: Any = None, resid: int = -1) -> Dict[str, Any]:
    return {
        "SlotID": [1], "StationName": station, "ProcessRecipe": recipe,
        "MoveTimeOffset": {}, "QTimeLimit": -1, "ResidencyConstraint": int(resid),
        "AfterOutPM": after or [], "BeforeInPM": [],
    }


def _proc_recipe(key: int, stage: int) -> str:
    """加工 recipe 名（含 key+stage → 唯一）。时长经 ProcessRecipes 解析，不内联。"""
    return f"proc_{key}_s{stage}"


def _route_steps(job: JobSpec, key: int, lp: str) -> List[Dict[str, Any]]:
    """LP→ATR→LL→VTR→PM(stage0)→VTR→PM(stage1)→…→VTR→LL→ATR→LP（无 heater/Cooler）。

    stage i 的 PM 步索引 = 3 + 2*i + 1 = 4 + 2*i（stage 0 PM 步在 index 4，与单工序一致）。
    """
    steps: List[Dict[str, Any]] = []

    def add(visits: List[Dict[str, Any]], need: bool) -> None:
        sid = len(steps)
        steps.append({"StepID": sid, "PostStepID": [sid + 1], "NeedProcess": need, "Visits": visits})

    add([_visit(lp)], False)
    add([_visit("ATR")], False)
    add([_visit(c) for c in LL_CANDIDATES], False)
    for i, stage_pms in enumerate(job.stages):
        recipe = _proc_recipe(key, i)
        add([_visit("VTR")], False)
        add([_visit(pm, recipe=recipe, resid=job.residency) for pm in stage_pms], True)
    add([_visit("VTR")], False)
    add([_visit(c) for c in LL_CANDIDATES], False)
    add([_visit("ATR")], False)
    add([_visit(lp)], False)
    steps[-1]["PostStepID"] = []
    return steps


def _clean_step_idx() -> int:
    """清洁挂载的 PM 步索引（stage 0 的 PM 步）。"""
    return 4


# --------------------------------------------------------------------------- #
# 清洗编码（接口形态：PrePJob / PostPJob / Visit.AfterOutPM + ProcessRecipes）
# --------------------------------------------------------------------------- #
def _idle_order(alias: str) -> Dict[str, Any]:
    return {"StateVariableName": "IdleTime", "ThresholdValueList": [_TINY, 9999],
            "PreJuge": False, "Alias": alias}


def _clean_recipe(job: JobSpec, key: int) -> str:
    return f"{job.clean_type}_{key}"


def _empty_recipe(job: JobSpec, key: int) -> str:
    return f"{job.clean_type}_wac_{key}"


def _pre_pjob(job: JobSpec, key: int, *, task: str, material_count: int,
              empty_recipe: str = "") -> Dict[str, Any]:
    recipe = _clean_recipe(job, key)
    state_vars = ["IdleTime", "DummyCount"] if material_count > 0 else ["IdleTime"]
    out: Dict[str, Any] = {}
    for pm in job.clean_pms:
        alias = f"j{key}_{pm}_{task}"
        out[pm] = [{
            "CheckConditions": {alias: [{
                "TaskName": task, "CleanRecipe": recipe,
                "UpdateStateVariables": state_vars,
                "MaterialCount": material_count,
                "EmptyCleanRecipeAfterMaterial": empty_recipe,
            }]},
            "ExecuteOrder": [_idle_order(alias)],
        }]
    return out


def _post_pjob(job: JobSpec, key: int) -> Dict[str, Any]:
    recipe = _clean_recipe(job, key)
    out: Dict[str, Any] = {}
    for pm in job.clean_pms:
        alias = f"j{key}_{pm}_PostClean"
        out[pm] = [{
            "CheckConditions": {alias: [{
                "TaskName": "PostClean", "CleanRecipe": recipe,
                "UpdateStateVariables": [], "MaterialCount": 0,
                "EmptyCleanRecipeAfterMaterial": "",
            }]},
            "ExecuteOrder": [{"Alias": alias}],
        }]
    return out


def _wac_after(job: JobSpec, key: int) -> List[Dict[str, Any]]:
    recipe = _clean_recipe(job, key)
    alias = f"j{key}_WacClean"
    return [{
        "CheckConditions": {alias: [{
            "TaskName": "WacClean", "CleanRecipe": recipe,
            "UpdateStateVariables": ["ProcessCount"], "MaterialCount": 0,
            "EmptyCleanRecipeAfterMaterial": "",
        }]},
        "ExecuteOrder": [{"StateVariableName": "ProcessCount",
                          "ThresholdValueList": [job.trigger, 9999],
                          "PreJuge": False, "Alias": alias}],
    }]


def _recipe_entry(name: str, pm: str, time: float) -> Dict[str, Any]:
    return {"Time": float(time), "ModuleName": pm, "Name": name, "ProcessType": "", "Weight": {}}


def job_process_recipes(job: JobSpec, key: int) -> List[Dict[str, Any]]:
    """本 job 的 ProcessRecipes：每道工序加工时长（per stage, per PM）+ 清洗时长。"""
    out: List[Dict[str, Any]] = []
    for i, stage_pms in enumerate(job.stages):
        proc = _proc_recipe(key, i)
        out += [_recipe_entry(proc, pm, job.proc_times[i]) for pm in stage_pms]
    if job.clean_type != "none":
        clean = _clean_recipe(job, key)
        out += [_recipe_entry(clean, pm, job.clean_time) for pm in job.clean_pms]
        if job.clean_type == "dummywacclean":
            empty = _empty_recipe(job, key)
            out += [_recipe_entry(empty, pm, job.empty_time) for pm in job.clean_pms]
    return out


# --------------------------------------------------------------------------- #
# 组装单 job 的 update_params（IUpdateParams 形状）
# --------------------------------------------------------------------------- #
def _apply_clean(route: Dict[str, Any], steps: List[Dict[str, Any]],
                 job: JobSpec, key: int) -> None:
    """按清洗类型把清洗块挂到 route（PrePJob/PostPJob）或 stage0 PM 步（AfterOutPM）。"""
    if job.clean_type == "preclean":
        route["PrePJob"] = _pre_pjob(job, key, task="PreClean", material_count=0)
    elif job.clean_type == "postclean":
        route["PostPJob"] = _post_pjob(job, key)
    elif job.clean_type == "dummyclean":
        route["PrePJob"] = _pre_pjob(job, key, task="PreDummyClean",
                                     material_count=job.n_dummy)
    elif job.clean_type == "dummywacclean":
        route["PrePJob"] = _pre_pjob(job, key, task="PreWacClean",
                                     material_count=job.n_dummy,
                                     empty_recipe=_empty_recipe(job, key))
    elif job.clean_type == "wacclean":
        after = _wac_after(job, key)
        for v in steps[_clean_step_idx()]["Visits"]:
            v["AfterOutPM"] = copy.deepcopy(after)


def _is_dummy_type(job: JobSpec) -> bool:
    return job.clean_type in ("dummyclean", "dummywacclean")


def build_update_params(
    job: JobSpec, key: int, priority: int, lp: str, mat_id_start: int, current_time: float,
    *, process_recipes: List[Dict[str, Any]] | None = None,
) -> Tuple[Dict[str, Any], int]:
    """组装一个随机 job 的 update_params；返回 (update_params, 下一个可用 material id)。

    key：命名唯一键（route/pjob/recipe）。priority：调度优先级整数（可与他 job 重复 → 并发）。
    process_recipes：本轮携带的 ProcessRecipes（首轮带全量并集，其余轮可空）。
    """
    rname = f"R_{key}"
    pjob = f"{key}.P1-1"
    task_id = f"job{key}"

    steps = _route_steps(job, key, lp)
    route: Dict[str, Any] = {
        "Name": rname, "RouteSteps": steps, "BufferOption": 0,
        "BoundedStepIDs": [], "Group": f"G{key}",
        "PrePJob": {}, "PostPJob": {}, "PostCJob": {},
    }
    _apply_clean(route, steps, job, key)

    mat_id = mat_id_start
    materials: List[Dict[str, Any]] = []
    mat_ids: List[int] = []
    for slot in range(1, job.n_wafer + 1):
        materials.append({
            "Name": str(mat_id), "ID": mat_id, "TaskID": task_id,
            "LotID": task_id, "FoupID": f"F{key}", "Priority": priority,
            "StepID": 0, "CurrentModuleName": lp, "SlotID": slot,
            "NeedSchedule": True, "PJobName": pjob, "SrcPortName": lp,
            "Route": copy.deepcopy(route),
        })
        mat_ids.append(mat_id)
        mat_id += 1

    # 带片清洁：注入 DummyPort 库存片（数量 = 每 PM job.n_dummy × 清洁腔室数）。
    if _is_dummy_type(job):
        dummy_task = f"dummy_{key}"
        for _ in range(job.n_dummy * len(job.clean_pms)):
            materials.append({
                "Name": str(mat_id), "ID": mat_id, "TaskID": dummy_task,
                "LotID": dummy_task, "FoupID": "DummyFoup", "Priority": -1,
                "StepID": 0, "CurrentModuleName": "DummyPort", "SlotID": 1,
                "NeedSchedule": True, "PJobName": "", "SrcPortName": "DummyPort",
            })
            mat_id += 1

    up = {
        "Scenario": 0,
        "Routes": {rname: copy.deepcopy(route)},
        "ProcessRecipes": list(process_recipes or []),
        "Materials": materials,
        "ProcessJobs": [{
            "JobName": pjob, "TaskID": task_id, "Priority": priority,
            "State": 0, "OriginRoute": copy.deepcopy(route), "MatList": mat_ids,
        }],
        "ControlJobs": [{
            "TaskID": task_id, "JobType": 0, "Priority": priority, "TaskMode": 0,
            "PJobNameList": [pjob], "MaterialCount": job.n_wafer,
        }],
        "RemoveList": [],
        "MoveStates": [],
        "CurrentTime": float(current_time),
    }
    return up, mat_id


def sample_jobs(n: int, rng: random.Random, *,
                pm_pool: Sequence[str] = PM_CANDIDATES,
                stage_range: Tuple[int, int] = (1, 1)) -> List[JobSpec]:
    return [JobSpec(i, rng, pm_pool=pm_pool, stage_range=stage_range) for i in range(n)]


def all_process_recipes(jobs: List[JobSpec], keys: Sequence[int]) -> List[Dict[str, Any]]:
    """所有 job 的 ProcessRecipes 并集（按 key 唯一），供首轮 update_params 携带。"""
    out: List[Dict[str, Any]] = []
    for job, key in zip(jobs, keys):
        out += job_process_recipes(job, key)
    return out


# --------------------------------------------------------------------------- #
# 并发混 job：6 腔室拓扑现合成 + 多 job 共存于同一 update
# --------------------------------------------------------------------------- #
def expand_topo_pms(topo: Dict[str, Any], pm_names: Sequence[str]) -> Dict[str, Any]:
    """把拓扑里缺的 PM（如 PM5/PM6）按已有 PM 模板克隆出来，并补全 VTR 的访问/搬运配置。

    克隆：Stations[新PM] ← 最后一个已有 PM；VTR.PlaceTime/PickTime/ArmPointerPair/
    ArmInfo.*.SlotsStationMap 各补一项；PrepTransTime 镜像模板 PM 的行/列 + 新 PM 互联。
    """
    topo = copy.deepcopy(topo)
    stations = topo["Stations"]
    vtr = topo["Robots"]["VTR"]
    existing = [p for p in pm_names if p in stations]
    if not existing:
        raise ValueError("拓扑中无任何模板 PM 可克隆")
    tmpl = existing[-1]
    new_pms = [p for p in pm_names if p not in stations]

    for pm in new_pms:
        s = copy.deepcopy(stations[tmpl])
        s["Name"] = pm
        stations[pm] = s

    for d in ("PlaceTime", "PickTime"):
        base = vtr[d][tmpl]
        for pm in new_pms:
            vtr[d][pm] = base

    pair_srcs = {p[0] for p in vtr["ArmPointerPair"]}
    for pm in new_pms:
        if pm not in pair_srcs:
            vtr["ArmPointerPair"].append([pm, pm])

    for arm in vtr["ArmInfo"].values():
        ssm = arm.get("SlotsStationMap")
        if isinstance(ssm, dict) and tmpl in ssm:
            for pm in new_pms:
                ssm[pm] = {"1": [{"Key": pm, "Value": 1}]}
        acc = arm.get("AccessibleStations")
        if isinstance(acc, list):
            for pm in new_pms:
                if pm not in acc:
                    acc.append(pm)

    # PrepTransTime：镜像模板 PM 的行/列；新 PM 之间互联用模板自环时长。
    ptt = vtr["PrepTransTime"]
    self_time = next((float(e["Time"]) for e in ptt
                      if e["SrcStation"] == tmpl and e["DestStation"] == tmpl), 1.65)
    add: List[Dict[str, Any]] = []
    for pm in new_pms:
        for e in ptt:
            if e["SrcStation"] == tmpl and e["DestStation"] != tmpl:
                add.append({"SrcStation": pm, "DestStation": e["DestStation"],
                            "TransType": e["TransType"], "Time": e["Time"]})
            if e["DestStation"] == tmpl and e["SrcStation"] != tmpl:
                add.append({"SrcStation": e["SrcStation"], "DestStation": pm,
                            "TransType": e["TransType"], "Time": e["Time"]})
    all_pms = existing + new_pms
    for a in new_pms:
        for b in all_pms:
            if a != b:
                add.append({"SrcStation": a, "DestStation": b, "TransType": 0, "Time": self_time})
        add.append({"SrcStation": a, "DestStation": a, "TransType": 0, "Time": self_time})
    ptt.extend(add)
    return topo


def assign_priorities(jobs: List[JobSpec], rng: random.Random, n_levels: int) -> None:
    """给各 job 赋调度优先级（1..n_levels，带重复 → 同优 job 可并发发片）。"""
    n_levels = max(1, n_levels)
    for job in jobs:
        job.priority = rng.randint(1, n_levels)


def build_concurrent_update(jobs: List[JobSpec], rng: random.Random, *,
                            lps: Sequence[str] = LP_POOL,
                            n_levels: int | None = None) -> Dict[str, Any]:
    """把多个 job 装进同一冷启动 update（共存并发）。priority 带重复，job 轮流分到各 LP。"""
    keys = [j.idx + 1 for j in jobs]
    if n_levels is None:
        n_levels = max(1, len(jobs) // 2)
    assign_priorities(jobs, rng, n_levels)
    recipes = all_process_recipes(jobs, keys)

    materials: List[Dict[str, Any]] = []
    pjobs: List[Dict[str, Any]] = []
    cjobs: List[Dict[str, Any]] = []
    routes: Dict[str, Any] = {}
    mat_id = 0
    for i, (job, key) in enumerate(zip(jobs, keys)):
        lp = lps[i % len(lps)]
        up, mat_id = build_update_params(job, key, job.priority, lp, mat_id, 0.0)
        materials += up["Materials"]
        pjobs += up["ProcessJobs"]
        cjobs += up["ControlJobs"]
        routes.update(up["Routes"])

    return {
        "Scenario": 0, "Routes": routes, "ProcessRecipes": recipes,
        "Materials": materials, "ProcessJobs": pjobs, "ControlJobs": cjobs,
        "RemoveList": [], "MoveStates": [], "CurrentTime": 0.0,
    }
