# Repository agent instructions

## Read documentation before solving problems

1. Before analyzing, troubleshooting, or modifying a problem, read the project documentation directly related to the task.
   - At minimum, check the relevant parts of the repository or target module's `README.md`, `docs/`, `realtime_scheduler/data/documentation/*.md`, and any design or constraint documents referenced at the top of source files.
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

8. Scheduling feature changes must update the corresponding user documentation.
   - When changing quick start, input APIs, constraint semantics, scheduling strategies, timing layers, Machine action feasibility, LoadLock management, or result analysis, update the corresponding pages in `realtime_scheduler/data/documentation/*.md` and verify page switching, body rendering, and the right-side table of contents in the user-documentation tab.
   - Each Markdown file is a separate page and must retain `title`, `slug`, `group`, `order`, and `description` front matter. Its level-one heading must match `title`. Split overly long content by topic instead of continuing to expand a single page.
   - Standard API documentation must remain last in document navigation. Changes to API fields, types, enums, inheritance, or aggregation must update the API overview, device objects, job objects, and Move/output pages, not only summary fields.
   - Documentation content is local runtime data and must remain excluded by `realtime_scheduler/data/.gitignore`. Do not remove that ignore rule merely to commit documentation changes; only documentation reading, validation, and display capabilities belong in the code repository.

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
- When the data layout or exchange behavior changes, update `docs/data-format.md`, the root `README.md`, and the frontend user documentation in the same change.
