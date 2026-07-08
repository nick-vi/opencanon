# Use const objects instead of native TypeScript enums

## Rule

Files matching src/**/*.{ts,tsx}, tests/**/*.{ts,tsx}, packages/*/src/**/*.{ts,tsx} must use const-object enum patterns instead of native TypeScript enums.

## Applies to

- `src/**/*.{ts,tsx}`
- `tests/**/*.{ts,tsx}`
- `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `file`
- Facts: `declarations`

## Related conventions

- [Use const objects instead of native TypeScript enums](const-object-enums.md)
