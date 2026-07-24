# 调度策略文档

本目录记录当前代码中可由 `scripts/run.py --strategy` 选择的全部调度策略。策略先生成资源占用顺序或直接求解，再统一产出 `SolveResult`；可行排程可导出为 MoveList。

| 策略 | 标识 | 适用场景 | 优化方式 |
| --- | --- | --- | --- |
| 快速启发式 | `heuristic` | 默认、需要低延迟 | 喂片优先、配比试探与安全兜底 |
| 深层神经派工 | `neural` | 离线充分训练、在线低延迟 | 5.9 万参数集合注意力 + 独立路线同步波前 + 有预算物理修复 |
| RL 搜索 | `rl` | 已有策略模型、要求限时改进 | 网络采样安全资源顺序，Timing 精确取优 |
| L2D 图策略 | `l2d` | PSE300 固定选腔场景 | GraphCNN/Actor 生成安全操作顺序 |
| MILP oracle | `milp` | 小中规模基准、标签与最优性参考 | Gurobi 混合整数优化 |

阅读路径：

- [公共解码与定时机制](common-engine.md)：所有非 MILP 策略共享的候选、Banker 安全检查、精确定时与约束口径。
- [启发式与搜索策略](heuristic-and-search.md)：启发式及其离线搜索变体。
- [学习策略与 MILP](learning-and-milp.md)：RL/L2D 的模型基础以及 `milp` 的建模决策。
- [深层神经派工](neural-dispatch.md)：直觉与理论依据、离线训练、低延迟推理和质量验收。
- [通用 LoadLock manager](neural-dispatch.md#loadlock策略无关的两层电梯式-petri-eta-manager)：
  Heuristic、Neural、BC、RL 共用的 Petri 安全候选 + 动态 ETA 物理锁绑定层。
- [运行、验收与选择](operation-guide.md)：命令行参数、输出、自检和选型建议。

## 统一术语

- **hop**：晶圆从当前 stage 移到下一 stage 的一次搬运，以 `(wid, source_stage)` 标识。
- **定序**：确定每个腔/槽和每台机器手上 hop 的先后次序；不是直接为每个动作填绝对时间。
- **解码**：从逐步选择的候选 hop 构建定序。默认解码保持同 route 发片 FIFO。
- **精确定时**：定序确定后，`solve_timing` 用差分约束图计算最早可行时间与 makespan，并检查驻留上界。
- **swap**：LoadLock 采用 entry/exit 分槽、允许异型片共存的变体；定时器会补充压力状态先后约束。

代码入口：`src/schedule/api.py` 提供启发式与 RL 搜索入口，`src/schedule/l2d/`
提供 L2D，`src/schedule/milp.py` 提供 MILP；`src/timing/solve.py` 只负责固定顺序定时。
