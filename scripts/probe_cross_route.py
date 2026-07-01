"""探针 2：BC 特征撞车，到底是「同一 job 的并行兄弟片」还是「跨 job 的两条路径」？

probe_path_discrim 只看 .npz 里的特征，分不出撞车竞争者来自哪条 route。这里重放 MILP 服务序
（与 labels.py 同口径），但每步额外记录每个候选的 route_name，把「专家行的特征撞车竞争者」
拆成 same-route / cross-route 两类。cross-route 撞车 = 两条不同 recipe 路径的候选在当前 18 维
特征下完全同形 → 这正是「BC 分不清两种路径晶圆」的直接计数。
"""
import argparse, glob, io, json, sys
from pathlib import Path
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import load_alg_entries, parse_task
from src.paths import input_data_path
from src.marathon_gen import expand_topo_pms, PM_POOL_6
from src.model import Durations
from src.features import step_features
from src.timing import (optimize_chambers, _Cand, _DecodeState, _resource,
                        _blocked, _drain_completes, _stage_dwell, _hop_span)
from src.labels import rtime_from_schedule

BASE_TOPO = "s1-1c1p-preclean"
_ROOT = Path(__file__).resolve().parents[1]
_BIG = 1e18


def replay_routes(ir, tm, wafers, msched, tol):
    """重放（greedy→banker 兜底）MILP 序，返回每步专家行的撞车竞争者 route 关系列表。"""
    rtime = rtime_from_schedule(msched)
    for banker in (False, True):
        out = _run(ir, tm, wafers, rtime, tol, banker)
        if out is not None:
            return out
    return None


def _run(ir, tm, wafers, rtime, tol, banker):
    wmap = {w.wid: w for w in wafers}
    K = {w.wid: len(w.stages) - 1 for w in wafers}
    pos = {w.wid: 0 for w in wafers}
    place_t = {w.wid: 0.0 for w in wafers}
    occ, resv, robot_free = {}, {}, {}
    route_wids = {}
    for w in wafers:
        route_wids.setdefault(w.route_name, []).append(w.wid)
    for v in route_wids.values():
        v.sort()
    next_rel = {r: 0 for r in route_wids}
    total = sum(K.values()); placed = 0
    rows = []   # 每个多候选撞车步：(n_same, n_cross)
    while placed < total:
        cands = []
        for w in wafers:
            wid = w.wid; j = pos[wid]
            if j >= K[wid]:
                continue
            dest = _resource(ir, w, j + 1)
            if _blocked(dest, occ, {}, wid):
                continue
            if j == 0 and route_wids[w.route_name][next_rel[w.route_name]] != wid:
                continue
            rob = w.transports[j]
            start = max(place_t[wid] + _stage_dwell(tm, w, j), robot_free.get(rob, 0.0))
            cands.append(_Cand(wid, j, dest, rob, start))
        if not cands:
            return None
        order = sorted(range(len(cands)),
                       key=lambda i: rtime.get((cands[i].wid, cands[i].j), _BIG))
        if not banker:
            pick = order[0]
        else:
            pick = None
            for idx in order:
                c = cands[idx]
                tpos = dict(pos); tocc = dict(occ)
                src = _resource(ir, wmap[c.wid], c.j)
                if src is not None and tocc.get(src) == c.wid:
                    del tocc[src]
                if c.dest is not None:
                    tocc[c.dest] = c.wid
                tpos[c.wid] = c.j + 1
                if _drain_completes(ir, wmap, K, tpos, tocc, {}, False):
                    pick = idx; break
            if pick is None:
                return None

        if len(cands) > 1:
            state = _DecodeState(ir, tm, wmap, K, pos, occ, resv, place_t,
                                 robot_free, placed, total, False)
            feats = step_features(state, cands)
            ef = feats[pick]
            er = wmap[cands[pick].wid].route_name
            n_same = n_cross = 0
            for j2 in range(len(cands)):
                if j2 == pick:
                    continue
                if np.max(np.abs(feats[j2] - ef)) < tol:
                    if wmap[cands[j2].wid].route_name == er:
                        n_same += 1
                    else:
                        n_cross += 1
            rows.append((n_same, n_cross))

        c = cands[pick]; wid, j, dest, rob, start = c; w = wmap[wid]
        src = _resource(ir, w, j)
        if src is not None and occ.get(src) == wid:
            del occ[src]
        if dest is not None:
            occ[dest] = wid
        robot_free[rob] = start + _hop_span(tm, w, j)
        place_t[wid] = robot_free[rob]
        if j == 0:
            next_rel[w.route_name] += 1
        pos[wid] = j + 1; placed += 1
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--glob", type=str, default="dataset/test/2job1s/inst_*.json")
    ap.add_argument("--tol", type=float, default=1e-4)
    args = ap.parse_args()

    ai0, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai0 = expand_topo_pms(ai0, PM_POOL_6)

    files = sorted(glob.glob(str(_ROOT / args.glob)))
    tot_steps = multi = tie_same = tie_cross = 0
    for f in files:
        d = json.load(open(f, encoding="utf-8"))
        res = d.get("result", {})
        if not res.get("schedule"):
            continue
        ir = parse_task(ai0, d["update_params"])
        tm = Durations(ir)
        _, wf, _ = optimize_chambers(ir, tm, ir.wafers, budget=1.0, seed=0)
        if wf is None:
            wf = ir.wafers
        rows = replay_routes(ir, tm, wf, res["schedule"], args.tol)
        if rows is None:
            print(f"  [warn] {Path(f).name}: 重放失败"); continue
        for n_same, n_cross in rows:
            multi += 1
            if n_same:
                tie_same += 1
            if n_cross:
                tie_cross += 1
        tot_steps += len(rows)

    print("=" * 60)
    print(f"实例 glob：{args.glob}  多候选步 {multi}")
    print(f"撞车步含 same-route 竞争者：{tie_same}  "
          f"({100*tie_same/max(multi,1):.1f}% of 多候选步)")
    print(f"撞车步含 cross-route 竞争者：{tie_cross}  "
          f"({100*tie_cross/max(multi,1):.1f}% of 多候选步)")
    print("  └ cross-route 撞车 = 两条 recipe 路径的候选在 18 维特征下同形 → BC 必给同分、分不清。")
    print("=" * 60)


if __name__ == "__main__":
    main()
