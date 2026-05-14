import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  createDefaultConfig,
  createOpenCanonDiagnostic,
  createPaths,
  FileDiscoveryMode,
  ExternalToolSchema,
  relative,
  validateConfig,
  writeAtomicJsonFileSync,
  type ContextConfig,
  type ExternalTool,
} from "@opencanon/core";

const ConfigFileName = "opencanon.config.json";
const TextEncoding = {
  Utf8: "utf8",
} as const;

const ConfigField = {
  CacheDir: "cacheDir",
  DecisionsPath: "decisionsPath",
  DocsDir: "docsDir",
  FileDiscovery: "fileDiscovery",
  FixturesDir: "fixturesDir",
  ImpactSurfacesPath: "impactSurfacesPath",
  Ignore: "ignore",
  BaselinePath: "baselinePath",
  Entrypoints: "entrypoints",
  ExternalTools: "externalTools",
  Generated: "generated",
  MaxFileSizeKb: "maxFileSizeKb",
  MaxFiles: "maxFiles",
  ProjectFilePatterns: "projectFilePatterns",
  ProposedImpactNotesPath: "proposedImpactNotesPath",
  PublicSurfaces: "publicSurfaces",
  RequiredPackageScripts: "requiredPackageScripts",
  ValidatorsPath: "validatorsPath",
} as const;
type ConfigField = (typeof ConfigField)[keyof typeof ConfigField];

const stringConfigFields = [
  ConfigField.CacheDir,
  ConfigField.DecisionsPath,
  ConfigField.DocsDir,
  ConfigField.FixturesDir,
  ConfigField.ImpactSurfacesPath,
  ConfigField.ProposedImpactNotesPath,
  ConfigField.BaselinePath,
  ConfigField.ValidatorsPath,
] as const;
const stringArrayConfigFields = [
  ConfigField.Entrypoints,
  ConfigField.Generated,
  ConfigField.Ignore,
  ConfigField.ProjectFilePatterns,
  ConfigField.PublicSurfaces,
  ConfigField.RequiredPackageScripts,
] as const;
const numberConfigFields = [ConfigField.MaxFileSizeKb, ConfigField.MaxFiles] as const;
const allowedConfigFields = new Set<ConfigField>([
  ...stringConfigFields,
  ...stringArrayConfigFields,
  ...numberConfigFields,
  ConfigField.FileDiscovery,
  ConfigField.ExternalTools,
]);

export type ProjectSettings = {
  rootDir: string;
  configPath: string;
  hasConfig: boolean;
  defaults: Required<ContextConfig>;
  effective: Required<ContextConfig>;
  overrides: ContextConfig;
  diagnostics: string[];
};

export function readProjectSettings(rootDir: string): ProjectSettings {
  const configPath = projectConfigPath(rootDir);
  const defaults = createDefaultConfig(rootDir);
  const { overrides, diagnostics } = readConfigOverrides(configPath);
  const effective = mergeConfig(defaults, overrides);
  return {
    rootDir,
    configPath: relative(rootDir, configPath),
    hasConfig: existsSync(configPath),
    defaults,
    effective,
    overrides,
    diagnostics: [...diagnostics, ...validateConfig(createPaths(rootDir, { config: effective, configPath }))],
  };
}

export function writeProjectSettings(
  rootDir: string,
  body: Record<string, unknown>,
): { ok: true; settings: ProjectSettings } | { ok: false; diagnostics: unknown[] } {
  const parsed = parseConfigOverrides(body.overrides);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };

  const configPath = projectConfigPath(rootDir);
  const effective = mergeConfig(createDefaultConfig(rootDir), parsed.overrides);
  const validation = validateConfig(createPaths(rootDir, { config: effective, configPath }));
  if (validation.length > 0) return { ok: false, diagnostics: validation.map(settingsDiagnostic) };

  writeAtomicJsonFileSync(configPath, orderedConfig(parsed.overrides));
  return { ok: true, settings: readProjectSettings(rootDir) };
}

function projectConfigPath(rootDir: string): string {
  return path.join(rootDir, ConfigFileName);
}

function readConfigOverrides(configPath: string): { overrides: ContextConfig; diagnostics: string[] } {
  if (!existsSync(configPath)) return { overrides: {}, diagnostics: [] };

  try {
    const raw = JSON.parse(readFileSync(configPath, TextEncoding.Utf8));
    if (!isRecord(raw)) return { overrides: {}, diagnostics: [`${ConfigFileName} must contain a JSON object.`] };
    const parsed = parseConfigOverrides(raw);
    if (!parsed.ok) return { overrides: {}, diagnostics: parsed.diagnostics.map(diagnosticMessage) };
    return { overrides: parsed.overrides, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { overrides: {}, diagnostics: [`Could not parse ${ConfigFileName}: ${message}`] };
  }
}

function parseConfigOverrides(input: unknown): { ok: true; overrides: ContextConfig } | { ok: false; diagnostics: unknown[] } {
  if (!isRecord(input)) {
    return { ok: false, diagnostics: [settingsDiagnostic("settings overrides must be a JSON object.")] };
  }

  const diagnostics: unknown[] = [];
  const overrides: ContextConfig = {};

  for (const key of Object.keys(input)) {
    if (!allowedConfigFields.has(key as ConfigField)) diagnostics.push(settingsDiagnostic(`Unknown settings field: ${key}.`));
  }

  for (const field of stringConfigFields) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      diagnostics.push(settingsDiagnostic(`${field} must be a non-empty string.`));
      continue;
    }
    overrides[field] = value.trim();
  }

  for (const field of stringArrayConfigFields) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
      diagnostics.push(settingsDiagnostic(`${field} must be an array of non-empty strings.`));
      continue;
    }
    overrides[field] = value.map((item) => item.trim());
  }

  for (const field of numberConfigFields) {
    const value = input[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      diagnostics.push(settingsDiagnostic(`${field} must be a non-negative integer.`));
      continue;
    }
    overrides[field] = value;
  }

  const fileDiscovery = input[ConfigField.FileDiscovery];
  if (fileDiscovery !== undefined) {
    if (fileDiscovery !== FileDiscoveryMode.Git && fileDiscovery !== FileDiscoveryMode.Filesystem) {
      diagnostics.push(settingsDiagnostic(`${ConfigField.FileDiscovery} must be "${FileDiscoveryMode.Git}" or "${FileDiscoveryMode.Filesystem}".`));
    } else {
      overrides.fileDiscovery = fileDiscovery;
    }
  }

  const externalTools = input[ConfigField.ExternalTools];
  if (externalTools !== undefined) {
    if (!isRecord(externalTools)) {
      diagnostics.push(settingsDiagnostic(`${ConfigField.ExternalTools} must be an object.`));
    } else {
      const parsed: Record<string, ExternalTool> = {};
      for (const [name, command] of Object.entries(externalTools)) {
        const result = ExternalToolSchema.safeParse(trimExternalToolInput(command));
        if (result.success) {
          parsed[name] = result.data;
          continue;
        }
        diagnostics.push(settingsDiagnostic(`${ConfigField.ExternalTools}.${name} must be a command string, string array, or object with command.`));
      }
      overrides.externalTools = parsed;
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, overrides };
}

function mergeConfig(defaults: Required<ContextConfig>, overrides: ContextConfig): Required<ContextConfig> {
  return {
    ...defaults,
    ...overrides,
    projectFilePatterns: overrides.projectFilePatterns ?? defaults.projectFilePatterns,
    ignore: overrides.ignore ?? defaults.ignore,
    entrypoints: overrides.entrypoints ?? defaults.entrypoints,
    publicSurfaces: overrides.publicSurfaces ?? defaults.publicSurfaces,
    generated: overrides.generated ?? defaults.generated,
    externalTools: overrides.externalTools ?? defaults.externalTools,
    requiredPackageScripts: overrides.requiredPackageScripts ?? defaults.requiredPackageScripts,
    fileDiscovery: overrides.fileDiscovery ?? defaults.fileDiscovery,
    maxFiles: overrides.maxFiles ?? defaults.maxFiles,
    maxFileSizeKb: overrides.maxFileSizeKb ?? defaults.maxFileSizeKb,
  };
}

function orderedConfig(config: ContextConfig): ContextConfig {
  const ordered: ContextConfig = {};
  for (const field of allowedConfigFields) {
    const value = config[field];
    if (value !== undefined) ordered[field] = value as never;
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimExternalToolInput(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item.trim() : item));
  if (!isRecord(value)) return value;
  return {
    ...value,
    command: trimExternalToolInput(value.command),
    versionArgs: Array.isArray(value.versionArgs) ? value.versionArgs.map((item) => (typeof item === "string" ? item.trim() : item)) : value.versionArgs,
  };
}

function settingsDiagnostic(message: string) {
  return createOpenCanonDiagnostic({ code: "config-invalid", message });
}

function diagnosticMessage(diagnostic: unknown): string {
  if (isRecord(diagnostic) && typeof diagnostic.message === "string") return diagnostic.message;
  return String(diagnostic);
}
