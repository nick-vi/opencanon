# Internal source does not preserve shim files

Convention id: `no-shim-files`.
Render style: `reference`.

## Rule

Rule: Internal source files should not be named around shims, compatibility, legacy, or deprecated paths.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx,py}`
- file glob `tests/**/*.{ts,tsx,py}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `file`
Facts: none

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [comments-current](opencanon://conventions/comments-current)
