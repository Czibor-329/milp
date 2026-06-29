"""按步派工的状态/候选特征（numpy，无 torch）。

从解码器某一步的状态（_DecodeState）+ 合法候选 hop（List[_Cand]）抽特征，供 BC 策略打分。
特征 permutation-invariant：每候选一行，策略对每行独立打分再 softmax，故候选数可变。
全局特征拼到每个候选上一起喂网络。所有特征做了「相对化/比例化」处理，跨实例规模无关
（不直接喂绝对时刻/绝对片数）。

口径与 timing.py 解码完全一致：候选 = 去向资源未占/未预留且 j==0 满足 FIFO（由解码器保证）；
本模块只读状态，不改任何东西。
"""

from __future__ import annotations

from typing import List

import numpy as np

EPS = 1e-9
GLOBAL_DIM = 6
CAND_DIM = 12
FEATURE_DIM = GLOBAL_DIM + CAND_DIM     # 每候选最终特征维度（全局拼到候选上）


def step_features(state, cands) -> np.ndarray:
    """返回 [n_cand, FEATURE_DIM] 特征矩阵（全局特征已拼到每行）。state: _DecodeState。"""
    from src.timing import _pdur                      # 懒导入避免环

    wmap, K, pos, occ = state.wmap, state.K, state.pos, state.occ
    place_t, robot_free = state.place_t, state.robot_free
    tm = state.tm
    n_waf = max(len(wmap), 1)
    n_c = len(cands)

    starts = [c.start for c in cands]
    min_s, max_s = min(starts), max(starts)
    span_s = (max_s - min_s) or 1.0
    rfs = [robot_free.get(c.rob, 0.0) for c in cands]
    min_rf, max_rf = min(rfs), max(rfs)
    span_rf = (max_rf - min_rf) or 1.0

    n_place_proc = 0
    n_pick_proc = 0
    rows = np.zeros((n_c, FEATURE_DIM), dtype=np.float32)
    for i, c in enumerate(cands):
        w = wmap[c.wid]
        Kw = max(K[c.wid], 1)
        sj = w.stages[c.j]
        sj1 = w.stages[c.j + 1]
        place_into_proc = 1.0 if sj1.stage_type == "process" else 0.0
        pick_from_proc = 1.0 if sj.stage_type == "process" else 0.0
        n_place_proc += int(place_into_proc)
        n_pick_proc += int(pick_from_proc)

        # 驻留紧迫度：若是「从驻留加工腔取片」，本次若在 start 取，已占 = start − 入腔时刻；
        # 上限 cap = 站内停留 + 驻留。urgency→1 表示快超驻留（该尽快取）。
        resid_urg = 0.0
        has_resid = 0.0
        if pick_from_proc and getattr(sj, "residency", 0) and sj.residency > 0:
            cap = _pdur(tm, w, c.j) + sj.residency
            resid_urg = float(np.clip((c.start - place_t[c.wid]) / (cap or 1.0), 0.0, 2.0))
            has_resid = 1.0

        # 填充机会：若「放入并行加工腔」，同 stage 候选腔里还空着的比例（鼓励填满并行腔）
        free_sib = 0.0
        if place_into_proc:
            sibs = list(getattr(sj1, "cands", []) or [sj1.chamber])
            if sibs:
                free = sum(1 for cc in sibs if (cc, 0) not in occ)
                free_sib = free / len(sibs)

        f = [
            place_into_proc,                                   # c0 放入加工腔
            pick_from_proc,                                    # c1 从加工腔取片
            1.0 if sj1.stage_type == "loadlock" else 0.0,      # c2 放入 loadlock
            1.0 if (c.j + 1) == K[c.wid] else 0.0,             # c3 进 sink（完工）
            1.0 if c.j == 0 else 0.0,                          # c4 发片（出 source）
            c.j / Kw,                                          # c5 该片进度
            (c.start - min_s) / span_s,                        # c6 相对最早可起
            1.0 if c.start <= min_s + EPS else 0.0,            # c7 是否最早
            resid_urg,                                         # c8 驻留紧迫度
            has_resid,                                         # c9 当前在驻留腔
            free_sib,                                          # c10 并行腔空闲比例
            (robot_free.get(c.rob, 0.0) - min_rf) / span_rf,   # c11 该手相对空闲
        ]
        rows[i, GLOBAL_DIM:] = f

    g = np.array([
        state.placed / max(state.total, 1),                    # g0 总进度
        len(occ) / n_waf,                                       # g1 在制品（占用资源数）
        n_c / n_waf,                                            # g2 候选规模
        n_place_proc / max(n_c, 1),                             # g3 放入加工腔候选占比
        n_pick_proc / max(n_c, 1),                              # g4 取片候选占比
        1.0,                                                   # g5 偏置项
    ], dtype=np.float32)
    rows[:, :GLOBAL_DIM] = g                                   # 广播到每行
    return rows
