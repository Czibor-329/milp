# 调度平台

此目录集中保存实时调度平台的前端、服务端和本地数据：

- `backend/main.py`：后端命令行启动入口。
- `backend/api/`：HTTP、静态资源与文档边界。
- `backend/execution/`：计划构建、算法运行、实时重算、CJob Cycle 与批量执行。
- `backend/workspace/`：数据集存储、迁移与设备/测试业务操作。
- `backend/workspace/catalog_service.py`：设备、Route、测试组和测试集目录业务。
- `backend/workspace/exchange_service.py`：设备/测试交换包编解码与导入导出规则。
- `backend/workspace/transfer_jobs.py`：导入导出后台任务、进度状态和制品下载。
- `backend/artifacts/`：运行结果、复现日志与 Baseline。
- `backend/validation/`：平台 MoveList 回放与 HongYe 进程会话。
- `backend/analysis.py`：服务端唯一的 MoveList 性能、瓶颈和测试组分析实现。
- 内置 `heuristic/loadlock-macro/e2e-ctq/dual-actor-e2e`：统一调用独立算法仓库
  `alg/src/api.py` 的 `init/update`，`update` 的可选 `algorithm`
  参数决定算法。
- `backend/execution/batch_service.py`：批量运行、Heuristic Baseline、并发进度与取消状态。
- `backend/execution/plan_builder.py`：设备归一化、Route/Recipe 和各轮 CJob/PJob 请求建模。
- `frontend/config_editor.html`：只保存调度平台的页面骨架。
- `frontend/src/`：TypeScript 前端源码，按 API、数据模型、Route 逻辑和页面入口拆分。
- `frontend/src/workspace_visualizer.ts`：MoveList 回放、腔室门状态与设备工作台；性能指标通过 `/api/analysis/*` 获取。
- `frontend/assets/`：可由 Python 服务直接托管的构建产物与样式。
- `frontend/movelist_gantt_viewer.html`：MoveList 甘特图页面。
- `data/datasets/`：设备、共享路径模板和测试集的唯一主数据；用户只通过前端导入/导出，不直接操作目录。
- `exports/logs/`：每次运行生成的 input_data 复现日志。
- `exports/results/`：每次运行生成的统一 MoveList 与重算点。

默认从父仓库的 `alg/` 加载完整算法仓库；也可用 `CT_ALGORITHM_ROOT`
指向其他位置。完整算法仓库是可选依赖：缺席时服务和工作区仍可启动，
内置策略在健康检查中标记为不可用。

独立交付的标准算法包只从算法仓库的 `other_alg/` 子目录加载。可以用
`CT_ALGORITHM_ROOT` 整体调整算法仓库位置，但不能另行指定策略目录。
算法输出返回平台后，多轮重算、现场快照和 MoveList 校验统一由平台本地状态机
根据 `MoveStates/RemoveList` 维护；无论本地完整算法仓库是否存在，都不会调用
`src.schedule.core`、`Machine` 或算法动作实现参与校验。
跨代重算会用新一代的 Route、Recipe 与 WAC 触发规则刷新校验元数据，但 PM 的
`StateVariables`、清洗计数和在机物料属于持续运行状态，必须原样保留，不能被新
一代初始化数据覆盖。

完整开发环境启动：

`alg\.venv\Scripts\python.exe -m realtime_scheduler.backend.main --port 8765 --open`

## 前端开发

部署和运行仍然只依赖 Python；仓库已经保存构建后的浏览器资源。修改调度平台前端时，
在 `realtime_scheduler/frontend` 下执行：

```powershell
npm install
npm run check
npm run build
```

`npm run check` 检查独立 TypeScript 业务模块，`npm run build` 更新
`assets/config_editor.js`，并生成供 Node 单元测试使用的 `route_editor_logic.js`
与 `workspace_visualizer_logic.js`。

每次修改前端都必须递增 `frontend/package.json` 和 `package-lock.json` 中的版本号，
并同步页面右上角显示版本及 CSS/JavaScript 资源查询版本。

调度平台中的“结果分析”可直接载入当前运行结果、批处理结果或本地 MoveList JSON。
结果分析支持拖动时间轴和按倍率播放，并根据 Prepare/Complete 动作显示腔室门的关闭、
正在开门、开启与正在关门状态。

## 运行策略

- `启发式`：使用默认实时排程器。
- `LoadLock 管理器`：Heuristic 默认共用 Petri-ETA 管理器；上层策略只决定发哪片和工艺顺序，管理器在 Petri 安全候选内按动态完成时刻绑定 LA/LB。
- `other_alg 标准算法`：自动扫描算法仓库 `alg/other_alg/<算法名>`，通过包内正式 `CT.infer.scheduler.init/update`（或公司端 `src.infer.scheduler.init/update` 布局）入口运行。每次重算前由平台状态机生成全量物料、机台、机器人快照以及 `RemoveList`，支持连续多轮重算；结果中的 `updates` 保留每次实际发送的数据。
- 外部策略只通过扫描 `alg/other_alg/<算法名>` 检测，不支持在前端上传或直接导入算法文件。
- 输出校验默认开启并默认选择 `HongYe Check（推荐）`：平台在每次状态推进时
  先用自己的 MoveList 状态机执行一次校验，再完整记录 `AlgInit`、
  `AlgSchedule`、`AlgUpdateMove`、`AlgOutput` 日志，交给原始
  CheckMinLog/`MoveStateSim.exe` 的 `module-parallel` 校验入口作为二次校验；
  取消 HongYe 后仍会保留平台状态推进校验。开始运行区域的“兼容模式”默认勾选，
  平台按 HongYe `module-parallel` 规则让各 Module 并行推进、同 Module 串行推进，
  Move 等待其本代 `PreMoveID` 实际结束后才开始；缺失的开关门动作会按设备语义
  自动补齐。所有算法都会把实际推进通知记录为 `AlgUpdateMove`。

本地算法列表不在前端写死，而是由算法仓库根目录的 `algorithms.json` 控制。
服务会在每次健康检查时重读清单；配置中的算法还必须存在于
`src.api.SUPPORTED_ALGORITHMS`，并满足 `requiredFiles`，才能在页面中启用。

内置算法与 `other_alg` 现在共用同一套标准 update 数据流。内置入口示例：

```python
from src.api import init, update

init(topo_data_json)
output_json = update(tool_json, algorithm="heuristic")
```

同一次 `init` 后不能在连续 update 之间切换算法；切换前需重新初始化设备。

标准算法目录可保留打包后的 `CT/infer/scheduler.py` 结构，也可以直接包含
`infer/scheduler.py`、`ropn_sa/` 和 `config/`，或按公司端约定提供
`src/infer/scheduler.py` 入口（入口转发文件内使用 `src.infer.function`
绝对导入或 `from .function` 相对导入均可）。前端健康检查会动态返回所有有效算法包，
默认无需额外配置；算法仓库不在 `alg/` 时设置 `CT_ALGORITHM_ROOT`。

测试组别作为设备下的独立数据保存，允许先创建空组，再在当前组内新建或复制测试；仅当旧测试实际尚未归组时，页面才显示“未分组”，无需为每台设备保留空的默认组。

路径配置只维护 Step 与候选腔室拓扑。加工时间、QTime、驻留、Buffer 和 Clean
在“运行计划”中为具体 PJob 选择路径模板后配置；这些参数随 PJob 路径实例保存，
同一测试内引用相同模板的多个 CJob/PJob 也互不影响，并且不会回写共享模板。
平台物理状态回放会把 Place 到 PM、Aligner 或 LoadLock 的物料保留为待服务状态；
Place 到 Buffer、LoadPort 或 DummyPort 的物料则直接进入可再次 Pick 的完成态。
Buffer 不执行 ProcessMove；同一片 Dummy 也能在复合清洁路径中安全返回库存并由后续
PJob 继续复用。
旧工作区首次由新版服务读取时会先把原共享 Route 的参数复制到各测试，再将共享 Route
收敛为模板，并安全合并拓扑相同的重复模板；同一测试存在冲突参数时会保留原模板，
避免静默改变已有排程。拆分工作区会保存迁移版本标记；仅在版本变化、旧库待迁移或检测到
外部更新文件时执行数据整理，后续启动直接跳过。服务完成必要迁移和算法预热后才开始监听
并打开网页，因此升级不需要手工重建已有测试，也不会让页面读到迁移中的数据。

运行页可选择任意可用策略后点击“批量运行当前组”。弹窗支持按原测试顺序逐项勾选、
输入起止序号选择连续范围，或直接全量运行。“运行设置”可把算法并行数配置为 1~30，
并把 HongYe 校验并行数配置为 1~15；所有测试及自动补算的 Heuristic Baseline 共享
同一校验配额，避免 MoveStateSim 的高内存占用随算法 worker 数一起增长。8 项及以上
使用配置数量的隔离进程，避免算法全局会话状态把并发退化为串行。页面每秒更新总体进度，
运行设置的四个开关与两个并发数会原子保存到本地 `data/run_preferences.json`，刷新页面
或重启服务后自动恢复；该文件不属于设备/测试集交换包。
结果卡片按名称中的数字自然排序（如 test1、test2、test10）并固定展示；数量较多时在
结果区域内滚动，并只在项目状态变化时重绘。
每项保留独立拓扑回放、甘特图和复现日志入口；点击结果卡片中的“回放”会直接载入
该测试并切换到拓扑回放界面。“全部甘特图”会在同一个查看器中一次加载所有成功结果，
每个测试对应一个标签页。

每个测试会保存一份与实际 Heuristic 输入配置绑定的 Baseline（makespan 与 CPU Time）。
首次运行、测试或共享 Route/Clean 变化时会自动计算或刷新；其他策略的结果卡片会显示
当前值、Baseline 和 makespan 改善比例。Baseline 计算失败会保存失败原因并清除旧指标，
避免继续使用已失效的数据。
