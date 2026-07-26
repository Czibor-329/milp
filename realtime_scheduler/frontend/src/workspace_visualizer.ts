/**
 * MoveList 可视化工作台。
 *
 * 本模块负责把调度输出回放成设备、机器人、晶圆和腔室门的可观察状态，并管理
 * 时间轴、播放控制、结果加载和本地文件导入。纯回放函数可在浏览器之外独立测试；
 * DOM 控制器只负责把快照呈现到配置终端的“可视化工作台”页。
 */

type UnknownRecord = Record<string, unknown>;

export interface MoveRecord extends UnknownRecord {
  MoveID?: number;
  MoveType?: number;
  ModuleName?: string;
  StartTime?: number;
  EndTime?: number;
}

export interface DeviceDefinition {
  Stations?: Record<string, UnknownRecord>;
  Robots?: Record<string, UnknownRecord>;
}

export type DoorStatus = "closed" | "opening" | "open" | "closing" | "doorless";
export type ModuleStatus = "idle" | "occupied" | "door" | "transfer" | "processing" | "cleaning" | "environment";

export interface ModuleSnapshot {
  name: string;
  type: string;
  status: ModuleStatus;
  door: DoorStatus;
  wafers: string[];
  activeMoveName: string;
  progress: number;
  environment: string;
  isRobotTarget: boolean;
}

export interface RobotSnapshot {
  name: string;
  wafers: string[];
  busy: boolean;
  target: string;
  activeMoveName: string;
}

export interface WorkspaceSnapshot {
  time: number;
  endTime: number;
  completedMoves: number;
  totalMoves: number;
  activeMoves: MoveRecord[];
  modules: ModuleSnapshot[];
  robots: RobotSnapshot[];
  waferCount: number;
}

interface NormalizedMove extends MoveRecord {
  MoveID: number;
  MoveType: number;
  ModuleName: string;
  StartTime: number;
  EndTime: number;
}

interface WorkspaceElements {
  empty: HTMLElement;
  content: HTMLElement;
  stage: HTMLElement;
  activeMoves: HTMLElement;
  source: HTMLElement;
  currentTime: HTMLElement;
  totalTime: HTMLElement;
  progressText: HTMLElement;
  moveText: HTMLElement;
  waferText: HTMLElement;
  range: HTMLInputElement;
  playButton: HTMLButtonElement;
  speed: HTMLSelectElement;
  fileInput: HTMLInputElement;
  openGantt: HTMLAnchorElement;
  resultButton: HTMLButtonElement;
}

const PICK_MOVE_TYPES = new Set([0, 2]);
const PLACE_MOVE_TYPES = new Set([1, 3]);
const SWAP_MOVE = 4;
const PREPARE_MOVE = 6;
const COMPLETE_MOVE = 7;
const PROCESS_MOVE = 9;
const PRE_PREPARE_MOVE = 10;
const CLEAN_MOVE = 14;
const PLAYBACK_FRAME_INTERVAL_MS = 80;
const DEFAULT_PLAYBACK_SPEED = 4;
const PROCESS_ARC_START_DEGREES = 200;
const PROCESS_ARC_END_DEGREES = 340;
const PROCESS_ARC_CENTER_X_PERCENT = 50;
const PROCESS_ARC_CENTER_Y_PIXELS = 214;
const PROCESS_ARC_RADIUS_X_PERCENT = 38;
const PROCESS_ARC_RADIUS_Y_PIXELS = 156;

const MOVE_NAMES: Record<number, string> = {
  0: "取片", 1: "放片", 2: "多片取片", 3: "多片放片", 4: "换片",
  5: "机械手转位", 6: "开门", 7: "关门", 8: "后置完成", 9: "加工",
  10: "环境切换", 11: "对准", 12: "抽真空", 13: "充气", 14: "清洁",
};

const STATUS_LABELS: Record<ModuleStatus, string> = {
  idle: "空闲",
  occupied: "已载片",
  door: "门动作",
  transfer: "传输中",
  processing: "加工中",
  cleaning: "清洁中",
  environment: "环境切换",
};

const DOOR_LABELS: Record<DoorStatus, string> = {
  closed: "门已关闭",
  opening: "正在开门",
  open: "门已打开",
  closing: "正在关门",
  doorless: "无门结构",
};

/** 把未知值规范为有限数字。 */
function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** 把协议中的列表字段规范为数组。 */
function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 返回稳定、适合人眼阅读的自然排序结果。 */
function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/** 转义将进入 innerHTML 的协议字段。 */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 把秒数格式化为固定但不冗余的显示文本。 */
function formatSeconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

/** 返回动作引用的物料 ID。 */
function materialIds(move: MoveRecord, field = "MatIDList"): string[] {
  return listValue(move[field]).map(String).filter(Boolean);
}

/** 返回动作引用的第一个站点。 */
function firstStation(move: MoveRecord, field: string): string {
  return String(listValue(move[field])[0] ?? "");
}

/** 判断名称是否代表机器人。 */
function isRobotName(name: string): boolean {
  return /^(ATR|VTR|TM\d*|ROBOT)/i.test(name);
}

/** 判断名称是否代表参考拓扑中的 Dummy Port，而不是正常装载端口。 */
function isDummyPortName(name: string): boolean {
  return /DUMMY/i.test(name) && /PORT/i.test(name);
}

/** 判断名称是否代表装载端口。 */
function isLoadPortName(name: string, type = ""): boolean {
  return !isDummyPortName(name)
    && (type.toLowerCase() === "loadport" || /^(LP\d*|P\d+|.*PORT)$/i.test(name));
}

/** 判断名称是否代表 LoadLock 或真空缓冲腔。 */
function isLoadLockName(name: string, type = ""): boolean {
  return type.toLowerCase() === "loadlock" || /^LL?[A-Z]$/i.test(name) || /^BUF_/i.test(name);
}

/** 判断硬件是否没有可观察的腔室门。 */
function isDoorlessModule(name: string, type = ""): boolean {
  return /^cool(er)?$/i.test(name) || type.toLowerCase() === "cooler" || isDummyPortName(name);
}

/** 判断模块是否属于围绕 VTR 排列的工艺腔室。 */
function isProcessModule(name: string, type = ""): boolean {
  const normalizedType = type.toLowerCase();
  return /process|chamber/.test(normalizedType) || /^(PM|CH)\w*/i.test(name);
}

/** 从页面加载的 JSON 中提取 MoveList。 */
export function normalizeMovePayload(payload: unknown): MoveRecord[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as UnknownRecord).MoveList)
      ? (payload as UnknownRecord).MoveList as unknown[]
      : null;
  if (!records) throw new Error("文件必须是 MoveList 数组，或包含 MoveList 字段的 JSON 对象");
  return records
    .filter((record): record is UnknownRecord => Boolean(record) && typeof record === "object" && !Array.isArray(record))
    .map(record => ({ ...record }));
}

/** 规范化时间字段并保证回放顺序稳定。 */
function normalizeMoves(moves: MoveRecord[]): NormalizedMove[] {
  return moves.map((move, index) => {
    const startTime = finiteNumber(move.StartTime);
    const endTime = Math.max(startTime, finiteNumber(move.EndTime, startTime));
    return {
      ...move,
      MoveID: finiteNumber(move.MoveID, index + 1),
      MoveType: finiteNumber(move.MoveType, -1),
      ModuleName: String(move.ModuleName ?? ""),
      StartTime: startTime,
      EndTime: endTime,
    };
  }).sort((left, right) => (
    left.StartTime - right.StartTime
    || left.EndTime - right.EndTime
    || left.MoveID - right.MoveID
  ));
}

/** 收集设备定义和 MoveList 中出现过的全部站点。 */
function collectModuleDefinitions(
  moves: NormalizedMove[],
  device: DeviceDefinition | null,
): Map<string, { type: string }> {
  const modules = new Map<string, { type: string }>();
  const stationDefinitions = device?.Stations ?? {};
  for (const move of moves) {
    const candidates = [
      move.ModuleName,
      ...listValue(move.SrcStationList),
      ...listValue(move.DestStationList),
      ...listValue(move.StationList),
    ].map(String).filter(Boolean);
    for (const name of candidates) {
      if (!isRobotName(name) && !modules.has(name)) {
        modules.set(name, { type: String(stationDefinitions[name]?.Type ?? "") });
      }
    }
  }
  return modules;
}

/** 收集设备定义和 MoveList 中出现过的机器人。 */
function collectRobotNames(moves: NormalizedMove[], device: DeviceDefinition | null): string[] {
  const names = new Set(Object.keys(device?.Robots ?? {}));
  for (const move of moves) {
    if (isRobotName(move.ModuleName)) names.add(move.ModuleName);
    const robot = String(move.Robot ?? "");
    if (robot) names.add(robot);
  }
  return [...names].sort(naturalCompare);
}

/** 推断每片晶圆在时间零点的初始位置。 */
function initialMaterialLocations(moves: NormalizedMove[]): Map<string, string> {
  const locations = new Map<string, string>();
  for (const move of moves) {
    if (move.MoveType === SWAP_MOVE) {
      const station = String(listValue(move.StationList)[0] ?? "");
      for (const material of materialIds(move, "RecvMatList")) {
        if (!locations.has(material)) locations.set(material, move.ModuleName);
      }
      for (const material of materialIds(move, "SendMatList")) {
        if (!locations.has(material)) locations.set(material, station);
      }
      continue;
    }
    const source = firstStation(move, "SrcStationList");
    const destination = firstStation(move, "DestStationList");
    const fallback = source
      || (PICK_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : "")
      || (PLACE_MOVE_TYPES.has(move.MoveType) ? move.ModuleName : "")
      || destination
      || move.ModuleName;
    for (const material of materialIds(move)) {
      if (!locations.has(material) && fallback) locations.set(material, fallback);
    }
  }
  return locations;
}

/** 把已经完成的传输动作应用到晶圆位置。 */
function applyCompletedTransfer(move: NormalizedMove, locations: Map<string, string>): void {
  if (PICK_MOVE_TYPES.has(move.MoveType)) {
    for (const material of materialIds(move)) locations.set(material, move.ModuleName);
    return;
  }
  if (PLACE_MOVE_TYPES.has(move.MoveType)) {
    const destination = firstStation(move, "DestStationList");
    if (destination) {
      for (const material of materialIds(move)) locations.set(material, destination);
    }
    return;
  }
  if (move.MoveType === SWAP_MOVE) {
    const station = String(listValue(move.StationList)[0] ?? "");
    for (const material of materialIds(move, "RecvMatList")) locations.set(material, station);
    for (const material of materialIds(move, "SendMatList")) locations.set(material, move.ModuleName);
  }
}

/** 返回动作在给定时刻的线性进度。 */
function moveProgress(move: NormalizedMove, time: number): number {
  const duration = move.EndTime - move.StartTime;
  if (duration <= 0) return time >= move.EndTime ? 1 : 0;
  return Math.max(0, Math.min(1, (time - move.StartTime) / duration));
}

/** 返回动作关联的主要站点，用于高亮机器人目标。 */
function activeTarget(move: NormalizedMove): string {
  return firstStation(move, "DestStationList")
    || firstStation(move, "SrcStationList")
    || String(listValue(move.StationList)[0] ?? "")
    || (!isRobotName(move.ModuleName) ? move.ModuleName : "");
}

/** 根据 MoveList 和设备定义构造某个时刻的完整工作台快照。 */
export function buildWorkspaceSnapshot(
  moves: MoveRecord[],
  device: DeviceDefinition | null,
  requestedTime: number,
): WorkspaceSnapshot {
  const records = normalizeMoves(moves);
  const endTime = records.reduce((maximum, move) => Math.max(maximum, move.EndTime), 0);
  const time = Math.max(0, Math.min(finiteNumber(requestedTime), endTime));
  const definitions = collectModuleDefinitions(records, device);
  const robotNames = collectRobotNames(records, device);
  const locations = initialMaterialLocations(records);
  const doorStates = new Map<string, DoorStatus>();
  const environments = new Map<string, string>();
  const activeMoves: NormalizedMove[] = [];
  let completedMoves = 0;

  for (const [name, definition] of definitions) {
    doorStates.set(name, isDoorlessModule(name, definition.type) ? "doorless" : "closed");
  }

  for (const move of records) {
    const active = move.StartTime <= time && time < move.EndTime;
    const completed = move.EndTime <= time;
    if (active) activeMoves.push(move);
    if (completed) {
      completedMoves += 1;
      applyCompletedTransfer(move, locations);
    }

    if (move.MoveType === PREPARE_MOVE) {
      if (active) doorStates.set(move.ModuleName, "opening");
      else if (completed) doorStates.set(move.ModuleName, "open");
    } else if (move.MoveType === COMPLETE_MOVE) {
      if (active) doorStates.set(move.ModuleName, "closing");
      else if (completed) doorStates.set(move.ModuleName, "closed");
    } else if (move.MoveType === PRE_PREPARE_MOVE && (active || completed)) {
      const currentState = String(move.CurState ?? "");
      const environment = /VTR|VAC/i.test(currentState) ? "真空" : /ATR|ATM/i.test(currentState) ? "大气" : currentState;
      if (environment) environments.set(move.ModuleName, active ? `${environment}切换中` : environment);
    }
  }

  const robotTargets = new Map<string, string>();
  for (const move of activeMoves) {
    if (isRobotName(move.ModuleName)) robotTargets.set(move.ModuleName, activeTarget(move));
  }

  const wafersByLocation = new Map<string, string[]>();
  for (const [material, location] of locations) {
    if (!location) continue;
    const wafers = wafersByLocation.get(location) ?? [];
    wafers.push(material);
    wafersByLocation.set(location, wafers);
  }
  for (const wafers of wafersByLocation.values()) wafers.sort(naturalCompare);

  const modules = [...definitions.entries()].map(([name, definition]): ModuleSnapshot => {
    const moduleMoves = activeMoves.filter(move => (
      move.ModuleName === name
      || firstStation(move, "SrcStationList") === name
      || firstStation(move, "DestStationList") === name
      || listValue(move.StationList).map(String).includes(name)
    ));
    const primaryMove = moduleMoves.find(move => move.MoveType === CLEAN_MOVE)
      ?? moduleMoves.find(move => move.MoveType === PROCESS_MOVE)
      ?? moduleMoves.find(move => move.MoveType === PRE_PREPARE_MOVE)
      ?? moduleMoves.find(move => [PREPARE_MOVE, COMPLETE_MOVE].includes(move.MoveType))
      ?? moduleMoves[0];
    let status: ModuleStatus = (wafersByLocation.get(name)?.length ?? 0) > 0 ? "occupied" : "idle";
    if (primaryMove?.MoveType === CLEAN_MOVE) status = "cleaning";
    else if (primaryMove?.MoveType === PROCESS_MOVE) status = "processing";
    else if (primaryMove?.MoveType === PRE_PREPARE_MOVE) status = "environment";
    else if (primaryMove && [PREPARE_MOVE, COMPLETE_MOVE].includes(primaryMove.MoveType)) status = "door";
    else if (primaryMove) status = "transfer";
    return {
      name,
      type: definition.type,
      status,
      door: doorStates.get(name) ?? "closed",
      wafers: wafersByLocation.get(name) ?? [],
      activeMoveName: primaryMove ? (MOVE_NAMES[primaryMove.MoveType] ?? `动作 ${primaryMove.MoveType}`) : "",
      progress: primaryMove ? moveProgress(primaryMove, time) : 0,
      environment: environments.get(name) ?? "",
      isRobotTarget: [...robotTargets.values()].includes(name),
    };
  }).sort((left, right) => naturalCompare(left.name, right.name));

  const robots = robotNames.map((name): RobotSnapshot => {
    const move = activeMoves.find(record => record.ModuleName === name);
    return {
      name,
      wafers: wafersByLocation.get(name) ?? [],
      busy: Boolean(move),
      target: robotTargets.get(name) ?? "",
      activeMoveName: move ? (MOVE_NAMES[move.MoveType] ?? `动作 ${move.MoveType}`) : "",
    };
  });

  return {
    time,
    endTime,
    completedMoves,
    totalMoves: records.length,
    activeMoves,
    modules,
    robots,
    waferCount: new Set(records.flatMap(move => materialIds(move))).size,
  };
}

/** 返回与当前页面结构绑定的工作台 DOM 节点。 */
function collectElements(root: Document): WorkspaceElements {
  const required = <ElementType extends HTMLElement>(id: string): ElementType => {
    const element = root.getElementById(id);
    if (!element) throw new Error(`可视化工作台缺少页面节点：${id}`);
    return element as ElementType;
  };
  return {
    empty: required("visualEmpty"),
    content: required("visualContent"),
    stage: required("visualDeviceStage"),
    activeMoves: required("visualActiveMoves"),
    source: required("visualSource"),
    currentTime: required("visualCurrentTime"),
    totalTime: required("visualTotalTime"),
    progressText: required("visualProgressText"),
    moveText: required("visualMoveText"),
    waferText: required("visualWaferText"),
    range: required<HTMLInputElement>("visualTimeline"),
    playButton: required<HTMLButtonElement>("visualPlayButton"),
    speed: required<HTMLSelectElement>("visualSpeed"),
    fileInput: required<HTMLInputElement>("visualFileInput"),
    openGantt: required<HTMLAnchorElement>("visualOpenGantt"),
    resultButton: required<HTMLButtonElement>("workspaceResultButton"),
  };
}

/** 生成统一线性 SVG 图标，避免用 Emoji 充当结构图标。 */
function icon(name: "play" | "pause" | "robot" | "upload"): string {
  const paths = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>',
    robot: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 18v3M15 18v3"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v5h14v-5"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

interface TopologyGroups {
  processModules: ModuleSnapshot[];
  loadLocks: ModuleSnapshot[];
  loadPorts: ModuleSnapshot[];
  auxiliaryModules: ModuleSnapshot[];
}

/** 按参考设备图的物理区域划分当前 MoveList 真正使用的模块。 */
function topologyGroups(modules: ModuleSnapshot[]): TopologyGroups {
  const loadLocks = modules.filter(module => isLoadLockName(module.name, module.type));
  const loadPorts = modules.filter(module => isLoadPortName(module.name, module.type));
  const processModules = modules.filter(module => isProcessModule(module.name, module.type));
  const assignedNames = new Set([...loadLocks, ...loadPorts, ...processModules].map(module => module.name));
  return {
    processModules,
    loadLocks,
    loadPorts,
    auxiliaryModules: modules.filter(module => !assignedNames.has(module.name)),
  };
}

/** 绘制拓扑中的紧凑腔室，包括门、晶圆、动作和进度状态。 */
function renderModule(module: ModuleSnapshot, role: "process" | "lock" | "port" | "auxiliary"): string {
  const waferLimit = 3;
  const wafers = module.wafers.slice(0, waferLimit)
    .map(wafer => `<span class="wafer-token" title="晶圆 ${escapeHtml(wafer)}">${escapeHtml(wafer)}</span>`)
    .join("");
  const overflow = module.wafers.length > waferLimit
    ? `<span class="wafer-more">+${module.wafers.length - waferLimit}</span>`
    : "";
  const progress = Math.round(module.progress * 100);
  const accessibleStatus = `${module.name}，${STATUS_LABELS[module.status]}，${DOOR_LABELS[module.door]}`;
  return `
    <article class="equipment-card equipment-${role} status-${module.status} door-${module.door} ${module.isRobotTarget ? "is-target" : ""}" aria-label="${escapeHtml(accessibleStatus)}">
      <div class="equipment-gate" aria-hidden="true"><span></span></div>
      <div class="equipment-head">
        <strong>${escapeHtml(module.name)}</strong>
        <span class="equipment-status"><i></i>${escapeHtml(STATUS_LABELS[module.status])}</span>
      </div>
      <div class="equipment-body">
        <div class="wafer-stack">${wafers || '<span class="wafer-empty">空腔</span>'}${overflow}</div>
        ${module.environment ? `<span class="environment-state">${escapeHtml(module.environment)}</span>` : ""}
      </div>
      <div class="equipment-foot">
        <span class="door-state"><i></i>${escapeHtml(DOOR_LABELS[module.door])}</span>
        <span>${escapeHtml(module.activeMoveName || "等待")}${module.activeMoveName ? ` · ${progress}%` : ""}</span>
      </div>
      <div class="equipment-progress"><span style="transform:scaleX(${module.activeMoveName ? module.progress : 0})"></span></div>
    </article>`;
}

/** 绘制参考图中央的机器人传输区。 */
function renderRobotHub(robot: RobotSnapshot, environment: "vacuum" | "atmosphere"): string {
  return `
    <article class="robot-hub robot-hub-${environment} ${robot.busy ? "is-busy" : ""}" aria-label="${escapeHtml(robot.name)} ${robot.busy ? "工作中" : "待命"}">
      <div class="robot-hub-icon">${icon("robot")}</div>
      <strong>${escapeHtml(robot.name)}</strong>
      <span>${environment === "vacuum" ? "真空传输区" : "大气传输区"}</span>
      <small>${escapeHtml(robot.busy ? `${robot.activeMoveName}${robot.target ? ` → ${robot.target}` : ""}` : "待命")}</small>
      <div class="robot-wafers">${robot.wafers.map(wafer => `<span class="wafer-token">${escapeHtml(wafer)}</span>`).join("")}</div>
    </article>`;
}

/** 计算工艺腔沿 VTR 上半圆排列的位置。 */
function processModulePosition(index: number, count: number): string {
  const progress = count <= 1 ? 0.5 : index / (count - 1);
  const degrees = PROCESS_ARC_START_DEGREES
    + (PROCESS_ARC_END_DEGREES - PROCESS_ARC_START_DEGREES) * progress;
  const radians = degrees * Math.PI / 180;
  const left = PROCESS_ARC_CENTER_X_PERCENT + Math.cos(radians) * PROCESS_ARC_RADIUS_X_PERCENT;
  const top = PROCESS_ARC_CENTER_Y_PIXELS + Math.sin(radians) * PROCESS_ARC_RADIUS_Y_PIXELS;
  return `--module-left:${left.toFixed(2)}%;--module-top:${top.toFixed(2)}px;--module-order:${index}`;
}

/** 按参考图绘制 VTR、ATR、腔室、Load Lock 与装载端口的设备俯视拓扑。 */
function renderEquipmentTopology(snapshot: WorkspaceSnapshot): string {
  const groups = topologyGroups(snapshot.modules);
  const vacuumRobot = snapshot.robots.find(robot => /^(VTR|TM\d*)/i.test(robot.name));
  const atmosphereRobot = snapshot.robots.find(robot => /^ATR/i.test(robot.name));
  const assignedRobots = new Set([vacuumRobot?.name, atmosphereRobot?.name].filter(Boolean));
  const additionalRobots = snapshot.robots.filter(robot => !assignedRobots.has(robot.name));
  const leftAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 0);
  const rightAuxiliary = groups.auxiliaryModules.filter((_, index) => index % 2 === 1);
  return `
    <section class="equipment-schematic" aria-label="当前 MoveList 使用的设备拓扑">
      <div class="schematic-head">
        <div><strong>设备拓扑</strong><span>仅显示当前 MoveList 使用的模块</span></div>
        <small>${snapshot.modules.length} 个腔室 · ${snapshot.robots.length} 台机械手</small>
      </div>
      <div class="schematic-canvas">
        <div class="process-ring" aria-label="工艺腔室">
          ${groups.processModules.map((module, index) => `
            <div class="process-module-position" style="${processModulePosition(index, groups.processModules.length)}">
              ${renderModule(module, "process")}
            </div>`).join("")}
        </div>
        ${vacuumRobot ? renderRobotHub(vacuumRobot, "vacuum") : '<div class="topology-junction vacuum-junction"><strong>真空传输区</strong></div>'}
        <div class="load-lock-bank" aria-label="真空过渡腔">
          ${groups.loadLocks.map(module => renderModule(module, "lock")).join("")}
        </div>
        <div class="atmosphere-deck">
          <div class="auxiliary-bank auxiliary-left">${leftAuxiliary.map(module => renderModule(module, "auxiliary")).join("")}</div>
          ${atmosphereRobot ? renderRobotHub(atmosphereRobot, "atmosphere") : '<div class="topology-junction atmosphere-junction"><strong>大气传输区</strong></div>'}
          <div class="auxiliary-bank auxiliary-right">${rightAuxiliary.map(module => renderModule(module, "auxiliary")).join("")}</div>
        </div>
        <div class="load-port-bank" aria-label="装载端口">
          ${groups.loadPorts.map(module => renderModule(module, "port")).join("")}
        </div>
        ${additionalRobots.length ? `<div class="additional-robot-bank">${additionalRobots.map(robot => renderRobotHub(robot, "atmosphere")).join("")}</div>` : ""}
      </div>
    </section>`;
}

/** 创建并管理现有配置终端中的可视化工作台。 */
export class VisualizationWorkspace {
  private readonly root: Document;
  private readonly elements: WorkspaceElements;
  private device: DeviceDefinition | null = null;
  private moves: MoveRecord[] = [];
  private sourceName = "";
  private resultUrl = "";
  private time = 0;
  private playing = false;
  private playbackSpeed = DEFAULT_PLAYBACK_SPEED;
  private animationFrame = 0;
  private previousFrameTime = 0;
  private previousRenderTime = 0;

  /** 绑定页面事件并初始化空状态。 */
  constructor(root: Document) {
    this.root = root;
    this.elements = collectElements(root);
    this.bindEvents();
    this.updatePlayButton();
  }

  /** 更新当前设备拓扑；已有 MoveList 会立即按新拓扑重绘。 */
  setDevice(device: DeviceDefinition | null): void {
    this.device = device ? structuredClone(device) : null;
    if (this.moves.length) this.render();
  }

  /** 加载浏览器中选择的 MoveList 文件。 */
  async loadFile(file: File): Promise<void> {
    const payload = JSON.parse(await file.text()) as unknown;
    this.loadMoves(normalizeMovePayload(payload), file.name, "");
  }

  /** 从后端保存的运行结果加载 MoveList。 */
  async loadResult(resultIdOrUrl: string, sourceName = "当前运行结果"): Promise<void> {
    const resultUrl = resultIdOrUrl.startsWith("/")
      ? resultIdOrUrl
      : `/api/results/${encodeURIComponent(resultIdOrUrl)}`;
    this.setLoading(true, "正在加载运行结果…");
    try {
      const response = await fetch(resultUrl, { cache: "no-store" });
      const payload = await response.json() as unknown;
      if (!response.ok) {
        const message = payload && typeof payload === "object"
          ? String((payload as UnknownRecord).error ?? "")
          : "";
        throw new Error(message || `服务返回 ${response.status}`);
      }
      this.loadMoves(normalizeMovePayload(payload), sourceName, resultUrl);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** 切换到工作台标签。 */
  show(): void {
    const tab = this.root.querySelector<HTMLElement>('[data-tab-target="workspace"]');
    tab?.click();
    this.elements.range.focus({ preventScroll: true });
  }

  /** 停止播放并释放动画帧。 */
  destroy(): void {
    this.pause();
  }

  /** 清除旧测试结果，避免切换测试后继续误看上一份 MoveList。 */
  clear(): void {
    this.pause();
    this.moves = [];
    this.sourceName = "";
    this.resultUrl = "";
    this.time = 0;
    this.elements.resultButton.disabled = true;
    this.elements.openGantt.href = "#";
    this.elements.openGantt.setAttribute("aria-disabled", "true");
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.empty.classList.remove("is-loading", "is-error");
    this.elements.empty.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 9h8M8 13h5"/></svg>
      <strong>等待 MoveList</strong>
      <span>运行一次计划，或导入已有的 MoveList JSON 文件后开始回放。</span>`;
  }

  /** 接收规范化后的 MoveList 并重置时间轴。 */
  private loadMoves(moves: MoveRecord[], sourceName: string, resultUrl: string): void {
    if (!moves.length) throw new Error("MoveList 为空，无法建立可视化回放");
    this.pause();
    this.moves = moves;
    this.sourceName = sourceName;
    this.resultUrl = resultUrl;
    const snapshot = buildWorkspaceSnapshot(this.moves, this.device, 0);
    this.time = 0;
    this.elements.range.min = "0";
    this.elements.range.max = String(snapshot.endTime);
    this.elements.range.step = snapshot.endTime > 10000 ? "1" : "0.1";
    this.elements.range.value = "0";
    this.elements.openGantt.href = resultUrl
      ? `/movelist_gantt_viewer.html?src=${encodeURIComponent(resultUrl)}`
      : "#";
    this.elements.openGantt.setAttribute("aria-disabled", resultUrl ? "false" : "true");
    this.elements.resultButton.disabled = false;
    this.elements.empty.hidden = true;
    this.elements.content.hidden = false;
    this.render(snapshot);
  }

  /** 绑定文件、时间轴、播放和快捷控制事件。 */
  private bindEvents(): void {
    this.elements.fileInput.addEventListener("change", () => {
      const file = this.elements.fileInput.files?.item(0);
      if (!file) return;
      this.loadFile(file)
        .catch(error => this.showError(error instanceof Error ? error.message : String(error)))
        .finally(() => { this.elements.fileInput.value = ""; });
    });
    this.elements.range.addEventListener("input", () => {
      this.time = finiteNumber(this.elements.range.value);
      this.render();
    });
    this.elements.playButton.addEventListener("click", () => {
      if (this.playing) this.pause();
      else this.play();
    });
    this.elements.speed.addEventListener("change", () => {
      this.playbackSpeed = Math.max(0.25, finiteNumber(this.elements.speed.value, DEFAULT_PLAYBACK_SPEED));
    });
    this.elements.resultButton.addEventListener("click", () => this.show());
    this.elements.openGantt.addEventListener("click", event => {
      if (this.elements.openGantt.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }

  /** 从当前时间开始播放；到达末尾时自动回到起点。 */
  private play(): void {
    if (!this.moves.length || this.playing) return;
    const endTime = finiteNumber(this.elements.range.max);
    if (this.time >= endTime) {
      this.time = 0;
      this.elements.range.value = "0";
    }
    this.playing = true;
    this.previousFrameTime = performance.now();
    this.previousRenderTime = 0;
    this.updatePlayButton();
    this.animationFrame = requestAnimationFrame(timestamp => this.tick(timestamp));
  }

  /** 暂停回放并保留当前时间。 */
  private pause(): void {
    this.playing = false;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.updatePlayButton();
  }

  /** 推进播放时钟，并按固定上限刷新 DOM。 */
  private tick(timestamp: number): void {
    if (!this.playing) return;
    const elapsedSeconds = Math.max(0, timestamp - this.previousFrameTime) / 1000;
    this.previousFrameTime = timestamp;
    const endTime = finiteNumber(this.elements.range.max);
    this.time = Math.min(endTime, this.time + elapsedSeconds * this.playbackSpeed);
    this.elements.range.value = String(this.time);
    if (timestamp - this.previousRenderTime >= PLAYBACK_FRAME_INTERVAL_MS || this.time >= endTime) {
      this.previousRenderTime = timestamp;
      this.render();
    }
    if (this.time >= endTime) {
      this.pause();
      return;
    }
    this.animationFrame = requestAnimationFrame(nextTimestamp => this.tick(nextTimestamp));
  }

  /** 同步播放按钮的图标和无障碍文本。 */
  private updatePlayButton(): void {
    this.elements.playButton.innerHTML = this.playing
      ? `${icon("pause")}<span>暂停</span>`
      : `${icon("play")}<span>播放</span>`;
    this.elements.playButton.setAttribute("aria-label", this.playing ? "暂停回放" : "播放回放");
    this.elements.playButton.classList.toggle("is-playing", this.playing);
  }

  /** 绘制当前时间对应的设备快照。 */
  private render(prebuiltSnapshot?: WorkspaceSnapshot): void {
    if (!this.moves.length) return;
    const snapshot = prebuiltSnapshot ?? buildWorkspaceSnapshot(this.moves, this.device, this.time);
    this.time = snapshot.time;
    this.elements.source.textContent = this.sourceName;
    this.elements.currentTime.textContent = formatSeconds(snapshot.time);
    this.elements.totalTime.textContent = formatSeconds(snapshot.endTime);
    this.elements.progressText.textContent = snapshot.endTime > 0
      ? `${Math.round(snapshot.time / snapshot.endTime * 100)}%`
      : "0%";
    this.elements.moveText.textContent = `${snapshot.completedMoves} / ${snapshot.totalMoves}`;
    this.elements.waferText.textContent = String(snapshot.waferCount);
    this.elements.range.value = String(snapshot.time);

    this.elements.stage.innerHTML = renderEquipmentTopology(snapshot);

    this.elements.activeMoves.innerHTML = snapshot.activeMoves.length
      ? snapshot.activeMoves.map(move => `
        <li>
          <span class="active-move-id">#${finiteNumber(move.MoveID)}</span>
          <strong>${escapeHtml(MOVE_NAMES[finiteNumber(move.MoveType, -1)] ?? `动作 ${move.MoveType}`)}</strong>
          <span>${escapeHtml(move.ModuleName || activeTarget(move as NormalizedMove) || "—")}</span>
          <time>${formatSeconds(finiteNumber(move.StartTime))}–${formatSeconds(finiteNumber(move.EndTime))} s</time>
        </li>`).join("")
      : '<li class="active-move-empty">当前时刻没有执行中的动作</li>';
  }

  /** 显示加载状态并保留明确的系统反馈。 */
  private setLoading(loading: boolean, message: string): void {
    this.elements.empty.hidden = false;
    this.elements.empty.classList.toggle("is-loading", loading);
    this.elements.empty.classList.remove("is-error");
    this.elements.empty.innerHTML = loading
      ? `<span class="visual-loader" aria-hidden="true"></span><strong>${escapeHtml(message)}</strong>`
      : `<strong>${escapeHtml(message)}</strong>`;
  }

  /** 在工作台空状态中显示可恢复的错误。 */
  private showError(message: string): void {
    this.pause();
    this.elements.content.hidden = true;
    this.elements.empty.hidden = false;
    this.elements.empty.classList.remove("is-loading");
    this.elements.empty.classList.add("is-error");
    this.elements.empty.innerHTML = `
      <strong>无法加载 MoveList</strong>
      <span>${escapeHtml(message)}</span>
      <label class="btn visual-import-button">${icon("upload")}重新选择文件<input type="file" accept=".json,application/json" data-visual-retry></label>`;
    const retryInput = this.elements.empty.querySelector<HTMLInputElement>("[data-visual-retry]");
    retryInput?.addEventListener("change", () => {
      const file = retryInput.files?.item(0);
      if (file) this.loadFile(file).catch(error => this.showError(error instanceof Error ? error.message : String(error)));
    });
  }
}

/** 在页面加载后创建工作台控制器。 */
export function createVisualizationWorkspace(root: Document = document): VisualizationWorkspace {
  return new VisualizationWorkspace(root);
}
