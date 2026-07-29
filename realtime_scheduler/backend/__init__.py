"""调度平台后端能力。

本包承载浏览器之外的业务能力。前端只能通过 HTTP 契约使用这些能力，不能直接
导入或复制其中的分析、持久化与调度规则。
"""

from .analysis import (
    analyze_schedule_performance,
    analyze_test_group_performance,
    build_schedule_analysis_context,
    summarize_bottleneck_utilization,
)

__all__ = [
    "analyze_schedule_performance",
    "analyze_test_group_performance",
    "build_schedule_analysis_context",
    "summarize_bottleneck_utilization",
]
