# Repository agent instructions

## Frontend versioning

- Do not change the frontend package version, visible frontend version, or asset cache-busting version while implementation is still in progress.
- Only bump the frontend version immediately before creating a user-requested commit.
- A version bump must update `realtime_scheduler/frontend/package.json`, `package-lock.json`, `config_editor.html`, and their version assertions together in the same commit.
