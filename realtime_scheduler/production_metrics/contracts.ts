/** 可独立复制的生产指标前端契约。 */

export interface ProductionMetricConfiguration {
  sampleSize: number;
  trimmedHeadWafers: number;
  trimmedTailWafers: number;
  minimumTotalWafers: number;
}

export interface ProductionMetricSampleWindow {
  available: boolean;
  totalCompletedWafers: number;
  selectedWaferCount: number;
  waferIds: string[];
  start: number | null;
  end: number | null;
  durationSeconds: number | null;
  reason: string;
}

export interface ProductionMetricChamber {
  chamber: string;
  stepId: string;
  recipe: string;
  waferCount: number;
  k: number;
  throughputPerHour: number | null;
  entryIntervalStdSeconds: number | null;
  surpassWaferCount: number;
  surpassRate: number | null;
}

export interface ProductionMetricModule {
  name: string;
  busyTimeSeconds: number;
  utilization: number;
}

export interface ProductionMetricsResult {
  schemaVersion: "production-metrics-v1";
  configuration: ProductionMetricConfiguration;
  calculationSeconds: number | null;
  sampleWindow: ProductionMetricSampleWindow;
  applicability: {
    sameRecipeAndPath: boolean;
    reason: string;
  };
  overall: {
    available: boolean;
    throughputPerHour: number | null;
    rptMinutes: number | null;
    parallelChamberCount: number | null;
    reason: string;
  };
  chambers: ProductionMetricChamber[];
  modules: ProductionMetricModule[];
}
