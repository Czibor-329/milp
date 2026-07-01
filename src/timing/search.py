"""关键路径瓶颈提取 + 局部搜索寻优（占用序 + loadlock 选腔）。

solve_timing 已把各 cross-wafer 互斥边打标(res._tagged)并存最早时刻(res._dist)。一条互斥边
「紧」(dist[a]+w ≈ dist[b]) ⟺ 它绑住后继 = 落在关键路径上。把扰动集中在这些瓶颈资源（尤其
瓶颈 loadlock）上，是逼近 MILP 的高 ROI 部分。搜索用 SA：解码内含 Banker ⇒ 候选恒无死锁；
始终保留可行 incumbent(初始=默认定序) ⇒ 最坏不退化、anytime 返回 best。
"""

from __future__ import annotations

import math
import random
import time
from typing import Dict, List, Optional, Tuple

from src.milp import SolveResult
from src.model import Durations, Problem

from ._common import EPS, _DecodeDeadlock
from .chambers import _Genome, _chamber_assign_events, _chamber_opt_budgets, _decode, optimize_chambers
from .solve import solve_timing


def _critical_resources(res: SolveResult, tol: float = 1e-6):
    """从 res 的紧边提瓶颈：返回落在关键路径上的 cross-wafer 互斥边，按权重降序。
    每条 = (kind, key, op_lo, op_hi, w)；kind='C'腔/'R'手，key=腔名/手名，op=(wid,j)。"""
    dist = getattr(res, "_dist", None)
    tagged = getattr(res, "_tagged", None)
    if not dist or not tagged:
        return []
    tight = [(kind, key, op_lo, op_hi, w)
             for a, b, w, kind, key, op_lo, op_hi in tagged
             if dist[a] + w >= dist[b] - tol]
    tight.sort(key=lambda e: -e[4])
    return tight


def _infeasible() -> SolveResult:
    r = SolveResult(status=3, makespan=float("nan"))
    r.feasible = False                             # type: ignore[attr-defined]
    r.residency_violations = []                    # type: ignore[attr-defined]
    return r


def _eval_genome(ir: Problem, tm: Durations, wafers, genome: _Genome,
                 banker: Optional[bool] = None) -> Tuple[SolveResult, List]:
    """解码 genome → 求时刻。residency 不可行时按需 reserve=True 重解一次。返回 (res, 有效 wafers)。
    banker=False（搜索快路径）解码死锁直接判负（infeasible），不再调 solve_timing。
    banker=None（自动）：含 loadlock 选腔变更时必用 Banker（换腔后贪心序几乎必死锁），否则走快路径。"""
    if banker is None:
        banker = bool(genome.ll_assign)
    try:
        wf, orders = _decode(ir, tm, wafers, genome, reserve=False, banker=banker)
    except _DecodeDeadlock:
        return _infeasible(), wafers
    res = solve_timing(ir, wf, orders=orders)
    if not getattr(res, "feasible", False) and getattr(res, "residency_violations", []):
        # 驻留不可行 → 预留重排（带 Banker）。被扰动 genome 的预留可能反致无安全候选 → 判负。
        try:
            wf, orders = _decode(ir, tm, wafers, genome, reserve=True, banker=True)
        except (_DecodeDeadlock, RuntimeError):
            return _infeasible(), wafers
        res = solve_timing(ir, wf, orders=orders)
    return res, wf


def _neighbor(cur: _Genome, cur_res: SolveResult, wafers,
              ll_cand: Dict[Tuple[int, int], List[str]],
              ll_default: Dict[Tuple[int, int], str], rng: random.Random,
              mk: float) -> _Genome:
    """从当前 genome 派生一个邻居（克隆后扰动）。算子按瓶颈类型分流：
      · loadlock 瓶颈（关键路径上 'C' 边落在有候选腔的 loadlock）→ 优先「换腔」：把某 loadlock 占用挪到
        其它候选腔（对齐 MILP 的 Z 决策，均衡 LA/LB；用 Banker 评估保证可行）。一半挑瓶颈紧边上的占用
        （定向均衡），一半随机挑任意可换腔 loadlock（覆盖不在当前紧边上的改进）。
      · 机器手/其它瓶颈 → 「瓶颈翻序」prio 偏置（走快路径评估），不触发 loadlock 换腔。
    这样 loadlock 瓶颈集中用换腔这把关键钥匙，机器手瓶颈则廉价快搜。"""
    g = _Genome(prio=dict(cur.prio), ll_assign=dict(cur.ll_assign))
    step = max(mk * rng.uniform(0.03, 0.2), 1.0)
    tight = _critical_resources(cur_res)
    # 落在「有候选腔 loadlock」上的紧腔互斥边 = 可重指派的 loadlock 瓶颈
    c_edges = [e for e in tight if e[0] == "C"
               and any(op in ll_cand and e[1] in ll_cand[op] for op in (e[2], e[3]))]
    r = rng.random()
    # (1) loadlock 换腔（仅当 loadlock 确在关键路径）
    if c_edges and ll_cand and r < 0.7:
        if rng.random() < 0.5:                         # 定向：瓶颈紧边上的占用
            _, key, op_lo, op_hi, _ = rng.choice(c_edges[:max(1, len(c_edges) // 2)])
            op = rng.choice([op_lo, op_hi])
        else:                                          # 随机：任意可换腔 loadlock
            op = rng.choice(list(ll_cand))
        cur_c = g.ll_assign.get(op, ll_default.get(op))
        alt = [c for c in ll_cand.get(op, []) if c != cur_c]
        if alt:
            g.ll_assign[op] = rng.choice(alt)
            return g
    # (2) 瓶颈制导翻序（prio，快路径）：提前后继占用、推后前驱占用，试图翻转占用序。
    #   prio 键是「hop」(按源 stage j)；腔互斥边的 op=(wid,j) 是「占用」(到站 stage j)，控制它到站
    #   早晚的是 hop (wid, j-1)；机器手互斥边的 op 本身即 hop → 键就是 (wid,j)。故按 kind 映射。
    if tight and r < 0.92:
        kind, key, op_lo, op_hi, w = rng.choice(tight[:max(1, len(tight) // 2)])
        hop_hi = (op_hi[0], op_hi[1] - 1) if kind == "C" else op_hi
        hop_lo = (op_lo[0], op_lo[1] - 1) if kind == "C" else op_lo
        if hop_hi[1] >= 0:
            g.prio[hop_hi] = g.prio.get(hop_hi, 0.0) - step   # 后继提前
        if hop_lo[1] >= 0:
            g.prio[hop_lo] = g.prio.get(hop_lo, 0.0) + step   # 前驱推后
        return g
    # (3) 随机偏置一个 hop（多样化，快路径）
    wf = rng.choice(wafers)
    if len(wf.stages) > 1:
        j = rng.randrange(len(wf.stages) - 1)
        g.prio[(wf.wid, j)] = g.prio.get((wf.wid, j), 0.0) + rng.uniform(-step, step)
    return g


def optimize_orders(ir: Problem, wafers=None, *, budget: float = 2.0,
                    iters: Optional[int] = None, seed: int = 0,
                    verbose: bool = False) -> SolveResult:
    """局部搜索（SA）寻优占用序 + loadlock 选腔，用 solve_timing 评估。返回 best 可行 SolveResult
    （schedule 已反映所选 loadlock 腔）。budget=墙钟秒数；iters 设定则按迭代数停。

    先用 portfolio+贪心把 loadlock 分配定下（最大杠杆——单基因 SA 跳不出 round-robin 坏默认的
    LL 局部最优），再在该 LL-opt 基底上做顺序 SA。incumbent 初始 = LL-opt 基底默认定序 ⇒ 最坏
    不退化。"""
    t0 = time.perf_counter()
    tm = Durations(ir)
    if wafers is None:
        wafers = ir.wafers
    rng = random.Random(seed)

    # 腔分配寻优（loadlock + 并行加工腔）→ 基底；顺序 SA 在该基底上跑（仍可经 _neighbor 微调 LL）。
    ll_budget = min(budget * 0.5, 1.2) if iters is None else 0.8
    b, rb, cap = _chamber_opt_budgets(wafers, ll_budget, None)
    _, wf, ll_res = optimize_chambers(ir, tm, wafers, budget=b, seed=seed,
                                      refine_budget=rb, time_cap=cap)
    if ll_res is not None:
        wafers = wf

    ll_genes = _chamber_assign_events(wafers)
    ll_cand = {(w, j): cs for w, j, cs in ll_genes}                 # (wid,j) → 候选腔
    ll_default = {(w.wid, j): w.stages[j].chamber for w in wafers
                  for j, s in enumerate(w.stages)
                  if (w.wid, j) in ll_cand}                         # (wid,j) → 当前基底腔

    cur = _Genome()
    cur_res = ll_res if ll_res is not None else _eval_genome(ir, tm, wafers, cur, banker=True)[0]
    if not getattr(cur_res, "feasible", False):
        if verbose:
            print("[timing] 默认定序即不可行，放弃搜索。")
        return cur_res
    best, best_res, best_mk = cur, cur_res, cur_res.makespan
    base_mk = best_mk                               # LL-opt 基底基线（仅供日志）
    cur_mk = best_mk
    # 贪心为主的低温 SA：Banker 评估贵、迭代少，故偏向爬山；停滞则回到 best 重启以跳出局部。
    T0 = max(best_mk * 0.02, 1.0)
    stale = 0
    it = 0
    while iters is None or it < iters:
        elapsed = time.perf_counter() - t0
        if iters is None and elapsed >= budget:
            break
        it += 1
        cand = _neighbor(cur, cur_res, wafers, ll_cand, ll_default, rng, cur_mk)
        res, _ = _eval_genome(ir, tm, wafers, cand)   # 自动选 banker：含换腔→Banker，纯偏置→快路径
        if not getattr(res, "feasible", False):
            stale += 1
            continue
        mk = res.makespan
        frac = (elapsed / budget) if (iters is None and budget > 0) else (it / max(iters, 1))
        T = max(T0 * (1.0 - frac), 1e-6)
        if mk < cur_mk - EPS or rng.random() < math.exp(-(mk - cur_mk) / T):
            cur, cur_res, cur_mk = cand, res, mk
            if mk < best_mk - EPS:
                best, best_res, best_mk = cand, res, mk
                stale = 0
            else:
                stale += 1
        else:
            stale += 1
        if stale >= 40:                            # 停滞 → 回到 best 重启
            cur, cur_res, cur_mk = best, best_res, best_mk
            stale = 0
    if verbose:
        gain = (1.0 - best_mk / base_mk) * 100 if base_mk else 0.0
        print(f"[timing][search] 迭代 {it} 次，用时 {(time.perf_counter()-t0)*1000:.0f} ms，"
              f"best makespan={best_mk:.2f}（较基线 {gain:+.1f}%），"
              f"loadlock 选腔变更 {len(best.ll_assign)} 处。")
    # best_res 自带 schedule/_dist/_tagged，直接返回（避免对空 genome 用快路径重解可能死锁）
    return best_res
