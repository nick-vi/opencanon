# Source files keep one primary responsibility

Convention id: `source-files-stay-cohesive`.
Render style: `reference`.

## Rule

Rule: Source files should stay cohesive. A large file should be split once it combines lifecycle, routing, storage, rendering, validation, or unrelated test concerns.

## Applies to

Kind: `files`
- file glob `apps/site/src/**/*.{svelte,ts,js}`
- file glob `crates/*/src/**/*.rs`
- file glob `opencanon/**/*.ts`
- file glob `packages/*/src/**/*.{ts,tsx,js,jsx,mts,cts}`
- file glob `packages/*/test/**/*.{ts,tsx,js,jsx,mts,cts}`
- file glob `scripts/**/*.{ts,tsx,mts,cts}`
- file glob `tests/**/*.{ts,tsx,js,jsx,mts,cts}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: none
Fixtures: `valid-and-invalid`

## Why

Rationale: Large mixed-responsibility files hide ownership boundaries, slow reviews, and make agent edits riskier because unrelated behavior shares one edit surface.

## Examples

Example 1:
Note: Split a runtime service file into registry, lifecycle, reconcile, and HTTP adapter modules when those responsibilities grow independently.

Example 2:
Note: Keep long test suites grouped by behavior instead of using one catch-all test file for unrelated runtime, doctor, cache, and CLI checks.

Example 3:
Note: Generated files and fixtures are excluded; the rule is about authored source ownership.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [folder-structure-current](opencanon://conventions/folder-structure-current)
- [import-boundaries-current](opencanon://conventions/import-boundaries-current)
- [tests-follow-risk](opencanon://conventions/tests-follow-risk)
