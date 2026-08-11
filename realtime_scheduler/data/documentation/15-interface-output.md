---
title: 标准接口：Move、输出与事件参数
slug: interface-output
group: 标准接口
order: 140
description: 完整列出 Move 基类及子类型、Move 状态、输出对象、规划 Job、Dummy 返回和事件参数。
---

# 标准接口：Move、输出与事件参数

本页说明平台与算法之间交换的结果格式，主要面向开发和对接人员。普通使用者只需在结果页查看“校验”和“总耗时”，无需阅读或导出这些字段。

算法通过 `IOutputParams` 输出绝对时间 MoveList 和辅助规划信息。Move 子类型继承 `IMove` 公共字段，再增加各自动作所需的 Station、Slot、Arm、Recipe 或状态字段。

## IMove 公共字段

| 字段 | 类型 | 说明及约束 |
| --- | --- | --- |
| `ModuleName` | `string` | 动作执行模块。Robot 动作通常填写 Robot 名称。 |
| `MoveType` | `MoveType` | `Pick=0`、`Place=1`、`MultiPick=2`、`MultiPlace=3`、`Swap=4`、`PreTrans=5`、`Prepare=6`、`Complete=7`、`PostComplete=8`、`Process=9`、`PrePrepare=10`、`Align=11`。 |
| `MatIDList` | `IList<int>` | 动作涉及的物料 IDs。 |
| `StepIDList` | `IList<int>` | 按 `MatIDList` 下标对齐的标准 Route Step IDs；必须使用原始 `IRouteStep.StepID`，不得写算法内部压缩后的 stage 下标。具体动作语义见下文。 |
| `MoveID` | `int` | Move 唯一标识。 |
| `RequestID` | `int` | 所属调度/重算请求 ID。 |
| `PJobName` | `IList<string>` | 各物料所属 PJob。 |
| `TaskID` | `IList<string>` | 各物料所属 Task/CJob。 |
| `StartTime` | `double` | 绝对开始时刻。 |
| `EndTime` | `double` | 绝对规划结束时刻，必须不早于 StartTime。 |
| `PreMoveID` | `IList<int>` | 前置 Move IDs；表达依赖关系，不等同于数组顺序。 |

## StepID 字段标准

`StepIDList[i]` 表示 `MatIDList[i]` 在该动作完成后应处于的 Route Step。Route 中的 Robot Visits 也是不可省略的正式步骤；算法内部即使只保留 Station stage，也必须在输出时还原原始 Robot StepID。

| MoveType | StepID 输出标准 |
| --- | --- |
| `Pick=0` / `MultiPick=2` | 填写物料 Pick 完成、落到 Robot 后的 Robot Route Step；该 Step 的 `Visits` 必须包含 `ModuleName` 对应 Robot。不能继续填写源 Station Step。 |
| `Place=1` / `MultiPlace=3` | 填写物料 Place 完成后的目标 Station Route Step；该 Step 的 `Visits` 必须包含对应的 `DestStationList[i]`。不能填写 Robot Step 或源 Station Step。 |
| `Swap=4` | `RecvMatStepIDList` 填 Station 旧片被 Robot 接收后的 Robot Step；`SendMatStepIDList` 填 Robot 新片落入 Station 后的目标 Station Step。公共 `MatIDList` 按 `RecvMatList + SendMatList` 排列，公共 `StepIDList` 按相同顺序拼接。 |
| `PreTrans=5` | 不改变物料 Route Step。空载转位应省略物料和 Step 字段；带片转位若携带 `StepIDList`，只能保持当前 Robot Step，不能借 PreTrans 推进 Route。 |
| `Prepare=6` / `Complete=7` / `PostComplete=8` | 门动作不推进 Route。Step 字段可省略；若输出 `StepIDList`，则必须与 `MatIDList`、`SlotList` 按下标对齐，并保持物料当前 Step。 |
| `Process=9` | 填写正在执行工艺的 Station Route Step，且该 Step 的 `NeedProcess=true`。标准输出使用列表字段 `StepIDList`，不使用旧版标量 `StepID`。 |
| `PrePrepare=10` / `Align=11` | 设备状态动作不推进 Route；若携带物料 Step，只能填写物料当前所在 Step。 |

例如 Route 为 `LP1(Step 0) → ATR(Step 1) → LB(Step 2)`，从 LP1 搬到 LB 的 Pick 必须输出 `StepIDList=[1]`，随后的 Place 必须输出 `StepIDList=[2]`。

所有存在的非空、按物料展开的列表都必须严格按 index 对齐。单片动作中相应列表长度为 1，双片动作相应为长度 2。不能用单个 Slot 值代表两个物料，也不能用内部 stage 下标代替 Route StepID。

## Pick、Place、MultiPick 与 MultiPlace

| 子接口 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| `IPickMove` | `RobotSlotList` | `IList<int>` | 使用的 Robot Slot。 |
| `IPickMove` | `SrcStationList` | `IList<string>` | 源模块列表。 |
| `IPickMove` | `SrcSlotList` | `IList<int>` | 源模块 Slot 列表。 |
| `IPlaceMove` | `RobotSlotList` | `IList<int>` | 使用的 Robot Slot。 |
| `IPlaceMove` | `DestStationList` | `IList<string>` | 目标模块列表。 |
| `IPlaceMove` | `DestSlotList` | `IList<int>` | 目标模块 Slot 列表。 |
| `IMultiPickMove` | `RobotSlotList` | `IList<int>` | 多 Arm Robot Slots。 |
| `IMultiPickMove` | `SrcStationList` | `IList<string>` | 多片源模块列表。 |
| `IMultiPickMove` | `SrcSlotList` | `IList<int>` | 多片源 Slots。 |
| `IMultiPlaceMove` | `RobotSlotList` | `IList<int>` | 多 Arm Robot Slots。 |
| `IMultiPlaceMove` | `DestStationList` | `IList<string>` | 多片目标模块列表。 |
| `IMultiPlaceMove` | `DestSlotList` | `IList<int>` | 多片目标 Slots。 |

> [!WARNING] **接口支持 MultiPick 不代表当前安全策略允许连续独立 Pick** — 双臂死锁预防仍遵循“一次只举起一片；Pick 后只允许 Swap 或 Place”。组合动作必须作为经过 Machine 验证的完整原子事务。

## IPreTransMove 与 ISwapMove

| 子接口 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| `IPreTransMove` | `RobotSlotList` | `IList<int>` | 关联 Robot Slots。 |
| `IPreTransMove` | `SrcStationList` | `IList<string>` | 源模块。 |
| `IPreTransMove` | `SrcSlotList` | `IList<int>` | 源 Slots。 |
| `IPreTransMove` | `DestStationList` | `IList<string>` | 目标模块。 |
| `IPreTransMove` | `DestSlotList` | `IList<int>` | 目标 Slots。 |
| `IPreTransMove` | `RalatedActionType` | `ActionType` | 关联动作：place/doubleplace=0、pick/doublepick=1、swap=2。标准表字段拼写为 `RalatedActionType`。 |
| `ISwapMove` | `StnRecvSlotList` | `IList<int>` | Station 接收新片的目标 Slots。 |
| `ISwapMove` | `StnSendSlotList` | `IList<int>` | Station 送出旧片的源 Slots。 |
| `ISwapMove` | `StationList` | `IList<string>` | 执行 Swap 的模块。 |
| `ISwapMove` | `RecvSlotList` | `IList<int>` | Robot 接收旧片的 Pick Slots。 |
| `ISwapMove` | `SendSlotList` | `IList<int>` | Robot 发送新片的 Place Slots。 |
| `ISwapMove` | `RecvMatList` | `IList<int>` | 从 Station 取出的旧片 IDs。 |
| `ISwapMove` | `SendMatList` | `IList<int>` | 放入 Station 的新片 IDs。 |
| `ISwapMove` | `SwapMode` | `SwapMode` | `0=pick first`、`1=place first`。 |
| `ISwapMove` | `RecvMatStepIDList` | `IList<int>` | 按 `RecvMatList` 对齐；旧片从 Station 被接收到 Robot 后的 Robot Route Step IDs。 |
| `ISwapMove` | `SendMatStepIDList` | `IList<int>` | 按 `SendMatList` 对齐；新片从 Robot 放入 Station 后的目标 Station Route Step IDs。 |

## Process、PrePrepare、Prepare 与完成动作

| 子接口 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| `IProcessMove` | `ProcessRecipe` | `string` | 工艺/Clean/Cooling Recipe。 |
| `IProcessMove` | `CleanTaskName` | `string` | CleanTask 名；普通产品工艺或 Cooling 置空。 |
| `IProcessMove` | `SlotList` | `IList<int>` | 关联模块 Slots。 |
| `IProcessMove` | `IsLastCleanTaskMove` | `bool` | 是否为该 CleanTask 最后一个 ProcessMove。 |
| `IProcessMove` | `IsLastMove` | `bool` | 是否为 CJob 内该 PM 最后一次使用，供 CTC 判断释放。 |
| `IPrePrepareMove` | `LastState` | `string` | 模块转换前状态。 |
| `IPrePrepareMove` | `CurState` | `string` | 模块转换后状态。 |
| `IPrePrepareMove` | `PrePrepareType` | `string` | Pump、Vent、旋转、控温等具体类型。 |
| `IAlignMove` | - | - | 无新增字段，使用 IMove 公共字段描述校准动作。 |
| `IPrepareMove` | `SlotList` | `IList<int>` | Prepare 关联模块 Slots。 |
| `IPrepareMove` | `RelatedActionType` | `ActionType` | place/doubleplace=0、pick/doublepick=1、swap=2。 |
| `IPrepareMove` | `RelatedRobotType` | `RobotType` | `1=真空手`、`2=大气手`。 |
| `ICompleteMove` | `RelatedActionType` | `ActionType` | 与完成动作对应的 Pick/Place/Swap 类型。 |
| `ICompleteMove` | `RelatedRobotType` | `RobotType` | `1=真空手`、`2=大气手`。 |
| `IPostCompleteMove` | `RelatedRobotType` | `RobotType` | PostComplete 关联 Robot 类型。 |

## IMoveStateInfo 重算状态

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `MoveID` | `int` | 对应旧计划 Move。 |
| `StartTime` | `double` | 实际/计划开始时间。 |
| `EndTime` | `double` | 实际结束时间；尚未结束给 `-1`。 |
| `MoveState` | `MoveState` | `Running=0`、`Done=1`、`Aborted=2`。 |

重算必须先回放 Running/Done Move 对 Robot、Station、Slot、门和压力的影响，再应用 `RemoveList`。不能把“出现在 RemoveList”直接理解为资源已经释放。

## IOutputParams 全部字段

| 字段 | 类型 | 子对象/说明 |
| --- | --- | --- |
| `MoveList` | `IList<IMove>` | 完整动作计划。 |
| `Feedback` | `IList<string>` | 算法通知，例如 Dummy 片不足。 |
| `JobList` | `IList<IPlannedJob>` | 规划后的 CJob 完成信息。 |
| `DummyReturnInfo` | `IDictionary<int,IList<IRouteList>>` | key 为 Dummy MatID，value 为 Dummy 关联产品任务和 Route。 |
| `MatIntoPM` | `IDictionary<int,IList<string>>` | key 为产品 MatID，value 为实际进入过的 PM 名称列表。 |

## IPlannedJob、IRouteList 与事件参数

| 对象 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| `IPlannedJob` | `TaskID` | `string` | CJob ID。 |
| `IPlannedJob` | `JobEndTime` | `double` | CJob 最后一片晶圆回到 LoadPort 的时间。 |
| `IPlannedJob` | `OccupiedBuffer` | `string` | 算法规划占用的 Buffer。 |
| `IRouteList` | `TaskID` | `string` | Dummy 片关联产品片 CJobID。 |
| `IRouteList` | `PJobName` | `string` | 关联 PJob 名称。 |
| `IRouteList` | `RouteRecipe` | `IRoute` | 算法为 Dummy 片规划的 Route。 |
| `IRouteList` | `CleanTaskName` | `string` | Dummy 片关联 CleanTask。 |
| `IRouteList` | `AlgorithmCount` | `int` | 该 Dummy 是 CleanTask 需要的第几片。 |
| `OutputEventArgs` | `OutputParams` | `IOutputParams` | 输出事件负载。 |
| `DeadLockEventArgs` | `DeadLockInfo` | `IList<string>` | 死锁详细信息。 |
| `SchedulerStateChangedArgs` | `SchedulerState` | `SchedulerState` | `Idle=0`、`Running=1`。 |

## 输出前最低校验

- 所有列表型 Move 字段长度必须与涉及的物料数量和 Robot Slots 一致。
- Pick、Place、Swap、Process 必须输出原始 Route StepID；不得输出内部 station stage 下标，也不得跳过 ATR/VTR 等 Robot Step。
- `StartTime/EndTime`、`PreMoveID` 与资源时间线不得矛盾。
- Pick/Place/Swap 的 Station Slot 与 Robot Slot 必须存在且可达。
- MoveType 与实际子接口字段必须匹配，不能用空字段冒充另一动作类型。
- MoveList 需要通过独立整机状态回放；校验失败的更短 Makespan 不是有效结果。
