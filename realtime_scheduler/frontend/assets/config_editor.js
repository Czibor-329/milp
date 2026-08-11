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
  normalizeStageProcessRecipes: () => normalizeStageProcessRecipes,
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
function normalizeStageProcessRecipes(stage, recipeName, normalizeVisit2 = (value) => value) {
  const needsProcess = stage.needProcess === true;
  let changed = false;
  for (const visit of stage.visits || []) {
    normalizeVisit2(visit);
    const normalizedRecipe = needsProcess ? processRecipeName(visit.processRecipe, recipeName) : "";
    if (visit.processRecipe !== normalizedRecipe) {
      visit.processRecipe = normalizedRecipe;
      changed = true;
    }
    if (needsProcess) {
      const normalizedRecipeTime = Number(visit.processTime);
      if (visit.recipeTime !== normalizedRecipeTime) {
        visit.recipeTime = normalizedRecipeTime;
        changed = true;
      }
    }
  }
  return changed;
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
async function requestSearchTelemetry(sinceRevision = null) {
  const query = sinceRevision === null ? "" : `?since=${encodeURIComponent(String(sinceRevision))}`;
  const result = await requestJson(`/api/search-telemetry${query}`, {
    cache: "no-store"
  });
  return result.telemetry;
}
async function requestSearchControl(command, actionKey = null) {
  return requestJson("/api/search-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actionKey ? { command, actionKey } : { command })
  });
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
function formatSeconds2(value) {
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
function isTopologyHiddenModule(module) {
  const name = module.name.trim();
  const type = module.type.trim().toLowerCase();
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
  const configuredRobotNames = new Set(Object.keys(device?.Robots ?? {}));
  for (const [name, definition] of Object.entries(device?.Stations ?? {})) {
    if (knownNames.has(name) || isRobotName(name, configuredRobotNames)) continue;
    const type = String(definition?.Type ?? "");
    if (isLoadPortName(name, type) && !isDummyPortName(name) && type.trim().toLowerCase() !== "dummyport") continue;
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
function moduleDoorSides(module, role, layout = "single", roleIndex = 0) {
  if (module.door === "doorless") return [];
  if (role === "lock") return [];
  if (role === "port") return ["top"];
  const name = module.name.trim().toUpperCase();
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
function renderModule(module, role, candidate, layout = "single", roleIndex = 0) {
  const waferProgress = module.status === "processing" ? module.progress : 0;
  const visibleWaferCount = role === "lock" ? 2 : 1;
  const processedWafers = new Set(module.processedWafers ?? []);
  const wafers = module.wafers.slice(0, visibleWaferCount).map((wafer) => renderWaferToken(wafer, waferProgress, processedWafers.has(wafer))).join("");
  const layerCount = role === "lock" && module.loadLockSlots.length ? module.loadLockSlots.filter((slot) => slot.wafer).length : module.wafers.length;
  const overflow = layerCount > visibleWaferCount ? `<span class="wafer-more">+ ${layerCount - visibleWaferCount}</span>` : "";
  const doors = moduleDoorSides(module, role, layout, roleIndex).map((side) => `<i class="chamber-door chamber-door-${side}"></i>`).join("");
  const accessibleStatus = `${module.name}\uFF0C${STATUS_LABELS[module.status]}\uFF0C${DOOR_LABELS[module.door]}`;
  const candidateLabel = candidate ? `${candidate.count} \u4E2A\u53EF\u884C\u52A8\u4F5C\uFF0C\u6700\u9AD8\u6A21\u578B\u504F\u597D ${(candidate.preference * 100).toFixed(0)}%` : "";
  if (role === "auxiliary" && (isBufferModule(module.name, module.type) || isCoolerModule(module.name, module.type))) {
    const utilityKind = isBufferModule(module.name, module.type) ? "buffer" : "cooler";
    const utilityBody = utilityKind === "buffer" ? `<div class="buffer-tray ${wafers ? "is-occupied" : "is-empty"}" aria-hidden="true"><span></span><span></span><span></span>${wafers}</div>` : `<div class="cooler-plate ${wafers ? "is-occupied" : "is-empty"}" aria-hidden="true"><span></span><i></i>${wafers}</div>`;
    return `<strong class="equipment-external-name equipment-external-name-${utilityKind}">${escapeHtml(module.name)}</strong>
      <article class="equipment-utility equipment-${utilityKind} status-${module.status} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
        ${utilityBody}
      </article>`;
  }
  const atmosphereLevel = role === "lock" ? module.loadLockPhase === "pumping" ? 100 - module.progress * 100 : module.loadLockPhase === "venting" ? module.progress * 100 : /大气|ATM|ATR/i.test(module.environment) ? 100 : 0 : 0;
  const loadLockLayers = role === "lock" ? `<div class="loadlock-layers" aria-hidden="true">${[0, 1].map((index) => {
    const layer = module.loadLockSlots[index];
    const wafer = layer ? layer.wafer : module.wafers[index];
    const processed = layer ? layer.processed : wafer ? processedWafers.has(wafer) : false;
    const waferState = processed ? "processed" : "unprocessed";
    return `<div class="loadlock-layer ${wafer ? "is-occupied" : "is-empty"}">${wafer ? `<span class="loadlock-wafer-line wafer-${waferState}" title="\u6676\u5706 ${escapeHtml(wafer)}\uFF08${processed ? "\u5DF2\u52A0\u5DE5" : "\u672A\u52A0\u5DE5"}\uFF09"></span>` : ""}</div>`;
  }).join("")}${overflow}</div>` : role === "process" ? `<div class="process-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : role === "port" ? `` : role === "auxiliary" ? `<div class="auxiliary-wafer-slot ${wafers ? "is-occupied" : "is-empty"}">${wafers}</div>` : `<div class="wafer-stack">${wafers}${overflow}</div>`;
  const bodyMarkup = role === "process" ? `<div class="equipment-process-shell"><div class="equipment-body">${loadLockLayers}</div></div>` : `<div class="equipment-body">${loadLockLayers}</div>`;
  const article = `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.loadLockPhase ? `loadlock-${module.loadLockPhase}` : ""} ${module.isRobotTarget ? "is-target" : ""} ${candidate ? "is-candidate-destination" : ""} ${candidate?.selected ? "is-model-selected" : ""}" style="--module-progress:${Math.round(module.progress * 100)}%;--loadlock-atmosphere:${Math.max(0, Math.min(100, atmosphereLevel)).toFixed(1)}%;--loadlock-atmosphere-ratio:${Math.max(0, Math.min(1, atmosphereLevel / 100)).toFixed(3)}" aria-label="${escapeHtml(`${accessibleStatus}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
       ${bodyMarkup}
      <div class="chamber-doors" aria-hidden="true">${role === "lock" ? '<i class="loadlock-door loadlock-door-vacuum"></i><i class="loadlock-door loadlock-door-atmosphere"></i>' : doors}</div>
    </article>`;
  if (role === "process" || role === "auxiliary" || role === "lock") {
    return `<strong class="equipment-external-name">${escapeHtml(module.name)}</strong>${article}`;
  }
  if (role === "port") {
    const isDummy = isDummyPortName(module.name) || module.type.trim().toLowerCase() === "dummyport";
    const portDoors = moduleDoorSides(module, role, layout, roleIndex).map((side) => `<i class="chamber-door chamber-door-${side}"></i>`).join("");
    return `<strong class="equipment-external-name ${isDummy ? "equipment-external-name-dummy" : "equipment-external-name-port"}">${escapeHtml(module.name)}</strong><div class="load-port-assembly ${isDummy ? "is-dummy-port" : "is-load-port"} door-${module.door}" role="group" aria-label="${escapeHtml(`${accessibleStatus}${isDummy ? "\uFF0CDummy Port" : ""}${candidateLabel ? `\uFF0C${candidateLabel}` : ""}`)}">
      ${isDummy ? '<span class="load-port-kind">DUMMY</span>' : ""}
      <div class="chamber-doors" aria-hidden="true">${portDoors}</div>
      ${renderLoadPortCassette(module)}
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
var TOPOLOGY_LOADPORT_WIDTH = 144;
var TOPOLOGY_LOADPORT_HEIGHT = 104;
var TOPOLOGY_LOADPORT_BASE_HEIGHT = 22;
var TOPOLOGY_LOADPORT_BASE_OVERHANG = 16;
var TOPOLOGY_BUFFER_WIDTH = 104;
var TOPOLOGY_BUFFER_HEIGHT = 56;
var TOPOLOGY_COOLER_WIDTH = 92;
var TOPOLOGY_COOLER_HEIGHT = 54;
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
  const hasMultiProcessChamber = modules.some((module) => isMultiProcessChamberType(module.type));
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
function moduleTopologyPosition(module, role, index, roleModules, layout, bridgeLoadLockNames = /* @__PURE__ */ new Set()) {
  const name = module.name.trim().toUpperCase();
  const roleCount = roleModules.length;
  const column = TOPOLOGY_COLUMN_PERCENTAGES;
  const row = TOPOLOGY_ROW_TOP_PIXELS;
  if (layout === "cascade" && role === "process") {
    const ordered = [...roleModules].sort((left, right) => naturalCompare(left.name, right.name));
    const layoutIndex = Math.max(0, ordered.findIndex((item) => item.name === module.name));
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
    const layoutIndex = Math.max(0, ordered.findIndex((item) => item.name === module.name));
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
  if (layout === "cascade" && role === "lock" && bridgeLoadLockNames.has(module.name)) {
    const bridgeIndex = [...bridgeLoadLockNames].indexOf(module.name);
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
    const gridIndex = Math.max(0, orderedLoadLocks.findIndex((item) => item.name === module.name));
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
    const portIndex = Math.max(0, orderedPorts.findIndex((item) => item.name === module.name));
    const currentIsDummy = isDummyPortName(module.name) || module.type.trim().toLowerCase() === "dummyport";
    const portColumns = roleCount <= column.length ? column : Array.from({ length: roleCount }, (_, current) => 16 + current * 58 / (roleCount - 1));
    const loadPortTop = layout === "cascade" ? TOPOLOGY_CASCADE_LOADPORT_TOP : TOPOLOGY_LOADPORT_ROW_TOP_PIXELS;
    return {
      /* 四列语义固定为 LP1 / LP2 / LP3 / Dummy Port；缺少 LP3 时保留空位。 */
      leftPercent: currentIsDummy && roleCount <= column.length ? column[3] : portColumns[portIndex] ?? column[0],
      topPixels: loadPortTop,
      widthPixels: TOPOLOGY_LOADPORT_WIDTH,
      heightPixels: TOPOLOGY_LOADPORT_HEIGHT
    };
  }
  if (["AL", "ALIGNER"].includes(name)) {
    return { leftPercent: column[0], topPixels: layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS };
  }
  if (role === "auxiliary" && (isBufferModule(module.name, module.type) || isCoolerModule(module.name, module.type))) {
    const atmosphereTop = layout === "cascade" ? TOPOLOGY_CASCADE_ATM_TOP : TOPOLOGY_ATMOSPHERE_ROW_TOP_PIXELS;
    const rightUtilities = roleModules.filter((item) => isBufferModule(item.name, item.type) || isCoolerModule(item.name, item.type)).sort((left, right) => {
      const leftRank = isCoolerModule(left.name, left.type) ? 0 : 1;
      const rightRank = isCoolerModule(right.name, right.type) ? 0 : 1;
      return leftRank - rightRank || naturalCompare(left.name, right.name);
    });
    const utilityIndex = Math.max(0, rightUtilities.findIndex((item) => item.name === module.name));
    const utilityTop = atmosphereTop + utilityIndex * 68;
    const buffer = isBufferModule(module.name, module.type);
    return {
      leftPercent: 90,
      topPixels: utilityTop,
      widthPixels: buffer ? TOPOLOGY_BUFFER_WIDTH : TOPOLOGY_COOLER_WIDTH,
      heightPixels: buffer ? TOPOLOGY_BUFFER_HEIGHT : TOPOLOGY_COOLER_HEIGHT
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
function isModuleFilteredOut(module, hiddenFilters) {
  if (!hiddenFilters?.size) return false;
  const normalized = module.name.trim().toUpperCase();
  const type = module.type.trim().toLowerCase();
  return hiddenFilters.has("aligner") && (/^(AL|ALIGNER)$/.test(normalized) || type === "aligner") || hiddenFilters.has("cooler") && (/^(CL|COOL(?:ER)?)$/.test(normalized) || type === "cooler");
}
function renderEquipmentTopology(snapshot, decision, hiddenFilters, device) {
  const visibleModules = snapshot.modules.filter((module) => !isTopologyHiddenModule(module) && !isModuleFilteredOut(module, hiddenFilters));
  const groups = topologyGroups(visibleModules);
  const destinations = candidateDestinations(decision);
  const atmosphereRobots = snapshot.robots.filter((robot) => robot.environment === "atmosphere" || !robot.environment && /^(ATR|ATM)/i.test(robot.name));
  const atmosphereNames = new Set(atmosphereRobots.map((robot) => robot.name));
  const vacuumRobots = snapshot.robots.filter((robot) => !atmosphereNames.has(robot.name));
  const layout = device ? detectDeviceTopologyLayout(device) : detectTopologyLayout(visibleModules, snapshot.robots.length);
  const loadLockNameSet = new Set(groups.loadLocks.map((module) => module.name));
  const configuredLoadLockOrder = Object.keys(device?.Stations ?? {}).filter((name) => loadLockNameSet.has(name));
  const orderedLoadLockNames = configuredLoadLockOrder.length === groups.loadLocks.length ? configuredLoadLockOrder : groups.loadLocks.map((module) => module.name);
  const bridgeLoadLockNames = layout === "cascade" ? cascadeBridgeLoadLockNames(
    orderedLoadLockNames,
    device,
    vacuumRobots.map((robot) => robot.name)
  ) : /* @__PURE__ */ new Set();
  const modulePositions = /* @__PURE__ */ new Map();
  const positionModuleGroup = (modules, role) => modules.forEach((module, index) => {
    const position = moduleTopologyPosition(module, role, index, modules, layout, bridgeLoadLockNames);
    modulePositions.set(module.name, position);
  });
  positionModuleGroup(groups.processModules, "process");
  positionModuleGroup(groups.loadLocks, "lock");
  positionModuleGroup(groups.loadPorts, "port");
  positionModuleGroup(groups.auxiliaryModules, "auxiliary");
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
  const positionedModules = (modules) => modules.map((module) => modulePositions.get(module.name)).filter((position) => Boolean(position));
  const positionedRobots = (robots) => robots.map((robot) => robotPositions.get(robot.name)).filter((position) => Boolean(position));
  const interfaceLoadLocks = groups.loadLocks.filter((module) => !bridgeLoadLockNames.has(module.name));
  const vacuumExtent = topologyVerticalExtent([
    ...positionedModules(groups.processModules),
    ...positionedRobots(vacuumRobots),
    ...positionedModules(groups.loadLocks.filter((module) => bridgeLoadLockNames.has(module.name)))
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
    groups.auxiliaryModules.forEach((module) => shiftPosition(modulePositions.get(module.name)));
    groups.loadPorts.forEach((module) => shiftPosition(modulePositions.get(module.name)));
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
  const renderModuleGroup = (modules, role) => modules.map((module, roleIndex) => {
    const position = modulePositions.get(module.name);
    if (!position) return "";
    return `<div class="reference-module-position" style="--module-left:${position.leftPercent}%;--module-top:${position.topPixels}px">${renderModule(module, role, destinations.get(module.name), layout, roleIndex)}</div>`;
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
    renderModuleGroup(groups.processModules, "process"),
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
        <strong id="decisionCandidatesTitle">\u51B3\u7B56 #${decision.decisionIndex} <small>@ ${formatSeconds2(decision.time)}s</small></strong>
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
        <strong id="dualActorDecisionTitle">\u51B3\u7B56 #${decision.decisionIndex} <small>@ ${formatSeconds2(decision.time)}s</small></strong>
        <span>\u53CC Actor \xB7 ${decision.replayEvaluated ? "\u56DE\u653E\u91CD\u8BC4\u4F30" : "\u539F\u59CB\u6A21\u578B\u51B3\u7B56"}</span>
      </header>
      <div class="dual-actor-recommendation-list">${groupMarkup}</div>
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
function withWaferResidenceTimes(performance2, moves, device) {
  if (performance2.waferSystemResidenceTimes?.length || !moves.length) return performance2;
  const entries = /* @__PURE__ */ new Map();
  const completions = /* @__PURE__ */ new Map();
  const stationType = (name) => String(device?.Stations?.[name]?.Type ?? "");
  for (const move of normalizeMoves(moves)) {
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      const source = firstStation(move, "SrcStationList");
      if (!isLoadPortName(source, stationType(source))) continue;
      for (const material of materialIds(move)) {
        if (!entries.has(material)) entries.set(material, move.EndTime);
      }
    } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
      const destination = firstStation(move, "DestStationList");
      if (!isLoadPortName(destination, stationType(destination))) continue;
      for (const material of materialIds(move)) completions.set(material, move.EndTime);
    } else if (move.MoveType === SWAP_MOVE) {
      const station = firstStation(move, "StationList");
      if (!isLoadPortName(station, stationType(station))) continue;
      for (const material of materialIds(move, "SendMatList")) {
        if (!entries.has(material)) entries.set(material, move.EndTime);
      }
      for (const material of materialIds(move, "RecvMatList")) {
        completions.set(material, move.EndTime);
      }
    }
  }
  const samples = [];
  for (const [wafer, completedAt] of completions) {
    const enteredAt = entries.get(wafer);
    if (enteredAt === void 0 || completedAt < enteredAt - PERFORMANCE_DISPLAY_TOLERANCE) continue;
    samples.push({ wafer, enteredAt, completedAt, duration: completedAt - enteredAt });
  }
  samples.sort((left, right) => left.completedAt - right.completedAt || naturalCompare(left.wafer, right.wafer));
  return samples.length ? { ...performance2, waferSystemResidenceTimes: samples } : performance2;
}
function renderBottleneckAnalysis(performance2) {
  const { window: window2 } = performance2;
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
      </div>
      <label class="bottleneck-window-control"><span class="visually-hidden">\u7EDF\u8BA1\u53E3\u5F84</span><div class="bottleneck-window-slot"></div></label>
    </header>
    <div class="resource-utilization-head" aria-hidden="true"><span>\u8D44\u6E90</span><span>\u5229\u7528\u7387</span><span>\u5360\u7528\u7EC4\u6210</span><span>\u6D3B\u8DC3\u65F6\u957F</span><span>\u74F6\u9888\u8BC1\u636E\u5F97\u5206</span></div>
    <ol class="resource-utilization-list">
      ${resourceRows(displayedResources)}
    </ol>
    <div class="performance-legend" aria-label="\u5360\u7528\u7EC4\u6210\u56FE\u4F8B">${legend}</div>
  `;
}
function renderWaferResidenceChart(performance2) {
  const samples = performance2.waferSystemResidenceTimes ?? [];
  if (!samples.length) {
    return `
      <header class="residence-chart-head"><strong>\u7CFB\u7EDF\u9A7B\u7559\u65F6\u95F4\u5206\u6790</strong></header>
      <div class="residence-chart-empty">\u5F53\u524D\u7ED3\u679C\u4E2D\u6CA1\u6709\u5B8C\u6210\u5F80\u8FD4 LoadPort \u7684\u6676\u5706\u3002</div>`;
  }
  const meanSeconds = samples.reduce((sum, sample) => sum + sample.duration, 0) / samples.length;
  const maximumSeconds = Math.max(...samples.map((sample) => sample.duration));
  const minimumSeconds = Math.min(...samples.map((sample) => sample.duration));
  const rangeToMinimumPercent = minimumSeconds > PERFORMANCE_DISPLAY_TOLERANCE ? (maximumSeconds - minimumSeconds) / minimumSeconds * 100 : null;
  const plotHeight = 170;
  const scaleMaximum = Math.max(maximumSeconds, 1) * 1.08;
  const meanHeight = Math.min(meanSeconds / scaleMaximum * plotHeight, plotHeight);
  const bars = samples.map((sample) => {
    const height = Math.max(sample.duration / scaleMaximum * plotHeight, 2);
    const wafer = escapeHtml(String(sample.wafer));
    const duration = formatSeconds2(sample.duration);
    return `
      <li class="residence-bar-item" role="img" aria-label="\u6676\u5706 ${wafer}\uFF0C\u7CFB\u7EDF\u9A7B\u7559 ${duration} \u79D2" title="\u6676\u5706 ${wafer} \xB7 \u79BB\u5F00 ${formatSeconds2(sample.enteredAt)} s \xB7 \u8FD4\u56DE ${formatSeconds2(sample.completedAt)} s \xB7 \u9A7B\u7559 ${duration} s">
        <strong>${duration}</strong>
        <span class="residence-bar-track"><i style="height:${height.toFixed(2)}px"></i></span>
        <small>${wafer}</small>
      </li>`;
  }).join("");
  return `
    <header class="residence-chart-head">
      <strong>\u7CFB\u7EDF\u9A7B\u7559\u65F6\u95F4\u5206\u6790</strong>
      <div class="residence-chart-summary">
        <span>\u5E73\u5747 <b>${formatSeconds2(meanSeconds)} s</b></span>
        <span>\u6700\u5927 <b>${formatSeconds2(maximumSeconds)} s</b></span>
        <span>\u6781\u5DEE/\u6700\u5C0F\u503C <b>${rangeToMinimumPercent === null ? "\u2014" : `${rangeToMinimumPercent.toFixed(1)}%`}</b></span>
        <span>\u6837\u672C <b>${samples.length} \u7247</b></span>
      </div>
    </header>
    <div class="residence-chart-body">
      <div class="residence-chart-scroll" tabindex="0" aria-label="\u9010\u7247\u6676\u5706\u7CFB\u7EDF\u9A7B\u7559\u65F6\u95F4\u67F1\u72B6\u56FE\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8">
        <div class="residence-chart-plot">
          <div class="residence-mean-line" style="bottom:${(28 + meanHeight).toFixed(2)}px"><span>\u5E73\u5747 ${formatSeconds2(meanSeconds)} s</span></div>
          <ol class="residence-bars">${bars}</ol>
        </div>
      </div>
    </div>`;
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

    <section class="result-card wafer-residence-card">
      ${renderWaferResidenceChart(performance2)}
    </section>

    <section class="result-card bottleneck-analysis-card">
      ${renderBottleneckAnalysis(performance2)}
    </section>

    <section class="result-card loadlock-swap-card">
      ${renderLoadLockCard(performance2)}
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
    this.updateRecommendationModelControl();
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
  async loadMoves(moves, decisionTrace, sourceName, resultUrl, analysisResultId) {
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
    const state2 = this.pauseTriggeredByDecisionChange ? "\u5DF2\u6682\u505C" : this.pauseOnDecisionChange ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED";
    const decisionKind = this.recommendationModel === "dual-actor-e2e" ? "\u539F\u5B50\u52A8\u4F5C\u51B3\u7B56" : "\u5B8C\u6574\u4E8B\u52A1\u51B3\u7B56";
    this.elements.pauseOnDecisionChangeButton.innerHTML = `
      <span class="decision-switch-copy"><span>\u4E0B\u4E00\u51B3\u7B56\u65F6\u6682\u505C</span><strong>${state2}</strong></span>
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
  /** 切换画布模块筛选；有 MoveList 时立即按新筛选重绘拓扑。 */
  setModuleFilter(key, hidden) {
    if (hidden) this.hiddenModuleFilters.add(key);
    else this.hiddenModuleFilters.delete(key);
    if (this.moves.length) this.render();
  }
  /** 绘制当前时间对应的设备快照。 */
  render(prebuiltSnapshot) {
    if (!this.moves.length && !this.liveSolving) return;
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
      this.hiddenModuleFilters,
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
          <time>${formatSeconds2(finiteNumber(move.StartTime))}\u2013${formatSeconds2(finiteNumber(move.EndTime))} s</time>
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
        rounds: this.analysisRounds
      });
      if (requestVersion !== this.analysisRequestVersion) return;
      const analysis = withWaferResidenceTimes(result.analysis, this.moves, this.device);
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

// src/documentation_view.ts
function escapeHtml3(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeHref(rawHref) {
  const href = rawHref.trim();
  return /^(?:https?:\/\/|mailto:|\/|#)/i.test(href) ? href : "#";
}
function renderInline(source) {
  const tokens = [];
  const tokenized = source.replace(/`([^`]+)`/g, (_match, code) => {
    const index = tokens.push(`<code>${escapeHtml3(code)}</code>`) - 1;
    return `\0${index}\0`;
  });
  const escaped = escapeHtml3(tokenized).replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_match, label, href, title) => {
    const safe = escapeHtml3(safeHref(href));
    const external = /^https?:\/\//i.test(href);
    const titleAttribute = title ? ` title="${escapeHtml3(title)}"` : "";
    const externalAttributes = external ? ' target="_blank" rel="noreferrer"' : "";
    return `<a href="${safe}"${titleAttribute}${externalAttributes}>${label}</a>`;
  }).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>").replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return escaped.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || "");
}
function headingId(text, counts) {
  const base = text.replace(/[`*_~]/g, "").trim().toLocaleLowerCase("zh-CN").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}
function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}
function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
function startsBlock(lines, index) {
  const line = lines[index] || "";
  return /^#{1,3}\s+/.test(line) || /^```/.test(line) || /^>\s?/.test(line) || /^\s*(?:[-+*]|\d+\.)\s+/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line) || line.includes("|") && isTableSeparator(lines[index + 1] || "");
}
function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  const headings = [];
  const headingCounts = /* @__PURE__ */ new Map();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/\s+#+\s*$/, "").trim();
      const id = headingId(text, headingCounts);
      if (level > 1) headings.push({ id, level, text });
      html.push(`<h${level} id="${escapeHtml3(id)}">${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1] || "text";
      html.push(`<figure class="documentation-code"><figcaption>${escapeHtml3(language)}</figcaption><pre><code>${escapeHtml3(codeLines.join("\n"))}</code></pre></figure>`);
      continue;
    }
    if (line.includes("|") && isTableSeparator(lines[index + 1] || "")) {
      const headers = splitTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push(`<div class="documentation-table-wrap"><table><thead><tr>${headers.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_header, cellIndex) => `${cellIndex === 0 ? '<th scope="row">' : "<td>"}${renderInline(row[cellIndex] || "")}${cellIndex === 0 ? "</th>" : "</td>"}`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      const callout = /^\[!(NOTE|TIP|IMPORTANT|WARNING)\]\s*(.*)$/i.exec(quoted[0] || "");
      if (callout) {
        const tone = callout[1].toLocaleLowerCase();
        const body = [callout[2], ...quoted.slice(1)].filter(Boolean).join(" ");
        const labels = { note: "\u8BF4\u660E", tip: "\u63D0\u793A", important: "\u91CD\u8981", warning: "\u6CE8\u610F" };
        html.push(`<aside class="documentation-callout is-${tone}" role="note"><strong>${labels[tone]}</strong><p>${renderInline(body)}</p></aside>`);
      } else {
        html.push(`<blockquote>${renderInline(quoted.join(" "))}</blockquote>`);
      }
      continue;
    }
    const listMatch = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const items = [];
      const listPattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
      while (index < lines.length) {
        const item = listPattern.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }
  return { html: html.join("\n"), headings };
}
function groupedPages(pages) {
  const groups = /* @__PURE__ */ new Map();
  pages.forEach((page) => groups.set(page.group, [...groups.get(page.group) || [], page]));
  return Array.from(groups.entries());
}
function documentationHash(slug, heading = "") {
  return `#documentation/${encodeURIComponent(slug)}${heading ? `/${encodeURIComponent(heading)}` : ""}`;
}
function hashLocation() {
  const match = /^#documentation\/([^/]+)(?:\/(.+))?$/.exec(window.location.hash);
  if (!match) return null;
  return {
    slug: decodeURIComponent(match[1]),
    heading: match[2] ? decodeURIComponent(match[2]) : ""
  };
}
var DocumentationView = class {
  root;
  document = null;
  activeSlug = "";
  loadingPromise = null;
  observer = null;
  constructor(root) {
    this.root = root;
    this.root.addEventListener("click", (event) => this.handleClick(event));
    window.addEventListener("hashchange", () => this.syncFromHash());
  }
  load(force = false) {
    if (this.document && !force) {
      this.syncFromHash();
      return Promise.resolve();
    }
    if (this.loadingPromise && !force) return this.loadingPromise;
    this.renderLoading();
    this.loadingPromise = this.fetchAndRender().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  }
  async fetchAndRender() {
    try {
      const response = await fetch("/api/documentation", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok || !payload.document?.pages.length) {
        throw new Error(payload.error || "\u6587\u6863\u63A5\u53E3\u672A\u8FD4\u56DE Markdown \u9875\u9762");
      }
      this.document = payload.document;
      const requested = hashLocation();
      this.activeSlug = payload.document.pages.some((page) => page.slug === requested?.slug) ? requested.slug : payload.document.pages[0].slug;
      this.renderPage(requested?.heading || "");
    } catch (error) {
      this.document = null;
      this.renderError(error instanceof Error ? error.message : "\u6587\u6863\u52A0\u8F7D\u5931\u8D25");
    }
  }
  renderLoading() {
    this.root.setAttribute("aria-busy", "true");
    this.root.innerHTML = `<div class="documentation-state" role="status"><span class="documentation-spinner" aria-hidden="true"></span><strong>\u6B63\u5728\u8BFB\u53D6\u672C\u5730 Markdown</strong><p>\u5185\u5BB9\u6765\u81EA realtime_scheduler/data/documentation\uFF0C\u4E0D\u4F1A\u8FDB\u5165 Git\u3002</p></div>`;
  }
  renderError(message) {
    this.root.removeAttribute("aria-busy");
    this.root.innerHTML = `<div class="documentation-state is-error" role="alert"><span aria-hidden="true">!</span><strong>\u6587\u6863\u6682\u4E0D\u53EF\u7528</strong><p>${escapeHtml3(message)}</p><button class="btn primary" type="button" data-documentation-retry>\u91CD\u65B0\u8BFB\u53D6</button></div>`;
  }
  renderPage(pendingHeading = "") {
    if (!this.document) return;
    const pageIndex = this.document.pages.findIndex((page2) => page2.slug === this.activeSlug);
    const page = this.document.pages[Math.max(0, pageIndex)];
    const rendered = renderMarkdown(page.markdown);
    const previous = pageIndex > 0 ? this.document.pages[pageIndex - 1] : null;
    const next = pageIndex < this.document.pages.length - 1 ? this.document.pages[pageIndex + 1] : null;
    this.root.removeAttribute("aria-busy");
    this.root.innerHTML = `<div class="documentation-layout">
      <nav class="documentation-navigation" aria-label="\u6587\u6863\u9875\u9762">
        ${groupedPages(this.document.pages).map(([group, pages]) => `<section><strong>${escapeHtml3(group)}</strong>${pages.map((item) => `<a href="${documentationHash(item.slug)}" data-documentation-page="${escapeHtml3(item.slug)}"${item.slug === page.slug ? ' aria-current="page"' : ""}>${escapeHtml3(item.title)}</a>`).join("")}</section>`).join("")}
      </nav>
      <main class="documentation-content" data-documentation-content>
        <p class="documentation-breadcrumb">\u4F7F\u7528\u6587\u6863 <span aria-hidden="true">/</span> ${escapeHtml3(page.group)}</p>
        <article class="documentation-markdown">${rendered.html}</article>
        <nav class="documentation-pagination" aria-label="\u76F8\u90BB\u6587\u6863\u9875\u9762">
          ${previous ? `<a href="${documentationHash(previous.slug)}" data-documentation-page="${escapeHtml3(previous.slug)}"><small>\u4E0A\u4E00\u9875</small><strong>\u2190 ${escapeHtml3(previous.title)}</strong></a>` : "<span></span>"}
          ${next ? `<a href="${documentationHash(next.slug)}" data-documentation-page="${escapeHtml3(next.slug)}"><small>\u4E0B\u4E00\u9875</small><strong>${escapeHtml3(next.title)} \u2192</strong></a>` : ""}
        </nav>
      </main>
      <aside class="documentation-on-page" aria-label="\u5F53\u524D\u9875\u9762\u76EE\u5F55">
        <strong><span aria-hidden="true">\u2630</span> \u672C\u9875\u5185\u5BB9</strong>
        ${rendered.headings.length ? rendered.headings.map((heading) => `<a class="is-level-${heading.level}" href="${documentationHash(page.slug, heading.id)}" data-documentation-heading="${escapeHtml3(heading.id)}">${escapeHtml3(heading.text)}</a>`).join("") : "<span>\u672C\u9875\u6682\u65E0\u5C0F\u8282</span>"}
      </aside>
    </div>`;
    this.observeHeadings();
    requestAnimationFrame(() => {
      const target = pendingHeading ? this.root.querySelector(`#${CSS.escape(pendingHeading)}`) : this.root.querySelector(".documentation-markdown h1");
      target?.scrollIntoView({ block: "start" });
    });
  }
  handleClick(event) {
    const target = event.target;
    if (target?.closest("[data-documentation-retry]")) {
      void this.load(true);
      return;
    }
    const pageLink = target?.closest("[data-documentation-page]");
    if (pageLink?.dataset.documentationPage) {
      event.preventDefault();
      this.showPage(pageLink.dataset.documentationPage);
      return;
    }
    const headingLink = target?.closest("[data-documentation-heading]");
    if (headingLink?.dataset.documentationHeading) {
      event.preventDefault();
      const heading = headingLink.dataset.documentationHeading;
      history.replaceState(null, "", documentationHash(this.activeSlug, heading));
      this.root.querySelectorAll("[data-documentation-heading]").forEach((link) => {
        if (link.dataset.documentationHeading === heading) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
      this.root.querySelector(`#${CSS.escape(heading)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  showPage(slug) {
    if (!this.document?.pages.some((page) => page.slug === slug)) return;
    this.activeSlug = slug;
    history.replaceState(null, "", documentationHash(slug));
    this.renderPage();
  }
  syncFromHash() {
    const requested = hashLocation();
    if (!requested || !this.document?.pages.some((page) => page.slug === requested.slug)) return;
    if (requested.slug !== this.activeSlug) {
      this.activeSlug = requested.slug;
      this.renderPage(requested.heading);
      return;
    }
    if (requested.heading) {
      this.root.querySelector(`#${CSS.escape(requested.heading)}`)?.scrollIntoView({ block: "start" });
    }
  }
  observeHeadings() {
    this.observer?.disconnect();
    if (!("IntersectionObserver" in window)) return;
    this.observer = new IntersectionObserver((entries) => {
      const current = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (!current) return;
      const id = current.target.id;
      this.root.querySelectorAll("[data-documentation-heading]").forEach((link) => {
        if (link.dataset.documentationHeading === id) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }, { rootMargin: "-2% 0px -82% 0px", threshold: 0 });
    this.root.querySelectorAll(".documentation-markdown h2, .documentation-markdown h3").forEach((heading) => this.observer?.observe(heading));
  }
};
function createDocumentationView(root) {
  return new DocumentationView(root);
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
var documentationView = createDocumentationView(document.getElementById("documentationRoot"));
var batchPerformanceAnalyses = /* @__PURE__ */ new Map();
var batchBottleneckSummaries = /* @__PURE__ */ new Map();
var batchBottleneckRequests = /* @__PURE__ */ new Map();
var batchBottleneckErrors = /* @__PURE__ */ new Map();
var EXPECTED_API_SCHEMA = "cjob-pjob-v3";
var DEFAULT_SCHEDULE_OPTIONS = Object.freeze({
  loadLockManager: "petri-look",
  residencyGuardSeconds: 0,
  maximumRobotHoldingSeconds: 0,
  maximumSystemResidenceCv: 0,
  loadLockMacroSearchSeconds: 4,
  loadLockMacroRollouts: 96,
  scheduleAlphaGoModelPath: "",
  seed: 0
});
var SCHEDULE_OPTION_KEYS = new Set(Object.keys(DEFAULT_SCHEDULE_OPTIONS));
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
var SEARCH_TELEMETRY_POLL_MILLISECONDS = 75;
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
  availableAlgorithms: [],
  algorithmMetadata: {},
  roundCount: 2,
  times: [0, 70],
  options: { ...DEFAULT_SCHEDULE_OPTIONS },
  cleans: [],
  routes: [{ name: "RouteA", group: "RouteA", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps([makeStage("LP1"), makeStage("Robot"), makeStage("PM1,PM2", true, "RouteA_Step2"), makeStage("Robot"), makeStage("LP1")]) }],
  rounds: [makeRound(1, 0, "RouteA", "LP1"), makeRound(2, 70, "RouteA", "LP2")],
  drawer: null,
  cleanDialogContext: null,
  expandedRouteProcessGroups: /* @__PURE__ */ new Set(),
  expandedRouteGroups: /* @__PURE__ */ new Set(),
  expandedRoutes: /* @__PURE__ */ new Set(),
  routeNameChanges: /* @__PURE__ */ new Map(),
  routeProcessFilter: "",
  routeParallelFilter: "",
  routeCleanFilter: "all",
  routeResidencyFilter: "all",
  routeQTimeFilter: "all"
};
var pjobRoutePickerContext = null;
var searchTelemetryPollToken = 0;
var latestSearchTelemetry = null;
var selectedSearchTelemetryId = "";
var followLatestSearchTelemetry = true;
var searchTelemetryRunActive = false;
var searchTelemetryControlPending = false;
var lastSearchTelemetryMoveCount = 0;
var continuousDecisionEnabled = false;
var continuousDecisionSubmittedSearchId = "";
var playbackMode = "replay";
var userChosenActionKey = "";
var userChosenSearchId = "";
var pendingModeSync = "";
var stepRunActive = false;
var stepRunCancelling = false;
var pendingAlphaGoCheckpointFile = null;
var sessionSchedulingConfiguration = null;
function retainSessionSchedulingConfiguration() {
  sessionSchedulingConfiguration = structuredClone({
    strategy: state.strategy,
    options: state.options
  });
}
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
  const isDummy = cleanType === "dummy" || cleanType === "dummywac";
  const name = String(value.name || `Clean${state.cleans.length + 1}`).trim() || `Clean${state.cleans.length + 1}`;
  value.name = name;
  value.cleanType = cleanType;
  value.recipeName = String(value.recipeName || value.recipeRef || `${name}-Recipe`).trim() || `${name}-Recipe`;
  const recipeTime = Number(value.recipeTime);
  value.recipeTime = Math.max(0, Number.isFinite(recipeTime) ? recipeTime : 0);
  const defaultTriggerCount = isDummy ? 2 : 5;
  value.triggerCount = Math.max(1, Math.floor(Number(
    isDummy ? value.materialCount ?? value.triggerCount : value.triggerCount ?? value.lower
  ) || defaultTriggerCount));
  if (isDummy) value.materialCount = value.triggerCount;
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
    return `${labels[value.cleanType]} \xB7 ${value.triggerCount}\u7247 \xB7 \u4E3B\u6E05\u6D01 ${mainDuration} \xB7 WAC ${formatCleanSeconds(value.wacRecipeTime)}`;
  }
  if (value.cleanType === "dummy") return `${labels[value.cleanType]} \xB7 ${value.triggerCount}\u7247 \xB7 ${mainDuration}`;
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
    materialCount: isDummy ? value.triggerCount : 0,
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
function normalizeRoute(route, normalizationChanges = null) {
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
    const recipesChanged = normalizeStageProcessRecipes(stage, recipeName, normalizeVisit);
    if (recipesChanged && normalizationChanges) normalizationChanges.changed = true;
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
function escapeHtml4(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}
function readonlyText(value) {
  if (value === void 0 || value === null || value === "") return "\u2014";
  return typeof value === "string" ? value : JSON.stringify(value);
}
function renderReadonlyField(label, value, wide = false) {
  return `<div class="readonly-field ${wide ? "wide" : ""}"><span>${escapeHtml4(label)}</span><strong>${escapeHtml4(readonlyText(value))}</strong></div>`;
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
function parseDeviceFileText(text) {
  try {
    return JSON.parse(text);
  } catch (originalError) {
    const records = text.trim().replace(/,\s*$/, "");
    try {
      return JSON.parse(`[${records}]`);
    } catch {
      throw originalError;
    }
  }
}
async function loadDevice(file) {
  if (!file) return;
  if (state.dirty) await saveCurrentTest(true);
  const device = unwrapDevice(parseDeviceFileText(await file.text()));
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
function robotArmSlotGroups(robot) {
  const declaredGroups = Object.entries(robot?.ArmInfo || {}).flatMap(([armName, arm]) => {
    if (!arm || typeof arm !== "object") return [];
    const slotIds = [...new Set((arm.SlotIDs || []).map(Number).filter(
      (slotId) => Number.isInteger(slotId) && slotId >= FIRST_ROBOT_SLOT_ID
    ))].sort((left, right) => left - right);
    return slotIds.length ? [{ armName, slotIds }] : [];
  });
  const groups = declaredGroups.length ? declaredGroups : [];
  const coveredSlots = new Set(groups.flatMap((group) => group.slotIds));
  robotAvailableSlots(robot).filter((slotId) => !coveredSlots.has(slotId)).forEach((slotId) => {
    groups.push({
      armName: generatedRobotArmName(groups.map((group) => group.armName), slotId),
      slotIds: [slotId]
    });
  });
  return groups;
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
function projectRobotArmToSlots(armName, sourceArm, slotIds) {
  const arm = structuredClone(sourceArm);
  arm.Name = armName;
  arm.IsEnable = true;
  const selected = [...new Set(slotIds.map(Number))].sort((left, right) => left - right);
  arm.SlotIDs = selected;
  Object.entries(arm.SlotsStationMap || {}).forEach(([stationName, stationSlots]) => {
    if (!stationSlots || typeof stationSlots !== "object") return;
    const entries = Object.entries(stationSlots);
    if (!entries.length) return;
    const fallback = entries[0][1];
    arm.SlotsStationMap[stationName] = Object.fromEntries(selected.map((slotId) => [
      String(slotId),
      structuredClone(stationSlots[String(slotId)] ?? fallback)
    ]));
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
    const projectedArms = {}, unmatchedSlots = new Set(selected);
    sourceArms.forEach(([armName, sourceArm]) => {
      const retainedSlots = (sourceArm.SlotIDs || []).map(Number).filter((slotId) => unmatchedSlots.has(slotId));
      if (!retainedSlots.length) return;
      projectedArms[armName] = projectRobotArmToSlots(armName, sourceArm, retainedSlots);
      retainedSlots.forEach((slotId) => unmatchedSlots.delete(slotId));
    });
    [...unmatchedSlots].sort((left, right) => left - right).forEach((slotId) => {
      const armName = generatedRobotArmName(
        [...Object.keys(robot.ArmInfo || {}), ...Object.keys(projectedArms)],
        slotId
      );
      projectedArms[armName] = projectRobotArmToSlots(armName, sourceArms[0][1], [slotId]);
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
    options: { ...DEFAULT_SCHEDULE_OPTIONS },
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
  menu.innerHTML = Array.from(select.options).map((option, index) => `<button class="compact-select-option" type="button" role="option" data-option-index="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}>${escapeHtml4(option.textContent?.trim() || "\u672A\u547D\u540D\u9009\u9879")}</button>`).join("");
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
    trigger.innerHTML = `<span class="compact-select-label">${escapeHtml4(compactSelectLabel(select))}</span><span class="compact-select-value"></span><i class="compact-select-chevron" aria-hidden="true"></i>`;
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
function displayDeviceName(name) {
  return String(name || "\u672A\u547D\u540D\u8BBE\u5907").replace(/\.json$/i, "");
}
function renderWorkspaceControls() {
  const deviceSelect = document.getElementById("deviceSelect"), tests = state.workspaceDevice?.tests || [];
  deviceSelect.innerHTML = state.workspaceDevices.length ? state.workspaceDevices.map((device) => `<option value="${escapeHtml4(device.id)}" ${device.id === state.workspaceDeviceId ? "selected" : ""}>${escapeHtml4(displayDeviceName(device.name))}</option>`).join("") : `<option value="">\u5C1A\u672A\u5BFC\u5165\u8BBE\u5907</option>`;
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  const groups = [.../* @__PURE__ */ new Set(["", ...state.workspaceDevice?.testGroups || [], ...tests.map((test) => String(test.group || "").trim())])].sort((left, right) => !left - !right || natural(left, right));
  const selectedGroup = groups.includes(state.activeTestGroup) ? state.activeTestGroup : groups[0] || "";
  const groupSelect = document.getElementById("testGroupSelect");
  groupSelect.innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml4(group)}" title="${escapeHtml4(group || "\u672A\u5206\u7EC4")}" ${group === selectedGroup ? "selected" : ""}>${escapeHtml4(group || "\u672A\u5206\u7EC4")}</option>`).join("") : `<option value="">\u672A\u5206\u7EC4</option>`;
  groupSelect.title = selectedGroup || "\u672A\u5206\u7EC4";
  groupSelect.disabled = !state.workspaceDeviceId;
  const testSelect = document.getElementById("testCaseSelect");
  const visibleTests = tests.filter((test) => String(test.group || "").trim() === selectedGroup).sort((left, right) => natural(left.name, right.name));
  testSelect.innerHTML = visibleTests.length ? visibleTests.map((test) => `<option value="${escapeHtml4(test.id)}" title="${escapeHtml4(test.name)}" ${test.id === state.testCaseId ? "selected" : ""}>${escapeHtml4(test.name)}</option>`).join("") : `<option value="">\u8BE5\u7EC4\u6682\u65E0\u6D4B\u8BD5</option>`;
  testSelect.title = visibleTests.find((test) => test.id === state.testCaseId)?.name || "\u8BE5\u7EC4\u6682\u65E0\u6D4B\u8BD5";
  testSelect.disabled = !visibleTests.length;
  const hasTest = Boolean(state.testCaseId);
  const nameInput = document.getElementById("testCaseName");
  nameInput.disabled = !hasTest;
  nameInput.value = state.testCaseName || "";
  nameInput.title = state.testCaseName || "";
  document.getElementById("newTestButton").disabled = !state.workspaceDeviceId;
  document.getElementById("newGroupButton").disabled = !state.workspaceDeviceId;
  document.getElementById("deleteDeviceButton").disabled = !state.workspaceDeviceId;
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
  const deviceType = {
    single: "\u5355\u8154\u975E\u7EA7\u8054",
    dual: "\u53CC\u8154\u975E\u7EA7\u8054",
    cascade: "\u7EA7\u8054"
  }[detectDeviceTopologyLayout(state.device)];
  document.getElementById("deviceSummary").innerHTML = state.device ? `<span class="chip good">${escapeHtml4(deviceType)}</span>` : `<span class="chip">\u5C1A\u672A\u9009\u62E9\u8BBE\u5907</span>`;
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
  document.getElementById("metricTimeLabel").textContent = "Total Time";
  document.getElementById("metricMakespanLabel").textContent = "Makespan";
  setBottleneckMetric(null);
  document.getElementById("metricValidationLabel").textContent = "Validation";
  document.getElementById("metricValidation").closest(".metric").classList.remove("is-success", "is-error");
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  for (const id of ["logButton", "ganttButton", "batchGanttButton"]) {
    const link = document.getElementById(id);
    link.href = "#";
    link.setAttribute("aria-disabled", "true");
  }
  resetSearchTelemetryView();
  writeTerminal("$ \u6D4B\u8BD5\u96C6\u5DF2\u5C31\u7EEA\uFF0C\u7B49\u5F85\u8FD0\u884C\u2026");
}
function resetSearchTelemetryView() {
  searchTelemetryPollToken += 1;
  latestSearchTelemetry = null;
  selectedSearchTelemetryId = "";
  followLatestSearchTelemetry = true;
  searchTelemetryRunActive = false;
  searchTelemetryControlPending = false;
  lastSearchTelemetryMoveCount = 0;
  continuousDecisionEnabled = false;
  continuousDecisionSubmittedSearchId = "";
  userChosenActionKey = "";
  userChosenSearchId = "";
  const panel = document.getElementById("searchTelemetryPanel");
  panel.hidden = true;
  document.getElementById("searchTelemetryVariationPanel").hidden = true;
  document.getElementById("searchTelemetryDecisionSelect").innerHTML = "";
  document.getElementById("searchTelemetryVariation").innerHTML = "";
  for (const id of [
    "searchTelemetryPauseButton",
    "searchTelemetryStepButton",
    "searchTelemetryContinueButton",
    "searchTelemetryFollowRecommendationButton",
    "searchTelemetryContinuousDecisionButton"
  ]) {
    const button = document.getElementById(id);
    button.disabled = true;
    button.classList.remove("is-active");
  }
}
function formatSearchTelemetryNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "\u2014";
}
function searchTelemetryStopReason(reason) {
  return {
    time_budget: "\u65F6\u95F4\u9884\u7B97",
    simulation_budget: "\u6A21\u62DF\u6B21\u6570\u9884\u7B97",
    node_budget: "\u8282\u70B9\u9884\u7B97"
  }[String(reason || "")] || "\u641C\u7D22\u4E2D";
}
function renderSearchActionChains(chains, decisionIndex, recommendedKey, selectedKey, maximumVisits, interactive) {
  return `<section class="decision-candidate-section search-action-section" aria-labelledby="searchCandidatesTitle">
    <header>
      <strong id="searchCandidatesTitle">\u51B3\u7B56 #${decisionIndex}</strong>
      <span>${chains.length} \u6761\u53EF\u9009\u7A33\u5B9A\u52A8\u4F5C\u94FE</span>
    </header>
    <ol>
      ${chains.map((chain, index) => {
    const visits = Number(chain?.visits) || 0;
    const visitPercent = Math.max(0, Math.min(100, visits / maximumVisits * 100));
    const isRecommended = String(chain?.actionKey || "") === recommendedKey;
    const isSelected = String(chain?.actionKey || "") === selectedKey;
    const tags = `${isRecommended ? '<span class="decision-tag is-recommendation">\u63A8\u8350</span>' : ""}${isSelected && !isRecommended ? '<span class="decision-tag is-user-chosen">\u4F60\u7684\u9009\u62E9</span>' : ""}`;
    const description = String(chain?.description || "\u7A33\u5B9A\u52A8\u4F5C\u94FE");
    const steps = Array.isArray(chain?.steps) ? chain.steps : [];
    return `<li class="decision-candidate search-action-candidate search-action-chain ${isSelected ? "is-selected" : ""} ${interactive ? "is-interactive" : ""}" data-action-key="${escapeHtml4(String(chain?.actionKey || ""))}" ${interactive ? `role="button" tabindex="0" aria-label="\u6267\u884C ${escapeHtml4(description)}"` : ""}>
          <div class="decision-candidate-rank" aria-label="\u7B2C ${index + 1} \u540D">${index + 1}</div>
          <div class="decision-candidate-main">
            <div class="decision-candidate-title"><strong title="${escapeHtml4(description)}">${escapeHtml4(description)}</strong>${tags}</div>
            <div class="decision-candidate-detail search-pnq" aria-label="\u641C\u7D22\u8BC4\u4F30\u6307\u6807">
              <span title="\u7B56\u7565\u5148\u9A8C P"><small>P \u5148\u9A8C</small><strong>${formatSearchTelemetryNumber(chain?.prior, 4)}</strong></span>
              <span title="\u8BBF\u95EE\u6B21\u6570 N"><small>N \u8BBF\u95EE</small><strong>${visits}</strong></span>
              <span title="\u5E73\u5747\u4EF7\u503C Q"><small>Q \u4EF7\u503C</small><strong>${formatSearchTelemetryNumber(chain?.value, 4)}</strong></span>
            </div>
            <ol class="search-chain-steps" aria-label="\u52A8\u4F5C\u94FE\u6B65\u9AA4">
              ${steps.map((step, stepIndex) => `<li><b>${stepIndex + 1}</b><span title="${escapeHtml4(step?.description || "\u52A8\u4F5C")}">${escapeHtml4(step?.description || "\u52A8\u4F5C")}</span><small>${Number(step?.primitiveCount) || 1} \u6B65</small></li>`).join("")}
            </ol>
          </div>
          <div class="decision-candidate-preference" aria-label="\u63A8\u8350\u6BD4\u4F8B ${visitPercent.toFixed(0)}%"><small>\u63A8\u8350\u6BD4\u4F8B</small><strong>${visitPercent.toFixed(0)}%</strong></div>
        </li>`;
  }).join("")}
    </ol>
  </section>`;
}
function renderSearchTelemetryDecision(snapshot) {
  const chains = Array.isArray(snapshot?.actionChains) ? snapshot.actionChains.slice(0, 3) : [];
  const recommendedKey = String(snapshot?.selectedActionKey || "");
  const selectedKey = String(snapshot?.searchId || "") === userChosenSearchId ? userChosenActionKey : recommendedKey;
  const decisionIndex = Number(snapshot?.decisionIndex || 0) + 1;
  const interactive = playbackMode === "step" && latestSearchTelemetry?.status === "waiting-choice" && String(snapshot?.searchId || "") === String(latestSearchTelemetry?.searchId || "");
  const maximumVisits = Math.max(1, ...chains.map((chain) => Number(chain?.visits) || 0));
  document.getElementById("visualDecisionLens").innerHTML = chains.length ? renderSearchActionChains(
    chains,
    decisionIndex,
    recommendedKey,
    selectedKey,
    maximumVisits,
    interactive
  ) : `<div class="decision-empty"><strong>\u6B63\u5728\u6784\u9020\u7A33\u5B9A\u52A8\u4F5C\u94FE\u2026</strong><p>\u53EA\u6709\u5728 50 \u5C42\u5185\u56DE\u5230 Robot \u5168\u90E8\u7A7A\u624B\u72B6\u6001\u7684\u94FE\u624D\u4F1A\u51FA\u73B0\u3002</p></div>`;
  const variationPanel = document.getElementById("searchTelemetryVariationPanel");
  variationPanel.hidden = true;
  document.getElementById("searchTelemetryVariation").innerHTML = "";
}
function updateSearchTelemetryControls(snapshot) {
  const executionMode = String(snapshot?.executionMode || "continuous");
  const stepMode = playbackMode === "step";
  const disabled = !searchTelemetryRunActive || searchTelemetryControlPending;
  const pauseButton = document.getElementById("searchTelemetryPauseButton");
  const stepButton = document.getElementById("searchTelemetryStepButton");
  const continueButton = document.getElementById("searchTelemetryContinueButton");
  const followButton = document.getElementById("searchTelemetryFollowRecommendationButton");
  const continuousButton = document.getElementById("searchTelemetryContinuousDecisionButton");
  const continuousActive = continuousDecisionEnabled && searchTelemetryRunActive && stepMode;
  pauseButton.hidden = stepMode;
  stepButton.hidden = stepMode;
  continueButton.hidden = stepMode;
  followButton.hidden = !stepMode;
  continuousButton.hidden = !stepMode;
  pauseButton.disabled = disabled;
  stepButton.disabled = disabled;
  continueButton.disabled = disabled;
  const canFollowRecommendation = !disabled && stepMode && executionMode === "paused" && snapshot?.status === "waiting-choice" && Boolean(snapshot?.selectedActionKey);
  followButton.disabled = !canFollowRecommendation || continuousActive;
  continuousButton.disabled = !stepMode || !searchTelemetryRunActive || !continuousActive && !canFollowRecommendation;
  continuousButton.textContent = continuousActive ? "\u505C\u6B62\u6301\u7EED\u51B3\u7B56" : "\u6301\u7EED\u51B3\u7B56";
  continuousButton.title = continuousActive ? "\u5B8C\u6210\u5F53\u524D\u5728\u9014\u9009\u62E9\u540E\u505C\u6B62\uFF0C\u4E0D\u518D\u81EA\u52A8\u6267\u884C\u4E0B\u4E00\u8F6E\u63A8\u8350" : "\u6301\u7EED\u6267\u884C\u6BCF\u4E00\u8F6E\u641C\u7D22\u7684\u6A21\u578B\u63A8\u8350\u52A8\u4F5C";
  continuousButton.setAttribute("aria-pressed", String(continuousActive));
  continuousButton.classList.toggle("is-active", continuousActive);
  pauseButton.classList.toggle("is-active", !disabled && !stepMode && executionMode === "paused");
  continueButton.classList.toggle("is-active", !disabled && !stepMode && executionMode === "continuous");
}
function syncSearchTelemetryPlayback(snapshot, selectedDecision) {
  const committedMoves = Array.isArray(snapshot?.committedMoves) ? snapshot.committedMoves : [];
  const movesChanged = Boolean(
    committedMoves.length && committedMoves.length !== lastSearchTelemetryMoveCount
  );
  const animateLatestStep = movesChanged && playbackMode === "step" && followLatestSearchTelemetry;
  if (movesChanged) {
    visualizationWorkspace.updateLiveMoves(
      committedMoves,
      followLatestSearchTelemetry,
      animateLatestStep
    );
    lastSearchTelemetryMoveCount = committedMoves.length;
  }
  const replayTime = Number(selectedDecision?.replayTime);
  if (!animateLatestStep && Number.isFinite(replayTime) && replayTime >= 0) {
    visualizationWorkspace.seekTo(replayTime);
  }
}
async function chooseSearchAction(actionKey, automatic = false) {
  if (!searchTelemetryRunActive || playbackMode !== "step") return;
  if (searchTelemetryControlPending) return;
  if (latestSearchTelemetry?.status !== "waiting-choice") return;
  const key = String(actionKey || "");
  if (!key) return;
  searchTelemetryControlPending = true;
  userChosenActionKey = key;
  userChosenSearchId = String(latestSearchTelemetry?.searchId || "");
  if (latestSearchTelemetry) renderSearchTelemetry(latestSearchTelemetry);
  updateSearchTelemetryControls(latestSearchTelemetry);
  try {
    const result = await requestSearchControl("choose", key);
    if (result?.telemetry) renderSearchTelemetry(result.telemetry);
  } catch (error) {
    if (automatic) {
      continuousDecisionEnabled = false;
      continuousDecisionSubmittedSearchId = "";
    }
    const status = document.getElementById("searchTelemetryStatus");
    status.textContent = automatic ? `\u6301\u7EED\u51B3\u7B56\u5DF2\u505C\u6B62\uFF1A${error.message || "\u63D0\u4EA4\u63A8\u8350\u5931\u8D25"}` : `\u63D0\u4EA4\u9009\u62E9\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`;
    status.classList.remove("is-searching", "is-paused");
  } finally {
    searchTelemetryControlPending = false;
    flushPendingModeSync();
    updateSearchTelemetryControls(latestSearchTelemetry);
    maybeContinueModelDecision(latestSearchTelemetry);
  }
}
function followSearchRecommendation() {
  const key = String(latestSearchTelemetry?.selectedActionKey || "");
  if (!key) return;
  void chooseSearchAction(key);
}
async function flushPendingModeSync() {
  const mode = pendingModeSync;
  if (!mode) return;
  pendingModeSync = "";
  await setPlaybackMode(mode);
}
function renderPlaybackModeSwitch() {
  const stepMode = playbackMode === "step";
  document.getElementById("playbackModeReplayButton").classList.toggle("is-active", playbackMode === "replay");
  document.getElementById("playbackModeStepButton").classList.toggle("is-active", stepMode);
  document.getElementById("playbackModeReplayButton").setAttribute("aria-pressed", String(playbackMode === "replay"));
  document.getElementById("playbackModeStepButton").setAttribute("aria-pressed", String(stepMode));
  document.getElementById("visualRecommendationModelControl").hidden = stepMode;
  document.getElementById("visualPauseOnDecisionChangeButton").hidden = stepMode;
}
function maybeContinueModelDecision(snapshot) {
  if (!continuousDecisionEnabled || !searchTelemetryRunActive || playbackMode !== "step") return;
  if (searchTelemetryControlPending || snapshot?.status !== "waiting-choice") return;
  const searchId = String(snapshot?.searchId || "");
  const actionKey = String(snapshot?.selectedActionKey || "");
  if (!searchId || !actionKey || searchId === continuousDecisionSubmittedSearchId) return;
  continuousDecisionSubmittedSearchId = searchId;
  void chooseSearchAction(actionKey, true);
}
function toggleContinuousDecision() {
  if (!searchTelemetryRunActive || playbackMode !== "step") return;
  continuousDecisionEnabled = !continuousDecisionEnabled;
  continuousDecisionSubmittedSearchId = "";
  followLatestSearchTelemetry = true;
  selectedSearchTelemetryId = "";
  if (latestSearchTelemetry) renderSearchTelemetry(latestSearchTelemetry);
  else updateSearchTelemetryControls(null);
}
async function setPlaybackMode(mode) {
  if (mode !== "step" && mode !== "replay") return;
  playbackMode = mode;
  if (mode !== "step") {
    continuousDecisionEnabled = false;
    continuousDecisionSubmittedSearchId = "";
  }
  renderPlaybackModeSwitch();
  if (searchTelemetryRunActive && !searchTelemetryControlPending) {
    try {
      const result = await requestSearchControl(mode === "step" ? "step-mode" : "replay-mode");
      if (result?.telemetry) renderSearchTelemetry(result.telemetry);
    } catch (error) {
      const status = document.getElementById("searchTelemetryStatus");
      status.textContent = `\u5207\u6362\u6A21\u5F0F\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`;
      status.classList.remove("is-searching", "is-paused");
    }
  } else if (searchTelemetryRunActive) {
    pendingModeSync = mode;
  }
  if (latestSearchTelemetry) renderSearchTelemetry(latestSearchTelemetry);
}
async function controlSearchTelemetry(command) {
  if (!searchTelemetryRunActive || searchTelemetryControlPending) return;
  searchTelemetryControlPending = true;
  if (command !== "pause") {
    followLatestSearchTelemetry = true;
    selectedSearchTelemetryId = "";
  }
  updateSearchTelemetryControls(latestSearchTelemetry);
  try {
    const result = await requestSearchControl(command);
    if (result?.telemetry) renderSearchTelemetry(result.telemetry);
  } catch (error) {
    const status = document.getElementById("searchTelemetryStatus");
    status.textContent = `\u6C42\u89E3\u63A7\u5236\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`;
    status.classList.remove("is-searching", "is-paused");
  } finally {
    searchTelemetryControlPending = false;
    flushPendingModeSync();
    updateSearchTelemetryControls(latestSearchTelemetry);
  }
}
function renderSearchTelemetry(snapshot) {
  if (!snapshot || snapshot.unchanged) return;
  if (snapshot.algorithm !== "schedule-alphago" && latestSearchTelemetry) return;
  latestSearchTelemetry = snapshot;
  const panel = document.getElementById("searchTelemetryPanel");
  panel.hidden = false;
  const status = document.getElementById("searchTelemetryStatus");
  if (snapshot.algorithm !== "schedule-alphago") {
    status.textContent = "\u6B63\u5728\u521D\u59CB\u5316\u641C\u7D22\u5668\u2026";
    status.classList.add("is-searching");
    status.classList.remove("is-paused");
    updateSearchTelemetryControls(snapshot);
    return;
  }
  const decisions = Array.isArray(snapshot.history) ? [...snapshot.history] : [];
  if (snapshot.searchId && decisions.at(-1)?.searchId !== snapshot.searchId) decisions.push(snapshot);
  const latestDecision = decisions.at(-1) || snapshot;
  if (followLatestSearchTelemetry || !decisions.some((item) => item.searchId === selectedSearchTelemetryId)) {
    selectedSearchTelemetryId = String(latestDecision.searchId || "");
  }
  const selector = document.getElementById("searchTelemetryDecisionSelect");
  selector.innerHTML = decisions.map((item) => {
    const suffix = item.status === "searching" ? "\u641C\u7D22\u4E2D" : `${Number(item.simulations) || 0} \u6B21`;
    return `<option value="${escapeHtml4(item.searchId || "")}">#${Number(item.decisionIndex || 0) + 1} \xB7 ${suffix}</option>`;
  }).join("");
  selector.value = selectedSearchTelemetryId;
  const selected = decisions.find((item) => item.searchId === selectedSearchTelemetryId) || latestDecision;
  const searching = snapshot?.status === "searching";
  const waiting = snapshot?.status === "waiting-step";
  const waitingChoice = snapshot?.status === "waiting-choice";
  const cancelled = snapshot?.status === "cancelled";
  status.textContent = cancelled ? "\u8FD0\u884C\u5DF2\u53D6\u6D88" : waitingChoice ? playbackMode === "step" ? continuousDecisionEnabled ? "\u6301\u7EED\u51B3\u7B56\u4E2D \xB7 \u6B63\u5728\u6267\u884C\u6A21\u578B\u63A8\u8350" : "\u641C\u7D22\u5B8C\u6210 \xB7 \u8BF7\u9009\u62E9\u8981\u6267\u884C\u7684\u52A8\u4F5C" : "\u6C42\u89E3\u5DF2\u6682\u505C \xB7 \u7B49\u5F85\u653E\u884C" : waiting ? "\u6C42\u89E3\u5DF2\u6682\u505C \xB7 \u53EF\u5355\u6B65\u653E\u884C\u4E00\u4E2A\u6839\u51B3\u7B56\uFF0C\u6216\u7EE7\u7EED\u8FDE\u7EED\u6C42\u89E3" : searching ? `${continuousDecisionEnabled && playbackMode === "step" ? "\u6301\u7EED\u51B3\u7B56\u4E2D \xB7 " : ""}\u6B63\u5728\u8FDB\u884C\u975E\u5BF9\u79F0\u6811\u641C\u7D22 \xB7 ${Number(snapshot?.simulations) || 0} \u6B21\u6A21\u62DF` : snapshot?.status === "action-applied" ? `\u6839\u52A8\u4F5C #${Number(snapshot?.decisionIndex || 0) + 1} \u5DF2\u63D0\u4EA4 \xB7 \u62D3\u6251\u5DF2\u63A8\u8FDB` : `\u51B3\u7B56\u5B8C\u6210 \xB7 \u7531${searchTelemetryStopReason(selected?.stopReason)}\u7EC8\u6B62`;
  status.classList.toggle("is-searching", searching);
  status.classList.toggle("is-paused", waiting || waitingChoice);
  updateSearchTelemetryControls(snapshot);
  renderSearchTelemetryDecision(selected);
  syncSearchTelemetryPlayback(snapshot, selected);
  maybeContinueModelDecision(snapshot);
}
async function pollSearchTelemetry(token) {
  let revision = null;
  while (token === searchTelemetryPollToken) {
    try {
      const snapshot = await requestSearchTelemetry(revision);
      if (token !== searchTelemetryPollToken) break;
      if (Number.isFinite(Number(snapshot?.revision))) revision = Number(snapshot.revision);
      renderSearchTelemetry(snapshot);
    } catch (error) {
      if (!latestSearchTelemetry && token === searchTelemetryPollToken) {
        const status = document.getElementById("searchTelemetryStatus");
        status.textContent = `\u9065\u6D4B\u6682\u4E0D\u53EF\u7528\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`;
        status.classList.remove("is-searching");
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, SEARCH_TELEMETRY_POLL_MILLISECONDS));
  }
}
function startSearchTelemetryPolling() {
  resetSearchTelemetryView();
  searchTelemetryRunActive = true;
  visualizationWorkspace.setExternalDecisionLensOwner(true);
  const panel = document.getElementById("searchTelemetryPanel");
  panel.hidden = false;
  const status = document.getElementById("searchTelemetryStatus");
  status.textContent = "\u6B63\u5728\u521D\u59CB\u5316\u641C\u7D22\u5668\u2026";
  status.classList.add("is-searching");
  updateSearchTelemetryControls({ executionMode: playbackMode === "step" ? "paused" : "continuous" });
  const token = ++searchTelemetryPollToken;
  void pollSearchTelemetry(token);
}
function stopSearchTelemetryPolling(finalSnapshot = null) {
  searchTelemetryPollToken += 1;
  searchTelemetryRunActive = false;
  continuousDecisionEnabled = false;
  continuousDecisionSubmittedSearchId = "";
  visualizationWorkspace.setExternalDecisionLensOwner(false);
  if (finalSnapshot) renderSearchTelemetry(finalSnapshot);
  const status = document.getElementById("searchTelemetryStatus");
  if (!finalSnapshot && latestSearchTelemetry?.algorithm === "schedule-alphago") {
    status.classList.remove("is-searching");
  }
  updateSearchTelemetryControls(finalSnapshot || latestSearchTelemetry);
}
function applyTestCase(testCase) {
  const value = structuredClone(testCase);
  state.routeNameChanges.clear();
  state.testCaseId = value.id;
  state.testCaseName = value.name;
  state.testCaseGroup = String(value.group || "");
  state.activeTestGroup = state.testCaseGroup;
  const requestedStrategy = String(value.strategy || "heuristic");
  state.strategy = requestedStrategy.trim() || "heuristic";
  state.roundCount = Math.max(1, Number(value.roundCount) || 1);
  state.times = Array.isArray(value.times) ? value.times : [0];
  const persistedOptions = value.options && typeof value.options === "object" ? value.options : {};
  state.options = {
    ...DEFAULT_SCHEDULE_OPTIONS,
    ...Object.fromEntries(
      Object.entries(persistedOptions).filter(([key]) => SCHEDULE_OPTION_KEYS.has(key))
    )
  };
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
  if (sessionSchedulingConfiguration) {
    state.strategy = sessionSchedulingConfiguration.strategy;
    state.options = structuredClone(sessionSchedulingConfiguration.options);
  } else {
    retainSessionSchedulingConfiguration();
  }
  if (!state.routes.length && Array.isArray(value.routes)) state.routes = value.routes;
  if (!state.cleans.length && Array.isArray(value.cleans)) state.cleans = value.cleans.map(normalizeClean);
  const routeNormalizationChanges = { changed: false };
  state.routes.forEach((route) => normalizeRoute(route, routeNormalizationChanges));
  state.expandedRouteProcessGroups.clear();
  state.expandedRouteGroups.clear();
  state.expandedRoutes.clear();
  state.routeProcessFilter = "";
  state.routeParallelFilter = "";
  state.routeCleanFilter = "all";
  state.routeResidencyFilter = "all";
  state.routeQTimeFilter = "all";
  state.rounds = Array.isArray(value.rounds) ? value.rounds : [];
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
  state.dirty = routeNormalizationChanges.changed || cleanNamesChanged || routeNamesChanged;
  document.getElementById("roundCount").value = state.roundCount;
  document.querySelectorAll('input[name="strategy"]').forEach((input) => {
    input.checked = input.value === state.strategy;
  });
  document.querySelectorAll("[data-option]").forEach((input) => {
    input.value = state.options[input.dataset.option] ?? input.value;
  });
  updateStrategyOptionVisibility();
  document.getElementById("roundCount").disabled = false;
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
  const currentGroup = state.activeTestGroup, deletedTestName = state.testCaseName;
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, { method: "DELETE" });
  state.workspaceDevice.tests = result.tests;
  const summary = state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId);
  if (summary) summary.testCount = result.tests.length;
  const nextTestInCurrentGroup = result.tests.find((test) => String(test.group || "").trim() === currentGroup);
  if (nextTestInCurrentGroup) {
    applyTestCase(nextTestInCurrentGroup);
    return;
  }
  state.activeTestGroup = currentGroup;
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = currentGroup;
  state.dirty = false;
  renderWorkspaceControls();
  resetRunResult();
  setWorkspaceStatus(`\u5DF2\u5220\u9664\u6D4B\u8BD5\u201C${deletedTestName}\u201D`, "saved");
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
  else resetWorkspaceSelection();
}
function resetWorkspaceSelection() {
  state.workspaceDevice = null;
  state.workspaceDeviceId = "";
  state.testCaseId = "";
  state.testCaseName = "";
  state.testCaseGroup = "";
  state.activeTestGroup = "";
  state.dirty = false;
  state.deviceName = "";
  state.baseDevice = null;
  state.device = null;
  state.stationNames = [];
  state.loadPorts = [];
  state.processModules = [];
  state.robotNames = [];
  state.robotScopes = {};
  state.robotSlots = {};
  renderWorkspaceControls();
  resetRunResult();
}
async function deleteWorkspaceDevice() {
  if (!state.workspaceDeviceId) return;
  if (state.batchRunning) throw new Error("\u6279\u91CF\u4EFB\u52A1\u8FD0\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u6216\u53D6\u6D88\u540E\u518D\u5220\u9664\u8BBE\u5907");
  const deviceName = displayDeviceName(state.workspaceDevices.find((device) => device.id === state.workspaceDeviceId)?.name || state.workspaceDevice?.name);
  const confirmed = await showWorkspaceDialog({ title: "\u5220\u9664\u8BBE\u5907", message: `\u786E\u5B9A\u5220\u9664\u8BBE\u5907\u201C${deviceName}\u201D\u5417\uFF1F\u5176\u4E0B\u5168\u90E8\u6D4B\u8BD5\u96C6\u3001\u8DEF\u7EBF\u4E0E\u6E05\u6D01\u914D\u65B9\u5C06\u4E00\u5E76\u5220\u9664\uFF0C\u4E14\u65E0\u6CD5\u6062\u590D\u3002`, dangerous: true });
  if (!confirmed) return;
  const result = await requestJson(`/api/workspaces/devices/${state.workspaceDeviceId}`, { method: "DELETE" });
  writeTerminal(`$ \u5DF2\u5220\u9664\u8BBE\u5907 ${result.deleted.name}
  \u5176\u4E0B ${result.deleted.testCount} \u4E2A\u6D4B\u8BD5\u96C6\u5DF2\u4E00\u5E76\u79FB\u9664`);
  try {
    await loadWorkspaceCatalog();
    setWorkspaceStatus(`\u5DF2\u5220\u9664\u8BBE\u5907\u201C${result.deleted.name}\u201D`, "saved");
  } catch (error) {
    state.workspaceDevices = state.workspaceDevices.filter((device) => device.id !== result.deleted.id);
    const nextDeviceId = state.workspaceDevices[0]?.id;
    if (nextDeviceId) await selectWorkspaceDevice(nextDeviceId);
    else resetWorkspaceSelection();
    setWorkspaceStatus(`\u8BBE\u5907\u5DF2\u5220\u9664\uFF0C\u4F46\u76EE\u5F55\u5237\u65B0\u5931\u8D25\uFF1A${error.message}`, "dirty");
  }
}
function switchTab(name) {
  document.querySelectorAll("[data-tab-target]").forEach((button) => button.classList.toggle("active", button.dataset.tabTarget === name));
  document.querySelectorAll("[data-tab-view]").forEach((view) => view.classList.toggle("active", view.dataset.tabView === name));
  document.getElementById("scheduleSide").classList.toggle("is-hidden", name !== "schedule");
  document.getElementById("pageLayout").classList.toggle("editor-mode", name !== "schedule");
  document.getElementById("pageLayout").classList.toggle("documentation-mode", name === "documentation");
  document.body.classList.toggle("documentation-mode", name === "documentation");
  if (name === "documentation") void documentationView.load();
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
  const safe = Math.max(1, Math.min(8, Number(count) || 1));
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
    // 腔室级清洁仅支持离开腔室后的 WAC；带 Dummy 晶圆的清洁必须绑定到 Route。
    { key: "afterCleanRefs", label: "\u79BB\u5F00\u8154\u5BA4\u540E", types: ["wacclean"] }
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
      <div><strong>${escapeHtml4(cleanName)}</strong><small>${escapeHtml4(placement.label)} \xB7 ${escapeHtml4(moduleSummary)}</small></div>
      <div class="context-clean-actions">
        <button class="btn small" type="button" data-action="edit-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml4(cleanName)}">\u7F16\u8F91</button>
        <button class="btn danger small" type="button" data-action="remove-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml4(cleanName)}">\u79FB\u9664</button>
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
  typeSelect.innerHTML = CLEAN_TYPE_DEFINITIONS.filter((item) => definition?.types.includes(item.key)).map((item) => `<option value="${item.key}">${escapeHtml4(item.label)}</option>`).join("");
  typeSelect.value = definition?.types.includes(currentType) ? currentType : definition?.types[0] || "";
  const usesMaterialCount = ["dummy", "dummywac"].includes(typeSelect.value);
  document.getElementById("cleanTriggerField").hidden = typeSelect.value !== "wacclean" && !usesMaterialCount;
  document.getElementById("cleanTriggerLabel").textContent = usesMaterialCount ? "Dummy \u6676\u5706\u6570\uFF08MaterialCount\uFF09" : "\u89E6\u53D1\u6B21\u6570";
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
  placementSelect.innerHTML = definitions.map((item) => `<option value="${item.key}">${escapeHtml4(item.label)}</option>`).join("");
  placementSelect.value = selectedPlacement;
  document.getElementById("cleanType").innerHTML = `<option value="${draft.cleanType}">${escapeHtml4(draft.cleanType)}</option>`;
  document.getElementById("cleanRecipeTime").value = String(draft.recipeTime);
  document.getElementById("cleanTriggerCount").value = String(draft.triggerCount);
  document.getElementById("cleanWacRecipeTime").value = String(draft.wacRecipeTime);
  const selectedModules = new Set(stringList(draft.modules));
  const moduleHost = document.getElementById("cleanModuleOptions");
  const modules = cleanContextModules(scope, routeIndex, stageIndex);
  moduleHost.innerHTML = modules.length ? modules.map((module) => `<label class="clean-module-option"><input type="checkbox" name="cleanModule" value="${escapeHtml4(module)}" ${selectedModules.has(module) ? "checked" : ""}><span>${escapeHtml4(module)}</span></label>`).join("") : `<span class="clean-dialog-empty">\u5F53\u524D\u8303\u56F4\u6CA1\u6709\u53EF\u914D\u7F6E\u7684\u52A0\u5DE5\u8154\u5BA4</span>`;
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
  const cleanType = document.getElementById("cleanType").value;
  const clean = normalizeClean({
    ...context.draft,
    cleanType,
    recipeTime: Number(document.getElementById("cleanRecipeTime").value),
    triggerCount: Number(document.getElementById("cleanTriggerCount").value),
    materialCount: ["dummy", "dummywac"].includes(cleanType) ? Number(document.getElementById("cleanTriggerCount").value) : context.draft.materialCount,
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
  const summary = candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml4(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u9009\u62E9\u8BBE\u5907</span>`;
  return `<details class="candidate-picker" onclick="event.stopPropagation()"><summary>${summary}</summary><div class="candidate-picker-menu">${allowed.map((name) => `<label class="candidate-option"><input type="checkbox" data-scope="stage-candidate-toggle" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-candidate="${escapeHtml4(name)}" ${selected.has(name) ? "checked" : ""}><span>${escapeHtml4(name)}</span></label>`).join("")}</div></details>`;
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
  const bufferModes = ["No Buffer", "\u5F3A\u5236 Buffer Out", "\u5F3A\u5236 Buffer In", "\u975E\u5F3A\u5236 Buffer Out", "\u975E\u5F3A\u5236 Buffer In"];
  const selectedBuffer = Math.max(0, Math.min(4, Math.trunc(Number(route.bufferOption) || 0)));
  return `<div class="route-details"><div class="edit-card-head"><strong>\u8DEF\u5F84\u8BE6\u60C5</strong><div><button class="btn small" data-action="open-context-clean" data-clean-scope="route" data-route-index="${index}">\uFF0B Clean</button> <button class="btn small" data-action="add-stage" data-index="${index}">\uFF0B Step \u7EC4</button> <button class="btn danger small" data-action="remove-route" data-index="${index}">\u5220\u9664</button></div></div>
    <div class="route-meta"><div class="route-meta-grid"><div class="field"><label>\u8DEF\u5F84\u540D\u79F0\uFF08\u81EA\u52A8\u751F\u6210\uFF09</label><input value="${escapeHtml4(route.name)}" readonly></div><div class="field route-group-field"><label>Group</label><input value="${escapeHtml4(route.group)}" title="${escapeHtml4(route.group)}" readonly></div><div class="field route-buffer-field"><label>BufferOption</label><select data-compact-label="BufferOption" data-scope="route" data-index="${index}" data-key="bufferOption">${bufferModes.map((label, value) => `<option value="${value}" ${value === selectedBuffer ? "selected" : ""}>${value} \xB7 ${escapeHtml4(label)}</option>`).join("")}</select></div></div>
    <section class="route-clean-section"><div class="context-clean-head"><div><strong>Route Clean</strong><small>Clean \u4EC5\u4F5C\u7528\u4E8E\u5F39\u7A97\u4E2D\u9009\u62E9\u7684\u8154\u5BA4</small></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="route" data-route-index="${index}">\uFF0B Clean</button></div>${renderContextCleans("route", index)}</section></div>
    <div class="route-table-wrap"><table class="route-table"><thead><tr><th>StepID</th><th>\u7C7B\u578B</th><th>\u53EF\u9009\u8154\u5BA4 / \u673A\u5668\u624B</th><th>PostStepID</th><th>NeedProcess</th><th></th></tr></thead><tbody>${renderSteps(route, index)}</tbody></table></div></div>`;
}
function renderRoutes() {
  const host = document.getElementById("routeList");
  const processSelect = document.getElementById("routeProcessFilter");
  const parallelSelect = document.getElementById("routeParallelFilter");
  const cleanSelect = document.getElementById("routeCleanFilter");
  const residencySelect = document.getElementById("routeResidencyFilter");
  const qTimeSelect = document.getElementById("routeQTimeFilter");
  const processGroups = groupedRoutes();
  const selectedProcess = processGroups.find((group) => group.key === state.routeProcessFilter) || processGroups[0];
  state.routeProcessFilter = selectedProcess?.key || "";
  const selectedStructure = selectedProcess?.structures.find((structure) => structure.key === state.routeParallelFilter) || selectedProcess?.structures[0];
  state.routeParallelFilter = selectedStructure?.key || "";
  processSelect.innerHTML = processGroups.map((group) => `<option value="${escapeHtml4(group.key)}">${escapeHtml4(group.label)}</option>`).join("");
  processSelect.value = state.routeProcessFilter;
  processSelect.disabled = !processGroups.length;
  parallelSelect.innerHTML = (selectedProcess?.structures || []).map((structure) => `<option value="${escapeHtml4(structure.key)}">${escapeHtml4(structure.label)}</option>`).join("");
  parallelSelect.value = state.routeParallelFilter;
  parallelSelect.disabled = !selectedProcess?.structures.length;
  cleanSelect.value = state.routeCleanFilter;
  cleanSelect.disabled = !selectedStructure;
  residencySelect.value = state.routeResidencyFilter;
  residencySelect.disabled = !selectedStructure;
  qTimeSelect.value = state.routeQTimeFilter;
  qTimeSelect.disabled = !selectedStructure;
  initializeCompactSelects();
  refreshCompactSelect(processSelect);
  refreshCompactSelect(parallelSelect);
  refreshCompactSelect(cleanSelect);
  refreshCompactSelect(residencySelect);
  refreshCompactSelect(qTimeSelect);
  if (!selectedStructure) {
    host.innerHTML = `<div class="empty">\u81F3\u5C11\u521B\u5EFA\u4E00\u6761\u8DEF\u5F84\uFF0CJob \u624D\u80FD\u5F15\u7528\u3002</div>`;
    return;
  }
  const routes = selectedStructure.routes.filter(({ route }) => (state.routeCleanFilter === "all" || routePickerCleanSummary(route) !== "\u65E0" === (state.routeCleanFilter === "yes")) && (state.routeResidencyFilter === "all" || routeHasTimeConstraint(route, "residencyConstraint") === (state.routeResidencyFilter === "yes")) && (state.routeQTimeFilter === "all" || routeHasTimeConstraint(route, "qTimeLimit") === (state.routeQTimeFilter === "yes"))).map(({ route, routeIndex }) => {
    const routeOpen = state.expandedRoutes.has(routeIndex);
    const compactPath = routePickerCompactPath(route);
    return `<article class="route-summary-card"><div class="route-summary-head"><button class="route-summary-toggle" data-action="toggle-route" data-route-index="${routeIndex}" aria-expanded="${routeOpen}">
      <span class="collapse-arrow ${routeOpen ? "open" : ""}">\u25B6</span><span class="route-summary-content"><span class="route-summary-primary"><span class="route-summary-id">${routePickerShortId(route)}</span><strong title="${escapeHtml4(compactPath)}">${escapeHtml4(compactPath)}</strong>${renderRoutePropertyTags(route)}</span></span></button>
      <div class="route-summary-actions"><button class="btn small" data-action="open-context-clean" data-clean-scope="route" data-route-index="${routeIndex}">\uFF0B Clean</button><button class="btn small" data-action="edit-route" data-route-index="${routeIndex}">\u7F16\u8F91</button><button class="btn small" data-action="copy-route" data-route-index="${routeIndex}">\u590D\u5236</button><button class="btn danger small" data-action="remove-route" data-index="${routeIndex}">\u5220\u9664</button></div>
    </div>${routeOpen ? renderRouteDetails(route, routeIndex) : ""}</article>`;
  }).join("");
  host.innerHTML = routes ? `<div class="route-flat-list">${routes}</div>` : `<div class="empty">\u5F53\u524D\u7B5B\u9009\u6761\u4EF6\u4E0B\u6CA1\u6709\u5339\u914D\u7684\u8DEF\u5F84\u3002</div>`;
  initializeCompactSelects();
}
function routePickerShortId(route) {
  const routeIndex = state.routes.indexOf(route);
  return routeIndex < 0 ? "R-???" : `R-${String(routeIndex + 1).padStart(3, "0")}`;
}
function routePickerCleanInfo(cleanName) {
  const clean = state.cleans.find((item) => item.name === cleanName);
  return clean ? { ...normalizeClean(clean), defined: true } : { name: cleanName, cleanType: inferCleanType({ name: cleanName }), defined: false };
}
function routePickerWacToken(cleanName) {
  const clean = routePickerCleanInfo(cleanName);
  return clean.defined ? `wac ${Number(clean.triggerCount) || 0}|${formatCleanSeconds(clean.recipeTime)}` : "wac";
}
function routePickerStageWacTokens(stage) {
  const names = [...new Set((stage.visits || []).flatMap((visit) => [
    ...stringList(visit.beforeCleanRefs),
    ...stringList(visit.afterCleanRefs)
  ]))];
  return names.filter((name) => routePickerCleanInfo(name).cleanType === "wacclean").map(routePickerWacToken);
}
function routePickerCompactPath(route) {
  normalizeRoute(route);
  return (route.stages || []).map((stage) => {
    const candidates = [...new Set((stage.visits || []).map((visit) => String(visit.stationName || "").trim()).filter(Boolean))];
    const transferOnly = stage.kind === "robot" || candidates.length && candidates.every((name) => state.robotNames.includes(name) || /robot/i.test(name) || /^(?:ATR|VTR|DBR|UBR|TM|VTM|EFEM)(?:[_-]?\d+)?$/i.test(name));
    if (transferOnly) return "";
    let node = candidates.join("/") || "\u672A\u9009\u8154\u5BA4";
    if (stage.needProcess) {
      const processTime = Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0);
      node += `(${formatCleanSeconds(processTime)})`;
    }
    const wacTokens = routePickerStageWacTokens(stage);
    return `${node}${wacTokens.length ? `[${wacTokens.join("+")}]` : ""}`;
  }).filter(Boolean).join("->") || "\u672A\u914D\u7F6E\u8DEF\u5F84";
}
function routePickerProcessSummary(profile) {
  const chambers = (profile?.candidatePath || []).join(" \u2192 ");
  return { label: profile?.processLabel || "\u6682\u65E0\u5DE5\u5E8F", chambers: chambers || "\u672A\u914D\u7F6E\u52A0\u5DE5\u8154\u5BA4" };
}
function routePickerSpecialCleanSummary(route) {
  const names = [.../* @__PURE__ */ new Set([
    ...ROUTE_CLEAN_KEYS.flatMap((key) => stringList(route[key])),
    ...(route.stages || []).flatMap((stage) => (stage.visits || []).flatMap((visit) => [
      ...stringList(visit.beforeCleanRefs),
      ...stringList(visit.afterCleanRefs)
    ]))
  ])];
  return names.map(routePickerCleanInfo).filter((clean) => ["preclean", "postclean", "dummy", "dummywac"].includes(clean.cleanType)).map((clean) => {
    if (!clean.defined) return clean.name;
    if (clean.cleanType === "dummywac") return `dummywac ${formatCleanSeconds(clean.recipeTime)}|${formatCleanSeconds(clean.wacRecipeTime)}`;
    const label = { preclean: "pre", postclean: "post", dummy: "dummy" }[clean.cleanType] || clean.cleanType;
    return `${label} ${formatCleanSeconds(clean.recipeTime)}`;
  }).join(" \xB7 ");
}
function routePickerCleanSummary(route) {
  const special = routePickerSpecialCleanSummary(route);
  const wac = [...new Set((route.stages || []).flatMap(routePickerStageWacTokens))];
  return [special, ...wac].filter(Boolean).join(" \xB7 ") || "\u65E0";
}
function routeBufferMode(value) {
  const index = Math.max(0, Math.min(4, Math.trunc(Number(value) || 0)));
  const modes = [
    { label: "No Buffer", tone: "none" },
    { label: "\u5F3A\u5236 Buffer Out", tone: "forced" },
    { label: "\u5F3A\u5236 Buffer In", tone: "forced" },
    { label: "\u975E\u5F3A\u5236 Buffer Out", tone: "optional" },
    { label: "\u975E\u5F3A\u5236 Buffer In", tone: "optional" }
  ];
  return { index, ...modes[index] };
}
function routeHasTimeConstraint(route, field) {
  return (route.stages || []).some((stage) => (stage.visits || []).some((visit) => {
    const value = Number(visit[field]);
    return Number.isFinite(value) && value >= 0;
  }));
}
function renderRoutePropertyTags(route) {
  const buffer = routeBufferMode(route.bufferOption);
  const cleanSummary = routePickerCleanSummary(route);
  const cleanLabel = cleanSummary === "\u65E0" ? "\u65E0\u6E05\u6D01" : cleanSummary;
  const hasResidency = routeHasTimeConstraint(route, "residencyConstraint");
  const hasQTime = routeHasTimeConstraint(route, "qTimeLimit");
  return `<span class="route-property-tags"><span class="route-property-tag buffer-${buffer.tone}" title="Buffer \u4F7F\u7528\u6A21\u5F0F ${buffer.index}\uFF1A${escapeHtml4(buffer.label)}">${escapeHtml4(buffer.label)}</span><span class="route-property-tag clean-${cleanSummary === "\u65E0" ? "none" : "active"}" title="\u6E05\u6D01\uFF1A${escapeHtml4(cleanLabel)}">${escapeHtml4(cleanLabel)}</span><span class="route-property-tag constraint-${hasResidency ? "active" : "none"}" title="\u9A7B\u7559\u65F6\u95F4\u7EA6\u675F\uFF1A${hasResidency ? "\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E"}">\u9A7B\u7559${hasResidency ? "\u7EA6\u675F" : "\u65E0"}</span><span class="route-property-tag qtime-${hasQTime ? "active" : "none"}" title="QTime\uFF1A${hasQTime ? "\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E"}">QTime${hasQTime ? "" : "\u65E0"}</span></span>`;
}
function renderPJobRouteCard(route, baseline) {
  const routeIndex = state.routes.indexOf(route), selected = route === baseline;
  const compactPath = routePickerCompactPath(route);
  return `<button type="button" class="pjob-route-card ${selected ? "selected" : ""}" data-action="select-pjob-route" data-route-index="${routeIndex}" aria-pressed="${selected}" title="${escapeHtml4(compactPath)}">
    <span class="pjob-route-card-head"><span class="pjob-route-card-id">${routePickerShortId(route)}</span><strong class="pjob-route-card-path">${escapeHtml4(compactPath)}</strong>${renderRoutePropertyTags(route)}${selected ? `<span class="pjob-route-card-current">\u5F53\u524D\u9009\u62E9</span>` : ""}</span>
  </button>`;
}
function renderPJobRouteDialogGroup(groupKey) {
  const context = pjobRoutePickerContext;
  if (!context) return;
  const selectedGroup = context.groups.find((group) => group.key === groupKey) || context.groups[0];
  const filters = context.filters;
  const candidates = (selectedGroup?.routes || []).filter(({ route }) => (filters.clean === "all" || routePickerCleanSummary(route) !== "\u65E0" === (filters.clean === "yes")) && (filters.residency === "all" || routeHasTimeConstraint(route, "residencyConstraint") === (filters.residency === "yes")) && (filters.qtime === "all" || routeHasTimeConstraint(route, "qTimeLimit") === (filters.qtime === "yes")));
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  context.groupKey = selectedGroup?.key || "";
  document.getElementById("pjobRouteDialogContext").textContent = selectedGroup ? `${selectedGroup.processLabel} \xB7 ${selectedGroup.label} \xB7 ${candidates.length} \u6761\u5019\u9009\u8DEF\u5F84` : "\u5F53\u524D\u5DE5\u5E8F\u6CA1\u6709\u53EF\u7528\u8DEF\u5F84";
  document.getElementById("pjobRouteCardList").innerHTML = candidates.length ? candidates.map(({ route }) => renderPJobRouteCard(route, selectedRoute)).join("") : `<div class="pjob-route-dialog-empty">\u5F53\u524D\u5DE5\u5E8F\u6CA1\u6709\u53EF\u9009\u62E9\u7684\u8DEF\u5F84</div>`;
}
function openPJobRoutePicker(button) {
  const roundIndex = Number(button.dataset.roundIndex), cjobIndex = Number(button.dataset.cjobIndex), pjobIndex = Number(button.dataset.pjobIndex);
  const pjob = state.rounds[roundIndex]?.cjobs[cjobIndex]?.pjobs[pjobIndex];
  if (!pjob) return;
  const groups = groupedRoutes().flatMap((processGroup) => processGroup.structures);
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const selectedKey = selectedRoute ? routeProcessProfile(selectedRoute).key : groups[0]?.key || "";
  pjobRoutePickerContext = {
    roundIndex,
    cjobIndex,
    pjobIndex,
    trigger: button,
    groups,
    groupKey: selectedKey,
    filters: { clean: "all", residency: "all", qtime: "all" }
  };
  document.getElementById("pjobRouteDialogTitle").textContent = `\u9009\u62E9 ${pjob.jobName} \u7684\u8DEF\u5F84`;
  const processSelect = document.getElementById("pjobRouteProcess");
  processSelect.innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml4(group.key)}" ${group.key === selectedKey ? "selected" : ""}>${escapeHtml4(`${group.processLabel} \xB7 ${group.label}`)}</option>`).join("") : `<option value="">\u6682\u65E0\u5DE5\u5E8F</option>`;
  document.getElementById("pjobRouteCleanFilter").value = "all";
  document.getElementById("pjobRouteResidencyFilter").value = "all";
  document.getElementById("pjobRouteQTimeFilter").value = "all";
  renderPJobRouteDialogGroup(selectedKey);
  button.setAttribute("aria-expanded", "true");
  const dialog = document.getElementById("pjobRouteDialog");
  dialog.showModal();
  window.setTimeout(() => processSelect.focus(), 0);
}
function closePJobRoutePicker(restoreFocus = true) {
  const context = pjobRoutePickerContext, dialog = document.getElementById("pjobRouteDialog");
  if (dialog.open) dialog.close();
  if (context?.trigger?.isConnected) {
    context.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) context.trigger.focus();
  }
  pjobRoutePickerContext = null;
}
function selectPJobRoute(routeIndex) {
  const context = pjobRoutePickerContext, route = state.routes[routeIndex];
  if (!context || !route) return;
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  if (!pjob) return;
  pjob.routeRef = route.name;
  normalizeRounds();
  markTestDirty();
  closePJobRoutePicker(false);
  renderAll();
}
function renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex) {
  const groups = groupedRoutes().flatMap((processGroup) => processGroup.structures);
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const selectedKey = selectedRoute ? routeProcessProfile(selectedRoute).key : groups[0]?.key || "";
  const selectedGroup = groups.find((group) => group.key === selectedKey);
  const common = `data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}"`;
  const summary = routePickerProcessSummary(selectedRoute ? routeProcessProfile(selectedRoute) : selectedGroup);
  return `<div class="pjob-route-picker">
    <div class="pjob-route-current" title="${escapeHtml4(`${summary.label} \xB7 ${summary.chambers}`)}"><strong>${escapeHtml4(summary.label)}</strong><span>${escapeHtml4(summary.chambers)}</span></div>
    <button type="button" class="pjob-route-open" data-action="open-pjob-route-picker" data-route-group-key="${escapeHtml4(selectedKey)}" aria-label="\u9009\u62E9\u5177\u4F53\u8DEF\u5F84" aria-haspopup="dialog" aria-controls="pjobRouteDialog" aria-expanded="false" ${common} ${groups.length ? "" : "disabled"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
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
      const fieldPrefix = `round-${roundIndex}-cjob-${cjobIndex}`;
      const pjobRows = cjob.pjobs.map((pjob, pjobIndex) => {
        const pjobFieldPrefix = `${fieldPrefix}-pjob-${pjobIndex}`;
        return `<div class="pjob-row">
          <div class="pjob-identity"><span>PJob</span><strong>${escapeHtml4(pjob.jobName)}</strong></div>
          <label class="pjob-field pjob-material" for="${pjobFieldPrefix}-wafer-count"><span>Material</span><input id="${pjobFieldPrefix}-wafer-count" class="pjob-number" type="number" min="1" max="25" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="waferCount" value="${Number(pjob.waferCount)}"></label>
          <div class="pjob-field pjob-origin-route"><span>OriginRoute</span>${renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex)}</div>
          <label class="pjob-field pjob-priority" for="${pjobFieldPrefix}-priority"><span>Priority</span><input id="${pjobFieldPrefix}-priority" class="pjob-number" type="number" min="1" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="priority" value="${Number(pjob.priority)}"></label>
          <button class="btn danger icon pjob-remove" type="button" aria-label="\u5220\u9664 ${escapeHtml4(pjob.jobName)}" title="\u5220\u9664 ${escapeHtml4(pjob.jobName)}" data-action="remove-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" ${cjob.pjobs.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13"/></svg></button>
        </div>`;
      }).join("");
      return `<section class="cjob-card">
        <header class="cjob-head">
          <div class="cjob-title"><strong>CJob ${cjobIndex + 1}</strong><span class="cjob-task-id">TaskID ${escapeHtml4(cjob.taskId)}</span></div>
          <div class="cjob-controls">
            <div class="field cjob-job-type"><label for="${fieldPrefix}-job-type">JobType</label><select id="${fieldPrefix}-job-type" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="jobType">${CJOB_TYPES.map((value) => `<option ${value === cjob.jobType ? "selected" : ""}>${value}</option>`).join("")}</select></div>
            <div class="field cjob-priority ${normalLot ? "" : "disabled-field"}"><label for="${fieldPrefix}-priority">Priority</label><input id="${fieldPrefix}-priority" type="number" min="1" inputmode="numeric" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="priority" value="${Number(cjob.priority)}" ${normalLot ? "" : "disabled"}></div>
            <div class="field cjob-task-mode"><label for="${fieldPrefix}-task-mode">TaskMode</label><select id="${fieldPrefix}-task-mode" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="taskMode">${TASK_MODES.map((value) => `<option ${value === cjob.taskMode ? "selected" : ""} ${round.cjobs.length > 1 && ["Pipeline", "Sequential"].includes(value) ? "disabled" : ""}>${value}</option>`).join("")}</select></div>
          </div>
          <div class="round-actions cjob-actions"><button class="btn small" type="button" data-action="add-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>PJob</span></button><button class="btn danger small" type="button" data-action="remove-cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" ${round.cjobs.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13"/></svg><span>\u5220\u9664</span></button></div>
        </header>
        <div class="pjob-list">${pjobRows}</div>
      </section>`;
    }).join("");
    const cjobLimitReached = state.loadPorts.length > 0 && round.cjobs.length >= state.loadPorts.length;
    const addCJobDisabled = cjobLimitReached || serialMode;
    const addCJobTitle = serialMode ? "Pipeline/Sequential \u6BCF\u8F6E\u53EA\u80FD\u914D\u7F6E\u4E00\u4E2A CJob" : "\u6BCF\u8F6E CJob \u6570\u4E0D\u80FD\u8D85\u8FC7 LoadPort \u6570";
    return `<section class="round-card"><header class="round-head"><div class="round-summary"><div class="round-title"><div class="round-number">${roundIndex + 1}</div><strong>${roundTitle}</strong></div><label class="round-time-editor" for="round-${roundIndex}-time"><span>${roundIndex ? "\u91CD\u7B97\u65F6\u95F4" : "\u6392\u7A0B\u65F6\u95F4"}</span><span class="round-time-control"><input id="round-${roundIndex}-time" type="number" min="0" step="0.1" inputmode="decimal" data-round-time-index="${roundIndex}" value="${Number(round.currentTime)}" ${roundIndex ? "" : "disabled"}><b aria-hidden="true">s</b></span></label></div><button class="btn small round-add-cjob" type="button" data-action="add-cjob" data-round-index="${roundIndex}" ${addCJobDisabled ? `disabled title="${addCJobTitle}"` : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>CJob</span></button></header><div class="cjob-list">${cjobs}</div></section>`;
  }).join("");
  initializeCompactSelects();
}
function renderStepNumberField(label, key, value, routeIndex, stageIndex, options = {}) {
  const inputId = `step-${routeIndex}-${stageIndex}-${key}`;
  const helper = options.helper ? `<small class="field-help">${escapeHtml4(options.helper)}</small>` : "";
  const minimum = options.minimum === void 0 ? "" : ` min="${options.minimum}"`;
  return `<div class="step-edit-field">
    <label for="${inputId}">${escapeHtml4(label)}</label>
    <div class="step-number-control">
      <input id="${inputId}" type="number" inputmode="decimal" step="${options.step || "0.1"}"${minimum} data-scope="visit-shared" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-key="${key}" value="${escapeHtml4(value)}">
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
  const warning = differences.length ? `<div class="visit-warning" role="status"><strong>\u5019\u9009\u8154\u5BA4\u7684\u53EF\u7F16\u8F91\u53C2\u6570\u4E0D\u4E00\u81F4</strong><p>\u5DEE\u5F02\u9879\uFF1A${differenceNames.map(escapeHtml4).join("\u3001")}\u3002\u5F53\u524D\u663E\u793A\u9996\u4E2A\u5019\u9009\u7684\u503C\u3002</p><button class="btn small" data-action="sync-stage-visits" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u540C\u6B65\u5230\u5168\u90E8\u5019\u9009</button></div>` : "";
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
  const routeName = escapeHtml4(route.name || "\u672A\u547D\u540D\u8DEF\u5F84");
  document.getElementById("drawerBody").innerHTML = `<section class="step-overview-card">
    <div class="step-route-context"><span>\u6240\u5C5E\u8DEF\u5F84</span><strong title="${routeName}">${routeName}</strong></div>
    <dl class="step-meta-list">
      <div><dt>Step</dt><dd>#${stage.stepId}</dd></div>
      <div><dt>Next</dt><dd>${stage.postStepIds?.length ? stage.postStepIds.map((id) => `#${id}`).join(", ") : "End"}</dd></div>
      <div><dt>Processing</dt><dd>${stage.needProcess ? "Yes" : "No"}</dd></div>
      <div><dt>Candidates</dt><dd>${stage.visits.length}</dd></div>
    </dl>
    <div class="step-candidates"><span>\u5019\u9009\u8154\u5BA4</span><div class="candidate-chip-list">${candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml4(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u672A\u9009\u62E9</span>`}</div></div>
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
  const dualArmCount = state.robotNames.filter((name) => {
    const robot = state.baseDevice.Robots[name] || {};
    const selected = state.robotSlots[name] || robotDefaultSlots(robot);
    return robotArmSlotGroups(robot).filter((group) => group.slotIds.some((slotId) => selected.includes(slotId))).length >= DUAL_ARM_SLOT_COUNT;
  }).length;
  summary.textContent = `${state.robotNames.length} \u53F0\u673A\u5668\u624B \xB7 ${dualArmCount} \u53F0\u53CC\u81C2`;
  container.innerHTML = state.robotNames.map((robotName) => {
    const robot = state.baseDevice.Robots[robotName] || {};
    const available = robotAvailableSlots(robot);
    const armGroups = robotArmSlotGroups(robot);
    const selected = state.robotSlots[robotName] || available;
    const defaults = robotDefaultSlots(robot);
    const selectedArmCount = armGroups.filter((group) => group.slotIds.some((slotId) => selected.includes(slotId))).length;
    const isDualArm = selectedArmCount >= DUAL_ARM_SLOT_COUNT;
    const supportsDualArm = armGroups.length >= DUAL_ARM_SLOT_COUNT;
    const isDefault = JSON.stringify(selected) === JSON.stringify(defaults);
    const isSaving = state.robotSlotsSaving.has(robotName);
    const accessibleStationCount = new Set(
      Object.values(robot.ArmInfo || {}).flatMap((arm) => arm?.AccessibleStations || [])
    ).size;
    const tokens = armGroups.map((group) => group.slotIds.map((slotId) => `
      <span class="robot-slot-token ${selected.includes(slotId) ? "is-active" : ""}">
        ${escapeHtml4(group.armName)} \xB7 Slot ${slotId}
      </span>
    `).join("")).join("");
    return `
      <article class="robot-slot-card" data-robot-slot-card="${escapeHtml4(robotName)}">
        <header class="robot-slot-card-head">
          <div class="robot-slot-card-title">
            <span class="robot-slot-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 18v3m8-3v3"/></svg>
            </span>
            <div>
              <h3>${escapeHtml4(robotName)}</h3>
              <p>${escapeHtml4(robot.Type || "Robot")} \xB7 \u53EF\u8FBE ${accessibleStationCount} \u4E2A\u7AD9\u70B9</p>
            </div>
          </div>
          <span class="robot-slot-mode">${isSaving ? "\u4FDD\u5B58\u4E2D\u2026" : isDualArm ? "\u53CC\u81C2" : "\u5355\u81C2"}</span>
        </header>
        <div class="robot-slot-visual" aria-label="${escapeHtml4(robotName)} \u53EF\u7528\u69FD\u4F4D">${tokens}</div>
        <div class="robot-slot-controls" role="group" aria-label="${escapeHtml4(robotName)} \u5DE5\u4F5C\u6A21\u5F0F">
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml4(robotName)}" data-robot-arm-count="1" aria-pressed="${String(!isDualArm)}" ${isSaving ? "disabled" : ""}>\u5355\u81C2</button>
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml4(robotName)}" data-robot-arm-count="2" aria-pressed="${String(isDualArm)}" ${!supportsDualArm || isSaving ? "disabled" : ""}>\u53CC\u81C2</button>
          <button class="robot-slot-choice robot-slot-default" type="button" data-robot-slot-default="${escapeHtml4(robotName)}" ${isDefault || isSaving ? "disabled" : ""}>\u6062\u590D\u9ED8\u8BA4</button>
        </div>
        <p class="robot-slot-card-note">${supportsDualArm ? "\u6309\u7269\u7406 Arm \u5207\u6362\uFF1B\u6BCF\u4E2A Arm \u58F0\u660E\u7684\u591A\u4E2A\u69FD\u4F4D\u4F1A\u4E00\u8D77\u4FDD\u7559\u3002" : `\u8BBE\u5907\u6587\u4EF6\u58F0\u660E 1 \u4E2A Arm\u3001${available.length} \u4E2A\u624B\u69FD\u3002`}</p>
      </article>
    `;
  }).join("");
}
async function setRobotArmCount(robotName, armCount) {
  if (!state.workspaceDeviceId || !state.baseDevice?.Robots?.[robotName]) return;
  const armGroups = robotArmSlotGroups(state.baseDevice.Robots[robotName]);
  const boundedCount = Math.max(1, Math.min(Number(armCount) || 1, DUAL_ARM_SLOT_COUNT, armGroups.length));
  const previousSelections = structuredClone(state.robotSlots);
  const selectedSlots = armGroups.slice(0, boundedCount).flatMap((group) => group.slotIds);
  const nextSelections = { ...state.robotSlots, [robotName]: selectedSlots };
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
  const defaultArmCount = robotArmSlotGroups(robot).filter(
    (group) => group.slotIds.some((slotId) => defaults.includes(slotId))
  ).length;
  await setRobotArmCount(robotName, defaultArmCount);
  setWorkspaceStatus(`\u5DF2\u6062\u590D ${robotName} \u7684\u8BBE\u5907\u6587\u4EF6\u9ED8\u8BA4\u914D\u7F6E`, "saved");
}
function renderAll() {
  renderTimes();
  renderRoutes();
  renderRounds();
  renderRobotSlots();
  if (state.drawer) renderStepDrawer();
}
function openScheduleAlphaGoOptionsDialog() {
  pendingAlphaGoCheckpointFile = null;
  const configuredPath = String(state.options.scheduleAlphaGoModelPath || "").trim();
  document.getElementById("alphaGoCheckpointPath").value = configuredPath;
  document.getElementById("alphaGoCheckpointFile").value = "";
  document.getElementById("alphaGoCheckpointHint").textContent = configuredPath ? "\u5F53\u524D checkpoint \u5DF2\u4FDD\u5B58\u5728\u672C\u5730\u670D\u52A1\u4E2D\uFF1B\u91CD\u65B0\u9009\u62E9\u6587\u4EF6\u53EF\u66FF\u6362\u5B83\u3002" : "\u9009\u62E9\u672C\u673A checkpoint \u540E\u5C06\u4E0A\u4F20\u5230\u672C\u5730\u670D\u52A1\uFF0C\u5E76\u7528\u4E8E\u540E\u7EED\u8FD0\u884C\u3002";
  document.getElementById("scheduleAlphaGoOptionsDialog").showModal();
}
async function uploadAlphaGoCheckpoint(file) {
  const response = await fetch("/api/model-checkpoints", {
    method: "POST",
    headers: { "X-Checkpoint-Filename": encodeURIComponent(file.name) },
    body: file
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.modelPath) {
    throw new Error(result.error || `checkpoint \u4E0A\u4F20\u5931\u8D25\uFF08${response.status}\uFF09`);
  }
  return String(result.modelPath);
}
async function saveScheduleAlphaGoOptions() {
  const saveButton = document.getElementById("saveScheduleAlphaGoOptionsButton");
  saveButton.disabled = true;
  try {
    const modelPath = pendingAlphaGoCheckpointFile ? await uploadAlphaGoCheckpoint(pendingAlphaGoCheckpointFile) : String(document.getElementById("alphaGoCheckpointPath").value || "").trim();
    state.options.scheduleAlphaGoModelPath = modelPath;
    pendingAlphaGoCheckpointFile = null;
    retainSessionSchedulingConfiguration();
    markTestDirty();
    renderAll();
    document.getElementById("scheduleAlphaGoOptionsDialog").close();
  } finally {
    saveButton.disabled = false;
  }
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
    retainSessionSchedulingConfiguration();
    return;
  }
  const scope = control.dataset.scope;
  if (scope === "route") {
    if (key === "bufferOption") value = Math.max(0, Math.min(4, Math.trunc(Number(value) || 0)));
    state.routes[Number(control.dataset.index)][key] = ROUTE_CLEAN_KEYS.includes(key) ? value ? [value] : [] : value;
  }
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
  if (scope === "pjob") {
    const pjob = state.rounds[Number(control.dataset.roundIndex)].cjobs[Number(control.dataset.cjobIndex)].pjobs[Number(control.dataset.pjobIndex)];
    pjob[key] = value;
    normalizeRounds();
  }
}
function handleAction(button) {
  const action = button.dataset.action, index = Number(button.dataset.index), routeIndex = Number(button.dataset.routeIndex), stageIndex = Number(button.dataset.stageIndex), visitIndex = Number(button.dataset.visitIndex);
  if (action === "open-pjob-route-picker") {
    openPJobRoutePicker(button);
    return;
  }
  if (action === "select-pjob-route") {
    selectPJobRoute(routeIndex);
    return;
  }
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
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
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
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
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
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
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
  if (station) {
    if (Array.isArray(station.Slots) && station.Slots.length) return station.Slots.map(Number);
    const capacity = Number(station.Capacity) || 0;
    return capacity >= 1 ? Array.from({ length: capacity }, (_, index) => index + 1) : [1];
  }
  const robot = state.device?.Robots?.[stationName];
  return robot ? robotDefaultSlots(robot) : [1];
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
  const options = { ...state.options };
  if (state.strategy === "schedule-alphago") {
    options.scheduleAlphaGoExecutionMode = playbackMode === "step" ? "stepped" : "continuous";
  }
  return { schemaVersion: EXPECTED_API_SCHEMA, workspaceDeviceId: state.workspaceDeviceId, workspaceTestId: state.testCaseId, deviceName: state.deviceName, device: state.device, strategy: state.strategy, roundCount: state.roundCount, options, skipValidation: skipValidationEnabled(), skipBaseline: skipBaselineEnabled(), recipes: collectRecipes(routes), cleans, routes, rounds: structuredClone(state.rounds) };
}
function skipValidationEnabled() {
  return document.getElementById("skipValidationInput")?.checked === true;
}
function skipBaselineEnabled() {
  return document.getElementById("skipBaselineInput")?.checked === true;
}
function validationDisplay(value) {
  if (value === "passed") return "\u901A\u8FC7";
  if (value === "skipped") return "\u8DF3\u8FC7";
  return value ? String(value) : "";
}
function renderOtherAlgorithmOptions(algorithms) {
  state.availableAlgorithms = Array.isArray(algorithms) ? algorithms : [];
  const container = document.getElementById("otherAlgorithmOptions");
  container.innerHTML = state.availableAlgorithms.map((algorithm) => `
    <label class="strategy-card" data-strategy-card="${escapeHtml4(algorithm.strategy)}" ${algorithm.unavailableReason ? `title="${escapeHtml4(algorithm.unavailableReason)}"` : ""}>
      <input type="radio" name="strategy" value="${escapeHtml4(algorithm.strategy)}" ${algorithm.strategy === state.strategy ? "checked" : ""} ${algorithm.available === false ? "disabled" : ""}>
      <b>${escapeHtml4(algorithm.name)}</b>
    </label>
  `).join("");
  updateStrategyOptionVisibility();
  renderAlgorithmMetadata();
}
function updateStrategyOptionVisibility() {
  const algorithm = state.availableAlgorithms.find((item) => item.strategy === state.strategy);
  const optionGroups = new Set(algorithm?.optionGroups || []);
  document.getElementById("loadlockOptions").classList.toggle("is-hidden", !optionGroups.has("loadlock"));
  document.getElementById("heuristicObjectiveOptions").classList.toggle("is-hidden", !optionGroups.has("heuristic-objectives"));
  document.getElementById("scheduleAlphaGoOptions").classList.toggle("is-hidden", !optionGroups.has("schedule-alphago"));
}
function showAlgorithmDetails(strategy) {
  const metadata = state.algorithmMetadata[strategy] || {};
  const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(strategy)}"] b`)?.textContent;
  document.getElementById("algorithmHoverInfo").innerHTML = `
    <span class="algorithm-hover-info-name">${escapeHtml4(metadata.name || cardName || strategy)}<small>\u7B97\u6CD5\u7B80\u4ECB</small></span>
    <span class="algorithm-hover-info-description">${escapeHtml4(metadata.introduction || "\u6682\u65E0\u7B97\u6CD5\u7B80\u4ECB")}</span>
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
    ["loadLockMacroRollouts", "\u5B8F\u91C7\u6837", "", ["loadlock-macro"]]
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
  if (latestSearchTelemetry?.algorithm === "schedule-alphago") {
    renderSearchTelemetry(latestSearchTelemetry);
  }
  return visualizationWorkspace.getBottleneckUtilization();
}
async function runPlan() {
  const button = document.getElementById("runButton");
  const stepRunButton = document.getElementById("stepRunButton");
  const batchButton = document.getElementById("batchRunButton");
  const comparisonButton = document.getElementById("openParameterComparisonDialogButton");
  let logReady = false, ganttReady = false, runResult = null, bottleneckSummary = null;
  const telemetryEnabled = state.strategy === "schedule-alphago";
  let telemetryStopped = false;
  try {
    const healthResponse = await fetch("/api/health", { cache: "no-store" }), health = await healthResponse.json();
    if (!healthResponse.ok || health.schemaVersion !== EXPECTED_API_SCHEMA) throw new Error("\u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\uFF0C\u8BF7\u91CD\u542F scripts/config_editor_server.py");
    if (state.strategy.startsWith("other_alg:")) {
      const algorithm = (health.otherAlgorithms || []).find((item) => item.strategy === state.strategy);
      if (!algorithm?.available) throw new Error(`${state.strategy} \u7B97\u6CD5\u5305\u4E0D\u5B58\u5728\u6216\u5165\u53E3\u4E0D\u5B8C\u6574`);
    } else if (health.strategies?.[state.strategy] === false) {
      throw new Error(health.strategyErrors?.[state.strategy] || `${state.strategy} \u7B56\u7565\u5F53\u524D\u4E0D\u53EF\u7528`);
    }
    if (state.testCaseId) await saveCurrentTest(true);
    const payload = buildPayload();
    button.disabled = true;
    batchButton.disabled = true;
    comparisonButton.disabled = true;
    button.classList.add("running");
    button.textContent = "\u6B63\u5728\u8FD0\u884C\u7B56\u7565\u2026";
    if (telemetryEnabled) {
      stepRunActive = true;
      stepRunCancelling = false;
      stepRunButton.classList.add("cancel");
      stepRunButton.disabled = false;
      stepRunButton.textContent = "\u25A0 \u505C\u6B62\u6A21\u578B\u6B65\u8FDB";
    }
    resetRunResult();
    visualizationWorkspace.setAnalysisConfiguration(state.routes, state.rounds);
    if (telemetryEnabled) {
      visualizationWorkspace.beginLiveSolve(
        payload,
        `${displayStrategyName(state.strategy)} \xB7 \u5B9E\u65F6\u6C42\u89E3`
      );
      visualizationWorkspace.showPlayback();
      startSearchTelemetryPolling();
    }
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
    if (telemetryEnabled) {
      stopSearchTelemetryPolling(runResult?.searchTelemetry || null);
      telemetryStopped = true;
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
    const cancelled = runResult?.cancelled === true;
    const baselineError = runResult?.baseline?.status === "failed" ? `
  Baseline \u5931\u8D25\uFF1A${runResult.baseline.error || "\u672A\u77E5\u539F\u56E0"}` : "";
    const validationIssues = Array.isArray(runResult?.validationIssues) ? runResult.validationIssues.map((issue) => `  ${issue}`) : [];
    if (!runResult?.metricsAvailable && ganttReady) {
      setBottleneckMetric(bottleneckSummary, "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8");
      document.getElementById("metricMakespan").textContent = Number.isFinite(Number(runResult.makespan)) ? `${Number(runResult.makespan).toFixed(2)} s` : "\u2014";
    }
    writeTerminal([
      cancelled ? `$ \u6A21\u578B\u6B65\u8FDB\u8FD0\u884C\u5DF2\u53D6\u6D88` : `$ \u8FD0\u884C\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`,
      ...validationIssues,
      ...baselineError ? [baselineError.trim()] : [],
      ...ganttReady ? ["  \u5931\u8D25 MoveList \u5DF2\u4FDD\u7559\uFF0C\u53EF\u70B9\u51FB\u201C\u6253\u5F00\u7518\u7279\u56FE\u201D\u67E5\u770B\u7EA2\u8272\u95EE\u9898 Move"] : [],
      ...logReady ? ["  \u590D\u73B0\u65E5\u5FD7\u5DF2\u751F\u6210\uFF0C\u53EF\u70B9\u51FB\u201C\u5BFC\u51FA\u590D\u73B0\u65E5\u5FD7\u201D"] : []
    ].join("\n"), true);
    document.getElementById("metricValidation").textContent = runResult?.metricsAvailable ? runResult.validation === "failed" ? "\u672A\u901A\u8FC7" : validationDisplay(runResult.validation) || "\u5931\u8D25" : "\u5931\u8D25";
  } finally {
    if (telemetryEnabled && !telemetryStopped) {
      stopSearchTelemetryPolling(runResult?.searchTelemetry || null);
    }
    if (stepRunActive) {
      stepRunActive = false;
      stepRunCancelling = false;
      stepRunButton.classList.remove("cancel");
      stepRunButton.textContent = "\u27F3 \u8FD0\u884C\u6A21\u578B\u6B65\u8FDB";
    }
    button.disabled = false;
    button.classList.remove("running");
    button.textContent = "\u25B6 \u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5";
    renderWorkspaceControls();
  }
}
async function runModelStepped() {
  const stepButton = document.getElementById("stepRunButton");
  if (stepButton.disabled) return;
  if (stepRunActive) {
    if (stepRunCancelling) return;
    stepRunCancelling = true;
    stepButton.disabled = true;
    stepButton.textContent = "\u6B63\u5728\u505C\u6B62\u2026";
    writeTerminal("$ \u6B63\u5728\u505C\u6B62\u6A21\u578B\u6B65\u8FDB\u8FD0\u884C\u2026");
    try {
      await requestSearchControl("cancel");
    } catch (error) {
      stepRunCancelling = false;
      stepButton.disabled = false;
      stepButton.classList.add("cancel");
      stepButton.textContent = "\u25A0 \u505C\u6B62";
      writeTerminal(`$ \u505C\u6B62\u8BF7\u6C42\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}
  \u53EF\u518D\u6B21\u70B9\u51FB\u201C\u25A0 \u505C\u6B62\u201D\u91CD\u8BD5\u3002`, true);
    }
    return;
  }
  if (state.strategy !== "schedule-alphago") {
    writeTerminal("$ \u8FD0\u884C\u6A21\u578B\u6B65\u8FDB\u4EC5\u652F\u6301 Schedule-AlphaGo \u7B56\u7565\uFF0C\u8BF7\u5148\u5728\u201C\u8FD0\u884C\u7B56\u7565\u201D\u4E2D\u9009\u62E9\u3002", true);
    return;
  }
  playbackMode = "step";
  renderPlaybackModeSwitch();
  await runPlan();
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
      body: JSON.stringify({ deviceId: state.workspaceDeviceId, group: state.activeTestGroup, strategy: state.strategy, options: state.options, skipValidation: skipValidationEnabled(), skipBaseline: skipBaselineEnabled() })
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
function setBottleneckMetric(summary, emptyDetail = "") {
  const utilization = Number(summary?.utilization);
  const available = summary && Number.isFinite(utilization);
  const resourceName = String(summary?.resourceName || "\u672A\u77E5\u8D44\u6E90").replace(/^工序容量组\s*[·:：-]?\s*/, "").trim() || "\u672A\u77E5\u8D44\u6E90";
  setResultMetric(
    "Moves",
    "Bottleneck Utilization",
    available ? `${resourceName} ${(utilization * 100).toFixed(1)}%` : "\u2014",
    available ? "" : emptyDetail
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
  setResultMetric("Time", "Total Time", timeText);
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
  const validationText = item.validation === "passed" ? "\u901A\u8FC7" : item.validation === "skipped" ? "\u8DF3\u8FC7" : item.validation ? String(item.validation) : item.status === "failed" ? "\u8FD0\u884C\u5931\u8D25" : item.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u7B49\u5F85\u5B8C\u6210";
  const comparisonDetail = baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status && baseline.status !== "succeeded" && baseline.status !== "skipped" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}` : "";
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
  setResultMetric("Validation", "Validation", validationText, item.error || "");
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
    const improvementText = hasMetrics && baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status === "skipped" ? "\u5DF2\u8DF3\u8FC7\u57FA\u7EBF" : baseline.status && baseline.status !== "succeeded" ? "\u65E0\u6709\u6548\u57FA\u7EBF" : "\u63D0\u5347 \u2014";
    const baselineReason = baseline.status === "skipped" ? "" : baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}` : "";
    const summaryError = baseline.status === "failed" ? baselineReason : item.status === "failed" ? `${hasMetrics ? "\u6821\u9A8C\u5931\u8D25" : "\u8FD0\u884C\u5931\u8D25"}\uFF1A${item.error || "\u672A\u77E5\u9519\u8BEF"}` : item.status === "cancelled" ? "\u8C03\u5EA6\u5DF2\u7EC8\u6B62" : baselineReason;
    const displayId = `t${index + 1}`;
    const itemSelectionId = String(item.testId || `index-${index}`);
    const selected = itemSelectionId === state.selectedBatchTestId;
    return `
      <div class="batch-result ${escapeHtml4(item.status || "queued")}${selected ? " selected" : ""}" data-batch-item-index="${index}">
        <div class="batch-result-head">
          <button class="batch-result-title" type="button" aria-pressed="${selected}" aria-label="\u67E5\u770B ${escapeHtml4(displayId)} ${escapeHtml4(item.testName || "")} \u7684\u8BE6\u7EC6\u6307\u6807"><strong title="${escapeHtml4(`${item.testId || ""} \xB7 ${item.testName || ""}`)}">${escapeHtml4(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}</strong></button>
          <div class="batch-result-meta">
            <span class="batch-status">${statusLabels[item.status] || "\u7B49\u5F85\u4E2D"}</span>
            ${item.logUrl ? `<a class="btn" href="${escapeHtml4(item.logUrl)}" download>\u65E5\u5FD7</a>` : `<span class="btn" aria-disabled="true">\u65E5\u5FD7</span>`}
            ${item.resultUrl ? `<button class="btn primary" type="button" data-workspace-result="${escapeHtml4(item.resultUrl)}" data-workspace-name="${escapeHtml4(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}">\u5DE5\u4F5C\u53F0</button>` : `<span class="btn" aria-disabled="true">\u5DE5\u4F5C\u53F0</span>`}
            ${item.ganttUrl ? `<a class="btn" href="${escapeHtml4(item.ganttUrl)}" target="_blank">\u7518\u7279\u56FE</a>` : `<span class="btn" aria-disabled="true">\u7518\u7279\u56FE</span>`}
          </div>
        </div>
        <div class="batch-result-summary">
          <div class="batch-metric-tags" aria-label="\u4E3B\u8981\u6307\u6807">
            <span class="batch-metric-tag makespan" title="Makespan${baselineReady ? `\uFF1BBaseline ${Number(baseline.makespan).toFixed(2)} s` : ""}">${hasMetrics ? `${Number(item.makespan).toFixed(2)} s` : "\u2014 s"}</span>
            <span class="batch-metric-tag ${improvement < 0 ? "loss" : "gain"}">${escapeHtml4(improvementText)}</span>
            <span class="batch-metric-tag cpu">CPU Time ${hasMetrics && Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014"}</span>
          </div>
          ${summaryError ? `<span class="summary-error" title="${escapeHtml4(summaryError)}">${escapeHtml4(summaryError)}</span>` : ""}
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
    if (item.status === "succeeded" && item.validation && item.validation !== "passed" && item.validation !== "skipped") {
      return [`t${index + 1} ${item.testName || ""}\uFF1AMoveList \u6821\u9A8C ${validationDisplay(item.validation)}${item.error ? `\uFF1B${item.error}` : ""}`];
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
    return `<div class="comparison-row"><span>${escapeHtml4(label)}</span><strong>${escapeHtml4(base)}</strong><strong>${escapeHtml4(candidate)}</strong><strong class="comparison-delta ${escapeHtml4(deltaValue.kind)}">${escapeHtml4(deltaValue.text)}</strong></div>`;
  }).join("");
}
function renderParameterComparisonCard(index, baseline, experiment) {
  const makespanDelta = comparisonDelta(baseline.result?.makespan, experiment.result?.makespan, 2, " s");
  const validation = experiment.result?.validation === "passed" ? "\u6821\u9A8C\u901A\u8FC7" : experiment.result?.validation === "skipped" ? "\u6821\u9A8C\u8DF3\u8FC7" : `\u6821\u9A8C ${experiment.result?.validation || "\u672A\u77E5"}`;
  return `<article class="comparison-experiment">
    <header class="comparison-experiment-head"><div><strong>\u57FA\u51C6 vs \u5BF9\u6BD4 ${index + 1}</strong><span> ${escapeHtml4(displayStrategyName(baseline.plan.strategy))} \u2192 ${escapeHtml4(displayStrategyName(experiment.plan.strategy))}</span></div><div><span class="comparison-delta ${escapeHtml4(makespanDelta.kind)}">Makespan ${escapeHtml4(makespanDelta.text)}</span>${experiment.result?.ganttUrl ? `<a class="btn" href="${escapeHtml4(experiment.result.ganttUrl)}" target="_blank">\u7518\u7279\u56FE</a>` : ""}</div></header>
    <div class="comparison-table"><div class="comparison-row comparison-row-head"><span>\u6307\u6807</span><strong>\u57FA\u51C6</strong><strong>\u5BF9\u6BD4</strong><strong>\u5DEE\u503C</strong></div>${renderParameterComparisonRows(baseline, experiment)}</div>
    <small>${escapeHtml4(validation)}</small>
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
    "loadlock-macro": [["loadLockMacroSearchSeconds", "\u5B8F\u641C\u7D22\u65F6\u95F4\uFF08\u79D2\uFF09", "number", "0.1"], ["loadLockMacroRollouts", "\u5B8F\u91C7\u6837\u6B21\u6570", "number", "1"]]
  };
  const fields = definitions[strategy] || [];
  document.getElementById("parameterComparisonStrategyOptions").innerHTML = fields.length ? `<div class="grid">${fields.map(([key, label, type, step]) => `<div class="field span-4"><label>${escapeHtml4(label)}<input data-comparison-option="${escapeHtml4(key)}" type="${type}" min="0" step="${step}" value="${escapeHtml4(String(options[key] ?? 0))}" required></label></div>`).join("")}</div>` : `<div class="hint">\u8BE5\u7B56\u7565\u6CA1\u6709\u989D\u5916\u7684\u7B56\u7565\u4E13\u5C5E\u53C2\u6570\uFF1B\u4E0A\u65B9\u901A\u7528\u7EA6\u675F\u53C2\u6570\u4ECD\u4F1A\u751F\u6548\u3002</div>`;
}
function openParameterComparisonDialog() {
  const comparison = state.parameterComparison;
  if (!comparison?.baseline) return;
  const baseline = comparison.baseline;
  const strategySelect = document.getElementById("parameterComparisonStrategy");
  const strategies = [...document.querySelectorAll('input[name="strategy"]')].filter((input) => !input.disabled || input.value === baseline.plan.strategy).map((input) => input.value);
  strategySelect.innerHTML = strategies.map((strategy) => `<option value="${escapeHtml4(strategy)}">${escapeHtml4(displayStrategyName(strategy))}</option>`).join("");
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
  document.getElementById("metricValidationLabel").textContent = "Validation";
  document.getElementById("metricTime").textContent = `${cpuTime.toFixed(1)} ms`;
  document.getElementById("metricMakespan").textContent = `${result.makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "\u2014"} s`;
  const validationValue = validationDisplay(result.validation);
  document.getElementById("metricValidation").textContent = validationValue;
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-success", result.validation === "passed");
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-error", result.validation !== "passed" && result.validation !== "skipped");
  const objectiveDiagnostics = [...result.rounds || []].reverse().map((round) => round.strategyDiagnostics).find((diagnostics) => diagnostics?.metrics);
  if (objectiveDiagnostics) {
    const metrics = objectiveDiagnostics.metrics;
    document.getElementById("metricValidationLabel").textContent = "Validation / Multi-metric";
    document.getElementById("metricValidationDetail").textContent = `\u9A7B\u7559\u8D85\u9650 ${Number(metrics.residencyViolationCount) || 0} \u6B21 \xB7 \u6700\u5927\u6301\u7247 ${Number(metrics.maximumRobotHoldingSeconds || 0).toFixed(2)} s \xB7 \u7CFB\u7EDF\u505C\u7559 CV ${Number(metrics.systemResidenceCv || 0).toFixed(3)}`;
  }
  const dualActorDiagnostics = (result.rounds || []).map((round) => round.strategyDiagnostics).filter((diagnostics) => diagnostics?.selectedSource === "dual-actor-e2e");
  if (dualActorDiagnostics.length) {
    const totals = dualActorDiagnostics.reduce((summary, diagnostics) => ({
      atmosphere: summary.atmosphere + (Number(diagnostics.actorDecisionCounts?.atmosphere) || 0),
      vacuum: summary.vacuum + (Number(diagnostics.actorDecisionCounts?.vacuum) || 0),
      pick: summary.pick + (Number(diagnostics.primitiveActionCounts?.pick) || 0),
      place: summary.place + (Number(diagnostics.primitiveActionCounts?.place) || 0),
      swap: summary.swap + (Number(diagnostics.primitiveActionCounts?.swap) || 0)
    }), { atmosphere: 0, vacuum: 0, pick: 0, place: 0, swap: 0 });
    document.getElementById("metricValidationLabel").textContent = "Validation / Dual Actor";
    document.getElementById("metricValidationDetail").textContent = `\u51B3\u7B56\uFF1A\u5927\u6C14 ${totals.atmosphere} \xB7 \u771F\u7A7A ${totals.vacuum}\uFF1B\u539F\u5B50\u52A8\u4F5C\uFF1APick ${totals.pick} \xB7 Place ${totals.place} \xB7 Swap ${totals.swap}`;
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
  const comparisonDetail = Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}% \xB7 \u7ED3\u679C\u6821\u9A8C\u672A\u901A\u8FC7` : baseline.status === "skipped" ? "" : baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}` : "\u5916\u90E8\u7B97\u6CD5\u672A\u8FD4\u56DE\u53EF\u6BD4\u8F83\u7684\u5B8C\u6574 Makespan";
  document.getElementById("metricContext").textContent = "\u5F53\u524D\u6D4B\u8BD5 \xB7 \u5916\u90E8\u7B97\u6CD5\u5931\u8D25\u7ED3\u679C";
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "\u5931\u8D25\u524D\u8017\u65F6", Number.isFinite(elapsedTime) ? `${elapsedTime.toFixed(1)} ms` : "\u2014", "\u4ECE\u63D0\u4EA4\u5230\u8FD4\u56DE\u5931\u8D25\u7ED3\u679C");
  setResultMetric("Makespan", "Makespan / Baseline", makespanText, comparisonDetail);
  setBottleneckMetric(result?.bottleneckUtilization, result?.resultId ? "\u5931\u8D25\u7ED3\u679C\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8" : "\u672A\u751F\u6210\u53EF\u5206\u6790\u7684 MoveList");
  setResultMetric("Validation", "Validation", result?.validation === "failed" ? "\u672A\u901A\u8FC7" : String(result?.validation || "\u5931\u8D25"), result?.error || "");
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
    const e2eCTQAvailable = status.strategies?.["e2e-ctq"] === true, dualActorE2EAvailable = status.strategies?.["dual-actor-e2e"] === true;
    state.algorithmMetadata = status.algorithmMetadata || {};
    const replayModelSelect = document.getElementById("visualRecommendationModel");
    replayModelSelect.querySelector('option[value="e2e-ctq"]').disabled = !e2eCTQAvailable;
    replayModelSelect.querySelector('option[value="dual-actor-e2e"]').disabled = !dualActorE2EAvailable;
    if (replayModelSelect.selectedOptions[0]?.disabled) {
      replayModelSelect.value = dualActorE2EAvailable ? "dual-actor-e2e" : "e2e-ctq";
      replayModelSelect.dispatchEvent(new Event("change"));
    }
    renderOtherAlgorithmOptions(status.algorithms || status.otherAlgorithms || []);
    runButton.disabled = !compatible;
    batchRunButton.disabled = !compatible;
    comparisonButton.disabled = !compatible || !state.parameterComparison?.baseline;
    document.getElementById("stepRunButton").disabled = !compatible || state.strategy !== "schedule-alphago";
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
    document.getElementById("stepRunButton").disabled = true;
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
document.getElementById("pjobRouteDialogClose").addEventListener("click", () => closePJobRoutePicker());
document.getElementById("pjobRouteDialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closePJobRoutePicker();
});
document.getElementById("pjobRouteDialog").addEventListener("click", (event) => {
  if (event.target.id === "pjobRouteDialog") closePJobRoutePicker();
});
document.getElementById("pjobRouteProcess").addEventListener("change", (event) => renderPJobRouteDialogGroup(event.target.value));
document.getElementById("pjobRouteCleanFilter").addEventListener("change", (event) => {
  if (!pjobRoutePickerContext) return;
  pjobRoutePickerContext.filters.clean = event.target.value;
  renderPJobRouteDialogGroup(pjobRoutePickerContext.groupKey);
});
document.getElementById("pjobRouteResidencyFilter").addEventListener("change", (event) => {
  if (!pjobRoutePickerContext) return;
  pjobRoutePickerContext.filters.residency = event.target.value;
  renderPJobRouteDialogGroup(pjobRoutePickerContext.groupKey);
});
document.getElementById("pjobRouteQTimeFilter").addEventListener("change", (event) => {
  if (!pjobRoutePickerContext) return;
  pjobRoutePickerContext.filters.qtime = event.target.value;
  renderPJobRouteDialogGroup(pjobRoutePickerContext.groupKey);
});
document.getElementById("routeProcessFilter").addEventListener("change", (event) => {
  state.routeProcessFilter = event.target.value;
  state.routeParallelFilter = "";
  renderRoutes();
});
document.getElementById("routeParallelFilter").addEventListener("change", (event) => {
  state.routeParallelFilter = event.target.value;
  renderRoutes();
});
document.getElementById("routeCleanFilter").addEventListener("change", (event) => {
  state.routeCleanFilter = event.target.value;
  renderRoutes();
});
document.getElementById("routeResidencyFilter").addEventListener("change", (event) => {
  state.routeResidencyFilter = event.target.value;
  renderRoutes();
});
document.getElementById("routeQTimeFilter").addEventListener("change", (event) => {
  state.routeQTimeFilter = event.target.value;
  renderRoutes();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.getElementById("pjobRouteDialog").open) {
    event.preventDefault();
    closePJobRoutePicker();
  }
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
document.getElementById("deleteDeviceButton").addEventListener("click", () => deleteWorkspaceDevice().catch((error) => {
  setWorkspaceStatus(`\u5220\u9664\u8BBE\u5907\u5931\u8D25\uFF1A${error.message}`, "dirty");
  writeTerminal(`$ \u5220\u9664\u8BBE\u5907\u5931\u8D25
  ${error.message}`, true);
}));
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
document.getElementById("stepRunButton").addEventListener("click", runModelStepped);
document.getElementById("batchRunButton").addEventListener("click", runCurrentTestGroup);
document.getElementById("openParameterComparisonDialogButton").addEventListener("click", openParameterComparisonDialog);
document.getElementById("parameterComparisonDialogCancel").addEventListener("click", () => document.getElementById("parameterComparisonDialog").close());
document.getElementById("openScheduleAlphaGoOptionsDialogButton").addEventListener("click", openScheduleAlphaGoOptionsDialog);
document.getElementById("scheduleAlphaGoOptionsDialogCancel").addEventListener("click", () => document.getElementById("scheduleAlphaGoOptionsDialog").close());
document.getElementById("alphaGoCheckpointFile").addEventListener("change", (event) => {
  pendingAlphaGoCheckpointFile = event.currentTarget.files?.[0] || null;
  if (!pendingAlphaGoCheckpointFile) return;
  document.getElementById("alphaGoCheckpointPath").value = pendingAlphaGoCheckpointFile.name;
  document.getElementById("alphaGoCheckpointHint").textContent = `\u5DF2\u9009\u62E9\u201C${pendingAlphaGoCheckpointFile.name}\u201D\uFF1B\u4FDD\u5B58\u53C2\u6570\u65F6\u4E0A\u4F20\u3002`;
});
document.getElementById("clearAlphaGoCheckpointButton").addEventListener("click", () => {
  pendingAlphaGoCheckpointFile = null;
  document.getElementById("alphaGoCheckpointFile").value = "";
  document.getElementById("alphaGoCheckpointPath").value = "";
  document.getElementById("alphaGoCheckpointHint").textContent = "\u4FDD\u5B58\u540E\u5C06\u4F7F\u7528\u9ED8\u8BA4\u6A21\u578B\u6216\u51B7\u542F\u52A8\u6A21\u578B\u3002";
});
document.getElementById("scheduleAlphaGoOptionsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveScheduleAlphaGoOptions().catch((error) => {
    document.getElementById("alphaGoCheckpointHint").textContent = error.message || "\u53C2\u6570\u4FDD\u5B58\u5931\u8D25";
  });
});
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
document.getElementById("searchTelemetryDecisionSelect").addEventListener("change", (event) => {
  selectedSearchTelemetryId = String(event.currentTarget.value || "");
  followLatestSearchTelemetry = selectedSearchTelemetryId === String(latestSearchTelemetry?.searchId || "");
  if (latestSearchTelemetry) renderSearchTelemetry(latestSearchTelemetry);
});
document.getElementById("searchTelemetryPauseButton").addEventListener("click", () => {
  void controlSearchTelemetry("pause");
});
document.getElementById("searchTelemetryStepButton").addEventListener("click", () => {
  void controlSearchTelemetry("step");
});
document.getElementById("searchTelemetryContinueButton").addEventListener("click", () => {
  void controlSearchTelemetry("continue");
});
document.getElementById("searchTelemetryFollowRecommendationButton").addEventListener("click", followSearchRecommendation);
document.getElementById("searchTelemetryContinuousDecisionButton").addEventListener("click", toggleContinuousDecision);
document.getElementById("playbackModeReplayButton").addEventListener("click", () => {
  void setPlaybackMode("replay");
});
document.getElementById("playbackModeStepButton").addEventListener("click", () => {
  void setPlaybackMode("step");
});
document.getElementById("visualDecisionLens").addEventListener("click", (event) => {
  const candidate = event.target.closest?.("[data-action-key][role='button']");
  if (!candidate) return;
  void chooseSearchAction(candidate.dataset.actionKey);
});
document.getElementById("visualDecisionLens").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const candidate = event.target.closest?.("[data-action-key][role='button']");
  if (!candidate) return;
  event.preventDefault();
  void chooseSearchAction(candidate.dataset.actionKey);
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
    if (["name", "cleanType", "recipeTime", "wacRecipeTime", "jobType", "waferCount", "bufferOption", ...ROUTE_CLEAN_KEYS].includes(event.target.dataset.key) || event.target.dataset.timeIndex !== void 0 || event.target.dataset.roundTimeIndex !== void 0 || ["stage-candidates", "stage-candidate-toggle", "cjob", "pjob"].includes(event.target.dataset.scope)) renderAll();
    else if (state.drawer) {
      renderRoutes();
      renderStepDrawer();
    }
  }
  if (event.target.name === "strategy") {
    state.strategy = event.target.value;
    const algorithm = state.availableAlgorithms.find((item) => item.strategy === state.strategy);
    if (algorithm?.defaultOptions && typeof algorithm.defaultOptions === "object") {
      Object.assign(state.options, algorithm.defaultOptions);
    }
    retainSessionSchedulingConfiguration();
    document.getElementById("roundCount").disabled = false;
    updateStrategyOptionVisibility();
    showAlgorithmDetails(state.strategy);
    document.getElementById("stepRunButton").disabled = stepRunActive ? false : !state.serviceCompatible || state.strategy !== "schedule-alphago";
    markTestDirty();
    renderAll();
  }
});
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab-target]");
  if (tab) switchTab(tab.dataset.tabTarget);
  const robotSlotChoice = event.target.closest("[data-robot-slot-name][data-robot-arm-count]");
  if (robotSlotChoice && !robotSlotChoice.disabled) {
    setRobotArmCount(robotSlotChoice.dataset.robotSlotName, Number(robotSlotChoice.dataset.robotArmCount)).catch((error) => writeTerminal(`$ \u673A\u5668\u624B\u69FD\u4F4D\u4FDD\u5B58\u5931\u8D25
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
