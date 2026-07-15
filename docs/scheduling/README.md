# 调度策略文档

本目录记录当前代码中可由 `scripts/run.py --strategy` 选择的全部调度策略。策略先生成资源占用顺序或直接求解，再统一产出 `SolveResult`；可行排程可导出为 MoveList。

| 策略 | 标识 | 适用场景 | 优化方式 |
| --- | --- | --- | --- |
| 快速启发式 | `heuristic` | 默认、需要低延迟 | 喂片优先、配比试探与安全兜底 |
| 双作业搜索 | `search` | 恰有两条 route，允许限时搜索 | 枚举/采样发片交织，并修复驻留违例 |
| 论文式任务池 | `paper` | 希望直接优化 PM 任务池 | 初始化 portfolio 加局部搜索 |
| 随机 rollout | `random` | 在快速解基础上再争取改进 | 随机候选偏好，多次精确评估取优 |
| BC 模仿学习 | `bc` | 已有训练模型，希望利用学习策略 | 网络联合选择 hop 与 LoadLock 腔 |
| MILP oracle | `milp` | 小中规模基准、标签与最优性参考 | Gurobi 混合整数优化 |

阅读路径：

- [公共解码与定时机制](common-engine.md)：所有非 MILP 策略共享的候选、Banker 安全检查、精确定时与约束口径。
- [启发式与搜索策略](heuristic-and-search.md)：`heuristic`、`random`、`search`、`paper` 的细节与适用边界。
- [学习策略与 MILP](learning-and-milp.md)：`bc` 训练/推理流程以及 `milp` 的建模决策。
- [运行、验收与选择](operation-guide.md)：命令行参数、输出、自检和选型建议。

## 统一术语

- **hop**：晶圆从当前 stage 移到下一 stage 的一次搬运，以 `(wid, source_stage)` 标识。
- **定序**：确定每个腔/槽和每台机器手上 hop 的先后次序；不是直接为每个动作填绝对时间。
- **解码**：从逐步选择的候选 hop 构建定序。默认解码保持同 route 发片 FIFO。
- **精确定时**：定序确定后，`solve_timing` 用差分约束图计算最早可行时间与 makespan，并检查驻留上界。
- **swap**：LoadLock 采用 entry/exit 分槽、允许异型片共存的变体；定时器会补充压力状态先后约束。

代码入口：`src/timing/api.py` 提供 `start_schedule`、`start_schedule_paper` 与 `start_schedule_by_policy`；`src/milp.py` 提供 `solve_milp`。
