"""调度终端本地服务的请求展开与多轮重算测试。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import realtime_scheduler.server as config_server
from scripts.config_editor_server import (
    BuildState,
    LoggedPlanError,
    build_round_update,
    build_route,
    create_workspace_test,
    delete_workspace_test,
    execute_plan,
    extract_init_data,
    get_workspace_device,
    import_workspace_device,
    list_workspace_devices,
    update_workspace_test,
)
from scripts.replay_config_log import load_plan_from_log


ROOT = Path(__file__).resolve().parents[1]
DEVICE_PATH = ROOT / "src" / "input_data" / "s1-1c2p-reschedule.json"
PSE300_PATH = ROOT / "src" / "input_data" / "PSE300.json"
EDITOR_PATH = ROOT / "realtime_scheduler" / "frontend" / "config_editor.html"


def _device_recording() -> list[dict]:
    """读取包含 AlgInit 的项目内实时重算小设备案例。"""
    return json.loads(DEVICE_PATH.read_text(encoding="utf-8"))


def _route(name: str, modules: str, recipe: str) -> dict:
    """创建测试用的完整源—加工—汇 Route。"""
    return {
        "name": name,
        "group": name,
        "bufferOption": 0,
        "prePJobCleanRefs": [],
        "postPJobCleanRefs": [],
        "postCJobCleanRefs": [],
        "stages": [
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": modules, "recipeRef": recipe, "slots": "1"},
            {"stations": "VTR", "recipeRef": "", "slots": "1"},
            {"stations": "LA,LB", "recipeRef": "", "slots": "1"},
            {"stations": "ATR", "recipeRef": "", "slots": "1"},
            {"stations": "LP1", "recipeRef": "", "slots": "1"},
        ],
    }


def _job(name: str, route: str, load_port: str) -> dict:
    """创建测试用单片 Job。"""
    return {
        "name": name,
        "routeRef": route,
        "loadPort": load_port,
        "waferCount": 1,
        "priority": 1,
        "weight": 1,
        "jobType": 0,
        "taskMode": 0,
        "foupId": name,
    }


class ConfigEditorServerTests(unittest.TestCase):
    """验证设备选择、Route 引用和两次重算的统一输出。"""

    def setUp(self) -> None:
        """为每个案例提取同一份设备拓扑。"""
        self.recording = _device_recording()
        self.device = extract_init_data(self.recording)

    def test_extract_init_data_from_recording(self) -> None:
        """input_data 录制数组应只提取 AlgInit 的设备字段。"""
        self.assertIn("Stations", self.device)
        self.assertIn("Robots", self.device)
        self.assertIn("PM1", self.device["Stations"])
        self.assertIn("LP1", self.device["Stations"])

    def test_job_route_is_bound_to_selected_load_port(self) -> None:
        """Job 复用公共 Route 时应生成独立 Route 并改写首尾 LoadPort。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        update = build_round_update(
            plan,
            {"jobs": [_job("Incoming", "Route12", "LP3")]},
            10.0,
            BuildState(),
        )
        runtime_route = update["Routes"]["Route12__Incoming"]
        self.assertEqual("LP3", runtime_route["RouteSteps"][0]["Visits"][0]["StationName"])
        self.assertEqual("LP3", runtime_route["RouteSteps"][-1]["Visits"][0]["StationName"])
        self.assertEqual("Route12__Incoming", update["ProcessJobs"][0]["OriginRoute"]["Name"])

    def test_round_supports_multiple_cjobs_and_pjobs(self) -> None:
        """同一轮多个 CJob 应共享轮次 TaskID，并正确派生 PJobNameList 和枚举。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        round_config = {
            "currentTime": 70,
            "cjobs": [
                {
                    "taskId": "2", "jobType": "NormalLot", "priority": 3, "taskMode": "Smart",
                    "pjobs": [
                        {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 2, "priority": 1},
                        {"jobName": "P2", "routeRef": "Route12", "loadPort": "LP2", "waferCount": 1, "priority": 2},
                    ],
                },
                {
                    "taskId": "2", "jobType": "HighestLot", "priority": 99, "taskMode": "Concurrent",
                    "pjobs": [{"jobName": "P1", "routeRef": "Route12", "loadPort": "LP3", "waferCount": 1}],
                },
            ],
        }
        update = build_round_update(plan, round_config, 70.0, BuildState())
        self.assertEqual(2, len(update["ControlJobs"]))
        self.assertEqual(3, len(update["ProcessJobs"]))
        self.assertEqual(["2", "2"], [item["TaskID"] for item in update["ControlJobs"]])
        self.assertEqual(["2.C1.P1", "2.C1.P2"], update["ControlJobs"][0]["PJobNameList"])
        self.assertEqual(["2.C2.P1"], update["ControlJobs"][1]["PJobNameList"])
        self.assertEqual(3, update["ControlJobs"][0]["Priority"])
        self.assertEqual(-1, update["ControlJobs"][1]["Priority"])
        self.assertEqual(2, update["ControlJobs"][1]["JobType"])
        self.assertEqual(3, update["ControlJobs"][1]["TaskMode"])
        self.assertEqual([1, 2], update["ProcessJobs"][0]["MatList"])
        self.assertTrue(all("Weight" not in pjob for pjob in update["ProcessJobs"]))

    def test_same_cjob_pjobs_use_continuous_material_ids_and_load_port_slots(self) -> None:
        """同一 CJob 的第二个 PJob 应接续前一个 PJob 的物料编号和 LoadPort 槽位。"""
        plan = {
            "device": self.device,
            "recipes": [{"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
        }
        update = build_round_update(plan, {"cjobs": [{"taskId": "1", "pjobs": [
            {"jobName": "P1", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 5},
            {"jobName": "P2", "routeRef": "Route12", "loadPort": "LP1", "waferCount": 5},
        ]}]}, 0.0, BuildState())
        self.assertEqual(list(range(1, 6)), update["ProcessJobs"][0]["MatList"])
        self.assertEqual(list(range(6, 11)), update["ProcessJobs"][1]["MatList"])
        self.assertEqual(list(range(1, 11)), [material["SlotID"] for material in update["Materials"]])

    def test_route_step_and_visit_fields_are_preserved(self) -> None:
        """显式 StepID/PostStepID/NeedProcess 和 IVisit 字段应进入标准 Route。"""
        route = {
            "name": "ExplicitRoute",
            "group": "ExplicitRoute",
            "stages": [
                {"stepId": 10, "postStepIds": [20], "needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
                {"stepId": 20, "postStepIds": [30], "needProcess": False, "visits": [{"stationName": "ATR", "slotIds": "1"}]},
                {"stepId": 30, "postStepIds": [40], "needProcess": True, "visits": [{
                    "stationName": "PM1",
                    "slotIds": "1,2",
                    "processRecipe": "R1",
                    "moveTimeOffset": {"2": 1.5},
                    "qTimeLimit": 12,
                    "residencyConstraint": 34,
                }]},
                {"stepId": 40, "postStepIds": [50], "needProcess": False, "visits": [{"stationName": "ATR", "slotIds": "1"}]},
                {"stepId": 50, "postStepIds": [], "needProcess": False, "visits": [{"stationName": "LP1", "slotIds": "1"}]},
            ],
        }
        built = build_route(route, {"R1": {"name": "R1"}}, {}, {"ATR"})
        process_step = built["RouteSteps"][2]
        process_visit = process_step["Visits"][0]
        self.assertEqual(30, process_step["StepID"])
        self.assertEqual([40], process_step["PostStepID"])
        self.assertTrue(process_step["NeedProcess"])
        self.assertEqual("PM1", process_visit["StationName"])
        self.assertEqual([1, 2], process_visit["SlotID"])
        self.assertEqual("R1", process_visit["ProcessRecipe"])
        self.assertEqual({"2": 1.5}, process_visit["MoveTimeOffset"])
        self.assertEqual(12, process_visit["QTimeLimit"])
        self.assertEqual(34, process_visit["ResidencyConstraint"])

    def test_editor_uses_persistent_route_table_and_step_drawer(self) -> None:
        """Route 应使用候选设备列表和自动保存，抽屉只编辑简化的工艺时间表。"""
        html = EDITOR_PATH.read_text(encoding="utf-8")
        self.assertIn('data-tab-target="schedule"', html)
        self.assertIn('data-tab-target="route"', html)
        self.assertIn('data-tab-target="clean"', html)
        self.assertIn('id="stepDrawer"', html)
        self.assertIn('class="route-table"', html)
        self.assertIn('data-scope="stage-candidate-toggle"', html)
        self.assertIn('class="visit-groups"', html)
        self.assertIn("Step 概要", html)
        self.assertIn("工艺信息", html)
        self.assertIn("约束信息", html)
        for field in ("ProcessTime", "Recipe", "ProcessType", "Weight", "MoveTimeOffset", "SlotID", "QTime", "Residency"):
            self.assertIn(field, html)
        self.assertIn("width: clamp(720px, 66vw, 980px)", html)
        self.assertIn("scheduleAutoSave", html)
        self.assertIn('window.addEventListener("pagehide"', html)
        self.assertIn("StepID", html)
        self.assertIn("PostStepID", html)
        self.assertIn("NeedProcess", html)
        self.assertIn('data-scope="visit"', html)
        self.assertIn("state.stationNames", html)
        self.assertIn('id="autoExportLog"', html)
        self.assertIn('id="logButton"', html)
        self.assertIn('id="deviceSelect"', html)
        self.assertIn('id="testCaseSelect"', html)
        self.assertIn('id="copyTestButton"', html)
        self.assertIn('id="saveTestButton"', html)
        self.assertIn("saveCurrentTest(true)", html)
        self.assertIn('data-action="add-cjob"', html)
        self.assertIn('data-action="add-pjob"', html)
        self.assertIn('data-scope="cjob"', html)
        self.assertIn('data-scope="pjob"', html)
        self.assertIn("PJobNameList", html)
        self.assertIn("重算轮次 → CJob → PJob", html)
        self.assertNotIn("<th>FoupID</th>", html)
        self.assertNotIn("<th>Weight</th>", html)
        self.assertIn("$ 运行失败：${error.message", html)
        self.assertIn("EXPECTED_API_SCHEMA", html)
        self.assertIn("失败也会生成", html)
        self.assertNotIn('id="recipeList"', html)

    def test_device_workspace_persists_independent_test_cases(self) -> None:
        """同一设备的多套 Route/Clean/重算配置应独立保存并可复制、修改、删除。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, created = import_workspace_device("device-a.json", self.recording, store_path)
            duplicate, duplicate_created = import_workspace_device("renamed.json", self.device, store_path)
            self.assertTrue(created)
            self.assertFalse(duplicate_created)
            self.assertEqual(device["id"], duplicate["id"])
            self.assertEqual("renamed.json", duplicate["name"])

            base = {
                "name": "基础案例",
                "strategy": "heuristic",
                "roundCount": 1,
                "times": [0],
                "options": {},
                "cleans": [{"name": "CleanA"}],
                "routes": [{"name": "RouteA"}],
                "rounds": [{"jobs": [{"name": "Initial"}]}],
            }
            first = create_workspace_test(device["id"], base, store_path)
            second = create_workspace_test(device["id"], {**base, "name": "复制案例"}, store_path)
            updated_second = update_workspace_test(device["id"], second["id"], {
                **base,
                "name": "复制案例-PM34",
                "routes": [{"name": "RoutePM34"}],
                "roundCount": 2,
                "times": [0, 100],
                "rounds": [{"jobs": []}, {"jobs": [{"name": "Added"}]}],
            }, store_path)

            loaded = get_workspace_device(device["id"], store_path)
            self.assertEqual(2, len(loaded["tests"]))
            self.assertEqual([{"name": "RoutePM34"}], loaded["routes"])
            self.assertEqual([{"name": "CleanA"}], loaded["cleans"])
            self.assertTrue(all("routes" not in item and "cleans" not in item for item in loaded["tests"]))
            self.assertNotIn("routes", updated_second)
            self.assertEqual(2, updated_second["roundCount"])
            migrated = updated_second["rounds"][1]["cjobs"][0]
            self.assertEqual("2", migrated["taskId"])
            self.assertEqual(["P1"], migrated["pJobNameList"])
            self.assertNotIn("foupId", migrated["pjobs"][0])
            self.assertNotIn("weight", migrated["pjobs"][0])
            self.assertEqual(2, list_workspace_devices(store_path)[0]["testCount"])

            delete_workspace_test(device["id"], first["id"], store_path)
            remaining = get_workspace_device(device["id"], store_path)["tests"]
            self.assertEqual([second["id"]], [item["id"] for item in remaining])
            with self.assertRaises(ValueError):
                delete_workspace_test(device["id"], second["id"], store_path)

    def test_legacy_test_routes_merge_into_shared_device_library(self) -> None:
        """Test3 有两条 Route、Test4 仅一条时，迁移后两者应使用设备的两条共享 Route。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            legacy = {
                "version": 1,
                "devices": [{
                    "id": "device-1", "name": "PSE300.json", "device": self.device,
                    "tests": [
                        {"id": "test3", "name": "Test3", "updatedAt": "2026-01-01T00:00:00+08:00",
                         "routes": [{"name": "R1"}, {"name": "R2"}], "cleans": [{"name": "C1"}]},
                        {"id": "test4", "name": "Test4", "updatedAt": "2026-01-02T00:00:00+08:00",
                         "routes": [{"name": "R1"}], "cleans": []},
                    ],
                }],
            }
            store_path.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")

            loaded = get_workspace_device("device-1", store_path)

            self.assertEqual(["R1", "R2"], [route["name"] for route in loaded["routes"]])
            self.assertEqual(["C1"], [clean["name"] for clean in loaded["cleans"]])
            self.assertTrue(all("routes" not in test and "cleans" not in test for test in loaded["tests"]))
            migrated = json.loads(store_path.read_text(encoding="utf-8"))
            self.assertEqual(2, migrated["version"])

    def test_nested_rounds_persist_without_reordering(self) -> None:
        """多轮、多 CJob/PJob 保存后重新读取，应保留时间与归属并重算只读字段。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            device, _ = import_workspace_device("device.json", self.device, store_path)
            nested = {
                "name": "三级结构", "strategy": "heuristic", "roundCount": 3,
                "times": [0, 70, 160], "options": {}, "cleans": [], "routes": [{"name": "Route12"}],
                "rounds": [
                    {"currentTime": 0, "cjobs": [{"pjobs": [{"routeRef": "Route12", "loadPort": "LP1", "waferCount": 2}]}]},
                    {"currentTime": 70, "cjobs": [
                        {"jobType": "NormalLot", "priority": 2, "pjobs": [
                            {"routeRef": "Route12", "loadPort": "LP2", "waferCount": 3},
                            {"routeRef": "Route12", "loadPort": "LP3", "waferCount": 1},
                        ]},
                        {"jobType": "HigherLot", "priority": 8, "taskMode": "Sequential", "pjobs": [
                            {"routeRef": "Route12", "loadPort": "LP4", "waferCount": 4},
                        ]},
                    ]},
                    {"currentTime": 160, "cjobs": [{"pjobs": [{"routeRef": "Route12", "loadPort": "LP1", "waferCount": 1}]}]},
                ],
            }
            created = create_workspace_test(device["id"], nested, store_path)
            loaded = get_workspace_device(device["id"], store_path)["tests"][0]
            self.assertEqual([0.0, 70.0, 160.0], loaded["times"])
            self.assertEqual(created["id"], loaded["id"])
            second = loaded["rounds"][1]
            self.assertEqual(2, len(second["cjobs"]))
            self.assertEqual(["2", "2"], [item["taskId"] for item in second["cjobs"]])
            self.assertEqual(["P1", "P2"], second["cjobs"][0]["pJobNameList"])
            self.assertEqual([3, 4, 5], second["cjobs"][0]["pjobs"][0]["matList"])
            self.assertEqual([6], second["cjobs"][0]["pjobs"][1]["matList"])
            self.assertEqual([7, 8, 9, 10], second["cjobs"][1]["pjobs"][0]["matList"])
            self.assertEqual(-1, second["cjobs"][1]["priority"])
            self.assertEqual("Sequential", second["cjobs"][1]["taskMode"])

    def test_test3_nested_jobs_run_successfully(self) -> None:
        """test3 形状的两轮、首轮双 PJob 配置应完成真实重算。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 2,
            "options": {},
            "recipes": [{"name": "R1", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("R1", "PM1,PM2", "R1")],
            "rounds": [
                {"currentTime": 0, "cjobs": [{"taskId": "1", "jobType": "NormalLot", "priority": 1, "taskMode": "Smart", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP1", "waferCount": 5, "priority": 1},
                    {"jobName": "P2", "routeRef": "R1", "loadPort": "LP1", "waferCount": 5, "priority": 1},
                ]}]},
                {"currentTime": 500, "cjobs": [{"taskId": "2", "jobType": "NormalLot", "priority": 1, "taskMode": "Smart", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP2", "waferCount": 5, "priority": 1},
                ]}]},
            ],
        }
        result = execute_plan(plan)
        self.assertTrue(result["ok"])
        self.assertEqual("passed", result["validation"])
        self.assertEqual(2, len(result["rounds"]))
        self.assertEqual(3, sum(round_row["jobCount"] for round_row in result["rounds"]))

    def test_recompute_balances_loadlocks_and_starts_with_earlier_released_pm(self) -> None:
        """上一轮最后使用 PM1 时，下一轮应从更早释放的 PM2 开始并同时使用 LA/LB。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 2,
            "options": {},
            "recipes": [{"name": "R1", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("R1", "PM1,PM2", "R1")],
            "rounds": [
                {"currentTime": 0, "cjobs": [{"taskId": "1", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP1", "waferCount": 3},
                    {"jobName": "P2", "routeRef": "R1", "loadPort": "LP1", "waferCount": 2},
                ]}]},
                {"currentTime": 500, "cjobs": [{"taskId": "2", "pjobs": [
                    {"jobName": "P1", "routeRef": "R1", "loadPort": "LP2", "waferCount": 5},
                ]}]},
            ],
        }

        result = execute_plan(plan)
        process_moves = [
            move for move in result["output"]["MoveList"]
            if move.get("MoveType") == 9 and move.get("MatIDList")
        ]
        last_initial = max(
            (move for move in process_moves if "1.C1.P2" in (move.get("PJobName") or [])),
            key=lambda move: float(move["EndTime"]),
        )
        first_added = min(
            (move for move in process_moves if "2.C1.P1" in (move.get("PJobName") or [])),
            key=lambda move: float(move["StartTime"]),
        )
        added_loadlocks = {
            move.get("ModuleName")
            for move in result["output"]["MoveList"]
            if "2.C1.P1" in (move.get("PJobName") or [])
            and move.get("ModuleName") in {"LA", "LB"}
        }

        self.assertEqual("PM1", last_initial["ModuleName"])
        self.assertEqual("PM2", first_added["ModuleName"])
        self.assertEqual({"LA", "LB"}, added_loadlocks)

    def test_pse300_arbitrary_recompute_waits_for_first_safe_time(self) -> None:
        """PSE300 任意时刻请求应保留旧 Move 到安全点，新 Move 从实际安全时间开始。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        initial_job = _job("InitialJob", "Route12", "LP1")
        initial_job["waferCount"] = 5
        added_job = _job("AddedJob1", "Route12", "LP2")
        added_job["waferCount"] = 5
        pending_job = _job("AddedJob2", "Route12", "LP3")
        pending_job["waferCount"] = 5
        plan = {
            "deviceName": PSE300_PATH.name,
            "device": pse300,
            "strategy": "heuristic",
            "roundCount": 3,
            "options": {},
            "recipes": [{"name": "R12", "time": 20, "modules": "PM1,PM2", "weight": {}}],
            "cleans": [],
            "routes": [_route("Route12", "PM1,PM2", "R12")],
            "rounds": [
                {"currentTime": 0, "jobs": [initial_job]},
                {"currentTime": 100, "jobs": [added_job]},
                {"currentTime": 200, "jobs": [pending_job]},
            ],
        }
        result = execute_plan(plan)
        self.assertTrue(result["ok"])
        self.assertEqual(3, len(result["rounds"]))
        effective_time = result["rounds"][1]["effectiveTime"]
        self.assertGreater(effective_time, 100.0)
        self.assertAlmostEqual(result["rounds"][0]["segmentEnd"], effective_time)
        self.assertEqual(effective_time, result["rounds"][2]["effectiveTime"])
        points = result["output"]["RecomputePoints"]
        point = points[0]
        self.assertEqual(100.0, point["Time"])
        self.assertEqual(effective_time, point["EffectiveTime"])
        self.assertEqual(200.0, points[1]["Time"])
        self.assertEqual(effective_time, points[1]["EffectiveTime"])

        first_output = next(
            entry["Info"] for entry in result["reproductionLog"]
            if entry["Describe"] == "AlgOutput"
        )
        initial_move_ids = {int(move["MoveID"]) for move in first_output["MoveList"]}
        final_moves = result["output"]["MoveList"]
        self.assertTrue(any(
            int(move["MoveID"]) in initial_move_ids
            and 100.0 <= float(move["StartTime"]) < effective_time
            for move in final_moves
        ))
        self.assertTrue(all(
            float(move["StartTime"]) >= effective_time - 1e-6
            for move in final_moves
            if int(move["MoveID"]) not in initial_move_ids
        ))

    def test_pse300_numeric_format_reuses_and_renames_existing_device(self) -> None:
        """仅 0/0.0 表示不同的提取版 init 应复用测试集并采用 PSE300 文件名。"""
        pse300 = json.loads(PSE300_PATH.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            original, created = import_workspace_device("legacy-recording.json", self.recording, store_path)
            renamed, renamed_created = import_workspace_device(PSE300_PATH.name, pse300, store_path)
            self.assertTrue(created)
            self.assertFalse(renamed_created)
            self.assertEqual(original["id"], renamed["id"])
            self.assertEqual(PSE300_PATH.name, renamed["name"])

    def test_failed_plan_keeps_input_data_reproduction_log(self) -> None:
        """后端校验失败时也应携带可重新提交的完整 Input 日志。"""
        plan = {"deviceName": "missing.json", "device": None, "roundCount": 1, "rounds": []}
        with self.assertRaises(LoggedPlanError) as context:
            execute_plan(plan)
        entries = context.exception.reproduction_log
        self.assertGreaterEqual(len(entries), 2)
        self.assertEqual("Input", entries[0]["Describe"])
        self.assertEqual(plan, load_plan_from_log(entries))
        self.assertEqual("AlgOutput", entries[-1]["Describe"])
        self.assertEqual("Error", entries[-1]["Info"]["Feedback"][0]["Level"])
        for entry in entries:
            self.assertEqual({"Time", "Describe", "SimTime", "Info"}, set(entry))
        with self.assertRaises(LoggedPlanError):
            execute_plan(load_plan_from_log(entries))

    def test_results_and_reproduction_logs_survive_memory_cache_reset(self) -> None:
        """甘特图结果与复现日志应写入专用目录，服务内存清空后仍可读取。"""
        with tempfile.TemporaryDirectory() as directory:
            export_root = Path(directory)
            with (
                patch.object(config_server, "RESULT_EXPORT_DIR", export_root / "results"),
                patch.object(config_server, "LOG_EXPORT_DIR", export_root / "logs"),
            ):
                result_id = config_server.save_result({"MoveList": [], "RecomputePoints": []})
                log_id = config_server.save_reproduction_log([{"Describe": "Input", "Info": {}}])
                config_server._RESULTS.clear()
                config_server._REPRODUCTION_LOGS.clear()

                self.assertEqual([], config_server.read_result(result_id)["MoveList"])
                self.assertEqual("Input", config_server.read_reproduction_log(log_id)[0]["Describe"])
                self.assertTrue((export_root / "results" / f"{result_id}.json").is_file())
                self.assertTrue((export_root / "logs" / f"{log_id}.json").is_file())

    def test_two_recomputes_merge_movelist_and_markers(self) -> None:
        """首次排程加两次重算应合并 MoveList，并保留两条重算线。"""
        plan = {
            "deviceName": DEVICE_PATH.name,
            "device": self.recording,
            "strategy": "heuristic",
            "roundCount": 3,
            "options": {},
            "recipes": [
                {"name": "R12", "time": 8, "modules": "PM1,PM2", "weight": {}},
                {"name": "R34", "time": 8, "modules": "PM3,PM4", "weight": {}},
            ],
            "cleans": [],
            "routes": [
                _route("Route12", "PM1,PM2", "R12"),
                _route("Route34", "PM3,PM4", "R34"),
            ],
            "rounds": [
                {"currentTime": 0, "jobs": [_job("Initial", "Route12", "LP1")]},
                {"currentTime": 1000, "jobs": [_job("FirstRecompute", "Route12", "LP2")]},
                {"currentTime": 2000, "jobs": [_job("SecondRecompute", "Route34", "LP3")]},
            ],
        }
        result = execute_plan(plan)
        output = result["output"]
        self.assertTrue(result["ok"])
        self.assertEqual(3, len(result["rounds"]))
        self.assertEqual([1000.0, 2000.0], [item["Time"] for item in output["RecomputePoints"]])
        self.assertGreater(len(output["MoveList"]), 0)
        reproduction = result["reproductionLog"]
        descriptions = [entry["Describe"] for entry in reproduction]
        self.assertEqual("Input", descriptions[0])
        self.assertEqual(1, descriptions.count("AlgInit"))
        self.assertEqual(3, descriptions.count("AlgSchedule"))
        self.assertEqual(3, descriptions.count("AlgOutput"))
        self.assertEqual(2, descriptions.count("RecomputeControl"))
        self.assertIn("AlgUpdateMove", descriptions)
        self.assertTrue(all(set(entry) == {"Time", "Describe", "SimTime", "Info"} for entry in reproduction))


if __name__ == "__main__":
    unittest.main()
