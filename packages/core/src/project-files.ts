import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AnalysisCache } from "./cache.ts";
import type { ContextPaths } from "./core.ts";
import { listFiles, listProjectFiles, matchesAny, relative } from "./core.ts";
import { isSupportedSourceFile } from "./discovery.ts";
import type { Profiler } from "./profiler.ts";
import type { ExportInfo, FunctionInfo, ImportInfo, LiteralInfo, TypeScriptDeclaration } from "./typescript.ts";
import type { PythonClassInfo, PythonFunctionInfo, PythonImportInfo } from "./python.ts";
import type { CallInfo, CommentInfo, JsonRead, ProjectDiagnosticFact, ProjectFile, TextMatch, Validator } from "./validator-types.ts";
import type { FileFacts } from "./contracts.ts";
import {
  mapCalls,
  mapComments,
  mapDeclarations,
  mapExports,
  mapFunctions,
  mapImports,
  mapLiterals,
  mapPythonCalls,
  mapPythonClasses,
  mapPythonFunctions,
  mapPythonImports,
} from "./ast-fact-mappers.ts";

export const PackageJsonFileName = "package.json";
import { ProjectFileLanguage, descriptorForExtension } from "./language-registry.ts";

/**
 * Module-level injection seam for an AST-backed project facts provider,
 * mirroring the live type-facts provider seam in validator.ts. The project runtime (and
 * any in-process validation host that owns the engine) registers a factory
 * here at startup; every AST fact accessor — `file.ts.imports/exports/
 * functions/declarations/calls/literals()`, `file.py.*`, and `file.comments()`
 * for TypeScript — reads from it. There is NO regex fallback for those structural
 * facts; access throws if no provider is installed. (Svelte/Python `comments()`
 * are the exception: they scan the whole file as text, since markup/`#` comments
 * live outside the JS AST.) Svelte structural facts come from the engine's
 * SvelteExtractor (which locates `<script>` blocks and parses them with oxc),
 * reached through this same seam like any other language. Core stays
 * free of any `@opencanon/engine` import (layering — enforced by
 * framework-package-boundaries) — it only calls back through this factory, which
 * the runtime/CLI supplies.
 *
 * The factory is keyed by `rootDir`; it may return `undefined` only when that
 * root truly has no engine-backed provider. AST fact access then throws
 * instead of silently falling back to regex. The provider is expected to
 * batch/cache internally keyed by (path, content).
 */
export interface ProjectAstFactsProvider {
  /**
   * Engine-extracted language-neutral facts for ONE file — ALL fact kinds in one
   * parse. Core adapts these to per-language accessor shapes via ast-fact-mappers
   * (the universal contract → TypeScript surface boundary). The one method any
   * language flows through. `undefined` when the file yielded no facts (the core
   * mappers treat it as empty).
   */
  factsFor(filePath: string, text: string): FileFacts | undefined;
}
export type ProjectAstFactsProviderFactory = (rootDir: string) => ProjectAstFactsProvider | undefined;
let projectAstFactsProviderFactory: ProjectAstFactsProviderFactory | undefined;

/** Runtime/CLI-only: install (or clear) the AST-backed project facts provider factory. */
export function setProjectAstFactsProviderFactory(factory: ProjectAstFactsProviderFactory | undefined): void {
  projectAstFactsProviderFactory = factory;
}

export function getProjectAstFactsProvider(rootDir: string): ProjectAstFactsProvider | undefined {
  return projectAstFactsProviderFactory?.(rootDir);
}

export type ProjectFileSnapshot = {
  path: string;
  content: string;
  size: number;
  contentHash: string;
};

export function loadProjectFiles(
  rootDir: string,
  files: string[] | undefined,
  validator: Pick<Validator, "id" | "severity">,
  paths?: ContextPaths,
  cache?: AnalysisCache,
  profiler?: Profiler,
  snapshots: ProjectFileSnapshot[] = [],
): ProjectFile[] {
  const sourceFiles = files ?? (paths ? listProjectFiles(paths) : listFiles(rootDir, isSupportedSourceFile).map((file) => relative(rootDir, file)));
  const snapshotsByPath = new Map(snapshots.map((snapshot) => [normalizeProjectPath(snapshot.path), snapshot]));
  return sourceFiles
    .filter((file) => isSupportedSourceFile(file))
    .filter((file) => !file.includes("node_modules/") && !file.includes(".git/"))
    .filter((file) => snapshotsByPath.has(normalizeProjectPath(file)) || existsSync(path.join(rootDir, file)))
    .map((file) => {
      const snapshot = snapshotsByPath.get(normalizeProjectPath(file));
      return snapshot ? createProjectFileFromSnapshot({ rootDir, snapshot, validator, cache, profiler }) : createProjectFile({ rootDir, file, validator, cache, profiler });
    });
}

export function createProjectFile(params: {
  rootDir: string;
  file: string;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache;
  profiler?: Profiler;
}): ProjectFile {
  const absolutePath = path.isAbsolute(params.file) ? params.file : path.join(params.rootDir, params.file);
  const filePath = path.relative(params.rootDir, absolutePath).split(path.sep).join("/");
  return createProjectFileFromDisk({
    absolutePath,
    path: filePath,
    rootDir: params.rootDir,
    validator: params.validator,
    cache: params.cache,
    profiler: params.profiler,
  });
}

export function createProjectFileFromSnapshot(params: {
  rootDir: string;
  snapshot: ProjectFileSnapshot;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache;
  profiler?: Profiler;
}): ProjectFile {
  const filePath = normalizeProjectPath(params.snapshot.path);
  return createProjectFileFromDisk({
    absolutePath: path.join(params.rootDir, filePath),
    path: filePath,
    rootDir: params.rootDir,
    validator: params.validator,
    cache: params.cache,
    profiler: params.profiler,
    content: params.snapshot.content,
  });
}

export function createProjectFileFromDisk(params: {
  absolutePath: string;
  path: string;
  /** Project root, when known. Enables the AST facts provider seam (imports,
   * exports, symbols, declarations, calls, literals, comments — TS/Svelte via oxc,
   * Python via rustpython). */
  rootDir?: string;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache;
  profiler?: Profiler;
  content?: string;
}): ProjectFile {
  let textCache: string | undefined;
  let linesCache: string[] | undefined;
  const extension = path.extname(params.path);
  const tsCache = {
    imports: undefined as ImportInfo[] | undefined,
    exports: undefined as ExportInfo[] | undefined,
    functions: undefined as FunctionInfo[] | undefined,
    calls: undefined as CallInfo[] | undefined,
    declarations: undefined as TypeScriptDeclaration[] | undefined,
    literals: undefined as LiteralInfo[] | undefined,
  };
  const pyCache = {
    imports: undefined as PythonImportInfo[] | undefined,
    functions: undefined as PythonFunctionInfo[] | undefined,
    classes: undefined as PythonClassInfo[] | undefined,
    calls: undefined as CallInfo[] | undefined,
  };
  let commentCache: CommentInfo[] | undefined;
  let diagnosticsCache: ProjectDiagnosticFact[] | undefined;

  function readText(): string {
    textCache ??= params.content ?? (params.profiler?.measure("file.read", () => readFileSync(params.absolutePath, "utf8")) ?? readFileSync(params.absolutePath, "utf8"));
    return textCache;
  }

  function readLines(): string[] {
    linesCache ??= readText().split(/\r?\n/);
    return linesCache;
  }

  function cached<T>(key: string, parse: () => T): T {
    const cachedValue = params.cache?.get<T>(params.path, key);
    if (cachedValue !== undefined) return cachedValue;
    const value = params.profiler?.measure(`parse.${key}`, parse) ?? parse();
    params.cache?.set(params.path, key, value);
    return value;
  }

  function requireProvider(): ProjectAstFactsProvider {
    const provider = params.rootDir ? getProjectAstFactsProvider(params.rootDir) : undefined;
    if (!provider) {
      throw new Error(
        `AST facts require an installed ProjectAstFactsProvider for ${params.path}. Install one via setProjectAstFactsProviderFactory (e.g. createCliAstFactsProvider / withCliAstFactsProvider) before reading facts.`,
      );
    }
    return provider;
  }


  return {
    path: params.path,
    absolutePath: params.absolutePath,
    get text() {
      return readText();
    },
    get lines() {
      return readLines();
    },
    extension,
    language: languageFor(extension),
    has(pattern) {
      if (typeof pattern === "string") return readText().includes(pattern);
      return pattern.test(readText());
    },
    find(pattern) {
      return findMatches(readLines(), pattern);
    },
    json() {
      return parseJsonRead(params.path, readText(), params.path);
    },
    lineAt(line) {
      return readLines()[line - 1] ?? "";
    },
    matches(glob) {
      return matchesAny(params.path, [glob]);
    },
    comments() {
      commentCache ??= cached("comments", () => {
        const language = languageFor(extension);
        if (language === ProjectFileLanguage.TypeScript) {
          return mapComments(requireProvider().factsFor(params.path, readText()));
        }
        return parseComments(readText(), language);
      });
      return commentCache;
    },
    diagnostics() {
      diagnosticsCache ??= cached("diagnostics", () => {
        const language = languageFor(extension);
        let facts: FileFacts | undefined;
        if (language === ProjectFileLanguage.TypeScript || language === ProjectFileLanguage.Svelte || language === ProjectFileLanguage.Python) facts = requireProvider().factsFor(params.path, readText());
        else return [];
        return (facts?.diagnostics ?? []).map((diagnostic) => ({
          file: params.path,
          line: diagnostic.position?.line ?? 1,
          column: diagnostic.position?.column,
          source: facts?.parser ?? "parser",
          code: diagnostic.code,
          message: diagnostic.message,
          severity: diagnostic.severity,
        }));
      });
      return diagnosticsCache;
    },
    report(input) {
      const column = input.column ?? firstNonWhitespaceColumn(readLines()[input.line - 1] ?? "");
      return {
        validatorId: params.validator.id,
        severity: params.validator.severity,
        file: params.path,
        ...input,
        column,
      };
    },
    ts: {
      imports() {
        tsCache.imports ??= cached("ts.imports", () => {
          const language = languageFor(extension);
          if (language !== ProjectFileLanguage.TypeScript && language !== ProjectFileLanguage.Svelte) return [];
          return mapImports(requireProvider().factsFor(params.path, readText()));
        });
        return tsCache.imports;
      },
      exports() {
        tsCache.exports ??= cached("ts.exports", () => {
          const language = languageFor(extension);
          if (language !== ProjectFileLanguage.TypeScript && language !== ProjectFileLanguage.Svelte) return [];
          return mapExports(requireProvider().factsFor(params.path, readText()));
        });
        return tsCache.exports;
      },
      functions() {
        tsCache.functions ??= cached("ts.functions", () => {
          const language = languageFor(extension);
          if (language !== ProjectFileLanguage.TypeScript && language !== ProjectFileLanguage.Svelte) return [];
          return mapFunctions(requireProvider().factsFor(params.path, readText()), readText());
        });
        return tsCache.functions;
      },
      calls() {
        tsCache.calls ??= cached("ts.calls", () => {
          const language = languageFor(extension);
          if (language !== ProjectFileLanguage.TypeScript && language !== ProjectFileLanguage.Svelte) return [];
          return mapCalls(requireProvider().factsFor(params.path, readText()));
        });
        return tsCache.calls;
      },
      declarations() {
        tsCache.declarations ??= cached("ts.declarations", () => {
          const language = languageFor(extension);
          if (language !== ProjectFileLanguage.TypeScript && language !== ProjectFileLanguage.Svelte) return [];
          return mapDeclarations(requireProvider().factsFor(params.path, readText()));
        });
        return tsCache.declarations;
      },
      literals() {
        tsCache.literals ??= cached("ts.literals", () => {
          const language = languageFor(extension);
          if (language !== ProjectFileLanguage.TypeScript && language !== ProjectFileLanguage.Svelte) return [];
          return mapLiterals(requireProvider().factsFor(params.path, readText()));
        });
        return tsCache.literals;
      },
    },
    py: {
      imports() {
        pyCache.imports ??= cached("py.imports", () => {
          if (languageFor(extension) !== ProjectFileLanguage.Python) return [];
          return mapPythonImports(requireProvider().factsFor(params.path, readText()));
        });
        return pyCache.imports;
      },
      functions() {
        pyCache.functions ??= cached("py.functions", () => {
          if (languageFor(extension) !== ProjectFileLanguage.Python) return [];
          return mapPythonFunctions(requireProvider().factsFor(params.path, readText()), readText());
        });
        return pyCache.functions;
      },
      classes() {
        pyCache.classes ??= cached("py.classes", () => {
          if (languageFor(extension) !== ProjectFileLanguage.Python) return [];
          return mapPythonClasses(requireProvider().factsFor(params.path, readText()));
        });
        return pyCache.classes;
      },
      calls() {
        pyCache.calls ??= cached("py.calls", () => {
          if (languageFor(extension) !== ProjectFileLanguage.Python) return [];
          return mapPythonCalls(requireProvider().factsFor(params.path, readText()));
        });
        return pyCache.calls;
      },
    },
  };
}

function normalizeProjectPath(file: string): string {
  return file.split(path.sep).join("/");
}


export function parseJsonRead<T>(pathLabel: string, text: string, filePath: string): JsonRead<T> {
  try {
    return {
      path: filePath,
      data: JSON.parse(text) as T,
      diagnostics: [],
    };
  } catch (error) {
    return {
      path: filePath,
      diagnostics: [`Invalid JSON in ${pathLabel}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}


export function languageFor(extension: string): ProjectFile["language"] {
  // Single source of truth: the language registry's per-descriptor extension map.
  return descriptorForExtension(extension).id;
}


export function readJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function readLooseJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(stripTrailingJsonCommas(stripJsonComments(readFileSync(file, "utf8")))) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

export function stripTrailingJsonCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      const rest = text.slice(index + 1);
      if (/^\s*[}\]]/.test(rest)) continue;
    }
    output += char;
  }
  return output;
}


export function firstNonWhitespaceColumn(line: string): number {
  const match = line.match(/\S/);
  return match && typeof match.index === "number" ? match.index + 1 : 1;
}

export function findMatches(lines: string[], pattern: RegExp | string): TextMatch[] {
  const matches: TextMatch[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (typeof pattern === "string") {
      const column = line.indexOf(pattern);
      if (column !== -1) {
        matches.push({
          line: lineIndex + 1,
          column: column + 1,
          text: pattern,
          groups: [],
        });
      }
      continue;
    }

    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of line.matchAll(regex)) {
      matches.push({
        line: lineIndex + 1,
        column: (match.index ?? 0) + 1,
        text: match[0],
        groups: match.slice(1),
      });
    }
  }
  return matches;
}


export function parseComments(text: string, language: ProjectFile["language"]): CommentInfo[] {
  const comments: CommentInfo[] = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (language === ProjectFileLanguage.Python) {
      const hash = line.indexOf("#");
      if (hash !== -1) {
        comments.push({
          line: index + 1,
          column: hash + 1,
          text: line.slice(hash + 1).trim(),
          kind: "line",
        });
      }
      continue;
    }

    if (language !== ProjectFileLanguage.TypeScript && language !== ProjectFileLanguage.Svelte) continue;

    const lineComment = line.indexOf("//");
    if (lineComment !== -1) {
      comments.push({
        line: index + 1,
        column: lineComment + 1,
        text: line.slice(lineComment + 2).trim(),
        kind: "line",
      });
    }

    let cursor = 0;
    while (cursor < line.length) {
      if (!inBlock) {
        const start = line.indexOf("/*", cursor);
        if (start === -1) break;
        const end = line.indexOf("*/", start + 2);
        comments.push({
          line: index + 1,
          column: start + 1,
          text: line.slice(start + 2, end === -1 ? line.length : end).trim(),
          kind: "block",
        });
        inBlock = end === -1;
        cursor = end === -1 ? line.length : end + 2;
        continue;
      }

      const end = line.indexOf("*/", cursor);
      comments.push({
        line: index + 1,
        column: 1,
        text: line.slice(cursor, end === -1 ? line.length : end).trim(),
        kind: "block",
      });
      inBlock = end === -1;
      cursor = end === -1 ? line.length : end + 2;
    }
  }

  return comments.filter((comment) => comment.text.length > 0);
}




function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
