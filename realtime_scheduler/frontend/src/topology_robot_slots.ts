/**
 * 机械手正视槽位组合：大气手纵向堆叠，单腔真空手按臂分列，双腔真空手每臂一行。
 * 只读取已完成动作的 RobotSlot 占位，不改变回放状态；槽位内容由页面统一渲染。
 */
import type { RobotSnapshot, LoadPortSlotSnapshot } from "./workspace_visualizer";
import { configuredRobotArms } from "./topology_robot_mechanism";

/** 根据物理臂生成独占一行的槽位组；单臂只占左列，双腔真空手共享两列外框。 */
export function renderRobotSlotRow(robot: RobotSnapshot, dual: boolean,
  renderSlots: (slots: LoadPortSlotSnapshot[]) => string, escape: (text: string) => string): string {
  const arms = robot.arms ?? configuredRobotArms({ Capacity: robot.capacity });
  const combined = dual && robot.environment === "vacuum";
  const slots = (ids: number[]): LoadPortSlotSnapshot[] => ids.map(slot => ({ slot,
    wafer: robot.slotWafers?.[slot] ?? "",
    processed: robot.processedWafers.includes(robot.slotWafers?.[slot] ?? ""),
  }));
  const boards = combined
    ? `<div class="front-module front-robot-combined"><strong>${escape(robot.name)}</strong><div class="front-slot-board front-robot-combined-board" style="--front-slot-count:${arms.length}">${arms.map(arm => `<div class="front-robot-arm-pair" role="group" aria-label="${escape(arm.name)}">${renderSlots(slots(arm.slots))}</div>`).join("")}</div></div>`
    : arms.map(arm => `<div class="front-module"><strong>${escape(robot.name)}${dual ? "" : ` · ${escape(arm.name)}`}</strong><div class="front-slot-board" style="--front-slot-count:${arm.slots.length}" role="group" aria-label="${escape(robot.name + ' ' + arm.name)}">${renderSlots(slots(arm.slots))}</div></div>`).join("");
  return `<div class="front-slot-row front-slot-row-robot" data-robot="${escape(robot.name)}">${boards}</div>`;
}
