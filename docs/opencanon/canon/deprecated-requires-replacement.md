# Deprecated code names its replacement and removal owner

Convention id: `deprecated-requires-replacement`.
Render style: `reference`.

## Rule

Rule: Deprecated internal code requires owner, replacement, and remove-by metadata.

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
