# Project Map Governance

Area id: `project-map-governance`.
Render style: `reference`.

## Summary

Summary: OpenCanon derives the Project Map across areas, changes, conventions, surfaces, checks, validators, and owned targets.

## Ownership

Files: opencanon/**/*.ts, packages/core/src/definition-graph.ts, packages/core/src/contracts.ts, packages/engine/src/index.ts, packages/runtime/src/snapshot.ts, crates/opencanon-engine/src/contracts.rs, crates/opencanon-engine/src/project.rs, crates/opencanon-engine/src/state.rs, crates/opencanon-engine/src/migrations/003_product_model.sql, tests/definition-graph.test.ts
Docs: docs/opencanon/**/*.md
Resources: definition-graph, product-model-projection

## Impact surfaces

- [project-canon-model](opencanon://impact-surfaces/project-canon-model)
- [project-context-index](opencanon://impact-surfaces/project-context-index)

## Checks

- `definition-graph-tests` test `tests/definition-graph.test.ts`
- `engine-product-model-tests` test `crates/opencanon-engine/src/tests.rs`
- `engine-wrapper-tests` test `packages/runtime/test/engine.test.ts`
- `runtime-state-tests` test `packages/runtime/test/state.test.ts`
- `project-doctor` doctor

## Stories

Story `doctor-sees-definition-drift`: as developer, I want doctor to flag missing links and ownership conflicts, so the live Project Map does not quietly drift from code.
- project map diagnostics appear in doctor
- runtime snapshots expose project map backlinks
Checks: `definition-graph-tests`, `project-doctor`

## Behaviors

Behavior `derives-impact-backlinks`: project runtime snapshot loads definitions and impact surfaces; area, change, convention, and surface backlinks are available to runtime clients and durable project state.
Checks: `definition-graph-tests`

## Dependencies

No area dependencies are recorded.

## Governance

- infer governing conventions from owned scope
- convention [impact-surfaces-current](opencanon://conventions/impact-surfaces-current)
- convention [tests-follow-risk](opencanon://conventions/tests-follow-risk)
