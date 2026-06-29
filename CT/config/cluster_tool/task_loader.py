"""加载 config/task/{task_id}.json，并提供从 payload 直接抽字段的小工具。"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Dict, List, Mapping, Tuple


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


def task_pjob(payload: Mapping[str, Any]) -> Dict[str, Any]:
    pjobs = list(payload.get("ProcessJobs") or [])
    if not pjobs:
        raise ValueError("task payload has no ProcessJobs")
    return dict(pjobs[0])


def task_id_of(payload: Mapping[str, Any]) -> str:
    pjob = task_pjob(payload)
    cjobs = list(payload.get("ControlJobs") or [])
    return str(pjob.get("TaskID", "")) or str((cjobs[0] if cjobs else {}).get("TaskID", ""))


def task_materials(payload: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """返回首个 PJob 关联的 Materials（兼容旧调用方）。"""
    pjob_name = str(task_pjob(payload).get("JobName", ""))
    mats = [
        m for m in (payload.get("Materials") or [])
        if str(m.get("PJobName", "")) == pjob_name
    ]
    if not mats:
        raise ValueError(f"PJob {pjob_name!r} has no Materials")
    first_route = mats[0].get("Route")
    if not isinstance(first_route, dict) or not first_route:
        raise ValueError(f"Material[0] of PJob {pjob_name!r} has no inline 'Route'")
    route_name = str(first_route.get("Name") or "")
    if not route_name:
        raise ValueError("Route.Name missing on Material[0]")
    for mat in mats:
        r = mat.get("Route")
        if not isinstance(r, dict) or r.get("Name") != route_name:
            raise ValueError(
                f"all Materials in PJob {pjob_name!r} must share Route.Name; "
                f"got {r.get('Name') if isinstance(r, dict) else None!r} != {route_name!r}"
            )
    return sorted(
        (deepcopy(m) for m in mats),
        key=lambda m: (int(m.get("Priority", 1)), int(m.get("ID", 0))),
    )


def task_route_name(payload: Mapping[str, Any]) -> str:
    mats = payload.get("Materials") or []
    if not mats:
        raise ValueError("task payload has no Materials")
    return str((mats[0].get("Route") or {}).get("Name") or "")


def task_n_wafer(payload: Mapping[str, Any]) -> int:
    return len(task_materials(payload))


def task_route_entry(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """从 Materials[0]["Route"] 深拷出 route_entry 并注入默认值（已不再含 takt_cycle/max_wafer_in_system）。"""
    mats = task_materials(payload)
    entry: Dict[str, Any] = deepcopy(mats[0]["Route"])
    _ensure_route_steps(entry)
    entry.setdefault("ratio", [1, 0])
    return entry


# ---------------------------------------------------------------------------
# 多 Route / 多 CJob / 多 PJob 支持
# ---------------------------------------------------------------------------

def task_control_jobs(payload: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """返回 ControlJobs 拷贝，按 payload 中的原始顺序。"""
    return [deepcopy(cj) for cj in (payload.get("ControlJobs") or [])]


def task_process_jobs(payload: Mapping[str, Any]) -> List[Dict[str, Any]]:
    return [deepcopy(pj) for pj in (payload.get("ProcessJobs") or [])]


_LEGACY_STATION_KEYS = ("process_time", "cleaning_duration", "cleaning_trigger_wafers")


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


def _legacy_sequence_to_route_steps(seq: List[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """旧 sequence (station/transport 交替) → 标准 RouteSteps。

    旧 station 上的 process_time / cleaning_* 透传到 RouteStep 顶层（非标字段），
    由下游 route_sequence.parse_route_steps 再传回 station dict 给 preprocess 用。
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


def _materials_index_by_id(payload: Mapping[str, Any]) -> Dict[int, Dict[str, Any]]:
    return {int(m["ID"]): m for m in (payload.get("Materials") or []) if "ID" in m}


def _pjob_index_by_name(payload: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {str(pj.get("JobName", "")): pj for pj in (payload.get("ProcessJobs") or [])}


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


def _resolve_pjob_load_port(routes: Mapping[str, Mapping[str, Any]], route_name: str) -> str:
    """从 Route.RouteSteps[0].Visits[0].StationName（source 站）取 LP 名字。

    routes 入参假定已经过 task_routes()/_ensure_route_steps 归一化，含 RouteSteps。
    """
    route = routes.get(route_name) or {}
    steps = route.get("RouteSteps") or []
    if not steps:
        # 兜底：直接转一次旧 sequence
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

    严格校验：
      - 每个 PJob 必须有 Priority/OriginRoute.Name
      - 不同 PJob 可绑定不同 Route
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
    out.sort(key=lambda c: (
        _JOBTYPE_RANK.get(int(c.job_type), 99),
        int(c.priority) if int(c.job_type) == int(CJobType.NormalLot) else 0,
        int(c.cjob_idx),
    ))
    return out


def task_pjob_assignments(payload: Mapping[str, Any]) -> List[PJobAssignment]:
    """扁平 PJob 列表（全局权威顺序）。

    按已排序的 CJob 顺序串接，每个 CJob 内 PJob 按 (priority, global_pjob_idx)
    升序。各 PJobAssignment 仍保留原 global_pjob_idx（身份键，不受排序影响）。
    """
    pjs: List[PJobAssignment] = []
    for cj in task_cjob_assignments(payload):
        pjs.extend(sorted(
            cj.pjobs, key=lambda p: (int(p.priority), int(p.global_pjob_idx)),
        ))
    return pjs


def task_route_entry_by_name(
    payload: Mapping[str, Any], route_name: str, *, n_materials: int = 0,
) -> Dict[str, Any]:
    """从 payload.Routes[name] 取 entry 并注入默认值。

    注意：max_wafer_in_system / takt_cycle 字段已迁到 task 根层，不再注入。
    """
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
