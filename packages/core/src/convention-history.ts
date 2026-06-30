import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AreaRenderKind, type Area } from "./area.ts";
import { loadAreaGraph } from "./area-loader.ts";
import { resolveAreaGeneratedDocsPath } from "./area-render.ts";
import { ChangeRenderKind, type Change } from "./change.ts";
import { loadChangeGraph } from "./change-loader.ts";
import { resolveChangeGeneratedDocsPath } from "./change-render.ts";
import { createPaths, loadImpactSurfaces, resolveRootDir, type ContextPaths } from "./context.ts";
import { ConventionRenderKind, lookupConvention, type Convention } from "./convention.ts";
import { resolveConventionGeneratedDocsPath } from "./convention-render.ts";
import { relative } from "./core-utils.ts";
import { getGitRoot } from "./git.ts";
import { SpecRenderKind, type Spec } from "./spec.ts";
import { loadSpecGraph } from "./spec-loader.ts";
import { resolveSpecGeneratedDocsPath } from "./spec-render.ts";
import { loadConventionGraph } from "./validator-graph.ts";

export type ConventionHistoryCommit = {
  hash: string;
  fullHash: string;
  timestamp: number;
  date: string;
  author: string;
  subject: string;
};

export type ConventionHistoryTarget = {
  requestedId: string;
  id: string;
  title: string;
  definitionFiles: string[];
  docFiles: string[];
  files: string[];
};

export type DefinitionHistoryKind = "convention" | "area" | "spec" | "change";

export type DefinitionHistoryTarget = {
  kind: DefinitionHistoryKind;
  requestedId: string;
  id: string;
  title: string;
  definitionFiles: string[];
  docFiles: string[];
  files: string[];
};

export type AreaHistoryTarget = DefinitionHistoryTarget & { kind: "area" };

export type SpecHistoryTarget = DefinitionHistoryTarget & { kind: "spec" };

export type ChangeHistoryTarget = DefinitionHistoryTarget & { kind: "change" };

export type ImpactEvolutionTarget = {
  surfaceId: string;
  title?: string;
  conventionIds: string[];
  files: string[];
};

export type GitCommandResult = {
  gitRoot: string | null;
  args: string[];
  stdout: string;
  diagnostics: string[];
};

export type RelatedCommitGitArgs = {
  path: string[];
  grep: string[];
};

export const ConventionGitLogFormat = "%h%x09%H%x09%ct%x09%ad%x09%an%x09%s";

const TextEncoding = {
  Utf8: "utf8",
} as const;

const GitCommand = {
  Git: "git",
} as const;

const GitSubcommand = {
  Diff: "diff",
  Log: "log",
} as const;

const GitArg = {
  All: "--all",
  DateShort: "--date=short",
  Directory: "-C",
  FixedStrings: "--fixed-strings",
  Separator: "--",
} as const;

const GitRunLimit = {
  TimeoutMs: 10_000,
  MaxBuffer: 64 * 1024 * 1024,
} as const;

type DefinitionSourceInput = {
  path: string;
  content: string;
};

type DefinitionSourceScore = {
  path: string;
  score: number;
  direct: boolean;
  basenameMatch: boolean;
  literal: boolean;
};

export async function loadConventionHistoryTarget(rootDir: string, conventionRef: string): Promise<{ ok: true; target: ConventionHistoryTarget } | { ok: false; diagnostics: string[] }> {
  rootDir = resolveRootDir(rootDir);
  const requestedId = conventionRef.trim();
  if (!requestedId) return { ok: false, diagnostics: ["Convention id is required."] };

  const paths = createPaths(rootDir);
  const graph = await loadConventionGraph(rootDir, paths, paths.conventionsPath);
  const convention = lookupConvention(graph.conventions, requestedId);
  if (!convention) return { ok: false, diagnostics: [`Unknown convention id: ${requestedId}`] };

  const docFiles = resolveConventionDocFiles(paths, convention);
  if (!docFiles.ok) return { ok: false, diagnostics: docFiles.diagnostics };
  const definitionFiles = resolveConventionDefinitionFiles({
    rootDir,
    paths,
    conventionId: convention.id,
    dependencyFiles: graph.metadata.dependencyFiles,
  });
  const files = uniqueStrings([...definitionFiles, ...docFiles.files]);
  return {
    ok: true,
    target: {
      requestedId,
      id: convention.id,
      title: convention.title,
      definitionFiles,
      docFiles: docFiles.files,
      files,
    },
  };
}

export async function loadAreaHistoryTarget(rootDir: string, areaRef: string): Promise<{ ok: true; target: AreaHistoryTarget } | { ok: false; diagnostics: string[] }> {
  rootDir = resolveRootDir(rootDir);
  const requestedId = areaRef.trim();
  if (!requestedId) return { ok: false, diagnostics: ["Area id is required."] };

  const paths = createPaths(rootDir);
  const graph = await loadAreaGraph(rootDir, paths);
  const area = graph.areas.find((item) => item.id === requestedId);
  if (!area) return { ok: false, diagnostics: [`Unknown area id: ${requestedId}`] };

  const docFiles = resolveAreaDocFiles(paths, area);
  if (!docFiles.ok) return { ok: false, diagnostics: docFiles.diagnostics };
  const definitionFiles = resolveDefinitionFiles({
    rootDir,
    entryPath: paths.areasPath,
    definitionId: area.id,
    dependencyFiles: graph.metadata.dependencyFiles,
  });
  const files = uniqueStrings([...definitionFiles, ...docFiles.files]);
  return {
    ok: true,
    target: {
      kind: "area",
      requestedId,
      id: area.id,
      title: area.title,
      definitionFiles,
      docFiles: docFiles.files,
      files,
    },
  };
}

export async function loadSpecHistoryTarget(rootDir: string, specRef: string): Promise<{ ok: true; target: SpecHistoryTarget } | { ok: false; diagnostics: string[] }> {
  rootDir = resolveRootDir(rootDir);
  const requestedId = specRef.trim();
  if (!requestedId) return { ok: false, diagnostics: ["Spec id is required."] };

  const paths = createPaths(rootDir);
  const graph = await loadSpecGraph(rootDir, paths);
  const spec = graph.specs.find((item) => item.id === requestedId);
  if (!spec) return { ok: false, diagnostics: [`Unknown spec id: ${requestedId}`] };

  const docFiles = resolveSpecDocFiles(paths, spec);
  if (!docFiles.ok) return { ok: false, diagnostics: docFiles.diagnostics };
  const definitionFiles = resolveDefinitionFiles({
    rootDir,
    entryPath: paths.specsPath,
    definitionId: spec.id,
    dependencyFiles: graph.metadata.dependencyFiles,
  });
  const files = uniqueStrings([...definitionFiles, ...docFiles.files]);
  return {
    ok: true,
    target: {
      kind: "spec",
      requestedId,
      id: spec.id,
      title: spec.title,
      definitionFiles,
      docFiles: docFiles.files,
      files,
    },
  };
}

export async function loadChangeHistoryTarget(rootDir: string, changeRef: string): Promise<{ ok: true; target: ChangeHistoryTarget } | { ok: false; diagnostics: string[] }> {
  rootDir = resolveRootDir(rootDir);
  const requestedId = changeRef.trim();
  if (!requestedId) return { ok: false, diagnostics: ["Change id is required."] };

  const paths = createPaths(rootDir);
  const graph = await loadChangeGraph(rootDir, paths);
  const change = graph.changes.find((item) => item.id === requestedId);
  if (!change) return { ok: false, diagnostics: [`Unknown change id: ${requestedId}`] };

  const docFiles = resolveChangeDocFiles(paths, change);
  if (!docFiles.ok) return { ok: false, diagnostics: docFiles.diagnostics };
  const definitionFiles = resolveDefinitionFiles({
    rootDir,
    entryPath: paths.changesPath,
    definitionId: change.id,
    dependencyFiles: graph.metadata.dependencyFiles,
  });
  const files = uniqueStrings([...definitionFiles, ...docFiles.files]);
  return {
    ok: true,
    target: {
      kind: "change",
      requestedId,
      id: change.id,
      title: change.title,
      definitionFiles,
      docFiles: docFiles.files,
      files,
    },
  };
}

export async function loadImpactEvolutionTarget(rootDir: string, surfaceIdInput: string): Promise<{ ok: true; target: ImpactEvolutionTarget } | { ok: false; diagnostics: string[] }> {
  rootDir = resolveRootDir(rootDir);
  const surfaceId = surfaceIdInput.trim();
  if (!surfaceId) return { ok: false, diagnostics: ["Impact surface id is required."] };

  const paths = createPaths(rootDir);
  const { surfaces } = loadImpactSurfaces(paths);
  const graph = await loadConventionGraph(rootDir, paths, paths.conventionsPath);
  const surface = surfaces.find((item) => item.id === surfaceId);
  const conventions = [...graph.conventions.byId.values()]
    .filter((convention) => convention.impactSurfaces?.includes(surfaceId) || surface?.conventionIds?.includes(convention.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (!surface && conventions.length === 0) return { ok: false, diagnostics: [`Unknown impact surface id: ${surfaceId}`] };

  const surfaceFile = existsSync(paths.impactSurfacesPath) ? [relative(rootDir, paths.impactSurfacesPath)] : [];
  const definitionFiles = conventions.flatMap((convention) =>
    resolveConventionDefinitionFiles({
      rootDir,
      paths,
      conventionId: convention.id,
      dependencyFiles: graph.metadata.dependencyFiles,
    }),
  );

  return {
    ok: true,
    target: {
      surfaceId,
      title: surface?.title,
      conventionIds: conventions.map((convention) => convention.id),
      files: uniqueStrings([...surfaceFile, ...definitionFiles]),
    },
  };
}

export function resolveConventionDocFiles(paths: ContextPaths, convention: Convention): { ok: true; files: string[] } | { ok: false; diagnostics: string[] } {
  if (convention.render.kind === ConventionRenderKind.None) return { ok: true, files: [] };
  const resolved = resolveConventionGeneratedDocsPath(paths, convention);
  if (!resolved.ok) return { ok: false, diagnostics: resolved.diagnostics };
  return { ok: true, files: [resolved.path] };
}

export function resolveAreaDocFiles(paths: ContextPaths, area: Area): { ok: true; files: string[] } | { ok: false; diagnostics: string[] } {
  if (area.render.kind === AreaRenderKind.None) return { ok: true, files: [] };
  const resolved = resolveAreaGeneratedDocsPath(paths, area);
  if (!resolved.ok) return { ok: false, diagnostics: resolved.diagnostics };
  return { ok: true, files: [resolved.path] };
}

export function resolveSpecDocFiles(paths: ContextPaths, spec: Spec): { ok: true; files: string[] } | { ok: false; diagnostics: string[] } {
  if (spec.render.kind === SpecRenderKind.None) return { ok: true, files: [] };
  const resolved = resolveSpecGeneratedDocsPath(paths, spec);
  if (!resolved.ok) return { ok: false, diagnostics: resolved.diagnostics };
  return { ok: true, files: [resolved.path] };
}

export function resolveChangeDocFiles(paths: ContextPaths, change: Change): { ok: true; files: string[] } | { ok: false; diagnostics: string[] } {
  if (change.render.kind === ChangeRenderKind.None) return { ok: true, files: [] };
  const resolved = resolveChangeGeneratedDocsPath(paths, change);
  if (!resolved.ok) return { ok: false, diagnostics: resolved.diagnostics };
  return { ok: true, files: [resolved.path] };
}

export function resolveConventionDefinitionFiles(input: {
  rootDir: string;
  paths: Pick<ContextPaths, "conventionsPath">;
  conventionId: string;
  dependencyFiles: string[];
}): string[] {
  return resolveDefinitionFiles({
    rootDir: input.rootDir,
    entryPath: input.paths.conventionsPath,
    definitionId: input.conventionId,
    dependencyFiles: input.dependencyFiles,
  });
}

export function resolveDefinitionFiles(input: {
  rootDir: string;
  entryPath: string;
  definitionId: string;
  dependencyFiles: string[];
}): string[] {
  const conventionsPath = normalizeRepoPath(relative(input.rootDir, input.entryPath));
  const dependencyFiles = input.dependencyFiles.map(normalizeRepoPath);
  const candidates = uniqueStrings([conventionsPath, ...dependencyFiles])
    .filter(isDefinitionSourceFile)
    .map((file) => ({ path: file, absolutePath: path.join(input.rootDir, file) }))
    .filter((file) => existsSync(file.absolutePath))
    .map((file) => ({ path: file.path, content: readFileSync(file.absolutePath, TextEncoding.Utf8) }));

  return resolveConventionDefinitionFilesFromSources({
    conventionId: input.definitionId,
    conventionsPath,
    sources: candidates,
  });
}

export function resolveConventionDefinitionFilesFromSources(input: {
  conventionId: string;
  conventionsPath: string;
  sources: DefinitionSourceInput[];
}): string[] {
  const conventionsPath = normalizeRepoPath(input.conventionsPath);
  const ranked = input.sources.map((source) => scoreDefinitionSource(input.conventionId, conventionsPath, source)).filter((item) => item.score > 0);
  const direct = ranked.filter((item) => item.direct);
  if (direct.length > 0) return orderedSourcePaths(direct);

  const basenameMatches = ranked.filter((item) => item.basenameMatch);
  if (basenameMatches.length > 0) return orderedSourcePaths(basenameMatches);

  const literalMatches = ranked.filter((item) => item.literal);
  if (literalMatches.length > 0) return orderedSourcePaths(literalMatches);

  return [conventionsPath];
}

export function buildConventionHistoryGitArgs(files: string[]): string[] {
  return buildDefinitionHistoryGitArgs(files);
}

export function buildConventionVersionsGitArgs(definitionFiles: string[]): string[] {
  return buildDefinitionVersionsGitArgs(definitionFiles);
}

export function buildConventionDiffGitArgs(input: { from: string; to: string; files: string[] }): string[] {
  return buildDefinitionDiffGitArgs(input);
}

export function buildRelatedCommitsGitArgs(input: { id: string; files: string[] }): RelatedCommitGitArgs {
  return buildRelatedDefinitionCommitsGitArgs(input);
}

export function buildDefinitionHistoryGitArgs(files: string[]): string[] {
  return buildPathLogGitArgs(files);
}

export function buildDefinitionVersionsGitArgs(definitionFiles: string[]): string[] {
  return buildPathLogGitArgs(definitionFiles);
}

export function buildDefinitionDiffGitArgs(input: { from: string; to: string; files: string[] }): string[] {
  return [GitSubcommand.Diff, input.from, input.to, GitArg.Separator, ...input.files];
}

export function buildRelatedDefinitionCommitsGitArgs(input: { id: string; files: string[] }): RelatedCommitGitArgs {
  return {
    path: buildPathLogGitArgs(input.files),
    grep: [
      GitSubcommand.Log,
      GitArg.All,
      GitArg.FixedStrings,
      `--grep=${input.id}`,
      GitArg.DateShort,
      `--format=${ConventionGitLogFormat}`,
    ],
  };
}

export function buildImpactEvolutionGitArgs(files: string[]): string[] {
  return buildPathLogGitArgs(files);
}

export function parseConventionGitLog(stdout: string): ConventionHistoryCommit[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash = "", fullHash = "", timestamp = "0", date = "", author = "", ...subjectParts] = line.split("\t");
      return {
        hash,
        fullHash,
        timestamp: Number(timestamp),
        date,
        author,
        subject: subjectParts.join("\t"),
      };
    });
}

export function dedupeCommits(commits: ConventionHistoryCommit[]): ConventionHistoryCommit[] {
  const byHash = new Map<string, ConventionHistoryCommit>();
  for (const commit of commits) {
    const key = commit.fullHash || commit.hash;
    if (!byHash.has(key)) byHash.set(key, commit);
  }
  return [...byHash.values()].sort((left, right) => right.timestamp - left.timestamp || left.fullHash.localeCompare(right.fullHash));
}

export function runGit(rootDir: string, args: string[]): GitCommandResult {
  rootDir = resolveRootDir(rootDir);
  const gitRoot = getGitRoot(rootDir);
  if (!gitRoot) {
    return {
      gitRoot: null,
      args,
      stdout: "",
      diagnostics: [`No Git repository found for ${rootDir}.`],
    };
  }

  const result = spawnSync(GitCommand.Git, [GitArg.Directory, gitRoot, ...args], {
    encoding: TextEncoding.Utf8,
    timeout: GitRunLimit.TimeoutMs,
    maxBuffer: GitRunLimit.MaxBuffer,
  });
  if (result.error || result.status !== 0) {
    return {
      gitRoot,
      args,
      stdout: result.stdout ?? "",
      diagnostics: [(result.error?.message ?? result.stderr.trim()) || `Git command failed: git ${args.join(" ")}`],
    };
  }
  return { gitRoot, args, stdout: result.stdout, diagnostics: [] };
}

function buildPathLogGitArgs(files: string[]): string[] {
  return [
    GitSubcommand.Log,
    GitArg.DateShort,
    `--format=${ConventionGitLogFormat}`,
    GitArg.Separator,
    ...files,
  ];
}

function scoreDefinitionSource(conventionId: string, conventionsPath: string, source: DefinitionSourceInput): DefinitionSourceScore {
  const sourcePath = normalizeRepoPath(source.path);
  const direct = new RegExp(`\\bid\\s*:\\s*["'\`]${escapeRegExp(conventionId)}["'\`]`).test(source.content);
  const literal = new RegExp(`["'\`]${escapeRegExp(conventionId)}["'\`]`).test(source.content);
  const basenameMatch = path.posix.basename(sourcePath, path.posix.extname(sourcePath)) === conventionId;
  const conventionsDir = path.posix.dirname(conventionsPath);
  const inConventionsDir = sourcePath === conventionsPath || sourcePath.startsWith(`${conventionsDir}/`);
  const score =
    (direct ? 100 : 0) +
    (basenameMatch ? 10 : 0) +
    (inConventionsDir ? 2 : 0) +
    (literal ? 1 : 0) +
    (sourcePath === conventionsPath ? 1 : 0);
  return { path: sourcePath, score, direct, basenameMatch, literal };
}

function orderedSourcePaths(scores: DefinitionSourceScore[]): string[] {
  return scores
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((item) => item.path);
}

function isDefinitionSourceFile(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(file);
}

function normalizeRepoPath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(normalizeRepoPath).filter(Boolean))];
}
