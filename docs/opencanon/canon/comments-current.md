# Comments describe current intent

Convention id: `comments-current`.
Render style: `reference`.

## Rule

Rule: Comments should explain current behavior, not preserve stale compatibility narratives.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx,py}`
- file glob `tests/**/*.{ts,tsx,py}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Agents may treat comments as live instructions. Legacy/deprecation/shim comments invite preserving old paths instead of cleaning touched code.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [no-stale-intent-comments](opencanon://conventions/no-stale-intent-comments)
- [no-shim-files](opencanon://conventions/no-shim-files)
- [shim-requires-expiry](opencanon://conventions/shim-requires-expiry)
- [deprecated-requires-replacement](opencanon://conventions/deprecated-requires-replacement)
