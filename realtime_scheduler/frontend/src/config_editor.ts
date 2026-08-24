/**
 * 调度平台的浏览器入口。
 * 负责页面状态、编辑交互和本地调度 API 协作；纯 Route 逻辑位于 route_editor_logic.ts。
 *
 * 该文件由原有页面控制器无行为变化迁移而来；DOM 事件仍采用动态结构，
 * 暂由构建器校验语法，新增的独立业务模块必须通过完整 TypeScript 类型检查。
 */

// @ts-nocheck
import * as RouteEditorLogic from "./route_editor_logic";
import {
  requestJson,
  requestScheduleAnalysis,
  requestSearchControl,
  requestSearchTelemetry,
  requestTestGroupAnalysis,
} from "./api_client";
import { createVisualizationWorkspace, detectDeviceTopologyLayout } from "./workspace_visualizer";
import { renderTestGroupAnalysis, testGroupSummaryCsv } from "./group_analysis_view";
import { createDocumentationView } from "./documentation_view";
import {
  CJOB_TYPES,
  TASK_MODES,
  linkRouteSteps,
  makeCJob,
  makePJob,
  makeRound,
  makeStage,
  makeVisit,
  normalizeRound,
  normalizeVisit,
  stringList,
} from "./editor_models";

const { VISIT_SHARED_FIELDS, automaticTemplateName, selectReferencedRoutes } = RouteEditorLogic;
const visualizationWorkspace = createVisualizationWorkspace();
const documentationView = createDocumentationView(document.getElementById("documentationRoot"));
const batchPerformanceAnalyses = new Map();
const batchBottleneckSummaries = new Map();
const batchBottleneckRequests = new Map();
const batchBottleneckErrors = new Map();

const EXPECTED_API_SCHEMA = "cjob-pjob-v3";
const DEFAULT_SCHEDULE_OPTIONS = Object.freeze({
  loadLockManager: "petri-look",
  residencyGuardSeconds: 0,
  maximumRobotHoldingSeconds: 0,
  maximumSystemResidenceCv: 0,
  loadLockMacroSearchSeconds: 4,
  loadLockMacroRollouts: 96,
  scheduleAlphaGoModelPath: "",
  seed: 0,
});
const SCHEDULE_OPTION_KEYS = new Set(Object.keys(DEFAULT_SCHEDULE_OPTIONS));

const CLEAN_TYPE_DEFINITIONS = [
  { key: "preclean", label: "PreClean" },
  { key: "postclean", label: "PostClean" },
  { key: "wacclean", label: "WAC Clean" },
  { key: "dummy", label: "Dummy" },
  { key: "dummywac", label: "Dummy WAC" },
];
const ROUTE_CLEAN_KEYS = ["prePJobCleanRefs", "postPJobCleanRefs", "postCJobCleanRefs"];
const PROCESSING_STATION_TYPES = new Set([
  "processchamber",
  "multiprocesschamber",
  "heater",
  "cooler",
]);
const FIRST_ROBOT_SLOT_ID = 1;
const DUAL_ARM_SLOT_COUNT = 2;
const SEARCH_TELEMETRY_POLL_MILLISECONDS = 75;
const STATION_ACTION_TIME_FIELDS = [
  { key: "PickPrepareTime", label: "取片准备" },
  { key: "PickCompleteTime", label: "取片完成" },
  { key: "PlacePrepareTime", label: "放片准备" },
  { key: "PlaceCompleteTime", label: "放片完成" },
  { key: "PostCompleteTime", label: "动作后处理" },
];
const ROBOT_ACTION_TIME_FIELDS = [
  { key: "PickTime", label: "取片" },
  { key: "PlaceTime", label: "放片" },
];

const state = {
  workspaceDevices: [], workspaceDevice: null, workspaceDeviceId: "", testCaseId: "", testCaseName: "", testCaseGroup: "", activeTestGroup: "", serviceCompatible: false, dirty: false,
  activeBatchId: "", batchRunning: false, batchCancelRequested: false, batchCancelSent: false, batchResult: null, selectedBatchTestId: "", parameterComparison: null,
  deviceName: "", baseDevice: null, device: null, stationNames: [], loadPorts: [], processModules: [], robotNames: [], robotScopes: {}, robotSlots: {}, robotSlotsSaving: new Set(),
  deviceConfigSection: "station-time", deviceStationName: "", deviceRobotName: "", deviceRobotTransferSources: {}, deviceTimingDraft: null, deviceTimingDirty: false, deviceTimingSaving: false, deviceTimingStatusMessage: "选择设备后开始配置",
  strategy: "heuristic", availableAlgorithms: [], algorithmMetadata: {}, roundCount: 2, times: [0, 70], options: { ...DEFAULT_SCHEDULE_OPTIONS },
  cleans: [],
  routes: [{ name: "RouteA", group: "RouteA", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps([makeStage("LP1"), makeStage("Robot"), makeStage("PM1,PM2", true, "RouteA_Step2"), makeStage("Robot"), makeStage("LP1")]) }],
  rounds: [makeRound(1, 0, "RouteA", "LP1"), makeRound(2, 70, "RouteA", "LP2")],
  testRouteConfigs: {}, routeDirty: false, routeGroupingProfiles: new Map(),
  routeEditingIndex: -1, routeEditSnapshot: null, routeEditGroupingProfile: null, routeEditIsNew: false,
  drawer: null, cleanDialogContext: null, expandedRouteProcessGroups: new Set(), expandedRouteGroups: new Set(), expandedRoutes: new Set(), routeNameChanges: new Map(),
  routeProcessFilter: "", routeParallelFilter: ""
};
let pjobRoutePickerContext = null;
let searchTelemetryPollToken = 0;
let latestSearchTelemetry = null;
let selectedSearchTelemetryId = "";
let followLatestSearchTelemetry = true;
let searchTelemetryRunActive = false;
let searchTelemetryControlPending = false;
let lastSearchTelemetryMoveCount = 0;
/** 是否在步进模式下持续提交每一轮搜索的模型推荐动作。 */
let continuousDecisionEnabled = false;
/** 已由持续决策提交的 searchId；防止同一遥测帧被轮询重复提交。 */
let continuousDecisionSubmittedSearchId = "";
/** 拓扑回放页面的求解模式：回放模式连续求解，步进模式等待用户选择根动作。 */
let playbackMode = "replay";
/** 用户最近一次 choose 的根动作键；用于回放历史时高亮实际执行的动作。 */
let userChosenActionKey = "";
/** 用户最近一次 choose 对应的根决策 searchId；跨决策后不再沿用旧高亮。 */
let userChosenSearchId = "";
/** 控制请求在途时待补发的模式切换命令；避免前后端执行模式失步。 */
let pendingModeSync = "";
/** “运行模型步进”是否正在运行；运行中按钮变为停止入口。 */
let stepRunActive = false;
/** 停止请求是否已在途；避免重复发送。 */
let stepRunCancelling = false;
/** 普通单测通过 clientRunId 轮询真实 init/update/output 阶段。 */
let singleRunActive = false;
let singleRunCancelling = false;
let activeSingleRunId = "";
let singleRunAbortController: AbortController | null = null;
let runStatusStartedAt = 0;
let runStatusElapsedMs = 0;
let runStatusTimer = 0;
let pendingAlphaGoCheckpointFile: File | null = null;
let dataTransferMode: "import" | "export" = "import";
/**
 * 当前页面会话统一使用的运行配置。
 *
 * 测试集仍会各自保存调度参数，便于在新页面会话中恢复；但用户已选择的策略、
 * checkpoint 和参数不能在切换测试集时被另一个测试集的旧配置覆盖。此状态只在
 * 当前页面存活期间保留，关闭页面后会自然清除。
 */
let sessionSchedulingConfiguration: { strategy: string; options: Record<string, unknown> } | null = null;

/** 将当前策略和调度参数设为本页面会话后续测试共用的运行配置。 */
function retainSessionSchedulingConfiguration() {
  sessionSchedulingConfiguration = structuredClone({
    strategy: state.strategy,
    options: state.options,
  });
}

/** 从新版字段或旧版任务参数识别清洁类别。 */
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

/** 兼容旧 Clean，并保留弹窗需要编辑的类型、时长和适用腔室。 */
function normalizeClean(clean) {
  const value = { ...(clean || {}) }, cleanType = inferCleanType(value);
  const isDummy = cleanType === "dummy" || cleanType === "dummywac";
  const name = String(value.name || `Clean${state.cleans.length + 1}`).trim() || `Clean${state.cleans.length + 1}`;
  value.name = name;
  value.cleanType = cleanType;
  value.recipeName = String(value.recipeName || value.recipeRef || `${name}-Recipe`).trim() || `${name}-Recipe`;
  const recipeTime = Number(value.recipeTime);
  value.recipeTime = Math.max(0, Number.isFinite(recipeTime) ? recipeTime : 0);
  // Dummy Clean 的触发数量由接口中的 CheckConditions.MaterialCount 表示；
  // 旧数据没有 triggerCount 时兼容读取 materialCount，避免编辑后重置为默认值。
  const defaultTriggerCount = isDummy ? 2 : 5;
  value.triggerCount = Math.max(1, Math.floor(Number(
    isDummy ? (value.materialCount ?? value.triggerCount) : (value.triggerCount ?? value.lower),
  ) || defaultTriggerCount));
  if (isDummy) value.materialCount = value.triggerCount;
  const wacRecipeTime = Number(value.wacRecipeTime ?? value.emptyRecipeTime);
  value.wacRecipeTime = Math.max(0, Number.isFinite(wacRecipeTime) ? wacRecipeTime : 20);
  value.modules = [...new Set(stringList(value.modules))];
  return value;
}

/** 把清洁时长格式化为 Clean 自动名称中的紧凑文本。 */
function formatCleanSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未设置";
  const text = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${text}s`;
}

/** 根据清洁类别与时长生成稳定、可读的 Clean 名称。 */
function automaticCleanName(clean) {
  const value = normalizeClean(clean);
  const labels = Object.fromEntries(CLEAN_TYPE_DEFINITIONS.map(item => [item.key, item.label]));
  const mainDuration = formatCleanSeconds(value.recipeTime);
  if (value.cleanType === "dummywac") {
    return `${labels[value.cleanType]} · ${value.triggerCount}片 · 主清洁 ${mainDuration} · WAC ${formatCleanSeconds(value.wacRecipeTime)}`;
  }
  if (value.cleanType === "dummy") return `${labels[value.cleanType]} · ${value.triggerCount}片 · ${mainDuration}`;
  return `${labels[value.cleanType]} · ${mainDuration}`;
}

/** 把路径中所有旧 Clean 引用替换为自动生成的新名称。 */
function renameCleanReferences(oldName, newName) {
  if (!oldName || oldName === newName) return;
  const rename = value => stringList(value).map(name => name === oldName ? newName : name);
  Object.values(state.testRouteConfigs).forEach(config => {
    ROUTE_CLEAN_KEYS.forEach(key => { config[key] = rename(config[key]); });
    Object.values(config.stages || {}).forEach(stage => {
      stage.beforeCleanRefs = rename(stage.beforeCleanRefs);
      stage.afterCleanRefs = rename(stage.afterCleanRefs);
    });
  });
}

/** 统一新旧 Clean 名称；同类型同时间的重复项使用稳定序号区分。 */
function synchronizeCleanNames() {
  const occurrences = new Map();
  let changed = false;
  state.cleans = state.cleans.map(normalizeClean);
  state.cleans.forEach(clean => {
    const baseName = automaticCleanName(clean);
    const occurrence = (occurrences.get(baseName) || 0) + 1;
    occurrences.set(baseName, occurrence);
    const generatedName = occurrence === 1 ? baseName : `${baseName} · #${occurrence}`;
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

/** 将精简编辑模型展开为调度接口使用的 Clean 模板，并保留显式适用腔室。 */
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
    emptyRecipeRef: type === "dummywac" ? `${value.recipeName}-WAC` : "",
  };
}

/** 创建一个使用默认时长且尚未选择腔室的 Clean。 */
function makeClean(cleanType = "preclean") {
  return normalizeClean({ name: "", cleanType, recipeTime: 20, triggerCount: 5, wacRecipeTime: 20, modules: [] });
}

/** 判断 Step 是否使用 Robot；旧数据没有类型时按已有候选项和原有交替规则兼容。 */
function stageUsesRobot(stage, index) {
  const names = (stage.visits || []).map(visit => visit.stationName).filter(Boolean);
  return stage.kind === "robot" || (names.length ? names.every(name => state.robotNames.includes(name)) : index % 2 === 1);
}

/** 深拷贝 Visit 公共参数，避免数组或对象在候选 Visit 间共享引用。 */
function cloneVisitParameters(visit) {
  return RouteEditorLogic.cloneVisitParameters(visit);
}

/** 判断 Route Step 是否为固定的 Src/Sink；运行时使用 CJob LoadPort 覆盖。 */
function isFixedRouteStep(route, index) {
  const stages = route?.stages || [];
  return index === 0 || index === stages.length - 1;
}

/** 返回 Step 类型的简短名称；首尾固定模块分别显示为 Src 与 Sink。 */
function stepKind(route, index) {
  if (!route?.stages?.length) return "Station";
  if (index === 0) return "Src";
  if (index === route.stages.length - 1) return "Sink";
  return stageUsesRobot(route.stages[index], index) ? "Robot" : "Station";
}

/** 统一补全 Step 的派生字段，避免 StepID、PostStepID、NeedProcess 被手工改坏。 */
function normalizeRoute(route, normalizationChanges = null) {
  route.stages = Array.isArray(route.stages) ? route.stages : [];
  ROUTE_CLEAN_KEYS.forEach(key => { route[key] = stringList(route[key]); });
  route.postCJobCleanRefs = [];
  route.bufferOption = Math.max(0, Math.min(4, Math.trunc(Number(route.bufferOption) || 0)));
  linkRouteSteps(route.stages);
  route.stages.forEach((stage, index) => {
    stage.visits = Array.isArray(stage.visits) ? stage.visits : [];
    stage.kind = stageUsesRobot(stage, index) ? "robot" : "station";
    stage.needProcess = stage.kind === "station" && stage.visits.some(visit => state.processModules.includes(visit.stationName));
    const recipeName = stage.needProcess ? `${route.group || route.name || "Route"}_Step${stage.stepId}` : "";
    const recipesChanged = RouteEditorLogic.normalizeStageProcessRecipes(stage, recipeName, normalizeVisit);
    if (recipesChanged && normalizationChanges) normalizationChanges.changed = true;
  });
  return route;
}

/** 比较候选 Visit 公共参数，并返回旧数据中不一致的字段。 */
function visitDifferenceFields(stage) {
  return RouteEditorLogic.differenceFields(stage, normalizeVisit);
}

/** 把允许编辑的 Step 参数同步到全部候选，并强制 Recipe Time 跟随 Process Time。 */
function synchronizeStageVisits(stage) {
  if (!(stage.visits || []).length) return;
  const first = normalizeVisit(stage.visits[0]);
  const editableValues = {
    processTime: Number(first.processTime),
    recipeTime: Number(first.processTime),
    qTimeLimit: Number(first.qTimeLimit),
    residencyConstraint: Number(first.residencyConstraint),
    beforeCleanRefs: structuredClone(stringList(first.beforeCleanRefs)),
    afterCleanRefs: structuredClone(stringList(first.afterCleanRefs)),
  };
  stage.visits.forEach(visit => Object.assign(visit, structuredClone(editableValues)));
}

/** 将列表中选择的候选设备同步为一组 Visit；新增项继承第一个候选的公共参数。 */
function setStageCandidates(routeIndex, stageIndex, names) {
  const route = state.routes[routeIndex], stage = route.stages[stageIndex];
  RouteEditorLogic.replaceCandidates(stage, names, makeVisit, normalizeVisit);
  normalizeRoute(route);
}

/** 读取一个 Step 的首个候选参数，作为测试侧 Route 配置的默认值。 */
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
    slotIds: String(first.slotIds || "1"),
  };
}

/** 为一条路径模板生成测试侧默认配置；旧数据中嵌在 Route 上的时间与清洁会迁移到这里。 */
function defaultRouteConfigForRoute(route) {
  normalizeRoute(route);
  return {
    bufferOption: Math.max(0, Math.min(4, Math.trunc(Number(route.bufferOption) || 0))),
    prePJobCleanRefs: structuredClone(stringList(route.prePJobCleanRefs)),
    postPJobCleanRefs: structuredClone(stringList(route.postPJobCleanRefs)),
    postCJobCleanRefs: structuredClone(stringList(route.postCJobCleanRefs)),
    stages: Object.fromEntries((route.stages || []).map(stage => [
      String(stage.stepId),
      stageDefaultConfig(stage),
    ])),
  };
}

/** 规范化测试侧 Route 配置，确保结构与当前路径模板的 Step 对齐。 */
function normalizeTestRouteConfigs(raw, routes) {
  const configs = raw && typeof raw === "object" && !Array.isArray(raw) ? structuredClone(raw) : {};
  const normalized = {};
  for (const route of routes || []) {
    const routeName = String(route.name || "").trim();
    if (!routeName) continue;
    const base = configs[routeName] || defaultRouteConfigForRoute(route);
    const stages = {};
    (route.stages || []).forEach(stage => {
      const stepId = String(stage.stepId);
      const override = base.stages?.[stepId] ? base.stages[stepId] : stageDefaultConfig(stage);
      stages[stepId] = {
        ...stageDefaultConfig(stage),
        ...(override && typeof override === "object" ? override : {}),
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
        slotIds: String(override?.slotIds ?? stageDefaultConfig(stage).slotIds),
      };
    });
    normalized[routeName] = {
      bufferOption: Math.max(0, Math.min(4, Math.trunc(Number(base.bufferOption) || 0))),
      prePJobCleanRefs: stringList(base.prePJobCleanRefs),
      postPJobCleanRefs: stringList(base.postPJobCleanRefs),
      postCJobCleanRefs: stringList(base.postCJobCleanRefs),
      stages,
    };
  }
  return normalized;
}

/** 把测试侧 Route 配置合并到路径模板，生成运行时可提交的 Route。 */
function runtimeRouteForTemplate(route) {
  const routeName = String(route?.name || "").trim();
  const config = state.testRouteConfigs[routeName] || defaultRouteConfigForRoute(route);
  const merged = structuredClone(route);
  normalizeRoute(merged);
  merged.bufferOption = Number(config.bufferOption ?? merged.bufferOption ?? 0);
  merged.prePJobCleanRefs = stringList(config.prePJobCleanRefs);
  merged.postPJobCleanRefs = stringList(config.postPJobCleanRefs);
  merged.postCJobCleanRefs = stringList(config.postCJobCleanRefs);
  (merged.stages || []).forEach(stage => {
    const stepId = String(stage.stepId);
    const override = config.stages?.[stepId];
    if (!override) return;
    (stage.visits || []).forEach(visit => {
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
    RouteEditorLogic.synchronizeVisits(stage, normalizeVisit);
  });
  return merged;
}

/** 返回所有路径模板合并测试配置后的运行时 Route 列表。 */
function runtimeRoutes() {
  return (state.routes || []).map(route => runtimeRouteForTemplate(route));
}

/** 将编辑态 Route 收敛为只包含路径拓扑的共享模板。 */
function routeTemplateForSave(route) {
  const template = structuredClone(route);
  normalizeRoute(template);
  template.bufferOption = 0;
  ROUTE_CLEAN_KEYS.forEach(key => { template[key] = []; });
  template.stages = (template.stages || []).map(stage => ({
    stepId: Number(stage.stepId),
    postStepIds: structuredClone(stage.postStepIds || []),
    needProcess: stage.needProcess === true,
    kind: stage.kind,
    visits: (stage.visits || []).map(visit => ({ stationName: String(visit.stationName || "") })),
  }));
  return template;
}

/** 记录当前已保存结构对应的分组，编辑草稿在保存前继续停留在原分组。 */
function captureRouteGroupingProfiles() {
  state.routeGroupingProfiles = new Map(
    state.routes.map(route => [route, structuredClone(routeProcessProfile(route))]),
  );
}

/** 返回路径当前应使用的分组结构；新增路径没有快照时使用草稿结构。 */
function routeGroupingProfile(route) {
  return state.routeGroupingProfiles.get(route) || routeProcessProfile(route);
}

/** 对所有轮次重新计算派生字段，并同步兼容的 times 数组。 */
function normalizeRounds() {
  let nextTaskId = 1;
  state.rounds = state.rounds.map((round, index) => {
    const normalized = normalizeRound(
      round,
      index + 1,
      state.times[index],
      nextTaskId,
      state.loadPorts,
    );
    nextTaskId += normalized.cjobs.length;
    return normalized;
  });
  let nextMaterialId = 1;
  state.rounds.forEach(round => round.cjobs.forEach(cjob => cjob.pjobs.forEach(pjob => {
    pjob.matList = Array.from({ length: pjob.waferCount }, () => nextMaterialId++);
  })));
  state.times = state.rounds.map(round => Number(round.currentTime));
}

/** 转义动态 HTML 文本。 */
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char])); }

/** 格式化抽屉中的只读参数。 */
function readonlyText(value) {
  if (value === undefined || value === null || value === "") return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** 绘制抽屉内统一的只读字段。 */
function renderReadonlyField(label, value, wide = false) {
  return `<div class="readonly-field ${wide ? "wide" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(readonlyText(value))}</strong></div>`;
}

/** 生成单选下拉选项。 */
function optionsHtml(values, selected, emptyLabel = "请选择") {
  return `<option value="">${escapeHtml(emptyLabel)}</option>` + values.map(value => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}

/** 生成多选下拉选项。 */
function multiOptionsHtml(values, selected) {
  const chosen = new Set(stringList(selected));
  return values.map(value => `<option value="${escapeHtml(value)}" ${chosen.has(value) ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}

/** 从 input_data 录制数组或普通 init 对象提取设备。 */
function unwrapDevice(raw) {
  let value = raw;
  if (Array.isArray(value)) { const entry = value.find(item => item && String(item.Describe || "").toLowerCase() === "alginit"); if (!entry) throw new Error("设备文件中找不到 Describe=AlgInit"); value = entry.Info; }
  if (value?.InitData) value = value.InitData;
  if (value?.Info?.Stations) value = value.Info;
  if (!value || typeof value !== "object" || !value.Stations || !value.Robots) throw new Error("设备文件必须包含 Stations 和 Robots");
  return value;
}

/** 解析标准 JSON，兼容由多条顶层日志对象加逗号串联的设备录制文件。 */
function parseDeviceFileText(text: string) {
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

/** 导入设备到本地工作区；相同拓扑会直接复用已有设备。 */
async function loadDevice(file) {
  if (!file) return;
  if (state.dirty) await saveCurrentTest(true);
  const device = unwrapDevice(parseDeviceFileText(await file.text()));
  const result = await requestJson("/api/workspaces/devices", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, device })
  });
  await loadWorkspaceCatalog(result.device.id);
  writeTerminal(`$ ${result.created ? "已导入" : "已选择已有"}设备 ${result.device.name}\n  该设备下有 ${state.workspaceDevice?.tests?.length || 0} 个测试集`);
  document.getElementById("deviceFile").value = "";
}

/** 打开统一的设备/测试集导入导出选择窗口。 */
function openDataTransferDialog(mode: "import" | "export") {
  dataTransferMode = mode;
  const importing = mode === "import";
  document.getElementById("dataTransferDialogTitle").textContent = importing ? "导入数据" : "导出数据";
  document.getElementById("dataTransferDialogDescription").textContent = importing
    ? "选择导入整台设备，或把测试集加入当前相同设备。"
    : "设备包包含设备下全部信息；测试集包只包含当前测试及所需路径。";
  document.getElementById("deviceTransferOptionTitle").textContent = importing ? "导入设备" : "导出当前设备";
  document.getElementById("deviceTransferOptionDescription").textContent = importing
    ? "支持同事分享的设备包，也支持新的 init JSON。"
    : "包含 init、路径、组别和该设备下全部测试集。";
  document.getElementById("testTransferOptionTitle").textContent = importing ? "导入测试集" : "导出当前测试集";
  document.getElementById("testTransferOptionDescription").textContent = importing
    ? "只能导入到 init 完全相同的当前设备。"
    : "接收方必须拥有 init 完全相同的设备。";
  document.getElementById("deviceTransferOption").disabled = !importing && !state.workspaceDeviceId;
  document.getElementById("testTransferOption").disabled = !state.workspaceDeviceId || (!importing && !state.testCaseId);
  const status = document.getElementById("dataTransferStatus");
  status.textContent = importing && !state.workspaceDeviceId ? "尚未选择设备时，只能导入设备。" : "";
  status.classList.remove("error");
  (document.getElementById("dataTransferDialog") as HTMLDialogElement).showModal();
}

/** 下载交换包，并在服务端拒绝时显示真实业务错误。 */
async function downloadWorkspaceArchive(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result?.error || `服务返回 ${response.status}`);
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

/** 在导出前保存当前草稿，确保交换包与页面看到的内容一致。 */
async function exportWorkspaceData(kind: "device" | "test") {
  if (!state.workspaceDeviceId) throw new Error("请先选择设备");
  if (state.dirty) await saveCurrentTest(true);
  if (state.deviceTimingDirty) await saveDeviceTiming();
  if (kind === "test" && !state.testCaseId) throw new Error("请先选择测试集");
  const url = kind === "device"
    ? `/api/workspaces/${encodeURIComponent(state.workspaceDeviceId)}/export`
    : `/api/workspaces/${encodeURIComponent(state.workspaceDeviceId)}/tests/${encodeURIComponent(state.testCaseId)}/export`;
  await downloadWorkspaceArchive(url);
  (document.getElementById("dataTransferDialog") as HTMLDialogElement).close();
  setWorkspaceStatus(kind === "device" ? "已开始导出当前设备" : "已开始导出当前测试集", "saved");
}

/** 上传新版交换包，并把后端错误转换为页面可读消息。 */
async function uploadWorkspaceArchive(file: File, kind: "device" | "test") {
  if (!file) return;
  if (state.dirty) await saveCurrentTest(true);
  const url = kind === "device"
    ? "/api/workspaces/import/device"
    : `/api/workspaces/${encodeURIComponent(state.workspaceDeviceId)}/import-test`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/zip", "X-Data-Filename": encodeURIComponent(file.name) },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) throw new Error(result?.error || `服务返回 ${response.status}`);
  if (kind === "device") {
    await loadWorkspaceCatalog(result.device.id);
    setWorkspaceStatus(`已导入设备“${result.device.name}”及 ${result.importedTests} 个测试集`, "saved");
  } else {
    await loadWorkspaceCatalog(state.workspaceDeviceId, result.test.id);
    setWorkspaceStatus(result.created ? `已导入测试集“${result.test.name}”` : `测试集“${result.test.name}”已存在`, "saved");
  }
  (document.getElementById("dataTransferDialog") as HTMLDialogElement).close();
}

/** 根据弹窗模式执行设备或测试集操作。 */
async function chooseDataTransfer(kind: "device" | "test") {
  const status = document.getElementById("dataTransferStatus");
  status.textContent = "";
  status.classList.remove("error");
  try {
    if (dataTransferMode === "export") {
      await exportWorkspaceData(kind);
      return;
    }
    if (kind === "test" && !state.workspaceDeviceId) throw new Error("请先选择测试集所属的相同设备");
    document.getElementById(kind === "device" ? "deviceFile" : "testExchangeFile").click();
  } catch (error) {
    status.textContent = error.message || "操作失败";
    status.classList.add("error");
  }
}

/** 从 ArmInfo 收集槽位；一个物理 Arm 可以包含多个晶圆手槽。 */
function robotAvailableSlots(robot) {
  const slots = new Set();
  const addSlots = (rawSlots, scalarIsCapacity = false) => {
    let values = [];
    if (Number.isInteger(rawSlots) && typeof rawSlots !== "boolean") {
      values = scalarIsCapacity
        ? Array.from({ length: Math.max(0, rawSlots) }, (_, index) => index + FIRST_ROBOT_SLOT_ID)
        : [rawSlots];
    } else if (Array.isArray(rawSlots)) values = rawSlots;
    else if (rawSlots && typeof rawSlots === "object") values = Object.keys(rawSlots);
    values.forEach(value => {
      const slotId = Number(value);
      if (Number.isInteger(slotId) && slotId >= FIRST_ROBOT_SLOT_ID) slots.add(slotId);
    });
  };
  Object.values(robot?.ArmInfo || {}).forEach(arm => addSlots(arm?.SlotIDs));
  if (Object.values(robot?.ArmInfo || {}).some(arm => arm && typeof arm === "object")) {
    for (let slotId = FIRST_ROBOT_SLOT_ID; slotId < FIRST_ROBOT_SLOT_ID + DUAL_ARM_SLOT_COUNT; slotId += 1) slots.add(slotId);
  }
  addSlots(robot?.Capacity, true);
  return [...(slots.size ? slots : new Set([FIRST_ROBOT_SLOT_ID]))].sort((left, right) => left - right);
}

/** 按设备原始 ArmInfo 返回物理 Arm 对应的槽位组。 */
function robotArmSlotGroups(robot) {
  const declaredGroups = Object.entries(robot?.ArmInfo || {}).flatMap(([armName, arm]) => {
    if (!arm || typeof arm !== "object") return [];
    const slotIds = [...new Set((arm.SlotIDs || []).map(Number).filter(
      slotId => Number.isInteger(slotId) && slotId >= FIRST_ROBOT_SLOT_ID
    ))].sort((left, right) => left - right);
    return slotIds.length ? [{ armName, slotIds }] : [];
  });
  const groups = declaredGroups.length ? declaredGroups : [];
  const coveredSlots = new Set(groups.flatMap(group => group.slotIds));
  robotAvailableSlots(robot).filter(slotId => !coveredSlots.has(slotId)).forEach(slotId => {
    groups.push({
      armName: generatedRobotArmName(groups.map(group => group.armName), slotId),
      slotIds: [slotId],
    });
  });
  return groups;
}

/** 按原始 ArmInfo 中启用的 Arm 返回设备文件默认模式。 */
function robotDefaultSlots(robot) {
  const available = robotAvailableSlots(robot);
  const requested = Object.values(robot?.ArmInfo || {})
    .filter(arm => arm && typeof arm === "object" && arm.IsEnable !== false)
    .flatMap(arm => Array.isArray(arm.SlotIDs) ? arm.SlotIDs.map(Number) : []);
  const selected = [...new Set(requested.filter(slotId => Number.isInteger(slotId) && available.includes(slotId)))].sort((left, right) => left - right);
  return selected.length ? selected : available.slice(0, 1);
}

/** 规范化设备级 Arm 槽位选择；缺失项沿用原始 ArmInfo 默认模式。 */
function normalizeRobotSlotSelections(device, rawSelections = {}) {
  const selections = rawSelections && typeof rawSelections === "object" ? rawSelections : {};
  return Object.fromEntries(Object.entries(device?.Robots || {}).map(([robotName, robot]) => {
    const available = robotAvailableSlots(robot);
    const requested = Array.isArray(selections[robotName]) ? selections[robotName].map(Number) : robotDefaultSlots(robot);
    const selected = [...new Set(requested.filter(slotId => Number.isInteger(slotId) && available.includes(slotId)))].sort((left, right) => left - right);
    return [robotName, selected.length ? selected : available];
  }));
}

/** 为设备文件缺少的第二个 Arm 生成稳定名称。 */
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

/** 复制一个物理 Arm，并保留该 Arm 被选择的全部 RobotSlot。 */
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
    arm.SlotsStationMap[stationName] = Object.fromEntries(selected.map(slotId => [
      String(slotId), structuredClone(stationSlots[String(slotId)] ?? fallback)
    ]));
  });
  return arm;
}

/** 把 Arm 槽位选择同步到前端运行时设备，后端保存时会执行同样的投影和校验。 */
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
      const retainedSlots = (sourceArm.SlotIDs || []).map(Number).filter(slotId => unmatchedSlots.has(slotId));
      if (!retainedSlots.length) return;
      projectedArms[armName] = projectRobotArmToSlots(armName, sourceArm, retainedSlots);
      retainedSlots.forEach(slotId => unmatchedSlots.delete(slotId));
    });
    [...unmatchedSlots].sort((left, right) => left - right).forEach(slotId => {
      const armName = generatedRobotArmName(
        [...Object.keys(robot.ArmInfo || {}), ...Object.keys(projectedArms)], slotId
      );
      projectedArms[armName] = projectRobotArmToSlots(armName, sourceArms[0][1], [slotId]);
    });
    robot.ArmInfo = projectedArms;
  });
  return { device, selections };
}

/** 应用设备拓扑，并建立 Route/Visit 可选模块集合。 */
function applyDeviceTopology(device, deviceName, rawRobotSlots = {}) {
  state.baseDevice = structuredClone(device);
  const configured = configuredDeviceForRobotSlots(state.baseDevice, rawRobotSlots);
  state.device = configured.device; state.robotSlots = configured.selections;
  const stations = Object.entries(state.device.Stations);
  const natural = (left, right) => left.localeCompare(right, undefined, { numeric: true });
  state.deviceName = deviceName;
  state.stationNames = stations.map(([name]) => name).sort(natural);
  state.loadPorts = stations.filter(([, item]) => String(item.Type || "").toLowerCase() === "loadport").map(([name]) => name).sort(natural);
  state.processModules = stations
    .filter(([, item]) => PROCESSING_STATION_TYPES.has(String(item.Type || "").trim().toLowerCase()))
    .map(([name]) => name)
    .sort(natural);
  state.robotNames = Object.keys(state.device.Robots).sort(natural);
  state.robotScopes = Object.fromEntries(Object.entries(state.device.Robots).map(([name, robot]) => [name, [...new Set(Object.values(robot.ArmInfo || {}).filter(arm => arm.IsEnable !== false).flatMap(arm => arm.AccessibleStations || []))]]));
  visualizationWorkspace.setDevice(state.device);
  if (!state.loadPorts.length || !state.processModules.length) throw new Error("设备必须包含 LoadPort 和 ProcessChamber");
}

/** 从设备拓扑提取页面允许修改的计时字段，避免把容量、状态等运行数据混入保存请求。 */
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
      timing.PrePrepareTime = station.PrePrepareTime.map(row => Number(row?.Time) || 0);
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
      timing.PrepTransTime = robot.PrepTransTime.map(row => Number(row?.Time) || 0);
    }
    draft.robots[robotName] = timing;
  });
  return draft;
}

/** 生成统一的秒数输入框，使用等宽数字并携带设备计时数据定位信息。 */
function deviceTimeInput(value, label, dataset) {
  const attributes = Object.entries(dataset)
    .map(([name, item]) => `data-${name}="${escapeHtml(item)}"`)
    .join(" ");
  const numericValue = Number(value);
  return `<label class="device-time-input"><input type="number" min="0" step="any" inputmode="decimal" required value="${Number.isFinite(numericValue) ? numericValue : 0}" aria-label="${escapeHtml(label)}" ${attributes}><span>s</span></label>`;
}

/** 根据当前设备、脏状态和保存状态刷新设备配置页头部反馈与操作按钮。 */
function renderDeviceConfigHeader() {
  const hasDevice = Boolean(state.workspaceDeviceId && state.baseDevice);
  document.getElementById("deviceConfigSelectedName").textContent = hasDevice
    ? displayDeviceName(state.deviceName)
    : "尚未选择设备";
  const status = document.getElementById("deviceTimingStatus");
  status.textContent = state.deviceTimingSaving
    ? "正在保存时间参数…"
    : state.deviceTimingDirty
      ? "有尚未保存的时间修改"
      : state.deviceTimingStatusMessage;
  status.classList.toggle("is-dirty", state.deviceTimingDirty);
  status.classList.toggle("is-saving", state.deviceTimingSaving);
  document.getElementById("resetDeviceTimingButton").disabled = !hasDevice || !state.deviceTimingDirty || state.deviceTimingSaving;
  document.getElementById("saveDeviceTimingButton").disabled = !hasDevice || !state.deviceTimingDirty || state.deviceTimingSaving;
}

/** 刷新站点和机器手选择器，使配置对象切换后仍保持可用的当前项。 */
function renderDeviceTimingSelectors() {
  const stationSelect = document.getElementById("deviceStationSelect");
  const robotSelect = document.getElementById("deviceRobotSelect");
  if (!state.stationNames.includes(state.deviceStationName)) state.deviceStationName = state.stationNames[0] || "";
  if (!state.robotNames.includes(state.deviceRobotName)) state.deviceRobotName = state.robotNames[0] || "";
  stationSelect.innerHTML = state.stationNames.length
    ? state.stationNames.map(name => `<option value="${escapeHtml(name)}" ${name === state.deviceStationName ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")
    : `<option value="">请先选择设备</option>`;
  robotSelect.innerHTML = state.robotNames.length
    ? state.robotNames.map(name => `<option value="${escapeHtml(name)}" ${name === state.deviceRobotName ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")
    : `<option value="">请先选择设备</option>`;
  stationSelect.disabled = !state.stationNames.length;
  robotSelect.disabled = !state.robotNames.length;
}

/** 绘制当前站点的动作时间表和 LoadLock/Aligner 等专项状态切换时间。 */
function renderDeviceStationTiming() {
  const container = document.getElementById("deviceStationTimingEditor");
  const stationName = state.deviceStationName;
  const station = state.baseDevice?.Stations?.[stationName];
  const timing = state.deviceTimingDraft?.stations?.[stationName];
  if (!station || !timing) {
    container.innerHTML = `<div class="device-config-empty"><strong>暂无可配置站点</strong><span>选择或导入设备后，可在这里校准站点动作时间。</span></div>`;
    return;
  }

  const actionControllers = [...new Set(STATION_ACTION_TIME_FIELDS.flatMap(
    ({ key }) => Object.keys(timing[key] || {}),
  ))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const actionRows = actionControllers.map(controller => `
    <tr>
      <th scope="row"><strong>${escapeHtml(controller)}</strong><small>控制机器手</small></th>
      ${STATION_ACTION_TIME_FIELDS.map(({ key, label }) => {
        if (!Object.prototype.hasOwnProperty.call(timing[key] || {}, controller)) return `<td><span class="device-time-unavailable">—</span></td>`;
        return `<td>${deviceTimeInput(timing[key][controller], `${stationName} ${controller} ${label}`, {
          "device-timing-target": "station-map",
          "device-name": stationName,
          "timing-field": key,
          "timing-key": controller,
        })}</td>`;
      }).join("")}
    </tr>
  `).join("");

  const alignmentEntries = Object.entries(timing.AlignmentTime || {});
  const prePrepareRows = Array.isArray(station.PrePrepareTime) ? station.PrePrepareTime : [];
  const specialRows = [
    ...alignmentEntries.map(([slotId, value]) => `
      <div class="device-transition-row">
        <span class="device-transition-kind">对准</span>
        <strong>Slot ${escapeHtml(slotId)}</strong>
        <span class="device-transition-route">晶圆定位时间</span>
        ${deviceTimeInput(value, `${stationName} Slot ${slotId} 对准时间`, {
          "device-timing-target": "station-map",
          "device-name": stationName,
          "timing-field": "AlignmentTime",
          "timing-key": slotId,
        })}
      </div>
    `),
    ...prePrepareRows.map((row, index) => `
      <div class="device-transition-row">
        <span class="device-transition-kind">${escapeHtml(row?.PrePrepareType || "状态切换")}</span>
        <strong>${escapeHtml(row?.LastItem || "—")} <i aria-hidden="true">→</i> ${escapeHtml(row?.CurrentItem || "—")}</strong>
        <span class="device-transition-route">${escapeHtml(row?.PrePrepareType === "PumpTime" ? "抽气" : row?.PrePrepareType === "VentTime" ? "充气" : "预处理")}</span>
        ${deviceTimeInput(timing.PrePrepareTime?.[index] ?? row?.Time ?? 0, `${stationName} ${row?.PrePrepareType || "状态切换"}`, {
          "device-timing-target": "station-sequence",
          "device-name": stationName,
          "timing-field": "PrePrepareTime",
          "timing-index": index,
        })}
      </div>
    `),
  ];
  const timingCount = actionControllers.reduce((count, controller) => count + STATION_ACTION_TIME_FIELDS.filter(
    ({ key }) => Object.prototype.hasOwnProperty.call(timing[key] || {}, controller),
  ).length, 0) + specialRows.length;

  container.innerHTML = `
    <div class="device-timing-overview">
      <div><span>站点类型</span><strong>${escapeHtml(station.Type || "Station")}</strong></div>
      <div><span>容量</span><strong>${Number(station.Capacity) || 0} <small>槽</small></strong></div>
      <div><span>关联机器手</span><strong>${actionControllers.length} <small>台</small></strong></div>
      <div><span>计时参数</span><strong>${timingCount} <small>项</small></strong></div>
    </div>
    <section class="device-time-section" aria-labelledby="stationActionTimingTitle">
      <header><div><h3 id="stationActionTimingTitle">取放片动作</h3><p>站点与对应机器手协同动作的分段耗时。</p></div><span>${actionControllers.length} 组控制关系</span></header>
      ${actionRows ? `<div class="device-time-table-wrap"><table class="device-time-table"><thead><tr><th>机器手</th>${STATION_ACTION_TIME_FIELDS.map(({ label }) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${actionRows}</tbody></table></div>` : `<div class="device-time-inline-empty">当前站点未声明取放片分段时间。</div>`}
    </section>
    <section class="device-time-section" aria-labelledby="stationTransitionTimingTitle">
      <header><div><h3 id="stationTransitionTimingTitle">专项处理与状态切换</h3><p>LoadLock 抽充气、Aligner 对准等站点专属时间。</p></div><span>${specialRows.length} 项</span></header>
      ${specialRows.length ? `<div class="device-transition-list">${specialRows.join("")}</div>` : `<div class="device-time-inline-empty">当前站点没有额外的状态切换时间。</div>`}
    </section>`;
}

/** 绘制当前机器手的取放片时间和按起点筛选的站点间移动时间。 */
function renderDeviceRobotTiming() {
  const container = document.getElementById("deviceRobotTimingEditor");
  const robotName = state.deviceRobotName;
  const robot = state.baseDevice?.Robots?.[robotName];
  const timing = state.deviceTimingDraft?.robots?.[robotName];
  if (!robot || !timing) {
    container.innerHTML = `<div class="device-config-empty"><strong>暂无可配置机器手</strong><span>当前设备没有声明机器手时间参数。</span></div>`;
    return;
  }

  const actionStations = [...new Set(ROBOT_ACTION_TIME_FIELDS.flatMap(
    ({ key }) => Object.keys(timing[key] || {}),
  ))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const actionRows = actionStations.map(stationName => `
    <tr><th scope="row"><strong>${escapeHtml(stationName)}</strong><small>目标站点</small></th>${ROBOT_ACTION_TIME_FIELDS.map(({ key, label }) => {
      if (!Object.prototype.hasOwnProperty.call(timing[key] || {}, stationName)) return `<td><span class="device-time-unavailable">—</span></td>`;
      return `<td>${deviceTimeInput(timing[key][stationName], `${robotName} 在 ${stationName} 的${label}时间`, {
        "device-timing-target": "robot-map",
        "device-name": robotName,
        "timing-field": key,
        "timing-key": stationName,
      })}</td>`;
    }).join("")}</tr>
  `).join("");

  const transferRows = Array.isArray(robot.PrepTransTime) ? robot.PrepTransTime : [];
  const sources = [...new Set(transferRows.map(row => String(row?.SrcStation || "")).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  let selectedSource = state.deviceRobotTransferSources[robotName];
  if (!sources.includes(selectedSource)) selectedSource = sources[0] || "";
  state.deviceRobotTransferSources[robotName] = selectedSource;
  const visibleTransfers = transferRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => String(row?.SrcStation || "") === selectedSource);
  const transferTableRows = visibleTransfers.map(({ row, index }) => `
    <tr>
      <th scope="row"><strong>${escapeHtml(row?.DestStation || "—")}</strong><small>${Number(row?.TransType) === 1 ? "载片移动" : "空载移动"}</small></th>
      <td><span class="device-transfer-type type-${Number(row?.TransType) === 1 ? "loaded" : "empty"}">${Number(row?.TransType) === 1 ? "载片" : "空载"}</span></td>
      <td>${deviceTimeInput(timing.PrepTransTime?.[index] ?? row?.Time ?? 0, `${robotName} 从 ${row?.SrcStation || "—"} 到 ${row?.DestStation || "—"} 的移动时间`, {
        "device-timing-target": "robot-sequence",
        "device-name": robotName,
        "timing-field": "PrepTransTime",
        "timing-index": index,
      })}</td>
    </tr>
  `).join("");
  const activeArms = Object.values(robot.ArmInfo || {}).filter(arm => arm?.IsEnable !== false).length;

  container.innerHTML = `
    <div class="device-timing-overview">
      <div><span>机器手类型</span><strong>${escapeHtml(robot.Type || "Robot")}</strong></div>
      <div><span>启用手臂</span><strong>${activeArms} <small>条</small></strong></div>
      <div><span>服务站点</span><strong>${actionStations.length} <small>个</small></strong></div>
      <div><span>移动规则</span><strong>${transferRows.length} <small>条</small></strong></div>
    </div>
    <section class="device-time-section robot-action-section" aria-labelledby="robotActionTimingTitle">
      <header><div><h3 id="robotActionTimingTitle">取片与放片</h3><p>同一机器手在不同站点可使用独立动作时间。</p></div><span>${actionStations.length} 个站点</span></header>
      ${actionRows ? `<div class="device-time-table-wrap"><table class="device-time-table compact"><thead><tr><th>站点</th>${ROBOT_ACTION_TIME_FIELDS.map(({ label }) => `<th>${label}时间</th>`).join("")}</tr></thead><tbody>${actionRows}</tbody></table></div>` : `<div class="device-time-inline-empty">当前机器手未声明取放片时间。</div>`}
    </section>
    <section class="device-time-section" aria-labelledby="robotTransferTimingTitle">
      <header class="device-transfer-head"><div><h3 id="robotTransferTimingTitle">站点间移动</h3><p>按起点查看移动规则，避免在大型设备中一次展示整张矩阵。</p></div><label><span>起点</span><select data-robot-transfer-source="${escapeHtml(robotName)}" ${sources.length ? "" : "disabled"}>${sources.length ? sources.map(source => `<option value="${escapeHtml(source)}" ${source === selectedSource ? "selected" : ""}>${escapeHtml(source)}</option>`).join("") : `<option>无移动规则</option>`}</select></label></header>
      ${transferTableRows ? `<div class="device-time-table-wrap"><table class="device-time-table transfer"><thead><tr><th>目标站点</th><th>搬运类型</th><th>移动时间</th></tr></thead><tbody>${transferTableRows}</tbody></table></div>` : `<div class="device-time-inline-empty">当前起点没有可配置的移动时间。</div>`}
    </section>`;
}

/** 刷新设备配置分类、表单与保存状态；仅显示当前分类以控制高密度表格的认知负担。 */
function renderDeviceTimingConfiguration() {
  renderDeviceConfigHeader();
  renderDeviceTimingSelectors();
  document.querySelectorAll("[data-device-config-section]").forEach(button => {
    const active = button.dataset.deviceConfigSection === state.deviceConfigSection;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-device-config-view]").forEach(view => {
    const active = view.dataset.deviceConfigView === state.deviceConfigSection;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  if (state.deviceConfigSection === "station-time") renderDeviceStationTiming();
  if (state.deviceConfigSection === "robot-time") renderDeviceRobotTiming();
  if (state.deviceConfigSection === "robot-slot") renderRobotSlots();
}

/** 从当前设备重新建立时间草稿，既用于设备切换，也用于撤销尚未保存的修改。 */
function resetDeviceTimingDraft(message = "当前设备时间参数已加载") {
  state.deviceTimingDraft = state.baseDevice ? buildDeviceTimingDraft(state.baseDevice) : null;
  state.deviceTimingDirty = false;
  state.deviceTimingSaving = false;
  state.deviceTimingStatusMessage = state.baseDevice ? message : "选择设备后开始配置";
  renderDeviceTimingConfiguration();
}

/** 标记设备时间草稿已改变，并立即更新页头保存反馈。 */
function markDeviceTimingDirty() {
  if (!state.deviceTimingDraft || !state.workspaceDeviceId) return;
  state.deviceTimingDirty = true;
  state.deviceTimingStatusMessage = "有尚未保存的时间修改";
  renderDeviceConfigHeader();
}

/** 把一个时间输入写回草稿；负数或非数字保留为无效状态并阻止后续保存。 */
function updateDeviceTimingFromControl(control) {
  const value = Number(control.value);
  const valid = control.value.trim() !== "" && Number.isFinite(value) && value >= 0;
  control.setCustomValidity(valid ? "" : "请输入大于或等于 0 的有限秒数");
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

/** 校验草稿中的每个秒数，确保保存请求不会包含 NaN、Infinity 或负数。 */
function validateDeviceTimingDraft() {
  let invalidLabel = "";
  Object.entries(state.deviceTimingDraft || {}).some(([sectionName, items]) => Object.entries(items).some(([itemName, fields]) => Object.entries(fields).some(([fieldName, values]) => {
    const rows = Array.isArray(values) ? values.map((value, index) => [index, value]) : Object.entries(values || {});
    const invalid = rows.find(([, value]) => !Number.isFinite(Number(value)) || Number(value) < 0);
    if (!invalid) return false;
    invalidLabel = `${sectionName}.${itemName}.${fieldName}.${invalid[0]}`;
    return true;
  })));
  if (invalidLabel) throw new Error(`${invalidLabel} 必须是大于或等于 0 的有限秒数`);
}

/** 保存当前设备的全部时间草稿，并用服务端返回的拓扑刷新排程与可视化数据。 */
async function saveDeviceTiming() {
  if (!state.deviceTimingDirty || state.deviceTimingSaving || !state.workspaceDeviceId) return;
  validateDeviceTimingDraft();
  state.deviceTimingSaving = true;
  renderDeviceConfigHeader();
  try {
    const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/device-timing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timing: state.deviceTimingDraft }),
    });
    state.workspaceDevice.device = structuredClone(result.device);
    applyDeviceTopology(result.device, state.deviceName, state.robotSlots);
    resetRunResult();
    resetDeviceTimingDraft("时间参数已保存并应用到全部测试");
    setWorkspaceStatus("设备时间参数已保存", "saved");
  } catch (error) {
    state.deviceTimingSaving = false;
    state.deviceTimingStatusMessage = `保存失败：${error.message}`;
    renderDeviceConfigHeader();
    throw error;
  }
}

/** 切换设备配置分类，保留未保存草稿并只重绘目标编辑器。 */
function switchDeviceConfigSection(sectionName) {
  if (!document.querySelector(`[data-device-config-view="${sectionName}"]`)) return;
  state.deviceConfigSection = sectionName;
  renderDeviceTimingConfiguration();
}

/** 在 Station—Robot 可达图中寻找 LoadPort 到 PM 的最短路径。 */
function shortestDevicePath(source, destination) {
  const queue = [[`S:${source}`]], visited = new Set(queue[0]);
  while (queue.length) {
    const path = queue.shift(), node = path.at(-1);
    if (node === `S:${destination}`) return path.map(item => item.slice(2));
    const [kind, name] = node.split(":");
    const neighbours = kind === "S" ? state.robotNames.filter(robot => (state.robotScopes[robot] || []).includes(name)).map(robot => `R:${robot}`) : (state.robotScopes[name] || []).map(station => `S:${station}`);
    neighbours.forEach(next => { if (!visited.has(next)) { visited.add(next); queue.push([...path, next]); } });
  }
  return [];
}

/** 用设备可达关系生成完整的往返 Route。 */
function defaultRouteStages(routeName) {
  const port = state.loadPorts[0] || "", modules = state.processModules.slice(0, 2), outward = shortestDevicePath(port, modules[0]);
  if (outward.length < 3) return linkRouteSteps([makeStage(port), makeStage(state.robotNames[0] || ""), makeStage(modules, true, `${routeName}_Step2`), makeStage(state.robotNames[0] || ""), makeStage(port)]);
  outward[outward.length - 1] = modules;
  const full = [...outward, ...outward.slice(0, -1).reverse()];
  return linkRouteSteps(full.map((name, index) => makeStage(name, index === outward.length - 1, index === outward.length - 1 ? `${routeName}_Step${index}` : "")));
}

/** 为当前设备创建一套可直接编辑的默认测试集；Route/Clean 归设备共享。 */
function makeDefaultTestCase(name = "默认测试集") {
  if (!state.routes.length) {
    const routeName = "RouteA";
    state.routes.push({ name: routeName, group: routeName, bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: defaultRouteStages(routeName) });
  }
  const routeName = state.routes[0]?.name || "";
  return {
    name, group: state.activeTestGroup || "", strategy: "heuristic", roundCount: 2, times: [0, 70],
    options: { ...DEFAULT_SCHEDULE_OPTIONS },
    cleans: [], routes: state.routes.map(routeTemplateForSave),
    routeConfigs: normalizeTestRouteConfigs({}, state.routes),
    rounds: [
      makeRound(1, 0, routeName, state.loadPorts[0] || ""),
      makeRound(2, 70, routeName, state.loadPorts[1] || state.loadPorts[0] || "")
    ]
  };
}

/** 显示小型输入或确认弹窗，并在打开时把焦点交给可操作控件。 */
function showWorkspaceDialog({ title, message, value = "", needsInput = false, dangerous = false }) {
  const dialog = document.getElementById("workspaceDialog"), input = document.getElementById("workspaceDialogInput"), confirm = document.getElementById("workspaceDialogConfirm");
  document.getElementById("workspaceDialogTitle").textContent = title;
  document.getElementById("workspaceDialogMessage").textContent = message;
  input.hidden = !needsInput; input.required = needsInput; input.value = value;
  confirm.textContent = dangerous ? "确认删除" : "确认";
  confirm.classList.toggle("danger", dangerous); confirm.classList.toggle("primary", !dangerous);
  dialog.showModal();
  window.setTimeout(() => (needsInput ? input : confirm).focus(), 0);
  return new Promise(resolve => dialog.addEventListener("close", () => {
    resolve(dialog.returnValue === "confirm" ? (needsInput ? input.value.trim() : true) : null);
  }, { once: true }));
}

const compactSelectMenus = new WeakMap();

/** 返回关联菜单，即使菜单为了避免裁剪而临时挂载在页面根节点。 */
function compactSelectMenu(wrapper) {
  return compactSelectMenus.get(wrapper) || wrapper.querySelector(".compact-select-menu");
}

/** 关闭单个下拉菜单，并将浮层归还到原控件，避免留下孤立菜单。 */
function closeCompactSelect(wrapper) {
  const trigger = wrapper.querySelector(".compact-select-trigger");
  const menu = compactSelectMenu(wrapper);
  wrapper.classList.remove("is-open");
  trigger.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  menu.removeAttribute("style");
  if (menu.parentElement !== wrapper) wrapper.append(menu);
}

/** 关闭除指定控件外的紧凑下拉菜单。 */
function closeCompactSelects(exceptSelect = null) {
  document.querySelectorAll(".compact-select.is-open").forEach(wrapper => {
    if (wrapper.querySelector("select") !== exceptSelect) closeCompactSelect(wrapper);
  });
}

/** 返回首页和重算任务中需要使用统一样式的单选下拉框。 */
function compactSelectTargets() {
  return document.querySelectorAll("select[data-compact-label], #roundList select:not([multiple])");
}

/** 读取原生下拉框在视觉控件和无障碍标签中使用的名称。 */
function compactSelectLabel(select) {
  return select.dataset.compactLabel
    || select.getAttribute("aria-label")
    || select.closest(".field")?.querySelector("label")?.textContent?.trim()
    || "请选择";
}

/** 根据原生 select 的当前选项同步紧凑下拉框的按钮与菜单内容。 */
function refreshCompactSelect(select) {
  const wrapper = select.parentElement;
  if (!wrapper?.classList.contains("compact-select")) return;
  const trigger = wrapper.querySelector(".compact-select-trigger");
  const menu = compactSelectMenu(wrapper);
  const selectedOption = select.selectedOptions[0] || select.options[0];
  trigger.disabled = select.disabled;
  trigger.setAttribute("aria-label", `${compactSelectLabel(select)}：${selectedOption?.textContent?.trim() || "未选择"}`);
  trigger.querySelector(".compact-select-value").textContent = selectedOption?.textContent?.trim() || "未选择";
  menu.innerHTML = Array.from(select.options).map((option, index) => `<button class="compact-select-option" type="button" role="option" data-option-index="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}>${escapeHtml(option.textContent?.trim() || "未命名选项")}</button>`).join("");
}

/** 为首页主选择器建立带标签、选中状态和键盘焦点的浅色下拉交互。 */
function initializeCompactSelects() {
  compactSelectTargets().forEach(select => {
    if (select.parentElement?.classList.contains("compact-select")) return;
    const wrapper = document.createElement("div");
    const trigger = document.createElement("button");
    const menu = document.createElement("div");
    wrapper.className = "compact-select";
    trigger.className = "compact-select-trigger";
    trigger.type = "button";
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = `<span class="compact-select-label">${escapeHtml(compactSelectLabel(select))}</span><span class="compact-select-value"></span><i class="compact-select-chevron" aria-hidden="true"></i>`;
    menu.className = "compact-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", compactSelectLabel(select));
    menu.hidden = true;
    select.before(wrapper);
    wrapper.append(select, trigger, menu);
    compactSelectMenus.set(wrapper, menu);
    const setOpen = open => {
      if (!open) {
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
    trigger.addEventListener("keydown", event => {
      if (event.key === "Escape") setOpen(false);
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
    });
    menu.addEventListener("click", event => {
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
    document.addEventListener("click", event => {
      if (!event.target.closest(".compact-select, .compact-select-menu")) closeCompactSelects();
    });
  }
}

/** 显示设备名时去掉常见的 .json 后缀，空值回退为“未命名设备”。 */
function displayDeviceName(name) {
  return String(name || "未命名设备").replace(/\.json$/i, "");
}

/** 更新设备、测试集下拉框和保存状态相关按钮。 */
function renderWorkspaceControls() {
  const deviceSelect = document.getElementById("deviceSelect"), tests = state.workspaceDevice?.tests || [];
  deviceSelect.innerHTML = state.workspaceDevices.length ? state.workspaceDevices.map(device => `<option value="${escapeHtml(device.id)}" ${device.id === state.workspaceDeviceId ? "selected" : ""}>${escapeHtml(displayDeviceName(device.name))}</option>`).join("") : `<option value="">尚未导入设备</option>`;
  const natural = (left, right) => left.localeCompare(right, undefined, { numeric: true });
  const groups = [...new Set(["", ...(state.workspaceDevice?.testGroups || []), ...tests.map(test => String(test.group || "").trim())])].sort((left, right) => (!left) - (!right) || natural(left, right));
  const selectedGroup = groups.includes(state.activeTestGroup) ? state.activeTestGroup : (groups[0] || "");
  const groupSelect = document.getElementById("testGroupSelect");
  groupSelect.innerHTML = groups.length ? groups.map(group => `<option value="${escapeHtml(group)}" title="${escapeHtml(group || "未分组")}" ${group === selectedGroup ? "selected" : ""}>${escapeHtml(group || "未分组")}</option>`).join("") : `<option value="">未分组</option>`;
  groupSelect.title = selectedGroup || "未分组";
  groupSelect.disabled = !state.workspaceDeviceId;
  const testSelect = document.getElementById("testCaseSelect");
  const visibleTests = tests.filter(test => String(test.group || "").trim() === selectedGroup).sort((left, right) => natural(left.name, right.name));
  testSelect.innerHTML = visibleTests.length ? visibleTests.map(test => `<option value="${escapeHtml(test.id)}" title="${escapeHtml(test.name)}" ${test.id === state.testCaseId ? "selected" : ""}>${escapeHtml(test.name)}</option>`).join("") : `<option value="">该组暂无测试</option>`;
  testSelect.title = visibleTests.find(test => test.id === state.testCaseId)?.name || "该组暂无测试";
  testSelect.disabled = !visibleTests.length;
  const hasTest = Boolean(state.testCaseId);
  const nameInput = document.getElementById("testCaseName"); nameInput.disabled = !hasTest; nameInput.value = state.testCaseName || ""; nameInput.title = state.testCaseName || "";
  document.getElementById("newTestButton").disabled = !state.workspaceDeviceId;
  document.getElementById("newGroupButton").disabled = !state.workspaceDeviceId;
  document.getElementById("deleteDeviceButton").disabled = !state.workspaceDeviceId;
  const isDefaultGroup = !selectedGroup;
  const hasGroupTests = tests.some(test => String(test.group || "").trim() === selectedGroup);
  document.getElementById("renameGroupButton").disabled = !state.workspaceDeviceId || isDefaultGroup;
  document.getElementById("deleteGroupButton").disabled = !state.workspaceDeviceId || (isDefaultGroup && !hasGroupTests);
  document.getElementById("deleteGroupButton").title = isDefaultGroup ? "删除“未分组”中的全部测试" : "删除当前测试组别";
  document.getElementById("groupActionHint").textContent = isDefaultGroup && state.workspaceDeviceId ? "“未分组”不可重命名；有测试时可以删除其中全部测试。" : "";
  document.getElementById("copyTestButton").disabled = !hasTest;
  document.getElementById("saveTestButton").disabled = !hasTest;
  document.getElementById("deleteTestButton").disabled = tests.length <= 1;
  const batchDisabled = (state.batchRunning && state.batchCancelRequested) || singleRunActive || !state.serviceCompatible || !visibleTests.length;
  document.getElementById("batchRunButton").disabled = batchDisabled;
  document.getElementById("openParameterComparisonDialogButton").disabled = state.batchRunning || !state.serviceCompatible || !state.parameterComparison?.baseline;
  const emptyHint = document.getElementById("emptyGroupHint");
  emptyHint.classList.toggle("visible", Boolean(state.workspaceDeviceId) && !visibleTests.length);
  document.getElementById("emptyGroupNewTestButton").disabled = !state.workspaceDeviceId;
  const deviceType = {
    single: "单腔非级联",
    dual: "双腔非级联",
    cascade: "级联",
  }[detectDeviceTopologyLayout(state.device)];
  document.getElementById("deviceSummary").innerHTML = state.device ? `<span class="chip good">${escapeHtml(deviceType)}</span>` : `<span class="chip">尚未选择设备</span>`;
  compactSelectTargets().forEach(refreshCompactSelect);
}

/** 显示当前测试集是否已经持久化。 */
function setWorkspaceStatus(message, kind = "") {
  const status = document.getElementById("workspaceStatus"); status.textContent = message; status.className = `workspace-status ${kind}`.trim();
}

/** 延迟自动保存，确保设备共享 Route/Clean 和测试任务均能恢复。 */
let autoSaveTimer = null;
function scheduleAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(() => {
    if (state.dirty) saveCurrentTest(true).catch(error => setWorkspaceStatus(`自动保存失败：${error.message}`, "dirty"));
  }, 600);
}

/** 标记当前测试集有尚未保存的编辑。 */
function markTestDirty() {
  if (!state.testCaseId) return;
  state.dirty = true; setWorkspaceStatus(`“${state.testCaseName}”有未保存修改`, "dirty");
  scheduleAutoSave();
}

/** 标记路径模板有尚未保存的编辑；路径模板只在用户点击保存后写回设备共享库。 */
function markRoutesDirty() {
  state.routeDirty = true;
  setWorkspaceStatus("当前路径模板有未保存修改，请在模板旁点击“保存”", "dirty");
}

/** 清理上一测试集的运行指标和结果链接，避免把旧结果误认为当前结果。 */
function resetRunResult() {
  visualizationWorkspace.clear();
  state.batchResult = null; state.selectedBatchTestId = "";
  batchPerformanceAnalyses.clear();
  batchBottleneckSummaries.clear();
  batchBottleneckRequests.clear();
  batchBottleneckErrors.clear();
  ["metricTime", "metricMakespan", "metricMoves", "metricValidation"].forEach(id => { document.getElementById(id).textContent = "—"; });
  ["metricTimeDetail", "metricMakespanDetail", "metricMovesDetail", "metricValidationDetail"].forEach(id => { document.getElementById(id).textContent = ""; });
  document.getElementById("metricContext").textContent = "运行总览";
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
    const link = document.getElementById(id); link.href = "#"; link.setAttribute("aria-disabled", "true");
  }
  resetSearchTelemetryView();
  writeTerminal("$ 测试集已就绪，等待运行…");
}

/** 清空搜索轮询和历史视图，避免切换测试后误看上一结果。 */
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
    "searchTelemetryContinuousDecisionButton",
  ]) {
    const button = document.getElementById(id);
    button.disabled = true;
    button.classList.remove("is-active");
  }
}

/** 把搜索数值格式化为稳定的有限小数。 */
function formatSearchTelemetryNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

/** 返回有限搜索终止原因的中文说明。 */
function searchTelemetryStopReason(reason) {
  return {
    time_budget: "时间预算",
    simulation_budget: "模拟次数预算",
    node_budget: "节点预算",
  }[String(reason || "")] || "搜索中";
}

/** 把一次 Alpha 决策的稳定动作链渲染成三张可展开候选卡片。 */
function renderSearchActionChains(
  chains,
  decisionIndex,
  recommendedKey,
  selectedKey,
  maximumVisits,
  interactive,
) {
  return `<section class="decision-candidate-section search-action-section" aria-labelledby="searchCandidatesTitle">
    <header>
      <strong id="searchCandidatesTitle">决策 #${decisionIndex}</strong>
      <span>${chains.length} 条可选稳定动作链</span>
    </header>
    <ol>
      ${chains.map((chain, index) => {
        const visits = Number(chain?.visits) || 0;
        const visitPercent = Math.max(0, Math.min(100, visits / maximumVisits * 100));
        const isRecommended = String(chain?.actionKey || "") === recommendedKey;
        const isSelected = String(chain?.actionKey || "") === selectedKey;
        const tags = `${isRecommended ? '<span class="decision-tag is-recommendation">推荐</span>' : ""}${isSelected && !isRecommended ? '<span class="decision-tag is-user-chosen">你的选择</span>' : ""}`;
        const description = String(chain?.description || "稳定动作链");
        const steps = Array.isArray(chain?.steps) ? chain.steps : [];
        return `<li class="decision-candidate search-action-candidate search-action-chain ${isSelected ? "is-selected" : ""} ${interactive ? "is-interactive" : ""}" data-action-key="${escapeHtml(String(chain?.actionKey || ""))}" ${interactive ? `role="button" tabindex="0" aria-label="执行 ${escapeHtml(description)}"` : ""}>
          <div class="decision-candidate-rank" aria-label="第 ${index + 1} 名">${index + 1}</div>
          <div class="decision-candidate-main">
            <div class="decision-candidate-title"><strong title="${escapeHtml(description)}">${escapeHtml(description)}</strong>${tags}</div>
            <div class="decision-candidate-detail search-pnq" aria-label="搜索评估指标">
              <span title="策略先验 P"><small>P 先验</small><strong>${formatSearchTelemetryNumber(chain?.prior, 4)}</strong></span>
              <span title="访问次数 N"><small>N 访问</small><strong>${visits}</strong></span>
              <span title="平均价值 Q"><small>Q 价值</small><strong>${formatSearchTelemetryNumber(chain?.value, 4)}</strong></span>
            </div>
            <ol class="search-chain-steps" aria-label="动作链步骤">
              ${steps.map((step, stepIndex) => `<li><b>${stepIndex + 1}</b><span title="${escapeHtml(step?.description || "动作")}">${escapeHtml(step?.description || "动作")}</span><small>${Number(step?.primitiveCount) || 1} 步</small></li>`).join("")}
            </ol>
          </div>
          <div class="decision-candidate-preference" aria-label="推荐比例 ${visitPercent.toFixed(0)}%"><small>推荐比例</small><strong>${visitPercent.toFixed(0)}%</strong></div>
        </li>`;
      }).join("")}
    </ol>
  </section>`;
}

/** 绘制某一次决策的三条可提交稳定动作链。 */
function renderSearchTelemetryDecision(snapshot) {
  const chains = Array.isArray(snapshot?.actionChains) ? snapshot.actionChains.slice(0, 3) : [];
  const recommendedKey = String(snapshot?.selectedActionKey || "");
  // 用户选择只作用于其提交时的那个根决策；跨决策或回看其他历史时沿用模型推荐。
  const selectedKey = String(snapshot?.searchId || "") === userChosenSearchId
    ? userChosenActionKey
    : recommendedKey;
  const decisionIndex = Number(snapshot?.decisionIndex || 0) + 1;
  const interactive = playbackMode === "step"
    && latestSearchTelemetry?.status === "waiting-choice"
    && String(snapshot?.searchId || "") === String(latestSearchTelemetry?.searchId || "");
  const maximumVisits = Math.max(1, ...chains.map(chain => Number(chain?.visits) || 0));
  document.getElementById("visualDecisionLens").innerHTML = chains.length
    ? renderSearchActionChains(
      chains,
      decisionIndex,
      recommendedKey,
      selectedKey,
      maximumVisits,
      interactive,
    )
    : `<div class="decision-empty"><strong>正在构造稳定动作链…</strong><p>只有在 50 层内回到 Robot 全部空手状态的链才会出现。</p></div>`;

  const variationPanel = document.getElementById("searchTelemetryVariationPanel");
  variationPanel.hidden = true;
  document.getElementById("searchTelemetryVariation").innerHTML = "";
}

/** 按回放/步进模式同步搜索控制按钮的可见与可用状态。 */
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
  // 回放模式显示暂停/单步/连续；步进模式显示单次执行和持续决策。
  pauseButton.hidden = stepMode;
  stepButton.hidden = stepMode;
  continueButton.hidden = stepMode;
  followButton.hidden = !stepMode;
  continuousButton.hidden = !stepMode;
  pauseButton.disabled = disabled;
  stepButton.disabled = disabled;
  continueButton.disabled = disabled;
  const canFollowRecommendation = (
    !disabled
    && stepMode
    && executionMode === "paused"
    && snapshot?.status === "waiting-choice"
    && Boolean(snapshot?.selectedActionKey)
  );
  // 持续决策开启后保留停止入口；关闭时只在当前推荐动作可提交时允许启动。
  followButton.disabled = !canFollowRecommendation || continuousActive;
  continuousButton.disabled = !stepMode || !searchTelemetryRunActive || (!continuousActive && !canFollowRecommendation);
  continuousButton.textContent = continuousActive ? "停止持续决策" : "持续决策";
  continuousButton.title = continuousActive
    ? "完成当前在途选择后停止，不再自动执行下一轮推荐"
    : "持续执行每一轮搜索的模型推荐动作";
  continuousButton.setAttribute("aria-pressed", String(continuousActive));
  continuousButton.classList.toggle("is-active", continuousActive);
  pauseButton.classList.toggle("is-active", !disabled && !stepMode && executionMode === "paused");
  continueButton.classList.toggle("is-active", !disabled && !stepMode && executionMode === "continuous");
}

/** 用已提交 MoveList 和所选根决策时刻同步拓扑画布。 */
function syncSearchTelemetryPlayback(snapshot, selectedDecision) {
  const committedMoves = Array.isArray(snapshot?.committedMoves)
    ? snapshot.committedMoves
    : [];
  const movesChanged = Boolean(
    committedMoves.length
    && committedMoves.length !== lastSearchTelemetryMoveCount
  );
  const animateLatestStep = (
    movesChanged
    && playbackMode === "step"
    && followLatestSearchTelemetry
  );
  if (movesChanged) {
    visualizationWorkspace.updateLiveMoves(
      committedMoves,
      followLatestSearchTelemetry,
      animateLatestStep,
    );
    lastSearchTelemetryMoveCount = committedMoves.length;
  }
  const replayTime = Number(selectedDecision?.replayTime);
  if (!animateLatestStep && Number.isFinite(replayTime) && replayTime >= 0) {
    visualizationWorkspace.seekTo(replayTime);
  }
}

/** 步进模式下用户点选某个根动作并提交。 */
async function chooseSearchAction(actionKey, automatic = false) {
  if (!searchTelemetryRunActive || playbackMode !== "step") return;
  if (searchTelemetryControlPending) return;
  // 只在后端确实等待用户选择时提交，避免搜索中的误点被静默预选。
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
    status.textContent = automatic
      ? `持续决策已停止：${error.message || "提交推荐失败"}`
      : `提交选择失败：${error.message || "未知错误"}`;
    status.classList.remove("is-searching", "is-paused");
  } finally {
    searchTelemetryControlPending = false;
    flushPendingModeSync();
    updateSearchTelemetryControls(latestSearchTelemetry);
    maybeContinueModelDecision(latestSearchTelemetry);
  }
}

/** 步进模式下直接提交模型推荐动作。 */
function followSearchRecommendation() {
  const key = String(latestSearchTelemetry?.selectedActionKey || "");
  if (!key) return;
  void chooseSearchAction(key);
}

/** 在控制请求结束后补发被跳过的模式切换命令，保持前后端执行模式一致。 */
async function flushPendingModeSync() {
  const mode = pendingModeSync;
  if (!mode) return;
  pendingModeSync = "";
  await setPlaybackMode(mode);
}

/** 切换回放/步进模式；运行中会同步后端执行模式。 */
/** 同步回放/步进模式切换按钮的选中状态（不向后端发命令）。 */
function renderPlaybackModeSwitch() {
  const stepMode = playbackMode === "step";
  document.getElementById("playbackModeReplayButton").classList.toggle("is-active", playbackMode === "replay");
  document.getElementById("playbackModeStepButton").classList.toggle("is-active", stepMode);
  document.getElementById("playbackModeReplayButton").setAttribute("aria-pressed", String(playbackMode === "replay"));
  document.getElementById("playbackModeStepButton").setAttribute("aria-pressed", String(stepMode));
  document.getElementById("visualRecommendationModelControl").hidden = stepMode;
  document.getElementById("visualPauseOnDecisionChangeButton").hidden = stepMode;
}

/** 当持续决策开启时，为当前根决策恰好提交一次模型推荐动作。 */
function maybeContinueModelDecision(snapshot) {
  if (!continuousDecisionEnabled || !searchTelemetryRunActive || playbackMode !== "step") return;
  if (searchTelemetryControlPending || snapshot?.status !== "waiting-choice") return;
  const searchId = String(snapshot?.searchId || "");
  const actionKey = String(snapshot?.selectedActionKey || "");
  if (!searchId || !actionKey || searchId === continuousDecisionSubmittedSearchId) return;
  continuousDecisionSubmittedSearchId = searchId;
  void chooseSearchAction(actionKey, true);
}

/** 开启或停止持续决策；停止不会撤销已经提交的当前动作。 */
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
      status.textContent = `切换模式失败：${error.message || "未知错误"}`;
      status.classList.remove("is-searching", "is-paused");
    }
  } else if (searchTelemetryRunActive) {
    // 控制请求在途：记下待补发的模式，请求结束后由 flushPendingModeSync 补发。
    pendingModeSync = mode;
  }
  if (latestSearchTelemetry) renderSearchTelemetry(latestSearchTelemetry);
}

/** 向服务端发送根决策暂停、单步或连续求解命令。 */
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
    status.textContent = `求解控制失败：${error.message || "未知错误"}`;
    status.classList.remove("is-searching", "is-paused");
  } finally {
    searchTelemetryControlPending = false;
    flushPendingModeSync();
    updateSearchTelemetryControls(latestSearchTelemetry);
  }
}

/** 合并实时帧与已完成历史，并保持用户手动选择的旧决策。 */
function renderSearchTelemetry(snapshot) {
  if (!snapshot || snapshot.unchanged) return;
  if (snapshot.algorithm !== "schedule-alphago" && latestSearchTelemetry) return;
  latestSearchTelemetry = snapshot;
  const panel = document.getElementById("searchTelemetryPanel");
  panel.hidden = false;
  const status = document.getElementById("searchTelemetryStatus");
  if (snapshot.algorithm !== "schedule-alphago") {
    status.textContent = "正在初始化搜索器…";
    status.classList.add("is-searching");
    status.classList.remove("is-paused");
    updateSearchTelemetryControls(snapshot);
    return;
  }
  const decisions = Array.isArray(snapshot.history) ? [...snapshot.history] : [];
  if (snapshot.searchId && decisions.at(-1)?.searchId !== snapshot.searchId) decisions.push(snapshot);
  const latestDecision = decisions.at(-1) || snapshot;
  if (followLatestSearchTelemetry || !decisions.some(item => item.searchId === selectedSearchTelemetryId)) {
    selectedSearchTelemetryId = String(latestDecision.searchId || "");
  }
  const selector = document.getElementById("searchTelemetryDecisionSelect");
  selector.innerHTML = decisions.map(item => {
    const suffix = item.status === "searching" ? "搜索中" : `${Number(item.simulations) || 0} 次`;
    return `<option value="${escapeHtml(item.searchId || "")}">#${Number(item.decisionIndex || 0) + 1} · ${suffix}</option>`;
  }).join("");
  selector.value = selectedSearchTelemetryId;
  const selected = decisions.find(item => item.searchId === selectedSearchTelemetryId) || latestDecision;
  const searching = snapshot?.status === "searching";
  const waiting = snapshot?.status === "waiting-step";
  const waitingChoice = snapshot?.status === "waiting-choice";
  const cancelled = snapshot?.status === "cancelled";
  status.textContent = cancelled
    ? "运行已取消"
    : waitingChoice
      ? playbackMode === "step"
        ? continuousDecisionEnabled
          ? "持续决策中 · 正在执行模型推荐"
          : "搜索完成 · 请选择要执行的动作"
        : "求解已暂停 · 等待放行"
      : waiting
        ? "求解已暂停 · 可单步放行一个根决策，或继续连续求解"
        : searching
          ? `${continuousDecisionEnabled && playbackMode === "step" ? "持续决策中 · " : ""}正在进行非对称树搜索 · ${Number(snapshot?.simulations) || 0} 次模拟`
          : snapshot?.status === "action-applied"
            ? `根动作 #${Number(snapshot?.decisionIndex || 0) + 1} 已提交 · 拓扑已推进`
            : `决策完成 · 由${searchTelemetryStopReason(selected?.stopReason)}终止`;
  status.classList.toggle("is-searching", searching);
  status.classList.toggle("is-paused", waiting || waitingChoice);
  updateSearchTelemetryControls(snapshot);
  renderSearchTelemetryDecision(selected);
  syncSearchTelemetryPlayback(snapshot, selected);
  maybeContinueModelDecision(snapshot);
}

/** 在独立 HTTP 线程上轮询搜索快照，不阻塞同步调度请求。 */
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
        status.textContent = `遥测暂不可用：${error.message || "未知错误"}`;
        status.classList.remove("is-searching");
      }
    }
    await new Promise(resolve => window.setTimeout(resolve, SEARCH_TELEMETRY_POLL_MILLISECONDS));
  }
}

/** 开始本次 Schedule-AlphaGo 运行的实时搜索轮询。 */
function startSearchTelemetryPolling() {
  resetSearchTelemetryView();
  searchTelemetryRunActive = true;
  // 搜索面板接管右侧“合法动作空间”渲染，避免回放帧覆盖候选列表。
  visualizationWorkspace.setExternalDecisionLensOwner(true);
  const panel = document.getElementById("searchTelemetryPanel");
  panel.hidden = false;
  const status = document.getElementById("searchTelemetryStatus");
  status.textContent = "正在初始化搜索器…";
  status.classList.add("is-searching");
  updateSearchTelemetryControls({ executionMode: playbackMode === "step" ? "paused" : "continuous" });
  const token = ++searchTelemetryPollToken;
  void pollSearchTelemetry(token);
}

/** 停止轮询，并用服务端随结果返回的完整历史覆盖最后一帧。 */
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

/** 将持久化测试集载入页面编辑状态。 */
function applyTestCase(testCase) {
  const value = structuredClone(testCase);
  state.routeNameChanges.clear();
  state.testCaseId = value.id; state.testCaseName = value.name; state.testCaseGroup = String(value.group || ""); state.activeTestGroup = state.testCaseGroup;
  const requestedStrategy = String(value.strategy || "heuristic");
  state.strategy = requestedStrategy.trim() || "heuristic";
  state.roundCount = Math.max(1, Number(value.roundCount) || 1); state.times = Array.isArray(value.times) ? value.times : [0];
  const persistedOptions = value.options && typeof value.options === "object" ? value.options : {};
  state.options = {
    ...DEFAULT_SCHEDULE_OPTIONS,
    ...Object.fromEntries(
      Object.entries(persistedOptions).filter(([key]) => SCHEDULE_OPTION_KEYS.has(key))
    ),
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
  // 首次载入以测试集配置建立会话基线；之后切换测试时沿用用户最近主动确认的运行配置。
  if (sessionSchedulingConfiguration) {
    state.strategy = sessionSchedulingConfiguration.strategy;
    state.options = structuredClone(sessionSchedulingConfiguration.options);
  } else {
    retainSessionSchedulingConfiguration();
  }
  // v2：Route/Clean 来自设备共享库；仅在加载尚未迁移的旧数据时使用测试集副本兜底。
  if (!state.routes.length && Array.isArray(value.routes)) state.routes = value.routes;
  state.cleans = Array.isArray(value.cleans)
    ? value.cleans.map(normalizeClean)
    : (state.workspaceDevice?.cleans || []).map(normalizeClean);
  state.routes.forEach(route => normalizeRoute(route));
  captureRouteGroupingProfiles();
  state.expandedRouteProcessGroups.clear(); state.expandedRouteGroups.clear(); state.expandedRoutes.clear();
  state.routeProcessFilter = ""; state.routeParallelFilter = "";
  state.rounds = Array.isArray(value.rounds) ? value.rounds : [];
  state.testRouteConfigs = normalizeTestRouteConfigs(value.routeConfigs, state.routes);
  while (state.times.length < state.roundCount) state.times.push((Number(state.times.at(-1)) || 0) + 70);
  while (state.rounds.length < state.roundCount) {
    const index = state.rounds.length;
    state.rounds.push(makeRound(index + 1, state.times[index], state.routes[0]?.name || "", state.loadPorts[index] || state.loadPorts[0] || ""));
  }
  state.times.length = state.roundCount; state.rounds.length = state.roundCount; state.times[0] = 0;
  normalizeRounds(); state.drawer = null; state.routeDirty = false; state.routeNameChanges.clear();
  state.routeEditingIndex = -1; state.routeEditSnapshot = null; state.routeEditGroupingProfile = null; state.routeEditIsNew = false;
  visualizationWorkspace.setAnalysisConfiguration(runtimeRoutes(), state.rounds);
  visualizationWorkspace.setReplayPlan(buildPayload());
  state.dirty = false;
  document.getElementById("roundCount").value = state.roundCount;
  document.querySelectorAll('input[name="strategy"]').forEach(input => { input.checked = input.value === state.strategy; });
  document.querySelectorAll("[data-option]").forEach(input => { input.value = state.options[input.dataset.option] ?? input.value; });
  updateStrategyOptionVisibility();
  document.getElementById("roundCount").disabled = false;
  if (Object.keys(state.algorithmMetadata).length) showAlgorithmDetails(state.strategy);
  renderAll(); renderWorkspaceControls(); resetRunResult();
  setWorkspaceStatus(`已载入“${state.testCaseName}”`, "saved");
}

/** 整理测试保存请求；路径模板不随测试保存，只在“保存路径”时写回设备共享库。 */
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
    rounds: state.rounds,
  });
}

/** 整理路径模板保存请求，并同步自动改名链。 */
function routeTemplateSnapshot() {
  synchronizeRouteNames();
  return structuredClone({
    routes: state.routes.map(routeTemplateForSave),
    routeNameChanges: Object.fromEntries(state.routeNameChanges),
  });
}

/** 保存路径模板到设备共享库；保存成功后按最新结构重新生成路径分组。 */
async function saveRoutes() {
  if (!state.workspaceDeviceId) throw new Error("请先选择设备");
  if (state.batchRunning) throw new Error("批量任务运行中，请等待完成或取消后再保存路径");
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/routes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routeTemplateSnapshot()),
    });
  } catch (error) {
    setWorkspaceStatus(`路径保存失败：${error.message}`, "dirty");
    throw error;
  }
  state.workspaceDevice.routes = structuredClone(result.routes || state.routes);
  state.routes = structuredClone(result.routes || state.routes);
  state.routes.forEach(route => normalizeRoute(route));
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
  setWorkspaceStatus("路径模板已保存，分组已刷新", "saved");
  return true;
}

/** 放弃尚未保存的路径模板修改，恢复设备共享库中的最新模板。 */
function discardRouteChanges() {
  if (!state.workspaceDevice) return;
  state.routes = Array.isArray(state.workspaceDevice.routes)
    ? structuredClone(state.workspaceDevice.routes)
    : [];
  state.routes.forEach(route => normalizeRoute(route));
  state.testRouteConfigs = normalizeTestRouteConfigs(state.testRouteConfigs, state.routes);
  captureRouteGroupingProfiles();
  state.routeDirty = false;
  state.routeEditingIndex = -1;
  state.routeEditSnapshot = null;
  state.routeEditGroupingProfile = null;
  state.routeEditIsNew = false;
  state.routeNameChanges.clear();
  state.expandedRouteProcessGroups.clear();
  state.expandedRouteGroups.clear();
  state.expandedRoutes.clear();
  renderRoutes();
  setWorkspaceStatus("已放弃未保存的路径修改", "saved");
}

/** 进入单条模板编辑态；分组继续使用保存前快照，直到用户明确保存。 */
function beginRouteEdit(routeIndex, isNew = false) {
  if (!state.routes[routeIndex]) return false;
  if (state.routeEditingIndex >= 0 && state.routeEditingIndex !== routeIndex) {
    setWorkspaceStatus("请先保存或取消当前正在编辑的路径模板", "dirty");
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

/** 取消单条模板草稿，不影响其他模板。 */
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
  setWorkspaceStatus("已取消路径模板修改", "saved");
}

/** 保存当前测试集；运行和切换前可静默调用。 */
async function saveCurrentTest(silent = false) {
  if (!state.workspaceDeviceId || !state.testCaseId) return false;
  const inputName = document.getElementById("testCaseName").value.trim();
  if (!inputName) {
    setWorkspaceStatus("测试名称不能为空，请输入名称后再保存", "dirty");
    throw new Error("测试名称不能为空");
  }
  state.testCaseName = inputName;
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(currentTestSnapshot())
    });
  } catch (error) {
    setWorkspaceStatus(`保存失败：${error.message}`, "dirty");
    throw error;
  }
  const index = state.workspaceDevice.tests.findIndex(test => test.id === state.testCaseId);
  state.workspaceDevice.tests[index] = result.test; state.testCaseName = result.test.name; state.dirty = false; state.routeNameChanges.clear();
  renderWorkspaceControls(); setWorkspaceStatus(`${silent ? "已自动保存" : "已保存"}“${state.testCaseName}”`, "saved");
  return true;
}

/** 新建空白测试集，或复制当前测试集形成独立副本。 */
async function createTestCase(copyCurrent = false, targetGroup = state.activeTestGroup) {
  if (!state.workspaceDeviceId) throw new Error("请先选择设备");
  if (state.dirty) await saveCurrentTest(true);
  const source = copyCurrent ? currentTestSnapshot(`${state.testCaseName} 副本`) : makeDefaultTestCase(`测试集 ${(state.workspaceDevice?.tests?.length || 0) + 1}`);
  source.group = targetGroup;
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source)
  });
  state.workspaceDevice.tests.push(result.test);
  const summary = state.workspaceDevices.find(device => device.id === state.workspaceDeviceId); if (summary) summary.testCount = state.workspaceDevice.tests.length;
  applyTestCase(result.test);
}

/** 新建一个空测试组别，并自动切换到该组。 */
async function createTestGroup() {
  const group = await showWorkspaceDialog({ title: "新增测试组别", message: "请输入组别名称；新建后会自动切换到该组。", needsInput: true });
  if (group === null) return;
  if (!group) throw new Error("测试组别名称不能为空");
  const exists = (state.workspaceDevice?.testGroups || []).includes(group)
    || (state.workspaceDevice?.tests || []).some(test => String(test.group || "").trim() === group);
  if (exists) throw new Error(`测试组别“${group}”已经存在`);
  if (state.dirty) await saveCurrentTest(true);
  let result;
  try {
    result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: group })
    });
  } catch (error) {
    if (error.message === "Not found") throw new Error("本地服务版本过旧，请重启 server.py 后再新建组别");
    throw error;
  }
  state.workspaceDevice.testGroups = result.groups;
  state.activeTestGroup = group; state.testCaseId = ""; state.testCaseName = ""; state.testCaseGroup = group; state.dirty = false;
  renderWorkspaceControls(); resetRunResult(); setWorkspaceStatus(`已新建测试组别“${group}”，请在该组中新建测试`, "saved");
}

/** 重命名当前测试组别，并同步更新该组内所有测试。 */
async function renameCurrentTestGroup() {
  const oldName = state.activeTestGroup;
  if (!oldName) throw new Error("默认“未分组”不能重命名");
  const group = await showWorkspaceDialog({ title: "重命名测试组别", message: "组内测试会保留，并同步使用新组别名称。", value: oldName, needsInput: true });
  if (group === null || group === oldName) return;
  if (!group) throw new Error("测试组别名称不能为空");
  if (state.dirty) await saveCurrentTest(true);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldName, name: group })
  });
  state.workspaceDevice.testGroups = result.groups; state.workspaceDevice.tests = result.tests;
  state.activeTestGroup = group; state.testCaseGroup = group;
  const current = result.tests.find(test => test.id === state.testCaseId);
  if (current) applyTestCase(current); else await selectWorkspaceGroup(group);
  setWorkspaceStatus(`已将测试组别重命名为“${group}”`, "saved");
}

/** 删除当前测试组别；若组内有测试，确认后会一并删除。 */
async function deleteCurrentTestGroup() {
  const group = state.activeTestGroup;
  const testCount = (state.workspaceDevice?.tests || []).filter(test => String(test.group || "").trim() === group).length;
  if (!group && !testCount) throw new Error("“未分组”中没有可删除的测试");
  const impact = testCount ? `该组含有 ${testCount} 个测试，删除后这些测试将无法恢复。` : "该组为空，删除后无法恢复。";
  const displayName = group || "未分组";
  const confirmed = await showWorkspaceDialog({ title: "删除测试组别", message: `确定删除“${displayName}”吗？${impact}`, dangerous: true });
  if (!confirmed) return;
  if (state.dirty) await saveCurrentTest(true);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/groups`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: group })
  });
  state.workspaceDevice.testGroups = result.groups; state.workspaceDevice.tests = result.tests;
  const summary = state.workspaceDevices.find(device => device.id === state.workspaceDeviceId); if (summary) summary.testCount = result.tests.length;
  const nextGroup = result.groups[0] || "";
  state.activeTestGroup = nextGroup; state.testCaseId = ""; state.testCaseName = ""; state.testCaseGroup = nextGroup; state.dirty = false;
  const nextTest = result.tests.find(test => String(test.group || "").trim() === nextGroup) || result.tests[0];
  if (nextTest) applyTestCase(nextTest);
  else { renderWorkspaceControls(); resetRunResult(); setWorkspaceStatus(`已删除测试组别“${displayName}”`, "saved"); }
}

/** 删除当前测试集，并优先停留在当前测试组别的下一套剩余测试。 */
async function deleteCurrentTest() {
  if (!state.testCaseId) return;
  const confirmed = await showWorkspaceDialog({ title: "删除测试", message: `确定删除测试“${state.testCaseName}”吗？删除后无法恢复。`, dangerous: true });
  if (!confirmed) return;
  const currentGroup = state.activeTestGroup, deletedTestName = state.testCaseName;
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, { method: "DELETE" });
  state.workspaceDevice.tests = result.tests;
  const summary = state.workspaceDevices.find(device => device.id === state.workspaceDeviceId); if (summary) summary.testCount = result.tests.length;
  const nextTestInCurrentGroup = result.tests.find(test => String(test.group || "").trim() === currentGroup);
  if (nextTestInCurrentGroup) {
    applyTestCase(nextTestInCurrentGroup);
    return;
  }
  // 当前组已为空时仍保留该组选择，方便继续新建测试而不跳转到其他组。
  state.activeTestGroup = currentGroup; state.testCaseId = ""; state.testCaseName = ""; state.testCaseGroup = currentGroup; state.dirty = false;
  renderWorkspaceControls(); resetRunResult(); setWorkspaceStatus(`已删除测试“${deletedTestName}”`, "saved");
}

/** 在当前设备中切换测试集，切换前自动保存当前编辑。 */
async function selectWorkspaceTest(testId) {
  if (state.dirty) await saveCurrentTest(true);
  const index = state.workspaceDevice?.tests?.findIndex(test => test.id === testId) ?? -1;
  if (index < 0) throw new Error(`测试集不存在：${testId}`);
  const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/tests/${testId}`);
  const testCase = result.test;
  state.workspaceDevice.tests[index] = testCase;
  applyTestCase(testCase);
}

/** 切换测试组别，并载入该组中的第一个测试。 */
async function selectWorkspaceGroup(group) {
  if (state.dirty) await saveCurrentTest(true);
  state.activeTestGroup = group;
  const testCase = state.workspaceDevice?.tests?.find(test => String(test.group || "").trim() === group);
  if (!testCase) {
    state.testCaseId = ""; state.testCaseName = ""; state.testCaseGroup = group; state.dirty = false;
    renderWorkspaceControls(); resetRunResult(); setWorkspaceStatus(`测试组别“${group || "未分组"}”暂无测试`, "saved");
    return;
  }
  await selectWorkspaceTest(testCase.id);
}

/** 读取一个设备及其测试集；首次导入时自动建立默认测试集。 */
async function selectWorkspaceDevice(deviceId, preferredTestId = "") {
  const result = await requestJson(`/api/workspaces/${deviceId}`);
  state.workspaceDevice = result.device; state.workspaceDeviceId = result.device.id;
  state.activeTestGroup = ""; state.testCaseGroup = "";
  applyDeviceTopology(result.device.device, result.device.name, result.device.robotSlots);
  resetDeviceTimingDraft();
  state.routes = Array.isArray(result.device.routes) ? structuredClone(result.device.routes) : [];
  state.cleans = Array.isArray(result.device.cleans) ? structuredClone(result.device.cleans).map(normalizeClean) : [];
  if (!result.device.tests.length) {
    const created = await requestJson(`/api/workspaces/${deviceId}/tests`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(makeDefaultTestCase())
    });
    state.workspaceDevice.tests.push(created.test);
  }
  const summary = state.workspaceDevices.find(device => device.id === deviceId); if (summary) summary.testCount = state.workspaceDevice.tests.length;
  const selected = state.workspaceDevice.tests.find(test => test.id === preferredTestId) || state.workspaceDevice.tests[0];
  await selectWorkspaceTest(selected.id);
}

/** 加载设备目录，并选择指定设备或目录中的第一台设备。 */
async function loadWorkspaceCatalog(preferredDeviceId = "", preferredTestId = "") {
  const result = await requestJson("/api/workspaces"); state.workspaceDevices = result.devices;
  const deviceId = result.devices.some(device => device.id === preferredDeviceId) ? preferredDeviceId : result.devices[0]?.id;
  if (deviceId) await selectWorkspaceDevice(deviceId, preferredTestId); else resetWorkspaceSelection();
}

/** 目录中没有设备时清空选择状态，回到“尚未导入设备”的初始界面。 */
function resetWorkspaceSelection() {
  state.workspaceDevice = null; state.workspaceDeviceId = ""; state.testCaseId = ""; state.testCaseName = ""; state.testCaseGroup = ""; state.activeTestGroup = ""; state.dirty = false;
  state.deviceName = ""; state.baseDevice = null; state.device = null; state.stationNames = []; state.loadPorts = []; state.processModules = []; state.robotNames = []; state.robotScopes = {}; state.robotSlots = {};
  state.deviceStationName = ""; state.deviceRobotName = ""; state.deviceRobotTransferSources = {}; state.deviceTimingDraft = null; state.deviceTimingDirty = false; state.deviceTimingSaving = false; state.deviceTimingStatusMessage = "选择设备后开始配置";
  renderWorkspaceControls();
  renderDeviceTimingConfiguration();
  resetRunResult();
}

/** 删除当前设备及其全部测试集，并刷新设备目录。 */
async function deleteWorkspaceDevice() {
  if (!state.workspaceDeviceId) return;
  if (state.batchRunning) throw new Error("批量任务运行中，请等待完成或取消后再删除设备");
  const deviceName = displayDeviceName(state.workspaceDevices.find(device => device.id === state.workspaceDeviceId)?.name || state.workspaceDevice?.name);
  const confirmed = await showWorkspaceDialog({ title: "删除设备", message: `确定删除设备“${deviceName}”吗？其下全部测试集、路线与清洁配方将一并删除，且无法恢复。`, dangerous: true });
  if (!confirmed) return;
  const result = await requestJson(`/api/workspaces/devices/${state.workspaceDeviceId}`, { method: "DELETE" });
  writeTerminal(`$ 已删除设备 ${result.deleted.name}\n  其下 ${result.deleted.testCount} 个测试集已一并移除`);
  try {
    await loadWorkspaceCatalog();
    setWorkspaceStatus(`已删除设备“${result.deleted.name}”`, "saved");
  } catch (error) {
    // 服务端删除已生效；目录刷新失败时基于本地快照降级，避免残留已删除的设备。
    state.workspaceDevices = state.workspaceDevices.filter(device => device.id !== result.deleted.id);
    const nextDeviceId = state.workspaceDevices[0]?.id;
    if (nextDeviceId) await selectWorkspaceDevice(nextDeviceId); else resetWorkspaceSelection();
    setWorkspaceStatus(`设备已删除，但目录刷新失败：${error.message}`, "dirty");
  }
}

/** 切换主功能标签，并只在运行页显示策略侧栏。 */
function switchTab(name) {
  document.querySelectorAll("[data-tab-target]").forEach(button => button.classList.toggle("active", button.dataset.tabTarget === name));
  document.querySelectorAll("[data-tab-view]").forEach(view => view.classList.toggle("active", view.dataset.tabView === name));
  document.getElementById("scheduleSide").classList.toggle("is-hidden", name !== "schedule");
  document.getElementById("pageLayout").classList.toggle("editor-mode", name !== "schedule");
  document.getElementById("pageLayout").classList.toggle("documentation-mode", name === "documentation");
  document.body.classList.toggle("documentation-mode", name === "documentation");
  if (name === "documentation") void documentationView.load();
  if (name === "device-config") renderDeviceTimingConfiguration();
  if (name !== "route") closeStepDrawer();
}

/** 同步轮数、时间和每轮 CJob/PJob 容器；缩放只裁剪尾部，已有轮次保持原位。 */
function resizeRounds(count) {
  normalizeRounds();
  const safe = Math.max(1, Math.min(8, Number(count) || 1)); state.roundCount = safe;
  while (state.rounds.length < safe) {
    const index = state.rounds.length, priorTime = Number(state.rounds.at(-1)?.currentTime || 0);
    state.rounds.push(makeRound(index + 1, priorTime + 70, state.routes[0]?.name || "", state.loadPorts[index] || state.loadPorts[0] || ""));
  }
  state.rounds.length = safe; normalizeRounds(); renderRounds();
}

/** 重算时间已合并到轮次卡片，此函数仅维持旧调用点的状态同步。 */
function renderTimes() { normalizeRounds(); }

/** 返回 Route 或 RouteStep 支持的 Clean 挂载位置。 */
function cleanPlacementDefinitions(scope) {
  return scope === "route"
    ? [
        { key: "prePJobCleanRefs", label: "PJob 前", types: ["preclean", "dummy", "dummywac"] },
        { key: "postPJobCleanRefs", label: "PJob 后", types: ["postclean"] },
      ]
    : [
        // 腔室级清洁仅支持离开腔室后的 WAC；带 Dummy 晶圆的清洁必须绑定到 Route。
        { key: "afterCleanRefs", label: "离开腔室后", types: ["wacclean"] },
      ];
}

/** 返回当前 Route 或 RouteStep 中允许 Clean 出现的加工腔室。 */
function cleanContextModules(scope, routeIndex, stageIndex = -1) {
  const route = state.routes[routeIndex];
  if (!route) return [];
  const stages = scope === "step" ? [route.stages[stageIndex]] : route.stages;
  return [...new Set((stages || []).flatMap(stage => (stage?.visits || [])
    .map(visit => visit.stationName)
    .filter(module => state.processModules.includes(module))))];
}

/** 读取某一挂载位置的 Clean 引用。 */
function cleanContextReferences(scope, routeIndex, stageIndex, placement) {
  const route = state.routes[routeIndex];
  if (!route) return [];
  const config = state.testRouteConfigs[route.name]
    || (state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route));
  if (scope === "route") return stringList(config[placement]);
  const stepId = String(route.stages[stageIndex]?.stepId);
  return stringList(config.stages?.[stepId]?.[placement]);
}

/** 在 Route 或 RouteStep 上添加、删除一个 Clean 引用。 */
function setCleanContextReference(context, placement, cleanName, enabled) {
  const route = state.routes[context.routeIndex];
  if (!route) return;
  const update = target => {
    const names = new Set(stringList(target[placement]));
    if (enabled) names.add(cleanName); else names.delete(cleanName);
    target[placement] = [...names];
  };
  const config = state.testRouteConfigs[route.name]
    || (state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route));
  if (context.scope === "route") update(config);
  else {
    const stepId = String(route.stages[context.stageIndex]?.stepId);
    const stageConfig = config.stages?.[stepId]
      || (config.stages[stepId] = stageDefaultConfig(route.stages[context.stageIndex]));
    update(stageConfig);
  }
}

/** 统计 Clean 在全部 Route 和 RouteStep 中的引用次数。 */
function cleanReferenceCount(cleanName) {
  let count = 0;
  Object.values(state.testRouteConfigs).forEach(config => {
    ROUTE_CLEAN_KEYS.forEach(key => { if (stringList(config[key]).includes(cleanName)) count += 1; });
    Object.values(config.stages || {}).forEach(stage => {
      for (const key of ["beforeCleanRefs", "afterCleanRefs"]) {
        if (stringList(stage[key]).includes(cleanName)) count += 1;
      }
    });
  });
  return count;
}

/** 绘制绑定在当前 Route 或 RouteStep 上的 Clean 列表。 */
function renderContextCleans(scope, routeIndex, stageIndex = -1) {
  const rows = cleanPlacementDefinitions(scope).flatMap(placement =>
    cleanContextReferences(scope, routeIndex, stageIndex, placement.key).map(cleanName => ({
      cleanName,
      placement,
      clean: state.cleans.find(item => item.name === cleanName),
    }))
  );
  if (!rows.length) return `<div class="context-clean-empty">尚未配置 Clean</div>`;
  return `<div class="context-clean-list">${rows.map(({ cleanName, placement, clean }) => {
    const modules = stringList(clean?.modules);
    const moduleSummary = modules.length ? modules.join(" / ") : "未选择腔室";
    return `<div class="context-clean-item">
      <div><strong>${escapeHtml(cleanName)}</strong><small>${escapeHtml(placement.label)} · ${escapeHtml(moduleSummary)}</small></div>
      <div class="context-clean-actions">
        <button class="btn small" type="button" data-action="edit-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml(cleanName)}">编辑</button>
        <button class="btn danger small" type="button" data-action="remove-context-clean" data-clean-scope="${scope}" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-placement="${placement.key}" data-clean-name="${escapeHtml(cleanName)}">移除</button>
      </div>
    </div>`;
  }).join("")}</div>`;
}

/** 根据挂载位置刷新 Clean 类型选项和条件字段。 */
function updateCleanDialogFields() {
  const context = state.cleanDialogContext;
  if (!context) return;
  const placement = document.getElementById("cleanPlacement").value;
  const definition = cleanPlacementDefinitions(context.scope).find(item => item.key === placement);
  const typeSelect = document.getElementById("cleanType");
  const currentType = typeSelect.value || context.draft.cleanType;
  typeSelect.innerHTML = CLEAN_TYPE_DEFINITIONS
    .filter(item => definition?.types.includes(item.key))
    .map(item => `<option value="${item.key}">${escapeHtml(item.label)}</option>`)
    .join("");
  typeSelect.value = definition?.types.includes(currentType) ? currentType : definition?.types[0] || "";
  const usesMaterialCount = ["dummy", "dummywac"].includes(typeSelect.value);
  document.getElementById("cleanTriggerField").hidden = typeSelect.value !== "wacclean" && !usesMaterialCount;
  document.getElementById("cleanTriggerLabel").textContent = usesMaterialCount
    ? "Dummy 晶圆数（MaterialCount）"
    : "触发次数";
  document.getElementById("cleanWacTimeField").hidden = typeSelect.value !== "dummywac";
}

/** 打开 Route 或 RouteStep 的 Clean 参数弹窗。 */
function openCleanDialog(scope, routeIndex, stageIndex = -1, cleanName = "", placement = "") {
  const existing = state.cleans.find(clean => clean.name === cleanName);
  const definitions = cleanPlacementDefinitions(scope);
  const selectedPlacement = definitions.some(item => item.key === placement) ? placement : definitions[0].key;
  const draft = normalizeClean(existing || makeClean(definitions[0].types[0]));
  state.cleanDialogContext = {
    scope,
    routeIndex,
    stageIndex,
    cleanName,
    originalPlacement: selectedPlacement,
    draft: structuredClone(draft),
  };
  document.getElementById("cleanDialogTitle").textContent = `${cleanName ? "编辑" : "新增"} ${scope === "route" ? "Job" : "RouteStep"} Clean`;
  document.getElementById("cleanDialogDescription").textContent = scope === "route"
    ? "Clean 只作用于当前测试的所选路径，不会修改路径模板。"
    : "Clean 只作用于当前测试的这个 Step，不会修改路径模板。";
  const placementSelect = document.getElementById("cleanPlacement");
  placementSelect.innerHTML = definitions.map(item => `<option value="${item.key}">${escapeHtml(item.label)}</option>`).join("");
  placementSelect.value = selectedPlacement;
  document.getElementById("cleanType").innerHTML = `<option value="${draft.cleanType}">${escapeHtml(draft.cleanType)}</option>`;
  document.getElementById("cleanRecipeTime").value = String(draft.recipeTime);
  document.getElementById("cleanTriggerCount").value = String(draft.triggerCount);
  document.getElementById("cleanWacRecipeTime").value = String(draft.wacRecipeTime);
  const selectedModules = new Set(stringList(draft.modules));
  const moduleHost = document.getElementById("cleanModuleOptions");
  const modules = cleanContextModules(scope, routeIndex, stageIndex);
  moduleHost.innerHTML = modules.length
    ? modules.map(module => `<label class="clean-module-option"><input type="checkbox" name="cleanModule" value="${escapeHtml(module)}" ${selectedModules.has(module) ? "checked" : ""}><span>${escapeHtml(module)}</span></label>`).join("")
    : `<span class="clean-dialog-empty">当前范围没有可配置的加工腔室</span>`;
  document.getElementById("cleanDialogError").textContent = "";
  document.getElementById("deleteCleanBindingButton").hidden = !cleanName;
  updateCleanDialogFields();
  document.getElementById("cleanType").value = draft.cleanType;
  updateCleanDialogFields();
  document.getElementById("cleanDialog").showModal();
}

/** 保存 Clean 参数并绑定到当前 Route 或 RouteStep。 */
function saveCleanDialog() {
  const context = state.cleanDialogContext;
  if (!context) return;
  const modules = Array.from(document.querySelectorAll('#cleanModuleOptions input[name="cleanModule"]:checked'), input => input.value);
  if (!modules.length) {
    document.getElementById("cleanDialogError").textContent = "请至少选择一个 Clean 适用腔室。";
    return;
  }
  const placement = document.getElementById("cleanPlacement").value;
  const cleanType = document.getElementById("cleanType").value;
  const clean = normalizeClean({
    ...context.draft,
    cleanType,
    recipeTime: Number(document.getElementById("cleanRecipeTime").value),
    triggerCount: Number(document.getElementById("cleanTriggerCount").value),
    materialCount: ["dummy", "dummywac"].includes(cleanType)
      ? Number(document.getElementById("cleanTriggerCount").value)
      : context.draft.materialCount,
    wacRecipeTime: Number(document.getElementById("cleanWacRecipeTime").value),
    modules,
  });
  if (context.cleanName) {
    const cleanIndex = state.cleans.findIndex(item => item.name === context.cleanName);
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

/** 从当前上下文移除 Clean；无其他引用时同时清理定义。 */
function removeContextClean(scope, routeIndex, stageIndex, placement, cleanName) {
  const context = { scope, routeIndex, stageIndex };
  setCleanContextReference(context, placement, cleanName, false);
  if (cleanReferenceCount(cleanName) === 0) {
    state.cleans = state.cleans.filter(clean => clean.name !== cleanName);
  }
  markTestDirty();
  renderRoutes();
  if (state.drawer) renderStepDrawer();
  if (pjobRoutePickerContext && document.getElementById("pjobRouteDialog").open) {
    renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
  }
}

/** 返回 Step 类型的简短名称。 */
/** 绘制紧凑候选设备选择器，避免原生多选框占用整行高度。 */
function renderCandidatePicker(routeIndex, stageIndex, allowed, candidates) {
  const selected = new Set(candidates);
  const summary = candidates.length
    ? candidates.map(name => `<span class="chip">${escapeHtml(name)}</span>`).join("")
    : `<span class="candidate-picker-empty">选择设备</span>`;
  return `<details class="candidate-picker" onclick="event.stopPropagation()"><summary>${summary}</summary><div class="candidate-picker-menu">${allowed.map(name => `<label class="candidate-option"><input type="checkbox" data-scope="stage-candidate-toggle" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-candidate="${escapeHtml(name)}" ${selected.has(name) ? "checked" : ""}><span>${escapeHtml(name)}</span></label>`).join("")}</div></details>`;
}

/** 更新候选选择器的摘要与 Step 状态，但不重绘整个路径列表，保持下拉常驻。 */
function refreshCandidatePicker(control) {
  const picker = control.closest(".candidate-picker");
  const routeIndex = Number(control.dataset.routeIndex);
  const stageIndex = Number(control.dataset.stageIndex);
  const route = state.routes[routeIndex];
  const stage = route?.stages?.[stageIndex];
  if (!picker || !stage) return;
  normalizeRoute(route);
  const candidates = [...new Set((stage.visits || []).map(visit => visit.stationName).filter(Boolean))];
  const summary = picker.querySelector("summary");
  if (summary) {
    summary.innerHTML = candidates.length
      ? candidates.map(name => `<span class="chip">${escapeHtml(name)}</span>`).join("")
      : `<span class="candidate-picker-empty">选择设备</span>`;
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

/** 绘制只读候选腔室；首尾固定模块与测试侧路径实例都使用该展示。 */
function renderReadonlyCandidates(stage) {
  const candidates = [...new Set((stage?.visits || []).map(visit => visit.stationName).filter(Boolean))];
  return candidates.length
    ? candidates.map(name => `<span class="chip">${escapeHtml(name)}</span>`).join("")
    : `<span class="candidate-picker-empty">未选择</span>`;
}

/** 绘制 Route Step 列表；Src/Sink 固定，其余 Step 允许选择候选设备。 */
function renderSteps(route, routeIndex) {
  return route.stages.map((stage, stageIndex) => {
    const candidates = [...new Set((stage.visits || []).map(visit => visit.stationName).filter(Boolean))];
    const allowed = stageUsesRobot(stage, stageIndex) ? state.robotNames : state.stationNames;
    const fixed = isFixedRouteStep(route, stageIndex);
    const picker = fixed ? `<span class="chip">测试 LoadPort</span>` : renderCandidatePicker(routeIndex, stageIndex, allowed, candidates);
    const actions = fixed
      ? `<span class="route-step-readonly">固定模块</span>`
      : `<div class="route-step-actions"><button class="btn icon small" title="前移" data-action="move-step-up" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">↑</button><button class="btn icon small" title="后移" data-action="move-step-down" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">↓</button><button class="btn danger icon small" title="删除" data-action="remove-stage" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" ${route.stages.length <= 3 ? "disabled" : ""}>×</button></div>`;
    return `<tr data-route-template-step data-route-index="${routeIndex}" data-stage-index="${stageIndex}">
      <td><span class="step-id-badge">${Number(stage.stepId)}</span></td>
      <td><span class="step-type ${stage.needProcess ? "process" : ""}">${stepKind(route, stageIndex)}</span></td>
      <td>${picker}</td>
      <td class="route-step-readonly"><span class="step-next">${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "结束"}</span></td>
      <td class="route-step-readonly">${stage.needProcess ? "true" : "false"}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
}

/** 根据加工 Step 数量和并行机器结构计算页面分组，不修改 Route.Group。 */
function routeProcessProfile(route) {
  normalizeRoute(route);
  return RouteEditorLogic.processProfile(route);
}

/** 按加工路径拓扑生成模板名称；加工时间、清洁与驻留只在测试中编辑。 */
function generatedRouteName(route) {
  return automaticTemplateName(routeProcessProfile(route));
}

/** 记录 Route 自动改名链，并同步当前测试中引用该 Route 的 PJob 与测试侧配置。 */
function recordRouteRename(oldName, newName) {
  if (!oldName || oldName === newName) return;
  let extended = false;
  for (const [origin, current] of state.routeNameChanges) {
    if (current === oldName) { state.routeNameChanges.set(origin, newName); extended = true; }
  }
  if (!extended) state.routeNameChanges.set(oldName, newName);
  state.rounds.forEach(round => round.cjobs.forEach(cjob => cjob.pjobs.forEach(pjob => {
    if (pjob.routeRef === oldName) pjob.routeRef = newName;
  })));
  if (state.testRouteConfigs[oldName] && !state.testRouteConfigs[newName]) {
    state.testRouteConfigs[newName] = structuredClone(state.testRouteConfigs[oldName]);
    delete state.testRouteConfigs[oldName];
  }
}

/** 按加工路径和实际候选腔室自动生成唯一 Route 名称。 */
function synchronizeRouteNames() {
  const occurrences = new Map(); let changed = false;
  state.routes.forEach(route => {
    const baseName = generatedRouteName(route);
    const occurrence = (occurrences.get(baseName) || 0) + 1; occurrences.set(baseName, occurrence);
    const generatedName = occurrence === 1 ? baseName : `${baseName} (${occurrence})`;
    if (route.name !== generatedName) {
      recordRouteRename(route.name, generatedName); route.name = generatedName; changed = true;
    }
  });
  return changed;
}

/** 生成“工序数 → 并行机器结构 → 路径”的稳定分组列表；重入路径统一进入独立分组。 */
function groupedRoutes() {
  const natural = (left, right) => left.localeCompare(right, undefined, { numeric: true });
  const processGroups = new Map();
  state.routes.forEach((route, routeIndex) => {
    const profile = routeGroupingProfile(route);
    const processKey = profile.isReentrant ? profile.key : String(profile.processCount);
    const processGroup = processGroups.get(processKey) || {
      key: processKey,
      processCount: profile.processCount,
      isReentrant: profile.isReentrant,
      label: profile.processLabel,
      routeCount: 0,
      structures: new Map(),
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
  return [...processGroups.values()]
    .sort((left, right) => (
      Number(left.isReentrant) - Number(right.isReentrant)
      || left.processCount - right.processCount
    ))
    .map(processGroup => ({
      ...processGroup,
      structures: [...processGroup.structures.values()]
        .sort(RouteEditorLogic.compareProfiles)
        .map(structure => ({
          ...structure,
          routes: structure.routes.sort((left, right) => natural(left.route.name || "", right.route.name || "")),
        })),
    }));
}

/** 绘制一条已展开路径模板的编辑能力；模板只负责腔室结构。 */
function renderRouteDetails(route, index) {
  return `<div class="route-details"><div class="edit-card-head"><strong>腔室路径</strong><div><button class="btn small" data-action="add-stage" data-index="${index}">＋ Step 组</button></div></div>
    <div class="route-table-wrap"><table class="route-table"><thead><tr><th>StepID</th><th>类型</th><th>可选腔室 / 机器手</th><th>PostStepID</th><th>NeedProcess</th><th></th></tr></thead><tbody>${renderSteps(route, index)}</tbody></table></div></div>`;
}

/** 绘制路径筛选器与当前组合的扁平路径列表；路径页只保留工序数与并行结构两个筛选。 */
function renderRoutes() {
  const host = document.getElementById("routeList");
  const processSelect = document.getElementById("routeProcessFilter");
  const parallelSelect = document.getElementById("routeParallelFilter");
  const processGroups = groupedRoutes();
  const selectedProcess = processGroups.find(group => group.key === state.routeProcessFilter) || processGroups[0];
  state.routeProcessFilter = selectedProcess?.key || "";
  const selectedStructure = selectedProcess?.structures.find(structure => structure.key === state.routeParallelFilter) || selectedProcess?.structures[0];
  state.routeParallelFilter = selectedStructure?.key || "";

  processSelect.innerHTML = processGroups.map(group => `<option value="${escapeHtml(group.key)}">${escapeHtml(group.label)}</option>`).join("");
  processSelect.value = state.routeProcessFilter;
  processSelect.disabled = !processGroups.length;
  parallelSelect.innerHTML = (selectedProcess?.structures || []).map(structure => `<option value="${escapeHtml(structure.key)}">${escapeHtml(structure.label)}</option>`).join("");
  parallelSelect.value = state.routeParallelFilter;
  parallelSelect.disabled = !selectedProcess?.structures.length;
  initializeCompactSelects();
  refreshCompactSelect(processSelect);
  refreshCompactSelect(parallelSelect);

  if (!selectedStructure) {
    host.innerHTML = `<div class="empty">至少创建一条路径，Job 才能引用。</div>`;
    return;
  }
  const routes = selectedStructure.routes.map(({ route, routeIndex }) => {
    const routeOpen = state.routeEditingIndex === routeIndex;
    const anotherRouteEditing = state.routeEditingIndex >= 0 && !routeOpen;
    const compactPath = routePickerCompactPath(route, false);
    const actions = routeOpen
      ? `<button class="btn small" type="button" disabled>编辑</button><button class="btn primary small" type="button" data-action="save-route" data-route-index="${routeIndex}">保存</button><button class="btn small" type="button" data-action="cancel-route-edit" data-route-index="${routeIndex}">取消</button>`
      : `<button class="btn small" type="button" data-action="edit-route" data-route-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>编辑</button><button class="btn small" type="button" data-action="copy-route" data-route-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>复制</button><button class="btn danger small" type="button" data-action="remove-route" data-index="${routeIndex}" ${anotherRouteEditing ? "disabled" : ""}>删除</button>`;
    return `<article class="route-summary-card ${routeOpen ? "is-editing" : ""}"><div class="route-summary-head"><div class="route-summary-toggle">
      <span class="route-summary-content"><span class="route-summary-primary"><span class="route-summary-id">${routePickerShortId(route)}</span><strong title="${escapeHtml(compactPath)}">${escapeHtml(compactPath)}</strong></span></span></div>
      <div class="route-summary-actions">${actions}</div>
    </div>${routeOpen ? renderRouteDetails(route, routeIndex) : ""}</article>`;
  }).join("");
  host.innerHTML = routes ? `<div class="route-flat-list">${routes}</div>` : `<div class="empty">当前筛选条件下没有匹配的路径。</div>`;
  initializeCompactSelects();
}

/** 为组合路径生成稳定、紧凑的界面编号；完整 Route.Name 仍用于数据引用。 */
function routePickerShortId(route) {
  const routeIndex = state.routes.indexOf(route);
  return routeIndex < 0 ? "R-???" : `R-${String(routeIndex + 1).padStart(3, "0")}`;
}

/** 返回 Clean 引用的类型和参数；缺少定义时仍保留原始名称。 */
function routePickerCleanInfo(cleanName) {
  const clean = state.cleans.find(item => item.name === cleanName);
  return clean ? { ...normalizeClean(clean), defined: true } : { name: cleanName, cleanType: inferCleanType({ name: cleanName }), defined: false };
}

/** 把 WAC 压缩为示例中的 [wac 2|10s] 形式。 */
function routePickerWacToken(cleanName) {
  const clean = routePickerCleanInfo(cleanName);
  return clean.defined ? `wac ${Number(clean.triggerCount) || 0}|${formatCleanSeconds(clean.recipeTime)}` : "wac";
}

/** 收集一个 Stage 上引用的 WAC Clean。 */
function routePickerStageWacTokens(stage) {
  const names = [...new Set((stage.visits || []).flatMap(visit => [
    ...stringList(visit.beforeCleanRefs),
    ...stringList(visit.afterCleanRefs),
  ]))];
  return names.filter(name => routePickerCleanInfo(name).cleanType === "wacclean").map(routePickerWacToken);
}

/** 生成紧凑路径文本；模板视图只显示拓扑，测试视图再显示时间与清洁。 */
function routePickerCompactPath(route, includeTestParameters = true, sourceModule = "") {
  normalizeRoute(route);
  return (route.stages || []).map((stage, stageIndex) => {
    const candidates = [...new Set((stage.visits || []).map(visit => String(visit.stationName || "").trim()).filter(Boolean))];
    const transferOnly = stage.kind === "robot" || (candidates.length && candidates.every(name => (
      state.robotNames.includes(name)
      || /robot/i.test(name)
      || /^(?:ATR|VTR|DBR|UBR|TM|VTM|EFEM)(?:[_-]?\d+)?$/i.test(name)
    )));
    if (transferOnly) return "";
    const fixedSource = isFixedRouteStep(route, stageIndex);
    let node = fixedSource
      ? (stageIndex === 0 ? "Src" : "Sink")
      : candidates.join("/") || "未选腔室";
    if (includeTestParameters && stage.needProcess) {
      const processTime = Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0);
      node += `(${formatCleanSeconds(processTime)})`;
    }
    const wacTokens = includeTestParameters ? routePickerStageWacTokens(stage) : [];
    return `${node}${wacTokens.length ? `[${wacTokens.join("+")}]` : ""}`;
  }).filter(Boolean).join("->") || "未配置路径";
}

/** 用“工序数 + 候选腔室”描述一个工序结构，不暴露内部路径名。 */
function routePickerProcessSummary(profile) {
  const chambers = (profile?.candidatePath || []).join(" → ");
  return { label: profile?.processLabel || "暂无工序", chambers: chambers || "未配置加工腔室" };
}

/** 把 Pre/Post/Dummy/DummyWAC 清洁压缩到单独一行。 */
function routePickerSpecialCleanSummary(route) {
  const names = [...new Set([
    ...ROUTE_CLEAN_KEYS.flatMap(key => stringList(route[key])),
    ...(route.stages || []).flatMap(stage => (stage.visits || []).flatMap(visit => [
      ...stringList(visit.beforeCleanRefs),
      ...stringList(visit.afterCleanRefs),
    ])),
  ])];
  return names.map(routePickerCleanInfo).filter(clean => ["preclean", "postclean", "dummy", "dummywac"].includes(clean.cleanType)).map(clean => {
    if (!clean.defined) return clean.name;
    if (clean.cleanType === "dummywac") return `dummywac ${formatCleanSeconds(clean.recipeTime)}|${formatCleanSeconds(clean.wacRecipeTime)}`;
    const label = { preclean: "pre", postclean: "post", dummy: "dummy" }[clean.cleanType] || clean.cleanType;
    return `${label} ${formatCleanSeconds(clean.recipeTime)}`;
  }).join(" · ");
}

/** 汇总卡片第二行使用的全部清洁信息。 */
function routePickerCleanSummary(route) {
  const special = routePickerSpecialCleanSummary(route);
  const wac = [...new Set((route.stages || []).flatMap(routePickerStageWacTokens))];
  return [special, ...wac].filter(Boolean).join(" · ") || "无";
}

/** 把 BufferOption 数值转换成路径卡片上直接可读的使用模式。 */
function routeBufferMode(value) {
  const index = Math.max(0, Math.min(4, Math.trunc(Number(value) || 0)));
  const modes = [
    { label: "No Buffer", tone: "none" },
    { label: "强制 Buffer Out", tone: "forced" },
    { label: "强制 Buffer In", tone: "forced" },
    { label: "非强制 Buffer Out", tone: "optional" },
    { label: "非强制 Buffer In", tone: "optional" },
  ];
  return { index, ...modes[index] };
}

/** 判断路径是否至少有一个加工 Visit 配置了给定的时间约束。 */
function routeHasTimeConstraint(route, field) {
  return (route.stages || []).some(stage => (stage.visits || []).some(visit => {
    const value = Number(visit[field]);
    return Number.isFinite(value) && value >= 0;
  }));
}

/** 绘制与路径同行的 Buffer 和清洁状态标签。 */
function renderRoutePropertyTags(route) {
  const buffer = routeBufferMode(route.bufferOption);
  const cleanSummary = routePickerCleanSummary(route);
  const hasResidency = routeHasTimeConstraint(route, "residencyConstraint");
  const hasQTime = routeHasTimeConstraint(route, "qTimeLimit");
  const tags = [];
  if (cleanSummary !== "无") tags.push(`<span class="route-property-tag clean-active" title="清洁：${escapeHtml(cleanSummary)}">${escapeHtml(cleanSummary)}</span>`);
  if (hasResidency) tags.push(`<span class="route-property-tag constraint-active" title="驻留时间约束：已配置">驻留约束</span>`);
  if (buffer.index > 0) tags.push(`<span class="route-property-tag buffer-${buffer.tone}" title="Buffer 使用模式 ${buffer.index}：${escapeHtml(buffer.label)}">${escapeHtml(buffer.label)}</span>`);
  if (hasQTime) tags.push(`<span class="route-property-tag qtime-active" title="QTime：已配置">QTime</span>`);
  return tags.length ? `<span class="route-property-tags">${tags.join("")}</span>` : "";
}

/** 绘制一张紧凑的具体路径选择卡片。 */
function renderPJobRouteCard(route, baseline) {
  const routeIndex = state.routes.indexOf(route), selected = route === baseline;
  const compactPath = routePickerCompactPath(route, false);
  return `<button type="button" class="pjob-route-card ${selected ? "selected" : ""}" data-action="select-pjob-route" data-route-index="${routeIndex}" aria-pressed="${selected}" title="${escapeHtml(compactPath)}">
    <span class="pjob-route-card-head"><span class="pjob-route-card-id">${routePickerShortId(route)}</span><strong class="pjob-route-card-path">${escapeHtml(compactPath)}</strong>${selected ? `<span class="pjob-route-card-current">当前选择</span>` : ""}</span>
  </button>`;
}

/** 在路径引用弹窗内显示已选模板的具体 Step；点击 Step 打开右侧抽屉编辑测试参数。 */
function renderRouteInstanceSteps(route, loadPort = "") {
  const routeIndex = state.routes.indexOf(route);
  const runtimeRoute = runtimeRouteForTemplate(route);
  if (loadPort && runtimeRoute.stages?.length) {
    for (const stageIndex of [0, runtimeRoute.stages.length - 1]) {
      (runtimeRoute.stages[stageIndex]?.visits || []).forEach(visit => {
        visit.stationName = loadPort;
      });
    }
  }
  return `<table class="route-table"><thead><tr><th>StepID</th><th>类型</th><th>可选腔室 / 机器手</th><th>PostStepID</th><th>NeedProcess</th></tr></thead><tbody>${(runtimeRoute.stages || []).map((stage, stageIndex) => {
    const fixed = isFixedRouteStep(runtimeRoute, stageIndex);
    return `<tr ${fixed ? "" : "data-step-card"} data-route-index="${routeIndex}" data-stage-index="${stageIndex}">
      <td><span class="step-id-badge">${Number(stage.stepId)}</span></td>
      <td>${fixed ? `<span class="route-step-source-note">由 CJob LoadPort 决定</span>` : `<span class="step-type ${stage.needProcess ? "process" : ""}">${stepKind(route, stageIndex)}</span>`}</td>
      <td>${fixed ? `<span class="route-step-readonly">—</span>` : renderReadonlyCandidates(stage)}</td>
      <td class="route-step-readonly"><span class="step-next">${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "结束"}</span></td>
      <td class="route-step-readonly">${stage.needProcess ? "true" : "false"}</td>
    </tr>`;
  }).join("")}</tbody></table>`;
}

/** 绘制只属于当前测试的 Buffer Option；路径模板本身始终不携带该参数。 */
function renderRouteBufferEditor(routeIndex) {
  const route = state.routes[routeIndex];
  const current = routeBufferMode(runtimeRouteForTemplate(route).bufferOption).index;
  const bufferModes = ["No Buffer", "强制 Buffer Out", "强制 Buffer In", "非强制 Buffer Out", "非强制 Buffer In"];
  return `<section class="route-instance-buffer">
    <label for="route-${routeIndex}-buffer-option">Buffer Option</label>
    <select id="route-${routeIndex}-buffer-option" data-compact-label="Buffer Option" data-scope="test-route" data-route-index="${routeIndex}" data-key="bufferOption">${bufferModes.map((label, value) => `<option value="${value}" ${value === current ? "selected" : ""}>${value} · ${escapeHtml(label)}</option>`).join("")}</select>
  </section>`;
}

/** 刷新弹窗中的并行结构下拉与路径卡片。 */
function renderPJobRouteDialogGroup(processKey, structureKey) {
  const context = pjobRoutePickerContext;
  if (!context) return;
  const selectedProcess = context.groups.find(group => group.key === processKey) || context.groups[0];
  const selectedStructure = (selectedProcess?.structures || []).find(structure => structure.key === structureKey) || selectedProcess?.structures[0];
  const pjob = state.rounds[context.roundIndex]?.cjobs[context.cjobIndex]?.pjobs[context.pjobIndex];
  const selectedRoute = state.routes.find(route => route.name === pjob.routeRef);
  context.processKey = selectedProcess?.key || "";
  context.structureKey = selectedStructure?.key || "";
  const filterGrid = document.getElementById("pjobRouteFilterGrid");
  const cardList = document.getElementById("pjobRouteCardList");
  const detailHost = document.getElementById("pjobRouteDetail");
  document.querySelector(".pjob-route-dialog-body")?.classList.toggle("edit-mode", context.mode === "edit" && Boolean(selectedRoute));
  if (context.mode === "edit" && selectedRoute) {
    document.getElementById("pjobRouteDialogTitle").textContent = `编辑 ${pjob.jobName} 的路径`;
    document.getElementById("pjobRouteDialogContext").textContent = "";
    filterGrid.hidden = true;
    cardList.hidden = true;
    detailHost.hidden = false;
    const routeIndex = state.routes.indexOf(selectedRoute);
    detailHost.innerHTML = `<article class="pjob-route-edit-card">
      <header class="pjob-route-edit-head"><button class="btn small" type="button" data-action="back-pjob-route-selection">← 返回选择模板</button><div><strong>${routePickerShortId(selectedRoute)}</strong></div></header>
      <div class="pjob-route-instance-settings">${renderRouteBufferEditor(routeIndex)}${renderRouteCleanEditor(routeIndex)}</div>
      <div class="route-table-wrap">${renderRouteInstanceSteps(selectedRoute, pjob?.loadPort)}</div>
    </article>`;
    initializeCompactSelects();
    return;
  }
  context.mode = "select";
  document.getElementById("pjobRouteDialogTitle").textContent = `选择 ${pjob.jobName} 的路径模板`;
  filterGrid.hidden = false;
  cardList.hidden = false;
  detailHost.hidden = true;
  detailHost.innerHTML = "";
  const parallelSelect = document.getElementById("pjobRouteParallel");
  parallelSelect.innerHTML = (selectedProcess?.structures || []).map(structure => (
    `<option value="${escapeHtml(structure.key)}" ${structure.key === context.structureKey ? "selected" : ""}>${escapeHtml(structure.label)}</option>`
  )).join("") || `<option value="">暂无结构</option>`;
  document.getElementById("pjobRouteDialogContext").textContent = selectedStructure
    ? `${selectedProcess.label} · ${selectedStructure.label} · ${selectedStructure.routes.length} 条候选路径`
    : "当前工序没有可用路径";
  cardList.innerHTML = (selectedStructure?.routes || []).length
    ? selectedStructure.routes.map(({ route }) => renderPJobRouteCard(route, selectedRoute)).join("")
    : `<div class="pjob-route-dialog-empty">当前工序没有可选择的路径</div>`;
}

/** 打开具体路径卡片面板，并把“工序数/并行结构”选择放在面板顶部。 */
function openPJobRoutePicker(button) {
  const roundIndex = Number(button.dataset.roundIndex), cjobIndex = Number(button.dataset.cjobIndex), pjobIndex = Number(button.dataset.pjobIndex);
  const pjob = state.rounds[roundIndex]?.cjobs[cjobIndex]?.pjobs[pjobIndex];
  if (!pjob) return;
  const groups = groupedRoutes();
  const selectedRoute = state.routes.find(route => route.name === pjob.routeRef);
  const selectedProfile = selectedRoute ? routeProcessProfile(selectedRoute) : null;
  const selectedProcess = groups.find(group => selectedProfile ? (selectedProfile.isReentrant ? group.key === selectedProfile.key : group.key === String(selectedProfile.processCount)) : false) || groups[0];
  const selectedStructure = (selectedProcess?.structures || []).find(structure => structure.key === selectedProfile?.key) || selectedProcess?.structures[0];
  pjobRoutePickerContext = {
    roundIndex, cjobIndex, pjobIndex, trigger: button, groups,
    processKey: selectedProcess?.key || "",
    structureKey: selectedStructure?.key || "",
    mode: "select",
  };
  document.getElementById("pjobRouteDialogTitle").textContent = `选择 ${pjob.jobName} 的路径`;
  const processSelect = document.getElementById("pjobRouteProcess");
  processSelect.innerHTML = groups.length ? groups.map(group => (
    `<option value="${escapeHtml(group.key)}" ${group.key === pjobRoutePickerContext.processKey ? "selected" : ""}>${escapeHtml(group.label)}</option>`
  )).join("") : `<option value="">暂无工序</option>`;
  renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
  button.setAttribute("aria-expanded", "true");
  const dialog = document.getElementById("pjobRouteDialog");
  dialog.showModal();
  window.setTimeout(() => processSelect.focus(), 0);
}

/** 关闭卡片面板；取消选择时把焦点交还给原按钮。 */
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

/** 在弹窗中选择路径模板；测试侧参数保持不变，右侧详情立即切换到新模板。 */
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

/** 外部展示当前工序和具体路径；具体模板与测试参数统一在弹窗内选择和编辑。 */
function renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex) {
  const selectedRoute = state.routes.find(route => route.name === pjob.routeRef);
  const runtimeRoute = selectedRoute ? runtimeRouteForTemplate(selectedRoute) : null;
  const compactPath = runtimeRoute ? routePickerCompactPath(runtimeRoute, true, pjob.loadPort) : "未选择路径";
  const common = `data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}"`;
  return `<div class="pjob-route-picker">
    <div class="pjob-route-current" title="${escapeHtml(compactPath)}"><span class="pjob-route-current-path">${escapeHtml(compactPath)}</span>${runtimeRoute ? renderRoutePropertyTags(runtimeRoute) : ""}</div>
    <button type="button" class="pjob-route-open" data-action="open-pjob-route-picker" aria-label="选择具体路径" aria-haspopup="dialog" aria-controls="pjobRouteDialog" aria-expanded="false" ${common}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
  </div>`;
}

/** 绘制重算轮次 → CJob → PJob 的三级结构。 */
function renderRounds() {
  normalizeRounds();
  const host = document.getElementById("roundList");
  host.innerHTML = state.rounds.map((round, roundIndex) => {
    const roundTitle = roundIndex ? `第 ${roundIndex + 1} 轮重算` : "首次排程";
    const serialMode = round.cjobs.some(cjob => ["Pipeline", "Sequential"].includes(cjob.taskMode));
    const cjobs = round.cjobs.map((cjob, cjobIndex) => {
      const normalLot = cjob.jobType === "NormalLot";
      const fieldPrefix = `round-${roundIndex}-cjob-${cjobIndex}`;
      const occupiedLoadPorts = new Set(
        round.cjobs
          .filter((_item, index) => index !== cjobIndex)
          .map(item => item.loadPort),
      );
      const loadPortOptions = state.loadPorts.map(loadPort => `<option value="${escapeHtml(loadPort)}" ${loadPort === cjob.loadPort ? "selected" : ""} ${occupiedLoadPorts.has(loadPort) ? "disabled" : ""}>${escapeHtml(loadPort)}</option>`).join("");
      const pjobRows = cjob.pjobs.map((pjob, pjobIndex) => {
        const pjobFieldPrefix = `${fieldPrefix}-pjob-${pjobIndex}`;
        return `<div class="pjob-row">
          <div class="pjob-identity"><span>PJob</span><strong>${escapeHtml(pjob.jobName)}</strong></div>
          <label class="pjob-field pjob-material" for="${pjobFieldPrefix}-wafer-count"><span>Material</span><input id="${pjobFieldPrefix}-wafer-count" class="pjob-number" type="number" min="1" max="25" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="waferCount" value="${Number(pjob.waferCount)}"></label>
          <label class="pjob-field pjob-priority" for="${pjobFieldPrefix}-priority"><span>Priority</span><input id="${pjobFieldPrefix}-priority" class="pjob-number" type="number" min="1" inputmode="numeric" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="priority" value="${Number(pjob.priority)}"></label>
          <div class="pjob-field pjob-origin-route"><span>OriginRoute</span>${renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex)}</div>
          <button class="btn danger icon pjob-remove" type="button" aria-label="删除 ${escapeHtml(pjob.jobName)}" title="删除 ${escapeHtml(pjob.jobName)}" data-action="remove-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" ${cjob.pjobs.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13"/></svg></button>
        </div>`;
      }).join("");
      return `<section class="cjob-card">
        <header class="cjob-head">
          <div class="cjob-title"><strong>CJob ${cjobIndex + 1}</strong><span class="cjob-task-id">TaskID ${escapeHtml(cjob.taskId)}</span></div>
          <div class="cjob-controls">
            <div class="field cjob-job-type"><label for="${fieldPrefix}-job-type">JobType</label><select id="${fieldPrefix}-job-type" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="jobType">${CJOB_TYPES.map(value => `<option ${value === cjob.jobType ? "selected" : ""}>${value}</option>`).join("")}</select></div>
            <div class="field cjob-load-port"><label for="${fieldPrefix}-load-port">LoadPort</label><select id="${fieldPrefix}-load-port" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="loadPort" aria-label="CJob ${cjobIndex + 1} LoadPort">${loadPortOptions}</select></div>
            <div class="field cjob-priority ${normalLot ? "" : "disabled-field"}"><label for="${fieldPrefix}-priority">Priority</label><input id="${fieldPrefix}-priority" type="number" min="1" inputmode="numeric" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="priority" value="${Number(cjob.priority)}" ${normalLot ? "" : "disabled"}></div>
            <div class="field cjob-task-mode"><label for="${fieldPrefix}-task-mode">TaskMode</label><select id="${fieldPrefix}-task-mode" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="taskMode">${TASK_MODES.map(value => `<option ${value === cjob.taskMode ? "selected" : ""} ${round.cjobs.length > 1 && ["Pipeline", "Sequential"].includes(value) ? "disabled" : ""}>${value}</option>`).join("")}</select></div>
            <div class="field cjob-cycle"><label for="${fieldPrefix}-cycle">CJobCycle</label><input id="${fieldPrefix}-cycle" type="number" min="1" max="1000" step="1" inputmode="numeric" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="cjobCycle" value="${Number(cjob.cjobCycle)}"></div>
          </div>
          <div class="round-actions cjob-actions"><button class="btn small" type="button" data-action="add-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>PJob</span></button><button class="btn danger small" type="button" data-action="remove-cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" ${round.cjobs.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13"/></svg><span>删除</span></button></div>
        </header>
        <div class="pjob-list">${pjobRows}</div>
      </section>`;
    }).join("");
    const cjobLimitReached = state.loadPorts.length > 0 && round.cjobs.length >= state.loadPorts.length;
    const addCJobDisabled = cjobLimitReached || serialMode;
    const addCJobTitle = serialMode
      ? "Pipeline/Sequential 每轮只能配置一个 CJob"
      : "每轮 CJob 数不能超过 LoadPort 数";
    return `<section class="round-card"><header class="round-head"><div class="round-summary"><div class="round-title"><div class="round-number">${roundIndex + 1}</div><strong>${roundTitle}</strong></div><label class="round-time-editor" for="round-${roundIndex}-time"><span>${roundIndex ? "重算时间" : "排程时间"}</span><span class="round-time-control"><input id="round-${roundIndex}-time" type="number" min="0" step="0.1" inputmode="decimal" data-round-time-index="${roundIndex}" value="${Number(round.currentTime)}" ${roundIndex ? "" : "disabled"}><b aria-hidden="true">s</b></span></label></div><button class="btn small round-add-cjob" type="button" data-action="add-cjob" data-round-index="${roundIndex}" ${addCJobDisabled ? `disabled title="${addCJobTitle}"` : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>CJob</span></button></header><div class="cjob-list">${cjobs}</div></section>`;
  }).join("");
  initializeCompactSelects();
}

/** 绘制 Step 中允许修改的数值参数。 */
function renderStepNumberField(label, key, value, routeIndex, stageIndex, options = {}) {
  const inputId = `step-${routeIndex}-${stageIndex}-${key}`;
  const helper = options.helper ? `<small class="field-help">${escapeHtml(options.helper)}</small>` : "";
  const minimum = options.minimum === undefined ? "" : ` min="${options.minimum}"`;
  return `<div class="step-edit-field">
    <label for="${inputId}">${escapeHtml(label)}</label>
    <div class="step-number-control">
      <input id="${inputId}" type="number" inputmode="decimal" step="${options.step || "0.1"}"${minimum} data-scope="test-step" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-key="${key}" value="${escapeHtml(value)}">
      <span aria-hidden="true">s</span>
    </div>
    ${helper}
  </div>`;
}

/** 绘制 RouteStep 的 Clean 绑定列表和新增入口。 */
function renderStepCleanEditor(routeIndex, stageIndex) {
  return `<section class="step-clean-section">
    <div class="context-clean-head"><div><strong>Clean</strong></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="step" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">＋ Clean</button></div>
    ${renderContextCleans("step", routeIndex, stageIndex)}
  </section>`;
}

/** 绘制只属于当前测试的路径级 Clean，避免写回共享模板。 */
function renderRouteCleanEditor(routeIndex) {
  return `<section class="step-clean-section">
    <div class="context-clean-head"><div><strong>Job Clean</strong></div><button class="btn small" type="button" data-action="open-context-clean" data-clean-scope="route" data-route-index="${routeIndex}" data-stage-index="-1">＋ Clean</button></div>
    ${renderContextCleans("route", routeIndex)}
  </section>`;
}

/** 绘制当前 Step 的配置详情；主区域只暴露业务允许修改的四项参数。 */
function renderStepDrawer() {
  if (!state.drawer) return;
  const { routeIndex, stageIndex } = state.drawer, template = state.routes[routeIndex];
  if (!template) { closeStepDrawer(); return; }
  const route = runtimeRouteForTemplate(template), stage = route?.stages[stageIndex];
  if (!stage || isFixedRouteStep(route, stageIndex)) { closeStepDrawer(); return; }
  document.getElementById("drawerTitle").textContent = `Step ${stage.stepId} 配置`;
  const candidates = [...new Set(stage.visits.map(visit => visit.stationName).filter(Boolean))];
  document.getElementById("drawerSubtitle").textContent = `腔室：${candidates.join(" / ") || "未选择"}`;
  const first = stage.visits[0] ? normalizeVisit(stage.visits[0]) : null;
  const editor = first ? `<section class="step-editor-card" aria-label="Step 时间参数">
    <div class="step-edit-grid">
      ${renderStepNumberField("Process Time", "processTime", first.processTime, routeIndex, stageIndex, { minimum: 0 })}
      ${renderStepNumberField("QTime", "qTimeLimit", first.qTimeLimit, routeIndex, stageIndex)}
      ${renderStepNumberField("Residency", "residencyConstraint", first.residencyConstraint, routeIndex, stageIndex)}
    </div>
  </section>${renderStepCleanEditor(routeIndex, stageIndex)}
  <details class="step-system-details">
    <summary><strong>系统参数</strong><span class="details-chevron" aria-hidden="true">⌄</span></summary>
    <div class="step-system-grid">
      ${renderReadonlyField("Recipe Time", first.processTime)}
      ${renderReadonlyField("Process Recipe", first.processRecipe)}
      ${renderReadonlyField("Process Type", first.processType)}
      ${renderReadonlyField("Slot IDs", first.slotIds)}
      ${renderReadonlyField("Weight", first.weight)}
      ${renderReadonlyField("Move Time Offset", first.moveTimeOffset, true)}
    </div>
  </details>` : `<div class="empty">未选择候选设备，请先在路径列表中选择。</div>`;
  document.getElementById("drawerBody").innerHTML = editor;
}

/** 从测试的路径引用面板打开 Step 抽屉；所有改动写入测试侧 Route 配置。 */
function openPJobStepDrawer(routeIndex, stageIndex) {
  const route = state.routes[routeIndex];
  if (!route || isFixedRouteStep(route, stageIndex)) return;
  state.drawer = { scope: "test", routeIndex, stageIndex };
  renderStepDrawer();
  const drawerLayer = document.getElementById("drawerLayer");
  drawerLayer.classList.add("open");
  if (!drawerLayer.open) drawerLayer.showModal();
}

/** 关闭 Step 抽屉；底层 Route 编辑窗口保持原状态。 */
function closeStepDrawer() {
  state.drawer = null;
  const drawerLayer = document.getElementById("drawerLayer");
  drawerLayer.classList.remove("open");
  if (drawerLayer.open) drawerLayer.close();
}

/** 绘制机器手槽位卡片；臂数与每臂槽位数分别展示。 */
function renderRobotSlots() {
  const container = document.getElementById("robotSlotList");
  const summary = document.getElementById("robotSlotSummary");
  if (!state.baseDevice || !state.robotNames.length) {
    summary.textContent = state.baseDevice ? "设备未声明机器手" : "请先选择设备";
    container.innerHTML = `<div class="robot-slot-empty"><span>${state.baseDevice ? "当前设备没有可配置的机器手。" : "选择或导入设备后，可在这里切换机器手的单臂与双臂模式。"}</span></div>`;
    return;
  }
  const dualArmCount = state.robotNames.filter(name => {
    const robot = state.baseDevice.Robots[name] || {};
    const selected = state.robotSlots[name] || robotDefaultSlots(robot);
    return robotArmSlotGroups(robot).filter(group => group.slotIds.some(slotId => selected.includes(slotId))).length >= DUAL_ARM_SLOT_COUNT;
  }).length;
  summary.textContent = `${state.robotNames.length} 台机器手 · ${dualArmCount} 台双臂`;
  container.innerHTML = state.robotNames.map(robotName => {
    const robot = state.baseDevice.Robots[robotName] || {};
    const available = robotAvailableSlots(robot);
    const armGroups = robotArmSlotGroups(robot);
    const selected = state.robotSlots[robotName] || available;
    const defaults = robotDefaultSlots(robot);
    const selectedArmCount = armGroups.filter(group => group.slotIds.some(slotId => selected.includes(slotId))).length;
    const isDualArm = selectedArmCount >= DUAL_ARM_SLOT_COUNT;
    const supportsDualArm = armGroups.length >= DUAL_ARM_SLOT_COUNT;
    const isDefault = JSON.stringify(selected) === JSON.stringify(defaults);
    const isSaving = state.robotSlotsSaving.has(robotName);
    const accessibleStationCount = new Set(
      Object.values(robot.ArmInfo || {}).flatMap(arm => arm?.AccessibleStations || [])
    ).size;
    const tokens = armGroups.map(group => group.slotIds.map(slotId => `
      <span class="robot-slot-token ${selected.includes(slotId) ? "is-active" : ""}">
        ${escapeHtml(group.armName)} · Slot ${slotId}
      </span>
    `).join("")).join("");
    return `
      <article class="robot-slot-card" data-robot-slot-card="${escapeHtml(robotName)}">
        <header class="robot-slot-card-head">
          <div class="robot-slot-card-title">
            <span class="robot-slot-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 18v3m8-3v3"/></svg>
            </span>
            <div>
              <h3>${escapeHtml(robotName)}</h3>
              <p>${escapeHtml(robot.Type || "Robot")} · 可达 ${accessibleStationCount} 个站点</p>
            </div>
          </div>
          <span class="robot-slot-mode">${isSaving ? "保存中…" : isDualArm ? "双臂" : "单臂"}</span>
        </header>
        <div class="robot-slot-visual" aria-label="${escapeHtml(robotName)} 可用槽位">${tokens}</div>
        <div class="robot-slot-controls" role="group" aria-label="${escapeHtml(robotName)} 工作模式">
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml(robotName)}" data-robot-arm-count="1" aria-pressed="${String(!isDualArm)}" ${isSaving ? "disabled" : ""}>单臂</button>
          <button class="robot-slot-choice" type="button" data-robot-slot-name="${escapeHtml(robotName)}" data-robot-arm-count="2" aria-pressed="${String(isDualArm)}" ${!supportsDualArm || isSaving ? "disabled" : ""}>双臂</button>
          <button class="robot-slot-choice robot-slot-default" type="button" data-robot-slot-default="${escapeHtml(robotName)}" ${isDefault || isSaving ? "disabled" : ""}>恢复默认</button>
        </div>
        <p class="robot-slot-card-note">${supportsDualArm ? "按物理 Arm 切换；每个 Arm 声明的多个槽位会一起保留。" : `设备文件声明 1 个 Arm、${available.length} 个手槽。`}</p>
      </article>
    `;
  }).join("");
}

/** 保存一台机器手的单臂或双臂选择，并保留每条 Arm 的全部槽位。 */
async function setRobotArmCount(robotName, armCount) {
  if (!state.workspaceDeviceId || !state.baseDevice?.Robots?.[robotName]) return;
  const armGroups = robotArmSlotGroups(state.baseDevice.Robots[robotName]);
  const boundedCount = Math.max(1, Math.min(Number(armCount) || 1, DUAL_ARM_SLOT_COUNT, armGroups.length));
  const previousSelections = structuredClone(state.robotSlots);
  const selectedSlots = armGroups.slice(0, boundedCount).flatMap(group => group.slotIds);
  const nextSelections = { ...state.robotSlots, [robotName]: selectedSlots };
  if (JSON.stringify(previousSelections[robotName]) === JSON.stringify(nextSelections[robotName])) return;
  state.robotSlotsSaving.add(robotName);
  applyDeviceTopology(state.baseDevice, state.deviceName, nextSelections);
  renderRobotSlots();
  try {
    const result = await requestJson(`/api/workspaces/${state.workspaceDeviceId}/robot-slots`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ robotSlots: nextSelections }),
    });
    state.workspaceDevice.robotSlots = structuredClone(result.robotSlots);
    applyDeviceTopology(state.baseDevice, state.deviceName, result.robotSlots);
    resetRunResult();
    setWorkspaceStatus(`已保存 ${robotName} 的${boundedCount >= DUAL_ARM_SLOT_COUNT ? "双臂" : "单臂"}配置`, "saved");
  } catch (error) {
    applyDeviceTopology(state.baseDevice, state.deviceName, previousSelections);
    setWorkspaceStatus(`机器手槽位保存失败：${error.message}`, "dirty");
    throw error;
  } finally {
    state.robotSlotsSaving.delete(robotName);
    renderRobotSlots();
  }
}

/** 将一台机器手恢复为导入设备文件中的原始 ArmInfo 模式。 */
async function restoreRobotSlotDefault(robotName) {
  const robot = state.baseDevice?.Robots?.[robotName];
  if (!robot) return;
  const defaults = robotDefaultSlots(robot);
  const defaultArmCount = robotArmSlotGroups(robot).filter(
    group => group.slotIds.some(slotId => defaults.includes(slotId))
  ).length;
  await setRobotArmCount(robotName, defaultArmCount);
  setWorkspaceStatus(`已恢复 ${robotName} 的设备文件默认配置`, "saved");
}

/** 渲染所有依赖状态的区域。 */
function renderAll() { renderTimes(); renderRoutes(); renderRounds(); renderRobotSlots(); if (state.drawer) renderStepDrawer(); }

/** 打开 AlphaGo 模型选择弹窗。 */
function openScheduleAlphaGoOptionsDialog() {
  pendingAlphaGoCheckpointFile = null;
  const configuredPath = String(state.options.scheduleAlphaGoModelPath || "").trim();
  document.getElementById("alphaGoCheckpointPath").value = configuredPath;
  document.getElementById("alphaGoCheckpointFile").value = "";
  document.getElementById("alphaGoCheckpointHint").textContent = configuredPath
    ? "当前 checkpoint 已保存在本地服务中；重新选择文件可替换它。"
    : "选择本机 checkpoint 后将上传到本地服务，并用于后续运行。";
  document.getElementById("scheduleAlphaGoOptionsDialog").showModal();
}

/** 上传用户从文件夹选取的 checkpoint，并返回本地服务可访问的绝对路径。 */
async function uploadAlphaGoCheckpoint(file) {
  const response = await fetch("/api/model-checkpoints", {
    method: "POST",
    headers: { "X-Checkpoint-Filename": encodeURIComponent(file.name) },
    body: file,
  });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.modelPath) {
    throw new Error(result.error || `checkpoint 上传失败（${response.status}）`);
  }
  return String(result.modelPath);
}

/** 保存 AlphaGo checkpoint；搜索和深度参数由生产后端统一管理。 */
async function saveScheduleAlphaGoOptions() {
  const saveButton = document.getElementById("saveScheduleAlphaGoOptionsButton");
  saveButton.disabled = true;
  try {
    const modelPath = pendingAlphaGoCheckpointFile
      ? await uploadAlphaGoCheckpoint(pendingAlphaGoCheckpointFile)
      : String(document.getElementById("alphaGoCheckpointPath").value || "").trim();
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

/** 根据 data 属性把表单值写回状态。 */
function updateStateFromControl(control) {
  let value = control.multiple ? Array.from(control.selectedOptions, item => item.value) : control.type === "checkbox" ? control.checked : control.type === "number" ? Number(control.value) : control.value;
  const key = control.dataset.key;
  const scope = control.dataset.scope;
  const routeControl = ["stage-candidates", "stage-candidate-toggle"].includes(scope);
  if (routeControl) markRoutesDirty(); else markTestDirty();
  if (control.dataset.timeIndex !== undefined) { state.times[Number(control.dataset.timeIndex)] = value; return; }
  if (control.dataset.roundTimeIndex !== undefined) {
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
  if (scope === "stage-candidates") setStageCandidates(Number(control.dataset.routeIndex), Number(control.dataset.stageIndex), Array.from(control.selectedOptions, item => item.value));
  if (scope === "stage-candidate-toggle") {
    const routeIndex = Number(control.dataset.routeIndex), stageIndex = Number(control.dataset.stageIndex);
    const current = new Set(state.routes[routeIndex].stages[stageIndex].visits.map(visit => visit.stationName));
    if (control.checked) current.add(control.dataset.candidate); else current.delete(control.dataset.candidate);
    setStageCandidates(routeIndex, stageIndex, [...current]);
  }
  if (scope === "test-route") {
    const route = state.routes[Number(control.dataset.routeIndex)];
    const config = state.testRouteConfigs[route.name] || (state.testRouteConfigs[route.name] = defaultRouteConfigForRoute(route));
    config[key] = ROUTE_CLEAN_KEYS.includes(key) ? (value ? [value] : []) : value;
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
      value = Math.max(1, Math.min(1000, Math.trunc(Number(value) || 1)));
      control.value = String(value);
    }
    cjob[key] = value;
    if (key === "loadPort") cjob.pjobs.forEach(pjob => { pjob.loadPort = String(value); });
    if (key === "jobType") cjob.priority = value === "NormalLot" ? (cjob.priority > 0 ? cjob.priority : 1) : -1;
    normalizeRounds();
  }
  if (scope === "pjob") {
    const pjob = state.rounds[Number(control.dataset.roundIndex)].cjobs[Number(control.dataset.cjobIndex)].pjobs[Number(control.dataset.pjobIndex)];
    pjob[key] = value;
    normalizeRounds();
  }
}

/** 处理新增、删除和 Step 排序动作。 */
function handleAction(button) {
  const action = button.dataset.action, index = Number(button.dataset.index), routeIndex = Number(button.dataset.routeIndex), stageIndex = Number(button.dataset.stageIndex);
  let routeAction = false;
  if (action === "open-pjob-route-picker") { openPJobRoutePicker(button); return; }
  if (action === "select-pjob-route") { selectPJobRoute(routeIndex); return; }
  if (action === "back-pjob-route-selection") {
    if (pjobRoutePickerContext) {
      pjobRoutePickerContext.mode = "select";
      renderPJobRouteDialogGroup(pjobRoutePickerContext.processKey, pjobRoutePickerContext.structureKey);
    }
    return;
  }
  if (action === "save-route") { saveRoutes().catch(error => writeTerminal(`$ 路径保存失败\n  ${error.message}`, true)); return; }
  if (action === "cancel-route-edit") { cancelRouteEdit(); return; }
  if (action === "open-pjob-step-drawer") { openPJobStepDrawer(routeIndex, stageIndex); return; }
  if (action === "open-context-clean" || action === "edit-context-clean") {
    openCleanDialog(
      button.dataset.cleanScope,
      routeIndex,
      Number.isFinite(stageIndex) ? stageIndex : -1,
      action === "edit-context-clean" ? button.dataset.cleanName || "" : "",
      button.dataset.placement || "",
    );
    return;
  }
  if (action === "remove-context-clean") {
    removeContextClean(
      button.dataset.cleanScope,
      routeIndex,
      Number.isFinite(stageIndex) ? stageIndex : -1,
      button.dataset.placement,
      button.dataset.cleanName,
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
        context.cleanName,
      );
    }
    document.getElementById("cleanDialog").close();
    state.cleanDialogContext = null;
    return;
  }
  if (action === "toggle-route-group") {
    const key = button.dataset.groupKey;
    if (state.expandedRouteGroups.has(key)) state.expandedRouteGroups.delete(key); else state.expandedRouteGroups.add(key);
    renderRoutes(); return;
  }
  if (action === "toggle-route-process-group") {
    const key = button.dataset.processKey;
    if (state.expandedRouteProcessGroups.has(key)) state.expandedRouteProcessGroups.delete(key); else state.expandedRouteProcessGroups.add(key);
    renderRoutes(); return;
  }
  if (action === "edit-route") {
    const profile = routeGroupingProfile(state.routes[routeIndex]);
    state.routeProcessFilter = profile.isReentrant ? profile.key : String(profile.processCount);
    state.routeParallelFilter = profile.key;
    state.expandedRouteProcessGroups.add(String(profile.processCount));
    state.expandedRouteGroups.add(profile.key);
    beginRouteEdit(routeIndex); return;
  }
  if (action === "add-route") {
    if (state.routeEditingIndex >= 0) { setWorkspaceStatus("请先保存或取消当前正在编辑的路径模板", "dirty"); return; }
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
    if (state.routeEditingIndex >= 0) { setWorkspaceStatus("请先保存或取消当前正在编辑的路径模板", "dirty"); return; }
    const source = state.routes[routeIndex], base = `${source.name || "Route"} 副本`, occupied = new Set(state.routes.map(route => route.name)); let name = base, suffix = 2;
    while (occupied.has(name)) name = `${base} (${suffix++})`;
    const copy = structuredClone(source); copy.name = name; state.routes.push(copy);
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
    if (state.routeEditingIndex >= 0) { setWorkspaceStatus("请先保存或取消当前正在编辑的路径模板", "dirty"); return; }
    state.routes.splice(index, 1); state.expandedRoutes.clear(); state.expandedRouteProcessGroups.clear(); state.expandedRouteGroups.clear();
    if (state.drawer?.routeIndex === index) closeStepDrawer();
    markRoutesDirty();
    saveRoutes().catch(error => writeTerminal(`$ 路径删除失败\n  ${error.message}`, true));
    return;
  }
  if (action === "add-stage") { state.routes[index].stages.splice(-1, 0, makeStage(""), makeStage("")); linkRouteSteps(state.routes[index].stages); routeAction = true; }
  if (action === "remove-stage" && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) { state.routes[routeIndex].stages.splice(stageIndex, 1); linkRouteSteps(state.routes[routeIndex].stages); closeStepDrawer(); routeAction = true; }
  if (action === "move-step-up" && stageIndex > 0 && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) { [state.routes[routeIndex].stages[stageIndex - 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex - 1]]; linkRouteSteps(state.routes[routeIndex].stages); routeAction = true; }
  if (action === "move-step-down" && stageIndex < state.routes[routeIndex].stages.length - 1 && !isFixedRouteStep(state.routes[routeIndex], stageIndex)) { [state.routes[routeIndex].stages[stageIndex + 1], state.routes[routeIndex].stages[stageIndex]] = [state.routes[routeIndex].stages[stageIndex], state.routes[routeIndex].stages[stageIndex + 1]]; linkRouteSteps(state.routes[routeIndex].stages); routeAction = true; }
  if (action === "add-cjob") {
    const roundIndex = Number(button.dataset.roundIndex), round = state.rounds[roundIndex];
    if (round.cjobs.some(cjob => ["Pipeline", "Sequential"].includes(cjob.taskMode))) return;
    if (state.loadPorts.length && round.cjobs.length >= state.loadPorts.length) return;
    const cjob = makeCJob(roundIndex + 1, [], state.routes[0]?.name || "", state.loadPorts[round.cjobs.length] || state.loadPorts[0] || "");
    cjob.key = `C${round.cjobs.length + 1}`; round.cjobs.push(cjob);
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
    markTestDirty(); renderAll();
  }
}

/** 收集 Step/Clean 内嵌 Recipe，并合并同名 Recipe 的设备范围。 */
function collectRecipes(routes = state.routes) {
  const recipes = [];
  const cleanByName = new Map(state.cleans.map(runtimeClean).map(clean => [clean.name, clean]));

  /** 按公司标准把 CleanCondition 使用的计数器写入产品 Recipe.Weight。 */
  function standardProcessWeight(visit) {
    const rawWeight = visit.weight ?? "{}";
    let weight;
    try {
      weight = typeof rawWeight === "string" ? JSON.parse(rawWeight || "{}") : structuredClone(rawWeight || {});
    } catch (_error) {
      // 保留非法原值，由后端返回既有的精确校验错误，避免前端静默改写。
      return rawWeight;
    }
    if (!weight || typeof weight !== "object" || Array.isArray(weight)) return rawWeight;
    [...stringList(visit.beforeCleanRefs), ...stringList(visit.afterCleanRefs)].forEach(cleanName => {
      const clean = cleanByName.get(cleanName);
      if (!stringList(clean?.modules).includes(visit.stationName)) return;
      const stateVariable = String(clean?.stateVariable || "").trim();
      // IdleTime 是设备空闲时钟；其余 CleanCondition 计数器随产品加工递增。
      if (stateVariable && stateVariable !== "IdleTime" && weight[stateVariable] === undefined) {
        weight[stateVariable] = 1;
      }
    });
    return JSON.stringify(weight);
  }

  function add(name, time, modules, processType = "", weightText = "{}") {
    const weight = typeof weightText === "string" ? weightText : JSON.stringify(weightText ?? {}), moduleList = stringList(modules);
    const existing = recipes.find(recipe => recipe.name === name && Number(recipe.time) === Number(time) && recipe.processType === processType && recipe.weight === weight);
    if (existing) {
      existing.modules = [...new Set([...existing.modules, ...moduleList])];
    } else recipes.push({ name, time: Number(time), modules: moduleList, processType, weight });
  }
  routes.forEach(route => { normalizeRoute(route); route.stages.forEach(stage => stage.visits.forEach(visit => { if (visit.processRecipe) add(visit.processRecipe, visit.processTime, [visit.stationName], visit.processType, standardProcessWeight(visit)); })); });
  state.cleans.map(runtimeClean).forEach(clean => {
    add(clean.recipeRef, clean.recipeTime, clean.modules);
    if (clean.cleanType === "dummywac") add(clean.emptyRecipeRef, clean.wacRecipeTime, clean.modules);
  });
  return recipes;
}

/** 从设备拓扑中提取站点可用槽位列表。 */
function stationSlotList(stationName: string): number[] {
  const station = state.device?.Stations?.[stationName];
  if (station) {
    if (Array.isArray(station.Slots) && station.Slots.length) return station.Slots.map(Number);
    const capacity = Number(station.Capacity) || 0;
    return capacity >= 1 ? Array.from({ length: capacity }, (_, index) => index + 1) : [1];
  }
  const robot = state.device?.Robots?.[stationName];
  return robot ? robotDefaultSlots(robot) : [1];
}

/** 将 Route Visit 的 slotIds 按站点真实槽位展开。 */
function expandVisitSlotIds(): void {
  if (!state.device) return;
  for (const route of state.routes) {
    for (const stage of (route.stages || [])) {
      for (const visit of (stage.visits || [])) {
        const stationName = String(visit.stationName || "").trim();
        if (!stationName) continue;
        const slots = stationSlotList(stationName);
        visit.slotIds = slots.join(",");
      }
    }
  }
}

/** 构造后端请求，Recipe 由 Route Step 和 Clean 自动生成。 */
function buildPayload() {
  normalizeRounds();
  expandVisitSlotIds();
  const routes = selectReferencedRoutes(runtimeRoutes(), state.rounds).map(route => ({ ...normalizeRoute(route), stages: route.stages.map(stage => ({ ...stage, visits: stage.visits.map(visit => structuredClone(visit)) })) }));
  const cleans = state.cleans.map(runtimeClean);
  const options = { ...state.options };
  if (state.strategy === "schedule-alphago") {
    // 初始执行模式随回放/步进模式走，避免 update 启动时的会话重置覆盖用户选择。
    options.scheduleAlphaGoExecutionMode = playbackMode === "step" ? "stepped" : "continuous";
  }
  return { schemaVersion: EXPECTED_API_SCHEMA, workspaceDeviceId: state.workspaceDeviceId, workspaceTestId: state.testCaseId, deviceName: state.deviceName, device: state.device, strategy: state.strategy, roundCount: state.roundCount, options, skipValidation: skipValidationEnabled(), hongYeCheck: hongYeCheckEnabled(), skipBaseline: skipBaselineEnabled(), recipes: collectRecipes(routes), cleans, routes, rounds: structuredClone(state.rounds) };
}

/** 返回“跳过输出校验”是否已勾选。 */
function skipValidationEnabled() {
  return document.getElementById("skipValidationInput")?.checked === true;
}

/** 返回是否选择 HongYe SchStateLib 输出校验器。 */
function hongYeCheckEnabled() {
  return document.getElementById("hongYeCheckInput")?.checked === true;
}

/** 返回“跳过Baseline”是否已勾选。 */
function skipBaselineEnabled() {
  return document.getElementById("skipBaselineInput")?.checked === true;
}

/** 把后端校验状态转换成前端中文文案（passed→通过，skipped→跳过）。 */
function validationDisplay(value) {
  if (value === "passed") return "通过";
  if (value === "skipped") return "跳过";
  return value ? String(value) : "";
}

/** 读取算法文件并提交给本地服务登记，成功后刷新策略卡片并选中新算法。 */
async function registerAlgorithmFile(file: File) {
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const separatorIndex = dataUrl.indexOf(",");
      resolve(separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : "");
    };
    reader.onerror = () => reject(new Error("读取算法文件失败"));
    reader.readAsDataURL(file);
  });
  if (!content) throw new Error("读取算法文件失败");
  const response = await fetch("/api/algorithms/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, content }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.ok) {
    throw new Error(result?.error || `服务返回 ${response.status}`);
  }
  state.strategy = result.algorithm?.strategy || state.strategy;
  await checkService();
  setWorkspaceStatus(
    `已登记算法“${result.algorithm?.name || file.name}”，策略 ${state.strategy} 已选中；刷新页面后仍会保留`,
    "saved",
  );
}

/** 根据健康检查返回值绘制全部本地和标准算法。 */
function renderOtherAlgorithmOptions(algorithms) {
  state.availableAlgorithms = Array.isArray(algorithms) ? algorithms : [];
  const container = document.getElementById("otherAlgorithmOptions");
  container.innerHTML = state.availableAlgorithms.map(algorithm => `
    <label class="strategy-card" data-strategy-card="${escapeHtml(algorithm.strategy)}" ${algorithm.unavailableReason ? `title="${escapeHtml(algorithm.unavailableReason)}"` : ""}>
      <input type="radio" name="strategy" value="${escapeHtml(algorithm.strategy)}" ${algorithm.strategy === state.strategy ? "checked" : ""} ${algorithm.available === false ? "disabled" : ""}>
      <b>${escapeHtml(algorithm.name)}</b>
    </label>
  `).join("");
  updateStrategyOptionVisibility();
  renderAlgorithmMetadata();
}

/** 按算法清单声明的能力控制通用参数区，不在前端维护算法名称白名单。 */
function updateStrategyOptionVisibility() {
  const algorithm = state.availableAlgorithms.find(item => item.strategy === state.strategy);
  const optionGroups = new Set(algorithm?.optionGroups || []);
  document.getElementById("loadlockOptions").classList.toggle("is-hidden", !optionGroups.has("loadlock"));
  document.getElementById("heuristicObjectiveOptions").classList.toggle("is-hidden", !optionGroups.has("heuristic-objectives"));
  document.getElementById("scheduleAlphaGoOptions").classList.toggle("is-hidden", !optionGroups.has("schedule-alphago"));
}

/** 在策略列表下方显示指定算法的介绍。 */
function showAlgorithmDetails(strategy) {
  const metadata = state.algorithmMetadata[strategy] || {};
  const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(strategy)}"] b`)?.textContent;
  document.getElementById("algorithmHoverInfo").innerHTML = `
    <span class="algorithm-hover-info-name">${escapeHtml(metadata.name || cardName || strategy)}<small>算法简介</small></span>
    <span class="algorithm-hover-info-description">${escapeHtml(metadata.introduction || "暂无算法简介")}</span>
  `;
}

/** 返回策略在批量结果中的可读名称，兼容动态发现的 other_alg 策略。 */
function displayStrategyName(strategy) {
  const normalized = String(strategy || "heuristic");
  const cardName = document.querySelector(`[data-strategy-card="${CSS.escape(normalized)}"] b`)?.textContent;
  return state.algorithmMetadata[normalized]?.name || cardName || normalized;
}

/** 将策略关联的常用调度参数压缩成结果卡片可横向比较的摘要。 */
function batchParameterSummary(options, strategy) {
  const values = options && typeof options === "object" ? options : {};
  const normalizedStrategy = String(strategy || "heuristic");
  const definitions = [
    ["loadLockManager", "LoadLock", "", []],
    ["residencyGuardSeconds", "驻留余量", "s", []],
    ["maximumRobotHoldingSeconds", "持片上限", "s", []],
    ["maximumSystemResidenceCv", "停留 CV", "", []],
    ["seed", "随机种子", "", []],
    ["loadLockMacroSearchSeconds", "宏搜索", "s", ["loadlock-macro"]],
    ["loadLockMacroRollouts", "宏采样", "", ["loadlock-macro"]],
  ];
  const labels = definitions.flatMap(([key, label, suffix, strategies]) => strategies.length && !strategies.includes(normalizedStrategy)
    ? []
    : values[key] === undefined || values[key] === null || values[key] === ""
    ? []
    : [`${label} ${values[key]}${suffix}`]);
  return labels.length ? labels.join(" · ") : "默认参数";
}

/** 为算法卡片绑定悬浮和键盘详情。 */
function renderAlgorithmMetadata() {
  document.querySelectorAll("[data-strategy-card]").forEach(card => {
    const strategy = card.dataset.strategyCard;
    card.onmouseenter = () => showAlgorithmDetails(strategy);
    card.onfocusin = () => showAlgorithmDetails(strategy);
  });
  const strategyOptions = document.querySelector(".strategy-options");
  strategyOptions.onmouseleave = () => showAlgorithmDetails(state.strategy);
  strategyOptions.onfocusout = event => {
    if (!strategyOptions.contains(event.relatedTarget)) showAlgorithmDetails(state.strategy);
  };
  showAlgorithmDetails(state.strategy);
}

/** 让本次运行生成的 input_data 日志可按需下载。 */
function prepareLogDownload(result) {
  if (!result?.logUrl) return false;
  const link = document.getElementById("logButton");
  link.href = result.logUrl; link.download = result.logFileName || "ct-input-log.json"; link.removeAttribute("aria-disabled");
  return true;
}

/** 为成功结果或带失败 MoveList 的诊断结果启用甘特图入口。 */
function prepareGanttView(result) {
  if (!result?.ganttUrl) return false;
  const link = document.getElementById("ganttButton");
  link.href = result.ganttUrl;
  link.removeAttribute("aria-disabled");
  return true;
}

/** 把本次结果加载进内嵌工作台，并启用直接查看入口。 */
async function prepareWorkspaceView(result) {
  if (!result?.resultId) return null;
  visualizationWorkspace.setAnalysisConfiguration(state.routes, state.rounds);
  visualizationWorkspace.setReplayPlan(buildPayload());
  await visualizationWorkspace.loadResult(result.resultId, state.testCaseName || "当前运行结果");
  if (latestSearchTelemetry?.algorithm === "schedule-alphago") {
    renderSearchTelemetry(latestSearchTelemetry);
  }
  return visualizationWorkspace.getBottleneckUtilization();
}

/** 把运行时长压缩为固定宽度的 mm:ss.d，长任务超过一小时仍保持可读。 */
function formatRunElapsed(milliseconds) {
  const totalTenths = Math.max(0, Math.floor(Number(milliseconds || 0) / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor(totalTenths / 10) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
}

/** 启动紧凑状态卡计时，不依赖后端轮询频率。 */
function startRunStatus(title, initialLabel = "正在准备") {
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

/** 最多展示最近 6 个真实阶段，避免状态卡挤占策略侧栏。 */
function renderRunStatusEvents(events) {
  const root = document.getElementById("runStatusEvents");
  const visible = Array.isArray(events) ? events.slice(-6) : [];
  root.replaceChildren(...visible.map(event => {
    const item = document.createElement("span");
    item.className = `run-status-event ${String(event.status || "")}`;
    const suffix = event.status === "succeeded"
      ? (String(event.label || "").startsWith("收到 ") ? "" : " 成功")
      : event.status === "failed" ? " 失败"
      : event.status === "running" ? "…"
      : event.status === "cancelled" ? " 已停止"
      : "";
    item.textContent = `${event.label || "处理中"}${suffix}`;
    if (event.detail) item.title = String(event.detail);
    return item;
  }));
}

/** 合并服务端状态快照；事件来自实际算法调用边界。 */
function renderSingleRunStatus(snapshot) {
  if (!snapshot) return;
  runStatusElapsedMs = Math.max(runStatusElapsedMs, Number(snapshot.elapsedMs || 0));
  document.getElementById("runStatusElapsed").textContent = formatRunElapsed(runStatusElapsedMs);
  const terminal = ["completed", "failed", "cancelled"].includes(snapshot.status);
  const title = snapshot.status === "completed" ? "当前测试运行完成"
    : snapshot.status === "failed" ? "当前测试运行失败"
    : snapshot.status === "cancelled" ? "当前测试已停止"
    : `正在运行 · ${snapshot.testName || state.testCaseName || "当前测试"}`;
  document.getElementById("runStatusTitle").textContent = title;
  renderRunStatusEvents(snapshot.events || []);
  if (terminal) finishRunStatus(snapshot.status, title);
}

/** 批测共用同一张小卡，只展示汇总而不复制下面的大结果列表。 */
function renderBatchRunStatus(result) {
  if (!result) return;
  const total = Number(result.testCount || 0);
  const completed = Number(result.completed || 0);
  const running = (result.items || []).filter(item => item.status === "running").length;
  renderRunStatusEvents([
    { label: `完成 ${completed}/${total}`, status: completed === total && total ? "succeeded" : "running" },
    { label: `运行中 ${running}`, status: running ? "running" : "skipped" },
    { label: `成功 ${Number(result.succeeded || 0)}`, status: "succeeded" },
    ...(Number(result.failed || 0) ? [{ label: `失败 ${Number(result.failed)}`, status: "failed" }] : []),
  ]);
  document.getElementById("runStatusTitle").textContent = `批量测试 · ${state.activeTestGroup || "未分组"}`;
}

/** 停止计时并保留最终状态，方便用户在下一次运行前核对。 */
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

/** 与同步结果请求并行轮询单测阶段；POST 尚未登记时允许短暂 404。 */
async function pollSingleRunStatus(runId) {
  while (singleRunActive && activeSingleRunId === runId) {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (response.ok) {
        const snapshot = await response.json();
        renderSingleRunStatus(snapshot);
        if (["completed", "failed", "cancelled"].includes(snapshot.status)) return;
      }
    } catch { /* 主结果请求负责展示连接错误。 */ }
    await new Promise(resolve => window.setTimeout(resolve, 180));
  }
}

/** 停止普通单测；迟到的算法输出由服务端丢弃。 */
async function requestSingleRunCancellation() {
  if (!singleRunActive || singleRunCancelling || !activeSingleRunId) return;
  singleRunCancelling = true;
  const button = document.getElementById("runButton");
  button.disabled = true; button.classList.add("running", "cancel"); button.textContent = "正在停止…";
  document.getElementById("runStatusTitle").textContent = "正在停止当前测试";
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(activeSingleRunId)}`, { method: "DELETE" });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || `服务返回 ${response.status}`);
    renderSingleRunStatus(snapshot);
    if (state.strategy === "schedule-alphago") {
      try { await requestSearchControl("cancel"); } catch { /* 单测停止状态已经生效。 */ }
    }
    singleRunAbortController?.abort();
  } catch (error) {
    singleRunCancelling = false;
    button.disabled = false; button.classList.remove("running"); button.classList.add("cancel"); button.textContent = "■ 停止当前测试";
    throw error;
  }
}

/** 调用本地服务运行排程。 */
async function runPlan() {
  const button = document.getElementById("runButton");
  const stepRunButton = document.getElementById("stepRunButton");
  const batchButton = document.getElementById("batchRunButton");
  const comparisonButton = document.getElementById("openParameterComparisonDialogButton");
  if (singleRunActive) {
    try { await requestSingleRunCancellation(); }
    catch (error) { writeTerminal(`$ 停止失败：${error.message || "未知错误"}\n  可再次点击“■ 停止当前测试”重试。`, true); }
    return;
  }
  let logReady = false, ganttReady = false, runResult = null, bottleneckSummary = null;
  const telemetryEnabled = state.strategy === "schedule-alphago";
  let telemetryStopped = false;
  try {
    const healthResponse = await fetch("/api/health", { cache: "no-store" }), health = await healthResponse.json();
    if (!healthResponse.ok || health.schemaVersion !== EXPECTED_API_SCHEMA) throw new Error("本地服务版本过旧，请重启 scripts/config_editor_server.py");
    if (state.strategy.startsWith("other_alg:")) {
      const algorithm = (health.otherAlgorithms || []).find(item => item.strategy === state.strategy);
      if (!algorithm?.available) throw new Error(`${state.strategy} 算法包不存在或入口不完整`);
    } else if (health.strategies?.[state.strategy] === false) {
      throw new Error(health.strategyErrors?.[state.strategy] || `${state.strategy} 策略当前不可用`);
    }
    if (state.testCaseId) await saveCurrentTest(true);
    const payload = buildPayload();
    const runId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");
    payload.clientRunId = runId;
    payload.testCaseName = state.testCaseName || "当前测试";
    singleRunActive = true; singleRunCancelling = false; activeSingleRunId = runId;
    singleRunAbortController = new AbortController();
    button.disabled = false; batchButton.disabled = true; comparisonButton.disabled = true;
    button.classList.remove("running"); button.classList.add("cancel"); button.textContent = "■ 停止当前测试";
    startRunStatus(`正在运行 · ${payload.testCaseName}`, "提交运行请求");
    void pollSingleRunStatus(runId);
    if (telemetryEnabled) {
      stepRunActive = true; stepRunCancelling = false;
      stepRunButton.classList.add("cancel"); stepRunButton.disabled = false; stepRunButton.textContent = "■ 停止模型步进";
    }
    resetRunResult();
    visualizationWorkspace.setAnalysisConfiguration(state.routes, state.rounds);
    if (telemetryEnabled) {
      visualizationWorkspace.beginLiveSolve(
        payload,
        `${displayStrategyName(state.strategy)} · 实时求解`,
      );
      visualizationWorkspace.showPlayback();
      startSearchTelemetryPolling();
    }
    writeTerminal(`$ 开始运行 ${state.strategy}\n  总轮数: ${state.roundCount}\n  重算时间: ${state.rounds.map(round => round.currentTime).join(", ")} s`);
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: singleRunAbortController.signal,
    });
    const responseText = await response.text();
    try { runResult = JSON.parse(responseText); }
    catch { throw new Error(responseText.trim().slice(0, 240) || `服务返回 ${response.status}`); }
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
      }
      catch (workspaceError) { writeTerminal(`$ 工作台加载失败\n  ${workspaceError.message || "未知错误"}`, true); }
    }
    if (!response.ok || !runResult.ok) {
      if (runResult?.metricsAvailable) showFailedResultMetrics(runResult);
      throw new Error(runResult.error || `服务返回 ${response.status}`);
    }
    showResult(runResult);
    finishRunStatus("completed", "当前测试运行完成");
  } catch (error) {
    const cancelled = singleRunCancelling || runResult?.cancelled === true || error?.name === "AbortError";
    const baselineError = runResult?.baseline?.status === "failed" ? `\n  Baseline 失败：${runResult.baseline.error || "未知原因"}` : "";
    const validationIssues = Array.isArray(runResult?.validationIssues)
      ? runResult.validationIssues.map(issue => `  ${issue}`)
      : [];
    if (!runResult?.metricsAvailable && ganttReady) {
      setBottleneckMetric(bottleneckSummary, "没有足够的资源活动");
      document.getElementById("metricMakespan").textContent = Number.isFinite(Number(runResult.makespan))
        ? `${Number(runResult.makespan).toFixed(2)} s`
        : "—";
    }
    writeTerminal([
      cancelled ? `$ 模型步进运行已取消` : `$ 运行失败：${error.message || "未知错误"}`,
      ...validationIssues,
      ...(baselineError ? [baselineError.trim()] : []),
      ...(ganttReady ? ["  已保留可回放的 MoveList；被 RemoveList 取消的动作会以浅色标记，可在甘特图中显示或隐藏"] : []),
      ...(logReady ? ["  复现日志已生成，可点击“导出复现日志”"] : []),
    ].join("\n"), true);
    document.getElementById("metricValidation").textContent = runResult?.metricsAvailable
      ? (runResult.validation === "failed" ? "未通过" : validationDisplay(runResult.validation) || "失败")
      : "失败";
    finishRunStatus(cancelled ? "cancelled" : "failed", cancelled ? "当前测试已停止" : "当前测试运行失败");
  }
  finally {
    if (telemetryEnabled && !telemetryStopped) {
      stopSearchTelemetryPolling(runResult?.searchTelemetry || null);
    }
    if (stepRunActive) {
      stepRunActive = false; stepRunCancelling = false;
      stepRunButton.classList.remove("cancel"); stepRunButton.textContent = "⟳ 运行模型步进";
    }
    singleRunActive = false; singleRunCancelling = false; activeSingleRunId = ""; singleRunAbortController = null;
    button.disabled = false; button.classList.remove("running", "cancel"); button.textContent = "▶ 运行当前测试"; renderWorkspaceControls();
  }
}

/** 以步进模式运行当前测试：运行中按钮变为停止入口，可随时终止耗时较长的搜索。 */
async function runModelStepped() {
  const stepButton = document.getElementById("stepRunButton");
  if (stepButton.disabled) return;
  if (stepRunActive) {
    if (stepRunCancelling) return;
    stepRunCancelling = true;
    stepButton.disabled = true;
    stepButton.textContent = "正在停止…";
    writeTerminal("$ 正在停止模型步进运行…");
    try {
      await requestSearchControl("cancel");
    } catch (error) {
      stepRunCancelling = false;
      stepButton.disabled = false;
      stepButton.classList.add("cancel");
      stepButton.textContent = "■ 停止";
      writeTerminal(`$ 停止请求失败：${error.message || "未知错误"}\n  可再次点击“■ 停止”重试。`, true);
    }
    return;
  }
  if (state.strategy !== "schedule-alphago") {
    writeTerminal("$ 运行模型步进仅支持 Schedule-AlphaGo 策略，请先在“运行策略”中选择。", true);
    return;
  }
  playbackMode = "step";
  renderPlaybackModeSwitch();
  await runPlan();
}

/** 使用当前所选策略并行运行当前测试组中的全部测试。 */
async function runCurrentTestGroup() {
  const button = document.getElementById("batchRunButton");
  const comparisonButton = document.getElementById("openParameterComparisonDialogButton");
  const runButton = document.getElementById("runButton");
  if (state.batchRunning) {
    try {
      await requestBatchCancellation();
    } catch (error) {
      state.batchCancelRequested = false; state.batchCancelSent = false;
      button.disabled = false; button.classList.remove("running"); button.classList.add("cancel"); button.textContent = "■ 终止调度";
      writeTerminal(`$ 终止失败：${error.message || "未知错误"}\n  批量任务仍在运行，可再次尝试终止。`, true);
    }
    return;
  }
  try {
    if (!state.workspaceDeviceId) throw new Error("请先选择设备和测试组");
    if (state.testCaseId) await saveCurrentTest(true);
    const tests = (state.workspaceDevice?.tests || []).filter(test => String(test.group || "").trim() === state.activeTestGroup);
    if (!tests.length) throw new Error("当前测试组没有可运行测试");
    state.batchRunning = true; state.activeBatchId = ""; state.batchCancelRequested = false; state.batchCancelSent = false; state.batchResult = null; state.selectedBatchTestId = "";
    startRunStatus(`批量测试 · ${state.activeTestGroup || "未分组"}`, `等待 ${tests.length} 个测试`);
    batchPerformanceAnalyses.clear();
    batchBottleneckSummaries.clear();
    batchBottleneckRequests.clear();
    batchBottleneckErrors.clear();
    document.getElementById("testGroupAnalysisButton").hidden = true;
    document.getElementById("testGroupAnalysisPanel").hidden = true;
    document.getElementById("testGroupAnalysisPanel").innerHTML = "";
    document.getElementById("batchOverviewButton").hidden = true;
    button.disabled = false; comparisonButton.disabled = true; runButton.disabled = true; button.classList.add("cancel"); button.textContent = "■ 终止调度";
    document.getElementById("batchResults").innerHTML = "";
    writeTerminal(`$ 批量运行当前测试组\n  组别: ${state.activeTestGroup || "未分组"}\n  策略: ${displayStrategyName(state.strategy)}\n  测试数: ${tests.length}\n  后端最多并行运行 4 项…`);
    const response = await fetch("/api/run-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: state.workspaceDeviceId, group: state.activeTestGroup, strategy: state.strategy, options: state.options, skipValidation: skipValidationEnabled(), hongYeCheck: hongYeCheckEnabled(), skipBaseline: skipBaselineEnabled() }),
    });
    let result = await response.json();
    if (!response.ok || !result.batchId || !Array.isArray(result.items)) throw new Error(result.error || `服务返回 ${response.status}`);
    state.activeBatchId = result.batchId;
    showBatchProgress(result);
    renderBatchRunStatus(result);
    if (state.batchCancelRequested) await sendBatchCancellation();
    while (!["completed", "failed", "cancelled"].includes(result.status)) {
      await new Promise(resolve => window.setTimeout(resolve, 450));
      const statusResponse = await fetch(`/api/run-batches/${encodeURIComponent(result.batchId)}`, { cache: "no-store" });
      result = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(result.error || `服务返回 ${statusResponse.status}`);
      showBatchProgress(result);
      renderBatchRunStatus(result);
    }
    if (result.status === "cancelled") {
      showBatchProgress(result);
      writeTerminal(`$ 批量调度已终止\n  已停止提交等待中的测试；仍在算法内部执行的任务结果将被忽略。`);
      finishRunStatus("cancelled", "批量测试已停止");
      return;
    }
    if (result.status === "failed" && !Array.isArray(result.items)) throw new Error(result.error || "批量任务失败");
    showBatchResult(result);
    finishRunStatus(Number(result.failed || 0) ? "failed" : "completed", Number(result.failed || 0) ? "批量测试完成（有失败）" : "批量测试运行完成");
  } catch (error) {
    writeTerminal(`$ 批量运行失败：${error.message || "未知错误"}`, true);
    document.getElementById("metricValidation").textContent = "失败";
    finishRunStatus("failed", "批量测试运行失败");
  } finally {
    state.batchRunning = false; state.activeBatchId = ""; state.batchCancelRequested = false; state.batchCancelSent = false;
    button.disabled = !state.serviceCompatible; runButton.disabled = !state.serviceCompatible;
    button.classList.remove("running", "cancel"); button.textContent = "▦ 运行当前测试组";
    renderWorkspaceControls();
  }
}

/** 请求终止当前批量任务；任务 ID 返回前点击也会在创建后立即补发。 */
async function requestBatchCancellation() {
  if (!state.batchRunning || state.batchCancelRequested) return;
  state.batchCancelRequested = true;
  const button = document.getElementById("batchRunButton");
  button.disabled = true; button.classList.add("running"); button.textContent = "正在终止…";
  writeTerminal("$ 正在终止批量调度…");
  if (state.activeBatchId) await sendBatchCancellation();
}

/** 通知后端取消排队任务，并冻结当前批量结果。 */
async function sendBatchCancellation() {
  if (!state.activeBatchId || state.batchCancelSent) return;
  state.batchCancelSent = true;
  const response = await fetch(`/api/run-batches/${encodeURIComponent(state.activeBatchId)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `终止失败，服务返回 ${response.status}`);
  showBatchProgress(result);
}

/** 更新一个顶部总览卡片，并统一处理可选的补充说明。 */
function setResultMetric(key, label, value, detail = "") {
  document.getElementById(`metric${key}Label`).textContent = label;
  document.getElementById(`metric${key}`).textContent = value;
  document.getElementById(`metric${key}Detail`).textContent = detail;
}

/** 校验未通过的外部算法原始输出也可保留为只读指标与诊断数据。 */
function hasBatchResultMetrics(item) {
  return item?.status === "succeeded" || item?.metricsAvailable === true;
}

/** 将结果分析中的同一瓶颈口径写入顶部摘要卡片。 */
function setBottleneckMetric(summary, emptyDetail = "") {
  const utilization = Number(summary?.utilization);
  const available = summary && Number.isFinite(utilization);
  const resourceName = String(summary?.resourceName || "未知资源").replace(/^工序容量组\s*[·:：-]?\s*/, "").trim() || "未知资源";
  setResultMetric(
    "Moves",
    "Bottleneck Utilization",
    available ? `${resourceName} ${(utilization * 100).toFixed(1)}%` : "—",
    available ? "" : emptyDetail,
  );
}

/** 绘制批量任务的组级汇总指标。 */
function showBatchOverviewMetrics(result) {
  const measured = (result.items || []).filter(hasBatchResultMetrics);
  const averageMakespan = measured.length ? measured.reduce((sum, item) => sum + Number(item.makespan), 0) / measured.length : 0;
  const comparable = measured.filter(item => item.baseline?.status === "succeeded");
  const totalMakespan = comparable.reduce((sum, item) => sum + Number(item.makespan), 0);
  const totalBaseline = comparable.reduce((sum, item) => sum + Number(item.baseline.makespan), 0);
  const aggregateImprovement = totalBaseline > 0 ? (totalBaseline - totalMakespan) / totalBaseline * 100 : NaN;
  const moveCount = measured.reduce((sum, item) => sum + Number(item.moveCount || 0), 0);
  const timeText = result.status === "completed" ? `${(Number(result.totalElapsedMs) / 1000).toFixed(2)} s` : result.status === "cancelled" ? "已终止" : "运行中";
  const makespanText = comparable.length
    ? `${totalMakespan.toFixed(2)} / ${totalBaseline.toFixed(2)} s`
    : measured.length ? `${averageMakespan.toFixed(2)} s` : "—";
  const improvementText = comparable.length && Number.isFinite(aggregateImprovement)
    ? `${aggregateImprovement >= 0 ? "提升" : "退化"} ${Math.abs(aggregateImprovement).toFixed(2)}%`
    : "";
  document.getElementById("metricContext").textContent = `批量总览 · ${result.group || "未分组"}`;
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "Total Time", timeText);
  setResultMetric("Makespan", comparable.length ? "总 Makespan / Baseline" : "平均 Makespan", makespanText, improvementText);
  setResultMetric("Moves", "总 Move 数", moveCount || "—");
  setResultMetric("Validation", result.cancelled ? "成功 / 失败 / 终止" : "成功 / 失败", result.cancelled ? `${result.succeeded || 0} / ${result.failed || 0} / ${result.cancelled}` : `${result.succeeded || 0} / ${result.failed || 0}`);
}

/** 把所选测试的耗时、基线、瓶颈和校验结果展示在顶部。 */
function showBatchItemOverview(item, index) {
  const hasMetrics = hasBatchResultMetrics(item);
  const baseline = item.baseline || {};
  const baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(item.cpuTimeMs ?? item.totalElapsedMs);
  const elapsedTime = Number(item.totalElapsedMs);
  const makespan = Number(item.makespan);
  const improvement = Number(item.improvementPercent);
  const validationText = item.validation === "passed" ? "通过" : item.validation === "skipped" ? "跳过" : item.validation ? String(item.validation) : item.status === "failed" ? "运行失败" : item.status === "cancelled" ? "已终止" : "等待完成";
  const comparisonDetail = baselineReady && Number.isFinite(improvement)
    ? `${improvement >= 0 ? "提升" : "退化"} ${Math.abs(improvement).toFixed(2)}%`
    : baseline.status && baseline.status !== "succeeded" && baseline.status !== "skipped" ? `Baseline ${baseline.status === "failed" ? "失败" : "失效"}` : "";
  const resultUrl = String(item.resultUrl || "");
  const bottleneckReady = resultUrl && batchBottleneckSummaries.has(resultUrl);
  const bottleneckSummary = bottleneckReady ? batchBottleneckSummaries.get(resultUrl) : null;
  const bottleneckError = resultUrl ? batchBottleneckErrors.get(resultUrl) : "";

  document.getElementById("metricContext").textContent = `t${index + 1} · ${item.testName || `测试 ${index + 1}`} · ${displayStrategyName(state.batchResult?.strategy)}`;
  document.getElementById("batchOverviewButton").hidden = false;
  setResultMetric("Time", "CPU Time / 耗时", Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "—", Number.isFinite(elapsedTime) ? `端到端耗时 ${elapsedTime.toFixed(1)} ms` : "");
  setResultMetric("Makespan", "Makespan / Baseline", Number.isFinite(makespan) ? `${makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "—"} s` : "—", comparisonDetail);
  setBottleneckMetric(
    bottleneckSummary,
    hasMetrics && resultUrl
      ? bottleneckError
        ? `瓶颈计算失败：${bottleneckError}`
        : bottleneckReady ? "没有足够的资源活动" : "正在计算稳态瓶颈…"
      : "没有可分析的 MoveList",
  );
  setResultMetric("Validation", "Validation", validationText, item.error || "");
}

/** 请求后端分析批量单项，并缓存结构化结果供页面复用。 */
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
        test => String(test.id) === String(item.testId),
      );
      const resultId = resultUrl.startsWith("/api/results/")
        ? decodeURIComponent(resultUrl.slice("/api/results/".length))
        : "";
      if (!resultId) throw new Error("结果地址不符合服务端分析契约");
      const response = await requestScheduleAnalysis({
        resultId,
        device: state.device,
        windowMode: "steady",
        routes: state.workspaceDevice?.routes || state.routes,
        rounds: testCase?.rounds || state.rounds,
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
    batchBottleneckErrors.set(resultUrl, error.message || "未知错误");
    if (state.selectedBatchTestId === String(item.testId || `index-${index}`)) {
      setBottleneckMetric(null, `瓶颈计算失败：${error.message || "未知错误"}`);
    }
    return null;
  } finally {
    batchBottleneckRequests.delete(resultUrl);
  }
}

/** 为所选测试异步补齐瓶颈数据，然后刷新顶部预览。 */
async function loadBatchItemBottleneck(item, index) {
  await loadBatchItemPerformance(item, index);
  const currentIndex = (state.batchResult?.items || []).findIndex(
    (candidate, candidateIndex) => String(candidate.testId || `index-${candidateIndex}`) === state.selectedBatchTestId,
  );
  if (currentIndex >= 0) showBatchItemOverview(state.batchResult.items[currentIndex], currentIndex);
}

/** 选择批量结果卡片，并在后续轮询中按测试 ID 保持选择。 */
function selectBatchItem(index) {
  const item = state.batchResult?.items?.[index];
  if (!item) return;
  state.selectedBatchTestId = String(item.testId || `index-${index}`);
  renderBatchItems(state.batchResult.items || []);
  showBatchItemOverview(item, index);
  void loadBatchItemBottleneck(item, index);
}

/** 清除单项选择并恢复当前批量任务的组级总览。 */
function showCurrentBatchOverview() {
  if (!state.batchResult) return;
  state.selectedBatchTestId = "";
  renderBatchItems(state.batchResult.items || []);
  showBatchOverviewMetrics(state.batchResult);
}

/** 请求后端评估当前测试组，并把服务端返回的多维统计绘制到结果分析工作台。 */
async function showTestGroupAnalysis() {
  const result = state.batchResult;
  if (!result?.items?.length) return;
  const button = document.getElementById("testGroupAnalysisButton");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在分析…";
  try {
  const analyzable = result.items
    .map((item, index) => ({ item, index }))
    .filter(entry => hasBatchResultMetrics(entry.item) && entry.item.resultUrl);
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
    baselineMakespan: item.baseline?.status === "succeeded"
      ? item.baseline.makespan
      : null,
    cpuTimeMs: item.cpuTimeMs ?? item.totalElapsedMs,
    elapsedTimeMs: item.totalElapsedMs,
    error: item.error || item.baseline?.error || "",
    performance: item.resultUrl
      ? batchPerformanceAnalyses.get(String(item.resultUrl)) ?? null
      : null,
  })));
  const panelMarkup = renderTestGroupAnalysis(
    summary,
    result.group || state.activeTestGroup || "当前测试组",
  );
  visualizationWorkspace.showGroupAnalysis(panelMarkup);
  switchTab("workspace");
  const panel = document.getElementById("testGroupAnalysisPanel");
  bindTestGroupExport(panel, summary, result.group || state.activeTestGroup || "当前测试组");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

/** 绑定测试组逐测试指标面板的“导出 CSV”按钮，生成 CSV 并触发浏览器下载。 */
function bindTestGroupExport(panel, summary, groupName) {
  const button = panel?.querySelector("[data-group-export-csv]");
  if (!button) return;
  button.addEventListener("click", (event) => {
    // 阻止事件冒泡到 <summary>，避免点击导出时展开/收起表格。
    event.preventDefault();
    event.stopPropagation();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = String(groupName || "测试组").replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([`\uFEFF${testGroupSummaryCsv(summary)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `测试组指标-${safeName}-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}

/** 实时绘制总体进度和每个测试的排队、运行、成功、失败状态。 */
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
    "$ 批量运行当前测试组",
    `  组别: ${result.group || "未分组"} · 策略: ${displayStrategyName(result.strategy)}`,
    `  进度: ${completed}/${total} (${percent}%) · 并行数: ${result.workerCount}`,
    `  等待: ${(result.items || []).filter(item => item.status === "queued").length} · 运行中: ${(result.items || []).filter(item => item.status === "running").length} · 成功: ${result.succeeded || 0} · 失败: ${result.failed || 0} · 终止: ${result.cancelled || 0}`,
  ].join("\n"));
}

/** 汇总批量测试卡片的失败报错文本；无失败时返回空字符串。 */
function batchItemErrorText(item) {
  const baseline = item.baseline || {};
  if (baseline.status === "failed") return `Baseline 失败：${baseline.error || "等待重新计算"}`;
  if (item.status === "failed") return `${hasBatchResultMetrics(item) ? "校验失败" : "运行失败"}：${item.error || "未知错误"}`;
  if (baseline.status && baseline.status !== "succeeded" && baseline.status !== "skipped") return `Baseline 失效：${baseline.error || "等待重新计算"}`;
  return "";
}

function renderBatchItems(items) {
  const statusLabels = { queued: "等待中", running: "运行中", succeeded: "成功", failed: "失败", cancelled: "已终止" };
  document.getElementById("batchResults").innerHTML = items.map((item, index) => {
    const hasMetrics = hasBatchResultMetrics(item);
    const baseline = item.baseline || {}, baselineReady = baseline.status === "succeeded";
    const cpuTime = Number(item.cpuTimeMs);
    const improvement = Number(item.improvementPercent);
    const improvementText = hasMetrics && baselineReady && Number.isFinite(improvement)
      ? `${improvement >= 0 ? "提升" : "退化"} ${Math.abs(improvement).toFixed(2)}%`
      : baseline.status === "skipped" ? "已跳过基线" : baseline.status && baseline.status !== "succeeded" ? "无有效基线" : "提升 —";
    const summaryError = batchItemErrorText(item);
    const failed = Boolean(summaryError);
    const summaryNote = item.status === "cancelled" ? "调度已终止" : failed ? "" : summaryError;
    const displayId = `t${index + 1}`;
    const itemSelectionId = String(item.testId || `index-${index}`);
    const selected = itemSelectionId === state.selectedBatchTestId;
    return `
      <div class="batch-result ${escapeHtml(item.status || "queued")}${selected ? " selected" : ""}" data-batch-item-index="${index}">
        <div class="batch-result-head">
          <button class="batch-result-title" type="button" aria-pressed="${selected}" aria-label="查看 ${escapeHtml(displayId)} ${escapeHtml(item.testName || "")} 的详细指标"><strong title="${escapeHtml(`${item.testId || ""} · ${item.testName || ""}`)}">${escapeHtml(item.testName || `测试 ${index + 1}`)}</strong></button>
          <div class="batch-result-meta">
            <span class="batch-status">${statusLabels[item.status] || "等待中"}</span>
            ${item.logUrl ? `<a class="btn" href="${escapeHtml(item.logUrl)}" download>日志</a>` : `<span class="btn" aria-disabled="true">日志</span>`}
            ${item.resultUrl ? `<button class="btn primary" type="button" data-workspace-result="${escapeHtml(item.resultUrl)}" data-workspace-name="${escapeHtml(item.testName || `测试 ${index + 1}`)}">工作台</button>` : `<span class="btn" aria-disabled="true">工作台</span>`}
            ${item.ganttUrl ? `<a class="btn" href="${escapeHtml(item.ganttUrl)}" target="_blank">甘特图</a>` : `<span class="btn" aria-disabled="true">甘特图</span>`}
            ${failed ? `<button class="btn danger" type="button" data-batch-error="${index}" aria-label="查看 ${escapeHtml(displayId)} 的报错信息">报错</button>` : ""}
          </div>
        </div>
        <div class="batch-result-summary">
          <div class="batch-metric-tags" aria-label="主要指标">
            <span class="batch-metric-tag makespan" title="Makespan${baselineReady ? `；Baseline ${Number(baseline.makespan).toFixed(2)} s` : ""}">${hasMetrics ? `${Number(item.makespan).toFixed(2)} s` : "— s"}</span>
            <span class="batch-metric-tag ${improvement < 0 ? "loss" : "gain"}">${escapeHtml(improvementText)}</span>
            <span class="batch-metric-tag cpu">CPU Time ${hasMetrics && Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "—"}</span>
          </div>
          ${summaryNote ? `<span class="summary-error" title="${escapeHtml(summaryNote)}">${escapeHtml(summaryNote)}</span>` : ""}
        </div>
      </div>`;
  }).join("");
}

/** 打开批量测试报错信息弹窗，展示完整失败原因（不直接铺在卡片上）。 */
function openBatchErrorDialog(index) {
  const item = state.batchResult?.items?.[index];
  if (!item) return;
  const errorText = batchItemErrorText(item) || "未知错误";
  document.getElementById("batchErrorDialogContext").textContent = `${item.testName || `测试 ${index + 1}`} · ${item.status === "failed" ? "运行失败" : "基线异常"}`;
  document.getElementById("batchErrorDialogContent").textContent = errorText;
  (document.getElementById("batchErrorDialog") as HTMLDialogElement).showModal();
}

/** 生成一个甘特图页面 URL，其中每个成功测试作为独立标签页一次加载。 */
function batchGanttUrl(items) {
  const params = new URLSearchParams();
  items.filter(item => item.resultUrl).forEach(item => {
    params.append("src", item.resultUrl);
    params.append("name", item.testName);
  });
  return params.size ? `/movelist_gantt_viewer.html?${params.toString()}` : "";
}

/** 更新当前批量任务的 ZIP 日志下载入口；执行中可下载已完成测试的日志。 */
function updateBatchLogDownload(result) {
  const button = document.getElementById("batchLogButton");
  const hasLogs = (result.items || []).some(item => item.logUrl);
  if (!result.batchId || !hasLogs) {
    button.href = "#";
    button.setAttribute("aria-disabled", "true");
    return;
  }
  button.href = `/api/run-batches/${encodeURIComponent(result.batchId)}/logs`;
  button.download = `ct-batch-logs-${String(result.batchId).slice(0, 8)}.zip`;
  button.removeAttribute("aria-disabled");
}

/** 汇总批量运行指标，并为每个测试保留甘特图和复现日志入口。 */
function showBatchResult(result) {
  state.batchResult = result;
  updateBatchLogDownload(result);
  document.getElementById("testGroupAnalysisButton").hidden = false;
  if (!state.selectedBatchTestId) showBatchOverviewMetrics(result);
  const resultErrors = result.items.flatMap((item, index) => {
    if (item.status === "failed") {
      return [`t${index + 1} ${item.testName || ""}：${item.error || "运行失败"}`];
    }
    if (item.status === "succeeded" && item.validation && item.validation !== "passed" && item.validation !== "skipped") {
      return [`t${index + 1} ${item.testName || ""}：MoveList 校验 ${validationDisplay(item.validation)}${item.error ? `；${item.error}` : ""}`];
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
  const first = result.items.find(item => item.ganttUrl || item.logUrl);
  if (first) {
    if (first.ganttUrl) {
      const gantt = document.getElementById("ganttButton"); gantt.href = first.ganttUrl; gantt.removeAttribute("aria-disabled");
    }
    if (first.logUrl) {
      const log = document.getElementById("logButton"); log.href = first.logUrl; log.download = first.logFileName; log.removeAttribute("aria-disabled");
    }
  }
  const allGanttUrl = batchGanttUrl(result.items);
  const allGantt = document.getElementById("batchGanttButton");
  if (allGanttUrl) { allGantt.href = allGanttUrl; allGantt.removeAttribute("aria-disabled"); }
}

/** 读取策略诊断中的三项约束结果，供单测试参数实验横向比较。 */
function objectiveComparisonMetrics(result) {
  const diagnostics = [...(result?.rounds || [])].reverse().map(round => round.strategyDiagnostics).find(value => value?.metrics);
  const metrics = diagnostics?.metrics || {};
  return {
    residencyViolationCount: Number(metrics.residencyViolationCount) || 0,
    maximumRobotHoldingSeconds: Number(metrics.maximumRobotHoldingSeconds),
    systemResidenceCv: Number(metrics.systemResidenceCv),
  };
}

/** 格式化对比表格中的数值，避免 NaN 或无约束值造成误读。 */
function comparisonNumber(value, digits = 2, suffix = "") {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : "—";
}

/** 给出候选值相对基准值的差异，并以正负号和比例凸显变化。 */
function comparisonDelta(baselineValue, candidateValue, digits = 2, suffix = "", lowerIsBetter = true) {
  const baseline = Number(baselineValue);
  const candidate = Number(candidateValue);
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return { text: "—", kind: "neutral" };
  const delta = candidate - baseline;
  const sign = delta > 0 ? "+" : "";
  const percent = Math.abs(baseline) > 1e-9 ? ` (${sign}${(delta / baseline * 100).toFixed(1)}%)` : "";
  const kind = delta === 0 ? "neutral" : (lowerIsBetter ? (delta < 0 ? "gain" : "loss") : (delta > 0 ? "gain" : "loss"));
  return { text: `${sign}${delta.toFixed(digits)}${suffix}${percent}`, kind };
}

/** 格式化约束值；0 统一表示不施加该项上限。 */
function comparisonLimit(value, digits = 2, suffix = "") {
  const numeric = Number(value) || 0;
  return numeric > 0 ? `${numeric.toFixed(digits)}${suffix}` : "不限";
}

/** 参数变化只用于说明实验设置，不赋予优劣含义。 */
function comparisonSettingDelta(baselineValue, candidateValue, digits = 2, suffix = "") {
  return { ...comparisonDelta(baselineValue, candidateValue, digits, suffix, false), kind: "neutral" };
}

/** 为一个对比实验生成“基准 / 对比 / 差值”行，直观突出性能与约束差异。 */
function renderParameterComparisonRows(baseline, experiment) {
  const baselineMetrics = objectiveComparisonMetrics(baseline.result);
  const experimentMetrics = objectiveComparisonMetrics(experiment.result);
  const baselineMakespan = Number(baseline.result?.makespan);
  const experimentMakespan = Number(experiment.result?.makespan);
  const strategyChanged = baseline.plan.strategy !== experiment.plan.strategy;
  const rows = [
    ["策略", displayStrategyName(baseline.plan.strategy), displayStrategyName(experiment.plan.strategy), strategyChanged ? "已切换" : "相同", strategyChanged ? "gain" : "neutral"],
    ["驻留余量", comparisonNumber(baseline.options.residencyGuardSeconds, 1, " s"), comparisonNumber(experiment.options.residencyGuardSeconds, 1, " s"), comparisonSettingDelta(baseline.options.residencyGuardSeconds, experiment.options.residencyGuardSeconds, 1, " s")],
    ["持片上限", comparisonLimit(baseline.options.maximumRobotHoldingSeconds, 1, " s"), comparisonLimit(experiment.options.maximumRobotHoldingSeconds, 1, " s"), comparisonSettingDelta(baseline.options.maximumRobotHoldingSeconds, experiment.options.maximumRobotHoldingSeconds, 1, " s")],
    ["CV 上限", comparisonLimit(baseline.options.maximumSystemResidenceCv, 3), comparisonLimit(experiment.options.maximumSystemResidenceCv, 3), comparisonSettingDelta(baseline.options.maximumSystemResidenceCv, experiment.options.maximumSystemResidenceCv, 3)],
    ["Makespan", comparisonNumber(baselineMakespan, 2, " s"), comparisonNumber(experimentMakespan, 2, " s"), comparisonDelta(baselineMakespan, experimentMakespan, 2, " s")],
    ["驻留超限", `${baselineMetrics.residencyViolationCount} 次`, `${experimentMetrics.residencyViolationCount} 次`, comparisonDelta(baselineMetrics.residencyViolationCount, experimentMetrics.residencyViolationCount, 0, " 次")],
    ["实际最大持片", comparisonNumber(baselineMetrics.maximumRobotHoldingSeconds, 2, " s"), comparisonNumber(experimentMetrics.maximumRobotHoldingSeconds, 2, " s"), comparisonDelta(baselineMetrics.maximumRobotHoldingSeconds, experimentMetrics.maximumRobotHoldingSeconds, 2, " s")],
    ["系统停留 CV", comparisonNumber(baselineMetrics.systemResidenceCv, 3), comparisonNumber(experimentMetrics.systemResidenceCv, 3), comparisonDelta(baselineMetrics.systemResidenceCv, experimentMetrics.systemResidenceCv, 3)],
  ];
  return rows.map(([label, base, candidate, delta, kind]) => {
    const deltaValue = typeof delta === "string" ? { text: delta, kind } : delta;
    return `<div class="comparison-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(base)}</strong><strong>${escapeHtml(candidate)}</strong><strong class="comparison-delta ${escapeHtml(deltaValue.kind)}">${escapeHtml(deltaValue.text)}</strong></div>`;
  }).join("");
}

/** 将每条对比实验渲染为可直接读出差值的结果预览区块。 */
function renderParameterComparisonCard(index, baseline, experiment) {
  const makespanDelta = comparisonDelta(baseline.result?.makespan, experiment.result?.makespan, 2, " s");
  const validation = experiment.result?.validation === "passed" ? "校验通过" : experiment.result?.validation === "skipped" ? "校验跳过" : `校验 ${experiment.result?.validation || "未知"}`;
  return `<article class="comparison-experiment">
    <header class="comparison-experiment-head"><div><strong>基准 vs 对比 ${index + 1}</strong><span> ${escapeHtml(displayStrategyName(baseline.plan.strategy))} → ${escapeHtml(displayStrategyName(experiment.plan.strategy))}</span></div><div><span class="comparison-delta ${escapeHtml(makespanDelta.kind)}">Makespan ${escapeHtml(makespanDelta.text)}</span>${experiment.result?.ganttUrl ? `<a class="btn" href="${escapeHtml(experiment.result.ganttUrl)}" target="_blank">甘特图</a>` : ""}</div></header>
    <div class="comparison-table"><div class="comparison-row comparison-row-head"><span>指标</span><strong>基准</strong><strong>对比</strong><strong>差值</strong></div>${renderParameterComparisonRows(baseline, experiment)}</div>
    <small>${escapeHtml(validation)}</small>
  </article>`;
}

/** 显示当前单测试的基准配置，以及其后续运行的策略/参数实验结果。 */
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
  document.getElementById("parameterComparisonBase").textContent = `基准：${displayStrategyName(baseline.plan.strategy)} · ${batchParameterSummary(baseline.options, baseline.plan.strategy)}`;
  document.getElementById("parameterComparisonResults").innerHTML = comparison.variants
    .map((variant, index) => renderParameterComparisonCard(index, baseline, variant)).join("");
}

/** 根据所选策略绘制对比窗口中的策略专属参数。 */
function renderParameterComparisonStrategyFields(strategy, options = {}) {
  const definitions = {
    "loadlock-macro": [["loadLockMacroSearchSeconds", "宏搜索时间（秒）", "number", "0.1"], ["loadLockMacroRollouts", "宏采样次数", "number", "1"]],
  };
  const fields = definitions[strategy] || [];
  document.getElementById("parameterComparisonStrategyOptions").innerHTML = fields.length
    ? `<div class="grid">${fields.map(([key, label, type, step]) => `<div class="field span-4"><label>${escapeHtml(label)}<input data-comparison-option="${escapeHtml(key)}" type="${type}" min="0" step="${step}" value="${escapeHtml(String(options[key] ?? 0))}" required></label></div>`).join("")}</div>`
    : `<div class="hint">该策略没有额外的策略专属参数；上方通用约束参数仍会生效。</div>`;
}

/** 打开策略/参数对比窗口，并以基准配置填充初始值。 */
function openParameterComparisonDialog() {
  const comparison = state.parameterComparison;
  if (!comparison?.baseline) return;
  const baseline = comparison.baseline;
  const strategySelect = document.getElementById("parameterComparisonStrategy");
  const strategies = [...document.querySelectorAll('input[name="strategy"]')]
    .filter(input => !input.disabled || input.value === baseline.plan.strategy)
    .map(input => input.value);
  strategySelect.innerHTML = strategies.map(strategy => `<option value="${escapeHtml(strategy)}">${escapeHtml(displayStrategyName(strategy))}</option>`).join("");
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

/** 读取策略/参数实验输入，拒绝负值和非数值以避免提交无效调度请求。 */
function parameterComparisonOptions() {
  const optionInputs = [
    ["comparisonResidencyGuardSeconds", "residencyGuardSeconds"],
    ["comparisonMaximumRobotHoldingSeconds", "maximumRobotHoldingSeconds"],
    ["comparisonMaximumSystemResidenceCv", "maximumSystemResidenceCv"],
    ["comparisonSeed", "seed"],
  ];
  const options = Object.fromEntries(optionInputs.map(([inputId, optionKey]) => {
    const value = Number(document.getElementById(inputId).value);
    if (!Number.isFinite(value) || value < 0) throw new Error("对比参数必须为大于或等于 0 的数字");
    return [optionKey, value];
  }));
  options.loadLockManager = document.getElementById("comparisonLoadLockManager").value;
  document.querySelectorAll("[data-comparison-option]").forEach(input => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) throw new Error("策略参数必须为大于或等于 0 的数字");
    options[input.dataset.comparisonOption] = value;
  });
  return options;
}

/** 使用基准测试的不可变快照，替换策略和参数后运行一次对比实验。 */
async function runParameterComparison() {
  const comparison = state.parameterComparison;
  if (!comparison?.baseline) throw new Error("请先完成一次单测试运行，再创建参数对比");
  const button = document.getElementById("runParameterComparisonButton");
  const status = document.getElementById("parameterComparisonDialogStatus");
  const overrides = parameterComparisonOptions();
  const plan = structuredClone(comparison.baseline.plan);
  plan.strategy = document.getElementById("parameterComparisonStrategy").value;
  plan.options = { ...plan.options, ...overrides };
  delete plan.workspaceDeviceId;
  delete plan.workspaceTestId;
  button.disabled = true;
  button.textContent = "正在运行对比…";
  status.textContent = "正在提交对比测试，请稍候…";
  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `服务返回 ${response.status}`);
    comparison.variants.push({ plan, options: plan.options, result });
    renderParameterComparison();
    document.getElementById("parameterComparisonDialog").close();
    writeTerminal(`$ 参数对比完成\n  ${displayStrategyName(plan.strategy)} · ${batchParameterSummary(overrides, plan.strategy)}\n  Makespan: ${Number(result.makespan).toFixed(2)} s`);
  } finally {
    button.disabled = false;
    button.textContent = "运行对比测试";
    status.textContent = "";
  }
}

/** 删除服务端已保存的甘特图结果和复现日志，并重置当前结果入口。 */
async function clearExportedArtifacts() {
  if (!window.confirm("将删除全部已导出的结果和复现日志，且无法恢复。是否继续？")) return;
  const button = document.getElementById("clearExportsButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/exports", { method: "DELETE" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "清理失败");
    resetRunResult();
    const deleted = result.deleted || {};
    writeTerminal(`$ 已清理导出数据\n  结果：${Number(deleted.results) || 0} 个\n  复现日志：${Number(deleted.logs) || 0} 个`);
  } catch (error) {
    writeTerminal(`$ 清理导出数据失败\n  ${error.message || "未知错误"}`, true);
  } finally {
    button.disabled = false;
  }
}

/** 显示运行指标和逐轮日志。 */
function showResult(result) {
  state.batchResult = null; state.selectedBatchTestId = "";
  document.getElementById("testGroupAnalysisButton").hidden = true;
  document.getElementById("testGroupAnalysisPanel").hidden = true;
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  const allGantt = document.getElementById("batchGanttButton"); allGantt.href = "#"; allGantt.setAttribute("aria-disabled", "true");
  updateBatchLogDownload({});
  const baseline = result.baseline || {}, baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(result.cpuTimeMs ?? result.totalElapsedMs);
  document.getElementById("metricContext").textContent = "当前测试";
  document.getElementById("batchOverviewButton").hidden = true;
  ["metricTimeDetail", "metricMakespanDetail", "metricMovesDetail", "metricValidationDetail"].forEach(id => { document.getElementById(id).textContent = ""; });
  document.getElementById("metricTimeLabel").textContent = "CPU Time";
  document.getElementById("metricMakespanLabel").textContent = "Makespan / Baseline";
  setBottleneckMetric(result.bottleneckUtilization, "没有足够的资源活动");
  document.getElementById("metricValidationLabel").textContent = "Validation";
  document.getElementById("metricTime").textContent = `${cpuTime.toFixed(1)} ms`;
  document.getElementById("metricMakespan").textContent = `${result.makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "—"} s`;
  const validationValue = validationDisplay(result.validation);
  document.getElementById("metricValidation").textContent = validationValue;
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-success", result.validation === "passed");
  document.getElementById("metricValidation").closest(".metric").classList.toggle("is-error", result.validation !== "passed" && result.validation !== "skipped");
  const objectiveDiagnostics = [...(result.rounds || [])].reverse().map(round => round.strategyDiagnostics).find(diagnostics => diagnostics?.metrics);
  if (objectiveDiagnostics) {
    const metrics = objectiveDiagnostics.metrics;
    document.getElementById("metricValidationLabel").textContent = "Validation / Multi-metric";
    document.getElementById("metricValidationDetail").textContent = `驻留超限 ${Number(metrics.residencyViolationCount) || 0} 次 · 最大持片 ${Number(metrics.maximumRobotHoldingSeconds || 0).toFixed(2)} s · 系统停留 CV ${Number(metrics.systemResidenceCv || 0).toFixed(3)}`;
  }
  const dualActorDiagnostics = (result.rounds || [])
    .map(round => round.strategyDiagnostics)
    .filter(diagnostics => diagnostics?.selectedSource === "dual-actor-e2e");
  if (dualActorDiagnostics.length) {
    const totals = dualActorDiagnostics.reduce((summary, diagnostics) => ({
      atmosphere: summary.atmosphere + (Number(diagnostics.actorDecisionCounts?.atmosphere) || 0),
      vacuum: summary.vacuum + (Number(diagnostics.actorDecisionCounts?.vacuum) || 0),
      pick: summary.pick + (Number(diagnostics.primitiveActionCounts?.pick) || 0),
      place: summary.place + (Number(diagnostics.primitiveActionCounts?.place) || 0),
      swap: summary.swap + (Number(diagnostics.primitiveActionCounts?.swap) || 0),
    }), { atmosphere: 0, vacuum: 0, pick: 0, place: 0, swap: 0 });
    document.getElementById("metricValidationLabel").textContent = "Validation / Dual Actor";
    document.getElementById("metricValidationDetail").textContent = `决策：大气 ${totals.atmosphere} · 真空 ${totals.vacuum}；原子动作：Pick ${totals.pick} · Place ${totals.place} · Swap ${totals.swap}`;
  }
  const baselinePlan = structuredClone(buildPayload());
  state.parameterComparison = {
    baseline: { plan: baselinePlan, options: baselinePlan.options, result },
    variants: [],
  };
  document.getElementById("openParameterComparisonDialogButton").disabled = !state.serviceCompatible;
  renderParameterComparison();
  writeTerminal(["$ 调度完成", ...(result.rounds || []).map(round => {
    if (round.kind === "initial") return `  #${round.index} 首次 | ${round.elapsedMs.toFixed(1)} ms`;
    const request = Number(round.requestedTime);
    const recoveryEnd = Number(round.recoveryEndTime ?? round.effectiveTime);
    const triggerLabel = round.trigger === "cjob-cycle" ? "CJobCycle 补片重算" : "定时重算";
    const timing = Math.abs(recoveryEnd - request) > 1e-6
      ? `@${request}s ${triggerLabel} · 固定旧动作收尾至 @${recoveryEnd}s`
      : `@${request}s ${triggerLabel}`;
    return `  #${round.index} ${timing} | ${round.elapsedMs.toFixed(1)} ms`;
  }), "", ...(result.logs || [])].join("\n"));
  const gantt = document.getElementById("ganttButton"); gantt.href = result.ganttUrl; gantt.removeAttribute("aria-disabled");
}

/** 外部算法失败时展示仍然客观可用的耗时、原始 Makespan 与 Baseline。 */
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
  const makespanText = `${Number.isFinite(makespan) ? makespan.toFixed(2) : "—"} / ${Number.isFinite(baselineMakespan) ? baselineMakespan.toFixed(2) : "—"} s`;
  const comparisonDetail = Number.isFinite(improvement)
    ? `${improvement >= 0 ? "提升" : "退化"} ${Math.abs(improvement).toFixed(2)}% · 结果校验未通过`
    : baseline.status === "skipped"
      ? ""
      : baseline.status && baseline.status !== "succeeded"
        ? `Baseline ${baseline.status === "failed" ? "失败" : "失效"}`
        : "外部算法未返回可比较的完整 Makespan";

  document.getElementById("metricContext").textContent = "当前测试 · 外部算法失败结果";
  document.getElementById("batchOverviewButton").hidden = true;
  setResultMetric("Time", "失败前耗时", Number.isFinite(elapsedTime) ? `${elapsedTime.toFixed(1)} ms` : "—", "从提交到返回失败结果");
  setResultMetric("Makespan", "Makespan / Baseline", makespanText, comparisonDetail);
  setBottleneckMetric(result?.bottleneckUtilization, result?.resultId ? "失败结果没有足够的资源活动" : "未生成可分析的 MoveList");
  setResultMetric("Validation", "Validation", result?.validation === "failed" ? "未通过" : String(result?.validation || "失败"), result?.error || "");
  document.getElementById("metricValidation").closest(".metric").classList.remove("is-success");
  document.getElementById("metricValidation").closest(".metric").classList.add("is-error");
  state.parameterComparison = null;
  document.getElementById("openParameterComparisonDialogButton").disabled = true;
}

/** 正常过程保持界面安静；只有错误才显示可复制的详细信息。 */
function writeTerminal(message, error = false) {
  const panel = document.getElementById("resultErrorPanel");
  const terminal = document.getElementById("terminal");
  if (!error) {
    terminal.textContent = "";
    panel.hidden = true;
    return;
  }
  terminal.textContent = String(message || "未知错误").replace(/^\$\s*/, "");
  panel.hidden = false;
}

/** 检查本地服务以及内置策略模型可用性。 */
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
    batchRunButton.disabled = !compatible || singleRunActive || (state.batchRunning && state.batchCancelRequested);
    comparisonButton.disabled = !compatible || state.batchRunning || !state.parameterComparison?.baseline;
    document.getElementById("stepRunButton").disabled = stepRunActive
      ? false
      : !compatible || state.strategy !== "schedule-alphago";
    renderWorkspaceControls();
    pill.textContent = compatible ? "本地服务已连接" : "服务版本过旧";
    if (!compatible) {
      pill.style.color = "var(--red)"; pill.style.background = "var(--red-soft)";
      writeTerminal("$ 本地服务版本过旧\n  请重启: py scripts/config_editor_server.py", true);
    }
  }
  catch {
    state.serviceCompatible = false;
    runButton.disabled = true;
    batchRunButton.disabled = true;
    comparisonButton.disabled = true;
    document.getElementById("stepRunButton").disabled = true;
    renderWorkspaceControls();
    pill.textContent = "本地服务未连接";
    pill.style.color = "var(--red)";
    pill.style.background = "var(--red-soft)";
    writeTerminal("$ 无法连接本地服务\n  请运行: py scripts/config_editor_server.py", true);
  }
}

document.getElementById("workspaceDialogCancel").addEventListener("click", () => document.getElementById("workspaceDialog").close("cancel"));
const batchErrorDialog = document.getElementById("batchErrorDialog") as HTMLDialogElement;
document.getElementById("batchErrorDialogClose").addEventListener("click", () => batchErrorDialog.close());
document.getElementById("batchErrorDialogConfirm").addEventListener("click", () => batchErrorDialog.close());
document.getElementById("batchErrorDialogCopy").addEventListener("click", async () => {
  const content = document.getElementById("batchErrorDialogContent")?.textContent || "";
  try { await navigator.clipboard.writeText(content); } catch { /* 剪贴板不可用时静默忽略 */ }
});
batchErrorDialog.addEventListener("click", event => { if (event.target === batchErrorDialog) batchErrorDialog.close(); });
document.getElementById("cleanDialogCancel").addEventListener("click", () => {
  document.getElementById("cleanDialog").close();
  state.cleanDialogContext = null;
});
document.getElementById("cleanDialog").addEventListener("close", () => { state.cleanDialogContext = null; });
document.getElementById("pjobRouteDialogClose").addEventListener("click", () => closePJobRoutePicker());
document.getElementById("pjobRouteDialog").addEventListener("cancel", event => { event.preventDefault(); closePJobRoutePicker(); });
document.getElementById("pjobRouteDialog").addEventListener("click", event => { if (event.target.id === "pjobRouteDialog") closePJobRoutePicker(); });
const bottleneckAnalysisHelpDialog = document.getElementById("bottleneckAnalysisHelpDialog") as HTMLDialogElement;
document.getElementById("bottleneckAnalysisHelpDialogClose").addEventListener("click", () => bottleneckAnalysisHelpDialog.close());
const residenceAnalysisHelpDialog = document.getElementById("residenceAnalysisHelpDialog") as HTMLDialogElement;
document.getElementById("residenceAnalysisHelpDialogClose").addEventListener("click", () => residenceAnalysisHelpDialog.close());
document.getElementById("visualPerformance").addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("#bottleneckAnalysisHelpButton") && !bottleneckAnalysisHelpDialog.open) {
    bottleneckAnalysisHelpDialog.showModal();
  }
  if (event.target.closest("#residenceAnalysisHelpButton") && !residenceAnalysisHelpDialog.open) {
    residenceAnalysisHelpDialog.showModal();
  }
});
document.getElementById("visualPerformance").addEventListener("change", event => {
  const select = event.target instanceof HTMLSelectElement && event.target.id === "residenceMetricSelect"
    ? event.target
    : null;
  if (!select) return;
  const performancePanel = event.currentTarget;
  if (!(performancePanel instanceof HTMLElement)) return;
  const selectedMetric = select.value;
  performancePanel.querySelectorAll<HTMLElement>("[data-residence-metric-chart]").forEach(chart => {
    chart.hidden = chart.dataset.residenceMetricChart !== selectedMetric;
  });
  performancePanel.querySelectorAll<HTMLElement>("[data-residence-summary]").forEach(summary => {
    summary.hidden = summary.dataset.residenceSummary !== selectedMetric;
  });
});
document.getElementById("bottleneckAnalysisHelpDialog").addEventListener("click", event => {
  if (event.target === bottleneckAnalysisHelpDialog) bottleneckAnalysisHelpDialog.close();
});
document.getElementById("residenceAnalysisHelpDialog").addEventListener("click", event => {
  if (event.target === residenceAnalysisHelpDialog) residenceAnalysisHelpDialog.close();
});
document.getElementById("pjobRouteProcess").addEventListener("change", event => renderPJobRouteDialogGroup(event.target.value));
document.getElementById("pjobRouteParallel").addEventListener("change", event => renderPJobRouteDialogGroup(pjobRoutePickerContext?.processKey, event.target.value));
document.getElementById("routeProcessFilter").addEventListener("change", event => {
  state.routeProcessFilter = event.target.value;
  state.routeParallelFilter = "";
  renderRoutes();
});
document.getElementById("routeParallelFilter").addEventListener("change", event => {
  state.routeParallelFilter = event.target.value;
  renderRoutes();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.getElementById("pjobRouteDialog").open && !document.getElementById("drawerLayer").open) {
    event.preventDefault();
    closePJobRoutePicker();
  }
});
document.getElementById("cleanPlacement").addEventListener("change", updateCleanDialogFields);
document.getElementById("cleanType").addEventListener("change", updateCleanDialogFields);
document.getElementById("cleanDialogForm").addEventListener("submit", event => {
  event.preventDefault();
  saveCleanDialog();
});
document.getElementById("workspaceImportButton").addEventListener("click", () => openDataTransferDialog("import"));
document.getElementById("workspaceExportButton").addEventListener("click", () => openDataTransferDialog("export"));
document.getElementById("dataTransferDialogClose").addEventListener("click", () => (document.getElementById("dataTransferDialog") as HTMLDialogElement).close());
document.getElementById("deviceTransferOption").addEventListener("click", () => chooseDataTransfer("device"));
document.getElementById("testTransferOption").addEventListener("click", () => chooseDataTransfer("test"));
document.getElementById("dataTransferDialog").addEventListener("click", event => {
  if (event.target === document.getElementById("dataTransferDialog")) (event.target as HTMLDialogElement).close();
});
document.getElementById("deviceFile").addEventListener("change", event => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const operation = file.name.toLowerCase().endsWith(".json") ? loadDevice(file) : uploadWorkspaceArchive(file, "device");
  operation.catch(error => {
    const status = document.getElementById("dataTransferStatus");
    status.textContent = error.message || "设备导入失败";
    status.classList.add("error");
    writeTerminal(`$ 设备读取失败\n  ${error.message}`, true);
  });
});
document.getElementById("testExchangeFile").addEventListener("change", event => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  uploadWorkspaceArchive(file, "test").catch(error => {
    const status = document.getElementById("dataTransferStatus");
    status.textContent = error.message || "测试集导入失败";
    status.classList.add("error");
    writeTerminal(`$ 测试集导入失败\n  ${error.message}`, true);
  });
});
document.getElementById("addAlgorithmButton").addEventListener("click", () => document.getElementById("addAlgorithmFileInput").click());
document.getElementById("addAlgorithmFileInput").addEventListener("change", event => {
  const input = event.currentTarget;
  const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
  if (input instanceof HTMLInputElement) input.value = "";
  if (!file) return;
  registerAlgorithmFile(file).catch(error => writeTerminal(`$ 添加算法失败\n  ${error.message || "未知错误"}`, true));
});
document.getElementById("deviceSelect").addEventListener("change", event => (async () => {
  if (state.dirty) await saveCurrentTest(true);
  if (state.deviceTimingDirty) await saveDeviceTiming();
  await selectWorkspaceDevice(event.target.value);
})().catch(error => writeTerminal(`$ 设备切换失败\n  ${error.message}`, true)));
document.getElementById("deleteDeviceButton").addEventListener("click", () => deleteWorkspaceDevice().catch(error => { setWorkspaceStatus(`删除设备失败：${error.message}`, "dirty"); writeTerminal(`$ 删除设备失败\n  ${error.message}`, true); }));
document.getElementById("saveDeviceTimingButton").addEventListener("click", () => saveDeviceTiming().catch(error => writeTerminal(`$ 设备时间保存失败\n  ${error.message}`, true)));
document.getElementById("resetDeviceTimingButton").addEventListener("click", () => resetDeviceTimingDraft("已撤销尚未保存的时间修改"));
document.getElementById("deviceStationSelect").addEventListener("change", event => {
  state.deviceStationName = event.target.value;
  renderDeviceStationTiming();
});
document.getElementById("deviceRobotSelect").addEventListener("change", event => {
  state.deviceRobotName = event.target.value;
  renderDeviceRobotTiming();
});
document.getElementById("testGroupSelect").addEventListener("change", event => selectWorkspaceGroup(event.target.value).catch(error => writeTerminal(`$ 测试组别切换失败\n  ${error.message}`, true)));
document.getElementById("testCaseSelect").addEventListener("change", event => selectWorkspaceTest(event.target.value).catch(error => writeTerminal(`$ 测试集切换失败\n  ${error.message}`, true)));
document.getElementById("testCaseName").addEventListener("input", event => { state.testCaseName = event.target.value; markTestDirty(); });
document.getElementById("newGroupButton").addEventListener("click", () => createTestGroup().catch(error => writeTerminal(`$ 新建测试组别失败\n  ${error.message}`, true)));
document.getElementById("renameGroupButton").addEventListener("click", () => renameCurrentTestGroup().catch(error => { setWorkspaceStatus(`重命名测试组别失败：${error.message}`, "dirty"); writeTerminal(`$ 重命名测试组别失败\n  ${error.message}`, true); }));
document.getElementById("deleteGroupButton").addEventListener("click", () => deleteCurrentTestGroup().catch(error => { setWorkspaceStatus(`删除测试组别失败：${error.message}`, "dirty"); writeTerminal(`$ 删除测试组别失败\n  ${error.message}`, true); }));
document.getElementById("newTestButton").addEventListener("click", () => createTestCase(false).catch(error => writeTerminal(`$ 新建测试集失败\n  ${error.message}`, true)));
document.getElementById("emptyGroupNewTestButton").addEventListener("click", () => createTestCase(false).catch(error => writeTerminal(`$ 新建测试集失败\n  ${error.message}`, true)));
document.getElementById("copyTestButton").addEventListener("click", () => createTestCase(true).catch(error => writeTerminal(`$ 复制测试集失败\n  ${error.message}`, true)));
document.getElementById("saveTestButton").addEventListener("click", () => saveCurrentTest(false).catch(error => writeTerminal(`$ 保存测试集失败\n  ${error.message}`, true)));
document.getElementById("deleteTestButton").addEventListener("click", () => deleteCurrentTest().catch(error => writeTerminal(`$ 删除测试集失败\n  ${error.message}`, true)));
document.getElementById("roundCount").addEventListener("input", event => { resizeRounds(event.target.value); markTestDirty(); });
document.getElementById("runButton").addEventListener("click", runPlan);
document.getElementById("stepRunButton").addEventListener("click", runModelStepped);
document.getElementById("batchRunButton").addEventListener("click", runCurrentTestGroup);
document.getElementById("openParameterComparisonDialogButton").addEventListener("click", openParameterComparisonDialog);
document.getElementById("parameterComparisonDialogCancel").addEventListener("click", () => document.getElementById("parameterComparisonDialog").close());
document.getElementById("openScheduleAlphaGoOptionsDialogButton").addEventListener("click", openScheduleAlphaGoOptionsDialog);
document.getElementById("scheduleAlphaGoOptionsDialogCancel").addEventListener("click", () => document.getElementById("scheduleAlphaGoOptionsDialog").close());
document.getElementById("alphaGoCheckpointFile").addEventListener("change", event => {
  pendingAlphaGoCheckpointFile = event.currentTarget.files?.[0] || null;
  if (!pendingAlphaGoCheckpointFile) return;
  document.getElementById("alphaGoCheckpointPath").value = pendingAlphaGoCheckpointFile.name;
  document.getElementById("alphaGoCheckpointHint").textContent = `已选择“${pendingAlphaGoCheckpointFile.name}”；保存参数时上传。`;
});
document.getElementById("clearAlphaGoCheckpointButton").addEventListener("click", () => {
  pendingAlphaGoCheckpointFile = null;
  document.getElementById("alphaGoCheckpointFile").value = "";
  document.getElementById("alphaGoCheckpointPath").value = "";
  document.getElementById("alphaGoCheckpointHint").textContent = "保存后将使用默认模型或冷启动模型。";
});
document.getElementById("scheduleAlphaGoOptionsForm").addEventListener("submit", event => {
  event.preventDefault();
  saveScheduleAlphaGoOptions().catch(error => {
    document.getElementById("alphaGoCheckpointHint").textContent = error.message || "参数保存失败";
  });
});
document.getElementById("parameterComparisonStrategy").addEventListener("change", event => {
  const baselineOptions = state.parameterComparison?.baseline?.options || {};
  renderParameterComparisonStrategyFields(event.target.value, baselineOptions);
});
document.getElementById("parameterComparisonForm").addEventListener("submit", event => {
  event.preventDefault();
  runParameterComparison().catch(error => {
    document.getElementById("parameterComparisonDialogStatus").textContent = error.message || "未知错误";
    writeTerminal(`$ 参数对比失败\n  ${error.message || "未知错误"}`, true);
  });
});
document.getElementById("clearExportsButton").addEventListener("click", clearExportedArtifacts);
document.getElementById("batchOverviewButton").addEventListener("click", showCurrentBatchOverview);
document.getElementById("testGroupAnalysisButton").addEventListener("click", () => {
  showTestGroupAnalysis().catch(error => writeTerminal(`$ 测试组结果分析失败\n  ${error.message || "未知错误"}`, true));
});
document.getElementById("logButton").addEventListener("click", event => { if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault(); });
document.getElementById("ganttButton").addEventListener("click", event => { if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault(); });
document.getElementById("batchLogButton").addEventListener("click", event => { if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault(); });
document.getElementById("batchGanttButton").addEventListener("click", event => { if (event.currentTarget.getAttribute("aria-disabled") === "true") event.preventDefault(); });
document.getElementById("searchTelemetryDecisionSelect").addEventListener("change", event => {
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
// 步进模式下点击候选行提交该动作；事件委托在容器上，避免每次重渲染重复绑定。
// 只响应可交互（role="button"）的候选行，防止搜索中的误点被静默预选。
document.getElementById("visualDecisionLens").addEventListener("click", event => {
  const candidate = event.target.closest?.("[data-action-key][role='button']");
  if (!candidate) return;
  void chooseSearchAction(candidate.dataset.actionKey);
});
document.getElementById("visualDecisionLens").addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const candidate = event.target.closest?.("[data-action-key][role='button']");
  if (!candidate) return;
  event.preventDefault();
  void chooseSearchAction(candidate.dataset.actionKey);
});
document.getElementById("closeDrawer").addEventListener("click", closeStepDrawer);
document.getElementById("drawerLayer").addEventListener("click", event => { if (event.target.id === "drawerLayer") closeStepDrawer(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") closeStepDrawer(); });
document.addEventListener("keydown", event => { const card = event.target.closest?.("[data-step-card]"); if (card && event.key === "Enter") openPJobStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex)); });
document.addEventListener("input", event => {
  if (event.target.matches("[data-device-timing-target]")) updateDeviceTimingFromControl(event.target);
  if (event.target.matches("[data-scope], [data-option], [data-time-index], [data-round-time-index]")) updateStateFromControl(event.target);
});
document.addEventListener("change", event => {
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
    if (["name", "cleanType", "recipeTime", "wacRecipeTime", "jobType", "waferCount", "bufferOption", ...ROUTE_CLEAN_KEYS].includes(event.target.dataset.key) || event.target.dataset.timeIndex !== undefined || event.target.dataset.roundTimeIndex !== undefined || ["stage-candidates", "cjob", "pjob"].includes(event.target.dataset.scope)) renderAll();
    else if (state.drawer) { renderRoutes(); renderStepDrawer(); }
    else if (["test-step", "test-route"].includes(event.target.dataset.scope)) renderRounds();
  }
  if (event.target.name === "strategy") {
    state.strategy = event.target.value;
    const algorithm = state.availableAlgorithms.find(item => item.strategy === state.strategy);
    if (algorithm?.defaultOptions && typeof algorithm.defaultOptions === "object") {
      Object.assign(state.options, algorithm.defaultOptions);
    }
    retainSessionSchedulingConfiguration();
    document.getElementById("roundCount").disabled = false;
    updateStrategyOptionVisibility();
    showAlgorithmDetails(state.strategy);
    // 运行期保持“停止”入口可用；非运行期才按策略/服务状态禁用。
    document.getElementById("stepRunButton").disabled = stepRunActive
      ? false
      : !state.serviceCompatible || state.strategy !== "schedule-alphago";
    markTestDirty(); renderAll();
  }
});
document.addEventListener("click", event => {
  const tab = event.target.closest("[data-tab-target]"); if (tab) switchTab(tab.dataset.tabTarget);
  const deviceConfigSection = event.target.closest("[data-device-config-section]");
  if (deviceConfigSection) {
    switchDeviceConfigSection(deviceConfigSection.dataset.deviceConfigSection);
    return;
  }
  const robotSlotChoice = event.target.closest("[data-robot-slot-name][data-robot-arm-count]");
  if (robotSlotChoice && !robotSlotChoice.disabled) {
    setRobotArmCount(robotSlotChoice.dataset.robotSlotName, Number(robotSlotChoice.dataset.robotArmCount))
      .catch(error => writeTerminal(`$ 机器手槽位保存失败\n  ${error.message}`, true));
    return;
  }
  const robotSlotDefault = event.target.closest("[data-robot-slot-default]");
  if (robotSlotDefault && !robotSlotDefault.disabled) {
    restoreRobotSlotDefault(robotSlotDefault.dataset.robotSlotDefault)
      .catch(error => writeTerminal(`$ 机器手默认配置恢复失败\n  ${error.message}`, true));
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
    visualizationWorkspace.loadResult(workspaceResult.dataset.workspaceResult, workspaceResult.dataset.workspaceName)
      .then(() => visualizationWorkspace.show())
      .catch(error => writeTerminal(`$ 工作台加载失败\n  ${error.message || "未知错误"}`, true));
    return;
  }
  const button = event.target.closest("[data-action]"); if (button && !button.disabled) { handleAction(button); return; }
  const card = event.target.closest("[data-step-card]"); if (card) openPJobStepDrawer(Number(card.dataset.routeIndex), Number(card.dataset.stageIndex));
});
window.addEventListener("pagehide", () => {
  if (state.deviceTimingDirty && state.workspaceDeviceId && state.deviceTimingDraft) {
    fetch(`/api/workspaces/${state.workspaceDeviceId}/device-timing`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timing: state.deviceTimingDraft }), keepalive: true,
    }).catch(() => {});
  }
  if (state.dirty && state.workspaceDeviceId && state.testCaseId) {
    fetch(`/api/workspaces/${state.workspaceDeviceId}/tests/${state.testCaseId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentTestSnapshot()), keepalive: true,
    }).catch(() => {});
  }
});

initializeCompactSelects();
renderAll(); renderWorkspaceControls(); renderDeviceTimingConfiguration(); checkService(); loadWorkspaceCatalog().catch(error => setWorkspaceStatus(`测试集读取失败：${error.message}`, "dirty"));
