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

- [Project Canon model](../areas/project-map-governance.md#project-map-governance)

## Related conventions

- [Repo definitions own truth; generated state stays derived](state-ownership-current.md)
- [Tests scale with blast radius](tests-follow-risk.md)
