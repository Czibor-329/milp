"""CT 实时调度终端本地服务。

页面只负责编辑设备引用、设备级共享 Clean/Route 和各轮新增 Job；本服务把请求展开成
标准调度接口数据，依次运行首次排程与实时重算。设备、共享工艺库、测试集、甘特图结果和
复现日志统一保存在 realtime_scheduler 目录中。

用法：
    python realtime_scheduler/server.py
    python realtime_scheduler/server.py --port 8765 --open

兼容入口：python scripts/config_editor_server.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import threading
import time
import uuid
import webbrowser
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.paths import MODELS_DIR
from src.reschedule import RealtimeRescheduler, TIME_TOLERANCE
from src.validation import MoveStateReplay


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_SAVED_RESULTS = 8
WORKSPACE_STORE_VERSION = 2
API_SCHEMA_VERSION = "cjob-pjob-v2"
FIRST_SLOT_ID = 1
MAX_WAFERS_PER_JOB = 25
DEFAULT_TRIGGER_UPPER = 9999.0
CJOB_TYPE_VALUES = {"NormalLot": 0, "HighestLot": 2, "HigherLot": 3}
TASK_MODE_VALUES = {"Smart": 0, "Pipeline": 1, "Sequential": 2, "Concurrent": 3}
CJOB_TYPE_NAMES = {value: name for name, value in CJOB_TYPE_VALUES.items()}
TASK_MODE_NAMES = {value: name for name, value in TASK_MODE_VALUES.items()}
REALTIME_APP_DIR = ROOT / "realtime_scheduler"
FRONTEND_DIR = REALTIME_APP_DIR / "frontend"
DATA_DIR = REALTIME_APP_DIR / "data"
EXPORT_DIR = REALTIME_APP_DIR / "exports"
EDITOR_PATH = FRONTEND_DIR / "config_editor.html"
VIEWER_PATH = FRONTEND_DIR / "movelist_gantt_viewer.html"
RL_MODEL_PATH = MODELS_DIR / "bc_policy_rl.pt"
WORKSPACE_STORE_PATH = DATA_DIR / "workspaces.json"
LEGACY_WORKSPACE_STORE_PATH = ROOT / "results" / "config_editor_workspaces.json"
DEVICE_INIT_DIR = DATA_DIR / "devices"
RESULT_EXPORT_DIR = EXPORT_DIR / "results"
LOG_EXPORT_DIR = EXPORT_DIR / "logs"


_RESULTS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_RESULTS_LOCK = threading.Lock()
_REPRODUCTION_LOGS: "OrderedDict[str, List[Dict[str, Any]]]" = OrderedDict()
_REPRODUCTION_LOGS_LOCK = threading.Lock()
_WORKSPACE_STORE_LOCK = threading.RLock()
_RL_POLICY: Any = None
_RL_POLICY_LOCK = threading.Lock()


@dataclass
class BuildState:
    """跨轮生成 Job 接口对象时使用的全局编号和 LoadPort 槽位状态。"""

    next_material_id: int = 1
    next_slot_by_port: Dict[str, int] = field(default_factory=dict)
    job_names: set[str] = field(default_factory=set)


@dataclass
class ReproductionLog:
    """按 input_data 录制格式收集一次控制台运行的全部事件。"""

    entries: List[Dict[str, Any]] = field(default_factory=list)

    def add(self, describe: str, info: Any, sim_time: float = 0.0) -> None:
        """追加带墙钟时间和仿真时间的标准日志项。"""
        self.entries.append({
            "Time": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            "Describe": describe,
            "SimTime": float(sim_time),
            "Info": deepcopy(info),
        })


class LoggedPlanError(RuntimeError):
    """携带可下载复现日志的排程异常。"""

    def __init__(self, message: str, reproduction_log: Sequence[Mapping[str, Any]]) -> None:
        super().__init__(message)
        self.reproduction_log = deepcopy(list(reproduction_log))


def _alg_output_info(
    output: Optional[Mapping[str, Any]] = None,
    feedback: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """生成与 input_data 中 AlgOutput 相同的顶层结构。"""
    source = output or {}
    return {
        "MoveList": deepcopy(list(source.get("MoveList") or [])),
        "Feedback": deepcopy(list(feedback if feedback is not None else source.get("Feedback") or [])),
        "JobList": deepcopy(list(source.get("JobList") or [])),
        "DummyReturnInfo": deepcopy(dict(source.get("DummyReturnInfo") or {})),
        "MatIntoPM": deepcopy(dict(source.get("MatIntoPM") or {})),
    }


def _schedule_log_info(device: Mapping[str, Any], update: Mapping[str, Any]) -> Dict[str, Any]:
    """把设备拓扑与一轮更新合成可单独回放的 AlgSchedule 输入。"""
    info = deepcopy(dict(update))
    info.setdefault("Robots", deepcopy(dict(device.get("Robots") or {})))
    info.setdefault("Stations", deepcopy(dict(device.get("Stations") or {})))
    return info


def extract_init_data(raw: Any) -> Dict[str, Any]:
    """兼容原始 init_data、AlgInit 录制数组和一层 Info 包装。"""
    value = raw
    if isinstance(value, list):
        entry = next(
            (
                item for item in value
                if isinstance(item, Mapping) and str(item.get("Describe") or "").lower() == "alginit"
            ),
            None,
        )
        if entry is None:
            raise ValueError("设备文件数组中找不到 Describe=AlgInit")
        value = entry.get("Info")
    if isinstance(value, Mapping) and isinstance(value.get("InitData"), Mapping):
        value = value["InitData"]
    if isinstance(value, Mapping) and isinstance(value.get("Info"), Mapping):
        value = value["Info"]
    if not isinstance(value, Mapping):
        raise ValueError("设备文件不是有效 JSON 对象")
    if not isinstance(value.get("Stations"), Mapping) or not isinstance(value.get("Robots"), Mapping):
        raise ValueError("设备文件必须包含 Stations 和 Robots")
    return deepcopy(dict(value))


def _name_index(rows: Sequence[Mapping[str, Any]], label: str) -> Dict[str, Dict[str, Any]]:
    """按唯一 Name 建立通用配置索引。"""
    result: Dict[str, Dict[str, Any]] = {}
    for index, row in enumerate(rows, start=1):
        name = str(row.get("name") or "").strip()
        if not name:
            raise ValueError(f"{label} 第 {index} 项缺少名称")
        if name in result:
            raise ValueError(f"{label} 名称重复：{name}")
        result[name] = deepcopy(dict(row))
    return result


def _string_list(value: Any) -> List[str]:
    """把数组或逗号分隔文本收敛为去重字符串列表。"""
    if isinstance(value, str):
        items = value.replace("，", ",").split(",")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        items = value
    else:
        items = []
    result: List[str] = []
    for item in items:
        text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def _slot_list(value: Any) -> List[int]:
    """解析 Route Visit 使用的一基槽位列表。"""
    slots: List[int] = []
    for item in _string_list(value):
        try:
            slot = int(item)
        except ValueError:
            continue
        if slot >= FIRST_SLOT_ID and slot not in slots:
            slots.append(slot)
    return slots or [FIRST_SLOT_ID]


def _finite_number(value: Any, default: float) -> float:
    """读取有限浮点数，非法值回退默认值。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _clean_condition(clean: Mapping[str, Any]) -> Dict[str, Any]:
    """把一个通用 Clean 模板展开成标准 ICleanCondition。"""
    alias = str(clean.get("name") or "").strip()
    state_variable = str(clean.get("stateVariable") or "IdleTime").strip() or "IdleTime"
    lower = _finite_number(clean.get("lower"), 0.0)
    upper = _finite_number(clean.get("upper"), DEFAULT_TRIGGER_UPPER)
    if upper < lower:
        raise ValueError(f"Clean {alias} 的触发上限小于下限")
    task = {
        "TaskName": str(clean.get("taskName") or alias).strip() or alias,
        "CleanRecipe": str(clean.get("recipeRef") or "").strip(),
        "UpdateStateVariables": _string_list(clean.get("updateStateVariables")),
        "MaterialCount": max(0, int(_finite_number(clean.get("materialCount"), 0))),
        "EmptyCleanRecipeAfterMaterial": str(clean.get("emptyRecipeRef") or "").strip(),
    }
    return {
        "CheckConditions": {alias: [task]},
        "ExecuteOrder": [{
            "StateVariableName": state_variable,
            "ThresholdValueList": [lower, upper],
            "PreJuge": bool(clean.get("preJudge", False)),
            "Alias": alias,
        }],
    }


def _clean_conditions(names: Any, clean_by_name: Mapping[str, Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """按引用名称复制 Clean 条件，引用不存在时立即报错。"""
    conditions: List[Dict[str, Any]] = []
    for name in _string_list(names):
        clean = clean_by_name.get(name)
        if clean is None:
            raise ValueError(f"Route 引用了不存在的 Clean：{name}")
        conditions.append(_clean_condition(clean))
    return conditions


def _route_process_modules(route: Mapping[str, Any]) -> List[str]:
    """收集 Route 中所有引用 Recipe 的候选加工模块。"""
    modules: List[str] = []
    for stage in route.get("stages") or []:
        if not isinstance(stage, Mapping):
            continue
        visit_rows = stage.get("visits")
        if isinstance(visit_rows, Sequence) and not isinstance(visit_rows, (str, bytes)):
            for visit in visit_rows:
                if not isinstance(visit, Mapping) or not str(
                    visit.get("processRecipe") or visit.get("ProcessRecipe") or ""
                ).strip():
                    continue
                module = str(visit.get("stationName") or visit.get("StationName") or "").strip()
                if module and module not in modules:
                    modules.append(module)
            continue
        if str(stage.get("recipeRef") or "").strip():
            for module in _string_list(stage.get("stations")):
                if module not in modules:
                    modules.append(module)
    return modules


def _integer_list(value: Any) -> List[int]:
    """把数组或逗号文本解析为去重整数列表。"""
    result: List[int] = []
    for item in _string_list(value):
        try:
            number = int(item)
        except ValueError:
            raise ValueError(f"无法解析整数列表项：{item}") from None
        if number not in result:
            result.append(number)
    return result


def _stage_visit_rows(stage: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """读取新 IVisit 编辑结构，并兼容旧版 Step 聚合字段。"""
    raw_visits = stage.get("visits")
    if isinstance(raw_visits, Sequence) and not isinstance(raw_visits, (str, bytes)):
        return [deepcopy(dict(visit)) for visit in raw_visits if isinstance(visit, Mapping)]
    return [{
        "stationName": station,
        "slotIds": stage.get("slots"),
        "processRecipe": stage.get("recipeRef"),
        "moveTimeOffset": {},
        "qTimeLimit": stage.get("qTime"),
        "residencyConstraint": stage.get("residency"),
        "afterCleanRefs": stage.get("afterCleanRefs"),
        "beforeCleanRefs": stage.get("beforeCleanRefs"),
    } for station in _string_list(stage.get("stations"))]


def _clean_target_modules(
    clean_names: Any,
    clean_by_name: Mapping[str, Mapping[str, Any]],
    recipe_by_name: Mapping[str, Mapping[str, Any]],
    route: Mapping[str, Any],
) -> List[str]:
    """由 Clean 所引用 Recipe 的适用模块推断 Route 顶层清洁目标。"""
    targets: List[str] = []
    route_modules = _route_process_modules(route)
    for clean_name in _string_list(clean_names):
        clean = clean_by_name.get(clean_name)
        if clean is None:
            raise ValueError(f"Route 引用了不存在的 Clean：{clean_name}")
        recipe_name = str(clean.get("recipeRef") or "").strip()
        recipe = recipe_by_name.get(recipe_name)
        modules = _string_list(recipe.get("modules")) if recipe else []
        for module in modules or route_modules:
            if module not in targets:
                targets.append(module)
    return targets


def _route_clean_dict(
    clean_names: Any,
    clean_by_name: Mapping[str, Mapping[str, Any]],
    recipe_by_name: Mapping[str, Mapping[str, Any]],
    route: Mapping[str, Any],
) -> Dict[str, List[Dict[str, Any]]]:
    """把 Route 顶层 Clean 引用展开为 PM 到条件列表的标准字典。"""
    conditions = _clean_conditions(clean_names, clean_by_name)
    return {
        module: deepcopy(conditions)
        for module in _clean_target_modules(clean_names, clean_by_name, recipe_by_name, route)
    }


def build_route(
    route: Mapping[str, Any],
    recipe_by_name: Mapping[str, Mapping[str, Any]],
    clean_by_name: Mapping[str, Mapping[str, Any]],
    robot_names: Optional[set[str]] = None,
) -> Dict[str, Any]:
    """把控制台 Route 展开成解析器接受的标准 Route。"""
    route_name = str(route.get("name") or "").strip()
    stages = [stage for stage in (route.get("stages") or []) if isinstance(stage, Mapping)]
    if len(stages) < 2:
        raise ValueError(f"Route {route_name} 至少需要源和汇两个 Step")
    if len(stages) < 3 or len(stages) % 2 == 0:
        raise ValueError(f"Route {route_name} 的 Step 数必须是大于等于 3 的奇数")
    route_steps: List[Dict[str, Any]] = []
    for index, stage in enumerate(stages):
        visit_rows = _stage_visit_rows(stage)
        stations = [
            str(visit.get("stationName") or visit.get("StationName") or "").strip()
            for visit in visit_rows
        ]
        if not stations or any(not station for station in stations):
            raise ValueError(f"Route {route_name} 的 Step {index} 没有完整 Visit StationName")
        if robot_names is not None:
            contains_robot = [station in robot_names for station in stations]
            expected_robot = index % 2 == 1
            if any(contains_robot) != all(contains_robot):
                raise ValueError(f"Route {route_name} 的 Step {index} 混用了 Robot 和 Station")
            if bool(contains_robot[0]) != expected_robot:
                expected = "Robot" if expected_robot else "Station"
                raise ValueError(f"Route {route_name} 的 Step {index} 必须填写 {expected}")
        visits: List[Dict[str, Any]] = []
        for visit_index, (station, visit) in enumerate(zip(stations, visit_rows)):
            recipe_name = str(visit.get("processRecipe") or visit.get("ProcessRecipe") or "").strip()
            if index % 2 == 1 and recipe_name:
                raise ValueError(f"Route {route_name} 的 Robot Step {index} Visit 不能引用 Recipe")
            if recipe_name and recipe_name not in recipe_by_name:
                raise ValueError(f"Route {route_name} Visit 引用了不存在的 Recipe：{recipe_name}")
            move_offsets = visit.get("moveTimeOffset") or visit.get("MoveTimeOffset") or {}
            if isinstance(move_offsets, str):
                try:
                    move_offsets = json.loads(move_offsets or "{}")
                except json.JSONDecodeError:
                    raise ValueError(
                        f"Route {route_name} Step {index} Visit {visit_index} 的 MoveTimeOffset 不是有效 JSON"
                    ) from None
            if not isinstance(move_offsets, Mapping):
                raise ValueError(f"Route {route_name} Step {index} Visit {visit_index} 的 MoveTimeOffset 必须是对象")
            visits.append({
                "SlotID": _slot_list(visit.get("slotIds") or visit.get("SlotID")),
                "StationName": station,
                "ProcessRecipe": recipe_name,
                "MoveTimeOffset": deepcopy(dict(move_offsets)),
                "QTimeLimit": _finite_number(visit.get("qTimeLimit", visit.get("QTimeLimit")), -1.0),
                "ResidencyConstraint": _finite_number(
                    visit.get("residencyConstraint", visit.get("ResidencyConstraint")), -1.0,
                ),
                "AfterOutPM": _clean_conditions(
                    visit.get("afterCleanRefs") or visit.get("AfterOutPM"), clean_by_name,
                ),
                "BeforeInPM": _clean_conditions(
                    visit.get("beforeCleanRefs") or visit.get("BeforeInPM"), clean_by_name,
                ),
            })
        step_id = int(_finite_number(stage.get("stepId", stage.get("StepID")), index))
        explicit_post = stage.get("postStepIds", stage.get("PostStepID"))
        post_step_ids = (
            _integer_list(explicit_post)
            if explicit_post is not None
            else ([index + 1] if index + 1 < len(stages) else [])
        )
        need_process = bool(stage.get("needProcess", stage.get("NeedProcess", any(
            visit["ProcessRecipe"] for visit in visits
        ))))
        route_steps.append({
            "StepID": step_id,
            "PostStepID": post_step_ids,
            "NeedProcess": need_process,
            "Visits": visits,
        })
    step_ids = [step["StepID"] for step in route_steps]
    if len(step_ids) != len(set(step_ids)):
        raise ValueError(f"Route {route_name} 的 StepID 重复")
    unknown_posts = sorted({post for step in route_steps for post in step["PostStepID"] if post not in step_ids})
    if unknown_posts:
        raise ValueError(f"Route {route_name} 的 PostStepID 不存在：{unknown_posts}")
    return {
        "Name": route_name,
        "RouteSteps": route_steps,
        "BufferOption": int(_finite_number(route.get("bufferOption"), 0)),
        "BoundedStepIDs": [],
        "Group": str(route.get("group") or route_name).strip() or route_name,
        "PrePJob": _route_clean_dict(
            route.get("prePJobCleanRefs"), clean_by_name, recipe_by_name, route,
        ),
        "PostPJob": _route_clean_dict(
            route.get("postPJobCleanRefs"), clean_by_name, recipe_by_name, route,
        ),
        "PostCJob": _route_clean_dict(
            route.get("postCJobCleanRefs"), clean_by_name, recipe_by_name, route,
        ),
    }


def build_process_recipes(
    recipes: Sequence[Mapping[str, Any]],
    routes: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """把通用 Recipe 按适用模块展开成 IProcessRecipe 列表。"""
    derived_modules: Dict[str, List[str]] = {}
    for route in routes:
        for stage in route.get("stages") or []:
            if not isinstance(stage, Mapping):
                continue
            visit_rows = _stage_visit_rows(stage)
            for visit in visit_rows:
                recipe_name = str(
                    visit.get("processRecipe") or visit.get("ProcessRecipe") or ""
                ).strip()
                module = str(visit.get("stationName") or visit.get("StationName") or "").strip()
                if not recipe_name or not module:
                    continue
                derived_modules.setdefault(recipe_name, [])
                if module not in derived_modules[recipe_name]:
                    derived_modules[recipe_name].append(module)
    result: List[Dict[str, Any]] = []
    for recipe in recipes:
        name = str(recipe.get("name") or "").strip()
        modules = _string_list(recipe.get("modules")) or derived_modules.get(name, [])
        if not modules:
            continue
        weight = recipe.get("weight") or {}
        if isinstance(weight, str):
            try:
                weight = json.loads(weight or "{}")
            except json.JSONDecodeError:
                raise ValueError(f"Recipe {name} 的 Weight 不是有效 JSON") from None
        if not isinstance(weight, Mapping):
            raise ValueError(f"Recipe {name} 的 Weight 必须是对象")
        for module in modules:
            result.append({
                "Time": max(0.0, _finite_number(recipe.get("time"), 0.0)),
                "ModuleName": module,
                "Name": name,
                "ProcessType": str(recipe.get("processType") or ""),
                "Weight": deepcopy(dict(weight)),
            })
    return result


def _load_port_capacity(tool_topo: Mapping[str, Any], name: str) -> int:
    """读取所选 LoadPort 容量，接口缺失时使用 25。"""
    station = (tool_topo.get("Stations") or {}).get(name) or {}
    try:
        return max(1, int(station.get("Capacity") or MAX_WAFERS_PER_JOB))
    except (TypeError, ValueError):
        return MAX_WAFERS_PER_JOB


def _enum_value(raw: Any, values: Mapping[str, int], field_name: str, default: str) -> int:
    """把页面枚举名称或兼容的整数值转换成后端枚举。"""
    if raw is None or raw == "":
        return values[default]
    if isinstance(raw, str) and raw in values:
        return values[raw]
    try:
        numeric = int(raw)
    except (TypeError, ValueError):
        numeric = -999
    if numeric in values.values():
        return numeric
    raise ValueError(f"{field_name} 不支持：{raw}")


def _round_cjob_rows(round_config: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """读取新 CJob/PJob 层级，并把旧版扁平 Job 兼容为一 Job 一 CJob。"""
    raw_cjobs = round_config.get("cjobs")
    if isinstance(raw_cjobs, Sequence) and not isinstance(raw_cjobs, (str, bytes)):
        return [deepcopy(dict(row)) for row in raw_cjobs if isinstance(row, Mapping)]
    rows: List[Dict[str, Any]] = []
    for index, job in enumerate(round_config.get("jobs") or [], start=1):
        if not isinstance(job, Mapping):
            continue
        name = str(job.get("name") or f"Job{index}").strip()
        pjob = deepcopy(dict(job))
        pjob["jobName"] = "P1"
        rows.append({
            "taskId": name,
            "jobType": job.get("jobType", 0),
            "priority": job.get("priority", 1),
            "taskMode": job.get("taskMode", 0),
            "pjobs": [pjob],
            "_legacyName": name,
        })
    return rows


def _round_pjob_count(round_config: Mapping[str, Any]) -> int:
    """返回一轮内的 PJob 数量，兼容旧版 jobs。"""
    cjobs = round_config.get("cjobs")
    if isinstance(cjobs, Sequence) and not isinstance(cjobs, (str, bytes)):
        return sum(len(cjob.get("pjobs") or []) for cjob in cjobs if isinstance(cjob, Mapping))
    return len([job for job in (round_config.get("jobs") or []) if isinstance(job, Mapping)])


def build_round_update(
    plan: Mapping[str, Any],
    round_config: Mapping[str, Any],
    current_time: float,
    build_state: BuildState,
) -> Dict[str, Any]:
    """把一轮 ``CJob → PJob`` 展开成标准 IUpdateParams。"""
    recipes = [row for row in (plan.get("recipes") or []) if isinstance(row, Mapping)]
    cleans = [row for row in (plan.get("cleans") or []) if isinstance(row, Mapping)]
    routes = [row for row in (plan.get("routes") or []) if isinstance(row, Mapping)]
    recipe_by_name = _name_index(recipes, "Recipe")
    clean_by_name = _name_index(cleans, "Clean")
    route_by_name = _name_index(routes, "Route")
    tool_topo = plan["device"]
    robot_names = {str(name) for name in (tool_topo.get("Robots") or {})}
    built_routes = {
        name: build_route(route, recipe_by_name, clean_by_name, robot_names)
        for name, route in route_by_name.items()
    }
    cjobs = _round_cjob_rows(round_config)
    if not cjobs:
        raise ValueError("每一轮至少需要一个 CJob")

    materials: List[Dict[str, Any]] = []
    process_jobs: List[Dict[str, Any]] = []
    control_jobs: List[Dict[str, Any]] = []
    referenced_routes: Dict[str, Dict[str, Any]] = {}
    for cjob_index, cjob in enumerate(cjobs, start=1):
        task_id = str(cjob.get("taskId") or cjob.get("TaskID") or cjob_index).strip()
        pjobs = [row for row in (cjob.get("pjobs") or []) if isinstance(row, Mapping)]
        if not pjobs:
            raise ValueError(f"CJob {cjob_index} 至少需要一个 PJob")
        job_type = _enum_value(cjob.get("jobType", cjob.get("JobType")), CJOB_TYPE_VALUES, "JobType", "NormalLot")
        task_mode = _enum_value(cjob.get("taskMode", cjob.get("TaskMode")), TASK_MODE_VALUES, "TaskMode", "Smart")
        cjob_priority = max(1, int(_finite_number(cjob.get("priority"), 1))) if job_type == 0 else -1
        runtime_pjob_names: List[str] = []
        cjob_material_count = 0
        legacy_name = str(cjob.get("_legacyName") or "").strip()

        for pjob_index, pjob in enumerate(pjobs, start=1):
            display_name = str(pjob.get("jobName") or pjob.get("name") or f"P{pjob_index}").strip()
            pjob_name = f"{legacy_name}.P1" if legacy_name else f"{task_id}.C{cjob_index}.{display_name}"
            if pjob_name in build_state.job_names:
                raise ValueError(f"PJob 名称跨轮重复：{pjob_name}")
            build_state.job_names.add(pjob_name)
            runtime_pjob_names.append(pjob_name)
            origin_route = pjob.get("originRoute")
            if isinstance(origin_route, Mapping):
                origin_route = origin_route.get("name") or origin_route.get("Name")
            route_name = str(pjob.get("routeRef") or origin_route or "").strip()
            route = built_routes.get(route_name)
            if route is None:
                raise ValueError(f"PJob {display_name} 引用了不存在的 Route：{route_name}")
            load_port = str(pjob.get("loadPort") or "").strip()
            if load_port not in (tool_topo.get("Stations") or {}):
                raise ValueError(f"PJob {display_name} 的 LoadPort 不存在：{load_port}")
            wafer_count = int(_finite_number(pjob.get("waferCount"), len(pjob.get("matList") or []) or 1))
            if wafer_count < 1 or wafer_count > MAX_WAFERS_PER_JOB:
                raise ValueError(f"PJob {display_name} 晶圆数必须为 1~{MAX_WAFERS_PER_JOB}")
            priority = max(1, int(_finite_number(pjob.get("priority"), 1)))
            runtime_route_name = f"{route_name}__{legacy_name or pjob_name}"
            runtime_route = deepcopy(route)
            runtime_route["Name"] = runtime_route_name
            route_steps = runtime_route.get("RouteSteps") or []
            for step_index in (0, len(route_steps) - 1):
                if 0 <= step_index < len(route_steps):
                    for visit in route_steps[step_index].get("Visits") or []:
                        visit["StationName"] = load_port
            material_ids: List[int] = []
            next_slot = build_state.next_slot_by_port.get(load_port, 0)
            capacity = _load_port_capacity(tool_topo, load_port)
            if next_slot + wafer_count > capacity:
                raise ValueError(f"{load_port} 总片数超过容量 {capacity}")
            for _ in range(wafer_count):
                next_slot += 1
                material_id = build_state.next_material_id
                build_state.next_material_id += 1
                material_ids.append(material_id)
                materials.append({
                    "Name": str(material_id), "ID": material_id, "TaskID": task_id,
                    "LotID": f"{task_id}.C{cjob_index}",
                    "FoupID": f"{task_id}-C{cjob_index}-{display_name}",
                    "Priority": priority, "StepID": 0, "CurrentModuleName": load_port,
                    "SlotID": next_slot, "NeedSchedule": True, "PJobName": pjob_name,
                    "SrcPortName": load_port, "Route": deepcopy(runtime_route),
                })
            build_state.next_slot_by_port[load_port] = next_slot
            referenced_routes[runtime_route_name] = deepcopy(runtime_route)
            process_jobs.append({
                "JobName": pjob_name, "TaskID": task_id, "Priority": priority,
                "State": 0, "OriginRoute": deepcopy(runtime_route), "MatList": material_ids,
            })
            cjob_material_count += wafer_count

        control_jobs.append({
            "TaskID": task_id, "JobType": job_type, "Priority": cjob_priority,
            "TaskMode": task_mode, "PJobNameList": runtime_pjob_names,
            "MaterialCount": cjob_material_count,
        })
    return {
        "Scenario": 0, "Routes": referenced_routes,
        "ProcessRecipes": build_process_recipes(recipes, routes),
        "Materials": materials, "ProcessJobs": process_jobs, "ControlJobs": control_jobs,
        "RemoveList": [], "MoveStates": [], "CurrentTime": float(current_time),
    }


def _planned_event_groups(moves: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """把旧计划转换为按容差归并的事件组，完成事件在同刻新开始事件之前落地。"""
    groups: Dict[int, Dict[str, Any]] = {}
    for raw_move in moves:
        move = dict(raw_move)
        start = float(move.get("StartTime") or 0.0)
        end = float(move.get("EndTime") or start)
        move_id = int(move["MoveID"])
        start_bucket = int(round(start / TIME_TOLERANCE))
        end_bucket = int(round(end / TIME_TOLERANCE))
        start_group = groups.setdefault(start_bucket, {
            "time": start, "starts": [], "priorFinishes": [], "sameFinishes": [],
        })
        start_group["time"] = max(float(start_group["time"]), start)
        start_group["starts"].append((start, {
            "MoveID": move_id,
            "MoveState": MoveStateReplay.RUNNING,
            "StartTime": start,
            "EndTime": -1,
        }))
        end_group = groups.setdefault(end_bucket, {
            "time": end, "starts": [], "priorFinishes": [], "sameFinishes": [],
        })
        end_group["time"] = max(float(end_group["time"]), end)
        finish_key = "sameFinishes" if start_bucket == end_bucket else "priorFinishes"
        end_group[finish_key].append((end, {
            "MoveID": move_id,
            "MoveState": MoveStateReplay.DONE,
            "StartTime": start,
            "EndTime": end,
        }))
    ordered: List[Dict[str, Any]] = []
    for bucket in sorted(groups):
        group = groups[bucket]
        for key in ("starts", "priorFinishes", "sameFinishes"):
            group[key].sort(key=lambda item: (item[0], item[1]["MoveID"]))
        ordered.append(group)
    return ordered


def advance_to_recompute(
    scheduler: RealtimeRescheduler,
    cutoff: float,
    recorded_events: Optional[List[Dict[str, Any]]] = None,
) -> float:
    """沿旧计划推进到请求时刻后的第一个全局安全切点，不限制最长等待。"""
    cutoff = max(float(cutoff), scheduler.state_time)
    groups = _planned_event_groups(scheduler.current_plan)
    started: set[int] = set()
    finished: set[int] = set()

    def apply_notification(notification: Mapping[str, Any]) -> None:
        """发送一条计划通知，并同步维护已开始、已完成集合与复现日志。"""
        scheduler.update_move_state(notification)
        move_id = int(notification["MoveID"])
        if notification.get("MoveState") == MoveStateReplay.RUNNING:
            started.add(move_id)
        else:
            finished.add(move_id)
        if recorded_events is not None:
            recorded_events.append(deepcopy(notification))

    # 先还原请求时刻的真实状态：只开始严格早于请求时间的 Move，并落地截至请求时刻的完成。
    for group in groups:
        for event_time, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if event_time <= cutoff + TIME_TOLERANCE and move_id in started and move_id not in finished:
                apply_notification(notification)
        for event_time, notification in group["starts"]:
            move_id = int(notification["MoveID"])
            if event_time < cutoff - TIME_TOLERANCE and move_id not in started:
                apply_notification(notification)
        for event_time, notification in group["sameFinishes"]:
            move_id = int(notification["MoveID"])
            if event_time <= cutoff + TIME_TOLERANCE and move_id in started and move_id not in finished:
                apply_notification(notification)

    if scheduler.can_recompute:
        return float(cutoff)

    # 请求时刻不安全时继续执行旧计划；每个事件组先完成旧 Move，再判断是否可取消同刻新 Move。
    last_time = float(cutoff)
    for group in groups:
        group_time = max(float(cutoff), float(group["time"]))
        if float(group["time"]) < cutoff - TIME_TOLERANCE:
            continue
        for _, notification in group["priorFinishes"]:
            move_id = int(notification["MoveID"])
            if move_id in started and move_id not in finished:
                apply_notification(notification)
        last_time = max(last_time, group_time)
        if scheduler.can_recompute:
            return last_time
        for _, notification in group["starts"]:
            move_id = int(notification["MoveID"])
            if move_id not in started:
                apply_notification(notification)
        for _, notification in group["sameFinishes"]:
            move_id = int(notification["MoveID"])
            if move_id in started and move_id not in finished:
                apply_notification(notification)
        if scheduler.can_recompute:
            return last_time

    if scheduler.can_recompute:
        return last_time
    raise ValueError("旧计划执行结束后仍找不到全局安全重算时刻")


def _load_rl_policy() -> Any:
    """按需加载并缓存 RL 模型，文件缺失时给出可操作错误。"""
    global _RL_POLICY
    with _RL_POLICY_LOCK:
        if _RL_POLICY is not None:
            return _RL_POLICY
        if not RL_MODEL_PATH.exists():
            raise ValueError(f"RL 模型不存在：{RL_MODEL_PATH}")
        from src.policy import load_policy

        _RL_POLICY = load_policy(RL_MODEL_PATH)
        return _RL_POLICY


def _segment_end(moves: Iterable[Mapping[str, Any]]) -> float:
    """返回一组 Move 的最大结束时刻。"""
    return max((float(move.get("EndTime") or 0.0) for move in moves), default=0.0)


def _execute_plan(raw_plan: Mapping[str, Any], reproduction: ReproductionLog) -> Dict[str, Any]:
    """执行控制台提交的计划，并同步写入结构化复现事件。"""
    started = time.perf_counter()
    plan = deepcopy(dict(raw_plan))
    plan["device"] = extract_init_data(plan.get("device"))
    reproduction.add("AlgInit", plan["device"])
    strategy = str(plan.get("strategy") or "heuristic").strip().lower()
    if strategy not in {"heuristic", "rl"}:
        raise ValueError("策略只支持 heuristic 或 rl")
    rounds = [row for row in (plan.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = int(_finite_number(plan.get("roundCount"), len(rounds)))
    if round_count < 1 or len(rounds) != round_count:
        raise ValueError("轮次数量与 roundCount 不一致")
    times = [_finite_number(row.get("currentTime"), 0.0) for row in rounds]
    if abs(times[0]) > TIME_TOLERANCE:
        raise ValueError("首次排程时间必须为 0")
    if any(right <= left + TIME_TOLERANCE for left, right in zip(times, times[1:])):
        raise ValueError("各轮重算时间必须严格递增")

    policy = _load_rl_policy() if strategy == "rl" else None
    options = plan.get("options") if isinstance(plan.get("options"), Mapping) else {}
    build_state = BuildState()
    logs: List[str] = [
        f"设备：{plan.get('deviceName') or 'selected init'}",
        f"策略：{strategy}；总轮数：{round_count}",
    ]
    summaries: List[Dict[str, Any]] = []

    first_update = build_round_update(plan, rounds[0], 0.0, build_state)
    reproduction.add("AlgSchedule", _schedule_log_info(plan["device"], first_update))
    round_started = time.perf_counter()
    scheduler = RealtimeRescheduler(
        plan["device"],
        first_update,
        strategy=strategy,
        policy=policy,
        rl_search_seconds=_finite_number(options.get("rlSearchSeconds"), 4.0),
        rl_rollouts=max(0, int(_finite_number(options.get("rlRollouts"), 256))),
        rl_temperature=max(0.01, _finite_number(options.get("rlTemperature"), 0.7)),
        seed=int(_finite_number(options.get("seed"), 0)),
    )
    elapsed_ms = (time.perf_counter() - round_started) * 1000.0
    summaries.append({
        "index": 1,
        "kind": "initial",
        "requestedTime": 0.0,
        "effectiveTime": 0.0,
        "jobCount": _round_pjob_count(rounds[0]),
        "elapsedMs": elapsed_ms,
        "segmentEnd": _segment_end(scheduler.current_plan),
    })
    logs.append(f"[1/{round_count}] 首次排程完成：{elapsed_ms:.1f} ms，{len(scheduler.current_plan)} Moves")
    reproduction.add("AlgOutput", _alg_output_info(scheduler.combined_output()))

    for index, round_config in enumerate(rounds[1:], start=2):
        requested_time = times[index - 1]
        notifications: List[Dict[str, Any]] = []
        effective_time = advance_to_recompute(scheduler, requested_time, notifications)
        for notification in notifications:
            event_time = (
                notification.get("EndTime")
                if notification.get("MoveState") == MoveStateReplay.DONE
                else notification.get("StartTime")
            )
            reproduction.add("AlgUpdateMove", notification, _finite_number(event_time, requested_time))
        reproduction.add("RecomputeControl", {
            "ControlInfo": {"Round": index},
            "RecomputeInfo": {
                "CurrentTime": requested_time,
                "EffectiveTime": effective_time,
                "Reason": f"第 {index} 轮新增 Job",
            },
        }, requested_time)
        update = build_round_update(plan, round_config, requested_time, build_state)
        reproduction.add("AlgSchedule", _schedule_log_info(plan["device"], update), requested_time)
        round_started = time.perf_counter()
        scheduler.recompute(
            update,
            effective_time,
            cutoff_time=requested_time,
            reason=f"第 {index} 轮新增 Job",
        )
        elapsed_ms = (time.perf_counter() - round_started) * 1000.0
        summaries.append({
            "index": index,
            "kind": "recompute",
            "requestedTime": requested_time,
            "effectiveTime": effective_time,
            "jobCount": _round_pjob_count(round_config),
            "elapsedMs": elapsed_ms,
            "segmentEnd": _segment_end(scheduler.current_plan),
        })
        suffix = (
            f"，旧计划继续执行至 {effective_time:.2f}s 的首个安全时刻"
            if effective_time > requested_time + TIME_TOLERANCE else ""
        )
        logs.append(
            f"[{index}/{round_count}] @{requested_time:.2f}s 重算完成：{elapsed_ms:.1f} ms，"
            f"新增 {_round_pjob_count(round_config)} PJobs{suffix}"
        )
        reproduction.add("AlgOutput", _alg_output_info(scheduler.combined_output()), effective_time)

    output = scheduler.combined_output()
    total_ms = (time.perf_counter() - started) * 1000.0
    makespan = _segment_end(output["MoveList"])
    logs.append(f"完成：总耗时 {total_ms:.1f} ms，makespan={makespan:.2f}s，Move={len(output['MoveList'])}")
    return {
        "ok": True,
        "strategy": strategy,
        "rounds": summaries,
        "totalElapsedMs": total_ms,
        "makespan": makespan,
        "moveCount": len(output["MoveList"]),
        "validation": "passed",
        "logs": logs,
        "output": output,
    }


def execute_plan(raw_plan: Mapping[str, Any]) -> Dict[str, Any]:
    """执行计划；成功和失败都生成可重放的 input_data 格式日志。"""
    reproduction = ReproductionLog()
    reproduction.add("Input", [deepcopy(dict(raw_plan))])
    try:
        result = _execute_plan(raw_plan, reproduction)
    except Exception as error:  # noqa: BLE001
        reproduction.add("AlgOutput", _alg_output_info(feedback=[{
            "Level": "Error",
            "Type": type(error).__name__,
            "Message": str(error),
        }]))
        raise LoggedPlanError(str(error), reproduction.entries) from error
    result["reproductionLog"] = deepcopy(reproduction.entries)
    return result


def _workspace_timestamp() -> str:
    """生成工作区记录使用的本地秒级时间。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _empty_workspace_catalog() -> Dict[str, Any]:
    """创建当前版本的空设备工作区目录。"""
    return {"version": WORKSPACE_STORE_VERSION, "devices": []}


def _merge_named_assets(base: Sequence[Any], additions: Sequence[Any]) -> List[Dict[str, Any]]:
    """按名称合并 Route/Clean；同名项由后出现的数据覆盖且保持稳定位置。"""
    merged: List[Dict[str, Any]] = []
    positions: Dict[str, int] = {}
    for raw in [*base, *additions]:
        if not isinstance(raw, Mapping):
            continue
        item = deepcopy(dict(raw))
        name = str(item.get("name") or item.get("Name") or "").strip()
        key = name.casefold()
        if not key:
            continue
        if key in positions:
            merged[positions[key]] = item
        else:
            positions[key] = len(merged)
            merged.append(item)
    return merged


def _migrate_workspace_catalog(catalog: Dict[str, Any]) -> bool:
    """把旧测试集内的 Route/Clean 提升为设备级共享库，并移除测试集副本。"""
    changed = int(catalog.get("version") or 0) != WORKSPACE_STORE_VERSION
    for raw_device in catalog.get("devices") or []:
        if not isinstance(raw_device, dict):
            continue
        routes = list(raw_device.get("routes") or [])
        cleans = list(raw_device.get("cleans") or [])
        tests = [item for item in (raw_device.get("tests") or []) if isinstance(item, dict)]
        # 旧数据按更新时间从早到晚合并，因此最近编辑的同名定义成为设备共享定义。
        for test in sorted(tests, key=lambda item: str(item.get("updatedAt") or item.get("createdAt") or "")):
            if "routes" in test:
                routes = _merge_named_assets(routes, test.get("routes") or [])
                test.pop("routes", None)
                changed = True
            if "cleans" in test:
                cleans = _merge_named_assets(cleans, test.get("cleans") or [])
                test.pop("cleans", None)
                changed = True
        if raw_device.get("routes") != routes:
            raw_device["routes"] = routes
            changed = True
        if raw_device.get("cleans") != cleans:
            raw_device["cleans"] = cleans
            changed = True
    catalog["version"] = WORKSPACE_STORE_VERSION
    return changed


def _read_workspace_catalog_unlocked(path: Path) -> Dict[str, Any]:
    """在调用方持锁时读取并校验设备工作区目录。"""
    source_path = path
    if path == WORKSPACE_STORE_PATH and not path.is_file() and LEGACY_WORKSPACE_STORE_PATH.is_file():
        source_path = LEGACY_WORKSPACE_STORE_PATH
    if not source_path.is_file():
        return _empty_workspace_catalog()
    raw = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping) or not isinstance(raw.get("devices"), list):
        raise ValueError(f"设备测试集存储格式无效：{source_path}")
    catalog = deepcopy(dict(raw))
    changed = _migrate_workspace_catalog(catalog)
    if changed or source_path != path:
        _write_workspace_catalog_unlocked(path, catalog)
    return catalog


def _write_json_atomic(path: Path, payload: Any) -> None:
    """把 JSON 原子写入指定文件，避免异常退出留下半份配置。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2),
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _write_workspace_catalog_unlocked(path: Path, catalog: Mapping[str, Any]) -> None:
    """在调用方持锁时以原子替换方式保存设备工作区目录。"""
    _write_json_atomic(path, catalog)
    if path == WORKSPACE_STORE_PATH:
        for device in catalog.get("devices") or []:
            if not isinstance(device, Mapping) or not isinstance(device.get("device"), Mapping):
                continue
            device_id = str(device.get("id") or "").strip()
            if device_id:
                _write_json_atomic(DEVICE_INIT_DIR / f"{device_id}.json", device["device"])


def list_workspace_devices(path: Path = WORKSPACE_STORE_PATH) -> List[Dict[str, Any]]:
    """列出本地保存的设备摘要，不返回体积较大的 init 和测试集内容。"""
    with _WORKSPACE_STORE_LOCK:
        catalog = _read_workspace_catalog_unlocked(path)
        return [{
            "id": str(device.get("id") or ""),
            "name": str(device.get("name") or "未命名设备"),
            "testCount": len(device.get("tests") or []),
            "updatedAt": device.get("updatedAt"),
        } for device in catalog["devices"] if isinstance(device, Mapping)]


def get_workspace_device(device_id: str, path: Path = WORKSPACE_STORE_PATH) -> Dict[str, Any]:
    """读取一个设备及其全部测试集，设备不存在时抛出明确错误。"""
    with _WORKSPACE_STORE_LOCK:
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and str(item.get("id")) == device_id
        ), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        return deepcopy(dict(device))


def _unique_workspace_name(name: str, existing_names: Iterable[str]) -> str:
    """为设备或测试集生成易读且不重复的名称。"""
    normalized = name.strip() or "未命名"
    occupied = {str(item) for item in existing_names}
    if normalized not in occupied:
        return normalized
    suffix = 2
    while f"{normalized} ({suffix})" in occupied:
        suffix += 1
    return f"{normalized} ({suffix})"


def _device_fingerprint(device_data: Mapping[str, Any]) -> str:
    """计算设备语义指纹，将 JSON 中数值相同的整数和浮点数视为同一拓扑。"""
    def normalize(value: Any) -> Any:
        """递归规范化 JSON 数值表示，不改变字段、数组顺序或非整数浮点精度。"""
        if isinstance(value, Mapping):
            return {str(key): normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, float) and math.isfinite(value) and value.is_integer():
            return int(value)
        return value

    canonical = json.dumps(
        normalize(device_data), ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def import_workspace_device(
    name: str,
    raw_device: Any,
    path: Path = WORKSPACE_STORE_PATH,
) -> Tuple[Dict[str, Any], bool]:
    """导入设备 init；相同拓扑通过指纹复用已有设备及其测试集。"""
    device_data = extract_init_data(raw_device)
    fingerprint = _device_fingerprint(device_data)
    with _WORKSPACE_STORE_LOCK:
        catalog = _read_workspace_catalog_unlocked(path)
        existing = next((
            item for item in catalog["devices"]
            if isinstance(item, Mapping) and (
                item.get("fingerprint") == fingerprint
                or (
                    isinstance(item.get("device"), Mapping)
                    and _device_fingerprint(item["device"]) == fingerprint
                )
            )
        ), None)
        if existing is not None:
            requested_name = Path(name).name.strip() or str(existing.get("name") or "未命名设备")
            existing["name"] = _unique_workspace_name(
                requested_name,
                (
                    str(item.get("name") or "")
                    for item in catalog["devices"]
                    if isinstance(item, Mapping) and item is not existing
                ),
            )
            existing["fingerprint"] = fingerprint
            existing["device"] = device_data
            existing["updatedAt"] = _workspace_timestamp()
            _write_workspace_catalog_unlocked(path, catalog)
            return deepcopy(dict(existing)), False
        timestamp = _workspace_timestamp()
        device = {
            "id": uuid.uuid4().hex,
            "name": _unique_workspace_name(
                Path(name).name or "未命名设备",
                (str(item.get("name") or "") for item in catalog["devices"] if isinstance(item, Mapping)),
            ),
            "fingerprint": fingerprint,
            "device": device_data,
            "routes": [],
            "cleans": [],
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "tests": [],
        }
        catalog["devices"].append(device)
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(device), True


def _normalize_workspace_pjob(raw: Mapping[str, Any], index: int, task_id: str) -> Dict[str, Any]:
    """规范化页面 PJob，并生成只读 JobName、TaskID 与 MatList。"""
    wafer_count = max(1, min(MAX_WAFERS_PER_JOB, int(_finite_number(
        raw.get("waferCount"), len(raw.get("matList") or raw.get("MatList") or []) or 1,
    ))))
    job_name = f"P{index}"
    origin_route = raw.get("originRoute", raw.get("OriginRoute"))
    if isinstance(origin_route, Mapping):
        origin_route = origin_route.get("name") or origin_route.get("Name")
    return {
        "jobName": job_name,
        "taskId": task_id,
        "waferCount": wafer_count,
        "matList": list(range(1, wafer_count + 1)),
        "routeRef": str(raw.get("routeRef") or origin_route or ""),
        "loadPort": str(raw.get("loadPort") or raw.get("LoadPort") or ""),
        "priority": max(1, int(_finite_number(raw.get("priority", raw.get("Priority")), 1))),
    }


def _normalize_workspace_round(raw: Mapping[str, Any], index: int, current_time: float) -> Dict[str, Any]:
    """规范化一轮 CJob/PJob；旧版 jobs 合并到该轮唯一默认 CJob。"""
    task_id = str(index)
    raw_cjobs = raw.get("cjobs")
    if isinstance(raw_cjobs, Sequence) and not isinstance(raw_cjobs, (str, bytes)):
        cjob_rows = [row for row in raw_cjobs if isinstance(row, Mapping)]
    else:
        legacy_jobs = [row for row in (raw.get("jobs") or []) if isinstance(row, Mapping)]
        first = legacy_jobs[0] if legacy_jobs else {}
        cjob_rows = [{
            "jobType": first.get("jobType", "NormalLot"),
            "priority": first.get("priority", 1),
            "taskMode": first.get("taskMode", "Smart"),
            "pjobs": legacy_jobs or [{}],
        }]
    if not cjob_rows:
        cjob_rows = [{"pjobs": [{}]}]
    cjobs: List[Dict[str, Any]] = []
    for cjob_index, row in enumerate(cjob_rows, start=1):
        raw_job_type = row.get("jobType", row.get("JobType", "NormalLot"))
        try:
            job_type_value = _enum_value(raw_job_type, CJOB_TYPE_VALUES, "JobType", "NormalLot")
        except ValueError:
            job_type_value = CJOB_TYPE_VALUES["NormalLot"]
        raw_task_mode = row.get("taskMode", row.get("TaskMode", "Smart"))
        try:
            task_mode_value = _enum_value(raw_task_mode, TASK_MODE_VALUES, "TaskMode", "Smart")
        except ValueError:
            task_mode_value = TASK_MODE_VALUES["Smart"]
        pjob_rows = [item for item in (row.get("pjobs") or []) if isinstance(item, Mapping)] or [{}]
        pjobs = [
            _normalize_workspace_pjob(item, pjob_index, task_id)
            for pjob_index, item in enumerate(pjob_rows, start=1)
        ]
        cjobs.append({
            "taskId": task_id,
            "jobType": CJOB_TYPE_NAMES[job_type_value],
            "priority": max(1, int(_finite_number(row.get("priority", row.get("Priority")), 1))) if job_type_value == 0 else -1,
            "taskMode": TASK_MODE_NAMES[task_mode_value],
            "pJobNameList": [pjob["jobName"] for pjob in pjobs],
            "pjobs": pjobs,
            "key": str(row.get("key") or f"C{cjob_index}"),
        })
    return {"currentTime": 0.0 if index == 1 else float(current_time), "cjobs": cjobs}


def _normalize_test_case(raw_test: Mapping[str, Any], test_id: Optional[str] = None) -> Dict[str, Any]:
    """保存只含排程任务的测试集结构，并兼容迁移旧版扁平 Job。"""
    timestamp = _workspace_timestamp()
    raw_rounds = [row for row in (raw_test.get("rounds") or []) if isinstance(row, Mapping)]
    round_count = max(1, int(_finite_number(raw_test.get("roundCount"), len(raw_rounds) or 1)))
    times = deepcopy(list(raw_test.get("times") or [0.0]))
    while len(raw_rounds) < round_count:
        raw_rounds.append({})
    while len(times) < round_count:
        times.append((float(times[-1]) if times else 0.0) + 70.0)
    rounds = [
        _normalize_workspace_round(
            raw_rounds[index], index + 1,
            _finite_number(raw_rounds[index].get("currentTime"), _finite_number(times[index], 0.0)),
        )
        for index in range(round_count)
    ]
    next_material_id = 1
    for round_row in rounds:
        for cjob in round_row["cjobs"]:
            for pjob in cjob["pjobs"]:
                wafer_count = int(pjob["waferCount"])
                pjob["matList"] = list(range(next_material_id, next_material_id + wafer_count))
                next_material_id += wafer_count
    times = [round_row["currentTime"] for round_row in rounds]
    return {
        "id": test_id or uuid.uuid4().hex,
        "name": str(raw_test.get("name") or "未命名测试集").strip() or "未命名测试集",
        "strategy": str(raw_test.get("strategy") or "heuristic"),
        "roundCount": round_count,
        "times": times,
        "options": deepcopy(dict(raw_test.get("options") or {})),
        "rounds": rounds,
        "createdAt": str(raw_test.get("createdAt") or timestamp),
        "updatedAt": timestamp,
    }


def _apply_device_library(device: Dict[str, Any], payload: Mapping[str, Any]) -> None:
    """将前端随保存请求提交的 Route/Clean 写入设备级共享库。"""
    if isinstance(payload.get("routes"), list):
        device["routes"] = deepcopy(payload["routes"])
    else:
        device.setdefault("routes", [])
    if isinstance(payload.get("cleans"), list):
        device["cleans"] = deepcopy(payload["cleans"])
    else:
        device.setdefault("cleans", [])


def create_workspace_test(
    device_id: str,
    raw_test: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """在指定设备下新增一个独立测试集，并自动消解重名。"""
    with _WORKSPACE_STORE_LOCK:
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        _apply_device_library(device, raw_test)
        test_case = _normalize_test_case(raw_test)
        test_case["name"] = _unique_workspace_name(
            test_case["name"],
            (str(item.get("name") or "") for item in device.get("tests") or []),
        )
        device.setdefault("tests", []).append(test_case)
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(test_case)


def update_workspace_test(
    device_id: str,
    test_id: str,
    raw_test: Mapping[str, Any],
    path: Path = WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """覆盖保存一个测试集，同时保持创建时间和稳定 ID。"""
    with _WORKSPACE_STORE_LOCK:
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        tests = device.get("tests") or []
        index = next((position for position, item in enumerate(tests) if item.get("id") == test_id), None)
        if index is None:
            raise ValueError(f"测试集不存在：{test_id}")
        requested_name = str(raw_test.get("name") or "").strip() or "未命名测试集"
        duplicate = next((
            item for item in tests
            if item.get("id") != test_id and str(item.get("name") or "") == requested_name
        ), None)
        if duplicate is not None:
            raise ValueError(f"测试集名称重复：{requested_name}")
        _apply_device_library(device, raw_test)
        merged = dict(raw_test)
        merged["createdAt"] = tests[index].get("createdAt")
        test_case = _normalize_test_case(merged, test_id)
        tests[index] = test_case
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)
        return deepcopy(test_case)


def delete_workspace_test(
    device_id: str,
    test_id: str,
    path: Path = WORKSPACE_STORE_PATH,
) -> None:
    """删除指定测试集；设备至少保留一个测试集以维持可运行状态。"""
    with _WORKSPACE_STORE_LOCK:
        catalog = _read_workspace_catalog_unlocked(path)
        device = next((item for item in catalog["devices"] if item.get("id") == device_id), None)
        if device is None:
            raise ValueError(f"设备不存在：{device_id}")
        tests = device.get("tests") or []
        if len(tests) <= 1:
            raise ValueError("设备至少需要保留一个测试集")
        remaining = [item for item in tests if item.get("id") != test_id]
        if len(remaining) == len(tests):
            raise ValueError(f"测试集不存在：{test_id}")
        device["tests"] = remaining
        device["updatedAt"] = _workspace_timestamp()
        _write_workspace_catalog_unlocked(path, catalog)


def save_result(output: Dict[str, Any]) -> str:
    """把甘特图数据写入专用导出目录并放入有界内存缓存。"""
    result_id = uuid.uuid4().hex
    _write_json_atomic(RESULT_EXPORT_DIR / f"{result_id}.json", output)
    with _RESULTS_LOCK:
        _RESULTS[result_id] = output
        _RESULTS.move_to_end(result_id)
        while len(_RESULTS) > MAX_SAVED_RESULTS:
            _RESULTS.popitem(last=False)
    return result_id


def read_result(result_id: str) -> Optional[Dict[str, Any]]:
    """读取一次运行的甘特图数据；服务重启后可从磁盘恢复。"""
    with _RESULTS_LOCK:
        value = _RESULTS.get(result_id)
        if value is not None:
            return deepcopy(value)
    if len(result_id) == 32 and all(char in "0123456789abcdef" for char in result_id.lower()):
        path = RESULT_EXPORT_DIR / f"{result_id}.json"
        if path.is_file():
            value = json.loads(path.read_text(encoding="utf-8"))
            return deepcopy(value) if isinstance(value, Mapping) else None
    return None


def save_reproduction_log(entries: Sequence[Mapping[str, Any]]) -> str:
    """把 input_data 格式日志写入专用导出目录并放入有界内存缓存。"""
    log_id = uuid.uuid4().hex
    payload = deepcopy(list(entries))
    _write_json_atomic(LOG_EXPORT_DIR / f"{log_id}.json", payload)
    with _REPRODUCTION_LOGS_LOCK:
        _REPRODUCTION_LOGS[log_id] = payload
        _REPRODUCTION_LOGS.move_to_end(log_id)
        while len(_REPRODUCTION_LOGS) > MAX_SAVED_RESULTS:
            _REPRODUCTION_LOGS.popitem(last=False)
    return log_id


def read_reproduction_log(log_id: str) -> Optional[List[Dict[str, Any]]]:
    """读取一次运行的可复现日志；服务重启后可从磁盘恢复。"""
    with _REPRODUCTION_LOGS_LOCK:
        value = _REPRODUCTION_LOGS.get(log_id)
        if value is not None:
            return deepcopy(value)
    if len(log_id) == 32 and all(char in "0123456789abcdef" for char in log_id.lower()):
        path = LOG_EXPORT_DIR / f"{log_id}.json"
        if path.is_file():
            value = json.loads(path.read_text(encoding="utf-8"))
            return deepcopy(value) if isinstance(value, list) else None
    return None


def _log_response_fields(log_id: str) -> Dict[str, str]:
    """生成前端下载日志所需的稳定地址与文件名。"""
    filename = f"ct-input-log-{log_id[:8]}.json"
    return {"logUrl": f"/api/logs/{log_id}", "logFileName": filename}


class ConfigEditorHandler(BaseHTTPRequestHandler):
    """暴露调度控制台、设备测试集、甘特图和运行 API 的本地 HTTP 处理器。"""

    server_version = "CTConfigEditor/1.0"

    def do_GET(self) -> None:
        """处理页面、健康检查和内存结果读取。"""
        path = unquote(urlparse(self.path).path)
        if path in {"/", "/config_editor.html"}:
            self._send_file(EDITOR_PATH, "text/html; charset=utf-8")
            return
        if path == "/movelist_gantt_viewer.html":
            self._send_file(VIEWER_PATH, "text/html; charset=utf-8")
            return
        if path == "/api/health":
            self._send_json({
                "ok": True,
                "service": "ct-config-editor",
                "schemaVersion": API_SCHEMA_VERSION,
                "strategies": {"heuristic": True, "rl": RL_MODEL_PATH.is_file()},
            })
            return
        if path == "/api/workspaces":
            try:
                self._send_json({"ok": True, "devices": list_workspace_devices()})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path.startswith("/api/workspaces/"):
            parts = [part for part in path.split("/") if part]
            if len(parts) == 3:
                try:
                    self._send_json({"ok": True, "device": get_workspace_device(parts[2])})
                except Exception as error:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(error)}, HTTPStatus.NOT_FOUND)
                return
        if path.startswith("/api/results/"):
            result = read_result(path.rsplit("/", 1)[-1])
            if result is None:
                self._send_json({"ok": False, "error": "结果不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(result)
            return
        if path.startswith("/api/logs/"):
            log_id = path.rsplit("/", 1)[-1]
            reproduction_log = read_reproduction_log(log_id)
            if reproduction_log is None:
                self._send_json({"ok": False, "error": "日志不存在或已过期"}, HTTPStatus.NOT_FOUND)
            else:
                self._send_json(
                    reproduction_log,
                    download_name=f"ct-input-log-{log_id[:8]}.json",
                )
            return
        self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        """接收控制台配置并同步运行后端策略。"""
        path = unquote(urlparse(self.path).path)
        if path == "/api/workspaces/devices":
            try:
                payload = self._read_json_object()
                device, created = import_workspace_device(
                    str(payload.get("name") or "未命名设备"), payload.get("device"),
                )
                self._send_json({"ok": True, "created": created, "device": {
                    "id": device["id"],
                    "name": device["name"],
                    "testCount": len(device.get("tests") or []),
                }})
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        workspace_parts = [part for part in path.split("/") if part]
        if len(workspace_parts) == 4 and workspace_parts[:2] == ["api", "workspaces"] and workspace_parts[3] == "tests":
            try:
                payload = self._read_json_object()
                test_case = create_workspace_test(workspace_parts[2], payload)
                self._send_json({"ok": True, "test": test_case}, HTTPStatus.CREATED)
            except Exception as error:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        if path != "/api/run":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        payload: Any = None
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("请求为空或超过大小限制")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("请求体必须是 JSON 对象")
            result = execute_plan(payload)
            result_id = save_result(result["output"])
            log_id = save_reproduction_log(result["reproductionLog"])
            response = {
                key: value
                for key, value in result.items()
                if key not in {"output", "reproductionLog"}
            }
            response["resultId"] = result_id
            response["ganttUrl"] = f"/movelist_gantt_viewer.html?src=/api/results/{result_id}"
            response.update(_log_response_fields(log_id))
            self._send_json(response)
        except LoggedPlanError as error:
            log_id = save_reproduction_log(error.reproduction_log)
            response = {"ok": False, "error": str(error)}
            response.update(_log_response_fields(log_id))
            self._send_json(response, HTTPStatus.BAD_REQUEST)
        except Exception as error:  # noqa: BLE001
            reproduction = ReproductionLog()
            reproduction.add("Input", [deepcopy(dict(payload))] if isinstance(payload, Mapping) else [])
            reproduction.add("AlgOutput", _alg_output_info(feedback=[{
                "Level": "Error",
                "Type": type(error).__name__,
                "Message": str(error),
            }]))
            log_id = save_reproduction_log(reproduction.entries)
            response = {"ok": False, "error": str(error) or type(error).__name__}
            response.update(_log_response_fields(log_id))
            self._send_json(response, HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:
        """保存设备下已有测试集的完整可运行配置。"""
        path = unquote(urlparse(self.path).path)
        parts = [part for part in path.split("/") if part]
        if len(parts) != 5 or parts[:2] != ["api", "workspaces"] or parts[3] != "tests":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self._read_json_object()
            test_case = update_workspace_test(parts[2], parts[4], payload)
            self._send_json({"ok": True, "test": test_case})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def do_DELETE(self) -> None:
        """删除设备下指定测试集，并返回剩余测试集列表。"""
        path = unquote(urlparse(self.path).path)
        parts = [part for part in path.split("/") if part]
        if len(parts) != 5 or parts[:2] != ["api", "workspaces"] or parts[3] != "tests":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        try:
            delete_workspace_test(parts[2], parts[4])
            device = get_workspace_device(parts[2])
            self._send_json({"ok": True, "tests": device["tests"]})
        except Exception as error:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)

    def log_message(self, format_string: str, *args: Any) -> None:
        """保留简洁的本地访问日志。"""
        sys.stdout.write(f"[config-editor] {self.address_string()} {format_string % args}\n")

    def _send_file(self, path: Path, content_type: str) -> None:
        """发送白名单中的静态文件。"""
        if not path.is_file():
            self._send_json({"ok": False, "error": f"文件不存在：{path}"}, HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def _read_json_object(self) -> Dict[str, Any]:
        """读取受大小限制的 JSON 对象请求体。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("请求为空或超过大小限制")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, Mapping):
            raise ValueError("请求体必须是 JSON 对象")
        return dict(payload)

    def _send_json(
        self,
        payload: Any,
        status: HTTPStatus = HTTPStatus.OK,
        download_name: Optional[str] = None,
    ) -> None:
        """以 UTF-8 JSON 返回 API 结果。"""
        content = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    """启动仅监听本机的多线程调度控制台服务。"""
    parser = argparse.ArgumentParser(description="CT 调度控制台本地服务")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认仅本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口")
    parser.add_argument("--open", action="store_true", help="启动后打开默认浏览器")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), ConfigEditorHandler)
    url = f"http://{args.host}:{args.port}/"
    print(f"CT 调度控制台：{url}")
    print("按 Ctrl+C 停止服务")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
