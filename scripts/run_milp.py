"""跑 MILP oracle（CT/solutions/milp.py）并自检 / 导出 movelist。

用法：
  # 合成 case
  python scripts/run_milp.py --case 1 --n1 2 --n2 2
  # 真实配置文件（CT/config/input_data/*.json）
  python scripts/run_milp.py --input s1-1c1p-preclean --export
"""

import argparse
import io
import json
import sys
import time
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from CT.solutions.cases import case1, case2, case3
from CT.solutions.preprocess import preprocess
from CT.solutions.milp import solve_milp, check_solution, export_movelist
from CT.config.input_loader import load_alg_entries
from CT.config.paths import input_data_path, output_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=str, default=None,
                    help="CT/config/input_data 下的场景名（与 --case 二选一）")
    ap.add_argument("--case", type=int, choices=[1, 2, 3], default=1)
    ap.add_argument("--n1", type=int, default=2)
    ap.add_argument("--n2", type=int, default=2)
    ap.add_argument("--tl", type=float, default=300.0, help="求解时限(秒)")
    ap.add_argument("--show", type=int, default=4, help="打印前 N 片排程")
    ap.add_argument("--export", action="store_true", help="导出 MoveList 到 results/output")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if args.input:
        name = args.input[:-5] if args.input.endswith(".json") else args.input
        ai, asch = load_alg_entries(input_data_path(name))
        ir, _ = preprocess(ai, asch)
    else:
        name = f"milp_case{args.case}"
        fn = {1: case1, 2: case2, 3: case3}[args.case]
        ai, asch = fn(n_wafer=[args.n1, args.n2])
        ir, _ = preprocess(ai, asch)

    # 核心仓库不含贪心上界（torch/Petri 栈），统一用 loose-M baseline。
    ub = None

    t0 = time.time()
    res = solve_milp(ir, time_limit=args.tl, verbose=args.verbose, ub=ub)
    wall = time.time() - t0

    print("=" * 68)
    print(f"{name}  status={res.status} "
          f"makespan={res.makespan:.1f}  gap={res.gap*100:.2f}%  "
          f"solve={res.runtime:.2f}s wall={wall:.2f}s  wafers={len(res.schedule)}")

    issues = check_solution(ir, res)
    if issues:
        print(f"  ✗ 自检发现 {len(issues)} 处违例：")
        for s in issues[:10]:
            print("    -", s)
    else:
        print("  ✓ 自检通过（P/C/R 约束均满足）")

    print(f"  发片顺序(时刻,route,wid): {res.releases[:args.show]}"
          f"{' ...' if len(res.releases) > args.show else ''}")
    for wid in list(res.schedule)[:args.show]:
        print(f"  w{wid}: " + " | ".join(
            f"{stype[:4]}@{c}[a={av:.1f},r={rv:.1f}]"
            for stype, c, av, rv in res.schedule[wid]))

    if args.export:
        ml = export_movelist(ir, res)
        out = output_path(f"{name}.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump({"MoveList": ml}, f, ensure_ascii=False)
        print(f"  导出 {len(ml)} 条 move → {out}")
    print("=" * 68)


if __name__ == "__main__":
    main()
