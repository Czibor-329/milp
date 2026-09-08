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
  cpuTimeMs?: number | null;
  recomputeCount?: number;
  metricGroups?: string[];
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

/** 请求算法按当前 Move 回放状态更新原子动作分类。 */
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

/** 创建测试组后台分析任务，使长耗时指标不阻塞页面请求。 */
export async function createTestGroupAnalysisJob(
  input: Record<string, any>,
): Promise<Record<string, any>> {
  const result = await requestJson("/api/analysis-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return result.job as Record<string, any>;
}

/** 读取测试组后台分析任务的进度和已完成结果。 */
export async function readTestGroupAnalysisJob(jobId: string): Promise<Record<string, any>> {
  const result = await requestJson(`/api/analysis-jobs/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
  });
  return result.job as Record<string, any>;
}

/** 请求取消正在运行的测试组分析任务。 */
export async function cancelTestGroupAnalysisJob(jobId: string): Promise<Record<string, any>> {
  const result = await requestJson(`/api/analysis-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  return result.job as Record<string, any>;
}

/** 请求服务端生成死锁诊断 JSON；返回文件内容与响应头中的下载名。 */
export async function requestDeadlockDiagnostic(input: {
  resultId?: string;
  moves?: MoveRecord[];
  plan?: Record<string, any> | null;
  time: number;
  snapshot: Record<string, any>;
}): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch("/api/analysis/deadlock-diagnostic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result?.error || `服务返回 ${response.status}`);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const fallbackName = disposition.match(/filename="([^"]+)"/i)?.[1];
  return {
    blob: await response.blob(),
    fileName: encodedName
      ? decodeURIComponent(encodedName)
      : fallbackName || "deadlock-diagnostic.json",
  };
}

/** 读取 Search Tree 搜索快照；版本未变化时后端只返回紧凑标记。 */
export async function requestSearchTelemetry(
  sinceRevision: number | null = null,
): Promise<Record<string, any>> {
  const query = sinceRevision === null
    ? ""
    : `?since=${encodeURIComponent(String(sinceRevision))}`;
  const result = await requestJson(`/api/search-telemetry${query}`, {
    cache: "no-store",
  });
  return result.telemetry as Record<string, any>;
}

/** 暂停、单步、继续、指定根动作或取消求解；actionKey 仅 choose 命令使用。 */
export async function requestSearchControl(
  command: "pause" | "step" | "continue" | "step-mode" | "replay-mode" | "choose" | "cancel",
  actionKey: string | null = null,
): Promise<Record<string, any>> {
  return requestJson("/api/search-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actionKey ? { command, actionKey } : { command }),
  });
}
