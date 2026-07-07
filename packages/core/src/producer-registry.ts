import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseVersionParts } from "./core-utils.ts";
import { ProjectFileLanguage, type LanguageId } from "./language-registry.ts";
import { ProducerStatusKind, type ProducerStatus } from "./type-facts-provider.ts";

export type ProducerVersionRange = {
  minimum: string;
  maximumExclusiveMajor: number;
  display: string;
};

export type ProducerPackageToolchain = {
  packageName: string;
  displayName: string;
  packageJsonSubpath: string;
  versionRange: ProducerVersionRange;
};

export type ProducerRequiredConfig = {
  defaultPath: (rootDir: string) => string;
  missingKind: ProducerStatusKind;
  missingDetail: (configPath: string) => string;
};

export const ProducerRunProfile = {
  Batch: "batch",
  Interactive: "interactive",
} as const;
export type ProducerRunProfile = (typeof ProducerRunProfile)[keyof typeof ProducerRunProfile];

export const ProducerSourceKind = {
  Artifact: "artifact",
  Live: "live",
  NotImplemented: "not-implemented",
} as const;
export type ProducerSourceKind = (typeof ProducerSourceKind)[keyof typeof ProducerSourceKind];

export const ProducerArtifactId = {
  TypedComparisons: "typed-comparisons",
} as const;
export type ProducerArtifactId = (typeof ProducerArtifactId)[keyof typeof ProducerArtifactId];

export const ProducerLiveWorkerId = {
  TypeScriptWatch: "typescript-watch",
} as const;
export type ProducerLiveWorkerId = (typeof ProducerLiveWorkerId)[keyof typeof ProducerLiveWorkerId];

export const ProducerArtifactFreshness = {
  Tsconfig: "tsconfig",
  PackageVersion: "package-version",
  SourceFingerprints: "source-fingerprints",
  MembershipHash: "membership-hash",
} as const;
export type ProducerArtifactFreshness = (typeof ProducerArtifactFreshness)[keyof typeof ProducerArtifactFreshness];

export type ProducerArtifactDefinition = {
  id: ProducerArtifactId;
  path: (rootDir: string) => string;
  generateCommand: string;
  freshness: readonly ProducerArtifactFreshness[];
};

export type ProducerLiveWorkerDefinition = {
  id: ProducerLiveWorkerId;
  kind: "watch-program";
};

export type ProducerSource =
  | { kind: typeof ProducerSourceKind.Artifact; id: ProducerArtifactId }
  | { kind: typeof ProducerSourceKind.Live; worker: ProducerLiveWorkerId }
  | { kind: typeof ProducerSourceKind.NotImplemented; detail?: string };

export type ProducerPolicy = {
  profile: ProducerRunProfile;
  sources: Partial<Record<LanguageId, ProducerSource>>;
};

export type ProducerDefinition = {
  language: LanguageId;
  providerId: string;
  packageToolchain?: ProducerPackageToolchain;
  requiredConfig?: ProducerRequiredConfig;
  artifacts: Partial<Record<ProducerArtifactId, ProducerArtifactDefinition>>;
  liveWorkers: Partial<Record<ProducerLiveWorkerId, ProducerLiveWorkerDefinition>>;
};

export const SupportedTypeScriptVersionRange = {
  Minimum: "5.0.0",
  MaximumExclusiveMajor: 7,
  Display: ">=5.0.0 <7.0.0",
} as const;

const TypeScriptProducerDefinition: ProducerDefinition = {
  language: ProjectFileLanguage.TypeScript,
  providerId: "typescript-type-producer",
  packageToolchain: {
    packageName: "typescript",
    displayName: "TypeScript",
    packageJsonSubpath: "typescript/package.json",
    versionRange: {
      minimum: SupportedTypeScriptVersionRange.Minimum,
      maximumExclusiveMajor: SupportedTypeScriptVersionRange.MaximumExclusiveMajor,
      display: SupportedTypeScriptVersionRange.Display,
    },
  },
  requiredConfig: {
    defaultPath: (rootDir) => path.join(rootDir, "tsconfig.json"),
    missingKind: ProducerStatusKind.MissingTsconfig,
    missingDetail: (configPath) => `no tsconfig at ${configPath}.`,
  },
  artifacts: {
    [ProducerArtifactId.TypedComparisons]: {
      id: ProducerArtifactId.TypedComparisons,
      path: (rootDir) => path.join(rootDir, ".opencanon/cache/typed-comparisons.json"),
      generateCommand: "opencanon analyze --typed",
      freshness: [
        ProducerArtifactFreshness.Tsconfig,
        ProducerArtifactFreshness.PackageVersion,
        ProducerArtifactFreshness.SourceFingerprints,
        ProducerArtifactFreshness.MembershipHash,
      ],
    },
  },
  liveWorkers: {
    [ProducerLiveWorkerId.TypeScriptWatch]: {
      id: ProducerLiveWorkerId.TypeScriptWatch,
      kind: "watch-program",
    },
  },
};

const ProducerDefinitions: ProducerDefinition[] = [TypeScriptProducerDefinition];

const NotImplementedProducerSource = { kind: ProducerSourceKind.NotImplemented } as const;

export const BatchProducerPolicy: ProducerPolicy = {
  profile: ProducerRunProfile.Batch,
  sources: {
    [ProjectFileLanguage.TypeScript]: { kind: ProducerSourceKind.Artifact, id: ProducerArtifactId.TypedComparisons },
    [ProjectFileLanguage.Svelte]: NotImplementedProducerSource,
    [ProjectFileLanguage.Python]: NotImplementedProducerSource,
  },
};

export const InteractiveProducerPolicy: ProducerPolicy = {
  profile: ProducerRunProfile.Interactive,
  sources: {
    [ProjectFileLanguage.TypeScript]: { kind: ProducerSourceKind.Live, worker: ProducerLiveWorkerId.TypeScriptWatch },
    [ProjectFileLanguage.Svelte]: NotImplementedProducerSource,
    [ProjectFileLanguage.Python]: NotImplementedProducerSource,
  },
};

export function producerDefinitions(): readonly ProducerDefinition[] {
  return ProducerDefinitions;
}

export function producerDefinitionForLanguage(language: string): ProducerDefinition | undefined {
  return ProducerDefinitions.find((definition) => definition.language === language);
}

export function producerSourceForLanguage(policy: ProducerPolicy, language: string): ProducerSource {
  return policy.sources[language as LanguageId] ?? { kind: ProducerSourceKind.NotImplemented, detail: `${language} is not configured in the ${policy.profile} producer policy.` };
}

export function producerDefinitionHasArtifact(definition: ProducerDefinition, artifactId: ProducerArtifactId): boolean {
  return Boolean(definition.artifacts[artifactId]);
}

export function producerDefinitionHasLiveWorker(definition: ProducerDefinition, workerId: ProducerLiveWorkerId): boolean {
  return Boolean(definition.liveWorkers[workerId]);
}

export function producerPackageJsonPath(definition: ProducerDefinition, rootDir: string): string | null {
  const toolchain = definition.packageToolchain;
  if (!toolchain) return null;
  try {
    return createRequire(path.join(rootDir, "package.json")).resolve(toolchain.packageJsonSubpath);
  } catch {
    return null;
  }
}

export function installedProducerPackageVersion(definition: ProducerDefinition, rootDir: string): string | null {
  const packageJsonPath = producerPackageJsonPath(definition, rootDir);
  if (!packageJsonPath || !existsSync(packageJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function producerPackageVersionSupport(
  definition: ProducerDefinition,
  version: string,
): { supported: boolean; detail?: string } {
  const toolchain = definition.packageToolchain;
  if (!toolchain) return { supported: true };
  const range = toolchain.versionRange;
  const parts = parseVersionParts(version);
  if (!parts) {
    return {
      supported: false,
      detail: `OpenCanon supports ${toolchain.displayName} ${range.display}; found ${version}.`,
    };
  }
  const [major] = parts;
  const minimumMajor = Number(range.minimum.split(".")[0]);
  const supported = major >= minimumMajor && major < range.maximumExclusiveMajor;
  return supported
    ? { supported: true }
    : {
        supported: false,
        detail: `OpenCanon supports ${toolchain.displayName} ${range.display}; found ${version}.`,
      };
}

export function producerSetupStatus(
  definition: ProducerDefinition,
  rootDir: string,
  options: { configPath?: string; missingConfigDetail?: (configPath: string) => string } = {},
): ProducerStatus | null {
  const configPath = options.configPath ?? definition.requiredConfig?.defaultPath(rootDir);
  if (definition.requiredConfig && configPath && !existsSync(configPath)) {
    return {
      language: definition.language,
      kind: definition.requiredConfig.missingKind,
      detail: (options.missingConfigDetail ?? definition.requiredConfig.missingDetail)(configPath),
    };
  }
  if (definition.packageToolchain) {
    const version = installedProducerPackageVersion(definition, rootDir);
    if (!version) {
      return {
        language: definition.language,
        kind: ProducerStatusKind.MissingPackage,
        detail: `\`${definition.packageToolchain.packageName}\` is not resolvable from the project root.`,
      };
    }
    const support = producerPackageVersionSupport(definition, version);
    if (!support.supported) {
      return {
        language: definition.language,
        kind: ProducerStatusKind.UnsupportedPackage,
        detail: support.detail,
      };
    }
  }
  return null;
}

export function isProducerToolchainAvailable(definition: ProducerDefinition, rootDir: string, options: { configPath?: string } = {}): boolean {
  return producerSetupStatus(definition, rootDir, options) === null;
}

export function installedTypeScriptPackageJsonPath(rootDir: string): string | null {
  return producerPackageJsonPath(TypeScriptProducerDefinition, rootDir);
}

export function installedTypeScriptVersion(rootDir: string): string | null {
  return installedProducerPackageVersion(TypeScriptProducerDefinition, rootDir);
}

export function isSupportedTypeScriptVersion(version: string): boolean {
  return producerPackageVersionSupport(TypeScriptProducerDefinition, version).supported;
}

export function unsupportedTypeScriptVersionDetail(version: string): string {
  return producerPackageVersionSupport(TypeScriptProducerDefinition, version).detail ?? "";
}

export function typeScriptVersionSupport(version: string): { supported: boolean; detail?: string } {
  return producerPackageVersionSupport(TypeScriptProducerDefinition, version);
}
