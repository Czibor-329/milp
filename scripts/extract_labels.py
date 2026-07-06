"""抽取 BC 标签：遍历数据集实例，teacher-forced 复现 MILP 服务序 → 每步 (候选特征, 专家 idx)。

数据集即 dataset/test/**（swap-free，由 gen_test.py 生成）——本仓库「测试集即训练集」：同一套
干净实例既抽标签训练、又供 run.py 评测。只收「完整复现」的实例（标签自洽 + 近 MILP）。
变长候选用 padding+mask 存成 .npz。末尾按 family（stage 数 × 腔数）报覆盖率。

用法：
  python scripts/extract_labels.py                       # 全 dataset/test/** → train_artifacts/bc_labels.npz
  python scripts/extract_labels.py --limit 100           # 冒烟
  python scripts/extract_labels.py --glob "dataset/train/inst_*.json" --splits train   # 旧 train 集（如仍在）
"""

import argparse
import glob
import io
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import load_alg_entries
from src.paths import input_data_path
from src.marathon_gen import expand_topo_pms, PM_POOL_6
from src.parse import parse_task
from src.model import Durations
from src.features import FEATURE_DIM
from src.labels import extract_instance

BASE_TOPO = "s1-1c1p-preclean"
_ROOT = Path(__file__).resolve().parents[1]


def _family(spec: dict) -> str:
    """返回stage中最多的腔室数"""
    ns = spec.get("n_stage")
    if ns is None:
        ns = len(spec.get("stages", [[]]))
    stages = spec.get("stages", [])
    nch = max((len(s) for s in stages), default=1) if stages else 1
    return f"st{ns}_ch{nch}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--splits", nargs="*", default=["test"], help="收哪些 split（默认 test=训练集）")
    ap.add_argument("--glob", type=str, default="dataset/test/**/inst_*.json",
                    help="实例 glob（相对仓库根，默认递归收 dataset/test/**）")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 个实例（冒烟，0=全部）")
    ap.add_argument("--out", type=str,
                    default=str(_ROOT / "dataset" / "train_artifacts" / "bc_labels.npz"))
    args = ap.parse_args()

    files = sorted(glob.glob(str(_ROOT / args.glob), recursive=True))
    if args.limit > 0:
        files = files[:args.limit]

    ai0, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai0 = expand_topo_pms(ai0, PM_POOL_6)

    all_feats = []          # list of [n_cand, F]
    all_expert = []         # list of int
    fam_tot = defaultdict(int)
    fam_done = defaultdict(int)
    fam_samp = defaultdict(int)
    n_tot = n_done = 0
    for f in files:
        d = json.load(open(f, encoding="utf-8"))
        if d.get("split") not in args.splits:
            continue
        res = d.get("result", {})
        fam = _family(d.get("spec", {}))
        fam_tot[fam] += 1
        n_tot += 1
        ir = parse_task(ai0, d["update_params"])
        tm = Durations(ir)
        records, completed = extract_instance(ir, tm, ir.wafers, res["schedule"])
        if not completed:
            print(f"inst {n_tot} failed")
            continue
        n_done += 1
        fam_done[fam] += 1
        for feats, expert in records:
            all_feats.append(feats)
            all_expert.append(expert)
            fam_samp[fam] += 1

    if not all_feats:
        print("没有可用标签（无完整复现实例）。"); return

    cmax = max(x.shape[0] for x in all_feats)
    N = len(all_feats)
    feats = np.zeros((N, cmax, FEATURE_DIM), dtype=np.float32)
    mask = np.zeros((N, cmax), dtype=np.float32)
    expert = np.array(all_expert, dtype=np.int64)
    for i, x in enumerate(all_feats):
        n = x.shape[0]
        feats[i, :n] = x
        mask[i, :n] = 1.0

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    np.savez_compressed(args.out, feats=feats, mask=mask, expert=expert,
                        feature_dim=FEATURE_DIM, cmax=cmax)

    print("=" * 64)
    print(f"实例：完整复现 {n_done}/{n_tot} ({100*n_done/max(n_tot,1):.0f}%)   "
          f"步样本 {N}   候选上限 cmax={cmax}   特征维 {FEATURE_DIM}")
    print(f"→ {args.out}")
    print("-" * 64)
    print(f"{'family':<12} {'实例':>6} {'完整':>6} {'覆盖%':>7} {'步样本':>8}")
    for fam in sorted(fam_tot):
        cov = 100 * fam_done[fam] / max(fam_tot[fam], 1)
        print(f"{fam:<12} {fam_tot[fam]:>6} {fam_done[fam]:>6} {cov:>7.0f} {fam_samp[fam]:>8}")
    print("=" * 64)


if __name__ == "__main__":
    main()
