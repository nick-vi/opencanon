# Soft enum comparisons use declared members

## Rule

Comparisons against a checked finite-literal set should reference the declared member, not inline the raw string.

## Applies to

- `src/**/*.{ts,tsx}`
- `tests/**/*.{ts,tsx}`
- `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`
- Facts: `literals`
- Requires producers: `typescript`
- Fixtures: `valid-only`

## Related conventions

- [inline-soft-enum-literal](opencanon://conventions/inline-soft-enum-literal)
