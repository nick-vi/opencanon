# Area and Change Model

Change id: `area-change-model`.
Change kind: `feature`.
Render style: `reference`.

## Intent

Problem: Product behavior, active change, and their relationships were not first-class typed definitions.
Outcome: Areas, changes, surfaces, conventions, checks, and targets can be parsed into a Project Map, validated by doctor, rendered into docs, persisted as derived project state, and exposed through CLI, MCP, and local APIs.
Why: Agents and humans need product-level context, state ownership, change-aware validation, and simple product language, not only file findings and validator lists.
Summary: OpenCanon can define permanent areas, active changes, and cross-definition relationships as typed source of truth with generated docs, derived project state, CLI access, MCP access, and local API visibility.

## Updates

- Areas: [company-read-model](opencanon://areas/company-read-model)
- Areas: [project-map-governance](opencanon://areas/project-map-governance)
- Areas: [project-context-index](opencanon://areas/project-context-index)
- Areas: [local-service-and-runtimes](opencanon://areas/local-service-and-runtimes)
- Areas: [living-conventions](opencanon://areas/living-conventions)
- Areas: [product-docs-and-guidance](opencanon://areas/product-docs-and-guidance)
- Areas: [definition-authoring-flow](opencanon://areas/definition-authoring-flow)
- Areas: [agent-feedback-and-gates](opencanon://areas/agent-feedback-and-gates)
- Areas: [runtime-release-update](opencanon://areas/runtime-release-update)
- Specs: [spec-governance-model](opencanon://specs/spec-governance-model)
- Conventions: [service-events-current](opencanon://conventions/service-events-current)
- Impact surfaces: [company-read-model](opencanon://impact-surfaces/company-read-model)
- Impact surfaces: [local-service-control](opencanon://impact-surfaces/local-service-control)
- Impact surfaces: [project-canon-model](opencanon://impact-surfaces/project-canon-model)
- Impact surfaces: [project-context-index](opencanon://impact-surfaces/project-context-index)
- Impact surfaces: [release-update](opencanon://impact-surfaces/release-update)
- Docs: `docs/opencanon/canon/architecture.md`
- Docs: `docs/opencanon/canon/service-events-current.md`
- Docs: `docs/opencanon/areas/company-read-model.md`
- Docs: `docs/opencanon/areas/definition-authoring-flow.md`
- Docs: `docs/opencanon/areas/project-map-governance.md`
- Docs: `docs/opencanon/areas/project-context-index.md`
- Docs: `docs/opencanon/areas/local-service-and-runtimes.md`
- Docs: `docs/opencanon/areas/living-conventions.md`
- Docs: `docs/opencanon/areas/agent-feedback-and-gates.md`
- Docs: `docs/opencanon/areas/product-docs-and-guidance.md`
- Docs: `docs/opencanon/areas/runtime-release-update.md`
- Docs: `docs/opencanon/specs/spec-governance-model.md`

## Scope

- Files: `package.json`
- Files: `package-lock.json`
- Files: `vitest.config.ts`
- Files: `.github/workflows/**`
- Files: `.opencode/plugins/opencanon.ts`
- Files: `packages/service-contracts/**`
- Files: `packages/distribution/**`
- Files: `packages/observability/**`
- Files: `packages/core/package.json`
- Files: `packages/core/src/area.ts`
- Files: `packages/core/src/area-loader.ts`
- Files: `packages/core/src/area-render.ts`
- Files: `packages/core/src/spec.ts`
- Files: `packages/core/src/spec-loader.ts`
- Files: `packages/core/src/spec-render.ts`
- Files: `packages/core/src/change.ts`
- Files: `packages/core/src/change-loader.ts`
- Files: `packages/core/src/change-render.ts`
- Files: `packages/core/src/context.ts`
- Files: `packages/core/src/contracts.ts`
- Files: `packages/core/src/core-utils.ts`
- Files: `packages/core/src/core.ts`
- Files: `packages/core/src/definition-graph.ts`
- Files: `packages/core/src/semantic-index.ts`
- Files: `packages/core/src/semantic-models.ts`
- Files: `packages/core/src/definition-target.ts`
- Files: `packages/core/src/doctor.ts`
- Files: `packages/core/src/feedback.ts`
- Files: `packages/core/src/hooks.ts`
- Files: `packages/core/src/index.ts`
- Files: `packages/core/src/language-analyzer.ts`
- Files: `packages/core/src/opencanon-skill.ts`
- Files: `packages/core/src/project-types.ts`
- Files: `packages/core/src/producer-registry.ts`
- Files: `packages/core/src/release-keys.ts`
- Files: `packages/core/src/testing.ts`
- Files: `packages/core/src/type-facts-provider.ts`
- Files: `packages/core/src/validator.ts`
- Files: `packages/core/src/validator-graph.ts`
- Files: `packages/cli/src/areas.ts`
- Files: `packages/cli/src/specs.ts`
- Files: `packages/cli/src/changes.ts`
- Files: `packages/cli/src/conventions.ts`
- Files: `packages/cli/src/context.ts`
- Files: `packages/cli/src/analyze.ts`
- Files: `packages/cli/src/baseline.ts`
- Files: `packages/cli/src/feedback.ts`
- Files: `packages/cli/src/index.ts`
- Files: `packages/cli/src/init-flow.ts`
- Files: `packages/cli/src/update.ts`
- Files: `packages/cli/src/validate.ts`
- Files: `packages/runtime/src/project-types-runtime.ts`
- Files: `packages/cli/src/runtime-client.ts`
- Files: `packages/engine/src/index.ts`
- Files: `packages/runtime/src/local-protocol.ts`
- Files: `packages/runtime/src/cli.ts`
- Files: `packages/runtime/src/index.ts`
- Files: `packages/runtime/src/service.ts`
- Files: `packages/runtime/src/state.ts`
- Files: `packages/runtime/src/semantic-index.ts`
- Files: `packages/runtime/src/type-producer/producer-main.ts`
- Files: `packages/runtime/src/type-producer/runtime.ts`
- Files: `packages/runtime/src/routes.ts`
- Files: `packages/runtime/src/server.ts`
- Files: `packages/runtime/src/server-fs.ts`
- Files: `packages/runtime/src/snapshot.ts`
- Files: `packages/runtime/test/**`
- Files: `packages/validators/src/**`
- Files: `packages/validators/package.json`
- Files: `crates/opencanon-engine/**`
- Files: `crates/opencanon-vector/**`
- Files: `crates/opencanon-inference/**`
- Files: `scripts/**`
- Files: `opencanon/areas/index.ts`
- Files: `opencanon/specs/index.ts`
- Files: `opencanon/changes/index.ts`
- Files: `opencanon/conventions/docs-only-conventions.ts`
- Files: `opencanon/conventions/no-secret-like-literals.ts`
- Files: `opencanon/conventions/spec-definitions-are-enforced.ts`
- Files: `opencanon/fixtures/**`
- Files: `tests/**`
- Files: `examples/projects/**`
- Files: `apps/site/**`
- Files: `examples/conventions/**`
- Docs: `README.md`
- Docs: `AGENTS.md`
- Docs: `CLAUDE.md`
- Docs: `.agents/skills/opencanon/SKILL.md`
- Docs: `.agents/skills/opencanon/**`
- Docs: `docs/opencanon/canon/architecture.md`
- Docs: `docs/runtime-update-security.md`
- Docs: `docs/opencanon/canon/service-events-current.md`
- Docs: `docs/opencanon/areas/company-read-model.md`
- Docs: `docs/opencanon/areas/definition-authoring-flow.md`
- Docs: `docs/opencanon/areas/project-map-governance.md`
- Docs: `docs/opencanon/areas/project-context-index.md`
- Docs: `docs/opencanon/areas/local-service-and-runtimes.md`
- Docs: `docs/opencanon/areas/living-conventions.md`
- Docs: `docs/opencanon/areas/agent-feedback-and-gates.md`
- Docs: `docs/opencanon/areas/product-docs-and-guidance.md`
- Docs: `docs/opencanon/areas/runtime-release-update.md`
- Docs: `docs/opencanon/changes/area-change-model.md`
- Docs: `docs/opencanon/specs/spec-governance-model.md`

## Checks

- `project-doctor` doctor
- `typecheck` command `npm run check:types`
- `definition-graph-tests` test `tests/definition-graph.test.ts`
- `convention-tests` test `tests/convention.test.ts`
- `engine-product-model-tests` test `crates/opencanon-engine/src/tests.rs`
- `engine-wrapper-tests` test `packages/runtime/test/engine.test.ts`
- `runtime-state-tests` test `packages/runtime/test/state.test.ts`
- `runtime-tests` test `packages/runtime/test/client.test.ts`
- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `semantic-index-tests` test `packages/runtime/test/semantic-index.test.ts`
- `worktree-tests` test `tests/worktree.test.ts`
- `release-tests` test `tests/release.test.ts`
- `release-check` command `npm run release:check`
- `runtime-build` command `npm run build:runtime -- --skip-engine`
- `test-tree` command `npm run test:tree`

## Plan

Plan `board-state`: Derive Change board columns from change-level events and task aggregate state
Checks: `runtime-tests`

Plan `context-index-recovery`: Repair generated semantic vectors when cached metadata points at missing vectors
Checks: `semantic-index-tests`

Plan `cli-and-copy`: Remove stale command aliases and keep CLI and README examples on current surfaces
Checks: `service-lifecycle-tests`

Plan `examples-and-hooks`: Refresh example projects and hooks so they teach the current runtime-owned workflow
Checks: `project-doctor`, `typecheck`

Plan `canon-dogfood`: Keep active Change tasks scoped to current work instead of completed historical migrations
Checks: `project-doctor`

Plan `runtime-repair-hardening`: Make supervised runtime repair deterministic across worktrees and stale pipes
Checks: `runtime-tests`, `service-lifecycle-tests`, `worktree-tests`

Plan `release-gate-proof`: Ensure release test gates include every committed test file
Checks: `release-tests`, `test-tree`

Plan `headless-runtime-split`: Keep the main branch focused on CLI, MCP, local service, runtime, and versioned APIs
Checks: `typecheck`, `release-tests`, `release-check`, `runtime-build`

## Tasks

Task `board-state`: Keep task events from closing whole Changes in the board projection
Files: `packages/runtime/src/snapshot.ts`, `packages/runtime/test/client.test.ts`
Impact surfaces: [project-canon-model](opencanon://impact-surfaces/project-canon-model)
Checks: `runtime-tests`

Task `context-index-recovery`: Rebuild semantic vectors after missing-vector reuse failures
Files: `packages/runtime/src/snapshot.ts`, `packages/runtime/test/semantic-index.test.ts`
Impact surfaces: [project-context-index](opencanon://impact-surfaces/project-context-index)
Checks: `semantic-index-tests`

Task `cli-copy-cleanup`: Remove stale Change check alias and refresh current command copy
Files: `packages/cli/src/changes.ts`, `packages/cli/src/context.ts`, `README.md`, `crates/opencanon-engine/src/state.rs`, `packages/runtime/test/service.test.ts`
Impact surfaces: [project-canon-model](opencanon://impact-surfaces/project-canon-model)
Checks: `service-lifecycle-tests`

Task `examples-current-canon`: Replace old decision examples with current Project Canon definitions
Files: `examples/projects/**`
Impact surfaces: [project-canon-model](opencanon://impact-surfaces/project-canon-model)
Checks: `project-doctor`

Task `hook-and-export-cleanup`: Expose hook failures and remove stale package export paths
Files: `.opencode/plugins/opencanon.ts`, `packages/core/package.json`, `packages/core/src/opencanon-skill.ts`, `packages/service-contracts/src/index.ts`
Impact surfaces: [project-canon-model](opencanon://impact-surfaces/project-canon-model), [local-service-control](opencanon://impact-surfaces/local-service-control)
Checks: `typecheck`

Task `release-gate-proof`: Make the release test gate cover every committed test file
Files: `package.json`, `tests/release.test.ts`
Impact surfaces: [release-update](opencanon://impact-surfaces/release-update)
Checks: `release-tests`, `test-tree`

Task `release-update-hardening`: Harden updater safety, release watching, hook scoping, and machine-readable CLI output
Files: `packages/cli/src/update.ts`, `packages/cli/src/feedback.ts`, `packages/cli/src/analyze.ts`, `packages/core/src/hooks.ts`, `scripts/publish-opencanon-release.ts`, `docs/runtime-update-security.md`, `README.md`, `tests/update-guard.test.ts`, `tests/feedback.test.ts`, `tests/validator.test.ts`, `tests/release.test.ts`
Impact surfaces: [release-update](opencanon://impact-surfaces/release-update), [local-service-control](opencanon://impact-surfaces/local-service-control), [project-canon-model](opencanon://impact-surfaces/project-canon-model)
Checks: `release-tests`, `typecheck`, `project-doctor`

Task `runtime-repair-hardening`: Make supervised runtime repair deterministic across worktrees and stale pipes
Files: `packages/cli/src/brief.ts`, `packages/cli/src/changes.ts`, `packages/cli/src/runtime-client.ts`, `packages/cli/src/validate.ts`, `packages/core/src/index.ts`, `packages/core/src/language-analyzer.ts`, `packages/core/src/producer-registry.ts`, `packages/core/src/type-facts-provider.ts`, `packages/core/src/validator.ts`, `packages/runtime/src/server.ts`, `packages/runtime/src/service.ts`, `packages/runtime/src/type-producer/producer-main.ts`, `packages/runtime/src/type-producer/runtime.ts`, `packages/runtime/test/type-producer.test.ts`, `packages/runtime/test/service.test.ts`, `tests/validator.test.ts`, `tests/worktree.test.ts`
Impact surfaces: [local-service-control](opencanon://impact-surfaces/local-service-control)
Checks: `runtime-tests`, `service-lifecycle-tests`, `worktree-tests`

Task `headless-runtime-split`: Split retired UI and site surfaces away from the runtime API branch
Files: `package.json`, `package-lock.json`, `vitest.config.ts`, `.github/workflows/**`, `packages/service-contracts/**`, `packages/runtime/**`, `packages/validators/**`, `apps/site/**`, `opencanon/fixtures/**`, `scripts/**`, `README.md`
Impact surfaces: [local-service-control](opencanon://impact-surfaces/local-service-control), [project-canon-model](opencanon://impact-surfaces/project-canon-model), [release-update](opencanon://impact-surfaces/release-update)
Checks: `typecheck`, `release-tests`, `release-check`, `runtime-build`

## Dependencies

No change dependencies are recorded.

## Links

No external links are recorded.
