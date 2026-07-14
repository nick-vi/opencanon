# Project Runtime Lifecycle Spec

## Summary

The local service and project runtime expose revision-driven readiness, typed failure, and deterministic shutdown.

## Scope

- Files: `packages/runtime/src/service*.ts`
- Files: `packages/runtime/src/cli.ts`
- Files: `packages/runtime/src/state-manager.ts`
- Files: `packages/runtime/src/activity-tracker.ts`
- Files: `packages/core/src/contracts-runtime.ts`
- Files: `packages/cli/src/runtime-client.ts`
- Files: `packages/cli/src/index.ts`
- Files: `packages/core/src/problem.ts`
- Files: `packages/core/src/validator-graph.ts`
- Files: `packages/runtime/test/service.test.ts`
- Files: `packages/runtime/test/service-reconcile.test.ts`
- Files: `packages/runtime/test/client-test-sources.ts`
- Files: `packages/runtime/test/client.test.ts`
- Files: `tests/cli-reporting.test.ts`
- Files: `tests/mcp.test.ts`
- Files: `tests/worktree.test.ts`
- Files: `.github/workflows/ci.yml`
- Files: `package.json`
- Docs: `docs/opencanon/specs/project-runtime-lifecycle-spec.md`

## Impact surfaces

- [Local service control plane](../areas/local-service-and-runtimes.md#local-service-and-project-runtimes)
- [Release and update path](../areas/runtime-release-update.md#runtime-updates)

## Areas

- [Local Service and Project Runtimes](../areas/local-service-and-runtimes.md)
- [Explicit Error Contracts](../areas/explicit-error-contracts.md)

## Checks

- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `contracts-tests` test `tests/contracts.test.ts`
- `coordinator-tests` test `packages/runtime/test/state-manager.test.ts`
- `activity-tests` test `packages/runtime/test/activity-tracker.test.ts`
- `project-doctor` doctor

## Rules

Rule `readiness-is-revision-driven`: Project readiness is determined by published and observed revisions rather than timing or a momentary process status.
- every accepted refresh has a monotonic revision
- queued filesystem refreshes coalesce to the newest revision
- superseded rebuilds cannot publish
- summary responses expose observed, accepted, and published revisions
Checks: `coordinator-tests`, `runtime-client-tests`, `contracts-tests`

Rule `transport-and-project-readiness-are-distinct`: Transport liveness, project snapshot readiness, and Project Knowledge readiness are independently observable states.
- transport can accept status requests while project refresh is active
- project summary reports freshness without pretending transient work is failure
- Knowledge routes reject missing, indexing, stale, or failed indexes explicitly
Checks: `runtime-client-tests`, `contracts-tests`

Rule `idle-shutdown-requires-quiescence`: A runtime can stop for idleness only after transport leases, Change checks, queued refreshes, and active refreshes are all complete.
- transport leases release exactly once
- stream cancellation releases its lease
- queued coordinator work prevents idle shutdown
- completed work receives a full idle window
Checks: `activity-tests`, `runtime-client-tests`

Rule `ensure-means-ready`: A successful project ensure or start result must reference a runtime whose process identity and health endpoint have been verified.
- process spawn is not returned as command success
- starting remains observable while the request waits
- ready results carry the running lifecycle
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Rule `startup-failure-is-typed`: A project runtime that exits during startup must return a structured problem or diagnostics payload to the supervising service before it exits.
- failure includes the project path
- missing definition errors include the missing path and repair action
- clients do not parse runtime logs to recover the cause
Checks: `service-lifecycle-tests`, `runtime-client-tests`, `contracts-tests`

Rule `retryability-drives-repair`: Automatic repair and reconciliation retry transient runtime failures but do not retry deterministic non-retryable project failures.
- dead or disconnected healthy projects can restart
- invalid project definitions become terminal failures
- a repaired project can be started explicitly
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Rule `service-owns-startup-state`: The local service owns project startup waiting, process cleanup, and repair; clients consume its result instead of implementing a second startup state machine.
- CLI and runtime client share the same ensure path
- one startup lock serializes a project start
- failed starts leave no registered or orphaned worker
- owner-bound temporary services terminate when their owner exits
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Rule `process-control-is-namespaced`: Each runtime distribution owns a deterministic namespace for global control state, project processes, SQLite state, and vector state.
- installed and source services use different registries
- runtime registrations, worker leases, SQLite state, and vector state use the same namespace as their service
- namespace values cannot escape generated-state directories
- ephemeral Proof state is removed with its owned workspace
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Rule `doctor-inspects-settled-runtime`: Doctor waits within a bounded lifecycle budget for expected project startup or active work before inspecting runtime health, producers, and Project Knowledge.
- Doctor immediately after validation does not report transient busy work as unhealthy
- all live checks observe the settled matching runtime
- work that exceeds the budget remains an explicit nonzero lifecycle failure
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Rule `isolated-clients-retire-owned-processes`: Tests and ephemeral clients that create private service registries must retire every service and project process they own before deleting their workspace.
- teardown stops project runtimes before the service
- stop failures fail the test
- a completed suite leaves no process for a deleted private registry
Checks: `service-lifecycle-tests`, `runtime-client-tests`

## Scenarios

Scenario `refresh-during-refresh`
- Given a project refresh is running
- Given the watcher observes a newer source revision
- When the older refresh completes
- Then the older result is not published as current
- Then the queued work coalesces to the newest revision
- Then waiters complete only after that revision is published
Checks: `coordinator-tests`

Scenario `start-healthy-project`
- Given an initialized project has valid Project Canon definitions
- Given no project runtime is running
- When a client starts or first queries the project
- Then the service lazily starts one isolated runtime
- Then the result is returned only after health is ready
- Then subsequent clients reuse the ready runtime
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Scenario `start-incomplete-project`
- Given an OpenCanon config exists
- Given the required conventions entrypoint is missing
- When a client starts or queries the project
- Then the request fails once with a non-retryable problem
- Then the problem names the missing path and repair command
- Then no project runtime remains registered or restarts in the background
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Scenario `source-and-installed-runtime-coexist`
- Given an installed runtime and a source checkout target the same project
- When each starts its own service and project runtime
- Then neither replaces the other service registry
- Then neither retires the other worker lease
- Then each opens namespace-owned SQLite and vector state
- Then schema compatibility and indexing are evaluated independently without writer contention
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Scenario `doctor-after-project-work`
- Given a matching project runtime is registered
- Given validation or refresh work is still active
- When Doctor runs immediately after that project work
- Then Doctor waits for the runtime to settle within its bounded budget
- Then health, producer, and Knowledge checks use the ready runtime
- Then transient busy state is not rendered as a false failure
Checks: `service-lifecycle-tests`, `runtime-client-tests`

## Governance

- infer governing conventions from spec scope
- convention [Runtime failures use explicit error payloads](../canon/explicit-error-contracts.md)
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
