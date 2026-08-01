# 拓扑回放：E2E 决策透镜

## 目标

拓扑回放不仅重放已经执行的 MoveList，还在每个 Move 状态边界回答三个问题：

1. 物理状态机当时允许哪些联合动作；
2. 模型更偏好哪一个动作，以及每个动作的剩余 Makespan 分布；
3. E2E 当前推荐与原 MoveList 实际执行的意图是否一致。

界面明确区分三类信息：MoveList 是已经生成的计划事实；候选集合是 Machine 的
物理可行性事实；偏好、Makespan 和区间是模型预测。面板中的候选按当前下一条
物理运输 Move 合并，不把完整站到站事务的后续落点误写成当前动作。预测不能显示为
“保证”或“真实增量”。MoveList 可以来自启发式、MILP、外部算法或 E2E 本身；其来源不
改变实时评估所使用的 Machine 状态和 E2E checkpoint。

## 研究结论如何映射到本项目

- AlphaGo 使用 policy network 缩小候选并用 value network 评价局面；KataGo 的分析
  协议进一步同时暴露候选、policy、winrate 和 score lead。这里对应为“合法联合动作、
  模型偏好、剩余 Makespan 分位数、相对候选最优均值的 Δ Makespan”。参考
  [AlphaGo 论文](https://www.nature.com/articles/nature16961)与
  [KataGo Analysis Engine](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md)。
- 自动驾驶的多模态运动预测不只给一个点，而是给若干条带概率的未来轨迹；Wayformer
  和 MTR++ 都把场景上下文与多个未来模式联合建模。当前 E2E-CTQ 的生产边界是
  “一次前向、确定性选择、单轨迹”，因此界面只显示当前推荐和当前候选分支，不把
  静态后续动作重复包装成预测轨迹，也不伪造未经 rollout 的替代完整轨迹。参考
  [Wayformer](https://arxiv.org/abs/2207.05844)与
  [MTR++](https://arxiv.org/abs/2306.17770)。
- 调度领域已经证明可以在析取图状态上逐步学习派工，并直接以 Makespan 为目标构造
  一条解；这与当前资源流图策略的在线边界一致。参考
  [Learning to Dispatch for Job Shop Scheduling](https://proceedings.neurips.cc/paper/2020/hash/11958dfee29b6709f48a9ba0387a2431-Abstract.html)。
- 分位价值头比单一均值更适合表达长程风险，因此界面同时给出均值和稳健区间，并保留
  “不确定性不是置信保证”的说明。参考
  [Distributional Reinforcement Learning with Quantile Regression](https://arxiv.org/abs/1710.10044)。

## 实时 Machine 回放

运行结果会保存生成该 MoveList 的完整计划和逐轮实际 update。时间轴到达新的 Move
开始/结束边界时，服务端从当前代 update 建立 ``Machine``，只回放该边界之前已经
发生的 Move，然后调用生产 E2E-CTQ 模型评分当前全部合法完整搬运意图。服务端再按
每个意图的下一条 Pick / Place / Swap Move 合并结果：同一次 Pick 的不同后续落点
只显示为一个当前动作，组内策略概率求和，价值分位数按组内概率加权。模型按 checkpoint
修改时间缓存；浏览器按设备事件缓存结果，不会在每个动画帧重复前向。

接口返回的 ``selectedActionId`` 表示 E2E 实时推荐的当前物理动作，``executedActionId``
表示原计划下一条物理动作；``selectedIntentActionId`` 和 ``executedIntentActionId``
保留对应的完整事务 ID 供诊断。界面用绿色表示模型推荐，用橙色虚线和“原计划”标记
实际执行；二者可以是同一候选，也可以不同。

## DecisionTrace v1

E2E-CTQ 每个决策点记录：

- `time`、`decisionIndex`、`roundIndex`；
- `candidateCount`、是否因体积限制截断；实时回放中该数量为合并后的当前物理动作数；
- 每个候选的 wafer、Robot、源/目标站点、槽位和预计起止时间；
- 同一候选集合内归一化的 `policyPreference`；
- `expected/median/lower/upperRemainingMakespan`；
- 相对当前候选最小预测均值的 `makespanDelta`；
- `selected` 和 `selectedActionId`。

实时回放切片额外包含 ``replayEvaluated``、``executedActionId``，候选中用
``executed`` 标识原计划实际选择，并用 ``intentCount``、``intentActionIds`` 记录该
物理动作合并了哪些完整事务。E2E 排程自带的静态 ``DecisionTrace`` 仍保留，
在旧结果缺少 Machine 回放上下文或实时接口不可用时作为只读兜底。

为控制 1000 片场景的内存和结果文件体积，每轮最多记录 2048 个决策点，每个决策点
最多保存模型偏好最高的 24 个候选，并保证已选动作一定保留。完整候选总数和截断标志
始终写入协议，界面显示 `Top N / 总数`，不会把截断后的列表冒充完整集合。

## 交互与视觉

- 拓扑腔室右上角显示候选落点：圆内数字为排名，百分比为该目标下最高模型偏好；
  绿色描边表示模型最终选择，蓝色描边表示其他可行目标。
- 右侧“决策评估”只显示一次实时推荐；候选明细排除已经置顶的推荐动作，避免与顶部
  可行动作卡片或未来轨迹重复。
- `Δ Makespan` 只在同一决策点内比较；分位区间来自模型价值头。
- 拖动时间轴时，拓扑热区、决策卡片与正在执行的 MoveList 同步更新。
- “决策变化暂停”默认关闭；开启后以当前候选动作集合为基线，候选总数或动作 ID
  集合变化时立即暂停。首次实时评估和仅偏好分数变化不会触发暂停。
- 普通策略不需要预先生成 `DecisionTrace`；只要有完整计划上下文，就由 Machine 和
  真实 E2E 模型实时生成。缺少计划上下文的旧文件保持可恢复空状态，不生成启发式假数据。

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
