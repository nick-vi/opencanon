# Comments describe current intent

## Rule

Comments should explain current behavior, not preserve stale compatibility narratives.

## Applies to

- `src/**/*.{ts,tsx,py}`
- `tests/**/*.{ts,tsx,py}`

## Why

Agents may treat comments as live instructions. Legacy/deprecation/shim comments invite preserving old paths instead of cleaning touched code.

## Related conventions

- [Comments do not preserve stale compatibility intent](no-stale-intent-comments.md)
- [Internal source does not preserve shim files](no-shim-files.md)
- [Shim annotations declare owner, replacement, and removal date](shim-requires-expiry.md)
- [Deprecated code names its replacement and removal owner](deprecated-requires-replacement.md)
