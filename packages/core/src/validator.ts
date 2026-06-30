import { existsSync } from "node:fs";
import path from "node:path";
import type { AnalysisCache } from "./cache.ts";
import { getAnalysisCache } from "./cache.ts";
import type { Area } from "./area.ts";
import { areaDocsReference } from "./area-render.ts";
import type { Change } from "./change.ts";
import { changeDocsReference } from "./change-render.ts";
import type { Baseline, ContextPaths, ImpactSurface, ProposedImpactNote } from "./core.ts";
import { ConventionRenderKind, ConventionRenderStyle, ConventionRuntimeKind, defineConvention, type Applies, type Convention, type Render } from "./convention.ts";
import { conventionDocsReference } from "./convention-render.ts";
import { createPaths, discoverProjectFiles, explainGlobMatches, listFiles, listProjectFiles, matchesAny, normalizePath, relative } from "./core.ts";
import { loadBaseline, loadImpactSurfaces, loadProposedImpactNotes } from "./core.ts";
import { definitionTargetFiles } from "./definition-target.ts";
import type { Profiler } from "./profiler.ts";
import type { Spec } from "./spec.ts";
import { specDocsReference } from "./spec-render.ts";
import { createProjectFile, loadProjectFiles } from "./project-files.ts";
import { isSupportedSourceFile } from "./discovery.ts";
import { ProjectFileLanguage } from "./language-registry.ts";
import { listKnownContextFiles, readContextJson, readContextText } from "./context-readers.ts";
import { buildImportGraph, buildWorkspaceGraph } from "./workspace.ts";
import { buildAnnotationFacts, buildCallFacts, buildDiagnosticFacts, buildDuplicateFacts, buildExportFacts, buildLiteralFacts, buildReferenceFacts, buildSymbolFacts } from "./facts.ts";
import {
  SidecarTypeFactsProvider,
  DeclarationIndex,
  readSidecarPayloadDetailed,
  sidecarStatusFromRead,
  queryLiterals,
  comparisonSites,
  siteKey,
  pickAuthoritativeStatus,
  ProducerStatusKind,
  type TypeFactsProvider,
  type ProducerStatus,
  type TypeResolution,
  type TypeSite,
  type SidecarPayload,
} from "./language-analyzer.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
export { SidecarTypeFactsProvider, DeclarationIndex, readSidecarPayloadDetailed, sidecarStatusFromRead, queryLiterals, siteKey, comparisonSites, asFiniteLiteralSet, finiteLiteralIncludes, pickAuthoritativeStatus, ProducerStatusKind, TypeResolutionKind } from "./language-analyzer.ts";
export type { TypeFactsProvider, TypeSource, TypeSite, TypeResolution, LiteralValue, LiteralMember, LiteralUnionSyntax, FiniteLiteralSet, ProducerStatus, ProducerWarning, ProducerSnapshot, ProducerSnapshotEntry, ResolvedLiteralFact, SidecarEntry, SidecarPayload, SidecarSourceFile, SidecarCoverage, SidecarReadResult, SymbolId, LiteralQuery } from "./language-analyzer.ts";
import { findingKey } from "./findings.ts";
import { validateTree } from "./tree.ts";
import { materializeFixture, type FixtureDefinition } from "./testing.ts";

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
  RuntimeDefinition,
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
const typeResolutionsSymbol = Symbol("opencanon.typeResolutions");
// Resolved per-language producer statuses for this run, stored on the context by
// the pre-warm and read synchronously by `ctx.typed.producerStatus(...)`.
const producerStatusesSymbol = Symbol("opencanon.producerStatuses");
// Languages whose producer-resolved type facts a validator actually consumed via
// `ctx.typed.literal(...)` during its run. The validation pipeline reads
// this after `validate()` to detect a forgetful author who consumed typed facts
// for a non-ready producer without declaring `requiresProducers`.
const consumedTypedFactsSymbol = Symbol("opencanon.consumedTypedFacts");
// Source texts of this context's analysis files (TS/Svelte), retained for
// callers that want raw text. Typed facts come only from a producer, not from text.
const analysisSourceTextsSymbol = Symbol("opencanon.analysisSourceTexts");
type CacheableValidationContext = ValidationContext & {
  [flushCacheSymbol]?: () => void;
  [commitGatesSymbol]?: CommitGate[];
  [commitGateDiagnosticsSymbol]?: string[];
  [fixtureCleanupSymbol]?: () => void;
  [typeResolutionsSymbol]?: Map<string, TypeResolution>;
  [producerStatusesSymbol]?: ProducerStatus[];
  [consumedTypedFactsSymbol]?: Set<string>;
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

export function createRuntime(
  paths: ContextPaths,
  conventions: Convention[] = [],
  definitions: { areas?: Area[]; specs?: Spec[]; changes?: Change[] } = {},
): ValidatorRuntime {
  const runtimeConventions = conventions.map(conventionAsRuntimeConvention);
  const runtimeDefinitions = {
    specs: (definitions.specs ?? []).map((spec) => specAsRuntimeDefinition(paths.rootDir, paths.specsPath, spec)),
    areas: (definitions.areas ?? []).map((area) => areaAsRuntimeDefinition(paths.rootDir, paths.areasPath, area)),
    changes: (definitions.changes ?? []).map((change) => changeAsRuntimeDefinition(paths.rootDir, paths.changesPath, change)),
    conventions: conventions.map((convention) => conventionAsRuntimeDefinition(paths.rootDir, paths.conventionsPath, convention)),
  };
  let projectFileCache: string[] | undefined;
  let impactSurfaceCache: ImpactSurface[] | undefined;
  const allDefinitions = () => [
    ...runtimeDefinitions.specs,
    ...runtimeDefinitions.areas,
    ...runtimeDefinitions.changes,
    ...runtimeDefinitions.conventions,
  ];
  const projectFiles = () => {
    projectFileCache ??= listProjectFiles(paths);
    return projectFileCache;
  };
  const impactSurfaces = () => {
    impactSurfaceCache ??= loadImpactSurfaces(paths).surfaces;
    return impactSurfaceCache;
  };
  const definitionFor = (kind: RuntimeDefinition["kind"], id: string) => allDefinitions().find((definition) => definition.kind === kind && definition.id === id);
  const definitionsForFile = (file: string) => {
    const normalized = normalizePath(file);
    return allDefinitions().filter((definition) => definition.targetFiles.some((target) => target === normalized || matchesAny(normalized, [target])));
  };
  const directConventionsForFile = (file: string) => {
    const normalized = normalizePath(file);
    return runtimeConventions.filter((convention) => convention.applies.some((target) => target === normalized || matchesAny(normalized, [target])));
  };
  const surfacesForFile = (file: string) => {
    const normalized = normalizePath(file);
    return impactSurfaces().filter((surface) => matchesAny(normalized, surface.applies));
  };
  const governingConventionsForFile = (file: string) => {
    const linkedIds = surfacesForFile(file).flatMap((surface) => surface.conventionIds ?? []);
    const linked = runtimeConventions.filter((convention) => linkedIds.includes(convention.id));
    return uniqueRuntimeConventions([...directConventionsForFile(file), ...linked]);
  };
  const conventionsForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    if (!surface) return [];
    const linkedIds = new Set(surface.conventionIds ?? []);
    const surfaceFiles = filesForSurface(surfaceId);
    const linked = runtimeConventions.filter((convention) => linkedIds.has(convention.id));
    const inferred = surfaceFiles.flatMap((file) => directConventionsForFile(file));
    return uniqueRuntimeConventions([...linked, ...inferred]);
  };
  const filesForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    return surface ? projectFiles().filter((file) => matchesAny(file, surface.applies)) : [];
  };
  const definitionsForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    if (!surface) return [];
    const surfaceFiles = filesForSurface(surfaceId);
    return allDefinitions().filter((definition) =>
      definition.surfaces.includes(surfaceId) ||
      definition.targetFiles.some((target) => surfaceFiles.some((file) => target === file || matchesAny(file, [target]))),
    );
  };
  const checksForDefinition = (kind: RuntimeDefinition["kind"], id: string) => definitionFor(kind, id)?.checkIds ?? [];
  const checksForSurface = (surfaceId: string) => {
    const surface = impactSurfaces().find((candidate) => candidate.id === surfaceId);
    const definitionChecks = definitionsForSurface(surfaceId).flatMap((definition) => definition.checkIds);
    const policyChecks = [
      ...(surface?.changePolicy?.requiresTests ?? []),
      ...(surface?.changePolicy?.requiresDocs ?? []),
    ];
    return uniqueStrings([...definitionChecks, ...policyChecks]);
  };
  return {
    rootDir: paths.rootDir,
    paths,
    conventions: {
      all: runtimeConventions,
      byId(id) {
        return runtimeConventions.find((convention) => convention.id === id);
      },
      byTopic(topic) {
        return runtimeConventions.filter((convention) => convention.topics.includes(topic));
      },
    },
    definitions: {
      ...runtimeDefinitions,
      all() {
        return allDefinitions();
      },
      byId(kind, id) {
        return definitionFor(kind, id);
      },
    },
    context: {
      definitionsForFile(file) {
        return definitionsForFile(file);
      },
      governingConventionsForFile(file) {
        return governingConventionsForFile(file);
      },
      surfacesForFile(file) {
        return surfacesForFile(file);
      },
      coverageForFile(file) {
        const normalized = normalizePath(file);
        const definitions = definitionsForFile(normalized);
        const conventions = governingConventionsForFile(normalized);
        const surfaces = surfacesForFile(normalized);
        const checks = uniqueStrings([
          ...definitions.flatMap((definition) => definition.checkIds),
          ...surfaces.flatMap((surface) => checksForSurface(surface.id)),
        ]);
        return {
          file: normalized,
          definitions,
          conventions,
          surfaces,
          checks,
          governed: definitions.length + conventions.length + surfaces.length > 0,
        };
      },
      filesForDefinition(kind, id) {
        return definitionFor(kind, id)?.targetFiles ?? [];
      },
      checksForDefinition(kind, id) {
        return checksForDefinition(kind, id);
      },
      filesForSurface(surfaceId) {
        return filesForSurface(surfaceId);
      },
      definitionsForSurface(surfaceId) {
        return definitionsForSurface(surfaceId);
      },
      conventionsForSurface(surfaceId) {
        return conventionsForSurface(surfaceId);
      },
      checksForSurface(surfaceId) {
        return checksForSurface(surfaceId);
      },
    },
    matches(file, globs) {
      return matchesAny(file, globs);
    },
    globs: {
      matches(file, patterns) {
        return matchesAny(file, patterns);
      },
      explain(file, patterns) {
        return explainGlobMatches(file, patterns);
      },
    },
    naming: {
      isPascalCase(value) {
        return /^[A-Z][A-Za-z0-9]*$/.test(value);
      },
      isCamelCase(value) {
        return /^[a-z][A-Za-z0-9]*$/.test(value);
      },
      isKebabCase(value) {
        return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
      },
      isSnakeCase(value) {
        return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value);
      },
      isScreamingSnakeCase(value) {
        return /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(value);
      },
    },
  };
}

function uniqueRuntimeConventions(conventions: ValidatorRuntime["conventions"]["all"]): ValidatorRuntime["conventions"]["all"] {
  const seen = new Set<string>();
  const result: ValidatorRuntime["conventions"]["all"] = [];
  for (const convention of conventions) {
    if (seen.has(convention.id)) continue;
    seen.add(convention.id);
    result.push(convention);
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function conventionAsRuntimeConvention(convention: Convention): ValidatorRuntime["conventions"]["all"][number] {
  return {
    id: convention.id,
    title: convention.title,
    topics: convention.topics ?? [],
    applies: conventionAppliesGlobs(convention),
    summary: convention.rule,
    docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
    validatorIds: convention.runtime.kind === ConventionRuntimeKind.None ? [] : [convention.id],
    rationale: convention.why ? [convention.why] : [],
    examples: (convention.examples ?? []).flatMap((example) => [example.good, example.bad, example.note].filter((item): item is string => Boolean(item))),
  };
}

function conventionAppliesGlobs(convention: Convention): string[] {
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return convention.applies.globs;
    case "imports":
      return [...(convention.applies.from ?? []), ...(convention.applies.to ?? [])];
    case "impact-surface":
      return convention.applies.surfaceIds;
    case "definitions":
      return convention.applies.definitions.flatMap((target) => (target.ids ?? []).map((id) => `${target.kind}:${id}`));
    case "project":
      return [convention.applies.describe ?? "project"];
    case "custom":
      return [convention.applies.describe];
  }
}

function specAsRuntimeDefinition(rootDir: string, specsPath: string, spec: Spec): ValidatorRuntime["definitions"]["specs"][number] {
  return {
    kind: "spec",
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    docs: spec.render.kind === "none" ? [] : [specDocsReference(spec)!],
    source: `${relative(rootDir, specsPath)}#${spec.id}`,
    surfaces: spec.surfaces ?? [],
    conventionIds: spec.governedBy?.conventions ?? [],
    checkIds: (spec.checks ?? []).map((check) => check.id),
    targetFiles: definitionTargetFiles(spec.scope),
  };
}

function areaAsRuntimeDefinition(rootDir: string, areasPath: string, area: Area): ValidatorRuntime["definitions"]["areas"][number] {
  return {
    kind: "area",
    id: area.id,
    title: area.title,
    summary: area.summary,
    docs: area.render.kind === "none" ? [] : [areaDocsReference(area)!],
    source: `${relative(rootDir, areasPath)}#${area.id}`,
    surfaces: area.surfaces ?? [],
    conventionIds: area.governedBy?.conventions ?? [],
    checkIds: (area.checks ?? []).map((check) => check.id),
    targetFiles: definitionTargetFiles(area.owns),
  };
}

function changeAsRuntimeDefinition(rootDir: string, changesPath: string, change: Change): ValidatorRuntime["definitions"]["changes"][number] {
  return {
    kind: "change",
    id: change.id,
    title: change.title,
    summary: change.summary ?? change.intent.outcome,
    docs: change.render.kind === "none" ? [] : [changeDocsReference(change)!],
    source: `${relative(rootDir, changesPath)}#${change.id}`,
    surfaces: change.updates?.surfaces ?? [],
    conventionIds: change.updates?.conventions ?? [],
    checkIds: (change.checks ?? []).map((check) => check.id),
    targetFiles: definitionTargetFiles(change.scope),
  };
}

function conventionAsRuntimeDefinition(rootDir: string, conventionsPath: string, convention: Convention): ValidatorRuntime["definitions"]["conventions"][number] {
  return {
    kind: "convention",
    id: convention.id,
    title: convention.title,
    summary: convention.rule,
    docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
    source: `${relative(rootDir, conventionsPath)}#${convention.id}`,
    surfaces: convention.impactSurfaces ?? [],
    conventionIds: convention.related ?? [],
    checkIds: convention.runtime.kind === ConventionRuntimeKind.None ? [] : [convention.id],
    targetFiles: convention.applies.kind === "files" || convention.applies.kind === "symbols" ? convention.applies.globs : [],
  };
}

export function createValidationContext(params: {
  rootDir: string;
  paths?: ContextPaths;
  files?: string[];
  directories?: string[];
  targetFiles?: string[];
  analysisFiles?: string[];
  project?: boolean;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache | null;
  profiler?: Profiler;
}): ValidationContext {
  const cache = params.cache === null ? undefined : (params.cache ?? (params.paths ? getAnalysisCache(params.paths) : undefined));
  const projectFiles = loadProjectFiles(params.rootDir, params.files, params.validator, params.paths, cache, params.profiler);
  const knownFiles = new Set(projectFiles.map((file) => file.path));
  for (const targetFile of params.targetFiles ?? []) {
    if (knownFiles.has(normalizePath(targetFile))) continue;
    if (!isSupportedSourceFile(targetFile)) continue;
    if (!existsSync(path.join(params.rootDir, targetFile))) continue;
    const file = createProjectFile({ rootDir: params.rootDir, file: targetFile, validator: params.validator, cache, profiler: params.profiler });
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

/**
 * OPENCANON_TYPED_PRODUCER=off|0|false disables the TypeScript producer entirely.
 * Folded into status: a disabled producer reports `{kind:"disabled"}` and serves
 * no facts. Mirrors the runtime's env check so both paths agree.
 */
function typescriptProducerDisabledByEnv(): boolean {
  const value = (process.env.OPENCANON_TYPED_PRODUCER ?? "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

/**
 * Compute the headless TypeScript producer's status for a project, from the
 * sidecar freshness machinery + setup probes (tsconfig present, typescript
 * resolvable). Single source of truth for the sidecar-backed status surface.
 */
export function resolveTypeScriptSidecarStatus(rootDir: string): { status: ProducerStatus; payload: SidecarPayload | null } {
  if (typescriptProducerDisabledByEnv()) {
    return {
      status: { language: "typescript", kind: "disabled", detail: "OPENCANON_TYPED_PRODUCER is set to off." },
      payload: null,
    };
  }
  const sidecarPath = path.join(rootDir, ".opencanon", "cache", "typed-comparisons.json");
  const read = readSidecarPayloadDetailed(sidecarPath, {
    rootDir,
    tsconfigHash: (tsconfigRelPath: string) => typedSidecarTsconfigHash(rootDir, tsconfigRelPath),
    tsVersion: () => installedTypeScriptVersion(rootDir),
    membershipHash: membershipHashOf(listMembershipFiles(rootDir)),
  });
  const status = sidecarStatusFromRead(read, {
    hasTsconfig: existsSync(path.join(rootDir, "tsconfig.json")),
    hasTypeScript: installedTypeScriptVersion(rootDir) !== null,
  });
  return { status, payload: read.payload };
}

/**
 * Select the headless type-facts provider for a project: a
 * `SidecarTypeFactsProvider` whose `status()` reflects the sidecar freshness
 * machinery (ready / stale / missing-package / missing-tsconfig / disabled). The
 * provider serves facts only when `ready` — binary, no degraded mode.
 */
export function resolveTypeFactsProvider(rootDir: string): TypeFactsProvider {
  const { status, payload } = resolveTypeScriptSidecarStatus(rootDir);
  return new SidecarTypeFactsProvider(payload, status);
}

/**
 * Resolve every known per-language producer's status for a run, decoupled from a
 * live validation context. Consults the live producer factory (runtime) when
 * installed; otherwise the headless sidecar producer. Backs `--require-producer`,
 * `doctor`, and `project status`. TypeScript is the only implemented language.
 */
export function resolveProducerStatuses(rootDir: string): ProducerStatus[] {
  return [resolveAuthoritativeProducerStatus(rootDir, "typescript").status];
}

export function normalizeProducerStatusesForProject(input: {
  paths: ContextPaths;
  validators?: Array<Pick<Validator, "requiresProducers">>;
  producers?: ProducerStatus[];
}): ProducerStatus[] {
  const producers = input.producers ?? resolveProducerStatuses(input.paths.rootDir);
  const requiredLanguages = new Set((input.validators ?? []).flatMap((validator) => validator.requiresProducers));
  const hasUserTypeScript = projectHasUserTypeScript(input.paths);
  return producers.map((status) => {
    if (status.language !== "typescript") return status;
    if (status.kind === ProducerStatusKind.Ready) return status;
    if (hasUserTypeScript || requiredLanguages.has("typescript")) return status;
    return {
      language: status.language,
      kind: ProducerStatusKind.NotImplemented,
      detail: "No root tsconfig.json or user TypeScript source files were discovered.",
    };
  });
}

function projectHasUserTypeScript(paths: ContextPaths): boolean {
  if (existsSync(path.join(paths.rootDir, "tsconfig.json"))) return true;
  const discovery = discoverProjectFiles(paths, (file) => /\.(?:ts|tsx|mts|cts)$/u.test(file));
  if (discovery.failed) return true;
  return discovery.files.some((file) => isUserTypeScriptFile(paths, file));
}

function isUserTypeScriptFile(paths: ContextPaths, file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (!/\.(?:ts|tsx|mts|cts)$/u.test(normalized)) return false;
  return !authoringPrefixes(paths).some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function authoringPrefixes(paths: ContextPaths): string[] {
  const sourceDirs = [
    path.dirname(paths.conventionsPath),
    path.dirname(paths.areasPath),
    path.dirname(paths.specsPath),
    path.dirname(paths.changesPath),
    paths.fixturesDir,
    path.join(paths.rootDir, ".opencanon"),
    path.join(paths.rootDir, ".agents"),
  ];
  return [...new Set(sourceDirs.map((dir) => relative(paths.rootDir, dir).replace(/\\/g, "/")).filter((dir) => dir && dir !== "."))];
}

/**
 * THE single authoritative producer-availability resolver for one language.
 * Every surface (skip logic, /api/producers, --require-producer, doctor, UI)
 * reads THIS — no independent re-resolution anywhere. Builds the candidate set
 * (the live producer when its factory is installed, plus the sidecar ONLY when
 * there is no live producer) and runs `pickAuthoritativeStatus` over it. Because
 * a live ready/warming/crashed status outranks every sidecar state by
 * precedence, a stale sidecar can never beat a ready live producer.
 * Returns the chosen status plus the live provider that won (so the caller can
 * query it for facts), or the sidecar provider when no live producer exists.
 */
export function resolveAuthoritativeProducerStatus(
  rootDir: string,
  language: string,
): { status: ProducerStatus; provider: TypeFactsProvider } {
  const live = language === "typescript" ? liveTypeFactsProviderFactory?.(rootDir) ?? null : null;
  if (live) {
    // A live producer exists: it is authoritative. We do NOT consult the sidecar
    // (precedence would pick the live status regardless; skipping the read avoids
    // a needless sidecar parse and any disagreement surfaces as the live status).
    return { status: live.status(), provider: live };
  }
  if (language !== "typescript") {
    const status: ProducerStatus = { language, kind: "not-implemented" };
    return { status, provider: notImplementedProvider(language) };
  }
  const sidecar = resolveTypeFactsProvider(rootDir);
  return { status: pickAuthoritativeStatus([sidecar.status()]), provider: sidecar };
}

function notImplementedProvider(language: string): TypeFactsProvider {
  return {
    language,
    status: () => ({ language, kind: "not-implemented" }),
    // No producer registered: no facts, hence no fact generation.
    factGeneration: () => undefined,
    resolveTypes: () => Promise.resolve(new Map()),
  };
}

/**
 * Async batch pre-warm: collect every comparison literal site from the context's
 * facts, resolve them once through `provider`, and cache the result map on the
 * context (keyed by `siteKey`). After this runs, `ctx.typed.literal()` reads the
 * map synchronously — the validation pipeline awaits this before validators run.
 * Idempotent; safe to call once per context.
 */
export async function prewarmTypeFacts(ctx: ValidationContext, provider: TypeFactsProvider): Promise<void> {
  const sites = comparisonSites(ctx.facts.literals());
  let map: Map<string, TypeResolution>;
  let status: ProducerStatus;
  try {
    map = await provider.resolveTypes(sites);
    status = provider.status();
  } catch (error) {
    status = producerCrashedStatus(provider, error);
    console.warn(`[opencanon] type-facts provider failed; ${provider.language} producer status is crashed: ${status.detail}`);
    map = new Map();
  }
  // H1: snapshot status AFTER awaiting resolveTypes — including the
  // success-but-empty path. A live producer that crashed DURING this query sets
  // its crash state before resolveTypes resolves, so `status()` now reports
  // `crashed`. Capturing it before would record a stale `ready`, letting
  // `requiresProducers` validators run against no facts.
  (ctx as CacheableValidationContext)[typeResolutionsSymbol] = map;
  (ctx as CacheableValidationContext)[producerStatusesSymbol] = [status];
}

/** Install an already-resolved type-facts map (and producer statuses) onto a context (shared per-run pre-warm). */
export function installContextTypeFacts(ctx: ValidationContext, map: Map<string, TypeResolution>, statuses: ProducerStatus[]): void {
  (ctx as CacheableValidationContext)[typeResolutionsSymbol] = map;
  (ctx as CacheableValidationContext)[producerStatusesSymbol] = statuses;
}

/**
 * Shared per-run type facts: the resolved site map, each producer's status
 * (availability), and `factGenerations` — the generation each language's facts
 * were ACTUALLY computed from, taken from the provider's `factGeneration()`
 * (bound atomically with the facts, not sampled from a racing `status` event).
 * `producerSnapshot` binds its generation from `factGenerations`, its `kind`
 * from `statuses`.
 */
export type RunTypeFacts = { map: Map<string, TypeResolution>; statuses: ProducerStatus[]; factGenerations: Record<string, number | undefined> };

/**
 * Resolve the UNION of every context's comparison sites a SINGLE time and return
 * one shared `Map<siteKey, TypeResolution>` plus the producer statuses. The
 * provider is selected once (the live factory if installed, else the headless
 * sidecar producer) and queried with the deduplicated site set — one batch
 * instead of one-RPC-per-validator. A provider failure resolves to an empty fact
 * map with an explicit `crashed` producer status, so required validators skip
 * loudly instead of running against missing facts.
 */
export async function resolveRunTypeFacts(contexts: ValidationContext[], rootDir: string): Promise<RunTypeFacts> {
  // Single authoritative resolution: the live producer when installed, else the
  // sidecar (precedence kills any stale-sidecar-vs-live disagreement). No
  // independent re-resolution — `resolveAuthoritativeProducerStatus` is the one
  // source every surface shares.
  const { provider } = resolveAuthoritativeProducerStatus(rootDir, "typescript");
  // H1: status is captured AFTER the query (below), never before — a producer
  // that crashes DURING this run's resolveTypes must report `crashed` to the skip
  // logic so `requiresProducers` validators skip loudly instead of running
  // silently against an empty map.
  if (contexts.length === 0) {
    const status = provider.status();
    // No query happened, so no facts were used: report the producer's current
    // generation (never newer than facts, because there are none).
    return { map: new Map(), statuses: [status], factGenerations: { [provider.language]: provider.factGeneration() ?? status.generation ?? 0 } };
  }
  // Union of comparison sites across all contexts, deduplicated by siteKey.
  const byKey = new Map<string, TypeSite>();
  for (const ctx of contexts) {
    for (const site of comparisonSites(ctx.facts.literals())) {
      byKey.set(siteKey(site.file, site.line, site.column), site);
    }
  }
  try {
    const map = await provider.resolveTypes([...byKey.values()]);
    // factGeneration() is set synchronously by resolveTypes from the facts it
    // just used — read it now, BEFORE any later status() can race ahead. This is
    // the generation bound to producerSnapshot; status() supplies only `kind`.
    const factGeneration = provider.factGeneration();
    return {
      map,
      statuses: [provider.status()],
      factGenerations: { [provider.language]: factGeneration },
    };
  } catch (error) {
    const status = producerCrashedStatus(provider, error);
    console.warn(`[opencanon] type-facts provider failed; ${provider.language} producer status is crashed: ${status.detail}`);
    return { map: new Map(), statuses: [status], factGenerations: { [provider.language]: provider.factGeneration() } };
  }
}

function producerCrashedStatus(provider: TypeFactsProvider, error: unknown): ProducerStatus {
  const existing = provider.status();
  const status: ProducerStatus = {
    language: provider.language,
    kind: ProducerStatusKind.Crashed,
    detail: error instanceof Error ? error.message : String(error),
  };
  const generation = provider.factGeneration() ?? existing.generation;
  if (generation !== undefined) status.generation = generation;
  if (existing.warnings && existing.warnings.length > 0) status.warnings = existing.warnings;
  return status;
}

/**
 * Module-level injection seam for a LIVE type-facts provider. The
 * project runtime owns a long-lived TypeScript type-producer child process and registers
 * a provider factory here at startup; `prewarmContextTypeFacts` consults it
 * BEFORE falling back to the sidecar `resolveTypeFactsProvider`. Core stays
 * free of any `typescript`/child-process import — it only calls back through this
 * factory, which the project runtime (the only code that imports `typescript`) supplies.
 *
 * Headless CLI runs never set this, so they keep the sidecar
 * default. The factory may return `null` to opt out for a given root (e.g. no
 * tsconfig), in which case the default path runs.
 */
export type TypeFactsProviderFactory = (rootDir: string) => TypeFactsProvider | null;
let liveTypeFactsProviderFactory: TypeFactsProviderFactory | undefined;

/** Runtime-only: install (or clear) the live type-facts provider factory. */
export function setLiveTypeFactsProviderFactory(factory: TypeFactsProviderFactory | undefined): void {
  liveTypeFactsProviderFactory = factory;
}

/**
 * Build the project's type-facts provider from a context's analysis files and
 * pre-warm the context with it. Convenience wrapper for validation entry points.
 *
 * Provider precedence: an explicit `providerOverride`, then the runtime's live
 * provider factory (if installed and it returns a provider), then the default
 * sidecar `resolveTypeFactsProvider`.
 */
export async function prewarmContextTypeFacts(
  ctx: ValidationContext,
  rootDir: string,
  providerOverride?: TypeFactsProvider,
): Promise<void> {
  const provider = providerOverride ?? resolveAuthoritativeProducerStatus(rootDir, "typescript").provider;
  await prewarmTypeFacts(ctx, provider);
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

export function typedSidecarTsconfigHash(rootDir: string, tsconfigRelPath: string = "tsconfig.json"): string {
  const candidate = path.isAbsolute(tsconfigRelPath) ? tsconfigRelPath : path.join(rootDir, tsconfigRelPath);
  if (!existsSync(candidate)) return "";
  try {
    return createHash("sha256").update(readFileSync(candidate, "utf8")).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Read the installed `typescript` package version without importing the module
 * (keeps core runtime-cheap). Returns null when not resolvable — callers treat
 * that as "can't verify", not "stale".
 */
export function installedTypeScriptVersion(rootDir: string): string | null {
  const candidates = [
    path.join(rootDir, "node_modules", "typescript", "package.json"),
    path.join(process.cwd(), "node_modules", "typescript", "package.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const MembershipExtensions = /\.(ts|tsx|mts|cts)$/;

/**
 * Hash the sorted set of type-relevant files (git-tracked TS/TSX/d.ts, minus
 * node_modules). Reproducible from producer and reader without tsc. List-only —
 * content drift is caught by per-file fingerprints; this catches add/remove.
 */
export function membershipHashOf(paths: string[]): string {
  const normalized = [...new Set(paths.map((p) => p.replace(/\\/g, "/")))].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

/**
 * TS/TSX/d.ts files visible to the project (minus node_modules), repo-relative.
 * Mirrors the runtime inventory: tracked + untracked-non-ignored (`--cached
 * --others --exclude-standard`) so a NEW uncommitted ambient `.d.ts` is counted,
 * not just committed ones. Sorted for a stable membership hash.
 */
export function listMembershipFiles(rootDir: string): string[] {
  const result = spawnSync(
    "git",
    ["-C", rootDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx", "*.mts", "*.cts"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // H1: distinguish "git ran, zero files" (status 0, empty stdout — a real empty
  // set) from "git failed/absent" (non-zero). On failure, fall back to a
  // deterministic filesystem walk so producer and reader agree on the SAME set;
  // returning [] on failure made every set hash to the empty-set hash, so
  // added/removed files never invalidated the sidecar.
  if (result.status === 0) {
    return result.stdout
      .split("\0")
      .map((file) => file.trim())
      .filter((file) => file.length > 0 && MembershipExtensions.test(file) && !file.includes("node_modules/"));
  }
  return listMembershipFilesViaFs(rootDir);
}

/**
 * Deterministic non-git membership discovery for roots where git is unavailable
 * (non-git root, git not installed). Producer (`analyze --typed`) and reader use
 * the same path so their membership hashes match. Walks rootDir for TS/TSX/d.ts,
 * skips node_modules and dot-directories, repo-relative + sorted (the sort is
 * done by `membershipHashOf`).
 */
function listMembershipFilesViaFs(rootDir: string): string[] {
  const skipDir = (dir: string): boolean => {
    const base = path.basename(dir);
    return base === "node_modules" || base.startsWith(".");
  };
  return listFiles(rootDir, (file) => MembershipExtensions.test(file), skipDir)
    .map((abs) => path.relative(rootDir, abs).replace(/\\/g, "/"))
    .filter((file) => file.length > 0 && !file.includes("node_modules/"));
}
