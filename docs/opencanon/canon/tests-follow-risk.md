# Tests scale with blast radius

Convention id: `tests-follow-risk`.

## Rule

Narrow changes get focused unit tests; shared behavior and cross-layer workflows need broader tests.

## Applies to

- `tests/**/*.{ts,tsx,py}`
- `src/**/*.test.{ts,tsx,py}`
- `packages/*/test/**/*.{ts,tsx,py}`
- `packages/*/src/**/*.test.{ts,tsx,py}`

## Why

Tests should catch regressions at the same boundary where the risk was introduced.

## Related conventions

- [spec-definitions-are-enforced](opencanon://conventions/spec-definitions-are-enforced)
- [source-files-stay-cohesive](opencanon://conventions/source-files-stay-cohesive)
