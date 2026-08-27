# HongYe 输出校验器

该目录把 HongYe 的 `SchStateLib.dll` 作为独立输出校验组件集成到调度平台。
服务端为每次运行启动一个 `HongYeValidator.exe`，通过 JSON Lines 逐条发送
`AlgInit`、`AlgSchedule`、`AlgUpdateMove` 和 `AlgOutput`。收到 `AlgOutput` 时，
校验器按 `module-parallel` 推进并立即返回错误、警告和计划时长差异。

每个 `AlgSchedule` 都是该代的完整现场快照。首排之后收到新的 `AlgSchedule` 时，
Python 会先发送 `reset`，再补发 `AlgInit` 和当前 `AlgSchedule`；因此 HongYe 独立
校验每一代 `AlgOutput`，不会用新一代 Material 状态回头重放旧计划。平台侧复现日志
仍保留全部 `AlgUpdateMove` 和各代输入输出。

`runtime/` 是最小运行目录，只包含：

- `HongYeValidator.exe` 与 .NET Framework 配置；
- `SchStateLib.dll`；
- `Newtonsoft.Json.dll`。

原 CheckMinLog 中的 Python 启动脚本、报告、示例、HTML、`Python.Runtime.dll`、
`log4net.dll`、`Adapter4Scheduler.dll` 和 `SchedulerStandardInterface.dll` 均不参与
当前增量校验路径。

修改 `Program.cs` 后，在本目录执行：

```powershell
dotnet build HongYeValidator.csproj -c Release
Copy-Item bin/Release/net472/HongYeValidator.exe runtime/ -Force
Copy-Item bin/Release/net472/HongYeValidator.exe.config runtime/ -Force
```
