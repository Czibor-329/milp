/** 机械臂配置、真实槽位选择与 Swap 分阶段交接的前端回归测试。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require(
  process.env.CT_WORKSPACE_VISUALIZER_TEST_BUILD
    || '../realtime_scheduler/frontend/workspace_visualizer_logic.js',
);
const fs = require('node:fs');
const path = require('node:path');
/** 从唯一设备目录读取真实机械臂声明，避免夹具掩盖臂数、槽位数差异。 */
function storedDevices() {
  const root = path.join(__dirname, '../realtime_scheduler/data/datasets');
  return fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'device.json')))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name, 'device.json'), 'utf8').replace(/^\uFEFF/, '')));
}

test('真实三类设备的机械手侧栏保留每个槽号，单臂留空列，双腔共享组合框', () => {
  for (const definition of storedDevices()) {
    const snapshot = logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([], definition, 0), definition);
    const layout = logic.detectDeviceTopologyLayout(definition);
    const html = logic.renderFrontSlotOverview(snapshot.modules, {}, snapshot.robots, layout, definition);
    for (const robot of snapshot.robots) {
      assert.ok(html.includes(`data-robot="${robot.name}"`));
      for (const slot of robot.arms.flatMap(arm => arm.slots)) assert.ok(html.includes(`${robot.name}.${slot} · 空槽`));
      const arms = logic.robotArmAnimation(robot.arms, {}, undefined, 0).arms;
      if (robot.environment === 'atmosphere') {
        const picture = logic.renderParallelRobotArms(arms, 100, String, String, undefined, [], robot.name, 'telescopic');
        assert.equal((picture.match(/class="parallel-robot-claw"/g) || []).length, 1);
      }
    }
    assert.equal(html.includes('front-robot-combined-board'), layout === 'dual');
    if (layout === 'cascade') {
      const order = ['data-robot="VTR_2"', 'title="UBR"', 'data-robot="VTR_1"', 'title="LA"', 'data-robot="ATR_1"'];
      assert.ok(order.every((item, index) => index === 0 || html.indexOf(order[index - 1]) < html.indexOf(item)));
    }
  }
});

test('双腔两臂待命只露两个爪，伸出时另一臂变浅，底层持片不会消失', () => {
  const arms = logic.configuredRobotArms({ ArmInfo: { A: { SlotIDs: [1, 2] }, B: { SlotIDs: [3, 4] } } });
  const render = state => logic.renderParallelRobotArms(state.arms, 160, String, String, undefined, [], 'VAC', 'articulated', true);
  const idle = render(logic.robotArmAnimation(arms, { 3: 'BOTTOM' }, undefined, 0));
  assert.match(idle, /visibility:hidden/);
  assert.match(idle, /BOTTOM/);
  const active = render(logic.robotArmAnimation(arms, {}, { MoveType: 0, RobotSlotList: [3, 4], MatIDList: ['A', 'B'],
    SrcStationList: ['PM1', 'PM1'], SrcSlotList: [1, 2], StartTime: 0, EndTime: 10 }, 4));
  assert.doesNotMatch(active, /visibility:hidden/);
  assert.match(active, /opacity:\.3/);
});

test('双腔每层双槽复用单腔镜像关节轮廓，而非单根横杆', () => {
  const render = (slots, stacked) => logic.renderParallelRobotArms(logic.robotArmAnimation(
    logic.configuredRobotArms({ ArmInfo: slots }), {}, undefined, 0).arms, 100, String, String,
    undefined, [], 'shape', 'articulated', stacked);
  const single = render({ A: { SlotIDs: [1] }, B: { SlotIDs: [2] } }, false);
  const dual = render({ A: { SlotIDs: [1, 2] } }, true);
  const paths = html => [...html.matchAll(/class="parallel-robot-link" d="([^"]+)"/g)].map(match => match[1]).join(' ');
  assert.equal(paths(dual), paths(single));
  assert.equal((dual.match(/class="parallel-robot-joint"/g) || []).length, 2);
});

test('双腔双片访问外侧 LC/LD 的动画使用 LA/LB 入口，并保留原始站点', () => {
  const definition = storedDevices().find(item => logic.detectDeviceTopologyLayout(item) === 'dual');
  const render = stations => {
    const move = { MoveID: 1, MoveType: 0, ModuleName: 'VACRobot', RobotSlotList: [1, 2], MatIDList: ['A', 'B'],
      SrcStationList: stations, SrcSlotList: [1, 1], StartTime: 0, EndTime: 10 };
    const snapshot = logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([move], definition, 4), definition);
    const html = logic.renderEquipmentTopology(snapshot, null, undefined, definition);
    assert.deepEqual(snapshot.activeMoves[0].SrcStationList, stations);
    assert.match(html, /topology-atmosphere-rail/);
    return [...html.matchAll(/class="parallel-robot-claw"[^>]*transform="([^"]+)"/g)].map(match => match[1]);
  };
  assert.deepEqual(render(['LC', 'LD']), render(['LA', 'LB']));
});

test('双腔动画交接和完成后，二号腔晶圆不因一号腔取空而换位', () => {
  const definition = storedDevices().find(item => logic.detectDeviceTopologyLayout(item) === 'dual');
  const move = { MoveID: 1, MoveType: 0, ModuleName: 'VACRobot', RobotSlotList: [1], MatIDList: ['FIRST'],
    SrcStationList: ['PM1'], SrcSlotList: [1], StartTime: 0, EndTime: 10 };
  const later = { ...move, MoveID: 2, RobotSlotList: [2], MatIDList: ['SECOND'], SrcSlotList: [2], StartTime: 20, EndTime: 30 };
  for (const time of [6, 10]) {
    const snapshot = logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([move, later], definition, time), definition);
    const projection = logic.projectTopologyTransfers(snapshot, definition);
    const slots = projection.modules.find(module => module.name === 'PM1').processSlots;
    assert.equal(slots.find(slot => slot.slot === 1).wafer, '');
    assert.equal(slots.find(slot => slot.slot === 2).wafer, 'SECOND');
    const html = logic.renderEquipmentTopology(snapshot, null, undefined, definition);
    assert.match(html, /atmosphere-aligner@left/);
    assert.match(html, /atmosphere-cooler@right/);
    assert.match(html, /parallel-robot-mechanism/);
  }
});
const device = {
  Stations: { LP1: { Type: 'LoadPort', Capacity: 1, Slots: [1] }, PM1: { Type: 'Process' } },
  Robots: {
    ATR: { Capacity: 1, ArmInfo: { Atmospheric: { IsEnable: true, SlotIDs: [3] } } },
    VTR: { Capacity: 2, ArmInfo: { Receive: { IsEnable: true, SlotIDs: [7] }, Send: { IsEnable: true, SlotIDs: [2] } } },
  },
};
const swap = { MoveID: 1, MoveType: 4, ModuleName: 'VTR', StationList: ['PM1'],
  RecvSlotList: [7], SendSlotList: [2], RecvMatList: ['OLD'], SendMatList: ['NEW'],
  StnSendSlotList: [1], StnRecvSlotList: [1], StartTime: 0, EndTime: 12, SwapMode: 0 };
/** 从相同原始输入生成任意时间的快照与纯展示投影，验证反向拖动不会继承上帧。 */
function scene(time, move = swap) {
  const snapshot = logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([move], device, time), device);
  return { snapshot, ...logic.projectTopologyTransfers(snapshot, device) };
}

test('配置决定臂数与每臂爪数，禁用臂保留外观但不执行', () => {
  assert.deepEqual(logic.configuredRobotArms(device.Robots.ATR).map(arm => arm.slots), [[3]]);
  assert.deepEqual(logic.configuredRobotArms(device.Robots.VTR).map(arm => arm.slots), [[7], [2]]);
  const arms = logic.configuredRobotArms({ Capacity: 3, ArmInfo: {
    One: { SlotIDs: [4, 9] }, Disabled: { IsEnable: false, SlotIDs: [1] },
  } });
  const state = logic.robotArmAnimation(arms, {}, { MoveType: 0, RobotSlotList: [1], MatIDList: ['W'], SrcStationList: ['PM1'], StartTime: 0, EndTime: 10 }, 5);
  assert.ok(state.arms.every(arm => arm.progress === null));
  const markup = logic.renderParallelRobotArms(state.arms, 120, String, String);
  assert.equal((markup.match(/class="parallel-robot-joint"/g) || []).length, 2);
  assert.equal((markup.match(/class="parallel-robot-claw"/g) || []).length, 3);
});

test('Pick 和 Place 只驱动 RobotSlotList 指定的臂，站点槽位不会误选臂', () => {
  for (const type of [0, 1, 2, 3]) {
    const move = { MoveType: type, RobotSlotList: [2], MatIDList: ['NEW'], SrcStationList: ['PM1'],
      DestStationList: ['PM1'], SrcSlotList: [7], DestSlotList: [7], StartTime: 0, EndTime: 10 };
    const state = logic.robotArmAnimation(logic.configuredRobotArms(device.Robots.VTR), { 7: 'OTHER', 2: 'NEW' }, move, 6);
    assert.equal(state.arms[0].progress, null);
    assert.equal(state.arms[0].wafers[7], 'OTHER');
    assert.equal(state.arms[1].progress, 0.6);
    assert.equal(state.arms[1].wafers[2], type % 2 === 0 ? 'NEW' : '');
  }
});

test('Swap 先接收臂取片收回，再发送臂放片；每次交接画布只有一份晶圆', () => {
  const early = scene(2);
  assert.ok(early.animations.get('VTR')[0].progress > 0);
  assert.equal(early.animations.get('VTR')[1].progress, null);
  assert.deepEqual(early.modules.find(module => module.name === 'PM1').wafers, ['OLD']);
  const received = scene(4);
  assert.equal(received.animations.get('VTR')[0].wafers[7], 'OLD');
  assert.equal(received.animations.get('VTR')[1].wafers[2], 'NEW');
  assert.deepEqual(received.modules.find(module => module.name === 'PM1').wafers, []);
  const second = scene(8);
  assert.equal(second.animations.get('VTR')[0].progress, null);
  assert.ok(second.animations.get('VTR')[1].progress > 0);
  const placed = scene(10);
  assert.equal(placed.animations.get('VTR')[0].wafers[7], 'OLD');
  assert.equal(placed.animations.get('VTR')[1].wafers[2], '');
  assert.deepEqual(placed.modules.find(module => module.name === 'PM1').wafers, ['NEW']);
  assert.deepEqual(placed.snapshot.modules.find(module => module.name === 'PM1').wafers, ['OLD']);
  assert.deepEqual(scene(2).animations, early.animations);
  assert.deepEqual(scene(12).snapshot.robots.find(robot => robot.name === 'VTR').slotWafers, { 7: 'OLD' });
});

test('SwapMode 1 按先放后取执行，同槽复用在第二阶段正确接收旧片', () => {
  const move = { ...swap, SwapMode: 1, RecvSlotList: [2], StnRecvSlotList: [2] };
  const placed = scene(4, move).animations.get('VTR');
  assert.equal(placed[1].wafers[2], '');
  const received = scene(10, move).animations.get('VTR');
  assert.equal(received[1].wafers[2], 'OLD');
  assert.equal(received[0].progress, null);
});

test('完成取片后按真实槽位保持占位，不受晶圆名称或臂顺序影响', () => {
  const moves = [
    { MoveType: 0, ModuleName: 'VTR', RobotSlotList: [7], MatIDList: ['Z'], EndTime: 2 },
    { MoveType: 0, ModuleName: 'VTR', RobotSlotList: [2], MatIDList: ['A'], EndTime: 4 },
  ];
  assert.deepEqual(logic.robotSlotWafers(moves, 4, 'VTR', ['A', 'Z']), { 7: 'Z', 2: 'A' });
});

test('单腔与级联实际渲染 ATR 一臂一爪、VTR 两臂两爪，Swap 仅一臂伸出', () => {
  for (const cascade of [false, true]) {
    const configured = structuredClone(device);
    if (cascade) configured.Robots.VTR_2 = structuredClone(device.Robots.VTR);
    const snapshot = logic.snapshotWithFullDeviceModules(logic.buildWorkspaceSnapshot([swap], configured, 4), configured);
    const html = logic.renderEquipmentTopology(snapshot, null, undefined, configured);
    assert.equal((html.match(/class="parallel-robot-claw"/g) || []).length, cascade ? 5 : 3);
    assert.equal((html.match(/class="parallel-robot-joint"/g) || []).length, cascade ? 4 : 2);
    assert.equal((html.match(/class="parallel-robot-slide"/g) || []).length, 1);
    assert.equal((html.match(/class="parallel-robot-arm is-transferring"/g) || []).length, 1);
    assert.match(html, /data-held-slot="7"/);
    assert.match(html, /data-held-slot="2"/);
  }
});

test('VTR 待命双臂镜像对称且每个肘关节内角九十度', () => {
  const upper = logic.robotArmGeometry(58, 0, 2, null);
  const lower = logic.robotArmGeometry(58, 1, 2, null);
  assert.equal(upper.elbowX, lower.elbowX);
  assert.equal(upper.elbowY, -lower.elbowY);
  assert.equal(upper.tipY, -lower.tipY);
  for (const arm of [upper, lower]) {
    const dot = -arm.elbowX * (58 - arm.elbowX) + (arm.shoulder - arm.elbowY) * (arm.tipY - arm.elbowY);
    assert.ok(Math.abs(dot) < 1e-9);
  }
});

test('ATR 无 PreTrans 时先对齐后伸臂，完成后停在目标，倒放可恢复', () => {
  const pick = { MoveID: 1, ModuleName: 'ATR', MoveType: 0, SrcStationList: ['LP1'],
    SrcSlotList: [1], RobotSlotList: [3], MatIDList: ['W'], StartTime: 0, EndTime: 12 };
  const moving = logic.atmosphereRailMotion([pick], 'ATR', 1);
  assert.equal(moving.source, '');
  assert.equal(moving.target, 'LP1');
  assert.ok(moving.progress > 0 && moving.progress < 1);
  const snapshot = logic.buildWorkspaceSnapshot([pick], device, 1);
  const projection = logic.projectTopologyTransfers(snapshot, device);
  assert.equal(projection.animations.get('ATR')[0].progress, null);
  assert.deepEqual(logic.atmosphereRailMotion([pick], 'ATR', 12), { source: 'LP1', target: 'LP1', progress: 1, preparationFraction: 0 });
  const aligned = logic.buildWorkspaceSnapshot([pick], device, 6);
  assert.equal(aligned.robots.find(robot => robot.name === 'ATR').railMotion.progress, 1);
  assert.ok(logic.projectTopologyTransfers(aligned, device).animations.get('ATR')[0].progress > 0);
  assert.deepEqual(logic.atmosphereRailMotion([pick], 'ATR', 1), moving);
});

test('ATR 有 PreTrans 时在转位期间移动，后续取放不会再次占用对齐阶段', () => {
  const moves = [
    { ModuleName: 'ATR', MoveType: 5, SrcStationList: ['LP1'], DestStationList: ['PM1'], StartTime: 0, EndTime: 4 },
    { ModuleName: 'ATR', MoveType: 1, DestStationList: ['PM1'], RobotSlotList: [3], MatIDList: ['W'], StartTime: 4, EndTime: 8 },
  ];
  assert.equal(logic.atmosphereRailMotion(moves, 'ATR', 2).progress, 0.5);
  assert.equal(logic.atmosphereRailMotion(moves, 'ATR', 5).preparationFraction, 0);
});
