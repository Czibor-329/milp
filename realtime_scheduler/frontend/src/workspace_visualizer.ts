/**
 * MoveList 结果分析页面。
 *
 * 本模块负责把调度输出回放成设备、机器人、晶圆和腔室门的可观察状态，并管理
 * 时间轴、播放控制、结果加载和本地文件导入。纯回放函数可在浏览器之外独立测试；
 * DOM 控制器只负责把快照呈现到调度平台的“结果分析”页。
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

export type DoorStatus = "closed" | "opening" | "open" | "closing" | "doorless";
export type ModuleStatus = "idle" | "occupied" | "door" | "transfer" | "processing" | "cleaning" | "environment";

export interface ModuleSnapshot {
  name: string;
  type: string;
  status: ModuleStatus;
  door: DoorStatus;
  wafers: string[];
  activeMoveName: string;
  progress: number;
  environment: string;
  isRobotTarget: boolean;
}

export interface RobotSnapshot {
  name: string;
  wafers: string[];
  busy: boolean;
  target: string;
  activeMoveName: string;
}

export interface WorkspaceSnapshot {
  time: number;
  endTime: number;
  completedMoves: number;
  totalMoves: number;
  activeMoves: MoveRecord[];
  modules: ModuleSnapshot[];
  robots: RobotSnapshot[];
  waferCount: number;
}

export type PerformanceWindowMode = "steady" | "full";
export type ActivityCategory = "process" | "clean" | "door" | "transfer" | "environment" | "other";
export type ResourceKind = "robot" | "process" | "loadlock" | "loadport" | "auxiliary";

export interface PerformanceWindow {
  mode: PerformanceWindowMode;
  method: "steady-overlap" | "middle-approximation" | "full";
  start: number;
  end: number;
  duration: number;
  scheduleStart: number;
  scheduleEnd: number;
  trimmedStart: number;
  trimmedEnd: number;
  label: string;
  detail: string;
}

export interface ResourcePerformance {
  name: string;
  type: string;
  kind: ResourceKind;
  utilization: number;
  busyTime: number;
  averageActivePeriod: number;
  longestActivePeriod: number;
  longestIdlePeriod: number;
  activePeriodCount: number;
  categoryTimes: Record<ActivityCategory, number>;
  isBottleneck: boolean;
}

export interface VacuumQueueItem {
  index: number;
  material: string;
  pjob: string;
  loadLock: string;
  admittedAt: number;
  targetModule: string;
  targetWasBusy: boolean;
  processWait: number;
}

export interface SchedulePerformance {
  window: PerformanceWindow;
  resources: ResourcePerformance[];
  bottleneck: ResourcePerformance | null;
  completedWaferCount: number;
  throughputPerHour: number;
  meanDepartureInterval: number;
  departureIntervalCv: number;
  vacuumQueue: VacuumQueueItem[];
  vacuumQueueJobSwitchRatio: number;
  vacuumQueueLongestRun: number;
}

interface NormalizedMove extends MoveRecord {
  MoveID: number;
  MoveType: number;
  ModuleName: string;
  StartTime: number;
  EndTime: number;
}

interface WorkspaceElements {
  empty: HTMLElement;
  content: HTMLElement;
  stage: HTMLElement;
  activeMoves: HTMLElement;
  source: HTMLElement;
  currentTime: HTMLElement;
  totalTime: HTMLElement;
  progressText: HTMLElement;
  moveText: HTMLElement;
  waferText: HTMLElement;
  range: HTMLInputElement;
  playButton: HTMLButtonElement;
  speed: HTMLSelectElement;
  fileInput: HTMLInputElement;
  openGantt: HTMLAnchorElement;
  resultButton: HTMLButtonElement;
  performance: HTMLElement;
  performanceWindow: HTMLSelectElement;
}

const PICK_MOVE_TYPES = new Set([0, 2]);
const PLACE_MOVE_TYPES = new Set([1, 3]);
const SWAP_MOVE = 4;
const PREPARE_MOVE = 6;
const COMPLETE_MOVE = 7;
const PROCESS_MOVE = 9;
const PRE_PREPARE_MOVE = 10;
const CLEAN_MOVE = 14;
const PLAYBACK_FRAME_INTERVAL_MS = 80;
const DEFAULT_PLAYBACK_SPEED = 4;
const PROCESS_ARC_START_DEGREES = 200;
const PROCESS_ARC_END_DEGREES = 340;
const PROCESS_ARC_CENTER_X_PERCENT = 50;
const PROCESS_ARC_CENTER_Y_PIXELS = 214;
const PROCESS_ARC_RADIUS_X_PERCENT = 38;
const PROCESS_ARC_RADIUS_Y_PIXELS = 156;
const PERFORMANCE_TIME_TOLERANCE = 1e-6;
const MIDDLE_WINDOW_TRIM_RATIO = 0.1;
const MINIMUM_STEADY_WAFERS = 4;
const MAXIMUM_VISIBLE_QUEUE_ITEMS = 32;

const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  "process",
  "clean",
  "door",
  "transfer",
  "environment",
  "other",
];

const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  process: "加工",
  clean: "清洁",
  door: "开关门",
  transfer: "取放 / 搬运",
  environment: "抽充气",
  other: "其他",
};

const MOVE_NAMES: Record<number, string> = {
  0: "取片", 1: "放片", 2: "多片取片", 3: "多片放片", 4: "换片",
  5: "机械手转位", 6: "开门", 7: "关门", 8: "后置完成", 9: "加工",
  10: "环境切换", 11: "对准", 12: "抽真空", 13: "充气", 14: "清洁",
};

const STATUS_LABELS: Record<ModuleStatus, string> = {
  idle: "空闲",
  occupied: "已载片",
  door: "门动作",
  transfer: "传输中",
  processing: "加工中",
  cleaning: "清洁中",
  environment: "环境切换",
};

const DOOR_LABELS: Record<DoorStatus, string> = {
  closed: "门已关闭",
  opening: "正在开门",
  open: "门已打开",
  closing: "正在关门",
  doorless: "无门结构",
};

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

/** 转义将进入 innerHTML 的协议字段。 */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 把秒数格式化为固定但不冗余的显示文本。 */
function formatSeconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
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

/** 判断硬件是否没有可观察的腔室门。 */
function isDoorlessModule(name: string, type = ""): boolean {
  return /^cool(er)?$/i.test(name) || type.toLowerCase() === "cooler" || isDummyPortName(name);
}

/** 判断模块是否属于围绕 VTR 排列的工艺腔室。 */
function isProcessModule(name: string, type = ""): boolean {
  const normalizedType = type.toLowerCase();
  return /process|chamber/.test(normalizedType) || /^(PM|CH)\w*/i.test(name);
}

/** 从页面加载的 JSON 中提取 MoveList。 */
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

/** 收集设备定义和 MoveList 中出现过的全部站点。 */
function collectModuleDefinitions(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
): Map<string, { type: string }> {
  const modules = new Map<string, { type: string }>();
  const stationDefinitions = device?.Stations ?? {};
  for (const move of moves) {
    const candidates = [
      move.ModuleName,
      ...listValue(move.SrcStationList),
      ...listValue(move.DestStationList),
      ...listValue(move.StationList),
    ].map(String).filter(Boolean);
    for (const name of candidates) {
      if (!isRobotName(name) && !modules.has(name)) {
        modules.set(name, { type: String(stationDefinitions[name]?.Type ?? "") });
      }
    }
  }
  return modules;
}

/** 收集设备定义和 MoveList 中出现过的机器人。 */
function collectRobotNames(moves: NormalizedMove[], device: DeviceDefinition | null): string[] {
  const names = new Set(Object.keys(device?.Robots ?? {}));
  for (const move of moves) {
    if (isRobotName(move.ModuleName)) names.add(move.ModuleName);
    const robot = String(move.Robot ?? "");
    if (robot) names.add(robot);
  }
  return [...names].sort(naturalCompare);
}

/** 推断每片晶圆在时间零点的初始位置。 */
function initialMaterialLocations(moves: NormalizedMove[]): Map<string, string> {
  const locations = new Map<string, string>();
  for (const move of moves) {
    if (move.MoveType === SWAP_MOVE) {
      const station = String(listValue(move.StationList)[0] ?? "");
      for (const material of materialIds(move, "RecvMatList")) {
        if (!locations.has(material)) locations.set(material, move.ModuleName);
      }
      for (const material of materialIds(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, station);
      }
      continue;
    }
    const source = firstStation(move, "SrcStationList");
    const destination = firstStation(move, "DestStationList");
    const fallback = source
      || (PICK_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : "")
      || (PLACE_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : "")
      || destination
      || move.ModuleName;
    for (const material of materialIds(move)) {
      if (!locations.has(material) && fallback) locations.set(material, fallback);
    }
  }
  return locations;
}

/** 把已经完成的传输动作应用到晶圆位置。 */
function applyCompletedTransfer(move: NormalizedMove, locations: Map<string, string>): void {
  if (PICK_MOVE_TYPES.has(move.MoveType)) {
    for (const material of materialIds(move)) locations.set(material, move.ModuleName);
    return;
  }
  if (PLACE_MOVE_TYPES.has(move.MoveType)) {
    const destination = firstStation(move, "DestStationList");
    if (destination) {
      for (const material of materialIds(move)) locations.set(material, destination);
    }
    return;
  }
  if (move.MoveType === SWAP_MOVE) {
    const station = String(listValue(move.StationList)[0] ?? "");
    for (const material of materialIds(move, "RecvMatList")) locations.set(material, station);
    for (const material of materialIds(move, "SendMatList")) locations.set(material, move.ModuleName);
  }
}

/** 返回动作在给定时刻的线性进度。 */
function moveProgress(move: NormalizedMove, time: number): number {
  const duration = move.EndTime - move.StartTime;
  if (duration <= 0) return time >= move.EndTime ? 1 : 0;
  return Math.max(0, Math.min(1, (time - move.StartTime) / duration));
}

/** 返回动作关联的主要站点，用于高亮机器人目标。 */
function activeTarget(move: NormalizedMove): string {
  return firstStation(move, "DestStationList")
    || firstStation(move, "SrcStationList")
    || String(listValue(move.StationList)[0] ?? "")
    || (!isRobotName(move.ModuleName) ? move.ModuleName : "");
}

/** 根据 MoveList 和设备定义构造某个时刻的完整工作台快照。 */
export function buildWorkspaceSnapshot(
  moves: MoveRecord[],
  device: DeviceDefinition | null,
  requestedTime: number,
): WorkspaceSnapshot {
  const records = normalizeMoves(moves);
  const endTime = records.reduce((maximum, move) => Math.max(maximum, move.EndTime), 0);
  const time = Math.max(0, Math.min(finiteNumber(requestedTime), endTime));
  const definitions = collectModuleDefinitions(records, device);
  const robotNames = collectRobotNames(records, device);
  const locations = initialMaterialLocations(records);
  const doorStates = new Map<string, DoorStatus>();
  const environments = new Map<string, string>();
  const activeMoves: NormalizedMove[] = [];
  let completedMoves = 0;

  for (const [name, definition] of definitions) {
    doorStates.set(name, isDoorlessModule(name, definition.type) ? "doorless" : "closed");
  }

  for (const move of records) {
    const active = move.StartTime <= time && time < move.EndTime;
    const completed = move.EndTime <= time;
    if (active) activeMoves.push(move);
    if (completed) {
      completedMoves += 1;
      applyCompletedTransfer(move, locations);
    }

    if (move.MoveType === PREPARE_MOVE) {
      if (active) doorStates.set(move.ModuleName, "opening");
      else if (completed) doorStates.set(move.ModuleName, "open");
    } else if (move.MoveType === COMPLETE_MOVE) {
      if (active) doorStates.set(move.ModuleName, "closing");
      else if (completed) doorStates.set(move.ModuleName, "closed");
    } else if (move.MoveType === PRE_PREPARE_MOVE && (active || completed)) {
      const currentState = String(move.CurState ?? "");
      const environment = /VTR|VAC/i.test(currentState) ? "真空" : /ATR|ATM/i.test(currentState) ? "大气" : currentState;
      if (environment) environments.set(move.ModuleName, active ? `${environment}切换中` : environment);
    }
  }

  const robotTargets = new Map<string, string>();
  for (const move of activeMoves) {
    if (isRobotName(move.ModuleName)) robotTargets.set(move.ModuleName, activeTarget(move));
  }

  const wafersByLocation = new Map<string, string[]>();
  for (const [material, location] of locations) {
    if (!location) continue;
    const wafers = wafersByLocation.get(location) ?? [];
    wafers.push(material);
    wafersByLocation.set(location, wafers);
  }
  for (const wafers of wafersByLocation.values()) wafers.sort(naturalCompare);

  const modules = [...definitions.entries()].map(([name, definition]): ModuleSnapshot => {
    const moduleMoves = activeMoves.filter(move => (
      move.ModuleName === name
      || firstStation(move, "SrcStationList") === name
      || firstStation(move, "DestStationList") === name
      || listValue(move.StationList).map(String).includes(name)
    ));
    const primaryMove = moduleMoves.find(move => move.MoveType === CLEAN_MOVE)
      ?? moduleMoves.find(move => move.MoveType === PROCESS_MOVE)
      ?? moduleMoves.find(move => move.MoveType === PRE_PREPARE_MOVE)
      ?? moduleMoves.find(move => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType))
      ?? moduleMoves[0];
    let status: ModuleStatus = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove?.MoveType === CLEAN_MOVE) status = "cleaning";
    else if (primaryMove?.MoveType === PROCESS_MOVE) status = "processing";
    else if (primaryMove?.MoveType === PRE_PREPARE_MOVE) status = "environment";
    else if (primaryMove && [PREPARE_MOVE, COMPLETE_MOVE].includes(primaryMove.MoveType)) status = "door";
    else if (primaryMove) status = "transfer";
    return {
      name,
      type: definition.type,
      status,
      door: doorStates.get(name) ?? "closed",
      wafers: wafersByLocation.get(name) ?? [],
      activeMoveName: primaryMove ? (MOVE_NAMES[primaryMove.MoveType] ?? `动作 ${primaryMove.MoveType}`) : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      isRobotTarget: [...robotTargets.values()].includes(name),
    };
  }).sort((left, right) => naturalCompare(left.name, right.name));

  const robots = robotNames.map((name): RobotSnapshot => {
    const move = activeMoves.find(record => record.ModuleName === name);
    return {
      name,
      wafers: wafersByLocation.get(name) ?? [],
      busy: Boolean(move),
      target: robotTargets.get(name) ?? "",
      activeMoveName: move ? (MOVE_NAMES[move.MoveType] ?? `动作 ${move.MoveType}`) : "",
    };
  });

  return {
    time,
    endTime,
    completedMoves,
    totalMoves: records.length,
    activeMoves,
    modules,
    robots,
    waferCount: new Set(records.flatMap(move => materialIds(move))).size,
  };
}

/** 返回与当前页面结构绑定的工作台 DOM 节点。 */
function collectElements(root: Document): WorkspaceElements {
  const required = <ElementType extends HTMLElement>(id: string): ElementType => {
    const element = root.getElementById(id);
    if (!element) throw new Error(`结果分析页面缺少页面节点：${id}`);
    return element as ElementType;
  };
  return {
    empty: required("visualEmpty"),
    content: required("visualContent"),
    stage: required("visualDeviceStage"),
    activeMoves: required("visualActiveMoves"),
    source: required("visualSource"),
    currentTime: required("visualCurrentTime"),
    totalTime: required("visualTotalTime"),
    progressText: required("visualProgressText"),
    moveText: required("visualMoveText"),
    waferText: required("visualWaferText"),
    range: required<HTMLInputElement>("visualTimeline"),
    playButton: required<HTMLButtonElement>("visualPlayButton"),
    speed: required<HTMLSelectElement>("visualSpeed"),
    fileInput: required<HTMLInputElement>("visualFileInput"),
    openGantt: required<HTMLAnchorElement>("visualOpenGantt"),
    resultButton: required<HTMLButtonElement>("workspaceResultButton"),
    performance: required("visualPerformance"),
    performanceWindow: required<HTMLSelectElement>("performanceWindow"),
  };
}

/** 生成统一线性 SVG 图标，避免用 Emoji 充当结构图标。 */
function icon(name: "play" | "pause" | "robot" | "upload"): string {
  const paths = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>',
    robot: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 18v3M15 18v3"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v5h14v-5"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

interface TopologyGroups {
  processModules: ModuleSnapshot[];
  loadLocks: ModuleSnapshot[];
  loadPorts: ModuleSnapshot[];
  auxiliaryModules: ModuleSnapshot[];
}

/** 按参考设备图的物理区域划分当前 MoveList 真正使用的模块。 */
function topologyGroups(modules: ModuleSnapshot[]): TopologyGroups {
  const loadLocks = modules.filter(module => isLoadLockName(module.name, module.type));
  const loadPorts = modules.filter(module => isLoadPortName(module.name, module.type));
  const processModules = modules.filter(module => isProcessModule(module.name, module.type));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map(module => module.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter(module => !assignedNames.has(module.name)),
  };
}

/** 绘制拓扑中的紧凑腔室，包括门、晶圆、动作和进度状态。 */
function renderModule(module: ModuleSnapshot, role: "process" | "lock" | "port" | "auxiliary"): string {
  const waferLimit = 3;
  const wafers = module.wafers.slice(0, waferLimit)
    .map(wafer => `<span class="wafer-token" title="晶圆 ${escapeHtml(wafer)}">${escapeHtml(wafer)}</span>`)
    .join("");
  const overflow = module.wafers.length > waferLimit
    ? `<span class="wafer-more">+${module.wafers.length - waferLimit}</span>`
    : "";
  const progress = Math.round(module.progress * 100);
  const accessibleStatus = `${module.name}，${STATUS_LABELS[module.status]}，${DOOR_LABELS[module.door]}`;
  return `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.isRobotTarget ? "is-target" : ""}" aria-label="${escapeHtml(accessibleStatus)}">
      <div class="equipment-gate" aria-hidden="true"><span></span></div>
      <div class="equipment-head">
        <strong>${escapeHtml(module.name)}</strong>
        <span class="equipment-status"><i></i>${escapeHtml(STATUS_LABELS[module.status])}</span>
      </div>
      <div class="equipment-body">
        <div class="wafer-stack">${wafers || '<span class="wafer-empty">空腔</span>'}${overflow}</div>
        ${module.environment ? `<span class="environment-state">${escapeHtml(module.environment)}</span>` : ""}
      </div>
      <div class="equipment-foot">
        <span class="door-state"><i></i>${escapeHtml(DOOR_LABELS[module.door])}</span>
        <span>${escapeHtml(module.activeMoveName || "等待")}${module.activeMoveName ? ` · ${progress}%` : ""}</span>
      </div>
      <div class="equipment-progress"><span style="transform:scaleX(${module.activeMoveName ? module.progress : 0})"></span></div>
    </article>`;
}

/** 绘制参考图中央的机器人传输区。 */
function renderRobotHub(robot: RobotSnapshot, environment: "vacuum" | "atmosphere"): string {
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" aria-label="${escapeHtml(robot.name)} ${robot.busy ? "工作中" : "待命"}">
      <div class="robot-hub-icon">${icon("robot")}</div>
      <strong>${escapeHtml(robot.name)}</strong>
      <span>${environment === "vacuum" ? "真空传输区" : "大气传输区"}</span>
      <small>${escapeHtml(robot.busy ? `${robot.activeMoveName}${robot.target ? ` → ${robot.target}` : ""}` : "待命")}</small>
      <div class="robot-wafers">${robot.wafers.map(wafer => `<span class="wafer-token">${escapeHtml(wafer)}</span>`).join("")}</div>
    </article>`;
}

/** 计算工艺腔沿 VTR 上半圆排列的位置。 */
function processModulePosition(index: number, count: number): string {
  const progress = count <= 1 ? 0.5 : index / (count - 1);
  const degrees = PROCESS_ARC_START_DEGREES
    + (PROCESS_ARC_END_DEGREES - PROCESS_ARC_START_DEGREES) * progress;
  const radians = degrees * Math.PI / 180;
  const left = PROCESS_ARC_CENTER_X_PERCENT + Math.cos(radians) * PROCESS_ARC_RADIUS_X_PERCENT;
  const top = PROCESS_ARC_CENTER_Y_PIXELS + Math.sin(radians) * PROCESS_ARC_RADIUS_Y_PIXELS;
  return `--module-left:${left.toFixed(2)}%;--module-top:${top.toFixed(2)}px;--module-order:${index}`;
}

/** 按参考图绘制 VTR、ATR、腔室、Load Lock 与装载端口的设备俯视拓扑。 */
function renderEquipmentTopology(snapshot: WorkspaceSnapshot): string {
  const groups = topologyGroups(snapshot.modules);
  const vacuumRobot = snapshot.robots.find(robot => /^(VTR|TM\d*)/i.test(robot.name));
  const atmosphereRobot = snapshot.robots.find(robot => /^ATR/i.test(robot.name));
  const assignedRobots = new Set([vacuumRobot?.name, atmosphereRobot?.name].filter(Boolean));
  const additionalRobots = snapshot.robots.filter(robot => !assignedRobots.has(robot.name));
  const leftAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 0);
  const rightAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 1);
  return `
    <section class="equipment-schematic" aria-label="当前 MoveList 使用的设备拓扑">
      <div class="schematic-head">
        <div><strong>设备拓扑</strong><span>仅显示当前 MoveList 使用的模块</span></div>
        <small>${snapshot.modules.length} 个腔室 · ${snapshot.robots.length} 台机械手</small>
      </div>
      <div class="schematic-canvas">
        <div class="process-ring" aria-label="工艺腔室">
          ${groups.processModules.map((module, index) => `
            <div class="process-module-position" style="${processModulePosition(index, groups.processModules.length)}">
              ${renderModule(module, "process")}
            </div>`).join("")}
        </div>
        ${vacuumRobot ? renderRobotHub(vacuumRobot, "vacuum") : '<div class="topology-junction vacuum-junction"><strong>真空传输区</strong></div>'}
        <div class="load-lock-bank" aria-label="真空过渡腔">
          ${groups.loadLocks.map(module => renderModule(module, "lock")).join("")}
        </div>
        <div class="atmosphere-deck">
          <div class="auxiliary-bank auxiliary-left">${leftAuxiliary.map(module => renderModule(module, "auxiliary")).join("")}</div>
          ${atmosphereRobot ? renderRobotHub(atmosphereRobot, "atmosphere") : '<div class="topology-junction atmosphere-junction"><strong>大气传输区</strong></div>'}
          <div class="auxiliary-bank auxiliary-right">${rightAuxiliary.map(module => renderModule(module, "auxiliary")).join("")}</div>
        </div>
        <div class="load-port-bank" aria-label="装载端口">
          ${groups.loadPorts.map(module => renderModule(module, "port")).join("")}
        </div>
        ${additionalRobots.length ? `<div class="additional-robot-bank">${additionalRobots.map(robot => renderRobotHub(robot, "atmosphere")).join("")}</div>` : ""}
      </div>
    </section>`;
}

/** 将 PJob 全名压缩为队列中可辨认的末级名称。 */
function shortPJobName(value: string): string {
  const parts = String(value || "").split(".").filter(Boolean);
  return parts.at(-1) ?? "—";
}

/** 把比例格式化为一位小数百分比。 */
function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

/** 绘制资源占用表、Active Period 瓶颈和真空端晶圆队列。 */
function renderSchedulePerformance(performance: SchedulePerformance): string {
  const window = performance.window;
  const bottleneck = performance.bottleneck;
  const resourceKindLabels: Record<ResourceKind, string> = {
    robot: "机械手",
    process: "工艺腔",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "辅助模块",
  };
  const legend = ACTIVITY_CATEGORIES.map(category => (
    `<span><i class="performance-swatch category-${category}"></i>${ACTIVITY_CATEGORY_LABELS[category]}</span>`
  )).join("");
  const resourceRows = performance.resources.map(resource => {
    const categoryBars = ACTIVITY_CATEGORIES.map(category => {
      const duration = resource.categoryTimes[category];
      if (duration <= PERFORMANCE_TIME_TOLERANCE || window.duration <= PERFORMANCE_TIME_TOLERANCE) return "";
      const width = Math.min(duration / window.duration * 100, 100);
      return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds(duration)} s"></span>`;
    }).join("");
    const status = resource.busyTime <= PERFORMANCE_TIME_TOLERANCE
      ? '<span class="resource-unused">未使用</span>'
      : resource.isBottleneck
        ? '<span class="resource-bottleneck">瓶颈候选</span>'
        : "";
    return `
      <tr class="${resource.isBottleneck ? "is-bottleneck" : ""}">
        <th scope="row">
          <span class="resource-name">${escapeHtml(resource.name)}</span>
          <small>${escapeHtml(resourceKindLabels[resource.kind])}</small>
          ${status}
        </th>
        <td>
          <div class="utilization-value">${formatPercent(resource.utilization)}</div>
          <div class="utilization-track" aria-label="${escapeHtml(resource.name)} 占用率 ${formatPercent(resource.utilization)}">${categoryBars}</div>
          <small>${formatSeconds(resource.busyTime)} s</small>
        </td>
        <td class="performance-number">${formatSeconds(resource.averageActivePeriod)} s<small>${resource.activePeriodCount} 段</small></td>
        <td class="performance-number">${formatSeconds(resource.longestIdlePeriod)} s</td>
      </tr>`;
  }).join("");
  const visibleQueue = performance.vacuumQueue.slice(0, MAXIMUM_VISIBLE_QUEUE_ITEMS);
  const queueMarkup = visibleQueue.length
    ? `<ol class="vacuum-queue-sequence">${visibleQueue.map(item => `
        <li class="${item.targetWasBusy ? "target-busy" : "target-idle"}">
          <span class="queue-index">${item.index}</span>
          <strong>W${escapeHtml(item.material)}</strong>
          <span>${escapeHtml(shortPJobName(item.pjob))} · ${escapeHtml(item.loadLock)} → ${escapeHtml(item.targetModule || "PM?")}</span>
          <small>${formatSeconds(item.admittedAt)} s · 目标腔${item.targetWasBusy ? "忙" : "闲"} · 至加工 ${formatSeconds(item.processWait)} s</small>
        </li>`).join("")}</ol>`
    : '<div class="vacuum-queue-empty">MoveList 中没有识别到“LoadLock → 真空机械手”的入队动作。</div>';
  return `
    <div class="performance-summary">
      <div>
        <span>统计窗口</span>
        <strong>${escapeHtml(window.label)} · ${formatSeconds(window.duration)} s</strong>
        <small>剔除开头 ${formatSeconds(window.trimmedStart)} s / 结尾 ${formatSeconds(window.trimmedEnd)} s</small>
      </div>
      <div>
        <span>连续忙碌瓶颈</span>
        <strong>${escapeHtml(bottleneck?.name ?? "—")}</strong>
        <small>${bottleneck ? `平均连续忙碌 ${formatSeconds(bottleneck.averageActivePeriod)} s · 占用 ${formatPercent(bottleneck.utilization)}` : "没有足够的资源活动"}</small>
      </div>
      <div>
        <span>出站节拍</span>
        <strong>${performance.throughputPerHour > 0 ? `${performance.throughputPerHour.toFixed(1)} 片/h` : "—"}</strong>
        <small>平均间隔 ${formatSeconds(performance.meanDepartureInterval)} s · 波动 CV ${performance.departureIntervalCv.toFixed(2)}</small>
      </div>
    </div>
    <p class="performance-window-note">${escapeHtml(window.detail)}</p>
    <div class="performance-legend" aria-label="占用组成图例">${legend}</div>
    <div class="performance-grid">
      <div class="performance-table-wrap">
        <table class="performance-table">
          <thead><tr><th>资源</th><th>物理占用</th><th>平均连续忙碌</th><th>最长空闲</th></tr></thead>
          <tbody>${resourceRows}</tbody>
        </table>
      </div>
      <aside class="vacuum-queue-panel">
        <div class="vacuum-queue-head">
          <div><strong>真空端入队序列</strong><span>按晶圆第一次从 LoadLock 被 VTR 取出排序</span></div>
          <small>Job 切换 ${formatPercent(performance.vacuumQueueJobSwitchRatio)} · 最长连续 ${performance.vacuumQueueLongestRun} 片</small>
        </div>
        ${queueMarkup}
        ${performance.vacuumQueue.length > visibleQueue.length
          ? `<div class="vacuum-queue-more">另有 ${performance.vacuumQueue.length - visibleQueue.length} 片未展开</div>`
          : ""}
      </aside>
    </div>`;
}

/** 创建并管理调度平台中的结果分析页面。 */
export class VisualizationWorkspace {
  private readonly root: Document;
  private readonly elements: WorkspaceElements;
  private device: DeviceDefinition | null = null;
  private moves: MoveRecord[] = [];
  private sourceName = "";
  private resultUrl = "";
  private time = 0;
  private playing = false;
  private playbackSpeed = DEFAULT_PLAYBACK_SPEED;
  private performanceWindowMode: PerformanceWindowMode = "steady";
  private animationFrame = 0;
  private previousFrameTime = 0;
  private previousRenderTime = 0;

  /** 绑定页面事件并初始化空状态。 */
  constructor(root: Document) {
    this.root = root;
    this.elements = collectElements(root);
    this.bindEvents();
    this.updatePlayButton();
  }

  /** 更新当前设备拓扑；已有 MoveList 会立即按新拓扑重绘。 */
  setDevice(device: DeviceDefinition | null): void {
    this.device = device ? structuredClone(device) : null;
    if (this.moves.length) {
      this.render();
      this.renderPerformance();
    }
  }

  /** 加载浏览器中选择的 MoveList 文件。 */
  async loadFile(file: File): Promise<void> {
    const payload = JSON.parse(await file.text()) as unknown;
    this.loadMoves(normalizeMovePayload(payload), file.name, "");
  }

  /** 从后端保存的运行结果加载 MoveList。 */
  async loadResult(resultIdOrUrl: string, sourceName = "当前运行结果"): Promise<void> {
    const resultUrl = resultIdOrUrl.startsWith("/")
      ? resultIdOrUrl
      : `/api/results/${encodeURIComponent(resultIdOrUrl)}`;
    this.setLoading(true, "正在加载运行结果…");
    try {
      const response = await fetch(resultUrl, { cache: "no-store" });
      const payload = await response.json() as unknown;
      if (!response.ok) {
        const message = payload && typeof payload === "object"
          ? String((payload as UnknownRecord).error ?? "")
          : "";
        throw new Error(message || `服务返回 ${response.status}`);
      }
      this.loadMoves(normalizeMovePayload(payload), sourceName, resultUrl);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** 切换到工作台标签。 */
  show(): void {
    const tab = this.root.querySelector<HTMLElement>('[data-tab-target="workspace"]');
    tab?.click();
    this.elements.range.focus({ preventScroll: true });
  }

  /** 停止播放并释放动画帧。 */
  destroy(): void {
    this.pause();
  }

  /** 清除旧测试结果，避免切换测试后继续误看上一份 MoveList。 */
  clear(): void {
    this.pause();
    this.moves = [];
    this.sourceName = "";
    this.resultUrl = "";
    this.time = 0;
    this.elements.resultButton.disabled = true;
    this.elements.openGantt.href = "#";
    this.elements.openGantt.setAttribute("aria-disabled", "true");
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.empty.classList.remove("is-loading", "is-error");
    this.elements.empty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 9h8M8 13h5"/></svg>
      <strong>等待 MoveList</strong>
      <span>运行一次计划，或导入已有的 MoveList JSON 文件后开始回放。</span>`;
  }

  /** 接收规范化后的 MoveList 并重置时间轴。 */
  private loadMoves(moves: MoveRecord[], sourceName: string, resultUrl: string): void {
    if (!moves.length) throw new Error("MoveList 为空，无法建立可视化回放");
    this.pause();
    this.moves = moves;
    this.sourceName = sourceName;
    this.resultUrl = resultUrl;
    const snapshot = buildWorkspaceSnapshot(this.moves, this.device, 0);
    this.time = 0;
    this.elements.range.min = "0";
    this.elements.range.max = String(snapshot.endTime);
    this.elements.range.step = snapshot.endTime > 10000 ? "1" : "0.1";
    this.elements.range.value = "0";
    this.elements.openGantt.href = resultUrl
      ? `/movelist_gantt_viewer.html?src=${encodeURIComponent(resultUrl)}`
      : "#";
    this.elements.openGantt.setAttribute("aria-disabled", resultUrl ? "false" : "true");
    this.elements.resultButton.disabled = false;
    this.elements.empty.hidden = true;
    this.elements.content.hidden = false;
    this.render(snapshot);
    this.renderPerformance();
  }

  /** 绑定文件、时间轴、播放和快捷控制事件。 */
  private bindEvents(): void {
    this.elements.fileInput.addEventListener("change", () => {
      const file = this.elements.fileInput.files?.item(0);
      if (!file) return;
      this.loadFile(file)
        .catch(error => this.showError(error instanceof Error ? error.message : String(error)))
        .finally(() => { this.elements.fileInput.value = ""; });
    });
    this.elements.range.addEventListener("input", () => {
      this.time = finiteNumber(this.elements.range.value);
      this.render();
    });
    this.elements.playButton.addEventListener("click", () => {
      if (this.playing) this.pause();
      else this.play();
    });
    this.elements.speed.addEventListener("change", () => {
      this.playbackSpeed = Math.max(0.25, finiteNumber(this.elements.speed.value, DEFAULT_PLAYBACK_SPEED));
    });
    this.elements.performanceWindow.addEventListener("change", () => {
      this.performanceWindowMode = this.elements.performanceWindow.value === "full" ? "full" : "steady";
      this.renderPerformance();
    });
    this.elements.resultButton.addEventListener("click", () => this.show());
    this.elements.openGantt.addEventListener("click", event => {
      if (this.elements.openGantt.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }

  /** 从当前时间开始播放；到达末尾时自动回到起点。 */
  private play(): void {
    if (!this.moves.length || this.playing) return;
    const endTime = finiteNumber(this.elements.range.max);
    if (this.time >= endTime) {
      this.time = 0;
      this.elements.range.value = "0";
    }
    this.playing = true;
    this.previousFrameTime = performance.now();
    this.previousRenderTime = 0;
    this.updatePlayButton();
    this.animationFrame = requestAnimationFrame(timestamp => this.tick(timestamp));
  }

  /** 暂停回放并保留当前时间。 */
  private pause(): void {
    this.playing = false;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.updatePlayButton();
  }

  /** 推进播放时钟，并按固定上限刷新 DOM。 */
  private tick(timestamp: number): void {
    if (!this.playing) return;
    const elapsedSeconds = Math.max(0, timestamp - this.previousFrameTime) / 1000;
    this.previousFrameTime = timestamp;
    const endTime = finiteNumber(this.elements.range.max);
    this.time = Math.min(endTime, this.time + elapsedSeconds * this.playbackSpeed);
    this.elements.range.value = String(this.time);
    if (timestamp - this.previousRenderTime >= PLAYBACK_FRAME_INTERVAL_MS || this.time >= endTime) {
      this.previousRenderTime = timestamp;
      this.render();
    }
    if (this.time >= endTime) {
      this.pause();
      return;
    }
    this.animationFrame = requestAnimationFrame(nextTimestamp => this.tick(nextTimestamp));
  }

  /** 同步播放按钮的图标和无障碍文本。 */
  private updatePlayButton(): void {
    this.elements.playButton.innerHTML = this.playing
      ? `${icon("pause")}<span>暂停</span>`
      : `${icon("play")}<span>播放</span>`;
    this.elements.playButton.setAttribute("aria-label", this.playing ? "暂停回放" : "播放回放");
    this.elements.playButton.classList.toggle("is-playing", this.playing);
  }

  /** 绘制当前时间对应的设备快照。 */
  private render(prebuiltSnapshot?: WorkspaceSnapshot): void {
    if (!this.moves.length) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(this.moves, this.device, this.time);
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds(snapshot.endTime);
    this.elements.progressText.textContent = snapshot.endTime > 0
      ? `${Math.round(snapshot.time / snapshot.endTime * 100)}%`
      : "0%";
    this.elements.moveText.textContent = `${snapshot.completedMoves} / ${snapshot.totalMoves}`;
    this.elements.waferText.textContent = String(snapshot.waferCount);
    this.elements.range.value = String(snapshot.time);

    this.elements.stage.innerHTML = renderEquipmentTopology(snapshot);

    this.elements.activeMoves.innerHTML = snapshot.activeMoves.length
      ? snapshot.activeMoves.map(move => `
        <li>
          <span class="active-move-id">#${finiteNumber(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber(move.MoveType, -1)] ?? `动作 ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move as NormalizedMove) || "—")}</span>
          <time>${formatSeconds(finiteNumber(move.StartTime))}–${formatSeconds(finiteNumber(move.EndTime))} s</time>
        </li>`).join("")
      : '<li class="active-move-empty">当前时刻没有执行中的动作</li>';
  }

  /** 重算并绘制与播放时刻无关的整段排程性能诊断。 */
  private renderPerformance(): void {
    if (!this.moves.length) return;
    const performance = analyzeSchedulePerformance(
      this.moves,
      this.device,
      this.performanceWindowMode,
    );
    this.elements.performance.innerHTML = renderSchedulePerformance(performance);
  }

  /** 显示加载状态并保留明确的系统反馈。 */
  private setLoading(loading: boolean, message: string): void {
    this.elements.empty.hidden = false;
    this.elements.empty.classList.toggle("is-loading", loading);
    this.elements.empty.classList.remove("is-error");
    this.elements.empty.innerHTML = loading
      ? `<span class="visual-loader" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong>`
      : `<strong>${escapeHtml(message)}</strong>`;
  }

  /** 在工作台空状态中显示可恢复的错误。 */
  private showError(message: string): void {
    this.pause();
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.empty.classList.remove("is-loading");
    this.elements.empty.classList.add("is-error");
    this.elements.empty.innerHTML = `
      <strong>无法加载 MoveList</strong>
      <span>${escapeHtml(message)}</span>
      <label class="btn visual-import-button">${icon("upload")}重新选择文件<input type="file" accept=".json,application/json" data-visual-retry></label>`;
    const retryInput = this.elements.empty.querySelector<HTMLInputElement>("[data-visual-retry]");
    retryInput?.addEventListener("change", () => {
      const file = retryInput.files?.item(0);
      if (file) this.loadFile(file).catch(error => this.showError(error instanceof Error ? error.message : String(error)));
    });
  }
}

/** 在页面加载后创建工作台控制器。 */
export function createVisualizationWorkspace(root: Document = document): VisualizationWorkspace {
  return new VisualizationWorkspace(root);
}
