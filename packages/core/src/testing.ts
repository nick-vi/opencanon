import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePath, relative } from "./core.ts";
import { buildWithEsbuildWasm as esbuild } from "./runtime-esbuild.ts";
import { authoringImportPlugin, resolveOpenCanonAuthoringImportAliases } from "./authoring-imports.ts";
import { writeAtomicTextFileSync } from "./atomic.ts";
import { ProjectTypesFilePath } from "./project-types.ts";

/** Text content for a virtual fixture file. */
export type FixtureTextInput = string;
export type FixtureTextFileInput = FixtureTextInput | { text: FixtureTextInput; target?: boolean; analysis?: boolean };
export type FixtureFileOptions = { target?: boolean; analysis?: boolean };

/** A virtual file declared by a flat `valid.ts`, `invalid.ts`, or `fixed.ts` fixture. */
export type FixtureFileEntry = {
  /** Repo-relative path to materialize inside the fixture case. */
  path: string;
  /** File content to write. */
  text: string;
  /** Include this file in `ctx.targetFiles`. If omitted, all source files are targeted. */
  target?: boolean;
  /** Include this file in the parsed fact analysis scope. */
  analysis?: boolean;
};

/** Builder helpers available in `defineFixture({ files: (...) => [...] })`. */
export type FixtureFileBuilder = {
  /** Declare a virtual text file exactly as provided. */
  (path: string, input: FixtureTextFileInput): FixtureFileEntry;
  /** Declare a virtual TypeScript file with dedented text and a trailing newline. */
  ts(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual TSX file with dedented text and a trailing newline. */
  tsx(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual JavaScript file with dedented text and a trailing newline. */
  js(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual JSX file with dedented text and a trailing newline. */
  jsx(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual Python file with dedented text and a trailing newline. */
  py(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual Rust file with dedented text and a trailing newline. */
  rs(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual TOML file with dedented text and a trailing newline. */
  toml(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual Markdown file with dedented text and a trailing newline. */
  md(path: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry;
  /** Declare a virtual JSON file with stable pretty-printed content. */
  json(path: string, value: unknown, options?: FixtureFileOptions): FixtureFileEntry;
};

export type FixtureFileApi = {
  /** Declare virtual files. Language helpers dedent multiline strings for readability. */
  file: FixtureFileBuilder;
};

/** Declarative virtual fixture content for one valid/invalid/fixed fixture case. */
export type FixtureDefinition = {
  /** Empty or structural directories that should exist in `ctx.folders()`. */
  directories?: string[];
  /** Virtual files to materialize inside the materialized fixture. */
  files?: (api: FixtureFileApi) => FixtureFileEntry[];
  /** Explicit target files. Defaults to all supported source files when omitted. */
  targetFiles?: string[];
  /** Explicit fact-analysis files. Defaults to target files when omitted. */
  analysisFiles?: string[];
};

export type MaterializedFixture = {
  /** Temporary materialized project root used for this fixture case. */
  rootDir: string;
  /** Remove the temporary project root when the validation context is flushed. */
  cleanup(): void;
  /** Explicit empty or structural directories materialized for `ctx.folders()`. */
  directories: string[];
  /** Explicit target files selected by the fixture, when provided. */
  targetFiles?: string[];
  /** Explicit fact-analysis files selected by the fixture, when provided. */
  analysisFiles?: string[];
};

/** Define virtual directories/files for a validator fixture case. */
export function defineFixture(input: FixtureDefinition): FixtureDefinition {
  return input;
}

/** Materialize a fixture case on disk from a flat fixture definition file. */
export async function materializeFixture(fixtureFile: string): Promise<MaterializedFixture> {
  const definition = await loadFixtureDefinition(fixtureFile);
  const rootDir = path.join(tmpdir(), `opencanon-fixture-${path.basename(path.dirname(fixtureFile))}-${path.basename(fixtureFile, path.extname(fixtureFile))}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rootDir, { recursive: true });

  const directories = (definition.directories ?? []).map(normalizeFixturePath);
  for (const directory of directories) {
    mkdirSync(path.join(rootDir, directory), { recursive: true });
  }

  const entries = fixtureFiles(definition);
  for (const entry of entries) {
    const target = path.join(rootDir, normalizeFixturePath(entry.path));
    mkdirSync(path.dirname(target), { recursive: true });
    writeAtomicTextFileSync(target, entry.text);
  }

  const declaredTargetFiles = entries
    .filter((entry) => entry.target)
    .map((entry) => normalizeFixturePath(entry.path));
  const declaredAnalysisFiles = entries
    .filter((entry) => entry.analysis)
    .map((entry) => normalizeFixturePath(entry.path));

  return {
    rootDir,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
    directories,
    targetFiles: normalizeOptionalFiles(definition.targetFiles) ?? (declaredTargetFiles.length > 0 ? declaredTargetFiles : undefined),
    analysisFiles: normalizeOptionalFiles(definition.analysisFiles) ?? (declaredAnalysisFiles.length > 0 ? declaredAnalysisFiles : undefined),
  };
}

async function loadFixtureDefinition(fixtureFile: string): Promise<FixtureDefinition> {
  if (!existsSync(fixtureFile)) {
    throw new Error(`Fixture definition does not exist: ${relative(process.cwd(), fixtureFile)}`);
  }
  const modulePath = await bundleFixtureDefinition(fixtureFile);
  const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let imported: { default?: unknown };
  try {
    imported = (await import(moduleUrl)) as { default?: unknown };
  } finally {
    if (modulePath !== fixtureFile) unlinkSync(modulePath);
  }
  if (!isFixtureDefinition(imported.default)) {
    throw new Error(`${relative(process.cwd(), fixtureFile)} must export defineFixture({ ... }) as default.`);
  }
  return imported.default;
}

async function bundleFixtureDefinition(fixtureFile: string): Promise<string> {
  const outputDir = path.join(tmpdir(), "opencanon-fixture-definitions");
  mkdirSync(outputDir, { recursive: true });
  const aliases = authoringImportAliases(fixtureFile);
  const build = await esbuild({
    entryPoints: [fixtureFile],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    minify: false,
    sourcemap: false,
    write: false,
    plugins: [authoringImportPlugin(aliases)],
  }).catch((error: unknown) => {
    throw new Error(`Could not bundle fixture definition ${relative(process.cwd(), fixtureFile)}:\n${formatBuildError(error)}`);
  });
  const output = build.outputFiles[0];
  if (!output) throw new Error(`Could not bundle fixture definition ${relative(process.cwd(), fixtureFile)}: no build output.`);
  const source = output.text;
  const hash = createHash("sha256").update(`${fixtureFile}\0${source}`).digest("hex");
  const bundlePath = path.join(outputDir, `${hash}-${process.pid}-${randomUUID()}.mjs`);
  writeAtomicTextFileSync(bundlePath, source);
  return bundlePath;
}

function authoringImportAliases(fromFile: string): { core: string; validators: string; project: string } {
  const fixtureRoot = fixtureProjectRoot(fromFile);
  const generatedProject = path.join(fixtureRoot, ProjectTypesFilePath);
  return resolveOpenCanonAuthoringImportAliases({
    rootDir: fixtureRoot,
    generatedProject,
    sourceRootCandidates: [
      path.resolve("."),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
    ],
  });
}

function fixtureProjectRoot(fromFile: string): string {
  let current = path.dirname(fromFile);
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, "opencanon.config.json")) || existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return process.cwd();
}

function fixtureFiles(definition: FixtureDefinition): FixtureFileEntry[] {
  const file = createFixtureFileBuilder();
  return definition.files?.({
    file,
  }) ?? [];
}

function createFixtureFileBuilder(): FixtureFileBuilder {
  const file = ((filePath: string, input: FixtureTextFileInput) => {
    const normalized = normalizeFixturePath(filePath);
    const text = typeof input === "string" ? input : input.text;
    return {
      path: normalized,
      text,
      target: typeof input === "object" ? input.target : undefined,
      analysis: typeof input === "object" ? input.analysis : undefined,
    };
  }) as FixtureFileBuilder;

  const textFile = (filePath: string, input: FixtureTextInput, options?: FixtureFileOptions): FixtureFileEntry =>
    file(filePath, {
      text: normalizeFixtureText(input),
      target: options?.target,
      analysis: options?.analysis,
    });

  file.ts = textFile;
  file.tsx = textFile;
  file.js = textFile;
  file.jsx = textFile;
  file.py = textFile;
  file.rs = textFile;
  file.toml = textFile;
  file.md = textFile;
  file.json = (filePath, value, options) =>
    file(filePath, {
      text: `${JSON.stringify(value, null, 2)}\n`,
      target: options?.target,
      analysis: options?.analysis,
    });

  return file;
}

function normalizeFixtureText(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  const text = lines.map((line) => line.slice(Math.min(indent, line.length))).join("\n");
  return text.length > 0 ? `${text}\n` : "";
}

function normalizeOptionalFiles(files: string[] | undefined): string[] | undefined {
  return files?.map(normalizeFixturePath);
}

function normalizeFixturePath(value: string): string {
  const normalized = normalizePath(value).replace(/^\/+/, "");
  if (!isSafeRelativePath(normalized)) throw new Error(`Fixture path is not safe: ${value}.`);
  return normalized;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split("/").includes("..");
}

function isFixtureDefinition(value: unknown): value is FixtureDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as FixtureDefinition;
  return (
    (candidate.directories === undefined || Array.isArray(candidate.directories)) &&
    (candidate.files === undefined || typeof candidate.files === "function") &&
    (candidate.targetFiles === undefined || Array.isArray(candidate.targetFiles)) &&
    (candidate.analysisFiles === undefined || Array.isArray(candidate.analysisFiles))
  );
}

function formatBuildError(error: unknown): string {
  if (isRecord(error) && Array.isArray(error.errors)) {
    const messages = error.errors.map(buildMessageText).filter((message): message is string => Boolean(message));
    if (messages.length > 0) return messages.map((message) => `- ${message}`).join("\n");
  }
  return `- ${error instanceof Error ? error.message : String(error)}`;
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
