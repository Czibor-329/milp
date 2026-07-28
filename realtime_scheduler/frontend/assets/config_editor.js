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

// ../analysis/movelist_performance.ts
var PERFORMANCE_TIME_TOLERANCE = 1e-6;
var MIDDLE_WINDOW_TRIM_RATIO = 0.1;
var MINIMUM_STEADY_WAFERS = 4;
var PICK_MOVE_TYPES = /* @__PURE__ */ new Set([0, 2]);
var PLACE_MOVE_TYPES = /* @__PURE__ */ new Set([1, 3]);
var SWAP_MOVE = 4;
var PRE_TRANS_MOVE = 5;
var PREPARE_MOVE = 6;
var COMPLETE_MOVE = 7;
var PROCESS_MOVE = 9;
var PRE_PREPARE_MOVE = 10;
var CLEAN_MOVE = 14;
var ACTIVITY_CATEGORIES = [
  "process",
  "clean",
  "door",
  "transfer",
  "environment",
  "other"
];
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function listValue(value) {
  return Array.isArray(value) ? value : [];
}
function naturalCompare(left, right) {
  return left.localeCompare(right, void 0, { numeric: true, sensitivity: "base" });
}
function materialIds(move, field = "MatIDList") {
  return listValue(move[field]).map(String).filter(Boolean);
}
function firstStation(move, field) {
  return String(listValue(move[field])[0] ?? "");
}
function moveRobotName(move) {
  return String(move.Robot ?? move.ModuleName ?? "").trim();
}
function isRobotName(name) {
  return /^(ATR|VTR|TM\d*|ROBOT)/i.test(name);
}
function isDummyPortName(name) {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}
function isLoadPortName(name, type = "") {
  return !isDummyPortName(name) && (type.toLowerCase() === "loadport" || /^(LP\d*|P\d+|.*PORT)$/i.test(name));
}
function isLoadLockName(name, type = "") {
  return type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name) || /^BUF_/i.test(name);
}
function isProcessModule(name, type = "") {
  const normalizedType = type.toLowerCase();
  return /process|chamber/.test(normalizedType) || /^(PM|CH)\w*/i.test(name);
}
function normalizeMovePayload(payload) {
  const records = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray(payload.MoveList) ? payload.MoveList : null;
  if (!records) throw new Error("\u6587\u4EF6\u5FC5\u987B\u662F MoveList \u6570\u7EC4\uFF0C\u6216\u5305\u542B MoveList \u5B57\u6BB5\u7684 JSON \u5BF9\u8C61");
  return records.filter((record) => Boolean(record) && typeof record === "object" && !Array.isArray(record)).map((record) => ({ ...record }));
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
  if (moveType === PROCESS_MOVE) return "process";
  if (moveType === CLEAN_MOVE) return "clean";
  if ([PREPARE_MOVE, COMPLETE_MOVE].includes(moveType)) return "door";
  if (moveType === PRE_PREPARE_MOVE || [12, 13].includes(moveType)) return "environment";
  if (PICK_MOVE_TYPES.has(moveType) || PLACE_MOVE_TYPES.has(moveType) || [SWAP_MOVE, 5].includes(moveType)) {
    return "transfer";
  }
  return "other";
}
function activityResourceNames(move) {
  const names = /* @__PURE__ */ new Set();
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
function stationType(device, name) {
  return String(device?.Stations?.[name]?.Type ?? "");
}
function resourceKind(name, type) {
  if (isRobotName(name)) return "robot";
  if (isProcessModule(name, type)) return "process";
  if (isLoadLockName(name, type)) return "loadlock";
  if (isLoadPortName(name, type)) return "loadport";
  return "auxiliary";
}
function performanceResourceDefinitions(moves, device) {
  const referenced = new Set(moves.flatMap(activityResourceNames));
  const resources = /* @__PURE__ */ new Map();
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
    const category = ACTIVITY_CATEGORIES.find((candidate) => active.some((interval) => interval.category === candidate)) ?? "other";
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
    } else if (move.MoveType === SWAP_MOVE) {
      const station = firstStation(move, "StationList");
      if (!isLoadPortName(station, stationType(device, station))) continue;
      for (const material of materialIds(move, "SendMatList")) {
        if (!entries.has(material)) entries.set(material, move.EndTime);
      }
      for (const material of materialIds(move, "RecvMatList")) {
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
function completionInsideWindow(completedAt, window2) {
  return completedAt >= window2.start - PERFORMANCE_TIME_TOLERANCE && completedAt <= window2.end + PERFORMANCE_TIME_TOLERANCE;
}
function processChamberDwellTime(moves, device, window2) {
  const durations = [];
  for (const processMove of moves) {
    const chamber = processMove.ModuleName;
    if (processMove.MoveType !== PROCESS_MOVE || !isProcessModule(chamber, stationType(device, chamber))) continue;
    for (const material of materialIds(processMove)) {
      const removal = moves.find((candidate) => {
        if (candidate.EndTime < processMove.EndTime - PERFORMANCE_TIME_TOLERANCE) return false;
        if (PICK_MOVE_TYPES.has(candidate.MoveType) && firstStation(candidate, "SrcStationList") === chamber && materialIds(candidate).includes(material)) return true;
        return candidate.MoveType === SWAP_MOVE && firstStation(candidate, "StationList") === chamber && materialIds(candidate, "SendMatList").includes(material);
      });
      if (!removal || !completionInsideWindow(removal.EndTime, window2)) continue;
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
function robotWaferDwellTime(moves, window2) {
  const transportByRobot = /* @__PURE__ */ new Map();
  for (const move of moves) {
    if (move.MoveType !== PRE_TRANS_MOVE || move.EndTime <= move.StartTime) continue;
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
      if (!completionInsideWindow(finishedAt, window2)) continue;
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
    if (PICK_MOVE_TYPES.has(move.MoveType)) {
      for (const material of materialIds(move)) {
        holdingStartedAt.set(`${robot}\0${material}`, move.EndTime);
      }
    } else if (PLACE_MOVE_TYPES.has(move.MoveType)) {
      finishHolding(robot, materialIds(move), move.StartTime);
    } else if (move.MoveType === SWAP_MOVE) {
      finishHolding(robot, materialIds(move, "RecvMatList"), move.StartTime);
      for (const material of materialIds(move, "SendMatList")) {
        holdingStartedAt.set(`${robot}\0${material}`, move.EndTime);
      }
    }
  }
  return summarizeDurations(durations);
}
function waferSystemResidenceTime(moves, device, window2) {
  const boundaries = waferBoundaryTimes(moves, device);
  const durations = [];
  for (const [material, completedAt] of boundaries.completions) {
    const enteredAt = boundaries.entries.get(material);
    if (enteredAt === void 0 || completedAt < enteredAt - PERFORMANCE_TIME_TOLERANCE || !completionInsideWindow(completedAt, window2)) continue;
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
    if (!direction || !isLoadLockName(loadLock, stationType(device, loadLock))) continue;
    if (direction === "vacuum") {
      const cycle = {
        index: 0,
        loadLock,
        vacuumWafers: materialIds(move),
        ventWafers: [],
        startedAt: move.StartTime
      };
      cycles.push(cycle);
      pendingByLoadLock.set(loadLock, cycle);
      continue;
    }
    const pending = pendingByLoadLock.get(loadLock);
    if (pending) {
      pending.ventWafers = materialIds(move);
      pendingByLoadLock.delete(loadLock);
      continue;
    }
    cycles.push({
      index: 0,
      loadLock,
      vacuumWafers: [],
      ventWafers: materialIds(move),
      startedAt: move.StartTime
    });
  }
  return cycles.sort((left, right) => left.startedAt - right.startedAt || naturalCompare(left.loadLock, right.loadLock)).map((cycle, index) => ({
    index: index + 1,
    loadLock: cycle.loadLock,
    vacuumWafers: cycle.vacuumWafers,
    ventWafers: cycle.ventWafers
  }));
}
function shortJobName(value) {
  const parts = String(value ?? "").split(".").filter(Boolean);
  return parts.at(-1) ?? "";
}
function processStepId(move) {
  const direct = move.StepID;
  if (direct !== void 0 && direct !== null && String(direct) !== "") return String(direct);
  return String(listValue(move.StepIDList)[0] ?? "");
}
function processPJobName(move) {
  return String(listValue(move.PJobName)[0] ?? move.PJobName ?? "");
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
  const observed = moves.filter((move) => move.MoveType === PROCESS_MOVE && move.EndTime > move.StartTime + PERFORMANCE_TIME_TOLERANCE && processResourceNames.has(move.ModuleName));
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
    const names = [...group.resourceNames].sort(naturalCompare);
    const key = names.join("|");
    const existing = merged.get(key) ?? { resourceNames: names, contextLabels: /* @__PURE__ */ new Set() };
    for (const label of group.contextLabels) existing.contextLabels.add(label);
    merged.set(key, existing);
  }
  return [...merged.values()].map((group) => ({
    resourceNames: group.resourceNames,
    contextLabels: [...group.contextLabels].filter(Boolean).sort(naturalCompare)
  }));
}
function rankBottleneckCandidates(moves, resources, window2, context) {
  if (window2.duration <= PERFORMANCE_TIME_TOLERANCE) return [];
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
      utilization: busyTime / (members.length * window2.duration),
      continuity: members.reduce(
        (sum, resource) => sum + Math.max(0, 1 - resource.longestIdlePeriod / window2.duration),
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
      continuity: Math.max(0, 1 - resource.longestIdlePeriod / window2.duration),
      contextLabels: []
    });
  }
  const loadLocks = resources.filter((item) => item.kind === "loadlock" && item.busyTime > PERFORMANCE_TIME_TOLERANCE);
  if (loadLocks.length) {
    raw.push({
      id: `loadlock:${loadLocks.map((resource) => resource.name).sort(naturalCompare).join("+")}`,
      label: `LoadLock \u5BB9\u91CF\u7EC4 \xB7 ${loadLocks.map((resource) => resource.name).sort(naturalCompare).join(" / ")}`,
      kind: "loadlock-group",
      resourceNames: loadLocks.map((resource) => resource.name).sort(naturalCompare),
      utilization: loadLocks.reduce((sum, resource) => sum + resource.busyTime, 0) / (loadLocks.length * window2.duration),
      continuity: loadLocks.reduce(
        (sum, resource) => sum + Math.max(0, 1 - resource.longestIdlePeriod / window2.duration),
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
  }).sort((left, right) => right.score - left.score || right.utilization - left.utilization || naturalCompare(left.label, right.label));
  if (!ranked.length) return [];
  const topScore = ranked[0].score;
  const likelyThreshold = Math.max(0.2, topScore * 0.72, topScore - 0.16);
  return ranked.filter((candidate) => candidate.score >= likelyThreshold).slice(0, 5);
}
function analyzeSchedulePerformance(moves, device, mode = "steady", context = null) {
  const records = normalizeMoves(moves);
  const window2 = performanceWindow(records, device, mode);
  const definitions = performanceResourceDefinitions(records, device);
  const intervalsByResource = resourceActivityIntervals(records, device);
  const resources = [...definitions.entries()].map(([name, definition]) => {
    const summary = summarizeIntervals(
      intervalsByResource.get(name) ?? [],
      window2.start,
      window2.end
    );
    return {
      name,
      type: definition.type,
      kind: definition.kind,
      utilization: window2.duration > PERFORMANCE_TIME_TOLERANCE ? summary.busyTime / window2.duration : 0,
      ...summary,
      isBottleneck: false,
      bottleneckCandidateRank: null
    };
  });
  const bottleneckCandidates = rankBottleneckCandidates(
    records,
    resources,
    window2,
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
  resources.sort((left, right) => Number(right.isBottleneck) - Number(left.isBottleneck) || kindOrder[left.kind] - kindOrder[right.kind] || right.utilization - left.utilization || naturalCompare(left.name, right.name));
  const boundaries = waferBoundaryTimes(records, device);
  const completionTimes = [...boundaries.completions.values()].filter((time) => time >= window2.start - PERFORMANCE_TIME_TOLERANCE && time <= window2.end + PERFORMANCE_TIME_TOLERANCE).sort((left, right) => left - right);
  const departureIntervals = completionTimes.slice(1).map((time, index) => time - completionTimes[index]);
  const meanDepartureInterval = departureIntervals.length ? departureIntervals.reduce((sum, interval) => sum + interval, 0) / departureIntervals.length : 0;
  const throughputPerHour = meanDepartureInterval > PERFORMANCE_TIME_TOLERANCE ? 3600 / meanDepartureInterval : 0;
  const chamberDwellTime = processChamberDwellTime(records, device, window2);
  const robotDwellTime = robotWaferDwellTime(records, window2);
  const systemResidenceTime = waferSystemResidenceTime(records, device, window2);
  const loadLockCycles = buildLoadLockCycles(records, device);
  return {
    window: window2,
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

// ../analysis/diagnostic_guidance.ts
function percent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}
function seconds(value) {
  return `${Math.max(0, value).toFixed(2)} s`;
}
function candidateDiagnostic(candidate, performance2) {
  const confidence = candidate.confidence === "high" ? "strong" : candidate.confidence === "medium" ? "moderate" : "exploratory";
  if (candidate.kind === "process-group") {
    return {
      title: "\u4F18\u5148\u9A8C\u8BC1\u5DE5\u827A\u5BB9\u91CF\u662F\u5426\u9650\u5236\u8282\u62CD",
      confidence,
      finding: `${candidate.label} \u662F\u5F53\u524D\u6700\u53EF\u80FD\u7684\u5BB9\u91CF\u7EA6\u675F\uFF1B\u5148\u9A8C\u8BC1\u52A0\u5DE5\u65F6\u957F\u53D8\u5316\u662F\u5426\u4F1A\u540C\u6B65\u6539\u53D8\u603B\u4F53\u5B8C\u5DE5\u65F6\u95F4\u3002`,
      evidence: [
        {
          label: "\u5BB9\u91CF\u5229\u7528\u7387",
          value: percent(candidate.utilization),
          interpretation: "\u540C\u7EC4\u5E76\u884C\u8154\u5BA4\u5728\u7EDF\u8BA1\u7A97\u53E3\u5185\u7684\u5E73\u5747\u5FD9\u788C\u7A0B\u5EA6\u3002"
        },
        {
          label: "\u52A0\u5DE5\u540E\u9A7B\u7559",
          value: seconds(performance2.processChamberDwellTime.meanSeconds),
          interpretation: "\u82E5\u540C\u65F6\u504F\u9AD8\uFF0C\u8BF4\u660E\u8154\u5BA4\u91CA\u653E\u8FD8\u53EF\u80FD\u88AB\u4E0B\u6E38\u642C\u8FD0\u963B\u585E\u3002"
        }
      ],
      nextExperiment: {
        id: "processing-time-compare",
        label: "\u5BF9\u6BD4\u52A0\u5DE5\u65F6\u957F\u53D8\u5316",
        change: "\u590D\u5236\u5F53\u524D\u6D4B\u8BD5\uFF0C\u5C0F\u5E45\u8C03\u6574\u52A0\u5DE5\u4E0E\u6E05\u6D01\u65F6\u957F\u540E\u91CD\u65B0\u8FD0\u884C\u5E76\u5BF9\u6BD4\u3002",
        expectedSignal: "\u82E5\u74F6\u9888\u5224\u65AD\u6210\u7ACB\uFF0Cmakespan \u4F1A\u654F\u611F\u4E0A\u5347\uFF0C\u4E14\u8BE5\u8D44\u6E90\u4ECD\u4FDD\u6301\u4E3B\u8981\u5019\u9009\u3002"
      },
      limitation: "\u8FD9\u662F\u7531\u6267\u884C\u8F68\u8FF9\u91CD\u5EFA\u7684\u56E0\u679C\u5047\u8BBE\uFF0C\u4E0D\u662F\u7B97\u6CD5\u5185\u90E8\u5019\u9009\u52A8\u4F5C\u6253\u5206\u3002"
    };
  }
  if (candidate.kind === "robot") {
    return {
      title: "\u4F18\u5148\u9A8C\u8BC1\u642C\u8FD0\u8D44\u6E90\u662F\u5426\u9020\u6210\u6392\u961F",
      confidence,
      finding: `${candidate.label} \u7684\u5360\u7528\u4E0E\u8FDE\u7EED\u5FD9\u788C\u8BC1\u636E\u6700\u5F3A\uFF0C\u53EF\u80FD\u9650\u5236\u5DE5\u827A\u8154\u53CA\u65F6\u4E0A\u4E0B\u7247\u3002`,
      evidence: [
        {
          label: "\u5BB9\u91CF\u5229\u7528\u7387",
          value: percent(candidate.utilization),
          interpretation: "\u4F20\u8F93\u52A8\u4F5C\u5360\u636E\u8BE5\u673A\u5668\u4EBA\u53EF\u670D\u52A1\u7A97\u53E3\u7684\u6BD4\u4F8B\u3002"
        },
        {
          label: "\u624B\u4E0A\u9A7B\u7559",
          value: seconds(performance2.robotWaferDwellTime.meanSeconds),
          interpretation: "\u6676\u5706\u88AB\u53D6\u51FA\u540E\u7B49\u5F85\u653E\u7F6E\u7684\u5E73\u5747\u65F6\u95F4\uFF0C\u5DF2\u5254\u9664\u663E\u5F0F\u8FD0\u8F93\u533A\u95F4\u3002"
        }
      ],
      nextExperiment: {
        id: "release-sequence-review",
        label: "\u5BF9\u6BD4\u642C\u8FD0\u4F18\u5148\u7EA7",
        change: "\u590D\u5236\u5F53\u524D\u6D4B\u8BD5\uFF0C\u4EC5\u8C03\u6574\u91CA\u653E\u6216\u6D3E\u5DE5\u4F18\u5148\u7EA7\u540E\u91CD\u65B0\u8FD0\u884C\u3002",
        expectedSignal: "\u82E5\u642C\u8FD0\u6B21\u5E8F\u662F\u4E3B\u56E0\uFF0C\u673A\u5668\u624B\u9A7B\u7559\u548C\u603B\u4F53\u5B8C\u5DE5\u65F6\u95F4\u5E94\u540C\u6B65\u4E0B\u964D\u3002"
      },
      limitation: "\u5F53\u524D\u53EA\u80FD\u89C2\u5BDF\u5DF2\u6267\u884C\u52A8\u4F5C\uFF0C\u65E0\u6CD5\u5BA3\u79F0\u7B97\u6CD5\u5F53\u65F6\u6CA1\u6709\u8BC4\u4F30\u5176\u4ED6\u53EF\u884C\u52A8\u4F5C\u3002"
    };
  }
  return {
    title: "\u4F18\u5148\u9A8C\u8BC1\u771F\u7A7A\u4EA4\u63A5\u662F\u5426\u9650\u5236\u6D41\u91CF",
    confidence,
    finding: `${candidate.label} \u5728\u62BD\u5145\u6C14\u4E0E\u4EA4\u63A5\u9636\u6BB5\u5F62\u6210\u8F83\u9AD8\u5BB9\u91CF\u5360\u7528\uFF0C\u53EF\u80FD\u653E\u5927\u771F\u7A7A\u7AEF\u7B49\u5F85\u3002`,
    evidence: [
      {
        label: "\u5BB9\u91CF\u5229\u7528\u7387",
        value: percent(candidate.utilization),
        interpretation: "LoadLock \u7EC4\u5728\u7EDF\u8BA1\u7A97\u53E3\u5185\u5904\u7406\u4EA4\u63A5\u5DE5\u4F5C\u7684\u5E73\u5747\u5360\u7528\u3002"
      },
      {
        label: "\u8FDE\u7EED\u6027",
        value: percent(candidate.continuity),
        interpretation: "\u53CD\u6620 LoadLock \u5BB9\u91CF\u6D3B\u52A8\u662F\u5426\u6301\u7EED\uFF0C\u8D8A\u9AD8\u8868\u793A\u7A7A\u95F2\u65AD\u70B9\u8D8A\u5C11\u3002"
      }
    ],
    nextExperiment: {
      id: "loadlock-policy-compare",
      label: "\u5BF9\u6BD4 LoadLock \u7BA1\u7406\u7B56\u7565",
      change: "\u4FDD\u6301\u6D4B\u8BD5\u7EC4\u4E0D\u53D8\uFF0C\u4EC5\u5207\u6362 LoadLock \u7BA1\u7406\u5668\u540E\u91CD\u65B0\u8FD0\u884C\u3002",
      expectedSignal: "\u82E5\u4EA4\u63A5\u7B56\u7565\u662F\u4E3B\u56E0\uFF0C\u771F\u7A7A\u7B49\u5F85\u4E0E makespan \u5E94\u540C\u65F6\u53D8\u5316\u3002"
    },
    limitation: "LoadLock \u5360\u7528\u53EF\u80FD\u662F\u4E0A\u6E38\u91CA\u653E\u6216\u4E0B\u6E38\u52A0\u5DE5\u62E5\u585E\u7684\u7ED3\u679C\uFF0C\u9700\u8981\u914D\u5BF9\u5B9E\u9A8C\u533A\u5206\u3002"
  };
}
function diagnoseSchedule(performance2) {
  const diagnostics = performance2.bottleneckCandidates.slice(0, 2).map((candidate) => candidateDiagnostic(candidate, performance2));
  if (performance2.departureIntervalCv >= 0.25) {
    diagnostics.push({
      title: "\u51FA\u7AD9\u8282\u62CD\u6CE2\u52A8\u9700\u8981\u5355\u72EC\u9A8C\u8BC1",
      confidence: performance2.completedWaferCount >= 8 ? "moderate" : "exploratory",
      finding: `\u51FA\u7AD9\u95F4\u9694 CV \u4E3A ${performance2.departureIntervalCv.toFixed(2)}\uFF0C\u5747\u503C\u65E0\u6CD5\u4EE3\u8868\u5C40\u90E8\u62E5\u585E\u6216\u9965\u997F\u3002`,
      evidence: [
        {
          label: "\u51FA\u7AD9\u95F4\u9694 CV",
          value: performance2.departureIntervalCv.toFixed(2),
          interpretation: "\u8D8A\u9AD8\u8868\u793A\u76F8\u90BB\u6676\u5706\u5B8C\u6210\u95F4\u9694\u8D8A\u4E0D\u5747\u5300\u3002"
        },
        {
          label: "\u5B8C\u6574\u6676\u5706\u6837\u672C",
          value: `${performance2.completedWaferCount} \u7247`,
          interpretation: "\u6837\u672C\u8D8A\u5C11\uFF0C\u6CE2\u52A8\u5224\u65AD\u8D8A\u5E94\u89C6\u4F5C\u63A2\u7D22\u6027\u7EBF\u7D22\u3002"
        }
      ],
      nextExperiment: {
        id: "load-level-compare",
        label: "\u8865\u9F50\u8D1F\u8F7D\u68AF\u5EA6\u6D4B\u8BD5",
        change: "\u590D\u5236\u5F53\u524D\u6D4B\u8BD5\uFF0C\u5206\u522B\u964D\u4F4E\u4E0E\u63D0\u9AD8\u6676\u5706\u89C4\u6A21\uFF0C\u518D\u5BF9\u6BD4\u8282\u62CD CV \u4E0E\u541E\u5410\u3002",
        expectedSignal: "\u82E5\u6CE2\u52A8\u6765\u81EA\u5BB9\u91CF\u4E34\u754C\u70B9\uFF0C\u4E2D\u9AD8\u8D1F\u8F7D\u7528\u4F8B\u7684 CV \u4F1A\u6301\u7EED\u5347\u9AD8\u3002"
      },
      limitation: "CV \u53EA\u63CF\u8FF0\u6CE2\u52A8\uFF0C\u4E0D\u76F4\u63A5\u8BF4\u660E\u8C03\u5EA6\u7B56\u7565\u6216\u8BBE\u5907\u5BB9\u91CF\u8C01\u662F\u6839\u56E0\u3002"
    });
  }
  return diagnostics;
}

// src/workspace_visualizer.ts
var PICK_MOVE_TYPES2 = /* @__PURE__ */ new Set([0, 2]);
var PLACE_MOVE_TYPES2 = /* @__PURE__ */ new Set([1, 3]);
var SWAP_MOVE2 = 4;
var PREPARE_MOVE2 = 6;
var COMPLETE_MOVE2 = 7;
var PROCESS_MOVE2 = 9;
var PRE_PREPARE_MOVE2 = 10;
var CLEAN_MOVE2 = 14;
var PLAYBACK_FRAME_INTERVAL_MS = 80;
var DEFAULT_PLAYBACK_SPEED = 4;
var PROCESS_ARC_START_DEGREES = 200;
var PROCESS_ARC_END_DEGREES = 340;
var PROCESS_ARC_CENTER_X_PERCENT = 50;
var PROCESS_ARC_CENTER_Y_PIXELS = 214;
var PROCESS_ARC_RADIUS_X_PERCENT = 38;
var PROCESS_ARC_RADIUS_Y_PIXELS = 156;
var ACTIVITY_CATEGORIES2 = [
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
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function formatSeconds2(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}
function materialIds2(move, field = "MatIDList") {
  return listValue2(move[field]).map(String).filter(Boolean);
}
function firstStation2(move, field) {
  return String(listValue2(move[field])[0] ?? "");
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
function isDoorlessModule(name, type = "") {
  return /^cool(er)?$/i.test(name) || type.toLowerCase() === "cooler" || isDummyPortName2(name);
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
function collectModuleDefinitions(moves, device) {
  const modules = /* @__PURE__ */ new Map();
  const stationDefinitions = device?.Stations ?? {};
  for (const move of moves) {
    const candidates = [
      move.ModuleName,
      ...listValue2(move.SrcStationList),
      ...listValue2(move.DestStationList),
      ...listValue2(move.StationList)
    ].map(String).filter(Boolean);
    for (const name of candidates) {
      if (!isRobotName2(name) && !modules.has(name)) {
        modules.set(name, { type: String(stationDefinitions[name]?.Type ?? "") });
      }
    }
  }
  return modules;
}
function collectRobotNames(moves, device) {
  const names = new Set(Object.keys(device?.Robots ?? {}));
  for (const move of moves) {
    if (isRobotName2(move.ModuleName)) names.add(move.ModuleName);
    const robot = String(move.Robot ?? "");
    if (robot) names.add(robot);
  }
  return [...names].sort(naturalCompare2);
}
function initialMaterialLocations(moves) {
  const locations = /* @__PURE__ */ new Map();
  for (const move of moves) {
    if (move.MoveType === SWAP_MOVE2) {
      const station = String(listValue2(move.StationList)[0] ?? "");
      for (const material of materialIds2(move, "RecvMatList")) {
        if (!locations.has(material)) locations.set(material, move.ModuleName);
      }
      for (const material of materialIds2(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, station);
      }
      continue;
    }
    const source = firstStation2(move, "SrcStationList");
    const destination = firstStation2(move, "DestStationList");
    const fallback = source || (PICK_MOVE_TYPES2.has(move.MoveType) ? move.ModuleName : "") || (PLACE_MOVE_TYPES2.has(move.MoveType) ? move.ModuleName : "") || destination || move.ModuleName;
    for (const material of materialIds2(move)) {
      if (!locations.has(material) && fallback) locations.set(material, fallback);
    }
  }
  return locations;
}
function applyCompletedTransfer(move, locations) {
  if (PICK_MOVE_TYPES2.has(move.MoveType)) {
    for (const material of materialIds2(move)) locations.set(material, move.ModuleName);
    return;
  }
  if (PLACE_MOVE_TYPES2.has(move.MoveType)) {
    const destination = firstStation2(move, "DestStationList");
    if (destination) {
      for (const material of materialIds2(move)) locations.set(material, destination);
    }
    return;
  }
  if (move.MoveType === SWAP_MOVE2) {
    const station = String(listValue2(move.StationList)[0] ?? "");
    for (const material of materialIds2(move, "RecvMatList")) locations.set(material, station);
    for (const material of materialIds2(move, "SendMatList")) locations.set(material, move.ModuleName);
  }
}
function moveProgress(move, time) {
  const duration = move.EndTime - move.StartTime;
  if (duration <= 0) return time >= move.EndTime ? 1 : 0;
  return Math.max(0, Math.min(1, (time - move.StartTime) / duration));
}
function activeTarget(move) {
  return firstStation2(move, "DestStationList") || firstStation2(move, "SrcStationList") || String(listValue2(move.StationList)[0] ?? "") || (!isRobotName2(move.ModuleName) ? move.ModuleName : "");
}
function buildWorkspaceSnapshot(moves, device, requestedTime) {
  const records = normalizeMoves2(moves);
  const endTime = records.reduce((maximum, move) => Math.max(maximum, move.EndTime), 0);
  const time = Math.max(0, Math.min(finiteNumber2(requestedTime), endTime));
  const definitions = collectModuleDefinitions(records, device);
  const robotNames = collectRobotNames(records, device);
  const locations = initialMaterialLocations(records);
  const doorStates = /* @__PURE__ */ new Map();
  const environments = /* @__PURE__ */ new Map();
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
    }
    if (move.MoveType === PREPARE_MOVE2) {
      if (active) doorStates.set(move.ModuleName, "opening");
      else if (completed) doorStates.set(move.ModuleName, "open");
    } else if (move.MoveType === COMPLETE_MOVE2) {
      if (active) doorStates.set(move.ModuleName, "closing");
      else if (completed) doorStates.set(move.ModuleName, "closed");
    } else if (move.MoveType === PRE_PREPARE_MOVE2 && (active || completed)) {
      const currentState = String(move.CurState ?? "");
      const environment = /VTR|VAC/i.test(currentState) ? "\u771F\u7A7A" : /ATR|ATM/i.test(currentState) ? "\u5927\u6C14" : currentState;
      if (environment) environments.set(move.ModuleName, active ? `${environment}\u5207\u6362\u4E2D` : environment);
    }
  }
  const robotTargets = /* @__PURE__ */ new Map();
  for (const move of activeMoves) {
    if (isRobotName2(move.ModuleName)) robotTargets.set(move.ModuleName, activeTarget(move));
  }
  const wafersByLocation = /* @__PURE__ */ new Map();
  for (const [material, location] of locations) {
    if (!location) continue;
    const wafers = wafersByLocation.get(location) ?? [];
    wafers.push(material);
    wafersByLocation.set(location, wafers);
  }
  for (const wafers of wafersByLocation.values()) wafers.sort(naturalCompare2);
  const modules = [...definitions.entries()].map(([name, definition]) => {
    const moduleMoves = activeMoves.filter((move) => move.ModuleName === name || firstStation2(move, "SrcStationList") === name || firstStation2(move, "DestStationList") === name || listValue2(move.StationList).map(String).includes(name));
    const primaryMove = moduleMoves.find((move) => move.MoveType === CLEAN_MOVE2) ?? moduleMoves.find((move) => move.MoveType === PROCESS_MOVE2) ?? moduleMoves.find((move) => move.MoveType === PRE_PREPARE_MOVE2) ?? moduleMoves.find((move) => [PREPARE_MOVE2, COMPLETE_MOVE2].includes(move.MoveType)) ?? moduleMoves[0];
    let status = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove?.MoveType === CLEAN_MOVE2) status = "cleaning";
    else if (primaryMove?.MoveType === PROCESS_MOVE2) status = "processing";
    else if (primaryMove?.MoveType === PRE_PREPARE_MOVE2) status = "environment";
    else if (primaryMove && [PREPARE_MOVE2, COMPLETE_MOVE2].includes(primaryMove.MoveType)) status = "door";
    else if (primaryMove) status = "transfer";
    return {
      name,
      type: definition.type,
      status,
      door: doorStates.get(name) ?? "closed",
      wafers: wafersByLocation.get(name) ?? [],
      activeMoveName: primaryMove ? MOVE_NAMES[primaryMove.MoveType] ?? `\u52A8\u4F5C ${primaryMove.MoveType}` : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      isRobotTarget: [...robotTargets.values()].includes(name)
    };
  }).sort((left, right) => naturalCompare2(left.name, right.name));
  const robots = robotNames.map((name) => {
    const move = activeMoves.find((record) => record.ModuleName === name);
    return {
      name,
      wafers: wafersByLocation.get(name) ?? [],
      busy: Boolean(move),
      target: robotTargets.get(name) ?? "",
      activeMoveName: move ? MOVE_NAMES[move.MoveType] ?? `\u52A8\u4F5C ${move.MoveType}` : ""
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
    waferCount: new Set(records.flatMap((move) => materialIds2(move))).size
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
    content: required("visualContent"),
    topologyPlayback: required("visualTopologyPlayback"),
    topologyToggle: required("visualTopologyToggle"),
    stage: required("visualDeviceStage"),
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
function topologyGroups(modules) {
  const loadLocks = modules.filter((module) => isLoadLockName2(module.name, module.type));
  const loadPorts = modules.filter((module) => isLoadPortName2(module.name, module.type));
  const processModules = modules.filter((module) => isProcessModule2(module.name, module.type));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map((module) => module.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter((module) => !assignedNames.has(module.name))
  };
}
function renderModule(module, role) {
  const waferLimit = 3;
  const wafers = module.wafers.slice(0, waferLimit).map((wafer) => `<span class="wafer-token" title="\u6676\u5706 ${escapeHtml(wafer)}">${escapeHtml(wafer)}</span>`).join("");
  const overflow = module.wafers.length > waferLimit ? `<span class="wafer-more">+${module.wafers.length - waferLimit}</span>` : "";
  const progress = Math.round(module.progress * 100);
  const accessibleStatus = `${module.name}\uFF0C${STATUS_LABELS[module.status]}\uFF0C${DOOR_LABELS[module.door]}`;
  return `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.isRobotTarget ? "is-target" : ""}" aria-label="${escapeHtml(accessibleStatus)}">
      <div class="equipment-gate" aria-hidden="true"><span></span></div>
      <div class="equipment-head">
        <strong>${escapeHtml(module.name)}</strong>
        <span class="equipment-status"><i></i>${escapeHtml(STATUS_LABELS[module.status])}</span>
      </div>
      <div class="equipment-body">
        <div class="wafer-stack">${wafers || '<span class="wafer-empty">\u7A7A\u8154</span>'}${overflow}</div>
        ${module.environment ? `<span class="environment-state">${escapeHtml(module.environment)}</span>` : ""}
      </div>
      <div class="equipment-foot">
        <span class="door-state"><i></i>${escapeHtml(DOOR_LABELS[module.door])}</span>
        <span>${escapeHtml(module.activeMoveName || "\u7B49\u5F85")}${module.activeMoveName ? ` \xB7 ${progress}%` : ""}</span>
      </div>
      <div class="equipment-progress"><span style="transform:scaleX(${module.activeMoveName ? module.progress : 0})"></span></div>
    </article>`;
}
function renderRobotHub(robot, environment) {
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" aria-label="${escapeHtml(robot.name)} ${robot.busy ? "\u5DE5\u4F5C\u4E2D" : "\u5F85\u547D"}">
      <div class="robot-hub-icon">${icon("robot")}</div>
      <strong>${escapeHtml(robot.name)}</strong>
      <span>${environment === "vacuum" ? "\u771F\u7A7A\u4F20\u8F93\u533A" : "\u5927\u6C14\u4F20\u8F93\u533A"}</span>
      <small>${escapeHtml(robot.busy ? `${robot.activeMoveName}${robot.target ? ` \u2192 ${robot.target}` : ""}` : "\u5F85\u547D")}</small>
      <div class="robot-wafers">${robot.wafers.map((wafer) => `<span class="wafer-token">${escapeHtml(wafer)}</span>`).join("")}</div>
    </article>`;
}
function processModulePosition(index, count) {
  const progress = count <= 1 ? 0.5 : index / (count - 1);
  const degrees = PROCESS_ARC_START_DEGREES + (PROCESS_ARC_END_DEGREES - PROCESS_ARC_START_DEGREES) * progress;
  const radians = degrees * Math.PI / 180;
  const left = PROCESS_ARC_CENTER_X_PERCENT + Math.cos(radians) * PROCESS_ARC_RADIUS_X_PERCENT;
  const top = PROCESS_ARC_CENTER_Y_PIXELS + Math.sin(radians) * PROCESS_ARC_RADIUS_Y_PIXELS;
  return `--module-left:${left.toFixed(2)}%;--module-top:${top.toFixed(2)}px;--module-order:${index}`;
}
function renderEquipmentTopology(snapshot) {
  const groups = topologyGroups(snapshot.modules);
  const vacuumRobot = snapshot.robots.find((robot) => /^(VTR|TM\d*)/i.test(robot.name));
  const atmosphereRobot = snapshot.robots.find((robot) => /^ATR/i.test(robot.name));
  const assignedRobots = new Set([vacuumRobot?.name, atmosphereRobot?.name].filter(Boolean));
  const additionalRobots = snapshot.robots.filter((robot) => !assignedRobots.has(robot.name));
  const leftAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 0);
  const rightAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 1);
  return `
    <section class="equipment-schematic" aria-label="\u5F53\u524D MoveList \u4F7F\u7528\u7684\u8BBE\u5907\u62D3\u6251">
      <div class="schematic-head">
        <div><strong>\u8BBE\u5907\u62D3\u6251</strong><span>\u4EC5\u663E\u793A\u5F53\u524D MoveList \u4F7F\u7528\u7684\u6A21\u5757</span></div>
        <small>${snapshot.modules.length} \u4E2A\u8154\u5BA4 \xB7 ${snapshot.robots.length} \u53F0\u673A\u68B0\u624B</small>
      </div>
      <div class="schematic-canvas">
        <div class="process-ring" aria-label="\u5DE5\u827A\u8154\u5BA4">
          ${groups.processModules.map((module, index) => `
            <div class="process-module-position" style="${processModulePosition(index, groups.processModules.length)}">
              ${renderModule(module, "process")}
            </div>`).join("")}
        </div>
        ${vacuumRobot ? renderRobotHub(vacuumRobot, "vacuum") : '<div class="topology-junction vacuum-junction"><strong>\u771F\u7A7A\u4F20\u8F93\u533A</strong></div>'}
        <div class="load-lock-bank" aria-label="\u771F\u7A7A\u8FC7\u6E21\u8154">
          ${groups.loadLocks.map((module) => renderModule(module, "lock")).join("")}
        </div>
        <div class="atmosphere-deck">
          <div class="auxiliary-bank auxiliary-left">${leftAuxiliary.map((module) => renderModule(module, "auxiliary")).join("")}</div>
          ${atmosphereRobot ? renderRobotHub(atmosphereRobot, "atmosphere") : '<div class="topology-junction atmosphere-junction"><strong>\u5927\u6C14\u4F20\u8F93\u533A</strong></div>'}
          <div class="auxiliary-bank auxiliary-right">${rightAuxiliary.map((module) => renderModule(module, "auxiliary")).join("")}</div>
        </div>
        <div class="load-port-bank" aria-label="\u88C5\u8F7D\u7AEF\u53E3">
          ${groups.loadPorts.map((module) => renderModule(module, "port")).join("")}
        </div>
        ${additionalRobots.length ? `<div class="additional-robot-bank">${additionalRobots.map((robot) => renderRobotHub(robot, "atmosphere")).join("")}</div>` : ""}
      </div>
    </section>`;
}
function waferLabel(value) {
  const material = String(value || "").trim();
  return /^W/i.test(material) ? material : `W${material}`;
}
function renderCycleWafers(wafers) {
  if (!wafers.length) return '<span class="cycle-empty">\u7A7A\u8F7D</span>';
  return wafers.map((wafer) => `<span class="cycle-wafer">${escapeHtml(waferLabel(wafer))}</span>`).join("");
}
function formatPercent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}
function renderSchedulePerformance(performance2) {
  const window2 = performance2.window;
  const bottleneck = performance2.primaryBottleneck;
  const confidenceLabels = { high: "\u8BC1\u636E\u8F83\u5F3A", medium: "\u8BC1\u636E\u4E2D\u7B49", low: "\u8BC1\u636E\u8F83\u5F31" };
  const candidateKindLabels = {
    "process-group": "\u5DE5\u5E8F\u5BB9\u91CF",
    robot: "\u4F20\u8F93\u8D44\u6E90",
    "loadlock-group": "LoadLock \u5BB9\u91CF"
  };
  const displayedResources = displayedPerformanceResources(performance2);
  const resourceKindLabels = {
    robot: "\u673A\u68B0\u624B",
    process: "\u5DE5\u827A\u8154",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "\u8F85\u52A9\u6A21\u5757"
  };
  const legend = ACTIVITY_CATEGORIES2.map((category) => `<span><i class="performance-swatch category-${category}"></i>${ACTIVITY_CATEGORY_LABELS[category]}</span>`).join("");
  const resourceRows = displayedResources.map((resource) => {
    const categoryBars = ACTIVITY_CATEGORIES2.map((category) => {
      const duration = resource.categoryTimes[category];
      if (duration <= PERFORMANCE_TIME_TOLERANCE || window2.duration <= PERFORMANCE_TIME_TOLERANCE) return "";
      const width = Math.min(duration / window2.duration * 100, 100);
      return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds2(duration)} s"></span>`;
    }).join("");
    const status = resource.bottleneckCandidateRank ? `<span class="resource-bottleneck">${resource.bottleneckCandidateRank === 1 ? "\u4E3B\u8981\u5019\u9009" : `\u5019\u9009 #${resource.bottleneckCandidateRank}`}</span>` : "";
    return `
      <tr class="${resource.isBottleneck ? "is-bottleneck" : ""}">
        <th scope="row">
          <div class="resource-heading">
            <span class="resource-name">${escapeHtml(resource.name)}</span>
            <small>${escapeHtml(resourceKindLabels[resource.kind])}</small>
            ${status}
          </div>
        </th>
        <td class="utilization-cell">
          <div class="utilization-line">
            <div class="utilization-value">${formatPercent(resource.utilization)}</div>
          <div class="utilization-track" aria-label="${escapeHtml(resource.name)} \u5360\u7528\u7387 ${formatPercent(resource.utilization)}">${categoryBars}</div>
            <small>${formatSeconds2(resource.busyTime)} s</small>
          </div>
        </td>
        <td class="performance-number">${formatSeconds2(resource.averageActivePeriod)} s <small>${resource.activePeriodCount} \u6BB5</small></td>
        <td class="performance-number">${formatSeconds2(resource.longestIdlePeriod)} s</td>
      </tr>`;
  }).join("");
  const candidateMarkup = performance2.bottleneckCandidates.length ? `<section class="bottleneck-candidates" aria-labelledby="bottleneckCandidatesTitle">
        <div class="bottleneck-candidate-head">
          <div>
            <strong id="bottleneckCandidatesTitle">\u74F6\u9888\u53EF\u80FD\u6027\u6392\u5E8F</strong>
            <span>\u5141\u8BB8\u591A\u4E2A\u5019\u9009\uFF1B\u8BC4\u5206\u4EE5\u5BB9\u91CF\u5229\u7528\u7387\u4E3A\u4E3B\uFF0C\u8FDE\u7EED\u6027\u548C\u540C\u7C7B\u76F8\u5BF9\u5F3A\u5EA6\u4E3A\u8F85\u3002</span>
          </div>
          <small>\u5171 ${performance2.bottleneckCandidates.length} \u4E2A\u8F83\u53EF\u80FD\u5019\u9009</small>
        </div>
        <ol class="bottleneck-candidate-list">
          ${performance2.bottleneckCandidates.map((candidate, index) => `
            <li class="${index === 0 ? "is-primary" : ""}">
              <span class="candidate-rank">${index + 1}</span>
              <div class="candidate-main">
                <div><strong>${escapeHtml(candidate.label)}</strong><span>${escapeHtml(candidateKindLabels[candidate.kind])}</span></div>
                <small>${candidate.evidence.map(escapeHtml).join(" \xB7 ")}</small>
              </div>
              <div class="candidate-metrics">
                <strong>${formatPercent(candidate.utilization)}</strong>
                <span>\u5BB9\u91CF\u5229\u7528\u7387</span>
              </div>
              <div class="candidate-score">
                <strong>${Math.round(candidate.score * 100)}</strong>
                <span>\u53EF\u80FD\u6027\u5206 \xB7 ${confidenceLabels[candidate.confidence]}</span>
              </div>
            </li>`).join("")}
        </ol>
      </section>` : "";
  const cycleMarkup = performance2.loadLockCycles.length ? `<div class="loadlock-cycle-table-wrap">
        <table class="loadlock-cycle-table" aria-label="LoadLock \u62BD\u6C14\u548C\u5145\u6C14\u643A\u7247\u987A\u5E8F">
          <thead><tr><th>\u987A\u5E8F</th><th>LoadLock</th><th>\u62BD\u6C14\u643A\u7247</th><th>\u5145\u6C14\u643A\u7247</th></tr></thead>
          <tbody>${performance2.loadLockCycles.map((cycle) => `
            <tr>
              <td><span class="cycle-index">${cycle.index}</span></td>
              <th scope="row">${escapeHtml(cycle.loadLock)}</th>
              <td><div class="cycle-wafers">${renderCycleWafers(cycle.vacuumWafers)}</div></td>
              <td><div class="cycle-wafers">${renderCycleWafers(cycle.ventWafers)}</div></td>
            </tr>`).join("")}</tbody>
        </table>
      </div>` : '<div class="loadlock-cycle-empty">MoveList \u4E2D\u6CA1\u6709\u8BC6\u522B\u5230 LoadLock \u62BD\u6C14\u6216\u5145\u6C14\u52A8\u4F5C\u3002</div>';
  const diagnostics = diagnoseSchedule(performance2);
  const diagnosticMarkup = diagnostics.length ? `<section class="diagnostic-panel" aria-labelledby="diagnosticPanelTitle">
        <div class="diagnostic-panel-head">
          <div><span>\u8BC1\u636E \u2192 \u5047\u8BBE \u2192 \u5B9E\u9A8C</span><strong id="diagnosticPanelTitle">\u4E0B\u4E00\u6B65\u4F18\u5316\u4ECE\u8FD9\u91CC\u5F00\u59CB</strong></div>
          <small>\u7ED3\u8BBA\u6765\u81EA\u6267\u884C\u8F68\u8FF9\u91CD\u5EFA\uFF0C\u4E0D\u5192\u5145\u7B97\u6CD5\u5185\u90E8\u6253\u5206</small>
        </div>
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
        </div>
      </section>` : "";
  return `
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
    ${candidateMarkup}
    ${diagnosticMarkup}
    <p class="performance-window-note">${escapeHtml(window2.detail)}</p>
    <div class="performance-legend" aria-label="\u5360\u7528\u7EC4\u6210\u56FE\u4F8B">${legend}</div>
    <div class="performance-grid">
      <div class="performance-table-wrap">
        <table class="performance-table" aria-label="\u5F53\u524D\u7EDF\u8BA1\u7A97\u53E3\u5185\u5B9E\u9645\u4F7F\u7528\u8D44\u6E90\u7684\u5360\u7528\u548C\u6D3B\u8DC3\u671F">
          <caption>\u4EC5\u663E\u793A\u5F53\u524D\u7EDF\u8BA1\u7A97\u53E3\u5185\u6709\u5360\u7528\u7684 ${displayedResources.length} \u4E2A\u8D44\u6E90</caption>
          <thead><tr><th>\u8D44\u6E90</th><th>\u8D44\u6E90\u5360\u7528\u7387</th><th>\u5E73\u5747\u6D3B\u8DC3\u671F</th><th>\u6700\u957F\u7A7A\u95F2</th></tr></thead>
          <tbody>${resourceRows}</tbody>
        </table>
      </div>
      <aside class="loadlock-cycle-panel">
        <div class="loadlock-cycle-head">
          <div><strong>LoadLock \u5FAA\u73AF\u987A\u5E8F</strong><span>\u540C\u4E00\u884C\u8868\u793A\u4E00\u6B21\u62BD\u6C14 \u2192 \u5145\u6C14\uFF0C\u53EA\u4FDD\u7559\u643A\u7247\u987A\u5E8F</span></div>
        </div>
        ${cycleMarkup}
      </aside>
    </div>
    `;
}
var VisualizationWorkspace = class {
  root;
  elements;
  device = null;
  analysisContext = null;
  moves = [];
  sourceName = "";
  resultUrl = "";
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
      this.renderPerformance();
    }
  }
  /** 加载浏览器中选择的 MoveList 文件。 */
  async loadFile(file) {
    const payload = JSON.parse(await file.text());
    this.loadMoves(normalizeMovePayload(payload), file.name, "");
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
      this.loadMoves(normalizeMovePayload(payload), sourceName, resultUrl);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  /** 注入路径中的并行工艺腔定义，使未被调度使用的候选腔仍属于正确容量组。 */
  setAnalysisContext(context) {
    this.analysisContext = context ? structuredClone(context) : null;
    if (this.moves.length) this.renderPerformance();
  }
  /** 返回与诊断面板一致的稳态瓶颈候选利用率，供运行结果摘要复用。 */
  getBottleneckUtilization() {
    if (!this.moves.length) return null;
    const performance2 = analyzeSchedulePerformance(
      this.moves,
      this.device,
      this.performanceWindowMode,
      this.analysisContext
    );
    return summarizeBottleneckUtilization(performance2);
  }
  /** 切换到工作台标签。 */
  show() {
    if (this.moves.length) this.showSingleResult();
    const tab = this.root.querySelector('[data-tab-target="workspace"]');
    tab?.click();
    this.elements.performanceWindow.focus({ preventScroll: true });
  }
  /** 显示测试组统计，并完全隐藏当前单例诊断与回放。 */
  showGroupAnalysis(markup) {
    this.pause();
    this.setTopologyVisible(false);
    this.elements.toolbar.hidden = true;
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
    this.sourceName = "";
    this.resultUrl = "";
    this.time = 0;
    this.elements.resultButton.disabled = true;
    this.elements.openGantt.href = "#";
    this.elements.openGantt.setAttribute("aria-disabled", "true");
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.groupAnalysis.innerHTML = "";
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.topologyToggle.disabled = true;
    this.setTopologyVisible(false);
    this.elements.empty.classList.remove("is-loading", "is-error");
    this.elements.empty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 9h8M8 13h5"/></svg>
      <strong>\u7B49\u5F85 MoveList</strong>
      <span>\u8FD0\u884C\u4E00\u6B21\u8BA1\u5212\uFF0C\u6216\u5BFC\u5165\u5DF2\u6709\u7684 MoveList JSON \u6587\u4EF6\u540E\u5F00\u59CB\u56DE\u653E\u3002</span>`;
  }
  /** 接收规范化后的 MoveList 并重置时间轴。 */
  loadMoves(moves, sourceName, resultUrl) {
    if (!moves.length) throw new Error("MoveList \u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u5EFA\u7ACB\u53EF\u89C6\u5316\u56DE\u653E");
    this.pause();
    this.moves = moves;
    this.sourceName = sourceName;
    this.resultUrl = resultUrl;
    const snapshot = buildWorkspaceSnapshot(this.moves, this.device, 0);
    this.time = 0;
    this.elements.range.min = "0";
    this.elements.range.max = String(snapshot.endTime);
    this.elements.range.step = snapshot.endTime > 1e4 ? "1" : "0.1";
    this.elements.range.value = "0";
    this.elements.openGantt.href = resultUrl ? `/movelist_gantt_viewer.html?src=${encodeURIComponent(resultUrl)}` : "#";
    this.elements.openGantt.setAttribute("aria-disabled", resultUrl ? "false" : "true");
    this.elements.resultButton.disabled = false;
    this.elements.topologyToggle.disabled = false;
    this.setTopologyVisible(false);
    this.showSingleResult();
    this.render(snapshot);
    this.renderPerformance();
  }
  /** 绑定文件、时间轴、播放和快捷控制事件。 */
  bindEvents() {
    this.elements.fileInput.addEventListener("change", () => {
      const file = this.elements.fileInput.files?.item(0);
      if (!file) return;
      this.loadFile(file).catch((error) => this.showError(error instanceof Error ? error.message : String(error))).finally(() => {
        this.elements.fileInput.value = "";
      });
    });
    this.elements.range.addEventListener("input", () => {
      this.time = finiteNumber2(this.elements.range.value);
      this.render();
    });
    this.elements.playButton.addEventListener("click", () => {
      if (this.playing) this.pause();
      else this.play();
    });
    this.elements.speed.addEventListener("change", () => {
      this.playbackSpeed = Math.max(0.25, finiteNumber2(this.elements.speed.value, DEFAULT_PLAYBACK_SPEED));
    });
    this.elements.performanceWindow.addEventListener("change", () => {
      this.performanceWindowMode = this.elements.performanceWindow.value === "full" ? "full" : "steady";
      this.renderPerformance();
    });
    this.elements.topologyToggle.addEventListener("click", () => {
      this.setTopologyVisible(this.elements.topologyPlayback.hidden);
    });
    this.elements.resultButton.addEventListener("click", () => this.show());
    this.elements.openGantt.addEventListener("click", (event) => {
      if (this.elements.openGantt.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }
  /** 从当前时间开始播放；到达末尾时自动回到起点。 */
  play() {
    if (!this.moves.length || this.playing) return;
    const endTime = finiteNumber2(this.elements.range.max);
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
    const endTime = finiteNumber2(this.elements.range.max);
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
  }
  /** 将概要、进度控制、拓扑与当前动作作为一个回放单元统一显隐。 */
  setTopologyVisible(visible) {
    if (!visible) this.pause();
    this.elements.topologyPlayback.hidden = !visible;
    this.elements.topologyToggle.setAttribute("aria-expanded", String(visible));
    const label = this.elements.topologyToggle.querySelector("span");
    if (label) label.textContent = visible ? "\u9690\u85CF\u8BBE\u5907\u62D3\u6251" : "\u663E\u793A\u8BBE\u5907\u62D3\u6251";
  }
  /** 绘制当前时间对应的设备快照。 */
  render(prebuiltSnapshot) {
    if (!this.moves.length) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(this.moves, this.device, this.time);
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds2(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds2(snapshot.endTime);
    this.elements.progressText.textContent = snapshot.endTime > 0 ? `${Math.round(snapshot.time / snapshot.endTime * 100)}%` : "0%";
    this.elements.moveText.textContent = `${snapshot.completedMoves} / ${snapshot.totalMoves}`;
    this.elements.waferText.textContent = String(snapshot.waferCount);
    this.elements.range.value = String(snapshot.time);
    this.elements.stage.innerHTML = renderEquipmentTopology(snapshot);
    this.elements.activeMoves.innerHTML = snapshot.activeMoves.length ? snapshot.activeMoves.map((move) => `
        <li>
          <span class="active-move-id">#${finiteNumber2(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber2(move.MoveType, -1)] ?? `\u52A8\u4F5C ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move) || "\u2014")}</span>
          <time>${formatSeconds2(finiteNumber2(move.StartTime))}\u2013${formatSeconds2(finiteNumber2(move.EndTime))} s</time>
        </li>`).join("") : '<li class="active-move-empty">\u5F53\u524D\u65F6\u523B\u6CA1\u6709\u6267\u884C\u4E2D\u7684\u52A8\u4F5C</li>';
  }
  /** 重算并绘制与播放时刻无关的整段排程性能诊断。 */
  renderPerformance() {
    if (!this.moves.length) return;
    const performance2 = analyzeSchedulePerformance(
      this.moves,
      this.device,
      this.performanceWindowMode,
      this.analysisContext
    );
    this.elements.performance.innerHTML = renderSchedulePerformance(performance2);
  }
  /** 显示加载状态并保留明确的系统反馈。 */
  setLoading(loading, message) {
    this.pause();
    this.setTopologyVisible(false);
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.empty.classList.toggle("is-loading", loading);
    this.elements.empty.classList.remove("is-error");
    this.elements.empty.innerHTML = loading ? `<span class="visual-loader" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong>` : `<strong>${escapeHtml(message)}</strong>`;
  }
  /** 在工作台空状态中显示可恢复的错误。 */
  showError(message) {
    this.pause();
    this.setTopologyVisible(false);
    this.elements.toolbar.hidden = false;
    this.elements.groupAnalysis.hidden = true;
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.empty.classList.remove("is-loading");
    this.elements.empty.classList.add("is-error");
    this.elements.empty.innerHTML = `
      <strong>\u65E0\u6CD5\u52A0\u8F7D MoveList</strong>
      <span>${escapeHtml(message)}</span>
      <label class="btn visual-import-button">${icon("upload")}\u91CD\u65B0\u9009\u62E9\u6587\u4EF6<input type="file" accept=".json,application/json" data-visual-retry></label>`;
    const retryInput = this.elements.empty.querySelector("[data-visual-retry]");
    retryInput?.addEventListener("change", () => {
      const file = retryInput.files?.item(0);
      if (file) this.loadFile(file).catch((error) => this.showError(error instanceof Error ? error.message : String(error)));
    });
  }
};
function createVisualizationWorkspace(root = document) {
  return new VisualizationWorkspace(root);
}

// ../analysis/group_performance.ts
var COMPARISON_TOLERANCE_PERCENT = 1e-6;
function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function median(values) {
  return percentile(values, 0.5);
}
function normalizeCase(input) {
  const makespan = finiteOrNull(input.makespan);
  const baselineMakespan = finiteOrNull(input.baselineMakespan);
  const comparable = input.status === "succeeded" && makespan !== null && baselineMakespan !== null && baselineMakespan > 0;
  const improvementPercent = comparable ? (baselineMakespan - makespan) / baselineMakespan * 100 : null;
  const primaryCandidate = input.performance?.primaryBottleneck ?? null;
  const legacyBottleneck = input.performance?.bottleneck ?? null;
  const bottleneckCandidates = input.performance?.bottleneckCandidates?.length ? input.performance.bottleneckCandidates.map((candidate) => ({
    resourceName: candidate.label,
    utilization: candidate.utilization,
    score: candidate.score,
    confidence: candidate.confidence
  })) : legacyBottleneck ? [{
    resourceName: legacyBottleneck.name,
    utilization: legacyBottleneck.utilization,
    score: legacyBottleneck.utilization,
    confidence: ""
  }] : [];
  return {
    id: String(input.id),
    name: String(input.name),
    status: String(input.status || "unknown"),
    validation: String(input.validation || "unknown"),
    validationPassed: input.validation === "passed",
    makespan,
    baselineMakespan,
    comparable,
    improvementPercent,
    performanceRatio: comparable ? makespan / baselineMakespan : null,
    cpuTimeMs: finiteOrNull(input.cpuTimeMs),
    elapsedTimeMs: finiteOrNull(input.elapsedTimeMs),
    bottleneckResource: primaryCandidate?.label ?? legacyBottleneck?.name ?? "",
    bottleneckUtilization: primaryCandidate?.utilization ?? legacyBottleneck?.utilization ?? null,
    bottleneckCandidateCount: input.performance?.bottleneckCandidates?.length ?? (legacyBottleneck ? 1 : 0),
    bottleneckCandidates,
    throughputPerHour: input.performance ? finiteOrNull(input.performance.throughputPerHour) : null,
    departureIntervalCv: input.performance ? finiteOrNull(input.performance.departureIntervalCv) : null,
    processChamberDwellMeanSeconds: input.performance?.processChamberDwellTime?.sampleCount ? finiteOrNull(input.performance.processChamberDwellTime?.meanSeconds) : null,
    robotWaferDwellMeanSeconds: input.performance?.robotWaferDwellTime?.sampleCount ? finiteOrNull(input.performance.robotWaferDwellTime?.meanSeconds) : null,
    waferSystemResidenceMeanSeconds: input.performance?.waferSystemResidenceTime?.sampleCount ? finiteOrNull(input.performance.waferSystemResidenceTime?.meanSeconds) : null,
    waferSystemResidenceCv: input.performance?.waferSystemResidenceTime?.sampleCount ? finiteOrNull(input.performance.waferSystemResidenceTime?.coefficientOfVariation) : null,
    windowMethod: input.performance?.window.method ?? "",
    error: String(input.error || "")
  };
}
function analyzeTestGroupPerformance(inputs) {
  const cases = inputs.map(normalizeCase);
  const succeeded = cases.filter((item) => item.status === "succeeded");
  const comparable = cases.filter((item) => item.comparable);
  const improvements = comparable.map((item) => item.improvementPercent).filter((value) => value !== null);
  const totalMakespan = comparable.reduce(
    (sum, item) => sum + (item.makespan ?? 0),
    0
  );
  const totalBaseline = comparable.reduce(
    (sum, item) => sum + (item.baselineMakespan ?? 0),
    0
  );
  const cpuTimes = succeeded.map((item) => item.cpuTimeMs).filter((value) => value !== null && value >= 0);
  const bottleneckUtilizations = succeeded.map((item) => item.bottleneckUtilization).filter((value) => value !== null);
  const throughputs = succeeded.map((item) => item.throughputPerHour).filter((value) => value !== null && value > 0);
  const departureCvs = succeeded.map((item) => item.departureIntervalCv).filter((value) => value !== null);
  const chamberDwellMeans = succeeded.map((item) => item.processChamberDwellMeanSeconds).filter((value) => value !== null);
  const robotDwellMeans = succeeded.map((item) => item.robotWaferDwellMeanSeconds).filter((value) => value !== null);
  const systemResidenceMeans = succeeded.map((item) => item.waferSystemResidenceMeanSeconds).filter((value) => value !== null);
  const systemResidenceCvs = succeeded.map((item) => item.waferSystemResidenceCv).filter((value) => value !== null);
  const frequencyMap = /* @__PURE__ */ new Map();
  const windowMethodCounts = {};
  for (const item of succeeded) {
    for (const candidate of item.bottleneckCandidates) {
      const values = frequencyMap.get(candidate.resourceName) ?? [];
      values.push(candidate.utilization);
      frequencyMap.set(candidate.resourceName, values);
    }
    if (item.windowMethod) {
      windowMethodCounts[item.windowMethod] = (windowMethodCounts[item.windowMethod] ?? 0) + 1;
    }
  }
  const bottleneckFrequencies = [...frequencyMap.entries()].map(([resourceName, values]) => ({
    resourceName,
    count: values.length,
    share: succeeded.length ? values.length / succeeded.length : 0,
    medianUtilization: median(values) ?? 0
  })).sort((left, right) => right.count - left.count || right.medianUtilization - left.medianUtilization || left.resourceName.localeCompare(right.resourceName, void 0, {
    numeric: true
  }));
  return {
    cases,
    totalCount: cases.length,
    succeededCount: succeeded.length,
    failedCount: cases.length - succeeded.length,
    validationPassedCount: succeeded.filter((item) => item.validationPassed).length,
    validationPassRate: succeeded.length ? succeeded.filter((item) => item.validationPassed).length / succeeded.length : 0,
    comparableCount: comparable.length,
    winCount: improvements.filter((value) => value > COMPARISON_TOLERANCE_PERCENT).length,
    tieCount: improvements.filter(
      (value) => Math.abs(value) <= COMPARISON_TOLERANCE_PERCENT
    ).length,
    regressionCount: improvements.filter(
      (value) => value < -COMPARISON_TOLERANCE_PERCENT
    ).length,
    weightedImprovementPercent: totalBaseline > 0 ? (totalBaseline - totalMakespan) / totalBaseline * 100 : null,
    medianImprovementPercent: median(improvements),
    worstRegressionPercent: improvements.some((value) => value < 0) ? Math.min(...improvements) : null,
    medianCpuTimeMs: median(cpuTimes),
    p90CpuTimeMs: percentile(cpuTimes, 0.9),
    totalCpuTimeMs: cpuTimes.reduce((sum, value) => sum + value, 0),
    medianBottleneckUtilization: median(bottleneckUtilizations),
    medianThroughputPerHour: median(throughputs),
    medianDepartureIntervalCv: median(departureCvs),
    medianProcessChamberDwellMeanSeconds: median(chamberDwellMeans),
    medianRobotWaferDwellMeanSeconds: median(robotDwellMeans),
    medianWaferSystemResidenceMeanSeconds: median(systemResidenceMeans),
    medianWaferSystemResidenceCv: median(systemResidenceCvs),
    bottleneckFrequencies,
    windowMethodCounts
  };
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
      <article><span>\u6821\u9A8C\u901A\u8FC7\u7387</span><strong>${(summary.validationPassRate * 100).toFixed(1)}%</strong><small>${summary.validationPassedCount}/${summary.succeededCount} \u4E2A\u6709\u6548\u7ED3\u679C</small></article>
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
  deviceName: "",
  device: null,
  stationNames: [],
  loadPorts: [],
  processModules: [],
  robotNames: [],
  robotScopes: {},
  strategy: "heuristic",
  availableOtherAlgorithms: [],
  algorithmMetadata: {},
  algorithmHistory: {},
  roundCount: 2,
  times: [0, 70],
  options: { loadLockManager: "petri-look", loadLockMacroSearchSeconds: 4, loadLockMacroRollouts: 96, nnSAEASearchSeconds: 4, nnSAEARollouts: 64, neuralUCBTopK: 2, neuralUCBExploration: 5, rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 },
  cleans: [],
  routes: [{ name: "RouteA", group: "RouteA", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps([makeStage("LP1"), makeStage("Robot"), makeStage("PM1,PM2", true, "RouteA_Step2"), makeStage("Robot"), makeStage("LP1")]) }],
  rounds: [makeRound(1, 0, "RouteA", "LP1"), makeRound(2, 70, "RouteA", "LP2")],
  drawer: null,
  expandedRouteProcessGroups: /* @__PURE__ */ new Set(),
  expandedRouteGroups: /* @__PURE__ */ new Set(),
  expandedRoutes: /* @__PURE__ */ new Set(),
  expandedCleanTypes: /* @__PURE__ */ new Set(),
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
    modules: [],
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
  return normalizeClean({ name: "", cleanType, recipeTime: 20, triggerCount: 5, wacRecipeTime: 20 });
}
function cleanNamesFor(types) {
  const allowed = new Set(types);
  return state.cleans.filter((clean) => allowed.has(inferCleanType(clean))).map((clean) => clean.name).filter(Boolean);
}
function removeCleanReferences(cleanName) {
  state.routes.forEach((route) => {
    for (const key of ["prePJobCleanRefs", "postPJobCleanRefs", "postCJobCleanRefs"]) {
      route[key] = stringList(route[key]).filter((name) => name !== cleanName);
    }
    (route.stages || []).forEach((stage) => (stage.visits || []).forEach((visit) => {
      visit.beforeCleanRefs = stringList(visit.beforeCleanRefs).filter((name) => name !== cleanName);
      visit.afterCleanRefs = stringList(visit.afterCleanRefs).filter((name) => name !== cleanName);
    }));
  });
}
function stageUsesRobot(stage, index) {
  const names = (stage.visits || []).map((visit) => visit.stationName).filter(Boolean);
  return stage.kind === "robot" || (names.length ? names.every((name) => state.robotNames.includes(name)) : index % 2 === 1);
}
function normalizeRoute(route) {
  route.stages = Array.isArray(route.stages) ? route.stages : [];
  ROUTE_CLEAN_KEYS.forEach((key) => {
    route[key] = stringList(route[key]).slice(0, 1);
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
function optionsHtml(values, selected, emptyLabel = "\u8BF7\u9009\u62E9") {
  return `<option value="">${escapeHtml3(emptyLabel)}</option>` + values.map((value) => `<option value="${escapeHtml3(value)}" ${value === selected ? "selected" : ""}>${escapeHtml3(value)}</option>`).join("");
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
function applyDeviceTopology(device, deviceName) {
  const stations = Object.entries(device.Stations);
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  state.device = structuredClone(device);
  state.deviceName = deviceName;
  state.stationNames = stations.map(([name]) => name).sort(natural);
  state.loadPorts = stations.filter(([, item]) => String(item.Type || "").toLowerCase() === "loadport").map(([name]) => name).sort(natural);
  state.processModules = stations.filter(([, item]) => String(item.Type || "").toLowerCase() === "processchamber").map(([name]) => name).sort(natural);
  state.robotNames = Object.keys(device.Robots).sort(natural);
  state.robotScopes = Object.fromEntries(Object.entries(device.Robots).map(([name, robot]) => [name, [...new Set(Object.values(robot.ArmInfo || {}).flatMap((arm) => arm.AccessibleStations || []))]]));
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
    options: { loadLockManager: "petri-look", loadLockMacroSearchSeconds: 4, loadLockMacroRollouts: 96, nnSAEASearchSeconds: 4, nnSAEARollouts: 64, rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 },
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
  document.getElementById("batchRunButton").disabled = !state.serviceCompatible || !visibleTests.length;
  const emptyHint = document.getElementById("emptyGroupHint");
  emptyHint.classList.toggle("visible", Boolean(state.workspaceDeviceId) && !visibleTests.length);
  document.getElementById("emptyGroupNewTestButton").disabled = !state.workspaceDeviceId;
  const deviceType = /PSE300/i.test(state.deviceName) ? "\u5355\u8154\u975E\u7EA7\u8054" : String(state.workspaceDevice?.deviceType || "\u5355\u8154\u975E\u7EA7\u8054");
  document.getElementById("deviceSummary").innerHTML = state.device ? `<span class="chip good">${escapeHtml3(deviceType)}</span>` : `<span class="chip">\u5C1A\u672A\u9009\u62E9\u8BBE\u5907</span>`;
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
  document.getElementById("metricTimeLabel").textContent = "\u603B\u8017\u65F6";
  document.getElementById("metricMakespanLabel").textContent = "Makespan";
  setBottleneckMetric(null);
  document.getElementById("metricValidationLabel").textContent = "\u6821\u9A8C";
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
  state.options = value.options || { loadLockManager: "petri-look", loadLockMacroSearchSeconds: 4, loadLockMacroRollouts: 96, nnSAEASearchSeconds: 4, nnSAEARollouts: 64, neuralUCBTopK: 2, neuralUCBExploration: 5, rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 };
  state.options.loadLockManager = state.options.loadLockManager || "petri-look";
  delete state.options.loadLockExchange;
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
  visualizationWorkspace.setAnalysisContext(
    buildScheduleAnalysisContext(state.routes, state.rounds)
  );
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
  document.getElementById("loadlockOptions").classList.toggle("is-hidden", !["heuristic", "loadlock-macro", "nn-saea", "setrank", "neuralucb", "neural", "rl"].includes(state.strategy));
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
  applyDeviceTopology(result.device.device, result.device.name);
  state.routes = Array.isArray(result.device.routes) ? structuredClone(result.device.routes) : [];
  state.cleans = Array.isArray(result.device.cleans) ? structuredClone(result.device.cleans).map(normalizeClean) : [];
  state.expandedCleanTypes = new Set(state.cleans.map((clean) => clean.cleanType));
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
  if (name === "algorithm-history") renderAlgorithmHistory();
  if (name !== "route") closeStepDrawer();
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
function renderCleans() {
  const host = document.getElementById("cleanList");
  synchronizeCleanNames();
  host.innerHTML = CLEAN_TYPE_DEFINITIONS.map((type) => {
    const rows = state.cleans.map((clean, index) => ({ clean, index })).filter((item) => item.clean.cleanType === type.key);
    const open = state.expandedCleanTypes.has(type.key);
    const cards = rows.map(({ clean, index }) => {
      const conditional = clean.cleanType === "wacclean" ? `<div class="field"><label>\u89E6\u53D1\u6B21\u6570</label><input type="number" min="1" step="1" data-scope="clean" data-index="${index}" data-key="triggerCount" value="${Number(clean.triggerCount)}"></div>` : clean.cleanType === "dummywac" ? `<div class="field"><label>WAC \u6E05\u6D01\u957F\u5EA6\uFF08\u79D2\uFF09</label><input type="number" min="0" step="0.1" data-scope="clean" data-index="${index}" data-key="wacRecipeTime" value="${Number(clean.wacRecipeTime)}"></div>` : "";
      return `<article class="clean-card"><div class="clean-card-title"><strong>${escapeHtml3(clean.name)}</strong><button class="btn danger small" data-action="remove-clean" data-index="${index}">\u5220\u9664</button></div><div class="clean-fields">
        <div class="field"><label>\u6E05\u6D01\u7C7B\u522B</label><select data-scope="clean" data-index="${index}" data-key="cleanType">${CLEAN_TYPE_DEFINITIONS.map((option) => `<option value="${option.key}" ${option.key === clean.cleanType ? "selected" : ""}>${escapeHtml3(option.label)}</option>`).join("")}</select></div>
        <div class="field"><label>\u6E05\u6D01\u65F6\u95F4\uFF08\u79D2\uFF09</label><input type="number" min="0" step="0.1" data-scope="clean" data-index="${index}" data-key="recipeTime" value="${Number(clean.recipeTime)}"></div>
        ${conditional}
      </div></article>`;
    }).join("");
    return `<section class="clean-type-group"><button class="clean-type-head" data-action="toggle-clean-type" data-clean-type="${type.key}"><span class="collapse-arrow ${open ? "open" : ""}">\u25B6</span><strong>${escapeHtml3(type.label)}</strong><span class="route-count">${rows.length} \u4E2A \xB7 ${open ? "\u5DF2\u5C55\u5F00" : "\u5DF2\u6536\u8D77"}</span></button>${open ? `<div class="clean-type-body">${cards || `<div class="clean-type-empty">\u6682\u65E0 ${escapeHtml3(type.label)}</div>`}</div>` : ""}</section>`;
  }).join("");
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
  const preCleans = cleanNamesFor(["preclean", "dummy", "dummywac"]);
  const postCleans = cleanNamesFor(["postclean"]);
  return `<div class="route-details"><div class="edit-card-head"><strong>\u8DEF\u5F84\u8BE6\u60C5</strong><div><button class="btn small" data-action="add-stage" data-index="${index}">\uFF0B Step \u7EC4</button> <button class="btn danger small" data-action="remove-route" data-index="${index}">\u5220\u9664</button></div></div>
    <div class="route-meta"><div class="route-meta-grid"><div class="field"><label>\u8DEF\u5F84\u540D\u79F0\uFF08\u81EA\u52A8\u751F\u6210\uFF09</label><input value="${escapeHtml3(route.name)}" readonly></div><div class="field"><label>Group</label><input data-scope="route" data-index="${index}" data-key="group" value="${escapeHtml3(route.group)}"></div><div class="field"><label>BufferOption</label><input type="number" min="0" max="4" step="1" data-scope="route" data-index="${index}" data-key="bufferOption" value="${Number(route.bufferOption)}"><small class="field-help">\u4EC5\u9650\u5236\u63A5\u53E3\u679A\u4E3E\u8303\u56F4\uFF0C\u6682\u4E0D\u81EA\u52A8\u4FEE\u6539\u8DEF\u5F84\u3002</small></div></div>
    <details class="route-clean-details"><summary>\u8DEF\u5F84\u7EA7 Clean \u8BBE\u7F6E</summary><div class="grid"><div class="field span-4"><label>PJob \u524D</label><select data-scope="route" data-index="${index}" data-key="prePJobCleanRefs">${optionsHtml(preCleans, stringList(route.prePJobCleanRefs)[0] || "", "\u4E0D\u9700\u8981\u6E05\u6D01")}</select></div><div class="field span-4"><label>PJob \u540E</label><select data-scope="route" data-index="${index}" data-key="postPJobCleanRefs">${optionsHtml(postCleans, stringList(route.postPJobCleanRefs)[0] || "", "\u4E0D\u9700\u8981\u6E05\u6D01")}</select></div><div class="field span-4 disabled-field"><label>CJob \u540E</label><select disabled><option>\u5F53\u524D\u7B97\u6CD5\u4E0D\u652F\u6301 PostCJob Clean</option></select></div></div></details></div>
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
        <div class="route-summary-actions"><button class="btn small" data-action="edit-route" data-route-index="${routeIndex}">\u7F16\u8F91</button><button class="btn small" data-action="copy-route" data-route-index="${routeIndex}">\u590D\u5236</button><button class="btn danger small" data-action="remove-route" data-index="${routeIndex}">\u5220\u9664</button></div>
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
function renderAfterCleanChoices(first, routeIndex, stageIndex) {
  const selected = new Set(stringList(first.afterCleanRefs));
  const choices = cleanNamesFor(["postclean", "wacclean"]);
  const noCleanActive = selected.size === 0;
  const cleanButtons = choices.map((name) => `<button type="button" class="clean-choice ${selected.has(name) ? "active" : ""}" data-action="toggle-after-clean" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-clean-name="${escapeHtml3(name)}" aria-pressed="${selected.has(name)}"><span class="clean-choice-indicator" aria-hidden="true">\u2713</span><span>${escapeHtml3(name)}</span></button>`).join("");
  return `<fieldset class="step-edit-field after-clean-field">
    <legend>After Clean</legend>
    <div class="clean-choice-list">
      <button type="button" class="clean-choice no-clean ${noCleanActive ? "active" : ""}" data-action="toggle-after-clean" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-clean-name="" aria-pressed="${noCleanActive}"><span class="clean-choice-indicator" aria-hidden="true">\u2713</span><span>No Clean</span></button>
      ${cleanButtons || `<span class="clean-choice-empty">\u6682\u65E0\u53EF\u7528\u7684 PostClean / WAC Clean</span>`}
    </div>
    <small class="field-help">\u53EF\u9009\u62E9\u591A\u4E2A\u6E05\u6D01\uFF1B\u9009\u62E9 No Clean \u5C06\u6E05\u7A7A\u5F53\u524D\u9009\u62E9\u3002</small>
  </fieldset>`;
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
  const editableFieldLabels = { processTime: "Process Time", qTimeLimit: "QTime", residencyConstraint: "Residency", afterCleanRefs: "After Clean" };
  const differences = visitDifferenceFields(stage).filter((field) => editableFieldLabels[field]);
  const candidates = [...new Set(stage.visits.map((visit) => visit.stationName).filter(Boolean))];
  const differenceNames = differences.map((field) => editableFieldLabels[field] || field);
  const warning = differences.length ? `<div class="visit-warning" role="status"><strong>\u5019\u9009\u8154\u5BA4\u7684\u53EF\u7F16\u8F91\u53C2\u6570\u4E0D\u4E00\u81F4</strong><p>\u5DEE\u5F02\u9879\uFF1A${differenceNames.map(escapeHtml3).join("\u3001")}\u3002\u5F53\u524D\u663E\u793A\u9996\u4E2A\u5019\u9009\u7684\u503C\u3002</p><button class="btn small" data-action="sync-stage-visits" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u540C\u6B65\u5230\u5168\u90E8\u5019\u9009</button></div>` : "";
  const editor = first ? `<section class="step-editor-card" aria-labelledby="stepEditorHeading">
    <header class="step-editor-head"><div><h3 id="stepEditorHeading">\u53EF\u7F16\u8F91\u53C2\u6570</h3><p>\u4FEE\u6539\u540E\u81EA\u52A8\u540C\u6B65\u5230 ${stage.visits.length} \u4E2A\u5019\u9009\u8154\u5BA4</p></div><span class="editable-badge">4 \u9879</span></header>
    <div class="step-edit-grid">
      ${renderStepNumberField("Process Time", "processTime", first.processTime, routeIndex, stageIndex, { minimum: 0, helper: "Recipe Time \u5C06\u81EA\u52A8\u4FDD\u6301\u4E00\u81F4" })}
      ${renderStepNumberField("QTime", "qTimeLimit", first.qTimeLimit, routeIndex, stageIndex)}
      ${renderStepNumberField("Residency", "residencyConstraint", first.residencyConstraint, routeIndex, stageIndex)}
      ${renderAfterCleanChoices(first, routeIndex, stageIndex)}
    </div>
  </section>
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
    <p class="system-note">Before Clean \u7531\u7CFB\u7EDF\u7BA1\u7406\uFF0C\u4E0D\u5728 RouteStep \u4E2D\u914D\u7F6E\u3002</p>
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
function renderAll() {
  renderTimes();
  renderCleans();
  renderRoutes();
  renderRounds();
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
    state.options[control.dataset.option] = value;
    return;
  }
  const scope = control.dataset.scope;
  if (scope === "clean") {
    const cleanIndex = Number(control.dataset.index), clean = state.cleans[cleanIndex];
    if (key === "cleanType" && clean.cleanType !== value) {
      removeCleanReferences(clean.name);
      clean.cleanType = value;
      state.expandedCleanTypes.add(value);
    } else clean[key] = value;
    state.cleans[cleanIndex] = normalizeClean(clean);
  }
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
  if (action === "toggle-clean-type") {
    const cleanType = button.dataset.cleanType;
    if (state.expandedCleanTypes.has(cleanType)) state.expandedCleanTypes.delete(cleanType);
    else state.expandedCleanTypes.add(cleanType);
    renderCleans();
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
  if (action === "toggle-after-clean") {
    const stage = state.routes[routeIndex]?.stages[stageIndex];
    if (!stage?.visits?.length) return;
    const cleanName = button.dataset.cleanName || "";
    const selected = new Set(stringList(stage.visits[0].afterCleanRefs));
    if (!cleanName) selected.clear();
    else if (selected.has(cleanName)) selected.delete(cleanName);
    else selected.add(cleanName);
    stage.visits[0].afterCleanRefs = [...selected];
    synchronizeStageVisits(stage);
    markTestDirty();
    renderRoutes();
    renderStepDrawer();
    return;
  }
  if (action === "add-clean") {
    const clean = makeClean("preclean");
    state.cleans.push(clean);
    state.expandedCleanTypes.add(clean.cleanType);
  }
  if (action === "remove-clean") {
    removeCleanReferences(state.cleans[index]?.name);
    state.cleans.splice(index, 1);
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
      const stateVariable = String(cleanByName.get(cleanName)?.stateVariable || "").trim();
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
  const cleanModules = /* @__PURE__ */ new Map();
  function addCleanModules(names, modules) {
    stringList(names).forEach((name) => {
      const targets = cleanModules.get(name) || /* @__PURE__ */ new Set();
      stringList(modules).forEach((module) => targets.add(module));
      cleanModules.set(name, targets);
    });
  }
  routes.forEach((route) => {
    const routeModules = [...new Set((route.stages || []).flatMap((stage) => (stage.visits || []).filter((visit) => state.processModules.includes(visit.stationName)).map((visit) => visit.stationName)))];
    addCleanModules(route.prePJobCleanRefs, routeModules);
    addCleanModules(route.postPJobCleanRefs, routeModules);
    addCleanModules(route.postCJobCleanRefs, routeModules);
    (route.stages || []).forEach((stage) => (stage.visits || []).forEach((visit) => {
      if (!state.processModules.includes(visit.stationName)) return;
      addCleanModules(visit.beforeCleanRefs, [visit.stationName]);
      addCleanModules(visit.afterCleanRefs, [visit.stationName]);
    }));
  });
  state.cleans.map(runtimeClean).forEach((clean) => {
    const modules = [...cleanModules.get(clean.name) || []];
    add(clean.recipeRef, clean.recipeTime, modules);
    if (clean.cleanType === "dummywac") add(clean.emptyRecipeRef, clean.wacRecipeTime, modules);
  });
  return recipes;
}
function buildPayload() {
  normalizeRounds();
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
    <span class="algorithm-hover-info-meta"><span>\u5F53\u524D\u7248\u672C ${escapeHtml3(metadata.version || "\u672A\u8BB0\u5F55")}</span><span>\u66F4\u65B0\u65E5\u671F ${escapeHtml3(metadata.updatedAt || "\u672A\u8BB0\u5F55")}</span></span>
  `;
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
  const strategySelect = document.getElementById("algorithmDialogStrategy");
  const strategies = [...document.querySelectorAll('input[name="strategy"]')].map((input) => input.value);
  strategySelect.innerHTML = strategies.map((strategy) => {
    const name = state.algorithmMetadata[strategy]?.name || document.querySelector(`[data-strategy-card="${CSS.escape(strategy)}"] b`)?.textContent || strategy;
    return `<option value="${escapeHtml3(strategy)}">${escapeHtml3(name)}</option>`;
  }).join("");
}
function algorithmChangeLabels(entry, previous) {
  if (!previous) return ["\u521D\u59CB\u8BB0\u5F55"];
  const labels = [];
  if (entry.version !== previous.version) labels.push(`\u7248\u672C ${previous.version || "\u672A\u8BB0\u5F55"} \u2192 ${entry.version || "\u672A\u8BB0\u5F55"}`);
  if (entry.description !== previous.description) labels.push("\u7B97\u6CD5\u63CF\u8FF0\u5DF2\u66F4\u65B0");
  if (entry.updatedAt !== previous.updatedAt) labels.push("\u66F4\u65B0\u65E5\u671F\u5DF2\u8C03\u6574");
  return labels.length ? labels : ["\u91CD\u590D\u4FDD\u5B58\uFF0C\u65E0\u5B57\u6BB5\u53D8\u5316"];
}
function renderAlgorithmHistory() {
  const container = document.getElementById("algorithmHistoryList");
  const strategies = [...document.querySelectorAll('input[name="strategy"]')].map((input) => input.value);
  container.innerHTML = strategies.map((strategy) => {
    const metadata = state.algorithmMetadata[strategy] || {};
    const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(strategy)}"] b`)?.textContent;
    const history = Array.isArray(state.algorithmHistory[strategy]) ? state.algorithmHistory[strategy] : [];
    const entries = history.map((entry, index) => ({
      entry,
      changes: algorithmChangeLabels(entry, history[index - 1])
    })).reverse();
    const timeline = entries.length ? `<div class="algorithm-timeline">${entries.map(({ entry, changes }) => `
      <article class="algorithm-version-entry">
        <div class="algorithm-version-label"><strong>v${escapeHtml3(entry.version || "\u672A\u8BB0\u5F55")}</strong><span>\u66F4\u65B0 ${escapeHtml3(entry.updatedAt || "\u672A\u8BB0\u5F55")}</span><span>\u8BB0\u5F55 ${escapeHtml3(String(entry.recordedAt || "\u672A\u8BB0\u5F55").replace("T", " "))}</span></div>
        <div class="algorithm-version-content"><p>${escapeHtml3(entry.description || "\u6682\u65E0\u7B97\u6CD5\u63CF\u8FF0")}</p><div class="algorithm-change-tags">${changes.map((label) => `<span>${escapeHtml3(label)}</span>`).join("")}</div></div>
      </article>
    `).join("")}</div>` : `<div class="algorithm-history-empty">\u5C1A\u65E0\u7248\u672C\u8BB0\u5F55\u3002\u70B9\u51FB\u201C\u65B0\u589E\u8BB0\u5F55\u201D\u4FDD\u5B58\u7B2C\u4E00\u4E2A\u7248\u672C\u3002</div>`;
    const contentId = `algorithm-history-${strategy.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    return `<section class="algorithm-history-card">
      <header class="algorithm-history-head">
        <button class="algorithm-history-toggle" type="button" data-toggle-algorithm-history="${escapeHtml3(strategy)}" aria-expanded="false" aria-controls="${escapeHtml3(contentId)}">
          <span class="algorithm-history-chevron" aria-hidden="true">\u203A</span>
          <span class="algorithm-history-title"><strong>${escapeHtml3(metadata.name || cardName || strategy)}</strong><small>${escapeHtml3(strategy)} \xB7 ${history.length} \u6761\u7248\u672C\u8BB0\u5F55</small></span>
        </button>
        <div class="algorithm-history-actions"><span class="algorithm-current-version">\u5F53\u524D ${escapeHtml3(metadata.version || "\u672A\u8BB0\u5F55")}</span><button class="btn small" type="button" data-edit-algorithm="${escapeHtml3(strategy)}">${history.length ? "\u65B0\u589E\u7248\u672C" : "\u65B0\u589E\u8BB0\u5F55"}</button></div>
      </header>
      <div class="algorithm-history-body" id="${escapeHtml3(contentId)}" hidden>${timeline}</div>
    </section>`;
  }).join("");
}
function fillAlgorithmDialog(strategy) {
  const metadata = state.algorithmMetadata[strategy] || {};
  document.getElementById("algorithmDialogStrategy").value = strategy;
  document.getElementById("algorithmDialogVersion").value = metadata.version === "\u672A\u8BB0\u5F55" ? "" : metadata.version || "";
  document.getElementById("algorithmDialogDate").value = metadata.updatedAt || (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA");
  document.getElementById("algorithmDialogDescription").value = metadata.description || "";
  document.getElementById("algorithmDialogStatus").textContent = "";
}
function openAlgorithmDialog() {
  fillAlgorithmDialog(state.strategy);
  document.getElementById("algorithmDialog").showModal();
  window.setTimeout(() => document.getElementById("algorithmDialogVersion").focus(), 0);
}
async function saveAlgorithmMetadata(event) {
  event.preventDefault();
  const strategy = document.getElementById("algorithmDialogStrategy").value;
  const saveButton = document.getElementById("algorithmDialogSave");
  const status = document.getElementById("algorithmDialogStatus");
  saveButton.disabled = true;
  status.textContent = "\u6B63\u5728\u4FDD\u5B58\u2026";
  try {
    const response = await fetch(`/api/algorithm-metadata/${encodeURIComponent(strategy)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: document.getElementById("algorithmDialogVersion").value.trim(),
        updatedAt: document.getElementById("algorithmDialogDate").value,
        description: document.getElementById("algorithmDialogDescription").value.trim()
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "\u4FDD\u5B58\u5931\u8D25");
    state.algorithmMetadata[strategy] = result.metadata;
    state.algorithmHistory[strategy] = result.history || [];
    renderAlgorithmMetadata();
    renderAlgorithmHistory();
    document.getElementById("algorithmDialog").close();
  } catch (error) {
    status.textContent = error.message || "\u4FDD\u5B58\u5931\u8D25";
  } finally {
    saveButton.disabled = false;
  }
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
  visualizationWorkspace.setAnalysisContext(
    buildScheduleAnalysisContext(state.routes, state.rounds)
  );
  await visualizationWorkspace.loadResult(result.resultId, state.testCaseName || "\u5F53\u524D\u8FD0\u884C\u7ED3\u679C");
  return visualizationWorkspace.getBottleneckUtilization();
}
async function runPlan() {
  const button = document.getElementById("runButton");
  const batchButton = document.getElementById("batchRunButton");
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
    if (!response.ok || !runResult.ok) throw new Error(runResult.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    showResult(runResult);
  } catch (error) {
    const baselineError = runResult?.baseline?.status === "failed" ? `
  Baseline \u5931\u8D25\uFF1A${runResult.baseline.error || "\u672A\u77E5\u539F\u56E0"}` : "";
    const validationIssues = Array.isArray(runResult?.validationIssues) ? runResult.validationIssues.map((issue) => `  ${issue}`) : [];
    if (ganttReady) {
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
    document.getElementById("metricValidation").textContent = "\u5931\u8D25";
  } finally {
    button.disabled = false;
    button.classList.remove("running");
    button.textContent = "\u25B6 \u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5";
    renderWorkspaceControls();
  }
}
async function runCurrentTestGroup() {
  const button = document.getElementById("batchRunButton"), runButton = document.getElementById("runButton");
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
    runButton.disabled = true;
    button.classList.add("cancel");
    button.textContent = "\u25A0 \u7EC8\u6B62\u8C03\u5EA6";
    document.getElementById("batchResults").innerHTML = "";
    writeTerminal(`$ \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4
  \u7EC4\u522B: ${state.activeTestGroup || "\u672A\u5206\u7EC4"}
  \u7B56\u7565: ${state.strategy}
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
  const successful = (result.items || []).filter((item) => item.status === "succeeded");
  const averageMakespan = successful.length ? successful.reduce((sum, item) => sum + Number(item.makespan), 0) / successful.length : 0;
  const comparable = successful.filter((item) => item.baseline?.status === "succeeded");
  const totalMakespan = comparable.reduce((sum, item) => sum + Number(item.makespan), 0);
  const totalBaseline = comparable.reduce((sum, item) => sum + Number(item.baseline.makespan), 0);
  const aggregateImprovement = totalBaseline > 0 ? (totalBaseline - totalMakespan) / totalBaseline * 100 : NaN;
  const moveCount = successful.reduce((sum, item) => sum + Number(item.moveCount || 0), 0);
  const timeText = result.status === "completed" ? `${(Number(result.totalElapsedMs) / 1e3).toFixed(2)} s` : result.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u8FD0\u884C\u4E2D";
  const makespanText = comparable.length ? `${totalMakespan.toFixed(2)} / ${totalBaseline.toFixed(2)} s` : successful.length ? `${averageMakespan.toFixed(2)} s` : "\u2014";
  const improvementText = comparable.length && Number.isFinite(aggregateImprovement) ? `${aggregateImprovement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(aggregateImprovement).toFixed(2)}%` : "";
  document.getElementById("metricContext").textContent = `\u6279\u91CF\u603B\u89C8 \xB7 ${result.group || "\u672A\u5206\u7EC4"}`;
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "\u603B\u8017\u65F6", timeText);
  setResultMetric("Makespan", comparable.length ? "\u603B Makespan / Baseline" : "\u5E73\u5747 Makespan", makespanText, improvementText);
  setResultMetric("Moves", "\u603B Move \u6570", moveCount || "\u2014");
  setResultMetric("Validation", result.cancelled ? "\u6210\u529F / \u5931\u8D25 / \u7EC8\u6B62" : "\u6210\u529F / \u5931\u8D25", result.cancelled ? `${result.succeeded || 0} / ${result.failed || 0} / ${result.cancelled}` : `${result.succeeded || 0} / ${result.failed || 0}`);
}
function showBatchItemOverview(item, index) {
  const succeeded = item.status === "succeeded";
  const baseline = item.baseline || {};
  const baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(item.cpuTimeMs ?? item.totalElapsedMs);
  const elapsedTime = Number(item.totalElapsedMs);
  const makespan = Number(item.makespan);
  const improvement = Number(item.improvementPercent);
  const validationText = item.validation === "passed" ? "\u901A\u8FC7" : succeeded ? String(item.validation || "\u672A\u77E5") : item.status === "failed" ? "\u5931\u8D25" : item.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u7B49\u5F85\u5B8C\u6210";
  const comparisonDetail = baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}` : "";
  const resultUrl = String(item.resultUrl || "");
  const bottleneckReady = resultUrl && batchBottleneckSummaries.has(resultUrl);
  const bottleneckSummary = bottleneckReady ? batchBottleneckSummaries.get(resultUrl) : null;
  const bottleneckError = resultUrl ? batchBottleneckErrors.get(resultUrl) : "";
  document.getElementById("metricContext").textContent = `t${index + 1} \xB7 ${item.testName || `\u6D4B\u8BD5 ${index + 1}`}`;
  document.getElementById("batchOverviewButton").hidden = false;
  setResultMetric("Time", "CPU Time / \u8017\u65F6", Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014", Number.isFinite(elapsedTime) ? `\u7AEF\u5230\u7AEF\u8017\u65F6 ${elapsedTime.toFixed(1)} ms` : "");
  setResultMetric("Makespan", "Makespan / Baseline", Number.isFinite(makespan) ? `${makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "\u2014"} s` : "\u2014", comparisonDetail);
  setBottleneckMetric(
    bottleneckSummary,
    succeeded && resultUrl ? bottleneckError ? `\u74F6\u9888\u8BA1\u7B97\u5931\u8D25\uFF1A${bottleneckError}` : bottleneckReady ? "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8" : "\u6B63\u5728\u8BA1\u7B97\u7A33\u6001\u74F6\u9888\u2026" : "\u6CA1\u6709\u53EF\u5206\u6790\u7684 MoveList"
  );
  setResultMetric("Validation", "\u6821\u9A8C", validationText, item.error || "");
}
async function loadBatchItemPerformance(item, index) {
  const resultUrl = String(item?.resultUrl || "");
  if (!resultUrl || item.status !== "succeeded") return null;
  if (batchPerformanceAnalyses.has(resultUrl)) {
    return batchPerformanceAnalyses.get(resultUrl);
  }
  if (batchBottleneckErrors.has(resultUrl)) return null;
  let request = batchBottleneckRequests.get(resultUrl);
  if (!request) {
    request = (async () => {
      const response = await fetch(resultUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`\u7ED3\u679C\u52A0\u8F7D\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
      const payload = await response.json();
      const testCase = (state.workspaceDevice?.tests || []).find(
        (test) => String(test.id) === String(item.testId)
      );
      const performance2 = analyzeSchedulePerformance(
        normalizeMovePayload(payload),
        state.device,
        "steady",
        buildScheduleAnalysisContext(
          state.workspaceDevice?.routes || state.routes,
          testCase?.rounds || state.rounds
        )
      );
      const summary = summarizeBottleneckUtilization(performance2);
      batchPerformanceAnalyses.set(resultUrl, performance2);
      batchBottleneckSummaries.set(resultUrl, summary);
      return performance2;
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
    const successful = result.items.map((item, index) => ({ item, index })).filter((entry) => entry.item.status === "succeeded" && entry.item.resultUrl);
    let cursor = 0;
    const workerCount = Math.min(4, successful.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < successful.length) {
        const current = successful[cursor];
        cursor += 1;
        await loadBatchItemPerformance(current.item, current.index);
      }
    }));
    const summary = analyzeTestGroupPerformance(result.items.map((item, index) => ({
      id: String(item.testId || `index-${index}`),
      name: `t${index + 1}`,
      status: String(item.status || "unknown"),
      validation: String(item.validation || "unknown"),
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
  const percent2 = total ? Math.round(completed / total * 100) : 0;
  const progress = document.getElementById("batchProgress");
  document.getElementById("testGroupAnalysisButton").hidden = !["completed", "cancelled"].includes(result.status);
  progress.classList.add("visible");
  progress.setAttribute("aria-valuenow", String(percent2));
  document.getElementById("batchProgressCount").textContent = `${percent2}%`;
  document.getElementById("batchProgressBar").style.width = `${percent2}%`;
  state.batchResult = result;
  if (!state.selectedBatchTestId) showBatchOverviewMetrics(result);
  renderBatchItems(result.items || []);
  const selectedIndex = (result.items || []).findIndex((item, index) => String(item.testId || `index-${index}`) === state.selectedBatchTestId);
  if (selectedIndex >= 0) {
    showBatchItemOverview(result.items[selectedIndex], selectedIndex);
    void loadBatchItemBottleneck(result.items[selectedIndex], selectedIndex);
  }
  writeTerminal([
    "$ \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4",
    `  \u7EC4\u522B: ${result.group || "\u672A\u5206\u7EC4"} \xB7 \u7B56\u7565: ${result.strategy}`,
    `  \u8FDB\u5EA6: ${completed}/${total} (${percent2}%) \xB7 \u5E76\u884C\u6570: ${result.workerCount}`,
    `  \u7B49\u5F85: ${(result.items || []).filter((item) => item.status === "queued").length} \xB7 \u8FD0\u884C\u4E2D: ${(result.items || []).filter((item) => item.status === "running").length} \xB7 \u6210\u529F: ${result.succeeded || 0} \xB7 \u5931\u8D25: ${result.failed || 0} \xB7 \u7EC8\u6B62: ${result.cancelled || 0}`
  ].join("\n"));
}
function renderBatchItems(items) {
  const statusLabels = { queued: "\u7B49\u5F85\u4E2D", running: "\u8FD0\u884C\u4E2D", succeeded: "\u6210\u529F", failed: "\u5931\u8D25", cancelled: "\u5DF2\u7EC8\u6B62" };
  document.getElementById("batchResults").innerHTML = items.map((item, index) => {
    const finished = item.status === "succeeded";
    const baseline = item.baseline || {}, baselineReady = baseline.status === "succeeded";
    const cpuTime = Number(item.cpuTimeMs);
    const improvement = Number(item.improvementPercent);
    const improvementText = finished && baselineReady && Number.isFinite(improvement) ? `${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%` : baseline.status && baseline.status !== "succeeded" ? "\u65E0\u6709\u6548\u57FA\u7EBF" : "\u63D0\u5347 \u2014";
    const baselineReason = baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}` : "";
    const summaryError = baseline.status === "failed" ? baselineReason : item.status === "failed" ? `\u8FD0\u884C\u5931\u8D25\uFF1A${item.error || "\u672A\u77E5\u9519\u8BEF"}` : item.status === "cancelled" ? "\u8C03\u5EA6\u5DF2\u7EC8\u6B62" : baselineReason;
    const displayId = `t${index + 1}`;
    const itemSelectionId = String(item.testId || `index-${index}`);
    const selected = itemSelectionId === state.selectedBatchTestId;
    return `
      <div class="batch-result ${escapeHtml3(item.status || "queued")}${selected ? " selected" : ""}" data-batch-item-index="${index}">
        <div class="batch-result-head">
          <button class="batch-result-title" type="button" aria-pressed="${selected}" aria-label="\u67E5\u770B ${escapeHtml3(displayId)} ${escapeHtml3(item.testName || "")} \u7684\u8BE6\u7EC6\u6307\u6807"><strong title="${escapeHtml3(`${item.testId || ""} \xB7 ${item.testName || ""}`)}">${escapeHtml3(displayId)}</strong></button>
          <span class="batch-status">${statusLabels[item.status] || "\u7B49\u5F85\u4E2D"}</span>
          <div class="batch-result-actions">
            ${item.logUrl ? `<a class="btn" href="${escapeHtml3(item.logUrl)}" download>\u65E5\u5FD7</a>` : `<span class="btn" aria-disabled="true">\u65E5\u5FD7</span>`}
            ${item.resultUrl ? `<button class="btn primary" type="button" data-workspace-result="${escapeHtml3(item.resultUrl)}" data-workspace-name="${escapeHtml3(item.testName || `\u6D4B\u8BD5 ${index + 1}`)}">\u5DE5\u4F5C\u53F0</button>` : `<span class="btn" aria-disabled="true">\u5DE5\u4F5C\u53F0</span>`}
            ${item.ganttUrl ? `<a class="btn" href="${escapeHtml3(item.ganttUrl)}" target="_blank">\u7518\u7279\u56FE</a>` : `<span class="btn" aria-disabled="true">\u7518\u7279\u56FE</span>`}
          </div>
        </div>
        <div class="batch-result-summary">
          <div class="batch-metric-tags" aria-label="\u4E3B\u8981\u6307\u6807">
            <span class="batch-metric-tag makespan" title="Makespan${baselineReady ? `\uFF1BBaseline ${Number(baseline.makespan).toFixed(2)} s` : ""}">${finished ? `${Number(item.makespan).toFixed(2)} s` : "\u2014 s"}</span>
            <span class="batch-metric-tag ${improvement < 0 ? "loss" : "gain"}">${escapeHtml3(improvementText)}</span>
            <span class="batch-metric-tag cpu">CPU Time ${finished && Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014"}</span>
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
function showBatchResult(result) {
  state.batchResult = result;
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
  writeTerminal(["$ \u8C03\u5EA6\u5B8C\u6210", ...result.rounds.map((round) => {
    if (round.kind === "initial") return `  #${round.index} \u9996\u6B21 | ${round.elapsedMs.toFixed(1)} ms`;
    const request = Number(round.requestedTime);
    const recoveryEnd = Number(round.recoveryEndTime ?? round.effectiveTime);
    const timing = Math.abs(recoveryEnd - request) > 1e-6 ? `@${request}s \u91CD\u7B97 \xB7 \u56FA\u5B9A\u65E7\u52A8\u4F5C\u6536\u5C3E\u81F3 @${recoveryEnd}s` : `@${request}s \u91CD\u7B97`;
    return `  #${round.index} ${timing} | ${round.elapsedMs.toFixed(1)} ms`;
  }), "", ...result.logs].join("\n"));
  const gantt = document.getElementById("ganttButton");
  gantt.href = result.ganttUrl;
  gantt.removeAttribute("aria-disabled");
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
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const status = await response.json(), compatible = status.schemaVersion === EXPECTED_API_SCHEMA;
    state.serviceCompatible = compatible;
    const loadlockMacroAvailable = status.strategies?.["loadlock-macro"] === true, nnSAEAAvailable = status.strategies?.["nn-saea"] === true, setrankAvailable = status.strategies?.setrank === true, neuralucbAvailable = status.strategies?.neuralucb === true, neuralAvailable = status.strategies?.neural === true, rlAvailable = status.strategies?.rl !== false, milpAvailable = status.strategies?.milp === true;
    state.algorithmMetadata = status.algorithmMetadata || {};
    state.algorithmHistory = status.algorithmHistory || {};
    document.getElementById("loadlockMacroStrategyInput").disabled = !loadlockMacroAvailable;
    document.getElementById("nnSAEAStrategyInput").disabled = !nnSAEAAvailable;
    document.getElementById("setrankStrategyInput").disabled = !setrankAvailable;
    document.getElementById("neuralucbStrategyInput").disabled = !neuralucbAvailable;
    document.getElementById("neuralStrategyInput").disabled = !neuralAvailable;
    document.getElementById("rlStrategyInput").disabled = !rlAvailable;
    document.getElementById("milpStrategyInput").disabled = !milpAvailable;
    renderOtherAlgorithmOptions(status.otherAlgorithms || []);
    renderAlgorithmHistory();
    runButton.disabled = !compatible;
    batchRunButton.disabled = !compatible;
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
    renderWorkspaceControls();
    pill.textContent = "\u672C\u5730\u670D\u52A1\u672A\u8FDE\u63A5";
    pill.style.color = "var(--red)";
    pill.style.background = "var(--red-soft)";
    writeTerminal("$ \u65E0\u6CD5\u8FDE\u63A5\u672C\u5730\u670D\u52A1\n  \u8BF7\u8FD0\u884C: py scripts/config_editor_server.py", true);
  }
}
document.getElementById("workspaceDialogCancel").addEventListener("click", () => document.getElementById("workspaceDialog").close("cancel"));
document.getElementById("editAlgorithmButton").addEventListener("click", openAlgorithmDialog);
document.getElementById("algorithmDialogCancel").addEventListener("click", () => document.getElementById("algorithmDialog").close());
document.getElementById("algorithmDialogStrategy").addEventListener("change", (event) => fillAlgorithmDialog(event.target.value));
document.getElementById("algorithmDialogForm").addEventListener("submit", saveAlgorithmMetadata);
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
    if (state.strategy === "neural") state.options.loadLockManager = "joint";
    else if (["heuristic", "loadlock-macro", "nn-saea", "setrank", "neuralucb", "rl"].includes(state.strategy)) state.options.loadLockManager = "petri-look";
    if (state.strategy === "milp") {
      resizeRounds(1);
      document.getElementById("roundCount").value = 1;
    }
    document.getElementById("roundCount").disabled = state.strategy === "milp";
    document.getElementById("loadlockOptions").classList.toggle("is-hidden", !["heuristic", "loadlock-macro", "nn-saea", "setrank", "neuralucb", "neural", "rl"].includes(state.strategy));
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
  const batchResultCard = event.target.closest("[data-batch-item-index]");
  if (batchResultCard && !event.target.closest(".batch-result-actions")) selectBatchItem(Number(batchResultCard.dataset.batchItemIndex));
  const algorithmHistoryToggle = event.target.closest("[data-toggle-algorithm-history]");
  if (algorithmHistoryToggle) {
    const content = document.getElementById(algorithmHistoryToggle.getAttribute("aria-controls"));
    const expanded = algorithmHistoryToggle.getAttribute("aria-expanded") === "true";
    algorithmHistoryToggle.setAttribute("aria-expanded", String(!expanded));
    content.hidden = expanded;
    return;
  }
  const algorithmEdit = event.target.closest("[data-edit-algorithm]");
  if (algorithmEdit) {
    fillAlgorithmDialog(algorithmEdit.dataset.editAlgorithm);
    document.getElementById("algorithmDialog").showModal();
    window.setTimeout(() => document.getElementById("algorithmDialogVersion").focus(), 0);
    return;
  }
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
renderAll();
renderWorkspaceControls();
checkService();
loadWorkspaceCatalog().catch((error) => setWorkspaceStatus(`\u6D4B\u8BD5\u96C6\u8BFB\u53D6\u5931\u8D25\uFF1A${error.message}`, "dirty"));
