"""策略无关的 LoadLock 派工管理器。

上层策略只决定“下一步搬哪片晶圆”。本模块负责把逻辑 LoadLock 请求兑现成具体
``(LoadLock, slot)``：先把 LA/LB 等物理展开候选折叠为逻辑 hop，再根据局部
Petri 标识给每个安全物理候选报价。默认报价使用预计完成时刻，而不是把“少一次
空抽/空充”放在所有时间代价之前；这使 manager 能处理不同 LoadLock 的 Pump/Vent、
门时长、Robot 到达时刻和运行时释放下界。

动作合法性仍由 ``sequencing`` 的全局 Petri 可达性掩码保证。这里的局部标识与评分只
决定安全候选的偏好，不会绕过门互锁、槽位容量或终态可达性检查。

本模块不依赖 Neural、Heuristic 或 RL 的特征实现。任何返回物理候选偏好序的 chooser
都可以使用兼容适配器；不读取具体 LoadLock 的规则型 chooser 可使用严格逻辑折叠适配器。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Protocol, Sequence, Tuple

ATMOSPHERE = "atmosphere"
VACUUM = "vacuum"
ENTRY = "entry"
EXIT = "exit"
LOADLOCK_TYPE = "loadlock"
EXCHANGE_AUTO = "auto"
EXCHANGE_ENABLED = "enabled"
EXCHANGE_DISABLED = "disabled"


@dataclass(frozen=True)
class LoadLockCarMarking:
    """一台 LoadLock 在逻辑事件边界上的时间 Petri 标识。"""

    name: str
    environment: str
    ready_at: float
    inbound_tokens: int
    outbound_tokens: int
    capacity: int
    occupied_slots: int
    service_count: int


@dataclass(frozen=True)
class LoadLockDispatchMarking:
    """LA/LB 群控 manager 使用的不可变局部标识。"""

    cars: Mapping[str, LoadLockCarMarking]
    vacuum_wip: int
    free_slots: int
    total_capacity: int


@dataclass(frozen=True)
class LoadLockRequest:
    """总派工器交给 LoadLock manager 的一个逻辑搬运请求。"""

    wafer_id: int
    stage_index: int
    direction: str
    access_environment: str
    earliest_start: float


@dataclass(frozen=True)
class LoadLockDecision:
    """一个安全物理候选的可解释评分结果。"""

    candidate_index: int
    loadlock: str
    slot: int
    access_ready_at: float
    service_finish_at: float
    empty_pressure_cycles: int
    empty_pressure_time: float
    return_risk: float
    service_count: int

    @property
    def ordering_key(self) -> Tuple[Any, ...]:
        """返回 ETA 群控的稳定字典序目标。

        Pump/Vent 时间已经进入 ``service_finish_at``；循环次数只用于同完成时刻下的
        能耗偏好，不能让一把很晚才释放的锁无条件压过立即可用的锁。
        """
        return (
            float(self.service_finish_at),
            float(self.return_risk),
            float(self.empty_pressure_cycles),
            float(self.service_count),
            self.loadlock,
            int(self.slot),
            float(self.candidate_index),
        )


class LoadLockDispatchManager(Protocol):
    """所有上层调度策略共享的最小 manager 协议。"""

    name: str

    def quote(
        self,
        state: Any,
        candidates: Sequence[Any],
        candidate_indices: Iterable[int],
    ) -> List[LoadLockDecision]:
        """给同一逻辑请求的安全物理候选报价。"""

    def rank_candidates(
        self,
        state: Any,
        candidates: Sequence[Any],
        candidate_indices: Iterable[int],
    ) -> List[int]:
        """按报价返回物理候选下标。"""

    def rank_preferred_candidates(
        self,
        state: Any,
        candidates: Sequence[Any],
        preferred: Iterable[int],
    ) -> List[int]:
        """保留上层逻辑偏好，只在组内选择物理 LoadLock。"""


class PetriEtaLoadLockManager:
    """在全局 Petri 安全候选内执行两层电梯式 ETA 群控。

    entry 完成后锁在真空侧，下一项自然服务 exit；exit 完成后锁在大气侧，下一项自然
    服务 entry。与纯 LOOK 不同，本 manager 把必要的空返 Pump/Vent 直接折算进预计服务
    完成时刻，因此不会为了少一次压力循环而选择一把明显更晚才可用的锁。
    """

    name = "petri-eta-v2"

    def _ordering_key(
        self,
        decision: LoadLockDecision,
        marking: LoadLockDispatchMarking,
        request: LoadLockRequest,
    ) -> Tuple[Any, ...]:
        """返回本 manager 的候选排序键，供派生策略替换群控规则。"""
        del marking, request
        return decision.ordering_key

    def marking(self, state: Any) -> LoadLockDispatchMarking:
        """由解码器只读状态重建双锁压力、占用、服务次数和回程容量。"""
        loadlocks = sorted(
            name
            for name, chamber in state.ir.chambers.items()
            if str(chamber.type).lower() == LOADLOCK_TYPE
        )
        runtime = getattr(state.ir, "runtime_availability", None)
        runtime_environments = (
            getattr(runtime, "loadlock_environment", {}) if runtime is not None else {}
        )
        runtime_ready = (
            getattr(runtime, "station_ready", {}) if runtime is not None else {}
        )
        planned_ready = getattr(state, "loadlock_ready_at", {})
        cars: Dict[str, LoadLockCarMarking] = {}
        free_slots = 0
        total_capacity = 0
        for loadlock in loadlocks:
            last_service = state.loadlock_last_services.get(loadlock)
            service_count = int(
                state.loadlock_service_counts.get(loadlock, 0)
            )
            environment = str(
                runtime_environments.get(loadlock, ATMOSPHERE)
            ).lower()
            if last_service is not None:
                wafer_id, stage_index = last_service
                last_stage = state.wmap[int(wafer_id)].stages[int(stage_index)]
                environment = VACUUM if last_stage.ll_type == ENTRY else ATMOSPHERE

            inbound_tokens = 0
            outbound_tokens = 0
            occupied_slots = {
                int(slot): int(wafer_id)
                for (station, slot), wafer_id in state.occ.items()
                if station == loadlock
            }
            for slot, wafer_id in occupied_slots.items():
                position = int(state.pos[int(wafer_id)])
                stage = state.wmap[int(wafer_id)].stages[position]
                if stage.ll_type == EXIT:
                    outbound_tokens += 1
                else:
                    inbound_tokens += 1
            chamber = state.ir.chambers[loadlock]
            capacity = max(int(getattr(chamber, "capacity", 1) or 1), 1)
            total_capacity += capacity
            free_slots += max(capacity - len(occupied_slots), 0)
            cars[loadlock] = LoadLockCarMarking(
                name=loadlock,
                environment=environment,
                ready_at=max(
                    float(runtime_ready.get(loadlock, 0.0)),
                    float(planned_ready.get(loadlock, 0.0)),
                ),
                inbound_tokens=inbound_tokens,
                outbound_tokens=outbound_tokens,
                capacity=capacity,
                occupied_slots=len(occupied_slots),
                service_count=service_count,
            )

        vacuum_wip = sum(
            int(
                (
                    int(state.pos[wafer_id]) > 0
                    or bool(state.wmap[wafer_id].already_released)
                )
                and int(state.pos[wafer_id]) < int(state.K[wafer_id])
            )
            for wafer_id in state.pos
        )
        return LoadLockDispatchMarking(
            cars=cars,
            vacuum_wip=vacuum_wip,
            free_slots=free_slots,
            total_capacity=total_capacity,
        )

    @staticmethod
    def _hop_span(state: Any, candidate: Any, loadlock: str) -> float:
        """按候选真实目的锁估算 Robot hop，而不是沿用展开阶段的固定腔。"""
        tm = getattr(state, "tm", None)
        if tm is None:
            return 0.0
        wafer = state.wmap[int(candidate.wid)]
        stage = wafer.stages[int(candidate.j)]
        robot = str(candidate.rob)
        return float(
            tm.pick_t(robot, stage.chamber)
            + tm.move(robot)
            + tm.place_t(robot, loadlock)
        )

    @staticmethod
    def _door_dwell(state: Any, candidate: Any, loadlock: str) -> float:
        """估算载片压力转换之外的关门、开门时间。"""
        tm = getattr(state, "tm", None)
        if tm is None:
            return 0.0
        wafer = state.wmap[int(candidate.wid)]
        stage = wafer.stages[int(candidate.j) + 1]
        in_robot = getattr(stage, "in_robot", "")
        out_robot = getattr(stage, "out_robot", "")
        return float(
            (tm.place_post(in_robot, loadlock) if in_robot else 0.0)
            + (tm.pick_pre(out_robot, loadlock) if out_robot else 0.0)
        )

    @staticmethod
    def _pressure_time(state: Any, loadlock: str, direction: str) -> float:
        """读取指定锁的 Pump/Vent，兼容测试替身和缺省为零的拓扑。"""
        resource = state.ir.chambers.get(loadlock)
        if resource is None:
            return 0.0
        attribute = "pump_time" if direction == ENTRY else "vent_time"
        return float(getattr(resource, attribute, 0.0) or 0.0)

    def request(self, state: Any, candidate: Any) -> LoadLockRequest:
        """把联合候选投影成不含 LA/LB 身份的逻辑请求。"""
        following = state.wmap[int(candidate.wid)].stages[int(candidate.j) + 1]
        direction = str(following.ll_type)
        return LoadLockRequest(
            wafer_id=int(candidate.wid),
            stage_index=int(candidate.j),
            direction=direction,
            access_environment=ATMOSPHERE if direction == ENTRY else VACUUM,
            earliest_start=float(candidate.start),
        )

    def quote(
        self,
        state: Any,
        candidates: Sequence[Any],
        candidate_indices: Iterable[int],
    ) -> List[LoadLockDecision]:
        """对同一逻辑请求的 LA/LB 安全候选给出稳定优先序。"""
        indices = list(candidate_indices)
        if not indices:
            return []
        marking = self.marking(state)
        request = self.request(state, candidates[indices[0]])
        decisions: List[LoadLockDecision] = []
        for candidate_index in indices:
            candidate = candidates[candidate_index]
            if candidate.dest is None:
                continue
            loadlock = str(candidate.dest[0])
            slot = int(candidate.dest[1])
            car = marking.cars[loadlock]
            empty_pressure_cycles = int(
                car.environment != request.access_environment
            )
            empty_direction = (
                ENTRY if request.access_environment == VACUUM else EXIT
            )
            empty_pressure_time = (
                self._pressure_time(state, loadlock, empty_direction)
                if empty_pressure_cycles
                else 0.0
            )
            hop_span = self._hop_span(state, candidate, loadlock)
            # Robot 可以在锁完成空抽/空充前并行执行 pick/move；真正的服务起点是
            # “晶圆到门口”和“锁到达可访问压力侧”两者的较晚者。
            access_ready_at = max(
                request.earliest_start + hop_span,
                car.ready_at + empty_pressure_time,
            )
            loaded_pressure_time = self._pressure_time(
                state,
                loadlock,
                request.direction,
            )
            service_finish_at = (
                access_ready_at
                + self._door_dwell(state, candidate, loadlock)
                + loaded_pressure_time
            )

            # 一片 entry 会生成一张未来回程票。这里不假定某个物理槽永久属于 exit；
            # 全局 Petri 掩码负责硬容量安全，manager 只对耗尽通用空槽的选择加软价格。
            return_risk = 0.0
            if request.direction == ENTRY:
                future_returns = marking.vacuum_wip + 1
                free_after_entry = max(marking.free_slots - 1, 0)
                return_risk = float(
                    max(future_returns - free_after_entry, 0)
                ) / max(
                    marking.total_capacity,
                    1,
                )
            decisions.append(LoadLockDecision(
                candidate_index=candidate_index,
                loadlock=loadlock,
                slot=slot,
                access_ready_at=access_ready_at,
                service_finish_at=service_finish_at,
                empty_pressure_cycles=empty_pressure_cycles,
                empty_pressure_time=empty_pressure_time,
                return_risk=return_risk,
                service_count=car.service_count,
            ))
        return sorted(
            decisions,
            key=lambda decision: self._ordering_key(
                decision,
                marking,
                request,
            ),
        )

    def rank_candidates(
        self,
        state: Any,
        candidates: Sequence[Any],
        candidate_indices: Iterable[int],
    ) -> List[int]:
        """返回一个逻辑请求内的物理候选下标顺序。"""
        return [
            decision.candidate_index
            for decision in self.quote(state, candidates, candidate_indices)
        ]

    def rank_preferred_candidates(
        self,
        state: Any,
        candidates: Sequence[Any],
        preferred: Iterable[int],
    ) -> List[int]:
        """实现公共 manager 协议的兼容型物理偏好折叠。"""
        return rank_preferred_loadlock_candidates(
            state,
            candidates,
            preferred,
            self,
        )


class CollectiveLookLoadLockManager(PetriEtaLoadLockManager):
    """两层集选 LOOK：优先继续当前压力方向，再比较完成时刻。

    两层电梯没有中间楼层，LOOK/collective control 退化为“先服务当前侧请求，再空返”。
    对 LoadLock 而言，这等价于优先避免一次空抽或空充；它适合作为压力循环最少基线。
    """

    name = "collective-look-v1"

    def _ordering_key(
        self,
        decision: LoadLockDecision,
        marking: LoadLockDispatchMarking,
        request: LoadLockRequest,
    ) -> Tuple[Any, ...]:
        """先比较空压力循环，再以 ETA、回程风险和稳定名称打破平局。"""
        del marking, request
        return (
            int(decision.empty_pressure_cycles),
            float(decision.service_finish_at),
            float(decision.return_risk),
            float(decision.service_count),
            decision.loadlock,
            int(decision.slot),
            int(decision.candidate_index),
        )


class RoundRobinLoadLockManager(PetriEtaLoadLockManager):
    """轮询/最少服务次数：优先把请求交给历史服务次数最少的锁。"""

    name = "round-robin-v1"

    def _ordering_key(
        self,
        decision: LoadLockDecision,
        marking: LoadLockDispatchMarking,
        request: LoadLockRequest,
    ) -> Tuple[Any, ...]:
        """以累计服务次数实现无内部游标、可从解码标识恢复的稳定轮询。"""
        del marking, request
        return (
            int(decision.service_count),
            float(decision.service_finish_at),
            float(decision.return_risk),
            decision.loadlock,
            int(decision.slot),
            int(decision.candidate_index),
        )


class DedicatedDirectionLoadLockManager(PetriEtaLoadLockManager):
    """方向分区：首把锁负责 entry，末把锁负责 exit，其余按 ETA 回退。

    这是两层电梯 zoning/dedication 的直接对应，可减少压力方向切换，但在流量不对称时
    可能牺牲利用率。首选锁不在当前 Petri 安全候选内时，仍会使用其他锁继续排程。
    """

    name = "dedicated-direction-v1"

    def _ordering_key(
        self,
        decision: LoadLockDecision,
        marking: LoadLockDispatchMarking,
        request: LoadLockRequest,
    ) -> Tuple[Any, ...]:
        """先选择方向专用锁，再按 ETA 在同一分区内排序。"""
        loadlocks = sorted(marking.cars)
        preferred = (
            loadlocks[0]
            if request.direction == ENTRY
            else loadlocks[-1]
        )
        return (
            int(decision.loadlock != preferred),
            float(decision.service_finish_at),
            float(decision.return_risk),
            float(decision.service_count),
            decision.loadlock,
            int(decision.slot),
            int(decision.candidate_index),
        )


class ExchangeLookLoadLockManager(PetriEtaLoadLockManager):
    """交换优先 LOOK：优先选择同门已有反向晶圆的锁，再按 ETA 排序。

    entry 请求若遇到 outbound token，可在大气侧先取成品再放入生片；exit 请求若遇到
    inbound token，可在真空侧先放入成品再取出生片。实际双槽共存、门合并和压力互锁仍
    由 sequencing、timing 与 MoveList 状态回放负责，本规则只保留交换机会。
    """

    name = "exchange-look-v1"

    def _ordering_key(
        self,
        decision: LoadLockDecision,
        marking: LoadLockDispatchMarking,
        request: LoadLockRequest,
    ) -> Tuple[Any, ...]:
        """先最大化可配对的反向 token 数，再比较服务完成时刻。"""
        car = marking.cars[decision.loadlock]
        pairable_tokens = (
            car.outbound_tokens
            if request.direction == ENTRY
            else car.inbound_tokens
        )
        return (
            int(pairable_tokens <= 0),
            -int(pairable_tokens),
            float(decision.service_finish_at),
            float(decision.return_risk),
            float(decision.service_count),
            decision.loadlock,
            int(decision.slot),
            int(decision.candidate_index),
        )


# 保留旧导入名与前端 ``petri-look`` 配置；行为已经升级为基于真实时长的 ETA v2。
PetriLookLoadLockManager = PetriEtaLoadLockManager


def resolve_loadlock_exchange_mode(mode: str | bool | None) -> str:
    """规范化双槽交换配置。

    ``auto`` 同时评估普通与交换轨迹并取优；``enabled`` 只评估双槽交换资源口径；
    ``disabled`` 复现整腔互斥基线。布尔值用于兼容程序化调用。
    """
    if mode is None:
        return EXCHANGE_AUTO
    if isinstance(mode, bool):
        return EXCHANGE_ENABLED if mode else EXCHANGE_DISABLED
    normalized = str(mode).strip().lower()
    aliases = {
        "": EXCHANGE_AUTO,
        "auto": EXCHANGE_AUTO,
        "best": EXCHANGE_AUTO,
        "on": EXCHANGE_ENABLED,
        "true": EXCHANGE_ENABLED,
        "enabled": EXCHANGE_ENABLED,
        "swap": EXCHANGE_ENABLED,
        "off": EXCHANGE_DISABLED,
        "false": EXCHANGE_DISABLED,
        "disabled": EXCHANGE_DISABLED,
        "no-swap": EXCHANGE_DISABLED,
    }
    if normalized in aliases:
        return aliases[normalized]
    raise ValueError(
        "LoadLock exchange 只支持 auto、enabled 或 disabled，"
        f"收到 {mode}"
    )


def separate_loadlock_choice(
    logical_chooser: Any,
    manager: LoadLockDispatchManager,
) -> Any:
    """把不读取物理锁身份的逻辑 chooser 与独立 manager 严格组合。

    与兼容型 ``rank_preferred_loadlock_candidates`` 不同，这里先把 LA/LB 展开
    候选折叠成每个 ``(wafer, stage)`` 一个代表，再调用上层 chooser。因而 manager
    的物理选择不会反向改变“先发哪片”。Heuristic 的规则只读取 wafer/stage，适合
    使用本适配器；仍读取物理 LoadLock 特征的旧 checkpoint 应使用兼容型适配器。
    """

    def choose(state: Any, candidates: List[Any]) -> List[int]:
        """先折叠逻辑请求，再在每组内兑现物理选择。"""
        representatives: List[Any] = []
        groups: List[List[int]] = []
        group_by_key: Dict[Tuple[Any, ...], int] = {}
        for index, candidate in enumerate(candidates):
            following = state.wmap[int(candidate.wid)].stages[int(candidate.j) + 1]
            if following.stage_type == LOADLOCK_TYPE:
                key: Tuple[Any, ...] = (
                    LOADLOCK_TYPE,
                    int(candidate.wid),
                    int(candidate.j),
                )
            else:
                key = ("physical", int(index))
            group_index = group_by_key.get(key)
            if group_index is None:
                group_index = len(groups)
                group_by_key[key] = group_index
                groups.append([])
                representatives.append(candidate)
            groups[group_index].append(index)

        # 使用稳定的规范代表，避免输入物理候选排列把 LA/LB 身份泄漏给逻辑规则。
        for group_index, indices in enumerate(groups):
            if len(indices) > 1:
                representative_index = min(
                    indices,
                    key=lambda index: (
                        candidates[index].dest or ("", -1),
                        index,
                    ),
                )
                representatives[group_index] = candidates[representative_index]

        logical_order = list(logical_chooser(state, representatives))
        if not logical_order:
            return []
        if any(index < 0 or index >= len(groups) for index in logical_order):
            raise IndexError("逻辑 chooser 返回了超出折叠候选范围的索引")

        # chooser 通常返回全序；若自定义策略只返回前缀，仍把未列出的组稳定补到末尾。
        seen = set(logical_order)
        logical_order.extend(
            index for index in range(len(groups)) if index not in seen
        )
        ordered: List[int] = []
        for group_index in logical_order:
            indices = groups[group_index]
            first = candidates[indices[0]]
            following = state.wmap[int(first.wid)].stages[int(first.j) + 1]
            if following.stage_type == LOADLOCK_TYPE and len(indices) > 1:
                ordered.extend(
                    manager.rank_candidates(state, candidates, indices)
                    or indices
                )
            else:
                ordered.extend(indices)
        return ordered

    return choose


def rank_preferred_loadlock_candidates(
    state: Any,
    candidates: Sequence[Any],
    preferred: Iterable[int],
    manager: LoadLockDispatchManager,
) -> List[int]:
    """兼容旧联合策略：按物理偏好首次出现决定逻辑组顺序，再由 manager 组选锁。

    该函数适合仍在物理候选上训练的 Neural/BC checkpoint。新规则策略优先使用
    ``separate_loadlock_choice``，从结构上阻止 LoadLock 身份影响逻辑请求顺序。
    """
    group_order: List[tuple[int, int]] = []
    groups: Dict[tuple[int, int], List[int]] = {}
    for candidate_index in preferred:
        candidate = candidates[candidate_index]
        key = (int(candidate.wid), int(candidate.j))
        if key not in groups:
            groups[key] = []
            group_order.append(key)
        groups[key].append(candidate_index)

    ordered: List[int] = []
    for key in group_order:
        indices = groups[key]
        first = candidates[indices[0]]
        following = state.wmap[int(first.wid)].stages[int(first.j) + 1]
        if following.stage_type == LOADLOCK_TYPE and len(indices) > 1:
            ordered.extend(
                manager.rank_candidates(state, candidates, indices)
                or indices
            )
        else:
            ordered.extend(indices)
    return ordered


def resolve_loadlock_manager(
    manager: Optional[LoadLockDispatchManager | str],
) -> Optional[LoadLockDispatchManager]:
    """把公共配置解析成 manager；``joint``/``none`` 表示由上层策略联合选锁。"""
    if manager is None:
        return None
    if not isinstance(manager, str):
        return manager
    mode = manager.strip().lower()
    if mode in {"", "none", "joint", "joint-network"}:
        return None
    if mode in {"petri-look", "petri-eta", "eta"}:
        return PetriEtaLoadLockManager()
    if mode in {"collective", "collective-look", "look"}:
        return CollectiveLookLoadLockManager()
    if mode in {"round-robin", "roundrobin", "rr"}:
        return RoundRobinLoadLockManager()
    if mode in {"dedicated", "dedicated-direction", "zoning"}:
        return DedicatedDirectionLoadLockManager()
    if mode in {"exchange", "exchange-look", "swap-look"}:
        return ExchangeLookLoadLockManager()
    raise ValueError(
        "LoadLock manager 只支持 joint/none、petri-eta、collective-look、"
        "round-robin、dedicated-direction 或 exchange-look，"
        f"收到 {manager}"
    )
