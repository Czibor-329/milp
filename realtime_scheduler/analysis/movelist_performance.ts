/**
 * 可复用的 MoveList 性能分析。
 *
 * 只包含协议解析与统计计算，不依赖 DOM、页面状态或网络请求。
 */

type UnknownRecord = Record<string, unknown>;

export interface MoveRecord extends UnknownRecord {
  MoveID?: number;
  MoveType?: number;
  ModuleName?: string;
  StartTime?: number;
  EndTime?: number;
}
export interface DeviceDefinition {
  Stations?: Record<string, UnknownRecord>;
  Robots?: Record<string, UnknownRecord>;
}
export type PerformanceWindowMode = "steady" | "full";
export type ActivityCategory = "process" | "clean" | "door" | "transfer" | "environment" | "other";
export type ResourceKind = "robot" | "process" | "loadlock" | "loadport" | "auxiliary";
export interface PerformanceWindow {
  mode: PerformanceWindowMode;
  method: "steady-overlap" | "middle-approximation" | "full";
  start: number; end: number; duration: number;
  scheduleStart: number; scheduleEnd: number;
  trimmedStart: number; trimmedEnd: number;
  label: string; detail: string;
}
export interface ResourcePerformance {
  name: string; type: string; kind: ResourceKind;
  utilization: number; busyTime: number;
  averageActivePeriod: number; longestActivePeriod: number; longestIdlePeriod: number;
  activePeriodCount: number;
  categoryTimes: Record<ActivityCategory, number>;
  isBottleneck: boolean;
  bottleneckCandidateRank: number | null;
}
export type BottleneckCandidateKind = "process-group" | "robot" | "loadlock-group";
export type BottleneckConfidence = "high" | "medium" | "low";
export interface ProcessStageDefinition {
  id: string;
  label?: string;
  pjobName?: string;
  stepId?: string | number;
  resourceNames: string[];
}
export interface ScheduleAnalysisContext {
  processStages?: ProcessStageDefinition[];
}
export interface BottleneckCandidate {
  id: string;
  label: string;
  kind: BottleneckCandidateKind;
  resourceNames: string[];
  utilization: number;
  continuity: number;
  score: number;
  confidence: BottleneckConfidence;
  evidence: string[];
}
export interface LoadLockCycle {
  index: number;
  loadLock: string;
  vacuumWafers: string[];
  ventWafers: string[];
  startTime: number;
  pumpEndTime: number;
  ventStartTime: number;
  ventEndTime: number;
}
export interface DurationMetricSummary {
  totalSeconds: number;
  meanSeconds: number;
  medianSeconds: number;
  maxSeconds: number;
  coefficientOfVariation: number;
  sampleCount: number;
}
export interface WaferResidenceTime {
  wafer: string;
  enteredAt: number;
  completedAt: number;
  duration: number;
}
export interface SchedulePerformance {
  window: PerformanceWindow;
  resources: ResourcePerformance[];
  bottleneckCandidates: BottleneckCandidate[];
  primaryBottleneck: BottleneckCandidate | null;
  /** @deprecated 兼容旧调用方；新界面应使用 primaryBottleneck。 */
  bottleneck: ResourcePerformance | null;
  completedWaferCount: number; throughputPerHour: number;
  meanDepartureInterval: number; departureIntervalCv: number;
  processChamberDwellTime: DurationMetricSummary;
  robotWaferDwellTime: DurationMetricSummary;
  waferSystemResidenceTime: DurationMetricSummary;
  waferSystemResidenceTimes: WaferResidenceTime[];
  loadLockCycles: LoadLockCycle[];
}
export interface BottleneckUtilizationSummary {
  resourceName: string; utilization: number; windowLabel: string;
  confidence: BottleneckConfidence;
  candidateCount: number;
  score: number;
}
interface NormalizedMove extends MoveRecord {
  MoveID: number; MoveType: number; ModuleName: string; StartTime: number; EndTime: number;
}

export const PERFORMANCE_TIME_TOLERANCE = 1e-6;
const MIDDLE_WINDOW_TRIM_RATIO = 0.1;
const MINIMUM_STEADY_WAFERS = 4;
const PICK_MOVE_TYPES = new Set([0, 2]);
const PLACE_MOVE_TYPES = new Set([1, 3]);
const SWAP_MOVE = 4;
const PRE_TRANS_MOVE = 5;
const PREPARE_MOVE = 6;
const COMPLETE_MOVE = 7;
const PROCESS_MOVE = 9;
const PRE_PREPARE_MOVE = 10;
const CLEAN_MOVE = 14;
const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  "process", "clean", "door", "transfer", "environment", "other",
];

/** 把未知值规范为有限数字。 */
function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 把协议中的列表字段规范为数组。 */
function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 返回稳定、适合人眼阅读的自然排序结果。 */
function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/** 返回动作引用的物料 ID。 */
function materialIds(move: MoveRecord, field = "MatIDList"): string[] {
  return listValue(move[field]).map(String).filter(Boolean);
}

/** 返回动作引用的第一个站点。 */
function firstStation(move: MoveRecord, field: string): string {
  return String(listValue(move[field])[0] ?? "");
}

/** 读取传输动作的机器人名称，兼容 Robot 与 ModuleName 两种协议字段。 */
function moveRobotName(move: MoveRecord): string {
  return String(move.Robot ?? move.ModuleName ?? "").trim();
}

/** 判断名称是否代表机器人。 */
function isRobotName(name: string): boolean {
  return /^(ATR|VTR|TM\d*|ROBOT)/i.test(name);
}

/** 判断名称是否代表参考拓扑中的 Dummy Port，而不是正常装载端口。 */
function isDummyPortName(name: string): boolean {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}

/** 判断名称是否代表装载端口。 */
function isLoadPortName(name: string, type = ""): boolean {
  return !isDummyPortName(name)
    && (type.toLowerCase() === "loadport" || /^(LP\d*|P\d+|.*PORT)$/i.test(name));
}

/** 判断名称是否代表 LoadLock 或真空缓冲腔。 */
function isLoadLockName(name: string, type = ""): boolean {
  return type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name) || /^BUF_/i.test(name);
}

/** 判断模块是否属于围绕 VTR 排列的工艺腔室。 */
function isProcessModule(name: string, type = ""): boolean {
  const normalizedType = type.toLowerCase();
  return /process|chamber/.test(normalizedType) || /^(PM|CH)\w*/i.test(name);
}

/** 从输入 JSON 中提取 MoveList。 */
export function normalizeMovePayload(payload: unknown): MoveRecord[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as UnknownRecord).MoveList)
      ? (payload as UnknownRecord).MoveList as unknown[]
      : null;
  if (!records) throw new Error("文件必须是 MoveList 数组，或包含 MoveList 字段的 JSON 对象");
  return records
    .filter((record): record is UnknownRecord => Boolean(record) && typeof record === "object" && !Array.isArray(record))
    .map(record => ({ ...record }));
}

/** 规范化时间字段并保证回放顺序稳定。 */
function normalizeMoves(moves: MoveRecord[]): NormalizedMove[] {
  return moves.map((move, index) => {
    const startTime = finiteNumber(move.StartTime);
    const endTime = Math.max(startTime, finiteNumber(move.EndTime, startTime));
    return {
      ...move,
      MoveID: finiteNumber(move.MoveID, index + 1),
      MoveType: finiteNumber(move.MoveType, -1),
      ModuleName: String(move.ModuleName ?? ""),
      StartTime: startTime,
      EndTime: endTime,
    };
  }).sort((left, right) => (
    left.StartTime - right.StartTime
    || left.EndTime - right.EndTime
    || left.MoveID - right.MoveID
  ));
}
interface ActivityInterval {
  start: number;
  end: number;
  category: ActivityCategory;
}

interface IntervalSummary {
  busyTime: number;
  averageActivePeriod: number;
  longestActivePeriod: number;
  longestIdlePeriod: number;
  activePeriodCount: number;
  categoryTimes: Record<ActivityCategory, number>;
}

/** 创建各动作类型时间均为零的资源占用组成。 */
function emptyCategoryTimes(): Record<ActivityCategory, number> {
  return {
    process: 0,
    clean: 0,
    door: 0,
    transfer: 0,
    environment: 0,
    other: 0,
  };
}

/** 把 MoveType 映射为性能诊断使用的物理活动类别。 */
function activityCategory(moveType: number): ActivityCategory {
  if (moveType === PROCESS_MOVE) return "process";
  if (moveType === CLEAN_MOVE) return "clean";
  if ([PREPARE_MOVE, COMPLETE_MOVE].includes(moveType)) return "door";
  if (moveType === PRE_PREPARE_MOVE || [12, 13].includes(moveType)) return "environment";
  if (PICK_MOVE_TYPES.has(moveType) || PLACE_MOVE_TYPES.has(moveType) || [SWAP_MOVE, 5].includes(moveType)) {
    return "transfer";
  }
  return "other";
}

/** 返回一个 Move 实际占用的机械手和腔室资源。 */
function activityResourceNames(move: NormalizedMove): string[] {
  const names = new Set<string>();
  if (move.ModuleName) names.add(move.ModuleName);
  if (PICK_MOVE_TYPES.has(move.MoveType)) {
    const source = firstStation(move, "SrcStationList");
    if (source) names.add(source);
  } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
    const destination = firstStation(move, "DestStationList");
    if (destination) names.add(destination);
  } else if (move.MoveType === SWAP_MOVE) {
    for (const station of listValue(move.StationList).map(String).filter(Boolean)) names.add(station);
  }
  return [...names];
}

/** 返回设备定义中一个站点的类型。 */
function stationType(device: DeviceDefinition | null, name: string): string {
  return String(device?.Stations?.[name]?.Type ?? "");
}

/** 将资源名称归入机械手、工艺腔、LoadLock 等稳定类别。 */
function resourceKind(name: string, type: string): ResourceKind {
  if (isRobotName(name)) return "robot";
  if (isProcessModule(name, type)) return "process";
  if (isLoadLockName(name, type)) return "loadlock";
  if (isLoadPortName(name, type)) return "loadport";
  return "auxiliary";
}

/** 收集性能表所需资源；工艺腔和 LoadLock 即使未使用也保留。 */
function performanceResourceDefinitions(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
): Map<string, { type: string; kind: ResourceKind }> {
  const referenced = new Set(moves.flatMap(activityResourceNames));
  const resources = new Map<string, { type: string; kind: ResourceKind }>();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    const type = String(definition.Type ?? "");
    if (referenced.has(name) || isProcessModule(name, type) || isLoadLockName(name, type)) {
      resources.set(name, { type, kind: resourceKind(name, type) });
    }
  }
  for (const name of Object.keys(device?.Robots ?? {})) {
    resources.set(name, { type: "Robot", kind: "robot" });
  }
  for (const name of referenced) {
    if (!resources.has(name)) {
      const type = stationType(device, name);
      resources.set(name, { type, kind: resourceKind(name, type) });
    }
  }
  return resources;
}

/** 按资源建立完整 MoveList 的物理占用区间。 */
function resourceActivityIntervals(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
): Map<string, ActivityInterval[]> {
  const intervals = new Map<string, ActivityInterval[]>();
  for (const name of performanceResourceDefinitions(moves, device).keys()) intervals.set(name, []);
  for (const move of moves) {
    if (move.EndTime <= move.StartTime + PERFORMANCE_TIME_TOLERANCE) continue;
    const interval = {
      start: move.StartTime,
      end: move.EndTime,
      category: activityCategory(move.MoveType),
    };
    for (const name of activityResourceNames(move)) {
      const resourceIntervals = intervals.get(name) ?? [];
      resourceIntervals.push(interval);
      intervals.set(name, resourceIntervals);
    }
  }
  return intervals;
}

/** 在统计窗口内合并重叠区间，并计算 Active Period 与最长空闲。 */
function summarizeIntervals(
  intervals: ActivityInterval[],
  windowStart: number,
  windowEnd: number,
): IntervalSummary {
  const categoryTimes = emptyCategoryTimes();
  const clipped = intervals
    .map(interval => ({
      ...interval,
      start: Math.max(windowStart, interval.start),
      end: Math.min(windowEnd, interval.end),
    }))
    .filter(interval => interval.end > interval.start + PERFORMANCE_TIME_TOLERANCE);
  if (windowEnd <= windowStart + PERFORMANCE_TIME_TOLERANCE) {
    return {
      busyTime: 0,
      averageActivePeriod: 0,
      longestActivePeriod: 0,
      longestIdlePeriod: 0,
      activePeriodCount: 0,
      categoryTimes,
    };
  }
  const points = [...new Set([
    windowStart,
    windowEnd,
    ...clipped.flatMap(interval => [interval.start, interval.end]),
  ])].sort((left, right) => left - right);
  const activePeriods: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start + PERFORMANCE_TIME_TOLERANCE) continue;
    const active = clipped.filter(interval => (
      interval.start < end - PERFORMANCE_TIME_TOLERANCE
      && interval.end > start + PERFORMANCE_TIME_TOLERANCE
    ));
    if (!active.length) continue;
    const category = ACTIVITY_CATEGORIES.find(candidate => (
      active.some(interval => interval.category === candidate)
    )) ?? "other";
    categoryTimes[category] += end - start;
    const previous = activePeriods.at(-1);
    if (previous && start <= previous.end + PERFORMANCE_TIME_TOLERANCE) previous.end = end;
    else activePeriods.push({ start, end });
  }
  const activeDurations = activePeriods.map(period => period.end - period.start);
  const busyTime = activeDurations.reduce((sum, duration) => sum + duration, 0);
  const idleDurations: number[] = [];
  let cursor = windowStart;
  for (const period of activePeriods) {
    if (period.start > cursor + PERFORMANCE_TIME_TOLERANCE) idleDurations.push(period.start - cursor);
    cursor = Math.max(cursor, period.end);
  }
  if (cursor < windowEnd - PERFORMANCE_TIME_TOLERANCE) idleDurations.push(windowEnd - cursor);
  return {
    busyTime,
    averageActivePeriod: activeDurations.length ? busyTime / activeDurations.length : 0,
    longestActivePeriod: Math.max(0, ...activeDurations),
    longestIdlePeriod: Math.max(0, ...idleDurations),
    activePeriodCount: activeDurations.length,
    categoryTimes,
  };
}

/** 收集晶圆从 LoadPort 离开和返回 LoadPort 的时刻。 */
function waferBoundaryTimes(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
): { entries: Map<string, number>; completions: Map<string, number> } {
  const entries = new Map<string, number>();
  const completions = new Map<string, number>();
  for (const move of moves) {
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      const source = firstStation(move, "SrcStationList");
      if (isLoadPortName(source, stationType(device, source))) {
        for (const material of materialIds(move)) {
          if (!entries.has(material)) entries.set(material, move.EndTime);
        }
      }
    } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
      const destination = firstStation(move, "DestStationList");
      if (isLoadPortName(destination, stationType(device, destination))) {
        for (const material of materialIds(move)) completions.set(material, move.EndTime);
      }
    } else if (move.MoveType === SWAP_MOVE) {
      const station = firstStation(move, "StationList");
      if (!isLoadPortName(station, stationType(device, station))) continue;
      for (const material of materialIds(move, "SendMatList")) {
        if (!entries.has(material)) entries.set(material, move.EndTime);
      }
      for (const material of materialIds(move, "RecvMatList")) {
        completions.set(material, move.EndTime);
      }
    }
  }
  return { entries, completions };
}

/** 由首片完工和末片投料自动剔除启动、收尾瞬态。 */
function performanceWindow(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
  mode: PerformanceWindowMode,
): PerformanceWindow {
  const scheduleStart = moves.length ? Math.min(...moves.map(move => move.StartTime)) : 0;
  const scheduleEnd = moves.length ? Math.max(...moves.map(move => move.EndTime)) : 0;
  const scheduleDuration = Math.max(scheduleEnd - scheduleStart, 0);
  if (mode === "full" || scheduleDuration <= PERFORMANCE_TIME_TOLERANCE) {
    return {
      mode,
      method: "full",
      start: scheduleStart,
      end: scheduleEnd,
      duration: scheduleDuration,
      scheduleStart,
      scheduleEnd,
      trimmedStart: 0,
      trimmedEnd: 0,
      label: "完整周期",
      detail: "从第一条 Move 开始到最后一条 Move 结束，包含启动与收尾阶段。",
    };
  }
  const boundaries = waferBoundaryTimes(moves, device);
  const entryTimes = [...boundaries.entries.values()];
  const completionTimes = [...boundaries.completions.values()];
  const firstCompletion = Math.min(...completionTimes);
  const lastEntry = Math.max(...entryTimes);
  const hasSteadyOverlap = (
    entryTimes.length >= MINIMUM_STEADY_WAFERS
    && completionTimes.length >= MINIMUM_STEADY_WAFERS
    && Number.isFinite(firstCompletion)
    && Number.isFinite(lastEntry)
    && lastEntry > firstCompletion + PERFORMANCE_TIME_TOLERANCE
  );
  const start = hasSteadyOverlap
    ? firstCompletion
    : scheduleStart + scheduleDuration * MIDDLE_WINDOW_TRIM_RATIO;
  const end = hasSteadyOverlap
    ? lastEntry
    : scheduleEnd - scheduleDuration * MIDDLE_WINDOW_TRIM_RATIO;
  return {
    mode,
    method: hasSteadyOverlap ? "steady-overlap" : "middle-approximation",
    start,
    end,
    duration: Math.max(end - start, 0),
    scheduleStart,
    scheduleEnd,
    trimmedStart: Math.max(start - scheduleStart, 0),
    trimmedEnd: Math.max(scheduleEnd - end, 0),
    label: hasSteadyOverlap ? "稳态交叠窗" : "中段近似窗",
    detail: hasSteadyOverlap
      ? "首片返回 LoadPort 后开始、末片离开 LoadPort 时结束，自动排除启动填充和末批排空。"
      : "样本没有形成可靠的首片完工—末片投料交叠，暂按时间轴两端各剔除 10%。",
  };
}

/** 计算一组正间隔的变异系数，衡量出站是否成团。 */
function intervalCoefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= PERFORMANCE_TIME_TOLERANCE) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** 计算一组时长的中位数。 */
function medianDuration(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** 汇总时长样本，统一输出均值、极值、CV 与样本数。 */
function summarizeDurations(values: number[]): DurationMetricSummary {
  const durations = values.filter(value => (
    Number.isFinite(value) && value >= -PERFORMANCE_TIME_TOLERANCE
  )).map(value => Math.max(0, value));
  const totalSeconds = durations.reduce((sum, value) => sum + value, 0);
  return {
    totalSeconds,
    meanSeconds: durations.length ? totalSeconds / durations.length : 0,
    medianSeconds: medianDuration(durations),
    maxSeconds: Math.max(0, ...durations),
    coefficientOfVariation: intervalCoefficientOfVariation(durations),
    sampleCount: durations.length,
  };
}

/** 判断以结束事件归属统计窗口的时长样本是否应被计入。 */
function completionInsideWindow(completedAt: number, window: PerformanceWindow): boolean {
  return (
    completedAt >= window.start - PERFORMANCE_TIME_TOLERANCE
    && completedAt <= window.end + PERFORMANCE_TIME_TOLERANCE
  );
}

/** 统计加工完成后至晶圆被完全移出加工腔的驻留时间。 */
function processChamberDwellTime(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
  window: PerformanceWindow,
): DurationMetricSummary {
  const durations: number[] = [];
  for (const processMove of moves) {
    const chamber = processMove.ModuleName;
    if (
      processMove.MoveType !== PROCESS_MOVE
      || !isProcessModule(chamber, stationType(device, chamber))
    ) continue;
    for (const material of materialIds(processMove)) {
      const removal = moves.find(candidate => {
        if (candidate.EndTime < processMove.EndTime - PERFORMANCE_TIME_TOLERANCE) return false;
        if (
          PICK_MOVE_TYPES.has(candidate.MoveType)
          && firstStation(candidate, "SrcStationList") === chamber
          && materialIds(candidate).includes(material)
        ) return true;
        return (
          candidate.MoveType === SWAP_MOVE
          && firstStation(candidate, "StationList") === chamber
          && materialIds(candidate, "SendMatList").includes(material)
        );
      });
      if (!removal || !completionInsideWindow(removal.EndTime, window)) continue;
      durations.push(removal.EndTime - processMove.EndTime);
    }
  }
  return summarizeDurations(durations);
}

interface PlainInterval {
  start: number;
  end: number;
}

/** 计算一组区间在指定边界内覆盖的时间并集。 */
function coveredDuration(
  intervals: PlainInterval[],
  boundaryStart: number,
  boundaryEnd: number,
): number {
  const clipped = intervals
    .map(interval => ({
      start: Math.max(interval.start, boundaryStart),
      end: Math.min(interval.end, boundaryEnd),
    }))
    .filter(interval => interval.end > interval.start + PERFORMANCE_TIME_TOLERANCE)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let activeStart: number | null = null;
  let activeEnd = 0;
  for (const interval of clipped) {
    if (activeStart === null) {
      activeStart = interval.start;
      activeEnd = interval.end;
    } else if (interval.start <= activeEnd + PERFORMANCE_TIME_TOLERANCE) {
      activeEnd = Math.max(activeEnd, interval.end);
    } else {
      total += activeEnd - activeStart;
      activeStart = interval.start;
      activeEnd = interval.end;
    }
  }
  return activeStart === null ? total : total + activeEnd - activeStart;
}

/** 统计晶圆被机器人持有期间的非运输等待，剔除显式 PreTrans 区间。 */
function robotWaferDwellTime(
  moves: NormalizedMove[],
  window: PerformanceWindow,
): DurationMetricSummary {
  const transportByRobot = new Map<string, PlainInterval[]>();
  for (const move of moves) {
    if (move.MoveType !== PRE_TRANS_MOVE || move.EndTime <= move.StartTime) continue;
    const robot = moveRobotName(move);
    if (!robot) continue;
    const intervals = transportByRobot.get(robot) ?? [];
    intervals.push({ start: move.StartTime, end: move.EndTime });
    transportByRobot.set(robot, intervals);
  }

  const holdingStartedAt = new Map<string, number>();
  const durations: number[] = [];
  const finishHolding = (
    robot: string,
    materials: string[],
    finishedAt: number,
  ): void => {
    for (const material of materials) {
      const key = `${robot}\u0000${material}`;
      const startedAt = holdingStartedAt.get(key);
      if (startedAt === undefined) continue;
      holdingStartedAt.delete(key);
      if (!completionInsideWindow(finishedAt, window)) continue;
      const rawDuration = Math.max(finishedAt - startedAt, 0);
      const transportDuration = coveredDuration(
        transportByRobot.get(robot) ?? [],
        startedAt,
        finishedAt,
      );
      durations.push(Math.max(rawDuration - transportDuration, 0));
    }
  };

  for (const move of moves) {
    const robot = moveRobotName(move);
    if (!robot) continue;
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      for (const material of materialIds(move)) {
        holdingStartedAt.set(`${robot}\u0000${material}`, move.EndTime);
      }
    } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
      finishHolding(robot, materialIds(move), move.StartTime);
    } else if (move.MoveType === SWAP_MOVE) {
      finishHolding(robot, materialIds(move, "SendMatList"), move.StartTime);
      for (const material of materialIds(move, "RecvMatList")) {
        holdingStartedAt.set(`${robot}\u0000${material}`, move.EndTime);
      }
    }
  }
  return summarizeDurations(durations);
}

/** 返回完整结果中每片晶圆离开 LoadPort 到返回 LoadPort 的系统停留时间。 */
function waferSystemResidenceTimes(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
): WaferResidenceTime[] {
  const boundaries = waferBoundaryTimes(moves, device);
  const samples: WaferResidenceTime[] = [];
  for (const [material, completedAt] of boundaries.completions) {
    const enteredAt = boundaries.entries.get(material);
    if (
      enteredAt === undefined
      || completedAt < enteredAt - PERFORMANCE_TIME_TOLERANCE
    ) continue;
    samples.push({
      wafer: material,
      enteredAt,
      completedAt,
      duration: completedAt - enteredAt,
    });
  }
  return samples.sort((left, right) => (
    left.completedAt - right.completedAt || naturalCompare(left.wafer, right.wafer)
  ));
}

interface PendingLoadLockCycle extends LoadLockCycle {
  startedAt: number;
  vacuumEndTime: number;
}

/** 判断 LoadLock 环境动作是抽气还是充气。 */
function loadLockTransitionDirection(move: NormalizedMove): "vacuum" | "vent" | null {
  const lastState = String(move.LastState ?? "").toUpperCase();
  const currentState = String(move.CurState ?? "").toUpperCase();
  if (lastState === "ATM" && currentState === "VAC") return "vacuum";
  if (lastState === "VAC" && currentState === "ATM") return "vent";
  if (move.MoveType === 12) return "vacuum";
  if (move.MoveType === 13) return "vent";
  return null;
}

/** 按时间把每个 LoadLock 的一次抽气和随后一次充气配成一行。 */
function buildLoadLockCycles(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
): LoadLockCycle[] {
  const cycles: PendingLoadLockCycle[] = [];
  const pendingByLoadLock = new Map<string, PendingLoadLockCycle>();
  for (const move of moves) {
    const direction = loadLockTransitionDirection(move);
    const loadLock = move.ModuleName;
    if (!direction || !isLoadLockName(loadLock, stationType(device, loadLock))) continue;
    if (direction === "vacuum") {
      const cycle: PendingLoadLockCycle = {
        index: 0,
        loadLock,
        vacuumWafers: materialIds(move),
        ventWafers: [],
        startTime: move.StartTime,
        pumpEndTime: move.EndTime,
        ventStartTime: 0,
        ventEndTime: 0,
        startedAt: move.StartTime,
        vacuumEndTime: move.EndTime,
      };
      cycles.push(cycle);
      pendingByLoadLock.set(loadLock, cycle);
      continue;
    }
    const pending = pendingByLoadLock.get(loadLock);
    if (pending) {
      pending.ventWafers = materialIds(move);
      pending.ventStartTime = move.StartTime;
      pending.ventEndTime = move.EndTime;
      pendingByLoadLock.delete(loadLock);
      continue;
    }
    cycles.push({
      index: 0,
      loadLock,
      vacuumWafers: [],
      ventWafers: materialIds(move),
      startTime: move.StartTime,
      pumpEndTime: move.StartTime,
      ventStartTime: move.StartTime,
      ventEndTime: move.EndTime,
      startedAt: move.StartTime,
      vacuumEndTime: move.StartTime,
    });
  }
  return cycles
    .sort((left, right) => left.startedAt - right.startedAt || naturalCompare(left.loadLock, right.loadLock))
    .map((cycle, index) => ({
      index: index + 1,
      loadLock: cycle.loadLock,
      vacuumWafers: cycle.vacuumWafers,
      ventWafers: cycle.ventWafers,
      startTime: cycle.startTime,
      pumpEndTime: cycle.pumpEndTime,
      ventStartTime: cycle.ventStartTime,
      ventEndTime: cycle.ventEndTime,
    }));
}

interface RawBottleneckCandidate {
  id: string;
  label: string;
  kind: BottleneckCandidateKind;
  resourceNames: string[];
  utilization: number;
  continuity: number;
  contextLabels: string[];
}

/** 把 PJob 全名压缩成稳定的末级名称，兼容上下文和 MoveList 使用不同前缀。 */
function shortJobName(value: unknown): string {
  const parts = String(value ?? "").split(".").filter(Boolean);
  return parts.at(-1) ?? "";
}

/** 读取 ProcessMove 的工序编号。 */
function processStepId(move: NormalizedMove): string {
  const direct = move.StepID;
  if (direct !== undefined && direct !== null && String(direct) !== "") return String(direct);
  return String(listValue(move.StepIDList)[0] ?? "");
}

/** 读取 ProcessMove 的 PJob。 */
function processPJobName(move: NormalizedMove): string {
  return String(listValue(move.PJobName)[0] ?? move.PJobName ?? "");
}

/** 判断配置中的工序定义是否对应一个实际 ProcessMove。 */
function stageMatchesMove(stage: ProcessStageDefinition, move: NormalizedMove): boolean {
  const configuredStep = stage.stepId === undefined || stage.stepId === null
    ? ""
    : String(stage.stepId);
  if (configuredStep && configuredStep !== processStepId(move)) return false;
  const configuredJob = shortJobName(stage.pjobName);
  const moveJob = shortJobName(processPJobName(move));
  return !configuredJob || !moveJob || configuredJob === moveJob;
}

/** 将并行工艺腔折叠成容量组；同一组被多个 Job/工序复用时只保留一次。 */
function processCapacityGroups(
  moves: NormalizedMove[],
  resources: ResourcePerformance[],
  context: ScheduleAnalysisContext | null,
): Array<{ resourceNames: string[]; contextLabels: string[] }> {
  const processResourceNames = new Set(
    resources.filter(resource => resource.kind === "process").map(resource => resource.name),
  );
  const observed = moves.filter(move => (
    move.MoveType === PROCESS_MOVE
    && move.EndTime > move.StartTime + PERFORMANCE_TIME_TOLERANCE
    && processResourceNames.has(move.ModuleName)
  ));
  const groups: Array<{ resourceNames: Set<string>; contextLabels: Set<string> }> = [];

  for (const stage of context?.processStages ?? []) {
    const names = stage.resourceNames
      .map(String)
      .filter(name => processResourceNames.has(name));
    if (!names.length) continue;
    groups.push({
      resourceNames: new Set(names),
      contextLabels: new Set(stage.label ? [String(stage.label)] : []),
    });
  }

  const unmatchedByStage = new Map<string, Set<string>>();
  for (const move of observed) {
    let matching = (context?.processStages ?? []).filter(stage => stageMatchesMove(stage, move));
    if (!matching.length) {
      const moveJob = shortJobName(processPJobName(move));
      matching = (context?.processStages ?? []).filter(stage => (
        stage.resourceNames.includes(move.ModuleName)
        && (!shortJobName(stage.pjobName) || shortJobName(stage.pjobName) === moveJob)
      ));
    }
    if (matching.length) continue;
    const key = `${processPJobName(move)}|${processStepId(move)}`;
    const names = unmatchedByStage.get(key) ?? new Set<string>();
    names.add(move.ModuleName);
    unmatchedByStage.set(key, names);
  }
  for (const [key, names] of unmatchedByStage) {
    groups.push({
      resourceNames: names,
      contextLabels: new Set([key.replace("|", " · 工序 ")]),
    });
  }

  const merged = new Map<string, { resourceNames: string[]; contextLabels: Set<string> }>();
  for (const group of groups) {
    const names = [...group.resourceNames].sort(naturalCompare);
    const key = names.join("|");
    const existing = merged.get(key) ?? { resourceNames: names, contextLabels: new Set<string>() };
    for (const label of group.contextLabels) existing.contextLabels.add(label);
    merged.set(key, existing);
  }
  return [...merged.values()].map(group => ({
    resourceNames: group.resourceNames,
    contextLabels: [...group.contextLabels].filter(Boolean).sort(naturalCompare),
  }));
}

/** 由容量占用、连续性和同类相对强度生成可比较的多资源瓶颈候选。 */
function rankBottleneckCandidates(
  moves: NormalizedMove[],
  resources: ResourcePerformance[],
  window: PerformanceWindow,
  context: ScheduleAnalysisContext | null,
): BottleneckCandidate[] {
  if (window.duration <= PERFORMANCE_TIME_TOLERANCE) return [];
  const byName = new Map(resources.map(resource => [resource.name, resource]));
  const raw: RawBottleneckCandidate[] = [];

  for (const group of processCapacityGroups(moves, resources, context)) {
    const members = group.resourceNames.map(name => byName.get(name)).filter(
      (resource): resource is ResourcePerformance => Boolean(resource),
    );
    const busyTime = members.reduce((sum, resource) => sum + resource.busyTime, 0);
    if (!members.length || busyTime <= PERFORMANCE_TIME_TOLERANCE) continue;
    raw.push({
      id: `process:${group.resourceNames.join("+")}`,
      label: `工序容量组 · ${group.resourceNames.join(" / ")}`,
      kind: "process-group",
      resourceNames: group.resourceNames,
      utilization: busyTime / (members.length * window.duration),
      continuity: members.reduce(
        (sum, resource) => sum + Math.max(0, 1 - resource.longestIdlePeriod / window.duration),
        0,
      ) / members.length,
      contextLabels: group.contextLabels,
    });
  }

  for (const resource of resources.filter(item => (
    item.kind === "robot" && item.busyTime > PERFORMANCE_TIME_TOLERANCE
  ))) {
    raw.push({
      id: `robot:${resource.name}`,
      label: resource.name,
      kind: "robot",
      resourceNames: [resource.name],
      utilization: resource.utilization,
      continuity: Math.max(0, 1 - resource.longestIdlePeriod / window.duration),
      contextLabels: [],
    });
  }

  const loadLocks = resources.filter(item => (
    item.kind === "loadlock" && item.busyTime > PERFORMANCE_TIME_TOLERANCE
  ));
  if (loadLocks.length) {
    raw.push({
      id: `loadlock:${loadLocks.map(resource => resource.name).sort(naturalCompare).join("+")}`,
      label: `LoadLock 容量组 · ${loadLocks.map(resource => resource.name).sort(naturalCompare).join(" / ")}`,
      kind: "loadlock-group",
      resourceNames: loadLocks.map(resource => resource.name).sort(naturalCompare),
      utilization: loadLocks.reduce((sum, resource) => sum + resource.busyTime, 0)
        / (loadLocks.length * window.duration),
      continuity: loadLocks.reduce(
        (sum, resource) => sum + Math.max(0, 1 - resource.longestIdlePeriod / window.duration),
        0,
      ) / loadLocks.length,
      contextLabels: [],
    });
  }

  const maximumByKind = new Map<BottleneckCandidateKind, number>();
  for (const candidate of raw) {
    maximumByKind.set(
      candidate.kind,
      Math.max(maximumByKind.get(candidate.kind) ?? 0, candidate.utilization),
    );
  }
  const ranked = raw.map(candidate => {
    const relative = candidate.utilization / Math.max(
      maximumByKind.get(candidate.kind) ?? 0,
      PERFORMANCE_TIME_TOLERANCE,
    );
    // 容量占用是跨类型比较的主体；连续性与同类排名仅用于打破接近结果。
    const score = Math.min(1, (
      candidate.utilization * 0.82
      + candidate.continuity * 0.12
      + relative * 0.06
    ));
    const confidence: BottleneckConfidence = score >= 0.72
      ? "high"
      : score >= 0.45 ? "medium" : "low";
    const evidence = [
      `${candidate.resourceNames.length > 1 ? "组平均容量占用" : "资源占用"} ${(candidate.utilization * 100).toFixed(1)}%`,
      `最长空闲折算连续性 ${(candidate.continuity * 100).toFixed(1)}%`,
    ];
    if (candidate.resourceNames.length > 1) {
      evidence.push(`并行/同类资源 ${candidate.resourceNames.join("、")}`);
    }
    if (candidate.contextLabels.length) {
      evidence.push(`关联 ${candidate.contextLabels.slice(0, 3).join("、")}`);
    }
    return {
      id: candidate.id,
      label: candidate.label,
      kind: candidate.kind,
      resourceNames: candidate.resourceNames,
      utilization: Math.max(0, Math.min(candidate.utilization, 1)),
      continuity: Math.max(0, Math.min(candidate.continuity, 1)),
      score,
      confidence,
      evidence,
    };
  }).sort((left, right) => (
    right.score - left.score
    || right.utilization - left.utilization
    || naturalCompare(left.label, right.label)
  ));
  if (!ranked.length) return [];
  const topScore = ranked[0].score;
  const likelyThreshold = Math.max(0.2, topScore * 0.72, topScore - 0.16);
  return ranked.filter(candidate => candidate.score >= likelyThreshold).slice(0, 5);
}

/** 从完整 MoveList 计算稳态资源占用、多候选瓶颈和真空端队列。 */
export function analyzeSchedulePerformance(
  moves: MoveRecord[],
  device: DeviceDefinition | null,
  mode: PerformanceWindowMode = "steady",
  context: ScheduleAnalysisContext | null = null,
): SchedulePerformance {
  const records = normalizeMoves(moves);
  const window = performanceWindow(records, device, mode);
  const definitions = performanceResourceDefinitions(records, device);
  const intervalsByResource = resourceActivityIntervals(records, device);
  const resources = [...definitions.entries()].map(([name, definition]): ResourcePerformance => {
    const summary = summarizeIntervals(
      intervalsByResource.get(name) ?? [],
      window.start,
      window.end,
    );
    return {
      name,
      type: definition.type,
      kind: definition.kind,
      utilization: window.duration > PERFORMANCE_TIME_TOLERANCE
        ? summary.busyTime / window.duration
        : 0,
      ...summary,
      isBottleneck: false,
      bottleneckCandidateRank: null,
    };
  });
  const bottleneckCandidates = rankBottleneckCandidates(
    records,
    resources,
    window,
    context,
  );
  const primaryBottleneck = bottleneckCandidates[0] ?? null;
  for (const [candidateIndex, candidate] of bottleneckCandidates.entries()) {
    for (const name of candidate.resourceNames) {
      const resource = resources.find(item => item.name === name);
      if (!resource) continue;
      resource.bottleneckCandidateRank = resource.bottleneckCandidateRank === null
        ? candidateIndex + 1
        : Math.min(resource.bottleneckCandidateRank, candidateIndex + 1);
      if (candidateIndex === 0) resource.isBottleneck = true;
    }
  }
  const bottleneck = primaryBottleneck
    ? resources.find(resource => primaryBottleneck.resourceNames.includes(resource.name)) ?? null
    : null;
  const kindOrder: Record<ResourceKind, number> = {
    robot: 0,
    loadlock: 1,
    process: 2,
    auxiliary: 3,
    loadport: 4,
  };
  resources.sort((left, right) => (
    Number(right.isBottleneck) - Number(left.isBottleneck)
    || kindOrder[left.kind] - kindOrder[right.kind]
    || right.utilization - left.utilization
    || naturalCompare(left.name, right.name)
  ));

  const boundaries = waferBoundaryTimes(records, device);
  const completionTimes = [...boundaries.completions.values()]
    .filter(time => (
      time >= window.start - PERFORMANCE_TIME_TOLERANCE
      && time <= window.end + PERFORMANCE_TIME_TOLERANCE
    ))
    .sort((left, right) => left - right);
  const departureIntervals = completionTimes.slice(1).map((time, index) => time - completionTimes[index]);
  const meanDepartureInterval = departureIntervals.length
    ? departureIntervals.reduce((sum, interval) => sum + interval, 0) / departureIntervals.length
    : 0;
  const throughputPerHour = meanDepartureInterval > PERFORMANCE_TIME_TOLERANCE
    ? 3600 / meanDepartureInterval
    : 0;
  const chamberDwellTime = processChamberDwellTime(records, device, window);
  const robotDwellTime = robotWaferDwellTime(records, window);
  const systemResidenceTimes = waferSystemResidenceTimes(records, device);
  const systemResidenceTime = summarizeDurations(
    systemResidenceTimes
      .filter(sample => completionInsideWindow(sample.completedAt, window))
      .map(sample => sample.duration),
  );
  const loadLockCycles = buildLoadLockCycles(records, device);
  return {
    window,
    resources,
    bottleneckCandidates,
    primaryBottleneck,
    bottleneck,
    completedWaferCount: completionTimes.length,
    throughputPerHour,
    meanDepartureInterval,
    departureIntervalCv: intervalCoefficientOfVariation(departureIntervals),
    processChamberDwellTime: chamberDwellTime,
    robotWaferDwellTime: robotDwellTime,
    waferSystemResidenceTime: systemResidenceTime,
    waferSystemResidenceTimes: systemResidenceTimes,
    loadLockCycles,
  };
}
/** 将完整性能诊断压缩为结果预览所需的瓶颈摘要。 */
export function summarizeBottleneckUtilization(
  performance: SchedulePerformance,
): BottleneckUtilizationSummary | null {
  const candidate = performance.primaryBottleneck;
  if (!candidate) return null;
  return {
    resourceName: candidate.label,
    utilization: candidate.utilization,
    windowLabel: performance.window.label,
    confidence: candidate.confidence,
    candidateCount: performance.bottleneckCandidates.length,
    score: candidate.score,
  };
}

/** 默认只展示统计窗口内发生过物理占用的资源。 */
export function displayedPerformanceResources(
  performance: SchedulePerformance,
): ResourcePerformance[] {
  return performance.resources.filter(
    resource => resource.busyTime > PERFORMANCE_TIME_TOLERANCE,
  );
}
