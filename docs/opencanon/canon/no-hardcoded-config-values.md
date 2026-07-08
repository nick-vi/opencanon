# Environment config stays behind named settings

Convention id: `no-hardcoded-config-values`.

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

- [hardcoded-secrets-and-config](opencanon://conventions/hardcoded-secrets-and-config)
