# Public contracts do not import database schemas

Convention id: `no-db-schema-in-contracts`.
Render style: `reference`.

## Rule

Rule: Public contract modules must not import database schema internals.

## Applies to

Kind: `imports`
- import source `src/contracts/**/*.{ts,tsx}`
- import source `packages/*/src/contracts/**/*.{ts,tsx}`

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

- [schema-contract-boundary](opencanon://conventions/schema-contract-boundary)
