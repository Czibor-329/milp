"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeTestGroupPerformance,
} = require("../realtime_scheduler/analysis/schedule_analysis.js");

function performance(resource, utilization, throughput, cv, method = "steady-overlap") {
  return {
    window: { method },
    bottleneck: { name: resource, utilization },
    throughputPerHour: throughput,
    departureIntervalCv: cv,
  };
}

test("测试组分析同时报告加权、逐例和计算成本指标", () => {
  const result = analyzeTestGroupPerformance([
    {
      id: "a",
      name: "t1",
      status: "succeeded",
      validation: "passed",
      makespan: 80,
      baselineMakespan: 100,
      cpuTimeMs: 100,
      performance: performance("PM1", 0.8, 30, 0.2),
    },
    {
      id: "b",
      name: "t2",
      status: "succeeded",
      validation: "passed",
      makespan: 220,
      baselineMakespan: 200,
      cpuTimeMs: 300,
      performance: performance("PM1", 0.6, 20, 0.4),
    },
    {
      id: "c",
      name: "t3",
      status: "failed",
      validation: "failed",
      error: "invalid MoveList",
    },
  ]);

  assert.equal(result.totalCount, 3);
  assert.equal(result.succeededCount, 2);
  assert.equal(result.validationPassRate, 1);
  assert.equal(result.winCount, 1);
  assert.equal(result.regressionCount, 1);
  assert.equal(result.weightedImprovementPercent, 0);
  assert.equal(result.medianImprovementPercent, 5);
  assert.equal(result.medianCpuTimeMs, 200);
  assert.equal(result.p90CpuTimeMs, 280);
  assert.equal(result.medianBottleneckUtilization, 0.7);
  assert.deepEqual(result.bottleneckFrequencies[0], {
    resourceName: "PM1",
    count: 2,
    share: 1,
    medianUtilization: 0.7,
  });
});

test("缺少 Baseline 或性能数据时保持明确空值", () => {
  const result = analyzeTestGroupPerformance([{
    id: "a",
    name: "t1",
    status: "succeeded",
    validation: "passed",
    makespan: 50,
    cpuTimeMs: 20,
  }]);

  assert.equal(result.comparableCount, 0);
  assert.equal(result.weightedImprovementPercent, null);
  assert.equal(result.medianImprovementPercent, null);
  assert.equal(result.medianBottleneckUtilization, null);
  assert.equal(result.cases[0].improvementPercent, null);
});

