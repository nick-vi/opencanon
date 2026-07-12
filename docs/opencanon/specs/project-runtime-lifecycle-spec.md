# Project Runtime Lifecycle Spec

## Summary

The local service owns a ready-only, typed, and retry-aware lifecycle for isolated project runtimes.

## Scope

- Files: `packages/runtime/src/service*.ts`
- Files: `packages/runtime/src/cli.ts`
- Files: `packages/cli/src/runtime-client.ts`
- Files: `packages/cli/src/index.ts`
- Files: `packages/core/src/problem.ts`
- Files: `packages/core/src/validator-graph.ts`
- Files: `packages/runtime/test/service.test.ts`
- Files: `packages/runtime/test/service-reconcile.test.ts`
- Files: `packages/runtime/test/client.test.ts`
- Docs: `docs/opencanon/specs/project-runtime-lifecycle-spec.md`

## Impact surfaces

- [Local service control plane](../areas/local-service-and-runtimes.md#local-service-and-project-runtimes)

## Areas

- [Local Service and Project Runtimes](../areas/local-service-and-runtimes.md)
- [Explicit Error Contracts](../areas/explicit-error-contracts.md)

## Checks

- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `contracts-tests` test `tests/contracts.test.ts`
- `project-doctor` doctor

## Rules

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
Checks: `service-lifecycle-tests`, `runtime-client-tests`

## Scenarios

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

## Governance

- infer governing conventions from spec scope
- convention [Runtime failures use explicit error payloads](../canon/explicit-error-contracts.md)
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
