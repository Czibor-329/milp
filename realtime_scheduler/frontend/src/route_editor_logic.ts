/**
 * Route 编辑器的纯数据逻辑。
 *
 * 本模块不访问 DOM，也不依赖页面状态，供 TypeScript 页面入口与 Node 单元测试共同使用。
 * 所有函数只负责 Route 工艺结构的归一化、比较和候选腔室同步。
 */

export interface RouteVisit {
  stationName?: string;
  processTime?: number;
  recipeTime?: number;
  processRecipe?: string;
  processType?: string;
  slotIds?: string;
  weight?: unknown;
  moveTimeOffset?: unknown;
  qTimeLimit?: number;
  residencyConstraint?: number;
  beforeCleanRefs?: string[];
  afterCleanRefs?: string[];
  [key: string]: unknown;
}

export interface RouteStage {
  needProcess?: boolean;
  visits?: RouteVisit[];
  [key: string]: unknown;
}

export interface RouteDefinition {
  name?: string;
  stages?: RouteStage[];
  prePJobCleanRefs?: string[] | string;
  postPJobCleanRefs?: string[] | string;
  postCJobCleanRefs?: string[] | string;
  [key: string]: unknown;
}

export interface RouteProcessProfile {
  processCount: number;
  counts: number[];
  candidatePath: string[];
  processTimes: number[];
  isReentrant: boolean;
  processLabel: string;
  label: string;
  key: string;
}

export const VISIT_SHARED_FIELDS = [
  "processTime", "recipeTime", "processRecipe", "processType", "slotIds",
  "weight", "moveTimeOffset", "qTimeLimit", "residencyConstraint",
  "beforeCleanRefs", "afterCleanRefs",
] as const;

type VisitSharedField = typeof VISIT_SHARED_FIELDS[number];

/** 深复制可序列化的字段值，同时保留 undefined。 */
function cloneValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** 提取可在同一 Stage 的候选腔室之间共享的 Visit 参数。 */
export function cloneVisitParameters(visit?: RouteVisit): Partial<RouteVisit> {
  return Object.fromEntries(
    VISIT_SHARED_FIELDS.map((key) => [key, cloneValue(visit?.[key])]),
  ) as Partial<RouteVisit>;
}

/**
 * 汇总 Route 的加工工序数量、并行机器结构、候选腔室路径与加工时间。
 * 任一加工腔室出现在多个加工 Stage 时，该路径视为重入路径，并使用统一分组键。
 */
export function processProfile(route: RouteDefinition): RouteProcessProfile {
  const processStages = (route.stages || []).filter((stage) => stage.needProcess);
  const candidateGroups = processStages.map((stage) => [
    ...new Set((stage.visits || [])
      .map((visit) => String(visit.stationName || "").trim())
      .filter(Boolean)),
  ]);
  const counts = candidateGroups.map((candidates) => candidates.length);
  const candidatePath = candidateGroups.map(
    (candidates) => candidates.join("/") || "未选择腔室",
  );
  const processTimes = processStages.map(
    (stage) => Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0),
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
    processLabel: isReentrant
      ? "重入组"
      : processCount === 0 ? "无加工工序" : `${processCount} 道工序`,
    label: isReentrant
      ? "重入路径"
      : processCount === 0 ? "(0)" : `(${counts.join(", ")})`,
    key: isReentrant
      ? "reentrant"
      : processCount === 0 ? "0:none" : `${processCount}:${counts.join(",")}`,
  };
}

/** 把秒数格式化为 Route 自动名称中的紧凑文本。 */
function formatSeconds(value: number): string {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${Number.isInteger(number) ? number : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s`
    : "未设置";
}

function cleanNames(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(rows.map((item) => String(item || "").trim()).filter(Boolean))];
}

/** 汇总 Route 级和加工 Step 级 Clean 引用，供自动名称区分清洁配置。 */
export function routeCleanSignature(route: RouteDefinition): string {
  const parts: string[] = [];
  const append = (label: string, value: unknown) => {
    const names = cleanNames(value);
    if (names.length) parts.push(`${label}:${names.join("+")}`);
  };
  append("Pre", route.prePJobCleanRefs);
  append("Post", route.postPJobCleanRefs);
  append("CJob", route.postCJobCleanRefs);
  (route.stages || []).filter((stage) => stage.needProcess).forEach((stage, index) => {
    const before = [...new Set((stage.visits || []).flatMap((visit) => cleanNames(visit.beforeCleanRefs)))];
    const after = [...new Set((stage.visits || []).flatMap((visit) => cleanNames(visit.afterCleanRefs)))];
    append(`S${index + 1}前`, before);
    append(`S${index + 1}后`, after);
  });
  return parts.join(" · ");
}

/** 返回 Route 中已设置的最小驻留约束；-1 表示不限制，不参与命名。 */
export function minimumResidencyConstraint(route: RouteDefinition): number | null {
  const limits = (route.stages || [])
    .filter((stage) => stage.needProcess)
    .flatMap((stage) => stage.visits || [])
    .map((visit) => Number(visit.residencyConstraint))
    .filter((limit) => Number.isFinite(limit) && limit >= 0);
  return limits.length ? Math.min(...limits) : null;
}

/** 根据 Route 工艺结构生成仅描述路径拓扑的模板名称，不含时间、清洁或驻留。 */
export function automaticTemplateName(profile: RouteProcessProfile): string {
  if (profile.processCount === 0) return "无加工工序";
  return profile.candidatePath.join(" → ");
}

/** 按加工路径、加工时间和 Clean 配置生成稳定、可读的 Route 名称。 */
export function automaticRouteName(
  profile: RouteProcessProfile,
  cleanSignature = "",
  minimumResidency: number | null = null,
): string {
  const processName = profile.processCount === 0
    ? "无加工工序"
    : profile.candidatePath.map(
      (path, index) => `${path}(${formatSeconds(profile.processTimes[index])})`,
    ).join(" → ");
  const suffixes = [
    cleanSignature,
    minimumResidency === null ? "" : `驻留 ${formatSeconds(minimumResidency)}`,
  ].filter(Boolean);
  return suffixes.length ? `${processName} · ${suffixes.join(" · ")}` : processName;
}

/** 按工序数量及各工序并行机器数排序 Route 工艺结构。 */
export function compareProfiles(left: RouteProcessProfile, right: RouteProcessProfile): number {
  if (left.processCount !== right.processCount) return left.processCount - right.processCount;
  for (let index = 0; index < Math.max(left.counts.length, right.counts.length); index += 1) {
    if ((left.counts[index] ?? -1) !== (right.counts[index] ?? -1)) {
      return (left.counts[index] ?? -1) - (right.counts[index] ?? -1);
    }
  }
  return 0;
}

/** 返回同一 Stage 候选 Visit 之间值不一致的共享字段。 */
export function differenceFields(
  stage: RouteStage,
  normalizeVisit: (visit: RouteVisit) => RouteVisit = (value) => value,
): VisitSharedField[] {
  if ((stage.visits || []).length < 2) return [];
  const first = normalizeVisit(stage.visits![0]);
  return VISIT_SHARED_FIELDS.filter((key) => stage.visits!.slice(1).some(
    (visit) => JSON.stringify(normalizeVisit(visit)[key]) !== JSON.stringify(first[key]),
  ));
}

/** 用第一个候选 Visit 的共享参数同步同一 Stage 的其他候选。 */
export function synchronizeVisits(
  stage: RouteStage,
  normalizeVisit: (visit: RouteVisit) => RouteVisit = (value) => value,
): void {
  if (!(stage.visits || []).length) return;
  const parameters = cloneVisitParameters(normalizeVisit(stage.visits![0]));
  stage.visits!.forEach((visit) => Object.assign(visit, structuredClone(parameters)));
}

/** 替换 Stage 候选腔室，并尽量保留已有候选的独立参数。 */
export function replaceCandidates(
  stage: RouteStage,
  names: string[],
  makeVisit: (stationName: string) => RouteVisit,
  normalizeVisit: (visit: RouteVisit) => RouteVisit = (value) => value,
): void {
  const selected = [...new Set((names || []).map((name) => String(name || "").trim()).filter(Boolean))];
  const prior = new Map((stage.visits || []).map((visit) => [visit.stationName, visit]));
  const template = stage.visits?.length
    ? cloneVisitParameters(normalizeVisit(stage.visits[0]))
    : cloneVisitParameters(normalizeVisit(makeVisit("")));
  stage.visits = selected.map(
    (name) => prior.get(name) || { stationName: name, ...structuredClone(template) },
  );
}

/** 只返回各轮 PJob 实际引用的 Route。 */
export function selectReferencedRoutes(
  routes: RouteDefinition[],
  rounds: Array<Record<string, unknown>>,
): RouteDefinition[] {
  const referencedNames = new Set((rounds || []).flatMap((round) => (
    ((round.cjobs as Array<Record<string, unknown>> | undefined) || []).flatMap((cjob) => (
      ((cjob.pjobs as Array<Record<string, unknown>> | undefined) || [])
        .map((pjob) => String(pjob.routeRef || "").trim())
    ))
  )));
  return (routes || []).filter((route) => referencedNames.has(String(route.name || "").trim()));
}

/** 空 Recipe 名称使用加工 Step 的稳定派生名称。 */
export function processRecipeName(value: unknown, fallback: unknown): string {
  const explicitName = String(value ?? "").trim();
  return explicitName || String(fallback ?? "").trim();
}

/**
 * 按 Step 的加工语义统一 Visit 配方；非加工 Step 必须清除从旧候选继承的配方。
 *
 * @param stage 当前 Route Step；函数会原地更新其中的 Visit。
 * @param recipeName 加工 Step 缺少显式配方时使用的稳定派生名称。
 * @param normalizeVisit Visit 默认字段归一化函数。
 * @returns 是否修改了任一配方字段或 Recipe Time，供页面加载历史数据时触发自动保存。
 */
export function normalizeStageProcessRecipes(
  stage: RouteStage,
  recipeName: string,
  normalizeVisit: (visit: RouteVisit) => RouteVisit = (value) => value,
): boolean {
  const needsProcess = stage.needProcess === true;
  let changed = false;
  for (const visit of stage.visits || []) {
    normalizeVisit(visit);
    const normalizedRecipe = needsProcess
      ? processRecipeName(visit.processRecipe, recipeName)
      : "";
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
