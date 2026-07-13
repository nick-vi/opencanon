# Language Support

OpenCanon represents language support as explicit capabilities, not filename checks
scattered through the runtime. The authoritative inventory is
`packages/core/src/language-registry.ts`; parser implementations live behind the
engine facts boundary, and project policy remains in Project Canon conventions.

## Ownership boundary

- The language registry owns static capability claims: extensions, source role,
  parser identity, fact coverage, graph and resolution modes, refactor operations,
  and naming idioms.
- The Rust engine owns parser execution, normalized facts, import resolution, and
  graph construction for capabilities advertised by the registry.
- The TypeScript semantic producer owns type-dependent facts. Its readiness and
  generation are runtime state, not static language metadata.
- Convention runtimes own project policy. A language capability says what OpenCanon
  can inspect; it never says what a repository permits.

Consumers query the registry helpers instead of maintaining their own extension or
language lists. Parser ASTs do not cross the engine boundary; all parsers normalize
into the language-neutral facts contract.

## Current capability matrix

| Language | Files | Syntactic facts | Graph and resolution | Semantic facts | Refactors |
| --- | --- | --- | --- | --- | --- |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` | Oxc provides imports, exports, symbols, declarations, calls, literals, and comments. Core derives references, annotations, and duplicates. | Derived code graph and TypeScript module resolution. | The TypeScript producer provides finite-literal type facts. | Text-backed symbol rename and literal replacement. |
| Svelte | `.svelte` | The engine extracts supported facts from embedded script blocks with Oxc: imports, exports, symbols, declarations, calls, and literals. Whole-file comments are text-scanned and are not advertised as parser facts. | TypeScript import resolution is available for script imports. Svelte is excluded from whole-file graph indexing because its source is embedded. | None. | Text-backed symbol rename and literal replacement. |
| Python | `.py` | RustPython provides imports, symbols, and calls. | Derived symbol/import graph with Python relative and absolute module resolution. | None. | Text-backed symbol rename and literal replacement. |
| JSON | `.json` | None. | None. | None. | None. |
| Markdown | `.md`, `.markdown` | None. | None. | None. | None. |
| Text | unmatched files | None. | None. | None. | None. |

This table mirrors `LANGUAGE_DESCRIPTORS`. A capability is supported only when the
descriptor advertises it and its implementation is covered by tests.

## Syntactic and semantic facts

Syntactic facts and semantic facts are separate contracts:

- Syntactic facts describe source structure and come from the parser selected by the
  language descriptor. Derived fact kinds are computed from parser output in core.
- Semantic facts depend on a live producer and carry producer status and generation.
  Validators that depend on them declare `requiresProducers`.

OpenCanon does not silently substitute regex or text guesses when an advertised parser
or required semantic producer is unavailable. Unsupported syntactic access fails for
that validation run. A non-ready semantic producer records a validator outcome; strict
producer mode makes the skipped requirement fail validation. Validators that consume
typed facts without declaring the producer are diagnosed as contract violations.

## Graph, resolution, and refactor behavior

The registry keeps related capabilities distinct:

- `graph.mode` controls whether code graph edges are derived, provider-owned, or absent.
- `resolution.strategyId` selects language-specific module resolution.
- `refactor.level` and `operations` describe edits OpenCanon can perform. Unsupported
  operations are not approximated with another language's syntax.
- Naming idioms are language metadata used by validators; repository-specific naming
  policy remains a convention.

These declarations are consumed through registry helpers such as
`isEngineExtractableFile`, `isCodeGraphIndexableFile`,
`importRewritableExtensions`, and `engineSourceLanguage`.

## Cache and compatibility contract

Parser facts are derived state. Cache identity includes file content and the extractor
version advertised by the registry. The release consistency gate keeps registry
extractor versions aligned with the engine extractor version so a parser change cannot
reuse older facts. Semantic results additionally bind to the producer generation used
for the validation result.

Adding or expanding language support requires all of the following in one coherent
change:

1. update the descriptor without overstating fact coverage;
2. implement the parser, graph, resolver, semantic, or refactor capability at its owned
   boundary;
3. update extractor/cache versions when output semantics change;
4. add engine, registry, runtime, validator, and fixture coverage appropriate to the
   capability;
5. run project validation and Doctor before the capability is considered available.

The registry and its tests are the machine-readable contract. This document explains
that contract; it is not a roadmap or a second source of truth.
