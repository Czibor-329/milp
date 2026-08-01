/**
 * MoveList 结果展示与回放页面。
 *
 * 本模块负责把调度输出回放成设备、机器人、晶圆和腔室门的可观察状态，并管理
 * 时间轴、播放控制、结果加载和本地文件导入。性能指标通过服务端 API 获取；
 * 本文件不实现分析规则，也不持久化业务数据。
 */

import { requestScheduleAnalysis } from "./api_client";
import type {
  ActivityCategory,
  BottleneckUtilizationSummary,
  BottleneckCandidate,
  BottleneckCandidateKind,
  DeviceDefinition,
  MoveRecord,
  PerformanceWindowMode,
  ResourcePerformance,
  ResourceKind,
  SchedulePerformance,
} from "./analysis_contracts";

type UnknownRecord = Record<string, unknown>;

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

export interface DecisionCandidate {
  actionId: string;
  kind: string;
  flowKind: string;
  robot: string;
  materialIds: string[];
  waferId: number;
  stageIndex: number;
  source: string;
  sourceSlot: number;
  destination: string;
  destinationSlot: number;
  earliestStart: number;
  finishTime: number;
  rank: number;
  selected: boolean;
  policyScore: number;
  policyPreference: number;
  expectedRemainingMakespan: number | null;
  medianRemainingMakespan: number | null;
  lowerRemainingMakespan: number | null;
  upperRemainingMakespan: number | null;
  makespanDelta: number | null;
}

export interface DecisionTraceStep {
  decisionIndex: number;
  time: number;
  revision: number;
  roundIndex: number;
  roundKind: string;
  selectedActionId: string;
  candidateCount: number;
  shownCandidateCount: number;
  candidatesTruncated: boolean;
  modelEvaluated: boolean;
  candidates: DecisionCandidate[];
}

interface NormalizedMove extends MoveRecord {
  MoveID: number;
  MoveType: number;
  ModuleName: string;
  StartTime: number;
  EndTime: number;
}

interface WorkspaceElements {
  toolbar: HTMLElement;
  groupAnalysis: HTMLElement;
  empty: HTMLElement;
  playbackEmpty: HTMLElement;
  content: HTMLElement;
  topologyPlayback: HTMLElement;
  stage: HTMLElement;
  decisionLens: HTMLElement;
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
const PERFORMANCE_DISPLAY_TOLERANCE = 1e-6;
const FUTURE_DECISION_COUNT = 6;

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

/** 把可选模型指标规范为有限数字；缺失或非有限值统一返回 null。 */
function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 把协议中的列表字段规范为数组。 */
function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 从用户文件或服务结果中提取 MoveList；这里只解析协议，不计算业务指标。 */
export function normalizeMovePayload(payload: unknown): MoveRecord[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      && Array.isArray((payload as UnknownRecord).MoveList)
      ? (payload as UnknownRecord).MoveList as unknown[]
      : null;
  if (!records) throw new Error("文件必须是 MoveList 数组，或包含 MoveList 字段的 JSON 对象");
  return records
    .filter((record): record is UnknownRecord => (
      Boolean(record) && typeof record === "object" && !Array.isArray(record)
    ))
    .map(record => ({ ...record }));
}

/** 从运行结果中提取有界的 E2E 候选动作与剩余 Makespan 预测。 */
export function normalizeDecisionTrace(payload: unknown): DecisionTraceStep[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rawTrace = (payload as UnknownRecord).DecisionTrace;
  if (!Array.isArray(rawTrace)) return [];
  return rawTrace
    .filter((step): step is UnknownRecord => Boolean(step) && typeof step === "object" && !Array.isArray(step))
    .map((step): DecisionTraceStep => {
      const rawCandidates = Array.isArray(step.candidates) ? step.candidates : [];
      const candidates = rawCandidates
        .filter((candidate): candidate is UnknownRecord => (
          Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
        ))
        .map((candidate): DecisionCandidate => ({
          actionId: String(candidate.actionId ?? ""),
          kind: String(candidate.kind ?? ""),
          flowKind: String(candidate.flowKind ?? ""),
          robot: String(candidate.robot ?? ""),
          materialIds: listValue(candidate.materialIds).map(String),
          waferId: finiteNumber(candidate.waferId),
          stageIndex: finiteNumber(candidate.stageIndex),
          source: String(candidate.source ?? ""),
          sourceSlot: finiteNumber(candidate.sourceSlot),
          destination: String(candidate.destination ?? ""),
          destinationSlot: finiteNumber(candidate.destinationSlot),
          earliestStart: finiteNumber(candidate.earliestStart),
          finishTime: finiteNumber(candidate.finishTime),
          rank: finiteNumber(candidate.rank),
          selected: Boolean(candidate.selected),
          policyScore: finiteNumber(candidate.policyScore),
          policyPreference: Math.max(0, Math.min(1, finiteNumber(candidate.policyPreference))),
          expectedRemainingMakespan: nullableFiniteNumber(candidate.expectedRemainingMakespan),
          medianRemainingMakespan: nullableFiniteNumber(candidate.medianRemainingMakespan),
          lowerRemainingMakespan: nullableFiniteNumber(candidate.lowerRemainingMakespan),
          upperRemainingMakespan: nullableFiniteNumber(candidate.upperRemainingMakespan),
          makespanDelta: nullableFiniteNumber(candidate.makespanDelta),
        }))
        .sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference);
      return {
        decisionIndex: finiteNumber(step.decisionIndex),
        time: finiteNumber(step.time),
        revision: finiteNumber(step.revision),
        roundIndex: finiteNumber(step.roundIndex),
        roundKind: String(step.roundKind ?? ""),
        selectedActionId: String(step.selectedActionId ?? ""),
        candidateCount: Math.max(candidates.length, finiteNumber(step.candidateCount, candidates.length)),
        shownCandidateCount: Math.max(candidates.length, finiteNumber(step.shownCandidateCount, candidates.length)),
        candidatesTruncated: Boolean(step.candidatesTruncated),
        modelEvaluated: Boolean(step.modelEvaluated),
        candidates,
      };
    })
    .sort((left, right) => left.time - right.time || left.decisionIndex - right.decisionIndex);
}

/** 返回播放时刻最近一次已经发生的模型决策。 */
export function decisionAtTime(
  trace: DecisionTraceStep[],
  time: number,
): DecisionTraceStep | null {
  let selected: DecisionTraceStep | null = null;
  for (const step of trace) {
    if (step.time > time + PERFORMANCE_DISPLAY_TOLERANCE) break;
    selected = step;
  }
  return selected ?? trace[0] ?? null;
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
    toolbar: required("visualToolbar"),
    groupAnalysis: required("testGroupAnalysisPanel"),
    empty: required("visualEmpty"),
    playbackEmpty: required("visualPlaybackEmpty"),
    content: required("visualContent"),
    topologyPlayback: required("visualTopologyPlayback"),
    stage: required("visualDeviceStage"),
    decisionLens: required("visualDecisionLens"),
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

interface CandidateDestinationSummary {
  count: number;
  bestRank: number;
  preference: number;
  makespanDelta: number | null;
  selected: boolean;
}

/** 按目标模块聚合同一决策点的候选，供拓扑绘制类似围棋候选点的热区。 */
function candidateDestinations(
  decision: DecisionTraceStep | null,
): Map<string, CandidateDestinationSummary> {
  const destinations = new Map<string, CandidateDestinationSummary>();
  for (const candidate of decision?.candidates ?? []) {
    if (!candidate.destination) continue;
    const previous = destinations.get(candidate.destination);
    destinations.set(candidate.destination, {
      count: (previous?.count ?? 0) + 1,
      bestRank: Math.min(previous?.bestRank ?? Number.POSITIVE_INFINITY, candidate.rank),
      preference: Math.max(previous?.preference ?? 0, candidate.policyPreference),
      makespanDelta: candidate.makespanDelta === null
        ? previous?.makespanDelta ?? null
        : Math.min(previous?.makespanDelta ?? Number.POSITIVE_INFINITY, candidate.makespanDelta),
      selected: Boolean(previous?.selected || candidate.selected),
    });
  }
  return destinations;
}

/** 把未进入最终 MoveList 的候选目标补进只读拓扑，避免只显示模型已选落点。 */
function snapshotWithCandidateModules(
  snapshot: WorkspaceSnapshot,
  decision: DecisionTraceStep | null,
  device: DeviceDefinition | null,
): WorkspaceSnapshot {
  const modules = [...snapshot.modules];
  const knownNames = new Set(modules.map(module => module.name));
  for (const candidate of decision?.candidates ?? []) {
    const name = candidate.destination;
    if (!name || isRobotName(name) || knownNames.has(name)) continue;
    modules.push({
      name,
      type: String(device?.Stations?.[name]?.Type ?? ""),
      status: "idle",
      door: "closed",
      wafers: [],
      activeMoveName: "",
      progress: 0,
      environment: "",
      isRobotTarget: false,
    });
    knownNames.add(name);
  }
  return {
    ...snapshot,
    modules: modules.sort((left, right) => naturalCompare(left.name, right.name)),
  };
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
function renderModule(
  module: ModuleSnapshot,
  role: "process" | "lock" | "port" | "auxiliary",
  candidate: CandidateDestinationSummary | undefined,
): string {
  const waferLimit = 3;
  const wafers = module.wafers.slice(0, waferLimit)
    .map(wafer => `<span class="wafer-token" title="晶圆 ${escapeHtml(wafer)}">${escapeHtml(wafer)}</span>`)
    .join("");
  const overflow = module.wafers.length > waferLimit
    ? `<span class="wafer-more">+${module.wafers.length - waferLimit}</span>`
    : "";
  const progress = Math.round(module.progress * 100);
  const accessibleStatus = `${module.name}，${STATUS_LABELS[module.status]}，${DOOR_LABELS[module.door]}`;
  const candidateLabel = candidate
    ? `${candidate.count} 个可行动作，最高模型偏好 ${(candidate.preference * 100).toFixed(0)}%`
    : "";
  return `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `，${candidateLabel}` : ""}`)}">
      ${candidate ? `<div class="candidate-landing" aria-hidden="true"><b>${candidate.bestRank}</b><span>${(candidate.preference * 100).toFixed(0)}%</span></div>` : ""}
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
function renderEquipmentTopology(
  snapshot: WorkspaceSnapshot,
  decision: DecisionTraceStep | null,
): string {
  const groups = topologyGroups(snapshot.modules);
  const destinations = candidateDestinations(decision);
  const vacuumRobot = snapshot.robots.find(robot => /^(VTR|TM\d*)/i.test(robot.name));
  const atmosphereRobot = snapshot.robots.find(robot => /^ATR/i.test(robot.name));
  const assignedRobots = new Set([vacuumRobot?.name, atmosphereRobot?.name].filter(Boolean));
  const additionalRobots = snapshot.robots.filter(robot => !assignedRobots.has(robot.name));
  const leftAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 0);
  const rightAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 1);
  return `
    <section class="equipment-schematic" aria-label="当前 MoveList 使用的设备拓扑">
      <div class="schematic-head">
        <div><strong>设备拓扑</strong><span>MoveList 模块 + 当前候选目标</span></div>
        <small>${snapshot.modules.length} 个腔室 · ${snapshot.robots.length} 台机械手</small>
      </div>
      <div class="schematic-canvas">
        <div class="process-ring" aria-label="工艺腔室">
          ${groups.processModules.map((module, index) => `
            <div class="process-module-position" style="${processModulePosition(index, groups.processModules.length)}">
              ${renderModule(module, "process", destinations.get(module.name))}
            </div>`).join("")}
        </div>
        ${vacuumRobot ? renderRobotHub(vacuumRobot, "vacuum") : '<div class="topology-junction vacuum-junction"><strong>真空传输区</strong></div>'}
        <div class="load-lock-bank" aria-label="真空过渡腔">
          ${groups.loadLocks.map(module => renderModule(module, "lock", destinations.get(module.name))).join("")}
        </div>
        <div class="atmosphere-deck">
          <div class="auxiliary-bank auxiliary-left">${leftAuxiliary.map(module => renderModule(module, "auxiliary", destinations.get(module.name))).join("")}</div>
          ${atmosphereRobot ? renderRobotHub(atmosphereRobot, "atmosphere") : '<div class="topology-junction atmosphere-junction"><strong>大气传输区</strong></div>'}
          <div class="auxiliary-bank auxiliary-right">${rightAuxiliary.map(module => renderModule(module, "auxiliary", destinations.get(module.name))).join("")}</div>
        </div>
        <div class="load-port-bank" aria-label="装载端口">
          ${groups.loadPorts.map(module => renderModule(module, "port", destinations.get(module.name))).join("")}
        </div>
        ${additionalRobots.length ? `<div class="additional-robot-bank">${additionalRobots.map(robot => renderRobotHub(robot, "atmosphere")).join("")}</div>` : ""}
      </div>
    </section>`;
}

/** 把可选秒数格式化为适合紧凑决策卡片的文本。 */
function modelSeconds(value: number | null, sign = false): string {
  if (value === null) return "—";
  const prefix = sign && value > PERFORMANCE_DISPLAY_TOLERANCE ? "+" : "";
  return `${prefix}${value.toFixed(value >= 100 ? 0 : 1)} s`;
}

/** 生成候选动作的人类可读路径标签。 */
function decisionCandidatePath(candidate: DecisionCandidate): string {
  const source = candidate.source || "当前位置";
  const destination = candidate.destination || "—";
  return `${source} → ${destination}${candidate.destinationSlot ? ` · 槽 ${candidate.destinationSlot}` : ""}`;
}

/** 返回当前决策之后的有限条已选动作，作为单轨迹未来规划视图。 */
function futureDecisionSteps(
  trace: DecisionTraceStep[],
  current: DecisionTraceStep,
): DecisionTraceStep[] {
  const index = trace.indexOf(current);
  if (index < 0) return [current];
  return trace.slice(index, index + FUTURE_DECISION_COUNT);
}

/** 绘制 E2E 决策透镜：候选偏好、Makespan 分布和未来单轨迹。 */
function renderDecisionLens(
  decision: DecisionTraceStep | null,
  trace: DecisionTraceStep[],
): string {
  if (!decision) {
    return `
      <div class="decision-empty">
        <strong>没有模型决策轨迹</strong>
        <p>当前结果只包含 MoveList。请使用 E2E-CTQ 重新运行，或导入含 <code>DecisionTrace</code> 的结果 JSON。</p>
      </div>`;
  }
  const selected = decision.candidates.find(candidate => candidate.selected)
    ?? decision.candidates.find(candidate => candidate.actionId === decision.selectedActionId)
    ?? decision.candidates[0];
  const shownText = decision.candidatesTruncated
    ? `展示 Top ${decision.shownCandidateCount} / ${decision.candidateCount}`
    : `${decision.candidateCount} 个可行动作`;
  const candidates = decision.candidates.map(candidate => {
    const preference = Math.round(candidate.policyPreference * 100);
    const uncertainty = candidate.lowerRemainingMakespan !== null && candidate.upperRemainingMakespan !== null
      ? `${modelSeconds(candidate.lowerRemainingMakespan)}–${modelSeconds(candidate.upperRemainingMakespan)}`
      : "未评估";
    const material = candidate.materialIds.length
      ? candidate.materialIds.join(" / ")
      : `Wafer ${candidate.waferId}`;
    return `
      <li class="decision-candidate ${candidate.selected ? "is-selected" : ""}">
        <div class="decision-candidate-rank">${candidate.rank}</div>
        <div class="decision-candidate-main">
          <div><strong>${escapeHtml(decisionCandidatePath(candidate))}</strong>${candidate.selected ? "<span>模型选择</span>" : ""}</div>
          <small>${escapeHtml(material)} · ${escapeHtml(candidate.robot || "Robot")} · ${escapeHtml(candidate.flowKind || candidate.kind)}</small>
          <div class="decision-preference-track" aria-label="模型偏好 ${preference}%"><i style="transform:scaleX(${candidate.policyPreference})"></i></div>
        </div>
        <div class="decision-candidate-metrics">
          <strong>${preference}%</strong>
          <span>Δ ${modelSeconds(candidate.makespanDelta, true)}</span>
          <small title="剩余 Makespan 预测区间">${uncertainty}</small>
        </div>
      </li>`;
  }).join("");
  const future = futureDecisionSteps(trace, decision).map((step, index) => {
    const action = step.candidates.find(candidate => candidate.selected)
      ?? step.candidates.find(candidate => candidate.actionId === step.selectedActionId)
      ?? step.candidates[0];
    if (!action) return "";
    return `
      <li class="future-decision-step ${index === 0 ? "is-current" : ""}">
        <span>${index === 0 ? "当前" : `+${index}`}</span>
        <strong>${escapeHtml(action.destination || "—")}</strong>
        <small>${formatSeconds(step.time)} s · ${escapeHtml(action.materialIds.join("/") || `W${action.waferId}`)}</small>
      </li>`;
  }).join("");
  const selectedSummary = selected
    ? `<div class="decision-selected-summary">
        <span>${decision.modelEvaluated ? "E2E-CTQ 选择" : "物理约束唯一解"}</span>
        <strong>${escapeHtml(decisionCandidatePath(selected))}</strong>
        <dl>
          <div><dt>模型偏好</dt><dd>${Math.round(selected.policyPreference * 100)}%</dd></div>
          <div><dt>剩余 Makespan</dt><dd>${modelSeconds(selected.expectedRemainingMakespan)}</dd></div>
          <div><dt>相对最优 Δ</dt><dd>${modelSeconds(selected.makespanDelta, true)}</dd></div>
        </dl>
      </div>`
    : "";
  return `
    <div class="decision-lens-head">
      <div><span>AI DECISION LENS</span><strong>决策 #${decision.decisionIndex}</strong></div>
      <small>${escapeHtml(shownText)}</small>
    </div>
    ${selectedSummary}
    <section class="future-trajectory" aria-labelledby="futureTrajectoryTitle">
      <header><strong id="futureTrajectoryTitle">未来单轨迹</strong><span>后续 ${FUTURE_DECISION_COUNT} 个决策点</span></header>
      <ol>${future}</ol>
    </section>
    <section class="decision-candidate-section" aria-labelledby="decisionCandidatesTitle">
      <header><strong id="decisionCandidatesTitle">候选动作</strong><span>偏好 · Δ Makespan · 预测区间</span></header>
      <ol>${candidates}</ol>
    </section>
    <p class="decision-method-note">偏好来自策略分数的同组归一化；Δ Makespan 相对当前候选中预测均值最小者。区间来自分位价值头，不代表完成时间保证。</p>`;
}

const WAFER_COLOR_PALETTE = [
  "#d81b60", "#2f9e44", "#5f5bd6", "#e76f51", "#008c95",
  "#c23b8d", "#2878c8", "#7ca62b", "#b45cc5", "#16856f",
  "#7a5fb5", "#b66a2c", "#c23b32", "#45a66b", "#4d66c4",
  "#df6b83", "#2b7a78", "#a33d64", "#7868c8", "#8a6045",
];

/** 把协议中的晶圆编号转成一致的短标签。 */
function waferLabel(value: string): string {
  const material = String(value || "").trim();
  return /^W/i.test(material) ? material : `W${material}`;
}

/** 为所有出现过晶圆分配唯一颜色。 */
function buildWaferColorMap(cycles: GanttCycle[]): Map<string, string> {
  const wafers = new Set<string>();
  for (const cycle of cycles) {
    for (const wafer of cycle.vacuumWafers) wafers.add(waferLabel(wafer));
    for (const wafer of cycle.ventWafers) wafers.add(waferLabel(wafer));
  }
  const map = new Map<string, string>();
  let idx = 0;
  for (const wafer of wafers) {
    map.set(wafer, WAFER_COLOR_PALETTE[idx % WAFER_COLOR_PALETTE.length]);
    idx++;
  }
  return map;
}

type GanttCycle = {
  index: number; loadLock: string;
  vacuumWafers: string[]; ventWafers: string[];
  startTime: number; pumpEndTime: number;
  ventStartTime: number; ventEndTime: number;
};

function normalizeGanttCycles(cycles: unknown[]): GanttCycle[] {
  return cycles.map((cycle: any) => ({
    index: Number(cycle.index ?? 0),
    loadLock: String(cycle.loadLock ?? ""),
    vacuumWafers: Array.isArray(cycle.vacuumWafers) ? cycle.vacuumWafers.map(String) : [],
    ventWafers: Array.isArray(cycle.ventWafers) ? cycle.ventWafers.map(String) : [],
    startTime: Number(cycle.startTime ?? cycle.index ?? 0),
    pumpEndTime: Number(cycle.pumpEndTime ?? cycle.startTime ?? cycle.index ?? 0),
    ventStartTime: Number(cycle.ventStartTime ?? 0),
    ventEndTime: Number(cycle.ventEndTime ?? 0),
  }));
}

function formatGanttTime(seconds: number): string {
  return seconds >= 1 ? seconds.toFixed(1) : seconds.toFixed(2);
}

function renderWaferDots(wafers: string[], waferColors: Map<string, string>): string {
  if (!wafers.length) return "";
  return wafers.map(w => {
    const label = waferLabel(w);
    const color = waferColors.get(label) || "#94a3b8";
    return `<span class="gantt-wafer-dot" style="background:${color}" title="${escapeHtml(label)}"></span>`;
  }).join("");
}

/** 绘制 LoadLock 环境切换时序 —— 仅保留所有 LoadLock 的全局交错序列。 */
function renderLoadLockGantt(cycles: GanttCycle[]): string {
  if (!cycles.length) return '<div class="loadlock-cycle-empty">MoveList 中没有识别到 LoadLock 抽气或充气动作。</div>';

  const waferColors = buildWaferColorMap(cycles);

  /* ---------- 收集所有抽气/充气事件，按时间排序 ---------- */
  interface SequenceEvent { time: number; loadLock: string; dir: "pump" | "vent"; wafers: string[]; }
  const events: SequenceEvent[] = [];
  for (const c of cycles) {
    events.push({ time: c.startTime, loadLock: c.loadLock, dir: "pump", wafers: c.vacuumWafers });
    if (c.ventStartTime) events.push({ time: c.ventStartTime, loadLock: c.loadLock, dir: "vent", wafers: c.ventWafers });
  }
  events.sort((a, b) => a.time - b.time);

  function renderCard(dir: "pump" | "vent", wafers: string[], loadLock: string, time: number): string {
    const cls = dir === "pump" ? "seq-pump" : "seq-vent";
    const label = dir === "pump" ? "抽" : "充";
    const dots = renderWaferDots(wafers, waferColors);
    const description = `${loadLock} ${label}气 ${formatGanttTime(time)}s`;
    return `<div class="seq-card ${cls}" role="img" aria-label="${escapeHtml(description)}" title="${escapeHtml(description)}"><span class="seq-dots">${dots}</span></div>`;
  }

  const interleavedCards = events.map(e => renderCard(e.dir, e.wafers, e.loadLock, e.time)).join("");

  return `<div class="loadlock-seq">
    <div class="seq-scroll" aria-label="LoadLock 全局交错时序">
      <div class="seq-cards">${interleavedCards}</div>
    </div>
  </div>`;
}

/** 把比例格式化为一位小数百分比。 */
function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

/** 为单个资源生成分类色条。 */
function renderCategoryBars(resource: ResourcePerformance, windowDuration: number): string {
  return ACTIVITY_CATEGORIES.map(category => {
    const duration = resource.categoryTimes[category];
    if (duration <= PERFORMANCE_DISPLAY_TOLERANCE || windowDuration <= PERFORMANCE_DISPLAY_TOLERANCE) return "";
    const width = Math.min(duration / windowDuration * 100, 100);
    return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds(duration)} s"></span>`;
  }).join("");
}

/** 渲染合并后的瓶颈分析区域：候选排序 + 各资源占用比例。 */
function renderBottleneckAnalysis(performance: SchedulePerformance): string {
  const { window, bottleneckCandidates, resources } = performance;
  const confidenceLabels = { high: "证据较强", medium: "证据中等", low: "证据较弱" };
  const resourceKindLabels: Record<ResourceKind, string> = {
    robot: "机械手",
    process: "工艺腔",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "辅助模块",
  };

  const activeResources = resources
    .filter(resource => resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE)
    .sort((left, right) => right.utilization - left.utilization);
  const displayedResources = activeResources.slice(0, 6);
  const remainingResources = activeResources.slice(displayedResources.length);
  const resourceRows = (items: ResourcePerformance[]): string => items.map((resource, index) => {
    const candidate = bottleneckCandidates
      .filter(item => item.resourceNames.includes(resource.name))
      .sort((left, right) => right.score - left.score)[0];
    const evidenceScore = candidate ? Math.round(candidate.score * 100) : null;
    const evidenceLabel = candidate ? confidenceLabels[candidate.confidence] : "未入选候选";
    return `
      <li class="resource-utilization-row">
        <div class="resource-utilization-name">
          <span>${index + 1}</span>
          <div><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resourceKindLabels[resource.kind])}</small></div>
        </div>
        <strong class="resource-utilization-percent">${formatPercent(resource.utilization)}</strong>
        <div class="utilization-track" aria-label="${escapeHtml(resource.name)} 占用率 ${formatPercent(resource.utilization)}">${renderCategoryBars(resource, window.duration)}</div>
        <small class="resource-utilization-time">${formatSeconds(resource.busyTime)} s</small>
        <div class="resource-evidence-score"><strong>${evidenceScore ?? "—"}</strong><small>${evidenceLabel}</small></div>
      </li>`;
  }).join("");

  const legend = ACTIVITY_CATEGORIES.map(category => (
    `<span><i class="performance-swatch category-${category}"></i>${ACTIVITY_CATEGORY_LABELS[category]}</span>`
  )).join("");

  return `
    <header class="bottleneck-analysis-head">
      <div>
        <strong>瓶颈分析</strong>
        <span>默认显示利用率最高的 6 个活跃资源，并给出对应的瓶颈证据得分。</span>
      </div>
      <label class="bottleneck-window-control">统计口径<span class="bottleneck-window-slot"></span></label>
    </header>
    <div class="resource-utilization-head" aria-hidden="true"><span>资源</span><span>利用率</span><span>占用组成</span><span>活跃时长</span><span>瓶颈证据得分</span></div>
    <ol class="resource-utilization-list">
      ${resourceRows(displayedResources)}
    </ol>
    <div class="performance-legend" aria-label="占用组成图例">${legend}</div>
    ${remainingResources.length ? `<details class="additional-resource-details"><summary>查看其他活跃资源（${remainingResources.length} 个）</summary><ol class="resource-utilization-list">${resourceRows(remainingResources)}</ol></details>` : ""}
    <p class="performance-window-note">${escapeHtml(window.detail)}</p>`;
}

/** 渲染 LoadLock 交换时序独立卡片。 */
function renderLoadLockCard(performance: SchedulePerformance): string {
  const ganttCycles = normalizeGanttCycles(performance.loadLockCycles);
  const gantt = renderLoadLockGantt(ganttCycles);
  return `
    <header class="loadlock-card-head">
      <strong>LoadLock 交换时序</strong>
      <span>显示全部 LoadLock 的抽气/充气交错序列</span>
    </header>
    <div class="loadlock-card-body">${gantt}</div>`;
}

/** 渲染下一步优化区域。 */
function renderNextOptimization(performance: SchedulePerformance): string {
  const diagnostics = performance.diagnostics ?? [];
  if (!diagnostics.length) return "";
  return `
    <header class="next-opt-head">
      <div><span>证据 → 假设 → 实验</span><strong>下一步优化</strong></div>
      <small>结论来自执行轨迹重建，不冒充算法内部打分</small>
    </header>
    <div class="diagnostic-list">
      ${diagnostics.map((diagnostic, index) => `
        <article class="diagnostic-card">
          <header><span class="diagnostic-rank">${index + 1}</span><div><strong>${escapeHtml(diagnostic.title)}</strong><small>${({ strong: "证据较强", moderate: "证据中等", exploratory: "探索性线索" })[diagnostic.confidence]}</small></div></header>
          <p>${escapeHtml(diagnostic.finding)}</p>
          <dl>${diagnostic.evidence.map(evidence => `
            <div><dt>${escapeHtml(evidence.label)}</dt><dd><b>${escapeHtml(evidence.value)}</b><span>${escapeHtml(evidence.interpretation)}</span></dd></div>
          `).join("")}</dl>
          <div class="diagnostic-experiment">
            <span>可证伪的下一步</span>
            <strong>${escapeHtml(diagnostic.nextExperiment.label)}</strong>
            <p>${escapeHtml(diagnostic.nextExperiment.change)}</p>
            <small>预期信号：${escapeHtml(diagnostic.nextExperiment.expectedSignal)}</small>
          </div>
          <aside>${escapeHtml(diagnostic.limitation)}</aside>
        </article>`).join("")}
    </div>`;
}

/** 绘制排程诊断面板 —— 总览、瓶颈分析、LoadLock 时序、下一步优化共四张卡片。 */
function renderSchedulePerformance(performance: SchedulePerformance): string {
  const window = performance.window;
  const bottleneck = performance.primaryBottleneck;
  const confidenceLabels = { high: "证据较强", medium: "证据中等", low: "证据较弱" };

  return `
    <section class="result-card overview-card">
      <header class="overview-head"><span class="visual-kicker">排程概览</span><strong>KPI 总览</strong></header>
      <div class="performance-summary">
        <div>
          <span>统计窗口</span>
          <strong>${escapeHtml(window.label)} · ${formatSeconds(window.duration)} s</strong>
          <small>剔除开头 ${formatSeconds(window.trimmedStart)} s / 结尾 ${formatSeconds(window.trimmedEnd)} s</small>
        </div>
        <div>
          <span>最可能瓶颈</span>
          <strong>${escapeHtml(bottleneck?.label ?? "—")}</strong>
          <small>${bottleneck ? `容量利用率 ${formatPercent(bottleneck.utilization)} · ${confidenceLabels[bottleneck.confidence]} · 另有 ${Math.max(0, performance.bottleneckCandidates.length - 1)} 个候选` : "没有足够的资源活动"}</small>
        </div>
        <div>
          <span>出站节拍</span>
          <strong>${performance.throughputPerHour > 0 ? `${performance.throughputPerHour.toFixed(1)} 片/h` : "—"}</strong>
          <small>平均间隔 ${formatSeconds(performance.meanDepartureInterval)} s · 间隔 CV ${performance.departureIntervalCv.toFixed(2)} · ${performance.completedWaferCount} 片样本</small>
        </div>
        <div>
          <span>晶圆驻留时间 · 加工腔</span>
          <strong>${performance.processChamberDwellTime.sampleCount ? `${formatSeconds(performance.processChamberDwellTime.meanSeconds)} s` : "—"}</strong>
          <small>加工结束 → 完全离腔 · 中位 ${formatSeconds(performance.processChamberDwellTime.medianSeconds)} s · 最大 ${formatSeconds(performance.processChamberDwellTime.maxSeconds)} s · ${performance.processChamberDwellTime.sampleCount} 次</small>
        </div>
        <div>
          <span>机器手驻留时间</span>
          <strong>${performance.robotWaferDwellTime.sampleCount ? `${formatSeconds(performance.robotWaferDwellTime.meanSeconds)} s` : "—"}</strong>
          <small>Pick 完成 → Place 开始，已扣除 PreTrans 运输 · 最大 ${formatSeconds(performance.robotWaferDwellTime.maxSeconds)} s · ${performance.robotWaferDwellTime.sampleCount} 次</small>
        </div>
        <div>
          <span>晶圆系统停留时间</span>
          <strong>${performance.waferSystemResidenceTime.sampleCount ? `${formatSeconds(performance.waferSystemResidenceTime.meanSeconds)} s` : "—"}</strong>
          <small>离开 LP → 返回 LP · CV ${performance.waferSystemResidenceTime.coefficientOfVariation.toFixed(2)} · 最大 ${formatSeconds(performance.waferSystemResidenceTime.maxSeconds)} s · ${performance.waferSystemResidenceTime.sampleCount} 片</small>
        </div>
      </div>
    </section>

    <section class="result-card bottleneck-analysis-card">
      ${renderBottleneckAnalysis(performance)}
    </section>

    <section class="result-card loadlock-swap-card">
      ${renderLoadLockCard(performance)}
    </section>

    ${performance.diagnostics?.length ? `
    <section class="result-card next-optimization-card">
      ${renderNextOptimization(performance)}
    </section>` : ""}
    `;
}

/** 创建并管理调度平台中的结果分析页面。 */
export class VisualizationWorkspace {
  private readonly root: Document;
  private readonly elements: WorkspaceElements;
  private device: DeviceDefinition | null = null;
  private analysisRoutes: Array<Record<string, any>> = [];
  private analysisRounds: Array<Record<string, any>> = [];
  private moves: MoveRecord[] = [];
  private decisionTrace: DecisionTraceStep[] = [];
  private sourceName = "";
  private resultUrl = "";
  private analysisResultId = "";
  private analysis: SchedulePerformance | null = null;
  private bottleneckSummary: BottleneckUtilizationSummary | null = null;
  private analysisRequestVersion = 0;
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
    this.setTopologyVisible(false);
  }

  /** 更新当前设备拓扑；已有 MoveList 会立即按新拓扑重绘。 */
  setDevice(device: DeviceDefinition | null): void {
    this.device = device ? structuredClone(device) : null;
    if (this.moves.length) {
      this.render();
      void this.renderPerformance();
    }
  }

  /** 加载浏览器中选择的 MoveList 文件。 */
  async loadFile(file: File): Promise<void> {
    const payload = JSON.parse(await file.text()) as unknown;
    await this.loadMoves(
      normalizeMovePayload(payload),
      normalizeDecisionTrace(payload),
      file.name,
      "",
      "",
    );
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
      const resultId = resultUrl.startsWith("/api/results/")
        ? decodeURIComponent(resultUrl.slice("/api/results/".length))
        : "";
      await this.loadMoves(
        normalizeMovePayload(payload),
        normalizeDecisionTrace(payload),
        sourceName,
        resultUrl,
        resultId,
      );
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** 提供后端构建工序容量上下文所需的原始 Route 和轮次配置。 */
  setAnalysisConfiguration(
    routes: Array<Record<string, any>> | null,
    rounds: Array<Record<string, any>> | null,
  ): void {
    this.analysisRoutes = structuredClone(routes ?? []);
    this.analysisRounds = structuredClone(rounds ?? []);
    if (this.moves.length) void this.renderPerformance();
  }

  /** 返回与诊断面板一致的稳态瓶颈候选利用率，供运行结果摘要复用。 */
  getBottleneckUtilization(): BottleneckUtilizationSummary | null {
    return this.bottleneckSummary ? structuredClone(this.bottleneckSummary) : null;
  }

  /** 切换到工作台标签。 */
  show(): void {
    if (this.moves.length) this.showSingleResult();
    const tab = this.root.querySelector<HTMLElement>('[data-tab-target="workspace"]');
    tab?.click();
    this.elements.performanceWindow.focus({ preventScroll: true });
  }

  /** 显示测试组统计，并隐藏当前单例诊断；独立回放页保留已加载的数据。 */
  showGroupAnalysis(markup: string): void {
    this.pause();
    this.elements.empty.hidden = true;
    this.elements.content.hidden = true;
    this.elements.groupAnalysis.innerHTML = markup;
    this.elements.groupAnalysis.hidden = false;
  }

  /** 停止播放并释放动画帧。 */
  destroy(): void {
    this.pause();
  }

  /** 清除旧测试结果，避免切换测试后继续误看上一份 MoveList。 */
  clear(): void {
    this.pause();
    this.moves = [];
    this.decisionTrace = [];
    this.sourceName = "";
    this.resultUrl = "";
    this.analysisResultId = "";
    this.analysis = null;
    this.bottleneckSummary = null;
    this.analysisRequestVersion += 1;
    this.time = 0;
    this.elements.resultButton.disabled = true;
    this.elements.openGantt.href = "#";
    this.elements.openGantt.setAttribute("aria-disabled", "true");
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.groupAnalysis.innerHTML = "";
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.playbackEmpty.hidden = false;
    this.setTopologyVisible(false);
    this.elements.empty.classList.remove("is-loading", "is-error");
    this.elements.empty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 9h8M8 13h5"/></svg>
      <strong>等待分析数据</strong>
      <span>运行一次计划，或在拓扑回放界面导入已有的 MoveList JSON 文件后查看结果分析。</span>`;
    this.elements.playbackEmpty.classList.remove("is-loading", "is-error");
    this.elements.playbackEmpty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 7.3 2.8 2.8M17 7.3l-2.8 2.8M7 16.7l2.8-2.8M17 16.7l-2.8-2.8"/></svg>
      <strong>等待 MoveList</strong>
      <span>运行一次计划，或导入已有的 MoveList JSON 文件后查看设备拓扑并开始回放。</span>`;
  }

  /** 接收规范化后的 MoveList 并重置时间轴。 */
  private async loadMoves(
    moves: MoveRecord[],
    decisionTrace: DecisionTraceStep[],
    sourceName: string,
    resultUrl: string,
    analysisResultId: string,
  ): Promise<void> {
    if (!moves.length) throw new Error("MoveList 为空，无法建立可视化回放");
    this.pause();
    this.moves = moves;
    this.decisionTrace = decisionTrace;
    this.sourceName = sourceName;
    this.resultUrl = resultUrl;
    this.analysisResultId = analysisResultId;
    this.analysis = null;
    this.bottleneckSummary = null;
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
    this.showSingleResult();
    this.setTopologyVisible(true);
    this.render(snapshot);
    await this.renderPerformance();
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
      void this.renderPerformance();
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

  /** 切换单例分析模式，测试组统计与单例诊断不会同时出现。 */
  private showSingleResult(): void {
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.empty.hidden = true;
    this.elements.content.hidden = false;
    this.elements.playbackEmpty.hidden = true;
  }

  /** 统一切换独立回放页中的概要、时间轴、拓扑与当前动作。 */
  private setTopologyVisible(visible: boolean): void {
    if (!visible) this.pause();
    this.elements.topologyPlayback.hidden = !visible;
    this.elements.playbackEmpty.hidden = visible;
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

    const currentDecision = decisionAtTime(this.decisionTrace, snapshot.time);
    const topologySnapshot = snapshotWithCandidateModules(snapshot, currentDecision, this.device);
    this.elements.stage.innerHTML = renderEquipmentTopology(topologySnapshot, currentDecision);
    this.elements.decisionLens.innerHTML = renderDecisionLens(currentDecision, this.decisionTrace);

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

  /** 请求并绘制与播放时刻无关的服务端排程性能诊断。 */
  private async renderPerformance(): Promise<void> {
    if (!this.moves.length) return;
    const requestVersion = ++this.analysisRequestVersion;
    this.elements.performance.innerHTML = '<div class="visual-loader" aria-label="正在分析"></div>';
    try {
      const result = await requestScheduleAnalysis({
        ...(this.analysisResultId
          ? { resultId: this.analysisResultId }
          : { moves: this.moves }),
        device: this.device,
        windowMode: this.performanceWindowMode,
        routes: this.analysisRoutes,
        rounds: this.analysisRounds,
      });
      if (requestVersion !== this.analysisRequestVersion) return;
      this.analysis = result.analysis;
      this.bottleneckSummary = result.bottleneck;
      this.elements.performance.innerHTML = renderSchedulePerformance(result.analysis);
      const windowSlot = this.elements.performance.querySelector(".bottleneck-window-slot");
      if (windowSlot) {
        this.elements.performanceWindow.tabIndex = 0;
        windowSlot.append(this.elements.performanceWindow);
      }
    } catch (error) {
      if (requestVersion !== this.analysisRequestVersion) return;
      this.analysis = null;
      this.bottleneckSummary = null;
      this.elements.performance.innerHTML = `
        <div class="visual-empty is-error">
          <strong>结果分析失败</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span>
        </div>`;
    }
  }

  /** 显示加载状态并保留明确的系统反馈。 */
  private setLoading(loading: boolean, message: string): void {
    this.pause();
    this.setTopologyVisible(false);
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.playbackEmpty.hidden = false;
    this.elements.empty.classList.toggle("is-loading", loading);
    this.elements.playbackEmpty.classList.toggle("is-loading", loading);
    this.elements.empty.classList.remove("is-error");
    this.elements.playbackEmpty.classList.remove("is-error");
    const loadingMarkup = loading
      ? `<span class="visual-loader" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong>`
      : `<strong>${escapeHtml(message)}</strong>`;
    this.elements.empty.innerHTML = loadingMarkup;
    this.elements.playbackEmpty.innerHTML = loadingMarkup;
  }

  /** 在工作台空状态中显示可恢复的错误。 */
  private showError(message: string): void {
    this.pause();
    this.setTopologyVisible(false);
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.playbackEmpty.hidden = false;
    this.elements.empty.classList.remove("is-loading");
    this.elements.playbackEmpty.classList.remove("is-loading");
    this.elements.empty.classList.add("is-error");
    this.elements.playbackEmpty.classList.add("is-error");
    const errorMarkup = `
      <strong>无法加载 MoveList</strong>
      <span>${escapeHtml(message)}</span>
      <label class="btn visual-import-button">${icon("upload")}重新选择文件<input type="file" accept=".json,application/json" data-visual-retry></label>`;
    this.elements.empty.innerHTML = errorMarkup;
    this.elements.playbackEmpty.innerHTML = errorMarkup;
    [this.elements.empty, this.elements.playbackEmpty].forEach(container => {
      const retryInput = container.querySelector<HTMLInputElement>("[data-visual-retry]");
      retryInput?.addEventListener("change", () => {
        const file = retryInput.files?.item(0);
        if (file) this.loadFile(file).catch(error => this.showError(error instanceof Error ? error.message : String(error)));
      });
    });
  }
}

/** 在页面加载后创建工作台控制器。 */
export function createVisualizationWorkspace(root: Document = document): VisualizationWorkspace {
  return new VisualizationWorkspace(root);
}
