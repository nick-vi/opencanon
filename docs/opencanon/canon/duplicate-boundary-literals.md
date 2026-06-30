# Boundary literals have a canonical owner

Convention id: `duplicate-boundary-literals`.
Render style: `reference`.

## Rule

Rule: Boundary literals should have a canonical owner.

## Applies to

Kind: `files`
- file glob `src/api/routes/**/*.{ts,tsx}`
- file glob `src/contracts/**/*.{ts,tsx}`
- file glob `packages/*/src/api/routes/**/*.{ts,tsx}`
- file glob `packages/*/src/contracts/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `project`
Facts: `duplicates`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [schema-contract-boundary](opencanon://conventions/schema-contract-boundary)
