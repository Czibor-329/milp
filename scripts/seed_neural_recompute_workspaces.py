"""幂等生成神经实时重算、清洁和六腔路线分解的前端验收工作区。

脚本只通过实时调度服务已有的工作区 CRUD 写入数据：四腔案例合并到现有
PSE300，六腔案例导入独立克隆设备，避免改变原设备拓扑。重复运行不会新增
同名 Route、Clean 或测试。
"""

from __future__ import annotations

import argparse
import json
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from realtime_scheduler import server as scheduler_server
from scripts.benchmark_neural_route_decomposition import six_pm_device


PSE300_PATH = ROOT / "alg" / "src" / "input_data" / "PSE300.json"
RECOMPUTE_GRIDS = (50, 100, 150, 250, 300)
WAFER_COUNTS = (10, 15)
SIX_PM_LONG_ROUNDS = 5
SIX_PM_LONG_INTERVAL_SECONDS = 1200
SIX_PM_LONG_WAFERS_PER_JOB = 5

SINGLE_TWO_JOB_GROUP = "单次重算-2Job"
R2_THREE_JOB_GROUP = "R2-3Job"
SINGLE_ONE_JOB_CLEAN_GROUP = "单次重算-1Job带清洁"
SINGLE_TWO_JOB_CLEAN_GROUP = "单次重算-2Job带清洁"
LEGACY_R2_GROUP = "R2-历史案例"
LEGACY_LONG_GROUP = "R10-历史案例"
ROUTE_DECOMPOSITION_GROUP = "六腔路线分解-验收"
LONG_QUALITY_GROUP = "六腔长途质量A/B"
LOADLOCK_CADENCE_GROUP = "LoadLock交换与短工艺-回归"

ROUTE_PM12 = "1道工序 · PM1/PM2(120s)"
ROUTE_PM123 = "PM1/PM2/PM3(120s)"
ROUTE_PM34 = "1道工序 · PM3/PM4(120s)"
ROUTE_PM1 = "1道工序 · PM1(40s)"
ROUTE_ALL4 = "1道工序 · PM1/PM2/PM3/PM4(120s)"
ROUTE_PM3_PM4 = "2道工序 · PM3(60s) → PM4(100s)"
ROUTE_PM1_PM3 = "2道工序 · PM1(60s) → PM3(100s)"
ROUTE_PM2_PM3 = "2道工序 · PM2(60s) → PM3(100s)"
ROUTE_PRE_CLEAN = "1道工序 · PM1/PM2(90s)"
ROUTE_WAC_CLEAN = "1道工序 · PM1(90s)"

PRE_CLEAN_NAME = "PRE-PM12-T30"
WAC_CLEAN_NAME = "WAC5-PM1-T30"

ROUTE_FULL6 = "1道工序 · PM1/PM2/PM3/PM4/PM5/PM6(300s)"
ROUTE_PAIR12 = "1道工序 · PM1/PM2(300s)"
ROUTE_PAIR34 = "1道工序 · PM3/PM4(300s)"
ROUTE_PAIR56 = "1道工序 · PM5/PM6(300s)"
ROUTE_SHORT6 = "PM1/PM2/PM3/PM4/PM5/PM6(5s,Residency30s)"
LOADLOCK_CADENCE_TEST = "6PM-5s-双相同Job-驻留30s"


def _visit(
    station_name: str,
    *,
    recipe_name: str = "",
    process_time: float = 20.0,
    residency: float = -1.0,
    after_clean_refs: Sequence[str] = (),
) -> Dict[str, Any]:
    """创建前端 Route 编辑器可直接展示的 IVisit。"""
    return {
        "stationName": station_name,
        "slotIds": "1",
        "processRecipe": recipe_name,
        "processTime": float(process_time),
        "recipeTime": float(process_time),
        "processType": "",
        "weight": "{}",
        "moveTimeOffset": "{}",
        "qTimeLimit": -1,
        "residencyConstraint": float(residency),
        "beforeCleanRefs": [],
        "afterCleanRefs": list(after_clean_refs),
    }


def _stage(
    step_id: int,
    stations: Sequence[str],
    *,
    recipe_name: str = "",
    process_time: float = 20.0,
    residency: float = -1.0,
    after_clean_refs: Sequence[str] = (),
) -> Dict[str, Any]:
    """创建一个候选站点共享 Recipe 参数的线性 Route Step。"""
    return {
        "stepId": step_id,
        "postStepIds": [],
        "needProcess": bool(recipe_name),
        "visits": [
            _visit(
                station,
                recipe_name=recipe_name,
                process_time=process_time,
                residency=residency,
                after_clean_refs=after_clean_refs,
            )
            for station in stations
        ],
        "kind": "robot" if stations and stations[0] in {"ATR", "VTR"} else "station",
    }


def _route(
    name: str,
    process_steps: Sequence[tuple[Sequence[str], float]],
    *,
    pre_clean_refs: Sequence[str] = (),
    periodic_clean_ref: str = "",
    residency: float = -1.0,
) -> Dict[str, Any]:
    """构造 LP—双 LoadLock—若干 PM—双 LoadLock—LP 的完整路线。"""
    stages: List[Dict[str, Any]] = [
        _stage(0, ("LP1",)),
        _stage(1, ("ATR",)),
        _stage(2, ("LA", "LB")),
        _stage(3, ("VTR",)),
    ]
    for process_index, (modules, process_time) in enumerate(
        process_steps,
        start=1,
    ):
        recipe_name = f"NeuralAcceptance_{name}_Step{process_index}"
        stages.append(_stage(
            len(stages),
            modules,
            recipe_name=recipe_name,
            process_time=process_time,
            residency=residency,
            after_clean_refs=(
                (periodic_clean_ref,)
                if periodic_clean_ref and process_index == 1
                else ()
            ),
        ))
        stages.append(_stage(len(stages), ("VTR",)))
    stages.extend([
        _stage(len(stages), ("LA", "LB")),
        _stage(len(stages) + 1, ("ATR",)),
        _stage(len(stages) + 2, ("LP1",)),
    ])
    for index, stage in enumerate(stages):
        stage["stepId"] = index
        stage["postStepIds"] = [index + 1] if index + 1 < len(stages) else []
    return {
        "name": name,
        "group": "神经实时验收",
        "bufferOption": 0,
        "prePJobCleanRefs": list(pre_clean_refs),
        "postPJobCleanRefs": [],
        "postCJobCleanRefs": [],
        "stages": stages,
    }


def _pjob(route_ref: str, load_port: str, wafer_count: int) -> Dict[str, Any]:
    """创建工作区规范化器需要的最小 PJob 输入。"""
    return {
        "routeRef": route_ref,
        "loadPort": load_port,
        "waferCount": int(wafer_count),
        "priority": 1,
    }


def _round(
    current_time: float,
    pjobs: Sequence[Mapping[str, Any]],
    *,
    separate_cjobs: bool = False,
) -> Dict[str, Any]:
    """创建一轮任务；需要并发语义时让每个 PJob 使用独立 CJob。"""
    if separate_cjobs:
        cjobs = [
            {
                "jobType": "NormalLot",
                "priority": 1,
                "taskMode": "Smart",
                "key": f"C{index}",
                "pjobs": [deepcopy(dict(pjob))],
            }
            for index, pjob in enumerate(pjobs, start=1)
        ]
    else:
        cjobs = [{
            "jobType": "NormalLot",
            "priority": 1,
            "taskMode": "Smart",
            "key": "C1",
            "pjobs": [deepcopy(dict(pjob)) for pjob in pjobs],
        }]
    return {"currentTime": float(current_time), "cjobs": cjobs}


def _test(
    name: str,
    group: str,
    rounds: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    """创建默认由深层神经策略运行的工作区测试。"""
    return {
        "name": name,
        "group": group,
        "strategy": "neural",
        "roundCount": len(rounds),
        "times": [float(round_row["currentTime"]) for round_row in rounds],
        "options": {"loadLockManager": "petri-look"},
        "rounds": [deepcopy(dict(round_row)) for round_row in rounds],
    }


def _merge_named_assets(
    existing: Sequence[Mapping[str, Any]],
    additions: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """按 name 原位更新共享资产，并把新资产稳定追加到末尾。"""
    merged = [deepcopy(dict(item)) for item in existing]
    index_by_name = {
        str(item.get("name") or ""): index
        for index, item in enumerate(merged)
    }
    for addition in additions:
        value = deepcopy(dict(addition))
        name = str(value.get("name") or "")
        if name in index_by_name:
            merged[index_by_name[name]] = value
        else:
            index_by_name[name] = len(merged)
            merged.append(value)
    return merged


def _ensure_groups(
    device_id: str,
    groups: Iterable[str],
    store_path: Path,
) -> None:
    """补齐设备测试组，同时保持已有组顺序。"""
    device = scheduler_server.get_workspace_device(device_id, store_path)
    known = set(device.get("testGroups") or [])
    for group in groups:
        if group in known:
            continue
        scheduler_server.create_workspace_test_group(
            device_id,
            group,
            store_path,
        )
        known.add(group)


def _upsert_tests(
    device_id: str,
    tests: Sequence[Mapping[str, Any]],
    routes: Sequence[Mapping[str, Any]],
    cleans: Sequence[Mapping[str, Any]],
    store_path: Path,
) -> List[str]:
    """按全局测试名称更新或创建案例，并在首次写入时提交完整共享库。"""
    written_ids: List[str] = []
    for index, raw_test in enumerate(tests):
        device = scheduler_server.get_workspace_device(device_id, store_path)
        existing = next(
            (
                test_case
                for test_case in (device.get("tests") or [])
                if str(test_case.get("name") or "") == str(raw_test.get("name") or "")
            ),
            None,
        )
        payload = deepcopy(dict(raw_test))
        if index == 0:
            payload["routes"] = [deepcopy(dict(route)) for route in routes]
            payload["cleans"] = [deepcopy(dict(clean)) for clean in cleans]
        if existing is None:
            saved = scheduler_server.create_workspace_test(
                device_id,
                payload,
                store_path,
            )
        else:
            saved = scheduler_server.update_workspace_test(
                device_id,
                str(existing["id"]),
                payload,
                store_path,
            )
        written_ids.append(str(saved["id"]))
    return written_ids


def _move_legacy_test(
    device_id: str,
    test_name: str,
    source_group: str,
    target_group: str,
    store_path: Path,
) -> None:
    """把已知不符合当前组语义的旧案例保留到显式历史组。"""
    device = scheduler_server.get_workspace_device(device_id, store_path)
    test_case = next(
        (
            test
            for test in (device.get("tests") or [])
            if str(test.get("name") or "") == test_name
            and str(test.get("group") or "") == source_group
        ),
        None,
    )
    if test_case is None:
        return
    payload = deepcopy(dict(test_case))
    payload["group"] = target_group
    scheduler_server.update_workspace_test(
        device_id,
        str(test_case["id"]),
        payload,
        store_path,
    )


def _four_pm_assets() -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """返回四腔矩阵新增 Route 与 Clean 模板。"""
    routes = [
        _route(ROUTE_PM12, [(("PM1", "PM2"), 120)]),
        _route(ROUTE_PM123, [(("PM1", "PM2", "PM3"), 120)]),
        _route(ROUTE_PM34, [(("PM3", "PM4"), 120)]),
        _route(ROUTE_PM1, [(("PM1",), 40)]),
        _route(ROUTE_ALL4, [(("PM1", "PM2", "PM3", "PM4"), 120)]),
        _route(ROUTE_PM3_PM4, [(("PM3",), 60), (("PM4",), 100)]),
        _route(ROUTE_PM1_PM3, [(("PM1",), 60), (("PM3",), 100)]),
        _route(ROUTE_PM2_PM3, [(("PM2",), 60), (("PM3",), 100)]),
        _route(
            ROUTE_PRE_CLEAN,
            [(("PM1", "PM2"), 90)],
            pre_clean_refs=(PRE_CLEAN_NAME,),
        ),
        _route(
            ROUTE_WAC_CLEAN,
            [(("PM1",), 90)],
            periodic_clean_ref=WAC_CLEAN_NAME,
        ),
    ]
    cleans = [
        {
            "name": PRE_CLEAN_NAME,
            "recipeName": f"{PRE_CLEAN_NAME}-Recipe",
            "recipeRef": f"{PRE_CLEAN_NAME}-Recipe",
            "recipeTime": 30,
            "modules": ["PM1", "PM2"],
            "taskName": "PreCleanPM12",
            "stateVariable": "IdleTime",
            "lower": 0,
            "upper": 9999,
            "updateStateVariables": ["IdleTime"],
            "materialCount": 0,
            "preJudge": False,
        },
        {
            "name": WAC_CLEAN_NAME,
            "recipeName": f"{WAC_CLEAN_NAME}-Recipe",
            "recipeRef": f"{WAC_CLEAN_NAME}-Recipe",
            "recipeTime": 30,
            "modules": ["PM1"],
            "taskName": "WacCleanPM1",
            "stateVariable": "ProcessCount",
            "lower": 5,
            "upper": 9999,
            "updateStateVariables": ["ProcessCount"],
            "materialCount": 0,
            "preJudge": False,
        },
    ]
    return routes, cleans


def _single_two_job_tests() -> List[Dict[str, Any]]:
    """生成同路线、无公共腔和共享 PM3 的单轮双 Job 对照。"""
    categories = (
        ("同Job", ROUTE_PM12, ROUTE_PM12),
        ("同构无公共腔", ROUTE_PM12, ROUTE_PM34),
        ("异构无公共腔", ROUTE_PM1, ROUTE_PM3_PM4),
        ("异构共享PM3", ROUTE_PM1_PM3, ROUTE_PM2_PM3),
    )
    tests: List[Dict[str, Any]] = []
    for label, left_route, right_route in categories:
        for wafer_count in WAFER_COUNTS:
            if label == "同Job" and wafer_count == 15:
                tests.append(_test(
                    "t1",
                    SINGLE_TWO_JOB_GROUP,
                    [_round(
                        0,
                        (
                            _pjob(ROUTE_PM123, "LP1", 12),
                            _pjob(ROUTE_PM123, "LP1", 12),
                        ),
                    )],
                ))
                continue
            tests.append(_test(
                f"S2-{label}-N{wafer_count}",
                SINGLE_TWO_JOB_GROUP,
                [_round(
                    0,
                    (
                        _pjob(left_route, "LP1", wafer_count),
                        _pjob(right_route, "LP2", wafer_count),
                    ),
                    separate_cjobs=True,
                )],
            ))
    return tests


def _r2_three_job_tests() -> List[Dict[str, Any]]:
    """生成两次重算、三个 Job 的四类完整五档网格与双片数矩阵。"""
    categories = (
        ("简单", ROUTE_PM12, ROUTE_PM12),
        ("中等并发", ROUTE_PM12, ROUTE_PM34),
        ("复杂无公共腔", ROUTE_PM1, ROUTE_PM3_PM4),
        ("超复杂共享PM3", ROUTE_PM1_PM3, ROUTE_PM2_PM3),
    )
    tests: List[Dict[str, Any]] = []
    for label, second_route, third_route in categories:
        for grid in RECOMPUTE_GRIDS:
            for wafer_count in WAFER_COUNTS:
                tests.append(_test(
                    f"R2-{label}-G{grid:03d}-N{wafer_count}",
                    R2_THREE_JOB_GROUP,
                    [
                        _round(
                            0,
                            (_pjob(ROUTE_ALL4, "LP1", wafer_count),),
                        ),
                        _round(
                            grid,
                            (_pjob(second_route, "LP2", wafer_count),),
                        ),
                        _round(
                            grid * 2,
                            (_pjob(third_route, "LP3", wafer_count),),
                        ),
                    ],
                ))
    return tests


def _clean_tests() -> List[Dict[str, Any]]:
    """生成 PrePJob 与周期 WAC 的单 Job、同路线双 Job 案例。"""
    tests: List[Dict[str, Any]] = []
    for label, route_ref in (
        ("PRE", ROUTE_PRE_CLEAN),
        ("WAC5", ROUTE_WAC_CLEAN),
    ):
        for wafer_count in WAFER_COUNTS:
            tests.append(_test(
                f"CLEAN1-{label}-N{wafer_count}",
                SINGLE_ONE_JOB_CLEAN_GROUP,
                [_round(
                    0,
                    (_pjob(route_ref, "LP1", wafer_count),),
                )],
            ))
            tests.append(_test(
                f"CLEAN2-{label}-N{wafer_count}",
                SINGLE_TWO_JOB_CLEAN_GROUP,
                [_round(
                    0,
                    (
                        _pjob(route_ref, "LP1", wafer_count),
                        _pjob(route_ref, "LP2", wafer_count),
                    ),
                    separate_cjobs=True,
                )],
            ))
    return tests


def _r10_stability_test() -> Dict[str, Any]:
    """生成不复用同一 LoadPort 槽位的八轮嵌套重算稳定性案例。"""
    rounds = [
        _round(
            round_index * 500,
            (_pjob(
                ROUTE_ALL4,
                f"LP{round_index % 4 + 1}",
                3,
            ),),
        )
        for round_index in range(8)
    ]
    return _test("R10-8轮稳定性-N3", "R10", rounds)


def _six_pm_assets() -> List[Dict[str, Any]]:
    """返回六腔设备的长工艺路线、拆分路线和短工艺驻留路线。"""
    return [
        _route(
            ROUTE_FULL6,
            [(("PM1", "PM2", "PM3", "PM4", "PM5", "PM6"), 300)],
        ),
        _route(ROUTE_PAIR12, [(("PM1", "PM2"), 300)]),
        _route(ROUTE_PAIR34, [(("PM3", "PM4"), 300)]),
        _route(ROUTE_PAIR56, [(("PM5", "PM6"), 300)]),
        {
            **_route(
                ROUTE_SHORT6,
                [(("PM1", "PM2", "PM3", "PM4", "PM5", "PM6"), 5)],
                residency=30,
            ),
            "group": LOADLOCK_CADENCE_GROUP,
        },
    ]


def _six_pm_tests() -> List[Dict[str, Any]]:
    """生成单轮严格分解对照和五轮拆分路线长途质量 A/B。"""
    reference_jobs = tuple(
        _pjob(ROUTE_FULL6, f"LP{index}", 25)
        for index in range(1, 4)
    )
    split_jobs = tuple(
        _pjob(route_ref, f"LP{index}", 25)
        for index, route_ref in enumerate(
            (ROUTE_PAIR12, ROUTE_PAIR34, ROUTE_PAIR56),
            start=1,
        )
    )
    tests = [
        _test(
            "6PM-00-原路线Reference-3x25",
            ROUTE_DECOMPOSITION_GROUP,
            [_round(0, reference_jobs, separate_cjobs=True)],
        ),
        _test(
            "6PM-01-拆分3Job-3x25",
            ROUTE_DECOMPOSITION_GROUP,
            [_round(0, split_jobs, separate_cjobs=True)],
        ),
    ]
    for split in (False, True):
        route_refs = (
            (ROUTE_PAIR12, ROUTE_PAIR34, ROUTE_PAIR56)
            if split
            else (ROUTE_FULL6, ROUTE_FULL6, ROUTE_FULL6)
        )
        rounds = [
            _round(
                round_index * SIX_PM_LONG_INTERVAL_SECONDS,
                tuple(
                    _pjob(
                        route_ref,
                        f"LP{job_index}",
                        SIX_PM_LONG_WAFERS_PER_JOB,
                    )
                    for job_index, route_ref in enumerate(route_refs, start=1)
                ),
                separate_cjobs=True,
            )
            for round_index in range(SIX_PM_LONG_ROUNDS)
        ]
        tests.append(_test(
            (
                "Long-01-拆分双腔DUT-5轮"
                if split
                else "Long-00-共享六腔观察项-5轮"
            ),
            LONG_QUALITY_GROUP,
            rounds,
        ))
    cadence_test = _test(
        LOADLOCK_CADENCE_TEST,
        LOADLOCK_CADENCE_GROUP,
        [_round(
            0,
            (
                _pjob(ROUTE_SHORT6, "LP1", 12),
                _pjob(ROUTE_SHORT6, "LP2", 12),
            ),
            separate_cjobs=True,
        )],
    )
    cadence_test["strategy"] = "heuristic"
    cadence_test["options"] = {
        "loadLockManager": "exchange-look",
    }
    tests.append(cadence_test)
    return tests


def _find_or_import_pse300(store_path: Path) -> Dict[str, Any]:
    """返回现有四腔 PSE300；空目录中则从正式 init 导入。"""
    summaries = scheduler_server.list_workspace_devices(store_path)
    existing = next(
        (
            summary
            for summary in summaries
            if str(summary.get("name") or "") == PSE300_PATH.name
        ),
        None,
    )
    if existing is not None:
        return scheduler_server.get_workspace_device(
            str(existing["id"]),
            store_path,
        )
    raw_device = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
    device, _ = scheduler_server.import_workspace_device(
        PSE300_PATH.name,
        raw_device,
        store_path,
    )
    return device


def seed_workspace_matrix(
    store_path: Path = scheduler_server.WORKSPACE_STORE_PATH,
) -> Dict[str, Any]:
    """写入完整验收矩阵，并返回设备、组别和测试数量摘要。"""
    four_device = _find_or_import_pse300(store_path)
    four_device_id = str(four_device["id"])
    _ensure_groups(
        four_device_id,
        (
            LEGACY_R2_GROUP,
            LEGACY_LONG_GROUP,
            SINGLE_TWO_JOB_GROUP,
            R2_THREE_JOB_GROUP,
            SINGLE_ONE_JOB_CLEAN_GROUP,
            SINGLE_TWO_JOB_CLEAN_GROUP,
            "R10",
        ),
        store_path,
    )
    _move_legacy_test(
        four_device_id,
        "q1",
        R2_THREE_JOB_GROUP,
        LEGACY_R2_GROUP,
        store_path,
    )
    _move_legacy_test(
        four_device_id,
        "p1",
        "R10",
        LEGACY_LONG_GROUP,
        store_path,
    )
    new_routes, new_cleans = _four_pm_assets()
    refreshed_four = scheduler_server.get_workspace_device(
        four_device_id,
        store_path,
    )
    merged_routes = _merge_named_assets(
        refreshed_four.get("routes") or [],
        new_routes,
    )
    merged_cleans = _merge_named_assets(
        refreshed_four.get("cleans") or [],
        new_cleans,
    )
    four_tests = [
        *_single_two_job_tests(),
        *_r2_three_job_tests(),
        *_clean_tests(),
        _r10_stability_test(),
    ]
    four_ids = _upsert_tests(
        four_device_id,
        four_tests,
        merged_routes,
        merged_cleans,
        store_path,
    )

    six_device, _ = scheduler_server.import_workspace_device(
        "PSE300-6PM神经验收.json",
        six_pm_device(),
        store_path,
    )
    six_device_id = str(six_device["id"])
    _ensure_groups(
        six_device_id,
        (
            ROUTE_DECOMPOSITION_GROUP,
            LONG_QUALITY_GROUP,
            LOADLOCK_CADENCE_GROUP,
        ),
        store_path,
    )
    refreshed_six = scheduler_server.get_workspace_device(
        six_device_id,
        store_path,
    )
    six_routes = _merge_named_assets(
        refreshed_six.get("routes") or [],
        _six_pm_assets(),
    )
    six_tests = _six_pm_tests()
    six_ids = _upsert_tests(
        six_device_id,
        six_tests,
        six_routes,
        refreshed_six.get("cleans") or [],
        store_path,
    )
    return {
        "fourPmDeviceId": four_device_id,
        "fourPmTestsUpserted": len(four_ids),
        "sixPmDeviceId": six_device_id,
        "sixPmTestsUpserted": len(six_ids),
        "r2ThreeJobCases": len(_r2_three_job_tests()),
        "recomputeGrids": list(RECOMPUTE_GRIDS),
        "waferCounts": list(WAFER_COUNTS),
    }


def main() -> None:
    """解析可选工作区路径并打印幂等生成摘要。"""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--store",
        type=Path,
        default=scheduler_server.WORKSPACE_STORE_PATH,
        help="工作区 JSON 路径；缺省写入实时前端当前数据目录",
    )
    args = parser.parse_args()
    print(
        json.dumps(
            seed_workspace_matrix(args.store),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
