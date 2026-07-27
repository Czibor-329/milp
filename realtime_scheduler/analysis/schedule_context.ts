/**
 * 将调度配置转换为性能分析上下文。
 *
 * 本模块不依赖 DOM 或页面状态，可与 movelist_performance 一起作为独立分析库复用。
 */

import type {
  ProcessStageDefinition,
  ScheduleAnalysisContext,
} from "./movelist_performance";

type UnknownRecord = Record<string, any>;

/** 从 Route/PJob 配置提取每道工序的完整并行腔室集合。 */
export function buildScheduleAnalysisContext(
  routes: UnknownRecord[] | null | undefined,
  rounds: UnknownRecord[] | null | undefined,
): ScheduleAnalysisContext {
  const routeByName = new Map(
    (routes ?? []).map(route => [String(route?.name ?? ""), route]),
  );
  const processStages: ProcessStageDefinition[] = [];

  for (const [roundIndex, round] of (rounds ?? []).entries()) {
    for (const [cjobIndex, cjob] of (round?.cjobs ?? []).entries()) {
      for (const pjob of cjob?.pjobs ?? []) {
        const route = routeByName.get(String(pjob?.routeRef ?? ""));
        if (!route) continue;
        let processOrdinal = 0;
        for (const stage of route.stages ?? []) {
          if (!stage?.needProcess) continue;
          processOrdinal += 1;
          const resourceNames = [...new Set<string>(
            (stage.visits ?? [])
              .map((visit: UnknownRecord) => String(visit?.stationName ?? "").trim())
              .filter(Boolean),
          )];
          if (!resourceNames.length) continue;
          const taskId = String(roundIndex + 1);
          const cjobKey = String(cjob?.key ?? `C${cjobIndex + 1}`);
          const jobName = String(pjob?.jobName ?? "P?");
          processStages.push({
            id: `${taskId}.${cjobKey}.${jobName}:step-${stage.stepId}`,
            label: `${jobName} · 工序 ${processOrdinal}`,
            pjobName: `${taskId}.${cjobKey}.${jobName}`,
            stepId: stage.stepId,
            resourceNames,
          });
        }
      }
    }
  }
  return { processStages };
}
