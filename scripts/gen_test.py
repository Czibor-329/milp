"""测试集生成：从 YAML 案例清单显式罗列每个测试案例 + MILP 最优标注。

测试集 = **显式案例清单**：YAML 里逐条列出「逐工序腔室数 × 逐工序加工时长」，
直接定位模型在结构维度上的强弱（含多 stage 非对称 proc）。每个案例（互斥腔，逐工序
从 PM_POOL_6 顺序切片，要求 sum(chambers)≤6，且 len(proc_times)==len(chambers)）：
  - `chambers: [1, 3]`：逐工序腔室数；
  - `proc_times: [120, 45]`：逐工序加工时长（各工序可不同）。
n_wafer / residency / lp 由 YAML defaults 提供，每案例可覆盖。
落扁平 inst_XXXX.json + manifest.json（split 由 --root 决定），供 extract_labels / run.py 读取。

本仓库（src 核心）用法：swap 在 MILP 侧关闭（enable_swap=False），使 MILP 解落在 timing 解码
层可表示空间内 —— 这套数据既做 BC 训练集又做评测集（测试集即训练集）。

用法:
  python scripts/gen_test.py --cases dataset/cases/3stage.yaml --out 3stage
  # 晶圆数多、MILP 跑不完时，只生成测试案例（不求解、无 movelist）：
  python scripts/gen_test.py --cases dataset/cases/3stage.yaml --out 3stage --no-milp
  # 含清洁的有标签网格（写到 dataset/train/clean，eval 报 gap）：
  python scripts/gen_test.py --cases dataset/cases/clean.yaml --out clean --root train --clean
"""

import argparse, io, json, random, sys, time
from pathlib import Path

import yaml

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse.generator import (
    JobSpec, build_update_params, build_concurrent_update, job_process_recipes,
    expand_topo_pms, PM_POOL_6, LP_POOL, CLEAN_TYPES,
)
from src.parse import parse_task, load_alg_entries
from src.schedule.milp import solve_milp
from src.export import check_solution, export_movelist
from src.paths import input_data_path, TEST_ROOT, TRAIN_DIR

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
        # 多 job 案例：jobs=[{chambers, proc_times, [n_wafer]}…]，加工腔跨 job 不相交 → sum 全部 ≤6。
        sub = case["jobs"] if "jobs" in case else [case]
        if "jobs" in case and len(case["jobs"]) < 2:
            raise ValueError(f"case {idx}: jobs 至少 2 个")
        total_ch = 0
        for jdx, jc in enumerate(sub):
            chambers, proc_times = jc.get("chambers"), jc.get("proc_times")
            if not chambers or not proc_times:
                raise ValueError(f"case {idx}.job{jdx}: 必须同时含 chambers 与 proc_times")
            if len(chambers) != len(proc_times):
                raise ValueError(f"case {idx}.job{jdx}: len(chambers)={len(chambers)} != "
                                 f"len(proc_times)={len(proc_times)}")
            total_ch += sum(chambers)
        if total_ch > len(PM_POOL_6):
            raise ValueError(f"case {idx}: 各 job 加工腔总数 {total_ch} > {len(PM_POOL_6)}（须不相交）")
    return defaults, cases


def _apply_clean_knobs(job, case):
    """把 case 里的清洁参数覆盖到 JobSpec（None=保留 JobSpec 随机/默认值）：
       trigger=wac 触发片数 · clean_time=清洗时长 · n_dummy=每 PM dummy 片数 · empty_time=dummy 片间 wac 时长。"""
    for src_key, attr in (("trigger", "trigger"), ("clean_time", "clean_time"),
                          ("n_dummy", "n_dummy"), ("empty_time", "empty_time")):
        v = case.get(src_key)
        if v is not None:
            setattr(job, attr, int(v))


def build_instance(chambers, proc_times, n_wafer, residency, lp, seed,
                   clean=False, clean_type=None, case=None):
    """逐工序腔室数 = chambers，互斥切片 PM_POOL_6，proc_times 逐工序取值。确定性构造。
    clean=True 时挂清洁（clean_type 指定则固定该类型，否则 JobSpec 随机抽）。
    case 提供则用其清洁参数（trigger/clean_time/n_dummy/empty_time）覆盖 JobSpec 随机默认。"""
    rng = random.Random(seed)
    stages, off = [], 0
    for c in chambers:
        stages.append(list(PM_POOL_6[off:off + c])); off += c
    job = JobSpec(0, rng, pm_pool=PM_POOL_6, stage_range=(len(chambers), len(chambers)),
                  clean=clean, residency=residency)
    job.stages = stages
    job.proc_times = [int(p) for p in proc_times]
    job.n_wafer = int(n_wafer)
    if clean and clean_type:
        job.clean_type = clean_type
    if case:
        _apply_clean_knobs(job, case)
    up, _ = build_update_params(job, 1, 1, lp, 0, 0.0,
                                process_recipes=job_process_recipes(job, 1))
    return job, up


def build_multi_instance(jobs_cfg, n_wafer_default, residency, seed,
                         clean=False, clean_type=None):
    """多 job（不同 recipe、加工腔不相交）：PM_POOL_6 跨 job 连续切片不重用，仅共享 VTR + loadlock。
    复用 build_concurrent_update（合并 routes/pjobs/cjobs/recipes、各 job 轮分 LP、同优并发）。确定性。
    清洁按 job：case.jobs[k].clean / clean_type 优先，否则用全局 clean/clean_type。"""
    rng = random.Random(seed)
    jobs, off = [], 0
    for k, jc in enumerate(jobs_cfg):
        chambers = list(jc["chambers"])
        stages = []
        for c in chambers:
            stages.append(list(PM_POOL_6[off:off + c])); off += c   # 跨 job 累进 off ⇒ 加工腔不相交
        jclean = bool(jc.get("clean", clean))
        job = JobSpec(k, rng, pm_pool=PM_POOL_6, stage_range=(len(chambers), len(chambers)),
                      clean=jclean, residency=int(jc.get("residency", residency)))
        job.stages = stages
        job.proc_times = [int(p) for p in jc["proc_times"]]
        job.n_wafer = int(jc.get("n_wafer", n_wafer_default))
        jct = jc.get("clean_type", clean_type)
        if jclean and jct:
            job.clean_type = jct
        _apply_clean_knobs(job, jc)
        jobs.append(job)
    up = build_concurrent_update(jobs, rng, lps=LP_POOL)
    return jobs, up


def _feasible(r) -> bool:
    return bool(getattr(r, "schedule", None)) and r.makespan == r.makespan


def solve_label(ir, tl, warm, verbose, probe):
    fix = solve_milp(ir, time_limit=tl, verbose=verbose)
    return fix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=str, required=True, help="YAML 案例清单路径")
    ap.add_argument("--out", type=str, default=None, help="保存子集名(相对 --root 指定的根)")
    ap.add_argument("--root", choices=["test", "train"], default="test",
                    help="输出根：test=dataset/test（外推/无标签默认），train=dataset/train（有标签网格，eval 报 gap）")
    ap.add_argument("--tl", type=float, default=100.0, help="单实例 MILP 时限(秒)")
    ap.add_argument("--probe", type=float, default=12.0,
                    help="free 探针时限(秒)：判 loadlock 饱和 vs 空闲（饱和例信 fix、瞬解）")
    ap.add_argument("--verbose", action="store_true", help="流式打印 Gurobi 求解日志（看慢例的实时进度）")
    ap.add_argument("--no-milp", action="store_true",
                    help="只生成测试案例（instance + spec + update_params），不跑 MILP 求解/标注/movelist。"
                         "晶圆数变多时 MILP 跑不完，用此选项产出纯测试集。")
    ap.add_argument("--clean", action="store_true",
                    help="启用清洁生成（默认关）；每 case 随机清洁类型，或用 --clean-type / case.clean_type 指定")
    ap.add_argument("--clean-type", type=str, default=None, choices=CLEAN_TYPES,
                    help="强制所有 case 用同一清洁类型（"
                         "preclean/postclean/dummyclean/dummywacclean/wacclean），便于逐类型冒烟")
    args = ap.parse_args()

    defaults, cases = load_cases(args.cases)
    split = args.root
    out = Path((TRAIN_DIR if args.root == "train" else TEST_ROOT) / args.out)
    out.mkdir(parents=True, exist_ok=True)

    alg_init, _ = load_alg_entries(input_data_path(BASE_TOPO))
    alg_init = expand_topo_pms(alg_init, PM_POOL_6)   # 物理拓扑恒含 PM1~6；route 只用前若干个
    total = len(cases)

    manifest = []
    n_nonopt = 0
    t_start = time.time()
    for i, case in enumerate(cases):
        residency = int(case.get("residency", defaults["residency"]))
        if "jobs" in case:                            # 多 job：不同 recipe、加工腔不相交，仅共享 VTR+loadlock
            jobs, up = build_multi_instance(case["jobs"], defaults["n_wafer"], residency, seed=i,
                                            clean=args.clean, clean_type=args.clean_type)
            spec = {"n_jobs": len(jobs), "residency": residency,
                    "jobs": [{"n_chamber": list(jc["chambers"]),
                              "proc_times": [int(p) for p in jc["proc_times"]],
                              "n_wafer": jb.n_wafer, "stages": jb.stages,
                              "clean_type": jb.clean_type}
                             for jc, jb in zip(case["jobs"], jobs)]}
            man_base = {"id": i, "split": split, "file": f"inst_{i:04d}.json", "n_jobs": len(jobs),
                        "configs": [list(jc["chambers"]) for jc in case["jobs"]]}
            head = (f"[{i+1:2d}/{total}] jobs×{len(jobs)} "
                    f"{' | '.join('·'.join(map(str, jc['chambers'])) for jc in case['jobs']):16s} 求解中…")
        else:                                         # 单 job（原结构网格）
            chambers = list(case["chambers"]); proc_times = [int(p) for p in case["proc_times"]]
            n_wafer = int(case.get("n_wafer", defaults["n_wafer"]))
            lp = case.get("lp", defaults["lp"])
            c_clean = bool(case.get("clean", args.clean)) or bool(case.get("clean_type"))
            c_type = case.get("clean_type", args.clean_type)
            job, up = build_instance(chambers, proc_times, n_wafer, residency, lp, seed=i,
                                     clean=c_clean, clean_type=c_type, case=case)
            spec = {"lp": lp, "n_wafer": n_wafer, "n_stage": len(chambers),
                    "n_chamber": chambers, "stages": job.stages, "proc_times": job.proc_times,
                    "residency": residency, "clean_type": job.clean_type,
                    "clean_time": job.clean_time, "trigger": job.trigger,
                    "n_dummy": job.n_dummy, "empty_time": job.empty_time}
            man_base = {"id": i, "split": split, "file": f"inst_{i:04d}.json", "n_wafer": n_wafer,
                        "n_stage": len(chambers),
                        "n_chamber": chambers[0] if len(chambers) == 1 else chambers,
                        "config": chambers, "proc": proc_times[0], "proc_times": proc_times}
            head = (f"[{i+1:2d}/{total}] cfg={'·'.join(map(str,chambers)):7s} "
                    f"proc={'·'.join(map(str,proc_times)):11s} nw={n_wafer:2d} 求解中…")
        ir = parse_task(alg_init, up)                 # parse_task 内部深拷贝 up、只读 topo，可复用 alg_init

        if args.no_milp:                              # 纯测试集：不跑 MILP（晶圆多时跑不完），instance 无标注/movelist
            rec = {
                "id": i, "split": split,
                "spec": spec,
                "update_params": up,
                "result": {"status": None, "makespan": float("nan"), "gap": float("nan"),
                           "optimal": False, "self_check_ok": None, "issues": [],
                           "replay_ok": None, "wall": 0.0, "releases": [], "schedule": {}},
                "MoveList": [],
            }
            fn = out / f"inst_{i:04d}.json"
            with open(fn, "w", encoding="utf-8") as f:
                json.dump(rec, f, ensure_ascii=False)
            man_base.update({"makespan": float("nan"), "gap": float("nan"),
                             "optimal": False, "replay_ok": None})
            manifest.append(man_base)
            print(head.replace("求解中…", "已生成（--no-milp 跳过求解）"), flush=True)
            continue

        # 先打 case 头（求解可能耗到 --tl 秒）：立刻 flush ⇒ 控制台实时显示「当前在解哪例」
        print(head, end="\n" if args.verbose else "", flush=True)
        warm = None
        t0 = time.time()
        res = solve_label(ir, args.tl, warm, args.verbose, args.probe)
        wall = time.time() - t0
        # 放开 PM 选腔后多 PM 例可能时限内未证明最优；只要有可行 incumbent（schedule 非空）即作标签
        # （incumbent 已 ≤ timing UB，比 round-robin 旧标更紧），optimal 仅作证明状态标记。
        feasible = (res.makespan == res.makespan) and bool(res.schedule)
        optimal = feasible and res.gap <= 1e-6
        issues = check_solution(ir, res) if feasible else ["no feasible solution"]
        ml = export_movelist(ir, res) if feasible else []
        replay_ok = None                              # 核心仓库无执行器/Petri 回放栈，不做 replay 校验
        n_nonopt += int(not optimal)

        rec = {
            "id": i, "split": split,
            "spec": spec,
            "update_params": up,
            "result": {"status": res.status, "makespan": res.makespan, "gap": res.gap,
                       "optimal": optimal, "self_check_ok": not issues, "issues": issues[:5],
                       "replay_ok": replay_ok, "wall": round(wall, 2),
                       "releases": res.releases if feasible else [],
                       "schedule": {str(k): v for k, v in res.schedule.items()} if feasible else {}},
            "MoveList": ml,
        }
        fn = out / f"inst_{i:04d}.json"
        with open(fn, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False)
        # 单 job 的 n_chamber/proc 便捷字段在 man_base 里（eval_grid 按 (chamber,proc) 铺热力图）；
        # 多 job 用 n_jobs/configs。此处统一补求解结果字段。
        man_base.update({"makespan": res.makespan, "gap": res.gap,
                         "optimal": optimal, "replay_ok": replay_ok})
        manifest.append(man_base)
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
