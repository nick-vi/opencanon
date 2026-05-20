import { readFileSync } from "node:fs";
import type { CodeSymbol, Validator } from "@opencanon/core";
import { fail, listFiles, matchesAny, relative, resolveRootDir, type ContextPaths, type Decision, type Format } from "@opencanon/core";
import { openCodeGraph } from "./code-graph.ts";
import { loadProjectContext } from "./project.ts";

type SearchKind = "all" | "symbol" | "decision" | "validator" | "doc";

type SearchQuery = {
  query: string;
  kind: SearchKind;
  symbolKind?: string;
  scopes: string[];
  limit: number;
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

export async function runSearchCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const context = await loadProjectContext(rootDir);
  const results = collectSearchResults(rootDir, query, {
    decisions: context.decisions,
    validators: context.validators,
    paths: context.paths,
  });

  if (query.format === "json") {
    console.log(JSON.stringify({ query: query.query, results }, null, 2));
    return;
  }
  printResults(query, results);
}

function collectSearchResults(
  rootDir: string,
  query: SearchQuery,
  input: { decisions: Decision[]; validators: Validator[]; paths: ContextPaths },
): SearchResult[] {
  const results: SearchResult[] = [];
  if (query.kind === "all" || query.kind === "symbol") results.push(...searchSymbols(rootDir, query));
  if (query.kind === "all" || query.kind === "decision") results.push(...searchDecisions(rootDir, query.query, input.decisions, input.paths.decisionsPath));
  if (query.kind === "all" || query.kind === "validator") results.push(...searchValidators(rootDir, query.query, input.validators, input.paths.validatorsPath));
  if (query.kind === "all" || query.kind === "doc") results.push(...searchDocs(rootDir, query.query, input.paths.docsDir));
  return results
    .filter((result) => inScope(result.path, query.scopes))
    .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path) || left.title.localeCompare(right.title))
    .slice(0, query.limit);
}

function searchSymbols(rootDir: string, query: SearchQuery): SearchResult[] {
  const graph = openCodeGraph(rootDir);
  try {
    const engineLimit = Math.max(query.limit * (query.scopes.length > 0 ? 10 : 4), 50);
    const symbols = graph.store.project.searchSymbols({ query: query.query, kind: query.symbolKind, limit: engineLimit }).symbols;
    return symbols.map((symbol) => symbolResult(symbol, query.query));
  } finally {
    graph.close();
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

function searchDecisions(rootDir: string, query: string, decisions: Decision[], decisionsPath: string): SearchResult[] {
  return decisions
    .map((decision) => ({
      decision,
      score: scoreText(query, [decision.id, decision.title, decision.summary, decision.status, ...decision.topics, ...decision.applies]),
    }))
    .filter((item) => item.score > 0)
    .map(({ decision, score }) => ({
      kind: "decision",
      title: `${decision.id}: ${decision.title}`,
      path: relative(rootDir, decisionsPath),
      detail: decision.summary,
      score,
    }));
}

function searchValidators(rootDir: string, query: string, validators: Validator[], validatorsPath: string): SearchResult[] {
  return validators
    .map((validator) => ({
      validator,
      score: scoreText(query, [validator.id, validator.summary ?? "", validator.scope, validator.severity, validator.topics, validator.appliesScopes, validator.facts]),
    }))
    .filter((item) => item.score > 0)
    .map(({ validator, score }) => ({
      kind: "validator",
      title: validator.id,
      path: relative(rootDir, validatorsPath),
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
      if (!value || !["all", "symbol", "decision", "validator", "doc"].includes(value)) fail(`Invalid --kind: ${String(value)}`);
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
    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== "markdown" && value !== "json") fail(`Invalid --format: ${String(value)}`);
      format = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown search option: ${arg}`);
    positional.push(arg);
  }
  if (help) return { query: "", kind, symbolKind, scopes, limit, format, help };
  if (positional.length !== 1) fail("Expected one search query.");
  return { query: positional[0], kind, symbolKind, scopes, limit, format, help };
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
  opencanon search <query> --kind symbol --symbol-kind function --scope "src/domain/**"
  opencanon search <query> --kind decision --format json

Options:
  --kind <kind>    all, symbol, decision, validator, or doc (default all).
  --symbol-kind    Restrict symbol results to a graph symbol kind.
  --scope <glob>   Restrict result paths to matching file globs. Repeatable.
  --limit <n>      Maximum results to return (default 50, max 500).
  --format <fmt>   markdown or json.
`);
}
