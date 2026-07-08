# Environment config stays behind named settings

## Rule

Environment-specific config values should live behind named config.

## Applies to

- `src/**/*.{ts,tsx}`
- `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `file`
- Facts: `literals`

## Related conventions

- [Secrets and environment config stay out of source literals](hardcoded-secrets-and-config.md)
