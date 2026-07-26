"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../realtime_scheduler/frontend/workspace_visualizer_logic.js");

const device = {
  Stations: {
    LP1: { Type: "LoadPort" },
    LA: { Type: "LoadLock" },
    PM1: { Type: "Process" },
    PM2: { Type: "Process" },
    Cooler: { Type: "Cooler" },
  },
  Robots: {
    ATR: {},
    VTR: {},
  },
};

const moves = [
  {
    MoveID: 1,
    MoveType: 6,
    ModuleName: "PM1",
    StartTime: 0,
    EndTime: 1,
  },
  {
    MoveID: 2,
    MoveType: 2,
    ModuleName: "ATR",
    SrcStationList: ["LP1"],
    MatIDList: ["W1"],
    StartTime: 1,
    EndTime: 2,
  },
  {
    MoveID: 3,
    MoveType: 3,
    ModuleName: "ATR",
    DestStationList: ["PM1"],
    MatIDList: ["W1"],
    StartTime: 2,
    EndTime: 3,
  },
  {
    MoveID: 4,
    MoveType: 7,
    ModuleName: "PM1",
    StartTime: 3,
    EndTime: 4,
  },
];

function moduleAt(snapshot, name) {
  return snapshot.modules.find(module => module.name === name);
}

test("MoveList 输入同时支持数组和结果对象", () => {
  assert.equal(logic.normalizeMovePayload(moves).length, 4);
  assert.equal(logic.normalizeMovePayload({ MoveList: moves }).length, 4);
  assert.throws(
    () => logic.normalizeMovePayload({ moves }),
    /MoveList/,
  );
});

test("时间轴准确回放腔室门的开启和关闭过程", () => {
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 0.5), "PM1").door, "opening");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 1.5), "PM1").door, "open");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 3.5), "PM1").door, "closing");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 4), "PM1").door, "closed");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 2), "Cooler"), undefined);
});

test("设备拓扑只包含 MoveList 实际引用的腔室", () => {
  const snapshot = logic.buildWorkspaceSnapshot(moves, device, 2);
  assert.deepEqual(snapshot.modules.map(module => module.name), ["LP1", "PM1"]);
});

test("完成取放动作后晶圆位置与机器人状态一致", () => {
  const picking = logic.buildWorkspaceSnapshot(moves, device, 1.5);
  assert.equal(picking.robots[0].busy, true);
  assert.equal(picking.robots[0].target, "LP1");

  const picked = logic.buildWorkspaceSnapshot(moves, device, 2);
  assert.deepEqual(picked.robots[0].wafers, ["W1"]);

  const placed = logic.buildWorkspaceSnapshot(moves, device, 3);
  assert.deepEqual(moduleAt(placed, "PM1").wafers, ["W1"]);
  assert.deepEqual(placed.robots[0].wafers, []);
});

const performanceMoves = [
  ...[
    ["W1", "1.C1.P1", 1, 2],
    ["W2", "1.C1.P2", 9, 10],
    ["W3", "1.C1.P1", 39, 40],
    ["W4", "1.C1.P2", 49, 50],
  ].map(([material, pjob, start, end], index) => ({
    MoveID: 100 + index,
    MoveType: 0,
    ModuleName: "ATR",
    SrcStationList: ["LP1"],
    MatIDList: [material],
    PJobName: [pjob],
    StartTime: start,
    EndTime: end,
  })),
  ...[
    ["W1", "1.C1.P1", 3, 4],
    ["W2", "1.C1.P2", 11, 12],
    ["W3", "1.C1.P1", 41, 42],
    ["W4", "1.C1.P2", 51, 52],
  ].map(([material, pjob, start, end], index) => ({
    MoveID: 200 + index,
    MoveType: 0,
    ModuleName: "VTR",
    SrcStationList: ["LA"],
    MatIDList: [material],
    PJobName: [pjob],
    StartTime: start,
    EndTime: end,
  })),
  {
    MoveID: 300,
    MoveType: 6,
    ModuleName: "PM1",
    MatIDList: ["W2"],
    StartTime: 30,
    EndTime: 31,
  },
  {
    MoveID: 301,
    MoveType: 1,
    ModuleName: "VTR",
    DestStationList: ["PM1"],
    MatIDList: ["W2"],
    PJobName: ["1.C1.P2"],
    StartTime: 31,
    EndTime: 33,
  },
  {
    MoveID: 302,
    MoveType: 9,
    ModuleName: "PM1",
    MatIDList: ["W2"],
    PJobName: ["1.C1.P2"],
    StartTime: 33,
    EndTime: 40,
  },
  ...[
    ["W1", "1.C1.P1", 29, 30],
    ["W2", "1.C1.P2", 44, 45],
    ["W3", "1.C1.P1", 59, 60],
    ["W4", "1.C1.P2", 74, 75],
  ].map(([material, pjob, start, end], index) => ({
    MoveID: 400 + index,
    MoveType: 1,
    ModuleName: "ATR",
    DestStationList: ["LP1"],
    MatIDList: [material],
    PJobName: [pjob],
    StartTime: start,
    EndTime: end,
  })),
];

test("性能分析用首片完工到末片投料剔除启动与收尾", () => {
  const performance = logic.analyzeSchedulePerformance(performanceMoves, device, "steady");
  assert.equal(performance.window.method, "steady-overlap");
  assert.equal(performance.window.start, 30);
  assert.equal(performance.window.end, 50);
  assert.equal(performance.completedWaferCount, 2);
  assert.equal(performance.throughputPerHour, 240);
  assert.equal(performance.departureIntervalCv, 0);
  assert.equal(logic.analyzeSchedulePerformance(performanceMoves, device, "full").completedWaferCount, 4);
});

test("模块物理占用包含开门、取放和加工，未使用并行腔保留", () => {
  const performance = logic.analyzeSchedulePerformance(performanceMoves, device, "steady");
  const pm1 = performance.resources.find(resource => resource.name === "PM1");
  const pm2 = performance.resources.find(resource => resource.name === "PM2");
  assert.equal(pm1.busyTime, 10);
  assert.equal(pm1.utilization, 0.5);
  assert.equal(pm1.categoryTimes.door, 1);
  assert.equal(pm1.categoryTimes.transfer, 2);
  assert.equal(pm1.categoryTimes.process, 7);
  assert.equal(pm2.busyTime, 0);
  assert.equal(performance.bottleneck.name, "PM1");
});

test("清洁与门动作重叠时按物理并集计时", () => {
  const movesWithClean = [
    ...performanceMoves,
    {
      MoveID: 450,
      MoveType: 14,
      ModuleName: "PM2",
      StartTime: 34,
      EndTime: 39,
    },
    {
      MoveID: 451,
      MoveType: 6,
      ModuleName: "PM2",
      StartTime: 38,
      EndTime: 40,
    },
  ];
  const performance = logic.analyzeSchedulePerformance(movesWithClean, device, "steady");
  const pm2 = performance.resources.find(resource => resource.name === "PM2");
  assert.equal(pm2.busyTime, 6);
  assert.equal(pm2.categoryTimes.clean, 5);
  assert.equal(pm2.categoryTimes.door, 1);
});

test("性能分析导出真空端晶圆顺序和 Job 交织指标", () => {
  const performance = logic.analyzeSchedulePerformance(performanceMoves, device, "steady");
  assert.deepEqual(performance.vacuumQueue.map(item => item.material), ["W1", "W2", "W3", "W4"]);
  assert.deepEqual(performance.vacuumQueue.map(item => item.pjob), [
    "1.C1.P1",
    "1.C1.P2",
    "1.C1.P1",
    "1.C1.P2",
  ]);
  assert.equal(performance.vacuumQueueJobSwitchRatio, 1);
  assert.equal(performance.vacuumQueueLongestRun, 1);
});

test("LoadLock 换片中的生片也进入真空端队列", () => {
  const swapMoves = [
    ...performanceMoves,
    {
      MoveID: 500,
      MoveType: 4,
      ModuleName: "VTR",
      StationList: ["LA", "LA"],
      MatIDList: ["W5", "DONE"],
      RecvMatList: ["W5"],
      SendMatList: ["DONE"],
      PJobName: ["1.C1.P1", "1.C1.P1"],
      StartTime: 54,
      EndTime: 56,
    },
    {
      MoveID: 501,
      MoveType: 1,
      ModuleName: "VTR",
      DestStationList: ["PM2"],
      MatIDList: ["W5"],
      PJobName: ["1.C1.P1"],
      StartTime: 56,
      EndTime: 58,
    },
    {
      MoveID: 502,
      MoveType: 9,
      ModuleName: "PM2",
      MatIDList: ["W5"],
      PJobName: ["1.C1.P1"],
      StartTime: 58,
      EndTime: 65,
    },
  ];
  const queue = logic.analyzeSchedulePerformance(swapMoves, device, "steady").vacuumQueue;
  const swappedWafer = queue.find(item => item.material === "W5");
  assert.equal(swappedWafer.loadLock, "LA");
  assert.equal(swappedWafer.targetModule, "PM2");
  assert.equal(swappedWafer.processWait, 2);
});
