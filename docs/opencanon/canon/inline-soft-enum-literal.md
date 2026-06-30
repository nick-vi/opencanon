# Soft enum comparisons use declared members

Convention id: `inline-soft-enum-literal`.
Render style: `reference`.

## Rule

Rule: Comparisons against a checked finite-literal set should reference the declared member, not inline the raw string.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`
- file glob `tests/**/*.{ts,tsx}`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: `literals`
Requires producers: `typescript`
Fixtures: `valid-only`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [inline-soft-enum-literal](opencanon://conventions/inline-soft-enum-literal)
