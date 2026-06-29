"""标准 RouteSteps 解析器。

输入：标准 IRoute.RouteSteps 列表
    [
        {"StepID": 0, "PostStepID": [1], "NeedProcess": false,
         "Visits": [{"StationName": "P1", "SlotID":[1], ...}]},
        {"StepID": 1, "PostStepID": [2], "NeedProcess": false,
         "Visits": [{"StationName": "TM1", ...}]},   # transport step
        ...
    ]

`parse_route_steps` 把 step 链拆成 (stations, transports)，并做结构 + scope 校验。
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence, Tuple


_ALLOWED_STAGE_TYPES: frozenset[str] = frozenset(
    {"source", "sink", "process", "buffer", "loadlock"}
)

# Station.Type（小写）→ stage_type 推断（仅用于既非首末也非 process 的 step）；
# 未命中（heater/cooler/aligner 等）回退 buffer。
_TYPE_TO_STAGE: Dict[str, str] = {
    "buffer": "buffer",
    "loadlock": "loadlock",
}


def _linearize_steps(
    route_name: str, route_steps: Sequence[Mapping[str, Any]],
) -> List[Mapping[str, Any]]:
    if not route_steps:
        raise ValueError(f"route {route_name}: RouteSteps is empty")
    by_id: Dict[int, Mapping[str, Any]] = {}
    for s in route_steps:
        if "StepID" not in s:
            raise ValueError(f"route {route_name}: step missing StepID")
        sid = int(s["StepID"])
        if sid in by_id:
            raise ValueError(f"route {route_name}: duplicate StepID={sid}")
        by_id[sid] = s
    has_pred: set[int] = set()
    for s in route_steps:
        post = list(s.get("PostStepID") or [])
        if len(post) > 1:
            raise NotImplementedError(
                f"route {route_name} step {s.get('StepID')}: branching PostStepID not supported"
            )
        for p in post:
            has_pred.add(int(p))
    roots = [int(s["StepID"]) for s in route_steps if int(s["StepID"]) not in has_pred]
    if len(roots) != 1:
        raise ValueError(f"route {route_name}: expected exactly 1 root step, got {roots}")
    chain: List[Mapping[str, Any]] = []
    seen: set[int] = set()
    cur = roots[0]
    while True:
        if cur in seen:
            raise ValueError(f"route {route_name}: cycle at StepID={cur}")
        seen.add(cur)
        step = by_id.get(cur)
        if step is None:
            raise ValueError(f"route {route_name}: dangling PostStepID={cur}")
        chain.append(step)
        post = list(step.get("PostStepID") or [])
        if not post:
            break
        cur = int(post[0])
    if len(chain) != len(by_id):
        raise ValueError(
            f"route {route_name}: {len(by_id)} steps but only {len(chain)} on linear chain"
        )
    return chain


def _visit_names(step: Mapping[str, Any]) -> List[str]:
    visits = step.get("Visits") or []
    out: List[str] = []
    for v in visits:
        name = v.get("StationName") if isinstance(v, Mapping) else None
        if not name:
            raise ValueError(f"step {step.get('StepID')}: visit missing StationName")
        out.append(str(name))
    if not out:
        raise ValueError(f"step {step.get('StepID')}: empty Visits")
    return out


def _limit_value(raw: Any, default: int = -1) -> int:
    if isinstance(raw, (int, float)):
        return int(raw)
    return int(default)


def parse_route_steps(
    route_name: str,
    route_steps: Sequence[Mapping[str, Any]],
    *,
    tm_scopes: Mapping[str, frozenset[str]],
    stations_cfg: Mapping[str, Mapping[str, Any]] | None = None,
) -> Tuple[List[Dict[str, Any]], List[str], List[int]]:
    """返回 (stations, transports, transport_qtimes)，len(stations) == len(transports) + 1。

    stations/transports 与旧 split_sequence 同构，额外返回每段 transport 的 QTimeLimit。
    """
    stations_cfg = stations_cfg or {}
    chain = _linearize_steps(route_name, route_steps)
    robot_names = set(tm_scopes.keys())

    is_transport: List[bool] = []
    for step in chain:
        names = _visit_names(step)
        all_robots = all(n in robot_names for n in names)
        any_robot = any(n in robot_names for n in names)
        if any_robot and not all_robots:
            raise ValueError(
                f"route {route_name} step {step.get('StepID')}: "
                f"mixed robot/chamber visits {names}"
            )
        is_transport.append(all_robots)

    # 起止必为 station，station/transport 严格交替
    n = len(chain)
    if n < 3 or n % 2 == 0:
        raise ValueError(
            f"route {route_name}: step count {n} invalid (must be odd, >=3)"
        )
    if is_transport[0] or is_transport[-1]:
        raise ValueError(f"route {route_name}: first/last step must be station, not robot")
    for i, t in enumerate(is_transport):
        expected_transport = (i % 2 == 1)
        if t != expected_transport:
            raise ValueError(
                f"route {route_name} step idx {i} (StepID={chain[i].get('StepID')}): "
                f"expected {'transport' if expected_transport else 'station'}"
            )

    stations: List[Dict[str, Any]] = []
    transports: List[str] = []
    transport_qtimes: List[int] = []

    for i, step in enumerate(chain):
        names = _visit_names(step)
        visits = step.get("Visits") or []
        if is_transport[i]:
            if len(names) > 1:
                raise ValueError(
                    f"route {route_name} step {step.get('StepID')}: "
                    f"transport step with multiple robot candidates {names}"
                )
            transports.append(names[0])
            transport_qtimes.append(_limit_value((visits[0] or {}).get("QTimeLimit")))
            continue

        # station step → 推断 stage_type
        if i == 0:
            stage_type = "source"
        elif i == n - 1:
            stage_type = "sink"
        elif bool(step.get("NeedProcess")):
            stage_type = "process"
        else:
            cand_types = {
                str((stations_cfg.get(c) or {}).get("Type") or "").lower()
                for c in names
            }
            cand_types.discard("")
            stage_type = ""
            for t in cand_types:
                mapped = _TYPE_TO_STAGE.get(t)
                if mapped:
                    stage_type = mapped
                    break
            if not stage_type:
                stage_type = "buffer"

        if stage_type not in _ALLOWED_STAGE_TYPES:
            raise ValueError(
                f"route {route_name} step {step.get('StepID')}: "
                f"invalid stage_type {stage_type!r}"
            )

        station: Dict[str, Any] = {
            "candidates": list(names),
            "stage_type": stage_type,
            "residency": {
                str(v.get("StationName")): (
                    _limit_value(v.get("ResidencyConstraint"))
                    if stage_type == "process"
                    else -1
                )
                for v in visits
                if isinstance(v, Mapping) and v.get("StationName")
            },
        }
        # 透传旧字段（兼容 task_loader 从 legacy sequence 写入的额外字段）
        for opt in ("process_time", "cleaning_duration", "cleaning_trigger_wafers"):
            if step.get(opt) is not None:
                station[opt] = step[opt]
        stations.append(station)

    # TM scope 校验：每个 hop 两侧 station 的 candidates 必须落在对应 TM scope 内
    for hop_idx, tm in enumerate(transports):
        scope = tm_scopes[tm]
        src = stations[hop_idx]["candidates"]
        dst = stations[hop_idx + 1]["candidates"]
        bad = [c for c in (*src, *dst) if c not in scope]
        if bad:
            raise ValueError(
                f"route {route_name} hop[{hop_idx}] {tm}: chambers {bad} not in {tm} scope"
            )

    return stations, transports, transport_qtimes
