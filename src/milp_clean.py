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


def _is_dummy_wafer(w: Wafer) -> bool:
    """合成的 dummy 清洁片：pjob 名 dummy_<PM>（synthesize_dummy_routes）或 route 名含 _dummy_。"""
    return w.pjob_name.startswith("dummy_") or "_dummy_" in w.route_name


def _clean_specs(task: Problem, wafers: List[Wafer]) -> List[_Clean]:
    """从 IR 的 route.clean 与 wac stage 字段，按 round-robin 的腔分配展开清洁事件。

    真实片与 dummy 片分开按腔归组：pre/post/periodic-wac 锚在真实片占用上；dummy-wac
    锚在「该 PM 最后一个 dummy 占用」与「首个真实占用」之间（dummy 清洁跑完 → 无片 wac → 首真实片）。
    """
    wmap = {w.wid: w for w in wafers}
    # 每个 process 腔按 wid 升序的占用 (wid, j)，真实/合成 dummy 分开归组
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
        # 按 pjob 把该腔占用切成连续段（发片序=wid 序 ⇒ 同 job 占用相邻）。pre/post 清洁挂在
        # **每个 job 边界**（PrePJob/PostPJob 语义）：pre 落每 job 首片前、post 落每 job 末片后。
        #   首 job 的 pre = 绝对 pre（腔空→首片）；后续 job 的 pre = 前一 job 末片与本 job 首片间隙。
        #   末 job 的 post = 收尾 post（进 makespan）；靠前 job 的 post = 本 job 末片与下 job 首片间隙。
        # 单 job 时段数=1 ⇒ 只出 pre / 只出 post，退化为原「腔全局首/末」口径（零回归）。
        runs: List[List[Tuple[int, int]]] = []
        for o in occ:
            pj = wmap[o[0]].pjob_name
            if runs and wmap[runs[-1][0][0]].pjob_name == pj:
                runs[-1].append(o)
            else:
                runs.append([o])
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
        # wac：每 trigger 片后插一次无片清洗（按 wid 序 = 发片序）
        st0 = wmap[occ[0][0]].stages[occ[0][1]]
        if st0.clean_trigger > 0 and st0.clean_time > 0:
            for k in range(st0.clean_trigger - 1, len(occ) - 1, st0.clean_trigger):
                cleans.append(_Clean(c, slot, st0.clean_time, st0.clean_recipe, "",
                                     "wac", after=occ[k], before=occ[k + 1]))
        # dummy-wac：dummy 清洁片跑完后、首个真实片前，插一次无片 wac
        docc = dummy_by_ch.get(c)
        if c in dwac_by_ch and docc:
            t, rec, task_name = dwac_by_ch[c]
            if t > 0:
                cleans.append(_Clean(c, slot, t, rec, task_name, "wac",
                                     after=docc[-1], before=occ[0]))
    return cleans