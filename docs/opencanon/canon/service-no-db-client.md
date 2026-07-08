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

- [DAL functions accept optional transactions](dal-transaction-flow.md)
- [Services compose DAL instead of direct DB clients](service-db-boundary.md)
