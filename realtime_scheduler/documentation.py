"""读取本地 Markdown 教学文档并提供稳定的页面数据契约。

正文以 ``realtime_scheduler/data/documentation/*.md`` 保存且不进入 Git。
每个 Markdown 文件对应左侧导航中的一个独立页面；本模块只负责元数据解析、
排序和基本校验，Markdown 到 HTML 的转换由浏览器端完成。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Dict


DOCUMENTATION_SCHEMA_VERSION = 2
_FRONT_MATTER_BOUNDARY = "---"
_SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class DocumentationError(ValueError):
    """表示本地文档缺失、元数据无效或页面契约冲突。"""


def _parse_front_matter(path: Path, source: str) -> tuple[Dict[str, str], str]:
    """解析简单的 ``key: value`` YAML front matter 和 Markdown 正文。"""
    lines = source.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != _FRONT_MATTER_BOUNDARY:
        raise DocumentationError(f"文档 {path.name} 缺少开头的 --- 元数据块")

    metadata: Dict[str, str] = {}
    closing_index = -1
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == _FRONT_MATTER_BOUNDARY:
            closing_index = index
            break
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, raw_value = line.partition(":")
        if not separator or not key.strip() or not raw_value.strip():
            raise DocumentationError(
                f"文档 {path.name} 第 {index + 1} 行元数据应为 key: value"
            )
        metadata[key.strip()] = raw_value.strip().strip("\"'")
    if closing_index < 0:
        raise DocumentationError(f"文档 {path.name} 的元数据块没有结束 ---")

    markdown = "\n".join(lines[closing_index + 1 :]).strip()
    if not markdown:
        raise DocumentationError(f"文档 {path.name} 的 Markdown 正文不能为空")
    return metadata, markdown


def _required_metadata(metadata: Dict[str, str], key: str, path: Path) -> str:
    value = metadata.get(key, "").strip()
    if not value:
        raise DocumentationError(f"文档 {path.name} 缺少元数据 {key}")
    return value


def _load_page(path: Path) -> Dict[str, Any]:
    """读取一个 Markdown 文件并生成可直接返回给前端的页面对象。"""
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as error:
        raise DocumentationError(f"读取本地文档 {path.name} 失败：{error}") from error

    metadata, markdown = _parse_front_matter(path, source)
    title = _required_metadata(metadata, "title", path)
    group = _required_metadata(metadata, "group", path)
    slug = metadata.get("slug", path.stem).strip()
    if not _SLUG_PATTERN.fullmatch(slug):
        raise DocumentationError(
            f"文档 {path.name} 的 slug 只能包含小写字母、数字和连字符"
        )
    try:
        order = int(metadata.get("order", "0"))
    except ValueError as error:
        raise DocumentationError(f"文档 {path.name} 的 order 必须是整数") from error
    if not re.search(rf"^#\s+{re.escape(title)}\s*$", markdown, re.MULTILINE):
        raise DocumentationError(
            f"文档 {path.name} 正文必须包含与 title 一致的一级标题：# {title}"
        )
    return {
        "slug": slug,
        "title": title,
        "group": group,
        "order": order,
        "description": metadata.get("description", "").strip(),
        "markdown": markdown,
    }


def load_documentation(directories: Path | Iterable[Path]) -> Dict[str, Any]:
    """聚合一个或多个 Markdown 页面目录并返回统一导航数据。

    本地使用手册可以继续放在 ``data/documentation``；算法仓库维护的接口
    文档从其版本化目录直接读取。不同来源仍共用 slug 唯一性与 order 排序，
    因而前端无需了解页面来自哪个仓库。
    """
    source_directories = (
        [directories]
        if isinstance(directories, Path)
        else [Path(directory) for directory in directories]
    )
    paths = sorted(
        path
        for directory in source_directories
        if directory.is_dir()
        for path in directory.glob("*.md")
        if path.is_file()
    )
    if not paths:
        raise DocumentationError(
            "文档尚未配置，请在 realtime_scheduler/data/documentation/ 或"
            "算法仓库 docs/documentation/ 下提供至少一个 .md 文件"
        )

    pages = [_load_page(path) for path in paths]
    pages.sort(key=lambda page: (page["order"], page["title"], page["slug"]))
    seen_slugs: set[str] = set()
    for page in pages:
        if page["slug"] in seen_slugs:
            raise DocumentationError(f"文档页面 slug 重复：{page['slug']}")
        seen_slugs.add(page["slug"])
    return {"schemaVersion": DOCUMENTATION_SCHEMA_VERSION, "pages": pages}
