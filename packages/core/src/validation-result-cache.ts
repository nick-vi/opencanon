import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeAtomicJsonFileSync } from "./atomic.ts";
import type { ContextPaths } from "./context.ts";
import type { ProducerSnapshot } from "./type-facts-provider.ts";
import type { CommitGate, Finding, Validator } from "./validator-types.ts";
import type { ValidatorOutcome } from "./validation.ts";

const cacheVersion = 1;
const maxEntries = 10_000;

type ValidationResultCacheFile = {
  version: number;
  entries: Record<string, ValidationResultCacheRecord>;
};

type ValidationResultCacheRecord = {
  key: string;
  createdAt: number;
  accessedAt: number;
  result: CachedValidatorResult;
};

export type CachedValidatorResult = {
  findings: Finding[];
  commitGates: CommitGate[];
  outcomes: ValidatorOutcome[];
};

export type ValidatorRunCacheKeyInput = {
  rootDir: string;
  paths: ContextPaths;
  projectFiles: string[];
  targetFiles: string[];
  analysisFiles: string[];
  project: boolean;
  strictProducers: boolean;
  validator: Validator;
  producerSnapshot: ProducerSnapshot;
  runtimeFingerprint: string;
};

export type ValidationResultCache = {
  get(key: string): CachedValidatorResult | undefined;
  set(key: string, result: CachedValidatorResult): void;
  flush(): void;
};

const caches = new Map<string, ValidationResultCache>();

export function getValidationResultCache(paths: ContextPaths): ValidationResultCache {
  const cachePath = path.join(paths.cacheDir, "validation-results.json");
  const existing = caches.get(cachePath);
  if (existing) return existing;

  let cacheFile = readCacheFile(cachePath);
  let dirty = false;

  const cache: ValidationResultCache = {
    get(key) {
      const record = cacheFile.entries[key];
      if (!record) return undefined;
      record.accessedAt = Date.now();
      dirty = true;
      return cloneCachedResult(record.result);
    },
    set(key, result) {
      cacheFile.entries[key] = {
        key,
        createdAt: Date.now(),
        accessedAt: Date.now(),
        result: cloneCachedResult(result),
      };
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      cacheFile = prune(cacheFile);
      writeAtomicJsonFileSync(cachePath, cacheFile);
      dirty = false;
    },
  };

  caches.set(cachePath, cache);
  return cache;
}

export function validatorRunCacheKey(input: ValidatorRunCacheKeyInput): string {
  return hashStable({
    version: cacheVersion,
    rootDir: input.rootDir,
    config: {
      projectFilePatterns: input.paths.projectFilePatterns,
      ignore: input.paths.ignore,
      fileDiscovery: input.paths.fileDiscovery,
      maxFiles: input.paths.maxFiles,
      maxFileSizeKb: input.paths.maxFileSizeKb,
    },
    project: input.project,
    strictProducers: input.strictProducers,
    targetFiles: [...input.targetFiles].sort(),
    analysisFiles: [...input.analysisFiles].sort(),
    projectFiles: fingerprintFiles(input.rootDir, input.projectFiles),
    contextFiles: fingerprintFiles(input.rootDir, contextFiles(input.paths)),
    validator: validatorFingerprint(input.validator),
    producerSnapshot: input.producerSnapshot,
    runtime: input.runtimeFingerprint,
  });
}

export function validationRuntimeFingerprint(value: unknown): string {
  return hashStable(value);
}

function validatorFingerprint(validator: Validator): string {
  return hashStable({
    id: validator.id,
    topics: validator.topics,
    appliesScopes: validator.appliesScopes,
    domain: validator.domain,
    analysisGlobs: validator.analysisGlobs,
    severity: validator.severity,
    scope: validator.scope,
    facts: validator.facts,
    conventionIds: validator.conventionIds,
    docs: validator.docs,
    summary: validator.summary,
    visuals: validator.visuals,
    requiresProducers: validator.requiresProducers,
    fixtures: validator.fixtures,
    validate: Function.prototype.toString.call(validator.validate),
  });
}

function contextFiles(paths: ContextPaths): string[] {
  const files = [
    paths.configPath,
    paths.conventionsPath,
    paths.areasPath,
    paths.specsPath,
    paths.changesPath,
    paths.impactSurfacesPath,
    paths.proposedImpactNotesPath,
    paths.baselinePath,
  ];
  return files
    .filter((file): file is string => Boolean(file))
    .map((file) => (path.isAbsolute(file) ? path.relative(paths.rootDir, file) : file));
}

function fingerprintFiles(rootDir: string, files: string[]): Array<{ path: string; exists: boolean; size?: number; mtimeMs?: number }> {
  return [...new Set(files)]
    .sort()
    .map((file) => {
      const normalized = file.split(path.sep).join("/");
      const absolutePath = path.isAbsolute(normalized) ? normalized : path.join(rootDir, normalized);
      if (!existsSync(absolutePath)) return { path: normalized, exists: false };
      const stats = statSync(absolutePath);
      return {
        path: normalized,
        exists: true,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    });
}

function readCacheFile(cachePath: string): ValidationResultCacheFile {
  if (!existsSync(cachePath)) return { version: cacheVersion, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ValidationResultCacheFile;
    if (parsed.version !== cacheVersion || !isRecord(parsed.entries)) return { version: cacheVersion, entries: {} };
    return parsed;
  } catch {
    return { version: cacheVersion, entries: {} };
  }
}

function prune(cacheFile: ValidationResultCacheFile): ValidationResultCacheFile {
  const records = Object.values(cacheFile.entries);
  if (records.length <= maxEntries) return cacheFile;
  const kept = records
    .sort((left, right) => right.accessedAt - left.accessedAt)
    .slice(0, maxEntries);
  return {
    version: cacheVersion,
    entries: Object.fromEntries(kept.map((record) => [record.key, record])),
  };
}

function cloneCachedResult(result: CachedValidatorResult): CachedValidatorResult {
  return JSON.parse(JSON.stringify(result)) as CachedValidatorResult;
}

function hashStable(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
