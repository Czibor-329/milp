# 调度平台架构

## 目标

调度平台采用服务端主导的三层结构：

```text
浏览器（编辑 / 回放 / 展示）
          │ JSON HTTP API
          ▼
服务端（应用编排 / 分析 / 调度入口）
          │
          ├── 工作区与结果存储（data/、exports/）
          └── 独立算法仓库（alg/）
```

浏览器不再承担分析责任，也不负责业务数据的持久化。浏览器内的 `state` 只是
当前页面的临时编辑草稿；保存、运行、结果和日志都由服务端 API 完成。

## 目录职责

| 目录 | 职责 | 不负责 |
| --- | --- | --- |
| `realtime_scheduler/frontend/src/` | 表单交互、回放投影、HTML/CSS 呈现、API 客户端 | 指标计算、瓶颈判断、结果持久化 |
| `realtime_scheduler/backend/analysis.py` | MoveList 性能、瓶颈、诊断、测试组汇总 | HTTP、DOM、文件读写 |
| `realtime_scheduler/plan_builder.py` | 将编辑模型展开为标准算法请求 | 算法决策、页面状态 |
| `realtime_scheduler/algorithm_interface.py` | 发现和调用独立算法包 | 工作区和页面渲染 |
| `realtime_scheduler/batch_service.py` | 批量运行、Baseline、并发状态 | HTML、浏览器存储 |
| `realtime_scheduler/server.py` | 组合现有应用服务并暴露 HTTP API | 页面分析逻辑 |
| `realtime_scheduler/data/` | 设备、共享 Route/Clean、测试集 | 浏览器缓存 |
| `realtime_scheduler/exports/` | MoveList 结果和复现日志 | 前端临时状态 |

`realtime_scheduler/analysis/` 中的 TypeScript/JavaScript 只用于旧 Node 回归测试
入口，生产构建不再导入它。新功能必须在 `backend/analysis.py` 中实现，并通过
HTTP 契约提供给前端。

## 分析 API

### `POST /api/analysis/schedule`

请求可以引用服务端已保存的结果：

```json
{
  "resultId": "result-id",
  "device": {},
  "windowMode": "steady",
  "routes": [],
  "rounds": []
}
```

也可以直接提交一次性 MoveList（例如用户导入本地文件）：

```json
{
  "moves": [{ "MoveType": 0, "StartTime": 0, "EndTime": 1 }],
  "device": {},
  "windowMode": "full"
}
```

服务端返回 `analysis` 和可用于结果卡片的 `bottleneck` 摘要。工序容量上下文由
服务端根据 `routes`/`rounds` 构建，前端不会复制这套规则。

### `POST /api/analysis/test-group`

请求体为结果案例数组，服务端统一计算胜/平/退化、CPU 分位数、瓶颈频次和吞吐
指标，返回完整组级摘要。

## 数据流约束

1. 前端编辑后通过 `/api/workspaces/*` 保存测试集，不能直接写 `data/` 或 `exports/`。
2. 调度运行由 `/api/run`、`/api/run-batch` 触发，结果由服务端写入 `exports/results/`。
3. 前端读取结果只使用 `/api/results/*`；分析只使用 `/api/analysis/*`。
4. 新增指标必须先补后端分析函数和 API 回归测试，再增加前端展示。
