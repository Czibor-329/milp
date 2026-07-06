# 标准接口当前实现手册

更新时间：2026-06-14

本文只描述当前实现、接口边界和待确认问题，不记录历史 Task 或实施过程。项目使用
`PurePetriEngine` 作为唯一执行后端，企业平台通过 `CT.infer.scheduler.init/update`
调用标准接口。

## 1. 调用入口

### 1.1 企业平台入口

```python
from CT.infer.scheduler import init, update

init(topo_data_json)
alg_output_json = update(tool_json)
```

- `init(topo_data)`：保存并校验设备拓扑、机械手、模块和时间配置。
- `update(tool_json)`：读取本次任务快照，构建设备与 Job，运行调度并返回 `AlgOutput`。
- 输入既可以是裸 JSON，也可以是 `{Time, Describe, SimTime, Info}` 包装 JSON。
- 包装输入返回包装输出；裸输入返回裸 `Info`。

### 1.2 内部执行层与开发工具

企业标准输入与执行不得绕过 `CT.infer.scheduler.init/update`。内部调用层级为：

```text
CT.infer.scheduler
-> CT.infer.function
-> StandardScheduler
-> runner
-> adapter / PurePetriEngine / GreedyScheduler
-> AlgOutput
```

- `StandardScheduler`：标准输入初始化和调度执行门面。
- `run_standard_schedule()`、`run_standard_schedule_files()`：Scheduler 使用的内部运行实现。
- `scripts/run_standard_interface.py`：本地文件调试工具。
- `scripts/check_standard_interface_acceptance.py`：本地样例语义验收。
- `scripts/fake_company_platform.py`：从重新打包的 zip 调用正式 `init/update` 的平台验收。
- `scripts/export_acceptance_assets.py`：企业组合日志资产导出。

## 2. 输入处理

### 2.1 拓扑

当前读取 Robot、Station、Capacity、Slots、ArmInfo、时间字段和模块运行态。

主要模块映射：

| 接口模块 | 内部资源 |
| --- | --- |
| LP/P1 等 | LoadPort |
| LA/LB/LC/LD | LoadLock |
| PM、MultiProcessChamber、heater | ProcessChamber |
| Cool/Cooler | Cooler；无显式 Buffer 时可承接 BufferOption |
| 显式 `Type=Buffer` | Buffer |
| Aligner | Aligner |
| DummyPort | Dummy 入口 |

`heater` 是真空侧工艺模块，不是 Buffer。强制 Buffer 优先使用显式 Buffer；设备没有
显式 Buffer 时才使用 Cool/Cooler。

### 2.2 机械手

- `AccessibleStations` 是可达模块硬约束。
- `SlotsStationMap` 同时约束 robot slot 与 station slot，也可声明组合站点。
- `IsEnable=false` 的 arm 不参与候选。
- `SlotAtStation` 恢复机械手初始位置，用于首个 PreTrans 起点。
- `MultiTrans/CanMultiTrans=true` 且双臂、站点槽位和 Route 均合法时，可生成双片原子搬运。

同一原子双片动作继续输出普通 `PickMove(0)`、`PlaceMove(1)` 和
`PreTransMove(5)`，不输出独立 `MultiPickMove(2)`、`MultiPlaceMove(3)`。

### 2.3 Station 槽位

PM、LoadLock、Buffer、Cooler、Aligner 使用数字物理槽位。候选槽位必须同时满足：

1. Route `Visit.SlotID` 允许。
2. ArmInfo 映射允许。
3. 槽位为空。
4. `TimeToAvailableOfSlot` 已到期。

`TimeToAvailableOfSlot[0]` 表示模块级最早可用时间，非零 key 表示具体槽位。
机械手还需满足自身 `TimeToAvailable`。

Cooler 和显式 Buffer 按 `MaterialCount` 最小值选择合法槽位，相同时保持 Route
槽位顺序。双腔 PM 不使用该均衡规则。

### 2.4 LoadLock

- LoadLock 使用数字物理槽位，不存在永久 `in/out` 槽。
- 同一 LL 的槽位共享模块压力状态。
- ATM/VTR 访问侧变化按 `PrePrepareTime` 或设备 Pump/Vent 配置转换。
- Pump/Vent 期间所有槽位不可访问。
- 单片允许通过；双片必须在同一原子 binding 内成组，不允许先放一片再补一片。
- `SlotsStationMap` 明确组合站点时，支持 `LA+LB`、`LC+LD` 各一片的同步搬运。

真实 Pump/Vent 转换输出为 `PrePrepareMove(10)`。

### 2.5 双腔 PM

`dual_chamber_non_cascade` 的双槽 PM 具有槽位级占用：

- `Visit.SlotID` 是硬约束。
- `SlotPriority` 只决定 PM 空闲时单片优先槽。
- PM 已占用、加工中或等待出片时，不允许向另一槽补片。
- 满载 PM 只有在两片均加工完成且换入片同时 ready 时，才允许原子 `2入2出` Swap。
- `MaterialCount` 读取、更新并进入 snapshot，当前不参与 PM 选槽。

## 3. Route 与时间约束

### 3.1 Route

- `PostStepID=[x]` 支持单一非连续后继。
- 原生多个后继目前不作为通用流程图解释。
- `Group`、`Material.Name` 等字段保存在 metadata。
- `MoveTimeOffset` 按已支持 MoveType 增加动作时长；未知 MoveType 直接报错。
- `AlignmentTime` 控制 AlignMove 时长。

### 3.2 BufferOption

| 值 | 当前行为 |
| --- | --- |
| 0 | 不要求 Buffer |
| 1 | LoadLock 出片后、回 LoadPort 前强制经过 Buffer/Cooler |
| 2 | 离开 LoadPort 后、进入 LoadLock 前强制经过 Buffer/Cooler |
| 3/4 | 字段可读取，但尚不是完整业务可选策略 |

Route 已有合适 Cool 步时不会重复插入模块，而是标记该步满足 BufferOption。
`JobList.OccupiedBuffer` 只记录实际承接 BufferOption 的资源。

### 3.3 Q-time 与 Residency

两类约束独立：

- Residency：PM 加工完成到机械手开始从该 PM 取片。
- Q-time：上一 PM 加工完成到下一 PM 真正开始加工。

`-1` 表示不启用，正值按秒计时。超时分别报告：

- `residency_timeout`
- `qtime_timeout`

业务优先级高于 deadline；同一业务优先级内优先处理剩余时间更短的晶圆。

## 4. Job 与 admission

### 4.1 ControlJob 与 ProcessJob

- 一个 ControlJob 对应一个 LoadPort 下的一组 PJob。
- `PJobNameList` 决定 PJob 顺序。
- `ProcessJob.MatList` 是晶圆归属和基础顺序的权威来源。
- 同一 CJob 下 PJob 必须来自同一 LoadPort。
- PJob 不能被多个 CJob 引用，也不能在同一 CJob 中重复引用。
- `Material.Priority` 参与同一 PJob 内排序；数值越小优先级越高。
- 同一 CJob、同 `ProcessJob.Priority` 且加工路线结构相同的 PJob 按 `PJobNameList`
  顺序串行。加工路线签名只看站点 / NeedProcess / ProcessRecipe 的逐 Visit 结构，
  与 `OriginRoute.Name` 无关；加工路线不同则仍可并发。

### 4.2 TaskMode

| 值 | 模式 | 当前 admission |
| --- | --- | --- |
| 0 | Smart | 允许可运行任务并发，受模块 reservation 和优先级约束 |
| 1 | Pipeline | 下一 PJob 在上一 PJob 最后一片离开 LP 后允许发片 |
| 2 | Sequential | 下一 PJob 在上一 PJob 全部返回后允许发片 |
| 3 | Concurrent | PJob 同时允许发片 |

同一次 update 混用 TaskMode 或使用未知值会直接报错。

### 4.3 CJobType

当前支持 `NormalLot`、`HighestLot`、`HigherLot`。未明确业务语义的
`ManualJob`、`TransferJob`、`DummySeason` 直接报错，避免伪造调度规则。

admission 先比较 CJobType、CJob Priority、CJob 输入顺序，再比较 PJob Priority、
PJob 顺序、Material Priority、MatList 顺序、deadline 和动作效率。

## 5. 清洗、Dummy 与 Swap

### 5.1 清洗

标准接口 BySequenceClean 已接入 PurePetri，支持：

- PreClean
- Wac
- PostClean
- DummyClean
- DummyWac

Dummy 是真实 token，必须经过 DummyPort、LoadLock、PM 并返回 DummyPort。
`ByChamberClean`、`PostCJob` 和完整运行中清洗重算尚未实现。

同一 CJob、同优先级、同加工路线结构且排在更前面的 PJob 会成为后序 PJob
`pre / dummy / dummy_wac` 清洗任务的串行前序。前序 PJob 的产品片全部 finished
之前，后序清洗保持 `unresolved`，不激活 Dummy token、不占用共享 PM；前序完成后
再按原条件转入 `pending` 或继续等待 IdleTime。

`ProcessRecipes.Weight` 已接入数值型状态变量更新：产品片完成 PM 加工后，
按实际 recipe 的 Weight 累加 `PJob + PM + VariableName` 维度计数。
Wac 的 `ProcessCount` 不再固定按片数加一，而是读取
`Weight.ProcessCount`。`PreJuge=true` 时使用“当前值 + 下一片 recipe
Weight”判断是否提前触发。当前仍不实现 `ComputeRule`、覆盖型状态变量和
clean 后复杂赋值公式。

### 5.2 SwapMove

- Swap 是一个不可中断的原子 binding，输出单条 `MoveType=4`。
- 直接交换组件时间来自 `picktime + placetime`，不读取独立 SwapMoveTime。
- 完整时长还包括必要 `PrepTransTime/transfer_times`、开关门和 LL Pump/Vent。
- 机械手移动时间严格按 `(SrcStation, DestStation, TransType)` 四元组读取；`TransType=0` 为空手移动，`TransType=1` 为持片移动。缺失、重复或非法值视为接口/配置错误，直接停止。
- 支持单片、双片及 guard 允许的不对称交换。
- 双片 pick/place 是同步动作，组件耗时取成员最大值，不按晶圆数求和。
- Cooler 有空槽且机械手槽位受限时优先先放再取。
- 输出层将目标侧交换展开为 `PrepareMove(6) + PreTransMove(5) + SwapMove(4) + CompleteMove(7)`；目标侧 Prepare 等待其 `PreMoveID` 中声明的前置完成动作，PreTrans 可与源侧 Complete 并行。

Swap 字段采用机械手视角：

- `RecvMatList`：机械手从模块取出的晶圆。
- `SendMatList`：机械手放入模块的晶圆。
- `StnRecvSlotList`：模块接收换入片的槽位。
- `StnSendSlotList`：模块发送换出片的槽位。

## 6. 输出

`AlgOutput.Info` 固定包含：

- `MoveList`
- `Feedback`
- `JobList`
- `DummyReturnInfo`
- `MatIntoPM`

输出约束：

- 非 ProcessMove 的 `PJobName=[]`。
- ProcessMove 保留所属 PJob、ProcessRecipe、CleanTaskName。
- `MatIntoPM` 固定为 `MatID -> [PM]`。
- 槽位型模块输出真实 `SlotList/SrcSlotList/DestSlotList`。
- 双片原子动作的各列表按同一 index 对齐。
- 默认不输出 `PostCompleteMove(8)`，相关时间折入 CompleteMove。
- `PreMoveID` 只引用最终仍存在且时间不晚于当前 Move 的动作。

## 7. 重算边界

当前重算支持：

- 物料当前位置和 StepID。
- PM/LL/Buffer/Cooler/Aligner 模块及槽位最早可用时间。
- 机械手最早可用时间与初始位置。
- 最近一次 MoveState、JobState 的保存。

尚未支持：

- 运行中 Move 的 firing 和剩余时间恢复。
- `RemoveList` 对动作依赖链的完整处理。
- 运行中清洗、Dummy 在途和剩余清洗时间恢复。
- JobState 的暂停、取消、恢复等业务状态迁移。

## 8. 明确未实现或待甲方确认

| 功能 | 当前状态 | 实现前需要的信息 |
| --- | --- | --- |
| BufferOption 3/4 | 不是完整可选策略 | WPH 目标、统计窗口、是否走 Buffer 和停留时间 |
| MultiPick/MultiPlace 2/3 | 不输出独立类型 | 与普通双片 Move 的边界、时间和依赖 |
| BoundedStepIDs | 未参与 admission | 约束对象、范围和分支语义 |
| ModuleState 完整状态机 | 只处理已明确的阻塞状态 | 枚举含义、转换和恢复时点 |
| ProcessingState | 未恢复 | 与 StepID、加工中、等待取片的对应关系 |
| JobState | 只保存 | 暂停、取消、恢复、完成规则 |
| ManualJob/TransferJob/DummySeason | 当前报错 | 装载、抢占、纯搬运和 DummySeason 规则 |
| CJob 抢占 | 只排序，不中断 | 抢占点、资源释放、在制晶圆和恢复规则 |
| 多机械手臂独立并发 | 未显式建模 | arm 独立运动、异向旋转和冲突规则 |
| StateVariable 完整计算 | 只支持 Weight 数值累加的核心路径 | ComputeRule、Route/Foup/Recipe/Lot overwrite 全部已实现 |

## 9. 验证

```powershell
python -m pytest tests -q
python scripts/check_standard_interface_acceptance.py `
  --root docs/接口 `
  --scheduler greedy `
  --max-moves 1200 `
  --require-samples
python scripts/export_acceptance_assets.py
python scripts/build_company_acceptance_package.py --with-venv
```

正式验收 MoveList 位于 `out/acceptance/v0.1.0/`。企业原始接口资料和日志含
B/C 级内容，只允许保存在私有仓库中，访问和分发遵循 `SECURITY.md`。
