"""旧版启动命令的弃用提示入口。

真实服务入口已迁移到 ``realtime_scheduler.backend.main``。本文件刻意不导入
任何后端实现，也不会自动启动服务；它只帮助使用旧命令的操作者切换到新命令。
"""

from __future__ import annotations

import sys


def main() -> None:
    """打印正式启动命令，并保留用户输入的命令行参数供复制。"""
    arguments = " ".join(sys.argv[1:])
    command = "python -m realtime_scheduler.backend.main"
    if arguments:
        command = f"{command} {arguments}"
    print("提示：realtime_scheduler/server.py 已不再作为服务启动入口。")
    print(f"请改用：{command}")


if __name__ == "__main__":
    main()
