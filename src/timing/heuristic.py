"""定序策略与评估内核：chooser 构造（喂片启发式 / 随机 / BC 策略）+ 解码评估 + 快速启发式调度。

对外入口 start_schedule / start_schedule_by_policy 在 api.py，本模块只放其复用的内部件：
  · 评估：_decode_eval（解码→solve_timing 精确评估）、_pick_best、_eval_chooser。
  · chooser：_feed_chooser（喂片优先启发式）、_random_chooser、_greedy_chooser / _sampling_chooser（BC）。
  · 调度：_has_clean、_heuristic_schedule（单 job 喂片 / 2+ job 配比搜 / 清洁排空 + backward 兜底）、
          _random_rollouts。
"""

from __future__ import annotations

import random
from typing import List, Optional

from src.milp import SolveResult
from src.model import Durations, Problem

from ._common import EPS, _DecodeDeadlock
from .solve import solve_timing
from .sequencing import (_Cand, _Chooser, _DecodeState, _make_default_chooser,
                         decode_orders)


# --------------------------------------------------------------------------- #
# 解码评估
# --------------------------------------------------------------------------- #
def _pick_best(a: Optional[SolveResult], b: Optional[SolveResult]) -> Optional[SolveResult]:
    """两个候选结果取 makespan 更优的可行者；都不可行/None 时保 a。"""
    if b is None or not getattr(b, "feasible", False):
        return a
    if a is None or not getattr(a, "feasible", False):
        return b
    return b if b.makespan < a.makespan - EPS else a


def _decode_eval(ir: Problem, durations: Durations, wafers, *, swap: bool = False,
                 chooser: Optional[_Chooser] = None) -> Optional[SolveResult]:
    """一次「解码 → solve_timing 精确评估」：可行返回结果，解码死锁/排不出返回 None。"""
    try:
        orders = decode_orders(ir, durations, wafers, chooser=chooser, swap=swap)
    except (RuntimeError, _DecodeDeadlock):
        return None
    r = solve_timing(ir, wafers, orders=orders)
    return r if getattr(r, "feasible", False) else None


def _eval_chooser(ir: Problem, durations: Durations, wafers, chooser: _Chooser,
                  prev: Optional[SolveResult]) -> Optional[SolveResult]:
    """一个 chooser 试 no-swap + swap 两条，与 prev 取 makespan 最优可行（单调不劣）。"""
    r = _pick_best(_decode_eval(ir, durations, wafers, swap=False, chooser=chooser),
                   _decode_eval(ir, durations, wafers, swap=True, chooser=chooser))
    return _pick_best(prev, r)


# --------------------------------------------------------------------------- #
# 快速启发式定序
# --------------------------------------------------------------------------- #
def _has_clean(ir: Problem, wafers) -> bool:
    """问题是否含清洁（pre/post/dummy-wac 或 stage 上的 periodic wac）。含清洁时不追求 LL 常满：
    换出加工腔的片需落脚处，若 LL 被未加工片占满则无处可去 → 死锁；故清洁例改保守排空优先。"""
    if ir.pre_clean or ir.post_clean or ir.dummy_wac:
        return True
    return any(getattr(s, "clean_time", 0.0) > 0 and getattr(s, "clean_trigger", 0) > 0
               for w in wafers for s in w.stages)


def _feed_chooser(quota: dict) -> _Chooser:
    """喂片优先 chooser：尽量把未加工片喂进加工腔/loadlock 以填满并行 PM（让 LL 常装未加工片、
    腔室不闲着）。每步偏好序：①搬进加工腔(启动 PM) > ②发新片(j==0，喂进 LL) > ③排空(按最早可起/
    下游优先)。Banker 安全掩码在解码循环里兜底——喂得太满会死锁时自动退到安全候选，故只影响顺序
    偏好、不破坏正确性。

    quota：route→发片配额权重（>0）。多 job 时按 fed[route]/quota[route] 最小者优先发片，即按
    配额交替发片（1:1 / 1:2 / …）；单 job 恒 0，退化为纯喂片优先。fed 从 state.pos 直接数
    （pos>0=已离源），无需内部计数器 ⇒ 对 Banker 改选鲁棒。"""
    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        fed: dict = {}
        for wid, p in state.pos.items():
            if p > 0:
                r = state.wmap[wid].route_name
                fed[r] = fed.get(r, 0) + 1

        def load_ratio(route: str) -> float:
            q = quota.get(route, 1) or 1
            return fed.get(route, 0) / q

        def key(i: int):
            c = cands[i]
            w = state.wmap[c.wid]
            dtype = w.stages[c.j + 1].stage_type
            into_proc = 0 if dtype == "process" else 1     # ①搬进加工腔最优
            feed = 0 if c.j == 0 else 1                     # ②发新片次之
            return (into_proc, feed, load_ratio(w.route_name), c.start, -c.j, c.wid)

        return sorted(range(len(cands)), key=key)

    return chooser


def _heuristic_schedule(ir: Problem, durations: Durations, wafers,
                        verbose: bool) -> Optional[SolveResult]:
    """快速启发式定序（取代原固定 backward 定序）。不做组合寻优的全局搜索：
      · 含清洁(wac/dummy-wac)：排空优先(backward)——不追求 LL 常满，避免换出加工腔的片无处落脚死锁。
      · 单 job：喂片优先(_feed_chooser)——让 LL 常装未加工片、填满并行 PM。
      · 2+ job：仅在几种交替发片配比(1:1/1:2/2:1/…)里小规模搜索。
    加工腔沿用 _expand 的 round-robin 固定分配（decode_orders 不选腔），启发式只决定顺序，每候选
    另试一次 LL swap 变体取优。喂片在深流水常触发驻留(qtime)超限 → 始终并评 backward 兜底取优，
    故整体单调不劣于旧固定序。"""
    routes = sorted({w.route_name for w in wafers})
    backward = _make_default_chooser(None)          # 旧固定序：排空/驻留安全，作兜底候选

    if _has_clean(ir, wafers):
        if verbose:
            print("[timing] 启发式：检测到清洁 → 排空优先(drain/backward)")
        return _eval_chooser(ir, durations, wafers, backward, None)

    best = _eval_chooser(ir, durations, wafers, backward, None)   # 兜底基线

    if len(routes) <= 1:
        if verbose:
            print("[timing] 启发式：单 job 喂片优先(feed) + backward 兜底")
        feed = _feed_chooser({routes[0]: 1} if routes else {})
        return _eval_chooser(ir, durations, wafers, feed, best)

    # 2+ job：在若干交替发片配比里搜索（非全局）。前两条 route 取配比，其余按权重 1 均分。
    A, B = routes[0], routes[1]
    others = {r: 1 for r in routes[2:]}
    ratios = [(1, 1), (1, 2), (2, 1), (1, 3), (3, 1), (2, 3), (3, 2)]
    for a, b in ratios:
        best = _eval_chooser(ir, durations, wafers, _feed_chooser({A: a, B: b, **others}), best)
    if verbose:
        mk = best.makespan if best is not None and getattr(best, "feasible", False) else float("nan")
        print(f"[timing] 启发式：{len(routes)} job 交替配比搜索 ×{len(ratios)} + backward → makespan={mk:.2f}")
    return best


# --------------------------------------------------------------------------- #
# 随机定序 rollout
# --------------------------------------------------------------------------- #
def _random_chooser(rng: random.Random) -> _Chooser:
    """随机定序 chooser：每步给合法候选一个均匀随机偏好序。解码循环的 Banker 安全掩码会沿
    该序回退——随机首选会导致死锁时自动跳到下一个安全候选，故任意随机序都解出可行占用序。"""
    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        order = list(range(len(cands)))
        rng.shuffle(order)
        return order
    return chooser


def _random_rollouts(ir: Problem, durations: Durations, wafers, base: Optional[SolveResult],
                     *, n: int, seed: int, verbose: bool) -> Optional[SolveResult]:
    """在给定腔分配基底上做 n 次随机定序 rollout（Banker 保证无死锁；放开 LL swap 空间——
    它严格包含 no-swap 的可行序），solve_timing 精确评估，与 base 取 makespan 最优可行
    （不满足要求——死锁/驻留超限/更差——即回退到已有最优）。"""
    rng = random.Random(seed)
    best = base
    picked = 0
    for _ in range(max(n, 0)):
        r = _decode_eval(ir, durations, wafers, swap=True, chooser=_random_chooser(rng))
        if r is not None and (best is None or not getattr(best, "feasible", False)
                              or r.makespan < best.makespan - EPS):
            best, picked = r, picked + 1
    if verbose and n > 0:
        mk = best.makespan if best is not None and getattr(best, "feasible", False) else float("nan")
        print(f"[timing] 随机定序 rollout ×{n}：采纳 {picked} 次改进 → makespan={mk:.2f}")
    return best


# --------------------------------------------------------------------------- #
# BC 策略 chooser（供 start_schedule_by_policy 用）
# --------------------------------------------------------------------------- #
def _greedy_chooser(policy) -> _Chooser:
    """策略 chooser：对每候选打分，返回分数降序的偏好序（Banker 在解码循环里再保证无死锁）。"""
    from src.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        scores = policy.score_step(step_features(state, cands))
        return sorted(range(len(cands)), key=lambda i: -float(scores[i]))

    return chooser


def _sampling_chooser(policy, rng, temp: float) -> _Chooser:
    """随机 rollout 的 chooser：分数/temp 加 Gumbel 噪声后排序（= 按 softmax(分数/temp) 抽偏好序）。
    多次 rollout 用 timing 精确评估取最优，逼近策略下的最好序——仍是纯 BC（推理期解码，不训练）。"""
    import numpy as np
    from src.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        s = policy.score_step(step_features(state, cands)) / temp
        g = rng.gumbel(size=len(s))
        return list(np.argsort(-(s + g)))

    return chooser
