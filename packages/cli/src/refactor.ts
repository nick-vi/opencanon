import { cac } from "cac";
import {
  applyRefactorPlan,
  createPaths,
  discoverProjectFiles,
  fail,
  moveDir,
  moveFile,
  renamePackage,
  renameSymbol,
  resolveRootDir,
  splitModule,
  updateImports,
  type Format,
  type RefactorPlan,
} from "@opencanon/core";
import { openProjectStore } from "@opencanon/daemon";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";

type RefactorQuery = {
  command: string;
  args: string[];
  apply: boolean;
  format: Format;
  files: string[];
  includes: string[];
  graphOnly: boolean;
  help: boolean;
};

export async function runRefactorCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const common = { rootDir, files: query.files, include: query.includes };
  const plan = createPlan(query, common);
  const result = applyRefactorPlan({ rootDir, plan, dryRun: !query.apply });

  if (query.format === "json") {
    console.log(JSON.stringify({ plan, result }, null, 2));
    return;
  }

  console.log(renderRefactorMarkdown(plan, result, query.apply));
  if (plan.diagnostics.length > 0 || result.diagnostics.length > 0) process.exit(1);
}

function parseArgs(args: string[]): RefactorQuery {
  const [command = "", ...rest] = args;
  const cli = cac("opencanon refactor");
  cli.option("-h, --help", "Show help.");
  cli.option("--apply", "Apply the planned edits and file moves.");
  cli.option("--format <format>", "Output format.");
  cli.option("--file <path>", "Restrict planning to a file. Repeatable.");
  cli.option("--include <path>", "Restrict file discovery to a directory. Repeatable.");
  cli.option("--graph-only", "Use graph references only for symbol rename.");
  const parsed = cli.parse(["node", "opencanon", ...rest], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "apply", "format", "file", "include", "graphOnly"]);
  return {
    command,
    args: parsed.args.map(String),
    apply: booleanOption(options.apply),
    format: formatOption(options.format),
    files: stringValues(options.file),
    includes: stringValues(options.include),
    graphOnly: booleanOption(options.graphOnly),
    help: booleanOption(options.help) || booleanOption(options.h) || command === "" || command === "help",
  };
}

function createPlan(query: RefactorQuery, common: { rootDir: string; files: string[]; include: string[] }): RefactorPlan {
  if (query.command === "rename-symbol") {
    assertArgCount(query, 2);
    return renameSymbol({ ...common, from: query.args[0], to: query.args[1], ...graphRenameInputs(common.rootDir, query.args[0]), graphOnly: query.graphOnly });
  }
  if (query.command === "update-imports") {
    assertArgCount(query, 2);
    return updateImports({ ...common, from: query.args[0], to: query.args[1] });
  }
  if (query.command === "move-file") {
    assertArgCount(query, 2);
    return moveFile({ ...common, from: query.args[0], to: query.args[1] });
  }
  if (query.command === "move-dir") {
    assertArgCount(query, 2);
    return moveDir({ ...common, from: query.args[0], to: query.args[1] });
  }
  if (query.command === "rename-package") {
    assertArgCount(query, 2);
    return renamePackage({ ...common, from: query.args[0], to: query.args[1] });
  }
  if (query.command === "split-module") {
    if (query.args.length < 2) fail("split-module requires <from> <target...>.");
    return splitModule({
      ...common,
      from: query.args[0],
      targets: query.args.slice(1).map((to) => ({ from: query.args[0], to })),
    });
  }
  fail(`Unknown refactor command: ${query.command}`);
}

function graphRenameInputs(rootDir: string, name: string): Pick<Parameters<typeof renameSymbol>[0], "symbols" | "references"> {
  const paths = createPaths(rootDir);
  const discovery = discoverProjectFiles(paths);
  if (discovery.failed) return {};
  const store = openProjectStore({ rootDir, paths });
  try {
    const sourceFiles = discovery.files.filter(isOxcSourceFile);
    const scan = store.scanAndDiff(discovery.files);
    const graphIsEmpty = store.project.searchSymbols({ limit: 1 }).symbols.length === 0;
    const changedSource = (graphIsEmpty ? sourceFiles : scan.changedFiles).filter(isOxcSourceFile);
    const deletedSource = scan.deletedFiles.filter(isOxcSourceFile);
    if (changedSource.length > 0 || deletedSource.length > 0) {
      store.project.indexCodeGraph({
        files: scan.files
          .filter((file) => changedSource.includes(file.path))
          .map((file) => ({ path: file.path, contentHash: file.contentHash, language: languageForFile(file.path) })),
        deletedFiles: deletedSource,
      });
    }
    return {
      symbols: store.project.searchSymbols({ query: name, limit: 500 }).symbols,
      references: store.project.searchReferences({ query: name, limit: 1000 }).references,
    };
  } finally {
    store.close();
  }
}

const oxcExtensions = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];

function isOxcSourceFile(file: string): boolean {
  return oxcExtensions.some((extension) => file.endsWith(extension));
}

function languageForFile(file: string): "typescript" | "tsx" | "javascript" | "jsx" {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (file.endsWith(".mts") || file.endsWith(".cts") || file.endsWith(".ts")) return "typescript";
  return "javascript";
}

function assertArgCount(query: RefactorQuery, count: number): void {
  if (query.args.length !== count) fail(`${query.command} requires ${count} arguments.`);
}

function renderRefactorMarkdown(plan: RefactorPlan, result: ReturnType<typeof applyRefactorPlan>, applied: boolean): string {
  const lines = ["# OpenCanon Refactor", "", `Kind: ${plan.kind}`, `Mode: ${applied ? "apply" : "plan"}`, `Summary: ${plan.summary}`, ""];
  lines.push(`Edits: ${plan.edits.length}`);
  lines.push(`File moves: ${plan.fileMoves.length}`);
  if (result.files.length > 0) lines.push(`Files: ${result.files.join(", ")}`);
  if (plan.diagnostics.length > 0 || result.diagnostics.length > 0) {
    lines.push("", "## Diagnostics");
    for (const diagnostic of [...plan.diagnostics, ...result.diagnostics]) lines.push(`- ${diagnostic}`);
  }
  if (plan.edits.length > 0) {
    lines.push("", "## Planned Edits");
    for (const edit of plan.edits.slice(0, 50)) lines.push(`- ${edit.file}:${edit.range.startLine}:${edit.range.startColumn} -> ${JSON.stringify(edit.replacement)}`);
    if (plan.edits.length > 50) lines.push(`- ... ${plan.edits.length - 50} more`);
  }
  if (plan.fileMoves.length > 0) {
    lines.push("", "## Planned Moves");
    for (const move of plan.fileMoves) lines.push(`- ${move.from} -> ${move.to}`);
  }
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`Usage:
  opencanon refactor rename-symbol <from> <to> [--file path] [--apply]
  opencanon refactor update-imports <from> <to> [--apply]
  opencanon refactor move-file <from> <to> [--apply]
  opencanon refactor move-dir <from> <to> [--apply]
  opencanon refactor rename-package <from> <to> [--apply]
  opencanon refactor split-module <from> <target...>

Options:
  --file <path>       Restrict planning to a file. Repeatable.
  --include <path>    Restrict discovery to a directory. Repeatable.
  --graph-only        Use graph references only for symbol rename.
  --apply             Apply the planned edits and file moves.
  --format json       Output JSON.
`);
}
