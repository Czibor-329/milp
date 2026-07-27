"""独立算法仓库中 ``other_alg`` 标准算法包的发现与 ``init/update`` 调用边界。

算法包既可以保留交付目录中的 ``CT/infer`` 层，也可以把 ``infer``、
``ropn_sa`` 和 ``config`` 直接放在算法目录下。所有调用都在独占会话中
执行，切换算法时会清理上一算法的同名 Python 模块。
"""

from __future__ import annotations

import importlib
import hashlib
import json
import os
import re
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, Iterator, Mapping, Optional, Union


JsonObject = Dict[str, Any]
EXTERNAL_ENTRY_RELATIVE_PATH = Path("CT") / "infer" / "scheduler.py"
PACKAGED_ENTRY_RELATIVE_PATH = Path("infer") / "scheduler.py"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
ALGORITHM_ROOT = Path(
    os.environ.get("CT_ALGORITHM_ROOT", str(PROJECT_ROOT / "alg"))
).expanduser().resolve()
OTHER_ALGORITHM_ROOT = ALGORITHM_ROOT / "other_alg"
OTHER_ALGORITHM_STRATEGY_PREFIX = "other_alg:"
ALGORITHM_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

_SESSION_LOCK = threading.RLock()
_ACTIVE_ALGORITHM = threading.local()
_ENTRY_MODULE: Optional[ModuleType] = None
_ENTRY_ROOT: Optional[Path] = None
_ENTRY_REVISION: Optional[str] = None

ALGORITHM_SOURCE_SUFFIXES = frozenset({
    ".py", ".json", ".yaml", ".yml", ".toml", ".npz", ".npy", ".pt",
    ".pth", ".pkl", ".joblib",
})
IGNORED_ALGORITHM_DIRECTORIES = frozenset({
    "__pycache__", ".git", ".pytest_cache", ".mypy_cache", ".venv", "venv",
    "results", "exports",
})


def algorithm_revision(root: Path) -> str:
    """计算算法包的确定性内容指纹，用于热重载与实验复现。

    指纹只纳入代码、配置与常见模型文件，并排除缓存、版本库和运行结果目录。
    读取文件内容而非仅依赖修改时间，避免文件被复制或时间戳被保留时漏掉改动。
    """
    resolved_root = root.resolve()
    digest = hashlib.sha256()
    files = sorted(
        (
            path for path in resolved_root.rglob("*")
            if path.is_file()
            and path.suffix.lower() in ALGORITHM_SOURCE_SUFFIXES
            and not any(part in IGNORED_ALGORITHM_DIRECTORIES for part in path.relative_to(resolved_root).parts)
        ),
        key=lambda path: path.relative_to(resolved_root).as_posix(),
    )
    for path in files:
        relative_path = path.relative_to(resolved_root).as_posix()
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def discover_other_algorithms() -> list[JsonObject]:
    """扫描 ``other_alg`` 一级子目录并返回可供前端选择的标准算法。

    每个算法目录必须包含 ``CT/infer/scheduler.py`` 或
    ``infer/scheduler.py``，目录名同时作为稳定算法 ID。
    """
    if not OTHER_ALGORITHM_ROOT.is_dir():
        return []
    algorithms: list[JsonObject] = []
    for root in sorted(
        (path for path in OTHER_ALGORITHM_ROOT.iterdir() if path.is_dir()),
        key=lambda path: path.name.casefold(),
    ):
        if not ALGORITHM_ID_PATTERN.fullmatch(root.name):
            continue
        entry_path = next(
            (
                root / relative_path
                for relative_path in (
                    EXTERNAL_ENTRY_RELATIVE_PATH,
                    PACKAGED_ENTRY_RELATIVE_PATH,
                )
                if (root / relative_path).is_file()
            ),
            None,
        )
        if entry_path is None:
            continue
        algorithms.append({
            "id": root.name,
            "name": root.name,
            "strategy": f"{OTHER_ALGORITHM_STRATEGY_PREFIX}{root.name}",
            "path": str(root.resolve()),
            "entry": str(entry_path.relative_to(root).as_posix()),
            "available": True,
            "revision": algorithm_revision(root),
        })
    return algorithms


def resolve_other_algorithm_root(algorithm_id: str) -> Optional[Path]:
    """按已发现的稳定 ID 返回本仓库算法目录，拒绝路径穿越。"""
    if not ALGORITHM_ID_PATTERN.fullmatch(str(algorithm_id or "")):
        return None
    expected = (OTHER_ALGORITHM_ROOT / algorithm_id).resolve()
    return next(
        (
            Path(str(item["path"]))
            for item in discover_other_algorithms()
            if item["id"] == algorithm_id and Path(str(item["path"])) == expected
        ),
        None,
    )


def _selected_root() -> Path:
    """返回当前会话选定的算法根目录。"""
    algorithm_id = getattr(_ACTIVE_ALGORITHM, "algorithm_id", None)
    if not algorithm_id:
        raise RuntimeError("调用标准算法前必须指定 other_alg 算法 ID")
    root = resolve_other_algorithm_root(str(algorithm_id))
    if root is None:
        raise RuntimeError(f"other_alg 中找不到标准算法包：{algorithm_id}")
    return root


def _module_belongs_to_root(module: ModuleType, root: Path) -> bool:
    """判断已加载模块的源文件是否来自指定算法目录。"""
    module_path = getattr(module, "__file__", None)
    if not module_path:
        return False
    try:
        Path(str(module_path)).resolve().relative_to(root)
    except (OSError, ValueError):
        return False
    return True


def _unload_previous_algorithm(root: Path) -> None:
    """卸载上一算法的模块并移除搜索路径，避免同名包串用。"""
    for module_name, module in list(sys.modules.items()):
        if isinstance(module, ModuleType) and _module_belongs_to_root(module, root):
            sys.modules.pop(module_name, None)
    for namespace in ("CT", "CT.infer"):
        sys.modules.pop(namespace, None)
    for search_root in (root, root / "CT"):
        search_root_text = str(search_root)
        while search_root_text in sys.path:
            sys.path.remove(search_root_text)


def _purge_algorithm_bytecode(root: Path) -> None:
    """删除算法目录内可再生成的字节码，避免同秒同尺寸改动命中旧缓存。"""
    for cache_directory in root.rglob("__pycache__"):
        if not cache_directory.is_dir():
            continue
        for bytecode_path in cache_directory.glob("*.pyc"):
            try:
                bytecode_path.unlink()
            except OSError:
                continue


def _prepare_ct_namespace(root: Path) -> None:
    """为去掉外层 ``CT`` 的标准包创建兼容命名空间。"""
    if (root / EXTERNAL_ENTRY_RELATIVE_PATH).is_file():
        return
    namespace = ModuleType("CT")
    namespace.__package__ = "CT"
    namespace.__path__ = [str(root)]  # type: ignore[attr-defined]
    sys.modules["CT"] = namespace


def _load_entry_module() -> ModuleType:
    """加载当前标准算法入口；目录内代码变化后自动卸载并重新导入。"""
    global _ENTRY_MODULE, _ENTRY_ROOT, _ENTRY_REVISION
    root = _selected_root()
    revision = algorithm_revision(root)
    if _ENTRY_MODULE is not None and _ENTRY_ROOT == root and _ENTRY_REVISION == revision:
        return _ENTRY_MODULE

    if _ENTRY_ROOT is not None:
        _unload_previous_algorithm(_ENTRY_ROOT)
    _ENTRY_MODULE = None
    _ENTRY_ROOT = None
    _ENTRY_REVISION = None
    _purge_algorithm_bytecode(root)

    search_roots = [root]
    if (root / "CT").is_dir():
        search_roots.insert(0, root / "CT")
    for search_root in reversed(search_roots):
        search_root_text = str(search_root)
        if search_root_text not in sys.path:
            sys.path.insert(0, search_root_text)
    _prepare_ct_namespace(root)
    importlib.invalidate_caches()
    module = importlib.import_module("CT.infer.scheduler")
    module_path = Path(str(getattr(module, "__file__", ""))).resolve()
    if root not in module_path.parents:
        raise RuntimeError(f"标准算法入口加载路径异常：{module_path}")
    _ENTRY_MODULE = module
    _ENTRY_ROOT = root
    _ENTRY_REVISION = revision
    return module


def _json_text(payload: Union[str, Mapping[str, Any]]) -> str:
    """把 dict 或已有 JSON 字符串转换成标准入口要求的文本。"""
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, Mapping):
        raise TypeError("标准算法 init/update 输入必须是 JSON 对象或 JSON 字符串")
    return json.dumps(dict(payload), ensure_ascii=False)


@contextmanager
def session(algorithm_id: str) -> Iterator[None]:
    """独占算法模块的全局 Scheduler，并在会话内固定算法 ID。"""
    with _SESSION_LOCK:
        previous = getattr(_ACTIVE_ALGORITHM, "algorithm_id", None)
        _ACTIVE_ALGORITHM.algorithm_id = algorithm_id
        try:
            yield
        finally:
            _ACTIVE_ALGORITHM.algorithm_id = previous


def init(init_data: Union[str, Mapping[str, Any]]) -> None:
    """调用当前算法的 ``CT.infer.scheduler.init`` 初始化设备拓扑。"""
    _load_entry_module().init(_json_text(init_data))


def update(update_data: Union[str, Mapping[str, Any]]) -> JsonObject:
    """调用当前算法的 ``CT.infer.scheduler.update`` 并解析标准输出。"""
    raw_output = _load_entry_module().update(_json_text(update_data))
    output = json.loads(raw_output)
    if not isinstance(output, dict):
        raise RuntimeError("标准算法 update 返回值不是 JSON 对象")
    if isinstance(output.get("Info"), dict):
        output = dict(output["Info"])
    return dict(output)
