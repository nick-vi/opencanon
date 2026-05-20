import { createPaths, discoverProjectFiles, fail, resolveRootDir, type CodeSymbol } from "@opencanon/core";
import { openProjectStore } from "@opencanon/daemon";

type SymbolsQuery = {
  query?: string;
  inPath?: string;
  kind?: string;
  limit: number;
  help: boolean;
};

const oxcExtensions = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];

export async function runSymbolsCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const store = openProjectStore({ rootDir, paths });
  try {
    const discovery = discoverProjectFiles(paths);
    if (discovery.failed) fail(discovery.diagnostics.join("\n"));

    const sourceFiles = discovery.files.filter(isOxcSourceFile);
    const scan = store.scanAndDiff(discovery.files);
    const graphIsEmpty = store.project.searchSymbols({ limit: 1 }).symbols.length === 0;
    const changedSource = (graphIsEmpty ? sourceFiles : scan.changedFiles).filter(isOxcSourceFile);
    const deletedSource = scan.deletedFiles.filter(isOxcSourceFile);
    if (changedSource.length > 0 || deletedSource.length > 0) {
      const indexFiles = scan.files
        .filter((file) => changedSource.includes(file.path))
        .map((file) => ({ path: file.path, contentHash: file.contentHash, language: languageForFile(file.path) }));
      store.project.indexCodeGraph({
        files: indexFiles,
        deletedFiles: deletedSource,
        parserVersion: "",
        extractorVersion: "",
      });
    }

    const result = store.project.searchSymbols({
      query: query.query,
      path: query.inPath,
      kind: query.kind,
      limit: query.limit,
    });
    printSymbols(result.symbols, sourceFiles.length, query);
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): SymbolsQuery {
  let query: string | undefined;
  let inPath: string | undefined;
  let kind: string | undefined;
  let limit = 50;
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
  return { query, inPath, kind, limit, help };
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

function isOxcSourceFile(file: string): boolean {
  return oxcExtensions.some((extension) => file.endsWith(extension));
}

function languageForFile(file: string): "typescript" | "tsx" | "javascript" | "jsx" {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (file.endsWith(".mts") || file.endsWith(".cts") || file.endsWith(".ts")) return "typescript";
  return "javascript";
}

function printHelp(): void {
  console.log(`Usage:
  opencanon symbols <query>
  opencanon symbols --in src/file.ts
  opencanon symbols <query> --kind function --limit 20

Options:
  --in <path>      Restrict results to a single file path.
  --kind <kind>    Filter by symbol kind (function, class, variable, type, interface, enum).
  --limit <n>      Maximum results to return (default 50, max 500).
`);
}
