/**
 * 甘特图执行时间对比逻辑。
 *
 * 本模块把平台复现日志中的多代 AlgOutput 拼接为一条时间线，并用
 * AlgUpdateMove 的 Running/Done 通知覆盖计划时间。纯渲染和交互仍由
 * movelist_gantt_viewer.html 负责。
 */

export const MOVE_STATE_RUNNING = 0;
export const MOVE_STATE_DONE = 1;
export const MOVE_STATE_ABORTED = 2;
export const TIME_TOLERANCE_SECONDS = 1e-6;

type JsonRecord = Record<string, unknown>;

export interface ExecutionMoveRecord {
  raw: JsonRecord;
  rawIndex: number;
  generation: number;
  moveId: number;
  planStart: number;
  planEnd: number;
  actualStart: number | null;
  actualEnd: number | null;
  actualEndKnown: boolean;
  executed: boolean;
  aborted: boolean;
}

export interface ReconstructedExecutionLog {
  records: ExecutionMoveRecord[];
  recomputePoints: JsonRecord[];
  warnings: string[];
  unmatchedExecutions: ExecutionInterval[];
}

interface PlanGeneration {
  scheduleTime: number;
  moves: JsonRecord[];
}

interface ExecutionInterval {
  moveId: number;
  start: number | null;
  end: number | null;
  aborted: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 从结果中的计划元数据或日志包装中提取显示时间，保持实际时间为绘图依据。 */
export function resolveMoveTimes(record: JsonRecord) {
  const raw = isRecord(record.raw) ? record.raw : record;
  const planStart = finiteNumber(record.planStart) ?? finiteNumber(raw.PlannedStartTime) ?? Number(raw.StartTime);
  const planEnd = finiteNumber(record.planEnd) ?? finiteNumber(raw.PlannedEndTime) ?? Number(raw.EndTime);
  const actualStart = finiteNumber(record.actualStart);
  const start = actualStart ?? Number(raw.StartTime);
  const end = finiteNumber(record.actualEnd)
    ?? (actualStart !== null ? actualStart + Math.max(0, planEnd - planStart) : Number(raw.EndTime));
  return { planStart, planEnd, start, end, duration: end - start };
}

/** 判断顶层数组是否包含平台复现日志条目。 */
export function isExecutionLog(payload: unknown): payload is JsonRecord[] {
  return Array.isArray(payload) && payload.some((entry) => {
    if (!isRecord(entry)) return false;
    return entry.Describe === "AlgOutput" || entry.Describe === "AlgUpdateMove";
  });
}

/**
 * 将同一 MoveID 的通知拆成独立执行区间。
 *
 * Running 创建新区间，Done/Aborted 结束最近的未闭合区间；这样即使算法在
 * 重算后复用 MoveID，也不会把两次执行折叠为一条。
 */
function pairExecutionNotifications(notifications: JsonRecord[], warnings: string[]): ExecutionInterval[] {
  const intervals: ExecutionInterval[] = [];
  const openByMoveId = new Map<number, ExecutionInterval[]>();

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

/** 为一次执行选择尚未占用、且计划时间最接近实际开始的同 ID 版本。 */
function pickPlanVersion(
  versions: ExecutionMoveRecord[],
  actualStart: number | null,
  used: Set<ExecutionMoveRecord>,
): ExecutionMoveRecord | null {
  const available = versions.filter((version) => !used.has(version));
  if (!available.length) return null;
  if (actualStart === null) return available[available.length - 1];

  const before = available
    .filter((version) => version.planStart <= actualStart + TIME_TOLERANCE_SECONDS)
    .sort((left, right) => right.planStart - left.planStart);
  return before[0] ?? available.sort((left, right) => left.planStart - right.planStart)[0];
}

/**
 * 从 input_data 复现日志恢复多代计划，并写入 AlgUpdateMove 的实际时间。
 *
 * 每代只保留计划开始早于下一次 AlgSchedule 的 Move，最后一代完整保留。
 * 未收到执行通知的 Move 保持计划时间；只有 Running 的 Move 用计划时长估算
 * 结束时间，并通过 actualEndKnown=false 明确标记该结束时间尚非实测值。
 */
export function reconstructExecutionLog(entries: unknown[]): ReconstructedExecutionLog | null {
  if (!isExecutionLog(entries)) return null;

  let scheduleTime = 0;
  const generations: PlanGeneration[] = [];
  const notifications: JsonRecord[] = [];
  const recomputePoints: JsonRecord[] = [];
  const warnings: string[] = [];

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
          RecoveryEndTime: finiteNumber(recompute.RecoveryEndTime)
            ?? finiteNumber(recompute.EffectiveTime)
            ?? time,
          Index: recomputePoints.length + 1,
          Reason: String(recompute.Reason ?? "重算"),
        });
      }
    }
  }
  if (!generations.length) return null;

  const records: ExecutionMoveRecord[] = [];
  const versionsByMoveId = new Map<number, ExecutionMoveRecord[]>();
  generations.forEach((generation, generationIndex) => {
    const cutoff = generations[generationIndex + 1]?.scheduleTime ?? Number.POSITIVE_INFINITY;
    for (const raw of generation.moves) {
      const planStart = finiteNumber(raw.StartTime);
      const planEnd = finiteNumber(raw.EndTime);
      if (planStart === null || planEnd === null) continue;
      if (Number.isFinite(cutoff) && !(planStart < cutoff - TIME_TOLERANCE_SECONDS)) continue;
      const moveId = finiteNumber(raw.MoveID) ?? Number.NaN;
      const record: ExecutionMoveRecord = {
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
        aborted: false,
      };
      records.push(record);
      if (Number.isFinite(moveId)) {
        const versions = versionsByMoveId.get(moveId) ?? [];
        versions.push(record);
        versionsByMoveId.set(moveId, versions);
      }
    }
  });

  const intervals = pairExecutionNotifications(notifications, warnings)
    .sort((left, right) => (left.start ?? Number.POSITIVE_INFINITY) - (right.start ?? Number.POSITIVE_INFINITY));
  const used = new Set<ExecutionMoveRecord>();
  const unmatchedExecutions: ExecutionInterval[] = [];
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
  records.forEach((record, index) => { record.rawIndex = index; });
  return { records, recomputePoints, warnings, unmatchedExecutions };
}

/** 判断实际起止时间是否相对原计划发生变化。 */
export function hasExecutionTimeDifference(
  record: Pick<ExecutionMoveRecord, "executed" | "planStart" | "planEnd"> & { start: number; end: number },
  durationOnly: boolean,
): boolean {
  if (!record.executed) return false;
  if (durationOnly) {
    return Math.abs((record.end - record.start) - (record.planEnd - record.planStart))
      > TIME_TOLERANCE_SECONDS;
  }
  return Math.abs(record.start - record.planStart) > TIME_TOLERANCE_SECONDS
    || Math.abs(record.end - record.planEnd) > TIME_TOLERANCE_SECONDS;
}
