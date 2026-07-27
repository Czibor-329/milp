/**
 * 测试组性能评估。
 *
 * 输入只包含调度结果与可选的 MoveList 性能诊断；输出为无 UI 依赖的结构化统计，
 * 可供浏览器、Node 脚本或其他报告工具复用。
 */

import type { SchedulePerformance } from "./movelist_performance";

export interface TestGroupCaseInput {
  id: string;
  name: string;
  status: string;
  validation: string;
  makespan?: number | null;
  baselineMakespan?: number | null;
  cpuTimeMs?: number | null;
  elapsedTimeMs?: number | null;
  error?: string;
  performance?: SchedulePerformance | null;
}

export interface TestGroupCasePerformance {
  id: string;
  name: string;
  status: string;
  validation: string;
  validationPassed: boolean;
  makespan: number | null;
  baselineMakespan: number | null;
  comparable: boolean;
  improvementPercent: number | null;
  performanceRatio: number | null;
  cpuTimeMs: number | null;
  elapsedTimeMs: number | null;
  bottleneckResource: string;
  bottleneckUtilization: number | null;
  bottleneckCandidateCount: number;
  bottleneckCandidates: Array<{
    resourceName: string;
    utilization: number;
    score: number;
    confidence: string;
  }>;
  throughputPerHour: number | null;
  departureIntervalCv: number | null;
  processChamberDwellMeanSeconds: number | null;
  robotWaferDwellMeanSeconds: number | null;
  waferSystemResidenceMeanSeconds: number | null;
  waferSystemResidenceCv: number | null;
  windowMethod: string;
  error: string;
}

export interface BottleneckFrequency {
  resourceName: string;
  count: number;
  share: number;
  medianUtilization: number;
}

export interface TestGroupPerformanceSummary {
  cases: TestGroupCasePerformance[];
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  validationPassedCount: number;
  validationPassRate: number;
  comparableCount: number;
  winCount: number;
  tieCount: number;
  regressionCount: number;
  weightedImprovementPercent: number | null;
  medianImprovementPercent: number | null;
  worstRegressionPercent: number | null;
  medianCpuTimeMs: number | null;
  p90CpuTimeMs: number | null;
  totalCpuTimeMs: number;
  medianBottleneckUtilization: number | null;
  medianThroughputPerHour: number | null;
  medianDepartureIntervalCv: number | null;
  medianProcessChamberDwellMeanSeconds: number | null;
  medianRobotWaferDwellMeanSeconds: number | null;
  medianWaferSystemResidenceMeanSeconds: number | null;
  medianWaferSystemResidenceCv: number | null;
  bottleneckFrequencies: BottleneckFrequency[];
  windowMethodCounts: Record<string, number>;
}

const COMPARISON_TOLERANCE_PERCENT = 1e-6;

function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

function normalizeCase(input: TestGroupCaseInput): TestGroupCasePerformance {
  const makespan = finiteOrNull(input.makespan);
  const baselineMakespan = finiteOrNull(input.baselineMakespan);
  const comparable = (
    input.status === "succeeded"
    && makespan !== null
    && baselineMakespan !== null
    && baselineMakespan > 0
  );
  const improvementPercent = comparable
    ? ((baselineMakespan - makespan) / baselineMakespan) * 100
    : null;
  const primaryCandidate = input.performance?.primaryBottleneck ?? null;
  const legacyBottleneck = input.performance?.bottleneck ?? null;
  const bottleneckCandidates = input.performance?.bottleneckCandidates?.length
    ? input.performance.bottleneckCandidates.map(candidate => ({
      resourceName: candidate.label,
      utilization: candidate.utilization,
      score: candidate.score,
      confidence: candidate.confidence,
    }))
    : legacyBottleneck ? [{
      resourceName: legacyBottleneck.name,
      utilization: legacyBottleneck.utilization,
      score: legacyBottleneck.utilization,
      confidence: "",
    }] : [];
  return {
    id: String(input.id),
    name: String(input.name),
    status: String(input.status || "unknown"),
    validation: String(input.validation || "unknown"),
    validationPassed: input.validation === "passed",
    makespan,
    baselineMakespan,
    comparable,
    improvementPercent,
    performanceRatio: comparable ? makespan / baselineMakespan : null,
    cpuTimeMs: finiteOrNull(input.cpuTimeMs),
    elapsedTimeMs: finiteOrNull(input.elapsedTimeMs),
    bottleneckResource: primaryCandidate?.label ?? legacyBottleneck?.name ?? "",
    bottleneckUtilization: primaryCandidate?.utilization
      ?? legacyBottleneck?.utilization
      ?? null,
    bottleneckCandidateCount: input.performance?.bottleneckCandidates?.length
      ?? (legacyBottleneck ? 1 : 0),
    bottleneckCandidates,
    throughputPerHour: input.performance
      ? finiteOrNull(input.performance.throughputPerHour)
      : null,
    departureIntervalCv: input.performance
      ? finiteOrNull(input.performance.departureIntervalCv)
      : null,
    processChamberDwellMeanSeconds: input.performance?.processChamberDwellTime?.sampleCount
      ? finiteOrNull(input.performance.processChamberDwellTime?.meanSeconds)
      : null,
    robotWaferDwellMeanSeconds: input.performance?.robotWaferDwellTime?.sampleCount
      ? finiteOrNull(input.performance.robotWaferDwellTime?.meanSeconds)
      : null,
    waferSystemResidenceMeanSeconds: input.performance?.waferSystemResidenceTime?.sampleCount
      ? finiteOrNull(input.performance.waferSystemResidenceTime?.meanSeconds)
      : null,
    waferSystemResidenceCv: input.performance?.waferSystemResidenceTime?.sampleCount
      ? finiteOrNull(input.performance.waferSystemResidenceTime?.coefficientOfVariation)
      : null,
    windowMethod: input.performance?.window.method ?? "",
    error: String(input.error || ""),
  };
}

/** 生成完整的测试组统计；不将不同量纲压成单一综合分数。 */
export function analyzeTestGroupPerformance(
  inputs: TestGroupCaseInput[],
): TestGroupPerformanceSummary {
  const cases = inputs.map(normalizeCase);
  const succeeded = cases.filter(item => item.status === "succeeded");
  const comparable = cases.filter(item => item.comparable);
  const improvements = comparable
    .map(item => item.improvementPercent)
    .filter((value): value is number => value !== null);
  const totalMakespan = comparable.reduce(
    (sum, item) => sum + (item.makespan ?? 0),
    0,
  );
  const totalBaseline = comparable.reduce(
    (sum, item) => sum + (item.baselineMakespan ?? 0),
    0,
  );
  const cpuTimes = succeeded
    .map(item => item.cpuTimeMs)
    .filter((value): value is number => value !== null && value >= 0);
  const bottleneckUtilizations = succeeded
    .map(item => item.bottleneckUtilization)
    .filter((value): value is number => value !== null);
  const throughputs = succeeded
    .map(item => item.throughputPerHour)
    .filter((value): value is number => value !== null && value > 0);
  const departureCvs = succeeded
    .map(item => item.departureIntervalCv)
    .filter((value): value is number => value !== null);
  const chamberDwellMeans = succeeded
    .map(item => item.processChamberDwellMeanSeconds)
    .filter((value): value is number => value !== null);
  const robotDwellMeans = succeeded
    .map(item => item.robotWaferDwellMeanSeconds)
    .filter((value): value is number => value !== null);
  const systemResidenceMeans = succeeded
    .map(item => item.waferSystemResidenceMeanSeconds)
    .filter((value): value is number => value !== null);
  const systemResidenceCvs = succeeded
    .map(item => item.waferSystemResidenceCv)
    .filter((value): value is number => value !== null);

  const frequencyMap = new Map<string, number[]>();
  const windowMethodCounts: Record<string, number> = {};
  for (const item of succeeded) {
    for (const candidate of item.bottleneckCandidates) {
      const values = frequencyMap.get(candidate.resourceName) ?? [];
      values.push(candidate.utilization);
      frequencyMap.set(candidate.resourceName, values);
    }
    if (item.windowMethod) {
      windowMethodCounts[item.windowMethod] = (
        windowMethodCounts[item.windowMethod] ?? 0
      ) + 1;
    }
  }
  const bottleneckFrequencies = [...frequencyMap.entries()]
    .map(([resourceName, values]) => ({
      resourceName,
      count: values.length,
      share: succeeded.length ? values.length / succeeded.length : 0,
      medianUtilization: median(values) ?? 0,
    }))
    .sort((left, right) => (
      right.count - left.count
      || right.medianUtilization - left.medianUtilization
      || left.resourceName.localeCompare(right.resourceName, undefined, {
        numeric: true,
      })
    ));

  return {
    cases,
    totalCount: cases.length,
    succeededCount: succeeded.length,
    failedCount: cases.length - succeeded.length,
    validationPassedCount: succeeded.filter(item => item.validationPassed).length,
    validationPassRate: succeeded.length
      ? succeeded.filter(item => item.validationPassed).length / succeeded.length
      : 0,
    comparableCount: comparable.length,
    winCount: improvements.filter(value => value > COMPARISON_TOLERANCE_PERCENT).length,
    tieCount: improvements.filter(
      value => Math.abs(value) <= COMPARISON_TOLERANCE_PERCENT,
    ).length,
    regressionCount: improvements.filter(
      value => value < -COMPARISON_TOLERANCE_PERCENT,
    ).length,
    weightedImprovementPercent: totalBaseline > 0
      ? ((totalBaseline - totalMakespan) / totalBaseline) * 100
      : null,
    medianImprovementPercent: median(improvements),
    worstRegressionPercent: improvements.some(value => value < 0)
      ? Math.min(...improvements)
      : null,
    medianCpuTimeMs: median(cpuTimes),
    p90CpuTimeMs: percentile(cpuTimes, 0.9),
    totalCpuTimeMs: cpuTimes.reduce((sum, value) => sum + value, 0),
    medianBottleneckUtilization: median(bottleneckUtilizations),
    medianThroughputPerHour: median(throughputs),
    medianDepartureIntervalCv: median(departureCvs),
    medianProcessChamberDwellMeanSeconds: median(chamberDwellMeans),
    medianRobotWaferDwellMeanSeconds: median(robotDwellMeans),
    medianWaferSystemResidenceMeanSeconds: median(systemResidenceMeans),
    medianWaferSystemResidenceCv: median(systemResidenceCvs),
    bottleneckFrequencies,
    windowMethodCounts,
  };
}
