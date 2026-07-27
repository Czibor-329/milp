/**
 * 调度编辑器的前端数据模型与兼容迁移。
 *
 * 本模块只构造和归一化页面数据，不访问 DOM 或全局编辑器状态，便于独立测试和复用。
 */

export const CJOB_TYPES = ["NormalLot", "HighestLot", "HigherLot"] as const;
export const TASK_MODES = ["Smart", "Pipeline", "Sequential", "Concurrent"] as const;

type EditorRecord = Record<string, any>;

/** 把数组或逗号文本转换成去重字符串列表。 */
export function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : String(value || "").replaceAll("，", ",").split(",");
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

/** 创建一个 IVisit；工艺名称是由 Route 派生的内部字段。 */
export function makeVisit(stationName = "", processRecipe = ""): EditorRecord {
  return {
    stationName, slotIds: "1", processRecipe, processTime: 20, recipeTime: 20,
    processType: "", weight: "{}", moveTimeOffset: "{}", qTimeLimit: -1,
    residencyConstraint: -1, beforeCleanRefs: [], afterCleanRefs: [],
  };
}

/** 创建一个 IRouteStep，并为候选设备分别创建 Visit。 */
export function makeStage(
  stations: string | string[] = "",
  needProcess = false,
  recipeName = "",
): EditorRecord {
  const names = stringList(stations);
  const visits = (names.length ? names : [""]).map(
    (name) => makeVisit(name, needProcess ? recipeName : ""),
  );
  return { stepId: 0, postStepIds: [], needProcess, visits };
}

/** 按当前顺序重建线性的 StepID 和 PostStepID。 */
export function linkRouteSteps(stages: EditorRecord[]): EditorRecord[] {
  stages.forEach((stage, index) => {
    stage.stepId = index;
    stage.postStepIds = index + 1 < stages.length ? [index + 1] : [];
  });
  return stages;
}

/** 规范化单个 Visit 的默认值，但保留旧数据中已经存在的差异。 */
export function normalizeVisit(visit: EditorRecord, recipeName = ""): EditorRecord {
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

/** 创建一个 PJob；名称、TaskID 和 MatList 由层级位置派生。 */
export function makePJob(index = 1, routeRef = "", loadPort = "", waferCount = 5): EditorRecord {
  return {
    jobName: `P${index}`,
    taskId: "",
    waferCount,
    matList: Array.from({ length: waferCount }, (_, item) => item + 1),
    routeRef,
    loadPort,
    priority: 1,
  };
}

/** 创建一个包含默认 PJob 的 CJob。 */
export function makeCJob(
  roundIndex: number,
  pjobs: EditorRecord[] = [],
  routeRef = "",
  loadPort = "",
): EditorRecord {
  const rows = pjobs.length ? pjobs : [makePJob(1, routeRef, loadPort, 5)];
  return {
    key: "C1", taskId: String(roundIndex), jobType: "NormalLot", priority: 1,
    taskMode: "Smart", pJobNameList: rows.map((item) => item.jobName), pjobs: rows,
  };
}

/** 创建一轮默认排程。 */
export function makeRound(
  roundIndex: number,
  currentTime: number,
  routeRef = "",
  loadPort = "",
): EditorRecord {
  return {
    currentTime: roundIndex === 1 ? 0 : currentTime,
    cjobs: [makeCJob(roundIndex, [], routeRef, loadPort)],
  };
}

/** 按盒子的全局 CJob 顺序轮转源 LoadPort；TaskMode 决定同一轮允许装入的盒数。 */
export function automaticLoadPort(
  loadPorts: string[],
  taskOrdinal: number,
): string {
  if (!loadPorts.length) return "";
  return loadPorts[Math.max(0, taskOrdinal - 1) % loadPorts.length];
}

/** 把旧枚举数值转换成页面使用的稳定名称。 */
function enumName(value: unknown, names: readonly string[], fallback: string): string {
  if (names.includes(String(value))) return String(value);
  const numeric = Number(value);
  if (names === CJOB_TYPES) {
    return ({ 0: "NormalLot", 2: "HighestLot", 3: "HigherLot" } as Record<number, string>)[numeric]
      || fallback;
  }
  return ({ 0: "Smart", 1: "Pipeline", 2: "Sequential", 3: "Concurrent" } as Record<number, string>)[numeric]
    || fallback;
}

/** 规范化一个 PJob，并重新计算只读字段。 */
export function normalizePJob(
  raw: EditorRecord,
  index: number,
  taskId: string,
  assignedLoadPort = "",
): EditorRecord {
  const source = raw || {};
  const originRoute = source.originRoute ?? source.OriginRoute;
  const routeRef = typeof originRoute === "object"
    ? originRoute?.name || originRoute?.Name || ""
    : originRoute;
  const waferCount = Math.max(
    1,
    Math.min(25, Number(source.waferCount ?? source.matList?.length ?? source.MatList?.length ?? 1) || 1),
  );
  return {
    jobName: `P${index}`,
    taskId: String(taskId),
    waferCount,
    matList: Array.from({ length: waferCount }, (_, item) => item + 1),
    routeRef: source.routeRef || routeRef || "",
    loadPort: assignedLoadPort || source.loadPort || source.LoadPort || "",
    priority: Math.max(1, Number(source.priority ?? source.Priority) || 1),
  };
}

/** 规范化一轮中的 CJob/PJob，并迁移旧版扁平 jobs。 */
export function normalizeRound(
  raw: EditorRecord,
  roundIndex: number,
  fallbackTime: number,
  firstTaskId = roundIndex,
  loadPorts: string[] = [],
): EditorRecord {
  const source = raw || {};
  let cjobs = Array.isArray(source.cjobs) ? source.cjobs : null;
  if (!cjobs) {
    const legacyJobs = Array.isArray(source.jobs) ? source.jobs : [];
    const first = legacyJobs[0] || {};
    cjobs = [{
      jobType: first.jobType,
      priority: first.priority,
      taskMode: first.taskMode,
      pjobs: legacyJobs.length ? legacyJobs : [{}],
    }];
  }
  if (!cjobs.length) cjobs = [{ pjobs: [{}] }];
  const normalizedCJobs = cjobs.map((cjob: EditorRecord, cjobIndex: number) => {
    const taskId = String(firstTaskId + cjobIndex);
    const taskMode = enumName(cjob.taskMode, TASK_MODES, "Smart");
    const rawPJobs = Array.isArray(cjob.pjobs) && cjob.pjobs.length ? cjob.pjobs : [{}];
    const legacyLoadPort = cjob.loadPort
      || rawPJobs[0]?.loadPort
      || rawPJobs[0]?.LoadPort
      || "";
    const loadPort = automaticLoadPort(loadPorts, firstTaskId + cjobIndex)
      || legacyLoadPort;
    const pjobs = rawPJobs.map(
      (pjob: EditorRecord, pjobIndex: number) => normalizePJob(
        pjob,
        pjobIndex + 1,
        taskId,
        loadPort,
      ),
    );
    const jobType = enumName(cjob.jobType, CJOB_TYPES, "NormalLot");
    return {
      key: cjob.key || `C${cjobIndex + 1}`,
      taskId,
      loadPort,
      jobType,
      priority: jobType === "NormalLot" ? Math.max(1, Number(cjob.priority) || 1) : -1,
      taskMode,
      pJobNameList: pjobs.map((pjob: EditorRecord) => pjob.jobName),
      pjobs,
    };
  });
  return {
    currentTime: roundIndex === 1 ? 0 : Number(source.currentTime ?? fallbackTime ?? 0),
    cjobs: normalizedCJobs,
  };
}
