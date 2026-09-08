"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const logic = require("../realtime_scheduler/frontend/workspace_visualizer_logic.js");
const frontendCss = fs.readFileSync(
  path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
  "utf8",
);

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

test("拓扑晶圆标签保留 ID 并显示首次来源模块和槽位", () => {
  const snapshot = logic.buildWorkspaceSnapshot([
    {
      MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"],
      SrcSlotList: [1], MatIDList: ["W1"], StartTime: 0, EndTime: 1,
    },
    {
      MoveID: 2, MoveType: 1, ModuleName: "ATR", DestStationList: ["PM1"],
      DestSlotList: [1], MatIDList: ["W1"], StartTime: 1, EndTime: 2,
    },
  ], device, 2);

  assert.equal(snapshot.waferOrigins.W1, "LP1.1");
  const markup = logic.renderEquipmentTopology(snapshot, null, new Set(), device);
  assert.match(markup, /class="wafer-origin-label">LP1\.1</);
  assert.doesNotMatch(markup, /wafer-dummy/);
});

test("Dummy 晶圆使用独立颜色，表面显示原始物料 ID", () => {
  const dummyDevice = {
    ...device,
    Stations: {
      ...device.Stations,
      DummyPort: { Type: "DummyPort" },
    },
  };
  const snapshot = logic.buildWorkspaceSnapshot([
    {
      MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["DummyPort"],
      SrcSlotList: [1], MatIDList: ["100000"], StartTime: 0, EndTime: 1,
    },
    {
      MoveID: 2, MoveType: 1, ModuleName: "ATR", DestStationList: ["PM1"],
      DestSlotList: [1], MatIDList: ["100000"], StartTime: 1, EndTime: 2,
    },
  ], dummyDevice, 2);

  assert.equal(snapshot.waferOrigins["100000"], "DummyPort.1");
  const markup = logic.renderEquipmentTopology(snapshot, null, new Set(), dummyDevice);
  assert.match(markup, /class="wafer-token wafer-unprocessed wafer-dummy"/);
  assert.match(markup, /class="wafer-origin-label">100000</);
  assert.doesNotMatch(markup, /class="wafer-origin-label">DummyPort\.1</);
  assert.match(markup, /title="晶圆 100000，来源 DummyPort\.1/);
  assert.match(frontendCss, /--sim-dummy:\s*#6d28d9/);
  assert.match(frontendCss, /\.wafer-token\.wafer-dummy/);
  assert.match(frontendCss, /\.front-slot\.is-dummy\.is-unprocessed::after \{ background: #6d28d9; \}/);

  const parked = logic.buildWorkspaceSnapshot([
    {
      MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["DummyPort"],
      SrcSlotList: [1], MatIDList: ["100000"], StartTime: 1, EndTime: 2,
    },
  ], dummyDevice, 0);
  const frontSlots = logic.renderFrontSlotOverview(parked.modules, parked.waferOrigins);
  assert.match(frontSlots, /front-slot is-unprocessed is-dummy/);
});

const deadlockStage = (stepId, stationName, postStepIds = []) => ({
  stepId,
  postStepIds,
  visits: [{ stationName }],
});

test("前端回放识别单臂持片且目标满腔依赖同一机器手排空", () => {
  const replayMoves = [
    {
      MoveID: 1, MoveType: 9, ModuleName: "PM1", MatIDList: ["W_OLD"],
      StepIDList: [0], PJobName: ["1.C1.P2"], StartTime: 0, EndTime: 1,
    },
    {
      MoveID: 2, MoveType: 0, ModuleName: "R", SrcStationList: ["LP1"],
      MatIDList: ["W_NEW"], StepIDList: [1], PJobName: ["1.C1.P1"],
      StartTime: 1, EndTime: 2,
    },
  ];
  const replayDevice = {
    Stations: { LP1: { Type: "LoadPort" }, PM1: { Type: "ProcessChamber", Capacity: 1 } },
    Robots: { R: { Capacity: 1, Slot: [1] } },
  };
  const replayPlan = {
    routes: [
      { name: "Incoming", stages: [deadlockStage(0, "LP1", [1]), deadlockStage(1, "R", [2]), deadlockStage(2, "PM1")] },
      { name: "Outgoing", stages: [deadlockStage(0, "PM1", [1]), deadlockStage(1, "R", [2]), deadlockStage(2, "LP1")] },
    ],
    rounds: [{ cjobs: [{ key: "C1", pjobs: [
      { jobName: "P1", routeRef: "Incoming" },
      { jobName: "P2", routeRef: "Outgoing" },
    ] }] }],
  };

  const deadlock = logic.detectTerminalPlaybackDeadlock(replayMoves, replayDevice, replayPlan);

  assert.equal(deadlock.Code, "DEADLOCK.SINGLE_ARM_TARGET_FULL");
  assert.match(deadlock.Message, /R.*唯一手臂.*W_NEW.*PM1.*W_OLD.*没有空手接走腔内晶圆.*相互等待/);
});

test("前端回放识别双臂单片持有且目标满腔无交换出口", () => {
  const replayMoves = [
    {
      MoveID: 1, MoveType: 5, ModuleName: "R", SrcStationList: ["PM2"],
      DestStationList: ["LL1"], MatIDList: ["W_HELD"], StepIDList: [0],
      StartTime: 0, EndTime: 0.5,
    },
    {
      MoveID: 2, MoveType: 9, ModuleName: "PM1", MatIDList: ["W_BLOCKING"],
      StepIDList: [0], PJobName: ["1.C1.P2"], StartTime: 0, EndTime: 1,
      CleanTaskName: "PreDummyClean", ProcessRecipe: "DummyCleanRecipe",
      IsLastCleanTaskMove: false,
    },
    {
      MoveID: 3, MoveType: 0, ModuleName: "R", SrcStationList: ["LL1"],
      MatIDList: ["W_HELD"], StepIDList: [1], PJobName: ["1.C1.P1"],
      StartTime: 1, EndTime: 2,
    },
  ];
  const replayDevice = {
    Stations: {
      LL1: { Type: "LoadLock", Capacity: 1 },
      PM1: { Type: "ProcessChamber", Capacity: 1 },
      PM2: { Type: "ProcessChamber", Capacity: 1 },
    },
    Robots: { R: { Capacity: 2, Slot: [1, 2] } },
  };
  const replayPlan = {
    routes: [
      { name: "Incoming", stages: [deadlockStage(0, "LL1", [1]), deadlockStage(1, "R", [2]), deadlockStage(2, "PM1")] },
      { name: "Outgoing", stages: [deadlockStage(0, "PM1", [1]), deadlockStage(1, "R", [2]), deadlockStage(2, "LL1")] },
    ],
    rounds: [{ cjobs: [{ key: "C1", pjobs: [
      { jobName: "P1", routeRef: "Incoming" },
      { jobName: "P2", routeRef: "Outgoing" },
    ] }] }],
  };

  const deadlock = logic.detectTerminalPlaybackDeadlock(replayMoves, replayDevice, replayPlan);

  assert.equal(deadlock.Code, "DEADLOCK.DUAL_ARM_SINGLE_HELD_TARGET_FULL");
  assert.match(deadlock.Message, /R.*W_HELD.*PM1.*尚未完成整组 PreDummyClean.*W_BLOCKING/);
  assert.match(deadlock.Message, /W_HELD.*清洗完成前禁止进入.*不能直接换片.*只能由 R 取出/);
});

test("前端回放识别双臂同时持有两片且目标腔室均已满", () => {
  const replayMoves = [
    ...[1, 2].map((number) => ({
      MoveID: number, MoveType: 9, ModuleName: `PM${number}`, MatIDList: [`W_OLD_${number}`],
      StepIDList: [0], PJobName: [`1.C1.P${number + 2}`], StartTime: 0, EndTime: 1,
    })),
    {
      MoveID: 3, MoveType: 2, ModuleName: "R", SrcStationList: ["LP1", "LP1"],
      MatIDList: ["W_NEW_1", "W_NEW_2"], StepIDList: [1, 1],
      PJobName: ["1.C1.P1", "1.C1.P2"], StartTime: 1, EndTime: 2,
    },
  ];
  const replayDevice = {
    Stations: {
      LP1: { Type: "LoadPort" },
      PM1: { Type: "ProcessChamber", Capacity: 1 },
      PM2: { Type: "ProcessChamber", Capacity: 1 },
    },
    Robots: { R: { Capacity: 2, Slot: [1, 2] } },
  };
  const route = (name, source, target) => ({
    name,
    stages: [deadlockStage(0, source, [1]), deadlockStage(1, "R", [2]), deadlockStage(2, target)],
  });
  const replayPlan = {
    routes: [
      route("Incoming1", "LP1", "PM1"), route("Incoming2", "LP1", "PM2"),
      route("Outgoing1", "PM1", "LP1"), route("Outgoing2", "PM2", "LP1"),
    ],
    rounds: [{ cjobs: [{ key: "C1", pjobs: [
      { jobName: "P1", routeRef: "Incoming1" }, { jobName: "P2", routeRef: "Incoming2" },
      { jobName: "P3", routeRef: "Outgoing1" }, { jobName: "P4", routeRef: "Outgoing2" },
    ] }] }],
  };

  const deadlock = logic.detectTerminalPlaybackDeadlock(replayMoves, replayDevice, replayPlan);

  assert.equal(deadlock.Code, "DEADLOCK.DUAL_ARM_TARGETS_FULL");
  assert.match(deadlock.Message, /R.*两只手臂.*W_NEW_1、W_NEW_2.*PM1、PM2.*没有空手接走.*W_OLD_1、W_OLD_2.*相互等待/);
});

test("Move 位置回放不自洽时不继续猜测死锁类型", () => {
  const invalidMoves = [
    {
      MoveID: 1, MoveType: 0, ModuleName: "R", SrcStationList: ["LP1"],
      MatIDList: ["W1"], StepIDList: [1], PJobName: ["1.C1.P1"], StartTime: 0, EndTime: 1,
    },
    {
      MoveID: 2, MoveType: 0, ModuleName: "R", SrcStationList: ["PM1"],
      MatIDList: ["W1"], StepIDList: [1], PJobName: ["1.C1.P1"], StartTime: 1, EndTime: 2,
    },
  ];
  const replayDevice = {
    Stations: { LP1: { Type: "LoadPort" }, PM1: { Type: "ProcessChamber", Capacity: 1 } },
    Robots: { R: { Capacity: 1 } },
  };
  const replayPlan = {
    routes: [{ name: "Route", stages: [
      deadlockStage(0, "LP1", [1]), deadlockStage(1, "R", [2]), deadlockStage(2, "PM1"),
    ] }],
    rounds: [{ cjobs: [{ key: "C1", pjobs: [{ jobName: "P1", routeRef: "Route" }] }] }],
  };

  assert.equal(logic.detectTerminalPlaybackDeadlock(invalidMoves, replayDevice, replayPlan), null);
});

function moduleAt(snapshot, name) {
  return snapshot.modules.find(module => module.name === name);
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    names.forEach(name => this.values.add(name));
  }

  remove(...names) {
    names.forEach(name => this.values.delete(name));
  }

  toggle(name, force) {
    if (force === true) this.values.add(name);
    else if (force === false) this.values.delete(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
  }
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.href = "";
    this.value = "";
    this.min = "";
    this.max = "";
    this.step = "";
    this.innerHTML = "";
    this.textContent = "";
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.label = null;
    this.style = { setProperty() {} };
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector) {
    return selector === "span" ? this.label : null;
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.clicked = true;
    this.listeners.get("click")?.({ preventDefault() {} });
  }
}

function fakeWorkspaceDocument() {
  const ids = [
    "visualToolbar",
    "testGroupAnalysisPanel",
    "visualEmpty",
    "visualPlaybackEmpty",
    "visualContent",
    "visualTopologyPlayback",
    "visualDeviceStage",
    "visualDecisionLens",
    "visualActionStatusFilter",
    "visualActionKindFilter",
    "visualPauseOnDecisionChangeButton",
    "visualActiveMoves",
    "visualSource",
    "visualCurrentTime",
    "visualTotalTime",
    "visualProgressText",
    "visualMoveText",
    "visualWaferText",
    "visualTimeline",
    "visualPlayButton",
    "visualSpeed",
    "visualFileInput",
    "visualOpenGantt",
    "workspaceResultButton",
    "visualPerformance",
    "performanceWindow",
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement()]));
  const workspaceTab = new FakeElement();
  return {
    elements,
    workspaceTab,
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    querySelector(selector) {
      return selector === '[data-tab-target="workspace"]' ? workspaceTab : null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

test("MoveList 输入同时支持数组和结果对象", () => {
  assert.equal(logic.normalizeMovePayload(moves).length, 4);
  assert.equal(logic.normalizeMovePayload({ MoveList: moves }).length, 4);
  assert.throws(
    () => logic.normalizeMovePayload({ moves }),
    /MoveList/,
  );
});

test("回放进度、MoveList 与中文工具入口合并在顶部紧凑工具栏", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/config_editor.html"),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
    "utf8",
  );
  const toolbarStart = html.indexOf('<section class="timeline-console petri-top-playback-controls"');
  const toolbarEnd = html.indexOf("</section>", toolbarStart);
  const toolbar = html.slice(toolbarStart, toolbarEnd);
  assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart);
  assert.match(toolbar, /class="timeline-primary-zone"[\s\S]*class="timeline-range"[\s\S]*class="timeline-tools-zone"/);
  assert.match(toolbar, /id="visualPlayButton"/);
  assert.match(toolbar, /id="visualSource"[^>]*title="—"/);
  assert.match(toolbar, /id="visualTimeline"/);
  assert.match(toolbar, /id="visualImportButton"[^>]*>[\s\S]*导入 MoveList/);
  assert.match(toolbar, /id="visualOpenGantt"[^>]*>[\s\S]*打开甘特图/);
  assert.match(css, /\.petri-top-playback-controls \{[^\n]*--playback-control-height: 44px/);
  assert.match(css, /grid-template-columns: auto minmax\(320px, 1fr\) auto/);
  assert.match(css, /@media \(max-width: 1100px\)/);
  assert.match(css, /@media \(max-width: 800px\)[\s\S]*grid-template-areas: "primary tools" "range range"/);
  assert.match(css, /\.petri-top-playback-controls :is\([^\n]*:focus-visible/);
  assert.doesNotMatch(html, /petri-utils/);
  assert.match(html, /id="visualPauseOnDecisionChangeButton"/);
  assert.doesNotMatch(html, /id="visualTransitionButtons"|MODEL EVALUATION/);
});

test("正视槽位卡片按内容收缩，不以画布高度拉长模块槽位", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
    "utf8",
  );
  assert.match(css, /\.topology-front-slot-card \{[^}]*height:\s*auto;[^}]*max-height:\s*var\(--topology-canvas-height, 640px\);/);
  assert.match(css, /\.topology-front-slot-card \{[^}]*align-content:\s*start;/);
  assert.match(css, /\.front-slot-row \{[^}]*align-items:\s*start;/);
  assert.match(css, /\.front-slot-board \{[^}]*height:\s*auto;[^}]*align-self:\s*start;/);
});

test("合法动作空间面板保持两列卡片与默认全状态视觉契约", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/config_editor.html"),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
    "utf8",
  );
  const source = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/src/config_editor.ts"),
    "utf8",
  );

  assert.match(html, /<h2 class="petri-panel-title">合法动作空间<\/h2>/);
  assert.match(html, /data-action-status-filter value="enabled" checked/);
  assert.match(html, /data-action-status-filter value="physical-blocked" checked/);
  assert.match(html, /data-action-status-filter value="deadlock-blocked" checked/);
  assert.match(css, /\.decision-lens-panel[^\n]*border-radius: 6px[^\n]*box-shadow: none/);
  assert.match(css, /\.action-filter-controls/);
  assert.match(css, /grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /\.action-card:hover \.action-status-tooltip/);
  assert.doesNotMatch(css, /body\.theme-dark/);
  assert.doesNotMatch(html, /themeToggle|logoutButton|adminUsersLink/);
  assert.doesNotMatch(css, /\.topology-playback\.is-instant-state-transition/);
  assert.doesNotMatch(source, /visualRecommendationModelControl|visualRecommendationModel/);
  assert.doesNotMatch(source, /根节点全部合法动作|物料 \$\{action\.materialIds/);
  assert.doesNotMatch(css, /decision-selected-summary|decision-preference-track|decision-auto-pause:hover|decision-candidate:hover/);
});

test("完整 Pick + Place 只在 Place 结束时形成下一决策边界", () => {
  assert.deepEqual(logic.decisionBoundaryTimes(moves), [3]);
  assert.deepEqual(logic.primitiveDecisionBoundaryTimes(moves), [2, 3]);
  assert.deepEqual(logic.decisionBoundaryTimes([
    ...moves,
    { MoveID: 5, MoveType: 4, StartTime: 5, EndTime: 7 },
  ]), [3, 7]);
});

test("结果分析与拓扑回放使用独立界面并共享当前 MoveList", async () => {
  const root = fakeWorkspaceDocument();
  const workspace = logic.createVisualizationWorkspace(root);
  const topology = root.elements.get("visualTopologyPlayback");

  assert.equal(topology.hidden, true);
  assert.equal(root.elements.get("visualPlaybackEmpty").hidden, false);

  workspace.showGroupAnalysis("<h2>组级统计</h2>");
  assert.equal(root.elements.get("visualToolbar").hidden, false);
  assert.equal(root.elements.get("testGroupAnalysisPanel").hidden, false);
  assert.equal(root.elements.get("visualContent").hidden, true);
  assert.equal(root.elements.get("visualEmpty").hidden, true);

  await workspace.loadFile({
    name: "t1.json",
    async text() {
      return JSON.stringify({
        MoveList: moves,
        DecisionTrace: [{
          decisionIndex: 0,
          time: 0,
          candidateCount: 1,
          candidates: [{
            actionId: "a", rank: 1, selected: true, destination: "PM2",
            policyPreference: 1,
          }],
        }],
      });
    },
  });
  assert.equal(root.elements.get("visualToolbar").hidden, false);
  assert.equal(root.elements.get("testGroupAnalysisPanel").hidden, true);
  assert.equal(root.elements.get("visualContent").hidden, false);
  assert.equal(topology.hidden, false);
  assert.equal(root.elements.get("visualPlaybackEmpty").hidden, true);
  assert.equal(root.elements.get("visualSource").title, "t1.json");
  const lens = root.elements.get("visualDecisionLens").innerHTML;
  assert.match(lens, /当前动作卡片为空/);
  assert.doesNotMatch(lens, /E2E推荐|Δ 基准|模型偏好|剩余工期/);
  assert.doesNotMatch(root.elements.get("visualDeviceStage").innerHTML, /PM2/);

  const pauseOnChange = root.elements.get("visualPauseOnDecisionChangeButton");
  assert.equal(pauseOnChange.getAttribute("aria-pressed"), "false");
  assert.equal(pauseOnChange.getAttribute("aria-checked"), "false");
  pauseOnChange.click();
  assert.equal(pauseOnChange.getAttribute("aria-pressed"), "true");
  assert.equal(pauseOnChange.getAttribute("aria-checked"), "true");
  assert.match(pauseOnChange.innerHTML, /已开启/);

  workspace.showGroupAnalysis("<h2>组级统计</h2>");
  assert.equal(topology.hidden, false);
  assert.equal(root.elements.get("visualContent").hidden, true);

  workspace.show();
  assert.equal(root.elements.get("testGroupAnalysisPanel").hidden, true);
  assert.equal(root.elements.get("visualContent").hidden, false);
  assert.equal(root.workspaceTab.clicked, true);
});

test("动作空间按状态筛选并把原因放进悬浮提示", () => {
  const decision = logic.normalizeDecisionTrace({ DecisionTrace: [{
    model: "actions",
    time: 10,
    actionDiagnosticsSource: "algorithm",
    actionDiagnosticsProvider: "fixture",
    actionCounts: { enabled: 1, "physical-blocked": 1, "deadlock-blocked": 1 },
    actionDiagnostics: [
      { actionId: "p1", kind: "pick", status: "enabled", robot: "ATR", source: "LP1", sourceSlot: 1, destination: "ATR", destinationSlot: 1, materialIds: ["1"], reason: "当前物理可行，死锁规则允许执行" },
      { actionId: "p2", kind: "place", status: "physical-blocked", robot: "ATR", source: "ATR", sourceSlot: 1, destination: "LA", destinationSlot: 1, reason: "目标槽已满", duplicateCount: 23 },
      { actionId: "s1", kind: "swap", status: "deadlock-blocked", robot: "VTR", source: "VTR", sourceSlot: 1, destination: "PM2", destinationSlot: 1, materialIds: ["1", "2"], reason: "无回程槽" },
    ],
  }] })[0];

  const enabled = logic.renderDecisionLens(decision, "idle", "", ["enabled"]);
  assert.match(enabled, /Pick\(1\) LP1#1 → ATR#1/);
  assert.match(enabled, /action-status-tooltip[\s\S]*当前物理可行/);
  assert.doesNotMatch(enabled, /decision-tag action-status|action-block-reason|目标槽已满|无回程槽|E2E|推荐|剩余工期|LA#1/);
  const blockedSwap = logic.renderDecisionLens(decision, "idle", "", ["deadlock-blocked"]);
  assert.match(blockedSwap, /Swap\(1,2\) VTR#1 → PM2#1/);
  assert.doesNotMatch(blockedSwap, /decision-tag action-status/);
  assert.match(blockedSwap, /action-status-tooltip[\s\S]*无回程槽/);
  assert.doesNotMatch(blockedSwap, /<p class="action-block-reason">/);
  const blockedPlace = logic.renderDecisionLens(decision, "idle", "", ["physical-blocked"]);
  assert.match(blockedPlace, /Place ATR#1 → LA#1/);
  assert.match(blockedPlace, /另 23 片相同/);
});

test("旧模型推荐轨迹不再进入动作状态卡片", async () => {
  const root = fakeWorkspaceDocument();
  const workspace = logic.createVisualizationWorkspace(root);
  await workspace.loadFile({
    name: "dual-actor-decision.json",
    async text() {
      return JSON.stringify({
        MoveList: moves,
        DecisionTraceMeta: {
          schema: "dual-actor-primitive-decision-trace-v1",
          model: "双 Actor 原子调度",
        },
        DecisionTrace: [{
          model: "dual-actor-e2e",
          decisionIndex: 12,
          time: 0,
          candidateGroups: [
            {
              actor: "atmosphere",
              label: "大气端 Actor",
              selectedActionId: "atr-pick",
              candidateCount: 2,
              candidates: [
                { actionId: "atr-place", actor: "atmosphere", kind: "place", robot: "ATR", source: "ATR", destination: "LA", rank: 2, policyPreference: 0.2, expectedRemainingCost: 18 },
                { actionId: "atr-pick", actor: "atmosphere", kind: "pick", robot: "ATR", source: "LP1", destination: "Robot hand", rank: 1, selected: true, policyPreference: 0.8, expectedRemainingCost: 11 },
              ],
            },
            {
              actor: "vacuum",
              label: "真空端 Actor",
              selectedActionId: "vtr-swap",
              candidateCount: 1,
              candidates: [
                { actionId: "vtr-swap", actor: "vacuum", kind: "swap", robot: "VTR", source: "PM1", destination: "PM2", rank: 1, selected: true, policyPreference: 1, expectedRemainingCost: 9 },
              ],
            },
          ],
        }],
      });
    },
  });

  const lens = root.elements.get("visualDecisionLens").innerHTML;
  assert.match(lens, /当前动作卡片为空/);
  assert.doesNotMatch(lens, /Actor|推荐|policyPreference/);
});

test("双 Actor 原始决策按最终定时 MoveList 的物理动作时刻对齐", () => {
  const trace = logic.normalizeDecisionTrace({
    DecisionTraceMeta: {
      schema: "dual-actor-primitive-decision-trace-v1",
      model: "双 Actor 原子调度",
    },
    DecisionTrace: [
      {
        model: "dual-actor-e2e",
        decisionIndex: 1,
        time: 0,
        selectedActionId: "atr:pick:W1:LP1",
        proposals: [{
          actor: "atmosphere",
          actionId: "atr:pick:W1:LP1",
          kind: "pick",
          robot: "ATR",
          materialIds: ["W1"],
          source: "LP1",
          selected: true,
        }],
      },
      {
        model: "dual-actor-e2e",
        decisionIndex: 2,
        time: 0,
        selectedActionId: "atr:place:W1:LA",
        proposals: [{
          actor: "atmosphere",
          actionId: "atr:place:W1:LA",
          kind: "place",
          robot: "ATR",
          materialIds: ["W1"],
          source: "LP1",
          destination: "LA",
          selected: true,
        }],
      },
    ],
  });
  const aligned = logic.alignOriginalDecisionTraceToMoves(trace, [
    {
      MoveID: 10, MoveType: 0, StartTime: 12.5, EndTime: 14,
      Robot: "ATR", ModuleName: "ATR", MatIDList: ["W1"], SrcStationList: ["LP1"],
    },
    {
      MoveID: 11, MoveType: 1, StartTime: 18.75, EndTime: 20,
      Robot: "ATR", ModuleName: "ATR", MatIDList: ["W1"], DestStationList: ["LA"],
    },
  ]);

  assert.deepEqual(aligned.map(step => step.time), [12.5, 18.75]);
  assert.deepEqual(
    aligned.map(step => step.executedActionId),
    ["atr:pick:W1:LP1", "atr:place:W1:LA"],
  );
  assert.ok(aligned.every(step => step.modelEvaluated && !step.replayEvaluated));
  assert.ok(aligned.every(step => step.candidates.some(candidate => candidate.executed)));
});

test("旧联合动作推荐不再进入动作状态卡片", async () => {
  const root = fakeWorkspaceDocument();
  const workspace = logic.createVisualizationWorkspace(root);
  await workspace.loadFile({
    name: "reentrant-priority.json",
    async text() {
      return JSON.stringify({
        MoveList: moves,
        DecisionTrace: [{
          decisionIndex: 7,
          time: 188.7,
          selectedActionId: "pm-reentry",
          executedActionId: "pm-reentry",
          candidateCount: 2,
          candidates: [
            {
              actionId: "feed-later", rank: 2, source: "LP1", destination: "LB",
              robot: "ATR", flowKind: "feed", policyPreference: 0.9,
              priorityDeferred: true,
            },
            {
              actionId: "pm-reentry", rank: 1, source: "PM3", destination: "PM2",
              robot: "VTR", flowKind: "internal", policyPreference: 0.1,
              selected: true, executed: true,
            },
          ],
        }],
      });
    },
  });

  const lens = root.elements.get("visualDecisionLens").innerHTML;
  assert.match(lens, /当前动作卡片为空/);
  assert.doesNotMatch(lens, /E2E推荐|与计划一致/);
});

test("开启保护后，回放在下一个原子动作边界暂停", async () => {
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const originalCancelAnimationFrame = global.cancelAnimationFrame;
  let scheduledFrame = null;
  global.requestAnimationFrame = callback => {
    scheduledFrame = callback;
    return 1;
  };
  global.cancelAnimationFrame = () => {};

  try {
    const root = fakeWorkspaceDocument();
    const workspace = logic.createVisualizationWorkspace(root);
    await workspace.loadFile({
      name: "decision-change.json",
      async text() {
        return JSON.stringify({
          MoveList: moves,
          DecisionTrace: [
            {
              decisionIndex: 0,
              time: 0,
              candidateCount: 1,
              candidates: [{ actionId: "move-a", rank: 1, selected: true }],
            },
            {
              decisionIndex: 1,
              time: 3,
              candidateCount: 2,
              candidates: [
                { actionId: "move-b", rank: 1, selected: true },
                { actionId: "move-c", rank: 2 },
              ],
            },
          ],
        });
      },
    });

    const autoPause = root.elements.get("visualPauseOnDecisionChangeButton");
    autoPause.click();
    root.elements.get("visualPlayButton").click();
    assert.match(root.elements.get("visualPlayButton").innerHTML, /暂停/);
    assert.equal(typeof scheduledFrame, "function");

    scheduledFrame(performance.now() + 800);
    assert.match(root.elements.get("visualPlayButton").innerHTML, /播放/);
    assert.match(autoPause.innerHTML, /已暂停/);
    assert.equal(root.elements.get("visualCurrentTime").textContent, "2.0");
    assert.equal(autoPause.getAttribute("aria-checked"), "true");
    assert.equal(autoPause.getAttribute("aria-label"), "已到达下一个原子动作决策，回放已暂停");
  } finally {
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("Alpha 实时步进从当前状态播放到新提交状态而不是直接跳转", () => {
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const originalCancelAnimationFrame = global.cancelAnimationFrame;
  let scheduledFrame = null;
  global.requestAnimationFrame = callback => {
    scheduledFrame = callback;
    return 1;
  };
  global.cancelAnimationFrame = () => {};

  try {
    const root = fakeWorkspaceDocument();
    const workspace = logic.createVisualizationWorkspace(root);
    workspace.beginLiveSolve({}, "Alpha 实时步进");
    workspace.updateLiveMoves(moves, true, true);

    assert.match(root.elements.get("visualPlayButton").innerHTML, /暂停/);
    assert.equal(root.elements.get("visualCurrentTime").textContent, "0.0");
    assert.equal(typeof scheduledFrame, "function");

    scheduledFrame(performance.now() + 100);
    const current = Number.parseFloat(root.elements.get("visualCurrentTime").textContent);
    assert.ok(current > 0 && current < 4, `应处于过渡动画中，实际为 ${current}`);
  } finally {
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("时间轴准确回放腔室门的开启和关闭过程", () => {
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 0.5), "PM1").door, "opening");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 1.5), "PM1").door, "open");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 3.5), "PM1").door, "closing");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 4), "PM1").door, "closed");
  assert.equal(moduleAt(logic.buildWorkspaceSnapshot(moves, device, 2), "Cooler"), undefined);
});

test("短门动作、LoadLock 相位和 PRE_TRANS 转位保持可观察", () => {
  const animationMoves = [
    {
      MoveID: 1, MoveType: 5, ModuleName: "ATR", Robot: "ATR",
      SrcStationList: ["LP1"], DestStationList: ["LA"],
      StartTime: 0, EndTime: 10,
    },
    {
      MoveID: 2, MoveType: 10, ModuleName: "LA",
      LastState: "ATR", CurState: "VTR", StartTime: 0, EndTime: 10,
    },
    {
      MoveID: 3, MoveType: 6, ModuleName: "PM1",
      StartTime: 9, EndTime: 9.1,
    },
  ];
  const snapshot = logic.buildWorkspaceSnapshot(animationMoves, device, 9.4);
  assert.equal(moduleAt(snapshot, "PM1").door, "opening");
  assert.equal(moduleAt(snapshot, "LA").loadLockPhase, "pumping");
  assert.equal(snapshot.robots[0].source, "LP1");
  assert.equal(snapshot.robots[0].target, "LA");
  assert.equal(snapshot.robots[0].isPreTrans, true);
  assert.ok(Math.abs(snapshot.robots[0].preTransProgress - 0.94) < 1e-9);
});

test("设备拓扑只包含 MoveList 实际引用的腔室", () => {
  const snapshot = logic.buildWorkspaceSnapshot(moves, device, 2);
  assert.deepEqual(snapshot.modules.map(module => module.name), ["LP1", "PM1"]);
});

test("拓扑回放补全设备配置中未被 MoveList 引用的腔室", () => {
  const snapshot = logic.buildWorkspaceSnapshot(moves, device, 0);
  assert.deepEqual(snapshot.modules.map(module => module.name), ["LP1", "PM1"]);
  const full = logic.snapshotWithFullDeviceModules(snapshot, device);
  assert.deepEqual(
    full.modules.map(module => module.name),
    ["Cooler", "LA", "LP1", "PM1", "PM2"],
  );
  const cooler = full.modules.find(module => module.name === "Cooler");
  assert.equal(cooler.status, "idle");
  assert.equal(cooler.door, "doorless");
  assert.equal(cooler.type, "Cooler");
  assert.equal(full.modules.find(module => module.name === "LA").door, "closed");
});

function positionsFromTopology(topology) {
  const positions = [];
  const pattern = /class="reference-(module|robot)-position" style="--(?:module|robot)-left:([\d.]+)%;--(?:module|robot)-top:(\d+)px[^\"]*">([\s\S]*?)(?=<div class="reference-|\s*<svg class="topology-target-arrows)/g;
  let match;
  while ((match = pattern.exec(topology)) !== null) {
    const isRobot = match[1] === "robot";
    const isLoadLock = /class="equipment-card equipment-lock\b/.test(match[4]);
    const isProcess = /class="equipment-card equipment-process\b/.test(match[4]);
    const isLoadPort = /class="load-port-assembly\b/.test(match[4]);
    const isBuffer = /class="equipment-utility equipment-buffer\b/.test(match[4]);
    const isCooler = /class="equipment-utility equipment-cooler\b/.test(match[4]);
    const isAligner = /class="equipment-utility equipment-aligner\b/.test(match[4]);
    positions.push({
      x: Number(match[2]) / 100 * 1000,
      y: Number(match[3]),
      width: isRobot ? 96 : isLoadLock ? 82 : isLoadPort ? 112 : isBuffer ? 104 : isCooler || isAligner ? 76 : isProcess ? 82 : 96,
      height: isRobot ? 96 : isLoadLock ? 82 : isLoadPort ? 104 : isBuffer || isCooler ? 56 : isAligner ? 54 : isProcess ? 82 : 96,
    });
  }
  return positions;
}

function assertTopologyComplete(topology, requiredNames) {
  for (const name of requiredNames) {
    assert.match(topology, new RegExp(`>${name}<`), `拓扑应包含 ${name}`);
  }
  const positions = positionsFromTopology(topology);
  assert.ok(positions.length >= requiredNames.length);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const a = positions[i];
      const b = positions[j];
      const overlaps = Math.abs(a.x - b.x) < (a.width + b.width) / 2
        && Math.abs(a.y - b.y) < (a.height + b.height) / 2;
      assert.equal(overlaps, false, `模块位置重叠：${JSON.stringify([a, b])}`);
    }
  }
}

test("单真空机械手拓扑以方框架固定四个 PM、Heater 与两把 LoadLock", () => {
  const fullDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" },
      LP3: { Type: "LoadPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      PM1: { Type: "ProcessChamber" }, PM2: { Type: "ProcessChamber" },
      PM3: { Type: "ProcessChamber" }, PM4: { Type: "ProcessChamber" },
      Aligner: { Type: "Aligner" }, heater: { Type: "Heater" },
      Cooler: { Type: "Cooler" }, DummyPort: { Type: "LoadPort" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR: { Type: "VTMRobot" } },
  };
  const required = [
    "LP1", "LP2", "LP3", "DummyPort", "Aligner", "Cooler",
    "LA", "LB", "heater", "PM1", "PM2", "PM3", "PM4",
  ];
  const snapshot = logic.buildWorkspaceSnapshot(moves, fullDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, fullDevice),
    null,
  );
  assertTopologyComplete(topology, required);
  assert.match(topology, />LP2</);
  assert.match(topology, />LP3</);
  assert.match(topology, /class="equipment-card equipment-port-top-view[^\"]*is-dummy-port/);
  assert.doesNotMatch(topology, /class="load-port-kind"|>DUMMY</);
  assert.match(topology, /class="equipment-utility equipment-cooler/);
  assert.match(topology, />heater</i);
  assert.match(topology, /class="topology-machine-frame topology-machine-frame-square"/);
  assert.doesNotMatch(topology, /DEVICE TOPOLOGY|设备配置全量模块/);
  assert.match(topology, /data-attachment-id="atmosphere-port-1@bottom"/);
  assert.match(topology, /--topology-canvas-height:\d+px/);
  assert.doesNotMatch(topology, /topology-zone|真空加工区|大气传输区/);
  assert.doesNotMatch(topology, /topology-interface-bay|VACUUM \/ ATM INTERFACE/);
  assert.match(topology, /data-frame-id="atmosphere-main"/);

  const modulePosition = name => {
    const match = new RegExp(
      `class="reference-module-position" style="--module-left:([\\d.]+)%;--module-top:(\\d+)px[^\"]*">(?:(?!class="reference-module-position")[\\s\\S])*?<strong[^>]*>${name}</strong>`,
    ).exec(topology);
    assert.ok(match, `应找到 ${name} 的坐标`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const robotPosition = name => {
    const match = new RegExp(
      `class="reference-robot-position" style="--robot-left:([\\d.]+)%;--robot-top:(\\d+)px[^\"]*">(?:(?!class="reference-robot-position")[\\s\\S])*?aria-label="${name}，`,
    ).exec(topology);
    assert.ok(match, `应找到 ${name} 的坐标`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const lp1 = modulePosition("LP1");
  const dummyPort = modulePosition("DummyPort");
  assert.deepEqual(
    ["LP1", "LP2", "LP3"].map(name => modulePosition(name).x),
    [35.125, 45.04875, 54.95125],
    "三个实际 LoadPort 应附着在大气框架底边",
  );
  assert.equal(modulePosition("DummyPort").x, 64.875, "DummyPort 应附着在大气框架底边最右侧");
  assert.equal(dummyPort.y, lp1.y, "DummyPort 应与实际 LoadPort 共用大气框架底边");
  assert.ok(lp1.x < dummyPort.x, "DummyPort 应排在实际 LoadPort 之后");
  const atr = robotPosition("ATR");
  assert.equal(lp1.y - atr.y, 116, "LoadPort 整排应由大气框架下边固定");
  assert.equal(modulePosition("Aligner").x, 33.95, "Aligner 应位于大气框架内左上角");
  assert.equal(modulePosition("Cooler").x, 66.05, "Cooler 应位于大气框架内右上角");
  assert.equal(modulePosition("Cooler").y - modulePosition("Aligner").y, 9, "Aligner 与 Cooler 应使用紧凑的顶部纵向间距");
  const pm2 = modulePosition("PM2");
  const pm3 = modulePosition("PM3");
  const pm4 = modulePosition("PM4");
  const pm1 = modulePosition("PM1");
  const vtr = robotPosition("VTR");
  const singleFrame = /data-frame-id="vacuum-main" style="--frame-left:[\d.]+%;--frame-top:(\d+)px;--frame-width:240px;--frame-height:240px"/.exec(topology);
  assert.ok(singleFrame, "应找到 240px 单腔真空框架");
  assert.equal(vtr.x, 50);
  assert.equal(vtr.y, Number(singleFrame[1]), "VTR 应位于单腔框架中心");
  assert.ok(pm1.x < vtr.x && pm2.x < vtr.x, "PM1/PM2 应附着在框架左边");
  assert.ok(pm3.x > vtr.x && pm4.x > vtr.x, "PM3/PM4 应附着在框架右边");
  const la = modulePosition("LA");
  const lb = modulePosition("LB");
  assert.deepEqual([la.x, lb.x], [45.8, 54.2], "LA / LB 应以极小间隔并排附着在大气框架上边");
  assert.equal(la.y, lb.y);
  assert.equal((topology.match(/class="loadlock-top-chamber"/g) || []).length, 2, "两把 LoadLock 均显示俯视腔体");
});

test("LP2 与 Dummy Port 之间固定预留 LP3 列位", () => {
  const portDevice = {
    Stations: {
      LP1: { Type: "LoadPort" },
      LP2: { Type: "LoadPort" },
      DummyPort: { Type: "DummyPort" },
    },
    Robots: { ATR: { Type: "ATMRobot" } },
  };
  const portMoves = [
    { MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], MatIDList: ["W1"], StartTime: 0, EndTime: 1 },
    { MoveID: 2, MoveType: 1, ModuleName: "ATR", DestStationList: ["LP2"], MatIDList: ["W1"], StartTime: 1, EndTime: 2 },
  ];
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot(portMoves, portDevice, 0), portDevice),
    null,
    undefined,
    portDevice,
  );
  const xFor = name => {
    const match = new RegExp(
      `class="reference-module-position" style="--module-left:([\\d.]+)%;[^>]*>(?:(?!class="reference-module-position")[\\s\\S])*?<strong[^>]*>${name}</strong>`,
    ).exec(topology);
    assert.ok(match, `应找到 ${name} 的列位`);
    return Number(match[1]);
  };
  assert.deepEqual([xFor("LP1"), xFor("LP2"), xFor("DummyPort")], [37.25, 50, 62.75]);
});

test("画布模块筛选：勾选 Aligner/Cooler 后对应模块不在拓扑中显示", () => {
  const filterDevice = {
    Stations: {
      LP1: { Type: "LoadPort" },
      LA: { Type: "LoadLock" },
      PM1: { Type: "Process" },
      Aligner: { Type: "Aligner" },
      Cooler: { Type: "Cooler" },
    },
    Robots: { ATR: {} },
  };
  const snapshot = logic.buildWorkspaceSnapshot([], filterDevice, 0);
  const full = logic.snapshotWithFullDeviceModules(snapshot, filterDevice);
  const plain = logic.renderEquipmentTopology(full, null);
  assert.match(plain, />Aligner</, "默认应显示 Aligner");
  assert.match(plain, />Cooler</, "默认应显示 Cooler");
  const noAligner = logic.renderEquipmentTopology(full, null, new Set(["aligner"]));
  assert.doesNotMatch(noAligner, />Aligner</, "勾选 Aligner 后应隐藏 Aligner");
  assert.match(noAligner, />Cooler</, "勾选 Aligner 不影响 Cooler");
  const noCooler = logic.renderEquipmentTopology(full, null, new Set(["cooler"]));
  assert.doesNotMatch(noCooler, />Cooler</, "勾选 Cooler 后应隐藏 Cooler");
  assert.match(noCooler, />Aligner</, "勾选 Cooler 不影响 Aligner");
  const none = logic.renderEquipmentTopology(full, null, new Set());
  assert.match(none, />Aligner</, "空筛选集合不隐藏任何模块");
  assert.match(none, />Cooler</);
});

test("画布模块筛选：AL/CL 别名同样被 Aligner/Cooler 筛选隐藏", () => {
  const aliasDevice = {
    Stations: {
      LP1: { Type: "LoadPort" },
      LA: { Type: "LoadLock" },
      PM1: { Type: "Process" },
      AL: { Type: "Aligner" },
      CL: { Type: "Cooler" },
    },
    Robots: { ATR: {} },
  };
  const full = logic.snapshotWithFullDeviceModules(
    logic.buildWorkspaceSnapshot([], aliasDevice, 0),
    aliasDevice,
  );
  const plain = logic.renderEquipmentTopology(full, null);
  assert.match(plain, />AL</, "默认应显示 AL");
  assert.match(plain, />CL</, "默认应显示 CL");
  const filtered = logic.renderEquipmentTopology(full, null, new Set(["aligner", "cooler"]));
  assert.doesNotMatch(filtered, />AL</, "勾选 Aligner 后隐藏 AL 别名");
  assert.doesNotMatch(filtered, />CL</, "勾选 Cooler 后隐藏 CL 别名");
});

test("双真空机械手级联拓扑固定显示全部 LP，并完整显示腔室且不重叠", () => {
  const fullDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" },
      LP3: { Type: "LoadPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      UBR: { Type: "LoadLock" }, DBR: { Type: "LoadLock" },
      PM1: { Type: "ProcessChamber" }, PM2: { Type: "ProcessChamber" },
      PM3: { Type: "ProcessChamber" }, PM4: { Type: "ProcessChamber" },
      PM5: { Type: "ProcessChamber" },
      Aligner: { Type: "Aligner" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR_1: { Type: "VTMRobot" }, VTR_2: { Type: "HighVTMRobot" } },
  };
  const required = ["LP1", "LP2", "LP3", "LA", "LB", "UBR", "DBR", "PM1", "PM2", "PM3", "PM4", "PM5"];
  const snapshot = logic.buildWorkspaceSnapshot(moves, fullDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, fullDevice),
    null,
  );
  assertTopologyComplete(topology, required);
  assert.match(topology, />LP2</);
  assert.match(topology, />LP3</);
  assert.match(topology, /data-frame-id="vacuum-vtr-1"/);
  assert.match(topology, /data-frame-id="vacuum-vtr-2"/);
  const yOf = name => {
    const module = new RegExp(
      `class="reference-module-position" style="--module-left:[\\d.]+%;--module-top:(\\d+)px[^\"]*">\\s*<strong class="equipment-external-name[^"]*">${name}</strong>`
    ).exec(topology);
    if (module) return Number(module[1]);
    const robot = new RegExp(
      `class="reference-robot-position" style="--robot-left:[\\d.]+%;--robot-top:(\\d+)px[^\"]*">\\s*<article class="robot-hub[^"]*"[^>]*aria-label="${name}`
    ).exec(topology);
    assert.ok(robot, `拓扑应包含 ${name}`);
    return Number(robot[1]);
  };
  assert.equal(yOf("UBR"), yOf("DBR"), "仅有四个 LoadLock 时 UBR/DBR 仍应水平同排");
  assert.ok(
    yOf("VTR_2") < yOf("UBR") && yOf("UBR") < yOf("VTR_1"),
    "UBR/DBR 应位于 VTR_2 与 VTR_1 之间，而不是 LA/LB 下方",
  );
});

test("级联与非级联拓扑的大气侧布局和区域高度保持一致", () => {
  const atmosphereStations = {
    LP1: { Type: "LoadPort" },
    LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
    Buffer1: { Type: "Buffer" }, Buffer2: { Type: "Buffer" },
    Buffer3: { Type: "Buffer" }, Buffer4: { Type: "Buffer" },
  };
  const singleDevice = {
    Stations: atmosphereStations,
    Robots: { ATR: { Type: "ATMRobot" }, VTR: { Type: "VTMRobot" } },
  };
  const cascadeDevice = {
    Stations: {
      ...atmosphereStations,
      UBR: { Type: "LoadLock" }, DBR: { Type: "LoadLock" },
    },
    Robots: {
      ATR: { Type: "ATMRobot" },
      VTR_1: { Type: "VTMRobot" }, VTR_2: { Type: "HighVTMRobot" },
    },
  };
  const atmosphereMoves = [
    { MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], MatIDList: ["W1"], StartTime: 0, EndTime: 1 },
  ];
  const render = device => logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot(atmosphereMoves, device, 0), device),
    null,
    undefined,
    device,
  );
  const atmosphereFrame = topology => {
    const match = /data-frame-id="atmosphere-main" style="--frame-left:[\d.]+%;--frame-top:([\d.]+)px;--frame-width:([\d.]+)px;--frame-height:([\d.]+)px"/.exec(topology);
    assert.ok(match, "应找到大气框架");
    return { top: Number(match[1]), width: Number(match[2]), height: Number(match[3]) };
  };
  const verticalPosition = (topology, kind, name) => {
    const prefix = kind === "robot"
      ? 'class="reference-robot-position" style="--robot-left:[\\d.]+%;--robot-top:'
      : 'class="reference-module-position" style="--module-left:[\\d.]+%;--module-top:';
    const match = new RegExp(`${prefix}(\\d+)px[^\"]*">(?:(?!class="reference-(?:robot|module)-position")[\\s\\S])*?${name}`).exec(topology);
    assert.ok(match, `应找到 ${name} 的纵向坐标`);
    return Number(match[1]);
  };
  const singleTopology = render(singleDevice);
  const cascadeTopology = render(cascadeDevice);

  assert.deepEqual(
    [atmosphereFrame(cascadeTopology).width, atmosphereFrame(cascadeTopology).height],
    [atmosphereFrame(singleTopology).width, atmosphereFrame(singleTopology).height],
    "两类拓扑的大气框架应使用同一尺寸",
  );
  for (const topology of [singleTopology, cascadeTopology]) {
    assert.doesNotMatch(topology, /topology-interface-bay|VACUUM \/ ATM INTERFACE/, "LoadLock 后方不应绘制接口框");
    assert.equal(
      verticalPosition(topology, "module", "LP1") - verticalPosition(topology, "robot", "ATR"),
      116,
      "ATR 到 LoadPort 的垂直间距应由大气框架固定",
    );
  }
});

test("拓扑布局按多腔类型和机器手数量识别，与自定义命名无关", () => {
  const single = {
    Stations: { "工艺站-甲": { Type: "ProcessChamber" } },
    Robots: { "大气搬运": { Type: "ATMRobot" }, "真空搬运": { Type: "VTMRobot" } },
  };
  const dual = {
    Stations: { "工艺站-乙": { Type: "MultiProcessChamber", Capacity: 2 } },
    Robots: { "前端手": { Type: "ATMRobot" }, "腔体手": { Type: "VTMRobot" } },
  };
  const cascade = {
    Stations: {
      "任意腔室-甲": { Type: "MultiProcessChamber", Capacity: 2 },
      "任意腔室-乙": { Type: "ProcessChamber" },
      "任意腔室-丙": { Type: "ProcessChamber" },
      "任意腔室-丁": { Type: "ProcessChamber" },
      "任意腔室-戊": { Type: "ProcessChamber" },
    },
    Robots: {
      "入口机械手": { Type: "ATMRobot" },
      "下层机械手": { Type: "VTMRobot" },
      "上层机械手": { Type: "HighVTMRobot" },
    },
  };

  assert.equal(logic.detectDeviceTopologyLayout(single), "single");
  assert.equal(logic.detectDeviceTopologyLayout(dual), "dual");
  assert.equal(logic.detectDeviceTopologyLayout(cascade), "cascade", "机器手超过 2 个时级联优先");

  for (const [deviceDefinition, expected] of [[single, "single"], [dual, "dual"], [cascade, "cascade"]]) {
    const snapshot = logic.snapshotWithFullDeviceModules(
      logic.buildWorkspaceSnapshot([], deviceDefinition, 0),
      deviceDefinition,
    );
    const topology = logic.renderEquipmentTopology(snapshot, null);
    assert.match(
      topology,
      new RegExp(`data-topology-layout="${expected}"`),
    );
    if (expected === "cascade") assertTopologyComplete(topology, Object.keys(deviceDefinition.Stations));
  }
});

test("三类设备以机器框架和不可见附着点固定真空腔室位置", () => {
  const render = device => logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([], device, 0), device),
    null,
    undefined,
    device,
  );
  const positionOf = (topology, kind, name) => {
    const className = kind === "robot" ? "reference-robot-position" : "reference-module-position";
    const variable = kind === "robot" ? "robot" : "module";
    const marker = kind === "robot" ? `aria-label="${name}，` : `>${name}</strong>`;
    const match = new RegExp(
      `class="${className}" style="--${variable}-left:([\\d.]+)%;--${variable}-top:(\\d+)px[^\"]*">(?:(?!class="reference-(?:robot|module)-position")[\\s\\S])*?${marker}`,
    ).exec(topology);
    assert.ok(match, `应找到 ${name} 的框架坐标`);
    return { x: Number(match[1]) * 10, y: Number(match[2]) };
  };
  const frameOf = (topology, id) => {
    const match = new RegExp(
      `data-frame-id="${id}" style="--frame-left:([\\d.]+)%;--frame-top:(\\d+)px;--frame-width:([\\d.]+)px;--frame-height:(\\d+)px"`,
    ).exec(topology);
    assert.ok(match, `应找到 ${id} 机器框架`);
    return { x: Number(match[1]) * 10, y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  };

  const single = {
    Stations: {
      PM1: { Type: "ProcessChamber" }, PM2: { Type: "ProcessChamber" },
      PM3: { Type: "ProcessChamber" }, PM4: { Type: "ProcessChamber" },
      Heater: { Type: "Heater" }, LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR: { Type: "VTMRobot" } },
  };
  const singleTopology = render(single);
  const singleFrame = frameOf(singleTopology, "vacuum-main");
  assert.equal(singleFrame.width, singleFrame.height, "单腔真空框架应为正方形");
  assert.equal(singleFrame.width, 240, "单腔真空框架边长应统一为 240px");
  assert.deepEqual(positionOf(singleTopology, "robot", "VTR"), { x: singleFrame.x, y: singleFrame.y });
  assert.deepEqual(
    ["PM1", "PM2", "PM3", "PM4"].map(name => positionOf(singleTopology, "module", name).x < singleFrame.x),
    [true, true, false, false],
    "四个 PM 应分别附着在框架左右两边",
  );
  assert.ok(positionOf(singleTopology, "module", "Heater").y < singleFrame.y, "Heater 应附着在框架左上方");
  assert.match(singleTopology, />Heater<\/strong>[\s\S]*?class="equipment-card equipment-process/);
  assert.ok(positionOf(singleTopology, "module", "LA").y > singleFrame.y);
  assert.ok(positionOf(singleTopology, "module", "LB").y > singleFrame.y);
  const singleAtmosphereFrame = frameOf(singleTopology, "atmosphere-main");
  for (const name of ["LA", "LB"]) {
    const lock = positionOf(singleTopology, "module", name);
    assert.equal(lock.y, singleFrame.y + singleFrame.height / 2 + 41, `${name} 应贴合真空框架下边`);
    assert.equal(lock.y, singleAtmosphereFrame.y - singleAtmosphereFrame.height / 2 - 41, `${name} 应贴合大气框架上边`);
  }
  assert.equal(
    positionOf(singleTopology, "module", "LA").x + positionOf(singleTopology, "module", "LB").x,
    singleFrame.x * 2,
    "单腔 LA/LB 应围绕真空框架中轴对称",
  );
  assert.ok(
    Math.abs(positionOf(singleTopology, "module", "LB").x - positionOf(singleTopology, "module", "LA").x) - 82 <= 2.01,
    "单腔 LA/LB 外框之间只应保留极小间隔",
  );

  const dual = {
    Stations: {
      PM1: { Type: "MultiProcessChamber", Capacity: 2 },
      PM2: { Type: "MultiProcessChamber", Capacity: 2 },
      PM3: { Type: "MultiProcessChamber", Capacity: 2 },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      LC: { Type: "LoadLock" }, LD: { Type: "LoadLock" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR: { Type: "VTMRobot" } },
  };
  const dualTopology = render(dual);
  const dualFrame = frameOf(dualTopology, "vacuum-main");
  assert.equal(dualFrame.width, dualFrame.height, "双腔真空框架应为正方形");
  assert.equal(dualFrame.width, 240, "双腔真空框架边长应统一为 240px");
  assert.deepEqual(positionOf(dualTopology, "robot", "VTR"), { x: dualFrame.x, y: dualFrame.y });
  assert.doesNotMatch(dualTopology, /VACUUM FRAME/, "双腔真空框架不应显示提示词");
  const dualAtmosphereFrame = frameOf(dualTopology, "atmosphere-main");
  for (const name of ["LA", "LB", "LC", "LD"]) {
    const lock = positionOf(dualTopology, "module", name);
    assert.equal(lock.y, dualFrame.y + dualFrame.height / 2 + 41, `${name} 应贴合双腔真空框架下边`);
    assert.equal(lock.y, dualAtmosphereFrame.y - dualAtmosphereFrame.height / 2 - 41, `${name} 应贴合双腔大气框架上边`);
  }
  const dualLockPositions = ["LC", "LA", "LB", "LD"].map(name => positionOf(dualTopology, "module", name));
  for (let index = 1; index < dualLockPositions.length; index += 1) {
    assert.ok(
      dualLockPositions[index].x - dualLockPositions[index - 1].x - 82 <= 2.01,
      "双腔 LoadLock 链相邻外框之间只应保留极小间隔",
    );
  }
  assert.ok(positionOf(dualTopology, "module", "PM1-1").x < dualFrame.x);
  assert.ok(positionOf(dualTopology, "module", "PM2-1").y < dualFrame.y);
  assert.ok(positionOf(dualTopology, "module", "PM3-1").x > dualFrame.x);

  const atmospheric = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" }, LP3: { Type: "LoadPort" }, DummyPort: { Type: "DummyPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      Aligner: { Type: "Aligner" }, Cooler: { Type: "Cooler" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR: { Type: "VTMRobot" } },
  };
  const atmosphericTopology = render(atmospheric);
  const atmosphereFrame = frameOf(atmosphericTopology, "atmosphere-main");
  assert.deepEqual(
    { width: atmosphereFrame.width, height: atmosphereFrame.height },
    { width: 425, height: 150 },
    "大气框架应为 425×150px",
  );
  assert.doesNotMatch(atmosphericTopology, /ATMOSPHERE FRAME/, "大气框架内不应显示区域提示");
  assert.doesNotMatch(atmosphericTopology, /topology-zone|真空加工区|大气传输区/);
  for (const name of ["LA", "LB"]) {
    assert.ok(positionOf(atmosphericTopology, "module", name).y < atmosphereFrame.y, `${name} 应附着在大气框架上边`);
  }
  for (const name of ["LP1", "LP2", "LP3", "DummyPort"]) {
    assert.ok(positionOf(atmosphericTopology, "module", name).y > atmosphereFrame.y, `${name} 应附着在大气框架下边`);
  }
  assert.ok(positionOf(atmosphericTopology, "module", "Aligner").x < atmosphereFrame.x && positionOf(atmosphericTopology, "module", "Aligner").y < atmosphereFrame.y);
  assert.ok(positionOf(atmosphericTopology, "module", "Cooler").x > atmosphereFrame.x && positionOf(atmosphericTopology, "module", "Cooler").y < atmosphereFrame.y);
  assert.deepEqual(positionOf(atmosphericTopology, "robot", "ATR"), { x: atmosphereFrame.x, y: atmosphereFrame.y });

  const cascade = {
    Stations: {
      PM1: { Type: "ProcessChamber" }, PM2: { Type: "ProcessChamber" },
      PM3: { Type: "ProcessChamber" }, PM4: { Type: "ProcessChamber" }, PM5: { Type: "ProcessChamber" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      UBR: { Type: "LoadLock" }, DBR: { Type: "LoadLock" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR_1: { Type: "VTMRobot" }, VTR_2: { Type: "HighVTMRobot" } },
  };
  const cascadeTopology = render(cascade);
  const upperFrame = frameOf(cascadeTopology, "vacuum-vtr-2");
  const lowerFrame = frameOf(cascadeTopology, "vacuum-vtr-1");
  assert.equal(upperFrame.width, upperFrame.height, "VTR_2 框架应为正方形");
  assert.equal(upperFrame.width, lowerFrame.width, "VTR_1 与 VTR_2 框架应使用相同宽度");
  assert.ok(lowerFrame.width > lowerFrame.height, "VTR_1 框架应为偏扁的横向框架");
  assert.equal(lowerFrame.height, 128, "VTR_1 框架应加高以容纳更清晰的级联层次");
  assert.doesNotMatch(cascadeTopology, /VACUUM FRAME/, "级联真空框架不应显示提示词");
  for (const edge of ["top", "right", "bottom", "left"]) {
    assert.equal(
      (cascadeTopology.match(new RegExp(`data-anchor-id="vacuum-vtr-2-${edge}-[12]"`, "g")) ?? []).length,
      2,
      `VTR_2 的 ${edge} 边应有两个对称锚点`,
    );
  }
  assert.deepEqual(positionOf(cascadeTopology, "robot", "VTR_1"), { x: lowerFrame.x, y: lowerFrame.y });
  assert.deepEqual(positionOf(cascadeTopology, "robot", "VTR_2"), { x: upperFrame.x, y: upperFrame.y });
  assert.ok(positionOf(cascadeTopology, "module", "PM3").x < upperFrame.x && positionOf(cascadeTopology, "module", "PM3").y > upperFrame.y);
  assert.ok(positionOf(cascadeTopology, "module", "PM4").x < upperFrame.x && positionOf(cascadeTopology, "module", "PM4").y < upperFrame.y);
  assert.ok(positionOf(cascadeTopology, "module", "PM5").x > upperFrame.x && positionOf(cascadeTopology, "module", "PM5").y < upperFrame.y);
  for (const name of ["UBR", "DBR"]) {
    const position = positionOf(cascadeTopology, "module", name);
    assert.ok(position.y > upperFrame.y && position.y < lowerFrame.y, `${name} 应附着在两个框架之间`);
  }
  for (const [leftName, rightName] of [["UBR", "DBR"]]) {
    const left = positionOf(cascadeTopology, "module", leftName);
    const right = positionOf(cascadeTopology, "module", rightName);
    assert.equal(left.y, right.y, `${leftName}/${rightName} 应在同一附着边`);
    assert.ok(
      Math.abs(right.x - left.x) <= 83.1,
      `${leftName}/${rightName} 应紧贴排列，不保留额外横向空白`,
    );
  }
  const cascadeAtmosphereFrame = frameOf(cascadeTopology, "atmosphere-main");
  const cascadeLA = positionOf(cascadeTopology, "module", "LA");
  const cascadeLB = positionOf(cascadeTopology, "module", "LB");
  for (const [name, position] of [["LA", cascadeLA], ["LB", cascadeLB]]) {
    assert.equal(position.y, lowerFrame.y + lowerFrame.height / 2 + 41, `${name} 应贴合 VTR_1 下边`);
    assert.equal(position.y, cascadeAtmosphereFrame.y - cascadeAtmosphereFrame.height / 2 - 41, `${name} 应贴合大气框架上边`);
  }
  assert.equal(cascadeLA.x + cascadeLB.x, lowerFrame.x * 2, "级联 LA/LB 应严格围绕 VTR_1 中轴对称");
  assert.ok(cascadeLB.x - cascadeLA.x - 82 <= 2.01, "级联 LA/LB 外框之间只应保留极小间隔");
  assert.match(cascadeTopology, /data-attachment-id="vacuum-vtr-1-loadlock-1@bottom\|atmosphere-main-loadlock-1@top"/);
  assert.match(cascadeTopology, /class="topology-attachment-point"/);
  assert.match(frontendCss, /\.topology-attachment-point[^{]*\{[^}]*opacity:\s*0/);
  assert.match(frontendCss, /\.topology-frame-anchor[^{]*\{[^}]*opacity:\s*0/);
});

test("三级机器手设备按结构使用级联布局，不依赖设备名称", () => {
  const twelveKDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" },
      LP3: { Type: "LoadPort" }, LP4: { Type: "LoadPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      UBR: { Type: "LoadLock" }, DBR: { Type: "LoadLock" },
      PM1: { Type: "ProcessChamber" }, PM2: { Type: "ProcessChamber" },
      PM3: { Type: "ProcessChamber" }, PM4: { Type: "ProcessChamber" },
      PM5: { Type: "ProcessChamber" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR_1: { Type: "VTMRobot" }, VTR_2: { Type: "HighVTMRobot" } },
  };
  const snapshot = logic.buildWorkspaceSnapshot(moves, twelveKDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, twelveKDevice),
    null,
    undefined,
    twelveKDevice,
  );
  assert.match(topology, /data-topology-layout="cascade"/);
  assertTopologyComplete(topology, ["LA", "LB", "UBR", "DBR", "PM1", "PM2", "PM3", "PM4", "PM5"]);
  const positionOf = name => {
    const module = new RegExp(
      `class="reference-module-position" style="--module-left:([\\d.]+)%;--module-top:(\\d+)px[^\"]*">\\s*<strong class="equipment-external-name[^"]*">${name}</strong>`
    ).exec(topology);
    if (module) return { x: Number(module[1]) / 100 * 1000, y: Number(module[2]) };
    const robot = new RegExp(
      `class="reference-robot-position" style="--robot-left:([\\d.]+)%;--robot-top:(\\d+)px[^\"]*">\\s*<article class="robot-hub[^"]*"[^>]*aria-label="${name}`
    ).exec(topology);
    assert.ok(robot, `拓扑应包含 ${name}`);
    return { x: Number(robot[1]) / 100 * 1000, y: Number(robot[2]) };
  };
  const vtr1 = positionOf("VTR_1");
  const vtr2 = positionOf("VTR_2");
  assert.ok(vtr1.y > vtr2.y, "VTR_1 主手应在 VTR_2 下方");
  const pm1 = positionOf("PM1"), pm2 = positionOf("PM2");
  assert.equal(pm1.y, vtr1.y, "PM1 应与 VTR_1 同排");
  assert.equal(pm2.y, vtr1.y, "PM2 应与 VTR_1 同排");
  assert.ok(pm1.x < vtr1.x && pm2.x > vtr1.x, "PM1/PM2 应分列 VTR_1 左右");
  const ubr = positionOf("UBR"), dbr = positionOf("DBR");
  assert.equal(ubr.y, dbr.y, "UBR/DBR 应水平同排");
  assert.ok(ubr.y < vtr1.y && ubr.y > vtr2.y, "UBR/DBR 应位于 VTR_1 上方、VTR_2 下方");
  assert.ok(ubr.x < dbr.x, "UBR 应在 DBR 左侧");
  const pm3 = positionOf("PM3"), pm4 = positionOf("PM4"), pm5 = positionOf("PM5");
  assert.ok(pm3.x < vtr2.x && pm3.y > vtr2.y, "PM3 应附着在 VTR_2 框架左下侧");
  assert.ok(pm4.x < vtr2.x && pm4.y < vtr2.y, "PM4 应附着在 VTR_2 框架左上侧");
  assert.ok(pm5.x > vtr2.x && pm5.y < vtr2.y, "PM5 应附着在 VTR_2 框架右上侧");
  const la = positionOf("LA"), lb = positionOf("LB");
  assert.equal(la.y, lb.y, "LA/LB 应同排附着在 VTR_1 框架底部");
  assert.ok(la.x < lb.x, "LA/LB 应按左右顺序排列");
  assert.doesNotMatch(topology, /topology-zone|真空加工区|大气传输区/, "不应绘制真空或大气背景框");
  assert.doesNotMatch(topology, /topology-interface-bay|VACUUM \/ ATM INTERFACE/, "LoadLock 后方不应绘制接口框");
  const renamedDeviceTopology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, twelveKDevice),
    null,
    undefined,
    { ...twelveKDevice, Name: "任意新建设备名称" },
  );
  assert.equal(renamedDeviceTopology, topology, "设备名称不应影响布局选择或坐标");
});

test("多个大气机械手在同一排横向分布且不重叠", () => {
  const multiAtrDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      PM1: { Type: "Process" }, PM2: { Type: "Process" },
    },
    Robots: {
      ATR_1: { Type: "ATMRobot" }, ATR_2: { Type: "ATMRobot" },
      VTR: { Type: "VTMRobot" },
    },
  };
  const multiAtrMoves = [
    { MoveID: 1, MoveType: 6, ModuleName: "PM1", StartTime: 0, EndTime: 1 },
    { MoveID: 2, MoveType: 2, ModuleName: "ATR_1", SrcStationList: ["LP1"], MatIDList: ["W1"], StartTime: 1, EndTime: 2 },
  ];
  const snapshot = logic.buildWorkspaceSnapshot(multiAtrMoves, multiAtrDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, multiAtrDevice),
    null,
  );
  assertTopologyComplete(topology, ["LP1", "LP2", "LA", "LB", "PM1", "PM2"]);
  assert.match(topology, />LP2</);
  const reAtr = /class="reference-robot-position" style="--robot-left:([\d.]+)%;--robot-top:(\d+)px">\s*<article class="robot-hub[^"]*"[^>]*aria-label="(ATR_\d)[^"]*"/g;
  let match;
  const found = new Map();
  while ((match = reAtr.exec(topology)) !== null) {
    found.set(match[3], { x: Number(match[1]) / 100 * 1000, y: Number(match[2]) });
  }
  assert.equal(found.size, 2);
  const positions = [...found.values()];
  assert.ok(Math.abs(positions[0].x - positions[1].x) >= 96, "两个大气机械手应横向分开");
  assert.equal(positions[0].y, positions[1].y, "两个大气机械手应在同一排");
});

test("双腔拓扑使用 init 机器手名称和 Type，并用双片错层效果显示两片晶圆", () => {
  const dualDevice = {
    Stations: {
      LP1: { Type: "LoadPort", Capacity: 2, Slots: [1, 2] },
      LA: { Type: "LoadLock", LastItem: "VacuumArm" },
      PM1: { Type: "Process" },
    },
    Robots: {
      AtmosphereArm: { Name: "AtmosphereArm", Type: "ATMRobot", Capacity: 2 },
      VacuumArm: { Name: "VacuumArm", Type: "VTMRobot", Capacity: 2 },
    },
  };
  const dualPick = [{
    MoveID: 1,
    MoveType: 0,
    ModuleName: "AtmosphereArm",
    Robot: "AtmosphereArm",
    SrcStationList: ["LP1", "LP1"],
    SrcSlotList: [1, 2],
    MatIDList: ["W1", "W2"],
    StartTime: 0,
    EndTime: 1,
  }];
  const snapshot = logic.snapshotWithFullDeviceModules(
    logic.buildWorkspaceSnapshot(dualPick, dualDevice, 1),
    dualDevice,
  );
  const robot = snapshot.robots.find(item => item.name === "AtmosphereArm");
  assert.deepEqual(robot.wafers, ["W1", "W2"]);
  const topology = logic.renderEquipmentTopology(snapshot, null);
  assert.match(topology, /class="robot-environment-badge">AtmosphereArm</);
  assert.doesNotMatch(topology, />ATMRobot</);
  assert.match(topology, /aria-label="AtmosphereArm，双片机械手/);
  assert.match(topology, /class="robot-held-wafer robot-held-wafer-0"/);
  assert.match(topology, /class="robot-held-wafer robot-held-wafer-1"/);
  assert.doesNotMatch(topology, /robot-external-name|robot-capacity-badge|robot-holding-count|is-dual-hold/);
  assert.doesNotMatch(topology, />2片</);
  assert.doesNotMatch(topology, /loadlock-pressure-state/);
});

test("双腔拓扑拒绝 MoveList 中不存在于 init 的组合假设备", () => {
  const twinsDevice = {
    Stations: {
      P1: { Type: "LoadPort" },
      LA: { Type: "LoadLock" },
      LB: { Type: "LoadLock" },
      LC: { Type: "LoadLock" },
      LD: { Type: "LoadLock" },
      PM1: { Type: "Process" },
    },
    Robots: { AtmosphereArm: { Type: "ATMRobot" }, VacuumArm: { Type: "VTMRobot" } },
  };
  const replayMoves = [
    {
      MoveID: 1,
      MoveType: 2,
      ModuleName: "AtmosphereArm",
      SrcStationList: ["P1"],
      DestStationList: ["LALB"],
      MatIDList: ["W1"],
      StartTime: 0,
      EndTime: 2,
    },
    {
      MoveID: 2,
      MoveType: 6,
      ModuleName: "LCLD",
      MatIDList: ["W1"],
      StartTime: 2,
      EndTime: 3,
    },
  ];
  const snapshot = logic.snapshotWithFullDeviceModules(
    logic.buildWorkspaceSnapshot(replayMoves, twinsDevice, 0.5),
    twinsDevice,
  );
  const names = snapshot.modules.map(module => module.name);
  assert.ok(names.includes("P1"));
  assert.ok(!names.includes("LALB"));
  assert.ok(!names.includes("LCLD"));
  const topology = logic.renderEquipmentTopology(snapshot, null);
  assert.doesNotMatch(topology, />LALB</);
  assert.doesNotMatch(topology, />LCLD</);
});

test("LoadPort 按物理槽位显示未加工、空槽与回片后的已加工状态", () => {
  const slotDevice = {
    Stations: {
      LP1: { Type: "LoadPort", Capacity: 3, Slots: [1, 2, 3] },
      PM1: { Type: "Process" },
    },
    Robots: { ATR: {} },
  };
  const slotMoves = [
    { MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [1], MatIDList: ["W1"], StartTime: 0, EndTime: 1 },
    { MoveID: 2, MoveType: 1, ModuleName: "ATR", DestStationList: ["PM1"], DestSlotList: [1], MatIDList: ["W1"], StartTime: 1, EndTime: 2 },
    { MoveID: 3, MoveType: 9, ModuleName: "PM1", MatIDList: ["W1"], StartTime: 2, EndTime: 3 },
    { MoveID: 4, MoveType: 0, ModuleName: "ATR", SrcStationList: ["PM1"], SrcSlotList: [1], MatIDList: ["W1"], StartTime: 3, EndTime: 4 },
    { MoveID: 5, MoveType: 1, ModuleName: "ATR", DestStationList: ["LP1"], DestSlotList: [1], MatIDList: ["W1"], StartTime: 4, EndTime: 5 },
    { MoveID: 6, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [2], MatIDList: ["W2"], StartTime: 10, EndTime: 11 },
  ];

  const initial = moduleAt(logic.buildWorkspaceSnapshot(slotMoves, slotDevice, 0), "LP1");
  assert.deepEqual(initial.loadPortSlots, [
    { slot: 1, wafer: "W1", processed: false },
    { slot: 2, wafer: "W2", processed: false },
    { slot: 3, wafer: "", processed: false },
  ]);

  const departed = moduleAt(logic.buildWorkspaceSnapshot(slotMoves, slotDevice, 1), "LP1");
  assert.equal(departed.loadPortSlots[0].wafer, "", "取出的晶圆必须留下空槽");
  assert.equal(departed.loadPortSlots[1].wafer, "W2");
  const departedTopology = logic.renderEquipmentTopology(
    logic.buildWorkspaceSnapshot(slotMoves, slotDevice, 1),
    null,
  );
  assert.match(departedTopology, /class="load-port-cassette"/);
  assert.match(departedTopology, /槽位 1，空/);
  assert.match(departedTopology, /槽位 2，晶圆 W2，未加工/);

  const returned = moduleAt(logic.buildWorkspaceSnapshot(slotMoves, slotDevice, 5), "LP1");
  assert.deepEqual(returned.loadPortSlots[0], { slot: 1, wafer: "W1", processed: true });
  const returnedTopology = logic.renderEquipmentTopology(
    logic.buildWorkspaceSnapshot(slotMoves, slotDevice, 5),
    null,
  );
  assert.match(returnedTopology, /槽位 1，晶圆 W1，已加工/);
  assert.match(returnedTopology, /load-port-slot is-processed/);
  assert.match(returnedTopology, /--load-port-slot-count:3/);
  assert.match(returnedTopology, /equipment-external-name equipment-external-name-port">LP1</);
  assert.doesNotMatch(returnedTopology, /load-port-slot-summary|>RAW\s|>DONE\s/);
});

test("CJobCycle 补片开始时替换 LoadPort 旧成品盒", () => {
  const cycleDevice = {
    Stations: {
      LP1: { Type: "LoadPort", Capacity: 10, Slots: Array.from({ length: 10 }, (_, index) => index + 1) },
    },
    Robots: { ATR: {} },
  };
  const cycleMoves = Array.from({ length: 10 }, (_, index) => {
    const slot = index + 1;
    return [
      { MoveID: slot, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [slot], MatIDList: [`OLD${slot}`], StartTime: index * 2, EndTime: index * 2 + 1 },
      { MoveID: 20 + slot, MoveType: 1, ModuleName: "ATR", DestStationList: ["LP1"], DestSlotList: [slot], MatIDList: [`OLD${slot}`], StartTime: 70 + index, EndTime: 71 + index },
      { MoveID: 40 + slot, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [slot], MatIDList: [`NEW${slot}`], StartTime: 100 + index * 2, EndTime: 101 + index * 2 },
    ];
  }).flat();

  const initial = moduleAt(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 0), "LP1");
  assert.deepEqual(initial.loadPortSlots.map(slot => slot.wafer), Array.from({ length: 10 }, (_, index) => `OLD${index + 1}`));
  const beforePatch = moduleAt(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 99.9), "LP1");
  assert.equal(beforePatch.loadPortSlots.filter(slot => /^OLD/.test(slot.wafer)).length, 10);
  assert.equal(beforePatch.loadPortSlots.some(slot => /^NEW/.test(slot.wafer)), false, "第二轮晶圆不能提前出现在初始盒中");
  const atPatch = moduleAt(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 100), "LP1");
  assert.equal(atPatch.loadPortSlots.some(slot => /^OLD/.test(slot.wafer)), false, "补片边界必须清掉上一盒成品");
  assert.deepEqual(atPatch.loadPortSlots.map(slot => slot.wafer), Array.from({ length: 10 }, (_, index) => `NEW${index + 1}`));
});

test("CJobCycle 补片复用 MatID 时不继承上一盒的已加工颜色", () => {
  const cycleDevice = {
    Stations: { LP1: { Type: "LoadPort", Capacity: 1, Slots: [1] }, PM1: { Type: "Process" } },
    Robots: { ATR: {} },
  };
  const cycleMoves = [
    { MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [1], MatIDList: [1], PJobName: ["P1"], StartTime: 0, EndTime: 1 },
    { MoveID: 2, MoveType: 9, ModuleName: "PM1", MatIDList: [1], PJobName: ["P1"], StartTime: 2, EndTime: 3 },
    { MoveID: 3, MoveType: 1, ModuleName: "ATR", DestStationList: ["LP1"], DestSlotList: [1], MatIDList: [1], PJobName: ["P1"], StartTime: 4, EndTime: 5 },
    { MoveID: 4, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [1], MatIDList: [1], PJobName: ["P1-CYCLE-2"], StartTime: 10, EndTime: 11 },
  ];

  const beforePatch = moduleAt(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 5), "LP1");
  assert.deepEqual(beforePatch.loadPortSlots[0], { slot: 1, wafer: "1", processed: true });
  const afterPatch = moduleAt(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 10), "LP1");
  assert.deepEqual(afterPatch.loadPortSlots[0], { slot: 1, wafer: "1", processed: false });
  assert.match(
    logic.renderEquipmentTopology(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 10), cycleDevice),
    /equipment-port-top-view[\s\S]*wafer-unprocessed/,
  );
});

test("CJobCycle 在重算边界立即显示整盒补片，不等待新片首次 Pick", () => {
  const cycleDevice = {
    Stations: { LP1: { Type: "LoadPort", Capacity: 2, Slots: [1, 2] }, PM1: { Type: "Process" } },
    Robots: { ATR: {} },
  };
  const cycleMoves = [
    { MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [1], MatIDList: [1], StartTime: 0, EndTime: 1 },
    { MoveID: 2, MoveType: 9, ModuleName: "PM1", MatIDList: [1], StartTime: 2, EndTime: 3 },
    { MoveID: 3, MoveType: 1, ModuleName: "ATR", DestStationList: ["LP1"], DestSlotList: [1], MatIDList: [1], StartTime: 4, EndTime: 5 },
    { MoveID: 4, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [1], MatIDList: [3], StartTime: 100, EndTime: 101 },
    { MoveID: 5, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], SrcSlotList: [2], MatIDList: [4], StartTime: 110, EndTime: 111 },
  ];
  const payload = {
    ReplayContext: {
      updates: [
        { CurrentTime: 0, Materials: [
          { ID: 1, TaskID: "C1", SrcPortName: "LP1", CurrentModuleName: "LP1", SlotID: 1 },
          { ID: 2, TaskID: "C1", SrcPortName: "LP1", CurrentModuleName: "LP1", SlotID: 2 },
        ] },
        { CurrentTime: 50, Materials: [
          { ID: 3, TaskID: "C1-CYCLE-2", SrcPortName: "LP1", CurrentModuleName: "LP1", SlotID: 1 },
          { ID: 4, TaskID: "C1-CYCLE-2", SrcPortName: "LP1", CurrentModuleName: "LP1", SlotID: 2 },
        ] },
      ],
    },
  };
  const replenishments = logic.normalizeLoadPortReplenishments(payload);
  assert.deepEqual(replenishments, [{
    time: 50,
    moduleName: "LP1",
    materials: [
      { wafer: "3", slot: 1, taskId: "C1-CYCLE-2" },
      { wafer: "4", slot: 2, taskId: "C1-CYCLE-2" },
    ],
  }]);
  const beforeRecompute = moduleAt(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 49.9, replenishments), "LP1");
  assert.equal(beforeRecompute.loadPortSlots[0].wafer, "1");
  assert.equal(beforeRecompute.loadPortSlots[0].processed, true);
  const atRecompute = moduleAt(logic.buildWorkspaceSnapshot(cycleMoves, cycleDevice, 50, replenishments), "LP1");
  assert.deepEqual(atRecompute.loadPortSlots, [
    { slot: 1, wafer: "3", processed: false },
    { slot: 2, wafer: "4", processed: false },
  ]);
});

test("Aligner 使用紧凑叉形，Cooler 使用多槽前视图", () => {
  const auxiliaryDevice = {
    Stations: {
      LP1: { Type: "LoadPort" },
      Aligner: { Type: "Aligner" },
      Cooler: { Type: "Cooler", Capacity: 4, Slots: [1, 2, 3, 4] },
    },
    Robots: { ATR: {} },
  };
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([], auxiliaryDevice, 0), auxiliaryDevice),
    null,
    undefined,
    auxiliaryDevice,
  );
  assert.match(topology, /class="equipment-utility equipment-aligner/);
  assert.match(topology, /class="aligner-cross is-empty"/);
  assert.match(topology, /class="equipment-utility equipment-cooler/);
  assert.equal((topology.match(/class="cooler-slot is-empty"/g) || []).length, 4);
  assert.doesNotMatch(topology, /cooler-plate/);
});

test("E2E 决策在机器人尚未执行时驱动单槽机械臂朝向且不再绘制箭头", () => {
  const idleSnapshot = logic.buildWorkspaceSnapshot(moves, device, 0);
  const decision = {
    decisionIndex: 0,
    selectedActionId: "pick-lp1",
    candidates: [{
      actionId: "pick-lp1",
      selected: true,
      executed: false,
      robot: "ATR",
      source: "LP1",
      destination: "ATR",
    }],
  };
  const topology = logic.renderEquipmentTopology(idleSnapshot, decision);
  assert.match(topology, /class="robot-hub robot-hub-atmosphere[^>]*style="--robot-arm-angle:[\d.-]+deg"[^>]*aria-label="ATR，单槽机械手/);
  assert.match(topology, /class="robot-end-effector is-empty"/);
  assert.doesNotMatch(topology, /class="robot-wrist-joint"/);
  assert.doesNotMatch(topology, /robot-fork-tine/);
  assert.doesNotMatch(topology, /robot-reach-sector/);
  assert.match(topology, /class="robot-environment-badge">ATR</);
  assert.doesNotMatch(topology, /topology-target-arrows|<line /);
});

test("机械手清除旧坐标偏移，并按 PRE_TRANS 进度连续旋转", () => {
  const rotationDevice = {
    Stations: { PM1: { Type: "Process" }, PM5: { Type: "Process" } },
    Robots: { VTR: {} },
  };
  const rotationMoves = [
    {
      MoveID: 1, MoveType: 5, ModuleName: "VTR",
      SrcStationList: ["PM1"], DestStationList: ["PM5"],
      StartTime: 0, EndTime: 10,
    },
    { MoveID: 2, MoveType: 9, ModuleName: "PM5", StartTime: 10, EndTime: 20 },
  ];
  const angleAt = time => {
    const topology = logic.renderEquipmentTopology(
      logic.buildWorkspaceSnapshot(rotationMoves, rotationDevice, time),
      null,
    );
    const match = /style="--robot-arm-angle:([\d.-]+)deg"/.exec(topology);
    assert.ok(match);
    return Number(match[1]);
  };
  assert.notEqual(angleAt(1), angleAt(5));
  assert.notEqual(angleAt(5), angleAt(9));
  const completedSnapshot = logic.buildWorkspaceSnapshot(rotationMoves, rotationDevice, 10);
  assert.equal(completedSnapshot.robots[0].target, "PM5");
  assert.equal(angleAt(10), angleAt(15));

  const css = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
    "utf8",
  );
  assert.match(css, /\.robot-hub-vacuum[^}]*top:\s*auto;\s*left:\s*auto;/);
  assert.match(css, /\.equipment-process \{[^}]*border-radius:\s*0;\s*clip-path:\s*polygon\(29\.29% 0, 70\.71% 0, 100% 29\.29%, 100% 70\.71%, 70\.71% 100%, 29\.29% 100%, 0 70\.71%, 0 29\.29%\)/);
  assert.match(css, /\.equipment-process \.equipment-process-shell \{[^}]*clip-path:\s*polygon\(29\.29% 0, 70\.71% 0, 100% 29\.29%, 100% 70\.71%, 70\.71% 100%, 29\.29% 100%, 0 70\.71%, 0 29\.29%\)/);
  assert.match(css, /\.load-port-shared-base[^}]*z-index:\s*4;[^}]*height:\s*22px;/);
  assert.match(css, /\.reference-grid-canvas \.load-port-assembly \.chamber-door-top[^}]*top:\s*0;/);
  assert.match(css, /\.load-port-slot-bank[^}]*grid-template-rows:\s*repeat\(var\(--load-port-slot-count\), minmax\(0, 1fr\)\);[^}]*gap:\s*0;/);
  assert.match(css, /\.load-port-slot\.is-unprocessed::after[^}]*width:\s*30px;[^}]*height:\s*3px;/);
  assert.doesNotMatch(css, /\.load-port-kind|\.topology-module-filter/);
  assert.match(css, /\.load-port-cassette[^}]*align-self:\s*center;/);
  assert.match(css, /\.equipment-buffer[^}]*width:\s*104px;\s*height:\s*56px;/);
  assert.match(css, /\.equipment-cooler[^}]*width:\s*76px;\s*height:\s*56px;/);
  assert.match(css, /\.robot-arm[^}]*width:\s*88px;/);
  assert.match(css, /\.robot-end-effector \{[^}]*width:\s*26px;[^}]*border-radius:\s*50%;/);
  assert.doesNotMatch(css, /\.robot-fork-tine/);
  assert.match(css, /\.robot-environment-badge[^}]*top:\s*calc\(50% - 44px\);[^}]*padding:\s*2px 4px;/);
  assert.match(css, /\.robot-environment-badge[^}]*white-space:\s*nowrap;/);
  assert.doesNotMatch(css, /\.robot-environment-badge[^}]*min-width:/);
  assert.match(css, /\.robot-held-wafer-0[^}]*translate\(-2px, -2px\)/);
  assert.match(css, /\.robot-held-wafer-1[^}]*translate\(2px, 2px\)/);
  assert.doesNotMatch(css, /robot-capacity-badge|robot-holding-count|robot-external-name|loadlock-pressure-state/);
  assert.doesNotMatch(css, /\.topology-interface-bay/);
  assert.doesNotMatch(css, /\.robot-reach-sector/);
  assert.doesNotMatch(css, /\.robot-effector-palm/);
  assert.doesNotMatch(css, /\.robot-end-effector::after/);
  assert.match(css, /\.equipment-card\.door-open :is\(\.chamber-door, \.loadlock-door\)[^}]*visibility:\s*hidden;\s*opacity:\s*0;/);
  assert.match(css, /\.equipment-card\.door-opening :is\(\.chamber-door, \.loadlock-door\)[^}]*visibility:\s*hidden;\s*opacity:\s*0;/);
});

test("LoadLock 空层不画晶圆线，并区分已加工晶圆且按环境变化蓝色液位", () => {
  const loadLockMoves = [
    { MoveID: 1, MoveType: 13, ModuleName: "LA", StartTime: 0, EndTime: 1 },
    { MoveID: 2, MoveType: 0, ModuleName: "VTR", SrcStationList: ["LP1"], MatIDList: ["W_DONE"], StartTime: 0, EndTime: 1 },
    { MoveID: 3, MoveType: 1, ModuleName: "VTR", DestStationList: ["PM1"], MatIDList: ["W_DONE"], StartTime: 1, EndTime: 2 },
    { MoveID: 4, MoveType: 9, ModuleName: "PM1", MatIDList: ["W_DONE"], StartTime: 2, EndTime: 3 },
    { MoveID: 5, MoveType: 0, ModuleName: "VTR", SrcStationList: ["PM1"], MatIDList: ["W_DONE"], StartTime: 3, EndTime: 4 },
    { MoveID: 6, MoveType: 1, ModuleName: "VTR", DestStationList: ["LA"], MatIDList: ["W_DONE"], StartTime: 4, EndTime: 5 },
    { MoveID: 7, MoveType: 12, ModuleName: "LA", StartTime: 6, EndTime: 10 },
    { MoveID: 8, MoveType: 0, ModuleName: "VTR", SrcStationList: ["LA"], MatIDList: ["W_RAW"], StartTime: 10, EndTime: 11 },
    { MoveID: 9, MoveType: 13, ModuleName: "LA", StartTime: 12, EndTime: 16 },
  ];
  const atmosphereSnapshot = logic.buildWorkspaceSnapshot(loadLockMoves, device, 5);
  assert.deepEqual(moduleAt(atmosphereSnapshot, "LA").processedWafers, ["W_DONE"]);
  const atmosphereTopology = logic.renderEquipmentTopology(atmosphereSnapshot, null);
  assert.match(atmosphereTopology, /--loadlock-atmosphere:100\.0%/);
  assert.match(atmosphereTopology, /--loadlock-atmosphere-ratio:1\.000/);
  assert.match(atmosphereTopology, /class="equipment-external-name">LA</);
  assert.doesNotMatch(atmosphereTopology, /loadlock-environment|loadlock-layer-index/);
  assert.match(atmosphereTopology, /class="loadlock-door loadlock-door-vacuum"/);
  assert.match(atmosphereTopology, /class="loadlock-door loadlock-door-atmosphere"/);
  assert.match(atmosphereTopology, /loadlock-wafer-line wafer-processed/);
  assert.match(atmosphereTopology, /loadlock-wafer-line wafer-unprocessed/);
  assert.doesNotMatch(atmosphereTopology, /loadlock-empty-slot/);
  assert.doesNotMatch(atmosphereTopology, /loadlock-pressure-state/);

  const pumpingTopology = logic.renderEquipmentTopology(
    logic.buildWorkspaceSnapshot(loadLockMoves, device, 8),
    null,
  );
  assert.match(pumpingTopology, /loadlock-pumping/);
  assert.match(pumpingTopology, /--loadlock-atmosphere:50\.0%/);

  const ventingTopology = logic.renderEquipmentTopology(
    logic.buildWorkspaceSnapshot(loadLockMoves, device, 14),
    null,
  );
  assert.match(ventingTopology, /loadlock-venting/);
  assert.match(ventingTopology, /--loadlock-atmosphere:50\.0%/);

  const emptyTopology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([], device, 0), device),
    null,
  );
  assert.doesNotMatch(emptyTopology, /loadlock-wafer-line/);
});

test("初始状态按设备 LastItem 解析 LoadLock 环境，缺省按大气充满蓝色", () => {
  const initialDevice = {
    Stations: {
      LP1: { Type: "LoadPort" },
      LA: { Type: "LoadLock", LastItem: "VTR" },
      LB: { Type: "LoadLock" },
      LC: { Type: "LoadLock", LastItem: "ATR" },
      LD: { Type: "LoadLock", LastItem: "ATR" },
      PM1: { Type: "Process" },
    },
    Robots: { ATR: {}, VTR: {} },
  };
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([], initialDevice, 0), initialDevice),
    null,
  );
  const atmosphereOf = name => {
    const match = new RegExp(`--loadlock-atmosphere:([\\d.]+)%;[^\"]*" aria-label="${name}`).exec(topology);
    return match ? Number(match[1]) : null;
  };
  assert.equal(atmosphereOf("LA"), 0, "LastItem VTR 初始为真空，不充满蓝色");
  assert.equal(atmosphereOf("LB"), 100, "缺少 LastItem 时按大气处理");
  assert.equal(atmosphereOf("LC"), 100, "LastItem ATR 初始为大气，充满蓝色");
  assert.equal(atmosphereOf("LD"), 100, "LastItem ATR 初始为大气，充满蓝色");
});

test("ATR 指向大气侧入口，VTR 放入 LA/LB 时指向两腔中点", () => {
  const portalDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, PM1: { Type: "Process" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      LC: { Type: "LoadLock" }, LD: { Type: "LoadLock" },
    },
    Robots: { ATR: {}, VTR: {} },
  };
  const portalMoves = [
    { MoveID: 1, MoveType: 2, ModuleName: "ATR", SrcStationList: ["LP1"], DestStationList: ["LA"], StartTime: 0, EndTime: 10 },
    { MoveID: 2, MoveType: 0, ModuleName: "VTR", SrcStationList: ["PM1"], DestStationList: ["LB"], StartTime: 0, EndTime: 10 },
  ];
  const snapshot = logic.snapshotWithFullDeviceModules(
    logic.buildWorkspaceSnapshot(portalMoves, portalDevice, 5),
    portalDevice,
  );
  const topology = logic.renderEquipmentTopology(snapshot, null);
  const robotAngle = name => {
    const match = new RegExp(`class="robot-hub robot-hub-[^"]*" style="--robot-arm-angle:([\\d.-]+)deg" aria-label="${name}`).exec(topology);
    assert.ok(match, `应找到 ${name} 的机械臂角度`);
    return Number(match[1]);
  };
  assert.ok(robotAngle("ATR") < -90, "ATR 应向左上方的下排 LoadLock 入口旋转");
  assert.ok(Math.abs(robotAngle("VTR") - 90) < 0.1, "VTR 应垂直指向 LA/LB 的中点");
  assert.doesNotMatch(topology, /topology-target-arrows/);
});

test("VTR 目标为 LA 或 LB 时使用相同的两腔中点角度", () => {
  const midpointDevice = {
    Stations: {
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" }, PM1: { Type: "Process" },
    },
    Robots: { VACRobot: { Type: "VTMRobot" } },
  };
  const angleFor = destination => {
    const movesToLock = [{
      MoveID: 1,
      MoveType: 1,
      ModuleName: "VACRobot",
      SrcStationList: ["PM1"],
      DestStationList: [destination],
      StartTime: 0,
      EndTime: 10,
    }];
    const topology = logic.renderEquipmentTopology(
      logic.snapshotWithFullDeviceModules(
        logic.buildWorkspaceSnapshot(movesToLock, midpointDevice, 5),
        midpointDevice,
      ),
      null,
    );
    const match = /style="--robot-arm-angle:([\d.-]+)deg"/.exec(topology);
    assert.ok(match);
    return Number(match[1]);
  };
  assert.ok(Math.abs(angleFor("LA") - 90) < 0.1);
  assert.ok(Math.abs(angleFor("LB") - 90) < 0.1);
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

test("LoadLock 初始不预显示未来入片，交换后双层仍按物理槽位显示", () => {
  const lockDevice = {
    Stations: {
      LA: { Type: "LoadLock", Capacity: 2, Slots: [1, 2] },
      PM1: { Type: "Process" },
    },
    Robots: { VTR: {} },
  };
  const exchangeMoves = [
    // 未加工 W9 初始在 LA 槽位 1（上层）：由未来取片动作的 SrcSlotList 定位
    { MoveID: 90, MoveType: 0, ModuleName: "VTR", SrcStationList: ["LA"], SrcSlotList: [1], MatIDList: ["W9"], StartTime: 100, EndTime: 101 },
    // 已加工 W1 从 PM1 收回后放回 LA 槽位 2（下层）
    { MoveID: 1, MoveType: 9, ModuleName: "PM1", MatIDList: ["W1"], StartTime: 0, EndTime: 5 },
    { MoveID: 2, MoveType: 0, ModuleName: "VTR", SrcStationList: ["PM1"], MatIDList: ["W1"], StartTime: 5, EndTime: 6 },
    { MoveID: 3, MoveType: 1, ModuleName: "VTR", DestStationList: ["LA"], DestSlotList: [2], MatIDList: ["W1"], StartTime: 6, EndTime: 7 },
    // W1 后续会从 LA 槽位 2 取走，但不能因此在时间零点提前显示
    { MoveID: 91, MoveType: 0, ModuleName: "VTR", SrcStationList: ["LA"], SrcSlotList: [2], MatIDList: ["W1"], StartTime: 110, EndTime: 111 },
  ];
  const initialSnapshot = logic.buildWorkspaceSnapshot(exchangeMoves, lockDevice, 0);
  assert.deepEqual(moduleAt(initialSnapshot, "LA").loadLockSlots, [
    { slot: 1, wafer: "W9", processed: false },
    { slot: 2, wafer: "", processed: false },
  ]);
  const snapshot = logic.buildWorkspaceSnapshot(exchangeMoves, lockDevice, 8);
  const la = moduleAt(snapshot, "LA");
  // 名称排序会得到 ["W1","W9"]；物理槽位跟踪必须得到槽1=W9、槽2=W1
  assert.deepEqual(la.loadLockSlots, [
    { slot: 1, wafer: "W9", processed: false },
    { slot: 2, wafer: "W1", processed: true },
  ]);
  const topology = logic.renderEquipmentTopology(snapshot, null);
  const layerTitles = [...topology.matchAll(/loadlock-layer is-occupied">[\s\S]*?title="([^"]*)"/g)]
    .map(match => match[1]);
  assert.deepEqual(layerTitles, ["晶圆 W9（未加工）", "晶圆 W1（已加工）"]);
});

test("SWAP 交换后送入片落在站上、收回片回到机器人", () => {
  const swapDevice = {
    Stations: {
      LA: { Type: "LoadLock", Capacity: 2, Slots: [1, 2] },
      PM1: { Type: "Process" },
    },
    Robots: { VTR: {} },
  };
  const swapMoves = [
    { MoveID: 1, MoveType: 9, ModuleName: "PM1", MatIDList: ["W2"], StartTime: 0, EndTime: 5 },
    { MoveID: 2, MoveType: 0, ModuleName: "VTR", SrcStationList: ["PM1"], MatIDList: ["W2"], StartTime: 5, EndTime: 6 },
    {
      MoveID: 3, MoveType: 4, ModuleName: "VTR",
      StationList: ["LA"], StnSendSlotList: [1], StnRecvSlotList: [2],
      RecvMatList: ["W1"], SendMatList: ["W2"],
      StartTime: 6, EndTime: 10,
    },
  ];
  const snapshot = logic.buildWorkspaceSnapshot(swapMoves, swapDevice, 10.5);
  assert.deepEqual(moduleAt(snapshot, "LA").wafers, ["W2"]);
  assert.deepEqual(snapshot.robots.find(robot => robot.name === "VTR").wafers, ["W1"]);
  assert.deepEqual(moduleAt(snapshot, "LA").loadLockSlots, [
    { slot: 1, wafer: "", processed: false },
    { slot: 2, wafer: "W2", processed: true },
  ]);
  const topology = logic.renderEquipmentTopology(snapshot, null);
  const layerTitles = [...topology.matchAll(/loadlock-layer is-occupied">[\s\S]*?title="([^"]*)"/g)]
    .map(match => match[1]);
  assert.deepEqual(layerTitles, ["晶圆 W2（已加工）"]);
  assert.match(
    topology,
    /loadlock-layer is-empty"><\/div><div class="loadlock-layer is-occupied">[\s\S]*?晶圆 W2（已加工）/,
  );
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

/** 为渲染测试构造服务端分析 API 已返回的最小性能响应。 */
function visualPerformanceFixture() {
  return {
    window: {
      label: "稳态交叠窗", duration: 20, trimmedStart: 0, trimmedEnd: 0,
    },
    resources: [],
    bottleneckCandidates: [],
    throughputPerHour: 0,
    throughputSampleCount: 0,
    throughputReason: "样本不足，完工片数必须大于 150",
    throughputTimeline: {
      rollingWindowMinimum: 2,
      rollingWindowMaximum: 10,
      cumulative: [
        { wafer: "W1", completedWaferIndex: 1, completedAt: 30, throughputPerHour: 120 },
        { wafer: "W2", completedWaferIndex: 2, completedAt: 45, throughputPerHour: 160 },
      ],
      rollingByWindow: Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
        const windowSize = index + 2;
        return [String(windowSize), [
          { wafer: `W${windowSize + 1}`, completedWaferIndex: windowSize + 1, completedAt: 900, throughputPerHour: 480 },
        ]];
      })),
    },
    cpuTimeMs: null,
    recomputeCount: 0,
    averageRecomputeTimeMs: null,
    waferSystemResidenceTimes: [
      { wafer: "W1", enteredAt: 2, completedAt: 30, duration: 28, chamberDwellSeconds: 0, robotDwellSeconds: 27 },
      { wafer: "W2", enteredAt: 10, completedAt: 45, duration: 35, chamberDwellSeconds: 0, robotDwellSeconds: 53 },
      { wafer: "W3", enteredAt: 40, completedAt: 60, duration: 20, chamberDwellSeconds: 0, robotDwellSeconds: 19 },
      { wafer: "W4", enteredAt: 50, completedAt: 75, duration: 25, chamberDwellSeconds: 0, robotDwellSeconds: 24 },
    ],
    loadLockEfficiency: {
      cycleCount: 0, waferCycleCount: 0, wafersPerCycle: 0,
      fullLoadCycleCount: 0, emptyLoadCycleCount: 0,
      fullLoadCycleRatio: 0, emptyLoadCycleRatio: 0,
    },
  };
}


test("KPI 总览按产能、重算、瓶颈和 LoadLock 效率展示，并将说明放入提示", () => {
  const performance = {
    ...visualPerformanceFixture(),
    throughputPerHour: 67.4,
    throughputSampleCount: 120,
    throughputReason: "",
    cpuTimeMs: 900,
    recomputeCount: 4,
    averageRecomputeTimeMs: 225,
    primaryBottleneck: { label: "PM1", name: "PM1", kind: "process", utilization: 0.876, score: 0.9 },
  };
  const markup = logic.renderSchedulePerformance(performance);

  assert.match(markup, /<span>产能<\/span>[\s\S]*?<span class="performance-kpi-tooltip"/);
  assert.match(markup, /<span>平均重算时间<\/span>/);
  // 瓶颈卡只展示利用率数值：不点名瓶颈资源、不使用警告色。
  assert.match(markup, /<span>瓶颈利用率<\/span>/);
  assert.match(markup, /瓶颈利用率<\/span>[\s\S]*?<strong>87\.6%<\/strong>/);
  assert.doesNotMatch(markup, /<span>瓶颈<\/span>[\s\S]*?<strong>PM1<\/strong>/);
  assert.doesNotMatch(markup, /performance-kpi-card[^"]*is-warning/);
  assert.match(markup, /<span>LoadLock 利用效率<\/span>/);
  assert.match(markup, /CPU Time \/ 4 次重算/);
  assert.doesNotMatch(markup, /<span>CPU Time<\/span>|<span>统计窗口<\/span>/);
  assert.doesNotMatch(markup, /<article class="performance-kpi-card[^"]*">[\s\S]*?<p>/);
  assert.match(markup, /居中 120 片稳态样本/);
  assert.doesNotMatch(markup, /系统状态/);
  assert.match(markup, /产能分析/);
  assert.doesNotMatch(markup, /指标导出参数设置|计算时间|单独导出 CSV/);
});

test("产能图可在从零累计和可选 2 至 10 片滑动窗口间切换", () => {
  const chart = logic.renderThroughputChart(visualPerformanceFixture());
  assert.match(chart, /id="throughputMetricSelect"[\s\S]*累计产能（公司口径）[\s\S]*滑动窗口/);
  assert.match(chart, /id="throughputWindowSize"[\s\S]*2 片[\s\S]*10 片/);
  assert.match(chart, /data-throughput-chart="cumulative"/);
  assert.match(chart, /data-throughput-chart="rolling-2"[\s\S]*? hidden/);
  assert.match(chart, /累计产能曲线/);
  assert.match(chart, /2 片滑动窗口产能曲线/);
  assert.doesNotMatch(chart, /产能（片[/]h）/);
  assert.doesNotMatch(chart, /完成顺序（晶圆）/);
  assert.doesNotMatch(chart, /throughput-chart-axis/);
  assert.match(chart, /id="throughputRangeSelect"[\s\S]*最近 30 片[\s\S]*最近 10 分钟/);
  assert.match(chart, /class="throughput-mean-line"/);
  assert.doesNotMatch(chart, /throughput-limit-line|throughput-reference-line|throughput-chart-area/);
  assert.doesNotMatch(chart, /throughput-chart-hit|throughput-tooltip/);
  assert.match(chart, /class="throughput-chart-value"/);
});

test("大批量产能趋势精简绘图点并保留首尾和尖峰", () => {
  const points = Array.from({ length: 300 }, (_, index) => ({
    wafer: `W${index + 1}`,
    completedWaferIndex: index + 1,
    completedAt: index * 10,
    throughputPerHour: index === 149 ? 999 : 300 + Math.sin(index / 8) * 10,
  }));
  const simplified = logic.simplifyThroughputPoints(points);
  assert.ok(simplified.length <= 72);
  assert.equal(simplified[0], points[0]);
  assert.equal(simplified.at(-1), points.at(-1));
  assert.ok(simplified.includes(points[149]));
});

test("动作接口回放在 Pick 结束后的原子决策边界暂停", async () => {
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const originalCancelAnimationFrame = global.cancelAnimationFrame;
  let scheduledFrame = null;
  global.requestAnimationFrame = callback => {
    scheduledFrame = callback;
    return 1;
  };
  global.cancelAnimationFrame = () => {};

  try {
    const root = fakeWorkspaceDocument();
    const workspace = logic.createVisualizationWorkspace(root);
    await workspace.loadFile({
      name: "dual-actor-primitive-boundary.json",
      async text() {
        return JSON.stringify({ MoveList: moves });
      },
    });
    const autoPause = root.elements.get("visualPauseOnDecisionChangeButton");
    autoPause.click();
    root.elements.get("visualPlayButton").click();
    scheduledFrame(performance.now() + 800);

    assert.equal(root.elements.get("visualCurrentTime").textContent, "2.0");
    assert.equal(autoPause.getAttribute("aria-label"), "已到达下一个原子动作决策，回放已暂停");
  } finally {
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("逐片晶圆驻留图可选择单一指标展示", () => {
  const performance = visualPerformanceFixture();
  const chart = logic.renderWaferResidenceChart(performance);
  assert.match(chart, /驻留时间分析/);
  assert.match(chart, /id="residenceMetricSelect"[\s\S]*系统驻留时间[\s\S]*腔室驻留时间[\s\S]*机器手驻留时间/);
  assert.match(chart, /data-residence-summary="system"[\s\S]*?<small>平均<\/small><b>27\.0<\/b><em>s<\/em>/);
  assert.match(chart, /平均 27\.0 s/);
  assert.doesNotMatch(chart, /上控制限/);
  assert.match(chart, /系统驻留时间/);
  assert.match(chart, /腔室驻留时间/);
  assert.match(chart, /机器手驻留时间/);
  assert.match(chart, /晶圆 W1，系统驻留 28\.0 秒/);
  assert.match(chart, /晶圆 W1，腔室驻留 0\.0 秒/);
  assert.match(chart, /晶圆 W1，机器手驻留 27\.0 秒/);
  assert.match(chart, /residence-bar-chamber/);
  assert.match(chart, /residence-bar-robot/);
  assert.equal((chart.match(/data-residence-metric-chart=/g) ?? []).length, 3);
  assert.equal((chart.match(/data-residence-metric-chart="(?:chamber|robot)" hidden/g) ?? []).length, 2);
  assert.doesNotMatch(chart, /residence-metric-head/);
  assert.equal((chart.match(/class="residence-metric-bar-item"/g) ?? []).length, 12);
});



test("瓶颈分析合并同工序设备、取组平均且最多显示四行", () => {
  const categoryTimes = (process, transfer = 0, environment = 0) => ({
    process,
    clean: 0,
    door: 0,
    transfer,
    environment,
    other: 0,
  });
  const resource = (name, kind, utilization, times) => ({
    name,
    kind,
    utilization,
    busyTime: utilization * 100,
    categoryTimes: times,
  });
  const performance = {
    resources: [
      resource("PM1", "process", 0.9, categoryTimes(90)),
      resource("PM2", "process", 0.7, categoryTimes(70)),
      resource("LA", "loadlock", 0.6, categoryTimes(0, 10, 50)),
      resource("LB", "loadlock", 0.4, categoryTimes(0, 10, 30)),
      resource("LC", "loadlock", 0, categoryTimes(0)),
      resource("LD", "loadlock", 0, categoryTimes(0)),
      resource("VTR", "robot", 0.3, categoryTimes(0, 30)),
      resource("ATR", "robot", 0.2, categoryTimes(0, 20)),
      resource("LP1", "loadport", 0.1, categoryTimes(0, 10)),
    ],
    bottleneckCandidates: [{
      kind: "process-group",
      resourceNames: ["PM1", "PM2"],
      score: 0.88,
      confidence: "high",
    }],
  };

  const groups = logic.groupedBottleneckResources(performance);
  assert.deepEqual(groups.map(group => group.name), ["PM1 / PM2", "LA / LB", "VTR", "ATR"]);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].utilization, 0.8);
  assert.equal(groups[0].busyTime, 80);
  assert.equal(groups[0].categoryTimes.process, 80);
  assert.equal(groups[0].candidate.score, 0.88);
  assert.equal(groups[1].utilization, 0.5);
  assert.equal(groups[1].categoryTimes.environment, 40);
});









test("晶圆必须完成全部加工工序后才标记为已加工", () => {
  const multiProcessDevice = {
    Stations: {
      LP1: { Type: "LoadPort" },
      LA: { Type: "LoadLock" },
      PM1: { Type: "Process" },
      PM2: { Type: "Process" },
    },
    Robots: { ATR: {}, VTR: {} },
  };
  const multiProcessMoves = [
    { MoveID: 1, MoveType: 0, ModuleName: "ATR", SrcStationList: ["LP1"], MatIDList: ["W1"], StartTime: 0, EndTime: 1 },
    { MoveID: 2, MoveType: 1, ModuleName: "ATR", DestStationList: ["PM1"], MatIDList: ["W1"], StartTime: 1, EndTime: 2 },
    { MoveID: 3, MoveType: 9, ModuleName: "PM1", MatIDList: ["W1"], StartTime: 2, EndTime: 4 },
    { MoveID: 4, MoveType: 0, ModuleName: "ATR", SrcStationList: ["PM1"], MatIDList: ["W1"], StartTime: 4, EndTime: 5 },
    { MoveID: 5, MoveType: 1, ModuleName: "ATR", DestStationList: ["PM2"], MatIDList: ["W1"], StartTime: 5, EndTime: 6 },
    { MoveID: 6, MoveType: 9, ModuleName: "PM2", MatIDList: ["W1"], StartTime: 6, EndTime: 8 },
    { MoveID: 7, MoveType: 0, ModuleName: "ATR", SrcStationList: ["PM2"], MatIDList: ["W1"], StartTime: 8, EndTime: 9 },
  ];

  const beforeLastProcessDone = logic.buildWorkspaceSnapshot(multiProcessMoves, multiProcessDevice, 7.999);
  assert.deepEqual(moduleAt(beforeLastProcessDone, "PM2").processedWafers, []);
  const atLastProcessDone = logic.buildWorkspaceSnapshot(multiProcessMoves, multiProcessDevice, 8);
  assert.deepEqual(moduleAt(atLastProcessDone, "PM2").processedWafers, ["W1"]);

  // 第一道工序（PM1）已完成的时刻，W1 尚未完成全部工序，必须保持未加工。
  const firstDone = logic.buildWorkspaceSnapshot(multiProcessMoves, multiProcessDevice, 5);
  const firstRobot = firstDone.robots.find(robot => robot.name === "ATR");
  assert.deepEqual(firstRobot.wafers, ["W1"]);
  assert.deepEqual(firstRobot.processedWafers, []);
  const firstTopology = logic.renderEquipmentTopology(firstDone, null);
  assert.match(firstTopology, /wafer-token wafer-unprocessed/);
  assert.doesNotMatch(firstTopology, /wafer-token wafer-processed/);

  // 第二道工序（PM2）也完成之后，W1 才标记为已加工。
  const allDone = logic.buildWorkspaceSnapshot(multiProcessMoves, multiProcessDevice, 8.5);
  const pm2Module = moduleAt(allDone, "PM2");
  assert.deepEqual(pm2Module.wafers, ["W1"]);
  assert.deepEqual(pm2Module.processedWafers, ["W1"]);
  const secondTopology = logic.renderEquipmentTopology(allDone, null);
  assert.match(secondTopology, /wafer-token wafer-processed/);
  assert.doesNotMatch(secondTopology, /wafer-token wafer-unprocessed/);
});

test("工艺腔渲染为正八边形 shell 结构，清洁状态使用浅粉色样式", () => {
  const topology = logic.renderEquipmentTopology(logic.buildWorkspaceSnapshot(moves, device, 0), null);
  assert.match(topology, /class="equipment-card equipment-process[^"]*"[^>]*>\s*<div class="equipment-process-shell"><div class="equipment-body"/);
  assert.doesNotMatch(topology, /class="equipment-card equipment-lock[^"]*"[^>]*>\s*<div class="equipment-process-shell"/);
  const css = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
    "utf8",
  );
  assert.match(css, /\.reference-grid-canvas \.equipment-process \.equipment-process-shell \{[^}]*clip-path:\s*polygon\(29\.29% 0, 70\.71% 0, 100% 29\.29%, 100% 70\.71%, 70\.71% 100%, 29\.29% 100%, 0 70\.71%, 0 29\.29%\)/);
  assert.match(css, /\.reference-grid-canvas \.equipment-process\.status-cleaning \.equipment-process-shell \{ background: #fdeef1; \}/);
  assert.match(css, /\.reference-grid-canvas \.equipment-process\.status-cleaning \{ background: #d98a97; \}/);
  assert.doesNotMatch(css, /reference-chamber-clean-sweep/, "清洁状态仅保留粉色，不应有循环扫光动画");
});

test("以空 ProcessMove 或清洁配方记录的清洁在拓扑回放中可见", () => {
  const cleanMoves = [
    { MoveID: 1, MoveType: 9, ModuleName: "PM1", MatIDList: [], StartTime: 10, EndTime: 20 },
    { MoveID: 2, MoveType: 9, ModuleName: "PM2", MatIDList: ["D1"], CleanRecipe: "Dummy Clean", StartTime: 30, EndTime: 40 },
  ];

  const emptyProcessSnapshot = logic.buildWorkspaceSnapshot(cleanMoves, device, 15);
  const recipeMarkedSnapshot = logic.buildWorkspaceSnapshot(cleanMoves, device, 35);

  assert.equal(moduleAt(emptyProcessSnapshot, "PM1").status, "cleaning");
  assert.equal(moduleAt(emptyProcessSnapshot, "PM1").activeMoveName, "清洁");
  assert.equal(moduleAt(recipeMarkedSnapshot, "PM2").status, "cleaning");
  assert.match(logic.renderEquipmentTopology(recipeMarkedSnapshot, null), /PM2[\s\S]*清洁中/);
});

test("瓶颈分析隐藏说明、窗口详情和统计口径可见标签", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/src/workspace_visualizer.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /同一道工序的设备合并取平均，按平均利用率最多显示 4 行。/);
  assert.doesNotMatch(source, /class="performance-window-note"/);
  assert.doesNotMatch(source, /class="bottleneck-window-control">统计口径/);
  assert.match(source, /class="visually-hidden">统计口径<\/span>/);
});

test("瓶颈分析提供目的、判定原理和最优性说明", () => {
  const workspaceSource = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/src/workspace_visualizer.ts"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/config_editor.html"),
    "utf8",
  );
  const editorSource = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/src/config_editor.ts"),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
    "utf8",
  );

  assert.match(workspaceSource, /id="bottleneckAnalysisHelpButton"/);
  assert.match(html, /id="bottleneckAnalysisHelpDialog"[\s\S]*为什么不能只看 Makespan？[\s\S]*容量利用率 × 82%[\s\S]*99% 以上[\s\S]*容量组取平均利用率/);
  assert.match(editorSource, /bottleneckAnalysisHelpDialog\.showModal\(\)/);
  assert.match(css, /\.bottleneck-analysis-help-dialog/);
});

test("驻留时间分析展示逐片腔室和机器手驻留，并提供说明", () => {
  const workspaceSource = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/src/workspace_visualizer.ts"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/config_editor.html"),
    "utf8",
  );
  const editorSource = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/src/config_editor.ts"),
    "utf8",
  );

  assert.match(workspaceSource, /chamber: \{ title: "腔室驻留时间"/);
  assert.match(workspaceSource, /robot: \{ title: "机器手驻留时间"/);
  assert.match(workspaceSource, /renderResidenceMetricChart/);
  assert.match(workspaceSource, /说明<\/button>/);
  assert.match(workspaceSource, /id="residenceMetricSelect"/);
  assert.match(workspaceSource, /id="residenceAnalysisHelpButton"/);
  assert.match(html, /id="residenceAnalysisHelpDialog"[\s\S]*三种驻留时间分别表示什么？[\s\S]*已扣除显式 PreTrans 搬运时间/);
  assert.match(editorSource, /residenceAnalysisHelpDialog\.showModal\(\)/);
  assert.match(editorSource, /data-residence-metric-chart/);
});
