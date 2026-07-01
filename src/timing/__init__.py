"""定时层（timing layer）：给定一个固定顺序，用差分约束图 + Bellman-Ford 求时刻。

设计见《调度实时重算优化方案》§3。要点：
  顺序固定后，模型里每条约束都退化成「动作 b 至少比动作 a 晚 w」即 t_b ≥ t_a + w，
  这是一条带权有向边。所有约束摆在一起就是一张图：
    · 求最早时刻 = 从源点求最长路（critical path）。
    · 驻留是「取出不能比放入晚太多」的【上界】，对应一条【往回指】的负权边。
    · 正环 = 绕一圈回到自己却要求它更早 = 该顺序在驻留下排不出来 → 报不可行。
  本层不含任何 0/1 变量，复杂度多项式（近 DAG，Bellman-Ford 几趟即收敛）。

顺序来自哪里：本包用一个「无死锁 backward 定序」(见 sequencing._sequence)——全局事件式构造，
一次产出彼此自洽的各资源占用序。面向单臂机器手：下游 hop 先于上游 hop（清空腔再装入），
并用 Banker 安全检查保证无死锁。定时引擎 solve_timing 与定序解耦——你也可以传入自己的
orders。

未建模（v1 已知缺口，命中时会打印告警）：
  · 多容量【加工】腔的门簇互斥 (Cd)。命中多容量非 skip 加工腔时 makespan 可能偏乐观。

用法：
    from src.timing import time_from_ir
    res = time_from_ir(task, verbose=True)       # res 是 SolveResult，且带 .feasible / .residency_violations
    issues = check_solution(task, res)           # 直接复用 milp 的独立复核

包内分层（原单文件 timing.py 按关注点拆分，行为不变，仅 4 个内部缩写名重命名 —— 详见各模块）：
    _common.py        公共常量/异常（EPS、SKIP_TYPES、_DecodeDeadlock）
    graph.py          差分约束图：Bellman-Ford 最长路 + 节点编号
    spans.py          时长/间隙口径（原 _pdur/_L/_gap/_ll_setup，已更名）
    sequencing.py      无死锁 backward 定序 + 可搜索候选解码器
    chambers.py        loadlock/加工腔分配寻优（portfolio + 贪心 + SA-ILS）
    solve.py           主入口 solve_timing：建图 + 求解
    search.py          关键路径瓶颈提取 + 占用序/选腔的 SA 寻优
    api.py             顶层封装 time_from_ir / optimize_from_ir
    policy_decode.py   BC 策略派工解码 time_from_policy

本模块把以上子模块的公开与内部名全部原样重导出，`from src.timing import <name>` 的行为与拆分前
完全一致（含 labels.py / features.py / scripts/probe_*.py 等直接引用的私有名）。
"""

from __future__ import annotations

from ._common import EPS, SKIP_TYPES, _DecodeDeadlock
from .graph import _Nodes, _bellman_ford_longest
from .spans import _hop_span, _ll_reuse_setup, _robot_switch_gap, _stage_dwell
from .sequencing import (
    _Cand,
    _Chooser,
    _DecodeState,
    _Orders,
    _blocked,
    _build_resource_map,
    _decode_orders,
    _drain_completes,
    _is_resid,
    _make_default_chooser,
    _reserve_for,
    _resource,
    _sequence,
    _skip_chambers,
    default_orders,
)
from .chambers import (
    _Genome,
    _apply_chamber_assign,
    _apply_ll_assign,
    _chamber_assign_events,
    _chamber_ils,
    _chamber_opt_budgets,
    _decode,
    _eval_chamber_assign,
    _eval_ll_assign,
    _joint_chamber_seeds,
    _ll_seed_assignments,
    _recompute_slots,
    optimize_chambers,
    optimize_loadlock,
)
from .solve import _fill_schedule, solve_timing
from .search import (
    _critical_resources,
    _eval_genome,
    _infeasible,
    _neighbor,
    optimize_orders,
)
from .api import _fixed_default, optimize_from_ir, time_from_ir
from .policy_decode import _greedy_chooser, _sampling_chooser, time_from_policy

__all__ = [
    "EPS", "SKIP_TYPES", "_DecodeDeadlock",
    "_bellman_ford_longest", "_Nodes",
    "_stage_dwell", "_hop_span", "_ll_reuse_setup", "_robot_switch_gap",
    "_skip_chambers", "_resource", "_Orders", "_Cand", "_DecodeState", "_Chooser",
    "_is_resid", "_reserve_for", "_blocked", "_build_resource_map", "_drain_completes",
    "_make_default_chooser", "_decode_orders", "_sequence", "default_orders",
    "_Genome", "_recompute_slots", "_apply_ll_assign", "_decode",
    "_ll_seed_assignments", "_eval_ll_assign", "optimize_loadlock",
    "_chamber_assign_events", "_apply_chamber_assign", "_eval_chamber_assign",
    "_joint_chamber_seeds", "optimize_chambers", "_chamber_opt_budgets", "_chamber_ils",
    "solve_timing", "_fill_schedule",
    "_critical_resources", "_infeasible", "_eval_genome", "_neighbor", "optimize_orders",
    "_fixed_default", "time_from_ir", "optimize_from_ir",
    "_greedy_chooser", "_sampling_chooser", "time_from_policy",
]
