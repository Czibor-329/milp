/**
 * 拓扑取放动画的瞬时画布投影。
 * 根据手臂动画交接时点更新画布中的腔室占位；业务快照、槽位侧栏、诊断与调度边界均不修改。
 */
import type { DeviceDefinition } from "./analysis_contracts";
import type { ModuleSnapshot, WorkspaceSnapshot } from "./workspace_visualizer";
import { configuredRobotArms, robotArmAnimation, type RobotArmAnimation } from "./topology_robot_mechanism";

/** 生成独立模块副本及各机器手分臂动画；所有物料标识仍来自原始快照或 Move。 */
export function projectTopologyTransfers(snapshot: WorkspaceSnapshot, device?: DeviceDefinition | null): {
  modules: ModuleSnapshot[];
  animations: Map<string, RobotArmAnimation[]>;
} {
  const modules = snapshot.modules.map(module => ({ ...module, wafers: [...module.wafers],
    processedWafers: [...module.processedWafers],
    loadPortSlots: module.loadPortSlots.map(slot => ({ ...slot })),
    loadLockSlots: module.loadLockSlots.map(slot => ({ ...slot })),
    processSlots: module.processSlots?.map(slot => ({ ...slot })),
  }));
  const animations = new Map<string, RobotArmAnimation[]>();
  for (const robot of snapshot.robots) {
    const definition = device?.Robots?.[robot.name];
    const arms = definition ? configuredRobotArms(definition)
      : robot.arms ?? configuredRobotArms({ Capacity: robot.capacity });
    const slots = arms.flatMap(arm => arm.slots);
    const slotWafers = { ...robot.slotWafers };
    if (slots.length === 1 && robot.wafers.length === 1 && !Object.keys(slotWafers).length) {
      slotWafers[slots[0]] = robot.wafers[0];
    }
    const move = snapshot.activeMoves.find(move => move.ModuleName === robot.name);
    const preparation = robot.environment === "atmosphere" ? robot.railMotion?.preparationFraction ?? 0 : 0;
    const alignedMove = move && preparation ? { ...move,
      StartTime: Number(move.StartTime) + (Number(move.EndTime) - Number(move.StartTime)) * preparation,
    } : move;
    const animation = robotArmAnimation(arms, slotWafers,
      alignedMove && snapshot.time < Number(alignedMove.StartTime) ? undefined : alignedMove, snapshot.time);
    animations.set(robot.name, animation.arms);
    for (const transfer of animation.transfers) {
      const module = modules.find(module => module.name === transfer.station);
      if (!module) continue;
      const processed = robot.processedWafers.includes(transfer.wafer);
      if (transfer.kind === "pick") {
        module.wafers = module.wafers.filter(wafer => wafer !== transfer.wafer);
      } else if (!module.wafers.includes(transfer.wafer)) {
        module.wafers.push(transfer.wafer);
        if (processed) module.processedWafers.push(transfer.wafer);
      }
      for (const slot of [...module.loadPortSlots, ...module.loadLockSlots, ...module.processSlots ?? []]) {
        if (transfer.kind === "pick" && slot.wafer === transfer.wafer) {
          slot.wafer = "";
          slot.processed = false;
        } else if (transfer.kind === "place" && slot.slot === transfer.stationSlot) {
          slot.wafer = transfer.wafer;
          slot.processed = processed;
        }
      }
    }
  }
  return { modules, animations };
}
