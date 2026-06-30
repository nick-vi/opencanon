import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { assertRuntimePrerequisites, ensureProjectRuntimeViaService } from "@opencanon/runtime";
import {
  buildDoctorReport,
  createDefaultConfig,
  createPaths,
  DoctorStatus,
  applyDoctorFixes,
  generateProjectTypes,
  GeneratedStateIgnoreEntries,
  HookInstallHost,
  HookInstallScope,
  installHook,
  InitStateFilePath,
  loadImpactSurfaces,
  relative,
  resolveRootDir,
  runValidation,
  splitList,
  validateConfig,
  validateContext,
  writeAtomicJsonFileSync,
  writeAtomicTextFileSync,
  DiagnosticSeverity,
  FixModeValue,
  Format,
  type DoctorReport,
  type HookInstallResult,
  type ValidationResult,
} from "@opencanon/core";
import { CliOptionDescription, CliOptionFlag, CliOptionName, booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { missingInitScaffoldFiles, runInitScaffold, type InitScaffoldQuery, type InitScaffoldResult } from "./init-scaffold.ts";
import { loadProjectContext } from "./project.ts";

const InitStatus = {
  Fail: "fail",
  Pass: "pass",
  Skip: "skip",
  Warn: "warn",
} as const;
type InitStatus = (typeof InitStatus)[keyof typeof InitStatus];

const InitStepId = {
  CacheIgnore: "cache-ignore",
  Context: "context",
  Runtime: "runtime",
  Doctor: "doctor",
  FeedbackHooks: "feedback-hooks",
  ProjectAuthoring: "project-authoring",
  ProjectValidation: "project-validation",
  Scaffold: "scaffold",
  InitStateIgnore: "init-state-ignore",
  InitState: "init-state",
  Validation: "validation",
} as const;
type InitStepId = (typeof InitStepId)[keyof typeof InitStepId];

const InitOptionName = {
  Runtime: "runtime",
} as const;

export type InitFlowQuery = {
  dryRun: boolean;
  format: Format;
  hooks: HookInstallHost[];
  startRuntime: boolean;
  init: Pick<InitScaffoldQuery, "docsDir" | "conventionsPath" | "areasPath" | "specsPath" | "changesPath" | "fixturesDir" | "cacheDir" | "fileDiscovery">;
};

type InitFlowStep = {
  id: InitStepId;
  status: InitStatus;
  message: string;
  details?: string[];
};

type InitScaffoldSummary = {
  files: InitScaffoldResult["files"];
  diagnostics: string[];
  nextSteps: string[];
};

export type InitFlowResult = {
  rootDir: string;
  status: Exclude<InitStatus, "skip">;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  statePath?: string;
  scaffoldMissing: string[];
  steps: InitFlowStep[];
  init?: InitScaffoldSummary;
  hooks: HookInstallResult[];
  doctor?: DoctorReport;
  validation?: ValidationResult;
  runtimeStart?: {
    status: string;
    url?: string;
    pid?: number;
  };
};

export async function runInitCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseInitFlowArgs(args, cwd);
  if (!query) return;
  const result = await runInitFlow(cwd, query);
  if (query.format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderInitFlowMarkdown(result));
  process.exit(result.status === InitStatus.Fail ? 1 : 0);
}

export async function runInitFlow(cwd: string, query: InitFlowQuery): Promise<InitFlowResult> {
  const rootDir = resolveRootDir(cwd);
  const startedAt = new Date().toISOString();
  const steps: InitFlowStep[] = [];
  const hooks: HookInstallResult[] = [];
  const scaffoldQuery = createInitScaffoldQuery(rootDir, query);
  const scaffoldMissing = missingScaffoldFiles(rootDir, scaffoldQuery);
  let init: InitScaffoldSummary | undefined;
  let doctor: DoctorReport | undefined;
  let validation: ValidationResult | undefined;
  let runtimeStart: InitFlowResult["runtimeStart"];

  if (scaffoldMissing.length > 0) {
    const initResult = runInitScaffold(rootDir, {
      ...scaffoldQuery,
      dryRun: query.dryRun,
      force: false,
      missingOnly: true,
    });
    init = {
      files: initResult.files,
      diagnostics: initResult.diagnostics,
      nextSteps: initResult.nextSteps,
    };
    steps.push({
      id: InitStepId.Scaffold,
      status: initResult.diagnostics.length === 0 ? InitStatus.Pass : InitStatus.Fail,
      message: query.dryRun ? "Scaffold plan generated." : "Scaffold is present.",
      details: [
        ...scaffoldMissing.map((file) => `missing before init: ${file}`),
        ...initResult.files.map((file) => `${file.action}: ${file.path}`),
        ...initResult.diagnostics,
      ],
    });
  } else {
    steps.push({
      id: InitStepId.Scaffold,
      status: InitStatus.Skip,
      message: "Scaffold is already present.",
    });
  }

  hooks.push(...installRequestedHooks(rootDir, query));
  if (query.hooks.length > 0) {
    steps.push({
      id: InitStepId.FeedbackHooks,
      status: hooks.some((hook) => hook.diagnostics.length > 0) ? InitStatus.Fail : InitStatus.Pass,
      message: query.dryRun ? "Feedback hook plan generated." : "Requested feedback hooks are installed.",
      details: hooks.flatMap((hook) => [
        `${hook.host}: ${hook.scope}${hook.dryRun ? " dry-run" : ""}`,
        ...hook.files.map((file) => `${file.action}: ${file.path}`),
        ...hook.diagnostics,
      ]),
    });
  }

  steps.push(ensureCacheIgnored(rootDir, query.dryRun));
  steps.push(ensureInitStateIgnored(rootDir, query.dryRun));
  steps.push(generateProjectAuthoringSupport(rootDir, query.dryRun));

  if (query.dryRun && scaffoldMissing.length > 0) {
    steps.push({
      id: InitStepId.Validation,
      status: InitStatus.Skip,
      message: "Validation needs the scaffold to be written.",
    });
  } else {
    const loaded = await loadInitContext(rootDir);
    steps.push(loaded.step);

    if (loaded.context) {
      const initialDoctor = buildDoctorReport(loaded.context);
      const doctorFixDetails: string[] = [];
      if (!query.dryRun) {
        const fixes = applyDoctorFixes({
          paths: loaded.context.paths,
          report: initialDoctor,
          mode: FixModeValue.Safe,
          dryRun: false,
          conventions: loaded.context.conventions,
          validators: loaded.context.validators,
        });
        if (fixes.selectedFixes > 0) {
          doctorFixDetails.push(`safe fixes applied: ${fixes.appliedFixes}/${fixes.selectedFixes}`);
          doctorFixDetails.push(...fixes.skipped.map((item) => `skipped: ${item}`));
          doctorFixDetails.push(...fixes.diagnostics.map((item) => `error: ${item}`));
        }
      }
      doctor = buildDoctorReport(loaded.context);
      steps.push({
        id: InitStepId.Doctor,
        status: initStatusFromDoctor(doctor.status),
        message: `Doctor status: ${doctor.status}.`,
        details: [...doctorFixDetails, ...doctor.checks.map((check) => `${check.status}: ${check.id}: ${check.message}`)],
      });

      try {
        validation = await runValidation({
          rootDir,
          paths: loaded.context.paths,
          conventions: loaded.context.conventions,
          validators: loaded.context.validators,
          project: true,
        });
        steps.push({
          id: InitStepId.ProjectValidation,
          status: initStatusFromValidation(validation),
          message: `Project validation found ${validation.findingCount} findings.`,
          details: [
            `validators: ${validation.validators.length}`,
            ...validation.diagnostics,
            ...validation.findings.slice(0, 20).map((finding) => `${finding.severity}: ${finding.validatorId} ${finding.file}:${finding.line}`),
          ],
        });
      } catch (error) {
        steps.push({
          id: InitStepId.ProjectValidation,
          status: InitStatus.Fail,
          message: "Project validation failed.",
          details: [errorMessage(error)],
        });
      }
    } else {
      steps.push({
        id: InitStepId.Doctor,
        status: InitStatus.Skip,
        message: "Doctor needs valid context files.",
      });
      steps.push({
        id: InitStepId.ProjectValidation,
        status: InitStatus.Skip,
        message: "Project validation needs valid context files.",
      });
    }
  }

  if (query.startRuntime) {
    const runtimeStep = await startInitRuntime(rootDir, query.dryRun);
    runtimeStart = runtimeStep.runtimeStart;
    steps.push(runtimeStep.step);
  } else {
    steps.push({
      id: InitStepId.Runtime,
      status: InitStatus.Skip,
      message: "Runtime start skipped.",
    });
  }

  let result = createInitFlowResult({
    rootDir,
    dryRun: query.dryRun,
    startedAt,
    scaffoldMissing,
    steps,
    init,
    hooks,
    doctor,
    validation,
    runtimeStart,
  });

  if (!query.dryRun) {
    try {
      writeInitState(rootDir, result);
      steps.push({
        id: InitStepId.InitState,
        status: InitStatus.Pass,
        message: `Init state written to ${InitStateFilePath}.`,
      });
    } catch (error) {
      steps.push({
        id: InitStepId.InitState,
        status: InitStatus.Fail,
        message: "Init state could not be written.",
        details: [errorMessage(error)],
      });
    }
  } else {
    steps.push({
      id: InitStepId.InitState,
      status: InitStatus.Skip,
      message: `Init state would be written to ${InitStateFilePath}.`,
    });
  }

  result = createInitFlowResult({
    rootDir,
    dryRun: query.dryRun,
    startedAt,
    scaffoldMissing,
    steps,
    init,
    hooks,
    doctor,
    validation,
    runtimeStart,
  });
  if (!query.dryRun && steps.at(-1)?.id === InitStepId.InitState && steps.at(-1)?.status === InitStatus.Pass) writeInitState(rootDir, result);
  return result;
}

function parseInitFlowArgs(args: string[], cwd: string): InitFlowQuery | null {
  const commandName = "opencanon init";
  const rootDir = resolveRootDir(cwd);
  const defaults = createInitScaffoldQuery(rootDir);
  const cli = cac(commandName);
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option("--yes", "Use defaults without prompting.");
  cli.option("--non-interactive", "Alias for --yes.");
  cli.option(CliOptionFlag.DryRun, "Show init actions without writing files.");
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
    InitOptionName.Runtime,
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
    printInitHelp();
    return null;
  }
  if (parsed.args.length > 0) throw new Error(`Unexpected init arguments: ${parsed.args.join(", ")}`);
  if (!booleanOption(options.yes) && !booleanOption(options.nonInteractive)) {
    throw new Error("opencanon init requires explicit consent. Use --yes or --non-interactive.");
  }

  return {
    dryRun: booleanOption(options.dryRun),
    format: formatOption(options.format),
    hooks: hooksOption(options.hooks),
    startRuntime: options[InitOptionName.Runtime] !== false,
    init: {
      docsDir: stringOption(options.docsDir, defaults.docsDir),
      conventionsPath: stringOption(options.conventionsPath, defaults.conventionsPath),
      areasPath: stringOption(options.areasPath, defaults.areasPath),
      specsPath: stringOption(options.specsPath, defaults.specsPath),
      changesPath: stringOption(options.changesPath, defaults.changesPath),
      fixturesDir: stringOption(options.fixturesDir, defaults.fixturesDir),
      cacheDir: stringOption(options.cacheDir, defaults.cacheDir),
      fileDiscovery: fileDiscoveryOption(options.fileDiscovery, defaults.fileDiscovery),
    },
  };
}

function createInitScaffoldQuery(rootDir: string, query?: InitFlowQuery): Omit<InitScaffoldQuery, "dryRun" | "force" | "missingOnly"> {
  const defaults = createDefaultConfig(rootDir);
  const paths = initScaffoldPaths(rootDir);
  return {
    docsDir: query?.init.docsDir ?? paths?.docsDir ?? defaults.docsDir,
    conventionsPath: query?.init.conventionsPath ?? paths?.conventionsPath ?? defaults.conventionsPath,
    areasPath: query?.init.areasPath ?? paths?.areasPath ?? defaults.areasPath,
    specsPath: query?.init.specsPath ?? paths?.specsPath ?? defaults.specsPath,
    changesPath: query?.init.changesPath ?? paths?.changesPath ?? defaults.changesPath,
    fixturesDir: query?.init.fixturesDir ?? paths?.fixturesDir ?? defaults.fixturesDir,
    cacheDir: query?.init.cacheDir ?? paths?.cacheDir ?? defaults.cacheDir,
    fileDiscovery: query?.init.fileDiscovery ?? paths?.fileDiscovery ?? defaults.fileDiscovery,
  };
}

function initScaffoldPaths(rootDir: string): Pick<InitScaffoldQuery, "docsDir" | "conventionsPath" | "areasPath" | "specsPath" | "changesPath" | "fixturesDir" | "cacheDir" | "fileDiscovery"> | null {
  try {
    const paths = createPaths(rootDir);
    return {
      docsDir: relative(rootDir, paths.docsDir),
      conventionsPath: relative(rootDir, paths.conventionsPath),
      areasPath: relative(rootDir, paths.areasPath),
      specsPath: relative(rootDir, paths.specsPath),
      changesPath: relative(rootDir, paths.changesPath),
      fixturesDir: relative(rootDir, paths.fixturesDir),
      cacheDir: relative(rootDir, paths.cacheDir),
      fileDiscovery: paths.fileDiscovery,
    };
  } catch {
    return null;
  }
}

function missingScaffoldFiles(rootDir: string, query: Omit<InitScaffoldQuery, "dryRun" | "force" | "missingOnly">): string[] {
  try {
    createPaths(rootDir);
  } catch {
    return ["opencanon.config.json"];
  }

  return missingInitScaffoldFiles(rootDir, {
    ...query,
    dryRun: false,
    force: false,
    missingOnly: true,
  });
}

function installRequestedHooks(rootDir: string, query: InitFlowQuery): HookInstallResult[] {
  return query.hooks.map((host) =>
    installHook({
      rootDir,
      host,
      scope: HookInstallScope.Project,
      dryRun: query.dryRun,
    }),
  );
}

async function loadInitContext(rootDir: string): Promise<{
  step: InitFlowStep;
  context?: {
    paths: ReturnType<typeof createPaths>;
    areas: Awaited<ReturnType<typeof loadProjectContext>>["areas"];
    changes: Awaited<ReturnType<typeof loadProjectContext>>["changes"];
    conventions: Awaited<ReturnType<typeof loadProjectContext>>["conventions"];
    specs: Awaited<ReturnType<typeof loadProjectContext>>["specs"];
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
        areas: context.areas,
        changes: context.changes,
        conventions: context.conventions,
        specs: context.specs,
        validators: context.validators.map((validator) => ({ id: validator.id, conventionIds: validator.conventionIds, docs: validator.docs })),
        impactSurfaces: context.impactSurfaces,
      }),
    ];
    return {
      step: {
        id: InitStepId.Context,
        status: diagnostics.length === 0 ? InitStatus.Pass : InitStatus.Fail,
        message: diagnostics.length === 0 ? "Context files are valid." : "Context files need attention.",
        details: diagnostics,
      },
      context: diagnostics.length === 0 ? context : undefined,
    };
  } catch (error) {
    return {
      step: {
        id: InitStepId.Context,
        status: InitStatus.Fail,
        message: "Context files could not be loaded.",
        details: [errorMessage(error)],
      },
    };
  }
}

function ensureCacheIgnored(rootDir: string, dryRun: boolean): InitFlowStep {
  try {
    const paths = createPaths(rootDir);
    const entry = `${relative(rootDir, paths.cacheDir).replace(/\/$/, "")}/`;
    return ensureGitignoreEntryStep({
      rootDir,
      entry,
      dryRun,
      id: InitStepId.CacheIgnore,
      presentMessage: `${entry} is ignored by Git.`,
      dryRunMessage: `${entry} would be added to .gitignore.`,
      writtenMessage: `${entry} added to .gitignore.`,
    });
  } catch (error) {
    return {
      id: InitStepId.CacheIgnore,
      status: InitStatus.Fail,
      message: "Cache ignore entry could not be resolved.",
      details: [errorMessage(error)],
    };
  }
}

function ensureInitStateIgnored(rootDir: string, dryRun: boolean): InitFlowStep {
  return ensureGitignoreEntriesStep({
    rootDir,
    entries: GeneratedStateIgnoreEntries,
    dryRun,
    id: InitStepId.InitStateIgnore,
    presentMessage: "Generated OpenCanon state files are ignored by Git.",
    dryRunMessage: "Generated OpenCanon state ignore entries would be added to .gitignore.",
    writtenMessage: "Generated OpenCanon state ignore entries added to .gitignore.",
  });
}

function generateProjectAuthoringSupport(rootDir: string, dryRun: boolean): InitFlowStep {
  if (dryRun) {
    return {
      id: InitStepId.ProjectAuthoring,
      status: InitStatus.Skip,
      message: "Project authoring support would be generated automatically.",
    };
  }

  try {
    const result = generateProjectTypes(rootDir, createPaths(rootDir));
    return {
      id: InitStepId.ProjectAuthoring,
      status: InitStatus.Pass,
      message: "Project authoring support generated.",
      details: [
        `path: ${result.path}`,
        `packages: ${result.packageCount}`,
        `import specifiers: ${result.importSpecifierCount}`,
        `npm dependencies: ${result.npmDependencyCount}`,
        `crates: ${result.crateCount}`,
        `cargo dependencies: ${result.cargoDependencyCount}`,
        `python dependencies: ${result.pythonDependencyCount}`,
        `alias modules: ${result.aliasModuleCount}`,
        `authoring declarations: ${result.authoringDeclarationCount}`,
      ],
    };
  } catch (error) {
    return {
      id: InitStepId.ProjectAuthoring,
      status: InitStatus.Fail,
      message: "Project authoring support could not be generated.",
      details: [errorMessage(error)],
    };
  }
}

function ensureGitignoreEntryStep(params: {
  rootDir: string;
  entry: string;
  dryRun: boolean;
  id: InitStepId;
  presentMessage: string;
  dryRunMessage: string;
  writtenMessage: string;
}): InitFlowStep {
  return ensureGitignoreEntriesStep({ ...params, entries: [params.entry] });
}

function ensureGitignoreEntriesStep(params: {
  rootDir: string;
  entries: string[];
  dryRun: boolean;
  id: InitStepId;
  presentMessage: string;
  dryRunMessage: string;
  writtenMessage: string;
}): InitFlowStep {
  const gitignorePath = path.join(params.rootDir, ".gitignore");
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missingEntries = params.entries.filter((entry) => !lines.includes(entry));
  if (missingEntries.length === 0) {
    return {
      id: params.id,
      status: InitStatus.Pass,
      message: params.presentMessage,
    };
  }

  if (!params.dryRun) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeAtomicTextFileSync(gitignorePath, `${current}${prefix}${missingEntries.join("\n")}\n`);
  }
  return {
    id: params.id,
    status: InitStatus.Pass,
    message: params.dryRun ? params.dryRunMessage : params.writtenMessage,
  };
}

async function startInitRuntime(rootDir: string, dryRun: boolean): Promise<{ step: InitFlowStep; runtimeStart?: InitFlowResult["runtimeStart"] }> {
  if (dryRun) {
    return {
      step: {
        id: InitStepId.Runtime,
        status: InitStatus.Skip,
        message: "Runtime prerequisite checks and start would run.",
      },
    };
  }

  try {
    const prerequisites = assertRuntimePrerequisites();
    const started = (await ensureProjectRuntimeViaService({ cwd: rootDir })).project;
    return {
      runtimeStart: {
        status: started.status,
        url: started.entry.url,
        pid: started.entry.pid,
      },
      step: {
        id: InitStepId.Runtime,
        status: InitStatus.Pass,
        message: `Runtime ${started.status} at ${started.entry.url}.`,
        details: [`Node: ${prerequisites.nodeVersion}`, `Engine: ${prerequisites.engine.version().engineVersion}`],
      },
    };
  } catch (error) {
    return {
      step: {
        id: InitStepId.Runtime,
        status: InitStatus.Fail,
        message: "Runtime could not be started.",
        details: [errorMessage(error)],
      },
    };
  }
}

function initStatusFromDoctor(status: DoctorStatus): InitStatus {
  if (status === DoctorStatus.Fail) return InitStatus.Fail;
  if (status === DoctorStatus.Warn) return InitStatus.Warn;
  return InitStatus.Pass;
}

function initStatusFromValidation(validation: ValidationResult): InitStatus {
  if (validation.diagnostics.length > 0 || validation.findings.some((finding) => finding.severity === DiagnosticSeverity.Error)) return InitStatus.Fail;
  if (validation.findings.length > 0) return InitStatus.Warn;
  return InitStatus.Pass;
}

function createInitFlowResult(params: Omit<InitFlowResult, "status" | "completedAt" | "statePath">): InitFlowResult {
  return {
    ...params,
    status: aggregateInitStatus(params.steps),
    completedAt: new Date().toISOString(),
    statePath: params.dryRun ? undefined : InitStateFilePath,
  };
}

function aggregateInitStatus(steps: InitFlowStep[]): Exclude<InitStatus, "skip"> {
  if (steps.some((step) => step.status === InitStatus.Fail)) return InitStatus.Fail;
  if (steps.some((step) => step.status === InitStatus.Warn)) return InitStatus.Warn;
  return InitStatus.Pass;
}

function writeInitState(rootDir: string, result: InitFlowResult): void {
  writeAtomicJsonFileSync(path.join(rootDir, InitStateFilePath), {
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
    runtimeStart: result.runtimeStart,
  });
}

function renderInitFlowMarkdown(result: InitFlowResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Init");
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
  lines.push("");
  lines.push("Next:");
  if (result.status === InitStatus.Fail) {
    lines.push("- Fix failed init steps, then rerun opencanon init.");
  } else {
    lines.push("- Use opencanon context --files <paths...> before code edits.");
    lines.push("- Use opencanon validate --files <paths...> after code edits.");
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

function fileDiscoveryOption(value: unknown, fallback: InitScaffoldQuery["fileDiscovery"]): InitScaffoldQuery["fileDiscovery"] {
  if (value === undefined) return fallback;
  if (value === "git" || value === "filesystem") return value;
  throw new Error(`Unsupported --file-discovery: ${String(value)}`);
}

function stringOption(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error("Option requires a string value.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printInitHelp(): void {
  console.log(`Usage:
  opencanon init --yes
  opencanon init --yes --hooks codex
  opencanon init --yes --hooks codex,claude,opencode
  opencanon init --yes --no-runtime
  opencanon init --yes --conventions-path canon/conventions/index.ts
  opencanon init --dry-run

Options:
  --yes                    Use defaults without prompting.
  --non-interactive        Alias for --yes.
  --dry-run                Show init actions without writing files.
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
`);
}
