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

- [hardcoded-secrets-and-config](opencanon://conventions/hardcoded-secrets-and-config)
