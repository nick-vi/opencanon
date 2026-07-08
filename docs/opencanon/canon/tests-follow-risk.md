# Tests scale with blast radius

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

- [Specs declare enforcement and governance](spec-definitions-are-enforced.md)
- [Source files keep one primary responsibility](source-files-stay-cohesive.md)
