# Tests scale with blast radius

Convention id: `tests-follow-risk`.
Render style: `reference`.

## Rule

Rule: Narrow changes get focused unit tests; shared behavior and cross-layer workflows need broader tests.

## Applies to

Kind: `files`
- file glob `tests/**/*.{ts,tsx,py}`
- file glob `src/**/*.test.{ts,tsx,py}`
- file glob `packages/*/test/**/*.{ts,tsx,py}`
- file glob `packages/*/src/**/*.test.{ts,tsx,py}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Tests should catch regressions at the same boundary where the risk was introduced.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [spec-definitions-are-enforced](opencanon://conventions/spec-definitions-are-enforced)
- [source-files-stay-cohesive](opencanon://conventions/source-files-stay-cohesive)
