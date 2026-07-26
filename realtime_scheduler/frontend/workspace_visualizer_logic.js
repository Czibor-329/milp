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
  normalizeMovePayload: () => normalizeMovePayload
});
module.exports = __toCommonJS(workspace_visualizer_exports);
var PICK_MOVE_TYPES = /* @__PURE__ */ new Set([0, 2]);
var PLACE_MOVE_TYPES = /* @__PURE__ */ new Set([1, 3]);
var SWAP_MOVE = 4;
var PREPARE_MOVE = 6;
var COMPLETE_MOVE = 7;
var PROCESS_MOVE = 9;
var PRE_PREPARE_MOVE = 10;
var CLEAN_MOVE = 14;
var PLAYBACK_FRAME_INTERVAL_MS = 80;
var DEFAULT_PLAYBACK_SPEED = 4;
var PROCESS_ARC_START_DEGREES = 200;
var PROCESS_ARC_END_DEGREES = 340;
var PROCESS_ARC_CENTER_X_PERCENT = 50;
var PROCESS_ARC_CENTER_Y_PIXELS = 214;
var PROCESS_ARC_RADIUS_X_PERCENT = 38;
var PROCESS_ARC_RADIUS_Y_PIXELS = 156;
var PERFORMANCE_TIME_TOLERANCE = 1e-6;
var MIDDLE_WINDOW_TRIM_RATIO = 0.1;
var MINIMUM_STEADY_WAFERS = 4;
var MAXIMUM_VISIBLE_QUEUE_ITEMS = 32;
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
function listValue(value) {
  return Array.isArray(value) ? value : [];
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
function materialPJob(move, material) {
  const materials = materialIds(move);
  const jobs = listValue(move.PJobName).map(String);
  const index = materials.indexOf(material);
  return jobs[index] ?? jobs[0] ?? "";
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
function buildVacuumQueue(moves, device, intervalsByResource) {
  const admittedMaterials = /* @__PURE__ */ new Set();
  const queue = [];
  for (const move of moves) {
    if (/^ATR/i.test(move.ModuleName)) continue;
    const isPick = PICK_MOVE_TYPES.has(move.MoveType);
    const isLoadLockSwap = move.MoveType === SWAP_MOVE;
    if (!isPick && !isLoadLockSwap) continue;
    const source = isLoadLockSwap ? String(listValue(move.StationList)[0] ?? "") : firstStation(move, "SrcStationList");
    if (!isLoadLockName(source, stationType(device, source))) continue;
    const admitted = isLoadLockSwap ? materialIds(move, "RecvMatList") : materialIds(move);
    for (const material of admitted) {
      if (admittedMaterials.has(material)) continue;
      admittedMaterials.add(material);
      const targetPlacement = moves.find((candidate) => candidate.StartTime >= move.EndTime - PERFORMANCE_TIME_TOLERANCE && (PLACE_MOVE_TYPES.has(candidate.MoveType) && materialIds(candidate).includes(material) || candidate.MoveType === SWAP_MOVE && materialIds(candidate, "SendMatList").includes(material)) && isProcessModule(
        candidate.MoveType === SWAP_MOVE ? String(listValue(candidate.StationList)[0] ?? "") : firstStation(candidate, "DestStationList"),
        stationType(
          device,
          candidate.MoveType === SWAP_MOVE ? String(listValue(candidate.StationList)[0] ?? "") : firstStation(candidate, "DestStationList")
        )
      ));
      const targetModule = targetPlacement ? targetPlacement.MoveType === SWAP_MOVE ? String(listValue(targetPlacement.StationList)[0] ?? "") : firstStation(targetPlacement, "DestStationList") : "";
      const processMove = moves.find((candidate) => candidate.StartTime >= move.EndTime - PERFORMANCE_TIME_TOLERANCE && candidate.MoveType === PROCESS_MOVE && candidate.ModuleName === targetModule && materialIds(candidate).includes(material));
      const admittedAt = move.EndTime;
      const targetWasBusy = Boolean(targetModule && (intervalsByResource.get(targetModule) ?? []).some((interval) => interval.start < admittedAt + PERFORMANCE_TIME_TOLERANCE && interval.end > admittedAt + PERFORMANCE_TIME_TOLERANCE));
      queue.push({
        index: queue.length + 1,
        material,
        pjob: materialPJob(move, material),
        loadLock: source,
        admittedAt,
        targetModule,
        targetWasBusy,
        processWait: processMove ? Math.max(processMove.StartTime - admittedAt, 0) : 0
      });
    }
  }
  return queue;
}
function vacuumQueuePattern(queue) {
  if (!queue.length) return { switchRatio: 0, longestRun: 0 };
  let switches = 0;
  let run = 1;
  let longestRun = 1;
  for (let index = 1; index < queue.length; index += 1) {
    if (queue[index].pjob === queue[index - 1].pjob) run += 1;
    else {
      switches += 1;
      run = 1;
    }
    longestRun = Math.max(longestRun, run);
  }
  return {
    switchRatio: queue.length > 1 ? switches / (queue.length - 1) : 0,
    longestRun
  };
}
function analyzeSchedulePerformance(moves, device, mode = "steady") {
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
      isBottleneck: false
    };
  });
  const bottleneckCandidates = resources.filter((resource) => ["robot", "process", "loadlock"].includes(resource.kind) && resource.busyTime > PERFORMANCE_TIME_TOLERANCE);
  const bottleneck = [...bottleneckCandidates].sort((left, right) => right.averageActivePeriod - left.averageActivePeriod || right.utilization - left.utilization || naturalCompare(left.name, right.name))[0] ?? null;
  if (bottleneck) bottleneck.isBottleneck = true;
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
  const vacuumQueue = buildVacuumQueue(records, device, intervalsByResource);
  const queuePattern = vacuumQueuePattern(vacuumQueue);
  return {
    window,
    resources,
    bottleneck,
    completedWaferCount: completionTimes.length,
    throughputPerHour,
    meanDepartureInterval,
    departureIntervalCv: intervalCoefficientOfVariation(departureIntervals),
    vacuumQueue,
    vacuumQueueJobSwitchRatio: queuePattern.switchRatio,
    vacuumQueueLongestRun: queuePattern.longestRun
  };
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
    if (move.MoveType === PREPARE_MOVE) {
      if (active) doorStates.set(move.ModuleName, "opening");
      else if (completed) doorStates.set(move.ModuleName, "open");
    } else if (move.MoveType === COMPLETE_MOVE) {
      if (active) doorStates.set(move.ModuleName, "closing");
      else if (completed) doorStates.set(move.ModuleName, "closed");
    } else if (move.MoveType === PRE_PREPARE_MOVE && (active || completed)) {
      const currentState = String(move.CurState ?? "");
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
    const primaryMove = moduleMoves.find((move) => move.MoveType === CLEAN_MOVE) ?? moduleMoves.find((move) => move.MoveType === PROCESS_MOVE) ?? moduleMoves.find((move) => move.MoveType === PRE_PREPARE_MOVE) ?? moduleMoves.find((move) => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType)) ?? moduleMoves[0];
    let status = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove?.MoveType === CLEAN_MOVE) status = "cleaning";
    else if (primaryMove?.MoveType === PROCESS_MOVE) status = "processing";
    else if (primaryMove?.MoveType === PRE_PREPARE_MOVE) status = "environment";
    else if (primaryMove && [PREPARE_MOVE, COMPLETE_MOVE].includes(primaryMove.MoveType)) status = "door";
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
  }).sort((left, right) => naturalCompare(left.name, right.name));
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
    waferCount: new Set(records.flatMap((move) => materialIds(move))).size
  };
}
function collectElements(root) {
  const required = (id) => {
    const element = root.getElementById(id);
    if (!element) throw new Error(`\u53EF\u89C6\u5316\u5DE5\u4F5C\u53F0\u7F3A\u5C11\u9875\u9762\u8282\u70B9\uFF1A${id}`);
    return element;
  };
  return {
    empty: required("visualEmpty"),
    content: required("visualContent"),
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
function shortPJobName(value) {
  const parts = String(value || "").split(".").filter(Boolean);
  return parts.at(-1) ?? "\u2014";
}
function formatPercent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`;
}
function renderSchedulePerformance(performance2) {
  const window = performance2.window;
  const bottleneck = performance2.bottleneck;
  const resourceKindLabels = {
    robot: "\u673A\u68B0\u624B",
    process: "\u5DE5\u827A\u8154",
    loadlock: "LoadLock",
    loadport: "LoadPort",
    auxiliary: "\u8F85\u52A9\u6A21\u5757"
  };
  const legend = ACTIVITY_CATEGORIES.map((category) => `<span><i class="performance-swatch category-${category}"></i>${ACTIVITY_CATEGORY_LABELS[category]}</span>`).join("");
  const resourceRows = performance2.resources.map((resource) => {
    const categoryBars = ACTIVITY_CATEGORIES.map((category) => {
      const duration = resource.categoryTimes[category];
      if (duration <= PERFORMANCE_TIME_TOLERANCE || window.duration <= PERFORMANCE_TIME_TOLERANCE) return "";
      const width = Math.min(duration / window.duration * 100, 100);
      return `<span class="category-${category}" style="width:${width.toFixed(3)}%" title="${ACTIVITY_CATEGORY_LABELS[category]} ${formatSeconds(duration)} s"></span>`;
    }).join("");
    const status = resource.busyTime <= PERFORMANCE_TIME_TOLERANCE ? '<span class="resource-unused">\u672A\u4F7F\u7528</span>' : resource.isBottleneck ? '<span class="resource-bottleneck">\u74F6\u9888\u5019\u9009</span>' : "";
    return `
      <tr class="${resource.isBottleneck ? "is-bottleneck" : ""}">
        <th scope="row">
          <span class="resource-name">${escapeHtml(resource.name)}</span>
          <small>${escapeHtml(resourceKindLabels[resource.kind])}</small>
          ${status}
        </th>
        <td>
          <div class="utilization-value">${formatPercent(resource.utilization)}</div>
          <div class="utilization-track" aria-label="${escapeHtml(resource.name)} \u5360\u7528\u7387 ${formatPercent(resource.utilization)}">${categoryBars}</div>
          <small>${formatSeconds(resource.busyTime)} s</small>
        </td>
        <td class="performance-number">${formatSeconds(resource.averageActivePeriod)} s<small>${resource.activePeriodCount} \u6BB5</small></td>
        <td class="performance-number">${formatSeconds(resource.longestIdlePeriod)} s</td>
      </tr>`;
  }).join("");
  const visibleQueue = performance2.vacuumQueue.slice(0, MAXIMUM_VISIBLE_QUEUE_ITEMS);
  const queueMarkup = visibleQueue.length ? `<ol class="vacuum-queue-sequence">${visibleQueue.map((item) => `
        <li class="${item.targetWasBusy ? "target-busy" : "target-idle"}">
          <span class="queue-index">${item.index}</span>
          <strong>W${escapeHtml(item.material)}</strong>
          <span>${escapeHtml(shortPJobName(item.pjob))} \xB7 ${escapeHtml(item.loadLock)} \u2192 ${escapeHtml(item.targetModule || "PM?")}</span>
          <small>${formatSeconds(item.admittedAt)} s \xB7 \u76EE\u6807\u8154${item.targetWasBusy ? "\u5FD9" : "\u95F2"} \xB7 \u81F3\u52A0\u5DE5 ${formatSeconds(item.processWait)} s</small>
        </li>`).join("")}</ol>` : '<div class="vacuum-queue-empty">MoveList \u4E2D\u6CA1\u6709\u8BC6\u522B\u5230\u201CLoadLock \u2192 \u771F\u7A7A\u673A\u68B0\u624B\u201D\u7684\u5165\u961F\u52A8\u4F5C\u3002</div>';
  return `
    <div class="performance-summary">
      <div>
        <span>\u7EDF\u8BA1\u7A97\u53E3</span>
        <strong>${escapeHtml(window.label)} \xB7 ${formatSeconds(window.duration)} s</strong>
        <small>\u5254\u9664\u5F00\u5934 ${formatSeconds(window.trimmedStart)} s / \u7ED3\u5C3E ${formatSeconds(window.trimmedEnd)} s</small>
      </div>
      <div>
        <span>\u8FDE\u7EED\u5FD9\u788C\u74F6\u9888</span>
        <strong>${escapeHtml(bottleneck?.name ?? "\u2014")}</strong>
        <small>${bottleneck ? `\u5E73\u5747\u8FDE\u7EED\u5FD9\u788C ${formatSeconds(bottleneck.averageActivePeriod)} s \xB7 \u5360\u7528 ${formatPercent(bottleneck.utilization)}` : "\u6CA1\u6709\u8DB3\u591F\u7684\u8D44\u6E90\u6D3B\u52A8"}</small>
      </div>
      <div>
        <span>\u51FA\u7AD9\u8282\u62CD</span>
        <strong>${performance2.throughputPerHour > 0 ? `${performance2.throughputPerHour.toFixed(1)} \u7247/h` : "\u2014"}</strong>
        <small>\u5E73\u5747\u95F4\u9694 ${formatSeconds(performance2.meanDepartureInterval)} s \xB7 \u6CE2\u52A8 CV ${performance2.departureIntervalCv.toFixed(2)}</small>
      </div>
    </div>
    <p class="performance-window-note">${escapeHtml(window.detail)}</p>
    <div class="performance-legend" aria-label="\u5360\u7528\u7EC4\u6210\u56FE\u4F8B">${legend}</div>
    <div class="performance-grid">
      <div class="performance-table-wrap">
        <table class="performance-table">
          <thead><tr><th>\u8D44\u6E90</th><th>\u7269\u7406\u5360\u7528</th><th>\u5E73\u5747\u8FDE\u7EED\u5FD9\u788C</th><th>\u6700\u957F\u7A7A\u95F2</th></tr></thead>
          <tbody>${resourceRows}</tbody>
        </table>
      </div>
      <aside class="vacuum-queue-panel">
        <div class="vacuum-queue-head">
          <div><strong>\u771F\u7A7A\u7AEF\u5165\u961F\u5E8F\u5217</strong><span>\u6309\u6676\u5706\u7B2C\u4E00\u6B21\u4ECE LoadLock \u88AB VTR \u53D6\u51FA\u6392\u5E8F</span></div>
          <small>Job \u5207\u6362 ${formatPercent(performance2.vacuumQueueJobSwitchRatio)} \xB7 \u6700\u957F\u8FDE\u7EED ${performance2.vacuumQueueLongestRun} \u7247</small>
        </div>
        ${queueMarkup}
        ${performance2.vacuumQueue.length > visibleQueue.length ? `<div class="vacuum-queue-more">\u53E6\u6709 ${performance2.vacuumQueue.length - visibleQueue.length} \u7247\u672A\u5C55\u5F00</div>` : ""}
      </aside>
    </div>`;
}
var VisualizationWorkspace = class {
  root;
  elements;
  device = null;
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
  /** 切换到工作台标签。 */
  show() {
    const tab = this.root.querySelector('[data-tab-target="workspace"]');
    tab?.click();
    this.elements.range.focus({ preventScroll: true });
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
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
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
    this.elements.empty.hidden = true;
    this.elements.content.hidden = false;
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
      this.renderPerformance();
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
          <span class="active-move-id">#${finiteNumber(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber(move.MoveType, -1)] ?? `\u52A8\u4F5C ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move) || "\u2014")}</span>
          <time>${formatSeconds(finiteNumber(move.StartTime))}\u2013${formatSeconds(finiteNumber(move.EndTime))} s</time>
        </li>`).join("") : '<li class="active-move-empty">\u5F53\u524D\u65F6\u523B\u6CA1\u6709\u6267\u884C\u4E2D\u7684\u52A8\u4F5C</li>';
  }
  /** 重算并绘制与播放时刻无关的整段排程性能诊断。 */
  renderPerformance() {
    if (!this.moves.length) return;
    const performance2 = analyzeSchedulePerformance(
      this.moves,
      this.device,
      this.performanceWindowMode
    );
    this.elements.performance.innerHTML = renderSchedulePerformance(performance2);
  }
  /** 显示加载状态并保留明确的系统反馈。 */
  setLoading(loading, message) {
    this.elements.empty.hidden = false;
    this.elements.empty.classList.toggle("is-loading", loading);
    this.elements.empty.classList.remove("is-error");
    this.elements.empty.innerHTML = loading ? `<span class="visual-loader" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong>` : `<strong>${escapeHtml(message)}</strong>`;
  }
  /** 在工作台空状态中显示可恢复的错误。 */
  showError(message) {
    this.pause();
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
  normalizeMovePayload
});
