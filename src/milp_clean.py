from typing import Optional, List, Tuple, Dict
from src.model import Problem, Wafer
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


def _clean_specs(task: Problem, wafers: List[Wafer]) -> List[_Clean]:
    """从 IR 的 route.clean 与 wac stage 字段，按 round-robin 的腔分配展开清洁事件。"""
    wmap = {w.wid: w for w in wafers}
    # 每个 process 腔按 wid 升序的占用 (wid, j)
    by_ch: Dict[str, List[Tuple[int, int]]] = {}
    for w in wafers:
        for j, s in enumerate(w.stages):
            if s.stage_type == "process" and s.chamber:
                by_ch.setdefault(s.chamber, []).append((w.wid, j))
    for occ in by_ch.values():
        occ.sort()

    # 顶层 pre/post 清洁按 PM 聚合（来源 Problem.pre_clean / post_clean，按 route 序拼接）
    pre_by_ch: Dict[str, Tuple[float, str, str]] = {}
    post_by_ch: Dict[str, Tuple[float, str, str]] = {}
    for spec in task.pre_clean:
        for c in spec.visits:
            pre_by_ch.setdefault(c, (float(spec.time), spec.recipe, spec.task))
    for spec in task.post_clean:
        for c in spec.visits:
            post_by_ch.setdefault(c, (float(spec.time), spec.recipe, spec.task))

    cleans: List[_Clean] = []
    for c, occ in by_ch.items():
        if not occ:
            continue
        slot = wmap[occ[0][0]].stages[occ[0][1]].slot
        if c in pre_by_ch:
            t, rec, task = pre_by_ch[c]
            if t > 0:
                cleans.append(_Clean(c, slot, t, rec, task, "pre", before=occ[0]))
        if c in post_by_ch:
            t, rec, task = post_by_ch[c]
            if t > 0:
                cleans.append(_Clean(c, slot, t, rec, task, "post", after=occ[-1]))
        # wac：每 trigger 片后插一次无片清洗（按 wid 序 = 发片序）
        st0 = wmap[occ[0][0]].stages[occ[0][1]]
        if st0.clean_trigger > 0 and st0.clean_time > 0:
            for k in range(st0.clean_trigger - 1, len(occ) - 1, st0.clean_trigger):
                cleans.append(_Clean(c, slot, st0.clean_time, st0.clean_recipe, "",
                                     "wac", after=occ[k], before=occ[k + 1]))
    return cleans