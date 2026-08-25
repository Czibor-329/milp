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
  automaticTemplateName: () => automaticTemplateName,
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
function automaticTemplateName(profile) {
  if (profile.processCount === 0) return "\u65E0\u52A0\u5DE5\u5DE5\u5E8F";
  return profile.candidatePath.join(" \u2192 ");
}
function automaticRouteName(profile, cleanSignature = "", minimumResidency = null) {
  const processName = profile.processCount === 0 ? "\u65E0\u52A0\u5DE5\u5DE5\u5E8F" : profile.candidatePath.map(
    (path2, index) => `${path2}(${formatSeconds(profile.processTimes[index])})`
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
  const environments2 = /* @__PURE__ */ new Map();
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
      environments2.set(name, initialLoadLockEnvironment(device, name));
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
      if (environment) environments2.set(move.ModuleName, active ? `${environment}\u5207\u6362\u4E2D` : environment);
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
      environment: environments2.get(name) ?? "",
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
function loadLockEfficiencyFromMoves(moves, device) {
  const pendingByLoadLock = /* @__PURE__ */ new Map();
  let cycleCount = 0;
  let waferCycleCount = 0;
  let fullLoadCycleCount = 0;
  let emptyLoadCycleCount = 0;
  const stationType = (name) => String(device?.Stations?.[name]?.Type ?? "");
  const capacityOf = (name) => {
    const definition = device?.Stations?.[name] ?? {};
    const slots = listValue(definition.Slots).map((value) => finiteNumber(value, 0)).filter((value) => value > 0);
    return Math.max(1, 2, finiteNumber(definition.Capacity, 0), slots.length, ...slots);
  };
  const directionOf = (move) => {
    const lastState = String(move.LastState ?? "").toUpperCase();
    const currentState = String(move.CurState ?? "").toUpperCase();
    if (["ATM", "ATR"].includes(lastState) && ["VAC", "VTR"].includes(currentState)) return "vacuum";
    if (["VAC", "VTR"].includes(lastState) && ["ATM", "ATR"].includes(currentState)) return "vent";
    if (move.MoveType === PUMP_MOVE) return "vacuum";
    if (move.MoveType === VENT_MOVE) return "vent";
    return null;
  };
  for (const move of normalizeMoves(moves)) {
    const direction = directionOf(move);
    const loadLock = move.ModuleName;
    if (!direction || !isLoadLockName(loadLock, stationType(loadLock))) continue;
    if (direction === "vacuum") {
      pendingByLoadLock.set(loadLock, materialIds(move));
      continue;
    }
    const pumpedWafers = pendingByLoadLock.get(loadLock);
    if (!pumpedWafers) continue;
    pendingByLoadLock.delete(loadLock);
    const cycleLoad = Math.max(pumpedWafers.length, materialIds(move).length);
    cycleCount += 1;
    waferCycleCount += cycleLoad;
    if (cycleLoad === 0) emptyLoadCycleCount += 1;
    if (cycleLoad >= capacityOf(loadLock)) fullLoadCycleCount += 1;
  }
  return {
    cycleCount,
    waferCycleCount,
    wafersPerCycle: cycleCount ? waferCycleCount / cycleCount : 0,
    fullLoadCycleCount,
    emptyLoadCycleCount,
    fullLoadCycleRatio: cycleCount ? fullLoadCycleCount / cycleCount : 0,
    emptyLoadCycleRatio: cycleCount ? emptyLoadCycleCount / cycleCount : 0
  };
}
function withWaferResidenceTimes(performance2, moves, device) {
  const entries = /* @__PURE__ */ new Map();
  const completions = /* @__PURE__ */ new Map();
  const stationType = (name) => String(device?.Stations?.[name]?.Type ?? "");
  const chamberDwellByWafer = /* @__PURE__ */ new Map();
  const robotDwellByWafer = /* @__PURE__ */ new Map();
  const transportByRobot = /* @__PURE__ */ new Map();
  const holdingStartedAt = /* @__PURE__ */ new Map();
  const coveredDuration = (intervals, start, end) => {
    const clipped = intervals.map((interval) => ({ start: Math.max(interval.start, start), end: Math.min(interval.end, end) })).filter((interval) => interval.end > interval.start + PERFORMANCE_DISPLAY_TOLERANCE).sort((left, right) => left.start - right.start || left.end - right.end);
    let total = 0;
    let active = null;
    for (const interval of clipped) {
      if (!active) active = interval;
      else if (interval.start <= active.end + PERFORMANCE_DISPLAY_TOLERANCE) active.end = Math.max(active.end, interval.end);
      else {
        total += active.end - active.start;
        active = interval;
      }
    }
    return active ? total + active.end - active.start : total;
  };
  const records = normalizeMoves(moves);
  for (const move of records) {
    if (move.MoveType === PRE_TRANS_MOVE && move.EndTime > move.StartTime) {
      const robot = move.ModuleName;
      const intervals = transportByRobot.get(robot) ?? [];
      intervals.push({ start: move.StartTime, end: move.EndTime });
      transportByRobot.set(robot, intervals);
    }
  }
  for (const processMove of records) {
    const chamber = processMove.ModuleName;
    if (processMove.MoveType !== PROCESS_MOVE || !isProcessModule(chamber, stationType(chamber))) continue;
    for (const wafer of materialIds(processMove)) {
      const removal = records.find((candidate) => candidate.EndTime >= processMove.EndTime - PERFORMANCE_DISPLAY_TOLERANCE && (PICK_MOVE_TYPES.has(candidate.MoveType) && firstStation(candidate, "SrcStationList") === chamber && materialIds(candidate).includes(wafer) || candidate.MoveType === SWAP_MOVE && firstStation(candidate, "StationList") === chamber && materialIds(candidate, "SendMatList").includes(wafer)));
      if (removal) chamberDwellByWafer.set(wafer, (chamberDwellByWafer.get(wafer) ?? 0) + removal.EndTime - processMove.EndTime);
    }
  }
  const finishHolding = (robot, wafers, finishedAt) => {
    for (const wafer of wafers) {
      const key = `${robot}\0${wafer}`;
      const startedAt = holdingStartedAt.get(key);
      if (startedAt === void 0) continue;
      holdingStartedAt.delete(key);
      const dwell = Math.max(finishedAt - startedAt - coveredDuration(transportByRobot.get(robot) ?? [], startedAt, finishedAt), 0);
      robotDwellByWafer.set(wafer, (robotDwellByWafer.get(wafer) ?? 0) + dwell);
    }
  };
  for (const move of records) {
    const robot = move.ModuleName;
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      for (const wafer of materialIds(move)) holdingStartedAt.set(`${robot}\0${wafer}`, move.EndTime);
    } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
      finishHolding(robot, materialIds(move), move.StartTime);
    } else if (move.MoveType === SWAP_MOVE) {
      finishHolding(robot, materialIds(move, "SendMatList"), move.StartTime);
      for (const wafer of materialIds(move, "RecvMatList")) holdingStartedAt.set(`${robot}\0${wafer}`, move.EndTime);
    }
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
  const fallbackSamples = [];
  for (const [wafer, completedAt] of completions) {
    const enteredAt = entries.get(wafer);
    if (enteredAt === void 0 || completedAt < enteredAt - PERFORMANCE_DISPLAY_TOLERANCE) continue;
    fallbackSamples.push({
      wafer,
      enteredAt,
      completedAt,
      duration: completedAt - enteredAt,
      chamberDwellSeconds: chamberDwellByWafer.get(wafer) ?? 0,
      robotDwellSeconds: robotDwellByWafer.get(wafer) ?? 0
    });
  }
  fallbackSamples.sort((left, right) => left.completedAt - right.completedAt || naturalCompare(left.wafer, right.wafer));
  const fallbackByWafer = new Map(fallbackSamples.map((sample) => [sample.wafer, sample]));
  const samples = (performance2.waferSystemResidenceTimes?.length ? performance2.waferSystemResidenceTimes : fallbackSamples).map((sample) => ({
    ...sample,
    chamberDwellSeconds: sample.chamberDwellSeconds ?? fallbackByWafer.get(sample.wafer)?.chamberDwellSeconds ?? 0,
    robotDwellSeconds: sample.robotDwellSeconds ?? fallbackByWafer.get(sample.wafer)?.robotDwellSeconds ?? 0
  }));
  const hydrated = samples.length ? { ...performance2, waferSystemResidenceTimes: samples } : performance2;
  return hydrated.loadLockEfficiency ? hydrated : { ...hydrated, loadLockEfficiency: loadLockEfficiencyFromMoves(moves, device) };
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
    const duration = formatSeconds2(seconds);
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
          <div class="residence-metric-mean-line" style="bottom:${(26 + meanHeight).toFixed(2)}px"><span>\u5E73\u5747 ${formatSeconds2(meanSeconds)} s</span></div>
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
        <span>\u7CFB\u7EDF\u5E73\u5747 <b>${formatSeconds2(systemMeanSeconds)} s</b></span>
        <span>\u7CFB\u7EDF\u6700\u5927 <b>${formatSeconds2(maximumSeconds)} s</b></span>
        <span>\u6781\u5DEE/\u6700\u5C0F\u503C <b>${rangeToMinimumPercent === null ? "\u2014" : `${rangeToMinimumPercent.toFixed(1)}%`}</b></span>
        <span>\u6837\u672C <b>${samples.length} \u7247</b></span>`)}
      ${summary("chamber", `
        <span>\u8154\u5BA4\u5E73\u5747 <b>${formatSeconds2(chamberMeanSeconds)} s</b></span>
        <span>\u8154\u5BA4\u6700\u5927 <b>${formatSeconds2(Math.max(...chamberValues))} s</b></span>
        <span>\u8154\u5BA4\u7D2F\u8BA1 <b>${formatSeconds2(chamberValues.reduce((sum, value) => sum + value, 0))} s</b></span>
        <span>\u6837\u672C <b>${samples.length} \u7247</b></span>`)}
      ${summary("robot", `
        <span>\u673A\u5668\u624B\u5E73\u5747 <b>${formatSeconds2(robotMeanSeconds)} s</b></span>
        <span>\u673A\u5668\u624B\u6700\u5927 <b>${formatSeconds2(Math.max(...robotValues))} s</b></span>
        <span>\u673A\u5668\u624B\u7D2F\u8BA1 <b>${formatSeconds2(robotValues.reduce((sum, value) => sum + value, 0))} s</b></span>
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
  const window2 = performance2.window;
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
          <strong>${escapeHtml(window2.label)} \xB7 ${formatSeconds2(window2.duration)} s</strong>
          <small>\u5254\u9664\u5F00\u5934 ${formatSeconds2(window2.trimmedStart)} s / \u7ED3\u5C3E ${formatSeconds2(window2.trimmedEnd)} s</small>
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
        rounds: this.analysisRounds,
        cpuTimeMs: this.analysisResultId ? void 0 : this.cpuTimeMs,
        recomputeCount: this.analysisResultId ? void 0 : this.recomputeCount
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
function csvEscape(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function testGroupSummaryCsv(summary) {
  const headers = [
    "\u6D4B\u8BD5",
    "Makespan",
    "Baseline",
    "\u6539\u5584",
    "\u74F6\u9888",
    "\u5229\u7528\u7387",
    "CPU Time",
    "\u541E\u5410",
    "\u51FA\u7AD9 CV",
    "\u52A0\u5DE5\u8154\u9A7B\u7559\u5747\u503C",
    "\u673A\u5668\u624B\u9A7B\u7559\u5747\u503C",
    "\u7CFB\u7EDF\u505C\u7559\u5747\u503C",
    "\u7CFB\u7EDF\u505C\u7559 CV",
    "\u6821\u9A8C"
  ];
  const rows = summary.cases.map((item, index) => [
    caseLabel(item, index),
    finiteText(item.makespan, 2, " s"),
    finiteText(item.baselineMakespan, 2, " s"),
    item.improvementPercent === null ? "\u2014" : `${item.improvementPercent > 0 ? "+" : ""}${item.improvementPercent.toFixed(2)}%`,
    `${item.bottleneckResource || "\u2014"}${item.bottleneckCandidateCount > 1 ? ` +${item.bottleneckCandidateCount - 1} \u4E2A\u5019\u9009` : ""}`,
    percentText(item.bottleneckUtilization, true),
    durationText(item.cpuTimeMs),
    finiteText(item.throughputPerHour, 1, " \u7247/h"),
    finiteText(item.departureIntervalCv, 2),
    finiteText(item.processChamberDwellMeanSeconds, 2, " s"),
    finiteText(item.robotWaferDwellMeanSeconds, 2, " s"),
    finiteText(item.waferSystemResidenceMeanSeconds, 2, " s"),
    finiteText(item.waferSystemResidenceCv, 2),
    item.validationPassed ? "\u901A\u8FC7" : item.validation || item.status || "\u2014"
  ].map(csvEscape));
  return [headers.map(csvEscape).join(","), ...rows.map((row) => row.join(","))].join("\r\n");
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
      <summary><span>\u67E5\u770B\u9010\u6D4B\u8BD5\u5B8C\u6574\u6307\u6807</span><button type="button" class="btn small group-analysis-export" data-group-export-csv>\u5BFC\u51FA CSV</button></summary>
      <div class="group-analysis-table-scroll">
        <table class="group-analysis-table">
          <thead><tr><th>\u6D4B\u8BD5</th><th>Makespan</th><th>Baseline</th><th>\u6539\u5584</th><th>\u74F6\u9888</th><th>\u5229\u7528\u7387</th><th>CPU Time</th><th>\u541E\u5410</th><th>\u51FA\u7AD9 CV</th><th>\u52A0\u5DE5\u8154\u9A7B\u7559\u5747\u503C</th><th>\u673A\u5668\u624B\u9A7B\u7559\u5747\u503C</th><th>\u7CFB\u7EDF\u505C\u7559\u5747\u503C</th><th>\u7CFB\u7EDF\u505C\u7559 CV</th><th>\u6821\u9A8C</th></tr></thead>
          <tbody>${resultTable(summary)}</tbody>
        </table>
      </div>
    </details>`;
}

// node_modules/katex/dist/katex.mjs
var SourceLocation = class _SourceLocation {
  // The + prefix indicates that these fields aren't writeable
  // Lexer holding the input string.
  // Start offset, zero-based inclusive.
  // End offset, zero-based exclusive.
  constructor(lexer, start, end) {
    this.lexer = void 0;
    this.start = void 0;
    this.end = void 0;
    this.lexer = lexer;
    this.start = start;
    this.end = end;
  }
  /**
   * Merges two `SourceLocation`s from location providers, given they are
   * provided in order of appearance.
   * - Returns the first one's location if only the first is provided.
   * - Returns a merged range of the first and the last if both are provided
   *   and their lexers match.
   * - Otherwise, returns null.
   */
  static range(first, second) {
    if (!second) {
      return first && first.loc;
    } else if (!first || !first.loc || !second.loc || first.loc.lexer !== second.loc.lexer) {
      return null;
    } else {
      return new _SourceLocation(first.loc.lexer, first.loc.start, second.loc.end);
    }
  }
};
var Token = class _Token {
  // don't expand the token
  // used in \noexpand
  constructor(text2, loc) {
    this.text = void 0;
    this.loc = void 0;
    this.noexpand = void 0;
    this.treatAsRelax = void 0;
    this.text = text2;
    this.loc = loc;
  }
  /**
   * Given a pair of tokens (this and endToken), compute a `Token` encompassing
   * the whole input range enclosed by these two.
   */
  range(endToken, text2) {
    return new _Token(text2, SourceLocation.range(this, endToken));
  }
};
var ParseError = class _ParseError {
  // Error start position based on passed-in Token or ParseNode.
  // Length of affected text based on passed-in Token or ParseNode.
  // The underlying error message without any context added.
  constructor(message, token) {
    this.name = void 0;
    this.position = void 0;
    this.length = void 0;
    this.rawMessage = void 0;
    var error = "KaTeX parse error: " + message;
    var start;
    var end;
    var loc = token && token.loc;
    if (loc && loc.start <= loc.end) {
      var input = loc.lexer.input;
      start = loc.start;
      end = loc.end;
      if (start === input.length) {
        error += " at end of input: ";
      } else {
        error += " at position " + (start + 1) + ": ";
      }
      var underlined = input.slice(start, end).replace(/[^]/g, "$&\u0332");
      var left;
      if (start > 15) {
        left = "\u2026" + input.slice(start - 15, start);
      } else {
        left = input.slice(0, start);
      }
      var right;
      if (end + 15 < input.length) {
        right = input.slice(end, end + 15) + "\u2026";
      } else {
        right = input.slice(end);
      }
      error += left + underlined + right;
    }
    var self = new Error(error);
    self.name = "ParseError";
    self.__proto__ = _ParseError.prototype;
    self.position = start;
    if (start != null && end != null) {
      self.length = end - start;
    }
    self.rawMessage = message;
    return self;
  }
};
ParseError.prototype.__proto__ = Error.prototype;
var contains = function contains2(list, elem) {
  return list.indexOf(elem) !== -1;
};
var deflt = function deflt2(setting, defaultIfUndefined) {
  return setting === void 0 ? defaultIfUndefined : setting;
};
var uppercase = /([A-Z])/g;
var hyphenate = function hyphenate2(str) {
  return str.replace(uppercase, "-$1").toLowerCase();
};
var ESCAPE_LOOKUP = {
  "&": "&amp;",
  ">": "&gt;",
  "<": "&lt;",
  '"': "&quot;",
  "'": "&#x27;"
};
var ESCAPE_REGEX = /[&><"']/g;
function escape(text2) {
  return String(text2).replace(ESCAPE_REGEX, (match) => ESCAPE_LOOKUP[match]);
}
var getBaseElem = function getBaseElem2(group) {
  if (group.type === "ordgroup") {
    if (group.body.length === 1) {
      return getBaseElem2(group.body[0]);
    } else {
      return group;
    }
  } else if (group.type === "color") {
    if (group.body.length === 1) {
      return getBaseElem2(group.body[0]);
    } else {
      return group;
    }
  } else if (group.type === "font") {
    return getBaseElem2(group.body);
  } else {
    return group;
  }
};
var isCharacterBox = function isCharacterBox2(group) {
  var baseElem = getBaseElem(group);
  return baseElem.type === "mathord" || baseElem.type === "textord" || baseElem.type === "atom";
};
var assert = function assert2(value) {
  if (!value) {
    throw new Error("Expected non-null, but got " + String(value));
  }
  return value;
};
var protocolFromUrl = function protocolFromUrl2(url) {
  var protocol = /^[\x00-\x20]*([^\\/#?]*?)(:|&#0*58|&#x0*3a|&colon)/i.exec(url);
  if (!protocol) {
    return "_relative";
  }
  if (protocol[2] !== ":") {
    return null;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*$/.test(protocol[1])) {
    return null;
  }
  return protocol[1].toLowerCase();
};
var utils = {
  contains,
  deflt,
  escape,
  hyphenate,
  getBaseElem,
  isCharacterBox,
  protocolFromUrl
};
var SETTINGS_SCHEMA = {
  displayMode: {
    type: "boolean",
    description: "Render math in display mode, which puts the math in display style (so \\int and \\sum are large, for example), and centers the math on the page on its own line.",
    cli: "-d, --display-mode"
  },
  output: {
    type: {
      enum: ["htmlAndMathml", "html", "mathml"]
    },
    description: "Determines the markup language of the output.",
    cli: "-F, --format <type>"
  },
  leqno: {
    type: "boolean",
    description: "Render display math in leqno style (left-justified tags)."
  },
  fleqn: {
    type: "boolean",
    description: "Render display math flush left."
  },
  throwOnError: {
    type: "boolean",
    default: true,
    cli: "-t, --no-throw-on-error",
    cliDescription: "Render errors (in the color given by --error-color) instead of throwing a ParseError exception when encountering an error."
  },
  errorColor: {
    type: "string",
    default: "#cc0000",
    cli: "-c, --error-color <color>",
    cliDescription: "A color string given in the format 'rgb' or 'rrggbb' (no #). This option determines the color of errors rendered by the -t option.",
    cliProcessor: (color) => "#" + color
  },
  macros: {
    type: "object",
    cli: "-m, --macro <def>",
    cliDescription: "Define custom macro of the form '\\foo:expansion' (use multiple -m arguments for multiple macros).",
    cliDefault: [],
    cliProcessor: (def, defs) => {
      defs.push(def);
      return defs;
    }
  },
  minRuleThickness: {
    type: "number",
    description: "Specifies a minimum thickness, in ems, for fraction lines, `\\sqrt` top lines, `{array}` vertical lines, `\\hline`, `\\hdashline`, `\\underline`, `\\overline`, and the borders of `\\fbox`, `\\boxed`, and `\\fcolorbox`.",
    processor: (t) => Math.max(0, t),
    cli: "--min-rule-thickness <size>",
    cliProcessor: parseFloat
  },
  colorIsTextColor: {
    type: "boolean",
    description: "Makes \\color behave like LaTeX's 2-argument \\textcolor, instead of LaTeX's one-argument \\color mode change.",
    cli: "-b, --color-is-text-color"
  },
  strict: {
    type: [{
      enum: ["warn", "ignore", "error"]
    }, "boolean", "function"],
    description: "Turn on strict / LaTeX faithfulness mode, which throws an error if the input uses features that are not supported by LaTeX.",
    cli: "-S, --strict",
    cliDefault: false
  },
  trust: {
    type: ["boolean", "function"],
    description: "Trust the input, enabling all HTML features such as \\url.",
    cli: "-T, --trust"
  },
  maxSize: {
    type: "number",
    default: Infinity,
    description: "If non-zero, all user-specified sizes, e.g. in \\rule{500em}{500em}, will be capped to maxSize ems. Otherwise, elements and spaces can be arbitrarily large",
    processor: (s) => Math.max(0, s),
    cli: "-s, --max-size <n>",
    cliProcessor: parseInt
  },
  maxExpand: {
    type: "number",
    default: 1e3,
    description: "Limit the number of macro expansions to the specified number, to prevent e.g. infinite macro loops. If set to Infinity, the macro expander will try to fully expand as in LaTeX.",
    processor: (n) => Math.max(0, n),
    cli: "-e, --max-expand <n>",
    cliProcessor: (n) => n === "Infinity" ? Infinity : parseInt(n)
  },
  globalGroup: {
    type: "boolean",
    cli: false
  }
};
function getDefaultValue(schema) {
  if (schema.default) {
    return schema.default;
  }
  var type = schema.type;
  var defaultType = Array.isArray(type) ? type[0] : type;
  if (typeof defaultType !== "string") {
    return defaultType.enum[0];
  }
  switch (defaultType) {
    case "boolean":
      return false;
    case "string":
      return "";
    case "number":
      return 0;
    case "object":
      return {};
  }
}
var Settings = class {
  constructor(options) {
    this.displayMode = void 0;
    this.output = void 0;
    this.leqno = void 0;
    this.fleqn = void 0;
    this.throwOnError = void 0;
    this.errorColor = void 0;
    this.macros = void 0;
    this.minRuleThickness = void 0;
    this.colorIsTextColor = void 0;
    this.strict = void 0;
    this.trust = void 0;
    this.maxSize = void 0;
    this.maxExpand = void 0;
    this.globalGroup = void 0;
    options = options || {};
    for (var prop in SETTINGS_SCHEMA) {
      if (SETTINGS_SCHEMA.hasOwnProperty(prop)) {
        var schema = SETTINGS_SCHEMA[prop];
        this[prop] = options[prop] !== void 0 ? schema.processor ? schema.processor(options[prop]) : options[prop] : getDefaultValue(schema);
      }
    }
  }
  /**
   * Report nonstrict (non-LaTeX-compatible) input.
   * Can safely not be called if `this.strict` is false in JavaScript.
   */
  reportNonstrict(errorCode, errorMsg, token) {
    var strict = this.strict;
    if (typeof strict === "function") {
      strict = strict(errorCode, errorMsg, token);
    }
    if (!strict || strict === "ignore") {
      return;
    } else if (strict === true || strict === "error") {
      throw new ParseError("LaTeX-incompatible input and strict mode is set to 'error': " + (errorMsg + " [" + errorCode + "]"), token);
    } else if (strict === "warn") {
      typeof console !== "undefined" && console.warn("LaTeX-incompatible input and strict mode is set to 'warn': " + (errorMsg + " [" + errorCode + "]"));
    } else {
      typeof console !== "undefined" && console.warn("LaTeX-incompatible input and strict mode is set to " + ("unrecognized '" + strict + "': " + errorMsg + " [" + errorCode + "]"));
    }
  }
  /**
   * Check whether to apply strict (LaTeX-adhering) behavior for unusual
   * input (like `\\`).  Unlike `nonstrict`, will not throw an error;
   * instead, "error" translates to a return value of `true`, while "ignore"
   * translates to a return value of `false`.  May still print a warning:
   * "warn" prints a warning and returns `false`.
   * This is for the second category of `errorCode`s listed in the README.
   */
  useStrictBehavior(errorCode, errorMsg, token) {
    var strict = this.strict;
    if (typeof strict === "function") {
      try {
        strict = strict(errorCode, errorMsg, token);
      } catch (error) {
        strict = "error";
      }
    }
    if (!strict || strict === "ignore") {
      return false;
    } else if (strict === true || strict === "error") {
      return true;
    } else if (strict === "warn") {
      typeof console !== "undefined" && console.warn("LaTeX-incompatible input and strict mode is set to 'warn': " + (errorMsg + " [" + errorCode + "]"));
      return false;
    } else {
      typeof console !== "undefined" && console.warn("LaTeX-incompatible input and strict mode is set to " + ("unrecognized '" + strict + "': " + errorMsg + " [" + errorCode + "]"));
      return false;
    }
  }
  /**
   * Check whether to test potentially dangerous input, and return
   * `true` (trusted) or `false` (untrusted).  The sole argument `context`
   * should be an object with `command` field specifying the relevant LaTeX
   * command (as a string starting with `\`), and any other arguments, etc.
   * If `context` has a `url` field, a `protocol` field will automatically
   * get added by this function (changing the specified object).
   */
  isTrusted(context) {
    if (context.url && !context.protocol) {
      var protocol = utils.protocolFromUrl(context.url);
      if (protocol == null) {
        return false;
      }
      context.protocol = protocol;
    }
    var trust = typeof this.trust === "function" ? this.trust(context) : this.trust;
    return Boolean(trust);
  }
};
var Style = class {
  constructor(id, size, cramped) {
    this.id = void 0;
    this.size = void 0;
    this.cramped = void 0;
    this.id = id;
    this.size = size;
    this.cramped = cramped;
  }
  /**
   * Get the style of a superscript given a base in the current style.
   */
  sup() {
    return styles[sup[this.id]];
  }
  /**
   * Get the style of a subscript given a base in the current style.
   */
  sub() {
    return styles[sub[this.id]];
  }
  /**
   * Get the style of a fraction numerator given the fraction in the current
   * style.
   */
  fracNum() {
    return styles[fracNum[this.id]];
  }
  /**
   * Get the style of a fraction denominator given the fraction in the current
   * style.
   */
  fracDen() {
    return styles[fracDen[this.id]];
  }
  /**
   * Get the cramped version of a style (in particular, cramping a cramped style
   * doesn't change the style).
   */
  cramp() {
    return styles[cramp[this.id]];
  }
  /**
   * Get a text or display version of this style.
   */
  text() {
    return styles[text$1[this.id]];
  }
  /**
   * Return true if this style is tightly spaced (scriptstyle/scriptscriptstyle)
   */
  isTight() {
    return this.size >= 2;
  }
};
var D = 0;
var Dc = 1;
var T = 2;
var Tc = 3;
var S = 4;
var Sc = 5;
var SS = 6;
var SSc = 7;
var styles = [new Style(D, 0, false), new Style(Dc, 0, true), new Style(T, 1, false), new Style(Tc, 1, true), new Style(S, 2, false), new Style(Sc, 2, true), new Style(SS, 3, false), new Style(SSc, 3, true)];
var sup = [S, Sc, S, Sc, SS, SSc, SS, SSc];
var sub = [Sc, Sc, Sc, Sc, SSc, SSc, SSc, SSc];
var fracNum = [T, Tc, S, Sc, SS, SSc, SS, SSc];
var fracDen = [Tc, Tc, Sc, Sc, SSc, SSc, SSc, SSc];
var cramp = [Dc, Dc, Tc, Tc, Sc, Sc, SSc, SSc];
var text$1 = [D, Dc, T, Tc, T, Tc, T, Tc];
var Style$1 = {
  DISPLAY: styles[D],
  TEXT: styles[T],
  SCRIPT: styles[S],
  SCRIPTSCRIPT: styles[SS]
};
var scriptData = [{
  // Latin characters beyond the Latin-1 characters we have metrics for.
  // Needed for Czech, Hungarian and Turkish text, for example.
  name: "latin",
  blocks: [
    [256, 591],
    // Latin Extended-A and Latin Extended-B
    [768, 879]
    // Combining Diacritical marks
  ]
}, {
  // The Cyrillic script used by Russian and related languages.
  // A Cyrillic subset used to be supported as explicitly defined
  // symbols in symbols.js
  name: "cyrillic",
  blocks: [[1024, 1279]]
}, {
  // Armenian
  name: "armenian",
  blocks: [[1328, 1423]]
}, {
  // The Brahmic scripts of South and Southeast Asia
  // Devanagari (0900–097F)
  // Bengali (0980–09FF)
  // Gurmukhi (0A00–0A7F)
  // Gujarati (0A80–0AFF)
  // Oriya (0B00–0B7F)
  // Tamil (0B80–0BFF)
  // Telugu (0C00–0C7F)
  // Kannada (0C80–0CFF)
  // Malayalam (0D00–0D7F)
  // Sinhala (0D80–0DFF)
  // Thai (0E00–0E7F)
  // Lao (0E80–0EFF)
  // Tibetan (0F00–0FFF)
  // Myanmar (1000–109F)
  name: "brahmic",
  blocks: [[2304, 4255]]
}, {
  name: "georgian",
  blocks: [[4256, 4351]]
}, {
  // Chinese and Japanese.
  // The "k" in cjk is for Korean, but we've separated Korean out
  name: "cjk",
  blocks: [
    [12288, 12543],
    // CJK symbols and punctuation, Hiragana, Katakana
    [19968, 40879],
    // CJK ideograms
    [65280, 65376]
    // Fullwidth punctuation
    // TODO: add halfwidth Katakana and Romanji glyphs
  ]
}, {
  // Korean
  name: "hangul",
  blocks: [[44032, 55215]]
}];
function scriptFromCodepoint(codepoint) {
  for (var i2 = 0; i2 < scriptData.length; i2++) {
    var script = scriptData[i2];
    for (var _i6 = 0; _i6 < script.blocks.length; _i6++) {
      var block = script.blocks[_i6];
      if (codepoint >= block[0] && codepoint <= block[1]) {
        return script.name;
      }
    }
  }
  return null;
}
var allBlocks = [];
scriptData.forEach((s) => s.blocks.forEach((b) => allBlocks.push(...b)));
function supportedCodepoint(codepoint) {
  for (var i2 = 0; i2 < allBlocks.length; i2 += 2) {
    if (codepoint >= allBlocks[i2] && codepoint <= allBlocks[i2 + 1]) {
      return true;
    }
  }
  return false;
}
var hLinePad = 80;
var sqrtMain = function sqrtMain2(extraVinculum, hLinePad2) {
  return "M95," + (622 + extraVinculum + hLinePad2) + "\nc-2.7,0,-7.17,-2.7,-13.5,-8c-5.8,-5.3,-9.5,-10,-9.5,-14\nc0,-2,0.3,-3.3,1,-4c1.3,-2.7,23.83,-20.7,67.5,-54\nc44.2,-33.3,65.8,-50.3,66.5,-51c1.3,-1.3,3,-2,5,-2c4.7,0,8.7,3.3,12,10\ns173,378,173,378c0.7,0,35.3,-71,104,-213c68.7,-142,137.5,-285,206.5,-429\nc69,-144,104.5,-217.7,106.5,-221\nl" + extraVinculum / 2.075 + " -" + extraVinculum + "\nc5.3,-9.3,12,-14,20,-14\nH400000v" + (40 + extraVinculum) + "H845.2724\ns-225.272,467,-225.272,467s-235,486,-235,486c-2.7,4.7,-9,7,-19,7\nc-6,0,-10,-1,-12,-3s-194,-422,-194,-422s-65,47,-65,47z\nM" + (834 + extraVinculum) + " " + hLinePad2 + "h400000v" + (40 + extraVinculum) + "h-400000z";
};
var sqrtSize1 = function sqrtSize12(extraVinculum, hLinePad2) {
  return "M263," + (601 + extraVinculum + hLinePad2) + "c0.7,0,18,39.7,52,119\nc34,79.3,68.167,158.7,102.5,238c34.3,79.3,51.8,119.3,52.5,120\nc340,-704.7,510.7,-1060.3,512,-1067\nl" + extraVinculum / 2.084 + " -" + extraVinculum + "\nc4.7,-7.3,11,-11,19,-11\nH40000v" + (40 + extraVinculum) + "H1012.3\ns-271.3,567,-271.3,567c-38.7,80.7,-84,175,-136,283c-52,108,-89.167,185.3,-111.5,232\nc-22.3,46.7,-33.8,70.3,-34.5,71c-4.7,4.7,-12.3,7,-23,7s-12,-1,-12,-1\ns-109,-253,-109,-253c-72.7,-168,-109.3,-252,-110,-252c-10.7,8,-22,16.7,-34,26\nc-22,17.3,-33.3,26,-34,26s-26,-26,-26,-26s76,-59,76,-59s76,-60,76,-60z\nM" + (1001 + extraVinculum) + " " + hLinePad2 + "h400000v" + (40 + extraVinculum) + "h-400000z";
};
var sqrtSize2 = function sqrtSize22(extraVinculum, hLinePad2) {
  return "M983 " + (10 + extraVinculum + hLinePad2) + "\nl" + extraVinculum / 3.13 + " -" + extraVinculum + "\nc4,-6.7,10,-10,18,-10 H400000v" + (40 + extraVinculum) + "\nH1013.1s-83.4,268,-264.1,840c-180.7,572,-277,876.3,-289,913c-4.7,4.7,-12.7,7,-24,7\ns-12,0,-12,0c-1.3,-3.3,-3.7,-11.7,-7,-25c-35.3,-125.3,-106.7,-373.3,-214,-744\nc-10,12,-21,25,-33,39s-32,39,-32,39c-6,-5.3,-15,-14,-27,-26s25,-30,25,-30\nc26.7,-32.7,52,-63,76,-91s52,-60,52,-60s208,722,208,722\nc56,-175.3,126.3,-397.3,211,-666c84.7,-268.7,153.8,-488.2,207.5,-658.5\nc53.7,-170.3,84.5,-266.8,92.5,-289.5z\nM" + (1001 + extraVinculum) + " " + hLinePad2 + "h400000v" + (40 + extraVinculum) + "h-400000z";
};
var sqrtSize3 = function sqrtSize32(extraVinculum, hLinePad2) {
  return "M424," + (2398 + extraVinculum + hLinePad2) + "\nc-1.3,-0.7,-38.5,-172,-111.5,-514c-73,-342,-109.8,-513.3,-110.5,-514\nc0,-2,-10.7,14.3,-32,49c-4.7,7.3,-9.8,15.7,-15.5,25c-5.7,9.3,-9.8,16,-12.5,20\ns-5,7,-5,7c-4,-3.3,-8.3,-7.7,-13,-13s-13,-13,-13,-13s76,-122,76,-122s77,-121,77,-121\ns209,968,209,968c0,-2,84.7,-361.7,254,-1079c169.3,-717.3,254.7,-1077.7,256,-1081\nl" + extraVinculum / 4.223 + " -" + extraVinculum + "c4,-6.7,10,-10,18,-10 H400000\nv" + (40 + extraVinculum) + "H1014.6\ns-87.3,378.7,-272.6,1166c-185.3,787.3,-279.3,1182.3,-282,1185\nc-2,6,-10,9,-24,9\nc-8,0,-12,-0.7,-12,-2z M" + (1001 + extraVinculum) + " " + hLinePad2 + "\nh400000v" + (40 + extraVinculum) + "h-400000z";
};
var sqrtSize4 = function sqrtSize42(extraVinculum, hLinePad2) {
  return "M473," + (2713 + extraVinculum + hLinePad2) + "\nc339.3,-1799.3,509.3,-2700,510,-2702 l" + extraVinculum / 5.298 + " -" + extraVinculum + "\nc3.3,-7.3,9.3,-11,18,-11 H400000v" + (40 + extraVinculum) + "H1017.7\ns-90.5,478,-276.2,1466c-185.7,988,-279.5,1483,-281.5,1485c-2,6,-10,9,-24,9\nc-8,0,-12,-0.7,-12,-2c0,-1.3,-5.3,-32,-16,-92c-50.7,-293.3,-119.7,-693.3,-207,-1200\nc0,-1.3,-5.3,8.7,-16,30c-10.7,21.3,-21.3,42.7,-32,64s-16,33,-16,33s-26,-26,-26,-26\ns76,-153,76,-153s77,-151,77,-151c0.7,0.7,35.7,202,105,604c67.3,400.7,102,602.7,104,\n606zM" + (1001 + extraVinculum) + " " + hLinePad2 + "h400000v" + (40 + extraVinculum) + "H1017.7z";
};
var phasePath = function phasePath2(y) {
  var x = y / 2;
  return "M400000 " + y + " H0 L" + x + " 0 l65 45 L145 " + (y - 80) + " H400000z";
};
var sqrtTall = function sqrtTall2(extraVinculum, hLinePad2, viewBoxHeight) {
  var vertSegment = viewBoxHeight - 54 - hLinePad2 - extraVinculum;
  return "M702 " + (extraVinculum + hLinePad2) + "H400000" + (40 + extraVinculum) + "\nH742v" + vertSegment + "l-4 4-4 4c-.667.7 -2 1.5-4 2.5s-4.167 1.833-6.5 2.5-5.5 1-9.5 1\nh-12l-28-84c-16.667-52-96.667 -294.333-240-727l-212 -643 -85 170\nc-4-3.333-8.333-7.667-13 -13l-13-13l77-155 77-156c66 199.333 139 419.667\n219 661 l218 661zM702 " + hLinePad2 + "H400000v" + (40 + extraVinculum) + "H742z";
};
var sqrtPath = function sqrtPath2(size, extraVinculum, viewBoxHeight) {
  extraVinculum = 1e3 * extraVinculum;
  var path2 = "";
  switch (size) {
    case "sqrtMain":
      path2 = sqrtMain(extraVinculum, hLinePad);
      break;
    case "sqrtSize1":
      path2 = sqrtSize1(extraVinculum, hLinePad);
      break;
    case "sqrtSize2":
      path2 = sqrtSize2(extraVinculum, hLinePad);
      break;
    case "sqrtSize3":
      path2 = sqrtSize3(extraVinculum, hLinePad);
      break;
    case "sqrtSize4":
      path2 = sqrtSize4(extraVinculum, hLinePad);
      break;
    case "sqrtTall":
      path2 = sqrtTall(extraVinculum, hLinePad, viewBoxHeight);
  }
  return path2;
};
var innerPath = function innerPath2(name, height) {
  switch (name) {
    case "\u239C":
      return "M291 0 H417 V" + height + " H291z M291 0 H417 V" + height + " H291z";
    case "\u2223":
      return "M145 0 H188 V" + height + " H145z M145 0 H188 V" + height + " H145z";
    case "\u2225":
      return "M145 0 H188 V" + height + " H145z M145 0 H188 V" + height + " H145z" + ("M367 0 H410 V" + height + " H367z M367 0 H410 V" + height + " H367z");
    case "\u239F":
      return "M457 0 H583 V" + height + " H457z M457 0 H583 V" + height + " H457z";
    case "\u23A2":
      return "M319 0 H403 V" + height + " H319z M319 0 H403 V" + height + " H319z";
    case "\u23A5":
      return "M263 0 H347 V" + height + " H263z M263 0 H347 V" + height + " H263z";
    case "\u23AA":
      return "M384 0 H504 V" + height + " H384z M384 0 H504 V" + height + " H384z";
    case "\u23D0":
      return "M312 0 H355 V" + height + " H312z M312 0 H355 V" + height + " H312z";
    case "\u2016":
      return "M257 0 H300 V" + height + " H257z M257 0 H300 V" + height + " H257z" + ("M478 0 H521 V" + height + " H478z M478 0 H521 V" + height + " H478z");
    default:
      return "";
  }
};
var path = {
  // The doubleleftarrow geometry is from glyph U+21D0 in the font KaTeX Main
  doubleleftarrow: "M262 157\nl10-10c34-36 62.7-77 86-123 3.3-8 5-13.3 5-16 0-5.3-6.7-8-20-8-7.3\n 0-12.2.5-14.5 1.5-2.3 1-4.8 4.5-7.5 10.5-49.3 97.3-121.7 169.3-217 216-28\n 14-57.3 25-88 33-6.7 2-11 3.8-13 5.5-2 1.7-3 4.2-3 7.5s1 5.8 3 7.5\nc2 1.7 6.3 3.5 13 5.5 68 17.3 128.2 47.8 180.5 91.5 52.3 43.7 93.8 96.2 124.5\n 157.5 9.3 8 15.3 12.3 18 13h6c12-.7 18-4 18-10 0-2-1.7-7-5-15-23.3-46-52-87\n-86-123l-10-10h399738v-40H218c328 0 0 0 0 0l-10-8c-26.7-20-65.7-43-117-69 2.7\n-2 6-3.7 10-5 36.7-16 72.3-37.3 107-64l10-8h399782v-40z\nm8 0v40h399730v-40zm0 194v40h399730v-40z",
  // doublerightarrow is from glyph U+21D2 in font KaTeX Main
  doublerightarrow: "M399738 392l\n-10 10c-34 36-62.7 77-86 123-3.3 8-5 13.3-5 16 0 5.3 6.7 8 20 8 7.3 0 12.2-.5\n 14.5-1.5 2.3-1 4.8-4.5 7.5-10.5 49.3-97.3 121.7-169.3 217-216 28-14 57.3-25 88\n-33 6.7-2 11-3.8 13-5.5 2-1.7 3-4.2 3-7.5s-1-5.8-3-7.5c-2-1.7-6.3-3.5-13-5.5-68\n-17.3-128.2-47.8-180.5-91.5-52.3-43.7-93.8-96.2-124.5-157.5-9.3-8-15.3-12.3-18\n-13h-6c-12 .7-18 4-18 10 0 2 1.7 7 5 15 23.3 46 52 87 86 123l10 10H0v40h399782\nc-328 0 0 0 0 0l10 8c26.7 20 65.7 43 117 69-2.7 2-6 3.7-10 5-36.7 16-72.3 37.3\n-107 64l-10 8H0v40zM0 157v40h399730v-40zm0 194v40h399730v-40z",
  // leftarrow is from glyph U+2190 in font KaTeX Main
  leftarrow: "M400000 241H110l3-3c68.7-52.7 113.7-120\n 135-202 4-14.7 6-23 6-25 0-7.3-7-11-21-11-8 0-13.2.8-15.5 2.5-2.3 1.7-4.2 5.8\n-5.5 12.5-1.3 4.7-2.7 10.3-4 17-12 48.7-34.8 92-68.5 130S65.3 228.3 18 247\nc-10 4-16 7.7-18 11 0 8.7 6 14.3 18 17 47.3 18.7 87.8 47 121.5 85S196 441.3 208\n 490c.7 2 1.3 5 2 9s1.2 6.7 1.5 8c.3 1.3 1 3.3 2 6s2.2 4.5 3.5 5.5c1.3 1 3.3\n 1.8 6 2.5s6 1 10 1c14 0 21-3.7 21-11 0-2-2-10.3-6-25-20-79.3-65-146.7-135-202\n l-3-3h399890zM100 241v40h399900v-40z",
  // overbrace is from glyphs U+23A9/23A8/23A7 in font KaTeX_Size4-Regular
  leftbrace: "M6 548l-6-6v-35l6-11c56-104 135.3-181.3 238-232 57.3-28.7 117\n-45 179-50h399577v120H403c-43.3 7-81 15-113 26-100.7 33-179.7 91-237 174-2.7\n 5-6 9-10 13-.7 1-7.3 1-20 1H6z",
  leftbraceunder: "M0 6l6-6h17c12.688 0 19.313.3 20 1 4 4 7.313 8.3 10 13\n 35.313 51.3 80.813 93.8 136.5 127.5 55.688 33.7 117.188 55.8 184.5 66.5.688\n 0 2 .3 4 1 18.688 2.7 76 4.3 172 5h399450v120H429l-6-1c-124.688-8-235-61.7\n-331-161C60.687 138.7 32.312 99.3 7 54L0 41V6z",
  // overgroup is from the MnSymbol package (public domain)
  leftgroup: "M400000 80\nH435C64 80 168.3 229.4 21 260c-5.9 1.2-18 0-18 0-2 0-3-1-3-3v-38C76 61 257 0\n 435 0h399565z",
  leftgroupunder: "M400000 262\nH435C64 262 168.3 112.6 21 82c-5.9-1.2-18 0-18 0-2 0-3 1-3 3v38c76 158 257 219\n 435 219h399565z",
  // Harpoons are from glyph U+21BD in font KaTeX Main
  leftharpoon: "M0 267c.7 5.3 3 10 7 14h399993v-40H93c3.3\n-3.3 10.2-9.5 20.5-18.5s17.8-15.8 22.5-20.5c50.7-52 88-110.3 112-175 4-11.3 5\n-18.3 3-21-1.3-4-7.3-6-18-6-8 0-13 .7-15 2s-4.7 6.7-8 16c-42 98.7-107.3 174.7\n-196 228-6.7 4.7-10.7 8-12 10-1.3 2-2 5.7-2 11zm100-26v40h399900v-40z",
  leftharpoonplus: "M0 267c.7 5.3 3 10 7 14h399993v-40H93c3.3-3.3 10.2-9.5\n 20.5-18.5s17.8-15.8 22.5-20.5c50.7-52 88-110.3 112-175 4-11.3 5-18.3 3-21-1.3\n-4-7.3-6-18-6-8 0-13 .7-15 2s-4.7 6.7-8 16c-42 98.7-107.3 174.7-196 228-6.7 4.7\n-10.7 8-12 10-1.3 2-2 5.7-2 11zm100-26v40h399900v-40zM0 435v40h400000v-40z\nm0 0v40h400000v-40z",
  leftharpoondown: "M7 241c-4 4-6.333 8.667-7 14 0 5.333.667 9 2 11s5.333\n 5.333 12 10c90.667 54 156 130 196 228 3.333 10.667 6.333 16.333 9 17 2 .667 5\n 1 9 1h5c10.667 0 16.667-2 18-6 2-2.667 1-9.667-3-21-32-87.333-82.667-157.667\n-152-211l-3-3h399907v-40zM93 281 H400000 v-40L7 241z",
  leftharpoondownplus: "M7 435c-4 4-6.3 8.7-7 14 0 5.3.7 9 2 11s5.3 5.3 12\n 10c90.7 54 156 130 196 228 3.3 10.7 6.3 16.3 9 17 2 .7 5 1 9 1h5c10.7 0 16.7\n-2 18-6 2-2.7 1-9.7-3-21-32-87.3-82.7-157.7-152-211l-3-3h399907v-40H7zm93 0\nv40h399900v-40zM0 241v40h399900v-40zm0 0v40h399900v-40z",
  // hook is from glyph U+21A9 in font KaTeX Main
  lefthook: "M400000 281 H103s-33-11.2-61-33.5S0 197.3 0 164s14.2-61.2 42.5\n-83.5C70.8 58.2 104 47 142 47 c16.7 0 25 6.7 25 20 0 12-8.7 18.7-26 20-40 3.3\n-68.7 15.7-86 37-10 12-15 25.3-15 40 0 22.7 9.8 40.7 29.5 54 19.7 13.3 43.5 21\n 71.5 23h399859zM103 281v-40h399897v40z",
  leftlinesegment: "M40 281 V428 H0 V94 H40 V241 H400000 v40z\nM40 281 V428 H0 V94 H40 V241 H400000 v40z",
  leftmapsto: "M40 281 V448H0V74H40V241H400000v40z\nM40 281 V448H0V74H40V241H400000v40z",
  // tofrom is from glyph U+21C4 in font KaTeX AMS Regular
  leftToFrom: "M0 147h400000v40H0zm0 214c68 40 115.7 95.7 143 167h22c15.3 0 23\n-.3 23-1 0-1.3-5.3-13.7-16-37-18-35.3-41.3-69-70-101l-7-8h399905v-40H95l7-8\nc28.7-32 52-65.7 70-101 10.7-23.3 16-35.7 16-37 0-.7-7.7-1-23-1h-22C115.7 265.3\n 68 321 0 361zm0-174v-40h399900v40zm100 154v40h399900v-40z",
  longequal: "M0 50 h400000 v40H0z m0 194h40000v40H0z\nM0 50 h400000 v40H0z m0 194h40000v40H0z",
  midbrace: "M200428 334\nc-100.7-8.3-195.3-44-280-108-55.3-42-101.7-93-139-153l-9-14c-2.7 4-5.7 8.7-9 14\n-53.3 86.7-123.7 153-211 199-66.7 36-137.3 56.3-212 62H0V214h199568c178.3-11.7\n 311.7-78.3 403-201 6-8 9.7-12 11-12 .7-.7 6.7-1 18-1s17.3.3 18 1c1.3 0 5 4 11\n 12 44.7 59.3 101.3 106.3 170 141s145.3 54.3 229 60h199572v120z",
  midbraceunder: "M199572 214\nc100.7 8.3 195.3 44 280 108 55.3 42 101.7 93 139 153l9 14c2.7-4 5.7-8.7 9-14\n 53.3-86.7 123.7-153 211-199 66.7-36 137.3-56.3 212-62h199568v120H200432c-178.3\n 11.7-311.7 78.3-403 201-6 8-9.7 12-11 12-.7.7-6.7 1-18 1s-17.3-.3-18-1c-1.3 0\n-5-4-11-12-44.7-59.3-101.3-106.3-170-141s-145.3-54.3-229-60H0V214z",
  oiintSize1: "M512.6 71.6c272.6 0 320.3 106.8 320.3 178.2 0 70.8-47.7 177.6\n-320.3 177.6S193.1 320.6 193.1 249.8c0-71.4 46.9-178.2 319.5-178.2z\nm368.1 178.2c0-86.4-60.9-215.4-368.1-215.4-306.4 0-367.3 129-367.3 215.4 0 85.8\n60.9 214.8 367.3 214.8 307.2 0 368.1-129 368.1-214.8z",
  oiintSize2: "M757.8 100.1c384.7 0 451.1 137.6 451.1 230 0 91.3-66.4 228.8\n-451.1 228.8-386.3 0-452.7-137.5-452.7-228.8 0-92.4 66.4-230 452.7-230z\nm502.4 230c0-111.2-82.4-277.2-502.4-277.2s-504 166-504 277.2\nc0 110 84 276 504 276s502.4-166 502.4-276z",
  oiiintSize1: "M681.4 71.6c408.9 0 480.5 106.8 480.5 178.2 0 70.8-71.6 177.6\n-480.5 177.6S202.1 320.6 202.1 249.8c0-71.4 70.5-178.2 479.3-178.2z\nm525.8 178.2c0-86.4-86.8-215.4-525.7-215.4-437.9 0-524.7 129-524.7 215.4 0\n85.8 86.8 214.8 524.7 214.8 438.9 0 525.7-129 525.7-214.8z",
  oiiintSize2: "M1021.2 53c603.6 0 707.8 165.8 707.8 277.2 0 110-104.2 275.8\n-707.8 275.8-606 0-710.2-165.8-710.2-275.8C311 218.8 415.2 53 1021.2 53z\nm770.4 277.1c0-131.2-126.4-327.6-770.5-327.6S248.4 198.9 248.4 330.1\nc0 130 128.8 326.4 772.7 326.4s770.5-196.4 770.5-326.4z",
  rightarrow: "M0 241v40h399891c-47.3 35.3-84 78-110 128\n-16.7 32-27.7 63.7-33 95 0 1.3-.2 2.7-.5 4-.3 1.3-.5 2.3-.5 3 0 7.3 6.7 11 20\n 11 8 0 13.2-.8 15.5-2.5 2.3-1.7 4.2-5.5 5.5-11.5 2-13.3 5.7-27 11-41 14.7-44.7\n 39-84.5 73-119.5s73.7-60.2 119-75.5c6-2 9-5.7 9-11s-3-9-9-11c-45.3-15.3-85\n-40.5-119-75.5s-58.3-74.8-73-119.5c-4.7-14-8.3-27.3-11-40-1.3-6.7-3.2-10.8-5.5\n-12.5-2.3-1.7-7.5-2.5-15.5-2.5-14 0-21 3.7-21 11 0 2 2 10.3 6 25 20.7 83.3 67\n 151.7 139 205zm0 0v40h399900v-40z",
  rightbrace: "M400000 542l\n-6 6h-17c-12.7 0-19.3-.3-20-1-4-4-7.3-8.3-10-13-35.3-51.3-80.8-93.8-136.5-127.5\ns-117.2-55.8-184.5-66.5c-.7 0-2-.3-4-1-18.7-2.7-76-4.3-172-5H0V214h399571l6 1\nc124.7 8 235 61.7 331 161 31.3 33.3 59.7 72.7 85 118l7 13v35z",
  rightbraceunder: "M399994 0l6 6v35l-6 11c-56 104-135.3 181.3-238 232-57.3\n 28.7-117 45-179 50H-300V214h399897c43.3-7 81-15 113-26 100.7-33 179.7-91 237\n-174 2.7-5 6-9 10-13 .7-1 7.3-1 20-1h17z",
  rightgroup: "M0 80h399565c371 0 266.7 149.4 414 180 5.9 1.2 18 0 18 0 2 0\n 3-1 3-3v-38c-76-158-257-219-435-219H0z",
  rightgroupunder: "M0 262h399565c371 0 266.7-149.4 414-180 5.9-1.2 18 0 18\n 0 2 0 3 1 3 3v38c-76 158-257 219-435 219H0z",
  rightharpoon: "M0 241v40h399993c4.7-4.7 7-9.3 7-14 0-9.3\n-3.7-15.3-11-18-92.7-56.7-159-133.7-199-231-3.3-9.3-6-14.7-8-16-2-1.3-7-2-15-2\n-10.7 0-16.7 2-18 6-2 2.7-1 9.7 3 21 15.3 42 36.7 81.8 64 119.5 27.3 37.7 58\n 69.2 92 94.5zm0 0v40h399900v-40z",
  rightharpoonplus: "M0 241v40h399993c4.7-4.7 7-9.3 7-14 0-9.3-3.7-15.3-11\n-18-92.7-56.7-159-133.7-199-231-3.3-9.3-6-14.7-8-16-2-1.3-7-2-15-2-10.7 0-16.7\n 2-18 6-2 2.7-1 9.7 3 21 15.3 42 36.7 81.8 64 119.5 27.3 37.7 58 69.2 92 94.5z\nm0 0v40h399900v-40z m100 194v40h399900v-40zm0 0v40h399900v-40z",
  rightharpoondown: "M399747 511c0 7.3 6.7 11 20 11 8 0 13-.8 15-2.5s4.7-6.8\n 8-15.5c40-94 99.3-166.3 178-217 13.3-8 20.3-12.3 21-13 5.3-3.3 8.5-5.8 9.5\n-7.5 1-1.7 1.5-5.2 1.5-10.5s-2.3-10.3-7-15H0v40h399908c-34 25.3-64.7 57-92 95\n-27.3 38-48.7 77.7-64 119-3.3 8.7-5 14-5 16zM0 241v40h399900v-40z",
  rightharpoondownplus: "M399747 705c0 7.3 6.7 11 20 11 8 0 13-.8\n 15-2.5s4.7-6.8 8-15.5c40-94 99.3-166.3 178-217 13.3-8 20.3-12.3 21-13 5.3-3.3\n 8.5-5.8 9.5-7.5 1-1.7 1.5-5.2 1.5-10.5s-2.3-10.3-7-15H0v40h399908c-34 25.3\n-64.7 57-92 95-27.3 38-48.7 77.7-64 119-3.3 8.7-5 14-5 16zM0 435v40h399900v-40z\nm0-194v40h400000v-40zm0 0v40h400000v-40z",
  righthook: "M399859 241c-764 0 0 0 0 0 40-3.3 68.7-15.7 86-37 10-12 15-25.3\n 15-40 0-22.7-9.8-40.7-29.5-54-19.7-13.3-43.5-21-71.5-23-17.3-1.3-26-8-26-20 0\n-13.3 8.7-20 26-20 38 0 71 11.2 99 33.5 0 0 7 5.6 21 16.7 14 11.2 21 33.5 21\n 66.8s-14 61.2-42 83.5c-28 22.3-61 33.5-99 33.5L0 241z M0 281v-40h399859v40z",
  rightlinesegment: "M399960 241 V94 h40 V428 h-40 V281 H0 v-40z\nM399960 241 V94 h40 V428 h-40 V281 H0 v-40z",
  rightToFrom: "M400000 167c-70.7-42-118-97.7-142-167h-23c-15.3 0-23 .3-23\n 1 0 1.3 5.3 13.7 16 37 18 35.3 41.3 69 70 101l7 8H0v40h399905l-7 8c-28.7 32\n-52 65.7-70 101-10.7 23.3-16 35.7-16 37 0 .7 7.7 1 23 1h23c24-69.3 71.3-125 142\n-167z M100 147v40h399900v-40zM0 341v40h399900v-40z",
  // twoheadleftarrow is from glyph U+219E in font KaTeX AMS Regular
  twoheadleftarrow: "M0 167c68 40\n 115.7 95.7 143 167h22c15.3 0 23-.3 23-1 0-1.3-5.3-13.7-16-37-18-35.3-41.3-69\n-70-101l-7-8h125l9 7c50.7 39.3 85 86 103 140h46c0-4.7-6.3-18.7-19-42-18-35.3\n-40-67.3-66-96l-9-9h399716v-40H284l9-9c26-28.7 48-60.7 66-96 12.7-23.333 19\n-37.333 19-42h-46c-18 54-52.3 100.7-103 140l-9 7H95l7-8c28.7-32 52-65.7 70-101\n 10.7-23.333 16-35.7 16-37 0-.7-7.7-1-23-1h-22C115.7 71.3 68 127 0 167z",
  twoheadrightarrow: "M400000 167\nc-68-40-115.7-95.7-143-167h-22c-15.3 0-23 .3-23 1 0 1.3 5.3 13.7 16 37 18 35.3\n 41.3 69 70 101l7 8h-125l-9-7c-50.7-39.3-85-86-103-140h-46c0 4.7 6.3 18.7 19 42\n 18 35.3 40 67.3 66 96l9 9H0v40h399716l-9 9c-26 28.7-48 60.7-66 96-12.7 23.333\n-19 37.333-19 42h46c18-54 52.3-100.7 103-140l9-7h125l-7 8c-28.7 32-52 65.7-70\n 101-10.7 23.333-16 35.7-16 37 0 .7 7.7 1 23 1h22c27.3-71.3 75-127 143-167z",
  // tilde1 is a modified version of a glyph from the MnSymbol package
  tilde1: "M200 55.538c-77 0-168 73.953-177 73.953-3 0-7\n-2.175-9-5.437L2 97c-1-2-2-4-2-6 0-4 2-7 5-9l20-12C116 12 171 0 207 0c86 0\n 114 68 191 68 78 0 168-68 177-68 4 0 7 2 9 5l12 19c1 2.175 2 4.35 2 6.525 0\n 4.35-2 7.613-5 9.788l-19 13.05c-92 63.077-116.937 75.308-183 76.128\n-68.267.847-113-73.952-191-73.952z",
  // ditto tilde2, tilde3, & tilde4
  tilde2: "M344 55.266c-142 0-300.638 81.316-311.5 86.418\n-8.01 3.762-22.5 10.91-23.5 5.562L1 120c-1-2-1-3-1-4 0-5 3-9 8-10l18.4-9C160.9\n 31.9 283 0 358 0c148 0 188 122 331 122s314-97 326-97c4 0 8 2 10 7l7 21.114\nc1 2.14 1 3.21 1 4.28 0 5.347-3 9.626-7 10.696l-22.3 12.622C852.6 158.372 751\n 181.476 676 181.476c-149 0-189-126.21-332-126.21z",
  tilde3: "M786 59C457 59 32 175.242 13 175.242c-6 0-10-3.457\n-11-10.37L.15 138c-1-7 3-12 10-13l19.2-6.4C378.4 40.7 634.3 0 804.3 0c337 0\n 411.8 157 746.8 157 328 0 754-112 773-112 5 0 10 3 11 9l1 14.075c1 8.066-.697\n 16.595-6.697 17.492l-21.052 7.31c-367.9 98.146-609.15 122.696-778.15 122.696\n -338 0-409-156.573-744-156.573z",
  tilde4: "M786 58C457 58 32 177.487 13 177.487c-6 0-10-3.345\n-11-10.035L.15 143c-1-7 3-12 10-13l22-6.7C381.2 35 637.15 0 807.15 0c337 0 409\n 177 744 177 328 0 754-127 773-127 5 0 10 3 11 9l1 14.794c1 7.805-3 13.38-9\n 14.495l-20.7 5.574c-366.85 99.79-607.3 139.372-776.3 139.372-338 0-409\n -175.236-744-175.236z",
  // vec is from glyph U+20D7 in font KaTeX Main
  vec: "M377 20c0-5.333 1.833-10 5.5-14S391 0 397 0c4.667 0 8.667 1.667 12 5\n3.333 2.667 6.667 9 10 19 6.667 24.667 20.333 43.667 41 57 7.333 4.667 11\n10.667 11 18 0 6-1 10-3 12s-6.667 5-14 9c-28.667 14.667-53.667 35.667-75 63\n-1.333 1.333-3.167 3.5-5.5 6.5s-4 4.833-5 5.5c-1 .667-2.5 1.333-4.5 2s-4.333 1\n-7 1c-4.667 0-9.167-1.833-13.5-5.5S337 184 337 178c0-12.667 15.667-32.333 47-59\nH213l-171-1c-8.667-6-13-12.333-13-19 0-4.667 4.333-11.333 13-20h359\nc-16-25.333-24-45-24-59z",
  // widehat1 is a modified version of a glyph from the MnSymbol package
  widehat1: "M529 0h5l519 115c5 1 9 5 9 10 0 1-1 2-1 3l-4 22\nc-1 5-5 9-11 9h-2L532 67 19 159h-2c-5 0-9-4-11-9l-5-22c-1-6 2-12 8-13z",
  // ditto widehat2, widehat3, & widehat4
  widehat2: "M1181 0h2l1171 176c6 0 10 5 10 11l-2 23c-1 6-5 10\n-11 10h-1L1182 67 15 220h-1c-6 0-10-4-11-10l-2-23c-1-6 4-11 10-11z",
  widehat3: "M1181 0h2l1171 236c6 0 10 5 10 11l-2 23c-1 6-5 10\n-11 10h-1L1182 67 15 280h-1c-6 0-10-4-11-10l-2-23c-1-6 4-11 10-11z",
  widehat4: "M1181 0h2l1171 296c6 0 10 5 10 11l-2 23c-1 6-5 10\n-11 10h-1L1182 67 15 340h-1c-6 0-10-4-11-10l-2-23c-1-6 4-11 10-11z",
  // widecheck paths are all inverted versions of widehat
  widecheck1: "M529,159h5l519,-115c5,-1,9,-5,9,-10c0,-1,-1,-2,-1,-3l-4,-22c-1,\n-5,-5,-9,-11,-9h-2l-512,92l-513,-92h-2c-5,0,-9,4,-11,9l-5,22c-1,6,2,12,8,13z",
  widecheck2: "M1181,220h2l1171,-176c6,0,10,-5,10,-11l-2,-23c-1,-6,-5,-10,\n-11,-10h-1l-1168,153l-1167,-153h-1c-6,0,-10,4,-11,10l-2,23c-1,6,4,11,10,11z",
  widecheck3: "M1181,280h2l1171,-236c6,0,10,-5,10,-11l-2,-23c-1,-6,-5,-10,\n-11,-10h-1l-1168,213l-1167,-213h-1c-6,0,-10,4,-11,10l-2,23c-1,6,4,11,10,11z",
  widecheck4: "M1181,340h2l1171,-296c6,0,10,-5,10,-11l-2,-23c-1,-6,-5,-10,\n-11,-10h-1l-1168,273l-1167,-273h-1c-6,0,-10,4,-11,10l-2,23c-1,6,4,11,10,11z",
  // The next ten paths support reaction arrows from the mhchem package.
  // Arrows for \ce{<-->} are offset from xAxis by 0.22ex, per mhchem in LaTeX
  // baraboveleftarrow is mostly from glyph U+2190 in font KaTeX Main
  baraboveleftarrow: "M400000 620h-399890l3 -3c68.7 -52.7 113.7 -120 135 -202\nc4 -14.7 6 -23 6 -25c0 -7.3 -7 -11 -21 -11c-8 0 -13.2 0.8 -15.5 2.5\nc-2.3 1.7 -4.2 5.8 -5.5 12.5c-1.3 4.7 -2.7 10.3 -4 17c-12 48.7 -34.8 92 -68.5 130\ns-74.2 66.3 -121.5 85c-10 4 -16 7.7 -18 11c0 8.7 6 14.3 18 17c47.3 18.7 87.8 47\n121.5 85s56.5 81.3 68.5 130c0.7 2 1.3 5 2 9s1.2 6.7 1.5 8c0.3 1.3 1 3.3 2 6\ns2.2 4.5 3.5 5.5c1.3 1 3.3 1.8 6 2.5s6 1 10 1c14 0 21 -3.7 21 -11\nc0 -2 -2 -10.3 -6 -25c-20 -79.3 -65 -146.7 -135 -202l-3 -3h399890z\nM100 620v40h399900v-40z M0 241v40h399900v-40zM0 241v40h399900v-40z",
  // rightarrowabovebar is mostly from glyph U+2192, KaTeX Main
  rightarrowabovebar: "M0 241v40h399891c-47.3 35.3-84 78-110 128-16.7 32\n-27.7 63.7-33 95 0 1.3-.2 2.7-.5 4-.3 1.3-.5 2.3-.5 3 0 7.3 6.7 11 20 11 8 0\n13.2-.8 15.5-2.5 2.3-1.7 4.2-5.5 5.5-11.5 2-13.3 5.7-27 11-41 14.7-44.7 39\n-84.5 73-119.5s73.7-60.2 119-75.5c6-2 9-5.7 9-11s-3-9-9-11c-45.3-15.3-85-40.5\n-119-75.5s-58.3-74.8-73-119.5c-4.7-14-8.3-27.3-11-40-1.3-6.7-3.2-10.8-5.5\n-12.5-2.3-1.7-7.5-2.5-15.5-2.5-14 0-21 3.7-21 11 0 2 2 10.3 6 25 20.7 83.3 67\n151.7 139 205zm96 379h399894v40H0zm0 0h399904v40H0z",
  // The short left harpoon has 0.5em (i.e. 500 units) kern on the left end.
  // Ref from mhchem.sty: \rlap{\raisebox{-.22ex}{$\kern0.5em
  baraboveshortleftharpoon: "M507,435c-4,4,-6.3,8.7,-7,14c0,5.3,0.7,9,2,11\nc1.3,2,5.3,5.3,12,10c90.7,54,156,130,196,228c3.3,10.7,6.3,16.3,9,17\nc2,0.7,5,1,9,1c0,0,5,0,5,0c10.7,0,16.7,-2,18,-6c2,-2.7,1,-9.7,-3,-21\nc-32,-87.3,-82.7,-157.7,-152,-211c0,0,-3,-3,-3,-3l399351,0l0,-40\nc-398570,0,-399437,0,-399437,0z M593 435 v40 H399500 v-40z\nM0 281 v-40 H399908 v40z M0 281 v-40 H399908 v40z",
  rightharpoonaboveshortbar: "M0,241 l0,40c399126,0,399993,0,399993,0\nc4.7,-4.7,7,-9.3,7,-14c0,-9.3,-3.7,-15.3,-11,-18c-92.7,-56.7,-159,-133.7,-199,\n-231c-3.3,-9.3,-6,-14.7,-8,-16c-2,-1.3,-7,-2,-15,-2c-10.7,0,-16.7,2,-18,6\nc-2,2.7,-1,9.7,3,21c15.3,42,36.7,81.8,64,119.5c27.3,37.7,58,69.2,92,94.5z\nM0 241 v40 H399908 v-40z M0 475 v-40 H399500 v40z M0 475 v-40 H399500 v40z",
  shortbaraboveleftharpoon: "M7,435c-4,4,-6.3,8.7,-7,14c0,5.3,0.7,9,2,11\nc1.3,2,5.3,5.3,12,10c90.7,54,156,130,196,228c3.3,10.7,6.3,16.3,9,17c2,0.7,5,1,9,\n1c0,0,5,0,5,0c10.7,0,16.7,-2,18,-6c2,-2.7,1,-9.7,-3,-21c-32,-87.3,-82.7,-157.7,\n-152,-211c0,0,-3,-3,-3,-3l399907,0l0,-40c-399126,0,-399993,0,-399993,0z\nM93 435 v40 H400000 v-40z M500 241 v40 H400000 v-40z M500 241 v40 H400000 v-40z",
  shortrightharpoonabovebar: "M53,241l0,40c398570,0,399437,0,399437,0\nc4.7,-4.7,7,-9.3,7,-14c0,-9.3,-3.7,-15.3,-11,-18c-92.7,-56.7,-159,-133.7,-199,\n-231c-3.3,-9.3,-6,-14.7,-8,-16c-2,-1.3,-7,-2,-15,-2c-10.7,0,-16.7,2,-18,6\nc-2,2.7,-1,9.7,3,21c15.3,42,36.7,81.8,64,119.5c27.3,37.7,58,69.2,92,94.5z\nM500 241 v40 H399408 v-40z M500 435 v40 H400000 v-40z"
};
var tallDelim = function tallDelim2(label, midHeight) {
  switch (label) {
    case "lbrack":
      return "M403 1759 V84 H666 V0 H319 V1759 v" + midHeight + " v1759 h347 v-84\nH403z M403 1759 V0 H319 V1759 v" + midHeight + " v1759 h84z";
    case "rbrack":
      return "M347 1759 V0 H0 V84 H263 V1759 v" + midHeight + " v1759 H0 v84 H347z\nM347 1759 V0 H263 V1759 v" + midHeight + " v1759 h84z";
    case "vert":
      return "M145 15 v585 v" + midHeight + " v585 c2.667,10,9.667,15,21,15\nc10,0,16.667,-5,20,-15 v-585 v" + -midHeight + " v-585 c-2.667,-10,-9.667,-15,-21,-15\nc-10,0,-16.667,5,-20,15z M188 15 H145 v585 v" + midHeight + " v585 h43z";
    case "doublevert":
      return "M145 15 v585 v" + midHeight + " v585 c2.667,10,9.667,15,21,15\nc10,0,16.667,-5,20,-15 v-585 v" + -midHeight + " v-585 c-2.667,-10,-9.667,-15,-21,-15\nc-10,0,-16.667,5,-20,15z M188 15 H145 v585 v" + midHeight + " v585 h43z\nM367 15 v585 v" + midHeight + " v585 c2.667,10,9.667,15,21,15\nc10,0,16.667,-5,20,-15 v-585 v" + -midHeight + " v-585 c-2.667,-10,-9.667,-15,-21,-15\nc-10,0,-16.667,5,-20,15z M410 15 H367 v585 v" + midHeight + " v585 h43z";
    case "lfloor":
      return "M319 602 V0 H403 V602 v" + midHeight + " v1715 h263 v84 H319z\nMM319 602 V0 H403 V602 v" + midHeight + " v1715 H319z";
    case "rfloor":
      return "M319 602 V0 H403 V602 v" + midHeight + " v1799 H0 v-84 H319z\nMM319 602 V0 H403 V602 v" + midHeight + " v1715 H319z";
    case "lceil":
      return "M403 1759 V84 H666 V0 H319 V1759 v" + midHeight + " v602 h84z\nM403 1759 V0 H319 V1759 v" + midHeight + " v602 h84z";
    case "rceil":
      return "M347 1759 V0 H0 V84 H263 V1759 v" + midHeight + " v602 h84z\nM347 1759 V0 h-84 V1759 v" + midHeight + " v602 h84z";
    case "lparen":
      return "M863,9c0,-2,-2,-5,-6,-9c0,0,-17,0,-17,0c-12.7,0,-19.3,0.3,-20,1\nc-5.3,5.3,-10.3,11,-15,17c-242.7,294.7,-395.3,682,-458,1162c-21.3,163.3,-33.3,349,\n-36,557 l0," + (midHeight + 84) + "c0.2,6,0,26,0,60c2,159.3,10,310.7,24,454c53.3,528,210,\n949.7,470,1265c4.7,6,9.7,11.7,15,17c0.7,0.7,7,1,19,1c0,0,18,0,18,0c4,-4,6,-7,6,-9\nc0,-2.7,-3.3,-8.7,-10,-18c-135.3,-192.7,-235.5,-414.3,-300.5,-665c-65,-250.7,-102.5,\n-544.7,-112.5,-882c-2,-104,-3,-167,-3,-189\nl0,-" + (midHeight + 92) + "c0,-162.7,5.7,-314,17,-454c20.7,-272,63.7,-513,129,-723c65.3,\n-210,155.3,-396.3,270,-559c6.7,-9.3,10,-15.3,10,-18z";
    case "rparen":
      return "M76,0c-16.7,0,-25,3,-25,9c0,2,2,6.3,6,13c21.3,28.7,42.3,60.3,\n63,95c96.7,156.7,172.8,332.5,228.5,527.5c55.7,195,92.8,416.5,111.5,664.5\nc11.3,139.3,17,290.7,17,454c0,28,1.7,43,3.3,45l0," + (midHeight + 9) + "\nc-3,4,-3.3,16.7,-3.3,38c0,162,-5.7,313.7,-17,455c-18.7,248,-55.8,469.3,-111.5,664\nc-55.7,194.7,-131.8,370.3,-228.5,527c-20.7,34.7,-41.7,66.3,-63,95c-2,3.3,-4,7,-6,11\nc0,7.3,5.7,11,17,11c0,0,11,0,11,0c9.3,0,14.3,-0.3,15,-1c5.3,-5.3,10.3,-11,15,-17\nc242.7,-294.7,395.3,-681.7,458,-1161c21.3,-164.7,33.3,-350.7,36,-558\nl0,-" + (midHeight + 144) + "c-2,-159.3,-10,-310.7,-24,-454c-53.3,-528,-210,-949.7,\n-470,-1265c-4.7,-6,-9.7,-11.7,-15,-17c-0.7,-0.7,-6.7,-1,-18,-1z";
    default:
      throw new Error("Unknown stretchy delimiter.");
  }
};
var DocumentFragment = class {
  // HtmlDomNode
  // Never used; needed for satisfying interface.
  constructor(children) {
    this.children = void 0;
    this.classes = void 0;
    this.height = void 0;
    this.depth = void 0;
    this.maxFontSize = void 0;
    this.style = void 0;
    this.children = children;
    this.classes = [];
    this.height = 0;
    this.depth = 0;
    this.maxFontSize = 0;
    this.style = {};
  }
  hasClass(className) {
    return utils.contains(this.classes, className);
  }
  /** Convert the fragment into a node. */
  toNode() {
    var frag = document.createDocumentFragment();
    for (var i2 = 0; i2 < this.children.length; i2++) {
      frag.appendChild(this.children[i2].toNode());
    }
    return frag;
  }
  /** Convert the fragment into HTML markup. */
  toMarkup() {
    var markup = "";
    for (var i2 = 0; i2 < this.children.length; i2++) {
      markup += this.children[i2].toMarkup();
    }
    return markup;
  }
  /**
   * Converts the math node into a string, similar to innerText. Applies to
   * MathDomNode's only.
   */
  toText() {
    var toText = (child) => child.toText();
    return this.children.map(toText).join("");
  }
};
var fontMetricsData = {
  "AMS-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "65": [0, 0.68889, 0, 0, 0.72222],
    "66": [0, 0.68889, 0, 0, 0.66667],
    "67": [0, 0.68889, 0, 0, 0.72222],
    "68": [0, 0.68889, 0, 0, 0.72222],
    "69": [0, 0.68889, 0, 0, 0.66667],
    "70": [0, 0.68889, 0, 0, 0.61111],
    "71": [0, 0.68889, 0, 0, 0.77778],
    "72": [0, 0.68889, 0, 0, 0.77778],
    "73": [0, 0.68889, 0, 0, 0.38889],
    "74": [0.16667, 0.68889, 0, 0, 0.5],
    "75": [0, 0.68889, 0, 0, 0.77778],
    "76": [0, 0.68889, 0, 0, 0.66667],
    "77": [0, 0.68889, 0, 0, 0.94445],
    "78": [0, 0.68889, 0, 0, 0.72222],
    "79": [0.16667, 0.68889, 0, 0, 0.77778],
    "80": [0, 0.68889, 0, 0, 0.61111],
    "81": [0.16667, 0.68889, 0, 0, 0.77778],
    "82": [0, 0.68889, 0, 0, 0.72222],
    "83": [0, 0.68889, 0, 0, 0.55556],
    "84": [0, 0.68889, 0, 0, 0.66667],
    "85": [0, 0.68889, 0, 0, 0.72222],
    "86": [0, 0.68889, 0, 0, 0.72222],
    "87": [0, 0.68889, 0, 0, 1],
    "88": [0, 0.68889, 0, 0, 0.72222],
    "89": [0, 0.68889, 0, 0, 0.72222],
    "90": [0, 0.68889, 0, 0, 0.66667],
    "107": [0, 0.68889, 0, 0, 0.55556],
    "160": [0, 0, 0, 0, 0.25],
    "165": [0, 0.675, 0.025, 0, 0.75],
    "174": [0.15559, 0.69224, 0, 0, 0.94666],
    "240": [0, 0.68889, 0, 0, 0.55556],
    "295": [0, 0.68889, 0, 0, 0.54028],
    "710": [0, 0.825, 0, 0, 2.33334],
    "732": [0, 0.9, 0, 0, 2.33334],
    "770": [0, 0.825, 0, 0, 2.33334],
    "771": [0, 0.9, 0, 0, 2.33334],
    "989": [0.08167, 0.58167, 0, 0, 0.77778],
    "1008": [0, 0.43056, 0.04028, 0, 0.66667],
    "8245": [0, 0.54986, 0, 0, 0.275],
    "8463": [0, 0.68889, 0, 0, 0.54028],
    "8487": [0, 0.68889, 0, 0, 0.72222],
    "8498": [0, 0.68889, 0, 0, 0.55556],
    "8502": [0, 0.68889, 0, 0, 0.66667],
    "8503": [0, 0.68889, 0, 0, 0.44445],
    "8504": [0, 0.68889, 0, 0, 0.66667],
    "8513": [0, 0.68889, 0, 0, 0.63889],
    "8592": [-0.03598, 0.46402, 0, 0, 0.5],
    "8594": [-0.03598, 0.46402, 0, 0, 0.5],
    "8602": [-0.13313, 0.36687, 0, 0, 1],
    "8603": [-0.13313, 0.36687, 0, 0, 1],
    "8606": [0.01354, 0.52239, 0, 0, 1],
    "8608": [0.01354, 0.52239, 0, 0, 1],
    "8610": [0.01354, 0.52239, 0, 0, 1.11111],
    "8611": [0.01354, 0.52239, 0, 0, 1.11111],
    "8619": [0, 0.54986, 0, 0, 1],
    "8620": [0, 0.54986, 0, 0, 1],
    "8621": [-0.13313, 0.37788, 0, 0, 1.38889],
    "8622": [-0.13313, 0.36687, 0, 0, 1],
    "8624": [0, 0.69224, 0, 0, 0.5],
    "8625": [0, 0.69224, 0, 0, 0.5],
    "8630": [0, 0.43056, 0, 0, 1],
    "8631": [0, 0.43056, 0, 0, 1],
    "8634": [0.08198, 0.58198, 0, 0, 0.77778],
    "8635": [0.08198, 0.58198, 0, 0, 0.77778],
    "8638": [0.19444, 0.69224, 0, 0, 0.41667],
    "8639": [0.19444, 0.69224, 0, 0, 0.41667],
    "8642": [0.19444, 0.69224, 0, 0, 0.41667],
    "8643": [0.19444, 0.69224, 0, 0, 0.41667],
    "8644": [0.1808, 0.675, 0, 0, 1],
    "8646": [0.1808, 0.675, 0, 0, 1],
    "8647": [0.1808, 0.675, 0, 0, 1],
    "8648": [0.19444, 0.69224, 0, 0, 0.83334],
    "8649": [0.1808, 0.675, 0, 0, 1],
    "8650": [0.19444, 0.69224, 0, 0, 0.83334],
    "8651": [0.01354, 0.52239, 0, 0, 1],
    "8652": [0.01354, 0.52239, 0, 0, 1],
    "8653": [-0.13313, 0.36687, 0, 0, 1],
    "8654": [-0.13313, 0.36687, 0, 0, 1],
    "8655": [-0.13313, 0.36687, 0, 0, 1],
    "8666": [0.13667, 0.63667, 0, 0, 1],
    "8667": [0.13667, 0.63667, 0, 0, 1],
    "8669": [-0.13313, 0.37788, 0, 0, 1],
    "8672": [-0.064, 0.437, 0, 0, 1.334],
    "8674": [-0.064, 0.437, 0, 0, 1.334],
    "8705": [0, 0.825, 0, 0, 0.5],
    "8708": [0, 0.68889, 0, 0, 0.55556],
    "8709": [0.08167, 0.58167, 0, 0, 0.77778],
    "8717": [0, 0.43056, 0, 0, 0.42917],
    "8722": [-0.03598, 0.46402, 0, 0, 0.5],
    "8724": [0.08198, 0.69224, 0, 0, 0.77778],
    "8726": [0.08167, 0.58167, 0, 0, 0.77778],
    "8733": [0, 0.69224, 0, 0, 0.77778],
    "8736": [0, 0.69224, 0, 0, 0.72222],
    "8737": [0, 0.69224, 0, 0, 0.72222],
    "8738": [0.03517, 0.52239, 0, 0, 0.72222],
    "8739": [0.08167, 0.58167, 0, 0, 0.22222],
    "8740": [0.25142, 0.74111, 0, 0, 0.27778],
    "8741": [0.08167, 0.58167, 0, 0, 0.38889],
    "8742": [0.25142, 0.74111, 0, 0, 0.5],
    "8756": [0, 0.69224, 0, 0, 0.66667],
    "8757": [0, 0.69224, 0, 0, 0.66667],
    "8764": [-0.13313, 0.36687, 0, 0, 0.77778],
    "8765": [-0.13313, 0.37788, 0, 0, 0.77778],
    "8769": [-0.13313, 0.36687, 0, 0, 0.77778],
    "8770": [-0.03625, 0.46375, 0, 0, 0.77778],
    "8774": [0.30274, 0.79383, 0, 0, 0.77778],
    "8776": [-0.01688, 0.48312, 0, 0, 0.77778],
    "8778": [0.08167, 0.58167, 0, 0, 0.77778],
    "8782": [0.06062, 0.54986, 0, 0, 0.77778],
    "8783": [0.06062, 0.54986, 0, 0, 0.77778],
    "8785": [0.08198, 0.58198, 0, 0, 0.77778],
    "8786": [0.08198, 0.58198, 0, 0, 0.77778],
    "8787": [0.08198, 0.58198, 0, 0, 0.77778],
    "8790": [0, 0.69224, 0, 0, 0.77778],
    "8791": [0.22958, 0.72958, 0, 0, 0.77778],
    "8796": [0.08198, 0.91667, 0, 0, 0.77778],
    "8806": [0.25583, 0.75583, 0, 0, 0.77778],
    "8807": [0.25583, 0.75583, 0, 0, 0.77778],
    "8808": [0.25142, 0.75726, 0, 0, 0.77778],
    "8809": [0.25142, 0.75726, 0, 0, 0.77778],
    "8812": [0.25583, 0.75583, 0, 0, 0.5],
    "8814": [0.20576, 0.70576, 0, 0, 0.77778],
    "8815": [0.20576, 0.70576, 0, 0, 0.77778],
    "8816": [0.30274, 0.79383, 0, 0, 0.77778],
    "8817": [0.30274, 0.79383, 0, 0, 0.77778],
    "8818": [0.22958, 0.72958, 0, 0, 0.77778],
    "8819": [0.22958, 0.72958, 0, 0, 0.77778],
    "8822": [0.1808, 0.675, 0, 0, 0.77778],
    "8823": [0.1808, 0.675, 0, 0, 0.77778],
    "8828": [0.13667, 0.63667, 0, 0, 0.77778],
    "8829": [0.13667, 0.63667, 0, 0, 0.77778],
    "8830": [0.22958, 0.72958, 0, 0, 0.77778],
    "8831": [0.22958, 0.72958, 0, 0, 0.77778],
    "8832": [0.20576, 0.70576, 0, 0, 0.77778],
    "8833": [0.20576, 0.70576, 0, 0, 0.77778],
    "8840": [0.30274, 0.79383, 0, 0, 0.77778],
    "8841": [0.30274, 0.79383, 0, 0, 0.77778],
    "8842": [0.13597, 0.63597, 0, 0, 0.77778],
    "8843": [0.13597, 0.63597, 0, 0, 0.77778],
    "8847": [0.03517, 0.54986, 0, 0, 0.77778],
    "8848": [0.03517, 0.54986, 0, 0, 0.77778],
    "8858": [0.08198, 0.58198, 0, 0, 0.77778],
    "8859": [0.08198, 0.58198, 0, 0, 0.77778],
    "8861": [0.08198, 0.58198, 0, 0, 0.77778],
    "8862": [0, 0.675, 0, 0, 0.77778],
    "8863": [0, 0.675, 0, 0, 0.77778],
    "8864": [0, 0.675, 0, 0, 0.77778],
    "8865": [0, 0.675, 0, 0, 0.77778],
    "8872": [0, 0.69224, 0, 0, 0.61111],
    "8873": [0, 0.69224, 0, 0, 0.72222],
    "8874": [0, 0.69224, 0, 0, 0.88889],
    "8876": [0, 0.68889, 0, 0, 0.61111],
    "8877": [0, 0.68889, 0, 0, 0.61111],
    "8878": [0, 0.68889, 0, 0, 0.72222],
    "8879": [0, 0.68889, 0, 0, 0.72222],
    "8882": [0.03517, 0.54986, 0, 0, 0.77778],
    "8883": [0.03517, 0.54986, 0, 0, 0.77778],
    "8884": [0.13667, 0.63667, 0, 0, 0.77778],
    "8885": [0.13667, 0.63667, 0, 0, 0.77778],
    "8888": [0, 0.54986, 0, 0, 1.11111],
    "8890": [0.19444, 0.43056, 0, 0, 0.55556],
    "8891": [0.19444, 0.69224, 0, 0, 0.61111],
    "8892": [0.19444, 0.69224, 0, 0, 0.61111],
    "8901": [0, 0.54986, 0, 0, 0.27778],
    "8903": [0.08167, 0.58167, 0, 0, 0.77778],
    "8905": [0.08167, 0.58167, 0, 0, 0.77778],
    "8906": [0.08167, 0.58167, 0, 0, 0.77778],
    "8907": [0, 0.69224, 0, 0, 0.77778],
    "8908": [0, 0.69224, 0, 0, 0.77778],
    "8909": [-0.03598, 0.46402, 0, 0, 0.77778],
    "8910": [0, 0.54986, 0, 0, 0.76042],
    "8911": [0, 0.54986, 0, 0, 0.76042],
    "8912": [0.03517, 0.54986, 0, 0, 0.77778],
    "8913": [0.03517, 0.54986, 0, 0, 0.77778],
    "8914": [0, 0.54986, 0, 0, 0.66667],
    "8915": [0, 0.54986, 0, 0, 0.66667],
    "8916": [0, 0.69224, 0, 0, 0.66667],
    "8918": [0.0391, 0.5391, 0, 0, 0.77778],
    "8919": [0.0391, 0.5391, 0, 0, 0.77778],
    "8920": [0.03517, 0.54986, 0, 0, 1.33334],
    "8921": [0.03517, 0.54986, 0, 0, 1.33334],
    "8922": [0.38569, 0.88569, 0, 0, 0.77778],
    "8923": [0.38569, 0.88569, 0, 0, 0.77778],
    "8926": [0.13667, 0.63667, 0, 0, 0.77778],
    "8927": [0.13667, 0.63667, 0, 0, 0.77778],
    "8928": [0.30274, 0.79383, 0, 0, 0.77778],
    "8929": [0.30274, 0.79383, 0, 0, 0.77778],
    "8934": [0.23222, 0.74111, 0, 0, 0.77778],
    "8935": [0.23222, 0.74111, 0, 0, 0.77778],
    "8936": [0.23222, 0.74111, 0, 0, 0.77778],
    "8937": [0.23222, 0.74111, 0, 0, 0.77778],
    "8938": [0.20576, 0.70576, 0, 0, 0.77778],
    "8939": [0.20576, 0.70576, 0, 0, 0.77778],
    "8940": [0.30274, 0.79383, 0, 0, 0.77778],
    "8941": [0.30274, 0.79383, 0, 0, 0.77778],
    "8994": [0.19444, 0.69224, 0, 0, 0.77778],
    "8995": [0.19444, 0.69224, 0, 0, 0.77778],
    "9416": [0.15559, 0.69224, 0, 0, 0.90222],
    "9484": [0, 0.69224, 0, 0, 0.5],
    "9488": [0, 0.69224, 0, 0, 0.5],
    "9492": [0, 0.37788, 0, 0, 0.5],
    "9496": [0, 0.37788, 0, 0, 0.5],
    "9585": [0.19444, 0.68889, 0, 0, 0.88889],
    "9586": [0.19444, 0.74111, 0, 0, 0.88889],
    "9632": [0, 0.675, 0, 0, 0.77778],
    "9633": [0, 0.675, 0, 0, 0.77778],
    "9650": [0, 0.54986, 0, 0, 0.72222],
    "9651": [0, 0.54986, 0, 0, 0.72222],
    "9654": [0.03517, 0.54986, 0, 0, 0.77778],
    "9660": [0, 0.54986, 0, 0, 0.72222],
    "9661": [0, 0.54986, 0, 0, 0.72222],
    "9664": [0.03517, 0.54986, 0, 0, 0.77778],
    "9674": [0.11111, 0.69224, 0, 0, 0.66667],
    "9733": [0.19444, 0.69224, 0, 0, 0.94445],
    "10003": [0, 0.69224, 0, 0, 0.83334],
    "10016": [0, 0.69224, 0, 0, 0.83334],
    "10731": [0.11111, 0.69224, 0, 0, 0.66667],
    "10846": [0.19444, 0.75583, 0, 0, 0.61111],
    "10877": [0.13667, 0.63667, 0, 0, 0.77778],
    "10878": [0.13667, 0.63667, 0, 0, 0.77778],
    "10885": [0.25583, 0.75583, 0, 0, 0.77778],
    "10886": [0.25583, 0.75583, 0, 0, 0.77778],
    "10887": [0.13597, 0.63597, 0, 0, 0.77778],
    "10888": [0.13597, 0.63597, 0, 0, 0.77778],
    "10889": [0.26167, 0.75726, 0, 0, 0.77778],
    "10890": [0.26167, 0.75726, 0, 0, 0.77778],
    "10891": [0.48256, 0.98256, 0, 0, 0.77778],
    "10892": [0.48256, 0.98256, 0, 0, 0.77778],
    "10901": [0.13667, 0.63667, 0, 0, 0.77778],
    "10902": [0.13667, 0.63667, 0, 0, 0.77778],
    "10933": [0.25142, 0.75726, 0, 0, 0.77778],
    "10934": [0.25142, 0.75726, 0, 0, 0.77778],
    "10935": [0.26167, 0.75726, 0, 0, 0.77778],
    "10936": [0.26167, 0.75726, 0, 0, 0.77778],
    "10937": [0.26167, 0.75726, 0, 0, 0.77778],
    "10938": [0.26167, 0.75726, 0, 0, 0.77778],
    "10949": [0.25583, 0.75583, 0, 0, 0.77778],
    "10950": [0.25583, 0.75583, 0, 0, 0.77778],
    "10955": [0.28481, 0.79383, 0, 0, 0.77778],
    "10956": [0.28481, 0.79383, 0, 0, 0.77778],
    "57350": [0.08167, 0.58167, 0, 0, 0.22222],
    "57351": [0.08167, 0.58167, 0, 0, 0.38889],
    "57352": [0.08167, 0.58167, 0, 0, 0.77778],
    "57353": [0, 0.43056, 0.04028, 0, 0.66667],
    "57356": [0.25142, 0.75726, 0, 0, 0.77778],
    "57357": [0.25142, 0.75726, 0, 0, 0.77778],
    "57358": [0.41951, 0.91951, 0, 0, 0.77778],
    "57359": [0.30274, 0.79383, 0, 0, 0.77778],
    "57360": [0.30274, 0.79383, 0, 0, 0.77778],
    "57361": [0.41951, 0.91951, 0, 0, 0.77778],
    "57366": [0.25142, 0.75726, 0, 0, 0.77778],
    "57367": [0.25142, 0.75726, 0, 0, 0.77778],
    "57368": [0.25142, 0.75726, 0, 0, 0.77778],
    "57369": [0.25142, 0.75726, 0, 0, 0.77778],
    "57370": [0.13597, 0.63597, 0, 0, 0.77778],
    "57371": [0.13597, 0.63597, 0, 0, 0.77778]
  },
  "Caligraphic-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "65": [0, 0.68333, 0, 0.19445, 0.79847],
    "66": [0, 0.68333, 0.03041, 0.13889, 0.65681],
    "67": [0, 0.68333, 0.05834, 0.13889, 0.52653],
    "68": [0, 0.68333, 0.02778, 0.08334, 0.77139],
    "69": [0, 0.68333, 0.08944, 0.11111, 0.52778],
    "70": [0, 0.68333, 0.09931, 0.11111, 0.71875],
    "71": [0.09722, 0.68333, 0.0593, 0.11111, 0.59487],
    "72": [0, 0.68333, 965e-5, 0.11111, 0.84452],
    "73": [0, 0.68333, 0.07382, 0, 0.54452],
    "74": [0.09722, 0.68333, 0.18472, 0.16667, 0.67778],
    "75": [0, 0.68333, 0.01445, 0.05556, 0.76195],
    "76": [0, 0.68333, 0, 0.13889, 0.68972],
    "77": [0, 0.68333, 0, 0.13889, 1.2009],
    "78": [0, 0.68333, 0.14736, 0.08334, 0.82049],
    "79": [0, 0.68333, 0.02778, 0.11111, 0.79611],
    "80": [0, 0.68333, 0.08222, 0.08334, 0.69556],
    "81": [0.09722, 0.68333, 0, 0.11111, 0.81667],
    "82": [0, 0.68333, 0, 0.08334, 0.8475],
    "83": [0, 0.68333, 0.075, 0.13889, 0.60556],
    "84": [0, 0.68333, 0.25417, 0, 0.54464],
    "85": [0, 0.68333, 0.09931, 0.08334, 0.62583],
    "86": [0, 0.68333, 0.08222, 0, 0.61278],
    "87": [0, 0.68333, 0.08222, 0.08334, 0.98778],
    "88": [0, 0.68333, 0.14643, 0.13889, 0.7133],
    "89": [0.09722, 0.68333, 0.08222, 0.08334, 0.66834],
    "90": [0, 0.68333, 0.07944, 0.13889, 0.72473],
    "160": [0, 0, 0, 0, 0.25]
  },
  "Fraktur-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69141, 0, 0, 0.29574],
    "34": [0, 0.69141, 0, 0, 0.21471],
    "38": [0, 0.69141, 0, 0, 0.73786],
    "39": [0, 0.69141, 0, 0, 0.21201],
    "40": [0.24982, 0.74947, 0, 0, 0.38865],
    "41": [0.24982, 0.74947, 0, 0, 0.38865],
    "42": [0, 0.62119, 0, 0, 0.27764],
    "43": [0.08319, 0.58283, 0, 0, 0.75623],
    "44": [0, 0.10803, 0, 0, 0.27764],
    "45": [0.08319, 0.58283, 0, 0, 0.75623],
    "46": [0, 0.10803, 0, 0, 0.27764],
    "47": [0.24982, 0.74947, 0, 0, 0.50181],
    "48": [0, 0.47534, 0, 0, 0.50181],
    "49": [0, 0.47534, 0, 0, 0.50181],
    "50": [0, 0.47534, 0, 0, 0.50181],
    "51": [0.18906, 0.47534, 0, 0, 0.50181],
    "52": [0.18906, 0.47534, 0, 0, 0.50181],
    "53": [0.18906, 0.47534, 0, 0, 0.50181],
    "54": [0, 0.69141, 0, 0, 0.50181],
    "55": [0.18906, 0.47534, 0, 0, 0.50181],
    "56": [0, 0.69141, 0, 0, 0.50181],
    "57": [0.18906, 0.47534, 0, 0, 0.50181],
    "58": [0, 0.47534, 0, 0, 0.21606],
    "59": [0.12604, 0.47534, 0, 0, 0.21606],
    "61": [-0.13099, 0.36866, 0, 0, 0.75623],
    "63": [0, 0.69141, 0, 0, 0.36245],
    "65": [0, 0.69141, 0, 0, 0.7176],
    "66": [0, 0.69141, 0, 0, 0.88397],
    "67": [0, 0.69141, 0, 0, 0.61254],
    "68": [0, 0.69141, 0, 0, 0.83158],
    "69": [0, 0.69141, 0, 0, 0.66278],
    "70": [0.12604, 0.69141, 0, 0, 0.61119],
    "71": [0, 0.69141, 0, 0, 0.78539],
    "72": [0.06302, 0.69141, 0, 0, 0.7203],
    "73": [0, 0.69141, 0, 0, 0.55448],
    "74": [0.12604, 0.69141, 0, 0, 0.55231],
    "75": [0, 0.69141, 0, 0, 0.66845],
    "76": [0, 0.69141, 0, 0, 0.66602],
    "77": [0, 0.69141, 0, 0, 1.04953],
    "78": [0, 0.69141, 0, 0, 0.83212],
    "79": [0, 0.69141, 0, 0, 0.82699],
    "80": [0.18906, 0.69141, 0, 0, 0.82753],
    "81": [0.03781, 0.69141, 0, 0, 0.82699],
    "82": [0, 0.69141, 0, 0, 0.82807],
    "83": [0, 0.69141, 0, 0, 0.82861],
    "84": [0, 0.69141, 0, 0, 0.66899],
    "85": [0, 0.69141, 0, 0, 0.64576],
    "86": [0, 0.69141, 0, 0, 0.83131],
    "87": [0, 0.69141, 0, 0, 1.04602],
    "88": [0, 0.69141, 0, 0, 0.71922],
    "89": [0.18906, 0.69141, 0, 0, 0.83293],
    "90": [0.12604, 0.69141, 0, 0, 0.60201],
    "91": [0.24982, 0.74947, 0, 0, 0.27764],
    "93": [0.24982, 0.74947, 0, 0, 0.27764],
    "94": [0, 0.69141, 0, 0, 0.49965],
    "97": [0, 0.47534, 0, 0, 0.50046],
    "98": [0, 0.69141, 0, 0, 0.51315],
    "99": [0, 0.47534, 0, 0, 0.38946],
    "100": [0, 0.62119, 0, 0, 0.49857],
    "101": [0, 0.47534, 0, 0, 0.40053],
    "102": [0.18906, 0.69141, 0, 0, 0.32626],
    "103": [0.18906, 0.47534, 0, 0, 0.5037],
    "104": [0.18906, 0.69141, 0, 0, 0.52126],
    "105": [0, 0.69141, 0, 0, 0.27899],
    "106": [0, 0.69141, 0, 0, 0.28088],
    "107": [0, 0.69141, 0, 0, 0.38946],
    "108": [0, 0.69141, 0, 0, 0.27953],
    "109": [0, 0.47534, 0, 0, 0.76676],
    "110": [0, 0.47534, 0, 0, 0.52666],
    "111": [0, 0.47534, 0, 0, 0.48885],
    "112": [0.18906, 0.52396, 0, 0, 0.50046],
    "113": [0.18906, 0.47534, 0, 0, 0.48912],
    "114": [0, 0.47534, 0, 0, 0.38919],
    "115": [0, 0.47534, 0, 0, 0.44266],
    "116": [0, 0.62119, 0, 0, 0.33301],
    "117": [0, 0.47534, 0, 0, 0.5172],
    "118": [0, 0.52396, 0, 0, 0.5118],
    "119": [0, 0.52396, 0, 0, 0.77351],
    "120": [0.18906, 0.47534, 0, 0, 0.38865],
    "121": [0.18906, 0.47534, 0, 0, 0.49884],
    "122": [0.18906, 0.47534, 0, 0, 0.39054],
    "160": [0, 0, 0, 0, 0.25],
    "8216": [0, 0.69141, 0, 0, 0.21471],
    "8217": [0, 0.69141, 0, 0, 0.21471],
    "58112": [0, 0.62119, 0, 0, 0.49749],
    "58113": [0, 0.62119, 0, 0, 0.4983],
    "58114": [0.18906, 0.69141, 0, 0, 0.33328],
    "58115": [0.18906, 0.69141, 0, 0, 0.32923],
    "58116": [0.18906, 0.47534, 0, 0, 0.50343],
    "58117": [0, 0.69141, 0, 0, 0.33301],
    "58118": [0, 0.62119, 0, 0, 0.33409],
    "58119": [0, 0.47534, 0, 0, 0.50073]
  },
  "Main-Bold": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69444, 0, 0, 0.35],
    "34": [0, 0.69444, 0, 0, 0.60278],
    "35": [0.19444, 0.69444, 0, 0, 0.95833],
    "36": [0.05556, 0.75, 0, 0, 0.575],
    "37": [0.05556, 0.75, 0, 0, 0.95833],
    "38": [0, 0.69444, 0, 0, 0.89444],
    "39": [0, 0.69444, 0, 0, 0.31944],
    "40": [0.25, 0.75, 0, 0, 0.44722],
    "41": [0.25, 0.75, 0, 0, 0.44722],
    "42": [0, 0.75, 0, 0, 0.575],
    "43": [0.13333, 0.63333, 0, 0, 0.89444],
    "44": [0.19444, 0.15556, 0, 0, 0.31944],
    "45": [0, 0.44444, 0, 0, 0.38333],
    "46": [0, 0.15556, 0, 0, 0.31944],
    "47": [0.25, 0.75, 0, 0, 0.575],
    "48": [0, 0.64444, 0, 0, 0.575],
    "49": [0, 0.64444, 0, 0, 0.575],
    "50": [0, 0.64444, 0, 0, 0.575],
    "51": [0, 0.64444, 0, 0, 0.575],
    "52": [0, 0.64444, 0, 0, 0.575],
    "53": [0, 0.64444, 0, 0, 0.575],
    "54": [0, 0.64444, 0, 0, 0.575],
    "55": [0, 0.64444, 0, 0, 0.575],
    "56": [0, 0.64444, 0, 0, 0.575],
    "57": [0, 0.64444, 0, 0, 0.575],
    "58": [0, 0.44444, 0, 0, 0.31944],
    "59": [0.19444, 0.44444, 0, 0, 0.31944],
    "60": [0.08556, 0.58556, 0, 0, 0.89444],
    "61": [-0.10889, 0.39111, 0, 0, 0.89444],
    "62": [0.08556, 0.58556, 0, 0, 0.89444],
    "63": [0, 0.69444, 0, 0, 0.54305],
    "64": [0, 0.69444, 0, 0, 0.89444],
    "65": [0, 0.68611, 0, 0, 0.86944],
    "66": [0, 0.68611, 0, 0, 0.81805],
    "67": [0, 0.68611, 0, 0, 0.83055],
    "68": [0, 0.68611, 0, 0, 0.88194],
    "69": [0, 0.68611, 0, 0, 0.75555],
    "70": [0, 0.68611, 0, 0, 0.72361],
    "71": [0, 0.68611, 0, 0, 0.90416],
    "72": [0, 0.68611, 0, 0, 0.9],
    "73": [0, 0.68611, 0, 0, 0.43611],
    "74": [0, 0.68611, 0, 0, 0.59444],
    "75": [0, 0.68611, 0, 0, 0.90138],
    "76": [0, 0.68611, 0, 0, 0.69166],
    "77": [0, 0.68611, 0, 0, 1.09166],
    "78": [0, 0.68611, 0, 0, 0.9],
    "79": [0, 0.68611, 0, 0, 0.86388],
    "80": [0, 0.68611, 0, 0, 0.78611],
    "81": [0.19444, 0.68611, 0, 0, 0.86388],
    "82": [0, 0.68611, 0, 0, 0.8625],
    "83": [0, 0.68611, 0, 0, 0.63889],
    "84": [0, 0.68611, 0, 0, 0.8],
    "85": [0, 0.68611, 0, 0, 0.88472],
    "86": [0, 0.68611, 0.01597, 0, 0.86944],
    "87": [0, 0.68611, 0.01597, 0, 1.18888],
    "88": [0, 0.68611, 0, 0, 0.86944],
    "89": [0, 0.68611, 0.02875, 0, 0.86944],
    "90": [0, 0.68611, 0, 0, 0.70277],
    "91": [0.25, 0.75, 0, 0, 0.31944],
    "92": [0.25, 0.75, 0, 0, 0.575],
    "93": [0.25, 0.75, 0, 0, 0.31944],
    "94": [0, 0.69444, 0, 0, 0.575],
    "95": [0.31, 0.13444, 0.03194, 0, 0.575],
    "97": [0, 0.44444, 0, 0, 0.55902],
    "98": [0, 0.69444, 0, 0, 0.63889],
    "99": [0, 0.44444, 0, 0, 0.51111],
    "100": [0, 0.69444, 0, 0, 0.63889],
    "101": [0, 0.44444, 0, 0, 0.52708],
    "102": [0, 0.69444, 0.10903, 0, 0.35139],
    "103": [0.19444, 0.44444, 0.01597, 0, 0.575],
    "104": [0, 0.69444, 0, 0, 0.63889],
    "105": [0, 0.69444, 0, 0, 0.31944],
    "106": [0.19444, 0.69444, 0, 0, 0.35139],
    "107": [0, 0.69444, 0, 0, 0.60694],
    "108": [0, 0.69444, 0, 0, 0.31944],
    "109": [0, 0.44444, 0, 0, 0.95833],
    "110": [0, 0.44444, 0, 0, 0.63889],
    "111": [0, 0.44444, 0, 0, 0.575],
    "112": [0.19444, 0.44444, 0, 0, 0.63889],
    "113": [0.19444, 0.44444, 0, 0, 0.60694],
    "114": [0, 0.44444, 0, 0, 0.47361],
    "115": [0, 0.44444, 0, 0, 0.45361],
    "116": [0, 0.63492, 0, 0, 0.44722],
    "117": [0, 0.44444, 0, 0, 0.63889],
    "118": [0, 0.44444, 0.01597, 0, 0.60694],
    "119": [0, 0.44444, 0.01597, 0, 0.83055],
    "120": [0, 0.44444, 0, 0, 0.60694],
    "121": [0.19444, 0.44444, 0.01597, 0, 0.60694],
    "122": [0, 0.44444, 0, 0, 0.51111],
    "123": [0.25, 0.75, 0, 0, 0.575],
    "124": [0.25, 0.75, 0, 0, 0.31944],
    "125": [0.25, 0.75, 0, 0, 0.575],
    "126": [0.35, 0.34444, 0, 0, 0.575],
    "160": [0, 0, 0, 0, 0.25],
    "163": [0, 0.69444, 0, 0, 0.86853],
    "168": [0, 0.69444, 0, 0, 0.575],
    "172": [0, 0.44444, 0, 0, 0.76666],
    "176": [0, 0.69444, 0, 0, 0.86944],
    "177": [0.13333, 0.63333, 0, 0, 0.89444],
    "184": [0.17014, 0, 0, 0, 0.51111],
    "198": [0, 0.68611, 0, 0, 1.04166],
    "215": [0.13333, 0.63333, 0, 0, 0.89444],
    "216": [0.04861, 0.73472, 0, 0, 0.89444],
    "223": [0, 0.69444, 0, 0, 0.59722],
    "230": [0, 0.44444, 0, 0, 0.83055],
    "247": [0.13333, 0.63333, 0, 0, 0.89444],
    "248": [0.09722, 0.54167, 0, 0, 0.575],
    "305": [0, 0.44444, 0, 0, 0.31944],
    "338": [0, 0.68611, 0, 0, 1.16944],
    "339": [0, 0.44444, 0, 0, 0.89444],
    "567": [0.19444, 0.44444, 0, 0, 0.35139],
    "710": [0, 0.69444, 0, 0, 0.575],
    "711": [0, 0.63194, 0, 0, 0.575],
    "713": [0, 0.59611, 0, 0, 0.575],
    "714": [0, 0.69444, 0, 0, 0.575],
    "715": [0, 0.69444, 0, 0, 0.575],
    "728": [0, 0.69444, 0, 0, 0.575],
    "729": [0, 0.69444, 0, 0, 0.31944],
    "730": [0, 0.69444, 0, 0, 0.86944],
    "732": [0, 0.69444, 0, 0, 0.575],
    "733": [0, 0.69444, 0, 0, 0.575],
    "915": [0, 0.68611, 0, 0, 0.69166],
    "916": [0, 0.68611, 0, 0, 0.95833],
    "920": [0, 0.68611, 0, 0, 0.89444],
    "923": [0, 0.68611, 0, 0, 0.80555],
    "926": [0, 0.68611, 0, 0, 0.76666],
    "928": [0, 0.68611, 0, 0, 0.9],
    "931": [0, 0.68611, 0, 0, 0.83055],
    "933": [0, 0.68611, 0, 0, 0.89444],
    "934": [0, 0.68611, 0, 0, 0.83055],
    "936": [0, 0.68611, 0, 0, 0.89444],
    "937": [0, 0.68611, 0, 0, 0.83055],
    "8211": [0, 0.44444, 0.03194, 0, 0.575],
    "8212": [0, 0.44444, 0.03194, 0, 1.14999],
    "8216": [0, 0.69444, 0, 0, 0.31944],
    "8217": [0, 0.69444, 0, 0, 0.31944],
    "8220": [0, 0.69444, 0, 0, 0.60278],
    "8221": [0, 0.69444, 0, 0, 0.60278],
    "8224": [0.19444, 0.69444, 0, 0, 0.51111],
    "8225": [0.19444, 0.69444, 0, 0, 0.51111],
    "8242": [0, 0.55556, 0, 0, 0.34444],
    "8407": [0, 0.72444, 0.15486, 0, 0.575],
    "8463": [0, 0.69444, 0, 0, 0.66759],
    "8465": [0, 0.69444, 0, 0, 0.83055],
    "8467": [0, 0.69444, 0, 0, 0.47361],
    "8472": [0.19444, 0.44444, 0, 0, 0.74027],
    "8476": [0, 0.69444, 0, 0, 0.83055],
    "8501": [0, 0.69444, 0, 0, 0.70277],
    "8592": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8593": [0.19444, 0.69444, 0, 0, 0.575],
    "8594": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8595": [0.19444, 0.69444, 0, 0, 0.575],
    "8596": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8597": [0.25, 0.75, 0, 0, 0.575],
    "8598": [0.19444, 0.69444, 0, 0, 1.14999],
    "8599": [0.19444, 0.69444, 0, 0, 1.14999],
    "8600": [0.19444, 0.69444, 0, 0, 1.14999],
    "8601": [0.19444, 0.69444, 0, 0, 1.14999],
    "8636": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8637": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8640": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8641": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8656": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8657": [0.19444, 0.69444, 0, 0, 0.70277],
    "8658": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8659": [0.19444, 0.69444, 0, 0, 0.70277],
    "8660": [-0.10889, 0.39111, 0, 0, 1.14999],
    "8661": [0.25, 0.75, 0, 0, 0.70277],
    "8704": [0, 0.69444, 0, 0, 0.63889],
    "8706": [0, 0.69444, 0.06389, 0, 0.62847],
    "8707": [0, 0.69444, 0, 0, 0.63889],
    "8709": [0.05556, 0.75, 0, 0, 0.575],
    "8711": [0, 0.68611, 0, 0, 0.95833],
    "8712": [0.08556, 0.58556, 0, 0, 0.76666],
    "8715": [0.08556, 0.58556, 0, 0, 0.76666],
    "8722": [0.13333, 0.63333, 0, 0, 0.89444],
    "8723": [0.13333, 0.63333, 0, 0, 0.89444],
    "8725": [0.25, 0.75, 0, 0, 0.575],
    "8726": [0.25, 0.75, 0, 0, 0.575],
    "8727": [-0.02778, 0.47222, 0, 0, 0.575],
    "8728": [-0.02639, 0.47361, 0, 0, 0.575],
    "8729": [-0.02639, 0.47361, 0, 0, 0.575],
    "8730": [0.18, 0.82, 0, 0, 0.95833],
    "8733": [0, 0.44444, 0, 0, 0.89444],
    "8734": [0, 0.44444, 0, 0, 1.14999],
    "8736": [0, 0.69224, 0, 0, 0.72222],
    "8739": [0.25, 0.75, 0, 0, 0.31944],
    "8741": [0.25, 0.75, 0, 0, 0.575],
    "8743": [0, 0.55556, 0, 0, 0.76666],
    "8744": [0, 0.55556, 0, 0, 0.76666],
    "8745": [0, 0.55556, 0, 0, 0.76666],
    "8746": [0, 0.55556, 0, 0, 0.76666],
    "8747": [0.19444, 0.69444, 0.12778, 0, 0.56875],
    "8764": [-0.10889, 0.39111, 0, 0, 0.89444],
    "8768": [0.19444, 0.69444, 0, 0, 0.31944],
    "8771": [222e-5, 0.50222, 0, 0, 0.89444],
    "8773": [0.027, 0.638, 0, 0, 0.894],
    "8776": [0.02444, 0.52444, 0, 0, 0.89444],
    "8781": [222e-5, 0.50222, 0, 0, 0.89444],
    "8801": [222e-5, 0.50222, 0, 0, 0.89444],
    "8804": [0.19667, 0.69667, 0, 0, 0.89444],
    "8805": [0.19667, 0.69667, 0, 0, 0.89444],
    "8810": [0.08556, 0.58556, 0, 0, 1.14999],
    "8811": [0.08556, 0.58556, 0, 0, 1.14999],
    "8826": [0.08556, 0.58556, 0, 0, 0.89444],
    "8827": [0.08556, 0.58556, 0, 0, 0.89444],
    "8834": [0.08556, 0.58556, 0, 0, 0.89444],
    "8835": [0.08556, 0.58556, 0, 0, 0.89444],
    "8838": [0.19667, 0.69667, 0, 0, 0.89444],
    "8839": [0.19667, 0.69667, 0, 0, 0.89444],
    "8846": [0, 0.55556, 0, 0, 0.76666],
    "8849": [0.19667, 0.69667, 0, 0, 0.89444],
    "8850": [0.19667, 0.69667, 0, 0, 0.89444],
    "8851": [0, 0.55556, 0, 0, 0.76666],
    "8852": [0, 0.55556, 0, 0, 0.76666],
    "8853": [0.13333, 0.63333, 0, 0, 0.89444],
    "8854": [0.13333, 0.63333, 0, 0, 0.89444],
    "8855": [0.13333, 0.63333, 0, 0, 0.89444],
    "8856": [0.13333, 0.63333, 0, 0, 0.89444],
    "8857": [0.13333, 0.63333, 0, 0, 0.89444],
    "8866": [0, 0.69444, 0, 0, 0.70277],
    "8867": [0, 0.69444, 0, 0, 0.70277],
    "8868": [0, 0.69444, 0, 0, 0.89444],
    "8869": [0, 0.69444, 0, 0, 0.89444],
    "8900": [-0.02639, 0.47361, 0, 0, 0.575],
    "8901": [-0.02639, 0.47361, 0, 0, 0.31944],
    "8902": [-0.02778, 0.47222, 0, 0, 0.575],
    "8968": [0.25, 0.75, 0, 0, 0.51111],
    "8969": [0.25, 0.75, 0, 0, 0.51111],
    "8970": [0.25, 0.75, 0, 0, 0.51111],
    "8971": [0.25, 0.75, 0, 0, 0.51111],
    "8994": [-0.13889, 0.36111, 0, 0, 1.14999],
    "8995": [-0.13889, 0.36111, 0, 0, 1.14999],
    "9651": [0.19444, 0.69444, 0, 0, 1.02222],
    "9657": [-0.02778, 0.47222, 0, 0, 0.575],
    "9661": [0.19444, 0.69444, 0, 0, 1.02222],
    "9667": [-0.02778, 0.47222, 0, 0, 0.575],
    "9711": [0.19444, 0.69444, 0, 0, 1.14999],
    "9824": [0.12963, 0.69444, 0, 0, 0.89444],
    "9825": [0.12963, 0.69444, 0, 0, 0.89444],
    "9826": [0.12963, 0.69444, 0, 0, 0.89444],
    "9827": [0.12963, 0.69444, 0, 0, 0.89444],
    "9837": [0, 0.75, 0, 0, 0.44722],
    "9838": [0.19444, 0.69444, 0, 0, 0.44722],
    "9839": [0.19444, 0.69444, 0, 0, 0.44722],
    "10216": [0.25, 0.75, 0, 0, 0.44722],
    "10217": [0.25, 0.75, 0, 0, 0.44722],
    "10815": [0, 0.68611, 0, 0, 0.9],
    "10927": [0.19667, 0.69667, 0, 0, 0.89444],
    "10928": [0.19667, 0.69667, 0, 0, 0.89444],
    "57376": [0.19444, 0.69444, 0, 0, 0]
  },
  "Main-BoldItalic": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69444, 0.11417, 0, 0.38611],
    "34": [0, 0.69444, 0.07939, 0, 0.62055],
    "35": [0.19444, 0.69444, 0.06833, 0, 0.94444],
    "37": [0.05556, 0.75, 0.12861, 0, 0.94444],
    "38": [0, 0.69444, 0.08528, 0, 0.88555],
    "39": [0, 0.69444, 0.12945, 0, 0.35555],
    "40": [0.25, 0.75, 0.15806, 0, 0.47333],
    "41": [0.25, 0.75, 0.03306, 0, 0.47333],
    "42": [0, 0.75, 0.14333, 0, 0.59111],
    "43": [0.10333, 0.60333, 0.03306, 0, 0.88555],
    "44": [0.19444, 0.14722, 0, 0, 0.35555],
    "45": [0, 0.44444, 0.02611, 0, 0.41444],
    "46": [0, 0.14722, 0, 0, 0.35555],
    "47": [0.25, 0.75, 0.15806, 0, 0.59111],
    "48": [0, 0.64444, 0.13167, 0, 0.59111],
    "49": [0, 0.64444, 0.13167, 0, 0.59111],
    "50": [0, 0.64444, 0.13167, 0, 0.59111],
    "51": [0, 0.64444, 0.13167, 0, 0.59111],
    "52": [0.19444, 0.64444, 0.13167, 0, 0.59111],
    "53": [0, 0.64444, 0.13167, 0, 0.59111],
    "54": [0, 0.64444, 0.13167, 0, 0.59111],
    "55": [0.19444, 0.64444, 0.13167, 0, 0.59111],
    "56": [0, 0.64444, 0.13167, 0, 0.59111],
    "57": [0, 0.64444, 0.13167, 0, 0.59111],
    "58": [0, 0.44444, 0.06695, 0, 0.35555],
    "59": [0.19444, 0.44444, 0.06695, 0, 0.35555],
    "61": [-0.10889, 0.39111, 0.06833, 0, 0.88555],
    "63": [0, 0.69444, 0.11472, 0, 0.59111],
    "64": [0, 0.69444, 0.09208, 0, 0.88555],
    "65": [0, 0.68611, 0, 0, 0.86555],
    "66": [0, 0.68611, 0.0992, 0, 0.81666],
    "67": [0, 0.68611, 0.14208, 0, 0.82666],
    "68": [0, 0.68611, 0.09062, 0, 0.87555],
    "69": [0, 0.68611, 0.11431, 0, 0.75666],
    "70": [0, 0.68611, 0.12903, 0, 0.72722],
    "71": [0, 0.68611, 0.07347, 0, 0.89527],
    "72": [0, 0.68611, 0.17208, 0, 0.8961],
    "73": [0, 0.68611, 0.15681, 0, 0.47166],
    "74": [0, 0.68611, 0.145, 0, 0.61055],
    "75": [0, 0.68611, 0.14208, 0, 0.89499],
    "76": [0, 0.68611, 0, 0, 0.69777],
    "77": [0, 0.68611, 0.17208, 0, 1.07277],
    "78": [0, 0.68611, 0.17208, 0, 0.8961],
    "79": [0, 0.68611, 0.09062, 0, 0.85499],
    "80": [0, 0.68611, 0.0992, 0, 0.78721],
    "81": [0.19444, 0.68611, 0.09062, 0, 0.85499],
    "82": [0, 0.68611, 0.02559, 0, 0.85944],
    "83": [0, 0.68611, 0.11264, 0, 0.64999],
    "84": [0, 0.68611, 0.12903, 0, 0.7961],
    "85": [0, 0.68611, 0.17208, 0, 0.88083],
    "86": [0, 0.68611, 0.18625, 0, 0.86555],
    "87": [0, 0.68611, 0.18625, 0, 1.15999],
    "88": [0, 0.68611, 0.15681, 0, 0.86555],
    "89": [0, 0.68611, 0.19803, 0, 0.86555],
    "90": [0, 0.68611, 0.14208, 0, 0.70888],
    "91": [0.25, 0.75, 0.1875, 0, 0.35611],
    "93": [0.25, 0.75, 0.09972, 0, 0.35611],
    "94": [0, 0.69444, 0.06709, 0, 0.59111],
    "95": [0.31, 0.13444, 0.09811, 0, 0.59111],
    "97": [0, 0.44444, 0.09426, 0, 0.59111],
    "98": [0, 0.69444, 0.07861, 0, 0.53222],
    "99": [0, 0.44444, 0.05222, 0, 0.53222],
    "100": [0, 0.69444, 0.10861, 0, 0.59111],
    "101": [0, 0.44444, 0.085, 0, 0.53222],
    "102": [0.19444, 0.69444, 0.21778, 0, 0.4],
    "103": [0.19444, 0.44444, 0.105, 0, 0.53222],
    "104": [0, 0.69444, 0.09426, 0, 0.59111],
    "105": [0, 0.69326, 0.11387, 0, 0.35555],
    "106": [0.19444, 0.69326, 0.1672, 0, 0.35555],
    "107": [0, 0.69444, 0.11111, 0, 0.53222],
    "108": [0, 0.69444, 0.10861, 0, 0.29666],
    "109": [0, 0.44444, 0.09426, 0, 0.94444],
    "110": [0, 0.44444, 0.09426, 0, 0.64999],
    "111": [0, 0.44444, 0.07861, 0, 0.59111],
    "112": [0.19444, 0.44444, 0.07861, 0, 0.59111],
    "113": [0.19444, 0.44444, 0.105, 0, 0.53222],
    "114": [0, 0.44444, 0.11111, 0, 0.50167],
    "115": [0, 0.44444, 0.08167, 0, 0.48694],
    "116": [0, 0.63492, 0.09639, 0, 0.385],
    "117": [0, 0.44444, 0.09426, 0, 0.62055],
    "118": [0, 0.44444, 0.11111, 0, 0.53222],
    "119": [0, 0.44444, 0.11111, 0, 0.76777],
    "120": [0, 0.44444, 0.12583, 0, 0.56055],
    "121": [0.19444, 0.44444, 0.105, 0, 0.56166],
    "122": [0, 0.44444, 0.13889, 0, 0.49055],
    "126": [0.35, 0.34444, 0.11472, 0, 0.59111],
    "160": [0, 0, 0, 0, 0.25],
    "168": [0, 0.69444, 0.11473, 0, 0.59111],
    "176": [0, 0.69444, 0, 0, 0.94888],
    "184": [0.17014, 0, 0, 0, 0.53222],
    "198": [0, 0.68611, 0.11431, 0, 1.02277],
    "216": [0.04861, 0.73472, 0.09062, 0, 0.88555],
    "223": [0.19444, 0.69444, 0.09736, 0, 0.665],
    "230": [0, 0.44444, 0.085, 0, 0.82666],
    "248": [0.09722, 0.54167, 0.09458, 0, 0.59111],
    "305": [0, 0.44444, 0.09426, 0, 0.35555],
    "338": [0, 0.68611, 0.11431, 0, 1.14054],
    "339": [0, 0.44444, 0.085, 0, 0.82666],
    "567": [0.19444, 0.44444, 0.04611, 0, 0.385],
    "710": [0, 0.69444, 0.06709, 0, 0.59111],
    "711": [0, 0.63194, 0.08271, 0, 0.59111],
    "713": [0, 0.59444, 0.10444, 0, 0.59111],
    "714": [0, 0.69444, 0.08528, 0, 0.59111],
    "715": [0, 0.69444, 0, 0, 0.59111],
    "728": [0, 0.69444, 0.10333, 0, 0.59111],
    "729": [0, 0.69444, 0.12945, 0, 0.35555],
    "730": [0, 0.69444, 0, 0, 0.94888],
    "732": [0, 0.69444, 0.11472, 0, 0.59111],
    "733": [0, 0.69444, 0.11472, 0, 0.59111],
    "915": [0, 0.68611, 0.12903, 0, 0.69777],
    "916": [0, 0.68611, 0, 0, 0.94444],
    "920": [0, 0.68611, 0.09062, 0, 0.88555],
    "923": [0, 0.68611, 0, 0, 0.80666],
    "926": [0, 0.68611, 0.15092, 0, 0.76777],
    "928": [0, 0.68611, 0.17208, 0, 0.8961],
    "931": [0, 0.68611, 0.11431, 0, 0.82666],
    "933": [0, 0.68611, 0.10778, 0, 0.88555],
    "934": [0, 0.68611, 0.05632, 0, 0.82666],
    "936": [0, 0.68611, 0.10778, 0, 0.88555],
    "937": [0, 0.68611, 0.0992, 0, 0.82666],
    "8211": [0, 0.44444, 0.09811, 0, 0.59111],
    "8212": [0, 0.44444, 0.09811, 0, 1.18221],
    "8216": [0, 0.69444, 0.12945, 0, 0.35555],
    "8217": [0, 0.69444, 0.12945, 0, 0.35555],
    "8220": [0, 0.69444, 0.16772, 0, 0.62055],
    "8221": [0, 0.69444, 0.07939, 0, 0.62055]
  },
  "Main-Italic": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69444, 0.12417, 0, 0.30667],
    "34": [0, 0.69444, 0.06961, 0, 0.51444],
    "35": [0.19444, 0.69444, 0.06616, 0, 0.81777],
    "37": [0.05556, 0.75, 0.13639, 0, 0.81777],
    "38": [0, 0.69444, 0.09694, 0, 0.76666],
    "39": [0, 0.69444, 0.12417, 0, 0.30667],
    "40": [0.25, 0.75, 0.16194, 0, 0.40889],
    "41": [0.25, 0.75, 0.03694, 0, 0.40889],
    "42": [0, 0.75, 0.14917, 0, 0.51111],
    "43": [0.05667, 0.56167, 0.03694, 0, 0.76666],
    "44": [0.19444, 0.10556, 0, 0, 0.30667],
    "45": [0, 0.43056, 0.02826, 0, 0.35778],
    "46": [0, 0.10556, 0, 0, 0.30667],
    "47": [0.25, 0.75, 0.16194, 0, 0.51111],
    "48": [0, 0.64444, 0.13556, 0, 0.51111],
    "49": [0, 0.64444, 0.13556, 0, 0.51111],
    "50": [0, 0.64444, 0.13556, 0, 0.51111],
    "51": [0, 0.64444, 0.13556, 0, 0.51111],
    "52": [0.19444, 0.64444, 0.13556, 0, 0.51111],
    "53": [0, 0.64444, 0.13556, 0, 0.51111],
    "54": [0, 0.64444, 0.13556, 0, 0.51111],
    "55": [0.19444, 0.64444, 0.13556, 0, 0.51111],
    "56": [0, 0.64444, 0.13556, 0, 0.51111],
    "57": [0, 0.64444, 0.13556, 0, 0.51111],
    "58": [0, 0.43056, 0.0582, 0, 0.30667],
    "59": [0.19444, 0.43056, 0.0582, 0, 0.30667],
    "61": [-0.13313, 0.36687, 0.06616, 0, 0.76666],
    "63": [0, 0.69444, 0.1225, 0, 0.51111],
    "64": [0, 0.69444, 0.09597, 0, 0.76666],
    "65": [0, 0.68333, 0, 0, 0.74333],
    "66": [0, 0.68333, 0.10257, 0, 0.70389],
    "67": [0, 0.68333, 0.14528, 0, 0.71555],
    "68": [0, 0.68333, 0.09403, 0, 0.755],
    "69": [0, 0.68333, 0.12028, 0, 0.67833],
    "70": [0, 0.68333, 0.13305, 0, 0.65277],
    "71": [0, 0.68333, 0.08722, 0, 0.77361],
    "72": [0, 0.68333, 0.16389, 0, 0.74333],
    "73": [0, 0.68333, 0.15806, 0, 0.38555],
    "74": [0, 0.68333, 0.14028, 0, 0.525],
    "75": [0, 0.68333, 0.14528, 0, 0.76888],
    "76": [0, 0.68333, 0, 0, 0.62722],
    "77": [0, 0.68333, 0.16389, 0, 0.89666],
    "78": [0, 0.68333, 0.16389, 0, 0.74333],
    "79": [0, 0.68333, 0.09403, 0, 0.76666],
    "80": [0, 0.68333, 0.10257, 0, 0.67833],
    "81": [0.19444, 0.68333, 0.09403, 0, 0.76666],
    "82": [0, 0.68333, 0.03868, 0, 0.72944],
    "83": [0, 0.68333, 0.11972, 0, 0.56222],
    "84": [0, 0.68333, 0.13305, 0, 0.71555],
    "85": [0, 0.68333, 0.16389, 0, 0.74333],
    "86": [0, 0.68333, 0.18361, 0, 0.74333],
    "87": [0, 0.68333, 0.18361, 0, 0.99888],
    "88": [0, 0.68333, 0.15806, 0, 0.74333],
    "89": [0, 0.68333, 0.19383, 0, 0.74333],
    "90": [0, 0.68333, 0.14528, 0, 0.61333],
    "91": [0.25, 0.75, 0.1875, 0, 0.30667],
    "93": [0.25, 0.75, 0.10528, 0, 0.30667],
    "94": [0, 0.69444, 0.06646, 0, 0.51111],
    "95": [0.31, 0.12056, 0.09208, 0, 0.51111],
    "97": [0, 0.43056, 0.07671, 0, 0.51111],
    "98": [0, 0.69444, 0.06312, 0, 0.46],
    "99": [0, 0.43056, 0.05653, 0, 0.46],
    "100": [0, 0.69444, 0.10333, 0, 0.51111],
    "101": [0, 0.43056, 0.07514, 0, 0.46],
    "102": [0.19444, 0.69444, 0.21194, 0, 0.30667],
    "103": [0.19444, 0.43056, 0.08847, 0, 0.46],
    "104": [0, 0.69444, 0.07671, 0, 0.51111],
    "105": [0, 0.65536, 0.1019, 0, 0.30667],
    "106": [0.19444, 0.65536, 0.14467, 0, 0.30667],
    "107": [0, 0.69444, 0.10764, 0, 0.46],
    "108": [0, 0.69444, 0.10333, 0, 0.25555],
    "109": [0, 0.43056, 0.07671, 0, 0.81777],
    "110": [0, 0.43056, 0.07671, 0, 0.56222],
    "111": [0, 0.43056, 0.06312, 0, 0.51111],
    "112": [0.19444, 0.43056, 0.06312, 0, 0.51111],
    "113": [0.19444, 0.43056, 0.08847, 0, 0.46],
    "114": [0, 0.43056, 0.10764, 0, 0.42166],
    "115": [0, 0.43056, 0.08208, 0, 0.40889],
    "116": [0, 0.61508, 0.09486, 0, 0.33222],
    "117": [0, 0.43056, 0.07671, 0, 0.53666],
    "118": [0, 0.43056, 0.10764, 0, 0.46],
    "119": [0, 0.43056, 0.10764, 0, 0.66444],
    "120": [0, 0.43056, 0.12042, 0, 0.46389],
    "121": [0.19444, 0.43056, 0.08847, 0, 0.48555],
    "122": [0, 0.43056, 0.12292, 0, 0.40889],
    "126": [0.35, 0.31786, 0.11585, 0, 0.51111],
    "160": [0, 0, 0, 0, 0.25],
    "168": [0, 0.66786, 0.10474, 0, 0.51111],
    "176": [0, 0.69444, 0, 0, 0.83129],
    "184": [0.17014, 0, 0, 0, 0.46],
    "198": [0, 0.68333, 0.12028, 0, 0.88277],
    "216": [0.04861, 0.73194, 0.09403, 0, 0.76666],
    "223": [0.19444, 0.69444, 0.10514, 0, 0.53666],
    "230": [0, 0.43056, 0.07514, 0, 0.71555],
    "248": [0.09722, 0.52778, 0.09194, 0, 0.51111],
    "338": [0, 0.68333, 0.12028, 0, 0.98499],
    "339": [0, 0.43056, 0.07514, 0, 0.71555],
    "710": [0, 0.69444, 0.06646, 0, 0.51111],
    "711": [0, 0.62847, 0.08295, 0, 0.51111],
    "713": [0, 0.56167, 0.10333, 0, 0.51111],
    "714": [0, 0.69444, 0.09694, 0, 0.51111],
    "715": [0, 0.69444, 0, 0, 0.51111],
    "728": [0, 0.69444, 0.10806, 0, 0.51111],
    "729": [0, 0.66786, 0.11752, 0, 0.30667],
    "730": [0, 0.69444, 0, 0, 0.83129],
    "732": [0, 0.66786, 0.11585, 0, 0.51111],
    "733": [0, 0.69444, 0.1225, 0, 0.51111],
    "915": [0, 0.68333, 0.13305, 0, 0.62722],
    "916": [0, 0.68333, 0, 0, 0.81777],
    "920": [0, 0.68333, 0.09403, 0, 0.76666],
    "923": [0, 0.68333, 0, 0, 0.69222],
    "926": [0, 0.68333, 0.15294, 0, 0.66444],
    "928": [0, 0.68333, 0.16389, 0, 0.74333],
    "931": [0, 0.68333, 0.12028, 0, 0.71555],
    "933": [0, 0.68333, 0.11111, 0, 0.76666],
    "934": [0, 0.68333, 0.05986, 0, 0.71555],
    "936": [0, 0.68333, 0.11111, 0, 0.76666],
    "937": [0, 0.68333, 0.10257, 0, 0.71555],
    "8211": [0, 0.43056, 0.09208, 0, 0.51111],
    "8212": [0, 0.43056, 0.09208, 0, 1.02222],
    "8216": [0, 0.69444, 0.12417, 0, 0.30667],
    "8217": [0, 0.69444, 0.12417, 0, 0.30667],
    "8220": [0, 0.69444, 0.1685, 0, 0.51444],
    "8221": [0, 0.69444, 0.06961, 0, 0.51444],
    "8463": [0, 0.68889, 0, 0, 0.54028]
  },
  "Main-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69444, 0, 0, 0.27778],
    "34": [0, 0.69444, 0, 0, 0.5],
    "35": [0.19444, 0.69444, 0, 0, 0.83334],
    "36": [0.05556, 0.75, 0, 0, 0.5],
    "37": [0.05556, 0.75, 0, 0, 0.83334],
    "38": [0, 0.69444, 0, 0, 0.77778],
    "39": [0, 0.69444, 0, 0, 0.27778],
    "40": [0.25, 0.75, 0, 0, 0.38889],
    "41": [0.25, 0.75, 0, 0, 0.38889],
    "42": [0, 0.75, 0, 0, 0.5],
    "43": [0.08333, 0.58333, 0, 0, 0.77778],
    "44": [0.19444, 0.10556, 0, 0, 0.27778],
    "45": [0, 0.43056, 0, 0, 0.33333],
    "46": [0, 0.10556, 0, 0, 0.27778],
    "47": [0.25, 0.75, 0, 0, 0.5],
    "48": [0, 0.64444, 0, 0, 0.5],
    "49": [0, 0.64444, 0, 0, 0.5],
    "50": [0, 0.64444, 0, 0, 0.5],
    "51": [0, 0.64444, 0, 0, 0.5],
    "52": [0, 0.64444, 0, 0, 0.5],
    "53": [0, 0.64444, 0, 0, 0.5],
    "54": [0, 0.64444, 0, 0, 0.5],
    "55": [0, 0.64444, 0, 0, 0.5],
    "56": [0, 0.64444, 0, 0, 0.5],
    "57": [0, 0.64444, 0, 0, 0.5],
    "58": [0, 0.43056, 0, 0, 0.27778],
    "59": [0.19444, 0.43056, 0, 0, 0.27778],
    "60": [0.0391, 0.5391, 0, 0, 0.77778],
    "61": [-0.13313, 0.36687, 0, 0, 0.77778],
    "62": [0.0391, 0.5391, 0, 0, 0.77778],
    "63": [0, 0.69444, 0, 0, 0.47222],
    "64": [0, 0.69444, 0, 0, 0.77778],
    "65": [0, 0.68333, 0, 0, 0.75],
    "66": [0, 0.68333, 0, 0, 0.70834],
    "67": [0, 0.68333, 0, 0, 0.72222],
    "68": [0, 0.68333, 0, 0, 0.76389],
    "69": [0, 0.68333, 0, 0, 0.68056],
    "70": [0, 0.68333, 0, 0, 0.65278],
    "71": [0, 0.68333, 0, 0, 0.78472],
    "72": [0, 0.68333, 0, 0, 0.75],
    "73": [0, 0.68333, 0, 0, 0.36111],
    "74": [0, 0.68333, 0, 0, 0.51389],
    "75": [0, 0.68333, 0, 0, 0.77778],
    "76": [0, 0.68333, 0, 0, 0.625],
    "77": [0, 0.68333, 0, 0, 0.91667],
    "78": [0, 0.68333, 0, 0, 0.75],
    "79": [0, 0.68333, 0, 0, 0.77778],
    "80": [0, 0.68333, 0, 0, 0.68056],
    "81": [0.19444, 0.68333, 0, 0, 0.77778],
    "82": [0, 0.68333, 0, 0, 0.73611],
    "83": [0, 0.68333, 0, 0, 0.55556],
    "84": [0, 0.68333, 0, 0, 0.72222],
    "85": [0, 0.68333, 0, 0, 0.75],
    "86": [0, 0.68333, 0.01389, 0, 0.75],
    "87": [0, 0.68333, 0.01389, 0, 1.02778],
    "88": [0, 0.68333, 0, 0, 0.75],
    "89": [0, 0.68333, 0.025, 0, 0.75],
    "90": [0, 0.68333, 0, 0, 0.61111],
    "91": [0.25, 0.75, 0, 0, 0.27778],
    "92": [0.25, 0.75, 0, 0, 0.5],
    "93": [0.25, 0.75, 0, 0, 0.27778],
    "94": [0, 0.69444, 0, 0, 0.5],
    "95": [0.31, 0.12056, 0.02778, 0, 0.5],
    "97": [0, 0.43056, 0, 0, 0.5],
    "98": [0, 0.69444, 0, 0, 0.55556],
    "99": [0, 0.43056, 0, 0, 0.44445],
    "100": [0, 0.69444, 0, 0, 0.55556],
    "101": [0, 0.43056, 0, 0, 0.44445],
    "102": [0, 0.69444, 0.07778, 0, 0.30556],
    "103": [0.19444, 0.43056, 0.01389, 0, 0.5],
    "104": [0, 0.69444, 0, 0, 0.55556],
    "105": [0, 0.66786, 0, 0, 0.27778],
    "106": [0.19444, 0.66786, 0, 0, 0.30556],
    "107": [0, 0.69444, 0, 0, 0.52778],
    "108": [0, 0.69444, 0, 0, 0.27778],
    "109": [0, 0.43056, 0, 0, 0.83334],
    "110": [0, 0.43056, 0, 0, 0.55556],
    "111": [0, 0.43056, 0, 0, 0.5],
    "112": [0.19444, 0.43056, 0, 0, 0.55556],
    "113": [0.19444, 0.43056, 0, 0, 0.52778],
    "114": [0, 0.43056, 0, 0, 0.39167],
    "115": [0, 0.43056, 0, 0, 0.39445],
    "116": [0, 0.61508, 0, 0, 0.38889],
    "117": [0, 0.43056, 0, 0, 0.55556],
    "118": [0, 0.43056, 0.01389, 0, 0.52778],
    "119": [0, 0.43056, 0.01389, 0, 0.72222],
    "120": [0, 0.43056, 0, 0, 0.52778],
    "121": [0.19444, 0.43056, 0.01389, 0, 0.52778],
    "122": [0, 0.43056, 0, 0, 0.44445],
    "123": [0.25, 0.75, 0, 0, 0.5],
    "124": [0.25, 0.75, 0, 0, 0.27778],
    "125": [0.25, 0.75, 0, 0, 0.5],
    "126": [0.35, 0.31786, 0, 0, 0.5],
    "160": [0, 0, 0, 0, 0.25],
    "163": [0, 0.69444, 0, 0, 0.76909],
    "167": [0.19444, 0.69444, 0, 0, 0.44445],
    "168": [0, 0.66786, 0, 0, 0.5],
    "172": [0, 0.43056, 0, 0, 0.66667],
    "176": [0, 0.69444, 0, 0, 0.75],
    "177": [0.08333, 0.58333, 0, 0, 0.77778],
    "182": [0.19444, 0.69444, 0, 0, 0.61111],
    "184": [0.17014, 0, 0, 0, 0.44445],
    "198": [0, 0.68333, 0, 0, 0.90278],
    "215": [0.08333, 0.58333, 0, 0, 0.77778],
    "216": [0.04861, 0.73194, 0, 0, 0.77778],
    "223": [0, 0.69444, 0, 0, 0.5],
    "230": [0, 0.43056, 0, 0, 0.72222],
    "247": [0.08333, 0.58333, 0, 0, 0.77778],
    "248": [0.09722, 0.52778, 0, 0, 0.5],
    "305": [0, 0.43056, 0, 0, 0.27778],
    "338": [0, 0.68333, 0, 0, 1.01389],
    "339": [0, 0.43056, 0, 0, 0.77778],
    "567": [0.19444, 0.43056, 0, 0, 0.30556],
    "710": [0, 0.69444, 0, 0, 0.5],
    "711": [0, 0.62847, 0, 0, 0.5],
    "713": [0, 0.56778, 0, 0, 0.5],
    "714": [0, 0.69444, 0, 0, 0.5],
    "715": [0, 0.69444, 0, 0, 0.5],
    "728": [0, 0.69444, 0, 0, 0.5],
    "729": [0, 0.66786, 0, 0, 0.27778],
    "730": [0, 0.69444, 0, 0, 0.75],
    "732": [0, 0.66786, 0, 0, 0.5],
    "733": [0, 0.69444, 0, 0, 0.5],
    "915": [0, 0.68333, 0, 0, 0.625],
    "916": [0, 0.68333, 0, 0, 0.83334],
    "920": [0, 0.68333, 0, 0, 0.77778],
    "923": [0, 0.68333, 0, 0, 0.69445],
    "926": [0, 0.68333, 0, 0, 0.66667],
    "928": [0, 0.68333, 0, 0, 0.75],
    "931": [0, 0.68333, 0, 0, 0.72222],
    "933": [0, 0.68333, 0, 0, 0.77778],
    "934": [0, 0.68333, 0, 0, 0.72222],
    "936": [0, 0.68333, 0, 0, 0.77778],
    "937": [0, 0.68333, 0, 0, 0.72222],
    "8211": [0, 0.43056, 0.02778, 0, 0.5],
    "8212": [0, 0.43056, 0.02778, 0, 1],
    "8216": [0, 0.69444, 0, 0, 0.27778],
    "8217": [0, 0.69444, 0, 0, 0.27778],
    "8220": [0, 0.69444, 0, 0, 0.5],
    "8221": [0, 0.69444, 0, 0, 0.5],
    "8224": [0.19444, 0.69444, 0, 0, 0.44445],
    "8225": [0.19444, 0.69444, 0, 0, 0.44445],
    "8230": [0, 0.123, 0, 0, 1.172],
    "8242": [0, 0.55556, 0, 0, 0.275],
    "8407": [0, 0.71444, 0.15382, 0, 0.5],
    "8463": [0, 0.68889, 0, 0, 0.54028],
    "8465": [0, 0.69444, 0, 0, 0.72222],
    "8467": [0, 0.69444, 0, 0.11111, 0.41667],
    "8472": [0.19444, 0.43056, 0, 0.11111, 0.63646],
    "8476": [0, 0.69444, 0, 0, 0.72222],
    "8501": [0, 0.69444, 0, 0, 0.61111],
    "8592": [-0.13313, 0.36687, 0, 0, 1],
    "8593": [0.19444, 0.69444, 0, 0, 0.5],
    "8594": [-0.13313, 0.36687, 0, 0, 1],
    "8595": [0.19444, 0.69444, 0, 0, 0.5],
    "8596": [-0.13313, 0.36687, 0, 0, 1],
    "8597": [0.25, 0.75, 0, 0, 0.5],
    "8598": [0.19444, 0.69444, 0, 0, 1],
    "8599": [0.19444, 0.69444, 0, 0, 1],
    "8600": [0.19444, 0.69444, 0, 0, 1],
    "8601": [0.19444, 0.69444, 0, 0, 1],
    "8614": [0.011, 0.511, 0, 0, 1],
    "8617": [0.011, 0.511, 0, 0, 1.126],
    "8618": [0.011, 0.511, 0, 0, 1.126],
    "8636": [-0.13313, 0.36687, 0, 0, 1],
    "8637": [-0.13313, 0.36687, 0, 0, 1],
    "8640": [-0.13313, 0.36687, 0, 0, 1],
    "8641": [-0.13313, 0.36687, 0, 0, 1],
    "8652": [0.011, 0.671, 0, 0, 1],
    "8656": [-0.13313, 0.36687, 0, 0, 1],
    "8657": [0.19444, 0.69444, 0, 0, 0.61111],
    "8658": [-0.13313, 0.36687, 0, 0, 1],
    "8659": [0.19444, 0.69444, 0, 0, 0.61111],
    "8660": [-0.13313, 0.36687, 0, 0, 1],
    "8661": [0.25, 0.75, 0, 0, 0.61111],
    "8704": [0, 0.69444, 0, 0, 0.55556],
    "8706": [0, 0.69444, 0.05556, 0.08334, 0.5309],
    "8707": [0, 0.69444, 0, 0, 0.55556],
    "8709": [0.05556, 0.75, 0, 0, 0.5],
    "8711": [0, 0.68333, 0, 0, 0.83334],
    "8712": [0.0391, 0.5391, 0, 0, 0.66667],
    "8715": [0.0391, 0.5391, 0, 0, 0.66667],
    "8722": [0.08333, 0.58333, 0, 0, 0.77778],
    "8723": [0.08333, 0.58333, 0, 0, 0.77778],
    "8725": [0.25, 0.75, 0, 0, 0.5],
    "8726": [0.25, 0.75, 0, 0, 0.5],
    "8727": [-0.03472, 0.46528, 0, 0, 0.5],
    "8728": [-0.05555, 0.44445, 0, 0, 0.5],
    "8729": [-0.05555, 0.44445, 0, 0, 0.5],
    "8730": [0.2, 0.8, 0, 0, 0.83334],
    "8733": [0, 0.43056, 0, 0, 0.77778],
    "8734": [0, 0.43056, 0, 0, 1],
    "8736": [0, 0.69224, 0, 0, 0.72222],
    "8739": [0.25, 0.75, 0, 0, 0.27778],
    "8741": [0.25, 0.75, 0, 0, 0.5],
    "8743": [0, 0.55556, 0, 0, 0.66667],
    "8744": [0, 0.55556, 0, 0, 0.66667],
    "8745": [0, 0.55556, 0, 0, 0.66667],
    "8746": [0, 0.55556, 0, 0, 0.66667],
    "8747": [0.19444, 0.69444, 0.11111, 0, 0.41667],
    "8764": [-0.13313, 0.36687, 0, 0, 0.77778],
    "8768": [0.19444, 0.69444, 0, 0, 0.27778],
    "8771": [-0.03625, 0.46375, 0, 0, 0.77778],
    "8773": [-0.022, 0.589, 0, 0, 0.778],
    "8776": [-0.01688, 0.48312, 0, 0, 0.77778],
    "8781": [-0.03625, 0.46375, 0, 0, 0.77778],
    "8784": [-0.133, 0.673, 0, 0, 0.778],
    "8801": [-0.03625, 0.46375, 0, 0, 0.77778],
    "8804": [0.13597, 0.63597, 0, 0, 0.77778],
    "8805": [0.13597, 0.63597, 0, 0, 0.77778],
    "8810": [0.0391, 0.5391, 0, 0, 1],
    "8811": [0.0391, 0.5391, 0, 0, 1],
    "8826": [0.0391, 0.5391, 0, 0, 0.77778],
    "8827": [0.0391, 0.5391, 0, 0, 0.77778],
    "8834": [0.0391, 0.5391, 0, 0, 0.77778],
    "8835": [0.0391, 0.5391, 0, 0, 0.77778],
    "8838": [0.13597, 0.63597, 0, 0, 0.77778],
    "8839": [0.13597, 0.63597, 0, 0, 0.77778],
    "8846": [0, 0.55556, 0, 0, 0.66667],
    "8849": [0.13597, 0.63597, 0, 0, 0.77778],
    "8850": [0.13597, 0.63597, 0, 0, 0.77778],
    "8851": [0, 0.55556, 0, 0, 0.66667],
    "8852": [0, 0.55556, 0, 0, 0.66667],
    "8853": [0.08333, 0.58333, 0, 0, 0.77778],
    "8854": [0.08333, 0.58333, 0, 0, 0.77778],
    "8855": [0.08333, 0.58333, 0, 0, 0.77778],
    "8856": [0.08333, 0.58333, 0, 0, 0.77778],
    "8857": [0.08333, 0.58333, 0, 0, 0.77778],
    "8866": [0, 0.69444, 0, 0, 0.61111],
    "8867": [0, 0.69444, 0, 0, 0.61111],
    "8868": [0, 0.69444, 0, 0, 0.77778],
    "8869": [0, 0.69444, 0, 0, 0.77778],
    "8872": [0.249, 0.75, 0, 0, 0.867],
    "8900": [-0.05555, 0.44445, 0, 0, 0.5],
    "8901": [-0.05555, 0.44445, 0, 0, 0.27778],
    "8902": [-0.03472, 0.46528, 0, 0, 0.5],
    "8904": [5e-3, 0.505, 0, 0, 0.9],
    "8942": [0.03, 0.903, 0, 0, 0.278],
    "8943": [-0.19, 0.313, 0, 0, 1.172],
    "8945": [-0.1, 0.823, 0, 0, 1.282],
    "8968": [0.25, 0.75, 0, 0, 0.44445],
    "8969": [0.25, 0.75, 0, 0, 0.44445],
    "8970": [0.25, 0.75, 0, 0, 0.44445],
    "8971": [0.25, 0.75, 0, 0, 0.44445],
    "8994": [-0.14236, 0.35764, 0, 0, 1],
    "8995": [-0.14236, 0.35764, 0, 0, 1],
    "9136": [0.244, 0.744, 0, 0, 0.412],
    "9137": [0.244, 0.745, 0, 0, 0.412],
    "9651": [0.19444, 0.69444, 0, 0, 0.88889],
    "9657": [-0.03472, 0.46528, 0, 0, 0.5],
    "9661": [0.19444, 0.69444, 0, 0, 0.88889],
    "9667": [-0.03472, 0.46528, 0, 0, 0.5],
    "9711": [0.19444, 0.69444, 0, 0, 1],
    "9824": [0.12963, 0.69444, 0, 0, 0.77778],
    "9825": [0.12963, 0.69444, 0, 0, 0.77778],
    "9826": [0.12963, 0.69444, 0, 0, 0.77778],
    "9827": [0.12963, 0.69444, 0, 0, 0.77778],
    "9837": [0, 0.75, 0, 0, 0.38889],
    "9838": [0.19444, 0.69444, 0, 0, 0.38889],
    "9839": [0.19444, 0.69444, 0, 0, 0.38889],
    "10216": [0.25, 0.75, 0, 0, 0.38889],
    "10217": [0.25, 0.75, 0, 0, 0.38889],
    "10222": [0.244, 0.744, 0, 0, 0.412],
    "10223": [0.244, 0.745, 0, 0, 0.412],
    "10229": [0.011, 0.511, 0, 0, 1.609],
    "10230": [0.011, 0.511, 0, 0, 1.638],
    "10231": [0.011, 0.511, 0, 0, 1.859],
    "10232": [0.024, 0.525, 0, 0, 1.609],
    "10233": [0.024, 0.525, 0, 0, 1.638],
    "10234": [0.024, 0.525, 0, 0, 1.858],
    "10236": [0.011, 0.511, 0, 0, 1.638],
    "10815": [0, 0.68333, 0, 0, 0.75],
    "10927": [0.13597, 0.63597, 0, 0, 0.77778],
    "10928": [0.13597, 0.63597, 0, 0, 0.77778],
    "57376": [0.19444, 0.69444, 0, 0, 0]
  },
  "Math-BoldItalic": {
    "32": [0, 0, 0, 0, 0.25],
    "48": [0, 0.44444, 0, 0, 0.575],
    "49": [0, 0.44444, 0, 0, 0.575],
    "50": [0, 0.44444, 0, 0, 0.575],
    "51": [0.19444, 0.44444, 0, 0, 0.575],
    "52": [0.19444, 0.44444, 0, 0, 0.575],
    "53": [0.19444, 0.44444, 0, 0, 0.575],
    "54": [0, 0.64444, 0, 0, 0.575],
    "55": [0.19444, 0.44444, 0, 0, 0.575],
    "56": [0, 0.64444, 0, 0, 0.575],
    "57": [0.19444, 0.44444, 0, 0, 0.575],
    "65": [0, 0.68611, 0, 0, 0.86944],
    "66": [0, 0.68611, 0.04835, 0, 0.8664],
    "67": [0, 0.68611, 0.06979, 0, 0.81694],
    "68": [0, 0.68611, 0.03194, 0, 0.93812],
    "69": [0, 0.68611, 0.05451, 0, 0.81007],
    "70": [0, 0.68611, 0.15972, 0, 0.68889],
    "71": [0, 0.68611, 0, 0, 0.88673],
    "72": [0, 0.68611, 0.08229, 0, 0.98229],
    "73": [0, 0.68611, 0.07778, 0, 0.51111],
    "74": [0, 0.68611, 0.10069, 0, 0.63125],
    "75": [0, 0.68611, 0.06979, 0, 0.97118],
    "76": [0, 0.68611, 0, 0, 0.75555],
    "77": [0, 0.68611, 0.11424, 0, 1.14201],
    "78": [0, 0.68611, 0.11424, 0, 0.95034],
    "79": [0, 0.68611, 0.03194, 0, 0.83666],
    "80": [0, 0.68611, 0.15972, 0, 0.72309],
    "81": [0.19444, 0.68611, 0, 0, 0.86861],
    "82": [0, 0.68611, 421e-5, 0, 0.87235],
    "83": [0, 0.68611, 0.05382, 0, 0.69271],
    "84": [0, 0.68611, 0.15972, 0, 0.63663],
    "85": [0, 0.68611, 0.11424, 0, 0.80027],
    "86": [0, 0.68611, 0.25555, 0, 0.67778],
    "87": [0, 0.68611, 0.15972, 0, 1.09305],
    "88": [0, 0.68611, 0.07778, 0, 0.94722],
    "89": [0, 0.68611, 0.25555, 0, 0.67458],
    "90": [0, 0.68611, 0.06979, 0, 0.77257],
    "97": [0, 0.44444, 0, 0, 0.63287],
    "98": [0, 0.69444, 0, 0, 0.52083],
    "99": [0, 0.44444, 0, 0, 0.51342],
    "100": [0, 0.69444, 0, 0, 0.60972],
    "101": [0, 0.44444, 0, 0, 0.55361],
    "102": [0.19444, 0.69444, 0.11042, 0, 0.56806],
    "103": [0.19444, 0.44444, 0.03704, 0, 0.5449],
    "104": [0, 0.69444, 0, 0, 0.66759],
    "105": [0, 0.69326, 0, 0, 0.4048],
    "106": [0.19444, 0.69326, 0.0622, 0, 0.47083],
    "107": [0, 0.69444, 0.01852, 0, 0.6037],
    "108": [0, 0.69444, 88e-4, 0, 0.34815],
    "109": [0, 0.44444, 0, 0, 1.0324],
    "110": [0, 0.44444, 0, 0, 0.71296],
    "111": [0, 0.44444, 0, 0, 0.58472],
    "112": [0.19444, 0.44444, 0, 0, 0.60092],
    "113": [0.19444, 0.44444, 0.03704, 0, 0.54213],
    "114": [0, 0.44444, 0.03194, 0, 0.5287],
    "115": [0, 0.44444, 0, 0, 0.53125],
    "116": [0, 0.63492, 0, 0, 0.41528],
    "117": [0, 0.44444, 0, 0, 0.68102],
    "118": [0, 0.44444, 0.03704, 0, 0.56666],
    "119": [0, 0.44444, 0.02778, 0, 0.83148],
    "120": [0, 0.44444, 0, 0, 0.65903],
    "121": [0.19444, 0.44444, 0.03704, 0, 0.59028],
    "122": [0, 0.44444, 0.04213, 0, 0.55509],
    "160": [0, 0, 0, 0, 0.25],
    "915": [0, 0.68611, 0.15972, 0, 0.65694],
    "916": [0, 0.68611, 0, 0, 0.95833],
    "920": [0, 0.68611, 0.03194, 0, 0.86722],
    "923": [0, 0.68611, 0, 0, 0.80555],
    "926": [0, 0.68611, 0.07458, 0, 0.84125],
    "928": [0, 0.68611, 0.08229, 0, 0.98229],
    "931": [0, 0.68611, 0.05451, 0, 0.88507],
    "933": [0, 0.68611, 0.15972, 0, 0.67083],
    "934": [0, 0.68611, 0, 0, 0.76666],
    "936": [0, 0.68611, 0.11653, 0, 0.71402],
    "937": [0, 0.68611, 0.04835, 0, 0.8789],
    "945": [0, 0.44444, 0, 0, 0.76064],
    "946": [0.19444, 0.69444, 0.03403, 0, 0.65972],
    "947": [0.19444, 0.44444, 0.06389, 0, 0.59003],
    "948": [0, 0.69444, 0.03819, 0, 0.52222],
    "949": [0, 0.44444, 0, 0, 0.52882],
    "950": [0.19444, 0.69444, 0.06215, 0, 0.50833],
    "951": [0.19444, 0.44444, 0.03704, 0, 0.6],
    "952": [0, 0.69444, 0.03194, 0, 0.5618],
    "953": [0, 0.44444, 0, 0, 0.41204],
    "954": [0, 0.44444, 0, 0, 0.66759],
    "955": [0, 0.69444, 0, 0, 0.67083],
    "956": [0.19444, 0.44444, 0, 0, 0.70787],
    "957": [0, 0.44444, 0.06898, 0, 0.57685],
    "958": [0.19444, 0.69444, 0.03021, 0, 0.50833],
    "959": [0, 0.44444, 0, 0, 0.58472],
    "960": [0, 0.44444, 0.03704, 0, 0.68241],
    "961": [0.19444, 0.44444, 0, 0, 0.6118],
    "962": [0.09722, 0.44444, 0.07917, 0, 0.42361],
    "963": [0, 0.44444, 0.03704, 0, 0.68588],
    "964": [0, 0.44444, 0.13472, 0, 0.52083],
    "965": [0, 0.44444, 0.03704, 0, 0.63055],
    "966": [0.19444, 0.44444, 0, 0, 0.74722],
    "967": [0.19444, 0.44444, 0, 0, 0.71805],
    "968": [0.19444, 0.69444, 0.03704, 0, 0.75833],
    "969": [0, 0.44444, 0.03704, 0, 0.71782],
    "977": [0, 0.69444, 0, 0, 0.69155],
    "981": [0.19444, 0.69444, 0, 0, 0.7125],
    "982": [0, 0.44444, 0.03194, 0, 0.975],
    "1009": [0.19444, 0.44444, 0, 0, 0.6118],
    "1013": [0, 0.44444, 0, 0, 0.48333],
    "57649": [0, 0.44444, 0, 0, 0.39352],
    "57911": [0.19444, 0.44444, 0, 0, 0.43889]
  },
  "Math-Italic": {
    "32": [0, 0, 0, 0, 0.25],
    "48": [0, 0.43056, 0, 0, 0.5],
    "49": [0, 0.43056, 0, 0, 0.5],
    "50": [0, 0.43056, 0, 0, 0.5],
    "51": [0.19444, 0.43056, 0, 0, 0.5],
    "52": [0.19444, 0.43056, 0, 0, 0.5],
    "53": [0.19444, 0.43056, 0, 0, 0.5],
    "54": [0, 0.64444, 0, 0, 0.5],
    "55": [0.19444, 0.43056, 0, 0, 0.5],
    "56": [0, 0.64444, 0, 0, 0.5],
    "57": [0.19444, 0.43056, 0, 0, 0.5],
    "65": [0, 0.68333, 0, 0.13889, 0.75],
    "66": [0, 0.68333, 0.05017, 0.08334, 0.75851],
    "67": [0, 0.68333, 0.07153, 0.08334, 0.71472],
    "68": [0, 0.68333, 0.02778, 0.05556, 0.82792],
    "69": [0, 0.68333, 0.05764, 0.08334, 0.7382],
    "70": [0, 0.68333, 0.13889, 0.08334, 0.64306],
    "71": [0, 0.68333, 0, 0.08334, 0.78625],
    "72": [0, 0.68333, 0.08125, 0.05556, 0.83125],
    "73": [0, 0.68333, 0.07847, 0.11111, 0.43958],
    "74": [0, 0.68333, 0.09618, 0.16667, 0.55451],
    "75": [0, 0.68333, 0.07153, 0.05556, 0.84931],
    "76": [0, 0.68333, 0, 0.02778, 0.68056],
    "77": [0, 0.68333, 0.10903, 0.08334, 0.97014],
    "78": [0, 0.68333, 0.10903, 0.08334, 0.80347],
    "79": [0, 0.68333, 0.02778, 0.08334, 0.76278],
    "80": [0, 0.68333, 0.13889, 0.08334, 0.64201],
    "81": [0.19444, 0.68333, 0, 0.08334, 0.79056],
    "82": [0, 0.68333, 773e-5, 0.08334, 0.75929],
    "83": [0, 0.68333, 0.05764, 0.08334, 0.6132],
    "84": [0, 0.68333, 0.13889, 0.08334, 0.58438],
    "85": [0, 0.68333, 0.10903, 0.02778, 0.68278],
    "86": [0, 0.68333, 0.22222, 0, 0.58333],
    "87": [0, 0.68333, 0.13889, 0, 0.94445],
    "88": [0, 0.68333, 0.07847, 0.08334, 0.82847],
    "89": [0, 0.68333, 0.22222, 0, 0.58056],
    "90": [0, 0.68333, 0.07153, 0.08334, 0.68264],
    "97": [0, 0.43056, 0, 0, 0.52859],
    "98": [0, 0.69444, 0, 0, 0.42917],
    "99": [0, 0.43056, 0, 0.05556, 0.43276],
    "100": [0, 0.69444, 0, 0.16667, 0.52049],
    "101": [0, 0.43056, 0, 0.05556, 0.46563],
    "102": [0.19444, 0.69444, 0.10764, 0.16667, 0.48959],
    "103": [0.19444, 0.43056, 0.03588, 0.02778, 0.47697],
    "104": [0, 0.69444, 0, 0, 0.57616],
    "105": [0, 0.65952, 0, 0, 0.34451],
    "106": [0.19444, 0.65952, 0.05724, 0, 0.41181],
    "107": [0, 0.69444, 0.03148, 0, 0.5206],
    "108": [0, 0.69444, 0.01968, 0.08334, 0.29838],
    "109": [0, 0.43056, 0, 0, 0.87801],
    "110": [0, 0.43056, 0, 0, 0.60023],
    "111": [0, 0.43056, 0, 0.05556, 0.48472],
    "112": [0.19444, 0.43056, 0, 0.08334, 0.50313],
    "113": [0.19444, 0.43056, 0.03588, 0.08334, 0.44641],
    "114": [0, 0.43056, 0.02778, 0.05556, 0.45116],
    "115": [0, 0.43056, 0, 0.05556, 0.46875],
    "116": [0, 0.61508, 0, 0.08334, 0.36111],
    "117": [0, 0.43056, 0, 0.02778, 0.57246],
    "118": [0, 0.43056, 0.03588, 0.02778, 0.48472],
    "119": [0, 0.43056, 0.02691, 0.08334, 0.71592],
    "120": [0, 0.43056, 0, 0.02778, 0.57153],
    "121": [0.19444, 0.43056, 0.03588, 0.05556, 0.49028],
    "122": [0, 0.43056, 0.04398, 0.05556, 0.46505],
    "160": [0, 0, 0, 0, 0.25],
    "915": [0, 0.68333, 0.13889, 0.08334, 0.61528],
    "916": [0, 0.68333, 0, 0.16667, 0.83334],
    "920": [0, 0.68333, 0.02778, 0.08334, 0.76278],
    "923": [0, 0.68333, 0, 0.16667, 0.69445],
    "926": [0, 0.68333, 0.07569, 0.08334, 0.74236],
    "928": [0, 0.68333, 0.08125, 0.05556, 0.83125],
    "931": [0, 0.68333, 0.05764, 0.08334, 0.77986],
    "933": [0, 0.68333, 0.13889, 0.05556, 0.58333],
    "934": [0, 0.68333, 0, 0.08334, 0.66667],
    "936": [0, 0.68333, 0.11, 0.05556, 0.61222],
    "937": [0, 0.68333, 0.05017, 0.08334, 0.7724],
    "945": [0, 0.43056, 37e-4, 0.02778, 0.6397],
    "946": [0.19444, 0.69444, 0.05278, 0.08334, 0.56563],
    "947": [0.19444, 0.43056, 0.05556, 0, 0.51773],
    "948": [0, 0.69444, 0.03785, 0.05556, 0.44444],
    "949": [0, 0.43056, 0, 0.08334, 0.46632],
    "950": [0.19444, 0.69444, 0.07378, 0.08334, 0.4375],
    "951": [0.19444, 0.43056, 0.03588, 0.05556, 0.49653],
    "952": [0, 0.69444, 0.02778, 0.08334, 0.46944],
    "953": [0, 0.43056, 0, 0.05556, 0.35394],
    "954": [0, 0.43056, 0, 0, 0.57616],
    "955": [0, 0.69444, 0, 0, 0.58334],
    "956": [0.19444, 0.43056, 0, 0.02778, 0.60255],
    "957": [0, 0.43056, 0.06366, 0.02778, 0.49398],
    "958": [0.19444, 0.69444, 0.04601, 0.11111, 0.4375],
    "959": [0, 0.43056, 0, 0.05556, 0.48472],
    "960": [0, 0.43056, 0.03588, 0, 0.57003],
    "961": [0.19444, 0.43056, 0, 0.08334, 0.51702],
    "962": [0.09722, 0.43056, 0.07986, 0.08334, 0.36285],
    "963": [0, 0.43056, 0.03588, 0, 0.57141],
    "964": [0, 0.43056, 0.1132, 0.02778, 0.43715],
    "965": [0, 0.43056, 0.03588, 0.02778, 0.54028],
    "966": [0.19444, 0.43056, 0, 0.08334, 0.65417],
    "967": [0.19444, 0.43056, 0, 0.05556, 0.62569],
    "968": [0.19444, 0.69444, 0.03588, 0.11111, 0.65139],
    "969": [0, 0.43056, 0.03588, 0, 0.62245],
    "977": [0, 0.69444, 0, 0.08334, 0.59144],
    "981": [0.19444, 0.69444, 0, 0.08334, 0.59583],
    "982": [0, 0.43056, 0.02778, 0, 0.82813],
    "1009": [0.19444, 0.43056, 0, 0.08334, 0.51702],
    "1013": [0, 0.43056, 0, 0.05556, 0.4059],
    "57649": [0, 0.43056, 0, 0.02778, 0.32246],
    "57911": [0.19444, 0.43056, 0, 0.08334, 0.38403]
  },
  "SansSerif-Bold": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69444, 0, 0, 0.36667],
    "34": [0, 0.69444, 0, 0, 0.55834],
    "35": [0.19444, 0.69444, 0, 0, 0.91667],
    "36": [0.05556, 0.75, 0, 0, 0.55],
    "37": [0.05556, 0.75, 0, 0, 1.02912],
    "38": [0, 0.69444, 0, 0, 0.83056],
    "39": [0, 0.69444, 0, 0, 0.30556],
    "40": [0.25, 0.75, 0, 0, 0.42778],
    "41": [0.25, 0.75, 0, 0, 0.42778],
    "42": [0, 0.75, 0, 0, 0.55],
    "43": [0.11667, 0.61667, 0, 0, 0.85556],
    "44": [0.10556, 0.13056, 0, 0, 0.30556],
    "45": [0, 0.45833, 0, 0, 0.36667],
    "46": [0, 0.13056, 0, 0, 0.30556],
    "47": [0.25, 0.75, 0, 0, 0.55],
    "48": [0, 0.69444, 0, 0, 0.55],
    "49": [0, 0.69444, 0, 0, 0.55],
    "50": [0, 0.69444, 0, 0, 0.55],
    "51": [0, 0.69444, 0, 0, 0.55],
    "52": [0, 0.69444, 0, 0, 0.55],
    "53": [0, 0.69444, 0, 0, 0.55],
    "54": [0, 0.69444, 0, 0, 0.55],
    "55": [0, 0.69444, 0, 0, 0.55],
    "56": [0, 0.69444, 0, 0, 0.55],
    "57": [0, 0.69444, 0, 0, 0.55],
    "58": [0, 0.45833, 0, 0, 0.30556],
    "59": [0.10556, 0.45833, 0, 0, 0.30556],
    "61": [-0.09375, 0.40625, 0, 0, 0.85556],
    "63": [0, 0.69444, 0, 0, 0.51945],
    "64": [0, 0.69444, 0, 0, 0.73334],
    "65": [0, 0.69444, 0, 0, 0.73334],
    "66": [0, 0.69444, 0, 0, 0.73334],
    "67": [0, 0.69444, 0, 0, 0.70278],
    "68": [0, 0.69444, 0, 0, 0.79445],
    "69": [0, 0.69444, 0, 0, 0.64167],
    "70": [0, 0.69444, 0, 0, 0.61111],
    "71": [0, 0.69444, 0, 0, 0.73334],
    "72": [0, 0.69444, 0, 0, 0.79445],
    "73": [0, 0.69444, 0, 0, 0.33056],
    "74": [0, 0.69444, 0, 0, 0.51945],
    "75": [0, 0.69444, 0, 0, 0.76389],
    "76": [0, 0.69444, 0, 0, 0.58056],
    "77": [0, 0.69444, 0, 0, 0.97778],
    "78": [0, 0.69444, 0, 0, 0.79445],
    "79": [0, 0.69444, 0, 0, 0.79445],
    "80": [0, 0.69444, 0, 0, 0.70278],
    "81": [0.10556, 0.69444, 0, 0, 0.79445],
    "82": [0, 0.69444, 0, 0, 0.70278],
    "83": [0, 0.69444, 0, 0, 0.61111],
    "84": [0, 0.69444, 0, 0, 0.73334],
    "85": [0, 0.69444, 0, 0, 0.76389],
    "86": [0, 0.69444, 0.01528, 0, 0.73334],
    "87": [0, 0.69444, 0.01528, 0, 1.03889],
    "88": [0, 0.69444, 0, 0, 0.73334],
    "89": [0, 0.69444, 0.0275, 0, 0.73334],
    "90": [0, 0.69444, 0, 0, 0.67223],
    "91": [0.25, 0.75, 0, 0, 0.34306],
    "93": [0.25, 0.75, 0, 0, 0.34306],
    "94": [0, 0.69444, 0, 0, 0.55],
    "95": [0.35, 0.10833, 0.03056, 0, 0.55],
    "97": [0, 0.45833, 0, 0, 0.525],
    "98": [0, 0.69444, 0, 0, 0.56111],
    "99": [0, 0.45833, 0, 0, 0.48889],
    "100": [0, 0.69444, 0, 0, 0.56111],
    "101": [0, 0.45833, 0, 0, 0.51111],
    "102": [0, 0.69444, 0.07639, 0, 0.33611],
    "103": [0.19444, 0.45833, 0.01528, 0, 0.55],
    "104": [0, 0.69444, 0, 0, 0.56111],
    "105": [0, 0.69444, 0, 0, 0.25556],
    "106": [0.19444, 0.69444, 0, 0, 0.28611],
    "107": [0, 0.69444, 0, 0, 0.53056],
    "108": [0, 0.69444, 0, 0, 0.25556],
    "109": [0, 0.45833, 0, 0, 0.86667],
    "110": [0, 0.45833, 0, 0, 0.56111],
    "111": [0, 0.45833, 0, 0, 0.55],
    "112": [0.19444, 0.45833, 0, 0, 0.56111],
    "113": [0.19444, 0.45833, 0, 0, 0.56111],
    "114": [0, 0.45833, 0.01528, 0, 0.37222],
    "115": [0, 0.45833, 0, 0, 0.42167],
    "116": [0, 0.58929, 0, 0, 0.40417],
    "117": [0, 0.45833, 0, 0, 0.56111],
    "118": [0, 0.45833, 0.01528, 0, 0.5],
    "119": [0, 0.45833, 0.01528, 0, 0.74445],
    "120": [0, 0.45833, 0, 0, 0.5],
    "121": [0.19444, 0.45833, 0.01528, 0, 0.5],
    "122": [0, 0.45833, 0, 0, 0.47639],
    "126": [0.35, 0.34444, 0, 0, 0.55],
    "160": [0, 0, 0, 0, 0.25],
    "168": [0, 0.69444, 0, 0, 0.55],
    "176": [0, 0.69444, 0, 0, 0.73334],
    "180": [0, 0.69444, 0, 0, 0.55],
    "184": [0.17014, 0, 0, 0, 0.48889],
    "305": [0, 0.45833, 0, 0, 0.25556],
    "567": [0.19444, 0.45833, 0, 0, 0.28611],
    "710": [0, 0.69444, 0, 0, 0.55],
    "711": [0, 0.63542, 0, 0, 0.55],
    "713": [0, 0.63778, 0, 0, 0.55],
    "728": [0, 0.69444, 0, 0, 0.55],
    "729": [0, 0.69444, 0, 0, 0.30556],
    "730": [0, 0.69444, 0, 0, 0.73334],
    "732": [0, 0.69444, 0, 0, 0.55],
    "733": [0, 0.69444, 0, 0, 0.55],
    "915": [0, 0.69444, 0, 0, 0.58056],
    "916": [0, 0.69444, 0, 0, 0.91667],
    "920": [0, 0.69444, 0, 0, 0.85556],
    "923": [0, 0.69444, 0, 0, 0.67223],
    "926": [0, 0.69444, 0, 0, 0.73334],
    "928": [0, 0.69444, 0, 0, 0.79445],
    "931": [0, 0.69444, 0, 0, 0.79445],
    "933": [0, 0.69444, 0, 0, 0.85556],
    "934": [0, 0.69444, 0, 0, 0.79445],
    "936": [0, 0.69444, 0, 0, 0.85556],
    "937": [0, 0.69444, 0, 0, 0.79445],
    "8211": [0, 0.45833, 0.03056, 0, 0.55],
    "8212": [0, 0.45833, 0.03056, 0, 1.10001],
    "8216": [0, 0.69444, 0, 0, 0.30556],
    "8217": [0, 0.69444, 0, 0, 0.30556],
    "8220": [0, 0.69444, 0, 0, 0.55834],
    "8221": [0, 0.69444, 0, 0, 0.55834]
  },
  "SansSerif-Italic": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69444, 0.05733, 0, 0.31945],
    "34": [0, 0.69444, 316e-5, 0, 0.5],
    "35": [0.19444, 0.69444, 0.05087, 0, 0.83334],
    "36": [0.05556, 0.75, 0.11156, 0, 0.5],
    "37": [0.05556, 0.75, 0.03126, 0, 0.83334],
    "38": [0, 0.69444, 0.03058, 0, 0.75834],
    "39": [0, 0.69444, 0.07816, 0, 0.27778],
    "40": [0.25, 0.75, 0.13164, 0, 0.38889],
    "41": [0.25, 0.75, 0.02536, 0, 0.38889],
    "42": [0, 0.75, 0.11775, 0, 0.5],
    "43": [0.08333, 0.58333, 0.02536, 0, 0.77778],
    "44": [0.125, 0.08333, 0, 0, 0.27778],
    "45": [0, 0.44444, 0.01946, 0, 0.33333],
    "46": [0, 0.08333, 0, 0, 0.27778],
    "47": [0.25, 0.75, 0.13164, 0, 0.5],
    "48": [0, 0.65556, 0.11156, 0, 0.5],
    "49": [0, 0.65556, 0.11156, 0, 0.5],
    "50": [0, 0.65556, 0.11156, 0, 0.5],
    "51": [0, 0.65556, 0.11156, 0, 0.5],
    "52": [0, 0.65556, 0.11156, 0, 0.5],
    "53": [0, 0.65556, 0.11156, 0, 0.5],
    "54": [0, 0.65556, 0.11156, 0, 0.5],
    "55": [0, 0.65556, 0.11156, 0, 0.5],
    "56": [0, 0.65556, 0.11156, 0, 0.5],
    "57": [0, 0.65556, 0.11156, 0, 0.5],
    "58": [0, 0.44444, 0.02502, 0, 0.27778],
    "59": [0.125, 0.44444, 0.02502, 0, 0.27778],
    "61": [-0.13, 0.37, 0.05087, 0, 0.77778],
    "63": [0, 0.69444, 0.11809, 0, 0.47222],
    "64": [0, 0.69444, 0.07555, 0, 0.66667],
    "65": [0, 0.69444, 0, 0, 0.66667],
    "66": [0, 0.69444, 0.08293, 0, 0.66667],
    "67": [0, 0.69444, 0.11983, 0, 0.63889],
    "68": [0, 0.69444, 0.07555, 0, 0.72223],
    "69": [0, 0.69444, 0.11983, 0, 0.59722],
    "70": [0, 0.69444, 0.13372, 0, 0.56945],
    "71": [0, 0.69444, 0.11983, 0, 0.66667],
    "72": [0, 0.69444, 0.08094, 0, 0.70834],
    "73": [0, 0.69444, 0.13372, 0, 0.27778],
    "74": [0, 0.69444, 0.08094, 0, 0.47222],
    "75": [0, 0.69444, 0.11983, 0, 0.69445],
    "76": [0, 0.69444, 0, 0, 0.54167],
    "77": [0, 0.69444, 0.08094, 0, 0.875],
    "78": [0, 0.69444, 0.08094, 0, 0.70834],
    "79": [0, 0.69444, 0.07555, 0, 0.73611],
    "80": [0, 0.69444, 0.08293, 0, 0.63889],
    "81": [0.125, 0.69444, 0.07555, 0, 0.73611],
    "82": [0, 0.69444, 0.08293, 0, 0.64584],
    "83": [0, 0.69444, 0.09205, 0, 0.55556],
    "84": [0, 0.69444, 0.13372, 0, 0.68056],
    "85": [0, 0.69444, 0.08094, 0, 0.6875],
    "86": [0, 0.69444, 0.1615, 0, 0.66667],
    "87": [0, 0.69444, 0.1615, 0, 0.94445],
    "88": [0, 0.69444, 0.13372, 0, 0.66667],
    "89": [0, 0.69444, 0.17261, 0, 0.66667],
    "90": [0, 0.69444, 0.11983, 0, 0.61111],
    "91": [0.25, 0.75, 0.15942, 0, 0.28889],
    "93": [0.25, 0.75, 0.08719, 0, 0.28889],
    "94": [0, 0.69444, 0.0799, 0, 0.5],
    "95": [0.35, 0.09444, 0.08616, 0, 0.5],
    "97": [0, 0.44444, 981e-5, 0, 0.48056],
    "98": [0, 0.69444, 0.03057, 0, 0.51667],
    "99": [0, 0.44444, 0.08336, 0, 0.44445],
    "100": [0, 0.69444, 0.09483, 0, 0.51667],
    "101": [0, 0.44444, 0.06778, 0, 0.44445],
    "102": [0, 0.69444, 0.21705, 0, 0.30556],
    "103": [0.19444, 0.44444, 0.10836, 0, 0.5],
    "104": [0, 0.69444, 0.01778, 0, 0.51667],
    "105": [0, 0.67937, 0.09718, 0, 0.23889],
    "106": [0.19444, 0.67937, 0.09162, 0, 0.26667],
    "107": [0, 0.69444, 0.08336, 0, 0.48889],
    "108": [0, 0.69444, 0.09483, 0, 0.23889],
    "109": [0, 0.44444, 0.01778, 0, 0.79445],
    "110": [0, 0.44444, 0.01778, 0, 0.51667],
    "111": [0, 0.44444, 0.06613, 0, 0.5],
    "112": [0.19444, 0.44444, 0.0389, 0, 0.51667],
    "113": [0.19444, 0.44444, 0.04169, 0, 0.51667],
    "114": [0, 0.44444, 0.10836, 0, 0.34167],
    "115": [0, 0.44444, 0.0778, 0, 0.38333],
    "116": [0, 0.57143, 0.07225, 0, 0.36111],
    "117": [0, 0.44444, 0.04169, 0, 0.51667],
    "118": [0, 0.44444, 0.10836, 0, 0.46111],
    "119": [0, 0.44444, 0.10836, 0, 0.68334],
    "120": [0, 0.44444, 0.09169, 0, 0.46111],
    "121": [0.19444, 0.44444, 0.10836, 0, 0.46111],
    "122": [0, 0.44444, 0.08752, 0, 0.43472],
    "126": [0.35, 0.32659, 0.08826, 0, 0.5],
    "160": [0, 0, 0, 0, 0.25],
    "168": [0, 0.67937, 0.06385, 0, 0.5],
    "176": [0, 0.69444, 0, 0, 0.73752],
    "184": [0.17014, 0, 0, 0, 0.44445],
    "305": [0, 0.44444, 0.04169, 0, 0.23889],
    "567": [0.19444, 0.44444, 0.04169, 0, 0.26667],
    "710": [0, 0.69444, 0.0799, 0, 0.5],
    "711": [0, 0.63194, 0.08432, 0, 0.5],
    "713": [0, 0.60889, 0.08776, 0, 0.5],
    "714": [0, 0.69444, 0.09205, 0, 0.5],
    "715": [0, 0.69444, 0, 0, 0.5],
    "728": [0, 0.69444, 0.09483, 0, 0.5],
    "729": [0, 0.67937, 0.07774, 0, 0.27778],
    "730": [0, 0.69444, 0, 0, 0.73752],
    "732": [0, 0.67659, 0.08826, 0, 0.5],
    "733": [0, 0.69444, 0.09205, 0, 0.5],
    "915": [0, 0.69444, 0.13372, 0, 0.54167],
    "916": [0, 0.69444, 0, 0, 0.83334],
    "920": [0, 0.69444, 0.07555, 0, 0.77778],
    "923": [0, 0.69444, 0, 0, 0.61111],
    "926": [0, 0.69444, 0.12816, 0, 0.66667],
    "928": [0, 0.69444, 0.08094, 0, 0.70834],
    "931": [0, 0.69444, 0.11983, 0, 0.72222],
    "933": [0, 0.69444, 0.09031, 0, 0.77778],
    "934": [0, 0.69444, 0.04603, 0, 0.72222],
    "936": [0, 0.69444, 0.09031, 0, 0.77778],
    "937": [0, 0.69444, 0.08293, 0, 0.72222],
    "8211": [0, 0.44444, 0.08616, 0, 0.5],
    "8212": [0, 0.44444, 0.08616, 0, 1],
    "8216": [0, 0.69444, 0.07816, 0, 0.27778],
    "8217": [0, 0.69444, 0.07816, 0, 0.27778],
    "8220": [0, 0.69444, 0.14205, 0, 0.5],
    "8221": [0, 0.69444, 316e-5, 0, 0.5]
  },
  "SansSerif-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "33": [0, 0.69444, 0, 0, 0.31945],
    "34": [0, 0.69444, 0, 0, 0.5],
    "35": [0.19444, 0.69444, 0, 0, 0.83334],
    "36": [0.05556, 0.75, 0, 0, 0.5],
    "37": [0.05556, 0.75, 0, 0, 0.83334],
    "38": [0, 0.69444, 0, 0, 0.75834],
    "39": [0, 0.69444, 0, 0, 0.27778],
    "40": [0.25, 0.75, 0, 0, 0.38889],
    "41": [0.25, 0.75, 0, 0, 0.38889],
    "42": [0, 0.75, 0, 0, 0.5],
    "43": [0.08333, 0.58333, 0, 0, 0.77778],
    "44": [0.125, 0.08333, 0, 0, 0.27778],
    "45": [0, 0.44444, 0, 0, 0.33333],
    "46": [0, 0.08333, 0, 0, 0.27778],
    "47": [0.25, 0.75, 0, 0, 0.5],
    "48": [0, 0.65556, 0, 0, 0.5],
    "49": [0, 0.65556, 0, 0, 0.5],
    "50": [0, 0.65556, 0, 0, 0.5],
    "51": [0, 0.65556, 0, 0, 0.5],
    "52": [0, 0.65556, 0, 0, 0.5],
    "53": [0, 0.65556, 0, 0, 0.5],
    "54": [0, 0.65556, 0, 0, 0.5],
    "55": [0, 0.65556, 0, 0, 0.5],
    "56": [0, 0.65556, 0, 0, 0.5],
    "57": [0, 0.65556, 0, 0, 0.5],
    "58": [0, 0.44444, 0, 0, 0.27778],
    "59": [0.125, 0.44444, 0, 0, 0.27778],
    "61": [-0.13, 0.37, 0, 0, 0.77778],
    "63": [0, 0.69444, 0, 0, 0.47222],
    "64": [0, 0.69444, 0, 0, 0.66667],
    "65": [0, 0.69444, 0, 0, 0.66667],
    "66": [0, 0.69444, 0, 0, 0.66667],
    "67": [0, 0.69444, 0, 0, 0.63889],
    "68": [0, 0.69444, 0, 0, 0.72223],
    "69": [0, 0.69444, 0, 0, 0.59722],
    "70": [0, 0.69444, 0, 0, 0.56945],
    "71": [0, 0.69444, 0, 0, 0.66667],
    "72": [0, 0.69444, 0, 0, 0.70834],
    "73": [0, 0.69444, 0, 0, 0.27778],
    "74": [0, 0.69444, 0, 0, 0.47222],
    "75": [0, 0.69444, 0, 0, 0.69445],
    "76": [0, 0.69444, 0, 0, 0.54167],
    "77": [0, 0.69444, 0, 0, 0.875],
    "78": [0, 0.69444, 0, 0, 0.70834],
    "79": [0, 0.69444, 0, 0, 0.73611],
    "80": [0, 0.69444, 0, 0, 0.63889],
    "81": [0.125, 0.69444, 0, 0, 0.73611],
    "82": [0, 0.69444, 0, 0, 0.64584],
    "83": [0, 0.69444, 0, 0, 0.55556],
    "84": [0, 0.69444, 0, 0, 0.68056],
    "85": [0, 0.69444, 0, 0, 0.6875],
    "86": [0, 0.69444, 0.01389, 0, 0.66667],
    "87": [0, 0.69444, 0.01389, 0, 0.94445],
    "88": [0, 0.69444, 0, 0, 0.66667],
    "89": [0, 0.69444, 0.025, 0, 0.66667],
    "90": [0, 0.69444, 0, 0, 0.61111],
    "91": [0.25, 0.75, 0, 0, 0.28889],
    "93": [0.25, 0.75, 0, 0, 0.28889],
    "94": [0, 0.69444, 0, 0, 0.5],
    "95": [0.35, 0.09444, 0.02778, 0, 0.5],
    "97": [0, 0.44444, 0, 0, 0.48056],
    "98": [0, 0.69444, 0, 0, 0.51667],
    "99": [0, 0.44444, 0, 0, 0.44445],
    "100": [0, 0.69444, 0, 0, 0.51667],
    "101": [0, 0.44444, 0, 0, 0.44445],
    "102": [0, 0.69444, 0.06944, 0, 0.30556],
    "103": [0.19444, 0.44444, 0.01389, 0, 0.5],
    "104": [0, 0.69444, 0, 0, 0.51667],
    "105": [0, 0.67937, 0, 0, 0.23889],
    "106": [0.19444, 0.67937, 0, 0, 0.26667],
    "107": [0, 0.69444, 0, 0, 0.48889],
    "108": [0, 0.69444, 0, 0, 0.23889],
    "109": [0, 0.44444, 0, 0, 0.79445],
    "110": [0, 0.44444, 0, 0, 0.51667],
    "111": [0, 0.44444, 0, 0, 0.5],
    "112": [0.19444, 0.44444, 0, 0, 0.51667],
    "113": [0.19444, 0.44444, 0, 0, 0.51667],
    "114": [0, 0.44444, 0.01389, 0, 0.34167],
    "115": [0, 0.44444, 0, 0, 0.38333],
    "116": [0, 0.57143, 0, 0, 0.36111],
    "117": [0, 0.44444, 0, 0, 0.51667],
    "118": [0, 0.44444, 0.01389, 0, 0.46111],
    "119": [0, 0.44444, 0.01389, 0, 0.68334],
    "120": [0, 0.44444, 0, 0, 0.46111],
    "121": [0.19444, 0.44444, 0.01389, 0, 0.46111],
    "122": [0, 0.44444, 0, 0, 0.43472],
    "126": [0.35, 0.32659, 0, 0, 0.5],
    "160": [0, 0, 0, 0, 0.25],
    "168": [0, 0.67937, 0, 0, 0.5],
    "176": [0, 0.69444, 0, 0, 0.66667],
    "184": [0.17014, 0, 0, 0, 0.44445],
    "305": [0, 0.44444, 0, 0, 0.23889],
    "567": [0.19444, 0.44444, 0, 0, 0.26667],
    "710": [0, 0.69444, 0, 0, 0.5],
    "711": [0, 0.63194, 0, 0, 0.5],
    "713": [0, 0.60889, 0, 0, 0.5],
    "714": [0, 0.69444, 0, 0, 0.5],
    "715": [0, 0.69444, 0, 0, 0.5],
    "728": [0, 0.69444, 0, 0, 0.5],
    "729": [0, 0.67937, 0, 0, 0.27778],
    "730": [0, 0.69444, 0, 0, 0.66667],
    "732": [0, 0.67659, 0, 0, 0.5],
    "733": [0, 0.69444, 0, 0, 0.5],
    "915": [0, 0.69444, 0, 0, 0.54167],
    "916": [0, 0.69444, 0, 0, 0.83334],
    "920": [0, 0.69444, 0, 0, 0.77778],
    "923": [0, 0.69444, 0, 0, 0.61111],
    "926": [0, 0.69444, 0, 0, 0.66667],
    "928": [0, 0.69444, 0, 0, 0.70834],
    "931": [0, 0.69444, 0, 0, 0.72222],
    "933": [0, 0.69444, 0, 0, 0.77778],
    "934": [0, 0.69444, 0, 0, 0.72222],
    "936": [0, 0.69444, 0, 0, 0.77778],
    "937": [0, 0.69444, 0, 0, 0.72222],
    "8211": [0, 0.44444, 0.02778, 0, 0.5],
    "8212": [0, 0.44444, 0.02778, 0, 1],
    "8216": [0, 0.69444, 0, 0, 0.27778],
    "8217": [0, 0.69444, 0, 0, 0.27778],
    "8220": [0, 0.69444, 0, 0, 0.5],
    "8221": [0, 0.69444, 0, 0, 0.5]
  },
  "Script-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "65": [0, 0.7, 0.22925, 0, 0.80253],
    "66": [0, 0.7, 0.04087, 0, 0.90757],
    "67": [0, 0.7, 0.1689, 0, 0.66619],
    "68": [0, 0.7, 0.09371, 0, 0.77443],
    "69": [0, 0.7, 0.18583, 0, 0.56162],
    "70": [0, 0.7, 0.13634, 0, 0.89544],
    "71": [0, 0.7, 0.17322, 0, 0.60961],
    "72": [0, 0.7, 0.29694, 0, 0.96919],
    "73": [0, 0.7, 0.19189, 0, 0.80907],
    "74": [0.27778, 0.7, 0.19189, 0, 1.05159],
    "75": [0, 0.7, 0.31259, 0, 0.91364],
    "76": [0, 0.7, 0.19189, 0, 0.87373],
    "77": [0, 0.7, 0.15981, 0, 1.08031],
    "78": [0, 0.7, 0.3525, 0, 0.9015],
    "79": [0, 0.7, 0.08078, 0, 0.73787],
    "80": [0, 0.7, 0.08078, 0, 1.01262],
    "81": [0, 0.7, 0.03305, 0, 0.88282],
    "82": [0, 0.7, 0.06259, 0, 0.85],
    "83": [0, 0.7, 0.19189, 0, 0.86767],
    "84": [0, 0.7, 0.29087, 0, 0.74697],
    "85": [0, 0.7, 0.25815, 0, 0.79996],
    "86": [0, 0.7, 0.27523, 0, 0.62204],
    "87": [0, 0.7, 0.27523, 0, 0.80532],
    "88": [0, 0.7, 0.26006, 0, 0.94445],
    "89": [0, 0.7, 0.2939, 0, 0.70961],
    "90": [0, 0.7, 0.24037, 0, 0.8212],
    "160": [0, 0, 0, 0, 0.25]
  },
  "Size1-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "40": [0.35001, 0.85, 0, 0, 0.45834],
    "41": [0.35001, 0.85, 0, 0, 0.45834],
    "47": [0.35001, 0.85, 0, 0, 0.57778],
    "91": [0.35001, 0.85, 0, 0, 0.41667],
    "92": [0.35001, 0.85, 0, 0, 0.57778],
    "93": [0.35001, 0.85, 0, 0, 0.41667],
    "123": [0.35001, 0.85, 0, 0, 0.58334],
    "125": [0.35001, 0.85, 0, 0, 0.58334],
    "160": [0, 0, 0, 0, 0.25],
    "710": [0, 0.72222, 0, 0, 0.55556],
    "732": [0, 0.72222, 0, 0, 0.55556],
    "770": [0, 0.72222, 0, 0, 0.55556],
    "771": [0, 0.72222, 0, 0, 0.55556],
    "8214": [-99e-5, 0.601, 0, 0, 0.77778],
    "8593": [1e-5, 0.6, 0, 0, 0.66667],
    "8595": [1e-5, 0.6, 0, 0, 0.66667],
    "8657": [1e-5, 0.6, 0, 0, 0.77778],
    "8659": [1e-5, 0.6, 0, 0, 0.77778],
    "8719": [0.25001, 0.75, 0, 0, 0.94445],
    "8720": [0.25001, 0.75, 0, 0, 0.94445],
    "8721": [0.25001, 0.75, 0, 0, 1.05556],
    "8730": [0.35001, 0.85, 0, 0, 1],
    "8739": [-599e-5, 0.606, 0, 0, 0.33333],
    "8741": [-599e-5, 0.606, 0, 0, 0.55556],
    "8747": [0.30612, 0.805, 0.19445, 0, 0.47222],
    "8748": [0.306, 0.805, 0.19445, 0, 0.47222],
    "8749": [0.306, 0.805, 0.19445, 0, 0.47222],
    "8750": [0.30612, 0.805, 0.19445, 0, 0.47222],
    "8896": [0.25001, 0.75, 0, 0, 0.83334],
    "8897": [0.25001, 0.75, 0, 0, 0.83334],
    "8898": [0.25001, 0.75, 0, 0, 0.83334],
    "8899": [0.25001, 0.75, 0, 0, 0.83334],
    "8968": [0.35001, 0.85, 0, 0, 0.47222],
    "8969": [0.35001, 0.85, 0, 0, 0.47222],
    "8970": [0.35001, 0.85, 0, 0, 0.47222],
    "8971": [0.35001, 0.85, 0, 0, 0.47222],
    "9168": [-99e-5, 0.601, 0, 0, 0.66667],
    "10216": [0.35001, 0.85, 0, 0, 0.47222],
    "10217": [0.35001, 0.85, 0, 0, 0.47222],
    "10752": [0.25001, 0.75, 0, 0, 1.11111],
    "10753": [0.25001, 0.75, 0, 0, 1.11111],
    "10754": [0.25001, 0.75, 0, 0, 1.11111],
    "10756": [0.25001, 0.75, 0, 0, 0.83334],
    "10758": [0.25001, 0.75, 0, 0, 0.83334]
  },
  "Size2-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "40": [0.65002, 1.15, 0, 0, 0.59722],
    "41": [0.65002, 1.15, 0, 0, 0.59722],
    "47": [0.65002, 1.15, 0, 0, 0.81111],
    "91": [0.65002, 1.15, 0, 0, 0.47222],
    "92": [0.65002, 1.15, 0, 0, 0.81111],
    "93": [0.65002, 1.15, 0, 0, 0.47222],
    "123": [0.65002, 1.15, 0, 0, 0.66667],
    "125": [0.65002, 1.15, 0, 0, 0.66667],
    "160": [0, 0, 0, 0, 0.25],
    "710": [0, 0.75, 0, 0, 1],
    "732": [0, 0.75, 0, 0, 1],
    "770": [0, 0.75, 0, 0, 1],
    "771": [0, 0.75, 0, 0, 1],
    "8719": [0.55001, 1.05, 0, 0, 1.27778],
    "8720": [0.55001, 1.05, 0, 0, 1.27778],
    "8721": [0.55001, 1.05, 0, 0, 1.44445],
    "8730": [0.65002, 1.15, 0, 0, 1],
    "8747": [0.86225, 1.36, 0.44445, 0, 0.55556],
    "8748": [0.862, 1.36, 0.44445, 0, 0.55556],
    "8749": [0.862, 1.36, 0.44445, 0, 0.55556],
    "8750": [0.86225, 1.36, 0.44445, 0, 0.55556],
    "8896": [0.55001, 1.05, 0, 0, 1.11111],
    "8897": [0.55001, 1.05, 0, 0, 1.11111],
    "8898": [0.55001, 1.05, 0, 0, 1.11111],
    "8899": [0.55001, 1.05, 0, 0, 1.11111],
    "8968": [0.65002, 1.15, 0, 0, 0.52778],
    "8969": [0.65002, 1.15, 0, 0, 0.52778],
    "8970": [0.65002, 1.15, 0, 0, 0.52778],
    "8971": [0.65002, 1.15, 0, 0, 0.52778],
    "10216": [0.65002, 1.15, 0, 0, 0.61111],
    "10217": [0.65002, 1.15, 0, 0, 0.61111],
    "10752": [0.55001, 1.05, 0, 0, 1.51112],
    "10753": [0.55001, 1.05, 0, 0, 1.51112],
    "10754": [0.55001, 1.05, 0, 0, 1.51112],
    "10756": [0.55001, 1.05, 0, 0, 1.11111],
    "10758": [0.55001, 1.05, 0, 0, 1.11111]
  },
  "Size3-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "40": [0.95003, 1.45, 0, 0, 0.73611],
    "41": [0.95003, 1.45, 0, 0, 0.73611],
    "47": [0.95003, 1.45, 0, 0, 1.04445],
    "91": [0.95003, 1.45, 0, 0, 0.52778],
    "92": [0.95003, 1.45, 0, 0, 1.04445],
    "93": [0.95003, 1.45, 0, 0, 0.52778],
    "123": [0.95003, 1.45, 0, 0, 0.75],
    "125": [0.95003, 1.45, 0, 0, 0.75],
    "160": [0, 0, 0, 0, 0.25],
    "710": [0, 0.75, 0, 0, 1.44445],
    "732": [0, 0.75, 0, 0, 1.44445],
    "770": [0, 0.75, 0, 0, 1.44445],
    "771": [0, 0.75, 0, 0, 1.44445],
    "8730": [0.95003, 1.45, 0, 0, 1],
    "8968": [0.95003, 1.45, 0, 0, 0.58334],
    "8969": [0.95003, 1.45, 0, 0, 0.58334],
    "8970": [0.95003, 1.45, 0, 0, 0.58334],
    "8971": [0.95003, 1.45, 0, 0, 0.58334],
    "10216": [0.95003, 1.45, 0, 0, 0.75],
    "10217": [0.95003, 1.45, 0, 0, 0.75]
  },
  "Size4-Regular": {
    "32": [0, 0, 0, 0, 0.25],
    "40": [1.25003, 1.75, 0, 0, 0.79167],
    "41": [1.25003, 1.75, 0, 0, 0.79167],
    "47": [1.25003, 1.75, 0, 0, 1.27778],
    "91": [1.25003, 1.75, 0, 0, 0.58334],
    "92": [1.25003, 1.75, 0, 0, 1.27778],
    "93": [1.25003, 1.75, 0, 0, 0.58334],
    "123": [1.25003, 1.75, 0, 0, 0.80556],
    "125": [1.25003, 1.75, 0, 0, 0.80556],
    "160": [0, 0, 0, 0, 0.25],
    "710": [0, 0.825, 0, 0, 1.8889],
    "732": [0, 0.825, 0, 0, 1.8889],
    "770": [0, 0.825, 0, 0, 1.8889],
    "771": [0, 0.825, 0, 0, 1.8889],
    "8730": [1.25003, 1.75, 0, 0, 1],
    "8968": [1.25003, 1.75, 0, 0, 0.63889],
    "8969": [1.25003, 1.75, 0, 0, 0.63889],
    "8970": [1.25003, 1.75, 0, 0, 0.63889],
    "8971": [1.25003, 1.75, 0, 0, 0.63889],
    "9115": [0.64502, 1.155, 0, 0, 0.875],
    "9116": [1e-5, 0.6, 0, 0, 0.875],
    "9117": [0.64502, 1.155, 0, 0, 0.875],
    "9118": [0.64502, 1.155, 0, 0, 0.875],
    "9119": [1e-5, 0.6, 0, 0, 0.875],
    "9120": [0.64502, 1.155, 0, 0, 0.875],
    "9121": [0.64502, 1.155, 0, 0, 0.66667],
    "9122": [-99e-5, 0.601, 0, 0, 0.66667],
    "9123": [0.64502, 1.155, 0, 0, 0.66667],
    "9124": [0.64502, 1.155, 0, 0, 0.66667],
    "9125": [-99e-5, 0.601, 0, 0, 0.66667],
    "9126": [0.64502, 1.155, 0, 0, 0.66667],
    "9127": [1e-5, 0.9, 0, 0, 0.88889],
    "9128": [0.65002, 1.15, 0, 0, 0.88889],
    "9129": [0.90001, 0, 0, 0, 0.88889],
    "9130": [0, 0.3, 0, 0, 0.88889],
    "9131": [1e-5, 0.9, 0, 0, 0.88889],
    "9132": [0.65002, 1.15, 0, 0, 0.88889],
    "9133": [0.90001, 0, 0, 0, 0.88889],
    "9143": [0.88502, 0.915, 0, 0, 1.05556],
    "10216": [1.25003, 1.75, 0, 0, 0.80556],
    "10217": [1.25003, 1.75, 0, 0, 0.80556],
    "57344": [-499e-5, 0.605, 0, 0, 1.05556],
    "57345": [-499e-5, 0.605, 0, 0, 1.05556],
    "57680": [0, 0.12, 0, 0, 0.45],
    "57681": [0, 0.12, 0, 0, 0.45],
    "57682": [0, 0.12, 0, 0, 0.45],
    "57683": [0, 0.12, 0, 0, 0.45]
  },
  "Typewriter-Regular": {
    "32": [0, 0, 0, 0, 0.525],
    "33": [0, 0.61111, 0, 0, 0.525],
    "34": [0, 0.61111, 0, 0, 0.525],
    "35": [0, 0.61111, 0, 0, 0.525],
    "36": [0.08333, 0.69444, 0, 0, 0.525],
    "37": [0.08333, 0.69444, 0, 0, 0.525],
    "38": [0, 0.61111, 0, 0, 0.525],
    "39": [0, 0.61111, 0, 0, 0.525],
    "40": [0.08333, 0.69444, 0, 0, 0.525],
    "41": [0.08333, 0.69444, 0, 0, 0.525],
    "42": [0, 0.52083, 0, 0, 0.525],
    "43": [-0.08056, 0.53055, 0, 0, 0.525],
    "44": [0.13889, 0.125, 0, 0, 0.525],
    "45": [-0.08056, 0.53055, 0, 0, 0.525],
    "46": [0, 0.125, 0, 0, 0.525],
    "47": [0.08333, 0.69444, 0, 0, 0.525],
    "48": [0, 0.61111, 0, 0, 0.525],
    "49": [0, 0.61111, 0, 0, 0.525],
    "50": [0, 0.61111, 0, 0, 0.525],
    "51": [0, 0.61111, 0, 0, 0.525],
    "52": [0, 0.61111, 0, 0, 0.525],
    "53": [0, 0.61111, 0, 0, 0.525],
    "54": [0, 0.61111, 0, 0, 0.525],
    "55": [0, 0.61111, 0, 0, 0.525],
    "56": [0, 0.61111, 0, 0, 0.525],
    "57": [0, 0.61111, 0, 0, 0.525],
    "58": [0, 0.43056, 0, 0, 0.525],
    "59": [0.13889, 0.43056, 0, 0, 0.525],
    "60": [-0.05556, 0.55556, 0, 0, 0.525],
    "61": [-0.19549, 0.41562, 0, 0, 0.525],
    "62": [-0.05556, 0.55556, 0, 0, 0.525],
    "63": [0, 0.61111, 0, 0, 0.525],
    "64": [0, 0.61111, 0, 0, 0.525],
    "65": [0, 0.61111, 0, 0, 0.525],
    "66": [0, 0.61111, 0, 0, 0.525],
    "67": [0, 0.61111, 0, 0, 0.525],
    "68": [0, 0.61111, 0, 0, 0.525],
    "69": [0, 0.61111, 0, 0, 0.525],
    "70": [0, 0.61111, 0, 0, 0.525],
    "71": [0, 0.61111, 0, 0, 0.525],
    "72": [0, 0.61111, 0, 0, 0.525],
    "73": [0, 0.61111, 0, 0, 0.525],
    "74": [0, 0.61111, 0, 0, 0.525],
    "75": [0, 0.61111, 0, 0, 0.525],
    "76": [0, 0.61111, 0, 0, 0.525],
    "77": [0, 0.61111, 0, 0, 0.525],
    "78": [0, 0.61111, 0, 0, 0.525],
    "79": [0, 0.61111, 0, 0, 0.525],
    "80": [0, 0.61111, 0, 0, 0.525],
    "81": [0.13889, 0.61111, 0, 0, 0.525],
    "82": [0, 0.61111, 0, 0, 0.525],
    "83": [0, 0.61111, 0, 0, 0.525],
    "84": [0, 0.61111, 0, 0, 0.525],
    "85": [0, 0.61111, 0, 0, 0.525],
    "86": [0, 0.61111, 0, 0, 0.525],
    "87": [0, 0.61111, 0, 0, 0.525],
    "88": [0, 0.61111, 0, 0, 0.525],
    "89": [0, 0.61111, 0, 0, 0.525],
    "90": [0, 0.61111, 0, 0, 0.525],
    "91": [0.08333, 0.69444, 0, 0, 0.525],
    "92": [0.08333, 0.69444, 0, 0, 0.525],
    "93": [0.08333, 0.69444, 0, 0, 0.525],
    "94": [0, 0.61111, 0, 0, 0.525],
    "95": [0.09514, 0, 0, 0, 0.525],
    "96": [0, 0.61111, 0, 0, 0.525],
    "97": [0, 0.43056, 0, 0, 0.525],
    "98": [0, 0.61111, 0, 0, 0.525],
    "99": [0, 0.43056, 0, 0, 0.525],
    "100": [0, 0.61111, 0, 0, 0.525],
    "101": [0, 0.43056, 0, 0, 0.525],
    "102": [0, 0.61111, 0, 0, 0.525],
    "103": [0.22222, 0.43056, 0, 0, 0.525],
    "104": [0, 0.61111, 0, 0, 0.525],
    "105": [0, 0.61111, 0, 0, 0.525],
    "106": [0.22222, 0.61111, 0, 0, 0.525],
    "107": [0, 0.61111, 0, 0, 0.525],
    "108": [0, 0.61111, 0, 0, 0.525],
    "109": [0, 0.43056, 0, 0, 0.525],
    "110": [0, 0.43056, 0, 0, 0.525],
    "111": [0, 0.43056, 0, 0, 0.525],
    "112": [0.22222, 0.43056, 0, 0, 0.525],
    "113": [0.22222, 0.43056, 0, 0, 0.525],
    "114": [0, 0.43056, 0, 0, 0.525],
    "115": [0, 0.43056, 0, 0, 0.525],
    "116": [0, 0.55358, 0, 0, 0.525],
    "117": [0, 0.43056, 0, 0, 0.525],
    "118": [0, 0.43056, 0, 0, 0.525],
    "119": [0, 0.43056, 0, 0, 0.525],
    "120": [0, 0.43056, 0, 0, 0.525],
    "121": [0.22222, 0.43056, 0, 0, 0.525],
    "122": [0, 0.43056, 0, 0, 0.525],
    "123": [0.08333, 0.69444, 0, 0, 0.525],
    "124": [0.08333, 0.69444, 0, 0, 0.525],
    "125": [0.08333, 0.69444, 0, 0, 0.525],
    "126": [0, 0.61111, 0, 0, 0.525],
    "127": [0, 0.61111, 0, 0, 0.525],
    "160": [0, 0, 0, 0, 0.525],
    "176": [0, 0.61111, 0, 0, 0.525],
    "184": [0.19445, 0, 0, 0, 0.525],
    "305": [0, 0.43056, 0, 0, 0.525],
    "567": [0.22222, 0.43056, 0, 0, 0.525],
    "711": [0, 0.56597, 0, 0, 0.525],
    "713": [0, 0.56555, 0, 0, 0.525],
    "714": [0, 0.61111, 0, 0, 0.525],
    "715": [0, 0.61111, 0, 0, 0.525],
    "728": [0, 0.61111, 0, 0, 0.525],
    "730": [0, 0.61111, 0, 0, 0.525],
    "770": [0, 0.61111, 0, 0, 0.525],
    "771": [0, 0.61111, 0, 0, 0.525],
    "776": [0, 0.61111, 0, 0, 0.525],
    "915": [0, 0.61111, 0, 0, 0.525],
    "916": [0, 0.61111, 0, 0, 0.525],
    "920": [0, 0.61111, 0, 0, 0.525],
    "923": [0, 0.61111, 0, 0, 0.525],
    "926": [0, 0.61111, 0, 0, 0.525],
    "928": [0, 0.61111, 0, 0, 0.525],
    "931": [0, 0.61111, 0, 0, 0.525],
    "933": [0, 0.61111, 0, 0, 0.525],
    "934": [0, 0.61111, 0, 0, 0.525],
    "936": [0, 0.61111, 0, 0, 0.525],
    "937": [0, 0.61111, 0, 0, 0.525],
    "8216": [0, 0.61111, 0, 0, 0.525],
    "8217": [0, 0.61111, 0, 0, 0.525],
    "8242": [0, 0.61111, 0, 0, 0.525],
    "9251": [0.11111, 0.21944, 0, 0, 0.525]
  }
};
var sigmasAndXis = {
  slant: [0.25, 0.25, 0.25],
  // sigma1
  space: [0, 0, 0],
  // sigma2
  stretch: [0, 0, 0],
  // sigma3
  shrink: [0, 0, 0],
  // sigma4
  xHeight: [0.431, 0.431, 0.431],
  // sigma5
  quad: [1, 1.171, 1.472],
  // sigma6
  extraSpace: [0, 0, 0],
  // sigma7
  num1: [0.677, 0.732, 0.925],
  // sigma8
  num2: [0.394, 0.384, 0.387],
  // sigma9
  num3: [0.444, 0.471, 0.504],
  // sigma10
  denom1: [0.686, 0.752, 1.025],
  // sigma11
  denom2: [0.345, 0.344, 0.532],
  // sigma12
  sup1: [0.413, 0.503, 0.504],
  // sigma13
  sup2: [0.363, 0.431, 0.404],
  // sigma14
  sup3: [0.289, 0.286, 0.294],
  // sigma15
  sub1: [0.15, 0.143, 0.2],
  // sigma16
  sub2: [0.247, 0.286, 0.4],
  // sigma17
  supDrop: [0.386, 0.353, 0.494],
  // sigma18
  subDrop: [0.05, 0.071, 0.1],
  // sigma19
  delim1: [2.39, 1.7, 1.98],
  // sigma20
  delim2: [1.01, 1.157, 1.42],
  // sigma21
  axisHeight: [0.25, 0.25, 0.25],
  // sigma22
  // These font metrics are extracted from TeX by using tftopl on cmex10.tfm;
  // they correspond to the font parameters of the extension fonts (family 3).
  // See the TeXbook, page 441. In AMSTeX, the extension fonts scale; to
  // match cmex7, we'd use cmex7.tfm values for script and scriptscript
  // values.
  defaultRuleThickness: [0.04, 0.049, 0.049],
  // xi8; cmex7: 0.049
  bigOpSpacing1: [0.111, 0.111, 0.111],
  // xi9
  bigOpSpacing2: [0.166, 0.166, 0.166],
  // xi10
  bigOpSpacing3: [0.2, 0.2, 0.2],
  // xi11
  bigOpSpacing4: [0.6, 0.611, 0.611],
  // xi12; cmex7: 0.611
  bigOpSpacing5: [0.1, 0.143, 0.143],
  // xi13; cmex7: 0.143
  // The \sqrt rule width is taken from the height of the surd character.
  // Since we use the same font at all sizes, this thickness doesn't scale.
  sqrtRuleThickness: [0.04, 0.04, 0.04],
  // This value determines how large a pt is, for metrics which are defined
  // in terms of pts.
  // This value is also used in katex.scss; if you change it make sure the
  // values match.
  ptPerEm: [10, 10, 10],
  // The space between adjacent `|` columns in an array definition. From
  // `\showthe\doublerulesep` in LaTeX. Equals 2.0 / ptPerEm.
  doubleRuleSep: [0.2, 0.2, 0.2],
  // The width of separator lines in {array} environments. From
  // `\showthe\arrayrulewidth` in LaTeX. Equals 0.4 / ptPerEm.
  arrayRuleWidth: [0.04, 0.04, 0.04],
  // Two values from LaTeX source2e:
  fboxsep: [0.3, 0.3, 0.3],
  //        3 pt / ptPerEm
  fboxrule: [0.04, 0.04, 0.04]
  // 0.4 pt / ptPerEm
};
var extraCharacterMap = {
  // Latin-1
  "\xC5": "A",
  "\xD0": "D",
  "\xDE": "o",
  "\xE5": "a",
  "\xF0": "d",
  "\xFE": "o",
  // Cyrillic
  "\u0410": "A",
  "\u0411": "B",
  "\u0412": "B",
  "\u0413": "F",
  "\u0414": "A",
  "\u0415": "E",
  "\u0416": "K",
  "\u0417": "3",
  "\u0418": "N",
  "\u0419": "N",
  "\u041A": "K",
  "\u041B": "N",
  "\u041C": "M",
  "\u041D": "H",
  "\u041E": "O",
  "\u041F": "N",
  "\u0420": "P",
  "\u0421": "C",
  "\u0422": "T",
  "\u0423": "y",
  "\u0424": "O",
  "\u0425": "X",
  "\u0426": "U",
  "\u0427": "h",
  "\u0428": "W",
  "\u0429": "W",
  "\u042A": "B",
  "\u042B": "X",
  "\u042C": "B",
  "\u042D": "3",
  "\u042E": "X",
  "\u042F": "R",
  "\u0430": "a",
  "\u0431": "b",
  "\u0432": "a",
  "\u0433": "r",
  "\u0434": "y",
  "\u0435": "e",
  "\u0436": "m",
  "\u0437": "e",
  "\u0438": "n",
  "\u0439": "n",
  "\u043A": "n",
  "\u043B": "n",
  "\u043C": "m",
  "\u043D": "n",
  "\u043E": "o",
  "\u043F": "n",
  "\u0440": "p",
  "\u0441": "c",
  "\u0442": "o",
  "\u0443": "y",
  "\u0444": "b",
  "\u0445": "x",
  "\u0446": "n",
  "\u0447": "n",
  "\u0448": "w",
  "\u0449": "w",
  "\u044A": "a",
  "\u044B": "m",
  "\u044C": "a",
  "\u044D": "e",
  "\u044E": "m",
  "\u044F": "r"
};
function getCharacterMetrics(character, font, mode) {
  if (!fontMetricsData[font]) {
    throw new Error("Font metrics not found for font: " + font + ".");
  }
  var ch2 = character.charCodeAt(0);
  var metrics = fontMetricsData[font][ch2];
  if (!metrics && character[0] in extraCharacterMap) {
    ch2 = extraCharacterMap[character[0]].charCodeAt(0);
    metrics = fontMetricsData[font][ch2];
  }
  if (!metrics && mode === "text") {
    if (supportedCodepoint(ch2)) {
      metrics = fontMetricsData[font][77];
    }
  }
  if (metrics) {
    return {
      depth: metrics[0],
      height: metrics[1],
      italic: metrics[2],
      skew: metrics[3],
      width: metrics[4]
    };
  }
}
var fontMetricsBySizeIndex = {};
function getGlobalMetrics(size) {
  var sizeIndex;
  if (size >= 5) {
    sizeIndex = 0;
  } else if (size >= 3) {
    sizeIndex = 1;
  } else {
    sizeIndex = 2;
  }
  if (!fontMetricsBySizeIndex[sizeIndex]) {
    var metrics = fontMetricsBySizeIndex[sizeIndex] = {
      cssEmPerMu: sigmasAndXis.quad[sizeIndex] / 18
    };
    for (var key in sigmasAndXis) {
      if (sigmasAndXis.hasOwnProperty(key)) {
        metrics[key] = sigmasAndXis[key][sizeIndex];
      }
    }
  }
  return fontMetricsBySizeIndex[sizeIndex];
}
var sizeStyleMap = [
  // Each element contains [textsize, scriptsize, scriptscriptsize].
  // The size mappings are taken from TeX with \normalsize=10pt.
  [1, 1, 1],
  // size1: [5, 5, 5]              \tiny
  [2, 1, 1],
  // size2: [6, 5, 5]
  [3, 1, 1],
  // size3: [7, 5, 5]              \scriptsize
  [4, 2, 1],
  // size4: [8, 6, 5]              \footnotesize
  [5, 2, 1],
  // size5: [9, 6, 5]              \small
  [6, 3, 1],
  // size6: [10, 7, 5]             \normalsize
  [7, 4, 2],
  // size7: [12, 8, 6]             \large
  [8, 6, 3],
  // size8: [14.4, 10, 7]          \Large
  [9, 7, 6],
  // size9: [17.28, 12, 10]        \LARGE
  [10, 8, 7],
  // size10: [20.74, 14.4, 12]     \huge
  [11, 10, 9]
  // size11: [24.88, 20.74, 17.28] \HUGE
];
var sizeMultipliers = [
  // fontMetrics.js:getGlobalMetrics also uses size indexes, so if
  // you change size indexes, change that function.
  0.5,
  0.6,
  0.7,
  0.8,
  0.9,
  1,
  1.2,
  1.44,
  1.728,
  2.074,
  2.488
];
var sizeAtStyle = function sizeAtStyle2(size, style) {
  return style.size < 2 ? size : sizeStyleMap[size - 1][style.size - 1];
};
var Options = class _Options {
  // A font family applies to a group of fonts (i.e. SansSerif), while a font
  // represents a specific font (i.e. SansSerif Bold).
  // See: https://tex.stackexchange.com/questions/22350/difference-between-textrm-and-mathrm
  /**
   * The base size index.
   */
  constructor(data) {
    this.style = void 0;
    this.color = void 0;
    this.size = void 0;
    this.textSize = void 0;
    this.phantom = void 0;
    this.font = void 0;
    this.fontFamily = void 0;
    this.fontWeight = void 0;
    this.fontShape = void 0;
    this.sizeMultiplier = void 0;
    this.maxSize = void 0;
    this.minRuleThickness = void 0;
    this._fontMetrics = void 0;
    this.style = data.style;
    this.color = data.color;
    this.size = data.size || _Options.BASESIZE;
    this.textSize = data.textSize || this.size;
    this.phantom = !!data.phantom;
    this.font = data.font || "";
    this.fontFamily = data.fontFamily || "";
    this.fontWeight = data.fontWeight || "";
    this.fontShape = data.fontShape || "";
    this.sizeMultiplier = sizeMultipliers[this.size - 1];
    this.maxSize = data.maxSize;
    this.minRuleThickness = data.minRuleThickness;
    this._fontMetrics = void 0;
  }
  /**
   * Returns a new options object with the same properties as "this".  Properties
   * from "extension" will be copied to the new options object.
   */
  extend(extension) {
    var data = {
      style: this.style,
      size: this.size,
      textSize: this.textSize,
      color: this.color,
      phantom: this.phantom,
      font: this.font,
      fontFamily: this.fontFamily,
      fontWeight: this.fontWeight,
      fontShape: this.fontShape,
      maxSize: this.maxSize,
      minRuleThickness: this.minRuleThickness
    };
    for (var key in extension) {
      if (extension.hasOwnProperty(key)) {
        data[key] = extension[key];
      }
    }
    return new _Options(data);
  }
  /**
   * Return an options object with the given style. If `this.style === style`,
   * returns `this`.
   */
  havingStyle(style) {
    if (this.style === style) {
      return this;
    } else {
      return this.extend({
        style,
        size: sizeAtStyle(this.textSize, style)
      });
    }
  }
  /**
   * Return an options object with a cramped version of the current style. If
   * the current style is cramped, returns `this`.
   */
  havingCrampedStyle() {
    return this.havingStyle(this.style.cramp());
  }
  /**
   * Return an options object with the given size and in at least `\textstyle`.
   * Returns `this` if appropriate.
   */
  havingSize(size) {
    if (this.size === size && this.textSize === size) {
      return this;
    } else {
      return this.extend({
        style: this.style.text(),
        size,
        textSize: size,
        sizeMultiplier: sizeMultipliers[size - 1]
      });
    }
  }
  /**
   * Like `this.havingSize(BASESIZE).havingStyle(style)`. If `style` is omitted,
   * changes to at least `\textstyle`.
   */
  havingBaseStyle(style) {
    style = style || this.style.text();
    var wantSize = sizeAtStyle(_Options.BASESIZE, style);
    if (this.size === wantSize && this.textSize === _Options.BASESIZE && this.style === style) {
      return this;
    } else {
      return this.extend({
        style,
        size: wantSize
      });
    }
  }
  /**
   * Remove the effect of sizing changes such as \Huge.
   * Keep the effect of the current style, such as \scriptstyle.
   */
  havingBaseSizing() {
    var size;
    switch (this.style.id) {
      case 4:
      case 5:
        size = 3;
        break;
      case 6:
      case 7:
        size = 1;
        break;
      default:
        size = 6;
    }
    return this.extend({
      style: this.style.text(),
      size
    });
  }
  /**
   * Create a new options object with the given color.
   */
  withColor(color) {
    return this.extend({
      color
    });
  }
  /**
   * Create a new options object with "phantom" set to true.
   */
  withPhantom() {
    return this.extend({
      phantom: true
    });
  }
  /**
   * Creates a new options object with the given math font or old text font.
   * @type {[type]}
   */
  withFont(font) {
    return this.extend({
      font
    });
  }
  /**
   * Create a new options objects with the given fontFamily.
   */
  withTextFontFamily(fontFamily) {
    return this.extend({
      fontFamily,
      font: ""
    });
  }
  /**
   * Creates a new options object with the given font weight
   */
  withTextFontWeight(fontWeight) {
    return this.extend({
      fontWeight,
      font: ""
    });
  }
  /**
   * Creates a new options object with the given font weight
   */
  withTextFontShape(fontShape) {
    return this.extend({
      fontShape,
      font: ""
    });
  }
  /**
   * Return the CSS sizing classes required to switch from enclosing options
   * `oldOptions` to `this`. Returns an array of classes.
   */
  sizingClasses(oldOptions) {
    if (oldOptions.size !== this.size) {
      return ["sizing", "reset-size" + oldOptions.size, "size" + this.size];
    } else {
      return [];
    }
  }
  /**
   * Return the CSS sizing classes required to switch to the base size. Like
   * `this.havingSize(BASESIZE).sizingClasses(this)`.
   */
  baseSizingClasses() {
    if (this.size !== _Options.BASESIZE) {
      return ["sizing", "reset-size" + this.size, "size" + _Options.BASESIZE];
    } else {
      return [];
    }
  }
  /**
   * Return the font metrics for this size.
   */
  fontMetrics() {
    if (!this._fontMetrics) {
      this._fontMetrics = getGlobalMetrics(this.size);
    }
    return this._fontMetrics;
  }
  /**
   * Gets the CSS color of the current options object
   */
  getColor() {
    if (this.phantom) {
      return "transparent";
    } else {
      return this.color;
    }
  }
};
Options.BASESIZE = 6;
var ptPerUnit = {
  // https://en.wikibooks.org/wiki/LaTeX/Lengths and
  // https://tex.stackexchange.com/a/8263
  "pt": 1,
  // TeX point
  "mm": 7227 / 2540,
  // millimeter
  "cm": 7227 / 254,
  // centimeter
  "in": 72.27,
  // inch
  "bp": 803 / 800,
  // big (PostScript) points
  "pc": 12,
  // pica
  "dd": 1238 / 1157,
  // didot
  "cc": 14856 / 1157,
  // cicero (12 didot)
  "nd": 685 / 642,
  // new didot
  "nc": 1370 / 107,
  // new cicero (12 new didot)
  "sp": 1 / 65536,
  // scaled point (TeX's internal smallest unit)
  // https://tex.stackexchange.com/a/41371
  "px": 803 / 800
  // \pdfpxdimen defaults to 1 bp in pdfTeX and LuaTeX
};
var relativeUnit = {
  "ex": true,
  "em": true,
  "mu": true
};
var validUnit = function validUnit2(unit) {
  if (typeof unit !== "string") {
    unit = unit.unit;
  }
  return unit in ptPerUnit || unit in relativeUnit || unit === "ex";
};
var calculateSize = function calculateSize2(sizeValue, options) {
  var scale;
  if (sizeValue.unit in ptPerUnit) {
    scale = ptPerUnit[sizeValue.unit] / options.fontMetrics().ptPerEm / options.sizeMultiplier;
  } else if (sizeValue.unit === "mu") {
    scale = options.fontMetrics().cssEmPerMu;
  } else {
    var unitOptions;
    if (options.style.isTight()) {
      unitOptions = options.havingStyle(options.style.text());
    } else {
      unitOptions = options;
    }
    if (sizeValue.unit === "ex") {
      scale = unitOptions.fontMetrics().xHeight;
    } else if (sizeValue.unit === "em") {
      scale = unitOptions.fontMetrics().quad;
    } else {
      throw new ParseError("Invalid unit: '" + sizeValue.unit + "'");
    }
    if (unitOptions !== options) {
      scale *= unitOptions.sizeMultiplier / options.sizeMultiplier;
    }
  }
  return Math.min(sizeValue.number * scale, options.maxSize);
};
var makeEm = function makeEm2(n) {
  return +n.toFixed(4) + "em";
};
var createClass = function createClass2(classes) {
  return classes.filter((cls) => cls).join(" ");
};
var initNode = function initNode2(classes, options, style) {
  this.classes = classes || [];
  this.attributes = {};
  this.height = 0;
  this.depth = 0;
  this.maxFontSize = 0;
  this.style = style || {};
  if (options) {
    if (options.style.isTight()) {
      this.classes.push("mtight");
    }
    var color = options.getColor();
    if (color) {
      this.style.color = color;
    }
  }
};
var toNode = function toNode2(tagName) {
  var node = document.createElement(tagName);
  node.className = createClass(this.classes);
  for (var style in this.style) {
    if (this.style.hasOwnProperty(style)) {
      node.style[style] = this.style[style];
    }
  }
  for (var attr in this.attributes) {
    if (this.attributes.hasOwnProperty(attr)) {
      node.setAttribute(attr, this.attributes[attr]);
    }
  }
  for (var i2 = 0; i2 < this.children.length; i2++) {
    node.appendChild(this.children[i2].toNode());
  }
  return node;
};
var invalidAttributeNameRegex = /[\s"'>/=\x00-\x1f]/;
var toMarkup = function toMarkup2(tagName) {
  var markup = "<" + tagName;
  if (this.classes.length) {
    markup += ' class="' + utils.escape(createClass(this.classes)) + '"';
  }
  var styles2 = "";
  for (var style in this.style) {
    if (this.style.hasOwnProperty(style)) {
      styles2 += utils.hyphenate(style) + ":" + this.style[style] + ";";
    }
  }
  if (styles2) {
    markup += ' style="' + utils.escape(styles2) + '"';
  }
  for (var attr in this.attributes) {
    if (this.attributes.hasOwnProperty(attr)) {
      if (invalidAttributeNameRegex.test(attr)) {
        throw new ParseError("Invalid attribute name '" + attr + "'");
      }
      markup += " " + attr + '="' + utils.escape(this.attributes[attr]) + '"';
    }
  }
  markup += ">";
  for (var i2 = 0; i2 < this.children.length; i2++) {
    markup += this.children[i2].toMarkup();
  }
  markup += "</" + tagName + ">";
  return markup;
};
var Span = class {
  constructor(classes, children, options, style) {
    this.children = void 0;
    this.attributes = void 0;
    this.classes = void 0;
    this.height = void 0;
    this.depth = void 0;
    this.width = void 0;
    this.maxFontSize = void 0;
    this.style = void 0;
    initNode.call(this, classes, options, style);
    this.children = children || [];
  }
  /**
   * Sets an arbitrary attribute on the span. Warning: use this wisely. Not
   * all browsers support attributes the same, and having too many custom
   * attributes is probably bad.
   */
  setAttribute(attribute, value) {
    this.attributes[attribute] = value;
  }
  hasClass(className) {
    return utils.contains(this.classes, className);
  }
  toNode() {
    return toNode.call(this, "span");
  }
  toMarkup() {
    return toMarkup.call(this, "span");
  }
};
var Anchor = class {
  constructor(href, classes, children, options) {
    this.children = void 0;
    this.attributes = void 0;
    this.classes = void 0;
    this.height = void 0;
    this.depth = void 0;
    this.maxFontSize = void 0;
    this.style = void 0;
    initNode.call(this, classes, options);
    this.children = children || [];
    this.setAttribute("href", href);
  }
  setAttribute(attribute, value) {
    this.attributes[attribute] = value;
  }
  hasClass(className) {
    return utils.contains(this.classes, className);
  }
  toNode() {
    return toNode.call(this, "a");
  }
  toMarkup() {
    return toMarkup.call(this, "a");
  }
};
var Img = class {
  constructor(src, alt, style) {
    this.src = void 0;
    this.alt = void 0;
    this.classes = void 0;
    this.height = void 0;
    this.depth = void 0;
    this.maxFontSize = void 0;
    this.style = void 0;
    this.alt = alt;
    this.src = src;
    this.classes = ["mord"];
    this.style = style;
  }
  hasClass(className) {
    return utils.contains(this.classes, className);
  }
  toNode() {
    var node = document.createElement("img");
    node.src = this.src;
    node.alt = this.alt;
    node.className = "mord";
    for (var style in this.style) {
      if (this.style.hasOwnProperty(style)) {
        node.style[style] = this.style[style];
      }
    }
    return node;
  }
  toMarkup() {
    var markup = '<img src="' + utils.escape(this.src) + '"' + (' alt="' + utils.escape(this.alt) + '"');
    var styles2 = "";
    for (var style in this.style) {
      if (this.style.hasOwnProperty(style)) {
        styles2 += utils.hyphenate(style) + ":" + this.style[style] + ";";
      }
    }
    if (styles2) {
      markup += ' style="' + utils.escape(styles2) + '"';
    }
    markup += "'/>";
    return markup;
  }
};
var iCombinations = {
  "\xEE": "\u0131\u0302",
  "\xEF": "\u0131\u0308",
  "\xED": "\u0131\u0301",
  // 'ī': '\u0131\u0304', // enable when we add Extended Latin
  "\xEC": "\u0131\u0300"
};
var SymbolNode = class {
  constructor(text2, height, depth, italic, skew, width, classes, style) {
    this.text = void 0;
    this.height = void 0;
    this.depth = void 0;
    this.italic = void 0;
    this.skew = void 0;
    this.width = void 0;
    this.maxFontSize = void 0;
    this.classes = void 0;
    this.style = void 0;
    this.text = text2;
    this.height = height || 0;
    this.depth = depth || 0;
    this.italic = italic || 0;
    this.skew = skew || 0;
    this.width = width || 0;
    this.classes = classes || [];
    this.style = style || {};
    this.maxFontSize = 0;
    var script = scriptFromCodepoint(this.text.charCodeAt(0));
    if (script) {
      this.classes.push(script + "_fallback");
    }
    if (/[îïíì]/.test(this.text)) {
      this.text = iCombinations[this.text];
    }
  }
  hasClass(className) {
    return utils.contains(this.classes, className);
  }
  /**
   * Creates a text node or span from a symbol node. Note that a span is only
   * created if it is needed.
   */
  toNode() {
    var node = document.createTextNode(this.text);
    var span = null;
    if (this.italic > 0) {
      span = document.createElement("span");
      span.style.marginRight = makeEm(this.italic);
    }
    if (this.classes.length > 0) {
      span = span || document.createElement("span");
      span.className = createClass(this.classes);
    }
    for (var style in this.style) {
      if (this.style.hasOwnProperty(style)) {
        span = span || document.createElement("span");
        span.style[style] = this.style[style];
      }
    }
    if (span) {
      span.appendChild(node);
      return span;
    } else {
      return node;
    }
  }
  /**
   * Creates markup for a symbol node.
   */
  toMarkup() {
    var needsSpan = false;
    var markup = "<span";
    if (this.classes.length) {
      needsSpan = true;
      markup += ' class="';
      markup += utils.escape(createClass(this.classes));
      markup += '"';
    }
    var styles2 = "";
    if (this.italic > 0) {
      styles2 += "margin-right:" + this.italic + "em;";
    }
    for (var style in this.style) {
      if (this.style.hasOwnProperty(style)) {
        styles2 += utils.hyphenate(style) + ":" + this.style[style] + ";";
      }
    }
    if (styles2) {
      needsSpan = true;
      markup += ' style="' + utils.escape(styles2) + '"';
    }
    var escaped = utils.escape(this.text);
    if (needsSpan) {
      markup += ">";
      markup += escaped;
      markup += "</span>";
      return markup;
    } else {
      return escaped;
    }
  }
};
var SvgNode = class {
  constructor(children, attributes) {
    this.children = void 0;
    this.attributes = void 0;
    this.children = children || [];
    this.attributes = attributes || {};
  }
  toNode() {
    var svgNS = "http://www.w3.org/2000/svg";
    var node = document.createElementNS(svgNS, "svg");
    for (var attr in this.attributes) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, attr)) {
        node.setAttribute(attr, this.attributes[attr]);
      }
    }
    for (var i2 = 0; i2 < this.children.length; i2++) {
      node.appendChild(this.children[i2].toNode());
    }
    return node;
  }
  toMarkup() {
    var markup = '<svg xmlns="http://www.w3.org/2000/svg"';
    for (var attr in this.attributes) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, attr)) {
        markup += " " + attr + '="' + utils.escape(this.attributes[attr]) + '"';
      }
    }
    markup += ">";
    for (var i2 = 0; i2 < this.children.length; i2++) {
      markup += this.children[i2].toMarkup();
    }
    markup += "</svg>";
    return markup;
  }
};
var PathNode = class {
  constructor(pathName, alternate) {
    this.pathName = void 0;
    this.alternate = void 0;
    this.pathName = pathName;
    this.alternate = alternate;
  }
  toNode() {
    var svgNS = "http://www.w3.org/2000/svg";
    var node = document.createElementNS(svgNS, "path");
    if (this.alternate) {
      node.setAttribute("d", this.alternate);
    } else {
      node.setAttribute("d", path[this.pathName]);
    }
    return node;
  }
  toMarkup() {
    if (this.alternate) {
      return '<path d="' + utils.escape(this.alternate) + '"/>';
    } else {
      return '<path d="' + utils.escape(path[this.pathName]) + '"/>';
    }
  }
};
var LineNode = class {
  constructor(attributes) {
    this.attributes = void 0;
    this.attributes = attributes || {};
  }
  toNode() {
    var svgNS = "http://www.w3.org/2000/svg";
    var node = document.createElementNS(svgNS, "line");
    for (var attr in this.attributes) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, attr)) {
        node.setAttribute(attr, this.attributes[attr]);
      }
    }
    return node;
  }
  toMarkup() {
    var markup = "<line";
    for (var attr in this.attributes) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, attr)) {
        markup += " " + attr + '="' + utils.escape(this.attributes[attr]) + '"';
      }
    }
    markup += "/>";
    return markup;
  }
};
function assertSymbolDomNode(group) {
  if (group instanceof SymbolNode) {
    return group;
  } else {
    throw new Error("Expected symbolNode but got " + String(group) + ".");
  }
}
function assertSpan(group) {
  if (group instanceof Span) {
    return group;
  } else {
    throw new Error("Expected span<HtmlDomNode> but got " + String(group) + ".");
  }
}
var ATOMS = {
  "bin": 1,
  "close": 1,
  "inner": 1,
  "open": 1,
  "punct": 1,
  "rel": 1
};
var NON_ATOMS = {
  "accent-token": 1,
  "mathord": 1,
  "op-token": 1,
  "spacing": 1,
  "textord": 1
};
var symbols = {
  "math": {},
  "text": {}
};
function defineSymbol(mode, font, group, replace, name, acceptUnicodeChar) {
  symbols[mode][name] = {
    font,
    group,
    replace
  };
  if (acceptUnicodeChar && replace) {
    symbols[mode][replace] = symbols[mode][name];
  }
}
var math = "math";
var text = "text";
var main = "main";
var ams = "ams";
var accent = "accent-token";
var bin = "bin";
var close = "close";
var inner = "inner";
var mathord = "mathord";
var op = "op-token";
var open = "open";
var punct = "punct";
var rel = "rel";
var spacing = "spacing";
var textord = "textord";
defineSymbol(math, main, rel, "\u2261", "\\equiv", true);
defineSymbol(math, main, rel, "\u227A", "\\prec", true);
defineSymbol(math, main, rel, "\u227B", "\\succ", true);
defineSymbol(math, main, rel, "\u223C", "\\sim", true);
defineSymbol(math, main, rel, "\u22A5", "\\perp");
defineSymbol(math, main, rel, "\u2AAF", "\\preceq", true);
defineSymbol(math, main, rel, "\u2AB0", "\\succeq", true);
defineSymbol(math, main, rel, "\u2243", "\\simeq", true);
defineSymbol(math, main, rel, "\u2223", "\\mid", true);
defineSymbol(math, main, rel, "\u226A", "\\ll", true);
defineSymbol(math, main, rel, "\u226B", "\\gg", true);
defineSymbol(math, main, rel, "\u224D", "\\asymp", true);
defineSymbol(math, main, rel, "\u2225", "\\parallel");
defineSymbol(math, main, rel, "\u22C8", "\\bowtie", true);
defineSymbol(math, main, rel, "\u2323", "\\smile", true);
defineSymbol(math, main, rel, "\u2291", "\\sqsubseteq", true);
defineSymbol(math, main, rel, "\u2292", "\\sqsupseteq", true);
defineSymbol(math, main, rel, "\u2250", "\\doteq", true);
defineSymbol(math, main, rel, "\u2322", "\\frown", true);
defineSymbol(math, main, rel, "\u220B", "\\ni", true);
defineSymbol(math, main, rel, "\u221D", "\\propto", true);
defineSymbol(math, main, rel, "\u22A2", "\\vdash", true);
defineSymbol(math, main, rel, "\u22A3", "\\dashv", true);
defineSymbol(math, main, rel, "\u220B", "\\owns");
defineSymbol(math, main, punct, ".", "\\ldotp");
defineSymbol(math, main, punct, "\u22C5", "\\cdotp");
defineSymbol(math, main, textord, "#", "\\#");
defineSymbol(text, main, textord, "#", "\\#");
defineSymbol(math, main, textord, "&", "\\&");
defineSymbol(text, main, textord, "&", "\\&");
defineSymbol(math, main, textord, "\u2135", "\\aleph", true);
defineSymbol(math, main, textord, "\u2200", "\\forall", true);
defineSymbol(math, main, textord, "\u210F", "\\hbar", true);
defineSymbol(math, main, textord, "\u2203", "\\exists", true);
defineSymbol(math, main, textord, "\u2207", "\\nabla", true);
defineSymbol(math, main, textord, "\u266D", "\\flat", true);
defineSymbol(math, main, textord, "\u2113", "\\ell", true);
defineSymbol(math, main, textord, "\u266E", "\\natural", true);
defineSymbol(math, main, textord, "\u2663", "\\clubsuit", true);
defineSymbol(math, main, textord, "\u2118", "\\wp", true);
defineSymbol(math, main, textord, "\u266F", "\\sharp", true);
defineSymbol(math, main, textord, "\u2662", "\\diamondsuit", true);
defineSymbol(math, main, textord, "\u211C", "\\Re", true);
defineSymbol(math, main, textord, "\u2661", "\\heartsuit", true);
defineSymbol(math, main, textord, "\u2111", "\\Im", true);
defineSymbol(math, main, textord, "\u2660", "\\spadesuit", true);
defineSymbol(math, main, textord, "\xA7", "\\S", true);
defineSymbol(text, main, textord, "\xA7", "\\S");
defineSymbol(math, main, textord, "\xB6", "\\P", true);
defineSymbol(text, main, textord, "\xB6", "\\P");
defineSymbol(math, main, textord, "\u2020", "\\dag");
defineSymbol(text, main, textord, "\u2020", "\\dag");
defineSymbol(text, main, textord, "\u2020", "\\textdagger");
defineSymbol(math, main, textord, "\u2021", "\\ddag");
defineSymbol(text, main, textord, "\u2021", "\\ddag");
defineSymbol(text, main, textord, "\u2021", "\\textdaggerdbl");
defineSymbol(math, main, close, "\u23B1", "\\rmoustache", true);
defineSymbol(math, main, open, "\u23B0", "\\lmoustache", true);
defineSymbol(math, main, close, "\u27EF", "\\rgroup", true);
defineSymbol(math, main, open, "\u27EE", "\\lgroup", true);
defineSymbol(math, main, bin, "\u2213", "\\mp", true);
defineSymbol(math, main, bin, "\u2296", "\\ominus", true);
defineSymbol(math, main, bin, "\u228E", "\\uplus", true);
defineSymbol(math, main, bin, "\u2293", "\\sqcap", true);
defineSymbol(math, main, bin, "\u2217", "\\ast");
defineSymbol(math, main, bin, "\u2294", "\\sqcup", true);
defineSymbol(math, main, bin, "\u25EF", "\\bigcirc", true);
defineSymbol(math, main, bin, "\u2219", "\\bullet", true);
defineSymbol(math, main, bin, "\u2021", "\\ddagger");
defineSymbol(math, main, bin, "\u2240", "\\wr", true);
defineSymbol(math, main, bin, "\u2A3F", "\\amalg");
defineSymbol(math, main, bin, "&", "\\And");
defineSymbol(math, main, rel, "\u27F5", "\\longleftarrow", true);
defineSymbol(math, main, rel, "\u21D0", "\\Leftarrow", true);
defineSymbol(math, main, rel, "\u27F8", "\\Longleftarrow", true);
defineSymbol(math, main, rel, "\u27F6", "\\longrightarrow", true);
defineSymbol(math, main, rel, "\u21D2", "\\Rightarrow", true);
defineSymbol(math, main, rel, "\u27F9", "\\Longrightarrow", true);
defineSymbol(math, main, rel, "\u2194", "\\leftrightarrow", true);
defineSymbol(math, main, rel, "\u27F7", "\\longleftrightarrow", true);
defineSymbol(math, main, rel, "\u21D4", "\\Leftrightarrow", true);
defineSymbol(math, main, rel, "\u27FA", "\\Longleftrightarrow", true);
defineSymbol(math, main, rel, "\u21A6", "\\mapsto", true);
defineSymbol(math, main, rel, "\u27FC", "\\longmapsto", true);
defineSymbol(math, main, rel, "\u2197", "\\nearrow", true);
defineSymbol(math, main, rel, "\u21A9", "\\hookleftarrow", true);
defineSymbol(math, main, rel, "\u21AA", "\\hookrightarrow", true);
defineSymbol(math, main, rel, "\u2198", "\\searrow", true);
defineSymbol(math, main, rel, "\u21BC", "\\leftharpoonup", true);
defineSymbol(math, main, rel, "\u21C0", "\\rightharpoonup", true);
defineSymbol(math, main, rel, "\u2199", "\\swarrow", true);
defineSymbol(math, main, rel, "\u21BD", "\\leftharpoondown", true);
defineSymbol(math, main, rel, "\u21C1", "\\rightharpoondown", true);
defineSymbol(math, main, rel, "\u2196", "\\nwarrow", true);
defineSymbol(math, main, rel, "\u21CC", "\\rightleftharpoons", true);
defineSymbol(math, ams, rel, "\u226E", "\\nless", true);
defineSymbol(math, ams, rel, "\uE010", "\\@nleqslant");
defineSymbol(math, ams, rel, "\uE011", "\\@nleqq");
defineSymbol(math, ams, rel, "\u2A87", "\\lneq", true);
defineSymbol(math, ams, rel, "\u2268", "\\lneqq", true);
defineSymbol(math, ams, rel, "\uE00C", "\\@lvertneqq");
defineSymbol(math, ams, rel, "\u22E6", "\\lnsim", true);
defineSymbol(math, ams, rel, "\u2A89", "\\lnapprox", true);
defineSymbol(math, ams, rel, "\u2280", "\\nprec", true);
defineSymbol(math, ams, rel, "\u22E0", "\\npreceq", true);
defineSymbol(math, ams, rel, "\u22E8", "\\precnsim", true);
defineSymbol(math, ams, rel, "\u2AB9", "\\precnapprox", true);
defineSymbol(math, ams, rel, "\u2241", "\\nsim", true);
defineSymbol(math, ams, rel, "\uE006", "\\@nshortmid");
defineSymbol(math, ams, rel, "\u2224", "\\nmid", true);
defineSymbol(math, ams, rel, "\u22AC", "\\nvdash", true);
defineSymbol(math, ams, rel, "\u22AD", "\\nvDash", true);
defineSymbol(math, ams, rel, "\u22EA", "\\ntriangleleft");
defineSymbol(math, ams, rel, "\u22EC", "\\ntrianglelefteq", true);
defineSymbol(math, ams, rel, "\u228A", "\\subsetneq", true);
defineSymbol(math, ams, rel, "\uE01A", "\\@varsubsetneq");
defineSymbol(math, ams, rel, "\u2ACB", "\\subsetneqq", true);
defineSymbol(math, ams, rel, "\uE017", "\\@varsubsetneqq");
defineSymbol(math, ams, rel, "\u226F", "\\ngtr", true);
defineSymbol(math, ams, rel, "\uE00F", "\\@ngeqslant");
defineSymbol(math, ams, rel, "\uE00E", "\\@ngeqq");
defineSymbol(math, ams, rel, "\u2A88", "\\gneq", true);
defineSymbol(math, ams, rel, "\u2269", "\\gneqq", true);
defineSymbol(math, ams, rel, "\uE00D", "\\@gvertneqq");
defineSymbol(math, ams, rel, "\u22E7", "\\gnsim", true);
defineSymbol(math, ams, rel, "\u2A8A", "\\gnapprox", true);
defineSymbol(math, ams, rel, "\u2281", "\\nsucc", true);
defineSymbol(math, ams, rel, "\u22E1", "\\nsucceq", true);
defineSymbol(math, ams, rel, "\u22E9", "\\succnsim", true);
defineSymbol(math, ams, rel, "\u2ABA", "\\succnapprox", true);
defineSymbol(math, ams, rel, "\u2246", "\\ncong", true);
defineSymbol(math, ams, rel, "\uE007", "\\@nshortparallel");
defineSymbol(math, ams, rel, "\u2226", "\\nparallel", true);
defineSymbol(math, ams, rel, "\u22AF", "\\nVDash", true);
defineSymbol(math, ams, rel, "\u22EB", "\\ntriangleright");
defineSymbol(math, ams, rel, "\u22ED", "\\ntrianglerighteq", true);
defineSymbol(math, ams, rel, "\uE018", "\\@nsupseteqq");
defineSymbol(math, ams, rel, "\u228B", "\\supsetneq", true);
defineSymbol(math, ams, rel, "\uE01B", "\\@varsupsetneq");
defineSymbol(math, ams, rel, "\u2ACC", "\\supsetneqq", true);
defineSymbol(math, ams, rel, "\uE019", "\\@varsupsetneqq");
defineSymbol(math, ams, rel, "\u22AE", "\\nVdash", true);
defineSymbol(math, ams, rel, "\u2AB5", "\\precneqq", true);
defineSymbol(math, ams, rel, "\u2AB6", "\\succneqq", true);
defineSymbol(math, ams, rel, "\uE016", "\\@nsubseteqq");
defineSymbol(math, ams, bin, "\u22B4", "\\unlhd");
defineSymbol(math, ams, bin, "\u22B5", "\\unrhd");
defineSymbol(math, ams, rel, "\u219A", "\\nleftarrow", true);
defineSymbol(math, ams, rel, "\u219B", "\\nrightarrow", true);
defineSymbol(math, ams, rel, "\u21CD", "\\nLeftarrow", true);
defineSymbol(math, ams, rel, "\u21CF", "\\nRightarrow", true);
defineSymbol(math, ams, rel, "\u21AE", "\\nleftrightarrow", true);
defineSymbol(math, ams, rel, "\u21CE", "\\nLeftrightarrow", true);
defineSymbol(math, ams, rel, "\u25B3", "\\vartriangle");
defineSymbol(math, ams, textord, "\u210F", "\\hslash");
defineSymbol(math, ams, textord, "\u25BD", "\\triangledown");
defineSymbol(math, ams, textord, "\u25CA", "\\lozenge");
defineSymbol(math, ams, textord, "\u24C8", "\\circledS");
defineSymbol(math, ams, textord, "\xAE", "\\circledR");
defineSymbol(text, ams, textord, "\xAE", "\\circledR");
defineSymbol(math, ams, textord, "\u2221", "\\measuredangle", true);
defineSymbol(math, ams, textord, "\u2204", "\\nexists");
defineSymbol(math, ams, textord, "\u2127", "\\mho");
defineSymbol(math, ams, textord, "\u2132", "\\Finv", true);
defineSymbol(math, ams, textord, "\u2141", "\\Game", true);
defineSymbol(math, ams, textord, "\u2035", "\\backprime");
defineSymbol(math, ams, textord, "\u25B2", "\\blacktriangle");
defineSymbol(math, ams, textord, "\u25BC", "\\blacktriangledown");
defineSymbol(math, ams, textord, "\u25A0", "\\blacksquare");
defineSymbol(math, ams, textord, "\u29EB", "\\blacklozenge");
defineSymbol(math, ams, textord, "\u2605", "\\bigstar");
defineSymbol(math, ams, textord, "\u2222", "\\sphericalangle", true);
defineSymbol(math, ams, textord, "\u2201", "\\complement", true);
defineSymbol(math, ams, textord, "\xF0", "\\eth", true);
defineSymbol(text, main, textord, "\xF0", "\xF0");
defineSymbol(math, ams, textord, "\u2571", "\\diagup");
defineSymbol(math, ams, textord, "\u2572", "\\diagdown");
defineSymbol(math, ams, textord, "\u25A1", "\\square");
defineSymbol(math, ams, textord, "\u25A1", "\\Box");
defineSymbol(math, ams, textord, "\u25CA", "\\Diamond");
defineSymbol(math, ams, textord, "\xA5", "\\yen", true);
defineSymbol(text, ams, textord, "\xA5", "\\yen", true);
defineSymbol(math, ams, textord, "\u2713", "\\checkmark", true);
defineSymbol(text, ams, textord, "\u2713", "\\checkmark");
defineSymbol(math, ams, textord, "\u2136", "\\beth", true);
defineSymbol(math, ams, textord, "\u2138", "\\daleth", true);
defineSymbol(math, ams, textord, "\u2137", "\\gimel", true);
defineSymbol(math, ams, textord, "\u03DD", "\\digamma", true);
defineSymbol(math, ams, textord, "\u03F0", "\\varkappa");
defineSymbol(math, ams, open, "\u250C", "\\@ulcorner", true);
defineSymbol(math, ams, close, "\u2510", "\\@urcorner", true);
defineSymbol(math, ams, open, "\u2514", "\\@llcorner", true);
defineSymbol(math, ams, close, "\u2518", "\\@lrcorner", true);
defineSymbol(math, ams, rel, "\u2266", "\\leqq", true);
defineSymbol(math, ams, rel, "\u2A7D", "\\leqslant", true);
defineSymbol(math, ams, rel, "\u2A95", "\\eqslantless", true);
defineSymbol(math, ams, rel, "\u2272", "\\lesssim", true);
defineSymbol(math, ams, rel, "\u2A85", "\\lessapprox", true);
defineSymbol(math, ams, rel, "\u224A", "\\approxeq", true);
defineSymbol(math, ams, bin, "\u22D6", "\\lessdot");
defineSymbol(math, ams, rel, "\u22D8", "\\lll", true);
defineSymbol(math, ams, rel, "\u2276", "\\lessgtr", true);
defineSymbol(math, ams, rel, "\u22DA", "\\lesseqgtr", true);
defineSymbol(math, ams, rel, "\u2A8B", "\\lesseqqgtr", true);
defineSymbol(math, ams, rel, "\u2251", "\\doteqdot");
defineSymbol(math, ams, rel, "\u2253", "\\risingdotseq", true);
defineSymbol(math, ams, rel, "\u2252", "\\fallingdotseq", true);
defineSymbol(math, ams, rel, "\u223D", "\\backsim", true);
defineSymbol(math, ams, rel, "\u22CD", "\\backsimeq", true);
defineSymbol(math, ams, rel, "\u2AC5", "\\subseteqq", true);
defineSymbol(math, ams, rel, "\u22D0", "\\Subset", true);
defineSymbol(math, ams, rel, "\u228F", "\\sqsubset", true);
defineSymbol(math, ams, rel, "\u227C", "\\preccurlyeq", true);
defineSymbol(math, ams, rel, "\u22DE", "\\curlyeqprec", true);
defineSymbol(math, ams, rel, "\u227E", "\\precsim", true);
defineSymbol(math, ams, rel, "\u2AB7", "\\precapprox", true);
defineSymbol(math, ams, rel, "\u22B2", "\\vartriangleleft");
defineSymbol(math, ams, rel, "\u22B4", "\\trianglelefteq");
defineSymbol(math, ams, rel, "\u22A8", "\\vDash", true);
defineSymbol(math, ams, rel, "\u22AA", "\\Vvdash", true);
defineSymbol(math, ams, rel, "\u2323", "\\smallsmile");
defineSymbol(math, ams, rel, "\u2322", "\\smallfrown");
defineSymbol(math, ams, rel, "\u224F", "\\bumpeq", true);
defineSymbol(math, ams, rel, "\u224E", "\\Bumpeq", true);
defineSymbol(math, ams, rel, "\u2267", "\\geqq", true);
defineSymbol(math, ams, rel, "\u2A7E", "\\geqslant", true);
defineSymbol(math, ams, rel, "\u2A96", "\\eqslantgtr", true);
defineSymbol(math, ams, rel, "\u2273", "\\gtrsim", true);
defineSymbol(math, ams, rel, "\u2A86", "\\gtrapprox", true);
defineSymbol(math, ams, bin, "\u22D7", "\\gtrdot");
defineSymbol(math, ams, rel, "\u22D9", "\\ggg", true);
defineSymbol(math, ams, rel, "\u2277", "\\gtrless", true);
defineSymbol(math, ams, rel, "\u22DB", "\\gtreqless", true);
defineSymbol(math, ams, rel, "\u2A8C", "\\gtreqqless", true);
defineSymbol(math, ams, rel, "\u2256", "\\eqcirc", true);
defineSymbol(math, ams, rel, "\u2257", "\\circeq", true);
defineSymbol(math, ams, rel, "\u225C", "\\triangleq", true);
defineSymbol(math, ams, rel, "\u223C", "\\thicksim");
defineSymbol(math, ams, rel, "\u2248", "\\thickapprox");
defineSymbol(math, ams, rel, "\u2AC6", "\\supseteqq", true);
defineSymbol(math, ams, rel, "\u22D1", "\\Supset", true);
defineSymbol(math, ams, rel, "\u2290", "\\sqsupset", true);
defineSymbol(math, ams, rel, "\u227D", "\\succcurlyeq", true);
defineSymbol(math, ams, rel, "\u22DF", "\\curlyeqsucc", true);
defineSymbol(math, ams, rel, "\u227F", "\\succsim", true);
defineSymbol(math, ams, rel, "\u2AB8", "\\succapprox", true);
defineSymbol(math, ams, rel, "\u22B3", "\\vartriangleright");
defineSymbol(math, ams, rel, "\u22B5", "\\trianglerighteq");
defineSymbol(math, ams, rel, "\u22A9", "\\Vdash", true);
defineSymbol(math, ams, rel, "\u2223", "\\shortmid");
defineSymbol(math, ams, rel, "\u2225", "\\shortparallel");
defineSymbol(math, ams, rel, "\u226C", "\\between", true);
defineSymbol(math, ams, rel, "\u22D4", "\\pitchfork", true);
defineSymbol(math, ams, rel, "\u221D", "\\varpropto");
defineSymbol(math, ams, rel, "\u25C0", "\\blacktriangleleft");
defineSymbol(math, ams, rel, "\u2234", "\\therefore", true);
defineSymbol(math, ams, rel, "\u220D", "\\backepsilon");
defineSymbol(math, ams, rel, "\u25B6", "\\blacktriangleright");
defineSymbol(math, ams, rel, "\u2235", "\\because", true);
defineSymbol(math, ams, rel, "\u22D8", "\\llless");
defineSymbol(math, ams, rel, "\u22D9", "\\gggtr");
defineSymbol(math, ams, bin, "\u22B2", "\\lhd");
defineSymbol(math, ams, bin, "\u22B3", "\\rhd");
defineSymbol(math, ams, rel, "\u2242", "\\eqsim", true);
defineSymbol(math, main, rel, "\u22C8", "\\Join");
defineSymbol(math, ams, rel, "\u2251", "\\Doteq", true);
defineSymbol(math, ams, bin, "\u2214", "\\dotplus", true);
defineSymbol(math, ams, bin, "\u2216", "\\smallsetminus");
defineSymbol(math, ams, bin, "\u22D2", "\\Cap", true);
defineSymbol(math, ams, bin, "\u22D3", "\\Cup", true);
defineSymbol(math, ams, bin, "\u2A5E", "\\doublebarwedge", true);
defineSymbol(math, ams, bin, "\u229F", "\\boxminus", true);
defineSymbol(math, ams, bin, "\u229E", "\\boxplus", true);
defineSymbol(math, ams, bin, "\u22C7", "\\divideontimes", true);
defineSymbol(math, ams, bin, "\u22C9", "\\ltimes", true);
defineSymbol(math, ams, bin, "\u22CA", "\\rtimes", true);
defineSymbol(math, ams, bin, "\u22CB", "\\leftthreetimes", true);
defineSymbol(math, ams, bin, "\u22CC", "\\rightthreetimes", true);
defineSymbol(math, ams, bin, "\u22CF", "\\curlywedge", true);
defineSymbol(math, ams, bin, "\u22CE", "\\curlyvee", true);
defineSymbol(math, ams, bin, "\u229D", "\\circleddash", true);
defineSymbol(math, ams, bin, "\u229B", "\\circledast", true);
defineSymbol(math, ams, bin, "\u22C5", "\\centerdot");
defineSymbol(math, ams, bin, "\u22BA", "\\intercal", true);
defineSymbol(math, ams, bin, "\u22D2", "\\doublecap");
defineSymbol(math, ams, bin, "\u22D3", "\\doublecup");
defineSymbol(math, ams, bin, "\u22A0", "\\boxtimes", true);
defineSymbol(math, ams, rel, "\u21E2", "\\dashrightarrow", true);
defineSymbol(math, ams, rel, "\u21E0", "\\dashleftarrow", true);
defineSymbol(math, ams, rel, "\u21C7", "\\leftleftarrows", true);
defineSymbol(math, ams, rel, "\u21C6", "\\leftrightarrows", true);
defineSymbol(math, ams, rel, "\u21DA", "\\Lleftarrow", true);
defineSymbol(math, ams, rel, "\u219E", "\\twoheadleftarrow", true);
defineSymbol(math, ams, rel, "\u21A2", "\\leftarrowtail", true);
defineSymbol(math, ams, rel, "\u21AB", "\\looparrowleft", true);
defineSymbol(math, ams, rel, "\u21CB", "\\leftrightharpoons", true);
defineSymbol(math, ams, rel, "\u21B6", "\\curvearrowleft", true);
defineSymbol(math, ams, rel, "\u21BA", "\\circlearrowleft", true);
defineSymbol(math, ams, rel, "\u21B0", "\\Lsh", true);
defineSymbol(math, ams, rel, "\u21C8", "\\upuparrows", true);
defineSymbol(math, ams, rel, "\u21BF", "\\upharpoonleft", true);
defineSymbol(math, ams, rel, "\u21C3", "\\downharpoonleft", true);
defineSymbol(math, main, rel, "\u22B6", "\\origof", true);
defineSymbol(math, main, rel, "\u22B7", "\\imageof", true);
defineSymbol(math, ams, rel, "\u22B8", "\\multimap", true);
defineSymbol(math, ams, rel, "\u21AD", "\\leftrightsquigarrow", true);
defineSymbol(math, ams, rel, "\u21C9", "\\rightrightarrows", true);
defineSymbol(math, ams, rel, "\u21C4", "\\rightleftarrows", true);
defineSymbol(math, ams, rel, "\u21A0", "\\twoheadrightarrow", true);
defineSymbol(math, ams, rel, "\u21A3", "\\rightarrowtail", true);
defineSymbol(math, ams, rel, "\u21AC", "\\looparrowright", true);
defineSymbol(math, ams, rel, "\u21B7", "\\curvearrowright", true);
defineSymbol(math, ams, rel, "\u21BB", "\\circlearrowright", true);
defineSymbol(math, ams, rel, "\u21B1", "\\Rsh", true);
defineSymbol(math, ams, rel, "\u21CA", "\\downdownarrows", true);
defineSymbol(math, ams, rel, "\u21BE", "\\upharpoonright", true);
defineSymbol(math, ams, rel, "\u21C2", "\\downharpoonright", true);
defineSymbol(math, ams, rel, "\u21DD", "\\rightsquigarrow", true);
defineSymbol(math, ams, rel, "\u21DD", "\\leadsto");
defineSymbol(math, ams, rel, "\u21DB", "\\Rrightarrow", true);
defineSymbol(math, ams, rel, "\u21BE", "\\restriction");
defineSymbol(math, main, textord, "\u2018", "`");
defineSymbol(math, main, textord, "$", "\\$");
defineSymbol(text, main, textord, "$", "\\$");
defineSymbol(text, main, textord, "$", "\\textdollar");
defineSymbol(math, main, textord, "%", "\\%");
defineSymbol(text, main, textord, "%", "\\%");
defineSymbol(math, main, textord, "_", "\\_");
defineSymbol(text, main, textord, "_", "\\_");
defineSymbol(text, main, textord, "_", "\\textunderscore");
defineSymbol(math, main, textord, "\u2220", "\\angle", true);
defineSymbol(math, main, textord, "\u221E", "\\infty", true);
defineSymbol(math, main, textord, "\u2032", "\\prime");
defineSymbol(math, main, textord, "\u25B3", "\\triangle");
defineSymbol(math, main, textord, "\u0393", "\\Gamma", true);
defineSymbol(math, main, textord, "\u0394", "\\Delta", true);
defineSymbol(math, main, textord, "\u0398", "\\Theta", true);
defineSymbol(math, main, textord, "\u039B", "\\Lambda", true);
defineSymbol(math, main, textord, "\u039E", "\\Xi", true);
defineSymbol(math, main, textord, "\u03A0", "\\Pi", true);
defineSymbol(math, main, textord, "\u03A3", "\\Sigma", true);
defineSymbol(math, main, textord, "\u03A5", "\\Upsilon", true);
defineSymbol(math, main, textord, "\u03A6", "\\Phi", true);
defineSymbol(math, main, textord, "\u03A8", "\\Psi", true);
defineSymbol(math, main, textord, "\u03A9", "\\Omega", true);
defineSymbol(math, main, textord, "A", "\u0391");
defineSymbol(math, main, textord, "B", "\u0392");
defineSymbol(math, main, textord, "E", "\u0395");
defineSymbol(math, main, textord, "Z", "\u0396");
defineSymbol(math, main, textord, "H", "\u0397");
defineSymbol(math, main, textord, "I", "\u0399");
defineSymbol(math, main, textord, "K", "\u039A");
defineSymbol(math, main, textord, "M", "\u039C");
defineSymbol(math, main, textord, "N", "\u039D");
defineSymbol(math, main, textord, "O", "\u039F");
defineSymbol(math, main, textord, "P", "\u03A1");
defineSymbol(math, main, textord, "T", "\u03A4");
defineSymbol(math, main, textord, "X", "\u03A7");
defineSymbol(math, main, textord, "\xAC", "\\neg", true);
defineSymbol(math, main, textord, "\xAC", "\\lnot");
defineSymbol(math, main, textord, "\u22A4", "\\top");
defineSymbol(math, main, textord, "\u22A5", "\\bot");
defineSymbol(math, main, textord, "\u2205", "\\emptyset");
defineSymbol(math, ams, textord, "\u2205", "\\varnothing");
defineSymbol(math, main, mathord, "\u03B1", "\\alpha", true);
defineSymbol(math, main, mathord, "\u03B2", "\\beta", true);
defineSymbol(math, main, mathord, "\u03B3", "\\gamma", true);
defineSymbol(math, main, mathord, "\u03B4", "\\delta", true);
defineSymbol(math, main, mathord, "\u03F5", "\\epsilon", true);
defineSymbol(math, main, mathord, "\u03B6", "\\zeta", true);
defineSymbol(math, main, mathord, "\u03B7", "\\eta", true);
defineSymbol(math, main, mathord, "\u03B8", "\\theta", true);
defineSymbol(math, main, mathord, "\u03B9", "\\iota", true);
defineSymbol(math, main, mathord, "\u03BA", "\\kappa", true);
defineSymbol(math, main, mathord, "\u03BB", "\\lambda", true);
defineSymbol(math, main, mathord, "\u03BC", "\\mu", true);
defineSymbol(math, main, mathord, "\u03BD", "\\nu", true);
defineSymbol(math, main, mathord, "\u03BE", "\\xi", true);
defineSymbol(math, main, mathord, "\u03BF", "\\omicron", true);
defineSymbol(math, main, mathord, "\u03C0", "\\pi", true);
defineSymbol(math, main, mathord, "\u03C1", "\\rho", true);
defineSymbol(math, main, mathord, "\u03C3", "\\sigma", true);
defineSymbol(math, main, mathord, "\u03C4", "\\tau", true);
defineSymbol(math, main, mathord, "\u03C5", "\\upsilon", true);
defineSymbol(math, main, mathord, "\u03D5", "\\phi", true);
defineSymbol(math, main, mathord, "\u03C7", "\\chi", true);
defineSymbol(math, main, mathord, "\u03C8", "\\psi", true);
defineSymbol(math, main, mathord, "\u03C9", "\\omega", true);
defineSymbol(math, main, mathord, "\u03B5", "\\varepsilon", true);
defineSymbol(math, main, mathord, "\u03D1", "\\vartheta", true);
defineSymbol(math, main, mathord, "\u03D6", "\\varpi", true);
defineSymbol(math, main, mathord, "\u03F1", "\\varrho", true);
defineSymbol(math, main, mathord, "\u03C2", "\\varsigma", true);
defineSymbol(math, main, mathord, "\u03C6", "\\varphi", true);
defineSymbol(math, main, bin, "\u2217", "*", true);
defineSymbol(math, main, bin, "+", "+");
defineSymbol(math, main, bin, "\u2212", "-", true);
defineSymbol(math, main, bin, "\u22C5", "\\cdot", true);
defineSymbol(math, main, bin, "\u2218", "\\circ", true);
defineSymbol(math, main, bin, "\xF7", "\\div", true);
defineSymbol(math, main, bin, "\xB1", "\\pm", true);
defineSymbol(math, main, bin, "\xD7", "\\times", true);
defineSymbol(math, main, bin, "\u2229", "\\cap", true);
defineSymbol(math, main, bin, "\u222A", "\\cup", true);
defineSymbol(math, main, bin, "\u2216", "\\setminus", true);
defineSymbol(math, main, bin, "\u2227", "\\land");
defineSymbol(math, main, bin, "\u2228", "\\lor");
defineSymbol(math, main, bin, "\u2227", "\\wedge", true);
defineSymbol(math, main, bin, "\u2228", "\\vee", true);
defineSymbol(math, main, textord, "\u221A", "\\surd");
defineSymbol(math, main, open, "\u27E8", "\\langle", true);
defineSymbol(math, main, open, "\u2223", "\\lvert");
defineSymbol(math, main, open, "\u2225", "\\lVert");
defineSymbol(math, main, close, "?", "?");
defineSymbol(math, main, close, "!", "!");
defineSymbol(math, main, close, "\u27E9", "\\rangle", true);
defineSymbol(math, main, close, "\u2223", "\\rvert");
defineSymbol(math, main, close, "\u2225", "\\rVert");
defineSymbol(math, main, rel, "=", "=");
defineSymbol(math, main, rel, ":", ":");
defineSymbol(math, main, rel, "\u2248", "\\approx", true);
defineSymbol(math, main, rel, "\u2245", "\\cong", true);
defineSymbol(math, main, rel, "\u2265", "\\ge");
defineSymbol(math, main, rel, "\u2265", "\\geq", true);
defineSymbol(math, main, rel, "\u2190", "\\gets");
defineSymbol(math, main, rel, ">", "\\gt", true);
defineSymbol(math, main, rel, "\u2208", "\\in", true);
defineSymbol(math, main, rel, "\uE020", "\\@not");
defineSymbol(math, main, rel, "\u2282", "\\subset", true);
defineSymbol(math, main, rel, "\u2283", "\\supset", true);
defineSymbol(math, main, rel, "\u2286", "\\subseteq", true);
defineSymbol(math, main, rel, "\u2287", "\\supseteq", true);
defineSymbol(math, ams, rel, "\u2288", "\\nsubseteq", true);
defineSymbol(math, ams, rel, "\u2289", "\\nsupseteq", true);
defineSymbol(math, main, rel, "\u22A8", "\\models");
defineSymbol(math, main, rel, "\u2190", "\\leftarrow", true);
defineSymbol(math, main, rel, "\u2264", "\\le");
defineSymbol(math, main, rel, "\u2264", "\\leq", true);
defineSymbol(math, main, rel, "<", "\\lt", true);
defineSymbol(math, main, rel, "\u2192", "\\rightarrow", true);
defineSymbol(math, main, rel, "\u2192", "\\to");
defineSymbol(math, ams, rel, "\u2271", "\\ngeq", true);
defineSymbol(math, ams, rel, "\u2270", "\\nleq", true);
defineSymbol(math, main, spacing, "\xA0", "\\ ");
defineSymbol(math, main, spacing, "\xA0", "\\space");
defineSymbol(math, main, spacing, "\xA0", "\\nobreakspace");
defineSymbol(text, main, spacing, "\xA0", "\\ ");
defineSymbol(text, main, spacing, "\xA0", " ");
defineSymbol(text, main, spacing, "\xA0", "\\space");
defineSymbol(text, main, spacing, "\xA0", "\\nobreakspace");
defineSymbol(math, main, spacing, null, "\\nobreak");
defineSymbol(math, main, spacing, null, "\\allowbreak");
defineSymbol(math, main, punct, ",", ",");
defineSymbol(math, main, punct, ";", ";");
defineSymbol(math, ams, bin, "\u22BC", "\\barwedge", true);
defineSymbol(math, ams, bin, "\u22BB", "\\veebar", true);
defineSymbol(math, main, bin, "\u2299", "\\odot", true);
defineSymbol(math, main, bin, "\u2295", "\\oplus", true);
defineSymbol(math, main, bin, "\u2297", "\\otimes", true);
defineSymbol(math, main, textord, "\u2202", "\\partial", true);
defineSymbol(math, main, bin, "\u2298", "\\oslash", true);
defineSymbol(math, ams, bin, "\u229A", "\\circledcirc", true);
defineSymbol(math, ams, bin, "\u22A1", "\\boxdot", true);
defineSymbol(math, main, bin, "\u25B3", "\\bigtriangleup");
defineSymbol(math, main, bin, "\u25BD", "\\bigtriangledown");
defineSymbol(math, main, bin, "\u2020", "\\dagger");
defineSymbol(math, main, bin, "\u22C4", "\\diamond");
defineSymbol(math, main, bin, "\u22C6", "\\star");
defineSymbol(math, main, bin, "\u25C3", "\\triangleleft");
defineSymbol(math, main, bin, "\u25B9", "\\triangleright");
defineSymbol(math, main, open, "{", "\\{");
defineSymbol(text, main, textord, "{", "\\{");
defineSymbol(text, main, textord, "{", "\\textbraceleft");
defineSymbol(math, main, close, "}", "\\}");
defineSymbol(text, main, textord, "}", "\\}");
defineSymbol(text, main, textord, "}", "\\textbraceright");
defineSymbol(math, main, open, "{", "\\lbrace");
defineSymbol(math, main, close, "}", "\\rbrace");
defineSymbol(math, main, open, "[", "\\lbrack", true);
defineSymbol(text, main, textord, "[", "\\lbrack", true);
defineSymbol(math, main, close, "]", "\\rbrack", true);
defineSymbol(text, main, textord, "]", "\\rbrack", true);
defineSymbol(math, main, open, "(", "\\lparen", true);
defineSymbol(math, main, close, ")", "\\rparen", true);
defineSymbol(text, main, textord, "<", "\\textless", true);
defineSymbol(text, main, textord, ">", "\\textgreater", true);
defineSymbol(math, main, open, "\u230A", "\\lfloor", true);
defineSymbol(math, main, close, "\u230B", "\\rfloor", true);
defineSymbol(math, main, open, "\u2308", "\\lceil", true);
defineSymbol(math, main, close, "\u2309", "\\rceil", true);
defineSymbol(math, main, textord, "\\", "\\backslash");
defineSymbol(math, main, textord, "\u2223", "|");
defineSymbol(math, main, textord, "\u2223", "\\vert");
defineSymbol(text, main, textord, "|", "\\textbar", true);
defineSymbol(math, main, textord, "\u2225", "\\|");
defineSymbol(math, main, textord, "\u2225", "\\Vert");
defineSymbol(text, main, textord, "\u2225", "\\textbardbl");
defineSymbol(text, main, textord, "~", "\\textasciitilde");
defineSymbol(text, main, textord, "\\", "\\textbackslash");
defineSymbol(text, main, textord, "^", "\\textasciicircum");
defineSymbol(math, main, rel, "\u2191", "\\uparrow", true);
defineSymbol(math, main, rel, "\u21D1", "\\Uparrow", true);
defineSymbol(math, main, rel, "\u2193", "\\downarrow", true);
defineSymbol(math, main, rel, "\u21D3", "\\Downarrow", true);
defineSymbol(math, main, rel, "\u2195", "\\updownarrow", true);
defineSymbol(math, main, rel, "\u21D5", "\\Updownarrow", true);
defineSymbol(math, main, op, "\u2210", "\\coprod");
defineSymbol(math, main, op, "\u22C1", "\\bigvee");
defineSymbol(math, main, op, "\u22C0", "\\bigwedge");
defineSymbol(math, main, op, "\u2A04", "\\biguplus");
defineSymbol(math, main, op, "\u22C2", "\\bigcap");
defineSymbol(math, main, op, "\u22C3", "\\bigcup");
defineSymbol(math, main, op, "\u222B", "\\int");
defineSymbol(math, main, op, "\u222B", "\\intop");
defineSymbol(math, main, op, "\u222C", "\\iint");
defineSymbol(math, main, op, "\u222D", "\\iiint");
defineSymbol(math, main, op, "\u220F", "\\prod");
defineSymbol(math, main, op, "\u2211", "\\sum");
defineSymbol(math, main, op, "\u2A02", "\\bigotimes");
defineSymbol(math, main, op, "\u2A01", "\\bigoplus");
defineSymbol(math, main, op, "\u2A00", "\\bigodot");
defineSymbol(math, main, op, "\u222E", "\\oint");
defineSymbol(math, main, op, "\u222F", "\\oiint");
defineSymbol(math, main, op, "\u2230", "\\oiiint");
defineSymbol(math, main, op, "\u2A06", "\\bigsqcup");
defineSymbol(math, main, op, "\u222B", "\\smallint");
defineSymbol(text, main, inner, "\u2026", "\\textellipsis");
defineSymbol(math, main, inner, "\u2026", "\\mathellipsis");
defineSymbol(text, main, inner, "\u2026", "\\ldots", true);
defineSymbol(math, main, inner, "\u2026", "\\ldots", true);
defineSymbol(math, main, inner, "\u22EF", "\\@cdots", true);
defineSymbol(math, main, inner, "\u22F1", "\\ddots", true);
defineSymbol(math, main, textord, "\u22EE", "\\varvdots");
defineSymbol(text, main, textord, "\u22EE", "\\varvdots");
defineSymbol(math, main, accent, "\u02CA", "\\acute");
defineSymbol(math, main, accent, "\u02CB", "\\grave");
defineSymbol(math, main, accent, "\xA8", "\\ddot");
defineSymbol(math, main, accent, "~", "\\tilde");
defineSymbol(math, main, accent, "\u02C9", "\\bar");
defineSymbol(math, main, accent, "\u02D8", "\\breve");
defineSymbol(math, main, accent, "\u02C7", "\\check");
defineSymbol(math, main, accent, "^", "\\hat");
defineSymbol(math, main, accent, "\u20D7", "\\vec");
defineSymbol(math, main, accent, "\u02D9", "\\dot");
defineSymbol(math, main, accent, "\u02DA", "\\mathring");
defineSymbol(math, main, mathord, "\uE131", "\\@imath");
defineSymbol(math, main, mathord, "\uE237", "\\@jmath");
defineSymbol(math, main, textord, "\u0131", "\u0131");
defineSymbol(math, main, textord, "\u0237", "\u0237");
defineSymbol(text, main, textord, "\u0131", "\\i", true);
defineSymbol(text, main, textord, "\u0237", "\\j", true);
defineSymbol(text, main, textord, "\xDF", "\\ss", true);
defineSymbol(text, main, textord, "\xE6", "\\ae", true);
defineSymbol(text, main, textord, "\u0153", "\\oe", true);
defineSymbol(text, main, textord, "\xF8", "\\o", true);
defineSymbol(text, main, textord, "\xC6", "\\AE", true);
defineSymbol(text, main, textord, "\u0152", "\\OE", true);
defineSymbol(text, main, textord, "\xD8", "\\O", true);
defineSymbol(text, main, accent, "\u02CA", "\\'");
defineSymbol(text, main, accent, "\u02CB", "\\`");
defineSymbol(text, main, accent, "\u02C6", "\\^");
defineSymbol(text, main, accent, "\u02DC", "\\~");
defineSymbol(text, main, accent, "\u02C9", "\\=");
defineSymbol(text, main, accent, "\u02D8", "\\u");
defineSymbol(text, main, accent, "\u02D9", "\\.");
defineSymbol(text, main, accent, "\xB8", "\\c");
defineSymbol(text, main, accent, "\u02DA", "\\r");
defineSymbol(text, main, accent, "\u02C7", "\\v");
defineSymbol(text, main, accent, "\xA8", '\\"');
defineSymbol(text, main, accent, "\u02DD", "\\H");
defineSymbol(text, main, accent, "\u25EF", "\\textcircled");
var ligatures = {
  "--": true,
  "---": true,
  "``": true,
  "''": true
};
defineSymbol(text, main, textord, "\u2013", "--", true);
defineSymbol(text, main, textord, "\u2013", "\\textendash");
defineSymbol(text, main, textord, "\u2014", "---", true);
defineSymbol(text, main, textord, "\u2014", "\\textemdash");
defineSymbol(text, main, textord, "\u2018", "`", true);
defineSymbol(text, main, textord, "\u2018", "\\textquoteleft");
defineSymbol(text, main, textord, "\u2019", "'", true);
defineSymbol(text, main, textord, "\u2019", "\\textquoteright");
defineSymbol(text, main, textord, "\u201C", "``", true);
defineSymbol(text, main, textord, "\u201C", "\\textquotedblleft");
defineSymbol(text, main, textord, "\u201D", "''", true);
defineSymbol(text, main, textord, "\u201D", "\\textquotedblright");
defineSymbol(math, main, textord, "\xB0", "\\degree", true);
defineSymbol(text, main, textord, "\xB0", "\\degree");
defineSymbol(text, main, textord, "\xB0", "\\textdegree", true);
defineSymbol(math, main, textord, "\xA3", "\\pounds");
defineSymbol(math, main, textord, "\xA3", "\\mathsterling", true);
defineSymbol(text, main, textord, "\xA3", "\\pounds");
defineSymbol(text, main, textord, "\xA3", "\\textsterling", true);
defineSymbol(math, ams, textord, "\u2720", "\\maltese");
defineSymbol(text, ams, textord, "\u2720", "\\maltese");
var mathTextSymbols = '0123456789/@."';
for (i = 0; i < mathTextSymbols.length; i++) {
  ch = mathTextSymbols.charAt(i);
  defineSymbol(math, main, textord, ch, ch);
}
var ch;
var i;
var textSymbols = '0123456789!@*()-=+";:?/.,';
for (_i = 0; _i < textSymbols.length; _i++) {
  _ch = textSymbols.charAt(_i);
  defineSymbol(text, main, textord, _ch, _ch);
}
var _ch;
var _i;
var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
for (_i2 = 0; _i2 < letters.length; _i2++) {
  _ch2 = letters.charAt(_i2);
  defineSymbol(math, main, mathord, _ch2, _ch2);
  defineSymbol(text, main, textord, _ch2, _ch2);
}
var _ch2;
var _i2;
defineSymbol(math, ams, textord, "C", "\u2102");
defineSymbol(text, ams, textord, "C", "\u2102");
defineSymbol(math, ams, textord, "H", "\u210D");
defineSymbol(text, ams, textord, "H", "\u210D");
defineSymbol(math, ams, textord, "N", "\u2115");
defineSymbol(text, ams, textord, "N", "\u2115");
defineSymbol(math, ams, textord, "P", "\u2119");
defineSymbol(text, ams, textord, "P", "\u2119");
defineSymbol(math, ams, textord, "Q", "\u211A");
defineSymbol(text, ams, textord, "Q", "\u211A");
defineSymbol(math, ams, textord, "R", "\u211D");
defineSymbol(text, ams, textord, "R", "\u211D");
defineSymbol(math, ams, textord, "Z", "\u2124");
defineSymbol(text, ams, textord, "Z", "\u2124");
defineSymbol(math, main, mathord, "h", "\u210E");
defineSymbol(text, main, mathord, "h", "\u210E");
var wideChar = "";
for (_i3 = 0; _i3 < letters.length; _i3++) {
  _ch3 = letters.charAt(_i3);
  wideChar = String.fromCharCode(55349, 56320 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56372 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56424 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56580 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56684 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56736 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56788 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56840 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  wideChar = String.fromCharCode(55349, 56944 + _i3);
  defineSymbol(math, main, mathord, _ch3, wideChar);
  defineSymbol(text, main, textord, _ch3, wideChar);
  if (_i3 < 26) {
    wideChar = String.fromCharCode(55349, 56632 + _i3);
    defineSymbol(math, main, mathord, _ch3, wideChar);
    defineSymbol(text, main, textord, _ch3, wideChar);
    wideChar = String.fromCharCode(55349, 56476 + _i3);
    defineSymbol(math, main, mathord, _ch3, wideChar);
    defineSymbol(text, main, textord, _ch3, wideChar);
  }
}
var _ch3;
var _i3;
wideChar = String.fromCharCode(55349, 56668);
defineSymbol(math, main, mathord, "k", wideChar);
defineSymbol(text, main, textord, "k", wideChar);
for (_i4 = 0; _i4 < 10; _i4++) {
  _ch4 = _i4.toString();
  wideChar = String.fromCharCode(55349, 57294 + _i4);
  defineSymbol(math, main, mathord, _ch4, wideChar);
  defineSymbol(text, main, textord, _ch4, wideChar);
  wideChar = String.fromCharCode(55349, 57314 + _i4);
  defineSymbol(math, main, mathord, _ch4, wideChar);
  defineSymbol(text, main, textord, _ch4, wideChar);
  wideChar = String.fromCharCode(55349, 57324 + _i4);
  defineSymbol(math, main, mathord, _ch4, wideChar);
  defineSymbol(text, main, textord, _ch4, wideChar);
  wideChar = String.fromCharCode(55349, 57334 + _i4);
  defineSymbol(math, main, mathord, _ch4, wideChar);
  defineSymbol(text, main, textord, _ch4, wideChar);
}
var _ch4;
var _i4;
var extraLatin = "\xD0\xDE\xFE";
for (_i5 = 0; _i5 < extraLatin.length; _i5++) {
  _ch5 = extraLatin.charAt(_i5);
  defineSymbol(math, main, mathord, _ch5, _ch5);
  defineSymbol(text, main, textord, _ch5, _ch5);
}
var _ch5;
var _i5;
var wideLatinLetterData = [
  ["mathbf", "textbf", "Main-Bold"],
  // A-Z bold upright
  ["mathbf", "textbf", "Main-Bold"],
  // a-z bold upright
  ["mathnormal", "textit", "Math-Italic"],
  // A-Z italic
  ["mathnormal", "textit", "Math-Italic"],
  // a-z italic
  ["boldsymbol", "boldsymbol", "Main-BoldItalic"],
  // A-Z bold italic
  ["boldsymbol", "boldsymbol", "Main-BoldItalic"],
  // a-z bold italic
  // Map fancy A-Z letters to script, not calligraphic.
  // This aligns with unicode-math and math fonts (except Cambria Math).
  ["mathscr", "textscr", "Script-Regular"],
  // A-Z script
  ["", "", ""],
  // a-z script.  No font
  ["", "", ""],
  // A-Z bold script. No font
  ["", "", ""],
  // a-z bold script. No font
  ["mathfrak", "textfrak", "Fraktur-Regular"],
  // A-Z Fraktur
  ["mathfrak", "textfrak", "Fraktur-Regular"],
  // a-z Fraktur
  ["mathbb", "textbb", "AMS-Regular"],
  // A-Z double-struck
  ["mathbb", "textbb", "AMS-Regular"],
  // k double-struck
  // Note that we are using a bold font, but font metrics for regular Fraktur.
  ["mathboldfrak", "textboldfrak", "Fraktur-Regular"],
  // A-Z bold Fraktur
  ["mathboldfrak", "textboldfrak", "Fraktur-Regular"],
  // a-z bold Fraktur
  ["mathsf", "textsf", "SansSerif-Regular"],
  // A-Z sans-serif
  ["mathsf", "textsf", "SansSerif-Regular"],
  // a-z sans-serif
  ["mathboldsf", "textboldsf", "SansSerif-Bold"],
  // A-Z bold sans-serif
  ["mathboldsf", "textboldsf", "SansSerif-Bold"],
  // a-z bold sans-serif
  ["mathitsf", "textitsf", "SansSerif-Italic"],
  // A-Z italic sans-serif
  ["mathitsf", "textitsf", "SansSerif-Italic"],
  // a-z italic sans-serif
  ["", "", ""],
  // A-Z bold italic sans. No font
  ["", "", ""],
  // a-z bold italic sans. No font
  ["mathtt", "texttt", "Typewriter-Regular"],
  // A-Z monospace
  ["mathtt", "texttt", "Typewriter-Regular"]
  // a-z monospace
];
var wideNumeralData = [
  ["mathbf", "textbf", "Main-Bold"],
  // 0-9 bold
  ["", "", ""],
  // 0-9 double-struck. No KaTeX font.
  ["mathsf", "textsf", "SansSerif-Regular"],
  // 0-9 sans-serif
  ["mathboldsf", "textboldsf", "SansSerif-Bold"],
  // 0-9 bold sans-serif
  ["mathtt", "texttt", "Typewriter-Regular"]
  // 0-9 monospace
];
var wideCharacterFont = function wideCharacterFont2(wideChar2, mode) {
  var H = wideChar2.charCodeAt(0);
  var L = wideChar2.charCodeAt(1);
  var codePoint = (H - 55296) * 1024 + (L - 56320) + 65536;
  var j = mode === "math" ? 0 : 1;
  if (119808 <= codePoint && codePoint < 120484) {
    var i2 = Math.floor((codePoint - 119808) / 26);
    return [wideLatinLetterData[i2][2], wideLatinLetterData[i2][j]];
  } else if (120782 <= codePoint && codePoint <= 120831) {
    var _i6 = Math.floor((codePoint - 120782) / 10);
    return [wideNumeralData[_i6][2], wideNumeralData[_i6][j]];
  } else if (codePoint === 120485 || codePoint === 120486) {
    return [wideLatinLetterData[0][2], wideLatinLetterData[0][j]];
  } else if (120486 < codePoint && codePoint < 120782) {
    return ["", ""];
  } else {
    throw new ParseError("Unsupported character: " + wideChar2);
  }
};
var lookupSymbol = function lookupSymbol2(value, fontName, mode) {
  if (symbols[mode][value] && symbols[mode][value].replace) {
    value = symbols[mode][value].replace;
  }
  return {
    value,
    metrics: getCharacterMetrics(value, fontName, mode)
  };
};
var makeSymbol = function makeSymbol2(value, fontName, mode, options, classes) {
  var lookup = lookupSymbol(value, fontName, mode);
  var metrics = lookup.metrics;
  value = lookup.value;
  var symbolNode;
  if (metrics) {
    var italic = metrics.italic;
    if (mode === "text" || options && options.font === "mathit") {
      italic = 0;
    }
    symbolNode = new SymbolNode(value, metrics.height, metrics.depth, italic, metrics.skew, metrics.width, classes);
  } else {
    typeof console !== "undefined" && console.warn("No character metrics " + ("for '" + value + "' in style '" + fontName + "' and mode '" + mode + "'"));
    symbolNode = new SymbolNode(value, 0, 0, 0, 0, 0, classes);
  }
  if (options) {
    symbolNode.maxFontSize = options.sizeMultiplier;
    if (options.style.isTight()) {
      symbolNode.classes.push("mtight");
    }
    var color = options.getColor();
    if (color) {
      symbolNode.style.color = color;
    }
  }
  return symbolNode;
};
var mathsym = function mathsym2(value, mode, options, classes) {
  if (classes === void 0) {
    classes = [];
  }
  if (options.font === "boldsymbol" && lookupSymbol(value, "Main-Bold", mode).metrics) {
    return makeSymbol(value, "Main-Bold", mode, options, classes.concat(["mathbf"]));
  } else if (value === "\\" || symbols[mode][value].font === "main") {
    return makeSymbol(value, "Main-Regular", mode, options, classes);
  } else {
    return makeSymbol(value, "AMS-Regular", mode, options, classes.concat(["amsrm"]));
  }
};
var boldsymbol = function boldsymbol2(value, mode, options, classes, type) {
  if (type !== "textord" && lookupSymbol(value, "Math-BoldItalic", mode).metrics) {
    return {
      fontName: "Math-BoldItalic",
      fontClass: "boldsymbol"
    };
  } else {
    return {
      fontName: "Main-Bold",
      fontClass: "mathbf"
    };
  }
};
var makeOrd = function makeOrd2(group, options, type) {
  var mode = group.mode;
  var text2 = group.text;
  var classes = ["mord"];
  var isFont = mode === "math" || mode === "text" && options.font;
  var fontOrFamily = isFont ? options.font : options.fontFamily;
  var wideFontName = "";
  var wideFontClass = "";
  if (text2.charCodeAt(0) === 55349) {
    [wideFontName, wideFontClass] = wideCharacterFont(text2, mode);
  }
  if (wideFontName.length > 0) {
    return makeSymbol(text2, wideFontName, mode, options, classes.concat(wideFontClass));
  } else if (fontOrFamily) {
    var fontName;
    var fontClasses;
    if (fontOrFamily === "boldsymbol") {
      var fontData = boldsymbol(text2, mode, options, classes, type);
      fontName = fontData.fontName;
      fontClasses = [fontData.fontClass];
    } else if (isFont) {
      fontName = fontMap[fontOrFamily].fontName;
      fontClasses = [fontOrFamily];
    } else {
      fontName = retrieveTextFontName(fontOrFamily, options.fontWeight, options.fontShape);
      fontClasses = [fontOrFamily, options.fontWeight, options.fontShape];
    }
    if (lookupSymbol(text2, fontName, mode).metrics) {
      return makeSymbol(text2, fontName, mode, options, classes.concat(fontClasses));
    } else if (ligatures.hasOwnProperty(text2) && fontName.slice(0, 10) === "Typewriter") {
      var parts = [];
      for (var i2 = 0; i2 < text2.length; i2++) {
        parts.push(makeSymbol(text2[i2], fontName, mode, options, classes.concat(fontClasses)));
      }
      return makeFragment(parts);
    }
  }
  if (type === "mathord") {
    return makeSymbol(text2, "Math-Italic", mode, options, classes.concat(["mathnormal"]));
  } else if (type === "textord") {
    var font = symbols[mode][text2] && symbols[mode][text2].font;
    if (font === "ams") {
      var _fontName = retrieveTextFontName("amsrm", options.fontWeight, options.fontShape);
      return makeSymbol(text2, _fontName, mode, options, classes.concat("amsrm", options.fontWeight, options.fontShape));
    } else if (font === "main" || !font) {
      var _fontName2 = retrieveTextFontName("textrm", options.fontWeight, options.fontShape);
      return makeSymbol(text2, _fontName2, mode, options, classes.concat(options.fontWeight, options.fontShape));
    } else {
      var _fontName3 = retrieveTextFontName(font, options.fontWeight, options.fontShape);
      return makeSymbol(text2, _fontName3, mode, options, classes.concat(_fontName3, options.fontWeight, options.fontShape));
    }
  } else {
    throw new Error("unexpected type: " + type + " in makeOrd");
  }
};
var canCombine = (prev, next) => {
  if (createClass(prev.classes) !== createClass(next.classes) || prev.skew !== next.skew || prev.maxFontSize !== next.maxFontSize) {
    return false;
  }
  if (prev.classes.length === 1) {
    var cls = prev.classes[0];
    if (cls === "mbin" || cls === "mord") {
      return false;
    }
  }
  for (var style in prev.style) {
    if (prev.style.hasOwnProperty(style) && prev.style[style] !== next.style[style]) {
      return false;
    }
  }
  for (var _style in next.style) {
    if (next.style.hasOwnProperty(_style) && prev.style[_style] !== next.style[_style]) {
      return false;
    }
  }
  return true;
};
var tryCombineChars = (chars) => {
  for (var i2 = 0; i2 < chars.length - 1; i2++) {
    var prev = chars[i2];
    var next = chars[i2 + 1];
    if (prev instanceof SymbolNode && next instanceof SymbolNode && canCombine(prev, next)) {
      prev.text += next.text;
      prev.height = Math.max(prev.height, next.height);
      prev.depth = Math.max(prev.depth, next.depth);
      prev.italic = next.italic;
      chars.splice(i2 + 1, 1);
      i2--;
    }
  }
  return chars;
};
var sizeElementFromChildren = function sizeElementFromChildren2(elem) {
  var height = 0;
  var depth = 0;
  var maxFontSize = 0;
  for (var i2 = 0; i2 < elem.children.length; i2++) {
    var child = elem.children[i2];
    if (child.height > height) {
      height = child.height;
    }
    if (child.depth > depth) {
      depth = child.depth;
    }
    if (child.maxFontSize > maxFontSize) {
      maxFontSize = child.maxFontSize;
    }
  }
  elem.height = height;
  elem.depth = depth;
  elem.maxFontSize = maxFontSize;
};
var makeSpan$2 = function makeSpan(classes, children, options, style) {
  var span = new Span(classes, children, options, style);
  sizeElementFromChildren(span);
  return span;
};
var makeSvgSpan = (classes, children, options, style) => new Span(classes, children, options, style);
var makeLineSpan = function makeLineSpan2(className, options, thickness) {
  var line = makeSpan$2([className], [], options);
  line.height = Math.max(thickness || options.fontMetrics().defaultRuleThickness, options.minRuleThickness);
  line.style.borderBottomWidth = makeEm(line.height);
  line.maxFontSize = 1;
  return line;
};
var makeAnchor = function makeAnchor2(href, classes, children, options) {
  var anchor = new Anchor(href, classes, children, options);
  sizeElementFromChildren(anchor);
  return anchor;
};
var makeFragment = function makeFragment2(children) {
  var fragment = new DocumentFragment(children);
  sizeElementFromChildren(fragment);
  return fragment;
};
var wrapFragment = function wrapFragment2(group, options) {
  if (group instanceof DocumentFragment) {
    return makeSpan$2([], [group], options);
  }
  return group;
};
var getVListChildrenAndDepth = function getVListChildrenAndDepth2(params) {
  if (params.positionType === "individualShift") {
    var oldChildren = params.children;
    var children = [oldChildren[0]];
    var _depth = -oldChildren[0].shift - oldChildren[0].elem.depth;
    var currPos = _depth;
    for (var i2 = 1; i2 < oldChildren.length; i2++) {
      var diff = -oldChildren[i2].shift - currPos - oldChildren[i2].elem.depth;
      var size = diff - (oldChildren[i2 - 1].elem.height + oldChildren[i2 - 1].elem.depth);
      currPos = currPos + diff;
      children.push({
        type: "kern",
        size
      });
      children.push(oldChildren[i2]);
    }
    return {
      children,
      depth: _depth
    };
  }
  var depth;
  if (params.positionType === "top") {
    var bottom = params.positionData;
    for (var _i6 = 0; _i6 < params.children.length; _i6++) {
      var child = params.children[_i6];
      bottom -= child.type === "kern" ? child.size : child.elem.height + child.elem.depth;
    }
    depth = bottom;
  } else if (params.positionType === "bottom") {
    depth = -params.positionData;
  } else {
    var firstChild = params.children[0];
    if (firstChild.type !== "elem") {
      throw new Error('First child must have type "elem".');
    }
    if (params.positionType === "shift") {
      depth = -firstChild.elem.depth - params.positionData;
    } else if (params.positionType === "firstBaseline") {
      depth = -firstChild.elem.depth;
    } else {
      throw new Error("Invalid positionType " + params.positionType + ".");
    }
  }
  return {
    children: params.children,
    depth
  };
};
var makeVList = function makeVList2(params, options) {
  var {
    children,
    depth
  } = getVListChildrenAndDepth(params);
  var pstrutSize = 0;
  for (var i2 = 0; i2 < children.length; i2++) {
    var child = children[i2];
    if (child.type === "elem") {
      var elem = child.elem;
      pstrutSize = Math.max(pstrutSize, elem.maxFontSize, elem.height);
    }
  }
  pstrutSize += 2;
  var pstrut = makeSpan$2(["pstrut"], []);
  pstrut.style.height = makeEm(pstrutSize);
  var realChildren = [];
  var minPos = depth;
  var maxPos = depth;
  var currPos = depth;
  for (var _i22 = 0; _i22 < children.length; _i22++) {
    var _child = children[_i22];
    if (_child.type === "kern") {
      currPos += _child.size;
    } else {
      var _elem = _child.elem;
      var classes = _child.wrapperClasses || [];
      var style = _child.wrapperStyle || {};
      var childWrap = makeSpan$2(classes, [pstrut, _elem], void 0, style);
      childWrap.style.top = makeEm(-pstrutSize - currPos - _elem.depth);
      if (_child.marginLeft) {
        childWrap.style.marginLeft = _child.marginLeft;
      }
      if (_child.marginRight) {
        childWrap.style.marginRight = _child.marginRight;
      }
      realChildren.push(childWrap);
      currPos += _elem.height + _elem.depth;
    }
    minPos = Math.min(minPos, currPos);
    maxPos = Math.max(maxPos, currPos);
  }
  var vlist = makeSpan$2(["vlist"], realChildren);
  vlist.style.height = makeEm(maxPos);
  var rows;
  if (minPos < 0) {
    var emptySpan = makeSpan$2([], []);
    var depthStrut = makeSpan$2(["vlist"], [emptySpan]);
    depthStrut.style.height = makeEm(-minPos);
    var topStrut = makeSpan$2(["vlist-s"], [new SymbolNode("\u200B")]);
    rows = [makeSpan$2(["vlist-r"], [vlist, topStrut]), makeSpan$2(["vlist-r"], [depthStrut])];
  } else {
    rows = [makeSpan$2(["vlist-r"], [vlist])];
  }
  var vtable = makeSpan$2(["vlist-t"], rows);
  if (rows.length === 2) {
    vtable.classes.push("vlist-t2");
  }
  vtable.height = maxPos;
  vtable.depth = -minPos;
  return vtable;
};
var makeGlue = (measurement, options) => {
  var rule = makeSpan$2(["mspace"], [], options);
  var size = calculateSize(measurement, options);
  rule.style.marginRight = makeEm(size);
  return rule;
};
var retrieveTextFontName = function retrieveTextFontName2(fontFamily, fontWeight, fontShape) {
  var baseFontName = "";
  switch (fontFamily) {
    case "amsrm":
      baseFontName = "AMS";
      break;
    case "textrm":
      baseFontName = "Main";
      break;
    case "textsf":
      baseFontName = "SansSerif";
      break;
    case "texttt":
      baseFontName = "Typewriter";
      break;
    default:
      baseFontName = fontFamily;
  }
  var fontStylesName;
  if (fontWeight === "textbf" && fontShape === "textit") {
    fontStylesName = "BoldItalic";
  } else if (fontWeight === "textbf") {
    fontStylesName = "Bold";
  } else if (fontWeight === "textit") {
    fontStylesName = "Italic";
  } else {
    fontStylesName = "Regular";
  }
  return baseFontName + "-" + fontStylesName;
};
var fontMap = {
  // styles
  "mathbf": {
    variant: "bold",
    fontName: "Main-Bold"
  },
  "mathrm": {
    variant: "normal",
    fontName: "Main-Regular"
  },
  "textit": {
    variant: "italic",
    fontName: "Main-Italic"
  },
  "mathit": {
    variant: "italic",
    fontName: "Main-Italic"
  },
  "mathnormal": {
    variant: "italic",
    fontName: "Math-Italic"
  },
  "mathsfit": {
    variant: "sans-serif-italic",
    fontName: "SansSerif-Italic"
  },
  // "boldsymbol" is missing because they require the use of multiple fonts:
  // Math-BoldItalic and Main-Bold.  This is handled by a special case in
  // makeOrd which ends up calling boldsymbol.
  // families
  "mathbb": {
    variant: "double-struck",
    fontName: "AMS-Regular"
  },
  "mathcal": {
    variant: "script",
    fontName: "Caligraphic-Regular"
  },
  "mathfrak": {
    variant: "fraktur",
    fontName: "Fraktur-Regular"
  },
  "mathscr": {
    variant: "script",
    fontName: "Script-Regular"
  },
  "mathsf": {
    variant: "sans-serif",
    fontName: "SansSerif-Regular"
  },
  "mathtt": {
    variant: "monospace",
    fontName: "Typewriter-Regular"
  }
};
var svgData = {
  //   path, width, height
  vec: ["vec", 0.471, 0.714],
  // values from the font glyph
  oiintSize1: ["oiintSize1", 0.957, 0.499],
  // oval to overlay the integrand
  oiintSize2: ["oiintSize2", 1.472, 0.659],
  oiiintSize1: ["oiiintSize1", 1.304, 0.499],
  oiiintSize2: ["oiiintSize2", 1.98, 0.659]
};
var staticSvg = function staticSvg2(value, options) {
  var [pathName, width, height] = svgData[value];
  var path2 = new PathNode(pathName);
  var svgNode = new SvgNode([path2], {
    "width": makeEm(width),
    "height": makeEm(height),
    // Override CSS rule `.katex svg { width: 100% }`
    "style": "width:" + makeEm(width),
    "viewBox": "0 0 " + 1e3 * width + " " + 1e3 * height,
    "preserveAspectRatio": "xMinYMin"
  });
  var span = makeSvgSpan(["overlay"], [svgNode], options);
  span.height = height;
  span.style.height = makeEm(height);
  span.style.width = makeEm(width);
  return span;
};
var buildCommon = {
  fontMap,
  makeSymbol,
  mathsym,
  makeSpan: makeSpan$2,
  makeSvgSpan,
  makeLineSpan,
  makeAnchor,
  makeFragment,
  wrapFragment,
  makeVList,
  makeOrd,
  makeGlue,
  staticSvg,
  svgData,
  tryCombineChars
};
var thinspace = {
  number: 3,
  unit: "mu"
};
var mediumspace = {
  number: 4,
  unit: "mu"
};
var thickspace = {
  number: 5,
  unit: "mu"
};
var spacings = {
  mord: {
    mop: thinspace,
    mbin: mediumspace,
    mrel: thickspace,
    minner: thinspace
  },
  mop: {
    mord: thinspace,
    mop: thinspace,
    mrel: thickspace,
    minner: thinspace
  },
  mbin: {
    mord: mediumspace,
    mop: mediumspace,
    mopen: mediumspace,
    minner: mediumspace
  },
  mrel: {
    mord: thickspace,
    mop: thickspace,
    mopen: thickspace,
    minner: thickspace
  },
  mopen: {},
  mclose: {
    mop: thinspace,
    mbin: mediumspace,
    mrel: thickspace,
    minner: thinspace
  },
  mpunct: {
    mord: thinspace,
    mop: thinspace,
    mrel: thickspace,
    mopen: thinspace,
    mclose: thinspace,
    mpunct: thinspace,
    minner: thinspace
  },
  minner: {
    mord: thinspace,
    mop: thinspace,
    mbin: mediumspace,
    mrel: thickspace,
    mopen: thinspace,
    mpunct: thinspace,
    minner: thinspace
  }
};
var tightSpacings = {
  mord: {
    mop: thinspace
  },
  mop: {
    mord: thinspace,
    mop: thinspace
  },
  mbin: {},
  mrel: {},
  mopen: {},
  mclose: {
    mop: thinspace
  },
  mpunct: {},
  minner: {
    mop: thinspace
  }
};
var _functions = {};
var _htmlGroupBuilders = {};
var _mathmlGroupBuilders = {};
function defineFunction(_ref) {
  var {
    type,
    names,
    props,
    handler,
    htmlBuilder: htmlBuilder3,
    mathmlBuilder: mathmlBuilder3
  } = _ref;
  var data = {
    type,
    numArgs: props.numArgs,
    argTypes: props.argTypes,
    allowedInArgument: !!props.allowedInArgument,
    allowedInText: !!props.allowedInText,
    allowedInMath: props.allowedInMath === void 0 ? true : props.allowedInMath,
    numOptionalArgs: props.numOptionalArgs || 0,
    infix: !!props.infix,
    primitive: !!props.primitive,
    handler
  };
  for (var i2 = 0; i2 < names.length; ++i2) {
    _functions[names[i2]] = data;
  }
  if (type) {
    if (htmlBuilder3) {
      _htmlGroupBuilders[type] = htmlBuilder3;
    }
    if (mathmlBuilder3) {
      _mathmlGroupBuilders[type] = mathmlBuilder3;
    }
  }
}
function defineFunctionBuilders(_ref2) {
  var {
    type,
    htmlBuilder: htmlBuilder3,
    mathmlBuilder: mathmlBuilder3
  } = _ref2;
  defineFunction({
    type,
    names: [],
    props: {
      numArgs: 0
    },
    handler() {
      throw new Error("Should never be called.");
    },
    htmlBuilder: htmlBuilder3,
    mathmlBuilder: mathmlBuilder3
  });
}
var normalizeArgument = function normalizeArgument2(arg) {
  return arg.type === "ordgroup" && arg.body.length === 1 ? arg.body[0] : arg;
};
var ordargument = function ordargument2(arg) {
  return arg.type === "ordgroup" ? arg.body : [arg];
};
var makeSpan$1 = buildCommon.makeSpan;
var binLeftCanceller = ["leftmost", "mbin", "mopen", "mrel", "mop", "mpunct"];
var binRightCanceller = ["rightmost", "mrel", "mclose", "mpunct"];
var styleMap$1 = {
  "display": Style$1.DISPLAY,
  "text": Style$1.TEXT,
  "script": Style$1.SCRIPT,
  "scriptscript": Style$1.SCRIPTSCRIPT
};
var DomEnum = {
  mord: "mord",
  mop: "mop",
  mbin: "mbin",
  mrel: "mrel",
  mopen: "mopen",
  mclose: "mclose",
  mpunct: "mpunct",
  minner: "minner"
};
var buildExpression$1 = function buildExpression(expression, options, isRealGroup, surrounding) {
  if (surrounding === void 0) {
    surrounding = [null, null];
  }
  var groups = [];
  for (var i2 = 0; i2 < expression.length; i2++) {
    var output = buildGroup$1(expression[i2], options);
    if (output instanceof DocumentFragment) {
      var children = output.children;
      groups.push(...children);
    } else {
      groups.push(output);
    }
  }
  buildCommon.tryCombineChars(groups);
  if (!isRealGroup) {
    return groups;
  }
  var glueOptions = options;
  if (expression.length === 1) {
    var node = expression[0];
    if (node.type === "sizing") {
      glueOptions = options.havingSize(node.size);
    } else if (node.type === "styling") {
      glueOptions = options.havingStyle(styleMap$1[node.style]);
    }
  }
  var dummyPrev = makeSpan$1([surrounding[0] || "leftmost"], [], options);
  var dummyNext = makeSpan$1([surrounding[1] || "rightmost"], [], options);
  var isRoot = isRealGroup === "root";
  traverseNonSpaceNodes(groups, (node2, prev) => {
    var prevType = prev.classes[0];
    var type = node2.classes[0];
    if (prevType === "mbin" && utils.contains(binRightCanceller, type)) {
      prev.classes[0] = "mord";
    } else if (type === "mbin" && utils.contains(binLeftCanceller, prevType)) {
      node2.classes[0] = "mord";
    }
  }, {
    node: dummyPrev
  }, dummyNext, isRoot);
  traverseNonSpaceNodes(groups, (node2, prev) => {
    var prevType = getTypeOfDomTree(prev);
    var type = getTypeOfDomTree(node2);
    var space = prevType && type ? node2.hasClass("mtight") ? tightSpacings[prevType][type] : spacings[prevType][type] : null;
    if (space) {
      return buildCommon.makeGlue(space, glueOptions);
    }
  }, {
    node: dummyPrev
  }, dummyNext, isRoot);
  return groups;
};
var traverseNonSpaceNodes = function traverseNonSpaceNodes2(nodes, callback, prev, next, isRoot) {
  if (next) {
    nodes.push(next);
  }
  var i2 = 0;
  for (; i2 < nodes.length; i2++) {
    var node = nodes[i2];
    var partialGroup = checkPartialGroup(node);
    if (partialGroup) {
      traverseNonSpaceNodes2(partialGroup.children, callback, prev, null, isRoot);
      continue;
    }
    var nonspace = !node.hasClass("mspace");
    if (nonspace) {
      var result = callback(node, prev.node);
      if (result) {
        if (prev.insertAfter) {
          prev.insertAfter(result);
        } else {
          nodes.unshift(result);
          i2++;
        }
      }
    }
    if (nonspace) {
      prev.node = node;
    } else if (isRoot && node.hasClass("newline")) {
      prev.node = makeSpan$1(["leftmost"]);
    }
    prev.insertAfter = /* @__PURE__ */ ((index) => (n) => {
      nodes.splice(index + 1, 0, n);
      i2++;
    })(i2);
  }
  if (next) {
    nodes.pop();
  }
};
var checkPartialGroup = function checkPartialGroup2(node) {
  if (node instanceof DocumentFragment || node instanceof Anchor || node instanceof Span && node.hasClass("enclosing")) {
    return node;
  }
  return null;
};
var getOutermostNode = function getOutermostNode2(node, side) {
  var partialGroup = checkPartialGroup(node);
  if (partialGroup) {
    var children = partialGroup.children;
    if (children.length) {
      if (side === "right") {
        return getOutermostNode2(children[children.length - 1], "right");
      } else if (side === "left") {
        return getOutermostNode2(children[0], "left");
      }
    }
  }
  return node;
};
var getTypeOfDomTree = function getTypeOfDomTree2(node, side) {
  if (!node) {
    return null;
  }
  if (side) {
    node = getOutermostNode(node, side);
  }
  return DomEnum[node.classes[0]] || null;
};
var makeNullDelimiter = function makeNullDelimiter2(options, classes) {
  var moreClasses = ["nulldelimiter"].concat(options.baseSizingClasses());
  return makeSpan$1(classes.concat(moreClasses));
};
var buildGroup$1 = function buildGroup(group, options, baseOptions) {
  if (!group) {
    return makeSpan$1();
  }
  if (_htmlGroupBuilders[group.type]) {
    var groupNode = _htmlGroupBuilders[group.type](group, options);
    if (baseOptions && options.size !== baseOptions.size) {
      groupNode = makeSpan$1(options.sizingClasses(baseOptions), [groupNode], options);
      var multiplier = options.sizeMultiplier / baseOptions.sizeMultiplier;
      groupNode.height *= multiplier;
      groupNode.depth *= multiplier;
    }
    return groupNode;
  } else {
    throw new ParseError("Got group of unknown type: '" + group.type + "'");
  }
};
function buildHTMLUnbreakable(children, options) {
  var body = makeSpan$1(["base"], children, options);
  var strut = makeSpan$1(["strut"]);
  strut.style.height = makeEm(body.height + body.depth);
  if (body.depth) {
    strut.style.verticalAlign = makeEm(-body.depth);
  }
  body.children.unshift(strut);
  return body;
}
function buildHTML(tree, options) {
  var tag = null;
  if (tree.length === 1 && tree[0].type === "tag") {
    tag = tree[0].tag;
    tree = tree[0].body;
  }
  var expression = buildExpression$1(tree, options, "root");
  var eqnNum;
  if (expression.length === 2 && expression[1].hasClass("tag")) {
    eqnNum = expression.pop();
  }
  var children = [];
  var parts = [];
  for (var i2 = 0; i2 < expression.length; i2++) {
    parts.push(expression[i2]);
    if (expression[i2].hasClass("mbin") || expression[i2].hasClass("mrel") || expression[i2].hasClass("allowbreak")) {
      var nobreak = false;
      while (i2 < expression.length - 1 && expression[i2 + 1].hasClass("mspace") && !expression[i2 + 1].hasClass("newline")) {
        i2++;
        parts.push(expression[i2]);
        if (expression[i2].hasClass("nobreak")) {
          nobreak = true;
        }
      }
      if (!nobreak) {
        children.push(buildHTMLUnbreakable(parts, options));
        parts = [];
      }
    } else if (expression[i2].hasClass("newline")) {
      parts.pop();
      if (parts.length > 0) {
        children.push(buildHTMLUnbreakable(parts, options));
        parts = [];
      }
      children.push(expression[i2]);
    }
  }
  if (parts.length > 0) {
    children.push(buildHTMLUnbreakable(parts, options));
  }
  var tagChild;
  if (tag) {
    tagChild = buildHTMLUnbreakable(buildExpression$1(tag, options, true));
    tagChild.classes = ["tag"];
    children.push(tagChild);
  } else if (eqnNum) {
    children.push(eqnNum);
  }
  var htmlNode = makeSpan$1(["katex-html"], children);
  htmlNode.setAttribute("aria-hidden", "true");
  if (tagChild) {
    var strut = tagChild.children[0];
    strut.style.height = makeEm(htmlNode.height + htmlNode.depth);
    if (htmlNode.depth) {
      strut.style.verticalAlign = makeEm(-htmlNode.depth);
    }
  }
  return htmlNode;
}
function newDocumentFragment(children) {
  return new DocumentFragment(children);
}
var MathNode = class {
  constructor(type, children, classes) {
    this.type = void 0;
    this.attributes = void 0;
    this.children = void 0;
    this.classes = void 0;
    this.type = type;
    this.attributes = {};
    this.children = children || [];
    this.classes = classes || [];
  }
  /**
   * Sets an attribute on a MathML node. MathML depends on attributes to convey a
   * semantic content, so this is used heavily.
   */
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  /**
   * Gets an attribute on a MathML node.
   */
  getAttribute(name) {
    return this.attributes[name];
  }
  /**
   * Converts the math node into a MathML-namespaced DOM element.
   */
  toNode() {
    var node = document.createElementNS("http://www.w3.org/1998/Math/MathML", this.type);
    for (var attr in this.attributes) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, attr)) {
        node.setAttribute(attr, this.attributes[attr]);
      }
    }
    if (this.classes.length > 0) {
      node.className = createClass(this.classes);
    }
    for (var i2 = 0; i2 < this.children.length; i2++) {
      if (this.children[i2] instanceof TextNode && this.children[i2 + 1] instanceof TextNode) {
        var text2 = this.children[i2].toText() + this.children[++i2].toText();
        while (this.children[i2 + 1] instanceof TextNode) {
          text2 += this.children[++i2].toText();
        }
        node.appendChild(new TextNode(text2).toNode());
      } else {
        node.appendChild(this.children[i2].toNode());
      }
    }
    return node;
  }
  /**
   * Converts the math node into an HTML markup string.
   */
  toMarkup() {
    var markup = "<" + this.type;
    for (var attr in this.attributes) {
      if (Object.prototype.hasOwnProperty.call(this.attributes, attr)) {
        markup += " " + attr + '="';
        markup += utils.escape(this.attributes[attr]);
        markup += '"';
      }
    }
    if (this.classes.length > 0) {
      markup += ' class ="' + utils.escape(createClass(this.classes)) + '"';
    }
    markup += ">";
    for (var i2 = 0; i2 < this.children.length; i2++) {
      markup += this.children[i2].toMarkup();
    }
    markup += "</" + this.type + ">";
    return markup;
  }
  /**
   * Converts the math node into a string, similar to innerText, but escaped.
   */
  toText() {
    return this.children.map((child) => child.toText()).join("");
  }
};
var TextNode = class {
  constructor(text2) {
    this.text = void 0;
    this.text = text2;
  }
  /**
   * Converts the text node into a DOM text node.
   */
  toNode() {
    return document.createTextNode(this.text);
  }
  /**
   * Converts the text node into escaped HTML markup
   * (representing the text itself).
   */
  toMarkup() {
    return utils.escape(this.toText());
  }
  /**
   * Converts the text node into a string
   * (representing the text itself).
   */
  toText() {
    return this.text;
  }
};
var SpaceNode = class {
  /**
   * Create a Space node with width given in CSS ems.
   */
  constructor(width) {
    this.width = void 0;
    this.character = void 0;
    this.width = width;
    if (width >= 0.05555 && width <= 0.05556) {
      this.character = "\u200A";
    } else if (width >= 0.1666 && width <= 0.1667) {
      this.character = "\u2009";
    } else if (width >= 0.2222 && width <= 0.2223) {
      this.character = "\u2005";
    } else if (width >= 0.2777 && width <= 0.2778) {
      this.character = "\u2005\u200A";
    } else if (width >= -0.05556 && width <= -0.05555) {
      this.character = "\u200A\u2063";
    } else if (width >= -0.1667 && width <= -0.1666) {
      this.character = "\u2009\u2063";
    } else if (width >= -0.2223 && width <= -0.2222) {
      this.character = "\u205F\u2063";
    } else if (width >= -0.2778 && width <= -0.2777) {
      this.character = "\u2005\u2063";
    } else {
      this.character = null;
    }
  }
  /**
   * Converts the math node into a MathML-namespaced DOM element.
   */
  toNode() {
    if (this.character) {
      return document.createTextNode(this.character);
    } else {
      var node = document.createElementNS("http://www.w3.org/1998/Math/MathML", "mspace");
      node.setAttribute("width", makeEm(this.width));
      return node;
    }
  }
  /**
   * Converts the math node into an HTML markup string.
   */
  toMarkup() {
    if (this.character) {
      return "<mtext>" + this.character + "</mtext>";
    } else {
      return '<mspace width="' + makeEm(this.width) + '"/>';
    }
  }
  /**
   * Converts the math node into a string, similar to innerText.
   */
  toText() {
    if (this.character) {
      return this.character;
    } else {
      return " ";
    }
  }
};
var mathMLTree = {
  MathNode,
  TextNode,
  SpaceNode,
  newDocumentFragment
};
var makeText = function makeText2(text2, mode, options) {
  if (symbols[mode][text2] && symbols[mode][text2].replace && text2.charCodeAt(0) !== 55349 && !(ligatures.hasOwnProperty(text2) && options && (options.fontFamily && options.fontFamily.slice(4, 6) === "tt" || options.font && options.font.slice(4, 6) === "tt"))) {
    text2 = symbols[mode][text2].replace;
  }
  return new mathMLTree.TextNode(text2);
};
var makeRow = function makeRow2(body) {
  if (body.length === 1) {
    return body[0];
  } else {
    return new mathMLTree.MathNode("mrow", body);
  }
};
var getVariant = function getVariant2(group, options) {
  if (options.fontFamily === "texttt") {
    return "monospace";
  } else if (options.fontFamily === "textsf") {
    if (options.fontShape === "textit" && options.fontWeight === "textbf") {
      return "sans-serif-bold-italic";
    } else if (options.fontShape === "textit") {
      return "sans-serif-italic";
    } else if (options.fontWeight === "textbf") {
      return "bold-sans-serif";
    } else {
      return "sans-serif";
    }
  } else if (options.fontShape === "textit" && options.fontWeight === "textbf") {
    return "bold-italic";
  } else if (options.fontShape === "textit") {
    return "italic";
  } else if (options.fontWeight === "textbf") {
    return "bold";
  }
  var font = options.font;
  if (!font || font === "mathnormal") {
    return null;
  }
  var mode = group.mode;
  if (font === "mathit") {
    return "italic";
  } else if (font === "boldsymbol") {
    return group.type === "textord" ? "bold" : "bold-italic";
  } else if (font === "mathbf") {
    return "bold";
  } else if (font === "mathbb") {
    return "double-struck";
  } else if (font === "mathsfit") {
    return "sans-serif-italic";
  } else if (font === "mathfrak") {
    return "fraktur";
  } else if (font === "mathscr" || font === "mathcal") {
    return "script";
  } else if (font === "mathsf") {
    return "sans-serif";
  } else if (font === "mathtt") {
    return "monospace";
  }
  var text2 = group.text;
  if (utils.contains(["\\imath", "\\jmath"], text2)) {
    return null;
  }
  if (symbols[mode][text2] && symbols[mode][text2].replace) {
    text2 = symbols[mode][text2].replace;
  }
  var fontName = buildCommon.fontMap[font].fontName;
  if (getCharacterMetrics(text2, fontName, mode)) {
    return buildCommon.fontMap[font].variant;
  }
  return null;
};
function isNumberPunctuation(group) {
  if (!group) {
    return false;
  }
  if (group.type === "mi" && group.children.length === 1) {
    var child = group.children[0];
    return child instanceof TextNode && child.text === ".";
  } else if (group.type === "mo" && group.children.length === 1 && group.getAttribute("separator") === "true" && group.getAttribute("lspace") === "0em" && group.getAttribute("rspace") === "0em") {
    var _child = group.children[0];
    return _child instanceof TextNode && _child.text === ",";
  } else {
    return false;
  }
}
var buildExpression2 = function buildExpression3(expression, options, isOrdgroup) {
  if (expression.length === 1) {
    var group = buildGroup2(expression[0], options);
    if (isOrdgroup && group instanceof MathNode && group.type === "mo") {
      group.setAttribute("lspace", "0em");
      group.setAttribute("rspace", "0em");
    }
    return [group];
  }
  var groups = [];
  var lastGroup;
  for (var i2 = 0; i2 < expression.length; i2++) {
    var _group = buildGroup2(expression[i2], options);
    if (_group instanceof MathNode && lastGroup instanceof MathNode) {
      if (_group.type === "mtext" && lastGroup.type === "mtext" && _group.getAttribute("mathvariant") === lastGroup.getAttribute("mathvariant")) {
        lastGroup.children.push(..._group.children);
        continue;
      } else if (_group.type === "mn" && lastGroup.type === "mn") {
        lastGroup.children.push(..._group.children);
        continue;
      } else if (isNumberPunctuation(_group) && lastGroup.type === "mn") {
        lastGroup.children.push(..._group.children);
        continue;
      } else if (_group.type === "mn" && isNumberPunctuation(lastGroup)) {
        _group.children = [...lastGroup.children, ..._group.children];
        groups.pop();
      } else if ((_group.type === "msup" || _group.type === "msub") && _group.children.length >= 1 && (lastGroup.type === "mn" || isNumberPunctuation(lastGroup))) {
        var base = _group.children[0];
        if (base instanceof MathNode && base.type === "mn") {
          base.children = [...lastGroup.children, ...base.children];
          groups.pop();
        }
      } else if (lastGroup.type === "mi" && lastGroup.children.length === 1) {
        var lastChild = lastGroup.children[0];
        if (lastChild instanceof TextNode && lastChild.text === "\u0338" && (_group.type === "mo" || _group.type === "mi" || _group.type === "mn")) {
          var child = _group.children[0];
          if (child instanceof TextNode && child.text.length > 0) {
            child.text = child.text.slice(0, 1) + "\u0338" + child.text.slice(1);
            groups.pop();
          }
        }
      }
    }
    groups.push(_group);
    lastGroup = _group;
  }
  return groups;
};
var buildExpressionRow = function buildExpressionRow2(expression, options, isOrdgroup) {
  return makeRow(buildExpression2(expression, options, isOrdgroup));
};
var buildGroup2 = function buildGroup3(group, options) {
  if (!group) {
    return new mathMLTree.MathNode("mrow");
  }
  if (_mathmlGroupBuilders[group.type]) {
    var result = _mathmlGroupBuilders[group.type](group, options);
    return result;
  } else {
    throw new ParseError("Got group of unknown type: '" + group.type + "'");
  }
};
function buildMathML(tree, texExpression, options, isDisplayMode, forMathmlOnly) {
  var expression = buildExpression2(tree, options);
  var wrapper;
  if (expression.length === 1 && expression[0] instanceof MathNode && utils.contains(["mrow", "mtable"], expression[0].type)) {
    wrapper = expression[0];
  } else {
    wrapper = new mathMLTree.MathNode("mrow", expression);
  }
  var annotation = new mathMLTree.MathNode("annotation", [new mathMLTree.TextNode(texExpression)]);
  annotation.setAttribute("encoding", "application/x-tex");
  var semantics = new mathMLTree.MathNode("semantics", [wrapper, annotation]);
  var math2 = new mathMLTree.MathNode("math", [semantics]);
  math2.setAttribute("xmlns", "http://www.w3.org/1998/Math/MathML");
  if (isDisplayMode) {
    math2.setAttribute("display", "block");
  }
  var wrapperClass = forMathmlOnly ? "katex" : "katex-mathml";
  return buildCommon.makeSpan([wrapperClass], [math2]);
}
var optionsFromSettings = function optionsFromSettings2(settings) {
  return new Options({
    style: settings.displayMode ? Style$1.DISPLAY : Style$1.TEXT,
    maxSize: settings.maxSize,
    minRuleThickness: settings.minRuleThickness
  });
};
var displayWrap = function displayWrap2(node, settings) {
  if (settings.displayMode) {
    var classes = ["katex-display"];
    if (settings.leqno) {
      classes.push("leqno");
    }
    if (settings.fleqn) {
      classes.push("fleqn");
    }
    node = buildCommon.makeSpan(classes, [node]);
  }
  return node;
};
var buildTree = function buildTree2(tree, expression, settings) {
  var options = optionsFromSettings(settings);
  var katexNode;
  if (settings.output === "mathml") {
    return buildMathML(tree, expression, options, settings.displayMode, true);
  } else if (settings.output === "html") {
    var htmlNode = buildHTML(tree, options);
    katexNode = buildCommon.makeSpan(["katex"], [htmlNode]);
  } else {
    var mathMLNode = buildMathML(tree, expression, options, settings.displayMode, false);
    var _htmlNode = buildHTML(tree, options);
    katexNode = buildCommon.makeSpan(["katex"], [mathMLNode, _htmlNode]);
  }
  return displayWrap(katexNode, settings);
};
var stretchyCodePoint = {
  widehat: "^",
  widecheck: "\u02C7",
  widetilde: "~",
  utilde: "~",
  overleftarrow: "\u2190",
  underleftarrow: "\u2190",
  xleftarrow: "\u2190",
  overrightarrow: "\u2192",
  underrightarrow: "\u2192",
  xrightarrow: "\u2192",
  underbrace: "\u23DF",
  overbrace: "\u23DE",
  overgroup: "\u23E0",
  undergroup: "\u23E1",
  overleftrightarrow: "\u2194",
  underleftrightarrow: "\u2194",
  xleftrightarrow: "\u2194",
  Overrightarrow: "\u21D2",
  xRightarrow: "\u21D2",
  overleftharpoon: "\u21BC",
  xleftharpoonup: "\u21BC",
  overrightharpoon: "\u21C0",
  xrightharpoonup: "\u21C0",
  xLeftarrow: "\u21D0",
  xLeftrightarrow: "\u21D4",
  xhookleftarrow: "\u21A9",
  xhookrightarrow: "\u21AA",
  xmapsto: "\u21A6",
  xrightharpoondown: "\u21C1",
  xleftharpoondown: "\u21BD",
  xrightleftharpoons: "\u21CC",
  xleftrightharpoons: "\u21CB",
  xtwoheadleftarrow: "\u219E",
  xtwoheadrightarrow: "\u21A0",
  xlongequal: "=",
  xtofrom: "\u21C4",
  xrightleftarrows: "\u21C4",
  xrightequilibrium: "\u21CC",
  // Not a perfect match.
  xleftequilibrium: "\u21CB",
  // None better available.
  "\\cdrightarrow": "\u2192",
  "\\cdleftarrow": "\u2190",
  "\\cdlongequal": "="
};
var mathMLnode = function mathMLnode2(label) {
  var node = new mathMLTree.MathNode("mo", [new mathMLTree.TextNode(stretchyCodePoint[label.replace(/^\\/, "")])]);
  node.setAttribute("stretchy", "true");
  return node;
};
var katexImagesData = {
  //   path(s), minWidth, height, align
  overrightarrow: [["rightarrow"], 0.888, 522, "xMaxYMin"],
  overleftarrow: [["leftarrow"], 0.888, 522, "xMinYMin"],
  underrightarrow: [["rightarrow"], 0.888, 522, "xMaxYMin"],
  underleftarrow: [["leftarrow"], 0.888, 522, "xMinYMin"],
  xrightarrow: [["rightarrow"], 1.469, 522, "xMaxYMin"],
  "\\cdrightarrow": [["rightarrow"], 3, 522, "xMaxYMin"],
  // CD minwwidth2.5pc
  xleftarrow: [["leftarrow"], 1.469, 522, "xMinYMin"],
  "\\cdleftarrow": [["leftarrow"], 3, 522, "xMinYMin"],
  Overrightarrow: [["doublerightarrow"], 0.888, 560, "xMaxYMin"],
  xRightarrow: [["doublerightarrow"], 1.526, 560, "xMaxYMin"],
  xLeftarrow: [["doubleleftarrow"], 1.526, 560, "xMinYMin"],
  overleftharpoon: [["leftharpoon"], 0.888, 522, "xMinYMin"],
  xleftharpoonup: [["leftharpoon"], 0.888, 522, "xMinYMin"],
  xleftharpoondown: [["leftharpoondown"], 0.888, 522, "xMinYMin"],
  overrightharpoon: [["rightharpoon"], 0.888, 522, "xMaxYMin"],
  xrightharpoonup: [["rightharpoon"], 0.888, 522, "xMaxYMin"],
  xrightharpoondown: [["rightharpoondown"], 0.888, 522, "xMaxYMin"],
  xlongequal: [["longequal"], 0.888, 334, "xMinYMin"],
  "\\cdlongequal": [["longequal"], 3, 334, "xMinYMin"],
  xtwoheadleftarrow: [["twoheadleftarrow"], 0.888, 334, "xMinYMin"],
  xtwoheadrightarrow: [["twoheadrightarrow"], 0.888, 334, "xMaxYMin"],
  overleftrightarrow: [["leftarrow", "rightarrow"], 0.888, 522],
  overbrace: [["leftbrace", "midbrace", "rightbrace"], 1.6, 548],
  underbrace: [["leftbraceunder", "midbraceunder", "rightbraceunder"], 1.6, 548],
  underleftrightarrow: [["leftarrow", "rightarrow"], 0.888, 522],
  xleftrightarrow: [["leftarrow", "rightarrow"], 1.75, 522],
  xLeftrightarrow: [["doubleleftarrow", "doublerightarrow"], 1.75, 560],
  xrightleftharpoons: [["leftharpoondownplus", "rightharpoonplus"], 1.75, 716],
  xleftrightharpoons: [["leftharpoonplus", "rightharpoondownplus"], 1.75, 716],
  xhookleftarrow: [["leftarrow", "righthook"], 1.08, 522],
  xhookrightarrow: [["lefthook", "rightarrow"], 1.08, 522],
  overlinesegment: [["leftlinesegment", "rightlinesegment"], 0.888, 522],
  underlinesegment: [["leftlinesegment", "rightlinesegment"], 0.888, 522],
  overgroup: [["leftgroup", "rightgroup"], 0.888, 342],
  undergroup: [["leftgroupunder", "rightgroupunder"], 0.888, 342],
  xmapsto: [["leftmapsto", "rightarrow"], 1.5, 522],
  xtofrom: [["leftToFrom", "rightToFrom"], 1.75, 528],
  // The next three arrows are from the mhchem package.
  // In mhchem.sty, min-length is 2.0em. But these arrows might appear in the
  // document as \xrightarrow or \xrightleftharpoons. Those have
  // min-length = 1.75em, so we set min-length on these next three to match.
  xrightleftarrows: [["baraboveleftarrow", "rightarrowabovebar"], 1.75, 901],
  xrightequilibrium: [["baraboveshortleftharpoon", "rightharpoonaboveshortbar"], 1.75, 716],
  xleftequilibrium: [["shortbaraboveleftharpoon", "shortrightharpoonabovebar"], 1.75, 716]
};
var groupLength = function groupLength2(arg) {
  if (arg.type === "ordgroup") {
    return arg.body.length;
  } else {
    return 1;
  }
};
var svgSpan = function svgSpan2(group, options) {
  function buildSvgSpan_() {
    var viewBoxWidth = 4e5;
    var label = group.label.slice(1);
    if (utils.contains(["widehat", "widecheck", "widetilde", "utilde"], label)) {
      var grp = group;
      var numChars = groupLength(grp.base);
      var viewBoxHeight;
      var pathName;
      var _height;
      if (numChars > 5) {
        if (label === "widehat" || label === "widecheck") {
          viewBoxHeight = 420;
          viewBoxWidth = 2364;
          _height = 0.42;
          pathName = label + "4";
        } else {
          viewBoxHeight = 312;
          viewBoxWidth = 2340;
          _height = 0.34;
          pathName = "tilde4";
        }
      } else {
        var imgIndex = [1, 1, 2, 2, 3, 3][numChars];
        if (label === "widehat" || label === "widecheck") {
          viewBoxWidth = [0, 1062, 2364, 2364, 2364][imgIndex];
          viewBoxHeight = [0, 239, 300, 360, 420][imgIndex];
          _height = [0, 0.24, 0.3, 0.3, 0.36, 0.42][imgIndex];
          pathName = label + imgIndex;
        } else {
          viewBoxWidth = [0, 600, 1033, 2339, 2340][imgIndex];
          viewBoxHeight = [0, 260, 286, 306, 312][imgIndex];
          _height = [0, 0.26, 0.286, 0.3, 0.306, 0.34][imgIndex];
          pathName = "tilde" + imgIndex;
        }
      }
      var path2 = new PathNode(pathName);
      var svgNode = new SvgNode([path2], {
        "width": "100%",
        "height": makeEm(_height),
        "viewBox": "0 0 " + viewBoxWidth + " " + viewBoxHeight,
        "preserveAspectRatio": "none"
      });
      return {
        span: buildCommon.makeSvgSpan([], [svgNode], options),
        minWidth: 0,
        height: _height
      };
    } else {
      var spans = [];
      var data = katexImagesData[label];
      var [paths, _minWidth, _viewBoxHeight] = data;
      var _height2 = _viewBoxHeight / 1e3;
      var numSvgChildren = paths.length;
      var widthClasses;
      var aligns;
      if (numSvgChildren === 1) {
        var align1 = data[3];
        widthClasses = ["hide-tail"];
        aligns = [align1];
      } else if (numSvgChildren === 2) {
        widthClasses = ["halfarrow-left", "halfarrow-right"];
        aligns = ["xMinYMin", "xMaxYMin"];
      } else if (numSvgChildren === 3) {
        widthClasses = ["brace-left", "brace-center", "brace-right"];
        aligns = ["xMinYMin", "xMidYMin", "xMaxYMin"];
      } else {
        throw new Error("Correct katexImagesData or update code here to support\n                    " + numSvgChildren + " children.");
      }
      for (var i2 = 0; i2 < numSvgChildren; i2++) {
        var _path = new PathNode(paths[i2]);
        var _svgNode = new SvgNode([_path], {
          "width": "400em",
          "height": makeEm(_height2),
          "viewBox": "0 0 " + viewBoxWidth + " " + _viewBoxHeight,
          "preserveAspectRatio": aligns[i2] + " slice"
        });
        var _span = buildCommon.makeSvgSpan([widthClasses[i2]], [_svgNode], options);
        if (numSvgChildren === 1) {
          return {
            span: _span,
            minWidth: _minWidth,
            height: _height2
          };
        } else {
          _span.style.height = makeEm(_height2);
          spans.push(_span);
        }
      }
      return {
        span: buildCommon.makeSpan(["stretchy"], spans, options),
        minWidth: _minWidth,
        height: _height2
      };
    }
  }
  var {
    span,
    minWidth,
    height
  } = buildSvgSpan_();
  span.height = height;
  span.style.height = makeEm(height);
  if (minWidth > 0) {
    span.style.minWidth = makeEm(minWidth);
  }
  return span;
};
var encloseSpan = function encloseSpan2(inner2, label, topPad, bottomPad, options) {
  var img;
  var totalHeight = inner2.height + inner2.depth + topPad + bottomPad;
  if (/fbox|color|angl/.test(label)) {
    img = buildCommon.makeSpan(["stretchy", label], [], options);
    if (label === "fbox") {
      var color = options.color && options.getColor();
      if (color) {
        img.style.borderColor = color;
      }
    }
  } else {
    var lines = [];
    if (/^[bx]cancel$/.test(label)) {
      lines.push(new LineNode({
        "x1": "0",
        "y1": "0",
        "x2": "100%",
        "y2": "100%",
        "stroke-width": "0.046em"
      }));
    }
    if (/^x?cancel$/.test(label)) {
      lines.push(new LineNode({
        "x1": "0",
        "y1": "100%",
        "x2": "100%",
        "y2": "0",
        "stroke-width": "0.046em"
      }));
    }
    var svgNode = new SvgNode(lines, {
      "width": "100%",
      "height": makeEm(totalHeight)
    });
    img = buildCommon.makeSvgSpan([], [svgNode], options);
  }
  img.height = totalHeight;
  img.style.height = makeEm(totalHeight);
  return img;
};
var stretchy = {
  encloseSpan,
  mathMLnode,
  svgSpan
};
function assertNodeType(node, type) {
  if (!node || node.type !== type) {
    throw new Error("Expected node of type " + type + ", but got " + (node ? "node of type " + node.type : String(node)));
  }
  return node;
}
function assertSymbolNodeType(node) {
  var typedNode = checkSymbolNodeType(node);
  if (!typedNode) {
    throw new Error("Expected node of symbol group type, but got " + (node ? "node of type " + node.type : String(node)));
  }
  return typedNode;
}
function checkSymbolNodeType(node) {
  if (node && (node.type === "atom" || NON_ATOMS.hasOwnProperty(node.type))) {
    return node;
  }
  return null;
}
var htmlBuilder$a = (grp, options) => {
  var base;
  var group;
  var supSubGroup;
  if (grp && grp.type === "supsub") {
    group = assertNodeType(grp.base, "accent");
    base = group.base;
    grp.base = base;
    supSubGroup = assertSpan(buildGroup$1(grp, options));
    grp.base = group;
  } else {
    group = assertNodeType(grp, "accent");
    base = group.base;
  }
  var body = buildGroup$1(base, options.havingCrampedStyle());
  var mustShift = group.isShifty && utils.isCharacterBox(base);
  var skew = 0;
  if (mustShift) {
    var baseChar = utils.getBaseElem(base);
    var baseGroup = buildGroup$1(baseChar, options.havingCrampedStyle());
    skew = assertSymbolDomNode(baseGroup).skew;
  }
  var accentBelow = group.label === "\\c";
  var clearance = accentBelow ? body.height + body.depth : Math.min(body.height, options.fontMetrics().xHeight);
  var accentBody;
  if (!group.isStretchy) {
    var accent2;
    var width;
    if (group.label === "\\vec") {
      accent2 = buildCommon.staticSvg("vec", options);
      width = buildCommon.svgData.vec[1];
    } else {
      accent2 = buildCommon.makeOrd({
        mode: group.mode,
        text: group.label
      }, options, "textord");
      accent2 = assertSymbolDomNode(accent2);
      accent2.italic = 0;
      width = accent2.width;
      if (accentBelow) {
        clearance += accent2.depth;
      }
    }
    accentBody = buildCommon.makeSpan(["accent-body"], [accent2]);
    var accentFull = group.label === "\\textcircled";
    if (accentFull) {
      accentBody.classes.push("accent-full");
      clearance = body.height;
    }
    var left = skew;
    if (!accentFull) {
      left -= width / 2;
    }
    accentBody.style.left = makeEm(left);
    if (group.label === "\\textcircled") {
      accentBody.style.top = ".2em";
    }
    accentBody = buildCommon.makeVList({
      positionType: "firstBaseline",
      children: [{
        type: "elem",
        elem: body
      }, {
        type: "kern",
        size: -clearance
      }, {
        type: "elem",
        elem: accentBody
      }]
    }, options);
  } else {
    accentBody = stretchy.svgSpan(group, options);
    accentBody = buildCommon.makeVList({
      positionType: "firstBaseline",
      children: [{
        type: "elem",
        elem: body
      }, {
        type: "elem",
        elem: accentBody,
        wrapperClasses: ["svg-align"],
        wrapperStyle: skew > 0 ? {
          width: "calc(100% - " + makeEm(2 * skew) + ")",
          marginLeft: makeEm(2 * skew)
        } : void 0
      }]
    }, options);
  }
  var accentWrap = buildCommon.makeSpan(["mord", "accent"], [accentBody], options);
  if (supSubGroup) {
    supSubGroup.children[0] = accentWrap;
    supSubGroup.height = Math.max(accentWrap.height, supSubGroup.height);
    supSubGroup.classes[0] = "mord";
    return supSubGroup;
  } else {
    return accentWrap;
  }
};
var mathmlBuilder$9 = (group, options) => {
  var accentNode = group.isStretchy ? stretchy.mathMLnode(group.label) : new mathMLTree.MathNode("mo", [makeText(group.label, group.mode)]);
  var node = new mathMLTree.MathNode("mover", [buildGroup2(group.base, options), accentNode]);
  node.setAttribute("accent", "true");
  return node;
};
var NON_STRETCHY_ACCENT_REGEX = new RegExp(["\\acute", "\\grave", "\\ddot", "\\tilde", "\\bar", "\\breve", "\\check", "\\hat", "\\vec", "\\dot", "\\mathring"].map((accent2) => "\\" + accent2).join("|"));
defineFunction({
  type: "accent",
  names: ["\\acute", "\\grave", "\\ddot", "\\tilde", "\\bar", "\\breve", "\\check", "\\hat", "\\vec", "\\dot", "\\mathring", "\\widecheck", "\\widehat", "\\widetilde", "\\overrightarrow", "\\overleftarrow", "\\Overrightarrow", "\\overleftrightarrow", "\\overgroup", "\\overlinesegment", "\\overleftharpoon", "\\overrightharpoon"],
  props: {
    numArgs: 1
  },
  handler: (context, args) => {
    var base = normalizeArgument(args[0]);
    var isStretchy = !NON_STRETCHY_ACCENT_REGEX.test(context.funcName);
    var isShifty = !isStretchy || context.funcName === "\\widehat" || context.funcName === "\\widetilde" || context.funcName === "\\widecheck";
    return {
      type: "accent",
      mode: context.parser.mode,
      label: context.funcName,
      isStretchy,
      isShifty,
      base
    };
  },
  htmlBuilder: htmlBuilder$a,
  mathmlBuilder: mathmlBuilder$9
});
defineFunction({
  type: "accent",
  names: ["\\'", "\\`", "\\^", "\\~", "\\=", "\\u", "\\.", '\\"', "\\c", "\\r", "\\H", "\\v", "\\textcircled"],
  props: {
    numArgs: 1,
    allowedInText: true,
    allowedInMath: true,
    // unless in strict mode
    argTypes: ["primitive"]
  },
  handler: (context, args) => {
    var base = args[0];
    var mode = context.parser.mode;
    if (mode === "math") {
      context.parser.settings.reportNonstrict("mathVsTextAccents", "LaTeX's accent " + context.funcName + " works only in text mode");
      mode = "text";
    }
    return {
      type: "accent",
      mode,
      label: context.funcName,
      isStretchy: false,
      isShifty: true,
      base
    };
  },
  htmlBuilder: htmlBuilder$a,
  mathmlBuilder: mathmlBuilder$9
});
defineFunction({
  type: "accentUnder",
  names: ["\\underleftarrow", "\\underrightarrow", "\\underleftrightarrow", "\\undergroup", "\\underlinesegment", "\\utilde"],
  props: {
    numArgs: 1
  },
  handler: (_ref, args) => {
    var {
      parser,
      funcName
    } = _ref;
    var base = args[0];
    return {
      type: "accentUnder",
      mode: parser.mode,
      label: funcName,
      base
    };
  },
  htmlBuilder: (group, options) => {
    var innerGroup = buildGroup$1(group.base, options);
    var accentBody = stretchy.svgSpan(group, options);
    var kern = group.label === "\\utilde" ? 0.12 : 0;
    var vlist = buildCommon.makeVList({
      positionType: "top",
      positionData: innerGroup.height,
      children: [{
        type: "elem",
        elem: accentBody,
        wrapperClasses: ["svg-align"]
      }, {
        type: "kern",
        size: kern
      }, {
        type: "elem",
        elem: innerGroup
      }]
    }, options);
    return buildCommon.makeSpan(["mord", "accentunder"], [vlist], options);
  },
  mathmlBuilder: (group, options) => {
    var accentNode = stretchy.mathMLnode(group.label);
    var node = new mathMLTree.MathNode("munder", [buildGroup2(group.base, options), accentNode]);
    node.setAttribute("accentunder", "true");
    return node;
  }
});
var paddedNode = (group) => {
  var node = new mathMLTree.MathNode("mpadded", group ? [group] : []);
  node.setAttribute("width", "+0.6em");
  node.setAttribute("lspace", "0.3em");
  return node;
};
defineFunction({
  type: "xArrow",
  names: [
    "\\xleftarrow",
    "\\xrightarrow",
    "\\xLeftarrow",
    "\\xRightarrow",
    "\\xleftrightarrow",
    "\\xLeftrightarrow",
    "\\xhookleftarrow",
    "\\xhookrightarrow",
    "\\xmapsto",
    "\\xrightharpoondown",
    "\\xrightharpoonup",
    "\\xleftharpoondown",
    "\\xleftharpoonup",
    "\\xrightleftharpoons",
    "\\xleftrightharpoons",
    "\\xlongequal",
    "\\xtwoheadrightarrow",
    "\\xtwoheadleftarrow",
    "\\xtofrom",
    // The next 3 functions are here to support the mhchem extension.
    // Direct use of these functions is discouraged and may break someday.
    "\\xrightleftarrows",
    "\\xrightequilibrium",
    "\\xleftequilibrium",
    // The next 3 functions are here only to support the {CD} environment.
    "\\\\cdrightarrow",
    "\\\\cdleftarrow",
    "\\\\cdlongequal"
  ],
  props: {
    numArgs: 1,
    numOptionalArgs: 1
  },
  handler(_ref, args, optArgs) {
    var {
      parser,
      funcName
    } = _ref;
    return {
      type: "xArrow",
      mode: parser.mode,
      label: funcName,
      body: args[0],
      below: optArgs[0]
    };
  },
  // Flow is unable to correctly infer the type of `group`, even though it's
  // unambiguously determined from the passed-in `type` above.
  htmlBuilder(group, options) {
    var style = options.style;
    var newOptions = options.havingStyle(style.sup());
    var upperGroup = buildCommon.wrapFragment(buildGroup$1(group.body, newOptions, options), options);
    var arrowPrefix = group.label.slice(0, 2) === "\\x" ? "x" : "cd";
    upperGroup.classes.push(arrowPrefix + "-arrow-pad");
    var lowerGroup;
    if (group.below) {
      newOptions = options.havingStyle(style.sub());
      lowerGroup = buildCommon.wrapFragment(buildGroup$1(group.below, newOptions, options), options);
      lowerGroup.classes.push(arrowPrefix + "-arrow-pad");
    }
    var arrowBody = stretchy.svgSpan(group, options);
    var arrowShift = -options.fontMetrics().axisHeight + 0.5 * arrowBody.height;
    var upperShift = -options.fontMetrics().axisHeight - 0.5 * arrowBody.height - 0.111;
    if (upperGroup.depth > 0.25 || group.label === "\\xleftequilibrium") {
      upperShift -= upperGroup.depth;
    }
    var vlist;
    if (lowerGroup) {
      var lowerShift = -options.fontMetrics().axisHeight + lowerGroup.height + 0.5 * arrowBody.height + 0.111;
      vlist = buildCommon.makeVList({
        positionType: "individualShift",
        children: [{
          type: "elem",
          elem: upperGroup,
          shift: upperShift
        }, {
          type: "elem",
          elem: arrowBody,
          shift: arrowShift
        }, {
          type: "elem",
          elem: lowerGroup,
          shift: lowerShift
        }]
      }, options);
    } else {
      vlist = buildCommon.makeVList({
        positionType: "individualShift",
        children: [{
          type: "elem",
          elem: upperGroup,
          shift: upperShift
        }, {
          type: "elem",
          elem: arrowBody,
          shift: arrowShift
        }]
      }, options);
    }
    vlist.children[0].children[0].children[1].classes.push("svg-align");
    return buildCommon.makeSpan(["mrel", "x-arrow"], [vlist], options);
  },
  mathmlBuilder(group, options) {
    var arrowNode = stretchy.mathMLnode(group.label);
    arrowNode.setAttribute("minsize", group.label.charAt(0) === "x" ? "1.75em" : "3.0em");
    var node;
    if (group.body) {
      var upperNode = paddedNode(buildGroup2(group.body, options));
      if (group.below) {
        var lowerNode = paddedNode(buildGroup2(group.below, options));
        node = new mathMLTree.MathNode("munderover", [arrowNode, lowerNode, upperNode]);
      } else {
        node = new mathMLTree.MathNode("mover", [arrowNode, upperNode]);
      }
    } else if (group.below) {
      var _lowerNode = paddedNode(buildGroup2(group.below, options));
      node = new mathMLTree.MathNode("munder", [arrowNode, _lowerNode]);
    } else {
      node = paddedNode();
      node = new mathMLTree.MathNode("mover", [arrowNode, node]);
    }
    return node;
  }
});
var makeSpan2 = buildCommon.makeSpan;
function htmlBuilder$9(group, options) {
  var elements = buildExpression$1(group.body, options, true);
  return makeSpan2([group.mclass], elements, options);
}
function mathmlBuilder$8(group, options) {
  var node;
  var inner2 = buildExpression2(group.body, options);
  if (group.mclass === "minner") {
    node = new mathMLTree.MathNode("mpadded", inner2);
  } else if (group.mclass === "mord") {
    if (group.isCharacterBox) {
      node = inner2[0];
      node.type = "mi";
    } else {
      node = new mathMLTree.MathNode("mi", inner2);
    }
  } else {
    if (group.isCharacterBox) {
      node = inner2[0];
      node.type = "mo";
    } else {
      node = new mathMLTree.MathNode("mo", inner2);
    }
    if (group.mclass === "mbin") {
      node.attributes.lspace = "0.22em";
      node.attributes.rspace = "0.22em";
    } else if (group.mclass === "mpunct") {
      node.attributes.lspace = "0em";
      node.attributes.rspace = "0.17em";
    } else if (group.mclass === "mopen" || group.mclass === "mclose") {
      node.attributes.lspace = "0em";
      node.attributes.rspace = "0em";
    } else if (group.mclass === "minner") {
      node.attributes.lspace = "0.0556em";
      node.attributes.width = "+0.1111em";
    }
  }
  return node;
}
defineFunction({
  type: "mclass",
  names: ["\\mathord", "\\mathbin", "\\mathrel", "\\mathopen", "\\mathclose", "\\mathpunct", "\\mathinner"],
  props: {
    numArgs: 1,
    primitive: true
  },
  handler(_ref, args) {
    var {
      parser,
      funcName
    } = _ref;
    var body = args[0];
    return {
      type: "mclass",
      mode: parser.mode,
      mclass: "m" + funcName.slice(5),
      // TODO(kevinb): don't prefix with 'm'
      body: ordargument(body),
      isCharacterBox: utils.isCharacterBox(body)
    };
  },
  htmlBuilder: htmlBuilder$9,
  mathmlBuilder: mathmlBuilder$8
});
var binrelClass = (arg) => {
  var atom = arg.type === "ordgroup" && arg.body.length ? arg.body[0] : arg;
  if (atom.type === "atom" && (atom.family === "bin" || atom.family === "rel")) {
    return "m" + atom.family;
  } else {
    return "mord";
  }
};
defineFunction({
  type: "mclass",
  names: ["\\@binrel"],
  props: {
    numArgs: 2
  },
  handler(_ref2, args) {
    var {
      parser
    } = _ref2;
    return {
      type: "mclass",
      mode: parser.mode,
      mclass: binrelClass(args[0]),
      body: ordargument(args[1]),
      isCharacterBox: utils.isCharacterBox(args[1])
    };
  }
});
defineFunction({
  type: "mclass",
  names: ["\\stackrel", "\\overset", "\\underset"],
  props: {
    numArgs: 2
  },
  handler(_ref3, args) {
    var {
      parser,
      funcName
    } = _ref3;
    var baseArg = args[1];
    var shiftedArg = args[0];
    var mclass;
    if (funcName !== "\\stackrel") {
      mclass = binrelClass(baseArg);
    } else {
      mclass = "mrel";
    }
    var baseOp = {
      type: "op",
      mode: baseArg.mode,
      limits: true,
      alwaysHandleSupSub: true,
      parentIsSupSub: false,
      symbol: false,
      suppressBaseShift: funcName !== "\\stackrel",
      body: ordargument(baseArg)
    };
    var supsub = {
      type: "supsub",
      mode: shiftedArg.mode,
      base: baseOp,
      sup: funcName === "\\underset" ? null : shiftedArg,
      sub: funcName === "\\underset" ? shiftedArg : null
    };
    return {
      type: "mclass",
      mode: parser.mode,
      mclass,
      body: [supsub],
      isCharacterBox: utils.isCharacterBox(supsub)
    };
  },
  htmlBuilder: htmlBuilder$9,
  mathmlBuilder: mathmlBuilder$8
});
defineFunction({
  type: "pmb",
  names: ["\\pmb"],
  props: {
    numArgs: 1,
    allowedInText: true
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    return {
      type: "pmb",
      mode: parser.mode,
      mclass: binrelClass(args[0]),
      body: ordargument(args[0])
    };
  },
  htmlBuilder(group, options) {
    var elements = buildExpression$1(group.body, options, true);
    var node = buildCommon.makeSpan([group.mclass], elements, options);
    node.style.textShadow = "0.02em 0.01em 0.04px";
    return node;
  },
  mathmlBuilder(group, style) {
    var inner2 = buildExpression2(group.body, style);
    var node = new mathMLTree.MathNode("mstyle", inner2);
    node.setAttribute("style", "text-shadow: 0.02em 0.01em 0.04px");
    return node;
  }
});
var cdArrowFunctionName = {
  ">": "\\\\cdrightarrow",
  "<": "\\\\cdleftarrow",
  "=": "\\\\cdlongequal",
  "A": "\\uparrow",
  "V": "\\downarrow",
  "|": "\\Vert",
  ".": "no arrow"
};
var newCell = () => {
  return {
    type: "styling",
    body: [],
    mode: "math",
    style: "display"
  };
};
var isStartOfArrow = (node) => {
  return node.type === "textord" && node.text === "@";
};
var isLabelEnd = (node, endChar) => {
  return (node.type === "mathord" || node.type === "atom") && node.text === endChar;
};
function cdArrow(arrowChar, labels, parser) {
  var funcName = cdArrowFunctionName[arrowChar];
  switch (funcName) {
    case "\\\\cdrightarrow":
    case "\\\\cdleftarrow":
      return parser.callFunction(funcName, [labels[0]], [labels[1]]);
    case "\\uparrow":
    case "\\downarrow": {
      var leftLabel = parser.callFunction("\\\\cdleft", [labels[0]], []);
      var bareArrow = {
        type: "atom",
        text: funcName,
        mode: "math",
        family: "rel"
      };
      var sizedArrow = parser.callFunction("\\Big", [bareArrow], []);
      var rightLabel = parser.callFunction("\\\\cdright", [labels[1]], []);
      var arrowGroup = {
        type: "ordgroup",
        mode: "math",
        body: [leftLabel, sizedArrow, rightLabel]
      };
      return parser.callFunction("\\\\cdparent", [arrowGroup], []);
    }
    case "\\\\cdlongequal":
      return parser.callFunction("\\\\cdlongequal", [], []);
    case "\\Vert": {
      var arrow = {
        type: "textord",
        text: "\\Vert",
        mode: "math"
      };
      return parser.callFunction("\\Big", [arrow], []);
    }
    default:
      return {
        type: "textord",
        text: " ",
        mode: "math"
      };
  }
}
function parseCD(parser) {
  var parsedRows = [];
  parser.gullet.beginGroup();
  parser.gullet.macros.set("\\cr", "\\\\\\relax");
  parser.gullet.beginGroup();
  while (true) {
    parsedRows.push(parser.parseExpression(false, "\\\\"));
    parser.gullet.endGroup();
    parser.gullet.beginGroup();
    var next = parser.fetch().text;
    if (next === "&" || next === "\\\\") {
      parser.consume();
    } else if (next === "\\end") {
      if (parsedRows[parsedRows.length - 1].length === 0) {
        parsedRows.pop();
      }
      break;
    } else {
      throw new ParseError("Expected \\\\ or \\cr or \\end", parser.nextToken);
    }
  }
  var row = [];
  var body = [row];
  for (var i2 = 0; i2 < parsedRows.length; i2++) {
    var rowNodes = parsedRows[i2];
    var cell = newCell();
    for (var j = 0; j < rowNodes.length; j++) {
      if (!isStartOfArrow(rowNodes[j])) {
        cell.body.push(rowNodes[j]);
      } else {
        row.push(cell);
        j += 1;
        var arrowChar = assertSymbolNodeType(rowNodes[j]).text;
        var labels = new Array(2);
        labels[0] = {
          type: "ordgroup",
          mode: "math",
          body: []
        };
        labels[1] = {
          type: "ordgroup",
          mode: "math",
          body: []
        };
        if ("=|.".indexOf(arrowChar) > -1) ;
        else if ("<>AV".indexOf(arrowChar) > -1) {
          for (var labelNum = 0; labelNum < 2; labelNum++) {
            var inLabel = true;
            for (var k = j + 1; k < rowNodes.length; k++) {
              if (isLabelEnd(rowNodes[k], arrowChar)) {
                inLabel = false;
                j = k;
                break;
              }
              if (isStartOfArrow(rowNodes[k])) {
                throw new ParseError("Missing a " + arrowChar + " character to complete a CD arrow.", rowNodes[k]);
              }
              labels[labelNum].body.push(rowNodes[k]);
            }
            if (inLabel) {
              throw new ParseError("Missing a " + arrowChar + " character to complete a CD arrow.", rowNodes[j]);
            }
          }
        } else {
          throw new ParseError('Expected one of "<>AV=|." after @', rowNodes[j]);
        }
        var arrow = cdArrow(arrowChar, labels, parser);
        var wrappedArrow = {
          type: "styling",
          body: [arrow],
          mode: "math",
          style: "display"
          // CD is always displaystyle.
        };
        row.push(wrappedArrow);
        cell = newCell();
      }
    }
    if (i2 % 2 === 0) {
      row.push(cell);
    } else {
      row.shift();
    }
    row = [];
    body.push(row);
  }
  parser.gullet.endGroup();
  parser.gullet.endGroup();
  var cols = new Array(body[0].length).fill({
    type: "align",
    align: "c",
    pregap: 0.25,
    // CD package sets \enskip between columns.
    postgap: 0.25
    // So pre and post each get half an \enskip, i.e. 0.25em.
  });
  return {
    type: "array",
    mode: "math",
    body,
    arraystretch: 1,
    addJot: true,
    rowGaps: [null],
    cols,
    colSeparationType: "CD",
    hLinesBeforeRow: new Array(body.length + 1).fill([])
  };
}
defineFunction({
  type: "cdlabel",
  names: ["\\\\cdleft", "\\\\cdright"],
  props: {
    numArgs: 1
  },
  handler(_ref, args) {
    var {
      parser,
      funcName
    } = _ref;
    return {
      type: "cdlabel",
      mode: parser.mode,
      side: funcName.slice(4),
      label: args[0]
    };
  },
  htmlBuilder(group, options) {
    var newOptions = options.havingStyle(options.style.sup());
    var label = buildCommon.wrapFragment(buildGroup$1(group.label, newOptions, options), options);
    label.classes.push("cd-label-" + group.side);
    label.style.bottom = makeEm(0.8 - label.depth);
    label.height = 0;
    label.depth = 0;
    return label;
  },
  mathmlBuilder(group, options) {
    var label = new mathMLTree.MathNode("mrow", [buildGroup2(group.label, options)]);
    label = new mathMLTree.MathNode("mpadded", [label]);
    label.setAttribute("width", "0");
    if (group.side === "left") {
      label.setAttribute("lspace", "-1width");
    }
    label.setAttribute("voffset", "0.7em");
    label = new mathMLTree.MathNode("mstyle", [label]);
    label.setAttribute("displaystyle", "false");
    label.setAttribute("scriptlevel", "1");
    return label;
  }
});
defineFunction({
  type: "cdlabelparent",
  names: ["\\\\cdparent"],
  props: {
    numArgs: 1
  },
  handler(_ref2, args) {
    var {
      parser
    } = _ref2;
    return {
      type: "cdlabelparent",
      mode: parser.mode,
      fragment: args[0]
    };
  },
  htmlBuilder(group, options) {
    var parent = buildCommon.wrapFragment(buildGroup$1(group.fragment, options), options);
    parent.classes.push("cd-vert-arrow");
    return parent;
  },
  mathmlBuilder(group, options) {
    return new mathMLTree.MathNode("mrow", [buildGroup2(group.fragment, options)]);
  }
});
defineFunction({
  type: "textord",
  names: ["\\@char"],
  props: {
    numArgs: 1,
    allowedInText: true
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    var arg = assertNodeType(args[0], "ordgroup");
    var group = arg.body;
    var number = "";
    for (var i2 = 0; i2 < group.length; i2++) {
      var node = assertNodeType(group[i2], "textord");
      number += node.text;
    }
    var code = parseInt(number);
    var text2;
    if (isNaN(code)) {
      throw new ParseError("\\@char has non-numeric argument " + number);
    } else if (code < 0 || code >= 1114111) {
      throw new ParseError("\\@char with invalid code point " + number);
    } else if (code <= 65535) {
      text2 = String.fromCharCode(code);
    } else {
      code -= 65536;
      text2 = String.fromCharCode((code >> 10) + 55296, (code & 1023) + 56320);
    }
    return {
      type: "textord",
      mode: parser.mode,
      text: text2
    };
  }
});
var htmlBuilder$8 = (group, options) => {
  var elements = buildExpression$1(group.body, options.withColor(group.color), false);
  return buildCommon.makeFragment(elements);
};
var mathmlBuilder$7 = (group, options) => {
  var inner2 = buildExpression2(group.body, options.withColor(group.color));
  var node = new mathMLTree.MathNode("mstyle", inner2);
  node.setAttribute("mathcolor", group.color);
  return node;
};
defineFunction({
  type: "color",
  names: ["\\textcolor"],
  props: {
    numArgs: 2,
    allowedInText: true,
    argTypes: ["color", "original"]
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    var color = assertNodeType(args[0], "color-token").color;
    var body = args[1];
    return {
      type: "color",
      mode: parser.mode,
      color,
      body: ordargument(body)
    };
  },
  htmlBuilder: htmlBuilder$8,
  mathmlBuilder: mathmlBuilder$7
});
defineFunction({
  type: "color",
  names: ["\\color"],
  props: {
    numArgs: 1,
    allowedInText: true,
    argTypes: ["color"]
  },
  handler(_ref2, args) {
    var {
      parser,
      breakOnTokenText
    } = _ref2;
    var color = assertNodeType(args[0], "color-token").color;
    parser.gullet.macros.set("\\current@color", color);
    var body = parser.parseExpression(true, breakOnTokenText);
    return {
      type: "color",
      mode: parser.mode,
      color,
      body
    };
  },
  htmlBuilder: htmlBuilder$8,
  mathmlBuilder: mathmlBuilder$7
});
defineFunction({
  type: "cr",
  names: ["\\\\"],
  props: {
    numArgs: 0,
    numOptionalArgs: 0,
    allowedInText: true
  },
  handler(_ref, args, optArgs) {
    var {
      parser
    } = _ref;
    var size = parser.gullet.future().text === "[" ? parser.parseSizeGroup(true) : null;
    var newLine = !parser.settings.displayMode || !parser.settings.useStrictBehavior("newLineInDisplayMode", "In LaTeX, \\\\ or \\newline does nothing in display mode");
    return {
      type: "cr",
      mode: parser.mode,
      newLine,
      size: size && assertNodeType(size, "size").value
    };
  },
  // The following builders are called only at the top level,
  // not within tabular/array environments.
  htmlBuilder(group, options) {
    var span = buildCommon.makeSpan(["mspace"], [], options);
    if (group.newLine) {
      span.classes.push("newline");
      if (group.size) {
        span.style.marginTop = makeEm(calculateSize(group.size, options));
      }
    }
    return span;
  },
  mathmlBuilder(group, options) {
    var node = new mathMLTree.MathNode("mspace");
    if (group.newLine) {
      node.setAttribute("linebreak", "newline");
      if (group.size) {
        node.setAttribute("height", makeEm(calculateSize(group.size, options)));
      }
    }
    return node;
  }
});
var globalMap = {
  "\\global": "\\global",
  "\\long": "\\\\globallong",
  "\\\\globallong": "\\\\globallong",
  "\\def": "\\gdef",
  "\\gdef": "\\gdef",
  "\\edef": "\\xdef",
  "\\xdef": "\\xdef",
  "\\let": "\\\\globallet",
  "\\futurelet": "\\\\globalfuture"
};
var checkControlSequence = (tok) => {
  var name = tok.text;
  if (/^(?:[\\{}$&#^_]|EOF)$/.test(name)) {
    throw new ParseError("Expected a control sequence", tok);
  }
  return name;
};
var getRHS = (parser) => {
  var tok = parser.gullet.popToken();
  if (tok.text === "=") {
    tok = parser.gullet.popToken();
    if (tok.text === " ") {
      tok = parser.gullet.popToken();
    }
  }
  return tok;
};
var letCommand = (parser, name, tok, global) => {
  var macro = parser.gullet.macros.get(tok.text);
  if (macro == null) {
    tok.noexpand = true;
    macro = {
      tokens: [tok],
      numArgs: 0,
      // reproduce the same behavior in expansion
      unexpandable: !parser.gullet.isExpandable(tok.text)
    };
  }
  parser.gullet.macros.set(name, macro, global);
};
defineFunction({
  type: "internal",
  names: [
    "\\global",
    "\\long",
    "\\\\globallong"
    // can’t be entered directly
  ],
  props: {
    numArgs: 0,
    allowedInText: true
  },
  handler(_ref) {
    var {
      parser,
      funcName
    } = _ref;
    parser.consumeSpaces();
    var token = parser.fetch();
    if (globalMap[token.text]) {
      if (funcName === "\\global" || funcName === "\\\\globallong") {
        token.text = globalMap[token.text];
      }
      return assertNodeType(parser.parseFunction(), "internal");
    }
    throw new ParseError("Invalid token after macro prefix", token);
  }
});
defineFunction({
  type: "internal",
  names: ["\\def", "\\gdef", "\\edef", "\\xdef"],
  props: {
    numArgs: 0,
    allowedInText: true,
    primitive: true
  },
  handler(_ref2) {
    var {
      parser,
      funcName
    } = _ref2;
    var tok = parser.gullet.popToken();
    var name = tok.text;
    if (/^(?:[\\{}$&#^_]|EOF)$/.test(name)) {
      throw new ParseError("Expected a control sequence", tok);
    }
    var numArgs = 0;
    var insert;
    var delimiters2 = [[]];
    while (parser.gullet.future().text !== "{") {
      tok = parser.gullet.popToken();
      if (tok.text === "#") {
        if (parser.gullet.future().text === "{") {
          insert = parser.gullet.future();
          delimiters2[numArgs].push("{");
          break;
        }
        tok = parser.gullet.popToken();
        if (!/^[1-9]$/.test(tok.text)) {
          throw new ParseError('Invalid argument number "' + tok.text + '"');
        }
        if (parseInt(tok.text) !== numArgs + 1) {
          throw new ParseError('Argument number "' + tok.text + '" out of order');
        }
        numArgs++;
        delimiters2.push([]);
      } else if (tok.text === "EOF") {
        throw new ParseError("Expected a macro definition");
      } else {
        delimiters2[numArgs].push(tok.text);
      }
    }
    var {
      tokens
    } = parser.gullet.consumeArg();
    if (insert) {
      tokens.unshift(insert);
    }
    if (funcName === "\\edef" || funcName === "\\xdef") {
      tokens = parser.gullet.expandTokens(tokens);
      tokens.reverse();
    }
    parser.gullet.macros.set(name, {
      tokens,
      numArgs,
      delimiters: delimiters2
    }, funcName === globalMap[funcName]);
    return {
      type: "internal",
      mode: parser.mode
    };
  }
});
defineFunction({
  type: "internal",
  names: [
    "\\let",
    "\\\\globallet"
    // can’t be entered directly
  ],
  props: {
    numArgs: 0,
    allowedInText: true,
    primitive: true
  },
  handler(_ref3) {
    var {
      parser,
      funcName
    } = _ref3;
    var name = checkControlSequence(parser.gullet.popToken());
    parser.gullet.consumeSpaces();
    var tok = getRHS(parser);
    letCommand(parser, name, tok, funcName === "\\\\globallet");
    return {
      type: "internal",
      mode: parser.mode
    };
  }
});
defineFunction({
  type: "internal",
  names: [
    "\\futurelet",
    "\\\\globalfuture"
    // can’t be entered directly
  ],
  props: {
    numArgs: 0,
    allowedInText: true,
    primitive: true
  },
  handler(_ref4) {
    var {
      parser,
      funcName
    } = _ref4;
    var name = checkControlSequence(parser.gullet.popToken());
    var middle = parser.gullet.popToken();
    var tok = parser.gullet.popToken();
    letCommand(parser, name, tok, funcName === "\\\\globalfuture");
    parser.gullet.pushToken(tok);
    parser.gullet.pushToken(middle);
    return {
      type: "internal",
      mode: parser.mode
    };
  }
});
var getMetrics = function getMetrics2(symbol, font, mode) {
  var replace = symbols.math[symbol] && symbols.math[symbol].replace;
  var metrics = getCharacterMetrics(replace || symbol, font, mode);
  if (!metrics) {
    throw new Error("Unsupported symbol " + symbol + " and font size " + font + ".");
  }
  return metrics;
};
var styleWrap = function styleWrap2(delim, toStyle, options, classes) {
  var newOptions = options.havingBaseStyle(toStyle);
  var span = buildCommon.makeSpan(classes.concat(newOptions.sizingClasses(options)), [delim], options);
  var delimSizeMultiplier = newOptions.sizeMultiplier / options.sizeMultiplier;
  span.height *= delimSizeMultiplier;
  span.depth *= delimSizeMultiplier;
  span.maxFontSize = newOptions.sizeMultiplier;
  return span;
};
var centerSpan = function centerSpan2(span, options, style) {
  var newOptions = options.havingBaseStyle(style);
  var shift = (1 - options.sizeMultiplier / newOptions.sizeMultiplier) * options.fontMetrics().axisHeight;
  span.classes.push("delimcenter");
  span.style.top = makeEm(shift);
  span.height -= shift;
  span.depth += shift;
};
var makeSmallDelim = function makeSmallDelim2(delim, style, center, options, mode, classes) {
  var text2 = buildCommon.makeSymbol(delim, "Main-Regular", mode, options);
  var span = styleWrap(text2, style, options, classes);
  if (center) {
    centerSpan(span, options, style);
  }
  return span;
};
var mathrmSize = function mathrmSize2(value, size, mode, options) {
  return buildCommon.makeSymbol(value, "Size" + size + "-Regular", mode, options);
};
var makeLargeDelim = function makeLargeDelim2(delim, size, center, options, mode, classes) {
  var inner2 = mathrmSize(delim, size, mode, options);
  var span = styleWrap(buildCommon.makeSpan(["delimsizing", "size" + size], [inner2], options), Style$1.TEXT, options, classes);
  if (center) {
    centerSpan(span, options, Style$1.TEXT);
  }
  return span;
};
var makeGlyphSpan = function makeGlyphSpan2(symbol, font, mode) {
  var sizeClass;
  if (font === "Size1-Regular") {
    sizeClass = "delim-size1";
  } else {
    sizeClass = "delim-size4";
  }
  var corner = buildCommon.makeSpan(["delimsizinginner", sizeClass], [buildCommon.makeSpan([], [buildCommon.makeSymbol(symbol, font, mode)])]);
  return {
    type: "elem",
    elem: corner
  };
};
var makeInner = function makeInner2(ch2, height, options) {
  var width = fontMetricsData["Size4-Regular"][ch2.charCodeAt(0)] ? fontMetricsData["Size4-Regular"][ch2.charCodeAt(0)][4] : fontMetricsData["Size1-Regular"][ch2.charCodeAt(0)][4];
  var path2 = new PathNode("inner", innerPath(ch2, Math.round(1e3 * height)));
  var svgNode = new SvgNode([path2], {
    "width": makeEm(width),
    "height": makeEm(height),
    // Override CSS rule `.katex svg { width: 100% }`
    "style": "width:" + makeEm(width),
    "viewBox": "0 0 " + 1e3 * width + " " + Math.round(1e3 * height),
    "preserveAspectRatio": "xMinYMin"
  });
  var span = buildCommon.makeSvgSpan([], [svgNode], options);
  span.height = height;
  span.style.height = makeEm(height);
  span.style.width = makeEm(width);
  return {
    type: "elem",
    elem: span
  };
};
var lapInEms = 8e-3;
var lap = {
  type: "kern",
  size: -1 * lapInEms
};
var verts = ["|", "\\lvert", "\\rvert", "\\vert"];
var doubleVerts = ["\\|", "\\lVert", "\\rVert", "\\Vert"];
var makeStackedDelim = function makeStackedDelim2(delim, heightTotal, center, options, mode, classes) {
  var top;
  var middle;
  var repeat;
  var bottom;
  var svgLabel = "";
  var viewBoxWidth = 0;
  top = repeat = bottom = delim;
  middle = null;
  var font = "Size1-Regular";
  if (delim === "\\uparrow") {
    repeat = bottom = "\u23D0";
  } else if (delim === "\\Uparrow") {
    repeat = bottom = "\u2016";
  } else if (delim === "\\downarrow") {
    top = repeat = "\u23D0";
  } else if (delim === "\\Downarrow") {
    top = repeat = "\u2016";
  } else if (delim === "\\updownarrow") {
    top = "\\uparrow";
    repeat = "\u23D0";
    bottom = "\\downarrow";
  } else if (delim === "\\Updownarrow") {
    top = "\\Uparrow";
    repeat = "\u2016";
    bottom = "\\Downarrow";
  } else if (utils.contains(verts, delim)) {
    repeat = "\u2223";
    svgLabel = "vert";
    viewBoxWidth = 333;
  } else if (utils.contains(doubleVerts, delim)) {
    repeat = "\u2225";
    svgLabel = "doublevert";
    viewBoxWidth = 556;
  } else if (delim === "[" || delim === "\\lbrack") {
    top = "\u23A1";
    repeat = "\u23A2";
    bottom = "\u23A3";
    font = "Size4-Regular";
    svgLabel = "lbrack";
    viewBoxWidth = 667;
  } else if (delim === "]" || delim === "\\rbrack") {
    top = "\u23A4";
    repeat = "\u23A5";
    bottom = "\u23A6";
    font = "Size4-Regular";
    svgLabel = "rbrack";
    viewBoxWidth = 667;
  } else if (delim === "\\lfloor" || delim === "\u230A") {
    repeat = top = "\u23A2";
    bottom = "\u23A3";
    font = "Size4-Regular";
    svgLabel = "lfloor";
    viewBoxWidth = 667;
  } else if (delim === "\\lceil" || delim === "\u2308") {
    top = "\u23A1";
    repeat = bottom = "\u23A2";
    font = "Size4-Regular";
    svgLabel = "lceil";
    viewBoxWidth = 667;
  } else if (delim === "\\rfloor" || delim === "\u230B") {
    repeat = top = "\u23A5";
    bottom = "\u23A6";
    font = "Size4-Regular";
    svgLabel = "rfloor";
    viewBoxWidth = 667;
  } else if (delim === "\\rceil" || delim === "\u2309") {
    top = "\u23A4";
    repeat = bottom = "\u23A5";
    font = "Size4-Regular";
    svgLabel = "rceil";
    viewBoxWidth = 667;
  } else if (delim === "(" || delim === "\\lparen") {
    top = "\u239B";
    repeat = "\u239C";
    bottom = "\u239D";
    font = "Size4-Regular";
    svgLabel = "lparen";
    viewBoxWidth = 875;
  } else if (delim === ")" || delim === "\\rparen") {
    top = "\u239E";
    repeat = "\u239F";
    bottom = "\u23A0";
    font = "Size4-Regular";
    svgLabel = "rparen";
    viewBoxWidth = 875;
  } else if (delim === "\\{" || delim === "\\lbrace") {
    top = "\u23A7";
    middle = "\u23A8";
    bottom = "\u23A9";
    repeat = "\u23AA";
    font = "Size4-Regular";
  } else if (delim === "\\}" || delim === "\\rbrace") {
    top = "\u23AB";
    middle = "\u23AC";
    bottom = "\u23AD";
    repeat = "\u23AA";
    font = "Size4-Regular";
  } else if (delim === "\\lgroup" || delim === "\u27EE") {
    top = "\u23A7";
    bottom = "\u23A9";
    repeat = "\u23AA";
    font = "Size4-Regular";
  } else if (delim === "\\rgroup" || delim === "\u27EF") {
    top = "\u23AB";
    bottom = "\u23AD";
    repeat = "\u23AA";
    font = "Size4-Regular";
  } else if (delim === "\\lmoustache" || delim === "\u23B0") {
    top = "\u23A7";
    bottom = "\u23AD";
    repeat = "\u23AA";
    font = "Size4-Regular";
  } else if (delim === "\\rmoustache" || delim === "\u23B1") {
    top = "\u23AB";
    bottom = "\u23A9";
    repeat = "\u23AA";
    font = "Size4-Regular";
  }
  var topMetrics = getMetrics(top, font, mode);
  var topHeightTotal = topMetrics.height + topMetrics.depth;
  var repeatMetrics = getMetrics(repeat, font, mode);
  var repeatHeightTotal = repeatMetrics.height + repeatMetrics.depth;
  var bottomMetrics = getMetrics(bottom, font, mode);
  var bottomHeightTotal = bottomMetrics.height + bottomMetrics.depth;
  var middleHeightTotal = 0;
  var middleFactor = 1;
  if (middle !== null) {
    var middleMetrics = getMetrics(middle, font, mode);
    middleHeightTotal = middleMetrics.height + middleMetrics.depth;
    middleFactor = 2;
  }
  var minHeight = topHeightTotal + bottomHeightTotal + middleHeightTotal;
  var repeatCount = Math.max(0, Math.ceil((heightTotal - minHeight) / (middleFactor * repeatHeightTotal)));
  var realHeightTotal = minHeight + repeatCount * middleFactor * repeatHeightTotal;
  var axisHeight = options.fontMetrics().axisHeight;
  if (center) {
    axisHeight *= options.sizeMultiplier;
  }
  var depth = realHeightTotal / 2 - axisHeight;
  var stack = [];
  if (svgLabel.length > 0) {
    var midHeight = realHeightTotal - topHeightTotal - bottomHeightTotal;
    var viewBoxHeight = Math.round(realHeightTotal * 1e3);
    var pathStr = tallDelim(svgLabel, Math.round(midHeight * 1e3));
    var path2 = new PathNode(svgLabel, pathStr);
    var width = (viewBoxWidth / 1e3).toFixed(3) + "em";
    var height = (viewBoxHeight / 1e3).toFixed(3) + "em";
    var svg = new SvgNode([path2], {
      "width": width,
      "height": height,
      "viewBox": "0 0 " + viewBoxWidth + " " + viewBoxHeight
    });
    var wrapper = buildCommon.makeSvgSpan([], [svg], options);
    wrapper.height = viewBoxHeight / 1e3;
    wrapper.style.width = width;
    wrapper.style.height = height;
    stack.push({
      type: "elem",
      elem: wrapper
    });
  } else {
    stack.push(makeGlyphSpan(bottom, font, mode));
    stack.push(lap);
    if (middle === null) {
      var innerHeight = realHeightTotal - topHeightTotal - bottomHeightTotal + 2 * lapInEms;
      stack.push(makeInner(repeat, innerHeight, options));
    } else {
      var _innerHeight = (realHeightTotal - topHeightTotal - bottomHeightTotal - middleHeightTotal) / 2 + 2 * lapInEms;
      stack.push(makeInner(repeat, _innerHeight, options));
      stack.push(lap);
      stack.push(makeGlyphSpan(middle, font, mode));
      stack.push(lap);
      stack.push(makeInner(repeat, _innerHeight, options));
    }
    stack.push(lap);
    stack.push(makeGlyphSpan(top, font, mode));
  }
  var newOptions = options.havingBaseStyle(Style$1.TEXT);
  var inner2 = buildCommon.makeVList({
    positionType: "bottom",
    positionData: depth,
    children: stack
  }, newOptions);
  return styleWrap(buildCommon.makeSpan(["delimsizing", "mult"], [inner2], newOptions), Style$1.TEXT, options, classes);
};
var vbPad = 80;
var emPad = 0.08;
var sqrtSvg = function sqrtSvg2(sqrtName, height, viewBoxHeight, extraVinculum, options) {
  var path2 = sqrtPath(sqrtName, extraVinculum, viewBoxHeight);
  var pathNode = new PathNode(sqrtName, path2);
  var svg = new SvgNode([pathNode], {
    // Note: 1000:1 ratio of viewBox to document em width.
    "width": "400em",
    "height": makeEm(height),
    "viewBox": "0 0 400000 " + viewBoxHeight,
    "preserveAspectRatio": "xMinYMin slice"
  });
  return buildCommon.makeSvgSpan(["hide-tail"], [svg], options);
};
var makeSqrtImage = function makeSqrtImage2(height, options) {
  var newOptions = options.havingBaseSizing();
  var delim = traverseSequence("\\surd", height * newOptions.sizeMultiplier, stackLargeDelimiterSequence, newOptions);
  var sizeMultiplier = newOptions.sizeMultiplier;
  var extraVinculum = Math.max(0, options.minRuleThickness - options.fontMetrics().sqrtRuleThickness);
  var span;
  var spanHeight = 0;
  var texHeight = 0;
  var viewBoxHeight = 0;
  var advanceWidth;
  if (delim.type === "small") {
    viewBoxHeight = 1e3 + 1e3 * extraVinculum + vbPad;
    if (height < 1) {
      sizeMultiplier = 1;
    } else if (height < 1.4) {
      sizeMultiplier = 0.7;
    }
    spanHeight = (1 + extraVinculum + emPad) / sizeMultiplier;
    texHeight = (1 + extraVinculum) / sizeMultiplier;
    span = sqrtSvg("sqrtMain", spanHeight, viewBoxHeight, extraVinculum, options);
    span.style.minWidth = "0.853em";
    advanceWidth = 0.833 / sizeMultiplier;
  } else if (delim.type === "large") {
    viewBoxHeight = (1e3 + vbPad) * sizeToMaxHeight[delim.size];
    texHeight = (sizeToMaxHeight[delim.size] + extraVinculum) / sizeMultiplier;
    spanHeight = (sizeToMaxHeight[delim.size] + extraVinculum + emPad) / sizeMultiplier;
    span = sqrtSvg("sqrtSize" + delim.size, spanHeight, viewBoxHeight, extraVinculum, options);
    span.style.minWidth = "1.02em";
    advanceWidth = 1 / sizeMultiplier;
  } else {
    spanHeight = height + extraVinculum + emPad;
    texHeight = height + extraVinculum;
    viewBoxHeight = Math.floor(1e3 * height + extraVinculum) + vbPad;
    span = sqrtSvg("sqrtTall", spanHeight, viewBoxHeight, extraVinculum, options);
    span.style.minWidth = "0.742em";
    advanceWidth = 1.056;
  }
  span.height = texHeight;
  span.style.height = makeEm(spanHeight);
  return {
    span,
    advanceWidth,
    // Calculate the actual line width.
    // This actually should depend on the chosen font -- e.g. \boldmath
    // should use the thicker surd symbols from e.g. KaTeX_Main-Bold, and
    // have thicker rules.
    ruleWidth: (options.fontMetrics().sqrtRuleThickness + extraVinculum) * sizeMultiplier
  };
};
var stackLargeDelimiters = ["(", "\\lparen", ")", "\\rparen", "[", "\\lbrack", "]", "\\rbrack", "\\{", "\\lbrace", "\\}", "\\rbrace", "\\lfloor", "\\rfloor", "\u230A", "\u230B", "\\lceil", "\\rceil", "\u2308", "\u2309", "\\surd"];
var stackAlwaysDelimiters = ["\\uparrow", "\\downarrow", "\\updownarrow", "\\Uparrow", "\\Downarrow", "\\Updownarrow", "|", "\\|", "\\vert", "\\Vert", "\\lvert", "\\rvert", "\\lVert", "\\rVert", "\\lgroup", "\\rgroup", "\u27EE", "\u27EF", "\\lmoustache", "\\rmoustache", "\u23B0", "\u23B1"];
var stackNeverDelimiters = ["<", ">", "\\langle", "\\rangle", "/", "\\backslash", "\\lt", "\\gt"];
var sizeToMaxHeight = [0, 1.2, 1.8, 2.4, 3];
var makeSizedDelim = function makeSizedDelim2(delim, size, options, mode, classes) {
  if (delim === "<" || delim === "\\lt" || delim === "\u27E8") {
    delim = "\\langle";
  } else if (delim === ">" || delim === "\\gt" || delim === "\u27E9") {
    delim = "\\rangle";
  }
  if (utils.contains(stackLargeDelimiters, delim) || utils.contains(stackNeverDelimiters, delim)) {
    return makeLargeDelim(delim, size, false, options, mode, classes);
  } else if (utils.contains(stackAlwaysDelimiters, delim)) {
    return makeStackedDelim(delim, sizeToMaxHeight[size], false, options, mode, classes);
  } else {
    throw new ParseError("Illegal delimiter: '" + delim + "'");
  }
};
var stackNeverDelimiterSequence = [{
  type: "small",
  style: Style$1.SCRIPTSCRIPT
}, {
  type: "small",
  style: Style$1.SCRIPT
}, {
  type: "small",
  style: Style$1.TEXT
}, {
  type: "large",
  size: 1
}, {
  type: "large",
  size: 2
}, {
  type: "large",
  size: 3
}, {
  type: "large",
  size: 4
}];
var stackAlwaysDelimiterSequence = [{
  type: "small",
  style: Style$1.SCRIPTSCRIPT
}, {
  type: "small",
  style: Style$1.SCRIPT
}, {
  type: "small",
  style: Style$1.TEXT
}, {
  type: "stack"
}];
var stackLargeDelimiterSequence = [{
  type: "small",
  style: Style$1.SCRIPTSCRIPT
}, {
  type: "small",
  style: Style$1.SCRIPT
}, {
  type: "small",
  style: Style$1.TEXT
}, {
  type: "large",
  size: 1
}, {
  type: "large",
  size: 2
}, {
  type: "large",
  size: 3
}, {
  type: "large",
  size: 4
}, {
  type: "stack"
}];
var delimTypeToFont = function delimTypeToFont2(type) {
  if (type.type === "small") {
    return "Main-Regular";
  } else if (type.type === "large") {
    return "Size" + type.size + "-Regular";
  } else if (type.type === "stack") {
    return "Size4-Regular";
  } else {
    throw new Error("Add support for delim type '" + type.type + "' here.");
  }
};
var traverseSequence = function traverseSequence2(delim, height, sequence, options) {
  var start = Math.min(2, 3 - options.style.size);
  for (var i2 = start; i2 < sequence.length; i2++) {
    if (sequence[i2].type === "stack") {
      break;
    }
    var metrics = getMetrics(delim, delimTypeToFont(sequence[i2]), "math");
    var heightDepth = metrics.height + metrics.depth;
    if (sequence[i2].type === "small") {
      var newOptions = options.havingBaseStyle(sequence[i2].style);
      heightDepth *= newOptions.sizeMultiplier;
    }
    if (heightDepth > height) {
      return sequence[i2];
    }
  }
  return sequence[sequence.length - 1];
};
var makeCustomSizedDelim = function makeCustomSizedDelim2(delim, height, center, options, mode, classes) {
  if (delim === "<" || delim === "\\lt" || delim === "\u27E8") {
    delim = "\\langle";
  } else if (delim === ">" || delim === "\\gt" || delim === "\u27E9") {
    delim = "\\rangle";
  }
  var sequence;
  if (utils.contains(stackNeverDelimiters, delim)) {
    sequence = stackNeverDelimiterSequence;
  } else if (utils.contains(stackLargeDelimiters, delim)) {
    sequence = stackLargeDelimiterSequence;
  } else {
    sequence = stackAlwaysDelimiterSequence;
  }
  var delimType = traverseSequence(delim, height, sequence, options);
  if (delimType.type === "small") {
    return makeSmallDelim(delim, delimType.style, center, options, mode, classes);
  } else if (delimType.type === "large") {
    return makeLargeDelim(delim, delimType.size, center, options, mode, classes);
  } else {
    return makeStackedDelim(delim, height, center, options, mode, classes);
  }
};
var makeLeftRightDelim = function makeLeftRightDelim2(delim, height, depth, options, mode, classes) {
  var axisHeight = options.fontMetrics().axisHeight * options.sizeMultiplier;
  var delimiterFactor = 901;
  var delimiterExtend = 5 / options.fontMetrics().ptPerEm;
  var maxDistFromAxis = Math.max(height - axisHeight, depth + axisHeight);
  var totalHeight = Math.max(
    // In real TeX, calculations are done using integral values which are
    // 65536 per pt, or 655360 per em. So, the division here truncates in
    // TeX but doesn't here, producing different results. If we wanted to
    // exactly match TeX's calculation, we could do
    //   Math.floor(655360 * maxDistFromAxis / 500) *
    //    delimiterFactor / 655360
    // (To see the difference, compare
    //    x^{x^{\left(\rule{0.1em}{0.68em}\right)}}
    // in TeX and KaTeX)
    maxDistFromAxis / 500 * delimiterFactor,
    2 * maxDistFromAxis - delimiterExtend
  );
  return makeCustomSizedDelim(delim, totalHeight, true, options, mode, classes);
};
var delimiter = {
  sqrtImage: makeSqrtImage,
  sizedDelim: makeSizedDelim,
  sizeToMaxHeight,
  customSizedDelim: makeCustomSizedDelim,
  leftRightDelim: makeLeftRightDelim
};
var delimiterSizes = {
  "\\bigl": {
    mclass: "mopen",
    size: 1
  },
  "\\Bigl": {
    mclass: "mopen",
    size: 2
  },
  "\\biggl": {
    mclass: "mopen",
    size: 3
  },
  "\\Biggl": {
    mclass: "mopen",
    size: 4
  },
  "\\bigr": {
    mclass: "mclose",
    size: 1
  },
  "\\Bigr": {
    mclass: "mclose",
    size: 2
  },
  "\\biggr": {
    mclass: "mclose",
    size: 3
  },
  "\\Biggr": {
    mclass: "mclose",
    size: 4
  },
  "\\bigm": {
    mclass: "mrel",
    size: 1
  },
  "\\Bigm": {
    mclass: "mrel",
    size: 2
  },
  "\\biggm": {
    mclass: "mrel",
    size: 3
  },
  "\\Biggm": {
    mclass: "mrel",
    size: 4
  },
  "\\big": {
    mclass: "mord",
    size: 1
  },
  "\\Big": {
    mclass: "mord",
    size: 2
  },
  "\\bigg": {
    mclass: "mord",
    size: 3
  },
  "\\Bigg": {
    mclass: "mord",
    size: 4
  }
};
var delimiters = ["(", "\\lparen", ")", "\\rparen", "[", "\\lbrack", "]", "\\rbrack", "\\{", "\\lbrace", "\\}", "\\rbrace", "\\lfloor", "\\rfloor", "\u230A", "\u230B", "\\lceil", "\\rceil", "\u2308", "\u2309", "<", ">", "\\langle", "\u27E8", "\\rangle", "\u27E9", "\\lt", "\\gt", "\\lvert", "\\rvert", "\\lVert", "\\rVert", "\\lgroup", "\\rgroup", "\u27EE", "\u27EF", "\\lmoustache", "\\rmoustache", "\u23B0", "\u23B1", "/", "\\backslash", "|", "\\vert", "\\|", "\\Vert", "\\uparrow", "\\Uparrow", "\\downarrow", "\\Downarrow", "\\updownarrow", "\\Updownarrow", "."];
function checkDelimiter(delim, context) {
  var symDelim = checkSymbolNodeType(delim);
  if (symDelim && utils.contains(delimiters, symDelim.text)) {
    return symDelim;
  } else if (symDelim) {
    throw new ParseError("Invalid delimiter '" + symDelim.text + "' after '" + context.funcName + "'", delim);
  } else {
    throw new ParseError("Invalid delimiter type '" + delim.type + "'", delim);
  }
}
defineFunction({
  type: "delimsizing",
  names: ["\\bigl", "\\Bigl", "\\biggl", "\\Biggl", "\\bigr", "\\Bigr", "\\biggr", "\\Biggr", "\\bigm", "\\Bigm", "\\biggm", "\\Biggm", "\\big", "\\Big", "\\bigg", "\\Bigg"],
  props: {
    numArgs: 1,
    argTypes: ["primitive"]
  },
  handler: (context, args) => {
    var delim = checkDelimiter(args[0], context);
    return {
      type: "delimsizing",
      mode: context.parser.mode,
      size: delimiterSizes[context.funcName].size,
      mclass: delimiterSizes[context.funcName].mclass,
      delim: delim.text
    };
  },
  htmlBuilder: (group, options) => {
    if (group.delim === ".") {
      return buildCommon.makeSpan([group.mclass]);
    }
    return delimiter.sizedDelim(group.delim, group.size, options, group.mode, [group.mclass]);
  },
  mathmlBuilder: (group) => {
    var children = [];
    if (group.delim !== ".") {
      children.push(makeText(group.delim, group.mode));
    }
    var node = new mathMLTree.MathNode("mo", children);
    if (group.mclass === "mopen" || group.mclass === "mclose") {
      node.setAttribute("fence", "true");
    } else {
      node.setAttribute("fence", "false");
    }
    node.setAttribute("stretchy", "true");
    var size = makeEm(delimiter.sizeToMaxHeight[group.size]);
    node.setAttribute("minsize", size);
    node.setAttribute("maxsize", size);
    return node;
  }
});
function assertParsed(group) {
  if (!group.body) {
    throw new Error("Bug: The leftright ParseNode wasn't fully parsed.");
  }
}
defineFunction({
  type: "leftright-right",
  names: ["\\right"],
  props: {
    numArgs: 1,
    primitive: true
  },
  handler: (context, args) => {
    var color = context.parser.gullet.macros.get("\\current@color");
    if (color && typeof color !== "string") {
      throw new ParseError("\\current@color set to non-string in \\right");
    }
    return {
      type: "leftright-right",
      mode: context.parser.mode,
      delim: checkDelimiter(args[0], context).text,
      color
      // undefined if not set via \color
    };
  }
});
defineFunction({
  type: "leftright",
  names: ["\\left"],
  props: {
    numArgs: 1,
    primitive: true
  },
  handler: (context, args) => {
    var delim = checkDelimiter(args[0], context);
    var parser = context.parser;
    ++parser.leftrightDepth;
    var body = parser.parseExpression(false);
    --parser.leftrightDepth;
    parser.expect("\\right", false);
    var right = assertNodeType(parser.parseFunction(), "leftright-right");
    return {
      type: "leftright",
      mode: parser.mode,
      body,
      left: delim.text,
      right: right.delim,
      rightColor: right.color
    };
  },
  htmlBuilder: (group, options) => {
    assertParsed(group);
    var inner2 = buildExpression$1(group.body, options, true, ["mopen", "mclose"]);
    var innerHeight = 0;
    var innerDepth = 0;
    var hadMiddle = false;
    for (var i2 = 0; i2 < inner2.length; i2++) {
      if (inner2[i2].isMiddle) {
        hadMiddle = true;
      } else {
        innerHeight = Math.max(inner2[i2].height, innerHeight);
        innerDepth = Math.max(inner2[i2].depth, innerDepth);
      }
    }
    innerHeight *= options.sizeMultiplier;
    innerDepth *= options.sizeMultiplier;
    var leftDelim;
    if (group.left === ".") {
      leftDelim = makeNullDelimiter(options, ["mopen"]);
    } else {
      leftDelim = delimiter.leftRightDelim(group.left, innerHeight, innerDepth, options, group.mode, ["mopen"]);
    }
    inner2.unshift(leftDelim);
    if (hadMiddle) {
      for (var _i6 = 1; _i6 < inner2.length; _i6++) {
        var middleDelim = inner2[_i6];
        var isMiddle = middleDelim.isMiddle;
        if (isMiddle) {
          inner2[_i6] = delimiter.leftRightDelim(isMiddle.delim, innerHeight, innerDepth, isMiddle.options, group.mode, []);
        }
      }
    }
    var rightDelim;
    if (group.right === ".") {
      rightDelim = makeNullDelimiter(options, ["mclose"]);
    } else {
      var colorOptions = group.rightColor ? options.withColor(group.rightColor) : options;
      rightDelim = delimiter.leftRightDelim(group.right, innerHeight, innerDepth, colorOptions, group.mode, ["mclose"]);
    }
    inner2.push(rightDelim);
    return buildCommon.makeSpan(["minner"], inner2, options);
  },
  mathmlBuilder: (group, options) => {
    assertParsed(group);
    var inner2 = buildExpression2(group.body, options);
    if (group.left !== ".") {
      var leftNode = new mathMLTree.MathNode("mo", [makeText(group.left, group.mode)]);
      leftNode.setAttribute("fence", "true");
      inner2.unshift(leftNode);
    }
    if (group.right !== ".") {
      var rightNode = new mathMLTree.MathNode("mo", [makeText(group.right, group.mode)]);
      rightNode.setAttribute("fence", "true");
      if (group.rightColor) {
        rightNode.setAttribute("mathcolor", group.rightColor);
      }
      inner2.push(rightNode);
    }
    return makeRow(inner2);
  }
});
defineFunction({
  type: "middle",
  names: ["\\middle"],
  props: {
    numArgs: 1,
    primitive: true
  },
  handler: (context, args) => {
    var delim = checkDelimiter(args[0], context);
    if (!context.parser.leftrightDepth) {
      throw new ParseError("\\middle without preceding \\left", delim);
    }
    return {
      type: "middle",
      mode: context.parser.mode,
      delim: delim.text
    };
  },
  htmlBuilder: (group, options) => {
    var middleDelim;
    if (group.delim === ".") {
      middleDelim = makeNullDelimiter(options, []);
    } else {
      middleDelim = delimiter.sizedDelim(group.delim, 1, options, group.mode, []);
      var isMiddle = {
        delim: group.delim,
        options
      };
      middleDelim.isMiddle = isMiddle;
    }
    return middleDelim;
  },
  mathmlBuilder: (group, options) => {
    var textNode = group.delim === "\\vert" || group.delim === "|" ? makeText("|", "text") : makeText(group.delim, group.mode);
    var middleNode = new mathMLTree.MathNode("mo", [textNode]);
    middleNode.setAttribute("fence", "true");
    middleNode.setAttribute("lspace", "0.05em");
    middleNode.setAttribute("rspace", "0.05em");
    return middleNode;
  }
});
var htmlBuilder$7 = (group, options) => {
  var inner2 = buildCommon.wrapFragment(buildGroup$1(group.body, options), options);
  var label = group.label.slice(1);
  var scale = options.sizeMultiplier;
  var img;
  var imgShift = 0;
  var isSingleChar = utils.isCharacterBox(group.body);
  if (label === "sout") {
    img = buildCommon.makeSpan(["stretchy", "sout"]);
    img.height = options.fontMetrics().defaultRuleThickness / scale;
    imgShift = -0.5 * options.fontMetrics().xHeight;
  } else if (label === "phase") {
    var lineWeight = calculateSize({
      number: 0.6,
      unit: "pt"
    }, options);
    var clearance = calculateSize({
      number: 0.35,
      unit: "ex"
    }, options);
    var newOptions = options.havingBaseSizing();
    scale = scale / newOptions.sizeMultiplier;
    var angleHeight = inner2.height + inner2.depth + lineWeight + clearance;
    inner2.style.paddingLeft = makeEm(angleHeight / 2 + lineWeight);
    var viewBoxHeight = Math.floor(1e3 * angleHeight * scale);
    var path2 = phasePath(viewBoxHeight);
    var svgNode = new SvgNode([new PathNode("phase", path2)], {
      "width": "400em",
      "height": makeEm(viewBoxHeight / 1e3),
      "viewBox": "0 0 400000 " + viewBoxHeight,
      "preserveAspectRatio": "xMinYMin slice"
    });
    img = buildCommon.makeSvgSpan(["hide-tail"], [svgNode], options);
    img.style.height = makeEm(angleHeight);
    imgShift = inner2.depth + lineWeight + clearance;
  } else {
    if (/cancel/.test(label)) {
      if (!isSingleChar) {
        inner2.classes.push("cancel-pad");
      }
    } else if (label === "angl") {
      inner2.classes.push("anglpad");
    } else {
      inner2.classes.push("boxpad");
    }
    var topPad = 0;
    var bottomPad = 0;
    var ruleThickness = 0;
    if (/box/.test(label)) {
      ruleThickness = Math.max(
        options.fontMetrics().fboxrule,
        // default
        options.minRuleThickness
        // User override.
      );
      topPad = options.fontMetrics().fboxsep + (label === "colorbox" ? 0 : ruleThickness);
      bottomPad = topPad;
    } else if (label === "angl") {
      ruleThickness = Math.max(options.fontMetrics().defaultRuleThickness, options.minRuleThickness);
      topPad = 4 * ruleThickness;
      bottomPad = Math.max(0, 0.25 - inner2.depth);
    } else {
      topPad = isSingleChar ? 0.2 : 0;
      bottomPad = topPad;
    }
    img = stretchy.encloseSpan(inner2, label, topPad, bottomPad, options);
    if (/fbox|boxed|fcolorbox/.test(label)) {
      img.style.borderStyle = "solid";
      img.style.borderWidth = makeEm(ruleThickness);
    } else if (label === "angl" && ruleThickness !== 0.049) {
      img.style.borderTopWidth = makeEm(ruleThickness);
      img.style.borderRightWidth = makeEm(ruleThickness);
    }
    imgShift = inner2.depth + bottomPad;
    if (group.backgroundColor) {
      img.style.backgroundColor = group.backgroundColor;
      if (group.borderColor) {
        img.style.borderColor = group.borderColor;
      }
    }
  }
  var vlist;
  if (group.backgroundColor) {
    vlist = buildCommon.makeVList({
      positionType: "individualShift",
      children: [
        // Put the color background behind inner;
        {
          type: "elem",
          elem: img,
          shift: imgShift
        },
        {
          type: "elem",
          elem: inner2,
          shift: 0
        }
      ]
    }, options);
  } else {
    var classes = /cancel|phase/.test(label) ? ["svg-align"] : [];
    vlist = buildCommon.makeVList({
      positionType: "individualShift",
      children: [
        // Write the \cancel stroke on top of inner.
        {
          type: "elem",
          elem: inner2,
          shift: 0
        },
        {
          type: "elem",
          elem: img,
          shift: imgShift,
          wrapperClasses: classes
        }
      ]
    }, options);
  }
  if (/cancel/.test(label)) {
    vlist.height = inner2.height;
    vlist.depth = inner2.depth;
  }
  if (/cancel/.test(label) && !isSingleChar) {
    return buildCommon.makeSpan(["mord", "cancel-lap"], [vlist], options);
  } else {
    return buildCommon.makeSpan(["mord"], [vlist], options);
  }
};
var mathmlBuilder$6 = (group, options) => {
  var fboxsep = 0;
  var node = new mathMLTree.MathNode(group.label.indexOf("colorbox") > -1 ? "mpadded" : "menclose", [buildGroup2(group.body, options)]);
  switch (group.label) {
    case "\\cancel":
      node.setAttribute("notation", "updiagonalstrike");
      break;
    case "\\bcancel":
      node.setAttribute("notation", "downdiagonalstrike");
      break;
    case "\\phase":
      node.setAttribute("notation", "phasorangle");
      break;
    case "\\sout":
      node.setAttribute("notation", "horizontalstrike");
      break;
    case "\\fbox":
      node.setAttribute("notation", "box");
      break;
    case "\\angl":
      node.setAttribute("notation", "actuarial");
      break;
    case "\\fcolorbox":
    case "\\colorbox":
      fboxsep = options.fontMetrics().fboxsep * options.fontMetrics().ptPerEm;
      node.setAttribute("width", "+" + 2 * fboxsep + "pt");
      node.setAttribute("height", "+" + 2 * fboxsep + "pt");
      node.setAttribute("lspace", fboxsep + "pt");
      node.setAttribute("voffset", fboxsep + "pt");
      if (group.label === "\\fcolorbox") {
        var thk = Math.max(
          options.fontMetrics().fboxrule,
          // default
          options.minRuleThickness
          // user override
        );
        node.setAttribute("style", "border: " + thk + "em solid " + String(group.borderColor));
      }
      break;
    case "\\xcancel":
      node.setAttribute("notation", "updiagonalstrike downdiagonalstrike");
      break;
  }
  if (group.backgroundColor) {
    node.setAttribute("mathbackground", group.backgroundColor);
  }
  return node;
};
defineFunction({
  type: "enclose",
  names: ["\\colorbox"],
  props: {
    numArgs: 2,
    allowedInText: true,
    argTypes: ["color", "text"]
  },
  handler(_ref, args, optArgs) {
    var {
      parser,
      funcName
    } = _ref;
    var color = assertNodeType(args[0], "color-token").color;
    var body = args[1];
    return {
      type: "enclose",
      mode: parser.mode,
      label: funcName,
      backgroundColor: color,
      body
    };
  },
  htmlBuilder: htmlBuilder$7,
  mathmlBuilder: mathmlBuilder$6
});
defineFunction({
  type: "enclose",
  names: ["\\fcolorbox"],
  props: {
    numArgs: 3,
    allowedInText: true,
    argTypes: ["color", "color", "text"]
  },
  handler(_ref2, args, optArgs) {
    var {
      parser,
      funcName
    } = _ref2;
    var borderColor = assertNodeType(args[0], "color-token").color;
    var backgroundColor = assertNodeType(args[1], "color-token").color;
    var body = args[2];
    return {
      type: "enclose",
      mode: parser.mode,
      label: funcName,
      backgroundColor,
      borderColor,
      body
    };
  },
  htmlBuilder: htmlBuilder$7,
  mathmlBuilder: mathmlBuilder$6
});
defineFunction({
  type: "enclose",
  names: ["\\fbox"],
  props: {
    numArgs: 1,
    argTypes: ["hbox"],
    allowedInText: true
  },
  handler(_ref3, args) {
    var {
      parser
    } = _ref3;
    return {
      type: "enclose",
      mode: parser.mode,
      label: "\\fbox",
      body: args[0]
    };
  }
});
defineFunction({
  type: "enclose",
  names: ["\\cancel", "\\bcancel", "\\xcancel", "\\sout", "\\phase"],
  props: {
    numArgs: 1
  },
  handler(_ref4, args) {
    var {
      parser,
      funcName
    } = _ref4;
    var body = args[0];
    return {
      type: "enclose",
      mode: parser.mode,
      label: funcName,
      body
    };
  },
  htmlBuilder: htmlBuilder$7,
  mathmlBuilder: mathmlBuilder$6
});
defineFunction({
  type: "enclose",
  names: ["\\angl"],
  props: {
    numArgs: 1,
    argTypes: ["hbox"],
    allowedInText: false
  },
  handler(_ref5, args) {
    var {
      parser
    } = _ref5;
    return {
      type: "enclose",
      mode: parser.mode,
      label: "\\angl",
      body: args[0]
    };
  }
});
var _environments = {};
function defineEnvironment(_ref) {
  var {
    type,
    names,
    props,
    handler,
    htmlBuilder: htmlBuilder3,
    mathmlBuilder: mathmlBuilder3
  } = _ref;
  var data = {
    type,
    numArgs: props.numArgs || 0,
    allowedInText: false,
    numOptionalArgs: 0,
    handler
  };
  for (var i2 = 0; i2 < names.length; ++i2) {
    _environments[names[i2]] = data;
  }
  if (htmlBuilder3) {
    _htmlGroupBuilders[type] = htmlBuilder3;
  }
  if (mathmlBuilder3) {
    _mathmlGroupBuilders[type] = mathmlBuilder3;
  }
}
var _macros = {};
function defineMacro(name, body) {
  _macros[name] = body;
}
function getHLines(parser) {
  var hlineInfo = [];
  parser.consumeSpaces();
  var nxt = parser.fetch().text;
  if (nxt === "\\relax") {
    parser.consume();
    parser.consumeSpaces();
    nxt = parser.fetch().text;
  }
  while (nxt === "\\hline" || nxt === "\\hdashline") {
    parser.consume();
    hlineInfo.push(nxt === "\\hdashline");
    parser.consumeSpaces();
    nxt = parser.fetch().text;
  }
  return hlineInfo;
}
var validateAmsEnvironmentContext = (context) => {
  var settings = context.parser.settings;
  if (!settings.displayMode) {
    throw new ParseError("{" + context.envName + "} can be used only in display mode.");
  }
};
function getAutoTag(name) {
  if (name.indexOf("ed") === -1) {
    return name.indexOf("*") === -1;
  }
}
function parseArray(parser, _ref, style) {
  var {
    hskipBeforeAndAfter,
    addJot,
    cols,
    arraystretch,
    colSeparationType,
    autoTag,
    singleRow,
    emptySingleRow,
    maxNumCols,
    leqno
  } = _ref;
  parser.gullet.beginGroup();
  if (!singleRow) {
    parser.gullet.macros.set("\\cr", "\\\\\\relax");
  }
  if (!arraystretch) {
    var stretch = parser.gullet.expandMacroAsText("\\arraystretch");
    if (stretch == null) {
      arraystretch = 1;
    } else {
      arraystretch = parseFloat(stretch);
      if (!arraystretch || arraystretch < 0) {
        throw new ParseError("Invalid \\arraystretch: " + stretch);
      }
    }
  }
  parser.gullet.beginGroup();
  var row = [];
  var body = [row];
  var rowGaps = [];
  var hLinesBeforeRow = [];
  var tags = autoTag != null ? [] : void 0;
  function beginRow() {
    if (autoTag) {
      parser.gullet.macros.set("\\@eqnsw", "1", true);
    }
  }
  function endRow() {
    if (tags) {
      if (parser.gullet.macros.get("\\df@tag")) {
        tags.push(parser.subparse([new Token("\\df@tag")]));
        parser.gullet.macros.set("\\df@tag", void 0, true);
      } else {
        tags.push(Boolean(autoTag) && parser.gullet.macros.get("\\@eqnsw") === "1");
      }
    }
  }
  beginRow();
  hLinesBeforeRow.push(getHLines(parser));
  while (true) {
    var cell = parser.parseExpression(false, singleRow ? "\\end" : "\\\\");
    parser.gullet.endGroup();
    parser.gullet.beginGroup();
    cell = {
      type: "ordgroup",
      mode: parser.mode,
      body: cell
    };
    if (style) {
      cell = {
        type: "styling",
        mode: parser.mode,
        style,
        body: [cell]
      };
    }
    row.push(cell);
    var next = parser.fetch().text;
    if (next === "&") {
      if (maxNumCols && row.length === maxNumCols) {
        if (singleRow || colSeparationType) {
          throw new ParseError("Too many tab characters: &", parser.nextToken);
        } else {
          parser.settings.reportNonstrict("textEnv", "Too few columns specified in the {array} column argument.");
        }
      }
      parser.consume();
    } else if (next === "\\end") {
      endRow();
      if (row.length === 1 && cell.type === "styling" && cell.body[0].body.length === 0 && (body.length > 1 || !emptySingleRow)) {
        body.pop();
      }
      if (hLinesBeforeRow.length < body.length + 1) {
        hLinesBeforeRow.push([]);
      }
      break;
    } else if (next === "\\\\") {
      parser.consume();
      var size = void 0;
      if (parser.gullet.future().text !== " ") {
        size = parser.parseSizeGroup(true);
      }
      rowGaps.push(size ? size.value : null);
      endRow();
      hLinesBeforeRow.push(getHLines(parser));
      row = [];
      body.push(row);
      beginRow();
    } else {
      throw new ParseError("Expected & or \\\\ or \\cr or \\end", parser.nextToken);
    }
  }
  parser.gullet.endGroup();
  parser.gullet.endGroup();
  return {
    type: "array",
    mode: parser.mode,
    addJot,
    arraystretch,
    body,
    cols,
    rowGaps,
    hskipBeforeAndAfter,
    hLinesBeforeRow,
    colSeparationType,
    tags,
    leqno
  };
}
function dCellStyle(envName) {
  if (envName.slice(0, 1) === "d") {
    return "display";
  } else {
    return "text";
  }
}
var htmlBuilder$6 = function htmlBuilder(group, options) {
  var r;
  var c;
  var nr = group.body.length;
  var hLinesBeforeRow = group.hLinesBeforeRow;
  var nc = 0;
  var body = new Array(nr);
  var hlines = [];
  var ruleThickness = Math.max(
    // From LaTeX \showthe\arrayrulewidth. Equals 0.04 em.
    options.fontMetrics().arrayRuleWidth,
    options.minRuleThickness
    // User override.
  );
  var pt = 1 / options.fontMetrics().ptPerEm;
  var arraycolsep = 5 * pt;
  if (group.colSeparationType && group.colSeparationType === "small") {
    var localMultiplier = options.havingStyle(Style$1.SCRIPT).sizeMultiplier;
    arraycolsep = 0.2778 * (localMultiplier / options.sizeMultiplier);
  }
  var baselineskip = group.colSeparationType === "CD" ? calculateSize({
    number: 3,
    unit: "ex"
  }, options) : 12 * pt;
  var jot = 3 * pt;
  var arrayskip = group.arraystretch * baselineskip;
  var arstrutHeight = 0.7 * arrayskip;
  var arstrutDepth = 0.3 * arrayskip;
  var totalHeight = 0;
  function setHLinePos(hlinesInGap) {
    for (var i2 = 0; i2 < hlinesInGap.length; ++i2) {
      if (i2 > 0) {
        totalHeight += 0.25;
      }
      hlines.push({
        pos: totalHeight,
        isDashed: hlinesInGap[i2]
      });
    }
  }
  setHLinePos(hLinesBeforeRow[0]);
  for (r = 0; r < group.body.length; ++r) {
    var inrow = group.body[r];
    var height = arstrutHeight;
    var depth = arstrutDepth;
    if (nc < inrow.length) {
      nc = inrow.length;
    }
    var outrow = new Array(inrow.length);
    for (c = 0; c < inrow.length; ++c) {
      var elt = buildGroup$1(inrow[c], options);
      if (depth < elt.depth) {
        depth = elt.depth;
      }
      if (height < elt.height) {
        height = elt.height;
      }
      outrow[c] = elt;
    }
    var rowGap = group.rowGaps[r];
    var gap = 0;
    if (rowGap) {
      gap = calculateSize(rowGap, options);
      if (gap > 0) {
        gap += arstrutDepth;
        if (depth < gap) {
          depth = gap;
        }
        gap = 0;
      }
    }
    if (group.addJot) {
      depth += jot;
    }
    outrow.height = height;
    outrow.depth = depth;
    totalHeight += height;
    outrow.pos = totalHeight;
    totalHeight += depth + gap;
    body[r] = outrow;
    setHLinePos(hLinesBeforeRow[r + 1]);
  }
  var offset = totalHeight / 2 + options.fontMetrics().axisHeight;
  var colDescriptions = group.cols || [];
  var cols = [];
  var colSep;
  var colDescrNum;
  var tagSpans = [];
  if (group.tags && group.tags.some((tag2) => tag2)) {
    for (r = 0; r < nr; ++r) {
      var rw = body[r];
      var shift = rw.pos - offset;
      var tag = group.tags[r];
      var tagSpan = void 0;
      if (tag === true) {
        tagSpan = buildCommon.makeSpan(["eqn-num"], [], options);
      } else if (tag === false) {
        tagSpan = buildCommon.makeSpan([], [], options);
      } else {
        tagSpan = buildCommon.makeSpan([], buildExpression$1(tag, options, true), options);
      }
      tagSpan.depth = rw.depth;
      tagSpan.height = rw.height;
      tagSpans.push({
        type: "elem",
        elem: tagSpan,
        shift
      });
    }
  }
  for (
    c = 0, colDescrNum = 0;
    // Continue while either there are more columns or more column
    // descriptions, so trailing separators don't get lost.
    c < nc || colDescrNum < colDescriptions.length;
    ++c, ++colDescrNum
  ) {
    var colDescr = colDescriptions[colDescrNum] || {};
    var firstSeparator = true;
    while (colDescr.type === "separator") {
      if (!firstSeparator) {
        colSep = buildCommon.makeSpan(["arraycolsep"], []);
        colSep.style.width = makeEm(options.fontMetrics().doubleRuleSep);
        cols.push(colSep);
      }
      if (colDescr.separator === "|" || colDescr.separator === ":") {
        var lineType = colDescr.separator === "|" ? "solid" : "dashed";
        var separator = buildCommon.makeSpan(["vertical-separator"], [], options);
        separator.style.height = makeEm(totalHeight);
        separator.style.borderRightWidth = makeEm(ruleThickness);
        separator.style.borderRightStyle = lineType;
        separator.style.margin = "0 " + makeEm(-ruleThickness / 2);
        var _shift = totalHeight - offset;
        if (_shift) {
          separator.style.verticalAlign = makeEm(-_shift);
        }
        cols.push(separator);
      } else {
        throw new ParseError("Invalid separator type: " + colDescr.separator);
      }
      colDescrNum++;
      colDescr = colDescriptions[colDescrNum] || {};
      firstSeparator = false;
    }
    if (c >= nc) {
      continue;
    }
    var sepwidth = void 0;
    if (c > 0 || group.hskipBeforeAndAfter) {
      sepwidth = utils.deflt(colDescr.pregap, arraycolsep);
      if (sepwidth !== 0) {
        colSep = buildCommon.makeSpan(["arraycolsep"], []);
        colSep.style.width = makeEm(sepwidth);
        cols.push(colSep);
      }
    }
    var col = [];
    for (r = 0; r < nr; ++r) {
      var row = body[r];
      var elem = row[c];
      if (!elem) {
        continue;
      }
      var _shift2 = row.pos - offset;
      elem.depth = row.depth;
      elem.height = row.height;
      col.push({
        type: "elem",
        elem,
        shift: _shift2
      });
    }
    col = buildCommon.makeVList({
      positionType: "individualShift",
      children: col
    }, options);
    col = buildCommon.makeSpan(["col-align-" + (colDescr.align || "c")], [col]);
    cols.push(col);
    if (c < nc - 1 || group.hskipBeforeAndAfter) {
      sepwidth = utils.deflt(colDescr.postgap, arraycolsep);
      if (sepwidth !== 0) {
        colSep = buildCommon.makeSpan(["arraycolsep"], []);
        colSep.style.width = makeEm(sepwidth);
        cols.push(colSep);
      }
    }
  }
  body = buildCommon.makeSpan(["mtable"], cols);
  if (hlines.length > 0) {
    var line = buildCommon.makeLineSpan("hline", options, ruleThickness);
    var dashes = buildCommon.makeLineSpan("hdashline", options, ruleThickness);
    var vListElems = [{
      type: "elem",
      elem: body,
      shift: 0
    }];
    while (hlines.length > 0) {
      var hline = hlines.pop();
      var lineShift = hline.pos - offset;
      if (hline.isDashed) {
        vListElems.push({
          type: "elem",
          elem: dashes,
          shift: lineShift
        });
      } else {
        vListElems.push({
          type: "elem",
          elem: line,
          shift: lineShift
        });
      }
    }
    body = buildCommon.makeVList({
      positionType: "individualShift",
      children: vListElems
    }, options);
  }
  if (tagSpans.length === 0) {
    return buildCommon.makeSpan(["mord"], [body], options);
  } else {
    var eqnNumCol = buildCommon.makeVList({
      positionType: "individualShift",
      children: tagSpans
    }, options);
    eqnNumCol = buildCommon.makeSpan(["tag"], [eqnNumCol], options);
    return buildCommon.makeFragment([body, eqnNumCol]);
  }
};
var alignMap = {
  c: "center ",
  l: "left ",
  r: "right "
};
var mathmlBuilder$5 = function mathmlBuilder(group, options) {
  var tbl = [];
  var glue = new mathMLTree.MathNode("mtd", [], ["mtr-glue"]);
  var tag = new mathMLTree.MathNode("mtd", [], ["mml-eqn-num"]);
  for (var i2 = 0; i2 < group.body.length; i2++) {
    var rw = group.body[i2];
    var row = [];
    for (var j = 0; j < rw.length; j++) {
      row.push(new mathMLTree.MathNode("mtd", [buildGroup2(rw[j], options)]));
    }
    if (group.tags && group.tags[i2]) {
      row.unshift(glue);
      row.push(glue);
      if (group.leqno) {
        row.unshift(tag);
      } else {
        row.push(tag);
      }
    }
    tbl.push(new mathMLTree.MathNode("mtr", row));
  }
  var table = new mathMLTree.MathNode("mtable", tbl);
  var gap = group.arraystretch === 0.5 ? 0.1 : 0.16 + group.arraystretch - 1 + (group.addJot ? 0.09 : 0);
  table.setAttribute("rowspacing", makeEm(gap));
  var menclose = "";
  var align = "";
  if (group.cols && group.cols.length > 0) {
    var cols = group.cols;
    var columnLines = "";
    var prevTypeWasAlign = false;
    var iStart = 0;
    var iEnd = cols.length;
    if (cols[0].type === "separator") {
      menclose += "top ";
      iStart = 1;
    }
    if (cols[cols.length - 1].type === "separator") {
      menclose += "bottom ";
      iEnd -= 1;
    }
    for (var _i6 = iStart; _i6 < iEnd; _i6++) {
      if (cols[_i6].type === "align") {
        align += alignMap[cols[_i6].align];
        if (prevTypeWasAlign) {
          columnLines += "none ";
        }
        prevTypeWasAlign = true;
      } else if (cols[_i6].type === "separator") {
        if (prevTypeWasAlign) {
          columnLines += cols[_i6].separator === "|" ? "solid " : "dashed ";
          prevTypeWasAlign = false;
        }
      }
    }
    table.setAttribute("columnalign", align.trim());
    if (/[sd]/.test(columnLines)) {
      table.setAttribute("columnlines", columnLines.trim());
    }
  }
  if (group.colSeparationType === "align") {
    var _cols = group.cols || [];
    var spacing2 = "";
    for (var _i22 = 1; _i22 < _cols.length; _i22++) {
      spacing2 += _i22 % 2 ? "0em " : "1em ";
    }
    table.setAttribute("columnspacing", spacing2.trim());
  } else if (group.colSeparationType === "alignat" || group.colSeparationType === "gather") {
    table.setAttribute("columnspacing", "0em");
  } else if (group.colSeparationType === "small") {
    table.setAttribute("columnspacing", "0.2778em");
  } else if (group.colSeparationType === "CD") {
    table.setAttribute("columnspacing", "0.5em");
  } else {
    table.setAttribute("columnspacing", "1em");
  }
  var rowLines = "";
  var hlines = group.hLinesBeforeRow;
  menclose += hlines[0].length > 0 ? "left " : "";
  menclose += hlines[hlines.length - 1].length > 0 ? "right " : "";
  for (var _i32 = 1; _i32 < hlines.length - 1; _i32++) {
    rowLines += hlines[_i32].length === 0 ? "none " : hlines[_i32][0] ? "dashed " : "solid ";
  }
  if (/[sd]/.test(rowLines)) {
    table.setAttribute("rowlines", rowLines.trim());
  }
  if (menclose !== "") {
    table = new mathMLTree.MathNode("menclose", [table]);
    table.setAttribute("notation", menclose.trim());
  }
  if (group.arraystretch && group.arraystretch < 1) {
    table = new mathMLTree.MathNode("mstyle", [table]);
    table.setAttribute("scriptlevel", "1");
  }
  return table;
};
var alignedHandler = function alignedHandler2(context, args) {
  if (context.envName.indexOf("ed") === -1) {
    validateAmsEnvironmentContext(context);
  }
  var cols = [];
  var separationType = context.envName.indexOf("at") > -1 ? "alignat" : "align";
  var isSplit = context.envName === "split";
  var res = parseArray(context.parser, {
    cols,
    addJot: true,
    autoTag: isSplit ? void 0 : getAutoTag(context.envName),
    emptySingleRow: true,
    colSeparationType: separationType,
    maxNumCols: isSplit ? 2 : void 0,
    leqno: context.parser.settings.leqno
  }, "display");
  var numMaths;
  var numCols = 0;
  var emptyGroup = {
    type: "ordgroup",
    mode: context.mode,
    body: []
  };
  if (args[0] && args[0].type === "ordgroup") {
    var arg0 = "";
    for (var i2 = 0; i2 < args[0].body.length; i2++) {
      var textord2 = assertNodeType(args[0].body[i2], "textord");
      arg0 += textord2.text;
    }
    numMaths = Number(arg0);
    numCols = numMaths * 2;
  }
  var isAligned = !numCols;
  res.body.forEach(function(row) {
    for (var _i42 = 1; _i42 < row.length; _i42 += 2) {
      var styling = assertNodeType(row[_i42], "styling");
      var ordgroup = assertNodeType(styling.body[0], "ordgroup");
      ordgroup.body.unshift(emptyGroup);
    }
    if (!isAligned) {
      var curMaths = row.length / 2;
      if (numMaths < curMaths) {
        throw new ParseError("Too many math in a row: " + ("expected " + numMaths + ", but got " + curMaths), row[0]);
      }
    } else if (numCols < row.length) {
      numCols = row.length;
    }
  });
  for (var _i52 = 0; _i52 < numCols; ++_i52) {
    var align = "r";
    var pregap = 0;
    if (_i52 % 2 === 1) {
      align = "l";
    } else if (_i52 > 0 && isAligned) {
      pregap = 1;
    }
    cols[_i52] = {
      type: "align",
      align,
      pregap,
      postgap: 0
    };
  }
  res.colSeparationType = isAligned ? "align" : "alignat";
  return res;
};
defineEnvironment({
  type: "array",
  names: ["array", "darray"],
  props: {
    numArgs: 1
  },
  handler(context, args) {
    var symNode = checkSymbolNodeType(args[0]);
    var colalign = symNode ? [args[0]] : assertNodeType(args[0], "ordgroup").body;
    var cols = colalign.map(function(nde) {
      var node = assertSymbolNodeType(nde);
      var ca = node.text;
      if ("lcr".indexOf(ca) !== -1) {
        return {
          type: "align",
          align: ca
        };
      } else if (ca === "|") {
        return {
          type: "separator",
          separator: "|"
        };
      } else if (ca === ":") {
        return {
          type: "separator",
          separator: ":"
        };
      }
      throw new ParseError("Unknown column alignment: " + ca, nde);
    });
    var res = {
      cols,
      hskipBeforeAndAfter: true,
      // \@preamble in lttab.dtx
      maxNumCols: cols.length
    };
    return parseArray(context.parser, res, dCellStyle(context.envName));
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "matrix*", "pmatrix*", "bmatrix*", "Bmatrix*", "vmatrix*", "Vmatrix*"],
  props: {
    numArgs: 0
  },
  handler(context) {
    var delimiters2 = {
      "matrix": null,
      "pmatrix": ["(", ")"],
      "bmatrix": ["[", "]"],
      "Bmatrix": ["\\{", "\\}"],
      "vmatrix": ["|", "|"],
      "Vmatrix": ["\\Vert", "\\Vert"]
    }[context.envName.replace("*", "")];
    var colAlign = "c";
    var payload = {
      hskipBeforeAndAfter: false,
      cols: [{
        type: "align",
        align: colAlign
      }]
    };
    if (context.envName.charAt(context.envName.length - 1) === "*") {
      var parser = context.parser;
      parser.consumeSpaces();
      if (parser.fetch().text === "[") {
        parser.consume();
        parser.consumeSpaces();
        colAlign = parser.fetch().text;
        if ("lcr".indexOf(colAlign) === -1) {
          throw new ParseError("Expected l or c or r", parser.nextToken);
        }
        parser.consume();
        parser.consumeSpaces();
        parser.expect("]");
        parser.consume();
        payload.cols = [{
          type: "align",
          align: colAlign
        }];
      }
    }
    var res = parseArray(context.parser, payload, dCellStyle(context.envName));
    var numCols = Math.max(0, ...res.body.map((row) => row.length));
    res.cols = new Array(numCols).fill({
      type: "align",
      align: colAlign
    });
    return delimiters2 ? {
      type: "leftright",
      mode: context.mode,
      body: [res],
      left: delimiters2[0],
      right: delimiters2[1],
      rightColor: void 0
      // \right uninfluenced by \color in array
    } : res;
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["smallmatrix"],
  props: {
    numArgs: 0
  },
  handler(context) {
    var payload = {
      arraystretch: 0.5
    };
    var res = parseArray(context.parser, payload, "script");
    res.colSeparationType = "small";
    return res;
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["subarray"],
  props: {
    numArgs: 1
  },
  handler(context, args) {
    var symNode = checkSymbolNodeType(args[0]);
    var colalign = symNode ? [args[0]] : assertNodeType(args[0], "ordgroup").body;
    var cols = colalign.map(function(nde) {
      var node = assertSymbolNodeType(nde);
      var ca = node.text;
      if ("lc".indexOf(ca) !== -1) {
        return {
          type: "align",
          align: ca
        };
      }
      throw new ParseError("Unknown column alignment: " + ca, nde);
    });
    if (cols.length > 1) {
      throw new ParseError("{subarray} can contain only one column");
    }
    var res = {
      cols,
      hskipBeforeAndAfter: false,
      arraystretch: 0.5
    };
    res = parseArray(context.parser, res, "script");
    if (res.body.length > 0 && res.body[0].length > 1) {
      throw new ParseError("{subarray} can contain only one column");
    }
    return res;
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["cases", "dcases", "rcases", "drcases"],
  props: {
    numArgs: 0
  },
  handler(context) {
    var payload = {
      arraystretch: 1.2,
      cols: [{
        type: "align",
        align: "l",
        pregap: 0,
        // TODO(kevinb) get the current style.
        // For now we use the metrics for TEXT style which is what we were
        // doing before.  Before attempting to get the current style we
        // should look at TeX's behavior especially for \over and matrices.
        postgap: 1
        /* 1em quad */
      }, {
        type: "align",
        align: "l",
        pregap: 0,
        postgap: 0
      }]
    };
    var res = parseArray(context.parser, payload, dCellStyle(context.envName));
    return {
      type: "leftright",
      mode: context.mode,
      body: [res],
      left: context.envName.indexOf("r") > -1 ? "." : "\\{",
      right: context.envName.indexOf("r") > -1 ? "\\}" : ".",
      rightColor: void 0
    };
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["align", "align*", "aligned", "split"],
  props: {
    numArgs: 0
  },
  handler: alignedHandler,
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["gathered", "gather", "gather*"],
  props: {
    numArgs: 0
  },
  handler(context) {
    if (utils.contains(["gather", "gather*"], context.envName)) {
      validateAmsEnvironmentContext(context);
    }
    var res = {
      cols: [{
        type: "align",
        align: "c"
      }],
      addJot: true,
      colSeparationType: "gather",
      autoTag: getAutoTag(context.envName),
      emptySingleRow: true,
      leqno: context.parser.settings.leqno
    };
    return parseArray(context.parser, res, "display");
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["alignat", "alignat*", "alignedat"],
  props: {
    numArgs: 1
  },
  handler: alignedHandler,
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["equation", "equation*"],
  props: {
    numArgs: 0
  },
  handler(context) {
    validateAmsEnvironmentContext(context);
    var res = {
      autoTag: getAutoTag(context.envName),
      emptySingleRow: true,
      singleRow: true,
      maxNumCols: 1,
      leqno: context.parser.settings.leqno
    };
    return parseArray(context.parser, res, "display");
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineEnvironment({
  type: "array",
  names: ["CD"],
  props: {
    numArgs: 0
  },
  handler(context) {
    validateAmsEnvironmentContext(context);
    return parseCD(context.parser);
  },
  htmlBuilder: htmlBuilder$6,
  mathmlBuilder: mathmlBuilder$5
});
defineMacro("\\nonumber", "\\gdef\\@eqnsw{0}");
defineMacro("\\notag", "\\nonumber");
defineFunction({
  type: "text",
  // Doesn't matter what this is.
  names: ["\\hline", "\\hdashline"],
  props: {
    numArgs: 0,
    allowedInText: true,
    allowedInMath: true
  },
  handler(context, args) {
    throw new ParseError(context.funcName + " valid only within array environment");
  }
});
var environments = _environments;
defineFunction({
  type: "environment",
  names: ["\\begin", "\\end"],
  props: {
    numArgs: 1,
    argTypes: ["text"]
  },
  handler(_ref, args) {
    var {
      parser,
      funcName
    } = _ref;
    var nameGroup = args[0];
    if (nameGroup.type !== "ordgroup") {
      throw new ParseError("Invalid environment name", nameGroup);
    }
    var envName = "";
    for (var i2 = 0; i2 < nameGroup.body.length; ++i2) {
      envName += assertNodeType(nameGroup.body[i2], "textord").text;
    }
    if (funcName === "\\begin") {
      if (!environments.hasOwnProperty(envName)) {
        throw new ParseError("No such environment: " + envName, nameGroup);
      }
      var env = environments[envName];
      var {
        args: _args,
        optArgs
      } = parser.parseArguments("\\begin{" + envName + "}", env);
      var context = {
        mode: parser.mode,
        envName,
        parser
      };
      var result = env.handler(context, _args, optArgs);
      parser.expect("\\end", false);
      var endNameToken = parser.nextToken;
      var end = assertNodeType(parser.parseFunction(), "environment");
      if (end.name !== envName) {
        throw new ParseError("Mismatch: \\begin{" + envName + "} matched by \\end{" + end.name + "}", endNameToken);
      }
      return result;
    }
    return {
      type: "environment",
      mode: parser.mode,
      name: envName,
      nameGroup
    };
  }
});
var htmlBuilder$5 = (group, options) => {
  var font = group.font;
  var newOptions = options.withFont(font);
  return buildGroup$1(group.body, newOptions);
};
var mathmlBuilder$4 = (group, options) => {
  var font = group.font;
  var newOptions = options.withFont(font);
  return buildGroup2(group.body, newOptions);
};
var fontAliases = {
  "\\Bbb": "\\mathbb",
  "\\bold": "\\mathbf",
  "\\frak": "\\mathfrak",
  "\\bm": "\\boldsymbol"
};
defineFunction({
  type: "font",
  names: [
    // styles, except \boldsymbol defined below
    "\\mathrm",
    "\\mathit",
    "\\mathbf",
    "\\mathnormal",
    "\\mathsfit",
    // families
    "\\mathbb",
    "\\mathcal",
    "\\mathfrak",
    "\\mathscr",
    "\\mathsf",
    "\\mathtt",
    // aliases, except \bm defined below
    "\\Bbb",
    "\\bold",
    "\\frak"
  ],
  props: {
    numArgs: 1,
    allowedInArgument: true
  },
  handler: (_ref, args) => {
    var {
      parser,
      funcName
    } = _ref;
    var body = normalizeArgument(args[0]);
    var func = funcName;
    if (func in fontAliases) {
      func = fontAliases[func];
    }
    return {
      type: "font",
      mode: parser.mode,
      font: func.slice(1),
      body
    };
  },
  htmlBuilder: htmlBuilder$5,
  mathmlBuilder: mathmlBuilder$4
});
defineFunction({
  type: "mclass",
  names: ["\\boldsymbol", "\\bm"],
  props: {
    numArgs: 1
  },
  handler: (_ref2, args) => {
    var {
      parser
    } = _ref2;
    var body = args[0];
    var isCharacterBox3 = utils.isCharacterBox(body);
    return {
      type: "mclass",
      mode: parser.mode,
      mclass: binrelClass(body),
      body: [{
        type: "font",
        mode: parser.mode,
        font: "boldsymbol",
        body
      }],
      isCharacterBox: isCharacterBox3
    };
  }
});
defineFunction({
  type: "font",
  names: ["\\rm", "\\sf", "\\tt", "\\bf", "\\it", "\\cal"],
  props: {
    numArgs: 0,
    allowedInText: true
  },
  handler: (_ref3, args) => {
    var {
      parser,
      funcName,
      breakOnTokenText
    } = _ref3;
    var {
      mode
    } = parser;
    var body = parser.parseExpression(true, breakOnTokenText);
    var style = "math" + funcName.slice(1);
    return {
      type: "font",
      mode,
      font: style,
      body: {
        type: "ordgroup",
        mode: parser.mode,
        body
      }
    };
  },
  htmlBuilder: htmlBuilder$5,
  mathmlBuilder: mathmlBuilder$4
});
var adjustStyle = (size, originalStyle) => {
  var style = originalStyle;
  if (size === "display") {
    style = style.id >= Style$1.SCRIPT.id ? style.text() : Style$1.DISPLAY;
  } else if (size === "text" && style.size === Style$1.DISPLAY.size) {
    style = Style$1.TEXT;
  } else if (size === "script") {
    style = Style$1.SCRIPT;
  } else if (size === "scriptscript") {
    style = Style$1.SCRIPTSCRIPT;
  }
  return style;
};
var htmlBuilder$4 = (group, options) => {
  var style = adjustStyle(group.size, options.style);
  var nstyle = style.fracNum();
  var dstyle = style.fracDen();
  var newOptions;
  newOptions = options.havingStyle(nstyle);
  var numerm = buildGroup$1(group.numer, newOptions, options);
  if (group.continued) {
    var hStrut = 8.5 / options.fontMetrics().ptPerEm;
    var dStrut = 3.5 / options.fontMetrics().ptPerEm;
    numerm.height = numerm.height < hStrut ? hStrut : numerm.height;
    numerm.depth = numerm.depth < dStrut ? dStrut : numerm.depth;
  }
  newOptions = options.havingStyle(dstyle);
  var denomm = buildGroup$1(group.denom, newOptions, options);
  var rule;
  var ruleWidth;
  var ruleSpacing;
  if (group.hasBarLine) {
    if (group.barSize) {
      ruleWidth = calculateSize(group.barSize, options);
      rule = buildCommon.makeLineSpan("frac-line", options, ruleWidth);
    } else {
      rule = buildCommon.makeLineSpan("frac-line", options);
    }
    ruleWidth = rule.height;
    ruleSpacing = rule.height;
  } else {
    rule = null;
    ruleWidth = 0;
    ruleSpacing = options.fontMetrics().defaultRuleThickness;
  }
  var numShift;
  var clearance;
  var denomShift;
  if (style.size === Style$1.DISPLAY.size || group.size === "display") {
    numShift = options.fontMetrics().num1;
    if (ruleWidth > 0) {
      clearance = 3 * ruleSpacing;
    } else {
      clearance = 7 * ruleSpacing;
    }
    denomShift = options.fontMetrics().denom1;
  } else {
    if (ruleWidth > 0) {
      numShift = options.fontMetrics().num2;
      clearance = ruleSpacing;
    } else {
      numShift = options.fontMetrics().num3;
      clearance = 3 * ruleSpacing;
    }
    denomShift = options.fontMetrics().denom2;
  }
  var frac;
  if (!rule) {
    var candidateClearance = numShift - numerm.depth - (denomm.height - denomShift);
    if (candidateClearance < clearance) {
      numShift += 0.5 * (clearance - candidateClearance);
      denomShift += 0.5 * (clearance - candidateClearance);
    }
    frac = buildCommon.makeVList({
      positionType: "individualShift",
      children: [{
        type: "elem",
        elem: denomm,
        shift: denomShift
      }, {
        type: "elem",
        elem: numerm,
        shift: -numShift
      }]
    }, options);
  } else {
    var axisHeight = options.fontMetrics().axisHeight;
    if (numShift - numerm.depth - (axisHeight + 0.5 * ruleWidth) < clearance) {
      numShift += clearance - (numShift - numerm.depth - (axisHeight + 0.5 * ruleWidth));
    }
    if (axisHeight - 0.5 * ruleWidth - (denomm.height - denomShift) < clearance) {
      denomShift += clearance - (axisHeight - 0.5 * ruleWidth - (denomm.height - denomShift));
    }
    var midShift = -(axisHeight - 0.5 * ruleWidth);
    frac = buildCommon.makeVList({
      positionType: "individualShift",
      children: [{
        type: "elem",
        elem: denomm,
        shift: denomShift
      }, {
        type: "elem",
        elem: rule,
        shift: midShift
      }, {
        type: "elem",
        elem: numerm,
        shift: -numShift
      }]
    }, options);
  }
  newOptions = options.havingStyle(style);
  frac.height *= newOptions.sizeMultiplier / options.sizeMultiplier;
  frac.depth *= newOptions.sizeMultiplier / options.sizeMultiplier;
  var delimSize;
  if (style.size === Style$1.DISPLAY.size) {
    delimSize = options.fontMetrics().delim1;
  } else if (style.size === Style$1.SCRIPTSCRIPT.size) {
    delimSize = options.havingStyle(Style$1.SCRIPT).fontMetrics().delim2;
  } else {
    delimSize = options.fontMetrics().delim2;
  }
  var leftDelim;
  var rightDelim;
  if (group.leftDelim == null) {
    leftDelim = makeNullDelimiter(options, ["mopen"]);
  } else {
    leftDelim = delimiter.customSizedDelim(group.leftDelim, delimSize, true, options.havingStyle(style), group.mode, ["mopen"]);
  }
  if (group.continued) {
    rightDelim = buildCommon.makeSpan([]);
  } else if (group.rightDelim == null) {
    rightDelim = makeNullDelimiter(options, ["mclose"]);
  } else {
    rightDelim = delimiter.customSizedDelim(group.rightDelim, delimSize, true, options.havingStyle(style), group.mode, ["mclose"]);
  }
  return buildCommon.makeSpan(["mord"].concat(newOptions.sizingClasses(options)), [leftDelim, buildCommon.makeSpan(["mfrac"], [frac]), rightDelim], options);
};
var mathmlBuilder$3 = (group, options) => {
  var node = new mathMLTree.MathNode("mfrac", [buildGroup2(group.numer, options), buildGroup2(group.denom, options)]);
  if (!group.hasBarLine) {
    node.setAttribute("linethickness", "0px");
  } else if (group.barSize) {
    var ruleWidth = calculateSize(group.barSize, options);
    node.setAttribute("linethickness", makeEm(ruleWidth));
  }
  var style = adjustStyle(group.size, options.style);
  if (style.size !== options.style.size) {
    node = new mathMLTree.MathNode("mstyle", [node]);
    var isDisplay = style.size === Style$1.DISPLAY.size ? "true" : "false";
    node.setAttribute("displaystyle", isDisplay);
    node.setAttribute("scriptlevel", "0");
  }
  if (group.leftDelim != null || group.rightDelim != null) {
    var withDelims = [];
    if (group.leftDelim != null) {
      var leftOp = new mathMLTree.MathNode("mo", [new mathMLTree.TextNode(group.leftDelim.replace("\\", ""))]);
      leftOp.setAttribute("fence", "true");
      withDelims.push(leftOp);
    }
    withDelims.push(node);
    if (group.rightDelim != null) {
      var rightOp = new mathMLTree.MathNode("mo", [new mathMLTree.TextNode(group.rightDelim.replace("\\", ""))]);
      rightOp.setAttribute("fence", "true");
      withDelims.push(rightOp);
    }
    return makeRow(withDelims);
  }
  return node;
};
defineFunction({
  type: "genfrac",
  names: [
    "\\dfrac",
    "\\frac",
    "\\tfrac",
    "\\dbinom",
    "\\binom",
    "\\tbinom",
    "\\\\atopfrac",
    // can’t be entered directly
    "\\\\bracefrac",
    "\\\\brackfrac"
    // ditto
  ],
  props: {
    numArgs: 2,
    allowedInArgument: true
  },
  handler: (_ref, args) => {
    var {
      parser,
      funcName
    } = _ref;
    var numer = args[0];
    var denom = args[1];
    var hasBarLine;
    var leftDelim = null;
    var rightDelim = null;
    var size = "auto";
    switch (funcName) {
      case "\\dfrac":
      case "\\frac":
      case "\\tfrac":
        hasBarLine = true;
        break;
      case "\\\\atopfrac":
        hasBarLine = false;
        break;
      case "\\dbinom":
      case "\\binom":
      case "\\tbinom":
        hasBarLine = false;
        leftDelim = "(";
        rightDelim = ")";
        break;
      case "\\\\bracefrac":
        hasBarLine = false;
        leftDelim = "\\{";
        rightDelim = "\\}";
        break;
      case "\\\\brackfrac":
        hasBarLine = false;
        leftDelim = "[";
        rightDelim = "]";
        break;
      default:
        throw new Error("Unrecognized genfrac command");
    }
    switch (funcName) {
      case "\\dfrac":
      case "\\dbinom":
        size = "display";
        break;
      case "\\tfrac":
      case "\\tbinom":
        size = "text";
        break;
    }
    return {
      type: "genfrac",
      mode: parser.mode,
      continued: false,
      numer,
      denom,
      hasBarLine,
      leftDelim,
      rightDelim,
      size,
      barSize: null
    };
  },
  htmlBuilder: htmlBuilder$4,
  mathmlBuilder: mathmlBuilder$3
});
defineFunction({
  type: "genfrac",
  names: ["\\cfrac"],
  props: {
    numArgs: 2
  },
  handler: (_ref2, args) => {
    var {
      parser,
      funcName
    } = _ref2;
    var numer = args[0];
    var denom = args[1];
    return {
      type: "genfrac",
      mode: parser.mode,
      continued: true,
      numer,
      denom,
      hasBarLine: true,
      leftDelim: null,
      rightDelim: null,
      size: "display",
      barSize: null
    };
  }
});
defineFunction({
  type: "infix",
  names: ["\\over", "\\choose", "\\atop", "\\brace", "\\brack"],
  props: {
    numArgs: 0,
    infix: true
  },
  handler(_ref3) {
    var {
      parser,
      funcName,
      token
    } = _ref3;
    var replaceWith;
    switch (funcName) {
      case "\\over":
        replaceWith = "\\frac";
        break;
      case "\\choose":
        replaceWith = "\\binom";
        break;
      case "\\atop":
        replaceWith = "\\\\atopfrac";
        break;
      case "\\brace":
        replaceWith = "\\\\bracefrac";
        break;
      case "\\brack":
        replaceWith = "\\\\brackfrac";
        break;
      default:
        throw new Error("Unrecognized infix genfrac command");
    }
    return {
      type: "infix",
      mode: parser.mode,
      replaceWith,
      token
    };
  }
});
var stylArray = ["display", "text", "script", "scriptscript"];
var delimFromValue = function delimFromValue2(delimString) {
  var delim = null;
  if (delimString.length > 0) {
    delim = delimString;
    delim = delim === "." ? null : delim;
  }
  return delim;
};
defineFunction({
  type: "genfrac",
  names: ["\\genfrac"],
  props: {
    numArgs: 6,
    allowedInArgument: true,
    argTypes: ["math", "math", "size", "text", "math", "math"]
  },
  handler(_ref4, args) {
    var {
      parser
    } = _ref4;
    var numer = args[4];
    var denom = args[5];
    var leftNode = normalizeArgument(args[0]);
    var leftDelim = leftNode.type === "atom" && leftNode.family === "open" ? delimFromValue(leftNode.text) : null;
    var rightNode = normalizeArgument(args[1]);
    var rightDelim = rightNode.type === "atom" && rightNode.family === "close" ? delimFromValue(rightNode.text) : null;
    var barNode = assertNodeType(args[2], "size");
    var hasBarLine;
    var barSize = null;
    if (barNode.isBlank) {
      hasBarLine = true;
    } else {
      barSize = barNode.value;
      hasBarLine = barSize.number > 0;
    }
    var size = "auto";
    var styl = args[3];
    if (styl.type === "ordgroup") {
      if (styl.body.length > 0) {
        var textOrd = assertNodeType(styl.body[0], "textord");
        size = stylArray[Number(textOrd.text)];
      }
    } else {
      styl = assertNodeType(styl, "textord");
      size = stylArray[Number(styl.text)];
    }
    return {
      type: "genfrac",
      mode: parser.mode,
      numer,
      denom,
      continued: false,
      hasBarLine,
      barSize,
      leftDelim,
      rightDelim,
      size
    };
  },
  htmlBuilder: htmlBuilder$4,
  mathmlBuilder: mathmlBuilder$3
});
defineFunction({
  type: "infix",
  names: ["\\above"],
  props: {
    numArgs: 1,
    argTypes: ["size"],
    infix: true
  },
  handler(_ref5, args) {
    var {
      parser,
      funcName,
      token
    } = _ref5;
    return {
      type: "infix",
      mode: parser.mode,
      replaceWith: "\\\\abovefrac",
      size: assertNodeType(args[0], "size").value,
      token
    };
  }
});
defineFunction({
  type: "genfrac",
  names: ["\\\\abovefrac"],
  props: {
    numArgs: 3,
    argTypes: ["math", "size", "math"]
  },
  handler: (_ref6, args) => {
    var {
      parser,
      funcName
    } = _ref6;
    var numer = args[0];
    var barSize = assert(assertNodeType(args[1], "infix").size);
    var denom = args[2];
    var hasBarLine = barSize.number > 0;
    return {
      type: "genfrac",
      mode: parser.mode,
      numer,
      denom,
      continued: false,
      hasBarLine,
      barSize,
      leftDelim: null,
      rightDelim: null,
      size: "auto"
    };
  },
  htmlBuilder: htmlBuilder$4,
  mathmlBuilder: mathmlBuilder$3
});
var htmlBuilder$3 = (grp, options) => {
  var style = options.style;
  var supSubGroup;
  var group;
  if (grp.type === "supsub") {
    supSubGroup = grp.sup ? buildGroup$1(grp.sup, options.havingStyle(style.sup()), options) : buildGroup$1(grp.sub, options.havingStyle(style.sub()), options);
    group = assertNodeType(grp.base, "horizBrace");
  } else {
    group = assertNodeType(grp, "horizBrace");
  }
  var body = buildGroup$1(group.base, options.havingBaseStyle(Style$1.DISPLAY));
  var braceBody = stretchy.svgSpan(group, options);
  var vlist;
  if (group.isOver) {
    vlist = buildCommon.makeVList({
      positionType: "firstBaseline",
      children: [{
        type: "elem",
        elem: body
      }, {
        type: "kern",
        size: 0.1
      }, {
        type: "elem",
        elem: braceBody
      }]
    }, options);
    vlist.children[0].children[0].children[1].classes.push("svg-align");
  } else {
    vlist = buildCommon.makeVList({
      positionType: "bottom",
      positionData: body.depth + 0.1 + braceBody.height,
      children: [{
        type: "elem",
        elem: braceBody
      }, {
        type: "kern",
        size: 0.1
      }, {
        type: "elem",
        elem: body
      }]
    }, options);
    vlist.children[0].children[0].children[0].classes.push("svg-align");
  }
  if (supSubGroup) {
    var vSpan = buildCommon.makeSpan(["mord", group.isOver ? "mover" : "munder"], [vlist], options);
    if (group.isOver) {
      vlist = buildCommon.makeVList({
        positionType: "firstBaseline",
        children: [{
          type: "elem",
          elem: vSpan
        }, {
          type: "kern",
          size: 0.2
        }, {
          type: "elem",
          elem: supSubGroup
        }]
      }, options);
    } else {
      vlist = buildCommon.makeVList({
        positionType: "bottom",
        positionData: vSpan.depth + 0.2 + supSubGroup.height + supSubGroup.depth,
        children: [{
          type: "elem",
          elem: supSubGroup
        }, {
          type: "kern",
          size: 0.2
        }, {
          type: "elem",
          elem: vSpan
        }]
      }, options);
    }
  }
  return buildCommon.makeSpan(["mord", group.isOver ? "mover" : "munder"], [vlist], options);
};
var mathmlBuilder$2 = (group, options) => {
  var accentNode = stretchy.mathMLnode(group.label);
  return new mathMLTree.MathNode(group.isOver ? "mover" : "munder", [buildGroup2(group.base, options), accentNode]);
};
defineFunction({
  type: "horizBrace",
  names: ["\\overbrace", "\\underbrace"],
  props: {
    numArgs: 1
  },
  handler(_ref, args) {
    var {
      parser,
      funcName
    } = _ref;
    return {
      type: "horizBrace",
      mode: parser.mode,
      label: funcName,
      isOver: /^\\over/.test(funcName),
      base: args[0]
    };
  },
  htmlBuilder: htmlBuilder$3,
  mathmlBuilder: mathmlBuilder$2
});
defineFunction({
  type: "href",
  names: ["\\href"],
  props: {
    numArgs: 2,
    argTypes: ["url", "original"],
    allowedInText: true
  },
  handler: (_ref, args) => {
    var {
      parser
    } = _ref;
    var body = args[1];
    var href = assertNodeType(args[0], "url").url;
    if (!parser.settings.isTrusted({
      command: "\\href",
      url: href
    })) {
      return parser.formatUnsupportedCmd("\\href");
    }
    return {
      type: "href",
      mode: parser.mode,
      href,
      body: ordargument(body)
    };
  },
  htmlBuilder: (group, options) => {
    var elements = buildExpression$1(group.body, options, false);
    return buildCommon.makeAnchor(group.href, [], elements, options);
  },
  mathmlBuilder: (group, options) => {
    var math2 = buildExpressionRow(group.body, options);
    if (!(math2 instanceof MathNode)) {
      math2 = new MathNode("mrow", [math2]);
    }
    math2.setAttribute("href", group.href);
    return math2;
  }
});
defineFunction({
  type: "href",
  names: ["\\url"],
  props: {
    numArgs: 1,
    argTypes: ["url"],
    allowedInText: true
  },
  handler: (_ref2, args) => {
    var {
      parser
    } = _ref2;
    var href = assertNodeType(args[0], "url").url;
    if (!parser.settings.isTrusted({
      command: "\\url",
      url: href
    })) {
      return parser.formatUnsupportedCmd("\\url");
    }
    var chars = [];
    for (var i2 = 0; i2 < href.length; i2++) {
      var c = href[i2];
      if (c === "~") {
        c = "\\textasciitilde";
      }
      chars.push({
        type: "textord",
        mode: "text",
        text: c
      });
    }
    var body = {
      type: "text",
      mode: parser.mode,
      font: "\\texttt",
      body: chars
    };
    return {
      type: "href",
      mode: parser.mode,
      href,
      body: ordargument(body)
    };
  }
});
defineFunction({
  type: "hbox",
  names: ["\\hbox"],
  props: {
    numArgs: 1,
    argTypes: ["text"],
    allowedInText: true,
    primitive: true
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    return {
      type: "hbox",
      mode: parser.mode,
      body: ordargument(args[0])
    };
  },
  htmlBuilder(group, options) {
    var elements = buildExpression$1(group.body, options, false);
    return buildCommon.makeFragment(elements);
  },
  mathmlBuilder(group, options) {
    return new mathMLTree.MathNode("mrow", buildExpression2(group.body, options));
  }
});
defineFunction({
  type: "html",
  names: ["\\htmlClass", "\\htmlId", "\\htmlStyle", "\\htmlData"],
  props: {
    numArgs: 2,
    argTypes: ["raw", "original"],
    allowedInText: true
  },
  handler: (_ref, args) => {
    var {
      parser,
      funcName,
      token
    } = _ref;
    var value = assertNodeType(args[0], "raw").string;
    var body = args[1];
    if (parser.settings.strict) {
      parser.settings.reportNonstrict("htmlExtension", "HTML extension is disabled on strict mode");
    }
    var trustContext;
    var attributes = {};
    switch (funcName) {
      case "\\htmlClass":
        attributes.class = value;
        trustContext = {
          command: "\\htmlClass",
          class: value
        };
        break;
      case "\\htmlId":
        attributes.id = value;
        trustContext = {
          command: "\\htmlId",
          id: value
        };
        break;
      case "\\htmlStyle":
        attributes.style = value;
        trustContext = {
          command: "\\htmlStyle",
          style: value
        };
        break;
      case "\\htmlData": {
        var data = value.split(",");
        for (var i2 = 0; i2 < data.length; i2++) {
          var keyVal = data[i2].split("=");
          if (keyVal.length !== 2) {
            throw new ParseError("Error parsing key-value for \\htmlData");
          }
          attributes["data-" + keyVal[0].trim()] = keyVal[1].trim();
        }
        trustContext = {
          command: "\\htmlData",
          attributes
        };
        break;
      }
      default:
        throw new Error("Unrecognized html command");
    }
    if (!parser.settings.isTrusted(trustContext)) {
      return parser.formatUnsupportedCmd(funcName);
    }
    return {
      type: "html",
      mode: parser.mode,
      attributes,
      body: ordargument(body)
    };
  },
  htmlBuilder: (group, options) => {
    var elements = buildExpression$1(group.body, options, false);
    var classes = ["enclosing"];
    if (group.attributes.class) {
      classes.push(...group.attributes.class.trim().split(/\s+/));
    }
    var span = buildCommon.makeSpan(classes, elements, options);
    for (var attr in group.attributes) {
      if (attr !== "class" && group.attributes.hasOwnProperty(attr)) {
        span.setAttribute(attr, group.attributes[attr]);
      }
    }
    return span;
  },
  mathmlBuilder: (group, options) => {
    return buildExpressionRow(group.body, options);
  }
});
defineFunction({
  type: "htmlmathml",
  names: ["\\html@mathml"],
  props: {
    numArgs: 2,
    allowedInText: true
  },
  handler: (_ref, args) => {
    var {
      parser
    } = _ref;
    return {
      type: "htmlmathml",
      mode: parser.mode,
      html: ordargument(args[0]),
      mathml: ordargument(args[1])
    };
  },
  htmlBuilder: (group, options) => {
    var elements = buildExpression$1(group.html, options, false);
    return buildCommon.makeFragment(elements);
  },
  mathmlBuilder: (group, options) => {
    return buildExpressionRow(group.mathml, options);
  }
});
var sizeData = function sizeData2(str) {
  if (/^[-+]? *(\d+(\.\d*)?|\.\d+)$/.test(str)) {
    return {
      number: +str,
      unit: "bp"
    };
  } else {
    var match = /([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/.exec(str);
    if (!match) {
      throw new ParseError("Invalid size: '" + str + "' in \\includegraphics");
    }
    var data = {
      number: +(match[1] + match[2]),
      // sign + magnitude, cast to number
      unit: match[3]
    };
    if (!validUnit(data)) {
      throw new ParseError("Invalid unit: '" + data.unit + "' in \\includegraphics.");
    }
    return data;
  }
};
defineFunction({
  type: "includegraphics",
  names: ["\\includegraphics"],
  props: {
    numArgs: 1,
    numOptionalArgs: 1,
    argTypes: ["raw", "url"],
    allowedInText: false
  },
  handler: (_ref, args, optArgs) => {
    var {
      parser
    } = _ref;
    var width = {
      number: 0,
      unit: "em"
    };
    var height = {
      number: 0.9,
      unit: "em"
    };
    var totalheight = {
      number: 0,
      unit: "em"
    };
    var alt = "";
    if (optArgs[0]) {
      var attributeStr = assertNodeType(optArgs[0], "raw").string;
      var attributes = attributeStr.split(",");
      for (var i2 = 0; i2 < attributes.length; i2++) {
        var keyVal = attributes[i2].split("=");
        if (keyVal.length === 2) {
          var str = keyVal[1].trim();
          switch (keyVal[0].trim()) {
            case "alt":
              alt = str;
              break;
            case "width":
              width = sizeData(str);
              break;
            case "height":
              height = sizeData(str);
              break;
            case "totalheight":
              totalheight = sizeData(str);
              break;
            default:
              throw new ParseError("Invalid key: '" + keyVal[0] + "' in \\includegraphics.");
          }
        }
      }
    }
    var src = assertNodeType(args[0], "url").url;
    if (alt === "") {
      alt = src;
      alt = alt.replace(/^.*[\\/]/, "");
      alt = alt.substring(0, alt.lastIndexOf("."));
    }
    if (!parser.settings.isTrusted({
      command: "\\includegraphics",
      url: src
    })) {
      return parser.formatUnsupportedCmd("\\includegraphics");
    }
    return {
      type: "includegraphics",
      mode: parser.mode,
      alt,
      width,
      height,
      totalheight,
      src
    };
  },
  htmlBuilder: (group, options) => {
    var height = calculateSize(group.height, options);
    var depth = 0;
    if (group.totalheight.number > 0) {
      depth = calculateSize(group.totalheight, options) - height;
    }
    var width = 0;
    if (group.width.number > 0) {
      width = calculateSize(group.width, options);
    }
    var style = {
      height: makeEm(height + depth)
    };
    if (width > 0) {
      style.width = makeEm(width);
    }
    if (depth > 0) {
      style.verticalAlign = makeEm(-depth);
    }
    var node = new Img(group.src, group.alt, style);
    node.height = height;
    node.depth = depth;
    return node;
  },
  mathmlBuilder: (group, options) => {
    var node = new mathMLTree.MathNode("mglyph", []);
    node.setAttribute("alt", group.alt);
    var height = calculateSize(group.height, options);
    var depth = 0;
    if (group.totalheight.number > 0) {
      depth = calculateSize(group.totalheight, options) - height;
      node.setAttribute("valign", makeEm(-depth));
    }
    node.setAttribute("height", makeEm(height + depth));
    if (group.width.number > 0) {
      var width = calculateSize(group.width, options);
      node.setAttribute("width", makeEm(width));
    }
    node.setAttribute("src", group.src);
    return node;
  }
});
defineFunction({
  type: "kern",
  names: ["\\kern", "\\mkern", "\\hskip", "\\mskip"],
  props: {
    numArgs: 1,
    argTypes: ["size"],
    primitive: true,
    allowedInText: true
  },
  handler(_ref, args) {
    var {
      parser,
      funcName
    } = _ref;
    var size = assertNodeType(args[0], "size");
    if (parser.settings.strict) {
      var mathFunction = funcName[1] === "m";
      var muUnit = size.value.unit === "mu";
      if (mathFunction) {
        if (!muUnit) {
          parser.settings.reportNonstrict("mathVsTextUnits", "LaTeX's " + funcName + " supports only mu units, " + ("not " + size.value.unit + " units"));
        }
        if (parser.mode !== "math") {
          parser.settings.reportNonstrict("mathVsTextUnits", "LaTeX's " + funcName + " works only in math mode");
        }
      } else {
        if (muUnit) {
          parser.settings.reportNonstrict("mathVsTextUnits", "LaTeX's " + funcName + " doesn't support mu units");
        }
      }
    }
    return {
      type: "kern",
      mode: parser.mode,
      dimension: size.value
    };
  },
  htmlBuilder(group, options) {
    return buildCommon.makeGlue(group.dimension, options);
  },
  mathmlBuilder(group, options) {
    var dimension = calculateSize(group.dimension, options);
    return new mathMLTree.SpaceNode(dimension);
  }
});
defineFunction({
  type: "lap",
  names: ["\\mathllap", "\\mathrlap", "\\mathclap"],
  props: {
    numArgs: 1,
    allowedInText: true
  },
  handler: (_ref, args) => {
    var {
      parser,
      funcName
    } = _ref;
    var body = args[0];
    return {
      type: "lap",
      mode: parser.mode,
      alignment: funcName.slice(5),
      body
    };
  },
  htmlBuilder: (group, options) => {
    var inner2;
    if (group.alignment === "clap") {
      inner2 = buildCommon.makeSpan([], [buildGroup$1(group.body, options)]);
      inner2 = buildCommon.makeSpan(["inner"], [inner2], options);
    } else {
      inner2 = buildCommon.makeSpan(["inner"], [buildGroup$1(group.body, options)]);
    }
    var fix = buildCommon.makeSpan(["fix"], []);
    var node = buildCommon.makeSpan([group.alignment], [inner2, fix], options);
    var strut = buildCommon.makeSpan(["strut"]);
    strut.style.height = makeEm(node.height + node.depth);
    if (node.depth) {
      strut.style.verticalAlign = makeEm(-node.depth);
    }
    node.children.unshift(strut);
    node = buildCommon.makeSpan(["thinbox"], [node], options);
    return buildCommon.makeSpan(["mord", "vbox"], [node], options);
  },
  mathmlBuilder: (group, options) => {
    var node = new mathMLTree.MathNode("mpadded", [buildGroup2(group.body, options)]);
    if (group.alignment !== "rlap") {
      var offset = group.alignment === "llap" ? "-1" : "-0.5";
      node.setAttribute("lspace", offset + "width");
    }
    node.setAttribute("width", "0px");
    return node;
  }
});
defineFunction({
  type: "styling",
  names: ["\\(", "$"],
  props: {
    numArgs: 0,
    allowedInText: true,
    allowedInMath: false
  },
  handler(_ref, args) {
    var {
      funcName,
      parser
    } = _ref;
    var outerMode = parser.mode;
    parser.switchMode("math");
    var close2 = funcName === "\\(" ? "\\)" : "$";
    var body = parser.parseExpression(false, close2);
    parser.expect(close2);
    parser.switchMode(outerMode);
    return {
      type: "styling",
      mode: parser.mode,
      style: "text",
      body
    };
  }
});
defineFunction({
  type: "text",
  // Doesn't matter what this is.
  names: ["\\)", "\\]"],
  props: {
    numArgs: 0,
    allowedInText: true,
    allowedInMath: false
  },
  handler(context, args) {
    throw new ParseError("Mismatched " + context.funcName);
  }
});
var chooseMathStyle = (group, options) => {
  switch (options.style.size) {
    case Style$1.DISPLAY.size:
      return group.display;
    case Style$1.TEXT.size:
      return group.text;
    case Style$1.SCRIPT.size:
      return group.script;
    case Style$1.SCRIPTSCRIPT.size:
      return group.scriptscript;
    default:
      return group.text;
  }
};
defineFunction({
  type: "mathchoice",
  names: ["\\mathchoice"],
  props: {
    numArgs: 4,
    primitive: true
  },
  handler: (_ref, args) => {
    var {
      parser
    } = _ref;
    return {
      type: "mathchoice",
      mode: parser.mode,
      display: ordargument(args[0]),
      text: ordargument(args[1]),
      script: ordargument(args[2]),
      scriptscript: ordargument(args[3])
    };
  },
  htmlBuilder: (group, options) => {
    var body = chooseMathStyle(group, options);
    var elements = buildExpression$1(body, options, false);
    return buildCommon.makeFragment(elements);
  },
  mathmlBuilder: (group, options) => {
    var body = chooseMathStyle(group, options);
    return buildExpressionRow(body, options);
  }
});
var assembleSupSub = (base, supGroup, subGroup, options, style, slant, baseShift) => {
  base = buildCommon.makeSpan([], [base]);
  var subIsSingleCharacter = subGroup && utils.isCharacterBox(subGroup);
  var sub2;
  var sup2;
  if (supGroup) {
    var elem = buildGroup$1(supGroup, options.havingStyle(style.sup()), options);
    sup2 = {
      elem,
      kern: Math.max(options.fontMetrics().bigOpSpacing1, options.fontMetrics().bigOpSpacing3 - elem.depth)
    };
  }
  if (subGroup) {
    var _elem = buildGroup$1(subGroup, options.havingStyle(style.sub()), options);
    sub2 = {
      elem: _elem,
      kern: Math.max(options.fontMetrics().bigOpSpacing2, options.fontMetrics().bigOpSpacing4 - _elem.height)
    };
  }
  var finalGroup;
  if (sup2 && sub2) {
    var bottom = options.fontMetrics().bigOpSpacing5 + sub2.elem.height + sub2.elem.depth + sub2.kern + base.depth + baseShift;
    finalGroup = buildCommon.makeVList({
      positionType: "bottom",
      positionData: bottom,
      children: [{
        type: "kern",
        size: options.fontMetrics().bigOpSpacing5
      }, {
        type: "elem",
        elem: sub2.elem,
        marginLeft: makeEm(-slant)
      }, {
        type: "kern",
        size: sub2.kern
      }, {
        type: "elem",
        elem: base
      }, {
        type: "kern",
        size: sup2.kern
      }, {
        type: "elem",
        elem: sup2.elem,
        marginLeft: makeEm(slant)
      }, {
        type: "kern",
        size: options.fontMetrics().bigOpSpacing5
      }]
    }, options);
  } else if (sub2) {
    var top = base.height - baseShift;
    finalGroup = buildCommon.makeVList({
      positionType: "top",
      positionData: top,
      children: [{
        type: "kern",
        size: options.fontMetrics().bigOpSpacing5
      }, {
        type: "elem",
        elem: sub2.elem,
        marginLeft: makeEm(-slant)
      }, {
        type: "kern",
        size: sub2.kern
      }, {
        type: "elem",
        elem: base
      }]
    }, options);
  } else if (sup2) {
    var _bottom = base.depth + baseShift;
    finalGroup = buildCommon.makeVList({
      positionType: "bottom",
      positionData: _bottom,
      children: [{
        type: "elem",
        elem: base
      }, {
        type: "kern",
        size: sup2.kern
      }, {
        type: "elem",
        elem: sup2.elem,
        marginLeft: makeEm(slant)
      }, {
        type: "kern",
        size: options.fontMetrics().bigOpSpacing5
      }]
    }, options);
  } else {
    return base;
  }
  var parts = [finalGroup];
  if (sub2 && slant !== 0 && !subIsSingleCharacter) {
    var spacer = buildCommon.makeSpan(["mspace"], [], options);
    spacer.style.marginRight = makeEm(slant);
    parts.unshift(spacer);
  }
  return buildCommon.makeSpan(["mop", "op-limits"], parts, options);
};
var noSuccessor = ["\\smallint"];
var htmlBuilder$2 = (grp, options) => {
  var supGroup;
  var subGroup;
  var hasLimits = false;
  var group;
  if (grp.type === "supsub") {
    supGroup = grp.sup;
    subGroup = grp.sub;
    group = assertNodeType(grp.base, "op");
    hasLimits = true;
  } else {
    group = assertNodeType(grp, "op");
  }
  var style = options.style;
  var large = false;
  if (style.size === Style$1.DISPLAY.size && group.symbol && !utils.contains(noSuccessor, group.name)) {
    large = true;
  }
  var base;
  if (group.symbol) {
    var fontName = large ? "Size2-Regular" : "Size1-Regular";
    var stash = "";
    if (group.name === "\\oiint" || group.name === "\\oiiint") {
      stash = group.name.slice(1);
      group.name = stash === "oiint" ? "\\iint" : "\\iiint";
    }
    base = buildCommon.makeSymbol(group.name, fontName, "math", options, ["mop", "op-symbol", large ? "large-op" : "small-op"]);
    if (stash.length > 0) {
      var italic = base.italic;
      var oval = buildCommon.staticSvg(stash + "Size" + (large ? "2" : "1"), options);
      base = buildCommon.makeVList({
        positionType: "individualShift",
        children: [{
          type: "elem",
          elem: base,
          shift: 0
        }, {
          type: "elem",
          elem: oval,
          shift: large ? 0.08 : 0
        }]
      }, options);
      group.name = "\\" + stash;
      base.classes.unshift("mop");
      base.italic = italic;
    }
  } else if (group.body) {
    var inner2 = buildExpression$1(group.body, options, true);
    if (inner2.length === 1 && inner2[0] instanceof SymbolNode) {
      base = inner2[0];
      base.classes[0] = "mop";
    } else {
      base = buildCommon.makeSpan(["mop"], inner2, options);
    }
  } else {
    var output = [];
    for (var i2 = 1; i2 < group.name.length; i2++) {
      output.push(buildCommon.mathsym(group.name[i2], group.mode, options));
    }
    base = buildCommon.makeSpan(["mop"], output, options);
  }
  var baseShift = 0;
  var slant = 0;
  if ((base instanceof SymbolNode || group.name === "\\oiint" || group.name === "\\oiiint") && !group.suppressBaseShift) {
    baseShift = (base.height - base.depth) / 2 - options.fontMetrics().axisHeight;
    slant = base.italic;
  }
  if (hasLimits) {
    return assembleSupSub(base, supGroup, subGroup, options, style, slant, baseShift);
  } else {
    if (baseShift) {
      base.style.position = "relative";
      base.style.top = makeEm(baseShift);
    }
    return base;
  }
};
var mathmlBuilder$1 = (group, options) => {
  var node;
  if (group.symbol) {
    node = new MathNode("mo", [makeText(group.name, group.mode)]);
    if (utils.contains(noSuccessor, group.name)) {
      node.setAttribute("largeop", "false");
    }
  } else if (group.body) {
    node = new MathNode("mo", buildExpression2(group.body, options));
  } else {
    node = new MathNode("mi", [new TextNode(group.name.slice(1))]);
    var operator = new MathNode("mo", [makeText("\u2061", "text")]);
    if (group.parentIsSupSub) {
      node = new MathNode("mrow", [node, operator]);
    } else {
      node = newDocumentFragment([node, operator]);
    }
  }
  return node;
};
var singleCharBigOps = {
  "\u220F": "\\prod",
  "\u2210": "\\coprod",
  "\u2211": "\\sum",
  "\u22C0": "\\bigwedge",
  "\u22C1": "\\bigvee",
  "\u22C2": "\\bigcap",
  "\u22C3": "\\bigcup",
  "\u2A00": "\\bigodot",
  "\u2A01": "\\bigoplus",
  "\u2A02": "\\bigotimes",
  "\u2A04": "\\biguplus",
  "\u2A06": "\\bigsqcup"
};
defineFunction({
  type: "op",
  names: ["\\coprod", "\\bigvee", "\\bigwedge", "\\biguplus", "\\bigcap", "\\bigcup", "\\intop", "\\prod", "\\sum", "\\bigotimes", "\\bigoplus", "\\bigodot", "\\bigsqcup", "\\smallint", "\u220F", "\u2210", "\u2211", "\u22C0", "\u22C1", "\u22C2", "\u22C3", "\u2A00", "\u2A01", "\u2A02", "\u2A04", "\u2A06"],
  props: {
    numArgs: 0
  },
  handler: (_ref, args) => {
    var {
      parser,
      funcName
    } = _ref;
    var fName = funcName;
    if (fName.length === 1) {
      fName = singleCharBigOps[fName];
    }
    return {
      type: "op",
      mode: parser.mode,
      limits: true,
      parentIsSupSub: false,
      symbol: true,
      name: fName
    };
  },
  htmlBuilder: htmlBuilder$2,
  mathmlBuilder: mathmlBuilder$1
});
defineFunction({
  type: "op",
  names: ["\\mathop"],
  props: {
    numArgs: 1,
    primitive: true
  },
  handler: (_ref2, args) => {
    var {
      parser
    } = _ref2;
    var body = args[0];
    return {
      type: "op",
      mode: parser.mode,
      limits: false,
      parentIsSupSub: false,
      symbol: false,
      body: ordargument(body)
    };
  },
  htmlBuilder: htmlBuilder$2,
  mathmlBuilder: mathmlBuilder$1
});
var singleCharIntegrals = {
  "\u222B": "\\int",
  "\u222C": "\\iint",
  "\u222D": "\\iiint",
  "\u222E": "\\oint",
  "\u222F": "\\oiint",
  "\u2230": "\\oiiint"
};
defineFunction({
  type: "op",
  names: ["\\arcsin", "\\arccos", "\\arctan", "\\arctg", "\\arcctg", "\\arg", "\\ch", "\\cos", "\\cosec", "\\cosh", "\\cot", "\\cotg", "\\coth", "\\csc", "\\ctg", "\\cth", "\\deg", "\\dim", "\\exp", "\\hom", "\\ker", "\\lg", "\\ln", "\\log", "\\sec", "\\sin", "\\sinh", "\\sh", "\\tan", "\\tanh", "\\tg", "\\th"],
  props: {
    numArgs: 0
  },
  handler(_ref3) {
    var {
      parser,
      funcName
    } = _ref3;
    return {
      type: "op",
      mode: parser.mode,
      limits: false,
      parentIsSupSub: false,
      symbol: false,
      name: funcName
    };
  },
  htmlBuilder: htmlBuilder$2,
  mathmlBuilder: mathmlBuilder$1
});
defineFunction({
  type: "op",
  names: ["\\det", "\\gcd", "\\inf", "\\lim", "\\max", "\\min", "\\Pr", "\\sup"],
  props: {
    numArgs: 0
  },
  handler(_ref4) {
    var {
      parser,
      funcName
    } = _ref4;
    return {
      type: "op",
      mode: parser.mode,
      limits: true,
      parentIsSupSub: false,
      symbol: false,
      name: funcName
    };
  },
  htmlBuilder: htmlBuilder$2,
  mathmlBuilder: mathmlBuilder$1
});
defineFunction({
  type: "op",
  names: ["\\int", "\\iint", "\\iiint", "\\oint", "\\oiint", "\\oiiint", "\u222B", "\u222C", "\u222D", "\u222E", "\u222F", "\u2230"],
  props: {
    numArgs: 0
  },
  handler(_ref5) {
    var {
      parser,
      funcName
    } = _ref5;
    var fName = funcName;
    if (fName.length === 1) {
      fName = singleCharIntegrals[fName];
    }
    return {
      type: "op",
      mode: parser.mode,
      limits: false,
      parentIsSupSub: false,
      symbol: true,
      name: fName
    };
  },
  htmlBuilder: htmlBuilder$2,
  mathmlBuilder: mathmlBuilder$1
});
var htmlBuilder$1 = (grp, options) => {
  var supGroup;
  var subGroup;
  var hasLimits = false;
  var group;
  if (grp.type === "supsub") {
    supGroup = grp.sup;
    subGroup = grp.sub;
    group = assertNodeType(grp.base, "operatorname");
    hasLimits = true;
  } else {
    group = assertNodeType(grp, "operatorname");
  }
  var base;
  if (group.body.length > 0) {
    var body = group.body.map((child2) => {
      var childText = child2.text;
      if (typeof childText === "string") {
        return {
          type: "textord",
          mode: child2.mode,
          text: childText
        };
      } else {
        return child2;
      }
    });
    var expression = buildExpression$1(body, options.withFont("mathrm"), true);
    for (var i2 = 0; i2 < expression.length; i2++) {
      var child = expression[i2];
      if (child instanceof SymbolNode) {
        child.text = child.text.replace(/\u2212/, "-").replace(/\u2217/, "*");
      }
    }
    base = buildCommon.makeSpan(["mop"], expression, options);
  } else {
    base = buildCommon.makeSpan(["mop"], [], options);
  }
  if (hasLimits) {
    return assembleSupSub(base, supGroup, subGroup, options, options.style, 0, 0);
  } else {
    return base;
  }
};
var mathmlBuilder2 = (group, options) => {
  var expression = buildExpression2(group.body, options.withFont("mathrm"));
  var isAllString = true;
  for (var i2 = 0; i2 < expression.length; i2++) {
    var node = expression[i2];
    if (node instanceof mathMLTree.SpaceNode) ;
    else if (node instanceof mathMLTree.MathNode) {
      switch (node.type) {
        case "mi":
        case "mn":
        case "ms":
        case "mspace":
        case "mtext":
          break;
        // Do nothing yet.
        case "mo": {
          var child = node.children[0];
          if (node.children.length === 1 && child instanceof mathMLTree.TextNode) {
            child.text = child.text.replace(/\u2212/, "-").replace(/\u2217/, "*");
          } else {
            isAllString = false;
          }
          break;
        }
        default:
          isAllString = false;
      }
    } else {
      isAllString = false;
    }
  }
  if (isAllString) {
    var word = expression.map((node2) => node2.toText()).join("");
    expression = [new mathMLTree.TextNode(word)];
  }
  var identifier = new mathMLTree.MathNode("mi", expression);
  identifier.setAttribute("mathvariant", "normal");
  var operator = new mathMLTree.MathNode("mo", [makeText("\u2061", "text")]);
  if (group.parentIsSupSub) {
    return new mathMLTree.MathNode("mrow", [identifier, operator]);
  } else {
    return mathMLTree.newDocumentFragment([identifier, operator]);
  }
};
defineFunction({
  type: "operatorname",
  names: ["\\operatorname@", "\\operatornamewithlimits"],
  props: {
    numArgs: 1
  },
  handler: (_ref, args) => {
    var {
      parser,
      funcName
    } = _ref;
    var body = args[0];
    return {
      type: "operatorname",
      mode: parser.mode,
      body: ordargument(body),
      alwaysHandleSupSub: funcName === "\\operatornamewithlimits",
      limits: false,
      parentIsSupSub: false
    };
  },
  htmlBuilder: htmlBuilder$1,
  mathmlBuilder: mathmlBuilder2
});
defineMacro("\\operatorname", "\\@ifstar\\operatornamewithlimits\\operatorname@");
defineFunctionBuilders({
  type: "ordgroup",
  htmlBuilder(group, options) {
    if (group.semisimple) {
      return buildCommon.makeFragment(buildExpression$1(group.body, options, false));
    }
    return buildCommon.makeSpan(["mord"], buildExpression$1(group.body, options, true), options);
  },
  mathmlBuilder(group, options) {
    return buildExpressionRow(group.body, options, true);
  }
});
defineFunction({
  type: "overline",
  names: ["\\overline"],
  props: {
    numArgs: 1
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    var body = args[0];
    return {
      type: "overline",
      mode: parser.mode,
      body
    };
  },
  htmlBuilder(group, options) {
    var innerGroup = buildGroup$1(group.body, options.havingCrampedStyle());
    var line = buildCommon.makeLineSpan("overline-line", options);
    var defaultRuleThickness = options.fontMetrics().defaultRuleThickness;
    var vlist = buildCommon.makeVList({
      positionType: "firstBaseline",
      children: [{
        type: "elem",
        elem: innerGroup
      }, {
        type: "kern",
        size: 3 * defaultRuleThickness
      }, {
        type: "elem",
        elem: line
      }, {
        type: "kern",
        size: defaultRuleThickness
      }]
    }, options);
    return buildCommon.makeSpan(["mord", "overline"], [vlist], options);
  },
  mathmlBuilder(group, options) {
    var operator = new mathMLTree.MathNode("mo", [new mathMLTree.TextNode("\u203E")]);
    operator.setAttribute("stretchy", "true");
    var node = new mathMLTree.MathNode("mover", [buildGroup2(group.body, options), operator]);
    node.setAttribute("accent", "true");
    return node;
  }
});
defineFunction({
  type: "phantom",
  names: ["\\phantom"],
  props: {
    numArgs: 1,
    allowedInText: true
  },
  handler: (_ref, args) => {
    var {
      parser
    } = _ref;
    var body = args[0];
    return {
      type: "phantom",
      mode: parser.mode,
      body: ordargument(body)
    };
  },
  htmlBuilder: (group, options) => {
    var elements = buildExpression$1(group.body, options.withPhantom(), false);
    return buildCommon.makeFragment(elements);
  },
  mathmlBuilder: (group, options) => {
    var inner2 = buildExpression2(group.body, options);
    return new mathMLTree.MathNode("mphantom", inner2);
  }
});
defineFunction({
  type: "hphantom",
  names: ["\\hphantom"],
  props: {
    numArgs: 1,
    allowedInText: true
  },
  handler: (_ref2, args) => {
    var {
      parser
    } = _ref2;
    var body = args[0];
    return {
      type: "hphantom",
      mode: parser.mode,
      body
    };
  },
  htmlBuilder: (group, options) => {
    var node = buildCommon.makeSpan([], [buildGroup$1(group.body, options.withPhantom())]);
    node.height = 0;
    node.depth = 0;
    if (node.children) {
      for (var i2 = 0; i2 < node.children.length; i2++) {
        node.children[i2].height = 0;
        node.children[i2].depth = 0;
      }
    }
    node = buildCommon.makeVList({
      positionType: "firstBaseline",
      children: [{
        type: "elem",
        elem: node
      }]
    }, options);
    return buildCommon.makeSpan(["mord"], [node], options);
  },
  mathmlBuilder: (group, options) => {
    var inner2 = buildExpression2(ordargument(group.body), options);
    var phantom = new mathMLTree.MathNode("mphantom", inner2);
    var node = new mathMLTree.MathNode("mpadded", [phantom]);
    node.setAttribute("height", "0px");
    node.setAttribute("depth", "0px");
    return node;
  }
});
defineFunction({
  type: "vphantom",
  names: ["\\vphantom"],
  props: {
    numArgs: 1,
    allowedInText: true
  },
  handler: (_ref3, args) => {
    var {
      parser
    } = _ref3;
    var body = args[0];
    return {
      type: "vphantom",
      mode: parser.mode,
      body
    };
  },
  htmlBuilder: (group, options) => {
    var inner2 = buildCommon.makeSpan(["inner"], [buildGroup$1(group.body, options.withPhantom())]);
    var fix = buildCommon.makeSpan(["fix"], []);
    return buildCommon.makeSpan(["mord", "rlap"], [inner2, fix], options);
  },
  mathmlBuilder: (group, options) => {
    var inner2 = buildExpression2(ordargument(group.body), options);
    var phantom = new mathMLTree.MathNode("mphantom", inner2);
    var node = new mathMLTree.MathNode("mpadded", [phantom]);
    node.setAttribute("width", "0px");
    return node;
  }
});
defineFunction({
  type: "raisebox",
  names: ["\\raisebox"],
  props: {
    numArgs: 2,
    argTypes: ["size", "hbox"],
    allowedInText: true
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    var amount = assertNodeType(args[0], "size").value;
    var body = args[1];
    return {
      type: "raisebox",
      mode: parser.mode,
      dy: amount,
      body
    };
  },
  htmlBuilder(group, options) {
    var body = buildGroup$1(group.body, options);
    var dy = calculateSize(group.dy, options);
    return buildCommon.makeVList({
      positionType: "shift",
      positionData: -dy,
      children: [{
        type: "elem",
        elem: body
      }]
    }, options);
  },
  mathmlBuilder(group, options) {
    var node = new mathMLTree.MathNode("mpadded", [buildGroup2(group.body, options)]);
    var dy = group.dy.number + group.dy.unit;
    node.setAttribute("voffset", dy);
    return node;
  }
});
defineFunction({
  type: "internal",
  names: ["\\relax"],
  props: {
    numArgs: 0,
    allowedInText: true,
    allowedInArgument: true
  },
  handler(_ref) {
    var {
      parser
    } = _ref;
    return {
      type: "internal",
      mode: parser.mode
    };
  }
});
defineFunction({
  type: "rule",
  names: ["\\rule"],
  props: {
    numArgs: 2,
    numOptionalArgs: 1,
    allowedInText: true,
    allowedInMath: true,
    argTypes: ["size", "size", "size"]
  },
  handler(_ref, args, optArgs) {
    var {
      parser
    } = _ref;
    var shift = optArgs[0];
    var width = assertNodeType(args[0], "size");
    var height = assertNodeType(args[1], "size");
    return {
      type: "rule",
      mode: parser.mode,
      shift: shift && assertNodeType(shift, "size").value,
      width: width.value,
      height: height.value
    };
  },
  htmlBuilder(group, options) {
    var rule = buildCommon.makeSpan(["mord", "rule"], [], options);
    var width = calculateSize(group.width, options);
    var height = calculateSize(group.height, options);
    var shift = group.shift ? calculateSize(group.shift, options) : 0;
    rule.style.borderRightWidth = makeEm(width);
    rule.style.borderTopWidth = makeEm(height);
    rule.style.bottom = makeEm(shift);
    rule.width = width;
    rule.height = height + shift;
    rule.depth = -shift;
    rule.maxFontSize = height * 1.125 * options.sizeMultiplier;
    return rule;
  },
  mathmlBuilder(group, options) {
    var width = calculateSize(group.width, options);
    var height = calculateSize(group.height, options);
    var shift = group.shift ? calculateSize(group.shift, options) : 0;
    var color = options.color && options.getColor() || "black";
    var rule = new mathMLTree.MathNode("mspace");
    rule.setAttribute("mathbackground", color);
    rule.setAttribute("width", makeEm(width));
    rule.setAttribute("height", makeEm(height));
    var wrapper = new mathMLTree.MathNode("mpadded", [rule]);
    if (shift >= 0) {
      wrapper.setAttribute("height", makeEm(shift));
    } else {
      wrapper.setAttribute("height", makeEm(shift));
      wrapper.setAttribute("depth", makeEm(-shift));
    }
    wrapper.setAttribute("voffset", makeEm(shift));
    return wrapper;
  }
});
function sizingGroup(value, options, baseOptions) {
  var inner2 = buildExpression$1(value, options, false);
  var multiplier = options.sizeMultiplier / baseOptions.sizeMultiplier;
  for (var i2 = 0; i2 < inner2.length; i2++) {
    var pos = inner2[i2].classes.indexOf("sizing");
    if (pos < 0) {
      Array.prototype.push.apply(inner2[i2].classes, options.sizingClasses(baseOptions));
    } else if (inner2[i2].classes[pos + 1] === "reset-size" + options.size) {
      inner2[i2].classes[pos + 1] = "reset-size" + baseOptions.size;
    }
    inner2[i2].height *= multiplier;
    inner2[i2].depth *= multiplier;
  }
  return buildCommon.makeFragment(inner2);
}
var sizeFuncs = ["\\tiny", "\\sixptsize", "\\scriptsize", "\\footnotesize", "\\small", "\\normalsize", "\\large", "\\Large", "\\LARGE", "\\huge", "\\Huge"];
var htmlBuilder2 = (group, options) => {
  var newOptions = options.havingSize(group.size);
  return sizingGroup(group.body, newOptions, options);
};
defineFunction({
  type: "sizing",
  names: sizeFuncs,
  props: {
    numArgs: 0,
    allowedInText: true
  },
  handler: (_ref, args) => {
    var {
      breakOnTokenText,
      funcName,
      parser
    } = _ref;
    var body = parser.parseExpression(false, breakOnTokenText);
    return {
      type: "sizing",
      mode: parser.mode,
      // Figure out what size to use based on the list of functions above
      size: sizeFuncs.indexOf(funcName) + 1,
      body
    };
  },
  htmlBuilder: htmlBuilder2,
  mathmlBuilder: (group, options) => {
    var newOptions = options.havingSize(group.size);
    var inner2 = buildExpression2(group.body, newOptions);
    var node = new mathMLTree.MathNode("mstyle", inner2);
    node.setAttribute("mathsize", makeEm(newOptions.sizeMultiplier));
    return node;
  }
});
defineFunction({
  type: "smash",
  names: ["\\smash"],
  props: {
    numArgs: 1,
    numOptionalArgs: 1,
    allowedInText: true
  },
  handler: (_ref, args, optArgs) => {
    var {
      parser
    } = _ref;
    var smashHeight = false;
    var smashDepth = false;
    var tbArg = optArgs[0] && assertNodeType(optArgs[0], "ordgroup");
    if (tbArg) {
      var letter = "";
      for (var i2 = 0; i2 < tbArg.body.length; ++i2) {
        var node = tbArg.body[i2];
        letter = node.text;
        if (letter === "t") {
          smashHeight = true;
        } else if (letter === "b") {
          smashDepth = true;
        } else {
          smashHeight = false;
          smashDepth = false;
          break;
        }
      }
    } else {
      smashHeight = true;
      smashDepth = true;
    }
    var body = args[0];
    return {
      type: "smash",
      mode: parser.mode,
      body,
      smashHeight,
      smashDepth
    };
  },
  htmlBuilder: (group, options) => {
    var node = buildCommon.makeSpan([], [buildGroup$1(group.body, options)]);
    if (!group.smashHeight && !group.smashDepth) {
      return node;
    }
    if (group.smashHeight) {
      node.height = 0;
      if (node.children) {
        for (var i2 = 0; i2 < node.children.length; i2++) {
          node.children[i2].height = 0;
        }
      }
    }
    if (group.smashDepth) {
      node.depth = 0;
      if (node.children) {
        for (var _i6 = 0; _i6 < node.children.length; _i6++) {
          node.children[_i6].depth = 0;
        }
      }
    }
    var smashedNode = buildCommon.makeVList({
      positionType: "firstBaseline",
      children: [{
        type: "elem",
        elem: node
      }]
    }, options);
    return buildCommon.makeSpan(["mord"], [smashedNode], options);
  },
  mathmlBuilder: (group, options) => {
    var node = new mathMLTree.MathNode("mpadded", [buildGroup2(group.body, options)]);
    if (group.smashHeight) {
      node.setAttribute("height", "0px");
    }
    if (group.smashDepth) {
      node.setAttribute("depth", "0px");
    }
    return node;
  }
});
defineFunction({
  type: "sqrt",
  names: ["\\sqrt"],
  props: {
    numArgs: 1,
    numOptionalArgs: 1
  },
  handler(_ref, args, optArgs) {
    var {
      parser
    } = _ref;
    var index = optArgs[0];
    var body = args[0];
    return {
      type: "sqrt",
      mode: parser.mode,
      body,
      index
    };
  },
  htmlBuilder(group, options) {
    var inner2 = buildGroup$1(group.body, options.havingCrampedStyle());
    if (inner2.height === 0) {
      inner2.height = options.fontMetrics().xHeight;
    }
    inner2 = buildCommon.wrapFragment(inner2, options);
    var metrics = options.fontMetrics();
    var theta = metrics.defaultRuleThickness;
    var phi = theta;
    if (options.style.id < Style$1.TEXT.id) {
      phi = options.fontMetrics().xHeight;
    }
    var lineClearance = theta + phi / 4;
    var minDelimiterHeight = inner2.height + inner2.depth + lineClearance + theta;
    var {
      span: img,
      ruleWidth,
      advanceWidth
    } = delimiter.sqrtImage(minDelimiterHeight, options);
    var delimDepth = img.height - ruleWidth;
    if (delimDepth > inner2.height + inner2.depth + lineClearance) {
      lineClearance = (lineClearance + delimDepth - inner2.height - inner2.depth) / 2;
    }
    var imgShift = img.height - inner2.height - lineClearance - ruleWidth;
    inner2.style.paddingLeft = makeEm(advanceWidth);
    var body = buildCommon.makeVList({
      positionType: "firstBaseline",
      children: [{
        type: "elem",
        elem: inner2,
        wrapperClasses: ["svg-align"]
      }, {
        type: "kern",
        size: -(inner2.height + imgShift)
      }, {
        type: "elem",
        elem: img
      }, {
        type: "kern",
        size: ruleWidth
      }]
    }, options);
    if (!group.index) {
      return buildCommon.makeSpan(["mord", "sqrt"], [body], options);
    } else {
      var newOptions = options.havingStyle(Style$1.SCRIPTSCRIPT);
      var rootm = buildGroup$1(group.index, newOptions, options);
      var toShift = 0.6 * (body.height - body.depth);
      var rootVList = buildCommon.makeVList({
        positionType: "shift",
        positionData: -toShift,
        children: [{
          type: "elem",
          elem: rootm
        }]
      }, options);
      var rootVListWrap = buildCommon.makeSpan(["root"], [rootVList]);
      return buildCommon.makeSpan(["mord", "sqrt"], [rootVListWrap, body], options);
    }
  },
  mathmlBuilder(group, options) {
    var {
      body,
      index
    } = group;
    return index ? new mathMLTree.MathNode("mroot", [buildGroup2(body, options), buildGroup2(index, options)]) : new mathMLTree.MathNode("msqrt", [buildGroup2(body, options)]);
  }
});
var styleMap = {
  "display": Style$1.DISPLAY,
  "text": Style$1.TEXT,
  "script": Style$1.SCRIPT,
  "scriptscript": Style$1.SCRIPTSCRIPT
};
defineFunction({
  type: "styling",
  names: ["\\displaystyle", "\\textstyle", "\\scriptstyle", "\\scriptscriptstyle"],
  props: {
    numArgs: 0,
    allowedInText: true,
    primitive: true
  },
  handler(_ref, args) {
    var {
      breakOnTokenText,
      funcName,
      parser
    } = _ref;
    var body = parser.parseExpression(true, breakOnTokenText);
    var style = funcName.slice(1, funcName.length - 5);
    return {
      type: "styling",
      mode: parser.mode,
      // Figure out what style to use by pulling out the style from
      // the function name
      style,
      body
    };
  },
  htmlBuilder(group, options) {
    var newStyle = styleMap[group.style];
    var newOptions = options.havingStyle(newStyle).withFont("");
    return sizingGroup(group.body, newOptions, options);
  },
  mathmlBuilder(group, options) {
    var newStyle = styleMap[group.style];
    var newOptions = options.havingStyle(newStyle);
    var inner2 = buildExpression2(group.body, newOptions);
    var node = new mathMLTree.MathNode("mstyle", inner2);
    var styleAttributes = {
      "display": ["0", "true"],
      "text": ["0", "false"],
      "script": ["1", "false"],
      "scriptscript": ["2", "false"]
    };
    var attr = styleAttributes[group.style];
    node.setAttribute("scriptlevel", attr[0]);
    node.setAttribute("displaystyle", attr[1]);
    return node;
  }
});
var htmlBuilderDelegate = function htmlBuilderDelegate2(group, options) {
  var base = group.base;
  if (!base) {
    return null;
  } else if (base.type === "op") {
    var delegate = base.limits && (options.style.size === Style$1.DISPLAY.size || base.alwaysHandleSupSub);
    return delegate ? htmlBuilder$2 : null;
  } else if (base.type === "operatorname") {
    var _delegate = base.alwaysHandleSupSub && (options.style.size === Style$1.DISPLAY.size || base.limits);
    return _delegate ? htmlBuilder$1 : null;
  } else if (base.type === "accent") {
    return utils.isCharacterBox(base.base) ? htmlBuilder$a : null;
  } else if (base.type === "horizBrace") {
    var isSup = !group.sub;
    return isSup === base.isOver ? htmlBuilder$3 : null;
  } else {
    return null;
  }
};
defineFunctionBuilders({
  type: "supsub",
  htmlBuilder(group, options) {
    var builderDelegate = htmlBuilderDelegate(group, options);
    if (builderDelegate) {
      return builderDelegate(group, options);
    }
    var {
      base: valueBase,
      sup: valueSup,
      sub: valueSub
    } = group;
    var base = buildGroup$1(valueBase, options);
    var supm;
    var subm;
    var metrics = options.fontMetrics();
    var supShift = 0;
    var subShift = 0;
    var isCharacterBox3 = valueBase && utils.isCharacterBox(valueBase);
    if (valueSup) {
      var newOptions = options.havingStyle(options.style.sup());
      supm = buildGroup$1(valueSup, newOptions, options);
      if (!isCharacterBox3) {
        supShift = base.height - newOptions.fontMetrics().supDrop * newOptions.sizeMultiplier / options.sizeMultiplier;
      }
    }
    if (valueSub) {
      var _newOptions = options.havingStyle(options.style.sub());
      subm = buildGroup$1(valueSub, _newOptions, options);
      if (!isCharacterBox3) {
        subShift = base.depth + _newOptions.fontMetrics().subDrop * _newOptions.sizeMultiplier / options.sizeMultiplier;
      }
    }
    var minSupShift;
    if (options.style === Style$1.DISPLAY) {
      minSupShift = metrics.sup1;
    } else if (options.style.cramped) {
      minSupShift = metrics.sup3;
    } else {
      minSupShift = metrics.sup2;
    }
    var multiplier = options.sizeMultiplier;
    var marginRight = makeEm(0.5 / metrics.ptPerEm / multiplier);
    var marginLeft = null;
    if (subm) {
      var isOiint = group.base && group.base.type === "op" && group.base.name && (group.base.name === "\\oiint" || group.base.name === "\\oiiint");
      if (base instanceof SymbolNode || isOiint) {
        marginLeft = makeEm(-base.italic);
      }
    }
    var supsub;
    if (supm && subm) {
      supShift = Math.max(supShift, minSupShift, supm.depth + 0.25 * metrics.xHeight);
      subShift = Math.max(subShift, metrics.sub2);
      var ruleWidth = metrics.defaultRuleThickness;
      var maxWidth = 4 * ruleWidth;
      if (supShift - supm.depth - (subm.height - subShift) < maxWidth) {
        subShift = maxWidth - (supShift - supm.depth) + subm.height;
        var psi = 0.8 * metrics.xHeight - (supShift - supm.depth);
        if (psi > 0) {
          supShift += psi;
          subShift -= psi;
        }
      }
      var vlistElem = [{
        type: "elem",
        elem: subm,
        shift: subShift,
        marginRight,
        marginLeft
      }, {
        type: "elem",
        elem: supm,
        shift: -supShift,
        marginRight
      }];
      supsub = buildCommon.makeVList({
        positionType: "individualShift",
        children: vlistElem
      }, options);
    } else if (subm) {
      subShift = Math.max(subShift, metrics.sub1, subm.height - 0.8 * metrics.xHeight);
      var _vlistElem = [{
        type: "elem",
        elem: subm,
        marginLeft,
        marginRight
      }];
      supsub = buildCommon.makeVList({
        positionType: "shift",
        positionData: subShift,
        children: _vlistElem
      }, options);
    } else if (supm) {
      supShift = Math.max(supShift, minSupShift, supm.depth + 0.25 * metrics.xHeight);
      supsub = buildCommon.makeVList({
        positionType: "shift",
        positionData: -supShift,
        children: [{
          type: "elem",
          elem: supm,
          marginRight
        }]
      }, options);
    } else {
      throw new Error("supsub must have either sup or sub.");
    }
    var mclass = getTypeOfDomTree(base, "right") || "mord";
    return buildCommon.makeSpan([mclass], [base, buildCommon.makeSpan(["msupsub"], [supsub])], options);
  },
  mathmlBuilder(group, options) {
    var isBrace = false;
    var isOver;
    var isSup;
    if (group.base && group.base.type === "horizBrace") {
      isSup = !!group.sup;
      if (isSup === group.base.isOver) {
        isBrace = true;
        isOver = group.base.isOver;
      }
    }
    if (group.base && (group.base.type === "op" || group.base.type === "operatorname")) {
      group.base.parentIsSupSub = true;
    }
    var children = [buildGroup2(group.base, options)];
    if (group.sub) {
      children.push(buildGroup2(group.sub, options));
    }
    if (group.sup) {
      children.push(buildGroup2(group.sup, options));
    }
    var nodeType;
    if (isBrace) {
      nodeType = isOver ? "mover" : "munder";
    } else if (!group.sub) {
      var base = group.base;
      if (base && base.type === "op" && base.limits && (options.style === Style$1.DISPLAY || base.alwaysHandleSupSub)) {
        nodeType = "mover";
      } else if (base && base.type === "operatorname" && base.alwaysHandleSupSub && (base.limits || options.style === Style$1.DISPLAY)) {
        nodeType = "mover";
      } else {
        nodeType = "msup";
      }
    } else if (!group.sup) {
      var _base = group.base;
      if (_base && _base.type === "op" && _base.limits && (options.style === Style$1.DISPLAY || _base.alwaysHandleSupSub)) {
        nodeType = "munder";
      } else if (_base && _base.type === "operatorname" && _base.alwaysHandleSupSub && (_base.limits || options.style === Style$1.DISPLAY)) {
        nodeType = "munder";
      } else {
        nodeType = "msub";
      }
    } else {
      var _base2 = group.base;
      if (_base2 && _base2.type === "op" && _base2.limits && options.style === Style$1.DISPLAY) {
        nodeType = "munderover";
      } else if (_base2 && _base2.type === "operatorname" && _base2.alwaysHandleSupSub && (options.style === Style$1.DISPLAY || _base2.limits)) {
        nodeType = "munderover";
      } else {
        nodeType = "msubsup";
      }
    }
    return new mathMLTree.MathNode(nodeType, children);
  }
});
defineFunctionBuilders({
  type: "atom",
  htmlBuilder(group, options) {
    return buildCommon.mathsym(group.text, group.mode, options, ["m" + group.family]);
  },
  mathmlBuilder(group, options) {
    var node = new mathMLTree.MathNode("mo", [makeText(group.text, group.mode)]);
    if (group.family === "bin") {
      var variant = getVariant(group, options);
      if (variant === "bold-italic") {
        node.setAttribute("mathvariant", variant);
      }
    } else if (group.family === "punct") {
      node.setAttribute("separator", "true");
    } else if (group.family === "open" || group.family === "close") {
      node.setAttribute("stretchy", "false");
    }
    return node;
  }
});
var defaultVariant = {
  "mi": "italic",
  "mn": "normal",
  "mtext": "normal"
};
defineFunctionBuilders({
  type: "mathord",
  htmlBuilder(group, options) {
    return buildCommon.makeOrd(group, options, "mathord");
  },
  mathmlBuilder(group, options) {
    var node = new mathMLTree.MathNode("mi", [makeText(group.text, group.mode, options)]);
    var variant = getVariant(group, options) || "italic";
    if (variant !== defaultVariant[node.type]) {
      node.setAttribute("mathvariant", variant);
    }
    return node;
  }
});
defineFunctionBuilders({
  type: "textord",
  htmlBuilder(group, options) {
    return buildCommon.makeOrd(group, options, "textord");
  },
  mathmlBuilder(group, options) {
    var text2 = makeText(group.text, group.mode, options);
    var variant = getVariant(group, options) || "normal";
    var node;
    if (group.mode === "text") {
      node = new mathMLTree.MathNode("mtext", [text2]);
    } else if (/[0-9]/.test(group.text)) {
      node = new mathMLTree.MathNode("mn", [text2]);
    } else if (group.text === "\\prime") {
      node = new mathMLTree.MathNode("mo", [text2]);
    } else {
      node = new mathMLTree.MathNode("mi", [text2]);
    }
    if (variant !== defaultVariant[node.type]) {
      node.setAttribute("mathvariant", variant);
    }
    return node;
  }
});
var cssSpace = {
  "\\nobreak": "nobreak",
  "\\allowbreak": "allowbreak"
};
var regularSpace = {
  " ": {},
  "\\ ": {},
  "~": {
    className: "nobreak"
  },
  "\\space": {},
  "\\nobreakspace": {
    className: "nobreak"
  }
};
defineFunctionBuilders({
  type: "spacing",
  htmlBuilder(group, options) {
    if (regularSpace.hasOwnProperty(group.text)) {
      var className = regularSpace[group.text].className || "";
      if (group.mode === "text") {
        var ord = buildCommon.makeOrd(group, options, "textord");
        ord.classes.push(className);
        return ord;
      } else {
        return buildCommon.makeSpan(["mspace", className], [buildCommon.mathsym(group.text, group.mode, options)], options);
      }
    } else if (cssSpace.hasOwnProperty(group.text)) {
      return buildCommon.makeSpan(["mspace", cssSpace[group.text]], [], options);
    } else {
      throw new ParseError('Unknown type of space "' + group.text + '"');
    }
  },
  mathmlBuilder(group, options) {
    var node;
    if (regularSpace.hasOwnProperty(group.text)) {
      node = new mathMLTree.MathNode("mtext", [new mathMLTree.TextNode("\xA0")]);
    } else if (cssSpace.hasOwnProperty(group.text)) {
      return new mathMLTree.MathNode("mspace");
    } else {
      throw new ParseError('Unknown type of space "' + group.text + '"');
    }
    return node;
  }
});
var pad = () => {
  var padNode = new mathMLTree.MathNode("mtd", []);
  padNode.setAttribute("width", "50%");
  return padNode;
};
defineFunctionBuilders({
  type: "tag",
  mathmlBuilder(group, options) {
    var table = new mathMLTree.MathNode("mtable", [new mathMLTree.MathNode("mtr", [pad(), new mathMLTree.MathNode("mtd", [buildExpressionRow(group.body, options)]), pad(), new mathMLTree.MathNode("mtd", [buildExpressionRow(group.tag, options)])])]);
    table.setAttribute("width", "100%");
    return table;
  }
});
var textFontFamilies = {
  "\\text": void 0,
  "\\textrm": "textrm",
  "\\textsf": "textsf",
  "\\texttt": "texttt",
  "\\textnormal": "textrm"
};
var textFontWeights = {
  "\\textbf": "textbf",
  "\\textmd": "textmd"
};
var textFontShapes = {
  "\\textit": "textit",
  "\\textup": "textup"
};
var optionsWithFont = (group, options) => {
  var font = group.font;
  if (!font) {
    return options;
  } else if (textFontFamilies[font]) {
    return options.withTextFontFamily(textFontFamilies[font]);
  } else if (textFontWeights[font]) {
    return options.withTextFontWeight(textFontWeights[font]);
  } else if (font === "\\emph") {
    return options.fontShape === "textit" ? options.withTextFontShape("textup") : options.withTextFontShape("textit");
  }
  return options.withTextFontShape(textFontShapes[font]);
};
defineFunction({
  type: "text",
  names: [
    // Font families
    "\\text",
    "\\textrm",
    "\\textsf",
    "\\texttt",
    "\\textnormal",
    // Font weights
    "\\textbf",
    "\\textmd",
    // Font Shapes
    "\\textit",
    "\\textup",
    "\\emph"
  ],
  props: {
    numArgs: 1,
    argTypes: ["text"],
    allowedInArgument: true,
    allowedInText: true
  },
  handler(_ref, args) {
    var {
      parser,
      funcName
    } = _ref;
    var body = args[0];
    return {
      type: "text",
      mode: parser.mode,
      body: ordargument(body),
      font: funcName
    };
  },
  htmlBuilder(group, options) {
    var newOptions = optionsWithFont(group, options);
    var inner2 = buildExpression$1(group.body, newOptions, true);
    return buildCommon.makeSpan(["mord", "text"], inner2, newOptions);
  },
  mathmlBuilder(group, options) {
    var newOptions = optionsWithFont(group, options);
    return buildExpressionRow(group.body, newOptions);
  }
});
defineFunction({
  type: "underline",
  names: ["\\underline"],
  props: {
    numArgs: 1,
    allowedInText: true
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    return {
      type: "underline",
      mode: parser.mode,
      body: args[0]
    };
  },
  htmlBuilder(group, options) {
    var innerGroup = buildGroup$1(group.body, options);
    var line = buildCommon.makeLineSpan("underline-line", options);
    var defaultRuleThickness = options.fontMetrics().defaultRuleThickness;
    var vlist = buildCommon.makeVList({
      positionType: "top",
      positionData: innerGroup.height,
      children: [{
        type: "kern",
        size: defaultRuleThickness
      }, {
        type: "elem",
        elem: line
      }, {
        type: "kern",
        size: 3 * defaultRuleThickness
      }, {
        type: "elem",
        elem: innerGroup
      }]
    }, options);
    return buildCommon.makeSpan(["mord", "underline"], [vlist], options);
  },
  mathmlBuilder(group, options) {
    var operator = new mathMLTree.MathNode("mo", [new mathMLTree.TextNode("\u203E")]);
    operator.setAttribute("stretchy", "true");
    var node = new mathMLTree.MathNode("munder", [buildGroup2(group.body, options), operator]);
    node.setAttribute("accentunder", "true");
    return node;
  }
});
defineFunction({
  type: "vcenter",
  names: ["\\vcenter"],
  props: {
    numArgs: 1,
    argTypes: ["original"],
    // In LaTeX, \vcenter can act only on a box.
    allowedInText: false
  },
  handler(_ref, args) {
    var {
      parser
    } = _ref;
    return {
      type: "vcenter",
      mode: parser.mode,
      body: args[0]
    };
  },
  htmlBuilder(group, options) {
    var body = buildGroup$1(group.body, options);
    var axisHeight = options.fontMetrics().axisHeight;
    var dy = 0.5 * (body.height - axisHeight - (body.depth + axisHeight));
    return buildCommon.makeVList({
      positionType: "shift",
      positionData: dy,
      children: [{
        type: "elem",
        elem: body
      }]
    }, options);
  },
  mathmlBuilder(group, options) {
    return new mathMLTree.MathNode("mpadded", [buildGroup2(group.body, options)], ["vcenter"]);
  }
});
defineFunction({
  type: "verb",
  names: ["\\verb"],
  props: {
    numArgs: 0,
    allowedInText: true
  },
  handler(context, args, optArgs) {
    throw new ParseError("\\verb ended by end of line instead of matching delimiter");
  },
  htmlBuilder(group, options) {
    var text2 = makeVerb(group);
    var body = [];
    var newOptions = options.havingStyle(options.style.text());
    for (var i2 = 0; i2 < text2.length; i2++) {
      var c = text2[i2];
      if (c === "~") {
        c = "\\textasciitilde";
      }
      body.push(buildCommon.makeSymbol(c, "Typewriter-Regular", group.mode, newOptions, ["mord", "texttt"]));
    }
    return buildCommon.makeSpan(["mord", "text"].concat(newOptions.sizingClasses(options)), buildCommon.tryCombineChars(body), newOptions);
  },
  mathmlBuilder(group, options) {
    var text2 = new mathMLTree.TextNode(makeVerb(group));
    var node = new mathMLTree.MathNode("mtext", [text2]);
    node.setAttribute("mathvariant", "monospace");
    return node;
  }
});
var makeVerb = (group) => group.body.replace(/ /g, group.star ? "\u2423" : "\xA0");
var functions = _functions;
var spaceRegexString = "[ \r\n	]";
var controlWordRegexString = "\\\\[a-zA-Z@]+";
var controlSymbolRegexString = "\\\\[^\uD800-\uDFFF]";
var controlWordWhitespaceRegexString = "(" + controlWordRegexString + ")" + spaceRegexString + "*";
var controlSpaceRegexString = "\\\\(\n|[ \r	]+\n?)[ \r	]*";
var combiningDiacriticalMarkString = "[\u0300-\u036F]";
var combiningDiacriticalMarksEndRegex = new RegExp(combiningDiacriticalMarkString + "+$");
var tokenRegexString = "(" + spaceRegexString + "+)|" + // whitespace
(controlSpaceRegexString + "|") + // \whitespace
"([!-\\[\\]-\u2027\u202A-\uD7FF\uF900-\uFFFF]" + // single codepoint
(combiningDiacriticalMarkString + "*") + // ...plus accents
"|[\uD800-\uDBFF][\uDC00-\uDFFF]" + // surrogate pair
(combiningDiacriticalMarkString + "*") + // ...plus accents
"|\\\\verb\\*([^]).*?\\4|\\\\verb([^*a-zA-Z]).*?\\5" + // \verb unstarred
("|" + controlWordWhitespaceRegexString) + // \macroName + spaces
("|" + controlSymbolRegexString + ")");
var Lexer = class {
  // Category codes. The lexer only supports comment characters (14) for now.
  // MacroExpander additionally distinguishes active (13).
  constructor(input, settings) {
    this.input = void 0;
    this.settings = void 0;
    this.tokenRegex = void 0;
    this.catcodes = void 0;
    this.input = input;
    this.settings = settings;
    this.tokenRegex = new RegExp(tokenRegexString, "g");
    this.catcodes = {
      "%": 14,
      // comment character
      "~": 13
      // active character
    };
  }
  setCatcode(char, code) {
    this.catcodes[char] = code;
  }
  /**
   * This function lexes a single token.
   */
  lex() {
    var input = this.input;
    var pos = this.tokenRegex.lastIndex;
    if (pos === input.length) {
      return new Token("EOF", new SourceLocation(this, pos, pos));
    }
    var match = this.tokenRegex.exec(input);
    if (match === null || match.index !== pos) {
      throw new ParseError("Unexpected character: '" + input[pos] + "'", new Token(input[pos], new SourceLocation(this, pos, pos + 1)));
    }
    var text2 = match[6] || match[3] || (match[2] ? "\\ " : " ");
    if (this.catcodes[text2] === 14) {
      var nlIndex = input.indexOf("\n", this.tokenRegex.lastIndex);
      if (nlIndex === -1) {
        this.tokenRegex.lastIndex = input.length;
        this.settings.reportNonstrict("commentAtEnd", "% comment has no terminating newline; LaTeX would fail because of commenting the end of math mode (e.g. $)");
      } else {
        this.tokenRegex.lastIndex = nlIndex + 1;
      }
      return this.lex();
    }
    return new Token(text2, new SourceLocation(this, pos, this.tokenRegex.lastIndex));
  }
};
var Namespace = class {
  /**
   * Both arguments are optional.  The first argument is an object of
   * built-in mappings which never change.  The second argument is an object
   * of initial (global-level) mappings, which will constantly change
   * according to any global/top-level `set`s done.
   */
  constructor(builtins, globalMacros) {
    if (builtins === void 0) {
      builtins = {};
    }
    if (globalMacros === void 0) {
      globalMacros = {};
    }
    this.current = void 0;
    this.builtins = void 0;
    this.undefStack = void 0;
    this.current = globalMacros;
    this.builtins = builtins;
    this.undefStack = [];
  }
  /**
   * Start a new nested group, affecting future local `set`s.
   */
  beginGroup() {
    this.undefStack.push({});
  }
  /**
   * End current nested group, restoring values before the group began.
   */
  endGroup() {
    if (this.undefStack.length === 0) {
      throw new ParseError("Unbalanced namespace destruction: attempt to pop global namespace; please report this as a bug");
    }
    var undefs = this.undefStack.pop();
    for (var undef in undefs) {
      if (undefs.hasOwnProperty(undef)) {
        if (undefs[undef] == null) {
          delete this.current[undef];
        } else {
          this.current[undef] = undefs[undef];
        }
      }
    }
  }
  /**
   * Ends all currently nested groups (if any), restoring values before the
   * groups began.  Useful in case of an error in the middle of parsing.
   */
  endGroups() {
    while (this.undefStack.length > 0) {
      this.endGroup();
    }
  }
  /**
   * Detect whether `name` has a definition.  Equivalent to
   * `get(name) != null`.
   */
  has(name) {
    return this.current.hasOwnProperty(name) || this.builtins.hasOwnProperty(name);
  }
  /**
   * Get the current value of a name, or `undefined` if there is no value.
   *
   * Note: Do not use `if (namespace.get(...))` to detect whether a macro
   * is defined, as the definition may be the empty string which evaluates
   * to `false` in JavaScript.  Use `if (namespace.get(...) != null)` or
   * `if (namespace.has(...))`.
   */
  get(name) {
    if (this.current.hasOwnProperty(name)) {
      return this.current[name];
    } else {
      return this.builtins[name];
    }
  }
  /**
   * Set the current value of a name, and optionally set it globally too.
   * Local set() sets the current value and (when appropriate) adds an undo
   * operation to the undo stack.  Global set() may change the undo
   * operation at every level, so takes time linear in their number.
   * A value of undefined means to delete existing definitions.
   */
  set(name, value, global) {
    if (global === void 0) {
      global = false;
    }
    if (global) {
      for (var i2 = 0; i2 < this.undefStack.length; i2++) {
        delete this.undefStack[i2][name];
      }
      if (this.undefStack.length > 0) {
        this.undefStack[this.undefStack.length - 1][name] = value;
      }
    } else {
      var top = this.undefStack[this.undefStack.length - 1];
      if (top && !top.hasOwnProperty(name)) {
        top[name] = this.current[name];
      }
    }
    if (value == null) {
      delete this.current[name];
    } else {
      this.current[name] = value;
    }
  }
};
var macros = _macros;
defineMacro("\\noexpand", function(context) {
  var t = context.popToken();
  if (context.isExpandable(t.text)) {
    t.noexpand = true;
    t.treatAsRelax = true;
  }
  return {
    tokens: [t],
    numArgs: 0
  };
});
defineMacro("\\expandafter", function(context) {
  var t = context.popToken();
  context.expandOnce(true);
  return {
    tokens: [t],
    numArgs: 0
  };
});
defineMacro("\\@firstoftwo", function(context) {
  var args = context.consumeArgs(2);
  return {
    tokens: args[0],
    numArgs: 0
  };
});
defineMacro("\\@secondoftwo", function(context) {
  var args = context.consumeArgs(2);
  return {
    tokens: args[1],
    numArgs: 0
  };
});
defineMacro("\\@ifnextchar", function(context) {
  var args = context.consumeArgs(3);
  context.consumeSpaces();
  var nextToken = context.future();
  if (args[0].length === 1 && args[0][0].text === nextToken.text) {
    return {
      tokens: args[1],
      numArgs: 0
    };
  } else {
    return {
      tokens: args[2],
      numArgs: 0
    };
  }
});
defineMacro("\\@ifstar", "\\@ifnextchar *{\\@firstoftwo{#1}}");
defineMacro("\\TextOrMath", function(context) {
  var args = context.consumeArgs(2);
  if (context.mode === "text") {
    return {
      tokens: args[0],
      numArgs: 0
    };
  } else {
    return {
      tokens: args[1],
      numArgs: 0
    };
  }
});
var digitToNumber = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "a": 10,
  "A": 10,
  "b": 11,
  "B": 11,
  "c": 12,
  "C": 12,
  "d": 13,
  "D": 13,
  "e": 14,
  "E": 14,
  "f": 15,
  "F": 15
};
defineMacro("\\char", function(context) {
  var token = context.popToken();
  var base;
  var number = "";
  if (token.text === "'") {
    base = 8;
    token = context.popToken();
  } else if (token.text === '"') {
    base = 16;
    token = context.popToken();
  } else if (token.text === "`") {
    token = context.popToken();
    if (token.text[0] === "\\") {
      number = token.text.charCodeAt(1);
    } else if (token.text === "EOF") {
      throw new ParseError("\\char` missing argument");
    } else {
      number = token.text.charCodeAt(0);
    }
  } else {
    base = 10;
  }
  if (base) {
    number = digitToNumber[token.text];
    if (number == null || number >= base) {
      throw new ParseError("Invalid base-" + base + " digit " + token.text);
    }
    var digit;
    while ((digit = digitToNumber[context.future().text]) != null && digit < base) {
      number *= base;
      number += digit;
      context.popToken();
    }
  }
  return "\\@char{" + number + "}";
});
var newcommand = (context, existsOK, nonexistsOK, skipIfExists) => {
  var arg = context.consumeArg().tokens;
  if (arg.length !== 1) {
    throw new ParseError("\\newcommand's first argument must be a macro name");
  }
  var name = arg[0].text;
  var exists = context.isDefined(name);
  if (exists && !existsOK) {
    throw new ParseError("\\newcommand{" + name + "} attempting to redefine " + (name + "; use \\renewcommand"));
  }
  if (!exists && !nonexistsOK) {
    throw new ParseError("\\renewcommand{" + name + "} when command " + name + " does not yet exist; use \\newcommand");
  }
  var numArgs = 0;
  arg = context.consumeArg().tokens;
  if (arg.length === 1 && arg[0].text === "[") {
    var argText = "";
    var token = context.expandNextToken();
    while (token.text !== "]" && token.text !== "EOF") {
      argText += token.text;
      token = context.expandNextToken();
    }
    if (!argText.match(/^\s*[0-9]+\s*$/)) {
      throw new ParseError("Invalid number of arguments: " + argText);
    }
    numArgs = parseInt(argText);
    arg = context.consumeArg().tokens;
  }
  if (!(exists && skipIfExists)) {
    context.macros.set(name, {
      tokens: arg,
      numArgs
    });
  }
  return "";
};
defineMacro("\\newcommand", (context) => newcommand(context, false, true, false));
defineMacro("\\renewcommand", (context) => newcommand(context, true, false, false));
defineMacro("\\providecommand", (context) => newcommand(context, true, true, true));
defineMacro("\\message", (context) => {
  var arg = context.consumeArgs(1)[0];
  console.log(arg.reverse().map((token) => token.text).join(""));
  return "";
});
defineMacro("\\errmessage", (context) => {
  var arg = context.consumeArgs(1)[0];
  console.error(arg.reverse().map((token) => token.text).join(""));
  return "";
});
defineMacro("\\show", (context) => {
  var tok = context.popToken();
  var name = tok.text;
  console.log(tok, context.macros.get(name), functions[name], symbols.math[name], symbols.text[name]);
  return "";
});
defineMacro("\\bgroup", "{");
defineMacro("\\egroup", "}");
defineMacro("~", "\\nobreakspace");
defineMacro("\\lq", "`");
defineMacro("\\rq", "'");
defineMacro("\\aa", "\\r a");
defineMacro("\\AA", "\\r A");
defineMacro("\\textcopyright", "\\html@mathml{\\textcircled{c}}{\\char`\xA9}");
defineMacro("\\copyright", "\\TextOrMath{\\textcopyright}{\\text{\\textcopyright}}");
defineMacro("\\textregistered", "\\html@mathml{\\textcircled{\\scriptsize R}}{\\char`\xAE}");
defineMacro("\u212C", "\\mathscr{B}");
defineMacro("\u2130", "\\mathscr{E}");
defineMacro("\u2131", "\\mathscr{F}");
defineMacro("\u210B", "\\mathscr{H}");
defineMacro("\u2110", "\\mathscr{I}");
defineMacro("\u2112", "\\mathscr{L}");
defineMacro("\u2133", "\\mathscr{M}");
defineMacro("\u211B", "\\mathscr{R}");
defineMacro("\u212D", "\\mathfrak{C}");
defineMacro("\u210C", "\\mathfrak{H}");
defineMacro("\u2128", "\\mathfrak{Z}");
defineMacro("\\Bbbk", "\\Bbb{k}");
defineMacro("\xB7", "\\cdotp");
defineMacro("\\llap", "\\mathllap{\\textrm{#1}}");
defineMacro("\\rlap", "\\mathrlap{\\textrm{#1}}");
defineMacro("\\clap", "\\mathclap{\\textrm{#1}}");
defineMacro("\\mathstrut", "\\vphantom{(}");
defineMacro("\\underbar", "\\underline{\\text{#1}}");
defineMacro("\\not", '\\html@mathml{\\mathrel{\\mathrlap\\@not}}{\\char"338}');
defineMacro("\\neq", "\\html@mathml{\\mathrel{\\not=}}{\\mathrel{\\char`\u2260}}");
defineMacro("\\ne", "\\neq");
defineMacro("\u2260", "\\neq");
defineMacro("\\notin", "\\html@mathml{\\mathrel{{\\in}\\mathllap{/\\mskip1mu}}}{\\mathrel{\\char`\u2209}}");
defineMacro("\u2209", "\\notin");
defineMacro("\u2258", "\\html@mathml{\\mathrel{=\\kern{-1em}\\raisebox{0.4em}{$\\scriptsize\\frown$}}}{\\mathrel{\\char`\u2258}}");
defineMacro("\u2259", "\\html@mathml{\\stackrel{\\tiny\\wedge}{=}}{\\mathrel{\\char`\u2258}}");
defineMacro("\u225A", "\\html@mathml{\\stackrel{\\tiny\\vee}{=}}{\\mathrel{\\char`\u225A}}");
defineMacro("\u225B", "\\html@mathml{\\stackrel{\\scriptsize\\star}{=}}{\\mathrel{\\char`\u225B}}");
defineMacro("\u225D", "\\html@mathml{\\stackrel{\\tiny\\mathrm{def}}{=}}{\\mathrel{\\char`\u225D}}");
defineMacro("\u225E", "\\html@mathml{\\stackrel{\\tiny\\mathrm{m}}{=}}{\\mathrel{\\char`\u225E}}");
defineMacro("\u225F", "\\html@mathml{\\stackrel{\\tiny?}{=}}{\\mathrel{\\char`\u225F}}");
defineMacro("\u27C2", "\\perp");
defineMacro("\u203C", "\\mathclose{!\\mkern-0.8mu!}");
defineMacro("\u220C", "\\notni");
defineMacro("\u231C", "\\ulcorner");
defineMacro("\u231D", "\\urcorner");
defineMacro("\u231E", "\\llcorner");
defineMacro("\u231F", "\\lrcorner");
defineMacro("\xA9", "\\copyright");
defineMacro("\xAE", "\\textregistered");
defineMacro("\uFE0F", "\\textregistered");
defineMacro("\\ulcorner", '\\html@mathml{\\@ulcorner}{\\mathop{\\char"231c}}');
defineMacro("\\urcorner", '\\html@mathml{\\@urcorner}{\\mathop{\\char"231d}}');
defineMacro("\\llcorner", '\\html@mathml{\\@llcorner}{\\mathop{\\char"231e}}');
defineMacro("\\lrcorner", '\\html@mathml{\\@lrcorner}{\\mathop{\\char"231f}}');
defineMacro("\\vdots", "{\\varvdots\\rule{0pt}{15pt}}");
defineMacro("\u22EE", "\\vdots");
defineMacro("\\varGamma", "\\mathit{\\Gamma}");
defineMacro("\\varDelta", "\\mathit{\\Delta}");
defineMacro("\\varTheta", "\\mathit{\\Theta}");
defineMacro("\\varLambda", "\\mathit{\\Lambda}");
defineMacro("\\varXi", "\\mathit{\\Xi}");
defineMacro("\\varPi", "\\mathit{\\Pi}");
defineMacro("\\varSigma", "\\mathit{\\Sigma}");
defineMacro("\\varUpsilon", "\\mathit{\\Upsilon}");
defineMacro("\\varPhi", "\\mathit{\\Phi}");
defineMacro("\\varPsi", "\\mathit{\\Psi}");
defineMacro("\\varOmega", "\\mathit{\\Omega}");
defineMacro("\\substack", "\\begin{subarray}{c}#1\\end{subarray}");
defineMacro("\\colon", "\\nobreak\\mskip2mu\\mathpunct{}\\mathchoice{\\mkern-3mu}{\\mkern-3mu}{}{}{:}\\mskip6mu\\relax");
defineMacro("\\boxed", "\\fbox{$\\displaystyle{#1}$}");
defineMacro("\\iff", "\\DOTSB\\;\\Longleftrightarrow\\;");
defineMacro("\\implies", "\\DOTSB\\;\\Longrightarrow\\;");
defineMacro("\\impliedby", "\\DOTSB\\;\\Longleftarrow\\;");
defineMacro("\\dddot", "{\\overset{\\raisebox{-0.1ex}{\\normalsize ...}}{#1}}");
defineMacro("\\ddddot", "{\\overset{\\raisebox{-0.1ex}{\\normalsize ....}}{#1}}");
var dotsByToken = {
  ",": "\\dotsc",
  "\\not": "\\dotsb",
  // \keybin@ checks for the following:
  "+": "\\dotsb",
  "=": "\\dotsb",
  "<": "\\dotsb",
  ">": "\\dotsb",
  "-": "\\dotsb",
  "*": "\\dotsb",
  ":": "\\dotsb",
  // Symbols whose definition starts with \DOTSB:
  "\\DOTSB": "\\dotsb",
  "\\coprod": "\\dotsb",
  "\\bigvee": "\\dotsb",
  "\\bigwedge": "\\dotsb",
  "\\biguplus": "\\dotsb",
  "\\bigcap": "\\dotsb",
  "\\bigcup": "\\dotsb",
  "\\prod": "\\dotsb",
  "\\sum": "\\dotsb",
  "\\bigotimes": "\\dotsb",
  "\\bigoplus": "\\dotsb",
  "\\bigodot": "\\dotsb",
  "\\bigsqcup": "\\dotsb",
  "\\And": "\\dotsb",
  "\\longrightarrow": "\\dotsb",
  "\\Longrightarrow": "\\dotsb",
  "\\longleftarrow": "\\dotsb",
  "\\Longleftarrow": "\\dotsb",
  "\\longleftrightarrow": "\\dotsb",
  "\\Longleftrightarrow": "\\dotsb",
  "\\mapsto": "\\dotsb",
  "\\longmapsto": "\\dotsb",
  "\\hookrightarrow": "\\dotsb",
  "\\doteq": "\\dotsb",
  // Symbols whose definition starts with \mathbin:
  "\\mathbin": "\\dotsb",
  // Symbols whose definition starts with \mathrel:
  "\\mathrel": "\\dotsb",
  "\\relbar": "\\dotsb",
  "\\Relbar": "\\dotsb",
  "\\xrightarrow": "\\dotsb",
  "\\xleftarrow": "\\dotsb",
  // Symbols whose definition starts with \DOTSI:
  "\\DOTSI": "\\dotsi",
  "\\int": "\\dotsi",
  "\\oint": "\\dotsi",
  "\\iint": "\\dotsi",
  "\\iiint": "\\dotsi",
  "\\iiiint": "\\dotsi",
  "\\idotsint": "\\dotsi",
  // Symbols whose definition starts with \DOTSX:
  "\\DOTSX": "\\dotsx"
};
defineMacro("\\dots", function(context) {
  var thedots = "\\dotso";
  var next = context.expandAfterFuture().text;
  if (next in dotsByToken) {
    thedots = dotsByToken[next];
  } else if (next.slice(0, 4) === "\\not") {
    thedots = "\\dotsb";
  } else if (next in symbols.math) {
    if (utils.contains(["bin", "rel"], symbols.math[next].group)) {
      thedots = "\\dotsb";
    }
  }
  return thedots;
});
var spaceAfterDots = {
  // \rightdelim@ checks for the following:
  ")": true,
  "]": true,
  "\\rbrack": true,
  "\\}": true,
  "\\rbrace": true,
  "\\rangle": true,
  "\\rceil": true,
  "\\rfloor": true,
  "\\rgroup": true,
  "\\rmoustache": true,
  "\\right": true,
  "\\bigr": true,
  "\\biggr": true,
  "\\Bigr": true,
  "\\Biggr": true,
  // \extra@ also tests for the following:
  "$": true,
  // \extrap@ checks for the following:
  ";": true,
  ".": true,
  ",": true
};
defineMacro("\\dotso", function(context) {
  var next = context.future().text;
  if (next in spaceAfterDots) {
    return "\\ldots\\,";
  } else {
    return "\\ldots";
  }
});
defineMacro("\\dotsc", function(context) {
  var next = context.future().text;
  if (next in spaceAfterDots && next !== ",") {
    return "\\ldots\\,";
  } else {
    return "\\ldots";
  }
});
defineMacro("\\cdots", function(context) {
  var next = context.future().text;
  if (next in spaceAfterDots) {
    return "\\@cdots\\,";
  } else {
    return "\\@cdots";
  }
});
defineMacro("\\dotsb", "\\cdots");
defineMacro("\\dotsm", "\\cdots");
defineMacro("\\dotsi", "\\!\\cdots");
defineMacro("\\dotsx", "\\ldots\\,");
defineMacro("\\DOTSI", "\\relax");
defineMacro("\\DOTSB", "\\relax");
defineMacro("\\DOTSX", "\\relax");
defineMacro("\\tmspace", "\\TextOrMath{\\kern#1#3}{\\mskip#1#2}\\relax");
defineMacro("\\,", "\\tmspace+{3mu}{.1667em}");
defineMacro("\\thinspace", "\\,");
defineMacro("\\>", "\\mskip{4mu}");
defineMacro("\\:", "\\tmspace+{4mu}{.2222em}");
defineMacro("\\medspace", "\\:");
defineMacro("\\;", "\\tmspace+{5mu}{.2777em}");
defineMacro("\\thickspace", "\\;");
defineMacro("\\!", "\\tmspace-{3mu}{.1667em}");
defineMacro("\\negthinspace", "\\!");
defineMacro("\\negmedspace", "\\tmspace-{4mu}{.2222em}");
defineMacro("\\negthickspace", "\\tmspace-{5mu}{.277em}");
defineMacro("\\enspace", "\\kern.5em ");
defineMacro("\\enskip", "\\hskip.5em\\relax");
defineMacro("\\quad", "\\hskip1em\\relax");
defineMacro("\\qquad", "\\hskip2em\\relax");
defineMacro("\\tag", "\\@ifstar\\tag@literal\\tag@paren");
defineMacro("\\tag@paren", "\\tag@literal{({#1})}");
defineMacro("\\tag@literal", (context) => {
  if (context.macros.get("\\df@tag")) {
    throw new ParseError("Multiple \\tag");
  }
  return "\\gdef\\df@tag{\\text{#1}}";
});
defineMacro("\\bmod", "\\mathchoice{\\mskip1mu}{\\mskip1mu}{\\mskip5mu}{\\mskip5mu}\\mathbin{\\rm mod}\\mathchoice{\\mskip1mu}{\\mskip1mu}{\\mskip5mu}{\\mskip5mu}");
defineMacro("\\pod", "\\allowbreak\\mathchoice{\\mkern18mu}{\\mkern8mu}{\\mkern8mu}{\\mkern8mu}(#1)");
defineMacro("\\pmod", "\\pod{{\\rm mod}\\mkern6mu#1}");
defineMacro("\\mod", "\\allowbreak\\mathchoice{\\mkern18mu}{\\mkern12mu}{\\mkern12mu}{\\mkern12mu}{\\rm mod}\\,\\,#1");
defineMacro("\\newline", "\\\\\\relax");
defineMacro("\\TeX", "\\textrm{\\html@mathml{T\\kern-.1667em\\raisebox{-.5ex}{E}\\kern-.125emX}{TeX}}");
var latexRaiseA = makeEm(fontMetricsData["Main-Regular"]["T".charCodeAt(0)][1] - 0.7 * fontMetricsData["Main-Regular"]["A".charCodeAt(0)][1]);
defineMacro("\\LaTeX", "\\textrm{\\html@mathml{" + ("L\\kern-.36em\\raisebox{" + latexRaiseA + "}{\\scriptstyle A}") + "\\kern-.15em\\TeX}{LaTeX}}");
defineMacro("\\KaTeX", "\\textrm{\\html@mathml{" + ("K\\kern-.17em\\raisebox{" + latexRaiseA + "}{\\scriptstyle A}") + "\\kern-.15em\\TeX}{KaTeX}}");
defineMacro("\\hspace", "\\@ifstar\\@hspacer\\@hspace");
defineMacro("\\@hspace", "\\hskip #1\\relax");
defineMacro("\\@hspacer", "\\rule{0pt}{0pt}\\hskip #1\\relax");
defineMacro("\\ordinarycolon", ":");
defineMacro("\\vcentcolon", "\\mathrel{\\mathop\\ordinarycolon}");
defineMacro("\\dblcolon", '\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-.9mu}\\vcentcolon}}{\\mathop{\\char"2237}}');
defineMacro("\\coloneqq", '\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}=}}{\\mathop{\\char"2254}}');
defineMacro("\\Coloneqq", '\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}=}}{\\mathop{\\char"2237\\char"3d}}');
defineMacro("\\coloneq", '\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}\\mathrel{-}}}{\\mathop{\\char"3a\\char"2212}}');
defineMacro("\\Coloneq", '\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}\\mathrel{-}}}{\\mathop{\\char"2237\\char"2212}}');
defineMacro("\\eqqcolon", '\\html@mathml{\\mathrel{=\\mathrel{\\mkern-1.2mu}\\vcentcolon}}{\\mathop{\\char"2255}}');
defineMacro("\\Eqqcolon", '\\html@mathml{\\mathrel{=\\mathrel{\\mkern-1.2mu}\\dblcolon}}{\\mathop{\\char"3d\\char"2237}}');
defineMacro("\\eqcolon", '\\html@mathml{\\mathrel{\\mathrel{-}\\mathrel{\\mkern-1.2mu}\\vcentcolon}}{\\mathop{\\char"2239}}');
defineMacro("\\Eqcolon", '\\html@mathml{\\mathrel{\\mathrel{-}\\mathrel{\\mkern-1.2mu}\\dblcolon}}{\\mathop{\\char"2212\\char"2237}}');
defineMacro("\\colonapprox", '\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}\\approx}}{\\mathop{\\char"3a\\char"2248}}');
defineMacro("\\Colonapprox", '\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}\\approx}}{\\mathop{\\char"2237\\char"2248}}');
defineMacro("\\colonsim", '\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}\\sim}}{\\mathop{\\char"3a\\char"223c}}');
defineMacro("\\Colonsim", '\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}\\sim}}{\\mathop{\\char"2237\\char"223c}}');
defineMacro("\u2237", "\\dblcolon");
defineMacro("\u2239", "\\eqcolon");
defineMacro("\u2254", "\\coloneqq");
defineMacro("\u2255", "\\eqqcolon");
defineMacro("\u2A74", "\\Coloneqq");
defineMacro("\\ratio", "\\vcentcolon");
defineMacro("\\coloncolon", "\\dblcolon");
defineMacro("\\colonequals", "\\coloneqq");
defineMacro("\\coloncolonequals", "\\Coloneqq");
defineMacro("\\equalscolon", "\\eqqcolon");
defineMacro("\\equalscoloncolon", "\\Eqqcolon");
defineMacro("\\colonminus", "\\coloneq");
defineMacro("\\coloncolonminus", "\\Coloneq");
defineMacro("\\minuscolon", "\\eqcolon");
defineMacro("\\minuscoloncolon", "\\Eqcolon");
defineMacro("\\coloncolonapprox", "\\Colonapprox");
defineMacro("\\coloncolonsim", "\\Colonsim");
defineMacro("\\simcolon", "\\mathrel{\\sim\\mathrel{\\mkern-1.2mu}\\vcentcolon}");
defineMacro("\\simcoloncolon", "\\mathrel{\\sim\\mathrel{\\mkern-1.2mu}\\dblcolon}");
defineMacro("\\approxcolon", "\\mathrel{\\approx\\mathrel{\\mkern-1.2mu}\\vcentcolon}");
defineMacro("\\approxcoloncolon", "\\mathrel{\\approx\\mathrel{\\mkern-1.2mu}\\dblcolon}");
defineMacro("\\notni", "\\html@mathml{\\not\\ni}{\\mathrel{\\char`\u220C}}");
defineMacro("\\limsup", "\\DOTSB\\operatorname*{lim\\,sup}");
defineMacro("\\liminf", "\\DOTSB\\operatorname*{lim\\,inf}");
defineMacro("\\injlim", "\\DOTSB\\operatorname*{inj\\,lim}");
defineMacro("\\projlim", "\\DOTSB\\operatorname*{proj\\,lim}");
defineMacro("\\varlimsup", "\\DOTSB\\operatorname*{\\overline{lim}}");
defineMacro("\\varliminf", "\\DOTSB\\operatorname*{\\underline{lim}}");
defineMacro("\\varinjlim", "\\DOTSB\\operatorname*{\\underrightarrow{lim}}");
defineMacro("\\varprojlim", "\\DOTSB\\operatorname*{\\underleftarrow{lim}}");
defineMacro("\\gvertneqq", "\\html@mathml{\\@gvertneqq}{\u2269}");
defineMacro("\\lvertneqq", "\\html@mathml{\\@lvertneqq}{\u2268}");
defineMacro("\\ngeqq", "\\html@mathml{\\@ngeqq}{\u2271}");
defineMacro("\\ngeqslant", "\\html@mathml{\\@ngeqslant}{\u2271}");
defineMacro("\\nleqq", "\\html@mathml{\\@nleqq}{\u2270}");
defineMacro("\\nleqslant", "\\html@mathml{\\@nleqslant}{\u2270}");
defineMacro("\\nshortmid", "\\html@mathml{\\@nshortmid}{\u2224}");
defineMacro("\\nshortparallel", "\\html@mathml{\\@nshortparallel}{\u2226}");
defineMacro("\\nsubseteqq", "\\html@mathml{\\@nsubseteqq}{\u2288}");
defineMacro("\\nsupseteqq", "\\html@mathml{\\@nsupseteqq}{\u2289}");
defineMacro("\\varsubsetneq", "\\html@mathml{\\@varsubsetneq}{\u228A}");
defineMacro("\\varsubsetneqq", "\\html@mathml{\\@varsubsetneqq}{\u2ACB}");
defineMacro("\\varsupsetneq", "\\html@mathml{\\@varsupsetneq}{\u228B}");
defineMacro("\\varsupsetneqq", "\\html@mathml{\\@varsupsetneqq}{\u2ACC}");
defineMacro("\\imath", "\\html@mathml{\\@imath}{\u0131}");
defineMacro("\\jmath", "\\html@mathml{\\@jmath}{\u0237}");
defineMacro("\\llbracket", "\\html@mathml{\\mathopen{[\\mkern-3.2mu[}}{\\mathopen{\\char`\u27E6}}");
defineMacro("\\rrbracket", "\\html@mathml{\\mathclose{]\\mkern-3.2mu]}}{\\mathclose{\\char`\u27E7}}");
defineMacro("\u27E6", "\\llbracket");
defineMacro("\u27E7", "\\rrbracket");
defineMacro("\\lBrace", "\\html@mathml{\\mathopen{\\{\\mkern-3.2mu[}}{\\mathopen{\\char`\u2983}}");
defineMacro("\\rBrace", "\\html@mathml{\\mathclose{]\\mkern-3.2mu\\}}}{\\mathclose{\\char`\u2984}}");
defineMacro("\u2983", "\\lBrace");
defineMacro("\u2984", "\\rBrace");
defineMacro("\\minuso", "\\mathbin{\\html@mathml{{\\mathrlap{\\mathchoice{\\kern{0.145em}}{\\kern{0.145em}}{\\kern{0.1015em}}{\\kern{0.0725em}}\\circ}{-}}}{\\char`\u29B5}}");
defineMacro("\u29B5", "\\minuso");
defineMacro("\\darr", "\\downarrow");
defineMacro("\\dArr", "\\Downarrow");
defineMacro("\\Darr", "\\Downarrow");
defineMacro("\\lang", "\\langle");
defineMacro("\\rang", "\\rangle");
defineMacro("\\uarr", "\\uparrow");
defineMacro("\\uArr", "\\Uparrow");
defineMacro("\\Uarr", "\\Uparrow");
defineMacro("\\N", "\\mathbb{N}");
defineMacro("\\R", "\\mathbb{R}");
defineMacro("\\Z", "\\mathbb{Z}");
defineMacro("\\alef", "\\aleph");
defineMacro("\\alefsym", "\\aleph");
defineMacro("\\Alpha", "\\mathrm{A}");
defineMacro("\\Beta", "\\mathrm{B}");
defineMacro("\\bull", "\\bullet");
defineMacro("\\Chi", "\\mathrm{X}");
defineMacro("\\clubs", "\\clubsuit");
defineMacro("\\cnums", "\\mathbb{C}");
defineMacro("\\Complex", "\\mathbb{C}");
defineMacro("\\Dagger", "\\ddagger");
defineMacro("\\diamonds", "\\diamondsuit");
defineMacro("\\empty", "\\emptyset");
defineMacro("\\Epsilon", "\\mathrm{E}");
defineMacro("\\Eta", "\\mathrm{H}");
defineMacro("\\exist", "\\exists");
defineMacro("\\harr", "\\leftrightarrow");
defineMacro("\\hArr", "\\Leftrightarrow");
defineMacro("\\Harr", "\\Leftrightarrow");
defineMacro("\\hearts", "\\heartsuit");
defineMacro("\\image", "\\Im");
defineMacro("\\infin", "\\infty");
defineMacro("\\Iota", "\\mathrm{I}");
defineMacro("\\isin", "\\in");
defineMacro("\\Kappa", "\\mathrm{K}");
defineMacro("\\larr", "\\leftarrow");
defineMacro("\\lArr", "\\Leftarrow");
defineMacro("\\Larr", "\\Leftarrow");
defineMacro("\\lrarr", "\\leftrightarrow");
defineMacro("\\lrArr", "\\Leftrightarrow");
defineMacro("\\Lrarr", "\\Leftrightarrow");
defineMacro("\\Mu", "\\mathrm{M}");
defineMacro("\\natnums", "\\mathbb{N}");
defineMacro("\\Nu", "\\mathrm{N}");
defineMacro("\\Omicron", "\\mathrm{O}");
defineMacro("\\plusmn", "\\pm");
defineMacro("\\rarr", "\\rightarrow");
defineMacro("\\rArr", "\\Rightarrow");
defineMacro("\\Rarr", "\\Rightarrow");
defineMacro("\\real", "\\Re");
defineMacro("\\reals", "\\mathbb{R}");
defineMacro("\\Reals", "\\mathbb{R}");
defineMacro("\\Rho", "\\mathrm{P}");
defineMacro("\\sdot", "\\cdot");
defineMacro("\\sect", "\\S");
defineMacro("\\spades", "\\spadesuit");
defineMacro("\\sub", "\\subset");
defineMacro("\\sube", "\\subseteq");
defineMacro("\\supe", "\\supseteq");
defineMacro("\\Tau", "\\mathrm{T}");
defineMacro("\\thetasym", "\\vartheta");
defineMacro("\\weierp", "\\wp");
defineMacro("\\Zeta", "\\mathrm{Z}");
defineMacro("\\argmin", "\\DOTSB\\operatorname*{arg\\,min}");
defineMacro("\\argmax", "\\DOTSB\\operatorname*{arg\\,max}");
defineMacro("\\plim", "\\DOTSB\\mathop{\\operatorname{plim}}\\limits");
defineMacro("\\bra", "\\mathinner{\\langle{#1}|}");
defineMacro("\\ket", "\\mathinner{|{#1}\\rangle}");
defineMacro("\\braket", "\\mathinner{\\langle{#1}\\rangle}");
defineMacro("\\Bra", "\\left\\langle#1\\right|");
defineMacro("\\Ket", "\\left|#1\\right\\rangle");
var braketHelper = (one) => (context) => {
  var left = context.consumeArg().tokens;
  var middle = context.consumeArg().tokens;
  var middleDouble = context.consumeArg().tokens;
  var right = context.consumeArg().tokens;
  var oldMiddle = context.macros.get("|");
  var oldMiddleDouble = context.macros.get("\\|");
  context.macros.beginGroup();
  var midMacro = (double) => (context2) => {
    if (one) {
      context2.macros.set("|", oldMiddle);
      if (middleDouble.length) {
        context2.macros.set("\\|", oldMiddleDouble);
      }
    }
    var doubled = double;
    if (!double && middleDouble.length) {
      var nextToken = context2.future();
      if (nextToken.text === "|") {
        context2.popToken();
        doubled = true;
      }
    }
    return {
      tokens: doubled ? middleDouble : middle,
      numArgs: 0
    };
  };
  context.macros.set("|", midMacro(false));
  if (middleDouble.length) {
    context.macros.set("\\|", midMacro(true));
  }
  var arg = context.consumeArg().tokens;
  var expanded = context.expandTokens([
    ...right,
    ...arg,
    ...left
    // reversed
  ]);
  context.macros.endGroup();
  return {
    tokens: expanded.reverse(),
    numArgs: 0
  };
};
defineMacro("\\bra@ket", braketHelper(false));
defineMacro("\\bra@set", braketHelper(true));
defineMacro("\\Braket", "\\bra@ket{\\left\\langle}{\\,\\middle\\vert\\,}{\\,\\middle\\vert\\,}{\\right\\rangle}");
defineMacro("\\Set", "\\bra@set{\\left\\{\\:}{\\;\\middle\\vert\\;}{\\;\\middle\\Vert\\;}{\\:\\right\\}}");
defineMacro("\\set", "\\bra@set{\\{\\,}{\\mid}{}{\\,\\}}");
defineMacro("\\angln", "{\\angl n}");
defineMacro("\\blue", "\\textcolor{##6495ed}{#1}");
defineMacro("\\orange", "\\textcolor{##ffa500}{#1}");
defineMacro("\\pink", "\\textcolor{##ff00af}{#1}");
defineMacro("\\red", "\\textcolor{##df0030}{#1}");
defineMacro("\\green", "\\textcolor{##28ae7b}{#1}");
defineMacro("\\gray", "\\textcolor{gray}{#1}");
defineMacro("\\purple", "\\textcolor{##9d38bd}{#1}");
defineMacro("\\blueA", "\\textcolor{##ccfaff}{#1}");
defineMacro("\\blueB", "\\textcolor{##80f6ff}{#1}");
defineMacro("\\blueC", "\\textcolor{##63d9ea}{#1}");
defineMacro("\\blueD", "\\textcolor{##11accd}{#1}");
defineMacro("\\blueE", "\\textcolor{##0c7f99}{#1}");
defineMacro("\\tealA", "\\textcolor{##94fff5}{#1}");
defineMacro("\\tealB", "\\textcolor{##26edd5}{#1}");
defineMacro("\\tealC", "\\textcolor{##01d1c1}{#1}");
defineMacro("\\tealD", "\\textcolor{##01a995}{#1}");
defineMacro("\\tealE", "\\textcolor{##208170}{#1}");
defineMacro("\\greenA", "\\textcolor{##b6ffb0}{#1}");
defineMacro("\\greenB", "\\textcolor{##8af281}{#1}");
defineMacro("\\greenC", "\\textcolor{##74cf70}{#1}");
defineMacro("\\greenD", "\\textcolor{##1fab54}{#1}");
defineMacro("\\greenE", "\\textcolor{##0d923f}{#1}");
defineMacro("\\goldA", "\\textcolor{##ffd0a9}{#1}");
defineMacro("\\goldB", "\\textcolor{##ffbb71}{#1}");
defineMacro("\\goldC", "\\textcolor{##ff9c39}{#1}");
defineMacro("\\goldD", "\\textcolor{##e07d10}{#1}");
defineMacro("\\goldE", "\\textcolor{##a75a05}{#1}");
defineMacro("\\redA", "\\textcolor{##fca9a9}{#1}");
defineMacro("\\redB", "\\textcolor{##ff8482}{#1}");
defineMacro("\\redC", "\\textcolor{##f9685d}{#1}");
defineMacro("\\redD", "\\textcolor{##e84d39}{#1}");
defineMacro("\\redE", "\\textcolor{##bc2612}{#1}");
defineMacro("\\maroonA", "\\textcolor{##ffbde0}{#1}");
defineMacro("\\maroonB", "\\textcolor{##ff92c6}{#1}");
defineMacro("\\maroonC", "\\textcolor{##ed5fa6}{#1}");
defineMacro("\\maroonD", "\\textcolor{##ca337c}{#1}");
defineMacro("\\maroonE", "\\textcolor{##9e034e}{#1}");
defineMacro("\\purpleA", "\\textcolor{##ddd7ff}{#1}");
defineMacro("\\purpleB", "\\textcolor{##c6b9fc}{#1}");
defineMacro("\\purpleC", "\\textcolor{##aa87ff}{#1}");
defineMacro("\\purpleD", "\\textcolor{##7854ab}{#1}");
defineMacro("\\purpleE", "\\textcolor{##543b78}{#1}");
defineMacro("\\mintA", "\\textcolor{##f5f9e8}{#1}");
defineMacro("\\mintB", "\\textcolor{##edf2df}{#1}");
defineMacro("\\mintC", "\\textcolor{##e0e5cc}{#1}");
defineMacro("\\grayA", "\\textcolor{##f6f7f7}{#1}");
defineMacro("\\grayB", "\\textcolor{##f0f1f2}{#1}");
defineMacro("\\grayC", "\\textcolor{##e3e5e6}{#1}");
defineMacro("\\grayD", "\\textcolor{##d6d8da}{#1}");
defineMacro("\\grayE", "\\textcolor{##babec2}{#1}");
defineMacro("\\grayF", "\\textcolor{##888d93}{#1}");
defineMacro("\\grayG", "\\textcolor{##626569}{#1}");
defineMacro("\\grayH", "\\textcolor{##3b3e40}{#1}");
defineMacro("\\grayI", "\\textcolor{##21242c}{#1}");
defineMacro("\\kaBlue", "\\textcolor{##314453}{#1}");
defineMacro("\\kaGreen", "\\textcolor{##71B307}{#1}");
var implicitCommands = {
  "^": true,
  // Parser.js
  "_": true,
  // Parser.js
  "\\limits": true,
  // Parser.js
  "\\nolimits": true
  // Parser.js
};
var MacroExpander = class {
  constructor(input, settings, mode) {
    this.settings = void 0;
    this.expansionCount = void 0;
    this.lexer = void 0;
    this.macros = void 0;
    this.stack = void 0;
    this.mode = void 0;
    this.settings = settings;
    this.expansionCount = 0;
    this.feed(input);
    this.macros = new Namespace(macros, settings.macros);
    this.mode = mode;
    this.stack = [];
  }
  /**
   * Feed a new input string to the same MacroExpander
   * (with existing macros etc.).
   */
  feed(input) {
    this.lexer = new Lexer(input, this.settings);
  }
  /**
   * Switches between "text" and "math" modes.
   */
  switchMode(newMode) {
    this.mode = newMode;
  }
  /**
   * Start a new group nesting within all namespaces.
   */
  beginGroup() {
    this.macros.beginGroup();
  }
  /**
   * End current group nesting within all namespaces.
   */
  endGroup() {
    this.macros.endGroup();
  }
  /**
   * Ends all currently nested groups (if any), restoring values before the
   * groups began.  Useful in case of an error in the middle of parsing.
   */
  endGroups() {
    this.macros.endGroups();
  }
  /**
   * Returns the topmost token on the stack, without expanding it.
   * Similar in behavior to TeX's `\futurelet`.
   */
  future() {
    if (this.stack.length === 0) {
      this.pushToken(this.lexer.lex());
    }
    return this.stack[this.stack.length - 1];
  }
  /**
   * Remove and return the next unexpanded token.
   */
  popToken() {
    this.future();
    return this.stack.pop();
  }
  /**
   * Add a given token to the token stack.  In particular, this get be used
   * to put back a token returned from one of the other methods.
   */
  pushToken(token) {
    this.stack.push(token);
  }
  /**
   * Append an array of tokens to the token stack.
   */
  pushTokens(tokens) {
    this.stack.push(...tokens);
  }
  /**
   * Find an macro argument without expanding tokens and append the array of
   * tokens to the token stack. Uses Token as a container for the result.
   */
  scanArgument(isOptional) {
    var start;
    var end;
    var tokens;
    if (isOptional) {
      this.consumeSpaces();
      if (this.future().text !== "[") {
        return null;
      }
      start = this.popToken();
      ({
        tokens,
        end
      } = this.consumeArg(["]"]));
    } else {
      ({
        tokens,
        start,
        end
      } = this.consumeArg());
    }
    this.pushToken(new Token("EOF", end.loc));
    this.pushTokens(tokens);
    return start.range(end, "");
  }
  /**
   * Consume all following space tokens, without expansion.
   */
  consumeSpaces() {
    for (; ; ) {
      var token = this.future();
      if (token.text === " ") {
        this.stack.pop();
      } else {
        break;
      }
    }
  }
  /**
   * Consume an argument from the token stream, and return the resulting array
   * of tokens and start/end token.
   */
  consumeArg(delims) {
    var tokens = [];
    var isDelimited = delims && delims.length > 0;
    if (!isDelimited) {
      this.consumeSpaces();
    }
    var start = this.future();
    var tok;
    var depth = 0;
    var match = 0;
    do {
      tok = this.popToken();
      tokens.push(tok);
      if (tok.text === "{") {
        ++depth;
      } else if (tok.text === "}") {
        --depth;
        if (depth === -1) {
          throw new ParseError("Extra }", tok);
        }
      } else if (tok.text === "EOF") {
        throw new ParseError("Unexpected end of input in a macro argument, expected '" + (delims && isDelimited ? delims[match] : "}") + "'", tok);
      }
      if (delims && isDelimited) {
        if ((depth === 0 || depth === 1 && delims[match] === "{") && tok.text === delims[match]) {
          ++match;
          if (match === delims.length) {
            tokens.splice(-match, match);
            break;
          }
        } else {
          match = 0;
        }
      }
    } while (depth !== 0 || isDelimited);
    if (start.text === "{" && tokens[tokens.length - 1].text === "}") {
      tokens.pop();
      tokens.shift();
    }
    tokens.reverse();
    return {
      tokens,
      start,
      end: tok
    };
  }
  /**
   * Consume the specified number of (delimited) arguments from the token
   * stream and return the resulting array of arguments.
   */
  consumeArgs(numArgs, delimiters2) {
    if (delimiters2) {
      if (delimiters2.length !== numArgs + 1) {
        throw new ParseError("The length of delimiters doesn't match the number of args!");
      }
      var delims = delimiters2[0];
      for (var i2 = 0; i2 < delims.length; i2++) {
        var tok = this.popToken();
        if (delims[i2] !== tok.text) {
          throw new ParseError("Use of the macro doesn't match its definition", tok);
        }
      }
    }
    var args = [];
    for (var _i6 = 0; _i6 < numArgs; _i6++) {
      args.push(this.consumeArg(delimiters2 && delimiters2[_i6 + 1]).tokens);
    }
    return args;
  }
  /**
   * Increment `expansionCount` by the specified amount.
   * Throw an error if it exceeds `maxExpand`.
   */
  countExpansion(amount) {
    this.expansionCount += amount;
    if (this.expansionCount > this.settings.maxExpand) {
      throw new ParseError("Too many expansions: infinite loop or need to increase maxExpand setting");
    }
  }
  /**
   * Expand the next token only once if possible.
   *
   * If the token is expanded, the resulting tokens will be pushed onto
   * the stack in reverse order, and the number of such tokens will be
   * returned.  This number might be zero or positive.
   *
   * If not, the return value is `false`, and the next token remains at the
   * top of the stack.
   *
   * In either case, the next token will be on the top of the stack,
   * or the stack will be empty (in case of empty expansion
   * and no other tokens).
   *
   * Used to implement `expandAfterFuture` and `expandNextToken`.
   *
   * If expandableOnly, only expandable tokens are expanded and
   * an undefined control sequence results in an error.
   */
  expandOnce(expandableOnly) {
    var topToken = this.popToken();
    var name = topToken.text;
    var expansion = !topToken.noexpand ? this._getExpansion(name) : null;
    if (expansion == null || expandableOnly && expansion.unexpandable) {
      if (expandableOnly && expansion == null && name[0] === "\\" && !this.isDefined(name)) {
        throw new ParseError("Undefined control sequence: " + name);
      }
      this.pushToken(topToken);
      return false;
    }
    this.countExpansion(1);
    var tokens = expansion.tokens;
    var args = this.consumeArgs(expansion.numArgs, expansion.delimiters);
    if (expansion.numArgs) {
      tokens = tokens.slice();
      for (var i2 = tokens.length - 1; i2 >= 0; --i2) {
        var tok = tokens[i2];
        if (tok.text === "#") {
          if (i2 === 0) {
            throw new ParseError("Incomplete placeholder at end of macro body", tok);
          }
          tok = tokens[--i2];
          if (tok.text === "#") {
            tokens.splice(i2 + 1, 1);
          } else if (/^[1-9]$/.test(tok.text)) {
            tokens.splice(i2, 2, ...args[+tok.text - 1]);
          } else {
            throw new ParseError("Not a valid argument number", tok);
          }
        }
      }
    }
    this.pushTokens(tokens);
    return tokens.length;
  }
  /**
   * Expand the next token only once (if possible), and return the resulting
   * top token on the stack (without removing anything from the stack).
   * Similar in behavior to TeX's `\expandafter\futurelet`.
   * Equivalent to expandOnce() followed by future().
   */
  expandAfterFuture() {
    this.expandOnce();
    return this.future();
  }
  /**
   * Recursively expand first token, then return first non-expandable token.
   */
  expandNextToken() {
    for (; ; ) {
      if (this.expandOnce() === false) {
        var token = this.stack.pop();
        if (token.treatAsRelax) {
          token.text = "\\relax";
        }
        return token;
      }
    }
    throw new Error();
  }
  /**
   * Fully expand the given macro name and return the resulting list of
   * tokens, or return `undefined` if no such macro is defined.
   */
  expandMacro(name) {
    return this.macros.has(name) ? this.expandTokens([new Token(name)]) : void 0;
  }
  /**
   * Fully expand the given token stream and return the resulting list of
   * tokens.  Note that the input tokens are in reverse order, but the
   * output tokens are in forward order.
   */
  expandTokens(tokens) {
    var output = [];
    var oldStackLength = this.stack.length;
    this.pushTokens(tokens);
    while (this.stack.length > oldStackLength) {
      if (this.expandOnce(true) === false) {
        var token = this.stack.pop();
        if (token.treatAsRelax) {
          token.noexpand = false;
          token.treatAsRelax = false;
        }
        output.push(token);
      }
    }
    this.countExpansion(output.length);
    return output;
  }
  /**
   * Fully expand the given macro name and return the result as a string,
   * or return `undefined` if no such macro is defined.
   */
  expandMacroAsText(name) {
    var tokens = this.expandMacro(name);
    if (tokens) {
      return tokens.map((token) => token.text).join("");
    } else {
      return tokens;
    }
  }
  /**
   * Returns the expanded macro as a reversed array of tokens and a macro
   * argument count.  Or returns `null` if no such macro.
   */
  _getExpansion(name) {
    var definition = this.macros.get(name);
    if (definition == null) {
      return definition;
    }
    if (name.length === 1) {
      var catcode = this.lexer.catcodes[name];
      if (catcode != null && catcode !== 13) {
        return;
      }
    }
    var expansion = typeof definition === "function" ? definition(this) : definition;
    if (typeof expansion === "string") {
      var numArgs = 0;
      if (expansion.indexOf("#") !== -1) {
        var stripped = expansion.replace(/##/g, "");
        while (stripped.indexOf("#" + (numArgs + 1)) !== -1) {
          ++numArgs;
        }
      }
      var bodyLexer = new Lexer(expansion, this.settings);
      var tokens = [];
      var tok = bodyLexer.lex();
      while (tok.text !== "EOF") {
        tokens.push(tok);
        tok = bodyLexer.lex();
      }
      tokens.reverse();
      var expanded = {
        tokens,
        numArgs
      };
      return expanded;
    }
    return expansion;
  }
  /**
   * Determine whether a command is currently "defined" (has some
   * functionality), meaning that it's a macro (in the current group),
   * a function, a symbol, or one of the special commands listed in
   * `implicitCommands`.
   */
  isDefined(name) {
    return this.macros.has(name) || functions.hasOwnProperty(name) || symbols.math.hasOwnProperty(name) || symbols.text.hasOwnProperty(name) || implicitCommands.hasOwnProperty(name);
  }
  /**
   * Determine whether a command is expandable.
   */
  isExpandable(name) {
    var macro = this.macros.get(name);
    return macro != null ? typeof macro === "string" || typeof macro === "function" || !macro.unexpandable : functions.hasOwnProperty(name) && !functions[name].primitive;
  }
};
var unicodeSubRegEx = /^[₊₋₌₍₎₀₁₂₃₄₅₆₇₈₉ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ]/;
var uSubsAndSups = Object.freeze({
  "\u208A": "+",
  "\u208B": "-",
  "\u208C": "=",
  "\u208D": "(",
  "\u208E": ")",
  "\u2080": "0",
  "\u2081": "1",
  "\u2082": "2",
  "\u2083": "3",
  "\u2084": "4",
  "\u2085": "5",
  "\u2086": "6",
  "\u2087": "7",
  "\u2088": "8",
  "\u2089": "9",
  "\u2090": "a",
  "\u2091": "e",
  "\u2095": "h",
  "\u1D62": "i",
  "\u2C7C": "j",
  "\u2096": "k",
  "\u2097": "l",
  "\u2098": "m",
  "\u2099": "n",
  "\u2092": "o",
  "\u209A": "p",
  "\u1D63": "r",
  "\u209B": "s",
  "\u209C": "t",
  "\u1D64": "u",
  "\u1D65": "v",
  "\u2093": "x",
  "\u1D66": "\u03B2",
  "\u1D67": "\u03B3",
  "\u1D68": "\u03C1",
  "\u1D69": "\u03D5",
  "\u1D6A": "\u03C7",
  "\u207A": "+",
  "\u207B": "-",
  "\u207C": "=",
  "\u207D": "(",
  "\u207E": ")",
  "\u2070": "0",
  "\xB9": "1",
  "\xB2": "2",
  "\xB3": "3",
  "\u2074": "4",
  "\u2075": "5",
  "\u2076": "6",
  "\u2077": "7",
  "\u2078": "8",
  "\u2079": "9",
  "\u1D2C": "A",
  "\u1D2E": "B",
  "\u1D30": "D",
  "\u1D31": "E",
  "\u1D33": "G",
  "\u1D34": "H",
  "\u1D35": "I",
  "\u1D36": "J",
  "\u1D37": "K",
  "\u1D38": "L",
  "\u1D39": "M",
  "\u1D3A": "N",
  "\u1D3C": "O",
  "\u1D3E": "P",
  "\u1D3F": "R",
  "\u1D40": "T",
  "\u1D41": "U",
  "\u2C7D": "V",
  "\u1D42": "W",
  "\u1D43": "a",
  "\u1D47": "b",
  "\u1D9C": "c",
  "\u1D48": "d",
  "\u1D49": "e",
  "\u1DA0": "f",
  "\u1D4D": "g",
  "\u02B0": "h",
  "\u2071": "i",
  "\u02B2": "j",
  "\u1D4F": "k",
  "\u02E1": "l",
  "\u1D50": "m",
  "\u207F": "n",
  "\u1D52": "o",
  "\u1D56": "p",
  "\u02B3": "r",
  "\u02E2": "s",
  "\u1D57": "t",
  "\u1D58": "u",
  "\u1D5B": "v",
  "\u02B7": "w",
  "\u02E3": "x",
  "\u02B8": "y",
  "\u1DBB": "z",
  "\u1D5D": "\u03B2",
  "\u1D5E": "\u03B3",
  "\u1D5F": "\u03B4",
  "\u1D60": "\u03D5",
  "\u1D61": "\u03C7",
  "\u1DBF": "\u03B8"
});
var unicodeAccents = {
  "\u0301": {
    "text": "\\'",
    "math": "\\acute"
  },
  "\u0300": {
    "text": "\\`",
    "math": "\\grave"
  },
  "\u0308": {
    "text": '\\"',
    "math": "\\ddot"
  },
  "\u0303": {
    "text": "\\~",
    "math": "\\tilde"
  },
  "\u0304": {
    "text": "\\=",
    "math": "\\bar"
  },
  "\u0306": {
    "text": "\\u",
    "math": "\\breve"
  },
  "\u030C": {
    "text": "\\v",
    "math": "\\check"
  },
  "\u0302": {
    "text": "\\^",
    "math": "\\hat"
  },
  "\u0307": {
    "text": "\\.",
    "math": "\\dot"
  },
  "\u030A": {
    "text": "\\r",
    "math": "\\mathring"
  },
  "\u030B": {
    "text": "\\H"
  },
  "\u0327": {
    "text": "\\c"
  }
};
var unicodeSymbols = {
  "\xE1": "a\u0301",
  "\xE0": "a\u0300",
  "\xE4": "a\u0308",
  "\u01DF": "a\u0308\u0304",
  "\xE3": "a\u0303",
  "\u0101": "a\u0304",
  "\u0103": "a\u0306",
  "\u1EAF": "a\u0306\u0301",
  "\u1EB1": "a\u0306\u0300",
  "\u1EB5": "a\u0306\u0303",
  "\u01CE": "a\u030C",
  "\xE2": "a\u0302",
  "\u1EA5": "a\u0302\u0301",
  "\u1EA7": "a\u0302\u0300",
  "\u1EAB": "a\u0302\u0303",
  "\u0227": "a\u0307",
  "\u01E1": "a\u0307\u0304",
  "\xE5": "a\u030A",
  "\u01FB": "a\u030A\u0301",
  "\u1E03": "b\u0307",
  "\u0107": "c\u0301",
  "\u1E09": "c\u0327\u0301",
  "\u010D": "c\u030C",
  "\u0109": "c\u0302",
  "\u010B": "c\u0307",
  "\xE7": "c\u0327",
  "\u010F": "d\u030C",
  "\u1E0B": "d\u0307",
  "\u1E11": "d\u0327",
  "\xE9": "e\u0301",
  "\xE8": "e\u0300",
  "\xEB": "e\u0308",
  "\u1EBD": "e\u0303",
  "\u0113": "e\u0304",
  "\u1E17": "e\u0304\u0301",
  "\u1E15": "e\u0304\u0300",
  "\u0115": "e\u0306",
  "\u1E1D": "e\u0327\u0306",
  "\u011B": "e\u030C",
  "\xEA": "e\u0302",
  "\u1EBF": "e\u0302\u0301",
  "\u1EC1": "e\u0302\u0300",
  "\u1EC5": "e\u0302\u0303",
  "\u0117": "e\u0307",
  "\u0229": "e\u0327",
  "\u1E1F": "f\u0307",
  "\u01F5": "g\u0301",
  "\u1E21": "g\u0304",
  "\u011F": "g\u0306",
  "\u01E7": "g\u030C",
  "\u011D": "g\u0302",
  "\u0121": "g\u0307",
  "\u0123": "g\u0327",
  "\u1E27": "h\u0308",
  "\u021F": "h\u030C",
  "\u0125": "h\u0302",
  "\u1E23": "h\u0307",
  "\u1E29": "h\u0327",
  "\xED": "i\u0301",
  "\xEC": "i\u0300",
  "\xEF": "i\u0308",
  "\u1E2F": "i\u0308\u0301",
  "\u0129": "i\u0303",
  "\u012B": "i\u0304",
  "\u012D": "i\u0306",
  "\u01D0": "i\u030C",
  "\xEE": "i\u0302",
  "\u01F0": "j\u030C",
  "\u0135": "j\u0302",
  "\u1E31": "k\u0301",
  "\u01E9": "k\u030C",
  "\u0137": "k\u0327",
  "\u013A": "l\u0301",
  "\u013E": "l\u030C",
  "\u013C": "l\u0327",
  "\u1E3F": "m\u0301",
  "\u1E41": "m\u0307",
  "\u0144": "n\u0301",
  "\u01F9": "n\u0300",
  "\xF1": "n\u0303",
  "\u0148": "n\u030C",
  "\u1E45": "n\u0307",
  "\u0146": "n\u0327",
  "\xF3": "o\u0301",
  "\xF2": "o\u0300",
  "\xF6": "o\u0308",
  "\u022B": "o\u0308\u0304",
  "\xF5": "o\u0303",
  "\u1E4D": "o\u0303\u0301",
  "\u1E4F": "o\u0303\u0308",
  "\u022D": "o\u0303\u0304",
  "\u014D": "o\u0304",
  "\u1E53": "o\u0304\u0301",
  "\u1E51": "o\u0304\u0300",
  "\u014F": "o\u0306",
  "\u01D2": "o\u030C",
  "\xF4": "o\u0302",
  "\u1ED1": "o\u0302\u0301",
  "\u1ED3": "o\u0302\u0300",
  "\u1ED7": "o\u0302\u0303",
  "\u022F": "o\u0307",
  "\u0231": "o\u0307\u0304",
  "\u0151": "o\u030B",
  "\u1E55": "p\u0301",
  "\u1E57": "p\u0307",
  "\u0155": "r\u0301",
  "\u0159": "r\u030C",
  "\u1E59": "r\u0307",
  "\u0157": "r\u0327",
  "\u015B": "s\u0301",
  "\u1E65": "s\u0301\u0307",
  "\u0161": "s\u030C",
  "\u1E67": "s\u030C\u0307",
  "\u015D": "s\u0302",
  "\u1E61": "s\u0307",
  "\u015F": "s\u0327",
  "\u1E97": "t\u0308",
  "\u0165": "t\u030C",
  "\u1E6B": "t\u0307",
  "\u0163": "t\u0327",
  "\xFA": "u\u0301",
  "\xF9": "u\u0300",
  "\xFC": "u\u0308",
  "\u01D8": "u\u0308\u0301",
  "\u01DC": "u\u0308\u0300",
  "\u01D6": "u\u0308\u0304",
  "\u01DA": "u\u0308\u030C",
  "\u0169": "u\u0303",
  "\u1E79": "u\u0303\u0301",
  "\u016B": "u\u0304",
  "\u1E7B": "u\u0304\u0308",
  "\u016D": "u\u0306",
  "\u01D4": "u\u030C",
  "\xFB": "u\u0302",
  "\u016F": "u\u030A",
  "\u0171": "u\u030B",
  "\u1E7D": "v\u0303",
  "\u1E83": "w\u0301",
  "\u1E81": "w\u0300",
  "\u1E85": "w\u0308",
  "\u0175": "w\u0302",
  "\u1E87": "w\u0307",
  "\u1E98": "w\u030A",
  "\u1E8D": "x\u0308",
  "\u1E8B": "x\u0307",
  "\xFD": "y\u0301",
  "\u1EF3": "y\u0300",
  "\xFF": "y\u0308",
  "\u1EF9": "y\u0303",
  "\u0233": "y\u0304",
  "\u0177": "y\u0302",
  "\u1E8F": "y\u0307",
  "\u1E99": "y\u030A",
  "\u017A": "z\u0301",
  "\u017E": "z\u030C",
  "\u1E91": "z\u0302",
  "\u017C": "z\u0307",
  "\xC1": "A\u0301",
  "\xC0": "A\u0300",
  "\xC4": "A\u0308",
  "\u01DE": "A\u0308\u0304",
  "\xC3": "A\u0303",
  "\u0100": "A\u0304",
  "\u0102": "A\u0306",
  "\u1EAE": "A\u0306\u0301",
  "\u1EB0": "A\u0306\u0300",
  "\u1EB4": "A\u0306\u0303",
  "\u01CD": "A\u030C",
  "\xC2": "A\u0302",
  "\u1EA4": "A\u0302\u0301",
  "\u1EA6": "A\u0302\u0300",
  "\u1EAA": "A\u0302\u0303",
  "\u0226": "A\u0307",
  "\u01E0": "A\u0307\u0304",
  "\xC5": "A\u030A",
  "\u01FA": "A\u030A\u0301",
  "\u1E02": "B\u0307",
  "\u0106": "C\u0301",
  "\u1E08": "C\u0327\u0301",
  "\u010C": "C\u030C",
  "\u0108": "C\u0302",
  "\u010A": "C\u0307",
  "\xC7": "C\u0327",
  "\u010E": "D\u030C",
  "\u1E0A": "D\u0307",
  "\u1E10": "D\u0327",
  "\xC9": "E\u0301",
  "\xC8": "E\u0300",
  "\xCB": "E\u0308",
  "\u1EBC": "E\u0303",
  "\u0112": "E\u0304",
  "\u1E16": "E\u0304\u0301",
  "\u1E14": "E\u0304\u0300",
  "\u0114": "E\u0306",
  "\u1E1C": "E\u0327\u0306",
  "\u011A": "E\u030C",
  "\xCA": "E\u0302",
  "\u1EBE": "E\u0302\u0301",
  "\u1EC0": "E\u0302\u0300",
  "\u1EC4": "E\u0302\u0303",
  "\u0116": "E\u0307",
  "\u0228": "E\u0327",
  "\u1E1E": "F\u0307",
  "\u01F4": "G\u0301",
  "\u1E20": "G\u0304",
  "\u011E": "G\u0306",
  "\u01E6": "G\u030C",
  "\u011C": "G\u0302",
  "\u0120": "G\u0307",
  "\u0122": "G\u0327",
  "\u1E26": "H\u0308",
  "\u021E": "H\u030C",
  "\u0124": "H\u0302",
  "\u1E22": "H\u0307",
  "\u1E28": "H\u0327",
  "\xCD": "I\u0301",
  "\xCC": "I\u0300",
  "\xCF": "I\u0308",
  "\u1E2E": "I\u0308\u0301",
  "\u0128": "I\u0303",
  "\u012A": "I\u0304",
  "\u012C": "I\u0306",
  "\u01CF": "I\u030C",
  "\xCE": "I\u0302",
  "\u0130": "I\u0307",
  "\u0134": "J\u0302",
  "\u1E30": "K\u0301",
  "\u01E8": "K\u030C",
  "\u0136": "K\u0327",
  "\u0139": "L\u0301",
  "\u013D": "L\u030C",
  "\u013B": "L\u0327",
  "\u1E3E": "M\u0301",
  "\u1E40": "M\u0307",
  "\u0143": "N\u0301",
  "\u01F8": "N\u0300",
  "\xD1": "N\u0303",
  "\u0147": "N\u030C",
  "\u1E44": "N\u0307",
  "\u0145": "N\u0327",
  "\xD3": "O\u0301",
  "\xD2": "O\u0300",
  "\xD6": "O\u0308",
  "\u022A": "O\u0308\u0304",
  "\xD5": "O\u0303",
  "\u1E4C": "O\u0303\u0301",
  "\u1E4E": "O\u0303\u0308",
  "\u022C": "O\u0303\u0304",
  "\u014C": "O\u0304",
  "\u1E52": "O\u0304\u0301",
  "\u1E50": "O\u0304\u0300",
  "\u014E": "O\u0306",
  "\u01D1": "O\u030C",
  "\xD4": "O\u0302",
  "\u1ED0": "O\u0302\u0301",
  "\u1ED2": "O\u0302\u0300",
  "\u1ED6": "O\u0302\u0303",
  "\u022E": "O\u0307",
  "\u0230": "O\u0307\u0304",
  "\u0150": "O\u030B",
  "\u1E54": "P\u0301",
  "\u1E56": "P\u0307",
  "\u0154": "R\u0301",
  "\u0158": "R\u030C",
  "\u1E58": "R\u0307",
  "\u0156": "R\u0327",
  "\u015A": "S\u0301",
  "\u1E64": "S\u0301\u0307",
  "\u0160": "S\u030C",
  "\u1E66": "S\u030C\u0307",
  "\u015C": "S\u0302",
  "\u1E60": "S\u0307",
  "\u015E": "S\u0327",
  "\u0164": "T\u030C",
  "\u1E6A": "T\u0307",
  "\u0162": "T\u0327",
  "\xDA": "U\u0301",
  "\xD9": "U\u0300",
  "\xDC": "U\u0308",
  "\u01D7": "U\u0308\u0301",
  "\u01DB": "U\u0308\u0300",
  "\u01D5": "U\u0308\u0304",
  "\u01D9": "U\u0308\u030C",
  "\u0168": "U\u0303",
  "\u1E78": "U\u0303\u0301",
  "\u016A": "U\u0304",
  "\u1E7A": "U\u0304\u0308",
  "\u016C": "U\u0306",
  "\u01D3": "U\u030C",
  "\xDB": "U\u0302",
  "\u016E": "U\u030A",
  "\u0170": "U\u030B",
  "\u1E7C": "V\u0303",
  "\u1E82": "W\u0301",
  "\u1E80": "W\u0300",
  "\u1E84": "W\u0308",
  "\u0174": "W\u0302",
  "\u1E86": "W\u0307",
  "\u1E8C": "X\u0308",
  "\u1E8A": "X\u0307",
  "\xDD": "Y\u0301",
  "\u1EF2": "Y\u0300",
  "\u0178": "Y\u0308",
  "\u1EF8": "Y\u0303",
  "\u0232": "Y\u0304",
  "\u0176": "Y\u0302",
  "\u1E8E": "Y\u0307",
  "\u0179": "Z\u0301",
  "\u017D": "Z\u030C",
  "\u1E90": "Z\u0302",
  "\u017B": "Z\u0307",
  "\u03AC": "\u03B1\u0301",
  "\u1F70": "\u03B1\u0300",
  "\u1FB1": "\u03B1\u0304",
  "\u1FB0": "\u03B1\u0306",
  "\u03AD": "\u03B5\u0301",
  "\u1F72": "\u03B5\u0300",
  "\u03AE": "\u03B7\u0301",
  "\u1F74": "\u03B7\u0300",
  "\u03AF": "\u03B9\u0301",
  "\u1F76": "\u03B9\u0300",
  "\u03CA": "\u03B9\u0308",
  "\u0390": "\u03B9\u0308\u0301",
  "\u1FD2": "\u03B9\u0308\u0300",
  "\u1FD1": "\u03B9\u0304",
  "\u1FD0": "\u03B9\u0306",
  "\u03CC": "\u03BF\u0301",
  "\u1F78": "\u03BF\u0300",
  "\u03CD": "\u03C5\u0301",
  "\u1F7A": "\u03C5\u0300",
  "\u03CB": "\u03C5\u0308",
  "\u03B0": "\u03C5\u0308\u0301",
  "\u1FE2": "\u03C5\u0308\u0300",
  "\u1FE1": "\u03C5\u0304",
  "\u1FE0": "\u03C5\u0306",
  "\u03CE": "\u03C9\u0301",
  "\u1F7C": "\u03C9\u0300",
  "\u038E": "\u03A5\u0301",
  "\u1FEA": "\u03A5\u0300",
  "\u03AB": "\u03A5\u0308",
  "\u1FE9": "\u03A5\u0304",
  "\u1FE8": "\u03A5\u0306",
  "\u038F": "\u03A9\u0301",
  "\u1FFA": "\u03A9\u0300"
};
var Parser = class _Parser {
  constructor(input, settings) {
    this.mode = void 0;
    this.gullet = void 0;
    this.settings = void 0;
    this.leftrightDepth = void 0;
    this.nextToken = void 0;
    this.mode = "math";
    this.gullet = new MacroExpander(input, settings, this.mode);
    this.settings = settings;
    this.leftrightDepth = 0;
  }
  /**
   * Checks a result to make sure it has the right type, and throws an
   * appropriate error otherwise.
   */
  expect(text2, consume) {
    if (consume === void 0) {
      consume = true;
    }
    if (this.fetch().text !== text2) {
      throw new ParseError("Expected '" + text2 + "', got '" + this.fetch().text + "'", this.fetch());
    }
    if (consume) {
      this.consume();
    }
  }
  /**
   * Discards the current lookahead token, considering it consumed.
   */
  consume() {
    this.nextToken = null;
  }
  /**
   * Return the current lookahead token, or if there isn't one (at the
   * beginning, or if the previous lookahead token was consume()d),
   * fetch the next token as the new lookahead token and return it.
   */
  fetch() {
    if (this.nextToken == null) {
      this.nextToken = this.gullet.expandNextToken();
    }
    return this.nextToken;
  }
  /**
   * Switches between "text" and "math" modes.
   */
  switchMode(newMode) {
    this.mode = newMode;
    this.gullet.switchMode(newMode);
  }
  /**
   * Main parsing function, which parses an entire input.
   */
  parse() {
    if (!this.settings.globalGroup) {
      this.gullet.beginGroup();
    }
    if (this.settings.colorIsTextColor) {
      this.gullet.macros.set("\\color", "\\textcolor");
    }
    try {
      var parse = this.parseExpression(false);
      this.expect("EOF");
      if (!this.settings.globalGroup) {
        this.gullet.endGroup();
      }
      return parse;
    } finally {
      this.gullet.endGroups();
    }
  }
  /**
   * Fully parse a separate sequence of tokens as a separate job.
   * Tokens should be specified in reverse order, as in a MacroDefinition.
   */
  subparse(tokens) {
    var oldToken = this.nextToken;
    this.consume();
    this.gullet.pushToken(new Token("}"));
    this.gullet.pushTokens(tokens);
    var parse = this.parseExpression(false);
    this.expect("}");
    this.nextToken = oldToken;
    return parse;
  }
  /**
   * Parses an "expression", which is a list of atoms.
   *
   * `breakOnInfix`: Should the parsing stop when we hit infix nodes? This
   *                 happens when functions have higher precedence han infix
   *                 nodes in implicit parses.
   *
   * `breakOnTokenText`: The text of the token that the expression should end
   *                     with, or `null` if something else should end the
   *                     expression.
   */
  parseExpression(breakOnInfix, breakOnTokenText) {
    var body = [];
    while (true) {
      if (this.mode === "math") {
        this.consumeSpaces();
      }
      var lex = this.fetch();
      if (_Parser.endOfExpression.indexOf(lex.text) !== -1) {
        break;
      }
      if (breakOnTokenText && lex.text === breakOnTokenText) {
        break;
      }
      if (breakOnInfix && functions[lex.text] && functions[lex.text].infix) {
        break;
      }
      var atom = this.parseAtom(breakOnTokenText);
      if (!atom) {
        break;
      } else if (atom.type === "internal") {
        continue;
      }
      body.push(atom);
    }
    if (this.mode === "text") {
      this.formLigatures(body);
    }
    return this.handleInfixNodes(body);
  }
  /**
   * Rewrites infix operators such as \over with corresponding commands such
   * as \frac.
   *
   * There can only be one infix operator per group.  If there's more than one
   * then the expression is ambiguous.  This can be resolved by adding {}.
   */
  handleInfixNodes(body) {
    var overIndex = -1;
    var funcName;
    for (var i2 = 0; i2 < body.length; i2++) {
      if (body[i2].type === "infix") {
        if (overIndex !== -1) {
          throw new ParseError("only one infix operator per group", body[i2].token);
        }
        overIndex = i2;
        funcName = body[i2].replaceWith;
      }
    }
    if (overIndex !== -1 && funcName) {
      var numerNode;
      var denomNode;
      var numerBody = body.slice(0, overIndex);
      var denomBody = body.slice(overIndex + 1);
      if (numerBody.length === 1 && numerBody[0].type === "ordgroup") {
        numerNode = numerBody[0];
      } else {
        numerNode = {
          type: "ordgroup",
          mode: this.mode,
          body: numerBody
        };
      }
      if (denomBody.length === 1 && denomBody[0].type === "ordgroup") {
        denomNode = denomBody[0];
      } else {
        denomNode = {
          type: "ordgroup",
          mode: this.mode,
          body: denomBody
        };
      }
      var node;
      if (funcName === "\\\\abovefrac") {
        node = this.callFunction(funcName, [numerNode, body[overIndex], denomNode], []);
      } else {
        node = this.callFunction(funcName, [numerNode, denomNode], []);
      }
      return [node];
    } else {
      return body;
    }
  }
  /**
   * Handle a subscript or superscript with nice errors.
   */
  handleSupSubscript(name) {
    var symbolToken = this.fetch();
    var symbol = symbolToken.text;
    this.consume();
    this.consumeSpaces();
    var group;
    do {
      var _group;
      group = this.parseGroup(name);
    } while (((_group = group) == null ? void 0 : _group.type) === "internal");
    if (!group) {
      throw new ParseError("Expected group after '" + symbol + "'", symbolToken);
    }
    return group;
  }
  /**
   * Converts the textual input of an unsupported command into a text node
   * contained within a color node whose color is determined by errorColor
   */
  formatUnsupportedCmd(text2) {
    var textordArray = [];
    for (var i2 = 0; i2 < text2.length; i2++) {
      textordArray.push({
        type: "textord",
        mode: "text",
        text: text2[i2]
      });
    }
    var textNode = {
      type: "text",
      mode: this.mode,
      body: textordArray
    };
    var colorNode = {
      type: "color",
      mode: this.mode,
      color: this.settings.errorColor,
      body: [textNode]
    };
    return colorNode;
  }
  /**
   * Parses a group with optional super/subscripts.
   */
  parseAtom(breakOnTokenText) {
    var base = this.parseGroup("atom", breakOnTokenText);
    if ((base == null ? void 0 : base.type) === "internal") {
      return base;
    }
    if (this.mode === "text") {
      return base;
    }
    var superscript;
    var subscript;
    while (true) {
      this.consumeSpaces();
      var lex = this.fetch();
      if (lex.text === "\\limits" || lex.text === "\\nolimits") {
        if (base && base.type === "op") {
          var limits = lex.text === "\\limits";
          base.limits = limits;
          base.alwaysHandleSupSub = true;
        } else if (base && base.type === "operatorname") {
          if (base.alwaysHandleSupSub) {
            base.limits = lex.text === "\\limits";
          }
        } else {
          throw new ParseError("Limit controls must follow a math operator", lex);
        }
        this.consume();
      } else if (lex.text === "^") {
        if (superscript) {
          throw new ParseError("Double superscript", lex);
        }
        superscript = this.handleSupSubscript("superscript");
      } else if (lex.text === "_") {
        if (subscript) {
          throw new ParseError("Double subscript", lex);
        }
        subscript = this.handleSupSubscript("subscript");
      } else if (lex.text === "'") {
        if (superscript) {
          throw new ParseError("Double superscript", lex);
        }
        var prime = {
          type: "textord",
          mode: this.mode,
          text: "\\prime"
        };
        var primes = [prime];
        this.consume();
        while (this.fetch().text === "'") {
          primes.push(prime);
          this.consume();
        }
        if (this.fetch().text === "^") {
          primes.push(this.handleSupSubscript("superscript"));
        }
        superscript = {
          type: "ordgroup",
          mode: this.mode,
          body: primes
        };
      } else if (uSubsAndSups[lex.text]) {
        var isSub = unicodeSubRegEx.test(lex.text);
        var subsupTokens = [];
        subsupTokens.push(new Token(uSubsAndSups[lex.text]));
        this.consume();
        while (true) {
          var token = this.fetch().text;
          if (!uSubsAndSups[token]) {
            break;
          }
          if (unicodeSubRegEx.test(token) !== isSub) {
            break;
          }
          subsupTokens.unshift(new Token(uSubsAndSups[token]));
          this.consume();
        }
        var body = this.subparse(subsupTokens);
        if (isSub) {
          subscript = {
            type: "ordgroup",
            mode: "math",
            body
          };
        } else {
          superscript = {
            type: "ordgroup",
            mode: "math",
            body
          };
        }
      } else {
        break;
      }
    }
    if (superscript || subscript) {
      return {
        type: "supsub",
        mode: this.mode,
        base,
        sup: superscript,
        sub: subscript
      };
    } else {
      return base;
    }
  }
  /**
   * Parses an entire function, including its base and all of its arguments.
   */
  parseFunction(breakOnTokenText, name) {
    var token = this.fetch();
    var func = token.text;
    var funcData = functions[func];
    if (!funcData) {
      return null;
    }
    this.consume();
    if (name && name !== "atom" && !funcData.allowedInArgument) {
      throw new ParseError("Got function '" + func + "' with no arguments" + (name ? " as " + name : ""), token);
    } else if (this.mode === "text" && !funcData.allowedInText) {
      throw new ParseError("Can't use function '" + func + "' in text mode", token);
    } else if (this.mode === "math" && funcData.allowedInMath === false) {
      throw new ParseError("Can't use function '" + func + "' in math mode", token);
    }
    var {
      args,
      optArgs
    } = this.parseArguments(func, funcData);
    return this.callFunction(func, args, optArgs, token, breakOnTokenText);
  }
  /**
   * Call a function handler with a suitable context and arguments.
   */
  callFunction(name, args, optArgs, token, breakOnTokenText) {
    var context = {
      funcName: name,
      parser: this,
      token,
      breakOnTokenText
    };
    var func = functions[name];
    if (func && func.handler) {
      return func.handler(context, args, optArgs);
    } else {
      throw new ParseError("No function handler for " + name);
    }
  }
  /**
   * Parses the arguments of a function or environment
   */
  parseArguments(func, funcData) {
    var totalArgs = funcData.numArgs + funcData.numOptionalArgs;
    if (totalArgs === 0) {
      return {
        args: [],
        optArgs: []
      };
    }
    var args = [];
    var optArgs = [];
    for (var i2 = 0; i2 < totalArgs; i2++) {
      var argType = funcData.argTypes && funcData.argTypes[i2];
      var isOptional = i2 < funcData.numOptionalArgs;
      if (funcData.primitive && argType == null || // \sqrt expands into primitive if optional argument doesn't exist
      funcData.type === "sqrt" && i2 === 1 && optArgs[0] == null) {
        argType = "primitive";
      }
      var arg = this.parseGroupOfType("argument to '" + func + "'", argType, isOptional);
      if (isOptional) {
        optArgs.push(arg);
      } else if (arg != null) {
        args.push(arg);
      } else {
        throw new ParseError("Null argument, please report this as a bug");
      }
    }
    return {
      args,
      optArgs
    };
  }
  /**
   * Parses a group when the mode is changing.
   */
  parseGroupOfType(name, type, optional) {
    switch (type) {
      case "color":
        return this.parseColorGroup(optional);
      case "size":
        return this.parseSizeGroup(optional);
      case "url":
        return this.parseUrlGroup(optional);
      case "math":
      case "text":
        return this.parseArgumentGroup(optional, type);
      case "hbox": {
        var group = this.parseArgumentGroup(optional, "text");
        return group != null ? {
          type: "styling",
          mode: group.mode,
          body: [group],
          style: "text"
          // simulate \textstyle
        } : null;
      }
      case "raw": {
        var token = this.parseStringGroup("raw", optional);
        return token != null ? {
          type: "raw",
          mode: "text",
          string: token.text
        } : null;
      }
      case "primitive": {
        if (optional) {
          throw new ParseError("A primitive argument cannot be optional");
        }
        var _group2 = this.parseGroup(name);
        if (_group2 == null) {
          throw new ParseError("Expected group as " + name, this.fetch());
        }
        return _group2;
      }
      case "original":
      case null:
      case void 0:
        return this.parseArgumentGroup(optional);
      default:
        throw new ParseError("Unknown group type as " + name, this.fetch());
    }
  }
  /**
   * Discard any space tokens, fetching the next non-space token.
   */
  consumeSpaces() {
    while (this.fetch().text === " ") {
      this.consume();
    }
  }
  /**
   * Parses a group, essentially returning the string formed by the
   * brace-enclosed tokens plus some position information.
   */
  parseStringGroup(modeName, optional) {
    var argToken = this.gullet.scanArgument(optional);
    if (argToken == null) {
      return null;
    }
    var str = "";
    var nextToken;
    while ((nextToken = this.fetch()).text !== "EOF") {
      str += nextToken.text;
      this.consume();
    }
    this.consume();
    argToken.text = str;
    return argToken;
  }
  /**
   * Parses a regex-delimited group: the largest sequence of tokens
   * whose concatenated strings match `regex`. Returns the string
   * formed by the tokens plus some position information.
   */
  parseRegexGroup(regex, modeName) {
    var firstToken = this.fetch();
    var lastToken = firstToken;
    var str = "";
    var nextToken;
    while ((nextToken = this.fetch()).text !== "EOF" && regex.test(str + nextToken.text)) {
      lastToken = nextToken;
      str += lastToken.text;
      this.consume();
    }
    if (str === "") {
      throw new ParseError("Invalid " + modeName + ": '" + firstToken.text + "'", firstToken);
    }
    return firstToken.range(lastToken, str);
  }
  /**
   * Parses a color description.
   */
  parseColorGroup(optional) {
    var res = this.parseStringGroup("color", optional);
    if (res == null) {
      return null;
    }
    var match = /^(#[a-f0-9]{3}|#?[a-f0-9]{6}|[a-z]+)$/i.exec(res.text);
    if (!match) {
      throw new ParseError("Invalid color: '" + res.text + "'", res);
    }
    var color = match[0];
    if (/^[0-9a-f]{6}$/i.test(color)) {
      color = "#" + color;
    }
    return {
      type: "color-token",
      mode: this.mode,
      color
    };
  }
  /**
   * Parses a size specification, consisting of magnitude and unit.
   */
  parseSizeGroup(optional) {
    var res;
    var isBlank = false;
    this.gullet.consumeSpaces();
    if (!optional && this.gullet.future().text !== "{") {
      res = this.parseRegexGroup(/^[-+]? *(?:$|\d+|\d+\.\d*|\.\d*) *[a-z]{0,2} *$/, "size");
    } else {
      res = this.parseStringGroup("size", optional);
    }
    if (!res) {
      return null;
    }
    if (!optional && res.text.length === 0) {
      res.text = "0pt";
      isBlank = true;
    }
    var match = /([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/.exec(res.text);
    if (!match) {
      throw new ParseError("Invalid size: '" + res.text + "'", res);
    }
    var data = {
      number: +(match[1] + match[2]),
      // sign + magnitude, cast to number
      unit: match[3]
    };
    if (!validUnit(data)) {
      throw new ParseError("Invalid unit: '" + data.unit + "'", res);
    }
    return {
      type: "size",
      mode: this.mode,
      value: data,
      isBlank
    };
  }
  /**
   * Parses an URL, checking escaped letters and allowed protocols,
   * and setting the catcode of % as an active character (as in \hyperref).
   */
  parseUrlGroup(optional) {
    this.gullet.lexer.setCatcode("%", 13);
    this.gullet.lexer.setCatcode("~", 12);
    var res = this.parseStringGroup("url", optional);
    this.gullet.lexer.setCatcode("%", 14);
    this.gullet.lexer.setCatcode("~", 13);
    if (res == null) {
      return null;
    }
    var url = res.text.replace(/\\([#$%&~_^{}])/g, "$1");
    return {
      type: "url",
      mode: this.mode,
      url
    };
  }
  /**
   * Parses an argument with the mode specified.
   */
  parseArgumentGroup(optional, mode) {
    var argToken = this.gullet.scanArgument(optional);
    if (argToken == null) {
      return null;
    }
    var outerMode = this.mode;
    if (mode) {
      this.switchMode(mode);
    }
    this.gullet.beginGroup();
    var expression = this.parseExpression(false, "EOF");
    this.expect("EOF");
    this.gullet.endGroup();
    var result = {
      type: "ordgroup",
      mode: this.mode,
      loc: argToken.loc,
      body: expression
    };
    if (mode) {
      this.switchMode(outerMode);
    }
    return result;
  }
  /**
   * Parses an ordinary group, which is either a single nucleus (like "x")
   * or an expression in braces (like "{x+y}") or an implicit group, a group
   * that starts at the current position, and ends right before a higher explicit
   * group ends, or at EOF.
   */
  parseGroup(name, breakOnTokenText) {
    var firstToken = this.fetch();
    var text2 = firstToken.text;
    var result;
    if (text2 === "{" || text2 === "\\begingroup") {
      this.consume();
      var groupEnd = text2 === "{" ? "}" : "\\endgroup";
      this.gullet.beginGroup();
      var expression = this.parseExpression(false, groupEnd);
      var lastToken = this.fetch();
      this.expect(groupEnd);
      this.gullet.endGroup();
      result = {
        type: "ordgroup",
        mode: this.mode,
        loc: SourceLocation.range(firstToken, lastToken),
        body: expression,
        // A group formed by \begingroup...\endgroup is a semi-simple group
        // which doesn't affect spacing in math mode, i.e., is transparent.
        // https://tex.stackexchange.com/questions/1930/when-should-one-
        // use-begingroup-instead-of-bgroup
        semisimple: text2 === "\\begingroup" || void 0
      };
    } else {
      result = this.parseFunction(breakOnTokenText, name) || this.parseSymbol();
      if (result == null && text2[0] === "\\" && !implicitCommands.hasOwnProperty(text2)) {
        if (this.settings.throwOnError) {
          throw new ParseError("Undefined control sequence: " + text2, firstToken);
        }
        result = this.formatUnsupportedCmd(text2);
        this.consume();
      }
    }
    return result;
  }
  /**
   * Form ligature-like combinations of characters for text mode.
   * This includes inputs like "--", "---", "``" and "''".
   * The result will simply replace multiple textord nodes with a single
   * character in each value by a single textord node having multiple
   * characters in its value.  The representation is still ASCII source.
   * The group will be modified in place.
   */
  formLigatures(group) {
    var n = group.length - 1;
    for (var i2 = 0; i2 < n; ++i2) {
      var a = group[i2];
      var v = a.text;
      if (v === "-" && group[i2 + 1].text === "-") {
        if (i2 + 1 < n && group[i2 + 2].text === "-") {
          group.splice(i2, 3, {
            type: "textord",
            mode: "text",
            loc: SourceLocation.range(a, group[i2 + 2]),
            text: "---"
          });
          n -= 2;
        } else {
          group.splice(i2, 2, {
            type: "textord",
            mode: "text",
            loc: SourceLocation.range(a, group[i2 + 1]),
            text: "--"
          });
          n -= 1;
        }
      }
      if ((v === "'" || v === "`") && group[i2 + 1].text === v) {
        group.splice(i2, 2, {
          type: "textord",
          mode: "text",
          loc: SourceLocation.range(a, group[i2 + 1]),
          text: v + v
        });
        n -= 1;
      }
    }
  }
  /**
   * Parse a single symbol out of the string. Here, we handle single character
   * symbols and special functions like \verb.
   */
  parseSymbol() {
    var nucleus = this.fetch();
    var text2 = nucleus.text;
    if (/^\\verb[^a-zA-Z]/.test(text2)) {
      this.consume();
      var arg = text2.slice(5);
      var star = arg.charAt(0) === "*";
      if (star) {
        arg = arg.slice(1);
      }
      if (arg.length < 2 || arg.charAt(0) !== arg.slice(-1)) {
        throw new ParseError("\\verb assertion failed --\n                    please report what input caused this bug");
      }
      arg = arg.slice(1, -1);
      return {
        type: "verb",
        mode: "text",
        body: arg,
        star
      };
    }
    if (unicodeSymbols.hasOwnProperty(text2[0]) && !symbols[this.mode][text2[0]]) {
      if (this.settings.strict && this.mode === "math") {
        this.settings.reportNonstrict("unicodeTextInMathMode", 'Accented Unicode text character "' + text2[0] + '" used in math mode', nucleus);
      }
      text2 = unicodeSymbols[text2[0]] + text2.slice(1);
    }
    var match = combiningDiacriticalMarksEndRegex.exec(text2);
    if (match) {
      text2 = text2.substring(0, match.index);
      if (text2 === "i") {
        text2 = "\u0131";
      } else if (text2 === "j") {
        text2 = "\u0237";
      }
    }
    var symbol;
    if (symbols[this.mode][text2]) {
      if (this.settings.strict && this.mode === "math" && extraLatin.indexOf(text2) >= 0) {
        this.settings.reportNonstrict("unicodeTextInMathMode", 'Latin-1/Unicode text character "' + text2[0] + '" used in math mode', nucleus);
      }
      var group = symbols[this.mode][text2].group;
      var loc = SourceLocation.range(nucleus);
      var s;
      if (ATOMS.hasOwnProperty(group)) {
        var family = group;
        s = {
          type: "atom",
          mode: this.mode,
          family,
          loc,
          text: text2
        };
      } else {
        s = {
          type: group,
          mode: this.mode,
          loc,
          text: text2
        };
      }
      symbol = s;
    } else if (text2.charCodeAt(0) >= 128) {
      if (this.settings.strict) {
        if (!supportedCodepoint(text2.charCodeAt(0))) {
          this.settings.reportNonstrict("unknownSymbol", 'Unrecognized Unicode character "' + text2[0] + '"' + (" (" + text2.charCodeAt(0) + ")"), nucleus);
        } else if (this.mode === "math") {
          this.settings.reportNonstrict("unicodeTextInMathMode", 'Unicode text character "' + text2[0] + '" used in math mode', nucleus);
        }
      }
      symbol = {
        type: "textord",
        mode: "text",
        loc: SourceLocation.range(nucleus),
        text: text2
      };
    } else {
      return null;
    }
    this.consume();
    if (match) {
      for (var i2 = 0; i2 < match[0].length; i2++) {
        var accent2 = match[0][i2];
        if (!unicodeAccents[accent2]) {
          throw new ParseError("Unknown accent ' " + accent2 + "'", nucleus);
        }
        var command = unicodeAccents[accent2][this.mode] || unicodeAccents[accent2].text;
        if (!command) {
          throw new ParseError("Accent " + accent2 + " unsupported in " + this.mode + " mode", nucleus);
        }
        symbol = {
          type: "accent",
          mode: this.mode,
          loc: SourceLocation.range(nucleus),
          label: command,
          isStretchy: false,
          isShifty: true,
          // $FlowFixMe
          base: symbol
        };
      }
    }
    return symbol;
  }
};
Parser.endOfExpression = ["}", "\\endgroup", "\\end", "\\right", "&"];
var parseTree = function parseTree2(toParse, settings) {
  if (!(typeof toParse === "string" || toParse instanceof String)) {
    throw new TypeError("KaTeX can only parse string typed expression");
  }
  var parser = new Parser(toParse, settings);
  delete parser.gullet.macros.current["\\df@tag"];
  var tree = parser.parse();
  delete parser.gullet.macros.current["\\current@color"];
  delete parser.gullet.macros.current["\\color"];
  if (parser.gullet.macros.get("\\df@tag")) {
    if (!settings.displayMode) {
      throw new ParseError("\\tag works only in display equations");
    }
    tree = [{
      type: "tag",
      mode: "text",
      body: tree,
      tag: parser.subparse([new Token("\\df@tag")])
    }];
  }
  return tree;
};
var render = function render2(expression, baseNode, options) {
  baseNode.textContent = "";
  var node = renderToDomTree(expression, options).toNode();
  baseNode.appendChild(node);
};
if (typeof document !== "undefined") {
  if (document.compatMode !== "CSS1Compat") {
    typeof console !== "undefined" && console.warn("Warning: KaTeX doesn't work in quirks mode. Make sure your website has a suitable doctype.");
    render = function render3() {
      throw new ParseError("KaTeX doesn't work in quirks mode.");
    };
  }
}
var renderToString = function renderToString2(expression, options) {
  var markup = renderToDomTree(expression, options).toMarkup();
  return markup;
};
var renderError = function renderError2(error, expression, options) {
  if (options.throwOnError || !(error instanceof ParseError)) {
    throw error;
  }
  var node = buildCommon.makeSpan(["katex-error"], [new SymbolNode(expression)]);
  node.setAttribute("title", error.toString());
  node.setAttribute("style", "color:" + options.errorColor);
  return node;
};
var renderToDomTree = function renderToDomTree2(expression, options) {
  var settings = new Settings(options);
  try {
    var tree = parseTree(expression, settings);
    return buildTree(tree, expression, settings);
  } catch (error) {
    return renderError(error, expression, settings);
  }
};

// src/documentation_view.ts
function escapeHtml3(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeHref(rawHref) {
  const href = rawHref.trim();
  return /^(?:https?:\/\/|mailto:|\/|#)/i.test(href) ? href : "#";
}
function renderMath(source, displayMode) {
  const formula = source.trim();
  if (!formula) return "";
  try {
    return renderToString(formula, {
      displayMode,
      output: "htmlAndMathml",
      strict: "ignore",
      throwOnError: true,
      trust: false
    });
  } catch {
    return `<span class="documentation-math-error" title="\u516C\u5F0F\u8BED\u6CD5\u65E0\u6CD5\u89E3\u6790">${escapeHtml3(formula)}</span>`;
  }
}
function renderInline(source) {
  const tokens = [];
  const withCode = source.replace(/`([^`]+)`/g, (_match, code) => {
    const index = tokens.push(`<code>${escapeHtml3(code)}</code>`) - 1;
    return `\0${index}\0`;
  });
  const tokenized = withCode.replace(/\\\((.+?)\\\)/g, (_match, formula) => {
    const index = tokens.push(renderMath(formula, false)) - 1;
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
function headingId(text2, counts) {
  const base = text2.replace(/[`*_~]/g, "").trim().toLocaleLowerCase("zh-CN").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
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
  return /^#{1,3}\s+/.test(line) || /^\s*\\\[/.test(line) || /^```/.test(line) || /^>\s?/.test(line) || /^\s*(?:[-+*]|\d+\.)\s+/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line) || line.includes("|") && isTableSeparator(lines[index + 1] || "");
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
      const text2 = heading[2].replace(/\s+#+\s*$/, "").trim();
      const id = headingId(text2, headingCounts);
      if (level > 1) headings.push({ id, level, text: text2 });
      html.push(`<h${level} id="${escapeHtml3(id)}">${renderInline(text2)}</h${level}>`);
      index += 1;
      continue;
    }
    const blockMath = /^\s*\\\[(.*)$/.exec(line);
    if (blockMath) {
      const formulaLines = [];
      let remainder = blockMath[1];
      const closesOnFirstLine = /\\\]\s*$/.test(remainder);
      if (closesOnFirstLine) {
        formulaLines.push(remainder.replace(/\\\]\s*$/, ""));
        index += 1;
      } else {
        if (remainder.trim()) formulaLines.push(remainder);
        index += 1;
        while (index < lines.length && !/\\\]\s*$/.test(lines[index])) {
          formulaLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          const closingLine = lines[index].replace(/\\\]\s*$/, "");
          if (closingLine.trim()) formulaLines.push(closingLine);
          index += 1;
        }
      }
      html.push(`<div class="documentation-math-block">${renderMath(formulaLines.join("\n"), true)}</div>`);
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
    loadPort,
    cjobCycle: 1,
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
    const loadPort = (loadPorts.includes(String(legacyLoadPort)) ? String(legacyLoadPort) : "") || automaticLoadPort(loadPorts, firstTaskId + cjobIndex) || String(legacyLoadPort);
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
      cjobCycle: Math.max(
        1,
        Math.min(1e3, Math.trunc(Number(
          cjob.cjobCycle ?? cjob.CJobCycle ?? cjob.jobCycle ?? cjob.JobCycle ?? 1
        ) || 1))
      ),
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
var { VISIT_SHARED_FIELDS: VISIT_SHARED_FIELDS2, automaticTemplateName: automaticTemplateName2, selectReferencedRoutes: selectReferencedRoutes2 } = route_editor_logic_exports;
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
var STATION_ACTION_TIME_FIELDS = [
  { key: "PickPrepareTime", label: "\u53D6\u7247\u51C6\u5907" },
  { key: "PickCompleteTime", label: "\u53D6\u7247\u5B8C\u6210" },
  { key: "PlacePrepareTime", label: "\u653E\u7247\u51C6\u5907" },
  { key: "PlaceCompleteTime", label: "\u653E\u7247\u5B8C\u6210" },
  { key: "PostCompleteTime", label: "\u52A8\u4F5C\u540E\u5904\u7406" }
];
var ROBOT_ACTION_TIME_FIELDS = [
  { key: "PickTime", label: "\u53D6\u7247" },
  { key: "PlaceTime", label: "\u653E\u7247" }
];
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
  deviceConfigSection: "station-time",
  deviceStationName: "",
  deviceRobotName: "",
  deviceRobotTransferSources: {},
  deviceTimingDraft: null,
  deviceTimingDirty: false,
  deviceTimingSaving: false,
  deviceTimingStatusMessage: "\u9009\u62E9\u8BBE\u5907\u540E\u5F00\u59CB\u914D\u7F6E",
  strategy: "heuristic",
  availableAlgorithms: [],
  algorithmMetadata: {},
  roundCount: 2,
  times: [0, 70],
  options: { ...DEFAULT_SCHEDULE_OPTIONS },
  cleans: [],
  routes: [{ name: "RouteA", group: "RouteA", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps([makeStage("LP1"), makeStage("Robot"), makeStage("PM1,PM2", true, "RouteA_Step2"), makeStage("Robot"), makeStage("LP1")]) }],
  rounds: [makeRound(1, 0, "RouteA", "LP1"), makeRound(2, 70, "RouteA", "LP2")],
  testRouteConfigs: {},
  routeDirty: false,
  routeGroupingProfiles: /* @__PURE__ */ new Map(),
  routeEditingIndex: -1,
  routeEditSnapshot: null,
  routeEditGroupingProfile: null,
  routeEditIsNew: false,
  drawer: null,
  cleanDialogContext: null,
  expandedRouteProcessGroups: /* @__PURE__ */ new Set(),
  expandedRouteGroups: /* @__PURE__ */ new Set(),
  expandedRoutes: /* @__PURE__ */ new Set(),
  routeNameChanges: /* @__PURE__ */ new Map(),
  routeProcessFilter: "",
  routeParallelFilter: ""
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
var singleRunActive = false;
var singleRunCancelling = false;
var activeSingleRunId = "";
var singleRunAbortController = null;
var runStatusStartedAt = 0;
var runStatusElapsedMs = 0;
var runStatusTimer = 0;
var pendingAlphaGoCheckpointFile = null;
var dataTransferMode = "import";
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
  const text2 = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text2}s`;
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
  Object.values(state.testRouteConfigs).forEach((config) => {
    ROUTE_CLEAN_KEYS.forEach((key) => {
      config[key] = rename(config[key]);
    });
    Object.values(config.stages || {}).forEach((stage) => {
      stage.beforeCleanRefs = rename(stage.beforeCleanRefs);
      stage.afterCleanRefs = rename(stage.afterCleanRefs);
    });
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
function isFixedRouteStep(route, index) {
  const stages = route?.stages || [];
  return index === 0 || index === stages.length - 1;
}
function stepKind(route, index) {
  if (!route?.stages?.length) return "Station";
  if (index === 0) return "Src";
  if (index === route.stages.length - 1) return "Sink";
  return stageUsesRobot(route.stages[index], index) ? "Robot" : "Station";
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
function setStageCandidates(routeIndex, stageIndex, names) {
  const route = state.routes[routeIndex], stage = route.stages[stageIndex];
  replaceCandidates(stage, names, makeVisit, normalizeVisit);
  normalizeRoute(route);
}
function stageDefaultConfig(stage) {
  const first = (stage?.visits || [])[0] ? normalizeVisit(stage.visits[0]) : makeVisit("");
  return {
    processTime: Number(first.processTime),
    recipeTime: Number(first.recipeTime ?? first.processTime),
    qTimeLimit: Number(first.qTimeLimit),
    residencyConstraint: Number(first.residencyConstraint),
    beforeCleanRefs: structuredClone(stringList(first.beforeCleanRefs)),
    afterCleanRefs: structuredClone(stringList(first.afterCleanRefs)),
    processRecipe: String(first.processRecipe || ""),
    processType: String(first.processType || ""),
    weight: structuredClone(first.weight ?? {}),
    moveTimeOffset: structuredClone(first.moveTimeOffset ?? {}),
    slotIds: String(first.slotIds || "1")
  };
}
function defaultRouteConfigForRoute(route) {
  normalizeRoute(route);
  return {
    bufferOption: Math.max(0, Math.min(4, Math.trunc(Number(route.bufferOption) || 0))),
    prePJobCleanRefs: structuredClone(stringList(route.prePJobCleanRefs)),
    postPJobCleanRefs: structuredClone(stringList(route.postPJobCleanRefs)),
    postCJobCleanRefs: structuredClone(stringList(route.postCJobCleanRefs)),
    stages: Object.fromEntries((route.stages || []).map((stage) => [
      String(stage.stepId),
      stageDefaultConfig(stage)
    ]))
  };
}
function normalizeTestRouteConfigs(raw, routes) {
  const configs = raw && typeof raw === "object" && !Array.isArray(raw) ? structuredClone(raw) : {};
  const normalized = {};
  for (const route of routes || []) {
    const routeName = String(route.name || "").trim();
    if (!routeName) continue;
    const base = configs[routeName] || defaultRouteConfigForRoute(route);
    const stages = {};
    (route.stages || []).forEach((stage) => {
      const stepId = String(stage.stepId);
      const override = base.stages?.[stepId] ? base.stages[stepId] : stageDefaultConfig(stage);
      stages[stepId] = {
        ...stageDefaultConfig(stage),
        ...override && typeof override === "object" ? override : {},
        processTime: Number(override?.processTime ?? stageDefaultConfig(stage).processTime),
        recipeTime: Number(override?.processTime ?? stageDefaultConfig(stage).recipeTime),
        qTimeLimit: Number(override?.qTimeLimit ?? stageDefaultConfig(stage).qTimeLimit),
        residencyConstraint: Number(override?.residencyConstraint ?? stageDefaultConfig(stage).residencyConstraint),
        beforeCleanRefs: stringList(override?.beforeCleanRefs ?? stageDefaultConfig(stage).beforeCleanRefs),
        afterCleanRefs: stringList(override?.afterCleanRefs ?? stageDefaultConfig(stage).afterCleanRefs),
        processRecipe: String(override?.processRecipe ?? stageDefaultConfig(stage).processRecipe),
        processType: String(override?.processType ?? stageDefaultConfig(stage).processType),
        weight: structuredClone(override?.weight ?? stageDefaultConfig(stage).weight),
        moveTimeOffset: structuredClone(override?.moveTimeOffset ?? stageDefaultConfig(stage).moveTimeOffset),
        slotIds: String(override?.slotIds ?? stageDefaultConfig(stage).slotIds)
      };
    });
    normalized[routeName] = {
      bufferOption: Math.max(0, Math.min(4, Math.trunc(Number(base.bufferOption) || 0))),
      prePJobCleanRefs: stringList(base.prePJobCleanRefs),
      postPJobCleanRefs: stringList(base.postPJobCleanRefs),
      postCJobCleanRefs: stringList(base.postCJobCleanRefs),
      stages
    };
  }
  return normalized;
}
function runtimeRouteForTemplate(route) {
  const routeName = String(route?.name || "").trim();
  const config = state.testRouteConfigs[routeName] || defaultRouteConfigForRoute(route);
  const merged = structuredClone(route);
  normalizeRoute(merged);
  merged.bufferOption = Number(config.bufferOption ?? merged.bufferOption ?? 0);
  merged.prePJobCleanRefs = stringList(config.prePJobCleanRefs);
  merged.postPJobCleanRefs = stringList(config.postPJobCleanRefs);
  merged.postCJobCleanRefs = stringList(config.postCJobCleanRefs);
  (merged.stages || []).forEach((stage) => {
    const stepId = String(stage.stepId);
    const override = config.stages?.[stepId];
    if (!override) return;
    (stage.visits || []).forEach((visit) => {
      visit.processTime = Number(override.processTime ?? visit.processTime ?? 20);
      visit.recipeTime = Number(override.recipeTime ?? visit.processTime ?? 20);
      visit.qTimeLimit = Number(override.qTimeLimit ?? visit.qTimeLimit ?? -1);
      visit.residencyConstraint = Number(override.residencyConstraint ?? visit.residencyConstraint ?? -1);
      visit.beforeCleanRefs = stringList(override.beforeCleanRefs ?? visit.beforeCleanRefs);
      visit.afterCleanRefs = stringList(override.afterCleanRefs ?? visit.afterCleanRefs);
      visit.processRecipe = String(override.processRecipe ?? visit.processRecipe ?? "");
      visit.processType = String(override.processType ?? visit.processType ?? "");
      visit.weight = structuredClone(override.weight ?? visit.weight ?? {});
      visit.moveTimeOffset = structuredClone(override.moveTimeOffset ?? visit.moveTimeOffset ?? {});
      visit.slotIds = String(override.slotIds ?? visit.slotIds ?? "1");
    });
    normalizeVisit(stage.visits[0]);
    synchronizeVisits(stage, normalizeVisit);
  });
  return merged;
}
function runtimeRoutes() {
  return (state.routes || []).map((route) => runtimeRouteForTemplate(route));
}
function routeTemplateForSave(route) {
  const template = structuredClone(route);
  normalizeRoute(template);
  template.bufferOption = 0;
  ROUTE_CLEAN_KEYS.forEach((key) => {
    template[key] = [];
  });
  template.stages = (template.stages || []).map((stage) => ({
    stepId: Number(stage.stepId),
    postStepIds: structuredClone(stage.postStepIds || []),
    needProcess: stage.needProcess === true,
    kind: stage.kind,
    visits: (stage.visits || []).map((visit) => ({ stationName: String(visit.stationName || "") }))
  }));
  return template;
}
function captureRouteGroupingProfiles() {
  state.routeGroupingProfiles = new Map(
    state.routes.map((route) => [route, structuredClone(routeProcessProfile(route))])
  );
}
function routeGroupingProfile(route) {
  return state.routeGroupingProfiles.get(route) || routeProcessProfile(route);
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
function parseDeviceFileText(text2) {
  try {
    return JSON.parse(text2);
  } catch (originalError) {
    const records = text2.trim().replace(/,\s*$/, "");
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
function openDataTransferDialog(mode) {
  dataTransferMode = mode;
  const importing = mode === "import";
  document.getElementById("dataTransferDialogTitle").textContent = importing ? "\u5BFC\u5165\u6570\u636E" : "\u5BFC\u51FA\u6570\u636E";
  document.getElementById("dataTransferDialogDescription").textContent = importing ? "\u9009\u62E9\u5BFC\u5165\u6574\u53F0\u8BBE\u5907\uFF0C\u6216\u628A\u6D4B\u8BD5\u96C6\u52A0\u5165\u5F53\u524D\u76F8\u540C\u8BBE\u5907\u3002" : "\u8BBE\u5907\u5305\u5305\u542B\u8BBE\u5907\u4E0B\u5168\u90E8\u4FE1\u606F\uFF1B\u6D4B\u8BD5\u96C6\u5305\u53EA\u5305\u542B\u5F53\u524D\u6D4B\u8BD5\u53CA\u6240\u9700\u8DEF\u5F84\u3002";
  document.getElementById("deviceTransferOptionTitle").textContent = importing ? "\u5BFC\u5165\u8BBE\u5907" : "\u5BFC\u51FA\u5F53\u524D\u8BBE\u5907";
  document.getElementById("deviceTransferOptionDescription").textContent = importing ? "\u652F\u6301\u540C\u4E8B\u5206\u4EAB\u7684\u8BBE\u5907\u5305\uFF0C\u4E5F\u652F\u6301\u65B0\u7684 init JSON\u3002" : "\u5305\u542B init\u3001\u8DEF\u5F84\u3001\u7EC4\u522B\u548C\u8BE5\u8BBE\u5907\u4E0B\u5168\u90E8\u6D4B\u8BD5\u96C6\u3002";
  document.getElementById("testTransferOptionTitle").textContent = importing ? "\u5BFC\u5165\u6D4B\u8BD5\u96C6" : "\u5BFC\u51FA\u5F53\u524D\u6D4B\u8BD5\u96C6";
  document.getElementById("testTransferOptionDescription").textContent = importing ? "\u53EA\u80FD\u5BFC\u5165\u5230 init \u5B8C\u5168\u76F8\u540C\u7684\u5F53\u524D\u8BBE\u5907\u3002" : "\u63A5\u6536\u65B9\u5FC5\u987B\u62E5\u6709 init \u5B8C\u5168\u76F8\u540C\u7684\u8BBE\u5907\u3002";
  document.getElementById("deviceTransferOption").disabled = !importing && !state.workspaceDeviceId;
  document.getElementById("testTransferOption").disabled = !state.workspaceDeviceId || !importing && !state.testCaseId;
  const status = document.getElementById("dataTransferStatus");
  status.textContent = importing && !state.workspaceDeviceId ? "\u5C1A\u672A\u9009\u62E9\u8BBE\u5907\u65F6\uFF0C\u53EA\u80FD\u5BFC\u5165\u8BBE\u5907\u3002" : "";
  status.classList.remove("error");
  document.getElementById("dataTransferDialog").showModal();
}
async function downloadWorkspaceArchive(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "ct-data.zip";
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
async function exportWorkspaceData(kind) {
  if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907");
  if (state.dirty) await saveCurrentTest(true);
  if (state.deviceTimingDirty) await saveDeviceTiming();
  if (kind === "test" && !state.testCaseId) throw new Error("\u8BF7\u5148\u9009\u62E9\u6D4B\u8BD5\u96C6");
  const url = kind === "device" ? `/api/workspaces/${encodeURIComponent(state.workspaceDeviceId)}/export` : `/api/workspaces/${encodeURIComponent(state.workspaceDeviceId)}/tests/${encodeURIComponent(state.testCaseId)}/export`;
  await downloadWorkspaceArchive(url);
  document.getElementById("dataTransferDialog").close();
  setWorkspaceStatus(kind === "device" ? "\u5DF2\u5F00\u59CB\u5BFC\u51FA\u5F53\u524D\u8BBE\u5907" : "\u5DF2\u5F00\u59CB\u5BFC\u51FA\u5F53\u524D\u6D4B\u8BD5\u96C6", "saved");
}
async function uploadWorkspaceArchive(file, kind) {
  if (!file) return;
  if (state.dirty) await saveCurrentTest(true);
  const url = kind === "device" ? "/api/workspaces/import/device" : `/api/workspaces/${encodeURIComponent(state.workspaceDeviceId)}/import-test`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/zip", "X-Data-Filename": encodeURIComponent(file.name) },
    body: file
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) throw new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  if (kind === "device") {
    await loadWorkspaceCatalog(result.device.id);
    setWorkspaceStatus(`\u5DF2\u5BFC\u5165\u8BBE\u5907\u201C${result.device.name}\u201D\u53CA ${result.importedTests} \u4E2A\u6D4B\u8BD5\u96C6`, "saved");
  } else {
    await loadWorkspaceCatalog(state.workspaceDeviceId, result.test.id);
    setWorkspaceStatus(result.created ? `\u5DF2\u5BFC\u5165\u6D4B\u8BD5\u96C6\u201C${result.test.name}\u201D` : `\u6D4B\u8BD5\u96C6\u201C${result.test.name}\u201D\u5DF2\u5B58\u5728`, "saved");
  }
  document.getElementById("dataTransferDialog").close();
}
async function chooseDataTransfer(kind) {
  const status = document.getElementById("dataTransferStatus");
  status.textContent = "";
  status.classList.remove("error");
  try {
    if (dataTransferMode === "export") {
      await exportWorkspaceData(kind);
      return;
    }
    if (kind === "test" && !state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u6D4B\u8BD5\u96C6\u6240\u5C5E\u7684\u76F8\u540C\u8BBE\u5907");
    document.getElementById(kind === "device" ? "deviceFile" : "testExchangeFile").click();
  } catch (error) {
    status.textContent = error.message || "\u64CD\u4F5C\u5931\u8D25";
    status.classList.add("error");
  }
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
function buildDeviceTimingDraft(device) {
  const draft = { stations: {}, robots: {} };
  Object.entries(device?.Stations || {}).forEach(([stationName, station]) => {
    const timing = {};
    [...STATION_ACTION_TIME_FIELDS, { key: "AlignmentTime" }].forEach(({ key }) => {
      if (station?.[key] && typeof station[key] === "object" && !Array.isArray(station[key])) {
        timing[key] = structuredClone(station[key]);
      }
    });
    if (Array.isArray(station?.PrePrepareTime)) {
      timing.PrePrepareTime = station.PrePrepareTime.map((row) => Number(row?.Time) || 0);
    }
    draft.stations[stationName] = timing;
  });
  Object.entries(device?.Robots || {}).forEach(([robotName, robot]) => {
    const timing = {};
    ROBOT_ACTION_TIME_FIELDS.forEach(({ key }) => {
      if (robot?.[key] && typeof robot[key] === "object" && !Array.isArray(robot[key])) {
        timing[key] = structuredClone(robot[key]);
      }
    });
    if (Array.isArray(robot?.PrepTransTime)) {
      timing.PrepTransTime = robot.PrepTransTime.map((row) => Number(row?.Time) || 0);
    }
    draft.robots[robotName] = timing;
  });
  return draft;
}
function deviceTimeInput(value, label, dataset) {
  const attributes = Object.entries(dataset).map(([name, item]) => `data-${name}="${escapeHtml4(item)}"`).join(" ");
  const numericValue = Number(value);
  return `<label class="device-time-input"><input type="number" min="0" step="any" inputmode="decimal" required value="${Number.isFinite(numericValue) ? numericValue : 0}" aria-label="${escapeHtml4(label)}" ${attributes}><span>s</span></label>`;
}
function renderDeviceConfigHeader() {
  const hasDevice = Boolean(state.workspaceDeviceId && state.baseDevice);
  document.getElementById("deviceConfigSelectedName").textContent = hasDevice ? displayDeviceName(state.deviceName) : "\u5C1A\u672A\u9009\u62E9\u8BBE\u5907";
  const status = document.getElementById("deviceTimingStatus");
  status.textContent = state.deviceTimingSaving ? "\u6B63\u5728\u4FDD\u5B58\u65F6\u95F4\u53C2\u6570\u2026" : state.deviceTimingDirty ? "\u6709\u5C1A\u672A\u4FDD\u5B58\u7684\u65F6\u95F4\u4FEE\u6539" : state.deviceTimingStatusMessage;
  status.classList.toggle("is-dirty", state.deviceTimingDirty);
  status.classList.toggle("is-saving", state.deviceTimingSaving);
  document.getElementById("resetDeviceTimingButton").disabled = !hasDevice || !state.deviceTimingDirty || state.deviceTimingSaving;
  document.getElementById("saveDeviceTimingButton").disabled = !hasDevice || !state.deviceTimingDirty || state.deviceTimingSaving;
}
function renderDeviceTimingSelectors() {
  const stationSelect = document.getElementById("deviceStationSelect");
  const robotSelect = document.getElementById("deviceRobotSelect");
  if (!state.stationNames.includes(state.deviceStationName)) state.deviceStationName = state.stationNames[0] || "";
  if (!state.robotNames.includes(state.deviceRobotName)) state.deviceRobotName = state.robotNames[0] || "";
  stationSelect.innerHTML = state.stationNames.length ? state.stationNames.map((name) => `<option value="${escapeHtml4(name)}" ${name === state.deviceStationName ? "selected" : ""}>${escapeHtml4(name)}</option>`).join("") : `<option value="">\u8BF7\u5148\u9009\u62E9\u8BBE\u5907</option>`;
  robotSelect.innerHTML = state.robotNames.length ? state.robotNames.map((name) => `<option value="${escapeHtml4(name)}" ${name === state.deviceRobotName ? "selected" : ""}>${escapeHtml4(name)}</option>`).join("") : `<option value="">\u8BF7\u5148\u9009\u62E9\u8BBE\u5907</option>`;
  stationSelect.disabled = !state.stationNames.length;
  robotSelect.disabled = !state.robotNames.length;
}
function renderDeviceStationTiming() {
  const container = document.getElementById("deviceStationTimingEditor");
  const stationName = state.deviceStationName;
  const station = state.baseDevice?.Stations?.[stationName];
  const timing = state.deviceTimingDraft?.stations?.[stationName];
  if (!station || !timing) {
    container.innerHTML = `<div class="device-config-empty"><strong>\u6682\u65E0\u53EF\u914D\u7F6E\u7AD9\u70B9</strong><span>\u9009\u62E9\u6216\u5BFC\u5165\u8BBE\u5907\u540E\uFF0C\u53EF\u5728\u8FD9\u91CC\u6821\u51C6\u7AD9\u70B9\u52A8\u4F5C\u65F6\u95F4\u3002</span></div>`;
    return;
  }
  const actionControllers = [...new Set(STATION_ACTION_TIME_FIELDS.flatMap(
    ({ key }) => Object.keys(timing[key] || {})
  ))].sort((left, right) => left.localeCompare(right, void 0, { numeric: true }));
  const actionRows = actionControllers.map((controller) => `
    <tr>
      <th scope="row"><strong>${escapeHtml4(controller)}</strong><small>\u63A7\u5236\u673A\u5668\u624B</small></th>
      ${STATION_ACTION_TIME_FIELDS.map(({ key, label }) => {
    if (!Object.prototype.hasOwnProperty.call(timing[key] || {}, controller)) return `<td><span class="device-time-unavailable">\u2014</span></td>`;
    return `<td>${deviceTimeInput(timing[key][controller], `${stationName} ${controller} ${label}`, {
      "device-timing-target": "station-map",
      "device-name": stationName,
      "timing-field": key,
      "timing-key": controller
    })}</td>`;
  }).join("")}
    </tr>
  `).join("");
  const alignmentEntries = Object.entries(timing.AlignmentTime || {});
  const prePrepareRows = Array.isArray(station.PrePrepareTime) ? station.PrePrepareTime : [];
  const specialRows = [
    ...alignmentEntries.map(([slotId, value]) => `
      <div class="device-transition-row">
        <span class="device-transition-kind">\u5BF9\u51C6</span>
        <strong>Slot ${escapeHtml4(slotId)}</strong>
        <span class="device-transition-route">\u6676\u5706\u5B9A\u4F4D\u65F6\u95F4</span>
        ${deviceTimeInput(value, `${stationName} Slot ${slotId} \u5BF9\u51C6\u65F6\u95F4`, {
      "device-timing-target": "station-map",
      "device-name": stationName,
      "timing-field": "AlignmentTime",
      "timing-key": slotId
    })}
      </div>
    `),
    ...prePrepareRows.map((row, index) => `
      <div class="device-transition-row">
        <span class="device-transition-kind">${escapeHtml4(row?.PrePrepareType || "\u72B6\u6001\u5207\u6362")}</span>
        <strong>${escapeHtml4(row?.LastItem || "\u2014")} <i aria-hidden="true">\u2192</i> ${escapeHtml4(row?.CurrentItem || "\u2014")}</strong>
        <span class="device-transition-route">${escapeHtml4(row?.PrePrepareType === "PumpTime" ? "\u62BD\u6C14" : row?.PrePrepareType === "VentTime" ? "\u5145\u6C14" : "\u9884\u5904\u7406")}</span>
        ${deviceTimeInput(timing.PrePrepareTime?.[index] ?? row?.Time ?? 0, `${stationName} ${row?.PrePrepareType || "\u72B6\u6001\u5207\u6362"}`, {
      "device-timing-target": "station-sequence",
      "device-name": stationName,
      "timing-field": "PrePrepareTime",
      "timing-index": index
    })}
      </div>
    `)
  ];
  const timingCount = actionControllers.reduce((count, controller) => count + STATION_ACTION_TIME_FIELDS.filter(
    ({ key }) => Object.prototype.hasOwnProperty.call(timing[key] || {}, controller)
  ).length, 0) + specialRows.length;
  container.innerHTML = `
    <div class="device-timing-overview">
      <div><span>\u7AD9\u70B9\u7C7B\u578B</span><strong>${escapeHtml4(station.Type || "Station")}</strong></div>
      <div><span>\u5BB9\u91CF</span><strong>${Number(station.Capacity) || 0} <small>\u69FD</small></strong></div>
      <div><span>\u5173\u8054\u673A\u5668\u624B</span><strong>${actionControllers.length} <small>\u53F0</small></strong></div>
      <div><span>\u8BA1\u65F6\u53C2\u6570</span><strong>${timingCount} <small>\u9879</small></strong></div>
    </div>
    <section class="device-time-section" aria-labelledby="stationActionTimingTitle">
      <header><div><h3 id="stationActionTimingTitle">\u53D6\u653E\u7247\u52A8\u4F5C</h3><p>\u7AD9\u70B9\u4E0E\u5BF9\u5E94\u673A\u5668\u624B\u534F\u540C\u52A8\u4F5C\u7684\u5206\u6BB5\u8017\u65F6\u3002</p></div><span>${actionControllers.length} \u7EC4\u63A7\u5236\u5173\u7CFB</span></header>
      ${actionRows ? `<div class="device-time-table-wrap"><table class="device-time-table"><thead><tr><th>\u673A\u5668\u624B</th>${STATION_ACTION_TIME_FIELDS.map(({ label }) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${actionRows}</tbody></table></div>` : `<div class="device-time-inline-empty">\u5F53\u524D\u7AD9\u70B9\u672A\u58F0\u660E\u53D6\u653E\u7247\u5206\u6BB5\u65F6\u95F4\u3002</div>`}
    </section>
    <section class="device-time-section" aria-labelledby="stationTransitionTimingTitle">
      <header><div><h3 id="stationTransitionTimingTitle">\u4E13\u9879\u5904\u7406\u4E0E\u72B6\u6001\u5207\u6362</h3><p>LoadLock \u62BD\u5145\u6C14\u3001Aligner \u5BF9\u51C6\u7B49\u7AD9\u70B9\u4E13\u5C5E\u65F6\u95F4\u3002</p></div><span>${specialRows.length} \u9879</span></header>
      ${specialRows.length ? `<div class="device-transition-list">${specialRows.join("")}</div>` : `<div class="device-time-inline-empty">\u5F53\u524D\u7AD9\u70B9\u6CA1\u6709\u989D\u5916\u7684\u72B6\u6001\u5207\u6362\u65F6\u95F4\u3002</div>`}
    </section>`;
}
function renderDeviceRobotTiming() {
  const container = document.getElementById("deviceRobotTimingEditor");
  const robotName = state.deviceRobotName;
  const robot = state.baseDevice?.Robots?.[robotName];
  const timing = state.deviceTimingDraft?.robots?.[robotName];
  if (!robot || !timing) {
    container.innerHTML = `<div class="device-config-empty"><strong>\u6682\u65E0\u53EF\u914D\u7F6E\u673A\u5668\u624B</strong><span>\u5F53\u524D\u8BBE\u5907\u6CA1\u6709\u58F0\u660E\u673A\u5668\u624B\u65F6\u95F4\u53C2\u6570\u3002</span></div>`;
    return;
  }
  const actionStations = [...new Set(ROBOT_ACTION_TIME_FIELDS.flatMap(
    ({ key }) => Object.keys(timing[key] || {})
  ))].sort((left, right) => left.localeCompare(right, void 0, { numeric: true }));
  const actionRows = actionStations.map((stationName) => `
    <tr><th scope="row"><strong>${escapeHtml4(stationName)}</strong><small>\u76EE\u6807\u7AD9\u70B9</small></th>${ROBOT_ACTION_TIME_FIELDS.map(({ key, label }) => {
    if (!Object.prototype.hasOwnProperty.call(timing[key] || {}, stationName)) return `<td><span class="device-time-unavailable">\u2014</span></td>`;
    return `<td>${deviceTimeInput(timing[key][stationName], `${robotName} \u5728 ${stationName} \u7684${label}\u65F6\u95F4`, {
      "device-timing-target": "robot-map",
      "device-name": robotName,
      "timing-field": key,
      "timing-key": stationName
    })}</td>`;
  }).join("")}</tr>
  `).join("");
  const transferRows = Array.isArray(robot.PrepTransTime) ? robot.PrepTransTime : [];
  const sources = [...new Set(transferRows.map((row) => String(row?.SrcStation || "")).filter(Boolean))].sort((left, right) => left.localeCompare(right, void 0, { numeric: true }));
  let selectedSource = state.deviceRobotTransferSources[robotName];
  if (!sources.includes(selectedSource)) selectedSource = sources[0] || "";
  state.deviceRobotTransferSources[robotName] = selectedSource;
  const visibleTransfers = transferRows.map((row, index) => ({ row, index })).filter(({ row }) => String(row?.SrcStation || "") === selectedSource);
  const transferTableRows = visibleTransfers.map(({ row, index }) => `
    <tr>
      <th scope="row"><strong>${escapeHtml4(row?.DestStation || "\u2014")}</strong><small>${Number(row?.TransType) === 1 ? "\u8F7D\u7247\u79FB\u52A8" : "\u7A7A\u8F7D\u79FB\u52A8"}</small></th>
      <td><span class="device-transfer-type type-${Number(row?.TransType) === 1 ? "loaded" : "empty"}">${Number(row?.TransType) === 1 ? "\u8F7D\u7247" : "\u7A7A\u8F7D"}</span></td>
      <td>${deviceTimeInput(timing.PrepTransTime?.[index] ?? row?.Time ?? 0, `${robotName} \u4ECE ${row?.SrcStation || "\u2014"} \u5230 ${row?.DestStation || "\u2014"} \u7684\u79FB\u52A8\u65F6\u95F4`, {
    "device-timing-target": "robot-sequence",
    "device-name": robotName,
    "timing-field": "PrepTransTime",
    "timing-index": index
  })}</td>
    </tr>
  `).join("");
  const activeArms = Object.values(robot.ArmInfo || {}).filter((arm) => arm?.IsEnable !== false).length;
  container.innerHTML = `
    <div class="device-timing-overview">
      <div><span>\u673A\u5668\u624B\u7C7B\u578B</span><strong>${escapeHtml4(robot.Type || "Robot")}</strong></div>
      <div><span>\u542F\u7528\u624B\u81C2</span><strong>${activeArms} <small>\u6761</small></strong></div>
      <div><span>\u670D\u52A1\u7AD9\u70B9</span><strong>${actionStations.length} <small>\u4E2A</small></strong></div>
      <div><span>\u79FB\u52A8\u89C4\u5219</span><strong>${transferRows.length} <small>\u6761</small></strong></div>
    </div>
    <section class="device-time-section robot-action-section" aria-labelledby="robotActionTimingTitle">
      <header><div><h3 id="robotActionTimingTitle">\u53D6\u7247\u4E0E\u653E\u7247</h3><p>\u540C\u4E00\u673A\u5668\u624B\u5728\u4E0D\u540C\u7AD9\u70B9\u53EF\u4F7F\u7528\u72EC\u7ACB\u52A8\u4F5C\u65F6\u95F4\u3002</p></div><span>${actionStations.length} \u4E2A\u7AD9\u70B9</span></header>
      ${actionRows ? `<div class="device-time-table-wrap"><table class="device-time-table compact"><thead><tr><th>\u7AD9\u70B9</th>${ROBOT_ACTION_TIME_FIELDS.map(({ label }) => `<th>${label}\u65F6\u95F4</th>`).join("")}</tr></thead><tbody>${actionRows}</tbody></table></div>` : `<div class="device-time-inline-empty">\u5F53\u524D\u673A\u5668\u624B\u672A\u58F0\u660E\u53D6\u653E\u7247\u65F6\u95F4\u3002</div>`}
    </section>
    <section class="device-time-section" aria-labelledby="robotTransferTimingTitle">
      <header class="device-transfer-head"><div><h3 id="robotTransferTimingTitle">\u7AD9\u70B9\u95F4\u79FB\u52A8</h3><p>\u6309\u8D77\u70B9\u67E5\u770B\u79FB\u52A8\u89C4\u5219\uFF0C\u907F\u514D\u5728\u5927\u578B\u8BBE\u5907\u4E2D\u4E00\u6B21\u5C55\u793A\u6574\u5F20\u77E9\u9635\u3002</p></div><label><span>\u8D77\u70B9</span><select data-robot-transfer-source="${escapeHtml4(robotName)}" ${sources.length ? "" : "disabled"}>${sources.length ? sources.map((source) => `<option value="${escapeHtml4(source)}" ${source === selectedSource ? "selected" : ""}>${escapeHtml4(source)}</option>`).join("") : `<option>\u65E0\u79FB\u52A8\u89C4\u5219</option>`}</select></label></header>
      ${transferTableRows ? `<div class="device-time-table-wrap"><table class="device-time-table transfer"><thead><tr><th>\u76EE\u6807\u7AD9\u70B9</th><th>\u642C\u8FD0\u7C7B\u578B</th><th>\u79FB\u52A8\u65F6\u95F4</th></tr></thead><tbody>${transferTableRows}</tbody></table></div>` : `<div class="device-time-inline-empty">\u5F53\u524D\u8D77\u70B9\u6CA1\u6709\u53EF\u914D\u7F6E\u7684\u79FB\u52A8\u65F6\u95F4\u3002</div>`}
    </section>`;
}
function renderDeviceTimingConfiguration() {
  renderDeviceConfigHeader();
  renderDeviceTimingSelectors();
  document.querySelectorAll("[data-device-config-section]").forEach((button) => {
    const active = button.dataset.deviceConfigSection === state.deviceConfigSection;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-device-config-view]").forEach((view) => {
    const active = view.dataset.deviceConfigView === state.deviceConfigSection;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  if (state.deviceConfigSection === "station-time") renderDeviceStationTiming();
  if (state.deviceConfigSection === "robot-time") renderDeviceRobotTiming();
  if (state.deviceConfigSection === "robot-slot") renderRobotSlots();
}
function resetDeviceTimingDraft(message = "\u5F53\u524D\u8BBE\u5907\u65F6\u95F4\u53C2\u6570\u5DF2\u52A0\u8F7D") {
  state.deviceTimingDraft = state.baseDevice ? buildDeviceTimingDraft(state.baseDevice) : null;
  state.deviceTimingDirty = false;
  state.deviceTimingSaving = false;
  state.deviceTimingStatusMessage = state.baseDevice ? message : "\u9009\u62E9\u8BBE\u5907\u540E\u5F00\u59CB\u914D\u7F6E";
  renderDeviceTimingConfiguration();
}
function markDeviceTimingDirty() {
  if (!state.deviceTimingDraft || !state.workspaceDeviceId) return;
  state.deviceTimingDirty = true;
  state.deviceTimingStatusMessage = "\u6709\u5C1A\u672A\u4FDD\u5B58\u7684\u65F6\u95F4\u4FEE\u6539";
  renderDeviceConfigHeader();
}
function updateDeviceTimingFromControl(control) {
  const value = Number(control.value);
  const valid = control.value.trim() !== "" && Number.isFinite(value) && value >= 0;
  control.setCustomValidity(valid ? "" : "\u8BF7\u8F93\u5165\u5927\u4E8E\u6216\u7B49\u4E8E 0 \u7684\u6709\u9650\u79D2\u6570");
  control.classList.toggle("is-invalid", !valid);
  const section = control.dataset.deviceTimingTarget?.startsWith("station") ? "stations" : "robots";
  const item = state.deviceTimingDraft?.[section]?.[control.dataset.deviceName];
  if (!item) return;
  if (control.dataset.deviceTimingTarget?.endsWith("map")) {
    item[control.dataset.timingField][control.dataset.timingKey] = valid ? value : Number.NaN;
  } else {
    item[control.dataset.timingField][Number(control.dataset.timingIndex)] = valid ? value : Number.NaN;
  }
  markDeviceTimingDirty();
}
function validateDeviceTimingDraft() {
  let invalidLabel = "";
  Object.entries(state.deviceTimingDraft || {}).some(([sectionName, items]) => Object.entries(items).some(([itemName, fields]) => Object.entries(fields).some(([fieldName, values]) => {
    const rows = Array.isArray(values) ? values.map((value, index) => [index, value]) : Object.entries(values || {});
    const invalid = rows.find(([, value]) => !Number.isFinite(Number(value)) || Number(value) < 0);
    if (!invalid) return false;
    invalidLabel = `${sectionName}.${itemName}.${fieldName}.${invalid[0]}`;
    return true;
  })));
  if (invalidLabel) throw new Error(`${invalidLabel} \u5FC5\u987B\u662F\u5927\u4E8E\u6216\u7B49\u4E8E 0 \u7684\u6709\u9650\u79D2\u6570`);
}
async function saveDeviceTiming() {
  if (!state.deviceTimingDirty || state.deviceTimingSaving || !state.workspaceDeviceId) return;
  validateDeviceTimingDraft();
  state.deviceTimingSaving = true;
  renderDeviceConfigHeader();
  try {
    const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/device-timing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timing: state.deviceTimingDraft })
    });
    state.workspaceDevice.device = structuredClone(result.device);
    applyDeviceTopology(result.device, state.deviceName, state.robotSlots);
    resetRunResult();
    resetDeviceTimingDraft("\u65F6\u95F4\u53C2\u6570\u5DF2\u4FDD\u5B58\u5E76\u5E94\u7528\u5230\u5168\u90E8\u6D4B\u8BD5");
    setWorkspaceStatus("\u8BBE\u5907\u65F6\u95F4\u53C2\u6570\u5DF2\u4FDD\u5B58", "saved");
  } catch (error) {
    state.deviceTimingSaving = false;
    state.deviceTimingStatusMessage = `\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`;
    renderDeviceConfigHeader();
    throw error;
  }
}
function switchDeviceConfigSection(sectionName) {
  if (!document.querySelector(`[data-device-config-view="${sectionName}"]`)) return;
  state.deviceConfigSection = sectionName;
  renderDeviceTimingConfiguration();
}
function shortestDevicePath(source, destination) {
  const queue = [[`S:${source}`]], visited = new Set(queue[0]);
  while (queue.length) {
    const path2 = queue.shift(), node = path2.at(-1);
    if (node === `S:${destination}`) return path2.map((item) => item.slice(2));
    const [kind, name] = node.split(":");
    const neighbours = kind === "S" ? state.robotNames.filter((robot) => (state.robotScopes[robot] || []).includes(name)).map((robot) => `R:${robot}`) : (state.robotScopes[name] || []).map((station) => `S:${station}`);
    neighbours.forEach((next) => {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path2, next]);
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
    cleans: [],
    routes: state.routes.map(routeTemplateForSave),
    routeConfigs: normalizeTestRouteConfigs({}, state.routes),
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
    const setOpen = (open2) => {
      if (!open2) {
        closeCompactSelect(wrapper);
        return;
      }
      closeCompactSelects(select);
      const triggerBounds = trigger.getBoundingClientRect();
      (select.closest("dialog") || document.body).append(menu);
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
  const batchDisabled = state.batchRunning && state.batchCancelRequested || singleRunActive || !state.serviceCompatible || !visibleTests.length;
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
var testEditRevision = 0;
var testSaveInFlight = null;
function scheduleAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    if (state.dirty) saveCurrentTest(true).catch((error) => setWorkspaceStatus(`\u81EA\u52A8\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty"));
  }, 600);
}
function markTestDirty() {
  if (!state.testCaseId) return;
  testEditRevision += 1;
  state.dirty = true;
  setWorkspaceStatus(`\u201C${state.testCaseName}\u201D\u6709\u672A\u4FDD\u5B58\u4FEE\u6539`, "dirty");
  scheduleAutoSave();
}
function markRoutesDirty() {
  state.routeDirty = true;
  setWorkspaceStatus("\u5F53\u524D\u8DEF\u5F84\u6A21\u677F\u6709\u672A\u4FDD\u5B58\u4FEE\u6539\uFF0C\u8BF7\u5728\u6A21\u677F\u65C1\u70B9\u51FB\u201C\u4FDD\u5B58\u201D", "dirty");
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
  state.cleans = Array.isArray(value.cleans) ? value.cleans.map(normalizeClean) : (state.workspaceDevice?.cleans || []).map(normalizeClean);
  state.routes.forEach((route) => normalizeRoute(route));
  captureRouteGroupingProfiles();
  state.expandedRouteProcessGroups.clear();
  state.expandedRouteGroups.clear();
  state.expandedRoutes.clear();
  state.routeProcessFilter = "";
  state.routeParallelFilter = "";
  state.rounds = Array.isArray(value.rounds) ? value.rounds : [];
  state.testRouteConfigs = normalizeTestRouteConfigs(value.routeConfigs, state.routes);
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
  state.routeDirty = false;
  state.routeNameChanges.clear();
  state.routeEditingIndex = -1;
  state.routeEditSnapshot = null;
  state.routeEditGroupingProfile = null;
  state.routeEditIsNew = false;
  visualizationWorkspace.setAnalysisConfiguration(runtimeRoutes(), state.rounds);
  visualizationWorkspace.setReplayPlan(buildPayload());
  state.dirty = false;
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
  setWorkspaceStatus(`\u5DF2\u8F7D\u5165\u201C${state.testCaseName}\u201D`, "saved");
}
function currentTestSnapshot(name = state.testCaseName) {
  normalizeRounds();
  synchronizeCleanNames();
  return structuredClone({
    name,
    group: state.testCaseGroup,
    strategy: state.strategy,
    roundCount: state.roundCount,
    times: state.times,
    options: state.options,
    cleans: state.cleans.map(runtimeClean),
    routeConfigs: state.testRouteConfigs,
    rounds: state.rounds
  });
}
function routeTemplateSnapshot() {
  synchronizeRouteNames();
  return structuredClone({
    routes: state.routes.map(routeTemplateForSave),
    routeNameChanges: Object.fromEntries(state.routeNameChanges)
  });
}
async function saveRoutes() {
  if (!state.workspaceDeviceId) throw new Error("\u8BF7\u5148\u9009\u62E9\u8BBE\u5907");
  if (state.batchRunning) throw new Error("\u6279\u91CF\u4EFB\u52A1\u8FD0\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u6216\u53D6\u6D88\u540E\u518D\u4FDD\u5B58\u8DEF\u5F84");
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/routes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routeTemplateSnapshot())
    });
  } catch (error) {
    setWorkspaceStatus(`\u8DEF\u5F84\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty");
    throw error;
  }
  state.workspaceDevice.routes = structuredClone(result.routes || state.routes);
  state.routes = structuredClone(result.routes || state.routes);
  state.routes.forEach((route) => normalizeRoute(route));
  state.testRouteConfigs = normalizeTestRouteConfigs(state.testRouteConfigs, state.routes);
  captureRouteGroupingProfiles();
  state.routeDirty = false;
  state.routeEditingIndex = -1;
  state.routeEditSnapshot = null;
  state.routeEditGroupingProfile = null;
  state.routeEditIsNew = false;
  state.routeNameChanges.clear();
  renderRoutes();
  renderWorkspaceControls();
  setWorkspaceStatus("\u8DEF\u5F84\u6A21\u677F\u5DF2\u4FDD\u5B58\uFF0C\u5206\u7EC4\u5DF2\u5237\u65B0", "saved");
  return true;
}
function beginRouteEdit(routeIndex, isNew = false) {
  if (!state.routes[routeIndex]) return false;
  if (state.routeEditingIndex >= 0 && state.routeEditingIndex !== routeIndex) {
    setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
    return false;
  }
  state.routeEditingIndex = routeIndex;
  state.routeEditSnapshot = isNew ? null : structuredClone(state.routes[routeIndex]);
  state.routeEditGroupingProfile = structuredClone(routeGroupingProfile(state.routes[routeIndex]));
  state.routeEditIsNew = isNew;
  state.expandedRoutes.add(routeIndex);
  renderRoutes();
  return true;
}
function cancelRouteEdit() {
  const routeIndex = state.routeEditingIndex;
  if (routeIndex < 0) return;
  if (state.routeEditIsNew) {
    state.routes.splice(routeIndex, 1);
  } else if (state.routeEditSnapshot) {
    const restored = structuredClone(state.routeEditSnapshot);
    state.routes[routeIndex] = restored;
    if (state.routeEditGroupingProfile) {
      state.routeGroupingProfiles.set(restored, structuredClone(state.routeEditGroupingProfile));
    }
  }
  state.routeEditingIndex = -1;
  state.routeEditSnapshot = null;
  state.routeEditGroupingProfile = null;
  state.routeEditIsNew = false;
  state.routeDirty = false;
  state.routeNameChanges.clear();
  state.expandedRoutes.clear();
  renderRoutes();
  setWorkspaceStatus("\u5DF2\u53D6\u6D88\u8DEF\u5F84\u6A21\u677F\u4FEE\u6539", "saved");
}
async function saveCurrentTest(silent = false) {
  if (!state.workspaceDeviceId || !state.testCaseId) return false;
  if (testSaveInFlight) {
    await testSaveInFlight;
    if (!state.dirty) return true;
  }
  const inputName = document.getElementById("testCaseName").value.trim();
  if (!inputName) {
    setWorkspaceStatus("\u6D4B\u8BD5\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u8BF7\u8F93\u5165\u540D\u79F0\u540E\u518D\u4FDD\u5B58", "dirty");
    throw new Error("\u6D4B\u8BD5\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  }
  state.testCaseName = inputName;
  const deviceId = state.workspaceDeviceId;
  const testId = state.testCaseId;
  const revision = testEditRevision;
  const snapshot = currentTestSnapshot();
  const pendingSave = (async () => {
    let result;
    try {
      result = await requestJson(`/api/workspaces/${deviceId}/tests/${testId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot)
      });
    } catch (error) {
      setWorkspaceStatus(`\u4FDD\u5B58\u5931\u8D25\uFF1A${error.message}`, "dirty");
      throw error;
    }
    if (state.workspaceDeviceId !== deviceId || state.testCaseId !== testId) return true;
    const index = state.workspaceDevice.tests.findIndex((test) => test.id === testId);
    if (index >= 0) state.workspaceDevice.tests[index] = result.test;
    if (revision === testEditRevision) {
      state.testCaseName = result.test.name;
      state.dirty = false;
      state.routeNameChanges.clear();
      renderWorkspaceControls();
      setWorkspaceStatus(`${silent ? "\u5DF2\u81EA\u52A8\u4FDD\u5B58" : "\u5DF2\u4FDD\u5B58"}\u201C${state.testCaseName}\u201D`, "saved");
    } else {
      state.dirty = true;
      scheduleAutoSave();
    }
    return true;
  })();
  testSaveInFlight = pendingSave;
  try {
    return await pendingSave;
  } finally {
    if (testSaveInFlight === pendingSave) testSaveInFlight = null;
  }
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
  const index = state.workspaceDevice?.tests?.findIndex((test) => test.id === testId) ?? -1;
  if (index < 0) throw new Error(`\u6D4B\u8BD5\u96C6\u4E0D\u5B58\u5728\uFF1A${testId}`);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${testId}`);
  const testCase = result.test;
  state.workspaceDevice.tests[index] = testCase;
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
  await selectWorkspaceTest(testCase.id);
}
async function selectWorkspaceDevice(deviceId, preferredTestId = "") {
  const result = await requestJson(`/api/workspaces/${deviceId}`);
  state.workspaceDevice = result.device;
  state.workspaceDeviceId = result.device.id;
  state.activeTestGroup = "";
  state.testCaseGroup = "";
  applyDeviceTopology(result.device.device, result.device.name, result.device.robotSlots);
  resetDeviceTimingDraft();
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
  await selectWorkspaceTest(selected.id);
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
  state.deviceStationName = "";
  state.deviceRobotName = "";
  state.deviceRobotTransferSources = {};
  state.deviceTimingDraft = null;
  state.deviceTimingDirty = false;
  state.deviceTimingSaving = false;
  state.deviceTimingStatusMessage = "\u9009\u62E9\u8BBE\u5907\u540E\u5F00\u59CB\u914D\u7F6E";
  renderWorkspaceControls();
  renderDeviceTimingConfiguration();
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
  if (name === "device-config") renderDeviceTimingConfiguration();
  if (name !== "route") closeStepDrawer();
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
  const config = state.testRouteConfigs[route.name] || (state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route));
  if (scope === "route") return stringList(config[placement]);
  const stepId = String(route.stages[stageIndex]?.stepId);
  return stringList(config.stages?.[stepId]?.[placement]);
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
  const config = state.testRouteConfigs[route.name] || (state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route));
  if (context.scope === "route") update(config);
  else {
    const stepId = String(route.stages[context.stageIndex]?.stepId);
    const stageConfig = config.stages?.[stepId] || (config.stages[stepId] = stageDefaultConfig(route.stages[context.stageIndex]));
    update(stageConfig);
  }
}
function cleanReferenceCount(cleanName) {
  let count = 0;
  Object.values(state.testRouteConfigs).forEach((config) => {
    ROUTE_CLEAN_KEYS.forEach((key) => {
      if (stringList(config[key]).includes(cleanName)) count += 1;
    });
    Object.values(config.stages || {}).forEach((stage) => {
      for (const key of ["beforeCleanRefs", "afterCleanRefs"]) {
        if (stringList(stage[key]).includes(cleanName)) count += 1;
      }
    });
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
  document.getElementById("cleanDialogTitle").textContent = `${cleanName ? "\u7F16\u8F91" : "\u65B0\u589E"} ${scope === "route" ? "Job" : "RouteStep"} Clean`;
  document.getElementById("cleanDialogDescription").textContent = scope === "route" ? "Clean \u53EA\u4F5C\u7528\u4E8E\u5F53\u524D\u6D4B\u8BD5\u7684\u6240\u9009\u8DEF\u5F84\uFF0C\u4E0D\u4F1A\u4FEE\u6539\u8DEF\u5F84\u6A21\u677F\u3002" : "Clean \u53EA\u4F5C\u7528\u4E8E\u5F53\u524D\u6D4B\u8BD5\u7684\u8FD9\u4E2A Step\uFF0C\u4E0D\u4F1A\u4FEE\u6539\u8DEF\u5F84\u6A21\u677F\u3002";
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
  if (pjobRoutePickerContext && document.getElementById("pjobRouteDialog").open) {
    renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
  }
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
  if (pjobRoutePickerContext && document.getElementById("pjobRouteDialog").open) {
    renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
  }
}
function renderCandidatePicker(routeIndex, stageIndex, allowed, candidates) {
  const selected = new Set(candidates);
  const summary = candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml4(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u9009\u62E9\u8BBE\u5907</span>`;
  return `<details class="candidate-picker" onclick="event.stopPropagation()"><summary>${summary}</summary><div class="candidate-picker-menu">${allowed.map((name) => `<label class="candidate-option"><input type="checkbox" data-scope="stage-candidate-toggle" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-candidate="${escapeHtml4(name)}" ${selected.has(name) ? "checked" : ""}><span>${escapeHtml4(name)}</span></label>`).join("")}</div></details>`;
}
function refreshCandidatePicker(control) {
  const picker = control.closest(".candidate-picker");
  const routeIndex = Number(control.dataset.routeIndex);
  const stageIndex = Number(control.dataset.stageIndex);
  const route = state.routes[routeIndex];
  const stage = route?.stages?.[stageIndex];
  if (!picker || !stage) return;
  normalizeRoute(route);
  const candidates = [...new Set((stage.visits || []).map((visit) => visit.stationName).filter(Boolean))];
  const summary = picker.querySelector("summary");
  if (summary) {
    summary.innerHTML = candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml4(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u9009\u62E9\u8BBE\u5907</span>`;
  }
  const row = control.closest("[data-step-card]");
  if (row) {
    const type = row.querySelector(".step-type");
    if (type) {
      type.className = `step-type ${stage.needProcess ? "process" : ""}`;
      type.textContent = stepKind(route, stageIndex);
    }
    const needProcess = row.querySelectorAll(".route-step-readonly")[1];
    if (needProcess) needProcess.textContent = stage.needProcess ? "true" : "false";
  }
}
function renderReadonlyCandidates(stage) {
  const candidates = [...new Set((stage?.visits || []).map((visit) => visit.stationName).filter(Boolean))];
  return candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml4(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u672A\u9009\u62E9</span>`;
}
function renderSteps(route, routeIndex) {
  return route.stages.map((stage, stageIndex) => {
    const candidates = [...new Set((stage.visits || []).map((visit) => visit.stationName).filter(Boolean))];
    const allowed = stageUsesRobot(stage, stageIndex) ? state.robotNames : state.stationNames;
    const fixed = isFixedRouteStep(route, stageIndex);
    const picker = fixed ? `<span class="chip">\u6D4B\u8BD5 LoadPort</span>` : renderCandidatePicker(routeIndex, stageIndex, allowed, candidates);
    const actions = fixed ? `<span class="route-step-readonly">\u56FA\u5B9A\u6A21\u5757</span>` : `<div class="route-step-actions"><button class="btn icon small" title="\u524D\u79FB" data-action="move-step-up" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u2191</button><button class="btn icon small" title="\u540E\u79FB" data-action="move-step-down" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u2193</button><button class="btn danger icon small" title="\u5220\u9664" data-action="remove-stage" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" ${route.stages.length <= 3 ? "disabled" : ""}>\xD7</button></div>`;
    return `<tr data-route-template-step data-route-index="${routeIndex}" data-stage-index="${stageIndex}">
      <td><span class="step-id-badge">${Number(stage.stepId)}</span></td>
      <td><span class="step-type ${stage.needProcess ? "process" : ""}">${stepKind(route, stageIndex)}</span></td>
      <td>${picker}</td>
      <td class="route-step-readonly"><span class="step-next">${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "\u7ED3\u675F"}</span></td>
      <td class="route-step-readonly">${stage.needProcess ? "true" : "false"}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
}
function routeProcessProfile(route) {
  normalizeRoute(route);
  return processProfile(route);
}
function generatedRouteName(route) {
  return automaticTemplateName2(routeProcessProfile(route));
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
  if (state.testRouteConfigs[oldName] && !state.testRouteConfigs[newName]) {
    state.testRouteConfigs[newName] = structuredClone(state.testRouteConfigs[oldName]);
    delete state.testRouteConfigs[oldName];
  }
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
  const processGroups = /* @__PURE__ */ new Map();
  state.routes.forEach((route, routeIndex) => {
    const profile = routeGroupingProfile(route);
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
  return `<div class="route-details"><div class="edit-card-head"><strong>\u8154\u5BA4\u8DEF\u5F84</strong><div><button class="btn small" data-action="add-stage" data-index="${index}">\uFF0B Step \u7EC4</button></div></div>
    <div class="route-table-wrap"><table class="route-table"><thead><tr><th>StepID</th><th>\u7C7B\u578B</th><th>\u53EF\u9009\u8154\u5BA4 / \u673A\u5668\u624B</th><th>PostStepID</th><th>NeedProcess</th><th></th></tr></thead><tbody>${renderSteps(route, index)}</tbody></table></div></div>`;
}
function renderRoutes() {
  const host = document.getElementById("routeList");
  const processSelect = document.getElementById("routeProcessFilter");
  const parallelSelect = document.getElementById("routeParallelFilter");
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
  initializeCompactSelects();
  refreshCompactSelect(processSelect);
  refreshCompactSelect(parallelSelect);
  if (!selectedStructure) {
    host.innerHTML = `<div class="empty">\u81F3\u5C11\u521B\u5EFA\u4E00\u6761\u8DEF\u5F84\uFF0CJob \u624D\u80FD\u5F15\u7528\u3002</div>`;
    return;
  }
  const routes = selectedStructure.routes.map(({ route, routeIndex }) => {
    const routeOpen = state.routeEditingIndex === routeIndex;
    const anotherRouteEditing = state.routeEditingIndex >= 0 && !routeOpen;
    const compactPath = routePickerCompactPath(route, false);
    const actions = routeOpen ? `<button class="btn small" type="button" disabled>\u7F16\u8F91</button><button class="btn primary small" type="button" data-action="save-route" data-route-index="${routeIndex}">\u4FDD\u5B58</button><button class="btn small" type="button" data-action="cancel-route-edit" data-route-index="${routeIndex}">\u53D6\u6D88</button>` : `<button class="btn small" type="button" data-action="edit-route" data-route-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>\u7F16\u8F91</button><button class="btn small" type="button" data-action="copy-route" data-route-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>\u590D\u5236</button><button class="btn danger small" type="button" data-action="remove-route" data-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>\u5220\u9664</button>`;
    return `<article class="route-summary-card ${routeOpen ? "is-editing" : ""}"><div class="route-summary-head"><div class="route-summary-toggle">
      <span class="route-summary-content"><span class="route-summary-primary"><span class="route-summary-id">${routePickerShortId(route)}</span><strong title="${escapeHtml4(compactPath)}">${escapeHtml4(compactPath)}</strong></span></span></div>
      <div class="route-summary-actions">${actions}</div>
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
function routePickerCompactPath(route, includeTestParameters = true, sourceModule = "") {
  normalizeRoute(route);
  return (route.stages || []).map((stage, stageIndex) => {
    const candidates = [...new Set((stage.visits || []).map((visit) => String(visit.stationName || "").trim()).filter(Boolean))];
    const transferOnly = stage.kind === "robot" || candidates.length && candidates.every((name) => state.robotNames.includes(name) || /robot/i.test(name) || /^(?:ATR|VTR|DBR|UBR|TM|VTM|EFEM)(?:[_-]?\d+)?$/i.test(name));
    if (transferOnly) return "";
    const fixedSource = isFixedRouteStep(route, stageIndex);
    let node = fixedSource ? stageIndex === 0 ? "Src" : "Sink" : candidates.join("/") || "\u672A\u9009\u8154\u5BA4";
    if (includeTestParameters && stage.needProcess) {
      const processTime = Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0);
      node += `(${formatCleanSeconds(processTime)})`;
    }
    const wacTokens = includeTestParameters ? routePickerStageWacTokens(stage) : [];
    return `${node}${wacTokens.length ? `[${wacTokens.join("+")}]` : ""}`;
  }).filter(Boolean).join("->") || "\u672A\u914D\u7F6E\u8DEF\u5F84";
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
  const hasResidency = routeHasTimeConstraint(route, "residencyConstraint");
  const hasQTime = routeHasTimeConstraint(route, "qTimeLimit");
  const tags = [];
  if (cleanSummary !== "\u65E0") tags.push(`<span class="route-property-tag clean-active" title="\u6E05\u6D01\uFF1A${escapeHtml4(cleanSummary)}">${escapeHtml4(cleanSummary)}</span>`);
  if (hasResidency) tags.push(`<span class="route-property-tag constraint-active" title="\u9A7B\u7559\u65F6\u95F4\u7EA6\u675F\uFF1A\u5DF2\u914D\u7F6E">\u9A7B\u7559\u7EA6\u675F</span>`);
  if (buffer.index > 0) tags.push(`<span class="route-property-tag buffer-${buffer.tone}" title="Buffer \u4F7F\u7528\u6A21\u5F0F ${buffer.index}\uFF1A${escapeHtml4(buffer.label)}">${escapeHtml4(buffer.label)}</span>`);
  if (hasQTime) tags.push(`<span class="route-property-tag qtime-active" title="QTime\uFF1A\u5DF2\u914D\u7F6E">QTime</span>`);
  return tags.length ? `<span class="route-property-tags">${tags.join("")}</span>` : "";
}
function renderPJobRouteCard(route, baseline) {
  const routeIndex = state.routes.indexOf(route), selected = route === baseline;
  const compactPath = routePickerCompactPath(route, false);
  return `<button type="button" class="pjob-route-card ${selected ? "selected" : ""}" data-action="select-pjob-route" data-route-index="${routeIndex}" aria-pressed="${selected}" title="${escapeHtml4(compactPath)}">
    <span class="pjob-route-card-head"><span class="pjob-route-card-id">${routePickerShortId(route)}</span><strong class="pjob-route-card-path">${escapeHtml4(compactPath)}</strong>${selected ? `<span class="pjob-route-card-current">\u5F53\u524D\u9009\u62E9</span>` : ""}</span>
  </button>`;
}
function renderRouteInstanceSteps(route, loadPort = "") {
  const routeIndex = state.routes.indexOf(route);
  const runtimeRoute = runtimeRouteForTemplate(route);
  if (loadPort && runtimeRoute.stages?.length) {
    for (const stageIndex of [0, runtimeRoute.stages.length - 1]) {
      (runtimeRoute.stages[stageIndex]?.visits || []).forEach((visit) => {
        visit.stationName = loadPort;
      });
    }
  }
  return `<table class="route-table"><thead><tr><th>StepID</th><th>\u7C7B\u578B</th><th>\u53EF\u9009\u8154\u5BA4 / \u673A\u5668\u624B</th><th>PostStepID</th><th>NeedProcess</th></tr></thead><tbody>${(runtimeRoute.stages || []).map((stage, stageIndex) => {
    const fixed = isFixedRouteStep(runtimeRoute, stageIndex);
    return `<tr ${fixed ? "" : "data-step-card"} data-route-index="${routeIndex}" data-stage-index="${stageIndex}">
      <td><span class="step-id-badge">${Number(stage.stepId)}</span></td>
      <td>${fixed ? `<span class="route-step-source-note">\u7531 CJob LoadPort \u51B3\u5B9A</span>` : `<span class="step-type ${stage.needProcess ? "process" : ""}">${stepKind(route, stageIndex)}</span>`}</td>
      <td>${fixed ? `<span class="route-step-readonly">\u2014</span>` : renderReadonlyCandidates(stage)}</td>
      <td class="route-step-readonly"><span class="step-next">${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "\u7ED3\u675F"}</span></td>
      <td class="route-step-readonly">${stage.needProcess ? "true" : "false"}</td>
    </tr>`;
  }).join("")}</tbody></table>`;
}
function renderRouteBufferEditor(routeIndex) {
  const route = state.routes[routeIndex];
  const current = routeBufferMode(runtimeRouteForTemplate(route).bufferOption).index;
  const bufferModes = ["No Buffer", "\u5F3A\u5236 Buffer Out", "\u5F3A\u5236 Buffer In", "\u975E\u5F3A\u5236 Buffer Out", "\u975E\u5F3A\u5236 Buffer In"];
  return `<section class="route-instance-buffer">
    <label for="route-${routeIndex}-buffer-option">Buffer Option</label>
    <select id="route-${routeIndex}-buffer-option" data-compact-label="Buffer Option" data-scope="test-route" data-route-index="${routeIndex}" data-key="bufferOption">${bufferModes.map((label, value) => `<option value="${value}" ${value === current ? "selected" : ""}>${value} \xB7 ${escapeHtml4(label)}</option>`).join("")}</select>
  </section>`;
}
function renderPJobRouteDialogGroup(processKey, structureKey) {
  const context = pjobRoutePickerContext;
  if (!context) return;
  const selectedProcess = context.groups.find((group) => group.key === processKey) || context.groups[0];
  const selectedStructure = (selectedProcess?.structures || []).find((structure) => structure.key === structureKey) || selectedProcess?.structures[0];
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  context.processKey = selectedProcess?.key || "";
  context.structureKey = selectedStructure?.key || "";
  const filterGrid = document.getElementById("pjobRouteFilterGrid");
  const cardList = document.getElementById("pjobRouteCardList");
  const detailHost = document.getElementById("pjobRouteDetail");
  document.querySelector(".pjob-route-dialog-body")?.classList.toggle("edit-mode", context.mode === "edit" && Boolean(selectedRoute));
  if (context.mode === "edit" && selectedRoute) {
    document.getElementById("pjobRouteDialogTitle").textContent = `\u7F16\u8F91 ${pjob.jobName} \u7684\u8DEF\u5F84`;
    document.getElementById("pjobRouteDialogContext").textContent = "";
    filterGrid.hidden = true;
    cardList.hidden = true;
    detailHost.hidden = false;
    const routeIndex = state.routes.indexOf(selectedRoute);
    detailHost.innerHTML = `<article class="pjob-route-edit-card">
      <header class="pjob-route-edit-head"><button class="btn small" type="button" data-action="back-pjob-route-selection">\u2190 \u8FD4\u56DE\u9009\u62E9\u6A21\u677F</button><div><strong>${routePickerShortId(selectedRoute)}</strong></div></header>
      <div class="pjob-route-instance-settings">${renderRouteBufferEditor(routeIndex)}${renderRouteCleanEditor(routeIndex)}</div>
      <div class="route-table-wrap">${renderRouteInstanceSteps(selectedRoute, pjob?.loadPort)}</div>
    </article>`;
    initializeCompactSelects();
    return;
  }
  context.mode = "select";
  document.getElementById("pjobRouteDialogTitle").textContent = `\u9009\u62E9 ${pjob.jobName} \u7684\u8DEF\u5F84\u6A21\u677F`;
  filterGrid.hidden = false;
  cardList.hidden = false;
  detailHost.hidden = true;
  detailHost.innerHTML = "";
  const parallelSelect = document.getElementById("pjobRouteParallel");
  parallelSelect.innerHTML = (selectedProcess?.structures || []).map((structure) => `<option value="${escapeHtml4(structure.key)}" ${structure.key === context.structureKey ? "selected" : ""}>${escapeHtml4(structure.label)}</option>`).join("") || `<option value="">\u6682\u65E0\u7ED3\u6784</option>`;
  document.getElementById("pjobRouteDialogContext").textContent = selectedStructure ? `${selectedProcess.label} \xB7 ${selectedStructure.label} \xB7 ${selectedStructure.routes.length} \u6761\u5019\u9009\u8DEF\u5F84` : "\u5F53\u524D\u5DE5\u5E8F\u6CA1\u6709\u53EF\u7528\u8DEF\u5F84";
  cardList.innerHTML = (selectedStructure?.routes || []).length ? selectedStructure.routes.map(({ route }) => renderPJobRouteCard(route, selectedRoute)).join("") : `<div class="pjob-route-dialog-empty">\u5F53\u524D\u5DE5\u5E8F\u6CA1\u6709\u53EF\u9009\u62E9\u7684\u8DEF\u5F84</div>`;
}
function openPJobRoutePicker(button) {
  const roundIndex = Number(button.dataset.roundIndex), cjobIndex = Number(button.dataset.cjobIndex), pjobIndex = Number(button.dataset.pjobIndex);
  const pjob = state.rounds[roundIndex]?.cjobs[cjobIndex]?.pjobs[pjobIndex];
  if (!pjob) return;
  const groups = groupedRoutes();
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const selectedProfile = selectedRoute ? routeProcessProfile(selectedRoute) : null;
  const selectedProcess = groups.find((group) => selectedProfile ? selectedProfile.isReentrant ? group.key === selectedProfile.key : group.key === String(selectedProfile.processCount) : false) || groups[0];
  const selectedStructure = (selectedProcess?.structures || []).find((structure) => structure.key === selectedProfile?.key) || selectedProcess?.structures[0];
  pjobRoutePickerContext = {
    roundIndex,
    cjobIndex,
    pjobIndex,
    trigger: button,
    groups,
    processKey: selectedProcess?.key || "",
    structureKey: selectedStructure?.key || "",
    mode: "select"
  };
  document.getElementById("pjobRouteDialogTitle").textContent = `\u9009\u62E9 ${pjob.jobName} \u7684\u8DEF\u5F84`;
  const processSelect = document.getElementById("pjobRouteProcess");
  processSelect.innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml4(group.key)}" ${group.key === pjobRoutePickerContext.processKey ? "selected" : ""}>${escapeHtml4(group.label)}</option>`).join("") : `<option value="">\u6682\u65E0\u5DE5\u5E8F</option>`;
  renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
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
  renderRounds();
}
function selectPJobRoute(routeIndex) {
  const context = pjobRoutePickerContext, route = state.routes[routeIndex];
  if (!context || !route) return;
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  if (!pjob) return;
  pjob.routeRef = route.name;
  if (!state.testRouteConfigs[route.name]) state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route);
  normalizeRounds();
  markTestDirty();
  context.mode = "edit";
  renderPJobRouteDialogGroup(context.processKey, context.structureKey);
}
function renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex) {
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const runtimeRoute = selectedRoute ? runtimeRouteForTemplate(selectedRoute) : null;
  const compactPath = runtimeRoute ? routePickerCompactPath(runtimeRoute, true, pjob.loadPort) : "\u672A\u9009\u62E9\u8DEF\u5F84";
  const common = `data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}"`;
  return `<div class="pjob-route-picker">
    <div class="pjob-route-current" title="${escapeHtml4(compactPath)}"><span class="pjob-route-current-path">${escapeHtml4(compactPath)}</span>${runtimeRoute ? renderRoutePropertyTags(runtimeRoute) : ""}</div>
    <button type="button" class="pjob-route-open" data-action="open-pjob-route-picker" aria-label="\u9009\u62E9\u5177\u4F53\u8DEF\u5F84" aria-haspopup="dialog" aria-controls="pjobRouteDialog" aria-expanded="false" ${common}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
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
      const occupiedLoadPorts = new Set(
        round.cjobs.filter((_item, index) => index !== cjobIndex).map((item) => item.loadPort)
      );
      const loadPortOptions = state.loadPorts.map((loadPort) => `<option value="${escapeHtml4(loadPort)}" ${loadPort === cjob.loadPort ? "selected" : ""} ${occupiedLoadPorts.has(loadPort) ? "disabled" : ""}>${escapeHtml4(loadPort)}</option>`).join("");
      const pjobRows = cjob.pjobs.map((pjob, pjobIndex) => {
        const pjobFieldPrefix = `${fieldPrefix}-pjob-${pjobIndex}`;
        return `<div class="pjob-row">
          <div class="pjob-identity"><span>PJob</span><strong>${escapeHtml4(pjob.jobName)}</strong></div>
          <label class="pjob-field pjob-material" for="${pjobFieldPrefix}-wafer-count"><span>Material</span><input id="${pjobFieldPrefix}-wafer-count" class="pjob-number" type="number" min="1" max="25" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="waferCount" value="${Number(pjob.waferCount)}"></label>
          <label class="pjob-field pjob-priority" for="${pjobFieldPrefix}-priority"><span>Priority</span><input id="${pjobFieldPrefix}-priority" class="pjob-number" type="number" min="1" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="priority" value="${Number(pjob.priority)}"></label>
          <div class="pjob-field pjob-origin-route"><span>OriginRoute</span>${renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex)}</div>
          <button class="btn danger icon pjob-remove" type="button" aria-label="\u5220\u9664 ${escapeHtml4(pjob.jobName)}" title="\u5220\u9664 ${escapeHtml4(pjob.jobName)}" data-action="remove-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" ${cjob.pjobs.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13"/></svg></button>
        </div>`;
      }).join("");
      return `<section class="cjob-card">
        <header class="cjob-head">
          <div class="cjob-title"><strong>CJob ${cjobIndex + 1}</strong><span class="cjob-task-id">TaskID ${escapeHtml4(cjob.taskId)}</span></div>
          <div class="cjob-controls">
            <div class="field cjob-job-type"><label for="${fieldPrefix}-job-type">JobType</label><select id="${fieldPrefix}-job-type" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="jobType">${CJOB_TYPES.map((value) => `<option ${value === cjob.jobType ? "selected" : ""}>${value}</option>`).join("")}</select></div>
            <div class="field cjob-load-port"><label for="${fieldPrefix}-load-port">LoadPort</label><select id="${fieldPrefix}-load-port" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="loadPort" aria-label="CJob ${cjobIndex + 1} LoadPort">${loadPortOptions}</select></div>
            <div class="field cjob-priority ${normalLot ? "" : "disabled-field"}"><label for="${fieldPrefix}-priority">Priority</label><input id="${fieldPrefix}-priority" type="number" min="1" inputmode="numeric" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="priority" value="${Number(cjob.priority)}" ${normalLot ? "" : "disabled"}></div>
            <div class="field cjob-task-mode"><label for="${fieldPrefix}-task-mode">TaskMode</label><select id="${fieldPrefix}-task-mode" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="taskMode">${TASK_MODES.map((value) => `<option ${value === cjob.taskMode ? "selected" : ""} ${round.cjobs.length > 1 && ["Pipeline", "Sequential"].includes(value) ? "disabled" : ""}>${value}</option>`).join("")}</select></div>
            <div class="field cjob-cycle"><label for="${fieldPrefix}-cycle">CJobCycle</label><input id="${fieldPrefix}-cycle" type="number" min="1" max="1000" step="1" inputmode="numeric" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="cjobCycle" value="${Number(cjob.cjobCycle)}"></div>
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
      <input id="${inputId}" type="number" inputmode="decimal" step="${options.step || "0.1"}"${minimum} data-scope="test-step" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-key="${key}" value="${escapeHtml4(value)}">
      <span aria-hidden="true">s</span>
    </div>
    ${helper}
  </div>`;
}
function renderStepCleanEditor(routeIndex, stageIndex) {
  return `<section class="step-clean-section">
    <div class="context-clean-head"><div><strong>Clean</strong></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="step" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\uFF0B Clean</button></div>
    ${renderContextCleans("step", routeIndex, stageIndex)}
  </section>`;
}
function renderRouteCleanEditor(routeIndex) {
  return `<section class="step-clean-section">
    <div class="context-clean-head"><div><strong>Job Clean</strong></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="route" data-route-index="${routeIndex}" data-stage-index="-1">\uFF0B Clean</button></div>
    ${renderContextCleans("route", routeIndex)}
  </section>`;
}
function renderStepDrawer() {
  if (!state.drawer) return;
  const { routeIndex, stageIndex } = state.drawer, template = state.routes[routeIndex];
  if (!template) {
    closeStepDrawer();
    return;
  }
  const route = runtimeRouteForTemplate(template), stage = route?.stages[stageIndex];
  if (!stage || isFixedRouteStep(route, stageIndex)) {
    closeStepDrawer();
    return;
  }
  document.getElementById("drawerTitle").textContent = `Step ${stage.stepId} \u914D\u7F6E`;
  const candidates = [...new Set(stage.visits.map((visit) => visit.stationName).filter(Boolean))];
  document.getElementById("drawerSubtitle").textContent = `\u8154\u5BA4\uFF1A${candidates.join(" / ") || "\u672A\u9009\u62E9"}`;
  const first = stage.visits[0] ? normalizeVisit(stage.visits[0]) : null;
  const editor = first ? `<section class="step-editor-card" aria-label="Step \u65F6\u95F4\u53C2\u6570">
    <div class="step-edit-grid">
      ${renderStepNumberField("Process Time", "processTime", first.processTime, routeIndex, stageIndex, { minimum: 0 })}
      ${renderStepNumberField("QTime", "qTimeLimit", first.qTimeLimit, routeIndex, stageIndex)}
      ${renderStepNumberField("Residency", "residencyConstraint", first.residencyConstraint, routeIndex, stageIndex)}
    </div>
  </section>${renderStepCleanEditor(routeIndex, stageIndex)}
  <details class="step-system-details">
    <summary><strong>\u7CFB\u7EDF\u53C2\u6570</strong><span class="details-chevron" aria-hidden="true">\u2304</span></summary>
    <div class="step-system-grid">
      ${renderReadonlyField("Recipe Time", first.processTime)}
      ${renderReadonlyField("Process Recipe", first.processRecipe)}
      ${renderReadonlyField("Process Type", first.processType)}
      ${renderReadonlyField("Slot IDs", first.slotIds)}
      ${renderReadonlyField("Weight", first.weight)}
      ${renderReadonlyField("Move Time Offset", first.moveTimeOffset, true)}
    </div>
  </details>` : `<div class="empty">\u672A\u9009\u62E9\u5019\u9009\u8BBE\u5907\uFF0C\u8BF7\u5148\u5728\u8DEF\u5F84\u5217\u8868\u4E2D\u9009\u62E9\u3002</div>`;
  document.getElementById("drawerBody").innerHTML = editor;
}
function openPJobStepDrawer(routeIndex, stageIndex) {
  const route = state.routes[routeIndex];
  if (!route || isFixedRouteStep(route, stageIndex)) return;
  state.drawer = { scope: "test", routeIndex, stageIndex };
  renderStepDrawer();
  const drawerLayer = document.getElementById("drawerLayer");
  drawerLayer.classList.add("open");
  if (!drawerLayer.open) drawerLayer.showModal();
}
function closeStepDrawer() {
  state.drawer = null;
  const drawerLayer = document.getElementById("drawerLayer");
  drawerLayer.classList.remove("open");
  if (drawerLayer.open) drawerLayer.close();
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
  const scope = control.dataset.scope;
  const routeControl = ["stage-candidates", "stage-candidate-toggle"].includes(scope);
  if (routeControl) markRoutesDirty();
  else markTestDirty();
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
  if (scope === "stage-candidates") setStageCandidates(Number(control.dataset.routeIndex), Number(control.dataset.stageIndex), Array.from(control.selectedOptions, (item) => item.value));
  if (scope === "stage-candidate-toggle") {
    const routeIndex = Number(control.dataset.routeIndex), stageIndex = Number(control.dataset.stageIndex);
    const current = new Set(state.routes[routeIndex].stages[stageIndex].visits.map((visit) => visit.stationName));
    if (control.checked) current.add(control.dataset.candidate);
    else current.delete(control.dataset.candidate);
    setStageCandidates(routeIndex, stageIndex, [...current]);
  }
  if (scope === "test-route") {
    const route = state.routes[Number(control.dataset.routeIndex)];
    const config = state.testRouteConfigs[route.name] || (state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route));
    config[key] = ROUTE_CLEAN_KEYS.includes(key) ? value ? [value] : [] : value;
  }
  if (scope === "test-step") {
    const route = state.routes[Number(control.dataset.routeIndex)];
    const stage = route.stages[Number(control.dataset.stageIndex)];
    const config = state.testRouteConfigs[route.name] || (state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route));
    const stepId = String(stage.stepId);
    const stageConfig = config.stages[stepId] || (config.stages[stepId] = stageDefaultConfig(stage));
    stageConfig[key] = structuredClone(value);
    if (key === "processTime") stageConfig.recipeTime = Number(value);
  }
  if (scope === "cjob") {
    const round = state.rounds[Number(control.dataset.roundIndex)];
    const cjob = round.cjobs[Number(control.dataset.cjobIndex)];
    if (key === "taskMode" && ["Pipeline", "Sequential"].includes(String(value)) && round.cjobs.length > 1) {
      control.value = cjob.taskMode;
      return;
    }
    if (key === "cjobCycle") {
      value = Math.max(1, Math.min(1e3, Math.trunc(Number(value) || 1)));
      control.value = String(value);
    }
    cjob[key] = value;
    if (key === "loadPort") cjob.pjobs.forEach((pjob) => {
      pjob.loadPort = String(value);
    });
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
  const action = button.dataset.action, index = Number(button.dataset.index), routeIndex = Number(button.dataset.routeIndex), stageIndex = Number(button.dataset.stageIndex);
  let routeAction = false;
  if (action === "open-pjob-route-picker") {
    openPJobRoutePicker(button);
    return;
  }
  if (action === "select-pjob-route") {
    selectPJobRoute(routeIndex);
    return;
  }
  if (action === "back-pjob-route-selection") {
    if (pjobRoutePickerContext) {
      pjobRoutePickerContext.mode = "select";
      renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
    }
    return;
  }
  if (action === "save-route") {
    saveRoutes().catch((error) => writeTerminal(`$ \u8DEF\u5F84\u4FDD\u5B58\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  if (action === "cancel-route-edit") {
    cancelRouteEdit();
    return;
  }
  if (action === "open-pjob-step-drawer") {
    openPJobStepDrawer(routeIndex, stageIndex);
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
  if (action === "edit-route") {
    const profile = routeGroupingProfile(state.routes[routeIndex]);
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    beginRouteEdit(routeIndex);
    return;
  }
  if (action === "add-route") {
    if (state.routeEditingIndex >= 0) {
      setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
      return;
    }
    const name = `Route${state.routes.length + 1}`, route = { name, group: name, bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: state.device ? defaultRouteStages(name) : linkRouteSteps([makeStage(""), makeStage(""), makeStage("", true, `${name}_Step2`), makeStage(""), makeStage("")]) };
    state.routes.push(route);
    state.routeGroupingProfiles.set(route, structuredClone(routeProcessProfile(route)));
    const newIndex = state.routes.length - 1, profile = routeProcessProfile(route);
    state.expandedRoutes.add(newIndex);
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    beginRouteEdit(newIndex, true);
    routeAction = true;
  }
  if (action === "copy-route") {
    if (state.routeEditingIndex >= 0) {
      setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
      return;
    }
    const source = state.routes[routeIndex], base = `${source.name || "Route"} \u526F\u672C`, occupied = new Set(state.routes.map((route) => route.name));
    let name = base, suffix = 2;
    while (occupied.has(name)) name = `${base} (${suffix++})`;
    const copy = structuredClone(source);
    copy.name = name;
    state.routes.push(copy);
    state.routeGroupingProfiles.set(copy, structuredClone(routeProcessProfile(copy)));
    const newIndex = state.routes.length - 1, profile = routeProcessProfile(copy);
    state.expandedRoutes.add(newIndex);
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    beginRouteEdit(newIndex, true);
    routeAction = true;
  }
  if (action === "remove-route") {
    if (state.routeEditingIndex >= 0) {
      setWorkspaceStatus("\u8BF7\u5148\u4FDD\u5B58\u6216\u53D6\u6D88\u5F53\u524D\u6B63\u5728\u7F16\u8F91\u7684\u8DEF\u5F84\u6A21\u677F", "dirty");
      return;
    }
    state.routes.splice(index, 1);
    state.expandedRoutes.clear();
    state.expandedRouteProcessGroups.clear();
    state.expandedRouteGroups.clear();
    if (state.drawer?.routeIndex === index) closeStepDrawer();
    markRoutesDirty();
    saveRoutes().catch((error) => writeTerminal(`$ \u8DEF\u5F84\u5220\u9664\u5931\u8D25
  ${error.message}`, true));
    return;
  }
  if (action === "add-stage") {
    state.routes[index].stages.splice(-1, 0, makeStage(""), makeStage(""));
    linkRouteSteps(state.routes[index].stages);
    routeAction = true;
  }
  if (action === "remove-stage" && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) {
    state.routes[routeIndex].stages.splice(stageIndex, 1);
    linkRouteSteps(state.routes[routeIndex].stages);
    closeStepDrawer();
    routeAction = true;
  }
  if (action === "move-step-up" && stageIndex > 0 && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) {
    [state.routes[routeIndex].stages[stageIndex - 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex - 1]];
    linkRouteSteps(state.routes[routeIndex].stages);
    routeAction = true;
  }
  if (action === "move-step-down" && stageIndex < state.routes[routeIndex].stages.length - 1 && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) {
    [state.routes[routeIndex].stages[stageIndex + 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex + 1]];
    linkRouteSteps(state.routes[routeIndex].stages);
    routeAction = true;
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
  if (routeAction) {
    markRoutesDirty();
    renderRoutes();
    if (state.drawer) renderStepDrawer();
  } else {
    markTestDirty();
    renderAll();
  }
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
  const routes = selectReferencedRoutes2(runtimeRoutes(), state.rounds).map((route) => ({ ...normalizeRoute(route), stages: route.stages.map((stage) => ({ ...stage, visits: stage.visits.map((visit) => structuredClone(visit)) })) }));
  const cleans = state.cleans.map(runtimeClean);
  const options = { ...state.options };
  if (state.strategy === "schedule-alphago") {
    options.scheduleAlphaGoExecutionMode = playbackMode === "step" ? "stepped" : "continuous";
  }
  return { schemaVersion: EXPECTED_API_SCHEMA, workspaceDeviceId: state.workspaceDeviceId, workspaceTestId: state.testCaseId, deviceName: state.deviceName, device: state.device, strategy: state.strategy, roundCount: state.roundCount, options, skipValidation: skipValidationEnabled(), hongYeCheck: hongYeCheckEnabled(), skipBaseline: skipBaselineEnabled(), recipes: collectRecipes(routes), cleans, routes, rounds: structuredClone(state.rounds) };
}
function skipValidationEnabled() {
  return document.getElementById("skipValidationInput")?.checked === true;
}
function hongYeCheckEnabled() {
  return document.getElementById("hongYeCheckInput")?.checked === true;
}
function skipBaselineEnabled() {
  return document.getElementById("skipBaselineInput")?.checked === true;
}
function validationDisplay(value) {
  if (value === "passed") return "\u901A\u8FC7";
  if (value === "skipped") return "\u8DF3\u8FC7";
  return value ? String(value) : "";
}
async function registerAlgorithmFile(file) {
  const content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const separatorIndex = dataUrl.indexOf(",");
      resolve(separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : "");
    };
    reader.onerror = () => reject(new Error("\u8BFB\u53D6\u7B97\u6CD5\u6587\u4EF6\u5931\u8D25"));
    reader.readAsDataURL(file);
  });
  if (!content) throw new Error("\u8BFB\u53D6\u7B97\u6CD5\u6587\u4EF6\u5931\u8D25");
  const response = await fetch("/api/algorithms/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, content })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
  }
  state.strategy = result.algorithm?.strategy || state.strategy;
  await checkService();
  setWorkspaceStatus(
    `\u5DF2\u767B\u8BB0\u7B97\u6CD5\u201C${result.algorithm?.name || file.name}\u201D\uFF0C\u7B56\u7565 ${state.strategy} \u5DF2\u9009\u4E2D\uFF1B\u5237\u65B0\u9875\u9762\u540E\u4ECD\u4F1A\u4FDD\u7559`,
    "saved"
  );
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
function formatRunElapsed(milliseconds) {
  const totalTenths = Math.max(0, Math.floor(Number(milliseconds || 0) / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor(totalTenths / 10) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
}
function startRunStatus(title, initialLabel = "\u6B63\u5728\u51C6\u5907") {
  const card = document.getElementById("runStatusCard");
  card.classList.remove("failed", "cancelled");
  card.classList.add("running");
  document.getElementById("runStatusTitle").textContent = title;
  runStatusStartedAt = performance.now();
  runStatusElapsedMs = 0;
  renderRunStatusEvents([{ label: initialLabel, status: "running" }]);
  window.clearInterval(runStatusTimer);
  runStatusTimer = window.setInterval(() => {
    runStatusElapsedMs = Math.max(runStatusElapsedMs, performance.now() - runStatusStartedAt);
    document.getElementById("runStatusElapsed").textContent = formatRunElapsed(runStatusElapsedMs);
  }, 100);
}
function renderRunStatusEvents(events) {
  const root = document.getElementById("runStatusEvents");
  const visible = Array.isArray(events) ? events.slice(-6) : [];
  root.replaceChildren(...visible.map((event) => {
    const item = document.createElement("span");
    item.className = `run-status-event ${String(event.status || "")}`;
    const suffix = event.status === "succeeded" ? String(event.label || "").startsWith("\u6536\u5230 ") ? "" : " \u6210\u529F" : event.status === "failed" ? " \u5931\u8D25" : event.status === "running" ? "\u2026" : event.status === "cancelled" ? " \u5DF2\u505C\u6B62" : "";
    item.textContent = `${event.label || "\u5904\u7406\u4E2D"}${suffix}`;
    if (event.detail) item.title = String(event.detail);
    return item;
  }));
}
function renderSingleRunStatus(snapshot) {
  if (!snapshot) return;
  runStatusElapsedMs = Math.max(runStatusElapsedMs, Number(snapshot.elapsedMs || 0));
  document.getElementById("runStatusElapsed").textContent = formatRunElapsed(runStatusElapsedMs);
  const terminal = ["completed", "failed", "cancelled"].includes(snapshot.status);
  const title = snapshot.status === "completed" ? "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5B8C\u6210" : snapshot.status === "failed" ? "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5931\u8D25" : snapshot.status === "cancelled" ? "\u5F53\u524D\u6D4B\u8BD5\u5DF2\u505C\u6B62" : `\u6B63\u5728\u8FD0\u884C \xB7 ${snapshot.testName || state.testCaseName || "\u5F53\u524D\u6D4B\u8BD5"}`;
  document.getElementById("runStatusTitle").textContent = title;
  renderRunStatusEvents(snapshot.events || []);
  if (terminal) finishRunStatus(snapshot.status, title);
}
function renderBatchRunStatus(result) {
  if (!result) return;
  const total = Number(result.testCount || 0);
  const completed = Number(result.completed || 0);
  const running = (result.items || []).filter((item) => item.status === "running").length;
  renderRunStatusEvents([
    { label: `\u5B8C\u6210 ${completed}/${total}`, status: completed === total && total ? "succeeded" : "running" },
    { label: `\u8FD0\u884C\u4E2D ${running}`, status: running ? "running" : "skipped" },
    { label: `\u6210\u529F ${Number(result.succeeded || 0)}`, status: "succeeded" },
    ...Number(result.failed || 0) ? [{ label: `\u5931\u8D25 ${Number(result.failed)}`, status: "failed" }] : []
  ]);
  document.getElementById("runStatusTitle").textContent = `\u6279\u91CF\u6D4B\u8BD5 \xB7 ${state.activeTestGroup || "\u672A\u5206\u7EC4"}`;
}
function finishRunStatus(status, title) {
  window.clearInterval(runStatusTimer);
  runStatusTimer = 0;
  if (runStatusStartedAt) runStatusElapsedMs = Math.max(runStatusElapsedMs, performance.now() - runStatusStartedAt);
  document.getElementById("runStatusElapsed").textContent = formatRunElapsed(runStatusElapsedMs);
  const card = document.getElementById("runStatusCard");
  card.classList.remove("running", "failed", "cancelled");
  if (status === "failed") card.classList.add("failed");
  if (status === "cancelled") card.classList.add("cancelled");
  if (title) document.getElementById("runStatusTitle").textContent = title;
}
async function pollSingleRunStatus(runId) {
  while (singleRunActive && activeSingleRunId === runId) {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (response.ok) {
        const snapshot = await response.json();
        renderSingleRunStatus(snapshot);
        if (["completed", "failed", "cancelled"].includes(snapshot.status)) return;
      }
    } catch {
    }
    await new Promise((resolve) => window.setTimeout(resolve, 180));
  }
}
async function requestSingleRunCancellation() {
  if (!singleRunActive || singleRunCancelling || !activeSingleRunId) return;
  singleRunCancelling = true;
  const button = document.getElementById("runButton");
  button.disabled = true;
  button.classList.add("running", "cancel");
  button.textContent = "\u6B63\u5728\u505C\u6B62\u2026";
  document.getElementById("runStatusTitle").textContent = "\u6B63\u5728\u505C\u6B62\u5F53\u524D\u6D4B\u8BD5";
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(activeSingleRunId)}`, { method: "DELETE" });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    renderSingleRunStatus(snapshot);
    if (state.strategy === "schedule-alphago") {
      try {
        await requestSearchControl("cancel");
      } catch {
      }
    }
    singleRunAbortController?.abort();
  } catch (error) {
    singleRunCancelling = false;
    button.disabled = false;
    button.classList.remove("running");
    button.classList.add("cancel");
    button.textContent = "\u25A0 \u505C\u6B62\u5F53\u524D\u6D4B\u8BD5";
    throw error;
  }
}
async function runPlan() {
  const button = document.getElementById("runButton");
  const stepRunButton = document.getElementById("stepRunButton");
  const batchButton = document.getElementById("batchRunButton");
  const comparisonButton = document.getElementById("openParameterComparisonDialogButton");
  if (singleRunActive) {
    try {
      await requestSingleRunCancellation();
    } catch (error) {
      writeTerminal(`$ \u505C\u6B62\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}
  \u53EF\u518D\u6B21\u70B9\u51FB\u201C\u25A0 \u505C\u6B62\u5F53\u524D\u6D4B\u8BD5\u201D\u91CD\u8BD5\u3002`, true);
    }
    return;
  }
  let logReady = false, ganttReady = false, runResult = null, bottleneckSummary = null;
  const telemetryEnabled = state.strategy === "schedule-alphago";
  let telemetryStopped = false;
  button.disabled = true;
  batchButton.disabled = true;
  comparisonButton.disabled = true;
  button.classList.add("running");
  button.classList.remove("cancel");
  button.textContent = "\u6B63\u5728\u51C6\u5907\u2026";
  startRunStatus(`\u51C6\u5907\u8FD0\u884C \xB7 ${state.testCaseName || "\u5F53\u524D\u6D4B\u8BD5"}`, "\u68C0\u67E5\u670D\u52A1\u4E0E\u6D4B\u8BD5\u914D\u7F6E");
  try {
    const healthResponse = await fetch("/api/health", { cache: "no-store" }), health = await healthResponse.json();
    if (!healthResponse.ok || health.schemaVersion !== EXPECTED_API_SCHEMA) throw new Error("\u672C\u5730\u670D\u52A1\u7248\u672C\u8FC7\u65E7\uFF0C\u8BF7\u91CD\u542F scripts/config_editor_server.py");
    if (state.strategy.startsWith("other_alg:")) {
      const algorithm = (health.otherAlgorithms || []).find((item) => item.strategy === state.strategy);
      if (!algorithm?.available) throw new Error(`${state.strategy} \u7B97\u6CD5\u5305\u4E0D\u5B58\u5728\u6216\u5165\u53E3\u4E0D\u5B8C\u6574`);
    } else if (health.strategies?.[state.strategy] === false) {
      throw new Error(health.strategyErrors?.[state.strategy] || `${state.strategy} \u7B56\u7565\u5F53\u524D\u4E0D\u53EF\u7528`);
    }
    if (state.dirty) await saveCurrentTest(true);
    const payload = buildPayload();
    const runId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");
    payload.clientRunId = runId;
    payload.testCaseName = state.testCaseName || "\u5F53\u524D\u6D4B\u8BD5";
    singleRunActive = true;
    singleRunCancelling = false;
    activeSingleRunId = runId;
    singleRunAbortController = new AbortController();
    button.disabled = false;
    batchButton.disabled = true;
    comparisonButton.disabled = true;
    button.classList.remove("running");
    button.classList.add("cancel");
    button.textContent = "\u25A0 \u505C\u6B62\u5F53\u524D\u6D4B\u8BD5";
    startRunStatus(`\u6B63\u5728\u8FD0\u884C \xB7 ${payload.testCaseName}`, "\u63D0\u4EA4\u8FD0\u884C\u8BF7\u6C42");
    void pollSingleRunStatus(runId);
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
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: singleRunAbortController.signal
    });
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
    finishRunStatus("completed", "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5B8C\u6210");
  } catch (error) {
    const cancelled = singleRunCancelling || runResult?.cancelled === true || error?.name === "AbortError";
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
      ...ganttReady ? ["  \u5DF2\u4FDD\u7559\u53EF\u56DE\u653E\u7684 MoveList\uFF1B\u88AB RemoveList \u53D6\u6D88\u7684\u52A8\u4F5C\u4F1A\u4EE5\u6D45\u8272\u6807\u8BB0\uFF0C\u53EF\u5728\u7518\u7279\u56FE\u4E2D\u663E\u793A\u6216\u9690\u85CF"] : [],
      ...logReady ? ["  \u590D\u73B0\u65E5\u5FD7\u5DF2\u751F\u6210\uFF0C\u53EF\u70B9\u51FB\u201C\u5BFC\u51FA\u590D\u73B0\u65E5\u5FD7\u201D"] : []
    ].join("\n"), true);
    document.getElementById("metricValidation").textContent = runResult?.metricsAvailable ? runResult.validation === "failed" ? "\u672A\u901A\u8FC7" : validationDisplay(runResult.validation) || "\u5931\u8D25" : "\u5931\u8D25";
    finishRunStatus(cancelled ? "cancelled" : "failed", cancelled ? "\u5F53\u524D\u6D4B\u8BD5\u5DF2\u505C\u6B62" : "\u5F53\u524D\u6D4B\u8BD5\u8FD0\u884C\u5931\u8D25");
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
    singleRunActive = false;
    singleRunCancelling = false;
    activeSingleRunId = "";
    singleRunAbortController = null;
    button.disabled = false;
    button.classList.remove("running", "cancel");
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
    if (state.dirty) await saveCurrentTest(true);
    const tests = (state.workspaceDevice?.tests || []).filter((test) => String(test.group || "").trim() === state.activeTestGroup);
    if (!tests.length) throw new Error("\u5F53\u524D\u6D4B\u8BD5\u7EC4\u6CA1\u6709\u53EF\u8FD0\u884C\u6D4B\u8BD5");
    state.batchRunning = true;
    state.activeBatchId = "";
    state.batchCancelRequested = false;
    state.batchCancelSent = false;
    state.batchResult = null;
    state.selectedBatchTestId = "";
    startRunStatus(`\u6279\u91CF\u6D4B\u8BD5 \xB7 ${state.activeTestGroup || "\u672A\u5206\u7EC4"}`, `\u7B49\u5F85 ${tests.length} \u4E2A\u6D4B\u8BD5`);
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
      body: JSON.stringify({ deviceId: state.workspaceDeviceId, group: state.activeTestGroup, strategy: state.strategy, options: state.options, skipValidation: skipValidationEnabled(), hongYeCheck: hongYeCheckEnabled(), skipBaseline: skipBaselineEnabled() })
    });
    let result = await response.json();
    if (!response.ok || !result.batchId || !Array.isArray(result.items)) throw new Error(result.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    state.activeBatchId = result.batchId;
    showBatchProgress(result);
    renderBatchRunStatus(result);
    if (state.batchCancelRequested) await sendBatchCancellation();
    while (!["completed", "failed", "cancelled"].includes(result.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      const statusResponse = await fetch(`/api/run-batches/${encodeURIComponent(result.batchId)}`, { cache: "no-store" });
      result = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(result.error || `\u670D\u52A1\u8FD4\u56DE ${statusResponse.status}`);
      showBatchProgress(result);
      renderBatchRunStatus(result);
    }
    if (result.status === "cancelled") {
      showBatchProgress(result);
      writeTerminal(`$ \u6279\u91CF\u8C03\u5EA6\u5DF2\u7EC8\u6B62
  \u5DF2\u505C\u6B62\u63D0\u4EA4\u7B49\u5F85\u4E2D\u7684\u6D4B\u8BD5\uFF1B\u4ECD\u5728\u7B97\u6CD5\u5185\u90E8\u6267\u884C\u7684\u4EFB\u52A1\u7ED3\u679C\u5C06\u88AB\u5FFD\u7565\u3002`);
      finishRunStatus("cancelled", "\u6279\u91CF\u6D4B\u8BD5\u5DF2\u505C\u6B62");
      return;
    }
    if (result.status === "failed" && !Array.isArray(result.items)) throw new Error(result.error || "\u6279\u91CF\u4EFB\u52A1\u5931\u8D25");
    showBatchResult(result);
    finishRunStatus(Number(result.failed || 0) ? "failed" : "completed", Number(result.failed || 0) ? "\u6279\u91CF\u6D4B\u8BD5\u5B8C\u6210\uFF08\u6709\u5931\u8D25\uFF09" : "\u6279\u91CF\u6D4B\u8BD5\u8FD0\u884C\u5B8C\u6210");
  } catch (error) {
    writeTerminal(`$ \u6279\u91CF\u8FD0\u884C\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true);
    document.getElementById("metricValidation").textContent = "\u5931\u8D25";
    finishRunStatus("failed", "\u6279\u91CF\u6D4B\u8BD5\u8FD0\u884C\u5931\u8D25");
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
      name: item.testName || `t${index + 1}`,
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
    bindTestGroupExport(panel, summary, result.group || state.activeTestGroup || "\u5F53\u524D\u6D4B\u8BD5\u7EC4");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}
function bindTestGroupExport(panel, summary, groupName) {
  const button = panel?.querySelector("[data-group-export-csv]");
  if (!button) return;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = String(groupName || "\u6D4B\u8BD5\u7EC4").replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([`\uFEFF${testGroupSummaryCsv(summary)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `\u6D4B\u8BD5\u7EC4\u6307\u6807-${safeName}-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
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
function batchItemErrorText(item) {
  const baseline = item.baseline || {};
  if (baseline.status === "failed") return `Baseline \u5931\u8D25\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}`;
  if (item.status === "failed") return `${hasBatchResultMetrics(item) ? "\u6821\u9A8C\u5931\u8D25" : "\u8FD0\u884C\u5931\u8D25"}\uFF1A${item.error || "\u672A\u77E5\u9519\u8BEF"}`;
  if (baseline.status && baseline.status !== "succeeded" && baseline.status !== "skipped") return `Baseline \u5931\u6548\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}`;
  return "";
}
function renderBatchItems(items) {
  const statusLabels = { queued: "\u7B49\u5F85\u4E2D", running: "\u8FD0\u884C\u4E2D", succeeded: "\u6210\u529F", failed: "\u5931\u8D25", cancelled: "\u5DF2\u7EC8\u6B62" };
  document.getElementById("batchResults").innerHTML = items.map((item, index) => {
    const hasMetrics = hasBatchResultMetrics(item);
    const baseline = item.baseline || {}, baselineReady = baseline.status === "succeeded";
    const cpuTime = Number(item.cpuTimeMs);
    const improvement = Number(item.improvementPercent);
    const improvementText = hasMetrics && baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status === "skipped" ? "\u5DF2\u8DF3\u8FC7\u57FA\u7EBF" : baseline.status && baseline.status !== "succeeded" ? "\u65E0\u6709\u6548\u57FA\u7EBF" : "\u63D0\u5347 \u2014";
    const summaryError = batchItemErrorText(item);
    const failed = Boolean(summaryError);
    const summaryNote = item.status === "cancelled" ? "\u8C03\u5EA6\u5DF2\u7EC8\u6B62" : failed ? "" : summaryError;
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
            ${failed ? `<button class="btn danger" type="button" data-batch-error="${index}" aria-label="\u67E5\u770B ${escapeHtml4(displayId)} \u7684\u62A5\u9519\u4FE1\u606F">\u62A5\u9519</button>` : ""}
          </div>
        </div>
        <div class="batch-result-summary">
          <div class="batch-metric-tags" aria-label="\u4E3B\u8981\u6307\u6807">
            <span class="batch-metric-tag makespan" title="Makespan${baselineReady ? `\uFF1BBaseline ${Number(baseline.makespan).toFixed(2)} s` : ""}">${hasMetrics ? `${Number(item.makespan).toFixed(2)} s` : "\u2014 s"}</span>
            <span class="batch-metric-tag ${improvement < 0 ? "loss" : "gain"}">${escapeHtml4(improvementText)}</span>
            <span class="batch-metric-tag cpu">CPU Time ${hasMetrics && Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014"}</span>
          </div>
          ${summaryNote ? `<span class="summary-error" title="${escapeHtml4(summaryNote)}">${escapeHtml4(summaryNote)}</span>` : ""}
        </div>
      </div>`;
  }).join("");
}
function openBatchErrorDialog(index) {
  const item = state.batchResult?.items?.[index];
  if (!item) return;
  const errorText = batchItemErrorText(item) || "\u672A\u77E5\u9519\u8BEF";
  document.getElementById("batchErrorDialogContext").textContent = `${item.testName || `\u6D4B\u8BD5 ${index + 1}`} \xB7 ${item.status === "failed" ? "\u8FD0\u884C\u5931\u8D25" : "\u57FA\u7EBF\u5F02\u5E38"}`;
  document.getElementById("batchErrorDialogContent").textContent = errorText;
  document.getElementById("batchErrorDialog").showModal();
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
    const triggerLabel = round.trigger === "cjob-cycle" ? "CJobCycle \u8865\u7247\u91CD\u7B97" : "\u5B9A\u65F6\u91CD\u7B97";
    const timing = Math.abs(recoveryEnd - request) > 1e-6 ? `@${request}s ${triggerLabel} \xB7 \u56FA\u5B9A\u65E7\u52A8\u4F5C\u6536\u5C3E\u81F3 @${recoveryEnd}s` : `@${request}s ${triggerLabel}`;
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
    runButton.disabled = !compatible || singleRunCancelling || state.batchRunning;
    batchRunButton.disabled = !compatible || singleRunActive || state.batchRunning && state.batchCancelRequested;
    comparisonButton.disabled = !compatible || state.batchRunning || !state.parameterComparison?.baseline;
    document.getElementById("stepRunButton").disabled = stepRunActive ? false : !compatible || state.strategy !== "schedule-alphago";
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
var batchErrorDialog = document.getElementById("batchErrorDialog");
document.getElementById("batchErrorDialogClose").addEventListener("click", () => batchErrorDialog.close());
document.getElementById("batchErrorDialogConfirm").addEventListener("click", () => batchErrorDialog.close());
document.getElementById("batchErrorDialogCopy").addEventListener("click", async () => {
  const content = document.getElementById("batchErrorDialogContent")?.textContent || "";
  try {
    await navigator.clipboard.writeText(content);
  } catch {
  }
});
batchErrorDialog.addEventListener("click", (event) => {
  if (event.target === batchErrorDialog) batchErrorDialog.close();
});
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
var bottleneckAnalysisHelpDialog = document.getElementById("bottleneckAnalysisHelpDialog");
document.getElementById("bottleneckAnalysisHelpDialogClose").addEventListener("click", () => bottleneckAnalysisHelpDialog.close());
var residenceAnalysisHelpDialog = document.getElementById("residenceAnalysisHelpDialog");
document.getElementById("residenceAnalysisHelpDialogClose").addEventListener("click", () => residenceAnalysisHelpDialog.close());
document.getElementById("visualPerformance").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("#bottleneckAnalysisHelpButton") && !bottleneckAnalysisHelpDialog.open) {
    bottleneckAnalysisHelpDialog.showModal();
  }
  if (event.target.closest("#residenceAnalysisHelpButton") && !residenceAnalysisHelpDialog.open) {
    residenceAnalysisHelpDialog.showModal();
  }
});
document.getElementById("visualPerformance").addEventListener("change", (event) => {
  const select = event.target instanceof HTMLSelectElement && event.target.id === "residenceMetricSelect" ? event.target : null;
  if (!select) return;
  const performancePanel = event.currentTarget;
  if (!(performancePanel instanceof HTMLElement)) return;
  const selectedMetric = select.value;
  performancePanel.querySelectorAll("[data-residence-metric-chart]").forEach((chart) => {
    chart.hidden = chart.dataset.residenceMetricChart !== selectedMetric;
  });
  performancePanel.querySelectorAll("[data-residence-summary]").forEach((summary) => {
    summary.hidden = summary.dataset.residenceSummary !== selectedMetric;
  });
});
document.getElementById("bottleneckAnalysisHelpDialog").addEventListener("click", (event) => {
  if (event.target === bottleneckAnalysisHelpDialog) bottleneckAnalysisHelpDialog.close();
});
document.getElementById("residenceAnalysisHelpDialog").addEventListener("click", (event) => {
  if (event.target === residenceAnalysisHelpDialog) residenceAnalysisHelpDialog.close();
});
document.getElementById("pjobRouteProcess").addEventListener("change", (event) => renderPJobRouteDialogGroup(event.target.value));
document.getElementById("pjobRouteParallel").addEventListener("change", (event) => renderPJobRouteDialogGroup(pjobRoutePickerContext?.processKey, event.target.value));
document.getElementById("routeProcessFilter").addEventListener("change", (event) => {
  state.routeProcessFilter = event.target.value;
  state.routeParallelFilter = "";
  renderRoutes();
});
document.getElementById("routeParallelFilter").addEventListener("change", (event) => {
  state.routeParallelFilter = event.target.value;
  renderRoutes();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.getElementById("pjobRouteDialog").open && !document.getElementById("drawerLayer").open) {
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
document.getElementById("workspaceImportButton").addEventListener("click", () => openDataTransferDialog("import"));
document.getElementById("workspaceExportButton").addEventListener("click", () => openDataTransferDialog("export"));
document.getElementById("dataTransferDialogClose").addEventListener("click", () => document.getElementById("dataTransferDialog").close());
document.getElementById("deviceTransferOption").addEventListener("click", () => chooseDataTransfer("device"));
document.getElementById("testTransferOption").addEventListener("click", () => chooseDataTransfer("test"));
document.getElementById("dataTransferDialog").addEventListener("click", (event) => {
  if (event.target === document.getElementById("dataTransferDialog")) event.target.close();
});
document.getElementById("deviceFile").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const operation = file.name.toLowerCase().endsWith(".json") ? loadDevice(file) : uploadWorkspaceArchive(file, "device");
  operation.catch((error) => {
    const status = document.getElementById("dataTransferStatus");
    status.textContent = error.message || "\u8BBE\u5907\u5BFC\u5165\u5931\u8D25";
    status.classList.add("error");
    writeTerminal(`$ \u8BBE\u5907\u8BFB\u53D6\u5931\u8D25
  ${error.message}`, true);
  });
});
document.getElementById("testExchangeFile").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  uploadWorkspaceArchive(file, "test").catch((error) => {
    const status = document.getElementById("dataTransferStatus");
    status.textContent = error.message || "\u6D4B\u8BD5\u96C6\u5BFC\u5165\u5931\u8D25";
    status.classList.add("error");
    writeTerminal(`$ \u6D4B\u8BD5\u96C6\u5BFC\u5165\u5931\u8D25
  ${error.message}`, true);
  });
});
document.getElementById("addAlgorithmButton").addEventListener("click", () => document.getElementById("addAlgorithmFileInput").click());
document.getElementById("addAlgorithmFileInput").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
  if (input instanceof HTMLInputElement) input.value = "";
  if (!file) return;
  registerAlgorithmFile(file).catch((error) => writeTerminal(`$ \u6DFB\u52A0\u7B97\u6CD5\u5931\u8D25
  ${error.message || "\u672A\u77E5\u9519\u8BEF"}`, true));
});
document.getElementById("deviceSelect").addEventListener("change", (event) => (async () => {
  if (state.dirty) await saveCurrentTest(true);
  if (state.deviceTimingDirty) await saveDeviceTiming();
  await selectWorkspaceDevice(event.target.value);
})().catch((error) => writeTerminal(`$ \u8BBE\u5907\u5207\u6362\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("deleteDeviceButton").addEventListener("click", () => deleteWorkspaceDevice().catch((error) => {
  setWorkspaceStatus(`\u5220\u9664\u8BBE\u5907\u5931\u8D25\uFF1A${error.message}`, "dirty");
  writeTerminal(`$ \u5220\u9664\u8BBE\u5907\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("saveDeviceTimingButton").addEventListener("click", () => saveDeviceTiming().catch((error) => writeTerminal(`$ \u8BBE\u5907\u65F6\u95F4\u4FDD\u5B58\u5931\u8D25
  ${error.message}`, true)));
document.getElementById("resetDeviceTimingButton").addEventListener("click", () => resetDeviceTimingDraft("\u5DF2\u64A4\u9500\u5C1A\u672A\u4FDD\u5B58\u7684\u65F6\u95F4\u4FEE\u6539"));
document.getElementById("deviceStationSelect").addEventListener("change", (event) => {
  state.deviceStationName = event.target.value;
  renderDeviceStationTiming();
});
document.getElementById("deviceRobotSelect").addEventListener("change", (event) => {
  state.deviceRobotName = event.target.value;
  renderDeviceRobotTiming();
});
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
  if (card && event.key === "Enter") openPJobStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex));
});
document.addEventListener("input", (event) => {
  if (event.target.matches("[data-device-timing-target]")) updateDeviceTimingFromControl(event.target);
  if (event.target.matches("[data-scope], [data-option], [data-time-index], [data-round-time-index]")) updateStateFromControl(event.target);
});
document.addEventListener("change", (event) => {
  const transferSource = event.target.closest?.("[data-robot-transfer-source]");
  if (transferSource) {
    state.deviceRobotTransferSources[transferSource.dataset.robotTransferSource] = transferSource.value;
    renderDeviceRobotTiming();
    return;
  }
  if (event.target.matches("[data-scope], [data-option], [data-time-index], [data-round-time-index]")) {
    updateStateFromControl(event.target);
    if (event.target.dataset.scope === "stage-candidate-toggle") {
      refreshCandidatePicker(event.target);
      return;
    }
    if (["name", "cleanType", "recipeTime", "wacRecipeTime", "jobType", "waferCount", "bufferOption", ...ROUTE_CLEAN_KEYS].includes(event.target.dataset.key) || event.target.dataset.timeIndex !== void 0 || event.target.dataset.roundTimeIndex !== void 0 || ["stage-candidates", "cjob", "pjob"].includes(event.target.dataset.scope)) renderAll();
    else if (state.drawer) {
      renderRoutes();
      renderStepDrawer();
    } else if (["test-step", "test-route"].includes(event.target.dataset.scope)) renderRounds();
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
  const deviceConfigSection = event.target.closest("[data-device-config-section]");
  if (deviceConfigSection) {
    switchDeviceConfigSection(deviceConfigSection.dataset.deviceConfigSection);
    return;
  }
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
  const batchErrorButton = event.target.closest("[data-batch-error]");
  if (batchErrorButton) {
    openBatchErrorDialog(Number(batchErrorButton.dataset.batchError));
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
  if (card) openPJobStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex));
});
window.addEventListener("pagehide", () => {
  if (state.deviceTimingDirty && state.workspaceDeviceId && state.deviceTimingDraft) {
    fetch(`/api/workspaces/${state.workspaceDeviceId}/device-timing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timing: state.deviceTimingDraft }),
      keepalive: true
    }).catch(() => {
    });
  }
  if (state.dirty && state.workspaceDeviceId && state.testCaseId) {
    fetch(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentTestSnapshot()),
      keepalive: true
    }).catch(() => {
    });
  }
});
initializeCompactSelects();
renderAll();
renderWorkspaceControls();
renderDeviceTimingConfiguration();
checkService();
loadWorkspaceCatalog().catch((error) => setWorkspaceStatus(`\u6D4B\u8BD5\u96C6\u8BFB\u53D6\u5931\u8D25\uFF1A${error.message}`, "dirty"));
