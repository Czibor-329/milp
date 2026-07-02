"""清洁条件解析 + DummyClean 合成。

清洁条件解析（接口 CleanCondition 条件树）：
  挂载点：Wac=Visit.AfterOutPM(CounterCondition)，PreClean/DummyClean=Route.PrePJob,
          PostClean=Route.PostPJob。DummyClean 与不带片清洁的区别仅在 MaterialCount>0。
  resolve_route_clean 把 PrePJob/PostPJob 解析成 route 顶层 per-PM 表
  （pre/post/dummy_clean_by_pm）；Wac 由 parse 的 RouteStep 时长注入消费 _wac_from_afterout。

DummyClean 合成：产品 route 的 PrePJob[PM] 中 MaterialCount>0 的任务表示该 PM 加工前需要
调度 dummy 晶圆（DummyPort 库存）进腔执行清洁配方。dummy route 直接复用对应产品 PJob 的
OriginRoute（头/尾步骤落到 DummyPort、目标 PM 步骤换清洁 recipe），合成 dummy PJob/CJob。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from src.log_setup import get_logger

log = get_logger(__name__)


# --------------------------------------------------------------------------- #
# 清洁条件解析（接口 CleanCondition 条件树）
# --------------------------------------------------------------------------- #
def _flatten_clean_conditions(
    conditions: Optional[Sequence[Mapping[str, Any]]],
) -> List[Dict[str, Any]]:
    """IList<CleanCondition> 拍平为任务列表。threshold 取同 alias 的 ThresholdValueList[0]。"""
    out: List[Dict[str, Any]] = []
    for cond in conditions or []:
        if not isinstance(cond, Mapping):
            continue
        order_by_alias = {
            str(oc.get("Alias") or ""): oc
            for oc in (cond.get("ExecuteOrder") or []) if isinstance(oc, Mapping)
        }
        for alias, tasks in (cond.get("CheckConditions") or {}).items():
            oc = order_by_alias.get(str(alias), {})
            thr_list = oc.get("ThresholdValueList") or []
            threshold = float(thr_list[0]) if thr_list else None
            for t in tasks or []:
                if not isinstance(t, Mapping):
                    continue
                out.append({
                    "task": str(t.get("TaskName") or ""),
                    "recipe": str(t.get("CleanRecipe") or ""),
                    "material_count": int(t.get("MaterialCount") or 0),
                    "empty_recipe": str(t.get("EmptyCleanRecipeAfterMaterial") or ""),
                    "state_variable": str(oc.get("StateVariableName") or ""),
                    "threshold": threshold,
                })
    return out


def _wac_from_afterout(
    conditions: Optional[Sequence[Mapping[str, Any]]],
) -> Optional[Tuple[str, int, str]]:
    """Wac：首个按计数变量触发的任务 → (recipe, 触发片数, task)。IdleTime 触发不算计数清洁。"""
    for spec in _flatten_clean_conditions(conditions):
        if not spec["recipe"] or spec["threshold"] is None:
            continue
        if spec["state_variable"] in ("", "IdleTime"):
            continue
        if spec["threshold"] >= 1:
            return spec["recipe"], int(spec["threshold"]), spec["task"]
    return None


def _pjob_clean_table(
    raw: Optional[Mapping[str, Any]], *, with_material: bool,
) -> Dict[str, Dict[str, Any]]:
    """Route.PrePJob / PostPJob（{PM: [CleanCondition]}）→ {PM: 首个匹配任务}。

    with_material=False 取不带片任务（PreClean/PostClean），True 取带片任务（DummyClean）。
    """
    out: Dict[str, Dict[str, Any]] = {}
    for pm, conditions in (raw or {}).items():
        for spec in _flatten_clean_conditions(conditions):
            if not spec["recipe"]:
                continue
            if with_material != (spec["material_count"] > 0):
                continue
            out[str(pm)] = spec
            break
    return out


def parse_predummy_specs(route: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """PJob 前带片清洁（DummyClean，MaterialCount>0）：{PM: spec}，spec.material_count 为所需 dummy 片数。"""
    return _pjob_clean_table(route.get("PrePJob"), with_material=True)


def resolve_route_clean(
    routes: Sequence[Mapping[str, Any]],
    recipe_idx: Mapping[Tuple[str, str], float],
) -> None:
    """就地把各 route 的 PrePJob/PostPJob 清洁解析成顶层 per-PM 表，时长按 (CleanRecipe, PM) 查 recipe_idx。

      - pre_clean_by_pm / post_clean_by_pm：不带片清洁（PreClean/PostClean）；
      - dummy_clean_by_pm：带片清洁（DummyClean）极简记录——挂载腔室(PM)、清洁时长(duration)、
        是否紧接 dummy-wac 及其时长(empty_duration)。
    """
    for r in routes:
        if not isinstance(r, dict):
            continue
        for key, raw_key in (("pre_clean_by_pm", "PrePJob"),
                             ("post_clean_by_pm", "PostPJob")):
            if key in r:
                continue
            table: Dict[str, Any] = {}
            for pm, spec in _pjob_clean_table(r.get(raw_key), with_material=False).items():
                dur = recipe_idx.get((spec["recipe"], pm))
                if dur is None:
                    continue
                table[pm] = {
                    "duration": int(round(dur)),
                    "recipe": spec["recipe"],
                    "task": spec["task"],
                }
            if table:
                r[key] = table
        if "dummy_clean_by_pm" not in r:
            dummy_table: Dict[str, Any] = {}
            for pm, spec in _pjob_clean_table(r.get("PrePJob"), with_material=True).items():
                entry: Dict[str, Any] = {
                    "recipe": str(spec.get("recipe") or ""),
                    "task": str(spec.get("task") or ""),
                }
                dur = recipe_idx.get((spec["recipe"], pm))
                if dur is not None:
                    entry["duration"] = int(round(dur))
                if spec.get("empty_recipe"):
                    edur = recipe_idx.get((spec["empty_recipe"], pm))
                    if edur is not None:
                        entry["empty_duration"] = int(round(edur))
                        entry["empty_recipe"] = str(spec["empty_recipe"])
                dummy_table[pm] = entry
            if dummy_table:
                r["dummy_clean_by_pm"] = dummy_table


# --------------------------------------------------------------------------- #
# DummyClean 合成：dummy 晶圆的 Route / PJob / CJob
# --------------------------------------------------------------------------- #
def _find_dummyport(stations: Mapping[str, Any]) -> Optional[str]:
    for name, st in (stations or {}).items():
        if str((st or {}).get("Type") or "").lower() == "dummyport":
            return str(name)
    return None


def _is_dummy_material(mat: Mapping[str, Any], dummyport: str) -> bool:
    if str(mat.get("SrcPortName") or "") == dummyport:
        return True
    return str(mat.get("CurrentModuleName") or "") == dummyport


def _visit(station: str, *, recipe: str = "") -> Dict[str, Any]:
    return {
        "StationName": str(station),
        "SlotID": [1],
        "ProcessRecipe": str(recipe),
        "MoveTimeOffset": {},
        "AfterOutPM": [],
        "BeforeInPM": [],
        "QTimeLimit": -1,
        "ResidencyConstraint": -1,
    }


def _ordered_chain(steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按 PostStepID 把线性 route 步骤排成链（头 = 无前驱）。"""
    by_id = {int(st.get("StepID", i)): st for i, st in enumerate(steps)}
    referenced = {int(nxt) for st in steps for nxt in (st.get("PostStepID") or [])}
    head = next(
        (st for st in steps if int(st.get("StepID", -1)) not in referenced), steps[0]
    )
    chain: List[Dict[str, Any]] = []
    cur: Optional[Dict[str, Any]] = head
    seen: set = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        chain.append(cur)
        post = cur.get("PostStepID") or []
        cur = by_id.get(int(post[0])) if post else None
    return chain


def _build_dummy_route(
    name: str,
    product_route: Mapping[str, Any],
    *,
    dummyport: str,
    pm: str,
    recipe: str,
    robots: frozenset,
) -> Dict[str, Any]:
    """复用产品 route 合成 dummy 清洁 route。

    dummy 路径只需 DummyPort → LoadLock → PM → LoadLock → DummyPort：
    头/尾步骤收敛到 DummyPort 单候选；目标 PM 步骤收敛到该 PM 单候选并把工艺
    recipe 换成清洁 recipe；其余加工腔（heater / Cooler 等非目标 PM）连同其出腔
    机器手搬运一并删除，链路重连（进腔机器手直接搬到下一站）。
    清空 Pre/Post 清洁挂载点：dummy 自身不再触发清洁。
    """
    route = deepcopy(product_route)
    route["Name"] = str(name)
    route["PrePJob"] = {}
    route["PostPJob"] = {}
    route["PostCJob"] = {}
    # 内部标记：构网时 token 置 is_dummy（输出 RouteRecipe 前会剔除）
    route["is_dummy"] = True

    steps: List[Dict[str, Any]] = route.get("RouteSteps") or []
    if not steps:
        raise ValueError(f"产品 route {product_route.get('Name')!r} 无 RouteSteps")
    chain = _ordered_chain(steps)
    chain[0]["Visits"] = [_visit(dummyport)]
    chain[-1]["Visits"] = [_visit(dummyport)]

    def _is_robot(st: Dict[str, Any]) -> bool:
        return any(str(v.get("StationName")) in robots for v in (st.get("Visits") or []))

    pinned = False
    drop: set = set()
    for i, st in enumerate(chain):
        if st is chain[0] or st is chain[-1]:
            continue
        visits = st.get("Visits") or []
        if any(str(v.get("StationName")) == pm for v in visits):
            kept = deepcopy(next(v for v in visits if str(v.get("StationName")) == pm))
            kept["ProcessRecipe"] = str(recipe)
            st["Visits"] = [kept]
            st["NeedProcess"] = True
            pinned = True
        elif st.get("NeedProcess"):
            # 非目标加工腔（heater/Cooler）：删腔 + 紧随的出腔机器手，进腔机器手直连下站
            drop.add(i)
            if i + 1 < len(chain) and _is_robot(chain[i + 1]):
                drop.add(i + 1)
    if not pinned:
        raise ValueError(f"产品 route {product_route.get('Name')!r} 无访问 {pm} 的步骤")

    kept_chain = [st for i, st in enumerate(chain) if i not in drop]
    for i, st in enumerate(kept_chain):
        st["PostStepID"] = [int(kept_chain[i + 1]["StepID"])] if i + 1 < len(kept_chain) else []
    route["RouteSteps"] = kept_chain
    return route


def synthesize_dummy_routes(payload: Dict[str, Any]) -> Dict[str, Any]:
    """就地合成 dummy route/PJob/CJob，返回 DummyReturnInfo（无 PreDummyClean 时为 {}）。

    须在 normalize 之前调用（合成的 route/PJob 参与 Routes 收集、工时注入与节拍计算）。
    """
    stations = payload.get("Stations") or {}
    dummyport = _find_dummyport(stations)
    if not dummyport:
        return {}
    robots = frozenset(str(n) for n in (payload.get("Robots") or {}))

    # 1) 逐产品 PJob 解析 PreDummyClean：dummy 清洁绑定其声明 PJob 自身
    #    (1c2p：P1 的 dummy 先于 P1 晶圆，P2 的 dummy 在 P1 全部完工后、P2 晶圆前)。
    product_specs: List[Tuple[Mapping[str, Any], Dict[str, Dict[str, Any]]]] = []
    for pj in payload.get("ProcessJobs") or []:
        if not isinstance(pj, Mapping):
            continue
        specs = {
            pm: spec
            for pm, spec in parse_predummy_specs(pj.get("OriginRoute") or {}).items()
            if int(spec.get("material_count") or 0) > 0
        }
        product_specs.append((pj, specs))
    if not any(specs for _, specs in product_specs):
        return {}

    # 2) 优先级链：按权威顺序 (原 Priority, 声明序) 排产品，第 k 个产品改写为
    #    2k+1，其 dummy PJob 取 2k —— 借助现有跨优先级串行门控实现
    #    d(P1) → P1 → d(P2) → P2 的发片顺序。
    rank_order = sorted(
        range(len(product_specs)),
        key=lambda i: (int(product_specs[i][0].get("Priority", 1) or 1), i),
    )
    dummy_priority_by_product: Dict[int, int] = {}
    for rank, i in enumerate(rank_order):
        pj = product_specs[i][0]
        pj["Priority"] = 2 * rank + 1
        dummy_priority_by_product[i] = 2 * rank

    # 3) 可用 dummy 晶圆（按 ID 升序）。物理 dummy 片跨产品复用：
    #    P2 的 dummy 段被优先级门控压在 P1 全部完工之后，此时 dummy 已回 DummyPort。
    dummy_mats = sorted(
        (m for m in (payload.get("Materials") or []) if _is_dummy_material(m, dummyport)),
        key=lambda m: int(m.get("ID", 0)),
    )

    # 合成 route 必须显式注册到顶层 Routes：dummy 片复用时 Material 内联 Route
    # 会被后一次使用覆盖，normalize 从内联收集不到前面产品的 dummy route。
    routes_top = payload.setdefault("Routes", {})
    pjob_names: List[str] = []
    dummy_return_info: Dict[str, List[Dict[str, Any]]] = {}
    use_count_by_mat: Dict[int, int] = {}
    task_id = ""
    total_assigned = 0

    # 4) 逐产品 × 逐 PM 合成 route + PJob；产品内 dummy 片按 PM 轮转分配，
    #    跨产品复用同一批 dummy 片（cursor 每个产品归零）。
    for rank, i in enumerate(rank_order):
        product, specs = product_specs[i]
        if not specs:
            continue
        pm_order = list(specs.keys())
        assignment: Dict[str, List[Mapping[str, Any]]] = {pm: [] for pm in pm_order}
        cursor = 0
        pending = {pm: int(specs[pm]["material_count"]) for pm in pm_order}
        while any(v > 0 for v in pending.values()):
            progressed = False
            for pm in pm_order:
                if pending[pm] <= 0:
                    continue
                if cursor >= len(dummy_mats):
                    raise ValueError(
                        f"DummyPort dummy 晶圆不足：{product.get('JobName')} 还需 "
                        f"{sum(pending.values())} 片"
                    )
                mat = dummy_mats[cursor]
                accessible = [str(x) for x in (mat.get("AccessiblePM") or [])]
                if accessible and pm not in accessible:
                    raise ValueError(f"dummy 晶圆 {mat.get('ID')} 不可进 {pm}")
                assignment[pm].append(mat)
                pending[pm] -= 1
                cursor += 1
                progressed = True
            if not progressed:
                break
        total_assigned += cursor

        product_route = product.get("OriginRoute") or {}
        task_id = str(product.get("TaskID") or task_id)
        for pm in pm_order:
            spec = specs[pm]
            route_name = f"{product_route.get('Name') or 'route'}_dummy_{pm}"
            job_name = f"dummy_{pm}"
            if rank > 0:
                route_name = f"{route_name}_{rank + 1}"
                job_name = f"{job_name}_{rank + 1}"
            route = _build_dummy_route(
                route_name, product_route,
                dummyport=dummyport, pm=pm, recipe=str(spec["recipe"]),
                robots=robots,
            )
            mats = assignment[pm]
            mat_ids = [int(m["ID"]) for m in mats]
            payload.setdefault("ProcessJobs", []).append({
                "JobName": job_name,
                "TaskID": task_id,
                "Priority": int(dummy_priority_by_product[i]),
                "State": 0,
                "OriginRoute": route,
                "MatList": mat_ids,
            })
            pjob_names.append(job_name)
            if routes_top is not None:
                routes_top[route_name] = route
            for m in mats:
                m["PJobName"] = job_name
                m["Route"] = deepcopy(route)
                m["NeedSchedule"] = True
                # 复用片的逐趟 PJob 名（trace 按趟切换 PJobName / 归零 StepID）
                m.setdefault("_UsePJobNames", []).append(job_name)
                route_recipe = deepcopy(route)
                route_recipe.pop("is_dummy", None)
                mid = int(m["ID"])
                use_count_by_mat[mid] = use_count_by_mat.get(mid, 0) + 1
                dummy_return_info.setdefault(str(mid), []).append({
                    "TaskID": task_id,
                    "PJobName": str(product.get("JobName") or ""),
                    "RouteRecipe": route_recipe,
                    "CleanTaskName": "",
                    "AlgorithmCount": use_count_by_mat[mid],
                })

    payload.setdefault("ControlJobs", []).append({
        "TaskID": task_id,
        "JobType": 0,
        "Priority": -1,
        "PJobNameList": pjob_names,
        "MaterialCount": total_assigned,
    })
    log.info(
        "synthesize_dummy_routes: jobs=%s assigned=%d",
        pjob_names, total_assigned,
    )
    return dummy_return_info
