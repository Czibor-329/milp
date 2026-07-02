"""
"""

import argparse
import glob
import io
import json
import os
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import load_alg_entries, parse_task
from src.paths import input_data_path, OUTPUT_DIR
from src.marathon_gen import expand_topo_pms, PM_POOL_6
from src.timing import start_schedule
from src.export import export_movelist

BASE_TOPO = "s1-1c1p-preclean"
# 数据集重组后子集用「目录/名」限定：train/* 为有 MILP 标签的配置网格（报 gap），
# test/* 为更大规模外推实例（MILP 超时/无标签，只跑 timing/BC、不计入 gap 统计）。
SUBSETS = ["train/1stage", "train/2stage", "train/3stage", "train/2job", "train/clean", "test/1stage"]
_DATASET = Path(__file__).resolve().parents[1] / "dataset"
_BC_OUT = OUTPUT_DIR / "bc"


def _resolve(sub: str) -> Path:
    """子集名 → 目录。支持限定名 train/2job、test/1stage；未限定名（如 1stage）
    优先取 train/<sub>，其次 test/<sub>（兼容旧写法）。"""
    if "/" in sub:
        return _DATASET / sub
    for root in ("train", "test"):
        p = _DATASET / root / sub
        if p.is_dir():
            return p
    return _DATASET / "train" / sub  # 兜底（下游 glob 得空、警告跳过）


def _instances(sub: str, limit: int = 0):
    """子集下的 inst_*.json（忽略 grid_eval.json / grid_heatmap.html 等非实例文件）。"""
    files = sorted(glob.glob(str(_resolve(sub) / "inst_*.json")))
    return files[:limit] if limit > 0 else files


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subsets", nargs="*", default=SUBSETS, help="测试子集（缺省=全部）")
    ap.add_argument("--limit", type=int, default=0, help="每子集只跑前 N 个（冒烟用，0=全部）")
    args = ap.parse_args()

    ai, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai = expand_topo_pms(ai, PM_POOL_6)

    if args.subsets[0] == 'all':
        args.subsets = SUBSETS
    for sub in args.subsets:
        files = _instances(sub, args.limit)
        for f in files:
            name = f"{sub}/{os.path.basename(f)[:-5]}"
            d = json.load(open(f, encoding="utf-8"))
            try:
                ir = parse_task(ai, d["update_params"])
                tres = start_schedule(ir, verbose=False, random_orders=False)
                _export_bc_movelist(ir,tres,sub,os.path.basename(f)[:-5])
            except Exception as e:  # noqa: BLE001
                print(f"{name:<26} timing 失败: {e}")
                continue


def _export_bc_movelist(ir, bres, sub: str, basename: str) -> None:
    """把 BC 策略排程导出成 MoveList，落 results/output/bc/<子集>/<inst>.json。"""
    ml = export_movelist(ir, bres)
    out = _BC_OUT / sub / f"{basename}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as fp:
        json.dump({"MoveList": ml}, fp, ensure_ascii=False)
    print(f"saved random MoveList at {out}")

if __name__ == "__main__":
    main()
