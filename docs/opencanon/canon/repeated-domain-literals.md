# Repeated domain literals move into const objects

Convention id: `repeated-domain-literals`.

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

- [const-object-enums](opencanon://conventions/const-object-enums)
