import { existsSync } from "node:fs";
import path from "node:path";
import type { AnalysisCache } from "./cache.ts";
import { getAnalysisCache } from "./cache.ts";
import type { Baseline, ContextPaths, ImpactSurface, ProposedImpactNote } from "./core.ts";
import { ConventionRenderKind, ConventionRenderStyle, defineConvention, type Applies, type Convention, type Render } from "./convention.ts";
import { createPaths, listFiles, matchesAny, normalizePath, relative } from "./core.ts";
import { loadBaseline, loadImpactSurfaces, loadProposedImpactNotes } from "./core.ts";
import { createRuntime } from "./validator-runtime.ts";
export { createRuntime } from "./validator-runtime.ts";
import type { Profiler } from "./profiler.ts";
import { createProjectFile, createProjectFileFromSnapshot, loadProjectFiles, type ProjectFileSnapshot } from "./project-files.ts";
import { isSupportedSourceFile } from "./discovery.ts";
import { ProjectFileLanguage } from "./language-registry.ts";
import { listKnownContextFiles, readContextJson, readContextText } from "./context-readers.ts";
import { buildImportGraph, buildWorkspaceGraph } from "./workspace.ts";
import { buildAnnotationFacts, buildCallFacts, buildDiagnosticFacts, buildDuplicateFacts, buildExportFacts, buildLiteralFacts, buildReferenceFacts, buildSymbolFacts } from "./facts.ts";
import {
  DeclarationIndex,
  queryLiterals,
} from "./language-analyzer.ts";
export { SidecarTypeFactsProvider, DeclarationIndex, readSidecarPayloadDetailed, sidecarStatusFromRead, queryLiterals, siteKey, comparisonSites, asFiniteLiteralSet, finiteLiteralIncludes, pickAuthoritativeStatus, ProducerStatusKind, TypeResolutionKind } from "./language-analyzer.ts";
export type { TypeFactsProvider, TypeSource, TypeSite, TypeResolution, LiteralValue, LiteralMember, LiteralUnionSyntax, FiniteLiteralSet, ProducerStatus, ProducerWarning, ProducerSnapshot, ProducerSnapshotEntry, ResolvedLiteralFact, SidecarEntry, SidecarPayload, SidecarSourceFile, SidecarCoverage, SidecarReadResult, SymbolId, LiteralQuery } from "./language-analyzer.ts";
import { findingKey } from "./findings.ts";
import { validateTree } from "./tree.ts";
import { materializeFixture, type FixtureDefinition } from "./testing.ts";

export {
  SupportedTypeScriptVersionRange,
  installedProducerPackageVersion,
  installedTypeScriptPackageJsonPath,
  installedTypeScriptVersion,
  isProducerToolchainAvailable,
  isSupportedTypeScriptVersion,
  BatchProducerPolicy,
  InteractiveProducerPolicy,
  ProducerArtifactFreshness,
  ProducerArtifactId,
  producerDefinitionForLanguage,
  producerDefinitionHasArtifact,
  producerDefinitionHasLiveWorker,
  producerDefinitions,
  ProducerLiveWorkerId,
  ProducerRunProfile,
  ProducerSourceKind,
  producerPackageJsonPath,
  producerPackageVersionSupport,
  producerSetupStatus,
  producerSourceForLanguage,
  typeScriptVersionSupport,
  unsupportedTypeScriptVersionDetail,
} from "./producer-registry.ts";
export type { ProducerArtifactDefinition, ProducerDefinition, ProducerLiveWorkerDefinition, ProducerPackageToolchain, ProducerPolicy, ProducerRequiredConfig, ProducerSource, ProducerVersionRange } from "./producer-registry.ts";
import {
  consumedTypedFactsSymbol,
  producerStatusesSymbol,
  typeResolutionsSymbol,
  type TypeFactsCacheableValidationContext,
} from "./validator-type-facts.ts";
export {
  installContextTypeFacts,
  listMembershipFiles,
  membershipHashOf,
  normalizeProducerStatusesForProject,
  prewarmContextTypeFacts,
  prewarmTypeFacts,
  resolveArtifactTypeFactsProvider,
  resolveAuthoritativeProducerStatus,
  resolveLiveTypeFactsProvider,
  resolveProducerStatuses,
  resolveRunTypeFacts,
  resolveTypeFactsProvider,
  resolveTypeScriptSidecarStatus,
  setLiveTypeFactsProviderFactory,
  typedSidecarTsconfigHash,
} from "./validator-type-facts.ts";
export type { RunTypeFacts, TypeFactsProviderFactory } from "./validator-type-facts.ts";

export { validateFindings } from "./findings.ts";
export type { FindingValidationContext } from "./findings.ts";
export { formatValidatorApplies, resolveValidators, validateValidatorDefinitions, validatorMatchesAnyFile, validatorMatchesFile } from "./validator-definitions.ts";
export { FixSafety } from "./validator-types.ts";
export type {
  BaselineApi,
  DomainEdge,
  FactsApi,
  FileRead,
  FileReportInput,
  Finding,
  FindingFix,
  CommitGate,
  CommitGateEvidence,
  CommitGateInput,
  FolderInfo,
  GraphApi,
  ImpactApi,
  ImpactRequiredChecks,
  ImportEdge,
  JsonRead,
  ProjectAnnotationFact,
  ProjectCallFact,
  ProjectComment,
  ProjectDiagnosticFact,
  ProjectDuplicateFact,
  ProjectExportFact,
  ProjectFile,
  ProjectGraphEdge,
  OpenCanonProjectIndex,
  OpenCanonProjectIndexFile,
  ProjectLiteralFact,
  ProjectCallNameIn,
  ProjectCalleeOf,
  ProjectCallerOf,
  ProjectExportNameIn,
  ProjectFunctionNameIn,
  ProjectImportSourceIn,
  ProjectIndexFilePath,
  ProjectStringLiteralIn,
  ProjectSymbolId,
  ProjectSymbolNameIn,
  ProjectReferenceFact,
  RuntimeContextCoverage,
  ProjectSymbolFact,
  ReportInput,
  Severity,
  TextEdit,
  TextMatch,
  TypedCallEdge,
  TypedCallFact,
  TypedCallerEdge,
  TypedExportFact,
  TypedFactsApi,
  TypedFunctionFact,
  TypedImportFact,
  TypedStringLiteralFact,
  TypedSymbolFact,
  ValidationContext,
  Validator,
  ValidatorArgs,
  ValidatorDefinition,
  ValidatorRuntime,
  ValidatorSummary,
  ValidatorSummaryInput,
  ValidatorVisual,
  WorkspaceGraph,
  WorkspaceKind,
  WorkspacePackage,
} from "./validator-types.ts";
import type {
  DomainEdge,
  CommitGate,
  FolderInfo,
  ImportEdge,
  ProjectAnnotationFact,
  ProjectCallFact,
  ProjectDiagnosticFact,
  ProjectDuplicateFact,
  ProjectExportFact,
  ProjectFile,
  ProjectGraphEdge,
  ProjectLiteralFact,
  ProjectReferenceFact,
  RuntimeDefinition,
  Severity,
  ProjectSymbolFact,
  ValidationContext,
  Validator,
  ValidatorDefinition,
  ValidatorRuntime,
  ValidatorSummary,
  WorkspaceGraph,
} from "./validator-types.ts";
import { ProjectSymbolKind } from "./validator-types.ts";
const flushCacheSymbol = Symbol("opencanon.flushCache");
const commitGatesSymbol = Symbol("opencanon.commitGates");
const commitGateDiagnosticsSymbol = Symbol("opencanon.commitGateDiagnostics");
const fixtureCleanupSymbol = Symbol("opencanon.fixtureCleanup");
// Pre-warmed surrounding-type map (keyed by siteKey), stored on the context by
// `prewarmTypeFacts` and read synchronously by `ctx.typed.literal()`.
// Resolved per-language producer statuses for this run, stored on the context by
// the pre-warm and read synchronously by `ctx.typed.producerStatus(...)`.
// Languages whose producer-resolved type facts a validator actually consumed via
// `ctx.typed.literal(...)` during its run. The validation pipeline reads
// this after `validate()` to detect a forgetful author who consumed typed facts
// for a non-ready producer without declaring `requiresProducers`.
// Source texts of this context's analysis files (TS/Svelte), retained for
// callers that want raw text. Typed facts come only from a producer, not from text.
const analysisSourceTextsSymbol = Symbol("opencanon.analysisSourceTexts");
type CacheableValidationContext = TypeFactsCacheableValidationContext & {
  [flushCacheSymbol]?: () => void;
  [commitGatesSymbol]?: CommitGate[];
  [commitGateDiagnosticsSymbol]?: string[];
  [fixtureCleanupSymbol]?: () => void;
  [analysisSourceTextsSymbol]?: Map<string, string>;
};

export type ConventionFactoryBaseOptions = {
  id: string;
  topics: string[];
  severity: Severity;
  related?: string[];
  docs?: string[];
  summary?: ValidatorSummary;
  title?: string;
  rule?: string;
  render?: Render;
};

export type ConventionFactory<TOptions extends Record<string, unknown> = Record<string, never>> = (
  options: ConventionFactoryBaseOptions & TOptions,
) => Convention;

export function createConventionFactory<TOptions extends Record<string, unknown> = Record<string, never>>(
  create: (options: ConventionFactoryBaseOptions & TOptions) => ValidatorDefinition,
  applies?: (definition: ValidatorDefinition, options: ConventionFactoryBaseOptions & TOptions) => Applies,
): ConventionFactory<TOptions> {
  return (options) => {
    const definition = create(options);
    const docs = definition.docs ?? options.docs ?? [];
    const summary = typeof definition.summary === "string" ? definition.summary : undefined;
    const messageInput = (options as unknown as { message?: unknown }).message;
    const message = typeof messageInput === "string" ? messageInput : undefined;
    return defineConvention({
      id: definition.id,
      title: options.title ?? titleFromId(definition.id),
      topics: definition.topics,
      related: definition.conventionIds,
      rule: options.rule ?? summary ?? message ?? titleFromId(definition.id),
      applies: applies?.(definition, options) ?? defaultConventionApplies(definition),
      render: options.render ?? (docs[0] ? defaultGeneratedRender(definition.id) : { kind: ConventionRenderKind.None }),
      runtime: {
        kind: "validator",
        severity: definition.severity ?? options.severity,
        scope: definition.scope ?? "project",
        facts: definition.facts ?? [],
        visuals: definition.visuals,
        requiresProducers: definition.requiresProducers,
        fixtures: definition.fixtures,
        validate: definition.validate ?? (() => []),
      },
    });
  };
}

function defaultGeneratedRender(id: string): Render {
  return {
    kind: ConventionRenderKind.Generated,
    docs: `docs/opencanon/canon/${id}.md`,
    style: ConventionRenderStyle.Reference,
  };
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function defaultConventionApplies(definition: ValidatorDefinition): Applies {
  const globs = definition.applies ?? [];
  return definition.scope === "import-edge" ? { kind: "imports", from: globs } : { kind: "files", globs };
}

export function createValidationContext(params: {
  rootDir: string;
  paths?: ContextPaths;
  files?: string[];
  directories?: string[];
  targetFiles?: string[];
  analysisFiles?: string[];
  projectFileSnapshots?: ProjectFileSnapshot[];
  project?: boolean;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache | null;
  profiler?: Profiler;
}): ValidationContext {
  const cache = params.cache === null ? undefined : (params.cache ?? (params.paths ? getAnalysisCache(params.paths) : undefined));
  const snapshotsByPath = new Map((params.projectFileSnapshots ?? []).map((snapshot) => [normalizePath(snapshot.path), snapshot]));
  const projectFiles = loadProjectFiles(params.rootDir, params.files, params.validator, params.paths, cache, params.profiler, params.projectFileSnapshots);
  const knownFiles = new Set(projectFiles.map((file) => file.path));
  for (const targetFile of params.targetFiles ?? []) {
    if (knownFiles.has(normalizePath(targetFile))) continue;
    if (!isSupportedSourceFile(targetFile)) continue;
    const snapshot = snapshotsByPath.get(normalizePath(targetFile));
    if (!snapshot && !existsSync(path.join(params.rootDir, targetFile))) continue;
    const file = snapshot
      ? createProjectFileFromSnapshot({ rootDir: params.rootDir, snapshot, validator: params.validator, cache, profiler: params.profiler })
      : createProjectFile({ rootDir: params.rootDir, file: targetFile, validator: params.validator, cache, profiler: params.profiler });
    projectFiles.push(file);
    knownFiles.add(file.path);
  }
  const filesByPath = new Map(projectFiles.map((file) => [file.path, file]));
  const targetFiles = (params.targetFiles ?? projectFiles.map((file) => file.path))
    .map((file) => filesByPath.get(file))
    .filter((file): file is ProjectFile => Boolean(file));
  const analysisFiles = (params.analysisFiles ?? targetFiles.map((file) => file.path))
    .map((file) => filesByPath.get(file))
    .filter((file): file is ProjectFile => Boolean(file));
  let importCache: ImportEdge[] | undefined;
  let folderCache: FolderInfo[] | undefined;
  let workspaceCache: WorkspaceGraph | undefined;
  let exportFactCache: ProjectExportFact[] | undefined;
  let symbolFactCache: ProjectSymbolFact[] | undefined;
  let callFactCache: ProjectCallFact[] | undefined;
  let literalFactCache: ProjectLiteralFact[] | undefined;
  let declarationIndexCache: DeclarationIndex | undefined;
  let referenceFactCache: ProjectReferenceFact[] | undefined;
  let annotationFactCache: ProjectAnnotationFact[] | undefined;
  let diagnosticFactCache: ProjectDiagnosticFact[] | undefined;
  let duplicateFactCache: ProjectDuplicateFact[] | undefined;
  let graphEdgeCache: ProjectGraphEdge[] | undefined;
  let impactSurfaceCache: ImpactSurface[] | undefined;
  let proposedImpactNoteCache: ProposedImpactNote[] | undefined;
  let baselineCache: Baseline | undefined;

  const ctx: CacheableValidationContext = {
    files: projectFiles,
    targetFiles,
    project: params.project ?? false,
    facts: {
      imports() {
        return ctx.imports();
      },
      exports() {
        exportFactCache ??= buildExportFacts(analysisFiles);
        return exportFactCache;
      },
      symbols() {
        symbolFactCache ??= buildSymbolFacts(analysisFiles);
        return symbolFactCache;
      },
      calls() {
        callFactCache ??= buildCallFacts(analysisFiles);
        return callFactCache;
      },
      literals() {
        literalFactCache ??= buildLiteralFacts(analysisFiles);
        return literalFactCache;
      },
      comments() {
        return ctx.comments();
      },
      references() {
        referenceFactCache ??= buildReferenceFacts(analysisFiles, ctx.imports(), ctx.facts.symbols(), ctx.facts.calls());
        return referenceFactCache;
      },
      annotations() {
        annotationFactCache ??= buildAnnotationFacts(ctx.facts.comments(), ctx.facts.symbols());
        return annotationFactCache;
      },
      diagnostics() {
        diagnosticFactCache ??= buildDiagnosticFacts(analysisFiles);
        return diagnosticFactCache;
      },
      duplicates() {
        duplicateFactCache ??= buildDuplicateFacts(ctx.facts.literals());
        return duplicateFactCache;
      },
    },
    typed: {
      imports(file) {
        return ctx.imports().filter((edge) => edge.from.path === file).map((edge) => ({ ...edge, file })) as never;
      },
      exports(file) {
        return ctx.facts.exports().filter((fact) => fact.file.path === file) as never;
      },
      functions(file) {
        return ctx.facts.symbols().filter((fact) => fact.file.path === file && fact.kind === ProjectSymbolKind.Function) as never;
      },
      stringLiterals(file) {
        return ctx.facts.literals().filter((fact) => fact.file.path === file) as never;
      },
      symbols(file) {
        return ctx.facts.symbols()
          .filter((fact) => fact.file.path === file)
          .map((fact) => ({ ...fact, id: symbolId(fact) })) as never;
      },
      calls(file) {
        return ctx.facts.calls().filter((fact) => fact.file.path === file) as never;
      },
      callees(symbol) {
        return ctx.graph.callees(symbol)
          .filter((edge) => edge.source)
          .map((edge) => ({ ...edge, from: symbolId(edge.source!), to: symbolId(edge.target) })) as never;
      },
      callers(symbol) {
        return ctx.graph.callers(symbol)
          .filter((edge) => edge.source)
          .map((edge) => ({ ...edge, from: symbolId(edge.source!), to: symbolId(edge.target) })) as never;
      },
      literal(opts) {
        const query = opts ?? {};
        const declarations = declarationIndex();
        // Read the pre-warmed type map (set by prewarmTypeFacts). The map only ever
        // contains facts from a `ready` producer; when pre-warm was skipped or the
        // producer was not ready, there are no surrounding types — binary, no guess.
        const typeMap = (ctx as CacheableValidationContext)[typeResolutionsSymbol];
        const literals = ctx.facts.literals();
        const cacheable = ctx as CacheableValidationContext;
        // CRITICAL1: record consumption on ACTUAL access to producer-enriched
        // data, not on "a type came back". `onSurroundingTypeAccess` fires the
        // first time a validator reads `literal.surroundingType` — even when it
        // resolves to undefined because the producer was stale/warming/crashed.
        // This is exactly when the producer-dependency warning is needed; the old
        // "a result carried surroundingType" test was blind precisely then (the
        // type map is empty when the producer is not ready, so nothing recorded).
        const markConsumed = (language: string) => {
          (cacheable[consumedTypedFactsSymbol] ??= new Set<string>()).add(language);
        };
        const results = queryLiterals(literals, typeMap ?? new Map(), declarations, query, markConsumed);
        // A `surroundingTypeName`-filtered query inherently depends on every
        // analyzed language's producer (the filter is meaningless without one),
        // regardless of which literals matched — record up front.
        if (query.surroundingTypeName !== undefined) {
          for (const literal of literals) markConsumed(literal.language);
        }
        return results as never;
      },
      producerStatus(language) {
        const statuses = (ctx as CacheableValidationContext)[producerStatusesSymbol] ?? [];
        return statuses.find((status) => status.language === language) ?? { language, kind: "not-implemented" };
      },
      producerStatuses() {
        return (ctx as CacheableValidationContext)[producerStatusesSymbol] ?? [];
      },
    },
    graph: {
      symbols() {
        return ctx.facts.symbols();
      },
      references() {
        return ctx.facts.references();
      },
      callers(symbol) {
        const targets = graphSymbolMatches(ctx.facts.symbols(), symbol);
        return graphEdges().filter((edge) => targets.includes(edge.target));
      },
      callees(symbol) {
        const sources = graphSymbolMatches(ctx.facts.symbols(), symbol);
        return graphEdges().filter((edge) => edge.source && sources.includes(edge.source));
      },
      impact(symbol) {
        const matches = graphSymbolMatches(ctx.facts.symbols(), symbol);
        return graphEdges().filter((edge) => matches.includes(edge.target) || (edge.source && matches.includes(edge.source)));
      },
    },
    impact: {
      surfaces() {
        impactSurfaceCache ??= params.paths ? loadImpactSurfaces(params.paths).surfaces : [];
        return impactSurfaceCache;
      },
      proposals() {
        proposedImpactNoteCache ??= params.paths ? loadProposedImpactNotes(params.paths).notes : [];
        return proposedImpactNoteCache;
      },
      surfacesForFiles(files) {
        return surfacesForFiles(ctx.impact.surfaces(), files.map((file) => (typeof file === "string" ? normalizePath(file) : file.path)));
      },
      downstreamOf(surfaceId) {
        const surface = ctx.impact.surfaces().find((item) => item.id === surfaceId);
        return surface?.downstream ?? [];
      },
      requiredChecks(files) {
        const filePaths = files.map((file) => (typeof file === "string" ? normalizePath(file) : file.path));
        return ctx.impact.surfacesForFiles(filePaths).map((surface) => ({
          surface,
          files: targetFiles.filter((file) => filePaths.includes(file.path) && matchesAny(file.path, surface.applies)),
          requiresTests: surface.changePolicy?.requiresTests ?? [],
          requiresDocs: surface.changePolicy?.requiresDocs ?? [],
          requiresApproval: surface.changePolicy?.requiresApproval ?? false,
          reviewers: surface.changePolicy?.reviewers ?? [],
        }));
      },
      domainEdges() {
        return buildDomainEdges(ctx.impact.surfaces());
      },
    },
    baseline: {
      all() {
        baselineCache ??= params.paths ? loadBaseline(params.paths) : { version: 1, findings: [] };
        return baselineCache;
      },
      key(finding) {
        return findingKey(finding);
      },
      isKnown(finding) {
        const key = findingKey(finding);
        return ctx.baseline.all().findings.some((item) => item.key === key);
      },
    },
    file(filePath) {
      return filesByPath.get(normalizePath(filePath));
    },
    projectFiles(patterns) {
      return patterns ? projectFiles.filter((file) => matchesAny(file.path, patterns)) : projectFiles;
    },
    byGlob(patterns) {
      return projectFiles.filter((file) => matchesAny(file.path, patterns));
    },
    text(filePath) {
      return readContextText({
        rootDir: params.rootDir,
        filePath,
        filesByPath,
        validator: params.validator,
        cache,
        profiler: params.profiler,
      });
    },
    json(filePath) {
      return readContextJson({
        rootDir: params.rootDir,
        filePath,
        filesByPath,
        validator: params.validator,
        cache,
        profiler: params.profiler,
      });
    },
    jsonFiles(patterns) {
      return listKnownContextFiles(params.rootDir, projectFiles, patterns, (file) => /\.json$/.test(file)).map((file) =>
        readContextJson({
          rootDir: params.rootDir,
          filePath: file,
          filesByPath,
          validator: params.validator,
          cache,
          profiler: params.profiler,
        }),
      );
    },
    imports() {
      importCache ??= buildImportGraph({
        rootDir: params.rootDir,
        paths: params.paths,
        files: projectFiles,
        sourceFiles: analysisFiles,
        workspace: ctx.workspace(),
      });
      return importCache;
    },
    folders() {
      folderCache ??= buildFolders(projectFiles, params.directories);
      return folderCache;
    },
    comments() {
      return analysisFiles.flatMap((file) => file.comments().map((comment) => ({ ...comment, file })));
    },
    workspace() {
      workspaceCache ??= buildWorkspaceGraph(params.rootDir, projectFiles, () => ctx.imports());
      return workspaceCache;
    },
    tree(definition) {
      return validateTree(ctx, definition);
    },
    report(input) {
      return {
        validatorId: params.validator.id,
        severity: params.validator.severity,
        ...input,
      };
    },
    commitGate(input) {
      const gate = {
        validatorId: params.validator.id,
        ...input,
      };
      if (!input.question.trim()) {
        ctx[commitGateDiagnosticsSymbol]?.push(`Commit gate ${input.id} from validator ${params.validator.id} needs a non-empty question.`);
        return gate;
      }
      ctx[commitGatesSymbol]?.push(gate);
      return gate;
    },
  };
  function graphEdges(): ProjectGraphEdge[] {
    graphEdgeCache ??= buildGraphEdges(ctx.facts.symbols(), ctx.facts.references());
    return graphEdgeCache;
  }
  function declarationIndex(): DeclarationIndex {
    declarationIndexCache ??= new DeclarationIndex(ctx.facts.literals());
    return declarationIndexCache;
  }
  function sourceTexts(): Map<string, string> {
    let texts = (ctx as CacheableValidationContext)[analysisSourceTextsSymbol];
    if (texts) return texts;
    texts = new Map<string, string>();
    for (const file of analysisFiles) {
      if (file.language !== ProjectFileLanguage.TypeScript && file.language !== ProjectFileLanguage.Svelte) continue;
      texts.set(file.path, file.text);
    }
    (ctx as CacheableValidationContext)[analysisSourceTextsSymbol] = texts;
    return texts;
  }
  // Eagerly populate source texts so a module-level `prewarmContextTypeFacts`
  // can read them without depending on a prior literal query.
  sourceTexts();
  ctx[flushCacheSymbol] = () => cache?.flush();
  ctx[commitGatesSymbol] = [];
  ctx[commitGateDiagnosticsSymbol] = [];
  return ctx;
}

export function flushValidationContextCache(ctx: ValidationContext): void {
  (ctx as CacheableValidationContext)[flushCacheSymbol]?.();
  (ctx as CacheableValidationContext)[fixtureCleanupSymbol]?.();
}

export function commitGatesFromValidationContext(ctx: ValidationContext): CommitGate[] {
  return (ctx as CacheableValidationContext)[commitGatesSymbol] ?? [];
}

export function commitGateDiagnosticsFromValidationContext(ctx: ValidationContext): string[] {
  return (ctx as CacheableValidationContext)[commitGateDiagnosticsSymbol] ?? [];
}

/**
 * Languages whose producer-resolved type facts the validator consumed via
 * `ctx.typed.literal(...)` during its run. Empty when the validator never
 * touched producer-resolved type info. Read by the pipeline to detect a
 * forgetful author who omitted `requiresProducers` for a non-ready producer.
 */
export function consumedTypedFactsFromValidationContext(ctx: ValidationContext): string[] {
  return [...((ctx as CacheableValidationContext)[consumedTypedFactsSymbol] ?? [])];
}

export function createValidationContextFromFixture(params: {
  rootDir: string;
  validator: Pick<Validator, "id" | "severity">;
  directories?: string[];
  targetFiles?: string[];
  analysisFiles?: string[];
}): ValidationContext {
  const files = listFiles(params.rootDir, isSupportedSourceFile).map((file) => relative(params.rootDir, file));
  const paths = createPaths(params.rootDir);
  return createValidationContext({
    rootDir: params.rootDir,
    paths,
    files,
    directories: params.directories,
    targetFiles: params.targetFiles ?? files,
    analysisFiles: params.analysisFiles,
    cache: null,
    validator: params.validator,
  });
}

export async function createValidationContextFromFixtureFile(params: {
  fixtureFile: string;
  validator: Pick<Validator, "id" | "severity">;
}): Promise<ValidationContext> {
  const fixture = await materializeFixture(params.fixtureFile);
  const ctx = createValidationContextFromFixture({
    rootDir: fixture.rootDir,
    validator: params.validator,
    directories: fixture.directories,
    targetFiles: fixture.targetFiles,
    analysisFiles: fixture.analysisFiles,
  });
  (ctx as CacheableValidationContext)[fixtureCleanupSymbol] = fixture.cleanup;
  return ctx;
}

export type { FixtureDefinition };

function surfacesForFiles(surfaces: ImpactSurface[], files: string[]): ImpactSurface[] {
  return surfaces.filter((surface) => files.some((file) => matchesAny(file, surface.applies)));
}

function buildGraphEdges(symbols: ProjectSymbolFact[], references: ProjectReferenceFact[]): ProjectGraphEdge[] {
  const byName = new Map<string, ProjectSymbolFact[]>();
  for (const symbol of symbols) {
    byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol]);
  }
  return references
    .filter((reference) => reference.kind === "call" || reference.kind === "identifier")
    .flatMap((reference) => {
      const targets = byName.get(reference.targetName ?? reference.name) ?? [];
      if (targets.length === 0) return [];
      const source = nearestPriorSymbol(symbols, reference.file.path, reference.line);
      return targets
        .filter((target) => source !== target)
        .map((target) => ({
          source,
          target,
          reference,
          kind: reference.kind === "call" ? ("call" as const) : ("reference" as const),
          confidence: targets.length === 1 ? ("exact" as const) : ("ambiguous" as const),
        }));
    });
}

function graphSymbolMatches(symbols: ProjectSymbolFact[], symbol: string | ProjectSymbolFact): ProjectSymbolFact[] {
  if (typeof symbol !== "string") return [symbol];
  return symbols.filter((item) => item.name === symbol || symbolId(item) === symbol || `${item.file.path}#${item.name}` === symbol);
}

function symbolId(symbol: ProjectSymbolFact): string {
  return `${symbol.file.path}#${symbol.name}:${symbol.line}`;
}

function nearestPriorSymbol(symbols: ProjectSymbolFact[], file: string, line: number): ProjectSymbolFact | undefined {
  return symbols
    .filter((symbol) => symbol.file.path === file && symbol.line <= line)
    .sort((left, right) => right.line - left.line)[0];
}

function buildDomainEdges(surfaces: ImpactSurface[]): DomainEdge[] {
  return surfaces.flatMap((surface) => [
    ...(surface.owns ?? []).map((target) => ({ from: surface.id, to: target, kind: "owns" as const, surfaceId: surface.id })),
    ...(surface.dependsOn ?? []).map((target) => ({ from: surface.id, to: target, kind: "depends-on" as const, surfaceId: surface.id })),
    ...(surface.downstream ?? []).map((target) => ({ from: surface.id, to: target, kind: "downstream" as const, surfaceId: surface.id })),
  ]);
}

function buildFolders(files: ProjectFile[], directories: string[] = []): FolderInfo[] {
  const folders = new Map<string, Set<string>>();
  for (const directory of directories) {
    const normalized = normalizePath(directory).replace(/\/+$/, "");
    if (normalized.length === 0 || normalized === ".") continue;
    const parts = normalized.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const folder = parts.slice(0, index).join("/");
      folders.set(folder, folders.get(folder) ?? new Set<string>());
    }
  }
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const folder = parts.slice(0, index).join("/");
      const folderFiles = folders.get(folder) ?? new Set<string>();
      folderFiles.add(file.path);
      folders.set(folder, folderFiles);
    }
  }
  return [...folders.entries()]
    .sort()
    .map(([folder, folderFiles]) => ({
      path: folder,
      depth: folder.split("/").length,
      fileCount: folderFiles.size,
      empty: folderFiles.size === 0,
    }));
}
