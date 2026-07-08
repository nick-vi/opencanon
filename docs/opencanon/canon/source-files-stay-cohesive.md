# Source files keep one primary responsibility

Convention id: `source-files-stay-cohesive`.

## Rule

Source files should stay cohesive. A large file should be split once it combines lifecycle, routing, storage, rendering, validation, or unrelated test concerns.

## Applies to

- `apps/site/src/**/*.{svelte,ts,js}`
- `crates/*/src/**/*.rs`
- `opencanon/**/*.ts`
- `packages/*/src/**/*.{ts,tsx,js,jsx,mts,cts}`
- `packages/*/test/**/*.{ts,tsx,js,jsx,mts,cts}`
- `scripts/**/*.{ts,tsx,mts,cts}`
- `tests/**/*.{ts,tsx,js,jsx,mts,cts}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`
- Fixtures: `valid-and-invalid`

## Why

Large mixed-responsibility files hide ownership boundaries, slow reviews, and make agent edits riskier because unrelated behavior shares one edit surface.

## Examples

- Split a runtime service file into registry, lifecycle, reconcile, and HTTP adapter modules when those responsibilities grow independently.

- Keep long test suites grouped by behavior instead of using one catch-all test file for unrelated runtime, doctor, cache, and CLI checks.

- Generated files and fixtures are excluded; the rule is about authored source ownership.

## Related conventions

- [folder-structure-current](opencanon://conventions/folder-structure-current)
- [import-boundaries-current](opencanon://conventions/import-boundaries-current)
- [tests-follow-risk](opencanon://conventions/tests-follow-risk)
