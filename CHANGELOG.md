# Changelog

## v0.4.4 - 2026-07-07

- Added scoped graph search and symbol-kind filtering for repository queries.
- Added graph-backed migration and unused-export validation improvements.
- Added refactor planning APIs and refreshed release/runtime documentation.

## v0.4.3 - 2026-07-02

- Added scoped graph search and symbol-kind filtering for repository queries.
- Added graph-backed migration and unused-export validation improvements.
- Added refactor planning APIs and refreshed release/runtime documentation.

## v0.4.2 - 2026-07-02

- Added scoped graph search and symbol-kind filtering for repository queries.
- Added graph-backed migration and unused-export validation improvements.
- Added refactor planning APIs and refreshed release/runtime documentation.

## v0.4.1 - 2026-07-02

- Added scoped graph search and symbol-kind filtering for repository queries.
- Added graph-backed migration and unused-export validation improvements.
- Added refactor planning APIs and refreshed release/runtime documentation.

## v0.4.0 - 2026-06-02

Type-aware validation (TypeScript-first). Validators can now ask the type checker
about a comparison site, not just match text — e.g. flag a string literal compared
against an enum/union-typed value when it should reference the declared constant.

- `ctx.typed.literal()` with capability accessors (`asFiniteLiteralSet`,
  `finiteLiteralIncludes`) as the rule-facing contract; the resolution shape is
  hidden so rules never branch on it. `LiteralFact.declarationSourceId` is a
  syntactic fact (always available, no producer).
- Binary producer model — no degraded/heuristic results. A typed fact comes from a
  `ready` per-language producer or not at all. `ProducerStatus`
  (`ready`/`missing-tsconfig`/`missing-package`/`crashed`/`stale`/`disabled`/
  `not-implemented`) is first-class: `ctx.typed.producerStatus()`, `opencanon
  doctor`, `opencanon runtime status`.
- Live TypeScript producer: a persistent incremental `ts.createWatchProgram` child,
  lazy-spawned on the first typed query, kept off the runtime-readiness path, idle-
  timed, warm-incremental. The batch sidecar (`opencanon analyze --typed`) is the
  headless/CI producer. `OPENCANON_TYPED_PRODUCER=off` disables the live producer.
- Validators declare `requiresProducers: ["typescript"]`; when a required producer
  isn't `ready` the validator skips. Skips/errors are reported on a separate
  `ValidationResult.validatorOutcomes` channel (`ran`/`skipped`/`error` + reason +
  producer), never as file-anchored findings — so the findings count stays purely
  code, and a broken/stale/disabled producer can never silently yield "no findings".
  Consuming typed facts for an undeclared non-ready producer also surfaces an
  outcome.
- One authoritative producer status: a single resolver feeds every surface (skip
  logic, `/api/producers`, `--require-producer`, `doctor`, `runtime status`), with a
  tightened precedence where a ready/warming live producer always beats any sidecar
  state. A `warming` status covers the live producer's initial build; the runtime
  re-runs typed validators once it becomes ready. Each `ValidationResult` records
  the producer `generation` its facts came from, so a status can never claim newer
  facts than were used.
- CLI gates: `opencanon validate --require-producer <langs>` (CI fails if a named
  producer isn't ready) and `--strict-producers` (escalate skips to errors).

Scope/notes:
- TypeScript-only today; Python/Rust producers plug into the same seam later, and
  files of an unsupported language return nothing (no spurious findings).
- The UI file tree gained a "files with findings only" filter.
- Project references consume referenced `.d.ts` as-built — run `tsc --build` before
  `analyze --typed` for fresh declarations.

### Polyglot AST facts foundation

Syntactic facts (imports/exports/symbols/declarations/calls/literals/comments and
the derived references/annotations/duplicates) now come from real parsers for every
source language, behind one seam — no regex fact extraction remains.

- **Generic provider seam.** All languages flow through one
  `ProjectAstFactsProvider.factsFor(path, text)`; core owns the language-neutral
  `FileFacts` → per-language accessor mapping and stays engine-free, while the
  runtime/CLI install the engine-backed implementation.
- **LanguageCapabilityRegistry** — the single language authority. One descriptor per
  language declares its full capability profile (facts extractor + coverage, semantic
  provider, graph mode, resolution, refactor ops, naming idioms), and every
  consumer queries it instead of branching on language. "Which parser does language X
  use" and "is it a real parser" are queryable facts. Descriptors are honest:
  `derived` marks fact kinds core computes rather than the extractor emitting them.
- **TypeScript/JavaScript & Svelte → oxc.** ALL fact extraction lives in the engine
  (no parsing in core). Svelte has its own engine `SvelteExtractor`: a dependency-free
  Svelte/HTML lexer locates top-level `<script>` blocks (module + instance incl.
  Svelte 5 bare `module`, `lang`-aware, exact line+UTF-16-column offsets), correctly
  ignoring `<script>` text inside comments, attribute values, `{…}` expressions, and
  block tags; each body is parsed with oxc and merged into one `FileFacts`. No Svelte
  compiler dependency.
- **Python → rustpython.** AST imports/symbols/calls with real `tryDepth`/
  `argumentCalls` (parity with the TS extractor), surfaced through `file.py.*` and in
  the canonical import graph. Python also participates in the **engine code graph**:
  symbol nodes for def/class plus import resolution (relative `from .`/`..` and
  absolute dotted modules, `__init__.py`-aware), so cross-file symbol search and
  graph-backed `renameSymbol` work for Python.
- **Columns are UTF-16 code units** across all extractors (oxc + rustpython), matching
  JS string indexing — non-ASCII no longer shifts columns.
- **renameSymbol** is a declared, working refactor capability for TS/Svelte/Python
  (text path language-agnostic, graph path backs all three).
- **Regex TS parsers deleted** — AST is the only path; access throws if no provider
  is installed (no silent regex fallback). A file the extractor cannot parse now
  surfaces an error-severity parse diagnostic instead of validating as silently
  clean.
- The validator fact cache is version-locked to the engine extractor
  (`cache.ts` ↔ engine `EXTRACTOR_VERSION`), enforced by `release:check`.

## v0.3.14 - 2026-05-26

- Added scoped graph search and symbol-kind filtering for repository queries.
- Added graph-backed migration and unused-export validation improvements.
- Added refactor planning APIs and refreshed release/runtime documentation.

## v0.3.13 - 2026-05-25

- Fixed GitHub Actions file descriptor exhaustion by running UI smoke before the parallel Vitest pool.
- Keeps the v0.3.11 validator authoring APIs while making the full CI sequence pass on the Linux runner.

## v0.3.12 - 2026-05-25

- Fixed CI file descriptor pressure by avoiding ephemeral runtime startup for rule metadata and non-graph context queries.
- Keeps the v0.3.11 validator authoring APIs while making `check:ci` pass in GitHub Actions.

## v0.3.11 - 2026-05-25

- Added virtual fixture files for validator tests, including typed helpers for TypeScript, Python, JSON, and raw file content.
- Added generated project authoring constants for package roots, imports, npm dependencies, Rust crates, Cargo packages, and Python packages.
- Added explicit commit approval gates with diff/file scopes and deterministic approval fingerprints.

## v0.3.10 - 2026-05-21

- Fixed the UI smoke indexing check to use explicit runtime reindexing instead of CI-sensitive file watcher timing.

## v0.3.9 - 2026-05-21

- Fixed the UI smoke watcher check to mutate a tracked project file instead of relying on untracked file discovery.

## v0.3.8 - 2026-05-21

- Fixed runtime validator graph reloads for imported validator modules.
- Added explicit cross-scope project file access for validators.
- Added wrapper-aware Tauri command parity and a Tauri desktop example bundle.
- Improved doctor output for decision backrefs and fixture coverage.

## v0.3.7 - 2026-05-21

- Fixed default project scope so skill implementation files are ignored while validator fixtures remain checkable.

## v0.3.6 - 2026-05-21

- Fixed DRY bundle fixture coverage so installed bundles pass fixture validation.

## v0.3.5 - 2026-05-21

- Fixed example bundle source globs so generated validators install with valid glob patterns.

## v0.3.4 - 2026-05-21

- Fixed example bundles so installed validators reference their bundled decisions.

## v0.3.3 - 2026-05-21

- Fixed bundle validator index wiring for modules that export arrays of validators.

## v0.3.2 - 2026-05-21

- Fixed setup manifest propagation when `OPENCANON_UPDATE_MANIFEST` is used.
- Updated generated skill barrels to export the full curated validator factory surface.

## v0.3.1 - 2026-05-21

- Fixed bundle installs so generated validator modules are wired into the validators index and run immediately.
- Made example bundles portable outside the source checkout.
- Added JSON output support for `symbols` and `graph` commands to match documented CLI usage.

## v0.3.0 - 2026-05-21

- Added bundle-driven migration and graph-backed DRY examples with before/after project fixtures.
- Added validator and bundle API improvements for migration references, similar function checks, unused exports, and hardcoded value policies.
- Added skill-local runtime ignore handling and replaced the old agent brief init flow with `init --non-interactive`.
- Improved documentation site examples, mobile docs navigation, tree rendering, and diff displays.

## v0.2.2 - 2026-05-20

- Ignored generated runtime and runtime state during setup/init so consumer repos commit only source scaffold files.

## v0.2.1 - 2026-05-20

- Fixed release metadata so the engine binary reports the release version.

## v0.2.0 - 2026-05-20

- Added scoped graph search and symbol-kind filtering for repository queries.
- Added graph-backed migration and unused-export validation improvements.
- Added refactor planning APIs and refreshed release/runtime documentation.

## v0.1.0 - 2026-05-19

- Initial OpenCanon release.
