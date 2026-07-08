# Runtime data updates through explicit service events

## Rule

Service and project-runtime data updates come from explicit runtime events; transport failures enter reconnecting or offline states rather than hidden project-data fallback.

## Applies to

- `packages/runtime/src/server-events.ts`
- `packages/runtime/src/service.ts`
- `packages/runtime/src/server.ts`
- `packages/runtime/test/service.test.ts`
- `packages/runtime/test/client.test.ts`

## Why

Project data should either come from the project runtime event stream or be visibly unavailable. Silent polling fallback makes stale data look healthy and hides transport failures from humans and agents.

## Examples

- Runtime snapshots update summary, doctor, gates, context, Activity, and Project Map queries from the project event stream.

- Refresh Project restarts event-stream repair after bounded reconnect attempts instead of leaving hidden polling active.

- Service discovery may refresh service health, but it does not replace project runtime live updates.

## Related impact surfaces

- [local-service-control](opencanon://impact-surfaces/local-service-control)

## Related conventions

- [state-ownership-current](opencanon://conventions/state-ownership-current)
