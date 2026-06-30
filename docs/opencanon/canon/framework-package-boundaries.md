# Framework packages depend inward

Convention id: `framework-package-boundaries`.
Render style: `reference`.

## Rule

Rule: OpenCanon framework packages must depend only on approved lower-level packages.

## Applies to

Kind: `imports`
- import source `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `error`
Scope: `import-edge`
Facts: `imports`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [framework-package-boundaries](opencanon://conventions/framework-package-boundaries)
