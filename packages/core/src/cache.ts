import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeAtomicJsonFileSync } from "./atomic.ts";
import type { ContextPaths } from "./core.ts";

const cacheVersion = 1;
const parserVersion = "opencanon-parser";

type CacheFile = {
  version: number;
  entries: Record<string, CacheRecord>;
};

type CacheRecord = {
  path: string;
  size: number;
  mtimeMs: number;
  parserVersion: string;
  configHash: string;
  values: Record<string, unknown>;
};

export type AnalysisCache = {
  get<T>(file: string, key: string): T | undefined;
  set(file: string, key: string, value: unknown): void;
  flush(): void;
};

const caches = new Map<string, AnalysisCache>();

export function getAnalysisCache(paths: ContextPaths): AnalysisCache {
  const cachePath = path.join(paths.cacheDir, "analysis.json");
  const existing = caches.get(cachePath);
  if (existing) return existing;

  const configHash = hashJson({
    projectFilePatterns: paths.projectFilePatterns,
    ignore: paths.ignore,
    maxFileSizeKb: paths.maxFileSizeKb,
    fileDiscovery: paths.fileDiscovery,
  });
  let cacheFile = readCacheFile(cachePath);
  let dirty = false;

  function recordFor(file: string): CacheRecord | undefined {
    const absolutePath = path.join(paths.rootDir, file);
    if (!existsSync(absolutePath)) return undefined;
    const stats = statSync(absolutePath);
    const record = cacheFile.entries[file];
    if (
      record &&
      record.size === stats.size &&
      record.mtimeMs === stats.mtimeMs &&
      record.parserVersion === parserVersion &&
      record.configHash === configHash
    ) {
      return record;
    }
    return {
      path: file,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      parserVersion,
      configHash,
      values: {},
    };
  }

  const cache: AnalysisCache = {
    get<T>(file: string, key: string) {
      return recordFor(file)?.values[key] as T | undefined;
    },
    set(file: string, key: string, value: unknown) {
      const record = recordFor(file);
      if (!record) return;
      record.values[key] = value;
      cacheFile.entries[file] = record;
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      writeAtomicJsonFileSync(cachePath, cacheFile);
      dirty = false;
    },
  };

  caches.set(cachePath, cache);
  return cache;
}

function readCacheFile(cachePath: string): CacheFile {
  if (!existsSync(cachePath)) return { version: cacheVersion, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile;
    if (parsed.version !== cacheVersion || !isRecord(parsed.entries)) return { version: cacheVersion, entries: {} };
    return parsed;
  } catch {
    return { version: cacheVersion, entries: {} };
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
