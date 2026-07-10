"""统一入口：一种调度策略 → 排程 → 自检 / 导出 MoveList / 对比 MILP 标签。

取代旧 run_.py / run_milp.py / eval_dataset.py 三脚本。策略（--strategy，可多选）：
  · heuristic  快速启发式定序（单 job 喂片 / 2+ job 配比搜 / 清洁排空 + backward 兜底）。start_schedule。
  · random     启发式基底上叠 N 次随机定序 rollout 取优。start_schedule(random_orders=N)。
  · bc         BC 策略【联合选腔 + 定序】。start_schedule_by_policy（需 results/models/bc_policy.pt）。
  · milp       Gurobi oracle（重跑，非读标签）。solve_milp。作参考/oracle，覆盖旧 run_milp。

两种运行模式：
  · 数据集批量（默认）：遍历 dataset 子集，逐实例跑所选策略，与 result.makespan(MILP 标签) 比 gap%，
    打印表 + 汇总；--export 导出各策略 MoveList 到 results/output/<strategy>/<子集>/inst_XXXX.json。
  · 单场景（--input NAME）：跑 src/input_data/NAME.json 一个场景（无标签），自检 + 可选导出。

每个可行解都做双层自检（v 列 = 违例数，非 0 时逐条打印）：schedule 层 check_solution（P/C/R/LL/Clean）
+ MoveList 层 validate_movelist（LL 压力态：type-10 与门/取放不重叠、大气手须 ATM/真空手须 VAC、链衔接）。

用法：
  python scripts/run.py                                         # 全子集，仅 heuristic
  python scripts/run.py --strategy heuristic bc random          # 三策略对比
  python scripts/run.py --strategy all --subsets train/2job --limit 3   # 冒烟
  python scripts/run.py --strategy bc --export --out eval.json  # 导出 MoveList + 汇总 JSON
  python scripts/run.py --strategy milp --input s1-1c1p-preclean --export   # 旧 run_milp
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
from src.timing import start_schedule, start_schedule_by_policy
from src.milp import solve_milp
from export.export import check_solution, export_movelist, validate_move_list

BASE_TOPO = "s1-1c1p-preclean"
# 子集用「目录/名」限定：train/* 有 MILP 标签的配置网格（报 gap）；test/* 大规模外推（无标签，不计 gap）。
SUBSETS = ["train/1stage", "train/2stage", "train/3stage", "train/2job", "train/clean", "test/1stage"]
STRATEGIES = ["heuristic", "random", "bc", "milp"]
_DATASET = Path(__file__).resolve().parents[1] / "dataset"


# --------------------------------------------------------------------------- #
# 策略分发 + 通用可行性
# --------------------------------------------------------------------------- #
def _ok(res) -> bool:
    """排程是否可行：有解、makespan 非 nan、schedule 非空（统一 timing/milp 两种结果口径）。"""
    if res is None:
        return False
    mk = getattr(res, "makespan", float("nan"))
    return mk == mk and bool(getattr(res, "schedule", None))


def run_strategy(name: str, ir, *, policy=None, random_orders: int = 64,
                 tl: float = 300.0, seed: int = 0, verbose: bool = False):
    """跑一种策略 → (SolveResult|None, wall_ms)。bc 无 policy 时返回 (None, nan)。"""
    t0 = time.perf_counter()
    if name == "heuristic":
        res = start_schedule(ir, verbose=verbose)
    elif name == "random":
        res = start_schedule(ir, verbose=verbose, seed=seed, random_orders=random_orders)
    elif name == "bc":
        if policy is None:
            return None, float("nan")
        res = start_schedule_by_policy(ir, policy, seed=seed)
    elif name == "milp":
        res = solve_milp(ir, time_limit=tl, verbose=verbose)
    else:
        raise ValueError(f"未知策略 {name}")
    return res, (time.perf_counter() - t0) * 1000.0


def _check_all(ir, res, init_data=None) -> tuple:
    """可行解统一双层校验：schedule 层(check_solution) + MoveList 层(validate_movelist)。
    每次排程都构建 MoveList 并校验（不管是否 --export），返回 (违例列表, MoveList)。"""
    issues = check_solution(ir, res)
    ml = export_movelist(ir, res)
    return issues + validate_move_list(ir, ml, init_data), ml


def _export(ml, strategy: str, sub: str, basename: str) -> None:
    """导出 MoveList 到 results/output/<strategy>/<子集>/<inst>.json。"""
    out = OUTPUT_DIR / strategy / sub / f"{basename}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as fp:
        json.dump({"MoveList": ml}, fp, ensure_ascii=False)


# --------------------------------------------------------------------------- #
# 数据集定位
# --------------------------------------------------------------------------- #
def _valid_label(result: dict) -> bool:
    """实例是否带可用 MILP 标签：有可行解（makespan 非 nan 且 schedule 非空）。"""
    mk = result.get("makespan")
    return (isinstance(mk, (int, float)) and not math.isnan(mk)
            and bool(result.get("schedule")))


def _resolve(sub: str) -> Path:
    """子集名 → 目录。限定名(train/2job)直用；未限定名优先 train/<sub>，其次 test/<sub>。"""
    if "/" in sub:
        return _DATASET / sub
    for root in ("train", "test"):
        p = _DATASET / root / sub
        if p.is_dir():
            return p
    return _DATASET / "train" / sub


def _instances(sub: str, limit: int = 0):
    files = sorted(glob.glob(str(_resolve(sub) / "inst_*.json")))
    return files[:limit] if limit > 0 else files


def _load_policy():
    try:
        from src.policy import load_policy
        return load_policy(MODELS_DIR / "bc_policy.pt")
    except Exception as e:  # noqa: BLE001
        print(f"[warn] load_policy 失败（{e}），bc 策略将跳过。")
        return None


# --------------------------------------------------------------------------- #
# 模式一：数据集批量对比
# --------------------------------------------------------------------------- #
def run_dataset(args, strategies, policy) -> None:
    ai, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai = expand_topo_pms(ai, PM_POOL_6)

    hdr = f"{'case':<26} {'MILP':>9} |"
    for s in strategies:
        hdr += f" {s[:6]+' mk':>10} {'ms':>7} {'gap%':>7} {'f':>2} {'v':>2} |"

    records = []
    grand = {s: {"gaps": [], "ms": [], "feas": 0} for s in strategies}
    grand_n = 0
    subsets = SUBSETS if (args.subsets and args.subsets[0] == "all") else args.subsets

    for sub in subsets:
        files = _instances(sub, args.limit)
        if not files:
            print(f"[warn] 子集 {sub} 无实例，跳过。")
            continue
        print("=" * len(hdr))
        print(f"子集 {sub}（{len(files)} 实例）")
        print(hdr)
        print("-" * len(hdr))

        sub_stat = {s: {"gaps": [], "ms": [], "feas": 0} for s in strategies}
        for f in files:
            name = f"{sub}/{os.path.basename(f)[:-5]}"
            basename = os.path.basename(f)[:-5]
            d = json.load(open(f, encoding="utf-8"))
            has_label = _valid_label(d["result"])
            m_mk = float(d["result"]["makespan"]) if has_label else float("nan")

            try:
                ir = parse_task(ai, d["update_params"])
            except Exception as e:  # noqa: BLE001
                print(f"{name:<26} parse 失败: {e}")
                continue

            row = f"{name:<26} {(f'{m_mk:.1f}' if has_label else 'n/a'):>9} |"
            rec = {"case": name, "milp": m_mk if has_label else None, "has_label": has_label}
            for s in strategies:
                try:
                    res, ms = run_strategy(s, ir, policy=policy, random_orders=args.random_orders,
                                           tl=args.tl, seed=args.seed)
                except Exception as e:  # noqa: BLE001
                    print(f"  [warn] {name} {s} 失败: {e}")
                    res, ms = None, float("nan")
                feas = _ok(res)
                mk = res.makespan if feas else float("nan")
                issues, ml = _check_all(ir, res, ai) if feas else ([], None)
                viol = len(issues)
                for x in issues[:4]:
                    print(f"  [viol] {name} {s}: {x}")
                gap = ((mk - m_mk) / m_mk * 100.0) if (feas and has_label and m_mk > 0) else float("nan")
                if feas:
                    sub_stat[s]["feas"] += 1
                    if ms == ms:
                        sub_stat[s]["ms"].append(ms)
                    if gap == gap:
                        sub_stat[s]["gaps"].append(gap)
                    if args.export:
                        _export(ml, s, sub, basename)
                row += (f" {(f'{mk:.1f}' if feas else '-'):>10} {(f'{ms:.1f}' if ms == ms else '-'):>7}"
                        f" {(f'{gap:+.2f}' if gap == gap else '-'):>7} {str(feas)[0]:>2} {viol:>2} |")
                rec[s] = {"mk": mk if feas else None, "ms": ms if ms == ms else None,
                          "feas": feas, "viol": viol, "gap": gap if gap == gap else None}
            print(row)
            records.append(rec)

        print("-" * len(hdr))
        for s in strategies:
            g, m = sub_stat[s]["gaps"], sub_stat[s]["ms"]
            line = f"  [{s}] 可行 {sub_stat[s]['feas']}/{len(files)}"
            if g:
                line += f"  gap%：均 {sum(g)/len(g):+.2f} 大 {max(g):+.2f} 小 {min(g):+.2f}"
            if m:
                line += f"  均耗时 {sum(m)/len(m):.1f} ms"
            print(line)
            grand[s]["gaps"] += g
            grand[s]["ms"] += m
            grand[s]["feas"] += sub_stat[s]["feas"]
        grand_n += len(files)

    print("=" * len(hdr))
    print(f"总体（{grand_n} 实例）")
    for s in strategies:
        g = grand[s]["gaps"]
        line = f"  [{s}] 可行 {grand[s]['feas']}/{grand_n}"
        if g:
            line += f"  gap%：均 {sum(g)/len(g):+.2f} 大 {max(g):+.2f} 小 {min(g):+.2f} (n={len(g)})"
        print(line)
    if args.export:
        print(f"  MoveList 导出 → {OUTPUT_DIR}/<strategy>/")
    print("=" * len(hdr))

    if args.out:
        summary = {s: {"feasible": grand[s]["feas"], "total": grand_n,
                       "gap_mean": (sum(grand[s]["gaps"]) / len(grand[s]["gaps"]))
                       if grand[s]["gaps"] else None} for s in strategies}
        with open(args.out, "w", encoding="utf-8") as fp:
            json.dump({"summary": summary, "records": records}, fp, ensure_ascii=False, indent=2)
        print(f"已写 {len(records)} 条记录 + 汇总 → {args.out}")


# --------------------------------------------------------------------------- #
# 模式二：单场景（src/input_data/NAME.json）
# --------------------------------------------------------------------------- #
def run_single(args, strategies, policy) -> None:
    name = args.input[:-5] if args.input.endswith(".json") else args.input
    ai, asch = load_alg_entries(input_data_path(name))
    ir = parse_task(ai, asch)

    for s in strategies:
        res, ms = run_strategy(s, ir, policy=policy, random_orders=args.random_orders,
                               tl=args.tl, seed=args.seed, verbose=False)
        print("=" * 68)
        if not _ok(res):
            print(f"{name}  [{s}] 无可行解")
            continue
        gap = getattr(res, "gap", 0.0)
        print(f"{name}  [{s}] status={getattr(res,'status','-')} makespan={res.makespan:.1f}"
              f"  gap={gap*100:.2f}%  solve={getattr(res,'runtime',0.0):.2f}s wall={ms/1000:.2f}s"
              f"  wafers={len(res.schedule)}")
        issues, ml = _check_all(ir, res, ai)
        if issues:
            print(f"  ✗ 自检 {len(issues)} 处违例：")
            for x in issues[:10]:
                print("    -", x)
        else:
            print("  ✓ 自检通过（schedule P/C/R/LL/Clean + MoveList 压力态）")
        if args.export:
            _export(ml, s, "input", name)
            print(f"  导出 MoveList → {OUTPUT_DIR/s/'input'/(name+'.json')}")
    print("=" * 68)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", nargs="+", default=["heuristic"],
                    help=f"调度策略，可多选：{STRATEGIES} 或 all（=heuristic random bc）")
    ap.add_argument("--subsets", nargs="*", default=SUBSETS, help="数据集子集（缺省=全部；all 同义）")
    ap.add_argument("--input", type=str, default=None, help="单场景模式：src/input_data 下的场景名")
    ap.add_argument("--limit", type=int, default=0, help="每子集只跑前 N 个（0=全部）")
    ap.add_argument("--random-orders", type=int, default=64, help="random 策略的随机 rollout 次数")
    ap.add_argument("--tl", type=float, default=300.0, help="milp 策略求解时限(秒)")
    ap.add_argument("--seed", type=int, default=0, help="random/bc 随机种子")
    ap.add_argument("--export", action="store_true", help="导出各策略 MoveList")
    ap.add_argument("--out", type=str, default=None, help="把逐实例+汇总写成 JSON（仅数据集模式）")
    args = ap.parse_args()

    strategies = STRATEGIES[:3] if args.strategy == ["all"] else args.strategy
    bad = [s for s in strategies if s not in STRATEGIES]
    if bad:
        ap.error(f"未知策略 {bad}，可选 {STRATEGIES} 或 all")

    policy = _load_policy() if "bc" in strategies else None
    if "bc" in strategies and policy is None:
        strategies = [s for s in strategies if s != "bc"]
        if not strategies:
            return

    if args.input:
        run_single(args, strategies, policy)
    else:
        run_dataset(args, strategies, policy)


if __name__ == "__main__":
    main()
