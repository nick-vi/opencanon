# OpenCanon Architecture

Scope: OpenCanon framework standalone

## Product Definition

OpenCanon stores and enforces repository conventions for agent-assisted code changes.

It provides:

- loading scoped convention context
- reading current decisions and docs
- enforcing rules with validators
- recording findings
- exposing daemon-backed CLI, hook, and UI surfaces

It is not a task tracker, chat memory system, or code search product.

Model:

```text
docs -> decisions -> validators -> findings
daemon -> CLI/hooks/UI
```

## Runtime Architecture

OpenCanon has one execution path and no silent fallbacks.

```text
Rust watcher -> daemon -> Rust engine/state -> fact graph/cache -> TypeScript validators -> findings -> CLI/UI/hooks
```

Required choices:

- Runtime: Bun.
- Package installs: exact dependency versions plus committed `bun.lock`.
- Engine bridge: napi-rs.
- Watch backend: Rust `notify` plus debouncing inside the engine.
- State storage: repo-local SQLite owned by Rust with embedded migrations.
- Daemon: TypeScript on Bun, using the engine for hot-path work and durable state operations.
- Rust engine: watcher, file inventory, hashing, diffing, migrations, glob matching, fact extraction, graph updates, affected calculation.
- Validator authoring: TypeScript.
- UI: React plus Vite, served by the daemon.
- Hooks: adapters call daemon APIs after daemon unification.

If a required component is missing or stale, OpenCanon fails with a diagnostic.

## Version Policy

OpenCanon pins exact runtime package versions instead of ranges. `bun add --exact` is the default rule for npm dependencies, and `Cargo.lock` is committed for Rust crates.

Refresh procedure:

```bash
npm view <package> version
curl -s https://crates.io/api/v1/crates/<crate> | jq -r '.crate.max_stable_version'
curl -s https://api.github.com/repos/oven-sh/bun/releases/latest | jq -r '.tag_name'
curl -s https://api.github.com/repos/rust-lang/rust/releases/latest | jq -r '.tag_name'
```

Updating a pin requires updating package manifests, lockfiles, and the doctor version check in the same change.

### Runtime Release Manifest

Engine runtime distribution is manifest-driven. The CLI detects the current target from `process.platform` and `process.arch`; agents do not choose bundle URLs manually.

Manifest contract:

- `version: 1`
- skill version
- required Bun version
- one atomic bundle per supported target (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64`), each with a `url` and SHA-256

Every bundle is a single `tar.gz` whose contents drop directly into `.agents/skills/opencanon/runtime/`: `cli.js`, `validators.js`, and `engine/<target>/opencanon.<target>.node`. Engine binary and JS runtime ship together to make schema drift impossible.

`opencanon update check --manifest <path-or-url>` reads the manifest, selects the current target, validates the pinned Bun version, and reports `current`, `missing`, or `update-available` against the `.bundle.json` marker. `opencanon update apply --manifest <path-or-url>` refuses to write while the project daemon is running, downloads the target bundle over HTTPS, `file:`, or a local path, verifies SHA-256, extracts to a staging directory, and swaps it into place atomically (renaming the previous `runtime/` aside before removing it).

### Toolchain

| Component | Pin | Use |
| --- | ---: | --- |
| Bun | `1.3.13` | Runtime, package manager, CLI execution, daemon HTTP/SSE |
| Rust | `1.95.0` | Engine toolchain via `rust-toolchain.toml` |

### NPM Packages

| Package | Pin | Use |
| --- | ---: | --- |
| `@napi-rs/cli` | `3.6.2` | Engine build command |
| `@types/bun` | `1.3.14` | Bun type support |
| `@types/node` | `25.7.0` | Node-compatible type support |
| `cac` | `7.0.0` | CLI command parsing |
| `zod` | `4.4.3` | Runtime schemas for config, daemon API, persisted records |
| `vite` | `8.0.12` | UI build/dev server |
| `@vitejs/plugin-react` | `6.0.1` | React plugin |
| `react` | `19.2.6` | UI |
| `react-dom` | `19.2.6` | UI |
| `@types/react` | `19.2.14` | UI types |
| `@types/react-dom` | `19.2.3` | UI types |
| `@tanstack/react-query` | `5.100.10` | UI data fetching |
| `@tanstack/react-router` | `1.169.2` | UI routing |
| `lucide-react` | `1.14.0` | UI icons |
| `vitest` | `4.1.6` | Tests |
| `playwright` | `1.60.0` | UI verification |

The Svelte documentation site is tracked separately from daemon/runtime checks. Site dependency changes should stay separate from runtime release changes.

Do not add `better-sqlite3`, external filesystem watcher clients, or `ws`. Rust owns durable state and file watching; Bun already provides the selected HTTP and WebSocket APIs for this architecture.

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
Initial JS/TS facts use Oxc. If a validator requests facts for a language without an adapter, validation fails with `unsupported-language-facts`.

## Package Layout

```text
packages/core
  TS public types, validator API, schemas, finding types, docs/decision types

packages/validators
  curated validator factories

packages/cli
  opencanon command parser, daemon lifecycle commands, bootstrap checks, and daemon-backed command clients

packages/engine
  napi-rs loader and typed TS wrapper around Rust engine

packages/daemon
  Bun daemon, global supervisor registry, Rust engine orchestration, job runner, HTTP/WebSocket API

packages/ui
  React/Vite dashboard

crates/opencanon-engine
  watcher, SQLite migrations/state, file inventory, hashing, glob matching, fact extraction, graph construction, affected calculation
```

Daemon unification removes duplicate runtime-validation paths from the CLI. One-shot commands and CI start an isolated ephemeral daemon and use the same API path as a supervised daemon.

## Runtime Modes

### Local Development

```bash
opencanon dev
```

Starts:

- supervised per-project daemon
- Rust watcher
- repo-local SQLite database
- UI server
- server-sent event state stream

The global supervisor is a registry and lifecycle controller, not a shared daemon. It stores project daemon metadata in `~/.opencanon/daemons.json`; each project daemon still owns exactly one repo root, one `.opencanon` state directory, one auth token, and one watcher root.

### CLI Use

```bash
opencanon validate --changed
opencanon context --files src/api/routes/company.ts
opencanon feedback --changed
```

These commands first reuse a healthy supervised daemon for the project. If none is running, they start an in-process ephemeral daemon with an isolated scratch SQLite path, execute the request through HTTP, then stop it. This is still daemon-backed execution; it is not a direct validation fallback.

### CI And One-Shot Commands

CI is not a fallback. It is an explicit one-shot daemon mode:

1. start ephemeral daemon
2. initialize Rust watcher
3. open an isolated scratch SQLite state path
4. build or refresh state
5. run validation through the daemon HTTP API
6. stop daemon and remove scratch state

## Fail-Fast Policy

| Condition | Result |
| --- | --- |
| Bun version does not match configured pin | hard fail |
| Rust watcher cannot start | hard fail or mark state stale in explicit no-watch mode |
| Engine binary missing | hard fail |
| Engine binary version differs from package version | hard fail |
| SQLite state schema is newer than daemon schema | hard fail |
| SQLite state schema is older than daemon schema | run embedded migrations at daemon startup |
| Validator definition is invalid | hard fail at daemon load |
| Validator requests unsupported facts | hard fail for that validation run |
| Docs/decision schema invalid | hard fail for context/rules/docs commands |
| Hook called without a supervised daemon | start isolated ephemeral daemon; hard fail only if daemon prerequisites fail |

Predictability is more important than continuing in a weaker mode.

## Rust Watcher Contract

The engine is the only filesystem event source. OpenCanon does not require a user-installed filesystem daemon.

Daemon startup must:

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

- initial daemon start performs a full inventory scan
- save noise is debounced before snapshot rebuild work starts
- deletes and renames are reconciled by comparing current inventory against persisted `files`
- watcher errors, event overflow, or unreadable paths mark state stale
- stale state schedules a full scan before the daemon reports ready
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

The daemon does not expose raw SQLite tables through NAPI. NAPI methods are domain operations: open project state, scan and diff inventory, extract facts, build graph data, watch files, and persist canon events. Low-level table CRUD stays inside Rust.

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
  decisionsPath: string;
  validatorsPath: string;
  fixturesDir: string;
  impactSurfacesPath: string;
  proposedImpactNotesPath: string;
  baselinePath: string;
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

## Daemon API

The daemon exposes HTTP for request/response operations and server-sent events for live state. Health is public; other API routes require the daemon bearer token or daemon session cookie. Remote UI bootstrap accepts the token on the index route, then serves static assets only to authorized requests.

Base URL is stored in `.opencanon/daemon.json`:

```json
{
  "rootDir": "/repo",
  "host": "127.0.0.1",
  "pid": 12345,
  "port": 43187,
  "url": "http://127.0.0.1:43187",
  "startedAt": "<ISO-8601 timestamp>",
  "logPath": ".opencanon/daemon.log",
  "authToken": "<generated-token>"
}
```

Endpoints:

```text
GET  /api/health
GET  /api/state
GET  /api/snapshot
GET  /api/events
GET  /api/events/stream
GET  /api/git/history
GET  /api/git/diff
POST /api/index
GET  /api/supervisor/projects
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
migrations
meta
files
facts
repo_graphs
validators
validator_shards
findings
recommendations
docs
doc_snippets
decisions
decision_events
canon_events
jobs
watch_state
```

Rules:

- SQLite is repo-local.
- Cache/state files are generated and gitignored.
- Rust owns schema creation and migrations.
- Migrations are embedded into the engine with `include_str!`.
- Daemon startup applies older pending migrations before serving API requests.
- A database newer than the running daemon is a hard failure.
- Each migration is wrapped in a Rust transaction; migration SQL files do not include `BEGIN` or `COMMIT`.
- The daemon uses WAL mode and normal synchronous mode for routine writes.
- Facts, findings, graph snapshots, watch state, and event records do not live in JSON files.

```bash
opencanon db status
opencanon db reset --confirm
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
```

## JSON State

JSON is for human-readable configuration and small generated pointers only.

Store these as JSON:

- `opencanon.config.json`: optional repo-authored configuration overrides.
- `.opencanon/daemon.json`: generated daemon pointer with `rootDir`, `host`, `pid`, `port`, `url`, `startedAt`, `logPath`, and `authToken`.
- `~/.opencanon/daemons.json`: generated supervisor registry for running project daemons.
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
Decision -> MarkdownHeadingRef -> DocSnippet -> ContextIndex
Decision -> DecisionEvent -> ValidatorLink -> FindingLink
```

Shard keys derive from runtime version, engine version, config hash, schema version, parser version, validator source hash, file hashes, fact hashes, decision hashes, and linked doc heading hashes. Key derivation stays inside the daemon/state layer.

Invalidation rules:

| Change | Recompute |
| --- | --- |
| source file content | facts for that file |
| import facts | import graph and import-edge validators |
| package manifest | package graph and package validators |
| validator source | that validator's shards |
| validator fixture | fixture check for that validator |
| config | discovery, graph, all affected validators |
| docs | docs index and context results |
| decisions | decision index, links, affected context |
| engine version | all facts and graphs |
| schema version | block until migration |

## Validator Model

Validators remain TypeScript because agents must be able to write and modify them.

Every validator declares:

```ts
export type ValidatorDefinition = {
  id: string;
  topics: string[];
  severity: "error" | "warning";
  scope: "file" | "folder" | "import-edge" | "package" | "project";
  applies?: string[];
  facts?: FactKind[];
  decisionIds?: string[];
  docs?: string[];
  summary?: string | ((definition: ValidatorSummaryInput) => string);
  validate(input: ValidatorInput): ValidatorResult | Promise<ValidatorResult>;
};
```

Scope behavior:

| Scope | Unit | Typical rules |
| --- | --- | --- |
| `file` | one file | comments, literals, file-local patterns |
| `folder` | one folder | naming, folder shape |
| `import-edge` | one resolved import edge | boundaries, deep imports |
| `package` | one workspace package | dependency direction, package ownership |
| `project` | whole repo | duplicate literals, global structure, docs coverage |

Project validators are allowed but visible. They are not the default.

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
  decisionIds?: string[];
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

## Docs And Decisions

Docs and decisions are first-class state.

```text
Decision = what we chose and why
Markdown docs = how to apply it
Validator = executable enforcement
Finding = current repo state
```

Decision record:

```ts
export type Decision = {
  id: string;
  date: string;
  title: string;
  status: "current" | "proposed" | "replaced";
  topics: string[];
  applies: string[];
  summary: string;
  rationale: string[];
  docs: string[];
  validatorIds: string[];
  replaced?: string[];
};
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
  decisionIds: string[];
  contentHash: string;
};
```

Decision and docs context is surfaced through `context`, `rules`, validation output, and daemon/UI snapshot APIs.

## CLI Surface

Daemon lifecycle:

```bash
opencanon daemon start
opencanon daemon stop
opencanon daemon status
opencanon daemon list
opencanon daemon open
opencanon daemon serve
opencanon dev
```

Validation:

```bash
opencanon validate --changed
opencanon validate --files <paths...>
opencanon validate --project
opencanon validate --changed --strict-warnings
opencanon validate --check-fixtures
```

Context:

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
opencanon rules --topic <topic>
opencanon rules --decision <id>
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

## UI

The UI is a local dashboard over daemon state. It does not have separate state or interpretation.

The distributed skill ships the UI as built static runtime assets. Source stays in `packages/ui`; installed skills serve optimized files under `.agents/skills/opencanon/runtime/ui/`. Installed skills do not require Vite, React source files, or package installation to open the dashboard.

Runtime UI rules:

- `packages/ui` is development source only.
- the skill runtime includes built HTML, CSS, JS, fonts, and other static assets
- the daemon serves runtime UI files directly
- UI builds are produced during skill runtime build
- runtime UI files are versioned with the skill
- no installed skill path imports UI source from workspace packages
- UI API calls go through the daemon HTTP/SSE endpoints
- generated runtime assets are verified by smoke tests before release

Views:

```text
Tree View
File View
Git View
Rules View
Docs View
Decision View
Findings Inbox
Daemon Health
```

Tree View:

- repo structure
- packages/apps/modules
- finding counts per subtree
- boundary violations
- affected subtrees
- folder convention status

File View:

- imports, exports, symbols, calls, literals, comments
- validators that apply
- inline findings
- linked docs and decisions
- related files from import graph and git co-change

Git View:

- changed files
- introduced/resolved findings
- affected validators
- affected packages
- co-changed files
- commits related to touched decisions

Rules View:

- validators
- scopes
- fixtures
- linked docs/decisions
- recent finding history
- rule tree visualization

Docs View:

- heading snippets
- linked decisions
- source anchors
- linked validators/decisions
- stale or missing enforcement

Decision View:

- current decision
- rationale
- history
- linked validators
- linked docs
- affected files/packages
- findings caused by this decision

Findings Inbox:

- blocking violations
- warnings
- recommendations
- insights
- safe fixes
- manual guidance

## Indexing

OpenCanon keeps indexing inside the daemon state layer.

Primitives:

- content hashing
- file inventory diffing
- directory and graph hashes for invalidation
- import graph construction
- persisted per-file facts
- Git-visible inventory and ignore handling

## Daemon-Only Execution Rule

Do not keep duplicate execution paths.

Direct CLI validation uses the daemon-backed path. Do not keep parallel validation paths.
