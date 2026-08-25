/** 独立生产指标卡片与 CSV 导出；不依赖现有结果分析的渲染函数。 */

import type { ProductionMetricsResult } from "./contracts";

const PRODUCTION_METRIC_STYLE_ID = "production-metrics-module-styles";

function productionEscapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function productionMetricNumberText(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}

function productionMetricPercentText(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
}

function productionMetricChamberLabel(chamber: ProductionMetricsResult["chambers"][number]): string {
  const details = [chamber.stepId ? `工序 ${chamber.stepId}` : "", chamber.recipe].filter(Boolean);
  return details.length ? `${chamber.chamber} · ${details.join(" · ")}` : chamber.chamber;
}

/** 注入模块自带样式，复制整个文件夹时无需同步主站 CSS。 */
export function ensureProductionMetricsStyles(root: Document = document): void {
  if (
    typeof root.createElement !== "function"
    || !root.head
    || typeof root.head.append !== "function"
  ) return;
  if (root.getElementById(PRODUCTION_METRIC_STYLE_ID)) return;
  const style = root.createElement("style");
  style.id = PRODUCTION_METRIC_STYLE_ID;
  style.textContent = `
    .production-metrics-module{display:grid;gap:16px;margin-top:16px;--pm-accent:#0f766e;--pm-ink:#102a2a;--pm-muted:#607272;--pm-line:#d6e4e2;--pm-soft:#f0fdfa}
    .production-metrics-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;border:1px solid var(--pm-line);border-radius:14px;background:linear-gradient(135deg,#f0fdfa 0%,#fff 72%);box-shadow:0 5px 18px rgba(15,118,110,.08)}
    .production-metrics-title{display:grid;gap:4px}.production-metrics-title strong{color:var(--pm-ink);font-size:16px}.production-metrics-title small{color:var(--pm-muted);line-height:1.5}
    .production-metrics-actions{display:flex;align-items:center;gap:10px}.production-metrics-badge{display:inline-flex;align-items:center;min-height:28px;padding:0 10px;border:1px solid #99d5cc;border-radius:999px;background:#fff;color:var(--pm-accent);font-size:12px;font-weight:800;white-space:nowrap}
    .production-metrics-export{min-height:34px;padding:0 14px;border:1px solid var(--pm-accent);border-radius:9px;background:var(--pm-accent);color:#fff;font:inherit;font-size:13px;font-weight:800;cursor:pointer}.production-metrics-export:hover{filter:brightness(.96)}.production-metrics-export:focus-visible{outline:3px solid rgba(20,184,166,.3);outline-offset:2px}
    .production-metrics-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.production-metric-card{min-width:0;overflow:hidden;border:1px solid var(--pm-line);border-radius:14px;background:#fff;box-shadow:0 5px 18px rgba(15,23,42,.05)}
    .production-metric-card.wide{grid-column:1/-1}.production-metric-card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #e7efee;background:#fbfefd}.production-metric-card>header strong{color:var(--pm-ink);font-size:14px}.production-metric-card>header small{color:var(--pm-muted);line-height:1.45;text-align:right}
    .production-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.production-kpi{min-width:0;padding:18px;border-left:1px solid #e7efee}.production-kpi:first-child{border-left:0}.production-kpi span,.production-kpi strong,.production-kpi small{display:block}.production-kpi span{color:var(--pm-muted);font-size:12px;font-weight:800}.production-kpi strong{margin-top:6px;color:var(--pm-ink);font-size:23px;line-height:1.25}.production-kpi small{margin-top:6px;color:var(--pm-muted);font-size:12px;line-height:1.5}
    .production-metric-note{margin:0;padding:18px;color:var(--pm-muted);font-size:13px;line-height:1.65}.production-metric-table-wrap{overflow:auto}.production-metric-table{width:100%;border-collapse:collapse;font-size:12px}.production-metric-table th,.production-metric-table td{padding:12px 14px;border-bottom:1px solid #edf2f1;text-align:right;white-space:nowrap}.production-metric-table th:first-child,.production-metric-table td:first-child{text-align:left}.production-metric-table th{background:#fbfefd;color:var(--pm-muted);font-weight:800}.production-metric-table td{color:var(--pm-ink)}
    .production-utilization-list{display:grid;gap:12px;margin:0;padding:16px 18px;list-style:none}.production-utilization-row{display:grid;grid-template-columns:minmax(90px,1fr) minmax(120px,3fr) 62px;align-items:center;gap:12px}.production-utilization-row strong{overflow:hidden;color:var(--pm-ink);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.production-utilization-track{height:9px;overflow:hidden;border-radius:999px;background:#e6efed}.production-utilization-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#14b8a6,#0f766e)}.production-utilization-row span{color:var(--pm-muted);font-size:12px;text-align:right}
    @media(max-width:760px){.production-metrics-head{align-items:stretch;flex-direction:column}.production-metrics-actions{justify-content:space-between}.production-metrics-grid{grid-template-columns:1fr}.production-kpis{grid-template-columns:1fr}.production-kpi{border-top:1px solid #e7efee;border-left:0}.production-kpi:first-child{border-top:0}.production-metric-card>header{flex-direction:column}.production-metric-card>header small{text-align:left}.production-utilization-row{grid-template-columns:minmax(80px,1fr) minmax(100px,2fr) 54px}}
  `;
  root.head.append(style);
}

/** 渲染与旧指标物理分隔的新指标模块。 */
export function renderProductionMetrics(metrics: ProductionMetricsResult): string {
  const config = metrics.configuration;
  const sample = metrics.sampleWindow;
  const unavailableReason = metrics.overall.reason || metrics.applicability.reason || sample.reason;
  const chamberRows = metrics.chambers.map(chamber => `
    <tr>
      <td>${productionEscapeHtml(productionMetricChamberLabel(chamber))}</td>
      <td>${chamber.waferCount}</td>
      <td>${chamber.k}</td>
      <td>${productionMetricNumberText(chamber.throughputPerHour, 1)}</td>
      <td>${productionMetricNumberText(chamber.entryIntervalStdSeconds, 3)}</td>
      <td>${chamber.surpassWaferCount}</td>
      <td>${productionMetricPercentText(chamber.surpassRate)}</td>
    </tr>`).join("");
  const moduleRows = metrics.modules.slice(0, 12).map(module => `
    <li class="production-utilization-row">
      <strong title="${productionEscapeHtml(module.name)}">${productionEscapeHtml(module.name)}</strong>
      <span class="production-utilization-track" role="img" aria-label="${productionEscapeHtml(module.name)} 利用率 ${productionMetricPercentText(module.utilization)}"><i style="width:${Math.max(0, Math.min(module.utilization, 1)) * 100}%"></i></span>
      <span>${productionMetricPercentText(module.utilization)}</span>
    </li>`).join("");
  const sampleDetail = sample.available
    ? `完工 ${sample.totalCompletedWafers} 片 · 剔除前 ${config.trimmedHeadWafers} 片后固定取 ${config.sampleSize} 片 · 后方至少保留 ${config.trimmedTailWafers} 片`
    : sample.reason;
  return `
    <section class="production-metrics-module" aria-labelledby="productionMetricsTitle">
      <header class="production-metrics-head">
        <div class="production-metrics-title">
          <strong id="productionMetricsTitle">指标导出参数设置 · 独立统计</strong>
          <small>${productionEscapeHtml(sampleDetail)}</small>
        </div>
        <div class="production-metrics-actions">
          <span class="production-metrics-badge">${metrics.applicability.sameRecipeAndPath ? "同 Recipe / 路径" : "指标受限"}</span>
          <button class="production-metrics-export" type="button" data-production-metrics-export>单独导出 CSV</button>
        </div>
      </header>
      <div class="production-metrics-grid">
        <article class="production-metric-card">
          <header><strong>产能与运行</strong><small>与原有 KPI 分开统计</small></header>
          <div class="production-kpis">
            <div class="production-kpi"><span>整体产能</span><strong>${productionMetricNumberText(metrics.overall.throughputPerHour, 1)}</strong><small>片 / 小时 · 固定 N=${config.sampleSize}</small></div>
            <div class="production-kpi"><span>RPT</span><strong>${productionMetricNumberText(metrics.overall.rptMinutes, 2)}</strong><small>分钟 / 片${metrics.overall.parallelChamberCount ? ` · ${metrics.overall.parallelChamberCount} 个并行腔室` : ""}</small></div>
            <div class="production-kpi"><span>计算时间</span><strong>${productionMetricNumberText(metrics.calculationSeconds, 3)}</strong><small>秒</small></div>
          </div>
          ${unavailableReason ? `<p class="production-metric-note">${productionEscapeHtml(unavailableReason)}</p>` : ""}
        </article>
        <article class="production-metric-card">
          <header><strong>模块利用率</strong><small>重叠活动取时间并集，多槽位不重复累计</small></header>
          ${moduleRows ? `<ol class="production-utilization-list">${moduleRows}</ol>` : `<p class="production-metric-note">${productionEscapeHtml(sample.reason || "没有可统计的模块活动。")}</p>`}
        </article>
        <article class="production-metric-card wide">
          <header><strong>腔室产能与进腔质量</strong><small>超片示例：期望 1→2→3，实际 1→3→2，只将晶圆 3 计为 1 片超片</small></header>
          ${chamberRows ? `
            <div class="production-metric-table-wrap"><table class="production-metric-table">
              <thead><tr><th>腔室 / 工序 / Recipe</th><th>晶圆数</th><th>k</th><th>产能（片/h）</th><th>节拍 σ（s）</th><th>超片数</th><th>超片率</th></tr></thead>
              <tbody>${chamberRows}</tbody>
            </table></div>` : `<p class="production-metric-note">${productionEscapeHtml(unavailableReason || "没有可统计的腔室加工记录。")}</p>`}
        </article>
      </div>
    </section>`;
}

function productionMetricCsvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 仅序列化本模块指标，不混入已有分析指标。 */
export function productionMetricsCsv(metrics: ProductionMetricsResult): string {
  const rows: Array<Array<unknown>> = [["类别", "对象", "指标", "数值", "单位", "说明"]];
  const push = (category: string, target: string, metric: string, value: unknown, unit: string, note = "") => {
    rows.push([category, target, metric, value ?? "", unit, note]);
  };
  push("统计口径", "样本", "已完工晶圆数", metrics.sampleWindow.totalCompletedWafers, "片");
  push("统计口径", "样本", "固定样本数 N", metrics.configuration.sampleSize, "片", `剔除前 ${metrics.configuration.trimmedHeadWafers} 片，样本后至少保留 ${metrics.configuration.trimmedTailWafers} 片`);
  push("适用性", "Recipe/路径", "是否一致", metrics.applicability.sameRecipeAndPath ? "是" : "否", "", metrics.applicability.reason);
  push("产能与运行", "整体", "整体产能", metrics.overall.throughputPerHour, "片/h", metrics.overall.reason);
  push("产能与运行", "整体", "RPT", metrics.overall.rptMinutes, "min/片", metrics.overall.reason);
  push("产能与运行", "算法", "计算时间", metrics.calculationSeconds, "s");
  for (const chamber of metrics.chambers) {
    const label = productionMetricChamberLabel(chamber);
    push("腔室", label, "腔室产能", chamber.throughputPerHour, "片/h", `k=${chamber.k}`);
    push("腔室", label, "进腔节拍标准差", chamber.entryIntervalStdSeconds, "s", "std(I_pmi)");
    push("腔室", label, "超片数", chamber.surpassWaferCount, "片");
    push("腔室", label, "超片率", chamber.surpassRate === null ? null : chamber.surpassRate * 100, "%");
  }
  for (const module of metrics.modules) {
    push("模块", module.name, "利用率", module.utilization * 100, "%", `时间并集 ${module.busyTimeSeconds.toFixed(3)} s`);
  }
  return rows.map(row => row.map(productionMetricCsvCell).join(",")).join("\r\n");
}

/** 触发本模块自己的 CSV 下载。 */
export function downloadProductionMetricsCsv(
  metrics: ProductionMetricsResult,
  sourceName = "调度结果",
): void {
  const link = document.createElement("a");
  const safeName = sourceName.replace(/[\\/:*?"<>|]+/g, "-").replace(/\.[^.]+$/, "") || "调度结果";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  link.href = `data:text/csv;charset=utf-8,%EF%BB%BF${encodeURIComponent(productionMetricsCsv(metrics))}`;
  link.download = `新增生产指标-${safeName}-${stamp}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
}
