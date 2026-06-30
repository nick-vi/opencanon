# Secret-like literals stay out of source

Convention id: `no-secret-like-literals`.
Render style: `reference`.

## Rule

Rule: Secret-like literals must not be committed.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `error`
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
