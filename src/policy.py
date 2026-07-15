"""BC/RL 候选策略：permutation-invariant 共享 MLP + Torch/NumPy 推理封装。

每候选特征 → 共享 MLP → 标量分；对候选 softmax（变长候选用 mask）。训练 = 候选上的交叉熵
（专家选中 idx 为正类）。推理只需对每候选打分取最高（timing 的 Banker 解码再套安全掩码）。

训练使用 Torch；推理环境未安装 Torch 时，可从受限解析的标准 checkpoint 读取 3 层 MLP 权重，
改用 NumPy 做同口径前向。timing 懒导入本模块，标签提取仍只依赖 NumPy。
"""

from __future__ import annotations

import codecs
import collections
import io
import pickle
import zipfile

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


class NumpyPolicy:
    """无 Torch 推理策略：用 NumPy 执行 Linear→ReLU→Linear→ReLU→Linear。"""

    def __init__(self, weights, biases, mean: np.ndarray, std: np.ndarray):
        self.weights = [np.asarray(weight, dtype=np.float32) for weight in weights]
        self.biases = [np.asarray(bias, dtype=np.float32) for bias in biases]
        self.mean = np.asarray(mean, dtype=np.float32)
        self.std = np.asarray(std, dtype=np.float32)

    def score_step(self, feats: np.ndarray) -> np.ndarray:
        """标准化单步候选特征并返回与 Torch MLP 一致的标量分数。"""
        hidden = (np.asarray(feats, dtype=np.float32) - self.mean) / self.std
        for weight, bias in zip(self.weights[:-1], self.biases[:-1]):
            hidden = np.maximum(hidden @ weight.T + bias, 0.0)
        return (hidden @ self.weights[-1].T + self.biases[-1]).reshape(-1)


class _FloatStorage:
    """受限反序列化时用于识别 Torch FloatStorage 的哨兵类型。"""


class _StorageReference:
    """checkpoint 外置 storage 的只读引用。"""

    def __init__(self, key: str):
        self.key = str(key)


class _TensorReference:
    """记录 tensor 对 storage 的偏移、形状和 stride，稍后再映射为 NumPy。"""

    def __init__(self, storage: _StorageReference, offset: int, shape, stride):
        self.storage = storage
        self.offset = int(offset)
        self.shape = tuple(int(value) for value in shape)
        self.stride = tuple(int(value) for value in stride)


def _rebuild_tensor(storage, offset, shape, stride, *_args):
    """替代 ``torch._utils._rebuild_tensor_v2``，仅保存 tensor 元数据。"""
    return _TensorReference(storage, offset, shape, stride)


class _RestrictedCheckpointUnpickler(pickle.Unpickler):
    """只允许 checkpoint 所需的 Torch tensor 元数据和 NumPy 数组类型。"""

    _ALLOWED_GLOBALS = {
        ("torch._utils", "_rebuild_tensor_v2"): _rebuild_tensor,
        ("torch", "FloatStorage"): _FloatStorage,
        ("collections", "OrderedDict"): collections.OrderedDict,
        ("numpy._core.multiarray", "_reconstruct"): np._core.multiarray._reconstruct,
        ("numpy.core.multiarray", "_reconstruct"): np._core.multiarray._reconstruct,
        ("numpy", "ndarray"): np.ndarray,
        ("numpy", "dtype"): np.dtype,
        ("_codecs", "encode"): codecs.encode,
    }

    def find_class(self, module: str, name: str):
        """拒绝白名单之外的任意全局对象，避免 checkpoint 执行任意代码。"""
        value = self._ALLOWED_GLOBALS.get((module, name))
        if value is None:
            raise pickle.UnpicklingError(f"checkpoint 含不允许的对象 {module}.{name}")
        return value

    def persistent_load(self, persistent_id):
        """把 Torch storage persistent id 转为不读取代码的轻量引用。"""
        if (not isinstance(persistent_id, tuple) or len(persistent_id) < 3
                or persistent_id[0] != "storage"
                or persistent_id[1] is not _FloatStorage):
            raise pickle.UnpicklingError(f"不支持的 storage 标识 {persistent_id!r}")
        return _StorageReference(str(persistent_id[2]))


def _tensor_to_numpy(archive: zipfile.ZipFile, prefix: str,
                     reference: _TensorReference) -> np.ndarray:
    """读取一个 FloatStorage，并按 tensor 的 shape/stride 构造独立 NumPy 数组。"""
    raw = archive.read(f"{prefix}/data/{reference.storage.key}")
    storage = np.frombuffer(raw, dtype="<f4")
    byte_strides = tuple(stride * storage.dtype.itemsize for stride in reference.stride)
    tensor = np.ndarray(
        shape=reference.shape, dtype=storage.dtype,
        buffer=storage, offset=reference.offset * storage.dtype.itemsize,
        strides=byte_strides,
    )
    return np.array(tensor, dtype=np.float32, copy=True)


def _load_numpy_policy(path: str) -> NumpyPolicy:
    """在无 Torch 环境下受限读取本项目 ``torch.save`` checkpoint。"""
    with zipfile.ZipFile(path) as archive:
        data_entry = next((name for name in archive.namelist() if name.endswith("/data.pkl")), None)
        if data_entry is None:
            raise ValueError("checkpoint 缺少 data.pkl")
        prefix = data_entry.rsplit("/", 1)[0]
        checkpoint = _RestrictedCheckpointUnpickler(
            io.BytesIO(archive.read(data_entry)), encoding="utf-8",
        ).load()
        state = checkpoint.get("state") or {}
        layer_indices = (0, 2, 4)
        weights = [
            _tensor_to_numpy(archive, prefix, state[f"net.{index}.weight"])
            for index in layer_indices
        ]
        biases = [
            _tensor_to_numpy(archive, prefix, state[f"net.{index}.bias"])
            for index in layer_indices
        ]
    return NumpyPolicy(weights, biases,
                       np.asarray(checkpoint["mean"]), np.asarray(checkpoint["std"]))


def load_policy(path: str) -> "Policy | NumpyPolicy":
    """读取训练 checkpoint；有 Torch 用原模型，否则返回等价 NumPy 策略。"""
    if not _HAS_TORCH:
        return _load_numpy_policy(path)
    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    model = CandidateScorer(int(ckpt["feat_dim"]), int(ckpt["hidden"]))
    model.load_state_dict(ckpt["state"])
    model.eval()
    return Policy(model, np.asarray(ckpt["mean"]), np.asarray(ckpt["std"]))
