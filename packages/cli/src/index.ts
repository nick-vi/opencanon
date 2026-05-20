#!/usr/bin/env bun
import { rmSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { runDaemonCommand, runDevCommand } from "@opencanon/daemon";
import { fail, loadImpactSurfaces, resolveRootDir, validateContext } from "@opencanon/core";
import { applyDoctorFixes, buildDoctorReport, renderDoctorFixMarkdown, renderDoctorMarkdown } from "@opencanon/core";
import { CliOptionDescription, CliOptionFlag, CliOptionName, booleanOption, fixModeOption, formatOption, rejectUnknownOptions } from "./options.ts";
import { runBenchmarkCommand } from "./benchmark.ts";
import { runBaselineCommand } from "./baseline.ts";
import { runBundleCommand } from "./bundle.ts";
import { runFeedbackCommand, runHookCommand } from "./feedback.ts";
import { runGraphCommand } from "./graph.ts";
import { runInitCommand } from "./init.ts";
import { loadProjectContext } from "./project.ts";
import { runContextCommand } from "./context.ts";
import { runRefactorCommand } from "./refactor.ts";
import { runRulesCommand } from "./rules.ts";
import { runSearchCommand } from "./search.ts";
import { runSetupCommand } from "./setup.ts";
import { runSymbolsCommand } from "./symbols.ts";
import { runUpdateCommand } from "./update.ts";
import { runValidateCommand } from "./validate.ts";

export { OpenCanonPlugin } from "./opencode-plugin.ts";

export async function runOpenCanonCli(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command, ...rest] = args;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  if (command === "context") {
    await runContextCommand(rest, cwd);
    return;
  }

  if (command === "init") {
    await runInitCommand(rest, cwd);
    return;
  }

  if (command === "setup") {
    await runSetupCommand(rest, cwd);
    return;
  }

  if (command === "validate") {
    await runValidateCommand(rest, cwd);
    return;
  }

  if (command === "update") {
    await runUpdateCommand(rest, cwd);
    return;
  }

  if (command === "rules") {
    await runRulesCommand(rest, cwd);
    return;
  }

  if (command === "search") {
    await runSearchCommand(rest, cwd);
    return;
  }

  if (command === "feedback") {
    await runFeedbackCommand(rest, cwd);
    return;
  }

  if (command === "hook") {
    await runHookCommand(rest, cwd);
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand(rest, cwd);
    return;
  }

  if (command === "daemon") {
    await runDaemonCommand(rest, cwd);
    return;
  }

  if (command === "db") {
    runDbCommand(rest, cwd);
    return;
  }

  if (command === "dev") {
    await runDevCommand(rest, cwd);
    return;
  }

  if (command === "benchmark") {
    await runBenchmarkCommand(rest);
    return;
  }

  if (command === "baseline") {
    await runBaselineCommand(rest, cwd);
    return;
  }

  if (command === "bundle") {
    await runBundleCommand(rest, cwd);
    return;
  }

  if (command === "symbols") {
    await runSymbolsCommand(rest, cwd);
    return;
  }

  if (command === "graph") {
    await runGraphCommand(rest, cwd);
    return;
  }

  if (command === "refactor") {
    await runRefactorCommand(rest, cwd);
    return;
  }

  fail(`Unknown command: ${command}`);
}

async function runDoctorCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon doctor");
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option(CliOptionFlag.Format, CliOptionDescription.Format);
  cli.option("--fix [mode]", "Apply doctor setup fixes.");
  cli.option(CliOptionFlag.DryRun, CliOptionDescription.DryRun);
  cli.option("--run-external-tools", "Execute configured external tool checks.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [CliOptionName.Help, CliOptionName.H, CliOptionName.Format, CliOptionName.Fix, CliOptionName.DryRun, "runExternalTools"]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printDoctorHelp();
    return;
  }

  if (parsed.args.length > 0) fail(`Unexpected doctor arguments: ${parsed.args.join(", ")}`);

  const query = {
    format: formatOption(options.format),
    fixMode: fixModeOption(options.fix),
    dryRun: booleanOption(options.dryRun),
    runExternalTools: booleanOption(options.runExternalTools),
  };
  const { paths, decisions, validators } = await loadProjectContext(cwd);
  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const diagnostics = [...impactDiagnostics, ...validateContext({ decisions, validators, impactSurfaces, paths })];
  if (diagnostics.length > 0) {
    console.error("OpenCanon files are invalid. Run bun run opencanon context --check for details.");
    process.exit(1);
  }

  let report = buildDoctorReport({ paths, decisions, validators, runExternalTools: query.runExternalTools });
  const fixes = query.fixMode ? applyDoctorFixes({ paths, report, mode: query.fixMode, dryRun: query.dryRun }) : undefined;
  if (fixes && !fixes.dryRun && fixes.diagnostics.length === 0 && fixes.appliedFixes > 0) {
    report = buildDoctorReport({ paths, decisions, validators, runExternalTools: query.runExternalTools });
  }

  if (query.format === "json") {
    console.log(JSON.stringify({ ...report, fixes }, null, 2));
  } else {
    console.log([renderDoctorMarkdown(report), fixes ? renderDoctorFixMarkdown(fixes) : ""].filter(Boolean).join("\n\n"));
  }

  process.exit(report.status === "fail" ? 1 : 0);
}

function printHelp(): void {
  console.log(`Usage:
  opencanon context --files <paths...>
  opencanon setup --yes
  opencanon init --agent
  opencanon rules --validator <id>
  opencanon search <query>
  opencanon validate --files <paths...>
  opencanon update check --manifest <path-or-url>
  opencanon feedback --files <paths...>
  opencanon hook <codex|claude|opencode>
  opencanon hook install --all
  opencanon doctor
  opencanon daemon start
  opencanon dev
  opencanon baseline check
  opencanon bundle install <bundle.ts|bundle.json> --option key=value
  opencanon symbols <query>
  opencanon refactor rename-symbol <from> <to>

Commands:
  context    Load scoped docs, decisions, validators, and git evidence.
  setup      First-run scaffold, hook install, validation, doctor, and daemon start.
  init       Scaffold OpenCanon skill files, validators, optional config, and agent setup brief.
  rules      List validator summaries, scopes, decisions, and fixture coverage.
  search     Search symbols, decisions, validators, and docs deterministically.
  validate   Run validators against files, changed files, fixtures, or the project.
  update     Check or install verified engine runtime assets from a release manifest.
  feedback   Run validators and render concise agent feedback.
  hook       Adapt host hook payloads to OpenCanon feedback.
  doctor     Check core setup, validator coverage, dependencies, and hooks.
  daemon     Start or inspect the daemon runtime.
  dev        Start the daemon and serve the built UI.
  baseline   Show or update the known findings baseline.
  bundle     Inspect, plan, install, or update canon bundles.
  symbols    Search the deterministic TS/JS code symbol graph.
  graph      Inspect deterministic callers, callees, and impact edges.
  refactor   Plan or apply deterministic symbol/import/file refactors.

Maintenance:
  db         Inspect or reset generated daemon state.
  benchmark  Generate synthetic repos and profile discovery/parsing tiers.
`);
}

function runDbCommand(args: string[], cwd: string): void {
  const [command = "status", ...rest] = args;
  if (command === "reset") {
    const cli = cac("opencanon db reset");
    cli.option("--confirm", "Confirm generated state deletion.");
    cli.option("-h, --help", "Show help.");
    const parsed = cli.parse(["node", "opencanon", ...rest], { run: false });
    const options = parsed.options as Record<string, unknown>;
    if (options.help || options.h) {
      printDbHelp();
      return;
    }
    if (options.confirm !== true) fail("Refusing to reset generated state without --confirm.");
    const rootDir = resolveRootDir(cwd);
    const statePath = path.join(rootDir, ".opencanon", "state.sqlite");
    for (const file of [statePath, `${statePath}-wal`, `${statePath}-shm`]) rmSync(file, { force: true });
    console.log(`# OpenCanon DB\n\nStatus: reset\nPath: ${statePath}`);
    return;
  }
  if (command === "status") {
    const rootDir = resolveRootDir(cwd);
    console.log(`# OpenCanon DB\n\nPath: ${path.join(rootDir, ".opencanon", "state.sqlite")}`);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printDbHelp();
    return;
  }
  fail(`Unknown db command: ${command}`);
}

function printDbHelp(): void {
  console.log(`Usage:
  bun run opencanon db status
  bun run opencanon db reset --confirm

Commands:
  status  Show the generated project state path.
  reset   Delete generated SQLite state for this project.
`);
}

function printDoctorHelp(): void {
  console.log(`Usage:
  bun run opencanon doctor
  bun run opencanon doctor --fix --dry-run

Options:
  --format markdown|json     Output format. Default: markdown.
  --fix [safe|suggested|all] Apply setup fixes. Default with --fix: safe.
  --dry-run                  Show selected fixes without writing files.
  --run-external-tools       Execute configured external tool checks.
`);
}

if (import.meta.main) await runOpenCanonCli();
