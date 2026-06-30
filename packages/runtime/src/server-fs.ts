import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInsideRoot, safeRelativePath } from "@opencanon/core";
import type { RuntimeSnapshot } from "./snapshot.ts";
import { UrlSearchParam, diagnostic, diagnosticCodes, json, type RuntimeError } from "./routes.ts";

const maxFileBytes = 2 * 1024 * 1024;
const serverTextEncoding = "utf8" as const;
const GitCommand = { Git: "git" } as const;
const GitSubcommand = { LsFiles: "ls-files", RevParse: "rev-parse" } as const;
const GitArg = { Cached: "--cached", Directory: "-C", ExcludeStandard: "--exclude-standard", Others: "--others", ShowTopLevel: "--show-toplevel" } as const;
const GitInventoryArgs = [GitSubcommand.LsFiles, GitArg.Cached, GitArg.Others, GitArg.ExcludeStandard] as const;
export const TreeScope = { All: "all", Canon: "canon" } as const;
export type TreeScope = (typeof TreeScope)[keyof typeof TreeScope];
const TreeSortLocaleOptions: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };
const TreeHiddenFilePrefixes = [] as const;
const FileExtension = { Cjs: ".cjs", Css: ".css", Cts: ".cts", Html: ".html", Js: ".js", Json: ".json", Jsx: ".jsx", Markdown: ".markdown", Md: ".md", Mjs: ".mjs", Mts: ".mts", Py: ".py", Rs: ".rs", Toml: ".toml", Ts: ".ts", Tsx: ".tsx", Yaml: ".yaml", Yml: ".yml" } as const;

export type TreeEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  indexed: boolean;
  findingCount: number;
  language?: string;
};

export type TreeResponse = {
  path: string;
  entries: TreeEntry[];
};

export type FileResponse = {
  path: string;
  language: string;
  bytes: number;
  content: string;
};

export function validateRelativePath(
  input: string,
  options: { allowEmpty: boolean },
): { ok: true; path: string } | { ok: false; error: RuntimeError } {
  const safe = safeRelativePath(input, options);
  if (safe.ok) return safe;
  return {
    ok: false,
    error: diagnostic(diagnosticCodes.invalidRuntimeResponse, safe.message),
  };
}

export function validateRelativePaths(inputs: string[]): { ok: true; paths: string[] } | { ok: false; error: RuntimeError } {
  if (inputs.length === 0) {
    return {
      ok: false,
      error: diagnostic(diagnosticCodes.invalidRuntimeResponse, "At least one file path is required."),
    };
  }

  const paths: string[] = [];
  for (const input of inputs) {
    const safe = validateRelativePath(input, { allowEmpty: false });
    if (!safe.ok) return safe;
    paths.push(safe.path);
  }
  return { ok: true, paths };
}

export function validateOptionalRelativePaths(inputs: string[]): { ok: true; paths: string[] } | { ok: false; error: RuntimeError } {
  const paths: string[] = [];
  for (const input of inputs) {
    const safe = validateRelativePath(input, { allowEmpty: false });
    if (!safe.ok) return safe;
    paths.push(safe.path);
  }
  return { ok: true, paths };
}

export function validateCommitHash(input: string): { ok: true; commit: string } | { ok: false; error: RuntimeError } {
  const commit = input.trim();
  if (!commit) {
    return {
      ok: false,
      error: diagnostic(diagnosticCodes.invalidRuntimeResponse, "Commit is required."),
    };
  }
  if (!/^[a-f0-9]{7,40}$/i.test(commit)) {
    return {
      ok: false,
      error: diagnostic(diagnosticCodes.invalidRuntimeResponse, "Commit must be a 7 to 40 character Git hash."),
    };
  }
  return { ok: true, commit };
}

export function treeScopeParam(url: URL): TreeScope {
  return url.searchParams.get(UrlSearchParam.Scope) === TreeScope.Canon ? TreeScope.Canon : TreeScope.All;
}

export type ProjectInventory = { ok: true; files: string[] } | { ok: false; error: RuntimeError };

export function listProjectInventory(cwd: string): ProjectInventory {
  const root = path.resolve(cwd);
  const gitRootResult = spawnSync(GitCommand.Git, [GitArg.Directory, root, GitSubcommand.RevParse, GitArg.ShowTopLevel], {
    encoding: serverTextEncoding,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (gitRootResult.status !== 0) {
    return {
      ok: false,
      error: diagnostic(diagnosticCodes.projectInventoryFailed, gitRootResult.stderr.trim() || `Could not locate a Git root for ${root}.`),
    };
  }

  const gitRoot = gitRootResult.stdout.trim();
  if (!gitRoot) {
    return {
      ok: false,
      error: diagnostic(diagnosticCodes.projectInventoryFailed, `Could not locate a Git root for ${root}.`),
    };
  }

  const filesResult = spawnSync(GitCommand.Git, [GitArg.Directory, gitRoot, ...GitInventoryArgs], {
    encoding: serverTextEncoding,
    timeout: 10_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (filesResult.status !== 0) {
    return {
      ok: false,
      error: diagnostic(diagnosticCodes.projectInventoryFailed, filesResult.stderr.trim() || `Could not list Git-visible files for ${root}.`),
    };
  }

  const files = filesResult.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => path.relative(root, path.join(gitRoot, file)))
    .map(toSlashPath)
    .filter((file) => file.length > 0 && !file.startsWith("..") && !path.isAbsolute(file))
    .filter((file) => existsSync(path.join(root, file)))
    .sort((a, b) => a.localeCompare(b));

  return { ok: true, files: [...new Set(files)] };
}

export function buildTreeResponse(dirPath: string, projectFiles: string[], snapshot: RuntimeSnapshot, options: { query: string; showDotEntries: boolean; withFindingsOnly?: boolean }): TreeResponse {
  const prefix = dirPath === "" ? "" : `${dirPath}/`;
  const visibleFiles = filterTreeFiles(projectFiles, options);
  const indexedFiles = new Set(snapshot.files);
  const childDirs = new Map<string, { findingCount: number; indexed: boolean }>();
  const directFiles: TreeEntry[] = [];
  const findingByFile = new Map<string, number>();
  for (const finding of snapshot.findings) {
    if (!finding.file) continue;
    findingByFile.set(finding.file, (findingByFile.get(finding.file) ?? 0) + 1);
  }
  for (const file of visibleFiles) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      directFiles.push({
        name: rest,
        path: file,
        kind: "file",
        indexed: indexedFiles.has(file),
        findingCount: findingByFile.get(file) ?? 0,
        language: detectLanguage(rest),
      });
    } else {
      const name = rest.slice(0, slash);
      const dirKey = `${prefix}${name}`;
      const current = childDirs.get(dirKey) ?? {
        findingCount: 0,
        indexed: false,
      };
      current.findingCount += findingByFile.get(file) ?? 0;
      current.indexed = current.indexed || indexedFiles.has(file);
      childDirs.set(dirKey, current);
    }
  }
  const dirEntries: TreeEntry[] = [...childDirs.entries()]
    .filter(([, info]) => (options.withFindingsOnly ? info.findingCount > 0 : true))
    .map(([dirKey, info]) => compactTreeDirectoryEntry(dirKey, prefix, visibleFiles, info));
  const filteredFiles = options.withFindingsOnly ? directFiles.filter((entry) => entry.findingCount > 0) : directFiles;
  const entries = [...dirEntries.sort(compareTreeEntryName), ...filteredFiles.sort(compareTreeEntryName)];
  return { path: dirPath, entries };
}

export function compareTreeEntryName(left: TreeEntry, right: TreeEntry): number {
  return left.name.localeCompare(right.name, undefined, TreeSortLocaleOptions);
}

export function compactTreeDirectoryEntry(dirKey: string, prefix: string, files: string[], info: { findingCount: number; indexed: boolean }): TreeEntry {
  let pathValue = dirKey;
  let name = dirKey.slice(prefix.length);

  while (true) {
    const childPrefix = `${pathValue}/`;
    let directFileCount = 0;
    const childDirectories = new Set<string>();
    for (const file of files) {
      if (!file.startsWith(childPrefix)) continue;
      const rest = file.slice(childPrefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        directFileCount += 1;
      } else {
        childDirectories.add(rest.slice(0, slash));
      }
      if (directFileCount > 0 || childDirectories.size > 1) break;
    }

    if (directFileCount > 0 || childDirectories.size !== 1) break;
    const onlyChild = [...childDirectories][0];
    pathValue = `${pathValue}/${onlyChild}`;
    name = `${name}/${onlyChild}`;
  }

  return {
    name,
    path: pathValue,
    kind: "dir",
    indexed: info.indexed,
    findingCount: info.findingCount,
  };
}

export function filterTreeFiles(files: string[], options: { query: string; showDotEntries: boolean }): string[] {
  const query = options.query.trim().toLowerCase();
  return files.filter((file) => {
    if (isHiddenTreeFile(file)) return false;
    if (!options.showDotEntries && hasDotPathSegment(file)) return false;
    if (!query) return true;
    return file.toLowerCase().includes(query);
  });
}

export function isHiddenTreeFile(file: string): boolean {
  return TreeHiddenFilePrefixes.some((prefix) => file.startsWith(prefix));
}

export function hasDotPathSegment(file: string): boolean {
  return file.split("/").some((part) => part.startsWith("."));
}

function toSlashPath(file: string): string {
  return file.replace(/\\/g, "/");
}

export async function readFileResponse(cwd: string, relPath: string): Promise<Response> {
  const resolved = resolveInsideRoot(cwd, relPath);
  if (!resolved.ok) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, resolved.message), 400);
  const absolute = resolved.absolutePath;
  if (!existsSync(absolute)) {
    return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `File not found: ${relPath}.`), 404);
  }
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `Not a file: ${relPath}.`), 400);
  }
  if (stat.size > maxFileBytes) {
    return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `File exceeds ${maxFileBytes} byte cap (${stat.size} bytes).`), 413);
  }
  const content = await readFile(absolute, serverTextEncoding);
  const data: FileResponse = {
    path: relPath,
    language: detectLanguage(relPath),
    bytes: stat.size,
    content,
  };
  return json({ ok: true, data });
}

export function detectLanguage(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(FileExtension.Tsx)) return "tsx";
  if (hasExtension(lower, [FileExtension.Ts, FileExtension.Mts, FileExtension.Cts])) return "typescript";
  if (lower.endsWith(FileExtension.Jsx)) return "jsx";
  if (hasExtension(lower, [FileExtension.Js, FileExtension.Mjs, FileExtension.Cjs])) return "javascript";
  if (lower.endsWith(FileExtension.Json)) return "json";
  if (hasExtension(lower, [FileExtension.Md, FileExtension.Markdown])) return "markdown";
  if (lower.endsWith(FileExtension.Py)) return "python";
  if (lower.endsWith(FileExtension.Rs)) return "rust";
  if (lower.endsWith(FileExtension.Css)) return "css";
  if (lower.endsWith(FileExtension.Html)) return "html";
  if (lower.endsWith(FileExtension.Toml)) return "toml";
  if (hasExtension(lower, [FileExtension.Yml, FileExtension.Yaml])) return "yaml";
  return "plaintext";
}

function hasExtension(file: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => file.endsWith(extension));
}
