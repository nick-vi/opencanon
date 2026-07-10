# Language Support Foundation — Design

Status: **implemented (foundation).** The strong, ages-well architecture for ALL
language-dependent behavior in OpenCanon — not just facts — built on the premise
that agent-cheap code means the cost to minimize is FUTURE REFACTORING, so the
complete extension-point framework lands now. The single language authority is
`LanguageCapabilityRegistry` (`packages/core/src/language-registry.ts`). Supersedes
the scope of `docs/polyglot-facts-plan.md` (which remains the facts-capability
implementation plan for Svelte/Python).

## Premise & scope
Today, everything that depends on language branches ad-hoc across the codebase
(fact extraction, type resolution, code graph, import resolution, refactors,
naming idioms, discovery). Adding a language — or a new kind of language-dependent
behavior — touches many scattered sites. The foundation makes language support a
**single first-class concept**: one `LanguageCapabilityRegistry` of descriptors,
where every language-dependent capability is a declared extension point. Adding a
language = one descriptor + filling its slots. Adding a new capability = one slot +
its consumers, defined once. **No tear-up, ever.**

Grounded in the languages we KNOW we'll model (not hypotheticals): TypeScript
(has every capability), Svelte (embedded TS), Python (native, no semantic yet,
snake_case), Rust (gated `syn`). Every slot below is justified by one of these.

## The one boundary that keeps this from sprawling
**The registry describes what a language CAN EXPRESS; convention runtimes
describe what THIS repo ALLOWS.** Capability (TS has finite-literal types; Python
uses snake_case functions) lives in the registry. Policy (no DB import in services;
banned folders; layering rules) stays in conventions. Never mix them.

## The unified `LanguageDescriptor`
```ts
interface LanguageDescriptor {
  id: LanguageId;
  extensions: string[];
  role: "source" | "embedded-source" | "doc" | "config";
  embeddedSublanguages?: EmbeddedUnit[];          // svelte: script / style / template

  // capability #1 — syntactic facts (engine parser -> language-neutral FileFacts)
  facts: {
    extractor: ExtractorId;                        // oxc | rustpython | syn | svelte-embedded
    coverage: Partial<Record<FactKind, Coverage>>; // which kinds, at what fidelity
    commentSyntax: CommentSyntax;                   // line/block/doc markers
    extractorVersion: string;                      // per-language cache key
  };

  semantic?: { providerId: string; capabilities: SemanticCapability[] } | "none";
  graph: { mode: "derived" | "provider" | "none" };
  resolution?: { strategyId: string } | { mode: "none" };
  refactor: { level: "semantic" | "ast" | "text" | "none"; operations: RefactorOperation[] };
  naming: { identifiers: Partial<Record<IdentifierRole, NamingStyle[]>> };
}
```

## Capabilities — home, consumer, "no support" behavior
| Capability | Core-derived or provider | Consumer | No-support behavior |
|---|---|---|---|
| **Syntactic facts** (`factsFor → FileFacts`) | **provider** (engine parser) | `ctx.facts.*`, `file.*` | provider required; access throws (no silent regex) |
| **Comment syntax** | core-derived (once syntax declared) | comment facts, no-bypass-comment rules | `comments` coverage = none |
| **Semantic facts** (types/resolution) | **provider** (`SemanticFactsProvider`) | `ctx.semantic.*` / `ctx.typed.*` adapter | rule needing semantics → `skipped` via producer-status |
| **Code graph** | **core-derived** (`mode: derived` from facts symbols/refs/calls/imports); `provider` only if edges can't be FileFacts | `searchSymbols/References`, `indexCodeGraph`, `ctx.graph.*` | empty language-scoped results; graph rules skipped |
| **Module resolution** | **provider** (`ResolutionStrategy`) | `buildImportGraph`, import-edge + boundary rules | imports exist as raw facts; `resolvedTarget`/ownership unavailable |
| **Refactor / edits** | **provider** (`RefactorProvider`, level ast/text/semantic) | fix application, `--fix`, codemods | fixes downgrade to `manual`/`suggested`, no auto-edit |
| **Naming idioms** | **core-derived** (lookup) | naming validators | use project override, or rule doesn't run for that language |
| **File classification** | **core-derived** (`extensions`+`role`) | discovery, validator scoping | n/a |

Per-language examples: TS = all capabilities. Svelte = `role: embedded-source`,
facts via `svelte-embedded` (oxc on the `<script>` body), `semantic: none` (until
needed). Python = native `rustpython`, `semantic: none`, `resolution: python`,
`refactor.level: text`, snake_case idioms. Rust = descriptor present, slots
**gated** until a real `.rs` validator ships.

## The two seams (keep separate — never merge)
**Syntactic** (the migration's seam, generalized):
```ts
interface ProjectSyntacticFactsProvider {
  registry(): LanguageCapabilityRegistry;
  factsFor(req: { path; content?; language?; virtualPath?; requestedFacts? }): FileFacts;
}
```
`FileFacts` gains `coverage`, `embedded: FileFacts[]` (host languages like Svelte),
`sourceRange`/`locationBase` (offset mapping), and a TYPED `extensions: Record<string,
{version, data}>` bag for language-specific facts (`python.decorators`,
`svelte.reactive`, `typescript.jsx`) — never top-level language fields. Cache keys
include language + contentHash + requested kinds + extractor/parser/extension
versions (+ embedded child versions). Replace the single `parserVersion` lockstep
with per-language registry-version lockstep.

**Semantic** (generalizes the type-producer):
```ts
interface SemanticFactsProvider {
  language: LanguageId; capabilities: SemanticCapability[];
  status(): ProducerStatus; factGeneration(): number | undefined;
  resolve(batch: SemanticQueryBatch): Promise<SemanticResultBatch>;
}
```
The existing tsc type-producer becomes the first one; `ctx.typed.*` stays a TS
adapter over `ctx.semantic.*`.

Core surface: one canonical `ctx.facts.imports({ languages?, includeEmbedded? })`
+ ergonomic per-language adapters **generated from descriptors** (`file.as("python")
.decorators()`), not hand-written provider methods.

## Convention runtime contract — declare needs, framework auto-gates
```ts
defineConvention({
  id: "python-no-bare-except",
  title: "Python code avoids bare except",
  rule: "Python exception handling names the expected exception type.",
  topics: ["python"],
  applies: { kind: "files", globs: ["src/**/*.py"] },
  render: { kind: "none" },
  runtime: {
    kind: "validator",
    severity: "error",
    scope: "file",
    facts: ["diagnostics"],
    validate({ ctx }) { /* ... */ },
  },
});
```
Core intersects `applies` with discovered languages, checks each required
capability against the descriptor + provider readiness, and records
`validatorOutcomes` (`ran` / `skipped` with reason / `error`). Unsupported coverage
→ skip; unknown language/capability → definition error; semantic-not-ready → reuse
producer-status and validator-outcome machinery.

## Core-derived vs provider-required (the split that keeps it lean)
- **Core-derived (free once facts/syntax exist):** file classification, naming
  lookup, graph indexing from facts, raw comment extraction.
- **Provider-required (real per-language impl):** syntactic extraction, semantic
  facts, module resolution, structured refactors, (semantic graph if ever needed).

## Build sequence (framework first, dogfood TS, then languages)
1. Registry schema + descriptor discovery (extensions/role) + generic `factsFor`;
   wrap existing TS methods.
2. Move `OxcExtractor` behind the engine extractor trait; publish TS/JS descriptors;
   move comment syntax into descriptors.
3. Dogfood TS/JS/TSX/JSX fully through `factsFor` — behavior stays green.
4. Adapt the TS type-producer into the `SemanticFactsProvider` registry.
5. Move the graph builder behind `graph.mode`; TS import resolution behind
   `ResolutionStrategy`; naming validators onto descriptor idioms; add the
   `RefactorProvider` contract (TS rename = semantic) + downgrade unsupported fixes.
6. **Svelte** — embedded extractor (oxc on `<script>` body via `factsFor`),
   `role: embedded-source`; delete script-body regex.
7. **Python** — native `rustpython` extractor → FileFacts; resolution + snake_case
   idioms; migrate the 2 validators; delete Python regex.
8. **Rust** — fill the gated descriptor (`syn`) only when a real `.rs` validator ships.

## Guardrails (strong, not baroque)
- One generic seam — NO per-language provider methods; NO core import of `@opencanon/
  engine`; NO raw parser AST exposed across the boundary.
- Semantic data NEVER inside `FileFacts`; language-specific facts only in the typed
  `extensions` bag, never top-level.
- NO manual `if language === …` gating in validators — declare `requires`.
- NO silent regex fallback; "partial" coverage is never advertised as "full".
- **Policy stays out of the registry** — banned folders, layer/boundary/dependency
  rules, "services must not import DB" live in conventions, not descriptors.
- Build slots only along axes a KNOWN language exercises (TS/Svelte/Python/Rust) —
  if none of the four needs a field, don't add it.
