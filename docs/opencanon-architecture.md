# OpenCanon Architecture

Scope: OpenCanon framework standalone

## Product Definition

OpenCanon turns a repository into Project Canon for agent-assisted software development.

It provides:

- loading scoped Project Canon definitions, generated docs, and project knowledge
- reading current conventions, areas, specs, changes, surfaces, and Project Map links
- enforcing convention runtime checks, gates, tests, and declared change checks
- recording findings
- exposing service-backed CLI, hook, MCP, and browser diagnostics surfaces
- indexing project knowledge for search, related-code discovery, and definition backlinks

It is not a general task tracker, chat memory system, or standalone code search product. Changes, search, and knowledge exist to serve Project Canon and runtime proof.

Model:

```text
typed Project Canon definitions -> generated docs -> project knowledge index -> runtime proof -> findings/gates
OpenCanon service -> project runtime -> CLI/hooks/MCP/browser diagnostics
```

## Runtime Architecture

OpenCanon has one execution path and no silent fallbacks.

```text
Rust watcher -> project runtime -> Rust engine/state -> fact graph/cache -> TypeScript convention runtime -> findings/gates -> CLI/MCP/hooks
```

Required choices:

- Runtime: Node.js (>=24.12.0, native TypeScript execution).
- Package installs: exact dependency versions plus committed `package-lock.json`.
- Engine bridge: napi-rs.
- Watch backend: Rust `notify` plus debouncing inside the engine.
- State storage: repo-local SQLite owned by Rust with embedded migrations.
- Service/runtimes: TypeScript on Node, using the engine for hot-path work and durable state operations.
- Rust engine: watcher, file inventory, hashing, diffing, migrations, glob matching, fact extraction, graph updates, affected calculation.
- Convention authoring: TypeScript.
- Hooks: adapters call runtime APIs after runtime unification.

If a required component is missing or stale, OpenCanon fails with a diagnostic.

## Version Policy

OpenCanon pins exact runtime package versions instead of ranges. `npm install --save-exact` is the default rule for npm dependencies, and `Cargo.lock` is committed for Rust crates.

Refresh procedure:

```bash
npm view <package> version
curl -s https://crates.io/api/v1/crates/<crate> | jq -r '.crate.max_stable_version'
node --version  # must satisfy the >=24.12.0 floor
curl -s https://api.github.com/repos/rust-lang/rust/releases/latest | jq -r '.tag_name'
```

Updating a pin requires updating package manifests, lockfiles, and the doctor version check in the same change.

### Runtime Release Manifest

OpenCanon runtime distribution is manifest-driven. The CLI detects the current target from `process.platform` and `process.arch`; agents do not choose bundle URLs manually.

Manifest contract:

- `version: 1`
- runtime version
- required Node version
- one atomic bundle per supported target (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64`), each with a `url` and SHA-256

Every bundle is a single `tar.gz` whose contents drop directly into the installed OpenCanon runtime: `cli.js`, `validators.js`, and `engine/<target>/opencanon.<target>.node`. Engine binary and JS runtime ship together to make schema drift impossible.

`opencanon update check` reads the default signed stable manifest unless `--manifest` or `OPENCANON_UPDATE_MANIFEST` overrides it, selects the current target, validates the pinned Node version, and reports `current`, `missing`, or `update-available` against the `.bundle.json` marker. `opencanon update apply` refuses to write while the service or any registered project runtime is running, downloads the target runtime bundle over HTTPS, `file:`, or a local path, verifies SHA-256, extracts to a staging directory, and swaps it into place atomically. After a real install, the apply result tells users to run `opencanon doctor --fix` inside initialized projects so Doctor refreshes managed agent guidance, agent entry blocks, generated authoring files, and install metadata through the single project-repair path.

### Toolchain

| Component | Pin | Use |
| --- | ---: | --- |
| Node.js | `>=24.12.0` | Runtime, native TS execution, runtime HTTP/SSE |
| Rust | `1.95.0` | Engine toolchain via `rust-toolchain.toml` |

### NPM Packages

| Package | Pin | Use |
| --- | ---: | --- |
| `@napi-rs/cli` | `3.6.2` | Engine build command |
| `esbuild` | `0.28.1` | Build-time bundling of the OpenCanon runtime |
| `esbuild-wasm` | `0.28.1` | Runtime validator-graph bundling (self-contained) |
| `@types/node` | `26.1.0` | Node-compatible type support |
| `cac` | `7.0.0` | CLI command parsing |
| `zod` | `4.4.3` | Runtime schemas for config, runtime API, persisted records |
| `vitest` | `4.1.9` | Tests |

Do not add `better-sqlite3`, external filesystem watcher clients, or `ws`. Rust owns durable state and file watching; Node provides the selected HTTP and SSE APIs (node:http) for this architecture.

### Rust Crates

| Crate | Pin | Use |
| --- | ---: | --- |
| `napi` | `3.9.0` | NAPI bindings |
| `napi-derive` | `3.5.6` | NAPI macros |
| `napi-build` | `2.3.2` | Engine build setup |
| `serde` | `1.0.228` | Serialization |
| `serde_json` | `1.0.149` | JSON bridge payloads |
| `blake3` | `1.8.5` | Content and cache hashing |
| `globset` | `0.4.18` | Glob matching |
| `notify` | `9.0.0-rc.4` | Cross-platform filesystem events; OpenCanon owns settled batch debouncing |
| `rusqlite` | `0.39.0` | SQLite state and embedded migrations |
| `oxc_allocator` | `0.128.0` | Oxc arena allocation |
| `oxc_ast` | `0.128.0` | JS/TS AST facts |
| `oxc_ast_visit` | `0.128.0` | AST traversal |
| `oxc_parser` | `0.128.0` | JS/TS/TSX parsing |
| `oxc_semantic` | `0.128.0` | JS/TS semantic facts |
| `oxc_span` | `0.128.0` | Source spans and line mapping |
| `oxc_syntax` | `0.128.0` | Scope flags and syntax metadata |
Initial JS/TS facts use Oxc. If a convention runtime requests facts for a language without an adapter, validation fails with `unsupported-language-facts`.

## Package Layout

```text
packages/core
  TS public types, convention API, schemas, finding types, docs and impact types

packages/validators
  curated validator factories

packages/cli
  opencanon command parser, service/runtime lifecycle commands, bootstrap checks, and runtime-backed command clients

packages/engine
  napi-rs loader and typed TS wrapper around Rust engine

packages/runtime
  Node service and project-runtime implementation, Rust engine orchestration, job runner, HTTP/SSE API

crates/opencanon-engine
  watcher, SQLite migrations/state, file inventory, hashing, glob matching, fact extraction, graph construction, affected calculation

crates/opencanon-vector
  mmap-backed vector storage and HNSW search for the project context index

crates/opencanon-inference
  native GGUF embedding and generation runtime for project-local context indexing
```

Runtime unification removes duplicate validation paths from the CLI. Normal commands use a project runtime managed by the OpenCanon service; tests and explicit one-shot callers can force an isolated in-process runtime.

## Context Index Boundary

OpenCanon owns search and retrieval internals as runtime substrate, not as a parallel product or second runtime.

Source-of-truth rules:

- Authored truth stays in TypeScript definitions, generated docs, fixtures, tests, and project source files.
- Chunks, embeddings, BM25 rows, vector files, lineage summaries, and search rankings are generated runtime state under `.opencanon/`.
- Semantic and LLM-derived output is advisory until a deterministic convention runtime, gate, check, or test enforces it.
- Project knowledge search must backlink to definitions where possible: conventions, specs, areas, changes, checks, impact surfaces, files, symbols, docs, and findings.
- Product copy says Knowledge, Search, Project Map, and related code. Architecture/source code may say Semantic Index, chunk, embedding, HNSW, vector store, and lineage.

This keeps OpenCanon definition-first. Search helps agents and humans find evidence, but it does not become the system of record.

The full Project Context implementation contract is tracked in
`docs/project-context-implementation-plan.md`. It covers chunking, embeddings,
vector storage, deterministic validator APIs, CLI/MCP surfaces, Search
and Ask, Project Map coverage, doctor, observability, security, and dogfooding.

## Runtime Modes

### Local Development

```bash
opencanon project start --foreground
```

Starts:

- foreground project runtime
- Rust watcher
- repo-local SQLite database
- browser diagnostics harness
- server-sent event state stream for browser diagnostics clients

The OpenCanon service is a registry and lifecycle controller, not a shared project runtime. It stores runtime metadata in `~/.opencanon/service.json`; each project runtime still owns exactly one repo root, one `.opencanon` state directory, one auth token, and one watcher root. Registry entries advertise both a pipe endpoint for local app/CLI traffic and a loopback URL for browser diagnostics.

### CLI Use

```bash
opencanon validate --changed
opencanon context --files src/api/routes/company.ts
opencanon feedback --changed
```

These commands first reuse a healthy project runtime. If none is running, they ask the service to lazily start the runtime, then execute the same local request protocol over the advertised pipe endpoint. The loopback URL remains a debug/browser transport. One-shot runtime servers are only used by explicit runtime-server tests and foreground runtime debugging, not as a CLI fallback.

### CI And One-Shot Commands

CI is not a fallback. It runs the same service-backed command path as local use, with tests using private service registries when persistent user service state would be noisy:

1. build the runtime artifacts
2. build the runtime bundle
3. run release, Rust, TypeScript, and Vitest checks
4. run context, fixture, doctor, manifest, and install-rehearsal checks through OpenCanon commands

## Fail-Fast Policy

| Condition | Result |
| --- | --- |
| Node version below the >=24.12.0 floor | hard fail |
| Rust watcher cannot start | hard fail or mark state stale in explicit no-watch mode |
| Engine binary missing | hard fail |
| Engine binary version differs from package version | hard fail |
| SQLite state schema is newer than runtime schema | hard fail |
| SQLite state schema is older than runtime schema | run embedded migrations at runtime startup |
| Convention definition is invalid | hard fail at runtime load |
| Convention runtime requests unsupported facts | hard fail for that validation run |
| Convention/docs schema invalid | hard fail for context/rules/docs commands |
| Hook called without a supervised runtime | start isolated ephemeral runtime; hard fail only if runtime prerequisites fail |

Predictability is more important than continuing in a weaker mode.

## Rust Watcher Contract

The engine is the only filesystem event source. OpenCanon does not require a user-installed filesystem watcher.

Project runtime startup must:

1. open the repo-local state database
2. run embedded Rust migrations
3. scan the Git-visible project inventory
4. hash the current inventory
5. diff against persisted file state
6. mark unknown or failed watcher state as stale
7. start the Rust watcher if watch mode is enabled
8. publish a fresh snapshot only after inventory, facts, graph, and findings agree

Watcher events are hints, not the source of truth. The source of truth is the next scan plus content-hash diff against SQLite state.

Required behavior:

- initial project runtime start performs a full inventory scan
- save noise is debounced before snapshot rebuild work starts
- deletes and renames are reconciled by comparing current inventory against persisted `files`
- watcher errors, event overflow, or unreadable paths mark state stale
- stale state schedules a full scan before the runtime reports ready
- `.git`, `.opencanon`, `node_modules`, build outputs, and configured ignores are excluded before hashing
- no timestamp-only freshness checks are allowed
- no per-file NAPI call loop is allowed for watcher or hash work

## Engine Engine Contract

The NAPI bridge exposes project-handle domain operations. No raw-table APIs, root-level batch helpers, or per-file NAPI loops are part of the runtime contract.

```ts
export type Engine = {
  version(): EngineVersion;
  openProject(request: OpenProjectRequest): ProjectHandle;
};

export type ProjectHandle = {
  status(): EngineProjectStatus;
  scanAndDiff(request: ScanAndDiffRequest): ScanAndDiffResult;
  extractFacts(request: ExtractFactsRequest): ExtractFactsResult;
  buildRepoGraph(request: BuildRepoGraphRequest): BuildRepoGraphResult;
  startWatcher(request: WatcherStartRequest, onBatch: WatcherBatchCallback): WatcherStartResult;
  drainWatcherEvents(): WatcherEventBatch[];
  stopWatcher(): void;
  writeEvent(event: CanonEvent): void;
  listEvents(limit?: number): CanonEvent[];
  close(): void;
};
```

The project runtime does not expose raw SQLite tables through NAPI. NAPI methods are domain operations: open project state, scan and diff inventory, extract facts, build graph data, watch files, and persist canon events. Low-level table CRUD stays inside Rust.

### Requests

```ts
export type OpenProjectRequest = {
  rootDir: string;
  statePath: string;
  settings: ResolvedProjectSettings;
};

export type ExternalTool = {
  command: string | string[];
  required?: boolean;
  missingSeverity?: "error" | "warning" | "ignore";
  versionArgs?: string[];
  timeoutMs?: number;
} | string | string[];

export type ResolvedProjectSettings = {
  docsDir: string;
  conventionsPath: string;
  fixturesDir: string;
  impactSurfacesPath: string;
  proposedImpactNotesPath: string;
  baselinePath: string;
  commitApprovalsPath: string;
  commitApprovalsPersistent: boolean;
  projectFilePatterns: string[];
  ignore: string[];
  entrypoints: string[];
  publicSurfaces: string[];
  generated: string[];
  externalTools: Record<string, ExternalTool>;
  maxFiles: number;
  maxFileSizeKb: number;
  fileDiscovery: "git" | "filesystem";
  configHash: string;
};

export type ExtractFactsRequest = {
  files: Array<{
    path: string;
    contentHash: string;
    language: "typescript" | "tsx" | "javascript" | "jsx" | "svelte" | "python" | "json" | "markdown" | "text";
  }>;
  facts: Array<
    | "imports"
    | "exports"
    | "symbols"
    | "calls"
    | "literals"
    | "comments"
    | "references"
    | "annotations"
    | "diagnostics"
    | "duplicates"
  >;
  parserVersion: string;
};

export type BuildRepoGraphRequest = {
  facts: FileFacts[];
  packageManifests: string[];
};

export type ScanAndDiffResult = {
  statePath: string;
  schemaVersion: number;
  inventoryHash: string;
  files: Array<{ path: string; contentHash: string; size: number; stale: boolean }>;
  changedFiles: string[];
  unchangedFiles: string[];
  deletedFiles: string[];
  staleFiles: number;
};

export type WatcherEventBatch = {
  rootDir: string;
  paths: string[];
  stale: boolean;
  reason?: string;
  timestamp: string;
};
```

### File Facts

```ts
export type FileFacts = {
  path: string;
  contentHash: string;
  language: string;
  parser: string;
  parserVersion: string;
  imports: ImportFact[];
  exports: ExportFact[];
  symbols: SymbolFact[];
  calls: CallFact[];
  literals: LiteralFact[];
  comments: CommentFact[];
  diagnostics: FactDiagnostic[];
};
```

Fact extraction diagnostics are data, but malformed bridge payloads are errors. Engine panics are process-fatal and treated as engine bugs.

## Runtime API

The project runtime exposes HTTP for request/response operations and server-sent events for live state. Health is public; other API routes require the runtime bearer token or runtime session cookie. Remote UI bootstrap accepts the token on the index route, then serves static assets only to authorized requests.

Base URL is stored in `.opencanon/runtime.json`:

```json
{
  "rootDir": "/repo",
  "host": "127.0.0.1",
  "pid": 12345,
  "port": 43187,
  "url": "http://127.0.0.1:43187",
  "startedAt": "<ISO-8601 timestamp>",
  "logPath": ".opencanon/runtime.log",
  "authToken": "<generated-token>"
}
```

Endpoints:

```text
GET  /api/health
GET  /api/state
GET  /api/snapshot
GET  /api/context/status
GET  /api/context/search
GET  /api/context/ask
GET  /api/context/chunks
GET  /api/context/coverage
GET  /api/context/backlinks
GET  /api/doctor
GET  /api/events
GET  /api/events/stream
GET  /api/git/history
GET  /api/git/diff
POST /api/validate
POST /api/index
GET  /api/service/projects
GET  /api/fs/tree
GET  /api/fs/file
GET  /api/findings
```

All API responses are Zod-validated on both server and client boundaries.

## SQLite State

Database path:

```text
.opencanon/state.sqlite
```

Required tables:

```text
meta
files
facts
repo_graphs
findings
canon_events
jobs
watch_state
observability_traces
observability_spans
observability_events
semantic_index_snapshots
semantic_chunks
```

Rules:

- SQLite is repo-local.
- Cache/state files are generated and gitignored.
- Rust owns schema creation and migrations.
- Migrations are embedded into the engine with `include_str!`.
- Project runtime startup applies older pending migrations before serving API requests.
- A database newer than the running project runtime is a hard failure.
- Each migration is wrapped in a Rust transaction; migration SQL files do not include `BEGIN` or `COMMIT`.
- The project runtime uses WAL mode and normal synchronous mode for routine writes.
- Facts, findings, graph snapshots, watch state, and event records do not live in JSON files.

```bash
opencanon state status
opencanon state reset --confirm
```

Initial table shape:

```text
migrations(version, name, applied_at)
meta(key, value)
files(path, content_hash, fact_hash, language, size, indexed_at, stale)
facts(path, content_hash, parser_version, payload, diagnostics, indexed_at)
repo_graphs(graph_hash, payload, indexed_at)
findings(id, payload, status, indexed_at, resolved_at)
canon_events(id, type, timestamp, payload)
watch_state(root_dir, inventory_hash, stale, reason, updated_at)
jobs(id, type, status, payload, created_at, updated_at)
observability_traces(root_dir, id, name, status, recording, sampled, started_at, ended_at, payload)
observability_spans(root_dir, id, trace_id, parent_span_id, name, kind, status, started_at, ended_at, payload)
observability_events(root_dir, id, trace_id, span_id, name, occurred_at, payload)
semantic_index_snapshots(root_dir, id, status, identity_hash, payload, indexed_at)
semantic_chunks(root_dir, index_id, id, path, content_hash, chunk_hash, payload, indexed_at)
```

## JSON State

JSON is for human-readable configuration and small generated pointers only.

Store these as JSON:

- `opencanon.config.json`: optional repo-authored configuration overrides.
- `.opencanon/runtime.json`: generated runtime pointer with `rootDir`, `host`, `pid`, `port`, `url`, `startedAt`, `logPath`, and `authToken`.
- `~/.opencanon/service.json`: generated service registry for running project runtimes.
- Optional local UI preferences if they are not important to validation correctness.

Do not store these as JSON:

- file inventory
- content hashes
- fact payloads
- graph snapshots
- findings
- watch freshness
- migrations
- jobs
- search indexes

JSON writes use atomic writes: write a unique temp file in the same directory, flush/sync it, rename it into place, and sync the parent directory where the platform supports it.

## Incremental Computation Model

OpenCanon uses a dependency graph, not full rescans.

```text
File -> FileFacts -> RepoGraph -> ValidatorShard -> Finding
File -> SemanticChunk -> Embedding -> SemanticIndex
Convention -> MarkdownHeadingRef -> ContextIndex
Convention -> CanonEvent -> RuntimeLink -> FindingLink
```

Shard keys derive from runtime version, engine version, config hash, schema version, parser version, convention source hash, file hashes, fact hashes, convention hashes, and linked doc heading hashes. Key derivation stays inside the runtime/state layer.

Invalidation rules:

| Change | Recompute |
| --- | --- |
| source file content | facts for that file |
| import facts | import graph and import-edge validators |
| package manifest | package graph and package validators |
| convention source | that convention's runtime shards |
| convention fixture | fixture check for that convention |
| config | discovery, graph, all affected convention runtimes |
| docs | docs index and context results |
| generated convention docs | doctor drift check and context results |
| engine version | all facts and graphs |
| schema version | block until migration |

## Convention Model

Conventions remain TypeScript because humans and agents must be able to write and modify them in the same source-of-truth file.

Every convention declares identity plus three independent axes:

```ts
export type Convention = {
  id: string;
  title: string;
  topics?: string[];
  why?: string;
  rule: string;
  examples?: { good?: string; bad?: string; note?: string }[];
  related?: string[];
  impactSurfaces?: string[];
  applies: Applies;
  render: Render;
  runtime: Runtime;
};
```

Axis behavior:

| Axis | Purpose | Variants |
| --- | --- | --- |
| `applies` | where the convention is relevant | files, symbols, imports, impact surface, custom |
| `render` | how docs are produced | generated, none |
| `runtime` | how enforcement runs | none, validator, gate, test |

OpenCanon-owned Markdown is always `render(definition)`. Definition docs have no hand-edited Markdown opt-out; use `render.kind === "none"` when a definition should not produce docs. No persisted proposed/active status exists: committing the convention definition is ratification.

## Findings And Recommendations

All repo feedback is represented as records.

```ts
export type FindingKind = "violation" | "warning" | "recommendation" | "insight";

export type Finding = {
  id: string;
  kind: FindingKind;
  severity: "error" | "warning" | "info";
  validatorId?: string;
  title: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  docs?: string[];
  conventionIds?: string[];
  introducedBy?: string;
  resolvedBy?: string;
  fix?: {
    type: "safe" | "unsafe" | "manual";
    command?: string;
    description: string;
  };
};
```

Policy:

- `error` findings fail validation.
- `warning` findings fail only with `--strict-warnings`.
- `recommendation` is advisory until promoted to a validator.
- `insight` is non-blocking repo intelligence.
- Safe fixes are explicit.
- Unsafe/manual fixes are never auto-applied.

## Docs And Conventions

Docs and conventions are first-class state.

```text
Convention = what we chose, why, where it applies, and how it is enforced
Markdown docs = generated human-facing rendering
Runtime = executable validator/gate/test behavior
Finding = current repo state
```

Generated convention docs are deterministic:

```ts
renderConvention(convention, convention.render.style) === readFile(convention.render.docs)
```

Resolved doc snippet:

```ts
export type DocSnippet = {
  source: string;
  path: string;
  slug: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  body: string;
  conventionIds: string[];
  contentHash: string;
};
```

Convention and docs context is surfaced through `context`, `rules`, validation output, history helpers, and runtime/UI snapshot APIs.

## CLI Surface

Service and project lifecycle:

```bash
opencanon status
opencanon status --format json
opencanon service start
opencanon service stop
opencanon service status
opencanon service status --format json
opencanon project start
opencanon project stop
opencanon project status
opencanon project status --format json
opencanon project list
opencanon project index
opencanon project logs --tail 200
opencanon project open
opencanon project start --foreground
```

`project start` opens the supervised local API and reuses cached Project Context
state. It does not perform a hidden full Search/Ask/Project Map rebuild on the
startup path. `project index` is the explicit command for rebuilding derived
project knowledge.

Validation:

```bash
opencanon validate --changed
opencanon validate --files <paths...>
opencanon validate --project
opencanon validate --changed --strict-warnings
opencanon validate --check-fixtures
```

Knowledge:

```bash
opencanon context --changed
opencanon context --files <paths...>
opencanon context --topic <topic>
opencanon context --list-topics
opencanon context --list-exceptions
opencanon context --check
```

Rules:

```bash
opencanon rules
opencanon rules --tree
opencanon rules --validator <id>
opencanon rules --convention <id>
opencanon rules --topic <topic>
```

Project Canon:

```bash
opencanon canon list
opencanon canon render conventions --dry-run
opencanon canon history convention <id>
opencanon canon related-commits convention <id>
opencanon canon map
```

Feedback, hooks, and baselines:

```bash
opencanon feedback --changed
opencanon hook <codex|claude|opencode>
opencanon hook install --all --dry-run
opencanon baseline check
opencanon baseline update
```

Doctor:

```bash
opencanon doctor
opencanon doctor --format json
opencanon doctor --run-external-tools
```

## Browser Diagnostics

The service and each project runtime can expose a local browser diagnostics harness for inspection and agent debugging. Browser diagnostics are not the product source of truth: they call the same authenticated service/runtime APIs as the CLI, and all durable behavior remains in Project Canon definitions, runtime state, checks, and Doctor.

Runtime diagnostics rules:

- the CLI and MCP remain the primary programmable interfaces
- browser diagnostics are served by the service or project runtime
- runtime events flow through service/runtime SSE
- no installed skill path imports browser source from workspace packages

Dashboard:

- selected project summary
- indexing, service, and project runtime status
- Project Canon coverage
- recent activity and health signals

Activity:

- canonical events
- indexing progress
- check results
- agent-facing progress signals

Review:

- changed files
- introduced/resolved findings
- affected convention runtimes
- affected areas, surfaces, specs, and changes
- unresolved gates and recovery context

Changes:

- readonly implementation board
- change plans, tasks, checks, events, and backlinks
- drilldown into linked canon definitions and files

Canon:

- conventions, areas, specs, changes, and impact surfaces
- generated docs links
- governing checks and backlinks

Project Map:

- graph of Project Canon, proof, knowledge, files, and surfaces
- overview, neighborhood, and detail exploration

Search:

- chunks, symbols, docs, and related-code retrieval
- evidence snippets with backlinks

Files:

- project file tree
- file icons, open/reveal actions, and linked definitions

Health:

- doctor results
- runtime/service state
- project setup, generated docs, and index freshness

Settings:

- app-level preferences
- project registration and recent project state
- runtime and indexing controls

## Indexing

OpenCanon keeps indexing inside the project-runtime state layer.

Primitives:

- content hashing
- file inventory diffing
- directory and graph hashes for invalidation
- import graph construction
- persisted per-file facts
- Git-visible inventory and ignore handling

## Runtime-Backed Execution Rule

Do not keep duplicate execution paths.

Direct CLI validation uses the runtime-backed path. Do not keep parallel validation paths.
