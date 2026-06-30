# Repo definitions own truth; generated state stays derived

Convention id: `state-ownership-current`.
Render style: `reference`.

## Rule

Rule: Committed repo definitions are the source of truth; .opencanon and OpenCanon home directory data are generated state, projections, cache, history, indexes, or local service metadata.

## Applies to

Kind: `files`
- file glob `opencanon/**/*.ts`
- file glob `docs/opencanon/**/*.md`
- file glob `.agents/skills/**/*.md`
- file glob `.opencanon/**`
- file glob `packages/runtime/src/**/*.{ts,tsx}`
- file glob `packages/core/src/doctor.ts`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: A local service introduces global state, project-local state, and committed definitions. Mixing those ownership domains causes stale docs, unreviewed state drift, and hard-to-debug runtime behavior.

## Examples

Example 1:
Note: Project Canon lives in opencanon/conventions, opencanon/areas, opencanon/specs, and opencanon/changes.

Example 2:
Note: Product model rows, semantic chunks, and vector files in .opencanon are derived from committed definitions and project files.

## Related impact surfaces

- [local-service-control](opencanon://impact-surfaces/local-service-control)
- [project-context-index](opencanon://impact-surfaces/project-context-index)
- [project-canon-model](opencanon://impact-surfaces/project-canon-model)

## Related conventions

No related conventions are recorded.
