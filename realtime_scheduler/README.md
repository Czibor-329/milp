# CT 实时调度终端

此目录集中保存实时调度前端及其本地数据：

- `server.py`：本地调度服务与工作区接口。
- `frontend/`：配置终端和 MoveList 甘特图页面。
- `data/workspaces.json`：设备、设备级共享 Route/Clean、测试集任务。
- `data/devices/`：按设备 ID 独立保存的 init 信息。
- `exports/logs/`：每次运行生成的 input_data 复现日志。
- `exports/results/`：每次运行生成的统一 MoveList 与重算点。

启动：`python realtime_scheduler/server.py --port 8765 --open`

旧命令 `python scripts/config_editor_server.py` 仍可使用。
