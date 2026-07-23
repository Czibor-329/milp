(function exposeRouteEditorLogic(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RouteEditorLogic = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createRouteEditorLogic() {
  "use strict";

  const VISIT_SHARED_FIELDS = [
    "processTime", "recipeTime", "processRecipe", "processType", "slotIds",
    "weight", "moveTimeOffset", "qTimeLimit", "residencyConstraint",
    "beforeCleanRefs", "afterCleanRefs",
  ];

  function cloneValue(value) {
    return value === undefined ? undefined : structuredClone(value);
  }

  function cloneVisitParameters(visit) {
    return Object.fromEntries(VISIT_SHARED_FIELDS.map(key => [key, cloneValue(visit?.[key])]));
  }

  function processProfile(route) {
    const processStages = (route.stages || []).filter(stage => stage.needProcess);
    const counts = processStages.map(stage => new Set((stage.visits || []).map(visit => visit.stationName).filter(Boolean)).size);
    const candidatePath = processStages.map(stage => [...new Set((stage.visits || []).map(visit => visit.stationName).filter(Boolean))].join("/") || "未选择腔室");
    const processTimes = processStages.map(stage => Number(stage.visits?.[0]?.processTime ?? stage.visits?.[0]?.recipeTime ?? 0));
    const processCount = processStages.length;
    const label = processCount === 0 ? "无加工工序" : `${processCount}道工序`;
    return { processCount, counts, candidatePath, processTimes, label, key: String(processCount) };
  }

  function formatSeconds(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Number.isInteger(number) ? number : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s` : "未设置";
  }

  function automaticRouteName(profile) {
    return profile.processCount === 0
      ? "无加工工序"
      : `${profile.processCount}道工序 · ${profile.candidatePath.map((path, index) => `${path}(${formatSeconds(profile.processTimes[index])})`).join(" → ")}`;
  }

  const EXAMPLE_ROUTE_SPECS = [
    ...[["PM1"], ["PM1", "PM2"], ["PM1", "PM2", "PM3"], ["PM1", "PM2", "PM3", "PM4"]]
      .flatMap(candidates => [40, 80, 120].map(time => ({ candidates: [candidates], times: [time] }))),
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
    { candidates: [["PM1"], ["PM2", "PM3"], ["PM4"]], times: [40, 100, 120] },
  ];

  function exampleRouteSpecs() {
    return structuredClone(EXAMPLE_ROUTE_SPECS);
  }

  function compareProfiles(left, right) {
    if (left.processCount !== right.processCount) return left.processCount - right.processCount;
    for (let index = 0; index < Math.max(left.counts.length, right.counts.length); index += 1) {
      if ((left.counts[index] ?? -1) !== (right.counts[index] ?? -1)) return (left.counts[index] ?? -1) - (right.counts[index] ?? -1);
    }
    return 0;
  }

  function differenceFields(stage, normalizeVisit = value => value) {
    if ((stage.visits || []).length < 2) return [];
    const first = normalizeVisit(stage.visits[0]);
    return VISIT_SHARED_FIELDS.filter(key => stage.visits.slice(1).some(visit => (
      JSON.stringify(normalizeVisit(visit)[key]) !== JSON.stringify(first[key])
    )));
  }

  function synchronizeVisits(stage, normalizeVisit = value => value) {
    if (!(stage.visits || []).length) return;
    const parameters = cloneVisitParameters(normalizeVisit(stage.visits[0]));
    stage.visits.forEach(visit => Object.assign(visit, structuredClone(parameters)));
  }

  function replaceCandidates(stage, names, makeVisit, normalizeVisit = value => value) {
    const selected = [...new Set((names || []).map(name => String(name || "").trim()).filter(Boolean))];
    const prior = new Map((stage.visits || []).map(visit => [visit.stationName, visit]));
    const template = stage.visits?.length
      ? cloneVisitParameters(normalizeVisit(stage.visits[0]))
      : cloneVisitParameters(normalizeVisit(makeVisit("")));
    stage.visits = selected.map(name => prior.get(name) || { stationName: name, ...structuredClone(template) });
  }

  function selectReferencedRoutes(routes, rounds) {
    /** 只返回当前测试各轮 PJob 实际引用的 Route，避免共享库中的同名 Recipe 冲突。 */
    const referencedNames = new Set((rounds || []).flatMap(round => (
      (round.cjobs || []).flatMap(cjob => (
        (cjob.pjobs || []).map(pjob => String(pjob.routeRef || "").trim())
      ))
    )));
    return (routes || []).filter(route => referencedNames.has(String(route.name || "").trim()));
  }

  function processRecipeName(value, fallback) {
    /** 空字符串和空白字符串都视为缺失，使用加工 Step 的稳定派生名称。 */
    const explicitName = String(value ?? "").trim();
    return explicitName || String(fallback ?? "").trim();
  }

  return {
    VISIT_SHARED_FIELDS,
    cloneVisitParameters,
    processProfile,
    automaticRouteName,
    exampleRouteSpecs,
    compareProfiles,
    differenceFields,
    synchronizeVisits,
    replaceCandidates,
    selectReferencedRoutes,
    processRecipeName,
  };
}));
