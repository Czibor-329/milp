"""BC 标签：teacher-forced 复现 MILP **选腔 + 服务序** → 每步 (候选特征, 专家选中 idx)。

逐步走解码器：每步在合法候选里跟随 MILP——同一 hop 仅在 loadlock 多候选腔（LA/LB）下分裂成多个
候选（加工腔 round-robin 固定单候选、不选腔，见 _chamber_pool），专家 = 「MILP 最早发生的 hop」
且「MILP 实际用的那个腔」。提交即把选中的腔写回该 stage（改 chamber/slot、loadlock 重算 pump/vent），
使后续资源键与 MILP 一致。

**为何不再需要 Banker**：过去标签把 MILP 选腔决策丢掉、用 parse round-robin 腔重放 MILP 序 ⇒
缝合怪死锁、被迫用 Banker 擦屁股、标签偏离 MILP、BC 天花板卡在选腔。现在 teacher 连腔一起复现，
「MILP 序 + MILP 腔」本身可行无死锁（实测 dataset 全通），纯跟随即可完整复现，banker=False。

MILP 的 hop 发生时刻 / 选腔取自 result.schedule：schedule[wid][j] = (stage_type, chamber, a进站, r取走)。
hop (wid,j) 发生时刻 = 该 stage 的 r；hop (wid,j)→(j+1) 的去向腔 = stage j+1 的 chamber。
"""

from __future__ import annotations

import copy
from typing import Dict, List, Optional, Tuple

import numpy as np

from src.features import step_features
from src.milp import _ll_proc

_BIG = 1e18


def _hop_release_times(schedule: dict) -> Dict[Tuple[int, int], float]:
    """MILP 解里每个 hop 的发生时刻：hop (wid,j) 发生 = 晶圆 wid 离开 stage j 的取走(r)时刻。
    schedule[wid][j] = (stage_type, chamber, a进站, r取走)，取 [3]。"""
    out: Dict[Tuple[int, int], float] = {}
    for wid, row in schedule.items():
        for j, entry in enumerate(row):
            out[(int(wid), j)] = float(entry[3])
    return out


def _hop_chambers(schedule: dict) -> Dict[Tuple[int, int], str]:
    """MILP 解里每片每 stage 实际用的腔：schedule[wid][j][1]。供 teacher 选腔对齐 MILP。"""
    out: Dict[Tuple[int, int], str] = {}
    for wid, row in schedule.items():
        for j, entry in enumerate(row):
            out[(int(wid), j)] = str(entry[1])
    return out


def _clone_wafers(wafers) -> List:
    """浅克隆 wafers + stages（提交时会就地改 stage.chamber/slot/proc，不能污染 ir.wafers）。"""
    wf = [copy.copy(w) for w in wafers]
    for w in wf:
        w.stages = [copy.copy(s) for s in w.stages]
    return wf


def _replay_record(ir, tm, wafers, rtime, milp_ch
                   ) -> Tuple[List[Tuple[np.ndarray, int]], bool]:
    """跟随 MILP 选腔+服务序复现，记录每步 (候选特征, 专家 idx)。返回 (records, completed)。

    候选：每片当前 hop 按其去向 stage 的候选腔（有空槽者）分裂成多个 _Cand（dest=(腔,槽)）；
    专家：MILP 最早发生的 hop 且用 MILP 那个腔。banker=False 纯跟随（MILP 序+腔可行无死锁）。"""
    from src.timing import _Cand, _DecodeState, _resource, _stage_dwell, _hop_span, _chamber_pool

    wafers = _clone_wafers(wafers)
    wmap = {w.wid: w for w in wafers}
    K = {w.wid: len(w.stages) - 1 for w in wafers}
    pos = {w.wid: 0 for w in wafers}
    place_t = {w.wid: 0.0 for w in wafers}
    occ: Dict[Tuple[str, int], int] = {}
    resv: Dict[Tuple[str, int], int] = {}
    robot_free: Dict[str, float] = {}
    ch_used: Dict[str, int] = {}               # 各腔累计派入片数（供选腔均衡特征）

    route_wids: Dict[str, List[int]] = {}
    for w in wafers:
        route_wids.setdefault(w.route_name, []).append(w.wid)
    for v in route_wids.values():
        v.sort()
    next_rel = {r: 0 for r in route_wids}

    def _free_slot(cc: str) -> Optional[int]:
        ch = ir.chambers.get(cc)
        cap = int(ch.capacity) if ch else 1
        return next((s for s in range(max(cap, 1)) if (cc, s) not in occ), None)

    records: List[Tuple[np.ndarray, int]] = []
    total = sum(K.values())
    placed = 0
    while placed < total:
        cands: List[_Cand] = []
        for w in wafers:
            wid = w.wid
            j = pos[wid]
            if j >= K[wid]:                              # 已完工
                continue
            if j == 0 and route_wids[w.route_name][next_rel[w.route_name]] != wid:
                continue                                 # 发片 FIFO 未轮到
            rob = w.transports[j]
            start = max(place_t[wid] + _stage_dwell(tm, w, j), robot_free.get(rob, 0.0))
            base = _resource(ir, w, j + 1)               # None=去向为 source/sink/skip（无资源、不选腔）
            if base is None:
                cands.append(_Cand(wid, j, None, rob, start))
                continue
            nxt = w.stages[j + 1]
            pool = _chamber_pool(nxt)                     # 仅 loadlock 多候选选腔；加工腔 round-robin 固定
            for cc in pool:                              # 每个有空槽的候选腔 → 一个候选
                slot = _free_slot(cc)
                if slot is not None:
                    cands.append(_Cand(wid, j, (cc, slot), rob, start))
        if not cands:
            return records, False                        # 无合法候选却未完工

        # 专家偏好：MILP 最早发生的 hop 优先；同一 hop 内选 MILP 实际用的腔（mismatch=0 排前）
        def key(i: int):
            c = cands[i]
            r = rtime.get((c.wid, c.j), _BIG)
            mism = 0 if (c.dest is None or milp_ch.get((c.wid, c.j + 1)) == c.dest[0]) else 1
            return (r, mism)
        pick = min(range(len(cands)), key=key)

        state = _DecodeState(ir, tm, wmap, K, pos, occ, resv, place_t, robot_free,
                             placed, total, False, ch_used)
        records.append((step_features(state, cands), pick))

        c = cands[pick]
        wid, j, dest, rob, start = c
        w = wmap[wid]
        src = _resource(ir, w, j)
        if src is not None and occ.get(src) == wid:
            del occ[src]
        if dest is not None:                             # 把选中的腔写回 stage（资源键与 MILP 一致）
            cc, slot = dest
            nxt = w.stages[j + 1]
            nxt.chamber, nxt.slot = cc, slot
            if nxt.stage_type == "loadlock":
                nxt.proc = _ll_proc(ir, cc, nxt.ll_type)
            occ[dest] = wid
            ch_used[cc] = ch_used.get(cc, 0) + 1
        robot_free[rob] = start + _hop_span(tm, w, j)
        place_t[wid] = robot_free[rob]
        if j == 0:
            next_rel[w.route_name] += 1
        pos[wid] = j + 1
        placed += 1
    return records, True


def extract_instance(ir, tm, wafers, schedule) -> Tuple[List[Tuple[np.ndarray, int]], bool]:
    """teacher-forced 复现 MILP 选腔+服务序。返回 (每步记录, 是否成功完工)。"""
    rtime = _hop_release_times(schedule)
    milp_ch = _hop_chambers(schedule)
    return _replay_record(ir, tm, wafers, rtime, milp_ch)
