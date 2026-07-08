# Context indexing is derived OpenCanon runtime state

## Rule

Project context indexing belongs to OpenCanon runtime state; authored definitions stay in repo source, and semantic results remain advisory unless backed by checks or convention runtimes.

## Applies to

- `packages/core/src/semantic-index.ts`
- `packages/runtime/src/semantic-index.ts`
- `packages/runtime/src/snapshot.ts`
- `packages/runtime/src/server.ts`
- `crates/opencanon-vector/**`
- `crates/opencanon-inference/**`
- `docs/opencanon/canon/architecture.md`

## Why

Search, chunks, embeddings, and related-code retrieval are valuable only when they serve the OpenCanon product model. Treating them as a separate product or authored source of truth would split responsibility and weaken deterministic enforcement.

## Examples

- A chunk can backlink to an area, spec, change item, convention, finding, and impact surface, but the chunk itself is regenerated state.

- Use search to discover likely related code, then enforce behavior through validators, checks, gates, or tests.

## Related impact surfaces

- [Project context index](../areas/project-context-index.md#project-context-index)
