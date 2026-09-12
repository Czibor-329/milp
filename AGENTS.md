# Repository agent instructions

## Terminal dataset debugging

- AI 或开发者需要复现前端测试集时，统一从仓库根目录运行
  `.\venv\Scripts\python.exe scripts\run_dataset_suite.py`。该入口直接读取
  `realtime_scheduler/data/datasets/`，默认使用平台内置 MoveList 校验器，
  不启动 HongYe，并跳过 Baseline 以缩短调试时间。
- 先用 `--list` 查询稳定入口：
  `--list` 列设备，`--device 12kChamber --list` 列组，
  `--device 12kChamber --group 公司示例集 --list` 列测试及 ID。
- 运行整组：
  `.\venv\Scripts\python.exe scripts\run_dataset_suite.py --device 12kChamber --group 公司示例集 --strategy heuristic`。
  快速复现优先加 `--limit 3 --workers 1`；精确复现可重复传入
  `--test <测试ID或完整名称>`；需要机器可读结果时加 `--json-output <路径>`。
- 退出码 `0` 表示全部通过，`1` 表示至少一个测试失败，`2` 表示参数或运行环境错误。
  只有明确需要性能对比时才加 `--with-baseline`。

## Automated test standards

1. 使用隔离的统一入口运行自动化测试。
   - 从父仓库运行 `./venv/Scripts/python.exe scripts/run_test_suite.py`，入口会分别启动
     平台 pytest、`alg` pytest 和前端 Node 测试，不能把两个顶层 `tests` 包交给同一个
     pytest 进程收集。
   - 可用 `--suite platform`、`--suite algorithm` 或 `--suite frontend` 缩小范围；pytest
     附加参数放在 `--` 后，例如 `--suite platform -- -k workspace`。
   - 公司数据集验收仍使用 `scripts/run_dataset_suite.py`，不能以单元测试通过代替数据集验收。

2. 失败测试不是业务语义的最终事实。
   - 修改失败测试前，必须依次核对当前用户文档、正式接口、生产实现和同一边界的其它测试，
     判断是实现回归、测试夹具过期、接口迁移遗漏还是历史语义已经废弃。
   - 已有测试与当前文档冲突时，不能为了恢复绿色而修改生产实现迁就旧测试；应记录旧断言、
     当前依据和替代断言。业务意图仍不明确时保留失败并提出问题，不能自行放宽约束。
   - 不得仅因测试失败而删除测试。迁移后的测试必须继续覆盖原测试真正要防止的风险；如果风险
     已被取消，应通过新语义的正向或反向案例明确证明。

3. 按能力边界组织测试。
   - 测试文件应对应生产模块的单一能力，例如 `workspace/catalog`、`execution/batch`、
     `validation/dependencies` 或 `frontend/playback`，不得继续扩展综合性的 catch-all 测试文件。
   - 测试文件超过 800 行或一个测试类超过 30 项时必须复核拆分；新文件不得超过 1200 行。
     这是新增与重构标准，历史文件应在相关改动中逐步收敛。
   - 公共夹具放在本仓库 `tests/support/`；算法夹具放在 `alg/tests/support/`。测试文件不得从
     另一个 `test_*.py` 导入 helper，也不得跨仓库共享可变夹具。

4. 夹具必须确定、隔离并说明语义。
   - 文件写入使用 `tmp_path`、`TemporaryDirectory` 或专用临时目录；不得修改
     `realtime_scheduler/data/datasets/` 主数据。
   - 单元测试优先使用最小领域 builder；真实数据集只能用于标记为 `dataset` 的集成/验收测试，
     读取后必须复制到隔离目录。性能夹具必须固定随机种子、规模、schemaVersion 和内容哈希。
   - 不创建隐藏关键前提的万能 fixture。Machine、平台 MoveList 校验和接口 payload 使用各自
     具名 builder，参数名称应体现槽位、环境、PJob、清洁和时间语义。

5. 断言稳定契约，不绑定偶然实现。
   - 校验失败优先断言稳定错误码或结构化字段，再按需要断言用户可见文案；不得默认只检查
     `issues[0]`，除非首错顺序本身就是协议。
   - 前端业务逻辑优先测试 TypeScript 导出函数；HTML 源码扫描只保留稳定 ID、可访问性、资源
     版本和明确的架构禁令，不断言局部函数名、代码排版或整段实现字符串。
   - 前端测试必须从当前 TypeScript 源码编译临时测试模块，不能信任仓库中已有的 CJS 构建产物。

6. 明确测试层级和外部依赖。
   - 使用 `integration`、`dataset`、`performance`、`external_model` 标记区分慢测试与非仓库制品。
     缺少可选模型、HongYe 或固定性能机时应显式 skip，并说明恢复条件，不能以普通失败污染单测。
   - 时间预算测试只在文档规定的固定环境门禁；普通测试优先断言访问路径、状态和复杂度等结构性
     不变量，不能用宽松 sleep 或单次墙钟代替。

7. 重构测试必须可审计。
   - 先记录重构前可收集数、通过数、失败数和跳过数；只做搬迁时不得改变测试语义或减少覆盖。
   - 语义迁移与机械拆分分开提交或至少分开说明；交付时列出更新的旧语义、保留的真实回归、
     尚需外部环境或业务确认的测试。

## Read documentation before solving problems

1. Before analyzing, troubleshooting, or modifying a problem, read the project documentation directly related to the task.
   - At minimum, check the relevant parts of `D:/ct-scheduler-docs/README.md`, the relevant pages in `D:/ct-scheduler-docs/pages/`, and any design or constraint documents referenced at the top of source files.
   - Read only the pages relevant to the current problem; a full indiscriminate review is not required.

2. Use the documentation to establish the problem boundary, terminology, business rules, input and output constraints, current design, and validation approach before choosing a solution.
   - For scheduling problems, prioritize the problem overview and the relevant timing, Machine, LoadLock, deadlock, or strategy documentation.
   - For API problems, prioritize the corresponding API overview and object documentation.
   - For frontend problems, prioritize frontend build, versioning, and page-specific documentation.

3. Cross-check documentation conclusions against the current implementation.
   - If documentation conflicts with code, tests, or runtime behavior, identify the difference, determine which side is outdated, and synchronize it within the task scope.
   - Do not treat unverified documentation as a fact about the current system.

## Coding standards

1. Functions must have documentation.
   - Public, exported, and complex functions must describe their purpose, parameters, return value, and important side effects.
   - Simple functions should at least explain the problem they solve.

2. Source files must have documentation at the top describing their responsibility, main contents, and relationship to other modules.
   - Include important constraints, input/output formats, and business assumptions when applicable.

3. Prefer clear, common, complete words in names.
   - Use the project's established terminology and vocabulary where possible.
   - Short, obvious local variables such as loop indexes may use abbreviations.
   - Names with a broad scope, passed across functions, exposed across modules, or frequently used should use established or readily understandable complete words.
   - Avoid abbreviations that only the author can understand.

4. Long functions must include concise comments before major stages or complex branches, explaining each block's role in the overall flow rather than restating individual lines.

5. Comments and documentation strings must be written in Chinese by default.
   - Necessary English proper nouns, protocol field names, error codes, class names, and function names may remain in English.

6. Name hard-coded numbers and avoid unexplained magic numbers.
   - Numbers originating from API documentation, protocols, enumerations, business rules, or tolerances should be represented by semantic constants or enums.
   - Very local and self-explanatory values, such as list indexes or simple counts, may remain inline.

7. Do not add thin wrapper layers.
   - A function, class, or module that only forwards to another implementation must add a stable abstraction, unified semantics, error handling, resource management, or meaningful caller simplification.
   - Entry points may exist when they represent a real boundary; do not add one-line indirection merely to create the appearance of layering.

8. Decide module ownership before adding a feature.
   - Do not append a new feature to the nearest existing file by default. First identify its business capability, state ownership, input/output boundary, and callers, then place it in the module whose documented responsibility matches all four.
   - A feature with an independent lifecycle, state container, persistence format, external protocol, or background task belongs in a dedicated, specifically named module. For example, workspace CRUD, exchange-package encoding, and background transfer jobs must not share one catch-all service file.
   - If a change introduces a second independent responsibility, pushes a runtime file beyond 1500 lines, or makes the top-of-file responsibility description inaccurate, split the module in the same task. Runtime Python files have a hard limit of 2000 lines.
   - Update all imports, tests, architecture documentation, and entry points when moving ownership. Do not leave compatibility wrappers in the root package unless an explicit supported external compatibility contract requires them.
   - The only current exception is `realtime_scheduler/server.py`: it may remain solely as a no-import deprecation notice for the historical startup command. It must not start the service, import backend modules, or re-export any API.

9. Clean names when defining or moving boundaries.
   - Module, class, function, state-container, and dependency names must state the concrete capability they own. Prefer names such as `exchange_service`, `transfer_jobs`, or `workspace_repository` over vague buckets such as `utils`, `common`, `manager`, or an ever-growing generic `service`.
   - Remove stale historical names, duplicated aliases, and misleading comments as part of a move. A symbol exposed across modules must use one canonical name and one canonical import path.
   - Do not encode an obsolete file location in logs, protocol metadata, UI guidance, or tests after the implementation has moved.

10. Scheduling feature changes must update the corresponding user documentation.
   - When changing quick start, input APIs, constraint semantics, scheduling strategies, timing layers, Machine action feasibility, LoadLock management, or result analysis, update the corresponding pages in `D:/ct-scheduler-docs/pages/` and verify page switching, body rendering, and the right-side table of contents in the user-documentation tab.
   - Each Markdown file is a separate page and must retain `title`, `slug`, `group`, `order`, and `description` front matter. Its level-one heading must match `title`. Split overly long content by topic instead of continuing to expand a single page.
   - Standard API documentation must remain last in document navigation. Changes to API fields, types, enums, inheritance, or aggregation must update the API overview, device objects, job objects, and Move/output pages, not only summary fields.
   - All documentation content is owned by the separate Git repository `D:/ct-scheduler-docs`. Do not create documentation copies or old-path navigation pages in either code repository. Keep code-repository agent instructions here and point their reading requirements to the documentation repository. Runtime data ignore rules remain unchanged.

## Frontend versioning

- Do not change the frontend package version, visible frontend version, or asset cache-busting version while implementation is still in progress.
- Only bump the frontend version immediately before creating a user-requested commit.
- A version bump must update `realtime_scheduler/frontend/package.json`, `package-lock.json`, `config_editor.html`, and their version assertions together in the same commit.

## Commit messages

- Write the commit description in Chinese. The commit type may remain in English (for example, `feat: 集成 HongYe 增量输出校验`).
- Every commit must include a Chinese description body in addition to its subject, summarizing the main changes.

## Local data format

- `realtime_scheduler/data/datasets/` is the only source of truth for device and test data. Do not add a second device mirror or make runtime caches authoritative.
- Device and test directories use stable UUIDs. Human-readable names belong in JSON metadata and the frontend, not filesystem paths.
- A device `device.json` contains init data only (`Stations` and `Robots`). Routes, groups, and tests must remain in their separate files or directories.
- Every persistent format change must increment `schemaVersion`, provide an idempotent migration from the previous released version, preserve a recoverable backup, and add migration fixtures and tests.
- Import must reject newer unsupported versions and must never silently overwrite a same-ID item with different content.
- When the data layout or exchange behavior changes, update `D:/ct-scheduler-docs/pages/engineering/data-format.md` and the corresponding platform pages in the documentation repository in the same change.
