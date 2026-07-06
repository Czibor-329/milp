# MoveList 校验逻辑

更新时间：2026-07-04

本文描述 `src/validation` 包对调度输出 `MoveList` 的目标校验算法。核心原则是：
按时间轴从前往后扫描 move；扫到一个 move 时，先检查字段完整性，再根据
init data 检查位置、时间、槽位和设备能力是否合法，最后检查它声明的
`PreMoveID` 是否覆盖所有必须已经完成的前置 move。

当前代码入口是 `src/validation/api.py::validate_move_list()`；PreMoveID 推导和图
一致性规则在 `src/validation/premove.py`；接口字段来源见
`docs/interface_doc.txt` 的 `Move类`。

## 1. 输入与输出

输入：

- `task: Problem`：解析后的内部任务模型，用于读取机器人、腔室和 LoadLock
  访问侧等语义信息。
- `moves: List[dict]`：调度输出的 `MoveList`。
- `init_data: Optional[Mapping]`：原始接口输入。存在时作为设备拓扑、槽位、
  可达性和动作时长的权威来源；不存在时只做不依赖原始接口的检查。

输出：

- 返回问题字符串列表，不抛出单个问题异常。
- 校验器不修改 `MoveList`。需要补齐依赖时使用
  `src/validation/premove.py::populate_premove_ids()` 作为单独工具。

容差：

- PreMoveID 前后时间比较使用 `1e-6`。
- 动作时长与 init data 比较使用 `1e-4`。

## 2. 总体扫描算法

完整校验按以下顺序执行：

1. 建立静态索引。
   - 建立 `MoveID -> move` 索引，并检查 `MoveID` 唯一性。
   - 从 init data 建立 `Robots`、`Stations`、station 合法槽位、机器人可达站点、
     pick/place/pretrans/prepare/complete/preprepare 时长表。
   - 读取初始材料位置、模块槽位状态、机器人槽位状态、模块压力态和
     `TimeToAvailable`。

2. 按 `(StartTime, EndTime, MoveID)` 对 move 排序。
   - 扫描时维护 `history`，表示已经出现在时间轴上的 move。
   - 扫描到当前 move 时，将 `EndTime <= 当前 StartTime + tolerance` 的 move
     视为已完成。
   - 任何被当前 move 依赖的前置 move，如果尚未完成，当前 move 非法。

3. 对当前 move 做三层检查。
   - 字段检查：检查公共字段和 MoveType 专属字段是否完整、类型是否正确。
   - init data 合法性检查：检查机器人、模块、槽位、时间、可达性、资源占用、
     压力态等是否符合初始配置和时间轴状态。
   - PreMoveID 检查：按当前 move 类型查找必须的前置 move，并确认这些 move
     已在当前 move 的 `PreMoveID` 中声明且已经执行完毕。

4. 更新时间轴状态。
   - move 通过前两层检查后，按其 `EndTime` 把状态更新事件登记到事件队列。
   - Pick 完成后，材料从 station slot 移到 robot slot。
   - Place 完成后，材料从 robot slot 移到 station slot。
   - Process 完成后，更新材料加工状态和模块状态变量。
   - PrePrepare 完成后，更新模块压力态或环境状态。
   - Prepare/Complete 完成后，更新模块门、pin、可访问状态等辅助状态。

5. 扫描结束后检查整张 PreMoveID 图。
   - 引用存在。
   - 不重复。
   - 不自环。
   - 无环。
   - 每条边满足类型、时间、站点、槽位、机器人、材料和 PJob 一致性。

## 3. MoveType 范围

接口枚举定义：

| MoveType | 名称 |
| --- | --- |
| 0 | PickMove |
| 1 | PlaceMove |
| 2 | MultiPickMove |
| 3 | MultiPlaceMove |
| 4 | SwapMove |
| 5 | PreTransMove |
| 6 | PrepareMove |
| 7 | CompleteMove |
| 8 | PostCompleteMove |
| 9 | ProcessMove |
| 10 | PrePrepareMove |
| 11 | AlignMove |

当前校验规则已经覆盖 `0/1/5/6/7/9/10`。如果输出包含 `2/3/4/8/11`，
在对应字段、时长、资源状态和 PreMoveID 规则补齐前，应按“不支持的
MoveType”报错，避免默认通过。

## 4. 字段完整性检查

### 4.1 公共字段

每个 move 都必须满足：

- `MoveID` 是正整数，且在 MoveList 内唯一。
- `MoveType` 是受支持的枚举值。
- `StartTime`、`EndTime` 是有限数字。
- `EndTime >= StartTime`。
- `ModuleName` 非空。
- `PreMoveID` 是整数列表；空依赖用 `[]`。
- 槽位字段中的槽位号必须是正整数。
- 带有多片语义的列表字段必须按 index 对齐，例如 `MatIDList`、`StepIDList`、
  `PJobName`、station list、slot list 和 robot slot list。

### 4.2 PickMove(0)

必须包含：

- `Robot`
- `RobotSlotList`
- `SrcStationList`
- `SrcSlotList`
- `MatIDList`

检查含义：

- `RobotSlotList` 表示接收晶圆的机器人槽位。
- `SrcStationList/SrcSlotList` 表示被取片的模块槽位。
- 源站槽位在当前时间必须有对应 `MatIDList` 的晶圆。
- 机器人槽位在当前时间必须为空。

### 4.3 PlaceMove(1)

必须包含：

- `Robot`
- `RobotSlotList`
- `DestStationList`
- `DestSlotList`
- `MatIDList`

检查含义：

- `RobotSlotList` 表示送片使用的机器人槽位。
- `DestStationList/DestSlotList` 表示被放片的模块槽位。
- 机器人槽位在当前时间必须持有对应 `MatIDList` 的晶圆。
- 目标站槽位在当前时间必须为空，或者业务上允许被同一原子动作替换。

### 4.4 PreTransMove(5)

必须包含：

- `Robot`
- `RobotSlotList`
- `SrcStationList`
- `DestStationList`
- 建议同时输出 `SrcSlotList`、`DestSlotList`，用于校验带片转位的源/目标槽位。

检查含义：

- 空载 PreTrans 只约束机器人当前位置和目标位置。
- 带片 PreTrans 还必须和当前机器人槽位中的材料一致。
- 预转移结束后，机器人应指向目标站点。

### 4.5 PrepareMove(6)

必须包含：

- `ModuleName`
- `SlotList`
- `RelatedActionType`
- `RelatedRobotType`

检查含义：

- 作用于 `ModuleName/SlotList` 指定的站点槽位。
- 必须发生在对应 Pick 或 Place 之前。
- 时长取决于后续消费它的 Pick/Place 及机器人类型。

### 4.6 CompleteMove(7)

必须包含：

- `ModuleName`
- `SlotList`
- `RelatedActionType`
- `RelatedRobotType`

检查含义：

- 作用于刚刚发生 Pick 或 Place 的站点槽位。
- 必须发生在对应 Pick 或 Place 之后。
- 时长取决于它前置的 Pick/Place 及机器人类型。

### 4.7 ProcessMove(9)

必须包含：

- `ModuleName`
- `SlotList`
- `ProcessRecipe`
- 产品片工艺需要 `MatIDList`、`StepIDList`、`PJobName`。

检查含义：

- 站点槽位在开始时必须被对应晶圆占用。
- `ProcessRecipe` 必须存在并适用于该模块。
- 结束后更新材料加工状态和工艺计数。

### 4.8 PrePrepareMove(10)

必须包含：

- `ModuleName`
- `SlotList`
- `LastState`
- `CurState`
- `PrePrepareType`

检查含义：

- 用于 Pump/Vent、控温或其他传输前环境准备。
- LoadLock 压力状态目前只允许 `ATM` 和 `VAC`。
- `LastState` 必须等于模块在当前时间轴状态中的上一状态。
- 完成后模块状态更新为 `CurState`。

## 5. init data 合法性检查

存在 init data 时，以下内容以 init data 为准。

### 5.1 模块和槽位

- move 引用的 station 必须存在于 `Stations`。
- station 合法槽位优先读取 `Slots`；若未配置 `Slots`，使用 `1..Capacity`。
- `SrcSlotList`、`DestSlotList`、`SlotList` 中所有槽位必须在 station 合法槽位内。
- `TimeToAvailableOfSlot[slot]` 和 `TimeToAvailableOfSlot[0]` 不得晚于 move
  对该模块或槽位的实际占用开始时间。

### 5.2 机器人和可达性

- Pick、Place、PreTrans 引用的 `Robot` 必须存在于 `Robots`。
- `RobotSlotList` 必须属于启用 arm 的 `SlotIDs`。
- 机器人访问的 station 必须在启用 arm 的 `AccessibleStations` 中。
- 如果存在 `SlotsStationMap`，还要检查 robot slot 到 station slot 的映射是否合法。
- `TimeToAvailable` 不得晚于机器人实际占用开始时间。

### 5.3 动作时长

实际时长为 `EndTime - StartTime`。存在配置时，实际时长必须等于配置时长：

| MoveType | 期望时长来源 |
| --- | --- |
| PickMove(0) | `Robot.PickTime[src_station]` |
| PlaceMove(1) | `Robot.PlaceTime[dest_station]` |
| PreTransMove(5) | `Robot.PrepTransTime` 中匹配 `SrcStation/DestStation/TransType` 的 `Time` |
| PrepareMove(6) | 后续 Pick 使用 `Station.PickPrepareTime[robot]`；后续 Place 使用 `Station.PlacePrepareTime[robot]` |
| CompleteMove(7) | 前置 Pick 使用 `Station.PickCompleteTime[robot]`；前置 Place 使用 `Station.PlaceCompleteTime[robot]` |
| ProcessMove(9) | `ProcessRecipe.Time + Visit.MoveTimeOffset[ProcessMove]` |
| PrePrepareMove(10) | `PrePrepareTime`、`PumpTime` 或 `VentTime` |

### 5.4 时间轴位置状态

按扫描状态检查：

- Pick 开始时，源站槽位必须有对应晶圆，且未被其他未完成动作占用。
- Place 开始时，目标站槽位必须可放入，机器人槽位必须有对应晶圆。
- Process 开始时，站点槽位必须有对应晶圆，且晶圆的 route step 与 recipe 匹配。
- Prepare/Complete/PrePrepare 期间，目标模块槽位不能与互斥动作非法重叠。
- LoadLock Pump/Vent 期间，所有槽位不可被 Pick、Place、Prepare、Complete 访问。

## 6. 必须的 PreMoveID 推导

校验器只要求“业务上最近且已经完成”的前置 move。查找候选前置 move 时，只从
当前 move 之前的 `history` 中查；如果候选 move 的 `EndTime` 晚于当前
`StartTime`，它不能作为已完成前置，当前 move 应报错。

### 6.1 类型允许表

显式 `PreMoveID` 边必须满足以下类型约束：

| 当前 MoveType | 允许的前置 MoveType |
| --- | --- |
| PickMove(0) | PreTrans(5), Prepare(6), PrePrepare(10) |
| PlaceMove(1) | PreTrans(5), Prepare(6), PrePrepare(10) |
| PreTransMove(5) | Pick(0), Place(1) |
| PrepareMove(6) | Pick(0), Place(1), Complete(7), Process(9), PrePrepare(10) |
| CompleteMove(7) | Pick(0), Place(1), Prepare(6), PrePrepare(10) |
| ProcessMove(9) | Complete(7) |
| PrePrepareMove(10) | Pick(0), Place(1), Complete(7), PrePrepare(10) |

### 6.2 PickMove(0)

必须查找并声明：

- 同一源站槽位、同一材料的最近 PrepareMove(6)。
- 同一机器人、目标站槽位等于 Pick 源站槽位的最近 PreTransMove(5)。
- 同一源站的最近 PrePrepareMove(10)。

如果这些前置存在但不在当前 move 的 `PreMoveID` 中，报“PreMoveID 不完整”。
如果这些前置在 `PreMoveID` 中但尚未结束，报“前置未完成”或“时间违例”。

### 6.3 PlaceMove(1)

必须查找并声明：

- 同一目标站槽位、同一材料的最近 PrepareMove(6)。
- 同一机器人、同一材料、目标站槽位等于 Place 目标站槽位的最近 PreTransMove(5)。
- 同一目标站的最近 PrePrepareMove(10)。

### 6.4 PreTransMove(5)

必须查找并声明：

- 如果 PreTrans 携带 `MatIDList`，前置是同一机器人、同一源站、同一材料的最近
  PickMove(0)。
- 如果 PreTrans 不携带材料信息，前置是同一机器人的最近 PickMove(0) 或
  PlaceMove(1)。

### 6.5 PrepareMove(6)

必须查找并声明：

- 同一站点槽位最近的 CompleteMove(7)、ProcessMove(9) 或 PrePrepareMove(10)。

该规则保证模块前一次关门、加工完成或环境准备已经结束，再开始下一次开门/准备。

### 6.6 CompleteMove(7)

必须查找并声明：

- 同一站点槽位、同一材料的最近 PickMove(0) 或 PlaceMove(1)。
- 同一站点槽位最近的 PrepareMove(6)，如果存在。

### 6.7 ProcessMove(9)

必须查找并声明：

- 同一站点槽位最近的 CompleteMove(7)。
- 如果 ProcessMove 携带 `MatIDList`，前置 CompleteMove 也必须携带同一材料。

### 6.8 PrePrepareMove(10)

必须查找并声明：

- 同一模块最近的 PrePrepareMove(10)，用于串联压力态或环境态。
- 同一站点槽位最近可能占用该槽位的 CompleteMove(7)、PickMove(0) 或
  PlaceMove(1)；如果当前 PrePrepare 携带材料信息，则要求同一材料。

## 7. PreMoveID 边一致性检查

对每条显式 `previous -> current` 边检查：

- `previous` 必须存在。
- `previous.MoveID != current.MoveID`。
- `previous.EndTime <= current.StartTime + tolerance`。
- `previous.MoveType` 在当前 MoveType 的允许前置类型表中。
- 两个 move 至少通过机器人、站点或材料之一形成业务关联。
- 两个 move 都携带 `MatIDList` 且当前类型要求材料连续时，`MatIDList` 必须一致。
- 两个 move 都携带 `PJobName` 时，`PJobName` 必须一致。
- Pick 的 Prepare/PrePrepare 前置必须指向 Pick 源站。
- Place 的 Prepare/PrePrepare/PreTrans 前置必须指向 Place 目标站。
- Complete、Process、PrePrepare 的站点槽位前置必须和当前站点槽位一致。
- PrePrepare 到 PrePrepare 的链路必须满足 `previous.CurState == current.LastState`。

整张图额外检查：

- `PreMoveID` 不得重复。
- 不得自环。
- 不得形成循环依赖。

## 8. LoadLock 压力态检查

LoadLock 压力态除 PreMoveID 外还需要独立检查：

- 同一 LoadLock 的 PrePrepareMove(10) 按时间排序后，连续转换必须满足
  `previous.CurState == next.LastState`。
- Pump/Vent 转换期间，不允许同一 LoadLock 发生 Pick、Place、Prepare 或
  Complete 访问。
- 根据 route 中 LoadLock stage 的 `ll_type` 推导机器人访问侧：
  - entry LL：`in_robot` 访问侧为 `ATM`，`out_robot` 访问侧为 `VAC`。
  - exit LL：`in_robot` 访问侧为 `VAC`，`out_robot` 访问侧为 `ATM`。
- Pick/Place 访问 LoadLock 时，访问时间点的实际压力态必须等于该机器人要求的
  压力侧；如果处于转换中，直接报错。

## 9. 错误分类建议

错误信息建议保持当前前缀风格，便于调用方过滤：

- `ML 字段违例`：字段缺失、类型错误、枚举不支持、时间反向。
- `ML 拓扑违例`：机器人不存在、模块不存在、不可达、槽位不合法。
- `ML 时长违例`：实际动作时长和 init data 不一致。
- `ML PreMoveID ...`：前置缺失、引用不存在、类型错误、时间违例、资源关联错误、
  有环。
- `ML 压力态违例`：LoadLock 状态链、转换重叠或访问侧错误。

## 10. 伪代码

```python
def validate_move_list(task, moves, init_data=None):
    issues = []
    static = build_static_indexes(task, init_data, moves)
    timeline = sorted(moves, key=(StartTime, EndTime, MoveID))
    history = []
    completed = set()
    state = build_initial_state(task, init_data)
    end_events = []

    for move in timeline:
        completed.update(
            previous.MoveID
            for previous in history
            if previous.EndTime <= move.StartTime + tolerance
        )
        apply_end_events_until(end_events, state, move.StartTime)

        issues += validate_common_fields(move, static)
        issues += validate_type_fields(move, static)
        issues += validate_init_legality(move, state, static)

        required = required_premove_ids_for_current_move(move, history, static)
        declared = set(move.PreMoveID)
        for previous_id in required:
            if previous_id not in declared:
                issues.append(missing_premove(previous_id, move.MoveID))
            elif previous_id not in completed:
                issues.append(previous_not_finished(previous_id, move.MoveID))

        for previous_id in declared:
            issues += validate_explicit_edge(previous_id, move, static)

        register_state_update_at_end(end_events, move)
        history.append(move)

    issues += validate_premove_graph_is_acyclic(moves)
    issues += validate_loadlock_pressure_state(task, moves)
    return issues
```
