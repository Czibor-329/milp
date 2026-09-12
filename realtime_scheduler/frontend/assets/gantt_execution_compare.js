var GanttExecutionCompare = (() => {
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

  // src/gantt_execution_compare.ts
  var gantt_execution_compare_exports = {};
  __export(gantt_execution_compare_exports, {
    MOVE_STATE_ABORTED: () => MOVE_STATE_ABORTED,
    MOVE_STATE_DONE: () => MOVE_STATE_DONE,
    MOVE_STATE_RUNNING: () => MOVE_STATE_RUNNING,
    TIME_TOLERANCE_SECONDS: () => TIME_TOLERANCE_SECONDS,
    hasExecutionTimeDifference: () => hasExecutionTimeDifference,
    isExecutionLog: () => isExecutionLog,
    reconstructExecutionLog: () => reconstructExecutionLog,
    resolveMoveTimes: () => resolveMoveTimes
  });
  var MOVE_STATE_RUNNING = 0;
  var MOVE_STATE_DONE = 1;
  var MOVE_STATE_ABORTED = 2;
  var TIME_TOLERANCE_SECONDS = 1e-6;
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function finiteNumber(value) {
    if (value === null || value === void 0 || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function resolveMoveTimes(record) {
    const raw = isRecord(record.raw) ? record.raw : record;
    const planStart = finiteNumber(record.planStart) ?? finiteNumber(raw.PlannedStartTime) ?? Number(raw.StartTime);
    const planEnd = finiteNumber(record.planEnd) ?? finiteNumber(raw.PlannedEndTime) ?? Number(raw.EndTime);
    const actualStart = finiteNumber(record.actualStart);
    const start = actualStart ?? Number(raw.StartTime);
    const end = finiteNumber(record.actualEnd) ?? (actualStart !== null ? actualStart + Math.max(0, planEnd - planStart) : Number(raw.EndTime));
    return { planStart, planEnd, start, end, duration: end - start };
  }
  function isExecutionLog(payload) {
    return Array.isArray(payload) && payload.some((entry) => {
      if (!isRecord(entry)) return false;
      return entry.Describe === "AlgOutput" || entry.Describe === "AlgUpdateMove";
    });
  }
  function pairExecutionNotifications(notifications, warnings) {
    const intervals = [];
    const openByMoveId = /* @__PURE__ */ new Map();
    for (const notification of notifications) {
      const moveId = finiteNumber(notification.MoveID);
      if (moveId === null) continue;
      const moveState = finiteNumber(notification.MoveState);
      const start = finiteNumber(notification.StartTime);
      const end = finiteNumber(notification.EndTime);
      const open = openByMoveId.get(moveId) ?? [];
      if (moveState === MOVE_STATE_RUNNING) {
        const interval = { moveId, start, end: null, aborted: false };
        intervals.push(interval);
        open.push(interval);
        openByMoveId.set(moveId, open);
        continue;
      }
      if (moveState === MOVE_STATE_DONE || moveState === MOVE_STATE_ABORTED) {
        let interval = [...open].reverse().find((candidate) => candidate.end === null);
        if (!interval) {
          interval = { moveId, start, end: null, aborted: false };
          intervals.push(interval);
        }
        if (interval.start === null) interval.start = start;
        interval.end = end;
        interval.aborted = moveState === MOVE_STATE_ABORTED;
        continue;
      }
      const warning = `Unknown MoveState=${String(notification.MoveState)} (MoveID=${moveId})`;
      if (warnings.length < 4 && !warnings.includes(warning)) warnings.push(warning);
    }
    return intervals;
  }
  function pickPlanVersion(versions, actualStart, used) {
    const available = versions.filter((version) => !used.has(version));
    if (!available.length) return null;
    if (actualStart === null) return available[available.length - 1];
    const before = available.filter((version) => version.planStart <= actualStart + TIME_TOLERANCE_SECONDS).sort((left, right) => right.planStart - left.planStart);
    return before[0] ?? available.sort((left, right) => left.planStart - right.planStart)[0];
  }
  function reconstructExecutionLog(entries) {
    if (!isExecutionLog(entries)) return null;
    let scheduleTime = 0;
    const generations = [];
    const notifications = [];
    const recomputePoints = [];
    const warnings = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const describe = String(entry.Describe ?? "");
      if (describe === "AlgSchedule") {
        scheduleTime = finiteNumber(entry.SimTime) ?? 0;
      } else if (describe === "AlgOutput") {
        const information = isRecord(entry.Info) ? entry.Info : {};
        if (Array.isArray(information.MoveList)) {
          generations.push({ scheduleTime, moves: information.MoveList.filter(isRecord) });
        }
      } else if (describe === "AlgUpdateMove") {
        if (isRecord(entry.Info)) notifications.push(entry.Info);
      } else if (describe === "RecomputeControl") {
        const information = isRecord(entry.Info) ? entry.Info : {};
        const recompute = isRecord(information.RecomputeInfo) ? information.RecomputeInfo : {};
        const time = finiteNumber(recompute.CurrentTime) ?? finiteNumber(entry.SimTime);
        if (time !== null) {
          recomputePoints.push({
            Time: time,
            EffectiveTime: finiteNumber(recompute.EffectiveTime) ?? time,
            ScheduleStartTime: finiteNumber(recompute.ScheduleStartTime) ?? time,
            RecoveryEndTime: finiteNumber(recompute.RecoveryEndTime) ?? finiteNumber(recompute.EffectiveTime) ?? time,
            Index: recomputePoints.length + 1,
            Reason: String(recompute.Reason ?? "\u91CD\u7B97")
          });
        }
      }
    }
    if (!generations.length) return null;
    const records = [];
    const versionsByMoveId = /* @__PURE__ */ new Map();
    generations.forEach((generation, generationIndex) => {
      const cutoff = generations[generationIndex + 1]?.scheduleTime ?? Number.POSITIVE_INFINITY;
      for (const raw of generation.moves) {
        const planStart = finiteNumber(raw.StartTime);
        const planEnd = finiteNumber(raw.EndTime);
        if (planStart === null || planEnd === null) continue;
        if (Number.isFinite(cutoff) && !(planStart < cutoff - TIME_TOLERANCE_SECONDS)) continue;
        const moveId = finiteNumber(raw.MoveID) ?? Number.NaN;
        const record = {
          raw,
          rawIndex: records.length,
          generation: generationIndex + 1,
          moveId,
          planStart,
          planEnd,
          actualStart: null,
          actualEnd: null,
          actualEndKnown: false,
          executed: false,
          aborted: false
        };
        records.push(record);
        if (Number.isFinite(moveId)) {
          const versions = versionsByMoveId.get(moveId) ?? [];
          versions.push(record);
          versionsByMoveId.set(moveId, versions);
        }
      }
    });
    const intervals = pairExecutionNotifications(notifications, warnings).sort((left, right) => (left.start ?? Number.POSITIVE_INFINITY) - (right.start ?? Number.POSITIVE_INFINITY));
    const used = /* @__PURE__ */ new Set();
    const unmatchedExecutions = [];
    for (const interval of intervals) {
      const target = pickPlanVersion(versionsByMoveId.get(interval.moveId) ?? [], interval.start, used);
      if (!target) {
        unmatchedExecutions.push(interval);
        continue;
      }
      used.add(target);
      target.actualStart = interval.start;
      target.actualEnd = interval.end;
      target.actualEndKnown = interval.end !== null;
      target.executed = true;
      target.aborted = interval.aborted;
    }
    records.sort((left, right) => left.planStart - right.planStart || left.moveId - right.moveId);
    records.forEach((record, index) => {
      record.rawIndex = index;
    });
    return { records, recomputePoints, warnings, unmatchedExecutions };
  }
  function hasExecutionTimeDifference(record, durationOnly) {
    if (!record.executed) return false;
    if (durationOnly) {
      return Math.abs(record.end - record.start - (record.planEnd - record.planStart)) > TIME_TOLERANCE_SECONDS;
    }
    return Math.abs(record.start - record.planStart) > TIME_TOLERANCE_SECONDS || Math.abs(record.end - record.planEnd) > TIME_TOLERANCE_SECONDS;
  }
  return __toCommonJS(gantt_execution_compare_exports);
})();
