"""Benchmark：timing 基线（腔分配寻优 + 默认定序）+ BC 策略 vs MILP 最优标签，在 dataset/test 批量对比。

本脚本直接吃 dataset 实例（含 spec/update_params/result），用 result.makespan 作 MILP 基准
（不重跑 Gurobi），逐实例跑 timing 基线（time_from_ir）+ BC 策略（time_from_policy）并对比
gap% 与计算时间。BC 生成的排程会导出 MoveList 到 results/output/bc/<子集>/inst_XXXX.json。

注：time_from_ir/time_from_policy 现在都先做【腔分配寻优】(loadlock + 并行加工腔，毫秒级 BF
评估)，再分别走默认/策略定序。腔分配是逼近 MILP 的最大杠杆——round-robin 默认让每片 entry/exit
同腔、并行腔串行化（旧 gap +15~70%）；寻优后多数例命中 MILP。残留正 gap（2stage 2腔例、
3PM-长proc 例）是 backward 定序器流水表达力限制。
  · 个别小负 gap（≤1.3%，仅多 PM 例）非 bug、非乐观：MILP 只优化 loadlock 分配、**PM 写死
    round-robin**（见 milp.py「PM 仍写死」），而本层把 PM 分配也寻优了，故能找到比 MILP 标签更优
    的可行解。已证实：把本层选的 PM 分配回灌 MILP，MILP 复得同一更优值（status=2 gap=0）；且独立
    校验器（不复用 solve_timing/check_solution）对全部 timing+BC 排程 0 违例。
  · 警示：本表 gap 大幅收窄主要来自【腔分配寻优(搜索)】，非 BC 网络本身；bc% 多数 == b%（同基底），
    学到的策略仅在少数例(1stage/10·11、2stage/5)较默认定序再压 ≤2.4%。

实例重建 ir 的路径（见 manifest base_topo=s1-1c1p-preclean）：
  load_alg_entries(s1-1c1p-preclean) → expand_topo_pms(PM_POOL_6) → parse_task(topo, update_params)

用法：
  python scripts/eval_dataset.py                                  # 全 3 子集
  python scripts/eval_dataset.py --subsets 1stage --limit 3       # 冒烟
  python scripts/eval_dataset.py --out eval.json                  # 写逐实例+汇总 JSON

解读：
  · gap% = (timing.makespan − milp.makespan) / milp.makespan，正=timing 偏大(劣)。
  · b%=固定顺序 gap，bc%=BC 策略 gap。
  · feas=False=该顺序在驻留下排不出；viol>0=timing 自身建图有 bug（应为 0）。
  · MILP status≠2 或标签为 nan（超时/不可行）的实例：仍跑 timing，但不计入 gap 统计。
  · 多容量加工腔 Cd 门簇互斥未建模，个别 case 可能负 gap（漏约束偏乐观，非更优）。
"""

import argparse
import glob
import io
import json
import math
import os
import sys
import time
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import load_alg_entries, parse_task
from src.paths import input_data_path, MODELS_DIR, OUTPUT_DIR
from src.marathon_gen import expand_topo_pms, PM_POOL_6
from src.timing import time_from_ir, time_from_policy
from src.milp import export_movelist
from src.policy import load_policy

BASE_TOPO = "s1-1c1p-preclean"
SUBSETS = ["1stage", "1stage_e", "2stage", "3stage"]
_DATASET_TEST = Path(__file__).resolve().parents[1] / "dataset" / "test"
_BC_OUT = OUTPUT_DIR / "bc"


def _valid_label(result: dict) -> bool:
    """实例是否带可用的 MILP 最优标签（status==2 且 makespan 非 nan）。"""
    mk = result.get("makespan")
    return result.get("status") == 2 and isinstance(mk, (int, float)) and not math.isnan(mk)


def _instances(sub: str, limit: int = 0):
    """子集下的 inst_*.json（忽略 grid_eval.json / grid_heatmap.html 等非实例文件）。"""
    files = sorted(glob.glob(str(_DATASET_TEST / sub / "inst_*.json")))
    return files[:limit] if limit > 0 else files


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subsets", nargs="*", default=SUBSETS, help="测试子集（缺省=全部）")
    ap.add_argument("--limit", type=int, default=0, help="每子集只跑前 N 个（冒烟用，0=全部）")
    ap.add_argument("--out", type=str, default=None, help="把逐实例+汇总写成 JSON")
    args = ap.parse_args()

    policy = load_policy(MODELS_DIR / "bc_policy.pt")

    # 基础物理拓扑只加载/expand 一次，循环复用
    ai, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai = expand_topo_pms(ai, PM_POOL_6)

    hdr = (f"{'case':<26} {'MILP mk':>9} | {'tmg mk':>9} {'bc mk':>9} "
           f"{'tmg ms':>8} {'bc ms':>8} {'feas':>5} {'viol':>5} | {'b%':>7} {'bc%':>7}")

    records = []
    all_gaps, all_bgaps = [], []
    grand_feas = grand_n = 0
    for sub in args.subsets:
        files = _instances(sub, args.limit)
        if not files:
            print(f"[warn] 子集 {sub} 无实例，跳过。")
            continue
        print("=" * len(hdr))
        print(f"子集 {sub}（{len(files)} 实例）")
        print(hdr)
        print("-" * len(hdr))

        gaps, bgaps, tms_list, bms_list = [], [], [], []
        feas_cnt = 0
        for f in files:
            name = f"{sub}/{os.path.basename(f)[:-5]}"
            d = json.load(open(f, encoding="utf-8"))
            has_label = _valid_label(d["result"])
            m_mk = float(d["result"]["makespan"]) if has_label else float("nan")

            try:
                ir = parse_task(ai, d["update_params"])
                t0 = time.perf_counter()
                tres = time_from_ir(ir, verbose=False, cross_check=True)
                t_ms = (time.perf_counter() - t0) * 1000.0
                t_mk = tres.makespan
                feas = bool(getattr(tres, "feasible", False))
                viol = len(getattr(tres, "check_issues", []))
            except Exception as e:  # noqa: BLE001
                print(f"{name:<26} timing 失败: {e}")
                continue

            b_mk = float("nan")
            b_ms = float("nan")
            if policy is not None:
                try:
                    t0 = time.perf_counter()
                    bres = time_from_policy(ir, policy, verbose=False, cross_check=False)
                    b_ms = (time.perf_counter() - t0) * 1000.0
                    if bool(getattr(bres, "feasible", False)):
                        b_mk = bres.makespan
                        _export_bc_movelist(ir, bres, sub, os.path.basename(f)[:-5])
                except Exception as e:  # noqa: BLE001
                    print(f"  [warn] {name} bc 失败: {e}")

            gap = ((t_mk - m_mk) / m_mk * 100.0) if (feas and has_label and m_mk > 0) else float("nan")
            bgap = ((b_mk - m_mk) / m_mk * 100.0) if (b_mk == b_mk and has_label and m_mk > 0) else float("nan")
            if feas:
                feas_cnt += 1
                tms_list.append(t_ms)
                if b_ms == b_ms:
                    bms_list.append(b_ms)
                if gap == gap:
                    gaps.append(gap)
                if bgap == bgap:
                    bgaps.append(bgap)

            mmk_str = f"{m_mk:>9.1f}" if has_label else f"{'n/a':>9}"
            bmk_str = f"{b_mk:>9.1f}" if b_mk == b_mk else f"{'-':>9}"
            bms_str = f"{b_ms:>8.1f}" if b_ms == b_ms else f"{'-':>8}"
            gap_str = f"{gap:>7.2f}" if gap == gap else f"{'n/a':>7}"
            bgap_str = f"{bgap:>7.2f}" if bgap == bgap else f"{'-':>7}"
            print(f"{name:<26} {mmk_str} | {t_mk:>9.1f} {bmk_str} "
                  f"{t_ms:>8.1f} {bms_str} {str(feas):>5} {viol:>5} | {gap_str} {bgap_str}")

            records.append({
                "case": name, "milp": m_mk if has_label else None, "has_label": has_label,
                "tmg_mk": t_mk, "bc_mk": b_mk if b_mk == b_mk else None,
                "tmg_ms": t_ms, "bc_ms": b_ms if b_ms == b_ms else None,
                "feasible": feas, "viol": viol,
                "gap": gap if gap == gap else None,
                "bgap": bgap if bgap == bgap else None,
            })

        print("-" * len(hdr))
        print(f"  可行 {feas_cnt}/{len(files)}"
              + (f"  固定顺序 gap%：平均 {sum(gaps)/len(gaps):+.2f} 最大 {max(gaps):+.2f} 最小 {min(gaps):+.2f}" if gaps else "")
              + (f"  bc gap%：平均 {sum(bgaps)/len(bgaps):+.2f} 最大 {max(bgaps):+.2f} 最小 {min(bgaps):+.2f}" if bgaps else ""))
        print(f"  平均计算时间：固定顺序 {sum(tms_list)/len(tms_list):.1f} ms" if tms_list else "  平均计算时间：固定顺序 n/a",
              end="")
        print((f"  bc {sum(bms_list)/len(bms_list):.1f} ms" if bms_list else ""))
        all_gaps += gaps
        all_bgaps += bgaps
        grand_feas += feas_cnt
        grand_n += len(files)

    print("=" * len(hdr))
    print(f"总体：可行 {grand_feas}/{grand_n}")
    if all_gaps:
        print(f"  固定顺序 gap%：平均 {sum(all_gaps)/len(all_gaps):+.2f}  最大 {max(all_gaps):+.2f}  最小 {min(all_gaps):+.2f}  (n={len(all_gaps)})")
    if all_bgaps:
        print(f"  bc       gap%：平均 {sum(all_bgaps)/len(all_bgaps):+.2f}  最大 {max(all_bgaps):+.2f}  最小 {min(all_bgaps):+.2f}  (n={len(all_bgaps)})")
    print(f"  BC MoveList 导出 → {_BC_OUT}")
    print("=" * len(hdr))

    if args.out:
        summary = {
            "feasible": grand_feas, "total": grand_n,
            "gap_mean": (sum(all_gaps)/len(all_gaps)) if all_gaps else None,
            "bgap_mean": (sum(all_bgaps)/len(all_bgaps)) if all_bgaps else None,
        }
        with open(args.out, "w", encoding="utf-8") as fp:
            json.dump({"summary": summary, "records": records}, fp, ensure_ascii=False, indent=2)
        print(f"已写 {len(records)} 条记录 + 汇总 → {args.out}")


def _export_bc_movelist(ir, bres, sub: str, basename: str) -> None:
    """把 BC 策略排程导出成 MoveList，落 results/output/bc/<子集>/<inst>.json。"""
    ml = export_movelist(ir, bres)
    out = _BC_OUT / sub / f"{basename}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as fp:
        json.dump({"MoveList": ml}, fp, ensure_ascii=False)


if __name__ == "__main__":
    main()
