"""深层集合注意力神经派工策略。

每个调度事件只需要回答“当前候选中下一步搬哪片、送往哪个 LoadLock”。本模块先把
联合候选编码成无量纲物理特征，再用不带位置编码的集合注意力网络比较候选；完整轨迹、
小规模 Petri 重试和有预算物理修复分层保证离散可达性，``solve_timing`` 负责精确定时
和驻留约束。训练阶段可长时间使用多场景教师搜索，生产端只加载纯 NumPy checkpoint，
不依赖 Torch，也不做无界在线搜索。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

import numpy as np

from src.export import check_solution
from src.parse.model import Durations, Problem
from src.timing._common import _DecodeDeadlock, SKIP_TYPES
from src.timing.solve import SolveResult, solve_timing
from src.timing.spans import _ll_proc, _stage_dwell

from .loadlock_dispatch import (
    LoadLockDispatchManager,
    resolve_loadlock_manager,
)
from .sequencing import decode_orders, decode_orders_choosing


MODEL_DIMENSION = 48
ATTENTION_HEADS = 4
ATTENTION_LAYERS = 3
FEED_FORWARD_DIMENSION = 96
SCORE_DIMENSION = 24
MODEL_SCHEMA_VERSION = "deep-set-dispatch-v2"
DEFAULT_MODEL_PATH = Path(__file__).with_name("neural_policy.npz")
NUMERICAL_EPSILON = 1e-9
RESIDENCY_URGENCY_LIMIT = 2.0
UNKNOWN_REFERENCE_TIME = 1e30
LAYER_NORMALIZATION_EPSILON = 1e-5
INITIALIZATION_SEED = 20260723
REFERENCE_BATCH_SIZE = 25
REFERENCE_ROUTE_COUNT = 4
REFERENCE_PIPELINE_DEPTH = 6
SPARSE_STARTUP_MAX_MACHINE_BATCHES = 4
# 完整 Petri 终态搜索的成本随晶圆数快速上升；离线跨规模基准显示 50 片已会把
# 失败恢复拖到 4–6 秒，因此生产路径只允许小批量使用它。
FULL_PETRI_RETRY_MAX_WAFERS = 24
STRUCTURED_PETRI_REPAIR_MAX_WAFERS = 128
FORCED_QUALITY_FLOOR_MINIMUM_GAIN = 0.01


class Feature(IntEnum):
    """候选 hop 的稳定、无量纲特征位置。"""

    GLOBAL_PROGRESS = 0
    OCCUPANCY = 1
    CANDIDATE_DENSITY = 2
    ENTER_PROCESS_SHARE = 3
    EXIT_PROCESS_SHARE = 4
    STAGE_PROGRESS = 5
    RELATIVE_START = 6
    EARLIEST = 7
    PICK_FROM_PROCESS = 8
    PLACE_INTO_PROCESS = 9
    DESTINATION_LOADLOCK = 10
    RELEASE = 11
    COMPLETE = 12
    RESIDENCY_URGENCY = 13
    HAS_RESIDENCY = 14
    CURRENT_PROCESS = 15
    NEXT_PROCESS = 16
    REMAINING_WORK = 17
    ROUTE_WORK = 18
    ROBOT_READY = 19
    FREE_PARALLEL_CAPACITY = 20
    SAME_DESTINATION_PRESSURE = 21
    ROUTE_RELEASE_PROGRESS = 22
    ROUTE_WIP_LOAD = 23
    CURRENT_LOADLOCK = 24
    CLEANING_LOAD = 25
    DUMMY_WAFER = 26
    ALREADY_RELEASED = 27
    JOB_TYPE = 28
    BUSINESS_PRIORITY = 29
    DESTINATION_LOAD = 30
    ROUTE_COUNT = 31
    WAFER_SCALE = 32
    PIPELINE_DEPTH = 33
    CAPACITY_PRESSURE = 34
    PRE_CLEAN_PRESENT = 35
    POST_CLEAN_PRESENT = 36
    PERIODIC_CLEAN_PRESENT = 37
    DUMMY_CLEAN_PRESENT = 38


FEATURE_DIMENSION = len(Feature)


@dataclass(frozen=True)
class _FeatureContext:
    """一个排程实例内可复用的静态归一化量。"""

    route_work: Dict[str, float]
    route_totals: Dict[str, int]
    remaining_work: Dict[tuple[int, int], float]
    maximum_route_work: float
    maximum_process_time: float
    maximum_priority: int
    resource_capacity: int
    wafer_count: int
    route_count: int
    maximum_stage_count: int
    has_pre_clean: bool
    has_post_clean: bool
    has_periodic_clean: bool
    has_dummy_clean: bool


@dataclass(frozen=True)
class _BalancedWavefront:
    """互不共享加工腔的等负载路线族及其局部 wafer 次序。"""

    rank_by_wafer: Dict[int, int]
    capacity_by_wafer: Dict[int, int]
    family_count: int
    maximum_machine_batches: int
    process_time: float


class SetAttentionNetwork:
    """对变长候选集合打分的深层置换等变网络。

    三层多头自注意力显式建模“发片、填腔、出腔”候选间的竞争。网络没有位置编码，
    所以重排输入候选只会同样重排输出分数；候选数量也不固定。
    """

    def __init__(
        self,
        *,
        input_weights: Optional[np.ndarray] = None,
        input_bias: Optional[np.ndarray] = None,
        query_weights: Optional[np.ndarray] = None,
        key_weights: Optional[np.ndarray] = None,
        value_weights: Optional[np.ndarray] = None,
        attention_output_weights: Optional[np.ndarray] = None,
        feed_forward_input_weights: Optional[np.ndarray] = None,
        feed_forward_input_bias: Optional[np.ndarray] = None,
        feed_forward_output_weights: Optional[np.ndarray] = None,
        feed_forward_output_bias: Optional[np.ndarray] = None,
        score_weights: Optional[np.ndarray] = None,
        score_bias: Optional[np.ndarray] = None,
        score_output: Optional[np.ndarray] = None,
        feature_mean: Optional[np.ndarray] = None,
        feature_std: Optional[np.ndarray] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """创建网络；未给权重时使用固定种子的 Xavier 初始化。"""
        initial = _initial_weights()
        supplied = {
            "input_weights": input_weights,
            "input_bias": input_bias,
            "query_weights": query_weights,
            "key_weights": key_weights,
            "value_weights": value_weights,
            "attention_output_weights": attention_output_weights,
            "feed_forward_input_weights": feed_forward_input_weights,
            "feed_forward_input_bias": feed_forward_input_bias,
            "feed_forward_output_weights": feed_forward_output_weights,
            "feed_forward_output_bias": feed_forward_output_bias,
            "score_weights": score_weights,
            "score_bias": score_bias,
            "score_output": score_output,
        }
        for name, value in supplied.items():
            setattr(
                self,
                name,
                np.asarray(initial[name] if value is None else value, dtype=np.float32),
            )
        self.feature_mean = np.asarray(
            (
                np.zeros(FEATURE_DIMENSION, dtype=np.float32)
                if feature_mean is None
                else feature_mean
            ),
            dtype=np.float32,
        )
        self.feature_std = np.asarray(
            (
                np.ones(FEATURE_DIMENSION, dtype=np.float32)
                if feature_std is None
                else feature_std
            ),
            dtype=np.float32,
        )
        self.metadata = dict(metadata or {})
        self._validate_shapes()

    def _validate_shapes(self) -> None:
        """拒绝维度不匹配、非有限值或无效标准差。"""
        expected = {
            "input_weights": (FEATURE_DIMENSION, MODEL_DIMENSION),
            "input_bias": (MODEL_DIMENSION,),
            "query_weights": (
                ATTENTION_LAYERS,
                MODEL_DIMENSION,
                MODEL_DIMENSION,
            ),
            "key_weights": (
                ATTENTION_LAYERS,
                MODEL_DIMENSION,
                MODEL_DIMENSION,
            ),
            "value_weights": (
                ATTENTION_LAYERS,
                MODEL_DIMENSION,
                MODEL_DIMENSION,
            ),
            "attention_output_weights": (
                ATTENTION_LAYERS,
                MODEL_DIMENSION,
                MODEL_DIMENSION,
            ),
            "feed_forward_input_weights": (
                ATTENTION_LAYERS,
                MODEL_DIMENSION,
                FEED_FORWARD_DIMENSION,
            ),
            "feed_forward_input_bias": (
                ATTENTION_LAYERS,
                FEED_FORWARD_DIMENSION,
            ),
            "feed_forward_output_weights": (
                ATTENTION_LAYERS,
                FEED_FORWARD_DIMENSION,
                MODEL_DIMENSION,
            ),
            "feed_forward_output_bias": (
                ATTENTION_LAYERS,
                MODEL_DIMENSION,
            ),
            "score_weights": (MODEL_DIMENSION, SCORE_DIMENSION),
            "score_bias": (SCORE_DIMENSION,),
            "score_output": (SCORE_DIMENSION,),
            "feature_mean": (FEATURE_DIMENSION,),
            "feature_std": (FEATURE_DIMENSION,),
        }
        for name, shape in expected.items():
            value = getattr(self, name)
            if value.shape != shape:
                raise ValueError(f"神经模型 {name} 应为 {shape}，收到 {value.shape}")
            if not np.isfinite(value).all():
                raise ValueError(f"神经模型 {name} 包含 NaN 或无穷值")
        if np.any(self.feature_std <= 0.0):
            raise ValueError("神经模型 feature_std 必须全部为正数")

    @property
    def parameter_count(self) -> int:
        """返回实际参与前向计算的标量参数数量。"""
        names = (
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
        return int(sum(getattr(self, name).size for name in names))

    def score(self, features: np.ndarray) -> np.ndarray:
        """对 ``[候选数, 特征数]`` 矩阵返回逐候选优先级。"""
        values = np.asarray(features, dtype=np.float32)
        if values.ndim != 2 or values.shape[1] != FEATURE_DIMENSION:
            raise ValueError(
                f"神经候选特征应为 [N,{FEATURE_DIMENSION}]，收到 {values.shape}"
            )
        normalized = (values - self.feature_mean) / self.feature_std
        hidden = np.tanh(normalized @ self.input_weights + self.input_bias)
        head_dimension = MODEL_DIMENSION // ATTENTION_HEADS
        attention_scale = head_dimension ** -0.5
        for layer in range(ATTENTION_LAYERS):
            query = (hidden @ self.query_weights[layer]).reshape(
                len(hidden),
                ATTENTION_HEADS,
                head_dimension,
            ).transpose(1, 0, 2)
            key = (hidden @ self.key_weights[layer]).reshape(
                len(hidden),
                ATTENTION_HEADS,
                head_dimension,
            ).transpose(1, 0, 2)
            value = (hidden @ self.value_weights[layer]).reshape(
                len(hidden),
                ATTENTION_HEADS,
                head_dimension,
            ).transpose(1, 0, 2)
            attention_logits = (
                np.einsum("hnd,hmd->hnm", query, key) * attention_scale
            )
            attention = _softmax(attention_logits)
            message = np.einsum(
                "hnm,hmd->hnd",
                attention,
                value,
            ).transpose(1, 0, 2).reshape(len(hidden), MODEL_DIMENSION)
            hidden = _layer_normalize(
                hidden + message @ self.attention_output_weights[layer]
            )
            feed_forward = np.tanh(
                hidden @ self.feed_forward_input_weights[layer]
                + self.feed_forward_input_bias[layer]
            )
            hidden = _layer_normalize(
                hidden
                + feed_forward @ self.feed_forward_output_weights[layer]
                + self.feed_forward_output_bias[layer]
            )
        score_hidden = np.tanh(hidden @ self.score_weights + self.score_bias)
        return score_hidden @ self.score_output


def load_neural_policy(path: Path | str = DEFAULT_MODEL_PATH) -> SetAttentionNetwork:
    """安全读取纯数组 checkpoint，不反序列化 Python 对象。"""
    model_path = Path(path)
    if not model_path.is_file():
        raise FileNotFoundError(f"深层神经派工模型不存在：{model_path}")
    with np.load(model_path, allow_pickle=False) as checkpoint:
        schema = str(checkpoint["schema"].item())
        if schema != MODEL_SCHEMA_VERSION:
            raise ValueError(
                f"神经模型 schema={schema!r}，当前只支持 {MODEL_SCHEMA_VERSION!r}"
            )
        metadata = {
            "path": str(model_path.resolve()),
            "trainingInstances": int(checkpoint["training_instances"].item()),
            "validationAccuracy": float(checkpoint["validation_accuracy"].item()),
            "teacher": str(checkpoint["teacher"].item()),
        }
        if "training_steps" in checkpoint:
            metadata["trainingSteps"] = int(checkpoint["training_steps"].item())
        return SetAttentionNetwork(
            input_weights=checkpoint["input_weights"],
            input_bias=checkpoint["input_bias"],
            query_weights=checkpoint["query_weights"],
            key_weights=checkpoint["key_weights"],
            value_weights=checkpoint["value_weights"],
            attention_output_weights=checkpoint["attention_output_weights"],
            feed_forward_input_weights=checkpoint["feed_forward_input_weights"],
            feed_forward_input_bias=checkpoint["feed_forward_input_bias"],
            feed_forward_output_weights=checkpoint["feed_forward_output_weights"],
            feed_forward_output_bias=checkpoint["feed_forward_output_bias"],
            score_weights=checkpoint["score_weights"],
            score_bias=checkpoint["score_bias"],
            score_output=checkpoint["score_output"],
            feature_mean=checkpoint["feature_mean"],
            feature_std=checkpoint["feature_std"],
            metadata=metadata,
        )


def _xavier(
    generator: np.random.Generator,
    shape: tuple[int, ...],
    fan_in: int,
    fan_out: int,
) -> np.ndarray:
    """生成确定性的 Xavier 均匀初始化数组。"""
    limit = float(np.sqrt(6.0 / max(fan_in + fan_out, 1)))
    return generator.uniform(-limit, limit, size=shape).astype(np.float32)


def _initial_weights() -> Dict[str, np.ndarray]:
    """构造无外部依赖的确定性网络初值。"""
    generator = np.random.default_rng(INITIALIZATION_SEED)
    return {
        "input_weights": _xavier(
            generator,
            (FEATURE_DIMENSION, MODEL_DIMENSION),
            FEATURE_DIMENSION,
            MODEL_DIMENSION,
        ),
        "input_bias": np.zeros(MODEL_DIMENSION, dtype=np.float32),
        "query_weights": _xavier(
            generator,
            (ATTENTION_LAYERS, MODEL_DIMENSION, MODEL_DIMENSION),
            MODEL_DIMENSION,
            MODEL_DIMENSION,
        ),
        "key_weights": _xavier(
            generator,
            (ATTENTION_LAYERS, MODEL_DIMENSION, MODEL_DIMENSION),
            MODEL_DIMENSION,
            MODEL_DIMENSION,
        ),
        "value_weights": _xavier(
            generator,
            (ATTENTION_LAYERS, MODEL_DIMENSION, MODEL_DIMENSION),
            MODEL_DIMENSION,
            MODEL_DIMENSION,
        ),
        "attention_output_weights": _xavier(
            generator,
            (ATTENTION_LAYERS, MODEL_DIMENSION, MODEL_DIMENSION),
            MODEL_DIMENSION,
            MODEL_DIMENSION,
        ),
        "feed_forward_input_weights": _xavier(
            generator,
            (ATTENTION_LAYERS, MODEL_DIMENSION, FEED_FORWARD_DIMENSION),
            MODEL_DIMENSION,
            FEED_FORWARD_DIMENSION,
        ),
        "feed_forward_input_bias": np.zeros(
            (ATTENTION_LAYERS, FEED_FORWARD_DIMENSION),
            dtype=np.float32,
        ),
        "feed_forward_output_weights": _xavier(
            generator,
            (ATTENTION_LAYERS, FEED_FORWARD_DIMENSION, MODEL_DIMENSION),
            FEED_FORWARD_DIMENSION,
            MODEL_DIMENSION,
        ),
        "feed_forward_output_bias": np.zeros(
            (ATTENTION_LAYERS, MODEL_DIMENSION),
            dtype=np.float32,
        ),
        "score_weights": _xavier(
            generator,
            (MODEL_DIMENSION, SCORE_DIMENSION),
            MODEL_DIMENSION,
            SCORE_DIMENSION,
        ),
        "score_bias": np.zeros(SCORE_DIMENSION, dtype=np.float32),
        "score_output": _xavier(
            generator,
            (SCORE_DIMENSION,),
            SCORE_DIMENSION,
            1,
        ),
    }


def _layer_normalize(values: np.ndarray) -> np.ndarray:
    """沿候选嵌入维做无可训练仿射项的 LayerNorm。"""
    mean = values.mean(axis=-1, keepdims=True)
    variance = np.square(values - mean).mean(axis=-1, keepdims=True)
    return (values - mean) / np.sqrt(variance + LAYER_NORMALIZATION_EPSILON)


def _softmax(values: np.ndarray) -> np.ndarray:
    """沿最后一维计算数值稳定的 softmax。"""
    shifted = values - values.max(axis=-1, keepdims=True)
    exponential = np.exp(shifted)
    return exponential / exponential.sum(axis=-1, keepdims=True)


def _feature_context(problem: Problem) -> _FeatureContext:
    """预算实例级 Recipe 工作量和资源容量，供每一步快速抽特征。"""
    route_work: Dict[str, float] = {}
    route_totals: Dict[str, int] = {}
    remaining_work: Dict[tuple[int, int], float] = {}
    maximum_process_time = 1.0
    maximum_priority = 1
    maximum_stage_count = 1
    has_periodic_clean = False
    has_dummy_wafer = False
    touched_resources = set()
    for wafer in problem.wafers:
        total = float(sum(max(stage.proc, 0.0) for stage in wafer.stages))
        route_work[wafer.route_name] = max(route_work.get(wafer.route_name, 0.0), total)
        route_totals[wafer.route_name] = route_totals.get(wafer.route_name, 0) + 1
        maximum_priority = max(maximum_priority, int(wafer.cjob_priority))
        maximum_stage_count = max(maximum_stage_count, len(wafer.stages) - 1)
        has_dummy_wafer = has_dummy_wafer or (
            wafer.pjob_name.startswith("dummy_") or "_dummy_" in wafer.route_name
        )
        suffix = 0.0
        for stage_index in range(len(wafer.stages) - 1, -1, -1):
            stage = wafer.stages[stage_index]
            suffix += max(float(stage.proc), 0.0)
            remaining_work[(wafer.wid, stage_index)] = suffix
            maximum_process_time = max(maximum_process_time, float(stage.proc))
            has_periodic_clean = has_periodic_clean or (
                float(stage.clean_time) > 0.0 and int(stage.clean_trigger) > 0
            )
            chamber = problem.chambers.get(stage.chamber)
            if (
                chamber is not None
                and stage.stage_type not in {"source", "sink"}
                and str(chamber.type).lower() not in SKIP_TYPES
            ):
                touched_resources.add(stage.chamber)
    resource_capacity = max(
        sum(max(int(problem.chambers[name].capacity), 1) for name in touched_resources),
        1,
    )
    return _FeatureContext(
        route_work=route_work,
        route_totals=route_totals,
        remaining_work=remaining_work,
        maximum_route_work=max(route_work.values(), default=1.0) or 1.0,
        maximum_process_time=maximum_process_time,
        maximum_priority=maximum_priority,
        resource_capacity=resource_capacity,
        wafer_count=max(len(problem.wafers), 1),
        route_count=max(len(route_totals), 1),
        maximum_stage_count=maximum_stage_count,
        has_pre_clean=bool(problem.pre_clean),
        has_post_clean=bool(problem.post_clean),
        has_periodic_clean=has_periodic_clean,
        has_dummy_clean=bool(problem.dummy_wac) or has_dummy_wafer,
    )


def _balanced_disjoint_wavefront(problem: Problem) -> Optional[_BalancedWavefront]:
    """识别可以安全使用同步波前的对称、互斥加工腔路线族。

    若各路线族只有一道等时长加工工序、加工腔池两两不相交，且族间待加工片数相差
    不超过一片，则各族第 ``k`` 片同步推进不会牺牲任何加工腔容量。它还避免某一族
    连续占用共享 LoadLock，造成其他独立 PM 池饥饿。复杂清洁、多工序、共享 PM 或
    明显不平衡负载不满足这一充分条件，继续完全使用通用神经排序。
    """
    if (
        problem.pre_clean
        or problem.post_clean
        or problem.dummy_wac
        or len(problem.wafers) < 2
    ):
        return None

    families: Dict[frozenset[str], List[Any]] = {}
    common_process_time: Optional[float] = None
    for wafer in problem.wafers:
        process_stages = [
            stage for stage in wafer.stages if stage.stage_type == "process"
        ]
        if len(process_stages) != 1:
            # 已走完 PM、只剩出站动作的实时 token 不参与族负载判定；排序时把它放在
            # rank=-1 的排空前沿即可。
            if bool(wafer.already_released) and not process_stages:
                continue
            return None
        stage = process_stages[0]
        if float(stage.clean_time) > 0.0 or int(stage.clean_trigger) > 0:
            return None
        pool = frozenset(str(name) for name in (stage.cands or [stage.chamber]))
        if not pool:
            return None
        process_time = float(stage.proc)
        if common_process_time is None:
            common_process_time = process_time
        elif abs(process_time - common_process_time) > NUMERICAL_EPSILON:
            return None
        families.setdefault(pool, []).append(wafer)

    pools = list(families)
    if len(pools) < 2:
        return None
    occupied: set[str] = set()
    for pool in pools:
        if occupied.intersection(pool):
            return None
        occupied.update(pool)
    family_sizes = [len(families[pool]) for pool in pools]
    if not family_sizes or max(family_sizes) - min(family_sizes) > 1:
        return None

    rank_by_wafer: Dict[int, int] = {}
    capacity_by_wafer: Dict[int, int] = {}
    for pool in sorted(pools, key=lambda item: tuple(sorted(item))):
        # wid 由输入中 CJob/PJob/wafer 的业务顺序稳定生成；同一族跨多个 PJob 时继续
        # 沿用这一全局顺序，而不是让每个 PJob 的 route_rank 从零重新开始。
        for rank, wafer in enumerate(sorted(families[pool], key=lambda item: item.wid)):
            rank_by_wafer[int(wafer.wid)] = rank
            capacity_by_wafer[int(wafer.wid)] = max(len(pool), 1)
    return _BalancedWavefront(
        rank_by_wafer=rank_by_wafer,
        capacity_by_wafer=capacity_by_wafer,
        family_count=len(pools),
        maximum_machine_batches=max(
            (
                int(np.ceil(len(families[pool]) / max(len(pool), 1)))
                for pool in pools
            ),
            default=0,
        ),
        process_time=float(common_process_time or 0.0),
    )


def _needs_sparse_feed_startup(
    problem: Problem,
    wavefront: Optional[_BalancedWavefront],
) -> bool:
    """识别长加工、低批次数的启动瞬态，启用一次等配额填充专家。

    PM 尚未形成稳定流水时，逐片同步会让共享 LoadLock 频繁在三个独立族间切换；
    等配额 feed 可先填满并行 PM。只在每族不超过四个并行机批次时启用，进入饱和区
    后立即交还神经波前。长加工判据不使用未来到达时刻，而比较当前 PM 工作下界与
    25 片参考批次的 LoadLock 抽充气往返预算。
    """
    if (
        wavefront is None
        or wavefront.maximum_machine_batches <= 0
        or wavefront.maximum_machine_batches
        > SPARSE_STARTUP_MAX_MACHINE_BATCHES
    ):
        return False
    pressure_round_trip = max(
        (
            float(chamber.pump_time or 0.0)
            + float(chamber.vent_time or 0.0)
            for chamber in problem.chambers.values()
            if str(chamber.type).lower() == "loadlock"
        ),
        default=0.0,
    )
    if pressure_round_trip <= NUMERICAL_EPSILON:
        return False
    process_lower_bound = (
        wavefront.maximum_machine_batches * wavefront.process_time
    )
    pressure_reference_horizon = (
        REFERENCE_BATCH_SIZE * pressure_round_trip
    )
    return process_lower_bound > pressure_reference_horizon


def _candidate_features(state: Any, candidates: List[Any], context: _FeatureContext) -> np.ndarray:
    """把当前候选集合转换成含物理、拥塞和业务信号的无量纲矩阵。"""
    starts = np.asarray([float(candidate.start) for candidate in candidates], dtype=np.float64)
    start_minimum = float(starts.min())
    start_span = max(float(starts.max()) - start_minimum, NUMERICAL_EPSILON)
    robot_ready_values = np.asarray(
        [float(state.robot_free.get(candidate.rob, 0.0)) for candidate in candidates],
        dtype=np.float64,
    )
    robot_ready_minimum = float(robot_ready_values.min())
    robot_ready_span = max(
        float(robot_ready_values.max()) - robot_ready_minimum,
        NUMERICAL_EPSILON,
    )
    rows = np.zeros((len(candidates), FEATURE_DIMENSION), dtype=np.float32)
    occupancy = min(len(state.occ) / context.resource_capacity, 2.0)
    candidate_density = min(len(candidates) / context.resource_capacity, 2.0)
    enter_process_share = sum(
        state.wmap[candidate.wid].stages[candidate.j + 1].stage_type == "process"
        for candidate in candidates
    ) / len(candidates)
    exit_process_share = sum(
        state.wmap[candidate.wid].stages[candidate.j].stage_type == "process"
        for candidate in candidates
    ) / len(candidates)

    route_released_state = getattr(state, "route_released", None)
    route_wip_state = getattr(state, "route_wip", None)
    if route_released_state is not None and route_wip_state is not None:
        route_released = route_released_state
        route_wip = route_wip_state
    else:
        route_released = {}
        route_wip = {}
        for wafer_id, position in state.pos.items():
            wafer = state.wmap[wafer_id]
            released = position > 0 or bool(wafer.already_released)
            if released:
                route_released[wafer.route_name] = (
                    route_released.get(wafer.route_name, 0) + 1
                )
            if released and position < state.K[wafer_id]:
                route_wip[wafer.route_name] = route_wip.get(wafer.route_name, 0) + 1

    destination_counts: Dict[str, int] = {}
    for candidate in candidates:
        destination = candidate.dest[0] if candidate.dest is not None else "__sink__"
        destination_counts[destination] = destination_counts.get(destination, 0) + 1

    for row_index, candidate in enumerate(candidates):
        wafer = state.wmap[candidate.wid]
        stage_count = max(state.K[candidate.wid], 1)
        current = wafer.stages[candidate.j]
        following = wafer.stages[candidate.j + 1]
        pick_from_process = current.stage_type == "process"
        place_into_process = following.stage_type == "process"
        has_residency = pick_from_process and float(current.residency) > 0.0
        urgency = 0.0
        if has_residency:
            allowed = _stage_dwell(state.tm, wafer, candidate.j) + float(current.residency)
            occupied = float(candidate.start) - float(state.place_t[candidate.wid])
            urgency = float(
                np.clip(
                    occupied / max(allowed, NUMERICAL_EPSILON),
                    0.0,
                    RESIDENCY_URGENCY_LIMIT,
                )
            )
        route_work = context.route_work.get(wafer.route_name, 0.0)
        destination = candidate.dest[0] if candidate.dest is not None else "__sink__"
        parallel_chambers = list(following.cands or [following.chamber])
        parallel_capacity = max(
            sum(
                max(int(state.ir.chambers[chamber].capacity), 1)
                for chamber in parallel_chambers
                if chamber in state.ir.chambers
            ),
            1,
        )
        occupied_parallel_slots = sum(
            resource[0] in parallel_chambers for resource in state.occ
        )
        free_parallel_capacity = (
            max(parallel_capacity - occupied_parallel_slots, 0) / parallel_capacity
            if place_into_process
            else 0.0
        )
        route_total = max(context.route_totals.get(wafer.route_name, 1), 1)
        priority_denominator = max(context.maximum_priority - 1, 1)
        normalized_priority = float(
            np.clip(
                1.0
                - (max(int(wafer.cjob_priority), 1) - 1)
                / priority_denominator,
                0.0,
                1.0,
            )
        )
        cleaning_load = float(
            np.clip(
                (
                    max(float(current.clean_time), 0.0)
                    + max(float(following.clean_time), 0.0)
                )
                / context.maximum_process_time,
                0.0,
                2.0,
            )
        )
        is_dummy = wafer.pjob_name.startswith("dummy_") or "_dummy_" in wafer.route_name
        destination_process_time = max(float(following.proc), 0.0)
        if following.stage_type == "loadlock" and candidate.dest is not None:
            destination_process_time = max(
                float(_ll_proc(state.ir, candidate.dest[0], following.ll_type)),
                0.0,
            )
        chamber_load = 0.0
        chamber_usage = getattr(state, "ch_used", None)
        if candidate.dest is not None and chamber_usage is not None:
            destination_pool = list(following.cands or [candidate.dest[0]])
            loads = [int(chamber_usage.get(chamber, 0)) for chamber in destination_pool]
            lowest_load = min(loads, default=0)
            load_span = max(max(loads, default=0) - lowest_load, 1)
            chamber_load = (
                int(chamber_usage.get(candidate.dest[0], 0)) - lowest_load
            ) / load_span
        rows[row_index] = np.asarray(
            [
                state.placed / max(state.total, 1),
                occupancy,
                candidate_density,
                enter_process_share,
                exit_process_share,
                candidate.j / stage_count,
                (float(candidate.start) - start_minimum) / start_span,
                float(candidate.start <= start_minimum + NUMERICAL_EPSILON),
                float(pick_from_process),
                float(place_into_process),
                float(following.stage_type == "loadlock"),
                float(candidate.j == 0),
                float(candidate.j + 1 == state.K[candidate.wid]),
                urgency,
                float(has_residency),
                max(float(current.proc), 0.0) / context.maximum_process_time,
                destination_process_time / context.maximum_process_time,
                context.remaining_work[(candidate.wid, candidate.j)]
                / context.maximum_route_work,
                route_work / context.maximum_route_work,
                (
                    float(state.robot_free.get(candidate.rob, 0.0))
                    - robot_ready_minimum
                )
                / robot_ready_span,
                free_parallel_capacity,
                destination_counts[destination] / len(candidates),
                route_released.get(wafer.route_name, 0) / route_total,
                min(
                    route_wip.get(wafer.route_name, 0) / context.resource_capacity,
                    2.0,
                ),
                float(current.stage_type == "loadlock"),
                cleaning_load,
                float(is_dummy),
                float(wafer.already_released),
                float(np.clip(int(wafer.cjob_job_type) / 3.0, 0.0, 1.0)),
                normalized_priority,
                chamber_load,
                min(context.route_count / REFERENCE_ROUTE_COUNT, 2.0),
                min(
                    float(np.log1p(context.wafer_count))
                    / float(np.log1p(REFERENCE_BATCH_SIZE)),
                    2.0,
                ),
                min(
                    context.maximum_stage_count / REFERENCE_PIPELINE_DEPTH,
                    2.0,
                ),
                min(context.wafer_count / context.resource_capacity, 2.0),
                float(context.has_pre_clean),
                float(context.has_post_clean),
                float(context.has_periodic_clean),
                float(context.has_dummy_clean),
            ],
            dtype=np.float32,
        )
    return rows


def _network_chooser(
    network: SetAttentionNetwork,
    context: _FeatureContext,
    decision_counter: Optional[List[int]] = None,
    balanced_wavefront: Optional[_BalancedWavefront] = None,
    loadlock_manager: Optional[LoadLockDispatchManager] = None,
    *,
    capacity_window: bool = False,
):
    """把集合网络适配成安全解码器，并按需加入独立路线同步波前掩码。"""

    def choose(state: Any, candidates: List[Any]) -> List[int]:
        """按神经分数降序返回候选下标，并用物理键稳定处理浮点并列。"""
        # 单元素动作集没有决策熵，任何策略都只能选择它。跳过深网既不改变轨迹，也避免
        # 大批量流水线上为数千个强制动作支付 Python/NumPy 小矩阵调用开销。
        if len(candidates) == 1:
            return [0]
        if decision_counter is not None:
            decision_counter[0] += 1
        features = _candidate_features(state, candidates, context)
        if balanced_wavefront is not None:
            scores = network.score(features)

            def wavefront_key(index: int) -> tuple[Any, ...]:
                """先守住吞吐波前，再由网络解决同一物理前沿内的细粒度选择。"""
                candidate = candidates[index]
                destination_load = 0
                if candidate.dest is not None and state.ch_used is not None:
                    destination_load = int(
                        state.ch_used.get(candidate.dest[0], 0)
                    )
                rank = balanced_wavefront.rank_by_wafer.get(
                    int(candidate.wid),
                    -1,
                )
                family_capacity = balanced_wavefront.capacity_by_wafer.get(
                    int(candidate.wid),
                    1,
                )
                # 一个窗口恰好覆盖该族的一次并行机装载（双腔即 2 片）。跨窗口仍保持
                # majorization 波前，窗口内则让网络根据压力态、在制品和下游拥塞排序。
                # 相比逐片硬同步，这既限制路线饥饿，也允许学习批量化 LoadLock 服务。
                wave_index = (
                    rank // family_capacity
                    if rank >= 0
                    else -1
                )
                if capacity_window:
                    return (
                        float(candidate.start),
                        wave_index,
                        -int(candidate.j),
                        -float(scores[index]),
                        rank,
                        destination_load,
                        int(candidate.wid),
                        candidate.dest or ("", 0),
                    )
                following = state.wmap[int(candidate.wid)].stages[
                    int(candidate.j) + 1
                ]
                network_tie_break = (
                    -float(scores[index])
                    if following.stage_type == "process"
                    else 0.0
                )
                return (
                    float(candidate.start),
                    rank,
                    -int(candidate.j),
                    int(candidate.wid),
                    destination_load,
                    network_tie_break,
                    candidate.dest or ("", 0),
                )

            preferred = sorted(range(len(candidates)), key=wavefront_key)
            if loadlock_manager is not None:
                return loadlock_manager.rank_preferred_candidates(
                    state,
                    candidates,
                    preferred,
                )
            return preferred
        scores = network.score(features)
        preferred = sorted(
            range(len(candidates)),
            key=lambda index: (
                -float(scores[index]),
                float(candidates[index].start),
                -int(candidates[index].j),
                int(candidates[index].wid),
            ),
        )
        if loadlock_manager is not None:
            # 当前 checkpoint 仍在物理候选上训练：先按联合分数形成逻辑组偏好，
            # 再经公共 manager 绑定 LoadLock。未来逻辑候选 checkpoint 可直接
            # 调用严格折叠适配器。
            return loadlock_manager.rank_preferred_candidates(
                state,
                candidates,
                preferred,
            )
        return preferred

    return choose


def _extract_reference_records(
    problem: Problem,
    schedule: Mapping[Any, List[Any]],
    *,
    full_ranking: bool,
) -> List[tuple[np.ndarray, Any]]:
    """回放参考排程，并按需记录首选动作或完整候选名次。"""
    reference_times = {
        (int(wafer_id), stage_index): float(stage_entry[3])
        for wafer_id, stages in schedule.items()
        for stage_index, stage_entry in enumerate(stages)
    }
    reference_chambers = {
        (int(wafer_id), stage_index): str(stage_entry[1])
        for wafer_id, stages in schedule.items()
        for stage_index, stage_entry in enumerate(stages)
    }
    records: List[tuple[np.ndarray, Any]] = []
    context = _feature_context(problem)

    def teacher(state: Any, candidates: List[Any]) -> List[int]:
        """优先复现参考排程中更早执行的 hop，并记录集合样本。"""
        order = sorted(
            range(len(candidates)),
            key=lambda index: (
                reference_times.get(
                    (int(candidates[index].wid), int(candidates[index].j)),
                    UNKNOWN_REFERENCE_TIME,
                ),
                int(
                    candidates[index].dest is not None
                    and reference_chambers.get(
                        (
                            int(candidates[index].wid),
                            int(candidates[index].j) + 1,
                        )
                    )
                    != str(candidates[index].dest[0])
                ),
                float(candidates[index].start),
                -int(candidates[index].j),
                int(candidates[index].wid),
            ),
        )
        if full_ranking:
            ranking = np.empty(len(order), dtype=np.int64)
            ranking[np.asarray(order, dtype=np.int64)] = np.arange(
                len(order),
                dtype=np.int64,
            )
            target: Any = ranking
        else:
            target = int(order[0])
        records.append((_candidate_features(state, candidates, context), target))
        return order

    decode_orders_choosing(
        problem,
        Durations(problem),
        problem.wafers,
        chooser=teacher,
        swap=True,
        trust_preferred_path=True,
        include_order_snapshots=False,
    )
    return records


def extract_reference_steps(
    problem: Problem,
    schedule: Mapping[Any, List[Any]],
) -> List[tuple[np.ndarray, int]]:
    """把参考排程回放成逐事件首选动作监督样本。"""
    return _extract_reference_records(
        problem,
        schedule,
        full_ranking=False,
    )


def extract_reference_ranked_steps(
    problem: Problem,
    schedule: Mapping[Any, List[Any]],
) -> List[tuple[np.ndarray, np.ndarray]]:
    """回放参考排程并保留每一步所有安全候选的教师名次。

    完整排序给次优候选也提供学习信号：即使上线时一次选择偏离教师，后续剩余候选仍有
    合理相对顺序，比只监督一个 one-hot 动作更耐受长轨迹误差。
    """
    return _extract_reference_records(
        problem,
        schedule,
        full_ranking=True,
    )


def start_schedule_neural(
    problem: Problem,
    *,
    policy: Optional[SetAttentionNetwork] = None,
    fallback_on_failure: bool = True,
    loadlock_manager_mode: LoadLockDispatchManager | str | None = "joint",
    force_quality_floor: bool = False,
) -> SolveResult:
    """用训练好的深层集合网络做贪心解码，并在失败时执行有预算物理修复。

    参数：
        problem: 已解析并展开晶圆的调度问题。
        policy: 已加载的纯 NumPy checkpoint；缺省使用确定性初始化网络。
        fallback_on_failure: 网络序列不可行时是否调用 Heuristic 故障兜底。
        loadlock_manager_mode: manager 实例或公共配置名。当前 checkpoint 缺省保留
            ``joint`` 联合选锁；传入 ``petri-eta`` 可把 LA/LB 交给公共 manager。
        force_quality_floor: 已知整个多轮计划含分布外多工序 Route 时，从首段起
            启用快速 heuristic 质量地板。

    返回：
        带 ``neural_diagnostics`` 的已验证可行 ``SolveResult``。
    """
    network = policy or SetAttentionNetwork()
    loadlock_manager = resolve_loadlock_manager(loadlock_manager_mode)
    if isinstance(loadlock_manager_mode, str):
        requested_loadlock_manager = loadlock_manager_mode
    elif loadlock_manager_mode is None:
        requested_loadlock_manager = "joint"
    else:
        requested_loadlock_manager = loadlock_manager.name
    has_multi_process_route = any(
        sum(stage.stage_type == "process" for stage in wafer.stages) > 1
        for wafer in problem.wafers
    )
    loadlock_manager_eligibility = (
        "eligible"
        if loadlock_manager is not None
        else "not-requested"
    )
    durations = Durations(problem)
    loadlock_swap_enabled = any(
        str(chamber.type).lower() == "loadlock"
        and int(getattr(chamber, "capacity", 1) or 1) >= 2
        for chamber in problem.chambers.values()
    )
    context = _feature_context(problem)
    balanced_wavefront = _balanced_disjoint_wavefront(problem)
    sparse_feed_startup = _needs_sparse_feed_startup(
        problem,
        balanced_wavefront,
    )
    decision_counter = [0]
    chooser = _network_chooser(
        network,
        context,
        decision_counter,
        balanced_wavefront,
        loadlock_manager,
    )
    capacity_window_decision_counter = [0]
    capacity_window_chooser = (
        _network_chooser(
            network,
            context,
            capacity_window_decision_counter,
            balanced_wavefront,
            loadlock_manager,
            capacity_window=True,
        )
        if balanced_wavefront is not None
        else None
    )
    joint_decision_counter = [0]
    joint_chooser = (
        _network_chooser(
            network,
            context,
            joint_decision_counter,
            balanced_wavefront,
            None,
        )
        if loadlock_manager is not None
        else None
    )
    failure_reason = ""

    def finalize(
        selected_wafers: Any,
        orders: Any,
    ) -> tuple[Optional[SolveResult], str]:
        """对一条资源顺序做精确定时与独立约束复核。"""
        result = solve_timing(
            problem,
            selected_wafers,
            orders=orders,
            enforce_resumed_route_fifo=False,
        )
        if not getattr(result, "feasible", False):
            return None, "网络资源顺序不满足时间或驻留约束"
        if check_solution(problem, result):
            return None, "网络资源顺序未通过排程约束复核"
        return result, ""

    def attempt_using(
        active_chooser: Any,
        *,
        trust_preferred_path: bool,
    ) -> tuple[Optional[SolveResult], str]:
        """解码一条网络轨迹并完成定时、可行性和结果复核。"""
        try:
            selected_wafers, orders = decode_orders_choosing(
                problem,
                durations,
                problem.wafers,
                chooser=active_chooser,
                swap=loadlock_swap_enabled,
                trust_preferred_path=trust_preferred_path,
                include_order_snapshots=False,
            )
        except (RuntimeError, _DecodeDeadlock) as error:
            return None, str(error) or type(error).__name__
        return finalize(selected_wafers, orders)

    def attempt(*, trust_preferred_path: bool) -> tuple[Optional[SolveResult], str]:
        """使用配置的主网络与 LoadLock manager 解码一条轨迹。"""
        return attempt_using(
            chooser,
            trust_preferred_path=trust_preferred_path,
        )

    def attempt_equal_feed_expert() -> tuple[Optional[SolveResult], str]:
        """评估一个等配额填充专家；它不是完整 heuristic portfolio。

        稀疏长加工的首段更像流水线 warm-up，而非稳态派工。单条动态 LL 轨迹可能在
        双槽 LoadLock 的固定去向上走进局部死锁，因此这里只对同一个等配额排序分别
        评估 no-swap/swap，并在必要时让 Petri-LOOK 动态兑现选锁。搜索宽度恒定为一个
        chooser，与 baseline 的七种 route 配比枚举严格区分。
        """
        from .heuristic import _eval_chooser, _feed_chooser

        routes = sorted({wafer.route_name for wafer in problem.wafers})
        result = _eval_chooser(
            problem,
            durations,
            problem.wafers,
            _feed_chooser({route_name: 1 for route_name in routes}),
            None,
        )
        if result is None or not getattr(result, "feasible", False):
            return None, "等配额启动专家未找到可行资源顺序"
        issues = check_solution(problem, result)
        if issues:
            return None, "等配额启动专家未通过排程约束复核"
        return result, ""

    def attempt_physics_repair() -> tuple[Optional[SolveResult], str]:
        """用两个有界物理 rollout 修复分布外轨迹，不启动完整状态搜索。"""

        def physics_chooser(_state: Any, candidates: List[Any]) -> List[int]:
            return sorted(
                range(len(candidates)),
                key=lambda index: (
                    float(candidates[index].start),
                    -int(candidates[index].j),
                    int(candidates[index].wid),
                ),
            )

        def drain_chooser(state: Any, candidates: List[Any]) -> List[int]:
            # 以“剩余 hop 数”而非裁剪后的局部 stage 编号定义拓扑深度。实时重算后，
            # PM/出站 LL 都会成为局部 stage 0；旧的 -j 排序因此会把它们与尚未发片
            # 混为一类。先排在制片、再排离 sink 更近者，可在无回流路线中单调减少
            # 设备内 token 的剩余势函数。
            return sorted(
                range(len(candidates)),
                key=lambda index: (
                    int(
                        not (
                            int(candidates[index].j) > 0
                            or bool(
                                state.wmap[int(candidates[index].wid)].already_released
                            )
                        )
                    ),
                    int(state.K[int(candidates[index].wid)])
                    - int(candidates[index].j),
                    float(candidates[index].start),
                    int(candidates[index].wid),
                ),
            )

        alternatives: List[SolveResult] = []
        reasons: List[str] = []
        routes = sorted({wafer.route_name for wafer in problem.wafers})
        compare_small_multi_route = (
            len(routes) > 1
            and len(problem.wafers) <= STRUCTURED_PETRI_REPAIR_MAX_WAFERS
        )
        # 大批量先走事件前沿版动态解码；它与固定腔解码使用相同物理使能条件，
        # 但每步只访问在机 token 与各路线头，避免 O(晶圆数 × 动作数) 的全表扫描。
        try:
            dynamic_wafers, dynamic_orders = decode_orders_choosing(
                problem,
                durations,
                problem.wafers,
                chooser=physics_chooser,
                swap=True,
                trust_preferred_path=True,
                include_order_snapshots=False,
            )
            dynamic_result, dynamic_reason = finalize(
                dynamic_wafers,
                dynamic_orders,
            )
            if dynamic_result is not None:
                if not compare_small_multi_route:
                    return dynamic_result, ""
                alternatives.append(dynamic_result)
            elif dynamic_reason:
                reasons.append(f"dynamic: {dynamic_reason}")
        except (RuntimeError, _DecodeDeadlock) as error:
            reasons.append(f"dynamic: {str(error) or type(error).__name__}")

        drain_builders = [
            (
                "dynamic-drain",
                lambda: decode_orders_choosing(
                    problem,
                    durations,
                    problem.wafers,
                    chooser=drain_chooser,
                    swap=True,
                    trust_preferred_path=True,
                    include_order_snapshots=False,
                ),
            ),
        ]
        if len(problem.wafers) <= STRUCTURED_PETRI_REPAIR_MAX_WAFERS:
            # 小问题保留固定腔候选作为质量组合；大问题不进入二次复杂度路径。
            drain_builders.append(
                (
                    "fixed-drain",
                    lambda: (
                        problem.wafers,
                        decode_orders(
                            problem,
                            durations,
                            problem.wafers,
                            chooser=drain_chooser,
                            swap=True,
                            trust_preferred_path=True,
                            enforce_resumed_route_fifo=False,
                        ),
                    ),
                )
            )
        for mode, builder in drain_builders:
            try:
                drain_wafers, drain_orders = builder()
                drain_result, drain_reason = finalize(
                    drain_wafers,
                    drain_orders,
                )
                if drain_result is not None:
                    if not compare_small_multi_route:
                        return drain_result, ""
                    alternatives.append(drain_result)
                elif drain_reason:
                    reasons.append(f"{mode}: {drain_reason}")
            except (RuntimeError, _DecodeDeadlock) as error:
                reasons.append(f"{mode}: {str(error) or type(error).__name__}")

        if len(problem.wafers) <= STRUCTURED_PETRI_REPAIR_MAX_WAFERS:
            try:
                fixed_orders = decode_orders(
                    problem,
                    durations,
                    problem.wafers,
                    chooser=physics_chooser,
                    swap=True,
                    trust_preferred_path=True,
                    enforce_resumed_route_fifo=False,
                )
                fixed_result, fixed_reason = finalize(problem.wafers, fixed_orders)
                if fixed_result is not None:
                    if not compare_small_multi_route:
                        return fixed_result, ""
                    alternatives.append(fixed_result)
                elif fixed_reason:
                    reasons.append(f"fixed: {fixed_reason}")
            except (RuntimeError, _DecodeDeadlock) as error:
                reasons.append(f"fixed: {str(error) or type(error).__name__}")

        if len(routes) > 1:
            # 多路线最常见的失败是某条路线连续发片把共享 LL 填死。只试三个固定配额
            # （而 baseline 会遍历更多配额并触发 Petri 搜索），墙钟成本仍是常数个 rollout。
            from .heuristic import _feed_chooser

            first, second = routes[:2]
            remaining_routes = {route: 1 for route in routes[2:]}
            for left, right in ((1, 1), (1, 2), (2, 1)):
                label = f"feed-{left}:{right}"
                try:
                    feed_wafers, feed_orders = decode_orders_choosing(
                        problem,
                        durations,
                        problem.wafers,
                        chooser=_feed_chooser(
                            {
                                first: left,
                                second: right,
                                **remaining_routes,
                            }
                        ),
                        swap=True,
                        trust_preferred_path=True,
                        include_order_snapshots=False,
                    )
                    feed_result, feed_reason = finalize(
                        feed_wafers,
                        feed_orders,
                    )
                    if feed_result is not None:
                        if not compare_small_multi_route:
                            return feed_result, ""
                        alternatives.append(feed_result)
                    elif feed_reason:
                        reasons.append(f"{label}: {feed_reason}")
                except (RuntimeError, _DecodeDeadlock) as error:
                    reasons.append(
                        f"{label}: {str(error) or type(error).__name__}"
                    )

            if len(problem.wafers) <= STRUCTURED_PETRI_REPAIR_MAX_WAFERS:
                for swap_mode in (True, False):
                    label = f"shielded-backward-swap={swap_mode}"
                    try:
                        shielded_orders = decode_orders(
                            problem,
                            durations,
                            problem.wafers,
                            chooser=physics_chooser,
                            swap=swap_mode,
                            first_safe_by_preference=True,
                            enforce_resumed_route_fifo=False,
                        )
                        shielded_result, shielded_reason = finalize(
                            problem.wafers,
                            shielded_orders,
                        )
                        if shielded_result is not None:
                            alternatives.append(shielded_result)
                        if shielded_reason:
                            reasons.append(f"{label}: {shielded_reason}")
                    except (RuntimeError, _DecodeDeadlock) as error:
                        reasons.append(
                            f"{label}: {str(error) or type(error).__name__}"
                        )

                for swap_mode in (True, False):
                    for left, right in (
                        (1, 1),
                        (1, 2),
                        (2, 1),
                    ):
                        quotas = {
                            first: left,
                            second: right,
                            **remaining_routes,
                        }
                        label = (
                            f"shielded-feed-{left}:{right}-swap={swap_mode}"
                        )
                        try:
                            shielded_orders = decode_orders(
                                problem,
                                durations,
                                problem.wafers,
                                chooser=_feed_chooser(quotas),
                                swap=swap_mode,
                                first_safe_by_preference=True,
                                enforce_resumed_route_fifo=False,
                            )
                            shielded_result, shielded_reason = finalize(
                                problem.wafers,
                                shielded_orders,
                            )
                            if shielded_result is not None:
                                alternatives.append(shielded_result)
                            if shielded_reason:
                                reasons.append(f"{label}: {shielded_reason}")
                        except (RuntimeError, _DecodeDeadlock) as error:
                            reasons.append(
                                f"{label}: {str(error) or type(error).__name__}"
                            )

        if alternatives:
            return min(alternatives, key=lambda result: float(result.makespan)), ""
        return None, "; ".join(reasons).replace(
            "网络资源顺序",
            "物理修复资源顺序",
        )

    # 正常路径不枚举未选动作：完整走到终态即构成逐步可达性证明。仅失败时才付出完整
    # Petri 屏蔽成本重试，因此最常见的生产路径保持低时延。
    candidate, preferred_failure = attempt(trust_preferred_path=True)
    used_safe_retry = False
    used_physics_repair = False
    used_sparse_feed_startup = False
    selected_wavefront_path = "strict-wavefront"
    failure_reasons = [preferred_failure] if preferred_failure else []
    portfolio_observations: List[str] = []
    if capacity_window_chooser is not None:
        window_candidate, window_failure = attempt_using(
            capacity_window_chooser,
            trust_preferred_path=True,
        )
        if window_failure:
            portfolio_observations.append(
                f"capacity-window: {window_failure}"
            )
        if (
            window_candidate is not None
            and (
                candidate is None
                or float(window_candidate.makespan) < float(candidate.makespan)
            )
        ):
            candidate = window_candidate
            selected_wavefront_path = "capacity-window"
    if sparse_feed_startup:
        startup_candidate, startup_failure = attempt_equal_feed_expert()
        if startup_failure:
            portfolio_observations.append(
                f"sparse-feed-startup: {startup_failure}"
            )
        if startup_candidate is not None:
            candidate = startup_candidate
            used_sparse_feed_startup = True
            selected_wavefront_path = "sparse-feed-startup"
    if candidate is None and len(problem.wafers) <= FULL_PETRI_RETRY_MAX_WAFERS:
        used_safe_retry = True
        candidate, safe_failure = attempt(trust_preferred_path=False)
        if safe_failure:
            failure_reasons.append(safe_failure)
    if candidate is None:
        used_physics_repair = True
        candidate, repair_failure = attempt_physics_repair()
        if repair_failure:
            failure_reasons.append(repair_failure)
    selected_loadlock_path = (
        loadlock_manager.name
        if loadlock_manager is not None
        else "joint-network"
    )
    if joint_chooser is not None:
        # 当前 checkpoint 仍由联合 LA/LB 标签训练。Petri-LOOK 是新的结构分解，
        # 用第二条确定性贪心轨迹组成一个两成员神经 portfolio，精确定时后取更优者；
        # 它不调用 heuristic baseline，推理预算仍是常数两次深网解码。
        joint_candidate, joint_failure = attempt_using(
            joint_chooser,
            trust_preferred_path=True,
        )
        if joint_failure:
            portfolio_observations.append(
                f"joint-portfolio: {joint_failure}"
            )
        if (
            joint_candidate is not None
            and (
                candidate is None
                or float(joint_candidate.makespan) < float(candidate.makespan)
            )
        ):
            candidate = joint_candidate
            used_safe_retry = False
            used_physics_repair = False
            selected_loadlock_path = "joint-network-portfolio"
    failure_reason = "; ".join(failure_reasons)

    selected = candidate
    if used_physics_repair and selected is not None:
        selected_source = "physics-shield-repair"
    elif used_sparse_feed_startup:
        selected_source = "neural-sparse-feed-startup"
    elif used_safe_retry:
        selected_source = "neural-safe-retry"
    else:
        selected_source = "neural"
    if (
        selected is None
        and fallback_on_failure
        and len(problem.wafers) <= STRUCTURED_PETRI_REPAIR_MAX_WAFERS
    ):
        from src.schedule.api import start_schedule

        selected = start_schedule(
            problem,
            verbose=False,
            loadlock_manager=loadlock_manager,
        )
        selected_source = "failure-fallback"
    elif (
        selected is not None
        and (
            selected_source == "physics-shield-repair"
            or has_multi_process_route
            or force_quality_floor
        )
        and fallback_on_failure
        and len(problem.wafers) <= STRUCTURED_PETRI_REPAIR_MAX_WAFERS
    ):
        # 有界规模的分布外问题可以负担一次显式质量地板：物理修复或当前尚未
        # 独立训练的多工序 Route 若差于快速 heuristic，就如实返回地板并在
        # 诊断中标明。已覆盖的单工序直推路径仍不运行 baseline，保持低时延。
        from src.schedule.api import start_schedule

        quality_floor = start_schedule(
            problem,
            verbose=False,
            loadlock_manager=loadlock_manager,
        )
        if getattr(quality_floor, "feasible", False):
            floor_makespan = float(quality_floor.makespan)
            selected_makespan = float(selected.makespan)
            required_gain = (
                FORCED_QUALITY_FLOOR_MINIMUM_GAIN
                if force_quality_floor
                else 0.0
            )
            realized_gain = (
                (floor_makespan - selected_makespan) / floor_makespan
                if floor_makespan > NUMERICAL_EPSILON
                else 0.0
            )
            if (
                selected_makespan > floor_makespan
                or realized_gain < required_gain
            ):
                selected = quality_floor
                selected_source = "quality-floor-fallback"
    if selected is None or not getattr(selected, "feasible", False):
        detail = f"：{failure_reason}" if failure_reason else ""
        raise RuntimeError(f"神经派工未找到可行计划{detail}")
    if selected_source == "physics-shield-repair":
        selected_loadlock_path = "physics-shield"
    elif selected_source == "neural-sparse-feed-startup":
        selected_loadlock_path = "sparse-feed-joint"
    elif selected_source in {"failure-fallback", "quality-floor-fallback"}:
        selected_loadlock_path = "heuristic-baseline"

    metadata = dict(network.metadata)
    selected.neural_diagnostics = {  # type: ignore[attr-defined]
        "architecture": MODEL_SCHEMA_VERSION,
        "parameterCount": network.parameter_count,
        "forwardPasses": int(
            decision_counter[0]
            + capacity_window_decision_counter[0]
            + joint_decision_counter[0]
        ),
        "actionMask": (
            selected_source
            if selected_source in {"failure-fallback", "quality-floor-fallback"}
            else (
                "structural-sparse-feed"
                if selected_source == "neural-sparse-feed-startup"
                else (
                    "structural-physics-shield"
                    if selected_source == "physics-shield-repair"
                    else (
                        "petri-reachability"
                        if used_safe_retry
                        else "complete-path-certificate"
                    )
                )
            )
        ),
        "selectedSource": selected_source,
        "fallbackReason": failure_reason,
        "portfolioObservations": portfolio_observations,
        "modelPath": metadata.get("path", ""),
        "trainingInstances": metadata.get("trainingInstances"),
        "trainingSteps": metadata.get("trainingSteps"),
        "validationAccuracy": metadata.get("validationAccuracy"),
        "teacher": metadata.get("teacher", "physics-initialized"),
        "inferenceMode": "greedy-path-with-budgeted-repair",
        "inductiveBias": (
            (
                "balanced-disjoint-sparse-feed-startup"
                if selected_wavefront_path == "sparse-feed-startup"
                else (
                    "balanced-disjoint-capacity-window"
                    if selected_wavefront_path == "capacity-window"
                    else "balanced-disjoint-route-wavefront"
                )
            )
            if balanced_wavefront is not None
            else "general-set-attention"
        ),
        "wavefrontFamilies": (
            balanced_wavefront.family_count
            if balanced_wavefront is not None
            else 0
        ),
        "decisionSpace": (
            "baseline-fallback"
            if selected_source in {"failure-fallback", "quality-floor-fallback"}
            else (
                "hop-and-loadlock-sparse-feed"
                if selected_source == "neural-sparse-feed-startup"
                else (
                    "hop-and-loadlock-physics-repair"
                    if selected_source == "physics-shield-repair"
                    else (
                        "hop-with-petri-look-loadlock"
                        if (
                            loadlock_manager is not None
                            and selected_loadlock_path == loadlock_manager.name
                        )
                        else "hop-and-loadlock"
                    )
                )
            )
        ),
        "loadLockManager": (
            loadlock_manager.name
            if loadlock_manager is not None
            else "joint-network"
        ),
        "loadLockManagerRequested": requested_loadlock_manager,
        "loadLockManagerEligibility": loadlock_manager_eligibility,
        "loadLockSelectedPath": selected_loadlock_path,
        "qualityFloorForced": bool(force_quality_floor),
    }
    selected.check_issues = check_solution(problem, selected)  # type: ignore[attr-defined]
    return selected
