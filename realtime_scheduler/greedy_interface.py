"""外部 new-sa Greedy 的 ``init/update`` 调用边界。

本模块只负责发现并加载外部仓库的正式 ``CT.infer.scheduler`` 入口、转换
JSON 字符串以及串行化一次完整会话。前端计划展开、结果保存和日志记录仍由
``realtime_scheduler.server`` 负责。
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, Iterator, Mapping, Optional, Union


JsonObject = Dict[str, Any]
EXTERNAL_ROOT_ENVIRONMENT_VARIABLE = "NEW_SA_PROJECT_ROOT"
EXTERNAL_ENTRY_RELATIVE_PATH = Path("CT") / "infer" / "scheduler.py"

_SESSION_LOCK = threading.RLock()
_ENTRY_MODULE: Optional[ModuleType] = None
_ENTRY_ROOT: Optional[Path] = None


def _candidate_roots() -> list[Path]:
    """返回按优先级排列的外部 new-sa 仓库候选目录。"""
    configured = os.environ.get(EXTERNAL_ROOT_ENVIRONMENT_VARIABLE)
    current_root = Path(__file__).resolve().parents[1]
    candidates = [
        Path(configured).expanduser() if configured else None,
        current_root.parent / "new-sa",
        current_root / "new-sa",
        Path("D:/Desktop/WenJiCai/new-sa"),
    ]
    unique: list[Path] = []
    for candidate in candidates:
        if candidate is None:
            continue
        resolved = candidate.resolve()
        if resolved not in unique:
            unique.append(resolved)
    return unique


def resolve_external_root() -> Optional[Path]:
    """寻找包含正式 ``CT.infer.scheduler`` 入口的外部仓库。"""
    return next(
        (
            root
            for root in _candidate_roots()
            if (root / EXTERNAL_ENTRY_RELATIVE_PATH).is_file()
        ),
        None,
    )


def availability() -> JsonObject:
    """返回前端健康检查需要的 Greedy 可用状态与发现路径。"""
    root = resolve_external_root()
    if root is None:
        return {
            "available": False,
            "path": "",
            "error": (
                f"找不到外部 new-sa；请设置环境变量 "
                f"{EXTERNAL_ROOT_ENVIRONMENT_VARIABLE}"
            ),
        }
    return {"available": True, "path": str(root), "error": ""}


def _load_entry_module() -> ModuleType:
    """加载外部正式入口，并拒绝复用来自其他目录的同名 ``CT`` 模块。"""
    global _ENTRY_MODULE, _ENTRY_ROOT
    root = resolve_external_root()
    if root is None:
        raise RuntimeError(availability()["error"])
    if _ENTRY_MODULE is not None and _ENTRY_ROOT == root:
        return _ENTRY_MODULE

    loaded_ct = sys.modules.get("CT")
    loaded_path = getattr(loaded_ct, "__file__", None) if loaded_ct is not None else None
    if loaded_path is not None and root not in Path(loaded_path).resolve().parents:
        raise RuntimeError(
            f"当前进程已从其他目录加载 CT：{loaded_path}；请重启服务后再切换 new-sa"
        )

    root_text = str(root)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)
    module = importlib.import_module("CT.infer.scheduler")
    module_path = Path(str(getattr(module, "__file__", ""))).resolve()
    if root not in module_path.parents:
        raise RuntimeError(f"外部 Greedy 入口加载路径异常：{module_path}")
    _ENTRY_MODULE = module
    _ENTRY_ROOT = root
    return module


def _json_text(payload: Union[str, Mapping[str, Any]]) -> str:
    """把 dict 或已有 JSON 字符串转换成外部入口要求的文本。"""
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, Mapping):
        raise TypeError("Greedy init/update 输入必须是 JSON 对象或 JSON 字符串")
    return json.dumps(dict(payload), ensure_ascii=False)


@contextmanager
def session() -> Iterator[None]:
    """独占外部模块的全局 Scheduler，避免并发请求互相覆盖 init 状态。"""
    with _SESSION_LOCK:
        yield


def init(init_data: Union[str, Mapping[str, Any]]) -> None:
    """调用外部 ``CT.infer.scheduler.init`` 初始化设备拓扑。"""
    _load_entry_module().init(_json_text(init_data))


def update(update_data: Union[str, Mapping[str, Any]]) -> JsonObject:
    """调用外部 ``CT.infer.scheduler.update`` 并解析标准输出。"""
    raw_output = _load_entry_module().update(_json_text(update_data))
    output = json.loads(raw_output)
    if not isinstance(output, dict):
        raise RuntimeError("外部 Greedy update 返回值不是 JSON 对象")
    if isinstance(output.get("Info"), dict):
        output = dict(output["Info"])
    return dict(output)
