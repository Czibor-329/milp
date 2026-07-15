"""调度终端本地服务的请求展开与多轮重算测试。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from scripts.config_editor_server import BuildState, build_round_update, execute_plan, extract_init_data


ROOT = Path(__file__).resolve().parents[1]
DEVICE_PATH = ROOT / "src" / "input_data" / "s1-1c2p-reschedule.json"


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


if __name__ == "__main__":
    unittest.main()
