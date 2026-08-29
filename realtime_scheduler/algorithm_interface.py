"""``other_alg`` 标准算法包的发现与 ``init/update`` 调用边界。

外部策略只能由服务扫描 ``alg/other_alg`` 下的目录包获得。算法包既可以
保留交付目录中的 ``CT/infer`` 层，也可以把 ``infer``、``ropn_sa`` 和
``config`` 直接放在算法目录下。所有调用都在独占会话中执行，切换算法时
会清理上一算法的同名 Python 模块。
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
# 公司端按 ``src.infer.scheduler`` 约定的交付布局（如 HeteroGraph）。
SRC_ENTRY_RELATIVE_PATH = Path("src") / "infer" / "scheduler.py"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
ALGORITHM_ROOT = Path(
    os.environ.get("CT_ALGORITHM_ROOT", str(PROJECT_ROOT / "alg"))
).expanduser().resolve()
# 外部策略入口固定在算法仓库的 other_alg 子目录；如需整体迁移算法仓库，
# 只允许通过 CT_ALGORITHM_ROOT 调整仓库根目录，避免形成第二套导入位置。
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

    每个算法目录必须包含 ``CT/infer/scheduler.py``、``infer/scheduler.py``
    或 ``src/infer/scheduler.py`` 之一，目录名同时作为稳定算法 ID。

    每次调用都重新扫描目录；新增或删除算法包后刷新前端即可看到最新列表。
    """
    if not OTHER_ALGORITHM_ROOT.is_dir():
        algorithms: list[JsonObject] = []
    else:
        algorithms = []
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
                        SRC_ENTRY_RELATIVE_PATH,
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


def _selected_entry() -> Path:
    """返回当前会话选定的 ``other_alg`` 算法根目录。"""
    algorithm_id = getattr(_ACTIVE_ALGORITHM, "algorithm_id", None)
    if not algorithm_id:
        raise RuntimeError("调用标准算法前必须指定 other_alg 算法 ID")
    item = next(
        (
            discovered
            for discovered in discover_other_algorithms()
            if str(discovered["id"]).casefold() == str(algorithm_id).casefold()
        ),
        None,
    )
    if item is None:
        raise RuntimeError(f"other_alg 中找不到标准算法包：{algorithm_id}")
    return Path(str(item["path"])).resolve()


def _module_belongs_to_root(module: ModuleType, root: Path) -> bool:
    """判断已加载模块的源文件是否来自指定算法目录。"""
    module_path = getattr(module, "__file__", None)
    if not module_path:
        return False
    resolved_module_path = Path(str(module_path)).resolve()
    try:
        resolved_module_path.relative_to(root)
    except (OSError, ValueError):
        return False
    return True


def _unload_previous_algorithm(entry_path: Path) -> None:
    """卸载上一算法的模块并移除搜索路径，避免同名包串用。"""
    for module_name, module in list(sys.modules.items()):
        if isinstance(module, ModuleType) and _module_belongs_to_root(module, entry_path):
            sys.modules.pop(module_name, None)
    for namespace in ("CT", "CT.infer"):
        sys.modules.pop(namespace, None)
    # ``src`` 布局（``src/infer/scheduler.py``）：算法创建的顶层 ``src``
    # 包已按文件路径在开头卸载；平台内置 src 包（alg/src）必须保留，
    # 只需移除加载时追加的算法目录，避免误删平台对 src.compiler 等的引用。
    # 无 __file__ 的算法 namespace 包在这里整包清理，防止残留。
    if (entry_path / SRC_ENTRY_RELATIVE_PATH).is_file():
        src_module = sys.modules.get("src")
        if src_module is not None and getattr(src_module, "__path__", None):
            algorithm_src_text = str(entry_path / "src")
            src_path = src_module.__path__  # type: ignore[attr-defined]
            while algorithm_src_text in src_path:
                src_path.remove(algorithm_src_text)
            if getattr(src_module, "__file__", None) is None:
                for namespace in ("src", "src.infer"):
                    sys.modules.pop(namespace, None)
    search_roots = (
        [entry_path.parent]
        if entry_path.is_file()
        else [entry_path, entry_path / "CT"]
    )
    for search_root in search_roots:
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


def _prepare_src_namespace(entry_path: Path) -> None:
    """让公司端 ``src.infer.scheduler`` 布局在平台已加载顶层 ``src`` 包时可解析。

    平台内置算法启动即占用顶层 ``src`` 包名（``alg/src``）。此时把算法目录
    的 ``src/`` 追加到 ``src.__path__``，``src.infer`` 即可解析到算法自身，
    同时 ``src.compiler`` 等平台模块仍按原路径解析，互不干扰；无平台 ``src``
    时按常规导入由 importlib 自动创建包，无需额外处理。
    """
    src_module = sys.modules.get("src")
    if src_module is None or not getattr(src_module, "__path__", None):
        return
    algorithm_src_text = str(entry_path / "src")
    src_path = src_module.__path__  # type: ignore[attr-defined]
    if algorithm_src_text not in src_path:
        src_path.append(algorithm_src_text)


def _load_entry_module() -> ModuleType:
    """加载当前标准算法入口；目录内代码变化后自动卸载并重新导入。"""
    global _ENTRY_MODULE, _ENTRY_ROOT, _ENTRY_REVISION
    entry_path = _selected_entry()
    revision = algorithm_revision(entry_path)
    if (
        _ENTRY_MODULE is not None
        and _ENTRY_ROOT == entry_path
        and _ENTRY_REVISION == revision
    ):
        return _ENTRY_MODULE

    if _ENTRY_ROOT is not None:
        _unload_previous_algorithm(_ENTRY_ROOT)
    _ENTRY_MODULE = None
    _ENTRY_ROOT = None
    _ENTRY_REVISION = None
    _purge_algorithm_bytecode(entry_path)

    # 入口布局优先级与 discover_other_algorithms 保持一致：
    # CT/infer/scheduler.py 与 infer/scheduler.py 都通过 CT.infer.scheduler
    # 导入（后者由 _prepare_ct_namespace 合成 CT 命名空间）；src/infer/
    # scheduler.py 布局直接按公司端约定的 src.infer.scheduler 导入。
    use_src_layout = (
        not (entry_path / EXTERNAL_ENTRY_RELATIVE_PATH).is_file()
        and not (entry_path / PACKAGED_ENTRY_RELATIVE_PATH).is_file()
        and (entry_path / SRC_ENTRY_RELATIVE_PATH).is_file()
    )
    search_roots = [entry_path]
    if (entry_path / "CT").is_dir():
        search_roots.insert(0, entry_path / "CT")
    for search_root in reversed(search_roots):
        search_root_text = str(search_root)
        if search_root_text not in sys.path:
            sys.path.insert(0, search_root_text)
    if use_src_layout:
        _prepare_src_namespace(entry_path)
    else:
        _prepare_ct_namespace(entry_path)
    importlib.invalidate_caches()
    module = importlib.import_module(
        "src.infer.scheduler" if use_src_layout else "CT.infer.scheduler"
    )
    module_path = Path(str(getattr(module, "__file__", ""))).resolve()
    if entry_path not in module_path.parents:
        raise RuntimeError(f"标准算法入口加载路径异常：{module_path}")
    _ENTRY_MODULE = module
    _ENTRY_ROOT = entry_path
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
    """调用当前算法的 ``update`` 并解析标准输出。

    输出既可以是 JSON 字符串，也可以是直接返回的 dict（单文件登记算法
    常见做法），两者都会被解析成标准输出对象。
    """
    raw_output = _load_entry_module().update(_json_text(update_data))
    if isinstance(raw_output, Mapping):
        output = dict(raw_output)
    else:
        output = json.loads(raw_output)
    if not isinstance(output, dict):
        raise RuntimeError("标准算法 update 返回值不是 JSON 对象")
    if isinstance(output.get("Info"), dict):
        output = dict(output["Info"])
    return dict(output)
