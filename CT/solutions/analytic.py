"""解析法调度（`solve_analytic`）：固定排序 → 差分约束图 → Bellman-Ford 最长路。

见 analytic_scheduler_design.md。核心思路：FIFO 发片 + round-robin 定腔/槽位已把绝大多数
「分配」决策写死；再把每个资源（腔-槽、机器手、loadlock）上各操作的先后顺序定下来，
`solve_milp` 的每条约束就退化成 `t_b ≥ t_a + d`（带延时前驱边）。在固定定向下最小化
makespan = 一张差分约束图上求最早可行时刻（最长路）。驻留 (D) 是上界 → 反向边，可能成环 →
用 Bellman-Ford 求解并检测正环（正环 ⟺ 当前顺序违反驻留 → 该结构选项不可行）。

资源服务顺序（唯一需要"决策"处）用**松弛-定序-重算的不动点迭代**近似列表调度：先在去掉
机器手互斥的松弛图上算一遍最早时刻，按各资源上 occ_start / pick 时刻排序得到服务序，固定该序
重建图再算；用新解重新定序，迭代至稳定。swap 作为结构选项整体 on/off 枚举（双臂换料：把
出腔 pick 与进腔 place 合成一趟 VTR 行程，省一次往返），取 makespan 最小者。

边权口径**完全复用** `milp.py` 的 `_Timing` / `_expand` / `_swap_candidates` / `L` /
occ_start / occ_end / ll_setup，保证与 MILP 同口径；输出兼容 `SolveResult`，可直接喂
`check_solution` / `export_movelist`。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, FrozenSet, List, Optional, Set, Tuple

from CT.solutions.preprocess.internal_data import PreprocessedTask
from CT.solutions.milp import (
    SolveResult, _SwapPair, _Timing, _Wafer, _expand, _swap_candidates, _clean_specs, _ll_proc,
)

NEG_INF = float("-inf")
EPS = 1e-6
Key = Tuple[str, int, int]   # ("a"|"r", wid, j)


# --------------------------------------------------------------------------- #
# 差分约束图：节点 = a[w,j] / r[w,j] / 源点；边 t[v] ≥ t[u] + w（求最长路）
# --------------------------------------------------------------------------- #
class _Graph:
    def __init__(self) -> None:
        self._id: Dict[object, int] = {}
        self.edges: List[Tuple[int, int, float]] = []   # (u, v, w): t[v] ≥ t[u] + w
        self.SRC = self.node("__src__")

    def node(self, key: object) -> int:
        i = self._id.get(key)
        if i is None:
            i = len(self._id)
            self._id[key] = i
        return i

    def add(self, u: int, v: int, w: float) -> None:
        self.edges.append((u, v, w))

    def add_eq(self, u: int, v: int, w: float) -> None:
        """刚性等式 t[v] = t[u] + w（双向边）。"""
        self.edges.append((u, v, w))
        self.edges.append((v, u, -w))


def _bellman_ford_longest(g: _Graph) -> Optional[List[float]]:
    """最长路（最早可行时刻）。返回 dist；出现正环（驻留不可行）→ None。"""
    n = len(g._id)
    dist = [NEG_INF] * n
    dist[g.SRC] = 0.0
    edges = g.edges
    for _ in range(n):
        changed = False
        for u, v, w in edges:
            du = dist[u]
            if du != NEG_INF and du + w > dist[v] + EPS:
                dist[v] = du + w
                changed = True
        if not changed:
            break
    else:
        for u, v, w in edges:            # 跑满 n 轮仍在变 → 正环
            du = dist[u]
            if du != NEG_INF and du + w > dist[v] + EPS:
                return None
    return dist


# --------------------------------------------------------------------------- #
# 边权口径（与 milp.py 完全一致）
# --------------------------------------------------------------------------- #
class _EdgeSpec:
    def __init__(self, ir: PreprocessedTask, tm: _Timing, wafers: List[_Wafer]):
        self.ir = ir
        self.tm = tm
        self.wafers = wafers
        self.wmap = {w.wid: w for w in wafers}
        self.skip_types = {"loadport", "buffer", "dummyport"}

    def L(self, w: _Wafer, j: int) -> float:
        rob = w.transports[j]
        return (self.tm.pick_t(rob, w.stages[j].chamber) + self.tm.move(rob)
                + self.tm.place_t(rob, w.stages[j + 1].chamber))

    def p_weight(self, w: _Wafer, j: int) -> float:
        """(P) a[w,j] → r[w,j]：place 关门 + 加工/抽充气 + pick 开门。"""
        s = w.stages[j]
        pp = self.tm.place_post(s.in_robot, s.chamber) if s.in_robot else 0.0
        pre = self.tm.pick_pre(s.out_robot, s.chamber) if s.out_robot else 0.0
        return pp + s.proc + pre

    def d_weight(self, w: _Wafer, j: int) -> Optional[float]:
        """(D) 驻留上界 → 反向边 r→a 权 −(p_weight + residency)。"""
        s = w.stages[j]
        if s.stage_type == "process" and s.residency > 0:
            return -(self.p_weight(w, j) + s.residency)
        return None

    def sst(self, w: _Wafer, j: int) -> float:
        s = w.stages[j]
        if not s.in_robot:
            return 0.0
        return self.tm.place_t(s.in_robot, s.chamber) + self.tm.place_pre(s.in_robot, s.chamber)

    def eet(self, w: _Wafer, j: int) -> float:
        s = w.stages[j]
        if not s.out_robot:
            return 0.0
        return self.tm.pick_t(s.out_robot, s.chamber) + self.tm.pick_post(s.out_robot, s.chamber)

    def ll_setup(self, prev: _Wafer, pj: int, nxt: _Wafer, nj: int) -> float:
        ps, ns = prev.stages[pj], nxt.stages[nj]
        if not ps.ll_type or not ns.ll_type:
            return 0.0
        ch = self.ir.chambers.get(ns.chamber)
        if ps.ll_type == "entry" and ns.ll_type == "entry":
            return float((ch.vent_time if ch else 0.0) or 0.0)
        if ps.ll_type == "exit" and ns.ll_type == "exit":
            return float((ch.pump_time if ch else 0.0) or 0.0)
        return 0.0

    def gap(self, rob: str, dst: str, src: str) -> float:
        """(R) 相邻两手活间隙：通常 move；同站多容量 skip 站须先关门再开门。"""
        ch = self.ir.chambers.get(dst)
        if (dst == src and ch and int(ch.capacity) > 1
                and str(ch.type).lower() in self.skip_types):
            return self.tm.place_post(rob, dst) + self.tm.pick_pre(rob, src)
        return self.tm.move(rob)


# --------------------------------------------------------------------------- #
# 机器手手活（统一表示：普通 hop 与 swap 合成趟）
# --------------------------------------------------------------------------- #
@dataclass
class _RobotOp:
    """机器手一次占用区间 [r(start), a(end)]。普通 hop 或 swap 合成趟。"""
    rob: str
    start: Key          # r 节点（占用起点）
    end: Key            # a 节点（占用终点）
    src: str            # pick 所在腔（定 gap）
    dst: str            # place 所在腔（定 gap）
    tie: Tuple[int, int]  # 排序 tie-break


def _robot_ops(es: _EdgeSpec, active: List[_SwapPair]) -> Dict[str, List[_RobotOp]]:
    """每手的手活列表。active swap 对的两 hop 合并为一趟，其余为普通 hop。"""
    consumed: Set[Tuple[int, int]] = set()
    for p in active:
        consumed.add((p.w_in.wid, p.j_in - 1))   # w_in 进腔 hop
        consumed.add((p.w_out.wid, p.j_out))      # w_out 出腔 hop
    out: Dict[str, List[_RobotOp]] = {}
    for w in es.wafers:
        for j in range(len(w.stages) - 1):
            if (w.wid, j) in consumed:
                continue
            out.setdefault(w.transports[j], []).append(_RobotOp(
                rob=w.transports[j], start=("r", w.wid, j), end=("a", w.wid, j + 1),
                src=w.stages[j].chamber, dst=w.stages[j + 1].chamber, tie=(w.wid, j)))
    for p in active:
        pin = p.j_in - 1
        c_prev = p.w_in.stages[pin].chamber
        c_next = p.w_out.stages[p.j_out + 1].chamber
        out.setdefault(p.robot, []).append(_RobotOp(
            rob=p.robot, start=("r", p.w_in.wid, pin), end=("a", p.w_out.wid, p.j_out + 1),
            src=c_prev, dst=c_next, tie=(p.w_in.wid, pin)))
    return out


def _chamber_ops(es: _EdgeSpec) -> Dict[Tuple[str, int], List[Tuple[int, int]]]:
    """每 (腔,槽) 上需互斥的占用 (wid, j)（跳过 loadport/buffer/dummyport 与 source/sink）。"""
    out: Dict[Tuple[str, int], List[Tuple[int, int]]] = {}
    for w in es.wafers:
        for j, s in enumerate(w.stages):
            ch = es.ir.chambers.get(s.chamber)
            if ch is None or str(ch.type).lower() in es.skip_types:
                continue
            if s.stage_type in ("source", "sink"):
                continue
            out.setdefault((s.chamber, s.slot), []).append((w.wid, j))
    return out


# --------------------------------------------------------------------------- #
# 建图 + 求解（给定 swap 结构与资源服务顺序）
# --------------------------------------------------------------------------- #
def _build_graph(
    es: _EdgeSpec,
    active: List[_SwapPair],
    chamber_order: Dict[Tuple[str, int], List[Tuple[int, int]]],
    robot_order: Dict[str, List[_RobotOp]],
) -> _Graph:
    g = _Graph()
    wmap = es.wmap
    A = lambda wid, j: g.node(("a", wid, j))
    R = lambda wid, j: g.node(("r", wid, j))

    # active swap：被合成趟治理的 hop（跳过普通 chain）；被换腔上跳过的 FIFO 对
    gov: Set[Tuple[int, int]] = set()
    skip_fifo: Set[FrozenSet[Tuple[int, int]]] = set()
    for p in active:
        gov.add((p.w_in.wid, p.j_in - 1))
        gov.add((p.w_out.wid, p.j_out))
        skip_fifo.add(frozenset({(p.w_out.wid, p.j_out), (p.w_in.wid, p.j_in)}))

    # 路径内在边：a[w,0]=0、chain（双向刚性）、(P)、(D)
    for w in es.wafers:
        K = len(w.stages) - 1
        g.add(g.SRC, A(w.wid, 0), 0.0)
        for j in range(K):
            g.add(A(w.wid, j), R(w.wid, j), es.p_weight(w, j))   # (P)
            dw = es.d_weight(w, j)
            if dw is not None:                                    # (D)
                g.add(R(w.wid, j), A(w.wid, j), dw)
            if (w.wid, j) in gov:
                continue                                          # swap 趟另铺刚性链
            Lwj = es.L(w, j)
            g.add_eq(R(w.wid, j), A(w.wid, j + 1), Lwj)           # chain a=r+L

    # active swap 刚性链（milp §4-S，sw=1）
    for p in active:
        Rr, c = p.robot, p.chamber
        pin = p.j_in - 1
        c_prev = p.w_in.stages[pin].chamber
        c_next = p.w_out.stages[p.j_out + 1].chamber
        swap_dur = es.tm.pick_t(Rr, c) + es.tm.place_t(Rr, c)
        e1 = es.tm.pick_t(Rr, c_prev) + es.tm.move(Rr)            # 持 w_in 抵 c = swap 起点
        g.add_eq(R(p.w_in.wid, pin), R(p.w_out.wid, p.j_out), e1)
        g.add_eq(R(p.w_out.wid, p.j_out), A(p.w_in.wid, p.j_in), swap_dur)
        e3 = es.tm.move(Rr) + es.tm.place_t(Rr, c_next)          # swap 后置 w_out 入 c_next
        g.add_eq(A(p.w_in.wid, p.j_in), A(p.w_out.wid, p.j_out + 1), e3)

    # (C)/(C-LL) 腔-槽互斥：occ_start(B) ≥ occ_end(A) + ll_setup
    #   ⟺ a[B] ≥ r[A] + (EET(A) + ll_setup + SST(B))
    for seq in chamber_order.values():
        for (wa, ja), (wb, jb) in zip(seq, seq[1:]):
            if frozenset({(wa, ja), (wb, jb)}) in skip_fifo:
                continue                                          # swap：w_in 随 w_out 同窗换入
            Wa, Wb = wmap[wa], wmap[wb]
            g.add(R(wa, ja), A(wb, jb),
                  es.eet(Wa, ja) + es.ll_setup(Wa, ja, Wb, jb) + es.sst(Wb, jb))

    # (R) 机器手互斥：r[B.start] ≥ a[A.end] + gap(A.dst, B.src)
    for seq in robot_order.values():
        for opa, opb in zip(seq, seq[1:]):
            g.add(g.node(opa.end), g.node(opb.start), es.gap(opa.rob, opa.dst, opb.src))

    # FIFO 发片：同 route id 升序 r[i,0] ≤ r[i+1,0]
    by_route: Dict[str, List[_Wafer]] = {}
    for w in es.wafers:
        by_route.setdefault(w.route_name, []).append(w)
    for ws in by_route.values():
        ws.sort(key=lambda w: w.wid)
        for i in range(len(ws) - 1):
            g.add(R(ws[i].wid, 0), R(ws[i + 1].wid, 0), 0.0)

    # 清洁占腔：pre 早于首片、wac 夹在两片间（post 不入图，回填 makespan 时计）
    for cl in _clean_specs(es.ir, es.wafers):
        if cl.kind == "pre":
            wb, jb = cl.before
            g.add(g.SRC, A(wb, jb), cl.dur + es.sst(wmap[wb], jb))
        elif cl.kind == "wac":
            wa, ja = cl.after
            wb, jb = cl.before
            g.add(R(wa, ja), A(wb, jb), es.eet(wmap[wa], ja) + cl.dur + es.sst(wmap[wb], jb))

    return g


def _build_and_solve(
    es: _EdgeSpec,
    active: List[_SwapPair],
    chamber_order: Dict[Tuple[str, int], List[Tuple[int, int]]],
    robot_order: Dict[str, List[_RobotOp]],
) -> Optional[Dict[Key, float]]:
    g = _build_graph(es, active, chamber_order, robot_order)
    dist = _bellman_ford_longest(g)
    if dist is None:
        return None
    return {key: dist[idx] for key, idx in g._id.items()
            if isinstance(key, tuple) and key[0] in ("a", "r")}


# --------------------------------------------------------------------------- #
# 列表调度：前向贪心模拟，按构造产出可行的资源服务序（无正环死锁）
#   pull 纪律：晶圆仅当目标腔有空（或与占用腔内已加工完的片 swap）才被取走。每步选「最早能
#   完成的就绪搬运」。模拟时刻仅用于定序，精确时刻由 Bellman-Ford 重算。
# --------------------------------------------------------------------------- #
def _list_schedule(es: _EdgeSpec, active: List[_SwapPair]):
    wmap = es.wmap
    swap_in = {p.w_in.wid: p for p in active}    # 该片经 swap 进腔
    swap_out = {p.w_out.wid: p for p in active}  # 该片经 swap 出腔（由 partner 的进腔触发）

    def is_skip(c: str) -> bool:
        ch = es.ir.chambers.get(c)
        return ch is None or str(ch.type).lower() in es.skip_types

    def blocks(w: _Wafer, j: int) -> bool:
        """stage j 占用是否计入腔互斥（非 skip 且非 source/sink）。"""
        s = w.stages[j]
        return not is_skip(s.chamber) and s.stage_type not in ("source", "sink")

    cur = {w.wid: 0 for w in es.wafers}
    avail = {w.wid: 0.0 for w in es.wafers}        # 在 cur 阶段加工完成、可被取走的时刻
    done = {w.wid: False for w in es.wafers}
    Klast = {w.wid: len(w.stages) - 1 for w in es.wafers}
    robot_free: Dict[str, float] = {}
    occ: Dict[Tuple[str, int], int] = {}           # (腔,槽) -> 占用 wid
    chamber_order: Dict[Tuple[str, int], List[Tuple[int, int]]] = {}
    robot_order: Dict[str, List[_RobotOp]] = {}

    # FIFO 发片：同 route 内须按 wid 升序离开 LP
    route_wids: Dict[str, List[int]] = {}
    for w in sorted(es.wafers, key=lambda w: w.wid):
        route_wids.setdefault(w.route_name, []).append(w.wid)

    def releasable(w: _Wafer) -> bool:
        for prev in route_wids[w.route_name]:
            if prev == w.wid:
                return True
            if cur[prev] == 0:        # 更早的同 route 片还没发 → 须等
                return False
        return True

    def rec_occupy(c: str, slot: int, wid: int, j: int) -> None:
        if not is_skip(c):
            occ[(c, slot)] = wid
            if blocks(wmap[wid], j):
                chamber_order.setdefault((c, slot), []).append((wid, j))

    def resolve_dest(w: _Wafer, dj: int) -> Optional[str]:
        """目标腔解析（含 LL 动态选腔=LL-z 交替模式）。多候选 loadlock 取空闲腔（默认优先），
        其余腔须 skip 或当前空闲，否则 None（被 pull 纪律挡住）。"""
        s = w.stages[dj]
        if s.stage_type == "loadlock" and len(s.cands) > 1:
            free = [c for c in s.cands if occ.get((c, 0)) is None]
            if not free:
                return None
            return s.chamber if s.chamber in free else free[0]
        if is_skip(s.chamber) or occ.get((s.chamber, s.slot)) is None:
            return s.chamber
        return None

    def assign_dest(w: _Wafer, dj: int, chosen: str) -> None:
        """把目标腔写回 stage（LL 动态改腔时同步刷新 proc=pump/vent）。"""
        s = w.stages[dj]
        if s.chamber != chosen:
            s.chamber = chosen
            if s.stage_type == "loadlock":
                s.proc = _ll_proc(es.ir, chosen, s.ll_type)

    steps = 0
    total_hops = sum(Klast.values())
    while steps <= total_hops + len(es.wafers) + 5:
        cands = []   # (comp, tie, kind, payload, start)
        for w in es.wafers:
            wid = w.wid
            if done[wid]:
                continue
            j = cur[wid]
            po = swap_out.get(wid)
            if po is not None and j == po.j_out:
                continue                       # 出腔由 partner 的 swap 触发，不自发
            R = w.transports[j]
            rf = robot_free.get(R, 0.0)
            pin_pair = swap_in.get(wid)
            if pin_pair is not None and j == pin_pair.j_in - 1:
                # swap 进腔：须 w_out 在腔且加工完、c_next 有空、本片就绪
                p = pin_pair
                wo = p.w_out.wid
                if cur[wo] != p.j_out:
                    continue                   # w_out 还没进腔 / 已离开 → swap 未就绪
                cn_ch = resolve_dest(p.w_out, p.j_out + 1)  # w_out 出腔目标（LL 动态选腔）
                if cn_ch is None:
                    continue
                start = max(avail[wid], avail[wo], rf)
                swap_dur = es.tm.pick_t(R, p.chamber) + es.tm.place_t(R, p.chamber)
                comp = start + es.tm.pick_t(R, p.w_in.stages[j].chamber) + es.tm.move(R) + swap_dur \
                    + es.tm.move(R) + es.tm.place_t(R, cn_ch)
                cands.append((comp, (wid, j), "swap", (p, cn_ch), start))
            else:
                if j == 0 and not releasable(w):
                    continue
                dch = resolve_dest(w, j + 1)
                if dch is None:
                    continue                   # 目标腔无空（pull 纪律）
                start = max(avail[wid], rf)
                comp = start + es.tm.pick_t(R, w.stages[j].chamber) + es.tm.move(R) + es.tm.place_t(R, dch)
                cands.append((comp, (wid, j), "hop", (wid, j, dch), start))
        if not cands:
            break
        cands.sort(key=lambda x: (x[0], x[1]))
        comp, _tie, kind, payload, start = cands[0]
        steps += 1

        if kind == "hop":
            wid, j, dch = payload
            w = wmap[wid]
            assign_dest(w, j + 1, dch)             # 落实目标腔（LL 动态选腔）
            R = w.transports[j]
            c, cslot = w.stages[j].chamber, w.stages[j].slot
            d, dslot = w.stages[j + 1].chamber, w.stages[j + 1].slot
            robot_order.setdefault(R, []).append(_RobotOp(
                R, ("r", wid, j), ("a", wid, j + 1), c, d, (wid, j)))
            if blocks(w, j):
                occ.pop((c, cslot), None)
            rec_occupy(d, dslot, wid, j + 1)
            cur[wid] = j + 1
            s2 = w.stages[j + 1]
            pp = es.tm.place_post(s2.in_robot, d) if s2.in_robot else 0.0
            avail[wid] = comp + pp + s2.proc
            robot_free[R] = comp
            if j + 1 == Klast[wid]:
                done[wid] = True
        else:  # swap
            p, cn_ch = payload
            assign_dest(p.w_out, p.j_out + 1, cn_ch)   # 落实 w_out 出腔目标（LL 动态选腔）
            R = p.robot
            wi, wo = p.w_in.wid, p.w_out.wid
            pin = p.j_in - 1
            cprev, sprev = p.w_in.stages[pin].chamber, p.w_in.stages[pin].slot
            c, cslot = p.chamber, p.w_in.stages[p.j_in].slot
            cn, snn = p.w_out.stages[p.j_out + 1].chamber, p.w_out.stages[p.j_out + 1].slot
            robot_order.setdefault(R, []).append(_RobotOp(
                R, ("r", wi, pin), ("a", wo, p.j_out + 1), cprev, cn, (wi, pin)))
            if blocks(p.w_in, pin):
                occ.pop((cprev, sprev), None)
            rec_occupy(c, cslot, wi, p.j_in)          # w_in 占 PM（w_out 同窗换出）
            rec_occupy(cn, snn, wo, p.j_out + 1)       # w_out 入 c_next
            swap_dur = es.tm.pick_t(R, c) + es.tm.place_t(R, c)
            arrive = start + es.tm.pick_t(R, cprev) + es.tm.move(R)
            swap_start = max(arrive, avail[wo])
            a_in = swap_start + swap_dur
            a_out = a_in + es.tm.move(R) + es.tm.place_t(R, cn)
            robot_free[R] = a_out
            cur[wi] = p.j_in
            si = p.w_in.stages[p.j_in]
            avail[wi] = a_in + (es.tm.place_post(si.in_robot, c) if si.in_robot else 0.0) + si.proc
            cur[wo] = p.j_out + 1
            so = p.w_out.stages[p.j_out + 1]
            avail[wo] = a_out + (es.tm.place_post(so.in_robot, cn) if so.in_robot else 0.0) + so.proc
            if p.j_in == Klast[wi]:
                done[wi] = True
            if p.j_out + 1 == Klast[wo]:
                done[wo] = True

    if not all(done.values()):
        import os
        if os.environ.get("ANALYTIC_DEBUG"):
            stuck = [(w.wid, cur[w.wid], w.stages[cur[w.wid]].chamber) for w in es.wafers if not done[w.wid]]
            print("DEADLOCK stuck (wid,cur,chamber):", stuck[:12])
            print("occ:", {k: v for k, v in occ.items()})
        return None  # 模拟死锁（罕见）→ 退回松弛 seed
    return chamber_order, robot_order


# 资源定序：按当前解的占用时刻排序（不动点迭代近似列表调度）
# --------------------------------------------------------------------------- #
def _order(es: _EdgeSpec, times: Dict[Key, float],
           chamber_ops: Dict[Tuple[str, int], List[Tuple[int, int]]],
           robot_ops: Dict[str, List[_RobotOp]]):
    def occ_start(p: Tuple[int, int]) -> float:
        return times.get(("a",) + p, 0.0) - es.sst(es.wmap[p[0]], p[1])

    chamber_order = {k: sorted(ops, key=lambda p: (occ_start(p), p))
                     for k, ops in chamber_ops.items()}
    robot_order = {k: sorted(ops, key=lambda o: (times.get(o.start, 0.0), o.tie))
                   for k, ops in robot_ops.items()}
    return chamber_order, robot_order


def _makespan(es: _EdgeSpec, times: Dict[Key, float]) -> float:
    ms = max(times.get(("a", w.wid, len(w.stages) - 1), 0.0) for w in es.wafers)
    for cl in _clean_specs(es.ir, es.wafers):
        if cl.kind == "post":
            wa, ja = cl.after
            ms = max(ms, times.get(("r", wa, ja), 0.0) + es.eet(es.wmap[wa], ja) + cl.dur)
    return ms


def _solve_mode(ir: PreprocessedTask, tm: _Timing, want_swap: bool, *,
                t0: float, time_limit: float, max_iter: int, verbose: bool):
    """给定 swap 结构，迭代定序 + Bellman-Ford，返回 (best_times, best_makespan, es, active)。

    每个 mode 独立 _expand（列表调度会动态改 LL 选腔，须隔离），故各自持有 es。初序来自列表
    调度模拟（按构造可行）；不可行则退回 wid 序松弛 seed。随后按解的占用时刻精化定序（不动点）。
    """
    wafers = _expand(ir, tm)
    es = _EdgeSpec(ir, tm, wafers)
    active = _swap_candidates(ir, wafers) if want_swap else []

    sim = _list_schedule(es, active)            # 注意：会就地改 es.wafers 的 LL 选腔
    chamber_ops = _chamber_ops(es)
    robot_ops = _robot_ops(es, active)
    if sim is not None:
        chamber_order, robot_order = sim
    else:
        chamber0 = {k: sorted(v) for k, v in chamber_ops.items()}
        seed = _build_and_solve(es, active, chamber0, {})
        if seed is None:
            return None, float("inf"), es, active
        chamber_order, robot_order = _order(es, seed, chamber_ops, robot_ops)

    best_times, best_ms, prev_sig = None, float("inf"), None
    for it in range(max_iter):
        times = _build_and_solve(es, active, chamber_order, robot_order)
        if times is None:
            break
        ms = _makespan(es, times)
        if ms < best_ms - EPS:
            best_ms, best_times = ms, times
        if verbose:
            print(f"    iter{it}: makespan={ms:.2f}")
        chamber_order, robot_order = _order(es, times, chamber_ops, robot_ops)
        sig = (tuple((k, tuple(v)) for k, v in sorted(chamber_order.items(), key=lambda x: str(x[0]))),
               tuple((k, tuple(o.tie for o in v)) for k, v in sorted(robot_order.items())))
        if sig == prev_sig or time.time() - t0 > time_limit:
            break
        prev_sig = sig
    return best_times, best_ms, es, active


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
def solve_analytic(ir: PreprocessedTask, *, time_limit: float = 1.0,
                   verbose: bool = False, max_iter: int = 8,
                   use_swap: Optional[bool] = None) -> SolveResult:
    """解析法求 makespan（drop-in 替换 solve_milp）。

    固定 FIFO+round-robin，枚举 swap{off,on} 两个结构选项，各自迭代定序 + Bellman-Ford
    最长路，取 makespan 最小者。use_swap 显式给定则只跑该模式。
    """
    t0 = time.time()
    tm = _Timing(ir)
    has_swap = bool(_swap_candidates(ir, _expand(ir, tm)))

    if use_swap is None:
        want = [False] + ([True] if has_swap else [])
    else:
        want = [bool(use_swap)]

    best = None  # (ms, times, es, active)
    for ws in want:
        if verbose:
            print(f"[analytic] swap={'on' if ws else 'off'}")
        times, ms, es, active = _solve_mode(ir, tm, ws, t0=t0, time_limit=time_limit,
                                            max_iter=max_iter, verbose=verbose)
        if times is not None and (best is None or ms < best[0] - EPS):
            best = (ms, times, es, active)

    if best is None:
        res = SolveResult(status=3, makespan=float("nan"))
        res.runtime = time.time() - t0
        return res

    best_ms, best_times, es, active = best
    res = SolveResult(status=2, makespan=best_ms)
    res.runtime = time.time() - t0
    for w in es.wafers:
        res.schedule[w.wid] = [
            (s.stage_type, s.chamber,
             best_times.get(("a", w.wid, j), 0.0),
             best_times.get(("r", w.wid, j), best_times.get(("a", w.wid, j), 0.0)))
            for j, s in enumerate(w.stages)]
    res.releases = sorted((best_times.get(("r", w.wid, 0), 0.0), w.route_name, w.wid)
                          for w in es.wafers)
    res.swaps = [(p.chamber, p.w_out.wid, p.w_in.wid) for p in active]
    res.gap = 0.0
    return res
