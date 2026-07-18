"""把固定机器的 PSE300 解码状态转换为动态析取图。

每个待提交 hop 对应一个节点。图始终包含片内合取边和自环，并随着解码推进加入已确定的
加工腔、LoadLock 与机器手资源顺序边。候选动作映射到节点下标，供 Actor 在 Banker 安全
候选集合上打分。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple

import torch

from src.timing.sequencing import _Cand, _DecodeState
from src.timing.spans import _hop_span, _stage_dwell


FEATURE_VERSION = "pse300-hop-v1"
FEATURE_DIMENSION = 12
MAX_PROCESS_STAGES = 3


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
    """估计目标腔当前可用时间；空闲或不占资源的目标返回零。"""
    destination = wafer.stages[hop_index + 1]
    occupying_wafers = [
        wid for (chamber, _slot), wid in state.occ.items()
        if chamber == destination.chamber
    ]
    if not occupying_wafers:
        return 0.0
    return max(state.place_t.get(wid, 0.0) for wid in occupying_wafers)


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
) -> GraphObservation:
    """从解码快照和安全候选构建 GraphCNN 输入。

    节点顺序按 ``(wid, hop)`` 稳定排列。邻接矩阵使用 ``A[目标, 前驱]=1``，因此一次
    矩阵乘法会聚合合取/析取前驱；自环保证孤立节点仍保留自身信息。
    """
    operations = [
        (wafer_id, hop_index)
        for wafer_id in sorted(state.wmap)
        for hop_index in range(state.K[wafer_id])
    ]
    node_index = {operation: index for index, operation in enumerate(operations)}
    completion, lower_bound, time_scale = _estimate_completion_bounds(state)

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
        feature_rows.append([
            completion[(wafer_id, hop_index)] / time_scale,
            float(hop_index < state.pos[wafer_id]),
            duration / time_scale,
            hop_index / hop_count,
            process_count / MAX_PROCESS_STAGES,
            *_operation_type(wafer, hop_index),
            state.robot_free.get(wafer.transports[hop_index], 0.0) / time_scale,
            _resource_ready_time(state, wafer, hop_index) / time_scale,
        ])

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
