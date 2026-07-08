# Explicit Error Contracts

Area id: `explicit-error-contracts`.

## Summary

OpenCanon runtime, service, local protocol, CLI, and MCP failures use a single `{ ok: false, error }` envelope.

## Ownership

Files: packages/core/src/errors.ts, packages/core/src/result.ts, packages/core/src/branch.ts, packages/core/src/safe-json.ts, packages/core/src/retry.ts, packages/core/src/singleflight.ts, packages/core/src/concurrency.ts, opencanon/conventions/explicit-error-contracts.ts
Endpoints: /api/* failure envelope (runtime), /api/projects/* failure envelope (service)
Docs: docs/opencanon/areas/explicit-error-contracts.md
Resources: runtime-error-envelope

## Impact surfaces

- [local-service-control](opencanon://impact-surfaces/local-service-control)
- [project-canon-model](opencanon://impact-surfaces/project-canon-model)

## Checks

- `contracts-tests` test `tests/contracts.test.ts`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `service-lifecycle-tests` test `packages/runtime/test/service.test.ts`
- `project-validation` command `npm run opencanon -- validate --project`

## Stories

Story `predictable-project-open-errors`: as developer, I want project-open and runtime failures to carry structured problem or diagnostic payloads, so CLI, MCP, and browser diagnostics can show explicit recovery steps without guessing from strings.
- project-open failures carry `error.kind = problem`
- diagnostic failures carry `error.kind = diagnostics`
- successful payload diagnostics remain domain data
Checks: `service-lifecycle-tests`, `runtime-client-tests`, `contracts-tests`

## Behaviors

Behavior `failure-envelope-is-explicit`: runtime or service API returns a failed response; the response is `{ ok: false, error }`; top-level diagnostics are not used for transport failures.
Checks: `contracts-tests`, `runtime-client-tests`

Behavior `problem-errors-drive-client-recovery`: runtime client opens an uninitialized project; the client receives a structured problem with code, path, action, retryability, and status.
Checks: `service-lifecycle-tests`, `runtime-client-tests`

## Governance

- infer governing conventions from owned scope
- convention [explicit-error-contracts](opencanon://conventions/explicit-error-contracts)
- convention [tests-follow-risk](opencanon://conventions/tests-follow-risk)
