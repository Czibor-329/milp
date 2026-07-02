"""按步派工的状态/候选特征（numpy，无 torch）。

从解码器某一步的状态（_DecodeState）+ 合法候选 hop（List[_Cand]）抽特征，供 BC 策略打分。
特征 permutation-invariant：每候选一行，策略对每行独立打分再 softmax，故候选数可变。
全局特征拼到每个候选上一起喂网络。所有特征做了「相对化/比例化」处理，跨实例规模无关
（不直接喂绝对时刻/绝对片数）。注：在制品/候选规模同时给两种归一化——÷n_waf（g1/g2）与
÷系统资源容量（g6/g7）。÷n_waf 在训练片数下是细分辨率的 WIP 爬坡信号（分布内精度靠它），
但 WIP/候选数受资源上限约束、不随片数增长，÷n_waf 会随片数增大滑向 0、掉出训练分布（12 片
训练→25 片测试腔室选择崩成串行）；÷容量版取值区间跨批量稳定，给网络一路外推可依赖的信号。
两者并列（增维而非替换）：单独替换成÷容量会丢掉÷n_waf 的爬坡分辨率、使模型对种子极敏感、
塌陷在不同配置间游走（实测每个种子都在某处崩）。

口径与 timing.py 解码完全一致：候选 = 去向资源未占/未预留且 j==0 满足 FIFO（由解码器保证）；
本模块只读状态，不改任何东西。

c12~c15 为 recipe/route 量纲特征（皆 ÷ 实例尺度，跨实例规模无关）：多 job 时同一步的两条
recipe 路径候选在原 18 维下特征撞车（实测 16.6% 步，全 cross-route）⇒ BC 必给同分、复现不了
MILP 的跨 job 服务序。加这 4 维把撞车降到 2.5%（残留=对称同构 route，本应同分）。

c16 为选腔特征：同一 hop 在多候选腔（loadlock LA/LB、并行 PM）下分裂成多个候选，本维给出去向腔
在其候选腔池里的相对累计负载，让这些候选可区分（否则特征全同 ⇒ BC 分不清选哪个腔，学不到
MILP 的选腔决策）。仅选腔模式（labels/policy 走 state.ch_used）非零；默认/backward 定序恒 0。
"""

from __future__ import annotations

from typing import List

import numpy as np

EPS = 1e-9
GLOBAL_DIM = 8
CAND_DIM = 17
FEATURE_DIM = GLOBAL_DIM + CAND_DIM     # 每候选最终特征维度（全局拼到候选上）


def step_features(state, cands) -> np.ndarray:
    """返回 [n_cand, FEATURE_DIM] 特征矩阵（全局特征已拼到每行）。state: _DecodeState。"""
    from src.timing import _stage_dwell                # 懒导入避免环
    from src.timing._common import SKIP_TYPES

    wmap, K, pos, occ = state.wmap, state.K, state.pos, state.occ
    place_t, robot_free = state.place_t, state.robot_free
    tm = state.tm
    ir = state.ir
    ch_used = getattr(state, "ch_used", None)              # 选腔模式下各腔累计派入片数（否则 None）
    n_waf = max(len(wmap), 1)
    n_c = len(cands)

    # 系统容量（资源单元数）：route 实际触及的资源腔（非 source/sink/skip 类）容量之和。
    # 只依赖拓扑/route，**与晶圆数无关** ⇒ 与 ÷n_waf 版并列喂网络（g6/g7）：÷n_waf 版在训练片数下
    # 有细分辨率的 WIP 爬坡信号（分布内精度靠它）、÷n_units 版跨批量稳定（外推靠它，不随片数滑向 0）。
    res_chambers = {s.chamber for w in wmap.values() for s in w.stages
                    if s.stage_type not in ("source", "sink")
                    and s.chamber in ir.chambers
                    and str(ir.chambers[s.chamber].type).lower() not in SKIP_TYPES}
    n_units = max(sum(int(ir.chambers[c].capacity) for c in res_chambers), 1)

    starts = [c.start for c in cands]
    min_s, max_s = min(starts), max(starts)
    span_s = (max_s - min_s) or 1.0
    rfs = [robot_free.get(c.rob, 0.0) for c in cands]
    min_rf, max_rf = min(rfs), max(rfs)
    span_rf = (max_rf - min_rf) or 1.0

    # 实例级尺度（recipe 特征用，尺度无关）：最大单步 proc、各 route 总工作量
    max_proc = max((s.proc for w in wmap.values() for s in w.stages if s.proc > 0), default=1.0) or 1.0
    route_work: dict = {}
    for w in wmap.values():
        route_work.setdefault(w.route_name, sum(s.proc for s in w.stages))
    max_work = max(route_work.values(), default=1.0) or 1.0

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
            cap = _stage_dwell(tm, w, c.j) + sj.residency
            resid_urg = float(np.clip((c.start - place_t[c.wid]) / (cap or 1.0), 0.0, 2.0))
            has_resid = 1.0

        # 填充机会：若「放入并行加工腔」，同 stage 候选腔里还空着的比例（鼓励填满并行腔）
        free_sib = 0.0
        if place_into_proc:
            sibs = list(getattr(sj1, "cands", []) or [sj1.chamber])
            if sibs:
                free = sum(1 for cc in sibs if (cc, 0) not in occ)
                free_sib = free / len(sibs)

        # 选腔均衡：本候选去向腔在其候选腔池里的相对累计负载（0=池内最闲、1=最忙）。
        # MILP 均衡 loadlock/PM 负载 ⇒ 偏好低负载腔；这维让同一 hop 的不同选腔候选可区分（否则特征撞车）。
        chamber_load = 0.0
        if c.dest is not None and ch_used is not None:
            pool = list(getattr(sj1, "cands", []) or [c.dest[0]])
            loads = [ch_used.get(cc, 0) for cc in pool]
            lo, hi = min(loads), max(loads)
            chamber_load = (ch_used.get(c.dest[0], 0) - lo) / ((hi - lo) or 1.0)

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
            sj.proc / max_proc,                                # c12 当前 stage proc（recipe 量纲）
            sj1.proc / max_proc,                               # c13 下一 stage proc（去向负荷）
            sum(s.proc for s in w.stages[c.j:]) / max_work,    # c14 剩余工作量占比（critical ratio）
            route_work[w.route_name] / max_work,               # c15 该 route 总工作量（路径身份）
            chamber_load,                                      # c16 去向腔相对累计负载（选腔均衡）
        ]
        rows[i, GLOBAL_DIM:] = f

    g = np.array([
        state.placed / max(state.total, 1),                    # g0 总进度
        len(occ) / n_waf,                                       # g1 在制品÷片数（训练片数下细分辨率的 WIP 爬坡）
        n_c / n_waf,                                            # g2 候选规模÷片数
        n_place_proc / max(n_c, 1),                             # g3 放入加工腔候选占比
        n_pick_proc / max(n_c, 1),                              # g4 取片候选占比
        1.0,                                                   # g5 偏置项
        len(occ) / n_units,                                     # g6 系统占用率÷资源容量（跨批量稳定，供外推）
        n_c / n_units,                                          # g7 候选规模÷资源容量（跨批量稳定，供外推）
    ], dtype=np.float32)
    rows[:, :GLOBAL_DIM] = g                                   # 广播到每行
    return rows
