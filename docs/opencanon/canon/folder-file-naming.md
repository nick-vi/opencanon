# Service files use the service suffix

Convention id: `folder-file-naming`.
Render style: `reference`.

## Rule

Rule: Service implementation files must use the *.service.ts naming pattern.

## Applies to

Kind: `files`
- file glob `src/services/**/*.{ts,tsx}`
- file glob `packages/*/src/services/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `error`
Scope: `file`
Facts: none

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [folder-structure-current](opencanon://conventions/folder-structure-current)
