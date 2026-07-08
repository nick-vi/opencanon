# Internal source does not preserve shim files

Convention id: `no-shim-files`.

## Rule

Internal source files should not be named around shims, compatibility, legacy, or deprecated paths.

## Applies to

- `src/**/*.{ts,tsx,py}`
- `tests/**/*.{ts,tsx,py}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`

## Related conventions

- [comments-current](opencanon://conventions/comments-current)
