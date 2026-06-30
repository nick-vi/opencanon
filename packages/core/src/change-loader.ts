import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextPaths } from "./context.ts";
import { authoringImportPlugin, resolveOpenCanonAuthoringImportAliases } from "./authoring-imports.ts";
import { ProjectTypesFilePath } from "./project-types.ts";
import { buildWithEsbuildWasm as esbuild } from "./runtime-esbuild.ts";
import { pathToImportUrl, relative, toRepoRelativePath, writeTextFileIfChangedSync } from "./core-utils.ts";
import { resolveChanges, type Change } from "./change.ts";

export type ChangeGraphMetadata = {
  entrypoint: string;
  bundlePath?: string;
  hash: string;
  loadedAt: string;
  changeCount: number;
  dependencyFiles: string[];
};

export type LoadedChangeGraph = {
  changes: Change[];
  metadata: ChangeGraphMetadata;
};

export async function loadChangeGraph(rootDir: string, paths: ContextPaths): Promise<LoadedChangeGraph> {
  if (!existsSync(paths.changesPath)) {
    return {
      changes: [],
      metadata: {
        entrypoint: relative(rootDir, paths.changesPath),
        hash: "",
        loadedAt: new Date().toISOString(),
        changeCount: 0,
        dependencyFiles: [],
      },
    };
  }

  const bundled = await bundleChangeGraph(rootDir, paths);
  const module = await import(`${pathToImportUrl(bundled.bundlePath)}?changeGraph=${bundled.hash}`);
  const definitions = (Array.isArray(module.default) ? module.default : [module.default]) as Change[];
  const resolution = resolveChanges(definitions);
  if (resolution.diagnostics.length > 0) {
    throw new Error(`Invalid changes ${relative(rootDir, paths.changesPath)}:\n${resolution.diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  const changes = [...resolution.byId.values()];
  return {
    changes,
    metadata: { ...bundled, loadedAt: new Date().toISOString(), changeCount: changes.length },
  };
}

async function bundleChangeGraph(
  rootDir: string,
  paths: ContextPaths,
): Promise<Pick<ChangeGraphMetadata, "entrypoint" | "bundlePath" | "hash" | "dependencyFiles"> & { bundlePath: string }> {
  const build = await esbuild({
    entryPoints: [paths.changesPath],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    minify: false,
    sourcemap: false,
    metafile: true,
    write: false,
    plugins: [authoringImportPlugin(changeAuthoringImportAliases(rootDir))],
  }).catch((error: unknown) => {
    throw new Error(`Could not bundle changes ${relative(rootDir, paths.changesPath)}:\n${formatBuildError(error)}`);
  });
  const output = build.outputFiles[0];
  if (!output) throw new Error(`Could not bundle changes ${relative(rootDir, paths.changesPath)}: no build output.`);
  const source = output.text;
  const hash = createHash("sha256").update(source).digest("hex");
  const bundleDir = path.join(paths.cacheDir, "change-graph");
  const bundlePath = path.join(bundleDir, `${hash}.mjs`);
  mkdirSync(bundleDir, { recursive: true });
  writeTextFileIfChangedSync(bundlePath, source);
  return {
    entrypoint: relative(rootDir, paths.changesPath),
    bundlePath,
    hash,
    dependencyFiles: changeGraphDependencyFiles(rootDir, build.metafile),
  };
}

function changeAuthoringImportAliases(rootDir: string): { core: string; validators: string; project: string } {
  const generatedProject = path.join(rootDir, ProjectTypesFilePath);
  return resolveOpenCanonAuthoringImportAliases({
    rootDir,
    generatedProject,
    sourceRootCandidates: [
      rootDir,
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
    ],
  });
}

function changeGraphDependencyFiles(rootDir: string, metafile: unknown): string[] {
  if (!isRecord(metafile) || !isRecord(metafile.inputs)) return [];
  const realRootDir = realpathSync(rootDir);
  return Object.keys(metafile.inputs)
    .map((file) => toRepoRelativePath(realRootDir, realInputPath(file)))
    .filter((file) => !file.startsWith("..") && !path.isAbsolute(file))
    .sort();
}

function realInputPath(file: string): string {
  const candidates = path.isAbsolute(file) ? [file] : [path.resolve(process.cwd(), file), path.resolve("/", file)];
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      // Try the next candidate. esbuild-wasm metafile paths can omit the leading
      // slash for absolute Unix paths because it runs without Node's filesystem.
    }
  }
  return candidates[0] ?? file;
}

function formatBuildError(error: unknown): string {
  if (isRecord(error) && Array.isArray(error.errors)) {
    return error.errors.map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : String(item))).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
