# Health And Runtime

OpenCanon should be either working or explicitly unhealthy. Hidden degraded modes are not a product goal.

Useful checks:

- `status --format json` for global and current-project status.
- `service status --format json` for the global service.
- `project status --format json` for the selected project runtime.
- `project logs --tail 200` for runtime errors and indexing progress.
- `project index` when derived project state needs to be rebuilt.
- `doctor` for setup, generated artifacts, hooks, runtime prerequisites, and Health.

If live project data looks stale, verify the project runtime event stream and logs first. Polling should not hide a broken live path.
