# Runtime Operations Spec

## Summary

Long-running project operations expose bounded status, durable execution state, replayable progress, and explicit cancellation through one runtime contract.

## Scope

- Files: `packages/core/src/contracts-runtime.ts`
- Files: `packages/core/src/contracts-change-runs.ts`
- Files: `packages/engine/src/index.ts`
- Files: `crates/opencanon-engine/src/project.rs`
- Files: `crates/opencanon-engine/src/contracts.rs`
- Files: `crates/opencanon-engine/src/state.rs`
- Files: `crates/opencanon-engine/src/migrations/*.sql`
- Files: `packages/runtime/src/server-events.ts`
- Files: `packages/runtime/src/routes.ts`
- Files: `packages/runtime/src/local-protocol.ts`
- Files: `packages/runtime/src/service-http.ts`
- Files: `packages/runtime/src/service-server.ts`
- Files: `packages/runtime/src/index.ts`
- Files: `packages/runtime/src/server-change-runtime.ts`
- Files: `packages/runtime/src/change-check-runner.ts`
- Files: `packages/runtime/src/server-routes.ts`
- Files: `packages/runtime/src/cli-status.ts`
- Files: `packages/runtime/src/cli.ts`
- Files: `packages/runtime/src/state.ts`
- Files: `packages/runtime/src/snapshot.ts`
- Files: `packages/cli/src/changes.ts`
- Files: `packages/cli/src/runtime-client.ts`
- Files: `packages/runtime/test/*.test.ts`
- Files: `tests/runtime-events.test.ts`
- Docs: `docs/opencanon/specs/runtime-operations-spec.md`

## Impact surfaces

- [Local service control plane](../areas/local-service-and-runtimes.md#local-service-and-project-runtimes)
- [Project Canon model](../areas/project-map-governance.md#project-map-governance)
- [Project Knowledge](../areas/project-knowledge-index.md#project-knowledge)

## Areas

- [Local Service and Project Runtimes](../areas/local-service-and-runtimes.md)
- [Project Map Governance](../areas/project-map-governance.md)

## Checks

- `contracts-tests` test `tests/contracts.test.ts`
- `engine-tests` command `npm run check:engine`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `change-run-tests` test `packages/runtime/test/change-runs.test.ts`
- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `project-doctor` doctor

## Rules

Rule `status-is-bounded-summary`: Public project status is a bounded summary and never serializes internal dependency inventories.
- validator graph status reports dependency count instead of paths
- full graph inputs require explicit inspection
- status size is bounded on large projects
Checks: `contracts-tests`, `runtime-client-tests`

Rule `long-work-is-a-run-resource`: Every Change check executes as a persisted run with a stable identity and explicit terminal state.
- start returns a run identity before completion
- runtime restart finalizes interrupted runs
- result and bounded output remain queryable
Checks: `change-run-tests`, `engine-tests`

Rule `progress-is-replayable`: Check progress and output use sequenced runtime events that reconnect from a cursor without polling.
- output is visible before process exit
- reconnect replays unseen events
- slow clients cannot create unbounded memory growth
Checks: `change-run-tests`, `runtime-client-tests`

Rule `cancellation-is-explicit`: Client cancellation and runtime shutdown terminate owned check process trees and persist a cancelled or interrupted terminal result.
- Ctrl-C sends cancellation
- runtime shutdown leaves no child check process
- terminal events distinguish cancellation from failure
Checks: `change-run-tests`, `service-lifecycle-tests`

## Scenarios

Scenario `agent-watches-long-check`
- Given a Change check runs longer than one response timeout
- When an agent starts the check
- Then the CLI prints progress while it runs
- Then the run survives client reconnection
- Then the terminal result is persisted once
Checks: `change-run-tests`, `runtime-client-tests`

Scenario `client-reads-large-project-status`
- Given a validator graph has thousands of dependency files
- When a client requests project status
- Then the response stays bounded
- Then dependency count remains visible
- Then an explicit inspection command can list dependency paths
Checks: `contracts-tests`, `runtime-client-tests`

## Governance

- infer governing conventions from spec scope
- convention [Runtime failures use explicit error payloads](../canon/explicit-error-contracts.md)
- convention [Runtime data updates through explicit service events](../canon/service-events-current.md)
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
