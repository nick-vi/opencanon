# Routes call services instead of DAL modules

## Rule

Route handlers must call services, not DAL modules.

## Applies to

- from `src/api/routes/**/*.{ts,tsx}`
- from `packages/*/src/api/routes/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `import-edge`
- Facts: `imports`

## Related conventions

- [DAL functions accept optional transactions](dal-transaction-flow.md)
