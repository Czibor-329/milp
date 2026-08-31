# HongYe 输出校验器

该目录把 CheckMinLog 原始包的 `MoveStateSim.exe` 和 `SchStateLib.dll` 作为独立
输出校验组件集成到调度平台。服务端先收集一次运行的完整日志，再按原始
`check_log.py` 的文件协议调用 `MoveStateSim.exe --advance module-parallel`，读取
`replay_modes.json` 中的 module-parallel 结果。当前集成的 CheckMinLog 版本为
`2026.08.31.2309`：同一 Move 的 `MoveState=0/1` 会按 Start/End 成对抵消，只有
“有 Start 无 End”才恢复为跨重算在飞动作。校验器不参与平台运行时状态推进，也不
跨请求保留会话。

平台兼容推进器使用相同时间语义：不同 `ModuleName` 独立并行，同一 Module 内按
计划时刻与 MoveID 串行；Move 必须等待本代 `PreMoveID` 全部实际结束，延迟后的
实际 StartTime/EndTime 同步用于重算切点、现场投影和最终甘特图。

`runtime/` 包含原始 CheckMinLog 运行依赖：

- `MoveStateSim.exe` 及配置文件；
- `SchStateLib.dll`、`Newtonsoft.Json.dll`；
- `SchedulerStandardInterface.dll`。

原始包中的 `Adapter4Scheduler.dll`、`Python.Runtime.dll` 和 `log4net.dll` 不会被
MoveStateSim 的日志校验路径加载，已通过逐项隔离启动验证，不随平台部署。
