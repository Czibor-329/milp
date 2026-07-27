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

// src/workspace_visualizer.ts
var workspace_visualizer_exports = {};
__export(workspace_visualizer_exports, {
  VisualizationWorkspace: () => VisualizationWorkspace,
  analyzeSchedulePerformance: () => analyzeSchedulePerformance,
  buildWorkspaceSnapshot: () => buildWorkspaceSnapshot,
  createVisualizationWorkspace: () => createVisualizationWorkspace,
  displayedPerformanceResources: () => displayedPerformanceResources,
  normalizeMovePayload: () => normalizeMovePayload,
  summarizeBottleneckUtilization: () => summarizeBottleneckUtilization
});
module.exports = __toCommonJS(workspace_visualizer_exports);

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
function completionInsideWindow(completedAt, window) {
  return completedAt >= window.start - PERFORMANCE_TIME_TOLERANCE && completedAt <= window.end + PERFORMANCE_TIME_TOLERANCE;
}
function processChamberDwellTime(moves, device, window) {
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
      id: `loadlock:${loadLocks.map((resource) => resource.name).sort(naturalCompare).join("+")}`,
      label: `LoadLock \u5BB9\u91CF\u7EC4 \xB7 ${loadLocks.map((resource) => resource.name).sort(naturalCompare).join(" / ")}`,
      kind: "loadlock-group",
      resourceNames: loadLocks.map((resource) => resource.name).sort(naturalCompare),
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
  }).sort((left, right) => right.score - left.score || right.utilization - left.utilization || naturalCompare(left.label, right.label));
  if (!ranked.length) return [];
  const topScore = ranked[0].score;
  const likelyThreshold = Math.max(0.2, topScore * 0.72, topScore - 0.16);
  return ranked.filter((candidate) => candidate.score >= likelyThreshold).slice(0, 5);
}
function analyzeSchedulePerformance(moves, device, mode = "steady", context = null) {
  const records = normalizeMoves(moves);
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
  resources.sort((left, right) => Number(right.isBottleneck) - Number(left.isBottleneck) || kindOrder[left.kind] - kindOrder[right.kind] || right.utilization - left.utilization || naturalCompare(left.name, right.name));
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
function formatSeconds(value) {
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
  const loadLocks = modules.filter((module2) => isLoadLockName2(module2.name, module2.type));
  const loadPorts = modules.filter((module2) => isLoadPortName2(module2.name, module2.type));
  const processModules = modules.filter((module2) => isProcessModule2(module2.name, module2.type));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map((module2) => module2.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter((module2) => !assignedNames.has(module2.name))
  };
}
function renderModule(module2, role) {
  const waferLimit = 3;
  const wafers = module2.wafers.slice(0, waferLimit).map((wafer) => `<span class="wafer-token" title="\u6676\u5706 ${escapeHtml(wafer)}">${escapeHtml(wafer)}</span>`).join("");
  const overflow = module2.wafers.length > waferLimit ? `<span class="wafer-more">+${module2.wafers.length - waferLimit}</span>` : "";
  const progress = Math.round(module2.progress * 100);
  const accessibleStatus = `${module2.name}\uFF0C${STATUS_LABELS[module2.status]}\uFF0C${DOOR_LABELS[module2.door]}`;
  return `
    <article class="equipment-card equipment-${role} status-${module2.status} door-${module2.door} ${module2.isRobotTarget ? "is-target" : ""}" aria-label="${escapeHtml(accessibleStatus)}">
      <div class="equipment-gate" aria-hidden="true"><span></span></div>
      <div class="equipment-head">
        <strong>${escapeHtml(module2.name)}</strong>
        <span class="equipment-status"><i></i>${escapeHtml(STATUS_LABELS[module2.status])}</span>
      </div>
      <div class="equipment-body">
        <div class="wafer-stack">${wafers || '<span class="wafer-empty">\u7A7A\u8154</span>'}${overflow}</div>
        ${module2.environment ? `<span class="environment-state">${escapeHtml(module2.environment)}</span>` : ""}
      </div>
      <div class="equipment-foot">
        <span class="door-state"><i></i>${escapeHtml(DOOR_LABELS[module2.door])}</span>
        <span>${escapeHtml(module2.activeMoveName || "\u7B49\u5F85")}${module2.activeMoveName ? ` \xB7 ${progress}%` : ""}</span>
      </div>
      <div class="equipment-progress"><span style="transform:scaleX(${module2.activeMoveName ? module2.progress : 0})"></span></div>
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
          ${groups.processModules.map((module2, index) => `
            <div class="process-module-position" style="${processModulePosition(index, groups.processModules.length)}">
              ${renderModule(module2, "process")}
            </div>`).join("")}
        </div>
        ${vacuumRobot ? renderRobotHub(vacuumRobot, "vacuum") : '<div class="topology-junction vacuum-junction"><strong>\u771F\u7A7A\u4F20\u8F93\u533A</strong></div>'}
        <div class="load-lock-bank" aria-label="\u771F\u7A7A\u8FC7\u6E21\u8154">
          ${groups.loadLocks.map((module2) => renderModule(module2, "lock")).join("")}
        </div>
        <div class="atmosphere-deck">
          <div class="auxiliary-bank auxiliary-left">${leftAuxiliary.map((module2) => renderModule(module2, "auxiliary")).join("")}</div>
          ${atmosphereRobot ? renderRobotHub(atmosphereRobot, "atmosphere") : '<div class="topology-junction atmosphere-junction"><strong>\u5927\u6C14\u4F20\u8F93\u533A</strong></div>'}
          <div class="auxiliary-bank auxiliary-right">${rightAuxiliary.map((module2) => renderModule(module2, "auxiliary")).join("")}</div>
        </div>
        <div class="load-port-bank" aria-label="\u88C5\u8F7D\u7AEF\u53E3">
          ${groups.loadPorts.map((module2) => renderModule(module2, "port")).join("")}
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
  const window = performance2.window;
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
      if (duration <= PERFORMANCE_TIME_TOLERANCE || window.duration <= PERFORMANCE_TIME_TOLERANCE) return "";
      const width = Math.min(duration / window.duration * 100, 100);
      return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds(duration)} s"></span>`;
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
            <small>${formatSeconds(resource.busyTime)} s</small>
          </div>
        </td>
        <td class="performance-number">${formatSeconds(resource.averageActivePeriod)} s <small>${resource.activePeriodCount} \u6BB5</small></td>
        <td class="performance-number">${formatSeconds(resource.longestIdlePeriod)} s</td>
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
    ${candidateMarkup}
    ${diagnosticMarkup}
    <p class="performance-window-note">${escapeHtml(window.detail)}</p>
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
    this.elements.currentTime.textContent = formatSeconds(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds(snapshot.endTime);
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
          <time>${formatSeconds(finiteNumber2(move.StartTime))}\u2013${formatSeconds(finiteNumber2(move.EndTime))} s</time>
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VisualizationWorkspace,
  analyzeSchedulePerformance,
  buildWorkspaceSnapshot,
  createVisualizationWorkspace,
  displayedPerformanceResources,
  normalizeMovePayload,
  summarizeBottleneckUtilization
});
