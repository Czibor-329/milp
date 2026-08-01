# 拓扑回放：E2E 决策透镜

## 目标

拓扑回放不仅重放已经执行的 MoveList，还在每个 E2E-CTQ 决策点回答三个问题：

1. 物理状态机当时允许哪些联合动作；
2. 模型更偏好哪一个动作，以及每个动作的剩余 Makespan 分布；
3. 模型最终选择的动作在后续若干决策点形成怎样的单轨迹。

界面明确区分三类信息：MoveList 是已经生成的计划事实；候选集合是 Machine 的
物理可行性事实；偏好、Makespan 和区间是模型预测。预测不能显示为“保证”或
“真实增量”。

## 研究结论如何映射到本项目

- AlphaGo 使用 policy network 缩小候选并用 value network 评价局面；KataGo 的分析
  协议进一步同时暴露候选、policy、winrate 和 score lead。这里对应为“合法联合动作、
  模型偏好、剩余 Makespan 分位数、相对候选最优均值的 Δ Makespan”。参考
  [AlphaGo 论文](https://www.nature.com/articles/nature16961)与
  [KataGo Analysis Engine](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md)。
- 自动驾驶的多模态运动预测不只给一个点，而是给若干条带概率的未来轨迹；Wayformer
  和 MTR++ 都把场景上下文与多个未来模式联合建模。当前 E2E-CTQ 的生产边界是
  “一次前向、确定性选择、单轨迹”，因此首版只显示当前多个候选分支和已经选择的
  后续单轨迹，不伪造未经 rollout 的完整替代轨迹。参考
  [Wayformer](https://arxiv.org/abs/2207.05844)与
  [MTR++](https://arxiv.org/abs/2306.17770)。
- 调度领域已经证明可以在析取图状态上逐步学习派工，并直接以 Makespan 为目标构造
  一条解；这与当前资源流图策略的在线边界一致。参考
  [Learning to Dispatch for Job Shop Scheduling](https://proceedings.neurips.cc/paper/2020/hash/11958dfee29b6709f48a9ba0387a2431-Abstract.html)。
- 分位价值头比单一均值更适合表达长程风险，因此界面同时给出均值和稳健区间，并保留
  “不确定性不是置信保证”的说明。参考
  [Distributional Reinforcement Learning with Quantile Regression](https://arxiv.org/abs/1710.10044)。

## DecisionTrace v1

E2E-CTQ 每个决策点记录：

- `time`、`decisionIndex`、`roundIndex`；
- `candidateCount`、是否因体积限制截断；
- 每个候选的 wafer、Robot、源/目标站点、槽位和预计起止时间；
- 同一候选集合内归一化的 `policyPreference`；
- `expected/median/lower/upperRemainingMakespan`；
- 相对当前候选最小预测均值的 `makespanDelta`；
- `selected` 和 `selectedActionId`。

为控制 1000 片场景的内存和结果文件体积，每轮最多记录 2048 个决策点，每个决策点
最多保存模型偏好最高的 24 个候选，并保证已选动作一定保留。完整候选总数和截断标志
始终写入协议，界面显示 `Top N / 总数`，不会把截断后的列表冒充完整集合。

## 交互与视觉

- 拓扑腔室右上角显示候选落点：圆内数字为排名，百分比为该目标下最高模型偏好；
  绿色描边表示模型最终选择，蓝色描边表示其他可行目标。
- 右侧“AI Decision Lens”显示选择摘要、未来六个已选决策点以及候选明细。
- `Δ Makespan` 只在同一决策点内比较；分位区间来自模型价值头。
- 拖动时间轴时，拓扑热区、决策卡片与正在执行的 MoveList 同步更新。
- 旧结果或普通策略没有 `DecisionTrace` 时显示可恢复的空状态，不生成启发式假数据。

## 后续阶段

1. 增加可选的离线 branch rollout 服务，对 Top-K 首动作各自继续运行有限步或到终局，
   输出真正的替代完整轨迹及真实状态机复核后的 Makespan；该服务不能进入生产在线
   选轨边界。
2. 对 `policyPreference` 做温度校准，并按设备族、晶圆规模和决策类型报告可靠性；
   未校准前只能称“模型偏好”，不能称“胜率”或“成功率”。
3. 增加模型漂移与反事实审计：候选覆盖率、Top-1/Top-K 稳定性、分位区间覆盖率、
   预测 Δ 与 rollout 实测 Δ 的误差。
4. 若引入多轨迹规划，沿用自动驾驶表达：每条替代轨迹必须同时显示概率、约束状态、
   预计 Makespan 和风险区间，并把最终执行轨迹与预测轨迹视觉分层。
