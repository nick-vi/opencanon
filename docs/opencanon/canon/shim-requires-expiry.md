# Shim annotations declare owner, replacement, and removal date

Convention id: `shim-requires-expiry`.
Render style: `reference`.

## Rule

Rule: Lifecycle shim annotations require owner, replacement, and remove-by metadata.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx,py}`
- file glob `tests/**/*.{ts,tsx,py}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: `annotations`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [comments-current](opencanon://conventions/comments-current)
