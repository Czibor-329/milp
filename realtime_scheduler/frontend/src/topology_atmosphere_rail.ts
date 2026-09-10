/**
 * 大气机械手沿导轨的回放时序。
 * 优先使用 PreTrans 移动；没有独立转位动作时，在取放前段完成对齐，再开始伸臂。
 * 保存模块名称与归一化进度，由拓扑布局解析坐标，不改变 MoveList 时间。
 */
import type { MoveRecord } from "./analysis_contracts";

export interface AtmosphereRailMotion {
  source: string;
  target: string;
  progress: number;
  /** 取放前的导轨阶段占动作时长比例，供画布交接同步重映射。 */
  preparationFraction: number;
}
const PRE_TRANS_MOVE = 5;
const RAIL_PREPARATION_FRACTION = 0.25;

/** 读取动作端点；标准取放优先使用实际站点，不把 RobotSlot 当作目标。 */
function station(move: MoveRecord, field: string): string {
  return Array.isArray(move[field]) ? String(move[field][0] ?? "") : "";
}

/** 从已开始动作恢复轨道位置和下一段移动，无播放历史依赖，支持反向拖动。 */
export function atmosphereRailMotion(moves: MoveRecord[], robot: string, time: number): AtmosphereRailMotion {
  let previousTarget = "";
  for (const move of moves.filter(move => move.ModuleName === robot)
    .sort((left, right) => Number(left.StartTime) - Number(right.StartTime))) {
    if (Number(move.StartTime) > time) break;
    const target = station(move, "DestStationList") || station(move, "SrcStationList") || station(move, "StationList");
    if (!target) continue;
    if (Number(move.EndTime) > time) {
      const source = Number(move.MoveType) === PRE_TRANS_MOVE ? station(move, "SrcStationList") || previousTarget : previousTarget;
      const preparationFraction = Number(move.MoveType) < PRE_TRANS_MOVE && source !== target ? RAIL_PREPARATION_FRACTION : 0;
      const progress = (time - Number(move.StartTime)) / (Number(move.EndTime) - Number(move.StartTime));
      return { source, target, preparationFraction,
        progress: Number(move.MoveType) === PRE_TRANS_MOVE ? progress : preparationFraction ? Math.min(1, progress / preparationFraction) : 1 };
    }
    previousTarget = target;
  }
  return { source: previousTarget, target: previousTarget, progress: 1, preparationFraction: 0 };
}
