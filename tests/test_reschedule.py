"""实时重算、旧计划截断和甘特图重算标记的回归测试。"""

import unittest
from pathlib import Path

import scripts.reschedule as demo
from src.reschedule import RealtimeRescheduler


ROOT = Path(__file__).resolve().parents[1]


class RealtimeRescheduleTests(unittest.TestCase):
    """覆盖用户要求的一个两次重算案例和查看器标记。"""

    def test_two_recomputes_use_requested_process_modules(self) -> None:
        """两次新增任务应分别经过 PM1/PM2 和 PM3/PM4，并输出两个重算点。"""
        output = demo.build_two_recompute_case()
        self.assertEqual(len(output["RecomputePoints"]), 2)
        self.assertLess(output["RecomputePoints"][0]["Time"], output["RecomputePoints"][1]["Time"])
        move_ids = [move["MoveID"] for move in output["MoveList"]]
        self.assertEqual(len(move_ids), len(set(move_ids)))

        modules_by_job = {}
        for pjob_name in ("2.P1-1", "3.P1-1"):
            modules_by_job[pjob_name] = {
                move["ModuleName"]
                for move in output["MoveList"]
                if move.get("MoveType") == 9
                and move.get("MatIDList")
                and pjob_name in (move.get("PJobName") or [])
            }
        self.assertEqual(modules_by_job["2.P1-1"], {"PM1", "PM2"})
        self.assertEqual(modules_by_job["3.P1-1"], {"PM3", "PM4"})

    def test_recompute_discards_unstarted_old_moves(self) -> None:
        """切点及其后的旧 MoveID 不得出现在拼接后的有效 MoveList。"""
        tool_topo, _ = demo.load_alg_entries(demo.DEFAULT_INPUT)
        initial_job = demo._job(0, ["PM1"], 24)
        new_job = demo._job(1, ["PM1", "PM2"], 28)
        scheduler = RealtimeRescheduler(tool_topo, demo._update(initial_job, 1, "LP1", 1, 0.0))
        cut_time = demo._find_stable_cut(scheduler, "1.P1-1")
        cancelled_ids = {
            move["MoveID"] for move in scheduler.current_plan
            if float(move["StartTime"]) >= cut_time - demo.TIME_TOLERANCE
        }

        demo._notify_until(scheduler, cut_time)
        output = scheduler.recompute(demo._update(new_job, 2, "LP2", 101, cut_time), cut_time)
        output_ids = {move["MoveID"] for move in output["MoveList"]}
        self.assertTrue(cancelled_ids)
        self.assertTrue(cancelled_ids.isdisjoint(output_ids))

    def test_viewer_reads_and_draws_recompute_points(self) -> None:
        """查看器应解析 RecomputePoints 并渲染重算竖线。"""
        viewer = (ROOT / "movelist_gantt_viewer.html").read_text(encoding="utf-8")
        self.assertIn("payload.RecomputePoints", viewer)
        self.assertIn('class="recompute-marker"', viewer)
        self.assertIn('stroke="#dc2626"', viewer)


if __name__ == "__main__":
    unittest.main()
