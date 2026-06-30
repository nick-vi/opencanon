# Services do not import DB clients

Convention id: `service-no-db-client`.
Render style: `reference`.

## Rule

Rule: Services must not import DB clients directly.

## Applies to

Kind: `imports`
- import source `src/services/**/*.{ts,tsx}`
- import source `packages/*/src/services/**/*.{ts,tsx}`

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

- [dal-transaction-flow](opencanon://conventions/dal-transaction-flow)
- [service-db-boundary](opencanon://conventions/service-db-boundary)
