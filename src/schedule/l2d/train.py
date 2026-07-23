"""PSE300 L2D 的两阶段 PPO 训练入口。

第一阶段从随机初始化模型训练单 Job；第二阶段必须加载第一阶段 checkpoint，并在同一模型
参数上继续训练双 Job。每个 episode 由 Actor 在 Banker 安全候选上采样，完整顺序产生后
只调用一次 ``solve_timing``，用真实 makespan 修正终局奖励。
"""

from __future__ import annotations

import argparse
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import List, Mapping, Optional, Sequence, Tuple

import torch

from src.parse.model import Durations, Problem
from src.schedule.api import start_schedule
from src.schedule.sequencing import _Cand, _DecodeState, decode_orders
from src.timing.solve import solve_timing

from .api import load_l2d_policy, save_l2d_checkpoint, start_schedule_l2d
from .graph import FEATURE_VERSION, GraphObservation, build_graph_observation
from .model import L2DPolicy
from .problems import (
    PM_ORDER,
    load_pse300_topology,
    sample_one_job_problem,
    sample_two_job_problem,
)


DEFAULT_GAMMA = 1.0
DEFAULT_CLIP = 0.2
DEFAULT_ENTROPY_COEFFICIENT = 0.01
DEFAULT_LEARNING_RATE = 2e-5
DEFAULT_VALUE_COEFFICIENT = 0.5
DEFAULT_MAX_GRADIENT_NORM = 0.5
DEFAULT_PPO_EPOCHS = 4
DEFAULT_EPISODES = 1000
DEFAULT_EPISODES_PER_UPDATE = 4
BALANCED_SINGLE_STAGE_INTERVAL = 4
DEFAULT_VALIDATION_INTERVAL = 50
VALIDATION_WAFER_COUNT = 12
VALIDATION_PROCESS_TIME = 120


@dataclass(frozen=True)
class PPOConfig:
    """PPO 目标函数与优化过程参数。"""

    gamma: float = DEFAULT_GAMMA
    clip: float = DEFAULT_CLIP
    entropy_coefficient: float = DEFAULT_ENTROPY_COEFFICIENT
    value_coefficient: float = DEFAULT_VALUE_COEFFICIENT
    learning_rate: float = DEFAULT_LEARNING_RATE
    ppo_epochs: int = DEFAULT_PPO_EPOCHS
    mini_batch_size: int = 64
    episodes_per_update: int = DEFAULT_EPISODES_PER_UPDATE
    maximum_gradient_norm: float = DEFAULT_MAX_GRADIENT_NORM


@dataclass(frozen=True)
class Transition:
    """一个安全动作决策及其 PPO 训练目标。"""

    observation: GraphObservation
    action: int
    old_log_probability: float
    old_value: float
    reward: float
    return_value: float


@dataclass(frozen=True)
class EpisodeResult:
    """一次 rollout 的训练样本和真实 timing 结果摘要。"""

    transitions: Tuple[Transition, ...]
    makespan: float
    total_reward: float
    decision_count: int
    baseline_makespan: Optional[float] = None


def collect_episode(
    problem: Problem,
    policy: L2DPolicy,
    *,
    gamma: float = DEFAULT_GAMMA,
    baseline_makespan: Optional[float] = None,
) -> EpisodeResult:
    """采样一条完整安全轨迹，并用一次真实 timing makespan 构造稠密奖励。

    步进奖励是连续状态 makespan 下界的负变化；最后一步用真实 makespan 替代下一状态
    下界。若提供与动作无关的训练基线，终局再加上 ``baseline-初始下界``，使未折扣总奖励
    等于 ``(baseline-真实makespan) / 时间尺度``，降低不同实例难度带来的策略梯度方差。
    """
    durations = Durations(problem)
    observations: List[GraphObservation] = []
    actions: List[int] = []
    old_log_probabilities: List[float] = []
    old_values: List[float] = []
    feature_version = str(
        getattr(policy, "checkpoint_metadata", {}).get("feature_version")
        or FEATURE_VERSION
    )

    def training_chooser(state: _DecodeState, candidates: List[_Cand]) -> List[int]:
        """在预过滤后的安全候选上按当前 Actor 分布采样。"""
        observation = build_graph_observation(
            state,
            candidates,
            feature_version=feature_version,
        )
        with torch.no_grad():
            action, log_probability, value = policy.choose_action(
                observation, greedy=False
            )
        observations.append(observation)
        actions.append(action)
        old_log_probabilities.append(float(log_probability.item()))
        old_values.append(float(value.item()))
        return [action, *(index for index in range(len(candidates)) if index != action)]

    orders = decode_orders(problem, durations, problem.wafers, chooser=training_chooser)
    timing_result = solve_timing(problem, problem.wafers, orders)
    if not getattr(timing_result, "feasible", False) or not math.isfinite(timing_result.makespan):
        raise RuntimeError("Banker 安全轨迹未能产生可行 timing 排程")
    if not observations:
        raise RuntimeError("训练 Problem 没有可调度动作")

    reference = max(observations[0].time_scale, 1.0)
    rewards = []
    for index, observation in enumerate(observations):
        next_bound = (
            observations[index + 1].lower_bound
            if index + 1 < len(observations)
            else timing_result.makespan
        )
        rewards.append((observation.lower_bound - next_bound) / reference)
    if baseline_makespan is not None:
        rewards[-1] += (baseline_makespan - observations[0].lower_bound) / reference

    returns = [0.0] * len(rewards)
    running_return = 0.0
    for index in range(len(rewards) - 1, -1, -1):
        running_return = rewards[index] + gamma * running_return
        returns[index] = running_return

    transitions = tuple(
        Transition(
            observation=observation,
            action=action,
            old_log_probability=old_log_probability,
            old_value=old_value,
            reward=reward,
            return_value=return_value,
        )
        for observation, action, old_log_probability, old_value, reward, return_value in zip(
            observations,
            actions,
            old_log_probabilities,
            old_values,
            rewards,
            returns,
        )
    )
    return EpisodeResult(
        transitions=transitions,
        makespan=timing_result.makespan,
        total_reward=sum(rewards),
        decision_count=len(transitions),
        baseline_makespan=baseline_makespan,
    )


def ppo_update(
    policy: L2DPolicy,
    optimizer: torch.optim.Optimizer,
    transitions: Sequence[Transition],
    config: PPOConfig,
    rng: random.Random,
) -> Mapping[str, float]:
    """对变长图 transition 执行 PPO clipped objective 更新。"""
    if not transitions:
        raise ValueError("PPO 更新至少需要一个 transition")
    policy.train()
    device = policy.device
    returns = torch.tensor(
        [transition.return_value for transition in transitions],
        dtype=torch.float32,
        device=device,
    )
    old_values = torch.tensor(
        [transition.old_value for transition in transitions],
        dtype=torch.float32,
        device=device,
    )
    advantages = returns - old_values
    if len(transitions) > 1:
        advantages = (advantages - advantages.mean()) / (
            advantages.std(unbiased=False) + 1e-8
        )

    aggregate_actor = 0.0
    aggregate_value = 0.0
    aggregate_entropy = 0.0
    update_count = 0
    all_indices = list(range(len(transitions)))
    for _epoch in range(config.ppo_epochs):
        rng.shuffle(all_indices)
        for batch_start in range(0, len(all_indices), config.mini_batch_size):
            batch_indices = all_indices[batch_start:batch_start + config.mini_batch_size]
            actor_losses = []
            value_losses = []
            entropies = []
            for index in batch_indices:
                transition = transitions[index]
                distribution, value = policy.distribution_and_value(transition.observation)
                action = torch.tensor(transition.action, device=device)
                log_probability = distribution.log_prob(action)
                old_log_probability = torch.tensor(
                    transition.old_log_probability, dtype=torch.float32, device=device
                )
                ratio = torch.exp(log_probability - old_log_probability)
                advantage = advantages[index]
                clipped_ratio = torch.clamp(
                    ratio, 1.0 - config.clip, 1.0 + config.clip
                )
                actor_losses.append(-torch.minimum(ratio * advantage, clipped_ratio * advantage))
                value_losses.append((value - returns[index]).square())
                entropies.append(distribution.entropy())

            actor_loss = torch.stack(actor_losses).mean()
            value_loss = torch.stack(value_losses).mean()
            entropy = torch.stack(entropies).mean()
            total_loss = (
                actor_loss
                + config.value_coefficient * value_loss
                - config.entropy_coefficient * entropy
            )
            optimizer.zero_grad()
            total_loss.backward()
            torch.nn.utils.clip_grad_norm_(
                policy.parameters(), config.maximum_gradient_norm
            )
            optimizer.step()

            aggregate_actor += float(actor_loss.item())
            aggregate_value += float(value_loss.item())
            aggregate_entropy += float(entropy.item())
            update_count += 1
    denominator = max(update_count, 1)
    return {
        "actor_loss": aggregate_actor / denominator,
        "value_loss": aggregate_value / denominator,
        "entropy": aggregate_entropy / denominator,
    }


def evaluate_single_stage_chamber_gaps(
    policy: L2DPolicy,
    topology: Mapping[str, object],
    *,
    seed: int,
) -> Mapping[str, float]:
    """在固定 12 片、120 秒的 1–4 腔矩阵上评估单次 greedy 相对启发式 gap。"""
    gaps = {}
    for chamber_count in range(1, len(PM_ORDER) + 1):
        problem = sample_one_job_problem(
            topology,
            random.Random(seed + chamber_count),
            wafer_count=VALIDATION_WAFER_COUNT,
            candidate_pool_sizes=(chamber_count,),
            process_range=(VALIDATION_PROCESS_TIME, VALIDATION_PROCESS_TIME),
        )
        model_result = start_schedule_l2d(problem, policy)
        baseline_result = start_schedule(problem, verbose=False)
        gaps[f"{chamber_count}ch_gap_percent"] = (
            100.0 * (model_result.makespan - baseline_result.makespan)
            / baseline_result.makespan
        )
    gaps["mean_gap_percent"] = sum(gaps.values()) / len(PM_ORDER)
    return gaps


def train_policy(
    *,
    phase: str,
    episodes: int,
    seed: int,
    device: str,
    output: Path,
    init_checkpoint: Optional[Path] = None,
    ppo_config: Optional[PPOConfig] = None,
    process_range: Tuple[int, int] = (40, 120),
    log_interval: int = 10,
    validation_interval: int = DEFAULT_VALIDATION_INTERVAL,
) -> L2DPolicy:
    """执行指定阶段训练、保存 checkpoint 并返回训练后的策略。"""
    if phase not in {"one-job", "two-job"}:
        raise ValueError("phase 必须是 'one-job' 或 'two-job'")
    if phase == "two-job" and init_checkpoint is None:
        raise ValueError("two-job 阶段必须通过 --init 提供第一阶段 checkpoint")
    if episodes < 1:
        raise ValueError("episodes 必须为正整数")
    rng = random.Random(seed)
    torch.manual_seed(seed)
    topology = load_pse300_topology()
    config = ppo_config or PPOConfig()
    policy = (
        load_l2d_policy(init_checkpoint, device=device)
        if init_checkpoint is not None
        else L2DPolicy().to(device)
    )
    if phase == "two-job":
        initial_phase = getattr(policy, "checkpoint_metadata", {}).get("training_phase")
        if initial_phase != "one-job":
            raise ValueError(
                f"two-job 阶段要求第一阶段 checkpoint，实际 training_phase={initial_phase!r}"
            )
    optimizer = torch.optim.Adam(policy.parameters(), lr=config.learning_rate)

    # 第二阶段在同一模型上继续，并尽可能恢复第一阶段优化器动量。
    if init_checkpoint is not None:
        try:
            initial_payload = torch.load(
                init_checkpoint, map_location=device, weights_only=True
            )
        except TypeError:
            initial_payload = torch.load(init_checkpoint, map_location=device)
        if isinstance(initial_payload, dict) and "optimizer_state_dict" in initial_payload:
            optimizer.load_state_dict(initial_payload["optimizer_state_dict"])
            for parameter_group in optimizer.param_groups:
                parameter_group["lr"] = config.learning_rate

    if config.episodes_per_update < 1:
        raise ValueError("episodes_per_update 必须为正整数")
    last_episode: Optional[EpisodeResult] = None
    last_validation: Mapping[str, float] = {}
    transition_batch: List[Transition] = []
    last_losses: Optional[Mapping[str, float]] = None
    for episode_index in range(1, episodes + 1):
        if phase == "one-job":
            balanced_episode = (episode_index - 1) % BALANCED_SINGLE_STAGE_INTERVAL == 0
            if balanced_episode:
                balanced_index = (episode_index - 1) // BALANCED_SINGLE_STAGE_INTERVAL
                chamber_count = balanced_index % len(PM_ORDER) + 1
                problem = sample_one_job_problem(
                    topology,
                    rng,
                    candidate_pool_sizes=(chamber_count,),
                    process_range=process_range,
                )
            else:
                problem = sample_one_job_problem(
                    topology, rng, process_range=process_range
                )
        else:
            problem = sample_two_job_problem(
                topology, rng, process_range=process_range
            )
        # 训练期基线只降低回报方差，不参与动作选择，也不会进入线上单次推理。
        baseline_result = start_schedule(problem, verbose=False)
        baseline_makespan = (
            baseline_result.makespan
            if getattr(baseline_result, "feasible", False)
            else None
        )
        last_episode = collect_episode(
            problem,
            policy,
            gamma=config.gamma,
            baseline_makespan=baseline_makespan,
        )
        transition_batch.extend(last_episode.transitions)
        update_due = (
            episode_index % config.episodes_per_update == 0
            or episode_index == episodes
        )
        if update_due:
            last_losses = ppo_update(policy, optimizer, transition_batch, config, rng)
            transition_batch.clear()
        if episode_index == 1 or episode_index % max(log_interval, 1) == 0:
            loss_text = (
                f"actor={last_losses['actor_loss']:.4f} value={last_losses['value_loss']:.4f}"
                if last_losses is not None
                else f"collecting={len(transition_batch)}/{config.episodes_per_update} episodes"
            )
            print(
                f"episode={episode_index}/{episodes} phase={phase} "
                f"makespan={last_episode.makespan:.2f} reward={last_episode.total_reward:.4f} "
                f"{loss_text}"
            )
        if (
            phase == "one-job"
            and validation_interval > 0
            and (
                episode_index % validation_interval == 0
                or episode_index == episodes
            )
        ):
            last_validation = evaluate_single_stage_chamber_gaps(
                policy,
                topology,
                seed=seed + 10_000,
            )
            print(
                "validation "
                + " ".join(
                    f"{name}={value:+.2f}%"
                    for name, value in last_validation.items()
                )
            )

    save_l2d_checkpoint(
        output,
        policy,
        phase=phase,
        topology=topology,
        random_seed=seed,
        optimizer=optimizer,
        training_metadata={
            "episodes": episodes,
            "gamma": config.gamma,
            "clip": config.clip,
            "entropy_coefficient": config.entropy_coefficient,
            "learning_rate": config.learning_rate,
            "episodes_per_update": config.episodes_per_update,
            "reward_baseline": "heuristic",
            "process_range": list(process_range),
            "last_makespan": last_episode.makespan if last_episode else None,
            "last_validation": dict(last_validation),
        },
    )
    return policy


def _argument_parser() -> argparse.ArgumentParser:
    """创建命令行解析器。"""
    parser = argparse.ArgumentParser(description="训练 PSE300 L2D GraphCNN/PPO 策略")
    parser.add_argument("--phase", required=True, choices=("one-job", "two-job"))
    parser.add_argument("--init", type=Path, help="第二阶段使用的第一阶段 checkpoint")
    parser.add_argument("--output", type=Path, help="checkpoint 输出路径")
    parser.add_argument("--episodes", type=int, default=DEFAULT_EPISODES)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--learning-rate", type=float, default=DEFAULT_LEARNING_RATE)
    parser.add_argument("--gamma", type=float, default=DEFAULT_GAMMA)
    parser.add_argument("--clip", type=float, default=DEFAULT_CLIP)
    parser.add_argument("--entropy", type=float, default=DEFAULT_ENTROPY_COEFFICIENT)
    parser.add_argument("--ppo-epochs", type=int, default=DEFAULT_PPO_EPOCHS)
    parser.add_argument("--mini-batch-size", type=int, default=64)
    parser.add_argument("--episodes-per-update", type=int, default=DEFAULT_EPISODES_PER_UPDATE)
    parser.add_argument("--process-min", type=int, default=40)
    parser.add_argument("--process-max", type=int, default=120)
    parser.add_argument("--log-interval", type=int, default=10)
    parser.add_argument("--validation-interval", type=int, default=DEFAULT_VALIDATION_INTERVAL)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> None:
    """解析 CLI 参数并执行一阶段或二阶段 PPO 训练。"""
    args = _argument_parser().parse_args(argv)
    output = args.output or Path(
        "l2d_pse300_1job.pt" if args.phase == "one-job" else "l2d_pse300_2job.pt"
    )
    train_policy(
        phase=args.phase,
        episodes=args.episodes,
        seed=args.seed,
        device=args.device,
        output=output,
        init_checkpoint=args.init,
        ppo_config=PPOConfig(
            gamma=args.gamma,
            clip=args.clip,
            entropy_coefficient=args.entropy,
            learning_rate=args.learning_rate,
            ppo_epochs=args.ppo_epochs,
            mini_batch_size=args.mini_batch_size,
            episodes_per_update=args.episodes_per_update,
        ),
        process_range=(args.process_min, args.process_max),
        log_interval=args.log_interval,
        validation_interval=args.validation_interval,
    )
    print(f"checkpoint 已保存：{output}")


if __name__ == "__main__":
    main()
