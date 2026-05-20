import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { applyRuntimeUpdate, assertDaemonPrerequisites, startSupervisedDaemon } from "@opencanon/daemon";
import {
  buildDoctorReport,
  createDefaultConfig,
  createPaths,
  DoctorStatus,
  fail,
  HookInstallHost,
  HookInstallScope,
  installHook,
  loadImpactSurfaces,
  relative,
  resolveRootDir,
  runValidation,
  splitList,
  validateConfig,
  validateContext,
  writeAtomicJsonFileSync,
  writeAtomicTextFileSync,
  type DoctorReport,
  type Format,
  type HookInstallResult,
  type ValidationResult,
} from "@opencanon/core";
import { CliOptionDescription, CliOptionFlag, CliOptionName, booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { runInit, type InitQuery, type InitResult } from "./init.ts";
import { loadProjectContext } from "./project.ts";

const SetupStatus = {
  Fail: "fail",
  Pass: "pass",
  Skip: "skip",
  Warn: "warn",
} as const;
type SetupStatus = (typeof SetupStatus)[keyof typeof SetupStatus];

const SetupStepId = {
  CacheIgnore: "cache-ignore",
  Context: "context",
  Daemon: "daemon",
  Doctor: "doctor",
  FeedbackHooks: "feedback-hooks",
  ProjectValidation: "project-validation",
  RuntimeUpdate: "runtime-update",
  Scaffold: "scaffold",
  SetupStateIgnore: "setup-state-ignore",
  SetupState: "setup-state",
  Validation: "validation",
} as const;
type SetupStepId = (typeof SetupStepId)[keyof typeof SetupStepId];

const SetupOptionName = {
  Daemon: SetupStepId.Daemon,
} as const;

const SetupStateFile = ".opencanon/setup.json";
const generatedStateIgnoreEntries = [
  ".opencanon/daemon.json",
  ".opencanon/daemon.log",
  ".opencanon/*.sqlite",
  ".opencanon/*.sqlite-shm",
  ".opencanon/*.sqlite-wal",
  ".agents/skills/opencanon/runtime/",
];

type SetupQuery = {
  dryRun: boolean;
  format: Format;
  hooks: HookInstallHost[];
  runtimeManifestSource?: string;
  startDaemon: boolean;
};

type SetupStep = {
  id: SetupStepId;
  status: SetupStatus;
  message: string;
  details?: string[];
};

type SetupInitSummary = {
  files: InitResult["files"];
  diagnostics: string[];
  nextSteps: string[];
  agentBriefPath?: string;
};

type SetupResult = {
  rootDir: string;
  status: Exclude<SetupStatus, "skip">;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  statePath?: string;
  scaffoldMissing: string[];
  steps: SetupStep[];
  init?: SetupInitSummary;
  hooks: HookInstallResult[];
  doctor?: DoctorReport;
  validation?: ValidationResult;
  daemonStart?: {
    status: string;
    url?: string;
    pid?: number;
  };
};

export async function runSetupCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseSetupArgs(args);
  if (!query) return;
  const result = await runSetup(cwd, query);
  if (query.format === "json") console.log(JSON.stringify(result, null, 2));
  else console.log(renderSetupMarkdown(result));
  process.exit(result.status === SetupStatus.Fail ? 1 : 0);
}

async function runSetup(cwd: string, query: SetupQuery): Promise<SetupResult> {
  const rootDir = resolveRootDir(cwd);
  const startedAt = new Date().toISOString();
  const steps: SetupStep[] = [];
  const hooks: HookInstallResult[] = [];
  const scaffoldMissing = missingScaffoldFiles(rootDir);
  let init: SetupInitSummary | undefined;
  let doctor: DoctorReport | undefined;
  let validation: ValidationResult | undefined;
  let daemonStart: SetupResult["daemonStart"];

  if (scaffoldMissing.length > 0) {
    const initResult = runInit(rootDir, createSetupInitQuery(rootDir, query));
    init = {
      files: initResult.files,
      diagnostics: initResult.diagnostics,
      nextSteps: initResult.nextSteps,
      agentBriefPath: initResult.agentBrief ? "tmp/opencanon-init-plan.md" : undefined,
    };
    steps.push({
      id: SetupStepId.Scaffold,
      status: initResult.diagnostics.length === 0 ? SetupStatus.Pass : SetupStatus.Fail,
      message: query.dryRun ? "Scaffold plan generated." : "Scaffold is present.",
      details: [
        ...scaffoldMissing.map((file) => `missing before setup: ${file}`),
        ...initResult.files.map((file) => `${file.action}: ${file.path}`),
        ...initResult.diagnostics,
      ],
    });
  } else {
    steps.push({
      id: SetupStepId.Scaffold,
      status: SetupStatus.Skip,
      message: "Scaffold is already present.",
    });
  }

  hooks.push(...installRequestedHooks(rootDir, query));
  if (query.hooks.length > 0) {
    steps.push({
      id: SetupStepId.FeedbackHooks,
      status: hooks.some((hook) => hook.diagnostics.length > 0) ? SetupStatus.Fail : SetupStatus.Pass,
      message: query.dryRun ? "Feedback hook plan generated." : "Requested feedback hooks are installed.",
      details: hooks.flatMap((hook) => [
        `${hook.host}: ${hook.scope}${hook.dryRun ? " dry-run" : ""}`,
        ...hook.files.map((file) => `${file.action}: ${file.path}`),
        ...hook.diagnostics,
      ]),
    });
  }

  steps.push(ensureCacheIgnored(rootDir, query.dryRun));
  steps.push(ensureSetupStateIgnored(rootDir, query.dryRun));

  if (query.runtimeManifestSource) {
    steps.push(await installSetupRuntime(rootDir, query));
  }

  if (query.dryRun && scaffoldMissing.length > 0) {
    steps.push({
      id: SetupStepId.Validation,
      status: SetupStatus.Skip,
      message: "Validation needs the scaffold to be written.",
    });
  } else {
    const loaded = await loadSetupContext(rootDir);
    steps.push(loaded.step);

    if (loaded.context) {
      doctor = buildDoctorReport(loaded.context);
      steps.push({
        id: SetupStepId.Doctor,
        status: setupStatusFromDoctor(doctor.status),
        message: `Doctor status: ${doctor.status}.`,
        details: doctor.checks.map((check) => `${check.status}: ${check.id}: ${check.message}`),
      });

      try {
        validation = await runValidation({
          rootDir,
          paths: loaded.context.paths,
          decisions: loaded.context.decisions,
          validators: loaded.context.validators,
          project: true,
        });
        steps.push({
          id: SetupStepId.ProjectValidation,
          status: setupStatusFromValidation(validation),
          message: `Project validation found ${validation.findingCount} findings.`,
          details: [
            `validators: ${validation.validators.length}`,
            ...validation.diagnostics,
            ...validation.findings.slice(0, 20).map((finding) => `${finding.severity}: ${finding.validatorId} ${finding.file}:${finding.line}`),
          ],
        });
      } catch (error) {
        steps.push({
          id: SetupStepId.ProjectValidation,
          status: SetupStatus.Fail,
          message: "Project validation failed.",
          details: [errorMessage(error)],
        });
      }
    } else {
      steps.push({
        id: SetupStepId.Doctor,
        status: SetupStatus.Skip,
        message: "Doctor needs valid context files.",
      });
      steps.push({
        id: SetupStepId.ProjectValidation,
        status: SetupStatus.Skip,
        message: "Project validation needs valid context files.",
      });
    }
  }

  if (query.startDaemon) {
    const daemonStep = await startSetupDaemon(rootDir, query.dryRun);
    daemonStart = daemonStep.daemonStart;
    steps.push(daemonStep.step);
  } else {
    steps.push({
      id: SetupStepId.Daemon,
      status: SetupStatus.Skip,
      message: "Daemon start skipped.",
    });
  }

  let result = createSetupResult({
    rootDir,
    dryRun: query.dryRun,
    startedAt,
    scaffoldMissing,
    steps,
    init,
    hooks,
    doctor,
    validation,
    daemonStart,
  });

  if (!query.dryRun) {
    try {
      writeSetupState(rootDir, result);
      steps.push({
        id: SetupStepId.SetupState,
        status: SetupStatus.Pass,
        message: `Setup state written to ${SetupStateFile}.`,
      });
    } catch (error) {
      steps.push({
        id: SetupStepId.SetupState,
        status: SetupStatus.Fail,
        message: "Setup state could not be written.",
        details: [errorMessage(error)],
      });
    }
  } else {
    steps.push({
      id: SetupStepId.SetupState,
      status: SetupStatus.Skip,
      message: `Setup state would be written to ${SetupStateFile}.`,
    });
  }

  result = createSetupResult({
    rootDir,
    dryRun: query.dryRun,
    startedAt,
    scaffoldMissing,
    steps,
    init,
    hooks,
    doctor,
    validation,
    daemonStart,
  });
  if (!query.dryRun && steps.at(-1)?.id === SetupStepId.SetupState && steps.at(-1)?.status === SetupStatus.Pass) writeSetupState(rootDir, result);
  return result;
}

function parseSetupArgs(args: string[]): SetupQuery | null {
  const cli = cac("opencanon setup");
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option("--yes", "Use defaults without prompting.");
  cli.option(CliOptionFlag.DryRun, "Show setup actions without writing files.");
  cli.option(CliOptionFlag.Format, CliOptionDescription.Format);
  cli.option("--hooks <hosts>", "Install feedback hooks: codex, claude, opencode, all, or none.");
  cli.option(CliOptionFlag.Manifest, CliOptionDescription.RuntimeManifest);
  cli.option("--no-daemon", "Do not start the supervised daemon.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    CliOptionName.Help,
    CliOptionName.H,
    CliOptionName.Yes,
    CliOptionName.DryRun,
    CliOptionName.Format,
    CliOptionName.Hooks,
    CliOptionName.Manifest,
    SetupOptionName.Daemon,
  ]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSetupHelp();
    return null;
  }
  if (parsed.args.length > 0) throw new Error(`Unexpected setup arguments: ${parsed.args.join(", ")}`);

  return {
    dryRun: booleanOption(options.dryRun),
    format: formatOption(options.format),
    hooks: hooksOption(options.hooks),
    runtimeManifestSource: manifestOption(options.manifest),
    startDaemon: options[SetupOptionName.Daemon] !== false,
  };
}

function createSetupInitQuery(rootDir: string, query: SetupQuery): InitQuery {
  const defaults = createDefaultConfig(rootDir);
  return {
    yes: true,
    agent: true,
    dryRun: query.dryRun,
    force: false,
    missingOnly: true,
    format: query.format,
    hooks: [],
    docsDir: defaults.docsDir,
    validatorsPath: defaults.validatorsPath,
    fixturesDir: defaults.fixturesDir,
    cacheDir: defaults.cacheDir,
    fileDiscovery: defaults.fileDiscovery,
  };
}

function missingScaffoldFiles(rootDir: string): string[] {
  let paths: ReturnType<typeof createPaths>;
  try {
    paths = createPaths(rootDir);
  } catch {
    return ["opencanon.config.json"];
  }

  const files = [
    paths.decisionsPath,
    paths.validatorsPath,
    path.join(rootDir, ".agents/skills/opencanon/SKILL.md"),
    path.join(rootDir, ".agents/skills/opencanon/index.ts"),
    path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon.ts"),
    path.join(rootDir, ".agents/skills/opencanon/runtime/cli.js"),
  ];
  const missing = files.filter((file) => !existsSync(file)).map((file) => relative(rootDir, file));
  if (!packageHasOpenCanonScript(rootDir)) missing.push("package.json#scripts.opencanon");
  return missing;
}

function packageHasOpenCanonScript(rootDir: string): boolean {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    return packageJson.scripts?.opencanon === "bun .agents/skills/opencanon/scripts/opencanon.ts";
  } catch {
    return false;
  }
}

function installRequestedHooks(rootDir: string, query: SetupQuery): HookInstallResult[] {
  return query.hooks.map((host) =>
    installHook({
      rootDir,
      host,
      scope: HookInstallScope.Project,
      dryRun: query.dryRun,
    }),
  );
}

async function loadSetupContext(rootDir: string): Promise<{
  step: SetupStep;
  context?: {
    paths: ReturnType<typeof createPaths>;
    decisions: Awaited<ReturnType<typeof loadProjectContext>>["decisions"];
    validators: Awaited<ReturnType<typeof loadProjectContext>>["validators"];
    impactSurfaces: Awaited<ReturnType<typeof loadProjectContext>>["impactSurfaces"];
  };
}> {
  try {
    const context = await loadProjectContext(rootDir);
    const diagnostics = [
      ...validateConfig(context.paths),
      ...loadImpactSurfaces(context.paths).diagnostics,
      ...validateContext({
        paths: context.paths,
        decisions: context.decisions,
        validators: context.validators,
        impactSurfaces: context.impactSurfaces,
      }),
    ];
    return {
      step: {
        id: SetupStepId.Context,
        status: diagnostics.length === 0 ? SetupStatus.Pass : SetupStatus.Fail,
        message: diagnostics.length === 0 ? "Context files are valid." : "Context files need attention.",
        details: diagnostics,
      },
      context: diagnostics.length === 0 ? context : undefined,
    };
  } catch (error) {
    return {
      step: {
        id: SetupStepId.Context,
        status: SetupStatus.Fail,
        message: "Context files could not be loaded.",
        details: [errorMessage(error)],
      },
    };
  }
}

function ensureCacheIgnored(rootDir: string, dryRun: boolean): SetupStep {
  try {
    const paths = createPaths(rootDir);
    const entry = `${relative(rootDir, paths.cacheDir).replace(/\/$/, "")}/`;
    return ensureGitignoreEntryStep({
      rootDir,
      entry,
      dryRun,
      id: SetupStepId.CacheIgnore,
      presentMessage: `${entry} is ignored by Git.`,
      dryRunMessage: `${entry} would be added to .gitignore.`,
      writtenMessage: `${entry} added to .gitignore.`,
    });
  } catch (error) {
    return {
      id: SetupStepId.CacheIgnore,
      status: SetupStatus.Fail,
      message: "Cache ignore entry could not be resolved.",
      details: [errorMessage(error)],
    };
  }
}

function ensureSetupStateIgnored(rootDir: string, dryRun: boolean): SetupStep {
  return ensureGitignoreEntriesStep({
    rootDir,
    entries: [SetupStateFile, ...generatedStateIgnoreEntries],
    dryRun,
    id: SetupStepId.SetupStateIgnore,
    presentMessage: "Generated OpenCanon state and runtime files are ignored by Git.",
    dryRunMessage: "Generated OpenCanon state and runtime ignore entries would be added to .gitignore.",
    writtenMessage: "Generated OpenCanon state and runtime ignore entries added to .gitignore.",
  });
}

function ensureGitignoreEntryStep(params: {
  rootDir: string;
  entry: string;
  dryRun: boolean;
  id: SetupStepId;
  presentMessage: string;
  dryRunMessage: string;
  writtenMessage: string;
}): SetupStep {
  return ensureGitignoreEntriesStep({ ...params, entries: [params.entry] });
}

function ensureGitignoreEntriesStep(params: {
  rootDir: string;
  entries: string[];
  dryRun: boolean;
  id: SetupStepId;
  presentMessage: string;
  dryRunMessage: string;
  writtenMessage: string;
}): SetupStep {
  const gitignorePath = path.join(params.rootDir, ".gitignore");
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missingEntries = params.entries.filter((entry) => !lines.includes(entry));
  if (missingEntries.length === 0) {
    return {
      id: params.id,
      status: SetupStatus.Pass,
      message: params.presentMessage,
    };
  }

  if (!params.dryRun) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeAtomicTextFileSync(gitignorePath, `${current}${prefix}${missingEntries.join("\n")}\n`);
  }
  return {
    id: params.id,
    status: SetupStatus.Pass,
    message: params.dryRun ? params.dryRunMessage : params.writtenMessage,
  };
}

async function installSetupRuntime(rootDir: string, query: SetupQuery): Promise<SetupStep> {
  try {
    const result = await applyRuntimeUpdate({
      rootDir,
      cwd: rootDir,
      manifestSource: query.runtimeManifestSource ?? "",
      runtimeRoot: path.join(rootDir, ".agents/skills/opencanon/runtime"),
      dryRun: query.dryRun,
    });
    return {
      id: SetupStepId.RuntimeUpdate,
      status: SetupStatus.Pass,
      message:
        result.status === "current"
          ? "Engine runtime already matches the release manifest."
          : result.status === "dry-run"
            ? "Engine runtime release asset selected."
            : "Engine runtime installed from the release manifest.",
      details: [
        `target: ${result.check.target}`,
        `asset: ${result.check.resolvedAssetSource}`,
        `runtime: ${path.relative(rootDir, result.check.runtimePath)}`,
        `sha256: ${result.check.expectedSha256}`,
      ],
    };
  } catch (error) {
    return {
      id: SetupStepId.RuntimeUpdate,
      status: SetupStatus.Fail,
      message: "Engine runtime could not be installed from the release manifest.",
      details: [errorMessage(error)],
    };
  }
}

async function startSetupDaemon(rootDir: string, dryRun: boolean): Promise<{ step: SetupStep; daemonStart?: SetupResult["daemonStart"] }> {
  if (dryRun) {
    return {
      step: {
        id: SetupStepId.Daemon,
        status: SetupStatus.Skip,
        message: "Daemon prerequisite checks and start would run.",
      },
    };
  }

  try {
    const prerequisites = assertDaemonPrerequisites();
    const started = await startSupervisedDaemon({ cwd: rootDir });
    return {
      daemonStart: {
        status: started.status,
        url: started.entry.url,
        pid: started.entry.pid,
      },
      step: {
        id: SetupStepId.Daemon,
        status: SetupStatus.Pass,
        message: `Daemon ${started.status} at ${started.entry.url}.`,
        details: [`Bun: ${prerequisites.bunVersion}`, `Engine: ${prerequisites.engine.version().engineVersion}`],
      },
    };
  } catch (error) {
    return {
      step: {
        id: SetupStepId.Daemon,
        status: SetupStatus.Fail,
        message: "Daemon could not be started.",
        details: [errorMessage(error)],
      },
    };
  }
}

function setupStatusFromDoctor(status: DoctorStatus): SetupStatus {
  if (status === DoctorStatus.Fail) return SetupStatus.Fail;
  if (status === DoctorStatus.Warn) return SetupStatus.Warn;
  return SetupStatus.Pass;
}

function setupStatusFromValidation(validation: ValidationResult): SetupStatus {
  if (validation.diagnostics.length > 0 || validation.findings.some((finding) => finding.severity === "error")) return SetupStatus.Fail;
  if (validation.findings.length > 0) return SetupStatus.Warn;
  return SetupStatus.Pass;
}

function createSetupResult(params: Omit<SetupResult, "status" | "completedAt" | "statePath">): SetupResult {
  return {
    ...params,
    status: aggregateSetupStatus(params.steps),
    completedAt: new Date().toISOString(),
    statePath: params.dryRun ? undefined : SetupStateFile,
  };
}

function aggregateSetupStatus(steps: SetupStep[]): Exclude<SetupStatus, "skip"> {
  if (steps.some((step) => step.status === SetupStatus.Fail)) return SetupStatus.Fail;
  if (steps.some((step) => step.status === SetupStatus.Warn)) return SetupStatus.Warn;
  return SetupStatus.Pass;
}

function writeSetupState(rootDir: string, result: SetupResult): void {
  writeAtomicJsonFileSync(path.join(rootDir, SetupStateFile), {
    version: 1,
    rootDir: result.rootDir,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    steps: result.steps,
    scaffoldMissing: result.scaffoldMissing,
    init: result.init,
    hooks: result.hooks.map((hook) => ({
      host: hook.host,
      scope: hook.scope,
      dryRun: hook.dryRun,
      files: hook.files,
      diagnostics: hook.diagnostics,
    })),
    doctorStatus: result.doctor?.status,
    validation: result.validation
      ? {
          files: result.validation.files,
          validators: result.validation.validators,
          findingCount: result.validation.findingCount,
          diagnostics: result.validation.diagnostics,
        }
      : undefined,
    daemonStart: result.daemonStart,
  });
}

function renderSetupMarkdown(result: SetupResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Setup");
  lines.push("");
  lines.push(`Root: ${result.rootDir}${result.dryRun ? " (dry-run)" : ""}`);
  lines.push(`Status: ${result.status}`);
  if (result.statePath) lines.push(`State: ${result.statePath}`);
  lines.push("");
  lines.push("Steps:");
  for (const step of result.steps) {
    lines.push(`- [${step.status}] ${step.id}: ${step.message}`);
    for (const detail of step.details ?? []) lines.push(`  - ${detail}`);
  }
  if (result.init?.agentBriefPath) {
    lines.push("");
    lines.push(`Agent brief: ${result.init.agentBriefPath}`);
  }
  lines.push("");
  lines.push("Next:");
  if (result.status === SetupStatus.Fail) {
    lines.push("- Fix failed setup steps, then rerun bun run opencanon setup.");
  } else {
    lines.push("- Use bun run opencanon context --files <paths...> before code edits.");
    lines.push("- Use bun run opencanon validate --files <paths...> after code edits.");
  }
  return lines.join("\n");
}

function hooksOption(value: unknown): HookInstallHost[] {
  const values = stringValues(value).flatMap(splitList);
  if (values.length === 0 || values.includes("none")) return [];
  if (values.includes("all")) return [HookInstallHost.Codex, HookInstallHost.Claude, HookInstallHost.OpenCode];
  return values.map((item) => {
    if (item === HookInstallHost.Codex || item === HookInstallHost.Claude || item === HookInstallHost.OpenCode) return item;
    throw new Error(`Unsupported --hooks value: ${item}`);
  });
}

function manifestOption(value: unknown): string | undefined {
  const values = stringValues(value);
  if (values.length > 1) fail("--manifest accepts one source.");
  return values[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printSetupHelp(): void {
  console.log(`Usage:
  bun run opencanon setup --yes
  bun run opencanon setup --yes --hooks codex
  bun run opencanon setup --yes --hooks codex,claude,opencode
  bun run opencanon setup --yes --manifest <path-or-url>
  bun run opencanon setup --yes --no-daemon
  bun run opencanon setup --dry-run

Options:
  --yes                    Use defaults without prompting.
  --dry-run                Show setup actions without writing files.
  --format markdown|json   Output format. Default: markdown.
  --hooks <hosts>          codex, claude, opencode, all, or none. Default: none.
  ${CliOptionFlag.Manifest}      Release manifest path, file URL, or HTTPS URL for engine runtime install.
  --no-daemon              Do not start the supervised daemon.
`);
}
