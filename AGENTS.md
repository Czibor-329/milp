# Repository agent instructions

## Frontend versioning

- Do not change the frontend package version, visible frontend version, or asset cache-busting version while implementation is still in progress.
- Only bump the frontend version immediately before creating a user-requested commit.
- A version bump must update `realtime_scheduler/frontend/package.json`, `package-lock.json`, `config_editor.html`, and their version assertions together in the same commit.

## Commit messages

- Write the commit description in Chinese. The commit type may remain in English (for example, `feat: 集成 HongYe 增量输出校验`).
- Every commit must include a Chinese description body in addition to its subject, summarizing the main changes.
