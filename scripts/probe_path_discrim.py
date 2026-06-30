"""探针：BC 特征能否区分「同一决策步里」属于不同 job/path 的候选？

策略对每个候选行独立打同一个 MLP 分（policy.py），故**若同一步内有两个候选的特征行相同**，
网络必给相同分 → 无法稳定偏好其中之一。专家（MILP）却只选了一个。这类「特征撞车」步就是
BC 模仿的不可约误差下界，也正是「分不清两条路径晶圆」的直接证据。

对一个 .npz 标签集（feats[N,C,F]、mask[N,C]、expert[N]）逐步统计：
  · tie：专家行在该步存在另一个特征近似相同（‖·‖∞<tol）的合法候选 → 该步「撞车」。
  · 撞车步里，最优分类器最多只能 1/重数 命中 → 累加得「特征可达上界」(feature ceiling)。
报告整体撞车率 + 特征可达 top-1 上界；并把专家被选行与其撞车竞争者的来源标出。
"""
import argparse, io, sys
from pathlib import Path
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", type=str,
                    default="dataset/train_artifacts/bc_labels_2job1s.npz")
    ap.add_argument("--tol", type=float, default=1e-4, help="特征行视为相同的 L∞ 阈值")
    args = ap.parse_args()

    z = np.load(args.labels)
    feats, mask, expert = z["feats"], z["mask"], z["expert"].astype(int)
    N, C, F = feats.shape

    tie_steps = 0
    multi_cand_steps = 0          # 有 ≥2 个合法候选的步（只有这些步才谈得上「分不清」）
    ceiling_num = 0.0             # Σ 1/重数（撞车步）+ 1（唯一步）
    tie_mult = []
    for n in range(N):
        valid = np.where(mask[n] > 0.5)[0]
        k = len(valid)
        if k <= 1:
            ceiling_num += 1.0
            continue
        multi_cand_steps += 1
        e = expert[n]
        ef = feats[n, e]
        # 与专家行 L∞ 距离 < tol 的合法候选（含自己）
        same = [j for j in valid
                if np.max(np.abs(feats[n, j] - ef)) < args.tol]
        m = len(same)
        if m > 1:
            tie_steps += 1
            tie_mult.append(m)
            ceiling_num += 1.0 / m
        else:
            ceiling_num += 1.0

    print("=" * 60)
    print(f"标签集 {args.labels}")
    print(f"步样本 N={N}  特征维 F={F}  候选上限 C={C}")
    print(f"多候选步（≥2 合法候选）：{multi_cand_steps}/{N}  "
          f"({100*multi_cand_steps/max(N,1):.0f}%)")
    print("-" * 60)
    print(f"特征撞车步（专家行有特征相同的竞争者，tol={args.tol}）：{tie_steps}")
    if multi_cand_steps:
        print(f"  占多候选步 {100*tie_steps/multi_cand_steps:.1f}%  "
              f"占全部步 {100*tie_steps/N:.1f}%")
    if tie_mult:
        u, ct = np.unique(tie_mult, return_counts=True)
        print(f"  撞车重数分布：{dict(zip(u.tolist(), ct.tolist()))}")
    print(f"特征可达 top-1 上界（Bayes-最优给定当前特征）：{ceiling_num/N:.3f}")
    print("  └ <1.000 = 仅凭当前 18 维特征**无法**完美复现专家：撞车步里两条路的候选不可分。")
    print("=" * 60)


if __name__ == "__main__":
    main()
