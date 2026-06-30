# Environment config stays behind named settings

Convention id: `no-hardcoded-config-values`.
Render style: `reference`.

## Rule

Rule: Environment-specific config values should live behind named config.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: `literals`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [hardcoded-secrets-and-config](opencanon://conventions/hardcoded-secrets-and-config)
