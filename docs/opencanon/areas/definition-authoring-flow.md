# Definition Authoring Flow

## Summary

OpenCanon provides project-local authoring support and draft commands for conventions, areas, and change definitions.

## Ownership

Files: packages/core/src/project-types.ts, packages/runtime/src/project-types-runtime.ts, packages/cli/src/setup.ts, packages/cli/src/areas.ts, packages/cli/src/changes.ts
Commands: opencanon canon draft convention (cli), opencanon canon draft area (cli), opencanon canon draft change (cli)
Docs: .agents/skills/opencanon/SKILL.md

## Checks

- `convention-tests` test `tests/convention.test.ts`
- `project-doctor` doctor

## Stories

Story `draft-typed-definitions`: as developer, I want draft commands and generated authoring support, so new canon can be written by agents or humans without memorizing every type shape.
- canon draft convention prints a compile-ready definition skeleton
- canon draft area and canon draft change print deterministic snippets
- project authoring support remains generated state
Checks: `convention-tests`, `project-doctor`

## Behaviors

Behavior `authoring-state-is-derived`: init and project runtime write authoring declaration files automatically; generated files stay under .opencanon/generated and out of committed source.
Checks: `project-doctor`

## Governance

- infer governing conventions from owned scope
- convention [state-ownership-current](opencanon://conventions/state-ownership-current)
- convention [product-language-current](opencanon://conventions/product-language-current)
