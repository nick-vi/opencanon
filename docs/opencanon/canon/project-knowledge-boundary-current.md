# Project Knowledge is derived OpenCanon runtime state

## Rule

Project Knowledge belongs to OpenCanon runtime state; authored definitions stay in repo source, and semantic results remain advisory unless backed by checks or convention runtimes.

## Applies to

- `packages/core/src/semantic-index.ts`
- `packages/runtime/src/knowledge-producers.ts`
- `packages/runtime/src/semantic-index.ts`
- `packages/runtime/src/snapshot.ts`
- `packages/runtime/src/server*.ts`
- `crates/opencanon-vector/**`
- `crates/opencanon-inference/**`
- `docs/opencanon/canon/architecture.md`

## Why

Search, chunks, embeddings, and related-code retrieval are valuable only when they serve the OpenCanon product model. Treating them as a separate product or authored source of truth would split responsibility and weaken deterministic enforcement.

## Examples

- A chunk can backlink to an area, spec, change item, convention, finding, and impact surface, but the chunk itself is regenerated state.

- Use search to discover likely related code, then enforce behavior through validators, checks, gates, or tests.

## Related impact surfaces

- [Project Knowledge](../areas/project-knowledge-index.md#project-knowledge)
