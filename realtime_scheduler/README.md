# CT 实时调度终端

此目录集中保存实时调度前端及其本地数据：

- `server.py`：本地调度服务、工作区接口与静态资源入口，不再承载前端实现。
- `batch_service.py`：批量运行、Heuristic Baseline、并发进度与取消状态。
- `plan_builder.py`：设备归一化、Route/Recipe 和各轮 CJob/PJob 请求建模。
- `frontend/config_editor.html`：只保存配置终端的页面骨架。
- `frontend/src/`：TypeScript 前端源码，按 API、数据模型、Route 逻辑和页面入口拆分。
- `frontend/src/workspace_visualizer.ts`：MoveList 回放、腔室门状态与设备工作台。
- `frontend/assets/`：可由 Python 服务直接托管的构建产物与样式。
- `frontend/movelist_gantt_viewer.html`：MoveList 甘特图页面。
- `data/workspaces.json`：设备、设备级共享 Route/Clean、测试集任务。
- `data/devices/`：按设备 ID 独立保存的 init 信息。
- `exports/logs/`：每次运行生成的 input_data 复现日志。
- `exports/results/`：每次运行生成的统一 MoveList 与重算点。

启动：`python realtime_scheduler/server.py --port 8765 --open`

旧命令 `python scripts/config_editor_server.py` 仍可使用。

## 前端开发

部署和运行仍然只依赖 Python；仓库已经保存构建后的浏览器资源。修改配置终端前端时，
在 `realtime_scheduler/frontend` 下执行：

```powershell
npm install
npm run check
npm run build
```

`npm run check` 检查独立 TypeScript 业务模块，`npm run build` 更新
`assets/config_editor.js`，并生成供 Node 单元测试使用的 `route_editor_logic.js`
与 `workspace_visualizer_logic.js`。

配置终端中的“可视化工作台”可直接载入当前运行结果、批处理结果或本地 MoveList JSON。
工作台支持拖动时间轴和按倍率播放，并根据 Prepare/Complete 动作显示腔室门的关闭、
正在开门、开启与正在关门状态。

## 运行策略

- `启发式`：使用默认实时排程器。
- `深层神经派工`：离线多场景长训练，在线 NumPy 联合派工；实时入口只接受网络打分轨迹及同一网络的 Petri 安全重试，不调用启发式、物理专家或质量地板保底；网络无法产生可执行计划时明确报错。
- `LoadLock 管理器`：Heuristic 与 RL 默认共用 Petri-ETA 管理器；上层策略只决定发哪片和工艺顺序，管理器在 Petri 安全候选内按动态完成时刻绑定 LA/LB。现有深层神经 checkpoint 暂以 `joint` 为默认，仍可显式切到 manager 供下一阶段重训与 A/B。
- `RL 搜索`：使用已有的行为克隆/RL模型做限时搜索。
- `MILP 最优求解`：独立调用 Gurobi，只允许首次排程且所有 PJob 产品晶圆总数不超过12片；页面显示是否已证明最优和最终 gap。
- `other_alg 标准算法`：自动扫描仓库 `other_alg/<算法名>`，通过包内正式 `CT.infer.scheduler.init/update` 入口运行。每次重算前使用 `src/validation/state.py` 回放当前 MoveList，生成全量物料、机台、机器人快照以及 `RemoveList`，支持连续多轮重算；结果中的 `updates` 保留每次实际发送的数据。

标准算法目录可保留打包后的 `CT/infer/scheduler.py` 结构，也可以直接包含
`infer/scheduler.py`、`ropn_sa/` 和 `config/`。前端健康检查会动态返回所有有效算法包，
无需配置仓库外路径或环境变量。

测试组别作为设备下的独立数据保存，允许先创建空组，再在当前组内新建或复制测试；旧测试会自动归入“未分组”，无需手工迁移。

运行页可选择任意可用策略后点击“批量运行当前组”。服务会在后台并行运行当前测试组中的
全部测试（最多四项并行），页面实时显示每项的等待、运行、成功或失败状态与总体进度。
每项保留独立甘特图和复现日志；“全部甘特图”会在同一个查看器中一次加载所有成功结果，
每个测试对应一个标签页。

每个测试会保存一份与实际 Heuristic 输入配置绑定的 Baseline（makespan 与 CPU Time）。
首次运行、测试或共享 Route/Clean 变化时会自动计算或刷新；其他策略的结果卡片会显示
当前值、Baseline 和 makespan 改善比例。Baseline 计算失败会保存失败原因并清除旧指标，
避免继续使用已失效的数据。
