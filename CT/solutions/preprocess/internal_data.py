from dataclasses import dataclass, field
from typing import List,Optional, Tuple, Dict, Union, Any

# --------------------------------------------------------------------------- #
# 类化 IR
# --------------------------------------------------------------------------- #
@dataclass
class PrePrepare:
    """LL 抽/充气时长。"""
    pump_time: float = 0.0
    vent_time: float = 0.0


@dataclass
class StageStep:
    """路径中的「站」步：源/汇/加工/buffer/cooler/loadlock。"""
    visits: List[str]                       # 候选 station
    stage_type: str                          # source/process/buffer/cooler/loadlock/sink
    time: float = 0.0                        # 加工时长（接口取自 ProcessRecipes[].Time）
    residual_time_limit: int = -1            # 驻留约束（每步单值），-1 无
    clean_time: int = 0                      # wac 清洗时长
    clean_trigger: int = 0                   # wac 触发片数
    clean_recipe: str = ""                   # movelist 输出用
    clean_task: str = ""
    preprepare_time: Optional[PrePrepare] = None


@dataclass
class TransportStep:
    """路径中的「传输」步：单台机器手搬运。"""
    visits: List[str]                        # 单元素 [robot]
    qtime_time_limit: int = -1

    @property
    def robot(self) -> str:
        return self.visits[0]

RouteStep = Union[StageStep, TransportStep]

@dataclass
class CleanSpec:
    """pre_clean / post_clean 单条（按 (duration,recipe,task) 聚合多个 PM）。"""
    visits: List[str]                        # PM 列表
    time: float
    recipe: str = ""
    task: str = ""


@dataclass
class DummyClean:
    """带片清洁记录：哪些腔室(visits)、清洁时长(time)、清洁配方/任务名（供 MoveList 输出），
    及是否紧接 dummy-wac 及其时长(wac_time，0 表示无）。"""
    visits: List[str]
    time: float = 0.0
    recipe: str = ""
    task: str = ""
    wac_time: float = 0.0                     # 片间不带片 wac（empty_duration），0 表示无


@dataclass
class Clean:
    pre_clean: List[CleanSpec] = field(default_factory=list)
    post_clean: List[CleanSpec] = field(default_factory=list)
    dummy_clean: Optional[DummyClean] = None


@dataclass
class Route:
    name: str
    steps: List[RouteStep]                    # StageStep / TransportStep 交织（偶=stage，奇=transport）
    clean: Clean = field(default_factory=Clean)
    group: str = ""
    is_dummy: bool = False

    def linearize(self) -> Tuple[List[Dict[str, Any]], List[str], List[int]]:
        """还原为 (stations, transports, transport_qtimes)——与 parse_route_steps 输出同构，
        供 build_net 后半段直接复用（保持构网逻辑等价）。"""
        stations: List[Dict[str, Any]] = []
        transports: List[str] = []
        qtimes: List[int] = []
        for step in self.steps:
            if isinstance(step, TransportStep):
                transports.append(step.robot)
                qtimes.append(int(step.qtime_time_limit))
                continue
            resid = int(step.residual_time_limit) if step.stage_type == "process" else -1
            stations.append({
                "candidates": list(step.visits),
                "stage_type": step.stage_type,
                "residency": {str(c): resid for c in step.visits},
                "process_time": float(step.time),
                "cleaning_duration": int(step.clean_time),
                "cleaning_trigger_wafers": int(step.clean_trigger),
            })
        return stations, transports, qtimes


@dataclass
class Robot:
    name: str
    scope: List[str]
    capacity: int
    can_swap: bool
    initial_chamber: str = ""
    pick_time: Dict[str, float] = field(default_factory=dict)
    place_time: Dict[str, float] = field(default_factory=dict)
    swap_time: float = 0.0
    prep_trans_time: List[dict] = field(default_factory=list)
    arms: List[str] = field(default_factory=lambda: ["ArmA"])   # ArmInfo 名（trace 臂跟踪用）


@dataclass
class Chamber:
    name: str
    type: str                                 # 原始 Station.Type（如 LoadLock/ProcessChamber/heater）
    capacity: int
    physical_capacity: int
    # None = 未显式给定（LL 走路线推断的抽/充气时长）；区分缺省与 0 是等价性关键
    pump_time: Optional[float] = None
    vent_time: Optional[float] = None
    # 原 IStation 门动作时长（key: robot）
    pick_prepare_time: Dict[str, float] = field(default_factory=dict)
    place_prepare_time: Dict[str, float] = field(default_factory=dict)
    pick_complete_time: Dict[str, float] = field(default_factory=dict)
    place_complete_time: Dict[str, float] = field(default_factory=dict)
    post_complete_time: Dict[str, float] = field(default_factory=dict)


@dataclass
class PJob:
    global_pjob_idx: int
    cjob_idx: int
    name: str
    priority: int
    route_name: str
    load_port: str
    material_ids: List[int]
    material_count: int
    is_dummy: bool = False


@dataclass
class CJob:
    cjob_idx: int
    task_id: str
    job_type: int
    priority: int
    pjob_names: List[str]
    material_count: int


@dataclass
class PreprocessedTask:
    scenario: int
    robots: Dict[str, Robot]
    chambers: Dict[str, Chamber]
    routes: Dict[str, Route]
    route_order: List[str]
    route_idx_by_name: Dict[str, int]
    pjobs: List[PJob]
    cjobs: List[CJob]
    takt_by_pjob: Dict[int, List[float]]
    # 每片精简模板（ID→TaskID/PJobName），供 trace 输出 MoveList 反查（替代 task_payload.Materials）
    materials: List[Dict[str, Any]] = field(default_factory=list)
    dual_view: Optional[dict] = None
    warm_start: Optional[dict] = None         # ★运行态快照（随每次 update 变）