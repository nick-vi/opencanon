/**
 * Language Capability Registry — the single home for everything OpenCanon needs to
 * know about a language (docs/language-support-foundation.md). Each descriptor
 * declares a language's FULL capability profile; consumers query the registry
 * instead of branching ad-hoc on language. Adding a language = one descriptor +
 * filling its extension points.
 *
 * This module is STATIC core knowledge (extensions, idioms, which tool each
 * capability uses) — engine-free and always available. The runtime IMPLEMENTATION
 * of the `facts` capability is supplied separately via the ProjectAstFactsProvider
 * seam; the descriptor only names which extractor a language uses.
 *
 * Honesty rule: `facts.extractor` names the REAL tool (`oxc`/`rustpython` AST, or
 * `none`), so "is language X on a proper parser?" is a queryable fact.
 */
import type { FactKind } from "./contracts.ts";

/** The languages OpenCanon classifies files into. The registry is the sole
 * authority — consumers import this directly from here. */
export const ProjectFileLanguage = {
  TypeScript: "typescript",
  Svelte: "svelte",
  Python: "python",
  Json: "json",
  Markdown: "markdown",
  Text: "text",
} as const;

export type LanguageId = (typeof ProjectFileLanguage)[keyof typeof ProjectFileLanguage];
export type LanguageRole = "source" | "embedded-source" | "doc" | "config" | "text";
export type FactExtractor = "oxc" | "rustpython" | "none";
export type FactCoverage = "full" | "partial" | "none";
export type SemanticCapability = "finite-literal-types" | "symbol-resolution" | "import-resolution" | "call-resolution" | "diagnostics";
export const GraphModeKind = { Derived: "derived", Provider: "provider", None: "none" } as const;
export type GraphMode = (typeof GraphModeKind)[keyof typeof GraphModeKind];
export type RefactorLevel = "semantic" | "ast" | "text" | "none";
export type RefactorOperation = "renameSymbol" | "replaceLiteral" | "organizeImports";
export type IdentifierRole = "function" | "method" | "variable" | "constant" | "type" | "enum" | "component";
export type NamingStyle = "camelCase" | "PascalCase" | "snake_case" | "SCREAMING_SNAKE_CASE" | "kebab-case";

export interface LanguageDescriptor {
  id: LanguageId;
  extensions: string[];
  role: LanguageRole;
  embeddedSublanguages?: LanguageId[]; // svelte: TS in <script>

  facts: {
    extractor: FactExtractor; // the REAL tool — oxc / rustpython (AST) or none
    // Availability via the facts API = extractor-emitted PLUS core-derived kinds.
    coverage: Partial<Record<FactKind, FactCoverage>>;
    // Kinds NOT emitted by the extractor but DERIVED in core from the emitted base
    // facts (e.g. references/annotations/duplicates), so `coverage` is not read as
    // "the extractor produces all of these".
    derived?: FactKind[];
    extractorVersion: string;
  };
  semantic?: { providerId: string; capabilities: SemanticCapability[] };
  graph: { mode: GraphMode };
  resolution?: { strategyId: string };
  refactor: { level: RefactorLevel; operations: RefactorOperation[] };
  naming: { identifiers: Partial<Record<IdentifierRole, NamingStyle>> };
}

// What the oxc extractor emits directly vs what core derives from those base facts.
const TS_EXTRACTOR_FACT_KINDS: FactKind[] = ["imports", "exports", "symbols", "declarations", "calls", "literals", "comments"];
const TS_DERIVED_FACT_KINDS: FactKind[] = ["references", "annotations", "duplicates"];
const TS_FACT_KINDS: FactKind[] = [...TS_EXTRACTOR_FACT_KINDS, ...TS_DERIVED_FACT_KINDS];
// Svelte comments are NOT in this set: `file.comments()` scans the whole .svelte
// file as text (markup + script), not the AST provider, so comment coverage is
// not an extractor capability here.
const SVELTE_FACT_KINDS: FactKind[] = ["imports", "exports", "symbols", "declarations", "calls", "literals"];
const full = (kinds: FactKind[]): Partial<Record<FactKind, FactCoverage>> => Object.fromEntries(kinds.map((k) => [k, "full" as FactCoverage]));

export const LANGUAGE_DESCRIPTORS: LanguageDescriptor[] = [
  {
    id: ProjectFileLanguage.TypeScript,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    role: "source",
    facts: { extractor: "oxc", coverage: full(TS_FACT_KINDS), derived: TS_DERIVED_FACT_KINDS, extractorVersion: "engine-graph-16" },
    semantic: { providerId: "typescript-type-producer", capabilities: ["finite-literal-types"] },
    graph: { mode: "derived" },
    resolution: { strategyId: "typescript" },
    refactor: { level: "text", operations: ["renameSymbol", "replaceLiteral"] },
    naming: { identifiers: { function: "camelCase", method: "camelCase", variable: "camelCase", constant: "SCREAMING_SNAKE_CASE", type: "PascalCase", enum: "PascalCase", component: "PascalCase" } },
  },
  {
    id: ProjectFileLanguage.Svelte,
    extensions: [".svelte"],
    role: "embedded-source",
    embeddedSublanguages: [ProjectFileLanguage.TypeScript],
    facts: { extractor: "oxc", coverage: full(SVELTE_FACT_KINDS), extractorVersion: "engine-graph-16" },
    graph: { mode: "derived" },
    resolution: { strategyId: "typescript" },
    refactor: { level: "text", operations: ["renameSymbol", "replaceLiteral"] },
    naming: { identifiers: { component: "PascalCase", function: "camelCase", constant: "SCREAMING_SNAKE_CASE", type: "PascalCase" } },
  },
  {
    id: ProjectFileLanguage.Python,
    extensions: [".py"],
    role: "source",
    facts: { extractor: "rustpython", coverage: full(["imports", "symbols", "calls"]), extractorVersion: "engine-graph-16" },
    graph: { mode: "derived" }, // engine builds a Python code graph (symbol nodes + resolved import edges)
    resolution: { strategyId: "python" }, // rustpython module resolution: relative + absolute dotted, __init__.py-aware
    refactor: { level: "text", operations: ["renameSymbol", "replaceLiteral"] },
    naming: { identifiers: { function: "snake_case", method: "snake_case", variable: "snake_case", constant: "SCREAMING_SNAKE_CASE", type: "PascalCase", enum: "PascalCase", component: "PascalCase" } },
  },
  { id: ProjectFileLanguage.Json, extensions: [".json"], role: "config", facts: { extractor: "none", coverage: {}, extractorVersion: "none" }, graph: { mode: "none" }, refactor: { level: "none", operations: [] }, naming: { identifiers: {} } },
  { id: ProjectFileLanguage.Markdown, extensions: [".md", ".markdown"], role: "doc", facts: { extractor: "none", coverage: {}, extractorVersion: "none" }, graph: { mode: "none" }, refactor: { level: "none", operations: [] }, naming: { identifiers: {} } },
  { id: ProjectFileLanguage.Text, extensions: [], role: "text", facts: { extractor: "none", coverage: {}, extractorVersion: "none" }, graph: { mode: "none" }, refactor: { level: "none", operations: [] }, naming: { identifiers: {} } },
];

const byId = new Map<LanguageId, LanguageDescriptor>(LANGUAGE_DESCRIPTORS.map((d) => [d.id, d]));
const byExtension = new Map<string, LanguageDescriptor>();
for (const descriptor of LANGUAGE_DESCRIPTORS) for (const ext of descriptor.extensions) byExtension.set(ext, descriptor);

/** Descriptor for a language id (always defined for a known LanguageId). */
export function languageDescriptor(id: LanguageId): LanguageDescriptor {
  return byId.get(id) ?? byId.get(ProjectFileLanguage.Text)!;
}

/** Descriptor for a file extension (e.g. ".ts"); defaults to text. */
export function descriptorForExtension(extension: string): LanguageDescriptor {
  return byExtension.get(extension) ?? byId.get(ProjectFileLanguage.Text)!;
}

/** Real (AST) fact extractors, vs `none`. */
const properParsers = new Set<FactExtractor>(["oxc", "rustpython"]);
/** Whether a language's fact extractor is a real parser (vs `none`). */
export function usesProperParser(id: LanguageId): boolean {
  return properParsers.has(languageDescriptor(id).facts.extractor);
}

/** Idiomatic naming style for an identifier role in a language, if declared. */
export function namingIdiom(id: LanguageId, role: IdentifierRole): NamingStyle | undefined {
  return languageDescriptor(id).naming.identifiers[role];
}

/** Extensions the engine extracts facts from: any language with a real parser.
 * Includes embedded-source Svelte — the engine's SvelteExtractor locates its
 * <script> blocks and parses them with oxc, so it is whole-file engine-extractable
 * like the rest. Single source for the runtime snapshot / provider bulk extract. */
const embeddedRoles = new Set<LanguageRole>(["embedded-source"]);
export const engineExtractableExtensions: string[] = LANGUAGE_DESCRIPTORS.filter((d) => properParsers.has(d.facts.extractor)).flatMap((d) => d.extensions);

/** Whether the engine can extract facts from this file in one whole-file parse. */
export function isEngineExtractableFile(filePath: string): boolean {
  return engineExtractableExtensions.some((extension) => filePath.endsWith(extension));
}

/** Extensions the engine builds a CODE GRAPH for: a derived-graph language with a
 * real parser that the engine parses whole-file (TS/JS family + Python). Excludes
 * embedded-source Svelte, whose facts come from <script> sub-blocks rather than a
 * whole-file graph parse. NARROWER than fact extraction (which also covers Svelte). */
const codeGraphIndexableExtensions: string[] = LANGUAGE_DESCRIPTORS.filter(
  (d) => d.graph.mode === GraphModeKind.Derived && properParsers.has(d.facts.extractor) && !embeddedRoles.has(d.role),
).flatMap((d) => d.extensions);

/** Whether the engine builds a code graph for this file (TS/JS family + Python). */
export function isCodeGraphIndexableFile(filePath: string): boolean {
  return codeGraphIndexableExtensions.some((extension) => filePath.endsWith(extension));
}

/** Extensions whose imports the refactor engine can rewrite: languages that resolve
 * imports via the TypeScript strategy (ES-module specifiers) — TS/JS family + Svelte.
 * Python is excluded: its imports are not ES-module specifiers. Single source for the
 * refactor module's source-file set, grounded in a declared resolution capability
 * rather than a hand-maintained list. */
const typescriptResolutionStrategy = "typescript";
export const importRewritableExtensions: string[] = LANGUAGE_DESCRIPTORS.filter(
  (d) => d.resolution?.strategyId === typescriptResolutionStrategy,
).flatMap((d) => d.extensions);

/** The source-type hint the engine parser wants for a file — finer-grained than
 * LanguageId (oxc needs tsx/jsx/js variants). Single source for every engine
 * extract/index call site (facts provider, snapshot, code-graph) so they can't
 * drift on extensions like .mjs/.cjs. Only meaningful for engine-extractable
 * files; defaults to "typescript". */
export type EngineSourceLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "python" | "svelte";
export function engineSourceLanguage(filePath: string): EngineSourceLanguage {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".jsx")) return "jsx";
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".svelte")) return "svelte"; // engine SvelteExtractor splits <script> blocks
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return "javascript";
  return "typescript"; // .ts/.mts/.cts and any other engine-extractable source
}
