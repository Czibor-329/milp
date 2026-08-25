"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const logic = require("../realtime_scheduler/frontend/workspace_visualizer_logic.js");

function fixture() {
  return {
    schemaVersion: "production-metrics-v1",
    configuration: { sampleSize: 120, trimmedHeadWafers: 15, trimmedTailWafers: 15, minimumTotalWafers: 150 },
    calculationSeconds: 0.75,
    sampleWindow: { available: true, totalCompletedWafers: 150, selectedWaferCount: 120, waferIds: [], start: 1, end: 1201, durationSeconds: 1200, reason: "" },
    applicability: { sameRecipeAndPath: true, reason: "" },
    overall: { available: true, throughputPerHour: 360, rptMinutes: 0.333, parallelChamberCount: 2, reason: "" },
    chambers: [{ chamber: "PM1", stepId: "4", recipe: "R1", waferCount: 60, k: 59, throughputPerHour: 180, entryIntervalStdSeconds: 0.25, surpassWaferCount: 1, surpassRate: 1 / 59 }],
    modules: [{ name: "PM1", busyTimeSeconds: 900, utilization: 0.75 }],
  };
}

test("new production metrics render in a separate module with separate export", () => {
  const markup = logic.renderProductionMetrics(fixture());
  assert.match(markup, /指标导出参数设置 · 独立统计/);
  assert.match(markup, /data-production-metrics-export/);
  assert.match(markup, /实际 1→3→2/);
  assert.match(markup, /PM1 · 工序 4 · R1/);
});

test("production metrics CSV contains only the new metric families", () => {
  const csv = logic.productionMetricsCsv(fixture());
  assert.match(csv, /整体产能/);
  assert.match(csv, /进腔节拍标准差/);
  assert.match(csv, /超片率/);
  assert.match(csv, /模块,PM1,利用率/);
  assert.doesNotMatch(csv, /驻留时间/);
  assert.doesNotMatch(csv, /瓶颈证据/);
});
