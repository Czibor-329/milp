"""BC 策略：permutation-invariant 候选打分器（torch）+ 推理封装。

每候选特征 → 共享 MLP → 标量分；对候选 softmax（变长候选用 mask）。训练 = 候选上的交叉熵
（专家选中 idx 为正类）。推理只需对每候选打分取最高（timing 的 Banker 解码再套安全掩码）。

timing.py 懒导入本模块；本模块只在需要时 import torch（标签提取/评测的 numpy 路径不依赖 torch）。
"""

from __future__ import annotations

import numpy as np

try:
    import torch
    import torch.nn as nn
    _HAS_TORCH = True
except Exception:                       # noqa: BLE001
    _HAS_TORCH = False


if _HAS_TORCH:
    class CandidateScorer(nn.Module):
        """每候选特征 [.., F] → 标量分。逐候选独立 ⇒ 天然 permutation-invariant、候选数可变。"""

        def __init__(self, feat_dim: int, hidden: int = 64):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(feat_dim, hidden), nn.ReLU(),
                nn.Linear(hidden, hidden), nn.ReLU(),
                nn.Linear(hidden, 1),
            )

        def forward(self, feats, mask):
            """feats [B,C,F], mask [B,C] → logits [B,C]（padding 处置 -1e9）。"""
            s = self.net(feats).squeeze(-1)
            return s.masked_fill(mask < 0.5, -1e9)


class Policy:
    """推理封装：单步 [n_cand, F]（原始特征）→ [n_cand] 分数。内部做训练时的标准化。"""

    def __init__(self, model, mean: np.ndarray, std: np.ndarray):
        self.model = model
        self.mean = mean.astype(np.float32)
        self.std = std.astype(np.float32)

    def score_step(self, feats: np.ndarray) -> np.ndarray:
        x = (feats - self.mean) / self.std
        with torch.no_grad():
            t = torch.from_numpy(x.astype(np.float32))
            s = self.model.net(t).squeeze(-1)
        return s.numpy()


def load_policy(path: str) -> "Policy":
    """读训练 checkpoint → Policy（含模型 + 特征标准化参数）。"""
    if not _HAS_TORCH:
        raise RuntimeError("load_policy 需要 torch（用带 torch 的 venv 跑）")
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    model = CandidateScorer(int(ckpt["feat_dim"]), int(ckpt["hidden"]))
    model.load_state_dict(ckpt["state"])
    model.eval()
    return Policy(model, np.asarray(ckpt["mean"]), np.asarray(ckpt["std"]))
