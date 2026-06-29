"""测试集生成：从 YAML 案例清单显式罗列每个测试案例 + MILP 最优标注。

测试集 = **显式案例清单**：YAML 里逐条列出「逐工序腔室数 × 逐工序加工时长」，
直接定位模型在结构维度上的强弱（含多 stage 非对称 proc）。每个案例（互斥腔，逐工序
从 PM_POOL_6 顺序切片，要求 sum(chambers)≤6，且 len(proc_times)==len(chambers)）：
  - `chambers: [1, 3]`：逐工序腔室数；
  - `proc_times: [120, 45]`：逐工序加工时长（各工序可不同）。
n_wafer / residency / lp 由 YAML defaults 提供，每案例可覆盖。
落扁平 inst_XXXX.json + manifest.json（全 split=test），供 extract_labels / eval_dataset 读取。

本仓库（src 核心）用法：swap 在 MILP 侧关闭（enable_swap=False），使 MILP 解落在 timing 解码
层可表示空间内 —— 这套数据既做 BC 训练集又做评测集（测试集即训练集）。

用法:
  venv/Scripts/python.exe scripts/gen_test.py --cases dataset/cases/3stage.yaml --out 3stage
"""

import argparse, io, json, random, sys, time
from pathlib import Path

import yaml

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.marathon_gen import (
    JobSpec, build_update_params, job_process_recipes, expand_topo_pms, PM_POOL_6,
)
from src.parse import parse_task, load_alg_entries
from src.milp import solve_milp, check_solution, export_movelist
from src.paths import input_data_path, TEST_ROOT

BASE_TOPO = "s1-1c1p-preclean"

_DEFAULTS = {"n_wafer": 12, "residency": 60, "lp": "LP1"}


def load_cases(path):
    """读 YAML 案例清单 → (defaults, cases)；逐案例校验长度匹配 + sum(chambers)≤6。"""
    with open(path, encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    defaults = {**_DEFAULTS, **(doc.get("defaults") or {})}
    cases = doc.get("cases") or []
    if not cases:
        raise ValueError(f"案例清单为空: {path}")
    for idx, case in enumerate(cases):
        chambers, proc_times = case.get("chambers"), case.get("proc_times")
        if not chambers or not proc_times:
            raise ValueError(f"case {idx}: 必须同时含 chambers 与 proc_times")
        if len(chambers) != len(proc_times):
            raise ValueError(f"case {idx}: len(chambers)={len(chambers)} != "
                             f"len(proc_times)={len(proc_times)}")
        if sum(chambers) > len(PM_POOL_6):
            raise ValueError(f"case {idx}: sum(chambers)={sum(chambers)} > {len(PM_POOL_6)}")
    return defaults, cases


def build_instance(chambers, proc_times, n_wafer, residency, lp, seed):
    """逐工序腔室数 = chambers，互斥切片 PM_POOL_6，proc_times 逐工序取值。确定性构造。"""
    rng = random.Random(seed)
    stages, off = [], 0
    for c in chambers:
        stages.append(list(PM_POOL_6[off:off + c])); off += c
    job = JobSpec(0, rng, pm_pool=PM_POOL_6, stage_range=(len(chambers), len(chambers)),
                  clean=False, residency=residency)
    job.stages = stages
    job.proc_times = [int(p) for p in proc_times]
    job.n_wafer = int(n_wafer)
    up, _ = build_update_params(job, 1, 1, lp, 0, 0.0,
                                process_recipes=job_process_recipes(job, 1))
    return job, up


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=str, required=True, help="YAML 案例清单路径")
    ap.add_argument("--out", type=str, default=None, help="保存路径(相对 TEST_ROOT)")
    ap.add_argument("--tl", type=float, default=100.0, help="单实例 MILP 时限(秒)")
    ap.add_argument("--verbose", action="store_true", help="流式打印 Gurobi 求解日志（看慢例的实时进度）")
    args = ap.parse_args()

    defaults, cases = load_cases(args.cases)
    out = Path(TEST_ROOT / args.out)
    out.mkdir(parents=True, exist_ok=True)

    alg_init, _ = load_alg_entries(input_data_path(BASE_TOPO))
    alg_init = expand_topo_pms(alg_init, PM_POOL_6)   # 物理拓扑恒含 PM1~6；route 只用前若干个
    total = len(cases)

    manifest = []
    n_nonopt = 0
    t_start = time.time()
    for i, case in enumerate(cases):
        chambers = list(case["chambers"])
        proc_times = [int(p) for p in case["proc_times"]]
        n_wafer = int(case.get("n_wafer", defaults["n_wafer"]))
        residency = int(case.get("residency", defaults["residency"]))
        lp = case.get("lp", defaults["lp"])
        job, up = build_instance(chambers, proc_times, n_wafer, residency, lp, seed=i)
        ir = parse_task(alg_init, up)                 # parse_task 内部深拷贝 up、只读 topo，可复用 alg_init
        # 先打 case 头（求解可能耗到 --tl 秒）：立刻 flush ⇒ 控制台实时显示「当前在解哪例」
        print(f"[{i+1:2d}/{total}] cfg={'·'.join(map(str,chambers)):7s} "
              f"proc={'·'.join(map(str,proc_times)):11s} nw={n_wafer:2d} 求解中…",
              end="\n" if args.verbose else "", flush=True)
        t0 = time.time()
        res = solve_milp(ir, time_limit=args.tl, ub=None, enable_swap=False,   # 无 swap：解落在 timing 可表示空间
                         verbose=args.verbose)
        wall = time.time() - t0
        optimal = (res.makespan == res.makespan) and res.gap <= 1e-6
        issues = check_solution(ir, res) if optimal else ["not optimal"]
        ml = export_movelist(ir, res) if optimal else []
        replay_ok = None                              # 核心仓库无执行器/Petri 回放栈，不做 replay 校验
        n_nonopt += int(not optimal)

        rec = {
            "id": i, "split": "test",
            "spec": {"lp": lp, "n_wafer": n_wafer, "n_stage": len(chambers),
                     "n_chamber": chambers, "stages": job.stages, "proc_times": job.proc_times,
                     "residency": residency},
            "update_params": up,
            "result": {"status": res.status, "makespan": res.makespan, "gap": res.gap,
                       "optimal": optimal, "self_check_ok": not issues, "issues": issues[:5],
                       "replay_ok": replay_ok, "wall": round(wall, 2),
                       "releases": res.releases if optimal else [],
                       "schedule": {str(k): v for k, v in res.schedule.items()} if optimal else {}},
            "MoveList": ml,
        }
        fn = out / f"inst_{i:04d}.json"
        with open(fn, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False)
        # n_chamber: 单工序存 int（eval_grid 按 (chamber,proc) 铺热力图）；多工序存 list
        # proc: 单工序便捷标量(eval_grid 沿用)；proc_times: 逐工序列表(下游真相源)
        manifest.append({"id": i, "split": "test", "file": fn.name, "n_wafer": n_wafer,
                         "n_stage": len(chambers),
                         "n_chamber": chambers[0] if len(chambers) == 1 else chambers,
                         "config": chambers, "proc": proc_times[0], "proc_times": proc_times,
                         "makespan": res.makespan, "gap": res.gap,
                         "optimal": optimal, "replay_ok": replay_ok})
        flag = "✓" if optimal else ("⚠非最优" if res.status != 2 else "⚠有 gap")
        # verbose 下 case 头已换行（Gurobi 日志占据其后），故再补完整一行；否则把结果接到「求解中…」同一行
        tail = f"MILP={res.makespan:8.1f} gap={res.gap*100:4.1f}% {flag} {wall:.1f}s"
        if args.verbose:
            print(f"[{i+1:2d}/{total}] → {tail}", flush=True)
        else:
            print(f"  {tail}", flush=True)

    with open(out / "manifest.json", "w", encoding="utf-8") as f:
        json.dump({"base_topo": BASE_TOPO, "kind": "cases", "cases_file": str(args.cases),
                   "defaults": defaults, "cases": cases,
                   "n": len(cases), "n_nonopt": n_nonopt,
                   "instances": manifest}, f, ensure_ascii=False, indent=2)
    print("=" * 60)
    print(f"完成 {len(cases)} 例（非最优 {n_nonopt}）  "
          f"用时 {time.time()-t_start:.1f}s → {out}")


if __name__ == "__main__":
    main()
