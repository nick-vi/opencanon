# Repeated domain literals move into const objects

Convention id: `repeated-domain-literals`.
Render style: `reference`.

## Rule

Rule: Repeated domain literals should be promoted to a const object plus derived union type.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `project`
Facts: `literals`

## Why

Rationale: No rationale is recorded.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [const-object-enums](opencanon://conventions/const-object-enums)
