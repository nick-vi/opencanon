# Spec Governance Model

## Summary

Specs describe durable behavior as typed definitions with generated docs, governing conventions, implementation scope, impact links, and executable checks.

## Scope

- Files: `packages/core/src/spec.ts`
- Files: `packages/core/src/spec-loader.ts`
- Files: `packages/core/src/spec-render.ts`
- Files: `packages/core/src/change.ts`
- Files: `packages/core/src/change-state.ts`
- Files: `packages/core/src/change-render.ts`
- Files: `packages/core/src/context.ts`
- Files: `packages/core/src/convention.ts`
- Files: `packages/core/src/render-links.ts`
- Files: `packages/core/src/validation.ts`
- Files: `packages/core/src/validator-types.ts`
- Files: `packages/core/src/validator.ts`
- Files: `packages/core/src/definition-graph.ts`
- Files: `packages/core/src/doctor.ts`
- Files: `packages/core/src/doctor-checks.ts`
- Files: `packages/core/src/doctor-types.ts`
- Files: `packages/core/src/convention-history.ts`
- Files: `packages/core/src/project-types.ts`
- Files: `packages/cli/src/specs.ts`
- Files: `packages/cli/src/changes.ts`
- Files: `packages/cli/src/changes-definition.ts`
- Files: `packages/cli/src/brief.ts`
- Files: `packages/cli/src/index.ts`
- Files: `packages/cli/src/mcp.ts`
- Files: `packages/cli/src/init-flow.ts`
- Files: `packages/cli/src/init-scaffold.ts`
- Files: `packages/runtime/src/routes.ts`
- Files: `packages/runtime/src/server*.ts`
- Files: `packages/runtime/src/snapshot.ts`
- Files: `packages/runtime/src/state.ts`
- Files: `opencanon/specs/index.ts`
- Files: `opencanon/conventions/spec-definitions-are-enforced.ts`
- Files: `tests/convention.test.ts`
- Files: `tests/definition-graph.test.ts`
- Docs: `docs/opencanon/specs/spec-governance-model.md`

## Impact surfaces

- [Project Canon model](../areas/project-map-governance.md#project-map-governance)
- [Project context index](../areas/project-context-index.md#project-context-index)

## Areas

- [Living Conventions](../areas/living-conventions.md)
- [Definition Authoring Flow](../areas/definition-authoring-flow.md)
- [Project Map Governance](../areas/project-map-governance.md)

## Checks

- `spec-render` command `npm run opencanon -- canon render specs --dry-run`
- `project-validation` command `npm run opencanon -- validate --project`
- `project-doctor` doctor
- `typecheck` command `npm run check:types`
- `convention-tests` test `tests/convention.test.ts`
- `definition-graph-tests` test `tests/definition-graph.test.ts`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`

## Rules

Rule `typed-source-of-truth`: A spec is authored as a TypeScript definition and any OpenCanon-owned Markdown is rendered from that definition.
- generated spec docs are deterministic
- definition docs have no hand-edited Markdown opt-out
Checks: `spec-render`, `project-doctor`

Rule `definition-domain-validation`: Validators can target explicit runtime domains such as definitions or project state without using empty file globs as the authoring contract.
- definition-scoped conventions map to validator domain definition
- project validation runs definition-domain validators once
Checks: `convention-tests`, `project-validation`

Rule `specs-link-governance`: Specs link the conventions and checks that keep the described behavior current.
- specs can link governing conventions
- doctor and project map can surface spec backlinks
Checks: `definition-graph-tests`, `project-doctor`

Rule `changes-own-task-graphs`: Implementation task graphs live on Change definitions while task progress is derived from runtime events.
- tasks can declare checks, files, impact surfaces, dependencies, blockers, and durable definition updates
- ready work is derived from dependency state instead of persisted as definition status
- task lifecycle and check events include task and check identifiers
Checks: `runtime-client-tests`, `definition-graph-tests`, `typecheck`

## Scenarios

Scenario `agent-implements-feature-from-spec`
- Given a repo has a spec with scope, checks, and governing conventions
- When an agent changes files covered by that spec
- Then OpenCanon can show the related spec
- Then runtime checks keep the implementation aligned with the spec and conventions
Checks: `project-validation`, `definition-graph-tests`

Scenario `agent-follows-ready-change-task`
- Given a Change has tasks with dependencies and declared checks
- When an agent asks for ready work
- Then OpenCanon returns only unblocked work
- Then the agent can claim a task
- Then check results and close events update runtime state without editing the Change definition
Checks: `runtime-client-tests`, `definition-graph-tests`

## Governance

- infer governing conventions from spec scope
- convention [Specs declare enforcement and governance](../canon/spec-definitions-are-enforced.md)
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
