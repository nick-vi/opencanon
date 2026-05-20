import path from "node:path";
import { resolveExternalTool, resolveInsideRoot } from "@opencanon/core";
import type {
  ExportInfo,
  Finding,
  FindingFix,
  FixSafety,
  LiteralContext,
  TreeDefinition,
  TypeScriptEnumDeclaration,
  ValidationContext,
  ValidatorRuntime,
  ValidatorSummary,
} from "@opencanon/core";

export type FindingOptions = {
  message: string;
  fix?: FindingFix;
  docs?: string[];
};

export type FileNameOptions = FindingOptions & {
  in: string[];
  names?: string[];
  suffix?: string | string[];
  allowNames?: string[];
};

export type NoImportsOptions = FindingOptions & {
  from: string[];
  to: string[];
};

export type NoForbiddenImportsOptions = FindingOptions & {
  in: string[];
  imports: string[];
};

export type NoDeepRelativeImportsOptions = FindingOptions & {
  in: string[];
  maxDepth: number;
};

export type RequiredFunctionParamOptions = FindingOptions & {
  in: string[];
  param: string | RegExp;
  functions?: string | RegExp | Array<string | RegExp>;
  exportedOnly?: boolean;
  position?: "any" | "first" | "last";
};

export type RequiredFileSiblingOptions = FindingOptions & {
  in: string[];
  sibling: string | string[];
};

export type NoFolderNamesOptions = FindingOptions & {
  in: string[];
  names: string[];
};

export type FolderStructureOptions = {
  in?: string[];
  tree: TreeDefinition;
};

export type NoBarrelCrossBoundaryOptions = FindingOptions & {
  in: string[];
  allow?: string[];
  deny?: string[];
  maxRelativeDepth?: number;
};

export type NoLayerCallOptions = FindingOptions & {
  in: string[];
  calls: RegExp | RegExp[];
};

export type RequireExportPatternOptions = FindingOptions & {
  in: string[];
  names: string | RegExp | Array<string | RegExp>;
  kinds?: ExportInfo["kind"][];
};

export type NoUnusedExportsOptions = FindingOptions & {
  in: string[];
  allow?: Array<string | RegExp>;
  kinds?: Array<"function" | "class" | "method" | "variable" | "type" | "interface" | "enum" | "property" | "unknown">;
};

export type NoNativeEnumsOptions = {
  in: string[];
  message?: string;
  docs?: string[];
  safeFix?: boolean;
};

export type RepeatedLiteralsOptions = FindingOptions & {
  in: string[];
  minOccurrences?: number;
  minFiles?: number;
  valueKinds?: Array<"string" | "number" | "boolean">;
  contexts?: LiteralContext[];
  ignore?: Array<string | RegExp>;
};

export type NoSecretLikeLiteralsOptions = FindingOptions & {
  in: string[];
  allow?: Array<string | RegExp>;
  allowFiles?: string[];
  minEntropy?: number;
  minLength?: number;
  patterns?: RegExp | RegExp[];
};

export type NoHardcodedConfigValuesOptions = FindingOptions & {
  in: string[];
  allow?: Array<string | RegExp>;
  allowFiles?: string[];
  kinds?: Array<"url" | "host" | "port" | "path">;
  contexts?: LiteralContext[];
};

export type NoCommentMatchesOptions =
  FindingOptions & {
    in: string[];
    patterns: RegExp | RegExp[];
  };

export type NoHeaderCommentsOptions =
  FindingOptions & {
    in: string[];
    allow?: RegExp | RegExp[];
    maxHeaderLines?: number;
    patterns?: RegExp | RegExp[];
  };

export type NoBypassCommentsOptions =
  FindingOptions & {
    in: string[];
    allow?: RegExp | RegExp[];
    patterns?: RegExp | RegExp[];
    reasonPatterns?: RegExp | RegExp[];
    requireReason?: boolean;
  };

export type NoForbiddenCallsOptions =
  FindingOptions & {
    in: string[];
    calls: RegExp | RegExp[];
  };

export type RestrictedSymbolsOptions = FindingOptions & {
  in?: string[];
  symbols: string[];
  from?: string[];
  allowIn: string[];
  scanText?: boolean;
};

export type ExternalCommandOptions = FindingOptions & {
  in?: string[];
  command: string;
  args?: string[];
  cwd?: string;
  optional?: boolean;
  missingMessage?: string;
  successCodes?: number[];
  timeoutMs?: number;
  maxBufferBytes?: number;
  reportFile?: string;
  reportLine?: number;
};

export type ExternalDiagnosticInput = {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  code?: string;
  severity?: "error" | "warning" | "info";
};

export type ExternalDiagnosticsOptions = FindingOptions & {
  in?: string[];
  command: string;
  args?: string[];
  cwd?: string;
  tool?: string;
  format?: "json" | "sarif" | "regex";
  map?: (diagnostic: unknown) => ExternalDiagnosticInput | ExternalDiagnosticInput[] | null | undefined;
  regex?: RegExp;
  optional?: boolean;
  missingMessage?: string;
  successCodes?: number[];
  timeoutMs?: number;
  maxBufferBytes?: number;
  reportFile?: string;
  reportLine?: number;
};

export type NoShimFilesOptions = FindingOptions & {
  in: string[];
  patterns?: RegExp | RegExp[];
};

export type AnnotationPolicyOptions = FindingOptions & {
  in: string[];
  tags?: string[];
  requireTags: string[];
};

export type NoBareExceptOptions = FindingOptions & {
  in: string[];
};

export type DuplicateBoundaryLiteralsOptions = FindingOptions & {
  in: string[];
  minOccurrences?: number;
  minFiles?: number;
  ignore?: Array<string | RegExp>;
};

export type SensitiveChangePolicyOptions = FindingOptions & {
  in?: string[];
  require?: "tests" | "docs" | "decision";
};

export const DefaultHeaderCommentAllowPatterns = [/^!\/usr\/bin\/env\b/u, /^SPDX-License-Identifier:/u, /^@license\b/u, /^Copyright\b/u, /^<reference\s/u];
export const DefaultBypassCommentPatterns = [
  /\beslint-disable(?:-next-line|-line)?\b/u,
  /\bbiome-ignore\b/u,
  /\boxlint-disable\b/u,
  /@ts-(?:ignore|expect-error|nocheck)\b/u,
  /\bnoqa\b/u,
  /\btype:\s*ignore\b/u,
  /\bpylint:\s*disable\b/u,
  /\bopencanon-(?:disable|ignore|skip)\b/u,
  /\bno-verify\b/u,
  /\bpragma:\s*no\s+cover\b/u,
];
export const DefaultBypassReasonPatterns = [/\b(?:reason|because|ticket|issue|approved|expires|owner)\b.{3,}/iu];
export const ValidatorFixSafety = {
  Manual: "manual",
} as const;

export type ExternalInvocationOptions = {
  command: string;
  args?: string[];
  cwd?: string;
};

export function externalInvocation(options: ExternalInvocationOptions, ctx: ValidationContext, runtime: ValidatorRuntime): { ok: true; command: string; args: string[]; cwd: string } | { ok: false; message: string } {
  const tool = resolveExternalTool(options.command, runtime.paths.externalTools);
  const cwdInput = options.cwd ? expandExternalText(options.cwd, ctx, runtime) : "";
  const relativeCwd = path.isAbsolute(cwdInput) ? path.relative(runtime.rootDir, cwdInput) : cwdInput;
  const cwd = resolveInsideRoot(runtime.rootDir, relativeCwd, { allowEmpty: true });
  if (!cwd.ok) return { ok: false, message: `External tool cwd is unsafe: ${cwd.message}` };
  return {
    ok: true,
    command: expandExternalText(tool.command, ctx, runtime),
    args: expandExternalArgs([...tool.args, ...(options.args ?? [])], ctx, runtime),
    cwd: cwd.absolutePath,
  };
}

export function expandExternalArgs(args: string[], ctx: ValidationContext, runtime: ValidatorRuntime): string[] {
  const values = externalTemplateValues(ctx, runtime);
  return args.flatMap((arg) => {
    const exact = exactExternalToken(arg);
    if (exact && Array.isArray(values[exact])) return values[exact] as string[];
    return [expandExternalText(arg, ctx, runtime)];
  });
}

export function expandExternalText(value: string, ctx: ValidationContext, runtime: ValidatorRuntime): string {
  const values = externalTemplateValues(ctx, runtime);
  return value.replace(/\{([A-Za-z]+)\}/g, (match, name: string) => {
    const replacement = values[name];
    if (replacement === undefined) return match;
    return Array.isArray(replacement) ? replacement.join(" ") : replacement;
  });
}

export function exactExternalToken(value: string): string | null {
  const match = value.match(/^\{([A-Za-z]+)\}$/);
  return match?.[1] ?? null;
}

export function externalTemplateValues(ctx: ValidationContext, runtime: ValidatorRuntime): Record<string, string | string[]> {
  const targetFiles = ctx.targetFiles.map((file) => file.path);
  const analysisFiles = ctx.files.map((file) => file.path);
  return {
    root: runtime.rootDir,
    config: runtime.paths.configPath ? normalizeExternalPath(path.relative(runtime.rootDir, runtime.paths.configPath)) : "",
    cache: normalizeExternalPath(path.relative(runtime.rootDir, runtime.paths.cacheDir)),
    files: targetFiles,
    targetFiles,
    changed: targetFiles,
    analysisFiles,
    projectFiles: analysisFiles,
  };
}

export function normalizeExternalPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function parseExternalDiagnostics(output: string, options: ExternalDiagnosticsOptions): ExternalDiagnosticInput[] {
  if (!output.trim()) return [];
  if (options.format === "regex") return parseRegexDiagnostics(output, options.regex);

  if (options.format === "sarif") {
    try {
      return parseSarifDiagnostics(JSON.parse(output) as unknown);
    } catch {
      return [];
    }
  }

  if (options.format === "json" || options.map) {
    try {
      const parsed = JSON.parse(output) as unknown;
      const values = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [parsed];
      return values.flatMap((value) => normalizeMappedDiagnostic(options.map ? options.map(value) : defaultJsonDiagnostic(value)));
    } catch {
      return [];
    }
  }

  return [];
}

export function parseRegexDiagnostics(output: string, regex: RegExp | undefined): ExternalDiagnosticInput[] {
  if (!regex) return [];
  const diagnostics: ExternalDiagnosticInput[] = [];
  const active = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  for (const match of output.matchAll(active)) {
    diagnostics.push({
      file: match.groups?.file ?? match[1],
      line: numberValue(match.groups?.line ?? match[2]),
      column: numberValue(match.groups?.column ?? match[3]),
      message: match.groups?.message ?? match[4] ?? match[0],
      code: match.groups?.code,
    });
  }
  return diagnostics;
}

export function parseSarifDiagnostics(value: unknown): ExternalDiagnosticInput[] {
  if (!isRecord(value) || !Array.isArray(value.runs)) return [];
  return value.runs.flatMap((run) => {
    if (!isRecord(run) || !Array.isArray(run.results)) return [];
    return run.results.flatMap((result) => {
      if (!isRecord(result)) return [];
      const location = Array.isArray(result.locations) ? result.locations[0] : undefined;
      const physicalLocation = isRecord(location) ? location.physicalLocation : undefined;
      const artifactLocation = isRecord(physicalLocation) ? physicalLocation.artifactLocation : undefined;
      const region = isRecord(physicalLocation) ? physicalLocation.region : undefined;
      const message = isRecord(result.message) && typeof result.message.text === "string" ? result.message.text : String(result.ruleId ?? "External diagnostic.");
      return [
        {
          file: isRecord(artifactLocation) && typeof artifactLocation.uri === "string" ? artifactLocation.uri : undefined,
          line: isRecord(region) ? numberValue(region.startLine) : undefined,
          column: isRecord(region) ? numberValue(region.startColumn) : undefined,
          message,
          code: typeof result.ruleId === "string" ? result.ruleId : undefined,
        },
      ];
    });
  });
}

export function defaultJsonDiagnostic(value: unknown): ExternalDiagnosticInput | null {
  if (!isRecord(value)) return null;
  const message = stringValue(value.message) ?? stringValue(value.title) ?? stringValue(value.reason);
  if (!message) return null;
  return {
    file: stringValue(value.file) ?? stringValue(value.path),
    line: numberValue(value.line),
    column: numberValue(value.column),
    message,
    code: stringValue(value.code) ?? stringValue(value.rule) ?? stringValue(value.ruleId),
    severity: severityValue(value.severity),
  };
}

export function normalizeMappedDiagnostic(value: ExternalDiagnosticInput | ExternalDiagnosticInput[] | null | undefined): ExternalDiagnosticInput[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function isMissingCommandError(error: Error): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function severityValue(value: unknown): ExternalDiagnosticInput["severity"] | undefined {
  return value === "error" || value === "warning" || value === "info" ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function firstCodeLineNumber(lines: string[], language: "typescript" | "svelte" | "python" | "json" | "markdown" | "text"): number {
  let inBlockComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    let text = lines[index].trim();
    if (!text) continue;

    if (language === "python") {
      if (text.startsWith("#")) continue;
      return index + 1;
    }

    if (language !== "typescript" && language !== "svelte") return index + 1;

    while (text.length > 0) {
      if (inBlockComment) {
        const end = text.indexOf("*/");
        if (end === -1) {
          text = "";
          break;
        }
        inBlockComment = false;
        text = text.slice(end + 2).trim();
        continue;
      }

      if (text.startsWith("//")) {
        text = "";
        break;
      }

      if (text.startsWith("/*")) {
        const end = text.indexOf("*/", 2);
        if (end === -1) {
          inBlockComment = true;
          text = "";
          break;
        }
        text = text.slice(end + 2).trim();
        continue;
      }

      return index + 1;
    }
  }

  return Number.POSITIVE_INFINITY;
}

export function safeEnumReplacement(declaration: TypeScriptEnumDeclaration, isPascalCase: (value: string) => boolean): string | null {
  if (!declaration.exported) return null;
  if (!isPascalCase(declaration.name)) return null;
  if (declaration.members.length === 0) return null;
  if (declaration.members.some((member) => !isPascalCase(member.name) || member.valueKind !== "string" || member.value === undefined)) return null;

  const properties = declaration.members.map((member) => `  ${member.name}: ${JSON.stringify(member.value)},`).join("\n");
  return `export const ${declaration.name} = {\n${properties}\n} as const;\n\nexport type ${declaration.name} = (typeof ${declaration.name})[keyof typeof ${declaration.name}];`;
}

export function paramsContain(params: string[], param: string | RegExp, position: "any" | "first" | "last"): boolean {
  if (params.length === 0) return false;
  if (position === "first") return valueMatches(params[0], param);
  if (position === "last") return valueMatches(params[params.length - 1], param);
  return params.some((item) => valueMatches(item, param));
}

export function interpolateSibling(filePath: string, template: string): string {
  const parsed = path.posix.parse(filePath);
  return path.posix.join(
    parsed.dir,
    template
      .replaceAll("{name}", parsed.base)
      .replaceAll("{stem}", parsed.name)
      .replaceAll("{ext}", parsed.ext.replace(/^\./, "")),
  );
}

export function isBarrelFile(file: string): boolean {
  return /(^|\/)index\.(ts|tsx|js|jsx|svelte)$/.test(file);
}

export function edgeMatches(
  runtime: { globs: { matches(file: string, patterns: string[]): boolean } },
  edge: { source: string; resolvedPath?: string; toPackage?: string },
  patterns: string[],
): boolean {
  const normalizedSource = edge.source.split(path.sep).join("/");
  const unrootedSource = normalizedSource.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  return [edge.resolvedPath, edge.toPackage, normalizedSource, unrootedSource].filter((value): value is string => Boolean(value)).some((candidate) => runtime.globs.matches(candidate, patterns));
}

export function matchesAny(
  runtime: { globs: { matches(file: string, patterns: string[]): boolean } },
  filePath: string,
  fileName: string,
  patterns: string[],
): boolean {
  return runtime.globs.matches(filePath, patterns) || runtime.globs.matches(fileName, patterns);
}

export function valueMatches(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") return value === pattern || value.includes(pattern);
  return regexMatches(pattern, value);
}

export function literalIgnored(value: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((pattern) => (typeof pattern === "string" ? value === pattern : regexMatches(pattern, value)));
}

export function importedSymbolName(specifier: string): string {
  return specifier
    .replace(/^type\s+/, "")
    .split(/\s+as\s+/)[0]
    .trim();
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

export function optionSummary(options: { summary?: ValidatorSummary; message?: string }, fallback: string): ValidatorSummary {
  return options.summary ?? options.message ?? fallback;
}

export function joinPatterns(patterns: string[]): string {
  return patterns.join(", ");
}

export function regexMatches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

export function manualFix(description: string): { safety: FixSafety; description: string } {
  return { safety: ValidatorFixSafety.Manual, description };
}

export function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
