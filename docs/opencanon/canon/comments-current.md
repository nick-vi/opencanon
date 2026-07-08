# Comments describe current intent

## Rule

Comments should explain current behavior, not preserve stale compatibility narratives.

## Applies to

- `src/**/*.{ts,tsx,py}`
- `tests/**/*.{ts,tsx,py}`

## Why

Agents may treat comments as live instructions. Legacy/deprecation/shim comments invite preserving old paths instead of cleaning touched code.

## Related conventions

- [no-stale-intent-comments](opencanon://conventions/no-stale-intent-comments)
- [no-shim-files](opencanon://conventions/no-shim-files)
- [shim-requires-expiry](opencanon://conventions/shim-requires-expiry)
- [deprecated-requires-replacement](opencanon://conventions/deprecated-requires-replacement)
