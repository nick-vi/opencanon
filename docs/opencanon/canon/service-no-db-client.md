# Services do not import DB clients

## Rule

Services must not import DB clients directly.

## Applies to

- from `src/services/**/*.{ts,tsx}`
- from `packages/*/src/services/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `import-edge`
- Facts: `imports`

## Related conventions

- [dal-transaction-flow](opencanon://conventions/dal-transaction-flow)
- [service-db-boundary](opencanon://conventions/service-db-boundary)
