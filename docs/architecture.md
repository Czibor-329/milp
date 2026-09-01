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
| `realtime_scheduler/backend/api/` | HTTP 请求、静态资源和文档 API | 调度决策、文件布局 |
| `realtime_scheduler/backend/execution/` | 计划构建、算法运行、实时重算、CJob Cycle 和批量运行 | HTTP、页面渲染 |
| `realtime_scheduler/backend/workspace/` | v7 存储、迁移和设备/测试业务操作 | 算法决策、前端状态 |
| `realtime_scheduler/backend/workspace/catalog_service.py` | 设备、Route、测试组和测试集目录业务 | 交换包格式、后台传输任务 |
| `realtime_scheduler/backend/workspace/exchange_service.py` | 交换包编解码和设备/测试导入导出规则 | 后台任务状态、普通 CRUD |
| `realtime_scheduler/backend/workspace/transfer_jobs.py` | 导入导出后台任务、进度状态和制品下载 | 交换包格式、普通 CRUD |
| `realtime_scheduler/backend/artifacts/` | 结果、复现日志和 Baseline 持久化 | 设备主数据 |
| `realtime_scheduler/backend/validation/` | 平台状态回放和 HongYe 校验会话 | 调度策略选择 |
| `realtime_scheduler/backend/algorithms/` | 发现和调用独立标准算法包 | 工作区和页面渲染 |
| `realtime_scheduler/backend/analysis.py` | MoveList 性能、瓶颈、诊断、测试组汇总 | HTTP、DOM、文件读写 |
| `realtime_scheduler/backend/main.py` | 命令行参数、启动检查和 HTTP 服务生命周期 | 业务实现、存储、调度和校验 |
| `realtime_scheduler/data/datasets/` | 设备 init、共享路径模板、测试独有的 Route 参数/Clean 与任务的唯一主数据 | 浏览器缓存、设备镜像 |
| `realtime_scheduler/exports/` | MoveList 结果和复现日志 | 前端临时状态 |

MoveList 指标、瓶颈和测试组统计只在 `backend/analysis.py` 中实现；前端通过 HTTP
契约请求结果，不保留兼容计算副本。

后端依赖方向固定为 HTTP → 应用装配 → execution/workspace/artifacts →
validation/algorithm interface。后端和仓库脚本必须直接导入 `realtime_scheduler.backend`
下的正式模块，根包不保留历史兼容模块。运行时 Python
文件以 2000 行为硬上限，达到 1500 行时应复核是否混入第二项独立职责。

## 后端终端日志

默认终端显示启动、Baseline、算法和校验等业务阶段，浏览器轮询产生的逐条 HTTP
访问日志默认关闭。`--log-level DEBUG` 可提高详细度，显式传入 `--access-log` 才显示
HTTP 请求。批量运行会输出测试 ID、校验状态、Move 数量和 makespan。

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
5. 共享路径模板只保存 Step 和候选腔室；每个 PJob 的 `routeConfig` 保存自己的
   时间、QTime、驻留、Buffer 与 Clean 引用。运行前由服务端或前端把该配置合并到
   模板副本并生成唯一 Route/Recipe 实例，不能把测试参数写回模板，也不能按模板名
   在多个 PJob 之间共享可变参数。顶层 `routeConfigs` 仅用于兼容 v6 数据和新实例默认值。
6. 服务启动时必须先完成工作区迁移与重复模板清理，再创建 HTTP 监听器；迁移过程
   需要同步全部测试的 `routeRef` 和 `routeConfigs`，有参数冲突时不得强制合并。拆分目录
   必须持久化迁移版本，当前版本且数据文件未更新时不得重复执行启动迁移。
7. 用户通过前端导入/导出交换设备或测试集；浏览器和用户均不得直接操作
   `data/datasets/`。测试集导入必须校验目标设备 init 指纹并安全合并引用路径。
8. 正常运行期间，设备列表只读取设备元数据和测试摘要索引，设备概览不得解析完整
   `test.json`，单测试读写只触碰目标测试及必要索引。完整目录扫描只允许出现在启动
   迁移、显式全库维护或确实需要跨测试同步的操作中。
9. 设备和测试集交换通过 `/api/workspace-transfers` 创建进程内后台任务；前端轮询任务
   状态并在导出完成后下载归档。当前目录格式的整设备导出只压缩目标设备文件，导入
   只合并目标设备和对应测试摘要索引，不得退化为全工作区读写。
