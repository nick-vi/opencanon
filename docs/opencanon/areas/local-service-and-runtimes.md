# Local Service and Project Runtimes

## Summary

The OpenCanon local service discovers projects and lazily starts isolated per-project runtimes.

## Ownership

Files: packages/service-contracts/**, packages/runtime/src/service*.ts, packages/runtime/src/local-protocol.ts, packages/runtime/src/routes.ts, packages/cli/src/runtime-client.ts, packages/runtime/test/service.test.ts
Endpoints: /api/projects/ensure (service), /api/projects/request (service), /api/projects/events/stream (service)
Commands: opencanon service (cli), opencanon project (cli)

## Impact surfaces

- [Local service control plane](local-service-and-runtimes.md#local-service-and-project-runtimes)

## Checks

- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `project-doctor` doctor

## Stories

Story `lazy-project-runtime`: as developer, I want OpenCanon commands to start the project runtime on demand, so projects do not require manually managed background processes.
- service registry records runtime identity
- large context requests move through the local protocol
- project start succeeds only after runtime health is ready
- non-retryable project failures remain terminal until the project is repaired
Checks: `runtime-client-tests`, `project-doctor`

## Behaviors

Behavior `large-related-context-request`: CLI requests related context for a large change set; the request uses the local protocol without exceeding HTTP query/header limits.
Checks: `runtime-client-tests`

Behavior `project-event-stream-is-explicit`: local service proxies project runtime events to CLI, MCP, and diagnostics clients; transport close or failure is reported as an explicit event-stream error instead of being masked by stale project data.
Checks: `runtime-client-tests`, `service-lifecycle-tests`

Behavior `project-worker-single-owner`: local service starts or repairs a project runtime; one project worker owns the repo state before SQLite opens, while stale or duplicate workers are retired.
Checks: `service-lifecycle-tests`

Behavior `project-start-is-readiness-contract`: CLI, MCP, or app client asks the local service to ensure a project runtime; success means verified ready; failure preserves a typed cause, retry policy, project path, and recovery action.
Checks: `runtime-client-tests`, `service-lifecycle-tests`

## Governance

- infer governing conventions from owned scope
- convention [Framework packages depend inward](../canon/framework-package-boundaries.md)
- convention [Runtime data updates through explicit service events](../canon/service-events-current.md)
