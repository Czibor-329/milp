/**
 * 调度终端的 JSON API 客户端。
 *
 * 统一处理 HTTP 状态和后端 error 字段，让页面交互只处理业务结果。
 */

import type {
  BottleneckUtilizationSummary,
  DeviceDefinition,
  MoveRecord,
  PerformanceWindowMode,
  SchedulePerformance,
  TestGroupPerformanceSummary,
} from "./analysis_contracts";

/** 请求 JSON 接口，并把失败响应转换为带业务消息的异常。 */
export async function requestJson(
  url: string,
  options: RequestInit = {},
): Promise<Record<string, any>> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `服务返回 ${response.status}`);
  }
  return result;
}

/** 请求服务端计算一份 MoveList 的完整性能分析。 */
export async function requestScheduleAnalysis(input: {
  resultId?: string;
  moves?: MoveRecord[];
  device: DeviceDefinition | null;
  windowMode: PerformanceWindowMode;
  routes?: Array<Record<string, any>>;
  rounds?: Array<Record<string, any>>;
}): Promise<{
  analysis: SchedulePerformance;
  bottleneck: BottleneckUtilizationSummary | null;
}> {
  const result = await requestJson("/api/analysis/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return {
    analysis: result.analysis as SchedulePerformance,
    bottleneck: (result.bottleneck ?? null) as BottleneckUtilizationSummary | null,
  };
}

/** 请求服务端汇总一个测试组，不在浏览器中复制统计口径。 */
export async function requestTestGroupAnalysis(
  cases: Array<Record<string, any>>,
): Promise<TestGroupPerformanceSummary> {
  const result = await requestJson("/api/analysis/test-group", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cases }),
  });
  return result.analysis as TestGroupPerformanceSummary;
}

/** 请求 Machine 按当前 Move 回放状态实时枚举并使用 E2E-CTQ 评分动作。 */
export async function requestReplayDecision(input: {
  resultId?: string;
  moves?: MoveRecord[];
  plan?: Record<string, any> | null;
  time: number;
}): Promise<Record<string, any>> {
  const result = await requestJson("/api/analysis/replay-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return result.decision as Record<string, any>;
}
