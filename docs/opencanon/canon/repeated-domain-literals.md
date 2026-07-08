# Repeated domain literals move into const objects

## Rule

Repeated domain literals should be promoted to a const object plus derived union type.

## Applies to

- `src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `project`
- Facts: `literals`

## Related conventions

- [Use const objects instead of native TypeScript enums](const-object-enums.md)
