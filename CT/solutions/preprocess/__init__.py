"""输入预处理：raw 接口（IToolTopo + IUpdateParams）→ 类化 IR（PreprocessedTask）→ build_net。

把散落的预处理逻辑统一收口于本包：双腔成对视图（dual_chamber）、
清洁条件解析 + DummyClean 合成（clean_parse）、接口补齐 + IR 派生与序列化（task_ir）。
"""

from CT.solutions.preprocess.state import State
from CT.solutions.preprocess.task_ir import (
    CJob,
    Chamber,
    Clean,
    CleanSpec,
    DummyClean,
    PJob,
    PrePrepare,
    PreprocessedTask,
    Robot,
    Route,
    StageStep,
    TransportStep,
    from_dict,
    init_topo,
    load_preprocessed,
    preprocess,
    save_preprocessed,
    to_dict,
)

__all__ = [
    "State",
    "PreprocessedTask", "Route", "StageStep", "TransportStep", "Robot", "Chamber",
    "PJob", "CJob", "Clean", "CleanSpec", "DummyClean", "PrePrepare",
    "preprocess", "save_preprocessed", "load_preprocessed",
    "init_topo", "from_dict", "to_dict",
]
