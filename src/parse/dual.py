"""解析双腔设备（MultiProcessChamber）的成对建模视图。

双腔设备：一个 PM 同时加工 2 片；VTR 每条臂 2 槽位（同取同放）；LoadLock 成对
出现（LA+LB / LC+LD，VAC 臂 SlotsStationMap 给出配对名 LALB/LCLD）。把 2 片晶圆
看成 1 个调度单元后，双腔模型与单腔模型同构：

  - LoadLock 对合并为一个库所（LALB/LCLD），容量 1（一对）
  - PM 容量 2 → 1（一对）；Cooler 容量减半
  - 大气手一次搬一对：在 LL/Cooler 这类单片位需要拆成 2 次取放 + 中间转位，
    pick/place 时长按 单片×2 + 成员间转位 合成；LoadPort 的时长本身就是成对值
  - 真空手双槽臂同取同放：时长直接用单值
  - Materials 按 PJob MatList 顺序两两配对；奇数片留一个单片"对"（占位空腔）
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Mapping, Optional

_DUAL_PM_TYPE = "multiprocesschamber"


def detect_dual_chamber(stations: Optional[Mapping[str, Any]]) -> bool:
    return any(
        str((st or {}).get("Type") or "").lower() == _DUAL_PM_TYPE
        for st in (stations or {}).values()
    )


def _merged_ll_groups(
    robots: Mapping[str, Any], stations: Mapping[str, Any]
) -> Dict[str, List[str]]:
    """从机器手臂 SlotsStationMap 提取 LL 配对：{'LALB': ['LA','LB'], ...}。"""
    groups: Dict[str, List[str]] = {}
    for rb in (robots or {}).values():
        arms = (rb or {}).get("ArmInfo") or {}
        if not isinstance(arms, Mapping):
            continue
        for arm in arms.values():
            for merged, slotmap in ((arm or {}).get("SlotsStationMap") or {}).items():
                merged = str(merged)
                if merged in stations or merged in groups:
                    continue
                members: List[str] = []
                for slot in sorted((slotmap or {}).keys(), key=str):
                    for kv in (slotmap or {}).get(slot) or []:
                        k = str((kv or {}).get("Key") or "")
                        if k and k not in members:
                            members.append(k)
                if len(members) >= 2 and all(m in stations for m in members):
                    groups[merged] = members
    return groups


def _trans_time(robot_cfg: Mapping[str, Any], src: str, dst: str, trans_type: int = 1) -> float:
    for r in robot_cfg.get("PrepTransTime") or []:
        if (
            int(r.get("TransType", -1)) == trans_type
            and str(r.get("SrcStation")) == src
            and str(r.get("DestStation")) == dst
        ):
            return float(r.get("Time", 0.0))
    return 0.0


def apply_dual_view(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """就地把 payload 改写成成对视图；非双腔返回 None，否则返回 _DualView 元数据。"""
    stations: Dict[str, Any] = payload.get("Stations") or {}
    robots: Dict[str, Any] = payload.get("Robots") or {}
    if not detect_dual_chamber(stations):
        return None

    groups = _merged_ll_groups(robots, stations)
    member_to_merged: Dict[str, str] = {
        m: merged for merged, members in groups.items() for m in members
    }
    cooler_names = [
        n for n, st in stations.items()
        if str((st or {}).get("Type") or "").lower() == "cooler"
    ]

    # ---- 1) Stations：合并 LL、PM 容量减半、Cooler 容量减半 ----
    for merged, members in groups.items():
        primary = stations[members[0]]
        entry = deepcopy(primary)
        entry["Name"] = merged
        stations[merged] = entry
    for m in member_to_merged:
        stations.pop(m, None)
    for n, st in stations.items():
        t = str((st or {}).get("Type") or "").lower()
        if t == _DUAL_PM_TYPE:
            st["Capacity"] = 1
            st["Slots"] = [1]
        elif t == "cooler":
            cap = max(1, int(st.get("Capacity", 1) or 1) // 2)
            st["Capacity"] = cap
            st["Slots"] = list(range(1, cap + 1))

    # ---- 2) Robots：时长合成 / scope 与 PrepTransTime 改名 / 容量减半 ----
    for rb in robots.values():
        if not isinstance(rb, dict):
            continue
        # 大气手判定：可达任一 LoadPort
        access_all = [
            str(s)
            for arm in ((rb.get("ArmInfo") or {}).values() if isinstance(rb.get("ArmInfo"), Mapping) else [])
            for s in (arm or {}).get("AccessibleStations") or []
        ]
        is_atm = any(
            str((stations.get(a) or {}).get("Type") or "").lower() == "loadport"
            for a in access_all
        )
        for field in ("PickTime", "PlaceTime"):
            tm: Dict[str, float] = {str(k): float(v) for k, v in (rb.get(field) or {}).items()}
            out: Dict[str, float] = {}
            for st_name, val in tm.items():
                if st_name in member_to_merged:
                    merged = member_to_merged[st_name]
                    if merged in out:
                        continue
                    if is_atm:
                        members = groups[merged]
                        inner = _trans_time(rb, members[0], members[1])
                        out[merged] = round(
                            float(tm.get(members[0], val)) + inner + float(tm.get(members[1], val)), 4
                        )
                    else:
                        out[merged] = val  # 真空手双槽同取同放
                elif is_atm and st_name in cooler_names:
                    inner = _trans_time(rb, st_name, st_name)
                    out[st_name] = round(val * 2 + inner, 4)
                else:
                    out[st_name] = val
            rb[field] = out
        # PrepTransTime 行改名 + 去重
        seen = set()
        new_rows = []
        for r in rb.get("PrepTransTime") or []:
            src = member_to_merged.get(str(r.get("SrcStation")), str(r.get("SrcStation")))
            dst = member_to_merged.get(str(r.get("DestStation")), str(r.get("DestStation")))
            key = (src, dst, int(r.get("TransType", -1)))
            if key in seen:
                continue
            seen.add(key)
            r2 = dict(r)
            r2["SrcStation"] = src
            r2["DestStation"] = dst
            new_rows.append(r2)
        rb["PrepTransTime"] = new_rows
        # 臂 scope 改名
        arms = rb.get("ArmInfo") or {}
        if isinstance(arms, Mapping):
            for arm in arms.values():
                if not isinstance(arm, dict):
                    continue
                acc = arm.get("AccessibleStations") or []
                new_acc: List[str] = []
                for s in acc:
                    s2 = member_to_merged.get(str(s), str(s))
                    if s2 not in new_acc:
                        new_acc.append(s2)
                arm["AccessibleStations"] = new_acc
        # 容量：2 片 = 1 个调度单元
        rb["Capacity"] = max(1, int(rb.get("Capacity", 1) or 1) // 2)

    # ---- 3) Routes：Visits 中 LL 成员名 → 合并名（同步去重） ----
    def _remap_route(route: Optional[Dict[str, Any]]) -> None:
        for step in (route or {}).get("RouteSteps") or []:
            visits = step.get("Visits") or []
            new_visits = []
            seen_st = set()
            for v in visits:
                name = member_to_merged.get(str(v.get("StationName")), str(v.get("StationName")))
                if name in seen_st:
                    continue
                seen_st.add(name)
                v2 = dict(v)
                v2["StationName"] = name
                new_visits.append(v2)
            step["Visits"] = new_visits

    for m in payload.get("Materials") or []:
        _remap_route(m.get("Route"))
    for r in (payload.get("Routes") or {}).values():
        _remap_route(r)
    for pj in payload.get("ProcessJobs") or []:
        _remap_route(pj.get("OriginRoute"))

    # ---- 4) Materials 两两配对（按 PJob MatList 顺序；奇数留单片对） ----
    mats_by_id: Dict[int, Dict[str, Any]] = {
        int(m["ID"]): m for m in (payload.get("Materials") or []) if "ID" in m
    }
    pair_members: Dict[int, List[int]] = {}
    new_materials: List[Dict[str, Any]] = []
    paired_ids: set = set()
    for pj in payload.get("ProcessJobs") or []:
        mat_list = [int(x) for x in (pj.get("MatList") or [])]
        new_list: List[int] = []
        for i in range(0, len(mat_list), 2):
            chunk = mat_list[i:i + 2]
            pid = chunk[0]
            pair_members[pid] = list(chunk)
            new_list.append(pid)
            paired_ids.update(chunk)
            new_materials.append(mats_by_id[pid])
        pj["MatList"] = new_list
        if "MaterialCount" in pj:
            pj["MaterialCount"] = len(new_list)
    # 不属于任何 PJob 的 Materials（如 dummy 备片）原样保留
    for m in payload.get("Materials") or []:
        if int(m.get("ID", -1)) not in paired_ids and m not in new_materials:
            new_materials.append(m)
    payload["Materials"] = new_materials
    for cj in payload.get("ControlJobs") or []:
        if "MaterialCount" in cj:
            cj["MaterialCount"] = sum(
                len(pj.get("MatList") or [])
                for pj in (payload.get("ProcessJobs") or [])
                if str(pj.get("JobName")) in set(map(str, cj.get("PJobNameList") or []))
            )

    dual_view = {
        "pair_members": {str(k): v for k, v in pair_members.items()},
        "merged_ll": {k: list(v) for k, v in groups.items()},
        "cooler_names": list(cooler_names),
    }
    payload["_DualView"] = dual_view
    return dual_view
