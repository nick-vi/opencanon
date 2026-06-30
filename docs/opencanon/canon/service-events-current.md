# Runtime data updates through explicit service events

Convention id: `service-events-current`.
Render style: `reference`.

## Rule

Rule: Service and project-runtime data updates come from explicit runtime events; transport failures enter reconnecting or offline states rather than hidden project-data fallback.

## Applies to

Kind: `files`
- file glob `packages/runtime/src/server-events.ts`
- file glob `packages/runtime/src/service.ts`
- file glob `packages/runtime/src/server.ts`
- file glob `packages/runtime/test/service.test.ts`
- file glob `packages/runtime/test/client.test.ts`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Project data should either come from the project runtime event stream or be visibly unavailable. Silent polling fallback makes stale data look healthy and hides transport failures from humans and agents.

## Examples

Example 1:
Note: Runtime snapshots update summary, doctor, gates, context, Activity, and Project Map queries from the project event stream.

Example 2:
Note: Refresh Project restarts event-stream repair after bounded reconnect attempts instead of leaving hidden polling active.

Example 3:
Note: Service discovery may refresh service health, but it does not replace project runtime live updates.

## Related impact surfaces

- [local-service-control](opencanon://impact-surfaces/local-service-control)

## Related conventions

- [state-ownership-current](opencanon://conventions/state-ownership-current)
