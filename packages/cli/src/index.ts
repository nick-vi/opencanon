#!/usr/bin/env node
import { rmSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { inspectProjectRuntime, inspectService, privateProjectRuntimeStatePath, projectRuntimeStatePath, ProjectRuntimeEnv, reconcileProjectRuntimes, runOpenCanonStatusCommand, runProjectCommand, runServiceCommand, runtimeNamespaceForRegistry, RuntimeStartupHealthBudgetMs, RuntimeStatus, serviceRegistryPath, stopProjectRuntime, waitForProjectRuntimeReady, withCliAstFactsProvider } from "@opencanon/runtime";
import { fail, formatOpenCanonProblem, Format, parseOpenCanonProblemFromError, resolveRootDir } from "@opencanon/core";
import { applyDoctorFixes, buildDoctorReport, DoctorStatus, renderDoctorFixMarkdown, renderDoctorMarkdown } from "@opencanon/core";
import type { DoctorRuntimeHealth, ProducerStatus } from "@opencanon/core";
import { fetchRunningRuntimeProducers, inspectRunningRuntimeKnowledge } from "./runtime-client.ts";
import { CliOptionDescription, CliOptionFlag, CliOptionName, booleanOption, fixModeOption, formatOption, rejectUnknownOptions } from "./options.ts";
import { runBenchmarkCommand } from "./benchmark.ts";
import { runBaselineCommand } from "./baseline.ts";
import { runCanonCommand } from "./canon.ts";
import { runChangesCommand } from "./changes.ts";
import { runFeedbackCommand, runHookCommand } from "./feedback.ts";
import { runGateCommand } from "./gate.ts";
import { runGraphCommand } from "./graph.ts";
import { runLanguagesCommand } from "./languages.ts";
import { runMcpCommand } from "./mcp.ts";
import { loadProjectContextUnchecked } from "./project.ts";
import { runBriefCommand } from "./brief.ts";
import { runAskCommand, runContextCommand } from "./context.ts";
import { runRefactorCommand } from "./refactor.ts";
import { runReviewCommand } from "./review.ts";
import { runRulesCommand } from "./rules.ts";
import { runSearchCommand } from "./search.ts";
import { runInitCommand } from "./init-flow.ts";
import { runSetupCommand } from "./setup.ts";
import { runSymbolsCommand } from "./symbols.ts";
import { runUpdateCommand } from "./update.ts";
import { runAnalyzeCommand } from "./analyze.ts";
import { runValidateCommand } from "./validate.ts";
import { runWorktreeCommand } from "./worktree.ts";
import { readCliPackageVersion } from "./package-version.ts";

export { OpenCanonPlugin } from "./opencode-plugin.ts";

export async function runOpenCanonCli(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  // Install the engine-backed AST facts provider for the whole CLI process so TS
  // facts come from the oxc AST on every in-process validation path (lazy per
  // rootDir; disposed on exit, with a process.exit backstop). Shared helper so
  // external @opencanon/core consumers satisfy the same provider-required contract.
  await withCliAstFactsProvider(() => dispatchOpenCanonCli(args, cwd));
}

async function dispatchOpenCanonCli(args: string[], cwd: string): Promise<void> {
  const [command, ...rest] = args;

  if (command === "--version" || command === "-v" || command === "version") {
    if (rest.length > 0) fail(`Unexpected version arguments: ${rest.join(", ")}`);
    console.log(readCliPackageVersion());
    return;
  }

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  if (command === "context") {
    await runContextCommand(rest, cwd);
    return;
  }

  if (command === "brief") {
    await runBriefCommand(rest, cwd);
    return;
  }

  if (command === "status") {
    await runOpenCanonStatusCommand(rest, cwd);
    return;
  }

  if (command === "ask") {
    await runAskCommand(rest, cwd);
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

  if (command === "languages") {
    await runLanguagesCommand(rest);
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

  if (command === "review") {
    await runReviewCommand(rest, cwd);
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

  if (command === "gate") {
    await runGateCommand(rest, cwd);
    return;
  }

  if (command === "hook") {
    await runHookCommand(rest, cwd);
    return;
  }

  if (command === "mcp") {
    await runMcpCommand(rest, cwd);
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand(rest, cwd);
    return;
  }

  if (command === "service") {
    await runServiceCommand(rest, cwd);
    return;
  }

  if (command === "project") {
    await runProjectCommand(rest, cwd);
    return;
  }

  if (command === "state") {
    await runStateCommand(rest, cwd);
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

  if (command === "canon") {
    await runCanonCommand(rest, cwd);
    return;
  }

  if (command === "changes") {
    await runChangesCommand(rest, cwd);
    return;
  }

  if (command === "worktree") {
    await runWorktreeCommand(rest, cwd);
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

  if (command === "analyze") {
    await runAnalyzeCommand(rest, cwd);
    return;
  }

  fail(`Unknown command: ${command}`);
}

async function runDoctorCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon doctor");
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option(CliOptionFlag.Format, CliOptionDescription.Format);
  cli.option("--fix [mode]", "Apply doctor init fixes.");
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
  const rootDir = resolveRootDir(cwd);
  const project = await loadProjectContextUnchecked(rootDir);
  const { paths, areas, specs, changes, conventions, validators } = project;

  // Authoritative producer status from a running runtime (it owns the live producer);
  // undefined when no runtime is running, in which case the headless sidecar resolve
  // is correct (no live producer exists).
  const runtimeHealth = await buildDoctorRuntimeHealth(rootDir);
  const [producerStatuses, knowledgeInspection] = await Promise.all([
    fetchRunningRuntimeProducers(rootDir),
    inspectRunningRuntimeKnowledge(rootDir),
  ]);
  let report = buildDoctorReport({ paths, areas, specs, changes, conventions, validators, runExternalTools: query.runExternalTools, producerStatuses, knowledgeInspection, runtimeHealth });
  const fixes = query.fixMode ? applyDoctorFixes({ paths, report, mode: query.fixMode, dryRun: query.dryRun, conventions, validators }) : undefined;
  if (fixes && !fixes.dryRun && fixes.diagnostics.length === 0 && fixes.appliedFixes > 0) {
    const nextProject = await loadProjectContextUnchecked(rootDir);
    report = buildDoctorReport({
      paths: nextProject.paths,
      areas: nextProject.areas,
      specs: nextProject.specs,
      changes: nextProject.changes,
      conventions: nextProject.conventions,
      validators: nextProject.validators,
      runExternalTools: query.runExternalTools,
      producerStatuses,
      knowledgeInspection,
      runtimeHealth,
    });
  }

  if (query.format === Format.Json) {
    console.log(JSON.stringify({ ...report, fixes }, null, 2));
  } else {
    console.log([renderDoctorMarkdown(report), fixes ? renderDoctorFixMarkdown(fixes) : ""].filter(Boolean).join("\n\n"));
  }

  process.exit(report.status === DoctorStatus.Fail ? 1 : 0);
}

async function buildDoctorRuntimeHealth(rootDir: string): Promise<DoctorRuntimeHealth> {
  await reconcileProjectRuntimes();
  await settleRuntimeForDoctor(rootDir);
  const [service, project] = await Promise.all([inspectService(), inspectProjectRuntime(rootDir)]);
  return {
    service: {
      status: service?.status ?? "not-running",
      registered: Boolean(service),
      ...(service?.message ? { message: service.message } : {}),
    },
    project: {
      status: project?.status ?? "not-running",
      registered: Boolean(project),
      ...(project?.message ? { message: project.message } : {}),
      ...(project?.entry.lifecycle.status ? { lifecycleStatus: project.entry.lifecycle.status } : {}),
    },
  };
}

async function settleRuntimeForDoctor(rootDir: string): Promise<void> {
  const inspection = await inspectProjectRuntime(rootDir);
  if (inspection?.status !== RuntimeStatus.Starting) return;
  try {
    await waitForProjectRuntimeReady(rootDir, { timeoutMs: RuntimeStartupHealthBudgetMs });
  } catch {
    // Doctor reports the final inspected runtime state below; it should not crash
    // before rendering the actionable runtime-health check.
  }
}

function printHelp(): void {
  console.log(`OpenCanon keeps Project Canon, runtime proof, and project knowledge in sync.

Usage:
  opencanon <command> [options]

Daily workflow:
  opencanon --version
  opencanon status
  opencanon status --format json
  opencanon setup --yes
  opencanon setup --yes --hooks codex
  opencanon context --files <paths...>
  opencanon brief --format json
  opencanon validate --changed
  opencanon validate --files <paths...>
  opencanon doctor
  opencanon review
  opencanon languages
  opencanon search <query>
  opencanon ask "where is auth enforced?"
  opencanon rules --validator <id>

Project Canon:
  opencanon canon list
  opencanon canon map
  opencanon canon draft convention <id> --title <title> --rule <rule>
  opencanon canon render conventions
  opencanon canon render areas
  opencanon canon render specs
  opencanon changes list
  opencanon worktree create <change-id> --task <task-id>
  opencanon worktree list

Project runtime:
  opencanon project status
  opencanon project status --format json
  opencanon project start
  opencanon project index
  opencanon project logs --tail 200
  opencanon project list
  opencanon service status

Agent and integration:
  opencanon feedback --files <paths...>
  opencanon gate approve <gate-id> --summary <summary>
  opencanon gate pending --format json
  opencanon hook <codex|claude|opencode>
  opencanon hook install --all
  opencanon mcp

Advanced and operations:
  opencanon project start --foreground
  opencanon update check
  opencanon baseline check
  opencanon symbols <query>
  opencanon graph callers <symbol>
  opencanon refactor rename-symbol <from> <to>
  opencanon state status
  opencanon benchmark --sizes 1000,10000 --file-kb 8 --source-snapshot-only

Command groups:
  status     Show global service and current project runtime status.
  context    Load the Project Canon and knowledge that apply to files, changes, or a topic.
  search     Search project symbols, canon definitions, validators, docs, and indexed knowledge.
  languages  Show explicit parser, facts, graph, and refactor support by language.
  review     Produce a read-only local/CI report for changed files.
  ask        Ask evidence-backed questions over the current project knowledge index.
  setup      Initialize this repo and emit an agent setup packet for Project Canon.
  init       Scaffold or repair the deterministic OpenCanon project files.
  canon      Browse, draft, render, and inspect durable Project Canon definitions.
  changes    List active Changes, run declared checks, and record runtime events.
  worktree   Create, list, remove, and reap managed worktrees for parallel agents.
  brief      Build an agent-ready briefing with ready work and scoped Project Canon.
  project    Start, inspect, reindex, open, or stop this project's runtime.
  service    Start, inspect, open, or stop the global OpenCanon control plane.

Run opencanon <command> --help for command-specific options.
`);
}

async function runStateCommand(args: string[], cwd: string): Promise<void> {
  const [command = "status", ...rest] = args;
  if (command === "reset") {
    const cli = cac("opencanon state reset");
    cli.option("--confirm", "Confirm generated state deletion.");
    cli.option("-h, --help", "Show help.");
    const parsed = cli.parse(["node", "opencanon", ...rest], { run: false });
    const options = parsed.options as Record<string, unknown>;
    if (booleanOption(options.help) || booleanOption(options.h)) {
      printStateHelp();
      return;
    }
    if (options.confirm !== true) fail("Refusing to reset generated state without --confirm.");
    const rootDir = resolveRootDir(cwd);
    const registryPath = serviceRegistryPath();
    const statePath = currentProjectStatePath(rootDir, registryPath);
    await stopProjectRuntime(rootDir, registryPath);
    rmSync(path.dirname(statePath), { recursive: true, force: true });
    console.log(`# OpenCanon State\n\nStatus: reset\nPath: ${statePath}`);
    return;
  }
  if (command === "status") {
    const rootDir = resolveRootDir(cwd);
    const registryPath = serviceRegistryPath();
    const namespace = runtimeNamespaceForRegistry(registryPath);
    console.log(`# OpenCanon State\n\nNamespace: ${namespace}\nPath: ${currentProjectStatePath(rootDir, registryPath)}`);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printStateHelp();
    return;
  }
  fail(`Unknown state command: ${command}`);
}

function currentProjectStatePath(rootDir: string, registryPath: string): string {
  const configuredPath = process.env[ProjectRuntimeEnv.StatePath]?.trim();
  if (configuredPath) return path.resolve(configuredPath);
  return privateProjectRuntimeStatePath({
    rootDir,
    registryPath,
    stateRoot: process.env[ProjectRuntimeEnv.StateRoot],
    ownerRegistryPath: process.env[ProjectRuntimeEnv.StateOwnerRegistryPath],
  }) ?? projectRuntimeStatePath(rootDir, runtimeNamespaceForRegistry(registryPath));
}

function printStateHelp(): void {
  console.log(`Usage:
  opencanon state status
  opencanon state reset --confirm

Commands:
  status  Show the generated project state path.
  reset   Delete generated SQLite state for this project.
`);
}

function printDoctorHelp(): void {
  console.log(`Usage:
  opencanon doctor
  opencanon doctor --fix --dry-run

Options:
  --format markdown|json     Output format. Default: markdown.
  --fix [safe|suggested|all] Apply init fixes. Default with --fix: safe.
  --dry-run                  Show selected fixes without writing files.
  --run-external-tools       Execute configured external tool checks.
`);
}

if (import.meta.main) {
  try {
    await runOpenCanonCli();
  } catch (error) {
    const problem = parseOpenCanonProblemFromError(error);
    console.error(problem ? formatOpenCanonProblem(problem) : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
