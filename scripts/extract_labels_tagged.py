"""与 extract_labels 同管线，但给每个 step 额外打上来源实例的 job 数（njob）标签，
用于按 1job / 多job 分层看 BC 准确率。输出 feats/mask/expert + njob（每 step 一个）。

用法：
  C:/Users/khand/Desktop/CT/venv/Scripts/python.exe scripts/extract_labels_tagged.py \
      --glob "dataset/train/**/inst_*.json" "dataset/test/**/inst_*.json"
"""
import argparse, glob, io, json, os, sys
from collections import Counter
from pathlib import Path
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import load_alg_entries, parse_task
from src.paths import input_data_path
from src.marathon_gen import expand_topo_pms, PM_POOL_6
from src.model import Durations
from src.features import FEATURE_DIM
from src.labels import extract_instance

BASE_TOPO = "s1-1c1p-preclean"
_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--glob", nargs="*",
                    default=["dataset/train/**/inst_*.json", "dataset/test/**/inst_*.json"])
    ap.add_argument("--out", type=str,
                    default=str(_ROOT / "dataset" / "train_artifacts" / "bc_labels_tagged.npz"))
    args = ap.parse_args()

    files = []
    for g in args.glob:
        files += glob.glob(str(_ROOT / g), recursive=True)
    files = sorted(set(files))

    ai0, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai0 = expand_topo_pms(ai0, PM_POOL_6)

    all_feats, all_expert, all_njob, all_clean = [], [], [], []
    njob_hist = Counter()
    n_tot = n_done = 0
    for f in files:
        d = json.load(open(f, encoding="utf-8"))
        res = d.get("result", {})
        if "schedule" not in res:
            continue
        n_tot += 1
        ir = parse_task(ai0, d["update_params"])
        njob = len(set(w.pjob_name for w in ir.wafers)) or 1
        has_clean = bool(ir.pre_clean or ir.post_clean or ir.dummy_wac
                         or any(getattr(s, "clean_time", 0) for w in ir.wafers for s in w.stages))
        tm = Durations(ir)
        records, completed = extract_instance(ir, tm, ir.wafers, res["schedule"])
        if not completed:
            continue
        n_done += 1
        njob_hist[njob] += 1
        for feats, expert in records:
            all_feats.append(feats)
            all_expert.append(expert)
            all_njob.append(njob)
            all_clean.append(int(has_clean))

    cmax = max(x.shape[0] for x in all_feats)
    N = len(all_feats)
    feats = np.zeros((N, cmax, FEATURE_DIM), dtype=np.float32)
    mask = np.zeros((N, cmax), dtype=np.float32)
    expert = np.array(all_expert, dtype=np.int64)
    njob = np.array(all_njob, dtype=np.int64)
    clean = np.array(all_clean, dtype=np.int64)
    for i, x in enumerate(all_feats):
        n = x.shape[0]
        feats[i, :n] = x
        mask[i, :n] = 1.0

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    np.savez_compressed(args.out, feats=feats, mask=mask, expert=expert,
                        njob=njob, clean=clean, feature_dim=FEATURE_DIM, cmax=cmax)
    print(f"实例完整复现 {n_done}/{n_tot}  步样本 {N}  cmax={cmax}")
    print(f"njob 分布(实例数): {dict(njob_hist)}")
    for k in sorted(set(all_njob)):
        print(f"  njob={k}: 步样本 {sum(1 for x in all_njob if x==k)}")
    print(f"→ {args.out}")


if __name__ == "__main__":
    main()
