"""L2D 风格的 GraphCNN、Actor 与 Critic 网络。

GraphCNN 使用三层 sum 邻居聚合；Actor 联合候选节点嵌入和全图平均池化嵌入打分，Critic
只读取图嵌入。网络不依赖固定节点数或候选数，因此可在 1–3 工序、1/2 Job 和变长晶圆数
之间共享参数。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Tuple

import torch
from torch import nn
from torch.distributions import Categorical

from .graph import FEATURE_DIMENSION, GraphObservation


@dataclass(frozen=True)
class L2DNetworkConfig:
    """可序列化的 L2D 网络结构配置。"""

    feature_dimension: int = FEATURE_DIMENSION
    graph_layers: int = 3
    graph_hidden_dimension: int = 64
    actor_hidden_dimension: int = 32
    critic_hidden_dimension: int = 32
    neighbor_pooling: str = "sum"
    graph_pooling: str = "average"

    @classmethod
    def from_dict(cls, values: Dict[str, Any]) -> "L2DNetworkConfig":
        """从 checkpoint 字典恢复配置，并让缺失字段使用当前默认值。"""
        known = {field_name for field_name in cls.__dataclass_fields__}
        return cls(**{key: value for key, value in values.items() if key in known})

    def to_dict(self) -> Dict[str, Any]:
        """转换为可写入 checkpoint 的普通字典。"""
        return asdict(self)


class GraphCNN(nn.Module):
    """使用稠密邻接矩阵实现的 sum 聚合 GraphCNN。"""

    def __init__(self, config: L2DNetworkConfig):
        super().__init__()
        if config.neighbor_pooling != "sum":
            raise ValueError("当前 GraphCNN 仅支持 sum 邻居聚合")
        dimensions = [config.feature_dimension] + [
            config.graph_hidden_dimension
        ] * config.graph_layers
        self.layers = nn.ModuleList(
            nn.Linear(dimensions[index], dimensions[index + 1])
            for index in range(config.graph_layers)
        )

    def forward(self, features: torch.Tensor, adjacency: torch.Tensor) -> torch.Tensor:
        """逐层聚合前驱和自环特征，返回所有操作节点嵌入。"""
        hidden = features
        for layer in self.layers:
            hidden = torch.relu(layer(adjacency @ hidden))
        return hidden


def _two_layer_mlp(input_dimension: int, hidden_dimension: int, output_dimension: int) -> nn.Sequential:
    """构造一层隐藏层、两次线性变换的 Actor/Critic MLP。"""
    return nn.Sequential(
        nn.Linear(input_dimension, hidden_dimension),
        nn.ReLU(),
        nn.Linear(hidden_dimension, output_dimension),
    )


class L2DPolicy(nn.Module):
    """共享 GraphCNN 编码器的 Actor-Critic 策略。"""

    def __init__(self, config: L2DNetworkConfig | None = None):
        super().__init__()
        self.config = config or L2DNetworkConfig()
        hidden_dimension = self.config.graph_hidden_dimension
        self.graph_cnn = GraphCNN(self.config)
        self.actor = _two_layer_mlp(
            input_dimension=hidden_dimension * 2,
            hidden_dimension=self.config.actor_hidden_dimension,
            output_dimension=1,
        )
        self.critic = _two_layer_mlp(
            input_dimension=hidden_dimension,
            hidden_dimension=self.config.critic_hidden_dimension,
            output_dimension=1,
        )

    @property
    def device(self) -> torch.device:
        """返回模型参数当前所在设备。"""
        return next(self.parameters()).device

    def distribution_and_value(
        self,
        observation: GraphObservation,
    ) -> Tuple[Categorical, torch.Tensor]:
        """计算安全候选上的分类分布和当前状态价值。"""
        local_observation = observation.to(self.device)
        node_embeddings = self.graph_cnn(
            local_observation.features, local_observation.adjacency
        )
        if self.config.graph_pooling != "average":
            raise ValueError("当前策略仅支持 average 图级池化")
        graph_embedding = node_embeddings.mean(dim=0)
        candidate_embeddings = node_embeddings[local_observation.candidate_nodes]
        repeated_graph = graph_embedding.unsqueeze(0).expand(
            candidate_embeddings.shape[0], -1
        )
        logits = self.actor(
            torch.cat((candidate_embeddings, repeated_graph), dim=1)
        ).squeeze(-1)
        value = self.critic(graph_embedding).squeeze(-1)
        return Categorical(logits=logits), value

    def choose_action(
        self,
        observation: GraphObservation,
        *,
        greedy: bool,
    ) -> Tuple[int, torch.Tensor, torch.Tensor]:
        """从安全候选中采样或贪心选择动作，并返回动作、log-prob 与价值。"""
        distribution, value = self.distribution_and_value(observation)
        action = torch.argmax(distribution.logits) if greedy else distribution.sample()
        return int(action.item()), distribution.log_prob(action), value
