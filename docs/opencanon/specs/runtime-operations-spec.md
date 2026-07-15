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
- Files: `packages/runtime/src/service*.ts`
- Files: `packages/runtime/src/check-command-guardian.ts`
- Files: `packages/runtime/src/index.ts`
- Files: `packages/runtime/src/server-change-runtime.ts`
- Files: `packages/runtime/src/change-check-runner.ts`
- Files: `packages/runtime/src/server-routes.ts`
- Files: `packages/runtime/src/cli-status.ts`
- Files: `packages/runtime/src/cli.ts`
- Files: `packages/runtime/src/state.ts`
- Files: `packages/runtime/src/snapshot.ts`
- Files: `packages/runtime/src/project-analysis*.ts`
- Files: `packages/cli/src/changes.ts`
- Files: `packages/cli/src/runtime-client.ts`
- Files: `packages/runtime/test/client-test-sources.ts`
- Files: `packages/runtime/test/*.test.ts`
- Files: `tests/runtime-events.test.ts`
- Files: `tests/cli-reporting.test.ts`
- Files: `package.json`
- Docs: `docs/opencanon/specs/runtime-operations-spec.md`

## Impact surfaces

- [Local service control plane](../areas/local-service-and-runtimes.md#local-service-and-project-runtimes)
- [Project Canon model](../areas/project-map-governance.md#project-map-governance)
- [Project Knowledge](../areas/project-knowledge-index.md#project-knowledge)
- [Release and update path](../areas/runtime-release-update.md#runtime-updates)

## Areas

- [Local Service and Project Runtimes](../areas/local-service-and-runtimes.md)
- [Project Map Governance](../areas/project-map-governance.md)

## Checks

- `contracts-tests` test `tests/contracts.test.ts`
- `engine-tests` command `npm run check:engine`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `semantic-index-tests` test `packages/runtime/test/semantic-index.test.ts`
- `project-analysis-tests` test `packages/runtime/test/project-analysis.test.ts`
- `change-run-tests` test `packages/runtime/test/change-runs.test.ts`
- `runtime-supervision-tests` test `packages/runtime/test/runtime-supervision.test.ts`
- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `cli-tests` test `tests/cli-reporting.test.ts`
- `doctor-tests` test `tests/validator-runtime.test.ts`
- `worktree-tests` test `tests/worktree.test.ts`
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

Rule `operation-resources-are-bounded`: A project runtime bounds active operation admission and terminal run history without deleting non-terminal work.
- admission rejects a whole batch before capacity is exceeded
- terminal history is pruned by age and count
- run events cascade when their run is removed
- active operations leave process readiness running and expose work through operation resources
- process inspection cannot overwrite a concurrent lifecycle transition
- Project State allocates monotonic run-event sequences atomically across runtime connections
Checks: `contracts-tests`, `change-run-tests`, `runtime-supervision-tests`, `engine-tests`

Rule `persisted-runs-remain-operable`: Clients can list, inspect, watch, and cancel persisted runs independently of the process that created them.
- list and show responses are bounded
- watch resumes from an event cursor without polling
- terminal cancellation is idempotent
- shell checks use explicit bounded timeout budgets
- active runs prevent lazy runtime shutdown and receive a full idle window after completion
- in-flight responses and event streams hold an activity lease until transport completion
Checks: `change-run-tests`, `runtime-client-tests`

Rule `isolated-check-runtimes-follow-owner-lifecycle`: Shell-backed Proof uses isolated service namespaces whose service, project runtimes, and generated workspace share one explicit owner lifecycle.
- owner death stops the isolated service, every child project runtime, and the active shell process tree
- completed checks remove their generated workspace
- a later check reaps an orphaned workspace only after its owner is dead
Checks: `change-run-tests`, `service-lifecycle-tests`

Rule `proof-guardians-use-process-liveness`: A Proof command guardian distinguishes actual owner-process death from a temporarily blocked owner event loop and always enforces the declared command deadline.
- owner-process death terminates the complete command process tree
- an owner event-loop stall within the command budget does not cancel healthy work
- the external guardian enforces the deadline even when the owner event loop cannot run
Checks: `service-lifecycle-tests`, `change-run-tests`

Rule `state-projections-use-complete-activity`: Correctness-sensitive Change state is derived from complete indexed Activity for the relevant Changes, while browsing feeds remain bounded.
- unrelated Activity cannot reopen closed work
- ready work and snapshots use the same complete history
- complete history is queried in one batch for current Changes
Checks: `engine-tests`, `runtime-client-tests`, `worktree-tests`

Rule `local-clients-use-pipe-transport`: Local CLI and MCP requests use the pipe control plane by default while loopback HTTP remains an explicit browser and diagnostics adapter.
- brief uses the shared default runtime client
- commands do not select HTTP without a surface requirement
- pipe transport is covered by integration proof
Checks: `runtime-client-tests`, `cli-tests`

Rule `doctor-reports-live-knowledge`: Doctor reports current Project Knowledge readiness when a matching project runtime is running and never presents an uninspected snapshot as ready.
- stale or missing live Knowledge warns
- invalid state or a failed live probe fails
- no running runtime is described as uninspected
Checks: `doctor-tests`, `cli-tests`, `runtime-client-tests`

Rule `diagnostics-do-not-start-project-work`: Doctor and status surfaces inspect bounded current state without starting producers, validation, indexing, or project snapshot revisions.
- an idle producer remains idle after Doctor
- Doctor does not publish a project revision
- pipe and HTTP health remain responsive throughout Doctor
- typed validation starts its required producer and publishes the generation it consumed
Checks: `doctor-tests`, `cli-tests`, `runtime-client-tests`, `service-lifecycle-tests`

Rule `source-refresh-preserves-transports`: Project source refresh keeps pipe and HTTP responsive by running complete analysis outside the serving runtime and publishing only a complete accepted revision.
- the serving process does not perform discovery, fact extraction, graph construction, or project validation
- superseded analysis is cancelled and cannot publish
- analysis failure preserves the previous snapshot and serving transports
- graph indexing writes a private generation that stays invisible until the serving runtime accepts it
- the product projection and graph generation commit only for the newest observed revision
- native graph writes do not run on the serving JavaScript event loop
- graph readers use independent SQLite WAL connections while graph writes are pending
- Activity and other Project State writes do not contend with graph transactions
- complete source identity derives changed and deleted graph files inside the graph store
- missing or incompatible graph state rebuilds from source
- cold graph extraction bounds memory by streaming files into one transaction
- a long refresh does not replace the serving runtime
Checks: `engine-tests`, `project-analysis-tests`, `runtime-client-tests`, `service-lifecycle-tests`

Rule `knowledge-builds-are-explicit-and-isolated`: Project Knowledge reads never start indexing, while native index and query inference execute with bounded memory outside the serving runtime.
- missing or stale Knowledge fails read commands immediately
- only project index starts a build
- source and embedding batches have fixed bounds
- index and query worker failures preserve runtime availability and the last published index
- native embedding models are never loaded into the serving runtime
Checks: `semantic-index-tests`, `runtime-client-tests`, `service-lifecycle-tests`

Rule `mutating-runtime-requests-are-idempotent`: A repaired client may retry a mutating runtime request with the same request identity without duplicating or contradicting committed Activity.
- an identical event retry returns the committed event
- reusing an event id for different content fails explicitly
- asynchronous check persistence failures terminate the run rather than the runtime
Checks: `change-run-tests`, `runtime-client-tests`

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

Scenario `client-reattaches-to-check-run`
- Given a Change check continues after its initiating client exits
- When another client inspects and watches the persisted run
- Then the run is discoverable
- Then unseen output replays from the requested cursor
- Then one terminal result is observed
Checks: `change-run-tests`, `runtime-client-tests`

Scenario `agent-brief-survives-unrelated-activity`
- Given a Change and all of its tasks are closed
- Given more than 500 newer events belong to other Changes
- When an agent requests ready work or a briefing
- Then the closed Change is absent from ready and blocked work
- Then the briefing queue agrees with the Change snapshot
Checks: `engine-tests`, `runtime-client-tests`, `worktree-tests`, `cli-tests`

Scenario `search-observes-missing-knowledge`
- Given Project Knowledge has not been built
- When a client searches or reads semantic context
- Then the request returns semantic-index-not-ready without scanning the repository
- Then the project runtime stays healthy
- Then the response points to opencanon project index
Checks: `semantic-index-tests`, `runtime-client-tests`, `cli-tests`

## Governance

- infer governing conventions from spec scope
- convention [Runtime failures use explicit error payloads](../canon/explicit-error-contracts.md)
- convention [Runtime data updates through explicit service events](../canon/service-events-current.md)
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
