# 调度平台

此目录集中保存实时调度平台的前端、服务端和本地数据：

- `server.py`：本地调度服务、工作区接口、分析 API 与静态资源入口，不承载页面分析实现。
- `backend/analysis.py`：服务端唯一的 MoveList 性能、瓶颈和测试组分析实现。
- 内置 `heuristic/loadlock-macro/e2e-ctq/dual-actor-e2e`：统一调用独立算法仓库
  `alg/infer/scheduler.py` 的 `init/update`，`update` 的可选 `algorithm`
  参数决定算法。
- `batch_service.py`：批量运行、Heuristic Baseline、并发进度与取消状态。
- `plan_builder.py`：设备归一化、Route/Recipe 和各轮 CJob/PJob 请求建模。
- `frontend/config_editor.html`：只保存调度平台的页面骨架。
- `frontend/src/`：TypeScript 前端源码，按 API、数据模型、Route 逻辑和页面入口拆分。
- `frontend/src/workspace_visualizer.ts`：MoveList 回放、腔室门状态与设备工作台；性能指标通过 `/api/analysis/*` 获取。
- `frontend/assets/`：可由 Python 服务直接托管的构建产物与样式。
- `frontend/movelist_gantt_viewer.html`：MoveList 甘特图页面。
- `data/workspaces.json`：设备、设备级共享 Route/Clean、测试集任务。
- `data/devices/`：按设备 ID 独立保存的 init 信息。
- `exports/logs/`：每次运行生成的 input_data 复现日志。
- `exports/results/`：每次运行生成的统一 MoveList 与重算点。

默认从父仓库的 `alg/` 加载完整算法仓库；也可用 `CT_ALGORITHM_ROOT`
指向其他位置。完整算法仓库是可选依赖：缺席时服务和工作区仍可启动，
内置策略在健康检查中标记为不可用。

独立交付的标准算法包默认从父仓库的 `other_alg/` 加载；若该目录不存在，
兼容读取 `alg/other_alg/`。也可用 `CT_OTHER_ALGORITHM_ROOT` 指向任意打包
算法目录。只有打包算法时，多轮重算由算法包自带的重算桥接器根据
`MoveStates/RemoveList` 恢复状态；本地完整算法仓库存在时仍使用原有
`src.validation` 状态机做平台侧校验。

完整开发环境启动：

`alg\.venv\Scripts\python.exe realtime_scheduler/server.py --port 8765 --open`

旧命令 `python scripts/config_editor_server.py` 仍可使用。

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
- `other_alg 标准算法`：自动扫描算法仓库 `alg/other_alg/<算法名>`，通过包内正式 `CT.infer.scheduler.init/update`（或公司端 `src.infer.scheduler.init/update` 布局）入口运行。每次重算前使用算法仓库的状态回放能力生成全量物料、机台、机器人快照以及 `RemoveList`，支持连续多轮重算；结果中的 `updates` 保留每次实际发送的数据。
- `添加算法`：策略面板上的「＋ 添加算法」按钮用于登记单个 Python 文件（管理员可见）。文件只需在顶层定义 `init` 和 `update` 两个函数，不要求 `CT/infer/scheduler.py` 结构；登记信息与源文件保存在 `data/registered_algorithms.json` 与 `data/registered_algorithms/` 下，重启保留。登记后刷新页面即出现在策略列表，与 `other_alg` 算法共用同一套标准调用。
- `跳过输出校验`：运行策略面板可勾选“跳过输出校验”，此时不再对 MoveList 做平台侧状态校验（首排与重算均跳过），直接展示算法原始输出，结果校验状态标记为 `skipped`；批量运行同样生效。

本地算法列表不在前端写死，而是由算法仓库根目录的 `algorithms.json` 控制。
服务会在每次健康检查时重读清单；配置中的算法还必须存在于
`infer.function.SUPPORTED_ALGORITHMS`，并满足 `requiredFiles`，才能在页面中启用。

内置算法与 `other_alg` 现在共用同一套标准 update 数据流。内置入口示例：

```python
from infer.scheduler import init, update

init(topo_data_json)
output_json = update(tool_json, algorithm="heuristic")
```

同一次 `init` 后不能在连续 update 之间切换算法；切换前需重新初始化设备。

标准算法目录可保留打包后的 `CT/infer/scheduler.py` 结构，也可以直接包含
`infer/scheduler.py`、`ropn_sa/` 和 `config/`，或按公司端约定提供
`src/infer/scheduler.py` 入口（入口转发文件内使用 `src.infer.function`
绝对导入或 `from .function` 相对导入均可）。前端健康检查会动态返回所有有效算法包，
默认无需额外配置；算法仓库不在 `alg/` 时设置 `CT_ALGORITHM_ROOT`。

测试组别作为设备下的独立数据保存，允许先创建空组，再在当前组内新建或复制测试；旧测试会自动归入“未分组”，无需手工迁移。

运行页可选择任意可用策略后点击“批量运行当前组”。服务会在后台并行运行当前测试组中的
全部测试（最多四项并行），页面实时显示每项的等待、运行、成功或失败状态与总体进度。
每项保留独立甘特图和复现日志；“全部甘特图”会在同一个查看器中一次加载所有成功结果，
每个测试对应一个标签页。

每个测试会保存一份与实际 Heuristic 输入配置绑定的 Baseline（makespan 与 CPU Time）。
首次运行、测试或共享 Route/Clean 变化时会自动计算或刷新；其他策略的结果卡片会显示
当前值、Baseline 和 makespan 改善比例。Baseline 计算失败会保存失败原因并清除旧指标，
避免继续使用已失效的数据。
