# Specs declare enforcement and governance

Convention id: `spec-definitions-are-enforced`.
Render style: `reference`.

## Rule

Rule: Specs should declare checks, governing conventions, and either implementation scope or impact surfaces.

## Applies to

Kind: `definitions`
- spec definitions: all

## Runtime checks

Kind: `validator`
Severity: `warning`
Scope: `project`
Domain: `definition`
Facts: none
Fixtures: `valid-only`

## Why

Rationale: Specs are useful only when they stay connected to the implementation and the conventions that constrain it.

## Examples

No examples are recorded.

## Related impact surfaces

- [project-canon-model](opencanon://impact-surfaces/project-canon-model)

## Related conventions

- [state-ownership-current](opencanon://conventions/state-ownership-current)
- [tests-follow-risk](opencanon://conventions/tests-follow-risk)
