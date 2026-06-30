import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextPaths } from "./context.ts";
import { listFiles } from "./discovery.ts";
import { pathToImportUrl, relative, toRepoRelativePath, writeTextFileIfChangedSync } from "./core-utils.ts";
import { buildWithEsbuildWasm as esbuild } from "./runtime-esbuild.ts";
import { authoringImportPlugin, resolveOpenCanonAuthoringImportAliases } from "./authoring-imports.ts";
import { ProjectTypesFilePath } from "./project-types.ts";
import { resolveValidators } from "./validator.ts";
import type { Validator } from "./validator.ts";
import { conventionToValidator, resolveConventions, type Convention } from "./convention.ts";

const ValidatorGraphBundleLimit = 20;

export type ValidatorGraphMetadata = {
  entrypoint: string;
  bundlePath: string;
  hash: string;
  loadedAt: string;
  validatorCount: number;
  dependencyFiles: string[];
};

export type ValidatorGraphSourceSignature = {
  signature: string;
  diagnostics: string[];
};

export async function loadValidators(rootDir: string, paths: ContextPaths): Promise<Validator[]> {
  return (await loadConventionGraph(rootDir, paths, paths.conventionsPath)).validators;
}

/**
 * Load a CONVENTIONS module (the authoring model). Bundles it through the same esbuild
 * path as validators, resolves identity (local>bundle precedence, alias map), then adapts
 * every enforcing convention to the validator executor. Returns the executable validators
 * plus the full convention resolution (docs-only conventions carry no validator but stay in
 * `conventions` for rendering/history/gates).
 */
export async function loadConventionGraph(
  rootDir: string,
  paths: ContextPaths,
  conventionsEntry: string,
): Promise<{ validators: Validator[]; conventions: ReturnType<typeof resolveConventions>; metadata: ValidatorGraphMetadata }> {
  const bundled = await bundleValidatorGraph(rootDir, paths, conventionsEntry);
  const module = await import(`${pathToImportUrl(bundled.bundlePath)}?conventionGraph=${bundled.hash}`);
  const definitions = (Array.isArray(module.default) ? module.default : [module.default]) as Convention[];
  const conventions = resolveConventions(definitions);
  if (conventions.diagnostics.length > 0) {
    throw new Error(`Invalid conventions ${relative(rootDir, conventionsEntry)}:\n${conventions.diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  const validatorDefs = [...conventions.byId.values()].map(conventionToValidator).filter((v) => v !== undefined);
  const result = resolveValidators(validatorDefs);
  if (result.diagnostics.length > 0) {
    throw new Error(`Invalid convention runtime ${relative(rootDir, conventionsEntry)}:\n${result.diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  return {
    validators: result.validators,
    conventions,
    metadata: { ...bundled, loadedAt: new Date().toISOString(), validatorCount: result.validators.length },
  };
}

export function readValidatorGraphSourceSignature(rootDir: string, paths: ContextPaths, dependencyFiles?: string[]): ValidatorGraphSourceSignature {
  const sourceFiles = dependencyFiles?.length ? dependencyFiles.map((file) => path.resolve(rootDir, file)) : defaultConventionSourceFiles(paths);
  const diagnostics: string[] = [];
  const hash = createHash("sha256");

  for (const filePath of sourceFiles.sort()) {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(filePath);
    } catch (error) {
      diagnostics.push(`Could not stat convention source ${relative(rootDir, filePath)}: ${errorMessage(error)}`);
      continue;
    }
    if (!stats.isFile()) continue;
    try {
      hash.update(relative(rootDir, filePath));
      hash.update(String(stats.mtimeMs));
      hash.update(String(stats.size));
      hash.update(readFileSync(filePath));
    } catch (error) {
      diagnostics.push(`Could not read convention source ${relative(rootDir, filePath)}: ${errorMessage(error)}`);
    }
  }

  return { signature: hash.digest("hex"), diagnostics };
}

async function bundleValidatorGraph(rootDir: string, paths: ContextPaths, entry: string = paths.conventionsPath): Promise<Pick<ValidatorGraphMetadata, "entrypoint" | "bundlePath" | "hash" | "dependencyFiles">> {
  const build = await esbuild({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    minify: false,
    sourcemap: false,
    metafile: true,
    write: false,
    plugins: [authoringImportPlugin(conventionAuthoringImportAliases(rootDir))],
  }).catch((error: unknown) => {
    throw new Error(`Could not bundle conventions ${relative(rootDir, entry)}:\n${formatBuildError(error)}`);
  });
  const output = build.outputFiles[0];
  if (!output) throw new Error(`Could not bundle conventions ${relative(rootDir, entry)}: no build output.`);
  const source = output.text;
  const hash = createHash("sha256").update(source).digest("hex");
  const bundleDir = path.join(paths.cacheDir, "validator-graph");
  const bundlePath = path.join(bundleDir, `${hash}.mjs`);
  mkdirSync(bundleDir, { recursive: true });
  writeTextFileIfChangedSync(bundlePath, source);
  pruneValidatorGraphBundles(bundleDir, bundlePath);
  return {
    entrypoint: relative(rootDir, entry),
    bundlePath,
    hash,
    dependencyFiles: validatorGraphDependencyFiles(rootDir, build.metafile),
  };
}

function conventionAuthoringImportAliases(rootDir: string): { core: string; validators: string; project: string } {
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

function validatorGraphDependencyFiles(rootDir: string, metafile: unknown): string[] {
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

function pruneValidatorGraphBundles(bundleDir: string, keepPath: string): void {
  const bundles = readdirSync(bundleDir)
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => path.join(bundleDir, file))
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const item of bundles.slice(ValidatorGraphBundleLimit)) {
    if (item.file === keepPath) continue;
    unlinkSync(item.file);
  }
}

function isValidatorSourceFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file);
}

function defaultConventionSourceFiles(paths: ContextPaths): string[] {
  const conventionsDir = path.dirname(paths.conventionsPath);
  return unique([paths.conventionsPath, ...listFiles(conventionsDir, isValidatorSourceFile)]);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBuildError(error: unknown): string {
  if (isRecord(error) && Array.isArray(error.errors)) {
    const messages = error.errors.map(buildMessageText).filter((message): message is string => Boolean(message));
    if (messages.length > 0) return messages.map((message) => `- ${message}`).join("\n");
  }
  return `- ${errorMessage(error)}`;
}

function buildMessageText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const text = typeof message.text === "string" ? message.text : undefined;
  const location = isRecord(message.location) && typeof message.location.file === "string"
    ? `${message.location.file}${typeof message.location.line === "number" ? `:${message.location.line}` : ""}`
    : "";
  if (!text) return undefined;
  return location ? `${location}: ${text}` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
