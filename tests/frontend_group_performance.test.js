"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeTestGroupPerformance,
} = require("../realtime_scheduler/analysis/schedule_analysis.js");

function performance(
  resource,
  utilization,
  throughput,
  cv,
  method = "steady-overlap",
  residence = { chamber: 0, robot: 0, system: 0, systemCv: 0 },
) {
  return {
    window: { method },
    bottleneck: { name: resource, utilization },
    throughputPerHour: throughput,
    departureIntervalCv: cv,
    processChamberDwellTime: { meanSeconds: residence.chamber, sampleCount: 1 },
    robotWaferDwellTime: { meanSeconds: residence.robot, sampleCount: 1 },
    waferSystemResidenceTime: {
      meanSeconds: residence.system,
      coefficientOfVariation: residence.systemCv,
      sampleCount: 1,
    },
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
      performance: performance(
        "PM1", 0.8, 30, 0.2, "steady-overlap",
        { chamber: 4, robot: 2, system: 40, systemCv: 0.1 },
      ),
    },
    {
      id: "b",
      name: "t2",
      status: "succeeded",
      validation: "passed",
      makespan: 220,
      baselineMakespan: 200,
      cpuTimeMs: 300,
      performance: performance(
        "PM1", 0.6, 20, 0.4, "steady-overlap",
        { chamber: 8, robot: 6, system: 80, systemCv: 0.3 },
      ),
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
  assert.equal(result.medianProcessChamberDwellMeanSeconds, 6);
  assert.equal(result.medianRobotWaferDwellMeanSeconds, 4);
  assert.equal(result.medianWaferSystemResidenceMeanSeconds, 60);
  assert.equal(result.medianWaferSystemResidenceCv, 0.2);
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

test("校验失败但保留指标的外部算法结果仍参与对比与测试组分析", () => {
  const result = analyzeTestGroupPerformance([{
    id: "external-invalid",
    name: "外部算法",
    status: "failed",
    validation: "failed",
    metricsAvailable: true,
    makespan: 80,
    baselineMakespan: 100,
    cpuTimeMs: 25,
    performance: performance("PM1", 0.75, 24, 0.3),
  }]);

  assert.equal(result.succeededCount, 0);
  assert.equal(result.metricsCount, 1);
  assert.equal(result.comparableCount, 1);
  assert.equal(result.weightedImprovementPercent, 20);
  assert.equal(result.medianCpuTimeMs, 25);
  assert.equal(result.validationPassRate, 0);
  assert.equal(result.bottleneckFrequencies[0].resourceName, "PM1");
});

test("测试组保留每例多个瓶颈候选并统计候选频次", () => {
  const result = analyzeTestGroupPerformance([{
    id: "a",
    name: "t1",
    status: "succeeded",
    validation: "passed",
    makespan: 90,
    baselineMakespan: 100,
    performance: {
      window: { method: "steady-overlap" },
      primaryBottleneck: {
        label: "VTR",
        utilization: 0.8,
      },
      bottleneckCandidates: [
        { label: "VTR", utilization: 0.8, score: 0.82, confidence: "high" },
        { label: "LoadLock 容量组 · LA / LB", utilization: 0.7, score: 0.7, confidence: "medium" },
      ],
      throughputPerHour: 30,
      departureIntervalCv: 0.2,
    },
  }]);

  assert.equal(result.cases[0].bottleneckCandidateCount, 2);
  assert.deepEqual(
    result.cases[0].bottleneckCandidates.map(item => item.resourceName),
    ["VTR", "LoadLock 容量组 · LA / LB"],
  );
  assert.deepEqual(
    result.bottleneckFrequencies.map(item => item.resourceName),
    ["VTR", "LoadLock 容量组 · LA / LB"],
  );
});
