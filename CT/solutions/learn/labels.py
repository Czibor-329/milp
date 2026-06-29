"""BC 标签：teacher-forced 复现 MILP 资源服务序 → 每步 (候选特征, 专家选中 idx)。

每步在当前合法候选里按 **MILP r-time 升序** 定专家偏好；提交：
  · banker=False（纯贪心）：直接取 MILP-min 候选。近 MILP（replay gap ~+2%），但单臂循环等待会
    死锁（PM 满 + loadlock 被入腔片占满 → 无片可出/可进），命中则该实例不完整。
  · banker=True（Banker 安全）：取 MILP 偏好序里第一个「保持可完工」的候选。永不死锁 ⇒ 全覆盖，
    与推理同口径（推理也走 banker=True 安全掩码）。

extract_instance 先试纯贪心（拿近 MILP 标签），不完整再退 Banker（拿覆盖）。两种都记录**实际提交
的候选**作专家标签。MILP r-time 取自 result.schedule：hop (wid,j) 发生 = stage j 的 r 值。
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np

from CT.solutions.learn.features import step_features

_BIG = 1e18


def rtime_from_schedule(msched: dict) -> Dict[Tuple[int, int], float]:
    """result.schedule（{wid: [(stype, chamber, a, r), ...]}）→ {(wid, j): r}（hop 发生时刻）。"""
    out: Dict[Tuple[int, int], float] = {}
    for wid, row in msched.items():
        for j, entry in enumerate(row):
            out[(int(wid), j)] = float(entry[3])
    return out


def _replay_record(ir, tm, wafers, rtime, *, banker: bool
                   ) -> Tuple[List[Tuple[np.ndarray, int]], bool]:
    """复现 MILP 序并记录每步 (候选特征, 提交候选在 cands 中的 idx)。返回 (records, completed)。
    候选/Banker/提交口径与 timing._decode_orders 完全一致（仅选择规则=MILP r-time）。"""
    from CT.solutions.timing import (_Cand, _DecodeState, _resource, _blocked,
                                     _reserve_for, _drain_completes, _pdur, _L)

    wmap = {w.wid: w for w in wafers}
    K = {w.wid: len(w.stages) - 1 for w in wafers}
    pos = {w.wid: 0 for w in wafers}
    place_t = {w.wid: 0.0 for w in wafers}
    occ: Dict[Tuple[str, int], int] = {}
    resv: Dict[Tuple[str, int], int] = {}      # 标签提取不预留（reserve=False）
    robot_free: Dict[str, float] = {}

    route_wids: Dict[str, List[int]] = {}
    for w in wafers:
        route_wids.setdefault(w.route_name, []).append(w.wid)
    for v in route_wids.values():
        v.sort()
    next_rel = {r: 0 for r in route_wids}

    records: List[Tuple[np.ndarray, int]] = []
    total = sum(K.values())
    placed = 0
    while placed < total:
        cands: List[_Cand] = []
        for w in wafers:
            wid = w.wid
            j = pos[wid]
            if j >= K[wid]:
                continue
            dest = _resource(ir, w, j + 1)
            if _blocked(dest, occ, {}, wid):
                continue
            if j == 0 and route_wids[w.route_name][next_rel[w.route_name]] != wid:
                continue
            rob = w.transports[j]
            start = max(place_t[wid] + _pdur(tm, w, j), robot_free.get(rob, 0.0))
            cands.append(_Cand(wid, j, dest, rob, start))
        if not cands:
            return records, False              # 死锁（纯贪心命中单臂循环等待）

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
                    pick = idx
                    break
            if pick is None:
                return records, False

        state = _DecodeState(ir, tm, wmap, K, pos, occ, resv, place_t, robot_free,
                             placed, total, False)
        records.append((step_features(state, cands), pick))

        c = cands[pick]
        wid, j, dest, rob, start = c
        w = wmap[wid]
        src = _resource(ir, w, j)
        if src is not None and occ.get(src) == wid:
            del occ[src]
        if dest is not None:
            occ[dest] = wid
        robot_free[rob] = start + _L(tm, w, j)
        place_t[wid] = robot_free[rob]
        if j == 0:
            next_rel[w.route_name] += 1
        pos[wid] = j + 1
        placed += 1
    return records, True


def extract_instance(ir, tm, wafers, msched) -> Tuple[List[Tuple[np.ndarray, int]], bool]:
    """先纯贪心复现（近 MILP 标签）；死锁则退 Banker（全覆盖）。返回 (每步记录, 是否成功)。"""
    rtime = rtime_from_schedule(msched)
    records, ok = _replay_record(ir, tm, wafers, rtime, banker=False)
    if ok:
        return records, True
    return _replay_record(ir, tm, wafers, rtime, banker=True)
