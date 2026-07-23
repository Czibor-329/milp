# 学习策略与 MILP

## `bc`：行为克隆策略

`start_schedule_by_policy(ir, policy, n_samples=64, temp=0.7, seed=0, fallback=True)` 接收由
`src.schedule.policy.load_policy` 读取的 PyTorch checkpoint。网络对每个候选的 25 维特征
独立经共享 MLP 打分，因此候选数量可变且对候选排列不敏感。

特征由 `src.schedule.features.step_features` 生成，包含全局进度、在制品与候选规模、
加工/取片机会、相对可开始时间、驻留紧迫度、并行腔空闲比例、机器人空闲程度、
配方和 route 工作量，以及候选 LoadLock 的相对累计负载。

训练标签来自 MILP 的 teacher-forced replay：每步选择 MILP 中最早发生的 hop；同一 hop 的多个 LoadLock 候选中，选择 MILP 实际使用的腔。标签提取与推理均把选择的腔写回 wafer，以保证后续资源键和抽/充气时间一致。

推理包含一条贪心 rollout 和 `n_samples` 条温度采样 rollout：采样时在分数除以 `temp` 后加入 Gumbel 噪声。每条 rollout 都经选腔版 Banker 和 `solve_timing` 验证，取 makespan 最小的可行解。`fallback=True`（默认）还会与快速启发式结果取优，因此具备可行性地板；纯模型评测可显式关闭它。

当前 BC 仅动态选择多候选 LoadLock；加工腔仍维持 round-robin 固定分配。运行 `bc` 前需存在 `results/models/bc_policy.pt` 且环境可导入 torch，否则统一运行器会跳过该策略。

## `milp`：Gurobi oracle

`solve_milp(task, time_limit=..., verbose=False)` 直接最小化 makespan，是基准、标签来源和小中规模精确求解手段。主要决策包括每个 hop 的取片时间、资源及机器人操作先后关系、LoadLock 候选腔二元选择，以及互斥析取变量。

模型覆盖：站内加工与驻留上界、搬运链、同一腔/槽互斥、LoadLock 条件化互斥与 pump/vent setup、多容量腔门簇互斥、机器人互斥/转位、同 route FIFO、pre/post/WAC/dummy-WAC 清洁和 dummy 段顺序。加工腔按解析阶段的 round-robin 静态分配，LoadLock 才通过二元变量选择具体腔。

MILP 在时限内有 incumbent 即返回可用解；`status` 和 `gap` 表示 Gurobi 的求解状态与相对最优间隙。它依赖 Gurobi 许可证，命令行默认时限为 300 秒。不要将时限内可行但未证最优的结果称作“最优解”。
