import { fail, matchesAny, resolveRootDir, type CodeReference, type CodeSymbol, type Format } from "@opencanon/core";
import { openCodeGraph } from "./code-graph.ts";

type SymbolsQuery = {
  query?: string;
  inPath?: string;
  kind?: string;
  scopes: string[];
  limit: number;
  references: boolean;
  format: Format;
  help: boolean;
};

export async function runSymbolsCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const graph = openCodeGraph(rootDir);
  try {
    const engineLimit = query.scopes.length > 0 ? Math.max(query.limit * 10, 500) : query.limit;
    if (query.references) {
      const result = graph.store.project.searchReferences({
        query: query.query,
        path: query.inPath,
        kind: query.kind,
        limit: engineLimit,
      });
      const references = filterReferences(result.references, query);
      if (query.format === "json") console.log(JSON.stringify({ sourceFiles: graph.sourceFiles.length, references }, null, 2));
      else printReferences(references, graph.sourceFiles.length, query);
      return;
    }
    const result = graph.store.project.searchSymbols({
      query: query.query,
      path: query.inPath,
      kind: query.kind,
      limit: engineLimit,
    });
    const symbols = filterSymbols(result.symbols, query);
    if (query.format === "json") console.log(JSON.stringify({ sourceFiles: graph.sourceFiles.length, symbols }, null, 2));
    else printSymbols(symbols, graph.sourceFiles.length, query);
  } finally {
    graph.close();
  }
}

function parseArgs(args: string[]): SymbolsQuery {
  let query: string | undefined;
  let inPath: string | undefined;
  let kind: string | undefined;
  const scopes: string[] = [];
  let limit = 50;
  let references = false;
  let format: Format = "markdown";
  let help = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--in") {
      inPath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--kind") {
      kind = args[index + 1];
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
    if (arg === "--references") {
      references = true;
      continue;
    }
    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== "markdown" && value !== "json") fail(`Invalid --format: ${value}`);
      format = value;
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
    if (arg.startsWith("--")) fail(`Unknown symbols option: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) fail(`Unexpected symbols arguments: ${positional.slice(1).join(", ")}`);
  query = positional[0];
  return { query, inPath, kind, scopes, limit, references, format, help };
}

function filterSymbols(symbols: CodeSymbol[], query: SymbolsQuery): CodeSymbol[] {
  return symbols.filter((symbol) => inScope(symbol.path, query.scopes)).slice(0, query.limit);
}

function filterReferences(references: CodeReference[], query: SymbolsQuery): CodeReference[] {
  return references.filter((reference) => inScope(reference.path, query.scopes)).slice(0, query.limit);
}

function inScope(file: string, scopes: string[]): boolean {
  return scopes.length === 0 || matchesAny(file, scopes);
}

function printSymbols(symbols: CodeSymbol[], sourceCount: number, query: SymbolsQuery): void {
  if (symbols.length === 0) {
    const filter = query.query ?? query.inPath ?? "<all>";
    console.log(`# No symbols match ${filter} across ${sourceCount} source files.`);
    return;
  }
  for (const symbol of symbols) {
    console.log(`${symbol.kind} ${symbol.name} ${symbol.path}:${symbol.range.start.line}`);
  }
}

function printReferences(references: CodeReference[], sourceCount: number, query: SymbolsQuery): void {
  if (references.length === 0) {
    const filter = query.query ?? query.inPath ?? "<all>";
    console.log(`# No references match ${filter} across ${sourceCount} source files.`);
    return;
  }
  for (const reference of references) {
    const source = reference.source ? ` source=${reference.source}` : "";
    console.log(`${reference.kind} ${reference.name} ${reference.path}:${reference.range.start.line}:${reference.range.start.column}${source}`);
  }
}

function printHelp(): void {
  console.log(`Usage:
  opencanon symbols <query>
  opencanon symbols --in src/file.ts
  opencanon symbols <query> --kind function --limit 20
  opencanon symbols <query> --kind function --scope "src/domain/**"
  opencanon symbols <query> --references

Options:
  --in <path>      Restrict results to a single file path.
  --scope <glob>   Restrict results to matching file globs. Repeatable.
  --kind <kind>    Filter by symbol or reference kind.
  --references     Search indexed references instead of symbols.
  --limit <n>      Maximum results to return (default 50, max 500).
  --format <fmt>   markdown or json. Default: markdown.
`);
}
