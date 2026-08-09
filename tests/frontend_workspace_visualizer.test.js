"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const logic = require("../realtime_scheduler/frontend/workspace_visualizer_logic.js");
const analysisLogic = require("../realtime_scheduler/analysis/schedule_analysis.js");

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
    "visualRecommendationModel",
    "visualRecommendationModelHint",
    "visualFilterAligner",
    "visualFilterCooler",
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

test("合法动作空间面板保持单一候选列表与标准开关视觉契约", () => {
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
  assert.match(html, /id="visualPauseOnDecisionChangeButton"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="searchTelemetryContinuousDecisionButton"[^>]*aria-pressed="false"[^>]*>持续决策<\/button>/);
  assert.match(html, /id="visualRecommendationModelControl"/);
  assert.match(css, /\.decision-lens-panel[^\n]*border-radius: 6px[^\n]*box-shadow: none/);
  assert.match(css, /\.decision-auto-pause[^\n]*min-height: 44px/);
  assert.match(css, /\.decision-tag\.is-recommendation/);
  assert.match(css, /body\.theme-dark \.decision-tag\.is-recommendation/);
  assert.doesNotMatch(css, /\.topology-playback\.is-instant-state-transition/);
  assert.match(source, /visualRecommendationModelControl"\)\.hidden = stepMode/);
  assert.match(source, /visualPauseOnDecisionChangeButton"\)\.hidden = stepMode/);
  assert.match(source, /function maybeContinueModelDecision\(snapshot\)/);
  assert.match(source, /searchId === continuousDecisionSubmittedSearchId/);
  assert.match(source, /void chooseSearchAction\(actionKey, true\)/);
  assert.match(source, /function toggleContinuousDecision\(\)/);
  assert.match(source, /<strong id="searchCandidatesTitle">决策 #\$\{decisionIndex\}<\/strong>/);
  assert.match(source, /P 先验[\s\S]*N 访问[\s\S]*Q 价值[\s\S]*推荐比例/);
  assert.match(source, /animateLatestStep/);
  assert.doesNotMatch(source, /根节点全部合法动作|物料 \$\{action\.materialIds/);
  assert.doesNotMatch(css, /decision-selected-summary|decision-preference-track|decision-auto-pause:hover|decision-candidate:hover/);
});

test("E2E 决策轨迹保留候选偏好、Makespan 增量和未来决策时刻", () => {
  const trace = logic.normalizeDecisionTrace({
    DecisionTrace: [
      {
        decisionIndex: 2,
        time: 8,
        candidateCount: 2,
        modelEvaluated: true,
        selectedActionId: "move-b",
        candidates: [
          {
            actionId: "move-b", rank: 1, selected: true, source: "LA",
            destination: "PM2", policyPreference: 0.72,
            expectedRemainingMakespan: 90, makespanDelta: 0,
          },
          {
            actionId: "move-a", rank: 2, source: "LA",
            destination: "PM1", policyPreference: 0.28,
            expectedRemainingMakespan: 96, makespanDelta: 6,
          },
        ],
      },
      { decisionIndex: 1, time: 3, candidateCount: 1, candidates: [] },
    ],
  });

  assert.equal(trace.length, 2);
  assert.equal(trace[1].candidates[0].destination, "PM2");
  assert.equal(trace[1].candidates[1].makespanDelta, 6);
  assert.equal(logic.decisionAtTime(trace, 7).decisionIndex, 1);
  assert.equal(logic.decisionAtTime(trace, 8).decisionIndex, 2);
});

test("决策空间签名忽略排序和分数，仅关注候选集合变化", () => {
  const [first] = logic.normalizeDecisionTrace({
    DecisionTrace: [{
      candidateCount: 2,
      candidates: [
        { actionId: "move-a", rank: 1, policyPreference: 0.8 },
        { actionId: "move-b", rank: 2, policyPreference: 0.2 },
      ],
    }],
  });
  const [reranked] = logic.normalizeDecisionTrace({
    DecisionTrace: [{
      candidateCount: 2,
      candidates: [
        { actionId: "move-b", rank: 1, policyPreference: 0.9 },
        { actionId: "move-a", rank: 2, policyPreference: 0.1 },
      ],
    }],
  });
  const [changed] = logic.normalizeDecisionTrace({
    DecisionTrace: [{
      candidateCount: 1,
      candidates: [{ actionId: "move-a", rank: 1, policyPreference: 1 }],
    }],
  });

  assert.equal(logic.decisionSpaceSignature(first), logic.decisionSpaceSignature(reranked));
  assert.notEqual(logic.decisionSpaceSignature(first), logic.decisionSpaceSignature(changed));
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
  assert.match(lens, /决策 #0/);
  assert.match(lens, /可行动作/);
  assert.match(lens, /E2E推荐/);
  assert.match(lens, /Δ 基准/);
  assert.doesNotMatch(lens, /实时推荐|物理约束结果|decision-selected-summary|其它可行动作|decision-preference-track/);
  assert.match(root.elements.get("visualDeviceStage").innerHTML, /PM2/);

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

test("合法动作空间按偏好排序并格式化低偏好和工期差值", async () => {
  const root = fakeWorkspaceDocument();
  const workspace = logic.createVisualizationWorkspace(root);
  await workspace.loadFile({
    name: "decision-panel.json",
    async text() {
      return JSON.stringify({
        MoveList: moves,
        DecisionTrace: [{
          decisionIndex: 65,
          time: 0,
          candidateCount: 3,
          candidates: [
            {
              actionId: "second", rank: 1, source: "VTR", destination: "PM1",
              robot: "VTR", flowKind: "internal", policyPreference: 0.004,
              expectedRemainingMakespan: 19.5, makespanDelta: 10.3,
            },
            {
              actionId: "recommended", rank: 2, source: "LP1", destination: "ATR",
              robot: "ATR", flowKind: "internal", policyPreference: 0.996,
              expectedRemainingMakespan: 2.5, makespanDelta: 0, executed: true,
            },
            {
              actionId: "third", rank: 3, source: "ATR", destination: "LA",
              robot: "ATR", flowKind: "feed", policyPreference: 0,
              expectedRemainingMakespan: 20, makespanDelta: 11.2,
            },
          ],
        }],
      });
    },
  });

  const lens = root.elements.get("visualDecisionLens").innerHTML;
  assert.match(lens, /决策 #65[\s\S]*3 个可行动作 · E2E 排序/);
  assert.ok(lens.indexOf("LP1 → ATR") < lens.indexOf("VTR → PM1"), "动作应按 E2E 偏好降序排列");
  assert.match(lens, /LP1 → ATR[\s\S]*E2E推荐[\s\S]*与计划一致[\s\S]*99\.6%|LP1 → ATR[\s\S]*E2E推荐[\s\S]*与计划一致[\s\S]*100%/);
  assert.match(lens, /VTR → PM1[\s\S]*VTR · internal[\s\S]*剩余工期 <strong>19\.5s<\/strong>[\s\S]*Δ \+10\.3s[\s\S]*<1%/);
  assert.match(lens, /Δ 基准/);
  assert.equal((lens.match(/class="decision-candidate"/g) || []).length, 3);
  assert.doesNotMatch(lens, /为什么推荐|候选对比|动作证据|已观察切片|Top-2|上一决策|下一决策|导出决策样本|剩余 Makespan|预测区间|lowerRemainingMakespan|upperRemainingMakespan/);
});

test("双 Actor 推荐按大气端和真空端分开显示且不跨域混排", async () => {
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

  const modelSelect = root.elements.get("visualRecommendationModel");
  modelSelect.value = "dual-actor-e2e";
  modelSelect.listeners.get("change")();
  const lens = root.elements.get("visualDecisionLens").innerHTML;
  assert.match(lens, /决策 #12[\s\S]*双 Actor · 原始模型决策/);
  assert.match(lens, /大气端 Actor[\s\S]*大气端推荐[\s\S]*真空端 Actor[\s\S]*真空端推荐/);
  assert.ok(lens.indexOf("LP1 → ATR 手上") < lens.indexOf("ATR 手上 → LA"), "大气端应在自己的榜单内排序");
  assert.equal((lens.match(/data-recommendation-actor=/g) || []).length, 2);
  assert.match(root.elements.get("visualRecommendationModelHint").textContent, /原始提案/);
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

test("重入让位候选按最终调度优先级展示且计划标签指向紧邻事务", async () => {
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
  assert.ok(lens.indexOf("PM3 → PM2") < lens.indexOf("LP1 → LB"));
  assert.match(lens, /PM3 → PM2[\s\S]*E2E推荐[\s\S]*与计划一致/);
  assert.doesNotMatch(lens, /LP1 → LB[\s\S]*E2E推荐/);
});

test("开启保护后，回放越过完整事务边界时精确暂停在下一决策", async () => {
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
    assert.equal(root.elements.get("visualCurrentTime").textContent, "3.0");
    assert.equal(autoPause.getAttribute("aria-checked"), "true");
    assert.equal(autoPause.getAttribute("aria-label"), "已到达下一个完整事务决策，回放已暂停");
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
  const pattern = /class="reference-(module|robot)-position" style="--(?:module|robot)-left:([\d.]+)%;--(?:module|robot)-top:(\d+)px">([\s\S]*?)(?=<div class="reference-|\s*<svg class="topology-target-arrows)/g;
  let match;
  while ((match = pattern.exec(topology)) !== null) {
    const isRobot = match[1] === "robot";
    const isLoadLock = /class="equipment-card equipment-lock\b/.test(match[4]);
    const isProcess = /class="equipment-card equipment-process\b/.test(match[4]);
    const isLoadPort = /class="load-port-assembly\b/.test(match[4]);
    const isBuffer = /class="equipment-utility equipment-buffer\b/.test(match[4]);
    const isCooler = /class="equipment-utility equipment-cooler\b/.test(match[4]);
    positions.push({
      x: Number(match[2]) / 100 * 1000,
      y: Number(match[3]),
      width: isRobot ? 132 : isLoadLock ? 120 : isLoadPort ? 144 : isBuffer ? 104 : isCooler ? 92 : isProcess ? 112 : 96,
      height: isRobot ? 132 : isLoadLock ? 72 : isLoadPort ? 104 : isBuffer ? 56 : isCooler ? 54 : isProcess ? 122 : 96,
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

test("单真空机械手拓扑显示使用中的 LP、Dummy Port 与大气侧辅助设备且不重叠", () => {
  const fullDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" },
      LP3: { Type: "LoadPort" }, LP4: { Type: "LoadPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      LC: { Type: "LoadLock" }, LD: { Type: "LoadLock" },
      PM1: { Type: "ProcessChamber" }, PM2: { Type: "ProcessChamber" },
      PM3: { Type: "ProcessChamber" }, PM4: { Type: "ProcessChamber" },
      PM5: { Type: "ProcessChamber" }, PM6: { Type: "ProcessChamber" },
      Buffer1: { Type: "Buffer" }, Buffer2: { Type: "Buffer" },
      Buffer3: { Type: "Buffer" }, Buffer4: { Type: "Buffer" },
      Aligner: { Type: "Aligner" }, heater: { Type: "Heater" },
      Cooler: { Type: "Cooler" }, DummyPort: { Type: "LoadPort" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR: { Type: "VTMRobot" } },
  };
  const required = [
    "LP1", "DummyPort", "Buffer1", "Buffer2", "Buffer3", "Buffer4", "Cooler",
    "LA", "LB", "PM1", "PM2", "PM3", "PM4", "PM5", "PM6",
  ];
  const snapshot = logic.buildWorkspaceSnapshot(moves, fullDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, fullDevice),
    null,
  );
  assertTopologyComplete(topology, required);
  assert.doesNotMatch(topology, />LP[2-4]</);
  assert.match(topology, /class="load-port-assembly is-dummy-port door-closed"/);
  assert.match(topology, /class="load-port-kind">DUMMY</);
  assert.match(topology, /class="load-port-shared-base"/);
  assert.match(topology, /class="equipment-utility equipment-buffer/);
  assert.match(topology, /class="equipment-utility equipment-cooler/);
  assert.doesNotMatch(topology, />heater</i);
  assert.doesNotMatch(topology, /DEVICE TOPOLOGY|设备配置全量模块/);
  assert.match(topology, /--module-left:26%;/);
  assert.match(topology, /--topology-canvas-height:\d+px/);
  assert.match(topology, /class="topology-zone topology-zone-vacuum"/);
  assert.doesNotMatch(topology, /VACUUM PROCESS AREA/);
  assert.match(topology, /<small>真空加工区<\/small>/);
  assert.match(topology, /class="topology-interface-bay"/);
  assert.match(topology, /VACUUM \/ ATM INTERFACE/);
  assert.match(topology, /class="topology-zone topology-zone-atmosphere"/);
  assert.doesNotMatch(topology, /ATM TRANSFER AREA/);
  assert.match(topology, /<small>大气传输区<\/small>/);

  const modulePosition = name => {
    const match = new RegExp(
      `class="reference-module-position" style="--module-left:([\\d.]+)%;--module-top:(\\d+)px">(?:(?!class="reference-module-position")[\\s\\S])*?<strong[^>]*>${name}</strong>`,
    ).exec(topology);
    assert.ok(match, `应找到 ${name} 的坐标`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const robotPosition = name => {
    const match = new RegExp(
      `class="reference-robot-position" style="--robot-left:([\\d.]+)%;--robot-top:(\\d+)px">(?:(?!class="reference-robot-position")[\\s\\S])*?aria-label="${name}，`,
    ).exec(topology);
    assert.ok(match, `应找到 ${name} 的坐标`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const lp1 = modulePosition("LP1");
  const dummyPort = modulePosition("DummyPort");
  assert.equal(dummyPort.y, lp1.y, "Dummy Port 应与普通 LoadPort 共用同一排底座");
  assert.deepEqual([lp1.x, dummyPort.x], [26, 74], "Dummy Port 应固定在第四列");
  const atr = robotPosition("ATR");
  assert.equal(lp1.y - atr.y, 140, "LoadPort 整排应在 ATR 下方保留更大的垂直间距");
  for (const name of ["Buffer1", "Buffer2", "Buffer3", "Buffer4", "Cooler"]) {
    assert.equal(modulePosition(name).x, 90, `${name} 应位于大气传输区右侧`);
  }
  const atmosphereZone = /class="topology-zone topology-zone-atmosphere" style="--zone-top:([\d.]+)px;--zone-height:([\d.]+)px"/.exec(topology);
  assert.ok(atmosphereZone, "应找到大气传输区边界");
  const atmosphereTop = Number(atmosphereZone[1]);
  assert.ok(modulePosition("Cooler").y - 27 >= atmosphereTop, "Cooler 应完整位于大气传输区内");
  assert.ok(modulePosition("Buffer1").y - 28 >= atmosphereTop, "首个 Buffer 应完整位于大气传输区内");
  const pm2 = modulePosition("PM2");
  const pm3 = modulePosition("PM3");
  const pm4 = modulePosition("PM4");
  const pm1 = modulePosition("PM1");
  const vtr = robotPosition("VTR");
  assert.equal(vtr.x, 50);
  assert.equal(vtr.y, (pm1.y + pm2.y) / 2);
  assert.equal(pm3.y + 52, pm2.y - 52, "PM3 底边应与 PM2 顶边水平");
  assert.equal(pm4.y + 52, pm2.y - 52, "PM4 底边应与 PM2 顶边水平");
  const vacuumZone = /class="topology-zone topology-zone-vacuum" style="--zone-top:([\d.]+)px;--zone-height:([\d.]+)px"/.exec(topology);
  assert.ok(vacuumZone, "应找到真空加工区边界");
  const vacuumTop = Number(vacuumZone[1]);
  const vacuumBottom = vacuumTop + Number(vacuumZone[2]);
  for (const name of ["PM1", "PM2", "PM3", "PM4", "PM5", "PM6"]) {
    const position = modulePosition(name);
    assert.ok(position.y - 52 >= vacuumTop && position.y + 52 <= vacuumBottom, `${name} 应完整位于真空加工区内`);
  }
  assert.ok(vtr.y - 66 >= vacuumTop && vtr.y + 66 <= vacuumBottom, "VTR 应完整位于真空加工区内");

  const la = modulePosition("LA");
  const lb = modulePosition("LB");
  const lc = modulePosition("LC");
  const ld = modulePosition("LD");
  assert.deepEqual([la.x, lb.x], [40, 60], "第一行应为 LA / LB，并在中等画布保持清晰间距");
  assert.deepEqual([lc.x, ld.x], [40, 60], "第二行应为 LC / LD，并在中等画布保持清晰间距");
  assert.equal(la.y, lb.y);
  assert.equal(lc.y, ld.y);
  assert.equal(lc.y - la.y, 76, "上下两排 LoadLock 应保留 4px 腔体间隙");
  assert.match(topology, /class="loadlock-layers"/);
  assert.equal((topology.match(/class="loadlock-layer /g) || []).length, 8, "四个 LoadLock 各显示两层");
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
  assert.deepEqual([xFor("LP1"), xFor("LP2"), xFor("DummyPort")], [26, 42, 74]);
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

test("模块筛选默认勾选 Aligner/Cooler，取消勾选后重新显示", async () => {
  const root = fakeWorkspaceDocument();
  root.elements.get("visualFilterAligner").checked = true;
  root.elements.get("visualFilterCooler").checked = true;
  const workspace = logic.createVisualizationWorkspace(root);
  workspace.setDevice({
    Stations: {
      LP1: { Type: "LoadPort" },
      LA: { Type: "LoadLock" },
      PM1: { Type: "Process" },
      Aligner: { Type: "Aligner" },
      Cooler: { Type: "Cooler" },
    },
    Robots: { ATR: {} },
  });
  await workspace.loadFile({
    name: "filter-default.json",
    async text() {
      return JSON.stringify({ MoveList: moves });
    },
  });
  const stage = root.elements.get("visualDeviceStage");
  assert.doesNotMatch(stage.innerHTML, />Aligner</, "默认勾选时 Aligner 不在画布显示");
  assert.doesNotMatch(stage.innerHTML, />Cooler</, "默认勾选时 Cooler 不在画布显示");
  const alignerCheckbox = root.elements.get("visualFilterAligner");
  alignerCheckbox.checked = false;
  alignerCheckbox.listeners.get("change")();
  assert.match(stage.innerHTML, />Aligner</, "取消勾选 Aligner 后重新显示");
  assert.doesNotMatch(stage.innerHTML, />Cooler</, "Cooler 仍保持默认隐藏");
});

test("双真空机械手级联拓扑隐藏未使用 LP，并完整显示腔室且不重叠", () => {
  const fullDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" },
      LP3: { Type: "LoadPort" }, LP4: { Type: "LoadPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      UBR: { Type: "LoadLock" }, DBR: { Type: "LoadLock" },
      PM1: { Type: "ProcessChamber" }, PM2: { Type: "ProcessChamber" },
      PM3: { Type: "ProcessChamber" }, PM4: { Type: "ProcessChamber" },
      PM5: { Type: "ProcessChamber" }, PM6: { Type: "ProcessChamber" },
      Buffer1: { Type: "Buffer" }, Buffer2: { Type: "Buffer" },
      Buffer3: { Type: "Buffer" }, Buffer4: { Type: "Buffer" },
      Aligner: { Type: "Aligner" },
    },
    Robots: { ATR: { Type: "ATMRobot" }, VTR_1: { Type: "VTMRobot" }, VTR_2: { Type: "HighVTMRobot" } },
  };
  const required = ["LP1", "LA", "LB", "UBR", "DBR", "PM1", "PM2", "PM3", "PM4", "PM5", "PM6"];
  const snapshot = logic.buildWorkspaceSnapshot(moves, fullDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, fullDevice),
    null,
  );
  assertTopologyComplete(topology, required);
  assert.doesNotMatch(topology, />LP[2-4]</);
  const yOf = name => {
    const module = new RegExp(
      `class="reference-module-position" style="--module-left:[\\d.]+%;--module-top:(\\d+)px">\\s*<strong class="equipment-external-name[^"]*">${name}</strong>`
    ).exec(topology);
    if (module) return Number(module[1]);
    const robot = new RegExp(
      `class="reference-robot-position" style="--robot-left:[\\d.]+%;--robot-top:(\\d+)px">\\s*<article class="robot-hub[^"]*"[^>]*aria-label="${name}`
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
  const zoneHeight = topology => {
    const match = /class="topology-zone topology-zone-atmosphere" style="--zone-top:[\d.]+px;--zone-height:([\d.]+)px"/.exec(topology);
    assert.ok(match, "应找到大气传输区高度");
    return Number(match[1]);
  };
  const zoneBounds = (topology, className) => {
    const match = new RegExp(`class="${className}" style="--zone-top:([\\d.]+)px;--zone-height:([\\d.]+)px"`).exec(topology);
    assert.ok(match, `应找到 ${className} 边界`);
    const top = Number(match[1]);
    return { top, bottom: top + Number(match[2]) };
  };
  const verticalPosition = (topology, kind, name) => {
    const prefix = kind === "robot"
      ? 'class="reference-robot-position" style="--robot-left:[\\d.]+%;--robot-top:'
      : 'class="reference-module-position" style="--module-left:[\\d.]+%;--module-top:';
    const match = new RegExp(`${prefix}(\\d+)px">(?:(?!class="reference-(?:robot|module)-position")[\\s\\S])*?${name}`).exec(topology);
    assert.ok(match, `应找到 ${name} 的纵向坐标`);
    return Number(match[1]);
  };
  const singleTopology = render(singleDevice);
  const cascadeTopology = render(cascadeDevice);

  assert.equal(zoneHeight(cascadeTopology), zoneHeight(singleTopology), "两类拓扑的大气传输区应等高");
  for (const topology of [singleTopology, cascadeTopology]) {
    const interfaceBay = zoneBounds(topology, "topology-interface-bay");
    const atmosphereZone = zoneBounds(topology, "topology-zone topology-zone-atmosphere");
    assert.equal(atmosphereZone.top - interfaceBay.bottom, 12, "大气传输区应紧接 LA/LB 接口带");
    assert.equal(
      verticalPosition(topology, "module", "LP1") - verticalPosition(topology, "robot", "ATR"),
      140,
      "ATR 到 LoadPort 的垂直间距应统一",
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

test("三级机器手设备按结构使用级联布局，不依赖设备名称", () => {
  const twelveKDevice = {
    Stations: {
      LP1: { Type: "LoadPort" }, LP2: { Type: "LoadPort" },
      LP3: { Type: "LoadPort" }, LP4: { Type: "LoadPort" },
      LA: { Type: "LoadLock" }, LB: { Type: "LoadLock" },
      LC: { Type: "LoadLock" }, LD: { Type: "LoadLock" },
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
  assertTopologyComplete(topology, ["LA", "LB", "LC", "LD", "UBR", "DBR", "PM1", "PM2", "PM3", "PM4", "PM5"]);
  const positionOf = name => {
    const module = new RegExp(
      `class="reference-module-position" style="--module-left:([\\d.]+)%;--module-top:(\\d+)px">\\s*<strong class="equipment-external-name[^"]*">${name}</strong>`
    ).exec(topology);
    if (module) return { x: Number(module[1]) / 100 * 1000, y: Number(module[2]) };
    const robot = new RegExp(
      `class="reference-robot-position" style="--robot-left:([\\d.]+)%;--robot-top:(\\d+)px">\\s*<article class="robot-hub[^"]*"[^>]*aria-label="${name}`
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
  assert.equal(pm3.x, vtr2.x, "PM3 应在 VTR_2 正上方");
  assert.ok(pm3.y < vtr2.y, "PM3 应位于 VTR_2 上方");
  assert.equal(pm4.y, vtr2.y, "PM4 应与 VTR_2 同排");
  assert.equal(pm5.y, vtr2.y, "PM5 应与 VTR_2 同排");
  assert.ok(pm4.x < vtr2.x && pm5.x > vtr2.x, "PM4/PM5 应分列 VTR_2 左右");
  const la = positionOf("LA"), lb = positionOf("LB"), lc = positionOf("LC"), ld = positionOf("LD");
  assert.equal(la.y, lb.y, "LA/LB 应同排（田字格上排）");
  assert.equal(lc.y, ld.y, "LC/LD 应同排（田字格下排）");
  assert.ok(lc.y > la.y, "LC/LD 应在 LA/LB 下方");
  assert.ok(la.x < lb.x && lc.x < ld.x, "田字格左右分布");
  assert.equal(la.x, lc.x, "LA/LC 同列");
  assert.equal(lb.x, ld.x, "LB/LD 同列");
  const vacuumZone = /class="topology-zone topology-zone-vacuum" style="--zone-top:([\d.]+)px;--zone-height:([\d.]+)px"/.exec(topology);
  assert.ok(vacuumZone, "应绘制真空加工区");
  const vacuumTop = Number(vacuumZone[1]);
  const vacuumBottom = vacuumTop + Number(vacuumZone[2]);
  for (const name of ["UBR", "DBR", "PM1", "PM2", "PM3", "PM4", "PM5", "VTR_1", "VTR_2"]) {
    const y = positionOf(name).y;
    assert.ok(
      y >= vacuumTop && y <= vacuumBottom,
      `${name} 应位于真空加工区内（y=${y}，真空区 ${vacuumTop}~${vacuumBottom}）`,
    );
  }
  const interfaceBay = /class="topology-interface-bay" style="--zone-top:([\d.]+)px;--zone-height:([\d.]+)px"/.exec(topology);
  assert.ok(interfaceBay, "应绘制大气/真空接口带");
  const interfaceTop = Number(interfaceBay[1]);
  const interfaceBottom = interfaceTop + Number(interfaceBay[2]);
  for (const name of ["UBR", "DBR"]) {
    const y = positionOf(name).y;
    assert.ok(
      y < interfaceTop || y > interfaceBottom,
      `${name} 不应落入大气/真空接口带（y=${y}，接口带 ${interfaceTop}~${interfaceBottom}）`,
    );
  }
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
  assertTopologyComplete(topology, ["LP1", "LA", "LB", "PM1", "PM2"]);
  assert.doesNotMatch(topology, />LP2</);
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
  assert.match(returnedTopology, /equipment-external-name equipment-external-name-port">LP1</);
  assert.doesNotMatch(returnedTopology, /load-port-slot-summary|>RAW\s|>DONE\s/);
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
  assert.match(css, /\.reference-grid-canvas \.load-port-assembly \.chamber-door-top[^}]*top:\s*12px;/);
  assert.match(css, /\.load-port-cassette[^}]*align-self:\s*center;/);
  assert.match(css, /\.equipment-buffer[^}]*width:\s*104px;\s*height:\s*56px;/);
  assert.match(css, /\.equipment-cooler[^}]*width:\s*92px;\s*height:\s*54px;/);
  assert.match(css, /\.robot-arm[^}]*width:\s*88px;/);
  assert.match(css, /\.robot-end-effector \{[^}]*width:\s*26px;[^}]*border-radius:\s*50%;/);
  assert.doesNotMatch(css, /\.robot-fork-tine/);
  assert.match(css, /\.robot-environment-badge[^}]*top:\s*calc\(50% - 44px\);[^}]*padding:\s*2px 4px;/);
  assert.match(css, /\.robot-environment-badge[^}]*white-space:\s*nowrap;/);
  assert.doesNotMatch(css, /\.robot-environment-badge[^}]*min-width:/);
  assert.match(css, /\.robot-held-wafer-0[^}]*translate\(-2px, -2px\)/);
  assert.match(css, /\.robot-held-wafer-1[^}]*translate\(2px, 2px\)/);
  assert.doesNotMatch(css, /robot-capacity-badge|robot-holding-count|robot-external-name|loadlock-pressure-state/);
  assert.match(css, /\.topology-interface-bay[^}]*right:\s*30%;\s*left:\s*30%;/);
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

test("性能分析用首片完工到末片投料剔除启动与收尾", () => {
  const performance = logic.analyzeSchedulePerformance(performanceMoves, device, "steady");
  assert.equal(performance.window.method, "steady-overlap");
  assert.equal(performance.window.start, 30);
  assert.equal(performance.window.end, 50);
  assert.equal(performance.completedWaferCount, 2);
  assert.equal(performance.throughputPerHour, 240);
  assert.equal(performance.departureIntervalCv, 0);
  assert.equal(performance.waferSystemResidenceTime.sampleCount, 2);
  assert.equal(performance.waferSystemResidenceTime.meanSeconds, 31.5);
  assert.ok(Math.abs(performance.waferSystemResidenceTime.coefficientOfVariation - (1 / 9)) < 1e-9);
  assert.deepEqual(performance.waferSystemResidenceTimes, [
    { wafer: "W1", enteredAt: 2, completedAt: 30, duration: 28 },
    { wafer: "W2", enteredAt: 10, completedAt: 45, duration: 35 },
    { wafer: "W3", enteredAt: 40, completedAt: 60, duration: 20 },
    { wafer: "W4", enteredAt: 50, completedAt: 75, duration: 25 },
  ]);
  assert.equal(logic.analyzeSchedulePerformance(performanceMoves, device, "full").completedWaferCount, 4);
});

test("双 Actor 回放在 Pick 结束后的原子决策边界暂停", async () => {
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
    const modelSelect = root.elements.get("visualRecommendationModel");
    modelSelect.value = "dual-actor-e2e";
    modelSelect.listeners.get("change")();

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

test("逐片晶圆系统驻留图展示柱、均值线和每片时长", () => {
  const performance = logic.analyzeSchedulePerformance(performanceMoves, device, "steady");
  const chart = logic.renderWaferResidenceChart(performance);
  assert.match(chart, /系统驻留时间分析/);
  assert.match(chart, /平均 27\.0 s/);
  assert.match(chart, /极差\/最小值 <b>75\.0%<\/b>/);
  assert.match(chart, /晶圆 W1，系统驻留 28\.0 秒/);
  assert.match(chart, /晶圆 W2，系统驻留 35\.0 秒/);
  assert.equal((chart.match(/class="residence-bar-item"/g) ?? []).length, 4);
});

test("旧分析响应缺少逐片字段时从当前 MoveList 补齐驻留图", () => {
  const current = logic.analyzeSchedulePerformance(performanceMoves, device, "steady");
  const legacy = { ...current };
  delete legacy.waferSystemResidenceTimes;

  const hydrated = logic.withWaferResidenceTimes(legacy, performanceMoves, device);
  assert.deepEqual(hydrated.waferSystemResidenceTimes, [
    { wafer: "W1", enteredAt: 2, completedAt: 30, duration: 28 },
    { wafer: "W2", enteredAt: 10, completedAt: 45, duration: 35 },
    { wafer: "W3", enteredAt: 40, completedAt: 60, duration: 20 },
    { wafer: "W4", enteredAt: 50, completedAt: 75, duration: 25 },
  ]);
  assert.doesNotMatch(logic.renderWaferResidenceChart(hydrated), /没有完成往返 LoadPort/);
});

test("性能分析统计加工腔、机器手非运输驻留和晶圆系统停留", () => {
  const residenceMoves = [
    {
      MoveID: 1, MoveType: 0, ModuleName: "VTR", SrcStationList: ["LP1"],
      MatIDList: ["W1"], StartTime: 0, EndTime: 1,
    },
    {
      MoveID: 2, MoveType: 1, ModuleName: "VTR", DestStationList: ["PM1"],
      MatIDList: ["W1"], StartTime: 2, EndTime: 3,
    },
    {
      MoveID: 3, MoveType: 9, ModuleName: "PM1", MatIDList: ["W1"],
      StartTime: 3, EndTime: 10,
    },
    {
      MoveID: 4, MoveType: 6, ModuleName: "PM1", MatIDList: ["W1"],
      StartTime: 10, EndTime: 11,
    },
    {
      MoveID: 5, MoveType: 0, ModuleName: "VTR", SrcStationList: ["PM1"],
      MatIDList: ["W1"], StartTime: 12, EndTime: 14,
    },
    {
      MoveID: 6, MoveType: 5, ModuleName: "VTR",
      StartTime: 14, EndTime: 16,
    },
    {
      MoveID: 7, MoveType: 1, ModuleName: "VTR", DestStationList: ["LP1"],
      MatIDList: ["W1"], StartTime: 19, EndTime: 20,
    },
  ];

  const performance = logic.analyzeSchedulePerformance(residenceMoves, device, "full");

  assert.deepEqual(performance.processChamberDwellTime, {
    totalSeconds: 4,
    meanSeconds: 4,
    medianSeconds: 4,
    maxSeconds: 4,
    coefficientOfVariation: 0,
    sampleCount: 1,
  });
  assert.equal(performance.robotWaferDwellTime.sampleCount, 2);
  assert.equal(performance.robotWaferDwellTime.totalSeconds, 4);
  assert.equal(performance.robotWaferDwellTime.maxSeconds, 3);
  assert.equal(performance.waferSystemResidenceTime.meanSeconds, 19);
  assert.equal(performance.waferSystemResidenceTime.sampleCount, 1);
});

test("模块物理占用包含开门、取放和加工，界面隐藏未使用并行腔", () => {
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
  assert.deepEqual(logic.summarizeBottleneckUtilization(performance), {
    resourceName: "工序容量组 · PM1",
    utilization: 0.5,
    windowLabel: "稳态交叠窗",
    confidence: "medium",
    candidateCount: 1,
    score: 0.53,
  });
  assert.equal(
    logic.displayedPerformanceResources(performance).some(resource => resource.name === "PM2"),
    false,
  );
});

test("并行工艺腔按完整工序容量组识别，即使其中一台没有被使用", () => {
  const parallelDevice = {
    Stations: {
      PM1: { Type: "ProcessChamber" },
      PM2: { Type: "ProcessChamber" },
    },
    Robots: {},
  };
  const performance = logic.analyzeSchedulePerformance([
    {
      MoveID: 1,
      MoveType: 9,
      ModuleName: "PM1",
      PJobName: ["1.C1.P1"],
      StepID: 2,
      StartTime: 0,
      EndTime: 100,
    },
  ], parallelDevice, "full", {
    processStages: [{
      id: "p1-step-2",
      label: "P1 · 工序 1",
      pjobName: "1.C1.P1",
      stepId: 2,
      resourceNames: ["PM1", "PM2"],
    }],
  });

  assert.equal(performance.primaryBottleneck.label, "工序容量组 · PM1 / PM2");
  assert.deepEqual(performance.primaryBottleneck.resourceNames, ["PM1", "PM2"]);
  assert.equal(performance.primaryBottleneck.utilization, 0.5);
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

test("路径配置可独立提取并行工序容量组", () => {
  const context = analysisLogic.buildScheduleAnalysisContext([
    {
      name: "RouteA",
      stages: [
        { stepId: 0, needProcess: false, visits: [{ stationName: "LP1" }] },
        {
          stepId: 2,
          needProcess: true,
          visits: [{ stationName: "PM1" }, { stationName: "PM2" }],
        },
      ],
    },
  ], [{
    cjobs: [{ key: "C1", pjobs: [{ jobName: "P1", routeRef: "RouteA" }] }],
  }]);

  assert.deepEqual(context.processStages, [{
    id: "1.C1.P1:step-2",
    label: "P1 · 工序 1",
    pjobName: "1.C1.P1",
    stepId: 2,
    resourceNames: ["PM1", "PM2"],
  }]);
});

test("高占用 VTR 不再被低占用长加工腔误判覆盖", () => {
  const transportDevice = {
    Stations: { PM1: { Type: "ProcessChamber" } },
    Robots: { VTR: {} },
  };
  const performance = logic.analyzeSchedulePerformance([
    { MoveID: 1, MoveType: 9, ModuleName: "PM1", StartTime: 0, EndTime: 30 },
    { MoveID: 2, MoveType: 5, ModuleName: "VTR", StartTime: 0, EndTime: 80 },
  ], transportDevice, "full");

  assert.equal(performance.primaryBottleneck.kind, "robot");
  assert.equal(performance.primaryBottleneck.label, "VTR");
  assert.equal(performance.primaryBottleneck.utilization, 1);
});

test("LoadLock 高容量占用可成为首位候选", () => {
  const loadLockDevice = {
    Stations: {
      LA: { Type: "LoadLock" },
      PM1: { Type: "ProcessChamber" },
    },
    Robots: { VTR: {} },
  };
  const performance = logic.analyzeSchedulePerformance([
    { MoveID: 1, MoveType: 10, ModuleName: "LA", StartTime: 0, EndTime: 80 },
    { MoveID: 2, MoveType: 9, ModuleName: "PM1", StartTime: 0, EndTime: 20 },
    { MoveID: 3, MoveType: 5, ModuleName: "VTR", StartTime: 0, EndTime: 10 },
  ], loadLockDevice, "full");

  assert.equal(performance.primaryBottleneck.kind, "loadlock-group");
  assert.equal(performance.primaryBottleneck.label, "LoadLock 容量组 · LA");
});

test("得分接近时保留多个瓶颈候选并按可能性排序", () => {
  const mixedDevice = {
    Stations: { PM1: { Type: "ProcessChamber" } },
    Robots: { VTR: {} },
  };
  const performance = logic.analyzeSchedulePerformance([
    { MoveID: 1, MoveType: 9, ModuleName: "PM1", StartTime: 0, EndTime: 75 },
    { MoveID: 2, MoveType: 5, ModuleName: "VTR", StartTime: 0, EndTime: 80 },
    { MoveID: 3, MoveType: 5, ModuleName: "OTHER", StartTime: 80, EndTime: 100 },
  ], mixedDevice, "full");

  assert.equal(performance.bottleneckCandidates.length, 2);
  assert.equal(performance.bottleneckCandidates[0].label, "VTR");
  assert.equal(performance.bottleneckCandidates[1].label, "工序容量组 · PM1");
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

test("性能分析按顺序配对 LoadLock 抽气和充气携片", () => {
  const performance = logic.analyzeSchedulePerformance([
    { MoveID: 1, MoveType: 10, ModuleName: "LA", LastState: "ATM", CurState: "VAC", MatIDList: ["W1"], StartTime: 1, EndTime: 5 },
    { MoveID: 2, MoveType: 10, ModuleName: "LA", LastState: "VAC", CurState: "ATM", MatIDList: ["W4"], StartTime: 10, EndTime: 14 },
    { MoveID: 3, MoveType: 10, ModuleName: "LA", LastState: "ATM", CurState: "VAC", MatIDList: ["W2", "W3"], StartTime: 20, EndTime: 24 },
    { MoveID: 4, MoveType: 10, ModuleName: "LA", LastState: "VAC", CurState: "ATM", MatIDList: [], StartTime: 30, EndTime: 34 },
  ], device, "full");

  assert.deepEqual(performance.loadLockCycles, [
    { index: 1, loadLock: "LA", vacuumWafers: ["W1"], ventWafers: ["W4"], startTime: 1, pumpEndTime: 5, ventStartTime: 10, ventEndTime: 14 },
    { index: 2, loadLock: "LA", vacuumWafers: ["W2", "W3"], ventWafers: [], startTime: 20, pumpEndTime: 24, ventStartTime: 30, ventEndTime: 34 },
  ]);
});

test("独立抽气和充气 MoveType 也能组成 LoadLock 循环", () => {
  const performance = logic.analyzeSchedulePerformance([
    { MoveID: 1, MoveType: 12, ModuleName: "LA", MatIDList: ["W5"], StartTime: 1, EndTime: 5 },
    { MoveID: 2, MoveType: 13, ModuleName: "LA", MatIDList: ["W6"], StartTime: 10, EndTime: 14 },
  ], device, "full");

  assert.deepEqual(performance.loadLockCycles, [
    { index: 1, loadLock: "LA", vacuumWafers: ["W5"], ventWafers: ["W6"], startTime: 1, pumpEndTime: 5, ventStartTime: 10, ventEndTime: 14 },
  ]);
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
