"""兼容旧启动命令；规范实现位于 realtime_scheduler.server。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from realtime_scheduler.server import *  # noqa: F401,F403
from realtime_scheduler.server import main


if __name__ == "__main__":
    main()
