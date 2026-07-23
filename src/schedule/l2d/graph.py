"""把固定机器的 PSE300 解码状态转换为动态析取图。

每个待提交 hop 对应一个节点。图始终包含片内合取边和自环，并随着解码推进加入已确定的
加工腔、LoadLock 与机器手资源顺序边。候选动作映射到节点下标，供 Actor 在 Banker 安全
候选集合上打分。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple

import torch

from src.schedule.sequencing import _Cand, _DecodeState
from src.timing.spans import _hop_span, _stage_dwell


LEGACY_FEATURE_VERSION = "pse300-hop-v1"
FEATURE_VERSION = "pse300-hop-v2"
LEGACY_FEATURE_DIMENSION = 12
FEATURE_DIMENSION = 19
SUPPORTED_FEATURE_DIMENSIONS = {
    LEGACY_FEATURE_VERSION: LEGACY_FEATURE_DIMENSION,
    FEATURE_VERSION: FEATURE_DIMENSION,
}
MAX_PROCESS_STAGES = 3
PSE300_PROCESS_MODULES = ("PM1", "PM2", "PM3", "PM4")


@dataclass(frozen=True)
class GraphObservation:
    """一次策略决策所需的不可变图张量和候选映射。"""

    features: torch.Tensor
    adjacency: torch.Tensor
    candidate_nodes: torch.Tensor
    candidate_keys: Tuple[Tuple[int, int], ...]
    lower_bound: float
    time_scale: float

    def to(self, device: torch.device | str) -> "GraphObservation":
        """把张量移动到目标设备，保留候选键和未归一化时间标量。"""
        return GraphObservation(
            features=self.features.to(device),
            adjacency=self.adjacency.to(device),
            candidate_nodes=self.candidate_nodes.to(device),
            candidate_keys=self.candidate_keys,
            lower_bound=self.lower_bound,
            time_scale=self.time_scale,
        )


def _operation_type(wafer, hop_index: int) -> Tuple[float, float, float, float, float]:
    """返回 hop 的 source/LL-entry/process/LL-exit/sink 五类 one-hot 特征。"""
    source_stage = wafer.stages[hop_index]
    destination_stage = wafer.stages[hop_index + 1]
    if source_stage.stage_type == "source":
        category = 0
    elif destination_stage.stage_type == "loadlock" and destination_stage.ll_type == "entry":
        category = 1
    elif destination_stage.stage_type == "process":
        category = 2
    elif destination_stage.stage_type == "loadlock" and destination_stage.ll_type == "exit":
        category = 3
    elif destination_stage.stage_type == "sink":
        category = 4
    else:
        category = 2
    return tuple(1.0 if index == category else 0.0 for index in range(5))  # type: ignore[return-value]


def _resource_ready_time(state: _DecodeState, wafer, hop_index: int) -> float:
    """按当前占用估计目标腔可用时间；保留 v1 checkpoint 的旧特征语义。"""
    destination = wafer.stages[hop_index + 1]
    occupying_wafers = [
        wid for (chamber, _slot), wid in state.occ.items()
        if chamber == destination.chamber
    ]
    if not occupying_wafers:
        return 0.0
    return max(state.place_t.get(wid, 0.0) for wid in occupying_wafers)


def _resource_history_ready_time(
    state: _DecodeState,
    wafer,
    hop_index: int,
    candidate_resource: Tuple[str, int] | None = None,
) -> float:
    """用目标资源最后一次已提交访问的完成估计表示动态负载。

    解码器只向策略暴露目标资源当前空闲的动作，因此旧的“当前占用”特征对所有候选恒为零。
    v2 改用资源历史最后一片的近似完成时刻，让模型在资源刚释放后仍能看到此前积累的负载。
    """
    destination = wafer.stages[hop_index + 1]
    resource = candidate_resource or (destination.chamber, destination.slot)
    sequence = state.chamber_orders.get(resource, ())
    if not sequence:
        return 0.0
    last_wafer_id, _stage_index = sequence[-1]
    return state.place_t.get(last_wafer_id, 0.0)


def _destination_pm_one_hot(wafer, hop_index: int) -> List[float]:
    """返回目标加工腔 PM1–PM4 的 one-hot；非加工目标全为零。"""
    destination = wafer.stages[hop_index + 1]
    return [
        1.0 if destination.stage_type == "process" and destination.chamber == module else 0.0
        for module in PSE300_PROCESS_MODULES
    ]


def _estimate_completion_bounds(
    state: _DecodeState,
) -> Tuple[Dict[Tuple[int, int], float], float, float]:
    """计算各 hop 的预计完成下界、全局下界和实例归一化时间尺度。"""
    durations: Dict[Tuple[int, int], float] = {}
    maximum_route_duration = 0.0
    for wafer in state.wmap.values():
        route_duration = 0.0
        for hop_index in range(state.K[wafer.wid]):
            duration = _stage_dwell(state.tm, wafer, hop_index) + _hop_span(
                state.tm, wafer, hop_index
            )
            durations[(wafer.wid, hop_index)] = duration
            route_duration += duration
        maximum_route_duration = max(maximum_route_duration, route_duration)
    time_scale = max(maximum_route_duration, 1.0)

    completion: Dict[Tuple[int, int], float] = {}
    final_bounds: List[float] = []
    for wafer in state.wmap.values():
        wafer_id = wafer.wid
        current_hop = state.pos[wafer_id]
        estimate = 0.0
        for hop_index in range(state.K[wafer_id]):
            dwell = _stage_dwell(state.tm, wafer, hop_index)
            span = _hop_span(state.tm, wafer, hop_index)
            if hop_index >= current_hop:
                estimate = max(estimate, state.place_t[wafer_id])
                estimate = max(
                    estimate + dwell,
                    state.robot_free.get(wafer.transports[hop_index], 0.0),
                ) + span
            else:
                estimate += durations[(wafer_id, hop_index)]
            completion[(wafer_id, hop_index)] = estimate
        final_bounds.append(estimate)
    return completion, max(final_bounds, default=0.0), time_scale


def _add_sequence_edges(
    adjacency: torch.Tensor,
    sequence: Sequence[Tuple[int, int]],
    node_index: Dict[Tuple[int, int], int],
    *,
    stage_entries: bool,
) -> None:
    """把资源提交顺序转成前驱聚合边；腔顺序的 stage 下标会换算为到站 hop。"""
    operation_sequence: List[Tuple[int, int]] = []
    for wafer_id, index in sequence:
        operation = (wafer_id, index - 1) if stage_entries else (wafer_id, index)
        if operation in node_index:
            operation_sequence.append(operation)
    for previous, current in zip(operation_sequence, operation_sequence[1:]):
        adjacency[node_index[current], node_index[previous]] = 1.0


def build_graph_observation(
    state: _DecodeState,
    candidates: Sequence[_Cand],
    *,
    feature_version: str = FEATURE_VERSION,
) -> GraphObservation:
    """从解码快照和安全候选构建 GraphCNN 输入。

    节点顺序按 ``(wid, hop)`` 稳定排列。邻接矩阵使用 ``A[目标, 前驱]=1``，因此一次
    矩阵乘法会聚合合取/析取前驱；自环保证孤立节点仍保留自身信息。
    """
    if feature_version not in SUPPORTED_FEATURE_DIMENSIONS:
        raise ValueError(f"不支持的 L2D 特征版本：{feature_version}")
    operations = [
        (wafer_id, hop_index)
        for wafer_id in sorted(state.wmap)
        for hop_index in range(state.K[wafer_id])
    ]
    node_index = {operation: index for index, operation in enumerate(operations)}
    completion, lower_bound, time_scale = _estimate_completion_bounds(state)

    candidate_starts = {
        (candidate.wid, candidate.j): candidate.start for candidate in candidates
    }
    candidate_resources = {
        (candidate.wid, candidate.j): candidate.dest for candidate in candidates
    }
    route_counts: Dict[str, int] = {}
    for wafer in state.wmap.values():
        route_counts[wafer.route_name] = route_counts.get(wafer.route_name, 0) + 1
    unfinished_destination_load: Dict[str, int] = {}
    for wafer in state.wmap.values():
        for operation_index in range(state.pos[wafer.wid], state.K[wafer.wid]):
            chamber = wafer.stages[operation_index + 1].chamber
            unfinished_destination_load[chamber] = unfinished_destination_load.get(chamber, 0) + 1

    feature_rows: List[List[float]] = []
    for wafer_id, hop_index in operations:
        wafer = state.wmap[wafer_id]
        hop_count = max(state.K[wafer_id], 1)
        duration = _stage_dwell(state.tm, wafer, hop_index) + _hop_span(
            state.tm, wafer, hop_index
        )
        process_count = sum(
            stage.stage_type == "process" for stage in wafer.stages
        )
        feature_row = [
            completion[(wafer_id, hop_index)] / time_scale,
            float(hop_index < state.pos[wafer_id]),
            duration / time_scale,
            hop_index / hop_count,
            process_count / MAX_PROCESS_STAGES,
            *_operation_type(wafer, hop_index),
            state.robot_free.get(wafer.transports[hop_index], 0.0) / time_scale,
            (
                _resource_ready_time(state, wafer, hop_index)
                if feature_version == LEGACY_FEATURE_VERSION
                else _resource_history_ready_time(
                    state,
                    wafer,
                    hop_index,
                    candidate_resources.get((wafer_id, hop_index)),
                )
            ) / time_scale,
        ]
        if feature_version == FEATURE_VERSION:
            route_count = max(route_counts.get(wafer.route_name, 1) - 1, 1)
            destination = wafer.stages[hop_index + 1]
            feature_row.extend([
                candidate_starts.get((wafer_id, hop_index), 0.0) / time_scale,
                wafer.route_rank / route_count,
                unfinished_destination_load.get(destination.chamber, 0)
                / max(len(state.wmap), 1),
                *_destination_pm_one_hot(wafer, hop_index),
            ])
        feature_rows.append(feature_row)

    features = torch.tensor(feature_rows, dtype=torch.float32)
    adjacency = torch.zeros((len(operations), len(operations)), dtype=torch.float32)
    adjacency.fill_diagonal_(1.0)

    # 片内合取边始终存在。
    for wafer_id in sorted(state.wmap):
        for hop_index in range(state.K[wafer_id] - 1):
            adjacency[
                node_index[(wafer_id, hop_index + 1)],
                node_index[(wafer_id, hop_index)],
            ] = 1.0

    # 已提交的腔、LoadLock 和机器手顺序形成动态析取边。
    for sequence in state.chamber_orders.values():
        _add_sequence_edges(adjacency, sequence, node_index, stage_entries=True)
    for sequence in state.loadlock_orders.values():
        _add_sequence_edges(adjacency, sequence, node_index, stage_entries=True)
    for sequence in state.robot_orders.values():
        _add_sequence_edges(adjacency, sequence, node_index, stage_entries=False)

    candidate_keys = tuple((candidate.wid, candidate.j) for candidate in candidates)
    candidate_nodes = torch.tensor(
        [node_index[key] for key in candidate_keys], dtype=torch.long
    )
    return GraphObservation(
        features=features,
        adjacency=adjacency,
        candidate_nodes=candidate_nodes,
        candidate_keys=candidate_keys,
        lower_bound=lower_bound,
        time_scale=time_scale,
    )
