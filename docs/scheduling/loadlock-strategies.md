# LoadLock 双槽交换与群控策略对比

## 结论

PSE300 的 LA/LB 在设备文件中各有两个物理槽：`IN` 与 `OUT`。旧解析器却把所有
LoadLock 的 `Capacity` 强制钳为 1，导致后续虽然已经实现 `swap=True`、跨槽压力边和
同门 place→pick 合并，调度器仍永远看不到第二个槽。现已保留设备真实容量：

- `disabled`：把 LoadLock 当作整腔单槽互斥，复现旧基线；
- `enabled`：entry 使用槽 0，exit 使用槽 1，允许异型晶圆共存；
- `auto`：同时评估上述两种资源口径，返回 makespan 更短的可行轨迹。

交换不是简单放宽容量。`sequencing` 仍用 Petri 终态可达性过滤动作，`solve_timing`
通过同一 LoadLock 的跨槽 `ll_seq` 约束单一压力状态，MoveList 导出只在同一 Robot、
同一门且时间连续时合并中间关门/开门，最后再经过完整状态回放。

## 文献映射

LoadLock 可近似看作只有“大气层/真空层”的两层电梯，但有两个重要差异：每次 entry
都会产生未来 exit 请求，而且运行方向由 Pump/Vent、Robot、PM 和槽位共同约束。因此
这里只复现群控规则的决策结构，不照搬乘客电梯的距离公式。

| 项目实现 | 文献对应 | 两层 LoadLock 化简 |
| --- | --- | --- |
| `petri-eta` | 多电梯按服务完成时间分配；Petri 标识上搜索可达调度 | 报价包含锁释放、空抽/空充、Robot hop、门和载片压力转换 |
| `collective-look` | collective/LOOK 的同向集选思想 | 两层下退化为“先服务当前压力侧”，即先避免一次空压力循环 |
| `round-robin` | 群控公平基线 | 选择累计服务次数最少的锁，再以 ETA 打破平局 |
| `dedicated-direction` | 多电梯 zoning/direction constraint；cluster tool 的 LoadLock dedication | LA 优先 entry、LB 优先 exit；首选锁不安全时允许回退 |
| `exchange-look` | cluster tool 的 swap sequence | 优先保留同锁反向 token，制造一次开门内 place→pick 的配对机会 |
| `joint` | 现有 Neural 联合动作空间 | 网络同时决定 wafer hop 与物理 LA/LB，不经过独立 manager |

主要依据：

- Lin 与 Fu 把多电梯的移动、上下客、换向建成 Timed Place Petri Net，并在可达图上用
  启发式搜索生成在线调度；这对应本项目“规则只排序、Petri 网决定动作能否执行”的分层。
  [Petri Net Based Dynamic Scheduling of an Elevator System](https://doi.org/10.1109/ROBOT.1996.503594)
- Kuroda 与 Nakata 以平均服务完成时间为多车电梯群控目标，并显式考虑 zone、direction
  和 call direction 约束；本项目的 ETA、方向分区是其在两层压力系统上的轻量化对应。
  [An Algorithm to Minimize Average Service Completion Time for the Group Controller of Multi-Car Elevator Systems](https://doi.org/10.1093/ietfec/e91-a.11.3215)
- Christopher 的 300 mm cluster tool 模型明确包含两台 LoadLock、每台一个 `IN` 和一个
  `OUT` 槽，并比较 LLA、LLB、DUAL dedication。论文也指出最优 dedication 随产品组合和
  工艺时间变化，不能把单一规则当成普适最优。
  [Study of Optimal Load Lock Dedication for Cluster Tools](https://informs-sim.org/wsc08papers/264.pdf)
- Lee、Kim 与 Lee 用 Petri net 和 MILP 研究 lot switching，并把 backward 与 swap
  sequence 发展为实用启发式，核心目标是同时避免死锁和无谓延迟。
  [Scheduling Lot Switching Operations for Cluster Tools](https://doi.org/10.1109/TSM.2013.2281083)
- Sakai 与 Nishi 说明 swap sequence 是先卸载已加工晶圆、再立即装入后继晶圆，并在非循环
  场景同时优化 residency 与 makespan；这支持把交换作为独立物理维度而非某个 manager
  名称的隐含副作用。
  [Noncyclic Scheduling of Dual-Armed Cluster Tools for Minimization of Wafer Residency Time and Makespan](https://doi.org/10.1177/1687814017693217)

## 当前基准结果

运行：

```powershell
.\venv\Scripts\python.exe scripts\benchmark_loadlock_strategies.py
```

完整逐组合结果写入 `results/loadlock_strategy_benchmark.json`。PSE300 三个代表场景的
交换效果如下；所有结果均通过 `check_solution` 和 MoveList 状态回放校验：

| 场景 | 禁用交换基线 | 启用交换 | makespan 改善 | 同门交换对 |
| --- | ---: | ---: | ---: | ---: |
| 12 片、20 s 快工艺 | 696.70 | 684.89 | 1.70% | 10 |
| 12 片、70 s 慢工艺 | 996.70 | 697.06 | 30.06% | 10 |
| 8+8 片、20/70 s 混流 | 1149.21 | 887.48 | 22.77% | 13 |

为了分离 manager 本身的作用，还应看 `disabled` 子表：

- 慢工艺：固定锁 `996.70`；ETA `841.33`；collective LOOK `841.18`；round-robin
  `841.33`；方向分区 `843.36`；exchange LOOK `841.33`。
- 快慢混流：固定锁 `1149.21`；ETA、collective LOOK、round-robin 和 exchange LOOK
  均为 `1076.79`；方向分区仍为 `1149.21`。

启用双槽交换后，这组三个场景中交换轨迹已经优于所有 manager 动态绑定轨迹，所以最终
质量地板选择了固定腔分配下的 swap 路径，各 manager 的 makespan 相同。这不是策略失效，
而是说明此处收益主要来自“恢复真实双槽物理能力”，其次才是 LA/LB 群控规则。后续比较应
加入不同 Pump/Vent、初始压力、锁故障/延迟和更多 Route mix，才能放大 manager 间差异。
