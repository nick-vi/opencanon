# AST Facts Migration — Design Doc

Status: **COMPLETE.** All seven TS fact kinds (imports, exports, functions,
declarations, calls, literals, comments) are extracted by the oxc engine via the
`ProjectAstFactsProvider` seam; the regex TS parsers + transient fallbacks are
deleted. Provider installed on every path (runtime, CLI, vitest). Svelte + Python
keep their own parsers (separate languages, gated per §8). Dual-audited; the
stale-cache CRITICAL (cache.ts `parserVersion` lockstep with the engine
`EXTRACTOR_VERSION`, enforced by `release:check`) and the per-kind-reparse perf
were fixed. Audit follow-ups DONE: `withCliAstFactsProvider()` helper for
in-process/external hosts; the runtime snapshot now threads file `content` through
`extractFacts` (no scan→extract TOCTOU). ONE known remainder: `cli/code-graph.ts`
still re-reads disk in `indexCodeGraph` (one-shot CLI command, low impact; needs
a `content` field on `indexCodeGraph` — a separate engine change).

## 1. Motivation

`ctx.facts.*` (the fact layer the 23 validators read) is built by **line-anchored
regex** in `packages/core/src/facts.ts` + `packages/core/src/typescript.ts`
(e.g. `line.match(/^\s*export\s+(function|const|class|type|interface)\s+.../)`).

Meanwhile the runtime — where validation actually runs (`CLI → POST /api/validate`) —
**already parses every JS/TS file with the native oxc AST** for the code-graph,
and caches `FileFacts` in SQLite. So today the system **double-parses** JS/TS:
oxc for the graph, regex for the rules, with the rules getting the *lower-quality*
parse.

Goal: feed `ctx.facts.*` from the engine AST (oxc) instead of regex. Delete the
regex extractors. One syntactic source of truth, the precise one.

Non-goal: replacing the **type-producer** (`ctx.typed.*`). That stays — it is the
*semantic* layer (types, inferred values, literal-union members). This migration
is about *syntactic* precision only.

### Known regex failure modes this removes
- Line-anchored `^\s*export` misses: multi-line declarations, decorators above
  the keyword, re-exports not at line start, `export {` blocks.
- `buildCallFacts` brace/arg scanning is fooled by regex literals (`/[}]/`),
  template `${…}` interpolation, generics (`Map<A,B>`), strings that look like code.
- `buildReferenceFacts` identifier scan is a raw `\bNAME\b` regex → matches names
  in comments, strings, and unrelated scopes.

## 2. Current architecture

```
oxc engine (Rust) ─→ FileFacts ─→ code-graph + runtime snapshot   (validators DON'T read)
file.ts.*/file.py.* (line regex, typescript.ts) ─┐
buildXFacts (regex/derive, facts.ts) ────────────┴─→ ctx.facts.* ─→ 23 validators
ts type-producer (tsc child) ─→ ctx.typed.* ─→ semantic-precision rules
```

`FileFacts` (engine) ALREADY contains: `imports, exports, symbols, calls,
literals, comments` (+ more). They are extracted and cached but never surfaced to
validators.

## 3. Target architecture

```
oxc engine (Rust) ─→ FileFacts ─→ code-graph  AND  ctx.facts.*
ts type-producer ─→ ctx.typed.*   (unchanged)
```

Per-language visitors all normalize into the same language-neutral `FileFacts`
schema. oxc visitor exists. Future: ruff/rustpython visitor (Python), syn (Rust) —
**gated, see §8**.

## 4. Fact taxonomy: base vs derived

**Base facts** (must come from a parser, per language):
`imports`, `exports`, `symbols`, `calls`, `literals`, `comments`.

**Derived facts** (computed in TS from base facts; language-neutral; NO parser
work needed — they just recompute once the base facts are AST-backed):
- `references` ← `imports` + `calls` + exported `symbols` (+ an identifier scan, see §5).
- `annotations` ← `comments` + `symbols` (nearest-following-symbol owner).
- `duplicates` ← `literals` (group string literals appearing ≥3×).

⇒ Migration surface = **6 base fact kinds**. Derived facts follow for free, EXCEPT
the `references` identifier-scan (§5.references) which is itself a regex today.

## 5. Per-fact-kind SEMANTIC CONTRACT

> Codex's mandate: define what each fact MEANS first, then make the AST extractor
> conform to the contract — not to whatever oxc happens to expose, and not to
> whatever the regex happened to capture. Each contract states: definition,
> fields, inclusion/exclusion rules, edge cases, and the deliberate diff from
> current regex behavior.

### imports
- **Means:** one module-import or re-export edge originating in this file.
- **Fields:** `line, column?, source (module specifier), specifiers[], kind:
  import|export|dynamic, resolution`.
- **Include:** static `import`, `import type`, side-effect `import "x"`,
  `export … from "x"` (re-export), dynamic `import("x")` with a static-string arg.
- **Exclude:** `require()` (CJS) unless a validator needs it (decide explicitly);
  `import()` with a non-literal arg (record as dynamic with `source: undefined`).
- **Edge/diff vs regex:** multi-line import specifier lists (regex misses) → now
  captured. `import type` distinguished. Re-export `specifiers` enumerated.

### exports
- **Means:** a name this file makes externally visible.
- **Fields:** `line, name, kind: function|class|const|let|var|type|interface|enum|default`.
- **Include:** `export` declarations, `export default`, `export { a, b }`,
  `export { x } from` (re-export names).
- **Exclude:** type-only vs value: keep `kind` faithful (`type`/`interface` are
  type-only). `export *` → record as a star re-export (kind TBD; today regex drops it).
- **Edge/diff:** decorated/multi-line exports now captured; `export default
  function foo` keeps name `foo` (regex anonymizes).

### symbols
- **Means:** a top-level (and optionally nested) declaration in this file.
- **Fields:** `line, column?, endLine?, name, kind: function|class|method|
  variable|type|interface|enum|property|unknown, exported, params?`.
- **Include:** functions, classes (+ methods? — decide: current regex does NOT
  emit methods; keep parity initially, add later behind a flag), const/let/var,
  type, interface, enum.
- **`exported`:** true if the declaration carries `export` OR its name appears in
  an `export { … }`. Contract: a single boolean per declaration.
- **`endLine`:** span end (declarations use it for "is X inside this decl"). oxc
  gives real spans → more accurate than regex brace-guess.
- **`params`:** function parameter source text, in order.
- **Edge/diff:** nested/arrow/assigned functions (`const f = () => …`) — define
  whether they are `function` or `variable` symbols (regex: `variable`). Keep
  parity, document.

### calls
- **Means:** a call expression `callee(args)`.
- **Fields:** `line, column?, name (last segment), receiver? (dotted chain before
  name), callee (full source text of callee), tryDepth (# enclosing try-BODIES,
  not catch/finally), argumentCalls[] ({callee,name,awaited})`.
- **Include:** every `CallExpression`. `new X()`? — decide (today regex catches
  `X(` after `new`; AST would separate NewExpression — keep them OUT of calls or
  add `isNew`).
- **Exclude:** keyword "calls" the regex false-matched (`if(`, `for(`, `while(`,
  `switch(`, `catch(`) — AST never emits these, so a *correctness improvement*.
- **`tryDepth` (AST-correct):** lexical count of enclosing try-block BODIES. A call
  in a `catch`/`finally` has depth 0 w.r.t. that try. This replaces the brace
  scanner — and is exact (no regex-literal/template miscounts).
- **`argumentCalls`:** direct call expressions in the argument list (one level),
  unwrapping a leading `await`. Powers `no-unguarded-json-parse`.
- **Edge/diff:** optional chaining `a?.b()`, tagged templates, computed
  `a["b"]()` — define `name`/`receiver` for each.

### literals
- **Means:** a string/number/boolean literal token + its syntactic context.
- **Fields:** `value, valueKind: string|number|boolean, line, column, context
  (comparison|argument|object-property|array-item|type-union|const-object|
  import-source|test-title|unknown), declarationSourceId?`.
- **`context`:** the surrounding syntactic role — AST gives this precisely (parent
  node kind), where regex guesses from neighbouring chars.
- **`declarationSourceId`:** set when the literal is a member of a named const-object
  or type-union declaration (used by `inline-soft-enum-literal`).
- **Edge/diff:** template literals (no-substitution → string? with-substitution →
  exclude or mark), regex literals (NOT string literals), numeric separators/bigint.

### comments
- **Means:** a comment token.
- **Fields:** `line, column, text, kind: line|block`.
- **Edge/diff:** AST/lexer gives exact comment ranges; regex can mismatch `//` and
  `/* */` inside strings/regex literals. JSDoc stays a block comment (annotation
  extraction parses tags in the derived layer).

### references (DERIVED — but note the identifier scan)
- **Means:** a use-site of a name (import, call, exported-symbol identifier).
- Built from `imports` (kind import/export), `calls` (kind call), and an
  **identifier scan** for exported symbols used cross-file.
- **The wart:** the identifier scan today is `file.find(/\bNAME\b/g)` — matches in
  comments/strings/unrelated scopes. AST-correct version = walk identifier
  references (oxc gives `IdentifierReference` nodes with binding info). This is the
  one derived fact that genuinely improves with AST. Migrate it WITH `calls`/`symbols`.

### annotations (DERIVED)
- From `comments` + `symbols`: parse `@tag value` from comment text, attach
  `ownerName` = nearest following symbol. No parser change; recomputes from
  AST-backed comments+symbols (gets more accurate owners via real symbol spans).

### duplicates (DERIVED)
- From `literals`: group identical string literals (with an alphanumeric char)
  occurring ≥3×. No parser change.

## 6. The `FileFacts` schema is the contract surface

`FileFacts` was shaped in the regex era. **Risk:** it may encode regex
approximations (e.g. `callee` as raw text, `params` as strings not structured).
Action: §5 contracts above are the authoritative definitions; where oxc can give
something cleaner, change the schema deliberately (versioned), don't preserve a
bad shape just because regex produced it.

`ProjectXFact` (validator-facing, carries the live `ProjectFile`) is the public
type validators consume. Keep it stable across the migration; only its *source*
changes. Any field change here = a validator-visible API change → fixtures + the
23-validator parity pass.

## 7. Perf model

Validation runs in the runtime (engine + warm SQLite cache present).
- **Warm runtime (normal path):** neutral→faster — removes the redundant regex
  pass, reuses cached normalized facts. **Cache facts, never ASTs** (memory).
- **Cold CLI one-shot:** regresses (cold parse + engine init). Acceptable.
- **NAPI boundary:** serialize compact facts, not trees. Watch payload size on
  large repos.
- **Cache keys MUST include:** content hash + parser version + extractor version +
  fact-schema version + (for type-aware contexts) tsconfig/package context. A bump
  in any invalidates.

## 8. Polyglot gating

oxc = JS/TS only. Migrate a language only when pain crosses a line (codex):
the runtime already parses it for another feature; OR ≥3 validators have known
regex false pos/neg; OR a rule needs nesting/scope/try-depth; OR regex distrust
blocks validator authors.

- **JS/TS:** crosses today → migrate now (oxc).
- **Python:** not yet → keep regex, documented. When it crosses: `ruff_python_parser`
  (best fidelity) or `rustpython-parser` (clean crates.io dep).
- **Rust:** `syn` only if source-level Rust facts are ever needed. Defer.
- **Svelte:** hybrid (compiler/tree-sitter) later — embedded script/template is the
  real problem.
- **NOT tree-sitter as the correctness layer** — uniform syntax ≠ uniform fidelity;
  precision is the product.

⇒ Until JS/TS migration is done + proven, **non-JS/TS facts stay regex**. The fact
layer becomes "AST for JS/TS, regex for the rest," documented honestly.

## 9. Sequencing (hardened, per codex)

0. **This doc** — semantic contracts (§5). ✅
1. **Parity harness** — a script/test that runs BOTH the regex extractor and the
   engine extractor over real workspaces and every fixture, per
   fact kind, and diffs. Classify each diff: `regex-bug | AST-bug | intentional`.
   Keep golden snapshots for nasties (regex literals, templates, generics,
   decorators, re-exports, multi-line decls).
2. **Migrate low-risk first:** `imports` → `exports` → `symbols`. Each behind a
   feature flag (`OPENCANON_FACTS_SOURCE=ast|regex`), flip, re-run all fixtures +
   the 23-validator parity pass.
3. **Then the hard ones:** `comments` → `literals` → `calls` → `references`
   identifier-scan.
4. **Delete the regex path** for a migrated fact kind only **after one release
   cycle** with the flag defaulting to AST and no regressions reported.
5. Derived facts (`annotations`, `duplicates`) ride along automatically; verify
   their fixtures after each base-fact flip.

## 10. Decisions (resolved)

**Parity philosophy: AST-correct wins.** Where the AST disagrees with regex
because regex was buggy, the AST output is authoritative; the parity harness
classifies every diff (`regex-bug | AST-bug | intentional`) and we fix fixtures to
the correct behavior. Precision is the product.

**Scope: richer from the start** (not parity-first):
1. Methods ARE emitted as symbols (`kind: method`).
2. `new X()` is recorded in `calls` with `isNew: true` (add field).
3. CJS `require("x")` IS recorded in `imports` (kind: `require` or `import` —
   decide in the imports contract; keep `kind` faithful).
4. Arrow/assigned functions classified precisely: `const f = () => …` →
   `kind: function` (not `variable`) when the initializer is a function/arrow.
5. Keyword false-calls (`if`/`for`/`while`/`switch`/`catch`) never emitted (AST
   correctness — they were regex noise).

Consequence: bigger initial diffs + more fixture churn than parity-first, but the
end state is fuller, correct facts. The parity harness absorbs the churn safely.

**Still to set when we get there:** flag name + per-phase default
(`OPENCANON_FACTS_SOURCE`), and the "one release cycle" definition before deleting
a regex path.

## 10b. Phase 1 parity-harness findings (this repo, 170 oxc-source files)

Run: `node scripts/ast-parity.ts`. Semantic-identity diff (line ignored).

| kind | both | regexOnly | astOnly | reading |
|---|---|---|---|---|
| imports | 763 | 2 | 35 | AST ~strictly better — catches multi-line `import {…}` blocks the line-regex drops (`@opencanon/core` in baseline/bundle/refactor/setup). 2 regexOnly to classify (init.ts `node:url`). |
| exports | 1073 | 0 | 804 | regex is badly incomplete — `^\s*export\s+(function\|const\|…)` is **blind to `export { a } from`** re-exports. AST captures all named re-exports (kind=`unknown` — engine doesn't classify re-export kinds yet → contract item). |
| symbols | 4803 | 217 | 529 | AST richer (nested/arrow/assigned vars). regexOnly=217 are mostly `type`/`interface` aliases the engine symbol extractor doesn't emit → **AST gap to fix** (emit type-alias symbols) before flipping `symbols`. |

Classification so far:
- **imports:** astOnly = regex-bug (missed multi-line). Investigate the 2 regexOnly.
- **exports:** astOnly = regex-bug (missed re-exports). Engine must classify re-export `kind` (contract §5 exports) before flip — `unknown` is a downgrade for rules that switch on kind.
- **symbols:** astOnly = intentional (richer, per §10 "richer from the start"). regexOnly type-aliases = **AST-bug/gap** — extend the oxc symbol visitor to emit `type`/`interface`/enum aliases.

⇒ Lowest-risk first flip is still **imports** (AST nearly strict-superset, tiny tail). `exports` needs the re-export `kind` classification; `symbols` needs the type-alias gap closed. Both are concrete engine tasks, not unknowns.

## 11. Risks
- **Schema mismatch (biggest):** `FileFacts` encodes regex-era abstractions; AST
  extractor may preserve bad shapes or silently shift validator behavior. Mitigation:
  §5 contracts are authoritative; parity harness classifies every diff.
- **Silent validator behavior change** across 23 rules. Mitigation: per-fact-kind
  flag + full fixture/parity pass before each flip.
- **Cache correctness** — stale facts if any version key is missed.
- **Cold-start regression** for CLI one-shot users with no runtime.
- **Scope creep into polyglot** — explicitly gated (§8).
