import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AnalysisCache } from "./cache.ts";
import { matchesAny, normalizePath } from "./core.ts";
import type { Profiler } from "./profiler.ts";
import { createProjectFile, parseJsonRead } from "./project-files.ts";
import { isSupportedSourceFile } from "./discovery.ts";
import type { FileRead, JsonRead, ProjectFile, Validator } from "./validator-types.ts";

export function readContextText(params: {
  rootDir: string;
  filePath: string;
  filesByPath: Map<string, ProjectFile>;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache;
  profiler?: Profiler;
}): FileRead {
  const filePath = normalizePath(params.filePath);
  const existing = params.filesByPath.get(filePath);
  if (existing) {
    return {
      path: existing.path,
      file: existing,
      text: existing.text,
      diagnostics: [],
    };
  }

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(params.rootDir, filePath);
  if (!existsSync(absolutePath)) {
    return {
      path: filePath,
      diagnostics: [`File not found: ${filePath}`],
    };
  }

  const file = createProjectFile({
    rootDir: params.rootDir,
    file: filePath,
    validator: params.validator,
    cache: params.cache,
    profiler: params.profiler,
  });
  return {
    path: file.path,
    file,
    text: file.text,
    diagnostics: [],
  };
}

export function readContextJson<T>(params: {
  rootDir: string;
  filePath: string;
  filesByPath: Map<string, ProjectFile>;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache;
  profiler?: Profiler;
}): JsonRead<T> {
  const file = readContextText(params);
  if (!file.text) {
    return {
      path: file.path,
      file: file.file,
      diagnostics: file.diagnostics,
    };
  }

  return {
    ...parseJsonRead<T>(file.path, file.text, file.path),
    file: file.file,
  };
}

export function listKnownContextFiles(rootDir: string, files: ProjectFile[], patterns: string[], predicate: (file: string) => boolean): string[] {
  const candidates = new Set(files.map((file) => file.path));
  for (const file of rootContextFiles(rootDir)) candidates.add(file);

  return [...candidates]
    .filter((file) => predicate(file))
    .filter((file) => matchesAny(file, patterns))
    .sort();
}

export function rootContextFiles(rootDir: string): string[] {
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(isSupportedSourceFile)
      .sort();
  } catch {
    return [];
  }
}


