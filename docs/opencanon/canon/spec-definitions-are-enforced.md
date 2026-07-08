# Specs declare enforcement and governance

## Rule

Specs should declare checks, governing conventions, and either implementation scope or impact surfaces.

## Applies to

- spec definitions: all

## Runtime checks

- Kind: `validator`
- Severity: `warning`
- Scope: `project`
- Domain: `definition`
- Fixtures: `valid-only`

## Why

Specs are useful only when they stay connected to the implementation and the conventions that constrain it.

## Related impact surfaces

- [project-canon-model](opencanon://impact-surfaces/project-canon-model)

## Related conventions

- [state-ownership-current](opencanon://conventions/state-ownership-current)
- [tests-follow-risk](opencanon://conventions/tests-follow-risk)
