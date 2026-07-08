# Secrets and environment config stay out of source literals

## Rule

Source code should not contain live-looking secrets or environment-specific configuration literals.

## Applies to

- `src/**/*.{ts,tsx}`
- `packages/*/src/**/*.{ts,tsx}`

## Why

Committed secrets are difficult to revoke reliably after publication. Hardcoded URLs, hosts, and ports make deployment environments harder to change. Agents may copy literal values unless config ownership is explicit.

## Related impact surfaces

- [Release and update path](../areas/runtime-release-update.md#runtime-updates)

## Related conventions

- [Secret-like literals stay out of source](no-secret-like-literals.md)
- [Environment config stays behind named settings](no-hardcoded-config-values.md)
