# Context indexing is derived OpenCanon runtime state

Convention id: `context-index-boundary-current`.
Render style: `reference`.

## Rule

Rule: Project context indexing belongs to OpenCanon runtime state; authored definitions stay in repo source, and semantic results remain advisory unless backed by checks or convention runtimes.

## Applies to

Kind: `files`
- file glob `packages/core/src/semantic-index.ts`
- file glob `packages/runtime/src/semantic-index.ts`
- file glob `packages/runtime/src/snapshot.ts`
- file glob `packages/runtime/src/server.ts`
- file glob `crates/opencanon-vector/**`
- file glob `crates/opencanon-inference/**`
- file glob `docs/opencanon/canon/architecture.md`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Search, chunks, embeddings, and related-code retrieval are valuable only when they serve the OpenCanon product model. Treating them as a separate product or authored source of truth would split responsibility and weaken deterministic enforcement.

## Examples

Example 1:
Note: A chunk can backlink to an area, spec, change item, convention, finding, and impact surface, but the chunk itself is regenerated state.

Example 2:
Note: Use search to discover likely related code, then enforce behavior through validators, checks, gates, or tests.

## Related impact surfaces

- [project-context-index](opencanon://impact-surfaces/project-context-index)

## Related conventions

No related conventions are recorded.
