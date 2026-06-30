"""诊断双 job gap 的天花板：MILP 标签 vs 解码层各档。

对每个实例算 4 档 makespan，全部相对 MILP 报 gap%：
  fixed : time_from_ir（腔分配寻优 + 单次默认 backward 定序）—— eval/BC 的基底
  oracle: optimize_chambers 基底 + **MILP r-time 顺序**喂解码器 + solve_timing
          = 「把 MILP 的服务序原样回放」能达到的 makespan = BC 模仿的天花板
  sa    : optimize_from_ir（在腔分配基底上对占用序 + loadlock 选腔做 SA 搜索）
  milp  : 参考标签（=0）

解读：
  · oracle ≈ milp → 解码层能表示 MILP 解，gap 全在「定序」上 → BC/特征可治。
  · oracle ≫ milp → 解码层（单臂 backward + 腔分配口径）表示不了 MILP 解 → 须改解码层本身。
  · sa < fixed   → 现成顺序搜索就能压 gap（免费），eval/BC 没用上而已。
"""
import argparse, glob, io, json, sys, time
from pathlib import Path
import numpy as np

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.parse import load_alg_entries, parse_task
from src.paths import input_data_path
from src.marathon_gen import expand_topo_pms, PM_POOL_6
from src.model import Durations
from src.timing import (time_from_ir, optimize_from_ir, optimize_chambers,
                        _decode_orders, solve_timing, _Cand, _apply_chamber_assign)
from src.labels import rtime_from_schedule

BASE_TOPO = "s1-1c1p-preclean"
_ROOT = Path(__file__).resolve().parents[1]
_BIG = 1e18


def _milp_chamber_assign(msched):
    """schedule {wid:[(stype,chamber,a,r)]} → {(wid,j): chamber}（MILP 自己选的腔）。"""
    return {(int(wid), j): row[j][1] for wid, row in msched.items()
            for j in range(len(row))}


def oracle_makespan(ir, tm, msched):
    """用 MILP **自己的腔分配** + MILP r-time 顺序 chooser + solve_timing（含 reserve 回退）。
    返回 (makespan, 失败原因)。这是「解码层能否复现 MILP 解」的真天花板。"""
    assign = _milp_chamber_assign(msched)
    wf = _apply_chamber_assign(ir, ir.wafers, assign)
    rtime = rtime_from_schedule(msched)

    def chooser(state, cands):
        return sorted(range(len(cands)),
                      key=lambda i: rtime.get((cands[i].wid, cands[i].j), _BIG))
    for reserve in (False, True):
        try:
            orders = _decode_orders(ir, tm, wf, chooser=chooser, reserve=reserve, banker=True)
        except RuntimeError:
            return float("nan"), "deadlock"
        r = solve_timing(ir, wf, orders=orders)
        if getattr(r, "feasible", False):
            return r.makespan, ""
    return float("nan"), "residency"


def milp_chambers_default_order(ir, tm, msched):
    """MILP 自己的腔分配 + **默认 backward 定序**（不喂 MILP 序）。隔离「腔 vs 序」：
    若 ≈ oracle(0)，说明一旦腔对了、默认序就够 → gap 全在腔分配。"""
    assign = _milp_chamber_assign(msched)
    wf = _apply_chamber_assign(ir, ir.wafers, assign)
    from src.timing import _sequence
    for reserve in (False, True):
        try:
            orders = _sequence(ir, tm, wf, reserve=reserve, banker=True)
        except RuntimeError:
            return float("nan")
        r = solve_timing(ir, wf, orders=orders)
        if getattr(r, "feasible", False):
            return r.makespan
    return float("nan")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--glob", type=str, default="dataset/test/2job1s/inst_*.json")
    ap.add_argument("--sa-budget", type=float, default=3.0)
    args = ap.parse_args()

    ai0, _ = load_alg_entries(input_data_path(BASE_TOPO))
    ai0 = expand_topo_pms(ai0, PM_POOL_6)
    files = sorted(glob.glob(str(_ROOT / args.glob)))

    print(f"{'case':<22}{'MILP':>8}{'fixed%':>9}{'mch+def%':>10}{'oracle%':>9}{'sa%':>9}")
    print("-" * 67)
    gf, gm, go, gs = [], [], [], []
    for f in files:
        d = json.load(open(f, encoding="utf-8"))
        res = d.get("result", {})
        mk = res.get("makespan")
        if not res.get("schedule") or not (isinstance(mk, (int, float)) and mk == mk):
            continue
        ir = parse_task(ai0, d["update_params"])
        tm = Durations(ir)
        fixed = time_from_ir(ir, verbose=False, cross_check=False).makespan
        mch = milp_chambers_default_order(ir, tm, res["schedule"])
        orac, why = oracle_makespan(ir, tm, res["schedule"])
        sa = optimize_from_ir(ir, budget=args.sa_budget, verbose=False, cross_check=False).makespan
        pf = (fixed - mk) / mk * 100
        pm = (mch - mk) / mk * 100 if mch == mch else float("nan")
        po = (orac - mk) / mk * 100 if orac == orac else float("nan")
        ps = (sa - mk) / mk * 100
        gf.append(pf); gs.append(ps)
        if pm == pm:
            gm.append(pm)
        if po == po:
            go.append(po)
        name = Path(f).stem
        ms_ = f"{pm:>9.1f}" if pm == pm else f"{'nan':>9}"
        os_ = f"{po:>8.1f}" if po == po else f"{why:>8}"
        print(f"{name:<22}{mk:>8.1f}{pf:>8.1f} {ms_} {os_} {ps:>8.1f}")
    print("-" * 67)
    print(f"{'平均':<22}{'':>8}{np.mean(gf):>8.1f} {np.mean(gm):>9.1f} {np.mean(go):>8.1f} {np.mean(gs):>8.1f}")
    print(f"{'最大':<22}{'':>8}{np.max(gf):>8.1f} {np.max(gm):>9.1f} {np.max(go):>8.1f} {np.max(gs):>8.1f}")


if __name__ == "__main__":
    main()
