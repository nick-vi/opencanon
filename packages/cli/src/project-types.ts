import { cac } from "cac";
import { createPaths, fail, generateProjectTypes, resolveRootDir } from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions } from "./options.ts";

export async function runProjectTypesCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "generate", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    printProjectTypesHelp();
    return;
  }
  if (command !== "generate") fail(`Unknown project-types command: ${command}`);

  const cli = cac("opencanon project-types generate");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...rest], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printProjectTypesHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected project-types arguments: ${parsed.args.join(", ")}`);

  const rootDir = resolveRootDir(cwd);
  const result = generateProjectTypes(rootDir, createPaths(rootDir));
  if (formatOption(options.format) === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`# OpenCanon Project Types

Generated: ${result.path}
Packages: ${result.packageCount}
Import specifiers: ${result.importSpecifierCount}
npm dependencies: ${result.npmDependencyCount}
Crates: ${result.crateCount}
Cargo dependencies: ${result.cargoDependencyCount}
Python dependencies: ${result.pythonDependencyCount}`);
}

function printProjectTypesHelp(): void {
  console.log(`Usage:
  bun run opencanon project-types generate

Options:
  --format markdown|json  Output format. Default: markdown.
`);
}
