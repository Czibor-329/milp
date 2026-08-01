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
  analyzeSchedulePerformance: () => analyzeSchedulePerformance,
  buildScheduleAnalysisContext: () => buildScheduleAnalysisContext,
  buildWorkspaceSnapshot: () => buildWorkspaceSnapshot,
  createVisualizationWorkspace: () => createVisualizationWorkspace,
  decisionAtTime: () => decisionAtTime,
  displayedPerformanceResources: () => displayedPerformanceResources,
  normalizeDecisionTrace: () => normalizeDecisionTrace,
  normalizeMovePayload: () => normalizeMovePayload,
  renderEquipmentTopology: () => renderEquipmentTopology,
  snapshotWithFullDeviceModules: () => snapshotWithFullDeviceModules,
  summarizeBottleneckUtilization: () => summarizeBottleneckUtilization
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

// src/workspace_visualizer.ts
var PICK_MOVE_TYPES = /* @__PURE__ */ new Set([0, 2]);
var PLACE_MOVE_TYPES = /* @__PURE__ */ new Set([1, 3]);
var SWAP_MOVE = 4;
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
var FUTURE_DECISION_COUNT = 6;
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
function normalizeDecisionTrace(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rawTrace = payload.DecisionTrace;
  if (!Array.isArray(rawTrace)) return [];
  return rawTrace.filter((step) => Boolean(step) && typeof step === "object" && !Array.isArray(step)).map((step) => {
    const rawCandidates = Array.isArray(step.candidates) ? step.candidates : [];
    const candidates = rawCandidates.filter((candidate) => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)).map((candidate) => ({
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
      makespanDelta: nullableFiniteNumber(candidate.makespanDelta)
    })).sort((left, right) => left.rank - right.rank || right.policyPreference - left.policyPreference);
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
      candidates
    };
  }).sort((left, right) => left.time - right.time || left.decisionIndex - right.decisionIndex);
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
function firstStation(move, field) {
  return String(listValue(move[field])[0] ?? "");
}
function isRobotName(name) {
  return /^(ATR|VTR|TM\d*|ROBOT)/i.test(name);
}
function isDummyPortName(name) {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}
function isTopologyHiddenModule(module2) {
  const name = module2.name.trim();
  const type = module2.type.trim().toLowerCase();
  return /^BUF(?:FER)?(?:[_-]?\w+)?$/i.test(name) || type === "buffer" || isDummyPortName(name) || type === "dummyport" || /^HEATER$/i.test(name) || type === "heater";
}
function isLoadPortName(name, type = "") {
  return !isDummyPortName(name) && (type.toLowerCase() === "loadport" || /^(LP\d*|P\d+|.*PORT)$/i.test(name));
}
function isLoadLockName(name, type = "") {
  return type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name) || /^BUF_/i.test(name);
}
function isDoorlessModule(name, type = "") {
  return /^cool(er)?$/i.test(name) || type.toLowerCase() === "cooler" || isDummyPortName(name);
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
function collectModuleDefinitions(moves, device) {
  const modules = /* @__PURE__ */ new Map();
  const stationDefinitions = device?.Stations ?? {};
  for (const move of moves) {
    const candidates = [
      move.ModuleName,
      ...listValue(move.SrcStationList),
      ...listValue(move.DestStationList),
      ...listValue(move.StationList)
    ].map(String).filter(Boolean);
    for (const name of candidates) {
      if (!isRobotName(name) && !modules.has(name)) {
        modules.set(name, { type: String(stationDefinitions[name]?.Type ?? "") });
      }
    }
  }
  return modules;
}
function collectRobotNames(moves, device) {
  const names = new Set(Object.keys(device?.Robots ?? {}));
  for (const move of moves) {
    if (isRobotName(move.ModuleName)) names.add(move.ModuleName);
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
        if (!locations.has(material)) locations.set(material, move.ModuleName);
      }
      for (const material of materialIds(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, station);
      }
      continue;
    }
    const source = firstStation(move, "SrcStationList");
    const destination = firstStation(move, "DestStationList");
    const fallback = source || (PICK_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : "") || (PLACE_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : "") || destination || move.ModuleName;
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
    for (const material of materialIds(move, "RecvMatList")) locations.set(material, station);
    for (const material of materialIds(move, "SendMatList")) locations.set(material, move.ModuleName);
  }
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
  const time = Math.max(0, Math.min(finiteNumber(requestedTime), endTime));
  const definitions = collectModuleDefinitions(records, device);
  const robotNames = collectRobotNames(records, device);
  const locations = initialMaterialLocations(records);
  const doorStates = /* @__PURE__ */ new Map();
  const environments = /* @__PURE__ */ new Map();
  const processedMaterials = /* @__PURE__ */ new Set();
  const activeMoves = [];
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
      if (move.MoveType === PROCESS_MOVE) {
        for (const material of materialIds(move)) processedMaterials.add(material);
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
    if (isRobotName(move.ModuleName)) robotTargets.set(move.ModuleName, activeTarget(move));
  }
  const wafersByLocation = /* @__PURE__ */ new Map();
  for (const [material, location] of locations) {
    if (!location) continue;
    const wafers = wafersByLocation.get(location) ?? [];
    wafers.push(material);
    wafersByLocation.set(location, wafers);
  }
  for (const wafers of wafersByLocation.values()) wafers.sort(naturalCompare);
  const modules = [...definitions.entries()].map(([name, definition]) => {
    const moduleMoves = activeMoves.filter((move) => move.ModuleName === name || firstStation(move, "SrcStationList") === name || firstStation(move, "DestStationList") === name || listValue(move.StationList).map(String).includes(name));
    const primaryMove = moduleMoves.find((move) => move.MoveType === CLEAN_MOVE) ?? moduleMoves.find((move) => move.MoveType === PROCESS_MOVE) ?? moduleMoves.find((move) => LOADLOCK_ENVIRONMENT_MOVE_TYPES.has(move.MoveType)) ?? moduleMoves.find((move) => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType)) ?? moduleMoves[0];
    let status = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove?.MoveType === CLEAN_MOVE) status = "cleaning";
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
      activeMoveName: primaryMove ? MOVE_NAMES[primaryMove.MoveType] ?? `\u52A8\u4F5C ${primaryMove.MoveType}` : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      loadLockPhase,
      isRobotTarget: [...robotTargets.values()].includes(name)
    };
  }).sort((left, right) => naturalCompare(left.name, right.name));
  const robots = robotNames.map((name) => {
    const move = activeMoves.find((record) => record.ModuleName === name);
    return {
      name,
      wafers: wafersByLocation.get(name) ?? [],
      busy: Boolean(move),
      source: move ? firstStation(move, "SrcStationList") : "",
      target: robotTargets.get(name) ?? "",
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
    transitionButtons: root.getElementById("visualTransitionButtons"),
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
  for (const candidate of decision?.candidates ?? []) {
    const name = candidate.destination;
    if (!name || isRobotName(name) || knownNames.has(name)) continue;
    modules.push({
      name,
      type: String(device?.Stations?.[name]?.Type ?? ""),
      status: "idle",
      door: "closed",
      wafers: [],
      processedWafers: [],
      activeMoveName: "",
      progress: 0,
      environment: "",
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
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (knownNames.has(name) || isRobotName(name)) continue;
    const type = String(definition?.Type ?? "");
    modules.push({
      name,
      type,
      status: "idle",
      door: isDoorlessModule(name, type) ? "doorless" : "closed",
      wafers: [],
      processedWafers: [],
      activeMoveName: "",
      progress: 0,
      environment: "",
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
function renderWaferToken(wafer, progress) {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  return `<span class="wafer-token" style="--wafer-progress:${normalizedProgress * 360}deg" title="\u6676\u5706 ${escapeHtml(wafer)}"><span>${escapeHtml(wafer)}</span></span>`;
}
function moduleDoorSides(module2, role) {
  if (module2.door === "doorless") return [];
  if (role === "lock") return [];
  if (role === "port") return ["top"];
  const name = module2.name.trim().toUpperCase();
  if (/^PM[12]$/.test(name)) return ["left"];
  if (/^PM[56]$/.test(name) || name === "HEATER") return ["right"];
  if (/^PM[34]$/.test(name)) return ["bottom"];
  if (["AL", "ALIGNER"].includes(name)) return ["right"];
  if (["CL", "COOLER"].includes(name)) return ["left"];
  return ["top"];
}
function renderModule(module2, role, candidate) {
  const waferProgress = module2.status === "processing" ? module2.progress : 0;
  const visibleWaferCount = role === "lock" ? 2 : 1;
  const wafers = module2.wafers.slice(0, visibleWaferCount).map((wafer) => renderWaferToken(wafer, waferProgress)).join("");
  const overflow = module2.wafers.length > visibleWaferCount ? `<span class="wafer-more">+ ${module2.wafers.length - visibleWaferCount}</span>` : "";
  const doors = moduleDoorSides(module2, role).map((side) => `<i class="chamber-door chamber-door-${side}"></i>`).join("");
  const accessibleStatus = `${module2.name}\uFF0C${STATUS_LABELS[module2.status]}\uFF0C${DOOR_LABELS[module2.door]}`;
  const candidateLabel = candidate ? `${candidate.count} \u4E2A\u53EF\u884C\u52A8\u4F5C\uFF0C\u6700\u9AD8\u6A21\u578B\u504F\u597D ${(candidate.preference * 100).toFixed(0)}%` : "";
  const atmosphereLevel = role === "lock" ? module2.loadLockPhase === "pumping" ? 100 - module2.progress * 100 : module2.loadLockPhase === "venting" ? module2.progress * 100 : /大气|ATM|ATR/i.test(module2.environment) ? 100 : 0 : 0;
  const processedWafers = new Set(module2.processedWafers ?? []);
  const loadLockLayers = role === "lock" ? `<div class="loadlock-layers" aria-hidden="true">${[0, 1].map((index) => {
    const wafer = module2.wafers[index];
    const processed = wafer ? processedWafers.has(wafer) : false;
    const waferState = processed ? "processed" : "unprocessed";
    return `<div class="loadlock-layer ${wafer ? "is-occupied" : "is-empty"}"><span class="loadlock-layer-index">${index + 1}</span>${wafer ? `<span class="loadlock-wafer-line wafer-${waferState}" title="\u6676\u5706 ${escapeHtml(wafer)}\uFF08${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}\uFF09"></span>` : ""}</div>`;
  }).join("")}${overflow}</div>` : `<div class="wafer-stack">${wafers}${overflow}</div>`;
  return `
    <article class="equipment-card equipment-${role} status-${module2.status} door-${module2.door} ${module2.loadLockPhase ? `loadlock-${module2.loadLockPhase}` : ""} ${module2.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" style="--module-progress:${Math.round(module2.progress * 100)}%;--loadlock-atmosphere:${Math.max(0, Math.min(100, atmosphereLevel)).toFixed(1)}%" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
      <div class="equipment-head">
        <strong>${escapeHtml(module2.name)}</strong>
      </div>
      <div class="equipment-body">
        ${loadLockLayers}
      </div>
      <div class="chamber-doors" aria-hidden="true">${doors}</div>
    </article>`;
}
function renderRobotHub(robot, environment) {
  const wafer = robot.wafers[0] ? renderWaferToken(robot.wafers[0], 0) : "";
  const overflow = robot.wafers.length > 1 ? `<span class="wafer-more">+ ${robot.wafers.length - 1}</span>` : "";
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" aria-label="${escapeHtml(robot.name)} ${robot.busy ? "\u5DE5\u4F5C\u4E2D" : "\u5F85\u547D"}">
      <strong>${escapeHtml(robot.name)}</strong>
      <div class="robot-wafers">${wafer}${overflow}</div>
    </article>`;
}
var TOPOLOGY_COLUMN_PERCENTAGES = [26, 42, 58, 74];
var TOPOLOGY_ROW_TOP_PIXELS = [52, 154, 256, 358, 460, 562, 664, 786, 929, 1031, 1133];
var TOPOLOGY_VIEWBOX_WIDTH = 1e3;
var TOPOLOGY_ITEM_SIZE = 96;
var TOPOLOGY_LOADLOCK_WIDTH = 136;
var TOPOLOGY_LOADLOCK_HEIGHT = 64;
var TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS = [664, 728];
var TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS = 866;
var TOPOLOGY_LOADPORT_ROW_TOP_PIXELS = 990;
var TOPOLOGY_CANVAS_PADDING = 28;
function distributedTopologyColumns(count) {
  if (count <= 1) return [50];
  if (count === 2) return [40, 60];
  if (count === 3) return [30, 50, 70];
  return Array.from({ length: count }, (_, index) => 20 + index * 60 / (count - 1));
}
function processModuleNumber(name) {
  const match = /^PM[_-]?(\d+)$/i.exec(name.trim());
  return match ? finiteNumber(match[1]) : 0;
}
function usesCascadeTopology(modules, vacuumRobotCount) {
  return vacuumRobotCount > 1 || modules.some((module2) => processModuleNumber(module2.name) > 6 || /^BUF[_-]?[AB]$/i.test(module2.name));
}
function moduleTopologyPosition(module2, role, index, roleModules, cascade) {
  const name = module2.name.trim().toUpperCase();
  const roleCount = roleModules.length;
  const column = TOPOLOGY_COLUMN_PERCENTAGES;
  const row = TOPOLOGY_ROW_TOP_PIXELS;
  const cascadePositions = {
    PM3: { leftPercent: column[1], topPixels: row[0] },
    PM4: { leftPercent: column[2], topPixels: row[0] },
    PM2: { leftPercent: column[0], topPixels: row[1] },
    PM1: { leftPercent: column[0], topPixels: row[2] },
    PM5: { leftPercent: column[3], topPixels: row[1] },
    PM6: { leftPercent: column[3], topPixels: row[2] },
    BUF_A: { leftPercent: column[1], topPixels: row[3] },
    BUFA: { leftPercent: column[1], topPixels: row[3] },
    BUF_B: { leftPercent: column[2], topPixels: row[3] },
    BUFB: { leftPercent: column[2], topPixels: row[3] },
    PM8: { leftPercent: column[0], topPixels: row[4] },
    PM7: { leftPercent: column[0], topPixels: row[5] },
    PM9: { leftPercent: column[3], topPixels: row[4] },
    PM10: { leftPercent: column[3], topPixels: row[5] }
  };
  const singlePositions = {
    PM3: { leftPercent: column[1], topPixels: row[3] },
    PM4: { leftPercent: column[2], topPixels: row[3] },
    PM2: { leftPercent: column[0], topPixels: row[4] },
    PM1: { leftPercent: column[0], topPixels: row[5] },
    PM5: { leftPercent: column[3], topPixels: row[4] },
    PM6: { leftPercent: column[3], topPixels: row[5] }
  };
  const explicit = (cascade ? cascadePositions : singlePositions)[name];
  if (explicit) return explicit;
  if (role === "lock") {
    const canonicalOrder = { LA: 0, LC: 1, LB: 2, LD: 3 };
    const orderedLoadLocks = [...roleModules].sort((left, right) => {
      const leftName = left.name.trim().toUpperCase();
      const rightName = right.name.trim().toUpperCase();
      const leftRank = canonicalOrder[leftName] ?? 100;
      const rightRank = canonicalOrder[rightName] ?? 100;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const gridIndex = Math.max(0, orderedLoadLocks.findIndex((item) => item.name === module2.name));
    const loadLockRowGap = TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[1] - TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    return {
      leftPercent: gridIndex % 2 === 0 ? column[1] : column[2],
      topPixels: TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0] + Math.floor(gridIndex / 2) * loadLockRowGap,
      widthPixels: TOPOLOGY_LOADLOCK_WIDTH,
      heightPixels: TOPOLOGY_LOADLOCK_HEIGHT
    };
  }
  if (role === "port") {
    const loadPortColumns = {
      LP1: column[0],
      LP2: column[1],
      LP3: column[2],
      LP4: column[3]
    };
    if (loadPortColumns[name] !== void 0) {
      return { leftPercent: loadPortColumns[name], topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS };
    }
    return { leftPercent: distributedTopologyColumns(roleCount)[index], topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS };
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
      topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS + row[1] - row[0] + rowIndex * rowGap
    };
  }
  const fallbackRow = role === "process" ? row[3] : row[7];
  return {
    leftPercent: distributedTopologyColumns(Math.max(roleCount, 1))[index] ?? 50,
    topPixels: fallbackRow
  };
}
function robotTopologyPosition(robotIndex, robotCount, environment, cascade) {
  if (environment === "atmosphere") {
    if (robotCount > 1) {
      return {
        leftPercent: distributedTopologyColumns(robotCount)[robotIndex] ?? 50,
        topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS
      };
    }
    return { leftPercent: 50, topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS };
  }
  if (cascade && robotCount > 1) {
    return {
      leftPercent: 50,
      topPixels: robotIndex === 0 ? TOPOLOGY_ROW_TOP_PIXELS[4] : (TOPOLOGY_ROW_TOP_PIXELS[1] + TOPOLOGY_ROW_TOP_PIXELS[2]) / 2
    };
  }
  return {
    leftPercent: 50,
    topPixels: (TOPOLOGY_ROW_TOP_PIXELS[4] + TOPOLOGY_ROW_TOP_PIXELS[5]) / 2
  };
}
function topologySvgPoint(position) {
  return {
    x: position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH,
    y: position.topPixels
  };
}
function topologyEdgePoint(center, toward, width = TOPOLOGY_ITEM_SIZE, height = TOPOLOGY_ITEM_SIZE) {
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
function interpolatedRobotAngle(start, end, progress) {
  let delta = (end - start) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return start + delta * Math.max(0, Math.min(1, progress));
}
function robotLoadLockPortal(robotName, moduleName, modulePositions) {
  const normalizedModule = moduleName.trim().toUpperCase();
  const isAtmosphereRobot = /^(ATR|ATM)/i.test(robotName);
  const isVacuumRobot = /^(VTR|VTM)/i.test(robotName);
  if (!isAtmosphereRobot && !isVacuumRobot) return moduleName;
  const preferred = ["LA", "LB"].includes(normalizedModule) ? isAtmosphereRobot ? "LB" : "LA" : ["LC", "LD"].includes(normalizedModule) ? isAtmosphereRobot ? "LD" : "LC" : moduleName;
  return modulePositions.has(preferred) ? preferred : moduleName;
}
function renderRobotTargetArrows(robots, robotPositions, modulePositions, canvasHeight) {
  const colors = ["var(--brand)", "var(--green)", "var(--red)", "var(--muted)"];
  const lines = robots.map((robot, index) => {
    const robotPosition = robotPositions.get(robot.name);
    const targetName = robotLoadLockPortal(robot.name, robot.target, modulePositions);
    const targetPosition = modulePositions.get(targetName);
    if (!robotPosition || !targetPosition || !robot.target) return "";
    const robotCenter = topologySvgPoint(robotPosition);
    const targetCenter = topologySvgPoint(targetPosition);
    let endPoint = topologyEdgePoint(
      targetCenter,
      robotCenter,
      targetPosition.widthPixels,
      targetPosition.heightPixels
    );
    if (robot.isPreTrans) {
      const sourceName = robotLoadLockPortal(robot.name, robot.source, modulePositions);
      const sourcePosition = modulePositions.get(sourceName);
      if (sourcePosition) {
        const sourceCenter = topologySvgPoint(sourcePosition);
        const startAngle = Math.atan2(sourceCenter.y - robotCenter.y, sourceCenter.x - robotCenter.x);
        const endAngle = Math.atan2(targetCenter.y - robotCenter.y, targetCenter.x - robotCenter.x);
        const angle = interpolatedRobotAngle(startAngle, endAngle, robot.preTransProgress);
        const sourceEdge = topologyEdgePoint(
          sourceCenter,
          robotCenter,
          sourcePosition.widthPixels,
          sourcePosition.heightPixels
        );
        const sourceRadius = Math.hypot(sourceEdge.x - robotCenter.x, sourceEdge.y - robotCenter.y);
        const targetRadius = Math.hypot(endPoint.x - robotCenter.x, endPoint.y - robotCenter.y);
        const radius = sourceRadius + (targetRadius - sourceRadius) * robot.preTransProgress;
        endPoint = {
          x: robotCenter.x + Math.cos(angle) * radius,
          y: robotCenter.y + Math.sin(angle) * radius
        };
      }
    }
    const startPoint = topologyEdgePoint(robotCenter, endPoint);
    const color = colors[index % colors.length];
    return `<line class="${robot.isPreTrans ? "is-pre-trans" : ""}" x1="${startPoint.x}" y1="${startPoint.y}" x2="${endPoint.x}" y2="${endPoint.y}" stroke="${color}" marker-end="url(#topology-arrowhead-${index})"/>`;
  }).join("");
  const markers = robots.map((_, index) => {
    const color = colors[index % colors.length];
    return `<marker id="topology-arrowhead-${index}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${color}"/></marker>`;
  }).join("");
  return `<svg class="topology-target-arrows" viewBox="0 0 ${TOPOLOGY_VIEWBOX_WIDTH} ${canvasHeight}" preserveAspectRatio="none" aria-hidden="true"><defs>${markers}</defs>${lines}</svg>`;
}
function renderEquipmentTopology(snapshot, decision) {
  const visibleModules = snapshot.modules.filter((module2) => !isTopologyHiddenModule(module2));
  const groups = topologyGroups(visibleModules);
  const destinations = candidateDestinations(decision);
  const atmosphereRobots = snapshot.robots.filter((robot) => /^(ATR|ATM)/i.test(robot.name));
  const atmosphereNames = new Set(atmosphereRobots.map((robot) => robot.name));
  const vacuumRobots = snapshot.robots.filter((robot) => !atmosphereNames.has(robot.name));
  const cascade = usesCascadeTopology(visibleModules, vacuumRobots.length);
  const modulePositions = /* @__PURE__ */ new Map();
  const positionModuleGroup = (modules, role) => modules.forEach((module2, index) => {
    const position = moduleTopologyPosition(module2, role, index, modules, cascade);
    modulePositions.set(module2.name, position);
  });
  positionModuleGroup(groups.processModules, "process");
  positionModuleGroup(groups.loadLocks, "lock");
  positionModuleGroup(groups.loadPorts, "port");
  positionModuleGroup(groups.auxiliaryModules, "auxiliary");
  const robotPositions = /* @__PURE__ */ new Map();
  const positionRobotGroup = (robots, environment) => robots.forEach((robot, index) => {
    const position = robotTopologyPosition(index, robots.length, environment, cascade);
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
  const canvasHeight = Math.max(
    520,
    Math.ceil(maximumBottom + verticalOffset + TOPOLOGY_CANVAS_PADDING)
  );
  for (const [name, position] of modulePositions) {
    modulePositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  for (const [name, position] of robotPositions) {
    robotPositions.set(name, { ...position, topPixels: position.topPixels + verticalOffset });
  }
  const renderModuleGroup = (modules, role) => modules.map((module2) => {
    const position = modulePositions.get(module2.name);
    if (!position) return "";
    return `<div class="reference-module-position" style="--module-left:${position.leftPercent}%;--module-top:${position.topPixels}px">${renderModule(module2, role, destinations.get(module2.name))}</div>`;
  }).join("");
  const moduleMarkup = [
    renderModuleGroup(groups.processModules, "process"),
    renderModuleGroup(groups.loadLocks, "lock"),
    renderModuleGroup(groups.loadPorts, "port"),
    renderModuleGroup(groups.auxiliaryModules, "auxiliary")
  ].join("");
  const renderRobotGroup = (robots, environment) => robots.map((robot) => {
    const position = robotPositions.get(robot.name);
    if (!position) return "";
    return `<div class="reference-robot-position" style="--robot-left:${position.leftPercent}%;--robot-top:${position.topPixels}px">${renderRobotHub(robot, environment)}</div>`;
  }).join("");
  const robotMarkup = renderRobotGroup(vacuumRobots, "vacuum") + renderRobotGroup(atmosphereRobots, "atmosphere");
  return `
    <section class="equipment-schematic" aria-label="\u5B8C\u6574\u8BBE\u5907\u62D3\u6251\u56DE\u653E">
      <div class="schematic-canvas reference-grid-canvas" style="--topology-canvas-height:${canvasHeight}px">
        ${moduleMarkup}
        ${robotMarkup}
        ${renderRobotTargetArrows(snapshot.robots, robotPositions, modulePositions, canvasHeight)}
      </div>
    </section>`;
}
function modelSeconds(value, sign = false) {
  if (value === null) return "\u2014";
  const prefix = sign && value > PERFORMANCE_DISPLAY_TOLERANCE ? "+" : "";
  return `${prefix}${value.toFixed(value >= 100 ? 0 : 1)} s`;
}
function decisionCandidatePath(candidate) {
  const source = candidate.source || "\u5F53\u524D\u4F4D\u7F6E";
  const destination = candidate.destination || "\u2014";
  return `${source} \u2192 ${destination}${candidate.destinationSlot ? ` \xB7 \u69FD ${candidate.destinationSlot}` : ""}`;
}
function renderTransitionButtons(decision) {
  if (!decision?.candidates.length) {
    return '<div class="transition-button-empty">\u5F53\u524D\u65F6\u523B\u6CA1\u6709\u6A21\u578B\u53EF\u884C\u52A8\u4F5C</div>';
  }
  return [...decision.candidates].sort((left, right) => left.rank - right.rank).map((candidate) => {
    const selected = candidate.selected || candidate.actionId === decision.selectedActionId;
    const path = decisionCandidatePath(candidate);
    return `
        <button class="transition-action-button ${selected ? "is-selected" : ""}" type="button" tabindex="-1" aria-disabled="true" title="${escapeHtml(path)}">
          <span>${escapeHtml(path)}</span>
          <small>#${candidate.rank} \xB7 ${Math.round(candidate.policyPreference * 100)}%</small>
        </button>`;
  }).join("");
}
function futureDecisionSteps(trace, current) {
  const index = trace.indexOf(current);
  if (index < 0) return [current];
  return trace.slice(index, index + FUTURE_DECISION_COUNT);
}
function renderDecisionLens(decision, trace) {
  if (!decision) {
    return `
      <div class="decision-empty">
        <strong>\u6CA1\u6709\u6A21\u578B\u51B3\u7B56\u8F68\u8FF9</strong>
        <p>\u5F53\u524D\u7ED3\u679C\u53EA\u5305\u542B MoveList\u3002\u8BF7\u4F7F\u7528 E2E-CTQ \u91CD\u65B0\u8FD0\u884C\uFF0C\u6216\u5BFC\u5165\u542B <code>DecisionTrace</code> \u7684\u7ED3\u679C JSON\u3002</p>
      </div>`;
  }
  const selected = decision.candidates.find((candidate) => candidate.selected) ?? decision.candidates.find((candidate) => candidate.actionId === decision.selectedActionId) ?? decision.candidates[0];
  const shownText = decision.candidatesTruncated ? `\u5C55\u793A Top ${decision.shownCandidateCount} / ${decision.candidateCount}` : `${decision.candidateCount} \u4E2A\u53EF\u884C\u52A8\u4F5C`;
  const candidates = decision.candidates.map((candidate) => {
    const preference = Math.round(candidate.policyPreference * 100);
    const uncertainty = candidate.lowerRemainingMakespan !== null && candidate.upperRemainingMakespan !== null ? `${modelSeconds(candidate.lowerRemainingMakespan)}\u2013${modelSeconds(candidate.upperRemainingMakespan)}` : "\u672A\u8BC4\u4F30";
    const material = candidate.materialIds.length ? candidate.materialIds.join(" / ") : `Wafer ${candidate.waferId}`;
    return `
      <li class="decision-candidate ${candidate.selected ? "is-selected" : ""}">
        <div class="decision-candidate-rank">${candidate.rank}</div>
        <div class="decision-candidate-main">
          <div><strong>${escapeHtml(decisionCandidatePath(candidate))}</strong>${candidate.selected ? "<span>\u6A21\u578B\u9009\u62E9</span>" : ""}</div>
          <small>${escapeHtml(material)} \xB7 ${escapeHtml(candidate.robot || "Robot")} \xB7 ${escapeHtml(candidate.flowKind || candidate.kind)}</small>
          <div class="decision-preference-track" aria-label="\u6A21\u578B\u504F\u597D ${preference}%"><i style="transform:scaleX(${candidate.policyPreference})"></i></div>
        </div>
        <div class="decision-candidate-metrics">
          <strong>${preference}%</strong>
          <span>\u0394 ${modelSeconds(candidate.makespanDelta, true)}</span>
          <small title="\u5269\u4F59 Makespan \u9884\u6D4B\u533A\u95F4">${uncertainty}</small>
        </div>
      </li>`;
  }).join("");
  const future = futureDecisionSteps(trace, decision).map((step, index) => {
    const action = step.candidates.find((candidate) => candidate.selected) ?? step.candidates.find((candidate) => candidate.actionId === step.selectedActionId) ?? step.candidates[0];
    if (!action) return "";
    return `
      <li class="future-decision-step ${index === 0 ? "is-current" : ""}">
        <span>${index === 0 ? "\u5F53\u524D" : `+${index}`}</span>
        <strong>${escapeHtml(action.destination || "\u2014")}</strong>
        <small>${formatSeconds(step.time)} s \xB7 ${escapeHtml(action.materialIds.join("/") || `W${action.waferId}`)}</small>
      </li>`;
  }).join("");
  const selectedSummary = selected ? `<div class="decision-selected-summary">
        <span>${decision.modelEvaluated ? "E2E-CTQ \u9009\u62E9" : "\u7269\u7406\u7EA6\u675F\u552F\u4E00\u89E3"}</span>
        <strong>${escapeHtml(decisionCandidatePath(selected))}</strong>
        <dl>
          <div><dt>\u6A21\u578B\u504F\u597D</dt><dd>${Math.round(selected.policyPreference * 100)}%</dd></div>
          <div><dt>\u5269\u4F59 Makespan</dt><dd>${modelSeconds(selected.expectedRemainingMakespan)}</dd></div>
          <div><dt>\u76F8\u5BF9\u6700\u4F18 \u0394</dt><dd>${modelSeconds(selected.makespanDelta, true)}</dd></div>
        </dl>
      </div>` : "";
  return `
    <div class="decision-lens-head">
      <div><span>AI DECISION LENS</span><strong>\u51B3\u7B56 #${decision.decisionIndex}</strong></div>
      <small>${escapeHtml(shownText)}</small>
    </div>
    ${selectedSummary}
    <section class="future-trajectory" aria-labelledby="futureTrajectoryTitle">
      <header><strong id="futureTrajectoryTitle">\u672A\u6765\u5355\u8F68\u8FF9</strong><span>\u540E\u7EED ${FUTURE_DECISION_COUNT} \u4E2A\u51B3\u7B56\u70B9</span></header>
      <ol>${future}</ol>
    </section>
    <section class="decision-candidate-section" aria-labelledby="decisionCandidatesTitle">
      <header><strong id="decisionCandidatesTitle">\u5019\u9009\u52A8\u4F5C</strong><span>\u504F\u597D \xB7 \u0394 Makespan \xB7 \u9884\u6D4B\u533A\u95F4</span></header>
      <ol>${candidates}</ol>
    </section>
    <p class="decision-method-note">\u504F\u597D\u6765\u81EA\u7B56\u7565\u5206\u6570\u7684\u540C\u7EC4\u5F52\u4E00\u5316\uFF1B\u0394 Makespan \u76F8\u5BF9\u5F53\u524D\u5019\u9009\u4E2D\u9884\u6D4B\u5747\u503C\u6700\u5C0F\u8005\u3002\u533A\u95F4\u6765\u81EA\u5206\u4F4D\u4EF7\u503C\u5934\uFF0C\u4E0D\u4EE3\u8868\u5B8C\u6210\u65F6\u95F4\u4FDD\u8BC1\u3002</p>`;
}
var WAFER_COLOR_PALETTE = [
  "#d81b60",
  "#2f9e44",
  "#5f5bd6",
  "#e76f51",
  "#008c95",
  "#c23b8d",
  "#2878c8",
  "#7ca62b",
  "#b45cc5",
  "#16856f",
  "#7a5fb5",
  "#b66a2c",
  "#c23b32",
  "#45a66b",
  "#4d66c4",
  "#df6b83",
  "#2b7a78",
  "#a33d64",
  "#7868c8",
  "#8a6045"
];
function waferLabel(value) {
  const material = String(value || "").trim();
  return /^W/i.test(material) ? material : `W${material}`;
}
function buildWaferColorMap(cycles) {
  const wafers = /* @__PURE__ */ new Set();
  for (const cycle of cycles) {
    for (const wafer of cycle.vacuumWafers) wafers.add(waferLabel(wafer));
    for (const wafer of cycle.ventWafers) wafers.add(waferLabel(wafer));
  }
  const map = /* @__PURE__ */ new Map();
  let idx = 0;
  for (const wafer of wafers) {
    map.set(wafer, WAFER_COLOR_PALETTE[idx % WAFER_COLOR_PALETTE.length]);
    idx++;
  }
  return map;
}
function normalizeGanttCycles(cycles) {
  return cycles.map((cycle) => ({
    index: Number(cycle.index ?? 0),
    loadLock: String(cycle.loadLock ?? ""),
    vacuumWafers: Array.isArray(cycle.vacuumWafers) ? cycle.vacuumWafers.map(String) : [],
    ventWafers: Array.isArray(cycle.ventWafers) ? cycle.ventWafers.map(String) : [],
    startTime: Number(cycle.startTime ?? cycle.index ?? 0),
    pumpEndTime: Number(cycle.pumpEndTime ?? cycle.startTime ?? cycle.index ?? 0),
    ventStartTime: Number(cycle.ventStartTime ?? 0),
    ventEndTime: Number(cycle.ventEndTime ?? 0)
  }));
}
function formatGanttTime(seconds) {
  return seconds >= 1 ? seconds.toFixed(1) : seconds.toFixed(2);
}
function renderWaferDots(wafers, waferColors) {
  if (!wafers.length) return "";
  return wafers.map((w) => {
    const label = waferLabel(w);
    const color = waferColors.get(label) || "#94a3b8";
    return `<span class="gantt-wafer-dot" style="background:${color}" title="${escapeHtml(label)}"></span>`;
  }).join("");
}
function renderLoadLockGantt(cycles) {
  if (!cycles.length) return '<div class="loadlock-cycle-empty">MoveList \u4E2D\u6CA1\u6709\u8BC6\u522B\u5230 LoadLock \u62BD\u6C14\u6216\u5145\u6C14\u52A8\u4F5C\u3002</div>';
  const waferColors = buildWaferColorMap(cycles);
  const events = [];
  for (const c of cycles) {
    events.push({ time: c.startTime, loadLock: c.loadLock, dir: "pump", wafers: c.vacuumWafers });
    if (c.ventStartTime) events.push({ time: c.ventStartTime, loadLock: c.loadLock, dir: "vent", wafers: c.ventWafers });
  }
  events.sort((a, b) => a.time - b.time);
  function renderCard(dir, wafers, loadLock, time) {
    const cls = dir === "pump" ? "seq-pump" : "seq-vent";
    const label = dir === "pump" ? "\u62BD" : "\u5145";
    const dots = renderWaferDots(wafers, waferColors);
    const description = `${loadLock} ${label}\u6C14 ${formatGanttTime(time)}s`;
    return `<div class="seq-card ${cls}" role="img" aria-label="${escapeHtml(description)}" title="${escapeHtml(description)}"><span class="seq-dots">${dots}</span></div>`;
  }
  const interleavedCards = events.map((e) => renderCard(e.dir, e.wafers, e.loadLock, e.time)).join("");
  return `<div class="loadlock-seq">
    <div class="seq-scroll" aria-label="LoadLock \u5168\u5C40\u4EA4\u9519\u65F6\u5E8F">
      <div class="seq-cards">${interleavedCards}</div>
    </div>
  </div>`;
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
function renderBottleneckAnalysis(performance2) {
  const { window, bottleneckCandidates, resources } = performance2;
  const confidenceLabels = { high: "\u8BC1\u636E\u8F83\u5F3A", medium: "\u8BC1\u636E\u4E2D\u7B49", low: "\u8BC1\u636E\u8F83\u5F31" };
  const resourceKindLabels = {
    robot: "\u673A\u68B0\u624B",
    process: "\u5DE5\u827A\u8154",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "\u8F85\u52A9\u6A21\u5757"
  };
  const activeResources = resources.filter((resource) => resource.busyTime > PERFORMANCE_DISPLAY_TOLERANCE).sort((left, right) => right.utilization - left.utilization);
  const displayedResources = activeResources.slice(0, 6);
  const remainingResources = activeResources.slice(displayedResources.length);
  const resourceRows = (items) => items.map((resource, index) => {
    const candidate = bottleneckCandidates.filter((item) => item.resourceNames.includes(resource.name)).sort((left, right) => right.score - left.score)[0];
    const evidenceScore = candidate ? Math.round(candidate.score * 100) : null;
    const evidenceLabel = candidate ? confidenceLabels[candidate.confidence] : "\u672A\u5165\u9009\u5019\u9009";
    return `
      <li class="resource-utilization-row">
        <div class="resource-utilization-name">
          <span>${index + 1}</span>
          <div><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resourceKindLabels[resource.kind])}</small></div>
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
        <span>\u9ED8\u8BA4\u663E\u793A\u5229\u7528\u7387\u6700\u9AD8\u7684 6 \u4E2A\u6D3B\u8DC3\u8D44\u6E90\uFF0C\u5E76\u7ED9\u51FA\u5BF9\u5E94\u7684\u74F6\u9888\u8BC1\u636E\u5F97\u5206\u3002</span>
      </div>
      <label class="bottleneck-window-control">\u7EDF\u8BA1\u53E3\u5F84<span class="bottleneck-window-slot"></span></label>
    </header>
    <div class="resource-utilization-head" aria-hidden="true"><span>\u8D44\u6E90</span><span>\u5229\u7528\u7387</span><span>\u5360\u7528\u7EC4\u6210</span><span>\u6D3B\u8DC3\u65F6\u957F</span><span>\u74F6\u9888\u8BC1\u636E\u5F97\u5206</span></div>
    <ol class="resource-utilization-list">
      ${resourceRows(displayedResources)}
    </ol>
    <div class="performance-legend" aria-label="\u5360\u7528\u7EC4\u6210\u56FE\u4F8B">${legend}</div>
    ${remainingResources.length ? `<details class="additional-resource-details"><summary>\u67E5\u770B\u5176\u4ED6\u6D3B\u8DC3\u8D44\u6E90\uFF08${remainingResources.length} \u4E2A\uFF09</summary><ol class="resource-utilization-list">${resourceRows(remainingResources)}</ol></details>` : ""}
    <p class="performance-window-note">${escapeHtml(window.detail)}</p>`;
}
function renderLoadLockCard(performance2) {
  const ganttCycles = normalizeGanttCycles(performance2.loadLockCycles);
  const gantt = renderLoadLockGantt(ganttCycles);
  return `
    <header class="loadlock-card-head">
      <strong>LoadLock \u4EA4\u6362\u65F6\u5E8F</strong>
      <span>\u663E\u793A\u5168\u90E8 LoadLock \u7684\u62BD\u6C14/\u5145\u6C14\u4EA4\u9519\u5E8F\u5217</span>
    </header>
    <div class="loadlock-card-body">${gantt}</div>`;
}
function renderNextOptimization(performance2) {
  const diagnostics = performance2.diagnostics ?? [];
  if (!diagnostics.length) return "";
  return `
    <header class="next-opt-head">
      <div><span>\u8BC1\u636E \u2192 \u5047\u8BBE \u2192 \u5B9E\u9A8C</span><strong>\u4E0B\u4E00\u6B65\u4F18\u5316</strong></div>
      <small>\u7ED3\u8BBA\u6765\u81EA\u6267\u884C\u8F68\u8FF9\u91CD\u5EFA\uFF0C\u4E0D\u5192\u5145\u7B97\u6CD5\u5185\u90E8\u6253\u5206</small>
    </header>
    <div class="diagnostic-list">
      ${diagnostics.map((diagnostic, index) => `
        <article class="diagnostic-card">
          <header><span class="diagnostic-rank">${index + 1}</span><div><strong>${escapeHtml(diagnostic.title)}</strong><small>${{ strong: "\u8BC1\u636E\u8F83\u5F3A", moderate: "\u8BC1\u636E\u4E2D\u7B49", exploratory: "\u63A2\u7D22\u6027\u7EBF\u7D22" }[diagnostic.confidence]}</small></div></header>
          <p>${escapeHtml(diagnostic.finding)}</p>
          <dl>${diagnostic.evidence.map((evidence) => `
            <div><dt>${escapeHtml(evidence.label)}</dt><dd><b>${escapeHtml(evidence.value)}</b><span>${escapeHtml(evidence.interpretation)}</span></dd></div>
          `).join("")}</dl>
          <div class="diagnostic-experiment">
            <span>\u53EF\u8BC1\u4F2A\u7684\u4E0B\u4E00\u6B65</span>
            <strong>${escapeHtml(diagnostic.nextExperiment.label)}</strong>
            <p>${escapeHtml(diagnostic.nextExperiment.change)}</p>
            <small>\u9884\u671F\u4FE1\u53F7\uFF1A${escapeHtml(diagnostic.nextExperiment.expectedSignal)}</small>
          </div>
          <aside>${escapeHtml(diagnostic.limitation)}</aside>
        </article>`).join("")}
    </div>`;
}
function renderSchedulePerformance(performance2) {
  const window = performance2.window;
  const bottleneck = performance2.primaryBottleneck;
  const confidenceLabels = { high: "\u8BC1\u636E\u8F83\u5F3A", medium: "\u8BC1\u636E\u4E2D\u7B49", low: "\u8BC1\u636E\u8F83\u5F31" };
  return `
    <section class="result-card overview-card">
      <header class="overview-head"><span class="visual-kicker">\u6392\u7A0B\u6982\u89C8</span><strong>KPI \u603B\u89C8</strong></header>
      <div class="performance-summary">
        <div>
          <span>\u7EDF\u8BA1\u7A97\u53E3</span>
          <strong>${escapeHtml(window.label)} \xB7 ${formatSeconds(window.duration)} s</strong>
          <small>\u5254\u9664\u5F00\u5934 ${formatSeconds(window.trimmedStart)} s / \u7ED3\u5C3E ${formatSeconds(window.trimmedEnd)} s</small>
        </div>
        <div>
          <span>\u6700\u53EF\u80FD\u74F6\u9888</span>
          <strong>${escapeHtml(bottleneck?.label ?? "\u2014")}</strong>
          <small>${bottleneck ? `\u5BB9\u91CF\u5229\u7528\u7387 ${formatPercent(bottleneck.utilization)} \xB7 ${confidenceLabels[bottleneck.confidence]} \xB7 \u53E6\u6709 ${Math.max(0, performance2.bottleneckCandidates.length - 1)} \u4E2A\u5019\u9009` : "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8"}</small>
        </div>
        <div>
          <span>\u51FA\u7AD9\u8282\u62CD</span>
          <strong>${performance2.throughputPerHour > 0 ? `${performance2.throughputPerHour.toFixed(1)} \u7247/h` : "\u2014"}</strong>
          <small>\u5E73\u5747\u95F4\u9694 ${formatSeconds(performance2.meanDepartureInterval)} s \xB7 \u95F4\u9694 CV ${performance2.departureIntervalCv.toFixed(2)} \xB7 ${performance2.completedWaferCount} \u7247\u6837\u672C</small>
        </div>
        <div>
          <span>\u6676\u5706\u9A7B\u7559\u65F6\u95F4 \xB7 \u52A0\u5DE5\u8154</span>
          <strong>${performance2.processChamberDwellTime.sampleCount ? `${formatSeconds(performance2.processChamberDwellTime.meanSeconds)} s` : "\u2014"}</strong>
          <small>\u52A0\u5DE5\u7ED3\u675F \u2192 \u5B8C\u5168\u79BB\u8154 \xB7 \u4E2D\u4F4D ${formatSeconds(performance2.processChamberDwellTime.medianSeconds)} s \xB7 \u6700\u5927 ${formatSeconds(performance2.processChamberDwellTime.maxSeconds)} s \xB7 ${performance2.processChamberDwellTime.sampleCount} \u6B21</small>
        </div>
        <div>
          <span>\u673A\u5668\u624B\u9A7B\u7559\u65F6\u95F4</span>
          <strong>${performance2.robotWaferDwellTime.sampleCount ? `${formatSeconds(performance2.robotWaferDwellTime.meanSeconds)} s` : "\u2014"}</strong>
          <small>Pick \u5B8C\u6210 \u2192 Place \u5F00\u59CB\uFF0C\u5DF2\u6263\u9664 PreTrans \u8FD0\u8F93 \xB7 \u6700\u5927 ${formatSeconds(performance2.robotWaferDwellTime.maxSeconds)} s \xB7 ${performance2.robotWaferDwellTime.sampleCount} \u6B21</small>
        </div>
        <div>
          <span>\u6676\u5706\u7CFB\u7EDF\u505C\u7559\u65F6\u95F4</span>
          <strong>${performance2.waferSystemResidenceTime.sampleCount ? `${formatSeconds(performance2.waferSystemResidenceTime.meanSeconds)} s` : "\u2014"}</strong>
          <small>\u79BB\u5F00 LP \u2192 \u8FD4\u56DE LP \xB7 CV ${performance2.waferSystemResidenceTime.coefficientOfVariation.toFixed(2)} \xB7 \u6700\u5927 ${formatSeconds(performance2.waferSystemResidenceTime.maxSeconds)} s \xB7 ${performance2.waferSystemResidenceTime.sampleCount} \u7247</small>
        </div>
      </div>
    </section>

    <section class="result-card bottleneck-analysis-card">
      ${renderBottleneckAnalysis(performance2)}
    </section>

    <section class="result-card loadlock-swap-card">
      ${renderLoadLockCard(performance2)}
    </section>

    ${performance2.diagnostics?.length ? `
    <section class="result-card next-optimization-card">
      ${renderNextOptimization(performance2)}
    </section>` : ""}
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
  sourceName = "";
  resultUrl = "";
  analysisResultId = "";
  analysis = null;
  bottleneckSummary = null;
  analysisRequestVersion = 0;
  time = 0;
  playing = false;
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
    await this.loadMoves(
      normalizeMovePayload(payload),
      normalizeDecisionTrace(payload),
      file.name,
      "",
      ""
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
      await this.loadMoves(
        normalizeMovePayload(payload),
        normalizeDecisionTrace(payload),
        sourceName,
        resultUrl,
        resultId
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
  /** 返回与诊断面板一致的稳态瓶颈候选利用率，供运行结果摘要复用。 */
  getBottleneckUtilization() {
    return this.bottleneckSummary ? structuredClone(this.bottleneckSummary) : null;
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
      <strong>\u7B49\u5F85\u5206\u6790\u6570\u636E</strong>
      <span>\u8FD0\u884C\u4E00\u6B21\u8BA1\u5212\uFF0C\u6216\u5728\u62D3\u6251\u56DE\u653E\u754C\u9762\u5BFC\u5165\u5DF2\u6709\u7684 MoveList JSON \u6587\u4EF6\u540E\u67E5\u770B\u7ED3\u679C\u5206\u6790\u3002</span>`;
    this.elements.playbackEmpty.classList.remove("is-loading", "is-error");
    this.elements.playbackEmpty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 7.3 2.8 2.8M17 7.3l-2.8 2.8M7 16.7l2.8-2.8M17 16.7l-2.8-2.8"/></svg>
      <strong>\u7B49\u5F85 MoveList</strong>
      <span>\u8FD0\u884C\u4E00\u6B21\u8BA1\u5212\uFF0C\u6216\u5BFC\u5165\u5DF2\u6709\u7684 MoveList JSON \u6587\u4EF6\u540E\u67E5\u770B\u8BBE\u5907\u62D3\u6251\u5E76\u5F00\u59CB\u56DE\u653E\u3002</span>`;
  }
  /** 接收规范化后的 MoveList 并重置时间轴。 */
  async loadMoves(moves, decisionTrace, sourceName, resultUrl, analysisResultId) {
    if (!moves.length) throw new Error("MoveList \u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5EFA\u7ACB\u53EF\u89C6\u5316\u56DE\u653E");
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
    this.elements.range.step = snapshot.endTime > 1e4 ? "1" : "0.1";
    this.elements.range.value = "0";
    this.elements.openGantt.href = resultUrl ? `/movelist_gantt_viewer.html?src=${encodeURIComponent(resultUrl)}` : "#";
    this.elements.openGantt.setAttribute("aria-disabled", resultUrl ? "false" : "true");
    this.elements.resultButton.disabled = false;
    this.showSingleResult();
    this.setTopologyVisible(true);
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
    this.previousFrameTime = performance.now();
    this.previousRenderTime = 0;
    this.updatePlayButton();
    this.animationFrame = requestAnimationFrame((timestamp) => this.tick(timestamp));
  }
  /** 暂停回放并保留当前时间。 */
  pause() {
    this.playing = false;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.updatePlayButton();
  }
  /** 推进播放时钟，并按固定上限刷新 DOM。 */
  tick(timestamp) {
    if (!this.playing) return;
    const elapsedSeconds = Math.max(0, timestamp - this.previousFrameTime) / 1e3;
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
    this.animationFrame = requestAnimationFrame((nextTimestamp) => this.tick(nextTimestamp));
  }
  /** 同步播放按钮的图标和无障碍文本。 */
  updatePlayButton() {
    this.elements.playButton.innerHTML = this.playing ? `${icon("pause")}<span>\u6682\u505C</span>` : `${icon("play")}<span>\u64AD\u653E</span>`;
    this.elements.playButton.setAttribute("aria-label", this.playing ? "\u6682\u505C\u56DE\u653E" : "\u64AD\u653E\u56DE\u653E");
    this.elements.playButton.classList.toggle("is-playing", this.playing);
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
    if (!this.moves.length) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(this.moves, this.device, this.time);
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds(snapshot.endTime);
    this.elements.progressText.textContent = snapshot.endTime > 0 ? `${Math.round(snapshot.time / snapshot.endTime * 100)}%` : "0%";
    this.elements.moveText.textContent = `${snapshot.completedMoves} / ${snapshot.totalMoves}`;
    this.elements.waferText.textContent = String(snapshot.waferCount);
    this.elements.range.value = String(snapshot.time);
    const currentDecision = decisionAtTime(this.decisionTrace, snapshot.time);
    const topologySnapshot = snapshotWithFullDeviceModules(
      snapshotWithCandidateModules(snapshot, currentDecision, this.device),
      this.device
    );
    this.elements.stage.innerHTML = renderEquipmentTopology(topologySnapshot, currentDecision);
    this.elements.decisionLens.innerHTML = renderDecisionLens(currentDecision, this.decisionTrace);
    if (this.elements.transitionButtons) {
      this.elements.transitionButtons.innerHTML = renderTransitionButtons(currentDecision);
    }
    this.elements.activeMoves.innerHTML = snapshot.activeMoves.length ? snapshot.activeMoves.map((move) => `
        <li>
          <span class="active-move-id">#${finiteNumber(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber(move.MoveType, -1)] ?? `\u52A8\u4F5C ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move) || "\u2014")}</span>
          <time>${formatSeconds(finiteNumber(move.StartTime))}\u2013${formatSeconds(finiteNumber(move.EndTime))} s</time>
        </li>`).join("") : '<li class="active-move-empty">\u5F53\u524D\u65F6\u523B\u6CA1\u6709\u6267\u884C\u4E2D\u7684\u52A8\u4F5C</li>';
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
        rounds: this.analysisRounds
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

// ../analysis/movelist_performance.ts
var PERFORMANCE_TIME_TOLERANCE = 1e-6;
var MIDDLE_WINDOW_TRIM_RATIO = 0.1;
var MINIMUM_STEADY_WAFERS = 4;
var PICK_MOVE_TYPES2 = /* @__PURE__ */ new Set([0, 2]);
var PLACE_MOVE_TYPES2 = /* @__PURE__ */ new Set([1, 3]);
var SWAP_MOVE2 = 4;
var PRE_TRANS_MOVE2 = 5;
var PREPARE_MOVE2 = 6;
var COMPLETE_MOVE2 = 7;
var PROCESS_MOVE2 = 9;
var PRE_PREPARE_MOVE2 = 10;
var CLEAN_MOVE2 = 14;
var ACTIVITY_CATEGORIES2 = [
  "process",
  "clean",
  "door",
  "transfer",
  "environment",
  "other"
];
function finiteNumber2(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function listValue2(value) {
  return Array.isArray(value) ? value : [];
}
function naturalCompare2(left, right) {
  return left.localeCompare(right, void 0, { numeric: true, sensitivity: "base" });
}
function materialIds2(move, field = "MatIDList") {
  return listValue2(move[field]).map(String).filter(Boolean);
}
function firstStation2(move, field) {
  return String(listValue2(move[field])[0] ?? "");
}
function moveRobotName(move) {
  return String(move.Robot ?? move.ModuleName ?? "").trim();
}
function isRobotName2(name) {
  return /^(ATR|VTR|TM\d*|ROBOT)/i.test(name);
}
function isDummyPortName2(name) {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}
function isLoadPortName2(name, type = "") {
  return !isDummyPortName2(name) && (type.toLowerCase() === "loadport" || /^(LP\d*|P\d+|.*PORT)$/i.test(name));
}
function isLoadLockName2(name, type = "") {
  return type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name) || /^BUF_/i.test(name);
}
function isProcessModule2(name, type = "") {
  const normalizedType = type.toLowerCase();
  return /process|chamber/.test(normalizedType) || /^(PM|CH)\w*/i.test(name);
}
function normalizeMoves2(moves) {
  return moves.map((move, index) => {
    const startTime = finiteNumber2(move.StartTime);
    const endTime = Math.max(startTime, finiteNumber2(move.EndTime, startTime));
    return {
      ...move,
      MoveID: finiteNumber2(move.MoveID, index + 1),
      MoveType: finiteNumber2(move.MoveType, -1),
      ModuleName: String(move.ModuleName ?? ""),
      StartTime: startTime,
      EndTime: endTime
    };
  }).sort((left, right) => left.StartTime - right.StartTime || left.EndTime - right.EndTime || left.MoveID - right.MoveID);
}
function emptyCategoryTimes() {
  return {
    process: 0,
    clean: 0,
    door: 0,
    transfer: 0,
    environment: 0,
    other: 0
  };
}
function activityCategory(moveType) {
  if (moveType === PROCESS_MOVE2) return "process";
  if (moveType === CLEAN_MOVE2) return "clean";
  if ([PREPARE_MOVE2, COMPLETE_MOVE2].includes(moveType)) return "door";
  if (moveType === PRE_PREPARE_MOVE2 || [12, 13].includes(moveType)) return "environment";
  if (PICK_MOVE_TYPES2.has(moveType) || PLACE_MOVE_TYPES2.has(moveType) || [SWAP_MOVE2, 5].includes(moveType)) {
    return "transfer";
  }
  return "other";
}
function activityResourceNames(move) {
  const names = /* @__PURE__ */ new Set();
  if (move.ModuleName) names.add(move.ModuleName);
  if (PICK_MOVE_TYPES2.has(move.MoveType)) {
    const source = firstStation2(move, "SrcStationList");
    if (source) names.add(source);
  } else if (PLACE_MOVE_TYPES2.has(move.MoveType)) {
    const destination = firstStation2(move, "DestStationList");
    if (destination) names.add(destination);
  } else if (move.MoveType === SWAP_MOVE2) {
    for (const station of listValue2(move.StationList).map(String).filter(Boolean)) names.add(station);
  }
  return [...names];
}
function stationType(device, name) {
  return String(device?.Stations?.[name]?.Type ?? "");
}
function resourceKind(name, type) {
  if (isRobotName2(name)) return "robot";
  if (isProcessModule2(name, type)) return "process";
  if (isLoadLockName2(name, type)) return "loadlock";
  if (isLoadPortName2(name, type)) return "loadport";
  return "auxiliary";
}
function performanceResourceDefinitions(moves, device) {
  const referenced = new Set(moves.flatMap(activityResourceNames));
  const resources = /* @__PURE__ */ new Map();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    const type = String(definition.Type ?? "");
    if (referenced.has(name) || isProcessModule2(name, type) || isLoadLockName2(name, type)) {
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
function resourceActivityIntervals(moves, device) {
  const intervals = /* @__PURE__ */ new Map();
  for (const name of performanceResourceDefinitions(moves, device).keys()) intervals.set(name, []);
  for (const move of moves) {
    if (move.EndTime <= move.StartTime + PERFORMANCE_TIME_TOLERANCE) continue;
    const interval = {
      start: move.StartTime,
      end: move.EndTime,
      category: activityCategory(move.MoveType)
    };
    for (const name of activityResourceNames(move)) {
      const resourceIntervals = intervals.get(name) ?? [];
      resourceIntervals.push(interval);
      intervals.set(name, resourceIntervals);
    }
  }
  return intervals;
}
function summarizeIntervals(intervals, windowStart, windowEnd) {
  const categoryTimes = emptyCategoryTimes();
  const clipped = intervals.map((interval) => ({
    ...interval,
    start: Math.max(windowStart, interval.start),
    end: Math.min(windowEnd, interval.end)
  })).filter((interval) => interval.end > interval.start + PERFORMANCE_TIME_TOLERANCE);
  if (windowEnd <= windowStart + PERFORMANCE_TIME_TOLERANCE) {
    return {
      busyTime: 0,
      averageActivePeriod: 0,
      longestActivePeriod: 0,
      longestIdlePeriod: 0,
      activePeriodCount: 0,
      categoryTimes
    };
  }
  const points = [.../* @__PURE__ */ new Set([
    windowStart,
    windowEnd,
    ...clipped.flatMap((interval) => [interval.start, interval.end])
  ])].sort((left, right) => left - right);
  const activePeriods = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start + PERFORMANCE_TIME_TOLERANCE) continue;
    const active = clipped.filter((interval) => interval.start < end - PERFORMANCE_TIME_TOLERANCE && interval.end > start + PERFORMANCE_TIME_TOLERANCE);
    if (!active.length) continue;
    const category = ACTIVITY_CATEGORIES2.find((candidate) => active.some((interval) => interval.category === candidate)) ?? "other";
    categoryTimes[category] += end - start;
    const previous = activePeriods.at(-1);
    if (previous && start <= previous.end + PERFORMANCE_TIME_TOLERANCE) previous.end = end;
    else activePeriods.push({ start, end });
  }
  const activeDurations = activePeriods.map((period) => period.end - period.start);
  const busyTime = activeDurations.reduce((sum, duration) => sum + duration, 0);
  const idleDurations = [];
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
    categoryTimes
  };
}
function waferBoundaryTimes(moves, device) {
  const entries = /* @__PURE__ */ new Map();
  const completions = /* @__PURE__ */ new Map();
  for (const move of moves) {
    if (PICK_MOVE_TYPES2.has(move.MoveType)) {
      const source = firstStation2(move, "SrcStationList");
      if (isLoadPortName2(source, stationType(device, source))) {
        for (const material of materialIds2(move)) {
          if (!entries.has(material)) entries.set(material, move.EndTime);
        }
      }
    } else if (PLACE_MOVE_TYPES2.has(move.MoveType)) {
      const destination = firstStation2(move, "DestStationList");
      if (isLoadPortName2(destination, stationType(device, destination))) {
        for (const material of materialIds2(move)) completions.set(material, move.EndTime);
      }
    } else if (move.MoveType === SWAP_MOVE2) {
      const station = firstStation2(move, "StationList");
      if (!isLoadPortName2(station, stationType(device, station))) continue;
      for (const material of materialIds2(move, "SendMatList")) {
        if (!entries.has(material)) entries.set(material, move.EndTime);
      }
      for (const material of materialIds2(move, "RecvMatList")) {
        completions.set(material, move.EndTime);
      }
    }
  }
  return { entries, completions };
}
function performanceWindow(moves, device, mode) {
  const scheduleStart = moves.length ? Math.min(...moves.map((move) => move.StartTime)) : 0;
  const scheduleEnd = moves.length ? Math.max(...moves.map((move) => move.EndTime)) : 0;
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
      label: "\u5B8C\u6574\u5468\u671F",
      detail: "\u4ECE\u7B2C\u4E00\u6761 Move \u5F00\u59CB\u5230\u6700\u540E\u4E00\u6761 Move \u7ED3\u675F\uFF0C\u5305\u542B\u542F\u52A8\u4E0E\u6536\u5C3E\u9636\u6BB5\u3002"
    };
  }
  const boundaries = waferBoundaryTimes(moves, device);
  const entryTimes = [...boundaries.entries.values()];
  const completionTimes = [...boundaries.completions.values()];
  const firstCompletion = Math.min(...completionTimes);
  const lastEntry = Math.max(...entryTimes);
  const hasSteadyOverlap = entryTimes.length >= MINIMUM_STEADY_WAFERS && completionTimes.length >= MINIMUM_STEADY_WAFERS && Number.isFinite(firstCompletion) && Number.isFinite(lastEntry) && lastEntry > firstCompletion + PERFORMANCE_TIME_TOLERANCE;
  const start = hasSteadyOverlap ? firstCompletion : scheduleStart + scheduleDuration * MIDDLE_WINDOW_TRIM_RATIO;
  const end = hasSteadyOverlap ? lastEntry : scheduleEnd - scheduleDuration * MIDDLE_WINDOW_TRIM_RATIO;
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
    label: hasSteadyOverlap ? "\u7A33\u6001\u4EA4\u53E0\u7A97" : "\u4E2D\u6BB5\u8FD1\u4F3C\u7A97",
    detail: hasSteadyOverlap ? "\u9996\u7247\u8FD4\u56DE LoadPort \u540E\u5F00\u59CB\u3001\u672B\u7247\u79BB\u5F00 LoadPort \u65F6\u7ED3\u675F\uFF0C\u81EA\u52A8\u6392\u9664\u542F\u52A8\u586B\u5145\u548C\u672B\u6279\u6392\u7A7A\u3002" : "\u6837\u672C\u6CA1\u6709\u5F62\u6210\u53EF\u9760\u7684\u9996\u7247\u5B8C\u5DE5\u2014\u672B\u7247\u6295\u6599\u4EA4\u53E0\uFF0C\u6682\u6309\u65F6\u95F4\u8F74\u4E24\u7AEF\u5404\u5254\u9664 10%\u3002"
  };
}
function intervalCoefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= PERFORMANCE_TIME_TOLERANCE) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
function medianDuration(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function summarizeDurations(values) {
  const durations = values.filter((value) => Number.isFinite(value) && value >= -PERFORMANCE_TIME_TOLERANCE).map((value) => Math.max(0, value));
  const totalSeconds = durations.reduce((sum, value) => sum + value, 0);
  return {
    totalSeconds,
    meanSeconds: durations.length ? totalSeconds / durations.length : 0,
    medianSeconds: medianDuration(durations),
    maxSeconds: Math.max(0, ...durations),
    coefficientOfVariation: intervalCoefficientOfVariation(durations),
    sampleCount: durations.length
  };
}
function completionInsideWindow(completedAt, window) {
  return completedAt >= window.start - PERFORMANCE_TIME_TOLERANCE && completedAt <= window.end + PERFORMANCE_TIME_TOLERANCE;
}
function processChamberDwellTime(moves, device, window) {
  const durations = [];
  for (const processMove of moves) {
    const chamber = processMove.ModuleName;
    if (processMove.MoveType !== PROCESS_MOVE2 || !isProcessModule2(chamber, stationType(device, chamber))) continue;
    for (const material of materialIds2(processMove)) {
      const removal = moves.find((candidate) => {
        if (candidate.EndTime < processMove.EndTime - PERFORMANCE_TIME_TOLERANCE) return false;
        if (PICK_MOVE_TYPES2.has(candidate.MoveType) && firstStation2(candidate, "SrcStationList") === chamber && materialIds2(candidate).includes(material)) return true;
        return candidate.MoveType === SWAP_MOVE2 && firstStation2(candidate, "StationList") === chamber && materialIds2(candidate, "SendMatList").includes(material);
      });
      if (!removal || !completionInsideWindow(removal.EndTime, window)) continue;
      durations.push(removal.EndTime - processMove.EndTime);
    }
  }
  return summarizeDurations(durations);
}
function coveredDuration(intervals, boundaryStart, boundaryEnd) {
  const clipped = intervals.map((interval) => ({
    start: Math.max(interval.start, boundaryStart),
    end: Math.min(interval.end, boundaryEnd)
  })).filter((interval) => interval.end > interval.start + PERFORMANCE_TIME_TOLERANCE).sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let activeStart = null;
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
function robotWaferDwellTime(moves, window) {
  const transportByRobot = /* @__PURE__ */ new Map();
  for (const move of moves) {
    if (move.MoveType !== PRE_TRANS_MOVE2 || move.EndTime <= move.StartTime) continue;
    const robot = moveRobotName(move);
    if (!robot) continue;
    const intervals = transportByRobot.get(robot) ?? [];
    intervals.push({ start: move.StartTime, end: move.EndTime });
    transportByRobot.set(robot, intervals);
  }
  const holdingStartedAt = /* @__PURE__ */ new Map();
  const durations = [];
  const finishHolding = (robot, materials, finishedAt) => {
    for (const material of materials) {
      const key = `${robot}\0${material}`;
      const startedAt = holdingStartedAt.get(key);
      if (startedAt === void 0) continue;
      holdingStartedAt.delete(key);
      if (!completionInsideWindow(finishedAt, window)) continue;
      const rawDuration = Math.max(finishedAt - startedAt, 0);
      const transportDuration = coveredDuration(
        transportByRobot.get(robot) ?? [],
        startedAt,
        finishedAt
      );
      durations.push(Math.max(rawDuration - transportDuration, 0));
    }
  };
  for (const move of moves) {
    const robot = moveRobotName(move);
    if (!robot) continue;
    if (PICK_MOVE_TYPES2.has(move.MoveType)) {
      for (const material of materialIds2(move)) {
        holdingStartedAt.set(`${robot}\0${material}`, move.EndTime);
      }
    } else if (PLACE_MOVE_TYPES2.has(move.MoveType)) {
      finishHolding(robot, materialIds2(move), move.StartTime);
    } else if (move.MoveType === SWAP_MOVE2) {
      finishHolding(robot, materialIds2(move, "SendMatList"), move.StartTime);
      for (const material of materialIds2(move, "RecvMatList")) {
        holdingStartedAt.set(`${robot}\0${material}`, move.EndTime);
      }
    }
  }
  return summarizeDurations(durations);
}
function waferSystemResidenceTime(moves, device, window) {
  const boundaries = waferBoundaryTimes(moves, device);
  const durations = [];
  for (const [material, completedAt] of boundaries.completions) {
    const enteredAt = boundaries.entries.get(material);
    if (enteredAt === void 0 || completedAt < enteredAt - PERFORMANCE_TIME_TOLERANCE || !completionInsideWindow(completedAt, window)) continue;
    durations.push(completedAt - enteredAt);
  }
  return summarizeDurations(durations);
}
function loadLockTransitionDirection(move) {
  const lastState = String(move.LastState ?? "").toUpperCase();
  const currentState = String(move.CurState ?? "").toUpperCase();
  if (lastState === "ATM" && currentState === "VAC") return "vacuum";
  if (lastState === "VAC" && currentState === "ATM") return "vent";
  if (move.MoveType === 12) return "vacuum";
  if (move.MoveType === 13) return "vent";
  return null;
}
function buildLoadLockCycles(moves, device) {
  const cycles = [];
  const pendingByLoadLock = /* @__PURE__ */ new Map();
  for (const move of moves) {
    const direction = loadLockTransitionDirection(move);
    const loadLock = move.ModuleName;
    if (!direction || !isLoadLockName2(loadLock, stationType(device, loadLock))) continue;
    if (direction === "vacuum") {
      const cycle = {
        index: 0,
        loadLock,
        vacuumWafers: materialIds2(move),
        ventWafers: [],
        startTime: move.StartTime,
        pumpEndTime: move.EndTime,
        ventStartTime: 0,
        ventEndTime: 0,
        startedAt: move.StartTime,
        vacuumEndTime: move.EndTime
      };
      cycles.push(cycle);
      pendingByLoadLock.set(loadLock, cycle);
      continue;
    }
    const pending = pendingByLoadLock.get(loadLock);
    if (pending) {
      pending.ventWafers = materialIds2(move);
      pending.ventStartTime = move.StartTime;
      pending.ventEndTime = move.EndTime;
      pendingByLoadLock.delete(loadLock);
      continue;
    }
    cycles.push({
      index: 0,
      loadLock,
      vacuumWafers: [],
      ventWafers: materialIds2(move),
      startTime: move.StartTime,
      pumpEndTime: move.StartTime,
      ventStartTime: move.StartTime,
      ventEndTime: move.EndTime,
      startedAt: move.StartTime,
      vacuumEndTime: move.StartTime
    });
  }
  return cycles.sort((left, right) => left.startedAt - right.startedAt || naturalCompare2(left.loadLock, right.loadLock)).map((cycle, index) => ({
    index: index + 1,
    loadLock: cycle.loadLock,
    vacuumWafers: cycle.vacuumWafers,
    ventWafers: cycle.ventWafers,
    startTime: cycle.startTime,
    pumpEndTime: cycle.pumpEndTime,
    ventStartTime: cycle.ventStartTime,
    ventEndTime: cycle.ventEndTime
  }));
}
function shortJobName(value) {
  const parts = String(value ?? "").split(".").filter(Boolean);
  return parts.at(-1) ?? "";
}
function processStepId(move) {
  const direct = move.StepID;
  if (direct !== void 0 && direct !== null && String(direct) !== "") return String(direct);
  return String(listValue2(move.StepIDList)[0] ?? "");
}
function processPJobName(move) {
  return String(listValue2(move.PJobName)[0] ?? move.PJobName ?? "");
}
function stageMatchesMove(stage, move) {
  const configuredStep = stage.stepId === void 0 || stage.stepId === null ? "" : String(stage.stepId);
  if (configuredStep && configuredStep !== processStepId(move)) return false;
  const configuredJob = shortJobName(stage.pjobName);
  const moveJob = shortJobName(processPJobName(move));
  return !configuredJob || !moveJob || configuredJob === moveJob;
}
function processCapacityGroups(moves, resources, context) {
  const processResourceNames = new Set(
    resources.filter((resource) => resource.kind === "process").map((resource) => resource.name)
  );
  const observed = moves.filter((move) => move.MoveType === PROCESS_MOVE2 && move.EndTime > move.StartTime + PERFORMANCE_TIME_TOLERANCE && processResourceNames.has(move.ModuleName));
  const groups = [];
  for (const stage of context?.processStages ?? []) {
    const names = stage.resourceNames.map(String).filter((name) => processResourceNames.has(name));
    if (!names.length) continue;
    groups.push({
      resourceNames: new Set(names),
      contextLabels: new Set(stage.label ? [String(stage.label)] : [])
    });
  }
  const unmatchedByStage = /* @__PURE__ */ new Map();
  for (const move of observed) {
    let matching = (context?.processStages ?? []).filter((stage) => stageMatchesMove(stage, move));
    if (!matching.length) {
      const moveJob = shortJobName(processPJobName(move));
      matching = (context?.processStages ?? []).filter((stage) => stage.resourceNames.includes(move.ModuleName) && (!shortJobName(stage.pjobName) || shortJobName(stage.pjobName) === moveJob));
    }
    if (matching.length) continue;
    const key = `${processPJobName(move)}|${processStepId(move)}`;
    const names = unmatchedByStage.get(key) ?? /* @__PURE__ */ new Set();
    names.add(move.ModuleName);
    unmatchedByStage.set(key, names);
  }
  for (const [key, names] of unmatchedByStage) {
    groups.push({
      resourceNames: names,
      contextLabels: /* @__PURE__ */ new Set([key.replace("|", " \xB7 \u5DE5\u5E8F ")])
    });
  }
  const merged = /* @__PURE__ */ new Map();
  for (const group of groups) {
    const names = [...group.resourceNames].sort(naturalCompare2);
    const key = names.join("|");
    const existing = merged.get(key) ?? { resourceNames: names, contextLabels: /* @__PURE__ */ new Set() };
    for (const label of group.contextLabels) existing.contextLabels.add(label);
    merged.set(key, existing);
  }
  return [...merged.values()].map((group) => ({
    resourceNames: group.resourceNames,
    contextLabels: [...group.contextLabels].filter(Boolean).sort(naturalCompare2)
  }));
}
function rankBottleneckCandidates(moves, resources, window, context) {
  if (window.duration <= PERFORMANCE_TIME_TOLERANCE) return [];
  const byName = new Map(resources.map((resource) => [resource.name, resource]));
  const raw = [];
  for (const group of processCapacityGroups(moves, resources, context)) {
    const members = group.resourceNames.map((name) => byName.get(name)).filter(
      (resource) => Boolean(resource)
    );
    const busyTime = members.reduce((sum, resource) => sum + resource.busyTime, 0);
    if (!members.length || busyTime <= PERFORMANCE_TIME_TOLERANCE) continue;
    raw.push({
      id: `process:${group.resourceNames.join("+")}`,
      label: `\u5DE5\u5E8F\u5BB9\u91CF\u7EC4 \xB7 ${group.resourceNames.join(" / ")}`,
      kind: "process-group",
      resourceNames: group.resourceNames,
      utilization: busyTime / (members.length * window.duration),
      continuity: members.reduce(
        (sum, resource) => sum + Math.max(0, 1 - resource.longestIdlePeriod / window.duration),
        0
      ) / members.length,
      contextLabels: group.contextLabels
    });
  }
  for (const resource of resources.filter((item) => item.kind === "robot" && item.busyTime > PERFORMANCE_TIME_TOLERANCE)) {
    raw.push({
      id: `robot:${resource.name}`,
      label: resource.name,
      kind: "robot",
      resourceNames: [resource.name],
      utilization: resource.utilization,
      continuity: Math.max(0, 1 - resource.longestIdlePeriod / window.duration),
      contextLabels: []
    });
  }
  const loadLocks = resources.filter((item) => item.kind === "loadlock" && item.busyTime > PERFORMANCE_TIME_TOLERANCE);
  if (loadLocks.length) {
    raw.push({
      id: `loadlock:${loadLocks.map((resource) => resource.name).sort(naturalCompare2).join("+")}`,
      label: `LoadLock \u5BB9\u91CF\u7EC4 \xB7 ${loadLocks.map((resource) => resource.name).sort(naturalCompare2).join(" / ")}`,
      kind: "loadlock-group",
      resourceNames: loadLocks.map((resource) => resource.name).sort(naturalCompare2),
      utilization: loadLocks.reduce((sum, resource) => sum + resource.busyTime, 0) / (loadLocks.length * window.duration),
      continuity: loadLocks.reduce(
        (sum, resource) => sum + Math.max(0, 1 - resource.longestIdlePeriod / window.duration),
        0
      ) / loadLocks.length,
      contextLabels: []
    });
  }
  const maximumByKind = /* @__PURE__ */ new Map();
  for (const candidate of raw) {
    maximumByKind.set(
      candidate.kind,
      Math.max(maximumByKind.get(candidate.kind) ?? 0, candidate.utilization)
    );
  }
  const ranked = raw.map((candidate) => {
    const relative = candidate.utilization / Math.max(
      maximumByKind.get(candidate.kind) ?? 0,
      PERFORMANCE_TIME_TOLERANCE
    );
    const score = Math.min(1, candidate.utilization * 0.82 + candidate.continuity * 0.12 + relative * 0.06);
    const confidence = score >= 0.72 ? "high" : score >= 0.45 ? "medium" : "low";
    const evidence = [
      `${candidate.resourceNames.length > 1 ? "\u7EC4\u5E73\u5747\u5BB9\u91CF\u5360\u7528" : "\u8D44\u6E90\u5360\u7528"} ${(candidate.utilization * 100).toFixed(1)}%`,
      `\u6700\u957F\u7A7A\u95F2\u6298\u7B97\u8FDE\u7EED\u6027 ${(candidate.continuity * 100).toFixed(1)}%`
    ];
    if (candidate.resourceNames.length > 1) {
      evidence.push(`\u5E76\u884C/\u540C\u7C7B\u8D44\u6E90 ${candidate.resourceNames.join("\u3001")}`);
    }
    if (candidate.contextLabels.length) {
      evidence.push(`\u5173\u8054 ${candidate.contextLabels.slice(0, 3).join("\u3001")}`);
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
      evidence
    };
  }).sort((left, right) => right.score - left.score || right.utilization - left.utilization || naturalCompare2(left.label, right.label));
  if (!ranked.length) return [];
  const topScore = ranked[0].score;
  const likelyThreshold = Math.max(0.2, topScore * 0.72, topScore - 0.16);
  return ranked.filter((candidate) => candidate.score >= likelyThreshold).slice(0, 5);
}
function analyzeSchedulePerformance(moves, device, mode = "steady", context = null) {
  const records = normalizeMoves2(moves);
  const window = performanceWindow(records, device, mode);
  const definitions = performanceResourceDefinitions(records, device);
  const intervalsByResource = resourceActivityIntervals(records, device);
  const resources = [...definitions.entries()].map(([name, definition]) => {
    const summary = summarizeIntervals(
      intervalsByResource.get(name) ?? [],
      window.start,
      window.end
    );
    return {
      name,
      type: definition.type,
      kind: definition.kind,
      utilization: window.duration > PERFORMANCE_TIME_TOLERANCE ? summary.busyTime / window.duration : 0,
      ...summary,
      isBottleneck: false,
      bottleneckCandidateRank: null
    };
  });
  const bottleneckCandidates = rankBottleneckCandidates(
    records,
    resources,
    window,
    context
  );
  const primaryBottleneck = bottleneckCandidates[0] ?? null;
  for (const [candidateIndex, candidate] of bottleneckCandidates.entries()) {
    for (const name of candidate.resourceNames) {
      const resource = resources.find((item) => item.name === name);
      if (!resource) continue;
      resource.bottleneckCandidateRank = resource.bottleneckCandidateRank === null ? candidateIndex + 1 : Math.min(resource.bottleneckCandidateRank, candidateIndex + 1);
      if (candidateIndex === 0) resource.isBottleneck = true;
    }
  }
  const bottleneck = primaryBottleneck ? resources.find((resource) => primaryBottleneck.resourceNames.includes(resource.name)) ?? null : null;
  const kindOrder = {
    robot: 0,
    loadlock: 1,
    process: 2,
    auxiliary: 3,
    loadport: 4
  };
  resources.sort((left, right) => Number(right.isBottleneck) - Number(left.isBottleneck) || kindOrder[left.kind] - kindOrder[right.kind] || right.utilization - left.utilization || naturalCompare2(left.name, right.name));
  const boundaries = waferBoundaryTimes(records, device);
  const completionTimes = [...boundaries.completions.values()].filter((time) => time >= window.start - PERFORMANCE_TIME_TOLERANCE && time <= window.end + PERFORMANCE_TIME_TOLERANCE).sort((left, right) => left - right);
  const departureIntervals = completionTimes.slice(1).map((time, index) => time - completionTimes[index]);
  const meanDepartureInterval = departureIntervals.length ? departureIntervals.reduce((sum, interval) => sum + interval, 0) / departureIntervals.length : 0;
  const throughputPerHour = meanDepartureInterval > PERFORMANCE_TIME_TOLERANCE ? 3600 / meanDepartureInterval : 0;
  const chamberDwellTime = processChamberDwellTime(records, device, window);
  const robotDwellTime = robotWaferDwellTime(records, window);
  const systemResidenceTime = waferSystemResidenceTime(records, device, window);
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
    loadLockCycles
  };
}
function summarizeBottleneckUtilization(performance2) {
  const candidate = performance2.primaryBottleneck;
  if (!candidate) return null;
  return {
    resourceName: candidate.label,
    utilization: candidate.utilization,
    windowLabel: performance2.window.label,
    confidence: candidate.confidence,
    candidateCount: performance2.bottleneckCandidates.length,
    score: candidate.score
  };
}
function displayedPerformanceResources(performance2) {
  return performance2.resources.filter(
    (resource) => resource.busyTime > PERFORMANCE_TIME_TOLERANCE
  );
}

// ../analysis/schedule_context.ts
function buildScheduleAnalysisContext(routes, rounds) {
  const routeByName = new Map(
    (routes ?? []).map((route) => [String(route?.name ?? ""), route])
  );
  const processStages = [];
  for (const [roundIndex, round] of (rounds ?? []).entries()) {
    for (const [cjobIndex, cjob] of (round?.cjobs ?? []).entries()) {
      for (const pjob of cjob?.pjobs ?? []) {
        const route = routeByName.get(String(pjob?.routeRef ?? ""));
        if (!route) continue;
        let processOrdinal = 0;
        for (const stage of route.stages ?? []) {
          if (!stage?.needProcess) continue;
          processOrdinal += 1;
          const resourceNames = [...new Set(
            (stage.visits ?? []).map((visit) => String(visit?.stationName ?? "").trim()).filter(Boolean)
          )];
          if (!resourceNames.length) continue;
          const taskId = String(roundIndex + 1);
          const cjobKey = String(cjob?.key ?? `C${cjobIndex + 1}`);
          const jobName = String(pjob?.jobName ?? "P?");
          processStages.push({
            id: `${taskId}.${cjobKey}.${jobName}:step-${stage.stepId}`,
            label: `${jobName} \xB7 \u5DE5\u5E8F ${processOrdinal}`,
            pjobName: `${taskId}.${cjobKey}.${jobName}`,
            stepId: stage.stepId,
            resourceNames
          });
        }
      }
    }
  }
  return { processStages };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  analyzeSchedulePerformance,
  buildScheduleAnalysisContext,
  buildWorkspaceSnapshot,
  createVisualizationWorkspace,
  decisionAtTime,
  displayedPerformanceResources,
  normalizeDecisionTrace,
  normalizeMovePayload,
  renderEquipmentTopology,
  snapshotWithFullDeviceModules,
  summarizeBottleneckUtilization
});
