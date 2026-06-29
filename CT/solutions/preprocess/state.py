"""重算/热启动的统一状态数据结构 `State`。

把"T 时刻的全部仿真态"形式化为一个显式 dataclass，取代此前散落、靠注释对齐字段的
无类型 snapshot dict。三处协作代码统一经由本结构：

  - 产出 A：`State.from_net(net)`        —— 回放到 T 后从 live net 抽取（重算路径）。
  - 产出 B：`State.from_update_params(up)` —— 从 IUpdateParams 设备字段抽取（run_once 路径）。
  - 消费：  `State.to_spec()` 产出 `ClusterTool._apply_warm_start` 直接消费的 dict
            （字段与其完全一致，最小化爆炸半径——本轮不改消费侧）。

`current_time` 即重算时间点 T；wafers/done_token_ids 表 T 时刻的 mark（库所代币分布）；
use_count/arm_use_count 为 transition 级负载均衡态；其余为 robot/LL/LP/PM 等资源工艺态。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

from CT.solutions.model.pn_models import LL, LOADPORT, ROBOT
from CT.tool.log_setup import get_logger

log = get_logger(__name__)


def _is_dummy_material(mat: Mapping[str, Any]) -> bool:
    """dummy wafer：不绑定 PJob、停在 DummyPort、Priority<0。不参与调度，快照中跳过。"""
    if str(mat.get("PJobName") or "").strip() == "":
        return True
    if "DummyPort" in (str(mat.get("SrcPortName") or ""), str(mat.get("CurrentModuleName") or "")):
        return True
    try:
        return int(mat.get("Priority", 0)) < 0
    except (TypeError, ValueError):
        return False


@dataclass
class State:
    """T 时刻的完整仿真态（mark + transition + 其它状态变量）。"""

    current_time: float = 0.0
    # —— mark（库所代币分布）——
    wafers: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    done_token_ids: List[int] = field(default_factory=list)
    # —— transition 级状态（负载均衡轮转）——
    use_count: Dict[str, int] = field(default_factory=dict)
    arm_use_count: Dict[str, Dict[str, int]] = field(default_factory=dict)
    # —— 其它资源/工艺状态 ——
    robots: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    loadlocks: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    # 各站门/资源 busy-until（前置 move 判定：开门 prepare 不得早于此）。重算时 _apply_warm_start
    # 以 current_time 为地板写回，使边界首动作的 prepare/旋转起点 ≥ T。
    station_door_busy: Dict[str, float] = field(default_factory=dict)
    lp_sched: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    pm_clean: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    pre_clean_marker_used: List[int] = field(default_factory=list)
    pm_entered_by_pjob: Dict[int, int] = field(default_factory=dict)

    # --------------------------------------------------------------------- #
    @classmethod
    def empty(cls, current_time: float = 0.0) -> "State":
        """冷启动空态（无活体片）。"""
        return cls(current_time=float(current_time))

    def is_empty(self) -> bool:
        """无任何活体/完工片：冷启动语义（消费侧据此跳过 warm-start）。"""
        return not self.wafers and not self.done_token_ids

    def to_spec(self) -> Dict[str, Any]:
        """产出 `_apply_warm_start` 直接消费的 dict（字段对齐；空段落为 no-op）。"""
        return {
            "current_time": float(self.current_time),
            "wafers": self.wafers,
            "done_token_ids": self.done_token_ids,
            "robots": self.robots,
            "loadlocks": self.loadlocks,
            "station_door_busy": self.station_door_busy,
            "lp_sched": self.lp_sched,
            "pm_clean": self.pm_clean,
            "pre_clean_marker_used": self.pre_clean_marker_used,
            "pm_entered_by_pjob": self.pm_entered_by_pjob,
            "use_count": self.use_count,
            "arm_use_count": self.arm_use_count,
        }

    # --------------------------------------------------------------------- #
    @classmethod
    def from_net(cls, net: Any) -> "State":
        """从「回放到重算时间点 T」之后的活体 net marking 导出状态。

        分类（遍历 net.marks 的每个 token，token_id == material ID）：
          - LoadPort 库所：route_head_idx==0 → 仍待发（跳过，combined 网冷态自然留在 LP）；
            route_head_idx 抵达 route_queue 末位 → 已完工 → done_token_ids。
          - 其它库所（PM/LL/Buffer/Cooler）：在制片 → wafers{}，直接读 token.stay_time/enter_time，
            resting_occurrence 由 net._resting_indices 现算（与 token 真实 route_head_idx 对齐）。
        机器手朝向 / LL 气相 / LP scheduler 节拍 / PM 清洁 / 负载均衡计数一并导出。
        current_time 取 net.time（回放实际落点）。

        精确 T 停（不再 settle 到 transports 空）：T 时刻停在机械手运输位的在途片（M2）作为
        in_flight 态显式携带（route_head_idx 已 unload+1、stay_time≤0 表剩余在途量），由
        _apply_warm_start 落回运输位续算；其余静止片由目标 station 现算 route_head_idx。
        """
        st = cls(current_time=float(net.time))
        # 经 warm-start 注入的「已完工」token：被 _take 移出 marking，下面 LP 扫描看不到它们。
        # 连续重算时须并回，否则上一轮经 warm-start 完工的 job 丢失 done 身份 → 复活 → 不可行。
        st.done_token_ids.extend(int(t) for t in getattr(net, "_ws_done_token_ids", []) or [])

        for place in net.marks:
            ptype = int(place.type)
            if ptype == ROBOT:
                # 在途片（精确 T 停时停在机器手运输位）：stay_time<0 表剩余在途时间。
                # route_head_idx 已在 unload 时 +1，无法由 _resting_indices 现算，故直接显式携带。
                for tok in place.tokens:
                    if getattr(tok, "is_dummy", False):
                        continue  # dummy 片每轮由 synthesize_dummy_routes 重新合成，不随 warm-start 携带
                    st.wafers[int(tok.token_id)] = {
                        "place": str(place.name),
                        "in_flight": True,
                        "route_head_idx": int(tok.route_head_idx),
                        "stay_time": float(tok.stay_time),
                        "enter_time": float(tok.enter_time),
                        "last_transition_code": int(getattr(tok, "last_transition_code", -1)),
                    }
                continue
            if ptype == LOADPORT:
                for tok in place.tokens:
                    if getattr(tok, "is_dummy", False):
                        continue  # dummy 片（停 DummyPort）不入快照——下一轮重新合成，否则 _take 找不到而报错
                    rq_len = len(tok.route_queue or ())
                    if int(tok.route_head_idx) >= rq_len > 0:
                        st.done_token_ids.append(int(tok.token_id))
                    # route_head_idx==0：仍待发，combined 网冷态保留在 LP，无需入规格。
                continue
            # 在制片（PM/LL/Buffer/Cooler 等）
            for tok in place.tokens:
                if getattr(tok, "is_dummy", False):
                    continue  # dummy 片不随 warm-start 携带（每轮重新合成）
                ridxs = net._resting_indices(tok, place.name)
                occ = ridxs.index(int(tok.route_head_idx)) if int(tok.route_head_idx) in ridxs else 0
                st.wafers[int(tok.token_id)] = {
                    "place": str(place.name),
                    "resting_occurrence": int(occ),
                    "stay_time": float(tok.stay_time),
                    "enter_time": float(tok.enter_time),
                }

        for place in net.marks:
            if int(place.type) == ROBOT:
                entry: Dict[str, Any] = {}
                if getattr(place, "_last_chamber", None) is not None:
                    entry["last_chamber"] = place._last_chamber
                if getattr(place, "_last_use_end", None) is not None:
                    entry["last_use_end"] = float(place._last_use_end)
                if entry:
                    st.robots[str(place.name)] = entry
            elif isinstance(place, LL):
                st.loadlocks[str(place.name)] = {
                    "is_atm": bool(place.is_atm),
                    "last_state_change_time": float(getattr(place, "_last_state_change_time", 0.0)),
                }

        # 站门 busy-until（settle 版多为空；exact-T 停时携带在途门动作末端）。
        st.station_door_busy = {
            str(k): float(v) for k, v in (getattr(net, "_station_door_busy", {}) or {}).items()
        }

        for lp, sch in (getattr(net, "_lp_schedulers", {}) or {}).items():
            st.lp_sched[str(lp)] = {
                "next_release_enable_time": float(sch.next_release_enable_time),
                "u_entry_release_count": int(sch.u_entry_release_count),
                "last_u_entry_fire_time": float(sch.last_u_entry_fire_time),
            }

        # PM 的 per-PJob 清洁状态：若不携带，重算后新网会遗忘旧 job 已完成的
        # PreClean/PostClean/wac 计数而重复触发（Bug4）。pjob_idx 在重算前后按 ProcessJob 顺序
        # 一致；若 _drop_completed_jobs 重排，scheduler 侧负责重映射本段索引。
        for place in net.marks:
            if not getattr(place, "is_pm", False):
                continue
            st.pm_clean[str(place.name)] = {
                "pre_cleaned_pjobs": sorted(int(x) for x in place.pre_cleaned_pjobs),
                "postcleaned_pjobs": sorted(int(x) for x in place.postcleaned_pjobs),
                "processed_pjobs": sorted(int(x) for x in place.processed_pjobs),
                "processed_count_by_pjob": {int(k): int(v) for k, v in place.processed_count_by_pjob.items()},
                "processed_wafer_count": int(place.processed_wafer_count),
                "is_cleaning": bool(place.is_cleaning),
                "cleaning_remaining": int(place.cleaning_remaining),
                "cleaning_reason": str(place.cleaning_reason),
                "cleaning_pjob": int(place.cleaning_pjob),
                "pending_cleans": [[str(r), float(d), int(pj)] for r, d, pj in place.pending_cleans],
            }
        st.pre_clean_marker_used = sorted(
            int(x) for x in getattr(net, "_pre_clean_marker_used", set()) or set()
        )
        st.pm_entered_by_pjob = {
            int(k): int(v) for k, v in (getattr(net, "_pm_entered_by_pjob", {}) or {}).items()
        }

        # 负载均衡计数（按变迁名 / robot·arm 名 keyed，跨网稳定）：不恢复则重算后归零、
        # 并行 PM 均衡从首个候选 PM 重新开始（轮转丢失）。
        st.use_count = {
            str(tr.name): int(tr.use_count)
            for tr in (getattr(net, "_transitions", []) or [])
            if int(getattr(tr, "use_count", 0)) > 0
        }
        st.arm_use_count = {
            str(rm): {str(a): int(c) for a, c in (arms or {}).items()}
            for rm, arms in (getattr(net, "_arm_use_count", {}) or {}).items()
        }

        return st

    # --------------------------------------------------------------------- #
    @classmethod
    def from_update_params(cls, update_params: Mapping[str, Any]) -> Optional["State"]:
        """把 IUpdateParams 当前态转成状态（不依赖 net）。冷启动（无活体片 + T=0）返回 None。

        route_head_idx 不在此解析——交由 net 在 reset 时从 token.route_queue + 目标 station
        现算（见 ClusterTool._resting_indices）。

        支持：静止于腔室/LL/LoadPort 的 wafer（CurrentModuleName 定位）、已完工 wafer
        （ProcessingState=Processed 且回到源 LP），以及 Robots/Stations 的机器手朝向 / LL
        气相动态态。中途在机械手上的在制片暂不支持（net 落位时无候选 route_head_idx 会抛错）。
        """
        cur_t = float(update_params.get("CurrentTime", 0.0))
        materials = list(update_params.get("Materials") or [])
        # 源 LoadPort 名集合：每片 wafer 的 SrcPortName
        source_lp = {str(m.get("SrcPortName")) for m in materials if m.get("SrcPortName")}

        st = cls(current_time=cur_t)
        st.lp_sched = dict(update_params.get("_LpSched") or {})
        has_active = False

        for mat in materials:
            # dummy wafer 不参与调度，直接跳过
            if _is_dummy_material(mat):
                continue
            tid = int(mat["ID"])
            state = int(mat.get("ProcessingState", 0) or 0)
            cur_mod = str(mat.get("CurrentModuleName", "") or "")

            # 未加工且仍在源 LP：留给 LP scheduler 正常发片
            if state == 0 and (not cur_mod or cur_mod in source_lp):
                continue
            has_active = True

            # 已完工（回到源/汇 LP）
            if state == 2 and cur_mod in source_lp:
                st.done_token_ids.append(tid)
                continue

            entry: Dict[str, Any] = {
                "place": cur_mod,
                # 重入路径多候选时 net 按序选取（k = 之前已访问的相同站次数）
                "resting_occurrence": int(mat.get("_RestingOccurrence", 0)),
            }
            # 驻留时长：显式 _StayTime 优先，否则把站点 TimeToAvailableOfSlot 传给 net 反推（proc - tta）
            if "_StayTime" in mat:
                entry["stay_time"] = float(mat["_StayTime"])
            else:
                station = (update_params.get("Stations") or {}).get(str(cur_mod))
                tta_map = (station or {}).get("TimeToAvailableOfSlot") or {}
                val = tta_map.get(
                    str(mat.get("SlotID", 1)),
                    tta_map.get(int(mat.get("SlotID", 1))) if mat.get("SlotID", 1) in tta_map else None,
                )
                if val is not None:
                    entry["tta"] = float(val)
            if "_EnterTime" in mat:
                entry["enter_time"] = float(mat["_EnterTime"])
            st.wafers[tid] = entry

        # 机器手朝向（IUpdateRobot 扩展字段 _LastChamber/_LastUseEnd）
        for rname, rinfo in (update_params.get("Robots") or {}).items():
            ri = rinfo or {}
            entry = {}
            if ri.get("_LastChamber") is not None:
                entry["last_chamber"] = ri["_LastChamber"]
            if ri.get("_LastUseEnd") is not None:
                entry["last_use_end"] = ri["_LastUseEnd"]
            if entry:
                st.robots[str(rname)] = entry

        # LL 气相态（IUpdateStation 扩展字段 _IsAtm/_LastStateChangeTime）
        for sname, sinfo in (update_params.get("Stations") or {}).items():
            si = sinfo or {}
            entry = {}
            if si.get("_IsAtm") is not None:
                entry["is_atm"] = bool(si["_IsAtm"])
            if si.get("_LastStateChangeTime") is not None:
                entry["last_state_change_time"] = float(si["_LastStateChangeTime"])
            if entry:
                st.loadlocks[str(sname)] = entry

        if not has_active and cur_t == 0.0:
            log.debug("State.from_update_params: 冷启动 (无活体 wafer, CurrentTime=0)，返回 None")
            return None
        return st
