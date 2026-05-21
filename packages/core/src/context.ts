import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { relative } from "./core-utils.ts";
import { defaultProjectFilePatterns, FileDiscoveryMode } from "./discovery.ts";
export type { ProjectFileDiscovery } from "./discovery.ts";
import { validateDocsReference } from "./docs.ts";
import { getGitRoot } from "./git.ts";
import type { ExternalTool } from "./contracts.ts";
import { validateExternalTool } from "./external-tools.ts";
import { validatePatterns } from "./globs.ts";

export type Format = "markdown" | "json";

export type Decision = {
  id: string;
  date: string;
  status: "current" | "proposed" | "replaced";
  title: string;
  topics: string[];
  applies: string[];
  summary: string;
  required?: string[];
  replaced?: string[];
  agentPolicy?: string[];
  exceptions?: string[];
  validatorIds?: string[];
  rationale?: string[];
  examples?: string[];
  docs?: string[];
};

export type ContextPaths = {
  rootDir: string;
  configPath: string | null;
  docsDir: string;
  decisionsPath: string;
  validatorsPath: string;
  fixturesDir: string;
  impactSurfacesPath: string;
  proposedImpactNotesPath: string;
  baselinePath: string;
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
};

export type ContextConfig = {
  docsDir?: string;
  decisionsPath?: string;
  validatorsPath?: string;
  fixturesDir?: string;
  impactSurfacesPath?: string;
  proposedImpactNotesPath?: string;
  baselinePath?: string;
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
};

export type ContextReferenceValidator = {
  id: string;
  decisionIds?: string[];
  docs?: string[];
};

export type ContextValidationInput = {
  decisions: Decision[];
  validators?: ContextReferenceValidator[];
  impactSurfaces?: ImpactSurface[];
  paths?: ContextPaths;
};

export const ContextDiagnosticCode = {
  DecisionValidatorBackrefMissing: "decision-validator-backref-missing",
  ValidatorDecisionBackrefMissing: "validator-decision-backref-missing",
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
  requiresDecision?: boolean;
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
  decisionIds?: string[];
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
  decisionIds?: string[];
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
  "decisionsPath",
  "validatorsPath",
  "fixturesDir",
  "impactSurfacesPath",
  "proposedImpactNotesPath",
  "baselinePath",
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
]);
const defaultDocsDir = "docs/opencanon";
const defaultValidatorsPath = ".agents/skills/opencanon/validators/index.ts";
const defaultFixturesDir = ".agents/skills/opencanon/fixtures";
const defaultImpactSurfacesPath = path.join(defaultDocsDir, "impact-surfaces.json");
const defaultProposedImpactNotesPath = path.join(defaultDocsDir, "proposed-impact-notes.json");
const defaultBaselinePath = ".opencanon/baseline.json";
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
    decisionsPath: path.join(defaultDocsDir, "decisions.json"),
    validatorsPath: defaultValidatorsPath,
    fixturesDir: defaultFixturesDir,
    impactSurfacesPath: defaultImpactSurfacesPath,
    proposedImpactNotesPath: defaultProposedImpactNotesPath,
    baselinePath: defaultBaselinePath,
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

  const raw = JSON.parse(readFileSync(configPath, TextEncoding.Utf8)) as ContextConfig;
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
    decisionsPath: path.join(rootDir, config.decisionsPath),
    validatorsPath: path.join(rootDir, config.validatorsPath),
    fixturesDir: path.join(rootDir, config.fixturesDir),
    impactSurfacesPath: path.join(rootDir, config.impactSurfacesPath),
    proposedImpactNotesPath: path.join(rootDir, config.proposedImpactNotesPath),
    baselinePath: path.join(rootDir, config.baselinePath),
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
  };
}

export function loadContextFiles(paths: ContextPaths): { decisions: Decision[] } {
  if (!existsSync(paths.decisionsPath)) fail(`Missing ${relative(paths.rootDir, paths.decisionsPath)}`);

  const decisions = JSON.parse(readFileSync(paths.decisionsPath, TextEncoding.Utf8)) as Decision[];
  return { decisions };
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
  const { decisions, validators = [], impactSurfaces = [], paths } = input;
  const decisionIds = new Set<string>();
  const validatorIds = new Set(validators.map((validator) => validator.id));
  const validatorById = new Map(validators.map((validator) => [validator.id, validator]));
  const decisionById = new Map<string, Decision>();
  const validStatuses = new Set(["current", "proposed", "replaced"]);

  if (!Array.isArray(decisions)) push("decisions.json must contain an array.");
  for (const decision of decisions) {
    if (decision.id) decisionIds.add(decision.id);
  }

  for (const decision of decisions) {
    if (!decision.id) push("Decision is missing id.");
    if (decision.id && decisionById.has(decision.id)) push(`Duplicate decision id: ${decision.id}`);
    decisionById.set(decision.id, decision);

    if (!decision.title) push(`Decision ${decision.id} is missing title.`);
    if (!decision.date) push(`Decision ${decision.id} is missing date.`);
    if (!validStatuses.has(decision.status)) push(`Decision ${decision.id} has invalid status: ${decision.status}`);
    if (!Array.isArray(decision.topics) || decision.topics.length === 0) push(`Decision ${decision.id} needs at least one topic.`);
    if (!Array.isArray(decision.applies) || decision.applies.length === 0) push(`Decision ${decision.id} needs at least one applies glob.`);
    if (!decision.summary) push(`Decision ${decision.id} is missing summary.`);

    for (const issue of validatePatterns(decision.applies ?? [])) push(`Decision ${decision.id}: ${issue}`);
    for (const docsRef of decision.docs ?? []) {
      for (const issue of validateDocsReference(`Decision ${decision.id}`, docsRef, { decisionIds, paths })) push(issue);
    }
    for (const validatorId of decision.validatorIds ?? []) {
      if (!validatorIds.has(validatorId)) {
        push(`Decision ${decision.id} references missing validator: ${validatorId}`);
        continue;
      }
      const validator = validatorById.get(validatorId);
      if (validator && !(validator.decisionIds ?? []).includes(decision.id)) {
        push(
          `Decision ${decision.id} references validator ${validatorId}, but validator ${validatorId} does not reference decision ${decision.id}.`,
          ContextDiagnosticCode.DecisionValidatorBackrefMissing,
        );
      }
    }
  }

  for (const validator of validators) {
    if (!validator.id) push("Validator reference is missing id.");
    for (const decisionId of validator.decisionIds ?? []) {
      if (!decisionIds.has(decisionId)) {
        push(`Validator ${validator.id} references missing decision: ${decisionId}`);
        continue;
      }
      const decision = decisionById.get(decisionId);
      if (decision && !(decision.validatorIds ?? []).includes(validator.id)) {
        push(
          `Validator ${validator.id} references decision ${decisionId}, but decision ${decisionId} does not reference validator ${validator.id}.`,
          ContextDiagnosticCode.ValidatorDecisionBackrefMissing,
        );
      }
    }
    for (const docsRef of validator.docs ?? []) {
      for (const issue of validateDocsReference(`Validator ${validator.id}`, docsRef, { decisionIds, paths })) push(issue);
    }
  }

  for (const issue of validateImpactSurfaces(impactSurfaces, paths, decisionIds)) push(issue);

  return diagnostics;
}

export function validateImpactSurfaces(surfaces: ImpactSurface[], paths?: ContextPaths, decisionIds = new Set<string>()): string[] {
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
      if (!Array.isArray(surface.decisionIds) || surface.decisionIds.length === 0) diagnostics.push(`${label} needs decisionIds before enforcement.`);
    }

    for (const docsRef of surface.docs ?? []) diagnostics.push(...validateDocsReference(label, docsRef, { decisionIds, paths }));
    for (const decisionId of surface.decisionIds ?? []) {
      if (decisionIds.size > 0 && !decisionIds.has(decisionId)) diagnostics.push(`${label} references missing decision: ${decisionId}`);
    }
  }
  return diagnostics;
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
  if (cachePath === "") {
    diagnostics.push("cacheDir must not point at the project root.");
  }
  if (cachePath.startsWith("..") || path.isAbsolute(cachePath)) {
    diagnostics.push(`cacheDir must stay inside the project root, found ${paths.cacheDir}.`);
  }
  if (baselinePath === "" || baselinePath.startsWith("..") || path.isAbsolute(baselinePath)) {
    diagnostics.push(`baselinePath must stay inside the project root, found ${paths.baselinePath}.`);
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
