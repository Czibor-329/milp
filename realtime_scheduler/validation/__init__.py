"""调度输出校验器。

该包统一放置平台可选择的输出校验实现。原平台校验仍位于
``realtime_scheduler.move_validation``；HongYe 校验通过独立进程隔离 .NET
Framework 状态机，避免把 CLR 生命周期和服务端 Python 进程耦合。
"""
