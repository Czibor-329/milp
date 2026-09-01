var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/workspace_visualizer_test_entry.ts
var workspace_visualizer_test_entry_exports = {};
__export(workspace_visualizer_test_entry_exports, {
  alignOriginalDecisionTraceToMoves: () => alignOriginalDecisionTraceToMoves,
  buildWorkspaceSnapshot: () => buildWorkspaceSnapshot,
  createVisualizationWorkspace: () => createVisualizationWorkspace,
  decisionAtTime: () => decisionAtTime,
  decisionBoundaryTimes: () => decisionBoundaryTimes,
  decisionSpaceSignature: () => decisionSpaceSignature,
  detectDeviceTopologyLayout: () => detectDeviceTopologyLayout,
  detectTerminalPlaybackDeadlock: () => detectTerminalPlaybackDeadlock,
  detectTopologyLayout: () => detectTopologyLayout,
  groupedBottleneckResources: () => groupedBottleneckResources,
  normalizeDecisionTrace: () => normalizeDecisionTrace,
  normalizeMovePayload: () => normalizeMovePayload,
  primitiveDecisionBoundaryTimes: () => primitiveDecisionBoundaryTimes,
  renderEquipmentTopology: () => renderEquipmentTopology,
  renderSchedulePerformance: () => renderSchedulePerformance,
  renderWaferResidenceChart: () => renderWaferResidenceChart,
  snapshotWithFullDeviceModules: () => snapshotWithFullDeviceModules
});
module.exports = __toCommonJS(workspace_visualizer_test_entry_exports);

// src/api_client.ts
async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  }
  return result;
}
async function requestScheduleAnalysis(input) {
  const result = await requestJson("/api/analysis/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return {
    analysis: result.analysis,
    bottleneck: result.bottleneck ?? null
  };
}
async function requestReplayDecision(input) {
  const result = await requestJson("/api/analysis/replay-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return result.decision;
}

// src/workspace_visualizer.ts
var PICK_MOVE_TYPES = /* @__PURE__ */ new Set([0, 2]);
var PLACE_MOVE_TYPES = /* @__PURE__ */ new Set([1, 3]);
var SWAP_MOVE = 4;
var DECISION_COMPLETION_MOVE_TYPES = /* @__PURE__ */ new Set([...PLACE_MOVE_TYPES, SWAP_MOVE]);
var PRIMITIVE_DECISION_COMPLETION_MOVE_TYPES = /* @__PURE__ */ new Set([
  ...PICK_MOVE_TYPES,
  ...PLACE_MOVE_TYPES,
  SWAP_MOVE
]);
var PRE_TRANS_MOVE = 5;
var PREPARE_MOVE = 6;
var COMPLETE_MOVE = 7;
var PROCESS_MOVE = 9;
var PRE_PREPARE_MOVE = 10;
var PUMP_MOVE = 12;
var VENT_MOVE = 13;
var CLEAN_MOVE = 14;
var LOADLOCK_ENVIRONMENT_MOVE_TYPES = /* @__PURE__ */ new Set([PRE_PREPARE_MOVE, PUMP_MOVE, VENT_MOVE]);
var PLAYBACK_FRAME_INTERVAL_MS = 40;
var DOOR_VISUAL_MIN_SECONDS = 0.7;
var DEFAULT_PLAYBACK_SPEED = 4;
var PERFORMANCE_DISPLAY_TOLERANCE = 1e-6;
var DEFAULT_LOAD_PORT_CAPACITY = 25;
var ACTIVITY_CATEGORIES = [
  "process",
  "clean",
  "door",
  "transfer",
  "environment",
  "other"
];
var ACTIVITY_CATEGORY_LABELS = {
  process: "\u52A0\u5DE5",
  clean: "\u6E05\u6D01",
  door: "\u5F00\u5173\u95E8",
  transfer: "\u53D6\u653E / \u642C\u8FD0",
  environment: "\u62BD\u5145\u6C14",
  other: "\u5176\u4ED6"
};
var MOVE_NAMES = {
  0: "\u53D6\u7247",
  1: "\u653E\u7247",
  2: "\u591A\u7247\u53D6\u7247",
  3: "\u591A\u7247\u653E\u7247",
  4: "\u6362\u7247",
  5: "\u673A\u68B0\u624B\u8F6C\u4F4D",
  6: "\u5F00\u95E8",
  7: "\u5173\u95E8",
  8: "\u540E\u7F6E\u5B8C\u6210",
  9: "\u52A0\u5DE5",
  10: "\u73AF\u5883\u5207\u6362",
  11: "\u5BF9\u51C6",
  12: "\u62BD\u771F\u7A7A",
  13: "\u5145\u6C14",
  14: "\u6E05\u6D01"
};
var STATUS_LABELS = {
  idle: "\u7A7A\u95F2",
  occupied: "\u5DF2\u8F7D\u7247",
  door: "\u95E8\u52A8\u4F5C",
  transfer: "\u4F20\u8F93\u4E2D",
  processing: "\u52A0\u5DE5\u4E2D",
  cleaning: "\u6E05\u6D01\u4E2D",
  environment: "\u73AF\u5883\u5207\u6362"
};
var DOOR_LABELS = {
  closed: "\u95E8\u5DF2\u5173\u95ED",
  opening: "\u6B63\u5728\u5F00\u95E8",
  open: "\u95E8\u5DF2\u6253\u5F00",
  closing: "\u6B63\u5728\u5173\u95E8",
  doorless: "\u65E0\u95E8\u7ED3\u6784"
};
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function nullableFiniteNumber(value) {
  if (value === null || value === void 0 || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function listValue(value) {
  return Array.isArray(value) ? value : [];
}
function normalizeMovePayload(payload) {
  const records = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray(payload.MoveList) ? payload.MoveList : null;
  if (!records) throw new Error("\u6587\u4EF6\u5FC5\u987B\u662F MoveList \u6570\u7EC4\uFF0C\u6216\u5305\u542B MoveList \u5B57\u6BB5\u7684 JSON \u5BF9\u8C61");
  return records.filter((record) => Boolean(record) && typeof record === "object" && !Array.isArray(record)).map((record) => ({ ...record }));
}
function normalizeDecisionCandidate(candidate, actor = "") {
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
    makespanDelta: nullableFiniteNumber(candidate.makespanDelta)
  };
}
function normalizeDecisionTrace(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload;
  const rawTrace = record.DecisionTrace;
  if (!Array.isArray(rawTrace)) return [];
  const traceMeta = record.DecisionTraceMeta;
  const meta = traceMeta && typeof traceMeta === "object" && !Array.isArray(traceMeta) ? traceMeta : {};
  return rawTrace.filter((step) => Boolean(step) && typeof step === "object" && !Array.isArray(step)).map((step) => {
    const modelSignature = `${String(step.model ?? "")} ${String(meta.schema ?? "")} ${String(meta.model ?? "")}`.toLowerCase();
    const model = modelSignature.includes("dual-actor") || modelSignature.includes("\u53CC actor") ? "dual-actor-e2e" : "e2e-ctq";
    const rawCandidates = Array.isArray(step.candidates) ? step.candidates : model === "dual-actor-e2e" && Array.isArray(step.proposals) ? step.proposals : [];
    let candidates = rawCandidates.filter((candidate) => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)).map((candidate) => normalizeDecisionCandidate(candidate)).sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference);
    const rawGroups = Array.isArray(step.candidateGroups) ? step.candidateGroups : [];
    let candidateGroups = rawGroups.filter((group) => Boolean(group) && typeof group === "object" && !Array.isArray(group)).map((group) => {
      const actor = String(group.actor ?? "");
      const groupCandidates = listValue(group.candidates).filter((candidate) => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)).map((candidate) => normalizeDecisionCandidate(candidate, actor)).sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference).map((candidate, index, rows) => ({
        ...candidate,
        rank: candidate.rank || index + 1,
        policyPreference: rows.length === 1 && candidate.policyPreference === 0 ? 1 : candidate.policyPreference
      }));
      return {
        actor,
        label: String(group.label ?? (actor === "atmosphere" ? "\u5927\u6C14\u7AEF Actor" : "\u771F\u7A7A\u7AEF Actor")),
        selectedActionId: String(group.selectedActionId ?? ""),
        executedActionId: String(group.executedActionId ?? ""),
        candidateCount: Math.max(groupCandidates.length, finiteNumber(group.candidateCount, groupCandidates.length)),
        shownCandidateCount: Math.max(groupCandidates.length, finiteNumber(group.shownCandidateCount, groupCandidates.length)),
        candidatesTruncated: Boolean(group.candidatesTruncated),
        candidates: groupCandidates
      };
    });
    if (model === "dual-actor-e2e" && !candidateGroups.length && candidates.length) {
      candidateGroups = ["atmosphere", "vacuum"].map((actor) => {
        const groupCandidates = candidates.filter((candidate) => candidate.actor === actor).map((candidate, index, rows) => ({
          ...candidate,
          rank: candidate.rank || index + 1,
          policyPreference: rows.length === 1 && candidate.policyPreference === 0 ? 1 : candidate.policyPreference
        }));
        return {
          actor,
          label: actor === "atmosphere" ? "\u5927\u6C14\u7AEF Actor" : "\u771F\u7A7A\u7AEF Actor",
          selectedActionId: groupCandidates.find((candidate) => candidate.selected)?.actionId ?? "",
          executedActionId: groupCandidates.find((candidate) => candidate.executed)?.actionId ?? "",
          candidateCount: groupCandidates.length,
          shownCandidateCount: groupCandidates.length,
          candidatesTruncated: false,
          candidates: groupCandidates
        };
      }).filter((group) => group.candidates.length);
    }
    if (candidateGroups.length) candidates = candidateGroups.flatMap((group) => group.candidates);
    return {
      model,
      modelLabel: String(step.modelLabel ?? (model === "dual-actor-e2e" ? "\u53CC Actor \u539F\u5B50\u8C03\u5EA6" : "E2E-CTQ")),
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
      candidateGroups
    };
  }).sort((left, right) => left.time - right.time || left.decisionIndex - right.decisionIndex);
}
function primitiveMoveKind(move) {
  const moveType = finiteNumber(move.MoveType, -1);
  if (PICK_MOVE_TYPES.has(moveType)) return "pick";
  if (PLACE_MOVE_TYPES.has(moveType)) return "place";
  if (moveType === SWAP_MOVE) return "swap";
  return "";
}
function moveStringList(move, field) {
  return listValue(move[field]).map(String);
}
function candidateMatchesPrimitiveMove(candidate, move) {
  if (candidate.kind !== primitiveMoveKind(move)) return false;
  const robot = String(move.Robot ?? move.ModuleName ?? "");
  if (candidate.robot && candidate.robot !== robot) return false;
  const moveMaterials = moveStringList(move, "MatIDList");
  if (candidate.kind === "swap") {
    const exchangedMaterials = /* @__PURE__ */ new Set([
      ...moveMaterials,
      ...moveStringList(move, "SentMatList"),
      ...moveStringList(move, "RecvMatList")
    ]);
    if (!candidate.materialIds.every((material) => exchangedMaterials.has(material))) {
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
function alignOriginalDecisionTraceToMoves(trace, moves) {
  const primitiveMoves = moves.filter((move) => Boolean(primitiveMoveKind(move))).sort((left, right) => finiteNumber(left.StartTime) - finiteNumber(right.StartTime) || finiteNumber(left.MoveID) - finiteNumber(right.MoveID));
  const usedMoveIds = /* @__PURE__ */ new Set();
  const aligned = trace.map((step) => {
    if (step.model !== "dual-actor-e2e") return step;
    const selectedCandidate = step.candidates.find((candidate) => candidate.actionId === step.selectedActionId || candidate.selected);
    if (!selectedCandidate) return step;
    const matchedMove = primitiveMoves.find((move) => {
      const moveId = finiteNumber(move.MoveID, -1);
      return !usedMoveIds.has(moveId) && candidateMatchesPrimitiveMove(selectedCandidate, move);
    });
    if (!matchedMove) return step;
    usedMoveIds.add(finiteNumber(matchedMove.MoveID, -1));
    const executedActionId = selectedCandidate.actionId;
    const candidateGroups = step.candidateGroups.map((group) => {
      const containsExecuted = group.candidates.some((candidate) => candidate.actionId === executedActionId);
      return {
        ...group,
        executedActionId: containsExecuted ? executedActionId : group.executedActionId,
        candidates: group.candidates.map((candidate) => ({
          ...candidate,
          executed: candidate.actionId === executedActionId
        }))
      };
    });
    const candidates = candidateGroups.length ? candidateGroups.flatMap((group) => group.candidates) : step.candidates.map((candidate) => ({
      ...candidate,
      executed: candidate.actionId === executedActionId
    }));
    return {
      ...step,
      time: finiteNumber(matchedMove.StartTime),
      executedActionId,
      modelEvaluated: true,
      replayEvaluated: false,
      candidates,
      candidateGroups
    };
  });
  return aligned.sort((left, right) => left.time - right.time || left.decisionIndex - right.decisionIndex);
}
function decisionAtTime(trace, time) {
  let selected = null;
  for (const step of trace) {
    if (step.time > time + PERFORMANCE_DISPLAY_TOLERANCE) break;
    selected = step;
  }
  return selected ?? trace[0] ?? null;
}
function naturalCompare(left, right) {
  return left.localeCompare(right, void 0, { numeric: true, sensitivity: "base" });
}
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatSeconds(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}
function materialIds(move, field = "MatIDList") {
  return listValue(move[field]).map(String).filter(Boolean);
}
function isCleaningMove(move) {
  if (move.MoveType === CLEAN_MOVE) return true;
  if (move.MoveType !== PROCESS_MOVE) return false;
  const materialList = move.MatIDList;
  const explicitlyEmpty = Array.isArray(materialList) && materialList.length === 0;
  const cleanMetadata = [move.CleanRecipe, move.CleanTaskName, move.RecipeName, move.ProcessRecipe].some((value) => /clean|wac|dummy/i.test(String(value ?? "")));
  return explicitlyEmpty || cleanMetadata;
}
function firstStation(move, field) {
  return String(listValue(move[field])[0] ?? "");
}
function isRobotName(name, configuredRobotNames) {
  return Boolean(configuredRobotNames?.has(name)) || /^(ATR|VTR|ATM|VTM|VAC|TM\d*|ROBOT)/i.test(name);
}
function robotEnvironment(name, definition = {}) {
  const type = String(definition.Type ?? "");
  if (/ATM|ATR|大气/i.test(type) || /^(ATR|ATM)/i.test(name)) return "atmosphere";
  return "vacuum";
}
function robotCapacity(definition, holdingCount = 0) {
  const declaredCapacity = finiteNumber(definition.Capacity, 0);
  const armSlotCount = Object.values(definition.ArmInfo ?? {}).reduce((maximum, arm) => {
    if (!arm || typeof arm !== "object") return maximum;
    return Math.max(maximum, listValue(arm.SlotIDs).length);
  }, 0);
  return Math.max(1, declaredCapacity, armSlotCount, holdingCount);
}
function isDummyPortName(name) {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}
function isBufferModule(name, type = "") {
  return type.trim().toLowerCase() === "buffer" || /^BUF(?:FER)?(?:[_-]?\w+)?$/i.test(name.trim());
}
function isCoolerModule(name, type = "") {
  return type.trim().toLowerCase() === "cooler" || /^(CL|COOL(?:ER)?)$/i.test(name.trim());
}
function isAlignerModule(name, type = "") {
  return type.trim().toLowerCase() === "aligner" || /^(AL|ALIGNER)$/i.test(name.trim());
}
function isTopologyHiddenModule(module2) {
  const name = module2.name.trim();
  const type = module2.type.trim().toLowerCase();
  return /^HEATER$/i.test(name) || type === "heater";
}
function isLoadPortName(name, type = "") {
  const normalizedType = type.trim().toLowerCase();
  return normalizedType === "loadport" || normalizedType === "dummyport" || isDummyPortName(name) || /^(LP\d*|P\d+|.*PORT)$/i.test(name);
}
function isLoadLockName(name, type = "") {
  return !isBufferModule(name, type) && (type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name));
}
function initialLoadLockEnvironment(device, name) {
  const lastItem = String(device?.Stations?.[name]?.LastItem ?? "");
  if (/VTR|VAC|真空/i.test(lastItem)) return "\u771F\u7A7A";
  if (/ATR|ATM|大气/i.test(lastItem)) return "\u5927\u6C14";
  return "\u5927\u6C14";
}
function isDoorlessModule(name, type = "") {
  return isCoolerModule(name, type) || isBufferModule(name, type);
}
function isProcessModule(name, type = "") {
  const normalizedType = type.toLowerCase();
  return /process|chamber/.test(normalizedType) || /^(PM|CH)\w*/i.test(name);
}
function normalizeMoves(moves) {
  return moves.map((move, index) => {
    const startTime = finiteNumber(move.StartTime);
    const endTime = Math.max(startTime, finiteNumber(move.EndTime, startTime));
    return {
      ...move,
      MoveID: finiteNumber(move.MoveID, index + 1),
      MoveType: finiteNumber(move.MoveType, -1),
      ModuleName: String(move.ModuleName ?? ""),
      StartTime: startTime,
      EndTime: endTime
    };
  }).sort((left, right) => left.StartTime - right.StartTime || left.EndTime - right.EndTime || left.MoveID - right.MoveID);
}
function collectModuleDefinitions(moves, device, configuredRobotNames = /* @__PURE__ */ new Set()) {
  const modules = /* @__PURE__ */ new Map();
  const stationDefinitions = device?.Stations ?? {};
  const hasConfiguredStations = Object.keys(stationDefinitions).length > 0;
  for (const move of moves) {
    const candidates = [
      move.ModuleName,
      ...listValue(move.SrcStationList),
      ...listValue(move.DestStationList),
      ...listValue(move.StationList)
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
function collectRobotNames(moves, device) {
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  const names = new Set(configuredRobotNames);
  for (const move of moves) {
    if (isRobotName(move.ModuleName, configuredRobotNames)) names.add(move.ModuleName);
    const robot = String(move.Robot ?? "");
    if (robot) names.add(robot);
  }
  return [...names].sort(naturalCompare);
}
function initialMaterialLocations(moves) {
  const locations = /* @__PURE__ */ new Map();
  for (const move of moves) {
    if (move.MoveType === SWAP_MOVE) {
      const station = String(listValue(move.StationList)[0] ?? "");
      for (const material of materialIds(move, "RecvMatList")) {
        if (!locations.has(material)) locations.set(material, station);
      }
      for (const material of materialIds(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, move.ModuleName);
      }
      continue;
    }
    const fallback = PICK_MOVE_TYPES.has(move.MoveType) ? firstStation(move, "SrcStationList") : PLACE_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : move.MoveType === PROCESS_MOVE ? move.ModuleName : "";
    for (const material of materialIds(move)) {
      if (!locations.has(material) && fallback) locations.set(material, fallback);
    }
  }
  return locations;
}
function applyCompletedTransfer(move, locations) {
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
    for (const material of materialIds(move, "RecvMatList")) locations.set(material, move.ModuleName);
    for (const material of materialIds(move, "SendMatList")) locations.set(material, station);
  }
}
function indexedStation(move, field, index) {
  const stations = listValue(move[field]).map(String);
  return String(stations[index] ?? stations[0] ?? "");
}
function indexedSlot(move, field, index) {
  const slots = listValue(move[field]);
  const slot = finiteNumber(slots[index] ?? slots[0], 0);
  return Number.isInteger(slot) && slot > 0 ? slot : 0;
}
function loadPortCapacity(device, name, observedMaximum) {
  const definition = device?.Stations?.[name] ?? {};
  const declaredSlots = listValue(definition.Slots).map((value) => finiteNumber(value, 0));
  const declaredCapacity = Math.max(
    finiteNumber(definition.Capacity, 0),
    declaredSlots.length,
    ...declaredSlots
  );
  return Math.max(
    1,
    declaredCapacity || DEFAULT_LOAD_PORT_CAPACITY,
    observedMaximum
  );
}
function stationSlotCapacity(device, name, defaultCapacity = 1) {
  const definition = device?.Stations?.[name] ?? {};
  const declaredSlots = listValue(definition.Slots).map((value) => finiteNumber(value, 0));
  return Math.max(
    1,
    defaultCapacity,
    finiteNumber(definition.Capacity, 0),
    declaredSlots.length,
    ...declaredSlots
  );
}
function buildLoadPortSlots(records, device, time, initialLocations, processedMaterials) {
  const names = /* @__PURE__ */ new Set();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isLoadPortName(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isLoadPortName(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }
  const observedMaximum = /* @__PURE__ */ new Map();
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
  const result = /* @__PURE__ */ new Map();
  for (const name of names) {
    const slotMaterialHistory = /* @__PURE__ */ new Map();
    const generationSlots = /* @__PURE__ */ new Map();
    const generationStartTimes = /* @__PURE__ */ new Map([[0, 0]]);
    const materialGenerations = /* @__PURE__ */ new Map();
    for (const move of records) {
      if (!PICK_MOVE_TYPES.has(move.MoveType)) continue;
      materialIds(move).forEach((material, index) => {
        if (indexedStation(move, "SrcStationList", index) !== name) return;
        const slot = indexedSlot(move, "SrcSlotList", index);
        if (!slot) return;
        const history = slotMaterialHistory.get(slot) ?? [];
        let generation = history.indexOf(material);
        if (generation < 0) {
          generation = history.length;
          history.push(material);
          slotMaterialHistory.set(slot, history);
        }
        const slots = generationSlots.get(generation) ?? /* @__PURE__ */ new Map();
        if (!slots.has(slot)) slots.set(slot, material);
        generationSlots.set(generation, slots);
        materialGenerations.set(material, generation);
        if (generation > 0) {
          generationStartTimes.set(
            generation,
            Math.min(generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY, move.StartTime)
          );
        }
      });
    }
    const activeGeneration = [...generationSlots.keys()].filter((generation) => generation === 0 || (generationStartTimes.get(generation) ?? Number.POSITIVE_INFINITY) <= time).reduce((latest, generation) => Math.max(latest, generation), 0);
    const occupancy = new Map(generationSlots.get(activeGeneration) ?? []);
    if (!occupancy.size && !generationSlots.size) {
      const legacyInitialMaterials = [...initialLocations.entries()].filter(([, location]) => location === name).map(([material]) => material).sort(naturalCompare);
      legacyInitialMaterials.forEach((material, index) => occupancy.set(index + 1, material));
    }
    for (const move of records) {
      const materials = materialIds(move);
      if (PICK_MOVE_TYPES.has(move.MoveType)) {
        if (move.EndTime > time) continue;
        materials.forEach((material, index) => {
          if (indexedStation(move, "SrcStationList", index) !== name) return;
          if ((materialGenerations.get(material) ?? 0) !== activeGeneration) return;
          const slot = indexedSlot(move, "SrcSlotList", index);
          if (slot) occupancy.delete(slot);
          else {
            const current = [...occupancy.entries()].find(([, wafer]) => wafer === material);
            if (current) occupancy.delete(current[0]);
          }
        });
      } else if (PLACE_MOVE_TYPES.has(move.MoveType) && move.EndTime <= time) {
        materials.forEach((material, index) => {
          if (indexedStation(move, "DestStationList", index) !== name) return;
          if ((materialGenerations.get(material) ?? 0) !== activeGeneration) return;
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
      Math.max(observedMaximum.get(name) ?? 0, occupiedMaximum, occupancy.size)
    );
    result.set(name, Array.from({ length: capacity }, (_, index) => {
      const wafer = occupancy.get(index + 1) ?? "";
      return { slot: index + 1, wafer, processed: Boolean(wafer && processedMaterials.has(wafer)) };
    }));
  }
  return result;
}
function buildLoadLockSlots(records, device, time, initialLocations, processedMaterials) {
  const names = /* @__PURE__ */ new Set();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isLoadLockName(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isLoadLockName(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }
  const initialByLock = /* @__PURE__ */ new Map();
  const observedMaximum = /* @__PURE__ */ new Map();
  const occupyInitial = (lock, slot, material) => {
    if (!lock || !slot || !material || initialLocations.get(material) !== lock) return;
    names.add(lock);
    const occupancy = initialByLock.get(lock) ?? /* @__PURE__ */ new Map();
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
  const result = /* @__PURE__ */ new Map();
  for (const name of names) {
    const occupancy = new Map(initialByLock.get(name) ?? []);
    const initialMaterials = [...initialLocations.entries()].filter(([, location]) => location === name).map(([material]) => material).sort(naturalCompare);
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
      Math.max(observedMaximum.get(name) ?? 0, occupiedMaximum, initialMaterials.length)
    );
    result.set(name, Array.from({ length: capacity }, (_, index) => {
      const wafer = occupancy.get(index + 1) ?? "";
      return { slot: index + 1, wafer, processed: Boolean(wafer && processedMaterials.has(wafer)) };
    }));
  }
  return result;
}
function moveProgress(move, time) {
  const duration = move.EndTime - move.StartTime;
  if (duration <= 0) return time >= move.EndTime ? 1 : 0;
  return Math.max(0, Math.min(1, (time - move.StartTime) / duration));
}
function activeTarget(move) {
  return firstStation(move, "DestStationList") || firstStation(move, "SrcStationList") || String(listValue(move.StationList)[0] ?? "") || (!isRobotName(move.ModuleName) ? move.ModuleName : "");
}
function buildWorkspaceSnapshot(moves, device, requestedTime) {
  const records = normalizeMoves(moves);
  const endTime = records.reduce((maximum, move) => Math.max(maximum, move.EndTime), 0);
  const normalizedRequestedTime = requestedTime === Number.POSITIVE_INFINITY ? endTime : finiteNumber(requestedTime);
  const time = Math.max(0, Math.min(normalizedRequestedTime, endTime));
  const robotNames = collectRobotNames(records, device);
  const robotNameSet = new Set(robotNames);
  const definitions = collectModuleDefinitions(records, device, robotNameSet);
  const initialLocations = initialMaterialLocations(records);
  const locations = new Map(initialLocations);
  const doorStates = /* @__PURE__ */ new Map();
  const environments = /* @__PURE__ */ new Map();
  const requiredProcesses = /* @__PURE__ */ new Map();
  for (const move of records) {
    if (move.MoveType !== PROCESS_MOVE) continue;
    for (const material of materialIds(move)) {
      requiredProcesses.set(material, (requiredProcesses.get(material) ?? 0) + 1);
    }
  }
  const completedProcesses = /* @__PURE__ */ new Map();
  const processedMaterials = /* @__PURE__ */ new Set();
  const activeMoves = [];
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
        for (const material of materialIds(move)) {
          const completed2 = (completedProcesses.get(material) ?? 0) + 1;
          completedProcesses.set(material, completed2);
          if (completed2 >= (requiredProcesses.get(material) ?? 1)) {
            processedMaterials.add(material);
          }
        }
      }
    }
    const doorVisualActive = move.StartTime <= time && time < Math.max(move.EndTime, move.StartTime + DOOR_VISUAL_MIN_SECONDS);
    if (move.MoveType === PREPARE_MOVE) {
      if (doorVisualActive) doorStates.set(move.ModuleName, "opening");
      else if (completed) doorStates.set(move.ModuleName, "open");
    } else if (move.MoveType === COMPLETE_MOVE) {
      if (doorVisualActive) doorStates.set(move.ModuleName, "closing");
      else if (completed) doorStates.set(move.ModuleName, "closed");
    } else if (LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType) && (active || completed)) {
      const currentState = move.MoveType === PUMP_MOVE ? "VAC" : move.MoveType === VENT_MOVE ? "ATM" : String(move.CurState ?? "");
      const environment = /VTR|VAC/i.test(currentState) ? "\u771F\u7A7A" : /ATR|ATM/i.test(currentState) ? "\u5927\u6C14" : currentState;
      if (environment) environments.set(move.ModuleName, active ? `${environment}\u5207\u6362\u4E2D` : environment);
    }
  }
  const robotTargets = /* @__PURE__ */ new Map();
  for (const move of activeMoves) {
    if (isRobotName(move.ModuleName, robotNameSet)) robotTargets.set(move.ModuleName, activeTarget(move));
  }
  const lastRobotTargets = /* @__PURE__ */ new Map();
  for (const move of records) {
    if (move.StartTime > time || !isRobotName(move.ModuleName, robotNameSet)) continue;
    const target = activeTarget(move);
    if (target) lastRobotTargets.set(move.ModuleName, target);
  }
  const wafersByLocation = /* @__PURE__ */ new Map();
  for (const [material, location] of locations) {
    if (!location) continue;
    const wafers = wafersByLocation.get(location) ?? [];
    wafers.push(material);
    wafersByLocation.set(location, wafers);
  }
  for (const wafers of wafersByLocation.values()) wafers.sort(naturalCompare);
  const loadPortSlots = buildLoadPortSlots(records, device, time, initialLocations, processedMaterials);
  const loadLockSlots = buildLoadLockSlots(records, device, time, initialLocations, processedMaterials);
  const modules = [...definitions.entries()].map(([name, definition]) => {
    const moduleMoves = activeMoves.filter((move) => move.ModuleName === name || firstStation(move, "SrcStationList") === name || firstStation(move, "DestStationList") === name || listValue(move.StationList).map(String).includes(name));
    const primaryMove = moduleMoves.find(isCleaningMove) ?? moduleMoves.find((move) => move.MoveType === PROCESS_MOVE) ?? moduleMoves.find((move) => LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType)) ?? moduleMoves.find((move) => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType)) ?? moduleMoves[0];
    let status = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove && isCleaningMove(primaryMove)) status = "cleaning";
    else if (primaryMove?.MoveType === PROCESS_MOVE) status = "processing";
    else if (primaryMove && LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(primaryMove.MoveType)) status = "environment";
    else if (primaryMove && [PREPARE_MOVE, COMPLETE_MOVE].includes(primaryMove.MoveType)) status = "door";
    else if (primaryMove) status = "transfer";
    const currentEnvironment = String(primaryMove?.CurState ?? "");
    const prePrepareType = String(primaryMove?.PrePrepareType ?? "");
    const loadLockPhase = primaryMove && LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(primaryMove.MoveType) ? primaryMove.MoveType === PUMP_MOVE || /VTR|VAC|PUMP/i.test(`${currentEnvironment} ${prePrepareType}`) ? "pumping" : primaryMove.MoveType === VENT_MOVE || /ATR|ATM|VENT/i.test(`${currentEnvironment} ${prePrepareType}`) ? "venting" : "" : "";
    return {
      name,
      type: definition.type,
      status,
      door: doorStates.get(name) ?? "closed",
      wafers: wafersByLocation.get(name) ?? [],
      processedWafers: (wafersByLocation.get(name) ?? []).filter((wafer) => processedMaterials.has(wafer)),
      loadPortSlots: loadPortSlots.get(name) ?? [],
      loadLockSlots: loadLockSlots.get(name) ?? [],
      slotCapacity: stationSlotCapacity(device, name, isCoolerModule(name, definition.type) ? 3 : 1),
      activeMoveName: primaryMove ? isCleaningMove(primaryMove) ? "\u6E05\u6D01" : MOVE_NAMES[primaryMove.MoveType] ?? `\u52A8\u4F5C ${primaryMove.MoveType}` : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      loadLockPhase,
      isRobotTarget: [...robotTargets.values()].includes(name)
    };
  }).sort((left, right) => naturalCompare(left.name, right.name));
  const robots = robotNames.map((name) => {
    const move = activeMoves.find((record) => record.ModuleName === name);
    const definition = device?.Robots?.[name] ?? {};
    const wafers = wafersByLocation.get(name) ?? [];
    return {
      name,
      type: String(definition.Type ?? ""),
      capacity: robotCapacity(definition, wafers.length),
      environment: robotEnvironment(name, definition),
      wafers,
      processedWafers: wafers.filter((wafer) => processedMaterials.has(wafer)),
      busy: Boolean(move),
      source: move ? firstStation(move, "SrcStationList") : "",
      target: robotTargets.get(name) ?? lastRobotTargets.get(name) ?? "",
      activeMoveName: move ? MOVE_NAMES[move.MoveType] ?? `\u52A8\u4F5C ${move.MoveType}` : "",
      isPreTrans: move?.MoveType === PRE_TRANS_MOVE,
      preTransProgress: move?.MoveType === PRE_TRANS_MOVE ? moveProgress(move, time) : 1
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
    waferCount: new Set(records.flatMap((move) => materialIds(move))).size
  };
}
function stationCapacity(device, name) {
  const definition = device?.Stations?.[name] ?? {};
  const slots = listValue(definition.Slots).map((value) => finiteNumber(value, 0)).filter((value) => Number.isInteger(value) && value > 0);
  return Math.max(1, finiteNumber(definition.Capacity, 0), slots.length);
}
function routeByPJobName(plan, pjobName) {
  const routes = Array.isArray(plan?.routes) ? plan.routes : [];
  const routeByName = new Map(routes.filter((route) => route && typeof route === "object" && !Array.isArray(route)).map((route) => [String(route.name ?? ""), route]));
  const aliases = /* @__PURE__ */ new Map();
  const rounds = Array.isArray(plan?.rounds) ? plan.rounds : [];
  rounds.forEach((round, roundIndex) => {
    const cjobs = Array.isArray(round?.cjobs) ? round.cjobs : [];
    cjobs.forEach((cjob, cjobIndex) => {
      const row = cjob;
      const cjobName = String(row.key ?? `C${cjobIndex + 1}`);
      const pjobs = Array.isArray(row.pjobs) ? row.pjobs : [];
      pjobs.forEach((pjob, pjobIndex) => {
        const job = pjob;
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
function replayMaterialProgress(records) {
  const progress = /* @__PURE__ */ new Map();
  const update = (move, materials, stepField, pjobOffset = 0) => {
    const stepIds = listValue(move[stepField]);
    const pjobs = listValue(move.PJobName);
    materials.forEach((material, index) => {
      const previous = progress.get(material) ?? { pjobName: "", stepId: "", explicitTargets: [] };
      const explicitTarget = indexedStation(move, "DestStationList", index);
      progress.set(material, {
        pjobName: String(pjobs[pjobOffset + index] ?? pjobs[index] ?? previous.pjobName),
        stepId: String(stepIds[index] ?? previous.stepId),
        explicitTargets: explicitTarget ? [explicitTarget] : []
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
function nextRouteResources(plan, progress) {
  if (!progress) return [];
  if (progress.explicitTargets.length) return progress.explicitTargets;
  const route = routeByPJobName(plan, progress.pjobName);
  const stages = Array.isArray(route?.stages) ? route.stages : [];
  const currentIndex = stages.findIndex((stage) => String(stage.stepId ?? "") === progress.stepId);
  if (currentIndex < 0) return [];
  const postStepIds = listValue(stages[currentIndex].postStepIds).map(String);
  const nextStages = postStepIds.length ? stages.filter((stage) => postStepIds.includes(String(stage.stepId ?? ""))) : stages.slice(currentIndex + 1, currentIndex + 2);
  return [...new Set(nextStages.flatMap((stage) => Array.isArray(stage.visits) ? stage.visits.map((visit) => String(visit.stationName ?? "")) : []).filter(Boolean))];
}
function hasConsistentTransferReplay(records, device) {
  const locations = initialMaterialLocations(records);
  const robotNames = new Set(Object.keys(device.Robots ?? {}));
  const locationCount = (location) => [...locations.values()].filter((current) => current === location).length;
  const orderedTransfers = records.filter((move) => PICK_MOVE_TYPES.has(move.MoveType) || PLACE_MOVE_TYPES.has(move.MoveType) || move.MoveType === SWAP_MOVE).sort((left, right) => left.EndTime - right.EndTime || left.MoveID - right.MoveID);
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
function detectTerminalPlaybackDeadlock(moves, device, plan) {
  if (!moves.length || !device || !plan) return null;
  const records = normalizeMoves(moves);
  if (!hasConsistentTransferReplay(records, device)) return null;
  const snapshot = buildWorkspaceSnapshot(records, device, Number.POSITIVE_INFINITY);
  const progress = replayMaterialProgress(records);
  const modules = new Map(snapshot.modules.map((module2) => [module2.name, module2]));
  const robotNames = new Set(snapshot.robots.map((robot) => robot.name));
  const blockingTargets = (robot, wafer) => {
    const targets = nextRouteResources(plan, progress.get(wafer)).filter((target) => !robotNames.has(target));
    if (!targets.length) return [];
    const blocked = targets.filter((target) => {
      const chamber = modules.get(target);
      if (!chamber || chamber.wafers.length < stationCapacity(device, target)) return false;
      return chamber.wafers.some((occupant) => nextRouteResources(plan, progress.get(occupant)).includes(robot.name));
    });
    return blocked.length === targets.length ? blocked : [];
  };
  const unfinishedCleaningBlockers = (targets) => targets.flatMap((target) => {
    const occupants = modules.get(target)?.wafers ?? [];
    return occupants.flatMap((wafer) => {
      const latestCleaningMove = [...records].filter((move) => move.MoveType === PROCESS_MOVE && move.ModuleName === target && materialIds(move).includes(wafer) && isCleaningMove(move)).sort((left, right) => right.EndTime - left.EndTime || right.MoveID - left.MoveID)[0];
      if (!latestCleaningMove || latestCleaningMove.IsLastCleanTaskMove !== false) return [];
      return [{
        target,
        wafer,
        taskName: String(latestCleaningMove.CleanTaskName || latestCleaningMove.ProcessRecipe || "\u6E05\u6D17\u4EFB\u52A1")
      }];
    });
  });
  for (const robot of snapshot.robots) {
    const held = [...robot.wafers].sort(naturalCompare);
    if (robot.capacity === 1 && held.length === 1) {
      const targets = blockingTargets(robot, held[0]);
      if (!targets.length) continue;
      const occupants = [...new Set(targets.flatMap((target) => modules.get(target)?.wafers ?? []))].sort(naturalCompare);
      return {
        Code: "DEADLOCK.SINGLE_ARM_TARGET_FULL",
        Category: "single-arm-target-full",
        Message: `${robot.name} \u7684\u552F\u4E00\u624B\u81C2\u6301\u6709\u6676\u5706 ${held[0]}\uFF0C\u76EE\u6807 ${targets.join("\u3001")} \u88AB\u6676\u5706 ${occupants.join("\u3001")} \u5360\u7528\uFF1B\u5B83\u6CA1\u6709\u7A7A\u624B\u63A5\u8D70\u8154\u5185\u6676\u5706\uFF0C\u6301\u7247\u53C8\u5FC5\u987B\u7B49\u76EE\u6807\u817E\u7A7A\u624D\u80FD\u653E\u4E0B\uFF0C\u5F62\u6210\u76F8\u4E92\u7B49\u5F85\u3002`
      };
    }
    if (robot.capacity === 2 && held.length === 1) {
      const targets = blockingTargets(robot, held[0]);
      if (!targets.length) continue;
      const occupants = [...new Set(targets.flatMap((target) => modules.get(target)?.wafers ?? []))].sort(naturalCompare);
      const cleaningBlockers = unfinishedCleaningBlockers(targets);
      const reason = cleaningBlockers.length ? cleaningBlockers.map((blocker) => `${blocker.target} \u88AB\u5C1A\u672A\u5B8C\u6210\u6574\u7EC4 ${blocker.taskName} \u7684\u6E05\u6D17\u7247 ${blocker.wafer} \u5360\u7528\uFF1B\u6676\u5706 ${held[0]} \u5728\u6E05\u6D17\u5B8C\u6210\u524D\u7981\u6B62\u8FDB\u5165\uFF0C\u4E0D\u80FD\u76F4\u63A5\u6362\u7247\u3002`).join("") : `\u76F4\u63A5\u6362\u7247\u4F1A\u8BA9\u8154\u5185\u6676\u5706 ${occupants.join("\u3001")} \u8F6C\u5230 ${robot.name} \u7684\u7B2C\u4E8C\u53EA\u624B\u81C2\uFF0C\u4F46\u56DE\u653E\u7EC8\u70B9\u6CA1\u6709\u80FD\u5C06\u8FD9\u4E9B\u6676\u5706\u7EE7\u7EED\u653E\u4E0B\u7684\u5408\u6CD5\u540E\u7EE7\u51FA\u53E3\uFF0C\u6362\u7247\u94FE\u65E0\u6CD5\u95ED\u5408\u3002`;
      return {
        Code: "DEADLOCK.DUAL_ARM_SINGLE_HELD_TARGET_FULL",
        Category: "dual-arm-single-held-target-full",
        Message: `${robot.name} \u5DF2\u6301\u6709\u6676\u5706 ${held[0]}\u3002${reason}\u8154\u5185\u7247\u53C8\u53EA\u80FD\u7531 ${robot.name} \u53D6\u51FA\uFF0C\u5F62\u6210\u6301\u7247\u7B49\u5F85\u95ED\u73AF\u3002`
      };
    }
    if (robot.capacity === 2 && held.length === 2) {
      const targetsByWafer = held.map((wafer) => blockingTargets(robot, wafer));
      if (targetsByWafer.some((targets2) => !targets2.length)) continue;
      const targets = [...new Set(targetsByWafer.flat())].sort(naturalCompare);
      return {
        Code: "DEADLOCK.DUAL_ARM_TARGETS_FULL",
        Category: "dual-arm-targets-full",
        Message: `${robot.name} \u4E24\u53EA\u624B\u81C2\u6301\u6709\u6676\u5706 ${held.join("\u3001")}\uFF0C\u76EE\u6807 ${targets.join("\u3001")} \u5747\u5DF2\u6EE1\uFF1B\u6CA1\u6709\u7A7A\u624B\u63A5\u8D70\u8154\u5185\u6676\u5706 ${[...new Set(targets.flatMap((target) => modules.get(target)?.wafers ?? []))].sort(naturalCompare).join("\u3001")}\uFF0C\u6301\u7247\u53C8\u5FC5\u987B\u7B49\u76EE\u6807\u817E\u7A7A\u624D\u80FD\u653E\u4E0B\uFF0C\u5F62\u6210\u76F8\u4E92\u7B49\u5F85\u3002`
      };
    }
  }
  return null;
}
function collectElements(root) {
  const required = (id) => {
    const element = root.getElementById(id);
    if (!element) throw new Error(`\u7ED3\u679C\u5206\u6790\u9875\u9762\u7F3A\u5C11\u9875\u9762\u8282\u70B9\uFF1A${id}`);
    return element;
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
    recommendationModel: required("visualRecommendationModel"),
    recommendationModelHint: required("visualRecommendationModelHint"),
    pauseOnDecisionChangeButton: required("visualPauseOnDecisionChangeButton"),
    activeMoves: required("visualActiveMoves"),
    source: required("visualSource"),
    currentTime: required("visualCurrentTime"),
    totalTime: required("visualTotalTime"),
    progressText: required("visualProgressText"),
    moveText: required("visualMoveText"),
    waferText: required("visualWaferText"),
    range: required("visualTimeline"),
    playButton: required("visualPlayButton"),
    speed: required("visualSpeed"),
    fileInput: required("visualFileInput"),
    importButton: root.getElementById("visualImportButton"),
    openGantt: required("visualOpenGantt"),
    resultButton: required("workspaceResultButton"),
    performance: required("visualPerformance"),
    performanceWindow: required("performanceWindow")
  };
}
function icon(name) {
  const paths = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>',
    robot: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 18v3M15 18v3"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v5h14v-5"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}
function candidateDestinations(decision) {
  const destinations = /* @__PURE__ */ new Map();
  for (const candidate of decision?.candidates ?? []) {
    if (!candidate.destination) continue;
    const previous = destinations.get(candidate.destination);
    destinations.set(candidate.destination, {
      count: (previous?.count ?? 0) + 1,
      bestRank: Math.min(previous?.bestRank ?? Number.POSITIVE_INFINITY, candidate.rank),
      preference: Math.max(previous?.preference ?? 0, candidate.policyPreference),
      makespanDelta: candidate.makespanDelta === null ? previous?.makespanDelta ?? null : Math.min(previous?.makespanDelta ?? Number.POSITIVE_INFINITY, candidate.makespanDelta),
      selected: Boolean(previous?.selected || candidate.selected)
    });
  }
  return destinations;
}
function snapshotWithCandidateModules(snapshot, decision, device) {
  const modules = [...snapshot.modules];
  const knownNames = new Set(modules.map((module2) => module2.name));
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
      isRobotTarget: false
    });
    knownNames.add(name);
  }
  return {
    ...snapshot,
    modules: modules.sort((left, right) => naturalCompare(left.name, right.name))
  };
}
function snapshotWithFullDeviceModules(snapshot, device) {
  const modules = [...snapshot.modules];
  const knownNames = new Set(modules.map((module2) => module2.name));
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
      loadPortSlots: isLoadPortName(name, type) ? Array.from({ length: loadPortCapacity(device, name, 0) }, (_, index) => ({
        slot: index + 1,
        wafer: "",
        processed: false
      })) : [],
      loadLockSlots: [],
      slotCapacity,
      activeMoveName: "",
      progress: 0,
      environment: isLoadLockName(name, type) ? initialLoadLockEnvironment(device, name) : "",
      loadLockPhase: "",
      isRobotTarget: false
    });
    knownNames.add(name);
  }
  return {
    ...snapshot,
    modules: modules.sort((left, right) => naturalCompare(left.name, right.name))
  };
}
function topologyGroups(modules) {
  const loadLocks = modules.filter((module2) => isLoadLockName(module2.name, module2.type));
  const loadPorts = modules.filter((module2) => isLoadPortName(module2.name, module2.type));
  const processModules = modules.filter((module2) => isProcessModule(module2.name, module2.type));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map((module2) => module2.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter((module2) => !assignedNames.has(module2.name))
  };
}
function expandDualProcessChambers(modules) {
  const expanded = [];
  for (const module2 of modules) {
    if (module2.slotCapacity < 2) {
      expanded.push({ view: module2, sourceName: module2.name });
      continue;
    }
    for (let index = 0; index < module2.slotCapacity; index += 1) {
      const wafer = module2.wafers[index] ?? "";
      expanded.push({
        view: {
          ...module2,
          name: `${module2.name}-${index + 1}`,
          wafers: wafer ? [wafer] : [],
          processedWafers: wafer && module2.processedWafers.includes(wafer) ? [wafer] : [],
          slotCapacity: 1
        },
        sourceName: module2.name
      });
    }
  }
  return expanded;
}
function renderWaferToken(wafer, progress, processed = false) {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  const state = processed ? "processed" : "unprocessed";
  return `<span class="wafer-token wafer-${state}" style="--wafer-progress:${normalizedProgress * 360}deg" title="\u6676\u5706 ${escapeHtml(wafer)}\uFF0C${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}"><span>${escapeHtml(wafer)}</span></span>`;
}
function moduleDoorSides(module2, role, layout = "single", roleIndex = 0) {
  if (module2.door === "doorless") return [];
  if (role === "lock") return [];
  if (role === "port") return ["top"];
  const name = module2.name.trim().toUpperCase();
  if (layout === "cascade" && role === "process") {
    const cascadeDoorSides = [
      ["right"],
      ["left"],
      ["bottom"],
      ["right"],
      ["left"],
      ["left"]
    ];
    return cascadeDoorSides[roleIndex] ?? ["top"];
  }
  if (role === "process") {
    const standardDoorSides = [
      ["right"],
      ["right"],
      ["bottom"],
      ["bottom"],
      ["left"],
      ["left"]
    ];
    return standardDoorSides[roleIndex] ?? ["top"];
  }
  if (name === "HEATER") return ["left"];
  if (["AL", "ALIGNER"].includes(name)) return ["right"];
  if (["CL", "COOLER"].includes(name)) return ["left"];
  return ["top"];
}
function renderLoadPortCassette(module2) {
  const slots = module2.loadPortSlots.length ? module2.loadPortSlots : module2.wafers.map((wafer, index) => ({
    slot: index + 1,
    wafer,
    processed: module2.processedWafers.includes(wafer)
  }));
  const processed = slots.filter((slot) => slot.wafer && slot.processed).length;
  const unprocessed = slots.filter((slot) => slot.wafer && !slot.processed).length;
  const slotMarkup = slots.map((slot) => {
    const state = !slot.wafer ? "empty" : slot.processed ? "processed" : "unprocessed";
    const label = slot.wafer ? `\u69FD\u4F4D ${slot.slot}\uFF0C\u6676\u5706 ${slot.wafer}\uFF0C${slot.processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}` : `\u69FD\u4F4D ${slot.slot}\uFF0C\u7A7A`;
    return `<span class="load-port-slot is-${state}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`;
  }).join("");
  return `<div class="load-port-cassette" role="group" aria-label="${escapeHtml(`${module2.name} \u6B63\u89C6\u6676\u5706\u76D2\uFF0C\u5171 ${slots.length} \u4E2A\u69FD\u4F4D\uFF0C\u672A\u52A0\u5DE5 ${unprocessed}\uFF0C\u5DF2\u52A0\u5DE5 ${processed}`)}">
    <span class="load-port-cassette-handle" aria-hidden="true"></span>
    <div class="load-port-slot-bank" style="--load-port-slot-count:${slots.length}">${slotMarkup}</div>
  </div>`;
}
function renderModule(module2, role, candidate, layout = "single", roleIndex = 0) {
  const waferProgress = module2.status === "processing" ? module2.progress : 0;
  const visibleWaferCount = role === "lock" ? 2 : 1;
  const processedWafers = new Set(module2.processedWafers ?? []);
  const wafers = module2.wafers.slice(0, visibleWaferCount).map((wafer) => renderWaferToken(wafer, waferProgress, processedWafers.has(wafer))).join("");
  const layerCount = role === "lock" && module2.loadLockSlots.length ? module2.loadLockSlots.filter((slot) => slot.wafer).length : module2.wafers.length;
  const overflow = layerCount > visibleWaferCount ? `<span class="wafer-more">+ ${layerCount - visibleWaferCount}</span>` : "";
  const doors = moduleDoorSides(module2, role, layout, roleIndex).map((side) => `<i class="chamber-door chamber-door-${side}"></i>`).join("");
  const accessibleStatus = `${module2.name}\uFF0C${STATUS_LABELS[module2.status]}\uFF0C${DOOR_LABELS[module2.door]}`;
  const candidateLabel = candidate ? `${candidate.count} \u4E2A\u53EF\u884C\u52A8\u4F5C\uFF0C\u6700\u9AD8\u6A21\u578B\u504F\u597D ${(candidate.preference * 100).toFixed(0)}%` : "";
  if (role === "auxiliary" && isAlignerModule(module2.name, module2.type)) {
    return `<strong class="equipment-external-name equipment-external-name-aligner">${escapeHtml(module2.name)}</strong>
      <article class="equipment-utility equipment-aligner status-${module2.status} ${module2.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
        <div class="aligner-cross ${wafers ? "is-occupied" : "is-empty"}" aria-hidden="true"><i></i><i></i>${wafers}</div>
      </article>`;
  }
  if (role === "auxiliary" && (isBufferModule(module2.name, module2.type) || isCoolerModule(module2.name, module2.type))) {
    const utilityKind = isBufferModule(module2.name, module2.type) ? "buffer" : "cooler";
    const coolerSlotCount = Math.max(2, Math.min(8, module2.slotCapacity || module2.wafers.length || 3));
    const coolerSlots = Array.from({ length: coolerSlotCount }, (_, index) => {
      const wafer = module2.wafers[index] ?? "";
      const processed = wafer && processedWafers.has(wafer);
      const label = wafer ? `\u69FD\u4F4D ${index + 1}\uFF0C\u6676\u5706 ${wafer}\uFF0C${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}` : `\u69FD\u4F4D ${index + 1}\uFF0C\u7A7A`;
      return `<span class="cooler-slot ${wafer ? `is-occupied wafer-${processed ? "processed" : "unprocessed"}` : "is-empty"}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`;
    }).join("");
    const utilityBody = utilityKind === "buffer" ? `<div class="buffer-tray ${wafers ? "is-occupied" : "is-empty"}" aria-hidden="true"><span></span><span></span><span></span>${wafers}</div>` : `<div class="cooler-slot-bank ${wafers ? "is-occupied" : "is-empty"}" role="group" aria-label="${escapeHtml(`${module2.name} \u6B63\u89C6\u51B7\u5374\u69FD\uFF0C\u5171 ${coolerSlotCount} \u4E2A\u69FD\u4F4D`)}">${coolerSlots}</div>`;
    return `<strong class="equipment-external-name equipment-external-name-${utilityKind}">${escapeHtml(module2.name)}</strong>
      <article class="equipment-utility equipment-${utilityKind} status-${module2.status} ${module2.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
        ${utilityBody}
      </article>`;
  }
  const atmosphereLevel = role === "lock" ? module2.loadLockPhase === "pumping" ? 100 - module2.progress * 100 : module2.loadLockPhase === "venting" ? module2.progress * 100 : /大气|ATM|ATR/i.test(module2.environment) ? 100 : 0 : 0;
  const loadLockLayers = role === "lock" ? `<div class="loadlock-layers" aria-hidden="true">${[0, 1].map((index) => {
    const layer = module2.loadLockSlots[index];
    const wafer = layer ? layer.wafer : module2.wafers[index];
    const processed = layer ? layer.processed : wafer ? processedWafers.has(wafer) : false;
    const waferState = processed ? "processed" : "unprocessed";
    return `<div class="loadlock-layer ${wafer ? "is-occupied" : "is-empty"}">${wafer ? `<span class="loadlock-wafer-line wafer-${waferState}" title="\u6676\u5706 ${escapeHtml(wafer)}\uFF08${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}\uFF09"></span>` : ""}</div>`;
  }).join("")}${overflow}</div>` : role === "process" ? `<div class="process-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : role === "port" ? `` : role === "auxiliary" ? `<div class="auxiliary-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : `<div class="wafer-stack">${wafers}${overflow}</div>`;
  const bodyMarkup = role === "process" ? `<div class="equipment-process-shell"><div class="equipment-body">${loadLockLayers}</div></div>` : `<div class="equipment-body">${loadLockLayers}</div>`;
  const article = `
    <article class="equipment-card equipment-${role} status-${module2.status} door-${module2.door} ${module2.loadLockPhase ? `loadlock-${module2.loadLockPhase}` : ""} ${module2.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" style="--module-progress:${Math.round(module2.progress * 100)}%;--loadlock-atmosphere:${Math.max(0, Math.min(100, atmosphereLevel)).toFixed(1)}%;--loadlock-atmosphere-ratio:${Math.max(0, Math.min(1, atmosphereLevel / 100)).toFixed(3)}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
       ${bodyMarkup}
      <div class="chamber-doors" aria-hidden="true">${role === "lock" ? '<i class="loadlock-door loadlock-door-vacuum"></i><i class="loadlock-door loadlock-door-atmosphere"></i>' : doors}</div>
    </article>`;
  if (role === "process" || role === "auxiliary" || role === "lock") {
    return `<strong class="equipment-external-name">${escapeHtml(module2.name)}</strong>${article}`;
  }
  if (role === "port") {
    const isDummy = isDummyPortName(module2.name) || module2.type.trim().toLowerCase() === "dummyport";
    const portDoors = moduleDoorSides(module2, role, layout, roleIndex).map((side) => `<i class="chamber-door chamber-door-${side}"></i>`).join("");
    return `<strong class="equipment-external-name ${isDummy ? "equipment-external-name-dummy" : "equipment-external-name-port"}">${escapeHtml(module2.name)}</strong><div class="load-port-assembly ${isDummy ? "is-dummy-port" : "is-load-port"} door-${module2.door}" role="group" aria-label="${escapeHtml(`${accessibleStatus}${isDummy ? "\uFF0CDummy Port" : ""}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
      <div class="chamber-doors" aria-hidden="true">${portDoors}</div>
      ${renderLoadPortCassette(module2)}
    </div>`;
  }
  return article;
}
var ROBOT_DOUBLE_HOLD_CAPACITY = 2;
var ROBOT_DISPLAY_WAFER_LIMIT = 2;
function renderRobotHub(robot, environment, angleDegrees) {
  const visibleWafers = robot.wafers.slice(0, ROBOT_DISPLAY_WAFER_LIMIT);
  const capacityLabel = robot.capacity >= ROBOT_DOUBLE_HOLD_CAPACITY ? "\u53CC\u7247\u673A\u68B0\u624B" : "\u5355\u69FD\u673A\u68B0\u624B";
  const holdingLabel = robot.wafers.length ? `\uFF0C\u6301\u6709 ${robot.wafers.length} \u7247\u6676\u5706 ${robot.wafers.join("\u3001")}` : "\uFF0C\u69FD\u4F4D\u4E3A\u7A7A";
  const waferMarkup = visibleWafers.map((wafer, index) => `
    <span class="robot-held-wafer robot-held-wafer-${index}">${renderWaferToken(wafer, 0, robot.processedWafers.includes(wafer))}</span>`).join("");
  const overflow = robot.wafers.length > ROBOT_DISPLAY_WAFER_LIMIT ? `<span class="robot-held-overflow">+${robot.wafers.length - ROBOT_DISPLAY_WAFER_LIMIT}</span>` : "";
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" style="--robot-arm-angle:${angleDegrees.toFixed(1)}deg" aria-label="${escapeHtml(robot.name)}\uFF0C${capacityLabel}\uFF0C${robot.busy ? "\u5DE5\u4F5C\u4E2D" : "\u5F85\u547D"}${holdingLabel}">
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
var TOPOLOGY_COLUMN_PERCENTAGES = [26, 42, 58, 74];
var TOPOLOGY_ROW_TOP_PIXELS = [52, 154, 256, 358, 460, 562, 664, 786, 929, 1031, 1133];
var TOPOLOGY_VIEWBOX_WIDTH = 1e3;
var TOPOLOGY_ITEM_SIZE = 96;
var TOPOLOGY_PROCESS_WIDTH = 104;
var TOPOLOGY_PROCESS_HEIGHT = 104;
var TOPOLOGY_ROBOT_SIZE = 132;
var TOPOLOGY_LOADLOCK_WIDTH = 120;
var TOPOLOGY_LOADLOCK_HEIGHT = 72;
var TOPOLOGY_LOADPORT_WIDTH = 112;
var TOPOLOGY_LOADPORT_HEIGHT = 104;
var TOPOLOGY_LOADPORT_BASE_HEIGHT = 22;
var TOPOLOGY_LOADPORT_BASE_OVERHANG = 16;
var TOPOLOGY_BUFFER_WIDTH = 104;
var TOPOLOGY_BUFFER_HEIGHT = 56;
var TOPOLOGY_COOLER_WIDTH = 76;
var TOPOLOGY_COOLER_HEIGHT = 56;
var TOPOLOGY_ALIGNER_WIDTH = 76;
var TOPOLOGY_ALIGNER_HEIGHT = 54;
var TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS = [664, 740];
var TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS = 866;
var TOPOLOGY_LOADPORT_ROW_TOP_PIXELS = 1006;
var TOPOLOGY_CANVAS_PADDING = 28;
var TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP = TOPOLOGY_ROW_TOP_PIXELS[4] - 32;
var TOPOLOGY_SINGLE_PROCESS_LOWER_TOP = TOPOLOGY_ROW_TOP_PIXELS[5] - 10;
var TOPOLOGY_CASCADE_PM_TOP = 60;
var TOPOLOGY_CASCADE_UPPER_ROBOT_TOP = 190;
var TOPOLOGY_CASCADE_BRIDGE_TOP = 310;
var TOPOLOGY_CASCADE_LOWER_ROBOT_TOP = 430;
var TOPOLOGY_CASCADE_LOCK_ROW_TOP = 548;
var TOPOLOGY_CASCADE_LOCK_ROW_GAP = 80;
var TOPOLOGY_CASCADE_ATM_TOP = 742;
var TOPOLOGY_ATMOSPHERE_LOADPORT_OFFSET = 140;
var TOPOLOGY_CASCADE_LOADPORT_TOP = TOPOLOGY_CASCADE_ATM_TOP + TOPOLOGY_ATMOSPHERE_LOADPORT_OFFSET;
function distributedTopologyColumns(count) {
  if (count <= 1) return [50];
  if (count === 2) return [40, 60];
  if (count === 3) return [30, 50, 70];
  return Array.from({ length: count }, (_, index) => 20 + index * 60 / (count - 1));
}
function isMultiProcessChamberType(value) {
  const type = String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return type.includes("multiprocesschamber") || (type.includes("multi") || type.includes("dual") || type.includes("double")) && (type.includes("process") || type.includes("chamber"));
}
function detectTopologyLayout(modules, robotCount) {
  if (robotCount > 2) return "cascade";
  const hasMultiProcessChamber = modules.some((module2) => isMultiProcessChamberType(module2.type));
  return hasMultiProcessChamber ? "dual" : "single";
}
function detectDeviceTopologyLayout(device) {
  const robotCount = Object.keys(device?.Robots ?? {}).length;
  if (robotCount > 2) return "cascade";
  const hasMultiProcessChamber = Object.values(device?.Stations ?? {}).some((station) => {
    const type = String(station.Type ?? "");
    return isMultiProcessChamberType(type) || /process|chamber/i.test(type) && finiteNumber(station.Capacity, 1) > 1;
  });
  return hasMultiProcessChamber ? "dual" : "single";
}
function configurationReferencesName(value, name) {
  if (typeof value === "string") return value === name;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => configurationReferencesName(item, name));
  return Object.entries(value).some(([key, item]) => key === name || configurationReferencesName(item, name));
}
function cascadeBridgeLoadLockNames(orderedLoadLockNames, device, vacuumRobotNames) {
  const structurallyLinked = orderedLoadLockNames.filter((loadLockName) => {
    const station = device?.Stations?.[loadLockName];
    const linkedVacuumRobots = vacuumRobotNames.filter((robotName) => configurationReferencesName(station, robotName) || configurationReferencesName(device?.Robots?.[robotName], loadLockName));
    return linkedVacuumRobots.length >= 2;
  });
  if (structurallyLinked.length) return new Set(structurallyLinked);
  const namedBridges = orderedLoadLockNames.filter((name) => /^(?:UBR|DBR)(?:[_-]?\d+)?$/i.test(name.trim())).sort((left, right) => {
    const rank = (name) => /^UBR/i.test(name.trim()) ? 0 : 1;
    return rank(left) - rank(right) || naturalCompare(left, right);
  });
  return new Set(namedBridges.length ? namedBridges : orderedLoadLockNames.slice(4));
}
function moduleTopologyPosition(module2, role, index, roleModules, layout, bridgeLoadLockNames = /* @__PURE__ */ new Set()) {
  const name = module2.name.trim().toUpperCase();
  const roleCount = roleModules.length;
  const column = TOPOLOGY_COLUMN_PERCENTAGES;
  const row = TOPOLOGY_ROW_TOP_PIXELS;
  if (layout === "cascade" && role === "process") {
    const ordered = [...roleModules].sort((left, right) => naturalCompare(left.name, right.name));
    const layoutIndex = Math.max(0, ordered.findIndex((item) => item.name === module2.name));
    const positions = [
      { leftPercent: column[0], topPixels: TOPOLOGY_CASCADE_LOWER_ROBOT_TOP },
      { leftPercent: column[3], topPixels: TOPOLOGY_CASCADE_LOWER_ROBOT_TOP },
      { leftPercent: 50, topPixels: TOPOLOGY_CASCADE_PM_TOP },
      { leftPercent: column[0], topPixels: TOPOLOGY_CASCADE_UPPER_ROBOT_TOP },
      { leftPercent: column[3], topPixels: TOPOLOGY_CASCADE_UPPER_ROBOT_TOP },
      { leftPercent: column[3], topPixels: TOPOLOGY_CASCADE_PM_TOP }
    ];
    const position = positions[layoutIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[layoutIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[0] - Math.floor(layoutIndex / Math.max(roleCount, 1)) * 112
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (role === "process") {
    const ordered = [...roleModules].sort((left, right) => naturalCompare(left.name, right.name));
    const layoutIndex = Math.max(0, ordered.findIndex((item) => item.name === module2.name));
    const positions = [
      { leftPercent: column[0], topPixels: TOPOLOGY_SINGLE_PROCESS_LOWER_TOP },
      { leftPercent: column[0], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP },
      { leftPercent: column[1], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP - TOPOLOGY_PROCESS_HEIGHT },
      { leftPercent: column[2], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP - TOPOLOGY_PROCESS_HEIGHT },
      { leftPercent: column[3], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP },
      { leftPercent: column[3], topPixels: TOPOLOGY_SINGLE_PROCESS_LOWER_TOP }
    ];
    const position = positions[layoutIndex] ?? {
      leftPercent: distributedTopologyColumns(roleCount)[layoutIndex] ?? 50,
      topPixels: TOPOLOGY_ROW_TOP_PIXELS[3]
    };
    return { ...position, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT };
  }
  if (layout === "cascade" && role === "lock" && bridgeLoadLockNames.has(module2.name)) {
    const bridgeIndex = [...bridgeLoadLockNames].indexOf(module2.name);
    return {
      leftPercent: bridgeIndex % 2 === 0 ? column[1] : column[2],
      topPixels: TOPOLOGY_CASCADE_BRIDGE_TOP,
      widthPixels: TOPOLOGY_LOADLOCK_WIDTH,
      heightPixels: TOPOLOGY_LOADLOCK_HEIGHT
    };
  }
  if (role === "lock") {
    const canonicalOrder = { LA: 0, LB: 1, LC: 2, LD: 3 };
    const orderedLoadLocks = [...roleModules].sort((left, right) => {
      const leftName = left.name.trim().toUpperCase();
      const rightName = right.name.trim().toUpperCase();
      const leftRank = canonicalOrder[leftName] ?? 100;
      const rightRank = canonicalOrder[rightName] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const gridIndex = Math.max(0, orderedLoadLocks.findIndex((item) => item.name === module2.name));
    const loadLockRowTop = layout === "cascade" ? TOPOLOGY_CASCADE_LOCK_ROW_TOP : TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    const loadLockRowGap = layout === "cascade" ? TOPOLOGY_CASCADE_LOCK_ROW_GAP : TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[1] - TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    return {
      leftPercent: gridIndex % 2 === 0 ? 40 : 60,
      topPixels: loadLockRowTop + Math.floor(gridIndex / 2) * loadLockRowGap,
      widthPixels: TOPOLOGY_LOADLOCK_WIDTH,
      heightPixels: TOPOLOGY_LOADLOCK_HEIGHT
    };
  }
  if (role === "port") {
    const canonicalOrder = { LP1: 0, LP2: 1, LP3: 2, LP4: 3 };
    const orderedPorts = [...roleModules].sort((left, right) => {
      const leftDummy = isDummyPortName(left.name) || left.type.trim().toLowerCase() === "dummyport";
      const rightDummy = isDummyPortName(right.name) || right.type.trim().toLowerCase() === "dummyport";
      if (leftDummy !== rightDummy) return leftDummy ? 1 : -1;
      const leftRank = canonicalOrder[left.name.trim().toUpperCase()] ?? 100;
      const rightRank = canonicalOrder[right.name.trim().toUpperCase()] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const portIndex = Math.max(0, orderedPorts.findIndex((item) => item.name === module2.name));
    const currentIsDummy = isDummyPortName(module2.name) || module2.type.trim().toLowerCase() === "dummyport";
    const portColumns = roleCount === 5 ? [26, 38, 50, 62, 74] : roleCount <= column.length ? column : Array.from({ length: roleCount }, (_, current) => 20 + current * 60 / (roleCount - 1));
    const loadPortTop = layout === "cascade" ? TOPOLOGY_CASCADE_LOADPORT_TOP : TOPOLOGY_LOADPORT_ROW_TOP_PIXELS;
    return {
      /* 四列语义固定为 LP1 / LP2 / LP3 / Dummy Port；缺少 LP3 时保留空位。 */
      leftPercent: currentIsDummy && roleCount <= column.length ? column[3] : portColumns[portIndex] ?? column[0],
      topPixels: loadPortTop,
      widthPixels: TOPOLOGY_LOADPORT_WIDTH,
      heightPixels: TOPOLOGY_LOADPORT_HEIGHT
    };
  }
  if (isAlignerModule(module2.name, module2.type)) {
    return {
      leftPercent: 10,
      topPixels: layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS,
      widthPixels: TOPOLOGY_ALIGNER_WIDTH,
      heightPixels: TOPOLOGY_ALIGNER_HEIGHT
    };
  }
  if (role === "auxiliary" && isCoolerModule(module2.name, module2.type)) {
    const atmosphereTop = layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS;
    const leftUtilities = roleModules.filter((item) => isCoolerModule(item.name, item.type)).sort((left, right) => naturalCompare(left.name, right.name));
    const coolerIndex = Math.max(0, leftUtilities.findIndex((item) => item.name === module2.name));
    const hasAligner = roleModules.some((item) => isAlignerModule(item.name, item.type));
    return {
      leftPercent: 10,
      topPixels: atmosphereTop + (hasAligner ? 80 : 0) + coolerIndex * 80,
      widthPixels: TOPOLOGY_COOLER_WIDTH,
      heightPixels: TOPOLOGY_COOLER_HEIGHT
    };
  }
  if (role === "auxiliary" && isBufferModule(module2.name, module2.type)) {
    const atmosphereTop = layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS;
    const rightUtilities = roleModules.filter((item) => isBufferModule(item.name, item.type)).sort((left, right) => naturalCompare(left.name, right.name));
    const utilityIndex = Math.max(0, rightUtilities.findIndex((item) => item.name === module2.name));
    const utilityTop = atmosphereTop + utilityIndex * 68;
    return {
      leftPercent: 90,
      topPixels: utilityTop,
      widthPixels: TOPOLOGY_BUFFER_WIDTH,
      heightPixels: TOPOLOGY_BUFFER_HEIGHT
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
      topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS + row[1] - row[0] + rowIndex * rowGap
    };
  }
  const fallbackRow = role === "process" ? row[3] : row[7];
  return {
    leftPercent: distributedTopologyColumns(Math.max(roleCount, 1))[index] ?? 50,
    topPixels: fallbackRow,
    ...role === "process" ? { widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT } : {}
  };
}
function robotTopologyPosition(robotIndex, robotCount, environment, layout) {
  if (environment === "atmosphere") {
    const atmosphereTop = layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS;
    if (robotCount > 1) {
      return {
        leftPercent: distributedTopologyColumns(robotCount)[robotIndex] ?? 50,
        topPixels: atmosphereTop,
        widthPixels: TOPOLOGY_ROBOT_SIZE,
        heightPixels: TOPOLOGY_ROBOT_SIZE
      };
    }
    return {
      leftPercent: 50,
      topPixels: atmosphereTop,
      widthPixels: TOPOLOGY_ROBOT_SIZE,
      heightPixels: TOPOLOGY_ROBOT_SIZE
    };
  }
  if (layout === "cascade") {
    const upperCount = Math.max(1, robotCount - 1);
    return {
      leftPercent: robotIndex === 0 ? 50 : distributedTopologyColumns(upperCount)[robotIndex - 1] ?? 50,
      topPixels: robotIndex === 0 ? TOPOLOGY_CASCADE_LOWER_ROBOT_TOP : TOPOLOGY_CASCADE_UPPER_ROBOT_TOP,
      widthPixels: TOPOLOGY_ROBOT_SIZE,
      heightPixels: TOPOLOGY_ROBOT_SIZE
    };
  }
  return {
    leftPercent: 50,
    topPixels: (TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP + TOPOLOGY_SINGLE_PROCESS_LOWER_TOP) / 2,
    widthPixels: TOPOLOGY_ROBOT_SIZE,
    heightPixels: TOPOLOGY_ROBOT_SIZE
  };
}
function topologyVerticalExtent(positions) {
  if (!positions.length) return null;
  return {
    top: Math.min(...positions.map((position) => position.topPixels - (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2)),
    bottom: Math.max(...positions.map((position) => position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2))
  };
}
function interpolatedRobotAngle(start, end, progress) {
  let delta = (end - start) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return start + delta * Math.max(0, Math.min(1, progress));
}
function robotLoadLockPortal(robotName, moduleName, modulePositions, environment) {
  const normalizedModule = moduleName.trim().toUpperCase();
  const isAtmosphereRobot = environment ? environment === "atmosphere" : /^(ATR|ATM)/i.test(robotName);
  const isVacuumRobot = environment ? environment === "vacuum" : /^(VTR|VTM|VAC)/i.test(robotName);
  if (!isAtmosphereRobot && !isVacuumRobot) return moduleName;
  const preferred = ["LA", "LC"].includes(normalizedModule) ? isAtmosphereRobot ? "LC" : "LA" : ["LB", "LD"].includes(normalizedModule) ? isAtmosphereRobot ? "LD" : "LB" : moduleName;
  return modulePositions.has(preferred) ? preferred : moduleName;
}
function robotTargetTopologyPosition(robot, moduleName, modulePositions) {
  const normalizedModule = moduleName.trim().toUpperCase();
  if (robot.environment === "vacuum" && ["LA", "LB"].includes(normalizedModule)) {
    const leftLoadLock = modulePositions.get("LA");
    const rightLoadLock = modulePositions.get("LB");
    if (leftLoadLock && rightLoadLock) {
      return {
        leftPercent: (leftLoadLock.leftPercent + rightLoadLock.leftPercent) / 2,
        topPixels: (leftLoadLock.topPixels + rightLoadLock.topPixels) / 2,
        widthPixels: 0,
        heightPixels: 0
      };
    }
  }
  const portal = robotLoadLockPortal(robot.name, moduleName, modulePositions, robot.environment);
  return modulePositions.get(portal);
}
function selectedDecisionCandidate(decision) {
  if (!decision) return null;
  return decision.candidates.find((candidate) => candidate.selected) ?? decision.candidates.find((candidate) => candidate.actionId === decision.selectedActionId) ?? decision.candidates.find((candidate) => candidate.executed) ?? null;
}
function decisionTargetForRobot(robot, decision) {
  const candidate = selectedDecisionCandidate(decision);
  if (!candidate || candidate.robot !== robot.name) return "";
  if (candidate.source === robot.name) return candidate.destination;
  if (candidate.destination === robot.name) return candidate.source;
  return candidate.destination || candidate.source;
}
function isModuleFilteredOut(module2, hiddenFilters) {
  if (!hiddenFilters?.size) return false;
  const normalized = module2.name.trim().toUpperCase();
  const type = module2.type.trim().toLowerCase();
  return hiddenFilters.has("aligner") && (/^(AL|ALIGNER)$/.test(normalized) || type === "aligner") || hiddenFilters.has("cooler") && (/^(CL|COOL(?:ER)?)$/.test(normalized) || type === "cooler");
}
function renderEquipmentTopology(snapshot, decision, hiddenFilters, device) {
  const visibleModules = snapshot.modules.filter((module2) => !isTopologyHiddenModule(module2) && !isModuleFilteredOut(module2, hiddenFilters));
  const groups = topologyGroups(visibleModules);
  const destinations = candidateDestinations(decision);
  const atmosphereRobots = snapshot.robots.filter((robot) => robot.environment === "atmosphere" || !robot.environment && /^(ATR|ATM)/i.test(robot.name));
  const atmosphereNames = new Set(atmosphereRobots.map((robot) => robot.name));
  const vacuumRobots = snapshot.robots.filter((robot) => !atmosphereNames.has(robot.name));
  const layout = device ? detectDeviceTopologyLayout(device) : detectTopologyLayout(visibleModules, snapshot.robots.length);
  const processChamberViews = layout === "dual" ? expandDualProcessChambers(groups.processModules) : groups.processModules.map((module2) => ({ view: module2, sourceName: module2.name }));
  const processSourceNames = new Map(processChamberViews.map((item) => [item.view.name, item.sourceName]));
  const loadLockNameSet = new Set(groups.loadLocks.map((module2) => module2.name));
  const configuredLoadLockOrder = Object.keys(device?.Stations ?? {}).filter((name) => loadLockNameSet.has(name));
  const orderedLoadLockNames = configuredLoadLockOrder.length === groups.loadLocks.length ? configuredLoadLockOrder : groups.loadLocks.map((module2) => module2.name);
  const bridgeLoadLockNames = layout === "cascade" ? cascadeBridgeLoadLockNames(
    orderedLoadLockNames,
    device,
    vacuumRobots.map((robot) => robot.name)
  ) : /* @__PURE__ */ new Set();
  const modulePositions = /* @__PURE__ */ new Map();
  const positionModuleGroup = (modules, role) => modules.forEach((module2, index) => {
    const position = moduleTopologyPosition(module2, role, index, modules, layout, bridgeLoadLockNames);
    modulePositions.set(module2.name, position);
  });
  positionModuleGroup(processChamberViews.map((item) => item.view), "process");
  positionModuleGroup(groups.loadLocks, "lock");
  positionModuleGroup(groups.loadPorts, "port");
  positionModuleGroup(groups.auxiliaryModules, "auxiliary");
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
          heightPixels: TOPOLOGY_PROCESS_HEIGHT
        });
      }
    }
  }
  const robotPositions = /* @__PURE__ */ new Map();
  const positionRobotGroup = (robots, environment) => robots.forEach((robot, index) => {
    const position = robotTopologyPosition(index, robots.length, environment, layout);
    robotPositions.set(robot.name, position);
  });
  positionRobotGroup(vacuumRobots, "vacuum");
  positionRobotGroup(atmosphereRobots, "atmosphere");
  const allPositions = [
    ...modulePositions.values(),
    ...robotPositions.values()
  ];
  const minimumTop = allPositions.length ? Math.min(...allPositions.map((position) => position.topPixels - (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2)) : 0;
  const maximumBottom = allPositions.length ? Math.max(...allPositions.map((position) => position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2)) : TOPOLOGY_ITEM_SIZE;
  const verticalOffset = TOPOLOGY_CANVAS_PADDING - minimumTop;
  let canvasHeight = Math.max(
    520,
    Math.ceil(maximumBottom + verticalOffset + TOPOLOGY_CANVAS_PADDING)
  );
  for (const [name, position] of modulePositions) {
    modulePositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  for (const [name, position] of robotPositions) {
    robotPositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  const positionedModules = (modules) => modules.map((module2) => modulePositions.get(module2.name)).filter((position) => Boolean(position));
  const positionedRobots = (robots) => robots.map((robot) => robotPositions.get(robot.name)).filter((position) => Boolean(position));
  const interfaceLoadLocks = groups.loadLocks.filter((module2) => !bridgeLoadLockNames.has(module2.name));
  const vacuumExtent = topologyVerticalExtent([
    ...positionedModules(processChamberViews.map((item) => item.view)),
    ...positionedRobots(vacuumRobots),
    ...positionedModules(groups.loadLocks.filter((module2) => bridgeLoadLockNames.has(module2.name)))
  ]);
  const interfaceExtent = topologyVerticalExtent(positionedModules(interfaceLoadLocks));
  let atmosphereExtent = topologyVerticalExtent([
    ...positionedModules(groups.auxiliaryModules),
    ...positionedModules(groups.loadPorts),
    ...positionedRobots(atmosphereRobots)
  ]);
  if (interfaceExtent && atmosphereExtent) {
    const atmosphereOffset = interfaceExtent.bottom + 24 - atmosphereExtent.top;
    const shiftPosition = (position) => {
      if (position) position.topPixels += atmosphereOffset;
    };
    groups.auxiliaryModules.forEach((module2) => shiftPosition(modulePositions.get(module2.name)));
    groups.loadPorts.forEach((module2) => shiftPosition(modulePositions.get(module2.name)));
    atmosphereRobots.forEach((robot) => shiftPosition(robotPositions.get(robot.name)));
    atmosphereExtent = topologyVerticalExtent([
      ...positionedModules(groups.auxiliaryModules),
      ...positionedModules(groups.loadPorts),
      ...positionedRobots(atmosphereRobots)
    ]);
    const finalMaximumBottom = Math.max(
      ...[...modulePositions.values()].map((position) => position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2),
      ...[...robotPositions.values()].map((position) => position.topPixels + (position.heightPixels ?? TOPOLOGY_ITEM_SIZE) / 2)
    );
    canvasHeight = Math.max(520, Math.ceil(finalMaximumBottom + TOPOLOGY_CANVAS_PADDING));
  }
  const interfaceTop = interfaceExtent ? Math.max(12, interfaceExtent.top - 12) : Math.round(canvasHeight * 0.48);
  const interfaceBottom = interfaceExtent ? Math.min(canvasHeight - 12, interfaceExtent.bottom + 12) : interfaceTop;
  const vacuumTop = vacuumExtent ? Math.max(12, vacuumExtent.top - 24) : 12;
  const vacuumBottom = Math.max(vacuumTop + 120, interfaceTop - 12);
  const atmosphereTop = atmosphereExtent ? interfaceExtent ? interfaceBottom + 12 : Math.max(12, atmosphereExtent.top) : interfaceExtent ? interfaceBottom + 12 : Math.round(canvasHeight * 0.52);
  const atmosphereBottom = atmosphereExtent ? Math.min(canvasHeight - 12, atmosphereExtent.bottom + 24) : canvasHeight - 12;
  const machineAreaMarkup = `
    <div class="topology-zone topology-zone-vacuum" style="--zone-top:${vacuumTop}px;--zone-height:${Math.max(120, vacuumBottom - vacuumTop)}px" aria-hidden="true">
      <span><small>\u771F\u7A7A\u52A0\u5DE5\u533A</small></span>
    </div>
    ${interfaceExtent ? `<div class="topology-interface-bay" style="--zone-top:${interfaceTop}px;--zone-height:${Math.max(96, interfaceBottom - interfaceTop)}px" aria-hidden="true"><span>VACUUM / ATM INTERFACE</span></div>` : ""}
    <div class="topology-zone topology-zone-atmosphere" style="--zone-top:${atmosphereTop}px;--zone-height:${Math.max(120, atmosphereBottom - atmosphereTop)}px" aria-hidden="true">
      <span><small>\u5927\u6C14\u4F20\u8F93\u533A</small></span>
    </div>`;
  const renderModuleGroup = (modules, role) => modules.map((module2, roleIndex) => {
    const position = modulePositions.get(module2.name);
    if (!position) return "";
    const candidateSource = processSourceNames.get(module2.name) ?? module2.name;
    return `<div class="reference-module-position" style="--module-left:${position.leftPercent}%;--module-top:${position.topPixels}px">${renderModule(module2, role, destinations.get(candidateSource), layout, roleIndex)}</div>`;
  }).join("");
  const positionedLoadPorts = positionedModules(groups.loadPorts);
  const loadPortBaseMarkup = positionedLoadPorts.length ? (() => {
    const lefts = positionedLoadPorts.map((position) => position.leftPercent);
    const baseCenter = (Math.min(...lefts) + Math.max(...lefts)) / 2;
    const baseWidth = Math.max(...lefts) - Math.min(...lefts) + TOPOLOGY_LOADPORT_WIDTH / TOPOLOGY_VIEWBOX_WIDTH * 100;
    const baseTop = positionedLoadPorts[0].topPixels + TOPOLOGY_LOADPORT_HEIGHT / 2 + TOPOLOGY_LOADPORT_BASE_OVERHANG - TOPOLOGY_LOADPORT_BASE_HEIGHT / 2;
    return `<div class="load-port-shared-base" style="--base-left:${baseCenter.toFixed(2)}%;--base-width:${baseWidth.toFixed(2)}%;--base-top:${baseTop.toFixed(1)}px" aria-hidden="true"></div>`;
  })() : "";
  const moduleMarkup = [
    renderModuleGroup(processChamberViews.map((item) => item.view), "process"),
    renderModuleGroup(groups.loadLocks, "lock"),
    renderModuleGroup(groups.loadPorts, "port"),
    renderModuleGroup(groups.auxiliaryModules, "auxiliary")
  ].join("");
  const renderRobotGroup = (robots, environment) => robots.map((robot) => {
    const position = robotPositions.get(robot.name);
    if (!position) return "";
    const target = robot.target || decisionTargetForRobot(robot, decision);
    const targetPosition = robotTargetTopologyPosition(robot, target, modulePositions);
    const targetAngle = targetPosition ? Math.atan2(
      targetPosition.topPixels - position.topPixels,
      targetPosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
    ) : -Math.PI / 2;
    let armAngle = targetAngle;
    if (robot.isPreTrans && robot.source) {
      const sourcePortal = robotLoadLockPortal(robot.name, robot.source, modulePositions, robot.environment);
      const sourcePosition = modulePositions.get(sourcePortal);
      if (sourcePosition) {
        const sourceAngle = Math.atan2(
          sourcePosition.topPixels - position.topPixels,
          sourcePosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
        );
        armAngle = interpolatedRobotAngle(sourceAngle, targetAngle, robot.preTransProgress);
      }
    }
    const angleDegrees = armAngle * 180 / Math.PI;
    return `<div class="reference-robot-position" style="--robot-left:${position.leftPercent}%;--robot-top:${position.topPixels}px">${renderRobotHub(robot, environment, angleDegrees)}</div>`;
  }).join("");
  const robotMarkup = renderRobotGroup(vacuumRobots, "vacuum") + renderRobotGroup(atmosphereRobots, "atmosphere");
  return `
    <section class="equipment-schematic" data-topology-layout="${layout}" aria-label="\u5B8C\u6574\u8BBE\u5907\u62D3\u6251\u56DE\u653E">
      <div class="schematic-canvas reference-grid-canvas" style="--topology-canvas-height:${canvasHeight}px">
        ${machineAreaMarkup}
        ${loadPortBaseMarkup}
        ${moduleMarkup}
        ${robotMarkup}
      </div>
    </section>`;
}
function modelSeconds(value, sign = false) {
  if (value === null) return "\u2014";
  const prefix = sign && value > PERFORMANCE_DISPLAY_TOLERANCE ? "+" : "";
  return `${prefix}${value.toFixed(value >= 100 ? 0 : 1)}s`;
}
function modelPreference(value) {
  const percent = Math.max(0, value) * 100;
  if (percent > 0 && Math.round(percent) === 0) return "<1%";
  return `${Math.round(percent)}%`;
}
function decisionCandidatePath(candidate) {
  const robotHand = `${candidate.robot || "Robot"} \u624B\u4E0A`;
  if (candidate.kind === "pick") {
    return `${candidate.source || "\u2014"} \u2192 ${robotHand}`;
  }
  if (candidate.kind === "place") {
    return `${robotHand} \u2192 ${candidate.destination || "\u2014"}${candidate.destinationSlot ? ` \xB7 \u69FD ${candidate.destinationSlot}` : ""}`;
  }
  if (candidate.kind === "swap") {
    return `${robotHand} \u2194 ${candidate.destination || "\u2014"}${candidate.destinationSlot ? ` \xB7 \u69FD ${candidate.destinationSlot}` : ""}`;
  }
  const source = candidate.source || "\u5F53\u524D\u4F4D\u7F6E";
  const destination = candidate.destination || "\u2014";
  return `${source} \u2192 ${destination}${candidate.destinationSlot ? ` \xB7 \u69FD ${candidate.destinationSlot}` : ""}`;
}
function decisionSpaceSignature(decision) {
  const actionIds = decision.candidates.map((candidate) => candidate.actionId).filter(Boolean).sort();
  return JSON.stringify([decision.candidateCount, actionIds]);
}
function decisionBoundaryTimes(moves) {
  return [...new Set(
    moves.filter((move) => DECISION_COMPLETION_MOVE_TYPES.has(finiteNumber(move.MoveType, -1))).map((move) => finiteNumber(move.EndTime)).filter((time) => time >= 0)
  )].sort((left, right) => left - right);
}
function primitiveDecisionBoundaryTimes(moves) {
  return [...new Set(
    moves.filter((move) => PRIMITIVE_DECISION_COMPLETION_MOVE_TYPES.has(finiteNumber(move.MoveType, -1))).map((move) => finiteNumber(move.EndTime)).filter((time) => time >= 0)
  )].sort((left, right) => left - right);
}
function renderDecisionLens(decision, requestState = "idle", requestError = "") {
  if (!decision) {
    if (requestState === "loading") {
      return `
        <div class="decision-empty is-loading" role="status" aria-live="polite">
          <div class="visual-loader" aria-hidden="true"></div>
          <strong>\u6B63\u5728\u8BC4\u4F30\u5F53\u524D\u5408\u6CD5\u52A8\u4F5C</strong>
          <p>\u6B63\u5728\u91CD\u5EFA\u673A\u5668\u72B6\u6001\u5E76\u8FD0\u884C\u63A8\u8350\u6A21\u578B\u3002</p>
        </div>`;
    }
    if (requestState === "error") {
      return `
        <div class="decision-empty is-error" role="alert">
          <strong>\u63A8\u8350\u6A21\u578B\u8BC4\u4F30\u5931\u8D25</strong>
          <p>${escapeHtml(requestError || "\u65E0\u6CD5\u83B7\u53D6\u5F53\u524D\u5408\u6CD5\u52A8\u4F5C\uFF0C\u8BF7\u68C0\u67E5\u670D\u52A1\u72B6\u6001\u3002")}</p>
        </div>`;
    }
    return `
      <div class="decision-empty">
        <strong>\u5F53\u524D\u65F6\u523B\u6682\u65E0\u5408\u6CD5\u52A8\u4F5C</strong>
        <p>\u56DE\u653E\u5230\u4E0B\u4E00\u8BBE\u5907\u4E8B\u4EF6\u540E\u66F4\u65B0\u3002</p>
      </div>`;
  }
  if (decision.model === "dual-actor-e2e") {
    return renderDualActorDecisionLens(decision);
  }
  const shownText = decision.candidatesTruncated ? `\u5C55\u793A Top ${decision.shownCandidateCount} / ${decision.candidateCount}` : `${decision.candidateCount} \u4E2A\u53EF\u884C\u52A8\u4F5C`;
  const hasExplicitRecommendation = decision.candidates.some((candidate) => candidate.selected) || Boolean(decision.selectedActionId);
  const rankedCandidates = [...decision.candidates].sort((left, right) => Number(left.priorityDeferred) - Number(right.priorityDeferred) || right.policyPreference - left.policyPreference || left.rank - right.rank || left.actionId.localeCompare(right.actionId));
  const candidates = rankedCandidates.map((candidate, index) => {
    const preference = modelPreference(candidate.policyPreference);
    const isRecommendation = hasExplicitRecommendation ? candidate.selected || candidate.actionId === decision.selectedActionId : index === 0;
    const tags = `${isRecommendation ? '<span class="decision-tag is-recommendation">E2E\u63A8\u8350</span>' : ""}${candidate.executed ? '<span class="decision-tag is-plan">\u4E0E\u8BA1\u5212\u4E00\u81F4</span>' : ""}`;
    const delta = isRecommendation ? "\u0394 \u57FA\u51C6" : `\u0394 ${modelSeconds(candidate.makespanDelta, true)}`;
    return `
      <li class="decision-candidate">
        <div class="decision-candidate-rank" aria-label="\u7B2C ${index + 1} \u540D">${index + 1}</div>
        <div class="decision-candidate-main">
          <div class="decision-candidate-title"><strong>${escapeHtml(decisionCandidatePath(candidate))}</strong>${tags}</div>
          <small>${escapeHtml(candidate.robot || "Robot")} \xB7 ${escapeHtml(candidate.flowKind || candidate.kind)}</small>
          <div class="decision-candidate-detail">
            <span>\u5269\u4F59\u5DE5\u671F <strong>${modelSeconds(candidate.expectedRemainingMakespan)}</strong></span>
            <span>${delta}</span>
          </div>
        </div>
        <strong class="decision-candidate-preference" aria-label="E2E \u504F\u597D ${preference}">${preference}</strong>
      </li>`;
  }).join("");
  return `
    <section class="decision-candidate-section" aria-labelledby="decisionCandidatesTitle">
      <header>
        <strong id="decisionCandidatesTitle">\u51B3\u7B56 #${decision.decisionIndex} <small>@ ${formatSeconds(decision.time)}s</small></strong>
        <span>${escapeHtml(shownText)} \xB7 E2E \u6392\u5E8F</span>
      </header>
      ${candidates ? `<ol>${candidates}</ol>` : '<p class="decision-alternative-empty">\u5F53\u524D\u6CA1\u6709\u5408\u6CD5\u52A8\u4F5C</p>'}
    </section>`;
}
function renderDualActorDecisionLens(decision) {
  const groupsByActor = new Map(
    decision.candidateGroups.map((group) => [group.actor, group])
  );
  const groups = [
    { actor: "atmosphere", label: "\u5927\u6C14\u7AEF Actor", hint: "LoadPort \u2194 LoadLock" },
    { actor: "vacuum", label: "\u771F\u7A7A\u7AEF Actor", hint: "LoadLock \u2194 \u5DE5\u827A\u8154" }
  ].map((definition) => ({
    ...definition,
    group: groupsByActor.get(definition.actor) ?? null
  }));
  const groupMarkup = groups.map(({ actor, label, hint, group }) => {
    const rankedCandidates = [...group?.candidates ?? []].sort((left, right) => right.policyPreference - left.policyPreference || left.rank - right.rank || left.actionId.localeCompare(right.actionId));
    const shownText = group?.candidatesTruncated ? `Top ${group.shownCandidateCount} / ${group.candidateCount}` : `${group?.candidateCount ?? 0} \u4E2A\u539F\u5B50\u52A8\u4F5C`;
    const candidates = rankedCandidates.map((candidate, index) => {
      const preference = modelPreference(candidate.policyPreference);
      const isRecommendation = candidate.selected || candidate.actionId === group?.selectedActionId || !group?.selectedActionId && index === 0;
      const recommendationTag = isRecommendation ? `<span class="decision-tag is-recommendation is-${actor}">${actor === "atmosphere" ? "\u5927\u6C14\u7AEF\u63A8\u8350" : "\u771F\u7A7A\u7AEF\u63A8\u8350"}</span>` : "";
      const planTag = candidate.executed ? '<span class="decision-tag is-plan">\u4E0E\u8BA1\u5212\u4E00\u81F4</span>' : "";
      const remainingCost = candidate.expectedRemainingCost ?? candidate.expectedRemainingMakespan;
      const delta = isRecommendation ? "\u0394 \u57FA\u51C6" : `\u0394 ${modelSeconds(candidate.makespanDelta, true)}`;
      return `
        <li class="decision-candidate">
          <div class="decision-candidate-rank" aria-label="\u7B2C ${index + 1} \u540D">${index + 1}</div>
          <div class="decision-candidate-main">
            <div class="decision-candidate-title"><strong>${escapeHtml(decisionCandidatePath(candidate))}</strong>${recommendationTag}${planTag}</div>
            <small>${escapeHtml(candidate.robot || "Robot")} \xB7 ${escapeHtml(candidate.kind || "\u539F\u5B50\u52A8\u4F5C")}</small>
            <div class="decision-candidate-detail">
              <span>\u5269\u4F59\u6210\u672C <strong>${modelSeconds(remainingCost)}</strong></span>
              <span>${delta}</span>
            </div>
          </div>
          <strong class="decision-candidate-preference" aria-label="${escapeHtml(label)}\u504F\u597D ${preference}">${preference}</strong>
        </li>`;
    }).join("");
    return `
      <article class="dual-actor-recommendation is-${actor}" data-recommendation-actor="${actor}">
        <header>
          <div><strong>${label}</strong><small>${hint}</small></div>
          <span>${shownText} \xB7 \u72EC\u7ACB\u6392\u5E8F</span>
        </header>
        ${candidates ? `<ol>${candidates}</ol>` : '<p class="decision-alternative-empty">\u5F53\u524D\u63A7\u5236\u57DF\u6CA1\u6709\u5408\u6CD5\u539F\u5B50\u52A8\u4F5C</p>'}
      </article>`;
  }).join("");
  return `
    <section class="dual-actor-decision" aria-labelledby="dualActorDecisionTitle">
      <header class="dual-actor-decision-head">
        <strong id="dualActorDecisionTitle">\u51B3\u7B56 #${decision.decisionIndex} <small>@ ${formatSeconds(decision.time)}s</small></strong>
        <span>\u53CC Actor \xB7 ${decision.replayEvaluated ? "\u56DE\u653E\u91CD\u8BC4\u4F30" : "\u539F\u59CB\u6A21\u578B\u51B3\u7B56"}</span>
      </header>
      <div class="dual-actor-recommendation-list">${groupMarkup}</div>
    </section>`;
}
function formatPercent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}
function renderCategoryBars(resource, windowDuration) {
  return ACTIVITY_CATEGORIES.map((category) => {
    const duration = resource.categoryTimes[category];
    if (duration <= PERFORMANCE_DISPLAY_TOLERANCE || windowDuration <= PERFORMANCE_DISPLAY_TOLERANCE) return "";
    const width = Math.min(duration / windowDuration * 100, 100);
    return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds(duration)} s"></span>`;
  }).join("");
}
function groupedBottleneckResources(performance2) {
  const resources = performance2.resources;
  const byName = new Map(resources.map((resource) => [resource.name, resource]));
  const assigned = /* @__PURE__ */ new Set();
  const memberGroups = [];
  const addGroup = (members) => {
    const uniqueMembers = members.filter((member) => !assigned.has(member.name));
    if (!uniqueMembers.length) return;
    uniqueMembers.forEach((member) => assigned.add(member.name));
    memberGroups.push(uniqueMembers);
  };
  for (const candidate of performance2.bottleneckCandidates) {
    if (candidate.kind !== "process-group") continue;
    addGroup(candidate.resourceNames.map((name) => byName.get(name)).filter((resource) => Boolean(resource)));
  }
  const remainingProcess = resources.filter((resource) => resource.kind === "process" && !assigned.has(resource.name));
  addGroup(remainingProcess);
  addGroup(resources.filter((resource) => resource.kind === "loadlock" && resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE));
  addGroup(resources.filter((resource) => resource.kind === "loadport" && resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE));
  for (const resource of resources.filter((resource2) => resource2.kind === "robot" || resource2.kind === "auxiliary")) addGroup([resource]);
  const sameMembers = (candidate, names) => candidate.resourceNames.length === names.length && candidate.resourceNames.every((name) => names.includes(name));
  return memberGroups.map((members) => {
    const memberNames = members.map((member) => member.name).sort((left, right) => left.localeCompare(right, void 0, { numeric: true, sensitivity: "base" }));
    const memberCount = members.length;
    const categoryTimes = Object.fromEntries(ACTIVITY_CATEGORIES.map((category) => [
      category,
      members.reduce((sum, member) => sum + member.categoryTimes[category], 0) / memberCount
    ]));
    return {
      name: memberNames.join(" / "),
      memberNames,
      kind: members[0].kind,
      utilization: members.reduce((sum, member) => sum + member.utilization, 0) / memberCount,
      busyTime: members.reduce((sum, member) => sum + member.busyTime, 0) / memberCount,
      categoryTimes,
      candidate: performance2.bottleneckCandidates.find((candidate) => sameMembers(candidate, memberNames)) ?? null
    };
  }).filter((group) => group.busyTime > PERFORMANCE_DISPLAY_TOLERANCE).sort((left, right) => right.utilization - left.utilization || left.name.localeCompare(right.name, void 0, { numeric: true, sensitivity: "base" })).slice(0, 4);
}
function renderBottleneckAnalysis(performance2) {
  const { window } = performance2;
  const confidenceLabels = { high: "\u8BC1\u636E\u8F83\u5F3A", medium: "\u8BC1\u636E\u4E2D\u7B49", low: "\u8BC1\u636E\u8F83\u5F31" };
  const resourceKindLabels = {
    robot: "\u673A\u68B0\u624B",
    process: "\u5DE5\u827A\u8154",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "\u8F85\u52A9\u6A21\u5757"
  };
  const displayedResources = groupedBottleneckResources(performance2);
  const resourceRows = (items) => items.map((resource, index) => {
    const candidate = resource.candidate;
    const evidenceScore = candidate ? Math.round(candidate.score * 100) : null;
    const evidenceLabel = candidate ? confidenceLabels[candidate.confidence] : "\u672A\u5165\u9009\u5019\u9009";
    const resourceLabel = resource.memberNames.length > 1 ? `${resourceKindLabels[resource.kind]} \xB7 ${resource.memberNames.length} \u53F0\u5E73\u5747` : resourceKindLabels[resource.kind];
    return `
      <li class="resource-utilization-row">
        <div class="resource-utilization-name">
          <span>${index + 1}</span>
          <div><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resourceLabel)}</small></div>
        </div>
        <strong class="resource-utilization-percent">${formatPercent(resource.utilization)}</strong>
        <div class="utilization-track" aria-label="${escapeHtml(resource.name)} \u5360\u7528\u7387 ${formatPercent(resource.utilization)}">${renderCategoryBars(resource, window.duration)}</div>
        <small class="resource-utilization-time">${formatSeconds(resource.busyTime)} s</small>
        <div class="resource-evidence-score"><strong>${evidenceScore ?? "\u2014"}</strong><small>${evidenceLabel}</small></div>
      </li>`;
  }).join("");
  const legend = ACTIVITY_CATEGORIES.map((category) => `<span><i class="performance-swatch category-${category}"></i>${ACTIVITY_CATEGORY_LABELS[category]}</span>`).join("");
  return `
    <header class="bottleneck-analysis-head">
      <div>
        <strong>\u74F6\u9888\u5206\u6790</strong>
      </div>
      <div class="bottleneck-analysis-actions">
        <button class="bottleneck-analysis-help" id="bottleneckAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="bottleneckAnalysisHelpDialog">\u74F6\u9888\u5206\u6790\u8BF4\u660E</button>
        <label class="bottleneck-window-control"><span class="visually-hidden">\u7EDF\u8BA1\u53E3\u5F84</span><div class="bottleneck-window-slot"></div></label>
      </div>
    </header>
    <div class="resource-utilization-head" aria-hidden="true"><span>\u8D44\u6E90</span><span>\u5229\u7528\u7387</span><span>\u5360\u7528\u7EC4\u6210</span><span>\u6D3B\u8DC3\u65F6\u957F</span><span>\u74F6\u9888\u8BC1\u636E\u5F97\u5206</span></div>
    <ol class="resource-utilization-list">
      ${resourceRows(displayedResources)}
    </ol>
    <div class="performance-legend" aria-label="\u5360\u7528\u7EC4\u6210\u56FE\u4F8B">${legend}</div>
  `;
}
function renderResidenceMetricChart(samples, kind) {
  const definitions = {
    system: { title: "\u7CFB\u7EDF\u9A7B\u7559\u65F6\u95F4", label: "\u7CFB\u7EDF\u9A7B\u7559", value: (sample) => sample.duration },
    chamber: { title: "\u8154\u5BA4\u9A7B\u7559\u65F6\u95F4", label: "\u8154\u5BA4\u9A7B\u7559", value: (sample) => sample.chamberDwellSeconds ?? 0 },
    robot: { title: "\u673A\u5668\u624B\u9A7B\u7559\u65F6\u95F4", label: "\u673A\u5668\u624B\u9A7B\u7559", value: (sample) => sample.robotDwellSeconds ?? 0 }
  };
  const metric = definitions[kind];
  const values = samples.map(metric.value);
  const meanSeconds = values.reduce((sum, value) => sum + value, 0) / values.length;
  const maximumSeconds = Math.max(...values, 1);
  const plotHeight = 120;
  const scaleMaximum = maximumSeconds * 1.08;
  const meanHeight = Math.min(meanSeconds / scaleMaximum * plotHeight, plotHeight);
  const bars = samples.map((sample) => {
    const seconds = metric.value(sample);
    const height = Math.max(seconds / scaleMaximum * plotHeight, 2);
    const wafer = escapeHtml(String(sample.wafer));
    const duration = formatSeconds(seconds);
    return `
      <li class="residence-metric-bar-item" role="img" aria-label="\u6676\u5706 ${wafer}\uFF0C${metric.label} ${duration} \u79D2" title="\u6676\u5706 ${wafer} \xB7 ${metric.label} ${duration} s">
        <strong>${duration}</strong>
        <span class="residence-metric-bar residence-bar-${kind}"><i style="height:${height.toFixed(2)}px"></i></span>
        <small>${wafer}</small>
      </li>`;
  }).join("");
  return `
    <div class="residence-metric-chart residence-metric-${kind}" data-residence-metric-chart="${kind}"${kind === "system" ? "" : " hidden"}>
      <div class="residence-metric-scroll" tabindex="0" aria-label="\u9010\u7247\u6676\u5706${metric.title}\u67F1\u72B6\u56FE\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8">
        <div class="residence-metric-plot">
          <div class="residence-metric-mean-line" style="bottom:${(26 + meanHeight).toFixed(2)}px"><span>\u5E73\u5747 ${formatSeconds(meanSeconds)} s</span></div>
          <ol class="residence-metric-bars">${bars}</ol>
        </div>
      </div>
    </div>`;
}
function renderWaferResidenceChart(performance2) {
  const samples = performance2.waferSystemResidenceTimes ?? [];
  const helpButton = `<button class="bottleneck-analysis-help residence-analysis-help" id="residenceAnalysisHelpButton" type="button" aria-haspopup="dialog" aria-controls="residenceAnalysisHelpDialog">\u8BF4\u660E</button>`;
  if (!samples.length) {
    return `
      <header class="residence-chart-head"><strong>\u9A7B\u7559\u65F6\u95F4\u5206\u6790</strong>${helpButton}</header>
      <div class="residence-chart-empty">\u5F53\u524D\u7ED3\u679C\u4E2D\u6CA1\u6709\u5B8C\u6210\u5F80\u8FD4 LoadPort \u7684\u6676\u5706\u3002</div>`;
  }
  const systemValues = samples.map((sample) => sample.duration);
  const systemMeanSeconds = systemValues.reduce((sum, value) => sum + value, 0) / systemValues.length;
  const maximumSeconds = Math.max(...systemValues);
  const minimumSeconds = Math.min(...systemValues);
  const rangeToMinimumPercent = minimumSeconds > PERFORMANCE_DISPLAY_TOLERANCE ? (maximumSeconds - minimumSeconds) / minimumSeconds * 100 : null;
  const chamberMeanSeconds = samples.reduce((sum, sample) => sum + (sample.chamberDwellSeconds ?? 0), 0) / samples.length;
  const robotMeanSeconds = samples.reduce((sum, sample) => sum + (sample.robotDwellSeconds ?? 0), 0) / samples.length;
  const chamberValues = samples.map((sample) => sample.chamberDwellSeconds ?? 0);
  const robotValues = samples.map((sample) => sample.robotDwellSeconds ?? 0);
  const summary = (kind, content) => `<div class="residence-chart-summary" data-residence-summary="${kind}"${kind === "system" ? "" : " hidden"}>${content}</div>`;
  return `
    <header class="residence-chart-head">
      <strong>\u9A7B\u7559\u65F6\u95F4\u5206\u6790</strong>
      <label class="residence-metric-control"><span class="visually-hidden">\u9009\u62E9\u9A7B\u7559\u65F6\u95F4\u56FE\u8868</span><select id="residenceMetricSelect" aria-label="\u9009\u62E9\u9A7B\u7559\u65F6\u95F4\u56FE\u8868">
        <option value="system">\u7CFB\u7EDF\u9A7B\u7559\u65F6\u95F4</option>
        <option value="chamber">\u8154\u5BA4\u9A7B\u7559\u65F6\u95F4</option>
        <option value="robot">\u673A\u5668\u624B\u9A7B\u7559\u65F6\u95F4</option>
      </select></label>
      ${summary("system", `
        <span>\u7CFB\u7EDF\u5E73\u5747 <b>${formatSeconds(systemMeanSeconds)} s</b></span>
        <span>\u7CFB\u7EDF\u6700\u5927 <b>${formatSeconds(maximumSeconds)} s</b></span>
        <span>\u6781\u5DEE/\u6700\u5C0F\u503C <b>${rangeToMinimumPercent === null ? "\u2014" : `${rangeToMinimumPercent.toFixed(1)}%`}</b></span>
        <span>\u6837\u672C <b>${samples.length} \u7247</b></span>`)}
      ${summary("chamber", `
        <span>\u8154\u5BA4\u5E73\u5747 <b>${formatSeconds(chamberMeanSeconds)} s</b></span>
        <span>\u8154\u5BA4\u6700\u5927 <b>${formatSeconds(Math.max(...chamberValues))} s</b></span>
        <span>\u8154\u5BA4\u7D2F\u8BA1 <b>${formatSeconds(chamberValues.reduce((sum, value) => sum + value, 0))} s</b></span>
        <span>\u6837\u672C <b>${samples.length} \u7247</b></span>`)}
      ${summary("robot", `
        <span>\u673A\u5668\u624B\u5E73\u5747 <b>${formatSeconds(robotMeanSeconds)} s</b></span>
        <span>\u673A\u5668\u624B\u6700\u5927 <b>${formatSeconds(Math.max(...robotValues))} s</b></span>
        <span>\u673A\u5668\u624B\u7D2F\u8BA1 <b>${formatSeconds(robotValues.reduce((sum, value) => sum + value, 0))} s</b></span>
        <span>\u6837\u672C <b>${samples.length} \u7247</b></span>`)}
      ${helpButton}
    </header>
    <div class="residence-chart-body">
      ${renderResidenceMetricChart(samples, "system")}
      ${renderResidenceMetricChart(samples, "chamber")}
      ${renderResidenceMetricChart(samples, "robot")}
    </div>`;
}
function renderSchedulePerformance(performance2) {
  const window = performance2.window;
  const loadLockEfficiency = performance2.loadLockEfficiency ?? {
    cycleCount: 0,
    waferCycleCount: 0,
    wafersPerCycle: 0,
    fullLoadCycleCount: 0,
    emptyLoadCycleCount: 0,
    fullLoadCycleRatio: 0,
    emptyLoadCycleRatio: 0
  };
  return `
    <section class="result-card overview-card">
      <header class="overview-head"><strong>KPI \u603B\u89C8</strong></header>
      <div class="performance-summary">
        <div>
          <span>\u7EDF\u8BA1\u7A97\u53E3</span>
          <strong>${escapeHtml(window.label)} \xB7 ${formatSeconds(window.duration)} s</strong>
          <small>\u5254\u9664\u5F00\u5934 ${formatSeconds(window.trimmedStart)} s / \u7ED3\u5C3E ${formatSeconds(window.trimmedEnd)} s</small>
        </div>
        <div>
          <span>\u4EA7\u80FD</span>
          <strong>${performance2.throughputPerHour > 0 ? `${performance2.throughputPerHour.toFixed(1)} \u7247/h` : "\u2014"}</strong>
          <small>${performance2.throughputSampleCount ? `\u56FA\u5B9A ${performance2.throughputSampleCount} \u7247\u6837\u672C \xB7 \u5254\u9664\u524D 15 \u7247 \xB7 \u5B8C\u5DE5\u7247\u6570\u4E25\u683C\u5927\u4E8E 150` : escapeHtml(performance2.throughputReason || "\u6837\u672C\u4E0D\u8DB3\uFF0C\u5B8C\u5DE5\u7247\u6570\u5FC5\u987B\u5927\u4E8E 150")}</small>
        </div>
        <div>
          <span>LoadLock \u5229\u7528\u6548\u7387</span>
          <strong>${loadLockEfficiency.cycleCount ? `${loadLockEfficiency.wafersPerCycle.toFixed(2)} \u7247/\u5468\u671F` : "\u2014"}</strong>
          <small>${loadLockEfficiency.cycleCount ? `${loadLockEfficiency.waferCycleCount} \u7247\xB7\u5468\u671F / ${loadLockEfficiency.cycleCount} \u4E2A\u5B8C\u6574\u62BD\u5145\u6C14\u5468\u671F \xB7 \u6EE1\u8F7D ${formatPercent(loadLockEfficiency.fullLoadCycleRatio)}\uFF08${loadLockEfficiency.fullLoadCycleCount}/${loadLockEfficiency.cycleCount}\uFF09\xB7 \u7A7A\u8F7D ${formatPercent(loadLockEfficiency.emptyLoadCycleRatio)}\uFF08${loadLockEfficiency.emptyLoadCycleCount}/${loadLockEfficiency.cycleCount}\uFF09` : "\u6CA1\u6709\u5B8C\u6574\u7684\u62BD\u6C14\u2014\u5145\u6C14\u5468\u671F"}</small>
        </div>
        <div>
          <span>CPU Time</span>
          <strong>${Number.isFinite(performance2.cpuTimeMs) ? `${Number(performance2.cpuTimeMs).toFixed(1)} ms` : "\u2014"}</strong>
          <small>\u672C\u6B21\u8FD0\u884C\u7D2F\u8BA1 CPU \u65F6\u95F4</small>
        </div>
        <div>
          <span>\u5E73\u5747\u91CD\u7B97\u65F6\u95F4</span>
          <strong>${Number.isFinite(performance2.averageRecomputeTimeMs) ? `${Number(performance2.averageRecomputeTimeMs).toFixed(1)} ms` : "\u2014"}</strong>
          <small>${performance2.recomputeCount ? `CPU Time / ${performance2.recomputeCount} \u6B21\u91CD\u7B97` : "\u6CA1\u6709\u91CD\u7B97\u8F6E\u6B21"}</small>
        </div>
      </div>
    </section>

    <section class="result-card wafer-residence-card">
      ${renderWaferResidenceChart(performance2)}
    </section>

    <section class="result-card bottleneck-analysis-card">
      ${renderBottleneckAnalysis(performance2)}
    </section>

    `;
}
var VisualizationWorkspace = class {
  root;
  elements;
  device = null;
  analysisRoutes = [];
  analysisRounds = [];
  moves = [];
  decisionTrace = [];
  replayPlan = null;
  recommendationModel = "e2e-ctq";
  liveDecision = null;
  liveDecisionKey = "";
  decisionBoundaries = [];
  primitiveDecisionBoundaries = [];
  pauseOnDecisionChange = false;
  pauseTriggeredByDecisionChange = false;
  replayDecisionCache = /* @__PURE__ */ new Map();
  pendingReplayDecisionKeys = /* @__PURE__ */ new Set();
  replayDecisionErrorKey = "";
  replayDecisionErrorMessage = "";
  replayDecisionRequestVersion = 0;
  sourceName = "";
  resultUrl = "";
  analysisResultId = "";
  analysis = null;
  cpuTimeMs = null;
  recomputeCount = 0;
  bottleneckSummary = null;
  analysisRequestVersion = 0;
  time = 0;
  playing = false;
  liveSolving = false;
  /** 外部（Schedule-AlphaGo 搜索面板）接管右侧决策镜头时跳过本类每帧覆盖。 */
  externalDecisionLensOwner = false;
  playbackSpeed = DEFAULT_PLAYBACK_SPEED;
  performanceWindowMode = "steady";
  animationFrame = 0;
  previousFrameTime = 0;
  previousRenderTime = 0;
  /** 绑定页面事件并初始化空状态。 */
  constructor(root) {
    this.root = root;
    this.elements = collectElements(root);
    this.bindEvents();
    this.updatePlayButton();
    this.updatePauseOnDecisionChangeButton();
    this.updateRecommendationModelControl();
    this.setTopologyVisible(false);
  }
  /** 更新当前设备拓扑；已有 MoveList 会立即按新拓扑重绘。 */
  setDevice(device) {
    this.device = device ? structuredClone(device) : null;
    if (this.moves.length) {
      this.render();
      void this.renderPerformance();
    }
  }
  /** 加载浏览器中选择的 MoveList 文件。 */
  async loadFile(file) {
    const payload = JSON.parse(await file.text());
    const metadata = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.RunMetricsMetadata ?? payload.ProductionMetricsMetadata : null;
    const rawCpuTimeMs = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Number(metadata.cpuTimeMs ?? Number(metadata.calculationSeconds) * 1e3) : Number.NaN;
    const recomputePoints = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.RecomputePoints : null;
    const metadataRecomputeCount = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Number(metadata.recomputeCount) : Number.NaN;
    const rawRecomputeCount = Number.isFinite(metadataRecomputeCount) ? metadataRecomputeCount : Array.isArray(recomputePoints) ? recomputePoints.length : 0;
    await this.loadMoves(
      normalizeMovePayload(payload),
      normalizeDecisionTrace(payload),
      file.name,
      "",
      "",
      Number.isFinite(rawCpuTimeMs) ? Math.max(rawCpuTimeMs, 0) : null,
      Number.isFinite(rawRecomputeCount) ? Math.max(0, Math.trunc(rawRecomputeCount)) : 0
    );
  }
  /** 从后端保存的运行结果加载 MoveList。 */
  async loadResult(resultIdOrUrl, sourceName = "\u5F53\u524D\u8FD0\u884C\u7ED3\u679C") {
    const resultUrl = resultIdOrUrl.startsWith("/") ? resultIdOrUrl : `/api/results/${encodeURIComponent(resultIdOrUrl)}`;
    this.setLoading(true, "\u6B63\u5728\u52A0\u8F7D\u8FD0\u884C\u7ED3\u679C\u2026");
    try {
      const response = await fetch(resultUrl, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === "object" ? String(payload.error ?? "") : "";
        throw new Error(message || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
      }
      const resultId = resultUrl.startsWith("/api/results/") ? decodeURIComponent(resultUrl.slice("/api/results/".length)) : "";
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const replayContext = payload.ReplayContext;
        if (replayContext && typeof replayContext === "object" && !Array.isArray(replayContext)) {
          const embeddedPlan = replayContext.plan;
          if (embeddedPlan && typeof embeddedPlan === "object" && !Array.isArray(embeddedPlan)) {
            this.setReplayPlan(embeddedPlan);
          }
        }
      }
      await this.loadMoves(
        normalizeMovePayload(payload),
        normalizeDecisionTrace(payload),
        sourceName,
        resultUrl,
        resultId,
        null,
        0
      );
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  /** 提供后端构建工序容量上下文所需的原始 Route 和轮次配置。 */
  setAnalysisConfiguration(routes, rounds) {
    this.analysisRoutes = structuredClone(routes ?? []);
    this.analysisRounds = structuredClone(rounds ?? []);
    if (this.moves.length) void this.renderPerformance();
  }
  /** 保存 Machine 回放所需的完整计划；任意来源 MoveList 都使用该计划实时评分。 */
  setReplayPlan(plan) {
    this.replayPlan = plan ? structuredClone(plan) : null;
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.replayDecisionErrorKey = "";
    this.replayDecisionErrorMessage = "";
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.decisionBoundaries = decisionBoundaryTimes(this.moves);
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(this.moves);
    this.replayDecisionRequestVersion += 1;
    if (this.moves.length) this.render();
  }
  /** 让 Schedule-AlphaGo 搜索面板接管右侧“合法动作空间”的渲染。 */
  setExternalDecisionLensOwner(owner) {
    this.externalDecisionLensOwner = owner;
  }
  /** 在完整 MoveList 返回前显示初始拓扑，并进入增量求解状态。 */
  beginLiveSolve(plan, sourceName = "Schedule-AlphaGo \u5B9E\u65F6\u6C42\u89E3") {
    this.pause();
    this.liveSolving = true;
    this.moves = [];
    this.decisionTrace = [];
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
    this.showSingleResult();
    this.setTopologyVisible(true);
    this.render(buildWorkspaceSnapshot([], this.device, 0));
  }
  /** 用已提交根动作产生的累计 MoveList 推进实时拓扑。 */
  updateLiveMoves(rawMoves, followLatest = true, animateToLatest = false) {
    if (!this.liveSolving || !rawMoves.length) return;
    const previousTime = this.time;
    this.pause();
    this.moves = normalizeMovePayload({ MoveList: rawMoves });
    this.decisionBoundaries = decisionBoundaryTimes(this.moves);
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(this.moves);
    const latestSnapshot = buildWorkspaceSnapshot(
      this.moves,
      this.device,
      Number.POSITIVE_INFINITY
    );
    this.elements.range.max = String(latestSnapshot.endTime);
    this.elements.range.step = latestSnapshot.endTime > 1e4 ? "1" : "0.1";
    if (animateToLatest && followLatest && latestSnapshot.endTime > previousTime + PERFORMANCE_DISPLAY_TOLERANCE) {
      this.time = Math.max(0, Math.min(previousTime, latestSnapshot.endTime));
      this.elements.range.value = String(this.time);
      this.render(buildWorkspaceSnapshot(this.moves, this.device, this.time));
      this.play();
      return;
    }
    this.time = followLatest ? latestSnapshot.endTime : Math.min(this.time, latestSnapshot.endTime);
    this.render(buildWorkspaceSnapshot(this.moves, this.device, this.time));
  }
  /** 把拓扑回放定位到某个根决策已经提交后的时刻。 */
  seekTo(time) {
    if (!this.moves.length) return;
    const bounded = Math.max(
      0,
      Math.min(finiteNumber(time), finiteNumber(this.elements.range.max))
    );
    this.time = bounded;
    this.elements.range.value = String(bounded);
    this.render();
  }
  /** 切换到独立拓扑回放标签。 */
  showPlayback() {
    const tab = this.root.querySelector('[data-tab-target="playback"]');
    tab?.click();
  }
  /** 返回与诊断面板一致的稳态瓶颈候选利用率，供运行结果摘要复用。 */
  getBottleneckUtilization() {
    return this.bottleneckSummary ? structuredClone(this.bottleneckSummary) : null;
  }
  /** 返回当前 MoveList 在前端回放终点识别出的持片满腔死锁。 */
  getTerminalDeadlock() {
    return detectTerminalPlaybackDeadlock(this.moves, this.device, this.replayPlan);
  }
  /** 切换到工作台标签。 */
  show() {
    if (this.moves.length) this.showSingleResult();
    const tab = this.root.querySelector('[data-tab-target="workspace"]');
    tab?.click();
    this.elements.performanceWindow.focus({ preventScroll: true });
  }
  /** 显示测试组统计，并隐藏当前单例诊断；独立回放页保留已加载的数据。 */
  showGroupAnalysis(markup) {
    this.pause();
    this.elements.empty.hidden = true;
    this.elements.content.hidden = true;
    this.elements.groupAnalysis.innerHTML = markup;
    this.elements.groupAnalysis.hidden = false;
  }
  /** 停止播放并释放动画帧。 */
  destroy() {
    this.pause();
  }
  /** 清除旧测试结果，避免切换测试后继续误看上一份 MoveList。 */
  clear() {
    this.pause();
    this.liveSolving = false;
    this.moves = [];
    this.decisionTrace = [];
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.decisionBoundaries = [];
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
      <strong>\u7B49\u5F85\u5206\u6790\u6570\u636E</strong>
      <span>\u8FD0\u884C\u4E00\u6B21\u8BA1\u5212\uFF0C\u6216\u5728\u62D3\u6251\u56DE\u653E\u754C\u9762\u5BFC\u5165\u5DF2\u6709\u7684 MoveList JSON \u6587\u4EF6\u540E\u67E5\u770B\u7ED3\u679C\u5206\u6790\u3002</span>`;
    this.elements.playbackEmpty.classList.remove("is-loading", "is-error");
    this.elements.playbackEmpty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 7.3 2.8 2.8M17 7.3l-2.8 2.8M7 16.7l2.8-2.8M17 16.7l-2.8-2.8"/></svg>
      <strong>\u7B49\u5F85 MoveList</strong>
      <span>\u8FD0\u884C\u4E00\u6B21\u8BA1\u5212\uFF0C\u6216\u5BFC\u5165\u5DF2\u6709\u7684 MoveList JSON \u6587\u4EF6\u540E\u67E5\u770B\u8BBE\u5907\u62D3\u6251\u5E76\u5F00\u59CB\u56DE\u653E\u3002</span>`;
  }
  /** 接收规范化后的 MoveList 并重置时间轴。 */
  async loadMoves(moves, decisionTrace, sourceName, resultUrl, analysisResultId, cpuTimeMs = null, recomputeCount = 0) {
    if (!moves.length) throw new Error("MoveList \u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5EFA\u7ACB\u53EF\u89C6\u5316\u56DE\u653E");
    this.pause();
    this.liveSolving = false;
    this.moves = moves;
    this.decisionBoundaries = decisionBoundaryTimes(moves);
    this.primitiveDecisionBoundaries = primitiveDecisionBoundaryTimes(moves);
    this.decisionTrace = alignOriginalDecisionTraceToMoves(decisionTrace, moves);
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
    const snapshot = buildWorkspaceSnapshot(this.moves, this.device, 0);
    this.time = 0;
    this.elements.range.min = "0";
    this.elements.range.max = String(snapshot.endTime);
    this.elements.range.step = snapshot.endTime > 1e4 ? "1" : "0.1";
    this.elements.range.value = "0";
    this.elements.range.disabled = false;
    this.elements.playButton.disabled = false;
    this.elements.openGantt.href = resultUrl ? `/movelist_gantt_viewer.html?src=${encodeURIComponent(resultUrl)}` : "#";
    this.elements.openGantt.setAttribute("aria-disabled", resultUrl ? "false" : "true");
    this.elements.resultButton.disabled = false;
    this.showSingleResult();
    this.setTopologyVisible(true);
    this.updateRecommendationModelControl();
    this.render(snapshot);
    await this.renderPerformance();
  }
  /** 绑定文件、时间轴、播放和快捷控制事件。 */
  bindEvents() {
    this.elements.importButton?.addEventListener("click", () => this.elements.fileInput.click());
    this.elements.fileInput.addEventListener("change", () => {
      const file = this.elements.fileInput.files?.item(0);
      if (!file) return;
      this.loadFile(file).catch((error) => this.showError(error instanceof Error ? error.message : String(error))).finally(() => {
        this.elements.fileInput.value = "";
      });
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
    this.elements.recommendationModel.addEventListener("change", () => {
      this.recommendationModel = this.elements.recommendationModel.value === "dual-actor-e2e" ? "dual-actor-e2e" : "e2e-ctq";
      this.liveDecision = null;
      this.liveDecisionKey = "";
      this.pendingReplayDecisionKeys.clear();
      this.replayDecisionErrorKey = "";
      this.replayDecisionErrorMessage = "";
      this.replayDecisionRequestVersion += 1;
      this.updateRecommendationModelControl();
      this.updatePauseOnDecisionChangeButton();
      this.render();
    });
    this.elements.speed.addEventListener("change", () => {
      this.playbackSpeed = Math.max(0.25, finiteNumber(this.elements.speed.value, DEFAULT_PLAYBACK_SPEED));
    });
    this.elements.performanceWindow.addEventListener("change", () => {
      this.performanceWindowMode = this.elements.performanceWindow.value === "full" ? "full" : "steady";
      void this.renderPerformance();
    });
    this.elements.resultButton.addEventListener("click", () => this.show());
    this.elements.openGantt.addEventListener("click", (event) => {
      if (this.elements.openGantt.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }
  /** 从当前时间开始播放；到达末尾时自动回到起点。 */
  play() {
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
    this.animationFrame = requestAnimationFrame((timestamp) => this.tick(timestamp));
  }
  /** 暂停回放并保留当前时间。 */
  pause(triggeredByDecisionChange = false) {
    this.playing = false;
    this.pauseTriggeredByDecisionChange = triggeredByDecisionChange;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.updatePlayButton();
    this.updatePauseOnDecisionChangeButton();
  }
  /** 推进播放时钟，并按固定上限刷新 DOM。 */
  tick(timestamp) {
    if (!this.playing) return;
    const elapsedSeconds = Math.max(0, timestamp - this.previousFrameTime) / 1e3;
    this.previousFrameTime = timestamp;
    const endTime = finiteNumber(this.elements.range.max);
    const previousTime = this.time;
    const advancedTime = Math.min(endTime, previousTime + elapsedSeconds * this.playbackSpeed);
    const nextDecisionBoundary = this.pauseOnDecisionChange ? this.currentDecisionBoundaries().find((boundary) => boundary > previousTime + PERFORMANCE_DISPLAY_TOLERANCE && boundary <= advancedTime + PERFORMANCE_DISPLAY_TOLERANCE) : void 0;
    this.time = nextDecisionBoundary ?? advancedTime;
    this.elements.range.value = String(this.time);
    if (nextDecisionBoundary !== void 0) {
      this.previousRenderTime = timestamp;
      this.render();
      this.pause(true);
      return;
    }
    if (timestamp - this.previousRenderTime >= PLAYBACK_FRAME_INTERVAL_MS || this.time >= endTime) {
      this.previousRenderTime = timestamp;
      this.render();
    }
    if (!this.playing) return;
    if (this.time >= endTime) {
      this.pause();
      return;
    }
    this.animationFrame = requestAnimationFrame((nextTimestamp) => this.tick(nextTimestamp));
  }
  /** 同步播放按钮的图标和无障碍文本。 */
  updatePlayButton() {
    this.elements.playButton.innerHTML = this.playing ? `${icon("pause")}<span>\u6682\u505C</span>` : `${icon("play")}<span>\u64AD\u653E</span>`;
    this.elements.playButton.setAttribute("aria-label", this.playing ? "\u6682\u505C\u56DE\u653E" : "\u64AD\u653E\u56DE\u653E");
    this.elements.playButton.classList.toggle("is-playing", this.playing);
  }
  /** 同步决策空间自动暂停按钮的开关、触发状态和无障碍文本。 */
  updatePauseOnDecisionChangeButton() {
    const state = this.pauseTriggeredByDecisionChange ? "\u5DF2\u6682\u505C" : this.pauseOnDecisionChange ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED";
    const decisionKind = this.recommendationModel === "dual-actor-e2e" ? "\u539F\u5B50\u52A8\u4F5C\u51B3\u7B56" : "\u5B8C\u6574\u4E8B\u52A1\u51B3\u7B56";
    this.elements.pauseOnDecisionChangeButton.innerHTML = `
      <span class="decision-switch-copy"><span>\u4E0B\u4E00\u51B3\u7B56\u65F6\u6682\u505C</span><strong>${state}</strong></span>
      <span class="decision-switch-track" aria-hidden="true"><i></i></span>`;
    this.elements.pauseOnDecisionChangeButton.setAttribute("aria-pressed", String(this.pauseOnDecisionChange));
    this.elements.pauseOnDecisionChangeButton.setAttribute("aria-checked", String(this.pauseOnDecisionChange));
    this.elements.pauseOnDecisionChangeButton.setAttribute(
      "aria-label",
      this.pauseTriggeredByDecisionChange ? `\u5DF2\u5230\u8FBE\u4E0B\u4E00\u4E2A${decisionKind}\uFF0C\u56DE\u653E\u5DF2\u6682\u505C` : `\u5230\u4E0B\u4E00\u4E2A${decisionKind}\u65F6\u81EA\u52A8\u6682\u505C\uFF1A${this.pauseOnDecisionChange ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED"}`
    );
    this.elements.pauseOnDecisionChangeButton.classList.toggle("is-active", this.pauseOnDecisionChange);
    this.elements.pauseOnDecisionChangeButton.classList.toggle("is-triggered", this.pauseTriggeredByDecisionChange);
  }
  /** 切换单例分析模式，测试组统计与单例诊断不会同时出现。 */
  showSingleResult() {
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.empty.hidden = true;
    this.elements.content.hidden = false;
    this.elements.playbackEmpty.hidden = true;
  }
  /** 统一切换独立回放页中的概要、时间轴、拓扑与当前动作。 */
  setTopologyVisible(visible) {
    if (!visible) this.pause();
    this.elements.topologyPlayback.hidden = !visible;
    this.elements.playbackEmpty.hidden = visible;
  }
  /** 绘制当前时间对应的设备快照。 */
  render(prebuiltSnapshot) {
    if (!this.moves.length && !this.liveSolving) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(this.moves, this.device, this.time);
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.source.title = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds(snapshot.endTime);
    this.elements.progressText.textContent = snapshot.endTime > 0 ? `${Math.round(snapshot.time / snapshot.endTime * 100)}%` : "0%";
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
    const traceDecision = decisionAtTime(this.decisionTrace, snapshot.time);
    const compatibleTraceDecision = traceDecision?.model === this.recommendationModel ? traceDecision : null;
    const originalDecisionTraceAvailable = this.hasOriginalDecisionTrace();
    const currentDecision = originalDecisionTraceAvailable ? compatibleTraceDecision : cachedDecision ?? (this.liveDecisionKey === replayKey ? this.liveDecision : null) ?? compatibleTraceDecision;
    if (this.replayPlan && !this.liveSolving && !originalDecisionTraceAvailable && !cachedDecision && this.liveDecisionKey !== replayKey && !this.pendingReplayDecisionKeys.has(replayKey) && this.replayDecisionErrorKey !== replayKey) {
      void this.refreshReplayDecision(replayKey, replayTime);
    }
    const topologySnapshot = snapshotWithFullDeviceModules(
      snapshotWithCandidateModules(snapshot, currentDecision, this.device),
      this.device
    );
    this.elements.stage.innerHTML = renderEquipmentTopology(
      topologySnapshot,
      currentDecision,
      void 0,
      this.device
    );
    if (!this.externalDecisionLensOwner) {
      const requestState = this.pendingReplayDecisionKeys.has(replayKey) ? "loading" : this.replayDecisionErrorKey === replayKey ? "error" : "idle";
      this.elements.decisionLens.innerHTML = renderDecisionLens(
        currentDecision,
        requestState,
        this.replayDecisionErrorMessage
      );
    }
    this.elements.activeMoves.innerHTML = snapshot.activeMoves.length ? snapshot.activeMoves.map((move) => `
        <li>
          <span class="active-move-id">#${finiteNumber(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber(move.MoveType, -1)] ?? `\u52A8\u4F5C ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move) || "\u2014")}</span>
          <time>${formatSeconds(finiteNumber(move.StartTime))}\u2013${formatSeconds(finiteNumber(move.EndTime))} s</time>
        </li>`).join("") : '<li class="active-move-empty">\u5F53\u524D\u65F6\u523B\u6CA1\u6709\u6267\u884C\u4E2D\u7684\u52A8\u4F5C</li>';
  }
  /** 同步推荐模型选择说明；双 Actor 明确提示两端互不混排。 */
  updateRecommendationModelControl() {
    this.elements.recommendationModel.value = this.recommendationModel;
    if (this.hasOriginalDecisionTrace()) {
      this.elements.recommendationModelHint.textContent = this.recommendationModel === "dual-actor-e2e" ? "\u663E\u793A\u672C\u6B21\u8C03\u5EA6\u4FDD\u5B58\u7684\u5927\u6C14\u7AEF\u3001\u771F\u7A7A\u7AEF\u539F\u59CB\u63D0\u6848\u548C\u6700\u7EC8\u6267\u884C\u52A8\u4F5C\u3002" : "\u663E\u793A\u672C\u6B21\u8C03\u5EA6\u4FDD\u5B58\u7684\u539F\u59CB E2E \u8054\u5408\u52A8\u4F5C\u51B3\u7B56\u3002";
      return;
    }
    this.elements.recommendationModelHint.textContent = this.recommendationModel === "dual-actor-e2e" ? "\u6309\u5F53\u524D\u7269\u7406\u65F6\u523B\u91CD\u65B0\u8BC4\u4F30\u4E24\u7AEF\u539F\u5B50\u52A8\u4F5C\uFF1B\u8FD9\u662F\u56DE\u653E\u91CD\u8BC4\u4F30\uFF0C\u4E0D\u4EE3\u8868\u539F\u8BA1\u5212\u5F53\u65F6\u9009\u62E9\u3002" : "\u6309\u5F53\u524D\u7269\u7406\u65F6\u523B\u91CD\u65B0\u8BC4\u4F30\u5B8C\u6574 Pick + Place / Swap \u4E8B\u52A1\u3002";
  }
  /** 当前结果是否保存了与所选策略一致、可审计的原始模型轨迹。 */
  hasOriginalDecisionTrace() {
    const planStrategy = String(this.replayPlan?.strategy ?? "");
    const strategyCompatible = !planStrategy || planStrategy === this.recommendationModel;
    return strategyCompatible && this.decisionTrace.some((step) => step.model === this.recommendationModel && !step.replayEvaluated);
  }
  /** 返回不晚于当前时刻、符合当前模型决策粒度的最近边界。 */
  replayDecisionTime(time) {
    let decisionTime = 0;
    for (const boundary of this.currentDecisionBoundaries()) {
      if (boundary > time + PERFORMANCE_DISPLAY_TOLERANCE) break;
      decisionTime = boundary;
    }
    return decisionTime;
  }
  /** E2E 按完整事务，双 Actor 按原子机器人动作选择各自的回放边界。 */
  currentDecisionBoundaries() {
    return this.recommendationModel === "dual-actor-e2e" ? this.primitiveDecisionBoundaries : this.decisionBoundaries;
  }
  /** 每个模型在自身决策边界只执行一次前向。 */
  replayStateKey(replayTime) {
    return `${this.recommendationModel}@${replayTime.toFixed(6)}`;
  }
  /** 异步请求当前 Machine 候选；过期响应不会覆盖用户已经拖到的新时刻。 */
  async refreshReplayDecision(replayKey, replayTime) {
    const requestVersion = ++this.replayDecisionRequestVersion;
    this.pendingReplayDecisionKeys.add(replayKey);
    if (this.replayDecisionErrorKey === replayKey) {
      this.replayDecisionErrorKey = "";
      this.replayDecisionErrorMessage = "";
    }
    let renderFailure = false;
    try {
      const rawDecision = await requestReplayDecision({
        resultId: this.analysisResultId || void 0,
        moves: this.analysisResultId ? void 0 : this.moves,
        plan: this.replayPlan,
        recommendationModel: this.recommendationModel,
        time: replayTime
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
        this.replayDecisionErrorMessage = error instanceof Error ? error.message : String(error);
        renderFailure = true;
      }
    } finally {
      this.pendingReplayDecisionKeys.delete(replayKey);
      if (renderFailure && this.replayStateKey(this.replayDecisionTime(this.time)) === replayKey) {
        this.render();
      }
    }
  }
  /** 请求并绘制与播放时刻无关的服务端排程性能诊断。 */
  async renderPerformance() {
    if (!this.moves.length) return;
    const requestVersion = ++this.analysisRequestVersion;
    this.elements.performance.innerHTML = '<div class="visual-loader" aria-label="\u6B63\u5728\u5206\u6790"></div>';
    try {
      const result = await requestScheduleAnalysis({
        ...this.analysisResultId ? { resultId: this.analysisResultId } : { moves: this.moves },
        device: this.device,
        windowMode: this.performanceWindowMode,
        routes: this.analysisRoutes,
        rounds: this.analysisRounds,
        cpuTimeMs: this.analysisResultId ? void 0 : this.cpuTimeMs,
        recomputeCount: this.analysisResultId ? void 0 : this.recomputeCount
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
    } catch (error) {
      if (requestVersion !== this.analysisRequestVersion) return;
      this.analysis = null;
      this.bottleneckSummary = null;
      this.elements.performance.innerHTML = `
        <div class="visual-empty is-error">
          <strong>\u7ED3\u679C\u5206\u6790\u5931\u8D25</strong>
          <span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span>
        </div>`;
    }
  }
  /** 显示加载状态并保留明确的系统反馈。 */
  setLoading(loading, message) {
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
    const loadingMarkup = loading ? `<span class="visual-loader" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong>` : `<strong>${escapeHtml(message)}</strong>`;
    this.elements.empty.innerHTML = loadingMarkup;
    this.elements.playbackEmpty.innerHTML = loadingMarkup;
  }
  /** 在工作台空状态中显示可恢复的错误。 */
  showError(message) {
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
      <strong>\u65E0\u6CD5\u52A0\u8F7D MoveList</strong>
      <span>${escapeHtml(message)}</span>
      <label class="btn visual-import-button">${icon("upload")}\u91CD\u65B0\u9009\u62E9\u6587\u4EF6<input type="file" accept=".json,application/json" data-visual-retry></label>`;
    this.elements.empty.innerHTML = errorMarkup;
    this.elements.playbackEmpty.innerHTML = errorMarkup;
    [this.elements.empty, this.elements.playbackEmpty].forEach((container) => {
      const retryInput = container.querySelector("[data-visual-retry]");
      retryInput?.addEventListener("change", () => {
        const file = retryInput.files?.item(0);
        if (file) this.loadFile(file).catch((error) => this.showError(error instanceof Error ? error.message : String(error)));
      });
    });
  }
};
function createVisualizationWorkspace(root = document) {
  return new VisualizationWorkspace(root);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  alignOriginalDecisionTraceToMoves,
  buildWorkspaceSnapshot,
  createVisualizationWorkspace,
  decisionAtTime,
  decisionBoundaryTimes,
  decisionSpaceSignature,
  detectDeviceTopologyLayout,
  detectTerminalPlaybackDeadlock,
  detectTopologyLayout,
  groupedBottleneckResources,
  normalizeDecisionTrace,
  normalizeMovePayload,
  primitiveDecisionBoundaryTimes,
  renderEquipmentTopology,
  renderSchedulePerformance,
  renderWaferResidenceChart,
  snapshotWithFullDeviceModules
});
