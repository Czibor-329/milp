# 深层集合注意力神经派工

`neural` 是一条独立的“离线重训练、在线轻推理”链路。它不复用 BC 或 RL 的网络
与 checkpoint，只共享解析器、Petri 可行性检查、精确定时器和 MoveList 校验器。

## 问题分解

调度器不直接回归整张甘特图，而是在每个设备事件点，从当前可搬运的 wafer hop 与
LoadLock 去向的联合候选中选择下一步。选择序列确定资源顺序，随后由 `solve_timing`
计算精确时刻。

这个分解有三个直接好处：

1. 候选数量随片数和设备状态变化，网络仍使用同一组参数；
2. 设备故障、插单或实时续排只改变当前状态，无需重新定义输出维度；
3. 网络负责“偏好”，Petri 网和定时器负责“能不能做”，安全约束不依赖训练是否充分。

## LoadLock：策略无关的两层电梯式 Petri-ETA manager

LA/LB 可以看作两台只有“大气侧/真空侧”两层的电梯：晶圆是乘客，抽气/充气是跨层
运行，开门和 Robot 搬运是上下客。它与普通电梯不同之处在于每把锁有入站/回程槽，
一次进真空必然产生一张未来回程需求，而且门、压力和 Robot/PM 是耦合资源。

`LoadLockDispatchManager` 把动作选择分成两层：

1. Heuristic、Neural、BC 或 RL 选择逻辑请求，即下一片晶圆和下一段工艺 hop；
2. 严格适配器先把 LA/LB 物理候选折叠成每个 `(wafer, stage)` 一个逻辑候选，避免
   具体锁名反向影响 Heuristic 的发片顺序；
3. manager 只在全局 Petri 网已经判定安全的候选内绑定 `(LoadLock, slot)`；
4. 报价累计运行时释放下界和此前已提交服务的完成时刻，再加入必要的空抽/空充、
   Robot hop、关门、载片抽/充气和开门，按预计服务完成时刻排序；
5. 同 ETA 时再比较回程容量风险、空压力循环、历史服务次数和稳定名称。

entry 完成后锁停在真空侧，下一项自然适合服务 exit；exit 完成后锁停在大气侧，下一项
自然适合服务 entry。这保留了两层 LOOK 的方向直觉，但不把“少一次压力循环”放在所有
时间成本之前：一把很晚才释放的同侧锁仍可能输给需要一次空循环、但更早完成的锁。

manager 只给已使能变迁报价，不创建新变迁，所以不会绕开门互锁、槽位容量和终态可达性。
默认实现名为 `petri-eta-v2`；前端继续接受 `petri-look` 作为兼容配置名。它没有单工序
限制，Heuristic、Neural、BC、RL 和实时续排共用同一接口。Heuristic 与 RL 默认启用；
现有 Neural checkpoint 仍以 `joint` 为默认，因为它在物理 LA/LB 标签上训练。切换到
`petri-eta` 时可由兼容适配器只改写每个逻辑请求组内的具体锁；下一阶段应直接用折叠后的
逻辑请求重训网络，再决定是否更换 Neural 的生产默认值。

Heuristic 会对同一逻辑规则同时评估固定锁、双槽 swap 和 manager 动态绑定三条轨迹，
全部交给 `solve_timing` 精确定时，只在 manager 轨迹更优时采用，因此启用 manager
对现有 Heuristic 有显式质量地板。最终实现对生成数据集中 169 个原本可行的实例做 A/B：
26 个改善、143 个持平、0 个变差；总 makespan 从 219,094.40 降到 213,384.34
（降低 2.61%）。独立测试集单工序子集为 7/21 改善、14/21 持平，总 makespan
降低 6.73%，单例最大降低 22.43%。所有 manager 结果均通过完整约束复核；另有一个
三工序实例在两种模式下都不可行，不计入上述 169 个实例。

这一分层与 cluster tool 常见的“两级调度器 + 实时控制器”一致；电梯 Petri 网工作也把
运动、上下客和换向拆成模块，再在可达图上做动态调度：

- [Petri net based dynamic scheduling of an elevator system](https://doi.org/10.1109/ROBOT.1996.503594)
- [Real-Time Scheduling and Control of Cluster Tools in Semiconductor Fabrication](https://www.sciencedirect.com/science/article/pii/S1474667015355841)
- [Timed Petri Nets in Modeling and Analysis of Cluster Tools](https://research.library.mun.ca/14867/)

## 直觉依据与理论依据

| 设计 | 直觉 | 理论或文献依据 |
| --- | --- | --- |
| 事件驱动候选派工 | 现场每次只执行一个 Robot hop，没必要在线生成完整时间表 | Learning to Dispatch 把组合排程化为尺寸无关的逐步派工 |
| 无位置编码的集合注意力 | 候选列表的排列是实现细节，不应改变分数 | Deep Sets 刻画集合函数；Set Transformer 用注意力表达元素间相互作用并保持置换对称性 |
| Recipe 静态特征 + 设备动态特征 | 同一动作的价值同时取决于剩余工艺和当前拥塞 | Cluster Tool 非循环 DRL 使用 Recipe 编码器与动态动作解码器 |
| 分层安全屏蔽 | 网络可以判断“更好”，但不应获准输出不可执行计划 | 完整轨迹本身提供终态可达证书；小批量可做 Petri 复核，大批量用下游排空屏蔽，最终再做精确定时和状态回放 |
| 教师搜索离线蒸馏 | 训练阶段可慢，应把多方案比较的结果压进一个快速策略 | Cluster Tool adaptive search 和自标注调度均把搜索质量转化为策略监督 |
| 全候选排序损失 | 只记首选动作时，一次误差后剩余动作没有可靠次序 | 顺序学习给所有候选提供相对偏好；它不能完全替代 DAgger，但能减轻长轨迹误差累积 |
| 有预算物理修复 | 模仿策略在未见实时状态会有分布漂移，失败成本不能变成长搜索 | 用固定数量的下游排空/配额轨迹形成 safety shield；大批量仅访问在机 token 与各路线头 |
| 重算切点拓扑恢复 | 实时状态保留槽位占用，却未必保留双槽 LoadLock 的历史入腔序 | 出站片优先、剩余 hop 更少者优先，使无回流路线的“设备内剩余 hop 势函数”单调下降，避免人为 FIFO 闭锁 |
| 独立路线同步波前 | 三条路线各自只用一对 PM 时，连续推进某一条会占满共享 LoadLock，让另外四个 PM 饥饿 | 对等负载、等加工时长且 PM 池两两不相交的路线族，先取真实最早事件，再同步推进各族第 k 片；这是并行机前缀负载的 majorization 均衡，并消除共享缓冲的队首阻塞 |

同步波前不是一般路线的最优性定理。它只在代码检查的充分条件内使用：单工序、等加工
时长、加工腔池两两不相交、各族片数相差不超过一片且无清洁。此时每个双腔族的加工
下界是 `ceil(n/2) × process_time`，让各族任意前缀的已释放片数相差至多一片，不会增加
任何族的该下界；共享 Robot/LoadLock 文献还表明，在“并行机 + 单装卸 server”的受限
模型里，最小 makespan 等价于最小机器总空闲时间。超出这些条件时仍由集合网络和 Petri
安全层处理，不外推这一结论。

主要参考：

- [Noncyclic Scheduling of Cluster Tools Using Deep Reinforcement Learning](https://doi.org/10.1109/TASE.2025.3632534)
- [Scheduling Cluster Tools for Concurrent Processing: Deep Reinforcement Learning with Adaptive Search](https://doi.org/10.1109/TASE.2024.3399818)
- [Learning to Dispatch for Job Shop Scheduling via Deep Reinforcement Learning](https://proceedings.neurips.cc/paper/2020/hash/11958dfee29b6709f48a9ba0387a2431-Abstract.html)
- [Deep Sets](https://arxiv.org/abs/1703.06114)
- [Set Transformer](https://proceedings.mlr.press/v97/lee19d.html)
- [Safe Reinforcement Learning via Shielding](https://ojs.aaai.org/index.php/AAAI/article/view/11797)
- [A Reduction of Imitation Learning and Structured Prediction to No-Regret Online Learning](https://proceedings.mlr.press/v15/ross11a)
- [Self-Labeling the Job Shop Scheduling Problem](https://arxiv.org/abs/2401.11849)
- [Deep Reinforcement Learning Guided Improvement Heuristic for Job Shop Scheduling](https://openreview.net/forum?id=jsWCmrsHHs)
- [Deep Reinforcement Learning for Scheduling Semiconductor Cluster Tools in Varying Configurations](https://doi.org/10.1038/s41598-025-31722-7)
- [Scheduling on Parallel Machines with a Common Server in Charge of Loading and Unloading Operations](https://arxiv.org/abs/2306.16669)

## 网络

每个候选使用 39 个无量纲特征，分成五类：

- 动作语义：发片、进 PM、出 PM、进 LoadLock、完工；
- 时间与安全：相对最早开始、Robot 可用性、Residency 紧迫度、清洁负荷；
- Recipe 与关键路径：当前/下一工序时长、剩余工作量、route 总工作量、工序进度；
- 拥塞与业务：系统占用、并行 PM 空闲率、同目的地竞争、route 在制品、JobType 和 Priority。
- 泛化尺度：route 数、批量对数尺度、流水深度、资源容量压力，以及 pre/post/周期/dummy
  清洁场景标志。

特征先投影到 48 维，经过 3 层、4 头的无位置集合自注意力；每层含 96 维前馈残差块，
最后由 24 维评分头输出每个候选的 logit。模型共 58,848 个参数。自注意力允许一个候选
显式看到其他候选，例如同时比较“继续喂片”和“立刻排空驻留片”；去掉位置编码则保证
重排候选只会同步重排输出。

生产实现是纯 NumPy。模型虽比第一版深很多，但每一步的候选集合很小，且正常路径只走
一条贪心轨迹；单元素候选不调用网络。大规模轨迹失败时只运行固定数量的物理修复轨迹，
不会执行无界 rollout、beam search 或梯度计算。

## 离线训练

默认只从 `dataset/train` 取场景，覆盖不同工序数、并行腔配置、Recipe 时间、Job 数和
片数，并按实例而不是按决策步切分训练/验证，避免同一轨迹泄漏。

```bash
python scripts/train_neural.py --epochs 300
```

默认把场景扩展到原片数、5、12、25 片。`strong` 教师在原始场景比较 MILP 标签与
Heuristic，选 makespan 更好的轨迹；扩展片数使用 Heuristic。网络学习教师在每个状态的
首选动作和全部候选的相对顺序；也可强制只用 MILP：

```bash
python scripts/train_neural.py --teacher milp --wafer-counts 0
```

当前交付 checkpoint 为刻意更严格的规模外推实验，只用 149 个原始训练场景
（`--teacher strong --wafer-counts 0`），包含 6,784 个训练决策状态；验证 top-1 为
79.28%。联合 LoadLock 的对称动作会压低分类准确率，因此发布验收以排程 makespan 与
可执行性为主，而不是只看动作分类。

训练脚本另提供 36 个路线拆分增强实例：PM 配对取三种排列，单 Job 片数为
4/8/16/24，加工时间为 90/180/450 秒；刻意不包含验收案例的 25 片/300 秒。建议从
已验收 checkpoint 做保持函数等价的低学习率微调，并输出候选文件：

```bash
python scripts/train_neural.py --wafer-counts 0 \
  --decomposition-augmentation \
  --initialize-from src/schedule/neural_policy.npz \
  --learning-rate 0.00002 --epochs 30 \
  --output neural_policy_candidate.npz
```

实时重算不是普通首排的同分布输入。训练器可在内存中真实执行两次重算，保留 Robot
位置、LoadLock 压力态以及站点/槽位/物料释放下界，再由 Heuristic 强教师重新标注完整
候选排序：

```bash
python scripts/train_neural.py --wafer-counts 0 \
  --realtime-residual-augmentation \
  --six-pm-long-augmentation \
  --initialize-from src/schedule/neural_policy.npz \
  --output neural_policy_candidate.npz
```

四腔残差训练域使用 37/73/127/211/337 秒重算间隔和 4/7/12/18/24 片，显式排除前端
验收的 50/100/150/250/300 秒及 10/15 片。六腔长途域同样排除验收的 600 秒工艺、
1200 秒间隔和每路线 5 片，并在 Heuristic 与网络同步波前教师中逐残差态取 makespan
更小者。这样训练阶段可以长时间搜索和聚合状态，生产端仍只做一次轻量前向。

`--initialize-from` 会补偿新旧训练集的特征均值和标准差，因此 epoch 0 与原 checkpoint
前向完全等价。候选模型不能按验证 top-1 直接覆盖生产文件：本次增强模型 top-1 从
79.28% 提升到 86.3%，但这不足以证明长时域质量；候选模型尚未通过“同一拆分计划下
Neural 对 Heuristic”的完整 makespan A/B 发布门槛，所以没有替换当前权重。

训练依赖 Torch，输出 `src/schedule/neural_policy.npz`。文件只包含固定维度浮点数组和
标量元数据，加载时使用 `allow_pickle=False`，生产推理不依赖 Torch。

若后续拥有更长的训练预算，优先增加两类数据，而不是继续扩大线上网络：

1. 用 MILP、限时搜索和多个启发式生成候选排程，仅把 makespan 最好的轨迹作为自标签；
2. 运行当前策略收集它自己会访问的状态，再由教师重新排序，形成 DAgger 式数据聚合。

第二项针对模仿学习的状态分布漂移；它只改变训练集，不增加任何上线时延。

## 在线推理

1. 服务启动后加载并缓存安全的 NumPy checkpoint；
2. 网络对 hop + PM + LoadLock 联合候选做一次前向并贪心选取，单候选直接提交；
3. 若识别到等负载、单工序且 PM 池两两不相交的路线族，动作掩码同步推进各族第 k 片，
   网络在该吞吐波前内选择等负载 PM；共享 PM、多工序、清洁和不平衡负载不启用；
4. 轨迹走到终态即为逐步可达证书；`solve_timing` 再检查时间、驻留和资源环；
5. ≤24 片失败轨迹可做完整 Petri 重试；更大批量跳过昂贵的全状态搜索；
6. 失败时运行固定数量的动态选腔、下游排空和多路线配额修复；大批量解码使用事件
   前沿，避免每个动作扫描全部待加工晶圆；
7. MoveList 状态机复核清洁、LoadLock、FIFO、Residency/QTime 和实时资源释放下界；
8. ≤24 片的物理修复会显式计算一次 Heuristic 质量地板，若更好则标为
   `quality-floor-fallback`；全部路径失败则标为 `failure-fallback`。大批量不计算
   baseline，不会把它伪装成网络结果。

命令行评测：

```bash
python scripts/run.py --strategy heuristic neural --subsets test/1stage
```

实时控制台可直接选择“深层神经派工”。结果中的 `strategyDiagnostics` 记录模型路径、
参数量、训练实例/决策步、验证准确率、前向次数、动作掩码和结果来源。

## 实测结果

同一候选模型在 93 个原始实例上与当前 Heuristic baseline 对照，Neural 为 93/93
可行，baseline 为 92/93；双方共同可行且有 MILP 标签的 72 个实例中：

| 场景 | 数量 | Baseline 平均 MILP gap | Neural 平均 MILP gap | 结论 |
| --- | ---: | ---: | ---: | --- |
| 2 Job | 20 | +34.09% | **+2.83%** | 19 胜 0 平 1 负 |
| 2 Job + clean | 6 | +29.72% | **+13.01%** | 4 胜 2 平 |
| 2 stage | 20 | +1.67% | **+0.26%** | 8 胜 10 平 |
| 3 stage | 16 个双方可行 | +1.36% | **+0.01%** | 网络平均 23.1 ms，baseline 50.1 ms |
| clean | 10 | +12.57% | **+5.24%** | 复杂清洁场景仍有继续训练空间 |
| 共同可行合计 | 72 | +14.46% | **+2.67%** | 复杂场景显著优于 baseline |

另有一个 3-stage 实例 baseline 无解，物理修复给出可行解，但相对 MILP 的 gap 为
256.49%；它提高了可行率，却是明确的质量离群点，因此不混入“共同可行”均值。

规模外推没有用于训练：未见的 50 片双 Job 五例 5/5 可行，makespan 为 4 平 1 胜，
平均调度时间约为 baseline 的一半；未见的单路线 1000 片排程用 2.57 秒，makespan
91,850.5 秒（25.51 小时），Schedule 与 MoveList 双层校验均为 0 违例。

完整实时压力测试位于 `tests/test_neural_long_horizon.py`：12 轮、11 次重算、累计
1000 片，最终 makespan 为 152,282.45 秒（42.30 小时）。最新回归中最慢一轮端到端
为 4.35 秒，整项前后端执行与最终状态回放约 34 秒；10 轮直接采用神经轨迹、2 轮采用
有预算物理修复，没有任何一轮落入 `failure-fallback` 或 `quality-floor-fallback`。导出后端对
LoadLock 压力/开门冲突采用单次时间线扫描，不再随 Move 数平方增长。

路线拆分困难例使用三个同优 Job、三个 LoadPort、每 Job 25 片、加工 300 秒。reference
中三个 Job 都可选 PM1–PM6；拆分组分别固定 PM1/2、PM3/4、PM5/6。四组完整前后端 A/B：

| 结果 | makespan | 说明 |
| --- | ---: | --- |
| 六腔 Neural reference | 约 4,560 秒 | 原路线标准 |
| 三条双腔 Neural | 约 4,558 秒 | reference 比率 99.94%，直接 `neural`，无 repair/fallback |
| 三条双腔 Heuristic | 约 7,461 秒 | Neural 减少 38.90% |

拆分网络端到端约为 baseline 的 24.4 倍速度；六个 PM 各处理 12 或 13 片。完整复现实验：

```bash
python scripts/benchmark_neural_route_decomposition.py
```

长途测试不再只检查“可行且快”。同一文件新增五轮/四次重算的同题质量 A/B，唯一质量
门槛是“拆分 Neural / 同一拆分计划 Heuristic ≤ 0.85”。六腔共享路线仍会执行并输出
`fullObservation`，但它仅是诊断观察项：更大的可选 PM 集合不保证当前策略一定找到更好
排程，因此不能用拆分结果与它的差值证明“路线拆分本身更优”，测试也不对两者比率设
质量断言。

最近一次中间回归中，拆分 Neural 为 13,154.81 秒，同一拆分计划的 Heuristic 为
13,310.80 秒，比率 98.83%，只改善 1.17%；六腔共享路线观察值为 14,425.01 秒。该结果
虽然略优于 baseline，但没有达到 15% 的发布门槛，所以测试保持失败，不能据此宣称长途
提升已经验收。

## 当前边界

网络决定 wafer hop、Robot 服务顺序和候选 Process Module；现有 checkpoint 默认用
`joint` 联合选锁，也可显式交给公共 Petri-ETA manager。对称独立路线族另有
同步波前归纳偏置；它是有明确充分条件的动作掩码，不用于共享 PM、多工序、清洁或明显
不平衡负载。离散轨迹安全、时间可行与设备动作可执行性分别由终态证书/Petri、
`solve_timing` 和 MoveList 状态机确认。网络或物理修复失败时才触发显式故障兜底，
不以偷偷重跑 Baseline 的方式制造质量数字。
