"""求解器工作数据结构（取代旧 PreprocessedTask IR）。

解析（parse.parse_task）直接产出 Problem：拓扑（chambers/robots）+ 已展开的每片晶圆
（wafers，取代旧 milp._expand）+ 每 PM 前/后清洗（pre_clean/post_clean）。milp/timing/il
全路径只消费 Problem，不再有 Route/StageStep/PJob 持久 IR，也不再有二次展开。

Durations（原 milp._Timing）从 Problem 的 robots/chambers 取各动作时长（含开关门）；
接口（pick/place/move/pick_pre…）原样保留，features.py 里 state.tm 即 Durations 实例。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


# --------------------------------------------------------------------------- #
# 拓扑：机器手 / 腔室（仅保留求解器实际读取的字段）
# --------------------------------------------------------------------------- #
@dataclass
class Robot:
    name: str
    scope: List[str]
    capacity: int
    can_swap: bool
    pick_time: Dict[str, float] = field(default_factory=dict)
    place_time: Dict[str, float] = field(default_factory=dict)
    prep_trans_time: List[dict] = field(default_factory=list)


@dataclass
class Chamber:
    name: str
    type: str                                 # 原始 Station.Type（如 LoadLock/ProcessChamber/heater）
    capacity: int
    # None = 未显式给定（LL 走路线推断的抽/充气时长）；区分缺省与 0 是等价性关键
    pump_time: Optional[float] = None
    vent_time: Optional[float] = None
    # 门动作时长（key: robot）
    pick_prepare_time: Dict[str, float] = field(default_factory=dict)
    place_prepare_time: Dict[str, float] = field(default_factory=dict)
    pick_complete_time: Dict[str, float] = field(default_factory=dict)
    place_complete_time: Dict[str, float] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# 已展开的晶圆 stage 序列
# --------------------------------------------------------------------------- #
@dataclass
class Stage:
    j: int
    chamber: str
    stage_type: str          # source/loadlock/process/sink/...
    proc: float              # 停留时长（process 加工 / loadlock pump 或 vent / 其余 0）
    in_robot: str            # 进站搬运手（""=源）
    out_robot: str           # 出站搬运手（""=汇）
    residency: float         # 驻留上限，<0 无
    ll_type: str = ""        # loadlock: "entry"(进站抽气) / "exit"(出站充气)
    slot: int = 0            # 多容量腔(heater/cooler)按 round-robin 分配的槽位(0-based)
    clean_time: float = 0.0  # wac 无片清洗时长（0=无）
    clean_trigger: int = 0   # wac 触发片数（每 N 片）
    clean_recipe: str = ""
    cands: List[str] = field(default_factory=list)  # 候选腔（loadlock 放开 round-robin 时由 MILP 选）


@dataclass
class Wafer:
    wid: int                 # 全局唯一序号（= 加工/发片优先序）
    mat_id: int
    route_name: str
    route_rank: int          # 同 route 内第几片（0-based），供 round-robin / FIFO
    stages: List[Stage]
    transports: List[str]    # hop -> robot，长度 = len(stages)-1
    pjob_name: str = ""


# --------------------------------------------------------------------------- #
# 清洗规格（pre/post，按 (duration,recipe,task) 聚合多个 PM）
# --------------------------------------------------------------------------- #
@dataclass
class CleanSpec:
    visits: List[str]                        # PM 列表
    time: float
    recipe: str = ""
    task: str = ""


# --------------------------------------------------------------------------- #
# 求解输入容器（取代 PreprocessedTask）
# --------------------------------------------------------------------------- #
@dataclass
class Problem:
    chambers: Dict[str, Chamber]
    robots: Dict[str, Robot]
    wafers: List[Wafer]              # 已展开（取代 _expand）
    pre_clean: List[CleanSpec] = field(default_factory=list)   # 每 PM 前清洗
    post_clean: List[CleanSpec] = field(default_factory=list)  # 每 PM 后清洗
    # dummy-wac：dummy 清洁片跑完后、所属 job 首片真实晶圆前，在该 PM 追加一次无片 wac（time=empty_duration）。
    # dummy 清洁本身已作为合成 dummy 晶圆编码在 wafers 里；periodic wac 编码在 wafer.stages 的 clean_* 字段。
    dummy_wac: List[CleanSpec] = field(default_factory=list)
    # dummy 清洁 pjob 名 → 所属产品 pjob 名（milp_clean 用于把 dummy 段夹在 job 边界之间定序）
    dummy_owner: Dict[str, str] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# 动作时长（含开关门），从 Problem 的 robots/chambers 取
# --------------------------------------------------------------------------- #
class Durations:
    """从 Problem 取动作时长（含开关门）。原 milp._Timing。"""
    def __init__(self, problem: Problem):
        self.robots = problem.robots
        self.chambers = problem.chambers
        # 大气手 = scope 里含 loadport 类站点的手
        self.atm_robots = set()
        lp_types = {"loadport"}
        ch = self.chambers
        for rn, rb in self.robots.items():
            if any(str(ch[s].type).lower() in lp_types for s in rb.scope if s in ch):
                self.atm_robots.add(rn)

    # 机器手动作（仅占机器手，validator: MoveType 0/1/5）
    def pick_t(self, robot: str, c: str) -> float:
        rb = self.robots.get(robot)
        return float(rb.pick_time.get(c, 0.0)) if rb else 0.0

    def place_t(self, robot: str, c: str) -> float:
        rb = self.robots.get(robot)
        return float(rb.place_time.get(c, 0.0)) if rb else 0.0

    # 门动作（仅占站点，validator: MoveType 6/7；与机器手行程/加工可并行）
    def pick_pre(self, robot: str, c: str) -> float:    # pick 前开门
        ch = self.chambers.get(c)
        return float(ch.pick_prepare_time.get(robot, 0.0)) if ch else 0.0

    def pick_post(self, robot: str, c: str) -> float:   # pick 后关门
        ch = self.chambers.get(c)
        return float(ch.pick_complete_time.get(robot, 0.0)) if ch else 0.0

    def place_pre(self, robot: str, c: str) -> float:   # place 前开门
        ch = self.chambers.get(c)
        return float(ch.place_prepare_time.get(robot, 0.0)) if ch else 0.0

    def place_post(self, robot: str, c: str) -> float:  # place 后关门
        ch = self.chambers.get(c)
        return float(ch.place_complete_time.get(robot, 0.0)) if ch else 0.0

    # 占用窗口口径（含门）：pick=开门+pick+关门，place=开门+place+关门
    def pick(self, robot: str, c: str) -> float:
        return self.pick_pre(robot, c) + self.pick_t(robot, c) + self.pick_post(robot, c)

    def place(self, robot: str, c: str) -> float:
        return self.place_pre(robot, c) + self.place_t(robot, c) + self.place_post(robot, c)

    def move(self, robot: str) -> float:
        rb = self.robots.get(robot)
        if rb and rb.prep_trans_time:
            return float(rb.prep_trans_time[0].get("Time", 0.0))
        return 0.0
