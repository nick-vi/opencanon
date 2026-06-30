# Routes call services instead of DAL modules

Convention id: `no-route-dal-import`.
Render style: `reference`.

## Rule

Rule: Route handlers must call services, not DAL modules.

## Applies to

Kind: `imports`
- import source `src/api/routes/**/*.{ts,tsx}`
- import source `packages/*/src/api/routes/**/*.{ts,tsx}`

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
