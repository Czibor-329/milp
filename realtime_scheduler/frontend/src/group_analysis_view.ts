import type { TestGroupPerformanceSummary } from "./analysis_contracts";

type TestGroupCasePerformance = TestGroupPerformanceSummary["cases"][number];

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function finiteText(
  value: number | null,
  digits: number,
  suffix = "",
): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value.toFixed(digits)}${suffix}`;
}

function percentText(value: number | null, fromRatio = false): string {
  const normalized = value === null ? null : value * (fromRatio ? 100 : 1);
  return finiteText(normalized, 2, "%");
}

function durationText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${value.toFixed(1)} ms`;
}

function caseLabel(item: TestGroupCasePerformance, index: number): string {
  return item.name || `t${index + 1}`;
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 将逐测试完整指标表格序列化为 CSV 文本（含中文表头，Excel 可直接打开）。 */
export function testGroupSummaryCsv(summary: TestGroupPerformanceSummary): string {
  const headers = [
    "测试", "Makespan", "Baseline", "改善", "瓶颈", "利用率", "CPU Time",
    "产能", "出站 CV", "加工腔驻留均值", "机器手驻留均值",
    "系统停留均值", "系统停留 CV", "校验",
  ];
  const rows = summary.cases.map((item, index) => [
    caseLabel(item, index),
    finiteText(item.makespan, 2, " s"),
    finiteText(item.baselineMakespan, 2, " s"),
    item.improvementPercent === null
      ? "—"
      : `${item.improvementPercent > 0 ? "+" : ""}${item.improvementPercent.toFixed(2)}%`,
    `${item.bottleneckResource || "—"}${item.bottleneckCandidateCount > 1 ? ` +${item.bottleneckCandidateCount - 1} 个候选` : ""}`,
    percentText(item.bottleneckUtilization, true),
    durationText(item.cpuTimeMs),
    finiteText(item.throughputPerHour, 1, " 片/h"),
    finiteText(item.departureIntervalCv, 2),
    finiteText(item.processChamberDwellMeanSeconds, 2, " s"),
    finiteText(item.robotWaferDwellMeanSeconds, 2, " s"),
    finiteText(item.waferSystemResidenceMeanSeconds, 2, " s"),
    finiteText(item.waferSystemResidenceCv, 2),
    item.validationPassed ? "通过" : (item.validation || item.status || "—"),
  ].map(csvEscape));
  return [headers.map(csvEscape).join(","), ...rows.map(row => row.join(","))].join("\r\n");
}

function resultTable(summary: TestGroupPerformanceSummary, selected: Set<string>): string {
  return summary.cases.map((item, index) => {
    const cells = [`<th scope="row">${escapeHtml(caseLabel(item, index))}</th>`];
    if (selected.has("makespan")) {
      cells.push(`<td>${finiteText(item.makespan, 2, " s")}</td>`);
      cells.push(`<td>${item.id === summary.referenceCaseId
        ? '<span class="group-reference">参考</span>'
        : item.referenceDeltas?.makespan?.percent === undefined
          ? "—"
          : item.referenceComparable
            ? `${item.referenceDeltas.makespan.percent > 0 ? "+" : ""}${item.referenceDeltas.makespan.percent.toFixed(2)}%`
            : '<span title="运行配置不同，只并列展示数值">仅观察</span>'}</td>`);
    }
    if (selected.has("baseline_improvement")) {
      cells.push(`<td>${finiteText(item.baselineMakespan, 2, " s")}</td>`);
      cells.push(`<td class="${(item.improvementPercent ?? 0) < 0 ? "loss" : "gain"}">${item.improvementPercent === null ? "—" : `${item.improvementPercent > 0 ? "+" : ""}${item.improvementPercent.toFixed(2)}%`}</td>`);
    }
    if (selected.has("bottleneck_candidates")) cells.push(`<td>${escapeHtml(item.bottleneckResource || "—")}${item.bottleneckCandidateCount > 1 ? ` <small>+${item.bottleneckCandidateCount - 1} 个候选</small>` : ""}</td>`);
    if (selected.has("resource_utilization")) cells.push(`<td>${percentText(item.bottleneckUtilization, true)}</td>`);
    if (selected.has("cpu_time")) cells.push(`<td>${durationText(item.cpuTimeMs)}</td>`);
    if (selected.has("average_recompute_time")) cells.push(`<td>${durationText(item.averageRecomputeTimeMs ?? null)}</td>`);
    if (selected.has("throughput")) cells.push(`<td>${finiteText(item.throughputPerHour, 1, " 片/h")}</td>`);
    if (selected.has("departure_interval_cv")) cells.push(`<td>${finiteText(item.departureIntervalCv, 2)}</td>`);
    if (selected.has("process_chamber_dwell")) cells.push(`<td>${finiteText(item.processChamberDwellMeanSeconds, 2, " s")}</td>`);
    if (selected.has("robot_wafer_dwell")) cells.push(`<td>${finiteText(item.robotWaferDwellMeanSeconds, 2, " s")}</td>`);
    if (selected.has("system_residence")) cells.push(`<td>${finiteText(item.waferSystemResidenceMeanSeconds, 2, " s")}</td>`);
    if (selected.has("system_residence_cv")) cells.push(`<td>${finiteText(item.waferSystemResidenceCv, 2)}</td>`);
    if (selected.has("loadlock_wafers_per_cycle")) cells.push(`<td>${finiteText(item.loadLockWafersPerCycle, 2, " 片")}</td>`);
    if (selected.has("loadlock_full_cycle_ratio")) cells.push(`<td>${percentText(item.loadLockFullCycleRatio, true)}</td>`);
    if (selected.has("loadlock_empty_cycle_ratio")) cells.push(`<td>${percentText(item.loadLockEmptyCycleRatio, true)}</td>`);
    if (selected.has("validation")) cells.push(`<td>${item.analysisStatus && item.analysisStatus !== "completed"
      ? `<span class="group-fail">${escapeHtml(item.error || item.analysisStatus)}</span>`
      : item.validationPassed ? '<span class="group-pass">通过</span>' : `<span class="group-fail">${escapeHtml(item.validation || item.status)}</span>`}</td>`);
    const rowClasses = [
      item.id === summary.referenceCaseId ? "is-reference" : "",
      item.analysisStatus && item.analysisStatus !== "completed" ? "is-incomplete" : "",
    ].filter(Boolean).join(" ");
    return `<tr${rowClasses ? ` class="${rowClasses}"` : ""}>${cells.join("")}</tr>`;
  }).join("");
}

/** 绘制测试组的多维结果分析，不生成跨量纲综合分数。 */
export function renderTestGroupAnalysis(
  summary: TestGroupPerformanceSummary,
  groupName: string,
): string {
  const selected = new Set(summary.selectedMetricIds ?? [
    "validation", "makespan", "baseline_improvement", "cpu_time", "throughput",
    "departure_interval_cv", "process_chamber_dwell", "robot_wafer_dwell",
    "system_residence", "system_residence_cv", "resource_utilization", "bottleneck_candidates",
  ]);
  const reference = summary.cases.find(item => item.id === summary.referenceCaseId);
  const selectedLabels: Record<string, string> = {
    validation: "校验结果", makespan: "Makespan", baseline_improvement: "Baseline 改善",
    cpu_time: "CPU Time", average_recompute_time: "平均重算时间", throughput: "产能",
    departure_interval_cv: "出站间隔 CV", process_chamber_dwell: "加工腔驻留",
    robot_wafer_dwell: "机器手驻留", system_residence: "系统停留",
    system_residence_cv: "系统停留 CV", resource_utilization: "资源利用率",
    bottleneck_candidates: "瓶颈候选", loadlock_wafers_per_cycle: "LoadLock 每周期晶圆",
    loadlock_full_cycle_ratio: "LoadLock 满载周期率", loadlock_empty_cycle_ratio: "LoadLock 空载周期率",
  };
  const tableHeaders = ["<th>测试</th>"];
  if (selected.has("makespan")) tableHeaders.push("<th>Makespan</th>", "<th>相对参考</th>");
  if (selected.has("baseline_improvement")) tableHeaders.push("<th>Baseline</th>", "<th>改善</th>");
  if (selected.has("bottleneck_candidates")) tableHeaders.push("<th>瓶颈</th>");
  if (selected.has("resource_utilization")) tableHeaders.push("<th>利用率</th>");
  if (selected.has("cpu_time")) tableHeaders.push("<th>CPU Time</th>");
  if (selected.has("average_recompute_time")) tableHeaders.push("<th>平均重算时间</th>");
  if (selected.has("throughput")) tableHeaders.push("<th>产能</th>");
  if (selected.has("departure_interval_cv")) tableHeaders.push("<th>出站 CV</th>");
  if (selected.has("process_chamber_dwell")) tableHeaders.push("<th>加工腔驻留均值</th>");
  if (selected.has("robot_wafer_dwell")) tableHeaders.push("<th>机器手驻留均值</th>");
  if (selected.has("system_residence")) tableHeaders.push("<th>系统停留均值</th>");
  if (selected.has("system_residence_cv")) tableHeaders.push("<th>系统停留 CV</th>");
  if (selected.has("loadlock_wafers_per_cycle")) tableHeaders.push("<th>LoadLock 每周期晶圆</th>");
  if (selected.has("loadlock_full_cycle_ratio")) tableHeaders.push("<th>LoadLock 满载周期率</th>");
  if (selected.has("loadlock_empty_cycle_ratio")) tableHeaders.push("<th>LoadLock 空载周期率</th>");
  if (selected.has("validation")) tableHeaders.push("<th>校验</th>");
  return `
    <div class="group-analysis-head">
      <div><h2>${escapeHtml(groupName || "当前测试组")}</h2><p>参考测试：${escapeHtml(reference?.name || "首个测试")} · ${summary.cacheHitCount ?? 0} 项命中缓存</p></div>
      <button class="btn small" type="button" data-reconfigure-analysis>重新选择指标与测试</button>
    </div>
    <div class="group-analysis-selection">${[...selected].map(metric => `<span>${escapeHtml(selectedLabels[metric] || metric)}</span>`).join("")}</div>
    ${summary.timedOut ? '<div class="group-analysis-warning">已达到时间预算，以下报告保留完成部分；可减少指标或提高时间预算后继续。</div>' : ""}
    <section class="group-analysis-table-wrap">
      <div class="group-analysis-table-head"><div><strong>逐测试指标对比</strong><small>${summary.cases.length} 个测试 · ${selected.size} 项指标 · 参考项已高亮</small></div><button type="button" class="btn small group-analysis-export" data-group-export-csv>导出 CSV</button></div>
      <div class="group-analysis-table-scroll">
        <table class="group-analysis-table">
          <caption class="sr-only">${escapeHtml(groupName || "当前测试组")}逐测试指标对比</caption>
          <thead><tr>${tableHeaders.join("")}</tr></thead>
          <tbody>${resultTable(summary, selected)}</tbody>
        </table>
      </div>
    </section>`;
}
