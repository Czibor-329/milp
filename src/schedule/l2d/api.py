"""L2D checkpoint 与单次贪心推理的公开接口。

推理阶段只做一轮 GraphCNN/Actor 解码。解码器负责 Banker 安全过滤，策略只决定操作
顺序；完整顺序产生后恰好调用一次 ``solve_timing`` 计算精确时刻，不运行 MILP、重复采样
或启发式替换。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

import torch

from src.parse.model import Durations, Problem
from src.schedule.sequencing import _Cand, _DecodeState, decode_orders
from src.timing.solve import SolveResult, solve_timing

from .graph import (
    FEATURE_VERSION,
    SUPPORTED_FEATURE_DIMENSIONS,
    build_graph_observation,
)
from .model import L2DNetworkConfig, L2DPolicy
from .problems import topology_digest


def _topology_summary(topology: Mapping[str, Any]) -> Dict[str, Any]:
    """提取 checkpoint 中用于诊断兼容性的 PSE300 拓扑摘要。"""
    return {
        "name": "PSE300",
        "sha256": topology_digest(topology),
        "robots": sorted((topology.get("Robots") or {}).keys()),
        "stations": sorted((topology.get("Stations") or {}).keys()),
    }


def save_l2d_checkpoint(
    path: str | Path,
    policy: L2DPolicy,
    *,
    phase: str,
    topology: Mapping[str, Any],
    random_seed: int,
    optimizer: Optional[torch.optim.Optimizer] = None,
    training_metadata: Optional[Mapping[str, Any]] = None,
) -> None:
    """保存可继续训练和独立推理的 L2D checkpoint。

    除模型参数外还记录网络结构、特征版本、训练阶段、PSE300 拓扑摘要和随机种子；若传入
    optimizer，也保存其状态，便于第二阶段保持优化器动量。
    """
    policy_feature_version = str(
        getattr(policy, "checkpoint_metadata", {}).get("feature_version")
        or FEATURE_VERSION
    )
    checkpoint: Dict[str, Any] = {
        "model_state_dict": policy.state_dict(),
        "network_config": policy.config.to_dict(),
        "feature_version": policy_feature_version,
        "training_phase": phase,
        "topology": _topology_summary(topology),
        "random_seed": int(random_seed),
        "training_metadata": dict(training_metadata or {}),
    }
    if optimizer is not None:
        checkpoint["optimizer_state_dict"] = optimizer.state_dict()
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    torch.save(checkpoint, destination)


def load_l2d_policy(
    checkpoint: str | Path,
    device: str | torch.device = "cpu",
) -> L2DPolicy:
    """加载 L2D checkpoint 并返回处于 eval 模式的策略。

    特征版本不匹配会立即报错，避免用旧特征语义静默运行新模型。checkpoint 元数据可从
    返回对象的 ``checkpoint_metadata`` 属性读取。
    """
    try:
        payload = torch.load(checkpoint, map_location=device, weights_only=True)
    except TypeError:
        payload = torch.load(checkpoint, map_location=device)
    if not isinstance(payload, dict) or "model_state_dict" not in payload:
        raise ValueError(f"{checkpoint} 不是有效的 L2D checkpoint")
    checkpoint_feature_version = str(payload.get("feature_version") or "")
    if checkpoint_feature_version not in SUPPORTED_FEATURE_DIMENSIONS:
        supported = "、".join(sorted(SUPPORTED_FEATURE_DIMENSIONS))
        raise ValueError(
            f"checkpoint 特征版本 {checkpoint_feature_version!r} 不受支持；支持：{supported}"
        )
    config = L2DNetworkConfig.from_dict(dict(payload.get("network_config") or {}))
    expected_dimension = SUPPORTED_FEATURE_DIMENSIONS[checkpoint_feature_version]
    if config.feature_dimension != expected_dimension:
        raise ValueError(
            f"checkpoint 特征维数 {config.feature_dimension} 与版本 "
            f"{checkpoint_feature_version!r} 要求的 {expected_dimension} 不一致"
        )
    policy = L2DPolicy(config).to(device)
    policy.load_state_dict(payload["model_state_dict"])
    policy.eval()
    policy.checkpoint_metadata = {  # type: ignore[attr-defined]
        key: value for key, value in payload.items()
        if key not in {"model_state_dict", "optimizer_state_dict"}
    }
    return policy


def start_schedule_l2d(problem: Problem, policy: L2DPolicy) -> SolveResult:
    """用一次贪心 L2D rollout 决定资源顺序，再调用一次 timing 求精确排程。

    ``Problem`` 中的每片实际 PM 和 LA/LB 必须已在解析阶段固定。函数不会改选腔、不会
    调用 MILP，也不会用启发式结果替换模型结果。返回值保持标准 ``SolveResult``，并附加
    ``l2d_decisions``、``l2d_orders`` 与 ``l2d_inference_runtime`` 诊断属性。
    """
    started_at = time.perf_counter()
    durations = Durations(problem)
    decisions = []
    feature_version = str(
        getattr(policy, "checkpoint_metadata", {}).get("feature_version")
        or FEATURE_VERSION
    )
    was_training = policy.training
    policy.eval()

    def graph_chooser(state: _DecodeState, candidates: list[_Cand]) -> list[int]:
        """在解码器给出的安全候选上执行 Actor 贪心选择。"""
        observation = build_graph_observation(
            state,
            candidates,
            feature_version=feature_version,
        )
        with torch.no_grad():
            action_index, _log_probability, _value = policy.choose_action(
                observation, greedy=True
            )
        selected = candidates[action_index]
        decisions.append((selected.wid, selected.j))
        remaining = [index for index in range(len(candidates)) if index != action_index]
        return [action_index, *remaining]

    try:
        orders = decode_orders(problem, durations, problem.wafers, chooser=graph_chooser,
                               enforce_resumed_route_fifo=False)
        # 这是推理中唯一一次精确定时调用。
        result = solve_timing(
            problem,
            problem.wafers,
            orders,
            enforce_resumed_route_fifo=False,
        )
    finally:
        if was_training:
            policy.train()

    result.l2d_decisions = tuple(decisions)  # type: ignore[attr-defined]
    result.l2d_orders = orders  # type: ignore[attr-defined]
    result.l2d_inference_runtime = time.perf_counter() - started_at  # type: ignore[attr-defined]
    return result
