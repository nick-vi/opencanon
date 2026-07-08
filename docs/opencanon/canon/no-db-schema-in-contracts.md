# Public contracts do not import database schemas

## Rule

Public contract modules must not import database schema internals.

## Applies to

- from `src/contracts/**/*.{ts,tsx}`
- from `packages/*/src/contracts/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `import-edge`
- Facts: `imports`

## Related conventions

- [schema-contract-boundary](opencanon://conventions/schema-contract-boundary)
