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
  const toolbarStart = html.indexOf('<section class="timeline-console petri-top-playback-controls"');
  const toolbarEnd = html.indexOf("</section>", toolbarStart);
  const toolbar = html.slice(toolbarStart, toolbarEnd);
  assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart);
  assert.match(toolbar, /id="visualPlayButton"/);
  assert.match(toolbar, /id="visualSource"/);
  assert.match(toolbar, /id="visualTimeline"/);
  assert.match(toolbar, /id="visualImportButton"[^>]*>[\s\S]*导入 MoveList/);
  assert.match(toolbar, /id="visualOpenGantt"[^>]*>打开甘特图</);
  assert.doesNotMatch(html, /petri-utils/);
  assert.match(html, /id="visualPauseOnDecisionChangeButton"/);
  assert.doesNotMatch(html, /id="visualTransitionButtons"|MODEL EVALUATION/);
});

test("E2E 面板保持扁平统一列表与标准开关视觉契约", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/config_editor.html"),
    "utf8",
  );
  const css = fs.readFileSync(
    path.join(__dirname, "../realtime_scheduler/frontend/assets/config_editor.css"),
    "utf8",
  );

  assert.match(html, /<h2 class="petri-panel-title">实时 E2E 评估<\/h2>/);
  assert.match(html, /id="visualPauseOnDecisionChangeButton"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(css, /\.decision-lens-panel[^\n]*border-radius: 6px[^\n]*box-shadow: none/);
  assert.match(css, /\.decision-auto-pause[^\n]*min-height: 44px/);
  assert.match(css, /\.decision-tag\.is-recommendation/);
  assert.match(css, /body\.theme-dark \.decision-tag\.is-recommendation/);
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

test("E2E 面板统一候选结构、按偏好排序并格式化低偏好和工期差值", async () => {
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
  assert.match(lens, /决策 #65[\s\S]*3 个可行动作/);
  assert.ok(lens.indexOf("LP1 → ATR") < lens.indexOf("VTR → PM1"), "动作应按 E2E 偏好降序排列");
  assert.match(lens, /LP1 → ATR[\s\S]*E2E推荐[\s\S]*与计划一致[\s\S]*99\.6%|LP1 → ATR[\s\S]*E2E推荐[\s\S]*与计划一致[\s\S]*100%/);
  assert.match(lens, /VTR → PM1[\s\S]*VTR · internal[\s\S]*剩余工期 <strong>19\.5s<\/strong>[\s\S]*Δ \+10\.3s[\s\S]*<1%/);
  assert.match(lens, /Δ 基准/);
  assert.match(lens, /Δ 为相对 E2E 推荐动作的预测工期差值。/);
  assert.equal((lens.match(/class="decision-candidate"/g) || []).length, 3);
  assert.doesNotMatch(lens, /剩余 Makespan|预测区间|lowerRemainingMakespan|upperRemainingMakespan/);
});

test("开启保护后，决策空间变化会暂停回放并显示触发状态", async () => {
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
              time: 1,
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

    scheduledFrame(performance.now() + 300);
    assert.match(root.elements.get("visualPlayButton").innerHTML, /播放/);
    assert.match(autoPause.innerHTML, /已暂停/);
    assert.equal(autoPause.getAttribute("aria-checked"), "true");
    assert.equal(autoPause.getAttribute("aria-label"), "决策空间已变化，回放已暂停");
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
    const isLoadPort = /class="equipment-card equipment-port\b/.test(match[4]);
    positions.push({
      x: Number(match[2]) / 100 * 1000,
      y: Number(match[3]),
      width: isRobot ? 132 : isLoadLock ? 120 : isLoadPort ? 144 : isProcess ? 112 : 96,
      height: isRobot ? 132 : isLoadLock ? 72 : isLoadPort ? 104 : isProcess ? 122 : 96,
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

test("单真空机械手拓扑只显示 MoveList 使用的 LP，并完整显示腔室且不重叠", () => {
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
  const required = ["LP1", "LA", "LB", "PM1", "PM2", "PM3", "PM4", "PM5", "PM6"];
  const snapshot = logic.buildWorkspaceSnapshot(moves, fullDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, fullDevice),
    null,
  );
  assertTopologyComplete(topology, required);
  assert.doesNotMatch(topology, />LP[2-4]</);
  assert.doesNotMatch(topology, />Buffer[1-4]</);
  assert.doesNotMatch(topology, />DummyPort</);
  assert.doesNotMatch(topology, />heater</i);
  assert.doesNotMatch(topology, /DEVICE TOPOLOGY|设备配置全量模块/);
  assert.match(topology, /--module-left:26%;/);
  assert.match(topology, /--topology-canvas-height:826px/);
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
  assert.deepEqual([la.x, lc.x], [40, 60], "第一行应为 LA / LC，并在中等画布保持清晰间距");
  assert.deepEqual([lb.x, ld.x], [40, 60], "第二行应为 LB / LD，并在中等画布保持清晰间距");
  assert.equal(la.y, lc.y);
  assert.equal(lb.y, ld.y);
  assert.equal(lb.y - la.y, 76, "上下两排 LoadLock 应保留 4px 腔体间隙");
  assert.match(topology, /class="loadlock-layers"/);
  assert.equal((topology.match(/class="loadlock-layer /g) || []).length, 8, "四个 LoadLock 各显示两层");
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
  const required = ["LP1", "LA", "LB", "PM1", "PM2", "PM3", "PM4", "PM5", "PM6"];
  const snapshot = logic.buildWorkspaceSnapshot(moves, fullDevice, 0);
  const topology = logic.renderEquipmentTopology(
    logic.snapshotWithFullDeviceModules(snapshot, fullDevice),
    null,
  );
  assertTopologyComplete(topology, required);
  assert.doesNotMatch(topology, />LP[2-4]</);
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
  assert.match(topology, /class="robot-fork-tine robot-fork-tine-top"/);
  assert.match(topology, /class="robot-fork-tine robot-fork-tine-bottom"/);
  assert.doesNotMatch(topology, /robot-reach-sector/);
  assert.match(topology, /class="robot-environment-badge">ATM</);
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
  assert.match(css, /\.equipment-process[^}]*border-radius:\s*3px;\s*clip-path:\s*none;/);
  assert.match(css, /\.equipment-port[^}]*border:\s*2px solid #667b94;\s*border-radius:\s*3px;\s*clip-path:\s*none;/);
  assert.match(css, /\.robot-arm[^}]*width:\s*88px;/);
  assert.match(css, /\.robot-fork-tine[^}]*width:\s*22px;/);
  assert.match(css, /\.robot-end-effector::before[^}]*left:\s*-3px;[^}]*height:\s*18px;/);
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

test("ATR 与 VTR 机械臂按各自 LoadLock 入口旋转，不再叠加方向箭头", () => {
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
  assert.ok(robotAngle("VTR") > 0, "VTR 应向下方的上排 LoadLock 入口旋转");
  assert.doesNotMatch(topology, /topology-target-arrows/);
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
  assert.equal(performance.waferSystemResidenceTime.sampleCount, 2);
  assert.equal(performance.waferSystemResidenceTime.meanSeconds, 31.5);
  assert.ok(Math.abs(performance.waferSystemResidenceTime.coefficientOfVariation - (1 / 9)) < 1e-9);
  assert.equal(logic.analyzeSchedulePerformance(performanceMoves, device, "full").completedWaferCount, 4);
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
