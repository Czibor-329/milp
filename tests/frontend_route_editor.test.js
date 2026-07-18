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

test("Route 只按加工工序数分组", () => {
  assert.equal(logic.processProfile(route(["PM1"])).label, "1道工序");
  assert.equal(logic.processProfile(route(["PM1", "PM2"])).label, "1道工序");
  assert.equal(logic.processProfile(route(["PM1", "PM2"], ["PM1", "PM2", "PM3"])).label, "2道工序");
  assert.equal(logic.processProfile({ stages: [{ needProcess: false, visits: [visit("ATR")] }] }).label, "无加工工序");
});

test("Route 名称由工序数、腔室种类和加工时间自动生成", () => {
  assert.equal(logic.automaticRouteName(logic.processProfile(route(["PM1"]))), "1道工序 · PM1(20s)");
  assert.equal(logic.automaticRouteName(logic.processProfile(route(["PM1", "PM2"]))), "1道工序 · PM1/PM2(20s)");
  assert.equal(logic.automaticRouteName(logic.processProfile(route(["PM1", "PM2"], ["PM3", "PM4"]))), "2道工序 · PM1/PM2(20s) → PM3/PM4(20s)");
});

test("示例 Route 覆盖 1–3 道工序且加工时间均为 40–120 秒", () => {
  const specs = logic.exampleRouteSpecs();
  assert.deepEqual([...new Set(specs.map(spec => spec.candidates.length))], [1, 2, 3]);
  assert.ok(specs.length >= 20);
  assert.ok(specs.every(spec => spec.times.length === spec.candidates.length));
  assert.ok(specs.flatMap(spec => spec.times).every(time => time >= 40 && time <= 120));
  assert.deepEqual(specs.slice(0, 4).map(spec => spec.candidates[0].length), [1, 1, 1, 2]);
});

test("Route 分组按工序数和候选数量序列排序", () => {
  const profiles = [route(["PM1", "PM2"], ["PM1"]), route(["PM1", "PM2"]), route(["PM1"])]
    .map(logic.processProfile).sort(logic.compareProfiles);
  assert.deepEqual(profiles.map(item => item.key), ["1", "1", "2"]);
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
