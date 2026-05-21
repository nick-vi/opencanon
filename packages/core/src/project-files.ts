import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AnalysisCache } from "./cache.ts";
import type { ContextPaths } from "./core.ts";
import { listFiles, listProjectFiles, matchesAny, relative } from "./core.ts";
import type { Profiler } from "./profiler.ts";
import { parsePythonClasses, parsePythonFunctions, parsePythonImports } from "./python.ts";
import {
  parseSvelteTypeScriptDeclarations,
  parseSvelteTypeScriptExports,
  parseSvelteTypeScriptFunctions,
  parseSvelteTypeScriptImports,
  parseSvelteTypeScriptLiterals,
  parseTypeScriptDeclarations,
  parseTypeScriptExports,
  parseTypeScriptFunctions,
  parseTypeScriptImports,
  parseTypeScriptLiterals,
} from "./typescript.ts";
import type { ExportInfo, FunctionInfo, ImportInfo, LiteralInfo, TypeScriptDeclaration } from "./typescript.ts";
import type { PythonClassInfo, PythonFunctionInfo, PythonImportInfo } from "./python.ts";
import type { CommentInfo, JsonRead, ProjectFile, TextMatch, Validator } from "./validator-types.ts";

export const PackageJsonFileName = "package.json";
export const ProjectFileLanguage = {
  TypeScript: "typescript",
  Svelte: "svelte",
  Python: "python",
  Json: "json",
  Markdown: "markdown",
  Text: "text",
} as const;

export function loadProjectFiles(
  rootDir: string,
  files: string[] | undefined,
  validator: Pick<Validator, "id" | "severity">,
  paths?: ContextPaths,
  cache?: AnalysisCache,
  profiler?: Profiler,
): ProjectFile[] {
  const sourceFiles = files ?? (paths ? listProjectFiles(paths) : listFiles(rootDir, isSupportedSourceFile).map((file) => relative(rootDir, file)));
  return sourceFiles
    .filter((file) => isSupportedSourceFile(file))
    .filter((file) => !file.includes("node_modules/") && !file.includes(".git/"))
    .filter((file) => existsSync(path.join(rootDir, file)))
    .map((file) => createProjectFile({ rootDir, file, validator, cache, profiler }));
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
    validator: params.validator,
    cache: params.cache,
    profiler: params.profiler,
  });
}

export function createProjectFileFromDisk(params: {
  absolutePath: string;
  path: string;
  validator: Pick<Validator, "id" | "severity">;
  cache?: AnalysisCache;
  profiler?: Profiler;
}): ProjectFile {
  let textCache: string | undefined;
  let linesCache: string[] | undefined;
  const extension = path.extname(params.path);
  const tsCache = {
    imports: undefined as ImportInfo[] | undefined,
    exports: undefined as ExportInfo[] | undefined,
    functions: undefined as FunctionInfo[] | undefined,
    declarations: undefined as TypeScriptDeclaration[] | undefined,
    literals: undefined as LiteralInfo[] | undefined,
  };
  const pyCache = {
    imports: undefined as PythonImportInfo[] | undefined,
    functions: undefined as PythonFunctionInfo[] | undefined,
    classes: undefined as PythonClassInfo[] | undefined,
  };
  let commentCache: CommentInfo[] | undefined;

  function readText(): string {
    textCache ??= params.profiler?.measure("file.read", () => readFileSync(params.absolutePath, "utf8")) ?? readFileSync(params.absolutePath, "utf8");
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
      commentCache ??= cached("comments", () => parseComments(readText(), languageFor(extension)));
      return commentCache;
    },
    report(input) {
      return {
        validatorId: params.validator.id,
        severity: params.validator.severity,
        file: params.path,
        ...input,
      };
    },
    ts: {
      imports() {
        tsCache.imports ??= cached("ts.imports", () => (languageFor(extension) === ProjectFileLanguage.Svelte ? parseSvelteTypeScriptImports(readText()) : parseTypeScriptImports(readText())));
        return tsCache.imports;
      },
      exports() {
        tsCache.exports ??= cached("ts.exports", () => (languageFor(extension) === ProjectFileLanguage.Svelte ? parseSvelteTypeScriptExports(readText()) : parseTypeScriptExports(readText())));
        return tsCache.exports;
      },
      functions() {
        tsCache.functions ??= cached("ts.functions", () => (languageFor(extension) === ProjectFileLanguage.Svelte ? parseSvelteTypeScriptFunctions(readText()) : parseTypeScriptFunctions(readText())));
        return tsCache.functions;
      },
      declarations() {
        tsCache.declarations ??= cached("ts.declarations", () => (languageFor(extension) === ProjectFileLanguage.Svelte ? parseSvelteTypeScriptDeclarations(readText()) : parseTypeScriptDeclarations(readText())));
        return tsCache.declarations;
      },
      literals() {
        tsCache.literals ??= cached("ts.literals", () => (languageFor(extension) === ProjectFileLanguage.Svelte ? parseSvelteTypeScriptLiterals(readText()) : parseTypeScriptLiterals(readText())));
        return tsCache.literals;
      },
    },
    py: {
      imports() {
        pyCache.imports ??= cached("py.imports", () => parsePythonImports(readText()));
        return pyCache.imports;
      },
      functions() {
        pyCache.functions ??= cached("py.functions", () => parsePythonFunctions(readText()));
        return pyCache.functions;
      },
      classes() {
        pyCache.classes ??= cached("py.classes", () => parsePythonClasses(readText()));
        return pyCache.classes;
      },
    },
  };
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
  if (extension === ".ts" || extension === ".tsx" || extension === ".js" || extension === ".jsx") return ProjectFileLanguage.TypeScript;
  if (extension === ".svelte") return ProjectFileLanguage.Svelte;
  if (extension === ".py") return ProjectFileLanguage.Python;
  if (extension === ".json") return ProjectFileLanguage.Json;
  if (extension === ".md" || extension === ".markdown") return ProjectFileLanguage.Markdown;
  return ProjectFileLanguage.Text;
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


export function isSupportedSourceFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|py|rs|svelte|css|scss|sass|less|json|md|markdown)$/.test(file);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
