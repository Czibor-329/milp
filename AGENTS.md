# Repository agent instructions

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
