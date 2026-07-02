"""2 个相同 job 共享同一批加工腔的清洁验证 + movelist 导出。

场景（默认，可用参数覆盖）：2 个相同 job（P1=10 片、P2=15 片），1 道工序在 PM1~PM4
round-robin 加工，proc=120s；5 类清洁时长均 20s。逐类跑 MILP → check_solution →
打印每 PM「占用 + 清洁」时间线 → 导出 movelist 到 results/output/2job_<clean>.json。

现有 build_multi_instance 只做「加工腔不相交」的多 job；本脚本手拼 update_params 让 2 个
pjob 共用同一 route（同一批 PM），专门验证 pre/post 清洁的 **每 job 边界** 语义
（pre 落每 job 首片前、post 落每 job 末片后；wac 按腔累计触发）。

用法：
  python scripts/test_2job_clean.py                       # 5 类全跑 + 导出 movelist
  python scripts/test_2job_clean.py --clean-type preclean # 只跑一类
  python scripts/test_2job_clean.py --n1 10 --n2 15 --proc 120 --clean-time 20 --tl 60
"""

import argparse
import copy
import io
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.marathon_gen import (
    JobSpec, build_update_params, job_process_recipes, expand_topo_pms,
    PM_POOL_6, CLEAN_TYPES,
)
from src.parse import parse_task, load_alg_entries
from src.milp import solve_milp
from src.model import Durations
from src.export import check_solution, export_movelist
from src.milp_clean import _clean_specs, _is_dummy_wafer
from src.paths import input_data_path, output_path

BASE_TOPO = "s1-1c1p-preclean"
PMS = ["PM1", "PM2", "PM3", "PM4"]


def build_two_jobs(clean_type, n1, n2, proc, clean_time):
    """手拼 2 个共用同一 route(PM1~PM4) 的 pjob：P1=n1 片、P2=n2 片。返回 update_params。
    P2 优先级低于 P1（数值大=靠后），同 route ⇒ FIFO 按 wid 序 = P1 全部先于 P2。"""
    rng = random.Random(0)
    job = JobSpec(0, rng, pm_pool=PM_POOL_6, stage_range=(1, 1), clean=True)
    job.stages = [list(PMS)]
    job.proc_times = [int(proc)]
    job.n_wafer = int(n1)
    job.clean_time = int(clean_time)
    job.empty_time = int(clean_time)
    job.clean_type = clean_type
    up, nid = build_update_params(job, 1, 1, "LP1", 0, 0.0,
                                  process_recipes=job_process_recipes(job, 1))
    route = up["Routes"]["R_1"]                       # P2 复用同一 route ⇒ 同 PM 池 + 同清洁挂载
    ids2 = []
    for slot in range(1, int(n2) + 1):
        up["Materials"].append({
            "Name": str(nid), "ID": nid, "TaskID": "job1", "LotID": "job1", "FoupID": "F1b",
            "Priority": 2, "StepID": 0, "CurrentModuleName": "LP1", "SlotID": slot,
            "NeedSchedule": True, "PJobName": "1.P2-1", "SrcPortName": "LP1",
            "Route": copy.deepcopy(route),
        })
        ids2.append(nid); nid += 1
    up["ProcessJobs"].append({
        "JobName": "1.P2-1", "TaskID": "job1", "Priority": 2, "State": 0,
        "OriginRoute": copy.deepcopy(route), "MatList": ids2,
    })
    up["ControlJobs"][0]["PJobNameList"].append("1.P2-1")
    up["ControlJobs"][0]["MaterialCount"] = int(n1) + int(n2)
    return up


def _pj_short(w):
    return "D" if _is_dummy_wafer(w) else ("P1" if w.pjob_name == "1.P1-1" else "P2")


def _occ_window(ir, res, wid, j):
    tm = Durations(ir)
    s = ir._wmap[wid].stages[j]
    _, c, av, rv = res.schedule[wid][j]
    st = av - (tm.place_t(s.in_robot, c) + tm.place_pre(s.in_robot, c) if s.in_robot else 0.0)
    en = rv + (tm.pick_t(s.out_robot, c) + tm.pick_post(s.out_robot, c) if s.out_robot else 0.0)
    return st, en


def _print_timeline(ir, res, cleans):
    """每 PM 时间线：晶圆占用 + 清洁事件按开始时刻排序打印（PM1 详列，各 PM 事件数汇总）。"""
    tl = defaultdict(list)
    for w in ir.wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type == "process" and s.chamber in PMS:
                st, en = _occ_window(ir, res, w.wid, j)
                tl[s.chamber].append((st, f"{_pj_short(w)}#{w.wid}"))
    for e in cleans:
        if e.kind == "pre":
            wid, j = e.before; st, _ = _occ_window(ir, res, wid, j); a = st - e.dur
        else:
            wid, j = e.after; _, en = _occ_window(ir, res, wid, j); a = en
        tl[e.chamber].append((a, f"[CLN-{e.kind}:{e.task or e.recipe}]"))
    seq = sorted(tl["PM1"], key=lambda x: x[0])
    print("  PM1 时间线:", " ".join(lab for _, lab in seq))
    per_pm = defaultdict(int)
    for e in cleans:
        per_pm[e.chamber] += 1
    print("  每 PM 清洁事件数:", dict(sorted(per_pm.items())))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean-type", choices=CLEAN_TYPES, default=None,
                    help="只跑指定清洁类型（默认 5 类全跑）")
    ap.add_argument("--n1", type=int, default=10, help="job1 片数")
    ap.add_argument("--n2", type=int, default=15, help="job2 片数")
    ap.add_argument("--proc", type=int, default=120, help="加工时长(s)")
    ap.add_argument("--clean-time", type=int, default=20, help="清洁时长(s)")
    ap.add_argument("--tl", type=float, default=60.0, help="MILP 时限(s)")
    ap.add_argument("--no-export", action="store_true", help="不导出 movelist")
    args = ap.parse_args()

    alg, _ = load_alg_entries(input_data_path(BASE_TOPO))
    alg = expand_topo_pms(alg, PM_POOL_6)
    types = [args.clean_type] if args.clean_type else list(CLEAN_TYPES)

    for ct in types:
        up = build_two_jobs(ct, args.n1, args.n2, args.proc, args.clean_time)
        ir = parse_task(alg, up)
        ir._wmap = {w.wid: w for w in ir.wafers}
        res = solve_milp(ir, time_limit=args.tl, verbose=False)
        issues = check_solution(ir, res)
        cleans = _clean_specs(ir, ir.wafers)
        print("=" * 68)
        print(f"{ct}  status={res.status} makespan={res.makespan:.1f} "
              f"gap={res.gap*100:.2f}% wafers={len(res.schedule)} clean_events={len(cleans)}")
        print("  ✓ 自检通过" if not issues else f"  ✗ 自检 {len(issues)} 违例: {issues[:3]}")
        _print_timeline(ir, res, cleans)
        if not args.no_export:
            ml = export_movelist(ir, res)
            out = output_path(f"2job_{ct}.json")
            out.parent.mkdir(parents=True, exist_ok=True)
            with open(out, "w", encoding="utf-8") as f:
                json.dump({"MoveList": ml}, f, ensure_ascii=False)
            nclean = sum(1 for m in ml if m.get("MoveType") == 9 and not m.get("MatIDList"))
            print(f"  导出 {len(ml)} 条 move（其中无片清洁 {nclean} 条）→ {out}")
    print("=" * 68)


if __name__ == "__main__":
    main()
