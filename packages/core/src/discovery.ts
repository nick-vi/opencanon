import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ContextPaths } from "./core.ts";
import { GitProjectFileArgs, getGitRoot, runGitFiles, toRealRootRelative } from "./git.ts";
import { matchesPath } from "./globs.ts";

export const FileDiscoveryMode = {
  Git: "git",
  Filesystem: "filesystem",
} as const;
export type FileDiscoveryMode = (typeof FileDiscoveryMode)[keyof typeof FileDiscoveryMode];

export type ProjectFileDiscovery = {
  files: string[];
  source: FileDiscoveryMode;
  diagnostics: string[];
  failed: boolean;
};

// The single list of file extensions OpenCanon surfaces to validators: every
// language-registry source language (incl. .mts/.cts/.mjs/.cjs) plus a text bucket
// (.rs/.css/...) with no descriptor that is still worth reporting on. Both the
// discovery glob and the isSupportedSourceFile predicate derive from THIS, so they
// can never drift.
const sourceFileExtensions = ["ts", "tsx", "mts", "cts", "mjs", "cjs", "js", "jsx", "py", "rs", "svelte", "css", "scss", "sass", "less", "json", "md", "markdown"] as const;
const sourceExtensions = `{${sourceFileExtensions.join(",")}}`;
const sourceExtensionPattern = new RegExp(`\\.(${sourceFileExtensions.join("|")})$`);
const ProjectFileName = {
  PackageJson: "package.json",
} as const;
const TextEncoding = {
  Utf8: "utf8",
} as const;

export function defaultProjectFilePatterns(rootDir: string): string[] {
  const rootPatterns = [
    `src/**/*.${sourceExtensions}`,
    `tests/**/*.${sourceExtensions}`,
    "docs/**/*.{md,markdown}",
    "*.{md,markdown}",
    ProjectFileName.PackageJson,
    "tsconfig*.json",
  ];
  const workspaceRoots = workspaceRootPatterns(rootDir);
  const workspacePatterns = workspaceRoots.flatMap((workspaceRoot) => [
    `${workspaceRoot}/**/*.${sourceExtensions}`,
    `${workspaceRoot}/${ProjectFileName.PackageJson}`,
    `${workspaceRoot}/tsconfig*.json`,
  ]);

  return unique([...rootPatterns, ...workspacePatterns]);
}

export function listFiles(dir: string, predicate: (file: string) => boolean, shouldSkipDirectory?: (dir: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(file);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (shouldSkipDirectory?.(file)) continue;
      output.push(...listFiles(file, predicate, shouldSkipDirectory));
    }
    if (stats.isFile() && predicate(file)) output.push(file);
  }
  return output.sort();
}

export function listProjectFiles(paths: ContextPaths, predicate = isSupportedSourceFile): string[] {
  const result = discoverProjectFiles(paths, predicate);
  if (result.failed) fail(result.diagnostics.join("\n"));
  return result.files;
}

export function discoverProjectFiles(paths: ContextPaths, predicate = isSupportedSourceFile): ProjectFileDiscovery {
  const diagnostics: string[] = [];
  if (paths.fileDiscovery !== FileDiscoveryMode.Git && paths.fileDiscovery !== FileDiscoveryMode.Filesystem) {
    diagnostics.push(`Project file discovery failed: fileDiscovery must be "${FileDiscoveryMode.Git}" or "${FileDiscoveryMode.Filesystem}", found ${String(paths.fileDiscovery)}.`);
    return { files: [], source: FileDiscoveryMode.Filesystem, diagnostics, failed: true };
  }

  const source = paths.fileDiscovery === FileDiscoveryMode.Git ? FileDiscoveryMode.Git : FileDiscoveryMode.Filesystem;
  const gitRoot = source === FileDiscoveryMode.Git ? getGitRoot(paths.rootDir) : null;

  if (source === FileDiscoveryMode.Git && !gitRoot) {
    diagnostics.push(
      `Project file discovery failed: fileDiscovery is "${FileDiscoveryMode.Git}" but no Git repository was found for ${paths.rootDir}. Set fileDiscovery to "${FileDiscoveryMode.Filesystem}" to opt into filesystem discovery.`,
    );
    return { files: [], source, diagnostics, failed: true };
  }

  const files = source === FileDiscoveryMode.Git ? gitProjectFiles(paths, gitRoot) : filesystemProjectFiles(paths, predicate);
  const selectedFiles: string[] = [];
  const maxBytes = paths.maxFileSizeKb * 1024;

  for (const file of files) {
    if (!matchesProjectFileScope(paths, file, predicate)) continue;

    const absolutePath = path.join(paths.rootDir, file);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolutePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (paths.maxFileSizeKb > 0 && stats.size > maxBytes) {
      diagnostics.push(`Skipped ${file}: file size ${Math.ceil(stats.size / 1024)}KB exceeds maxFileSizeKb ${paths.maxFileSizeKb}.`);
      continue;
    }
    selectedFiles.push(file);
  }

  const uniqueFiles = unique(selectedFiles).sort();
  if (paths.maxFiles > 0 && uniqueFiles.length > paths.maxFiles) {
    diagnostics.push(`Project file limit exceeded: ${uniqueFiles.length} files match, maxFiles is ${paths.maxFiles}.`);
    return { files: uniqueFiles.slice(0, paths.maxFiles), source, diagnostics, failed: true };
  }

  return { files: uniqueFiles, source, diagnostics, failed: false };
}

export function matchesProjectFileScope(paths: ContextPaths, file: string, predicate = isSupportedSourceFile): boolean {
  const normalized = normalizePath(file);
  if (!predicate(normalized)) return false;
  if (!matchesAny(normalized, paths.projectFilePatterns)) return false;
  return !matchesAny(normalized, paths.ignore);
}

function workspaceRootPatterns(rootDir: string): string[] {
  const packageJson = readRootPackageJson(rootDir);
  const workspacePatterns = packageJson ? readWorkspacePatterns(packageJson) : [];
  if (workspacePatterns.length > 0) return workspacePatterns;
  return ["apps/*", "packages/*"];
}

function readRootPackageJson(rootDir: string): Record<string, unknown> | null {
  const packageJsonPath = path.join(rootDir, ProjectFileName.PackageJson);
  if (!existsSync(packageJsonPath)) return null;
  try {
    const value = JSON.parse(readFileSync(packageJsonPath, TextEncoding.Utf8)) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readWorkspacePatterns(packageJson: Record<string, unknown>): string[] {
  const workspaces = packageJson.workspaces;
  const raw = Array.isArray(workspaces)
    ? workspaces
    : isRecord(workspaces) && Array.isArray(workspaces.packages)
      ? workspaces.packages
      : [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter((item) => item.length > 0 && !item.startsWith("!"));
}

function filesystemProjectFiles(paths: ContextPaths, predicate: (file: string) => boolean): string[] {
  const shouldSkipDirectory = (dir: string) => {
    const relativeDir = relative(paths.rootDir, dir);
    return relativeDir.length > 0 && matchesAny(`${relativeDir}/__dir__`, paths.ignore);
  };
  return listFiles(paths.rootDir, predicate, shouldSkipDirectory)
    .map((file) => relative(paths.rootDir, file))
    .sort();
}

function gitProjectFiles(paths: ContextPaths, gitRoot: string | null): string[] {
  if (!gitRoot) return [];
  return runGitFiles(gitRoot, GitProjectFileArgs)
    .map((file) => toRealRootRelative(paths.rootDir, path.join(gitRoot, file)))
    .filter((file) => !file.startsWith("..") && !path.isAbsolute(file))
    .sort();
}

function matchesAny(file: string, globs: string[]): boolean {
  return matchesPath(file, globs);
}

/** The project files OpenCanon surfaces to validators (see sourceFileExtensions).
 * Single source; imported by project-files rather than redefined. */
export function isSupportedSourceFile(file: string): boolean {
  return sourceExtensionPattern.test(file);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function relative(rootDir: string, value: string): string {
  return normalizePath(path.relative(rootDir, value));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
