# Repo definitions own truth; generated state stays derived

## Rule

Committed repo definitions are the source of truth; .opencanon and OpenCanon home directory data are generated state, projections, cache, history, indexes, or local service metadata.

## Applies to

- `opencanon/**/*.ts`
- `docs/opencanon/**/*.md`
- `.agents/skills/**/*.md`
- `.opencanon/**`
- `packages/runtime/src/**/*.{ts,tsx}`
- `packages/core/src/doctor.ts`

## Why

A local service introduces global state, project-local state, and committed definitions. Mixing those ownership domains causes stale docs, unreviewed state drift, and hard-to-debug runtime behavior.

## Examples

- Project Canon lives in opencanon/conventions, opencanon/areas, opencanon/specs, and opencanon/changes.

- Product model rows, semantic chunks, and vector files in .opencanon are derived from committed definitions and project files.

## Related impact surfaces

- [local-service-control](opencanon://impact-surfaces/local-service-control)
- [project-context-index](opencanon://impact-surfaces/project-context-index)
- [project-canon-model](opencanon://impact-surfaces/project-canon-model)
