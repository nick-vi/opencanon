# Explicit Error Contract Spec

## Summary

Failed OpenCanon API envelopes expose a single error payload while diagnostics remain valid domain data inside successful responses.

## Scope

- Files: `packages/core/src/errors.ts`
- Files: `packages/core/src/contracts.ts`
- Files: `packages/runtime/src/routes.ts`
- Files: `packages/runtime/src/server*.ts`
- Files: `packages/runtime/src/service.ts`
- Files: `packages/runtime/src/local-protocol.ts`
- Files: `opencanon/conventions/explicit-error-contracts.ts`
- Docs: `docs/opencanon/specs/explicit-error-contract-spec.md`

## Impact surfaces

- [Local service control plane](../areas/local-service-and-runtimes.md#local-service-and-project-runtimes)
- [Project Canon model](../areas/project-map-governance.md#project-map-governance)

## Areas

- [Explicit Error Contracts](../areas/explicit-error-contracts.md)
- [Local Service and Project Runtimes](../areas/local-service-and-runtimes.md)

## Checks

- `contracts-tests` test `tests/contracts.test.ts`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `project-validation` command `npm run opencanon -- validate --project`

## Rules

Rule `failed-envelope-uses-error`: Every transport failure is represented as `{ ok: false, error }`.
- runtime HTTP failures use `error`
- service HTTP failures use `error`
- local protocol clients parse `error`
Checks: `contracts-tests`, `runtime-client-tests`, `service-lifecycle-tests`

Rule `problem-or-diagnostics`: The error payload is discriminated as either `problem` for structured recovery or `diagnostics` for diagnostic lists.
- project-open failures use a problem payload
- diagnostic failures use a diagnostics payload
- clients branch on the error discriminant
Checks: `service-lifecycle-tests`, `runtime-client-tests`

Rule `diagnostics-domain-data-remains-allowed`: Successful response bodies and internal parser results may still expose diagnostics as domain data.
- Git/history/settings diagnostics remain successful payload fields
- internal parse functions can return diagnostics before route wrapping
Checks: `runtime-client-tests`, `project-validation`

## Scenarios

Scenario `client-opens-uninitialized-project`
- Given a folder exists but is not an initialized OpenCanon project
- When a CLI, MCP, or browser diagnostics client asks the service to ensure that project
- Then the service returns `error.kind = problem`
- Then the problem includes the folder path and setup action
- Then the client can display a predictable recovery flow
Checks: `service-lifecycle-tests`, `runtime-client-tests`

## Governance

- infer governing conventions from spec scope
- convention [Runtime failures use explicit error payloads](../canon/explicit-error-contracts.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
