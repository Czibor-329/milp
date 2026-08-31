"""调度平台命令行参数、启动检查和 HTTP 服务生命周期。"""

from __future__ import annotations

from realtime_scheduler.backend.bootstrap import *
from realtime_scheduler.backend.workspace.repository import *
from realtime_scheduler.backend.api.http import ConfigEditorHandler

def main() -> None:
    """启动仅监听本机的多线程调度控制台服务。"""
    parser = argparse.ArgumentParser(description="CT 调度控制台本地服务")
    parser.add_argument("--host", default=DEFAULT_HOST, help="监听地址，默认仅本机")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口")
    parser.add_argument("--open", action="store_true", help="启动后打开默认浏览器")
    parser.add_argument(
        "--log-level",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        default="INFO",
        help="终端日志级别，默认 INFO",
    )
    parser.add_argument(
        "--access-log",
        action="store_true",
        help="输出逐条 HTTP 访问日志（默认关闭）",
    )
    args = parser.parse_args()
    configure_logging(args.log_level, args.access_log)
    url = f"http://{args.host}:{args.port}/"
    # 仅在版本变化或检测到外部更新文件时整理工作区；完成标记使后续启动直接跳过。
    legacy_store = DATA_DIR / "workspaces.json"
    legacy_present = legacy_store.is_file()
    legacy_directory_present = _has_separate_legacy_workspace_directory(WORKSPACE_STORE_PATH)
    if _workspace_data_update_required():
        log_startup("正在更新工作区数据…")
        _prepare_workspace_data()
        log_startup("工作区数据更新完成")
    if legacy_present:
        log_startup(f"已自动迁移旧版工作区数据：{legacy_store.name} → {WORKSPACE_STORE_PATH.name}/ 拆分目录")
        log_startup(f"原文件备份为 {legacy_store.name}.legacy.json，确认无误后可删除")
    if legacy_directory_present:
        log_startup(f"已自动迁移旧版目录：workspaces/ + devices/ → {WORKSPACE_STORE_PATH.name}/ v{WORKSPACE_STORE_VERSION}")
        log_startup("原目录已移入 data/migration-backups/，确认新版数据正常后可清理")
    log_startup("正在预热算法缓存…")
    discover_other_algorithms()
    log_startup("算法缓存预热完成")
    # 数据迁移和缓存预热全部完成后才开始监听，避免浏览器读到半迁移状态。
    server = ThreadingHTTPServer((args.host, args.port), ConfigEditorHandler)
    log_startup(f"CT 调度控制台：{url}")
    log_startup("按 Ctrl+C 停止服务")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log_startup("服务已停止")
    finally:
        server.server_close()



__all__ = ('main',)
