"""把解析后的清洁配置展开为各调度策略共享的固定约束。"""

from typing import Optional, List, Tuple, Dict
from src.parse.model import Problem, Wafer
from dataclasses import dataclass

# --------------------------------------------------------------------------- #
# 清洁展开（决策4）：pre/post/wac 折成固定占腔事件（无片、无搬运），不进 0/1。
#   dummy 清洁已由 synthesize_dummy_routes 合成为 dummy 晶圆，随 task.pjobs 正常流转。
# --------------------------------------------------------------------------- #
@dataclass
class _Clean:
    chamber: str
    slot: int
    dur: float
    recipe: str
    task: str
    kind: str                          # 'pre' / 'post' / 'wac'
    before: Optional[Tuple[int, int]] = None   # 须早于此 (wid, j) 的占腔
    after: Optional[Tuple[int, int]] = None    # 须晚于此 (wid, j) 的占腔


def _is_dummy_wafer(w: Wafer) -> bool:
    """合成的 dummy 清洁片：pjob 名 dummy_<PM>（synthesize_dummy_routes）或 route 名含 _dummy_。"""
    return w.pjob_name.startswith("dummy_") or "_dummy_" in w.route_name


def _occ_by_chamber(
    wafers: List[Wafer],
) -> Tuple[Dict[str, List[Tuple[int, int]]], Dict[str, List[Tuple[int, int]]]]:
    """每个 process 腔按 wid 升序的占用 (wid, j)，真实片 / 合成 dummy 片分开归组。"""
    by_ch: Dict[str, List[Tuple[int, int]]] = {}
    dummy_by_ch: Dict[str, List[Tuple[int, int]]] = {}
    for w in wafers:
        dst = dummy_by_ch if _is_dummy_wafer(w) else by_ch
        for j, s in enumerate(w.stages):
            if s.stage_type == "process" and s.chamber:
                dst.setdefault(s.chamber, []).append((w.wid, j))
    for grp in (by_ch, dummy_by_ch):
        for occ in grp.values():
            occ.sort()
    return by_ch, dummy_by_ch


def _pjob_runs(
    wmap: Dict[int, Wafer], occ: List[Tuple[int, int]],
) -> List[List[Tuple[int, int]]]:
    """按 pjob 把腔占用切成连续段（发片序=wid 序 ⇒ 同 job 占用相邻）。"""
    runs: List[List[Tuple[int, int]]] = []
    for o in occ:
        pj = wmap[o[0]].pjob_name
        if runs and wmap[runs[-1][0][0]].pjob_name == pj:
            runs[-1].append(o)
        else:
            runs.append([o])
    return runs


def _dummy_order_pairs(
    task: Problem, wafers: List[Wafer],
) -> List[Tuple[Tuple[int, int], Tuple[int, int]]]:
    """dummy 清洁段与产品段的同腔定序对 (after, before)：occ_end(after) ≤ occ_start(before)。

    每个 dummy 段（一个 dummy pjob 在一个 PM 上的占用）夹在其所属产品的 job 边界之间：
    前一 job 的所有占用 → dummy 段首片，dummy 段末片 → 本 job 的所有占用，
    实现每腔 d(P1) → P1 → d(P2) → P2。所属产品由 Problem.dummy_owner 提供（缺失则不加约束）。
    """
    owner = getattr(task, "dummy_owner", {}) or {}
    if not owner:
        return []
    wmap = {w.wid: w for w in wafers}
    by_ch, dummy_by_ch = _occ_by_chamber(wafers)
    pairs: List[Tuple[Tuple[int, int], Tuple[int, int]]] = []
    for c, docc in dummy_by_ch.items():
        occ = by_ch.get(c)
        if not occ:
            continue
        runs = _pjob_runs(wmap, occ)
        run_idx = {wmap[run[0][0]].pjob_name: i for i, run in enumerate(runs)}
        for drun in _pjob_runs(wmap, docc):
            i = run_idx.get(owner.get(wmap[drun[0][0]].pjob_name, ""))
            if i is None:
                continue
            if i > 0:
                for o in runs[i - 1]:            # 前一 job 全部占用 → dummy 段首片
                    pairs.append((o, drun[0]))
            for o in runs[i]:                    # dummy 段末片 → 本 job 全部占用
                pairs.append((drun[-1], o))
    return pairs


def _clean_specs(task: Problem, wafers: List[Wafer]) -> List[_Clean]:
    """从 IR 的 route.clean 与 wac stage 字段，按 round-robin 的腔分配展开清洁事件。

    真实片与 dummy 片分开按腔归组：pre/post/periodic-wac 锚在真实片占用上；dummy-wac
    按 job 锚在「该 job 的 dummy 段末片」与「该 job 首个真实占用」之间
    （dummy 清洁跑完 → 无片 wac → 本 job 首片；dummy↔产品的定序见 _dummy_order_pairs）。
    """
    wmap = {w.wid: w for w in wafers}
    by_ch, dummy_by_ch = _occ_by_chamber(wafers)

    # 顶层 pre/post/dummy-wac 清洁按 PM 聚合（来源 Problem.pre_clean / post_clean / dummy_wac，按 route 序拼接）
    pre_by_ch: Dict[str, Tuple[float, str, str]] = {}
    post_by_ch: Dict[str, Tuple[float, str, str]] = {}
    dwac_by_ch: Dict[str, Tuple[float, str, str]] = {}
    for spec in task.pre_clean:
        for c in spec.visits:
            pre_by_ch.setdefault(c, (float(spec.time), spec.recipe, spec.task))
    for spec in task.post_clean:
        for c in spec.visits:
            post_by_ch.setdefault(c, (float(spec.time), spec.recipe, spec.task))
    for spec in getattr(task, "dummy_wac", []):
        for c in spec.visits:
            dwac_by_ch.setdefault(c, (float(spec.time), spec.recipe, spec.task))

    cleans: List[_Clean] = []
    for c, occ in by_ch.items():
        if not occ:
            continue
        slot = wmap[occ[0][0]].stages[occ[0][1]].slot
        # pre/post 清洁挂在 **每个 job 边界**（PrePJob/PostPJob 语义）：pre 落每 job 首片前、
        # post 落每 job 末片后。
        #   首 job 的 pre = 绝对 pre（腔空→首片）；后续 job 的 pre = 前一 job 末片与本 job 首片间隙。
        #   末 job 的 post = 收尾 post（进 makespan）；靠前 job 的 post = 本 job 末片与下 job 首片间隙。
        # 单 job 时段数=1 ⇒ 只出 pre / 只出 post，退化为原「腔全局首/末」口径（零回归）。
        runs = _pjob_runs(wmap, occ)
        if c in pre_by_ch:
            t, rec, task_name = pre_by_ch[c]
            if t > 0:
                for i, run in enumerate(runs):
                    if i == 0:                       # 腔上首 job：绝对 pre（腔空后清洁再放首片）
                        cleans.append(_Clean(c, slot, t, rec, task_name, "pre", before=run[0]))
                    else:                            # 后续 job：前 job 末片与本 job 首片之间清洁
                        cleans.append(_Clean(c, slot, t, rec, task_name, "wac",
                                             after=runs[i - 1][-1], before=run[0]))
        if c in post_by_ch:
            t, rec, task_name = post_by_ch[c]
            if t > 0:
                for i, run in enumerate(runs):
                    if i == len(runs) - 1:           # 腔上末 job：收尾 post（计入 makespan）
                        cleans.append(_Clean(c, slot, t, rec, task_name, "post", after=run[-1]))
                    else:                            # 靠前 job：本 job 末片与下 job 首片之间清洁
                        cleans.append(_Clean(c, slot, t, rec, task_name, "wac",
                                             after=run[-1], before=runs[i + 1][0]))
        # wac：每 trigger 片**加工后**插一次无片清洗（按 wid 序 = 发片序）。触发点含段末片：
        # 计数正好整除时末片后也要清（trigger=1、2 片 ⇒ w1-wac-w2-wac，而非 w1-wac-w2）。
        # 计数按 job（pjob 段）重置：跨 job 不累计，各 job 段内独立触发。
        st0 = wmap[occ[0][0]].stages[occ[0][1]]
        if st0.clean_trigger > 0 and st0.clean_time > 0:
            trig = st0.clean_trigger
            for ri, run in enumerate(runs):
                for k in range(trig - 1, len(run), trig):
                    if k + 1 < len(run):                 # 段内两片间清洗
                        cleans.append(_Clean(c, slot, st0.clean_time, st0.clean_recipe, "",
                                             "wac", after=run[k], before=run[k + 1]))
                    elif ri + 1 < len(runs):             # 段末触发：落到下一 job 首片前
                        cleans.append(_Clean(c, slot, st0.clean_time, st0.clean_recipe, "",
                                             "wac", after=run[k], before=runs[ri + 1][0]))
                    else:                                # 腔上最末片触发：收尾 wac（计入 makespan）
                        cleans.append(_Clean(c, slot, st0.clean_time, st0.clean_recipe, "",
                                             "post", after=run[k]))
        # dummy-wac：EmptyCleanRecipeAfterMaterial 语义——每片 dummy 加工后都插一次无片 wac，
        # 即 d1 → wac → d2 → wac → …→ 本 job 首个真实片（非仅末 dummy 后一次）。
        # dummy 段所属 job 由 dummy_owner 解析；解析不到时退化为「末 dummy → 腔上首真实片」。
        docc = dummy_by_ch.get(c)
        if c in dwac_by_ch and docc:
            t, rec, task_name = dwac_by_ch[c]
            if t > 0:
                owner = getattr(task, "dummy_owner", {}) or {}
                run_idx = {wmap[run[0][0]].pjob_name: i for i, run in enumerate(runs)}
                for drun in _pjob_runs(wmap, docc):
                    i = run_idx.get(owner.get(wmap[drun[0][0]].pjob_name, ""))
                    prod_first = runs[i][0] if i is not None else occ[0]
                    for di, d in enumerate(drun):        # 每片 dummy 后一次 wac
                        before = drun[di + 1] if di + 1 < len(drun) else prod_first
                        cleans.append(_Clean(c, slot, t, rec, task_name, "wac",
                                             after=d, before=before))
    return cleans
