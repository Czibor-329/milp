var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/route_editor_logic.ts
var route_editor_logic_exports = {};
__export(route_editor_logic_exports, {
  VISIT_SHARED_FIELDS: () => VISIT_SHARED_FIELDS,
  automaticRouteName: () => automaticRouteName,
  cloneVisitParameters: () => cloneVisitParameters,
  compareProfiles: () => compareProfiles,
  differenceFields: () => differenceFields,
  minimumResidencyConstraint: () => minimumResidencyConstraint,
  processProfile: () => processProfile,
  processRecipeName: () => processRecipeName,
  replaceCandidates: () => replaceCandidates,
  routeCleanSignature: () => routeCleanSignature,
  selectReferencedRoutes: () => selectReferencedRoutes,
  synchronizeVisits: () => synchronizeVisits
});
var VISIT_SHARED_FIELDS = [
  "processTime",
  "recipeTime",
  "processRecipe",
  "processType",
  "slotIds",
  "weight",
  "moveTimeOffset",
  "qTimeLimit",
  "residencyConstraint",
  "beforeCleanRefs",
  "afterCleanRefs"
];
function cloneValue(value) {
  return value === void 0 ? value : structuredClone(value);
}
function cloneVisitParameters(visit) {
  return Object.fromEntries(
    VISIT_SHARED_FIELDS.map((key) => [key, cloneValue(visit?.[key])])
  );
}
function processProfile(route) {
  const processStages = (route.stages || []).filter((stage) => stage.needProcess);
  const candidateGroups = processStages.map((stage) => [
    ...new Set((stage.visits || []).map((visit) => String(visit.stationName || "").trim()).filter(Boolean))
  ]);
  const counts = candidateGroups.map((candidates) => candidates.length);
  const candidatePath = candidateGroups.map(
    (candidates) => candidates.join("/") || "\u672A\u9009\u62E9\u8154\u5BA4"
  );
  const processTimes = processStages.map(
    (stage) => Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0)
  );
  const processCount = processStages.length;
  const candidateOccurrences = candidateGroups.flat();
  const isReentrant = new Set(candidateOccurrences).size < candidateOccurrences.length;
  return {
    processCount,
    counts,
    candidatePath,
    processTimes,
    isReentrant,
    processLabel: isReentrant ? "\u91CD\u5165\u7EC4" : processCount === 0 ? "\u65E0\u52A0\u5DE5\u5DE5\u5E8F" : `${processCount} \u9053\u5DE5\u5E8F`,
    label: isReentrant ? "\u91CD\u5165\u8DEF\u5F84" : processCount === 0 ? "(0)" : `(${counts.join(", ")})`,
    key: isReentrant ? "reentrant" : processCount === 0 ? "0:none" : `${processCount}:${counts.join(",")}`
  };
}
function formatSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Number.isInteger(number) ? number : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s` : "\u672A\u8BBE\u7F6E";
}
function cleanNames(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(rows.map((item) => String(item || "").trim()).filter(Boolean))];
}
function routeCleanSignature(route) {
  const parts = [];
  const append = (label, value) => {
    const names = cleanNames(value);
    if (names.length) parts.push(`${label}:${names.join("+")}`);
  };
  append("Pre", route.prePJobCleanRefs);
  append("Post", route.postPJobCleanRefs);
  append("CJob", route.postCJobCleanRefs);
  (route.stages || []).filter((stage) => stage.needProcess).forEach((stage, index) => {
    const before = [...new Set((stage.visits || []).flatMap((visit) => cleanNames(visit.beforeCleanRefs)))];
    const after = [...new Set((stage.visits || []).flatMap((visit) => cleanNames(visit.afterCleanRefs)))];
    append(`S${index + 1}\u524D`, before);
    append(`S${index + 1}\u540E`, after);
  });
  return parts.join(" \xB7 ");
}
function minimumResidencyConstraint(route) {
  const limits = (route.stages || []).filter((stage) => stage.needProcess).flatMap((stage) => stage.visits || []).map((visit) => Number(visit.residencyConstraint)).filter((limit) => Number.isFinite(limit) && limit >= 0);
  return limits.length ? Math.min(...limits) : null;
}
function automaticRouteName(profile, cleanSignature = "", minimumResidency = null) {
  const processName = profile.processCount === 0 ? "\u65E0\u52A0\u5DE5\u5DE5\u5E8F" : profile.candidatePath.map(
    (path, index) => `${path}(${formatSeconds(profile.processTimes[index])})`
  ).join(" \u2192 ");
  const suffixes = [
    cleanSignature,
    minimumResidency === null ? "" : `\u9A7B\u7559 ${formatSeconds(minimumResidency)}`
  ].filter(Boolean);
  return suffixes.length ? `${processName} \xB7 ${suffixes.join(" \xB7 ")}` : processName;
}
function compareProfiles(left, right) {
  if (left.processCount !== right.processCount) return left.processCount - right.processCount;
  for (let index = 0; index < Math.max(left.counts.length, right.counts.length); index += 1) {
    if ((left.counts[index] ?? -1) !== (right.counts[index] ?? -1)) {
      return (left.counts[index] ?? -1) - (right.counts[index] ?? -1);
    }
  }
  return 0;
}
function differenceFields(stage, normalizeVisit2 = (value) => value) {
  if ((stage.visits || []).length < 2) return [];
  const first = normalizeVisit2(stage.visits[0]);
  return VISIT_SHARED_FIELDS.filter((key) => stage.visits.slice(1).some(
    (visit) => JSON.stringify(normalizeVisit2(visit)[key]) !== JSON.stringify(first[key])
  ));
}
function synchronizeVisits(stage, normalizeVisit2 = (value) => value) {
  if (!(stage.visits || []).length) return;
  const parameters = cloneVisitParameters(normalizeVisit2(stage.visits[0]));
  stage.visits.forEach((visit) => Object.assign(visit, structuredClone(parameters)));
}
function replaceCandidates(stage, names, makeVisit2, normalizeVisit2 = (value) => value) {
  const selected = [...new Set((names || []).map((name) => String(name || "").trim()).filter(Boolean))];
  const prior = new Map((stage.visits || []).map((visit) => [visit.stationName, visit]));
  const template = stage.visits?.length ? cloneVisitParameters(normalizeVisit2(stage.visits[0])) : cloneVisitParameters(normalizeVisit2(makeVisit2("")));
  stage.visits = selected.map(
    (name) => prior.get(name) || { stationName: name, ...structuredClone(template) }
  );
}
function selectReferencedRoutes(routes, rounds) {
  const referencedNames = new Set((rounds || []).flatMap((round) => (round.cjobs || []).flatMap((cjob) => (cjob.pjobs || []).map((pjob) => String(pjob.routeRef || "").trim()))));
  return (routes || []).filter((route) => referencedNames.has(String(route.name || "").trim()));
}
function processRecipeName(value, fallback) {
  const explicitName = String(value ?? "").trim();
  return explicitName || String(fallback ?? "").trim();
}

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
async function requestTestGroupAnalysis(cases) {
  const result = await requestJson("/api/analysis/test-group", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cases })
  });
  return result.analysis;
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
      executed: Boolean(candidate.executed),
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
      executedActionId: String(step.executedActionId ?? ""),
      candidateCount: Math.max(candidates.length, finiteNumber(step.candidateCount, candidates.length)),
      shownCandidateCount: Math.max(candidates.length, finiteNumber(step.shownCandidateCount, candidates.length)),
      candidatesTruncated: Boolean(step.candidatesTruncated),
      modelEvaluated: Boolean(step.modelEvaluated),
      replayEvaluated: Boolean(step.replayEvaluated),
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
function formatSeconds2(value) {
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
function isTopologyHiddenModule(module) {
  const name = module.name.trim();
  const type = module.type.trim().toLowerCase();
  return /^BUF(?:FER)?(?:[_-]?\w+)?$/i.test(name) || type === "buffer" || isDummyPortName(name) || type === "dummyport" || /^HEATER$/i.test(name) || type === "heater";
}
function isLoadPortName(name, type = "") {
  return !isDummyPortName(name) && (type.toLowerCase() === "loadport" || /^(LP\d*|P\d+|.*PORT)$/i.test(name));
}
function isLoadLockName(name, type = "") {
  return type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name) || /^BUF_/i.test(name);
}
function initialLoadLockEnvironment(device, name) {
  const lastItem = String(device?.Stations?.[name]?.LastItem ?? "");
  if (/VTR|VAC|真空/i.test(lastItem)) return "\u771F\u7A7A";
  if (/ATR|ATM|大气/i.test(lastItem)) return "\u5927\u6C14";
  return "\u5927\u6C14";
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
        if (!locations.has(material)) locations.set(material, station);
      }
      for (const material of materialIds(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, move.ModuleName);
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
function buildLoadPortSlots(records, device, time, initialLocations, processedMaterials) {
  const names = /* @__PURE__ */ new Set();
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (isLoadPortName(name, String(definition?.Type ?? ""))) names.add(name);
  }
  for (const location of initialLocations.values()) {
    if (isLoadPortName(location, String(device?.Stations?.[location]?.Type ?? ""))) names.add(location);
  }
  const initialByPort = /* @__PURE__ */ new Map();
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
      const occupancy = initialByPort.get(source) ?? /* @__PURE__ */ new Map();
      if (!occupancy.has(slot)) occupancy.set(slot, material);
      initialByPort.set(source, occupancy);
      observedMaximum.set(source, Math.max(observedMaximum.get(source) ?? 0, slot));
    });
  }
  const result = /* @__PURE__ */ new Map();
  for (const name of names) {
    const occupancy = new Map(initialByPort.get(name) ?? []);
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
  const time = Math.max(0, Math.min(finiteNumber(requestedTime), endTime));
  const definitions = collectModuleDefinitions(records, device);
  const robotNames = collectRobotNames(records, device);
  const initialLocations = initialMaterialLocations(records);
  const locations = new Map(initialLocations);
  const doorStates = /* @__PURE__ */ new Map();
  const environments = /* @__PURE__ */ new Map();
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
  const lastRobotTargets = /* @__PURE__ */ new Map();
  for (const move of records) {
    if (move.StartTime > time || !isRobotName(move.ModuleName)) continue;
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
      loadPortSlots: loadPortSlots.get(name) ?? [],
      loadLockSlots: loadLockSlots.get(name) ?? [],
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
      processedWafers: (wafersByLocation.get(name) ?? []).filter((wafer) => processedMaterials.has(wafer)),
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
    alignerFilter: required("visualFilterAligner"),
    coolerFilter: required("visualFilterCooler"),
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
  const knownNames = new Set(modules.map((module) => module.name));
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
      loadLockSlots: [],
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
  const knownNames = new Set(modules.map((module) => module.name));
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
      loadLockSlots: [],
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
  const loadLocks = modules.filter((module) => isLoadLockName(module.name, module.type));
  const loadPorts = modules.filter((module) => isLoadPortName(module.name, module.type));
  const processModules = modules.filter((module) => isProcessModule(module.name, module.type));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map((module) => module.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter((module) => !assignedNames.has(module.name))
  };
}
function renderWaferToken(wafer, progress, processed = false) {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  const state2 = processed ? "processed" : "unprocessed";
  return `<span class="wafer-token wafer-${state2}" style="--wafer-progress:${normalizedProgress * 360}deg" title="\u6676\u5706 ${escapeHtml(wafer)}\uFF0C${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}"><span>${escapeHtml(wafer)}</span></span>`;
}
function moduleDoorSides(module, role) {
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
function renderLoadPortCassette(module) {
  const slots = module.loadPortSlots.length ? module.loadPortSlots : module.wafers.map((wafer, index) => ({
    slot: index + 1,
    wafer,
    processed: module.processedWafers.includes(wafer)
  }));
  const processed = slots.filter((slot) => slot.wafer && slot.processed).length;
  const unprocessed = slots.filter((slot) => slot.wafer && !slot.processed).length;
  const slotMarkup = slots.map((slot) => {
    const state2 = !slot.wafer ? "empty" : slot.processed ? "processed" : "unprocessed";
    const label = slot.wafer ? `\u69FD\u4F4D ${slot.slot}\uFF0C\u6676\u5706 ${slot.wafer}\uFF0C${slot.processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}` : `\u69FD\u4F4D ${slot.slot}\uFF0C\u7A7A`;
    return `<span class="load-port-slot is-${state2}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`;
  }).join("");
  return `<div class="load-port-cassette" role="group" aria-label="${escapeHtml(`${module.name} \u6B63\u89C6\u6676\u5706\u76D2\uFF0C\u5171 ${slots.length} \u4E2A\u69FD\u4F4D\uFF0C\u672A\u52A0\u5DE5 ${unprocessed}\uFF0C\u5DF2\u52A0\u5DE5 ${processed}`)}">
    <span class="load-port-cassette-handle" aria-hidden="true"></span>
    <div class="load-port-slot-bank">${slotMarkup}</div>
  </div>`;
}
function renderModule(module, role, candidate) {
  const waferProgress = module.status === "processing" ? module.progress : 0;
  const visibleWaferCount = role === "lock" ? 2 : 1;
  const processedWafers = new Set(module.processedWafers ?? []);
  const wafers = module.wafers.slice(0, visibleWaferCount).map((wafer) => renderWaferToken(wafer, waferProgress, processedWafers.has(wafer))).join("");
  const layerCount = role === "lock" && module.loadLockSlots.length ? module.loadLockSlots.filter((slot) => slot.wafer).length : module.wafers.length;
  const overflow = layerCount > visibleWaferCount ? `<span class="wafer-more">+ ${layerCount - visibleWaferCount}</span>` : "";
  const doors = moduleDoorSides(module, role).map((side) => `<i class="chamber-door chamber-door-${side}"></i>`).join("");
  const accessibleStatus = `${module.name}\uFF0C${STATUS_LABELS[module.status]}\uFF0C${DOOR_LABELS[module.door]}`;
  const candidateLabel = candidate ? `${candidate.count} \u4E2A\u53EF\u884C\u52A8\u4F5C\uFF0C\u6700\u9AD8\u6A21\u578B\u504F\u597D ${(candidate.preference * 100).toFixed(0)}%` : "";
  const atmosphereLevel = role === "lock" ? module.loadLockPhase === "pumping" ? 100 - module.progress * 100 : module.loadLockPhase === "venting" ? module.progress * 100 : /大气|ATM|ATR/i.test(module.environment) ? 100 : 0 : 0;
  const loadLockLayers = role === "lock" ? `<div class="loadlock-layers" aria-hidden="true">${[0, 1].map((index) => {
    const layer = module.loadLockSlots[index];
    const wafer = layer ? layer.wafer : module.wafers[index];
    const processed = layer ? layer.processed : wafer ? processedWafers.has(wafer) : false;
    const waferState = processed ? "processed" : "unprocessed";
    return `<div class="loadlock-layer ${wafer ? "is-occupied" : "is-empty"}">${wafer ? `<span class="loadlock-wafer-line wafer-${waferState}" title="\u6676\u5706 ${escapeHtml(wafer)}\uFF08${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}\uFF09"></span>` : ""}</div>`;
  }).join("")}${overflow}</div>` : role === "process" ? `<div class="process-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : role === "port" ? `<div class="load-port-dock-face" aria-hidden="true"><span></span></div>` : role === "auxiliary" ? `<div class="auxiliary-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : `<div class="wafer-stack">${wafers}${overflow}</div>`;
  const article = `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.loadLockPhase ? `loadlock-${module.loadLockPhase}` : ""} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" style="--module-progress:${Math.round(module.progress * 100)}%;--loadlock-atmosphere:${Math.max(0, Math.min(100, atmosphereLevel)).toFixed(1)}%;--loadlock-atmosphere-ratio:${Math.max(0, Math.min(1, atmosphereLevel / 100)).toFixed(3)}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
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
function renderRobotHub(robot, environment, angleDegrees) {
  const wafer = robot.wafers[0] ? renderWaferToken(robot.wafers[0], 0, robot.processedWafers.includes(robot.wafers[0])) : "";
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" style="--robot-arm-angle:${angleDegrees.toFixed(1)}deg" aria-label="${escapeHtml(robot.name)}\uFF0C\u5355\u69FD\u673A\u68B0\u624B\uFF0C${robot.busy ? "\u5DE5\u4F5C\u4E2D" : "\u5F85\u547D"}${robot.wafers[0] ? `\uFF0C\u6301\u6709\u6676\u5706 ${robot.wafers[0]}` : "\uFF0C\u69FD\u4F4D\u4E3A\u7A7A"}">
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
var TOPOLOGY_COLUMN_PERCENTAGES = [26, 42, 58, 74];
var TOPOLOGY_ROW_TOP_PIXELS = [52, 154, 256, 358, 460, 562, 664, 786, 929, 1031, 1133];
var TOPOLOGY_VIEWBOX_WIDTH = 1e3;
var TOPOLOGY_ITEM_SIZE = 96;
var TOPOLOGY_PROCESS_WIDTH = 112;
var TOPOLOGY_PROCESS_HEIGHT = 104;
var TOPOLOGY_ROBOT_SIZE = 132;
var TOPOLOGY_LOADLOCK_WIDTH = 120;
var TOPOLOGY_LOADLOCK_HEIGHT = 72;
var TOPOLOGY_LOADPORT_WIDTH = 144;
var TOPOLOGY_LOADPORT_HEIGHT = 104;
var TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS = [664, 740];
var TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS = 866;
var TOPOLOGY_LOADPORT_ROW_TOP_PIXELS = 990;
var TOPOLOGY_CANVAS_PADDING = 28;
var TOPOLOGY_EXTERNAL_LABEL_CLEARANCE = 22;
var TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP = TOPOLOGY_ROW_TOP_PIXELS[4] - 32;
var TOPOLOGY_SINGLE_PROCESS_LOWER_TOP = TOPOLOGY_ROW_TOP_PIXELS[5] - 10;
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
  return vacuumRobotCount > 1 || modules.some((module) => processModuleNumber(module.name) > 6 || /^BUF[_-]?[AB]$/i.test(module.name));
}
function moduleTopologyPosition(module, role, index, roleModules, cascade) {
  const name = module.name.trim().toUpperCase();
  const roleCount = roleModules.length;
  const column = TOPOLOGY_COLUMN_PERCENTAGES;
  const row = TOPOLOGY_ROW_TOP_PIXELS;
  const cascadePositions = {
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
    PM10: { leftPercent: column[3], topPixels: row[5] + TOPOLOGY_EXTERNAL_LABEL_CLEARANCE }
  };
  const singlePositions = {
    PM3: { leftPercent: column[1], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP - TOPOLOGY_PROCESS_HEIGHT },
    PM4: { leftPercent: column[2], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP - TOPOLOGY_PROCESS_HEIGHT },
    PM2: { leftPercent: column[0], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP },
    PM1: { leftPercent: column[0], topPixels: TOPOLOGY_SINGLE_PROCESS_LOWER_TOP },
    PM5: { leftPercent: column[3], topPixels: TOPOLOGY_SINGLE_PROCESS_MIDDLE_TOP },
    PM6: { leftPercent: column[3], topPixels: TOPOLOGY_SINGLE_PROCESS_LOWER_TOP }
  };
  const explicit = (cascade ? cascadePositions : singlePositions)[name];
  if (explicit) {
    return role === "process" ? { ...explicit, widthPixels: TOPOLOGY_PROCESS_WIDTH, heightPixels: TOPOLOGY_PROCESS_HEIGHT } : explicit;
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
    const gridIndex = Math.max(0, orderedLoadLocks.findIndex((item) => item.name === module.name));
    const loadLockRowGap = TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[1] - TOPOLOGY_LOADLOCK_ROW_TOP_PIXELS[0];
    return {
      leftPercent: gridIndex % 2 === 0 ? 40 : 60,
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
      return {
        leftPercent: loadPortColumns[name],
        topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS,
        widthPixels: TOPOLOGY_LOADPORT_WIDTH,
        heightPixels: TOPOLOGY_LOADPORT_HEIGHT
      };
    }
    return {
      leftPercent: distributedTopologyColumns(roleCount)[index],
      topPixels: TOPOLOGY_LOADPORT_ROW_TOP_PIXELS,
      widthPixels: TOPOLOGY_LOADPORT_WIDTH,
      heightPixels: TOPOLOGY_LOADPORT_HEIGHT
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
function robotTopologyPosition(robotIndex, robotCount, environment, cascade) {
  if (environment === "atmosphere") {
    if (robotCount > 1) {
      return {
        leftPercent: distributedTopologyColumns(robotCount)[robotIndex] ?? 50,
        topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS,
        widthPixels: TOPOLOGY_ROBOT_SIZE,
        heightPixels: TOPOLOGY_ROBOT_SIZE
      };
    }
    return {
      leftPercent: 50,
      topPixels: TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS,
      widthPixels: TOPOLOGY_ROBOT_SIZE,
      heightPixels: TOPOLOGY_ROBOT_SIZE
    };
  }
  if (cascade && robotCount > 1) {
    return {
      leftPercent: 50,
      topPixels: robotIndex === 0 ? TOPOLOGY_ROW_TOP_PIXELS[4] : (TOPOLOGY_ROW_TOP_PIXELS[1] + TOPOLOGY_ROW_TOP_PIXELS[2]) / 2 + TOPOLOGY_EXTERNAL_LABEL_CLEARANCE / 2,
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
function robotLoadLockPortal(robotName, moduleName, modulePositions) {
  const normalizedModule = moduleName.trim().toUpperCase();
  const isAtmosphereRobot = /^(ATR|ATM)/i.test(robotName);
  const isVacuumRobot = /^(VTR|VTM)/i.test(robotName);
  if (!isAtmosphereRobot && !isVacuumRobot) return moduleName;
  const preferred = ["LA", "LC"].includes(normalizedModule) ? isAtmosphereRobot ? "LC" : "LA" : ["LB", "LD"].includes(normalizedModule) ? isAtmosphereRobot ? "LD" : "LB" : moduleName;
  return modulePositions.has(preferred) ? preferred : moduleName;
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
function isModuleFilteredOut(module, hiddenFilters) {
  if (!hiddenFilters?.size) return false;
  const normalized = module.name.trim().toUpperCase();
  const type = module.type.trim().toLowerCase();
  return hiddenFilters.has("aligner") && (/^(AL|ALIGNER)$/.test(normalized) || type === "aligner") || hiddenFilters.has("cooler") && (/^(CL|COOL(?:ER)?)$/.test(normalized) || type === "cooler");
}
function renderEquipmentTopology(snapshot, decision, hiddenFilters) {
  const visibleModules = snapshot.modules.filter((module) => !isTopologyHiddenModule(module) && !isModuleFilteredOut(module, hiddenFilters));
  const groups = topologyGroups(visibleModules);
  const destinations = candidateDestinations(decision);
  const atmosphereRobots = snapshot.robots.filter((robot) => /^(ATR|ATM)/i.test(robot.name));
  const atmosphereNames = new Set(atmosphereRobots.map((robot) => robot.name));
  const vacuumRobots = snapshot.robots.filter((robot) => !atmosphereNames.has(robot.name));
  const cascade = usesCascadeTopology(visibleModules, vacuumRobots.length);
  const modulePositions = /* @__PURE__ */ new Map();
  const positionModuleGroup = (modules, role) => modules.forEach((module, index) => {
    const position = moduleTopologyPosition(module, role, index, modules, cascade);
    modulePositions.set(module.name, position);
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
  const positionedModules = (modules) => modules.map((module) => modulePositions.get(module.name)).filter((position) => Boolean(position));
  const positionedRobots = (robots) => robots.map((robot) => robotPositions.get(robot.name)).filter((position) => Boolean(position));
  const vacuumExtent = topologyVerticalExtent([
    ...positionedModules(groups.processModules),
    ...positionedRobots(vacuumRobots)
  ]);
  const interfaceExtent = topologyVerticalExtent(positionedModules(groups.loadLocks));
  const atmosphereExtent = topologyVerticalExtent([
    ...positionedModules(groups.auxiliaryModules),
    ...positionedModules(groups.loadPorts),
    ...positionedRobots(atmosphereRobots)
  ]);
  const interfaceTop = interfaceExtent ? Math.max(12, interfaceExtent.top - 12) : Math.round(canvasHeight * 0.48);
  const interfaceBottom = interfaceExtent ? Math.min(canvasHeight - 12, interfaceExtent.bottom + 12) : interfaceTop;
  const vacuumTop = vacuumExtent ? Math.max(12, vacuumExtent.top - 24) : 12;
  const vacuumBottom = Math.max(vacuumTop + 120, interfaceTop - 12);
  const atmosphereTop = interfaceExtent ? interfaceBottom + 12 : Math.round(canvasHeight * 0.52);
  const atmosphereBottom = atmosphereExtent ? Math.min(canvasHeight - 12, atmosphereExtent.bottom + 24) : canvasHeight - 12;
  const machineAreaMarkup = `
    <div class="topology-zone topology-zone-vacuum" style="--zone-top:${vacuumTop}px;--zone-height:${Math.max(120, vacuumBottom - vacuumTop)}px" aria-hidden="true">
      <span><small>\u771F\u7A7A\u52A0\u5DE5\u533A</small></span>
    </div>
    ${interfaceExtent ? `<div class="topology-interface-bay" style="--zone-top:${interfaceTop}px;--zone-height:${Math.max(96, interfaceBottom - interfaceTop)}px" aria-hidden="true"><span>VACUUM / ATM INTERFACE</span></div>` : ""}
    <div class="topology-zone topology-zone-atmosphere" style="--zone-top:${atmosphereTop}px;--zone-height:${Math.max(120, atmosphereBottom - atmosphereTop)}px" aria-hidden="true">
      <span><small>\u5927\u6C14\u4F20\u8F93\u533A</small></span>
    </div>`;
  const renderModuleGroup = (modules, role) => modules.map((module) => {
    const position = modulePositions.get(module.name);
    if (!position) return "";
    return `<div class="reference-module-position" style="--module-left:${position.leftPercent}%;--module-top:${position.topPixels}px">${renderModule(module, role, destinations.get(module.name))}</div>`;
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
    const target = robot.target || decisionTargetForRobot(robot, decision);
    const portal = robotLoadLockPortal(robot.name, target, modulePositions);
    const targetPosition = modulePositions.get(portal);
    const targetAngle = targetPosition ? Math.atan2(
      targetPosition.topPixels - position.topPixels,
      targetPosition.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH - position.leftPercent / 100 * TOPOLOGY_VIEWBOX_WIDTH
    ) : -Math.PI / 2;
    let armAngle = targetAngle;
    if (robot.isPreTrans && robot.source) {
      const sourcePortal = robotLoadLockPortal(robot.name, robot.source, modulePositions);
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
    <section class="equipment-schematic" aria-label="\u5B8C\u6574\u8BBE\u5907\u62D3\u6251\u56DE\u653E">
      <div class="schematic-canvas reference-grid-canvas" style="--topology-canvas-height:${canvasHeight}px">
        ${machineAreaMarkup}
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
  const source = candidate.source || "\u5F53\u524D\u4F4D\u7F6E";
  const destination = candidate.destination || "\u2014";
  return `${source} \u2192 ${destination}${candidate.destinationSlot ? ` \xB7 \u69FD ${candidate.destinationSlot}` : ""}`;
}
function decisionBoundaryTimes(moves) {
  return [...new Set(
    moves.filter((move) => DECISION_COMPLETION_MOVE_TYPES.has(finiteNumber(move.MoveType, -1))).map((move) => finiteNumber(move.EndTime)).filter((time) => time >= 0)
  )].sort((left, right) => left - right);
}
function renderDecisionLens(decision) {
  if (!decision) {
    return `
      <div class="decision-empty">
        <strong>\u5F53\u524D\u65F6\u523B\u6682\u65E0\u5408\u6CD5\u52A8\u4F5C</strong>
        <p>\u56DE\u653E\u5230\u4E0B\u4E00\u8BBE\u5907\u4E8B\u4EF6\u540E\u66F4\u65B0\u3002</p>
      </div>`;
  }
  const shownText = decision.candidatesTruncated ? `\u5C55\u793A Top ${decision.shownCandidateCount} / ${decision.candidateCount}` : `${decision.candidateCount} \u4E2A\u53EF\u884C\u52A8\u4F5C`;
  const rankedCandidates = [...decision.candidates].sort((left, right) => right.policyPreference - left.policyPreference || left.rank - right.rank || left.actionId.localeCompare(right.actionId));
  const candidates = rankedCandidates.map((candidate, index) => {
    const preference = modelPreference(candidate.policyPreference);
    const isRecommendation = index === 0;
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
        <strong id="decisionCandidatesTitle">\u51B3\u7B56 #${decision.decisionIndex} <small>@ ${formatSeconds2(decision.time)}s</small></strong>
        <span>${escapeHtml(shownText)} \xB7 E2E \u6392\u5E8F</span>
      </header>
      ${candidates ? `<ol>${candidates}</ol>` : '<p class="decision-alternative-empty">\u5F53\u524D\u6CA1\u6709\u5408\u6CD5\u52A8\u4F5C</p>'}
    </section>`;
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
    return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds2(duration)} s"></span>`;
  }).join("");
}
function renderBottleneckAnalysis(performance2) {
  const { window: window2, bottleneckCandidates, resources } = performance2;
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
        <div class="utilization-track" aria-label="${escapeHtml(resource.name)} \u5360\u7528\u7387 ${formatPercent(resource.utilization)}">${renderCategoryBars(resource, window2.duration)}</div>
        <small class="resource-utilization-time">${formatSeconds2(resource.busyTime)} s</small>
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
    <p class="performance-window-note">${escapeHtml(window2.detail)}</p>`;
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
  const window2 = performance2.window;
  const bottleneck = performance2.primaryBottleneck;
  const confidenceLabels = { high: "\u8BC1\u636E\u8F83\u5F3A", medium: "\u8BC1\u636E\u4E2D\u7B49", low: "\u8BC1\u636E\u8F83\u5F31" };
  return `
    <section class="result-card overview-card">
      <header class="overview-head"><span class="visual-kicker">\u6392\u7A0B\u6982\u89C8</span><strong>KPI \u603B\u89C8</strong></header>
      <div class="performance-summary">
        <div>
          <span>\u7EDF\u8BA1\u7A97\u53E3</span>
          <strong>${escapeHtml(window2.label)} \xB7 ${formatSeconds2(window2.duration)} s</strong>
          <small>\u5254\u9664\u5F00\u5934 ${formatSeconds2(window2.trimmedStart)} s / \u7ED3\u5C3E ${formatSeconds2(window2.trimmedEnd)} s</small>
        </div>
        <div>
          <span>\u6700\u53EF\u80FD\u74F6\u9888</span>
          <strong>${escapeHtml(bottleneck?.label ?? "\u2014")}</strong>
          <small>${bottleneck ? `\u5BB9\u91CF\u5229\u7528\u7387 ${formatPercent(bottleneck.utilization)} \xB7 ${confidenceLabels[bottleneck.confidence]} \xB7 \u53E6\u6709 ${Math.max(0, performance2.bottleneckCandidates.length - 1)} \u4E2A\u5019\u9009` : "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8"}</small>
        </div>
        <div>
          <span>\u51FA\u7AD9\u8282\u62CD</span>
          <strong>${performance2.throughputPerHour > 0 ? `${performance2.throughputPerHour.toFixed(1)} \u7247/h` : "\u2014"}</strong>
          <small>\u5E73\u5747\u95F4\u9694 ${formatSeconds2(performance2.meanDepartureInterval)} s \xB7 \u95F4\u9694 CV ${performance2.departureIntervalCv.toFixed(2)} \xB7 ${performance2.completedWaferCount} \u7247\u6837\u672C</small>
        </div>
        <div>
          <span>\u6676\u5706\u9A7B\u7559\u65F6\u95F4 \xB7 \u52A0\u5DE5\u8154</span>
          <strong>${performance2.processChamberDwellTime.sampleCount ? `${formatSeconds2(performance2.processChamberDwellTime.meanSeconds)} s` : "\u2014"}</strong>
          <small>\u52A0\u5DE5\u7ED3\u675F \u2192 \u5B8C\u5168\u79BB\u8154 \xB7 \u4E2D\u4F4D ${formatSeconds2(performance2.processChamberDwellTime.medianSeconds)} s \xB7 \u6700\u5927 ${formatSeconds2(performance2.processChamberDwellTime.maxSeconds)} s \xB7 ${performance2.processChamberDwellTime.sampleCount} \u6B21</small>
        </div>
        <div>
          <span>\u673A\u5668\u624B\u9A7B\u7559\u65F6\u95F4</span>
          <strong>${performance2.robotWaferDwellTime.sampleCount ? `${formatSeconds2(performance2.robotWaferDwellTime.meanSeconds)} s` : "\u2014"}</strong>
          <small>Pick \u5B8C\u6210 \u2192 Place \u5F00\u59CB\uFF0C\u5DF2\u6263\u9664 PreTrans \u8FD0\u8F93 \xB7 \u6700\u5927 ${formatSeconds2(performance2.robotWaferDwellTime.maxSeconds)} s \xB7 ${performance2.robotWaferDwellTime.sampleCount} \u6B21</small>
        </div>
        <div>
          <span>\u6676\u5706\u7CFB\u7EDF\u505C\u7559\u65F6\u95F4</span>
          <strong>${performance2.waferSystemResidenceTime.sampleCount ? `${formatSeconds2(performance2.waferSystemResidenceTime.meanSeconds)} s` : "\u2014"}</strong>
          <small>\u79BB\u5F00 LP \u2192 \u8FD4\u56DE LP \xB7 CV ${performance2.waferSystemResidenceTime.coefficientOfVariation.toFixed(2)} \xB7 \u6700\u5927 ${formatSeconds2(performance2.waferSystemResidenceTime.maxSeconds)} s \xB7 ${performance2.waferSystemResidenceTime.sampleCount} \u7247</small>
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
  replayPlan = null;
  liveDecision = null;
  liveDecisionKey = "";
  decisionBoundaries = [];
  pauseOnDecisionChange = false;
  pauseTriggeredByDecisionChange = false;
  replayDecisionCache = /* @__PURE__ */ new Map();
  pendingReplayDecisionKeys = /* @__PURE__ */ new Set();
  replayDecisionRequestVersion = 0;
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
  /** 画布下方模块筛选：勾选的模块类别（aligner/cooler）不在拓扑中显示。 */
  hiddenModuleFilters = /* @__PURE__ */ new Set();
  /** 绑定页面事件并初始化空状态。 */
  constructor(root) {
    this.root = root;
    this.elements = collectElements(root);
    this.syncModuleFiltersFromUi();
    this.bindEvents();
    this.updatePlayButton();
    this.updatePauseOnDecisionChangeButton();
    this.setTopologyVisible(false);
  }
  /** 以画布下方筛选框的勾选状态初始化模块筛选集合。 */
  syncModuleFiltersFromUi() {
    if (this.elements.alignerFilter.checked) this.hiddenModuleFilters.add("aligner");
    if (this.elements.coolerFilter.checked) this.hiddenModuleFilters.add("cooler");
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
  /** 保存 Machine 回放所需的完整计划；任意来源 MoveList 都使用该计划实时评分。 */
  setReplayPlan(plan) {
    this.replayPlan = plan ? structuredClone(plan) : null;
    this.replayDecisionCache.clear();
    this.pendingReplayDecisionKeys.clear();
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.decisionBoundaries = decisionBoundaryTimes(this.moves);
    this.replayDecisionRequestVersion += 1;
    if (this.moves.length) this.render();
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
    this.liveDecision = null;
    this.liveDecisionKey = "";
    this.decisionBoundaries = [];
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
    this.decisionBoundaries = decisionBoundaryTimes(moves);
    this.decisionTrace = decisionTrace;
    this.liveDecision = null;
    this.liveDecisionKey = "";
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
    const nextDecisionBoundary = this.pauseOnDecisionChange ? this.decisionBoundaries.find((boundary) => boundary > previousTime + PERFORMANCE_DISPLAY_TOLERANCE && boundary <= advancedTime + PERFORMANCE_DISPLAY_TOLERANCE) : void 0;
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
    const state2 = this.pauseTriggeredByDecisionChange ? "\u5DF2\u6682\u505C" : this.pauseOnDecisionChange ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED";
    this.elements.pauseOnDecisionChangeButton.innerHTML = `
      <span class="decision-switch-copy"><span>\u4E0B\u4E00\u51B3\u7B56\u65F6\u6682\u505C</span><strong>${state2}</strong></span>
      <span class="decision-switch-track" aria-hidden="true"><i></i></span>`;
    this.elements.pauseOnDecisionChangeButton.setAttribute("aria-pressed", String(this.pauseOnDecisionChange));
    this.elements.pauseOnDecisionChangeButton.setAttribute("aria-checked", String(this.pauseOnDecisionChange));
    this.elements.pauseOnDecisionChangeButton.setAttribute(
      "aria-label",
      this.pauseTriggeredByDecisionChange ? "\u5DF2\u5230\u8FBE\u4E0B\u4E00\u4E2A\u5B8C\u6574\u51B3\u7B56\uFF0C\u56DE\u653E\u5DF2\u6682\u505C" : `\u5230\u4E0B\u4E00\u4E2A\u5B8C\u6574\u51B3\u7B56\u65F6\u81EA\u52A8\u6682\u505C\uFF1A${this.pauseOnDecisionChange ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED"}`
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
  /** 切换画布模块筛选；有 MoveList 时立即按新筛选重绘拓扑。 */
  setModuleFilter(key, hidden) {
    if (hidden) this.hiddenModuleFilters.add(key);
    else this.hiddenModuleFilters.delete(key);
    if (this.moves.length) this.render();
  }
  /** 绘制当前时间对应的设备快照。 */
  render(prebuiltSnapshot) {
    if (!this.moves.length) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(this.moves, this.device, this.time);
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.source.title = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds2(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds2(snapshot.endTime);
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
    const currentDecision = cachedDecision ?? (this.liveDecisionKey === replayKey ? this.liveDecision : null) ?? decisionAtTime(this.decisionTrace, snapshot.time);
    if (this.replayPlan && !cachedDecision && this.liveDecisionKey !== replayKey && !this.pendingReplayDecisionKeys.has(replayKey)) {
      void this.refreshReplayDecision(replayKey, replayTime);
    }
    const topologySnapshot = snapshotWithFullDeviceModules(
      snapshotWithCandidateModules(snapshot, currentDecision, this.device),
      this.device
    );
    this.elements.stage.innerHTML = renderEquipmentTopology(topologySnapshot, currentDecision, this.hiddenModuleFilters);
    this.elements.decisionLens.innerHTML = renderDecisionLens(currentDecision);
    this.elements.activeMoves.innerHTML = snapshot.activeMoves.length ? snapshot.activeMoves.map((move) => `
        <li>
          <span class="active-move-id">#${finiteNumber(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber(move.MoveType, -1)] ?? `\u52A8\u4F5C ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move) || "\u2014")}</span>
          <time>${formatSeconds2(finiteNumber(move.StartTime))}\u2013${formatSeconds2(finiteNumber(move.EndTime))} s</time>
        </li>`).join("") : '<li class="active-move-empty">\u5F53\u524D\u65F6\u523B\u6CA1\u6709\u6267\u884C\u4E2D\u7684\u52A8\u4F5C</li>';
  }
  /** 返回不晚于当前时刻的最近完整事务边界，事务执行期间沿用上一决策。 */
  replayDecisionTime(time) {
    let decisionTime = 0;
    for (const boundary of this.decisionBoundaries) {
      if (boundary > time + PERFORMANCE_DISPLAY_TOLERANCE) break;
      decisionTime = boundary;
    }
    return decisionTime;
  }
  /** 每个完整事务边界只执行一次 E2E 前向。 */
  replayStateKey(replayTime) {
    return replayTime.toFixed(6);
  }
  /** 异步请求当前 Machine 候选；过期响应不会覆盖用户已经拖到的新时刻。 */
  async refreshReplayDecision(replayKey, replayTime) {
    const requestVersion = ++this.replayDecisionRequestVersion;
    this.pendingReplayDecisionKeys.add(replayKey);
    try {
      const rawDecision = await requestReplayDecision({
        resultId: this.analysisResultId || void 0,
        moves: this.analysisResultId ? void 0 : this.moves,
        plan: this.replayPlan,
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
    } catch (_error) {
    } finally {
      this.pendingReplayDecisionKeys.delete(replayKey);
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

// src/group_analysis_view.ts
function escapeHtml2(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function finiteText(value, digits, suffix = "") {
  return value === null || !Number.isFinite(value) ? "\u2014" : `${value.toFixed(digits)}${suffix}`;
}
function percentText(value, fromRatio = false) {
  const normalized = value === null ? null : value * (fromRatio ? 100 : 1);
  return finiteText(normalized, 2, "%");
}
function durationText(value) {
  if (value === null || !Number.isFinite(value)) return "\u2014";
  return value >= 1e3 ? `${(value / 1e3).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}
function caseLabel(item, index) {
  return item.name || `t${index + 1}`;
}
function improvementChart(summary) {
  const cases = summary.cases.filter((item) => item.improvementPercent !== null);
  const scale = Math.max(
    1,
    ...cases.map((item) => Math.abs(item.improvementPercent ?? 0))
  );
  return cases.map((item, index) => {
    const value = item.improvementPercent ?? 0;
    const width = Math.min(Math.abs(value) / scale * 50, 50);
    const status = value < 0 ? "loss" : value > 0 ? "gain" : "tie";
    return `<div class="group-chart-row">
      <span class="group-chart-label" title="${escapeHtml2(item.name)}">${escapeHtml2(caseLabel(item, index))}</span>
      <div class="group-diverging-track" role="img" aria-label="${escapeHtml2(caseLabel(item, index))} \u76F8\u5BF9\u57FA\u7EBF ${value >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(value).toFixed(2)}%">
        <i class="${status}" style="--bar-width:${width}%"></i>
      </div>
      <strong class="${status}">${value > 0 ? "+" : ""}${value.toFixed(2)}%</strong>
    </div>`;
  }).join("") || '<p class="group-analysis-empty">\u6CA1\u6709\u53EF\u6BD4\u8F83\u7684 Baseline\u3002</p>';
}
function utilizationChart(summary) {
  const rows = summary.cases.flatMap((item, caseIndex) => item.bottleneckCandidates.map((candidate, candidateIndex) => ({
    item,
    caseIndex,
    candidate,
    candidateIndex
  })));
  return rows.map(({ item, caseIndex, candidate, candidateIndex }) => {
    const utilization = Math.max(0, Math.min(candidate.utilization, 1));
    const label = candidateIndex === 0 ? caseLabel(item, caseIndex) : `\u21B3 \u5019\u9009 ${candidateIndex + 1}`;
    return `<div class="group-chart-row ${candidateIndex ? "is-secondary-candidate" : ""}">
      <span class="group-chart-label" title="${escapeHtml2(item.name)}">${escapeHtml2(label)}</span>
      <div class="group-linear-track" role="img" aria-label="${escapeHtml2(caseLabel(item, caseIndex))} \u74F6\u9888\u5019\u9009 ${escapeHtml2(candidate.resourceName)}\uFF0C\u5229\u7528\u7387 ${(utilization * 100).toFixed(1)}%">
        <i class="utilization" style="width:${(utilization * 100).toFixed(2)}%"></i>
      </div>
      <strong>${(utilization * 100).toFixed(1)}%</strong>
      <small title="${escapeHtml2(candidate.resourceName)}">${escapeHtml2(candidate.resourceName || "\u2014")}</small>
    </div>`;
  }).join("") || '<p class="group-analysis-empty">\u6CA1\u6709\u53EF\u5206\u6790\u7684\u74F6\u9888\u8D44\u6E90\u3002</p>';
}
function cpuChart(summary) {
  const cases = summary.cases.filter((item) => item.cpuTimeMs !== null);
  const scale = Math.max(1, ...cases.map((item) => item.cpuTimeMs ?? 0));
  return cases.map((item, index) => {
    const cpu = Math.max(item.cpuTimeMs ?? 0, 0);
    return `<div class="group-chart-row">
      <span class="group-chart-label" title="${escapeHtml2(item.name)}">${escapeHtml2(caseLabel(item, index))}</span>
      <div class="group-linear-track" role="img" aria-label="${escapeHtml2(caseLabel(item, index))} CPU Time ${durationText(cpu)}">
        <i class="cpu" style="width:${Math.min(cpu / scale * 100, 100).toFixed(2)}%"></i>
      </div>
      <strong>${escapeHtml2(durationText(cpu))}</strong>
    </div>`;
  }).join("") || '<p class="group-analysis-empty">\u6CA1\u6709 CPU Time \u6570\u636E\u3002</p>';
}
function resultTable(summary) {
  return summary.cases.map((item, index) => `
    <tr>
      <th scope="row">${escapeHtml2(caseLabel(item, index))}</th>
      <td>${finiteText(item.makespan, 2, " s")}</td>
      <td>${finiteText(item.baselineMakespan, 2, " s")}</td>
      <td class="${(item.improvementPercent ?? 0) < 0 ? "loss" : "gain"}">${item.improvementPercent === null ? "\u2014" : `${item.improvementPercent > 0 ? "+" : ""}${item.improvementPercent.toFixed(2)}%`}</td>
      <td>${escapeHtml2(item.bottleneckResource || "\u2014")}${item.bottleneckCandidateCount > 1 ? ` <small>+${item.bottleneckCandidateCount - 1} \u4E2A\u5019\u9009</small>` : ""}</td>
      <td>${percentText(item.bottleneckUtilization, true)}</td>
      <td>${durationText(item.cpuTimeMs)}</td>
      <td>${finiteText(item.throughputPerHour, 1, " \u7247/h")}</td>
      <td>${finiteText(item.departureIntervalCv, 2)}</td>
      <td>${finiteText(item.processChamberDwellMeanSeconds, 2, " s")}</td>
      <td>${finiteText(item.robotWaferDwellMeanSeconds, 2, " s")}</td>
      <td>${finiteText(item.waferSystemResidenceMeanSeconds, 2, " s")}</td>
      <td>${finiteText(item.waferSystemResidenceCv, 2)}</td>
      <td>${item.validationPassed ? '<span class="group-pass">\u901A\u8FC7</span>' : `<span class="group-fail">${escapeHtml2(item.validation || item.status)}</span>`}</td>
    </tr>`).join("");
}
function renderTestGroupAnalysis(summary, groupName) {
  const weighted = summary.weightedImprovementPercent;
  const medianImprovement = summary.medianImprovementPercent;
  return `
    <div class="group-analysis-head">
      <h2>${escapeHtml2(groupName || "\u5F53\u524D\u6D4B\u8BD5\u7EC4")}</h2>
    </div>
    <div class="group-kpi-grid">
      <article><span>\u6821\u9A8C\u901A\u8FC7\u7387</span><strong>${(summary.validationPassRate * 100).toFixed(1)}%</strong><small>${summary.validationPassedCount}/${summary.metricsCount} \u4E2A\u6709\u6307\u6807\u7ED3\u679C</small></article>
      <article><span>\u52A0\u6743\u603B\u4F53\u6539\u5584</span><strong class="${(weighted ?? 0) < 0 ? "loss" : "gain"}">${weighted === null ? "\u2014" : `${weighted > 0 ? "+" : ""}${weighted.toFixed(2)}%`}</strong><small>\u6309\u5404\u6D4B\u8BD5 Baseline makespan \u52A0\u6743</small></article>
      <article><span>\u9010\u4F8B\u4E2D\u4F4D\u6539\u5584</span><strong class="${(medianImprovement ?? 0) < 0 ? "loss" : "gain"}">${medianImprovement === null ? "\u2014" : `${medianImprovement > 0 ? "+" : ""}${medianImprovement.toFixed(2)}%`}</strong><small>${summary.winCount} \u80DC \xB7 ${summary.tieCount} \u5E73 \xB7 ${summary.regressionCount} \u9000\u5316</small></article>
      <article><span>CPU Time</span><strong>${durationText(summary.medianCpuTimeMs)}</strong><small>P90 ${durationText(summary.p90CpuTimeMs)} \xB7 \u603B\u8BA1 ${durationText(summary.totalCpuTimeMs)}</small></article>
      <article><span>\u4E3B\u8981\u5019\u9009\u5229\u7528\u7387\u4E2D\u4F4D\u6570</span><strong>${percentText(summary.medianBottleneckUtilization, true)}</strong><small>\u5DE5\u5E8F\u7EC4\u3001\u673A\u5668\u4EBA\u6216 LoadLock \u5BB9\u91CF</small></article>
      <article><span>\u51FA\u7AD9\u8868\u73B0\u4E2D\u4F4D\u6570</span><strong>${finiteText(summary.medianThroughputPerHour, 1, " \u7247/h")}</strong><small>\u95F4\u9694\u6CE2\u52A8 CV ${finiteText(summary.medianDepartureIntervalCv, 2)}</small></article>
      <article><span>\u52A0\u5DE5\u8154\u9A7B\u7559\u5747\u503C\u4E2D\u4F4D\u6570</span><strong>${finiteText(summary.medianProcessChamberDwellMeanSeconds, 2, " s")}</strong><small>\u5404\u6D4B\u8BD5\u201C\u52A0\u5DE5\u7ED3\u675F \u2192 \u5B8C\u5168\u79BB\u8154\u201D\u5747\u503C\u7684\u4E2D\u4F4D\u6570</small></article>
      <article><span>\u673A\u5668\u624B\u9A7B\u7559\u5747\u503C\u4E2D\u4F4D\u6570</span><strong>${finiteText(summary.medianRobotWaferDwellMeanSeconds, 2, " s")}</strong><small>\u5DF2\u5254\u9664\u663E\u5F0F PreTrans \u8FD0\u8F93\u533A\u95F4</small></article>
      <article><span>\u7CFB\u7EDF\u505C\u7559\u5747\u503C\u4E2D\u4F4D\u6570</span><strong>${finiteText(summary.medianWaferSystemResidenceMeanSeconds, 2, " s")}</strong><small>\u79BB\u5F00 LP \u2192 \u8FD4\u56DE LP \xB7 CV \u4E2D\u4F4D ${finiteText(summary.medianWaferSystemResidenceCv, 2)}</small></article>
    </div>
    <div class="group-chart-grid">
      <article class="group-chart-card">
        <header><div><h3>\u76F8\u5BF9 Baseline</h3><p>\u6B63\u503C\u4E3A makespan \u6539\u5584\uFF0C\u8D1F\u503C\u4E3A\u9000\u5316</p></div></header>
        <div class="group-chart-body">${improvementChart(summary)}</div>
      </article>
      <article class="group-chart-card">
        <header><div><h3>\u6240\u6709\u74F6\u9888\u5019\u9009\u5229\u7528\u7387</h3><p>\u6BCF\u4E2A\u6D4B\u8BD5\u6309\u53EF\u80FD\u6027\u4F9D\u6B21\u663E\u793A\u6240\u6709\u63A5\u8FD1\u5019\u9009</p></div></header>
        <div class="group-chart-body">${utilizationChart(summary)}</div>
      </article>
      <article class="group-chart-card">
        <header><div><h3>\u8BA1\u7B97\u65F6\u95F4</h3><p>\u5404\u6D4B\u8BD5\u7B97\u6CD5 CPU Time\uFF0C\u6309\u7EC4\u5185\u6700\u5927\u503C\u7F29\u653E</p></div></header>
        <div class="group-chart-body">${cpuChart(summary)}</div>
      </article>
    </div>
    <details class="group-analysis-table-wrap">
      <summary>\u67E5\u770B\u9010\u6D4B\u8BD5\u5B8C\u6574\u6307\u6807</summary>
      <div class="group-analysis-table-scroll">
        <table class="group-analysis-table">
          <thead><tr><th>\u6D4B\u8BD5</th><th>Makespan</th><th>Baseline</th><th>\u6539\u5584</th><th>\u74F6\u9888</th><th>\u5229\u7528\u7387</th><th>CPU Time</th><th>\u541E\u5410</th><th>\u51FA\u7AD9 CV</th><th>\u52A0\u5DE5\u8154\u9A7B\u7559\u5747\u503C</th><th>\u673A\u5668\u624B\u9A7B\u7559\u5747\u503C</th><th>\u7CFB\u7EDF\u505C\u7559\u5747\u503C</th><th>\u7CFB\u7EDF\u505C\u7559 CV</th><th>\u6821\u9A8C</th></tr></thead>
          <tbody>${resultTable(summary)}</tbody>
        </table>
      </div>
    </details>`;
}

// src/editor_models.ts
var CJOB_TYPES = ["NormalLot", "HighestLot", "HigherLot"];
var TASK_MODES = ["Smart", "Pipeline", "Sequential", "Concurrent"];
function stringList(value) {
  const values = Array.isArray(value) ? value : String(value || "").replaceAll("\uFF0C", ",").split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}
function makeVisit(stationName = "", processRecipe = "") {
  return {
    stationName,
    slotIds: "1",
    processRecipe,
    processTime: 20,
    recipeTime: 20,
    processType: "",
    weight: "{}",
    moveTimeOffset: "{}",
    qTimeLimit: -1,
    residencyConstraint: -1,
    beforeCleanRefs: [],
    afterCleanRefs: []
  };
}
function makeStage(stations = "", needProcess = false, recipeName = "") {
  const names = stringList(stations);
  const visits = (names.length ? names : [""]).map(
    (name) => makeVisit(name, needProcess ? recipeName : "")
  );
  return { stepId: 0, postStepIds: [], needProcess, visits };
}
function linkRouteSteps(stages) {
  stages.forEach((stage, index) => {
    stage.stepId = index;
    stage.postStepIds = index + 1 < stages.length ? [index + 1] : [];
  });
  return stages;
}
function normalizeVisit(visit, recipeName = "") {
  visit.processTime = Number(visit.processTime ?? visit.recipeTime ?? 20);
  visit.recipeTime = Number(visit.recipeTime ?? visit.processTime);
  visit.processRecipe = String(visit.processRecipe ?? "").trim() || String(recipeName).trim();
  visit.processType ??= "";
  visit.slotIds ??= "1";
  visit.weight ??= "{}";
  visit.moveTimeOffset ??= "{}";
  visit.qTimeLimit = Number(visit.qTimeLimit ?? -1);
  visit.residencyConstraint = Number(visit.residencyConstraint ?? -1);
  visit.beforeCleanRefs = Array.isArray(visit.beforeCleanRefs) ? visit.beforeCleanRefs : [];
  visit.afterCleanRefs = Array.isArray(visit.afterCleanRefs) ? visit.afterCleanRefs : [];
  return visit;
}
function makePJob(index = 1, routeRef = "", loadPort = "", waferCount = 5) {
  return {
    jobName: `P${index}`,
    taskId: "",
    waferCount,
    matList: Array.from({ length: waferCount }, (_, item) => item + 1),
    routeRef,
    loadPort,
    priority: 1
  };
}
function makeCJob(roundIndex, pjobs = [], routeRef = "", loadPort = "") {
  const rows = pjobs.length ? pjobs : [makePJob(1, routeRef, loadPort, 5)];
  return {
    key: "C1",
    taskId: String(roundIndex),
    jobType: "NormalLot",
    priority: 1,
    taskMode: "Smart",
    pJobNameList: rows.map((item) => item.jobName),
    pjobs: rows
  };
}
function makeRound(roundIndex, currentTime, routeRef = "", loadPort = "") {
  return {
    currentTime: roundIndex === 1 ? 0 : currentTime,
    cjobs: [makeCJob(roundIndex, [], routeRef, loadPort)]
  };
}
function automaticLoadPort(loadPorts, taskOrdinal) {
  if (!loadPorts.length) return "";
  return loadPorts[Math.max(0, taskOrdinal - 1) % loadPorts.length];
}
function enumName(value, names, fallback) {
  if (names.includes(String(value))) return String(value);
  const numeric = Number(value);
  if (names === CJOB_TYPES) {
    return { 0: "NormalLot", 2: "HighestLot", 3: "HigherLot" }[numeric] || fallback;
  }
  return { 0: "Smart", 1: "Pipeline", 2: "Sequential", 3: "Concurrent" }[numeric] || fallback;
}
function normalizePJob(raw, index, taskId, assignedLoadPort = "") {
  const source = raw || {};
  const originRoute = source.originRoute ?? source.OriginRoute;
  const routeRef = typeof originRoute === "object" ? originRoute?.name || originRoute?.Name || "" : originRoute;
  const waferCount = Math.max(
    1,
    Math.min(25, Number(source.waferCount ?? source.matList?.length ?? source.MatList?.length ?? 1) || 1)
  );
  return {
    jobName: `P${index}`,
    taskId: String(taskId),
    waferCount,
    matList: Array.from({ length: waferCount }, (_, item) => item + 1),
    routeRef: source.routeRef || routeRef || "",
    loadPort: assignedLoadPort || source.loadPort || source.LoadPort || "",
    priority: Math.max(1, Number(source.priority ?? source.Priority) || 1)
  };
}
function normalizeRound(raw, roundIndex, fallbackTime, firstTaskId = roundIndex, loadPorts = []) {
  const source = raw || {};
  let cjobs = Array.isArray(source.cjobs) ? source.cjobs : null;
  if (!cjobs) {
    const legacyJobs = Array.isArray(source.jobs) ? source.jobs : [];
    const first = legacyJobs[0] || {};
    cjobs = [{
      jobType: first.jobType,
      priority: first.priority,
      taskMode: first.taskMode,
      pjobs: legacyJobs.length ? legacyJobs : [{}]
    }];
  }
  if (!cjobs.length) cjobs = [{ pjobs: [{}] }];
  const normalizedCJobs = cjobs.map((cjob, cjobIndex) => {
    const taskId = String(firstTaskId + cjobIndex);
    const taskMode = enumName(cjob.taskMode, TASK_MODES, "Smart");
    const rawPJobs = Array.isArray(cjob.pjobs) && cjob.pjobs.length ? cjob.pjobs : [{}];
    const legacyLoadPort = cjob.loadPort || rawPJobs[0]?.loadPort || rawPJobs[0]?.LoadPort || "";
    const loadPort = automaticLoadPort(loadPorts, firstTaskId + cjobIndex) || legacyLoadPort;
    const pjobs = rawPJobs.map(
      (pjob, pjobIndex) => normalizePJob(
        pjob,
        pjobIndex + 1,
        taskId,
        loadPort
      )
    );
    const jobType = enumName(cjob.jobType, CJOB_TYPES, "NormalLot");
    return {
      key: cjob.key || `C${cjobIndex + 1}`,
      taskId,
      loadPort,
      jobType,
      priority: jobType === "NormalLot" ? Math.max(1, Number(cjob.priority) || 1) : -1,
      taskMode,
      pJobNameList: pjobs.map((pjob) => pjob.jobName),
      pjobs
    };
  });
  return {
    currentTime: roundIndex === 1 ? 0 : Number(source.currentTime ?? fallbackTime ?? 0),
    cjobs: normalizedCJobs
  };
}

// src/config_editor.ts
var { VISIT_SHARED_FIELDS: VISIT_SHARED_FIELDS2, selectReferencedRoutes: selectReferencedRoutes2 } = route_editor_logic_exports;
var visualizationWorkspace = createVisualizationWorkspace();
var batchPerformanceAnalyses = /* @__PURE__ */ new Map();
var batchBottleneckSummaries = /* @__PURE__ */ new Map();
var batchBottleneckRequests = /* @__PURE__ */ new Map();
var batchBottleneckErrors = /* @__PURE__ */ new Map();
var EXPECTED_API_SCHEMA = "cjob-pjob-v3";
var CLEAN_TYPE_DEFINITIONS = [
  { key: "preclean", label: "PreClean" },
  { key: "postclean", label: "PostClean" },
  { key: "wacclean", label: "WAC Clean" },
  { key: "dummy", label: "Dummy" },
  { key: "dummywac", label: "Dummy WAC" }
];
var ROUTE_CLEAN_KEYS = ["prePJobCleanRefs", "postPJobCleanRefs", "postCJobCleanRefs"];
var PROCESSING_STATION_TYPES = /* @__PURE__ */ new Set([
  "processchamber",
  "multiprocesschamber",
  "heater",
  "cooler"
]);
var FIRST_ROBOT_SLOT_ID = 1;
var DUAL_ARM_SLOT_COUNT = 2;
var state = {
  workspaceDevices: [],
  workspaceDevice: null,
  workspaceDeviceId: "",
  testCaseId: "",
  testCaseName: "",
  testCaseGroup: "",
  activeTestGroup: "",
  serviceCompatible: false,
  dirty: false,
  activeBatchId: "",
  batchRunning: false,
  batchCancelRequested: false,
  batchCancelSent: false,
  batchResult: null,
  selectedBatchTestId: "",
  parameterComparison: null,
  deviceName: "",
  baseDevice: null,
  device: null,
  stationNames: [],
  loadPorts: [],
  processModules: [],
  robotNames: [],
  robotScopes: {},
  robotSlots: {},
  robotSlotsSaving: /* @__PURE__ */ new Set(),
  strategy: "heuristic",
  availableOtherAlgorithms: [],
  algorithmMetadata: {},
  roundCount: 2,
  times: [0, 70],
  options: { loadLockManager: "petri-look", residencyGuardSeconds: 0, maximumRobotHoldingSeconds: 0, maximumSystemResidenceCv: 0, loadLockMacroSearchSeconds: 4, loadLockMacroRollouts: 96, nnSAEASearchSeconds: 4, nnSAEARollouts: 64, neuralUCBTopK: 2, neuralUCBExploration: 5, rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 },
  cleans: [],
  routes: [{ name: "RouteA", group: "RouteA", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps([makeStage("LP1"), makeStage("Robot"), makeStage("PM1,PM2", true, "RouteA_Step2"), makeStage("Robot"), makeStage("LP1")]) }],
  rounds: [makeRound(1, 0, "RouteA", "LP1"), makeRound(2, 70, "RouteA", "LP2")],
  drawer: null,
  cleanDialogContext: null,
  expandedRouteProcessGroups: /* @__PURE__ */ new Set(),
  expandedRouteGroups: /* @__PURE__ */ new Set(),
  expandedRoutes: /* @__PURE__ */ new Set(),
  routeNameChanges: /* @__PURE__ */ new Map()
};
function inferCleanType(clean) {
  const explicit = String(clean.cleanType || clean.category || "").toLowerCase().replace(/[-_\s]/g, "");
  if (["preclean", "postclean", "wacclean", "dummy", "dummywac"].includes(explicit)) return explicit;
  if (explicit === "dummyclean") return "dummy";
  if (explicit === "dummywacclean") return "dummywac";
  const signature = `${clean.taskName || ""} ${clean.name || ""}`.toLowerCase();
  if (/dummy.*wac|wac.*dummy|prewac/.test(signature) || clean.emptyRecipeRef) return "dummywac";
  if (Number(clean.materialCount || 0) > 0 || /dummy/.test(signature)) return "dummy";
  if (String(clean.stateVariable || "").toLowerCase() === "processcount" || /wac/.test(signature)) return "wacclean";
  if (/post/.test(signature)) return "postclean";
  return "preclean";
}
function normalizeClean(clean) {
  const value = { ...clean || {} }, cleanType = inferCleanType(value);
  const name = String(value.name || `Clean${state.cleans.length + 1}`).trim() || `Clean${state.cleans.length + 1}`;
  value.name = name;
  value.cleanType = cleanType;
  value.recipeName = String(value.recipeName || value.recipeRef || `${name}-Recipe`).trim() || `${name}-Recipe`;
  const recipeTime = Number(value.recipeTime);
  value.recipeTime = Math.max(0, Number.isFinite(recipeTime) ? recipeTime : 0);
  value.triggerCount = Math.max(1, Math.floor(Number(value.triggerCount ?? value.lower) || 5));
  const wacRecipeTime = Number(value.wacRecipeTime ?? value.emptyRecipeTime);
  value.wacRecipeTime = Math.max(0, Number.isFinite(wacRecipeTime) ? wacRecipeTime : 20);
  value.modules = [...new Set(stringList(value.modules))];
  return value;
}
function formatCleanSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "\u672A\u8BBE\u7F6E";
  const text = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text}s`;
}
function automaticCleanName(clean) {
  const value = normalizeClean(clean);
  const labels = Object.fromEntries(CLEAN_TYPE_DEFINITIONS.map((item) => [item.key, item.label]));
  const mainDuration = formatCleanSeconds(value.recipeTime);
  if (value.cleanType === "dummywac") {
    return `${labels[value.cleanType]} \xB7 \u4E3B\u6E05\u6D01 ${mainDuration} \xB7 WAC ${formatCleanSeconds(value.wacRecipeTime)}`;
  }
  return `${labels[value.cleanType]} \xB7 ${mainDuration}`;
}
function renameCleanReferences(oldName, newName) {
  if (!oldName || oldName === newName) return;
  const rename = (value) => stringList(value).map((name) => name === oldName ? newName : name);
  state.routes.forEach((route) => {
    ROUTE_CLEAN_KEYS.forEach((key) => {
      route[key] = rename(route[key]);
    });
    (route.stages || []).forEach((stage) => (stage.visits || []).forEach((visit) => {
      visit.beforeCleanRefs = rename(visit.beforeCleanRefs);
      visit.afterCleanRefs = rename(visit.afterCleanRefs);
    }));
  });
}
function synchronizeCleanNames() {
  const occurrences = /* @__PURE__ */ new Map();
  let changed = false;
  state.cleans = state.cleans.map(normalizeClean);
  state.cleans.forEach((clean) => {
    const baseName = automaticCleanName(clean);
    const occurrence = (occurrences.get(baseName) || 0) + 1;
    occurrences.set(baseName, occurrence);
    const generatedName = occurrence === 1 ? baseName : `${baseName} \xB7 #${occurrence}`;
    const oldName = clean.name;
    if (oldName !== generatedName) {
      renameCleanReferences(oldName, generatedName);
      clean.name = generatedName;
      changed = true;
    }
    const recipeName = `${generatedName}-Recipe`;
    if (clean.recipeName !== recipeName) {
      clean.recipeName = recipeName;
      changed = true;
    }
  });
  return changed;
}
function runtimeClean(clean) {
  const value = normalizeClean(clean), type = value.cleanType;
  const taskNames = { preclean: "PreClean", postclean: "PostClean", wacclean: "WacClean", dummy: "PreDummyClean", dummywac: "PreWacClean" };
  const isWac = type === "wacclean", isDummy = type === "dummy" || type === "dummywac";
  return {
    ...value,
    recipeRef: value.recipeName,
    modules: value.modules,
    taskName: taskNames[type],
    stateVariable: isWac ? "ProcessCount" : "IdleTime",
    lower: isWac ? value.triggerCount : 0,
    upper: 9999,
    updateStateVariables: isWac ? ["ProcessCount"] : isDummy ? ["IdleTime", "DummyCount"] : type === "preclean" ? ["IdleTime"] : [],
    materialCount: isDummy ? 2 : 0,
    preJudge: false,
    emptyRecipeRef: type === "dummywac" ? `${value.recipeName}-WAC` : ""
  };
}
function makeClean(cleanType = "preclean") {
  return normalizeClean({ name: "", cleanType, recipeTime: 20, triggerCount: 5, wacRecipeTime: 20, modules: [] });
}
function stageUsesRobot(stage, index) {
  const names = (stage.visits || []).map((visit) => visit.stationName).filter(Boolean);
  return stage.kind === "robot" || (names.length ? names.every((name) => state.robotNames.includes(name)) : index % 2 === 1);
}
function normalizeRoute(route) {
  route.stages = Array.isArray(route.stages) ? route.stages : [];
  ROUTE_CLEAN_KEYS.forEach((key) => {
    route[key] = stringList(route[key]);
  });
  route.postCJobCleanRefs = [];
  route.bufferOption = Math.max(0, Math.min(4, Math.trunc(Number(route.bufferOption) || 0)));
  linkRouteSteps(route.stages);
  route.stages.forEach((stage, index) => {
    stage.visits = Array.isArray(stage.visits) ? stage.visits : [];
    stage.kind = stageUsesRobot(stage, index) ? "robot" : "station";
    stage.needProcess = stage.kind === "station" && stage.visits.some((visit) => state.processModules.includes(visit.stationName));
    const recipeName = stage.needProcess ? `${route.group || route.name || "Route"}_Step${stage.stepId}` : "";
    stage.visits.forEach((visit) => {
      normalizeVisit(visit, recipeName);
      if (stage.needProcess) visit.recipeTime = Number(visit.processTime);
    });
  });
  return route;
}
function visitDifferenceFields(stage) {
  return differenceFields(stage, normalizeVisit);
}
function synchronizeStageVisits(stage) {
  if (!(stage.visits || []).length) return;
  const first = normalizeVisit(stage.visits[0]);
  const editableValues = {
    processTime: Number(first.processTime),
    recipeTime: Number(first.processTime),
    qTimeLimit: Number(first.qTimeLimit),
    residencyConstraint: Number(first.residencyConstraint),
    beforeCleanRefs: structuredClone(stringList(first.beforeCleanRefs)),
    afterCleanRefs: structuredClone(stringList(first.afterCleanRefs))
  };
  stage.visits.forEach((visit) => Object.assign(visit, structuredClone(editableValues)));
}
function setStageCandidates(routeIndex, stageIndex, names) {
  const route = state.routes[routeIndex], stage = route.stages[stageIndex];
  replaceCandidates(stage, names, makeVisit, normalizeVisit);
  normalizeRoute(route);
}
function normalizeRounds() {
  let nextTaskId = 1;
  state.rounds = state.rounds.map((round, index) => {
    const normalized = normalizeRound(
      round,
      index + 1,
      state.times[index],
      nextTaskId,
      state.loadPorts
    );
    nextTaskId += normalized.cjobs.length;
    return normalized;
  });
  let nextMaterialId = 1;
  state.rounds.forEach((round) => round.cjobs.forEach((cjob) => cjob.pjobs.forEach((pjob) => {
    pjob.matList = Array.from({ length: pjob.waferCount }, () => nextMaterialId++);
  })));
  state.times = state.rounds.map((round) => Number(round.currentTime));
}
function escapeHtml3(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}
function readonlyText(value) {
  if (value === void 0 || value === null || value === "") return "\u2014";
  return typeof value === "string" ? value : JSON.stringify(value);
}
function renderReadonlyField(label, value, wide = false) {
  return `<div class="readonly-field ${wide ? "wide" : ""}"><span>${escapeHtml3(label)}</span><strong>${escapeHtml3(readonlyText(value))}</strong></div>`;
}
function unwrapDevice(raw) {
  let value = raw;
  if (Array.isArray(value)) {
    const entry = value.find((item) => item && String(item.Describe || "").toLowerCase() === "alginit");
    if (!entry) throw new Error("\u8BBE\u5907\u6587\u4EF6\u4E2D\u627E\u4E0D\u5230 Describe=AlgInit");
    value = entry.Info;
  }
  if (value?.InitData) value = value.InitData;
  if (value?.Info?.Stations) value = value.Info;
  if (!value || typeof value !== "object" || !value.Stations || !value.Robots) throw new Error("\u8BBE\u5907\u6587\u4EF6\u5FC5\u987B\u5305\u542B Stations \u548C Robots");
  return value;
}
async function loadDevice(file) {
  if (!file) return;
  if (state.dirty) await saveCurrentTest(true);
  const device = unwrapDevice(JSON.parse(await file.text()));
  const result = await requestJson("/api/workspaces/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, device })
  });
  await loadWorkspaceCatalog(result.device.id);
  writeTerminal(`$ ${result.created ? "\u5DF2\u5BFC\u5165" : "\u5DF2\u9009\u62E9\u5DF2\u6709"}\u8BBE\u5907 ${result.device.name}
  \u8BE5\u8BBE\u5907\u4E0B\u6709 ${state.workspaceDevice?.tests?.length || 0} \u4E2A\u6D4B\u8BD5\u96C6`);
  document.getElementById("deviceFile").value = "";
}
function robotAvailableSlots(robot) {
  const slots = /* @__PURE__ */ new Set();
  const addSlots = (rawSlots, scalarIsCapacity = false) => {
    let values = [];
    if (Number.isInteger(rawSlots) && typeof rawSlots !== "boolean") {
      values = scalarIsCapacity ? Array.from({ length: Math.max(0, rawSlots) }, (_, index) => index + FIRST_ROBOT_SLOT_ID) : [rawSlots];
    } else if (Array.isArray(rawSlots)) values = rawSlots;
    else if (rawSlots && typeof rawSlots === "object") values = Object.keys(rawSlots);
    values.forEach((value) => {
      const slotId = Number(value);
      if (Number.isInteger(slotId) && slotId >= FIRST_ROBOT_SLOT_ID) slots.add(slotId);
    });
  };
  Object.values(robot?.ArmInfo || {}).forEach((arm) => addSlots(arm?.SlotIDs));
  if (Object.values(robot?.ArmInfo || {}).some((arm) => arm && typeof arm === "object")) {
    for (let slotId = FIRST_ROBOT_SLOT_ID; slotId < FIRST_ROBOT_SLOT_ID + DUAL_ARM_SLOT_COUNT; slotId += 1) slots.add(slotId);
  }
  addSlots(robot?.Capacity, true);
  return [...slots.size ? slots : /* @__PURE__ */ new Set([FIRST_ROBOT_SLOT_ID])].sort((left, right) => left - right);
}
function robotDefaultSlots(robot) {
  const available = robotAvailableSlots(robot);
  const requested = Object.values(robot?.ArmInfo || {}).filter((arm) => arm && typeof arm === "object" && arm.IsEnable !== false).flatMap((arm) => Array.isArray(arm.SlotIDs) ? arm.SlotIDs.map(Number) : []);
  const selected = [...new Set(requested.filter((slotId) => Number.isInteger(slotId) && available.includes(slotId)))].sort((left, right) => left - right);
  return selected.length ? selected : available.slice(0, 1);
}
function normalizeRobotSlotSelections(device, rawSelections = {}) {
  const selections = rawSelections && typeof rawSelections === "object" ? rawSelections : {};
  return Object.fromEntries(Object.entries(device?.Robots || {}).map(([robotName, robot]) => {
    const available = robotAvailableSlots(robot);
    const requested = Array.isArray(selections[robotName]) ? selections[robotName].map(Number) : robotDefaultSlots(robot);
    const selected = [...new Set(requested.filter((slotId) => Number.isInteger(slotId) && available.includes(slotId)))].sort((left, right) => left - right);
    return [robotName, selected.length ? selected : available];
  }));
}
function generatedRobotArmName(existingNames, slotId) {
  const occupied = new Set(existingNames.map(String));
  const alphabeticName = `Arm${String.fromCharCode("A".charCodeAt(0) + slotId - FIRST_ROBOT_SLOT_ID)}`;
  if (!occupied.has(alphabeticName)) return alphabeticName;
  const numericName = `Arm${slotId}`;
  if (!occupied.has(numericName)) return numericName;
  let suffix = slotId;
  while (occupied.has(`${numericName}_${suffix}`)) suffix += 1;
  return `${numericName}_${suffix}`;
}
function projectRobotArmToSlot(armName, sourceArm, slotId) {
  const arm = structuredClone(sourceArm);
  arm.Name = armName;
  arm.IsEnable = true;
  arm.SlotIDs = [slotId];
  Object.entries(arm.SlotsStationMap || {}).forEach(([stationName, stationSlots]) => {
    if (!stationSlots || typeof stationSlots !== "object") return;
    const entries = Object.entries(stationSlots);
    if (!entries.length) return;
    const template = stationSlots[String(slotId)] ?? entries[0][1];
    arm.SlotsStationMap[stationName] = { [String(slotId)]: structuredClone(template) };
  });
  return arm;
}
function configuredDeviceForRobotSlots(baseDevice, rawSelections) {
  const device = structuredClone(baseDevice);
  const selections = normalizeRobotSlotSelections(device, rawSelections);
  Object.entries(device?.Robots || {}).forEach(([robotName, robot]) => {
    const selected = selections[robotName];
    robot.Capacity = selected.length;
    const sourceArms = Object.entries(robot.ArmInfo || {}).filter(([, arm]) => arm && typeof arm === "object");
    if (!sourceArms.length) return;
    const projectedArms = {};
    selected.forEach((slotId) => {
      const matched = sourceArms.find(([, arm]) => (arm.SlotIDs || []).map(Number).includes(slotId));
      const armName = matched?.[0] || generatedRobotArmName(
        [...Object.keys(robot.ArmInfo || {}), ...Object.keys(projectedArms)],
        slotId
      );
      projectedArms[armName] = projectRobotArmToSlot(armName, matched?.[1] || sourceArms[0][1], slotId);
    });
    robot.ArmInfo = projectedArms;
  });
  return { device, selections };
}
function applyDeviceTopology(device, deviceName, rawRobotSlots = {}) {
  state.baseDevice = structuredClone(device);
  const configured = configuredDeviceForRobotSlots(state.baseDevice, rawRobotSlots);
  state.device = configured.device;
  state.robotSlots = configured.selections;
  const stations = Object.entries(state.device.Stations);
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  state.deviceName = deviceName;
  state.stationNames = stations.map(([name]) => name).sort(natural);
  state.loadPorts = stations.filter(([, item]) => String(item.Type || "").toLowerCase() === "loadport").map(([name]) => name).sort(natural);
  state.processModules = stations.filter(([, item]) => PROCESSING_STATION_TYPES.has(String(item.Type || "").trim().toLowerCase())).map(([name]) => name).sort(natural);
  state.robotNames = Object.keys(state.device.Robots).sort(natural);
  state.robotScopes = Object.fromEntries(Object.entries(state.device.Robots).map(([name, robot]) => [name, [...new Set(Object.values(robot.ArmInfo || {}).filter((arm) => arm.IsEnable !== false).flatMap((arm) => arm.AccessibleStations || []))]]));
  visualizationWorkspace.setDevice(state.device);
  if (!state.loadPorts.length || !state.processModules.length) throw new Error("\u8BBE\u5907\u5FC5\u987B\u5305\u542B LoadPort \u548C ProcessChamber");
}
function shortestDevicePath(source, destination) {
  const queue = [[`S:${source}`]], visited = new Set(queue[0]);
  while (queue.length) {
    const path = queue.shift(), node = path.at(-1);
    if (node === `S:${destination}`) return path.map((item) => item.slice(2));
    const [kind, name] = node.split(":");
    const neighbours = kind === "S" ? state.robotNames.filter((robot) => (state.robotScopes[robot] || []).includes(name)).map((robot) => `R:${robot}`) : (state.robotScopes[name] || []).map((station) => `S:${station}`);
    neighbours.forEach((next) => {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    });
  }
  return [];
}
function defaultRouteStages(routeName) {
  const port = state.loadPorts[0] || "", modules = state.processModules.slice(0, 2), outward = shortestDevicePath(port, modules[0]);
  if (outward.length < 3) return linkRouteSteps([makeStage(port), makeStage(state.robotNames[0] || ""), makeStage(modules, true, `${routeName}_Step2`), makeStage(state.robotNames[0] || ""), makeStage(port)]);
  outward[outward.length - 1] = modules;
  const full = [...outward, ...outward.slice(0, -1).reverse()];
  return linkRouteSteps(full.map((name, index) => makeStage(name, index === outward.length - 1, index === outward.length - 1 ? `${routeName}_Step${index}` : "")));
}
function makeDefaultTestCase(name = "\u9ED8\u8BA4\u6D4B\u8BD5\u96C6") {
  if (!state.routes.length) {
    const routeName2 = "RouteA";
    state.routes.push({ name: routeName2, group: routeName2, bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: defaultRouteStages(routeName2) });
  }
  const routeName = state.routes[0]?.name || "";
  return {
    name,
    group: state.activeTestGroup || "",
    strategy: "heuristic",
    roundCount: 2,
    times: [0, 70],
    options: { loadLockManager: "petri-look", residencyGuardSeconds: 0, maximumRobotHoldingSeconds: 0, maximumSystemResidenceCv: 0, loadLockMacroSearchSeconds: 4, loadLockMacroRollouts: 96, nnSAEASearchSeconds: 4, nnSAEARollouts: 64, rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 },
    cleans: state.cleans,
    routes: state.routes,
    rounds: [
      makeRound(1, 0, routeName, state.loadPorts[0] || ""),
      makeRound(2, 70, routeName, state.loadPorts[1] || state.loadPorts[0] || "")
    ]
  };
}
function showWorkspaceDialog({ title, message, value = "", needsInput = false, dangerous = false }) {
  const dialog = document.getElementById("workspaceDialog"), input = document.getElementById("workspaceDialogInput"), confirm = document.getElementById("workspaceDialogConfirm");
  document.getElementById("workspaceDialogTitle").textContent = title;
  document.getElementById("workspaceDialogMessage").textContent = message;
  input.hidden = !needsInput;
  input.required = needsInput;
  input.value = value;
  confirm.textContent = dangerous ? "\u786E\u8BA4\u5220\u9664" : "\u786E\u8BA4";
  confirm.classList.toggle("danger", dangerous);
  confirm.classList.toggle("primary", !dangerous);
  dialog.showModal();
  window.setTimeout(() => (needsInput ? input : confirm).focus(), 0);
  return new Promise((resolve) => dialog.addEventListener("close", () => {
    resolve(dialog.returnValue === "confirm" ? needsInput ? input.value.trim() : true : null);
  }, { once: true }));
}
var compactSelectMenus = /* @__PURE__ */ new WeakMap();
function compactSelectMenu(wrapper) {
  return compactSelectMenus.get(wrapper) || wrapper.querySelector(".compact-select-menu");
}
function closeCompactSelect(wrapper) {
  const trigger = wrapper.querySelector(".compact-select-trigger");
  const menu = compactSelectMenu(wrapper);
  wrapper.classList.remove("is-open");
  trigger.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  menu.removeAttribute("style");
  if (menu.parentElement !== wrapper) wrapper.append(menu);
}
function closeCompactSelects(exceptSelect = null) {
  document.querySelectorAll(".compact-select.is-open").forEach((wrapper) => {
    if (wrapper.querySelector("select") !== exceptSelect) closeCompactSelect(wrapper);
  });
}
function compactSelectTargets() {
  return document.querySelectorAll("select[data-compact-label], #roundList select:not([multiple])");
}
function compactSelectLabel(select) {
  return select.dataset.compactLabel || select.getAttribute("aria-label") || select.closest(".field")?.querySelector("label")?.textContent?.trim() || "\u8BF7\u9009\u62E9";
}
function refreshCompactSelect(select) {
  const wrapper = select.parentElement;
  if (!wrapper?.classList.contains("compact-select")) return;
  const trigger = wrapper.querySelector(".compact-select-trigger");
  const menu = compactSelectMenu(wrapper);
  const selectedOption = select.selectedOptions[0] || select.options[0];
  trigger.disabled = select.disabled;
  trigger.setAttribute("aria-label", `${compactSelectLabel(select)}\uFF1A${selectedOption?.textContent?.trim() || "\u672A\u9009\u62E9"}`);
  trigger.querySelector(".compact-select-value").textContent = selectedOption?.textContent?.trim() || "\u672A\u9009\u62E9";
  menu.innerHTML = Array.from(select.options).map((option, index) => `<button class="compact-select-option" type="button" role="option" data-option-index="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}>${escapeHtml3(option.textContent?.trim() || "\u672A\u547D\u540D\u9009\u9879")}</button>`).join("");
}
function initializeCompactSelects() {
  compactSelectTargets().forEach((select) => {
    if (select.parentElement?.classList.contains("compact-select")) return;
    const wrapper = document.createElement("div");
    const trigger = document.createElement("button");
    const menu = document.createElement("div");
    wrapper.className = "compact-select";
    trigger.className = "compact-select-trigger";
    trigger.type = "button";
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = `<span class="compact-select-label">${escapeHtml3(compactSelectLabel(select))}</span><span class="compact-select-value"></span><i class="compact-select-chevron" aria-hidden="true"></i>`;
    menu.className = "compact-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", compactSelectLabel(select));
    menu.hidden = true;
    select.before(wrapper);
    wrapper.append(select, trigger, menu);
    compactSelectMenus.set(wrapper, menu);
    const setOpen = (open) => {
      if (!open) {
        closeCompactSelect(wrapper);
        return;
      }
      closeCompactSelects(select);
      const triggerBounds = trigger.getBoundingClientRect();
      document.body.append(menu);
      menu.hidden = false;
      menu.style.position = "fixed";
      menu.style.top = `${triggerBounds.bottom + 6}px`;
      menu.style.left = `${triggerBounds.left}px`;
      menu.style.width = `${triggerBounds.width}px`;
      wrapper.classList.add("is-open");
      trigger.setAttribute("aria-expanded", "true");
      window.setTimeout(() => menu.querySelector("[aria-selected='true']")?.focus(), 0);
    };
    trigger.addEventListener("click", () => !select.disabled && setOpen(!wrapper.classList.contains("is-open")));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
    });
    menu.addEventListener("click", (event) => {
      const optionButton = event.target.closest("[data-option-index]");
      if (!optionButton || optionButton.disabled) return;
      select.selectedIndex = Number(optionButton.dataset.optionIndex);
      setOpen(false);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    refreshCompactSelect(select);
  });
  if (!document.body.dataset.compactSelectCloseHandler) {
    document.body.dataset.compactSelectCloseHandler = "true";
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".compact-select, .compact-select-menu")) closeCompactSelects();
    });
  }
}
function renderWorkspaceControls() {
  const deviceSelect = document.getElementById("deviceSelect"), tests = state.workspaceDevice?.tests || [];
  const displayDeviceName = (name) => String(name || "\u672A\u547D\u540D\u8BBE\u5907").replace(/\.json$/i, "");
  deviceSelect.innerHTML = state.workspaceDevices.length ? state.workspaceDevices.map((device) => `<option value="${escapeHtml3(device.id)}" ${device.id === state.workspaceDeviceId ? "selected" : ""}>${escapeHtml3(displayDeviceName(device.name))}</option>`).join("") : `<option value="">\u5C1A\u672A\u5BFC\u5165\u8BBE\u5907</option>`;
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  const groups = [.../* @__PURE__ */ new Set(["", ...state.workspaceDevice?.testGroups || [], ...tests.map((test) => String(test.group || "").trim())])].sort((left, right) => !left - !right || natural(left, right));
  const selectedGroup = groups.includes(state.activeTestGroup) ? state.activeTestGroup : groups[0] || "";
  const groupSelect = document.getElementById("testGroupSelect");
  groupSelect.innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml3(group)}" title="${escapeHtml3(group || "\u672A\u5206\u7EC4")}" ${group === selectedGroup ? "selected" : ""}>${escapeHtml3(group || "\u672A\u5206\u7EC4")}</option>`).join("") : `<option value="">\u672A\u5206\u7EC4</option>`;
  groupSelect.title = selectedGroup || "\u672A\u5206\u7EC4";
  groupSelect.disabled = !state.workspaceDeviceId;
  const testSelect = document.getElementById("testCaseSelect");
  const visibleTests = tests.filter((test) => String(test.group || "").trim() === selectedGroup).sort((left, right) => natural(left.name, right.name));
  testSelect.innerHTML = visibleTests.length ? visibleTests.map((test) => `<option value="${escapeHtml3(test.id)}" title="${escapeHtml3(test.name)}" ${test.id === state.testCaseId ? "selected" : ""}>${escapeHtml3(test.name)}</option>`).join("") : `<option value="">\u8BE5\u7EC4\u6682\u65E0\u6D4B\u8BD5</option>`;
  testSelect.title = visibleTests.find((test) => test.id === state.testCaseId)?.name || "\u8BE5\u7EC4\u6682\u65E0\u6D4B\u8BD5";
  testSelect.disabled = !visibleTests.length;
  const hasTest = Boolean(state.testCaseId);
  const nameInput = document.getElementById("testCaseName");
  nameInput.disabled = !hasTest;
  nameInput.value = state.testCaseName || "";
  nameInput.title = state.testCaseName || "";
  document.getElementById("newTestButton").disabled = !state.workspaceDeviceId;
  document.getElementById("newGroupButton").disabled = !state.workspaceDeviceId;
  const isDefaultGroup = !selectedGroup;
  const hasGroupTests = tests.some((test) => String(test.group || "").trim() === selectedGroup);
  document.getElementById("renameGroupButton").disabled = !state.workspaceDeviceId || isDefaultGroup;
  document.getElementById("deleteGroupButton").disabled = !state.workspaceDeviceId || isDefaultGroup && !hasGroupTests;
  document.getElementById("deleteGroupButton").title = isDefaultGroup ? "\u5220\u9664\u201C\u672A\u5206\u7EC4\u201D\u4E2D\u7684\u5168\u90E8\u6D4B\u8BD5" : "\u5220\u9664\u5F53\u524D\u6D4B\u8BD5\u7EC4\u522B";
  document.getElementById("groupActionHint").textContent = isDefaultGroup && state.workspaceDeviceId ? "\u201C\u672A\u5206\u7EC4\u201D\u4E0D\u53EF\u91CD\u547D\u540D\uFF1B\u6709\u6D4B\u8BD5\u65F6\u53EF\u4EE5\u5220\u9664\u5176\u4E2D\u5168\u90E8\u6D4B\u8BD5\u3002" : "";
  document.getElementById("copyTestButton").disabled = !hasTest;
  document.getElementById("saveTestButton").disabled = !hasTest;
  document.getElementById("deleteTestButton").disabled = tests.length <= 1;
  const batchDisabled = state.batchRunning || !state.serviceCompatible || !visibleTests.length;
  document.getElementById("batchRunButton").disabled = batchDisabled;
  document.getElementById("openParameterComparisonDialogButton").disabled = state.batchRunning || !state.serviceCompatible || !state.parameterComparison?.baseline;
  const emptyHint = document.getElementById("emptyGroupHint");
  emptyHint.classList.toggle("visible", Boolean(state.workspaceDeviceId) && !visibleTests.length);
  document.getElementById("emptyGroupNewTestButton").disabled = !state.workspaceDeviceId;
  const deviceType = /PSE300/i.test(state.deviceName) ? "\u5355\u8154\u975E\u7EA7\u8054" : String(state.workspaceDevice?.deviceType || "\u5355\u8154\u975E\u7EA7\u8054");
  document.getElementById("deviceSummary").innerHTML = state.device ? `<span class="chip good">${escapeHtml3(deviceType)}</span>` : `<span class="chip">\u5C1A\u672A\u9009\u62E9\u8BBE\u5907</span>`;
  compactSelectTargets().forEach(refreshCompactSelect);
}
function setWorkspaceStatus(message, kind = "") {
  const status = document.getElementById("workspaceStatus");
  status.textContent = message;
  status.className = `workspace-status ${kind}`.trim();
}
var autoSaveTimer = null;
function scheduleAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    if (state.dirty) saveCurrentTest(true).catch((error) => setWorkspaceStatus(`\u81EA\u52A8\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty"));
  }, 600);
}
function markTestDirty() {
  if (!state.testCaseId) return;
  state.dirty = true;
  setWorkspaceStatus(`\u201C${state.testCaseName}\u201D\u6709\u672A\u4FDD\u5B58\u4FEE\u6539`, "dirty");
  scheduleAutoSave();
}
function resetRunResult() {
  visualizationWorkspace.clear();
  state.batchResult = null;
  state.selectedBatchTestId = "";
  batchPerformanceAnalyses.clear();
  batchBottleneckSummaries.clear();
  batchBottleneckRequests.clear();
  batchBottleneckErrors.clear();
  ["metricTime", "metricMakespan", "metricMoves", "metricValidation"].forEach((id) => {
    document.getElementById(id).textContent = "\u2014";
  });
  ["metricTimeDetail", "metricMakespanDetail", "metricMovesDetail", "metricValidationDetail"].forEach((id) => {
    document.getElementById(id).textContent = "";
  });
  document.getElementById("metricContext").textContent = "\u8FD0\u884C\u603B\u89C8";
  document.getElementById("batchOverviewButton").hidden = true;
  document.getElementById("testGroupAnalysisButton").hidden = true;
  document.getElementById("testGroupAnalysisPanel").hidden = true;
  document.getElementById("testGroupAnalysisPanel").innerHTML = "";
  state.parameterComparison = null;
  document.getElementById("parameterComparisonPanel").hidden = true;
  document.getElementById("parameterComparisonResults").innerHTML = "";
  document.getElementById("openParameterComparisonDialogButton").disabled = true;
  document.getElementById("metricTimeLabel").textContent = "\u603B\u8017\u65F6";
  document.getElementById("metricMakespanLabel").textContent = "Makespan";
  setBottleneckMetric(null);
  document.getElementById("metricValidationLabel").textContent = "\u6821\u9A8C";
  document.getElementById("metricValidation").closest(".metric").classList.remove("is-success", "is-error");
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  for (const id of ["logButton", "ganttButton", "batchGanttButton"]) {
    const link = document.getElementById(id);
    link.href = "#";
    link.setAttribute("aria-disabled", "true");
  }
  writeTerminal("$ \u6D4B\u8BD5\u96C6\u5DF2\u5C31\u7EEA\uFF0C\u7B49\u5F85\u8FD0\u884C\u2026");
}
function applyTestCase(testCase) {
  const value = structuredClone(testCase);
  state.routeNameChanges.clear();
  state.testCaseId = value.id;
  state.testCaseName = value.name;
  state.testCaseGroup = String(value.group || "");
  state.activeTestGroup = state.testCaseGroup;
  state.strategy = value.strategy || "heuristic";
  state.roundCount = Math.max(1, Number(value.roundCount) || 1);
  state.times = Array.isArray(value.times) ? value.times : [0];
  state.options = value.options || { loadLockManager: "petri-look", residencyGuardSeconds: 0, maximumRobotHoldingSeconds: 0, maximumSystemResidenceCv: 0, loadLockMacroSearchSeconds: 4, loadLockMacroRollouts: 96, nnSAEASearchSeconds: 4, nnSAEARollouts: 64, neuralUCBTopK: 2, neuralUCBExploration: 5, rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 };
  state.options.loadLockManager = state.options.loadLockManager || "petri-look";
  delete state.options.loadLockExchange;
  for (const key of ["residencyGuardSeconds", "maximumRobotHoldingSeconds", "maximumSystemResidenceCv"]) {
    const objectiveValue = Number(state.options[key]);
    state.options[key] = Number.isFinite(objectiveValue) && objectiveValue >= 0 ? objectiveValue : 0;
  }
  const macroSearchSeconds = Number(state.options.loadLockMacroSearchSeconds);
  state.options.loadLockMacroSearchSeconds = Number.isFinite(macroSearchSeconds) && macroSearchSeconds >= 0 ? macroSearchSeconds : 4;
  const macroRollouts = Number(state.options.loadLockMacroRollouts);
  state.options.loadLockMacroRollouts = Number.isFinite(macroRollouts) && macroRollouts >= 0 ? Math.floor(macroRollouts) : 96;
  const nnSAEASearchSeconds = Number(state.options.nnSAEASearchSeconds);
  state.options.nnSAEASearchSeconds = Number.isFinite(nnSAEASearchSeconds) && nnSAEASearchSeconds >= 0 ? nnSAEASearchSeconds : 4;
  const nnSAEARollouts = Number(state.options.nnSAEARollouts);
  state.options.nnSAEARollouts = Number.isFinite(nnSAEARollouts) && nnSAEARollouts >= 0 ? Math.floor(nnSAEARollouts) : 64;
  state.options.neuralUCBTopK = Number(state.options.neuralUCBTopK) || 2;
  state.options.neuralUCBExploration = Number.isFinite(Number(state.options.neuralUCBExploration)) ? Number(state.options.neuralUCBExploration) : 5;
  state.options.milpTimeLimit = Number(state.options.milpTimeLimit) || 120;
  if (!state.routes.length && Array.isArray(value.routes)) state.routes = value.routes;
  if (!state.cleans.length && Array.isArray(value.cleans)) state.cleans = value.cleans.map(normalizeClean);
  state.routes.forEach(normalizeRoute);
  state.expandedRouteProcessGroups.clear();
  state.expandedRouteGroups.clear();
  state.expandedRoutes.clear();
  state.rounds = Array.isArray(value.rounds) ? value.rounds : [];
  if (state.strategy === "milp") state.roundCount = 1;
  while (state.times.length < state.roundCount) state.times.push((Number(state.times.at(-1)) || 0) + 70);
  while (state.rounds.length < state.roundCount) {
    const index = state.rounds.length;
    state.rounds.push(makeRound(index + 1, state.times[index], state.routes[0]?.name || "", state.loadPorts[index] || state.loadPorts[0] || ""));
  }
  state.times.length = state.roundCount;
  state.rounds.length = state.roundCount;
  state.times[0] = 0;
  normalizeRounds();
  state.drawer = null;
  visualizationWorkspace.setAnalysisConfiguration(state.routes, state.rounds);
  visualizationWorkspace.setReplayPlan(buildPayload());
  const cleanNamesChanged = synchronizeCleanNames();
  const routeNamesChanged = synchronizeRouteNames();
  state.dirty = cleanNamesChanged || routeNamesChanged;
  document.getElementById("roundCount").value = state.roundCount;
  document.querySelectorAll('input[name="strategy"]').forEach((input) => {
    input.checked = input.value === state.strategy;
  });
  document.querySelectorAll("[data-option]").forEach((input) => {
    input.value = state.options[input.dataset.option] ?? input.value;
  });
  document.getElementById("loadlockOptions").classList.toggle("is-hidden", !["heuristic", "loadlock-macro", "nn-saea", "setrank", "neuralucb", "neural", "e2e-ctq", "rl"].includes(state.strategy));
  document.getElementById("heuristicObjectiveOptions").classList.toggle("is-hidden", !["heuristic", "loadlock-macro"].includes(state.strategy));
  document.getElementById("nnSAEAOptions").classList.toggle("is-hidden", state.strategy !== "nn-saea");
  document.getElementById("neuralucbOptions").classList.toggle("is-hidden", state.strategy !== "neuralucb");
  document.getElementById("rlOptions").classList.toggle("is-hidden", state.strategy !== "rl");
  document.getElementById("milpOptions").classList.toggle("is-hidden", state.strategy !== "milp");
  document.getElementById("roundCount").disabled = state.strategy === "milp";
  if (Object.keys(state.algorithmMetadata).length) showAlgorithmDetails(state.strategy);
  renderAll();
  renderWorkspaceControls();
  resetRunResult();
  if (state.dirty) {
    setWorkspaceStatus("\u6B63\u5728\u4FDD\u5B58\u7EDF\u4E00\u751F\u6210\u7684\u8DEF\u5F84\u4E0E Clean \u540D\u79F0\u2026", "dirty");
    scheduleAutoSave();
  } else setWorkspaceStatus(`\u5DF2\u8F7D\u5165\u201C${state.testCaseName}\u201D`, "saved");
}
function currentTestSnapshot(name = state.testCaseName) {
  normalizeRounds();
  synchronizeCleanNames();
  synchronizeRouteNames();
  return structuredClone({ name, group: state.testCaseGroup, strategy: state.strategy, roundCount: state.roundCount, times: state.times, options: state.options, cleans: state.cleans.map(runtimeClean), routes: state.routes, routeNameChanges: Object.fromEntries(state.routeNameChanges), rounds: state.rounds });
}
async function saveCurrentTest(silent = false) {
  if (!state.workspaceDeviceId || !state.testCaseId) return false;
  const inputName = document.getElementById("testCaseName").value.trim();
  if (!inputName) {
    setWorkspaceStatus("\u6D4B\u8BD5\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u8BF7\u8F93\u5165\u540D\u79F0\u540E\u518D\u4FDD\u5B58", "dirty");
    throw new Error("\u6D4B\u8BD5\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  }
  state.testCaseName = inputName;
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentTestSnapshot())
    });
  } catch (error) {
    setWorkspaceStatus(`\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty");
    throw error;
  }
  const index = state.workspaceDevice.tests.findIndex((test) => test.id === state.testCaseId);
  state.workspaceDevice.tests[index] = result.test;
  state.testCaseName = result.test.name;
  state.dirty = false;
  state.routeNameChanges.clear();
  state.workspaceDevice.routes = structuredClone(state.routes);
  state.workspaceDevice.cleans = structuredClone(state.cleans);
  renderWorkspaceControls();
  setWorkspaceStatus(`${silent ? "\u5DF2\u81EA\u52A8\u4FDD\u5B58" : "\u5DF2\u4FDD\u5B58"}\u201C${state.testCaseName}\u201D`, "saved");
  return true;
}
async function createTestCase(copyCurrent = false, targetGroup = state.activeTestGroup) {
  if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907");
  if (state.dirty) await saveCurrentTest(true);
  const source = copyCurrent ? currentTestSnapshot(`${state.testCaseName} \u526F\u672C`) : makeDefaultTestCase(`\u6D4B\u8BD5\u96C6 ${(state.workspaceDevice?.tests?.length || 0) + 1}`);
  source.group = targetGroup;
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source)
  });
  state.workspaceDevice.tests.push(result.test);
  const summary = state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId);
  if (summary) summary.testCount = state.workspaceDevice.tests.length;
  applyTestCase(result.test);
}
async function createTestGroup() {
  const group = await showWorkspaceDialog({ title: "\u65B0\u589E\u6D4B\u8BD5\u7EC4\u522B", message: "\u8BF7\u8F93\u5165\u7EC4\u522B\u540D\u79F0\uFF1B\u65B0\u5EFA\u540E\u4F1A\u81EA\u52A8\u5207\u6362\u5230\u8BE5\u7EC4\u3002", needsInput: true });
  if (group === null) return;
  if (!group) throw new Error("\u6D4B\u8BD5\u7EC4\u522B\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  const exists = (state.workspaceDevice?.testGroups || []).includes(group) || (state.workspaceDevice?.tests || []).some((test) => String(test.group || "").trim() === group);
  if (exists) throw new Error(`\u6D4B\u8BD5\u7EC4\u522B\u201C${group}\u201D\u5DF2\u7ECF\u5B58\u5728`);
  if (state.dirty) await saveCurrentTest(true);
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: group })
    });
  } catch (error) {
    if (error.message === "Not found") throw new Error("\u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\uFF0C\u8BF7\u91CD\u542F server.py \u540E\u518D\u65B0\u5EFA\u7EC4\u522B");
    throw error;
  }
  state.workspaceDevice.testGroups = result.groups;
  state.activeTestGroup = group;
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = group;
  state.dirty = false;
  renderWorkspaceControls();
  resetRunResult();
  setWorkspaceStatus(`\u5DF2\u65B0\u5EFA\u6D4B\u8BD5\u7EC4\u522B\u201C${group}\u201D\uFF0C\u8BF7\u5728\u8BE5\u7EC4\u4E2D\u65B0\u5EFA\u6D4B\u8BD5`, "saved");
}
async function renameCurrentTestGroup() {
  const oldName = state.activeTestGroup;
  if (!oldName) throw new Error("\u9ED8\u8BA4\u201C\u672A\u5206\u7EC4\u201D\u4E0D\u80FD\u91CD\u547D\u540D");
  const group = await showWorkspaceDialog({ title: "\u91CD\u547D\u540D\u6D4B\u8BD5\u7EC4\u522B", message: "\u7EC4\u5185\u6D4B\u8BD5\u4F1A\u4FDD\u7559\uFF0C\u5E76\u540C\u6B65\u4F7F\u7528\u65B0\u7EC4\u522B\u540D\u79F0\u3002", value: oldName, needsInput: true });
  if (group === null || group === oldName) return;
  if (!group) throw new Error("\u6D4B\u8BD5\u7EC4\u522B\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  if (state.dirty) await saveCurrentTest(true);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName, name: group })
  });
  state.workspaceDevice.testGroups = result.groups;
  state.workspaceDevice.tests = result.tests;
  state.activeTestGroup = group;
  state.testCaseGroup = group;
  const current = result.tests.find((test) => test.id === state.testCaseId);
  if (current) applyTestCase(current);
  else await selectWorkspaceGroup(group);
  setWorkspaceStatus(`\u5DF2\u5C06\u6D4B\u8BD5\u7EC4\u522B\u91CD\u547D\u540D\u4E3A\u201C${group}\u201D`, "saved");
}
async function deleteCurrentTestGroup() {
  const group = state.activeTestGroup;
  const testCount = (state.workspaceDevice?.tests || []).filter((test) => String(test.group || "").trim() === group).length;
  if (!group && !testCount) throw new Error("\u201C\u672A\u5206\u7EC4\u201D\u4E2D\u6CA1\u6709\u53EF\u5220\u9664\u7684\u6D4B\u8BD5");
  const impact = testCount ? `\u8BE5\u7EC4\u542B\u6709 ${testCount} \u4E2A\u6D4B\u8BD5\uFF0C\u5220\u9664\u540E\u8FD9\u4E9B\u6D4B\u8BD5\u5C06\u65E0\u6CD5\u6062\u590D\u3002` : "\u8BE5\u7EC4\u4E3A\u7A7A\uFF0C\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002";
  const displayName = group || "\u672A\u5206\u7EC4";
  const confirmed = await showWorkspaceDialog({ title: "\u5220\u9664\u6D4B\u8BD5\u7EC4\u522B", message: `\u786E\u5B9A\u5220\u9664\u201C${displayName}\u201D\u5417\uFF1F${impact}`, dangerous: true });
  if (!confirmed) return;
  if (state.dirty) await saveCurrentTest(true);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: group })
  });
  state.workspaceDevice.testGroups = result.groups;
  state.workspaceDevice.tests = result.tests;
  const summary = state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId);
  if (summary) summary.testCount = result.tests.length;
  const nextGroup = result.groups[0] || "";
  state.activeTestGroup = nextGroup;
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = nextGroup;
  state.dirty = false;
  const nextTest = result.tests.find((test) => String(test.group || "").trim() === nextGroup) || result.tests[0];
  if (nextTest) applyTestCase(nextTest);
  else {
    renderWorkspaceControls();
    resetRunResult();
    setWorkspaceStatus(`\u5DF2\u5220\u9664\u6D4B\u8BD5\u7EC4\u522B\u201C${displayName}\u201D`, "saved");
  }
}
async function deleteCurrentTest() {
  if (!state.testCaseId) return;
  const confirmed = await showWorkspaceDialog({ title: "\u5220\u9664\u6D4B\u8BD5", message: `\u786E\u5B9A\u5220\u9664\u6D4B\u8BD5\u201C${state.testCaseName}\u201D\u5417\uFF1F\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002`, dangerous: true });
  if (!confirmed) return;
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, { method: "DELETE" });
  state.workspaceDevice.tests = result.tests;
  const summary = state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId);
  if (summary) summary.testCount = result.tests.length;
  applyTestCase(result.tests[0]);
}
async function selectWorkspaceTest(testId) {
  if (state.dirty) await saveCurrentTest(true);
  const testCase = state.workspaceDevice?.tests?.find((test) => test.id === testId);
  if (!testCase) throw new Error(`\u6D4B\u8BD5\u96C6\u4E0D\u5B58\u5728\uFF1A${testId}`);
  applyTestCase(testCase);
}
async function selectWorkspaceGroup(group) {
  if (state.dirty) await saveCurrentTest(true);
  state.activeTestGroup = group;
  const testCase = state.workspaceDevice?.tests?.find((test) => String(test.group || "").trim() === group);
  if (!testCase) {
    state.testCaseId = "";
    state.testCaseName = "";
    state.testCaseGroup = group;
    state.dirty = false;
    renderWorkspaceControls();
    resetRunResult();
    setWorkspaceStatus(`\u6D4B\u8BD5\u7EC4\u522B\u201C${group || "\u672A\u5206\u7EC4"}\u201D\u6682\u65E0\u6D4B\u8BD5`, "saved");
    return;
  }
  applyTestCase(testCase);
}
async function selectWorkspaceDevice(deviceId, preferredTestId = "") {
  const result = await requestJson(`/api/workspaces/${deviceId}`);
  state.workspaceDevice = result.device;
  state.workspaceDeviceId = result.device.id;
  state.activeTestGroup = "";
  state.testCaseGroup = "";
  applyDeviceTopology(result.device.device, result.device.name, result.device.robotSlots);
  state.routes = Array.isArray(result.device.routes) ? structuredClone(result.device.routes) : [];
  state.cleans = Array.isArray(result.device.cleans) ? structuredClone(result.device.cleans).map(normalizeClean) : [];
  if (!result.device.tests.length) {
    const created = await requestJson(`/api/workspaces/${deviceId}/tests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeDefaultTestCase())
    });
    state.workspaceDevice.tests.push(created.test);
  }
  const summary = state.workspaceDevices.find((device) => device.id === deviceId);
  if (summary) summary.testCount = state.workspaceDevice.tests.length;
  const selected = state.workspaceDevice.tests.find((test) => test.id === preferredTestId) || state.workspaceDevice.tests[0];
  applyTestCase(selected);
}
async function loadWorkspaceCatalog(preferredDeviceId = "", preferredTestId = "") {
  const result = await requestJson("/api/workspaces");
  state.workspaceDevices = result.devices;
  const deviceId = result.devices.some((device) => device.id === preferredDeviceId) ? preferredDeviceId : result.devices[0]?.id;
  if (deviceId) await selectWorkspaceDevice(deviceId, preferredTestId);
  else renderWorkspaceControls();
}
function switchTab(name) {
  document.querySelectorAll("[data-tab-target]").forEach((button) => button.classList.toggle("active", button.dataset.tabTarget === name));
  document.querySelectorAll("[data-tab-view]").forEach((view) => view.classList.toggle("active", view.dataset.tabView === name));
  document.getElementById("scheduleSide").classList.toggle("is-hidden", name !== "schedule");
  document.getElementById("pageLayout").classList.toggle("editor-mode", name !== "schedule");
  if (name !== "route") closeStepDrawer();
}
var THEME_STORAGE_KEY = "realtime-scheduler-theme";
function applyColorTheme(isDarkMode) {
  document.body.classList.toggle("theme-dark", isDarkMode);
  const toggle = document.getElementById("themeToggle");
  toggle.setAttribute("aria-pressed", String(isDarkMode));
  toggle.setAttribute("aria-label", isDarkMode ? "\u5207\u6362\u5230\u65E5\u95F4\u6A21\u5F0F" : "\u5207\u6362\u5230\u591C\u95F4\u6A21\u5F0F");
  toggle.querySelector("span").textContent = isDarkMode ? "\u65E5\u95F4\u6A21\u5F0F" : "\u591C\u95F4\u6A21\u5F0F";
}
function initializeThemeToggle() {
  let isDarkMode = false;
  try {
    isDarkMode = window.localStorage.getItem(THEME_STORAGE_KEY) === "dark";
  } catch {
  }
  applyColorTheme(isDarkMode);
  document.getElementById("themeToggle").addEventListener("click", () => {
    isDarkMode = !document.body.classList.contains("theme-dark");
    applyColorTheme(isDarkMode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, isDarkMode ? "dark" : "light");
    } catch {
    }
  });
}
function resizeRounds(count) {
  normalizeRounds();
  const safe = state.strategy === "milp" ? 1 : Math.max(1, Math.min(8, Number(count) || 1));
  state.roundCount = safe;
  while (state.rounds.length < safe) {
    const index = state.rounds.length, priorTime = Number(state.rounds.at(-1)?.currentTime || 0);
    state.rounds.push(makeRound(index + 1, priorTime + 70, state.routes[0]?.name || "", state.loadPorts[index] || state.loadPorts[0] || ""));
  }
  state.rounds.length = safe;
  normalizeRounds();
  renderRounds();
}
function renderTimes() {
  normalizeRounds();
}
function cleanPlacementDefinitions(scope) {
  return scope === "route" ? [
    { key: "prePJobCleanRefs", label: "PJob \u524D", types: ["preclean", "dummy", "dummywac"] },
    { key: "postPJobCleanRefs", label: "PJob \u540E", types: ["postclean"] }
  ] : [
    { key: "beforeCleanRefs", label: "\u8FDB\u5165\u8154\u5BA4\u524D", types: ["preclean", "dummy", "dummywac"] },
    { key: "afterCleanRefs", label: "\u79BB\u5F00\u8154\u5BA4\u540E", types: ["postclean", "wacclean"] }
  ];
}
function cleanContextModules(scope, routeIndex, stageIndex = -1) {
  const route = state.routes[routeIndex];
  if (!route) return [];
  const stages = scope === "step" ? [route.stages[stageIndex]] : route.stages;
  return [...new Set((stages || []).flatMap((stage) => (stage?.visits || []).map((visit) => visit.stationName).filter((module) => state.processModules.includes(module))))];
}
function cleanContextReferences(scope, routeIndex, stageIndex, placement) {
  const route = state.routes[routeIndex];
  if (!route) return [];
  if (scope === "route") return stringList(route[placement]);
  return stringList(route.stages[stageIndex]?.visits?.[0]?.[placement]);
}
function setCleanContextReference(context, placement, cleanName, enabled) {
  const route = state.routes[context.routeIndex];
  if (!route) return;
  const update = (target) => {
    const names = new Set(stringList(target[placement]));
    if (enabled) names.add(cleanName);
    else names.delete(cleanName);
    target[placement] = [...names];
  };
  if (context.scope === "route") update(route);
  else (route.stages[context.stageIndex]?.visits || []).forEach(update);
}
function cleanReferenceCount(cleanName) {
  let count = 0;
  state.routes.forEach((route) => {
    ROUTE_CLEAN_KEYS.forEach((key) => {
      if (stringList(route[key]).includes(cleanName)) count += 1;
    });
    (route.stages || []).forEach((stage) => (stage.visits || []).forEach((visit) => {
      for (const key of ["beforeCleanRefs", "afterCleanRefs"]) {
        if (stringList(visit[key]).includes(cleanName)) count += 1;
      }
    }));
  });
  return count;
}
function renderContextCleans(scope, routeIndex, stageIndex = -1) {
  const rows = cleanPlacementDefinitions(scope).flatMap(
    (placement) => cleanContextReferences(scope, routeIndex, stageIndex, placement.key).map((cleanName) => ({
      cleanName,
      placement,
      clean: state.cleans.find((item) => item.name === cleanName)
    }))
  );
  if (!rows.length) return `<div class="context-clean-empty">\u5C1A\u672A\u914D\u7F6E Clean</div>`;
  return `<div class="context-clean-list">${rows.map(({ cleanName, placement, clean }) => {
    const modules = stringList(clean?.modules);
    const moduleSummary = modules.length ? modules.join(" / ") : "\u672A\u9009\u62E9\u8154\u5BA4";
    return `<div class="context-clean-item">
      <div><strong>${escapeHtml3(cleanName)}</strong><small>${escapeHtml3(placement.label)} \xB7 ${escapeHtml3(moduleSummary)}</small></div>
      <div class="context-clean-actions">
        <button class="btn small" type="button" data-action="edit-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml3(cleanName)}">\u7F16\u8F91</button>
        <button class="btn danger small" type="button" data-action="remove-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml3(cleanName)}">\u79FB\u9664</button>
      </div>
    </div>`;
  }).join("")}</div>`;
}
function updateCleanDialogFields() {
  const context = state.cleanDialogContext;
  if (!context) return;
  const placement = document.getElementById("cleanPlacement").value;
  const definition = cleanPlacementDefinitions(context.scope).find((item) => item.key === placement);
  const typeSelect = document.getElementById("cleanType");
  const currentType = typeSelect.value || context.draft.cleanType;
  typeSelect.innerHTML = CLEAN_TYPE_DEFINITIONS.filter((item) => definition?.types.includes(item.key)).map((item) => `<option value="${item.key}">${escapeHtml3(item.label)}</option>`).join("");
  typeSelect.value = definition?.types.includes(currentType) ? currentType : definition?.types[0] || "";
  document.getElementById("cleanTriggerField").hidden = typeSelect.value !== "wacclean";
  document.getElementById("cleanWacTimeField").hidden = typeSelect.value !== "dummywac";
}
function openCleanDialog(scope, routeIndex, stageIndex = -1, cleanName = "", placement = "") {
  const existing = state.cleans.find((clean) => clean.name === cleanName);
  const definitions = cleanPlacementDefinitions(scope);
  const selectedPlacement = definitions.some((item) => item.key === placement) ? placement : definitions[0].key;
  const draft = normalizeClean(existing || makeClean(definitions[0].types[0]));
  state.cleanDialogContext = {
    scope,
    routeIndex,
    stageIndex,
    cleanName,
    originalPlacement: selectedPlacement,
    draft: structuredClone(draft)
  };
  document.getElementById("cleanDialogTitle").textContent = `${cleanName ? "\u7F16\u8F91" : "\u65B0\u589E"} ${scope === "route" ? "Route" : "RouteStep"} Clean`;
  document.getElementById("cleanDialogDescription").textContent = scope === "route" ? "Clean \u53EA\u4F1A\u51FA\u73B0\u5728\u6240\u9009 Route \u8154\u5BA4\u4E2D\u3002" : "Clean \u53EA\u4F1A\u51FA\u73B0\u5728\u5F53\u524D Step \u6240\u9009\u8154\u5BA4\u4E2D\u3002";
  const placementSelect = document.getElementById("cleanPlacement");
  placementSelect.innerHTML = definitions.map((item) => `<option value="${item.key}">${escapeHtml3(item.label)}</option>`).join("");
  placementSelect.value = selectedPlacement;
  document.getElementById("cleanType").innerHTML = `<option value="${draft.cleanType}">${escapeHtml3(draft.cleanType)}</option>`;
  document.getElementById("cleanRecipeTime").value = String(draft.recipeTime);
  document.getElementById("cleanTriggerCount").value = String(draft.triggerCount);
  document.getElementById("cleanWacRecipeTime").value = String(draft.wacRecipeTime);
  const selectedModules = new Set(stringList(draft.modules));
  const moduleHost = document.getElementById("cleanModuleOptions");
  const modules = cleanContextModules(scope, routeIndex, stageIndex);
  moduleHost.innerHTML = modules.length ? modules.map((module) => `<label class="clean-module-option"><input type="checkbox" name="cleanModule" value="${escapeHtml3(module)}" ${selectedModules.has(module) ? "checked" : ""}><span>${escapeHtml3(module)}</span></label>`).join("") : `<span class="clean-dialog-empty">\u5F53\u524D\u8303\u56F4\u6CA1\u6709\u53EF\u914D\u7F6E\u7684\u52A0\u5DE5\u8154\u5BA4</span>`;
  document.getElementById("cleanDialogError").textContent = "";
  document.getElementById("deleteCleanBindingButton").hidden = !cleanName;
  updateCleanDialogFields();
  document.getElementById("cleanType").value = draft.cleanType;
  updateCleanDialogFields();
  document.getElementById("cleanDialog").showModal();
}
function saveCleanDialog() {
  const context = state.cleanDialogContext;
  if (!context) return;
  const modules = Array.from(document.querySelectorAll('#cleanModuleOptions input[name="cleanModule"]:checked'), (input) => input.value);
  if (!modules.length) {
    document.getElementById("cleanDialogError").textContent = "\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A Clean \u9002\u7528\u8154\u5BA4\u3002";
    return;
  }
  const placement = document.getElementById("cleanPlacement").value;
  const clean = normalizeClean({
    ...context.draft,
    cleanType: document.getElementById("cleanType").value,
    recipeTime: Number(document.getElementById("cleanRecipeTime").value),
    triggerCount: Number(document.getElementById("cleanTriggerCount").value),
    wacRecipeTime: Number(document.getElementById("cleanWacRecipeTime").value),
    modules
  });
  if (context.cleanName) {
    const cleanIndex = state.cleans.findIndex((item) => item.name === context.cleanName);
    if (cleanIndex < 0) return;
    state.cleans[cleanIndex] = clean;
    if (context.originalPlacement !== placement) {
      setCleanContextReference(context, context.originalPlacement, context.cleanName, false);
      setCleanContextReference(context, placement, context.cleanName, true);
    }
  } else {
    state.cleans.push(clean);
    synchronizeCleanNames();
    const createdName = state.cleans.at(-1).name;
    setCleanContextReference(context, placement, createdName, true);
  }
  synchronizeCleanNames();
  markTestDirty();
  document.getElementById("cleanDialog").close();
  state.cleanDialogContext = null;
  renderRoutes();
  if (state.drawer) renderStepDrawer();
}
function removeContextClean(scope, routeIndex, stageIndex, placement, cleanName) {
  const context = { scope, routeIndex, stageIndex };
  setCleanContextReference(context, placement, cleanName, false);
  if (cleanReferenceCount(cleanName) === 0) {
    state.cleans = state.cleans.filter((clean) => clean.name !== cleanName);
  }
  markTestDirty();
  renderRoutes();
  if (state.drawer) renderStepDrawer();
}
function stepKind(route, index) {
  return stageUsesRobot(route.stages[index], index) ? "Robot" : "Station";
}
function renderCandidatePicker(routeIndex, stageIndex, allowed, candidates) {
  const selected = new Set(candidates);
  const summary = candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml3(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u9009\u62E9\u8BBE\u5907</span>`;
  return `<details class="candidate-picker" onclick="event.stopPropagation()"><summary>${summary}</summary><div class="candidate-picker-menu">${allowed.map((name) => `<label class="candidate-option"><input type="checkbox" data-scope="stage-candidate-toggle" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-candidate="${escapeHtml3(name)}" ${selected.has(name) ? "checked" : ""}><span>${escapeHtml3(name)}</span></label>`).join("")}</div></details>`;
}
function renderSteps(route, routeIndex) {
  return route.stages.map((stage, stageIndex) => {
    const candidates = [...new Set((stage.visits || []).map((visit) => visit.stationName).filter(Boolean))];
    const allowed = stageUsesRobot(stage, stageIndex) ? state.robotNames : state.stationNames;
    return `<tr data-step-card data-route-index="${routeIndex}" data-stage-index="${stageIndex}">
      <td><span class="step-id-badge">${Number(stage.stepId)}</span></td>
      <td><span class="step-type ${stage.needProcess ? "process" : ""}">${stepKind(route, stageIndex)}</span></td>
      <td>${renderCandidatePicker(routeIndex, stageIndex, allowed, candidates)}</td>
      <td class="route-step-readonly"><span class="step-next">${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "\u7ED3\u675F"}</span></td>
      <td class="route-step-readonly">${stage.needProcess ? "true" : "false"}</td>
      <td><div class="route-step-actions"><button class="btn icon small" title="\u524D\u79FB" data-action="move-step-up" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" ${stageIndex === 0 ? "disabled" : ""}>\u2191</button><button class="btn icon small" title="\u540E\u79FB" data-action="move-step-down" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" ${stageIndex === route.stages.length - 1 ? "disabled" : ""}>\u2193</button><button class="btn danger icon small" title="\u5220\u9664" data-action="remove-stage" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" ${route.stages.length <= 3 ? "disabled" : ""}>\xD7</button></div></td>
    </tr>`;
  }).join("");
}
function routeProcessProfile(route) {
  normalizeRoute(route);
  return processProfile(route);
}
function generatedRouteName(route) {
  return automaticRouteName(
    routeProcessProfile(route),
    routeCleanSignature(route),
    minimumResidencyConstraint(route)
  );
}
function recordRouteRename(oldName, newName) {
  if (!oldName || oldName === newName) return;
  let extended = false;
  for (const [origin, current] of state.routeNameChanges) {
    if (current === oldName) {
      state.routeNameChanges.set(origin, newName);
      extended = true;
    }
  }
  if (!extended) state.routeNameChanges.set(oldName, newName);
  state.rounds.forEach((round) => round.cjobs.forEach((cjob) => cjob.pjobs.forEach((pjob) => {
    if (pjob.routeRef === oldName) pjob.routeRef = newName;
  })));
}
function synchronizeRouteNames() {
  const occurrences = /* @__PURE__ */ new Map();
  let changed = false;
  state.routes.forEach((route) => {
    const baseName = generatedRouteName(route);
    const occurrence = (occurrences.get(baseName) || 0) + 1;
    occurrences.set(baseName, occurrence);
    const generatedName = occurrence === 1 ? baseName : `${baseName} (${occurrence})`;
    if (route.name !== generatedName) {
      recordRouteRename(route.name, generatedName);
      route.name = generatedName;
      changed = true;
    }
  });
  return changed;
}
function groupedRoutes() {
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  synchronizeRouteNames();
  const processGroups = /* @__PURE__ */ new Map();
  state.routes.forEach((route, routeIndex) => {
    const profile = routeProcessProfile(route);
    const processKey = profile.isReentrant ? profile.key : String(profile.processCount);
    const processGroup = processGroups.get(processKey) || {
      key: processKey,
      processCount: profile.processCount,
      isReentrant: profile.isReentrant,
      label: profile.processLabel,
      routeCount: 0,
      structures: /* @__PURE__ */ new Map()
    };
    const structure = processGroup.structures.get(profile.key) || { ...profile, routes: [] };
    structure.routes.push({ route, routeIndex, profile });
    processGroup.structures.set(profile.key, structure);
    processGroup.routeCount += 1;
    processGroups.set(processKey, processGroup);
    if (state.expandedRoutes.has(routeIndex)) {
      state.expandedRouteProcessGroups.add(processKey);
      state.expandedRouteGroups.add(profile.key);
    }
  });
  return [...processGroups.values()].sort((left, right) => Number(left.isReentrant) - Number(right.isReentrant) || left.processCount - right.processCount).map((processGroup) => ({
    ...processGroup,
    structures: [...processGroup.structures.values()].sort(compareProfiles).map((structure) => ({
      ...structure,
      routes: structure.routes.sort((left, right) => natural(left.route.name || "", right.route.name || ""))
    }))
  }));
}
function renderRouteDetails(route, index) {
  return `<div class="route-details"><div class="edit-card-head"><strong>\u8DEF\u5F84\u8BE6\u60C5</strong><div><button class="btn small" data-action="open-context-clean" data-clean-scope="route" data-route-index="${index}">\uFF0B Clean</button> <button class="btn small" data-action="add-stage" data-index="${index}">\uFF0B Step \u7EC4</button> <button class="btn danger small" data-action="remove-route" data-index="${index}">\u5220\u9664</button></div></div>
    <div class="route-meta"><div class="route-meta-grid"><div class="field"><label>\u8DEF\u5F84\u540D\u79F0\uFF08\u81EA\u52A8\u751F\u6210\uFF09</label><input value="${escapeHtml3(route.name)}" readonly></div><div class="field"><label>Group</label><input data-scope="route" data-index="${index}" data-key="group" value="${escapeHtml3(route.group)}"></div><div class="field"><label>BufferOption</label><input type="number" min="0" max="4" step="1" data-scope="route" data-index="${index}" data-key="bufferOption" value="${Number(route.bufferOption)}"><small class="field-help">\u4EC5\u9650\u5236\u63A5\u53E3\u679A\u4E3E\u8303\u56F4\uFF0C\u6682\u4E0D\u81EA\u52A8\u4FEE\u6539\u8DEF\u5F84\u3002</small></div></div>
    <section class="route-clean-section"><div class="context-clean-head"><div><strong>Route Clean</strong><small>Clean \u4EC5\u4F5C\u7528\u4E8E\u5F39\u7A97\u4E2D\u9009\u62E9\u7684\u8154\u5BA4</small></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="route" data-route-index="${index}">\uFF0B Clean</button></div>${renderContextCleans("route", index)}</section></div>
    <div class="route-table-wrap"><table class="route-table"><thead><tr><th>StepID</th><th>\u7C7B\u578B</th><th>\u53EF\u9009\u8154\u5BA4 / \u673A\u5668\u624B</th><th>PostStepID</th><th>NeedProcess</th><th></th></tr></thead><tbody>${renderSteps(route, index)}</tbody></table></div></div>`;
}
function renderRoutes() {
  const host = document.getElementById("routeList"), processGroups = groupedRoutes();
  host.innerHTML = processGroups.length ? processGroups.map((processGroup) => {
    const processOpen = state.expandedRouteProcessGroups.has(processGroup.key);
    const structures = processGroup.structures.map((structure) => {
      const structureOpen = state.expandedRouteGroups.has(structure.key);
      const routes = structure.routes.map(({ route, routeIndex, profile }) => {
        const routeOpen = state.expandedRoutes.has(routeIndex);
        const processSummary = profile.processCount ? profile.candidatePath.join(" \u2192 ") : "\u65E0\u52A0\u5DE5\u5DE5\u5E8F";
        return `<article class="route-summary-card"><div class="route-summary-head"><button class="route-summary-toggle" data-action="toggle-route" data-route-index="${routeIndex}" aria-expanded="${routeOpen}">
        <div class="route-summary-title"><span class="collapse-arrow ${routeOpen ? "open" : ""}">\u25B6</span><strong>${escapeHtml3(route.name || "\u672A\u547D\u540D\u8DEF\u5F84")}</strong></div><div class="route-summary-meta">${escapeHtml3(processSummary)} \xB7 ${route.stages.length} Steps</div></button>
        <div class="route-summary-actions"><button class="btn small" data-action="open-context-clean" data-clean-scope="route" data-route-index="${routeIndex}">\uFF0B Clean</button><button class="btn small" data-action="edit-route" data-route-index="${routeIndex}">\u7F16\u8F91</button><button class="btn small" data-action="copy-route" data-route-index="${routeIndex}">\u590D\u5236</button><button class="btn danger small" data-action="remove-route" data-index="${routeIndex}">\u5220\u9664</button></div>
      </div>${routeOpen ? renderRouteDetails(route, routeIndex) : ""}</article>`;
      }).join("");
      return processGroup.isReentrant ? routes : `<section class="route-type-group"><button class="route-type-head" data-action="toggle-route-group" data-group-key="${escapeHtml3(structure.key)}" aria-expanded="${structureOpen}"><span class="collapse-arrow ${structureOpen ? "open" : ""}">\u25B6</span><strong>\u5E76\u884C\u673A\u5668\u6570 <span class="route-structure-key">${escapeHtml3(structure.label)}</span></strong><span class="route-count">${structure.routes.length} \u6761\u8DEF\u5F84 \xB7 ${structureOpen ? "\u5DF2\u5C55\u5F00" : "\u5DF2\u6536\u8D77"}</span></button>${structureOpen ? `<div class="route-group-body">${routes}</div>` : ""}</section>`;
    }).join("");
    const groupSummary = processGroup.isReentrant ? `${processGroup.routeCount} \u6761\u8DEF\u5F84` : `${processGroup.routeCount} \u6761\u8DEF\u5F84 \xB7 ${processGroup.structures.length} \u79CD\u5E76\u884C\u7ED3\u6784`;
    return `<section class="route-process-group"><button class="route-process-head" data-action="toggle-route-process-group" data-process-key="${escapeHtml3(processGroup.key)}" aria-expanded="${processOpen}"><span class="collapse-arrow ${processOpen ? "open" : ""}">\u25B6</span><strong>${escapeHtml3(processGroup.label)}</strong><span class="route-count">${groupSummary}</span></button>${processOpen ? `<div class="route-process-body">${structures}</div>` : ""}</section>`;
  }).join("") : `<div class="empty">\u81F3\u5C11\u521B\u5EFA\u4E00\u6761\u8DEF\u5F84\uFF0CJob \u624D\u80FD\u5F15\u7528\u3002</div>`;
}
function renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex) {
  const groups = groupedRoutes().flatMap((processGroup) => processGroup.structures);
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const selectedKey = selectedRoute ? routeProcessProfile(selectedRoute).key : groups[0]?.key || "";
  const selectedGroup = groups.find((group) => group.key === selectedKey);
  const common = `data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}"`;
  const groupOptions = groups.map((group) => `<option value="${escapeHtml3(group.key)}" ${group.key === selectedKey ? "selected" : ""}>${escapeHtml3(group.isReentrant ? group.processLabel : `${group.processLabel} \xB7 ${group.label}`)}</option>`).join("");
  const routeOptions = (selectedGroup?.routes || []).map(({ route }) => `<option value="${escapeHtml3(route.name)}" ${route.name === pjob.routeRef ? "selected" : ""}>${escapeHtml3(route.name)}</option>`).join("");
  return `<div class="pjob-route-picker">
    <select class="pjob-route-process" aria-label="\u8DEF\u5F84\u7C7B\u522B" data-scope="pjob-route-group" ${common}>${groupOptions || `<option value="">\u6682\u65E0\u5DE5\u5E8F</option>`}</select>
    <select class="pjob-route-specific" aria-label="\u5177\u4F53\u8DEF\u5F84" data-scope="pjob" data-key="routeRef" ${common}>${routeOptions ? `<option value="">\u9009\u62E9\u8DEF\u5F84</option>${routeOptions}` : `<option value="">\u8BF7\u5148\u914D\u7F6E\u8DEF\u5F84</option>`}</select>
  </div>`;
}
function renderRounds() {
  normalizeRounds();
  const host = document.getElementById("roundList");
  host.innerHTML = state.rounds.map((round, roundIndex) => {
    const roundTitle = roundIndex ? `\u7B2C ${roundIndex + 1} \u8F6E\u91CD\u7B97` : "\u9996\u6B21\u6392\u7A0B";
    const serialMode = round.cjobs.some((cjob) => ["Pipeline", "Sequential"].includes(cjob.taskMode));
    const cjobs = round.cjobs.map((cjob, cjobIndex) => {
      const normalLot = cjob.jobType === "NormalLot";
      const pjobRows = cjob.pjobs.map((pjob, pjobIndex) => `<tr>
        <td><span class="readonly-pill">${escapeHtml3(pjob.jobName)}</span></td>
        <td><input class="pjob-number" type="number" min="1" max="${state.strategy === "milp" ? 12 : 25}" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="waferCount" value="${Number(pjob.waferCount)}"></td>
        <td>${renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex)}</td>
        <td><input class="pjob-number" type="number" min="1" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="priority" value="${Number(pjob.priority)}"></td>
        <td><button class="btn danger icon small" aria-label="\u5220\u9664 ${escapeHtml3(pjob.jobName)}" data-action="remove-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" ${cjob.pjobs.length <= 1 ? "disabled" : ""}>\xD7</button></td>
      </tr>`).join("");
      return `<section class="cjob-card">
        <header class="cjob-head"><div class="cjob-title"><strong>CJob ${cjobIndex + 1}</strong><span class="readonly-pill">TaskID ${escapeHtml3(cjob.taskId)}</span></div><div class="round-actions"><button class="btn small" data-action="add-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}">\uFF0B PJob</button><button class="btn danger small" data-action="remove-cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" ${round.cjobs.length <= 1 ? "disabled" : ""}>\u5220\u9664 CJob</button></div></header>
        <div class="cjob-controls">
          <div class="field"><label>JobType</label><select data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="jobType">${CJOB_TYPES.map((value) => `<option ${value === cjob.jobType ? "selected" : ""}>${value}</option>`).join("")}</select></div>
          <div class="field ${normalLot ? "" : "disabled-field"}"><label>Priority</label><input type="number" min="1" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="priority" value="${Number(cjob.priority)}" ${normalLot ? "" : "disabled"}></div>
          <div class="field"><label>TaskMode</label><select data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="taskMode">${TASK_MODES.map((value) => `<option ${value === cjob.taskMode ? "selected" : ""} ${round.cjobs.length > 1 && ["Pipeline", "Sequential"].includes(value) ? "disabled" : ""}>${value}</option>`).join("")}</select></div>
          <div class="field"><label>PJobNameList</label><div class="pjob-name-list">${cjob.pJobNameList.map((name) => `<span>${escapeHtml3(name)}</span>`).join("")}</div></div>
        </div>
        <div class="pjob-table-wrap"><table class="pjob-table"><thead><tr><th>JobName</th><th>Material</th><th>OriginRoute</th><th>Priority</th><th></th></tr></thead><tbody>${pjobRows}</tbody></table></div>
      </section>`;
    }).join("");
    const roundTimeBadge = roundIndex ? `<span class="readonly-pill">@ ${Number(round.currentTime)}s</span>` : "";
    const cjobLimitReached = state.loadPorts.length > 0 && round.cjobs.length >= state.loadPorts.length;
    const addCJobDisabled = cjobLimitReached || serialMode;
    const addCJobTitle = serialMode ? "Pipeline/Sequential \u6BCF\u8F6E\u53EA\u80FD\u914D\u7F6E\u4E00\u4E2A CJob" : "\u6BCF\u8F6E CJob \u6570\u4E0D\u80FD\u8D85\u8FC7 LoadPort \u6570";
    return `<section class="round-card"><header class="round-head"><div class="round-title"><div class="round-number">${roundIndex + 1}</div><div><strong>${roundTitle}</strong>${roundTimeBadge}</div></div><div class="round-time-editor field"><label>${roundIndex ? "\u91CD\u7B97\u65F6\u95F4" : "\u6392\u7A0B\u65F6\u95F4"}</label><div><input type="number" min="0" step="0.1" data-round-time-index="${roundIndex}" value="${Number(round.currentTime)}" ${roundIndex ? "" : "disabled"}><span>s</span></div></div><button class="btn small" data-action="add-cjob" data-round-index="${roundIndex}" ${addCJobDisabled ? `disabled title="${addCJobTitle}"` : ""}>\uFF0B CJob</button></header><div class="cjob-list">${cjobs}</div></section>`;
  }).join("");
  initializeCompactSelects();
}
function renderStepNumberField(label, key, value, routeIndex, stageIndex, options = {}) {
  const inputId = `step-${routeIndex}-${stageIndex}-${key}`;
  const helper = options.helper ? `<small class="field-help">${escapeHtml3(options.helper)}</small>` : "";
  const minimum = options.minimum === void 0 ? "" : ` min="${options.minimum}"`;
  return `<div class="step-edit-field">
    <label for="${inputId}">${escapeHtml3(label)}</label>
    <div class="step-number-control">
      <input id="${inputId}" type="number" inputmode="decimal" step="${options.step || "0.1"}"${minimum} data-scope="visit-shared" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-key="${key}" value="${escapeHtml3(value)}">
      <span aria-hidden="true">s</span>
    </div>
    ${helper}
  </div>`;
}
function renderStepCleanEditor(routeIndex, stageIndex) {
  return `<section class="step-clean-section">
    <div class="context-clean-head"><div><strong>RouteStep Clean</strong><small>\u8FDB\u5165\u6216\u79BB\u5F00\u8154\u5BA4\u65F6\u6267\u884C</small></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="step" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\uFF0B Clean</button></div>
    ${renderContextCleans("step", routeIndex, stageIndex)}
  </section>`;
}
function renderStepDrawer() {
  if (!state.drawer) return;
  const { routeIndex, stageIndex } = state.drawer, route = state.routes[routeIndex], stage = route?.stages[stageIndex];
  if (!stage) {
    closeStepDrawer();
    return;
  }
  normalizeRoute(route);
  document.getElementById("drawerTitle").textContent = `Step ${stage.stepId} \u914D\u7F6E`;
  document.getElementById("drawerSubtitle").textContent = `${stepKind(route, stageIndex)} \xB7 ${stage.visits.length} \u4E2A\u5019\u9009`;
  const first = stage.visits[0] ? normalizeVisit(stage.visits[0]) : null;
  const editableFieldLabels = { processTime: "Process Time", qTimeLimit: "QTime", residencyConstraint: "Residency", beforeCleanRefs: "Clean", afterCleanRefs: "Clean" };
  const differences = visitDifferenceFields(stage).filter((field) => editableFieldLabels[field]);
  const candidates = [...new Set(stage.visits.map((visit) => visit.stationName).filter(Boolean))];
  const differenceNames = differences.map((field) => editableFieldLabels[field] || field);
  const warning = differences.length ? `<div class="visit-warning" role="status"><strong>\u5019\u9009\u8154\u5BA4\u7684\u53EF\u7F16\u8F91\u53C2\u6570\u4E0D\u4E00\u81F4</strong><p>\u5DEE\u5F02\u9879\uFF1A${differenceNames.map(escapeHtml3).join("\u3001")}\u3002\u5F53\u524D\u663E\u793A\u9996\u4E2A\u5019\u9009\u7684\u503C\u3002</p><button class="btn small" data-action="sync-stage-visits" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u540C\u6B65\u5230\u5168\u90E8\u5019\u9009</button></div>` : "";
  const editor = first ? `<section class="step-editor-card" aria-labelledby="stepEditorHeading">
    <header class="step-editor-head"><div><h3 id="stepEditorHeading">\u53EF\u7F16\u8F91\u53C2\u6570</h3><p>\u4FEE\u6539\u540E\u81EA\u52A8\u540C\u6B65\u5230 ${stage.visits.length} \u4E2A\u5019\u9009\u8154\u5BA4</p></div><span class="editable-badge">3 \u9879</span></header>
    <div class="step-edit-grid">
      ${renderStepNumberField("Process Time", "processTime", first.processTime, routeIndex, stageIndex, { minimum: 0, helper: "Recipe Time \u5C06\u81EA\u52A8\u4FDD\u6301\u4E00\u81F4" })}
      ${renderStepNumberField("QTime", "qTimeLimit", first.qTimeLimit, routeIndex, stageIndex)}
      ${renderStepNumberField("Residency", "residencyConstraint", first.residencyConstraint, routeIndex, stageIndex)}
    </div>
  </section>${renderStepCleanEditor(routeIndex, stageIndex)}
  <details class="step-system-details">
    <summary><span><strong>\u7CFB\u7EDF\u53C2\u6570</strong><small>\u7531\u8DEF\u5F84\u6216\u7CFB\u7EDF\u7EF4\u62A4\uFF0C\u4EC5\u4F9B\u67E5\u770B</small></span><span class="details-chevron" aria-hidden="true">\u2304</span></summary>
    <div class="step-system-grid">
      ${renderReadonlyField("Recipe Time", first.processTime)}
      ${renderReadonlyField("Process Recipe", first.processRecipe)}
      ${renderReadonlyField("Process Type", first.processType)}
      ${renderReadonlyField("Slot IDs", first.slotIds)}
      ${renderReadonlyField("Weight", first.weight)}
      ${renderReadonlyField("Move Time Offset", first.moveTimeOffset, true)}
    </div>
  </details>` : `<div class="empty">\u672A\u9009\u62E9\u5019\u9009\u8BBE\u5907\uFF0C\u8BF7\u5148\u5728\u8DEF\u5F84\u5217\u8868\u4E2D\u9009\u62E9\u3002</div>`;
  const routeName = escapeHtml3(route.name || "\u672A\u547D\u540D\u8DEF\u5F84");
  document.getElementById("drawerBody").innerHTML = `<section class="step-overview-card">
    <div class="step-route-context"><span>\u6240\u5C5E\u8DEF\u5F84</span><strong title="${routeName}">${routeName}</strong></div>
    <dl class="step-meta-list">
      <div><dt>Step</dt><dd>#${stage.stepId}</dd></div>
      <div><dt>Next</dt><dd>${stage.postStepIds?.length ? stage.postStepIds.map((id) => `#${id}`).join(", ") : "End"}</dd></div>
      <div><dt>Processing</dt><dd>${stage.needProcess ? "Yes" : "No"}</dd></div>
      <div><dt>Candidates</dt><dd>${stage.visits.length}</dd></div>
    </dl>
    <div class="step-candidates"><span>\u5019\u9009\u8154\u5BA4</span><div class="candidate-chip-list">${candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml3(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u672A\u9009\u62E9</span>`}</div></div>
  </section>${warning}${editor}`;
}
function openStepDrawer(routeIndex, stageIndex) {
  const profile = routeProcessProfile(state.routes[routeIndex]);
  state.drawer = { routeIndex, stageIndex };
  state.expandedRoutes.add(routeIndex);
  state.expandedRouteProcessGroups.add(String(profile.processCount));
  state.expandedRouteGroups.add(profile.key);
  renderRoutes();
  renderStepDrawer();
  document.getElementById("drawerLayer").classList.add("open");
}
function closeStepDrawer() {
  state.drawer = null;
  document.getElementById("drawerLayer").classList.remove("open");
}
function renderRobotSlots() {
  const container = document.getElementById("robotSlotList");
  const summary = document.getElementById("robotSlotSummary");
  if (!state.baseDevice || !state.robotNames.length) {
    summary.textContent = state.baseDevice ? "\u8BBE\u5907\u672A\u58F0\u660E\u673A\u5668\u624B" : "\u8BF7\u5148\u9009\u62E9\u8BBE\u5907";
    container.innerHTML = `<div class="robot-slot-empty"><span>${state.baseDevice ? "\u5F53\u524D\u8BBE\u5907\u6CA1\u6709\u53EF\u914D\u7F6E\u7684\u673A\u5668\u624B\u3002" : "\u9009\u62E9\u6216\u5BFC\u5165\u8BBE\u5907\u540E\uFF0C\u53EF\u5728\u8FD9\u91CC\u5207\u6362\u673A\u5668\u624B\u7684\u5355\u81C2\u4E0E\u53CC\u81C2\u6A21\u5F0F\u3002"}</span></div>`;
    return;
  }
  const dualArmCount = state.robotNames.filter((name) => (state.robotSlots[name] || []).length >= DUAL_ARM_SLOT_COUNT).length;
  summary.textContent = `${state.robotNames.length} \u53F0\u673A\u5668\u624B \xB7 ${dualArmCount} \u53F0\u53CC\u81C2`;
  container.innerHTML = state.robotNames.map((robotName) => {
    const robot = state.baseDevice.Robots[robotName] || {};
    const available = robotAvailableSlots(robot);
    const selected = state.robotSlots[robotName] || available;
    const defaults = robotDefaultSlots(robot);
    const isDualArm = selected.length >= DUAL_ARM_SLOT_COUNT;
    const supportsDualArm = available.length >= DUAL_ARM_SLOT_COUNT;
    const isDefault = JSON.stringify(selected) === JSON.stringify(defaults);
    const isSaving = state.robotSlotsSaving.has(robotName);
    const accessibleStationCount = new Set(
      Object.values(robot.ArmInfo || {}).flatMap((arm) => arm?.AccessibleStations || [])
    ).size;
    const tokens = available.map((slotId) => `
      <span class="robot-slot-token ${selected.includes(slotId) ? "is-active" : ""}">
        Slot ${slotId}
      </span>
    `).join("");
    return `
      <article class="robot-slot-card" data-robot-slot-card="${escapeHtml3(robotName)}">
        <header class="robot-slot-card-head">
          <div class="robot-slot-card-title">
            <span class="robot-slot-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 18v3m8-3v3"/></svg>
            </span>
            <div>
              <h3>${escapeHtml3(robotName)}</h3>
              <p>${escapeHtml3(robot.Type || "Robot")} \xB7 \u53EF\u8FBE ${accessibleStationCount} \u4E2A\u7AD9\u70B9</p>
            </div>
          </div>
          <span class="robot-slot-mode">${isSaving ? "\u4FDD\u5B58\u4E2D\u2026" : isDualArm ? "\u53CC\u81C2" : "\u5355\u81C2"}</span>
        </header>
        <div class="robot-slot-visual" aria-label="${escapeHtml3(robotName)} \u53EF\u7528\u69FD\u4F4D">${tokens}</div>
        <div class="robot-slot-controls" role="group" aria-label="${escapeHtml3(robotName)} \u5DE5\u4F5C\u6A21\u5F0F">
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml3(robotName)}" data-robot-slot-count="1" aria-pressed="${String(!isDualArm)}" ${isSaving ? "disabled" : ""}>\u5355\u81C2</button>
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml3(robotName)}" data-robot-slot-count="2" aria-pressed="${String(isDualArm)}" ${!supportsDualArm || isSaving ? "disabled" : ""}>\u53CC\u81C2</button>
          <button class="robot-slot-choice robot-slot-default" type="button" data-robot-slot-default="${escapeHtml3(robotName)}" ${isDefault || isSaving ? "disabled" : ""}>\u6062\u590D\u9ED8\u8BA4</button>
        </div>
        <p class="robot-slot-card-note">${supportsDualArm ? "\u5207\u6362\u540E\u7ACB\u5373\u4FDD\u5B58\uFF0C\u5E76\u7528\u4E8E\u8BE5\u8BBE\u5907\u4E0B\u7684\u6240\u6709\u6D4B\u8BD5\u3002" : "\u8BBE\u5907\u6587\u4EF6\u4EC5\u58F0\u660E\u4E00\u4E2A\u53EF\u7528\u69FD\u4F4D\uFF0C\u5F53\u524D\u53EA\u80FD\u4F7F\u7528\u5355\u81C2\u3002"}</p>
      </article>
    `;
  }).join("");
}
async function setRobotSlotCount(robotName, slotCount) {
  if (!state.workspaceDeviceId || !state.baseDevice?.Robots?.[robotName]) return;
  const available = robotAvailableSlots(state.baseDevice.Robots[robotName]);
  const boundedCount = Math.max(1, Math.min(Number(slotCount) || 1, DUAL_ARM_SLOT_COUNT, available.length));
  const previousSelections = structuredClone(state.robotSlots);
  const nextSelections = { ...state.robotSlots, [robotName]: available.slice(0, boundedCount) };
  if (JSON.stringify(previousSelections[robotName]) === JSON.stringify(nextSelections[robotName])) return;
  state.robotSlotsSaving.add(robotName);
  applyDeviceTopology(state.baseDevice, state.deviceName, nextSelections);
  renderRobotSlots();
  try {
    const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/robot-slots`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotSlots: nextSelections })
    });
    state.workspaceDevice.robotSlots = structuredClone(result.robotSlots);
    applyDeviceTopology(state.baseDevice, state.deviceName, result.robotSlots);
    resetRunResult();
    setWorkspaceStatus(`\u5DF2\u4FDD\u5B58 ${robotName} \u7684${boundedCount >= DUAL_ARM_SLOT_COUNT ? "\u53CC\u81C2" : "\u5355\u81C2"}\u914D\u7F6E`, "saved");
  } catch (error) {
    applyDeviceTopology(state.baseDevice, state.deviceName, previousSelections);
    setWorkspaceStatus(`\u673A\u5668\u624B\u69FD\u4F4D\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty");
    throw error;
  } finally {
    state.robotSlotsSaving.delete(robotName);
    renderRobotSlots();
  }
}
async function restoreRobotSlotDefault(robotName) {
  const robot = state.baseDevice?.Robots?.[robotName];
  if (!robot) return;
  const defaults = robotDefaultSlots(robot);
  await setRobotSlotCount(robotName, defaults.length);
  setWorkspaceStatus(`\u5DF2\u6062\u590D ${robotName} \u7684\u8BBE\u5907\u6587\u4EF6\u9ED8\u8BA4\u914D\u7F6E`, "saved");
}
function renderAll() {
  renderTimes();
  renderRoutes();
  renderRounds();
  renderRobotSlots();
  if (state.drawer) renderStepDrawer();
}
function updateStateFromControl(control) {
  let value = control.multiple ? Array.from(control.selectedOptions, (item) => item.value) : control.type === "checkbox" ? control.checked : control.type === "number" ? Number(control.value) : control.value;
  const key = control.dataset.key;
  markTestDirty();
  if (control.dataset.timeIndex !== void 0) {
    state.times[Number(control.dataset.timeIndex)] = value;
    return;
  }
  if (control.dataset.roundTimeIndex !== void 0) {
    const roundIndex = Number(control.dataset.roundTimeIndex);
    state.rounds[roundIndex].currentTime = roundIndex ? Math.max(0, value) : 0;
    state.times[roundIndex] = state.rounds[roundIndex].currentTime;
    return;
  }
  if (control.dataset.option) {
    if (["residencyGuardSeconds", "maximumRobotHoldingSeconds", "maximumSystemResidenceCv"].includes(control.dataset.option)) {
      value = Number.isFinite(value) ? Math.max(0, value) : 0;
      control.value = value;
    }
    state.options[control.dataset.option] = value;
    return;
  }
  const scope = control.dataset.scope;
  if (scope === "route") state.routes[Number(control.dataset.index)][key] = ROUTE_CLEAN_KEYS.includes(key) ? value ? [value] : [] : value;
  if (scope === "stage-candidates") setStageCandidates(Number(control.dataset.routeIndex), Number(control.dataset.stageIndex), Array.from(control.selectedOptions, (item) => item.value));
  if (scope === "stage-candidate-toggle") {
    const routeIndex = Number(control.dataset.routeIndex), stageIndex = Number(control.dataset.stageIndex);
    const current = new Set(state.routes[routeIndex].stages[stageIndex].visits.map((visit) => visit.stationName));
    if (control.checked) current.add(control.dataset.candidate);
    else current.delete(control.dataset.candidate);
    setStageCandidates(routeIndex, stageIndex, [...current]);
  }
  if (scope === "visit") {
    const stage = state.routes[Number(control.dataset.routeIndex)].stages[Number(control.dataset.stageIndex)];
    stage.visits[Number(control.dataset.visitIndex)][key] = value;
    if (key === "processTime") stage.visits[Number(control.dataset.visitIndex)].recipeTime = value;
  }
  if (scope === "visit-shared") {
    const stage = state.routes[Number(control.dataset.routeIndex)].stages[Number(control.dataset.stageIndex)];
    if (!stage.visits.length) return;
    stage.visits[0][key] = structuredClone(value);
    if (key === "processTime") stage.visits[0].recipeTime = Number(value);
    synchronizeStageVisits(stage);
  }
  if (scope === "cjob") {
    const round = state.rounds[Number(control.dataset.roundIndex)];
    const cjob = round.cjobs[Number(control.dataset.cjobIndex)];
    if (key === "taskMode" && ["Pipeline", "Sequential"].includes(String(value)) && round.cjobs.length > 1) {
      control.value = cjob.taskMode;
      return;
    }
    cjob[key] = value;
    if (key === "jobType") cjob.priority = value === "NormalLot" ? cjob.priority > 0 ? cjob.priority : 1 : -1;
    normalizeRounds();
  }
  if (scope === "pjob-route-group") {
    const pjob = state.rounds[Number(control.dataset.roundIndex)].cjobs[Number(control.dataset.cjobIndex)].pjobs[Number(control.dataset.pjobIndex)];
    const route = state.routes.find((item) => routeProcessProfile(item).key === String(value));
    pjob.routeRef = route?.name || "";
    normalizeRounds();
    return;
  }
  if (scope === "pjob") {
    const pjob = state.rounds[Number(control.dataset.roundIndex)].cjobs[Number(control.dataset.cjobIndex)].pjobs[Number(control.dataset.pjobIndex)];
    pjob[key] = value;
    normalizeRounds();
  }
}
function handleAction(button) {
  const action = button.dataset.action, index = Number(button.dataset.index), routeIndex = Number(button.dataset.routeIndex), stageIndex = Number(button.dataset.stageIndex), visitIndex = Number(button.dataset.visitIndex);
  if (action === "open-context-clean" || action === "edit-context-clean") {
    openCleanDialog(
      button.dataset.cleanScope,
      routeIndex,
      Number.isFinite(stageIndex) ? stageIndex : -1,
      action === "edit-context-clean" ? button.dataset.cleanName || "" : "",
      button.dataset.placement || ""
    );
    return;
  }
  if (action === "remove-context-clean") {
    removeContextClean(
      button.dataset.cleanScope,
      routeIndex,
      Number.isFinite(stageIndex) ? stageIndex : -1,
      button.dataset.placement,
      button.dataset.cleanName
    );
    return;
  }
  if (action === "delete-clean-binding") {
    const context = state.cleanDialogContext;
    if (context?.cleanName) {
      removeContextClean(
        context.scope,
        context.routeIndex,
        context.stageIndex,
        context.originalPlacement,
        context.cleanName
      );
    }
    document.getElementById("cleanDialog").close();
    state.cleanDialogContext = null;
    return;
  }
  if (action === "toggle-route-group") {
    const key = button.dataset.groupKey;
    if (state.expandedRouteGroups.has(key)) state.expandedRouteGroups.delete(key);
    else state.expandedRouteGroups.add(key);
    renderRoutes();
    return;
  }
  if (action === "toggle-route-process-group") {
    const key = button.dataset.processKey;
    if (state.expandedRouteProcessGroups.has(key)) state.expandedRouteProcessGroups.delete(key);
    else state.expandedRouteProcessGroups.add(key);
    renderRoutes();
    return;
  }
  if (action === "toggle-route" || action === "edit-route") {
    if (action === "toggle-route" && state.expandedRoutes.has(routeIndex)) state.expandedRoutes.delete(routeIndex);
    else state.expandedRoutes.add(routeIndex);
    const profile = routeProcessProfile(state.routes[routeIndex]);
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    renderRoutes();
    return;
  }
  if (action === "sync-stage-visits") {
    synchronizeStageVisits(state.routes[routeIndex].stages[stageIndex]);
    markTestDirty();
    renderStepDrawer();
    return;
  }
  if (action === "add-route") {
    const name = `Route${state.routes.length + 1}`, route = { name, group: name, bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: state.device ? defaultRouteStages(name) : linkRouteSteps([makeStage(""), makeStage(""), makeStage("", true, `${name}_Step2`), makeStage(""), makeStage("")]) };
    state.routes.push(route);
    const newIndex = state.routes.length - 1, profile = routeProcessProfile(route);
    state.expandedRoutes.add(newIndex);
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
  }
  if (action === "copy-route") {
    const source = state.routes[routeIndex], base = `${source.name || "Route"} \u526F\u672C`, occupied = new Set(state.routes.map((route) => route.name));
    let name = base, suffix = 2;
    while (occupied.has(name)) name = `${base} (${suffix++})`;
    const copy = structuredClone(source);
    copy.name = name;
    state.routes.push(copy);
    const newIndex = state.routes.length - 1, profile = routeProcessProfile(copy);
    state.expandedRoutes.add(newIndex);
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
  }
  if (action === "remove-route") {
    state.routes.splice(index, 1);
    state.expandedRoutes.clear();
    state.expandedRouteProcessGroups.clear();
    state.expandedRouteGroups.clear();
    if (state.drawer?.routeIndex === index) closeStepDrawer();
  }
  if (action === "add-stage") {
    state.routes[index].stages.splice(-1, 0, makeStage(""), makeStage(""));
    linkRouteSteps(state.routes[index].stages);
  }
  if (action === "remove-stage") {
    state.routes[routeIndex].stages.splice(stageIndex, 1);
    linkRouteSteps(state.routes[routeIndex].stages);
    closeStepDrawer();
  }
  if (action === "move-step-up" && stageIndex > 0) {
    [state.routes[routeIndex].stages[stageIndex - 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex - 1]];
    linkRouteSteps(state.routes[routeIndex].stages);
  }
  if (action === "move-step-down" && stageIndex < state.routes[routeIndex].stages.length - 1) {
    [state.routes[routeIndex].stages[stageIndex + 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex + 1]];
    linkRouteSteps(state.routes[routeIndex].stages);
  }
  if (action === "add-cjob") {
    const roundIndex = Number(button.dataset.roundIndex), round = state.rounds[roundIndex];
    if (round.cjobs.some((cjob2) => ["Pipeline", "Sequential"].includes(cjob2.taskMode))) return;
    if (state.loadPorts.length && round.cjobs.length >= state.loadPorts.length) return;
    const cjob = makeCJob(roundIndex + 1, [], state.routes[0]?.name || "", state.loadPorts[round.cjobs.length] || state.loadPorts[0] || "");
    cjob.key = `C${round.cjobs.length + 1}`;
    round.cjobs.push(cjob);
  }
  if (action === "remove-cjob") state.rounds[Number(button.dataset.roundIndex)].cjobs.splice(Number(button.dataset.cjobIndex), 1);
  if (action === "add-pjob") {
    const roundIndex = Number(button.dataset.roundIndex), cjob = state.rounds[roundIndex].cjobs[Number(button.dataset.cjobIndex)];
    cjob.pjobs.push(makePJob(cjob.pjobs.length + 1, state.routes[0]?.name || "", cjob.loadPort || state.loadPorts[0] || "", 5));
  }
  if (action === "remove-pjob") state.rounds[Number(button.dataset.roundIndex)].cjobs[Number(button.dataset.cjobIndex)].pjobs.splice(Number(button.dataset.pjobIndex), 1);
  normalizeRounds();
  markTestDirty();
  renderAll();
}
function collectRecipes(routes = state.routes) {
  const recipes = [];
  const cleanByName = new Map(state.cleans.map(runtimeClean).map((clean) => [clean.name, clean]));
  function standardProcessWeight(visit) {
    const rawWeight = visit.weight ?? "{}";
    let weight;
    try {
      weight = typeof rawWeight === "string" ? JSON.parse(rawWeight || "{}") : structuredClone(rawWeight || {});
    } catch (_error) {
      return rawWeight;
    }
    if (!weight || typeof weight !== "object" || Array.isArray(weight)) return rawWeight;
    [...stringList(visit.beforeCleanRefs), ...stringList(visit.afterCleanRefs)].forEach((cleanName) => {
      const clean = cleanByName.get(cleanName);
      if (!stringList(clean?.modules).includes(visit.stationName)) return;
      const stateVariable = String(clean?.stateVariable || "").trim();
      if (stateVariable && stateVariable !== "IdleTime" && weight[stateVariable] === void 0) {
        weight[stateVariable] = 1;
      }
    });
    return JSON.stringify(weight);
  }
  function add(name, time, modules, processType = "", weightText = "{}") {
    const weight = typeof weightText === "string" ? weightText : JSON.stringify(weightText ?? {}), moduleList = stringList(modules);
    const existing = recipes.find((recipe) => recipe.name === name && Number(recipe.time) === Number(time) && recipe.processType === processType && recipe.weight === weight);
    if (existing) {
      existing.modules = [.../* @__PURE__ */ new Set([...existing.modules, ...moduleList])];
    } else recipes.push({ name, time: Number(time), modules: moduleList, processType, weight });
  }
  routes.forEach((route) => {
    normalizeRoute(route);
    route.stages.forEach((stage) => stage.visits.forEach((visit) => {
      if (visit.processRecipe) add(visit.processRecipe, visit.processTime, [visit.stationName], visit.processType, standardProcessWeight(visit));
    }));
  });
  state.cleans.map(runtimeClean).forEach((clean) => {
    add(clean.recipeRef, clean.recipeTime, clean.modules);
    if (clean.cleanType === "dummywac") add(clean.emptyRecipeRef, clean.wacRecipeTime, clean.modules);
  });
  return recipes;
}
function stationSlotList(stationName) {
  const station = state.device?.Stations?.[stationName];
  if (!station) return [1];
  if (Array.isArray(station.Slots) && station.Slots.length) return station.Slots.map(Number);
  const capacity = Number(station.Capacity) || 0;
  return capacity >= 1 ? Array.from({ length: capacity }, (_, index) => index + 1) : [1];
}
function expandVisitSlotIds() {
  if (!state.device) return;
  for (const route of state.routes) {
    for (const stage of route.stages || []) {
      for (const visit of stage.visits || []) {
        const stationName = String(visit.stationName || "").trim();
        if (!stationName) continue;
        const slots = stationSlotList(stationName);
        visit.slotIds = slots.join(",");
      }
    }
  }
}
function buildPayload() {
  normalizeRounds();
  expandVisitSlotIds();
  const routes = selectReferencedRoutes2(state.routes, state.rounds).map((route) => ({ ...normalizeRoute(route), stages: route.stages.map((stage) => ({ ...stage, visits: stage.visits.map((visit) => structuredClone(visit)) })) }));
  const cleans = state.cleans.map(runtimeClean);
  return { schemaVersion: EXPECTED_API_SCHEMA, workspaceDeviceId: state.workspaceDeviceId, workspaceTestId: state.testCaseId, deviceName: state.deviceName, device: state.device, strategy: state.strategy, roundCount: state.roundCount, options: state.options, recipes: collectRecipes(routes), cleans, routes, rounds: structuredClone(state.rounds) };
}
function configuredWaferCount() {
  return state.rounds.reduce((roundTotal, round) => roundTotal + round.cjobs.reduce(
    (cjobTotal, cjob) => cjobTotal + cjob.pjobs.reduce(
      (pjobTotal, pjob) => pjobTotal + Number(pjob.waferCount || 0),
      0
    ),
    0
  ), 0);
}
function renderOtherAlgorithmOptions(algorithms) {
  state.availableOtherAlgorithms = Array.isArray(algorithms) ? algorithms : [];
  const container = document.getElementById("otherAlgorithmOptions");
  container.innerHTML = state.availableOtherAlgorithms.map((algorithm) => `
    <label class="strategy-card" data-strategy-card="${escapeHtml3(algorithm.strategy)}">
      <input type="radio" name="strategy" value="${escapeHtml3(algorithm.strategy)}" ${algorithm.strategy === state.strategy ? "checked" : ""}>
      <b>${escapeHtml3(algorithm.name)}</b>
    </label>
  `).join("");
  renderAlgorithmMetadata();
}
function showAlgorithmDetails(strategy) {
  const metadata = state.algorithmMetadata[strategy] || {};
  const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(strategy)}"] b`)?.textContent;
  document.getElementById("algorithmHoverInfo").innerHTML = `
    <span class="algorithm-hover-info-name">${escapeHtml3(metadata.name || cardName || strategy)}<small>\u7B97\u6CD5\u7B80\u4ECB</small></span>
    <span class="algorithm-hover-info-description">${escapeHtml3(metadata.introduction || "\u6682\u65E0\u7B97\u6CD5\u7B80\u4ECB")}</span>
  `;
}
function displayStrategyName(strategy) {
  const normalized = String(strategy || "heuristic");
  const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(normalized)}"] b`)?.textContent;
  return state.algorithmMetadata[normalized]?.name || cardName || normalized;
}
function batchParameterSummary(options, strategy) {
  const values = options && typeof options === "object" ? options : {};
  const normalizedStrategy = String(strategy || "heuristic");
  const definitions = [
    ["loadLockManager", "LoadLock", "", []],
    ["residencyGuardSeconds", "\u9A7B\u7559\u4F59\u91CF", "s", []],
    ["maximumRobotHoldingSeconds", "\u6301\u7247\u4E0A\u9650", "s", []],
    ["maximumSystemResidenceCv", "\u505C\u7559 CV", "", []],
    ["seed", "\u968F\u673A\u79CD\u5B50", "", []],
    ["loadLockMacroSearchSeconds", "\u5B8F\u641C\u7D22", "s", ["loadlock-macro"]],
    ["loadLockMacroRollouts", "\u5B8F\u91C7\u6837", "", ["loadlock-macro"]],
    ["nnSAEASearchSeconds", "SAEA \u641C\u7D22", "s", ["nn-saea"]],
    ["nnSAEARollouts", "SAEA \u91C7\u6837", "", ["nn-saea"]],
    ["neuralUCBTopK", "UCB Top-K", "", ["neuralucb"]],
    ["neuralUCBExploration", "UCB \u63A2\u7D22", "", ["neuralucb"]],
    ["rlSearchSeconds", "RL \u641C\u7D22", "s", ["rl"]],
    ["rlRollouts", "RL \u91C7\u6837", "", ["rl"]],
    ["rlTemperature", "RL \u6E29\u5EA6", "", ["rl"]],
    ["milpTimeLimit", "MILP \u65F6\u9650", "s", ["milp"]]
  ];
  const labels = definitions.flatMap(([key, label, suffix, strategies]) => strategies.length && !strategies.includes(normalizedStrategy) ? [] : values[key] === void 0 || values[key] === null || values[key] === "" ? [] : [`${label} ${values[key]}${suffix}`]);
  return labels.length ? labels.join(" \xB7 ") : "\u9ED8\u8BA4\u53C2\u6570";
}
function renderAlgorithmMetadata() {
  document.querySelectorAll("[data-strategy-card]").forEach((card) => {
    const strategy = card.dataset.strategyCard;
    card.onmouseenter = () => showAlgorithmDetails(strategy);
    card.onfocusin = () => showAlgorithmDetails(strategy);
  });
  const strategyOptions = document.querySelector(".strategy-options");
  strategyOptions.onmouseleave = () => showAlgorithmDetails(state.strategy);
  strategyOptions.onfocusout = (event) => {
    if (!strategyOptions.contains(event.relatedTarget)) showAlgorithmDetails(state.strategy);
  };
  showAlgorithmDetails(state.strategy);
}
function prepareLogDownload(result) {
  if (!result?.logUrl) return false;
  const link = document.getElementById("logButton");
  link.href = result.logUrl;
  link.download = result.logFileName || "ct-input-log.json";
  link.removeAttribute("aria-disabled");
  if (document.getElementById("autoExportLog").checked) {
    const automatic = document.createElement("a");
    automatic.href = link.href;
    automatic.download = link.download;
    automatic.hidden = true;
    document.body.appendChild(automatic);
    automatic.click();
    automatic.remove();
  }
  return true;
}
function prepareGanttView(result) {
  if (!result?.ganttUrl) return false;
  const link = document.getElementById("ganttButton");
  link.href = result.ganttUrl;
  link.removeAttribute("aria-disabled");
  return true;
}
async function prepareWorkspaceView(result) {
  if (!result?.resultId) return null;
  visualizationWorkspace.setAnalysisConfiguration(state.routes, state.rounds);
  visualizationWorkspace.setReplayPlan(buildPayload());
  await visualizationWorkspace.loadResult(result.resultId, state.testCaseName || "\u5F53\u524D\u8FD0\u884C\u7ED3\u679C");
  return visualizationWorkspace.getBottleneckUtilization();
}
async function runPlan() {
  const button = document.getElementById("runButton");
  const batchButton = document.getElementById("batchRunButton");
  const comparisonButton = document.getElementById("openParameterComparisonDialogButton");
  let logReady = false, ganttReady = false, runResult = null, bottleneckSummary = null;
  try {
    const healthResponse = await fetch("/api/health", { cache: "no-store" }), health = await healthResponse.json();
    if (!healthResponse.ok || health.schemaVersion !== EXPECTED_API_SCHEMA) throw new Error("\u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\uFF0C\u8BF7\u91CD\u542F scripts/config_editor_server.py");
    if (state.strategy.startsWith("other_alg:")) {
      const algorithm = (health.otherAlgorithms || []).find((item) => item.strategy === state.strategy);
      if (!algorithm?.available) throw new Error(`${state.strategy} \u7B97\u6CD5\u5305\u4E0D\u5B58\u5728\u6216\u5165\u53E3\u4E0D\u5B8C\u6574`);
    } else if (health.strategies?.[state.strategy] === false) {
      throw new Error(health.strategyErrors?.[state.strategy] || `${state.strategy} \u7B56\u7565\u5F53\u524D\u4E0D\u53EF\u7528`);
    }
    if (state.strategy === "milp" && state.roundCount !== 1) throw new Error("MILP \u7B56\u7565\u53EA\u80FD\u8FD0\u884C\u9996\u6B21\u6392\u7A0B\uFF0C\u4E0D\u80FD\u9009\u62E9\u591A\u6B21\u91CD\u7B97");
    if (state.strategy === "milp" && configuredWaferCount() > 12) throw new Error(`MILP \u7B56\u7565\u603B\u6676\u5706\u6570\u91CF\u4E0D\u80FD\u8D85\u8FC7 12 \u7247\uFF0C\u5F53\u524D\u4E3A ${configuredWaferCount()} \u7247`);
    if (state.testCaseId) await saveCurrentTest(true);
    const payload = buildPayload();
    button.disabled = true;
    batchButton.disabled = true;
    comparisonButton.disabled = true;
    button.classList.add("running");
    button.textContent = "\u6B63\u5728\u8FD0\u884C\u7B56\u7565\u2026";
    resetRunResult();
    writeTerminal(`$ \u5F00\u59CB\u8FD0\u884C ${state.strategy}
  \u603B\u8F6E\u6570: ${state.roundCount}
  \u91CD\u7B97\u65F6\u95F4: ${state.rounds.map((round) => round.currentTime).join(", ")} s`);
    const response = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const responseText = await response.text();
    try {
      runResult = JSON.parse(responseText);
    } catch {
      throw new Error(responseText.trim().slice(0, 240) || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    }
    logReady = prepareLogDownload(runResult);
    ganttReady = prepareGanttView(runResult);
    if (runResult?.resultId) {
      try {
        bottleneckSummary = await prepareWorkspaceView(runResult);
        runResult.bottleneckUtilization = bottleneckSummary;
      } catch (workspaceError) {
        writeTerminal(`$ \u5DE5\u4F5C\u53F0\u52A0\u8F7D\u5931\u8D25
  ${workspaceError.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
      }
    }
    if (!response.ok || !runResult.ok) {
      if (runResult?.metricsAvailable) showFailedResultMetrics(runResult);
      throw new Error(runResult.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    }
    showResult(runResult);
  } catch (error) {
    const baselineError = runResult?.baseline?.status === "failed" ? `
  Baseline \u5931\u8D25\uFF1A${runResult.baseline.error || "\u672A\u77E5\u539F\u56E0"}` : "";
    const validationIssues = Array.isArray(runResult?.validationIssues) ? runResult.validationIssues.map((issue) => `  ${issue}`) : [];
    if (!runResult?.metricsAvailable && ganttReady) {
      setBottleneckMetric(bottleneckSummary, "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8");
      document.getElementById("metricMakespan").textContent = Number.isFinite(Number(runResult.makespan)) ? `${Number(runResult.makespan).toFixed(2)} s` : "\u2014";
    }
    writeTerminal([
      `$ \u8FD0\u884C\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`,
      ...validationIssues,
      ...baselineError ? [baselineError.trim()] : [],
      ...ganttReady ? ["  \u5931\u8D25 MoveList \u5DF2\u4FDD\u7559\uFF0C\u53EF\u70B9\u51FB\u201C\u6253\u5F00\u7518\u7279\u56FE\u201D\u67E5\u770B\u7EA2\u8272\u95EE\u9898 Move"] : [],
      ...logReady ? ["  \u590D\u73B0\u65E5\u5FD7\u5DF2\u751F\u6210\uFF0C\u53EF\u70B9\u51FB\u201C\u5BFC\u51FA\u590D\u73B0\u65E5\u5FD7\u201D"] : []
    ].join("\n"), true);
    document.getElementById("metricValidation").textContent = runResult?.metricsAvailable ? runResult.validation === "failed" ? "\u672A\u901A\u8FC7" : String(runResult.validation || "\u5931\u8D25") : "\u5931\u8D25";
  } finally {
    button.disabled = false;
    button.classList.remove("running");
    button.textContent = "\u25B6 \u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5";
    renderWorkspaceControls();
  }
}
async function runCurrentTestGroup() {
  const button = document.getElementById("batchRunButton");
  const comparisonButton = document.getElementById("openParameterComparisonDialogButton");
  const runButton = document.getElementById("runButton");
  if (state.batchRunning) {
    try {
      await requestBatchCancellation();
    } catch (error) {
      state.batchCancelRequested = false;
      state.batchCancelSent = false;
      button.disabled = false;
      button.classList.remove("running");
      button.classList.add("cancel");
      button.textContent = "\u25A0 \u7EC8\u6B62\u8C03\u5EA6";
      writeTerminal(`$ \u7EC8\u6B62\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}
  \u6279\u91CF\u4EFB\u52A1\u4ECD\u5728\u8FD0\u884C\uFF0C\u53EF\u518D\u6B21\u5C1D\u8BD5\u7EC8\u6B62\u3002`, true);
    }
    return;
  }
  try {
    if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907\u548C\u6D4B\u8BD5\u7EC4");
    if (state.testCaseId) await saveCurrentTest(true);
    const tests = (state.workspaceDevice?.tests || []).filter((test) => String(test.group || "").trim() === state.activeTestGroup);
    if (!tests.length) throw new Error("\u5F53\u524D\u6D4B\u8BD5\u7EC4\u6CA1\u6709\u53EF\u8FD0\u884C\u6D4B\u8BD5");
    state.batchRunning = true;
    state.activeBatchId = "";
    state.batchCancelRequested = false;
    state.batchCancelSent = false;
    state.batchResult = null;
    state.selectedBatchTestId = "";
    batchPerformanceAnalyses.clear();
    batchBottleneckSummaries.clear();
    batchBottleneckRequests.clear();
    batchBottleneckErrors.clear();
    document.getElementById("testGroupAnalysisButton").hidden = true;
    document.getElementById("testGroupAnalysisPanel").hidden = true;
    document.getElementById("testGroupAnalysisPanel").innerHTML = "";
    document.getElementById("batchOverviewButton").hidden = true;
    button.disabled = false;
    comparisonButton.disabled = true;
    runButton.disabled = true;
    button.classList.add("cancel");
    button.textContent = "\u25A0 \u7EC8\u6B62\u8C03\u5EA6";
    document.getElementById("batchResults").innerHTML = "";
    writeTerminal(`$ \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4
  \u7EC4\u522B: ${state.activeTestGroup || "\u672A\u5206\u7EC4"}
  \u7B56\u7565: ${displayStrategyName(state.strategy)}
  \u6D4B\u8BD5\u6570: ${tests.length}
  \u540E\u7AEF\u6700\u591A\u5E76\u884C\u8FD0\u884C 4 \u9879\u2026`);
    const response = await fetch("/api/run-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: state.workspaceDeviceId, group: state.activeTestGroup, strategy: state.strategy, options: state.options })
    });
    let result = await response.json();
    if (!response.ok || !result.batchId || !Array.isArray(result.items)) throw new Error(result.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    state.activeBatchId = result.batchId;
    showBatchProgress(result);
    if (state.batchCancelRequested) await sendBatchCancellation();
    while (!["completed", "failed", "cancelled"].includes(result.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      const statusResponse = await fetch(`/api/run-batches/${encodeURIComponent(result.batchId)}`, { cache: "no-store" });
      result = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(result.error || `\u670D\u52A1\u8FD4\u56DE ${statusResponse.status}`);
      showBatchProgress(result);
    }
    if (result.status === "cancelled") {
      showBatchProgress(result);
      writeTerminal(`$ \u6279\u91CF\u8C03\u5EA6\u5DF2\u7EC8\u6B62
  \u5DF2\u505C\u6B62\u63D0\u4EA4\u7B49\u5F85\u4E2D\u7684\u6D4B\u8BD5\uFF1B\u4ECD\u5728\u7B97\u6CD5\u5185\u90E8\u6267\u884C\u7684\u4EFB\u52A1\u7ED3\u679C\u5C06\u88AB\u5FFD\u7565\u3002`);
      return;
    }
    if (result.status === "failed" && !Array.isArray(result.items)) throw new Error(result.error || "\u6279\u91CF\u4EFB\u52A1\u5931\u8D25");
    showBatchResult(result);
  } catch (error) {
    writeTerminal(`$ \u6279\u91CF\u8FD0\u884C\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
    document.getElementById("metricValidation").textContent = "\u5931\u8D25";
  } finally {
    state.batchRunning = false;
    state.activeBatchId = "";
    state.batchCancelRequested = false;
    state.batchCancelSent = false;
    button.disabled = !state.serviceCompatible;
    runButton.disabled = !state.serviceCompatible;
    button.classList.remove("running", "cancel");
    button.textContent = "\u25A6 \u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4";
    renderWorkspaceControls();
  }
}
async function requestBatchCancellation() {
  if (!state.batchRunning || state.batchCancelRequested) return;
  state.batchCancelRequested = true;
  const button = document.getElementById("batchRunButton");
  button.disabled = true;
  button.classList.add("running");
  button.textContent = "\u6B63\u5728\u7EC8\u6B62\u2026";
  writeTerminal("$ \u6B63\u5728\u7EC8\u6B62\u6279\u91CF\u8C03\u5EA6\u2026");
  if (state.activeBatchId) await sendBatchCancellation();
}
async function sendBatchCancellation() {
  if (!state.activeBatchId || state.batchCancelSent) return;
  state.batchCancelSent = true;
  const response = await fetch(`/api/run-batches/${encodeURIComponent(state.activeBatchId)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `\u7EC8\u6B62\u5931\u8D25\uFF0C\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  showBatchProgress(result);
}
function setResultMetric(key, label, value, detail = "") {
  document.getElementById(`metric${key}Label`).textContent = label;
  document.getElementById(`metric${key}`).textContent = value;
  document.getElementById(`metric${key}Detail`).textContent = detail;
}
function hasBatchResultMetrics(item) {
  return item?.status === "succeeded" || item?.metricsAvailable === true;
}
function setBottleneckMetric(summary, emptyDetail = "\u8FD0\u884C\u540E\u8BA1\u7B97\u7A33\u6001\u74F6\u9888\u5019\u9009") {
  const utilization = Number(summary?.utilization);
  const available = summary && Number.isFinite(utilization);
  setResultMetric(
    "Moves",
    "\u74F6\u9888\u5229\u7528\u7387",
    available ? `${(utilization * 100).toFixed(1)}%` : "\u2014",
    available ? `${summary.resourceName || "\u672A\u77E5\u8D44\u6E90"} \xB7 ${{ high: "\u8BC1\u636E\u8F83\u5F3A", medium: "\u8BC1\u636E\u4E2D\u7B49", low: "\u8BC1\u636E\u8F83\u5F31" }[summary.confidence] || "\u5019\u9009"}${Number(summary.candidateCount) > 1 ? ` \xB7 \u5171 ${summary.candidateCount} \u4E2A\u5019\u9009` : ""}` : emptyDetail
  );
}
function showBatchOverviewMetrics(result) {
  const measured = (result.items || []).filter(hasBatchResultMetrics);
  const averageMakespan = measured.length ? measured.reduce((sum, item) => sum + Number(item.makespan), 0) / measured.length : 0;
  const comparable = measured.filter((item) => item.baseline?.status === "succeeded");
  const totalMakespan = comparable.reduce((sum, item) => sum + Number(item.makespan), 0);
  const totalBaseline = comparable.reduce((sum, item) => sum + Number(item.baseline.makespan), 0);
  const aggregateImprovement = totalBaseline > 0 ? (totalBaseline - totalMakespan) / totalBaseline * 100 : NaN;
  const moveCount = measured.reduce((sum, item) => sum + Number(item.moveCount || 0), 0);
  const timeText = result.status === "completed" ? `${(Number(result.totalElapsedMs) / 1e3).toFixed(2)} s` : result.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u8FD0\u884C\u4E2D";
  const makespanText = comparable.length ? `${totalMakespan.toFixed(2)} / ${totalBaseline.toFixed(2)} s` : measured.length ? `${averageMakespan.toFixed(2)} s` : "\u2014";
  const improvementText = comparable.length && Number.isFinite(aggregateImprovement) ? `${aggregateImprovement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(aggregateImprovement).toFixed(2)}%` : "";
  document.getElementById("metricContext").textContent = `\u6279\u91CF\u603B\u89C8 \xB7 ${result.group || "\u672A\u5206\u7EC4"}`;
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "\u603B\u8017\u65F6", timeText);
  setResultMetric("Makespan", comparable.length ? "\u603B Makespan / Baseline" : "\u5E73\u5747 Makespan", makespanText, improvementText);
  setResultMetric("Moves", "\u603B Move \u6570", moveCount || "\u2014");
  setResultMetric("Validation", result.cancelled ? "\u6210\u529F / \u5931\u8D25 / \u7EC8\u6B62" : "\u6210\u529F / \u5931\u8D25", result.cancelled ? `${result.succeeded || 0} / ${result.failed || 0} / ${result.cancelled}` : `${result.succeeded || 0} / ${result.failed || 0}`);
}
function showBatchItemOverview(item, index) {
  const hasMetrics = hasBatchResultMetrics(item);
  const baseline = item.baseline || {};
  const baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(item.cpuTimeMs ?? item.totalElapsedMs);
  const elapsedTime = Number(item.totalElapsedMs);
  const makespan = Number(item.makespan);
  const improvement = Number(item.improvementPercent);
  const validationText = item.validation === "passed" ? "\u901A\u8FC7" : item.validation ? String(item.validation) : item.status === "failed" ? "\u8FD0\u884C\u5931\u8D25" : item.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u7B49\u5F85\u5B8C\u6210";
  const comparisonDetail = baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}` : "";
  const resultUrl = String(item.resultUrl || "");
  const bottleneckReady = resultUrl && batchBottleneckSummaries.has(resultUrl);
  const bottleneckSummary = bottleneckReady ? batchBottleneckSummaries.get(resultUrl) : null;
  const bottleneckError = resultUrl ? batchBottleneckErrors.get(resultUrl) : "";
  document.getElementById("metricContext").textContent = `t${index + 1} \xB7 ${item.testName || `\u6D4B\u8BD5 ${index + 1}`} \xB7 ${displayStrategyName(state.batchResult?.strategy)}`;
  document.getElementById("batchOverviewButton").hidden = false;
  setResultMetric("Time", "CPU Time / \u8017\u65F6", Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014", Number.isFinite(elapsedTime) ? `\u7AEF\u5230\u7AEF\u8017\u65F6 ${elapsedTime.toFixed(1)} ms` : "");
  setResultMetric("Makespan", "Makespan / Baseline", Number.isFinite(makespan) ? `${makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "\u2014"} s` : "\u2014", comparisonDetail);
  setBottleneckMetric(
    bottleneckSummary,
    hasMetrics && resultUrl ? bottleneckError ? `\u74F6\u9888\u8BA1\u7B97\u5931\u8D25\uFF1A${bottleneckError}` : bottleneckReady ? "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8" : "\u6B63\u5728\u8BA1\u7B97\u7A33\u6001\u74F6\u9888\u2026" : "\u6CA1\u6709\u53EF\u5206\u6790\u7684 MoveList"
  );
  setResultMetric("Validation", "\u6821\u9A8C", validationText, item.error || "");
}
async function loadBatchItemPerformance(item, index) {
  const resultUrl = String(item?.resultUrl || "");
  if (!resultUrl || !hasBatchResultMetrics(item)) return null;
  if (batchPerformanceAnalyses.has(resultUrl)) {
    return batchPerformanceAnalyses.get(resultUrl);
  }
  if (batchBottleneckErrors.has(resultUrl)) return null;
  let request = batchBottleneckRequests.get(resultUrl);
  if (!request) {
    request = (async () => {
      const testCase = (state.workspaceDevice?.tests || []).find(
        (test) => String(test.id) === String(item.testId)
      );
      const resultId = resultUrl.startsWith("/api/results/") ? decodeURIComponent(resultUrl.slice("/api/results/".length)) : "";
      if (!resultId) throw new Error("\u7ED3\u679C\u5730\u5740\u4E0D\u7B26\u5408\u670D\u52A1\u7AEF\u5206\u6790\u5951\u7EA6");
      const response = await requestScheduleAnalysis({
        resultId,
        device: state.device,
        windowMode: "steady",
        routes: state.workspaceDevice?.routes || state.routes,
        rounds: testCase?.rounds || state.rounds
      });
      batchPerformanceAnalyses.set(resultUrl, response.analysis);
      batchBottleneckSummaries.set(resultUrl, response.bottleneck);
      return response.analysis;
    })();
    batchBottleneckRequests.set(resultUrl, request);
  }
  try {
    return await request;
  } catch (error) {
    batchBottleneckErrors.set(resultUrl, error.message || "\u672A\u77E5\u9519\u8BEF");
    if (state.selectedBatchTestId === String(item.testId || `index-${index}`)) {
      setBottleneckMetric(null, `\u74F6\u9888\u8BA1\u7B97\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`);
    }
    return null;
  } finally {
    batchBottleneckRequests.delete(resultUrl);
  }
}
async function loadBatchItemBottleneck(item, index) {
  await loadBatchItemPerformance(item, index);
  const currentIndex = (state.batchResult?.items || []).findIndex(
    (candidate, candidateIndex) => String(candidate.testId || `index-${candidateIndex}`) === state.selectedBatchTestId
  );
  if (currentIndex >= 0) showBatchItemOverview(state.batchResult.items[currentIndex], currentIndex);
}
function selectBatchItem(index) {
  const item = state.batchResult?.items?.[index];
  if (!item) return;
  state.selectedBatchTestId = String(item.testId || `index-${index}`);
  renderBatchItems(state.batchResult.items || []);
  showBatchItemOverview(item, index);
  void loadBatchItemBottleneck(item, index);
}
function showCurrentBatchOverview() {
  if (!state.batchResult) return;
  state.selectedBatchTestId = "";
  renderBatchItems(state.batchResult.items || []);
  showBatchOverviewMetrics(state.batchResult);
}
async function showTestGroupAnalysis() {
  const result = state.batchResult;
  if (!result?.items?.length) return;
  const button = document.getElementById("testGroupAnalysisButton");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "\u6B63\u5728\u5206\u6790\u2026";
  try {
    const analyzable = result.items.map((item, index) => ({ item, index })).filter((entry) => hasBatchResultMetrics(entry.item) && entry.item.resultUrl);
    let cursor = 0;
    const workerCount = Math.min(4, analyzable.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < analyzable.length) {
        const current = analyzable[cursor];
        cursor += 1;
        await loadBatchItemPerformance(current.item, current.index);
      }
    }));
    const summary = await requestTestGroupAnalysis(result.items.map((item, index) => ({
      id: String(item.testId || `index-${index}`),
      name: `t${index + 1}`,
      status: String(item.status || "unknown"),
      validation: String(item.validation || "unknown"),
      metricsAvailable: hasBatchResultMetrics(item),
      makespan: item.makespan,
      baselineMakespan: item.baseline?.status === "succeeded" ? item.baseline.makespan : null,
      cpuTimeMs: item.cpuTimeMs ?? item.totalElapsedMs,
      elapsedTimeMs: item.totalElapsedMs,
      error: item.error || item.baseline?.error || "",
      performance: item.resultUrl ? batchPerformanceAnalyses.get(String(item.resultUrl)) ?? null : null
    })));
    const panelMarkup = renderTestGroupAnalysis(
      summary,
      result.group || state.activeTestGroup || "\u5F53\u524D\u6D4B\u8BD5\u7EC4"
    );
    visualizationWorkspace.showGroupAnalysis(panelMarkup);
    switchTab("workspace");
    const panel = document.getElementById("testGroupAnalysisPanel");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}
function showBatchProgress(result) {
  const completed = Number(result.completed || 0), total = Number(result.testCount || result.items?.length || 0);
  const percent = total ? Math.round(completed / total * 100) : 0;
  const progress = document.getElementById("batchProgress");
  document.getElementById("testGroupAnalysisButton").hidden = !["completed", "cancelled"].includes(result.status);
  progress.classList.add("visible");
  progress.setAttribute("aria-valuenow", String(percent));
  document.getElementById("batchProgressCount").textContent = `${percent}%`;
  document.getElementById("batchProgressBar").style.width = `${percent}%`;
  state.batchResult = result;
  updateBatchLogDownload(result);
  if (!state.selectedBatchTestId) showBatchOverviewMetrics(result);
  renderBatchItems(result.items || []);
  const selectedIndex = (result.items || []).findIndex((item, index) => String(item.testId || `index-${index}`) === state.selectedBatchTestId);
  if (selectedIndex >= 0) {
    showBatchItemOverview(result.items[selectedIndex], selectedIndex);
    void loadBatchItemBottleneck(result.items[selectedIndex], selectedIndex);
  }
  writeTerminal([
    "$ \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4",
    `  \u7EC4\u522B: ${result.group || "\u672A\u5206\u7EC4"} \xB7 \u7B56\u7565: ${displayStrategyName(result.strategy)}`,
    `  \u8FDB\u5EA6: ${completed}/${total} (${percent}%) \xB7 \u5E76\u884C\u6570: ${result.workerCount}`,
    `  \u7B49\u5F85: ${(result.items || []).filter((item) => item.status === "queued").length} \xB7 \u8FD0\u884C\u4E2D: ${(result.items || []).filter((item) => item.status === "running").length} \xB7 \u6210\u529F: ${result.succeeded || 0} \xB7 \u5931\u8D25: ${result.failed || 0} \xB7 \u7EC8\u6B62: ${result.cancelled || 0}`
  ].join("\n"));
}
function renderBatchItems(items) {
  const statusLabels = { queued: "\u7B49\u5F85\u4E2D", running: "\u8FD0\u884C\u4E2D", succeeded: "\u6210\u529F", failed: "\u5931\u8D25", cancelled: "\u5DF2\u7EC8\u6B62" };
  document.getElementById("batchResults").innerHTML = items.map((item, index) => {
    const hasMetrics = hasBatchResultMetrics(item);
    const baseline = item.baseline || {}, baselineReady = baseline.status === "succeeded";
    const cpuTime = Number(item.cpuTimeMs);
    const improvement = Number(item.improvementPercent);
    const improvementText = hasMetrics && baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status && baseline.status !== "succeeded" ? "\u65E0\u6709\u6548\u57FA\u7EBF" : "\u63D0\u5347 \u2014";
    const baselineReason = baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}` : "";
    const summaryError = baseline.status === "failed" ? baselineReason : item.status === "failed" ? `${hasMetrics ? "\u6821\u9A8C\u5931\u8D25" : "\u8FD0\u884C\u5931\u8D25"}\uFF1A${item.error || "\u672A\u77E5\u9519\u8BEF"}` : item.status === "cancelled" ? "\u8C03\u5EA6\u5DF2\u7EC8\u6B62" : baselineReason;
    const displayId = `t${index + 1}`;
    const itemSelectionId = String(item.testId || `index-${index}`);
    const selected = itemSelectionId === state.selectedBatchTestId;
    return `
      <div class="batch-result ${escapeHtml3(item.status || "queued")}${selected ? " selected" : ""}" data-batch-item-index="${index}">
        <div class="batch-result-head">
          <button class="batch-result-title" type="button" aria-pressed="${selected}" aria-label="\u67E5\u770B ${escapeHtml3(displayId)} ${escapeHtml3(item.testName || "")} \u7684\u8BE6\u7EC6\u6307\u6807"><strong title="${escapeHtml3(`${item.testId || ""} \xB7 ${item.testName || ""}`)}">${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}</strong></button>
          <div class="batch-result-meta">
            <span class="batch-status">${statusLabels[item.status] || "\u7B49\u5F85\u4E2D"}</span>
            ${item.logUrl ? `<a class="btn" href="${escapeHtml3(item.logUrl)}" download>\u65E5\u5FD7</a>` : `<span class="btn" aria-disabled="true">\u65E5\u5FD7</span>`}
            ${item.resultUrl ? `<button class="btn primary" type="button" data-workspace-result="${escapeHtml3(item.resultUrl)}" data-workspace-name="${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}">\u5DE5\u4F5C\u53F0</button>` : `<span class="btn" aria-disabled="true">\u5DE5\u4F5C\u53F0</span>`}
            ${item.ganttUrl ? `<a class="btn" href="${escapeHtml3(item.ganttUrl)}" target="_blank">\u7518\u7279\u56FE</a>` : `<span class="btn" aria-disabled="true">\u7518\u7279\u56FE</span>`}
          </div>
        </div>
        <div class="batch-result-summary">
          <div class="batch-metric-tags" aria-label="\u4E3B\u8981\u6307\u6807">
            <span class="batch-metric-tag makespan" title="Makespan${baselineReady ? `\uFF1BBaseline ${Number(baseline.makespan).toFixed(2)} s` : ""}">${hasMetrics ? `${Number(item.makespan).toFixed(2)} s` : "\u2014 s"}</span>
            <span class="batch-metric-tag ${improvement < 0 ? "loss" : "gain"}">${escapeHtml3(improvementText)}</span>
            <span class="batch-metric-tag cpu">CPU Time ${hasMetrics && Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014"}</span>
          </div>
          ${summaryError ? `<span class="summary-error" title="${escapeHtml3(summaryError)}">${escapeHtml3(summaryError)}</span>` : ""}
        </div>
      </div>`;
  }).join("");
}
function batchGanttUrl(items) {
  const params = new URLSearchParams();
  items.filter((item) => item.resultUrl).forEach((item) => {
    params.append("src", item.resultUrl);
    params.append("name", item.testName);
  });
  return params.size ? `/movelist_gantt_viewer.html?${params.toString()}` : "";
}
function updateBatchLogDownload(result) {
  const button = document.getElementById("batchLogButton");
  const hasLogs = (result.items || []).some((item) => item.logUrl);
  if (!result.batchId || !hasLogs) {
    button.href = "#";
    button.setAttribute("aria-disabled", "true");
    return;
  }
  button.href = `/api/run-batches/${encodeURIComponent(result.batchId)}/logs`;
  button.download = `ct-batch-logs-${String(result.batchId).slice(0, 8)}.zip`;
  button.removeAttribute("aria-disabled");
}
function showBatchResult(result) {
  state.batchResult = result;
  updateBatchLogDownload(result);
  document.getElementById("testGroupAnalysisButton").hidden = false;
  if (!state.selectedBatchTestId) showBatchOverviewMetrics(result);
  const resultErrors = result.items.flatMap((item, index) => {
    if (item.status === "failed") {
      return [`t${index + 1} ${item.testName || ""}\uFF1A${item.error || "\u8FD0\u884C\u5931\u8D25"}`];
    }
    if (item.status === "succeeded" && item.validation && item.validation !== "passed") {
      return [`t${index + 1} ${item.testName || ""}\uFF1AMoveList \u6821\u9A8C ${item.validation}${item.error ? `\uFF1B${item.error}` : ""}`];
    }
    return [];
  });
  writeTerminal(resultErrors.join("\n"), resultErrors.length > 0);
  renderBatchItems(result.items);
  const selectedIndex = result.items.findIndex((item, index) => String(item.testId || `index-${index}`) === state.selectedBatchTestId);
  if (selectedIndex >= 0) {
    showBatchItemOverview(result.items[selectedIndex], selectedIndex);
    void loadBatchItemBottleneck(result.items[selectedIndex], selectedIndex);
  }
  const first = result.items.find((item) => item.ganttUrl || item.logUrl);
  if (first) {
    if (first.ganttUrl) {
      const gantt = document.getElementById("ganttButton");
      gantt.href = first.ganttUrl;
      gantt.removeAttribute("aria-disabled");
    }
    if (first.logUrl) {
      const log = document.getElementById("logButton");
      log.href = first.logUrl;
      log.download = first.logFileName;
      log.removeAttribute("aria-disabled");
    }
  }
  const allGanttUrl = batchGanttUrl(result.items);
  const allGantt = document.getElementById("batchGanttButton");
  if (allGanttUrl) {
    allGantt.href = allGanttUrl;
    allGantt.removeAttribute("aria-disabled");
  }
}
function objectiveComparisonMetrics(result) {
  const diagnostics = [...result?.rounds || []].reverse().map((round) => round.strategyDiagnostics).find((value) => value?.metrics);
  const metrics = diagnostics?.metrics || {};
  return {
    residencyViolationCount: Number(metrics.residencyViolationCount) || 0,
    maximumRobotHoldingSeconds: Number(metrics.maximumRobotHoldingSeconds),
    systemResidenceCv: Number(metrics.systemResidenceCv)
  };
}
function comparisonNumber(value, digits = 2, suffix = "") {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : "\u2014";
}
function comparisonDelta(baselineValue, candidateValue, digits = 2, suffix = "", lowerIsBetter = true) {
  const baseline = Number(baselineValue);
  const candidate = Number(candidateValue);
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return { text: "\u2014", kind: "neutral" };
  const delta = candidate - baseline;
  const sign = delta > 0 ? "+" : "";
  const percent = Math.abs(baseline) > 1e-9 ? ` (${sign}${(delta / baseline * 100).toFixed(1)}%)` : "";
  const kind = delta === 0 ? "neutral" : lowerIsBetter ? delta < 0 ? "gain" : "loss" : delta > 0 ? "gain" : "loss";
  return { text: `${sign}${delta.toFixed(digits)}${suffix}${percent}`, kind };
}
function comparisonLimit(value, digits = 2, suffix = "") {
  const numeric = Number(value) || 0;
  return numeric > 0 ? `${numeric.toFixed(digits)}${suffix}` : "\u4E0D\u9650";
}
function comparisonSettingDelta(baselineValue, candidateValue, digits = 2, suffix = "") {
  return { ...comparisonDelta(baselineValue, candidateValue, digits, suffix, false), kind: "neutral" };
}
function renderParameterComparisonRows(baseline, experiment) {
  const baselineMetrics = objectiveComparisonMetrics(baseline.result);
  const experimentMetrics = objectiveComparisonMetrics(experiment.result);
  const baselineMakespan = Number(baseline.result?.makespan);
  const experimentMakespan = Number(experiment.result?.makespan);
  const strategyChanged = baseline.plan.strategy !== experiment.plan.strategy;
  const rows = [
    ["\u7B56\u7565", displayStrategyName(baseline.plan.strategy), displayStrategyName(experiment.plan.strategy), strategyChanged ? "\u5DF2\u5207\u6362" : "\u76F8\u540C", strategyChanged ? "gain" : "neutral"],
    ["\u9A7B\u7559\u4F59\u91CF", comparisonNumber(baseline.options.residencyGuardSeconds, 1, " s"), comparisonNumber(experiment.options.residencyGuardSeconds, 1, " s"), comparisonSettingDelta(baseline.options.residencyGuardSeconds, experiment.options.residencyGuardSeconds, 1, " s")],
    ["\u6301\u7247\u4E0A\u9650", comparisonLimit(baseline.options.maximumRobotHoldingSeconds, 1, " s"), comparisonLimit(experiment.options.maximumRobotHoldingSeconds, 1, " s"), comparisonSettingDelta(baseline.options.maximumRobotHoldingSeconds, experiment.options.maximumRobotHoldingSeconds, 1, " s")],
    ["CV \u4E0A\u9650", comparisonLimit(baseline.options.maximumSystemResidenceCv, 3), comparisonLimit(experiment.options.maximumSystemResidenceCv, 3), comparisonSettingDelta(baseline.options.maximumSystemResidenceCv, experiment.options.maximumSystemResidenceCv, 3)],
    ["Makespan", comparisonNumber(baselineMakespan, 2, " s"), comparisonNumber(experimentMakespan, 2, " s"), comparisonDelta(baselineMakespan, experimentMakespan, 2, " s")],
    ["\u9A7B\u7559\u8D85\u9650", `${baselineMetrics.residencyViolationCount} \u6B21`, `${experimentMetrics.residencyViolationCount} \u6B21`, comparisonDelta(baselineMetrics.residencyViolationCount, experimentMetrics.residencyViolationCount, 0, " \u6B21")],
    ["\u5B9E\u9645\u6700\u5927\u6301\u7247", comparisonNumber(baselineMetrics.maximumRobotHoldingSeconds, 2, " s"), comparisonNumber(experimentMetrics.maximumRobotHoldingSeconds, 2, " s"), comparisonDelta(baselineMetrics.maximumRobotHoldingSeconds, experimentMetrics.maximumRobotHoldingSeconds, 2, " s")],
    ["\u7CFB\u7EDF\u505C\u7559 CV", comparisonNumber(baselineMetrics.systemResidenceCv, 3), comparisonNumber(experimentMetrics.systemResidenceCv, 3), comparisonDelta(baselineMetrics.systemResidenceCv, experimentMetrics.systemResidenceCv, 3)]
  ];
  return rows.map(([label, base, candidate, delta, kind]) => {
    const deltaValue = typeof delta === "string" ? { text: delta, kind } : delta;
    return `<div class="comparison-row"><span>${escapeHtml3(label)}</span><strong>${escapeHtml3(base)}</strong><strong>${escapeHtml3(candidate)}</strong><strong class="comparison-delta ${escapeHtml3(deltaValue.kind)}">${escapeHtml3(deltaValue.text)}</strong></div>`;
  }).join("");
}
function renderParameterComparisonCard(index, baseline, experiment) {
  const makespanDelta = comparisonDelta(baseline.result?.makespan, experiment.result?.makespan, 2, " s");
  const validation = experiment.result?.validation === "passed" ? "\u6821\u9A8C\u901A\u8FC7" : `\u6821\u9A8C ${experiment.result?.validation || "\u672A\u77E5"}`;
  return `<article class="comparison-experiment">
    <header class="comparison-experiment-head"><div><strong>\u57FA\u51C6 vs \u5BF9\u6BD4 ${index + 1}</strong><span> ${escapeHtml3(displayStrategyName(baseline.plan.strategy))} \u2192 ${escapeHtml3(displayStrategyName(experiment.plan.strategy))}</span></div><div><span class="comparison-delta ${escapeHtml3(makespanDelta.kind)}">Makespan ${escapeHtml3(makespanDelta.text)}</span>${experiment.result?.ganttUrl ? `<a class="btn" href="${escapeHtml3(experiment.result.ganttUrl)}" target="_blank">\u7518\u7279\u56FE</a>` : ""}</div></header>
    <div class="comparison-table"><div class="comparison-row comparison-row-head"><span>\u6307\u6807</span><strong>\u57FA\u51C6</strong><strong>\u5BF9\u6BD4</strong><strong>\u5DEE\u503C</strong></div>${renderParameterComparisonRows(baseline, experiment)}</div>
    <small>${escapeHtml3(validation)}</small>
  </article>`;
}
function renderParameterComparison() {
  const panel = document.getElementById("parameterComparisonPanel");
  const comparison = state.parameterComparison;
  if (!comparison?.baseline || !comparison.variants.length) {
    panel.hidden = true;
    document.getElementById("parameterComparisonBase").textContent = "";
    document.getElementById("parameterComparisonResults").innerHTML = "";
    return;
  }
  const baseline = comparison.baseline;
  panel.hidden = false;
  document.getElementById("parameterComparisonBase").textContent = `\u57FA\u51C6\uFF1A${displayStrategyName(baseline.plan.strategy)} \xB7 ${batchParameterSummary(baseline.options, baseline.plan.strategy)}`;
  document.getElementById("parameterComparisonResults").innerHTML = comparison.variants.map((variant, index) => renderParameterComparisonCard(index, baseline, variant)).join("");
}
function renderParameterComparisonStrategyFields(strategy, options = {}) {
  const definitions = {
    "loadlock-macro": [["loadLockMacroSearchSeconds", "\u5B8F\u641C\u7D22\u65F6\u95F4\uFF08\u79D2\uFF09", "number", "0.1"], ["loadLockMacroRollouts", "\u5B8F\u91C7\u6837\u6B21\u6570", "number", "1"]],
    "nn-saea": [["nnSAEASearchSeconds", "SAEA \u641C\u7D22\u65F6\u95F4\uFF08\u79D2\uFF09", "number", "0.1"], ["nnSAEARollouts", "SAEA \u91C7\u6837\u6B21\u6570", "number", "1"]],
    neuralucb: [["neuralUCBTopK", "UCB Top-K", "number", "1"], ["neuralUCBExploration", "UCB \u63A2\u7D22\u5F3A\u5EA6", "number", "0.1"]],
    rl: [["rlSearchSeconds", "RL \u641C\u7D22\u65F6\u95F4\uFF08\u79D2\uFF09", "number", "0.1"], ["rlRollouts", "RL \u91C7\u6837\u6B21\u6570", "number", "1"], ["rlTemperature", "RL \u6E29\u5EA6", "number", "0.01"]],
    milp: [["milpTimeLimit", "MILP \u65F6\u95F4\u4E0A\u9650\uFF08\u79D2\uFF09", "number", "0.1"]]
  };
  const fields = definitions[strategy] || [];
  document.getElementById("parameterComparisonStrategyOptions").innerHTML = fields.length ? `<div class="grid">${fields.map(([key, label, type, step]) => `<div class="field span-4"><label>${escapeHtml3(label)}<input data-comparison-option="${escapeHtml3(key)}" type="${type}" min="0" step="${step}" value="${escapeHtml3(String(options[key] ?? 0))}" required></label></div>`).join("")}</div>` : `<div class="hint">\u8BE5\u7B56\u7565\u6CA1\u6709\u989D\u5916\u7684\u7B56\u7565\u4E13\u5C5E\u53C2\u6570\uFF1B\u4E0A\u65B9\u901A\u7528\u7EA6\u675F\u53C2\u6570\u4ECD\u4F1A\u751F\u6548\u3002</div>`;
}
function openParameterComparisonDialog() {
  const comparison = state.parameterComparison;
  if (!comparison?.baseline) return;
  const baseline = comparison.baseline;
  const strategySelect = document.getElementById("parameterComparisonStrategy");
  const strategies = [...document.querySelectorAll('input[name="strategy"]')].filter((input) => !input.disabled || input.value === baseline.plan.strategy).map((input) => input.value);
  strategySelect.innerHTML = strategies.map((strategy) => `<option value="${escapeHtml3(strategy)}">${escapeHtml3(displayStrategyName(strategy))}</option>`).join("");
  strategySelect.value = baseline.plan.strategy;
  document.getElementById("comparisonLoadLockManager").value = baseline.options.loadLockManager || "petri-look";
  document.getElementById("comparisonResidencyGuardSeconds").value = String(Number(baseline.options.residencyGuardSeconds) || 0);
  document.getElementById("comparisonMaximumRobotHoldingSeconds").value = String(Number(baseline.options.maximumRobotHoldingSeconds) || 0);
  document.getElementById("comparisonMaximumSystemResidenceCv").value = String(Number(baseline.options.maximumSystemResidenceCv) || 0);
  document.getElementById("comparisonSeed").value = String(Number(baseline.options.seed) || 0);
  renderParameterComparisonStrategyFields(baseline.plan.strategy, baseline.options);
  document.getElementById("parameterComparisonDialogStatus").textContent = "";
  document.getElementById("parameterComparisonDialog").showModal();
}
function parameterComparisonOptions() {
  const optionInputs = [
    ["comparisonResidencyGuardSeconds", "residencyGuardSeconds"],
    ["comparisonMaximumRobotHoldingSeconds", "maximumRobotHoldingSeconds"],
    ["comparisonMaximumSystemResidenceCv", "maximumSystemResidenceCv"],
    ["comparisonSeed", "seed"]
  ];
  const options = Object.fromEntries(optionInputs.map(([inputId, optionKey]) => {
    const value = Number(document.getElementById(inputId).value);
    if (!Number.isFinite(value) || value < 0) throw new Error("\u5BF9\u6BD4\u53C2\u6570\u5FC5\u987B\u4E3A\u5927\u4E8E\u6216\u7B49\u4E8E 0 \u7684\u6570\u5B57");
    return [optionKey, value];
  }));
  options.loadLockManager = document.getElementById("comparisonLoadLockManager").value;
  document.querySelectorAll("[data-comparison-option]").forEach((input) => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) throw new Error("\u7B56\u7565\u53C2\u6570\u5FC5\u987B\u4E3A\u5927\u4E8E\u6216\u7B49\u4E8E 0 \u7684\u6570\u5B57");
    options[input.dataset.comparisonOption] = value;
  });
  return options;
}
async function runParameterComparison() {
  const comparison = state.parameterComparison;
  if (!comparison?.baseline) throw new Error("\u8BF7\u5148\u5B8C\u6210\u4E00\u6B21\u5355\u6D4B\u8BD5\u8FD0\u884C\uFF0C\u518D\u521B\u5EFA\u53C2\u6570\u5BF9\u6BD4");
  const button = document.getElementById("runParameterComparisonButton");
  const status = document.getElementById("parameterComparisonDialogStatus");
  const overrides = parameterComparisonOptions();
  const plan = structuredClone(comparison.baseline.plan);
  plan.strategy = document.getElementById("parameterComparisonStrategy").value;
  plan.options = { ...plan.options, ...overrides };
  delete plan.workspaceDeviceId;
  delete plan.workspaceTestId;
  button.disabled = true;
  button.textContent = "\u6B63\u5728\u8FD0\u884C\u5BF9\u6BD4\u2026";
  status.textContent = "\u6B63\u5728\u63D0\u4EA4\u5BF9\u6BD4\u6D4B\u8BD5\uFF0C\u8BF7\u7A0D\u5019\u2026";
  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    comparison.variants.push({ plan, options: plan.options, result });
    renderParameterComparison();
    document.getElementById("parameterComparisonDialog").close();
    writeTerminal(`$ \u53C2\u6570\u5BF9\u6BD4\u5B8C\u6210
  ${displayStrategyName(plan.strategy)} \xB7 ${batchParameterSummary(overrides, plan.strategy)}
  Makespan: ${Number(result.makespan).toFixed(2)} s`);
  } finally {
    button.disabled = false;
    button.textContent = "\u8FD0\u884C\u5BF9\u6BD4\u6D4B\u8BD5";
    status.textContent = "";
  }
}
async function clearExportedArtifacts() {
  if (!window.confirm("\u5C06\u5220\u9664\u5168\u90E8\u5DF2\u5BFC\u51FA\u7684\u7ED3\u679C\u548C\u590D\u73B0\u65E5\u5FD7\uFF0C\u4E14\u65E0\u6CD5\u6062\u590D\u3002\u662F\u5426\u7EE7\u7EED\uFF1F")) return;
  const button = document.getElementById("clearExportsButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/exports", { method: "DELETE" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "\u6E05\u7406\u5931\u8D25");
    resetRunResult();
    const deleted = result.deleted || {};
    writeTerminal(`$ \u5DF2\u6E05\u7406\u5BFC\u51FA\u6570\u636E
  \u7ED3\u679C\uFF1A${Number(deleted.results) || 0} \u4E2A
  \u590D\u73B0\u65E5\u5FD7\uFF1A${Number(deleted.logs) || 0} \u4E2A`);
  } catch (error) {
    writeTerminal(`$ \u6E05\u7406\u5BFC\u51FA\u6570\u636E\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
  } finally {
    button.disabled = false;
  }
}
function showResult(result) {
  state.batchResult = null;
  state.selectedBatchTestId = "";
  document.getElementById("testGroupAnalysisButton").hidden = true;
  document.getElementById("testGroupAnalysisPanel").hidden = true;
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  const allGantt = document.getElementById("batchGanttButton");
  allGantt.href = "#";
  allGantt.setAttribute("aria-disabled", "true");
  updateBatchLogDownload({});
  const baseline = result.baseline || {}, baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(result.cpuTimeMs ?? result.totalElapsedMs);
  document.getElementById("metricContext").textContent = "\u5F53\u524D\u6D4B\u8BD5";
  document.getElementById("batchOverviewButton").hidden = true;
  ["metricTimeDetail", "metricMakespanDetail", "metricMovesDetail", "metricValidationDetail"].forEach((id) => {
    document.getElementById(id).textContent = "";
  });
  document.getElementById("metricTimeLabel").textContent = "CPU Time";
  document.getElementById("metricMakespanLabel").textContent = "Makespan / Baseline";
  setBottleneckMetric(result.bottleneckUtilization, "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8");
  document.getElementById("metricValidationLabel").textContent = "\u6821\u9A8C";
  document.getElementById("metricTime").textContent = `${cpuTime.toFixed(1)} ms`;
  document.getElementById("metricMakespan").textContent = `${result.makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "\u2014"} s`;
  document.getElementById("metricValidation").textContent = result.validation === "passed" ? "\u901A\u8FC7" : result.validation;
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-success", result.validation === "passed");
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-error", result.validation !== "passed");
  const objectiveDiagnostics = [...result.rounds || []].reverse().map((round) => round.strategyDiagnostics).find((diagnostics) => diagnostics?.metrics);
  if (objectiveDiagnostics) {
    const metrics = objectiveDiagnostics.metrics;
    document.getElementById("metricValidationLabel").textContent = "\u6821\u9A8C / \u591A\u6307\u6807";
    document.getElementById("metricValidationDetail").textContent = `\u9A7B\u7559\u8D85\u9650 ${Number(metrics.residencyViolationCount) || 0} \u6B21 \xB7 \u6700\u5927\u6301\u7247 ${Number(metrics.maximumRobotHoldingSeconds || 0).toFixed(2)} s \xB7 \u7CFB\u7EDF\u505C\u7559 CV ${Number(metrics.systemResidenceCv || 0).toFixed(3)}`;
  }
  const baselinePlan = structuredClone(buildPayload());
  state.parameterComparison = {
    baseline: { plan: baselinePlan, options: baselinePlan.options, result },
    variants: []
  };
  document.getElementById("openParameterComparisonDialogButton").disabled = !state.serviceCompatible;
  renderParameterComparison();
  writeTerminal(["$ \u8C03\u5EA6\u5B8C\u6210", ...(result.rounds || []).map((round) => {
    if (round.kind === "initial") return `  #${round.index} \u9996\u6B21 | ${round.elapsedMs.toFixed(1)} ms`;
    const request = Number(round.requestedTime);
    const recoveryEnd = Number(round.recoveryEndTime ?? round.effectiveTime);
    const timing = Math.abs(recoveryEnd - request) > 1e-6 ? `@${request}s \u91CD\u7B97 \xB7 \u56FA\u5B9A\u65E7\u52A8\u4F5C\u6536\u5C3E\u81F3 @${recoveryEnd}s` : `@${request}s \u91CD\u7B97`;
    return `  #${round.index} ${timing} | ${round.elapsedMs.toFixed(1)} ms`;
  }), "", ...result.logs || []].join("\n"));
  const gantt = document.getElementById("ganttButton");
  gantt.href = result.ganttUrl;
  gantt.removeAttribute("aria-disabled");
}
function showFailedResultMetrics(result) {
  state.batchResult = null;
  state.selectedBatchTestId = "";
  document.getElementById("testGroupAnalysisButton").hidden = true;
  document.getElementById("testGroupAnalysisPanel").hidden = true;
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  const baseline = result?.baseline || {};
  const baselineMakespan = baseline.status === "succeeded" ? Number(baseline.makespan) : NaN;
  const makespan = Number(result?.makespan);
  const elapsedTime = Number(result?.totalElapsedMs ?? result?.cpuTimeMs);
  const improvement = Number(result?.improvementPercent);
  const makespanText = `${Number.isFinite(makespan) ? makespan.toFixed(2) : "\u2014"} / ${Number.isFinite(baselineMakespan) ? baselineMakespan.toFixed(2) : "\u2014"} s`;
  const comparisonDetail = Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}% \xB7 \u7ED3\u679C\u6821\u9A8C\u672A\u901A\u8FC7` : baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}` : "\u5916\u90E8\u7B97\u6CD5\u672A\u8FD4\u56DE\u53EF\u6BD4\u8F83\u7684\u5B8C\u6574 Makespan";
  document.getElementById("metricContext").textContent = "\u5F53\u524D\u6D4B\u8BD5 \xB7 \u5916\u90E8\u7B97\u6CD5\u5931\u8D25\u7ED3\u679C";
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "\u5931\u8D25\u524D\u8017\u65F6", Number.isFinite(elapsedTime) ? `${elapsedTime.toFixed(1)} ms` : "\u2014", "\u4ECE\u63D0\u4EA4\u5230\u8FD4\u56DE\u5931\u8D25\u7ED3\u679C");
  setResultMetric("Makespan", "Makespan / Baseline", makespanText, comparisonDetail);
  setBottleneckMetric(result?.bottleneckUtilization, result?.resultId ? "\u5931\u8D25\u7ED3\u679C\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8" : "\u672A\u751F\u6210\u53EF\u5206\u6790\u7684 MoveList");
  setResultMetric("Validation", "\u6821\u9A8C", result?.validation === "failed" ? "\u672A\u901A\u8FC7" : String(result?.validation || "\u5931\u8D25"), result?.error || "");
  document.getElementById("metricValidation").closest(".metric").classList.remove("is-success");
  document.getElementById("metricValidation").closest(".metric").classList.add("is-error");
  state.parameterComparison = null;
  document.getElementById("openParameterComparisonDialogButton").disabled = true;
}
function writeTerminal(message, error = false) {
  const panel = document.getElementById("resultErrorPanel");
  const terminal = document.getElementById("terminal");
  if (!error) {
    terminal.textContent = "";
    panel.hidden = true;
    return;
  }
  terminal.textContent = String(message || "\u672A\u77E5\u9519\u8BEF").replace(/^\$\s*/, "");
  panel.hidden = false;
}
async function checkService() {
  const pill = document.getElementById("serviceState");
  const runButton = document.getElementById("runButton");
  const batchRunButton = document.getElementById("batchRunButton");
  const comparisonButton = document.getElementById("openParameterComparisonDialogButton");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const status = await response.json(), compatible = status.schemaVersion === EXPECTED_API_SCHEMA;
    state.serviceCompatible = compatible;
    const loadlockMacroAvailable = status.strategies?.["loadlock-macro"] === true, nnSAEAAvailable = status.strategies?.["nn-saea"] === true, setrankAvailable = status.strategies?.setrank === true, neuralucbAvailable = status.strategies?.neuralucb === true, neuralAvailable = status.strategies?.neural === true, e2eCTQAvailable = status.strategies?.["e2e-ctq"] === true, rlAvailable = status.strategies?.rl !== false, milpAvailable = status.strategies?.milp === true;
    state.algorithmMetadata = status.algorithmMetadata || {};
    document.getElementById("loadlockMacroStrategyInput").disabled = !loadlockMacroAvailable;
    document.getElementById("nnSAEAStrategyInput").disabled = !nnSAEAAvailable;
    document.getElementById("setrankStrategyInput").disabled = !setrankAvailable;
    document.getElementById("neuralucbStrategyInput").disabled = !neuralucbAvailable;
    document.getElementById("neuralStrategyInput").disabled = !neuralAvailable;
    document.getElementById("e2eCTQStrategyInput").disabled = !e2eCTQAvailable;
    document.getElementById("rlStrategyInput").disabled = !rlAvailable;
    document.getElementById("milpStrategyInput").disabled = !milpAvailable;
    renderOtherAlgorithmOptions(status.otherAlgorithms || []);
    runButton.disabled = !compatible;
    batchRunButton.disabled = !compatible;
    comparisonButton.disabled = !compatible || !state.parameterComparison?.baseline;
    renderWorkspaceControls();
    pill.textContent = compatible ? "\u672C\u5730\u670D\u52A1\u5DF2\u8FDE\u63A5" : "\u670D\u52A1\u7248\u672C\u8FC7\u65E7";
    if (!compatible) {
      pill.style.color = "var(--red)";
      pill.style.background = "var(--red-soft)";
      writeTerminal("$ \u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\n  \u8BF7\u91CD\u542F: py scripts/config_editor_server.py", true);
    }
  } catch {
    state.serviceCompatible = false;
    runButton.disabled = true;
    batchRunButton.disabled = true;
    comparisonButton.disabled = true;
    renderWorkspaceControls();
    pill.textContent = "\u672C\u5730\u670D\u52A1\u672A\u8FDE\u63A5";
    pill.style.color = "var(--red)";
    pill.style.background = "var(--red-soft)";
    writeTerminal("$ \u65E0\u6CD5\u8FDE\u63A5\u672C\u5730\u670D\u52A1\n  \u8BF7\u8FD0\u884C: py scripts/config_editor_server.py", true);
  }
}
document.getElementById("workspaceDialogCancel").addEventListener("click", () => document.getElementById("workspaceDialog").close("cancel"));
document.getElementById("cleanDialogCancel").addEventListener("click", () => {
  document.getElementById("cleanDialog").close();
  state.cleanDialogContext = null;
});
document.getElementById("cleanDialog").addEventListener("close", () => {
  state.cleanDialogContext = null;
});
document.getElementById("cleanPlacement").addEventListener("change", updateCleanDialogFields);
document.getElementById("cleanType").addEventListener("change", updateCleanDialogFields);
document.getElementById("cleanDialogForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveCleanDialog();
});
document.getElementById("deviceFile").addEventListener("change", (event) => loadDevice(event.target.files[0]).catch((error) => {
  event.target.value = "";
  writeTerminal(`$ \u8BBE\u5907\u8BFB\u53D6\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("deviceSelect").addEventListener("change", (event) => (async () => {
  if (state.dirty) await saveCurrentTest(true);
  await selectWorkspaceDevice(event.target.value);
})().catch((error) => writeTerminal(`$ \u8BBE\u5907\u5207\u6362\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("testGroupSelect").addEventListener("change", (event) => selectWorkspaceGroup(event.target.value).catch((error) => writeTerminal(`$ \u6D4B\u8BD5\u7EC4\u522B\u5207\u6362\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("testCaseSelect").addEventListener("change", (event) => selectWorkspaceTest(event.target.value).catch((error) => writeTerminal(`$ \u6D4B\u8BD5\u96C6\u5207\u6362\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("testCaseName").addEventListener("input", (event) => {
  state.testCaseName = event.target.value;
  markTestDirty();
});
document.getElementById("newGroupButton").addEventListener("click", () => createTestGroup().catch((error) => writeTerminal(`$ \u65B0\u5EFA\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("renameGroupButton").addEventListener("click", () => renameCurrentTestGroup().catch((error) => {
  setWorkspaceStatus(`\u91CD\u547D\u540D\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25\uFF1A${error.message}`, "dirty");
  writeTerminal(`$ \u91CD\u547D\u540D\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("deleteGroupButton").addEventListener("click", () => deleteCurrentTestGroup().catch((error) => {
  setWorkspaceStatus(`\u5220\u9664\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25\uFF1A${error.message}`, "dirty");
  writeTerminal(`$ \u5220\u9664\u6D4B\u8BD5\u7EC4\u522B\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("newTestButton").addEventListener("click", () => createTestCase(false).catch((error) => writeTerminal(`$ \u65B0\u5EFA\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("emptyGroupNewTestButton").addEventListener("click", () => createTestCase(false).catch((error) => writeTerminal(`$ \u65B0\u5EFA\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("copyTestButton").addEventListener("click", () => createTestCase(true).catch((error) => writeTerminal(`$ \u590D\u5236\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("saveTestButton").addEventListener("click", () => saveCurrentTest(false).catch((error) => writeTerminal(`$ \u4FDD\u5B58\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("deleteTestButton").addEventListener("click", () => deleteCurrentTest().catch((error) => writeTerminal(`$ \u5220\u9664\u6D4B\u8BD5\u96C6\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("roundCount").addEventListener("input", (event) => {
  resizeRounds(event.target.value);
  markTestDirty();
});
document.getElementById("runButton").addEventListener("click", runPlan);
document.getElementById("batchRunButton").addEventListener("click", runCurrentTestGroup);
document.getElementById("openParameterComparisonDialogButton").addEventListener("click", openParameterComparisonDialog);
document.getElementById("parameterComparisonDialogCancel").addEventListener("click", () => document.getElementById("parameterComparisonDialog").close());
document.getElementById("parameterComparisonStrategy").addEventListener("change", (event) => {
  const baselineOptions = state.parameterComparison?.baseline?.options || {};
  renderParameterComparisonStrategyFields(event.target.value, baselineOptions);
});
document.getElementById("parameterComparisonForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runParameterComparison().catch((error) => {
    document.getElementById("parameterComparisonDialogStatus").textContent = error.message || "\u672A\u77E5\u9519\u8BEF";
    writeTerminal(`$ \u53C2\u6570\u5BF9\u6BD4\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
  });
});
document.getElementById("clearExportsButton").addEventListener("click", clearExportedArtifacts);
document.getElementById("batchOverviewButton").addEventListener("click", showCurrentBatchOverview);
document.getElementById("testGroupAnalysisButton").addEventListener("click", () => {
  showTestGroupAnalysis().catch((error) => writeTerminal(`$ \u6D4B\u8BD5\u7EC4\u7ED3\u679C\u5206\u6790\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
});
document.getElementById("logButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("ganttButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("batchLogButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("batchGanttButton").addEventListener("click", (event) => {
  if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault();
});
document.getElementById("closeDrawer").addEventListener("click", closeStepDrawer);
document.getElementById("drawerLayer").addEventListener("click", (event) => {
  if (event.target.id === "drawerLayer") closeStepDrawer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeStepDrawer();
});
document.addEventListener("keydown", (event) => {
  const card = event.target.closest?.("[data-step-card]");
  if (card && event.key === "Enter") openStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex));
});
document.addEventListener("input", (event) => {
  if (event.target.matches("[data-scope], [data-option], [data-time-index], [data-round-time-index]")) updateStateFromControl(event.target);
});
document.addEventListener("change", (event) => {
  if (event.target.matches("[data-scope], [data-option], [data-time-index], [data-round-time-index]")) {
    updateStateFromControl(event.target);
    if (["name", "cleanType", "recipeTime", "wacRecipeTime", "jobType", "waferCount", ...ROUTE_CLEAN_KEYS].includes(event.target.dataset.key) || event.target.dataset.timeIndex !== void 0 || event.target.dataset.roundTimeIndex !== void 0 || ["stage-candidates", "stage-candidate-toggle", "cjob", "pjob", "pjob-route-group"].includes(event.target.dataset.scope)) renderAll();
    else if (state.drawer) {
      renderRoutes();
      renderStepDrawer();
    }
  }
  if (event.target.name === "strategy") {
    state.strategy = event.target.value;
    if (["neural", "e2e-ctq"].includes(state.strategy)) state.options.loadLockManager = "joint";
    else if (["heuristic", "loadlock-macro", "nn-saea", "setrank", "neuralucb", "rl"].includes(state.strategy)) state.options.loadLockManager = "petri-look";
    if (state.strategy === "milp") {
      resizeRounds(1);
      document.getElementById("roundCount").value = 1;
    }
    document.getElementById("roundCount").disabled = state.strategy === "milp";
    document.getElementById("loadlockOptions").classList.toggle("is-hidden", !["heuristic", "loadlock-macro", "nn-saea", "setrank", "neuralucb", "neural", "e2e-ctq", "rl"].includes(state.strategy));
    document.getElementById("heuristicObjectiveOptions").classList.toggle("is-hidden", !["heuristic", "loadlock-macro"].includes(state.strategy));
    document.getElementById("nnSAEAOptions").classList.toggle("is-hidden", state.strategy !== "nn-saea");
    document.getElementById("neuralucbOptions").classList.toggle("is-hidden", state.strategy !== "neuralucb");
    document.getElementById("rlOptions").classList.toggle("is-hidden", state.strategy !== "rl");
    document.getElementById("milpOptions").classList.toggle("is-hidden", state.strategy !== "milp");
    showAlgorithmDetails(state.strategy);
    markTestDirty();
    renderAll();
  }
});
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab-target]");
  if (tab) switchTab(tab.dataset.tabTarget);
  const robotSlotChoice = event.target.closest("[data-robot-slot-name][data-robot-slot-count]");
  if (robotSlotChoice && !robotSlotChoice.disabled) {
    setRobotSlotCount(robotSlotChoice.dataset.robotSlotName, Number(robotSlotChoice.dataset.robotSlotCount)).catch((error) => writeTerminal(`$ \u673A\u5668\u624B\u69FD\u4F4D\u4FDD\u5B58\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  const robotSlotDefault = event.target.closest("[data-robot-slot-default]");
  if (robotSlotDefault && !robotSlotDefault.disabled) {
    restoreRobotSlotDefault(robotSlotDefault.dataset.robotSlotDefault).catch((error) => writeTerminal(`$ \u673A\u5668\u624B\u9ED8\u8BA4\u914D\u7F6E\u6062\u590D\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  const batchResultCard = event.target.closest("[data-batch-item-index]");
  if (batchResultCard && !event.target.closest(".batch-result-meta")) selectBatchItem(Number(batchResultCard.dataset.batchItemIndex));
  const workspaceResult = event.target.closest("[data-workspace-result]");
  if (workspaceResult) {
    visualizationWorkspace.loadResult(workspaceResult.dataset.workspaceResult, workspaceResult.dataset.workspaceName).then(() => visualizationWorkspace.show()).catch((error) => writeTerminal(`$ \u5DE5\u4F5C\u53F0\u52A0\u8F7D\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
    return;
  }
  const button = event.target.closest("[data-action]");
  if (button && !button.disabled) {
    handleAction(button);
    return;
  }
  const card = event.target.closest("[data-step-card]");
  if (card) openStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex));
});
window.addEventListener("pagehide", () => {
  if (!state.dirty || !state.workspaceDeviceId || !state.testCaseId) return;
  fetch(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(currentTestSnapshot()),
    keepalive: true
  }).catch(() => {
  });
});
initializeThemeToggle();
initializeCompactSelects();
renderAll();
renderWorkspaceControls();
checkService();
loadWorkspaceCatalog().catch((error) => setWorkspaceStatus(`\u6D4B\u8BD5\u96C6\u8BFB\u53D6\u5931\u8D25\uFF1A${error.message}`, "dirty"));
