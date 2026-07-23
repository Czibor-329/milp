# CT 实时调度终端

此目录集中保存实时调度前端及其本地数据：

- `server.py`：本地调度服务与工作区接口。
- `frontend/`：配置终端和 MoveList 甘特图页面。
- `data/workspaces.json`：设备、设备级共享 Route/Clean、测试集任务。
- `data/devices/`：按设备 ID 独立保存的 init 信息。
- `exports/logs/`：每次运行生成的 input_data 复现日志。
- `exports/results/`：每次运行生成的统一 MoveList 与重算点。

启动：`python realtime_scheduler/server.py --port 8765 --open`

旧命令 `python scripts/config_editor_server.py` 仍可使用。

## 运行策略

- `启发式`：使用默认实时排程器。
- `RL 搜索`：使用已有的行为克隆/RL模型做限时搜索。
- `L2D 图策略`：仅用于PSE300，模型贪心生成一次析取图操作顺序，再由Timing求解器统一定时。
- `MILP 最优求解`：独立调用 Gurobi，只允许首次排程且所有 PJob 产品晶圆总数不超过12片；页面显示是否已证明最优和最终 gap。
- `外部 Greedy`：在同一会话中调用 new-sa 的正式 `CT.infer.scheduler.init/update`。每次重算前使用 `src/validation/state.py` 回放当前 MoveList，生成全量物料、机台、机器人快照以及 `RemoveList`，支持连续多轮重算；结果中的 `updates` 保留每次实际发送的数据。

L2D会优先加载`results/models/l2d_pse300_2job.pt`，也支持同目录的一阶段模型以及仓库根目录下训练命令默认生成的checkpoint。没有找到checkpoint时，可直接在运行策略区导入`.pt`文件；服务会先验证模型结构和特征版本，再保存并立即启用L2D选项。

服务会自动寻找本机 `D:\Desktop\WenJiCai\new-sa`；部署到其他目录时，通过环境变量
`NEW_SA_PROJECT_ROOT` 指向包含 `CT/infer/scheduler.py` 的 new-sa 仓库根目录。健康检查会在
找不到入口时禁用前端的“外部 Greedy”选项并显示原因。

测试组别作为设备下的独立数据保存，允许先创建空组，再在当前组内新建或复制测试；旧测试会自动归入“未分组”，无需手工迁移。
