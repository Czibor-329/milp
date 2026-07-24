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
module.exports = __toCommonJS(route_editor_logic_exports);
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
function differenceFields(stage, normalizeVisit = (value) => value) {
  if ((stage.visits || []).length < 2) return [];
  const first = normalizeVisit(stage.visits[0]);
  return VISIT_SHARED_FIELDS.filter((key) => stage.visits.slice(1).some(
    (visit) => JSON.stringify(normalizeVisit(visit)[key]) !== JSON.stringify(first[key])
  ));
}
function synchronizeVisits(stage, normalizeVisit = (value) => value) {
  if (!(stage.visits || []).length) return;
  const parameters = cloneVisitParameters(normalizeVisit(stage.visits[0]));
  stage.visits.forEach((visit) => Object.assign(visit, structuredClone(parameters)));
}
function replaceCandidates(stage, names, makeVisit, normalizeVisit = (value) => value) {
  const selected = [...new Set((names || []).map((name) => String(name || "").trim()).filter(Boolean))];
  const prior = new Map((stage.visits || []).map((visit) => [visit.stationName, visit]));
  const template = stage.visits?.length ? cloneVisitParameters(normalizeVisit(stage.visits[0])) : cloneVisitParameters(normalizeVisit(makeVisit("")));
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VISIT_SHARED_FIELDS,
  automaticRouteName,
  cloneVisitParameters,
  compareProfiles,
  differenceFields,
  exampleRouteSpecs,
  processProfile,
  processRecipeName,
  replaceCandidates,
  routeCleanSignature,
  selectReferencedRoutes,
  synchronizeVisits
});
