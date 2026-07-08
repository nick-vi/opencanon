# Boundary literals have a canonical owner

Convention id: `duplicate-boundary-literals`.

## Rule

Boundary literals should have a canonical owner.

## Applies to

- `src/api/routes/**/*.{ts,tsx}`
- `src/contracts/**/*.{ts,tsx}`
- `packages/*/src/api/routes/**/*.{ts,tsx}`
- `packages/*/src/contracts/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `project`
- Facts: `duplicates`

## Related conventions

- [schema-contract-boundary](opencanon://conventions/schema-contract-boundary)
