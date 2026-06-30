# Architecture

## DAL

DAL modules are thin persistence adapters.

Rules:

- DAL functions accept simple input values or typed insert/update objects.
- The optional transaction/client parameter is last.
- Not-found reads return `null`.
- Batch functions return early for empty input.
- Business rules stay in services, not DAL.

## Services

Services compose workflows and business decisions.

Rules:

- Call DAL functions for persistence.
- Pass transaction/client parameters through multi-step workflows.
- Name service implementation files with the `*.service.ts` or `*.service.tsx` suffix.
- Do not import DB clients for ordinary reads or writes.
- Do not build table queries in services.
- Keep HTTP/request concerns out of services.

## Imports

Imports should make ownership clear.

Rules:

- Use same-folder relative imports for colocated private helpers.
- Use approved aliases or barrels for cross-layer dependencies.
- Avoid imports that climb multiple parent folders.
- Do not deep-import another layer's private implementation files.

## Framework Packages

OpenCanon framework packages depend inward.

Rules:

- Core owns shared contracts, schemas, context loading, validation runtime, and filesystem-safe primitives.
- Validator factories depend on core and local validator helpers.
- The engine TypeScript wrapper depends on core and the Rust engine binary.
- Service contracts stay dependency-free.
- The service/runtime package depends on service contracts, core, engine, distribution, observability, and validators.
- The CLI depends on service contracts, core, distribution, and the service/runtime package.
- Shared contracts move into service contracts or core rather than importing upward from the service/runtime package, CLI, engine, or validators.

## Product Language

Product-facing copy uses the smallest public vocabulary that still maps to the precise internal model. Public terms describe what a user is doing; internal terms describe the source type, runtime process, or implementation structure.

Rules:

- Use `OpenCanon runtime` or `OpenCanon CLI` for the installed product; use `service` or `project runtime` in setup, Health, CLI, and architecture contexts.
- Use `Project Canon` as the umbrella for conventions, areas, specs, and changes.
- Use `Proof` for checks, validators, gates, doctor, coverage, and deterministic enforcement.
- Use `Knowledge` for index, graph, backlinks, chunks, search, and related-code retrieval.
- Use `Activity` for events, agent runs, indexing progress, check results, logs, and live runtime movement.
- Use `Changes` for active planned changes in user-facing copy; keep `Change` for internal type names, DTOs, source files, and command identifiers.
- Use `Surfaces` for impact/risk areas in navigation and headings; use `Impact Surface` when explaining the model contract.
- Use `Project Map` for the user-facing relationship graph; keep `DefinitionGraph` and `definition graph` for source APIs and architecture details.
- Use `Search` for the focused retrieval action; use `Knowledge` for the broader product area. Keep `Semantic Index`, `chunks`, `embeddings`, and `vector store` for runtime and architecture details.
- Avoid leading product copy with implementation process terms, `definition graph`, `validator graph`, `projection`, `chunk`, or `embedding`.

Terminology contract:

- Public: `OpenCanon runtime`, `OpenCanon CLI`, `Project`, `Project Canon`, `Proof`, `Knowledge`, `Activity`, `Living Conventions`, `Areas`, `Specs`, `Changes`, `Project Map`, `Surfaces`, `Checks`, `Search`, `Doctor`, `Health`.
- Internal/source: `Definition`, `Change`, `DefinitionGraph`, `ImpactSurface`, `Validator`, `CommitGate`, `Semantic Index`, `SemanticChunk`, `Embedding`, `Local Service`, `Project Runtime`, `projection`.
- Generated docs may expose ids and source names, but titles, summaries, and first-read prose should use public terms first.

## Context Index

OpenCanon owns project context indexing as derived runtime state, not as a separate product.

Rules:

- The installed OpenCanon runtime owns Search, chunking, embeddings, vector storage, related-code retrieval, lineage signals, and ranking.
- Chunks are generated from files, facts, docs, and definitions. They are not hand-authored definitions and are never the source of truth.
- Context index state lives in `.opencanon/` SQLite/vector storage and can be rebuilt from committed definitions plus project files.
- Chunks can backlink to conventions, checks, findings, specs, areas, change, impact surfaces, docs, files, and symbols.
- Embedding and LLM-derived results are advisory context unless a deterministic convention runtime, check, gate, or test enforces the claim.
- Do not expose `Context Engine` as a separate user-facing product inside OpenCanon. Use OpenCanon product terms and keep implementation names in architecture/source contexts.

## State Ownership

Repo definitions are the source of truth; runtime and project state are generated or derived.

Rules:

- Committed repo files own conventions, areas, change definitions, validators, fixtures, and generated docs.
- `.opencanon/generated`, `.opencanon/cache`, `.opencanon/state.sqlite`, runtime logs, runtime registry files, and commit approvals are project-local state.
- Semantic chunks, embeddings, search indexes, vector files, lineage summaries, and product-model projections are generated project-local state.
- The OpenCanon home directory owns the global service registry, installed runtime bundles, update metadata, and cross-project discovery state.
- SQLite product-model rows are projections and history, never the source of truth for definitions.
- Doctor should validate generated-state freshness and ignore rules before project state is trusted.

## Specs

Specs describe durable product or business behavior as typed repo definitions.

Rules:

- Author specs in `opencanon/specs/index.ts` or the configured specs path.
- Link specs to implementation scope, impact surfaces, checks, and governing conventions.
- Render OpenCanon-owned spec docs from the spec definition; use `render: { kind: "none" }` when a spec has no generated Markdown.
- Treat checks and governing conventions as the enforcement path that keeps a spec aligned with code.
- Do not use empty file globs as the authoring contract for spec validation; use the explicit definition or project validation domain.

## API Routes

Route handlers are HTTP adapters. They validate input, call services, and serialize responses.

Rules:

- Validate params, query, and body at the route boundary.
- Use services for workflows and business decisions.
- Do not call DAL modules directly from route handlers.
- Keep response DTO mapping explicit.
- Keep route files organized by resource.

## Schemas

Schemas describe boundaries.

Rules:

- Contract schemas describe external request/response DTOs.
- Database schemas describe persistence tables and relations.
- Do not import database table definitions into public contract modules.
- Prefer one canonical exported schema per boundary concept.
