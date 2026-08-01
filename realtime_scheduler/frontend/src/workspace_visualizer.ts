/**
 * MoveList 结果展示与回放页面。
 *
 * 本模块负责把调度输出回放成设备、机器人、晶圆和腔室门的可观察状态，并管理
 * 时间轴、播放控制、结果加载和本地文件导入。性能指标通过服务端 API 获取；
 * 本文件不实现分析规则，也不持久化业务数据。
 */

import { requestReplayDecision, requestScheduleAnalysis } from "./api_client";
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
  processedWafers: string[];
  loadPortSlots: LoadPortSlotSnapshot[];
  activeMoveName: string;
  progress: number;
  environment: string;
  loadLockPhase: "" | "pumping" | "venting";
  isRobotTarget: boolean;
}

export interface RobotSnapshot {
  name: string;
  wafers: string[];
  processedWafers: string[];
  busy: boolean;
  source: string;
  target: string;
  activeMoveName: string;
  isPreTrans: boolean;
  preTransProgress: number;
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

export interface LoadPortSlotSnapshot {
  slot: number;
  wafer: string;
  processed: boolean;
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
  executed: boolean;
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
  executedActionId: string;
  candidateCount: number;
  shownCandidateCount: number;
  candidatesTruncated: boolean;
  modelEvaluated: boolean;
  replayEvaluated: boolean;
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
  alignerFilter: HTMLInputElement;
  coolerFilter: HTMLInputElement;
  pauseOnDecisionChangeButton: HTMLButtonElement;
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
  importButton: HTMLButtonElement | null;
  openGantt: HTMLAnchorElement;
  resultButton: HTMLButtonElement;
  performance: HTMLElement;
  performanceWindow: HTMLSelectElement;
}

const PICK_MOVE_TYPES = new Set([0, 2]);
const PLACE_MOVE_TYPES = new Set([1, 3]);
const SWAP_MOVE = 4;
const PRE_TRANS_MOVE = 5;
const PREPARE_MOVE = 6;
const COMPLETE_MOVE = 7;
const PROCESS_MOVE = 9;
const PRE_PREPARE_MOVE = 10;
const PUMP_MOVE = 12;
const VENT_MOVE = 13;
const CLEAN_MOVE = 14;
const LOADLOCK_ENVIRONMENT_MOVE_TYPES = new Set([PRE_PREPARE_MOVE, PUMP_MOVE, VENT_MOVE]);
const PLAYBACK_FRAME_INTERVAL_MS = 40;
const DOOR_VISUAL_MIN_SECONDS = 0.7;
const DEFAULT_PLAYBACK_SPEED = 4;
const PERFORMANCE_DISPLAY_TOLERANCE = 1e-6;
const DEFAULT_LOAD_PORT_CAPACITY = 25;

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
          executed: Boolean(candidate.executed),
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
        executedActionId: String(step.executedActionId ?? ""),
        candidateCount: Math.max(candidates.length, finiteNumber(step.candidateCount, candidates.length)),
        shownCandidateCount: Math.max(candidates.length, finiteNumber(step.shownCandidateCount, candidates.length)),
        candidatesTruncated: Boolean(step.candidatesTruncated),
        modelEvaluated: Boolean(step.modelEvaluated),
        replayEvaluated: Boolean(step.replayEvaluated),
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

/** 画布仅展示参与核心工艺路径的设备，辅助缓存与温控站点保留在底层数据中。 */
function isTopologyHiddenModule(module: ModuleSnapshot): boolean {
  const name = module.name.trim();
  const type = module.type.trim().toLowerCase();
  return /^BUF(?:FER)?(?:[_-]?\w+)?$/i.test(name)
    || type === "buffer"
    || isDummyPortName(name)
    || type === "dummyport"
    || /^HEATER$/i.test(name)
    || type === "heater";
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

/**
 * 从设备定义解析 LoadLock 的初始环境。
 * 设备文件用 LastItem 记录环境（ATR 大气 / VTR 真空，与服务端 update 输出一致）；
 * 缺省时按大气处理——LoadLock 默认连接大气侧，且后端 state 默认 ATMOSPHERE。
 */
function initialLoadLockEnvironment(device: DeviceDefinition | null, name: string): string {
  const lastItem = String(device?.Stations?.[name]?.LastItem ?? "");
  if (/VTR|VAC|真空/i.test(lastItem)) return "真空";
  if (/ATR|ATM|大气/i.test(lastItem)) return "大气";
  return "大气";
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

/** 返回列表字段中与材料下标对应的站点；单站点列表会复用于所有材料。 */
function indexedStation(move: NormalizedMove, field: string, index: number): string {
  const stations = listValue(move[field]).map(String);
  return String(stations[index] ?? stations[0] ?? "");
}

/** 返回列表字段中与材料下标对应的正整数槽位。 */
function indexedSlot(move: NormalizedMove, field: string, index: number): number {
  const slots = listValue(move[field]);
  const slot = finiteNumber(slots[index] ?? slots[0], 0);
  return Number.isInteger(slot) && slot > 0 ? slot : 0;
}

/** 从设备定义读取 LoadPort 容量，并兼容只声明 Slots 的旧设备。 */
function loadPortCapacity(
  device: DeviceDefinition | null,
  name: string,
  observedMaximum: number,
): number {
  const definition = device?.Stations?.[name] ?? {};
  const declaredSlots = listValue(definition.Slots).map(value => finiteNumber(value, 0));
  const declaredCapacity = Math.max(
    finiteNumber(definition.Capacity, 0),
    declaredSlots.length,
    ...declaredSlots,
  );
  return Math.max(
    1,
    declaredCapacity || DEFAULT_LOAD_PORT_CAPACITY,
    observedMaximum,
  );
}

/**
 * 从完整 MoveList 重建 LoadPort 的正视槽位占用。
 * 初始晶圆由未来第一次从 LP 取片时的 SrcSlotList 定位，已完成取放动作再逐条更新，
 * 因此晶圆离开后原槽会保持为空，回片也会落回 DestSlotList 指定的物理槽位。
 */
function buildLoadPortSlots(
  records: NormalizedMove[],
  device: DeviceDefinition | null,
  time: number,
  initialLocations: Map<string, string>,
  processedMaterials: Set<string>,
): Map<string, LoadPortSlotSnapshot[]> {
  const names = new Set<string>();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isLoadPortName(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isLoadPortName(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }

  const initialByPort = new Map<string, Map<number, string>>();
  const observedMaximum = new Map<string, number>();
  for (const move of records) {
    if (!PICK_MOVE_TYPES.has(move.MoveType)) continue;
    materialIds(move).forEach((material, index) => {
      const source = indexedStation(move, "SrcStationList", index);
      const type = String(device?.Stations?.[source]?.Type ?? "");
      if (!source || !isLoadPortName(source, type)) return;
      names.add(source);
      const slot = indexedSlot(move, "SrcSlotList", index);
      if (!slot) return;
      const occupancy = initialByPort.get(source) ?? new Map<number, string>();
      if (!occupancy.has(slot)) occupancy.set(slot, material);
      initialByPort.set(source, occupancy);
      observedMaximum.set(source, Math.max(observedMaximum.get(source) ?? 0, slot));
    });
  }

  const result = new Map<string, LoadPortSlotSnapshot[]>();
  for (const name of names) {
    const occupancy = new Map(initialByPort.get(name) ?? []);
    const initialMaterials = [...initialLocations.entries()]
      .filter(([, location]) => location === name)
      .map(([material]) => material)
      .sort(naturalCompare);
    const assigned = new Set(occupancy.values());
    let fallbackSlot = 1;
    for (const material of initialMaterials) {
      if (assigned.has(material)) continue;
      while (occupancy.has(fallbackSlot)) fallbackSlot += 1;
      occupancy.set(fallbackSlot, material);
      assigned.add(material);
    }

    for (const move of records) {
      if (move.EndTime > time) continue;
      const materials = materialIds(move);
      if (PICK_MOVE_TYPES.has(move.MoveType)) {
        materials.forEach((material, index) => {
          if (indexedStation(move, "SrcStationList", index) !== name) return;
          const slot = indexedSlot(move, "SrcSlotList", index);
          if (slot) occupancy.delete(slot);
          else {
            const current = [...occupancy.entries()].find(([, wafer]) => wafer === material);
            if (current) occupancy.delete(current[0]);
          }
        });
      } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
        materials.forEach((material, index) => {
          if (indexedStation(move, "DestStationList", index) !== name) return;
          let slot = indexedSlot(move, "DestSlotList", index);
          if (!slot) {
            slot = 1;
            while (occupancy.has(slot)) slot += 1;
          }
          occupancy.set(slot, material);
          observedMaximum.set(name, Math.max(observedMaximum.get(name) ?? 0, slot));
        });
      }
    }

    const occupiedMaximum = occupancy.size ? Math.max(...occupancy.keys()) : 0;
    const capacity = loadPortCapacity(
      device,
      name,
      Math.max(observedMaximum.get(name) ?? 0, occupiedMaximum, initialMaterials.length),
    );
    result.set(name, Array.from({ length: capacity }, (_, index) => {
      const wafer = occupancy.get(index + 1) ?? "";
      return { slot: index + 1, wafer, processed: Boolean(wafer && processedMaterials.has(wafer)) };
    }));
  }
  return result;
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
  const initialLocations = initialMaterialLocations(records);
  const locations = new Map(initialLocations);
  const doorStates = new Map<string, DoorStatus>();
  const environments = new Map<string, string>();
  const processedMaterials = new Set<string>();
  const activeMoves: NormalizedMove[] = [];
  let completedMoves = 0;

  for (const [name, definition] of definitions) {
    doorStates.set(name, isDoorlessModule(name, definition.type) ? "doorless" : "closed");
    if (isLoadLockName(name, definition.type)) {
      environments.set(name, initialLoadLockEnvironment(device, name));
    }
  }

  for (const move of records) {
    const active = move.StartTime <= time && time < move.EndTime;
    const completed = move.EndTime <= time;
    if (active) activeMoves.push(move);
    if (completed) {
      completedMoves += 1;
      applyCompletedTransfer(move, locations);
      if (move.MoveType === PROCESS_MOVE) {
        for (const material of materialIds(move)) processedMaterials.add(material);
      }
    }

    const doorVisualActive = move.StartTime <= time
      && time < Math.max(move.EndTime, move.StartTime + DOOR_VISUAL_MIN_SECONDS);
    if (move.MoveType === PREPARE_MOVE) {
      if (doorVisualActive) doorStates.set(move.ModuleName, "opening");
      else if (completed) doorStates.set(move.ModuleName, "open");
    } else if (move.MoveType === COMPLETE_MOVE) {
      if (doorVisualActive) doorStates.set(move.ModuleName, "closing");
      else if (completed) doorStates.set(move.ModuleName, "closed");
    } else if (LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType) && (active || completed)) {
      const currentState = move.MoveType === PUMP_MOVE
        ? "VAC"
        : move.MoveType === VENT_MOVE
          ? "ATM"
          : String(move.CurState ?? "");
      const environment = /VTR|VAC/i.test(currentState) ? "真空" : /ATR|ATM/i.test(currentState) ? "大气" : currentState;
      if (environment) environments.set(move.ModuleName, active ? `${environment}切换中` : environment);
    }
  }

  const robotTargets = new Map<string, string>();
  for (const move of activeMoves) {
    if (isRobotName(move.ModuleName)) robotTargets.set(move.ModuleName, activeTarget(move));
  }
  const lastRobotTargets = new Map<string, string>();
  for (const move of records) {
    if (move.StartTime > time || !isRobotName(move.ModuleName)) continue;
    const target = activeTarget(move);
    if (target) lastRobotTargets.set(move.ModuleName, target);
  }

  const wafersByLocation = new Map<string, string[]>();
  for (const [material, location] of locations) {
    if (!location) continue;
    const wafers = wafersByLocation.get(location) ?? [];
    wafers.push(material);
    wafersByLocation.set(location, wafers);
  }
  for (const wafers of wafersByLocation.values()) wafers.sort(naturalCompare);
  const loadPortSlots = buildLoadPortSlots(records, device, time, initialLocations, processedMaterials);

  const modules = [...definitions.entries()].map(([name, definition]): ModuleSnapshot => {
    const moduleMoves = activeMoves.filter(move => (
      move.ModuleName === name
      || firstStation(move, "SrcStationList") === name
      || firstStation(move, "DestStationList") === name
      || listValue(move.StationList).map(String).includes(name)
    ));
    const primaryMove = moduleMoves.find(move => move.MoveType === CLEAN_MOVE)
      ?? moduleMoves.find(move => move.MoveType === PROCESS_MOVE)
      ?? moduleMoves.find(move => LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType))
      ?? moduleMoves.find(move => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType))
      ?? moduleMoves[0];
    let status: ModuleStatus = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove?.MoveType === CLEAN_MOVE) status = "cleaning";
    else if (primaryMove?.MoveType === PROCESS_MOVE) status = "processing";
    else if (primaryMove && LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(primaryMove.MoveType)) status = "environment";
    else if (primaryMove && [PREPARE_MOVE, COMPLETE_MOVE].includes(primaryMove.MoveType)) status = "door";
    else if (primaryMove) status = "transfer";
    const currentEnvironment = String(primaryMove?.CurState ?? "");
    const prePrepareType = String(primaryMove?.PrePrepareType ?? "");
    const loadLockPhase = primaryMove && LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(primaryMove.MoveType)
      ? (primaryMove.MoveType === PUMP_MOVE || /VTR|VAC|PUMP/i.test(`${currentEnvironment} ${prePrepareType}`)
          ? "pumping"
          : primaryMove.MoveType === VENT_MOVE || /ATR|ATM|VENT/i.test(`${currentEnvironment} ${prePrepareType}`)
            ? "venting"
            : "")
      : "";
    return {
      name,
      type: definition.type,
      status,
      door: doorStates.get(name) ?? "closed",
      wafers: wafersByLocation.get(name) ?? [],
      processedWafers: (wafersByLocation.get(name) ?? []).filter(wafer => processedMaterials.has(wafer)),
      loadPortSlots: loadPortSlots.get(name) ?? [],
      activeMoveName: primaryMove ? (MOVE_NAMES[primaryMove.MoveType] ?? `动作 ${primaryMove.MoveType}`) : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      loadLockPhase,
      isRobotTarget: [...robotTargets.values()].includes(name),
    };
  }).sort((left, right) => naturalCompare(left.name, right.name));

  const robots = robotNames.map((name): RobotSnapshot => {
    const move = activeMoves.find(record => record.ModuleName === name);
    return {
      name,
      wafers: wafersByLocation.get(name) ?? [],
      processedWafers: (wafersByLocation.get(name) ?? []).filter(wafer => processedMaterials.has(wafer)),
      busy: Boolean(move),
      source: move ? firstStation(move, "SrcStationList") : "",
      target: robotTargets.get(name) ?? lastRobotTargets.get(name) ?? "",
      activeMoveName: move ? (MOVE_NAMES[move.MoveType] ?? `动作 ${move.MoveType}`) : "",
      isPreTrans: move?.MoveType === PRE_TRANS_MOVE,
      preTransProgress: move?.MoveType === PRE_TRANS_MOVE ? moveProgress(move, time) : 1,
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
    alignerFilter: required<HTMLInputElement>("visualFilterAligner"),
    coolerFilter: required<HTMLInputElement>("visualFilterCooler"),
    pauseOnDecisionChangeButton: required<HTMLButtonElement>("visualPauseOnDecisionChangeButton"),
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
    importButton: root.getElementById("visualImportButton") as HTMLButtonElement | null,
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
    const type = String(device?.Stations?.[name]?.Type ?? "");
    modules.push({
      name,
      type,
      status: "idle",
      door: "closed",
      wafers: [],
      processedWafers: [],
      loadPortSlots: [],
      activeMoveName: "",
      progress: 0,
      environment: isLoadLockName(name, type) ? initialLoadLockEnvironment(device, name) : "",
      loadLockPhase: "",
      isRobotTarget: false,
    });
    knownNames.add(name);
  }
  return {
    ...snapshot,
    modules: modules.sort((left, right) => naturalCompare(left.name, right.name)),
  };
}

/**
 * 把设备配置中尚未被 MoveList 引用的腔室并入拓扑快照。
 * 工艺模块、LoadLock 与辅助腔室完整保留；未被 MoveList 使用的 LoadPort 不再占用画布。
 * 已存在模块保留其回放状态；新增模块以空闲、门关闭的初始状态呈现。
 */
export function snapshotWithFullDeviceModules(
  snapshot: WorkspaceSnapshot,
  device: DeviceDefinition | null,
): WorkspaceSnapshot {
  const modules = [...snapshot.modules];
  const knownNames = new Set(modules.map(module => module.name));
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (knownNames.has(name) || isRobotName(name)) continue;
    const type = String(definition?.Type ?? "");
    if (isLoadPortName(name, type)) continue;
    modules.push({
      name,
      type,
      status: "idle",
      door: isDoorlessModule(name, type) ? "doorless" : "closed",
      wafers: [],
      processedWafers: [],
      loadPortSlots: [],
      activeMoveName: "",
      progress: 0,
      environment: isLoadLockName(name, type) ? initialLoadLockEnvironment(device, name) : "",
      loadLockPhase: "",
      isRobotTarget: false,
    });
    knownNames.add(name);
  }
  return {
    ...snapshot,
    modules: modules.sort((left, right) => naturalCompare(left.name, right.name)),
  };
}
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

/** 绘制原版风格的绿色晶圆；外圈由当前腔室加工进度驱动。 */
function renderWaferToken(wafer: string, progress: number, processed = false): string {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  const state = processed ? "processed" : "unprocessed";
  return `<span class="wafer-token wafer-${state}" style="--wafer-progress:${normalizedProgress * 360}deg" title="晶圆 ${escapeHtml(wafer)}，${processed ? "已加工" : "未加工"}"><span>${escapeHtml(wafer)}</span></span>`;
}

/** 门始终朝向对应机械手；LoadLock 改由正视双层结构单独表达。 */
function moduleDoorSides(
  module: ModuleSnapshot,
  role: "process" | "lock" | "port" | "auxiliary",
): Array<"top" | "right" | "bottom" | "left"> {
  if (module.door === "doorless") return [];
  if (role === "lock") return [];
  if (role === "port") return [];
  const name = module.name.trim().toUpperCase();
  if (/^PM[12]$/.test(name)) return ["right"];
  if (/^PM[56]$/.test(name) || name === "HEATER") return ["left"];
  if (/^PM[34]$/.test(name)) return ["bottom"];
  if (["AL", "ALIGNER"].includes(name)) return ["right"];
  if (["CL", "COOLER"].includes(name)) return ["left"];
  return ["top"];
}

/** 绘制 LoadPort 正视晶圆盒；空槽、未加工和已加工均保留独立语义。 */
function renderLoadPortCassette(module: ModuleSnapshot): string {
  const slots = module.loadPortSlots.length
    ? module.loadPortSlots
    : module.wafers.map((wafer, index) => ({
        slot: index + 1,
        wafer,
        processed: module.processedWafers.includes(wafer),
      }));
  const processed = slots.filter(slot => slot.wafer && slot.processed).length;
  const unprocessed = slots.filter(slot => slot.wafer && !slot.processed).length;
  const slotMarkup = slots.map(slot => {
    const state = !slot.wafer ? "empty" : slot.processed ? "processed" : "unprocessed";
    const label = slot.wafer
      ? `槽位 ${slot.slot}，晶圆 ${slot.wafer}，${slot.processed ? "已加工" : "未加工"}`
      : `槽位 ${slot.slot}，空`;
    return `<span class="load-port-slot is-${state}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`;
  }).join("");
  return `<div class="load-port-cassette" role="group" aria-label="${escapeHtml(`${module.name} 正视晶圆盒，共 ${slots.length} 个槽位，未加工 ${unprocessed}，已加工 ${processed}`)}">
    <span class="load-port-cassette-handle" aria-hidden="true"></span>
    <div class="load-port-slot-bank">${slotMarkup}</div>
  </div>`;
}

/** 绘制拓扑中的紧凑腔室；可见文字只保留腔室名称和晶圆 ID。 */
function renderModule(
  module: ModuleSnapshot,
  role: "process" | "lock" | "port" | "auxiliary",
  candidate: CandidateDestinationSummary | undefined,
): string {
  const waferProgress = module.status === "processing" ? module.progress : 0;
  const visibleWaferCount = role === "lock" ? 2 : 1;
  const processedWafers = new Set(module.processedWafers ?? []);
  const wafers = module.wafers.slice(0, visibleWaferCount)
    .map(wafer => renderWaferToken(wafer, waferProgress, processedWafers.has(wafer)))
    .join("");
  const overflow = module.wafers.length > visibleWaferCount
    ? `<span class="wafer-more">+ ${module.wafers.length - visibleWaferCount}</span>`
    : "";
  const doors = moduleDoorSides(module, role)
    .map(side => `<i class="chamber-door chamber-door-${side}"></i>`)
    .join("");
  const accessibleStatus = `${module.name}，${STATUS_LABELS[module.status]}，${DOOR_LABELS[module.door]}`;
  const candidateLabel = candidate
    ? `${candidate.count} 个可行动作，最高模型偏好 ${(candidate.preference * 100).toFixed(0)}%`
    : "";
  const atmosphereLevel = role === "lock"
    ? module.loadLockPhase === "pumping"
      ? 100 - module.progress * 100
      : module.loadLockPhase === "venting"
        ? module.progress * 100
        : /大气|ATM|ATR/i.test(module.environment)
          ? 100
          : 0
    : 0;
  const loadLockLayers = role === "lock"
    ? `<div class="loadlock-layers" aria-hidden="true">${[0, 1].map(index => {
        const wafer = module.wafers[index];
        const processed = wafer ? processedWafers.has(wafer) : false;
        const waferState = processed ? "processed" : "unprocessed";
        return `<div class="loadlock-layer ${wafer ? "is-occupied" : "is-empty"}">${wafer ? `<span class="loadlock-wafer-line wafer-${waferState}" title="晶圆 ${escapeHtml(wafer)}（${processed ? "已加工" : "未加工"}）"></span>` : ""}</div>`;
      }).join("")}${overflow}</div>`
    : role === "process"
      ? `<div class="process-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>`
      : role === "port"
        ? `<div class="load-port-dock-face" aria-hidden="true"><span></span></div>`
        : role === "auxiliary"
          ? `<div class="auxiliary-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>`
        : `<div class="wafer-stack">${wafers}${overflow}</div>`;
  const article = `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.loadLockPhase ? `loadlock-${module.loadLockPhase}` : ""} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" style="--module-progress:${Math.round(module.progress * 100)}%;--loadlock-atmosphere:${Math.max(0, Math.min(100, atmosphereLevel)).toFixed(1)}%;--loadlock-atmosphere-ratio:${Math.max(0, Math.min(1, atmosphereLevel / 100)).toFixed(3)}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `，${candidateLabel}` : ""}`)}">
      <div class="equipment-body">
        ${loadLockLayers}
      </div>
      <div class="chamber-doors" aria-hidden="true">${role === "lock" ? '<i class="loadlock-door loadlock-door-vacuum"></i><i class="loadlock-door loadlock-door-atmosphere"></i>' : doors}</div>
    </article>`;
  if (role === "process" || role === "auxiliary" || role === "lock") {
    return `<strong class="equipment-external-name">${escapeHtml(module.name)}</strong>${article}`;
  }
  if (role === "port") {
    return `<strong class="equipment-external-name equipment-external-name-port">${escapeHtml(module.name)}</strong><div class="load-port-assembly">${article}${renderLoadPortCassette(module)}</div>`;
  }
  return article;
}

/** 绘制单槽仿真机器人：圆形基座、旋转臂和勺形末端执行器。 */
function renderRobotHub(
  robot: RobotSnapshot,
  environment: "vacuum" | "atmosphere",
  angleDegrees: number,
): string {
  const wafer = robot.wafers[0]
    ? renderWaferToken(robot.wafers[0], 0, robot.processedWafers.includes(robot.wafers[0]))
    : "";
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" style="--robot-arm-angle:${angleDegrees.toFixed(1)}deg" aria-label="${escapeHtml(robot.name)}，单槽机械手，${robot.busy ? "工作中" : "待命"}${robot.wafers[0] ? `，持有晶圆 ${robot.wafers[0]}` : "，槽位为空"}">
      <span class="robot-environment-badge">${environment === "vacuum" ? "VAC" : "ATM"}</span>
      <div class="robot-mechanism" aria-hidden="true">
        <span class="robot-base"><i></i></span>
        <span class="robot-arm">
          <i class="robot-arm-beam"></i>
          <span class="robot-end-effector ${wafer ? "is-occupied" : "is-empty"}"><i class="robot-fork-tine robot-fork-tine-top"></i><i class="robot-fork-tine robot-fork-tine-bottom"></i>${wafer}</span>
        </span>
      </div>
    </article>`;
}

interface TopologyPosition {
  leftPercent: number;
  topPixels: number;
  widthPixels?: number;
  heightPixels?: number;
}

interface TopologyVerticalExtent {
  top: number;
  bottom: number;
}

const TOPOLOGY_COLUMN_PERCENTAGES = [26, 42, 58, 74] as const;
const TOPOLOGY_ROW_TOP_PIXELS = [52, 154, 256, 358, 460, 562, 664, 786, 929, 1031, 1133] as const;
const TOPOLOGY_VIEWBOX_WIDTH = 1000;
const TOPOLOGY_ITEM_SIZE = 96;
const TOPOLOGY_PROCESS_WIDTH = 112;
const TOPOLOGY_PROCESS_HEIGHT = 104;
const TOPOLOGY_ROBOT_SIZE = 132;
const TOPOLOGY_LOADLOCK_WIDTH = 120;
const TOPOLOGY_LOADLOCK_HEIGHT = 72;
const TOPOLOGY_LOADPORT_WIDTH = 144;
const TOPOLOGY_LOADPORT_HEIGHT = 104;
const TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS = [664, 740] as const;
const TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS = 866;
const TOPOLOGY_LOADPORT_ROW_TOP_PIXELS = 990;
const TOPOLOGY_CANVAS_PADDING = 28;
const TOPOLOGY_EXTERNAL_LABEL_CLEARANCE = 22;
const TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP = TOPOLOGY_ROW_TOP_PIXELS[4] - 32;
const TOPOLOGY_SINGLE_PROCESS_LOWER_TOP = TOPOLOGY_ROW_TOP_PIXELS[5] - 10;

/** 返回均匀分布在四列设备网格中的横向位置。 */
function distributedTopologyColumns(count: number): number[] {
  if (count <= 1) return [50];
  if (count === 2) return [40, 60];
  if (count === 3) return [30, 50, 70];
  return Array.from({ length: count }, (_, index) => 20 + index * 60 / (count - 1));
}

/** 从模块名中提取 PM 编号，无法识别时返回 0。 */
function processModuleNumber(name: string): number {
  const match = /^PM[_-]?(\d+)$/i.exec(name.trim());
  return match ? finiteNumber(match[1]) : 0;
}

/** 判断拓扑是否使用参考仓库中的上下双真空机械手级联布局。 */
function usesCascadeTopology(modules: ModuleSnapshot[], vacuumRobotCount: number): boolean {
  return vacuumRobotCount > 1 || modules.some(module => (
    processModuleNumber(module.name) > 6 || /^BUF[_-]?[AB]$/i.test(module.name)
  ));
}

/** 按参考仓库 CenterCanvas 的四列网格计算模块坐标。 */
function moduleTopologyPosition(
  module: ModuleSnapshot,
  role: "process" | "lock" | "port" | "auxiliary",
  index: number,
  roleModules: ModuleSnapshot[],
  cascade: boolean,
): TopologyPosition {
  const name = module.name.trim().toUpperCase();
  const roleCount = roleModules.length;
  const column = TOPOLOGY_COLUMN_PERCENTAGES;
  const row = TOPOLOGY_ROW_TOP_PIXELS;
  const cascadePositions: Record<string, TopologyPosition> = {
    PM3: { leftPercent: column[1], topPixels: row[0] },
    PM4: { leftPercent: column[2], topPixels: row[0] },
    PM2: { leftPercent: column[0], topPixels: row[1] },
    PM1: { leftPercent: column[0], topPixels: row[2] + TOPOLOGY_EXTERNAL_LABEL_CLEARANCE },
    PM5: { leftPercent: column[3], topPixels: row[1] },
    PM6: { leftPercent: column[3], topPixels: row[2] + TOPOLOGY_EXTERNAL_LABEL_CLEARANCE },
    BUF_A: { leftPercent: column[1], topPixels: row[3] },
    BUFA: { leftPercent: column[1], topPixels: row[3] },
    BUF_B: { leftPercent: column[2], topPixels: row[3] },
    BUFB: { leftPercent: column[2], topPixels: row[3] },
    PM8: { leftPercent: column[0], topPixels: row[4] },
    PM7: { leftPercent: column[0], topPixels: row[5] + TOPOLOGY_EXTERNAL_LABEL_CLEARANCE },
    PM9: { leftPercent: column[3], topPixels: row[4] },
    PM10: { leftPercent: column[3], topPixels: row[5] + TOPOLOGY_EXTERNAL_LABEL_CLEARANCE },
  };
  const singlePositions: Record<string, TopologyPosition> = {
    PM3: { leftPercent: column[1], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP - TOPOLOGY_PROCESS_HEIGHT },
    PM4: { leftPercent: column[2], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP - TOPOLOGY_PROCESS_HEIGHT },
    PM2: { leftPercent: column[0], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP },
    PM1: { leftPercent: column[0], topPixels: TOPOLOGY_SINGLE_PROCESS_LOWER_TOP },
    PM5: { leftPercent: column[3], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP },
    PM6: { leftPercent: column[3], topPixels: TOPOLOGY_SINGLE_PROCESS_LOWER_TOP },
  };
  const explicit = (cascade ? cascadePositions : singlePositions)[name];
  if (explicit) {
    return role === "process"
      ? { ...explicit, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT }
      : explicit;
  }
  if (role === "lock") {
    const canonicalOrder: Record<string, number> = { LA: 0, LC: 1, LB: 2, LD: 3 };
    const orderedLoadLocks = [...roleModules].sort((left, right) => {
      const leftName = left.name.trim().toUpperCase();
      const rightName = right.name.trim().toUpperCase();
      const leftRank = canonicalOrder[leftName] ?? 100;
      const rightRank = canonicalOrder[rightName] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const gridIndex = Math.max(0, orderedLoadLocks.findIndex(item => item.name === module.name));
    const loadLockRowGap = TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[1] - TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    return {
      leftPercent: gridIndex % 2 === 0 ? 40 : 60,
      topPixels: TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0] + Math.floor(gridIndex / 2) * loadLockRowGap,
      widthPixels: TOPOLOGY_LOADLOCK_WIDTH,
      heightPixels: TOPOLOGY_LOADLOCK_HEIGHT,
    };
  }
  if (role === "port") {
    const loadPortColumns: Record<string, number> = {
      LP1: column[0], LP2: column[1], LP3: column[2], LP4: column[3],
    };
    if (loadPortColumns[name] !== undefined) {
      return {
        leftPercent: loadPortColumns[name],
        topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS,
        widthPixels: TOPOLOGY_LOADPORT_WIDTH,
        heightPixels: TOPOLOGY_LOADPORT_HEIGHT,
      };
    }
    return {
      leftPercent: distributedTopologyColumns(roleCount)[index],
      topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS,
      widthPixels: TOPOLOGY_LOADPORT_WIDTH,
      heightPixels: TOPOLOGY_LOADPORT_HEIGHT,
    };
  }
  if (["AL", "ALIGNER"].includes(name)) return { leftPercent: column[0], topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS };
  if (["CL", "COOLER"].includes(name)) return { leftPercent: column[3], topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS };
  if (role === "auxiliary") {
    const perRow = 6;
    const rowIndex = Math.floor(index / perRow);
    const columnIndex = index % perRow;
    const columnsInRow = Math.max(1, Math.min(perRow, roleCount - rowIndex * perRow));
    const rowGap = row[1] - row[0];
    return {
      leftPercent: distributedTopologyColumns(columnsInRow)[columnIndex] ?? 50,
      topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS + row[1] - row[0] + rowIndex * rowGap,
    };
  }

  const fallbackRow = role === "process" ? row[3] : row[7];
  return {
    leftPercent: distributedTopologyColumns(Math.max(roleCount, 1))[index] ?? 50,
    topPixels: fallbackRow,
    ...(role === "process"
      ? { widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT }
      : {}),
  };
}

/** 按参考布局计算机器人的中央锚点。 */
function robotTopologyPosition(
  robotIndex: number,
  robotCount: number,
  environment: "vacuum" | "atmosphere",
  cascade: boolean,
): TopologyPosition {
  if (environment === "atmosphere") {
    if (robotCount > 1) {
      return {
        leftPercent: distributedTopologyColumns(robotCount)[robotIndex] ?? 50,
        topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS,
        widthPixels: TOPOLOGY_ROBOT_SIZE,
        heightPixels: TOPOLOGY_ROBOT_SIZE,
      };
    }
    return {
      leftPercent: 50,
      topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS,
      widthPixels: TOPOLOGY_ROBOT_SIZE,
      heightPixels: TOPOLOGY_ROBOT_SIZE,
    };
  }
  if (cascade && robotCount > 1) {
    return {
      leftPercent: 50,
      topPixels: robotIndex === 0
        ? TOPOLOGY_ROW_TOP_PIXELS[4]
        : (TOPOLOGY_ROW_TOP_PIXELS[1] + TOPOLOGY_ROW_TOP_PIXELS[2]) / 2
          + TOPOLOGY_EXTERNAL_LABEL_CLEARANCE / 2,
      widthPixels: TOPOLOGY_ROBOT_SIZE,
      heightPixels: TOPOLOGY_ROBOT_SIZE,
    };
  }
  return {
    leftPercent: 50,
    topPixels: (TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP + TOPOLOGY_SINGLE_PROCESS_LOWER_TOP) / 2,
    widthPixels: TOPOLOGY_ROBOT_SIZE,
    heightPixels: TOPOLOGY_ROBOT_SIZE,
  };
}

/** 把百分比横坐标转换为设备画布 SVG viewBox 坐标。 */
function topologySvgPoint(position: TopologyPosition): { x: number; y: number } {
  return {
    x: position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH,
    y: position.topPixels,
  };
}

/** 返回一组拓扑设备的垂直物理边界，用于绘制整机区域底板。 */
function topologyVerticalExtent(positions: TopologyPosition[]): TopologyVerticalExtent | null {
  if (!positions.length) return null;
  return {
    top: Math.min(...positions.map(position => (
      position.topPixels - (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2
    ))),
    bottom: Math.max(...positions.map(position => (
      position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2
    ))),
  };
}

/** 返回矩形边缘上朝向目标点的交点，避免指向线伸入设备卡片。 */
function topologyEdgePoint(
  center: { x: number; y: number },
  toward: { x: number; y: number },
  width = TOPOLOGY_ITEM_SIZE,
  height = TOPOLOGY_ITEM_SIZE,
): { x: number; y: number } {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return center;
  const scaleX = Math.abs(dx) > 1e-6 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = Math.abs(dy) > 1e-6 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/** 沿最短旋转方向插值角度，驱动真实 PRE_TRANS 机械手转位。 */
function interpolatedRobotAngle(start: number, end: number, progress: number): number {
  let delta = (end - start) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return start + delta * Math.max(0, Math.min(1, progress));
}

/**
 * LoadLock 田字布局使用靠近对应机械手的一排作为箭头入口：
 * ATR/ATM 固定进入下排 LB/LD，VTR 固定进入上排 LA/LC。
 */
function robotLoadLockPortal(
  robotName: string,
  moduleName: string,
  modulePositions: Map<string, TopologyPosition>,
): string {
  const normalizedModule = moduleName.trim().toUpperCase();
  const isAtmosphereRobot = /^(ATR|ATM)/i.test(robotName);
  const isVacuumRobot = /^(VTR|VTM)/i.test(robotName);
  if (!isAtmosphereRobot && !isVacuumRobot) return moduleName;
  const preferred = ["LA", "LB"].includes(normalizedModule)
    ? (isAtmosphereRobot ? "LB" : "LA")
    : ["LC", "LD"].includes(normalizedModule)
      ? (isAtmosphereRobot ? "LD" : "LC")
      : moduleName;
  return modulePositions.has(preferred) ? preferred : moduleName;
}

/** 从当前决策中找到模型选择的物理搬运意图。 */
function selectedDecisionCandidate(decision: DecisionTraceStep | null): DecisionCandidate | null {
  if (!decision) return null;
  return decision.candidates.find(candidate => candidate.selected)
    ?? decision.candidates.find(candidate => candidate.actionId === decision.selectedActionId)
    ?? decision.candidates.find(candidate => candidate.executed)
    ?? null;
}

/** 当前没有执行动作时，用 E2E 推荐意图补足机械手箭头目标。 */
function decisionTargetForRobot(
  robot: RobotSnapshot,
  decision: DecisionTraceStep | null,
): string {
  const candidate = selectedDecisionCandidate(decision);
  if (!candidate || candidate.robot !== robot.name) return "";
  if (candidate.source === robot.name) return candidate.destination;
  if (candidate.destination === robot.name) return candidate.source;
  return candidate.destination || candidate.source;
}

/** 生成当前机械手目标的统一实线箭头；无执行动作时仍显示 E2E 推荐意图。 */
function renderRobotTargetArrows(
  robots: RobotSnapshot[],
  robotPositions: Map<string, TopologyPosition>,
  modulePositions: Map<string, TopologyPosition>,
  canvasHeight: number,
  decision: DecisionTraceStep | null,
): string {
  const color = "var(--brand)";
  const lines = robots.map(robot => {
    const robotPosition = robotPositions.get(robot.name);
    const liveTarget = robot.target;
    const decisionTarget = liveTarget ? "" : decisionTargetForRobot(robot, decision);
    const target = liveTarget || decisionTarget;
    const targetName = robotLoadLockPortal(robot.name, target, modulePositions);
    const targetPosition = modulePositions.get(targetName);
    if (!robotPosition || !targetPosition || !target) return "";
    const robotCenter = topologySvgPoint(robotPosition);
    const targetCenter = topologySvgPoint(targetPosition);
    const endPoint = topologyEdgePoint(
      targetCenter,
      robotCenter,
      targetPosition.widthPixels,
      targetPosition.heightPixels,
    );
    const startPoint = topologyEdgePoint(robotCenter, endPoint);
    return `<line class="${decisionTarget ? "is-decision-target" : "is-live-target"}" data-robot="${escapeHtml(robot.name)}" data-target="${escapeHtml(target)}" x1="${startPoint.x}" y1="${startPoint.y}" x2="${endPoint.x}" y2="${endPoint.y}" stroke="${color}" marker-end="url(#topology-arrowhead)"/>`;
  }).join("");
  const marker = `<marker id="topology-arrowhead" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="${color}"/></marker>`;
  return `<svg class="topology-target-arrows" viewBox="0 0 ${TOPOLOGY_VIEWBOX_WIDTH} ${canvasHeight}" preserveAspectRatio="none" aria-hidden="true"><defs>${marker}</defs>${lines}</svg>`;
}

/** 返回模块是否被画布下方的模块筛选隐藏（当前支持 Aligner 与 Cooler 两类辅助模块）。 */
function isModuleFilteredOut(module: ModuleSnapshot, hiddenFilters?: ReadonlySet<string>): boolean {
  if (!hiddenFilters?.size) return false;
  const normalized = module.name.trim().toUpperCase();
  const type = module.type.trim().toLowerCase();
  return (hiddenFilters.has("aligner") && (/^(AL|ALIGNER)$/.test(normalized) || type === "aligner"))
    || (hiddenFilters.has("cooler") && (/^(CL|COOL(?:ER)?)$/.test(normalized) || type === "cooler"));
}

/** 按参考仓库的四列网格绘制机械手、腔室、Load Lock 与装载端口。 */
export function renderEquipmentTopology(
  snapshot: WorkspaceSnapshot,
  decision: DecisionTraceStep | null,
  hiddenFilters?: ReadonlySet<string>,
): string {
  const visibleModules = snapshot.modules.filter(module => (
    !isTopologyHiddenModule(module) && !isModuleFilteredOut(module, hiddenFilters)
  ));
  const groups = topologyGroups(visibleModules);
  const destinations = candidateDestinations(decision);
  const atmosphereRobots = snapshot.robots.filter(robot => /^(ATR|ATM)/i.test(robot.name));
  const atmosphereNames = new Set(atmosphereRobots.map(robot => robot.name));
  const vacuumRobots = snapshot.robots.filter(robot => !atmosphereNames.has(robot.name));
  const cascade = usesCascadeTopology(visibleModules, vacuumRobots.length);
  const modulePositions = new Map<string, TopologyPosition>();
  const positionModuleGroup = (
    modules: ModuleSnapshot[],
    role: "process" | "lock" | "port" | "auxiliary",
  ): void => modules.forEach((module, index) => {
    const position = moduleTopologyPosition(module, role, index, modules, cascade);
    modulePositions.set(module.name, position);
  });
  positionModuleGroup(groups.processModules, "process");
  positionModuleGroup(groups.loadLocks, "lock");
  positionModuleGroup(groups.loadPorts, "port");
  positionModuleGroup(groups.auxiliaryModules, "auxiliary");

  const robotPositions = new Map<string, TopologyPosition>();
  const positionRobotGroup = (
    robots: RobotSnapshot[],
    environment: "vacuum" | "atmosphere",
  ): void => robots.forEach((robot, index) => {
    const position = robotTopologyPosition(index, robots.length, environment, cascade);
    robotPositions.set(robot.name, position);
  });
  positionRobotGroup(vacuumRobots, "vacuum");
  positionRobotGroup(atmosphereRobots, "atmosphere");

  const allPositions = [
    ...modulePositions.values(),
    ...robotPositions.values(),
  ];
  const minimumTop = allPositions.length
    ? Math.min(...allPositions.map(position => position.topPixels - (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2))
    : 0;
  const maximumBottom = allPositions.length
    ? Math.max(...allPositions.map(position => position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2))
    : TOPOLOGY_ITEM_SIZE;
  const verticalOffset = TOPOLOGY_CANVAS_PADDING - minimumTop;
  const canvasHeight = Math.max(
    520,
    Math.ceil(maximumBottom + verticalOffset + TOPOLOGY_CANVAS_PADDING),
  );
  for (const [name, position] of modulePositions) {
    modulePositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  for (const [name, position] of robotPositions) {
    robotPositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }

  const positionedModules = (modules: ModuleSnapshot[]): TopologyPosition[] => modules
    .map(module => modulePositions.get(module.name))
    .filter((position): position is TopologyPosition => Boolean(position));
  const positionedRobots = (robots: RobotSnapshot[]): TopologyPosition[] => robots
    .map(robot => robotPositions.get(robot.name))
    .filter((position): position is TopologyPosition => Boolean(position));
  const vacuumExtent = topologyVerticalExtent([
    ...positionedModules(groups.processModules),
    ...positionedRobots(vacuumRobots),
  ]);
  const interfaceExtent = topologyVerticalExtent(positionedModules(groups.loadLocks));
  const atmosphereExtent = topologyVerticalExtent([
    ...positionedModules(groups.auxiliaryModules),
    ...positionedModules(groups.loadPorts),
    ...positionedRobots(atmosphereRobots),
  ]);
  const interfaceTop = interfaceExtent ? Math.max(12, interfaceExtent.top - 12) : Math.round(canvasHeight * .48);
  const interfaceBottom = interfaceExtent ? Math.min(canvasHeight - 12, interfaceExtent.bottom + 12) : interfaceTop;
  const vacuumTop = vacuumExtent ? Math.max(12, vacuumExtent.top - 24) : 12;
  const vacuumBottom = Math.max(vacuumTop + 120, interfaceTop - 12);
  const atmosphereTop = interfaceExtent ? interfaceBottom + 12 : Math.round(canvasHeight * .52);
  const atmosphereBottom = atmosphereExtent
    ? Math.min(canvasHeight - 12, atmosphereExtent.bottom + 24)
    : canvasHeight - 12;
  const machineAreaMarkup = `
    <div class="topology-zone topology-zone-vacuum" style="--zone-top:${vacuumTop}px;--zone-height:${Math.max(120, vacuumBottom - vacuumTop)}px" aria-hidden="true">
      <span><small>真空加工区</small></span>
    </div>
    ${interfaceExtent ? `<div class="topology-interface-bay" style="--zone-top:${interfaceTop}px;--zone-height:${Math.max(96, interfaceBottom - interfaceTop)}px" aria-hidden="true"><span>VACUUM / ATM INTERFACE</span></div>` : ""}
    <div class="topology-zone topology-zone-atmosphere" style="--zone-top:${atmosphereTop}px;--zone-height:${Math.max(120, atmosphereBottom - atmosphereTop)}px" aria-hidden="true">
      <span><small>大气传输区</small></span>
    </div>`;

  const renderModuleGroup = (
    modules: ModuleSnapshot[],
    role: "process" | "lock" | "port" | "auxiliary",
  ): string => modules.map(module => {
    const position = modulePositions.get(module.name);
    if (!position) return "";
    return `<div class="reference-module-position" style="--module-left:${position.leftPercent}%;--module-top:${position.topPixels}px">${renderModule(module, role, destinations.get(module.name))}</div>`;
  }).join("");
  const moduleMarkup = [
    renderModuleGroup(groups.processModules, "process"),
    renderModuleGroup(groups.loadLocks, "lock"),
    renderModuleGroup(groups.loadPorts, "port"),
    renderModuleGroup(groups.auxiliaryModules, "auxiliary"),
  ].join("");
  const renderRobotGroup = (
    robots: RobotSnapshot[],
    environment: "vacuum" | "atmosphere",
  ): string => robots.map(robot => {
    const position = robotPositions.get(robot.name);
    if (!position) return "";
    const target = robot.target || decisionTargetForRobot(robot, decision);
    const portal = robotLoadLockPortal(robot.name, target, modulePositions);
    const targetPosition = modulePositions.get(portal);
    const targetAngle = targetPosition
      ? Math.atan2(
          targetPosition.topPixels - position.topPixels,
          targetPosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
            - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH,
        )
      : -Math.PI / 2;
    let armAngle = targetAngle;
    if (robot.isPreTrans && robot.source) {
      const sourcePortal = robotLoadLockPortal(robot.name, robot.source, modulePositions);
      const sourcePosition = modulePositions.get(sourcePortal);
      if (sourcePosition) {
        const sourceAngle = Math.atan2(
          sourcePosition.topPixels - position.topPixels,
          sourcePosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
            - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH,
        );
        armAngle = interpolatedRobotAngle(sourceAngle, targetAngle, robot.preTransProgress);
      }
    }
    const angleDegrees = armAngle * 180 / Math.PI;
    return `<div class="reference-robot-position" style="--robot-left:${position.leftPercent}%;--robot-top:${position.topPixels}px">${renderRobotHub(robot, environment, angleDegrees)}</div>`;
  }).join("");
  const robotMarkup = renderRobotGroup(vacuumRobots, "vacuum")
    + renderRobotGroup(atmosphereRobots, "atmosphere");
  return `
    <section class="equipment-schematic" aria-label="完整设备拓扑回放">
      <div class="schematic-canvas reference-grid-canvas" style="--topology-canvas-height:${canvasHeight}px">
        ${machineAreaMarkup}
        ${moduleMarkup}
        ${robotMarkup}
      </div>
    </section>`;
}

/** 把可选秒数格式化为适合紧凑决策列表的文本。 */
function modelSeconds(value: number | null, sign = false): string {
  if (value === null) return "—";
  const prefix = sign && value > PERFORMANCE_DISPLAY_TOLERANCE ? "+" : "";
  return `${prefix}${value.toFixed(value >= 100 ? 0 : 1)}s`;
}

/** 避免把非零偏好四舍五入成具有误导性的 0%。 */
function modelPreference(value: number): string {
  const percent = Math.max(0, value) * 100;
  if (percent > 0 && Math.round(percent) === 0) return "<1%";
  return `${Math.round(percent)}%`;
}

/** 生成候选动作的人类可读路径标签。 */
function decisionCandidatePath(candidate: DecisionCandidate): string {
  const source = candidate.source || "当前位置";
  const destination = candidate.destination || "—";
  return `${source} → ${destination}${candidate.destinationSlot ? ` · 槽 ${candidate.destinationSlot}` : ""}`;
}

/** 生成与候选排序无关的决策空间签名，只在可行动作集合变化时改变。 */
export function decisionSpaceSignature(decision: DecisionTraceStep): string {
  const actionIds = decision.candidates
    .map(candidate => candidate.actionId)
    .filter(Boolean)
    .sort();
  return JSON.stringify([decision.candidateCount, actionIds]);
}

/** 绘制统一的 E2E 可行动作列表，推荐只是普通的候选状态。 */
function renderDecisionLens(decision: DecisionTraceStep | null): string {
  if (!decision) {
    return `
      <div class="decision-empty">
        <strong>当前时刻暂无决策</strong>
        <p>回放到下一设备事件后，Machine 会更新可行动作并触发实时评估。</p>
      </div>`;
  }
  const shownText = decision.candidatesTruncated
    ? `展示 Top ${decision.shownCandidateCount} / ${decision.candidateCount}`
    : `${decision.candidateCount} 个可行动作`;
  const rankedCandidates = [...decision.candidates].sort((left, right) =>
    right.policyPreference - left.policyPreference
      || left.rank - right.rank
      || left.actionId.localeCompare(right.actionId));
  const candidates = rankedCandidates.map((candidate, index) => {
    const preference = modelPreference(candidate.policyPreference);
    const isRecommendation = index === 0;
    const tags = `${isRecommendation ? '<span class="decision-tag is-recommendation">E2E推荐</span>' : ""}${candidate.executed ? '<span class="decision-tag is-plan">与计划一致</span>' : ""}`;
    const delta = isRecommendation
      ? "Δ 基准"
      : `Δ ${modelSeconds(candidate.makespanDelta, true)}`;
    return `
      <li class="decision-candidate">
        <div class="decision-candidate-rank" aria-label="第 ${index + 1} 名">${index + 1}</div>
        <div class="decision-candidate-main">
          <div class="decision-candidate-title"><strong>${escapeHtml(decisionCandidatePath(candidate))}</strong>${tags}</div>
          <small>${escapeHtml(candidate.robot || "Robot")} · ${escapeHtml(candidate.flowKind || candidate.kind)}</small>
          <div class="decision-candidate-detail">
            <span>剩余工期 <strong>${modelSeconds(candidate.expectedRemainingMakespan)}</strong></span>
            <span>${delta}</span>
          </div>
        </div>
        <strong class="decision-candidate-preference" aria-label="E2E 偏好 ${preference}">${preference}</strong>
      </li>`;
  }).join("");
  return `
    <div class="decision-lens-head">
      <strong>决策 #${decision.decisionIndex}</strong>
      <span>${escapeHtml(shownText)}</span>
    </div>
    <section class="decision-candidate-section" aria-labelledby="decisionCandidatesTitle">
      <header><strong id="decisionCandidatesTitle">可行动作</strong><span>按 E2E 偏好排序</span></header>
      ${candidates ? `<ol>${candidates}</ol>` : '<p class="decision-alternative-empty">当前没有可行动作</p>'}
    </section>
    <p class="decision-method-note">Δ 为相对 E2E 推荐动作的预测工期差值。</p>`;
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
  private replayPlan: Record<string, any> | null = null;
  private liveDecision: DecisionTraceStep | null = null;
  private liveDecisionKey = "";
  private lastDecisionSpaceSignature: string | null = null;
  private pauseOnDecisionChange = false;
  private pauseTriggeredByDecisionChange = false;
  private readonly replayDecisionCache = new Map<string, DecisionTraceStep>();
  private readonly pendingReplayDecisionKeys = new Set<string>();
  private replayDecisionRequestVersion = 0;
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
  /** 画布下方模块筛选：勾选的模块类别（aligner/cooler）不在拓扑中显示。 */
  private readonly hiddenModuleFilters = new Set<string>();

  /** 绑定页面事件并初始化空状态。 */
  constructor(root: Document) {
    this.root = root;
    this.elements = collectElements(root);
    this.syncModuleFiltersFromUi();
    this.bindEvents();
    this.updatePlayButton();
    this.updatePauseOnDecisionChangeButton();
    this.setTopologyVisible(false);
  }

  /** 以画布下方筛选框的勾选状态初始化模块筛选集合。 */
  private syncModuleFiltersFromUi(): void {
    if (this.elements.alignerFilter.checked) this.hiddenModuleFilters.add("aligner");
    if (this.elements.coolerFilter.checked) this.hiddenModuleFilters.add("cooler");
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
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const replayContext = (payload as UnknownRecord).ReplayContext;
        if (replayContext && typeof replayContext === "object" && !Array.isArray(replayContext)) {
          const embeddedPlan = (replayContext as UnknownRecord).plan;
          if (embeddedPlan && typeof embeddedPlan === "object" && !Array.isArray(embeddedPlan)) {
            this.setReplayPlan(embeddedPlan as Record<string, any>);
          }
        }
      }
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

  /** 保存 Machine 回放所需的完整计划；任意来源 MoveList 都使用该计划实时评分。 */
  setReplayPlan(plan: Record<string, any> | null): void {
    this.replayPlan = plan ? structuredClone(plan) : null;
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.lastDecisionSpaceSignature = null;
    this.replayDecisionRequestVersion += 1;
    if (this.moves.length) this.render();
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
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.lastDecisionSpaceSignature = null;
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionRequestVersion += 1;
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
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.lastDecisionSpaceSignature = null;
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionRequestVersion += 1;
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
    this.elements.importButton?.addEventListener("click", () => this.elements.fileInput.click());
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
    this.elements.pauseOnDecisionChangeButton.addEventListener("click", () => {
      this.pauseOnDecisionChange = !this.pauseOnDecisionChange;
      this.pauseTriggeredByDecisionChange = false;
      this.updatePauseOnDecisionChangeButton();
    });
    this.elements.speed.addEventListener("change", () => {
      this.playbackSpeed = Math.max(0.25, finiteNumber(this.elements.speed.value, DEFAULT_PLAYBACK_SPEED));
    });
    this.elements.alignerFilter.addEventListener("change", () => {
      this.setModuleFilter("aligner", this.elements.alignerFilter.checked);
    });
    this.elements.coolerFilter.addEventListener("change", () => {
      this.setModuleFilter("cooler", this.elements.coolerFilter.checked);
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
    this.pauseTriggeredByDecisionChange = false;
    this.previousFrameTime = performance.now();
    this.previousRenderTime = 0;
    this.updatePlayButton();
    this.animationFrame = requestAnimationFrame(timestamp => this.tick(timestamp));
  }

  /** 暂停回放并保留当前时间。 */
  private pause(triggeredByDecisionChange = false): void {
    this.playing = false;
    this.pauseTriggeredByDecisionChange = triggeredByDecisionChange;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.updatePlayButton();
    this.updatePauseOnDecisionChangeButton();
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
    if (!this.playing) return;
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

  /** 同步决策空间自动暂停按钮的开关、触发状态和无障碍文本。 */
  private updatePauseOnDecisionChangeButton(): void {
    const state = this.pauseTriggeredByDecisionChange
      ? "已暂停"
      : this.pauseOnDecisionChange ? "已开启" : "已关闭";
    this.elements.pauseOnDecisionChangeButton.innerHTML = `
      <span class="decision-switch-copy"><span>决策变化时暂停</span><strong>${state}</strong></span>
      <span class="decision-switch-track" aria-hidden="true"><i></i></span>`;
    this.elements.pauseOnDecisionChangeButton.setAttribute("aria-pressed", String(this.pauseOnDecisionChange));
    this.elements.pauseOnDecisionChangeButton.setAttribute("aria-checked", String(this.pauseOnDecisionChange));
    this.elements.pauseOnDecisionChangeButton.setAttribute(
      "aria-label",
      this.pauseTriggeredByDecisionChange
        ? "决策空间已变化，回放已暂停"
        : `决策空间变化时自动暂停：${this.pauseOnDecisionChange ? "已开启" : "已关闭"}`,
    );
    this.elements.pauseOnDecisionChangeButton.classList.toggle("is-active", this.pauseOnDecisionChange);
    this.elements.pauseOnDecisionChangeButton.classList.toggle("is-triggered", this.pauseTriggeredByDecisionChange);
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

  /** 切换画布模块筛选；有 MoveList 时立即按新筛选重绘拓扑。 */
  private setModuleFilter(key: string, hidden: boolean): void {
    if (hidden) this.hiddenModuleFilters.add(key);
    else this.hiddenModuleFilters.delete(key);
    if (this.moves.length) this.render();
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

    const replayTime = this.replayEventTime(snapshot.time);
    const replayKey = this.replayStateKey(snapshot, replayTime);
    const cachedDecision = this.replayDecisionCache.get(replayKey) ?? null;
    if (cachedDecision) {
      this.liveDecision = cachedDecision;
      this.liveDecisionKey = replayKey;
    }
    const currentDecision = cachedDecision
      ?? (this.liveDecisionKey === replayKey ? this.liveDecision : null)
      ?? decisionAtTime(this.decisionTrace, snapshot.time);
    const decisionSpaceReady = Boolean(
      cachedDecision
      || (this.liveDecisionKey === replayKey && this.liveDecision)
      || !this.replayPlan,
    );
    if (
      this.replayPlan
      && !cachedDecision
      && this.liveDecisionKey !== replayKey
      && !this.pendingReplayDecisionKeys.has(replayKey)
    ) {
      void this.refreshReplayDecision(replayKey, replayTime);
    }
    const topologySnapshot = snapshotWithFullDeviceModules(
      snapshotWithCandidateModules(snapshot, currentDecision, this.device),
      this.device,
    );
    this.observeDecisionSpace(currentDecision, decisionSpaceReady);
    this.elements.stage.innerHTML = renderEquipmentTopology(topologySnapshot, currentDecision, this.hiddenModuleFilters);
    this.elements.decisionLens.innerHTML = renderDecisionLens(currentDecision);

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

  /** 观察候选动作集合；初次结果只建立基线，后续变化才触发暂停。 */
  private observeDecisionSpace(decision: DecisionTraceStep | null, ready: boolean): void {
    if (!decision || !ready) return;
    const nextSignature = decisionSpaceSignature(decision);
    const changed = this.lastDecisionSpaceSignature !== null
      && this.lastDecisionSpaceSignature !== nextSignature;
    this.lastDecisionSpaceSignature = nextSignature;
    if (changed && this.pauseOnDecisionChange && this.playing) {
      this.pause(true);
    }
  }

  /** 返回不晚于当前时刻的最近 Move 开始/结束边界，供 Machine 读取稳定切片。 */
  private replayEventTime(time: number): number {
    let eventTime = 0;
    for (const move of this.moves) {
      const startTime = finiteNumber(move.StartTime);
      const endTime = finiteNumber(move.EndTime);
      if (startTime <= time + PERFORMANCE_DISPLAY_TOLERANCE) eventTime = Math.max(eventTime, startTime);
      if (endTime <= time + PERFORMANCE_DISPLAY_TOLERANCE) eventTime = Math.max(eventTime, endTime);
    }
    return eventTime;
  }

  /** 生成只在设备事件变化时更新的评估键，避免动画帧重复执行 E2E 前向。 */
  private replayStateKey(snapshot: WorkspaceSnapshot, replayTime: number): string {
    const activeMoveIds = snapshot.activeMoves
      .map(move => finiteNumber(move.MoveID))
      .sort((left, right) => left - right)
      .join(",");
    return `${replayTime.toFixed(6)}:${snapshot.completedMoves}:${activeMoveIds}`;
  }

  /** 异步请求当前 Machine 候选；过期响应不会覆盖用户已经拖到的新时刻。 */
  private async refreshReplayDecision(replayKey: string, replayTime: number): Promise<void> {
    const requestVersion = ++this.replayDecisionRequestVersion;
    this.pendingReplayDecisionKeys.add(replayKey);
    try {
      const rawDecision = await requestReplayDecision({
        resultId: this.analysisResultId || undefined,
        moves: this.analysisResultId ? undefined : this.moves,
        plan: this.replayPlan,
        time: replayTime,
      });
      const decision = normalizeDecisionTrace({ DecisionTrace: [rawDecision] })[0] ?? null;
      if (requestVersion !== this.replayDecisionRequestVersion || !decision) return;
      this.replayDecisionCache.set(replayKey, decision);
      const currentSnapshot = buildWorkspaceSnapshot(this.moves, this.device, this.time);
      const currentReplayTime = this.replayEventTime(this.time);
      if (this.replayStateKey(currentSnapshot, currentReplayTime) !== replayKey) return;
      this.liveDecision = decision;
      this.liveDecisionKey = replayKey;
      this.render();
    } catch (_error) {
      // 静态 DecisionTrace 仍作为旧结果和缺少完整配置的导入文件的只读兜底。
    } finally {
      this.pendingReplayDecisionKeys.delete(replayKey);
    }
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
