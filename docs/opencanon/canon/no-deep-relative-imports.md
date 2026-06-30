# Imports avoid deep relative parent climbs

Convention id: `no-deep-relative-imports`.
Render style: `reference`.

## Rule

Rule: Deep relative import crosses too many ownership levels.

## Applies to

Kind: `imports`
- import source `src/**/*.{ts,tsx}`
- import source `tests/**/*.{ts,tsx}`
- import source `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `import-edge`
Facts: `imports`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [import-boundaries-current](opencanon://conventions/import-boundaries-current)
