import { readFileSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import {
  Format,
  resolveRootDir,
} from "@opencanon/core";
import { isLoopbackHost } from "./auth.ts";
import { ApiRoute } from "./routes.ts";
import {
  readProducerStatuses,
  readProjectIndexStatus,
  readProjectSummary,
  renderOpenCanonStatusSummary,
  renderProducerStatusMarkdown,
  renderProjectIndexStatusMarkdown,
  renderSemanticIndexLines,
  runtimeEntryJson,
  runtimeInspectionJson,
  runtimeStatusJson,
  serviceEntryJson,
  serviceInspectionJson,
} from "./cli-status.ts";
import { startOpenCanonRuntime, checkRuntimePrerequisites } from "./server.ts";
import { requestKnowledgeIndex } from "./knowledge-index-progress.ts";
import { runtimeStartupProblem, writeRuntimeStartupFailure } from "./service-startup-result.ts";
import { stopAllProjectRuntimes } from "./service-control.ts";
import { localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";
import { HiddenServiceRegistryArg } from "./service-peer-discovery.ts";
import { ProjectRuntimeEnv } from "./service-types.ts";
import { defaultRuntimeNamespace, projectRuntimeStatePath } from "./service-namespace.ts";
import {
  ProcessLifecycleStatus,
  RuntimeStatus,
  type RuntimeInspection,
  type RuntimeRegistryEntry,
  type ServiceInspection,
  type ServiceRegistryEntry,
  ensureProjectRuntimeViaService,
  serviceLogPath,
  inspectAllRuntimes,
  inspectService,
  inspectProjectRuntime,
  isProcessRunning,
  waitForProjectRuntimeReady,
  openRuntimeUrl,
  readRuntimeLifecycleEvents,
  readRuntimeRegistryDiagnostics,
  forgetRuntimeEntry,
  forgetRuntimeEntryForPid,
  forgetServiceEntryForPid,
  formatRefreshStatus,
  renderRuntimeListMarkdown,
  renderRuntimeStatusMarkdown,
  renderLifecycleEventsMarkdown,
  renderServiceStatusMarkdown,
  repairServiceProcessState,
  resolveRuntimeCliEntrypoint,
  runtimeIdentityForEntrypoint,
  startService,
  startServiceServer,
  stopService,
  stopProjectRuntime,
  serviceRegistryPath,
  upsertServiceEntry,
} from "./service.ts";

const RuntimeCliOptionFlag = {
  AllowRemote: "--allow-remote",
} as const;

const ProjectInspectTarget = {
  Runtime: "runtime",
  ValidatorGraph: "validator-graph",
} as const;

const RuntimeEnv = {
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  ServiceToken: "OPENCANON_SERVICE_TOKEN",
} as const;

const HiddenRegistryArg = HiddenServiceRegistryArg;

const BindAllHost = {
  Ipv4: "0.0.0.0",
  Ipv6: "::",
} as const;

const OwnedServiceOwnerPollIntervalMs = 250;

type ProjectRuntimeCliSurface = {
  command: string;
  displayName: string;
  help: () => void;
};

const RuntimeCliSurface = {
  Project: {
    command: "opencanon project",
    displayName: "Project Runtime",
    help: printProjectHelp,
  },
} as const satisfies Record<string, ProjectRuntimeCliSurface>;

export async function runProjectCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "status", ...rest] = args;
  if (command === "start") {
    await runStartCommand(rest, cwd, RuntimeCliSurface.Project);
    return;
  }
  if (command === "status") {
    await runProjectStatusCommand(rest, cwd, RuntimeCliSurface.Project);
    return;
  }
  if (command === "inspect") {
    await runProjectInspectCommand(rest, cwd);
    return;
  }
  if (command === "index") {
    await runProjectIndexCommand(rest, cwd);
    return;
  }
  if (command === "logs") {
    await runProjectLogsCommand(rest, cwd);
    return;
  }
  if (command === "list") {
    await runListCommand(rest, RuntimeCliSurface.Project);
    return;
  }
  if (command === "stop") {
    await runStopCommand(rest, cwd, RuntimeCliSurface.Project);
    return;
  }
  if (command === "open") {
    await runOpenCommand(rest, cwd, RuntimeCliSurface.Project);
    return;
  }
  if (command === "check") {
    rejectUnexpectedCommandInput(rest, "opencanon project check");
    console.log(await checkRuntimePrerequisites());
    return;
  }
  if (command === "forget") {
    await runProjectForgetCommand(rest, cwd);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printProjectHelp();
    return;
  }
  throw new Error(`Unknown project command: ${command}`);
}

export async function runOpenCanonStatusCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const cli = cac("opencanon status");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon status", options, ["help", "h", "format"]);
  if (options.help || options.h) {
    printStatusHelp();
    return;
  }

  const service = await inspectService();
  const project = await inspectProjectRuntime(cwd);
  if (formatOption(options.format) === Format.Json) {
    const summary = project?.status === RuntimeStatus.Running ? await readProjectSummary(project.entry) : undefined;
    writeJson({ service: serviceInspectionJson(service), project: runtimeStatusJson(project, cwd, summary) });
    return;
  }

  console.log("# OpenCanon Status");
  console.log("");
  console.log(renderOpenCanonStatusSummary(service, project, cwd));
}

export async function runServiceCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "status", ...rest] = args;
  if (command === "start") {
    await runServiceStartCommand(rest, cwd);
    return;
  }
  if (command === "run") {
    await runServiceServeCommand(rest);
    return;
  }
  if (command === "status") {
    await runServiceStatusCommand(rest);
    return;
  }
  if (command === "events") {
    await runServiceEventsCommand(rest);
    return;
  }
  if (command === "repair") {
    await runServiceRepairCommand(rest, cwd);
    return;
  }
  if (command === "open") {
    await runServiceOpenCommand(rest, cwd);
    return;
  }
  if (command === "stop") {
    await runServiceStopCommand(rest);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printServiceHelp();
    return;
  }
  throw new Error(`Unknown service command: ${command}`);
}

async function runStartCommand(args: string[], cwd: string, surface: ProjectRuntimeCliSurface): Promise<void> {
  const commandName = `${surface.command} start`;
  const cli = cac(commandName);
  cli.option("--host <host>", "Host to bind.");
  cli.option("--port <port>", "Port to bind.");
  cli.option("--foreground", "Run in the current process instead of the OpenCanon service.");
  cli.option("--idle-timeout-ms <ms>", "Stop after this many idle milliseconds when running in the foreground.");
  cli.option("--format <format>", "Output format.");
  cli.option(`${HiddenRegistryArg} <path>`, "Registry path.");
  cli.option(RuntimeCliOptionFlag.AllowRemote, "Allow binding outside loopback addresses.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, commandName, options, ["help", "h", "host", "port", "foreground", "idleTimeoutMs", "format", "registry", "allowRemote"]);
  if (options.help || options.h) {
    surface.help();
    return;
  }

  if (options.foreground) {
    if (options.format !== undefined) throw new Error("--format is not supported with --foreground.");
    await runServeCommand(args.filter((arg) => arg !== "--foreground"), cwd, RuntimeCliSurface.Project);
    return;
  }

  const result = await ensureProjectRuntimeViaService({
    cwd,
    host: typeof options.host === "string" ? options.host : undefined,
    port: normalizeRuntimePort(options.port),
    allowRemote: options.allowRemote === true,
  });
  const project = result.project;
  if (formatOption(options.format) === Format.Json) {
    writeJson({
      project: {
        status: project.status,
        message: project.message,
        entry: runtimeEntryJson(project.entry),
      },
      service: {
        status: "running",
        entry: serviceEntryJson(result.service),
      },
    });
    return;
  }
  console.log(`# OpenCanon ${surface.displayName}`);
  console.log("");
  console.log(`Status: ${project.status}`);
  console.log(`Root: ${project.entry.rootDir}`);
  console.log(`Pipe: ${project.entry.pipeEndpoint}`);
  console.log(`URL: ${project.entry.url}`);
  console.log(`PID: ${project.entry.pid}`);
  console.log(`Log: ${project.entry.logPath}`);
  console.log(`Service pipe: ${result.service.pipeEndpoint}`);
  console.log(`Service: ${result.service.url}`);
}

async function runServeCommand(args: string[], cwd: string, surface: ProjectRuntimeCliSurface): Promise<void> {
  const commandName = `${surface.command} run`;
  const cli = cac(commandName);
  cli.option("--host <host>", "Host to bind.");
  cli.option("--port <port>", "Port to bind.");
  cli.option("--idle-timeout-ms <ms>", "Stop after this many idle milliseconds.");
  cli.option(`${HiddenRegistryArg} <path>`, "Registry path.");
  cli.option(RuntimeCliOptionFlag.AllowRemote, "Allow binding outside loopback addresses.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, commandName, options, ["help", "h", "host", "port", "idleTimeoutMs", "registry", "allowRemote"]);
  if (options.help || options.h) {
    surface.help();
    return;
  }

  const registryPath = typeof options.registry === "string" ? options.registry : process.env[RuntimeEnv.RegistryPath];
  const resolvedRootDir = resolveRootDir(cwd);
  let resolveStopped: () => void = () => undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let server: Awaited<ReturnType<typeof startOpenCanonRuntime>>;
  try {
    server = await startOpenCanonRuntime({
      cwd,
      host: typeof options.host === "string" ? options.host : undefined,
      port: normalizeRuntimePort(options.port),
      allowRemote: options.allowRemote === true,
      idleTimeoutMs: normalizeRuntimeIdleTimeoutMs(options.idleTimeoutMs),
      statePath: process.env[ProjectRuntimeEnv.StatePath]?.trim()
        ? path.resolve(process.env[ProjectRuntimeEnv.StatePath]!)
        : projectRuntimeStatePath(resolvedRootDir, defaultRuntimeNamespace()),
      onIdle: registryPath
        ? () => forgetRuntimeEntryForPid(resolvedRootDir, process.pid, registryPath)
        : undefined,
      onStopped: resolveStopped,
    });
  } catch (error) {
    const startupResultPath = process.env[ProjectRuntimeEnv.StartupResultPath];
    if (startupResultPath) writeRuntimeStartupFailure(resolvedRootDir, startupResultPath, runtimeStartupProblem(resolvedRootDir, error));
    throw error;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (registryPath) forgetRuntimeEntryForPid(resolvedRootDir, process.pid, registryPath);
    try {
      await server.stop();
    } finally {
      resolveStopped();
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(`OpenCanon ${surface.displayName.toLowerCase()} listening at ${server.url}`);
  console.log(`OpenCanon ${surface.displayName.toLowerCase()} pipe at ${server.pipeEndpoint}`);
  await stoppedPromise;
}

async function runProjectStatusCommand(args: string[], cwd: string, surface: ProjectRuntimeCliSurface): Promise<void> {
  const commandName = `${surface.command} status`;
  const cli = cac(commandName);
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, commandName, options, ["help", "h", "format"]);
  if (options.help || options.h) {
    surface.help();
    return;
  }
  const inspection = await inspectProjectRuntime(cwd);
  if (formatOption(options.format) === Format.Json) {
    const entry = inspection?.status === RuntimeStatus.Running ? inspection.entry : undefined;
    const summary = entry ? await readProjectSummary(entry) : undefined;
    const producers = entry ? await readProducerStatuses(entry) : undefined;
    writeJson({ project: runtimeStatusJson(inspection, cwd, summary), producers });
    return;
  }
  console.log(renderRuntimeStatusMarkdown(inspection, cwd));
  if (inspection && inspection.status === RuntimeStatus.Running) {
    console.log("");
    console.log(await renderProducerStatusMarkdown(inspection.entry));
    console.log("");
    console.log(await renderProjectIndexStatusMarkdown(inspection.entry));
  }
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function formatOption(value: unknown): Format {
  if (value === undefined) return Format.Markdown;
  if (value === Format.Markdown || value === Format.Json) return value;
  throw new Error(`Unsupported --format: ${String(value)}`);
}

async function runListCommand(args: string[], surface: ProjectRuntimeCliSurface): Promise<void> {
  const commandName = `${surface.command} list`;
  const cli = cac(commandName);
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, commandName, options, ["help", "h", "format"]);
  if (options.help || options.h) {
    surface.help();
    return;
  }
  const diagnostics = readRuntimeRegistryDiagnostics();
  const projects = await inspectAllRuntimes();
  if (formatOption(options.format) === Format.Json) {
    writeJson({ projects: projects.map((project) => runtimeStatusJson(project, process.cwd())), diagnostics });
    return;
  }
  console.log(renderRuntimeListMarkdown(projects, diagnostics));
}

async function runProjectInspectCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon project inspect");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args.slice(1), "opencanon project inspect", options, ["help", "h", "format"]);
  if (options.help || options.h) {
    console.log("Usage: opencanon project inspect <runtime|validator-graph> [--format markdown|json]");
    return;
  }
  const target = String(parsed.args[0] ?? "");
  if (target !== ProjectInspectTarget.Runtime && target !== ProjectInspectTarget.ValidatorGraph) {
    throw new Error("Usage: opencanon project inspect <runtime|validator-graph> [--format markdown|json]");
  }
  const inspection = await inspectProjectRuntime(cwd);
  if (!inspection || inspection.status !== RuntimeStatus.Running) {
    throw new Error("Project runtime is not running. Run opencanon project start first.");
  }
  if (target === ProjectInspectTarget.Runtime) {
    writeJson(runtimeInspectionJson(inspection, cwd));
    return;
  }
  const state = await requestLocalJson<{ health?: { validatorGraph?: unknown } }>(localProtocolEndpointFromEntry(inspection.entry), {
    method: "GET",
    path: ApiRoute.State,
  });
  const graph = state.health?.validatorGraph;
  if (!graph) throw new Error("The project runtime has no validator graph metadata.");
  if (formatOption(options.format) === Format.Json) {
    writeJson(graph);
    return;
  }
  const value = graph as { entrypoint?: string; hash?: string; loadedAt?: string; validatorCount?: number; dependencyFiles?: string[] };
  console.log([
    "# OpenCanon Validator Graph",
    "",
    `Entrypoint: ${value.entrypoint ?? "unknown"}`,
    `Hash: ${value.hash ?? "unknown"}`,
    `Loaded: ${value.loadedAt ?? "unknown"}`,
    `Validators: ${value.validatorCount ?? 0}`,
    `Dependencies: ${value.dependencyFiles?.length ?? 0}`,
    ...(value.dependencyFiles?.length ? ["", ...value.dependencyFiles.map((file) => `- ${file}`)] : []),
  ].join("\n"));
}

async function runServiceStartCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon service start");
  cli.option("--host <host>", "Host to bind.");
  cli.option("--port <port>", "Port to bind.");
  cli.option("--format <format>", "Output format.");
  cli.option(RuntimeCliOptionFlag.AllowRemote, "Allow binding outside loopback addresses.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service start", options, ["help", "h", "host", "port", "format", "allowRemote"]);
  if (options.help || options.h) {
    printServiceHelp();
    return;
  }
  const result = await startService({
    cwd,
    host: typeof options.host === "string" ? options.host : undefined,
    port: normalizeRuntimePort(options.port),
    allowRemote: options.allowRemote === true,
  });
  if (formatOption(options.format) === Format.Json) {
    writeJson({
      service: {
        status: result.status,
        message: result.message,
        entry: serviceEntryJson(result.entry),
      },
    });
    return;
  }
  console.log(`# OpenCanon Service`);
  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`Pipe: ${result.entry.pipeEndpoint}`);
  console.log(`URL: ${result.entry.url}`);
  console.log(`PID: ${result.entry.pid}`);
  console.log(`Log: ${result.entry.logPath}`);
}

async function runServiceServeCommand(args: string[]): Promise<void> {
  const cli = cac("opencanon service run");
  cli.option("--host <host>", "Host to bind.");
  cli.option("--port <port>", "Port to bind.");
  cli.option(`${HiddenRegistryArg} <path>`, "Registry path.");
  cli.option(RuntimeCliOptionFlag.AllowRemote, "Allow binding outside loopback addresses.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service run", options, ["help", "h", "host", "port", "registry", "allowRemote"]);
  if (options.help || options.h) {
    printServiceHelp();
    return;
  }
  const registryPath = typeof options.registry === "string" ? options.registry : process.env[RuntimeEnv.RegistryPath] ?? serviceRegistryPath();
  const leaseId = process.env.OPENCANON_SERVICE_LEASE_ID?.trim() || `service-${process.pid}`;
  const ownerPid = serviceOwnerPidFromEnv();
  let resolveStopped: () => void = () => undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const server = await startServiceServer({
    host: typeof options.host === "string" ? options.host : undefined,
    port: normalizeRuntimePort(options.port),
    authToken: process.env[RuntimeEnv.ServiceToken],
    leaseId,
    registryPath,
    allowRemote: options.allowRemote === true,
  });
  upsertServiceEntry(
    {
      host: typeof options.host === "string" ? options.host : "127.0.0.1",
      port: server.port,
      url: server.url,
      pipeEndpoint: server.pipeEndpoint,
      pid: process.pid,
      leaseId: server.leaseId,
      startedAt: new Date().toISOString(),
      logPath: serviceLogPath(registryPath),
      authToken: server.authToken,
      lifecycle: {
        status: ProcessLifecycleStatus.Running,
        updatedAt: new Date().toISOString(),
        message: "OpenCanon service health endpoint is ready.",
        restart: { attempts: 0 },
      },
      ...runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(process.cwd())),
      ownerPid,
    },
    registryPath,
  );
  let stopping = false;
  let ownerTimer: ReturnType<typeof setInterval> | undefined;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (ownerTimer) clearInterval(ownerTimer);
    ownerTimer = undefined;
    try {
      await server.stop();
    } finally {
      try {
        await stopAllProjectRuntimes(registryPath);
      } finally {
        forgetServiceEntryForPid(process.pid, registryPath);
        resolveStopped();
      }
    }
  };
  const requestStop = () => {
    void stop().catch((error) => {
      console.error(`OpenCanon service shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  if (ownerPid !== undefined) {
    ownerTimer = setInterval(() => {
      if (!isProcessRunning(ownerPid)) requestStop();
    }, OwnedServiceOwnerPollIntervalMs);
    ownerTimer.unref();
  }
  console.log(`OpenCanon service listening at ${server.url}`);
  console.log(`OpenCanon service pipe at ${server.pipeEndpoint}`);
  await stoppedPromise;
}

async function runServiceEventsCommand(args: string[]): Promise<void> {
  const cli = cac("opencanon service events");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--limit <limit>", "Number of recent events to show.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service events", options, ["help", "h", "format", "limit"]);
  if (options.help || options.h) {
    printServiceHelp();
    return;
  }
  const limit = normalizePositiveInteger(options.limit, "--limit", 50);
  const events = readRuntimeLifecycleEvents();
  if (formatOption(options.format) === Format.Json) {
    writeJson({ events: events.slice(-limit).reverse() });
    return;
  }
  console.log(renderLifecycleEventsMarkdown(events, limit));
}

async function runServiceStatusCommand(args: string[]): Promise<void> {
  const cli = cac("opencanon service status");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service status", options, ["help", "h", "format"]);
  if (options.help || options.h) {
    printServiceHelp();
    return;
  }
  const inspection = await inspectService();
  if (formatOption(options.format) === Format.Json) {
    writeJson({ service: serviceInspectionJson(inspection) });
    return;
  }
  console.log(renderServiceStatusMarkdown(inspection));
}

async function runServiceRepairCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon service repair");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service repair", options, ["help", "h", "format"]);
  if (options.help || options.h) {
    printServiceHelp();
    return;
  }
  const result = await repairServiceProcessState({ cwd });
  if (formatOption(options.format) === Format.Json) {
    writeJson(result);
    return;
  }
  console.log("# OpenCanon Service Repair");
  console.log("");
  console.log(`Retired service processes: ${result.retiredServiceProcesses}`);
  console.log(`Retired project runtimes: ${result.retiredProjectRuntimes}`);
  console.log(`Removed pipe endpoints: ${result.removedPipeEndpoints}`);
  if (result.diagnostics.length > 0) {
    console.log("");
    console.log("Diagnostics:");
    for (const diagnostic of result.diagnostics) console.log(`- ${diagnostic}`);
  }
}

async function runServiceOpenCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon service open");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service open", options, ["help", "h"]);
  if (options.help || options.h) {
    printServiceHelp();
    return;
  }
  const service = await startService({ cwd });
  const url = runtimeOpenUrl(service.entry);
  openRuntimeUrl(url);
  console.log(url);
}

async function runServiceStopCommand(args: string[]): Promise<void> {
  const cli = cac("opencanon service stop");
  cli.option("--format <format>", "Output format.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service stop", options, ["help", "h", "format"]);
  if (options.help || options.h) {
    printServiceHelp();
    return;
  }
  const result = await stopService();
  if (formatOption(options.format) === Format.Json) {
    writeJson(result);
    return;
  }
  console.log(`# OpenCanon Service`);
  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`Message: ${result.message}`);
}

async function runStopCommand(args: string[], cwd: string, surface: ProjectRuntimeCliSurface): Promise<void> {
  const commandName = `${surface.command} stop`;
  const cli = cac(commandName);
  cli.option("--format <format>", "Output format.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, commandName, options, ["help", "h", "format"]);
  if (options.help || options.h) {
    surface.help();
    return;
  }
  const result = await stopProjectRuntime(cwd);
  if (formatOption(options.format) === Format.Json) {
    writeJson(result);
    return;
  }
  console.log(`# OpenCanon ${surface.displayName}`);
  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`Root: ${result.rootDir}`);
  console.log(`Message: ${result.message}`);
}

async function runOpenCommand(args: string[], cwd: string, surface: ProjectRuntimeCliSurface): Promise<void> {
  const commandName = `${surface.command} open`;
  const cli = cac(commandName);
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, commandName, options, ["help", "h"]);
  if (options.help || options.h) {
    surface.help();
    return;
  }
  const inspection = await inspectProjectRuntime(cwd);
  if (!inspection || inspection.status !== RuntimeStatus.Running) {
    console.log(renderRuntimeStatusMarkdown(inspection, cwd));
    return;
  }
  const url = runtimeOpenUrl(inspection.entry);
  openRuntimeUrl(url);
  console.log(url);
}

async function runProjectIndexCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon project index");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--force", "Clear Project Knowledge state and rebuild it from source.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon project index", options, ["help", "h", "format", "force"]);
  if (options.help || options.h) {
    printProjectHelp();
    return;
  }
  const format = formatOption(options.format);
  const ensured = await ensureProjectRuntimeViaService({ cwd });
  const endpoint = localProtocolEndpointFromEntry(ensured.project.entry);
  if (format !== Format.Json) {
    console.log("# OpenCanon Project Knowledge");
    console.log("");
    console.log(options.force === true ? "Rebuilding Project Knowledge..." : "Indexing Project Knowledge...");
    console.log("");
  }
  const snapshot = await requestKnowledgeIndex({
    endpoint,
    force: options.force === true,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });
  const index = snapshot.state?.semanticIndex ?? snapshot.semanticIndex;
  if (format === Format.Json) {
    writeJson({ index: index ?? null });
    return;
  }
  if (!index) {
    console.log("Index requested; no Project Knowledge snapshot is available yet.");
    return;
  }
  for (const line of renderSemanticIndexLines(index)) console.log(line);
}

async function runProjectLogsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon project logs");
  cli.option("--path", "Print the log path only.");
  cli.option("--tail <lines>", "Number of trailing log lines to print.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon project logs", options, ["help", "h", "path", "tail"]);
  if (options.help || options.h) {
    printProjectHelp();
    return;
  }
  const inspection = await inspectProjectRuntime(cwd);
  if (!inspection) {
    console.log(renderRuntimeStatusMarkdown(inspection, cwd));
    return;
  }
  if (options.path === true) {
    console.log(inspection.entry.logPath);
    return;
  }
  const tail = normalizePositiveInteger(options.tail, "--tail", 200);
  try {
    const lines = readFileSync(inspection.entry.logPath, "utf8").split(/\r?\n/);
    console.log(lines.slice(Math.max(0, lines.length - tail)).join("\n").trimEnd());
  } catch (error) {
    throw new Error(`Could not read project log ${inspection.entry.logPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runProjectForgetCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon project forget");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon project forget", options, ["help", "h"]);
  if (options.help || options.h) {
    printProjectHelp();
    return;
  }
  const rootDir = resolveRootDir(cwd);
  forgetRuntimeEntry(rootDir, serviceRegistryPath());
  console.log(`# OpenCanon Project\n\nStatus: forgotten\nRoot: ${rootDir}`);
}

export function normalizeRuntimePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid --port: ${String(value)}`);
    process.exit(1);
  }
  return port;
}

function normalizeRuntimeIdleTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const timeout = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(timeout) || timeout < 0) {
    console.error(`Invalid --idle-timeout-ms: ${String(value)}`);
    process.exit(1);
  }
  return timeout;
}

function normalizePositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === false) return fallback;
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    console.error(`Invalid ${name}: ${String(value)}`);
    process.exit(1);
  }
  return numberValue;
}

function rejectUnexpectedCommandInput(args: readonly unknown[], command: string, options: Record<string, unknown> = {}, allowedOptions: string[] = []): void {
  const allowed = new Set(["--", ...allowedOptions]);
  const unknownOption = Object.keys(options).find((key) => !allowed.has(key));
  if (unknownOption) throw new Error(`Unknown ${command} option: --${unknownOption.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
  if (args.length > 0) throw new Error(`Unexpected ${command} arguments: ${args.map(String).join(", ")}`);
}

function serviceOwnerPidFromEnv(): number | undefined {
  const value = Number(process.env.OPENCANON_SERVICE_OWNER_PID);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function runtimeOpenUrl(entry: { url: string; host: string; authToken: string }): string {
  const url = new URL(entry.url);
  if (entry.host === BindAllHost.Ipv4) url.hostname = "127.0.0.1";
  if (entry.host === BindAllHost.Ipv6) url.hostname = "[::1]";
  if (isLoopbackHost(entry.host)) return url.href;
  url.searchParams.set("token", entry.authToken);
  return url.href;
}

function printStatusHelp(): void {
  console.log(`Usage:
  opencanon status
  opencanon status --format json

Shows the global OpenCanon service and the current project's runtime status.

Use this first when Search, Ask, validation, hooks, or local runtime state feels out of date.

Options:
  --format markdown|json  Output format. Default: markdown.
`);
}

function printProjectHelp(): void {
  console.log(`Usage:
  opencanon project status
  opencanon project status --format json
  opencanon project inspect validator-graph
  opencanon project start --port 4767
  opencanon project start --format json
  opencanon project start --foreground
  opencanon project index
  opencanon project index --force
  opencanon project index --format json
  opencanon project logs --tail 200
  opencanon project logs --path
  opencanon project list
  opencanon project stop
  opencanon project open
  opencanon project check
  opencanon project forget

Commands:
  status  Show this project's runtime, live refresh, producers, and index state.
  inspect Show explicit runtime internals or validator-graph dependency paths.
  start   Ask the OpenCanon service to start this project's runtime.
  index   Rebuild derived Search, Ask, Context, and Project Map knowledge now.
  logs    Print this project's runtime log path or recent log lines.
  list    List globally registered project runtimes.
  stop    Stop this project's runtime.
  open    Open this project's runtime URL.
  check   Verify pinned Node and engine prerequisites.
  forget  Remove this project's stale runtime registry entry.

Options:
  --format markdown|json  Output format for status, start, list, stop, and index. Default: markdown.
`);
}

function printServiceHelp(): void {
  console.log(`Usage:
  opencanon service start --format json
  opencanon service run
  opencanon service status
  opencanon service status --format json
  opencanon service events
  opencanon service repair
  opencanon service open
  opencanon service stop

Commands:
  start   Start the global OpenCanon service.
  run     Run the global OpenCanon service in the current process for debugging.
  status  Show global OpenCanon service status.
  events  Show recent service and project runtime lifecycle events.
  repair  Retire unregistered service/project processes and stale local pipes.
  open    Open the service API URL.
  stop    Stop the global OpenCanon service.

Options:
  --format markdown|json  Output format for start, status, events, and stop. Default: markdown.
`);
}
