const test = require("node:test");
const assert = require("node:assert/strict");

const { diagnoseSchedule } = require("../realtime_scheduler/analysis/schedule_analysis.js");

test("诊断把轨迹证据连接到可证伪的下一步实验", () => {
  const diagnostics = diagnoseSchedule({
    bottleneckCandidates: [{
      label: "工序 PM1 / PM2",
      kind: "process-group",
      confidence: "high",
      utilization: 0.94,
      continuity: 0.9,
    }],
    processChamberDwellTime: { meanSeconds: 6.5 },
    robotWaferDwellTime: { meanSeconds: 1.2 },
    departureIntervalCv: 0.31,
    completedWaferCount: 12,
  });

  assert.equal(diagnostics[0].confidence, "strong");
  assert.equal(diagnostics[0].nextExperiment.id, "processing-time-compare");
  assert.match(diagnostics[0].limitation, /执行轨迹/);
  assert.equal(diagnostics[1].nextExperiment.id, "load-level-compare");
});
