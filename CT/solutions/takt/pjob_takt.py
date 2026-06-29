"""Per-PJob 节拍现算（统一口径）。

仅依赖 analyze_cycle，入参为纯数据 / 鸭子类型，不 import task_loader，避免循环依赖。

节拍下限（floor）按 LoadLock 瓶颈现算：加工腔加工时间短时，瓶颈在 LL 补片循环。
单个 LL 一个完整补片循环（真空态→大气态→真空态）：
  4 开门 + 4 关门 + 2 交换（大气手/真空手各一次 pick+place）+ 抽气 + 充气
多个 LL 并行流水 → 每片节拍下限 = 平均循环时长 / LL 数。当前示例 LA/LB ≈ 33s。
"""

from typing import Any, Dict, List, Mapping, Optional, Sequence

from CT.solutions.takt.takt_analysis import analyze_cycle

# 数据缺失（无 LL 站点 / 循环为 0）时的兜底节拍下限。
_DEFAULT_LL_FLOOR = 33.0


def _ll_door_and_exchange(station: Mapping[str, Any], robots: Mapping[str, Any]) -> float:
    """单 LL 补片循环的门动作 + 交换：4开门 + 4关门 + 1 pick + 1 place。

    4开门 = 2*PickPrepare + 2*PlacePrepare（进/出各开一对门）；
    4关门 = 2*PickComplete + 2*PlaceComplete；
    1 pick + 1 place = 单次取/放（按可达机器手取均值代表值，不再对两手累加）。
    抽/充气由 _ll_pump_vent 另计（各 1 次）。"""
    name = str(station.get("Name") or "")

    def _mean(field: str) -> float:
        vals = [float(v or 0.0) for v in (station.get(field) or {}).values() if v is not None]
        return sum(vals) / len(vals) if vals else 0.0

    door = (
        2.0 * _mean("PickPrepareTime") + 2.0 * _mean("PlacePrepareTime")
        + 2.0 * _mean("PickCompleteTime") + 2.0 * _mean("PlaceCompleteTime")
    )
    picks = [
        float((rb.get("PickTime") or {}).get(name, 0.0) or 0.0)
        for rb in (robots or {}).values() if isinstance(rb, Mapping)
    ]
    places = [
        float((rb.get("PlaceTime") or {}).get(name, 0.0) or 0.0)
        for rb in (robots or {}).values() if isinstance(rb, Mapping)
    ]
    picks = [p for p in picks if p > 0]
    places = [p for p in places if p > 0]
    pick_t = sum(picks) / len(picks) if picks else 0.0
    place_t = sum(places) / len(places) if places else 0.0
    return door + pick_t + place_t


def _ll_pump_vent(station: Mapping[str, Any]) -> float:
    """单 LL 抽气 + 充气时长（显式 PumpTime/VentTime 优先，否则取 PrePrepareTime 列表）。"""
    pump = station.get("PumpTime")
    vent = station.get("VentTime")
    total = float(pump or 0.0) + float(vent or 0.0)
    seen_pump = pump is not None
    seen_vent = vent is not None
    for pp in (station.get("PrePrepareTime") or []):
        if not isinstance(pp, Mapping) or pp.get("Time") is None:
            continue
        pp_type = str(pp.get("PrePrepareType") or "").lower()
        if pp_type.startswith("pump") and not seen_pump:
            total += float(pp["Time"])
            seen_pump = True
        elif pp_type.startswith("vent") and not seen_vent:
            total += float(pp["Time"])
            seen_vent = True
    return total


def loadlock_bottleneck_floor(
    stations: Optional[Mapping[str, Any]],
    robots: Optional[Mapping[str, Any]],
    *,
    default: float = _DEFAULT_LL_FLOOR,
) -> float:
    """LL 瓶颈节拍下限：平均补片循环（4 开门+4 关门+1 pick+1 place+1 抽气+1 充气）/ LL 数。"""
    cycles: List[float] = []
    for st in (stations or {}).values():
        if not isinstance(st, Mapping):
            continue
        if str(st.get("Type") or "").lower() != "loadlock":
            continue
        cycle = _ll_door_and_exchange(st, robots or {}) + _ll_pump_vent(st)
        if cycle > 0:
            cycles.append(cycle)
    if not cycles:
        return float(default)
    return round(sum(cycles) / len(cycles) / len(cycles), 1)


def _route_steps_to_stages(
    route_steps: Sequence[Mapping[str, Any]],
    capacity_by_station: Optional[Mapping[str, int]] = None,
    *,
    wafers_per_release: int = 1,
) -> List[Dict[str, Any]]:
    """抽取 NeedProcess 且 process_time > 0 的步骤为 analyze_cycle 的 stages。

    并行度 m = 候选站容量之和（多槽位站如 Cooler/heater 的吞吐按槽位数算，
    否则节拍被高估——如双腔 Cool p=50 容量 3，真实瓶颈是 50/3 而非 50）。
    capacity_by_station 缺省时退化为每站容量 1（即候选站个数）。

    Wac 清洁占腔摊入工时：步骤配置了 cleaning_duration/cleaning_trigger_wafers
    时，每个发片单元（双腔成对视图 = 2 片）的有效工时
    p_eff = p + duration / max(1, trigger_wafers // wafers_per_release)，
    否则节拍只算加工时间，发片快于腔室真实周转、造成堵塞-空转交替。
    """
    caps = capacity_by_station or {}
    unit = max(1, int(wafers_per_release))
    stages: List[Dict[str, Any]] = []
    for st in route_steps or []:
        if not st.get("NeedProcess"):
            continue
        p = st.get("process_time")
        if p is None or int(p) <= 0:
            continue
        m = sum(
            max(1, int(caps.get(str(v.get("StationName")), 1) or 1))
            for v in (st.get("Visits") or [])
        )
        p_eff = float(p)
        clean_dur = float(st.get("cleaning_duration") or 0)
        clean_trig = int(st.get("cleaning_trigger_wafers") or 0)
        if clean_dur > 0 and clean_trig > 0:
            p_eff += clean_dur / max(1, clean_trig // unit)
        stages.append({
            "p": int(round(p_eff)),
            "m": max(1, m),
            "q": None,
            "d": 0,
        })
    return stages


def takt_for_route(
    route_steps: Sequence[Mapping[str, Any]],
    *,
    floor: float = _DEFAULT_LL_FLOOR,
    buffer: float = 0.0,
    fallback: Sequence[float] = (60.0,),
    capacity_by_station: Optional[Mapping[str, int]] = None,
    wafers_per_release: int = 1,
) -> List[float]:
    """按 route 的各加工工序经 analyze_cycle 现算节拍：max(fast_takt, floor) + buffer。

    floor 应传 loadlock_bottleneck_floor(...) 的现算值。无加工步时返回 fallback。
    """
    stages = _route_steps_to_stages(
        route_steps, capacity_by_station, wafers_per_release=wafers_per_release,
    )
    if not stages:
        return [float(x) for x in fallback]
    result = analyze_cycle(stages, max_parts=10000)
    return [round(max(float(result["fast_takt"]), float(floor)) + float(buffer), 1)]


def compute_takt_by_pjob(
    pjob_assignments: Sequence[Any],
    route_steps_by_name: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    floor: float = _DEFAULT_LL_FLOOR,
    capacity_by_station: Optional[Mapping[str, int]] = None,
    wafers_per_release: int = 1,
) -> Dict[int, List[float]]:
    """每个 PJob 按其 route 现算节拍；键为 global_pjob_idx（身份键）。"""
    out: Dict[int, List[float]] = {}
    for pj in pjob_assignments:
        steps = route_steps_by_name.get(str(pj.route_name)) or []
        out[int(pj.global_pjob_idx)] = takt_for_route(
            steps, floor=floor, capacity_by_station=capacity_by_station,
            wafers_per_release=wafers_per_release,
        )
    return out
