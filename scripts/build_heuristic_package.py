"""构建可直接部署到调度平台的 Heuristic 精简算法包。

脚本从独立 ``alg`` 仓库读取标准入口与运行时源码，排除训练、测试、模型和
其他算法实现，并在压缩包内收紧算法白名单。输出固定包含一个顶层 ``alg``
目录，解压后可直接替换调度平台根目录中的同名目录。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from typing import Iterable
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


PYTHON_REQUIREMENT = ">=3.10"
RUNTIME_REQUIREMENTS = "numpy==2.5.0\n"
ARCHIVE_PREFIX = "alg-heuristic"
ZIP_TIMESTAMP_MINIMUM_YEAR = 1980
EXCLUDED_RUNTIME_FILES = frozenset({
    PurePosixPath("src/task_data/generator.py"),
    PurePosixPath("src/task_data/macro_rule_scenarios.py"),
    PurePosixPath("src/schedule/strategies/dual_actor_e2e.py"),
    PurePosixPath("src/schedule/strategies/e2e_ctq.py"),
    PurePosixPath("src/schedule/strategies/global_wafer.py"),
    PurePosixPath("src/schedule/strategies/loadlock_macro.py"),
    PurePosixPath("src/schedule/strategies/milp.py"),
    PurePosixPath("src/schedule/strategies/schedule_alphago_model.py"),
})
EXCLUDED_RUNTIME_DIRECTORIES = frozenset({
    PurePosixPath("src/schedule/strategies/schedule_alphago"),
})


PACKAGE_README = r"""# CT Scheduler Heuristic 部署包

这是仅包含 Heuristic 策略的精简算法运行时，可作为调度平台的完整
`CT_ALGORITHM_ROOT` 使用。

## 内容

- `src/api.py`：标准 `init/update` 企业接口。
- `src/`：Heuristic 所需编译器、状态机、时序、校验和实时重算运行时。
- `requirements.txt`：唯一第三方运行依赖 NumPy。
- `PACKAGE_INFO.json`：源码提交、构建日期和运行环境信息。

不包含 Git 历史、虚拟环境、训练数据、测试、模型、`other_alg`、E2E、
双 Actor、MILP 或 LoadLock Macro 实现。

## 安装

要求 Python 3.10 或更高版本：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 配合调度平台运行

将本目录解压到平台的 `alg/`：

```text
调度平台/
  alg/
    src/
      api.py
    requirements.txt
```

然后运行：

```powershell
.\alg\.venv\Scripts\python.exe .\realtime_scheduler\server.py --open
```

也可以放在任意目录，通过环境变量指定：

```powershell
$env:CT_ALGORITHM_ROOT = "D:\path\to\alg"
python .\realtime_scheduler\server.py --open
```

标准接口只接受 `heuristic`；传入其他算法名会明确报错。
"""


def parse_arguments() -> argparse.Namespace:
    """解析源码目录、输出目录和可选构建日期。"""
    parser = argparse.ArgumentParser(description=__doc__)
    project_root = Path(__file__).resolve().parents[1]
    parser.add_argument(
        "--source-root",
        type=Path,
        default=project_root / "alg",
        help="独立算法仓库目录，默认使用项目根目录下的 alg",
    )
    parser.add_argument(
        "--output-directory",
        type=Path,
        default=project_root / "docs",
        help="压缩包输出目录，默认使用项目 docs",
    )
    parser.add_argument(
        "--build-date",
        type=date.fromisoformat,
        default=date.today(),
        help="包版本日期，格式为 YYYY-MM-DD",
    )
    return parser.parse_args()


def git_output(source_root: Path, *arguments: str) -> str:
    """执行只读 Git 查询并返回去除首尾空白的输出。"""
    completed = subprocess.run(
        ["git", "-C", str(source_root), *arguments],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return completed.stdout.strip()


def validate_source(source_root: Path) -> str:
    """校验算法仓库与标准入口，并返回完整源码提交号。"""
    source_root = source_root.resolve()
    if not (source_root / "src" / "api.py").is_file():
        raise FileNotFoundError(f"缺少标准入口：{source_root / 'src/api.py'}")
    if not (source_root / "src").is_dir():
        raise FileNotFoundError(f"缺少运行时源码目录：{source_root / 'src'}")
    dirty_status = git_output(source_root, "status", "--porcelain")
    if dirty_status:
        raise RuntimeError("算法仓库存在未提交修改，无法生成可追溯部署包")
    return git_output(source_root, "rev-parse", "HEAD")


def iter_runtime_files(source_root: Path) -> Iterable[Path]:
    """按稳定路径顺序返回精简运行时需要的 Python 源文件。"""
    candidates = [
        path
        for runtime_directory in (source_root / "src",)
        for path in runtime_directory.rglob("*.py")
        if "__pycache__" not in path.parts
    ]
    for path in sorted(
        candidates,
        key=lambda item: item.relative_to(source_root).as_posix(),
    ):
        relative_path = PurePosixPath(path.relative_to(source_root).as_posix())
        is_excluded_directory = any(
            directory == relative_path or directory in relative_path.parents
            for directory in EXCLUDED_RUNTIME_DIRECTORIES
        )
        if (
            relative_path not in EXCLUDED_RUNTIME_FILES
            and not is_excluded_directory
        ):
            yield path


def restrict_to_heuristic(relative_path: PurePosixPath, content: bytes) -> bytes:
    """收紧包内公共入口，使精简包明确拒绝其他算法名。"""
    if relative_path == PurePosixPath("src/api.py"):
        text = content.decode("utf-8")
        pattern = r"SUPPORTED_ALGORITHMS = frozenset\(\{.*?\}\)"
        text, replacement_count = re.subn(
            pattern,
            'SUPPORTED_ALGORITHMS = frozenset({"heuristic"})',
            text,
            count=1,
            flags=re.DOTALL,
        )
        if replacement_count != 1:
            raise RuntimeError("无法收紧 src/api.py 的算法白名单")
        telemetry_reset_pattern = (
            r"\r?\n        from src\.schedule\.strategies\.schedule_alphago"
            r"\.telemetry import \(\r?\n"
            r"            reset_schedule_alphago_telemetry,\r?\n"
            r"        \)\r?\n\r?\n"
            r"        reset_schedule_alphago_telemetry\(\)\r?\n"
        )
        text, reset_replacement_count = re.subn(
            telemetry_reset_pattern,
            "\n",
            text,
            count=1,
        )
        if reset_replacement_count != 1:
            raise RuntimeError("无法移除 heuristic 初始化中的搜索遥测依赖")
        return text.encode("utf-8")
    return content


def zip_info(archive_path: PurePosixPath, build_date: date) -> ZipInfo:
    """创建带稳定日期和 Unix 普通文件权限的 ZIP 条目信息。"""
    timestamp = datetime.combine(build_date, datetime.min.time())
    if timestamp.year < ZIP_TIMESTAMP_MINIMUM_YEAR:
        raise ValueError("ZIP 构建日期不能早于 1980-01-01")
    info = ZipInfo(str(archive_path), timestamp.timetuple()[:6])
    info.compress_type = ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    return info


def build_archive(
    source_root: Path,
    output_directory: Path,
    build_date: date,
    source_commit: str,
) -> Path:
    """写入精简源码、部署说明和元数据，并返回 ZIP 路径。"""
    short_commit = source_commit[:7]
    archive_name = (
        f"{ARCHIVE_PREFIX}-{build_date.strftime('%Y%m%d')}-{short_commit}.zip"
    )
    output_directory.mkdir(parents=True, exist_ok=True)
    archive_path = (output_directory / archive_name).resolve()

    runtime_entries: list[tuple[PurePosixPath, bytes]] = []
    for source_path in iter_runtime_files(source_root):
        relative_path = PurePosixPath(source_path.relative_to(source_root).as_posix())
        content = restrict_to_heuristic(relative_path, source_path.read_bytes())
        runtime_entries.append((PurePosixPath("alg") / relative_path, content))

    package_info = {
        "name": "ct-scheduler-heuristic-runtime",
        "source_commit": short_commit,
        "source_commit_full": source_commit,
        "built_at": build_date.isoformat(),
        "python": PYTHON_REQUIREMENT,
        "algorithms": ["heuristic"],
    }
    generated_entries = [
        (
            PurePosixPath("alg/PACKAGE_INFO.json"),
            (json.dumps(package_info, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        ),
        (PurePosixPath("alg/README.md"), PACKAGE_README.encode("utf-8")),
        (PurePosixPath("alg/requirements.txt"), RUNTIME_REQUIREMENTS.encode("utf-8")),
    ]

    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for entry_path, content in sorted(
            runtime_entries + generated_entries,
            key=lambda item: str(item[0]),
        ):
            archive.writestr(zip_info(entry_path, build_date), content)
    return archive_path


def archive_sha256(archive_path: Path) -> str:
    """计算部署包的 SHA-256，便于交付时核对完整性。"""
    digest = hashlib.sha256()
    with archive_path.open("rb") as archive_file:
        for chunk in iter(lambda: archive_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    """校验干净源码仓库，构建部署包并输出机器可读摘要。"""
    arguments = parse_arguments()
    source_root = arguments.source_root.resolve()
    source_commit = validate_source(source_root)
    archive_path = build_archive(
        source_root,
        arguments.output_directory.resolve(),
        arguments.build_date,
        source_commit,
    )
    summary = {
        "archive": str(archive_path),
        "bytes": archive_path.stat().st_size,
        "sha256": archive_sha256(archive_path),
        "source_commit": source_commit,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
