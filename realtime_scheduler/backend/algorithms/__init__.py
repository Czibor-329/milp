"""算法发现与运行时适配。

该包只负责定位独立算法仓库并提供稳定的标准接口；调度服务和 HTTP 层不直接
依赖算法包的目录结构。
"""

from .interface import discover_other_algorithms, init, session, update

__all__ = ["discover_other_algorithms", "init", "session", "update"]
