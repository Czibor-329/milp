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
  exampleRouteSpecs: () => exampleRouteSpecs,
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
  const counts = processStages.map(
    (stage) => new Set((stage.visits || []).map((visit) => visit.stationName).filter(Boolean)).size
  );
  const candidatePath = processStages.map((stage) => [...new Set((stage.visits || []).map((visit) => visit.stationName).filter(Boolean))].join("/") || "\u672A\u9009\u62E9\u8154\u5BA4");
  const processTimes = processStages.map(
    (stage) => Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0)
  );
  const processCount = processStages.length;
  return {
    processCount,
    counts,
    candidatePath,
    processTimes,
    label: processCount === 0 ? "\u65E0\u52A0\u5DE5\u5DE5\u5E8F" : `${processCount}\u9053\u5DE5\u5E8F`,
    key: String(processCount)
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
function automaticRouteName(profile, cleanSignature = "") {
  const processName = profile.processCount === 0 ? "\u65E0\u52A0\u5DE5\u5DE5\u5E8F" : profile.candidatePath.map(
    (path, index) => `${path}(${formatSeconds(profile.processTimes[index])})`
  ).join(" \u2192 ");
  return cleanSignature ? `${processName} \xB7 ${cleanSignature}` : processName;
}
var EXAMPLE_ROUTE_SPECS = [
  ...[["PM1"], ["PM1", "PM2"], ["PM1", "PM2", "PM3"], ["PM1", "PM2", "PM3", "PM4"]].flatMap((candidates) => [40, 80, 120].map((time) => ({ candidates: [candidates], times: [time] }))),
  { candidates: [["PM1"], ["PM2"]], times: [40, 60] },
  { candidates: [["PM1", "PM2"], ["PM3", "PM4"]], times: [40, 80] },
  { candidates: [["PM1", "PM2"], ["PM3", "PM4"]], times: [60, 100] },
  { candidates: [["PM1", "PM2"], ["PM3", "PM4"]], times: [80, 120] },
  { candidates: [["PM1"], ["PM2", "PM3", "PM4"]], times: [40, 120] },
  { candidates: [["PM1", "PM2", "PM3"], ["PM4"]], times: [60, 100] },
  { candidates: [["PM1"], ["PM2"], ["PM3", "PM4"]], times: [40, 60, 80] },
  { candidates: [["PM1"], ["PM2"], ["PM3", "PM4"]], times: [60, 80, 100] },
  { candidates: [["PM1"], ["PM2"], ["PM3", "PM4"]], times: [80, 100, 120] },
  { candidates: [["PM1", "PM2"], ["PM3"], ["PM4"]], times: [40, 80, 120] },
  { candidates: [["PM1"], ["PM2", "PM3"], ["PM4"]], times: [40, 100, 120] }
];
function exampleRouteSpecs() {
  return structuredClone(EXAMPLE_ROUTE_SPECS);
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
function enumName(value, names, fallback) {
  if (names.includes(String(value))) return String(value);
  const numeric = Number(value);
  if (names === CJOB_TYPES) {
    return { 0: "NormalLot", 2: "HighestLot", 3: "HigherLot" }[numeric] || fallback;
  }
  return { 0: "Smart", 1: "Pipeline", 2: "Sequential", 3: "Concurrent" }[numeric] || fallback;
}
function normalizePJob(raw, index, taskId) {
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
    loadPort: source.loadPort || source.LoadPort || "",
    priority: Math.max(1, Number(source.priority ?? source.Priority) || 1)
  };
}
function normalizeRound(raw, roundIndex, fallbackTime) {
  const taskId = String(roundIndex);
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
    const rawPJobs = Array.isArray(cjob.pjobs) && cjob.pjobs.length ? cjob.pjobs : [{}];
    const pjobs = rawPJobs.map(
      (pjob, pjobIndex) => normalizePJob(pjob, pjobIndex + 1, taskId)
    );
    const jobType = enumName(cjob.jobType, CJOB_TYPES, "NormalLot");
    return {
      key: cjob.key || `C${cjobIndex + 1}`,
      taskId,
      jobType,
      priority: jobType === "NormalLot" ? Math.max(1, Number(cjob.priority) || 1) : -1,
      taskMode: enumName(cjob.taskMode, TASK_MODES, "Smart"),
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
  deviceName: "",
  device: null,
  stationNames: [],
  loadPorts: [],
  processModules: [],
  robotNames: [],
  robotScopes: {},
  strategy: "heuristic",
  availableOtherAlgorithms: [],
  roundCount: 2,
  times: [0, 70],
  options: { loadLockManager: "petri-look", loadLockExchange: "auto", rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 },
  cleans: [],
  routes: [{ name: "RouteA", group: "RouteA", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps([makeStage("LP1"), makeStage("Robot"), makeStage("PM1,PM2", true, "RouteA_Step2"), makeStage("Robot"), makeStage("LP1")]) }],
  rounds: [makeRound(1, 0, "RouteA", "LP1"), makeRound(2, 70, "RouteA", "LP2")],
  drawer: null,
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
  const occupied = new Set(state.cleans.map((clean) => clean.name));
  let suffix = state.cleans.length + 1;
  while (occupied.has(`Clean${suffix}`)) suffix += 1;
  return normalizeClean({ name: `Clean${suffix}`, cleanType, recipeTime: 20, triggerCount: 5, wacRecipeTime: 20 });
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
function makeExampleRoute(spec, catalogIndex) {
  const prefix = `AutoRoute${catalogIndex + 1}`;
  const stages = [makeStage(state.loadPorts[0] || "LP1"), makeStage("ATR"), makeStage(["LA", "LB"]), makeStage("VTR")];
  spec.candidates.forEach((candidates, processIndex) => {
    const processStage = makeStage(candidates, true, `${prefix}_Step${processIndex + 1}`);
    processStage.visits.forEach((visit) => {
      visit.processTime = Number(spec.times[processIndex]);
      visit.recipeTime = Number(spec.times[processIndex]);
    });
    stages.push(processStage, makeStage("VTR"));
  });
  stages.push(makeStage(["LA", "LB"]), makeStage("ATR"), makeStage(state.loadPorts[0] || "LP1"));
  return { name: prefix, group: "\u81EA\u52A8\u793A\u4F8B", bufferOption: 0, prePJobCleanRefs: [], postPJobCleanRefs: [], postCJobCleanRefs: [], stages: linkRouteSteps(stages) };
}
function generateExampleRoutes() {
  const hasPse300Topology = ["PM1", "PM2", "PM3", "PM4"].every((name) => state.processModules.includes(name)) && ["LA", "LB"].every((name) => state.stationNames.includes(name)) && ["ATR", "VTR"].every((name) => state.robotNames.includes(name));
  if (!hasPse300Topology) return null;
  const existing = new Set(state.routes.map((route) => generatedRouteName(route)));
  let added = 0;
  exampleRouteSpecs().forEach((spec, catalogIndex) => {
    const route = makeExampleRoute(spec, catalogIndex);
    const signature = generatedRouteName(route);
    if (existing.has(signature)) return;
    existing.add(signature);
    state.routes.push(route);
    added += 1;
  });
  return added;
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
  linkRouteSteps(route.stages);
  route.stages.forEach((stage, index) => {
    stage.visits = Array.isArray(stage.visits) ? stage.visits : [];
    stage.kind = stageUsesRobot(stage, index) ? "robot" : "station";
    stage.needProcess = stage.kind === "station" && stage.visits.some((visit) => state.processModules.includes(visit.stationName));
    const recipeName = stage.needProcess ? `${route.group || route.name || "Route"}_Step${stage.stepId}` : "";
    stage.visits.forEach((visit) => normalizeVisit(visit, recipeName));
  });
  return route;
}
function visitDifferenceFields(stage) {
  return differenceFields(stage, normalizeVisit);
}
function synchronizeStageVisits(stage) {
  synchronizeVisits(stage, normalizeVisit);
}
function setStageCandidates(routeIndex, stageIndex, names) {
  const route = state.routes[routeIndex], stage = route.stages[stageIndex];
  replaceCandidates(stage, names, makeVisit, normalizeVisit);
  normalizeRoute(route);
}
function normalizeRounds() {
  state.rounds = state.rounds.map((round, index) => normalizeRound(round, index + 1, state.times[index]));
  let nextMaterialId = 1;
  state.rounds.forEach((round) => round.cjobs.forEach((cjob) => cjob.pjobs.forEach((pjob) => {
    pjob.matList = Array.from({ length: pjob.waferCount }, () => nextMaterialId++);
  })));
  state.times = state.rounds.map((round) => Number(round.currentTime));
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}
function optionsHtml(values, selected, emptyLabel = "\u8BF7\u9009\u62E9") {
  return `<option value="">${escapeHtml(emptyLabel)}</option>` + values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}
function multiOptionsHtml(values, selected) {
  const chosen = new Set(stringList(selected));
  return values.map((value) => `<option value="${escapeHtml(value)}" ${chosen.has(value) ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
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
    options: { loadLockManager: "petri-look", loadLockExchange: "auto", rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 },
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
  deviceSelect.innerHTML = state.workspaceDevices.length ? state.workspaceDevices.map((device) => `<option value="${escapeHtml(device.id)}" ${device.id === state.workspaceDeviceId ? "selected" : ""}>${escapeHtml(displayDeviceName(device.name))}</option>`).join("") : `<option value="">\u5C1A\u672A\u5BFC\u5165\u8BBE\u5907</option>`;
  const natural = (left, right) => left.localeCompare(right, void 0, { numeric: true });
  const groups = [.../* @__PURE__ */ new Set(["", ...state.workspaceDevice?.testGroups || [], ...tests.map((test) => String(test.group || "").trim())])].sort((left, right) => !left - !right || natural(left, right));
  const selectedGroup = groups.includes(state.activeTestGroup) ? state.activeTestGroup : groups[0] || "";
  const groupSelect = document.getElementById("testGroupSelect");
  groupSelect.innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml(group)}" title="${escapeHtml(group || "\u672A\u5206\u7EC4")}" ${group === selectedGroup ? "selected" : ""}>${escapeHtml(group || "\u672A\u5206\u7EC4")}</option>`).join("") : `<option value="">\u672A\u5206\u7EC4</option>`;
  groupSelect.title = selectedGroup || "\u672A\u5206\u7EC4";
  groupSelect.disabled = !state.workspaceDeviceId;
  const testSelect = document.getElementById("testCaseSelect");
  const visibleTests = tests.filter((test) => String(test.group || "").trim() === selectedGroup).sort((left, right) => natural(left.name, right.name));
  testSelect.innerHTML = visibleTests.length ? visibleTests.map((test) => `<option value="${escapeHtml(test.id)}" title="${escapeHtml(test.name)}" ${test.id === state.testCaseId ? "selected" : ""}>${escapeHtml(test.name)}</option>`).join("") : `<option value="">\u8BE5\u7EC4\u6682\u65E0\u6D4B\u8BD5</option>`;
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
  document.getElementById("deviceSummary").innerHTML = state.device ? `<span class="chip good">${escapeHtml(deviceType)}</span>` : `<span class="chip">\u5C1A\u672A\u9009\u62E9\u8BBE\u5907</span>`;
}
function setWorkspaceStatus(message, kind = "") {
  const status = document.getElementById("workspaceStatus");
  status.textContent = message;
  status.className = `span-12 workspace-status ${kind}`.trim();
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
  ["metricTime", "metricMakespan", "metricMoves", "metricValidation"].forEach((id) => {
    document.getElementById(id).textContent = "\u2014";
  });
  document.getElementById("metricTimeLabel").textContent = "\u603B\u8017\u65F6";
  document.getElementById("metricMakespanLabel").textContent = "Makespan";
  document.getElementById("metricMovesLabel").textContent = "Move \u6570";
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
  state.options = value.options || { loadLockManager: "petri-look", loadLockExchange: "auto", rlSearchSeconds: 4, rlRollouts: 256, rlTemperature: 0.7, milpTimeLimit: 120, seed: 0 };
  state.options.loadLockManager = state.options.loadLockManager || "petri-look";
  state.options.loadLockExchange = state.options.loadLockExchange || "auto";
  state.options.milpTimeLimit = Number(state.options.milpTimeLimit) || 120;
  if (!state.routes.length && Array.isArray(value.routes)) state.routes = value.routes;
  if (!state.cleans.length && Array.isArray(value.cleans)) state.cleans = value.cleans.map(normalizeClean);
  state.routes.forEach(normalizeRoute);
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
  const routeNamesChanged = synchronizeRouteNames();
  state.dirty = routeNamesChanged;
  document.getElementById("roundCount").value = state.roundCount;
  document.querySelectorAll('input[name="strategy"]').forEach((input) => {
    input.checked = input.value === state.strategy;
  });
  document.querySelectorAll("[data-option]").forEach((input) => {
    input.value = state.options[input.dataset.option] ?? input.value;
  });
  document.getElementById("loadlockOptions").classList.toggle("is-hidden", !["heuristic", "neural", "rl"].includes(state.strategy));
  document.getElementById("rlOptions").classList.toggle("is-hidden", state.strategy !== "rl");
  document.getElementById("milpOptions").classList.toggle("is-hidden", state.strategy !== "milp");
  document.getElementById("roundCount").disabled = state.strategy === "milp";
  renderAll();
  renderWorkspaceControls();
  resetRunResult();
  if (routeNamesChanged) {
    setWorkspaceStatus("\u6B63\u5728\u4FDD\u5B58\u81EA\u52A8\u751F\u6210\u7684 Route \u540D\u79F0\u2026", "dirty");
    scheduleAutoSave();
  } else setWorkspaceStatus(`\u5DF2\u8F7D\u5165\u201C${state.testCaseName}\u201D`, "saved");
}
function currentTestSnapshot(name = state.testCaseName) {
  normalizeRounds();
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
async function importL2dCheckpoint(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pt")) throw new Error("\u8BF7\u9009\u62E9 .pt checkpoint \u6587\u4EF6");
  if (file.size > 8 * 1024 * 1024) throw new Error("checkpoint \u4E0D\u80FD\u8D85\u8FC7 8MB");
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const result = await requestJson("/api/models/l2d", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: String(dataUrl).split(",", 2)[1] || "" })
  });
  document.getElementById("l2dCheckpointFile").value = "";
  await checkService();
  writeTerminal(`$ \u5DF2\u5BFC\u5165 L2D checkpoint
  ${result.model.filename} \xB7 ${result.model.phase}`);
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
  state.cleans = state.cleans.map(normalizeClean);
  host.innerHTML = CLEAN_TYPE_DEFINITIONS.map((type) => {
    const rows = state.cleans.map((clean, index) => ({ clean, index })).filter((item) => item.clean.cleanType === type.key);
    const open = state.expandedCleanTypes.has(type.key);
    const cards = rows.map(({ clean, index }) => {
      const conditional = clean.cleanType === "wacclean" ? `<div class="field"><label>\u89E6\u53D1\u6B21\u6570</label><input type="number" min="1" step="1" data-scope="clean" data-index="${index}" data-key="triggerCount" value="${Number(clean.triggerCount)}"></div>` : clean.cleanType === "dummywac" ? `<div class="field"><label>WAC \u6E05\u6D01\u957F\u5EA6\uFF08\u79D2\uFF09</label><input type="number" min="0" step="0.1" data-scope="clean" data-index="${index}" data-key="wacRecipeTime" value="${Number(clean.wacRecipeTime)}"></div>` : "";
      return `<article class="clean-card"><div class="clean-card-title"><strong>${escapeHtml(clean.name)}</strong><button class="btn danger small" data-action="remove-clean" data-index="${index}">\u5220\u9664</button></div><div class="clean-fields">
        <div class="field"><label>\u6E05\u6D01\u7C7B\u522B</label><select data-scope="clean" data-index="${index}" data-key="cleanType">${CLEAN_TYPE_DEFINITIONS.map((option) => `<option value="${option.key}" ${option.key === clean.cleanType ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></div>
        <div class="field"><label>\u6E05\u6D01\u65F6\u95F4\uFF08\u79D2\uFF09</label><input type="number" min="0" step="0.1" data-scope="clean" data-index="${index}" data-key="recipeTime" value="${Number(clean.recipeTime)}"></div>
        ${conditional}
      </div></article>`;
    }).join("");
    return `<section class="clean-type-group"><button class="clean-type-head" data-action="toggle-clean-type" data-clean-type="${type.key}"><span class="collapse-arrow ${open ? "open" : ""}">\u25B6</span><strong>${escapeHtml(type.label)}</strong><span class="route-count">${rows.length} \u4E2A \xB7 ${open ? "\u5DF2\u5C55\u5F00" : "\u5DF2\u6536\u8D77"}</span></button>${open ? `<div class="clean-type-body">${cards || `<div class="clean-type-empty">\u6682\u65E0 ${escapeHtml(type.label)}</div>`}</div>` : ""}</section>`;
  }).join("");
}
function stepKind(route, index) {
  return stageUsesRobot(route.stages[index], index) ? "Robot" : "Station";
}
function renderCandidatePicker(routeIndex, stageIndex, allowed, candidates) {
  const selected = new Set(candidates);
  const summary = candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u9009\u62E9\u8BBE\u5907</span>`;
  return `<details class="candidate-picker" onclick="event.stopPropagation()"><summary>${summary}</summary><div class="candidate-picker-menu">${allowed.map((name) => `<label class="candidate-option"><input type="checkbox" data-scope="stage-candidate-toggle" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-candidate="${escapeHtml(name)}" ${selected.has(name) ? "checked" : ""}><span>${escapeHtml(name)}</span></label>`).join("")}</div></details>`;
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
  return automaticRouteName(routeProcessProfile(route), routeCleanSignature(route));
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
  const groups = /* @__PURE__ */ new Map();
  state.routes.forEach((route, routeIndex) => {
    const profile = routeProcessProfile(route), group = groups.get(profile.key) || { ...profile, routes: [] };
    group.routes.push({ route, routeIndex, profile });
    groups.set(profile.key, group);
    if (state.expandedRoutes.has(routeIndex)) state.expandedRouteGroups.add(profile.key);
  });
  return [...groups.values()].sort(compareProfiles).map((group) => ({
    ...group,
    routes: group.routes.sort((left, right) => natural(left.route.name || "", right.route.name || ""))
  }));
}
function renderRouteDetails(route, index) {
  const preCleans = cleanNamesFor(["preclean", "dummy", "dummywac"]);
  const postCleans = cleanNamesFor(["postclean"]);
  return `<div class="route-details"><div class="edit-card-head"><strong>Route \u8BE6\u60C5</strong><div><button class="btn small" data-action="add-stage" data-index="${index}">\uFF0B Step \u7EC4</button> <button class="btn danger small" data-action="remove-route" data-index="${index}">\u5220\u9664</button></div></div>
    <div class="route-meta"><div class="route-meta-grid"><div class="field"><label>Route \u540D\u79F0\uFF08\u81EA\u52A8\u751F\u6210\uFF09</label><input value="${escapeHtml(route.name)}" readonly></div><div class="field"><label>Group</label><input data-scope="route" data-index="${index}" data-key="group" value="${escapeHtml(route.group)}"></div><div class="field"><label>BufferOption</label><input type="number" data-scope="route" data-index="${index}" data-key="bufferOption" value="${Number(route.bufferOption)}"></div></div>
    <details class="route-clean-details"><summary>Route \u7EA7 Clean \u8BBE\u7F6E</summary><div class="grid"><div class="field span-4"><label>PJob \u524D</label><select data-scope="route" data-index="${index}" data-key="prePJobCleanRefs">${optionsHtml(preCleans, stringList(route.prePJobCleanRefs)[0] || "", "\u4E0D\u9700\u8981\u6E05\u6D01")}</select></div><div class="field span-4"><label>PJob \u540E</label><select data-scope="route" data-index="${index}" data-key="postPJobCleanRefs">${optionsHtml(postCleans, stringList(route.postPJobCleanRefs)[0] || "", "\u4E0D\u9700\u8981\u6E05\u6D01")}</select></div><div class="field span-4"><label>CJob \u540E</label><select data-scope="route" data-index="${index}" data-key="postCJobCleanRefs">${optionsHtml(postCleans, stringList(route.postCJobCleanRefs)[0] || "", "\u4E0D\u9700\u8981\u6E05\u6D01")}</select></div></div></details></div>
    <div class="route-table-wrap"><table class="route-table"><thead><tr><th>StepID</th><th>\u7C7B\u578B</th><th>\u53EF\u9009\u8154\u5BA4 / \u673A\u5668\u624B</th><th>PostStepID</th><th>NeedProcess</th><th></th></tr></thead><tbody>${renderSteps(route, index)}</tbody></table></div></div>`;
}
function renderRoutes() {
  const host = document.getElementById("routeList"), groups = groupedRoutes();
  host.innerHTML = groups.length ? groups.map((group) => {
    const groupOpen = state.expandedRouteGroups.has(group.key);
    const routes = group.routes.map(({ route, routeIndex, profile }) => {
      const routeOpen = state.expandedRoutes.has(routeIndex), processSummary = profile.processCount ? `${profile.processCount} \u9053\u52A0\u5DE5\u5DE5\u5E8F \xB7 ${profile.candidatePath.join(" \u2192 ")}` : "\u65E0\u52A0\u5DE5\u5DE5\u5E8F";
      return `<article class="route-summary-card"><div class="route-summary-head"><button class="route-summary-toggle" data-action="toggle-route" data-route-index="${routeIndex}">
        <div class="route-summary-title"><span class="collapse-arrow ${routeOpen ? "open" : ""}">\u25B6</span><strong>${escapeHtml(route.name || "\u672A\u547D\u540D Route")}</strong></div><div class="route-summary-meta">${escapeHtml(processSummary)} \xB7 ${route.stages.length} Steps</div></button>
        <div class="route-summary-actions"><button class="btn small" data-action="edit-route" data-route-index="${routeIndex}">\u7F16\u8F91</button><button class="btn small" data-action="copy-route" data-route-index="${routeIndex}">\u590D\u5236</button><button class="btn danger small" data-action="remove-route" data-index="${routeIndex}">\u5220\u9664</button></div>
      </div>${routeOpen ? renderRouteDetails(route, routeIndex) : ""}</article>`;
    }).join("");
    return `<section class="route-type-group"><button class="route-type-head" data-action="toggle-route-group" data-group-key="${escapeHtml(group.key)}"><span class="collapse-arrow ${groupOpen ? "open" : ""}">\u25B6</span><strong>${escapeHtml(group.label)}</strong><span class="route-count">${group.routes.length} \u6761 Route \xB7 ${groupOpen ? "\u5DF2\u5C55\u5F00" : "\u5DF2\u6536\u8D77"}</span></button>${groupOpen ? `<div class="route-group-body">${routes}</div>` : ""}</section>`;
  }).join("") : `<div class="empty">\u81F3\u5C11\u521B\u5EFA\u4E00\u6761 Route\uFF0CJob \u624D\u80FD\u5F15\u7528\u3002</div>`;
}
function pjobLoadPortSlots(roundIndex, cjobIndex, pjobIndex) {
  const target = state.rounds[roundIndex].cjobs[cjobIndex].pjobs[pjobIndex];
  let occupied = 0;
  for (let currentCJobIndex = 0; currentCJobIndex <= cjobIndex; currentCJobIndex += 1) {
    const pjobs = state.rounds[roundIndex].cjobs[currentCJobIndex].pjobs;
    const end = currentCJobIndex === cjobIndex ? pjobIndex : pjobs.length - 1;
    for (let currentPJobIndex = 0; currentPJobIndex <= end; currentPJobIndex += 1) {
      const pjob = pjobs[currentPJobIndex];
      if (pjob.loadPort !== target.loadPort) continue;
      const start = occupied + 1;
      occupied += Number(pjob.waferCount);
      if (currentCJobIndex === cjobIndex && currentPJobIndex === pjobIndex) {
        return Array.from({ length: Number(pjob.waferCount) }, (_, index) => start + index);
      }
    }
  }
  return [];
}
function renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex) {
  const groups = groupedRoutes();
  const selectedRoute = state.routes.find((route) => route.name === pjob.routeRef);
  const selectedKey = selectedRoute ? routeProcessProfile(selectedRoute).key : groups[0]?.key || "";
  const selectedGroup = groups.find((group) => group.key === selectedKey);
  const common = `data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}"`;
  const groupOptions = groups.map((group) => `<option value="${escapeHtml(group.key)}" ${group.key === selectedKey ? "selected" : ""}>${escapeHtml(group.label)}</option>`).join("");
  const routeOptions = (selectedGroup?.routes || []).map(({ route }) => `<option value="${escapeHtml(route.name)}" ${route.name === pjob.routeRef ? "selected" : ""}>${escapeHtml(route.name)}</option>`).join("");
  return `<div class="pjob-route-picker">
    <select class="pjob-route-process" data-scope="pjob-route-group" ${common}>${groupOptions || `<option value="">\u6682\u65E0\u5DE5\u5E8F</option>`}</select>
    <select data-scope="pjob" data-key="routeRef" ${common}>${routeOptions ? `<option value="">\u9009\u62E9\u8DEF\u5F84</option>${routeOptions}` : `<option value="">\u8BF7\u5148\u914D\u7F6E Route</option>`}</select>
  </div>`;
}
function renderRounds() {
  normalizeRounds();
  const host = document.getElementById("roundList");
  host.innerHTML = state.rounds.map((round, roundIndex) => {
    const roundTitle = roundIndex ? `\u7B2C ${roundIndex + 1} \u8F6E\u91CD\u7B97` : "\u9996\u6B21\u6392\u7A0B";
    const cjobs = round.cjobs.map((cjob, cjobIndex) => {
      const normalLot = cjob.jobType === "NormalLot";
      const pjobRows = cjob.pjobs.map((pjob, pjobIndex) => `<tr>
        <td><span class="readonly-pill">${escapeHtml(pjob.jobName)}</span></td>
        <td><input class="pjob-number" type="number" min="1" max="${state.strategy === "milp" ? 12 : 25}" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="waferCount" value="${Number(pjob.waferCount)}"><small class="mat-list-preview">\u69FD\u4F4D [${pjobLoadPortSlots(roundIndex, cjobIndex, pjobIndex).join(", ")}]</small></td>
        <td>${renderPJobRoutePicker(pjob, roundIndex, cjobIndex, pjobIndex)}</td>
        <td><span class="readonly-pill">${escapeHtml(pjob.taskId)}</span></td>
        <td><input class="pjob-number" type="number" min="1" data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="priority" value="${Number(pjob.priority)}"></td>
        <td><select data-scope="pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" data-key="loadPort">${optionsHtml(state.loadPorts, pjob.loadPort, state.loadPorts.length ? "\u9009\u62E9\u7AEF\u53E3" : "\u65E0\u7AEF\u53E3")}</select></td>
        <td><button class="btn danger icon small" aria-label="\u5220\u9664 ${escapeHtml(pjob.jobName)}" data-action="remove-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-pjob-index="${pjobIndex}" ${cjob.pjobs.length <= 1 ? "disabled" : ""}>\xD7</button></td>
      </tr>`).join("");
      return `<section class="cjob-card">
        <header class="cjob-head"><div class="cjob-title"><strong>CJob ${cjobIndex + 1}</strong><span class="readonly-pill">TaskID ${escapeHtml(cjob.taskId)}</span></div><div class="round-actions"><button class="btn small" data-action="add-pjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}">\uFF0B PJob</button><button class="btn danger small" data-action="remove-cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" ${round.cjobs.length <= 1 ? "disabled" : ""}>\u5220\u9664 CJob</button></div></header>
        <div class="cjob-controls">
          <div class="field"><label>JobType</label><select data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="jobType">${CJOB_TYPES.map((value) => `<option ${value === cjob.jobType ? "selected" : ""}>${value}</option>`).join("")}</select></div>
          <div class="field ${normalLot ? "" : "disabled-field"}"><label>Priority</label><input type="number" min="1" data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="priority" value="${Number(cjob.priority)}" ${normalLot ? "" : "disabled"}></div>
          <div class="field"><label>TaskMode</label><select data-scope="cjob" data-round-index="${roundIndex}" data-cjob-index="${cjobIndex}" data-key="taskMode">${TASK_MODES.map((value) => `<option ${value === cjob.taskMode ? "selected" : ""}>${value}</option>`).join("")}</select></div>
          <div class="field"><label>PJobNameList</label><div class="pjob-name-list">${cjob.pJobNameList.map((name) => `<span>${escapeHtml(name)}</span>`).join("")}</div></div>
        </div>
        <div class="pjob-table-wrap"><table class="pjob-table"><thead><tr><th>JobName</th><th>\u6676\u5706\u6570\u91CF / LoadPort \u69FD\u4F4D</th><th>OriginRoute</th><th>TaskID</th><th>Priority</th><th>LoadPort</th><th></th></tr></thead><tbody>${pjobRows}</tbody></table></div>
      </section>`;
    }).join("");
    return `<section class="round-card"><header class="round-head"><div class="round-title"><div class="round-number">${roundIndex + 1}</div><div><strong>${roundTitle}</strong><span class="readonly-pill">@ ${Number(round.currentTime)}s</span></div></div><div class="round-time-editor field"><label>${roundIndex ? "\u91CD\u7B97\u65F6\u95F4" : "\u6392\u7A0B\u65F6\u95F4"}</label><div><input type="number" min="0" step="0.1" data-round-time-index="${roundIndex}" value="${Number(round.currentTime)}" ${roundIndex ? "" : "disabled"}><span>s</span></div></div><button class="btn small" data-action="add-cjob" data-round-index="${roundIndex}">\uFF0B CJob</button></header><div class="cjob-list">${cjobs}</div></section>`;
  }).join("");
}
function renderVisitField(label, key, value, routeIndex, stageIndex, options = {}) {
  const common = `data-scope="visit-shared" data-route-index="${routeIndex}" data-stage-index="${stageIndex}" data-key="${key}"`;
  if (options.multiple) return `<div class="unified-field ${options.wide ? "wide" : ""}"><label>${label}</label><select multiple ${common}>${multiOptionsHtml(options.values || [], value)}</select></div>`;
  const type = options.number ? "number" : "text", step = options.number ? ` step="${options.step || "0.1"}"` : "";
  return `<div class="unified-field ${options.wide ? "wide" : ""}"><label>${label}</label><input type="${type}"${step} ${common} value="${escapeHtml(value)}"></div>`;
}
function renderStepDrawer() {
  if (!state.drawer) return;
  const { routeIndex, stageIndex } = state.drawer, route = state.routes[routeIndex], stage = route?.stages[stageIndex];
  if (!stage) {
    closeStepDrawer();
    return;
  }
  normalizeRoute(route);
  document.getElementById("drawerTitle").textContent = `${route.name || "Route"} \xB7 StepID ${stage.stepId}`;
  document.getElementById("drawerSubtitle").textContent = `${stepKind(route, stageIndex)} \xB7 ${stage.visits.length} \u4E2A\u5019\u9009`;
  const first = stage.visits[0] ? normalizeVisit(stage.visits[0]) : null, differences = visitDifferenceFields(stage), candidates = stage.visits.map((visit) => visit.stationName).filter(Boolean);
  const warning = differences.length ? `<div class="visit-warning"><strong>\u5019\u9009\u8154\u5BA4\u53C2\u6570\u4E0D\u4E00\u81F4</strong><p>\u5B58\u5728\u5DEE\u5F02\u7684\u5B57\u6BB5\uFF1A${differences.map(escapeHtml).join("\u3001")}\u3002\u7EDF\u4E00\u8868\u5355\u6682\u65F6\u663E\u793A\u7B2C\u4E00\u4E2A\u5019\u9009 Visit \u7684\u503C\uFF0C\u5C1A\u672A\u8986\u76D6\u5176\u4ED6\u5019\u9009\u3002</p><button class="btn small" data-action="sync-stage-visits" data-route-index="${routeIndex}" data-stage-index="${stageIndex}">\u6309\u5F53\u524D\u8868\u5355\u540C\u6B65\u5168\u90E8\u5019\u9009</button></div>` : "";
  const form = first ? `<div class="unified-visit-form"><header class="unified-visit-head"><strong>\u7EDF\u4E00\u53C2\u6570</strong><span>\u4FEE\u6539\u4EFB\u4E00\u5B57\u6BB5\u540E\u540C\u6B65\u5230 ${stage.visits.length} \u4E2A\u5019\u9009</span></header><div class="visit-groups">
    <section class="visit-group"><h4>\u5DE5\u827A\u4FE1\u606F</h4><div class="visit-fields">
      ${renderVisitField("ProcessTime", "processTime", first.processTime, routeIndex, stageIndex, { number: true })}
      ${renderVisitField("RecipeTime", "recipeTime", first.recipeTime, routeIndex, stageIndex, { number: true })}
      ${renderVisitField("ProcessRecipe", "processRecipe", first.processRecipe, routeIndex, stageIndex)}
      ${renderVisitField("ProcessType", "processType", first.processType, routeIndex, stageIndex)}
      ${renderVisitField("Weight", "weight", typeof first.weight === "string" ? first.weight : JSON.stringify(first.weight), routeIndex, stageIndex)}
      ${renderVisitField("MoveTimeOffset", "moveTimeOffset", typeof first.moveTimeOffset === "string" ? first.moveTimeOffset : JSON.stringify(first.moveTimeOffset), routeIndex, stageIndex, { wide: true })}
    </div></section>
    <section class="visit-group"><h4>\u7EA6\u675F\u4FE1\u606F</h4><div class="visit-fields constraints">
      ${renderVisitField("SlotIDs", "slotIds", first.slotIds, routeIndex, stageIndex)}
      ${renderVisitField("QTime", "qTimeLimit", first.qTimeLimit, routeIndex, stageIndex, { number: true })}
      ${renderVisitField("Residency", "residencyConstraint", first.residencyConstraint, routeIndex, stageIndex, { number: true })}
      ${renderVisitField("Before Clean", "beforeCleanRefs", first.beforeCleanRefs, routeIndex, stageIndex, { multiple: true, values: cleanNamesFor(["preclean", "dummy", "dummywac"]), wide: true })}
      ${renderVisitField("After Clean", "afterCleanRefs", first.afterCleanRefs, routeIndex, stageIndex, { multiple: true, values: cleanNamesFor(["postclean", "wacclean"]), wide: true })}
    </div></section>
  </div></div>` : `<div class="empty">\u672A\u9009\u62E9\u5019\u9009\u8BBE\u5907\uFF0C\u8BF7\u5148\u5728 Route \u5217\u8868\u4E2D\u9009\u62E9\u3002</div>`;
  document.getElementById("drawerBody").innerHTML = `<section class="drawer-section"><h3>Step \u6982\u8981</h3><div class="step-summary"><div class="step-summary-item"><span>StepID</span><strong>${stage.stepId}</strong></div><div class="step-summary-item"><span>PostStepID</span><strong>${stage.postStepIds?.length ? stage.postStepIds.join(", ") : "\u7ED3\u675F"}</strong></div><div class="step-summary-item"><span>NeedProcess</span><strong>${stage.needProcess ? "true" : "false"}</strong></div><div class="step-summary-item"><span>\u5019\u9009\u6570\u91CF</span><strong>${stage.visits.length}</strong></div></div></section><section class="drawer-section"><h3>\u5019\u9009\u8154\u5BA4</h3><div class="candidate-chip-list">${candidates.length ? candidates.map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("") : `<span class="candidate-picker-empty">\u672A\u9009\u62E9</span>`}</div></section>${warning}<section class="drawer-section">${form}</section>`;
}
function openStepDrawer(routeIndex, stageIndex) {
  state.drawer = { routeIndex, stageIndex };
  state.expandedRoutes.add(routeIndex);
  state.expandedRouteGroups.add(routeProcessProfile(state.routes[routeIndex]).key);
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
    synchronizeStageVisits(stage);
  }
  if (scope === "cjob") {
    const cjob = state.rounds[Number(control.dataset.roundIndex)].cjobs[Number(control.dataset.cjobIndex)];
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
    state.expandedRouteGroups.add(routeProcessProfile(state.routes[routeIndex]).key);
    renderRoutes();
    return;
  }
  if (action === "sync-stage-visits") {
    synchronizeStageVisits(state.routes[routeIndex].stages[stageIndex]);
    markTestDirty();
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
    const newIndex = state.routes.length - 1;
    state.expandedRoutes.add(newIndex);
    state.expandedRouteGroups.add(routeProcessProfile(route).key);
  }
  if (action === "generate-example-routes") {
    const added = generateExampleRoutes();
    if (added === null) {
      writeTerminal("$ \u5F53\u524D\u8BBE\u5907\u4E0D\u662F\u5B8C\u6574\u7684 PSE300 \u62D3\u6251\uFF0C\u4E0D\u80FD\u751F\u6210\u8FD9\u7EC4\u793A\u4F8B Route", true);
      return;
    }
    if (!added) {
      writeTerminal("$ \u793A\u4F8B Route \u5DF2\u7ECF\u9F50\u5168\uFF0C\u6CA1\u6709\u91CD\u590D\u6DFB\u52A0", false);
      return;
    }
    state.expandedRoutes.clear();
    state.expandedRouteGroups.clear();
    writeTerminal(`$ \u5DF2\u65B0\u589E ${added} \u6761 PSE300 \u793A\u4F8B Route
  \u8986\u76D6 1\u20133 \u9053\u5DE5\u5E8F\u300140\u2013120 \u79D2\uFF0C\u771F\u7A7A\u9501\u5019\u9009\u4E3A LA/LB`, false);
  }
  if (action === "copy-route") {
    const source = state.routes[routeIndex], base = `${source.name || "Route"} \u526F\u672C`, occupied = new Set(state.routes.map((route) => route.name));
    let name = base, suffix = 2;
    while (occupied.has(name)) name = `${base} (${suffix++})`;
    const copy = structuredClone(source);
    copy.name = name;
    state.routes.push(copy);
    const newIndex = state.routes.length - 1;
    state.expandedRoutes.add(newIndex);
    state.expandedRouteGroups.add(routeProcessProfile(copy).key);
  }
  if (action === "remove-route") {
    state.routes.splice(index, 1);
    state.expandedRoutes.clear();
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
    const cjob = makeCJob(roundIndex + 1, [], state.routes[0]?.name || "", state.loadPorts[roundIndex] || state.loadPorts[0] || "");
    cjob.key = `C${round.cjobs.length + 1}`;
    round.cjobs.push(cjob);
  }
  if (action === "remove-cjob") state.rounds[Number(button.dataset.roundIndex)].cjobs.splice(Number(button.dataset.cjobIndex), 1);
  if (action === "add-pjob") {
    const roundIndex = Number(button.dataset.roundIndex), cjob = state.rounds[roundIndex].cjobs[Number(button.dataset.cjobIndex)];
    cjob.pjobs.push(makePJob(cjob.pjobs.length + 1, state.routes[0]?.name || "", state.loadPorts[roundIndex] || state.loadPorts[0] || "", 5));
  }
  if (action === "remove-pjob") state.rounds[Number(button.dataset.roundIndex)].cjobs[Number(button.dataset.cjobIndex)].pjobs.splice(Number(button.dataset.pjobIndex), 1);
  normalizeRounds();
  markTestDirty();
  renderAll();
}
function collectRecipes(routes = state.routes) {
  const recipes = [];
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
      if (visit.processRecipe) add(visit.processRecipe, visit.processTime, [visit.stationName], visit.processType, visit.weight);
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
    <label class="strategy-card" title="${escapeHtml(algorithm.path || "")}">
      <input type="radio" name="strategy" value="${escapeHtml(algorithm.strategy)}" ${algorithm.strategy === state.strategy ? "checked" : ""}>
      <b>${escapeHtml(algorithm.name)}</b>
      <span>other_alg \xB7 init/update</span>
    </label>
  `).join("");
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
async function runPlan() {
  const button = document.getElementById("runButton");
  const batchButton = document.getElementById("batchRunButton");
  let logReady = false, runResult = null;
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
    if (!response.ok || !runResult.ok) throw new Error(runResult.error || `\u670D\u52A1\u8FD4\u56DE ${response.status}`);
    showResult(runResult);
  } catch (error) {
    const baselineError = runResult?.baseline?.status === "failed" ? `
  Baseline \u5931\u8D25\uFF1A${runResult.baseline.error || "\u672A\u77E5\u539F\u56E0"}` : "";
    writeTerminal(`$ \u8FD0\u884C\u5931\u8D25\uFF1A${error.message || "\u672A\u77E5\u9519\u8BEF"}${baselineError}${logReady ? "\n  \u590D\u73B0\u65E5\u5FD7\u5DF2\u751F\u6210\uFF0C\u53EF\u70B9\u51FB\u201C\u5BFC\u51FA\u590D\u73B0\u65E5\u5FD7\u201D" : ""}`, true);
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
    button.textContent = "\u25A6 \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u7EC4";
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
function showBatchProgress(result) {
  const completed = Number(result.completed || 0), total = Number(result.testCount || result.items?.length || 0);
  const percent = total ? Math.round(completed / total * 100) : 0;
  const successful = (result.items || []).filter((item) => item.status === "succeeded");
  const averageMakespan = successful.length ? successful.reduce((sum, item) => sum + Number(item.makespan), 0) / successful.length : 0;
  const comparable = successful.filter((item) => item.baseline?.status === "succeeded");
  const totalMakespan = comparable.reduce((sum, item) => sum + Number(item.makespan), 0);
  const totalBaseline = comparable.reduce((sum, item) => sum + Number(item.baseline.makespan), 0);
  const aggregateImprovement = totalBaseline > 0 ? (totalBaseline - totalMakespan) / totalBaseline * 100 : NaN;
  const moveCount = successful.reduce((sum, item) => sum + Number(item.moveCount || 0), 0);
  const progress = document.getElementById("batchProgress");
  const statusText = result.status === "completed" ? "\u6279\u91CF\u8FD0\u884C\u5B8C\u6210" : result.status === "cancelled" ? "\u6279\u91CF\u8C03\u5EA6\u5DF2\u7EC8\u6B62" : result.status === "failed" ? "\u6279\u91CF\u8FD0\u884C\u5931\u8D25" : "\u6279\u91CF\u8FD0\u884C\u4E2D";
  progress.classList.add("visible");
  document.getElementById("metricTimeLabel").textContent = "\u603B\u8017\u65F6";
  document.getElementById("batchProgressText").textContent = statusText;
  document.getElementById("batchProgressCount").textContent = `${completed}/${total} \xB7 ${percent}%`;
  document.getElementById("batchProgressBar").style.width = `${percent}%`;
  document.getElementById("metricTime").textContent = result.status === "completed" ? `${(Number(result.totalElapsedMs) / 1e3).toFixed(2)} s` : result.status === "cancelled" ? "\u5DF2\u7EC8\u6B62" : "\u8FD0\u884C\u4E2D";
  document.getElementById("metricMakespanLabel").textContent = comparable.length ? "\u603B Makespan / Baseline" : "\u5E73\u5747 Makespan";
  document.getElementById("metricMakespan").textContent = comparable.length ? `${totalMakespan.toFixed(2)} / ${totalBaseline.toFixed(2)} s \xB7 ${aggregateImprovement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(aggregateImprovement).toFixed(2)}%` : successful.length ? `${averageMakespan.toFixed(2)} s` : "\u2014";
  document.getElementById("metricMovesLabel").textContent = "\u603B Move \u6570";
  document.getElementById("metricMoves").textContent = moveCount || "\u2014";
  document.getElementById("metricValidationLabel").textContent = result.cancelled ? "\u6210\u529F / \u5931\u8D25 / \u7EC8\u6B62" : "\u6210\u529F / \u5931\u8D25";
  document.getElementById("metricValidation").textContent = result.cancelled ? `${result.succeeded || 0} / ${result.failed || 0} / ${result.cancelled}` : `${result.succeeded || 0} / ${result.failed || 0}`;
  renderBatchItems(result.items || []);
  writeTerminal([
    "$ \u6279\u91CF\u8FD0\u884C\u5F53\u524D\u6D4B\u8BD5\u7EC4",
    `  \u7EC4\u522B: ${result.group || "\u672A\u5206\u7EC4"} \xB7 \u7B56\u7565: ${result.strategy}`,
    `  \u8FDB\u5EA6: ${completed}/${total} (${percent}%) \xB7 \u5E76\u884C\u6570: ${result.workerCount}`,
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
    const improvementBadge = finished && baselineReady && Number.isFinite(improvement) ? `<b class="${improvement >= 0 ? "summary-gain" : "summary-loss"}">${improvement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(improvement).toFixed(2)}%</b>` : "";
    const baselineReason = baseline.status && baseline.status !== "succeeded" ? `Baseline ${baseline.status === "failed" ? "\u5931\u8D25" : "\u5931\u6548"}\uFF1A${baseline.error || "\u7B49\u5F85\u91CD\u65B0\u8BA1\u7B97"}` : "";
    const summaryError = baseline.status === "failed" ? baselineReason : item.status === "failed" ? `\u8FD0\u884C\u5931\u8D25\uFF1A${item.error || "\u672A\u77E5\u9519\u8BEF"}` : item.status === "cancelled" ? "\u8C03\u5EA6\u5DF2\u7EC8\u6B62" : baselineReason;
    const displayId = `t${index + 1}`;
    return `
      <div class="batch-result ${escapeHtml(item.status || "queued")}">
        <div class="batch-result-head">
          <div class="batch-result-title"><strong title="${escapeHtml(`${item.testId || ""} \xB7 ${item.testName || ""}`)}">${escapeHtml(displayId)}</strong></div>
          <span class="batch-status">${statusLabels[item.status] || "\u7B49\u5F85\u4E2D"}</span>
          <div class="batch-result-actions">
            ${item.logUrl ? `<a class="btn" href="${escapeHtml(item.logUrl)}" download>\u65E5\u5FD7</a>` : `<span class="btn" aria-disabled="true">\u65E5\u5FD7</span>`}
            ${item.ganttUrl ? `<a class="btn primary" href="${escapeHtml(item.ganttUrl)}" target="_blank">\u7518\u7279\u56FE</a>` : `<span class="btn" aria-disabled="true">\u7518\u7279\u56FE</span>`}
          </div>
        </div>
        <div class="batch-result-summary">
          ${summaryError ? `<span class="summary-error" title="${escapeHtml(summaryError)}">${escapeHtml(summaryError)}</span>` : `
            <span title="Makespan \u5F53\u524D\u503C / Heuristic Baseline"><b>${finished ? `${Number(item.makespan).toFixed(2)} s` : "\u2014"}</b> / <b>${baselineReady ? `${Number(baseline.makespan).toFixed(2)} s` : "\u2014"}</b>${improvementBadge ? ` ${improvementBadge}` : ""}\uFF1BCpu time <b>${finished && Number.isFinite(cpuTime) ? `${cpuTime.toFixed(1)} ms` : "\u2014"}</b></span>
          `}
        </div>
      </div>`;
  }).join("");
}
function batchGanttUrl(items) {
  const params = new URLSearchParams();
  items.filter((item) => item.status === "succeeded" && item.resultUrl).forEach((item) => {
    params.append("src", item.resultUrl);
    params.append("name", item.testName);
  });
  return params.size ? `/movelist_gantt_viewer.html?${params.toString()}` : "";
}
function showBatchResult(result) {
  const successful = result.items.filter((item) => item.status === "succeeded");
  const averageMakespan = successful.length ? successful.reduce((sum, item) => sum + Number(item.makespan), 0) / successful.length : 0;
  const comparable = successful.filter((item) => item.baseline?.status === "succeeded");
  const totalMakespan = comparable.reduce((sum, item) => sum + Number(item.makespan), 0);
  const totalBaseline = comparable.reduce((sum, item) => sum + Number(item.baseline.makespan), 0);
  const aggregateImprovement = totalBaseline > 0 ? (totalBaseline - totalMakespan) / totalBaseline * 100 : NaN;
  const moveCount = successful.reduce((sum, item) => sum + Number(item.moveCount || 0), 0);
  document.getElementById("metricTimeLabel").textContent = "\u603B\u8017\u65F6";
  document.getElementById("metricTime").textContent = `${(Number(result.totalElapsedMs) / 1e3).toFixed(2)} s`;
  document.getElementById("metricMakespanLabel").textContent = comparable.length ? "\u603B Makespan / Baseline" : "\u5E73\u5747 Makespan";
  document.getElementById("metricMakespan").textContent = comparable.length ? `${totalMakespan.toFixed(2)} / ${totalBaseline.toFixed(2)} s \xB7 ${aggregateImprovement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(aggregateImprovement).toFixed(2)}%` : successful.length ? `${averageMakespan.toFixed(2)} s` : "\u2014";
  document.getElementById("metricMovesLabel").textContent = "\u603B Move \u6570";
  document.getElementById("metricMoves").textContent = moveCount;
  document.getElementById("metricValidationLabel").textContent = "\u6210\u529F / \u5931\u8D25";
  document.getElementById("metricValidation").textContent = `${result.succeeded} / ${result.failed}`;
  writeTerminal([
    "$ \u6279\u91CF\u8FD0\u884C\u5B8C\u6210",
    `  \u7EC4\u522B: ${result.group || "\u672A\u5206\u7EC4"} \xB7 \u7B56\u7565: ${result.strategy}`,
    `  \u6210\u529F: ${result.succeeded} \xB7 \u5931\u8D25: ${result.failed} \xB7 \u5E76\u884C\u6570: ${result.workerCount}`,
    `  \u603B\u8017\u65F6: ${(Number(result.totalElapsedMs) / 1e3).toFixed(2)} s`,
    ...comparable.length ? [`  \u7EC4\u7EA7 Makespan: ${totalMakespan.toFixed(2)} / Baseline ${totalBaseline.toFixed(2)} s \xB7 ${aggregateImprovement >= 0 ? "\u63D0\u5347" : "\u9000\u5316"} ${Math.abs(aggregateImprovement).toFixed(2)}%`] : [],
    "",
    ...result.items.map((item, index) => item.ok ? `  #${index + 1} ${item.testName} | makespan=${Number(item.makespan).toFixed(2)}s | improvement=${Number.isFinite(Number(item.improvementPercent)) ? `${Number(item.improvementPercent).toFixed(2)}%` : "\u2014"} | ${Number(item.totalElapsedMs).toFixed(1)}ms` : `  #${index + 1} ${item.testName} | \u5931\u8D25: ${item.error}`)
  ].join("\n"), result.failed > 0);
  renderBatchItems(result.items);
  const first = successful[0];
  if (first) {
    const gantt = document.getElementById("ganttButton");
    gantt.href = first.ganttUrl;
    gantt.removeAttribute("aria-disabled");
    const log = document.getElementById("logButton");
    log.href = first.logUrl;
    log.download = first.logFileName;
    log.removeAttribute("aria-disabled");
  }
  const allGanttUrl = batchGanttUrl(result.items);
  const allGantt = document.getElementById("batchGanttButton");
  if (allGanttUrl) {
    allGantt.href = allGanttUrl;
    allGantt.removeAttribute("aria-disabled");
  }
}
function showResult(result) {
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
  const allGantt = document.getElementById("batchGanttButton");
  allGantt.href = "#";
  allGantt.setAttribute("aria-disabled", "true");
  const baseline = result.baseline || {}, baselineReady = baseline.status === "succeeded";
  const cpuTime = Number(result.cpuTimeMs ?? result.totalElapsedMs);
  document.getElementById("metricTimeLabel").textContent = "CPU Time";
  document.getElementById("metricMakespanLabel").textContent = "Makespan / Baseline";
  document.getElementById("metricMovesLabel").textContent = "Move \u6570";
  document.getElementById("metricValidationLabel").textContent = "\u6821\u9A8C";
  document.getElementById("metricTime").textContent = `${cpuTime.toFixed(1)} ms`;
  document.getElementById("metricMakespan").textContent = `${result.makespan.toFixed(2)} / ${baselineReady ? Number(baseline.makespan).toFixed(2) : "\u2014"} s`;
  document.getElementById("metricMoves").textContent = result.moveCount;
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
  const terminal = document.getElementById("terminal");
  terminal.textContent = message;
  terminal.classList.toggle("error", error);
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
    const neuralAvailable = status.strategies?.neural === true, rlAvailable = status.strategies?.rl !== false, l2dAvailable = status.strategies?.l2d === true, milpAvailable = status.strategies?.milp === true;
    document.getElementById("neuralStrategyInput").disabled = !neuralAvailable;
    const neuralModelName = String(status.strategyModels?.neural || "").split(/[\\/]/).at(-1);
    document.getElementById("neuralStrategyHint").textContent = neuralAvailable ? `${neuralModelName} \xB7 NumPy \u5FEB\u901F\u63A8\u7406 \xB7 \u540C\u6B65\u6CE2\u524D\u5B89\u5168\u5C42` : "\u7F3A\u5C11\u6A21\u578B\uFF0C\u8BF7\u5148\u79BB\u7EBF\u8BAD\u7EC3";
    document.getElementById("rlStrategyInput").disabled = !rlAvailable;
    document.getElementById("rlStrategyHint").textContent = rlAvailable ? "\u8C03\u7528\u5DF2\u8BAD\u7EC3\u6A21\u578B" : "\u7F3A\u5C11 RL \u6A21\u578B";
    document.getElementById("l2dStrategyInput").disabled = !l2dAvailable;
    const l2dModelName = String(status.strategyModels?.l2d || "").split(/[\\/]/).at(-1);
    document.getElementById("l2dStrategyHint").textContent = l2dAvailable ? `${l2dModelName} \xB7 \u5355\u6B21\u8D2A\u5FC3\u63A8\u7406` : "\u7F3A\u5C11 checkpoint\uFF0C\u53EF\u5728\u4E0B\u65B9\u5BFC\u5165";
    document.getElementById("milpStrategyInput").disabled = !milpAvailable;
    renderOtherAlgorithmOptions(status.otherAlgorithms || []);
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
document.getElementById("deviceFile").addEventListener("change", (event) => loadDevice(event.target.files[0]).catch((error) => {
  event.target.value = "";
  writeTerminal(`$ \u8BBE\u5907\u8BFB\u53D6\u5931\u8D25
  ${error.message}`, true);
}));
document.getElementById("l2dCheckpointFile").addEventListener("change", (event) => importL2dCheckpoint(event.target.files[0]).catch((error) => {
  event.target.value = "";
  writeTerminal(`$ L2D checkpoint \u5BFC\u5165\u5931\u8D25
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
document.getElementById("clearButton").addEventListener("click", () => {
  writeTerminal("$ \u7B49\u5F85\u8FD0\u884C\u2026");
  document.getElementById("batchProgress").classList.remove("visible");
  document.getElementById("batchResults").innerHTML = "";
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
    if (["name", "cleanType", "jobType", "waferCount", ...ROUTE_CLEAN_KEYS].includes(event.target.dataset.key) || event.target.dataset.timeIndex !== void 0 || event.target.dataset.roundTimeIndex !== void 0 || ["stage-candidates", "stage-candidate-toggle", "cjob", "pjob", "pjob-route-group"].includes(event.target.dataset.scope)) renderAll();
    else if (state.drawer) {
      renderRoutes();
      renderStepDrawer();
    }
  }
  if (event.target.name === "strategy") {
    state.strategy = event.target.value;
    if (state.strategy === "neural") state.options.loadLockManager = "joint";
    else if (["heuristic", "rl"].includes(state.strategy)) state.options.loadLockManager = "petri-look";
    if (state.strategy === "milp") {
      resizeRounds(1);
      document.getElementById("roundCount").value = 1;
    }
    document.getElementById("roundCount").disabled = state.strategy === "milp";
    document.getElementById("loadlockOptions").classList.toggle("is-hidden", !["heuristic", "neural", "rl"].includes(state.strategy));
    document.getElementById("rlOptions").classList.toggle("is-hidden", state.strategy !== "rl");
    document.getElementById("milpOptions").classList.toggle("is-hidden", state.strategy !== "milp");
    markTestDirty();
    renderAll();
  }
});
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab-target]");
  if (tab) switchTab(tab.dataset.tabTarget);
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
