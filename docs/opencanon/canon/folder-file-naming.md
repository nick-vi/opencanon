# Service files use the service suffix

Convention id: `folder-file-naming`.

## Rule

Service implementation files must use the *.service.ts naming pattern.

## Applies to

- `src/services/**/*.{ts,tsx}`
- `packages/*/src/services/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `file`

## Related conventions

- [folder-structure-current](opencanon://conventions/folder-structure-current)
