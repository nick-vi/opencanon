# Use const objects instead of native TypeScript enums

Convention id: `no-native-enums`.
Render style: `reference`.

## Rule

Rule: Files matching src/**/*.{ts,tsx}, tests/**/*.{ts,tsx}, packages/*/src/**/*.{ts,tsx} must use const-object enum patterns instead of native TypeScript enums.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`
- file glob `tests/**/*.{ts,tsx}`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `error`
Scope: `file`
Facts: `declarations`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [const-object-enums](opencanon://conventions/const-object-enums)
