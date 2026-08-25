# 生产指标统计模块

这个文件夹是一套可独立拷贝的 MoveList 指标模块。后端计算只依赖 Python
标准库；`contracts.ts`、`view.ts` 提供前端类型、独立卡片和 CSV 导出。

## 本版指标

- 整体产能：固定选取 120 片，使用 `3600 × 120 / T`。
- 腔室产能：`3600 × k / (ST[n] - ST[n-k])`，`k` 为实际间隔数。
- 模块利用率：统计窗口内所有活动区间的时间并集除以窗口时长；多槽位重叠不重复累计。
- 进腔节拍一致性：进腔时间间隔集合 `I_pmi` 的总体标准差。
- 腔室超片率：后序晶圆先于仍未进腔的前序晶圆开始加工，则该后序晶圆记为一片超片；例如期望 `1,2,3`，实际 `1,3,2`，超片数为 1；超片率为超片晶圆数除以该腔室加工晶圆总数。
- RPT：仅对单工艺节点并行腔室路径计算，`60 / (整体 WPH / 并行腔室数)`。
- 计算时间：由调用方通过 `calculation_seconds` 传入。

阶梯产能和片间腔室利用率不在本版范围内。

## 固定统计口径

- 至少需要 150 片已完工晶圆。
- 按完工顺序剔除前 15 片，固定选取随后 120 片；因此样本之后至少还保留 15 片作为收尾排除量。
- 选中晶圆必须具有相同 Recipe 和路径；不满足时不计算产能、RPT、节拍一致性和超片率。
- 模块利用率对多槽位并发活动取时间并集，不重复累计。

## Python 使用

```python
from production_metrics import calculate_production_metrics

result = calculate_production_metrics(
    moves=move_list,
    device=device,
    context=analysis_context,
    calculation_seconds=0.83,
)
```

返回值是可直接 JSON 序列化的 `production-metrics-v1` 字典。

## 前端使用

```ts
import {
  downloadProductionMetricsCsv,
  ensureProductionMetricsStyles,
  renderProductionMetrics,
} from "./production_metrics/view";

ensureProductionMetricsStyles(document);
container.innerHTML = renderProductionMetrics(result.productionMetrics);
downloadButton.onclick = () => downloadProductionMetricsCsv(result.productionMetrics);
```

`view.ts` 的样式随模块注入，不依赖当前项目的全局 CSS。对接现有系统时，只需让
后端返回 `productionMetrics`，再在结果页调用上述渲染和导出函数；原有指标不需要迁移
到这个目录。
