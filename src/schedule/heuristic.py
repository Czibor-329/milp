"""定序策略与评估内核：chooser 构造（喂片启发式 / 随机 / BC 策略）+ 解码评估 + 快速启发式调度。

对外入口 start_schedule / start_schedule_by_policy 在 api.py，本模块只放其复用的内部件：
  · 评估：_decode_eval（解码→solve_timing 精确评估）、_pick_best、_eval_chooser。
  · chooser：_feed_chooser（喂片优先启发式）、_random_chooser、_greedy_chooser / _sampling_chooser（BC）。
  · 调度：_needs_drain、_heuristic_schedule（单 job 喂片 / 2+ job 配比搜 / 清洁排空 + backward 兜底）、
          _random_rollouts。
"""

import itertools
import math
import random
import time
from typing import List, Optional, Dict, Tuple

from src.parse.model import Durations, Problem
from src.timing.solve import SolveResult, solve_timing

from src.timing._common import EPS, _DecodeDeadlock
from .sequencing import (_Cand, _Chooser, _DecodeState,decode_orders)


def _make_default_chooser(prio: Optional[Dict[Tuple[int, int], float]]
                          ) -> _Chooser:
    """定死 backward 规则的 chooser：按 (最早可起+bias, 下游优先, wid) 排序。
    bias 缺省 0 ⇒ 与旧定序逐字节同序（wid 唯一 ⇒ 决出全序，不触及 dest/rob 比较）。"""
    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        def key(i: int):
            c = cands[i]
            bias = prio.get((c.wid, c.j), 0.0) if prio else 0.0
            return (c.start + bias, -c.j, c.wid)
        return sorted(range(len(cands)), key=key)
    return chooser

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
def _needs_drain(ir: Problem, wafers) -> bool:
    """是否必须走「保守排空优先(backward)」而非喂片。仅 dummy-wac 清洁需要：它注入 dummy 清洁片，
    喂片把 LL 塞满未加工片后 dummy 片/换出片无处落脚 → 死锁，故对其禁喂片、排空优先。

    pre/post/periodic-wac 清洁不注入 dummy 片，喂片安全（实测正好打到 MILP 最优、腔室利用率更高），
    故不锁排空——照单 job/多 job 的「backward 兜底 + 喂片」正常路径走。dummy 清洁(dummyclean)走多
    route 配比路径（drain 反而更差），也不在此门内。喂片若真死锁，_eval_chooser 会自拒并保留
    backward 地板 ⇒ 放行喂片单调不劣。"""
    return bool(ir.dummy_wac)


def _feed_chooser(quota: dict) -> _Chooser:
    """喂片优先 chooser：尽量把未加工片喂进加工腔/loadlock 以填满并行 PM（让 LL 常装未加工片、
    腔室不闲着）。每步偏好序：①搬进加工腔(启动 PM) > ②发新片(j==0，喂进 LL) > ③排空(按最早可起/
    下游优先)。Petri 可达性掩码在解码循环里兜底——喂得太满会死锁时只暴露安全候选，故只影响顺序
    偏好、不破坏正确性。

    quota：route→发片配额权重（>0）。多 job 时按 fed[route]/quota[route] 最小者优先发片，即按
    配额交替发片（1:1 / 1:2 / …）；单 job 恒 0，退化为纯喂片优先。fed 从 state.pos 直接数
    （pos>0=已离源），无需内部计数器 ⇒ 对动作掩码改选鲁棒。"""
    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        fed: dict = {}
        for wid, p in state.pos.items():
            if p > 0:
                w = state.wmap[wid]
                # 重算切点已经在设备内的晶圆，其 j==0 是裁剪后的续排起点，不是本轮新发片。
                # 若把它们计入 fed，新增同优 CJob 会先整批“追平”历史发片数，反而形成串行。
                if w.already_released:
                    continue
                group = w.cjob_id or w.route_name
                fed[group] = fed.get(group, 0) + 1

        def load_ratio(route: str) -> float:
            q = quota.get(route, 1) or 1
            return fed.get(route, 0) / q

        def business_rank(w):
            # HighestLot 可抢占后续派片/加工候选；HigherLot 的不可抢占边界由
            # dispatch_after 约束，NormalLot 再按 Priority 排序。
            if w.cjob_job_type == 2:
                return (0, 0)
            if w.cjob_job_type == 1:
                return (1, 0)
            if w.cjob_job_type == 3:
                return (2, 0)
            return (3, w.cjob_priority)

        def key(i: int):
            c = cands[i]
            w = state.wmap[c.wid]
            dtype = w.stages[c.j + 1].stage_type
            into_proc = 0 if dtype == "process" else 1     # ①搬进加工腔最优
            feed = 0 if c.j == 0 else 1                     # ②发新片次之
            group = w.cjob_id or w.route_name
            # 重算切点已经在设备内的晶圆先按原 Route 深度从下游向上游排空，
            # 避免 timing 把新片放进状态中仍被占用的 LL/PM 槽位。
            resume = (0, -w.resume_stage_index) if c.j == 0 and w.already_released else (1, 0)
            return (resume, *business_rank(w), into_proc, feed,
                    load_ratio(group), c.start, -c.j, c.wid)

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

    if _needs_drain(ir, wafers):
        if verbose:
            print("[timing] 启发式：dummy-wac 清洁 → 排空优先(drain/backward)")
        return _eval_chooser(ir, durations, wafers, backward, None)

    has_cjob_policy = any(w.cjob_id for w in wafers)
    # 标准 CJob 任务不能让不识别 JobType/Priority 的 backward 候选以更短
    # makespan 覆盖业务顺序；仅在业务 chooser 无可行解时才用它兜底。
    best = None if has_cjob_policy else _eval_chooser(ir, durations, wafers, backward, None)

    if len(routes) <= 1:
        if verbose:
            print("[timing] 启发式：单 job 喂片优先(feed) + backward 兜底")
        feed = _feed_chooser({routes[0]: 1} if routes else {})
        result = _eval_chooser(ir, durations, wafers, feed, best)
        return result or _eval_chooser(ir, durations, wafers, backward, None)

    # 2+ job：在若干交替发片配比里搜索（非全局）。前两条 route 取配比，其余按权重 1 均分。
    A, B = routes[0], routes[1]
    others = {r: 1 for r in routes[2:]}
    ratios = [(1, 1), (1, 2), (2, 1), (1, 3), (3, 1), (2, 3), (3, 2)]
    for a, b in ratios:
        best = _eval_chooser(ir, durations, wafers, _feed_chooser({A: a, B: b, **others}), best)
    if best is None:
        best = _eval_chooser(ir, durations, wafers, backward, None)
    if verbose:
        mk = best.makespan if best is not None and getattr(best, "feasible", False) else float("nan")
        print(f"[timing] 启发式：{len(routes)} job 交替配比搜索 ×{len(ratios)} + backward → makespan={mk:.2f}")
    return best


# --------------------------------------------------------------------------- #
# 随机定序 rollout
# --------------------------------------------------------------------------- #
def _random_chooser(rng: random.Random) -> _Chooser:
    """随机定序 chooser：每步给 Petri 安全候选一个均匀随机偏好序。"""
    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        order = list(range(len(cands)))
        rng.shuffle(order)
        return order
    return chooser


def _random_rollouts(ir: Problem, durations: Durations, wafers, base: Optional[SolveResult],
                     *, n: int, seed: int, verbose: bool) -> Optional[SolveResult]:
    """在给定腔分配基底上做 n 次随机定序 rollout（Petri 动作掩码保证无死锁；放开 LL swap 空间——
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
# 2-job 限时结构化搜索
# --------------------------------------------------------------------------- #
_RELEASE_SPACINGS = (5.0, 2.0, 10.0, 20.0, 40.0)
_REPAIR_FACTOR_RANGE = (0.7, 1.3)
_MAX_ENUMERATED_INTERLEAVINGS = 10_000
_MAX_PORTFOLIO_SECONDS = 1.0
_PORTFOLIO_BUDGET_FRACTION = 0.25


def _priority_eval(ir: Problem, durations: Durations, wafers, priorities: dict,
                   *, swap: bool) -> Optional[SolveResult]:
    """评估一组 hop 时间偏置；与 ``_decode_eval`` 不同，会保留驻留不可行结果供搜索修复。"""
    try:
        orders = decode_orders(ir, durations, wafers, swap=swap)
    except (RuntimeError, _DecodeDeadlock):
        return None
    return solve_timing(ir, wafers, orders=orders)


def _release_priorities(sequence: List[int], spacing: float) -> dict:
    """把两条 route 的发片交织序编码成 source hop 偏置；route 内 FIFO 仍由解码器保证。"""
    return {(wid, 0): rank * spacing for rank, wid in enumerate(sequence)}


def _repair_residency(priorities: dict, result: SolveResult,
                      rng: random.Random) -> bool:
    """依据精确定时返回的驻留超限，提前对应 PM 出片 hop；有可修复违例时返回 True。"""
    violations = getattr(result, "residency_violations", [])
    if not violations:
        return False
    low, high = _REPAIR_FACTOR_RANGE
    for wid, stage, _chamber, hold, limit in violations:
        excess = max(hold - limit, 1.0)
        hop = (wid, stage)
        priorities[hop] = priorities.get(hop, 0.0) - excess * rng.uniform(low, high)
    return True


def _two_job_timed_search(ir: Problem, durations: Durations, wafers,
                          base: Optional[SolveResult], *, seconds: float,
                          seed: int, verbose: bool) -> Optional[SolveResult]:
    """在严格时间预算内搜索两条 route 的发片交织，并用驻留违例定向修复。

    2-job 的 route 内发片顺序受 FIFO 固定，真正需要搜索的是两条有序序列的交织；例如 6+6 片
    仅有 924 种。每个候选仍交给 Petri 解码并由 ``solve_timing`` 精确计时，所以任意时刻返回的
    ``best`` 都是已验证可行解。搜索优先使用 LL swap，并周期性覆盖整腔互斥口径。

    参数：
      · seconds：墙钟时间预算，非正数时原样返回 base。
      · seed：候选交织、spacing 与驻留修复的可复现随机种子。
    """
    routes = sorted({w.route_name for w in wafers})
    if seconds <= 0 or len(routes) != 2:
        return base

    by_route = {route: sorted(w.wid for w in wafers if w.route_name == route)
                for route in routes}
    first_count = len(by_route[routes[0]])
    total_count = sum(len(wids) for wids in by_route.values())
    interleaving_count = math.comb(total_count, first_count)
    rng = random.Random(seed)
    search_start = time.perf_counter()
    deadline = search_start + seconds
    portfolio_seconds = (seconds if seconds <= _MAX_PORTFOLIO_SECONDS
                         else min(_MAX_PORTFOLIO_SECONDS,
                                  seconds * _PORTFOLIO_BUDGET_FRACTION))
    portfolio_deadline = search_start + portfolio_seconds
    best = base
    trials = 0
    improvements = 0

    # 常见 6+6 片只有 924 种：先用短 portfolio 覆盖不同 spacing，再完整扫 spacing=5 + LL swap。
    # 大批量组合数爆炸时回退随机采样，但仍以 set 去重，避免浪费昂贵的精确定时评估。
    enumerated = interleaving_count <= _MAX_ENUMERATED_INTERLEAVINGS
    positions = (list(itertools.combinations(range(total_count), first_count))
                 if enumerated else [])
    if positions:
        rng.shuffle(positions)
    phases = [(spacing, True) for spacing in _RELEASE_SPACINGS]
    phases.append((_RELEASE_SPACINGS[0], False))
    phase_index = 0
    position_index = 0
    seen = set()
    portfolio_finished = False

    while time.perf_counter() < deadline:
        in_portfolio = time.perf_counter() < portfolio_deadline
        if not in_portfolio and not portfolio_finished:
            # portfolio 后从 spacing=5 的完整覆盖重新开始，保证长预算能系统扫完最强邻域。
            position_index = 0
            phase_index = 0
            portfolio_finished = True
        if in_portfolio:
            spacing = rng.choice(_RELEASE_SPACINGS)
            swap = (trials % 8) != 0
        else:
            spacing, swap = phases[phase_index % len(phases)]
        if enumerated:
            first_positions = set(positions[position_index])
            position_index += 1
            if position_index >= len(positions):
                position_index = 0
                if not in_portfolio:
                    phase_index += 1
        else:
            tokens = [0] * first_count + [1] * (total_count - first_count)
            for _ in range(16):
                rng.shuffle(tokens)
                signature = (tuple(tokens), spacing, swap)
                if signature not in seen:
                    seen.add(signature)
                    break
            first_positions = {index for index, token in enumerate(tokens) if token == 0}

        offsets = [0, 0]
        sequence: List[int] = []
        for index in range(total_count):
            token = 0 if index in first_positions else 1
            route = routes[token]
            sequence.append(by_route[route][offsets[token]])
            offsets[token] += 1
        priorities = _release_priorities(sequence, spacing)
        result = _priority_eval(ir, durations, wafers, priorities, swap=swap)
        trials += 1

        if result is not None and getattr(result, "feasible", False):
            previous = best
            best = _pick_best(best, result)
            improvements += int(best is result and best is not previous)
        elif result is not None and _repair_residency(priorities, result, rng):
            # 一次定向修复通常足以跨过 qtime 可行边界；限制为一次以维持候选多样性。
            if time.perf_counter() >= deadline:
                break
            repaired = _priority_eval(ir, durations, wafers, priorities, swap=swap)
            trials += 1
            if repaired is not None and getattr(repaired, "feasible", False):
                previous = best
                best = _pick_best(best, repaired)
                improvements += int(best is repaired and best is not previous)

    if verbose:
        makespan = (best.makespan if best is not None and getattr(best, "feasible", False)
                    else float("nan"))
        print(f"[timing] 2-job 限时搜索 {seconds:.2f}s：评估 {trials} 个候选，"
              f"改进 {improvements} 次 → makespan={makespan:.2f}")
    return best


# --------------------------------------------------------------------------- #
# BC 策略 chooser（供 start_schedule_by_policy 用）
# --------------------------------------------------------------------------- #
def _greedy_chooser(policy) -> _Chooser:
    """策略 chooser：对 Petri 安全候选打分，返回分数降序的偏好序。"""
    from src.schedule.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        scores = policy.score_step(step_features(state, cands))
        return sorted(range(len(cands)), key=lambda i: -float(scores[i]))

    return chooser


def _sampling_chooser(policy, rng, temp: float) -> _Chooser:
    """随机 rollout 的 chooser：分数/temp 加 Gumbel 噪声后排序（= 按 softmax(分数/temp) 抽偏好序）。
    多次 rollout 用 timing 精确评估取最优，逼近策略下的最好序——仍是纯 BC（推理期解码，不训练）。"""
    import numpy as np
    from src.schedule.features import step_features

    def chooser(state: _DecodeState, cands: List[_Cand]) -> List[int]:
        s = policy.score_step(step_features(state, cands)) / temp
        g = rng.gumbel(size=len(s))
        return list(np.argsort(-(s + g)))

    return chooser
