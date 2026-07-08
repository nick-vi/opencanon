# Runtime failures use explicit error payloads

## Rule

OpenCanon transport failures return `{ ok: false, error }`, where `error.kind` is either `problem` or `diagnostics`; top-level `diagnostics` remains internal/domain data only.

## Applies to

- `packages/runtime/src/routes.ts`
- `packages/runtime/src/server.ts`
- `packages/runtime/src/service.ts`
- `packages/runtime/src/local-protocol.ts`
- `packages/runtime/test/**/*.ts`
- `tests/contracts.test.ts`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `project`
- Fixtures: `valid-and-invalid`

## Why

Humans and agents need predictable failure envelopes across runtime HTTP, local IPC, CLI, MCP, and browser diagnostics. Keeping problems and diagnostics under one `error` key prevents ambiguity with successful response diagnostics.

## Examples

- Use `diagnosticsFailure(...)` or `diagnostic(...)` at runtime route boundaries.

- Use `error: { kind: "problem", problem }` for predictable user-facing remediation such as project-open failures.

- Keep validation and settings internals free to return `diagnostics` until they are wrapped at HTTP, IPC, CLI, or MCP boundaries.

## Related impact surfaces

- [local-service-control](opencanon://impact-surfaces/local-service-control)
