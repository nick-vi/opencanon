import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPaths } from "./context.ts";
import { listFiles } from "./discovery.ts";
import { pathToImportUrl, relative, toRepoRelativePath } from "./core-utils.ts";
import { resolveValidators } from "./validator.ts";
import type { Validator } from "./validator.ts";

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
  return (await loadValidatorGraph(rootDir, paths)).validators;
}

export async function loadValidatorGraph(rootDir: string, paths: ContextPaths): Promise<{ validators: Validator[]; metadata: ValidatorGraphMetadata }> {
  const bundled = await bundleValidatorGraph(rootDir, paths);
  const module = await import(`${pathToImportUrl(bundled.bundlePath)}?validatorGraph=${bundled.hash}`);
  const result = resolveValidators(module.default);
  if (result.diagnostics.length > 0) {
    throw new Error(`Invalid validators ${relative(rootDir, paths.validatorsPath)}:\n${result.diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  return {
    validators: result.validators,
    metadata: {
      ...bundled,
      loadedAt: new Date().toISOString(),
      validatorCount: result.validators.length,
    },
  };
}

export function readValidatorGraphSourceSignature(rootDir: string, paths: ContextPaths, dependencyFiles?: string[]): ValidatorGraphSourceSignature {
  const sourceFiles = dependencyFiles?.length ? dependencyFiles.map((file) => path.resolve(rootDir, file)) : defaultValidatorSourceFiles(paths);
  const diagnostics: string[] = [];
  const hash = createHash("sha256");

  for (const filePath of sourceFiles.sort()) {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(filePath);
    } catch (error) {
      diagnostics.push(`Could not stat validator source ${relative(rootDir, filePath)}: ${errorMessage(error)}`);
      continue;
    }
    if (!stats.isFile()) continue;
    try {
      hash.update(relative(rootDir, filePath));
      hash.update(String(stats.mtimeMs));
      hash.update(String(stats.size));
      hash.update(readFileSync(filePath));
    } catch (error) {
      diagnostics.push(`Could not read validator source ${relative(rootDir, filePath)}: ${errorMessage(error)}`);
    }
  }

  return { signature: hash.digest("hex"), diagnostics };
}

async function bundleValidatorGraph(rootDir: string, paths: ContextPaths): Promise<Pick<ValidatorGraphMetadata, "entrypoint" | "bundlePath" | "hash" | "dependencyFiles">> {
  if (!("Bun" in globalThis) || typeof Bun.build !== "function") {
    const stats = statSync(paths.validatorsPath);
    const hash = createHash("sha256").update(`${paths.validatorsPath}:${stats.mtimeMs}:${stats.size}`).digest("hex");
    return {
      entrypoint: relative(rootDir, paths.validatorsPath),
      bundlePath: paths.validatorsPath,
      hash,
      dependencyFiles: [relative(rootDir, paths.validatorsPath)],
    };
  }

  const build = await Bun.build({
    entrypoints: [paths.validatorsPath],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
    metafile: true,
    plugins: [
      {
        name: "opencanon-authoring-imports",
        setup(builder) {
          const aliases = validatorAuthoringImportAliases(rootDir);
          builder.onResolve({ filter: /^@opencanon\/core(?:\/testing)?$/ }, () => ({ path: aliases.core }));
          builder.onResolve({ filter: /^@opencanon\/validators$/ }, () => ({ path: aliases.validators }));
          builder.onResolve({ filter: /^@opencanon\/project$/ }, () => ({ path: aliases.project }));
        },
      },
    ],
  });
  if (!build.success) {
    const diagnostics = build.logs.map((log) => log.message).filter(Boolean);
    throw new Error(`Could not bundle validators ${relative(rootDir, paths.validatorsPath)}:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`);
  }
  const output = build.outputs[0];
  if (!output) throw new Error(`Could not bundle validators ${relative(rootDir, paths.validatorsPath)}: no build output.`);
  const source = await output.text();
  const hash = createHash("sha256").update(source).digest("hex");
  const bundleDir = path.join(paths.cacheDir, "validator-graph");
  const bundlePath = path.join(bundleDir, `${hash}.mjs`);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(bundlePath, source);
  pruneValidatorGraphBundles(bundleDir, bundlePath);
  return {
    entrypoint: relative(rootDir, paths.validatorsPath),
    bundlePath,
    hash,
    dependencyFiles: validatorGraphDependencyFiles(rootDir, build.metafile),
  };
}

function validatorAuthoringImportAliases(rootDir: string): { core: string; validators: string; project: string } {
  const generatedProject = path.join(rootDir, ".agents/skills/opencanon/generated/project.ts");
  const sourceCore = path.join(rootDir, "packages/core/src/index.ts");
  const sourceValidators = path.join(rootDir, "packages/validators/src/index.ts");
  if (existsSync(sourceCore) && existsSync(sourceValidators)) {
    return { core: sourceCore, validators: sourceValidators, project: generatedProject };
  }

  const skillRoot = process.env.OPENCANON_SKILL_ROOT && existsSync(path.join(process.env.OPENCANON_SKILL_ROOT, "index.ts"))
    ? process.env.OPENCANON_SKILL_ROOT
    : path.join(rootDir, ".agents/skills/opencanon");
  return {
    core: path.join(skillRoot, "index.ts"),
    validators: path.join(skillRoot, "index.ts"),
    project: existsSync(generatedProject) ? generatedProject : path.join(skillRoot, "generated/project.ts"),
  };
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
  const absolutePath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
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

function defaultValidatorSourceFiles(paths: ContextPaths): string[] {
  const validatorsDir = path.dirname(paths.validatorsPath);
  return unique([paths.validatorsPath, ...listFiles(validatorsDir, isValidatorSourceFile)]);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
