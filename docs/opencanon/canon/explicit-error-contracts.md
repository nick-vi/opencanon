# Runtime failures use explicit error payloads

Convention id: `explicit-error-contracts`.
Render style: `reference`.

## Rule

Rule: OpenCanon transport failures return `{ ok: false, error }`, where `error.kind` is either `problem` or `diagnostics`; top-level `diagnostics` remains internal/domain data only.

## Applies to

Kind: `files`
- file glob `packages/runtime/src/routes.ts`
- file glob `packages/runtime/src/server.ts`
- file glob `packages/runtime/src/service.ts`
- file glob `packages/runtime/src/local-protocol.ts`
- file glob `packages/runtime/test/**/*.ts`
- file glob `tests/contracts.test.ts`

## Runtime checks

Kind: `validator`
Severity: `error`
Scope: `project`
Facts: none
Fixtures: `valid-and-invalid`

## Why

Rationale: Humans and agents need predictable failure envelopes across runtime HTTP, local IPC, CLI, MCP, and browser diagnostics. Keeping problems and diagnostics under one `error` key prevents ambiguity with successful response diagnostics.

## Examples

Example 1:
Note: Use `diagnosticsFailure(...)` or `diagnostic(...)` at runtime route boundaries.

Example 2:
Note: Use `error: { kind: "problem", problem }` for predictable user-facing remediation such as project-open failures.

Example 3:
Note: Keep validation and settings internals free to return `diagnostics` until they are wrapped at HTTP, IPC, CLI, or MCP boundaries.

## Related impact surfaces

- [local-service-control](opencanon://impact-surfaces/local-service-control)

## Related conventions

No related conventions are recorded.
