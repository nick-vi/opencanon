import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  AreaCheckKind,
  AreaRenderKind,
  type Area,
  type AreaCheck,
} from "./area.ts";
import { validateGeneratedAreaDocsPath } from "./area-render.ts";
import {
  ChangeCheckKind,
  ChangeKind,
  ChangeRenderKind,
  type Change,
} from "./change.ts";
import { validateGeneratedChangeDocsPath } from "./change-render.ts";
import { ConventionAppliesKind, ConventionDefinitionKind, ConventionRenderKind, ConventionRuntimeKind, type Convention } from "./convention.ts";
import { conventionDocsReference, validateGeneratedConventionDocsPath } from "./convention-render.ts";
import {
  SpecCheckKind,
  SpecRenderKind,
  type Spec,
} from "./spec.ts";
import { validateGeneratedSpecDocsPath } from "./spec-render.ts";
import { relative } from "./core-utils.ts";
import { DefinitionTargetKind, definitionTargetDocs, definitionTargetFiles, type DefinitionTarget } from "./definition-target.ts";
import { defaultProjectFilePatterns, FileDiscoveryMode } from "./discovery.ts";
export type { ProjectFileDiscovery } from "./discovery.ts";
import { validateDocsReference } from "./docs.ts";
import { getGitRoot } from "./git.ts";
import type { ExternalTool } from "./contracts.ts";
import { validateExternalTool } from "./external-tools.ts";
import { validatePatterns } from "./globs.ts";
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

export const ContextDiagnosticCode = {
  ConventionValidatorBackrefMissing: "convention-validator-backref-missing",
  ValidatorConventionBackrefMissing: "validator-convention-backref-missing",
  InvalidContext: "invalid-context",
} as const;
export type ContextDiagnosticCode = (typeof ContextDiagnosticCode)[keyof typeof ContextDiagnosticCode];

export type ContextDiagnostic = {
  code: ContextDiagnosticCode;
  message: string;
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

export function validateContext(input: ContextValidationInput): string[] {
  return validateContextDiagnostics(input).map((diagnostic) => diagnostic.message);
}

export function validateContextDiagnostics(input: ContextValidationInput): ContextDiagnostic[] {
  const diagnostics: ContextDiagnostic[] = [];
  const push = (message: string, code: ContextDiagnosticCode = ContextDiagnosticCode.InvalidContext) => diagnostics.push({ code, message });
  const { conventions, areas = [], specs = [], changes = [], validators = [], impactSurfaces = [], paths } = input;
  const conventionIds = new Set<string>();
  const areaIds = new Set<string>();
  const specIds = new Set<string>();
  const changeIds = new Set<string>();
  const validatorIds = new Set(validators.map((validator) => validator.id));
  const conventionById = new Map<string, Convention>();
  const areaById = new Map<string, Area>();
  const specById = new Map<string, Spec>();
  const changeById = new Map<string, Change>();
  const impactSurfaceIds = new Set(impactSurfaces.map((surface) => surface.id).filter(Boolean));
  const impactSurfaceById = new Map(impactSurfaces.map((surface) => [surface.id, surface]));
  const generatedDocsRefs = new Set<string>();

  if (!Array.isArray(conventions)) push("conventions must contain an array.");
  if (!Array.isArray(areas)) push("areas must contain an array.");
  if (!Array.isArray(specs)) push("specs must contain an array.");
  if (!Array.isArray(changes)) push("changes must contain an array.");
  for (const convention of conventions) {
    if (convention.id) conventionIds.add(convention.id);
    if (convention.render.kind === ConventionRenderKind.Generated) {
      const docsRef = conventionDocsReference(convention);
      if (docsRef) generatedDocsRefs.add(docsRef);
    }
  }

  for (const area of areas) {
    if (area.id) areaIds.add(area.id);
  }

  for (const spec of specs) {
    if (spec.id) specIds.add(spec.id);
  }

  for (const change of changes) {
    if (change.id) changeIds.add(change.id);
  }

  for (const convention of conventions) {
    if (!convention.id) push("Convention is missing id.");
    if (convention.id && conventionById.has(convention.id)) push(`Duplicate convention id: ${convention.id}`);
    conventionById.set(convention.id, convention);

    if (!convention.title) push(`Convention ${convention.id} is missing title.`);
    if (!convention.rule) push(`Convention ${convention.id} is missing rule.`);
    for (const issue of validateConventionSemantics(convention)) push(issue);
    if (shouldValidateAppliesGlobs(convention)) {
      for (const issue of validatePatterns(appliesGlobs(convention))) push(`Convention ${convention.id}: ${issue}`);
    }
    if (convention.render.kind === ConventionRenderKind.Generated) {
      for (const issue of validateGeneratedConventionDocsPath(`Convention ${convention.id}`, convention.render.docs, { paths })) push(issue);
    }
    for (const relatedId of convention.related ?? []) {
      if (!conventionIds.has(relatedId)) push(`Convention ${convention.id} references missing related convention: ${relatedId}`);
    }
    for (const surfaceId of convention.impactSurfaces ?? []) {
      if (!impactSurfaceIds.has(surfaceId)) push(`Convention ${convention.id} references missing impact surface: ${surfaceId}`);
    }
    if (convention.applies.kind === ConventionAppliesKind.ImpactSurface) {
      for (const surfaceId of convention.applies.surfaceIds) {
        if (!impactSurfaceIds.has(surfaceId)) push(`Convention ${convention.id} applies to missing impact surface: ${surfaceId}`);
      }
    }
    if (convention.applies.kind === ConventionAppliesKind.Definitions) {
      for (const target of convention.applies.definitions) {
        for (const id of target.ids ?? []) {
          if (target.kind === ConventionDefinitionKind.Spec && !specIds.has(id)) push(`Convention ${convention.id} applies to missing spec: ${id}`);
          if (target.kind === ConventionDefinitionKind.Area && !areaIds.has(id)) push(`Convention ${convention.id} applies to missing area: ${id}`);
          if (target.kind === ConventionDefinitionKind.Change && !changeIds.has(id)) push(`Convention ${convention.id} applies to missing change: ${id}`);
          if (target.kind === ConventionDefinitionKind.Convention && !conventionIds.has(id)) push(`Convention ${convention.id} applies to missing convention: ${id}`);
        }
      }
    }
  }

  for (const area of areas) {
    if (!area.id) push("Area is missing id.");
    if (area.id && areaById.has(area.id)) push(`Duplicate area id: ${area.id}`);
    areaById.set(area.id, area);

    if (!area.title) push(`Area ${area.id} is missing title.`);
    if (!area.summary) push(`Area ${area.id} is missing summary.`);
    for (const issue of validateAreaSemantics(area)) push(issue);
    if (area.render.kind === AreaRenderKind.Generated) {
      for (const issue of validateGeneratedAreaDocsPath(`Area ${area.id}`, area.render.docs, { paths })) push(issue);
    }
    for (const surfaceId of area.surfaces ?? []) {
      if (!impactSurfaceIds.has(surfaceId)) push(`Area ${area.id} references missing impact surface: ${surfaceId}`);
    }
    for (const dependencyId of area.dependsOn ?? []) {
      if (!areaIds.has(dependencyId)) push(`Area ${area.id} references missing dependency: ${dependencyId}`);
    }
    for (const conventionId of area.governedBy?.conventions ?? []) {
      if (!conventionIds.has(conventionId)) push(`Area ${area.id} references missing governing convention: ${conventionId}`);
    }
    for (const issue of validateAreaCheckReferences(area)) push(issue);
  }

  for (const issue of validateAreaDependencyCycles(areas)) push(issue);

  for (const spec of specs) {
    if (!spec.id) push("Spec is missing id.");
    if (spec.id && specById.has(spec.id)) push(`Duplicate spec id: ${spec.id}`);
    specById.set(spec.id, spec);

    if (!spec.title) push(`Spec ${spec.id} is missing title.`);
    if (!spec.summary) push(`Spec ${spec.id} is missing summary.`);
    for (const issue of validateSpecSemantics(spec)) push(issue);
    if (spec.render.kind === SpecRenderKind.Generated) {
      for (const issue of validateGeneratedSpecDocsPath(`Spec ${spec.id}`, spec.render.docs, { paths })) push(issue);
    }
    for (const surfaceId of spec.surfaces ?? []) {
      if (!impactSurfaceIds.has(surfaceId)) push(`Spec ${spec.id} references missing impact surface: ${surfaceId}`);
    }
    for (const areaId of spec.areas ?? []) {
      if (!areaIds.has(areaId)) push(`Spec ${spec.id} references missing area: ${areaId}`);
    }
    for (const dependencyId of spec.dependsOn ?? []) {
      if (!specIds.has(dependencyId)) push(`Spec ${spec.id} references missing dependency: ${dependencyId}`);
    }
    for (const conventionId of spec.governedBy?.conventions ?? []) {
      if (!conventionIds.has(conventionId)) push(`Spec ${spec.id} references missing governing convention: ${conventionId}`);
    }
    for (const issue of validateSpecCheckReferences(spec)) push(issue);
  }

  for (const issue of validateSpecDependencyCycles(specs)) push(issue);

  for (const change of changes) {
    if (!change.id) push("Change is missing id.");
    if (change.id && changeById.has(change.id)) push(`Duplicate change id: ${change.id}`);
    changeById.set(change.id, change);

    if (!change.title) push(`Change ${change.id} is missing title.`);
    if (!Object.values(ChangeKind).includes(change.kind)) push(`Change ${change.id} has invalid kind: ${String(change.kind)}`);
    if (!change.intent?.problem) push(`Change ${change.id} is missing intent problem.`);
    if (!change.intent?.outcome) push(`Change ${change.id} is missing intent outcome.`);
    for (const issue of validateChangeSemantics(change)) push(issue);
    if (change.render.kind === ChangeRenderKind.Generated) {
      for (const issue of validateGeneratedChangeDocsPath(`Change ${change.id}`, change.render.docs, { paths })) push(issue);
    }
    for (const areaId of change.updates?.areas ?? []) {
      if (!areaIds.has(areaId)) push(`Change ${change.id} references missing area: ${areaId}`);
    }
    for (const specId of change.updates?.specs ?? []) {
      if (!specIds.has(specId)) push(`Change ${change.id} references missing spec: ${specId}`);
    }
    for (const conventionId of change.updates?.conventions ?? []) {
      if (!conventionIds.has(conventionId)) push(`Change ${change.id} references missing convention: ${conventionId}`);
    }
    for (const surfaceId of change.updates?.surfaces ?? []) {
      if (!impactSurfaceIds.has(surfaceId)) push(`Change ${change.id} references missing impact surface: ${surfaceId}`);
    }
    for (const task of change.tasks ?? []) {
      for (const areaId of task.updates?.areas ?? []) {
        if (!areaIds.has(areaId)) push(`Change ${change.id} task ${task.id} references missing area: ${areaId}`);
      }
      for (const specId of task.updates?.specs ?? []) {
        if (!specIds.has(specId)) push(`Change ${change.id} task ${task.id} references missing spec: ${specId}`);
      }
      for (const conventionId of task.updates?.conventions ?? []) {
        if (!conventionIds.has(conventionId)) push(`Change ${change.id} task ${task.id} references missing convention: ${conventionId}`);
      }
      for (const surfaceId of task.surfaces ?? []) {
        if (!impactSurfaceIds.has(surfaceId)) push(`Change ${change.id} task ${task.id} references missing impact surface: ${surfaceId}`);
      }
      for (const surfaceId of task.updates?.surfaces ?? []) {
        if (!impactSurfaceIds.has(surfaceId)) push(`Change ${change.id} task ${task.id} references missing impact surface: ${surfaceId}`);
      }
    }
    for (const dependencyId of change.dependsOn ?? []) {
      if (!changeIds.has(dependencyId)) push(`Change ${change.id} references missing dependency: ${dependencyId}`);
    }
    for (const blockerId of change.blockedBy ?? []) {
      if (!changeIds.has(blockerId)) push(`Change ${change.id} references missing blocker: ${blockerId}`);
    }
    for (const issue of validateChangeCheckReferences(change)) push(issue);
  }

  for (const issue of validateChangeDependencyCycles(changes)) push(issue);

  for (const convention of conventions) {
    for (const surfaceId of convention.impactSurfaces ?? []) {
      const surface = impactSurfaceById.get(surfaceId);
      if (!surface) continue;
      if (!(surface.conventionIds ?? []).includes(convention.id)) {
        push(`Impact surface ${surfaceId} omits convention ${convention.id}, but convention ${convention.id} references impact surface ${surfaceId}.`);
      }
    }
  }

  for (const validator of validators) {
    if (!validator.id) push("Validator reference is missing id.");
    for (const conventionId of validator.conventionIds ?? []) {
      if (!conventionIds.has(conventionId)) {
        push(`Validator ${validator.id} references missing convention: ${conventionId}`);
        continue;
      }
      if (conventionId === validator.id) continue;
      const convention = conventionById.get(conventionId);
      if (convention && convention.related && !convention.related.includes(validator.id)) {
        push(
          `Validator ${validator.id} references convention ${conventionId}, but convention ${conventionId} does not reference validator ${validator.id}.`,
          ContextDiagnosticCode.ValidatorConventionBackrefMissing,
        );
      }
    }
    for (const docsRef of validator.docs ?? []) {
      if (generatedDocsRefs.has(docsRef)) continue;
      for (const issue of validateDocsReference(`Validator ${validator.id}`, docsRef, { conventionIds, paths })) push(issue);
    }
  }

  for (const issue of validateImpactSurfaces(impactSurfaces, paths, conventionIds)) push(issue);
  for (const surface of impactSurfaces) {
    const surfaceId = surface.id;
    if (!surfaceId) continue;
    for (const conventionId of surface.conventionIds ?? []) {
      if (!conventionIds.has(conventionId)) continue;
      const convention = conventionById.get(conventionId);
      if (convention && !(convention.impactSurfaces ?? []).includes(surfaceId)) {
        push(`Impact surface ${surfaceId} references convention ${conventionId}, but convention ${conventionId} does not reference impact surface ${surfaceId}.`);
      }
    }
  }

  return diagnostics;
}

export function validateImpactSurfaces(surfaces: ImpactSurface[], paths?: ContextPaths, conventionIds = new Set<string>()): string[] {
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  for (const surface of surfaces) {
    const label = surface.id ? `Impact surface ${surface.id}` : "Impact surface";
    if (!surface.id) diagnostics.push("Impact surface is missing id.");
    if (surface.id && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(surface.id)) diagnostics.push(`${label} id must be kebab-case.`);
    if (surface.id && ids.has(surface.id)) diagnostics.push(`Duplicate impact surface id: ${surface.id}`);
    if (surface.id) ids.add(surface.id);
    if (!Array.isArray(surface.applies) || surface.applies.length === 0) diagnostics.push(`${label} needs at least one applies glob.`);
    else diagnostics.push(...validatePatterns(surface.applies).map((diagnostic) => `${label}: ${diagnostic}`));

    if (!surface.proposed) {
      if (!Array.isArray(surface.docs) || surface.docs.length === 0) diagnostics.push(`${label} needs docs before enforcement.`);
      if (!Array.isArray(surface.conventionIds) || surface.conventionIds.length === 0) diagnostics.push(`${label} needs conventionIds before enforcement.`);
    }

    for (const docsRef of surface.docs ?? []) diagnostics.push(...validateDocsReference(label, docsRef, { conventionIds, paths }));
    for (const conventionId of surface.conventionIds ?? []) {
      if (conventionIds.size > 0 && !conventionIds.has(conventionId)) diagnostics.push(`${label} references missing convention: ${conventionId}`);
    }
  }
  return diagnostics;
}

function validateConventionSemantics(convention: Convention): string[] {
  const diagnostics: string[] = [];
  if (convention.runtime.kind === ConventionRuntimeKind.Test && convention.render.kind !== ConventionRenderKind.None) {
    diagnostics.push(`Convention ${convention.id} runtime kind "test" must use render kind "none". Use runtime kind "validator" when the rule also has docs.`);
  }
  if (convention.runtime.kind === ConventionRuntimeKind.Gate && !convention.runtime.question.trim()) {
    diagnostics.push(`Convention ${convention.id} gate runtime must include a non-empty question.`);
  }
  return diagnostics;
}

function validateAreaSemantics(area: Area): string[] {
  const diagnostics: string[] = [];
  if (area.id && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(area.id)) diagnostics.push(`Area ${area.id} id must be kebab-case.`);
  for (const issue of validateDefinitionTargets(`Area ${area.id} ownership`, area.owns)) diagnostics.push(issue);
  for (const issue of validateStringIds(`Area ${area.id} stories`, area.stories ?? [])) diagnostics.push(issue);
  for (const issue of validateStringIds(`Area ${area.id} behaviors`, area.behaviors ?? [])) diagnostics.push(issue);
  for (const issue of validateAreaChecks(area)) diagnostics.push(issue);

  for (const story of area.stories ?? []) {
    if (!story.as.trim()) diagnostics.push(`Area ${area.id} story ${story.id} is missing actor.`);
    if (!story.want.trim()) diagnostics.push(`Area ${area.id} story ${story.id} is missing want.`);
    if (!story.so.trim()) diagnostics.push(`Area ${area.id} story ${story.id} is missing outcome rationale.`);
    if (!Array.isArray(story.acceptance) || story.acceptance.length === 0) diagnostics.push(`Area ${area.id} story ${story.id} needs acceptance criteria.`);
  }

  for (const behavior of area.behaviors ?? []) {
    if (!behavior.actor.trim()) diagnostics.push(`Area ${area.id} behavior ${behavior.id} is missing actor.`);
    if (!behavior.action.trim()) diagnostics.push(`Area ${area.id} behavior ${behavior.id} is missing action.`);
    if (!behavior.outcome.trim()) diagnostics.push(`Area ${area.id} behavior ${behavior.id} is missing outcome.`);
  }

  return diagnostics;
}

function validateAreaChecks(area: Area): string[] {
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  for (const check of area.checks ?? []) {
    if (!check.id) diagnostics.push(`Area ${area.id} has a check without id.`);
    if (check.id && ids.has(check.id)) diagnostics.push(`Area ${area.id} has duplicate check id: ${check.id}`);
    ids.add(check.id);
    switch (check.kind) {
      case AreaCheckKind.Command:
        if (!check.command.trim()) diagnostics.push(`Area ${area.id} check ${check.id} needs command.`);
        break;
      case AreaCheckKind.Doctor:
        break;
      case AreaCheckKind.Validator:
        if (!check.validatorId.trim()) diagnostics.push(`Area ${area.id} check ${check.id} needs validatorId.`);
        break;
      case AreaCheckKind.Test:
        if (!check.target.trim()) diagnostics.push(`Area ${area.id} check ${check.id} needs target.`);
        break;
    }
  }
  return diagnostics;
}

function validateAreaCheckReferences(area: Area): string[] {
  const diagnostics: string[] = [];
  const checkIds = new Set((area.checks ?? []).map((check) => check.id));
  for (const story of area.stories ?? []) {
    for (const checkId of story.checks ?? []) {
      if (!checkIds.has(checkId)) diagnostics.push(`Area ${area.id} story ${story.id} references missing check: ${checkId}`);
    }
  }
  for (const behavior of area.behaviors ?? []) {
    for (const checkId of behavior.checks ?? []) {
      if (!checkIds.has(checkId)) diagnostics.push(`Area ${area.id} behavior ${behavior.id} references missing check: ${checkId}`);
    }
  }
  return diagnostics;
}

function validateAreaDependencyCycles(areas: Area[]): string[] {
  const byId = new Map(areas.map((area) => [area.id, area]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const diagnostics: string[] = [];

  function visit(id: string, pathIds: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = pathIds.indexOf(id);
      const cycle = pathIds.slice(cycleStart).join(" -> ");
      diagnostics.push(`Area dependency cycle detected: ${cycle}`);
      return;
    }
    const area = byId.get(id);
    if (!area) return;
    visiting.add(id);
    for (const dependency of area.dependsOn ?? []) visit(dependency, [...pathIds, dependency]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const area of areas) visit(area.id, [area.id]);
  return diagnostics;
}

function validateSpecSemantics(spec: Spec): string[] {
  const diagnostics: string[] = [];
  if (spec.id && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(spec.id)) diagnostics.push(`Spec ${spec.id} id must be kebab-case.`);
  for (const issue of validateDefinitionTargets(`Spec ${spec.id} scope`, spec.scope)) diagnostics.push(issue);
  for (const issue of validateStringIds(`Spec ${spec.id} rules`, spec.rules ?? [])) diagnostics.push(issue);
  for (const issue of validateStringIds(`Spec ${spec.id} scenarios`, spec.scenarios ?? [])) diagnostics.push(issue);
  for (const issue of validateSpecChecks(spec)) diagnostics.push(issue);

  for (const rule of spec.rules ?? []) {
    if (!rule.statement.trim()) diagnostics.push(`Spec ${spec.id} rule ${rule.id} is missing statement.`);
    if (rule.acceptance !== undefined && (!Array.isArray(rule.acceptance) || rule.acceptance.some((item) => !hasNonEmptyString(item)))) {
      diagnostics.push(`Spec ${spec.id} rule ${rule.id} acceptance must contain non-empty strings.`);
    }
  }

  for (const scenario of spec.scenarios ?? []) {
    if (!Array.isArray(scenario.given) || scenario.given.length === 0 || scenario.given.some((item) => !hasNonEmptyString(item))) {
      diagnostics.push(`Spec ${spec.id} scenario ${scenario.id} needs at least one Given string.`);
    }
    if (!scenario.when.trim()) diagnostics.push(`Spec ${spec.id} scenario ${scenario.id} is missing When.`);
    if (!Array.isArray(scenario.then) || scenario.then.length === 0 || scenario.then.some((item) => !hasNonEmptyString(item))) {
      diagnostics.push(`Spec ${spec.id} scenario ${scenario.id} needs at least one Then string.`);
    }
  }

  return diagnostics;
}

function validateChangeSemantics(change: Change): string[] {
  const diagnostics: string[] = [];
  if (change.id && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(change.id)) diagnostics.push(`Change ${change.id} id must be kebab-case.`);
  for (const issue of validateDefinitionTargets(`Change ${change.id} scope`, change.scope)) diagnostics.push(issue);
  for (const issue of validateStringIds(`Change ${change.id} plan`, change.plan ?? [])) diagnostics.push(issue);
  for (const issue of validateStringIds(`Change ${change.id} tasks`, change.tasks ?? [])) diagnostics.push(issue);
  for (const issue of validateChangeChecks(change)) diagnostics.push(issue);

  for (const plan of change.plan ?? []) {
    if (!plan.title.trim()) diagnostics.push(`Change ${change.id} plan ${plan.id} is missing title.`);
  }
  for (const task of change.tasks ?? []) {
    if (!task.title.trim()) diagnostics.push(`Change ${change.id} task ${task.id} is missing title.`);
    const taskFiles = task.files ?? [];
    if (taskFiles.length > 0) {
      for (const issue of validatePatterns(taskFiles)) diagnostics.push(`Change ${change.id} task ${task.id}: ${issue}`);
    }
    for (const dependencyId of [...(task.dependsOn ?? []), ...(task.blockedBy ?? [])]) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(dependencyId)) diagnostics.push(`Change ${change.id} task ${task.id} dependency ${dependencyId} must be kebab-case.`);
    }
    if (task.updates?.docs) {
      for (const issue of validatePatterns(task.updates.docs)) diagnostics.push(`Change ${change.id} task ${task.id}: ${issue}`);
    }
    for (const surfaceId of task.surfaces ?? []) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(surfaceId)) diagnostics.push(`Change ${change.id} task ${task.id} impact surface ${surfaceId} must be kebab-case.`);
    }
  }
  diagnostics.push(...validateChangeTaskDependencies(change));

  return diagnostics;
}

function validateDefinitionTargets(owner: string, targets: DefinitionTarget[] | undefined): string[] {
  if (!targets) return [];
  if (!Array.isArray(targets)) return [`${owner} must be an array of targets.`];
  const diagnostics: string[] = [];
  for (const issue of validatePatterns([...definitionTargetFiles(targets), ...definitionTargetDocs(targets)])) diagnostics.push(`${owner}: ${issue}`);

  for (const [index, target] of targets.entries()) {
    const label = `${owner} target ${index + 1}`;
    if (!target || typeof target !== "object") {
      diagnostics.push(`${label} must be an object.`);
      continue;
    }
    switch (target.kind) {
      case DefinitionTargetKind.File:
      case DefinitionTargetKind.Endpoint:
      case DefinitionTargetKind.Doc:
        if (!hasNonEmptyString(target.path)) diagnostics.push(`${label} needs a non-empty path.`);
        break;
      case DefinitionTargetKind.Package:
      case DefinitionTargetKind.Command:
      case DefinitionTargetKind.Resource:
        if (!hasNonEmptyString(target.name)) diagnostics.push(`${label} needs a non-empty name.`);
        break;
      default:
        diagnostics.push(`${label} has invalid kind: ${String((target as { kind?: unknown }).kind)}.`);
    }
  }
  return diagnostics;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSpecChecks(spec: Spec): string[] {
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  for (const check of spec.checks ?? []) {
    if (!check.id) diagnostics.push(`Spec ${spec.id} has a check without id.`);
    if (check.id && ids.has(check.id)) diagnostics.push(`Spec ${spec.id} has duplicate check id: ${check.id}`);
    ids.add(check.id);
    switch (check.kind) {
      case SpecCheckKind.Command:
        if (!check.command.trim()) diagnostics.push(`Spec ${spec.id} check ${check.id} needs command.`);
        break;
      case SpecCheckKind.Doctor:
        break;
      case SpecCheckKind.Validator:
        if (!check.validatorId.trim()) diagnostics.push(`Spec ${spec.id} check ${check.id} needs validatorId.`);
        break;
      case SpecCheckKind.Test:
        if (!check.target.trim()) diagnostics.push(`Spec ${spec.id} check ${check.id} needs target.`);
        break;
    }
  }
  return diagnostics;
}

function validateSpecCheckReferences(spec: Spec): string[] {
  const diagnostics: string[] = [];
  const checkIds = new Set((spec.checks ?? []).map((check) => check.id));
  for (const rule of spec.rules ?? []) {
    for (const checkId of rule.checks ?? []) {
      if (!checkIds.has(checkId)) diagnostics.push(`Spec ${spec.id} rule ${rule.id} references missing check: ${checkId}`);
    }
  }
  for (const scenario of spec.scenarios ?? []) {
    for (const checkId of scenario.checks ?? []) {
      if (!checkIds.has(checkId)) diagnostics.push(`Spec ${spec.id} scenario ${scenario.id} references missing check: ${checkId}`);
    }
  }
  return diagnostics;
}

function validateSpecDependencyCycles(specs: Spec[]): string[] {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const diagnostics: string[] = [];

  function visit(id: string, pathIds: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = pathIds.indexOf(id);
      const cycle = pathIds.slice(cycleStart).join(" -> ");
      diagnostics.push(`Spec dependency cycle detected: ${cycle}`);
      return;
    }
    const spec = byId.get(id);
    if (!spec) return;
    visiting.add(id);
    for (const dependency of spec.dependsOn ?? []) visit(dependency, [...pathIds, dependency]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const spec of specs) visit(spec.id, [spec.id]);
  return diagnostics;
}

function validateChangeChecks(change: Change): string[] {
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  for (const check of change.checks ?? []) {
    if (!check.id) diagnostics.push(`Change ${change.id} has a check without id.`);
    if (check.id && ids.has(check.id)) diagnostics.push(`Change ${change.id} has duplicate check id: ${check.id}`);
    ids.add(check.id);
    switch (check.kind) {
      case ChangeCheckKind.Command:
        if (!check.command.trim()) diagnostics.push(`Change ${change.id} check ${check.id} needs command.`);
        break;
      case ChangeCheckKind.Doctor:
        break;
      case ChangeCheckKind.Validator:
        if (!check.validatorId.trim()) diagnostics.push(`Change ${change.id} check ${check.id} needs validatorId.`);
        break;
      case ChangeCheckKind.Test:
        if (!check.target.trim()) diagnostics.push(`Change ${change.id} check ${check.id} needs target.`);
        break;
    }
  }
  return diagnostics;
}

function validateChangeCheckReferences(change: Change): string[] {
  const diagnostics: string[] = [];
  const checkIds = new Set((change.checks ?? []).map((check) => check.id));
  for (const plan of change.plan ?? []) {
    for (const checkId of plan.checks ?? []) {
      if (!checkIds.has(checkId)) diagnostics.push(`Change ${change.id} plan ${plan.id} references missing check: ${checkId}`);
    }
  }
  for (const task of change.tasks ?? []) {
    for (const checkId of task.checks ?? []) {
      if (!checkIds.has(checkId)) diagnostics.push(`Change ${change.id} task ${task.id} references missing check: ${checkId}`);
    }
  }
  return diagnostics;
}

function validateChangeTaskDependencies(change: Change): string[] {
  const diagnostics: string[] = [];
  const tasks = change.tasks ?? [];
  const taskIds = new Set(tasks.map((task) => task.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const task of tasks) {
    for (const dependencyId of [...(task.dependsOn ?? []), ...(task.blockedBy ?? [])]) {
      if (!taskIds.has(dependencyId)) diagnostics.push(`Change ${change.id} task ${task.id} references missing task: ${dependencyId}`);
      if (dependencyId === task.id) diagnostics.push(`Change ${change.id} task ${task.id} cannot depend on itself.`);
    }
  }

  function visit(id: string, pathIds: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = pathIds.indexOf(id);
      const cycle = pathIds.slice(cycleStart).join(" -> ");
      diagnostics.push(`Change ${change.id} task dependency cycle detected: ${cycle}`);
      return;
    }
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    visiting.add(id);
    for (const dependency of [...(task.dependsOn ?? []), ...(task.blockedBy ?? [])]) visit(dependency, [...pathIds, dependency]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of tasks) visit(task.id, [task.id]);
  return diagnostics;
}

function validateChangeDependencyCycles(changes: Change[]): string[] {
  const byId = new Map(changes.map((change) => [change.id, change]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const diagnostics: string[] = [];

  function visit(id: string, pathIds: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = pathIds.indexOf(id);
      const cycle = pathIds.slice(cycleStart).join(" -> ");
      diagnostics.push(`Change dependency cycle detected: ${cycle}`);
      return;
    }
    const change = byId.get(id);
    if (!change) return;
    visiting.add(id);
    for (const dependency of [...(change.dependsOn ?? []), ...(change.blockedBy ?? [])]) visit(dependency, [...pathIds, dependency]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const change of changes) visit(change.id, [change.id]);
  return diagnostics;
}

function validateStringIds(label: string, items: Array<{ id: string }>): string[] {
  const diagnostics: string[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (!item.id) diagnostics.push(`${label} include an item without id.`);
    if (item.id && ids.has(item.id)) diagnostics.push(`${label} include duplicate id: ${item.id}`);
    ids.add(item.id);
  }
  return diagnostics;
}

function appliesGlobs(convention: Convention): string[] {
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return convention.applies.globs;
    case "imports":
      return [...(convention.applies.from ?? []), ...(convention.applies.to ?? [])];
    case "impact-surface":
    case "custom":
    case "definitions":
    case "project":
      return [];
  }
}

function shouldValidateAppliesGlobs(convention: Convention): boolean {
  if (convention.applies.kind === ConventionAppliesKind.Files || convention.applies.kind === ConventionAppliesKind.Symbols) return true;
  if (convention.applies.kind === ConventionAppliesKind.Imports) return appliesGlobs(convention).length > 0;
  return false;
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
  if (config.mode !== SemanticEmbeddingProviderKind.Local && config.mode !== SemanticEmbeddingProviderKind.Native) {
    diagnostics.push(`semanticEmbedding.mode must be "${SemanticEmbeddingProviderKind.Local}" or "${SemanticEmbeddingProviderKind.Native}".`);
  }
  if (typeof config.modelId !== "string" || !ids.includes(config.modelId as SemanticEmbeddingModelId)) {
    diagnostics.push(`semanticEmbedding.modelId must be one of: ${ids.join(", ")}.`);
    return diagnostics;
  }

  const modelId = config.modelId as SemanticEmbeddingModelId;
  const model = semanticEmbeddingModel(modelId);
  if (config.mode === SemanticEmbeddingProviderKind.Local && model.providerKind !== SemanticEmbeddingProviderKind.Local) {
    diagnostics.push(`semanticEmbedding.modelId must be the local model when mode is "${SemanticEmbeddingProviderKind.Local}".`);
  }
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
