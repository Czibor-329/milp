/**
 * MoveList 结果展示与回放页面。
 *
 * 本模块负责把调度输出回放成设备、机器人、晶圆和腔室门的可观察状态，并管理
 * 时间轴、播放控制、结果加载和本地文件导入。性能指标通过服务端 API 获取；
 * 本文件不实现分析规则，也不持久化业务数据。
 */

import {
  requestDeadlockDiagnostic,
  requestReplayDecision,
  requestScheduleAnalysis,
} from "./api_client";
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
  ThroughputTimelinePoint,
  WaferResidenceTime,
} from "./analysis_contracts";

type UnknownRecord = Record<string, unknown>;

export type DoorStatus = "closed" | "opening" | "open" | "closing" | "doorless";
export type ModuleStatus = "idle" | "occupied" | "door" | "transfer" | "processing" | "cleaning" | "environment";
type RobotEnvironment = "vacuum" | "atmosphere";
export type TopologyLayout = "single" | "dual" | "cascade";

export interface ModuleSnapshot {
  name: string;
  type: string;
  status: ModuleStatus;
  door: DoorStatus;
  wafers: string[];
  processedWafers: string[];
  loadPortSlots: LoadPortSlotSnapshot[];
  loadLockSlots: LoadPortSlotSnapshot[];
  /** 设备声明的物理槽位容量；辅助设备用它绘制固定前视槽位。 */
  slotCapacity: number;
  activeMoveName: string;
  progress: number;
  environment: string;
  loadLockPhase: "" | "pumping" | "venting";
  isRobotTarget: boolean;
}

export interface RobotSnapshot {
  name: string;
  type: string;
  capacity: number;
  environment: RobotEnvironment;
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
  /** 晶圆在本次 MoveList 中首次确认的来源模块和槽位，如 LP1.1。 */
  waferOrigins: Record<string, string>;
  waferCount: number;
}

export interface PlaybackDeadlock {
  Code:
    | "DEADLOCK.SINGLE_ARM_TARGET_FULL"
    | "DEADLOCK.DUAL_ARM_SINGLE_HELD_TARGET_FULL"
    | "DEADLOCK.DUAL_ARM_TARGETS_FULL";
  Category:
    | "single-arm-target-full"
    | "dual-arm-single-held-target-full"
    | "dual-arm-targets-full";
  Message: string;
}

export interface LoadPortSlotSnapshot {
  slot: number;
  wafer: string;
  processed: boolean;
}

interface LoadPortReplenishment {
  time: number;
  moduleName: string;
  materials: Array<{ wafer: string; slot: number; taskId: string }>;
}

/** 旧结果文件中的模型候选，仅用于忽略历史 DecisionTrace 时保持解析兼容。 */
export interface DecisionCandidate {
  actionId: string;
  actor: string;
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
  priorityDeferred: boolean;
  policyScore: number;
  policyPreference: number;
  expectedRemainingMakespan: number | null;
  expectedRemainingCost: number | null;
  medianRemainingMakespan: number | null;
  lowerRemainingMakespan: number | null;
  upperRemainingMakespan: number | null;
  makespanDelta: number | null;
}

export interface DecisionCandidateGroup {
  actor: string;
  label: string;
  selectedActionId: string;
  executedActionId: string;
  candidateCount: number;
  shownCandidateCount: number;
  candidatesTruncated: boolean;
  candidates: DecisionCandidate[];
}

type ActionDiagnosticStatus = "enabled" | "physical-blocked" | "deadlock-blocked";
const ALL_ACTION_DIAGNOSTIC_STATUSES: ActionDiagnosticStatus[] = [
  "enabled",
  "physical-blocked",
  "deadlock-blocked",
];

export interface ReplayActionDiagnostic {
  actionId: string;
  kind: "pick" | "place" | "swap";
  status: ActionDiagnosticStatus;
  reason: string;
  actor: string;
  robot: string;
  materialIds: string[];
  source: string;
  sourceSlot: number;
  destination: string;
  destinationSlot: number;
  duplicateCount: number;
  earliestStart: number;
  finishTime: number;
}

type RecommendationModel = "actions" | "e2e-ctq" | "dual-actor-e2e";

export interface DecisionTraceStep {
  model: RecommendationModel;
  modelLabel: string;
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
  candidateGroups: DecisionCandidateGroup[];
  actionDiagnosticsSource: string;
  actionDiagnosticsProvider: string;
  actionCounts: Record<ActionDiagnosticStatus, number>;
  actionDiagnostics: ReplayActionDiagnostic[];
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
  frontSlotOverview: HTMLElement;
  decisionLens: HTMLElement;
  actionStatusFilters: HTMLInputElement[];
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
  exportDiagnosticButton: HTMLButtonElement | null;
  openGantt: HTMLAnchorElement;
  resultButton: HTMLButtonElement;
  performance: HTMLElement;
  performanceWindow: HTMLSelectElement;
}

const PICK_MOVE_TYPES = new Set([0, 2]);
const PLACE_MOVE_TYPES = new Set([1, 3]);
const SWAP_MOVE = 4;
const DECISION_COMPLETION_MOVE_TYPES = new Set([...PLACE_MOVE_TYPES, SWAP_MOVE]);
const PRIMITIVE_DECISION_COMPLETION_MOVE_TYPES = new Set([
  ...PICK_MOVE_TYPES,
  ...PLACE_MOVE_TYPES,
  SWAP_MOVE,
]);
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

/** 把旧结果中的可选数值规范为有限数字；缺失或非有限值统一返回 null。 */
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

/** 规范旧结果文件中的候选字段；当前动作状态卡片不会展示这些字段。 */
function normalizeDecisionCandidate(
  candidate: UnknownRecord,
  actor = "",
): DecisionCandidate {
  return {
    actionId: String(candidate.actionId ?? ""),
    actor: String(candidate.actor ?? actor),
    kind: String(candidate.kind ?? ""),
    flowKind: String(candidate.flowKind ?? candidate.kind ?? ""),
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
    priorityDeferred: Boolean(candidate.priorityDeferred),
    policyScore: finiteNumber(candidate.policyScore),
    policyPreference: Math.max(0, Math.min(1, finiteNumber(candidate.policyPreference))),
    expectedRemainingMakespan: nullableFiniteNumber(candidate.expectedRemainingMakespan),
    expectedRemainingCost: nullableFiniteNumber(candidate.expectedRemainingCost),
    medianRemainingMakespan: nullableFiniteNumber(candidate.medianRemainingMakespan),
    lowerRemainingMakespan: nullableFiniteNumber(candidate.lowerRemainingMakespan),
    upperRemainingMakespan: nullableFiniteNumber(candidate.upperRemainingMakespan),
    makespanDelta: nullableFiniteNumber(candidate.makespanDelta),
  };
}

/** 规范算法接口返回的 Pick、Place、Swap 动作诊断。 */
function normalizeReplayActionDiagnostic(value: UnknownRecord): ReplayActionDiagnostic | null {
  const kind = String(value.kind ?? "").toLowerCase();
  const status = String(value.status ?? "").toLowerCase();
  if (!["pick", "place", "swap"].includes(kind)) return null;
  if (!["enabled", "physical-blocked", "deadlock-blocked"].includes(status)) return null;
  return {
    actionId: String(value.actionId ?? ""),
    kind: kind as ReplayActionDiagnostic["kind"],
    status: status as ActionDiagnosticStatus,
    reason: String(value.reason ?? ""),
    actor: String(value.actor ?? ""),
    robot: String(value.robot ?? ""),
    materialIds: listValue(value.materialIds).map(String),
    source: String(value.source ?? ""),
    sourceSlot: finiteNumber(value.sourceSlot),
    destination: String(value.destination ?? ""),
    destinationSlot: finiteNumber(value.destinationSlot),
    duplicateCount: Math.max(0, Math.round(finiteNumber(value.duplicateCount))),
    earliestStart: finiteNumber(value.earliestStart),
    finishTime: finiteNumber(value.finishTime),
  };
}

/** 从运行结果中提取 E2E 联合推荐或双 Actor 分域原子推荐。 */
export function normalizeDecisionTrace(payload: unknown): DecisionTraceStep[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as UnknownRecord;
  const rawTrace = record.DecisionTrace;
  if (!Array.isArray(rawTrace)) return [];
  const traceMeta = record.DecisionTraceMeta;
  const meta = traceMeta && typeof traceMeta === "object" && !Array.isArray(traceMeta)
    ? traceMeta as UnknownRecord
    : {};
  return rawTrace
    .filter((step): step is UnknownRecord => Boolean(step) && typeof step === "object" && !Array.isArray(step))
    .map((step): DecisionTraceStep => {
      const modelSignature = `${String(step.model ?? "")} ${String(meta.schema ?? "")} ${String(meta.model ?? "")}`.toLowerCase();
      const model: RecommendationModel = modelSignature.includes("actions")
        ? "actions"
        : modelSignature.includes("dual-actor") || modelSignature.includes("双 actor")
          ? "dual-actor-e2e"
          : "e2e-ctq";
      const rawCandidates = Array.isArray(step.candidates)
        ? step.candidates
        : model === "dual-actor-e2e" && Array.isArray(step.proposals)
          ? step.proposals
          : [];
      let candidates = rawCandidates
        .filter((candidate): candidate is UnknownRecord => (
          Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
        ))
        .map(candidate => normalizeDecisionCandidate(candidate))
        .sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference);
      const rawGroups = Array.isArray(step.candidateGroups) ? step.candidateGroups : [];
      let candidateGroups = rawGroups
        .filter((group): group is UnknownRecord => Boolean(group) && typeof group === "object" && !Array.isArray(group))
        .map((group): DecisionCandidateGroup => {
          const actor = String(group.actor ?? "");
          const groupCandidates = listValue(group.candidates)
            .filter((candidate): candidate is UnknownRecord => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate))
            .map(candidate => normalizeDecisionCandidate(candidate, actor))
            .sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference)
            .map((candidate, index, rows) => ({
              ...candidate,
              rank: candidate.rank || index + 1,
              policyPreference: rows.length === 1 && candidate.policyPreference === 0 ? 1 : candidate.policyPreference,
            }));
          return {
            actor,
            label: String(group.label ?? (actor === "atmosphere" ? "大气端 Actor" : "真空端 Actor")),
            selectedActionId: String(group.selectedActionId ?? ""),
            executedActionId: String(group.executedActionId ?? ""),
            candidateCount: Math.max(groupCandidates.length, finiteNumber(group.candidateCount, groupCandidates.length)),
            shownCandidateCount: Math.max(groupCandidates.length, finiteNumber(group.shownCandidateCount, groupCandidates.length)),
            candidatesTruncated: Boolean(group.candidatesTruncated),
            candidates: groupCandidates,
          };
        });
      if (model === "dual-actor-e2e" && !candidateGroups.length && candidates.length) {
        candidateGroups = ["atmosphere", "vacuum"].map(actor => {
          const groupCandidates = candidates
            .filter(candidate => candidate.actor === actor)
            .map((candidate, index, rows) => ({
              ...candidate,
              rank: candidate.rank || index + 1,
              policyPreference: rows.length === 1 && candidate.policyPreference === 0 ? 1 : candidate.policyPreference,
            }));
          return {
            actor,
            label: actor === "atmosphere" ? "大气端 Actor" : "真空端 Actor",
            selectedActionId: groupCandidates.find(candidate => candidate.selected)?.actionId ?? "",
            executedActionId: groupCandidates.find(candidate => candidate.executed)?.actionId ?? "",
            candidateCount: groupCandidates.length,
            shownCandidateCount: groupCandidates.length,
            candidatesTruncated: false,
            candidates: groupCandidates,
          };
        }).filter(group => group.candidates.length);
      }
      if (candidateGroups.length) candidates = candidateGroups.flatMap(group => group.candidates);
      const actionDiagnostics = listValue(step.actionDiagnostics)
        .filter((action): action is UnknownRecord => Boolean(action) && typeof action === "object" && !Array.isArray(action))
        .map(normalizeReplayActionDiagnostic)
        .filter((action): action is ReplayActionDiagnostic => Boolean(action));
      const rawActionCounts = step.actionCounts && typeof step.actionCounts === "object"
        ? step.actionCounts as UnknownRecord
        : {};
      return {
        model,
        modelLabel: String(step.modelLabel ?? (model === "dual-actor-e2e" ? "双 Actor 原子调度" : "E2E-CTQ")),
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
        candidateGroups,
        actionDiagnosticsSource: String(step.actionDiagnosticsSource ?? ""),
        actionDiagnosticsProvider: String(step.actionDiagnosticsProvider ?? ""),
        actionCounts: {
          enabled: finiteNumber(rawActionCounts.enabled),
          "physical-blocked": finiteNumber(rawActionCounts["physical-blocked"]),
          "deadlock-blocked": finiteNumber(rawActionCounts["deadlock-blocked"]),
        },
        actionDiagnostics,
      };
    })
    .sort((left, right) => left.time - right.time || left.decisionIndex - right.decisionIndex);
}

/** 返回 MoveList 核心机器人动作对应的双 Actor 原子类型。 */
function primitiveMoveKind(move: MoveRecord): "pick" | "place" | "swap" | "" {
  const moveType = finiteNumber(move.MoveType, -1);
  if (PICK_MOVE_TYPES.has(moveType)) return "pick";
  if (PLACE_MOVE_TYPES.has(moveType)) return "place";
  if (moveType === SWAP_MOVE) return "swap";
  return "";
}

function moveStringList(move: MoveRecord, field: string): string[] {
  return listValue(move[field]).map(String);
}

/** 判断原始模型选中的原子动作是否对应最终定时 MoveList 中的一条物理动作。 */
function candidateMatchesPrimitiveMove(
  candidate: DecisionCandidate,
  move: MoveRecord,
): boolean {
  if (candidate.kind !== primitiveMoveKind(move)) return false;
  const robot = String(move.Robot ?? move.ModuleName ?? "");
  if (candidate.robot && candidate.robot !== robot) return false;
  const moveMaterials = moveStringList(move, "MatIDList");
  if (candidate.kind === "swap") {
    const exchangedMaterials = new Set([
      ...moveMaterials,
      ...moveStringList(move, "SentMatList"),
      ...moveStringList(move, "RecvMatList"),
    ]);
    if (!candidate.materialIds.every(material => exchangedMaterials.has(material))) {
      return false;
    }
    const stations = moveStringList(move, "StationList");
    return !candidate.destination || stations.includes(candidate.destination);
  }
  if (candidate.materialIds[0] && candidate.materialIds[0] !== moveMaterials[0]) return false;
  if (candidate.kind === "pick") {
    const sources = moveStringList(move, "SrcStationList");
    return !candidate.source || sources.includes(candidate.source);
  }
  const destinations = moveStringList(move, "DestStationList");
  return !candidate.destination || destinations.includes(candidate.destination);
}

/**
 * 把调度时保存的双 Actor 决策映射到最终 timing MoveList 的物理开始时刻。
 *
 * 原始 trace 的逻辑状态时间通常都为轮次起点；回放若直接按该字段选择，会把
 * 事后重评估误当成原始模型选择。每个已选原子动作与最终 Pick/Place/Swap
 * 一一对应，因此以 Robot、物料、端点和动作类型做稳定匹配。
 */
export function alignOriginalDecisionTraceToMoves(
  trace: DecisionTraceStep[],
  moves: MoveRecord[],
): DecisionTraceStep[] {
  const primitiveMoves = moves
    .filter(move => Boolean(primitiveMoveKind(move)))
    .sort((left, right) => finiteNumber(left.StartTime) - finiteNumber(right.StartTime)
      || finiteNumber(left.MoveID) - finiteNumber(right.MoveID));
  const usedMoveIds = new Set<number>();
  const aligned = trace.map(step => {
    if (step.model !== "dual-actor-e2e") return step;
    const selectedCandidate = step.candidates.find(candidate => (
      candidate.actionId === step.selectedActionId || candidate.selected
    ));
    if (!selectedCandidate) return step;
    const matchedMove = primitiveMoves.find(move => {
      const moveId = finiteNumber(move.MoveID, -1);
      return !usedMoveIds.has(moveId)
        && candidateMatchesPrimitiveMove(selectedCandidate, move);
    });
    if (!matchedMove) return step;
    usedMoveIds.add(finiteNumber(matchedMove.MoveID, -1));
    const executedActionId = selectedCandidate.actionId;
    const candidateGroups = step.candidateGroups.map(group => {
      const containsExecuted = group.candidates.some(candidate => (
        candidate.actionId === executedActionId
      ));
      return {
        ...group,
        executedActionId: containsExecuted ? executedActionId : group.executedActionId,
        candidates: group.candidates.map(candidate => ({
          ...candidate,
          executed: candidate.actionId === executedActionId,
        })),
      };
    });
    const candidates = candidateGroups.length
      ? candidateGroups.flatMap(group => group.candidates)
      : step.candidates.map(candidate => ({
          ...candidate,
          executed: candidate.actionId === executedActionId,
        }));
    return {
      ...step,
      time: finiteNumber(matchedMove.StartTime),
      executedActionId,
      modelEvaluated: true,
      replayEvaluated: false,
      candidates,
      candidateGroups,
    };
  });
  return aligned.sort((left, right) => left.time - right.time
    || left.decisionIndex - right.decisionIndex);
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

/**
 * 从结果内嵌的各代 AlgSchedule 快照提取 LoadPort 补片边界。
 *
 * 补片发生在重算时刻，不等到新一盒首片真正开始 Pick。后续 MoveList 只能证明
 * 新盒存在，无法单独还原它何时装入，因此回放必须使用 ReplayContext.updates 的
 * CurrentTime 与新增 TaskID。
 */
export function normalizeLoadPortReplenishments(payload: unknown): LoadPortReplenishment[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const replayContext = (payload as UnknownRecord).ReplayContext;
  if (!replayContext || typeof replayContext !== "object" || Array.isArray(replayContext)) return [];
  const updates = listValue((replayContext as UnknownRecord).updates)
    .filter((update): update is UnknownRecord => Boolean(update) && typeof update === "object" && !Array.isArray(update))
    .sort((left, right) => finiteNumber(left.CurrentTime) - finiteNumber(right.CurrentTime));
  const knownTaskIdsByPort = new Map<string, Set<string>>();
  const replenishments: LoadPortReplenishment[] = [];

  updates.forEach((update, updateIndex) => {
    const materials = listValue(update.Materials)
      .filter((material): material is UnknownRecord => Boolean(material) && typeof material === "object" && !Array.isArray(material));
    const currentByPortAndTask = new Map<string, Map<string, Array<{ wafer: string; slot: number; taskId: string }>>>();
    for (const material of materials) {
      const port = String(material.SrcPortName ?? "").trim();
      const currentModule = String(material.CurrentModuleName ?? "").trim();
      const taskId = String(material.TaskID ?? "").trim();
      const wafer = String(material.ID ?? material.Name ?? "").trim();
      const slot = Math.trunc(finiteNumber(material.SlotID));
      if (!port || currentModule !== port || !taskId || !wafer || slot < 1) continue;
      const byTask = currentByPortAndTask.get(port) ?? new Map<string, Array<{ wafer: string; slot: number; taskId: string }>>();
      const taskMaterials = byTask.get(taskId) ?? [];
      taskMaterials.push({ wafer, slot, taskId });
      byTask.set(taskId, taskMaterials);
      currentByPortAndTask.set(port, byTask);
    }

    for (const [port, byTask] of currentByPortAndTask) {
      const knownTaskIds = knownTaskIdsByPort.get(port) ?? new Set<string>();
      for (const [taskId, taskMaterials] of byTask) {
        if (updateIndex > 0 && !knownTaskIds.has(taskId)) {
          replenishments.push({
            time: finiteNumber(update.CurrentTime),
            moduleName: port,
            materials: taskMaterials.sort((left, right) => left.slot - right.slot),
          });
        }
        knownTaskIds.add(taskId);
      }
      knownTaskIdsByPort.set(port, knownTaskIds);
    }
  });
  return replenishments;
}

/**
 * 返回回放中一片晶圆的批次内身份。
 *
 * CJobCycle 补片会在后续计划代次重新从 1 分配 MatID，因此 MatID 本身不能作为
 * 全程唯一键。PJobName 随该批产品传递，可将同号的不同补片批次区分开；旧版
 * MoveList 缺少 PJobName 时退回 MatID，维持兼容。
 */
function materialInstanceId(move: MoveRecord, material: string, index: number): string {
  const taskIds = listValue(move.TaskID).map(String).filter(Boolean);
  const taskId = taskIds[index] ?? taskIds[0] ?? "";
  if (taskId) return `${material}\u0000${taskId}`;
  const processJobs = listValue(move.PJobName).map(String).filter(Boolean);
  const processJob = processJobs[index] ?? processJobs[0] ?? "";
  return processJob ? `${material}\u0000${processJob}` : material;
}

/**
 * 判断算法是否以 ProcessMove 形式记录清洁。
 *
 * 部分算法包不会输出 MoveType=14，而是用没有产品晶圆的 ProcessMove 或附带
 * 清洁配方元数据的 ProcessMove 表达清洁。回放需把两种协议形态统一成清洁状态。
 */
function isCleaningMove(move: MoveRecord): boolean {
  if (move.MoveType === CLEAN_MOVE) return true;
  if (move.MoveType !== PROCESS_MOVE) return false;
  const materialList = move.MatIDList;
  const explicitlyEmpty = Array.isArray(materialList) && materialList.length === 0;
  const cleanMetadata = [move.CleanRecipe, move.CleanTaskName, move.RecipeName, move.ProcessRecipe]
    .some(value => /clean|wac|dummy/i.test(String(value ?? "")));
  return explicitlyEmpty || cleanMetadata;
}

/** 返回动作引用的第一个站点。 */
function firstStation(move: MoveRecord, field: string): string {
  return String(listValue(move[field])[0] ?? "");
}

/** 判断名称是否代表机器人；配置中的精确名称优先于历史前缀兼容规则。 */
function isRobotName(name: string, configuredRobotNames?: ReadonlySet<string>): boolean {
  return Boolean(configuredRobotNames?.has(name)) || /^(ATR|VTR|ATM|VTM|VAC|TM\d*|ROBOT)/i.test(name);
}

/** 根据 init 中的 Type 和名称确定机器手所在的气体环境。 */
function robotEnvironment(name: string, definition: UnknownRecord = {}): RobotEnvironment {
  const type = String(definition.Type ?? "");
  if (/ATM|ATR|大气/i.test(type) || /^(ATR|ATM)/i.test(name)) return "atmosphere";
  return "vacuum";
}

/** 从 init 的 Capacity/ArmInfo 读取机器手可持片数，并兼容旧设备定义。 */
function robotCapacity(definition: UnknownRecord, holdingCount = 0): number {
  const declaredCapacity = finiteNumber(definition.Capacity, 0);
  const armSlotCount = Object.values(definition.ArmInfo ?? {}).reduce((maximum, arm) => {
    if (!arm || typeof arm !== "object") return maximum;
    return Math.max(maximum, listValue((arm as UnknownRecord).SlotIDs).length);
  }, 0);
  return Math.max(1, declaredCapacity, armSlotCount, holdingCount);
}

/** 判断名称是否代表参考拓扑中的 Dummy Port，而不是正常装载端口。 */
function isDummyPortName(name: string): boolean {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}

/**
 * 拆分 ``DummyPort.3`` / ``LP1.1`` 这类来源标识。
 *
 * 最后一个点号后的片段视为槽位；没有槽位时只返回模块名。
 */
function splitWaferOrigin(origin: string): { moduleName: string; slotLabel: string } {
  const trimmed = origin.trim();
  const separator = trimmed.lastIndexOf(".");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return { moduleName: trimmed, slotLabel: "" };
  }
  return {
    moduleName: trimmed.slice(0, separator),
    slotLabel: trimmed.slice(separator + 1),
  };
}

/** 根据首次来源判断晶圆是否来自 Dummy Port。 */
function isDummyWaferOrigin(origin: string): boolean {
  const { moduleName } = splitWaferOrigin(origin);
  return Boolean(moduleName) && isDummyPortName(moduleName);
}

/** 与计划构建一致：Dummy 物料 ID 从 100000 起编号。 */
const DUMMY_MATERIAL_ID_START = 100000;

/** 根据首次来源或物料编号判断是否是 Dummy 晶圆。 */
function isDummyWafer(wafer: string, origin: string): boolean {
  if (isDummyWaferOrigin(origin)) return true;
  const materialId = Number(wafer);
  return Number.isInteger(materialId) && materialId >= DUMMY_MATERIAL_ID_START;
}

/**
 * 晶圆表面展示文案：生产片保留 ``LP1.1``，Dummy 显示原始物料 ID，避免 ``DummyPort.xx``。
 */
function waferSurfaceLabel(wafer: string, origin: string): string {
  if (isDummyWafer(wafer, origin) && wafer) return wafer;
  if (!origin) return "来源未知";
  return origin;
}

/** 判断站点是否是大气侧的简易缓存。 */
function isBufferModule(name: string, type = ""): boolean {
  return type.trim().toLowerCase() === "buffer" || /^BUF(?:FER)?(?:[_-]?\w+)?$/i.test(name.trim());
}

/** 判断站点是否是大气侧冷却盘。 */
function isCoolerModule(name: string, type = ""): boolean {
  return type.trim().toLowerCase() === "cooler" || /^(CL|COOL(?:ER)?)$/i.test(name.trim());
}

/** 判断站点是否是标准晶圆对准器。 */
function isAlignerModule(name: string, type = ""): boolean {
  return type.trim().toLowerCase() === "aligner" || /^(AL|ALIGNER)$/i.test(name.trim());
}

/** 判断站点是否是真空框架顶部的加热腔；它在拓扑中沿用 PM 的腔室外观。 */
function isHeaterModule(name: string, type = ""): boolean {
  return type.trim().toLowerCase() === "heater" || /^HEATER$/i.test(name.trim());
}

/** 画布隐藏不参与当前回放拓扑的站点；Buffer 与 LP4 暂不进入新布局。 */
function isTopologyHiddenModule(module: ModuleSnapshot): boolean {
  const name = module.name.trim();
  const type = module.type.trim().toLowerCase();
  return isBufferModule(name, type)
    || /^LP4$/i.test(name);
}

/** 判断名称是否代表装载端口。 */
function isLoadPortName(name: string, type = ""): boolean {
  const normalizedType = type.trim().toLowerCase();
  return normalizedType === "loadport"
    || normalizedType === "dummyport"
    || isDummyPortName(name)
    || /^(LP\d*|P\d+|.*PORT)$/i.test(name);
}

/** 判断名称是否代表 LoadLock 或真空缓冲腔。 */
function isLoadLockName(name: string, type = ""): boolean {
  return !isBufferModule(name, type)
    && (type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name));
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
  return isCoolerModule(name, type) || isBufferModule(name, type);
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
  configuredRobotNames: ReadonlySet<string> = new Set(),
): Map<string, { type: string }> {
  const modules = new Map<string, { type: string }>();
  const stationDefinitions = device?.Stations ?? {};
  const hasConfiguredStations = Object.keys(stationDefinitions).length > 0;
  for (const move of moves) {
    const candidates = [
      move.ModuleName,
      ...listValue(move.SrcStationList),
      ...listValue(move.DestStationList),
      ...listValue(move.StationList),
    ].map(String).filter(Boolean);
    for (const name of candidates) {
      if (hasConfiguredStations && !stationDefinitions[name]) continue;
      if (!isRobotName(name, configuredRobotNames) && !modules.has(name)) {
        modules.set(name, { type: String(stationDefinitions[name]?.Type ?? "") });
      }
    }
  }
  return modules;
}

/** 收集设备定义和 MoveList 中出现过的机器人。 */
function collectRobotNames(moves: NormalizedMove[], device: DeviceDefinition | null): string[] {
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  const names = new Set(configuredRobotNames);
  for (const move of moves) {
    if (isRobotName(move.ModuleName, configuredRobotNames)) names.add(move.ModuleName);
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
      // RecvMatList 是交换前停在站上的旧片（被机器人收回），SendMatList
      // 是机器人原持片（送入站），因此初始位置与站/机器人方向相反。
      for (const material of materialIds(move, "RecvMatList")) {
        if (!locations.has(material)) locations.set(material, station);
      }
      for (const material of materialIds(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, move.ModuleName);
      }
      continue;
    }
    // PreTrans 的 SrcStationList 表示机器手指向，不是晶圆所在站点。
    // 初始位置只能由实际取放或加工动作确认，否则带片 PreTrans
    // 会让后续死锁回放误以为晶圆从错误模块取出。
    const fallback = PICK_MOVE_TYPES.has(move.MoveType)
      ? firstStation(move, "SrcStationList")
      : PLACE_MOVE_TYPES.has(move.MoveType)
        ? move.ModuleName
        : move.MoveType === PROCESS_MOVE
          ? move.ModuleName
          : "";
    for (const material of materialIds(move)) {
      if (!locations.has(material) && fallback) locations.set(material, fallback);
    }
  }
  return locations;
}

/**
 * 返回晶圆在回放开始时的来源标识。
 *
 * 首次 Pick 能同时确认来源站与槽位，展示为 ``LP1.1``；缺少槽位或只能从
 * Place/Process/Swap 推断时保留模块名，避免把当前所在位置误作来源。
 */
function initialMaterialOrigins(moves: NormalizedMove[]): Map<string, string> {
  const origins = new Map<string, string>();
  const setOrigin = (material: string, module: string, slot = 0): void => {
    if (!material || !module || origins.has(material)) return;
    origins.set(material, slot > 0 ? `${module}.${slot}` : module);
  };
  for (const move of moves) {
    if (move.MoveType === SWAP_MOVE) {
      materialIds(move, "RecvMatList").forEach((material, index) => {
        setOrigin(
          material,
          indexedStation(move, "StationList", index),
          indexedSlot(move, "StnSendSlotList", index),
        );
      });
      for (const material of materialIds(move, "SendMatList")) {
        setOrigin(material, move.ModuleName);
      }
      continue;
    }
    const source = PICK_MOVE_TYPES.has(move.MoveType)
      ? "SrcStationList"
      : "";
    const fallback = source
      ? ""
      : PLACE_MOVE_TYPES.has(move.MoveType) || move.MoveType === PROCESS_MOVE
        ? move.ModuleName
        : "";
    materialIds(move).forEach((material, index) => {
      setOrigin(
        material,
        source ? indexedStation(move, source, index) : fallback,
        source ? indexedSlot(move, "SrcSlotList", index) : 0,
      );
    });
  }
  return origins;
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
    // RecvMatList 被机器人从站收回，SendMatList 由机器人送入站。
    for (const material of materialIds(move, "RecvMatList")) locations.set(material, move.ModuleName);
    for (const material of materialIds(move, "SendMatList")) locations.set(material, station);
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

/** 从设备定义读取站点槽位容量，缺失时使用设备类型对应的可视化缺省值。 */
function stationSlotCapacity(
  device: DeviceDefinition | null,
  name: string,
  defaultCapacity = 1,
): number {
  const definition = device?.Stations?.[name] ?? {};
  const declaredSlots = listValue(definition.Slots).map(value => finiteNumber(value, 0));
  return Math.max(
    1,
    defaultCapacity,
    finiteNumber(definition.Capacity, 0),
    declaredSlots.length,
    ...declaredSlots,
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
  replenishments: LoadPortReplenishment[],
): Map<string, LoadPortSlotSnapshot[]> {
  const names = new Set<string>();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isLoadPortName(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isLoadPortName(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }

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
      observedMaximum.set(source, Math.max(observedMaximum.get(source) ?? 0, slot));
    });
  }

  const result = new Map<string, LoadPortSlotSnapshot[]>();
  for (const name of names) {
    /*
     * 同一槽位依次出现的不同物料代表不同晶圆盒。按“槽位内第几个不同物料”建立
     * 盒次，可以在时间零点只装入首盒，并在下一盒首个 Pick 开始时一次装入整盒。
     * 同一片 Dummy 多次回库再取出仍属于同一盒次，不会被误判为补片。
     */
    const slotMaterialHistory = new Map<number, string[]>();
    const generationSlots = new Map<number, Map<number, { wafer: string; instanceId: string }>>();
    const generationStartTimes = new Map<number, number>([[0, 0]]);
    const materialGenerations = new Map<string, number>();
    for (const move of records) {
      if (!PICK_MOVE_TYPES.has(move.MoveType)) continue;
      materialIds(move).forEach((material, index) => {
        if (indexedStation(move, "SrcStationList", index) !== name) return;
        const slot = indexedSlot(move, "SrcSlotList", index);
        if (!slot) return;
        const instanceId = materialInstanceId(move, material, index);
        const history = slotMaterialHistory.get(slot) ?? [];
        let generation = history.indexOf(instanceId);
        if (generation < 0) {
          generation = history.length;
          history.push(instanceId);
          slotMaterialHistory.set(slot, history);
        }
        const slots = generationSlots.get(generation) ?? new Map<number, { wafer: string; instanceId: string }>();
        if (!slots.has(slot)) slots.set(slot, { wafer: material, instanceId });
        generationSlots.set(generation, slots);
        materialGenerations.set(instanceId, generation);
        if (generation > 0) {
          generationStartTimes.set(
            generation,
            Math.min(generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY, move.StartTime),
          );
        }
      });
    }
    /* 重算快照给出的补片时刻优先于新盒首片的 Pick 开始时刻。 */
    for (const replenishment of replenishments.filter(item => item.moduleName === name)) {
      const generations = replenishment.materials
        .map(material => materialGenerations.get(`${material.wafer}\u0000${material.taskId}`)
          ?? materialGenerations.get(material.wafer)
          ?? [...materialGenerations.entries()].find(([instanceId]) => (
            instanceId === material.wafer || instanceId.startsWith(`${material.wafer}\u0000`)
        ))?.[1])
        .filter((generation): generation is number => generation !== undefined);
      const generation = generations.length
        ? Math.max(...generations)
        : Math.max(...generationSlots.keys(), -1) + 1;
      const replenishedSlots = generationSlots.get(generation) ?? new Map<number, { wafer: string; instanceId: string }>();
      for (const material of replenishment.materials) {
        const declaredInstanceId = `${material.wafer}\u0000${material.taskId}`;
        const instanceId = materialGenerations.has(declaredInstanceId)
          ? declaredInstanceId
          : [...materialGenerations.keys()].find(candidate => (
          candidate === material.wafer || candidate.startsWith(`${material.wafer}\u0000`)
          )) ?? declaredInstanceId;
        replenishedSlots.set(material.slot, { wafer: material.wafer, instanceId });
        materialGenerations.set(instanceId, generation);
        observedMaximum.set(name, Math.max(observedMaximum.get(name) ?? 0, material.slot));
      }
      generationSlots.set(generation, replenishedSlots);
      generationStartTimes.set(
        generation,
        Math.min(generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY, replenishment.time),
      );
    }
    const activeGeneration = [...generationSlots.keys()]
      .filter(generation => generation === 0 || (generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY) <= time)
      .reduce((latest, generation) => Math.max(latest, generation), 0);
    const occupancy = new Map<number, { wafer: string; instanceId: string }>(generationSlots.get(activeGeneration) ?? []);
    /* 没有槽位字段的旧 MoveList 仍按初始位置顺序回退，但不与盒次推断混用。 */
    if (!occupancy.size && !generationSlots.size) {
      const legacyInitialMaterials = [...initialLocations.entries()]
        .filter(([, location]) => location === name)
        .map(([material]) => material)
        .sort(naturalCompare);
      legacyInitialMaterials.forEach((material, index) => occupancy.set(index + 1, { wafer: material, instanceId: material }));
    }

    for (const move of records) {
      const materials = materialIds(move);
      if (PICK_MOVE_TYPES.has(move.MoveType)) {
        if (move.EndTime > time) continue;
        materials.forEach((material, index) => {
          if (indexedStation(move, "SrcStationList", index) !== name) return;
          const instanceId = materialInstanceId(move, material, index);
          if ((materialGenerations.get(instanceId) ?? 0) !== activeGeneration) return;
          const slot = indexedSlot(move, "SrcSlotList", index);
          if (slot) occupancy.delete(slot);
          else {
            const current = [...occupancy.entries()].find(([, wafer]) => wafer.instanceId === instanceId);
            if (current) occupancy.delete(current[0]);
          }
        });
      } else if (PLACE_MOVE_TYPES.has(move.MoveType) && move.EndTime <= time) {
        materials.forEach((material, index) => {
          if (indexedStation(move, "DestStationList", index) !== name) return;
          const instanceId = materialInstanceId(move, material, index);
          if ((materialGenerations.get(instanceId) ?? 0) !== activeGeneration) return;
          let slot = indexedSlot(move, "DestSlotList", index);
          if (!slot) {
            slot = 1;
            while (occupancy.has(slot)) slot += 1;
          }
          occupancy.set(slot, { wafer: material, instanceId });
          observedMaximum.set(name, Math.max(observedMaximum.get(name) ?? 0, slot));
        });
      }
    }

    const occupiedMaximum = occupancy.size ? Math.max(...occupancy.keys()) : 0;
    const capacity = loadPortCapacity(
      device,
      name,
      Math.max(observedMaximum.get(name) ?? 0, occupiedMaximum, occupancy.size),
    );
    result.set(name, Array.from({ length: capacity }, (_, index) => {
      const occupied = occupancy.get(index + 1);
      return {
        slot: index + 1,
        wafer: occupied?.wafer ?? "",
        processed: Boolean(occupied && processedMaterials.has(occupied.instanceId)),
      };
    }));
  }
  return result;
}

/**
 * 从完整 MoveList 重建 LoadLock 正视双层的槽位占用。
 *
 * LoadPort 已有 buildLoadPortSlots 按 SrcSlotList/DestSlotList 精确跟踪；
 * LoadLock 双层同样携带槽位字段（PICK/PLACE 的 Src/DestSlotList，SWAP 的
 * StnSendSlotList/StnRecvSlotList）。这里按槽位号重建占用：槽位 1 对应上层、
 * 槽位 2 对应下层。只有时间零点确实位于 LoadLock 的晶圆，才会借助未来第一次
 * 取片/换片动作定位初始槽位；已完成动作再逐条更新，因此后续进入的晶圆不会提前
 * 出现在初始画面，真空交换后新片也会落在真实物理槽位而不受名称排序影响。
 */
function buildLoadLockSlots(
  records: NormalizedMove[],
  device: DeviceDefinition | null,
  time: number,
  initialLocations: Map<string, string>,
  processedMaterials: Set<string>,
  currentMaterialInstances: ReadonlyMap<string, string>,
): Map<string, LoadPortSlotSnapshot[]> {
  const names = new Set<string>();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isLoadLockName(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isLoadLockName(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }

  const initialByLock = new Map<string, Map<number, string>>();
  const observedMaximum = new Map<string, number>();
  /** 仅为时间零点已经位于指定 LoadLock 的晶圆记录初始槽位。 */
  const occupyInitial = (lock: string, slot: number, material: string): void => {
    if (!lock || !slot || !material || initialLocations.get(material) !== lock) return;
    names.add(lock);
    const occupancy = initialByLock.get(lock) ?? new Map<number, string>();
    if (!occupancy.has(slot)) occupancy.set(slot, material);
    initialByLock.set(lock, occupancy);
    observedMaximum.set(lock, Math.max(observedMaximum.get(lock) ?? 0, slot));
  };
  for (const move of records) {
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      materialIds(move).forEach((material, index) => {
        const source = indexedStation(move, "SrcStationList", index);
        if (!isLoadLockName(source, String(device?.Stations?.[source]?.Type ?? ""))) return;
        occupyInitial(source, indexedSlot(move, "SrcSlotList", index), material);
      });
    } else if (move.MoveType === SWAP_MOVE) {
      materialIds(move, "RecvMatList").forEach((material, index) => {
        const station = indexedStation(move, "StationList", index);
        if (!isLoadLockName(station, String(device?.Stations?.[station]?.Type ?? ""))) return;
        occupyInitial(station, indexedSlot(move, "StnSendSlotList", index), material);
      });
    }
  }

  const result = new Map<string, LoadPortSlotSnapshot[]>();
  for (const name of names) {
    const occupancy = new Map(initialByLock.get(name) ?? []);
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
      } else if (move.MoveType === SWAP_MOVE) {
        // 先移除被取走的旧片，再写入送入的新片，避免同槽换片互相覆盖。
        materialIds(move, "RecvMatList").forEach((material, index) => {
          if (indexedStation(move, "StationList", index) !== name) return;
          const slot = indexedSlot(move, "StnSendSlotList", index);
          if (slot) occupancy.delete(slot);
          else {
            const current = [...occupancy.entries()].find(([, wafer]) => wafer === material);
            if (current) occupancy.delete(current[0]);
          }
        });
        materialIds(move, "SendMatList").forEach((material, index) => {
          if (indexedStation(move, "StationList", index) !== name) return;
          let slot = indexedSlot(move, "StnRecvSlotList", index);
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
      const instanceId = currentMaterialInstances.get(wafer) ?? wafer;
      return { slot: index + 1, wafer, processed: Boolean(wafer && processedMaterials.has(instanceId)) };
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
  replenishments: LoadPortReplenishment[] = [],
): WorkspaceSnapshot {
  const records = normalizeMoves(moves);
  const endTime = records.reduce((maximum, move) => Math.max(maximum, move.EndTime), 0);
  const normalizedRequestedTime = requestedTime === Number.POSITIVE_INFINITY
    ? endTime
    : finiteNumber(requestedTime);
  const time = Math.max(0, Math.min(normalizedRequestedTime, endTime));
  const robotNames = collectRobotNames(records, device);
  const robotNameSet = new Set(robotNames);
  const definitions = collectModuleDefinitions(records, device, robotNameSet);
  const initialLocations = initialMaterialLocations(records);
  const waferOrigins = initialMaterialOrigins(records);
  const locations = new Map(initialLocations);
  const doorStates = new Map<string, DoorStatus>();
  const environments = new Map<string, string>();
  // 每片晶圆在整个计划中需要完成的加工工序数；只有全部工序完成才视为已加工。
  const requiredProcesses = new Map<string, number>();
  for (const move of records) {
    if (move.MoveType !== PROCESS_MOVE) continue;
    materialIds(move).forEach((material, index) => {
      const instanceId = materialInstanceId(move, material, index);
      requiredProcesses.set(instanceId, (requiredProcesses.get(instanceId) ?? 0) + 1);
    });
  }
  const completedProcesses = new Map<string, number>();
  /** 已完成加工的“晶圆 ID + PJob”实例，避免补片复用 ID 时继承旧批次状态。 */
  const processedMaterials = new Set<string>();
  /** 当前时间点每个显示 ID 对应的批次实例，供所有设备位置统一判断颜色。 */
  const currentMaterialInstances = new Map<string, string>();
  for (const move of records) {
    materialIds(move).forEach((material, index) => {
      if (!currentMaterialInstances.has(material)) {
        currentMaterialInstances.set(material, materialInstanceId(move, material, index));
      }
    });
  }
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
    if (move.StartTime <= time) {
      materialIds(move).forEach((material, index) => {
        currentMaterialInstances.set(material, materialInstanceId(move, material, index));
      });
    }
    if (active) activeMoves.push(move);
    if (completed) {
      completedMoves += 1;
      applyCompletedTransfer(move, locations);
      if (move.MoveType === PROCESS_MOVE) {
        materialIds(move).forEach((material, index) => {
          const instanceId = materialInstanceId(move, material, index);
          const completed = (completedProcesses.get(instanceId) ?? 0) + 1;
          completedProcesses.set(instanceId, completed);
          if (completed >= (requiredProcesses.get(instanceId) ?? 1)) {
            processedMaterials.add(instanceId);
          }
        });
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
  for (const replenishment of replenishments) {
    if (replenishment.time > time) continue;
    for (const material of replenishment.materials) {
      currentMaterialInstances.set(material.wafer, `${material.wafer}\u0000${material.taskId}`);
    }
  }
  const isProcessed = (material: string): boolean => processedMaterials.has(
    currentMaterialInstances.get(material) ?? material,
  );

  const robotTargets = new Map<string, string>();
  for (const move of activeMoves) {
    if (isRobotName(move.ModuleName, robotNameSet)) robotTargets.set(move.ModuleName, activeTarget(move));
  }
  const lastRobotTargets = new Map<string, string>();
  for (const move of records) {
    if (move.StartTime > time || !isRobotName(move.ModuleName, robotNameSet)) continue;
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
  const loadPortSlots = buildLoadPortSlots(
    records,
    device,
    time,
    initialLocations,
    processedMaterials,
    replenishments,
  );
  const loadLockSlots = buildLoadLockSlots(
    records,
    device,
    time,
    initialLocations,
    processedMaterials,
    currentMaterialInstances,
  );

  const modules = [...definitions.entries()].map(([name, definition]): ModuleSnapshot => {
    const moduleMoves = activeMoves.filter(move => (
      move.ModuleName === name
      || firstStation(move, "SrcStationList") === name
      || firstStation(move, "DestStationList") === name
      || listValue(move.StationList).map(String).includes(name)
    ));
    const primaryMove = moduleMoves.find(isCleaningMove)
      ?? moduleMoves.find(move => move.MoveType === PROCESS_MOVE)
      ?? moduleMoves.find(move => LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType))
      ?? moduleMoves.find(move => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType))
      ?? moduleMoves[0];
    let status: ModuleStatus = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove && isCleaningMove(primaryMove)) status = "cleaning";
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
      processedWafers: (wafersByLocation.get(name) ?? []).filter(isProcessed),
      loadPortSlots: loadPortSlots.get(name) ?? [],
      loadLockSlots: loadLockSlots.get(name) ?? [],
      slotCapacity: stationSlotCapacity(device, name, isCoolerModule(name, definition.type) ? 3 : 1),
      activeMoveName: primaryMove ? (isCleaningMove(primaryMove) ? "清洁" : MOVE_NAMES[primaryMove.MoveType] ?? `动作 ${primaryMove.MoveType}`) : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      loadLockPhase,
      isRobotTarget: [...robotTargets.values()].includes(name),
    };
  }).sort((left, right) => naturalCompare(left.name, right.name));

  const robots = robotNames.map((name): RobotSnapshot => {
    const move = activeMoves.find(record => record.ModuleName === name);
    const definition = device?.Robots?.[name] ?? {};
    const wafers = wafersByLocation.get(name) ?? [];
    return {
      name,
      type: String(definition.Type ?? ""),
      capacity: robotCapacity(definition, wafers.length),
      environment: robotEnvironment(name, definition),
      wafers,
      processedWafers: wafers.filter(isProcessed),
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
    waferOrigins: Object.fromEntries(waferOrigins),
    waferCount: new Set(records.flatMap(move => materialIds(move))).size,
  };
}

/** 从设备声明读取普通腔室容量；未声明容量的腔室按单槽处理。 */
function stationCapacity(device: DeviceDefinition | null, name: string): number {
  const definition = device?.Stations?.[name] ?? {};
  const slots = listValue(definition.Slots)
    .map(value => finiteNumber(value, 0))
    .filter(value => Number.isInteger(value) && value > 0);
  return Math.max(1, finiteNumber(definition.Capacity, 0), slots.length);
}

/** 找到计划中 PJob 使用的 Route，兼容页面短名称和运行时完整 PJobName。 */
function routeByPJobName(plan: UnknownRecord | null, pjobName: string): UnknownRecord | null {
  const routes = Array.isArray(plan?.routes) ? plan.routes : [];
  const routeByName = new Map(routes
    .filter(route => route && typeof route === "object" && !Array.isArray(route))
    .map(route => [String((route as UnknownRecord).name ?? ""), route as UnknownRecord]));
  const aliases = new Map<string, UnknownRecord>();
  const rounds = Array.isArray(plan?.rounds) ? plan.rounds : [];
  rounds.forEach((round, roundIndex) => {
    const cjobs = Array.isArray((round as UnknownRecord)?.cjobs) ? (round as UnknownRecord).cjobs as unknown[] : [];
    cjobs.forEach((cjob, cjobIndex) => {
      const row = cjob as UnknownRecord;
      const cjobName = String(row.key ?? `C${cjobIndex + 1}`);
      const pjobs = Array.isArray(row.pjobs) ? row.pjobs : [];
      pjobs.forEach((pjob, pjobIndex) => {
        const job = pjob as UnknownRecord;
        const shortName = String(job.jobName ?? `P${pjobIndex + 1}`);
        const route = routeByName.get(String(job.routeRef ?? ""));
        if (!route) return;
        aliases.set(`${roundIndex + 1}.${cjobName}.${shortName}`, route);
        if (!aliases.has(shortName)) aliases.set(shortName, route);
      });
    });
  });
  return aliases.get(pjobName) ?? aliases.get(pjobName.split(".").at(-1) ?? "") ?? null;
}

interface PlaybackMaterialProgress {
  pjobName: string;
  stepId: string;
  explicitTargets: string[];
}

/** 按 Move 完成顺序提取每片晶圆最后可确认的 Route 位置和显式搬运目标。 */
function replayMaterialProgress(records: NormalizedMove[]): Map<string, PlaybackMaterialProgress> {
  const progress = new Map<string, PlaybackMaterialProgress>();
  const update = (move: NormalizedMove, materials: string[], stepField: string, pjobOffset = 0): void => {
    const stepIds = listValue(move[stepField]);
    const pjobs = listValue(move.PJobName);
    materials.forEach((material, index) => {
      const previous = progress.get(material) ?? { pjobName: "", stepId: "", explicitTargets: [] };
      const explicitTarget = indexedStation(move, "DestStationList", index);
      progress.set(material, {
        pjobName: String(pjobs[pjobOffset + index] ?? pjobs[index] ?? previous.pjobName),
        stepId: String(stepIds[index] ?? previous.stepId),
        explicitTargets: explicitTarget ? [explicitTarget] : [],
      });
    });
  };
  for (const move of [...records].sort((left, right) => left.EndTime - right.EndTime || left.MoveID - right.MoveID)) {
    if (move.MoveType === SWAP_MOVE) {
      const received = materialIds(move, "RecvMatList");
      update(move, received, "RecvMatStepIDList");
      update(move, materialIds(move, "SendMatList"), "SendMatStepIDList", received.length);
    } else {
      update(move, materialIds(move), "StepIDList");
    }
  }
  return progress;
}

/** 根据最后 Step 的 PostStepID 返回下一步可用模块。 */
function nextRouteResources(
  plan: UnknownRecord | null,
  progress: PlaybackMaterialProgress | undefined,
): string[] {
  if (!progress) return [];
  if (progress.explicitTargets.length) return progress.explicitTargets;
  const route = routeByPJobName(plan, progress.pjobName);
  const stages = Array.isArray(route?.stages) ? route.stages as UnknownRecord[] : [];
  const currentIndex = stages.findIndex(stage => String(stage.stepId ?? "") === progress.stepId);
  if (currentIndex < 0) return [];
  const postStepIds = listValue(stages[currentIndex].postStepIds).map(String);
  const nextStages = postStepIds.length
    ? stages.filter(stage => postStepIds.includes(String(stage.stepId ?? "")))
    : stages.slice(currentIndex + 1, currentIndex + 2);
  return [...new Set(nextStages.flatMap(stage => (
    Array.isArray(stage.visits)
      ? stage.visits.map(visit => String((visit as UnknownRecord).stationName ?? ""))
      : []
  )).filter(Boolean))];
}

/**
 * 校验死锁识别依赖的 Pick/Place/Swap 位置演进。
 *
 * 这里只验证前端回放状态能否自洽，不复制服务端的门、压力、时长和工艺校验规则。
 */
function hasConsistentTransferReplay(
  records: NormalizedMove[],
  device: DeviceDefinition,
): boolean {
  const locations = initialMaterialLocations(records);
  const robotNames = new Set(Object.keys(device.Robots ?? {}));
  const locationCount = (location: string): number => [...locations.values()]
    .filter(current => current === location).length;
  const orderedTransfers = records
    .filter(move => PICK_MOVE_TYPES.has(move.MoveType) || PLACE_MOVE_TYPES.has(move.MoveType) || move.MoveType === SWAP_MOVE)
    .sort((left, right) => left.EndTime - right.EndTime || left.MoveID - right.MoveID);

  for (const move of orderedTransfers) {
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      const materials = materialIds(move);
      for (let index = 0; index < materials.length; index += 1) {
        const material = materials[index];
        const source = indexedStation(move, "SrcStationList", index);
        if (!source || locations.get(material) !== source) return false;
        const robotDefinition = device.Robots?.[move.ModuleName] ?? {};
        if (!robotNames.has(move.ModuleName) || locationCount(move.ModuleName) >= robotCapacity(robotDefinition)) return false;
        locations.set(material, move.ModuleName);
      }
      continue;
    }
    if (PLACE_MOVE_TYPES.has(move.MoveType)) {
      const materials = materialIds(move);
      for (let index = 0; index < materials.length; index += 1) {
        const material = materials[index];
        const destination = indexedStation(move, "DestStationList", index);
        if (!destination || locations.get(material) !== move.ModuleName) return false;
        if (locationCount(destination) >= stationCapacity(device, destination)) return false;
        locations.set(material, destination);
      }
      continue;
    }
    const received = materialIds(move, "RecvMatList");
    const sent = materialIds(move, "SendMatList");
    for (let index = 0; index < received.length; index += 1) {
      const station = indexedStation(move, "StationList", index);
      if (!station || locations.get(received[index]) !== station) return false;
      locations.set(received[index], move.ModuleName);
    }
    for (let index = 0; index < sent.length; index += 1) {
      const station = indexedStation(move, "StationList", index);
      if (!station || locations.get(sent[index]) !== move.ModuleName) return false;
      if (locationCount(station) >= stationCapacity(device, station)) return false;
      locations.set(sent[index], station);
    }
  }
  return true;
}

/**
 * 在 MoveList 回放终点识别三种明确的持片满腔死锁。
 *
 * 判定只读取前端回放出的最终位置、Route 下一步和设备容量，不信任算法提供的
 * DEADLOCK 分类。目标腔内晶圆的下一步也必须由同一机器手搬出，才算形成依赖。
 */
export function detectTerminalPlaybackDeadlock(
  moves: MoveRecord[],
  device: DeviceDefinition | null,
  plan: UnknownRecord | null,
): PlaybackDeadlock | null {
  if (!moves.length || !device || !plan) return null;
  const records = normalizeMoves(moves);
  if (!hasConsistentTransferReplay(records, device)) return null;
  const snapshot = buildWorkspaceSnapshot(records, device, Number.POSITIVE_INFINITY);
  const progress = replayMaterialProgress(records);
  const modules = new Map(snapshot.modules.map(module => [module.name, module]));
  const robotNames = new Set(snapshot.robots.map(robot => robot.name));

  const blockingTargets = (robot: RobotSnapshot, wafer: string): string[] => {
    const targets = nextRouteResources(plan, progress.get(wafer))
      .filter(target => !robotNames.has(target));
    if (!targets.length) return [];
    const blocked = targets.filter(target => {
      const chamber = modules.get(target);
      if (!chamber || chamber.wafers.length < stationCapacity(device, target)) return false;
      return chamber.wafers.some(occupant => (
        nextRouteResources(plan, progress.get(occupant)).includes(robot.name)
      ));
    });
    return blocked.length === targets.length ? blocked : [];
  };

  /** 找出仍占用目标腔室、且尚未完成整组清洗的 Dummy。 */
  const unfinishedCleaningBlockers = (targets: string[]): Array<{
    target: string;
    wafer: string;
    taskName: string;
  }> => targets.flatMap(target => {
    const occupants = modules.get(target)?.wafers ?? [];
    return occupants.flatMap(wafer => {
      const latestCleaningMove = [...records]
        .filter(move => (
          move.MoveType === PROCESS_MOVE
          && move.ModuleName === target
          && materialIds(move).includes(wafer)
          && isCleaningMove(move)
        ))
        .sort((left, right) => right.EndTime - left.EndTime || right.MoveID - left.MoveID)[0];
      if (!latestCleaningMove || latestCleaningMove.IsLastCleanTaskMove !== false) return [];
      return [{
        target,
        wafer,
        taskName: String(latestCleaningMove.CleanTaskName || latestCleaningMove.ProcessRecipe || "清洗任务"),
      }];
    });
  });

  for (const robot of snapshot.robots) {
    const held = [...robot.wafers].sort(naturalCompare);
    if (robot.capacity === 1 && held.length === 1) {
      const targets = blockingTargets(robot, held[0]);
      if (!targets.length) continue;
      const occupants = [...new Set(targets.flatMap(target => modules.get(target)?.wafers ?? []))].sort(naturalCompare);
      return {
        Code: "DEADLOCK.SINGLE_ARM_TARGET_FULL",
        Category: "single-arm-target-full",
        Message: `${robot.name} 的唯一手臂持有晶圆 ${held[0]}，目标 ${targets.join("、")} 被晶圆 ${occupants.join("、")} 占用；它没有空手接走腔内晶圆，持片又必须等目标腾空才能放下，形成相互等待。`,
      };
    }
    if (robot.capacity === 2 && held.length === 1) {
      const targets = blockingTargets(robot, held[0]);
      if (!targets.length) continue;
      const occupants = [...new Set(targets.flatMap(target => modules.get(target)?.wafers ?? []))].sort(naturalCompare);
      const cleaningBlockers = unfinishedCleaningBlockers(targets);
      const reason = cleaningBlockers.length
        ? cleaningBlockers.map(blocker => (
          `${blocker.target} 被尚未完成整组 ${blocker.taskName} 的清洗片 ${blocker.wafer} 占用；`
          + `晶圆 ${held[0]} 在清洗完成前禁止进入，不能直接换片。`
        )).join("")
        : `直接换片会让腔内晶圆 ${occupants.join("、")} 转到 ${robot.name} 的第二只手臂，`
          + `但回放终点没有能将这些晶圆继续放下的合法后继出口，换片链无法闭合。`;
      return {
        Code: "DEADLOCK.DUAL_ARM_SINGLE_HELD_TARGET_FULL",
        Category: "dual-arm-single-held-target-full",
        Message: `${robot.name} 已持有晶圆 ${held[0]}。${reason}腔内片又只能由 ${robot.name} 取出，形成持片等待闭环。`,
      };
    }
    if (robot.capacity === 2 && held.length === 2) {
      const targetsByWafer = held.map(wafer => blockingTargets(robot, wafer));
      if (targetsByWafer.some(targets => !targets.length)) continue;
      const targets = [...new Set(targetsByWafer.flat())].sort(naturalCompare);
      return {
        Code: "DEADLOCK.DUAL_ARM_TARGETS_FULL",
        Category: "dual-arm-targets-full",
        Message: `${robot.name} 两只手臂持有晶圆 ${held.join("、")}，目标 ${targets.join("、")} 均已满；没有空手接走腔内晶圆 ${[...new Set(targets.flatMap(target => modules.get(target)?.wafers ?? []))].sort(naturalCompare).join("、")}，持片又必须等目标腾空才能放下，形成相互等待。`,
      };
    }
  }
  return null;
}

/** 返回与当前页面结构绑定的工作台 DOM 节点。 */
function collectElements(root: Document): WorkspaceElements {
  const required = <ElementType extends HTMLElement>(id: string): ElementType => {
    const element = root.getElementById(id);
    if (!element) throw new Error(`结果分析页面缺少页面节点：${id}`);
    return element as ElementType;
  };
  const optionalSelect = (id: string, value: string): HTMLSelectElement => (
    root.getElementById(id) as HTMLSelectElement | null
    ?? { value, addEventListener: () => undefined } as unknown as HTMLSelectElement
  );
  return {
    toolbar: required("visualToolbar"),
    groupAnalysis: required("testGroupAnalysisPanel"),
    empty: required("visualEmpty"),
    playbackEmpty: required("visualPlaybackEmpty"),
    content: required("visualContent"),
    topologyPlayback: required("visualTopologyPlayback"),
    stage: required("visualDeviceStage"),
    /* 独立逻辑测试可使用精简页面夹具；真实页面始终提供该节点。 */
    frontSlotOverview: (root.getElementById("visualFrontSlotOverview") as HTMLElement | null)
      ?? ({ innerHTML: "", style: { setProperty() { /* 测试夹具无 CSS 自定义属性 */ } } } as unknown as HTMLElement),
    decisionLens: required("visualDecisionLens"),
    actionStatusFilters: Array.from(root.querySelectorAll<HTMLInputElement>("[data-action-status-filter]")),
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
    exportDiagnosticButton: root.getElementById("visualExportDeadlockDiagnostic") as HTMLButtonElement | null,
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
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  const stationDefinitions = device?.Stations ?? {};
  const hasConfiguredStations = Object.keys(stationDefinitions).length > 0;
  for (const candidate of decision?.candidates ?? []) {
    const name = candidate.destination;
    if (!name || isRobotName(name, configuredRobotNames) || knownNames.has(name)) continue;
    if (hasConfiguredStations && !stationDefinitions[name]) continue;
    const type = String(stationDefinitions[name]?.Type ?? "");
    modules.push({
      name,
      type,
      status: "idle",
      door: "closed",
      wafers: [],
      processedWafers: [],
      loadPortSlots: [],
      loadLockSlots: [],
      slotCapacity: stationSlotCapacity(device, name, isCoolerModule(name, type) ? 3 : 1),
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
 * 工艺模块、LoadLock、所有 LoadPort 与辅助设备完整保留，使拓扑结构不随当前盒
 * 是否有晶圆而跳动。
 * 已存在模块保留其回放状态；新增模块以空闲、门关闭的初始状态呈现。
 */
export function snapshotWithFullDeviceModules(
  snapshot: WorkspaceSnapshot,
  device: DeviceDefinition | null,
): WorkspaceSnapshot {
  const modules = [...snapshot.modules];
  const knownNames = new Set(modules.map(module => module.name));
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (knownNames.has(name) || isRobotName(name, configuredRobotNames)) continue;
    const type = String(definition?.Type ?? "");
    const slotCapacity = stationSlotCapacity(device, name, isCoolerModule(name, type) ? 3 : 1);
    modules.push({
      name,
      type,
      status: "idle",
      door: isDoorlessModule(name, type) ? "doorless" : "closed",
      wafers: [],
      processedWafers: [],
      loadPortSlots: isLoadPortName(name, type)
        ? Array.from({ length: loadPortCapacity(device, name, 0) }, (_, index) => ({
            slot: index + 1,
            wafer: "",
            processed: false,
          }))
        : [],
      loadLockSlots: [],
      slotCapacity,
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
  const processModules = modules.filter(module => (
    isProcessModule(module.name, module.type) || isHeaterModule(module.name, module.type)
  ));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map(module => module.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter(module => !assignedNames.has(module.name)),
  };
}

/** 双腔展开后的腔室视图；view 为可直接渲染的伪模块，sourceName 指向原 PM 模块。 */
interface DualChamberView {
  view: ModuleSnapshot;
  sourceName: string;
}

/**
 * 把双腔工艺模块展开为独立腔室卡片。
 *
 * 回放快照中一个 MultiProcessChamber（Capacity≥2）同时承载两个腔室，晶圆统一挂在
 * 模块名下。拓扑渲染时按槽位拆分为 "PM1-1" / "PM1-2" 两个腔室视图，各自持有一片
 * 晶圆，名称附加 "-N" 后缀以便区分；单腔模块保持原样返回。
 */
function expandDualProcessChambers(modules: ModuleSnapshot[]): DualChamberView[] {
  const expanded: DualChamberView[] = [];
  for (const module of modules) {
    if (module.slotCapacity < 2) {
      expanded.push({ view: module, sourceName: module.name });
      continue;
    }
    for (let index = 0; index < module.slotCapacity; index += 1) {
      const wafer = module.wafers[index] ?? "";
      expanded.push({
        view: {
          ...module,
          name: `${module.name}-${index + 1}`,
          wafers: wafer ? [wafer] : [],
          processedWafers: wafer && module.processedWafers.includes(wafer) ? [wafer] : [],
          slotCapacity: 1,
        },
        sourceName: module.name,
      });
    }
  }
  return expanded;
}

/** 绘制晶圆来源位置；外圈由当前腔室加工进度驱动。生产片显示 LPi.i，Dummy 显示原始物料 ID。 */
function renderWaferToken(
  wafer: string,
  origin: string,
  progress: number,
  processed = false,
): string {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  const state = processed ? "processed" : "unprocessed";
  const originLabel = origin || "来源未知";
  const surfaceLabel = waferSurfaceLabel(wafer, origin);
  const dummyClass = isDummyWafer(wafer, origin) ? " wafer-dummy" : "";
  return `<span class="wafer-token wafer-${state}${dummyClass}" style="--wafer-progress:${normalizedProgress * 360}deg" title="晶圆 ${escapeHtml(wafer)}，来源 ${escapeHtml(originLabel)}，${processed ? "已加工" : "未加工"}"><span><b class="wafer-origin-label">${escapeHtml(surfaceLabel)}</b></span></span>`;
}

/** 门始终朝向对应机械手；LoadLock 的上下门由俯视结构单独表达。 */
function moduleDoorSides(
  module: ModuleSnapshot,
  role: "process" | "lock" | "port" | "auxiliary",
  layout: TopologyLayout = "single",
  roleIndex = 0,
  attachmentId = "",
): Array<"top" | "right" | "bottom" | "left"> {
  if (module.door === "doorless") return [];
  if (role === "lock") return [];
  if (role === "port") return ["top"];
  const name = module.name.trim().toUpperCase();
  if (role === "process" && attachmentId) {
    if (attachmentId.endsWith("@left")) return ["right"];
    if (attachmentId.endsWith("@right")) return ["left"];
    if (attachmentId.endsWith("@top")) return ["bottom"];
    if (attachmentId.endsWith("@bottom")) return ["top"];
  }
  if (layout === "cascade" && role === "process") {
    /* 级联腔室按布局槽位朝向机器手，不依赖 PM1/PM2 等设备名称。 */
    const cascadeDoorSides: Array<Array<"top" | "right" | "bottom" | "left">> = [
      ["right"], ["left"], ["bottom"], ["right"], ["left"], ["left"],
    ];
    return cascadeDoorSides[roleIndex] ?? ["top"];
  }
  if (layout === "dual" && role === "process") {
    /* 双腔 U 形中，左右列的两腔都朝中央真空手开门。 */
    const dualDoorSides: Array<Array<"top" | "right" | "bottom" | "left">> = [
      ["right"], ["right"], ["bottom"], ["bottom"], ["left"], ["left"],
    ];
    return dualDoorSides[roleIndex] ?? ["top"];
  }
  if (role === "process") {
    const standardDoorSides: Array<Array<"top" | "right" | "bottom" | "left">> = [
      ["right"], ["left"], ["bottom"], ["bottom"], ["left"], ["left"],
    ];
    return standardDoorSides[roleIndex] ?? ["top"];
  }
  if (name === "HEATER") return ["left"];
  if (["AL", "ALIGNER"].includes(name)) return ["right"];
  if (["CL", "COOLER"].includes(name)) return ["left"];
  return ["top"];
}

/** 返回模块当前可见的物理槽位；空设备仍保留由容量声明的槽位。 */
function visibleModuleSlots(module: ModuleSnapshot, kind: "port" | "lock" | "cooler"): LoadPortSlotSnapshot[] {
  const recordedSlots = kind === "port"
    ? module.loadPortSlots
    : kind === "lock"
      ? module.loadLockSlots
      : [];
  if (recordedSlots.length) return recordedSlots;
  const slotCount = Math.max(kind === "lock" ? 2 : 1, module.slotCapacity, module.wafers.length);
  return Array.from({ length: slotCount }, (_, index) => ({
    slot: index + 1,
    wafer: module.wafers[index] ?? "",
    processed: module.processedWafers.includes(module.wafers[index] ?? ""),
  }));
}

/** 绘制左侧独立的正视槽位区；模块按类型分行，槽位高度随数量自然延展。 */
export function renderFrontSlotOverview(
  modules: ModuleSnapshot[],
  waferOrigins: Readonly<Record<string, string>> = {},
): string {
  const visibleModules = modules.filter(module => !isTopologyHiddenModule(module));
  type FrontSlotModule = { module: ModuleSnapshot; kind: "port" | "lock" | "cooler" };
  const moduleNameOrder = (left: FrontSlotModule, right: FrontSlotModule): number => {
    const leftName = left.module.name.trim();
    const rightName = right.module.name.trim();
    const leftPort = /^LP(\d+)$/i.exec(leftName);
    const rightPort = /^LP(\d+)$/i.exec(rightName);
    if (leftPort && rightPort) return Number(leftPort[1]) - Number(rightPort[1]);
    if (leftPort) return -1;
    if (rightPort) return 1;
    return leftName.localeCompare(rightName, undefined, { numeric: true });
  };
  const loadPorts = visibleModules
    .filter(module => isLoadPortName(module.name, module.type))
    .map(module => ({ module, kind: "port" as const }))
    .sort(moduleNameOrder);
  const coolers = visibleModules
    .filter(module => isCoolerModule(module.name, module.type))
    .map(module => ({ module, kind: "cooler" as const }))
    .sort(moduleNameOrder);
  const loadLocks = visibleModules
    .filter(module => isLoadLockName(module.name, module.type))
    .map(module => ({ module, kind: "lock" as const }))
    .sort(moduleNameOrder);
  const splitRows = (items: FrontSlotModule[], columns: number): FrontSlotModule[][] => (
    Array.from({ length: Math.ceil(items.length / columns) }, (_, index) => items.slice(index * columns, (index + 1) * columns))
  );
  /* LoadLock 优先展示；LoadPort 两列换行，Cooler 与 LoadLock 分别保持为独立的设备类型行。 */
  const slotRows = [
    ...splitRows(loadLocks, 2),
    ...splitRows(loadPorts, 2),
    ...splitRows(coolers, 2),
  ].filter(row => row.length);
  const renderSlots = (slots: LoadPortSlotSnapshot[], module: ModuleSnapshot): string => (
    slots.map(slot => {
      const state = !slot.wafer ? "empty" : slot.processed ? "processed" : "unprocessed";
      const dummy = Boolean(slot.wafer) && isDummyWafer(
        slot.wafer,
        waferOrigins[slot.wafer] ?? `${module.name}.${slot.slot}`,
      );
      const identity = `${module.name}.${slot.slot}`;
      const detail = slot.wafer
        ? `${identity} · 晶圆 ${slot.wafer}，${slot.processed ? "已加工" : "未加工"}`
        : `${identity} · 空槽`;
      return `<span class="front-slot is-${state}${dummy ? " is-dummy" : ""}" tabindex="0" title="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}"></span>`;
    }).join("")
  );
  if (!slotRows.length) return "";
  const renderModule = ({ module, kind }: FrontSlotModule): string => {
    const slots = visibleModuleSlots(module, kind);
    return `<div class="front-module">
      <strong title="${escapeHtml(module.name)}">${escapeHtml(module.name)}</strong>
      <div class="front-slot-board" style="--front-slot-count:${slots.length}" role="group" aria-label="${escapeHtml(`${module.name} 正视槽位`)}">${renderSlots(slots, module)}</div>
    </div>`;
  };
  const content = slotRows.map(row => `<div class="front-slot-row front-slot-row-${row[0].kind}" style="--front-row-module-count:${row.length}">${row.map(renderModule).join("")}</div>`).join("");
  return `<div class="topology-front-content" role="group" aria-label="设备正视槽位">${content}</div>`;
}

/** 把 LoadPort 显示为俯视装载台，主画布不再绘制正视晶圆盒。 */
function renderLoadPortTopView(
  module: ModuleSnapshot,
  wafers: string,
  accessibleStatus: string,
  candidate: CandidateDestinationSummary | undefined,
): string {
  const slots = visibleModuleSlots(module, "port");
  const processed = slots.filter(slot => slot.wafer && slot.processed).length;
  const unprocessed = slots.filter(slot => slot.wafer && !slot.processed).length;
  const candidateLabel = candidate ? `，${candidate.count} 个可行动作` : "";
  const isDummy = isDummyPortName(module.name) || module.type.trim().toLowerCase() === "dummyport";
  return `<strong class="equipment-external-name equipment-external-name-port">${escapeHtml(module.name)}</strong>
    <article class="equipment-card equipment-port-top-view status-${module.status} door-${module.door} ${isDummy ? "is-dummy-port" : ""} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""}" aria-label="${escapeHtml(`${accessibleStatus}，俯视装载台，共 ${slots.length} 个槽位，未加工 ${unprocessed}，已加工 ${processed}${candidateLabel}`)}">
      <span class="port-top-gate" aria-hidden="true"></span>
      <span class="port-top-cassette ${wafers ? "is-occupied" : "is-empty"}">${wafers || "<i></i>"}</span>
    </article>`;
}

/** 绘制拓扑中的紧凑腔室；晶圆标签只展示首次确认的来源模块。 */
function renderModule(
  module: ModuleSnapshot,
  waferOrigins: Readonly<Record<string, string>>,
  role: "process" | "lock" | "port" | "auxiliary",
  candidate: CandidateDestinationSummary | undefined,
  layout: TopologyLayout = "single",
  roleIndex = 0,
  attachmentId = "",
): string {
  const waferProgress = module.status === "processing" ? module.progress : 0;
  const visibleWaferCount = role === "lock" ? 2 : 1;
  const processedWafers = new Set(module.processedWafers ?? []);
  const wafers = module.wafers.slice(0, visibleWaferCount)
    .map(wafer => renderWaferToken(wafer, waferOrigins[wafer] ?? "", waferProgress, processedWafers.has(wafer)))
    .join("");
  const layerCount = role === "lock" && module.loadLockSlots.length
    ? module.loadLockSlots.filter(slot => slot.wafer).length
    : module.wafers.length;
  const overflow = layerCount > visibleWaferCount
    ? `<span class="wafer-more">+ ${layerCount - visibleWaferCount}</span>`
    : "";
  const doors = moduleDoorSides(module, role, layout, roleIndex, attachmentId)
    .map(side => `<i class="chamber-door chamber-door-${side}"></i>`)
    .join("");
  const accessibleStatus = `${module.name}，${STATUS_LABELS[module.status]}，${DOOR_LABELS[module.door]}`;
  const candidateLabel = candidate
    ? `${candidate.count} 个可行动作，最高模型偏好 ${(candidate.preference * 100).toFixed(0)}%`
    : "";
  if (role === "port") {
    // LoadPort 的盒次可能复用 MatID；俯视图必须复用物理槽位的批次状态，不能
    // 使用模块级 MatID 集合，否则补片后的新片会被旧片染成“已加工”。
    const visibleSlot = visibleModuleSlots(module, "port").find(slot => slot.wafer);
    const portWafers = visibleSlot
      ? renderWaferToken(
        visibleSlot.wafer,
        waferOrigins[visibleSlot.wafer] ?? "",
        waferProgress,
        visibleSlot.processed,
      )
      : "";
    return renderLoadPortTopView(module, portWafers, accessibleStatus, candidate);
  }
  if (role === "auxiliary" && isAlignerModule(module.name, module.type)) {
    return `<strong class="equipment-external-name equipment-external-name-aligner">${escapeHtml(module.name)}</strong>
      <article class="equipment-utility equipment-aligner status-${module.status} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `，${candidateLabel}` : ""}`)}">
        <div class="aligner-cross ${wafers ? "is-occupied" : "is-empty"}" aria-hidden="true"><i></i><i></i>${wafers}</div>
      </article>`;
  }
  if (role === "auxiliary" && isCoolerModule(module.name, module.type)) {
    const coolerSlots = visibleModuleSlots(module, "cooler");
    /* 冷却槽物理上沿竖直方向堆叠，俯视图只显示最上方的可见晶圆。 */
    const visibleSlot = coolerSlots.find(slot => slot.wafer) ?? coolerSlots[0];
    const state = !visibleSlot?.wafer ? "empty" : visibleSlot.processed ? "processed" : "unprocessed";
    const label = visibleSlot?.wafer
      ? `${module.name}.${visibleSlot.slot}，晶圆 ${visibleSlot.wafer}，${visibleSlot.processed ? "已加工" : "未加工"}`
      : `${module.name}.${visibleSlot?.slot ?? 1}，空槽`;
    const visibleWafer = visibleSlot?.wafer
      ? renderWaferToken(
          visibleSlot.wafer,
          waferOrigins[visibleSlot.wafer] ?? "",
          waferProgress,
          visibleSlot.processed,
        )
      : "";
    return `<strong class="equipment-external-name equipment-external-name-cooler">${escapeHtml(module.name)}</strong>
      <article class="equipment-utility equipment-cooler-top-view status-${module.status} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}，俯视冷却盘${candidateLabel ? `，${candidateLabel}` : ""}`)}">
        <div class="cooler-top-plate" role="group" aria-label="${escapeHtml(`${module.name} 俯视冷却盘`)}"><span class="cooler-top-pocket is-${state}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${visibleWafer}</span></div>
      </article>`;
  }
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
      ? (() => {
        const slots = visibleModuleSlots(module, "lock");
        /* 两层 LoadLock 槽沿竖直方向重叠，俯视图仅露出最上方的在位晶圆。 */
        const visibleSlot = slots.find(slot => slot.wafer) ?? slots[0];
        const state = !visibleSlot?.wafer ? "empty" : visibleSlot.processed ? "processed" : "unprocessed";
        const label = visibleSlot?.wafer
          ? `${module.name}.${visibleSlot.slot}，晶圆 ${visibleSlot.wafer}，${visibleSlot.processed ? "已加工" : "未加工"}`
          : `${module.name}.${visibleSlot?.slot ?? 1}，空槽`;
        const visibleWafer = visibleSlot?.wafer
          ? renderWaferToken(
              visibleSlot.wafer,
              waferOrigins[visibleSlot.wafer] ?? "",
              waferProgress,
              visibleSlot.processed,
            )
          : "";
        return `<div class="loadlock-top-chamber" role="group" aria-label="${escapeHtml(`${module.name} 俯视 LoadLock`)}"><span class="loadlock-top-seat is-${state}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${visibleWafer}</span></div>`;
      })()
    : role === "process"
      ? `<div class="process-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>`
      : role === "auxiliary"
        ? `<div class="auxiliary-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>`
        : `<div class="wafer-stack">${wafers}${overflow}</div>`;
  const bodyMarkup = role === "process"
    ? `<div class="equipment-process-shell"><div class="equipment-body">${loadLockLayers}</div></div>`
    : `<div class="equipment-body">${loadLockLayers}</div>`;
  const article = `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.loadLockPhase ? `loadlock-${module.loadLockPhase}` : ""} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" style="--module-progress:${Math.round(module.progress * 100)}%;--loadlock-atmosphere:${Math.max(0, Math.min(100, atmosphereLevel)).toFixed(1)}%;--loadlock-atmosphere-ratio:${Math.max(0, Math.min(1, atmosphereLevel / 100)).toFixed(3)}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `，${candidateLabel}` : ""}`)}">
       ${bodyMarkup}
      <div class="chamber-doors" aria-hidden="true">${role === "lock" ? '<i class="loadlock-top-gate loadlock-top-gate-vacuum"></i><i class="loadlock-top-gate loadlock-top-gate-atmosphere"></i>' : doors}</div>
    </article>`;
  if (role === "process" || role === "auxiliary" || role === "lock") {
    return `<strong class="equipment-external-name">${escapeHtml(module.name)}</strong>${article}`;
  }
  return article;
}

const ROBOT_DOUBLE_HOLD_CAPACITY = 2;
const ROBOT_DISPLAY_WAFER_LIMIT = 2;

/** 绘制机器手：双片仅用轻微错层区分，不额外显示数量标签。 */
function renderRobotHub(
  robot: RobotSnapshot,
  waferOrigins: Readonly<Record<string, string>>,
  environment: RobotEnvironment,
  angleDegrees: number,
): string {
  const visibleWafers = robot.wafers.slice(0, ROBOT_DISPLAY_WAFER_LIMIT);
  const capacityLabel = robot.capacity >= ROBOT_DOUBLE_HOLD_CAPACITY ? "双片机械手" : "单槽机械手";
  const holdingLabel = robot.wafers.length
    ? `，持有 ${robot.wafers.length} 片晶圆 ${robot.wafers.join("、")}`
    : "，槽位为空";
  const waferMarkup = visibleWafers.map((wafer, index) => `
    <span class="robot-held-wafer robot-held-wafer-${index}">${renderWaferToken(wafer, waferOrigins[wafer] ?? "", 0, robot.processedWafers.includes(wafer))}</span>`).join("");
  const overflow = robot.wafers.length > ROBOT_DISPLAY_WAFER_LIMIT
    ? `<span class="robot-held-overflow">+${robot.wafers.length - ROBOT_DISPLAY_WAFER_LIMIT}</span>`
    : "";
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" style="--robot-arm-angle:${angleDegrees.toFixed(1)}deg" aria-label="${escapeHtml(robot.name)}，${capacityLabel}，${robot.busy ? "工作中" : "待命"}${holdingLabel}">
      <span class="robot-environment-badge">${escapeHtml(robot.name)}</span>
      <div class="robot-mechanism" aria-hidden="true">
        <span class="robot-base"><i></i></span>
        <span class="robot-arm">
          <i class="robot-arm-beam"></i>
          <span class="robot-end-effector ${visibleWafers.length ? "is-occupied" : "is-empty"}">
            <span class="robot-held-wafers">${waferMarkup}${overflow}</span>
          </span>
        </span>
      </div>
    </article>`;
}

interface TopologyPosition {
  leftPercent: number;
  topPixels: number;
  widthPixels?: number;
  heightPixels?: number;
  /** 位置来源的稳定框架附着点；用于把视觉节点与机器骨架绑定。 */
  attachmentId?: string;
  /** 框架节点使用相对画布中心的固定像素横坐标，避免侧栏挤压后脱离方形框架。 */
  fixedLeftOffsetPixels?: number;
}

interface TopologyMachineFrame {
  id: string;
  label: string;
  centerLeftPercent: number;
  centerTopPixels: number;
  widthPixels: number;
  heightPixels: number;
  shape: "square" | "flat" | "atmosphere";
}

const TOPOLOGY_COLUMN_PERCENTAGES = [26, 42, 58, 74] as const;
const TOPOLOGY_ROW_TOP_PIXELS = [52, 154, 256, 358, 460, 562, 664, 786, 929, 1031, 1133] as const;
const TOPOLOGY_VIEWBOX_WIDTH = 1000;
const TOPOLOGY_ITEM_SIZE = 96;
const TOPOLOGY_PROCESS_WIDTH = 82;
const TOPOLOGY_PROCESS_HEIGHT = 82;
const TOPOLOGY_ROBOT_SIZE = 132;
/* 单腔、双腔均沿用原双腔的紧凑 LoadLock 尺寸。 */
const TOPOLOGY_LOADLOCK_WIDTH = 82;
const TOPOLOGY_LOADLOCK_HEIGHT = 82;
/** 同一桥接链相邻 LoadLock 外框之间保留的最小可读间隙。 */
const TOPOLOGY_LOADLOCK_BRIDGE_GAP = 2;
/* 级联双框等宽，LoadLock 的中心距离等于其自身宽度，从而形成紧贴的一对。 */
const TOPOLOGY_CASCADE_FRAME_WIDTH = 240;
const TOPOLOGY_CASCADE_VTR1_HEIGHT = 128;
const TOPOLOGY_TIGHT_LOADLOCK_ATTACHMENT_OFFSET = (TOPOLOGY_LOADLOCK_WIDTH + 1) / TOPOLOGY_CASCADE_FRAME_WIDTH;
const TOPOLOGY_LOADPORT_WIDTH = 82;
const TOPOLOGY_LOADPORT_HEIGHT = 82;
const TOPOLOGY_LOADPORT_BASE_HEIGHT = 22;
/* 底座顶沿仅压住晶圆盒底边 2px，使 LoadPort 明确站在下托之上。 */
const TOPOLOGY_LOADPORT_BASE_OVERHANG = 16;
/** 大气框架内部设备与边缘保持的紧凑留白。 */
const TOPOLOGY_ATMOSPHERE_INTERIOR_INSET = 14;
const TOPOLOGY_BUFFER_WIDTH = 104;
const TOPOLOGY_BUFFER_HEIGHT = 56;
const TOPOLOGY_COOLER_WIDTH = 76;
const TOPOLOGY_COOLER_HEIGHT = 72;
const TOPOLOGY_ALIGNER_WIDTH = 76;
const TOPOLOGY_ALIGNER_HEIGHT = 54;
const TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS = [664, 740] as const;
const TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS = 866;
const TOPOLOGY_LOADPORT_ROW_TOP_PIXELS = 1006;
const TOPOLOGY_CANVAS_PADDING = 28;
const TOPOLOGY_EXTERNAL_LABEL_CLEARANCE = 22;
/* 真空机器框架是拓扑布局的唯一几何基准；模块只引用框架边缘的不可见附着点。 */
const TOPOLOGY_MACHINE_FRAMES: Record<TopologyLayout, readonly TopologyMachineFrame[]> = {
  single: [{
    id: "vacuum-main",
    label: "VTR VACUUM FRAME",
    centerLeftPercent: 50,
    centerTopPixels: 270,
    widthPixels: 240,
    heightPixels: 240,
    shape: "square",
  }],
  dual: [{
    id: "vacuum-main",
    label: "",
    centerLeftPercent: 50,
    centerTopPixels: 270,
    widthPixels: 240,
    heightPixels: 240,
    shape: "square",
  }],
  cascade: [
    {
      id: "vacuum-vtr-2",
      label: "",
      centerLeftPercent: 50,
      centerTopPixels: 230,
      widthPixels: TOPOLOGY_CASCADE_FRAME_WIDTH,
      heightPixels: TOPOLOGY_CASCADE_FRAME_WIDTH,
      shape: "square",
    },
    {
      id: "vacuum-vtr-1",
      label: "",
      centerLeftPercent: 50,
      /* 上移 8px，使 UBR/DBR 同时贴合 VTR_2 底边与 VTR_1 顶边。 */
      centerTopPixels: 496,
      widthPixels: TOPOLOGY_CASCADE_FRAME_WIDTH,
      heightPixels: TOPOLOGY_CASCADE_VTR1_HEIGHT,
      shape: "flat",
    },
  ],
};
/* 大气侧使用独立框架；其上边承接 LoadLock，下边承接三个实际 LoadPort。 */
const TOPOLOGY_ATMOSPHERE_FRAMES: Record<TopologyLayout, TopologyMachineFrame> = {
  single: {
    id: "atmosphere-main",
    /* 大气框架仅表达附着边界，不在框内重复显示区域名称。 */
    label: "",
    centerLeftPercent: 50,
    /* LoadLock 作为真空与大气框架之间的桥接腔。 */
    centerTopPixels: 547,
    widthPixels: 425,
    heightPixels: 150,
    shape: "atmosphere",
  },
  dual: {
    id: "atmosphere-main",
    label: "",
    centerLeftPercent: 50,
    centerTopPixels: 547,
    widthPixels: 425,
    heightPixels: 150,
    shape: "atmosphere",
  },
  cascade: {
    id: "atmosphere-main",
    label: "",
    centerLeftPercent: 50,
    centerTopPixels: 717,
    widthPixels: 425,
    heightPixels: 150,
    shape: "atmosphere",
  },
};
const TOPOLOGY_CASCADE_LOCK_ROW_TOP = 597;
const TOPOLOGY_CASCADE_LOCK_ROW_GAP = 80;
const TOPOLOGY_CASCADE_ATM_TOP = 720;
/* 大气侧在所有拓扑中共用同一垂直节奏：LoadPort 位于 ATR 下方 140px。 */
const TOPOLOGY_ATMOSPHERE_LOADPORT_OFFSET = 140;
const TOPOLOGY_CASCADE_LOADPORT_TOP = TOPOLOGY_CASCADE_ATM_TOP + TOPOLOGY_ATMOSPHERE_LOADPORT_OFFSET;

/** 返回指定布局的机器框架；索引在级联布局中固定为 VTR_2、VTR_1。 */
function topologyMachineFrame(layout: TopologyLayout, index = 0): TopologyMachineFrame {
  return TOPOLOGY_MACHINE_FRAMES[layout][index] ?? TOPOLOGY_MACHINE_FRAMES[layout][0];
}

/** 返回大气传输框架；所有实际 LoadPort 和非桥接 LoadLock 均以它为附着基准。 */
function topologyAtmosphereFrame(layout: TopologyLayout): TopologyMachineFrame {
  return TOPOLOGY_ATMOSPHERE_FRAMES[layout];
}

/**
 * 由机器框架边缘生成模块中心点，使模块外框与框架边缘严格相切。
 * offset 取 -1～1，表示沿该边从左/上到右/下的位置。
 */
function topologyFrameAttachment(
  frame: TopologyMachineFrame,
  attachmentId: string,
  side: "top" | "right" | "bottom" | "left" | "center",
  offset: number,
  widthPixels: number,
  heightPixels: number,
): TopologyPosition {
  const halfWidthPercent = widthPixels / TOPOLOGY_VIEWBOX_WIDTH * 50;
  const frameWidthPercent = frame.widthPixels / TOPOLOGY_VIEWBOX_WIDTH * 100;
  if (side === "center") {
    return {
      leftPercent: frame.centerLeftPercent,
      topPixels: frame.centerTopPixels,
      widthPixels,
      heightPixels,
      attachmentId,
      fixedLeftOffsetPixels: 0,
    };
  }
  const horizontalOffset = offset * frameWidthPercent / 2;
  const verticalOffset = offset * frame.heightPixels / 2;
  return {
    leftPercent: side === "left"
      ? frame.centerLeftPercent - frameWidthPercent / 2 - halfWidthPercent
      : side === "right"
        ? frame.centerLeftPercent + frameWidthPercent / 2 + halfWidthPercent
        : frame.centerLeftPercent + horizontalOffset,
    topPixels: Math.round(side === "top"
      ? frame.centerTopPixels - frame.heightPixels / 2 - heightPixels / 2
      : side === "bottom"
        ? frame.centerTopPixels + frame.heightPixels / 2 + heightPixels / 2
        : frame.centerTopPixels + verticalOffset),
    widthPixels,
    heightPixels,
    attachmentId,
    fixedLeftOffsetPixels: (side === "left"
      ? -frame.widthPixels / 2 - widthPixels / 2
      : side === "right"
        ? frame.widthPixels / 2 + widthPixels / 2
        : horizontalOffset / 100 * TOPOLOGY_VIEWBOX_WIDTH),
  };
}

/**
 * 计算连接真空与大气侧的 LoadLock 位置。
 *
 * LoadLock 的上缘由真空框架下边锚定，下缘与大气框架上边相切。横坐标从真空
 * 框架推导，并按两框架宽度换算为大气框架上的同一物理位置，避免缩放后偏离中轴。
 */
function topologyVacuumAtmosphereLoadLockBridge(
  layout: TopologyLayout,
  lockIndex: number,
  atmosphereOffset: number,
): TopologyPosition {
  const vacuumFrame = layout === "cascade"
    ? topologyMachineFrame("cascade", 1)
    : topologyMachineFrame(layout);
  const atmosphereFrame = topologyAtmosphereFrame(layout);
  const vacuumOffset = atmosphereOffset * atmosphereFrame.widthPixels / vacuumFrame.widthPixels;
  const vacuumAttachment = topologyFrameAttachment(
    vacuumFrame,
    `${vacuumFrame.id}-loadlock-${lockIndex + 1}@bottom`,
    "bottom",
    vacuumOffset,
    TOPOLOGY_LOADLOCK_WIDTH,
    TOPOLOGY_LOADLOCK_HEIGHT,
  );
  const atmosphereAttachment = topologyFrameAttachment(
    atmosphereFrame,
    `${atmosphereFrame.id}-loadlock-${lockIndex + 1}@top`,
    "top",
    atmosphereOffset,
    TOPOLOGY_LOADLOCK_WIDTH,
    TOPOLOGY_LOADLOCK_HEIGHT,
  );
  return {
    ...vacuumAttachment,
    /* 两端框架的中心距由常量固定；保留大气锚点的纵坐标以表达两侧同时相切。 */
    topPixels: atmosphereAttachment.topPixels,
    attachmentId: `${vacuumAttachment.attachmentId}|${atmosphereAttachment.attachmentId}`,
  };
}

/** 返回在一条桥接链中居中且以固定窄间隔连续排列的横向偏移。 */
function topologyTightLoadLockOffsets(count: number, frameWidthPixels: number): number[] {
  if (count <= 1) return [0];
  const centerSpacing = TOPOLOGY_LOADLOCK_WIDTH + TOPOLOGY_LOADLOCK_BRIDGE_GAP;
  const offsetStep = centerSpacing / (frameWidthPixels / 2);
  return Array.from(
    { length: count },
    (_, index) => (index - (count - 1) / 2) * offsetStep,
  );
}

/** 把辅助设备固定在框架内部四角，避免随画布宽度变化而漂移。 */
function topologyFrameInteriorCorner(
  frame: TopologyMachineFrame,
  attachmentId: string,
  horizontal: "left" | "right",
  widthPixels: number,
  heightPixels: number,
): TopologyPosition {
  const horizontalOffset = frame.widthPixels / 2 - TOPOLOGY_ATMOSPHERE_INTERIOR_INSET - widthPixels / 2;
  return {
    leftPercent: frame.centerLeftPercent + (horizontal === "left" ? -horizontalOffset : horizontalOffset) / TOPOLOGY_VIEWBOX_WIDTH * 100,
    topPixels: frame.centerTopPixels - frame.heightPixels / 2 + TOPOLOGY_ATMOSPHERE_INTERIOR_INSET + heightPixels / 2,
    widthPixels,
    heightPixels,
    attachmentId,
    fixedLeftOffsetPixels: horizontal === "left" ? -horizontalOffset : horizontalOffset,
  };
}

/** 返回均匀分布在四列设备网格中的横向位置。 */
function distributedTopologyColumns(count: number): number[] {
  if (count <= 1) return [50];
  if (count === 2) return [40, 60];
  if (count === 3) return [30, 50, 70];
  return Array.from({ length: count }, (_, index) => 20 + index * 60 / (count - 1));
}

/** 判断站点类型是否表示可同时处理多片晶圆的多腔加工站。 */
function isMultiProcessChamberType(value: unknown): boolean {
  const type = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return type.includes("multiprocesschamber")
    || ((type.includes("multi") || type.includes("dual") || type.includes("double"))
      && (type.includes("process") || type.includes("chamber")));
}

/** 由回放快照判断拓扑布局，不依赖设备、腔室或机器手名称。 */
export function detectTopologyLayout(modules: ModuleSnapshot[], robotCount: number): TopologyLayout {
  if (robotCount > 2) return "cascade";
  const hasMultiProcessChamber = modules.some(module => isMultiProcessChamberType(module.type));
  return hasMultiProcessChamber ? "dual" : "single";
}

/** 由 init 设备结构判断拓扑布局，供设备摘要与回放共用同一套规则。 */
export function detectDeviceTopologyLayout(device: DeviceDefinition | null): TopologyLayout {
  const robotCount = Object.keys(device?.Robots ?? {}).length;
  if (robotCount > 2) return "cascade";
  const hasMultiProcessChamber = Object.values(device?.Stations ?? {})
    .some(station => {
      const type = String(station.Type ?? "");
      return isMultiProcessChamberType(type)
        || (/process|chamber/i.test(type) && finiteNumber(station.Capacity, 1) > 1);
    });
  return hasMultiProcessChamber ? "dual" : "single";
}

/** 在设备 JSON 中查找精确的模块引用；同时覆盖对象键（如 PickTime.UBR）与字段值。 */
function configurationReferencesName(value: unknown, name: string): boolean {
  if (typeof value === "string") return value === name;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => configurationReferencesName(item, name));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    key === name || configurationReferencesName(item, name)
  ));
}

/**
 * 识别连接上下两级真空机械手的桥接 LoadLock。
 *
 * 完整设备配置优先按真实连通关系判断；精简配置通常只保留 Type，因此兼容
 * UBR/DBR 语义名称。仅当两者都不可用时，才沿用“前四个为接口腔”的旧顺序规则。
 */
function cascadeBridgeLoadLockNames(
  orderedLoadLockNames: string[],
  device: DeviceDefinition | null | undefined,
  vacuumRobotNames: string[],
): Set<string> {
  const structurallyLinked = orderedLoadLockNames.filter(loadLockName => {
    const station = device?.Stations?.[loadLockName];
    const linkedVacuumRobots = vacuumRobotNames.filter(robotName => (
      configurationReferencesName(station, robotName)
      || configurationReferencesName(device?.Robots?.[robotName], loadLockName)
    ));
    return linkedVacuumRobots.length >= 2;
  });
  if (structurallyLinked.length) return new Set(structurallyLinked);

  const namedBridges = orderedLoadLockNames
    .filter(name => /^(?:UBR|DBR)(?:[_-]?\d+)?$/i.test(name.trim()))
    .sort((left, right) => {
      const rank = (name: string): number => /^UBR/i.test(name.trim()) ? 0 : 1;
      return rank(left) - rank(right) || naturalCompare(left, right);
    });
  return new Set(namedBridges.length ? namedBridges : orderedLoadLockNames.slice(4));
}

/** 按参考仓库 CenterCanvas 的四列网格计算模块坐标。 */
function moduleTopologyPosition(
  module: ModuleSnapshot,
  role: "process" | "lock" | "port" | "auxiliary",
  index: number,
  roleModules: ModuleSnapshot[],
  layout: TopologyLayout,
  bridgeLoadLockNames: ReadonlySet<string> = new Set(),
): TopologyPosition {
  const name = module.name.trim().toUpperCase();
  const roleCount = roleModules.length;
  const column = TOPOLOGY_COLUMN_PERCENTAGES;
  const row = TOPOLOGY_ROW_TOP_PIXELS;
  if (layout === "cascade" && role === "process") {
    const ordered = [...roleModules]
      .filter(item => !isHeaterModule(item.name, item.type))
      .sort((left, right) => naturalCompare(left.name, right.name));
    const layoutIndex = Math.max(0, ordered.findIndex(item => item.name === module.name));
    const upperFrame = topologyMachineFrame("cascade", 0);
    const lowerFrame = topologyMachineFrame("cascade", 1);
    const positions = [
      topologyFrameAttachment(lowerFrame, "vtr-1-process-left@left", "left", 0, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(lowerFrame, "vtr-1-process-right@right", "right", 0, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(upperFrame, "vtr-2-process-left-lower@left", "left", .55, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(upperFrame, "vtr-2-process-top-left@top", "top", -.45, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(upperFrame, "vtr-2-process-right-upper@right", "right", -.45, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
    ];
    const position = positions[layoutIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[layoutIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[0] - Math.floor(layoutIndex / Math.max(roleCount, 1)) * 112,
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (layout === "dual" && role === "process") {
    /*
     * 双腔设备采用稳定的 U 形布局，而不是复用单腔的编号顺序：
     * PM1 两腔在左列，PM2 两腔在上排，PM3 两腔在右列。
     * 左、右列的下腔从上排所有腔室的底边之后开始，避免两排视觉相交。
     */
    const dualBaseName = module.name.replace(/-\d+$/, "");
    const dualSlotIndex = Math.max(0, Number(/-(\d+)$/.exec(module.name)?.[1] ?? "1") - 1);
    const dualBaseNames = [...new Set(roleModules
      .map(item => item.name.replace(/-\d+$/, "")))]
      .sort(naturalCompare);
    const dualBaseIndex = Math.max(0, dualBaseNames.indexOf(dualBaseName));
    const frame = topologyMachineFrame("dual");
    const dualLayout: TopologyPosition[][] = [
      [
        topologyFrameAttachment(frame, "dual-pm1-upper@left", "left", -.38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
        topologyFrameAttachment(frame, "dual-pm1-lower@left", "left", .38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      ],
      [
        topologyFrameAttachment(frame, "dual-pm2-left@top", "top", -.5, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
        topologyFrameAttachment(frame, "dual-pm2-right@top", "top", .5, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      ],
      [
        topologyFrameAttachment(frame, "dual-pm3-upper@right", "right", -.38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
        topologyFrameAttachment(frame, "dual-pm3-lower@right", "right", .38, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      ],
    ];
    const position = dualLayout[dualBaseIndex]?.[dualSlotIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[dualBaseIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[3],
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (role === "process") {
    const frame = topologyMachineFrame("single");
    if (isHeaterModule(module.name, module.type)) {
      return topologyFrameAttachment(
        frame,
        "single-heater-top-left@top",
        "top",
        -.5,
        TOPOLOGY_PROCESS_WIDTH,
        TOPOLOGY_PROCESS_HEIGHT,
      );
    }
    const ordered = [...roleModules]
      .filter(item => !isHeaterModule(item.name, item.type))
      .sort((left, right) => naturalCompare(left.name, right.name));
    const layoutIndex = Math.max(0, ordered.findIndex(item => item.name === module.name));
    const positions = [
      topologyFrameAttachment(frame, "single-process-left-upper@left", "left", -.32, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(frame, "single-process-left-lower@left", "left", .48, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(frame, "single-process-right-upper@right", "right", -.32, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
      topologyFrameAttachment(frame, "single-process-right-lower@right", "right", .48, TOPOLOGY_PROCESS_WIDTH, TOPOLOGY_PROCESS_HEIGHT),
    ];
    const position = positions[layoutIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[layoutIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[3],
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (layout === "cascade" && role === "lock" && bridgeLoadLockNames.has(module.name)) {
    const orderedBridges = [...bridgeLoadLockNames];
    const bridgeIndex = Math.max(0, orderedBridges.indexOf(module.name));
    return topologyFrameAttachment(
      topologyMachineFrame("cascade", 0),
      bridgeIndex % 2 === 0 ? "cascade-bridge-left" : "cascade-bridge-right",
      "bottom",
      bridgeIndex % 2 === 0
        ? -TOPOLOGY_TIGHT_LOADLOCK_ATTACHMENT_OFFSET
        : TOPOLOGY_TIGHT_LOADLOCK_ATTACHMENT_OFFSET,
      TOPOLOGY_LOADLOCK_WIDTH,
      TOPOLOGY_LOADLOCK_HEIGHT,
    );
  }
  if (role === "lock") {
    /* 双腔设备的四个 LoadLock 对应一条横向接口链：LC → LA → LB → LD。 */
    const canonicalOrder: Record<string, number> = layout === "dual"
      ? { LC: 0, LA: 1, LB: 2, LD: 3 }
      : { LA: 0, LB: 1, LC: 2, LD: 3 };
    /* UBR/DBR 已连接两级真空框架，不能占用 LA/LB 的大气桥接锚点。 */
    const atmosphereLoadLocks = layout === "cascade"
      ? roleModules.filter(item => !bridgeLoadLockNames.has(item.name))
      : roleModules;
    const orderedLoadLocks = [...atmosphereLoadLocks].sort((left, right) => {
      const leftName = left.name.trim().toUpperCase();
      const rightName = right.name.trim().toUpperCase();
      const leftRank = canonicalOrder[leftName] ?? 100;
      const rightRank = canonicalOrder[rightName] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const gridIndex = Math.max(0, orderedLoadLocks.findIndex(item => item.name === module.name));
    if ((layout === "single" || layout === "dual" || layout === "cascade") && gridIndex < 4) {
      const atmosphereLockCount = orderedLoadLocks.length;
      const offsets = topologyTightLoadLockOffsets(
        atmosphereLockCount,
        topologyAtmosphereFrame(layout).widthPixels,
      );
      return topologyVacuumAtmosphereLoadLockBridge(
        layout,
        gridIndex,
        offsets[gridIndex] ?? 0,
      );
    }
    const loadLockRowTop = layout === "cascade" ? TOPOLOGY_CASCADE_LOCK_ROW_TOP : TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    const loadLockRowGap = layout === "cascade"
      ? TOPOLOGY_CASCADE_LOCK_ROW_GAP
      : TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[1] - TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    return {
      leftPercent: gridIndex % 2 === 0 ? 40 : 60,
      topPixels: loadLockRowTop + Math.floor(gridIndex / 2) * loadLockRowGap,
      widthPixels: TOPOLOGY_LOADLOCK_WIDTH,
      heightPixels: TOPOLOGY_LOADLOCK_HEIGHT,
    };
  }
  if (role === "port") {
    const canonicalOrder: Record<string, number> = { LP1: 0, LP2: 1, LP3: 2, LP4: 3 };
    const orderedPorts = [...roleModules].sort((left, right) => {
      const leftDummy = isDummyPortName(left.name) || left.type.trim().toLowerCase() === "dummyport";
      const rightDummy = isDummyPortName(right.name) || right.type.trim().toLowerCase() === "dummyport";
      if (leftDummy !== rightDummy) return leftDummy ? 1 : -1;
      const leftRank = canonicalOrder[left.name.trim().toUpperCase()] ?? 100;
      const rightRank = canonicalOrder[right.name.trim().toUpperCase()] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const portIndex = Math.max(0, orderedPorts.findIndex(item => item.name === module.name));
    if (portIndex < 4) {
      const offsets = orderedPorts.length <= 1
        ? [0]
        : orderedPorts.length === 2
          ? [-.3, .3]
          : orderedPorts.length === 3
            ? [-.6, 0, .6]
            : [-.7, -.233, .233, .7];
      return topologyFrameAttachment(
        topologyAtmosphereFrame(layout),
        `atmosphere-port-${portIndex + 1}@bottom`,
        "bottom",
        offsets[portIndex] ?? 0,
        TOPOLOGY_LOADPORT_WIDTH,
        TOPOLOGY_LOADPORT_HEIGHT,
      );
    }
    const portColumns = roleCount === 5
      ? [26, 38, 50, 62, 74]
      : roleCount <= column.length
        ? column
        : Array.from({ length: roleCount }, (_, current) => 20 + current * 60 / (roleCount - 1));
    const loadPortTop = layout === "cascade" ? TOPOLOGY_CASCADE_LOADPORT_TOP : TOPOLOGY_LOADPORT_ROW_TOP_PIXELS;
    return {
      leftPercent: portColumns[portIndex] ?? column[0],
      topPixels: loadPortTop,
      widthPixels: TOPOLOGY_LOADPORT_WIDTH,
      heightPixels: TOPOLOGY_LOADPORT_HEIGHT,
    };
  }
  if (isAlignerModule(module.name, module.type)) {
    return topologyFrameInteriorCorner(
      topologyAtmosphereFrame(layout),
      "atmosphere-aligner-top-left@inside",
      "left",
      TOPOLOGY_ALIGNER_WIDTH,
      TOPOLOGY_ALIGNER_HEIGHT,
    );
  }
  if (role === "auxiliary" && isCoolerModule(module.name, module.type)) {
    return topologyFrameInteriorCorner(
      topologyAtmosphereFrame(layout),
      "atmosphere-cooler-top-right@inside",
      "right",
      TOPOLOGY_COOLER_WIDTH,
      TOPOLOGY_COOLER_HEIGHT,
    );
  }
  if (role === "auxiliary" && isBufferModule(module.name, module.type)) {
    const atmosphereTop = layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS;
    const rightUtilities = roleModules
      .filter(item => isBufferModule(item.name, item.type))
      .sort((left, right) => naturalCompare(left.name, right.name));
    const utilityIndex = Math.max(0, rightUtilities.findIndex(item => item.name === module.name));
    /* 从 ATR 所在行开始向下排，避免首个 Buffer/Cooler 越过大气区上边界。 */
    const utilityTop = atmosphereTop + utilityIndex * 68;
    return {
      leftPercent: 90,
      topPixels: utilityTop,
      widthPixels: TOPOLOGY_BUFFER_WIDTH,
      heightPixels: TOPOLOGY_BUFFER_HEIGHT,
    };
  }
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
  layout: TopologyLayout,
): TopologyPosition {
  if (environment === "atmosphere") {
    const atmosphereFrame = topologyAtmosphereFrame(layout);
    if (robotCount > 1) {
      return {
        leftPercent: distributedTopologyColumns(robotCount)[robotIndex] ?? 50,
        topPixels: atmosphereFrame.centerTopPixels,
        widthPixels: TOPOLOGY_ROBOT_SIZE,
        heightPixels: TOPOLOGY_ROBOT_SIZE,
      };
    }
    return topologyFrameAttachment(
      atmosphereFrame,
      "atr-center",
      "center",
      0,
      TOPOLOGY_ROBOT_SIZE,
      TOPOLOGY_ROBOT_SIZE,
    );
  }
  if (layout === "cascade") {
    /* 第一把真空手属于下层扁框架，其余真空手属于上层方框架。 */
    const frame = topologyMachineFrame("cascade", robotIndex === 0 ? 1 : 0);
    return topologyFrameAttachment(
      frame,
      robotIndex === 0 ? "vtr-1-center" : `vtr-2-center-${robotIndex}`,
      "center",
      0,
      TOPOLOGY_ROBOT_SIZE,
      TOPOLOGY_ROBOT_SIZE,
    );
  }
  if (layout === "dual") {
    return topologyFrameAttachment(
      topologyMachineFrame("dual"),
      "dual-robot-center",
      "center",
      0,
      TOPOLOGY_ROBOT_SIZE,
      TOPOLOGY_ROBOT_SIZE,
    );
  }
  return topologyFrameAttachment(
    topologyMachineFrame("single"),
    "single-robot-center",
    "center",
    0,
    TOPOLOGY_ROBOT_SIZE,
    TOPOLOGY_ROBOT_SIZE,
  );
}

/** 把百分比横坐标转换为设备画布 SVG viewBox 坐标。 */
function topologySvgPoint(position: TopologyPosition): { x: number; y: number } {
  return {
    x: position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH,
    y: position.topPixels,
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
 * init Type 为 ATM/ATR 的机械手进入下排 LC/LD，VTM/VTR 进入上排 LA/LB；
 * 没有 init 类型时才回退到历史名称前缀判断。
 */
function robotLoadLockPortal(
  robotName: string,
  moduleName: string,
  modulePositions: Map<string, TopologyPosition>,
  environment?: RobotEnvironment,
): string {
  const normalizedModule = moduleName.trim().toUpperCase();
  const isAtmosphereRobot = environment
    ? environment === "atmosphere"
    : /^(ATR|ATM)/i.test(robotName);
  const isVacuumRobot = environment
    ? environment === "vacuum"
    : /^(VTR|VTM|VAC)/i.test(robotName);
  if (!isAtmosphereRobot && !isVacuumRobot) return moduleName;
  const preferred = ["LA", "LC"].includes(normalizedModule)
    ? (isAtmosphereRobot ? "LC" : "LA")
    : ["LB", "LD"].includes(normalizedModule)
      ? (isAtmosphereRobot ? "LD" : "LB")
      : moduleName;
  return modulePositions.has(preferred) ? preferred : moduleName;
}

/** 真空机器手面向 LA/LB 时取两腔中心，其余目标仍指向具体模块。 */
function robotTargetTopologyPosition(
  robot: RobotSnapshot,
  moduleName: string,
  modulePositions: Map<string, TopologyPosition>,
): TopologyPosition | undefined {
  const normalizedModule = moduleName.trim().toUpperCase();
  if (robot.environment === "vacuum" && ["LA", "LB"].includes(normalizedModule)) {
    const leftLoadLock = modulePositions.get("LA");
    const rightLoadLock = modulePositions.get("LB");
    if (leftLoadLock && rightLoadLock) {
      return {
        leftPercent: (leftLoadLock.leftPercent + rightLoadLock.leftPercent) / 2,
        topPixels: (leftLoadLock.topPixels + rightLoadLock.topPixels) / 2,
        widthPixels: 0,
        heightPixels: 0,
      };
    }
  }
  const portal = robotLoadLockPortal(robot.name, moduleName, modulePositions, robot.environment);
  return modulePositions.get(portal);
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
    const targetPosition = robotTargetTopologyPosition(robot, target, modulePositions);
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
  device?: DeviceDefinition | null,
): string {
  const visibleModules = snapshot.modules.filter(module => (
    !isTopologyHiddenModule(module) && !isModuleFilteredOut(module, hiddenFilters)
  ));
  const groups = topologyGroups(visibleModules);
  const destinations = candidateDestinations(decision);
  const atmosphereRobots = snapshot.robots.filter(robot => (
    robot.environment === "atmosphere"
      || (!robot.environment && /^(ATR|ATM)/i.test(robot.name))
  ));
  const atmosphereNames = new Set(atmosphereRobots.map(robot => robot.name));
  const vacuumRobots = snapshot.robots.filter(robot => !atmosphereNames.has(robot.name));
  const layout = device
    ? detectDeviceTopologyLayout(device)
    : detectTopologyLayout(visibleModules, snapshot.robots.length);
  const machineFrames = TOPOLOGY_MACHINE_FRAMES[layout].map(frame => ({ ...frame }));
  /* 双腔布局把 MultiProcessChamber 拆成独立腔室卡片，占满单腔 6 腔室 U 形布局。 */
  const processChamberViews = layout === "dual"
    ? expandDualProcessChambers(groups.processModules)
    : groups.processModules.map(module => ({ view: module, sourceName: module.name }));
  const processSourceNames = new Map(processChamberViews.map(item => [item.view.name, item.sourceName]));
  const loadLockNameSet = new Set(groups.loadLocks.map(module => module.name));
  const configuredLoadLockOrder = Object.keys(device?.Stations ?? {})
    .filter(name => loadLockNameSet.has(name));
  const orderedLoadLockNames = configuredLoadLockOrder.length === groups.loadLocks.length
    ? configuredLoadLockOrder
    : groups.loadLocks.map(module => module.name);
  const bridgeLoadLockNames = layout === "cascade"
    ? cascadeBridgeLoadLockNames(
      orderedLoadLockNames,
      device,
      vacuumRobots.map(robot => robot.name),
    )
    : new Set<string>();
  const modulePositions = new Map<string, TopologyPosition>();
  const positionModuleGroup = (
    modules: ModuleSnapshot[],
    role: "process" | "lock" | "port" | "auxiliary",
  ): void => modules.forEach((module, index) => {
    const position = moduleTopologyPosition(module, role, index, modules, layout, bridgeLoadLockNames);
    modulePositions.set(module.name, position);
  });
  positionModuleGroup(processChamberViews.map(item => item.view), "process");
  positionModuleGroup(groups.loadLocks, "lock");
  positionModuleGroup(groups.loadPorts, "port");
  positionModuleGroup(groups.auxiliaryModules, "auxiliary");
  /* 双腔展开后，原 PM 模块名指向两腔中心，供机器手目标箭头复用。 */
  if (layout === "dual") {
    for (const item of processChamberViews) {
      if (item.view.name === item.sourceName) continue;
      const first = modulePositions.get(`${item.sourceName}-1`);
      const second = modulePositions.get(`${item.sourceName}-2`);
      if (first && second) {
        modulePositions.set(item.sourceName, {
          leftPercent: (first.leftPercent + second.leftPercent) / 2,
          topPixels: (first.topPixels + second.topPixels) / 2,
          widthPixels: TOPOLOGY_PROCESS_WIDTH,
          heightPixels: TOPOLOGY_PROCESS_HEIGHT,
        });
      }
    }
  }

  const robotPositions = new Map<string, TopologyPosition>();
  const positionRobotGroup = (
    robots: RobotSnapshot[],
    environment: "vacuum" | "atmosphere",
  ): void => robots.forEach((robot, index) => {
    const position = robotTopologyPosition(index, robots.length, environment, layout);
    robotPositions.set(robot.name, position);
  });
  positionRobotGroup(vacuumRobots, "vacuum");
  positionRobotGroup(atmosphereRobots, "atmosphere");

  const atmosphereFrame = { ...topologyAtmosphereFrame(layout) };
  const allPositions = [
    ...modulePositions.values(),
    ...robotPositions.values(),
    ...machineFrames.map(frame => ({
      leftPercent: frame.centerLeftPercent,
      topPixels: frame.centerTopPixels,
      widthPixels: frame.widthPixels,
      heightPixels: frame.heightPixels,
    })),
    {
      leftPercent: atmosphereFrame.centerLeftPercent,
      topPixels: atmosphereFrame.centerTopPixels,
      widthPixels: atmosphereFrame.widthPixels,
      heightPixels: atmosphereFrame.heightPixels,
    },
  ];
  const minimumTop = allPositions.length
    ? Math.min(...allPositions.map(position => position.topPixels - (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2))
    : 0;
  const maximumBottom = allPositions.length
    ? Math.max(...allPositions.map(position => position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2))
    : TOPOLOGY_ITEM_SIZE;
  const verticalOffset = TOPOLOGY_CANVAS_PADDING - minimumTop;
  let canvasHeight = Math.max(
    520,
    Math.ceil(maximumBottom + verticalOffset + TOPOLOGY_CANVAS_PADDING),
  );
  for (const [name, position] of modulePositions) {
    modulePositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  for (const [name, position] of robotPositions) {
    robotPositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  machineFrames.forEach(frame => {
    frame.centerTopPixels += verticalOffset;
  });
  atmosphereFrame.centerTopPixels += verticalOffset;
  const machineAreaMarkup = "";
  const machineFrameMarkup = [...machineFrames, atmosphereFrame].map(frame => {
    const frameAnchors = (["top", "right", "bottom", "left"] as const)
      .flatMap(edge => [1, 2].map(index => (
        `<i class="topology-frame-anchor topology-frame-anchor-${edge} topology-frame-anchor-${index}" data-anchor-id="${escapeHtml(frame.id)}-${edge}-${index}" data-anchor-edge="${edge}" aria-hidden="true"></i>`
      )))
      .join("");
    return `
    <div class="topology-machine-frame topology-machine-frame-${frame.shape}" data-frame-id="${escapeHtml(frame.id)}" style="--frame-left:${frame.centerLeftPercent}%;--frame-top:${frame.centerTopPixels}px;--frame-width:${frame.widthPixels}px;--frame-height:${frame.heightPixels}px" aria-hidden="true">
      ${frame.label ? `<span>${escapeHtml(frame.label)}</span>` : ""}
      ${frameAnchors}
    </div>`;
  }).join("");
  const attachmentPointMarkup = [...modulePositions.values(), ...robotPositions.values()]
    .filter(position => position.attachmentId)
    .map(position => `<i class="topology-attachment-point" data-attachment-id="${escapeHtml(position.attachmentId ?? "")}" style="--attachment-left:${position.leftPercent}%;--attachment-top:${position.topPixels}px" aria-hidden="true"></i>`)
    .join("");

  const renderModuleGroup = (
    modules: ModuleSnapshot[],
    role: "process" | "lock" | "port" | "auxiliary",
  ): string => modules.map((module, roleIndex) => {
    const position = modulePositions.get(module.name);
    if (!position) return "";
    /* 展开后的腔室卡片仍用原 PM 模块名查询候选动作高亮。 */
    const candidateSource = processSourceNames.get(module.name) ?? module.name;
    const fixedLeft = position.fixedLeftOffsetPixels === undefined
      ? ""
      : `;--fixed-left:calc(50% ${position.fixedLeftOffsetPixels < 0 ? "-" : "+"} ${Math.abs(position.fixedLeftOffsetPixels)}px)`;
    return `<div class="reference-module-position" style="--module-left:${position.leftPercent}%;--module-top:${position.topPixels}px${fixedLeft}">${renderModule(module, snapshot.waferOrigins, role, destinations.get(candidateSource), layout, roleIndex, position.attachmentId)}</div>`;
  }).join("");
  const moduleMarkup = [
    renderModuleGroup(processChamberViews.map(item => item.view), "process"),
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
    const targetPosition = robotTargetTopologyPosition(robot, target, modulePositions);
    const targetAngle = targetPosition
      ? Math.atan2(
          targetPosition.topPixels - position.topPixels,
          targetPosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
            - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH,
        )
      : -Math.PI / 2;
    let armAngle = targetAngle;
    if (robot.isPreTrans && robot.source) {
      const sourcePortal = robotLoadLockPortal(robot.name, robot.source, modulePositions, robot.environment);
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
    const fixedLeft = position.fixedLeftOffsetPixels === undefined
      ? ""
      : `;--fixed-left:calc(50% ${position.fixedLeftOffsetPixels < 0 ? "-" : "+"} ${Math.abs(position.fixedLeftOffsetPixels)}px)`;
    return `<div class="reference-robot-position" style="--robot-left:${position.leftPercent}%;--robot-top:${position.topPixels}px${fixedLeft}">${renderRobotHub(robot, snapshot.waferOrigins, environment, angleDegrees)}</div>`;
  }).join("");
  const robotMarkup = renderRobotGroup(vacuumRobots, "vacuum")
    + renderRobotGroup(atmosphereRobots, "atmosphere");
  return `
    <section class="equipment-schematic" data-topology-layout="${layout}" aria-label="完整设备拓扑回放">
      <div class="schematic-canvas reference-grid-canvas" style="--topology-canvas-height:${canvasHeight}px">
        <div class="topology-status-legend" role="group" aria-label="回放状态图例">
          <span><i class="topology-status-legend-processing"></i>加工</span>
          <span><i class="topology-status-legend-pumping"></i>抽气</span>
          <span><i class="topology-status-legend-venting"></i>充气</span>
          <span><i class="topology-status-legend-cleaning"></i>清洁</span>
          <span><i class="topology-status-legend-transfer"></i>传输</span>
          <span><i class="topology-status-legend-door"></i>门动作</span>
        </div>
        ${machineAreaMarkup}
        ${machineFrameMarkup}
        ${attachmentPointMarkup}
        ${moduleMarkup}
        ${robotMarkup}
      </div>
    </section>`;
}

/** 生成与候选排序无关的决策空间签名，只在可行动作集合变化时改变。 */
export function decisionSpaceSignature(decision: DecisionTraceStep): string {
  const actionIds = decision.candidates
    .map(candidate => candidate.actionId)
    .filter(Boolean)
    .sort();
  return JSON.stringify([decision.candidateCount, actionIds]);
}

/** 返回完整搬运事务完成后的决策边界；Pick 结束不是新的决策点。 */
export function decisionBoundaryTimes(moves: MoveRecord[]): number[] {
  return [...new Set(
    moves
      .filter(move => DECISION_COMPLETION_MOVE_TYPES.has(finiteNumber(move.MoveType, -1)))
      .map(move => finiteNumber(move.EndTime))
      .filter(time => time >= 0),
  )].sort((left, right) => left - right);
}

/** 双 Actor 每完成一个 Pick / Place / Swap 都会进入下一次原子决策。 */
export function primitiveDecisionBoundaryTimes(moves: MoveRecord[]): number[] {
  return [...new Set(
    moves
      .filter(move => PRIMITIVE_DECISION_COMPLETION_MOVE_TYPES.has(finiteNumber(move.MoveType, -1)))
      .map(move => finiteNumber(move.EndTime))
      .filter(time => time >= 0),
  )].sort((left, right) => left - right);
}

/** 把站点或 Robot 与槽位格式化为 LP1#1。 */
function formatActionEndpoint(name: string, slot: number): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return slot > 0 ? `${trimmed}#${slot}` : trimmed;
}

/** 生成 Pick(1) LP1#1 → ATR#1 形式的动作路径。 */
function formatActionPath(action: ReplayActionDiagnostic): string {
  const kindLabels = { pick: "Pick", place: "Place", swap: "Swap" };
  const materialIds = action.materialIds.filter(Boolean).join(",");
  const kindLabel = kindLabels[action.kind];
  const prefix = materialIds ? `${kindLabel}(${materialIds})` : kindLabel;
  const source = formatActionEndpoint(action.source, action.sourceSlot);
  const destination = formatActionEndpoint(action.destination, action.destinationSlot);
  const path = [source, destination].filter(Boolean).join(" → ");
  return path ? `${prefix} ${path}` : prefix;
}

/** 绘制算法动作接口返回的原子动作分类。 */
export function renderDecisionLens(
  decision: DecisionTraceStep | null,
  requestState: "idle" | "loading" | "error" = "idle",
  requestError = "",
  statusFilters: ActionDiagnosticStatus[] = ALL_ACTION_DIAGNOSTIC_STATUSES,
): string {
  if (!decision) {
    if (requestState === "loading") {
      return `
        <div class="decision-empty is-loading" role="status" aria-live="polite">
          <div class="visual-loader" aria-hidden="true"></div>
          <strong>正在更新当前动作</strong>
          <p>正在按 Move 状态调用算法动作接口。</p>
        </div>`;
    }
    if (requestState === "error") {
      return `
        <div class="decision-empty is-error" role="alert">
          <strong>动作接口调用失败</strong>
          <p>${escapeHtml(requestError || "无法获取当前动作，请检查服务状态。")}</p>
        </div>`;
    }
    return `
      <div class="decision-empty">
        <strong>当前动作卡片为空</strong>
        <p>当前算法未提供动作接口，或回放到此时没有动作。</p>
      </div>`;
  }
  const statusLabels: Record<ActionDiagnosticStatus, string> = {
    enabled: "使能",
    "physical-blocked": "物理拦截",
    "deadlock-blocked": "死锁规则拦截",
  };
  const visibleActions = decision.actionDiagnostics.filter(action => statusFilters.includes(action.status));
  const cards = visibleActions.map(action => {
    const reason = action.reason || statusLabels[action.status];
    const duplicate = action.duplicateCount > 0
      ? `<small>另 ${action.duplicateCount} 片相同</small>`
      : "";
    return `
      <li class="decision-candidate action-card action-status-${action.status}" tabindex="0" aria-label="${escapeHtml(`${formatActionPath(action)}，${statusLabels[action.status]}`)}">
        <strong class="action-card-path">${escapeHtml(formatActionPath(action))}</strong>
        ${duplicate}
        <span class="action-status-tooltip" role="tooltip">${escapeHtml(reason)}</span>
      </li>`;
  }).join("");
  const counts = decision.actionCounts;
  const provider = decision.actionDiagnosticsSource === "algorithm"
    ? `算法接口 · ${decision.actionDiagnosticsProvider || "未命名实现"}`
    : "算法未提供动作接口";
  return `
    <section class="decision-candidate-section" aria-label="当前合法动作">
      <p class="action-count-summary">使能 ${counts.enabled} · 物理拦截 ${counts["physical-blocked"]} · 死锁拦截 ${counts["deadlock-blocked"]}</p>
      ${cards ? `<ul>${cards}</ul>` : '<p class="decision-alternative-empty">当前筛选条件下没有动作</p>'}
    </section>`;
}

/** 把比例格式化为一位小数百分比。 */
function formatPercent(value: number): string {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}

/** 为单个资源生成分类色条。 */
function renderCategoryBars(resource: Pick<ResourcePerformance, "categoryTimes">, windowDuration: number): string {
  return ACTIVITY_CATEGORIES.map(category => {
    const duration = resource.categoryTimes[category];
    if (duration <= PERFORMANCE_DISPLAY_TOLERANCE || windowDuration <= PERFORMANCE_DISPLAY_TOLERANCE) return "";
    const width = Math.min(duration / windowDuration * 100, 100);
    return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds(duration)} s"></span>`;
  }).join("");
}

export interface BottleneckResourceGroup {
  name: string;
  memberNames: string[];
  kind: ResourceKind;
  utilization: number;
  busyTime: number;
  categoryTimes: Record<ActivityCategory, number>;
  candidate: BottleneckCandidate | null;
}

/**
 * 将并行工序设备合并为一条展示记录。
 *
 * 工艺腔优先沿用服务端识别出的工序容量组；LoadLock、LoadPort 按同类设备合并，
 * 机器人和辅助模块仍各自展示。所有时长与利用率均按组内设备数取算术平均。
 */
export function groupedBottleneckResources(
  performance: SchedulePerformance,
): BottleneckResourceGroup[] {
  const resources = performance.resources;
  const byName = new Map(resources.map(resource => [resource.name, resource]));
  const assigned = new Set<string>();
  const memberGroups: ResourcePerformance[][] = [];

  const addGroup = (members: ResourcePerformance[]): void => {
    const uniqueMembers = members.filter(member => !assigned.has(member.name));
    if (!uniqueMembers.length) return;
    uniqueMembers.forEach(member => assigned.add(member.name));
    memberGroups.push(uniqueMembers);
  };

  for (const candidate of performance.bottleneckCandidates) {
    if (candidate.kind !== "process-group") continue;
    addGroup(candidate.resourceNames
      .map(name => byName.get(name))
      .filter((resource): resource is ResourcePerformance => Boolean(resource)));
  }

  const remainingProcess = resources.filter(resource => (
    resource.kind === "process" && !assigned.has(resource.name)
  ));
  addGroup(remainingProcess);
  addGroup(resources.filter(resource => (
    resource.kind === "loadlock" && resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE
  )));
  addGroup(resources.filter(resource => (
    resource.kind === "loadport" && resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE
  )));
  for (const resource of resources.filter(resource => (
    resource.kind === "robot" || resource.kind === "auxiliary"
  ))) addGroup([resource]);

  const sameMembers = (candidate: BottleneckCandidate, names: string[]): boolean => (
    candidate.resourceNames.length === names.length
    && candidate.resourceNames.every(name => names.includes(name))
  );

  return memberGroups.map(members => {
    const memberNames = members.map(member => member.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
    const memberCount = members.length;
    const categoryTimes = Object.fromEntries(ACTIVITY_CATEGORIES.map(category => [
      category,
      members.reduce((sum, member) => sum + member.categoryTimes[category], 0) / memberCount,
    ])) as Record<ActivityCategory, number>;
    return {
      name: memberNames.join(" / "),
      memberNames,
      kind: members[0].kind,
      utilization: members.reduce((sum, member) => sum + member.utilization, 0) / memberCount,
      busyTime: members.reduce((sum, member) => sum + member.busyTime, 0) / memberCount,
      categoryTimes,
      candidate: performance.bottleneckCandidates.find(candidate => sameMembers(candidate, memberNames)) ?? null,
    };
  }).filter(group => group.busyTime > PERFORMANCE_DISPLAY_TOLERANCE)
    .sort((left, right) => (
      right.utilization - left.utilization
      || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
    ))
    .slice(0, 4);
}

/** 渲染合并后的瓶颈分析区域：候选排序 + 各资源占用比例。 */
function renderBottleneckAnalysis(performance: SchedulePerformance): string {
  const { window } = performance;
  const confidenceLabels = { high: "证据较强", medium: "证据中等", low: "证据较弱" };
  const resourceKindLabels: Record<ResourceKind, string> = {
    robot: "机械手",
    process: "工艺腔",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "辅助模块",
  };

  // 表格聚焦最需要优先处理的三个资源；完整分组结果仍保留给既有数据逻辑使用。
  const displayedResources = groupedBottleneckResources(performance).slice(0, 3);
  const resourceRows = (items: BottleneckResourceGroup[]): string => items.map((resource, index) => {
    const candidate = resource.candidate;
    const evidenceScore = candidate ? Math.round(candidate.score * 100) : null;
    const evidenceLabel = candidate ? confidenceLabels[candidate.confidence] : "未入选候选";
    const resourceLabel = resource.memberNames.length > 1
      ? `${resourceKindLabels[resource.kind]} · ${resource.memberNames.length} 台平均`
      : resourceKindLabels[resource.kind];
    return `
      <li class="resource-utilization-row">
        <div class="resource-utilization-summary">
          <div class="resource-utilization-name">
            <span>${index + 1}</span>
            <div><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resourceLabel)}</small></div>
          </div>
          <strong class="resource-utilization-percent">${formatPercent(resource.utilization)}</strong>
          <div class="utilization-track" aria-label="${escapeHtml(resource.name)} 占用率 ${formatPercent(resource.utilization)}">${renderCategoryBars(resource, window.duration)}</div>
          <div class="resource-evidence-score"><strong>${evidenceScore ?? "—"}</strong><small>${evidenceLabel}</small></div>
          <span aria-hidden="true"></span>
        </div>
      </li>`;
  }).join("");

  const legend = ACTIVITY_CATEGORIES.map(category => (
    `<span><i class="performance-swatch category-${category}"></i>${ACTIVITY_CATEGORY_LABELS[category]}</span>`
  )).join("");
  return `
    <header class="analysis-section-head bottleneck-analysis-head">
      <div class="analysis-section-title"><strong>瓶颈分析</strong></div>
      <div class="bottleneck-analysis-actions">
        <label class="bottleneck-window-control"><span class="visually-hidden">统计口径</span><div class="bottleneck-window-slot"></div></label>
        <button class="analysis-secondary-button bottleneck-analysis-help" id="bottleneckAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="bottleneckAnalysisHelpDialog"><span aria-hidden="true">ⓘ</span> 说明</button>
      </div>
    </header>
    <ol class="resource-utilization-list">
      ${resourceRows(displayedResources)}
    </ol>
    <div class="performance-legend" aria-label="占用组成图例">${legend}</div>
  `;
}

type ResidenceMetricKind = "system" | "chamber" | "robot";

/** 渲染单一驻留口径的逐片柱状图，保持三种口径的原有配色与平均线表达。 */
function renderResidenceMetricChart(
  samples: WaferResidenceTime[],
  kind: ResidenceMetricKind,
): string {
  const definitions: Record<ResidenceMetricKind, { title: string; label: string; value: (sample: WaferResidenceTime) => number }> = {
    system: { title: "系统驻留时间", label: "系统驻留", value: sample => sample.duration },
    chamber: { title: "腔室驻留时间", label: "腔室驻留", value: sample => sample.chamberDwellSeconds ?? 0 },
    robot: { title: "机器手驻留时间", label: "机器手驻留", value: sample => sample.robotDwellSeconds ?? 0 },
  };
  const metric = definitions[kind];
  const values = samples.map(metric.value);
  const meanSeconds = values.reduce((sum, value) => sum + value, 0) / values.length;
  const maximumSeconds = Math.max(...values, 1);
  const plotHeight = 150;
  const scaleMaximum = maximumSeconds * 1.08;
  const meanHeight = Math.min(meanSeconds / scaleMaximum * plotHeight, plotHeight);
  const bars = samples.map(sample => {
    const seconds = metric.value(sample);
    const height = Math.max(seconds / scaleMaximum * plotHeight, 2);
    const wafer = escapeHtml(String(sample.wafer));
    const duration = formatSeconds(seconds);
    return `
      <li class="residence-metric-bar-item" role="img" aria-label="晶圆 ${wafer}，${metric.label} ${duration} 秒">
        <strong>${duration}</strong>
        <span class="residence-metric-bar residence-bar-${kind}"><i style="height:${height.toFixed(2)}px"></i></span>
        <small>${wafer}</small>
      </li>`;
  }).join("");
  return `
    <div class="residence-metric-chart residence-metric-${kind}" data-residence-metric-chart="${kind}"${kind === "system" ? "" : " hidden"}>
      <div class="residence-metric-scroll" tabindex="0" aria-label="逐片晶圆${metric.title}柱状图，可横向滚动">
        <div class="residence-metric-plot">
          <div class="residence-metric-mean-line" style="bottom:${(26 + meanHeight).toFixed(2)}px"><span>平均 ${formatSeconds(meanSeconds)} s</span></div>
          <ol class="residence-metric-bars">${bars}</ol>
        </div>
      </div>
    </div>`;
}

/** 渲染逐片晶圆的系统、腔室与机器手驻留时间图表。 */
export function renderWaferResidenceChart(performance: SchedulePerformance): string {
  const samples = performance.waferSystemResidenceTimes ?? [];
  const helpButton = `<button class="analysis-secondary-button residence-analysis-help" id="residenceAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="residenceAnalysisHelpDialog"><span aria-hidden="true">ⓘ</span> 说明</button>`;
  if (!samples.length) {
    return `
      <header class="analysis-section-head residence-chart-head"><div class="analysis-section-title"><strong>驻留时间分析</strong></div>${helpButton}</header>
      <div class="analysis-empty-state"><strong>暂无驻留数据</strong><span>当前结果中没有完成往返 LoadPort 的晶圆。</span></div>`;
  }

  const systemValues = samples.map(sample => sample.duration);
  const chamberValues = samples.map(sample => sample.chamberDwellSeconds ?? 0);
  const robotValues = samples.map(sample => sample.robotDwellSeconds ?? 0);
  const metricSummary = (values: number[], label: string): string => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    const upperControlLimit = mean + deviation * 2;
    const abnormalCount = values.filter(value => value > upperControlLimit).length;
    return `<span><small>平均</small><b>${formatSeconds(mean)}</b><em>s</em></span><span><small>最大</small><b>${formatSeconds(Math.max(...values))}</b><em>s</em></span><span class="${abnormalCount ? "is-warning" : ""}"><small>偏高比例</small><b>${(abnormalCount / values.length * 100).toFixed(1)}</b><em>%</em></span><span><small>样本</small><b>${values.length}</b><em>片</em></span><span class="visually-hidden">${label}</span>`;
  };
  const summary = (kind: ResidenceMetricKind, content: string): string => (
    `<div class="analysis-compact-stats residence-chart-summary" data-residence-summary="${kind}"${kind === "system" ? "" : " hidden"}>${content}</div>`
  );

  return `
    <header class="analysis-section-head residence-chart-head">
      <div class="analysis-section-title"><strong>驻留时间分析</strong></div>
      <label class="analysis-filter residence-metric-control"><select id="residenceMetricSelect" aria-label="选择驻留时间图表">
        <option value="system">系统驻留时间</option>
        <option value="chamber">腔室驻留时间</option>
        <option value="robot">机器手驻留时间</option>
      </select></label>
      ${summary("system", metricSummary(systemValues, "系统驻留"))}
      ${summary("chamber", metricSummary(chamberValues, "腔室驻留"))}
      ${summary("robot", metricSummary(robotValues, "机器手驻留"))}
      ${helpButton}
    </header>
    <div class="residence-chart-body">
      ${renderResidenceMetricChart(samples, "system")}
      ${renderResidenceMetricChart(samples, "chamber")}
      ${renderResidenceMetricChart(samples, "robot")}
    </div>`;
}

/** 根据用户选择的晶圆数或时间范围裁剪产能点。 */
function filterThroughputPoints(points: ThroughputTimelinePoint[], range: string): ThroughputTimelinePoint[] {
  if (!points.length || range === "all") return points;
  const [kind, rawAmount] = range.split(":");
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return points;
  if (kind === "wafer") return points.slice(-Math.floor(amount));
  if (kind === "time") {
    const cutoff = points[points.length - 1].completedAt - amount;
    const filtered = points.filter(point => point.completedAt >= cutoff);
    return filtered.length ? filtered : points.slice(-1);
  }
  return points;
}

const MAXIMUM_THROUGHPUT_DRAW_POINTS = 72;
const MAXIMUM_THROUGHPUT_VALUE_LABELS = 12;

/** 按区间保留高低点，避免大批量结果生成数百个重叠节点，同时保住曲线尖峰。 */
export function simplifyThroughputPoints(points: ThroughputTimelinePoint[]): ThroughputTimelinePoint[] {
  if (points.length <= MAXIMUM_THROUGHPUT_DRAW_POINTS) return points;
  const interior = points.slice(1, -1);
  const bucketCount = Math.max(1, Math.floor((MAXIMUM_THROUGHPUT_DRAW_POINTS - 2) / 2));
  const selected = [points[0]];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * interior.length / bucketCount);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * interior.length / bucketCount));
    const rows = interior.slice(start, end).map((point, index) => ({ point, index: start + index }));
    const minimum = rows.reduce((best, row) => row.point.throughputPerHour < best.point.throughputPerHour ? row : best);
    const maximum = rows.reduce((best, row) => row.point.throughputPerHour > best.point.throughputPerHour ? row : best);
    [minimum, maximum].sort((left, right) => left.index - right.index).forEach(row => {
      if (selected[selected.length - 1] !== row.point) selected.push(row.point);
    });
  }
  selected.push(points[points.length - 1]);
  return selected;
}

/** 生成自适应坐标轴、参考线、异常点和悬停命中区域。 */
function renderThroughputSvg(
  points: ThroughputTimelinePoint[],
  title: string,
): string {
  const width = 760;
  const height = 174;
  const left = 12;
  const right = 12;
  const top = 12;
  const bottom = 12;
  const usableWidth = width - left - right;
  const usableHeight = height - top - bottom;
  const allValues = points.map(point => Math.max(0, Number(point.throughputPerHour) || 0));
  const mean = allValues.reduce((sum, value) => sum + value, 0) / allValues.length;
  const displayPoints = simplifyThroughputPoints(points);
  const values = displayPoints.map(point => Math.max(0, Number(point.throughputPerHour) || 0));
  const observedMinimum = Math.min(...values);
  const observedMaximum = Math.max(...values);
  const spread = Math.max(observedMaximum - observedMinimum, Math.max(mean * .04, 1));
  const padding = Math.max(1, spread * .18);
  const step = spread > 20 ? 5 : spread > 8 ? 2 : 1;
  const minimum = Math.max(0, Math.floor((observedMinimum - padding) / step) * step);
  const maximum = Math.max(minimum + step * 3, Math.ceil((observedMaximum + padding) / step) * step);
  const yRange = maximum - minimum;
  const firstIndex = displayPoints[0].completedWaferIndex;
  const lastIndex = displayPoints[displayPoints.length - 1].completedWaferIndex;
  const indexRange = Math.max(1, lastIndex - firstIndex);
  const coordinates = displayPoints.map((point, index) => ({
    x: left + (point.completedWaferIndex - firstIndex) / indexRange * usableWidth,
    y: top + (1 - (values[index] - minimum) / yRange) * usableHeight,
  }));
  const linePath = coordinates.length === 1
    ? `M ${coordinates[0].x.toFixed(2)} ${coordinates[0].y.toFixed(2)}`
    : coordinates.reduce((path, point, index) => {
      if (index === 0) return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
      return `${path} L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }, "");
  const latest = displayPoints[displayPoints.length - 1];
  const yForValue = (value: number): number => top + (1 - (value - minimum) / yRange) * usableHeight;
  const meanY = yForValue(mean);
  const labelStride = Math.max(1, Math.ceil(displayPoints.length / MAXIMUM_THROUGHPUT_VALUE_LABELS));
  const pointTargets = displayPoints.map((point, index) => {
    const coordinate = coordinates[index];
    const value = values[index];
    const previousValue = values[index - 1] ?? value;
    const nextValue = values[index + 1] ?? value;
    const isLocalMinimum = index > 0 && index < values.length - 1 && value <= previousValue && value <= nextValue;
    const labelY = isLocalMinimum
      ? Math.min(top + usableHeight - 4, coordinate.y + 17)
      : Math.max(top + 10, coordinate.y - 9);
    const labelClass = isLocalMinimum ? "throughput-chart-value is-below" : "throughput-chart-value";
    const showLabel = index === 0 || index === displayPoints.length - 1 || index % labelStride === 0;
    return `${showLabel ? `<text class="${labelClass}" x="${coordinate.x.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="middle">${value.toFixed(1)}</text>` : ""}<circle class="throughput-chart-point" cx="${coordinate.x.toFixed(2)}" cy="${coordinate.y.toFixed(2)}" r="${displayPoints.length > 36 ? "1.8" : "2.6"}"/>`;
  }).join("");

  return `
        <svg class="throughput-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}，最新为第 ${latest.completedWaferIndex} 片，每小时 ${latest.throughputPerHour.toFixed(1)} 片">
          <g class="throughput-control-lines">
            <line class="throughput-mean-line" x1="${left}" y1="${meanY.toFixed(2)}" x2="${width - right}" y2="${meanY.toFixed(2)}"/>
          </g>
          <path class="throughput-chart-line" d="${linePath}"/>
          ${pointTargets}
          <circle class="throughput-chart-latest" cx="${coordinates[coordinates.length - 1].x.toFixed(2)}" cy="${coordinates[coordinates.length - 1].y.toFixed(2)}" r="4"/>
        </svg>`;
}

/** 将逐片产能点绘制为可切换范围的交互式 SVG 曲线。 */
function renderThroughputLine(
  points: ThroughputTimelinePoint[],
  chartKey: string,
  title: string,
  visible: boolean,
  initialRange = "wafer:30",
): string {
  const serializedPoints = escapeHtml(JSON.stringify(points));
  const visiblePoints = filterThroughputPoints(points, initialRange);
  return `
    <div class="throughput-chart" data-throughput-chart="${chartKey}" data-throughput-title="${escapeHtml(title)}" data-throughput-points="${serializedPoints}"${visible ? "" : " hidden"}>
      <div class="throughput-chart-scroll" tabindex="0" aria-label="${escapeHtml(title)}，逐点展示产能数值">
        <div class="throughput-chart-canvas">${renderThroughputSvg(visiblePoints, title)}</div>
      </div>
    </div>`;
}

/** 在不重新请求分析接口的情况下，按选择范围刷新当前产能图。 */
export function updateThroughputChartRange(chart: HTMLElement, range: string): void {
  const rawPoints = chart.dataset.throughputPoints;
  const chartKey = chart.dataset.throughputChart ?? "throughput";
  const title = chart.dataset.throughputTitle ?? "产能曲线";
  if (!rawPoints) return;
  const points = filterThroughputPoints(JSON.parse(rawPoints) as ThroughputTimelinePoint[], range);
  const canvas = chart.querySelector<HTMLElement>(".throughput-chart-canvas");
  if (!canvas || !points.length) return;
  canvas.innerHTML = renderThroughputSvg(points, title);
}

/** 渲染从仿真零点累计或按用户选择的 2–10 片窗口计算的逐片产能趋势。 */
export function renderThroughputChart(performance: SchedulePerformance): string {
  const timeline = performance.throughputTimeline;
  const helpButton = `<button class="analysis-secondary-button throughput-analysis-help" id="throughputAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="throughputAnalysisHelpDialog"><span aria-hidden="true">ⓘ</span> 说明</button>`;
  if (!timeline?.cumulative?.length) {
    return `
      <header class="analysis-section-head throughput-chart-head"><div class="analysis-section-title"><strong>产能分析</strong></div>${helpButton}</header>
      <div class="analysis-empty-state"><strong>暂无生产数据</strong><span>请等待新的晶圆完成后查看分析结果。</span></div>`;
  }
  const cumulative = timeline.cumulative;
  const minimumWindow = timeline.rollingWindowMinimum;
  const maximumWindow = timeline.rollingWindowMaximum;
  const defaultWindow = Math.min(Math.max(5, minimumWindow), maximumWindow);
  const windowOptions = Array.from(
    { length: maximumWindow - minimumWindow + 1 },
    (_, index) => minimumWindow + index,
  );
  const lastCumulative = cumulative[cumulative.length - 1];
  const summary = (chartKey: string, content: string, visible: boolean): string => (
    `<div class="analysis-compact-stats throughput-chart-summary" data-throughput-summary="${chartKey}"${visible ? "" : " hidden"}>${content}</div>`
  );
  const rollingContent = windowOptions.map(windowSize => {
    const points = timeline.rollingByWindow[String(windowSize)] ?? [];
    const latest = points[points.length - 1];
    const average = points.length
      ? points.reduce((sum, point) => sum + point.throughputPerHour, 0) / points.length
      : 0;
    return summary(
      `rolling-${windowSize}`,
      latest
        ? `<span><small>最新</small><b>${latest.throughputPerHour.toFixed(1)}</b><em>片/h</em></span><span><small>平均</small><b>${average.toFixed(1)}</b><em>片/h</em></span>`
        : `<span class="is-muted"><small>样本状态</small><b>不足</b><em>至少 ${windowSize + 1} 片</em></span>`,
      windowSize === defaultWindow,
    );
  }).join("");
  const rollingCharts = windowOptions.map(windowSize => {
    const points = timeline.rollingByWindow[String(windowSize)] ?? [];
    const chartKey = `rolling-${windowSize}`;
    return points.length
      ? renderThroughputLine(points, chartKey, `${windowSize} 片滑动窗口产能曲线`, windowSize === defaultWindow)
      : `<div class="throughput-chart-empty" data-throughput-chart="${chartKey}" hidden>尚未形成完整 ${windowSize} 片滑动窗口。</div>`;
  }).join("");
  const cumulativeAverage = cumulative.reduce((sum, point) => sum + point.throughputPerHour, 0) / cumulative.length;
  return `
    <header class="analysis-section-head throughput-chart-head">
      <div class="analysis-section-title"><strong>产能分析</strong></div>
      <div class="analysis-filter-group">
      <label class="analysis-filter throughput-metric-control"><select id="throughputMetricSelect" aria-label="选择产能口径">
        <option value="cumulative">累计产能（公司口径）</option>
        <option value="rolling" selected>滑动窗口</option>
      </select></label>
      <label class="analysis-filter throughput-window-control" data-throughput-window-control><select id="throughputWindowSize" aria-label="滑动窗口大小">${windowOptions.map(windowSize => `<option value="${windowSize}"${windowSize === defaultWindow ? " selected" : ""}>${windowSize} 片</option>`).join("")}</select></label>
      <label class="analysis-filter throughput-range-control"><select id="throughputRangeSelect" aria-label="选择产能图显示范围"><option value="wafer:30" selected>最近 30 片</option><option value="wafer:60">最近 60 片</option><option value="wafer:120">最近 120 片</option><option value="time:600">最近 10 分钟</option><option value="time:1800">最近 30 分钟</option><option value="all">全部</option></select></label>
      </div>
      ${summary("cumulative", `<span><small>最新</small><b>${lastCumulative.throughputPerHour.toFixed(1)}</b><em>片/h</em></span><span><small>平均</small><b>${cumulativeAverage.toFixed(1)}</b><em>片/h</em></span><span><small>时刻</small><b>${formatSeconds(lastCumulative.completedAt)}</b><em>s</em></span>`, false)}
      ${rollingContent}
      ${helpButton}
    </header>
    <div class="throughput-chart-body">
      <div class="analysis-chart-legend" aria-label="产能图图例"><span><i class="legend-current"></i>当前产能</span><span><i class="legend-average"></i>显示范围平均</span></div>
      ${renderThroughputLine(cumulative, "cumulative", "累计产能曲线", false)}
      ${rollingCharts}
    </div>`;
}

/** 绘制排程诊断面板 —— 总览、逐片驻留与瓶颈分析。 */
export function renderSchedulePerformance(performance: SchedulePerformance): string {
  // 兼容缓存的旧分析响应：服务端升级前的结果没有这个字段，也应能打开结果页。
  const loadLockEfficiency = performance.loadLockEfficiency ?? {
    cycleCount: 0,
    waferCycleCount: 0,
    wafersPerCycle: 0,
    fullLoadCycleCount: 0,
    emptyLoadCycleCount: 0,
    fullLoadCycleRatio: 0,
    emptyLoadCycleRatio: 0,
  };
  const kpiCard = (
    label: string,
    value: string,
    unit: string,
    detail: string,
    cardClass = "",
  ): string => `
    <article class="performance-kpi-card ${cardClass}">
      <div class="performance-kpi-label">
        <span>${label}</span>
        <span class="performance-kpi-help" tabindex="0" aria-label="${escapeHtml(detail)}">
          <i aria-hidden="true">i</i><span class="performance-kpi-tooltip" role="tooltip">${detail}</span>
        </span>
      </div>
      <div class="performance-kpi-value"><strong>${value}</strong>${unit ? `<small>${unit}</small>` : ""}</div>
    </article>`;
  const primaryBottleneck = performance.primaryBottleneck;
  const bottleneckUtilization = primaryBottleneck?.utilization ?? performance.bottleneck?.utilization ?? null;
  const bottleneckDetail = bottleneckUtilization !== null
    ? "当前统计窗口内最高的资源利用率"
    : "当前统计窗口内未形成明确瓶颈";
  return `
    <section class="result-card overview-card">
      <div class="performance-summary">
        ${kpiCard("产能", performance.throughputPerHour > 0 ? performance.throughputPerHour.toFixed(1) : "—", performance.throughputPerHour > 0 ? "片/h" : "", performance.throughputSampleCount ? `居中 ${performance.throughputSampleCount} 片稳态样本` : escapeHtml(performance.throughputReason || "样本不足，完工片数必须大于 150"), "is-primary")}
        ${kpiCard("平均重算时间", Number.isFinite(performance.averageRecomputeTimeMs) ? Number(performance.averageRecomputeTimeMs).toFixed(1) : "—", Number.isFinite(performance.averageRecomputeTimeMs) ? "ms" : "", performance.recomputeCount ? `CPU Time / ${performance.recomputeCount} 次重算` : "没有重算轮次")}
        ${kpiCard("瓶颈利用率", bottleneckUtilization !== null ? formatPercent(bottleneckUtilization) : "—", "", bottleneckDetail)}
        ${kpiCard("LoadLock 利用效率", loadLockEfficiency.cycleCount ? loadLockEfficiency.wafersPerCycle.toFixed(2) : "—", loadLockEfficiency.cycleCount ? "片/周期" : "", loadLockEfficiency.cycleCount ? `${loadLockEfficiency.cycleCount} 个完整周期 · 满载 ${formatPercent(loadLockEfficiency.fullLoadCycleRatio)} · 空载 ${formatPercent(loadLockEfficiency.emptyLoadCycleRatio)}` : "没有完整的抽气—充气周期")}
      </div>
    </section>

    <section class="result-card throughput-analysis-card">
      ${renderThroughputChart(performance)}
    </section>

    <section class="result-card bottleneck-analysis-card">
      ${renderBottleneckAnalysis(performance)}
    </section>

    <section class="result-card wafer-residence-card">
      ${renderWaferResidenceChart(performance)}
    </section>

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
  private loadPortReplenishments: LoadPortReplenishment[] = [];
  private replayPlan: Record<string, any> | null = null;
  private actionStatusFilters: ActionDiagnosticStatus[] = [...ALL_ACTION_DIAGNOSTIC_STATUSES];
  private liveDecision: DecisionTraceStep | null = null;
  private liveDecisionKey = "";
  private primitiveDecisionBoundaries: number[] = [];
  private readonly replayDecisionCache = new Map<string, DecisionTraceStep>();
  private readonly pendingReplayDecisionKeys = new Set<string>();
  private replayDecisionErrorKey = "";
  private replayDecisionErrorMessage = "";
  private replayDecisionRequestVersion = 0;
  private sourceName = "";
  private resultUrl = "";
  private analysisResultId = "";
  private analysis: SchedulePerformance | null = null;
  private cpuTimeMs: number | null = null;
  private recomputeCount = 0;
  private bottleneckSummary: BottleneckUtilizationSummary | null = null;
  private analysisRequestVersion = 0;
  private time = 0;
  private playing = false;
  private liveSolving = false;
  private playbackSpeed = DEFAULT_PLAYBACK_SPEED;
  private performanceWindowMode: PerformanceWindowMode = "steady";
  private animationFrame = 0;
  private previousFrameTime = 0;
  private previousRenderTime = 0;
  /** 绑定页面事件并初始化空状态。 */
  constructor(root: Document) {
    this.root = root;
    this.elements = collectElements(root);
    const selectedFilters = this.elements.actionStatusFilters
      .filter(item => item.checked)
      .map(item => item.value as ActionDiagnosticStatus);
    if (selectedFilters.length) this.actionStatusFilters = selectedFilters;
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
    const metadata = payload && typeof payload === "object" && !Array.isArray(payload)
      ? ((payload as UnknownRecord).RunMetricsMetadata ?? (payload as UnknownRecord).ProductionMetricsMetadata)
      : null;
    const rawCpuTimeMs = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? Number((metadata as UnknownRecord).cpuTimeMs ?? Number((metadata as UnknownRecord).calculationSeconds) * 1000)
      : Number.NaN;
    const recomputePoints = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as UnknownRecord).RecomputePoints
      : null;
    const metadataRecomputeCount = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? Number((metadata as UnknownRecord).recomputeCount)
      : Number.NaN;
    const rawRecomputeCount = Number.isFinite(metadataRecomputeCount)
      ? metadataRecomputeCount
      // 旧结果仅有 RecomputePoints；它不包含首轮算法 update。
      : Array.isArray(recomputePoints) && Number.isFinite(rawCpuTimeMs)
        ? recomputePoints.length + 1
        : 0;
    await this.loadMoves(
      normalizeMovePayload(payload),
      normalizeDecisionTrace(payload),
      normalizeLoadPortReplenishments(payload),
      file.name,
      "",
      "",
      Number.isFinite(rawCpuTimeMs) ? Math.max(rawCpuTimeMs, 0) : null,
      Number.isFinite(rawRecomputeCount) ? Math.max(0, Math.trunc(rawRecomputeCount)) : 0,
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
        normalizeLoadPortReplenishments(payload),
        sourceName,
        resultUrl,
        resultId,
        null,
        0,
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
    this.replayDecisionErrorKey = "";
    this.replayDecisionErrorMessage = "";
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(this.moves);
    this.replayDecisionRequestVersion += 1;
    if (this.elements.exportDiagnosticButton) {
      this.elements.exportDiagnosticButton.disabled = !this.replayPlan || !this.moves.length;
    }
    if (this.moves.length) this.render();
  }

  /** 在完整 MoveList 返回前显示初始拓扑，并进入增量求解状态。 */
  beginLiveSolve(
    plan: Record<string, any>,
    sourceName = "Search Tree 实时求解",
  ): void {
    this.pause();
    this.liveSolving = true;
    this.moves = [];
    this.loadPortReplenishments = [];
    this.loadPortReplenishments = [];
    this.sourceName = sourceName;
    this.resultUrl = "";
    this.analysisResultId = "";
    this.analysis = null;
    this.cpuTimeMs = null;
    this.recomputeCount = 0;
    this.bottleneckSummary = null;
    this.time = 0;
    this.setReplayPlan(plan);
    this.elements.range.min = "0";
    this.elements.range.max = "0";
    this.elements.range.value = "0";
    this.elements.range.disabled = true;
    this.elements.playButton.disabled = true;
    this.elements.openGantt.href = "#";
    this.elements.openGantt.setAttribute("aria-disabled", "true");
    if (this.elements.exportDiagnosticButton) this.elements.exportDiagnosticButton.disabled = true;
    this.showSingleResult();
    this.setTopologyVisible(true);
    this.render(buildWorkspaceSnapshot([], this.device, 0));
  }

  /** 用已提交根动作产生的累计 MoveList 推进实时拓扑。 */
  updateLiveMoves(
    rawMoves: unknown[],
    followLatest = true,
    animateToLatest = false,
  ): void {
    if (!this.liveSolving || !rawMoves.length) return;
    const previousTime = this.time;
    this.pause();
    this.moves = normalizeMovePayload({ MoveList: rawMoves });
    if (this.elements.exportDiagnosticButton) {
      this.elements.exportDiagnosticButton.disabled = !this.replayPlan;
    }
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(this.moves);
    const latestSnapshot = buildWorkspaceSnapshot(
      this.moves,
      this.device,
      Number.POSITIVE_INFINITY,
    );
    this.elements.range.max = String(latestSnapshot.endTime);
    this.elements.range.step = latestSnapshot.endTime > 10000 ? "1" : "0.1";
    if (
      animateToLatest
      && followLatest
      && latestSnapshot.endTime > previousTime + PERFORMANCE_DISPLAY_TOLERANCE
    ) {
      this.time = Math.max(0, Math.min(previousTime, latestSnapshot.endTime));
      this.elements.range.value = String(this.time);
      this.render(buildWorkspaceSnapshot(this.moves, this.device, this.time));
      this.play();
      return;
    }
    this.time = followLatest
      ? latestSnapshot.endTime
      : Math.min(this.time, latestSnapshot.endTime);
    this.render(buildWorkspaceSnapshot(this.moves, this.device, this.time));
  }

  /** 把拓扑回放定位到某个根决策已经提交后的时刻。 */
  seekTo(time: number): void {
    if (!this.moves.length) return;
    const bounded = Math.max(
      0,
      Math.min(finiteNumber(time), finiteNumber(this.elements.range.max)),
    );
    this.time = bounded;
    this.elements.range.value = String(bounded);
    this.render();
  }

  /** 切换到独立拓扑回放标签。 */
  showPlayback(): void {
    const tab = this.root.querySelector<HTMLElement>('[data-tab-target="playback"]');
    tab?.click();
  }

  /** 返回与诊断面板一致的稳态瓶颈候选利用率，供运行结果摘要复用。 */
  getBottleneckUtilization(): BottleneckUtilizationSummary | null {
    return this.bottleneckSummary ? structuredClone(this.bottleneckSummary) : null;
  }

  /** 返回当前 MoveList 在前端回放终点识别出的持片满腔死锁。 */
  getTerminalDeadlock(): PlaybackDeadlock | null {
    return detectTerminalPlaybackDeadlock(this.moves, this.device, this.replayPlan);
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
    this.liveSolving = false;
    this.moves = [];
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.primitiveDecisionBoundaries = [];
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionErrorKey = "";
    this.replayDecisionErrorMessage = "";
    this.replayDecisionRequestVersion += 1;
    this.sourceName = "";
    this.resultUrl = "";
    this.analysisResultId = "";
    this.analysis = null;
    this.cpuTimeMs = null;
    this.recomputeCount = 0;
    this.bottleneckSummary = null;
    this.analysisRequestVersion += 1;
    this.time = 0;
    this.elements.resultButton.disabled = true;
    this.elements.range.disabled = false;
    this.elements.playButton.disabled = false;
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
    _decisionTrace: DecisionTraceStep[],
    loadPortReplenishments: LoadPortReplenishment[],
    sourceName: string,
    resultUrl: string,
    analysisResultId: string,
    cpuTimeMs: number | null = null,
    recomputeCount = 0,
  ): Promise<void> {
    if (!moves.length) throw new Error("MoveList 为空，无法建立可视化回放");
    this.pause();
    this.liveSolving = false;
    this.moves = moves;
    this.loadPortReplenishments = loadPortReplenishments;
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(moves);
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionErrorKey = "";
    this.replayDecisionErrorMessage = "";
    this.replayDecisionRequestVersion += 1;
    this.sourceName = sourceName;
    this.resultUrl = resultUrl;
    this.analysisResultId = analysisResultId;
    this.analysis = null;
    this.cpuTimeMs = cpuTimeMs;
    this.recomputeCount = recomputeCount;
    this.bottleneckSummary = null;
    const snapshot = buildWorkspaceSnapshot(this.moves, this.device, 0, this.loadPortReplenishments);
    this.time = 0;
    this.elements.range.min = "0";
    this.elements.range.max = String(snapshot.endTime);
    this.elements.range.step = snapshot.endTime > 10000 ? "1" : "0.1";
    this.elements.range.value = "0";
    this.elements.range.disabled = false;
    this.elements.playButton.disabled = false;
    this.elements.openGantt.href = resultUrl
      ? `/movelist_gantt_viewer.html?src=${encodeURIComponent(resultUrl)}`
      : "#";
    this.elements.openGantt.setAttribute("aria-disabled", resultUrl ? "false" : "true");
    if (this.elements.exportDiagnosticButton) {
      this.elements.exportDiagnosticButton.disabled = !this.replayPlan;
    }
    this.elements.resultButton.disabled = false;
    this.showSingleResult();
    this.setTopologyVisible(true);
    this.render(snapshot);
    await this.renderPerformance();
  }

  /** 绑定文件、时间轴、播放和快捷控制事件。 */
  private bindEvents(): void {
    this.elements.importButton?.addEventListener("click", () => this.elements.fileInput.click());
    this.elements.exportDiagnosticButton?.addEventListener("click", () => {
      void this.exportDeadlockDiagnostic();
    });
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
    this.elements.actionStatusFilters.forEach(filter => filter.addEventListener("change", () => {
      this.actionStatusFilters = this.elements.actionStatusFilters
        .filter(item => item.checked)
        .map(item => item.value as ActionDiagnosticStatus);
      this.render();
    }));
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

  /** 导出当前回放帧及算法候选动作，供离线复现死锁。 */
  private async exportDeadlockDiagnostic(): Promise<void> {
    if (!this.moves.length || !this.replayPlan) {
      this.showError("当前 MoveList 缺少完整计划，无法重建 Machine 诊断上下文");
      return;
    }
    const button = this.elements.exportDiagnosticButton;
    if (button) button.disabled = true;
    try {
      const snapshot = buildWorkspaceSnapshot(
        this.moves,
        this.device,
        this.time,
        this.loadPortReplenishments,
      );
      const result = await requestDeadlockDiagnostic({
        resultId: this.analysisResultId || undefined,
        moves: this.analysisResultId ? undefined : this.moves,
        plan: this.analysisResultId ? undefined : this.replayPlan,
        time: this.time,
        snapshot: snapshot as unknown as Record<string, any>,
      });
      const downloadUrl = URL.createObjectURL(result.blob);
      const link = this.root.createElement("a");
      link.href = downloadUrl;
      link.download = result.fileName;
      link.click();
      URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (button) button.disabled = false;
    }
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
    const advancedTime = Math.min(endTime, this.time + elapsedSeconds * this.playbackSpeed);
    this.time = advancedTime;
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
    if (!this.moves.length && !this.liveSolving) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(
      this.moves,
      this.device,
      this.time,
      this.loadPortReplenishments,
    );
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.source.title = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds(snapshot.endTime);
    this.elements.progressText.textContent = snapshot.endTime > 0
      ? `${Math.round(snapshot.time / snapshot.endTime * 100)}%`
      : "0%";
    this.elements.moveText.textContent = `${snapshot.completedMoves} / ${snapshot.totalMoves}`;
    this.elements.waferText.textContent = String(snapshot.waferCount);
    this.elements.range.value = String(snapshot.time);

    const replayTime = this.replayDecisionTime(snapshot.time);
    const replayKey = this.replayStateKey(replayTime);
    const cachedDecision = this.replayDecisionCache.get(replayKey) ?? null;
    if (cachedDecision) {
      this.liveDecision = cachedDecision;
      this.liveDecisionKey = replayKey;
    }
    const currentDecision = cachedDecision
      ?? (this.liveDecisionKey === replayKey ? this.liveDecision : null);
    if (
      this.replayPlan
      && !this.liveSolving
      && !cachedDecision
      && this.liveDecisionKey !== replayKey
      && !this.pendingReplayDecisionKeys.has(replayKey)
      && this.replayDecisionErrorKey !== replayKey
    ) {
      void this.refreshReplayDecision(replayKey, replayTime);
    }
    const topologySnapshot = snapshotWithFullDeviceModules(
      snapshotWithCandidateModules(snapshot, currentDecision, this.device),
      this.device,
    );
    this.elements.stage.innerHTML = renderEquipmentTopology(
      topologySnapshot,
      currentDecision,
      undefined,
      this.device,
    );
    const topologyCanvas = this.elements.stage.querySelector<HTMLElement>(".reference-grid-canvas");
    const canvasHeight = topologyCanvas?.style.getPropertyValue("--topology-canvas-height") ?? "";
    this.elements.frontSlotOverview.style.setProperty("--topology-canvas-height", canvasHeight);
    this.elements.frontSlotOverview.innerHTML = renderFrontSlotOverview(
      topologySnapshot.modules,
      topologySnapshot.waferOrigins,
    );
    const requestState = this.pendingReplayDecisionKeys.has(replayKey)
      ? "loading"
      : this.replayDecisionErrorKey === replayKey ? "error" : "idle";
    this.elements.decisionLens.innerHTML = renderDecisionLens(
      currentDecision,
      requestState,
      this.replayDecisionErrorMessage,
      this.actionStatusFilters,
    );

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

  /** 返回不晚于当前时刻的最近原子动作边界。 */
  private replayDecisionTime(time: number): number {
    let decisionTime = 0;
    for (const boundary of this.currentDecisionBoundaries()) {
      if (boundary > time + PERFORMANCE_DISPLAY_TOLERANCE) break;
      decisionTime = boundary;
    }
    return decisionTime;
  }

  /** 动作接口在每个 Pick、Place、Swap 完成边界更新。 */
  private currentDecisionBoundaries(): number[] {
    return this.primitiveDecisionBoundaries;
  }

  /** 每个原子动作边界只请求一次算法接口。 */
  private replayStateKey(replayTime: number): string {
    return `actions@${replayTime.toFixed(6)}`;
  }

  /** 异步请求当前 Machine 候选；过期响应不会覆盖用户已经拖到的新时刻。 */
  private async refreshReplayDecision(replayKey: string, replayTime: number): Promise<void> {
    const requestVersion = ++this.replayDecisionRequestVersion;
    this.pendingReplayDecisionKeys.add(replayKey);
    if (this.replayDecisionErrorKey === replayKey) {
      this.replayDecisionErrorKey = "";
      this.replayDecisionErrorMessage = "";
    }
    let renderFailure = false;
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
      const currentReplayTime = this.replayDecisionTime(this.time);
      if (this.replayStateKey(currentReplayTime) !== replayKey) return;
      this.liveDecision = decision;
      this.liveDecisionKey = replayKey;
      this.render();
    } catch (error) {
      if (requestVersion === this.replayDecisionRequestVersion) {
        this.replayDecisionErrorKey = replayKey;
        this.replayDecisionErrorMessage = error instanceof Error
          ? error.message
          : String(error);
        renderFailure = true;
      }
    } finally {
      this.pendingReplayDecisionKeys.delete(replayKey);
      if (
        renderFailure
        && this.replayStateKey(this.replayDecisionTime(this.time)) === replayKey
      ) {
        this.render();
      }
    }
  }

  /** 请求并绘制与播放时刻无关的服务端排程性能诊断。 */
  private async renderPerformance(): Promise<void> {
    if (!this.moves.length) return;
    const requestVersion = ++this.analysisRequestVersion;
    this.elements.performance.innerHTML = `
      <section class="result-card analysis-skeleton" aria-label="正在加载结果分析">
        <div class="analysis-skeleton-head"><i></i><span></span></div>
        <div class="analysis-skeleton-grid">${Array.from({ length: 6 }, () => "<span></span>").join("")}</div>
      </section>`;
    try {
      const result = await requestScheduleAnalysis({
        ...(this.analysisResultId
          ? { resultId: this.analysisResultId }
          : { moves: this.moves }),
        device: this.device,
        windowMode: this.performanceWindowMode,
        routes: this.analysisRoutes,
        rounds: this.analysisRounds,
        cpuTimeMs: this.analysisResultId ? undefined : this.cpuTimeMs,
        recomputeCount: this.analysisResultId ? undefined : this.recomputeCount,
      });
      if (requestVersion !== this.analysisRequestVersion) return;
      const analysis = result.analysis;
      this.analysis = analysis;
      this.bottleneckSummary = result.bottleneck;
      this.elements.performance.innerHTML = renderSchedulePerformance(analysis);
      const windowSlot = this.elements.performance.querySelector(".bottleneck-window-slot");
      if (windowSlot) {
        this.elements.performanceWindow.tabIndex = 0;
        windowSlot.append(this.elements.performanceWindow);
      }
      this.elements.performance.querySelectorAll<HTMLElement>(".residence-metric-scroll").forEach(scroller => {
        scroller.scrollLeft = scroller.scrollWidth;
      });
    } catch (error) {
      if (requestVersion !== this.analysisRequestVersion) return;
      this.analysis = null;
      this.bottleneckSummary = null;
      this.elements.performance.innerHTML = `
        <div class="analysis-error-state">
          <strong>数据获取失败</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span>
          <button class="analysis-secondary-button" type="button" data-performance-retry>重新加载</button>
        </div>`;
      this.elements.performance.querySelector<HTMLButtonElement>("[data-performance-retry]")?.addEventListener("click", () => {
        void this.renderPerformance();
      });
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
