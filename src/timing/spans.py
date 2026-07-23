"""时长/间隙口径（与 milp.py 完全一致）：站内停留、机器手一跳耗时、loadlock 复用 setup、
机器手连续两操作间的切换间隙。

原名 → 新名（拆分重命名，纯改名不改逻辑）：
  _pdur     → _stage_dwell
  _L        → _hop_span
  _ll_setup → _ll_reuse_setup
  _gap      → _robot_switch_gap
"""

from __future__ import annotations

from src.parse.model import Durations, Problem

from ._common import SKIP_TYPES


def _ll_proc(task: Problem, chamber: str, ll_type: str) -> float:
    """返回 LoadLock 在指定腔室执行抽气或充气的时长。"""
    resource = task.chambers.get(chamber)
    if resource is None or ll_type not in {"entry", "exit"}:
        return 0.0
    duration = resource.pump_time if ll_type == "entry" else resource.vent_time
    return float(duration or 0.0)


def _stage_dwell(tm: Durations, w, j: int) -> float:
    """站内停留：place 关门 + 加工/抽充气 + pick 开门（s.proc 在 _expand 已置为 LL 的 pump/vent）。"""
    s = w.stages[j]
    pp = tm.place_post(s.in_robot, s.chamber) if s.in_robot else 0.0
    pre = tm.pick_pre(s.out_robot, s.chamber) if s.out_robot else 0.0
    return pp + s.proc + pre


def _hop_span(tm: Durations, w, j: int) -> float:
    """hop j→j+1 占机器手时长 = pick + move + place（门不占手）。"""
    rob = w.transports[j]
    return (tm.pick_t(rob, w.stages[j].chamber) + tm.move(rob)
            + tm.place_t(rob, w.stages[j + 1].chamber))


def _ll_reuse_setup(ir: Problem, prev_stage, nxt_stage) -> float:
    """同一LL再次可以使用时间间隔：
    - 上一次使用是ATR，当前使用ATR，则必须充气后才能使用
    - 上一次使用是VTR，当前使用VTR，则必须抽气后才能使用
    - 上一次使用是VTR(ATR)，当前使用ATR(VTR)，则必须时间间隔为零"""
    pt, nt = prev_stage.ll_type, nxt_stage.ll_type
    if not pt or not nt:
        return 0.0
    ch = ir.chambers.get(nxt_stage.chamber)
    if pt == "entry" and nt == "entry":
        return float((ch.vent_time if ch else 0.0) or 0.0)
    if pt == "exit" and nt == "exit":
        return float((ch.pump_time if ch else 0.0) or 0.0)
    return 0.0


def _robot_switch_gap(ir: Problem, tm: Durations, rob: str, wa, ja: int, wb, jb: int) -> float:
    """wa 的 hop 紧接 wb 的 hop 时机器手所需间隙：同一多槽 skip 站须关门+开门，否则 = 转位 move。"""
    dst, src = wa.stages[ja + 1].chamber, wb.stages[jb].chamber
    ch = ir.chambers.get(dst)
    if dst == src and ch and int(ch.capacity) > 1 and str(ch.type).lower() in SKIP_TYPES:
        return tm.place_post(rob, dst) + tm.pick_pre(rob, src)
    return tm.move(rob)
