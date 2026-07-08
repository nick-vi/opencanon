# Shim annotations declare owner, replacement, and removal date

## Rule

Lifecycle shim annotations require owner, replacement, and remove-by metadata.

## Applies to

- `src/**/*.{ts,tsx,py}`
- `tests/**/*.{ts,tsx,py}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`
- Facts: `annotations`

## Related conventions

- [Comments describe current intent](comments-current.md)
