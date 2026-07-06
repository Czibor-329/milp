"""用 sklearn 经典模型（随机森林/SVM/逻辑回归/GBDT）替代 NN 做 BC 候选打分，横向比准确率。

复用 train_bc.py 的同一份标签 bc_labels.npz（feats [N,C,F] / mask [N,C] / expert [N]）。
框架与 CandidateScorer 一致：逐候选独立打分 ⇒ 把每个真实候选行摊平成一条样本，
二分类标签 = 是否被专家选中；推理时对同一 step 的所有候选打「正类概率」取 argmax，
与专家 idx 比＝step 级 top-1 准确率（与 NN 的 val_acc 同口径，可直接对比）。

关键：train/val 按 STEP 划分（不是按候选行），否则同一 step 的候选跨集泄漏。
特征标准化 mean/std 只用训练集真实候选行算（与 NN 一致）。CPU 秒级。

用法（须用装了 sklearn 的 venv）：
  C:/Users/khand/Desktop/CT/venv/Scripts/python.exe scripts/train_bc_sklearn.py
  ... --labels dataset/train_artifacts/bc_labels.npz --val-frac 0.15 --seed 0
"""

import argparse
import io
import sys
import time
from pathlib import Path

import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.svm import SVC
from sklearn.linear_model import LogisticRegression

_ROOT = Path(__file__).resolve().parents[1]


def step_top1(clf, Xv, groups_v, expert_v, use_proba=True):
    """对每个 step 的候选打分取 argmax，与专家 idx（该 step 内的候选序号）比。"""
    if use_proba:
        # 正类概率（class==1 那列）
        classes = list(clf.classes_)
        pi = classes.index(1) if 1 in classes else -1
        scores = clf.predict_proba(Xv)[:, pi]
    else:
        scores = clf.decision_function(Xv)
    correct = 0
    total = 0
    for g_start, g_len, exp in groups_v:
        sc = scores[g_start:g_start + g_len]
        if int(np.argmax(sc)) == exp:
            correct += 1
        total += 1
    return correct / max(total, 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", type=str,
                    default=str(_ROOT / "dataset" / "train_artifacts" / "bc_labels.npz"))
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--njob", type=int, default=0,
                    help="只保留该 job 数的 step（0=全部；需 labels 带 njob 字段）")
    ap.add_argument("--no-clean", action="store_true",
                    help="剔除含清洁的 step（需 labels 带 clean 字段）")
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    z = np.load(args.labels)
    feats = z["feats"].astype(np.float32)   # [N, C, F]
    mask = z["mask"].astype(np.float32)     # [N, C]
    expert = z["expert"].astype(np.int64)   # [N]  step 内被选候选序号
    keep = np.ones(len(feats), dtype=bool)
    if args.njob > 0:
        if "njob" not in z.files:
            raise SystemExit("labels 无 njob 字段，请用 extract_labels_tagged.py 生成的 npz")
        keep &= z["njob"].astype(np.int64) == args.njob
    if args.no_clean:
        if "clean" not in z.files:
            raise SystemExit("labels 无 clean 字段，请用 extract_labels_tagged.py 生成的 npz")
        keep &= z["clean"].astype(np.int64) == 0
    if not keep.all():
        feats, mask, expert = feats[keep], mask[keep], expert[keep]
        print(f"[过滤 njob={args.njob or '*'} no_clean={args.no_clean}] 保留 {int(keep.sum())}/{len(keep)} steps")
    N, C, F = feats.shape
    print(f"labels: N(steps)={N}  cmax={C}  feat_dim={F}")

    # 按 step 划 train/val
    idx = rng.permutation(N)
    n_val = int(N * args.val_frac)
    val_steps = set(idx[:n_val].tolist())

    # 摊平成候选行样本：只留真实候选（mask>0.5）。同时为 val 记录分组以便 step 级评测。
    Xtr_l, ytr_l = [], []
    Xv_flat_l, val_groups = [], []   # val_groups: (start_in_Xv, len, expert_local_idx)
    v_cursor = 0
    for i in range(N):
        m = mask[i] > 0.5
        rows = feats[i][m]                     # [n_cand, F]
        n_cand = rows.shape[0]
        # expert 是在【全候选(含padding前)】里的序号；真实候选按顺序排在前 n_cand 个，
        # mask 前 n_cand 为 True（构造保证）⇒ expert 直接就是真实候选内的序号。
        exp = int(expert[i])
        if i in val_steps:
            Xv_flat_l.append(rows)
            val_groups.append((v_cursor, n_cand, exp))
            v_cursor += n_cand
        else:
            lab = np.zeros(n_cand, dtype=np.int64)
            lab[exp] = 1
            Xtr_l.append(rows)
            ytr_l.append(lab)

    Xtr = np.concatenate(Xtr_l, 0)
    ytr = np.concatenate(ytr_l, 0)
    Xv = np.concatenate(Xv_flat_l, 0)
    print(f"train rows={len(Xtr)} (pos={int(ytr.sum())})  val steps={len(val_groups)} rows={len(Xv)}")

    # 标准化：只用训练集算 mean/std
    mean = Xtr.mean(0)
    std = Xtr.std(0)
    std[std < 1e-6] = 1.0
    Xtr_n = (Xtr - mean) / std
    Xv_n = (Xv - mean) / std

    # 训练集 step 级评测也要分组
    tr_groups = []
    t_cursor = 0
    for i in range(N):
        if i in val_steps:
            continue
        n_cand = int((mask[i] > 0.5).sum())
        tr_groups.append((t_cursor, n_cand, int(expert[i])))
        t_cursor += n_cand

    models = {
        "RandomForest": (RandomForestClassifier(
            n_estimators=400, max_depth=None, min_samples_leaf=2,
            class_weight="balanced", n_jobs=-1, random_state=args.seed), True),
        "GradBoost": (GradientBoostingClassifier(random_state=args.seed), True),
        "SVM-rbf": (SVC(kernel="rbf", C=2.0, gamma="scale",
                        class_weight="balanced", probability=False,
                        random_state=args.seed), False),
        "LogReg": (LogisticRegression(max_iter=2000, class_weight="balanced",
                                      random_state=args.seed), True),
    }

    print(f"\n{'model':<14}{'train_acc':>10}{'val_acc':>10}{'fit_s':>8}")
    print("-" * 42)
    results = []
    for name, (clf, use_proba) in models.items():
        t0 = time.time()
        clf.fit(Xtr_n, ytr)
        dt = time.time() - t0
        tr_acc = step_top1(clf, Xtr_n, tr_groups, None, use_proba)
        v_acc = step_top1(clf, Xv_n, val_groups, None, use_proba)
        results.append((name, tr_acc, v_acc, dt))
        print(f"{name:<14}{tr_acc:>10.3f}{v_acc:>10.3f}{dt:>8.1f}")

    best = max(results, key=lambda r: r[2])
    print(f"\nbest val_acc: {best[0]} = {best[2]:.3f}")
    print("（NN 基线 val_acc 见 train_bc.py 输出，同口径 step 级 top-1）")


if __name__ == "__main__":
    main()
