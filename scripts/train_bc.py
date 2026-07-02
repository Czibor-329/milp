"""训练 BC 候选打分器：读 bc_labels.npz → 训 CandidateScorer → 存 bc_policy.pt。

损失 = 候选上的交叉熵（专家选中 idx 为正类）。报训练/验证 top-1 准确率（专家被选中率）。
特征做标准化（mean/std 存进 checkpoint，推理时复用）。CPU 即可。

用法（须用带 torch 的 venv）：
  C:/Users/khand/Desktop/CT/venv/Scripts/python.exe scripts/train_bc.py
  ... scripts/train_bc.py --epochs 60 --hidden 64 --lr 1e-3
"""

import argparse
import io
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.policy import CandidateScorer
from src.paths import model_output_path

_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", type=str,
                    default=str(_ROOT / "dataset" / "train_artifacts" / "bc_labels.npz"))
    ap.add_argument("--out", type=str,
                    default=str(model_output_path("bc_policy.pt")))
    ap.add_argument("--epochs", type=int, default=1000)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--waf-aug", action="store_true",
                    help="晶圆数域随机化：把 12 片样本按多个虚拟片数重标 g1/g2，逼网络学片数不变策略（外推大批量）")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)

    z = np.load(args.labels)
    feats = z["feats"].astype(np.float32)        # [N, C, F]
    mask = z["mask"].astype(np.float32)          # [N, C]
    expert = z["expert"].astype(np.int64)        # [N]
    N, C, F = feats.shape
    print(f"labels: N={N} cmax={C} feat_dim={F}")

    # 晶圆数域随机化（--waf-aug）：标签全在训练片数(=12)下抽出，g1/g2=occ/12、n_c/12 的【绝对档位】
    # 只在 12 片时成立，测试 25 片时会滑向 0 掉出分布 ⇒ 网络若依赖它就在大批量塌成串行。这里把每个
    # 12 片样本复制若干份、按不同虚拟片数 nw' 重标 g1/g2（乘 12/nw'），专家选中候选不变 ⇒ 无需新
    # 标签。网络因此见到「同一决策下 g1/g2 档位随机变化」，被迫改用与片数无关的 g6/g7(÷资源容量)，
    # 学成片数不变的策略、外推到任意批量。g1=col1、g2=col2（全局块前 8 列内），只缩放真实候选行。
    if args.waf_aug:
        nwps = [8, 12, 18, 25, 36]               # 覆盖部署片数范围的虚拟批量（12=原样）
        base_nw = 12.0
        fs, ms, es = [], [], []
        for nwp in nwps:
            fc = feats.copy()
            sc = base_nw / nwp
            fc[:, :, 1] *= sc                     # g1 = occ / nw'
            fc[:, :, 2] *= sc                     # g2 = n_c / nw'
            fc *= mask[:, :, None]                # padding 行保持 0
            fs.append(fc); ms.append(mask.copy()); es.append(expert.copy())
        feats = np.concatenate(fs, 0)
        mask = np.concatenate(ms, 0)
        expert = np.concatenate(es, 0)
        N = feats.shape[0]
        print(f"waf-aug: ×{len(nwps)} 片数档 {nwps} ⇒ N={N}")

    # 标准化：仅用真实候选行算 mean/std
    flat = feats[mask > 0.5]                      # [M, F]
    mean = flat.mean(0)
    std = flat.std(0)
    std[std < 1e-6] = 1.0
    feats = (feats - mean) / std

    # 划分 train/val
    idx = rng.permutation(N)
    n_val = int(N * args.val_frac)
    val_idx, tr_idx = idx[:n_val], idx[n_val:]

    def to_t(a):
        return torch.from_numpy(a)
    Xtr, Mtr, Ytr = to_t(feats[tr_idx]), to_t(mask[tr_idx]), to_t(expert[tr_idx])
    Xv, Mv, Yv = to_t(feats[val_idx]), to_t(mask[val_idx]), to_t(expert[val_idx])

    model = CandidateScorer(F, args.hidden)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    lossf = nn.CrossEntropyLoss()

    # 基线：默认规则≈选「最早可起」(特征 c7=is_earliest 在第 GLOBAL_DIM+7 列，标准化前=1)。
    # 用未标准化的 mask 行里 expert 落在 is_earliest 的比例做朴素基线参考。
    def topk_acc(logits, y):
        return (logits.argmax(1) == y).float().mean().item()

    best_val = -1.0
    best_state = None
    ntr = len(tr_idx)
    for ep in range(1, args.epochs + 1):
        model.train()
        perm = torch.randperm(ntr)
        tot = 0.0
        for b in range(0, ntr, args.batch):
            bi = perm[b:b + args.batch]
            logits = model(Xtr[bi], Mtr[bi])
            loss = lossf(logits, Ytr[bi])
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item() * len(bi)
        model.eval()
        with torch.no_grad():
            tr_acc = topk_acc(model(Xtr, Mtr), Ytr)
            v_logits = model(Xv, Mv)
            v_acc = topk_acc(v_logits, Yv)
            v_loss = lossf(v_logits, Yv).item()
        if v_acc > best_val:
            best_val = v_acc
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        if ep % 10 == 0 or ep == 1:
            print(f"ep {ep:>3}: train_loss {tot/ntr:.4f}  train_acc {tr_acc:.3f}  "
                  f"val_loss {v_loss:.4f}  val_acc {v_acc:.3f}")

    torch.save({
        "state": best_state, "feat_dim": F, "hidden": args.hidden,
        "mean": mean, "std": std,
    }, args.out)
    print(f"best val_acc={best_val:.3f}  → {args.out}")


if __name__ == "__main__":
    main()
