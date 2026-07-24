"""统一入口：一种调度策略 → 排程 → 自检 / 导出 MoveList / 对比 MILP 标签。

取代旧 run_.py / run_milp.py / eval_dataset.py 三脚本。策略（--strategy，可多选）：
  · heuristic  快速启发式定序（单 job 喂片 / 2+ job 配比搜 / 清洁排空 + backward 兜底）。start_schedule。
  · neural     离线训练的深层集合注意力网络；生产用 NumPy 贪心轨迹 + 有预算物理修复。
  · random     启发式基底上叠 N 次随机定序 rollout 取优。start_schedule(random_orders=N)。
  · search     面向 2-job 的限时结构化搜索（默认 7 秒）：发片交织 + 驻留违例定向修复。
  · bc         BC 策略【联合选腔 + 定序】。start_schedule_by_policy（需 results/models/bc_policy.pt）。
  · rl         RL 策略做顶层顺序限时搜索，底层由 timing 精确定时（需 bc_policy_rl.pt，硬限 <5 秒）。
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
  python scripts/run.py --strategy all --subsets train/2job --limit 3   # 全部非 MILP 策略冒烟
  python scripts/run.py --strategy bc --export --out eval.json  # 导出 MoveList + 汇总 JSON
  python scripts/run.py --strategy rl --wafer-count 25 --rl-search-seconds 4.0  # 5片训练模型外推
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

from src.parse import load_alg_entries, parse_task, resize_task_materials
from src.paths import input_data_path, MODELS_DIR, OUTPUT_DIR
from src.parse.generator import expand_topo_pms, PM_POOL_6
from src.schedule.api import start_schedule, start_schedule_by_policy
from src.schedule.milp import solve_milp
from src.schedule.neural import DEFAULT_MODEL_PATH, load_neural_policy, start_schedule_neural
from src.schedule.rl import start_schedule_by_rl
from src.export import check_solution, export_movelist
from src.validation import validate_move_list

BASE_TOPO = "s1-1c1p-preclean"
# 子集用「目录/名」限定：train/* 有 MILP 标签的配置网格（报 gap）；test/* 大规模外推（无标签，不计 gap）。
SUBSETS = ["train/1stage", "train/2stage", "train/3stage", "train/2job", "train/clean", "test/1stage"]
STRATEGIES = ["heuristic", "neural", "search", "random", "bc", "rl", "milp"]
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
                 search_seconds: float = 7.0, tl: float = 300.0,
                 rl_search_seconds: float = 4.0,
                 rl_rollouts: int = 256, rl_temperature: float = 0.7,
                 seed: int = 0, verbose: bool = False):
    """跑一种策略 → (SolveResult|None, wall_ms)。bc/rl 无 policy 时返回 (None, nan)。"""
    t0 = time.perf_counter()
    if name == "heuristic":
        res = start_schedule(ir, verbose=verbose)
    elif name == "neural":
        if policy is None:
            return None, float("nan")
        res = start_schedule_neural(ir, policy=policy)
    elif name == "search":
        res = start_schedule(ir, verbose=verbose, seed=seed,
                             search_seconds=search_seconds)
    elif name == "random":
        res = start_schedule(ir, verbose=verbose, seed=seed, random_orders=random_orders)
    elif name == "bc":
        if policy is None:
            return None, float("nan")
        res = start_schedule_by_policy(ir, policy, seed=seed)
    elif name == "rl":
        if policy is None:
            return None, float("nan")
        res = start_schedule_by_rl(
            ir, policy, seed=seed, search_seconds=rl_search_seconds,
            max_rollouts=rl_rollouts, temp=rl_temperature, verbose=verbose,
        )
    elif name == "milp":
        res = solve_milp(ir, time_limit=tl, verbose=verbose)
    else:
        raise ValueError(f"未知策略 {name}")
    return res, (time.perf_counter() - t0) * 1000.0


def _check_all(ir, res, init_data=None) -> tuple:
    """可行解统一双层校验：schedule 层(check_solution) + MoveList 层(validate_movelist)。
    每次排程都构建 MoveList 并校验（不管是否 --export），返回 (违例列表, MoveList)。"""
    issues = check_solution(ir, res)
    ml = export_movelist(ir, res, init_data)
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


def _load_policy(path: Path, strategy: str):
    """加载指定策略 checkpoint；失败时只跳过该神经网络策略。"""
    try:
        if strategy == "neural":
            return load_neural_policy(path)
        from src.schedule.policy import load_policy
        return load_policy(path)
    except Exception as e:  # noqa: BLE001
        print(f"[warn] {strategy} 模型加载失败（{path}: {e}），该策略将跳过。")
        return None


# --------------------------------------------------------------------------- #
# 模式一：数据集批量对比
# --------------------------------------------------------------------------- #
def run_dataset(args, strategies, policies) -> None:
    """批量评测所选策略；可按总片数构造无标签的规模外推实例。"""
    ai, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai = expand_topo_pms(ai, PM_POOL_6)
    if args.wafer_count > 0:
        # 离线规模外推没有真实 FOUP 更换事件。把 LoadPort 视作足够大的输入仓，
        # 避免超过原 25 槽后 parse_task 取模复用槽位，造成两个物料占同一初始槽。
        for station in (ai.get("Stations") or {}).values():
            if str(station.get("Type") or "").lower() != "loadport":
                continue
            capacity = max(
                int(station.get("Capacity") or 1),
                int(args.wafer_count),
            )
            station["Capacity"] = capacity
            station["Slots"] = list(range(1, capacity + 1))
            station["TimeToAvailableOfSlot"] = {
                str(slot): 0 for slot in range(1, capacity + 1)
            }

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
            source_basename = os.path.basename(f)[:-5]
            basename = (f"{source_basename}_w{args.wafer_count}"
                        if args.wafer_count > 0 else source_basename)
            name = f"{sub}/{basename}"
            d = json.load(open(f, encoding="utf-8"))
            has_label = _valid_label(d["result"]) and args.wafer_count <= 0
            m_mk = float(d["result"]["makespan"]) if has_label else float("nan")

            try:
                update_params = (resize_task_materials(d["update_params"], args.wafer_count)
                                 if args.wafer_count > 0 else d["update_params"])
                ir = parse_task(ai, update_params)
            except Exception as e:  # noqa: BLE001
                print(f"{name:<26} parse 失败: {e}")
                continue

            row = f"{name:<26} {(f'{m_mk:.1f}' if has_label else 'n/a'):>9} |"
            rec = {"case": name, "milp": m_mk if has_label else None, "has_label": has_label}
            for s in strategies:
                try:
                    res, ms = run_strategy(s, ir, policy=policies.get(s),
                                           random_orders=args.random_orders,
                                           search_seconds=args.search_seconds,
                                           rl_search_seconds=args.rl_search_seconds,
                                           rl_rollouts=args.rl_rollouts,
                                           rl_temperature=args.rl_temperature,
                                           tl=args.tl, seed=args.seed)
                except Exception as e:  # noqa: BLE001
                    print(f"  [warn] {name} {s} 失败: {e}")
                    res, ms = None, float("nan")
                feas = _ok(res)
                mk = res.makespan if feas else float("nan")
                # 规模外推会重建物料与 LoadPort 槽位；原始 AlgInit 中的 Materials 已不再
                # 对应新任务，校验器应从 Problem 的首工序恢复物料，而不是加载旧快照。
                validation_source = None if args.wafer_count > 0 else ai
                issues, ml = (
                    _check_all(ir, res, validation_source)
                    if feas
                    else ([], None)
                )
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
                if s == "neural" and feas:
                    rec[s]["diagnostics"] = dict(
                        getattr(res, "neural_diagnostics", {}) or {}
                    )
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
def run_single(args, strategies, policies) -> None:
    """运行一个录制场景，并可在解析前调整产品晶圆总数。"""
    name = args.input[:-5] if args.input.endswith(".json") else args.input
    ai, asch = load_alg_entries(input_data_path(name))
    if args.wafer_count > 0:
        asch = resize_task_materials(asch, args.wafer_count)
    ir = parse_task(ai, asch)

    for s in strategies:
        res, ms = run_strategy(s, ir, policy=policies.get(s),
                               random_orders=args.random_orders,
                               search_seconds=args.search_seconds,
                               rl_search_seconds=args.rl_search_seconds,
                               rl_rollouts=args.rl_rollouts,
                               rl_temperature=args.rl_temperature,
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
                    help=f"调度策略，可多选：{STRATEGIES} 或 all（全部非 MILP 策略）")
    ap.add_argument("--subsets", nargs="*", default=SUBSETS, help="数据集子集（缺省=全部；all 同义）")
    ap.add_argument("--input", type=str, default=None, help="单场景模式：src/input_data 下的场景名")
    ap.add_argument("--limit", type=int, default=0, help="每子集只跑前 N 个（0=全部）")
    ap.add_argument("--wafer-count", type=int, default=0,
                    help="解析前把产品晶圆总数缩放到 N；0=保持原任务。用于 5→25 规模外推验证")
    ap.add_argument("--random-orders", type=int, default=64, help="random 策略的随机 rollout 次数")
    ap.add_argument("--search-seconds", type=float, default=7.0,
                    help="search 策略在每个 2-job 实例上的墙钟预算(秒)")
    ap.add_argument("--bc-model", type=Path, default=MODELS_DIR / "bc_policy.pt",
                    help="BC checkpoint 路径")
    ap.add_argument("--neural-model", type=Path, default=DEFAULT_MODEL_PATH,
                    help="深层集合注意力网络的安全 NumPy checkpoint 路径")
    ap.add_argument("--rl-model", type=Path, default=MODELS_DIR / "bc_policy_rl.pt",
                    help="RL checkpoint 路径")
    ap.add_argument("--rl-search-seconds", type=float, default=4.0,
                    help="RL 顶层搜索墙钟预算(秒)，内部硬限制为 4.5，保证低于 5 秒")
    ap.add_argument("--rl-rollouts", type=int, default=256,
                    help="RL 搜索最多采样候选序数量；时间预算会更早停止")
    ap.add_argument("--rl-temperature", type=float, default=0.7,
                    help="RL rollout 的 softmax/Gumbel 采样温度")
    ap.add_argument("--tl", type=float, default=300.0, help="milp 策略求解时限(秒)")
    ap.add_argument("--seed", type=int, default=0, help="search/random/bc/rl 随机种子")
    ap.add_argument("--export", action="store_true", help="导出各策略 MoveList")
    ap.add_argument("--out", type=str, default=None, help="把逐实例+汇总写成 JSON（仅数据集模式）")
    args = ap.parse_args()

    strategies = ["heuristic", "neural", "search", "random", "bc", "rl"] if args.strategy == ["all"] else args.strategy
    bad = [s for s in strategies if s not in STRATEGIES]
    if bad:
        ap.error(f"未知策略 {bad}，可选 {STRATEGIES} 或 all")
    if args.wafer_count < 0:
        ap.error("--wafer-count 不能为负数")
    if args.rl_search_seconds < 0:
        ap.error("--rl-search-seconds 不能为负数")
    if args.rl_rollouts < 0:
        ap.error("--rl-rollouts 不能为负数")
    if args.rl_temperature <= 0:
        ap.error("--rl-temperature 必须为正数")

    model_paths = {
        "neural": args.neural_model,
        "bc": args.bc_model,
        "rl": args.rl_model,
    }
    policies = {
        strategy: _load_policy(model_paths[strategy], strategy)
        for strategy in ("neural", "bc", "rl")
        if strategy in strategies
    }
    strategies = [
        strategy for strategy in strategies
        if strategy not in model_paths or policies.get(strategy) is not None
    ]
    if not strategies:
        return

    if args.input:
        run_single(args, strategies, policies)
    else:
        run_dataset(args, strategies, policies)


if __name__ == "__main__":
    main()
