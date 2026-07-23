"""PSE300 L2D 的配置、动态图、安全动作、PPO 与端到端验收测试。"""

from __future__ import annotations

import random
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import torch

from src.export.export import check_solution, export_movelist
from src.schedule.l2d.api import load_l2d_policy, save_l2d_checkpoint, start_schedule_l2d
from src.schedule.l2d.graph import (
    FEATURE_DIMENSION,
    LEGACY_FEATURE_DIMENSION,
    LEGACY_FEATURE_VERSION,
    build_graph_observation,
)
from src.schedule.l2d.model import L2DNetworkConfig, L2DPolicy
from src.schedule.l2d.problems import (
    PM_ORDER,
    candidate_pool_configurations,
    enumerate_increasing_paths,
    load_pse300_topology,
    random_labeled_pm_partition,
    sample_one_job_problem,
    sample_two_job_problem,
)
from src.schedule.l2d.train import PPOConfig, collect_episode, ppo_update
from src.parse.generator import JobSpec, build_update_params, job_process_recipes
from src.parse.model import Durations
from src.parse import PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN, parse_task
from src.schedule.sequencing import (
    decode_orders,
)
from src.validation import validate_move_list


def _problem_with_full_candidate_pools(stage_count: int, wafer_count: int):
    """构造每道工序均可使用 PM1–PM4 的确定性测试 Problem。"""
    rng = random.Random(11 + stage_count)
    job = JobSpec(
        0,
        rng,
        pm_pool=PM_ORDER,
        stage_range=(stage_count, stage_count),
        clean=False,
    )
    job.stages = [list(PM_ORDER) for _ in range(stage_count)]
    job.proc_times = [40 + 10 * index for index in range(stage_count)]
    job.n_wafer = wafer_count
    update_params, _ = build_update_params(
        job,
        key=1,
        priority=1,
        lp="LP1",
        mat_id_start=0,
        current_time=0.0,
        process_recipes=job_process_recipes(job, 1),
    )
    return parse_task(
        load_pse300_topology(),
        update_params,
        process_assignment=PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN,
        process_pm_order=PM_ORDER,
    )


class L2DConfigurationTests(unittest.TestCase):
    """验证候选池、无环实际路径和双 Job PM 分区。"""

    def test_one_stage_has_exactly_four_prefix_configurations(self):
        configurations = candidate_pool_configurations(1)
        self.assertEqual(
            configurations,
            [
                (("PM1",),),
                (("PM1", "PM2"),),
                (("PM1", "PM2", "PM3"),),
                (("PM1", "PM2", "PM3", "PM4"),),
            ],
        )

    def test_multi_stage_cartesian_configurations_are_filtered(self):
        for stage_count in (2, 3):
            configurations = candidate_pool_configurations(stage_count)
            self.assertTrue(configurations)
            for configuration in configurations:
                paths = enumerate_increasing_paths(configuration)
                self.assertTrue(paths)
                self.assertTrue(all(len(set(path)) == stage_count for path in paths))
        self.assertNotIn((("PM1",), ("PM1",)), candidate_pool_configurations(2))

    def test_round_robin_uses_only_increasing_non_reentrant_paths(self):
        problem = _problem_with_full_candidate_pools(stage_count=2, wafer_count=12)
        actual_paths = [
            tuple(stage.chamber for stage in wafer.stages if stage.stage_type == "process")
            for wafer in problem.wafers
        ]
        expected_cycle = [
            ("PM1", "PM2"),
            ("PM1", "PM3"),
            ("PM1", "PM4"),
            ("PM2", "PM3"),
            ("PM2", "PM4"),
            ("PM3", "PM4"),
        ]
        self.assertEqual(actual_paths, expected_cycle * 2)

        three_stage = _problem_with_full_candidate_pools(stage_count=3, wafer_count=8)
        three_paths = [
            tuple(stage.chamber for stage in wafer.stages if stage.stage_type == "process")
            for wafer in three_stage.wafers
        ]
        self.assertEqual(
            three_paths[:4],
            [
                ("PM1", "PM2", "PM3"),
                ("PM1", "PM2", "PM4"),
                ("PM1", "PM3", "PM4"),
                ("PM2", "PM3", "PM4"),
            ],
        )
        self.assertTrue(all(len(path) == len(set(path)) for path in three_paths))

    def test_parser_reports_route_and_pools_when_no_path_exists(self):
        rng = random.Random(19)
        job = JobSpec(
            0, rng, pm_pool=PM_ORDER, stage_range=(2, 2), clean=False
        )
        job.stages = [["PM1"], ["PM1"]]
        job.proc_times = [40, 50]
        job.n_wafer = 1
        update_params, _ = build_update_params(
            job,
            key=1,
            priority=1,
            lp="LP1",
            mat_id_start=0,
            current_time=0.0,
            process_recipes=job_process_recipes(job, 1),
        )
        with self.assertRaisesRegex(ValueError, r"Route .*候选池"):
            parse_task(
                load_pse300_topology(),
                update_params,
                process_assignment=PROCESS_ASSIGNMENT_ACYCLIC_ROUND_ROBIN,
                process_pm_order=PM_ORDER,
            )

    def test_random_partitions_are_complete_disjoint_and_nonempty(self):
        rng = random.Random(23)
        for _sample in range(100):
            first, second = random_labeled_pm_partition(rng)
            self.assertTrue(first)
            self.assertTrue(second)
            self.assertFalse(set(first) & set(second))
            self.assertEqual(set(first) | set(second), set(PM_ORDER))

    def test_two_job_stage_count_respects_owned_pm_count(self):
        problem = sample_two_job_problem(load_pse300_topology(), random.Random(31))
        generation = problem._l2d_generation
        for pool, stage_count in zip(
            generation["pm_partition"], generation["stage_counts"]
        ):
            self.assertLessEqual(stage_count, len(pool))


class L2DGraphAndPolicyTests(unittest.TestCase):
    """验证动态析取边、安全候选提交一致性和变长模型。"""

    def test_dynamic_edges_and_safe_actions_match_committed_orders(self):
        problem = _problem_with_full_candidate_pools(stage_count=2, wafer_count=5)
        durations = Durations(problem)
        graph_edge_counts = []
        chosen_by_robot = {}
        observed_history = []

        def chooser(state, candidates):
            observation = build_graph_observation(state, candidates)
            graph_edge_counts.append(int(observation.adjacency.sum().item()))
            observed_history.append(state.robot_orders)
            selected = candidates[0]
            chosen_by_robot.setdefault(selected.rob, []).append((selected.wid, selected.j))
            return list(range(len(candidates)))

        orders = decode_orders(problem, durations, problem.wafers, chooser=chooser)
        self.assertEqual(chosen_by_robot, orders.robots)
        self.assertGreater(max(graph_edge_counts), min(graph_edge_counts))
        with self.assertRaises(TypeError):
            observed_history[-1]["VTR"] = ()

    def test_model_supports_one_to_three_stages_and_two_jobs(self):
        policy = L2DPolicy()
        topology = load_pse300_topology()
        problems = [
            sample_one_job_problem(topology, random.Random(stage), wafer_count=5, stage_count=stage)
            for stage in (1, 2, 3)
        ]
        problems.append(sample_two_job_problem(topology, random.Random(42)))
        for problem in problems:
            captured = []

            def chooser(state, candidates):
                observation = build_graph_observation(state, candidates)
                distribution, value = policy.distribution_and_value(observation)
                captured.append((distribution.probs.shape[0], value.ndim))
                return list(range(len(candidates)))

            decode_orders(problem, Durations(problem), problem.wafers, chooser=chooser)
            self.assertTrue(captured)
            self.assertTrue(all(count >= 1 and ndim == 0 for count, ndim in captured))

    def test_v2_features_expose_candidate_start_resource_history_and_pm_identity(self):
        """v2 候选特征不应再把已使用 PM 的动态负载全部编码成零。"""
        problem = sample_one_job_problem(
            load_pse300_topology(),
            random.Random(47),
            wafer_count=12,
            candidate_pool_sizes=(3,),
            process_range=(120, 120),
        )
        observed_resource_history = []
        observed_candidate_starts = []
        observed_process_pm_codes = []

        def chooser(state, candidates):
            """收集候选节点的 v2 动态与静态资源特征。"""
            observation = build_graph_observation(state, candidates)
            rows = observation.features[observation.candidate_nodes]
            self.assertEqual(rows.shape[1], FEATURE_DIMENSION)
            observed_resource_history.extend(rows[:, 11].tolist())
            observed_candidate_starts.extend(rows[:, 12].tolist())
            for candidate, row in zip(candidates, rows):
                destination = state.wmap[candidate.wid].stages[candidate.j + 1]
                if destination.stage_type == "process":
                    observed_process_pm_codes.append(float(row[15:19].sum().item()))
            return list(range(len(candidates)))

        decode_orders(problem, Durations(problem), problem.wafers, chooser=chooser)
        self.assertTrue(any(value > 0.0 for value in observed_resource_history))
        self.assertTrue(any(value > 0.0 for value in observed_candidate_starts))
        self.assertTrue(observed_process_pm_codes)
        self.assertTrue(all(value == 1.0 for value in observed_process_pm_codes))


class L2DTrainingAndInferenceTests(unittest.TestCase):
    """验证 PPO 更新、checkpoint 往返和 timing 单调用端到端行为。"""

    def test_minimal_ppo_update_changes_parameters_and_checkpoint_roundtrips(self):
        topology = load_pse300_topology()
        problem = sample_one_job_problem(
            topology, random.Random(51), wafer_count=2, stage_count=1
        )
        policy = L2DPolicy()
        optimizer = torch.optim.Adam(policy.parameters(), lr=1e-3)
        before = next(policy.parameters()).detach().clone()
        episode = collect_episode(problem, policy)
        first_observation = episode.transitions[0].observation
        self.assertAlmostEqual(
            episode.total_reward,
            (first_observation.lower_bound - episode.makespan)
            / first_observation.time_scale,
            places=7,
        )
        ppo_update(
            policy,
            optimizer,
            episode.transitions,
            PPOConfig(learning_rate=1e-3, ppo_epochs=1, mini_batch_size=64),
            random.Random(52),
        )
        self.assertFalse(torch.equal(before, next(policy.parameters()).detach()))

        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint = Path(temporary_directory) / "policy.pt"
            save_l2d_checkpoint(
                checkpoint,
                policy,
                phase="one-job",
                topology=topology,
                random_seed=51,
                optimizer=optimizer,
            )
            loaded = load_l2d_policy(checkpoint)
            self.assertEqual(loaded.checkpoint_metadata["training_phase"], "one-job")
            for expected, actual in zip(policy.parameters(), loaded.parameters()):
                self.assertTrue(torch.equal(expected, actual))

    def test_legacy_v1_checkpoint_remains_single_rollout_compatible(self):
        """旧 12 维 checkpoint 应继续按 v1 特征推理，避免静默改变线上语义。"""
        topology = load_pse300_topology()
        policy = L2DPolicy(L2DNetworkConfig(feature_dimension=LEGACY_FEATURE_DIMENSION))
        policy.checkpoint_metadata = {"feature_version": LEGACY_FEATURE_VERSION}
        problem = sample_one_job_problem(
            topology,
            random.Random(59),
            wafer_count=3,
            candidate_pool_sizes=(3,),
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            checkpoint = Path(temporary_directory) / "legacy.pt"
            save_l2d_checkpoint(
                checkpoint,
                policy,
                phase="one-job",
                topology=topology,
                random_seed=59,
            )
            loaded = load_l2d_policy(checkpoint)
            result = start_schedule_l2d(problem, loaded)

        self.assertEqual(loaded.checkpoint_metadata["feature_version"], LEGACY_FEATURE_VERSION)
        self.assertTrue(result.feasible)

    def test_inference_calls_timing_once_and_5_25_wafer_cases_are_valid(self):
        topology = load_pse300_topology()
        policy = L2DPolicy()
        for wafer_count in (5, 25):
            problem = sample_one_job_problem(
                topology,
                random.Random(60 + wafer_count),
                wafer_count=wafer_count,
                stage_count=3,
            )
            with mock.patch(
                "src.schedule.l2d.api.solve_timing",
                wraps=__import__("src.timing.solve", fromlist=["solve_timing"]).solve_timing,
            ) as timing_mock:
                result = start_schedule_l2d(problem, policy)
            self.assertEqual(timing_mock.call_count, 1)
            self.assertTrue(result.feasible)
            self.assertFalse(check_solution(problem, result))
            moves = export_movelist(problem, result)
            self.assertFalse(validate_move_list(problem, moves))

    def test_one_plus_three_and_two_plus_two_job_partitions_are_feasible(self):
        topology = load_pse300_topology()
        rng = random.Random(77)
        policy = L2DPolicy()
        for expected_shape in ((1, 3), (2, 2)):
            for _attempt in range(1000):
                problem = sample_two_job_problem(topology, rng)
                actual_shape = tuple(
                    len(pool) for pool in problem._l2d_generation["pm_partition"]
                )
                if actual_shape == expected_shape:
                    break
            else:
                self.fail(f"未采样到 PM 分区 {expected_shape}")
            result = start_schedule_l2d(problem, policy)
            self.assertTrue(result.feasible)
            self.assertFalse(check_solution(problem, result))


if __name__ == "__main__":
    unittest.main()
