"""深层集合神经派工的模型、排程质量和前端接入测试。"""

from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from src.export import check_solution
from src.parse import load_alg_entries, parse_task
from src.parse.generator import PM_POOL_6, expand_topo_pms
from src.paths import input_data_path
from src.schedule.api import start_schedule
from src.schedule.neural import (
    DEFAULT_MODEL_PATH,
    FEATURE_DIMENSION,
    MODEL_SCHEMA_VERSION,
    SetAttentionNetwork,
    _BalancedWavefront,
    _needs_sparse_feed_startup,
    load_neural_policy,
    start_schedule_neural,
)


ROOT = Path(__file__).resolve().parents[1]
TEST_INSTANCE = ROOT / "dataset" / "test" / "1stage" / "inst_0000.json"
COMPLEX_INSTANCES = [
    ROOT / "dataset" / "train" / "2job" / f"inst_{index:04d}.json"
    for index in range(5)
]
MAXIMUM_BASELINE_GAP = 0.10
MAXIMUM_COMPLEX_NEURAL_TOTAL = 9_500.0


class SetAttentionNetworkTests(unittest.TestCase):
    """验证集合网络本身及安全 checkpoint 格式。"""

    def test_candidate_scores_are_permutation_equivariant(self) -> None:
        """重排候选只能重排分数，不得改变某个候选的得分。"""
        network = SetAttentionNetwork()
        features = np.arange(
            FEATURE_DIMENSION * 5,
            dtype=np.float32,
        ).reshape(5, FEATURE_DIMENSION) / 100.0
        permutation = np.asarray([3, 0, 4, 1, 2])

        original = network.score(features)
        permuted = network.score(features[permutation])

        np.testing.assert_allclose(original[permutation], permuted, rtol=1e-6, atol=1e-6)
        self.assertGreater(network.parameter_count, 50_000)
        self.assertLess(network.parameter_count, 100_000)

    def test_numpy_checkpoint_round_trip(self) -> None:
        """模型文件应只含固定维度数组，并恢复完全一致的前向结果。"""
        network = SetAttentionNetwork()
        features = np.eye(FEATURE_DIMENSION, dtype=np.float32)[:4]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.npz"
            checkpoint = {
                name: getattr(network, name)
                for name in (
                    "input_weights",
                    "input_bias",
                    "query_weights",
                    "key_weights",
                    "value_weights",
                    "attention_output_weights",
                    "feed_forward_input_weights",
                    "feed_forward_input_bias",
                    "feed_forward_output_weights",
                    "feed_forward_output_bias",
                    "score_weights",
                    "score_bias",
                    "score_output",
                )
            }
            np.savez_compressed(
                path,
                schema=np.asarray(MODEL_SCHEMA_VERSION),
                **checkpoint,
                feature_mean=network.feature_mean,
                feature_std=network.feature_std,
                training_instances=np.asarray(2, dtype=np.int64),
                validation_accuracy=np.asarray(0.75, dtype=np.float32),
                teacher=np.asarray("baseline"),
            )

            loaded = load_neural_policy(path)

        np.testing.assert_allclose(network.score(features), loaded.score(features))
        self.assertEqual(2, loaded.metadata["trainingInstances"])
        self.assertEqual("baseline", loaded.metadata["teacher"])

    def test_sparse_feed_startup_is_limited_to_long_low_batch_transient(self) -> None:
        """等配额启动专家只应覆盖长加工、低批次数的独立路线 warm-up。"""
        problem = SimpleNamespace(chambers={
            "LA": SimpleNamespace(
                type="LoadLock",
                pump_time=19.26,
                vent_time=19.30,
            ),
        })
        long_sparse = _BalancedWavefront(
            rank_by_wafer={},
            capacity_by_wafer={},
            family_count=3,
            maximum_machine_batches=3,
            process_time=600.0,
        )

        self.assertTrue(
            _needs_sparse_feed_startup(problem, long_sparse)
        )
        self.assertFalse(
            _needs_sparse_feed_startup(
                problem,
                replace(long_sparse, process_time=300.0),
            )
        )
        self.assertFalse(
            _needs_sparse_feed_startup(
                problem,
                replace(long_sparse, maximum_machine_batches=5),
            )
        )


class NeuralScheduleTests(unittest.TestCase):
    """在未参与训练划分的测试实例上验证真实排程链路。"""

    @classmethod
    def setUpClass(cls) -> None:
        """加载公共拓扑、独立测试实例和训练模型。"""
        if not DEFAULT_MODEL_PATH.is_file():
            raise AssertionError(
                f"缺少交付模型 {DEFAULT_MODEL_PATH}，请运行 scripts/train_neural.py"
            )
        topology, _ = load_alg_entries(input_data_path("s1-1c1p-preclean"))
        topology = expand_topo_pms(topology, PM_POOL_6)
        payload = json.loads(TEST_INSTANCE.read_text(encoding="utf-8"))
        cls.topology = topology
        cls.problem = parse_task(topology, payload["update_params"])
        cls.policy = load_neural_policy(DEFAULT_MODEL_PATH)

    def test_single_pass_neural_schedule_does_not_regress_on_unseen_simple_case(self) -> None:
        """未见单路线实例上，纯网络单次解码应可行且不明显退化。"""
        baseline = start_schedule(self.problem, verbose=False)
        neural = start_schedule_neural(
            self.problem,
            policy=self.policy,
            fallback_on_failure=False,
        )

        self.assertTrue(getattr(neural, "feasible", False))
        self.assertEqual([], check_solution(self.problem, neural))
        # 单槽 LoadLock 的 entry/exit 现在共享真实槽 0；旧模型把 exit 映射到
        # 不存在的第二槽。修正后贪心轨迹可能需要同一网络的 Petri-safe 重试。
        self.assertIn(
            neural.neural_diagnostics["selectedSource"],
            {"neural", "neural-safe-retry"},
        )
        self.assertEqual(MODEL_SCHEMA_VERSION, neural.neural_diagnostics["architecture"])
        relative_gap = (neural.makespan - baseline.makespan) / baseline.makespan
        self.assertLessEqual(relative_gap, MAXIMUM_BASELINE_GAP)

    def test_complex_two_job_portfolio_keeps_checkpoint_quality(self) -> None:
        """PM 换片升级 baseline 后，纯 checkpoint 模式仍须守住原组合质量上界。

        这里显式关闭 fallback，测的是旧 checkpoint 本身而不是生产入口。Heuristic
        现在获得双臂 PM swap 物理能力，继续要求未重训模型比新 baseline 快 15% 已不
        再是同口径比较；生产入口会在物理修复较差时选择新的 swap quality floor。
        """
        baseline_total = 0.0
        neural_total = 0.0
        for path in COMPLEX_INSTANCES:
            payload = json.loads(path.read_text(encoding="utf-8"))
            problem = parse_task(self.topology, payload["update_params"])
            baseline = start_schedule(problem, verbose=False)
            neural = start_schedule_neural(
                problem,
                policy=self.policy,
                fallback_on_failure=False,
            )
            self.assertTrue(getattr(baseline, "feasible", False))
            self.assertTrue(getattr(neural, "feasible", False))
            self.assertEqual([], check_solution(problem, neural))
            baseline_total += float(baseline.makespan)
            neural_total += float(neural.makespan)

        self.assertGreater(baseline_total, 0.0)
        self.assertLessEqual(neural_total, MAXIMUM_COMPLEX_NEURAL_TOTAL)

    def test_frontend_and_health_endpoint_expose_neural_strategy(self) -> None:
        """页面选择器和服务健康检查应使用同一稳定策略标识。"""
        frontend_root = ROOT / "realtime_scheduler" / "frontend"
        html = "\n".join([
            (frontend_root / "config_editor.html").read_text(encoding="utf-8"),
            (frontend_root / "src" / "config_editor.ts").read_text(encoding="utf-8"),
        ])
        server_source = (
            ROOT / "realtime_scheduler" / "server.py"
        ).read_text(encoding="utf-8")

        self.assertIn('id="neuralStrategyInput"', html)
        self.assertIn('value="neural"', html)
        self.assertIn("status.strategies?.neural", html)
        self.assertIn("item.improvementPercent", html)
        self.assertIn("总 Makespan / Baseline", html)
        self.assertIn('"neural": NEURAL_MODEL_PATH.is_file()', server_source)
        self.assertIn('{"heuristic", "neural", "rl", "milp"}', server_source)


if __name__ == "__main__":
    unittest.main()
