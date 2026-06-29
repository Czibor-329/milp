from collections import deque
from dataclasses import dataclass, field
from time import process_time
from typing import Callable, Deque, List, Mapping, Optional, Tuple, Dict, Any
import numpy as np

from dataclasses import dataclass, field


# Place 类型枚举（station 6 类 + robot）。
PROCESS = 1   # 加工腔室（PM*）
LOADLOCK = 2  # 真空所（LLA/LLB，需 pump/vent）
LOADPORT = 3  # LP（既作为 source，也作为 sink）
BUFFER = 4    # 真空区缓冲（BufA/BufB）
ALIGN = 5     # 对齐模块（AL）
COOLER = 6    # 冷却模块（CL）
ROBOT = 7     # 机械手（TM1/TM2/TM3）


@dataclass(slots=True)
class BasedToken:
    enter_time: float = 0.0
    stay_time: float = 0.0
    token_id: int = -1
    route_type: int = 1
    cjob_idx: int = 0
    pjob_idx: int = -1
    subpath_name: str = ""
    route_queue: Tuple[Tuple[int, ...], ...] = ()
    route_proc_time_queue: Tuple[float, ...] = ()
    route_limit_queue: Tuple[Any, ...] = ()
    # 清洗参数随 token 走（状态留 place）：{pm_name: (wac_duration, wac_trigger, dummy_empty)}。
    # 按腔室取值，全局（只读）共享一份；place 仅累计运行态计数。
    clean_by_pm: Dict[str, Tuple[int, int, int]] = field(default_factory=dict)
    route_head_idx: int = 0
    last_transition_code: int = -1
    scrapped_by_failure: bool = False
    skip_processing: bool = False
    is_dummy: bool = False
    dummy_kind: str = ""

    def color(self) -> Tuple[int, ...]:
        if self.route_head_idx < 0 or self.route_head_idx >= len(self.route_queue):
            return ()
        gate = self.route_queue[self.route_head_idx]
        if isinstance(gate, int):
            return (int(gate),)
        return tuple(int(code) for code in gate)

    def clone(self):
        return BasedToken(
            enter_time=self.enter_time,
            stay_time=self.stay_time,
            token_id=self.token_id,
            route_type=int(self.route_type),
            cjob_idx=int(self.cjob_idx),
            pjob_idx=int(self.pjob_idx),
            subpath_name=str(self.subpath_name),
            route_queue=tuple(self.route_queue),
            route_proc_time_queue=tuple(self.route_proc_time_queue),
            route_limit_queue=tuple(self.route_limit_queue),
            clean_by_pm=self.clean_by_pm,
            route_head_idx=int(self.route_head_idx),
            last_transition_code=int(self.last_transition_code),
            scrapped_by_failure=bool(self.scrapped_by_failure),
            skip_processing=bool(self.skip_processing),
            is_dummy=bool(self.is_dummy),
            dummy_kind=str(getattr(self, "dummy_kind", "")),
        )

    def current_limit(self) -> int:
        idx = int(self.route_head_idx) - 1
        if idx < 0 or idx >= len(self.route_limit_queue):
            return -1
        entry = self.route_limit_queue[idx]
        if isinstance(entry, Mapping):
            return int(entry.get(int(self.last_transition_code), -1))
        if isinstance(entry, (int, float)):
            return int(entry)
        return -1

    def to_visual_dict(
        self,
        *,
        place_name: str,
        place_idx: int,
        place_type: int,
        proc_time: float,
        time_to_scrap: float,
    ) -> Dict[str, Any]:
        return {
            "tokenId": int(self.token_id),
            "placeName": str(place_name),
            "placeIdx": int(place_idx),
            "placeType": int(place_type),
            "stayTime": float(self.stay_time),
            "procTime": float(proc_time),
            "timeToScrap": float(time_to_scrap),
            "step": int(self.route_head_idx),
            "scrappedByFailure": bool(self.scrapped_by_failure),
            "isDummy": bool(self.is_dummy),
            "dummyKind": str(getattr(self, "dummy_kind", "")),
        }

    # 默认撤离终点（仅旧测试/单 LP 场景使用）。多 LP 时通过 evacuation_sink 参数注入。
    _DEFAULT_EVAC_SINK: str = "LP"

    @staticmethod
    def _failure_evacuation_targets(place_name: str, evac_sink: Optional[str] = None) -> Tuple[str, ...]:
        """PM 故障撤离硬编码路径；返回从当前 place 开始的后续目标序列。"""
        name = str(place_name)
        sink = str(evac_sink or BasedToken._DEFAULT_EVAC_SINK)
        if name.startswith("LP"):
            return ()
        if name == "LLB":
            return (sink,)
        if name in {"TM1", "AL", "CL"}:
            return (sink,)
        if name in {"PM7", "PM8", "PM9", "PM10", "TM2", "LLA"}:
            return ("LLB", sink)
        if name == "BufB":
            return ("LLB", sink)
        if name in {"PM1", "PM2", "PM3", "PM4", "PM5", "PM6", "TM3", "BufA"}:
            return ("BufB", "LLB", sink)
        return ()

    def rewrite_color_queue(
        self,
        place_name: str,
        *,
        transition_code_by_name: Optional[Mapping[str, int]] = None,
        transport_by_source_target: Optional[Mapping[Tuple[str, str], str]] = None,
        fallback_transport: Optional[Callable[[str, str], Optional[str]]] = None,
        evac_sink: Optional[str] = None,
    ) -> bool:
        """按硬编码撤离语义重写 route_queue（撤离段不施加驻留/运输限制）。"""
        targets = BasedToken._failure_evacuation_targets(place_name, evac_sink=evac_sink)
        if not targets:
            return False

        def transition_code(transition_name: str) -> int:
            if transition_code_by_name is None:
                raise RuntimeError("transition_code_by_name is required for route color rewrite")
            code = int(transition_code_by_name.get(str(transition_name), -1))
            if code <= 0:
                raise RuntimeError(f"missing route color for transition {transition_name}")
            return code

        source = str(place_name)
        source_is_transport = source in {"TM1", "TM2", "TM3"}
        route_prefix = list(
            tuple(getattr(self, "route_queue", ()) or ())[: int(self.route_head_idx)]
        )
        route_suffix: List[Tuple[int, ...]] = []
        for idx, target in enumerate(targets):
            target_name = str(target)
            if idx == 0 and source_is_transport:
                transport = source
                route_suffix.append((transition_code(f"t_{transport}_{target_name}"),))
            else:
                transport = None
                if fallback_transport is not None:
                    transport = fallback_transport(source, target_name)
                if transport is None and transport_by_source_target is not None:
                    transport = transport_by_source_target.get((source, target_name))
                if transport is None:
                    raise RuntimeError(f"missing evacuation transport for {source}->{target_name}")
                route_suffix.append((transition_code(f"u_{source}_{transport}"),))
                route_suffix.append((transition_code(f"t_{transport}_{target_name}"),))
            source = target_name
        self.route_queue = tuple(route_prefix + route_suffix)
        limit_prefix = list(tuple(getattr(self, "route_limit_queue", ()) or ())[: int(self.route_head_idx)])
        self.route_limit_queue = tuple(limit_prefix + [-1] * len(route_suffix))
        return True


@dataclass(slots=True)
class TransitionInfo:
    """变迁静态描述：封装单条变迁的拓扑与颜色信息。"""
    idx: int                # 在 id2t_name 中的索引（= mask 向量位置）
    name: str               # e.g. "t_TM2_PM7", "u_PM1_TM2"
    kind: str               # "t" 或 "u"
    pre_place_idx: int      # 前置库所索引
    pst_place_idx: int      # 后置库所索引
    pre_place_name: str     # e.g. "TM2"（t_* 的运输位）或 "PM1"（u_* 的源腔室）
    pst_place_name: str     # e.g. "PM7"（t_* 的目标腔室）或 "TM2"（u_* 的运输位）
    color_code: object      # u_*/t_*: int 变迁颜色编号；缺省 -1
    target_place: str       # t_*: 目标腔室名；u_*: ""
    transport: str          # 所属 TM（"TM1"/"TM2"/"TM3"）
    action_time: float = 0.0
    swap_time: float = 0.0
    use_count: int = 0


@dataclass(slots=True)
class ActionCacheEntry:
    """get_action_mask() 中缓存的单条动作元数据，供 step/fire 复用。"""
    t_idx: int
    is_swap: bool
    duration: float                 # 动作本身的时长（action_time 或 swap_time），不含前置等待
    fire_time: float                # 动作实际发射时刻 = mask 时刻 self.time + extra_wait
    token_id: int                   # 被移动的晶圆 (pre_place head)
    swapped_token_id: int = -1      # swap 时被换出的晶圆 (pst_place head), 否则 -1
    # 本动作触发的旋转量（transport_time[from->to]），驱动 _fire 还原 prepare 区间
    prepare_delta: float = 0.0


@dataclass(slots=True)
class Place:
    """
    Petri 网库所。

    属性说明：
    - name: 库所名称
    - capacity: 容量
    - processing_time: 加工时间（库所驻留时间）
    - type:
        1=PROCESS  加工腔室（PM*，有驻留约束）
        2=LOADLOCK 真空所（LLA/LLB，pump/vent）
        3=LOADPORT LP（同时作为 source / sink）
        4=BUFFER   真空区缓冲（BufA/BufB）
        5=ALIGN    对齐模块（AL）
        6=COOLER   冷却模块（CL）
        7=ROBOT    机械手（TM*）
    - tokens: token 队列（FIFO）
    - last_machine: 上次分配的机器编号（type=PROCESS 使用）
    """
    name: str
    capacity: int
    processing_time: float
    type: int
    tokens: Deque[BasedToken] = field(default_factory=deque)
    last_machine: int = -1
    processed_wafer_count: int = 0
    idle_time: int = 0
    last_proc_type: str = ""
    last_wafer_id: int = -1
    is_cleaning: bool = False
    cleaning_remaining: int = 0
    cleaning_reason: str = ""
    is_pm: bool = field(init=False, default=False)
    is_dtm: bool = field(init=False, default=False)
    is_failure: bool = False
    should_remove: bool = False
    base_processing_time: float = 0.0
    process_time_extra: float = 0.0
    station_times: Dict[str, Dict[str, float]] = field(default_factory=dict)
    # 按 route_type 区分的加工时间（已含门动作 extra）；为空时回退到 processing_time。
    process_time_by_route: Dict[int, float] = field(default_factory=dict)
    cleaning_duration: int = 0
    cleaning_trigger_wafers: int = 0
    # 清洁元数据（供 Movelist 输出 recipe/task 名与 Pre/PostClean 执行）：
    #   {"wac": {recipe, task}, "pre": {duration, recipe, task}, "post": {duration, recipe, task}}
    clean_meta: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        self.is_pm = self.name.startswith("PM")
        self.is_dtm = self.name.startswith("d_TM")
        if self.base_processing_time <= 0.0:
            self.base_processing_time = float(self.processing_time) - float(self.process_time_extra)

    def clone(self) -> "Place":
        cloned = Place(
            name=self.name,
            capacity=self.capacity,
            processing_time=self.processing_time,
            type=self.type,
            last_machine=self.last_machine,
            processed_wafer_count=self.processed_wafer_count,
            idle_time=self.idle_time,
            last_proc_type=self.last_proc_type,
            last_wafer_id=self.last_wafer_id,
            is_cleaning=self.is_cleaning,
            cleaning_remaining=self.cleaning_remaining,
            cleaning_reason=self.cleaning_reason,
            base_processing_time=self.base_processing_time,
            process_time_extra=self.process_time_extra,
            station_times={k: dict(v) for k, v in self.station_times.items()},
            process_time_by_route=dict(self.process_time_by_route),
            cleaning_duration=self.cleaning_duration,
            cleaning_trigger_wafers=self.cleaning_trigger_wafers,
            clean_meta={k: dict(v) for k, v in self.clean_meta.items()},
        )
        cloned.tokens = deque(tok.clone() for tok in self.tokens)
        return cloned

    def station_time(self, robot: str, field: str) -> float:
        return float(self.station_times[str(robot)][str(field)])

    def processing_time_for_base(self, base_proc_time: float) -> float:
        return float(base_proc_time) + float(self.process_time_extra)

    def head(self) -> BasedToken:
        return self.tokens[0]

    def pop_head(self) -> BasedToken:
        return self.tokens.popleft()

    def append(self, token: BasedToken) -> None:
        self.tokens.append(token)

    def res_time(self, current_time: float) -> float:
        """返回当前库所内wafer的剩余超时时间（示例逻辑，和你的原实现一致）"""
        if len(self.tokens) == 0:
            return 10**5
        else:
            tok_limit = int(self.head().current_limit())
            if tok_limit < 0:
                return 10**5
            if self.type == PROCESS:  # process chamber
                res_time = self.head().enter_time + self.processing_time + tok_limit - current_time
            elif self.type == ROBOT:  # transport place
                res_time = self.head().enter_time + 5 + tok_limit - current_time
            else:
                return 10**5
            return -1.0 if res_time < 0 else float(res_time)

    def __len__(self) -> int:
        return len(self.tokens)

    def get_obs(self) -> List[float]:
        """默认返回空列表；子类 PM/TM/LL/SR 覆写以返回各自特征。"""
        return []

    def get_obs_dim(self) -> int:
        """返回观测向量维度；子类继承即可，基于 get_obs 长度。"""
        return len(self.get_obs())

    def write_obs(self, buffer: np.ndarray, offset: int) -> int:
        """
        将本库所观测原地写入预分配 buffer。
        返回写入长度；默认走 get_obs 兼容路径。
        """
        values = self.get_obs()
        length = len(values)
        if length <= 0:
            return 0
        buffer[offset: offset + length] = values
        return length

    def write_obs_fast(self, buffer: np.ndarray, offset: int) -> int:
        """Pre-zeroed buffer variant; subclasses override for speed."""
        return self.write_obs(buffer, offset)

    @staticmethod
    def _is_transport_place_name(name: str) -> bool:
        raw = str(name)
        return raw.startswith("d_TM") or raw in {"TM1", "TM2", "TM3"}

    @staticmethod
    def _normalize_transport_name(name: str) -> str:
        raw = str(name)
        if raw.endswith("TM1"):
            return "TM1"
        if raw.endswith("TM2"):
            return "TM2"
        if raw.endswith("TM3"):
            return "TM3"
        return raw

    @staticmethod
    def _is_start_buffer_name(name: str) -> bool:
        raw = str(name)
        return raw.startswith("LP")

    @staticmethod
    def _is_end_buffer_name(name: str) -> bool:
        # 多 LP 拓扑下 source == sink，统一视为 start buffer；
        # 完成状态由 viewmodel 用 route_head_idx 判定。
        return False

    def _visual_chamber_type(self) -> str:
        if self._is_transport_place_name(self.name):
            return "transport"
        if self._is_start_buffer_name(self.name):
            return "start"
        if self._is_end_buffer_name(self.name):
            return "end"
        return "processing"

    def _proc_time_for_token(self, token: BasedToken) -> float:
        """按 token 逐段加工时间取本库所驻留时长；门 extra 取自库所，缺失/0 回退 processing_time。"""
        q = getattr(token, "route_proc_time_queue", ()) or ()
        h = int(getattr(token, "route_head_idx", 0))
        if q and 0 <= h < len(q):
            base = float(q[h])
            if base > 0.0:
                return base + float(getattr(self, "process_time_extra", 0.0) or 0.0)
        return float(getattr(self, "processing_time", 0))

    def _time_to_scrap(self, token: BasedToken) -> float:
        stay_time = float(getattr(token, "stay_time", 0))
        proc_time = self._proc_time_for_token(token)
        limit = int(token.current_limit())
        if limit < 0:
            return -1.0
        if int(self.type) == PROCESS:
            return float(proc_time + float(limit) - stay_time)
        if int(self.type) == BUFFER and str(self.name) in {"BufA", "BufB"}:
            return float(proc_time + float(limit) * 3.0 - stay_time)
        if int(self.type) == ROBOT or self._is_transport_place_name(self.name):
            return float(float(limit) - stay_time)
        return -1.0

    def _collect_visual_wafers(
        self,
        *,
        place_idx: int,
    ) -> List[Dict[str, Any]]:
        wafers: List[Dict[str, Any]] = []
        for token in self.tokens:
            if self._is_start_buffer_name(self.name) and token.route_head_idx != 0:
                continue
            token_id = int(getattr(token, "token_id", -1))
            if token_id < 0 and not bool(getattr(token, "is_dummy", False)):
                continue
            wafers.append(
                token.to_visual_dict(
                    place_name=str(self.name),
                    place_idx=int(place_idx),
                    place_type=int(self.type),
                    proc_time=self._proc_time_for_token(token),
                    time_to_scrap=self._time_to_scrap(token),
                )
            )
        return wafers

    def _visual_status(self, *, wafers: List[Dict[str, Any]], chamber_type: str) -> str:
        if bool(getattr(self, "is_cleaning", False)):
            return "cleaning"
        if not wafers:
            return "idle"
        if chamber_type == "transport":
            return "active"
        deadlines = [
            float(wafer.get("timeToScrap", -1))
            for wafer in wafers
            if float(wafer.get("timeToScrap", -1)) >= 0
        ]
        min_time_to_scrap = min(deadlines, default=9999.0)
        if min_time_to_scrap <= 0:
            return "danger"
        if min_time_to_scrap <= 5:
            return "warning"
        return "active"

    def to_visual_dict(
        self,
        *,
        place_idx: int,
        cleaning_trigger: int = 0,
        display_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        chamber_type = self._visual_chamber_type()
        wafers = self._collect_visual_wafers(
            place_idx=int(place_idx),
        )
        trigger = int(cleaning_trigger)
        cleaning_countdown = -1
        if trigger > 0:
            processed = int(getattr(self, "processed_wafer_count", 0))
            cleaning_countdown = max(0, trigger - processed)
        return {
            "name": str(display_name or self._normalize_transport_name(self.name)),
            "sourceName": str(self.name),
            "placeIdx": int(place_idx),
            "capacity": int(self.capacity),
            "wafers": wafers,
            "procTime": float(getattr(self, "processing_time", 0)),
            "baseProcTime": float(getattr(self, "base_processing_time", 0.0)),
            "doorTime": float(getattr(self, "process_time_extra", 0.0)),
            "status": self._visual_status(wafers=wafers, chamber_type=chamber_type),
            "chamberType": chamber_type,
            "cleaningRemaining": float(getattr(self, "cleaning_remaining", 0.0)),
            "inboundBlocked": bool(getattr(self, "is_cleaning", False)),
            "cleaningWaferCountdown": int(cleaning_countdown),
        }


# ---------- Place 子类（单设备观测用）----------
# SR=Source, TM=Transport, PM=Process Module, LL=Load Lock


class SR(Place):
    """源/汇聚库所（LP*），返回 1 维 remaining_norm。"""
    __slots__ = ('_n_wafer', '_inv_n_wafer', '_n_routes')

    def __init__(self, name: str, capacity: int, processing_time: float, type: int = LOADPORT, n_wafer: int = 1,
                 n_routes: int = 1, **kwargs):
        super().__init__(name=name, capacity=capacity, processing_time=processing_time, type=type, **kwargs)
        self._n_wafer = max(1, n_wafer)
        self._inv_n_wafer = 1.0 / float(self._n_wafer)
        self._n_routes = max(1, int(n_routes))

    def get_obs(self) -> List[float]:
        obs_dim = self.get_obs_dim()
        if obs_dim == 0:
            return []
        out = np.zeros(obs_dim, dtype=np.float32)
        self.write_obs(out, 0)
        return out.tolist()

    def get_obs_dim(self) -> int:
        return 1

    def write_obs(self, buffer: np.ndarray, offset: int) -> int:
        unprocessed = sum(1 for tok in self.tokens if tok.route_head_idx == 0)
        remaining_norm = float(unprocessed) * self._inv_n_wafer
        if remaining_norm < 0.0:
            remaining_norm = 0.0
        elif remaining_norm > 1.0:
            remaining_norm = 1.0
        buffer[offset] = remaining_norm
        return 1

    write_obs_fast = write_obs

    def clone(self) -> "SR":
        cloned = SR(
            name=self.name,
            capacity=self.capacity,
            processing_time=self.processing_time,
            type=self.type,
            n_wafer=self._n_wafer,
            n_routes=self._n_routes,
            last_machine=self.last_machine,
            processed_wafer_count=self.processed_wafer_count,
            idle_time=self.idle_time,
            last_proc_type=self.last_proc_type,
            last_wafer_id=self.last_wafer_id,
            is_cleaning=self.is_cleaning,
            cleaning_remaining=self.cleaning_remaining,
            cleaning_reason=self.cleaning_reason,
            base_processing_time=self.base_processing_time,
            process_time_extra=self.process_time_extra,
            station_times={k: dict(v) for k, v in self.station_times.items()},
            process_time_by_route=dict(self.process_time_by_route),
        )
        cloned.tokens = deque(tok.clone() for tok in self.tokens)
        return cloned


class TM(Place):
    """运输位（d_TM1/d_TM2/d_TM3），返回 4 维时间 + binary_dim 维去向 + 1 维 route_type。"""
    __slots__ = (
        '_D_Residual_time', '_color_binary_map', '_binary_dim', '_obs_dim',
        '_last_chamber', '_last_use_end', '_n_routes', '_inv_n_routes',
    )

    def __init__(
        self,
        name: str,
        capacity: int,
        processing_time: float,
        type: int = ROBOT,
        D_Residual_time: int = 20,
        color_binary_map: Optional[Dict[int, int]] = None,
        binary_dim: int = 4,
        last_chamber: Optional[str] = None,
        last_use_end: float = 0.0,
        n_routes: int = 1,
        **kwargs,
    ):
        super().__init__(name=name, capacity=capacity, processing_time=processing_time, type=type, **kwargs)
        self._D_Residual_time = max(1, D_Residual_time)
        self._color_binary_map = {int(k): int(v) for k, v in dict(color_binary_map or {}).items()}
        self._binary_dim = max(1, binary_dim)
        self._n_routes = max(1, int(n_routes))
        self._inv_n_routes = 1.0 / float(self._n_routes)
        self._obs_dim = 4 + self._binary_dim + 1
        # 机器手朝向感知：上次接触的腔室名 + 上次动作结束时刻（构网时按 managed_chambers[0] 注入）
        self._last_chamber: Optional[str] = last_chamber
        self._last_use_end: float = float(last_use_end)

    def get_obs(self) -> List[float]:
        out = np.zeros(self._obs_dim, dtype=np.float32)
        self.write_obs(out, 0)
        return out.tolist()

    def get_obs_dim(self) -> int:
        return self._obs_dim

    def write_obs(self, buffer: np.ndarray, offset: int) -> int:
        obs_dim = self._obs_dim
        buffer[offset:offset + obs_dim] = 0.0
        return self._write_obs_inner(buffer, offset, obs_dim)

    def write_obs_fast(self, buffer: np.ndarray, offset: int) -> int:
        return self._write_obs_inner(buffer, offset, self._obs_dim)

    def _write_obs_inner(self, buffer: np.ndarray, offset: int, obs_dim: int) -> int:
        """
        ready_for_pick, 是否准备好被取走（驻留时间 >= 加工时间）
        over_penalty, 是否已经过了惩罚时间（驻留时间 > D_Residual_time）
        stay_time_norm, 驻留时间占两倍惩罚时间的比例（0-1，超过惩罚时间部分不增加）
        has_wafer, 是否有晶圆
        [4..4+binary_dim), 目标去向的二进制编码（LSB优先，0=无目标）
        """
        penalty_time = float(self._D_Residual_time)
        dwell_time = float(self.processing_time) if self.processing_time > 0 else 1.0

        tokens = self.tokens
        if len(tokens) == 0:
            buffer[offset + 3] = 1.0
            return obs_dim

        head = tokens[0]
        stay_time = float(head.stay_time)
        token_limit = int(head.current_limit())
        if token_limit >= 0:
            penalty_time = float(token_limit)
        buffer[offset] = 1.0 if stay_time >= dwell_time else 0.0
        buffer[offset + 1] = 1.0 if stay_time > penalty_time else 0.0

        tm_norm_denom = max(dwell_time, penalty_time) * 2.0
        max_stay_norm = stay_time / tm_norm_denom if tm_norm_denom > 0.0 else 0.0
        if max_stay_norm < 0.0:
            max_stay_norm = 0.0
        elif max_stay_norm > 1.0:
            max_stay_norm = 1.0
        buffer[offset + 2] = max_stay_norm

        distance_to_penalty = penalty_time - stay_time
        if distance_to_penalty < 0.0:
            distance_to_penalty = 0.0
        min_distance_norm = distance_to_penalty / penalty_time
        if min_distance_norm > 1.0:
            min_distance_norm = 1.0
        buffer[offset + 3] = min_distance_norm

        color_gate = head.color()
        color_code = int(color_gate[0]) if color_gate else 0
        idx = self._color_binary_map.get(color_code, 0)
        if idx > 0:
            binary_dim = self._binary_dim
            for bit in range(binary_dim):
                buffer[offset + 4 + bit] = float((idx >> bit) & 1)
        buffer[offset + 4 + self._binary_dim] = float(int(head.route_type)) * self._inv_n_routes
        return obs_dim

    def clone(self) -> "TM":
        cloned = TM(
            name=self.name,
            capacity=self.capacity,
            processing_time=self.processing_time,
            type=self.type,
            D_Residual_time=self._D_Residual_time,
            color_binary_map=dict(self._color_binary_map),
            binary_dim=self._binary_dim,
            n_routes=self._n_routes,
            last_machine=self.last_machine,
            last_chamber=self._last_chamber,
            last_use_end=self._last_use_end,
            base_processing_time=self.base_processing_time,
            process_time_extra=self.process_time_extra,
            station_times={k: dict(v) for k, v in self.station_times.items()},
            process_time_by_route=dict(self.process_time_by_route),
        )
        cloned.tokens = deque(tok.clone() for tok in self.tokens)
        return cloned


class PM(Place):
    """加工腔室（PM1/PM3/PM4/PM6 等），返回 6 或 9 维特征（取决于 cleaning_enabled）。"""
    __slots__ = (
        '_P_Residual_time', '_cleaning_duration', '_cleaning_trigger_wafers',
        '_scrap_clip_threshold', '_inv_cleaning_duration', '_inv_cleaning_trigger',
        '_inv_scrap_clip', '_obs_dim', '_cleaning_enabled',
        '_n_routes', '_inv_n_routes',
        # per-PJob 清洁状态（需求：清洁绑定每个 PJob 的首/末片，wac 计数按 PJob 分桶）
        'pre_cleaned_pjobs', 'postcleaned_pjobs', 'processed_pjobs',
        'processed_count_by_pjob', 'pending_cleans', 'cleaning_pjob',
    )

    def __init__(
        self,
        name: str,
        capacity: int,
        processing_time: float,
        type: int = PROCESS,
        P_Residual_time: int = 15,
        cleaning_duration: int = 150,
        cleaning_trigger_wafers: int = 5,
        scrap_clip_threshold: float = 20.0,
        n_routes: int = 1,
        pre_cleaned_pjobs: Optional[set] = None,
        postcleaned_pjobs: Optional[set] = None,
        processed_pjobs: Optional[set] = None,
        processed_count_by_pjob: Optional[Dict[int, int]] = None,
        pending_cleans: Optional[List] = None,
        cleaning_pjob: int = -1,
        **kwargs,
    ):
        super().__init__(name=name, capacity=capacity, processing_time=processing_time, type=type,
                         cleaning_duration=cleaning_duration, cleaning_trigger_wafers=cleaning_trigger_wafers,
                         **kwargs)
        self.pre_cleaned_pjobs = set(pre_cleaned_pjobs or ())
        self.postcleaned_pjobs = set(postcleaned_pjobs or ())
        self.processed_pjobs = set(processed_pjobs or ())
        self.processed_count_by_pjob = dict(processed_count_by_pjob or {})
        # 排队中的清洁请求：[(rule, duration, pjob_idx), ...]，腔室空闲时依次执行
        self.pending_cleans = list(pending_cleans or [])
        self.cleaning_pjob = int(cleaning_pjob)
        self._P_Residual_time = max(1, P_Residual_time)
        # 真值保持原样（0 = 不触发清洗）；归一化分母另行钳到 ≥1 防除零。
        self._cleaning_duration = int(cleaning_duration)
        self._cleaning_trigger_wafers = int(cleaning_trigger_wafers)
        self._scrap_clip_threshold = max(1.0, scrap_clip_threshold)
        self._inv_cleaning_duration = 1.0 / float(max(1, self._cleaning_duration))
        self._inv_cleaning_trigger = 1.0 / float(max(1, self._cleaning_trigger_wafers))
        self._inv_scrap_clip = 1.0 / float(self._scrap_clip_threshold)
        self._n_routes = max(1, int(n_routes))
        self._inv_n_routes = 1.0 / float(self._n_routes)
        self._obs_dim = 10

    def get_obs(self) -> List[float]:
        out = np.zeros(self._obs_dim, dtype=np.float32)
        self.write_obs(out, 0)
        return out.tolist()

    def get_obs_dim(self) -> int:
        return self._obs_dim

    def write_obs(self, buffer: np.ndarray, offset: int) -> int:
        buffer[offset:offset + self._obs_dim] = 0.0
        return self._write_obs_inner(buffer, offset)

    def write_obs_fast(self, buffer: np.ndarray, offset: int) -> int:
        return self._write_obs_inner(buffer, offset)

    def _write_obs_inner(self, buffer: np.ndarray, offset: int) -> int:
        """
        has_wafer, 是否有晶圆
        is_processing, 是否正在加工（驻留时间 < 加工时间）
        ready_for_pick, 是否加工完成（驻留时间 >= 加工时间）
        remaining_process_time_norm, 加工剩余时间占加工时间的比例（0-1)
        wafer_stay_time_norm, 晶圆驻留时间占加工时间的比例（0-1）
        time_to_scrap_norm, 距离报废的时间占 scrap_clip_threshold 的比例
        is_cleaning, 是否正在清洗
        cleaning_remaining_time_norm, 清洗剩余时间占清洗总时间的比例（0-1）
        near_cleaning_norm, 离清洗触发次数的程度（0-1，基于 cleaning_trigger_wafers 的差距计算
        """
        tokens = self.tokens
        has_wafer = len(tokens) > 0
        buffer[offset] = 1.0 if has_wafer else 0.0
        proc_time = float(self.processing_time) if self.processing_time > 0 else 1.0
        p_residual = float(self._P_Residual_time)

        if has_wafer:
            head = tokens[0]
            stay_time = float(head.stay_time)
            token_limit = int(head.current_limit())
            if token_limit >= 0:
                p_residual = float(token_limit)
            is_processing = stay_time < proc_time
            buffer[offset + 1] = 1.0 if is_processing else 0.0
            buffer[offset + 2] = 0.0 if is_processing else 1.0

            remaining_proc = proc_time - stay_time
            if remaining_proc < 0.0:
                remaining_proc = 0.0
            remaining_process_time_norm = remaining_proc / proc_time
            if remaining_process_time_norm > 1.0:
                remaining_process_time_norm = 1.0
            buffer[offset + 3] = remaining_process_time_norm

            wafer_stay_time_norm = stay_time / proc_time
            if wafer_stay_time_norm < 0.0:
                wafer_stay_time_norm = 0.0
            elif wafer_stay_time_norm > 1.0:
                wafer_stay_time_norm = 1.0
            buffer[offset + 4] = wafer_stay_time_norm

            time_to_scrap = proc_time + p_residual - stay_time
            if time_to_scrap < 0.0:
                time_to_scrap = 0.0
            elif time_to_scrap > self._scrap_clip_threshold:
                time_to_scrap = self._scrap_clip_threshold
            buffer[offset + 5] = time_to_scrap * self._inv_scrap_clip

        if has_wafer:
            head_route = float(int(tokens[0].route_type)) * self._inv_n_routes
        else:
            head_route = 0.0

        buffer[offset + 6] = 1.0 if self.is_cleaning else 0.0
        clean_remaining = float(self.cleaning_remaining)
        if clean_remaining < 0.0:
            clean_remaining = 0.0
        clean_remaining_time_norm = clean_remaining * self._inv_cleaning_duration
        if clean_remaining_time_norm > 1.0:
            clean_remaining_time_norm = 1.0
        buffer[offset + 7] = clean_remaining_time_norm

        trigger_wafers = float(self._cleaning_trigger_wafers)
        if trigger_wafers < 1.0:
            trigger_wafers = 1.0
        processed_count = float(self.processed_wafer_count)
        if processed_count < 0.0:
            processed_count = 0.0
        remaining_runs = trigger_wafers - processed_count
        if remaining_runs < 0.0:
            remaining_runs = 0.0
        near_cleaning_norm = (2.0 - remaining_runs) * 0.5
        if near_cleaning_norm < 0.0:
            near_cleaning_norm = 0.0
        elif near_cleaning_norm > 1.0:
            near_cleaning_norm = 1.0
        if self.is_cleaning:
            near_cleaning_norm = 0.0
        buffer[offset + 8] = near_cleaning_norm
        buffer[offset + 9] = head_route
        return 10

    def clone(self) -> "PM":
        cloned = PM(
            name=self.name,
            capacity=self.capacity,
            processing_time=self.processing_time,
            type=self.type,
            P_Residual_time=self._P_Residual_time,
            cleaning_duration=self._cleaning_duration,
            cleaning_trigger_wafers=self._cleaning_trigger_wafers,
            scrap_clip_threshold=self._scrap_clip_threshold,
            n_routes=self._n_routes,
            last_machine=self.last_machine,
            processed_wafer_count=self.processed_wafer_count,
            idle_time=self.idle_time,
            last_proc_type=self.last_proc_type,
            last_wafer_id=self.last_wafer_id,
            is_cleaning=self.is_cleaning,
            cleaning_remaining=self.cleaning_remaining,
            cleaning_reason=self.cleaning_reason,
            base_processing_time=self.base_processing_time,
            process_time_extra=self.process_time_extra,
            station_times={k: dict(v) for k, v in self.station_times.items()},
            process_time_by_route=dict(self.process_time_by_route),
            clean_meta={k: dict(v) for k, v in self.clean_meta.items()},
            pre_cleaned_pjobs=set(self.pre_cleaned_pjobs),
            postcleaned_pjobs=set(self.postcleaned_pjobs),
            processed_pjobs=set(self.processed_pjobs),
            processed_count_by_pjob=dict(self.processed_count_by_pjob),
            pending_cleans=list(self.pending_cleans),
            cleaning_pjob=self.cleaning_pjob,
        )
        cloned.tokens = deque(tok.clone() for tok in self.tokens)
        return cloned


class LL(Place):
    """Load Lock 缓冲，返回 5 维基础时间特征 + binary_dim 维去向二进制编码。

    is_atm=True  → 大气侧（venting 或 atm_ready），仅 TM1 可操作
    is_atm=False → 真空侧（pumping 或 vacuum_ready），仅 TM2 可操作
    processing_time = pump_time（抽气时长）
    vent_time      = 充气时长（含 +2*door 站点门动作）
    movelist_pump_time / movelist_vent_time = 导出 Movelist 用，与 chambers JSON 中 pump_time/vent_time 字面一致
    """
    __slots__ = (
        "_color_binary_map", "_binary_dim", "_obs_dim", "is_atm", "vent_time",
        "movelist_pump_time", "movelist_vent_time", "_last_state_change_time",
        "_n_routes", "_inv_n_routes",
    )

    def __init__(
        self,
        name: str,
        capacity: int,
        processing_time: float,
        type: int = LOADLOCK,
        color_binary_map: Optional[Dict[int, int]] = None,
        binary_dim: int = 2,
        vent_time: float = 0.0,
        movelist_pump_time: Optional[float] = None,
        movelist_vent_time: Optional[float] = None,
        n_routes: int = 1,
        **kwargs,
    ):
        super().__init__(
            name=name,
            capacity=capacity,
            processing_time=processing_time,
            type=type,
            **kwargs,
        )
        self._color_binary_map = {int(k): int(v) for k, v in dict(color_binary_map or {}).items()}
        self._binary_dim = max(1, binary_dim)
        self._n_routes = max(1, int(n_routes))
        self._inv_n_routes = 1.0 / float(self._n_routes)
        self._obs_dim = 5 + self._binary_dim + 1
        self.is_atm: bool = True
        self.vent_time: float = float(vent_time)
        self._last_state_change_time: float = 0.0
        self.movelist_pump_time: Optional[float] = (
            float(movelist_pump_time) if movelist_pump_time is not None else None
        )
        self.movelist_vent_time: Optional[float] = (
            float(movelist_vent_time) if movelist_vent_time is not None else None
        )

    def get_obs(self) -> List[float]:
        out = np.zeros(self.get_obs_dim(), dtype=np.float32)
        self.write_obs(out, 0)
        return out.tolist()

    def get_obs_dim(self) -> int:
        return self._obs_dim

    def write_obs(self, buffer: np.ndarray, offset: int) -> int:
        buffer[offset: offset + self._obs_dim] = 0.0
        return self._write_obs_inner(buffer, offset)

    def write_obs_fast(self, buffer: np.ndarray, offset: int) -> int:
        return self._write_obs_inner(buffer, offset)

    def _write_obs_inner(self, buffer: np.ndarray, offset: int) -> int:
        """
        has_wafer,                  是否有晶圆
        is_processing,              是否正在抽气/充气（驻留时间 < 当前状态处理时间）
        ready_for_pick,             是否完成（驻留时间 >= 当前状态处理时间）
        remaining_process_time_norm,剩余时间比例（0-1）
        is_atm,                     1.0=大气侧，0.0=真空侧
        [5..5+binary_dim),          目标去向的二进制编码（LSB优先，0=无目标）
        """
        has_wafer = len(self.tokens) > 0
        buffer[offset] = 1.0 if has_wafer else 0.0
        buffer[offset + 4] = 1.0 if self.is_atm else 0.0
        if not has_wafer:
            # no token → route_type dim already 0 (write_obs zeroed the whole slice)
            return self._obs_dim
        head_tok = self.tokens[0]
        buffer[offset + 5 + self._binary_dim] = float(int(head_tok.route_type)) * self._inv_n_routes

        # 根据当前状态选用正确的处理时间
        raw_proc_time = float(self.vent_time) if self.is_atm else float(self.processing_time)
        if raw_proc_time <= 0.0:
            buffer[offset + 2] = 1.0
            head = self.tokens[0]
            color_gate = head.color()
            color_code = int(color_gate[0]) if color_gate else 0
            idx = self._color_binary_map.get(color_code, 0)
            if idx > 0:
                for bit in range(self._binary_dim):
                    buffer[offset + 5 + bit] = float((idx >> bit) & 1)
            return self._obs_dim

        stay_time = float(self.tokens[0].stay_time)
        is_processing = stay_time < raw_proc_time
        buffer[offset + 1] = 1.0 if is_processing else 0.0
        buffer[offset + 2] = 0.0 if is_processing else 1.0
        remaining_proc = raw_proc_time - stay_time
        if remaining_proc < 0.0:
            remaining_proc = 0.0
        remaining_norm = remaining_proc / raw_proc_time
        if remaining_norm > 1.0:
            remaining_norm = 1.0
        buffer[offset + 3] = remaining_norm
        color_gate = self.tokens[0].color()
        color_code = int(color_gate[0]) if color_gate else 0
        idx = self._color_binary_map.get(color_code, 0)
        if idx > 0:
            for bit in range(self._binary_dim):
                buffer[offset + 5 + bit] = float((idx >> bit) & 1)
        return self._obs_dim

    def clone(self) -> "LL":
        cloned = LL(
            name=self.name,
            capacity=self.capacity,
            processing_time=self.processing_time,
            type=self.type,
            color_binary_map=dict(self._color_binary_map),
            binary_dim=self._binary_dim,
            vent_time=self.vent_time,
            n_routes=self._n_routes,
            last_machine=self.last_machine,
            processed_wafer_count=self.processed_wafer_count,
            idle_time=self.idle_time,
            last_proc_type=self.last_proc_type,
            last_wafer_id=self.last_wafer_id,
            is_cleaning=self.is_cleaning,
            cleaning_remaining=self.cleaning_remaining,
            cleaning_reason=self.cleaning_reason,
            base_processing_time=self.base_processing_time,
            process_time_extra=self.process_time_extra,
            station_times={k: dict(v) for k, v in self.station_times.items()},
            process_time_by_route=dict(self.process_time_by_route),
            movelist_pump_time=self.movelist_pump_time,
            movelist_vent_time=self.movelist_vent_time,
        )
        cloned.is_atm = self.is_atm
        cloned._last_state_change_time = float(getattr(self, "_last_state_change_time", 0.0))
        cloned.tokens = deque(tok.clone() for tok in self.tokens)
        return cloned
