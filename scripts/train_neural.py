"""离线训练深层集合注意力调度网络。

脚本遍历不同工序数、并行腔、Recipe 时长、Job 数和晶圆规模的场景，用 Heuristic
Baseline（也可选数据集 MILP）生成参考资源顺序，再训练 ``deep-set-dispatch-v2``。
除首选动作外，训练还学习教师对全部安全候选的相对排序，以降低长轨迹中的误差累积。
训练依赖 Torch 且可长时间运行；输出仅含 NumPy 数组，生产推理不依赖 Torch。

示例：
    python scripts/train_neural.py --epochs 300
    python scripts/train_neural.py --max-source-files 80 --wafer-counts 5 12 25
    python scripts/train_neural.py --realtime-residual-augmentation
"""

from __future__ import annotations

import argparse
import glob
import io
import json
import random
import sys
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as functional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.parse import load_alg_entries, parse_task, resize_task_materials
from src.parse.generator import (
    PM_POOL_6,
    JobSpec,
    build_concurrent_update,
    expand_topo_pms,
)
from src.parse.model import Durations, RuntimeAvailability
from src.paths import input_data_path
from src.schedule.api import start_schedule
from src.schedule.neural import (
    ATTENTION_HEADS,
    ATTENTION_LAYERS,
    DEFAULT_MODEL_PATH,
    FEATURE_DIMENSION,
    FEED_FORWARD_DIMENSION,
    Feature,
    LAYER_NORMALIZATION_EPSILON,
    MODEL_DIMENSION,
    MODEL_SCHEMA_VERSION,
    REFERENCE_ROUTE_COUNT,
    SCORE_DIMENSION,
    SetAttentionNetwork,
    extract_reference_ranked_steps,
    load_neural_policy,
)
from src.schedule.sequencing import decode_orders_choosing
from src.timing.solve import solve_timing


BASE_TOPOLOGY = "s1-1c1p-preclean"
DEFAULT_GLOBS = (
    "dataset/train/**/inst_*.json",
)
MINIMUM_STANDARD_DEVIATION = 1e-6
MASKED_LOGIT = -1e9
EARLY_DECISION_WEIGHT = 2.0
CROSS_ROUTE_RELEASE_WEIGHT = 2.0
CLEANING_SAMPLE_WEIGHT = 2.0
MULTI_ROUTE_SAMPLE_WEIGHT = 1.0
DECOMPOSITION_WAFER_COUNTS = (4, 8, 16, 24)
DECOMPOSITION_PROCESS_TIMES = (90, 180, 450)
DECOMPOSITION_PAIR_LAYOUTS = (
    (("PM1", "PM2"), ("PM3", "PM4"), ("PM5", "PM6")),
    (("PM1", "PM4"), ("PM2", "PM5"), ("PM3", "PM6")),
    (("PM1", "PM6"), ("PM2", "PM3"), ("PM4", "PM5")),
)
REALTIME_RESIDUAL_RECOMPUTE_GAPS = (37, 73, 127, 211, 337)
REALTIME_RESIDUAL_WAFER_COUNTS = (4, 7, 12, 18, 24)
REALTIME_RESIDUAL_PROCESS_TIMES = (83, 137, 191, 263)
REALTIME_RESIDUAL_DISJOINT_TIME_OFFSET = 29
REALTIME_RESIDUAL_SINGLE_TIME_REDUCTION = 17
REALTIME_RESIDUAL_MULTI_STAGE_RATIOS = (
    (0.61, 0.89),
    (0.68, 0.82),
)
REALTIME_RESIDUAL_STRUCTURES = (
    ("same-single", ("single12", "single12", "single12")),
    ("disjoint-single", ("single12", "single34", "single12")),
    ("different-disjoint-multi", ("single1", "multi34", "single1")),
    ("shared-multi", ("multi13", "multi23", "multi13")),
)
SIX_PM_LONG_PROCESS_TIMES = (420, 510, 690, 780)
SIX_PM_LONG_RECOMPUTE_GAPS = (850, 1050, 1450, 1750)
SIX_PM_LONG_WAFER_COUNTS = (3, 4)
SIX_PM_LONG_ROUND_COUNT = 5
ACCEPTANCE_LONG_PROCESS_TIME = 600
ACCEPTANCE_LONG_RECOMPUTE_GAP = 1200
ACCEPTANCE_LONG_WAFER_COUNT = 5
ACCEPTANCE_RECOMPUTE_GAPS = frozenset((50, 100, 150, 250, 300))
ACCEPTANCE_WAFER_COUNTS = frozenset((10, 15))
PSE300_DEVICE_PATH = ROOT / "src" / "input_data" / "PSE300.json"

Step = Tuple[np.ndarray, np.ndarray]


@dataclass(frozen=True)
class RealtimeResidualTrainingInstance:
    """一条来自多次重算后残差状态的完整候选排序训练实例。

    ``runtime_availability`` 与特征样本一起保留，便于测试和离线审计确认数据确实
    来自运行态投影，而不是把普通首排样本换了一个名称。
    """

    structure: str
    recompute_gap: int
    recompute_index: int
    wafer_count: int
    teacher: str
    runtime_availability: RuntimeAvailability
    records: List[Step]


class TrainableSetAttentionNetwork(nn.Module):
    """与生产 NumPy 前向完全同构的可训练 Torch 网络。"""

    def __init__(self) -> None:
        """用生产端确定性 Xavier 参数初始化全部可训练层。"""
        super().__init__()
        initial = SetAttentionNetwork()
        parameter_names = (
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
        for name in parameter_names:
            value = torch.from_numpy(getattr(initial, name).copy())
            setattr(self, name, nn.Parameter(value))

    def forward(self, features: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        """计算带 padding 掩码的变长候选 logits。"""
        hidden = torch.tanh(features @ self.input_weights + self.input_bias)
        batch_size, candidate_count, _ = hidden.shape
        head_dimension = MODEL_DIMENSION // ATTENTION_HEADS
        attention_scale = head_dimension ** -0.5
        key_padding = mask[:, None, None, :] < 0.5
        for layer in range(ATTENTION_LAYERS):
            query = (hidden @ self.query_weights[layer]).reshape(
                batch_size,
                candidate_count,
                ATTENTION_HEADS,
                head_dimension,
            ).transpose(1, 2)
            key = (hidden @ self.key_weights[layer]).reshape(
                batch_size,
                candidate_count,
                ATTENTION_HEADS,
                head_dimension,
            ).transpose(1, 2)
            value = (hidden @ self.value_weights[layer]).reshape(
                batch_size,
                candidate_count,
                ATTENTION_HEADS,
                head_dimension,
            ).transpose(1, 2)
            attention_logits = (
                query @ key.transpose(-2, -1)
            ) * attention_scale
            attention = torch.softmax(
                attention_logits.masked_fill(key_padding, MASKED_LOGIT),
                dim=-1,
            )
            message = (attention @ value).transpose(1, 2).reshape(
                batch_size,
                candidate_count,
                MODEL_DIMENSION,
            )
            hidden = functional.layer_norm(
                hidden + message @ self.attention_output_weights[layer],
                (MODEL_DIMENSION,),
                eps=LAYER_NORMALIZATION_EPSILON,
            )
            feed_forward = torch.tanh(
                hidden @ self.feed_forward_input_weights[layer]
                + self.feed_forward_input_bias[layer]
            )
            hidden = functional.layer_norm(
                hidden
                + feed_forward @ self.feed_forward_output_weights[layer]
                + self.feed_forward_output_bias[layer],
                (MODEL_DIMENSION,),
                eps=LAYER_NORMALIZATION_EPSILON,
            )
        score_hidden = torch.tanh(hidden @ self.score_weights + self.score_bias)
        logits = score_hidden @ self.score_output
        return logits.masked_fill(mask < 0.5, MASKED_LOGIT)


def _source_files(patterns: Sequence[str], maximum: int, seed: int) -> List[Path]:
    """展开多个递归 glob、去重并按固定种子抽取训练源文件。"""
    files = sorted(
        {
            Path(filename)
            for pattern in patterns
            for filename in glob.glob(str(ROOT / pattern), recursive=True)
        }
    )
    if maximum > 0 and len(files) > maximum:
        generator = random.Random(seed)
        files = sorted(generator.sample(files, maximum))
    return files


def _oracle_schedule(payload: dict):
    """读取数据集内已通过自检的 MILP schedule 与 makespan。"""
    result = payload.get("result") or {}
    schedule = result.get("schedule")
    makespan = result.get("makespan")
    self_check = result.get("self_check_ok")
    if (
        not isinstance(schedule, dict)
        or not schedule
        or not isinstance(makespan, (int, float))
        or not np.isfinite(float(makespan))
        or self_check is False
    ):
        return None, float("inf")
    return schedule, float(makespan)


def _reference_schedule(
    problem,
    payload: dict,
    teacher: str,
    *,
    original_size: bool,
):
    """从 baseline 与可用 oracle 中选 makespan 最小的强教师轨迹。"""
    oracle_schedule, oracle_makespan = (
        _oracle_schedule(payload) if original_size else (None, float("inf"))
    )
    if teacher == "milp":
        return oracle_schedule
    baseline = start_schedule(problem, verbose=False)
    if not getattr(baseline, "feasible", False):
        return oracle_schedule
    if (
        teacher == "strong"
        and oracle_schedule is not None
        and oracle_makespan < float(baseline.makespan) - 1e-9
    ):
        return oracle_schedule
    return baseline.schedule


def _collect_instances(
    files: Sequence[Path],
    wafer_counts: Sequence[int],
    teacher: str,
) -> List[List[Step]]:
    """解析多场景并提取按实例分组的安全动作监督样本。"""
    topology, _ = load_alg_entries(input_data_path(BASE_TOPOLOGY))
    topology = expand_topo_pms(topology, PM_POOL_6)
    instances: List[List[Step]] = []
    for file_index, filename in enumerate(files, start=1):
        payload = json.loads(filename.read_text(encoding="utf-8"))
        for wafer_count in wafer_counts:
            if teacher == "milp" and wafer_count != 0:
                continue
            update = payload["update_params"]
            if wafer_count > 0:
                update = resize_task_materials(update, wafer_count)
            try:
                problem = parse_task(topology, update)
                schedule = _reference_schedule(
                    problem,
                    payload,
                    teacher,
                    original_size=wafer_count == 0,
                )
                if schedule is None:
                    continue
                records = extract_reference_ranked_steps(problem, schedule)
            except Exception as error:  # noqa: BLE001
                print(
                    f"[跳过] {filename.name} wafers={wafer_count or '原始'}：{error}"
                )
                continue
            if records:
                instances.append(records)
        if file_index % 10 == 0 or file_index == len(files):
            step_count = sum(len(records) for records in instances)
            print(
                f"[标签] 源文件 {file_index}/{len(files)}，"
                f"有效实例 {len(instances)}，决策步 {step_count}"
            )
    return instances


def _wavefront_reference_result(problem):
    """为互斥 PM 池生成各路线第 k 片同步推进的强教师结果。"""
    durations = Durations(problem)

    def wavefront_chooser(state, candidates):
        """按真实最早事件、路线内 wafer 序和下游深度构造稳定波前。"""
        return sorted(
            range(len(candidates)),
            key=lambda index: (
                float(candidates[index].start),
                int(state.wmap[candidates[index].wid].route_rank),
                -int(candidates[index].j),
                int(candidates[index].wid),
                (
                    int(state.ch_used.get(candidates[index].dest[0], 0))
                    if candidates[index].dest is not None
                    and state.ch_used is not None
                    else 0
                ),
                candidates[index].dest or ("", 0),
            ),
        )

    selected_wafers, orders = decode_orders_choosing(
        problem,
        durations,
        problem.wafers,
        chooser=wavefront_chooser,
        swap=True,
        trust_preferred_path=True,
        include_order_snapshots=False,
    )
    result = solve_timing(
        problem,
        selected_wafers,
        orders=orders,
        enforce_resumed_route_fifo=False,
    )
    if not getattr(result, "feasible", False):
        raise RuntimeError("拆分路线波前教师未生成可行排程")
    return result


def _collect_decomposition_instances(
    topology,
    seed: int,
) -> List[List[Step]]:
    """生成未包含 25片/300秒目标点的路线拆分增强场景。

    训练域改变 wafer 数、加工时长和 PM 配对，保留“多个独立 PM 池共享 Robot/LoadLock”
    这一组合结构。验收案例的 25 片、300 秒因此仍是组合外推，而非标签记忆。
    """
    instances: List[List[Step]] = []
    for layout_index, pair_layout in enumerate(DECOMPOSITION_PAIR_LAYOUTS):
        for wafer_count in DECOMPOSITION_WAFER_COUNTS:
            for process_time in DECOMPOSITION_PROCESS_TIMES:
                generator = random.Random(
                    seed
                    + layout_index * 10_000
                    + wafer_count * 100
                    + process_time
                )
                jobs = []
                for job_index, process_modules in enumerate(pair_layout):
                    job = JobSpec(
                        job_index,
                        generator,
                        pm_pool=process_modules,
                        stage_range=(1, 1),
                        clean=False,
                        proc_range=(process_time, process_time),
                    )
                    job.stages = [list(process_modules)]
                    job.proc_times = [process_time]
                    job.n_wafer = wafer_count
                    job.priority = 1
                    jobs.append(job)
                update = build_concurrent_update(
                    jobs,
                    generator,
                    n_levels=1,
                )
                try:
                    problem = parse_task(topology, update)
                    result = _wavefront_reference_result(problem)
                    records = extract_reference_ranked_steps(
                        problem,
                        result.schedule,
                    )
                except Exception as error:  # noqa: BLE001
                    print(
                        "[跳过] 拆分增强 "
                        f"layout={layout_index} wafers={wafer_count} "
                        f"process={process_time}：{error}"
                    )
                    continue
                if records:
                    instances.append(records)
    print(
        f"[拆分增强] 有效实例 {len(instances)}，"
        f"决策步 {sum(len(records) for records in instances)}"
    )
    return instances


def _realtime_residual_routes(process_time: int) -> Dict[str, Dict[str, Any]]:
    """构造四类重算增强共享的单工序与双工序 Route。

    加工时长取独立训练域，不复用前端验收矩阵的固定 120/60/100 秒组合。返回值
    使用语义键连接结构定义，实际 Route 名称包含时长以便日志可追溯。
    """
    from scripts.seed_neural_recompute_workspaces import _route

    first_ratios, second_ratios = REALTIME_RESIDUAL_MULTI_STAGE_RATIOS

    def scaled(ratio: float) -> int:
        """把阶段比例转换为至少一秒的整数加工时间。"""
        return max(1, int(round(process_time * ratio)))

    suffix = str(process_time)
    return {
        "single12": _route(
            f"Residual-Single12-T{suffix}",
            [(("PM1", "PM2"), process_time)],
        ),
        "single34": _route(
            f"Residual-Single34-T{suffix}",
            [(
                ("PM3", "PM4"),
                process_time + REALTIME_RESIDUAL_DISJOINT_TIME_OFFSET,
            )],
        ),
        "single1": _route(
            f"Residual-Single1-T{suffix}",
            [(
                ("PM1",),
                max(1, process_time - REALTIME_RESIDUAL_SINGLE_TIME_REDUCTION),
            )],
        ),
        "multi34": _route(
            f"Residual-Multi34-T{suffix}",
            [
                (("PM3",), scaled(first_ratios[0])),
                (("PM4",), scaled(first_ratios[1])),
            ],
        ),
        "multi13": _route(
            f"Residual-Multi13-T{suffix}",
            [
                (("PM1",), scaled(second_ratios[0])),
                (("PM3",), scaled(second_ratios[1])),
            ],
        ),
        "multi23": _route(
            f"Residual-Multi23-T{suffix}",
            [
                (("PM2",), scaled(second_ratios[1])),
                (("PM3",), scaled(second_ratios[0])),
            ],
        ),
    }


def _collect_realtime_residual_instances(
    seed: int,
    limit: int = 0,
) -> List[RealtimeResidualTrainingInstance]:
    """从两次在线重算后的残差问题收集 Heuristic 教师完整排序。

    参数：
        seed: 只控制训练域组合顺序和加工时长轮换，场景本身仍可确定复现。
        limit: 最多返回的残差实例数；``0`` 表示遍历完整训练域。

    返回：
        每个元素都含非空 ``RuntimeAvailability`` 和对应 ranked steps。函数只读取
        PSE300 设备文件并调用内存构建接口，不读取或写入前端工作区。
    """
    if limit < 0:
        raise ValueError("实时残差增强 limit 不能为负数")
    if ACCEPTANCE_RECOMPUTE_GAPS.intersection(
        REALTIME_RESIDUAL_RECOMPUTE_GAPS
    ):
        raise RuntimeError("实时残差训练 gap 不得包含前端验收点")
    if ACCEPTANCE_WAFER_COUNTS.intersection(
        REALTIME_RESIDUAL_WAFER_COUNTS
    ):
        raise RuntimeError("实时残差训练片数不得包含前端验收点")

    # 延迟导入前端的纯构造器和服务内存接口，使默认关闭时不增加训练启动耦合。
    from realtime_scheduler import server as scheduler_server
    from scripts.seed_neural_recompute_workspaces import _pjob, _round
    from src.schedule.realtime import RealtimeRescheduler

    device = json.loads(PSE300_DEVICE_PATH.read_text(encoding="utf-8"))
    domains = [
        (gap, wafer_count)
        for gap in REALTIME_RESIDUAL_RECOMPUTE_GAPS
        for wafer_count in REALTIME_RESIDUAL_WAFER_COUNTS
    ]
    random.Random(seed).shuffle(domains)
    instances: List[RealtimeResidualTrainingInstance] = []

    for domain_index, (gap, wafer_count) in enumerate(domains):
        process_time = REALTIME_RESIDUAL_PROCESS_TIMES[
            (domain_index + seed) % len(REALTIME_RESIDUAL_PROCESS_TIMES)
        ]
        routes_by_key = _realtime_residual_routes(process_time)
        for structure, route_keys in REALTIME_RESIDUAL_STRUCTURES:
            selected_route_keys = list(dict.fromkeys(route_keys))
            routes = [routes_by_key[key] for key in selected_route_keys]
            plan = {
                "device": device,
                "routes": routes,
                "recipes": scheduler_server._batch_test_recipes(routes, []),
                "cleans": [],
            }
            build_state = scheduler_server.BuildState()
            rounds = []
            for round_index, (route_key, load_port) in enumerate(
                zip(route_keys, ("LP1", "LP2", "LP3")),
                start=1,
            ):
                current_time = (round_index - 1) * gap
                round_config = _round(
                    current_time,
                    (
                        _pjob(
                            str(routes_by_key[route_key]["name"]),
                            load_port,
                            wafer_count,
                        ),
                    ),
                )
                cjob = round_config["cjobs"][0]
                cjob["taskId"] = (
                    f"Residual-{structure}-D{domain_index}-R{round_index}"
                )
                cjob["pjobs"][0]["jobName"] = "P1"
                rounds.append(round_config)

            try:
                first_update = scheduler_server.build_round_update(
                    plan,
                    rounds[0],
                    0.0,
                    build_state,
                )
                scheduler = RealtimeRescheduler(
                    device,
                    first_update,
                    first_update,
                    strategy="heuristic",
                )

                # 两次都按真实控制链投影旧动作；每个重算态都作为独立实例，覆盖
                # “旧批次 + 一批新增”和“旧批次 + 两批新增”两种常见残差分布。
                for recompute_index, round_config in enumerate(
                    rounds[1:],
                    start=1,
                ):
                    requested_time = float(round_config["currentTime"])
                    recovery = scheduler_server.advance_to_recompute(
                        scheduler,
                        requested_time,
                    )
                    new_update = scheduler_server.build_round_update(
                        plan,
                        round_config,
                        requested_time,
                        build_state,
                    )
                    scheduler.recompute(
                        new_update,
                        recovery.recovery_end,
                        cutoff_time=requested_time,
                        schedule_start_time=requested_time,
                        material_ready_times=recovery.material_ready_times,
                        reason="离线实时残差增强",
                    )

                    problem = scheduler.problem
                    availability = problem.runtime_availability
                    if availability is None:
                        raise RuntimeError(
                            f"第 {recompute_index} 次重算没有生成 RuntimeAvailability"
                        )
                    teacher_result = start_schedule(problem, verbose=False)
                    if not getattr(teacher_result, "feasible", False):
                        raise RuntimeError("Heuristic 残差教师未生成可行排程")
                    records = extract_reference_ranked_steps(
                        problem,
                        teacher_result.schedule,
                    )
                    if records:
                        instances.append(RealtimeResidualTrainingInstance(
                            structure=structure,
                            recompute_gap=gap,
                            recompute_index=recompute_index,
                            wafer_count=wafer_count,
                            teacher="heuristic",
                            runtime_availability=deepcopy(availability),
                            records=records,
                        ))
                    if limit > 0 and len(instances) >= limit:
                        print(
                            f"[实时残差增强] 有效实例 {len(instances)}，"
                            f"决策步 {sum(len(item.records) for item in instances)}"
                        )
                        return instances
            except Exception as error:  # noqa: BLE001
                print(
                    "[跳过] 实时残差增强 "
                    f"structure={structure} gap={gap} wafers={wafer_count}："
                    f"{error}"
                )
                continue

    print(
        f"[实时残差增强] 有效实例 {len(instances)}，"
        f"决策步 {sum(len(item.records) for item in instances)}"
    )
    return instances


def _collect_six_pm_long_residual_instances(
    seed: int,
    limit: int = 0,
) -> List[RealtimeResidualTrainingInstance]:
    """采集六腔长负载残差态，并在 Heuristic 与同步波前教师中逐态取优。

    训练域避开长途验收的 600 秒、1200 秒和 5 片组合。每个场景真实运行五轮，
    前两轮的稀疏装载与后续积压态都会被标注，使网络能从当前在制品和资源释放
    下界学习何时批量装载、何时切换到防饥饿波前，而不依赖已知未来到达时刻。
    """
    if limit < 0:
        raise ValueError("六腔长途增强 limit 不能为负数")
    if ACCEPTANCE_LONG_PROCESS_TIME in SIX_PM_LONG_PROCESS_TIMES:
        raise RuntimeError("六腔长途训练加工时长不得包含验收点")
    if ACCEPTANCE_LONG_RECOMPUTE_GAP in SIX_PM_LONG_RECOMPUTE_GAPS:
        raise RuntimeError("六腔长途训练 gap 不得包含验收点")
    if ACCEPTANCE_LONG_WAFER_COUNT in SIX_PM_LONG_WAFER_COUNTS:
        raise RuntimeError("六腔长途训练片数不得包含验收点")

    from realtime_scheduler import server as scheduler_server
    from scripts.benchmark_neural_route_decomposition import six_pm_device
    from scripts.seed_neural_recompute_workspaces import (
        _pjob,
        _round,
        _route,
    )
    from src.schedule.neural import start_schedule_neural
    from src.schedule.realtime import RealtimeRescheduler

    network_teacher = load_neural_policy(DEFAULT_MODEL_PATH)
    domains = [
        (process_time, gap, wafer_count)
        for process_time in SIX_PM_LONG_PROCESS_TIMES
        for gap in SIX_PM_LONG_RECOMPUTE_GAPS
        for wafer_count in SIX_PM_LONG_WAFER_COUNTS
    ]
    random.Random(seed).shuffle(domains)
    instances: List[RealtimeResidualTrainingInstance] = []
    pair_pools = (
        ("PM1", "PM2"),
        ("PM3", "PM4"),
        ("PM5", "PM6"),
    )

    for domain_index, (process_time, gap, wafer_count) in enumerate(domains):
        routes = [
            _route(
                f"LongResidual-Pair{pair_index}-T{process_time}",
                [(pool, process_time)],
            )
            for pair_index, pool in enumerate(pair_pools, start=1)
        ]
        plan = {
            "device": six_pm_device(),
            "routes": routes,
            "recipes": scheduler_server._batch_test_recipes(routes, []),
            "cleans": [],
        }
        build_state = scheduler_server.BuildState()
        rounds = []
        for round_index in range(SIX_PM_LONG_ROUND_COUNT):
            round_config = _round(
                round_index * gap,
                tuple(
                    _pjob(
                        str(route["name"]),
                        f"LP{route_index}",
                        wafer_count,
                    )
                    for route_index, route in enumerate(routes, start=1)
                ),
                separate_cjobs=True,
            )
            for route_index, cjob in enumerate(
                round_config["cjobs"],
                start=1,
            ):
                cjob["taskId"] = (
                    f"LongResidual-D{domain_index}-R{round_index + 1}-"
                    f"C{route_index}"
                )
                cjob["pjobs"][0]["jobName"] = "P1"
            rounds.append(round_config)

        try:
            first_update = scheduler_server.build_round_update(
                plan,
                rounds[0],
                0.0,
                build_state,
            )
            scheduler = RealtimeRescheduler(
                plan["device"],
                first_update,
                first_update,
                strategy="heuristic",
            )
            for recompute_index, round_config in enumerate(
                rounds[1:],
                start=1,
            ):
                requested_time = float(round_config["currentTime"])
                recovery = scheduler_server.advance_to_recompute(
                    scheduler,
                    requested_time,
                )
                new_update = scheduler_server.build_round_update(
                    plan,
                    round_config,
                    requested_time,
                    build_state,
                )
                scheduler.recompute(
                    new_update,
                    recovery.recovery_end,
                    cutoff_time=requested_time,
                    schedule_start_time=requested_time,
                    material_ready_times=recovery.material_ready_times,
                    reason="离线六腔长途增强",
                )

                problem = scheduler.problem
                availability = problem.runtime_availability
                if availability is None:
                    raise RuntimeError("六腔残差态缺少 RuntimeAvailability")
                heuristic_result = start_schedule(problem, verbose=False)
                if not getattr(heuristic_result, "feasible", False):
                    raise RuntimeError("六腔 Heuristic 教师未生成可行排程")
                teacher_result = heuristic_result
                teacher_name = "heuristic"
                try:
                    wavefront_result = start_schedule_neural(
                        problem,
                        policy=network_teacher,
                        fallback_on_failure=False,
                        loadlock_manager_mode="joint",
                    )
                    if (
                        getattr(wavefront_result, "feasible", False)
                        and float(wavefront_result.makespan)
                        < float(teacher_result.makespan) - 1e-9
                    ):
                        teacher_result = wavefront_result
                        teacher_name = "neural-wavefront"
                except Exception as error:  # noqa: BLE001
                    print(
                        "[六腔长途增强] 网络波前教师不可用，保留 Heuristic："
                        f"{error}"
                    )
                records = extract_reference_ranked_steps(
                    problem,
                    teacher_result.schedule,
                )
                if records:
                    instances.append(RealtimeResidualTrainingInstance(
                        structure="six-pm-long",
                        recompute_gap=gap,
                        recompute_index=recompute_index,
                        wafer_count=wafer_count,
                        teacher=teacher_name,
                        runtime_availability=deepcopy(availability),
                        records=records,
                    ))
                if limit > 0 and len(instances) >= limit:
                    print(
                        f"[六腔长途增强] 有效实例 {len(instances)}，"
                        f"决策步 {sum(len(item.records) for item in instances)}"
                    )
                    return instances
        except Exception as error:  # noqa: BLE001
            print(
                "[跳过] 六腔长途增强 "
                f"process={process_time} gap={gap} wafers={wafer_count}："
                f"{error}"
            )

    print(
        f"[六腔长途增强] 有效实例 {len(instances)}，"
        f"决策步 {sum(len(item.records) for item in instances)}"
    )
    return instances


def _split_instances(
    instances: Sequence[List[Step]],
    validation_fraction: float,
    seed: int,
) -> Tuple[List[Step], List[Step]]:
    """按实例而非按决策步切分，避免同一 Recipe 轨迹泄漏到验证集。"""
    if len(instances) < 2:
        raise ValueError("至少需要两个有效训练实例")
    indices = np.random.default_rng(seed).permutation(len(instances))
    validation_count = max(1, int(round(len(instances) * validation_fraction)))
    validation_ids = set(indices[:validation_count].tolist())
    training = [
        step
        for instance_index, records in enumerate(instances)
        if instance_index not in validation_ids
        for step in records
    ]
    validation = [
        step
        for instance_index, records in enumerate(instances)
        if instance_index in validation_ids
        for step in records
    ]
    if not training or not validation:
        raise ValueError("训练集或验证集为空")
    return training, validation


def _normalization(steps: Iterable[Step]) -> Tuple[np.ndarray, np.ndarray]:
    """只用训练集真实候选行计算特征标准化参数。"""
    rows = np.concatenate([features for features, _ in steps], axis=0)
    mean = rows.mean(axis=0, dtype=np.float64).astype(np.float32)
    std = rows.std(axis=0, dtype=np.float64).astype(np.float32)
    std[std < MINIMUM_STANDARD_DEVIATION] = 1.0
    return mean, std


def _batch(
    steps: Sequence[Step],
    indices: Sequence[int],
    mean: np.ndarray,
    std: np.ndarray,
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """把一个变长候选批次动态 padding 为 Torch 张量。"""
    candidate_limit = max(steps[index][0].shape[0] for index in indices)
    features = np.zeros(
        (len(indices), candidate_limit, FEATURE_DIMENSION),
        dtype=np.float32,
    )
    mask = np.zeros((len(indices), candidate_limit), dtype=np.float32)
    expert = np.zeros(len(indices), dtype=np.int64)
    rankings = np.full(
        (len(indices), candidate_limit),
        candidate_limit,
        dtype=np.int64,
    )
    importance = np.ones(len(indices), dtype=np.float32)
    for row_index, step_index in enumerate(indices):
        rows, teacher_ranking = steps[step_index]
        candidate_count = rows.shape[0]
        features[row_index, :candidate_count] = (rows - mean) / std
        mask[row_index, :candidate_count] = 1.0
        rankings[row_index, :candidate_count] = teacher_ranking
        selected = int(np.argmin(teacher_ranking))
        expert[row_index] = selected
        remaining_horizon = 1.0 - float(
            rows[selected, int(Feature.GLOBAL_PROGRESS)]
        )
        cross_route_release = (
            rows[selected, int(Feature.RELEASE)] > 0.5
            and np.ptp(rows[:, int(Feature.ROUTE_WORK)]) > 1e-6
        )
        has_cleaning = any(
            rows[selected, int(feature)] > 0.5
            for feature in (
                Feature.PRE_CLEAN_PRESENT,
                Feature.POST_CLEAN_PRESENT,
                Feature.PERIODIC_CLEAN_PRESENT,
                Feature.DUMMY_CLEAN_PRESENT,
            )
        )
        has_multiple_routes = (
            rows[selected, int(Feature.ROUTE_COUNT)]
            > (1.0 / REFERENCE_ROUTE_COUNT) + 1e-6
        )
        importance[row_index] = (
            1.0
            + EARLY_DECISION_WEIGHT * remaining_horizon
            + CROSS_ROUTE_RELEASE_WEIGHT * float(cross_route_release)
            + CLEANING_SAMPLE_WEIGHT * float(has_cleaning)
            + MULTI_ROUTE_SAMPLE_WEIGHT * float(has_multiple_routes)
        )
    return (
        torch.from_numpy(features),
        torch.from_numpy(mask),
        torch.from_numpy(expert),
        torch.from_numpy(rankings),
        torch.from_numpy(importance),
    )


def _supervised_loss(
    logits: torch.Tensor,
    expert: torch.Tensor,
    rankings: torch.Tensor,
    mask: torch.Tensor,
    importance: torch.Tensor,
    ranking_weight: float,
) -> torch.Tensor:
    """组合首选动作交叉熵与完整候选顺序的成对排序损失。"""
    top_choice_losses = functional.cross_entropy(logits, expert, reduction="none")
    top_choice_loss = (
        top_choice_losses * importance
    ).sum() / importance.sum().clamp_min(1.0)
    valid = mask > 0.5
    better_pair = (
        (rankings.unsqueeze(2) < rankings.unsqueeze(1))
        & valid.unsqueeze(2)
        & valid.unsqueeze(1)
    )
    if not bool(better_pair.any()):
        return top_choice_loss
    score_difference = logits.unsqueeze(2) - logits.unsqueeze(1)
    pairwise_values = functional.softplus(-score_difference) * better_pair
    pair_counts = better_pair.sum(dim=(1, 2)).clamp_min(1)
    pairwise_by_step = pairwise_values.sum(dim=(1, 2)) / pair_counts
    pairwise_loss = (
        pairwise_by_step * importance
    ).sum() / importance.sum().clamp_min(1.0)
    return top_choice_loss + ranking_weight * pairwise_loss


def _evaluate(
    model: TrainableSetAttentionNetwork,
    steps: Sequence[Step],
    mean: np.ndarray,
    std: np.ndarray,
    batch_size: int,
    ranking_weight: float,
) -> Tuple[float, float]:
    """返回验证监督损失和逐步 top-1 准确率。"""
    model.eval()
    losses = []
    correct = 0
    with torch.no_grad():
        for start in range(0, len(steps), batch_size):
            indices = list(range(start, min(start + batch_size, len(steps))))
            features, mask, expert, rankings, importance = _batch(
                steps,
                indices,
                mean,
                std,
            )
            logits = model(features, mask)
            losses.append(
                float(
                    _supervised_loss(
                        logits,
                        expert,
                        rankings,
                        mask,
                        importance,
                        ranking_weight,
                    )
                )
                * len(indices)
            )
            correct += int((logits.argmax(dim=1) == expert).sum())
    return sum(losses) / len(steps), correct / len(steps)


def _save_checkpoint(
    path: Path,
    model: TrainableSetAttentionNetwork,
    mean: np.ndarray,
    std: np.ndarray,
    training_instances: int,
    training_steps: int,
    validation_accuracy: float,
    teacher: str,
) -> None:
    """保存仅含数值数组和标量元数据的安全推理 checkpoint。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        schema=np.asarray(MODEL_SCHEMA_VERSION),
        input_weights=model.input_weights.detach().numpy().astype(np.float32),
        input_bias=model.input_bias.detach().numpy().astype(np.float32),
        query_weights=model.query_weights.detach().numpy().astype(np.float32),
        key_weights=model.key_weights.detach().numpy().astype(np.float32),
        value_weights=model.value_weights.detach().numpy().astype(np.float32),
        attention_output_weights=(
            model.attention_output_weights.detach().numpy().astype(np.float32)
        ),
        feed_forward_input_weights=(
            model.feed_forward_input_weights.detach().numpy().astype(np.float32)
        ),
        feed_forward_input_bias=(
            model.feed_forward_input_bias.detach().numpy().astype(np.float32)
        ),
        feed_forward_output_weights=(
            model.feed_forward_output_weights.detach().numpy().astype(np.float32)
        ),
        feed_forward_output_bias=(
            model.feed_forward_output_bias.detach().numpy().astype(np.float32)
        ),
        score_weights=model.score_weights.detach().numpy().astype(np.float32),
        score_bias=model.score_bias.detach().numpy().astype(np.float32),
        score_output=model.score_output.detach().numpy().astype(np.float32),
        feature_mean=mean.astype(np.float32),
        feature_std=std.astype(np.float32),
        training_instances=np.asarray(training_instances, dtype=np.int64),
        training_steps=np.asarray(training_steps, dtype=np.int64),
        validation_accuracy=np.asarray(validation_accuracy, dtype=np.float32),
        teacher=np.asarray(f"{teacher}-listwise"),
    )


def _initialize_from_checkpoint(
    model: TrainableSetAttentionNetwork,
    path: Path,
    mean: np.ndarray,
    std: np.ndarray,
) -> None:
    """载入生产 checkpoint，并补偿新训练集标准化变化以保持初始函数不变。"""
    policy = load_neural_policy(path)
    parameter_names = (
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
    old_input_weights = policy.input_weights
    normalization_scale = std / policy.feature_std
    normalization_shift = (
        mean - policy.feature_mean
    ) / policy.feature_std
    with torch.no_grad():
        model.input_weights.copy_(
            torch.from_numpy(
                old_input_weights * normalization_scale[:, None]
            )
        )
        model.input_bias.copy_(
            torch.from_numpy(
                policy.input_bias
                + normalization_shift @ old_input_weights
            )
        )
        for name in parameter_names:
            getattr(model, name).copy_(
                torch.from_numpy(getattr(policy, name))
            )
    print(f"[初始化] 保持函数等价地载入 {path}")


def main() -> None:
    """解析命令行、抽取多场景标签、训练并保存最佳验证模型。"""
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(
            sys.stdout.buffer,
            encoding="utf-8",
            line_buffering=True,
            write_through=True,
        )
    parser = argparse.ArgumentParser()
    parser.add_argument("--globs", nargs="+", default=list(DEFAULT_GLOBS))
    parser.add_argument("--max-source-files", type=int, default=0)
    parser.add_argument(
        "--wafer-counts",
        nargs="+",
        type=int,
        default=[0, 5, 12, 25],
        help="0 表示保留原始片数；使用 MILP teacher 时只允许 0",
    )
    parser.add_argument(
        "--teacher",
        choices=("strong", "baseline", "milp"),
        default="strong",
        help="strong=原始场景取 MILP/baseline 较优者，扩展片数使用 baseline",
    )
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=5e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-5)
    parser.add_argument(
        "--ranking-weight",
        type=float,
        default=0.2,
        help="完整候选顺序损失相对首选动作交叉熵的权重",
    )
    parser.add_argument("--validation-fraction", type=float, default=0.15)
    parser.add_argument("--patience", type=int, default=40)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--output", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument(
        "--initialize-from",
        type=Path,
        default=None,
        help="从已有安全 checkpoint 微调；自动补偿新特征标准化",
    )
    parser.add_argument(
        "--decomposition-augmentation",
        action="store_true",
        help="加入独立 PM 池共享 LoadLock 的路线拆分增强场景",
    )
    parser.add_argument(
        "--realtime-residual-augmentation",
        action="store_true",
        help="加入两次在线重算后带资源释放下界的残差状态增强场景",
    )
    parser.add_argument(
        "--realtime-residual-limit",
        type=int,
        default=0,
        help="实时残差增强最大实例数；0 表示完整训练域",
    )
    parser.add_argument(
        "--six-pm-long-augmentation",
        action="store_true",
        help="加入非验收参数的五轮六腔长负载强教师残差场景",
    )
    parser.add_argument(
        "--six-pm-long-limit",
        type=int,
        default=0,
        help="六腔长负载增强最大残差实例数；0 表示完整训练域",
    )
    args = parser.parse_args()

    if any(count < 0 for count in args.wafer_counts):
        parser.error("--wafer-counts 不能包含负数")
    if not 0.0 < args.validation_fraction < 1.0:
        parser.error("--validation-fraction 必须位于 0 与 1 之间")
    if args.ranking_weight < 0.0:
        parser.error("--ranking-weight 不能为负数")
    if args.realtime_residual_limit < 0:
        parser.error("--realtime-residual-limit 不能为负数")
    if args.six_pm_long_limit < 0:
        parser.error("--six-pm-long-limit 不能为负数")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    files = _source_files(args.globs, args.max_source_files, args.seed)
    if not files:
        raise SystemExit("没有找到训练场景")
    print(f"[数据] 源文件 {len(files)}，片数域 {args.wafer_counts}，teacher={args.teacher}")
    instances = _collect_instances(files, args.wafer_counts, args.teacher)
    if args.decomposition_augmentation:
        topology, _ = load_alg_entries(input_data_path(BASE_TOPOLOGY))
        topology = expand_topo_pms(topology, PM_POOL_6)
        instances.extend(
            _collect_decomposition_instances(
                topology,
                args.seed,
            )
        )
    if args.realtime_residual_augmentation:
        residual_instances = _collect_realtime_residual_instances(
            args.seed,
            args.realtime_residual_limit,
        )
        instances.extend(
            instance.records
            for instance in residual_instances
        )
    if args.six_pm_long_augmentation:
        long_instances = _collect_six_pm_long_residual_instances(
            args.seed,
            args.six_pm_long_limit,
        )
        instances.extend(
            instance.records
            for instance in long_instances
        )
    training, validation = _split_instances(
        instances,
        args.validation_fraction,
        args.seed,
    )
    mean, std = _normalization(training)
    print(
        f"[样本] 实例 {len(instances)}，训练步 {len(training)}，"
        f"验证步 {len(validation)}"
    )

    model = TrainableSetAttentionNetwork()
    if args.initialize_from is not None:
        _initialize_from_checkpoint(
            model,
            args.initialize_from,
            mean,
            std,
        )
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    generator = np.random.default_rng(args.seed)
    best_accuracy = -1.0
    best_loss = float("inf")
    best_state = None
    if args.initialize_from is not None:
        best_loss, best_accuracy = _evaluate(
            model,
            validation,
            mean,
            std,
            args.batch_size,
            args.ranking_weight,
        )
        best_state = {
            name: value.detach().clone()
            for name, value in model.state_dict().items()
        }
        print(
            f"[训练] epoch=  0 val_loss={best_loss:.4f} "
            f"val_top1={best_accuracy:.3f}"
        )
    stale_epochs = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        permutation = generator.permutation(len(training))
        for start in range(0, len(training), args.batch_size):
            indices = permutation[start:start + args.batch_size].tolist()
            features, mask, expert, rankings, importance = _batch(
                training,
                indices,
                mean,
                std,
            )
            loss = _supervised_loss(
                model(features, mask),
                expert,
                rankings,
                mask,
                importance,
                args.ranking_weight,
            )
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        validation_loss, validation_accuracy = _evaluate(
            model,
            validation,
            mean,
            std,
            args.batch_size,
            args.ranking_weight,
        )
        improved = (
            validation_accuracy > best_accuracy
            or (
                abs(validation_accuracy - best_accuracy) <= 1e-12
                and validation_loss < best_loss
            )
        )
        if improved:
            best_accuracy = validation_accuracy
            best_loss = validation_loss
            best_state = {
                name: value.detach().clone()
                for name, value in model.state_dict().items()
            }
            stale_epochs = 0
        else:
            stale_epochs += 1
        if epoch == 1 or epoch % 10 == 0:
            print(
                f"[训练] epoch={epoch:>3} val_loss={validation_loss:.4f} "
                f"val_top1={validation_accuracy:.3f} best={best_accuracy:.3f}"
            )
        if stale_epochs >= args.patience:
            print(f"[训练] 连续 {args.patience} 轮未改善，提前停止")
            break

    if best_state is None:
        raise RuntimeError("训练未产生可保存模型")
    model.load_state_dict(best_state)
    _save_checkpoint(
        args.output,
        model,
        mean,
        std,
        len(instances),
        len(training),
        best_accuracy,
        "+".join([
            args.teacher,
            *(
                ["route-decomposition"]
                if args.decomposition_augmentation
                else []
            ),
            *(
                ["realtime-residual"]
                if args.realtime_residual_augmentation
                else []
            ),
            *(
                ["six-pm-long"]
                if args.six_pm_long_augmentation
                else []
            ),
        ]),
    )
    print(
        f"[完成] val_top1={best_accuracy:.3f}，参数="
        f"{SetAttentionNetwork().parameter_count}，模型={args.output}"
    )


if __name__ == "__main__":
    main()
