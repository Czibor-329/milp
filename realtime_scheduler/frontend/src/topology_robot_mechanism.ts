/**
 * 单腔与级联机械臂的配置、槽位占位与取放动画。
 * ArmInfo/SlotIDs 定义臂和爪，动作的 RobotSlotList/RecvSlotList/SendSlotList 选择执行臂。
 * 交接仅用于画布投影，不修改调度快照或动作完成边界。
 */
import type { MoveRecord } from "./analysis_contracts";

export interface RobotArmDefinition {
  name: string;
  enabled: boolean;
  slots: number[];
}
export interface RobotArmAnimation extends RobotArmDefinition {
  progress: number | null;
  target: string;
  wafers: Record<number, string>;
}
export interface RobotVisualTransfer {
  kind: "pick" | "place";
  station: string;
  stationSlot: number;
  robotSlot: number;
  wafer: string;
}
const REST_REACH = 58;
const ATR_RETRACTED_REACH = 42;
const CLAW_SCALE = 0.8;
const ARM_SEPARATION = 44;
const CLAW_SEPARATION = 18;
const SHOULDER_SEPARATION = 16;
const EXTENDED_ELBOW_RATIO = 0.12;
/** 夹爪局部原点为晶圆中心，连接柄末端位于其后方 23px。 */
const CLAW_STEM_OFFSET = 23;
/** 紧凑叉形夹爪：实心连接柄、两条渐细爪指与内侧弧形开口。 */
const CLAW_PATH = "M -23 -4 L -15 -4 Q -8 -4 -7 -14 L 14 -20 L 16 -18 L -1 -12 Q -8 0 -1 12 L 16 18 L 14 20 L -7 14 Q -8 4 -15 4 L -23 4 Z";
const HANDOFF_PROGRESS = 0.5;
const SWAP_MOVE = 4;

/** 缺失的标准列表字段按空数组处理。 */
function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 按 ArmInfo 读取物理臂与手槽；旧配置只按 Capacity/Slots 回退，不默认双臂。 */
export function configuredRobotArms(definition: Record<string, unknown>): RobotArmDefinition[] {
  const arms = Object.entries((definition.ArmInfo ?? {}) as Record<string, Record<string, unknown>>)
    .filter(([, arm]) => arm && typeof arm === "object")
    .map(([name, arm]) => ({ name, enabled: arm.IsEnable !== false,
      slots: [...new Set(values(arm.SlotIDs).map(Number).filter(slot => Number.isInteger(slot) && slot > 0))] }));
  if (arms.length) return arms;
  const declaredSlots = values(definition.Slots).map(Number).filter(slot => Number.isInteger(slot) && slot > 0);
  const slots = declaredSlots.length ? declaredSlots
    : Array.from({ length: Math.max(1, Math.floor(Number(definition.Capacity) || 1)) }, (_, index) => index + 1);
  return slots.map(slot => ({ name: `Arm${slot}`, enabled: true, slots: [slot] }));
}

/** 展开有序交接阶段，严格区分机器手槽位与站点槽位，并尊重 SwapMode。 */
function transferStages(move: MoveRecord): RobotVisualTransfer[][] {
  const type = Number(move.MoveType);
  /** 从同下标的槽位、物料、站点字段构造一次交接。 */
  const stage = (kind: "pick" | "place", slots: string, materials: string,
    stations: string, stationSlots: string): RobotVisualTransfer[] => values(move[materials]).map((wafer, index) => ({
      kind, wafer: String(wafer), robotSlot: Number(values(move[slots])[index] ?? 0),
      station: String(values(move[stations])[index] ?? values(move[stations])[0] ?? ""),
      stationSlot: Number(values(move[stationSlots])[index] ?? 0),
    }));
  if (type === SWAP_MOVE) {
    const pick = stage("pick", "RecvSlotList", "RecvMatList", "StationList", "StnSendSlotList");
    const place = stage("place", "SendSlotList", "SendMatList", "StationList", "StnRecvSlotList");
    return Number(move.SwapMode) === 1 ? [place, pick] : [pick, place];
  }
  if (type === 0 || type === 2) return [stage("pick", "RobotSlotList", "MatIDList", "SrcStationList", "SrcSlotList")];
  if (type === 1 || type === 3) return [stage("place", "RobotSlotList", "MatIDList", "DestStationList", "DestSlotList")];
  return [];
}

/** 从完成动作恢复手槽；首次持片可由后续 Place/Swap 定位，最后用业务快照过滤旧物料。 */
export function robotSlotWafers(moves: MoveRecord[], time: number, name: string,
  heldWafers: string[]): Record<number, string> {
  const byWafer = new Map<string, number>();
  const relevant = moves.filter(move => move.ModuleName === name);
  for (const move of relevant) {
    for (const transfer of transferStages(move).flat()) {
      if (transfer.robotSlot > 0 && !byWafer.has(transfer.wafer)) byWafer.set(transfer.wafer, transfer.robotSlot);
    }
  }
  for (const move of [...relevant].sort((a, b) => Number(a.EndTime) - Number(b.EndTime))) {
    if (Number(move.EndTime) > time) continue;
    for (const transfer of transferStages(move).flat()) {
      if (transfer.kind === "pick" && transfer.robotSlot > 0) byWafer.set(transfer.wafer, transfer.robotSlot);
    }
  }
  return Object.fromEntries(heldWafers.filter(wafer => byWafer.has(wafer)).map(wafer => [byWafer.get(wafer), wafer]));
}

/** 每个 Swap 阶段独立伸入、交接、收回；未参与阶段的臂保持原槽位持片。 */
export function robotArmAnimation(definitions: RobotArmDefinition[], slotWafers: Record<number, string>,
  move: MoveRecord | undefined, time: number): { arms: RobotArmAnimation[]; transfers: RobotVisualTransfer[] } {
  const arms = definitions.map(arm => ({ ...arm, progress: null as number | null, target: "",
    wafers: Object.fromEntries(arm.slots.map(slot => [slot, slotWafers[slot] ?? ""])) }));
  const transfers: RobotVisualTransfer[] = [];
  if (!move) return { arms, transfers };
  const stages = transferStages(move);
  const duration = Number(move.EndTime) - Number(move.StartTime);
  const progress = duration > 0 ? Math.max(0, Math.min(1, (time - Number(move.StartTime)) / duration)) : 1;
  stages.forEach((stage, index) => {
    const localProgress = progress * stages.length - index;
    for (const transfer of stage) {
      // 缺字段时仅允许唯一有效槽位回退，不能按晶圆排序猜测多臂执行槽位。
      const enabledSlots = arms.filter(arm => arm.enabled).flatMap(arm => arm.slots);
      const slot = transfer.robotSlot || (enabledSlots.length === 1 ? enabledSlots[0] : 0);
      const arm = arms.find(arm => arm.enabled && arm.slots.includes(slot));
      if (!arm) continue;
      if (localProgress >= 0 && localProgress < 1) {
        arm.progress = localProgress;
        arm.target = transfer.station;
      }
      if (localProgress >= HANDOFF_PROGRESS) {
        arm.wafers[slot] = transfer.kind === "pick" ? transfer.wafer : "";
        transfers.push({ ...transfer, robotSlot: slot });
      }
    }
  });
  return { arms, transfers };
}

/** 阶段中段抵达腔室中心，开始和结束均收回，拖动时间轴按同一公式定位。 */
export function robotTransferReach(distance: number, progress: number | null, restReach = REST_REACH): number {
  return restReach + (distance - restReach) * extensionFraction(progress);
}

/** 将伸入和收回映射为连续的平滑插值，臂端横向偏移与伸缩同步回到待命位置。 */
function extensionFraction(progress: number | null): number {
  if (progress === null) return 0;
  const bounded = Math.max(0, Math.min(1, progress));
  const phase = Math.min(1, bounded * 3, (1 - bounded) * 3);
  return phase * phase * (3 - 2 * phase);
}

/** 待命肘点位于首尾连线的直径圆上，保证内角九十度；两臂绕中轴镜像展开。 */
export function robotArmGeometry(reach: number, index: number, count: number, progress: number | null): {
  shoulder: number; elbowX: number; elbowY: number; tipY: number;
} {
  const side = index < (count - 1) / 2 ? -1 : 1;
  const shoulder = (index - (count - 1) / 2) * SHOULDER_SEPARATION;
  const fraction = extensionFraction(progress);
  const tipY = (index - (count - 1) / 2) * ARM_SEPARATION * (1 - fraction);
  const bend = (1 - fraction) / 2 + fraction * EXTENDED_ELBOW_RATIO;
  return { shoulder, tipY,
    elbowX: reach / 2 - side * (tipY - shoulder) * bend,
    elbowY: (shoulder + tipY) / 2 + side * reach * bend,
  };
}

/** 每个配置槽位绘制一个爪，持片绑定所属槽位；回调负责晶圆内容及名称转义。 */
export function renderParallelRobotArms(arms: RobotArmAnimation[], distance: number,
  renderWafer: (wafer: string) => string, escape: (text: string) => string,
  targetGeometry?: (station: string) => { distance: number; angle: number } | undefined,
  occlusions: Array<{ x: number; y: number; radius: number }> = [], maskPrefix = "robot",
  mechanism: "articulated" | "telescopic" = "articulated"): string {
  const waferLayers: string[] = [];
  const markup = arms.map((arm, index) => {
    const geometry = arm.target ? targetGeometry?.(arm.target) : undefined;
    const visibleProgress = targetGeometry && arm.target && !geometry ? null : arm.progress;
    const reach = robotTransferReach(geometry?.distance ?? distance, visibleProgress,
      mechanism === "telescopic" ? ATR_RETRACTED_REACH : REST_REACH);
    const { shoulder, elbowX, elbowY, tipY } = robotArmGeometry(reach, index, arms.length, visibleProgress);
    // 夹爪随前臂末段朝向旋转，前臂终点停在连接柄尾端，避免伸进叉口或错位。
    const clawAngle = mechanism === "telescopic" ? 0 : Math.atan2(tipY - elbowY, reach - elbowX);
    const mountX = reach - CLAW_STEM_OFFSET * CLAW_SCALE * Math.cos(clawAngle);
    const mountY = tipY - CLAW_STEM_OFFSET * CLAW_SCALE * Math.sin(clawAngle);
    const linkPath = mechanism === "telescopic" ? `M 0 ${tipY} L ${mountX} ${mountY}`
      : `M 0 ${shoulder} L ${elbowX} ${elbowY} L ${mountX} ${mountY}`;
    const wristHalfWidth = (arm.slots.length - 1) * CLAW_SEPARATION / 2;
    const wristPath = arm.slots.length > 1 ? ` M ${mountX} ${mountY - wristHalfWidth} V ${mountY + wristHalfWidth}` : "";
    const claws = arm.slots.map((slot, slotIndex) => {
      const y = tipY + (slotIndex - (arm.slots.length - 1) / 2) * CLAW_SEPARATION;
      return `<g class="parallel-robot-claw" data-robot-slot="${slot}" transform="translate(${reach} ${y}) rotate(${clawAngle * 180 / Math.PI}) scale(${CLAW_SCALE})">
        <path d="${CLAW_PATH}"/>
      </g>`;
    }).join("");
    const wafers = arm.slots.map((slot, slotIndex) => {
      const wafer = arm.wafers[slot];
      const y = tipY + (slotIndex - (arm.slots.length - 1) / 2) * CLAW_SEPARATION;
      return wafer ? `<span class="parallel-robot-wafers" data-held-slot="${slot}" style="left:${reach}px;top:${y}px">${renderWafer(wafer)}</span>` : "";
    }).join("");
    const localAngle = geometry?.angle ?? 0;
    waferLayers.push(`<div class="parallel-robot-wafer-layer" style="--robot-arm-local-angle:${localAngle}deg">${wafers}</div>`);
    // 站点晶圆仍在模块图层；机构在这些圆形区域留空，保证取片前和放片后爪子也位于晶圆下。
    const maskId = `robot-mask-${Array.from(maskPrefix).map(character => character.codePointAt(0)).join("-")}-${index}`;
    const radians = localAngle * Math.PI / 180;
    const holes = occlusions.map(point => `<circle cx="${point.x * Math.cos(radians) + point.y * Math.sin(radians)}" cy="${-point.x * Math.sin(radians) + point.y * Math.cos(radians)}" r="${point.radius}" fill="black"/>`).join("");
    return `<div class="parallel-robot-arm${arm.progress === null ? "" : " is-transferring"}${arm.enabled ? "" : " is-disabled"}" data-arm="${escape(arm.name)}" style="--robot-reach:${reach.toFixed(2)}px;--robot-arm-local-angle:${localAngle}deg">
      <svg class="parallel-robot-arms" overflow="visible" aria-hidden="true">
        <defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="4000" height="4000"><rect x="-2000" y="-2000" width="4000" height="4000" fill="white"/>${holes}</mask></defs>
        <g mask="url(#${maskId})"><path class="parallel-robot-link" d="${linkPath}${wristPath}"/>
        <path class="parallel-robot-link-inset" d="${linkPath}${wristPath}"/>
        ${mechanism === "telescopic" ? `<path class="parallel-robot-slide" d="M 0 ${tipY} H ${reach / 2}"/>`
          : `<circle class="parallel-robot-joint" cx="${elbowX}" cy="${elbowY}" r="4"/>`}${claws}</g>
      </svg></div>`;
  }).join("");
  return `<div class="parallel-robot-mechanism">${markup}${waferLayers.join("")}</div>`;
}
