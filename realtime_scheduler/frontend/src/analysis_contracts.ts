/**
 * 服务端分析 API 的只读响应契约。
 *
 * 本文件只描述前端渲染需要的数据形状，不包含任何指标计算、数据持久化或业务规则。
 */

import type { ProductionMetricsResult } from "../../production_metrics/contracts";

export type UnknownRecord = Record<string, unknown>;

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

export type PerformanceWindowMode = "steady" | "full";
export type ActivityCategory = "process" | "clean" | "door" | "transfer" | "environment" | "other";
export type ResourceKind = "robot" | "process" | "loadlock" | "loadport" | "auxiliary";
export type BottleneckConfidence = "high" | "medium" | "low";
export type BottleneckCandidateKind = "process-group" | "robot" | "loadlock-group";

export interface ScheduleAnalysisContext {
  processStages?: Array<{
    id: string;
    label?: string;
    pjobName?: string;
    stepId?: string | number;
    resourceNames: string[];
  }>;
}

export interface PerformanceWindow {
  mode: PerformanceWindowMode;
  method: "steady-overlap" | "middle-approximation" | "full";
  start: number;
  end: number;
  duration: number;
  scheduleStart: number;
  scheduleEnd: number;
  trimmedStart: number;
  trimmedEnd: number;
  label: string;
  detail: string;
}

export interface DurationMetricSummary {
  totalSeconds: number;
  meanSeconds: number;
  medianSeconds: number;
  maxSeconds: number;
  coefficientOfVariation: number;
  sampleCount: number;
}

export interface WaferResidenceTime {
  wafer: string;
  enteredAt: number;
  completedAt: number;
  duration: number;
  chamberDwellSeconds?: number;
  robotDwellSeconds?: number;
}

export interface ResourcePerformance {
  name: string;
  type: string;
  kind: ResourceKind;
  utilization: number;
  busyTime: number;
  averageActivePeriod: number;
  longestActivePeriod: number;
  longestIdlePeriod: number;
  activePeriodCount: number;
  categoryTimes: Record<ActivityCategory, number>;
  isBottleneck: boolean;
  bottleneckCandidateRank: number | null;
}

export interface BottleneckCandidate {
  id: string;
  label: string;
  kind: BottleneckCandidateKind;
  resourceNames: string[];
  utilization: number;
  continuity: number;
  score: number;
  confidence: BottleneckConfidence;
  evidence: string[];
}

export interface SchedulePerformance {
  window: PerformanceWindow;
  resources: ResourcePerformance[];
  bottleneckCandidates: BottleneckCandidate[];
  primaryBottleneck: BottleneckCandidate | null;
  bottleneck: ResourcePerformance | null;
  completedWaferCount: number;
  throughputPerHour: number;
  meanDepartureInterval: number;
  departureIntervalCv: number;
  processChamberDwellTime: DurationMetricSummary;
  robotWaferDwellTime: DurationMetricSummary;
  waferSystemResidenceTime: DurationMetricSummary;
  waferSystemResidenceTimes: WaferResidenceTime[];
  loadLockEfficiency: {
    cycleCount: number;
    waferCycleCount: number;
    wafersPerCycle: number;
    fullLoadCycleCount: number;
    emptyLoadCycleCount: number;
    fullLoadCycleRatio: number;
    emptyLoadCycleRatio: number;
  };
  productionMetrics: ProductionMetricsResult;
}

export interface BottleneckUtilizationSummary {
  resourceName: string;
  utilization: number;
  windowLabel: string;
  confidence: BottleneckConfidence;
  candidateCount: number;
  score: number;
}

export interface TestGroupPerformanceSummary {
  cases: Array<Record<string, any>>;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  metricsCount: number;
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
  bottleneckFrequencies: Array<{
    resourceName: string;
    count: number;
    share: number;
    medianUtilization: number;
  }>;
  windowMethodCounts: Record<string, number>;
}
