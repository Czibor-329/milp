"""输入解析：raw 接口（IToolTopo + IUpdateParams）→ 直接产出求解器要的 Problem。

取代旧的 PreprocessedTask 中间层 + milp._expand 二次展开。一条流水：

    parse_task(tool_topo, update_params)
      → synthesize_dummy_routes（合成带片清洁的 dummy 晶圆）
      → apply_dual_view（双腔成对视图）
      → _assemble_routes（ProcessRecipes 时长注入 + 顶层 Routes 收集 + 清洗解析）
      → _build_robots / _build_chambers（拓扑）
      → 路由线性化（parse_route_steps）+ 晶圆展开（round-robin 定腔 / slot / loadlock 抽充气）
      → Problem(chambers, robots, wafers, pre_clean, post_clean)

并入了原 task_ir / construct.route_sequence / config.cluster_tool.task_loader（仅实际用到的
解析链）/ config.input_loader 的有用部分；丢弃 takt / warm_start / cjobs / materials / dual_view /
route_idx / IR 序列化等无人消费的派生。
"""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass, field
from enum import IntEnum
from itertools import product
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from src.parse.clean import resolve_route_clean, synthesize_dummy_routes, _wac_from_afterout
from src.parse.dual import apply_dual_view
from src.log_setup import get_logger
from src.parse.model import Chamber, CleanSpec, Durations, Problem, Robot, Stage, Wafer

log = get_logger(__name__)


PROCESS_ASSIGNMENT_ROUND_ROBIN = "round_robin"
PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN = "acyclic_round_robin"


# --------------------------------------------------------------------------- #
# input_data 录制日志（AlgInit/AlgSchedule）读取
# --------------------------------------------------------------------------- #
def load_alg_entries(path: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """从 input_data 日志数组中取出 AlgInit / AlgSchedule 的 Info。"""
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)
    alg_init = next((e["Info"] for e in entries if e.get("Describe") == "AlgInit"), None)
    alg_schedule = next((e["Info"] for e in entries if e.get("Describe") == "AlgSchedule"), None)
    if alg_init is None:
        raise ValueError(f"{path} 中没有 Describe==AlgInit 的条目")
    if alg_schedule is None:
        raise ValueError(f"{path} 中没有 Describe==AlgSchedule 的条目")
    return alg_init, alg_schedule


def resize_task_materials(update_params: Mapping[str, Any], total_wafers: int) -> Dict[str, Any]:
    """把原始调度任务按 PJob 比例缩放到指定产品片数。

    该函数在 ``parse_task`` 之前工作，同步重建 ``Materials``、各 ``ProcessJob.MatList`` 和
    ``ControlJob.MaterialCount``。每个仍有晶圆的 PJob 至少保留一片，剩余片数按原始 PJob
    规模做最大余数分配；物料模板、route、recipe 和来源 LoadPort 均沿用原任务，槽位则在各
    LoadPort 内重新连续编号。这样可用同一配置构造 5 片训练实例和 25 片外推实例。

    参数：
      · update_params：接口格式的 IUpdateParams。
      · total_wafers：缩放后的产品晶圆总数，必须为正数。

    返回深拷贝后的新任务，不修改调用方传入数据。
    """
    if total_wafers <= 0:
        raise ValueError("total_wafers 必须为正数")

    payload: Dict[str, Any] = deepcopy(dict(update_params))
    process_jobs = list(payload.get("ProcessJobs") or [])
    materials = list(payload.get("Materials") or [])
    if not process_jobs or not materials:
        raise ValueError("任务缺少 ProcessJobs 或 Materials，无法缩放晶圆数")

    materials_by_id = {
        int(material["ID"]): material
        for material in materials
        if isinstance(material, Mapping) and material.get("ID") is not None
    }
    templates_by_job: Dict[str, List[Mapping[str, Any]]] = {}
    original_counts: List[int] = []
    for process_job in process_jobs:
        job_name = str(process_job.get("JobName") or "")
        material_ids = [int(value) for value in (process_job.get("MatList") or [])]
        templates = [materials_by_id[value] for value in material_ids if value in materials_by_id]
        if not templates:
            templates = [
                material for material in materials
                if str((material or {}).get("PJobName") or "") == job_name
            ]
        templates_by_job[job_name] = templates
        original_counts.append(len(templates))

    active_indices = [index for index, count in enumerate(original_counts) if count > 0]
    if not active_indices:
        raise ValueError("所有 ProcessJob 都没有可复用的物料模板")

    # 先尽量为每个原有 PJob 保留一片，再按原规模比例分配剩余片数。
    target_counts = [0] * len(process_jobs)
    if total_wafers < len(active_indices):
        for index in active_indices[:total_wafers]:
            target_counts[index] = 1
    else:
        for index in active_indices:
            target_counts[index] = 1
        remaining = total_wafers - len(active_indices)
        weight_sum = sum(original_counts[index] for index in active_indices)
        raw_extras = {
            index: remaining * original_counts[index] / weight_sum
            for index in active_indices
        }
        for index, raw_extra in raw_extras.items():
            target_counts[index] += int(raw_extra)
        assigned = sum(target_counts)
        remainder_order = sorted(
            active_indices,
            key=lambda index: (-(raw_extras[index] - int(raw_extras[index])), index),
        )
        for index in remainder_order[:total_wafers - assigned]:
            target_counts[index] += 1

    next_material_id = 0
    next_slot_by_port: Dict[str, int] = {}
    resized_materials: List[Dict[str, Any]] = []
    count_by_job: Dict[str, int] = {}
    for process_job, target_count in zip(process_jobs, target_counts):
        job_name = str(process_job.get("JobName") or "")
        templates = templates_by_job[job_name]
        new_material_ids: List[int] = []
        for rank in range(target_count):
            material = deepcopy(dict(templates[rank % len(templates)]))
            port = str(material.get("CurrentModuleName") or material.get("SrcPortName") or "")
            next_slot_by_port[port] = next_slot_by_port.get(port, 0) + 1
            material["ID"] = next_material_id
            material["Name"] = str(next_material_id)
            material["PJobName"] = job_name
            material["SlotID"] = next_slot_by_port[port]
            resized_materials.append(material)
            new_material_ids.append(next_material_id)
            next_material_id += 1
        process_job["MatList"] = new_material_ids
        count_by_job[job_name] = len(new_material_ids)

    for control_job in (payload.get("ControlJobs") or []):
        job_names = [str(name) for name in (control_job.get("PJobNameList") or [])]
        control_job["MaterialCount"] = sum(count_by_job.get(name, 0) for name in job_names)

    payload["ProcessJobs"] = process_jobs
    payload["Materials"] = resized_materials
    if "MaterialCount" in payload:
        payload["MaterialCount"] = total_wafers
    return payload


# --------------------------------------------------------------------------- #
# ControlJob / ProcessJob 解析（原 task_loader 实际用到的链）
# --------------------------------------------------------------------------- #
class CJobType(IntEnum):
    NormalLot = 0
    ManualJob = 1
    HighestLot = 2
    HigherLot = 3


# CJob 排序权：值越小越靠前（ManualJob > HighestLot > HigherLot > NormalLot）
_JOBTYPE_RANK = {
    int(CJobType.ManualJob): 0,
    int(CJobType.HighestLot): 1,
    int(CJobType.HigherLot): 2,
    int(CJobType.NormalLot): 3,
}


@dataclass(slots=True)
class PJobAssignment:
    """单个 ProcessJob 的运行时绑定信息。"""
    global_pjob_idx: int     # 跨 CJob 全局索引（按 payload.ProcessJobs 顺序）
    cjob_idx: int            # 所属 CJob 在 payload.ControlJobs 中的序号
    name: str
    priority: int            # PJob.Priority（数值小=高优）
    route_name: str
    load_port: str
    material_ids: List[int]
    material_count: int
    cjob_id: str = ""
    cjob_job_type: int = int(CJobType.NormalLot)
    cjob_priority: int = 1


@dataclass(slots=True)
class CJobAssignment:
    """单个 ControlJob 的运行时绑定信息（CJob 退化为 PJob 容器）。"""
    cjob_idx: int
    task_id: str
    material_count: int
    pjob_names: List[str]
    pjobs: List[PJobAssignment]
    job_type: int = int(CJobType.NormalLot)
    priority: int = 1


def _legacy_visit(station_name: str) -> Dict[str, Any]:
    return {
        "StationName": str(station_name),
        "SlotID": [1],
        "ProcessRecipe": "",
        "MoveTimeOffset": {},
        "QTimeLimit": -1,
        "ResidencyConstraint": -1,
        "AfterOutPM": [],
        "BeforeInPM": [],
    }


_LEGACY_STATION_KEYS = ("process_time", "cleaning_duration", "cleaning_trigger_wafers")


def _legacy_sequence_to_route_steps(seq: List[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """旧 sequence (station/transport 交替) → 标准 RouteSteps。

    旧 station 上的 process_time / cleaning_* 透传到 RouteStep 顶层（非标字段），
    由下游 parse_route_steps 再传回 station dict 使用。
    """
    if not seq:
        return []
    steps: List[Dict[str, Any]] = []
    for i, entry in enumerate(seq):
        sid = i
        post = [i + 1] if i + 1 < len(seq) else []
        if "transport" in entry:
            steps.append({
                "StepID": sid,
                "PostStepID": post,
                "NeedProcess": False,
                "Visits": [_legacy_visit(entry["transport"])],
            })
        else:
            stations = entry.get("station") or []
            stage_type = str(entry.get("stage_type", "") or "")
            step: Dict[str, Any] = {
                "StepID": sid,
                "PostStepID": post,
                "NeedProcess": stage_type == "process",
                "Visits": [_legacy_visit(s) for s in stations],
            }
            for k in _LEGACY_STATION_KEYS:
                if entry.get(k) is not None:
                    step[k] = entry[k]
            steps.append(step)
    return steps


def _ensure_route_steps(entry: Dict[str, Any]) -> Dict[str, Any]:
    """若 route entry 只含旧 sequence，则原地补一份等价 RouteSteps。"""
    if entry.get("RouteSteps"):
        return entry
    seq = entry.get("sequence")
    if isinstance(seq, list) and seq:
        entry["RouteSteps"] = _legacy_sequence_to_route_steps(seq)
    return entry


def task_routes(payload: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for name, route in (payload.get("Routes") or {}).items():
        entry = deepcopy(dict(route or {}))
        _ensure_route_steps(entry)
        out[str(name)] = entry
    return out


def _pjob_index_by_name(payload: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {str(pj.get("JobName", "")): pj for pj in (payload.get("ProcessJobs") or [])}


def _resolve_pjob_load_port(routes: Mapping[str, Mapping[str, Any]], route_name: str) -> str:
    """从 Route.RouteSteps[0].Visits[0].StationName（source 站）取 LP 名字。"""
    route = routes.get(route_name) or {}
    steps = route.get("RouteSteps") or []
    if not steps:
        seq = route.get("sequence") or []
        if not seq:
            raise ValueError(f"Route {route_name!r} has no RouteSteps / sequence")
        steps = _legacy_sequence_to_route_steps(seq)
    visits = (steps[0].get("Visits") or [])
    if not visits:
        raise ValueError(f"Route {route_name!r} RouteSteps[0] has no Visits")
    name = visits[0].get("StationName")
    if not name:
        raise ValueError(f"Route {route_name!r} RouteSteps[0].Visits[0] missing StationName")
    return str(name)


def task_cjob_assignments(payload: Mapping[str, Any]) -> List[CJobAssignment]:
    """解析 ControlJobs → PJobs → Materials → RouteName，并按 CJob 优先级排序。

    CJob 排序规则（两层权威顺序的第一层）：
      1. JobType：ManualJob > HighestLot > HigherLot > NormalLot；
      2. NormalLot 内再按 CJob.Priority 升序（1=最高）；
      3. 最后按原 cjob_idx 稳定兜底。
    """
    cjobs_raw = list(payload.get("ControlJobs") or [])
    pjob_by_name = _pjob_index_by_name(payload)
    routes_section = dict(payload.get("Routes") or {})
    # global_pjob_idx 按 payload.ProcessJobs 出现顺序赋值
    global_idx_by_name: Dict[str, int] = {
        str(pj.get("JobName", "")): i
        for i, pj in enumerate(payload.get("ProcessJobs") or [])
    }

    out: List[CJobAssignment] = []
    for cidx, cj in enumerate(cjobs_raw):
        pjob_names = [str(n) for n in (cj.get("PJobNameList") or [])]
        if not pjob_names:
            raise ValueError(f"ControlJob[{cidx}] PJobNameList empty")
        pjobs: List[PJobAssignment] = []
        mat_ids: List[int] = []
        for name in pjob_names:
            pj = pjob_by_name.get(name)
            if pj is None:
                raise ValueError(f"PJob {name!r} not found for ControlJob[{cidx}]")
            if "Priority" not in pj:
                raise ValueError(f"PJob {name!r} missing Priority")
            r_name = str((pj.get("OriginRoute") or {}).get("Name") or "")
            if not r_name:
                raise ValueError(f"PJob {name!r} missing OriginRoute.Name")
            if r_name not in routes_section:
                raise ValueError(f"PJob {name!r} references unknown Route {r_name!r}")
            lp = _resolve_pjob_load_port(routes_section, r_name)
            pj_mat_ids = [int(x) for x in (pj.get("MatList") or [])]
            mat_ids.extend(pj_mat_ids)
            pjobs.append(PJobAssignment(
                global_pjob_idx=int(global_idx_by_name.get(name, len(global_idx_by_name))),
                cjob_idx=int(cidx),
                name=name,
                priority=int(pj.get("Priority")),
                route_name=r_name,
                load_port=lp,
                material_ids=pj_mat_ids,
                material_count=len(pj_mat_ids),
            ))
        job_type = int(cj.get("JobType", int(CJobType.NormalLot)) or 0)
        cjob_priority = int(cj.get("Priority", 1) or 1)
        out.append(CJobAssignment(
            cjob_idx=int(cidx),
            task_id=str(cj.get("TaskID", "")),
            material_count=int(cj.get("MaterialCount", len(mat_ids))),
            pjob_names=pjob_names,
            pjobs=pjobs,
            job_type=job_type,
            priority=cjob_priority,
        ))
        cjob_id = f"{str(cj.get('TaskID', ''))}:{cidx}"
        for assignment in pjobs:
            assignment.cjob_id = cjob_id
            assignment.cjob_job_type = job_type
            assignment.cjob_priority = cjob_priority
    out.sort(key=lambda c: (
        _JOBTYPE_RANK.get(int(c.job_type), 99),
        int(c.priority) if int(c.job_type) == int(CJobType.NormalLot) else 0,
        int(c.cjob_idx),
    ))
    return out


def task_pjob_assignments(payload: Mapping[str, Any]) -> List[PJobAssignment]:
    """扁平 PJob 列表（全局权威顺序）。

    按已排序的 CJob 顺序串接，每个 CJob 内 PJob 按 (priority, global_pjob_idx) 升序。
    """
    pjs: List[PJobAssignment] = []
    for cj in task_cjob_assignments(payload):
        pjs.extend(sorted(
            cj.pjobs, key=lambda p: (int(p.priority), int(p.global_pjob_idx)),
        ))
    return pjs


def task_route_entry_by_name(payload: Mapping[str, Any], route_name: str) -> Dict[str, Any]:
    """从 payload.Routes[name] 取 entry 并注入默认值。"""
    routes = task_routes(payload)
    entry = deepcopy(routes.get(route_name) or {})
    if not entry:
        # 退化：扫 Materials 找一份 inline Route
        for m in (payload.get("Materials") or []):
            r = m.get("Route") or {}
            if str(r.get("Name") or "") == route_name:
                entry = deepcopy(r)
                break
    if not entry:
        raise ValueError(f"Route {route_name!r} not found in payload.Routes or Materials")
    entry["Name"] = route_name
    _ensure_route_steps(entry)
    entry.setdefault("ratio", [1, 0])
    return entry


# --------------------------------------------------------------------------- #
# RouteSteps 线性化（原 construct.route_sequence）
# --------------------------------------------------------------------------- #
_ALLOWED_STAGE_TYPES: frozenset = frozenset(
    {"source", "sink", "process", "buffer", "loadlock"}
)

# Station.Type（小写）→ stage_type 推断（仅用于既非首末也非 process 的 step）；
# 未命中（heater/cooler/aligner 等）回退 buffer。
_TYPE_TO_STAGE: Dict[str, str] = {
    "buffer": "buffer",
    "loadlock": "loadlock",
}


def _linearize_steps(
    route_name: str, route_steps: Sequence[Mapping[str, Any]],
) -> List[Mapping[str, Any]]:
    if not route_steps:
        raise ValueError(f"route {route_name}: RouteSteps is empty")
    by_id: Dict[int, Mapping[str, Any]] = {}
    for s in route_steps:
        if "StepID" not in s:
            raise ValueError(f"route {route_name}: step missing StepID")
        sid = int(s["StepID"])
        if sid in by_id:
            raise ValueError(f"route {route_name}: duplicate StepID={sid}")
        by_id[sid] = s
    has_pred: set = set()
    for s in route_steps:
        post = list(s.get("PostStepID") or [])
        if len(post) > 1:
            raise NotImplementedError(
                f"route {route_name} step {s.get('StepID')}: branching PostStepID not supported"
            )
        for p in post:
            has_pred.add(int(p))
    roots = [int(s["StepID"]) for s in route_steps if int(s["StepID"]) not in has_pred]
    if len(roots) != 1:
        raise ValueError(f"route {route_name}: expected exactly 1 root step, got {roots}")
    chain: List[Mapping[str, Any]] = []
    seen: set = set()
    cur = roots[0]
    while True:
        if cur in seen:
            raise ValueError(f"route {route_name}: cycle at StepID={cur}")
        seen.add(cur)
        step = by_id.get(cur)
        if step is None:
            raise ValueError(f"route {route_name}: dangling PostStepID={cur}")
        chain.append(step)
        post = list(step.get("PostStepID") or [])
        if not post:
            break
        cur = int(post[0])
    if len(chain) != len(by_id):
        raise ValueError(
            f"route {route_name}: {len(by_id)} steps but only {len(chain)} on linear chain"
        )
    return chain


def _visit_names(step: Mapping[str, Any]) -> List[str]:
    visits = step.get("Visits") or []
    out: List[str] = []
    for v in visits:
        name = v.get("StationName") if isinstance(v, Mapping) else None
        if not name:
            raise ValueError(f"step {step.get('StepID')}: visit missing StationName")
        out.append(str(name))
    if not out:
        raise ValueError(f"step {step.get('StepID')}: empty Visits")
    return out


def _limit_value(raw: Any, default: int = -1) -> int:
    if isinstance(raw, (int, float)):
        return int(raw)
    return int(default)


def parse_route_steps(
    route_name: str,
    route_steps: Sequence[Mapping[str, Any]],
    *,
    tm_scopes: Mapping[str, frozenset],
    stations_cfg: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> Tuple[List[Dict[str, Any]], List[str], List[int]]:
    """返回 (stations, transports, transport_qtimes)，len(stations) == len(transports) + 1。"""
    stations_cfg = stations_cfg or {}
    chain = _linearize_steps(route_name, route_steps)
    robot_names = set(tm_scopes.keys())

    is_transport: List[bool] = []
    for step in chain:
        names = _visit_names(step)
        all_robots = all(n in robot_names for n in names)
        any_robot = any(n in robot_names for n in names)
        if any_robot and not all_robots:
            raise ValueError(
                f"route {route_name} step {step.get('StepID')}: "
                f"mixed robot/chamber visits {names}"
            )
        is_transport.append(all_robots)

    # 起止必为 station，station/transport 严格交替
    n = len(chain)
    if n < 3 or n % 2 == 0:
        raise ValueError(
            f"route {route_name}: step count {n} invalid (must be odd, >=3)"
        )
    if is_transport[0] or is_transport[-1]:
        raise ValueError(f"route {route_name}: first/last step must be station, not robot")
    for i, t in enumerate(is_transport):
        expected_transport = (i % 2 == 1)
        if t != expected_transport:
            raise ValueError(
                f"route {route_name} step idx {i} (StepID={chain[i].get('StepID')}): "
                f"expected {'transport' if expected_transport else 'station'}"
            )

    stations: List[Dict[str, Any]] = []
    transports: List[str] = []
    transport_qtimes: List[int] = []

    for i, step in enumerate(chain):
        names = _visit_names(step)
        visits = step.get("Visits") or []
        if is_transport[i]:
            if len(names) > 1:
                raise ValueError(
                    f"route {route_name} step {step.get('StepID')}: "
                    f"transport step with multiple robot candidates {names}"
                )
            transports.append(names[0])
            transport_qtimes.append(_limit_value((visits[0] or {}).get("QTimeLimit")))
            continue

        # station step → 推断 stage_type
        if i == 0:
            stage_type = "source"
        elif i == n - 1:
            stage_type = "sink"
        elif bool(step.get("NeedProcess")):
            stage_type = "process"
        else:
            cand_types = {
                str((stations_cfg.get(c) or {}).get("Type") or "").lower()
                for c in names
            }
            cand_types.discard("")
            stage_type = ""
            for t in cand_types:
                mapped = _TYPE_TO_STAGE.get(t)
                if mapped:
                    stage_type = mapped
                    break
            if not stage_type:
                stage_type = "buffer"

        if stage_type not in _ALLOWED_STAGE_TYPES:
            raise ValueError(
                f"route {route_name} step {step.get('StepID')}: "
                f"invalid stage_type {stage_type!r}"
            )

        station: Dict[str, Any] = {
            "candidates": list(names),
            "stage_type": stage_type,
            "residency": {
                str(v.get("StationName")): (
                    _limit_value(v.get("ResidencyConstraint"))
                    if stage_type == "process"
                    else -1
                )
                for v in visits
                if isinstance(v, Mapping) and v.get("StationName")
            },
        }
        # 透传旧字段（兼容 legacy sequence 写入的额外字段）
        for opt in ("process_time", "cleaning_duration", "cleaning_trigger_wafers"):
            if step.get(opt) is not None:
                station[opt] = step[opt]
        stations.append(station)

    # TM scope 校验：每个 hop 两侧 station 的 candidates 必须落在对应 TM scope 内
    for hop_idx, tm in enumerate(transports):
        scope = tm_scopes[tm]
        src = stations[hop_idx]["candidates"]
        dst = stations[hop_idx + 1]["candidates"]
        bad = [c for c in (*src, *dst) if c not in scope]
        if bad:
            raise ValueError(
                f"route {route_name} hop[{hop_idx}] {tm}: chambers {bad} not in {tm} scope"
            )

    return stations, transports, transport_qtimes


# --------------------------------------------------------------------------- #
# 接口 payload 补齐 native 形状：ProcessRecipes 时长注入 + 顶层 Routes 收集 + 清洗解析
# --------------------------------------------------------------------------- #
def _recipe_index(process_recipes: Optional[Sequence[Mapping[str, Any]]]) -> Dict[Tuple[str, str], float]:
    """(Name, ModuleName) -> Time。"""
    idx: Dict[Tuple[str, str], float] = {}
    for r in (process_recipes or []):
        if not isinstance(r, Mapping):
            continue
        name = str(r.get("Name") or "")
        module = str(r.get("ModuleName") or "")
        if name and r.get("Time") is not None:
            idx[(name, module)] = float(r["Time"])
    return idx


def resolve_route_step_times(
    route_steps: Optional[Sequence[Dict[str, Any]]],
    recipe_idx: Mapping[Tuple[str, str], float],
) -> None:
    """就地把 ProcessRecipes 的加工/清洗(Wac)时长注入各 RouteStep（缺啥补啥）。"""
    for step in (route_steps or []):
        if not isinstance(step, dict) or not step.get("NeedProcess"):
            continue
        for v in (step.get("Visits") or []):
            station = str(v.get("StationName") or "")
            # 加工时长
            if "process_time" not in step:
                recipe = str(v.get("ProcessRecipe") or "")
                t = recipe_idx.get((recipe, station))
                if t is not None:
                    step["process_time"] = int(round(t))
            # 清洗（Wac）：按 CleanCondition 条件树（CounterCondition）解析
            if "cleaning_trigger_wafers" not in step and "cleaning_duration" not in step:
                clean = _wac_from_afterout(v.get("AfterOutPM"))
                if clean is not None:
                    recipe_name, trigger, task_name = clean
                    dur = recipe_idx.get((recipe_name, station))
                    if dur is not None:
                        step["cleaning_duration"] = int(round(dur))
                        step["cleaning_trigger_wafers"] = int(trigger)
                        step["cleaning_recipe"] = recipe_name
                        step["cleaning_task"] = task_name


def _assemble_routes(
    payload: Dict[str, Any],
    process_recipes: Optional[Sequence[Mapping[str, Any]]] = None,
) -> None:
    """就地把接口格式 payload 补齐成 native 形状。对 native payload 幂等。

      - ProcessRecipes 时长注入 Materials 内联 / 顶层 RouteSteps；
      - 顶层 Routes：从 Materials 内联 Route 按 Name 去重补齐（不覆盖已注册的合成 dummy route）；
      - 清洗解析：pre/post/dummy_clean_by_pm per-PM 表（见 clean.resolve_route_clean）。
    """
    recipe_idx = _recipe_index(process_recipes)
    if recipe_idx:
        for m in (payload.get("Materials") or []):
            resolve_route_step_times((m.get("Route") or {}).get("RouteSteps"), recipe_idx)
    routes: Dict[str, Any] = dict(payload.get("Routes") or {})
    for m in (payload.get("Materials") or []):
        r = m.get("Route")
        if isinstance(r, dict) and r.get("Name") and str(r["Name"]) not in routes:
            routes[str(r["Name"])] = r
    if routes:
        payload["Routes"] = routes
        if recipe_idx:
            for r in routes.values():
                resolve_route_step_times((r or {}).get("RouteSteps"), recipe_idx)
    resolve_route_clean((payload.get("Routes") or {}).values(), recipe_idx)


# --------------------------------------------------------------------------- #
# 派生：拓扑（机器手 / 腔室）
# --------------------------------------------------------------------------- #
def _build_robots(robots_raw: Mapping[str, Any]) -> Dict[str, Robot]:
    out: Dict[str, Robot] = {}
    for name, rb in (robots_raw or {}).items():
        cfg = rb or {}
        arm_a = (cfg.get("ArmInfo") or {}).get("ArmA") or {}
        out[str(name)] = Robot(
            name=str(name),
            scope=[str(s) for s in (arm_a.get("AccessibleStations") or [])],
            capacity=int(cfg.get("Capacity", 1) or 1),
            can_swap=int(cfg.get("Capacity", 1) or 1) >= 2,
            pick_time={str(k): float(v) for k, v in dict(cfg.get("PickTime") or {}).items()},
            place_time={str(k): float(v) for k, v in dict(cfg.get("PlaceTime") or {}).items()},
            prep_trans_time=list(cfg.get("PrepTransTime") or []),
        )
    return out


def _build_chambers(stations_raw: Mapping[str, Any]) -> Dict[str, Chamber]:
    """从 task_payload["Stations"] 提取站点静态配置 + 门动作时长，折进 Chamber 类。

    含 loadport（作为门动作时长载体）。LoadLock 保留物理容量；双槽异型共存时，
    sequencing/timing 通过跨槽 ``ll_seq`` 统一约束单一压力态。
    """
    out: Dict[str, Chamber] = {}
    for name, entry in (stations_raw or {}).items():
        if not isinstance(entry, Mapping):
            continue
        cls_raw = entry.get("Type")
        if cls_raw is None:
            raise ValueError(f"Station {name!r} missing required 'Type'")
        cls = str(cls_raw)

        def _td(field_name: str) -> Dict[str, float]:
            return {str(k): float(v) for k, v in dict(entry.get(field_name) or {}).items()}

        cap = int(entry.get("Capacity", 1) or 1)
        chamber = Chamber(
            name=str(name), type=cls, capacity=cap,
            pick_prepare_time=_td("PickPrepareTime"),
            place_prepare_time=_td("PlacePrepareTime"),
            pick_complete_time=_td("PickCompleteTime"),
            place_complete_time=_td("PlaceCompleteTime"),
        )
        if entry.get("PumpTime") is not None:
            chamber.pump_time = float(entry["PumpTime"])
        if entry.get("VentTime") is not None:
            chamber.vent_time = float(entry["VentTime"])
        if cls.lower() == "loadlock":
            # 接口 pump/vent 在 PrePrepareTime 列表里；显式字段优先。LL 时长保留小数。
            for pp in (entry.get("PrePrepareTime") or []):
                if not isinstance(pp, Mapping) or pp.get("Time") is None:
                    continue
                pp_type = str(pp.get("PrePrepareType") or "").lower()
                if pp_type.startswith("pump") and chamber.pump_time is None:
                    chamber.pump_time = float(pp["Time"])
                elif pp_type.startswith("vent") and chamber.vent_time is None:
                    chamber.vent_time = float(pp["Time"])
        out[str(name)] = chamber
    return out


# --------------------------------------------------------------------------- #
# 路由模板（解析期本地结构，不进 Problem）+ 晶圆展开
# --------------------------------------------------------------------------- #
@dataclass
class _RouteTmpl:
    stages: List[Dict[str, Any]]    # 每项: visits/stage_type/time/residency/clean_time/clean_trigger/clean_recipe
    transports: List[str]           # hop -> robot
    pre_clean: List[CleanSpec] = field(default_factory=list)
    post_clean: List[CleanSpec] = field(default_factory=list)
    dummy_wac: List[CleanSpec] = field(default_factory=list)


def _clean_specs(table: Mapping[str, Any]) -> List[CleanSpec]:
    """route entry 的 per-PM 清洁表 → CleanSpec（按 (duration,recipe,task) 聚合 PM）。"""
    grouped: Dict[Tuple[float, str, str], List[str]] = {}
    for pm, spec in (table or {}).items():
        key = (float(spec.get("duration") or 0), str(spec.get("recipe") or ""), str(spec.get("task") or ""))
        grouped.setdefault(key, []).append(str(pm))
    return [CleanSpec(visits=pms, time=k[0], recipe=k[1], task=k[2]) for k, pms in grouped.items()]


def _dummy_wac_specs(table: Mapping[str, Any]) -> List[CleanSpec]:
    """dummy_clean_by_pm 表 → dummy-wac CleanSpec（time=empty_duration）。
    只取有 empty_duration 的 PM（dummywacclean 才带）；dummy 清洁本身是合成 dummy 晶圆、不在此。"""
    grouped: Dict[Tuple[float, str], List[str]] = {}
    for pm, spec in (table or {}).items():
        edur = spec.get("empty_duration")
        if not edur:
            continue
        key = (float(edur), str(spec.get("empty_recipe") or ""))
        grouped.setdefault(key, []).append(str(pm))
    return [CleanSpec(visits=pms, time=k[0], recipe=k[1], task="") for k, pms in grouped.items()]


def _build_route_tmpl(
    name: str, entry: Mapping[str, Any], tm_scopes: Mapping[str, frozenset],
    stations_cfg: Mapping[str, Any],
) -> _RouteTmpl:
    stations, transports, _qtimes = parse_route_steps(
        route_name=str(name), route_steps=entry.get("RouteSteps") or [],
        tm_scopes=tm_scopes, stations_cfg=stations_cfg,
    )
    # RouteStep 上的 cleaning_recipe（注入）按 candidate 收集，附到对应 stage
    recipe_by_pm: Dict[str, str] = {}
    for st in (entry.get("RouteSteps") or []):
        recipe = str(st.get("cleaning_recipe") or "")
        if not recipe:
            continue
        for v in (st.get("Visits") or []):
            pm = str(v.get("StationName") or "")
            if pm:
                recipe_by_pm.setdefault(pm, recipe)

    stages: List[Dict[str, Any]] = []
    for station in stations:
        resid = station.get("residency") or {}
        rvals = [int(x) for x in resid.values()]
        rv = (max(rvals) if rvals else -1) if station["stage_type"] == "process" else -1
        cands = [str(c) for c in station["candidates"]]
        recipe = ""
        for c in cands:
            if c in recipe_by_pm:
                recipe = recipe_by_pm[c]
                break
        stages.append({
            "visits": cands,
            "stage_type": str(station["stage_type"]),
            "time": float(station.get("process_time") or 0),
            "residency": rv,
            "clean_time": int(station.get("cleaning_duration") or 0),
            "clean_trigger": int(station.get("cleaning_trigger_wafers") or 0),
            "clean_recipe": recipe,
        })

    return _RouteTmpl(
        stages=stages,
        transports=[str(t) for t in transports],
        pre_clean=_clean_specs(entry.get("pre_clean_by_pm") or {}),
        post_clean=_clean_specs(entry.get("post_clean_by_pm") or {}),
        dummy_wac=_dummy_wac_specs(entry.get("dummy_clean_by_pm") or {}),
    )


def _round_robin(candidates: List[str], rank: int) -> str:
    return candidates[rank % len(candidates)] if candidates else ""


def _acyclic_process_paths(
    route_name: str,
    stage_steps: Sequence[Mapping[str, Any]],
    process_pm_order: Optional[Sequence[str]],
) -> Tuple[List[int], List[Tuple[str, ...]]]:
    """枚举一条 Route 可采用的严格递增加工腔路径。

    每道加工工序从自己的候选池选择一个 PM；同片不同工序不可重复使用 PM，且所选
    PM 在固定顺序中必须严格递增。该约束消除不同晶圆形成相反 PM 资源环的可能性。

    参数：
        route_name: 用于错误信息的 Route 名称。
        stage_steps: 已线性化的 Route stage 模板。
        process_pm_order: PM 的全局固定顺序；未提供时按候选名称排序推导。

    返回：
        ``(加工 stage 下标, 合法 PM 路径)``。

    Raises:
        ValueError: 候选池为空、包含不在固定顺序内的 PM，或不存在合法路径。
    """
    process_indices = [
        index for index, stage in enumerate(stage_steps)
        if str(stage.get("stage_type")) == "process"
    ]
    if not process_indices:
        return [], [tuple()]

    pools = [list(stage_steps[index].get("visits") or []) for index in process_indices]
    if any(not pool for pool in pools):
        raise ValueError(f"Route {route_name!r} 的加工候选池不能为空：{pools}")

    if process_pm_order is None:
        pm_order = sorted({pm for pool in pools for pm in pool})
    else:
        pm_order = list(process_pm_order)
    if len(pm_order) != len(set(pm_order)):
        raise ValueError(f"process_pm_order 包含重复 PM：{pm_order}")
    order_index = {pm: index for index, pm in enumerate(pm_order)}
    unknown = sorted({pm for pool in pools for pm in pool if pm not in order_index})
    if unknown:
        raise ValueError(
            f"Route {route_name!r} 的候选 PM {unknown} 不在固定顺序 {pm_order} 中"
        )

    valid_paths = [
        tuple(path)
        for path in product(*pools)
        if all(order_index[left] < order_index[right] for left, right in zip(path, path[1:]))
    ]
    if not valid_paths:
        raise ValueError(
            f"Route {route_name!r} 没有合法的严格递增 PM 路径；候选池={pools}，"
            f"固定顺序={pm_order}"
        )
    return process_indices, valid_paths


def _expand_wafers(
    chambers: Dict[str, Chamber], dur: Durations,
    routes: Dict[str, _RouteTmpl], pjob_assignments: List[PJobAssignment],
    *, process_assignment: str = PROCESS_ASSIGNMENT_ROUND_ROBIN,
    process_pm_order: Optional[Sequence[str]] = None,
) -> List[Wafer]:
    """每个 pjob 的每片 material → Wafer，按 (pjob 顺序, material 顺序) 定全局 wid。
    含定腔、loadlock 抽/充气时长、多容量腔 round-robin 槽位（取代旧 milp._expand）。

    ``process_assignment`` 默认保持历史的逐工序 round-robin。L2D 使用可选的
    ``acyclic_round_robin``：先枚举每条 Route 的严格递增 PM 路径，再按晶圆轮询整条路径，
    从而同时保证同片 PM 不重复和跨片资源方向一致。
    """
    supported_assignments = {
        PROCESS_ASSIGNMENT_ROUND_ROBIN,
        PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN,
    }
    if process_assignment not in supported_assignments:
        raise ValueError(
            f"未知 process_assignment={process_assignment!r}；可选值={sorted(supported_assignments)}"
        )
    wafers: List[Wafer] = []
    wid = 0
    slot_counter: Dict[str, int] = {}
    # process 腔 round-robin 按 (stage, 候选池) 全局连续计数：多 pjob 共享同一腔池时接着轮
    # （job2 从 job1 停下的位置继续，负载均衡）而非每 pjob 归零。单 pjob / 池不相交时 == rank。
    # loadlock 仍按 rank（其腔分配是 MILP/timing 决策，robin 只是初始默认，维持既有基线）。
    # 例外：dummy 清洁 pjob 的 loadlock 也走全局连续计数——每个 dummy pjob 通常只有 1~2 片、
    # rank 从 0 重数，按 rank 轮转会让所有 dummy pjob 的首片挤同一 loadlock（进+出都是它，
    # 另一 LL 闲置 ⇒ dummy 段串行）；跨 pjob 接着轮后各 PM 的 dummy 片 LA/LB 交替。
    robin_counter: Dict[tuple, int] = {}
    route_path_counter: Dict[str, int] = {}
    route_paths: Dict[str, Tuple[List[int], List[Tuple[str, ...]]]] = {}
    if process_assignment == PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN:
        route_paths = {
            route_name: _acyclic_process_paths(route_name, route.stages, process_pm_order)
            for route_name, route in routes.items()
        }

    for pj in pjob_assignments:
        rt = routes[pj.route_name]
        stage_steps = rt.stages
        transports = rt.transports
        dummy_pj = pj.name.startswith("dummy_") or "_dummy_" in pj.route_name
        for rank, mat in enumerate(pj.material_ids):
            stages: List[Stage] = []
            selected_process_chambers: Dict[int, str] = {}
            if process_assignment == PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN:
                process_indices, valid_paths = route_paths[pj.route_name]
                path_rank = route_path_counter.get(pj.route_name, 0)
                route_path_counter[pj.route_name] = path_rank + 1
                selected_path = valid_paths[path_rank % len(valid_paths)]
                selected_process_chambers = dict(zip(process_indices, selected_path))
            # 同一片晶圆回到 source LoadPort 时必须复用它的初始物理槽位；若 source/sink 分别
            # 消耗全局 slot_counter，25 槽 LoadPort 在第 13 片就会绕回并产生初始占位冲突。
            home_slots: Dict[str, int] = {}
            for j, st in enumerate(stage_steps):
                in_r = transports[j - 1] if j >= 1 else ""
                out_r = transports[j] if j < len(transports) else ""
                if j in selected_process_chambers:
                    chamber = selected_process_chambers[j]
                elif st["stage_type"] == "process" or (dummy_pj and st["stage_type"] == "loadlock"):
                    rkey = (st["stage_type"], j, tuple(st["visits"]))
                    k = robin_counter.get(rkey, 0)
                    robin_counter[rkey] = k + 1
                    chamber = _round_robin(st["visits"], k)
                else:
                    chamber = _round_robin(st["visits"], rank)
                proc = float(st["time"])
                ll_type = ""
                if st["stage_type"] == "loadlock":
                    entry = in_r in dur.atm_robots  # 进站手是大气手 → 进真空，抽气
                    ll_type = "entry" if entry else "exit"
                    ch = chambers.get(chamber)
                    proc = float((ch.pump_time if entry else ch.vent_time) or 0.0) if ch else 0.0
                ch = chambers.get(chamber)
                if st["stage_type"] == "loadlock":
                    # 双槽 LL 才按方向分槽；单槽 LL 的 entry/exit 必须都落物理槽 0。
                    # 互斥退到同槽内，不能为单槽设备导出不存在的 SlotID=2。
                    capacity = int(ch.capacity) if ch else 1
                    slot = (
                        0 if ll_type == "entry" else 1
                    ) if capacity >= 2 else 0
                else:
                    cap = int(ch.capacity) if ch else 1
                    if st["stage_type"] == "sink" and chamber in home_slots:
                        slot = home_slots[chamber]
                    else:
                        slot = slot_counter.get(chamber, 0) % max(cap, 1)
                        slot_counter[chamber] = slot_counter.get(chamber, 0) + 1
                        if st["stage_type"] == "source":
                            home_slots[chamber] = slot
                stages.append(Stage(
                    j=j, chamber=chamber, stage_type=st["stage_type"], proc=proc,
                    in_robot=in_r, out_robot=out_r,
                    residency=float(st["residency"]), ll_type=ll_type, slot=slot,
                    clean_time=float(st["clean_time"]), clean_trigger=int(st["clean_trigger"]),
                    clean_recipe=st["clean_recipe"], cands=list(st["visits"]),
                ))
            wafers.append(Wafer(wid=wid, mat_id=mat, route_name=pj.route_name,
                                route_rank=rank, stages=stages, transports=list(transports),
                                pjob_name=pj.name, cjob_id=pj.cjob_id,
                                cjob_job_type=pj.cjob_job_type,
                                cjob_priority=pj.cjob_priority))
            wid += 1
    return wafers


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
def _problem_from_payload(
    payload: Mapping[str, Any],
    *,
    process_assignment: str = PROCESS_ASSIGNMENT_ROUND_ROBIN,
    process_pm_order: Optional[Sequence[str]] = None,
) -> Problem:
    """已组装/归一化的 task_payload → Problem，并按指定模式固定加工腔。"""
    cjob_assignments = task_cjob_assignments(payload)
    if not cjob_assignments:
        raise ValueError("task payload has no usable ControlJobs")
    pjob_assignments = task_pjob_assignments(payload)
    if not pjob_assignments:
        raise ValueError("task payload has no usable ProcessJobs")

    route_order: List[str] = []
    for pj in pjob_assignments:
        if pj.route_name not in route_order:
            route_order.append(pj.route_name)

    robots = _build_robots(payload.get("Robots") or {})
    chambers = _build_chambers(payload.get("Stations") or {})
    tm_scopes = {n: frozenset(r.scope) for n, r in robots.items()}
    stations_cfg = payload.get("Stations") or {}

    routes = {
        name: _build_route_tmpl(name, task_route_entry_by_name(payload, name),
                                tm_scopes, stations_cfg)
        for name in route_order
    }

    problem = Problem(chambers=chambers, robots=robots, wafers=[])
    dur = Durations(problem)
    problem.wafers = _expand_wafers(
        chambers,
        dur,
        routes,
        pjob_assignments,
        process_assignment=process_assignment,
        process_pm_order=process_pm_order,
    )
    problem.pre_clean = [s for name in route_order for s in routes[name].pre_clean]
    problem.post_clean = [s for name in route_order for s in routes[name].post_clean]
    problem.dummy_wac = [s for name in route_order for s in routes[name].dummy_wac]
    # dummy 清洁 pjob → 所属产品 pjob（synthesize_dummy_routes 注入 _ProductPJob），
    # 供 milp_clean 把 dummy 段定序在「前一 job 末片 → 本 job 首片」之间。
    problem.dummy_owner = {
        str(pj.get("JobName") or ""): str(pj["_ProductPJob"])
        for pj in (payload.get("ProcessJobs") or [])
        if isinstance(pj, Mapping) and pj.get("_ProductPJob")
    }
    return problem


def parse_task(
    tool_topo: Mapping[str, Any],
    update_params: Mapping[str, Any],
    *,
    process_assignment: str = PROCESS_ASSIGNMENT_ROUND_ROBIN,
    process_pm_order: Optional[Sequence[str]] = None,
) -> Problem:
    """由 tool_topo + update_params 组装内部 task_payload，直接产出求解器要的 Problem。

    标准重算数据（文档接口格式）经 _assemble_routes 就地补齐成 native 形状；
    ProcessRecipes 在补齐前取出再传给补齐。PreDummyClean 合成 dummy 晶圆的
    route/PJob/CJob 须在 dual-view / 补齐之前。

    ``process_assignment`` 默认使用历史逐工序 round-robin；传入 ``acyclic_round_robin``
    时按 ``process_pm_order`` 枚举严格递增实际路径并整条轮询。返回值中的实际 PM、LA/LB
    和槽位都已固定，可直接交给 timing 或 L2D 顺序策略。
    """
    process_recipes = update_params.get("ProcessRecipes")
    payload: Dict[str, Any] = {k: deepcopy(v) for k, v in update_params.items()}
    payload["Robots"] = dict(tool_topo.get("Robots") or {})
    payload["Stations"] = dict(tool_topo.get("Stations") or {})
    synthesize_dummy_routes(payload)
    # 双腔设备：2 片成对建模（须在补齐之前，清洁解析基于成对视图）
    apply_dual_view(payload)
    _assemble_routes(payload, process_recipes)
    return _problem_from_payload(
        payload,
        process_assignment=process_assignment,
        process_pm_order=process_pm_order,
    )
