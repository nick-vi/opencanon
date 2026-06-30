# Project Examples

Small before/after projects that show how OpenCanon changes a repository.

Each example is intentionally tiny:

- `before/` shows the project state before an agent installs or applies OpenCanon guidance.
- `after/` shows the expected shape after Project Canon definitions, generated docs, validators, fixtures, and code changes are in place.

These examples are documentation fixtures, not full initialized package templates. They intentionally omit managed agent guidance, hooks, and other setup files that `opencanon setup` installs in a real project.

Use them to inspect the before/after shape and to verify the convention proof path:

```bash
cd examples/projects/dry-graph/after
opencanon validate --project
opencanon validate --check-fixtures
```

Current OpenCanon truth lives in `opencanon/` TypeScript definitions. Markdown under `docs/opencanon/` is rendered from those definitions.
