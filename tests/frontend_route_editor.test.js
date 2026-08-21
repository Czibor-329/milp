"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../realtime_scheduler/frontend/route_editor_logic.js");

function visit(stationName, processTime = 20) {
  return {
    stationName, processTime, recipeTime: processTime, processRecipe: "R_Step4",
    processType: "", slotIds: "1", weight: { value: 1 }, moveTimeOffset: {},
    qTimeLimit: -1, residencyConstraint: -1, beforeCleanRefs: [], afterCleanRefs: [],
  };
}

function route(...candidateGroups) {
  return { stages: candidateGroups.map(names => ({ needProcess: true, visits: names.map(name => visit(name)) })) };
}

test("Route 按工序数与各工序并行机器数形成两级分组", () => {
  assert.deepEqual(
    logic.processProfile(route(["PM1"])),
    {
      processCount: 1,
      counts: [1],
      candidatePath: ["PM1"],
      processTimes: [20],
      isReentrant: false,
      processLabel: "1 道工序",
      label: "(1)",
      key: "1:1",
    },
  );
  assert.equal(logic.processProfile(route(["PM1", "PM2"])).label, "(2)");
  assert.equal(logic.processProfile(route(["PM1", "PM2"], ["PM3", "PM4", "PM5"])).label, "(2, 3)");
  const empty = logic.processProfile({ stages: [{ needProcess: false, visits: [visit("ATR")] }] });
  assert.equal(empty.processLabel, "无加工工序");
  assert.equal(empty.label, "(0)");
});

test("重复进入加工腔室的 Route 统一归入重入组", () => {
  const profile = logic.processProfile(route(["PM1"], ["PM2"], ["PM1"], ["PM2"]));
  assert.equal(profile.isReentrant, true);
  assert.equal(profile.processLabel, "重入组");
  assert.equal(profile.label, "重入路径");
  assert.equal(profile.key, "reentrant");
  assert.deepEqual(profile.candidatePath, ["PM1", "PM2", "PM1", "PM2"]);

  const parallelReentry = logic.processProfile(
    route(["PM1", "PM2"], ["PM3"], ["PM1", "PM2"]),
  );
  assert.equal(parallelReentry.key, "reentrant");
  assert.deepEqual(parallelReentry.counts, [2, 1, 2]);
});

test("Route 名称由腔室种类和加工时间自动生成且不带工序数前缀", () => {
  assert.equal(logic.automaticRouteName(logic.processProfile(route(["PM1"]))), "PM1(20s)");
  assert.equal(logic.automaticRouteName(logic.processProfile(route(["PM1", "PM2"]))), "PM1/PM2(20s)");
  assert.equal(logic.automaticRouteName(logic.processProfile(route(["PM1", "PM2"], ["PM3", "PM4"]))), "PM1/PM2(20s) → PM3/PM4(20s)");
});

test("路径模板名称只包含腔室拓扑，不包含测试时间", () => {
  const value = route(["PM1", "PM2"], ["PM3"]);
  value.stages[0].visits[0].processTime = 88;
  assert.equal(logic.automaticTemplateName(logic.processProfile(value)), "PM1/PM2 → PM3");
});

test("Route 名称仅追加最小的有效驻留时间", () => {
  const value = route(["PM1", "PM2"], ["PM3"]);
  value.stages[0].visits[0].residencyConstraint = 45;
  value.stages[0].visits[1].residencyConstraint = 30;
  value.stages[1].visits[0].residencyConstraint = -1;
  assert.equal(logic.minimumResidencyConstraint(value), 30);
  assert.equal(
    logic.automaticRouteName(logic.processProfile(value), "", logic.minimumResidencyConstraint(value)),
    "PM1/PM2(20s) → PM3(20s) · 驻留 30s",
  );
  assert.equal(logic.minimumResidencyConstraint(route(["PM1"])), null);
});

test("同一加工路径按 Clean 引用生成不同名称", () => {
  const first = route(["PM1", "PM2"]);
  first.prePJobCleanRefs = ["PreA"];
  const second = structuredClone(first);
  second.prePJobCleanRefs = ["PreB"];
  assert.equal(logic.routeCleanSignature(first), "Pre:PreA");
  assert.equal(logic.routeCleanSignature(second), "Pre:PreB");
  assert.equal(
    logic.automaticRouteName(logic.processProfile(first), logic.routeCleanSignature(first)),
    "PM1/PM2(20s) · Pre:PreA",
  );
  assert.notEqual(
    logic.automaticRouteName(logic.processProfile(first), logic.routeCleanSignature(first)),
    logic.automaticRouteName(logic.processProfile(second), logic.routeCleanSignature(second)),
  );
});

test("加工 Step Clean 也进入 Route 名称", () => {
  const value = route(["PM1"], ["PM2"]);
  value.stages[0].visits[0].beforeCleanRefs = ["DummyA"];
  value.stages[1].visits[0].afterCleanRefs = ["WacA"];
  assert.equal(logic.routeCleanSignature(value), "S1前:DummyA · S2后:WacA");
});

test("Route 分组按工序数和候选数量序列排序", () => {
  const profiles = [route(["PM1", "PM2"], ["PM3"]), route(["PM1", "PM2"]), route(["PM1"])]
    .map(logic.processProfile).sort(logic.compareProfiles);
  assert.deepEqual(profiles.map(item => item.key), ["1:1", "1:2", "2:2,1"]);
});

test("运行时只提交测试任务实际引用的共享 Route", () => {
  const routes = [{ name: "R10" }, { name: "R20" }, { name: "Unused" }];
  const rounds = [
    { cjobs: [{ pjobs: [{ routeRef: "R10" }] }] },
    { cjobs: [{ pjobs: [{ routeRef: "R20" }, { routeRef: "R10" }] }] },
  ];
  assert.deepEqual(
    logic.selectReferencedRoutes(routes, rounds).map(item => item.name),
    ["R10", "R20"],
  );
});

test("加工 Step 的空 Recipe 使用稳定派生名称", () => {
  assert.equal(logic.processRecipeName("", "Route7_Step6"), "Route7_Step6");
  assert.equal(logic.processRecipeName("   ", "Route7_Step8"), "Route7_Step8");
  assert.equal(logic.processRecipeName("ExplicitRecipe", "Route7_Step6"), "ExplicitRecipe");
});

test("候选从加工腔改为 LoadLock 后清除继承的 ProcessRecipe", () => {
  const stage = { needProcess: true, visits: [visit("PM1", 20)] };
  logic.replaceCandidates(stage, ["LA", "LB"], name => visit(name));
  assert.ok(stage.visits.every(item => item.processRecipe === "R_Step4"));

  stage.needProcess = false;
  assert.equal(logic.normalizeStageProcessRecipes(stage, ""), true);
  assert.deepEqual(
    stage.visits.map(item => [item.stationName, item.processRecipe]),
    [["LA", ""], ["LB", ""]],
  );
  assert.equal(logic.normalizeStageProcessRecipes(stage, ""), false);
});

test("加工 Step 仍补齐派生 Recipe 并同步 Recipe Time", () => {
  const stage = {
    needProcess: true,
    visits: [{ ...visit("PM1", 30), processRecipe: "", recipeTime: 12 }],
  };
  assert.equal(logic.normalizeStageProcessRecipes(stage, "RouteA_Step4"), true);
  assert.equal(stage.visits[0].processRecipe, "RouteA_Step4");
  assert.equal(stage.visits[0].recipeTime, 30);
});

test("统一参数修改后深拷贝同步到全部候选 Visit", () => {
  const stage = { visits: [visit("PM1", 30), visit("PM2", 50)] };
  stage.visits[0].beforeCleanRefs = ["CleanA"];
  assert.deepEqual(logic.differenceFields(stage).sort(), ["beforeCleanRefs", "processTime", "recipeTime"]);
  logic.synchronizeVisits(stage);
  assert.equal(stage.visits[1].processTime, 30);
  assert.deepEqual(stage.visits[1].beforeCleanRefs, ["CleanA"]);
  assert.notStrictEqual(stage.visits[0].beforeCleanRefs, stage.visits[1].beforeCleanRefs);
  assert.notStrictEqual(stage.visits[0].weight, stage.visits[1].weight);
  assert.deepEqual(logic.differenceFields(stage), []);
});

test("新增候选继承统一参数，删除候选不改变剩余参数", () => {
  const stage = { visits: [visit("PM1", 42), visit("PM2", 42)] };
  stage.visits[0].afterCleanRefs = ["CleanB"];
  logic.synchronizeVisits(stage);
  logic.replaceCandidates(stage, ["PM1", "PM2", "PM3"], name => visit(name));
  const pm3 = stage.visits.find(item => item.stationName === "PM3");
  assert.equal(pm3.processTime, 42);
  assert.deepEqual(pm3.afterCleanRefs, ["CleanB"]);
  assert.notStrictEqual(pm3.afterCleanRefs, stage.visits[0].afterCleanRefs);
  logic.replaceCandidates(stage, ["PM1", "PM3"], name => visit(name));
  assert.deepEqual(stage.visits.map(item => item.stationName), ["PM1", "PM3"]);
  assert.ok(stage.visits.every(item => item.processTime === 42));
});
