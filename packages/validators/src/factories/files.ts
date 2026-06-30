import { createConventionFactory, LiteralValueKind, ProjectSymbolKind, TypeScriptDeclarationKind } from "@opencanon/core";
import type { Finding, LiteralContext } from "@opencanon/core";
import { edgeMatches, importedSymbolName, list, literalIgnored, manualFix, optionSummary, joinPatterns, matchesAny, paramsContain, safeEnumReplacement, valueMatches, interpolateSibling } from "../shared.ts";
import type { FileNameOptions, RequiredFunctionParamOptions, RequiredFileSiblingOptions, RequireExportPatternOptions, NoUnusedExportsOptions, SimilarFunctionNamesOptions, NoNativeEnumsOptions, RepeatedLiteralsOptions, RestrictedSymbolsOptions, NoSecretLikeLiteralsOptions, NoHardcodedConfigValuesOptions } from "../shared.ts";
import path from "node:path";

export const fileNames = createConventionFactory<FileNameOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  conventionIds: options.related,
  summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} must use the configured file naming pattern.`),
  validate({ ctx, runtime }) {
    const suffixes = list(options.suffix);
    const allowed = new Set(options.allowNames ?? []);

    return ctx.targetFiles
      .filter((file) => !allowed.has(path.posix.basename(file.path)))
      .filter((file) => {
        const fileName = path.posix.basename(file.path);
        const nameMatches = options.names && matchesAny(runtime, file.path, fileName, options.names);
        const suffixMatches = suffixes.length > 0 && suffixes.some((suffix) => file.path.endsWith(suffix));
        return !nameMatches && !suffixMatches;
      })
      .map((file) =>
        file.report({
          line: 1,
          message: options.message,
          fix: options.fix ?? manualFix("Rename the file to match the convention and update imports."),
          docs: options.docs,
        }),
      );
  },
}));

export const requiredFunctionParam = createConventionFactory<RequiredFunctionParamOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  facts: ["symbols"],
  conventionIds: options.related,
  summary: optionSummary(options, `Functions in ${joinPatterns(options.in)} must include the required parameter.`),
  validate({ ctx }) {
    const functionPatterns = list(options.functions);
    const targetPaths = new Set(ctx.targetFiles.map((file) => file.path));
    return ctx.facts
      .symbols()
      .filter((fn) => targetPaths.has(fn.file.path))
      .filter((fn) => fn.kind === ProjectSymbolKind.Function)
        .filter((fn) => !options.exportedOnly || fn.exported)
        .filter((fn) => functionPatterns.length === 0 || functionPatterns.some((pattern) => valueMatches(fn.name, pattern)))
      .filter((fn) => !paramsContain(fn.params ?? [], options.param, options.position ?? "any"))
        .map((fn) =>
          fn.file.report({
            line: fn.line,
            message: options.message,
            fix: options.fix ?? manualFix("Add the required function parameter following the local signature convention."),
            docs: options.docs,
          }),
        );
  },
}));

export const requiredFileSibling = createConventionFactory<RequiredFileSiblingOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  conventionIds: options.related,
  summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} must have sibling file ${joinPatterns(list(options.sibling))}.`),
  validate({ ctx }) {
    const projectFiles = new Set(ctx.files.map((file) => file.path));
    return ctx.targetFiles.flatMap((file) =>
      list(options.sibling)
        .map((sibling) => interpolateSibling(file.path, sibling))
        .filter((sibling) => !projectFiles.has(sibling))
        .map((sibling) =>
          file.report({
            line: 1,
            message: options.message,
            fix: options.fix ?? manualFix(`Add required sibling file ${sibling}.`),
            docs: options.docs,
          }),
        ),
    );
  },
}));

export const requireExportPattern = createConventionFactory<RequireExportPatternOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  facts: ["exports"],
  conventionIds: options.related,
  summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} must export a symbol matching the required pattern.`),
  validate({ ctx }) {
    const names = list(options.names);
    const kinds = new Set(options.kinds ?? []);
    return ctx.targetFiles.flatMap((file) => {
      const exports = ctx.facts.exports().filter((item) => item.file.path === file.path && (kinds.size === 0 || kinds.has(item.kind)));
      if (exports.some((item) => names.some((name) => valueMatches(item.name, name)))) return [];
      return [
        file.report({
          line: 1,
          message: options.message,
          fix: options.fix ?? manualFix("Export a symbol that matches the required naming pattern."),
          docs: options.docs,
        }),
      ];
    });
  },
}));

export const noUnusedExports = createConventionFactory<NoUnusedExportsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  facts: ["symbols", "references"],
  conventionIds: options.related,
  summary: optionSummary(options, `Exports in ${joinPatterns(options.in)} must have a known project reference.`),
  validate({ ctx, runtime }) {
    const allowed = list(options.allow);
    const kinds = new Set(options.kinds ?? []);
    const targetPaths = new Set(ctx.targetFiles.map((file) => file.path));
    const entrypoints = [...runtime.paths.entrypoints, ...(options.entrypoints ?? [])];
    const publicSurfaces = [...(options.ignoreConfiguredPublicSurfaces ? [] : runtime.paths.publicSurfaces), ...(options.publicSurfaces ?? [])];
    const publicPatterns = [...entrypoints, ...publicSurfaces];

    return ctx.graph
      .symbols()
      .filter((symbol) => symbol.exported)
      .filter((symbol) => targetPaths.has(symbol.file.path))
      .filter((symbol) => kinds.size === 0 || kinds.has(symbol.kind))
      .filter((symbol) => !allowed.some((pattern) => valueMatches(symbol.name, pattern)))
      .filter((symbol) => !matchesAny(runtime, symbol.file.path, path.posix.basename(symbol.file.path), publicPatterns))
      .filter((symbol) => ctx.graph.callers(symbol).length === 0)
      .map((symbol) =>
        symbol.file.report({
          line: symbol.line,
          column: symbol.column,
          message: options.message,
          fix: options.fix ?? manualFix("Remove the export, make it private, or add the missing project reference/entrypoint rule."),
          docs: options.docs,
        }),
      );
  },
}));

export const similarFunctionNames = createConventionFactory<SimilarFunctionNamesOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  facts: ["symbols", "calls"],
  conventionIds: options.related,
  summary: optionSummary(options, `Function names in ${joinPatterns(options.in)} should not describe duplicate or near-duplicate behavior.`),
  validate({ ctx }) {
    const minSimilarity = options.minSimilarity ?? 0.82;
    const targetPaths = new Set(ctx.targetFiles.map((file) => file.path));
    const allow = options.allow ?? [];
    const functions = ctx.graph
      .symbols()
      .filter((symbol) => symbol.kind === ProjectSymbolKind.Function || symbol.kind === ProjectSymbolKind.Method)
      .filter((symbol) => targetPaths.has(symbol.file.path))
      .filter((symbol) => !allow.some((pattern) => valueMatches(symbol.name, pattern)));
    const findings: Finding[] = [];
    const reported = new Set<string>();

    for (let leftIndex = 0; leftIndex < functions.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < functions.length; rightIndex += 1) {
        const left = functions[leftIndex];
        const right = functions[rightIndex];
        const similarity = nameSimilarity(left.name, right.name);
        if (similarity < minSimilarity) continue;
        const sharedCallees = sharedCalleeNames(ctx.graph.callees(left), ctx.graph.callees(right));
        if (options.requireSharedCallees && sharedCallees.length === 0) continue;
        const key = [left.file.path, left.name, right.file.path, right.name].sort().join("\0");
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push(
          left.file.report({
            line: left.line,
            column: left.column,
            message: `${options.message} Similar functions: ${left.name} and ${right.name}${sharedCallees.length > 0 ? ` share callees ${sharedCallees.join(", ")}` : ""}.`,
            fix: options.fix ?? manualFix("Compare these functions and merge, rename, or extract the shared behavior if they are duplicates."),
            docs: options.docs,
          }),
        );
      }
    }

    return findings;
  },
}));

export const noNativeEnums = createConventionFactory<NoNativeEnumsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  facts: ["declarations"],
  conventionIds: options.related,
  summary: options.summary ?? options.message ?? `Files matching ${joinPatterns(options.in)} must use const-object enum patterns instead of native TypeScript enums.`,
  validate({ ctx, runtime }) {
    const findings: Finding[] = [];

    for (const file of ctx.targetFiles) {
      for (const declaration of file.ts.declarations()) {
        if (declaration.kind !== TypeScriptDeclarationKind.Enum) continue;
        const replacement = options.safeFix === false ? null : safeEnumReplacement(declaration, runtime.naming);
        findings.push(
          file.report({
            line: declaration.line,
            message: options.message ?? `Native TypeScript enum ${declaration.name} is not allowed.`,
            fix: replacement
              ? {
                  safety: "safe",
                  description: "Replace this string enum with a const object plus derived union type.",
                  edits: [
                    {
                      file: file.path,
                      range: {
                        startLine: declaration.line,
                        startColumn: 1,
                        endLine: declaration.endLine,
                        endColumn: file.lineAt(declaration.endLine).length + 1,
                      },
                      replacement,
                    },
                  ],
                }
              : manualFix("Rewrite this enum as a const object and update call sites if member names or values need semantic changes."),
            docs: options.docs,
          }),
        );
      }
    }

    return findings;
  },
}));

function nameSimilarity(left: string, right: string): number {
  const leftName = normalizeIdentifier(left);
  const rightName = normalizeIdentifier(right);
  if (!leftName || !rightName) return 0;
  if (leftName === rightName) return 1;
  const distance = levenshteinDistance(leftName, rightName);
  return 1 - distance / Math.max(leftName.length, rightName.length);
}

function normalizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b(?:get|set|load|fetch|read|write|create|update|delete|remove|handle|process|do)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(current[rightIndex - 1] + 1, previous[rightIndex] + 1, previous[rightIndex - 1] + cost);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function sharedCalleeNames(left: Array<{ target: { name: string } }>, right: Array<{ target: { name: string } }>): string[] {
  const rightNames = new Set(right.map((edge) => edge.target.name));
  return [...new Set(left.map((edge) => edge.target.name).filter((name) => rightNames.has(name)))].sort();
}

export const repeatedLiterals = createConventionFactory<RepeatedLiteralsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "project",
  facts: ["literals"],
  conventionIds: options.related,
  summary: optionSummary(options, `Repeated primitive literals in ${joinPatterns(options.in)} should be extracted into named constants or const-object enum patterns.`),
  validate({ ctx }) {
    const minOccurrences = options.minOccurrences ?? 3;
    const minFiles = options.minFiles ?? 1;
    const valueKinds = new Set(options.valueKinds ?? ["string"]);
    const contexts = new Set<LiteralContext>(options.contexts ?? ["comparison", "argument", "object-property", "array-item"]);
    const groups = new Map<string, Array<{ file: (typeof ctx.targetFiles)[number]; line: number; column: number; value: string; valueKind: string }>>();

    for (const file of ctx.targetFiles) {
      for (const literal of ctx.facts.literals().filter((item) => item.file.path === file.path)) {
        if (!valueKinds.has(literal.valueKind)) continue;
        if (!contexts.has(literal.context)) continue;
        if (literal.value.trim() === "") continue;
        if (/^(?:\\[nrt])+$/u.test(literal.value)) continue;
        if (!/[A-Za-z0-9]/.test(literal.value)) continue;
        if (literalIgnored(literal.value, options.ignore ?? [])) continue;
        if (options.excludeTypeofRhs) {
          const lineText = file.lineAt(literal.line);
          const prefix = lineText.slice(0, literal.column - 1);
          if (/typeof\s+[A-Za-z_$][\w$]*\s*(?:===|!==|==|!=)\s*$/.test(prefix)) continue;
        }
        const key = `${literal.valueKind}:${literal.value}`;
        const values = groups.get(key) ?? [];
        values.push({
          file,
          line: literal.line,
          column: literal.column,
          value: literal.value,
          valueKind: literal.valueKind,
        });
        groups.set(key, values);
      }
    }

    return [...groups.values()]
      .filter((values) => values.length >= minOccurrences)
      .filter((values) => new Set(values.map((value) => value.file.path)).size >= minFiles)
      .map((values) => {
        const first = values[0];
        const fileCount = new Set(values.map((value) => value.file.path)).size;
        return first.file.report({
          line: first.line,
          column: first.column,
          message: `${options.message} Literal ${JSON.stringify(first.value)} appears ${values.length} times across ${fileCount} file(s).`,
          fix: options.fix ?? manualFix("Extract this domain literal into a named constant or const-object enum pattern and update call sites."),
          docs: options.docs,
        });
      });
  },
}));

const DefaultSecretLiteralPatterns = [
  /^(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}$/u,
  /^AKIA[0-9A-Z]{16}$/u,
  /^AIza[0-9A-Za-z_-]{20,}$/u,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /^[A-Za-z0-9+/]{40,}={0,2}$/u,
  /^[0-9a-f]{48,}$/iu,
] as const;

const SecretNamePattern = /\b(?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|client[_-]?secret|access[_-]?key|session[_-]?secret|jwt)\b/iu;
const PlaceholderPattern = /^(?:<[^>]+>|\{\{[^}]+\}\}|example|sample|test|dummy|placeholder|redacted|changeme|your[-_a-z0-9]*|[a-z-]*token)$/iu;
const ConfigValueKinds = {
  Host: "host",
  Path: "path",
  Port: "port",
  Url: "url",
} as const;

export const noSecretLikeLiterals = createConventionFactory<NoSecretLikeLiteralsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  facts: ["literals"],
  conventionIds: options.related,
  summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} must not contain secret-like literals.`),
  validate({ ctx, runtime }) {
    const allow = options.allow ?? [];
    const allowFiles = options.allowFiles ?? [];
    const minLength = options.minLength ?? 32;
    const minEntropy = options.minEntropy ?? 3.5;
    const patterns = [...DefaultSecretLiteralPatterns, ...list(options.patterns)];
    const findings: Finding[] = [];

    for (const literal of ctx.facts.literals()) {
      if (literal.valueKind !== LiteralValueKind.String) continue;
      if (!ctx.targetFiles.some((file) => file.path === literal.file.path)) continue;
      if (allowFiles.length > 0 && runtime.globs.matches(literal.file.path, allowFiles)) continue;
      if (literalIgnored(literal.value, allow)) continue;
      if (PlaceholderPattern.test(literal.value)) continue;

      const line = literal.file.lineAt(literal.line);
      const secretNamedAssignment = lineHasSecretAssignmentName(line, literal.column) && literal.value.length >= 8 && !isLocalhostLiteral(literal.value);
      const secretPattern = patterns.some((pattern) => pattern.test(literal.value));
      const highEntropy =
        isSecretTokenCandidate(literal.value) &&
        literal.value.length >= minLength &&
        shannonEntropy(literal.value) >= minEntropy &&
        /[A-Za-z]/.test(literal.value) &&
        /\d/.test(literal.value);
      if (!secretNamedAssignment && !secretPattern && !highEntropy) continue;

      findings.push(
        literal.file.report({
          line: literal.line,
          column: literal.column,
          message: `${options.message} Move this value to a secret manager or environment variable.`,
          fix: options.fix ?? manualFix("Replace the literal with a secret/config lookup and keep real secret values out of source control."),
          docs: options.docs,
        }),
      );
    }

    return findings;
  },
}));

export const noHardcodedConfigValues = createConventionFactory<NoHardcodedConfigValuesOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: "file",
  facts: ["literals"],
  conventionIds: options.related,
  summary: optionSummary(options, `Files matching ${joinPatterns(options.in)} should keep environment-specific config values behind named config.`),
  validate({ ctx, runtime }) {
    const allow = options.allow ?? [];
    const allowFiles = options.allowFiles ?? [];
    const contexts = new Set<LiteralContext>(options.contexts ?? ["argument", "object-property", "array-item", "unknown"]);
    const kinds = new Set(options.kinds ?? [ConfigValueKinds.Url, ConfigValueKinds.Host, ConfigValueKinds.Port, ConfigValueKinds.Path]);
    const findings: Finding[] = [];

    for (const literal of ctx.facts.literals()) {
      if (!ctx.targetFiles.some((file) => file.path === literal.file.path)) continue;
      if (!contexts.has(literal.context)) continue;
      if (allowFiles.length > 0 && runtime.globs.matches(literal.file.path, allowFiles)) continue;
      if (literalIgnored(literal.value, allow)) continue;

      const kind = configLiteralKind(literal.value, literal.valueKind, kinds);
      if (!kind) continue;

      findings.push(
        literal.file.report({
          line: literal.line,
          column: literal.column,
          message: `${options.message} Hardcoded ${kind}: ${JSON.stringify(literal.value)}.`,
          fix: options.fix ?? manualFix("Move this value behind a named config constant or environment-specific setting."),
          docs: options.docs,
        }),
      );
    }

    return findings;
  },
}));

export const restrictedSymbols = createConventionFactory<RestrictedSymbolsOptions>((options) => ({
  id: options.id,
  topics: options.topics,
  applies: options.in,
  severity: options.severity,
  scope: options.scanText ? "file" : "import-edge",
  facts: options.scanText ? ["imports", "symbols"] : ["imports"],
  conventionIds: options.related,
  summary: optionSummary(options, `Symbols ${options.symbols.join(", ")} are restricted outside ${joinPatterns(options.allowIn)}.`),
  validate({ ctx, runtime }) {
    const symbols = new Set(options.symbols);
    const targetPaths = new Set(ctx.targetFiles.map((file) => file.path));
    const findings: Finding[] = [];
    const seen = new Set<string>();

    const pushFinding = (finding: Finding) => {
      const key = [finding.file, finding.line, finding.column ?? 0, finding.message].join("\0");
      if (seen.has(key)) return;
      seen.add(key);
      findings.push(finding);
    };

    for (const edge of ctx.facts.imports()) {
      if (!targetPaths.has(edge.from.path)) continue;
      if (runtime.globs.matches(edge.from.path, options.allowIn)) continue;
      if (options.from && !edgeMatches(runtime, edge, options.from)) continue;
      const matched = edge.specifiers.map(importedSymbolName).filter((specifier) => symbols.has(specifier));
      if (matched.length === 0) continue;

      pushFinding(
        edge.from.report({
          line: edge.line,
          message: `${options.message} Restricted symbol: ${matched.join(", ")}.`,
          fix: options.fix ?? manualFix("Move this usage behind the approved owner or import an approved facade."),
          docs: options.docs,
        }),
      );
    }

    if (options.scanText) {
      for (const file of ctx.targetFiles) {
        if (runtime.globs.matches(file.path, options.allowIn)) continue;
        for (const symbol of symbols) {
          for (const match of file.find(new RegExp(`\\b${RegExp.escape(symbol)}\\b`, "g"))) {
            pushFinding(
              file.report({
                line: match.line,
                column: match.column,
                message: `${options.message} Restricted symbol: ${symbol}.`,
                fix: options.fix ?? manualFix("Move this usage behind the approved owner or import an approved facade."),
                docs: options.docs,
              }),
            );
          }
        }
      }
    }

    return findings;
  },
}));

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function isLocalhostLiteral(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value.startsWith("http://127.0.0.1") || value.startsWith("http://localhost");
}

function isSecretTokenCandidate(value: string): boolean {
  return !/\s/u.test(value);
}

function lineHasSecretAssignmentName(line: string, literalColumn: number): boolean {
  const beforeLiteral = line.slice(0, literalColumn - 1);
  const assignmentMatch = beforeLiteral.match(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*[:=][^:=]*$/u) ?? beforeLiteral.match(/([A-Za-z_$][\w$]*)\s*:\s*$/u);
  return assignmentMatch ? SecretNamePattern.test(splitIdentifierWords(assignmentMatch[1])) : false;
}

function splitIdentifierWords(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function configLiteralKind(value: string, valueKind: string, kinds: Set<"url" | "host" | "port" | "path">): "url" | "host" | "port" | "path" | null {
  if (valueKind === "number") {
    const port = Number(value);
    return kinds.has(ConfigValueKinds.Port) && Number.isInteger(port) && port >= 1024 && port <= 65535 ? ConfigValueKinds.Port : null;
  }
  if (valueKind !== "string") return null;
  if (kinds.has(ConfigValueKinds.Url) && /^https?:\/\/[^\s"'`]+$/iu.test(value)) return ConfigValueKinds.Url;
  if (kinds.has(ConfigValueKinds.Host) && /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)$/u.test(value)) return ConfigValueKinds.Host;
  if (kinds.has(ConfigValueKinds.Port) && /^\d{4,5}$/u.test(value)) {
    const port = Number(value);
    if (port >= 1024 && port <= 65535) return ConfigValueKinds.Port;
  }
  if (kinds.has(ConfigValueKinds.Path) && isConfigPath(value)) return ConfigValueKinds.Path;
  return null;
}

function isConfigPath(value: string): boolean {
  if (value.length < 4) return false;
  if (/^(?:\.{0,2}\/|~\/|\/)[A-Za-z0-9._/-]+$/u.test(value)) return true;
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/u.test(value) && !value.includes("**") && !value.startsWith("docs/");
}
