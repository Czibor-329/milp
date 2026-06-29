"""Benchmark：timing.py 定时层 vs MILP 的提速 / 质量对比。

对每个 case 同时跑两条路：
  · MILP   solve_milp(ir)          → 最优 makespan（瓶颈在组合定序，秒级）
  · 定时层 time_from_ir(ir)        → 固定启发式顺序的可行解（Bellman-Ford，毫秒级）
并打表对比 speedup 与 makespan gap%，末尾给汇总。

用法：
  python scripts/bench_timing.py                 # 跑默认代表性 case 集
  python scripts/bench_timing.py s1-1c1p-preclean d-2c   # 只跑指定 case
  python scripts/bench_timing.py --tl 120        # MILP 时限(秒)

解读：
  · gap% = (timing.makespan − milp.makespan) / milp.makespan，正=timing 偏大(劣)。
  · 多容量加工腔(1c2p)上 Cd 门簇互斥未建模，gap% 可能为负——那是漏约束(makespan 偏乐观)，
    不是"更优"。
  · 复核违例 viol>0 说明 timing 自身建图有 bug；feas=False 说明该启发式顺序在驻留下排不出。
"""

import argparse
import io
import sys
import time
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from CT.config.input_loader import load_alg_entries
from CT.config.paths import input_data_path
from CT.solutions.preprocess import preprocess
from CT.solutions.milp import solve_milp
from CT.solutions.timing import time_from_ir


# 代表性 case：单容量 / 多容量(命中未建模 Cd) / 双腔
DEFAULT_CASES = [
    "s1-1c1p-preclean", "s1-1c1p-postclean", "s1-1c1p-wacclean",
    "s1-1c2p-preclean", "s1-1c2p-postclean",
    "d-2c", "d-1c1p-preclean",
]


def _load_ir(name: str):
    name = name[:-5] if name.endswith(".json") else name
    ai, asch = load_alg_entries(input_data_path(name))
    ir, _ = preprocess(ai, asch)
    return ir


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", nargs="*", default=None, help="case 名（缺省=默认集）")
    ap.add_argument("--tl", type=float, default=300.0, help="MILP 求解时限(秒)")
    args = ap.parse_args()
    cases = args.cases or DEFAULT_CASES

    hdr = (f"{'case':<22} {'MILP mk':>9} {'MILP s':>8} | "
           f"{'tmg mk':>9} {'tmg ms':>8} {'feas':>5} {'viol':>5} | "
           f"{'speedup':>9} {'gap%':>8}")
    print("=" * len(hdr))
    print(hdr)
    print("-" * len(hdr))

    speedups, gaps = [], []
    for name in cases:
        try:
            ir = _load_ir(name)
        except Exception as e:  # noqa: BLE001
            print(f"{name:<22} 加载失败: {e}")
            continue

        # MILP
        t0 = time.perf_counter()
        try:
            mres = solve_milp(ir, time_limit=args.tl, verbose=False, ub=None)
            m_wall = time.perf_counter() - t0
            m_mk, m_s = mres.makespan, mres.runtime
        except Exception as e:  # noqa: BLE001
            print(f"{name:<22} MILP 失败: {e}")
            continue

        # 定时层
        try:
            tres = time_from_ir(ir, verbose=False, cross_check=True)
            t_mk = tres.makespan
            t_ms = tres.runtime * 1000.0
            feas = bool(getattr(tres, "feasible", False))
            viol = len(getattr(tres, "check_issues", []))
        except Exception as e:  # noqa: BLE001
            print(f"{name:<22} {m_mk:>9.1f} {m_s:>8.2f} | timing 失败: {e}")
            continue

        speedup = (m_s / tres.runtime) if tres.runtime > 0 else float("inf")
        gap = ((t_mk - m_mk) / m_mk * 100.0) if (feas and m_mk > 0) else float("nan")
        if feas:
            speedups.append(speedup)
            if m_mk > 0:
                gaps.append(gap)

        gap_str = f"{gap:>8.2f}" if gap == gap else f"{'n/a':>8}"
        print(f"{name:<22} {m_mk:>9.1f} {m_s:>8.2f} | "
              f"{t_mk:>9.1f} {t_ms:>8.1f} {str(feas):>5} {viol:>5} | "
              f"{speedup:>9.0f} {gap_str}")

    print("-" * len(hdr))
    if speedups:
        avg_sp = sum(speedups) / len(speedups)
        print(f"平均 speedup ≈ {avg_sp:,.0f}×  ({len(speedups)} 个可行 case)")
    if gaps:
        print(f"makespan gap%：平均 {sum(gaps)/len(gaps):+.2f}  "
              f"最大 {max(gaps):+.2f}  最小 {min(gaps):+.2f}")
    print("=" * len(hdr))
    print("注：1c2p 多容量加工腔 Cd 门簇互斥未建模，负 gap% 是漏约束(偏乐观)非更优；"
          "viol>0=timing 建图 bug；feas=False=该启发式顺序排不出。")


if __name__ == "__main__":
    main()
