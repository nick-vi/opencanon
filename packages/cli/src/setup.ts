import { existsSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { createPaths, discoverProjectFiles, fail, Format, HookInstallHost, relative, resolveRootDir, splitList } from "@opencanon/core";
import { CliOptionDescription, CliOptionFlag, CliOptionName, booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";
import { runInitFlow, type InitFlowQuery, type InitFlowResult } from "./init-flow.ts";

type SetupResult = {
  rootDir: string;
  status: "fail" | "pass" | "warn";
  dryRun: boolean;
  init: InitFlowResult;
  packet?: SetupPacket;
};

type SetupPacket = {
  schema: "opencanon.setup-packet.v1";
  rootDir: string;
  generatedAt: string;
  purpose: string;
  discovery: {
    source: string;
    fileCount: number;
    sampleFiles: string[];
    languageCounts: Record<string, number>;
    packageManagers: string[];
    diagnostics: string[];
  };
  existingCanon: {
    areas: number;
    specs: number;
    changes: number;
    conventions: number;
    validators: number;
    impactSurfaces: number;
  };
  agentWorkflow: string[];
  proposalRequirements: string[];
  suggestedCommands: string[];
};

const SetupStatus = {
  Fail: "fail",
} as const;

export async function runSetupCommand(args: string[], cwd: string): Promise<void> {
  const query = parseSetupArgs(args, cwd);
  if (!query) return;

  const init = await runInitFlow(cwd, query);
  const result: SetupResult = {
    rootDir: init.rootDir,
    status: init.status,
    dryRun: init.dryRun,
    init,
    packet: init.status === SetupStatus.Fail || init.dryRun ? undefined : await buildSetupPacket(init.rootDir),
  };

  if (query.format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderSetupMarkdown(result));
  process.exit(result.status === SetupStatus.Fail ? 1 : 0);
}

function parseSetupArgs(args: string[], cwd: string): InitFlowQuery | null {
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const cli = cac("opencanon setup");
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option("--yes", "Use defaults without prompting.");
  cli.option("--non-interactive", "Alias for --yes.");
  cli.option(CliOptionFlag.DryRun, "Show setup actions without writing files.");
  cli.option(CliOptionFlag.Format, CliOptionDescription.Format);
  cli.option("--hooks <hosts>", "Install feedback hooks: codex, claude, opencode, all, or none.");
  cli.option("--no-runtime", "Do not start the project runtime.");
  cli.option("--docs-dir <path>", "Project Canon docs directory.");
  cli.option("--conventions-path <path>", "Convention entrypoint path.");
  cli.option("--areas-path <path>", "Area entrypoint path.");
  cli.option("--specs-path <path>", "Spec entrypoint path.");
  cli.option("--changes-path <path>", "Change entrypoint path.");
  cli.option("--fixtures-dir <path>", "Validator fixtures directory.");
  cli.option("--cache-dir <path>", "Generated cache directory.");
  cli.option("--file-discovery <mode>", "Project discovery mode: git or filesystem.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    CliOptionName.Help,
    CliOptionName.H,
    CliOptionName.Yes,
    "nonInteractive",
    CliOptionName.DryRun,
    CliOptionName.Format,
    CliOptionName.Hooks,
    "runtime",
    "docsDir",
    "conventionsPath",
    "areasPath",
    "specsPath",
    "changesPath",
    "fixturesDir",
    "cacheDir",
    "fileDiscovery",
  ]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSetupHelp();
    return null;
  }
  if (parsed.args.length > 0) fail(`Unexpected setup arguments: ${parsed.args.join(", ")}`);
  if (!booleanOption(options.dryRun) && !booleanOption(options.yes) && !booleanOption(options.nonInteractive)) {
    fail("opencanon setup requires explicit consent. Use --yes or --dry-run.");
  }

  return {
    dryRun: booleanOption(options.dryRun),
    format: formatOption(options.format),
    hooks: hooksOption(options.hooks),
    startRuntime: options.runtime !== false,
    init: {
      docsDir: stringOption(options.docsDir, relative(rootDir, paths.docsDir)),
      conventionsPath: stringOption(options.conventionsPath, relative(rootDir, paths.conventionsPath)),
      areasPath: stringOption(options.areasPath, relative(rootDir, paths.areasPath)),
      specsPath: stringOption(options.specsPath, relative(rootDir, paths.specsPath)),
      changesPath: stringOption(options.changesPath, relative(rootDir, paths.changesPath)),
      fixturesDir: stringOption(options.fixturesDir, relative(rootDir, paths.fixturesDir)),
      cacheDir: stringOption(options.cacheDir, relative(rootDir, paths.cacheDir)),
      fileDiscovery: fileDiscoveryOption(options.fileDiscovery, paths.fileDiscovery),
    },
  };
}

async function buildSetupPacket(rootDir: string): Promise<SetupPacket> {
  const paths = createPaths(rootDir);
  const project = await loadProjectContext(rootDir);
  const discovery = discoverProjectFiles(paths);
  return {
    schema: "opencanon.setup-packet.v1",
    rootDir,
    generatedAt: new Date().toISOString(),
    purpose: "Guide an agent through establishing this repository's Project Canon with user review.",
    discovery: {
      source: discovery.source,
      fileCount: discovery.files.length,
      sampleFiles: discovery.files.slice(0, 25),
      languageCounts: languageCounts(discovery.files),
      packageManagers: packageManagers(rootDir),
      diagnostics: discovery.diagnostics,
    },
    existingCanon: {
      areas: project.areas.length,
      specs: project.specs.length,
      changes: project.changes.length,
      conventions: project.conventions.length,
      validators: project.validators.length,
      impactSurfaces: project.impactSurfaces.length,
    },
    agentWorkflow: [
      "Inspect the setup packet and existing Project Canon before proposing durable definitions.",
      "Explore repository structure, tests, docs, package scripts, entrypoints, and risky surfaces using OpenCanon Search and scoped context.",
      "Draft Areas, Specs, Conventions, Impact Surfaces, Checks, and active Changes as a proposal with evidence and open questions.",
      "Ask the user to accept or revise the proposal before writing TypeScript definitions under opencanon/.",
      "After accepted definitions are written, render Project Canon docs, run validate, and run doctor.",
    ],
    proposalRequirements: [
      "Areas identify ownership and implementation boundaries.",
      "Specs describe durable product or system behavior, not temporary implementation tasks.",
      "Conventions describe rules that should outlive the current setup session and can later gain runtime Proof.",
      "Impact Surfaces identify files or resources where downstream effects need explicit attention.",
      "Checks name the commands, tests, validators, or Doctor coverage that prove the canon stays current.",
      "Changes describe active work only; progress belongs in runtime Activity, not mutable definition status.",
    ],
    suggestedCommands: [
      "opencanon brief --format json",
      "opencanon canon map --format json",
      "opencanon search \"architecture entrypoints\"",
      "opencanon context --files <paths...>",
      "opencanon validate --changed",
      "opencanon doctor",
    ],
  };
}

function renderSetupMarkdown(result: SetupResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Setup");
  lines.push("");
  lines.push(`Root: ${result.rootDir}${result.dryRun ? " (dry-run)" : ""}`);
  lines.push(`Status: ${result.status}`);
  lines.push("");
  lines.push("Init:");
  for (const step of result.init.steps) lines.push(`- [${step.status}] ${step.id}: ${step.message}`);
  if (!result.packet) {
    lines.push("");
    lines.push("Next:");
    lines.push(result.status === SetupStatus.Fail ? "- Fix failed setup steps, then rerun `opencanon setup --yes`." : "- Rerun without `--dry-run` to produce the agent setup packet.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Discovery:");
  lines.push(`- Source: ${result.packet.discovery.source}`);
  lines.push(`- Files: ${result.packet.discovery.fileCount}`);
  lines.push(`- Languages: ${formatRecord(result.packet.discovery.languageCounts) || "none"}`);
  lines.push(`- Package managers: ${result.packet.discovery.packageManagers.join(", ") || "none"}`);
  for (const diagnostic of result.packet.discovery.diagnostics) lines.push(`- Diagnostic: ${diagnostic}`);

  lines.push("");
  lines.push("Existing Project Canon:");
  lines.push(`- Areas: ${result.packet.existingCanon.areas}`);
  lines.push(`- Specs: ${result.packet.existingCanon.specs}`);
  lines.push(`- Changes: ${result.packet.existingCanon.changes}`);
  lines.push(`- Conventions: ${result.packet.existingCanon.conventions}`);
  lines.push(`- Validators: ${result.packet.existingCanon.validators}`);
  lines.push(`- Impact Surfaces: ${result.packet.existingCanon.impactSurfaces}`);

  lines.push("");
  lines.push("Agent Workflow:");
  for (const item of result.packet.agentWorkflow) lines.push(`- ${item}`);

  lines.push("");
  lines.push("Suggested Commands:");
  for (const command of result.packet.suggestedCommands) lines.push(`- \`${command}\``);

  return lines.join("\n");
}

function languageCounts(files: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = languageKey(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function languageKey(file: string): string {
  const basename = path.basename(file);
  if (basename === "package.json") return "package-json";
  const extension = path.extname(file).slice(1);
  return extension || "other";
}

function packageManagers(rootDir: string): string[] {
  const managers: string[] = [];
  if (existsSync(path.join(rootDir, "package-lock.json"))) managers.push("npm");
  if (existsSync(path.join(rootDir, "pnpm-lock.yaml"))) managers.push("pnpm");
  if (existsSync(path.join(rootDir, "yarn.lock"))) managers.push("yarn");
  if (existsSync(path.join(rootDir, "bun.lock")) || existsSync(path.join(rootDir, "bun.lockb"))) managers.push("bun");
  if (existsSync(path.join(rootDir, "Cargo.toml"))) managers.push("cargo");
  if (existsSync(path.join(rootDir, "pyproject.toml"))) managers.push("python");
  return managers;
}

function formatRecord(record: Record<string, number>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
}

function hooksOption(value: unknown): HookInstallHost[] {
  const values = stringValues(value).flatMap(splitList);
  if (values.length === 0 || values.includes("none")) return [];
  if (values.includes("all")) return [HookInstallHost.Codex, HookInstallHost.Claude, HookInstallHost.OpenCode];
  return values.map((item) => {
    if (item === HookInstallHost.Codex || item === HookInstallHost.Claude || item === HookInstallHost.OpenCode) return item;
    fail(`Unsupported --hooks value: ${item}`);
  });
}

function fileDiscoveryOption(value: unknown, fallback: InitFlowQuery["init"]["fileDiscovery"]): InitFlowQuery["init"]["fileDiscovery"] {
  if (value === undefined) return fallback;
  if (value === "git" || value === "filesystem") return value;
  fail(`Unsupported --file-discovery: ${String(value)}`);
}

function stringOption(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length > 0) return value;
  fail("Option requires a string value.");
}

function printSetupHelp(): void {
  console.log(`Usage:
  opencanon setup --yes
  opencanon setup --yes --hooks codex
  opencanon setup --yes --no-runtime
  opencanon setup --dry-run

Options:
  --yes                    Use defaults without prompting.
  --non-interactive        Alias for --yes.
  --dry-run                Show setup actions without writing files.
  --format markdown|json   Output format. Default: markdown.
  --hooks <hosts>          codex, claude, opencode, all, or none. Default: none.
  --no-runtime             Do not start the project runtime.
  --docs-dir <path>        Default: docs/opencanon.
  --conventions-path <path>
  --areas-path <path>
  --specs-path <path>
  --changes-path <path>
  --fixtures-dir <path>    Default: opencanon/fixtures.
  --cache-dir <path>       Default: .opencanon/cache.
  --file-discovery <mode>  git or filesystem.

Setup runs deterministic init first, then emits an agent setup packet for establishing Project Canon with user review.
`);
}
