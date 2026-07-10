# Project Knowledge

## Summary

OpenCanon owns search, chunks, embeddings, vector storage, and related-code retrieval as derived project runtime state tied back to definitions.

## Ownership

Files: packages/core/src/semantic-index.ts, packages/core/src/semantic-models.ts, packages/runtime/src/project-context.ts, packages/runtime/src/knowledge-producers.ts, packages/runtime/src/semantic-index.ts, packages/runtime/src/state.ts, packages/runtime/test/semantic-index.test.ts, crates/opencanon-engine/src/migrations/005_knowledge_index.sql, crates/opencanon-engine/src/migrations/006_knowledge_hybrid.sql, crates/opencanon-vector/**, crates/opencanon-inference/**
Endpoints: /api/context/status (runtime), /api/context/search (runtime), /api/context/ask (runtime), /api/context/chunks (runtime), /api/context/coverage (runtime), /api/context/backlinks (runtime)
Docs: docs/opencanon-architecture.md
Resources: semantic-index, semantic-chunks, vector-store

## Impact surfaces

- [Project Knowledge](project-knowledge-index.md#project-knowledge)

## Checks

- `semantic-index-tests` test `packages/runtime/test/semantic-index.test.ts`
- `engine-semantic-index-tests` test `crates/opencanon-engine/src/tests.rs`
- `project-doctor` doctor

## Stories

Story `search-related-code-through-definitions`: as developer, I want search and related-code results to point back to definitions, checks, and surfaces, so search helps agents and humans navigate without becoming a separate source of truth.
- Knowledge chunks are derived from project files and facts
- search results can be scoped by paths
- doctor reports Knowledge health
Checks: `semantic-index-tests`, `project-doctor`

Story `grounded-search-and-ask`: as developer, I want Search and Ask to show evidence, citations, freshness, and backlinks, so I can understand project behavior without treating generated answers as enforcement.
- answers cite retrieved evidence
- stale context state is visible
- suggested backlinks remain proposals
Checks: `semantic-index-tests`, `project-doctor`

## Behaviors

Behavior `derived-context-substrate`: project runtime indexes project files and generated docs; chunks, embeddings, and lexical search rows are rebuilt from committed definitions and current files.
Checks: `semantic-index-tests`

Behavior `advisory-search-results`: OpenCanon search returns semantic or lexical matches; results are treated as context until a deterministic check, gate, validator, or test enforces the claim.
Checks: `project-doctor`

Behavior `deterministic-validator-context`: validator runtime queries Project Knowledge; blocking findings depend on deterministic files, facts, definitions, surfaces, chunks, freshness, coverage, or backlinks.
Checks: `project-doctor`

## Governance

- infer governing conventions from owned scope
- convention [Project Knowledge is derived OpenCanon runtime state](../canon/project-knowledge-boundary-current.md)
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Product-facing language stays simple](../canon/product-language-current.md)
