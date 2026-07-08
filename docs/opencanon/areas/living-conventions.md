# Living Conventions

Area id: `living-conventions`.

## Summary

Conventions are typed definitions that can render human docs and enforce runtime validators, gates, or tests.

## Ownership

Files: packages/core/src/convention.ts, packages/core/src/convention-render.ts, packages/core/src/validator-graph.ts, packages/core/src/validation.ts, opencanon/conventions/index.ts, opencanon/conventions/docs-only-conventions.ts, tests/convention.test.ts
Commands: opencanon canon (cli), opencanon validate (cli)
Docs: docs/opencanon/canon/architecture.md

## Impact surfaces

- [project-canon-model](opencanon://impact-surfaces/project-canon-model)

## Checks

- `convention-tests` test `tests/convention.test.ts`
- `project-doctor` doctor

## Stories

Story `generated-docs-stay-current`: as maintainer, I want generated convention docs to match definitions exactly, so humans and agents read the same current canon.
- doctor detects stale generated docs
- runtime validators adapt from convention definitions
Checks: `convention-tests`, `project-doctor`

## Behaviors

Behavior `runtime-axis-enforces`: validator runtime loads a convention with runtime validation; findings and gates are produced from the convention definition.
Checks: `convention-tests`

## Governance

- infer governing conventions from owned scope
