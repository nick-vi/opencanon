import { existsSync } from "node:fs";
import path from "node:path";
import type { AnalysisCache } from "./cache.ts";
import { getAnalysisCache } from "./cache.ts";
import type { ValidatorScope } from "./contracts.ts";
import type { Baseline, ContextPaths, Decision, ImpactSurface, ProposedImpactNote } from "./core.ts";
import { createPaths, explainGlobMatches, listFiles, listProjectFiles, matchesAny, normalizePath, relative } from "./core.ts";
import { loadBaseline, loadImpactSurfaces, loadProposedImpactNotes } from "./core.ts";
import type { Profiler } from "./profiler.ts";
import { PackageJsonFileName, ProjectFileLanguage, createProjectFile, isSupportedSourceFile, loadProjectFiles, readJsonObject, readLooseJsonObject } from "./project-files.ts";
import { listKnownContextFiles, readContextJson, readContextText } from "./context-readers.ts";
import { buildImportGraph, buildWorkspaceGraph } from "./workspace.ts";
import { buildAnnotationFacts, buildCallFacts, buildDuplicateFacts, buildExportFacts, buildLiteralFacts, buildReferenceFacts, buildSymbolFacts } from "./facts.ts";
import { validateFindings, findingKey, type FindingValidationContext } from "./findings.ts";
import { formatValidatorApplies, resolveValidators, validateValidatorDefinitions, validatorMatchesAnyFile, validatorMatchesFile } from "./validator-definitions.ts";
import { validateTree } from "./tree.ts";
import type { TreeDefinition } from "./tree.ts";

export { validateFindings } from "./findings.ts";
export { formatValidatorApplies, resolveValidators, validateValidatorDefinitions, validatorMatchesAnyFile, validatorMatchesFile } from "./validator-definitions.ts";
export type {
  BaselineApi,
  DomainEdge,
  FactsApi,
  FileRead,
  FileReportInput,
  Finding,
  FindingFix,
  FixSafety,
  FolderInfo,
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
  ProjectLiteralFact,
  ProjectReferenceFact,
  ProjectSymbolFact,
  ReportInput,
  Severity,
  TextEdit,
  TextMatch,
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
  BaselineApi,
  DomainEdge,
  FactsApi,
  FileRead,
  FileReportInput,
  Finding,
  FindingFix,
  FixSafety,
  FolderInfo,
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
  ProjectLiteralFact,
  ProjectReferenceFact,
  ProjectSymbolFact,
  ReportInput,
  Severity,
  TextEdit,
  TextMatch,
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
const flushCacheSymbol = Symbol("opencanon.flushCache");
const FactKeySeparator = "\u0000";

type CacheableValidationContext = ValidationContext & {
  [flushCacheSymbol]?: () => void;
};

export type ValidatorRuntime = {
  rootDir: string;
  paths: ContextPaths;
  decisions: {
    all: Decision[];
    byId(id: string): Decision | undefined;
    byTopic(topic: string): Decision[];
  };
  matches(file: string, globs: string[]): boolean;
  globs: {
    matches(file: string, patterns: string[]): boolean;
    explain(file: string, patterns: string[]): ReturnType<typeof explainGlobMatches>;
  };
  naming: {
    isPascalCase(value: string): boolean;
    isCamelCase(value: string): boolean;
    isKebabCase(value: string): boolean;
    isSnakeCase(value: string): boolean;
    isScreamingSnakeCase(value: string): boolean;
  };
};

export type ValidatorArgs = {
  ctx: ValidationContext;
  runtime: ValidatorRuntime;
};

export type ValidatorSummaryInput = {
  id: string;
  topics: string[];
  applies: string[];
  severity: Severity;
  scope: ValidatorScope;
  facts: FactKind[];
  decisionIds: string[];
  docs: string[];
};

export type ValidatorSummary = string | ((definition: ValidatorSummaryInput) => string);

export type ValidatorVisual = {
  kind: "tree";
  title?: string;
  definition: TreeDefinition;
};

export type ValidatorDefinition = {
  id: string;
  topics?: string[];
  applies?: string[];
  severity?: Severity;
  scope?: ValidatorScope;
  facts?: FactKind[];
  decisionIds?: string[];
  docs?: string[];
  summary?: ValidatorSummary;
  visuals?: ValidatorVisual[];
  validate?(args: ValidatorArgs): Finding[] | Promise<Finding[]>;
  validators?: ValidatorDefinition[];
};

export type ValidatorFactoryBaseOptions = {
  id: string;
  topics: string[];
  severity: Severity;
  decisionIds?: string[];
  docs?: string[];
  summary?: ValidatorSummary;
};

export type ValidatorFactory<TOptions extends Record<string, unknown> = Record<string, never>> = (
  options: ValidatorFactoryBaseOptions & TOptions,
) => ValidatorDefinition;

export type Validator = {
  id: string;
  topics: string[];
  appliesScopes: string[][];
  severity: Severity;
  scope: ValidatorScope;
  facts: FactKind[];
  decisionIds: string[];
  docs: string[];
  summary?: string;
  visuals: ValidatorVisual[];
  validate(args: ValidatorArgs): Finding[] | Promise<Finding[]>;
};

export type FindingValidationContext = {
  paths: ContextPaths;
  decisionIds: Set<string>;
};

export function defineValidator(definition: ValidatorDefinition): ValidatorDefinition {
  return definition;
}

export function createValidatorFactory<TOptions extends Record<string, unknown> = Record<string, never>>(
  create: (options: ValidatorFactoryBaseOptions & TOptions) => ValidatorDefinition,
): ValidatorFactory<TOptions> {
  return (options) => {
    const definition = create(options);
    if (definition.docs !== undefined || options.docs === undefined) return defineValidator(definition);
    return defineValidator({ ...definition, docs: options.docs });
  };
}

export function createRuntime(paths: ContextPaths, decisions: Decision[]): ValidatorRuntime {
  return {
    rootDir: paths.rootDir,
    paths,
    decisions: {
      all: decisions,
      byId(id) {
        return decisions.find((decision) => decision.id === id);
      },
      byTopic(topic) {
        return decisions.filter((decision) => decision.topics.includes(topic));
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

export function createValidationContext(params: {
  rootDir: string;
  paths?: ContextPaths;
  files?: string[];
  targetFiles?: string[];
  analysisFiles?: string[];
  project?: boolean;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache;
  profiler?: Profiler;
}): ValidationContext {
  const cache = params.cache ?? (params.paths ? getAnalysisCache(params.paths) : undefined);
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
  let referenceFactCache: ProjectReferenceFact[] | undefined;
  let annotationFactCache: ProjectAnnotationFact[] | undefined;
  let diagnosticFactCache: ProjectDiagnosticFact[] | undefined;
  let duplicateFactCache: ProjectDuplicateFact[] | undefined;
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
        diagnosticFactCache ??= [];
        return diagnosticFactCache;
      },
      duplicates() {
        duplicateFactCache ??= buildDuplicateFacts(ctx.facts.literals());
        return duplicateFactCache;
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
          requiresDecision: surface.changePolicy?.requiresDecision ?? false,
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
      folderCache ??= buildFolders(projectFiles);
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
  };
  ctx[flushCacheSymbol] = () => cache?.flush();
  return ctx;
}

export function flushValidationContextCache(ctx: ValidationContext): void {
  (ctx as CacheableValidationContext)[flushCacheSymbol]?.();
}

export function createValidationContextFromFixture(params: {
  rootDir: string;
  validator: Pick<Validator, "id" | "severity">;
}): ValidationContext {
  const files = listFiles(params.rootDir, isSupportedSourceFile).map((file) => relative(params.rootDir, file));
  const paths = createPaths(params.rootDir);
  return createValidationContext({
    rootDir: params.rootDir,
    paths,
    files,
    targetFiles: files,
    validator: params.validator,
  });
}

function surfacesForFiles(surfaces: ImpactSurface[], files: string[]): ImpactSurface[] {
  return surfaces.filter((surface) => files.some((file) => matchesAny(file, surface.applies)));
}

function buildDomainEdges(surfaces: ImpactSurface[]): DomainEdge[] {
  return surfaces.flatMap((surface) => [
    ...(surface.owns ?? []).map((target) => ({ from: surface.id, to: target, kind: "owns" as const, surfaceId: surface.id })),
    ...(surface.dependsOn ?? []).map((target) => ({ from: surface.id, to: target, kind: "depends-on" as const, surfaceId: surface.id })),
    ...(surface.downstream ?? []).map((target) => ({ from: surface.id, to: target, kind: "downstream" as const, surfaceId: surface.id })),
  ]);
}

function buildFolders(files: ProjectFile[]): FolderInfo[] {
  const folders = new Map<string, Set<string>>();
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

function relativeDepth(source: string): number {
  if (!source.startsWith(".")) return 0;
  return source.split("/").filter((part) => part === "..").length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
