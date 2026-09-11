/**
 * LoadLock 双侧门的只读时间投影，供拓扑回放使用。
 * 通过实际取放动作的依赖/相邻关系识别访问 Robot；级联桥接腔按上下级映射。
 * 不修改 MoveList、压力状态或调度规则。方向缺失时保留未知标记，不能同时打开两扇门。
 */
import type { DeviceDefinition, MoveRecord } from "./analysis_contracts";

export type LoadLockDoorState = "closed" | "opening" | "open" | "closing" | "unknown";
export interface LoadLockDoors {
  top: LoadLockDoorState;
  bottom: LoadLockDoorState;
  topLabel: string;
  bottomLabel: string;
}
type DoorSide = "top" | "bottom";
const PREPARE = 6;
const COMPLETE = 7;
const TRANSFERS = new Set([0, 1, 2, 3, 4]);
const TIME_TOLERANCE = 1e-6;
const RELATED_ATMOSPHERE = 0;
const RELATED_VACUUM = 1;

/** 将协议中的标量或数组统一为列表，缺省值保持为空。 */
function values(value: unknown): unknown[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

/** 按设备类型优先识别 Robot；名称仅用于缺少类型的旧日志。 */
function robotKind(name: string, device: DeviceDefinition | null): "atmosphere" | "vacuum" | "upper" | undefined {
  const type = String(device?.Robots?.[name]?.Type ?? "");
  if (/HighVTM/i.test(type) || /VTR[_-]?2/i.test(name)) return "upper";
  if (/ATM/i.test(type) || /ATR|ATM/i.test(name)) return "atmosphere";
  if (/VTM|VAC/i.test(type) || /VTR|VAC/i.test(name)) return "vacuum";
  return undefined;
}

interface TransferIndex {
  byId: Map<number, MoveRecord>;
  dependents: Map<number, MoveRecord[]>;
  starts: Map<string, MoveRecord[]>;
  ends: Map<string, MoveRecord[]>;
}

/** 为依赖和站点时间边界建索引，避免每次回放为每扇门遍历整份 MoveList。 */
function indexTransfers(moves: MoveRecord[]): TransferIndex {
  const index: TransferIndex = { byId: new Map(), dependents: new Map(), starts: new Map(), ends: new Map() };
  /** 同一键可对应组合取放，保留候选供方向一致性检查。 */
  const append = <Key>(map: Map<Key, MoveRecord[]>, key: Key, move: MoveRecord): void => {
    const entries = map.get(key) ?? [];
    entries.push(move);
    map.set(key, entries);
  };
  for (const move of moves) {
    if (!TRANSFERS.has(Number(move.MoveType))) continue;
    if (move.MoveID !== undefined) index.byId.set(move.MoveID, move);
    for (const id of values(move.PreMoveID)) append(index.dependents, Number(id), move);
    const stations = new Set([...values(move.SrcStationList), ...values(move.DestStationList), ...values(move.StationList)].map(String));
    for (const station of stations) {
      append(index.starts, `${station}:${Math.round(Number(move.StartTime) / TIME_TOLERANCE)}`, move);
      append(index.ends, `${station}:${Math.round(Number(move.EndTime) / TIME_TOLERANCE)}`, move);
    }
  }
  return index;
}

/** 获取门服务对应的取放 Robot；依赖优先，只有唯一访问 Robot 才采用时间相邻回退。 */
function relatedRobot(door: MoveRecord, index: TransferIndex): string | undefined {
  const explicit = String(door.Robot ?? "");
  if (explicit) return explicit;
  const closing = door.MoveType === COMPLETE;
  const boundary = Number(closing ? door.StartTime : door.EndTime);
  const bucket = Math.round(boundary / TIME_TOLERANCE);
  const dependencies = closing ? values(door.PreMoveID).map(id => index.byId.get(Number(id))).filter((move): move is MoveRecord => Boolean(move))
    : index.dependents.get(Number(door.MoveID)) ?? [];
  const adjacent = [-1, 0, 1].flatMap(offset => (closing ? index.ends : index.starts).get(`${door.ModuleName}:${bucket + offset}`) ?? []);
  /** 组合动作只匹配当前模块，物料字段存在时还需确认同一次服务。 */
  const matches = (move: MoveRecord): boolean => {
    const stations = [...values(move.SrcStationList), ...values(move.DestStationList), ...values(move.StationList)];
    if (!stations.map(String).includes(String(door.ModuleName))) return false;
    const materials = values(door.MatIDList).map(String);
    const transported = values(move.MatIDList).map(String);
    return !materials.length || !transported.length || materials.some(material => transported.includes(material));
  };
  const related = dependencies.filter(matches);
  const selected = related.length ? related : adjacent.filter(move => matches(move) && Math.abs(Number(closing ? move.EndTime : move.StartTime) - boundary) <= TIME_TOLERANCE);
  const robots = [...new Set(selected.map(move => String(move.Robot || move.ModuleName || "")).filter(Boolean))];
  return robots.length === 1 ? robots[0] : undefined;
}

/**
 * 以指定时间回放各 LoadLock 的两扇门，返回按模块名称索引的快照。
 * names 为已识别的 LoadLock；moves 需使用同一代归一化时间线。无副作用，支持反向拖动。
 */
export function projectLoadLockDoors(moves: MoveRecord[], device: DeviceDefinition | null, time: number, names: string[]): Map<string, LoadLockDoors> {
  const result = new Map<string, LoadLockDoors>();
  const transfers = indexTransfers(moves);
  for (const name of names) {
    const station = device?.Stations?.[name];
    const preparations = values(station?.PrePrepareTime) as Record<string, unknown>[];
    const linkedNames = preparations.flatMap(item => [String(item.LastItem ?? ""), String(item.CurrentItem ?? "")]);
    const bridge = linkedNames.some(robot => robotKind(robot, device) === "upper") || /^(UBR|DBR)$/i.test(name);
    const doors: LoadLockDoors = { top: "closed", bottom: "closed", topLabel: bridge ? "上级真空侧" : "真空侧", bottomLabel: bridge ? "下级真空侧" : "大气侧" };
    /** 将访问 Robot 映射到画布中的物理门方向。 */
    const sideForRobot = (robot: string): DoorSide | undefined => {
      const kind = robotKind(robot, device);
      if (bridge) return kind === "upper" ? "top" : kind === "vacuum" ? "bottom" : undefined;
      return kind === "atmosphere" ? "bottom" : kind === "vacuum" || kind === "upper" ? "top" : undefined;
    };
    let previousSide: DoorSide | undefined;
    let environmentRobot = String(station?.LastItem ?? "");
    for (const move of moves) {
      if (move.ModuleName !== name || Number(move.StartTime) > time) continue;
      if (move.MoveType === 10 && Number(move.EndTime) <= time) environmentRobot = String(move.CurState ?? "");
      if (move.MoveType !== PREPARE && move.MoveType !== COMPLETE) continue;
      const robot = relatedRobot(move, transfers);
      let side = robot ? sideForRobot(robot) : undefined;
      if (!side && move.MoveType === COMPLETE) side = previousSide;
      // 日志内部枚举为 0=大气、1=真空；级联腔必须依靠实际 Robot，不能套用全局分类。
      if (!side && !bridge) side = move.RelatedRobotType === RELATED_ATMOSPHERE ? "bottom"
        : move.RelatedRobotType === RELATED_VACUUM ? "top" : undefined;
      if (!side) side = sideForRobot(environmentRobot);
      const completed = Number(move.EndTime) <= time;
      if (side) {
        doors[side] = move.MoveType === PREPARE ? (completed ? "open" : "opening") : (completed ? "closed" : "closing");
        previousSide = side;
      } else {
        // 不制造双侧开门；只有无法归属的门态显示灰色虚线。
        doors.top = doors.bottom = move.MoveType === COMPLETE && completed ? "closed" : "unknown";
      }
    }
    result.set(name, doors);
  }
  return result;
}
