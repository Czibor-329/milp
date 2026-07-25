"""神经实时调度前端验收工作区生成器的结构与幂等回归。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from realtime_scheduler import server as scheduler_server
from scripts.seed_neural_recompute_workspaces import (
    LONG_QUALITY_GROUP,
    LOADLOCK_CADENCE_GROUP,
    R2_THREE_JOB_GROUP,
    RECOMPUTE_GRIDS,
    ROUTE_DECOMPOSITION_GROUP,
    SINGLE_ONE_JOB_CLEAN_GROUP,
    SINGLE_TWO_JOB_CLEAN_GROUP,
    SINGLE_TWO_JOB_GROUP,
    WAFER_COUNTS,
    seed_workspace_matrix,
)


class NeuralWorkspaceSeedTests(unittest.TestCase):
    """验证矩阵内容、六腔隔离和重复生成不会累积副本。"""

    def test_seed_builds_complete_idempotent_frontend_matrix(self) -> None:
        """四腔与六腔设备应得到完整测试组，且第二次运行数量不变。"""
        with tempfile.TemporaryDirectory() as directory:
            store_path = Path(directory) / "workspaces.json"
            first_report = seed_workspace_matrix(store_path)
            devices_after_first = scheduler_server.list_workspace_devices(
                store_path
            )
            first_counts = {
                str(device["id"]): int(device["testCount"])
                for device in devices_after_first
            }

            second_report = seed_workspace_matrix(store_path)
            devices_after_second = scheduler_server.list_workspace_devices(
                store_path
            )
            second_counts = {
                str(device["id"]): int(device["testCount"])
                for device in devices_after_second
            }

            self.assertEqual(first_report, second_report)
            self.assertEqual(first_counts, second_counts)
            self.assertEqual(2, len(devices_after_second))

            four_device = scheduler_server.get_workspace_device(
                str(first_report["fourPmDeviceId"]),
                store_path,
            )
            six_device = scheduler_server.get_workspace_device(
                str(first_report["sixPmDeviceId"]),
                store_path,
            )
            self.assertNotIn("PM5", four_device["device"]["Stations"])
            self.assertNotIn("PM6", four_device["device"]["Stations"])
            self.assertTrue(all(
                name in six_device["device"]["Stations"]
                for name in (
                    "PM1",
                    "PM2",
                    "PM3",
                    "PM4",
                    "PM5",
                    "PM6",
                )
            ))
            for arm in six_device["device"]["Robots"]["VTR"]["ArmInfo"].values():
                accessible = set(arm["AccessibleStations"])
                self.assertTrue({"PM5", "PM6"}.issubset(accessible))

            four_group_counts = {
                group: sum(
                    str(test_case.get("group") or "") == group
                    for test_case in four_device["tests"]
                )
                for group in (
                    SINGLE_TWO_JOB_GROUP,
                    R2_THREE_JOB_GROUP,
                    SINGLE_ONE_JOB_CLEAN_GROUP,
                    SINGLE_TWO_JOB_CLEAN_GROUP,
                    "R10",
                )
            }
            self.assertEqual(
                {
                    SINGLE_TWO_JOB_GROUP: 8,
                    R2_THREE_JOB_GROUP: (
                        4 * len(RECOMPUTE_GRIDS) * len(WAFER_COUNTS)
                    ),
                    SINGLE_ONE_JOB_CLEAN_GROUP: 4,
                    SINGLE_TWO_JOB_CLEAN_GROUP: 4,
                    "R10": 1,
                },
                four_group_counts,
            )

            route_names = {
                str(route["name"])
                for route in four_device["routes"]
            }
            for test_case in four_device["tests"]:
                for round_row in test_case.get("rounds") or []:
                    for cjob in round_row.get("cjobs") or []:
                        for pjob in cjob.get("pjobs") or []:
                            self.assertIn(pjob["routeRef"], route_names)
            clean_names = {
                str(clean["name"])
                for clean in four_device["cleans"]
            }
            referenced_cleans = {
                clean_name
                for route in four_device["routes"]
                for clean_name in (
                    route.get("prePJobCleanRefs") or []
                )
            }
            referenced_cleans.update(
                clean_name
                for route in four_device["routes"]
                for stage in route.get("stages") or []
                for visit in stage.get("visits") or []
                for clean_name in visit.get("afterCleanRefs") or []
            )
            self.assertTrue(referenced_cleans)
            self.assertTrue(referenced_cleans.issubset(clean_names))

            r2_cases = [
                test_case
                for test_case in four_device["tests"]
                if test_case.get("group") == R2_THREE_JOB_GROUP
            ]
            self.assertTrue(all(
                int(test_case["roundCount"]) == 3
                and len(test_case["rounds"]) == 3
                for test_case in r2_cases
            ))
            observed_grids = {
                int(test_case["times"][1])
                for test_case in r2_cases
            }
            observed_counts = {
                int(test_case["rounds"][0]["cjobs"][0]["pjobs"][0]["waferCount"])
                for test_case in r2_cases
            }
            self.assertEqual(set(RECOMPUTE_GRIDS), observed_grids)
            self.assertEqual(set(WAFER_COUNTS), observed_counts)
            self.assertTrue(all(
                float(test_case["times"][2])
                == float(test_case["times"][1]) * 2.0
                for test_case in r2_cases
            ))

            six_group_counts = {
                group: sum(
                    str(test_case.get("group") or "") == group
                    for test_case in six_device["tests"]
                )
                for group in (
                    ROUTE_DECOMPOSITION_GROUP,
                    LONG_QUALITY_GROUP,
                    LOADLOCK_CADENCE_GROUP,
                )
            }
            self.assertEqual(
                {
                    ROUTE_DECOMPOSITION_GROUP: 2,
                    LONG_QUALITY_GROUP: 2,
                    LOADLOCK_CADENCE_GROUP: 1,
                },
                six_group_counts,
            )


if __name__ == "__main__":
    unittest.main()
