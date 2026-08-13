"""本地 Markdown 教学文档读取契约的回归测试。"""

from __future__ import annotations

import pytest

from realtime_scheduler.documentation import DocumentationError, load_documentation


def _write_page(
    directory,
    filename: str = "01-quick-start.md",
    *,
    slug: str = "quick-start",
    title: str = "快速开始",
    group: str = "快速上手",
    order: int = 10,
) -> None:
    """写入满足最小契约的单页 Markdown 测试数据。"""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / filename).write_text(
        "\n".join([
            "---",
            f"title: {title}",
            f"slug: {slug}",
            f"group: {group}",
            f"order: {order}",
            "description: 本地启动说明",
            "---",
            "",
            f"# {title}",
            "",
            "## 启动服务",
            "",
            "运行 `python realtime_scheduler/server.py`。",
        ]),
        encoding="utf-8",
    )


def test_load_documentation_accepts_and_orders_markdown_pages(tmp_path) -> None:
    """Markdown 页面应按 order 排序并保持原始正文。"""
    directory = tmp_path / "documentation"
    _write_page(directory, "02-input.md", slug="input", title="输入接口", order=20)
    _write_page(directory, order=10)

    loaded = load_documentation(directory)

    assert loaded["schemaVersion"] == 2
    assert [page["slug"] for page in loaded["pages"]] == ["quick-start", "input"]
    assert "## 启动服务" in loaded["pages"][0]["markdown"]


def test_load_documentation_merges_platform_and_algorithm_pages(tmp_path) -> None:
    """平台本地文档和算法仓库文档应进入同一份有序导航。"""
    platform_directory = tmp_path / "platform"
    algorithm_directory = tmp_path / "algorithm"
    _write_page(platform_directory, order=10)
    _write_page(
        algorithm_directory,
        "20-api.md",
        slug="algorithm-api",
        title="算法接口",
        group="算法接口",
        order=200,
    )

    loaded = load_documentation((platform_directory, algorithm_directory))

    assert [page["slug"] for page in loaded["pages"]] == [
        "quick-start",
        "algorithm-api",
    ]


def test_load_documentation_reports_missing_directory(tmp_path) -> None:
    """文档未部署时应返回可执行的 Markdown 目录提示。"""
    with pytest.raises(DocumentationError, match="data/documentation"):
        load_documentation(tmp_path / "documentation")


def test_load_documentation_rejects_duplicate_slugs(tmp_path) -> None:
    """重复页面 slug 会破坏左侧换页，加载阶段必须拒绝。"""
    directory = tmp_path / "documentation"
    _write_page(directory)
    _write_page(directory, "02-copy.md", slug="quick-start", title="另一个页面", order=20)

    with pytest.raises(DocumentationError, match="slug 重复"):
        load_documentation(directory)


def test_load_documentation_requires_matching_h1(tmp_path) -> None:
    """一级标题必须与导航标题一致，避免页面标题和目录名称脱节。"""
    directory = tmp_path / "documentation"
    _write_page(directory)
    page = directory / "01-quick-start.md"
    page.write_text(page.read_text(encoding="utf-8").replace("# 快速开始", "# 错误标题"), encoding="utf-8")

    with pytest.raises(DocumentationError, match="一级标题"):
        load_documentation(directory)
