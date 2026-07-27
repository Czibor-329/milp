import type {
  TestGroupCasePerformance,
  TestGroupPerformanceSummary,
} from "../../analysis/group_performance";

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

function improvementChart(summary: TestGroupPerformanceSummary): string {
  const cases = summary.cases.filter(item => item.improvementPercent !== null);
  const scale = Math.max(
    1,
    ...cases.map(item => Math.abs(item.improvementPercent ?? 0)),
  );
  return cases.map((item, index) => {
    const value = item.improvementPercent ?? 0;
    const width = Math.min(Math.abs(value) / scale * 50, 50);
    const status = value < 0 ? "loss" : value > 0 ? "gain" : "tie";
    return `<div class="group-chart-row">
      <span class="group-chart-label" title="${escapeHtml(item.name)}">${escapeHtml(caseLabel(item, index))}</span>
      <div class="group-diverging-track" role="img" aria-label="${escapeHtml(caseLabel(item, index))} 相对基线 ${value >= 0 ? "提升" : "退化"} ${Math.abs(value).toFixed(2)}%">
        <i class="${status}" style="--bar-width:${width}%"></i>
      </div>
      <strong class="${status}">${value > 0 ? "+" : ""}${value.toFixed(2)}%</strong>
    </div>`;
  }).join("") || '<p class="group-analysis-empty">没有可比较的 Baseline。</p>';
}

function utilizationChart(summary: TestGroupPerformanceSummary): string {
  const rows = summary.cases.flatMap((item, caseIndex) => (
    item.bottleneckCandidates.map((candidate, candidateIndex) => ({
      item,
      caseIndex,
      candidate,
      candidateIndex,
    }))
  ));
  return rows.map(({ item, caseIndex, candidate, candidateIndex }) => {
    const utilization = Math.max(0, Math.min(candidate.utilization, 1));
    const label = candidateIndex === 0
      ? caseLabel(item, caseIndex)
      : `↳ 候选 ${candidateIndex + 1}`;
    return `<div class="group-chart-row ${candidateIndex ? "is-secondary-candidate" : ""}">
      <span class="group-chart-label" title="${escapeHtml(item.name)}">${escapeHtml(label)}</span>
      <div class="group-linear-track" role="img" aria-label="${escapeHtml(caseLabel(item, caseIndex))} 瓶颈候选 ${escapeHtml(candidate.resourceName)}，利用率 ${(utilization * 100).toFixed(1)}%">
        <i class="utilization" style="width:${(utilization * 100).toFixed(2)}%"></i>
      </div>
      <strong>${(utilization * 100).toFixed(1)}%</strong>
      <small title="${escapeHtml(candidate.resourceName)}">${escapeHtml(candidate.resourceName || "—")}</small>
    </div>`;
  }).join("") || '<p class="group-analysis-empty">没有可分析的瓶颈资源。</p>';
}

function cpuChart(summary: TestGroupPerformanceSummary): string {
  const cases = summary.cases.filter(item => item.cpuTimeMs !== null);
  const scale = Math.max(1, ...cases.map(item => item.cpuTimeMs ?? 0));
  return cases.map((item, index) => {
    const cpu = Math.max(item.cpuTimeMs ?? 0, 0);
    return `<div class="group-chart-row">
      <span class="group-chart-label" title="${escapeHtml(item.name)}">${escapeHtml(caseLabel(item, index))}</span>
      <div class="group-linear-track" role="img" aria-label="${escapeHtml(caseLabel(item, index))} CPU Time ${durationText(cpu)}">
        <i class="cpu" style="width:${Math.min(cpu / scale * 100, 100).toFixed(2)}%"></i>
      </div>
      <strong>${escapeHtml(durationText(cpu))}</strong>
    </div>`;
  }).join("") || '<p class="group-analysis-empty">没有 CPU Time 数据。</p>';
}

function resultTable(summary: TestGroupPerformanceSummary): string {
  return summary.cases.map((item, index) => `
    <tr>
      <th scope="row">${escapeHtml(caseLabel(item, index))}</th>
      <td>${finiteText(item.makespan, 2, " s")}</td>
      <td>${finiteText(item.baselineMakespan, 2, " s")}</td>
      <td class="${(item.improvementPercent ?? 0) < 0 ? "loss" : "gain"}">${item.improvementPercent === null ? "—" : `${item.improvementPercent > 0 ? "+" : ""}${item.improvementPercent.toFixed(2)}%`}</td>
      <td>${escapeHtml(item.bottleneckResource || "—")}${item.bottleneckCandidateCount > 1 ? ` <small>+${item.bottleneckCandidateCount - 1} 个候选</small>` : ""}</td>
      <td>${percentText(item.bottleneckUtilization, true)}</td>
      <td>${durationText(item.cpuTimeMs)}</td>
      <td>${finiteText(item.throughputPerHour, 1, " 片/h")}</td>
      <td>${finiteText(item.departureIntervalCv, 2)}</td>
      <td>${finiteText(item.processChamberDwellMeanSeconds, 2, " s")}</td>
      <td>${finiteText(item.robotWaferDwellMeanSeconds, 2, " s")}</td>
      <td>${finiteText(item.waferSystemResidenceMeanSeconds, 2, " s")}</td>
      <td>${finiteText(item.waferSystemResidenceCv, 2)}</td>
      <td>${item.validationPassed ? '<span class="group-pass">通过</span>' : `<span class="group-fail">${escapeHtml(item.validation || item.status)}</span>`}</td>
    </tr>`).join("");
}

/** 绘制测试组的多维结果分析，不生成跨量纲综合分数。 */
export function renderTestGroupAnalysis(
  summary: TestGroupPerformanceSummary,
  groupName: string,
): string {
  const weighted = summary.weightedImprovementPercent;
  const medianImprovement = summary.medianImprovementPercent;
  return `
    <div class="group-analysis-head">
      <h2>${escapeHtml(groupName || "当前测试组")}</h2>
    </div>
    <div class="group-kpi-grid">
      <article><span>校验通过率</span><strong>${(summary.validationPassRate * 100).toFixed(1)}%</strong><small>${summary.validationPassedCount}/${summary.succeededCount} 个有效结果</small></article>
      <article><span>加权总体改善</span><strong class="${(weighted ?? 0) < 0 ? "loss" : "gain"}">${weighted === null ? "—" : `${weighted > 0 ? "+" : ""}${weighted.toFixed(2)}%`}</strong><small>按各测试 Baseline makespan 加权</small></article>
      <article><span>逐例中位改善</span><strong class="${(medianImprovement ?? 0) < 0 ? "loss" : "gain"}">${medianImprovement === null ? "—" : `${medianImprovement > 0 ? "+" : ""}${medianImprovement.toFixed(2)}%`}</strong><small>${summary.winCount} 胜 · ${summary.tieCount} 平 · ${summary.regressionCount} 退化</small></article>
      <article><span>CPU Time</span><strong>${durationText(summary.medianCpuTimeMs)}</strong><small>P90 ${durationText(summary.p90CpuTimeMs)} · 总计 ${durationText(summary.totalCpuTimeMs)}</small></article>
      <article><span>主要候选利用率中位数</span><strong>${percentText(summary.medianBottleneckUtilization, true)}</strong><small>工序组、机器人或 LoadLock 容量</small></article>
      <article><span>出站表现中位数</span><strong>${finiteText(summary.medianThroughputPerHour, 1, " 片/h")}</strong><small>间隔波动 CV ${finiteText(summary.medianDepartureIntervalCv, 2)}</small></article>
      <article><span>加工腔驻留均值中位数</span><strong>${finiteText(summary.medianProcessChamberDwellMeanSeconds, 2, " s")}</strong><small>各测试“加工结束 → 完全离腔”均值的中位数</small></article>
      <article><span>机器手驻留均值中位数</span><strong>${finiteText(summary.medianRobotWaferDwellMeanSeconds, 2, " s")}</strong><small>已剔除显式 PreTrans 运输区间</small></article>
      <article><span>系统停留均值中位数</span><strong>${finiteText(summary.medianWaferSystemResidenceMeanSeconds, 2, " s")}</strong><small>离开 LP → 返回 LP · CV 中位 ${finiteText(summary.medianWaferSystemResidenceCv, 2)}</small></article>
    </div>
    <div class="group-chart-grid">
      <article class="group-chart-card">
        <header><div><h3>相对 Baseline</h3><p>正值为 makespan 改善，负值为退化</p></div></header>
        <div class="group-chart-body">${improvementChart(summary)}</div>
      </article>
      <article class="group-chart-card">
        <header><div><h3>所有瓶颈候选利用率</h3><p>每个测试按可能性依次显示所有接近候选</p></div></header>
        <div class="group-chart-body">${utilizationChart(summary)}</div>
      </article>
      <article class="group-chart-card">
        <header><div><h3>计算时间</h3><p>各测试算法 CPU Time，按组内最大值缩放</p></div></header>
        <div class="group-chart-body">${cpuChart(summary)}</div>
      </article>
    </div>
    <details class="group-analysis-table-wrap">
      <summary>查看逐测试完整指标</summary>
      <div class="group-analysis-table-scroll">
        <table class="group-analysis-table">
          <thead><tr><th>测试</th><th>Makespan</th><th>Baseline</th><th>改善</th><th>瓶颈</th><th>利用率</th><th>CPU Time</th><th>吞吐</th><th>出站 CV</th><th>加工腔驻留均值</th><th>机器手驻留均值</th><th>系统停留均值</th><th>系统停留 CV</th><th>校验</th></tr></thead>
          <tbody>${resultTable(summary)}</tbody>
        </table>
      </div>
    </details>`;
}
