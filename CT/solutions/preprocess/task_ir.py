"""输入预处理：raw 接口（IToolTopo + IUpdateParams）→ 类化中间表示 PreprocessedTask。

设计动机见 plan：原 task_payload 把冗长的接口结构（RouteSteps/Visits 链表、散落的
ProcessRecipes、AfterOutPM 条件树）一路带进 build_net 二次解析。本模块把「接口→native
归一化 + 一次性派生」收口到一处，产出强类型、可 JSON 序列化的 IR；build_net 直接消费 IR。

落盘：save_preprocessed → results/preprocessed/<name>.json（人类可读，便于排查）。
warm-start 纳入 IR 但为运行态快照（随每次 update 变），与静态拓扑/路由/作业分属两类。
"""

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from CT.config.cluster_tool.task_loader import (
    task_cjob_assignments,
    task_pjob_assignments,
    task_route_entry_by_name,
)
from CT.config.paths import preprocessed_path
from copy import deepcopy
from CT.tool.log_setup import get_logger
from CT.solutions.construct.route_sequence import parse_route_steps
from CT.solutions.takt.pjob_takt import compute_takt_by_pjob, loadlock_bottleneck_floor
from CT.solutions.preprocess.dual_chamber import apply_dual_view
from CT.solutions.preprocess.clean_parse import (
    synthesize_dummy_routes,
    resolve_route_clean,
    _wac_from_afterout,
)
from CT.solutions.preprocess.state import State
from .internal_data import *

log = get_logger(__name__)


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
      - 顶层 Routes：从 Materials 内联 Route 按 Name 去重补齐（不覆盖已注册的合成 dummy route——
        dummy 片复用时内联 Route 只剩最后一次使用的版本）；
      - 清洗解析：pre/post/dummy_clean_by_pm per-PM 表（见 clean_parse.resolve_route_clean）。
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
# 派生：raw 接口 / native payload → IR
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
            initial_chamber=str(cfg.get("InitialChamber") or ""),
            pick_time={str(k): float(v) for k, v in dict(cfg.get("PickTime") or {}).items()},
            place_time={str(k): float(v) for k, v in dict(cfg.get("PlaceTime") or {}).items()},
            swap_time=float(cfg.get("SwapTime", 0.0) or 0.0),
            prep_trans_time=list(cfg.get("PrepTransTime") or []),
            arms=[str(a) for a in (cfg.get("ArmInfo") or {})] or ["ArmA"],
        )
    return out


def _build_chambers(stations_raw: Mapping[str, Any]) -> Dict[str, Chamber]:
    """从 task_payload["Stations"] 提取站点静态配置 + 门动作时长，折进 Chamber 类。

    含 loadport：loadport 作为门动作时长载体（非源/汇 LP 在机器手 scope 内充当中间站，
    其门动作要叠进 processing_time）。但 loadport 不进腔室容量逻辑（见 build_marks._chamber_meta
    与 physical_capacity_by_name 的 loadport/dummyport 过滤），口径与旧 station_timings 一致。
    LL 建模容量钳为 1，保留真实物理槽位。
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
            name=str(name), type=cls, capacity=cap, physical_capacity=cap,
            pick_prepare_time=_td("PickPrepareTime"),
            place_prepare_time=_td("PlacePrepareTime"),
            pick_complete_time=_td("PickCompleteTime"),
            place_complete_time=_td("PlaceCompleteTime"),
            post_complete_time=_td("PostCompleteTime"),
        )
        if entry.get("PumpTime") is not None:
            chamber.pump_time = float(entry["PumpTime"])
        if entry.get("VentTime") is not None:
            chamber.vent_time = float(entry["VentTime"])
        if cls.lower() == "loadlock":
            # 建模容量钳为 1（保持单一压力态/抽充气计时正确）；保留真实物理槽位供 swap 判定。
            chamber.physical_capacity = cap
            chamber.capacity = 1
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


def _clean_block(entry: Mapping[str, Any]) -> Clean:
    """route entry 的 per-PM 清洁表 → 类化 Clean（按 (duration,recipe,task) 聚合 PM）。"""
    def _specs(table: Mapping[str, Any]) -> List[CleanSpec]:
        grouped: Dict[Tuple[float, str, str], List[str]] = {}
        for pm, spec in (table or {}).items():
            key = (float(spec.get("duration") or 0), str(spec.get("recipe") or ""), str(spec.get("task") or ""))
            grouped.setdefault(key, []).append(str(pm))
        return [CleanSpec(visits=pms, time=k[0], recipe=k[1], task=k[2]) for k, pms in grouped.items()]

    dummy_tbl = entry.get("dummy_clean_by_pm") or {}
    dummy: Optional[DummyClean] = None
    if dummy_tbl:
        pms = [str(pm) for pm in dummy_tbl]
        first = next(iter(dummy_tbl.values()))
        dummy = DummyClean(
            visits=pms,
            time=float(first.get("duration") or 0),
            recipe=str(first.get("recipe") or ""),
            task=str(first.get("task") or ""),
            wac_time=float(first.get("empty_duration") or 0),
        )
    return Clean(
        pre_clean=_specs(entry.get("pre_clean_by_pm") or {}),
        post_clean=_specs(entry.get("post_clean_by_pm") or {}),
        dummy_clean=dummy,
    )


def _build_route(
    name: str, entry: Mapping[str, Any], tm_scopes: Mapping[str, frozenset],
    stations_cfg: Mapping[str, Any],
) -> Route:
    stations, transports, qtimes = parse_route_steps(
        route_name=str(name), route_steps=entry.get("RouteSteps") or [],
        tm_scopes=tm_scopes, stations_cfg=stations_cfg,
    )
    # RouteStep 上的 cleaning_recipe/task（normalize 注入）按 candidate 收集，附到对应 StageStep
    recipe_task_by_pm: Dict[str, Tuple[str, str]] = {}
    for st in (entry.get("RouteSteps") or []):
        recipe = str(st.get("cleaning_recipe") or "")
        if not recipe:
            continue
        for v in (st.get("Visits") or []):
            pm = str(v.get("StationName") or "")
            if pm:
                recipe_task_by_pm.setdefault(pm, (recipe, str(st.get("cleaning_task") or "")))

    steps: List[RouteStep] = []
    for i, station in enumerate(stations):
        resid = station.get("residency") or {}
        rvals = [int(x) for x in resid.values()]
        rv = (max(rvals) if rvals else -1) if station["stage_type"] == "process" else -1
        cands = [str(c) for c in station["candidates"]]
        recipe, task = "", ""
        for c in cands:
            if c in recipe_task_by_pm:
                recipe, task = recipe_task_by_pm[c]
                break
        steps.append(StageStep(
            visits=cands,
            stage_type=str(station["stage_type"]),
            time=float(station.get("process_time") or 0),
            residual_time_limit=rv,
            clean_time=int(station.get("cleaning_duration") or 0),
            clean_trigger=int(station.get("cleaning_trigger_wafers") or 0),
            clean_recipe=recipe, clean_task=task,
        ))
        if i < len(transports):
            steps.append(TransportStep(visits=[str(transports[i])], qtime_time_limit=int(qtimes[i])))

    return Route(
        name=str(name), steps=steps, clean=_clean_block(entry),
        group=str(entry.get("group") or ""),
        is_dummy=bool(entry.get("is_dummy")),
    )


def _resolve_routes_and_pjobs(payload: Mapping[str, Any]):
    cjob_assignments = task_cjob_assignments(payload)
    if not cjob_assignments:
        raise ValueError("task payload has no usable ControlJobs")
    pjob_assignments = task_pjob_assignments(payload)
    if not pjob_assignments:
        raise ValueError("task payload has no usable ProcessJobs")
    used: List[str] = []
    for pj in pjob_assignments:
        if pj.route_name not in used:
            used.append(pj.route_name)
    route_entries: Dict[str, Dict[str, Any]] = {}
    for name in used:
        n_mat = sum(len(pj.material_ids) for pj in pjob_assignments if pj.route_name == name)
        route_entries[name] = task_route_entry_by_name(payload, name, n_materials=n_mat)
    route_idx_by_name = {name: idx + 1 for idx, name in enumerate(used)}
    return cjob_assignments, pjob_assignments, route_entries, route_idx_by_name, used


def _ir_from_payload(payload: Mapping[str, Any]) -> PreprocessedTask:
    """已组装/归一化的 task_payload → 类化 IR。对 native payload 幂等。"""
    cjob_assignments, pjob_assignments, route_entries, route_idx_by_name, route_order = \
        _resolve_routes_and_pjobs(payload)

    robots = _build_robots(payload.get("Robots") or {})
    chambers = _build_chambers(payload.get("Stations") or {})
    tm_scopes = {n: frozenset(r.scope) for n, r in robots.items()}
    stations_cfg = payload.get("Stations") or {}

    routes = {
        name: _build_route(name, route_entries[name], tm_scopes, stations_cfg)
        for name in route_order
    }
    is_dummy_by_route = {name: routes[name].is_dummy for name in route_order}

    # 节拍：按 route 现算（floor = LL 瓶颈）。键为 global_pjob_idx。
    is_dual = bool(payload.get("_DualView"))
    takt_floor = loadlock_bottleneck_floor(payload.get("Stations"), payload.get("Robots"))
    takt_by_pjob = compute_takt_by_pjob(
        pjob_assignments,
        {name: (route_entries[name].get("RouteSteps") or []) for name in route_order},
        floor=takt_floor,
        capacity_by_station={
            str(n): int((st or {}).get("Capacity", 1) or 1)
            for n, st in (payload.get("Stations") or {}).items()
        },
        wafers_per_release=2 if is_dual else 1,
    )

    pjobs = [
        PJob(
            global_pjob_idx=int(pj.global_pjob_idx), cjob_idx=int(pj.cjob_idx),
            name=str(pj.name), priority=int(pj.priority),
            route_name=str(pj.route_name), load_port=str(pj.load_port),
            material_ids=list(pj.material_ids), material_count=int(pj.material_count),
            is_dummy=bool(is_dummy_by_route.get(pj.route_name, False)),
        )
        for pj in pjob_assignments
    ]
    cjobs = [
        CJob(
            cjob_idx=int(cj.cjob_idx), task_id=str(cj.task_id), job_type=int(cj.job_type),
            priority=int(cj.priority), pjob_names=list(cj.pjob_names),
            material_count=int(cj.material_count),
        )
        for cj in cjob_assignments
    ]

    return PreprocessedTask(
        scenario=int(payload.get("Scenario", payload.get("scenario", 0)) or 0),
        robots=robots,
        chambers=chambers,
        routes=routes,
        route_order=list(route_order),
        route_idx_by_name=dict(route_idx_by_name),
        pjobs=pjobs,
        cjobs=cjobs,
        takt_by_pjob={int(k): list(v) for k, v in takt_by_pjob.items()},
        materials=[
            {
                "ID": int(m["ID"]),
                "TaskID": str(m.get("TaskID", "") or ""),
                "PJobName": str(m.get("PJobName", "") or ""),
            }
            for m in (payload.get("Materials") or []) if "ID" in m
        ],
        dual_view=payload.get("_DualView"),
        warm_start=payload.get("_WarmStart"),
    )


def init_topo(init_data: Mapping[str, Any]) -> Tuple[Dict[str, Robot], Dict[str, Chamber]]:
    """仅拓扑层预处理：init_data(Robots/Stations) → (robots, chambers)。

    跑 dual-view（双腔合并 LL / 改写机器手 scope），**不碰** route/pjob/cleaning。
    供 init_net 在 scheduler.init 阶段直接由 init_data 取静态拓扑，与 preprocess()
    中 Robots/Stations 经历的拓扑层变换一致。
    """
    payload: Dict[str, Any] = {
        "Robots": deepcopy(dict(init_data.get("Robots") or {})),
        "Stations": deepcopy(dict(init_data.get("Stations") or {})),
    }
    apply_dual_view(payload)
    return _build_robots(payload["Robots"]), _build_chambers(payload["Stations"])


def preprocess(tool_topo: Mapping[str, Any], update_params: Mapping[str, Any]) -> Tuple[PreprocessedTask, Dict[str, Any]]:
    """由 tool_topo + update_params 组装内部 task_payload，返回 (IR, DummyReturnInfo)。

        标准重算数据（文档接口格式）经 _assemble_routes 就地补齐成 native 形状；
        ProcessRecipes 属 _RUNTIME_ONLY_KEYS（会被剥离），故在剥离前取出再传给补齐。

        PreDummyClean：合成 dummy 晶圆的 route/PJob/CJob（须在 dual-view / 补齐之前，
        合成的 route/PJob 参与 Routes 收集与节拍计算），并返回 DummyReturnInfo。
        """
    process_recipes = update_params.get("ProcessRecipes")
    payload: Dict[str, Any] = {k: deepcopy(v) for k, v in update_params.items()}
    payload["Robots"] = dict(tool_topo.get("Robots") or {})
    payload["Stations"] = dict(tool_topo.get("Stations") or {})
    dummy_return_info = synthesize_dummy_routes(payload)
    # 双腔设备：2 片成对建模（须在补齐之前，节拍/清洁解析基于成对视图）
    apply_dual_view(payload)
    _assemble_routes(payload, process_recipes)
    # 热启动内部规格内联进 payload（在 _RUNTIME_ONLY_KEYS 剥离之外单独注入）；
    # 冷启动（State.from_update_params 返回 None）则不写入，net 走纯冷启动 reset。
    _ws = State.from_update_params(update_params)
    if _ws is not None:
        payload["_WarmStart"] = _ws.to_spec()
    return _ir_from_payload(payload), dummy_return_info


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def to_dict(ir: PreprocessedTask) -> Dict[str, Any]:
    return asdict(ir)


def save_preprocessed(ir: PreprocessedTask, *, name: str) -> Path:
    out = preprocessed_path(f"{name}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(asdict(ir), f, ensure_ascii=False, indent=1)
    log.info("save_preprocessed: %s", out)
    return out


def _route_from_dict(d: Mapping[str, Any]) -> Route:
    steps: List[RouteStep] = []
    for i, s in enumerate(d.get("steps") or []):
        if i % 2 == 1:  # 奇数位恒为 transport
            steps.append(TransportStep(visits=list(s["visits"]),
                                       qtime_time_limit=int(s.get("qtime_time_limit", -1))))
        else:
            pp = s.get("preprepare_time")
            steps.append(StageStep(
                visits=list(s["visits"]), stage_type=str(s["stage_type"]),
                time=float(s.get("time", 0.0)),
                residual_time_limit=int(s.get("residual_time_limit", -1)),
                clean_time=int(s.get("clean_time", 0)),
                clean_trigger=int(s.get("clean_trigger", 0)),
                clean_recipe=str(s.get("clean_recipe", "")),
                clean_task=str(s.get("clean_task", "")),
                preprepare_time=PrePrepare(**pp) if pp else None,
            ))
    clean = d.get("clean") or {}
    dummy = clean.get("dummy_clean")
    return Route(
        name=str(d["name"]), steps=steps,
        clean=Clean(
            pre_clean=[CleanSpec(**c) for c in (clean.get("pre_clean") or [])],
            post_clean=[CleanSpec(**c) for c in (clean.get("post_clean") or [])],
            dummy_clean=DummyClean(**dummy) if dummy else None,
        ),
        group=str(d.get("group", "")),
        is_dummy=bool(d.get("is_dummy", False)),
    )


def from_dict(d: Mapping[str, Any]) -> PreprocessedTask:
    return PreprocessedTask(
        scenario=int(d.get("scenario", 0)),
        robots={k: Robot(**v) for k, v in (d.get("robots") or {}).items()},
        chambers={k: Chamber(**v) for k, v in (d.get("chambers") or {}).items()},
        routes={k: _route_from_dict(v) for k, v in (d.get("routes") or {}).items()},
        route_order=list(d.get("route_order") or []),
        route_idx_by_name={str(k): int(v) for k, v in (d.get("route_idx_by_name") or {}).items()},
        pjobs=[PJob(**p) for p in (d.get("pjobs") or [])],
        cjobs=[CJob(**c) for c in (d.get("cjobs") or [])],
        takt_by_pjob={int(k): list(v) for k, v in (d.get("takt_by_pjob") or {}).items()},
        materials=[dict(m) for m in (d.get("materials") or [])],
        dual_view=d.get("dual_view"),
        warm_start=d.get("warm_start"),
    )


def load_preprocessed(path: Path) -> PreprocessedTask:
    with open(path, encoding="utf-8") as f:
        return from_dict(json.load(f))
