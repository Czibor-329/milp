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

// ../analysis/index.ts
var index_exports = {};
__export(index_exports, {
  PERFORMANCE_TIME_TOLERANCE: () => PERFORMANCE_TIME_TOLERANCE,
  analyzeSchedulePerformance: () => analyzeSchedulePerformance,
  analyzeTestGroupPerformance: () => analyzeTestGroupPerformance,
  buildScheduleAnalysisContext: () => buildScheduleAnalysisContext,
  diagnoseSchedule: () => diagnoseSchedule,
  displayedPerformanceResources: () => displayedPerformanceResources,
  normalizeMovePayload: () => normalizeMovePayload,
  summarizeBottleneckUtilization: () => summarizeBottleneckUtilization
});
module.exports = __toCommonJS(index_exports);

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
      finishHolding(robot, materialIds(move, "SendMatList"), move.StartTime);
      for (const material of materialIds(move, "RecvMatList")) {
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
      pending.ventWafers = materialIds(move);
      pending.ventStartTime = move.StartTime;
      pending.ventEndTime = move.EndTime;
      pendingByLoadLock.delete(loadLock);
      continue;
    }
    cycles.push({
      index: 0,
      loadLock,
      vacuumWafers: [],
      ventWafers: materialIds(move),
      startTime: move.StartTime,
      pumpEndTime: move.StartTime,
      ventStartTime: move.StartTime,
      ventEndTime: move.EndTime,
      startedAt: move.StartTime,
      vacuumEndTime: move.StartTime
    });
  }
  return cycles.sort((left, right) => left.startedAt - right.startedAt || naturalCompare(left.loadLock, right.loadLock)).map((cycle, index) => ({
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
function summarizeBottleneckUtilization(performance) {
  const candidate = performance.primaryBottleneck;
  if (!candidate) return null;
  return {
    resourceName: candidate.label,
    utilization: candidate.utilization,
    windowLabel: performance.window.label,
    confidence: candidate.confidence,
    candidateCount: performance.bottleneckCandidates.length,
    score: candidate.score
  };
}
function displayedPerformanceResources(performance) {
  return performance.resources.filter(
    (resource) => resource.busyTime > PERFORMANCE_TIME_TOLERANCE
  );
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
  const metricsAvailable = input.status === "succeeded" || input.metricsAvailable === true;
  const comparable = metricsAvailable && makespan !== null && baselineMakespan !== null && baselineMakespan > 0;
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
    metricsAvailable,
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
  const measured = cases.filter((item) => item.metricsAvailable);
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
  const cpuTimes = measured.map((item) => item.cpuTimeMs).filter((value) => value !== null && value >= 0);
  const bottleneckUtilizations = measured.map((item) => item.bottleneckUtilization).filter((value) => value !== null);
  const throughputs = measured.map((item) => item.throughputPerHour).filter((value) => value !== null && value > 0);
  const departureCvs = measured.map((item) => item.departureIntervalCv).filter((value) => value !== null);
  const chamberDwellMeans = measured.map((item) => item.processChamberDwellMeanSeconds).filter((value) => value !== null);
  const robotDwellMeans = measured.map((item) => item.robotWaferDwellMeanSeconds).filter((value) => value !== null);
  const systemResidenceMeans = measured.map((item) => item.waferSystemResidenceMeanSeconds).filter((value) => value !== null);
  const systemResidenceCvs = measured.map((item) => item.waferSystemResidenceCv).filter((value) => value !== null);
  const frequencyMap = /* @__PURE__ */ new Map();
  const windowMethodCounts = {};
  for (const item of measured) {
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
    share: measured.length ? values.length / measured.length : 0,
    medianUtilization: median(values) ?? 0
  })).sort((left, right) => right.count - left.count || right.medianUtilization - left.medianUtilization || left.resourceName.localeCompare(right.resourceName, void 0, {
    numeric: true
  }));
  return {
    cases,
    totalCount: cases.length,
    succeededCount: succeeded.length,
    failedCount: cases.length - succeeded.length,
    metricsCount: measured.length,
    validationPassedCount: measured.filter((item) => item.validationPassed).length,
    validationPassRate: measured.length ? measured.filter((item) => item.validationPassed).length / measured.length : 0,
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

// ../analysis/diagnostic_guidance.ts
function percent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}
function seconds(value) {
  return `${Math.max(0, value).toFixed(2)} s`;
}
function candidateDiagnostic(candidate, performance) {
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
          value: seconds(performance.processChamberDwellTime.meanSeconds),
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
          value: seconds(performance.robotWaferDwellTime.meanSeconds),
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
function diagnoseSchedule(performance) {
  const diagnostics = performance.bottleneckCandidates.slice(0, 2).map((candidate) => candidateDiagnostic(candidate, performance));
  if (performance.departureIntervalCv >= 0.25) {
    diagnostics.push({
      title: "\u51FA\u7AD9\u8282\u62CD\u6CE2\u52A8\u9700\u8981\u5355\u72EC\u9A8C\u8BC1",
      confidence: performance.completedWaferCount >= 8 ? "moderate" : "exploratory",
      finding: `\u51FA\u7AD9\u95F4\u9694 CV \u4E3A ${performance.departureIntervalCv.toFixed(2)}\uFF0C\u5747\u503C\u65E0\u6CD5\u4EE3\u8868\u5C40\u90E8\u62E5\u585E\u6216\u9965\u997F\u3002`,
      evidence: [
        {
          label: "\u51FA\u7AD9\u95F4\u9694 CV",
          value: performance.departureIntervalCv.toFixed(2),
          interpretation: "\u8D8A\u9AD8\u8868\u793A\u76F8\u90BB\u6676\u5706\u5B8C\u6210\u95F4\u9694\u8D8A\u4E0D\u5747\u5300\u3002"
        },
        {
          label: "\u5B8C\u6574\u6676\u5706\u6837\u672C",
          value: `${performance.completedWaferCount} \u7247`,
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PERFORMANCE_TIME_TOLERANCE,
  analyzeSchedulePerformance,
  analyzeTestGroupPerformance,
  buildScheduleAnalysisContext,
  diagnoseSchedule,
  displayedPerformanceResources,
  normalizeMovePayload,
  summarizeBottleneckUtilization
});
