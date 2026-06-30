# Secrets and environment config stay out of source literals

Convention id: `hardcoded-secrets-and-config`.
Render style: `reference`.

## Rule

Rule: Source code should not contain live-looking secrets or environment-specific configuration literals.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Committed secrets are difficult to revoke reliably after publication. Hardcoded URLs, hosts, and ports make deployment environments harder to change. Agents may copy literal values unless config ownership is explicit.

## Examples

No examples are recorded.

## Related impact surfaces

- [release-update](opencanon://impact-surfaces/release-update)

## Related conventions

- [no-secret-like-literals](opencanon://conventions/no-secret-like-literals)
- [no-hardcoded-config-values](opencanon://conventions/no-hardcoded-config-values)
