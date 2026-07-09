import { readFileSync } from "node:fs";
import type { CodeSymbol, Convention, Validator } from "@opencanon/core";
import { fail, Format, listFiles, matchesAny, relative, resolveRootDir, type ContextPaths } from "@opencanon/core";
import { loadProjectContext } from "./project.ts";
import { RuntimeApiRoute, withRuntimeClient } from "./runtime-client.ts";

// Single source of truth for search kinds; reference members instead of inlining the strings.
const SearchKind = { All: "all", Symbol: "symbol", Convention: "convention", Validator: "validator", Doc: "doc", Context: "context" } as const;
type SearchKind = (typeof SearchKind)[keyof typeof SearchKind];
const ContextSearchRequestTimeoutMs = 20_000;
const ContextSearchStartupTimeoutMs = 20_000;

type SearchQuery = {
  query: string;
  kind: SearchKind;
  symbolKind?: string;
  scopes: string[];
  limit: number;
  index: boolean;
  format: Format;
  help: boolean;
};

type SearchResult = {
  kind: Exclude<SearchKind, "all">;
  title: string;
  path: string;
  line?: number;
  detail?: string;
  score: number;
};

type ContextSearchResponse = {
  results: Array<{
    chunk: {
      path: string;
      preview: string;
      range: { start: { line: number } };
    };
    score: number;
  }>;
};

type CodeSymbolsResponse = {
  symbols: CodeSymbol[];
};

export async function runSearchCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const context = await loadProjectContext(rootDir);
  const results = await collectSearchResults(rootDir, query, {
    conventions: context.conventions,
    validators: context.validators,
    paths: context.paths,
  });

  if (query.format === Format.Json) {
    console.log(JSON.stringify({ query: query.query, results }, null, 2));
    return;
  }
  printResults(query, results);
}

async function collectSearchResults(
  rootDir: string,
  query: SearchQuery,
  input: { conventions: Convention[]; validators: Validator[]; paths: ContextPaths },
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  if (query.kind === SearchKind.All || query.kind === SearchKind.Symbol) results.push(...(await searchSymbols(rootDir, query)));
  if (query.kind === SearchKind.All || query.kind === SearchKind.Convention) results.push(...searchConventions(rootDir, query.query, input.conventions, input.paths.conventionsPath));
  if (query.kind === SearchKind.All || query.kind === SearchKind.Validator) results.push(...searchValidators(rootDir, query.query, input.validators, input.paths.conventionsPath));
  if (query.kind === SearchKind.All || query.kind === SearchKind.Doc) results.push(...searchDocs(rootDir, query.query, input.paths.docsDir));
  if (query.kind === SearchKind.All || query.kind === SearchKind.Context) results.push(...(await searchProjectContext(rootDir, query)));
  return results
    .filter((result) => inScope(result.path, query.scopes))
    .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path) || left.title.localeCompare(right.title))
    .slice(0, query.limit);
}

async function searchSymbols(rootDir: string, query: SearchQuery): Promise<SearchResult[]> {
  const engineLimit = Math.max(query.limit * (query.scopes.length > 0 ? 10 : 4), 50);
  const params = new URLSearchParams({
    query: query.query,
    limit: String(engineLimit),
  });
  if (query.symbolKind) params.set("kind", query.symbolKind);
  const result = await withRuntimeClient<CodeSymbolsResponse>(rootDir, (client) => client.get(`${RuntimeApiRoute.CodeSymbols}?${params.toString()}`));
  return result.symbols.map((symbol) => symbolResult(symbol, query.query));
}

async function searchProjectContext(rootDir: string, query: SearchQuery): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams();
    params.set("query", query.query);
    params.set("limit", String(query.limit));
    if (query.index) params.set("index", "1");
    const response = await withRuntimeClient<ContextSearchResponse>(
      rootDir,
      (client) => client.get(`${RuntimeApiRoute.ContextSearch}?${params.toString()}`),
      { requestTimeoutMs: ContextSearchRequestTimeoutMs, startupTimeoutMs: ContextSearchStartupTimeoutMs },
    );
    return response.results.map((result) => ({
      kind: "context",
      title: result.chunk.preview || result.chunk.path,
      path: result.chunk.path,
      line: result.chunk.range.start.line,
      detail: result.chunk.preview,
      score: Math.round(result.score * 100),
    }));
  } catch (error) {
    if (query.kind === SearchKind.Context) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`Project Context search failed: ${message}`);
    }
    return [];
  }
}

function inScope(file: string, scopes: string[]): boolean {
  return scopes.length === 0 || matchesAny(file, scopes);
}

function symbolResult(symbol: CodeSymbol, query: string): SearchResult {
  return {
    kind: "symbol",
    title: `${symbol.kind} ${symbol.name}`,
    path: symbol.path,
    line: symbol.range.start.line,
    detail: symbol.qualifiedName !== symbol.name ? symbol.qualifiedName : undefined,
    score: scoreText(query, [symbol.name, symbol.qualifiedName, symbol.kind, symbol.path]),
  };
}

function searchConventions(rootDir: string, query: string, conventions: Convention[], conventionsPath: string): SearchResult[] {
  return conventions
    .map((convention) => ({
      convention,
      score: scoreText(query, [convention.id, convention.title, convention.rule, convention.topics ?? [], conventionApplies(convention)]),
    }))
    .filter((item) => item.score > 0)
    .map(({ convention, score }) => ({
      kind: "convention",
      title: `${convention.id}: ${convention.title}`,
      path: relative(rootDir, conventionsPath),
      detail: convention.rule,
      score,
    }));
}

function conventionApplies(convention: Convention): string[] {
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return convention.applies.globs;
    case "imports":
      return [...(convention.applies.from ?? []), ...(convention.applies.to ?? [])];
    case "impact-surface":
      return convention.applies.surfaceIds;
    case "definitions":
      return convention.applies.definitions.flatMap((target) => (target.ids ?? ["*"]).map((id) => `${target.kind}:${id}`));
    case "project":
      return [convention.applies.describe ?? "project"];
    case "custom":
      return [convention.applies.describe];
  }
}

function searchValidators(rootDir: string, query: string, validators: Validator[], conventionsPath: string): SearchResult[] {
  return validators
    .map((validator) => ({
      validator,
      score: scoreText(query, [validator.id, validator.summary ?? "", validator.scope, validator.severity, validator.topics, validator.appliesScopes, validator.facts]),
    }))
    .filter((item) => item.score > 0)
    .map(({ validator, score }) => ({
      kind: "validator",
      title: validator.id,
      path: relative(rootDir, conventionsPath),
      detail: validator.summary,
      score,
    }));
}

function searchDocs(rootDir: string, query: string, docsDir: string): SearchResult[] {
  const files = listFiles(docsDir, (file) => /\.(md|markdown)$/i.test(file));
  const results: SearchResult[] = [];
  for (const file of files) {
    const relativePath = relative(rootDir, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const score = scoreText(query, [line, relativePath]);
      if (score === 0) continue;
      results.push({
        kind: "doc",
        title: line.trim().replace(/^#+\s*/, "") || relativePath,
        path: relativePath,
        line: index + 1,
        detail: line.trim(),
        score,
      });
    }
  }
  return results;
}

function scoreText(query: string, fields: unknown[]): number {
  const needle = normalize(query);
  if (!needle) return 1;
  let best = 0;
  for (const field of fields.flat(2)) {
    if (typeof field !== "string") continue;
    const value = normalize(field);
    if (!value) continue;
    if (value === needle) best = Math.max(best, 100);
    else if (value.startsWith(needle)) best = Math.max(best, 80);
    else if (value.includes(needle)) best = Math.max(best, 60);
    else if (isSubsequence(needle, value)) best = Math.max(best, Math.max(10, 40 - (value.length - needle.length)));
  }
  return best;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function parseArgs(args: string[]): SearchQuery {
  let kind: SearchKind = "all";
  let symbolKind: string | undefined;
  const scopes: string[] = [];
  let limit = 50;
  let indexBeforeContextSearch = false;
  let format: Format = "markdown";
  let help = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--kind") {
      const value = args[index + 1] as SearchKind | undefined;
      if (!value || !["all", "symbol", "convention", "validator", "doc", "context"].includes(value)) fail(`Invalid --kind: ${String(value)}`);
      kind = value;
      index += 1;
      continue;
    }
    if (arg === "--symbol-kind") {
      const value = args[index + 1];
      if (!value) fail("Missing value for --symbol-kind.");
      symbolKind = value;
      index += 1;
      continue;
    }
    if (arg === "--scope") {
      const value = args[index + 1];
      if (!value) fail("Missing value for --scope.");
      scopes.push(value);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 500) fail(`Invalid --limit: ${args[index + 1]}`);
      limit = value;
      index += 1;
      continue;
    }
    if (arg === "--index") {
      indexBeforeContextSearch = true;
      continue;
    }
    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== Format.Markdown && value !== Format.Json) fail(`Invalid --format: ${String(value)}`);
      format = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown search option: ${arg}`);
    positional.push(arg);
  }
  if (help) return { query: "", kind, symbolKind, scopes, limit, index: indexBeforeContextSearch, format, help };
  if (positional.length !== 1) fail("Expected one search query.");
  return { query: positional[0], kind, symbolKind, scopes, limit, index: indexBeforeContextSearch, format, help };
}

function printResults(query: SearchQuery, results: SearchResult[]): void {
  if (results.length === 0) {
    console.log(`# No ${query.kind} results match ${query.query}.`);
    return;
  }
  for (const result of results) {
    const location = result.line ? `${result.path}:${result.line}` : result.path;
    const detail = result.detail ? ` - ${result.detail}` : "";
    console.log(`${result.kind} ${result.title} ${location}${detail}`);
  }
}

function printHelp(): void {
  console.log(`Usage:
  opencanon search <query>
  opencanon search <query> --kind symbol
  opencanon search <query> --kind context
  opencanon search <query> --kind symbol --symbol-kind function --scope "src/domain/**"
  opencanon search <query> --kind convention --format json

Options:
  --kind <kind>    all, symbol, convention, validator, doc, or context (default all).
  --symbol-kind    Restrict symbol results to a graph symbol kind.
  --scope <glob>   Restrict result paths to matching file globs. Repeatable.
  --limit <n>      Maximum results to return (default 50, max 500).
  --index          Build Project Context before context search.
  --format <fmt>   markdown or json.
`);
}
