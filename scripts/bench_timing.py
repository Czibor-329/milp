"""Benchmark：timing.py 定时层 vs MILP 的提速 / 质量对比。

对每个 case 同时跑三条路：
  · MILP   solve_milp(ir)          → 最优 makespan（瓶颈在组合定序，秒级）
  · 单次   time_from_ir(ir)        → 定死 backward 定序的可行解（Bellman-Ford，毫秒级）
  · 寻优   optimize_from_ir(ir)    → 局部搜索（占用序 + loadlock 选腔）逼近 MILP（anytime，秒级）
并打表对比 speedup 与 makespan gap%（单次 b% / 寻优 o%），末尾给汇总。

用法：
  python scripts/bench_timing.py                 # 跑默认代表性 case 集
  python scripts/bench_timing.py s1-1c1p-preclean d-2c   # 只跑指定 case
  python scripts/bench_timing.py --tl 120        # MILP 时限(秒)
  python scripts/bench_timing.py --opt-budget 3  # 寻优墙钟预算(秒)，0=跳过寻优只跑单次

解读：
  · gap% = (timing.makespan − milp.makespan) / milp.makespan，正=timing 偏大(劣)。
  · b%=单次定序 gap，o%=寻优后 gap；寻优 incumbent=单次解，故 o% ≤ b%（最坏不退化）。
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
from CT.solutions.timing import time_from_ir, optimize_from_ir


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
    ap.add_argument("--opt-budget", type=float, default=3.0,
                    help="寻优墙钟预算(秒)，0=跳过寻优")
    args = ap.parse_args()
    cases = args.cases or DEFAULT_CASES
    do_opt = args.opt_budget > 0

    hdr = (f"{'case':<22} {'MILP mk':>9} {'MILP s':>8} | "
           f"{'tmg mk':>9} {'opt mk':>9} {'tmg ms':>8} {'feas':>5} {'viol':>5} | "
           f"{'speedup':>9} {'b%':>7} {'o%':>7}")
    print("=" * len(hdr))
    print(hdr)
    print("-" * len(hdr))

    speedups, gaps, ogaps = [], [], []
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

        # 单次定序
        try:
            tres = time_from_ir(ir, verbose=False, cross_check=True)
            t_mk = tres.makespan
            t_ms = tres.runtime * 1000.0
            feas = bool(getattr(tres, "feasible", False))
            viol = len(getattr(tres, "check_issues", []))
        except Exception as e:  # noqa: BLE001
            print(f"{name:<22} {m_mk:>9.1f} {m_s:>8.2f} | timing 失败: {e}")
            continue

        # 寻优（局部搜索）
        o_mk = float("nan")
        if do_opt:
            try:
                ores = optimize_from_ir(ir, budget=args.opt_budget, verbose=False,
                                        cross_check=False)
                if bool(getattr(ores, "feasible", False)):
                    o_mk = ores.makespan
            except Exception as e:  # noqa: BLE001
                print(f"  [warn] {name} 寻优失败: {e}")

        speedup = (m_s / tres.runtime) if tres.runtime > 0 else float("inf")
        gap = ((t_mk - m_mk) / m_mk * 100.0) if (feas and m_mk > 0) else float("nan")
        ogap = ((o_mk - m_mk) / m_mk * 100.0) if (o_mk == o_mk and m_mk > 0) else float("nan")
        if feas:
            speedups.append(speedup)
            if m_mk > 0:
                gaps.append(gap)
                if ogap == ogap:
                    ogaps.append(ogap)

        gap_str = f"{gap:>7.2f}" if gap == gap else f"{'n/a':>7}"
        ogap_str = f"{ogap:>7.2f}" if ogap == ogap else f"{'-':>7}"
        omk_str = f"{o_mk:>9.1f}" if o_mk == o_mk else f"{'-':>9}"
        print(f"{name:<22} {m_mk:>9.1f} {m_s:>8.2f} | "
              f"{t_mk:>9.1f} {omk_str} {t_ms:>8.1f} {str(feas):>5} {viol:>5} | "
              f"{speedup:>9.0f} {gap_str} {ogap_str}")

    print("-" * len(hdr))
    if speedups:
        avg_sp = sum(speedups) / len(speedups)
        print(f"平均 speedup ≈ {avg_sp:,.0f}×  ({len(speedups)} 个可行 case)")
    if gaps:
        print(f"单次 gap%：平均 {sum(gaps)/len(gaps):+.2f}  最大 {max(gaps):+.2f}  最小 {min(gaps):+.2f}")
    if ogaps:
        print(f"寻优 gap%：平均 {sum(ogaps)/len(ogaps):+.2f}  最大 {max(ogaps):+.2f}  最小 {min(ogaps):+.2f}")
    print("=" * len(hdr))
    print("注：b%=单次定序 gap，o%=寻优后 gap(o%≤b%)；1c2p 多容量加工腔 Cd 未建模，负 gap% 是漏约束"
          "(偏乐观)非更优；viol>0=timing 建图 bug；feas=False=该启发式顺序排不出。")


if __name__ == "__main__":
    main()
