# Secret-like literals stay out of source

## Rule

Secret-like literals must not be committed.

## Applies to

- `src/**/*.{ts,tsx}`
- `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `file`
- Facts: `literals`

## Related conventions

- [Secrets and environment config stay out of source literals](hardcoded-secrets-and-config.md)
