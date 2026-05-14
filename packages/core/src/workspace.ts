import path from "node:path";
import type { ContextPaths } from "./core.ts";
import { matchesAny, normalizePath, unique } from "./core.ts";
import { listKnownContextFiles } from "./context-readers.ts";
import { PackageJsonFileName, ProjectFileLanguage, readJsonObject, readLooseJsonObject } from "./project-files.ts";
import type { ImportEdge, ProjectFile, WorkspaceGraph, WorkspaceKind, WorkspacePackage } from "./validator-types.ts";

export function buildWorkspaceGraph(rootDir: string, files: ProjectFile[], importEdges: () => ImportEdge[]): WorkspaceGraph {
  const rootPackageJson = readJsonObject(path.join(rootDir, PackageJsonFileName));
  const workspacePatterns = readWorkspacePatterns(rootPackageJson);
  const packageJsonFiles = listKnownContextFiles(rootDir, files, [PackageJsonFileName, "**/package.json"], (file) => path.basename(file) === PackageJsonFileName);
  const packageFiles = packageJsonFiles
    .map((file) => {
      const packageRoot = normalizePath(path.posix.dirname(file));
      if (packageRoot === ".") return rootPackage(rootDir, file, files);
      if (workspacePatterns.length > 0 && !workspacePatterns.some((pattern) => matchesAny(packageRoot, [pattern]))) return null;
      return workspacePackage(rootDir, packageRoot, file, files);
    })
    .filter((item): item is WorkspacePackage => Boolean(item));
  const packages = uniqueByName(packageFiles).sort((left, right) => left.root.localeCompare(right.root));

  return {
    packages,
    byName(name) {
      return packages.find((item) => item.name === name);
    },
    ownerOf(file) {
      const filePath = typeof file === "string" ? normalizePath(file) : file.path;
      return packages
        .filter((item) => item.root === "" || filePath === item.root || filePath.startsWith(`${item.root}/`))
        .sort((left, right) => right.root.length - left.root.length)[0];
    },
    importEdges,
  };
}

export function rootPackage(rootDir: string, packageJsonPath: string, files: ProjectFile[]): WorkspacePackage | null {
  const packageJson = readJsonObject(path.join(rootDir, packageJsonPath));
  if (!packageJson) return null;
  return {
    name: stringValue(packageJson.name) ?? "<root>",
    root: "",
    kind: "root",
    packageJson,
    dependencies: readDependencies(packageJson),
    files: files.filter((file) => !file.path.startsWith("packages/") && !file.path.startsWith("apps/")),
  };
}

export function workspacePackage(rootDir: string, packageRoot: string, packageJsonPath: string, files: ProjectFile[]): WorkspacePackage | null {
  const packageJson = readJsonObject(path.join(rootDir, packageJsonPath));
  const name = stringValue(packageJson?.name);
  if (!packageJson || !name) return null;
  return {
    name,
    root: packageRoot,
    kind: workspaceKind(packageRoot),
    packageJson,
    dependencies: readDependencies(packageJson),
    files: files.filter((file) => file.path === packageRoot || file.path.startsWith(`${packageRoot}/`)),
  };
}

export function readWorkspacePatterns(packageJson: Record<string, unknown> | null): string[] {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((item): item is string => typeof item === "string");
  if (workspaces && typeof workspaces === "object" && Array.isArray((workspaces as { packages?: unknown }).packages)) {
    return (workspaces as { packages: unknown[] }).packages.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function workspaceKind(packageRoot: string): WorkspaceKind {
  if (packageRoot.startsWith("apps/")) return "app";
  if (packageRoot.startsWith("packages/")) return "package";
  return "workspace";
}

export function readDependencies(packageJson: Record<string, unknown>): Record<string, string> {
  return {
    ...recordOfStrings(packageJson.dependencies),
    ...recordOfStrings(packageJson.devDependencies),
    ...recordOfStrings(packageJson.peerDependencies),
    ...recordOfStrings(packageJson.optionalDependencies),
  };
}

export function uniqueByName(packages: WorkspacePackage[]): WorkspacePackage[] {
  const seen = new Set<string>();
  const output: WorkspacePackage[] = [];
  for (const item of packages) {
    const key = item.name;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

export function buildImportGraph(params: {
  rootDir: string;
  paths?: ContextPaths;
  files: ProjectFile[];
  sourceFiles?: ProjectFile[];
  workspace: WorkspaceGraph;
}): ImportEdge[] {
  const filesByPath = new Map(params.files.map((file) => [file.path, file]));
  const sourceFiles = params.sourceFiles ?? params.files;
  const resolveAlias = createAliasResolver(params.rootDir, params.files, filesByPath);
  const edges: ImportEdge[] = [];

  for (const file of sourceFiles) {
    if (file.language !== ProjectFileLanguage.TypeScript && file.language !== ProjectFileLanguage.Svelte) continue;
    const fromPackage = params.workspace.ownerOf(file)?.name;
    for (const item of file.ts.imports()) {
      const resolved = resolveImport({
        fromPath: file.path,
        source: item.source,
        filesByPath,
        workspace: params.workspace,
        resolveAlias,
      });
      edges.push({
        from: file,
        to: resolved.path ? filesByPath.get(resolved.path) : undefined,
        source: item.source,
        line: item.line,
        specifiers: item.specifiers,
        kind: item.kind,
        resolution: resolved.resolution,
        relativeDepth: relativeDepth(item.source),
        resolvedPath: resolved.path,
        fromPackage,
        toPackage: resolved.packageName ?? (resolved.path ? params.workspace.ownerOf(resolved.path)?.name : undefined),
      });
    }
  }

  return edges;
}

export function resolveImport(params: {
  fromPath: string;
  source: string;
  filesByPath: Map<string, ProjectFile>;
  workspace: WorkspaceGraph;
  resolveAlias(source: string, fromPath: string): string | undefined;
}): { resolution: ImportEdge["resolution"]; path?: string; packageName?: string } {
  if (params.source.startsWith(".")) {
    const resolvedPath = resolveImportPath(params.fromPath, params.source, params.filesByPath);
    return {
      resolution: resolvedPath ? "relative" : "unresolved",
      path: resolvedPath,
    };
  }

  const aliasPath = params.resolveAlias(params.source, params.fromPath);
  if (aliasPath) return { resolution: "alias", path: aliasPath };

  const workspaceImport = resolveWorkspaceImportPath(params.source, params.workspace, params.filesByPath);
  if (workspaceImport) return { resolution: "workspace", path: workspaceImport.path, packageName: workspaceImport.packageName };

  return { resolution: "external" };
}

export function resolveImportPath(fromPath: string, source: string, filesByPath: Map<string, ProjectFile>): string | undefined {
  const fromDir = path.posix.dirname(fromPath);
  const base = normalizePath(path.posix.normalize(path.posix.join(fromDir, source)));
  return resolveCandidatePath(base, filesByPath);
}

export function resolveCandidatePath(base: string, filesByPath: Map<string, ProjectFile>): string | undefined {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.svelte`,
    `${base}.json`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.svelte`,
  ];
  return candidates.find((candidate) => filesByPath.has(candidate));
}

export function resolveWorkspaceImportPath(
  source: string,
  workspace: WorkspaceGraph,
  filesByPath: Map<string, ProjectFile>,
): { path?: string; packageName: string } | undefined {
  const packages = [...workspace.packages].sort((left, right) => right.name.length - left.name.length);
  const owner = packages.find((item) => source === item.name || source.startsWith(`${item.name}/`));
  if (!owner) return undefined;

  const subpath = source === owner.name ? "" : source.slice(owner.name.length + 1);
  const exportPath = readExportPath(owner.packageJson, subpath);
  const bases = unique([
    ...(exportPath ? [normalizePath(path.posix.join(owner.root, exportPath))] : []),
    subpath ? normalizePath(path.posix.join(owner.root, subpath)) : normalizePath(path.posix.join(owner.root, "src/index")),
    subpath ? normalizePath(path.posix.join(owner.root, "src", subpath)) : normalizePath(path.posix.join(owner.root, "index")),
  ]);

  return {
    packageName: owner.name,
    path: bases.map((base) => resolveCandidatePath(base, filesByPath)).find(Boolean),
  };
}

export function createAliasResolver(
  rootDir: string,
  files: ProjectFile[],
  filesByPath: Map<string, ProjectFile>,
): (source: string, fromPath: string) => string | undefined {
  const aliases = readTypeScriptAliases(rootDir, files);
  return (source, fromPath) => {
    const eligible = aliases
      .filter((alias) => alias.configRoot === "" || fromPath === alias.configRoot || fromPath.startsWith(`${alias.configRoot}/`))
      .sort((left, right) => right.configRoot.length - left.configRoot.length);

    for (const alias of eligible) {
      const wildcard = matchAliasPattern(alias.pattern, source);
      if (wildcard === null) continue;
      for (const target of alias.targets) {
        const targetPath = target.replaceAll("*", wildcard);
        const base = normalizePath(path.posix.normalize(path.posix.join(alias.baseDir, targetPath)));
        const resolved = resolveCandidatePath(base, filesByPath);
        if (resolved) return resolved;
      }
    }

    return undefined;
  };
}

export function readTypeScriptAliases(
  rootDir: string,
  files: ProjectFile[],
): Array<{ configRoot: string; baseDir: string; pattern: string; targets: string[] }> {
  return listKnownContextFiles(rootDir, files, ["tsconfig*.json", "**/tsconfig*.json"], (file) => /^tsconfig.*\.json$/.test(path.basename(file))).flatMap((file) => {
    const config = readLooseJsonObject(path.join(rootDir, file));
    const compilerOptions = isRecord(config?.compilerOptions) ? config.compilerOptions : {};
    const pathsConfig = isRecord(compilerOptions.paths) ? compilerOptions.paths : {};
    const configRoot = normalizePath(path.posix.dirname(file));
    const normalizedRoot = configRoot === "." ? "" : configRoot;
    const baseUrl = stringValue(compilerOptions.baseUrl) ?? ".";
    const baseDir = normalizePath(path.posix.normalize(path.posix.join(normalizedRoot, baseUrl)));

    return Object.entries(pathsConfig).flatMap(([pattern, value]) => {
      const targets = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      if (targets.length === 0) return [];
      return {
        configRoot: normalizedRoot,
        baseDir,
        pattern,
        targets,
      };
    });
  });
}

export function matchAliasPattern(pattern: string, source: string): string | null {
  if (!pattern.includes("*")) return pattern === source ? "" : null;
  const [prefix = "", suffix = ""] = pattern.split("*");
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return null;
  return source.slice(prefix.length, source.length - suffix.length);
}

export function readExportPath(packageJson: Record<string, unknown>, subpath: string): string | undefined {
  const exports = packageJson.exports;
  const key = subpath ? `./${subpath}` : ".";
  if (typeof exports === "string" && !subpath) return exports;
  if (!isRecord(exports)) return undefined;
  const value = exports[key];
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    for (const condition of ["import", "default", ProjectFileLanguage.Svelte, "types"]) {
      const candidate = value[condition];
      if (typeof candidate === "string") return candidate;
    }
  }
  return undefined;
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function relativeDepth(source: string): number {
  if (!source.startsWith(".")) return 0;
  return source.split("/").filter((part) => part === "..").length;
}
