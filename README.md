# CT 实时调度平台

本仓库保存调度控制台、服务端应用、工作区数据和前端测试。浏览器只负责编辑、
回放和展示；性能分析、诊断、批处理和持久化全部由服务端负责。架构边界见
[`docs/architecture.md`](docs/architecture.md)。
调度算法是可选的独立仓库，开发时默认检出到本仓库的 `alg/` 目录；该目录
已被父仓库 Git 忽略。主仓库可以单独交付：没有 `alg/` 时平台仍可启动、
编辑和分析数据，并可运行独立部署的 `other_alg` 标准算法包；内置策略会
明确显示为不可用。

## 目录

```text
realtime_scheduler/
  frontend/               # 页面、样式和 TypeScript/JavaScript
  server.py               # 本地 HTTP 服务与算法接口适配
  algorithm_interface.py  # 外部候选算法发现与标准 init/update 调用
  plan_builder.py         # 把页面配置转换为标准接口数据
  batch_service.py        # 前端批量运行任务
  data/                   # 本地工作区
  exports/                # 页面导出的结果与日志
scripts/
  config_editor_server.py # 兼容启动入口
  replay_config_log.py    # 回放页面导出的请求日志
  seed_neural_recompute_workspaces.py
tests/                    # 前端与服务适配层测试
alg/                      # 独立算法仓库，不由父仓库追踪
```

## 算法部署方式

完整开发环境可把私有算法仓库检出到：

```text
<本仓库>/alg
```

也可以通过环境变量指向其他位置：

```powershell
$env:CT_ALGORITHM_ROOT = "D:\path\to\algorithm-repo"
```

完整算法仓库必须提供：

```text
infer/scheduler.py
src/
```

只交付已打包算法时，不需要完整 `alg`。把标准算法包放到主仓库的：

```text
<本仓库>/other_alg/<算法名>/infer/scheduler.py
```

算法包保留 `CT/infer/scheduler.py` 结构也可以。若打包算法位于其他目录，
设置：

```powershell
$env:CT_OTHER_ALGORITHM_ROOT = "D:\path\to\other_alg"
```

`CT_ALGORITHM_ROOT` 与 `CT_OTHER_ALGORITHM_ROOT` 可以同时设置：前者提供本地
内置算法，后者提供可独立交付的标准算法包。

## 启动

完整开发环境先安装算法依赖，再从算法仓库环境启动服务：

```powershell
alg\.venv\Scripts\python.exe realtime_scheduler\server.py --open
```

不带完整算法仓库时，安装主仓库依赖并使用任意兼容 Python 环境启动：

```powershell
python realtime_scheduler\server.py --open
```

也可使用兼容入口：

```powershell
alg\.venv\Scripts\python.exe scripts\config_editor_server.py --open
```

默认地址为 `http://127.0.0.1:8765/config_editor.html`。

“可视化工作台”会从 MoveList 计算物理资源占用、Active Period
瓶颈、出站节拍和真空端入队序列。默认统计窗口剔除启动填充与末批排空，
也可以切换到完整周期；指标口径与测试集分析见
[`docs/schedule-performance-analysis.md`](docs/schedule-performance-analysis.md)。

父仓库不会直接维护算法实现、模型、训练脚本或算法测试；这些内容都在
独立的 `alg` 仓库中管理。
