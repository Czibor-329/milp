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
}
export interface VacuumQueueItem {
  index: number; material: string; pjob: string; loadLock: string;
  admittedAt: number; targetModule: string; targetWasBusy: boolean; processWait: number;
}
export interface SchedulePerformance {
  window: PerformanceWindow;
  resources: ResourcePerformance[];
  bottleneck: ResourcePerformance | null;
  completedWaferCount: number; throughputPerHour: number;
  meanDepartureInterval: number; departureIntervalCv: number;
  vacuumQueue: VacuumQueueItem[];
  vacuumQueueJobSwitchRatio: number; vacuumQueueLongestRun: number;
}
export interface BottleneckUtilizationSummary {
  resourceName: string; utilization: number; windowLabel: string;
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

/** 返回物料在 Move 的并行列表字段中对应的 PJob 名称。 */
function materialPJob(move: NormalizedMove, material: string): string {
  const materials = materialIds(move);
  const jobs = listValue(move.PJobName).map(String);
  const index = materials.indexOf(material);
  return jobs[index] ?? jobs[0] ?? "";
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

/** 构造晶圆第一次从 LoadLock 进入真空机器人的可观察队列。 */
function buildVacuumQueue(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
  intervalsByResource: Map<string, ActivityInterval[]>,
): VacuumQueueItem[] {
  const admittedMaterials = new Set<string>();
  const queue: VacuumQueueItem[] = [];
  for (const move of moves) {
    if (/^ATR/i.test(move.ModuleName)) continue;
    const isPick = PICK_MOVE_TYPES.has(move.MoveType);
    const isLoadLockSwap = move.MoveType === SWAP_MOVE;
    if (!isPick && !isLoadLockSwap) continue;
    const source = isLoadLockSwap
      ? String(listValue(move.StationList)[0] ?? "")
      : firstStation(move, "SrcStationList");
    if (!isLoadLockName(source, stationType(device, source))) continue;
    const admitted = isLoadLockSwap ? materialIds(move, "RecvMatList") : materialIds(move);
    for (const material of admitted) {
      if (admittedMaterials.has(material)) continue;
      admittedMaterials.add(material);
      const targetPlacement = moves.find(candidate => (
        candidate.StartTime >= move.EndTime - PERFORMANCE_TIME_TOLERANCE
        && (
          (
            PLACE_MOVE_TYPES.has(candidate.MoveType)
            && materialIds(candidate).includes(material)
          )
          || (
            candidate.MoveType === SWAP_MOVE
            && materialIds(candidate, "SendMatList").includes(material)
          )
        )
        && isProcessModule(
          candidate.MoveType === SWAP_MOVE
            ? String(listValue(candidate.StationList)[0] ?? "")
            : firstStation(candidate, "DestStationList"),
          stationType(
            device,
            candidate.MoveType === SWAP_MOVE
              ? String(listValue(candidate.StationList)[0] ?? "")
              : firstStation(candidate, "DestStationList"),
          ),
        )
      ));
      const targetModule = targetPlacement
        ? targetPlacement.MoveType === SWAP_MOVE
          ? String(listValue(targetPlacement.StationList)[0] ?? "")
          : firstStation(targetPlacement, "DestStationList")
        : "";
      const processMove = moves.find(candidate => (
        candidate.StartTime >= move.EndTime - PERFORMANCE_TIME_TOLERANCE
        && candidate.MoveType === PROCESS_MOVE
        && candidate.ModuleName === targetModule
        && materialIds(candidate).includes(material)
      ));
      const admittedAt = move.EndTime;
      const targetWasBusy = Boolean(targetModule && (intervalsByResource.get(targetModule) ?? []).some(interval => (
        interval.start < admittedAt + PERFORMANCE_TIME_TOLERANCE
        && interval.end > admittedAt + PERFORMANCE_TIME_TOLERANCE
      )));
      queue.push({
        index: queue.length + 1,
        material,
        pjob: materialPJob(move, material),
        loadLock: source,
        admittedAt,
        targetModule,
        targetWasBusy,
        processWait: processMove ? Math.max(processMove.StartTime - admittedAt, 0) : 0,
      });
    }
  }
  return queue;
}

/** 统计真空端队列中相邻 Job 切换比例和最长连续段。 */
function vacuumQueuePattern(queue: VacuumQueueItem[]): { switchRatio: number; longestRun: number } {
  if (!queue.length) return { switchRatio: 0, longestRun: 0 };
  let switches = 0;
  let run = 1;
  let longestRun = 1;
  for (let index = 1; index < queue.length; index += 1) {
    if (queue[index].pjob === queue[index - 1].pjob) run += 1;
    else {
      switches += 1;
      run = 1;
    }
    longestRun = Math.max(longestRun, run);
  }
  return {
    switchRatio: queue.length > 1 ? switches / (queue.length - 1) : 0,
    longestRun,
  };
}
/** 从完整 MoveList 计算稳态资源占用、Active Period 和真空端队列。 */
export function analyzeSchedulePerformance(
  moves: MoveRecord[],
  device: DeviceDefinition | null,
  mode: PerformanceWindowMode = "steady",
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
    };
  });
  const bottleneckCandidates = resources.filter(resource => (
    ["robot", "process", "loadlock"].includes(resource.kind)
    && resource.busyTime > PERFORMANCE_TIME_TOLERANCE
  ));
  const bottleneck = [...bottleneckCandidates].sort((left, right) => (
    right.averageActivePeriod - left.averageActivePeriod
    || right.utilization - left.utilization
    || naturalCompare(left.name, right.name)
  ))[0] ?? null;
  if (bottleneck) bottleneck.isBottleneck = true;
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
  const vacuumQueue = buildVacuumQueue(records, device, intervalsByResource);
  const queuePattern = vacuumQueuePattern(vacuumQueue);
  return {
    window,
    resources,
    bottleneck,
    completedWaferCount: completionTimes.length,
    throughputPerHour,
    meanDepartureInterval,
    departureIntervalCv: intervalCoefficientOfVariation(departureIntervals),
    vacuumQueue,
    vacuumQueueJobSwitchRatio: queuePattern.switchRatio,
    vacuumQueueLongestRun: queuePattern.longestRun,
  };
}
/** 将完整性能诊断压缩为结果预览所需的瓶颈摘要。 */
export function summarizeBottleneckUtilization(
  performance: SchedulePerformance,
): BottleneckUtilizationSummary | null {
  if (!performance.bottleneck) return null;
  return {
    resourceName: performance.bottleneck.name,
    utilization: performance.bottleneck.utilization,
    windowLabel: performance.window.label,
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
