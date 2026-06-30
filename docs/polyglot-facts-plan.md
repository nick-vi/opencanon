# Polyglot AST Facts — Plan (Svelte, Python, Rust)

OpenCanon-Knowledge: exclude

Status: **Svelte + Python implemented; Rust deferred.** Extends the completed
TypeScript AST migration (`docs/ast-facts-migration.md`) to the remaining languages.

## Where we are
TypeScript/TSX/JS/JSX, Svelte, and Python facts are all engine AST via the
`ProjectAstFactsProvider` seam:
- **Svelte** — `<script>` blocks located and parsed by the engine `SvelteExtractor`
  (`crates/opencanon-engine/src/svelte_facts.rs`), merged to host coordinates.
- **Python** — engine `rustpython` facts + code graph (`graph.mode: "derived"`,
  `resolution.strategyId: "python"`). Ships `python-no-bare-except`,
  `python-no-sys-path-mutation`.
- **Rust** — still **not a validated language** (`.rs` is not in `languageValues`); no facts today.

The foundation (seam, language-neutral `FileFacts`, content-based extract, install
points, lockstep cache version, proven engine→contract→provider→live-verify workflow)
is reused throughout. Core cannot import `@opencanon/engine` (layering) — everything
routes through the seam.

## Cross-cutting decision (do this first)
**Generalize the seam to `factsFor({ path, content, language, virtualPath? }): FileFacts`**,
and reimplement the TS-shaped methods (`importsFor`/`exportsFor`/…) as thin wrappers
over it. Rationale (codex): ages far better than per-language method sprawl
(`pyImportsFor`/`rsSymbolsFor`/…); core maps the normalized `FileFacts` into each
language's accessors; keeps layering clean (core depends only on the interface).

---

## Phase 0 — generic `factsFor` seam  ·  ~2–3 days  ·  no engine work
- Add `factsFor` to `ProjectAstFactsProvider`; runtime/CLI/vitest engine providers
  implement it (they already batch all kinds in one `extractFacts`).
- TS methods become wrappers. Provider-required contract stays per language
  (TS/Svelte require it now; Python only once Phase 2 lands).
- Keep `cache.ts` `parserVersion` lockstep with engine `EXTRACTOR_VERSION` (already
  enforced in `release:check`); bump on any `FileFacts` schema/semantics change.
- Verify: `check:ci` green, `validate --project` unchanged (pure refactor).

## Phase 1 — Svelte via the existing oxc provider  ·  ~2–4 days  ·  no engine work
The `<script>` body **is** TypeScript and we already parse content. Rewire the 6
`parseSvelteTypeScript*` to: regex-locate `<script>` blocks (HTML boundary detection
only — keep that), then call `requireTypeScriptProvider().factsFor({ content: block.body,
language: ts|js, path: realSveltePath, virtualPath: synth })` and apply the line/column
offset.

Details / gotchas (codex):
- **Cache key** = `realPath + blockIndex + contentHash` (NOT the synthetic path — avoids
  `Component.svelte.ts` collisions + stale reuse when only a block body changes).
- Fact `file` stays the real `.svelte` path; offset **all 7 kinds**; column offset only
  applies to line 1 of the block; merge multiple blocks in document order.
- Preserve `<script lang="ts">` vs JS and `context="module"` as optional fact metadata
  (or keep internally for Svelte validators until normalized fields exist).
- Delete the `parseScript*` regex body-parsers after fixture + `validate --project` parity.
- **Layering-clean** as long as core only calls the seam. Risks: cache-key bugs,
  location drift, validators relying on old regex quirks.

## Phase 2 — Python: engine parser + extractor  ·  ~2–3 weeks  ·  real new-language work
- **Parser: `rustpython-parser`** (codex) — standalone, crates.io-friendly, typed AST,
  far easier to ship than vendoring Ruff internals. Not tree-sitter (CST pushes semantic
  work onto us); Ruff's fidelity isn't worth the dependency/stability cost yet.
- Teach `source_type_for_file` to accept `.py`; implement `PythonExtractor → FileFacts`,
  incrementally with per-kind parity against the regex `file.py.*`:
  1. **imports** (`import x`, `import x as y`, `from x import y`, relative).
  2. **symbols** (functions, async, classes, methods, decorators).
  3. **calls** (`foo()`, `obj.foo()`, `module.func()`) — replaces `parseCallFactsFromText`.
  4. literals/comments only if a Python validator needs them (defer otherwise).
- Core adds **Python adapters** that map normalized `FileFacts` → `file.py.imports/
  functions/classes/calls` (adapters in core, NOT new provider methods — the seam stays
  generic via `factsFor`).
- **Protect `python-no-bare-except` + `python-no-sys-path-mutation`** with parity before
  deleting any Python regex. Live-verify each increment (`check:ci` + `validate --project`;
  the codex sandbox masks via fallback — verify in the real env, as in the TS migration).

## Phase 3 — Rust: gated, do not build yet
`.rs` is not a fact target today. Parser would be **`syn`**. Build only when there is a
real shipped `.rs` validator (imports/items/calls) or a cross-crate graph need. Until the
threshold is crossed, no work.

---

## Priority order
1. **Phase 0** — `factsFor` generic seam (enables clean Svelte + Python).
2. **Phase 1** — Svelte (quick, high-consistency win, removes the last script-body regex).
3. **Phase 2** — Python (the real sub-project; incremental, regex deleted per kind).
4. **Phase 3** — Rust gate (demand-driven).

## Effort / risk summary
| Phase | Effort | Engine work | Risk |
|---|---|---|---|
| 0 `factsFor` | ~2–3 days | none | low (pure refactor) |
| 1 Svelte | ~2–4 days | none | low–med (offsets, cache key) |
| 2 Python | ~2–3 weeks | new parser + extractor | med (new language, validator parity) |
| 3 Rust | — | — | gated; not started |

No architectural blockers — the seam + `FileFacts` contract + content extract were built
to extend. Each phase follows the proven workflow: engine visitor (Phase 2 only) →
contract → provider → live-verify → per-kind parity → delete regex.
