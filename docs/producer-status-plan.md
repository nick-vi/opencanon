# Producer-Status Model — design + implementation plan

OpenCanon-Knowledge: exclude

Status: implemented (Phases 0–6) in the unreleased v0.4.0. Replaces the
`confidence: checked | heuristic` tier introduced with typed literal facts.
Pre-reset API shapes were deleted because only local builds used them.

## Principle

Two fact categories:

- **Syntactic facts** (`declarationSourceId`, literals, imports, symbols) — always
  available, deterministic, no producer needed.
- **Typed facts** (surrounding type at a site) — served ONLY by a per-language
  producer that is `ready`. Otherwise return **nothing**, never a guess.

Binary contract: typed rules work or they don't. No degraded results — degraded
data dressed as a result silently erodes trust, which is the worst failure for a
convention engine. A validator declares the producers it needs; unmet → skip with a
diagnostic (or error under `--strict-producers`). Producer state is first-class
(`producerStatus`), shown in `doctor`/`project status`, gated in CI by
`--require-producer`.

The confidence tier conflated two failure modes under one label:
1. Language supported but producer can't run (tsc missing, sidecar stale, producer
   crashed) — user-fixable, must fail loud.
2. Language not yet supported (no Python producer) — expected, silent zero.

Producer status separates them.

## Phase 0 — runtime stability gate (BLOCKING)

Binary model makes the live producer the only path, so the runtime must stay up on a
real large repo before anything else.

- Run live runtime + repeated `validate` on a large dogfood workspace.
- Pass: runtime stays up across >=3 calls; 2nd query warm (<2s, not 15s); no service
  death; memory stable.
- Fail: fix the crash(es) first — that becomes the real headline. Suspects beyond the
  fixed `flushed` TDZ: watch-program init cost/memory on 2200 files, monorepo tsconfig
  resolution, TS version, service restart loop.
- No Phase 1+ until the large dogfood workspace stays warm.

## Phase 1 — producer registry + status (core)

- `ProducerStatus = { kind: "ready" | "missing-tsconfig" | "missing-package" | "crashed" | "stale" | "disabled" | "not-implemented"; detail?: string; warnings?: ProducerWarning[] }`
- `ProducerWarning = { code: "membership-drift" | ...; message: string }`
- `TypeFactsProvider.status(): ProducerStatus` (each producer reports its own).
- `ProducerRegistry` (language -> provider); runtime/CLI populate, core queries.
- `ctx.typed.producerStatus(lang)`, `ctx.typed.producerStatuses()`.
- `typed.literal()` resolves a site iff the file's language producer is `ready`, else nothing.

## Phase 2 — delete the degraded path (no compat)

Remove: `confidence` (TypeResolution + facts); `requireChecked`; `kind:"other"` as a
rule-reachable resolution; `RegexTypeFactsProvider` query path + the annotation pass
(delete outright unless a producer measurably needs an internal pre-filter);
`--require-typed-index`; `OPENCANON_TYPED_PRODUCER` env (collapses into
`producerStatus: "disabled"`); `typedIndexStatus()`; `liveProducerCapable()`.

Keep: `declarationSourceId` (syntactic, always-on); `asFiniteLiteralSet` /
`finiteLiteralIncludes`; sidecar as the headless/CI producer (reports ready/stale,
not a fallback).

## Phase 3 — validator-declared producers + gates

- `defineValidator({ requiresProducers: ["typescript"], ... })`.
- Unmet required producer -> validator skips, one per-run diagnostic.
- `validate --require-producer <langs>` exits nonzero if any named producer != ready.
- `--strict-producers` escalates all skips to errors.
- `validateContext`/validator-graph track `requiresProducers`.

## Phase 4 — surfaces

- `doctor`: per-producer status block (state + last-crash reason).
- `project status`: same, live.
- membership-drift -> `producerStatus.warnings[]` (CI can fail on it).

## Phase 5 — re-dogfood + audit

- `inline-soft-enum-literal.ts`: drop `requireChecked`, add `requiresProducers:["typescript"]`,
  drop the safety comment.
- Re-run on a large dogfood workspace: findings when ready; stale sidecar -> loud skip + CI fail;
  crash -> `crashed` status not silent zero; warm-incremental works.
- Codex audit + self audit.

## Public API delta

```
REMOVE  TypeResolution.confidence, LiteralMember.confidence
REMOVE  TypedLiteralOptions.requireChecked
REMOVE  RegexTypeFactsProvider (export + class), annotation pass
REMOVE  typedIndexStatus, liveProducerCapable, --require-typed-index, OPENCANON_TYPED_PRODUCER
ADD     ProducerStatus, ProducerWarning
ADD     TypeFactsProvider.status(), ProducerRegistry
ADD     ctx.typed.producerStatus(lang), producerStatuses()
ADD     defineValidator({ requiresProducers })
ADD     validate --require-producer <langs>, --strict-producers
KEEP    declarationSourceId, asFiniteLiteralSet, finiteLiteralIncludes, sidecar (as producer), live producer
```

## Phase 6 — validator outcomes + generation model (long-term)

Fixes three dogfood defects at the root: (1) validator skip/error meta-messages
were emitted as file-anchored `Finding`s on `conventionsPath:1`, inflating the
findings count; (2) a stale sidecar could win over a ready live producer because
status was re-resolved independently in several places; (3) the boot snapshot ran
typed validators before the lazy live producer was warm, baking a "skip/stale"
into the UI that persisted even after the producer became ready.

### Findings are code-only; outcomes are the meta channel

- `Finding` means strictly "actionable issue in project code". Nothing else.
- New `ValidatorOutcome = { validatorId; status: "ran" | "skipped" | "error";
  reason?; producer?: { language; generation } }`. Outcomes are NEVER
  file-anchored. `ValidationResult.validatorOutcomes` carries them.
  - producer not ready -> `{ status: "skipped", reason, producer }`.
  - validator-runtime contract violation / invalid commit gate -> `{ status: "error", reason }`.
  - forgetful-author (consumed typed facts for an undeclared non-ready producer)
    -> `{ status: "skipped" }` (advisory) / `"error"` under `--strict-producers`.
  - validator ran normally -> `{ status: "ran" }`.
- Exit-code semantics read OUTCOMES (`validationExitCode`): any `error` outcome is
  nonzero always; a producer `skipped` outcome is nonzero only under
  `--strict-producers`; plain skips are advisory (exit 0) but always present.
- CLI renders a "Skipped/Errored Validators (not findings)" section; the findings
  count excludes outcomes.

### Single authoritative producer availability — tightened precedence

- ONE resolver, `resolveAuthoritativeProducerStatus(rootDir, language)`, returns
  the authoritative `ProducerStatus` + the provider that won. Every surface (skip
  logic via `resolveRunTypeFacts`, `/api/producers`, `--require-producer`,
  `doctor`, UI) reads this — no independent re-resolution.
- Precedence (`pickAuthoritativeStatus`): `live-ready > live-warming >
  live-crashed > sidecar-stale > missing-package > missing-tsconfig > disabled >
  not-implemented`. The sidecar is consulted ONLY when there is no live producer.
  A ready OR warming live producer beats any sidecar state (kills defect #2).

### `warming` status + generation + debounced refresh

- `ProducerStatusKind` gains `warming` (distinct from stale/crashed/disabled): a
  live producer that exists but whose `ts.Program` has not finished building. It
  WILL become ready; queries against it SKIP (not bake a stale result).
- Generation: the live producer carries a monotonic `generation`, incremented in
  `afterProgramCreate` on each watch-program rebuild. The child pushes an
  unsolicited `{event:"status", ready, building, generation}` line; the runtime
  runtime tracks it and exposes it through `ProducerStatus.generation`.
- Availability vs factSnapshot (codex #5): `ProducerStatus` answers "can it serve
  now" (kind + generation). A `ValidationResult.producerSnapshot: { [language]:
  { kind, generation } }` records the generation(s) actually used — so a surface
  can never claim "ready" about a result computed from warming/stale facts.
- Boot snapshot: a warming producer yields `skipped(warming)` outcomes — never a
  baked finding, never "stale".
- Runtime refresh on warming->ready: `TypeProducerRuntime.onReady(cb)` fires when
  the producer reaches ready (generation advance). The server debounces (~300ms)
  and a generation-guard drops a stale completion; the refresh reuses
  `scheduleWatchRebuild` -> `rebuildAndPublish`, re-running validators whose
  producer availability changed (skipped(warming) -> ran).

### Extensibility (codex #4)

Producer identity is `{ language, generation }` (workspaceRoot implicit per
runtime). Validators depend on producers by LANGUAGE (`requiresProducers`); no
producer names are hardcoded in the outcomes/result contract. A future
Python/Rust producer registers with its own language + status + generation with
zero changes to `ValidatorOutcome` / `ValidationResult.producerSnapshot`.

## Done criteria

1. Phase 0 green on a large dogfood workspace (runtime warm, no crash).
2. Zero rule-reachable path returns non-producer-checked typed data.
3. Every failure mode loud: stale/crashed/missing -> visible status + CI gate;
   unsupported-language -> silent zero.
4. Large-workspace re-dogfood: findings when ready; three original failure modes now loud.
5. Both audits clean.
