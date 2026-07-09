import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Area } from "./area.ts";
import type { Change } from "./change.ts";
import type { Convention } from "./convention.ts";
import type { Spec } from "./spec.ts";
import { relative } from "./core-utils.ts";
import { defaultProjectFilePatterns, FileDiscoveryMode } from "./discovery.ts";
export type { ProjectFileDiscovery } from "./discovery.ts";
import { getGitRoot } from "./git.ts";
import type { ExternalTool } from "./contracts.ts";
import { validateExternalTool } from "./external-tools.ts";
import { validatePatterns } from "./globs.ts";
import { validateImpactSurfaces } from "./context-validation.ts";
export { ContextDiagnosticCode, validateContext, validateContextDiagnostics, validateImpactSurfaces } from "./context-validation.ts";
export type { ContextDiagnostic } from "./context-validation.ts";
import {
  DefaultNativeSemanticEmbeddingModelId,
  DefaultSemanticEmbeddingConfig,
  SemanticEmbeddingProviderKind,
  semanticEmbeddingModel,
  semanticEmbeddingModelIds,
  type SemanticEmbeddingConfig,
  type SemanticEmbeddingModelId,
} from "./semantic-models.ts";

// Single source of truth for output formats; reference members instead of inlining the strings.
export const Format = { Markdown: "markdown", Json: "json" } as const;
export type Format = (typeof Format)[keyof typeof Format];

export type RuntimeConvention = {
  id: string;
  title: string;
  topics: string[];
  applies: string[];
  summary: string;
  validatorIds?: string[];
  rationale?: string[];
  examples?: string[];
  docs?: string[];
};

export type ContextPaths = {
  rootDir: string;
  configPath: string | null;
  docsDir: string;
  conventionsPath: string;
  areasPath: string;
  specsPath: string;
  changesPath: string;
  fixturesDir: string;
  impactSurfacesPath: string;
  proposedImpactNotesPath: string;
  baselinePath: string;
  commitApprovalsPath: string;
  commitApprovalsPersistent: boolean;
  cacheDir: string;
  projectFilePatterns: string[];
  ignore: string[];
  entrypoints: string[];
  publicSurfaces: string[];
  generated: string[];
  externalTools: Record<string, ExternalTool>;
  requiredPackageScripts: string[];
  fileDiscovery: FileDiscoveryMode;
  maxFiles: number;
  maxFileSizeKb: number;
  semanticEmbedding: SemanticEmbeddingConfig;
};

export type ContextConfig = {
  docsDir?: string;
  conventionsPath?: string;
  areasPath?: string;
  specsPath?: string;
  changesPath?: string;
  fixturesDir?: string;
  impactSurfacesPath?: string;
  proposedImpactNotesPath?: string;
  baselinePath?: string;
  commitApprovalsPath?: string;
  commitApprovalsPersistent?: boolean;
  cacheDir?: string;
  projectFilePatterns?: string[];
  ignore?: string[];
  entrypoints?: string[];
  publicSurfaces?: string[];
  generated?: string[];
  externalTools?: Record<string, ExternalTool>;
  requiredPackageScripts?: string[];
  fileDiscovery?: FileDiscoveryMode;
  maxFiles?: number;
  maxFileSizeKb?: number;
  semanticEmbedding?: SemanticEmbeddingConfig;
};

export type ContextReferenceValidator = {
  id: string;
  conventionIds?: string[];
  docs?: string[];
};

export type ContextValidationInput = {
  conventions: Convention[];
  areas?: Area[];
  specs?: Spec[];
  changes?: Change[];
  validators?: ContextReferenceValidator[];
  impactSurfaces?: ImpactSurface[];
  paths?: ContextPaths;
};

export type ChangePolicy = {
  requiresTests?: string[];
  requiresDocs?: string[];
  requiresApproval?: boolean;
  reviewers?: string[];
};

export type ImpactSurface = {
  id: string;
  title?: string;
  applies: string[];
  owns?: string[];
  dependsOn?: string[];
  downstream?: string[];
  risks?: string[];
  changePolicy?: ChangePolicy;
  docs?: string[];
  conventionIds?: string[];
  proposed?: boolean;
};

export type ProposedImpactNote = {
  id: string;
  title: string;
  applies: string[];
  evidence: string[];
  owns?: string[];
  downstream?: string[];
  risks?: string[];
  createdAt: string;
  createdBy?: string;
  docs?: string[];
  conventionIds?: string[];
};

export type Baseline = {
  version: 1;
  findings: Array<{
    key: string;
    validatorId: string;
    file: string;
    line?: number;
    message: string;
  }>;
};

const contextConfigKeys = new Set<keyof ContextConfig>([
  "docsDir",
  "conventionsPath",
  "areasPath",
  "specsPath",
  "changesPath",
  "fixturesDir",
  "impactSurfacesPath",
  "proposedImpactNotesPath",
  "baselinePath",
  "commitApprovalsPath",
  "commitApprovalsPersistent",
  "cacheDir",
  "projectFilePatterns",
  "ignore",
  "entrypoints",
  "publicSurfaces",
  "generated",
  "externalTools",
  "requiredPackageScripts",
  "fileDiscovery",
  "maxFiles",
  "maxFileSizeKb",
  "semanticEmbedding",
]);
const defaultDocsDir = "docs/opencanon";
export const OpenCanonProjectDir = "opencanon";
export const OpenCanonDefaultConventionsPath = "opencanon/conventions/index.ts";
export const OpenCanonDefaultAreasPath = "opencanon/areas/index.ts";
export const OpenCanonDefaultSpecsPath = "opencanon/specs/index.ts";
export const OpenCanonDefaultChangesPath = "opencanon/changes/index.ts";
export const OpenCanonDefaultFixturesDir = "opencanon/fixtures";
const defaultConventionsPath = OpenCanonDefaultConventionsPath;
const defaultAreasPath = OpenCanonDefaultAreasPath;
const defaultSpecsPath = OpenCanonDefaultSpecsPath;
const defaultChangesPath = OpenCanonDefaultChangesPath;
const defaultFixturesDir = OpenCanonDefaultFixturesDir;
const defaultImpactSurfacesPath = path.join(defaultDocsDir, "impact-surfaces.json");
const defaultProposedImpactNotesPath = path.join(defaultDocsDir, "proposed-impact-notes.json");
const defaultBaselinePath = ".opencanon/baseline.json";
const defaultCommitApprovalsPath = ".opencanon/commit-approvals.json";
const defaultCacheDir = ".opencanon/cache";
export const ProjectFileName = {
  OpenCanonConfig: "opencanon.config.json",
  PackageJson: "package.json",
} as const;
const TextEncoding = {
  Utf8: "utf8",
} as const;
const defaultIgnore = [
  "node_modules/**",
  ".git/**",
  ".agents/**",
  ".opencanon/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".next/**",
  ".svelte-kit/**",
  ".turbo/**",
];

export function createDefaultConfig(rootDir: string): Required<ContextConfig> {
  return {
    docsDir: defaultDocsDir,
    conventionsPath: defaultConventionsPath,
    areasPath: defaultAreasPath,
    specsPath: defaultSpecsPath,
    changesPath: defaultChangesPath,
    fixturesDir: defaultFixturesDir,
    impactSurfacesPath: defaultImpactSurfacesPath,
    proposedImpactNotesPath: defaultProposedImpactNotesPath,
    baselinePath: defaultBaselinePath,
    commitApprovalsPath: defaultCommitApprovalsPath,
    commitApprovalsPersistent: false,
    cacheDir: defaultCacheDir,
    projectFilePatterns: defaultProjectFilePatterns(rootDir),
    ignore: defaultIgnore,
    entrypoints: [],
    publicSurfaces: [],
    generated: [],
    externalTools: {},
    requiredPackageScripts: ["opencanon"],
    fileDiscovery: getGitRoot(rootDir) ? FileDiscoveryMode.Git : FileDiscoveryMode.Filesystem,
    maxFiles: 20_000,
    maxFileSizeKb: 512,
    semanticEmbedding: DefaultSemanticEmbeddingConfig,
  };
}

export function resolveRootDir(start = process.cwd()): string {
  let current = path.resolve(start);
  if (existsSync(current) && statSync(current).isFile()) current = path.dirname(current);

  while (true) {
    if (existsSync(path.join(current, ProjectFileName.OpenCanonConfig))) return current;
    if (existsSync(path.join(current, ProjectFileName.PackageJson))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export function loadConfig(rootDir: string): { config: Required<ContextConfig>; configPath: string | null } {
  const configPath = path.join(rootDir, ProjectFileName.OpenCanonConfig);
  const defaults = createDefaultConfig(rootDir);
  if (!existsSync(configPath)) return { config: defaults, configPath: null };

  let raw: ContextConfig;
  try {
    raw = JSON.parse(readFileSync(configPath, TextEncoding.Utf8)) as ContextConfig;
  } catch (error) {
    fail(`Invalid JSON in ${relative(rootDir, configPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    config: {
      ...defaults,
      ...raw,
      projectFilePatterns: raw.projectFilePatterns ?? defaults.projectFilePatterns,
      ignore: raw.ignore ?? defaults.ignore,
      entrypoints: raw.entrypoints ?? defaults.entrypoints,
      publicSurfaces: raw.publicSurfaces ?? defaults.publicSurfaces,
      generated: raw.generated ?? defaults.generated,
      externalTools: raw.externalTools ?? defaults.externalTools,
      requiredPackageScripts: raw.requiredPackageScripts ?? defaults.requiredPackageScripts,
      fileDiscovery: raw.fileDiscovery ?? defaults.fileDiscovery,
      maxFiles: raw.maxFiles ?? defaults.maxFiles,
      maxFileSizeKb: raw.maxFileSizeKb ?? defaults.maxFileSizeKb,
      semanticEmbedding: raw.semanticEmbedding ?? defaults.semanticEmbedding,
    },
    configPath,
  };
}

export function createPaths(rootDir: string, configInput = loadConfig(rootDir)): ContextPaths {
  const { config, configPath } = configInput;
  const docsDir = path.join(rootDir, config.docsDir);
  return {
    rootDir,
    configPath,
    docsDir,
    conventionsPath: path.join(rootDir, config.conventionsPath),
    areasPath: path.join(rootDir, config.areasPath),
    specsPath: path.join(rootDir, config.specsPath),
    changesPath: path.join(rootDir, config.changesPath),
    fixturesDir: path.join(rootDir, config.fixturesDir),
    impactSurfacesPath: path.join(rootDir, config.impactSurfacesPath),
    proposedImpactNotesPath: path.join(rootDir, config.proposedImpactNotesPath),
    baselinePath: path.join(rootDir, config.baselinePath),
    commitApprovalsPath: path.join(rootDir, config.commitApprovalsPath),
    commitApprovalsPersistent: config.commitApprovalsPersistent,
    cacheDir: path.join(rootDir, config.cacheDir),
    projectFilePatterns: config.projectFilePatterns,
    ignore: config.ignore,
    entrypoints: config.entrypoints,
    publicSurfaces: config.publicSurfaces,
    generated: config.generated,
    externalTools: config.externalTools,
    requiredPackageScripts: config.requiredPackageScripts,
    fileDiscovery: config.fileDiscovery,
    maxFiles: config.maxFiles,
    maxFileSizeKb: config.maxFileSizeKb,
    semanticEmbedding: config.semanticEmbedding,
  };
}

export function loadImpactSurfaces(paths: ContextPaths): { surfaces: ImpactSurface[]; diagnostics: string[] } {
  if (!existsSync(paths.impactSurfacesPath)) return { surfaces: [], diagnostics: [] };
  try {
    const value = JSON.parse(readFileSync(paths.impactSurfacesPath, TextEncoding.Utf8)) as unknown;
    if (!Array.isArray(value)) {
      return { surfaces: [], diagnostics: [`${relative(paths.rootDir, paths.impactSurfacesPath)} must contain an array.`] };
    }
    return { surfaces: value as ImpactSurface[], diagnostics: validateImpactSurfaces(value as ImpactSurface[], paths) };
  } catch (error) {
    return {
      surfaces: [],
      diagnostics: [`Could not parse ${relative(paths.rootDir, paths.impactSurfacesPath)}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function loadProposedImpactNotes(paths: ContextPaths): { notes: ProposedImpactNote[]; diagnostics: string[] } {
  if (!existsSync(paths.proposedImpactNotesPath)) return { notes: [], diagnostics: [] };
  try {
    const value = JSON.parse(readFileSync(paths.proposedImpactNotesPath, TextEncoding.Utf8)) as unknown;
    if (!Array.isArray(value)) {
      return { notes: [], diagnostics: [`${relative(paths.rootDir, paths.proposedImpactNotesPath)} must contain an array.`] };
    }
    return { notes: value as ProposedImpactNote[], diagnostics: [] };
  } catch (error) {
    return {
      notes: [],
      diagnostics: [`Could not parse ${relative(paths.rootDir, paths.proposedImpactNotesPath)}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function loadBaseline(paths: ContextPaths): Baseline {
  if (!existsSync(paths.baselinePath)) return { version: 1, findings: [] };
  try {
    const value = JSON.parse(readFileSync(paths.baselinePath, TextEncoding.Utf8)) as Partial<Baseline>;
    return {
      version: 1,
      findings: Array.isArray(value.findings) ? value.findings.filter((item): item is Baseline["findings"][number] => isRecord(item) && typeof item.key === "string") : [],
    };
  } catch {
    return { version: 1, findings: [] };
  }
}

export function validateConfig(paths: ContextPaths): string[] {
  const diagnostics: string[] = [];
  const projectFilePatterns = paths.projectFilePatterns as unknown;
  const ignore = paths.ignore as unknown;
  const entrypoints = paths.entrypoints as unknown;
  const publicSurfaces = paths.publicSurfaces as unknown;
  const generated = paths.generated as unknown;
  const cachePath = relative(paths.rootDir, paths.cacheDir);
  const baselinePath = relative(paths.rootDir, paths.baselinePath);
  const commitApprovalsPath = relative(paths.rootDir, paths.commitApprovalsPath);

  diagnostics.push(...validateConfigFile(paths));

  if (paths.fileDiscovery !== FileDiscoveryMode.Git && paths.fileDiscovery !== FileDiscoveryMode.Filesystem) {
    diagnostics.push(`fileDiscovery must be "${FileDiscoveryMode.Git}" or "${FileDiscoveryMode.Filesystem}", found ${String(paths.fileDiscovery)}.`);
  }
  if (paths.fileDiscovery === FileDiscoveryMode.Git && !getGitRoot(paths.rootDir)) {
    diagnostics.push(
      `fileDiscovery is "${FileDiscoveryMode.Git}" but no Git repository was found for ${paths.rootDir}. Set fileDiscovery to "${FileDiscoveryMode.Filesystem}" to opt into filesystem discovery.`,
    );
  }
  if (!Number.isInteger(paths.maxFiles) || paths.maxFiles < 0) {
    diagnostics.push(`maxFiles must be a non-negative integer, found ${String(paths.maxFiles)}.`);
  }
  if (!Number.isInteger(paths.maxFileSizeKb) || paths.maxFileSizeKb < 0) {
    diagnostics.push(`maxFileSizeKb must be a non-negative integer, found ${String(paths.maxFileSizeKb)}.`);
  }
  diagnostics.push(...validateSemanticEmbeddingConfig(paths.semanticEmbedding));
  if (cachePath === "") {
    diagnostics.push("cacheDir must not point at the project root.");
  }
  if (cachePath.startsWith("..") || path.isAbsolute(cachePath)) {
    diagnostics.push(`cacheDir must stay inside the project root, found ${paths.cacheDir}.`);
  }
  if (baselinePath === "" || baselinePath.startsWith("..") || path.isAbsolute(baselinePath)) {
    diagnostics.push(`baselinePath must stay inside the project root, found ${paths.baselinePath}.`);
  }
  if (commitApprovalsPath === "" || commitApprovalsPath.startsWith("..") || path.isAbsolute(commitApprovalsPath)) {
    diagnostics.push(`commitApprovalsPath must stay inside the project root, found ${paths.commitApprovalsPath}.`);
  }
  if (typeof paths.commitApprovalsPersistent !== "boolean") {
    diagnostics.push(`commitApprovalsPersistent must be a boolean, found ${String(paths.commitApprovalsPersistent)}.`);
  }

  if (!isStringArray(projectFilePatterns)) {
    diagnostics.push("projectFilePatterns must be an array of strings.");
  } else {
    diagnostics.push(...validatePatterns(projectFilePatterns).map((diagnostic) => `projectFilePatterns: ${diagnostic}`));
  }

  if (!isStringArray(ignore)) {
    diagnostics.push("ignore must be an array of strings.");
  } else if (ignore.length > 0) {
    diagnostics.push(...validatePatterns(ignore).map((diagnostic) => `ignore: ${diagnostic}`));
  }

  for (const [label, value] of [
    ["entrypoints", entrypoints],
    ["publicSurfaces", publicSurfaces],
    ["generated", generated],
  ] as const) {
    if (!isStringArray(value)) diagnostics.push(`${label} must be an array of strings.`);
    else if (value.length > 0) diagnostics.push(...validatePatterns(value).map((diagnostic) => `${label}: ${diagnostic}`));
  }

  if (!isRecord(paths.externalTools)) {
    diagnostics.push("externalTools must be an object.");
  } else {
    for (const [name, command] of Object.entries(paths.externalTools)) diagnostics.push(...validateExternalTool(name, command));
  }

  return diagnostics;
}

function validateConfigFile(paths: ContextPaths): string[] {
  if (!paths.configPath || !existsSync(paths.configPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(paths.configPath, TextEncoding.Utf8)) as unknown;
    if (!isRecord(raw)) return [`${ProjectFileName.OpenCanonConfig} must contain a JSON object.`];
    return Object.keys(raw)
      .filter((key) => !contextConfigKeys.has(key as keyof ContextConfig))
      .map((key) => `Unknown config field: ${key}.`);
  } catch (error) {
    return [`Could not parse ${ProjectFileName.OpenCanonConfig}: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function validateSemanticEmbeddingConfig(config: unknown): string[] {
  const diagnostics: string[] = [];
  if (!isRecord(config)) return ["semanticEmbedding must be an object."];
  const ids = semanticEmbeddingModelIds();
  if (config.mode !== SemanticEmbeddingProviderKind.Native) {
    diagnostics.push(`semanticEmbedding.mode must be "${SemanticEmbeddingProviderKind.Native}".`);
  }
  if (typeof config.modelId !== "string" || !ids.includes(config.modelId as SemanticEmbeddingModelId)) {
    diagnostics.push(`semanticEmbedding.modelId must be one of: ${ids.join(", ")}.`);
    return diagnostics;
  }

  const modelId = config.modelId as SemanticEmbeddingModelId;
  const model = semanticEmbeddingModel(modelId);
  if (config.mode === SemanticEmbeddingProviderKind.Native && model.providerKind !== SemanticEmbeddingProviderKind.Native) {
    diagnostics.push(`semanticEmbedding.modelId must be a native model such as "${DefaultNativeSemanticEmbeddingModelId}" when mode is "${SemanticEmbeddingProviderKind.Native}".`);
  }
  for (const field of ["nGpuLayers", "nThreads", "nCtx"] as const) {
    const value = config[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || (field !== "nGpuLayers" && value === 0))) {
      diagnostics.push(`semanticEmbedding.${field} must be a ${field === "nGpuLayers" ? "non-negative" : "positive"} integer.`);
    }
  }
  if (typeof config.showDownloadProgress !== "boolean") diagnostics.push("semanticEmbedding.showDownloadProgress must be a boolean.");
  return diagnostics;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
