import { readFileSync } from "node:fs";
import { cac } from "cac";
import {
  Format,
  ProjectRefreshModeValue,
  ProjectRefreshStatusValue,
  resolveRootDir,
  type ProducerStatus,
  type ReadSemanticIndexStatusResult,
  type SemanticIndexSnapshot,
} from "@opencanon/core";
import { isLoopbackHost } from "./auth.ts";
import { ApiRoute, ProjectIndexResponseMode } from "./routes.ts";
import { startOpenCanonRuntime, checkRuntimePrerequisites } from "./server.ts";
import { localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";
import { HiddenServiceRegistryArg } from "./service-peer-discovery.ts";
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

const RuntimeEnv = {
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  ServiceToken: "OPENCANON_SERVICE_TOKEN",
} as const;

const HiddenRegistryArg = HiddenServiceRegistryArg;

const BindAllHost = {
  Ipv4: "0.0.0.0",
  Ipv6: "::",
} as const;

const SemanticIndexStatus = {
  Disabled: "disabled",
  Indexing: "indexing",
  Ready: "ready",
  Stale: "stale",
  Failed: "failed",
} as const;

const ProjectRuntimeReadyTimeoutMs = 60_000;

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
    writeJson({ service: serviceInspectionJson(service), project: runtimeInspectionJson(project, cwd) });
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
  const server = await startOpenCanonRuntime({
    cwd,
    host: typeof options.host === "string" ? options.host : undefined,
    port: normalizeRuntimePort(options.port),
    allowRemote: options.allowRemote === true,
    idleTimeoutMs: normalizeRuntimeIdleTimeoutMs(options.idleTimeoutMs),
    onIdle: registryPath
      ? () => forgetRuntimeEntryForPid(resolvedRootDir, process.pid, registryPath)
      : undefined,
  });
  const stop = async () => {
    if (registryPath) forgetRuntimeEntryForPid(resolvedRootDir, process.pid, registryPath);
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(`OpenCanon ${surface.displayName.toLowerCase()} listening at ${server.url}`);
  console.log(`OpenCanon ${surface.displayName.toLowerCase()} pipe at ${server.pipeEndpoint}`);
  await new Promise(() => undefined);
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
    const producers = entry ? await readProducerStatuses(entry) : undefined;
    const index = entry ? await readProjectIndexStatus(entry) : undefined;
    writeJson({ project: runtimeInspectionJson(inspection, cwd), producers, index });
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

/** Fetch the running runtime's live producer statuses and render a markdown block. */
async function renderProducerStatusMarkdown(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<string> {
  const lines = ["## Type Producers", ""];
  const result = await readProducerStatuses(entry);
  if ("error" in result) {
    lines.push(`Could not read producer status: ${result.error}`);
    return lines.join("\n");
  }
  if (result.producers.length === 0) {
    lines.push("No type producers registered.");
    return lines.join("\n");
  }
  for (const status of result.producers) {
    const detail = status.detail ? ` — ${status.detail}` : "";
    lines.push(`- ${status.language}: ${status.kind}${detail}`);
    for (const warning of status.warnings ?? []) lines.push(`  - warning [${warning.code}]: ${warning.message}`);
  }
  return lines.join("\n");
}

async function readProducerStatuses(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<{ producers: ProducerStatus[] } | { error: string }> {
  try {
    const body = await requestLocalJson<{ producers?: ProducerStatus[] }>(localProtocolEndpointFromEntry(entry), { method: "GET", path: ApiRoute.Producers });
    return { producers: body.producers ?? [] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function renderProjectIndexStatusMarkdown(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<string> {
  const lines = ["## Project Index", ""];
  const result = await readProjectIndexStatus(entry);
  if ("error" in result) {
    lines.push(`Could not read project index status: ${result.error}`);
    return lines.join("\n");
  }
  if (!result.index) {
    lines.push("No context index snapshot has been written.");
    lines.push("");
    lines.push("Action: Run opencanon project index to build Search, Ask, and Context knowledge.");
    return lines.join("\n");
  }
  lines.push(...renderSemanticIndexLines(result.index));
  return lines.join("\n");
}

async function readProjectIndexStatus(entry: {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
}): Promise<ReadSemanticIndexStatusResult | { error: string }> {
  try {
    return await requestLocalJson<ReadSemanticIndexStatusResult>(localProtocolEndpointFromEntry(entry), { method: "GET", path: ApiRoute.ContextStatus });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function renderSemanticIndexLines(index: SemanticIndexSnapshot): string[] {
  const lines = [
    `Status: ${index.status}`,
    `Chunks: ${index.chunkCount}`,
    `Vectors: ${index.vectorCount}`,
    `Stale chunks: ${index.staleChunkCount}`,
    `Provider: ${index.provider.displayName ?? index.provider.id} (${index.provider.modelId})`,
    `Indexed: ${index.indexedAt}`,
  ];
  if (index.embeddingStats) {
    lines.push(`Embeddings: ${index.embeddingStats.embeddedChunks} embedded, ${index.embeddingStats.reusedChunks} reused of ${index.embeddingStats.totalChunks}`);
  }
  if (index.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of index.diagnostics) lines.push(`- ${diagnostic.severity}: ${diagnostic.message}`);
  }
  const action = semanticIndexAction(index);
  if (action) lines.push("", `Action: ${action}`);
  return lines;
}

function semanticIndexAction(index: SemanticIndexSnapshot): string | undefined {
  if (index.status === SemanticIndexStatus.Ready && index.staleChunkCount === 0) return undefined;
  if (index.status === SemanticIndexStatus.Indexing) return "Wait for the current project index rebuild to finish, then rerun opencanon project status.";
  if (index.status === SemanticIndexStatus.Disabled) return "Enable project knowledge indexing in opencanon.config.json before using Search or Ask.";
  if (index.status === SemanticIndexStatus.Failed) return "Fix the listed diagnostics, then run opencanon project index.";
  return "Run opencanon project index to rebuild Search, Ask, and Context knowledge.";
}

function runtimeInspectionJson(inspection: RuntimeInspection | undefined, cwd: string): Record<string, unknown> {
  if (!inspection) {
    return {
      rootDir: resolveRootDir(cwd),
      status: "not-running",
      actions: ["Run opencanon project start."],
    };
  }
  return {
    entry: runtimeEntryJson(inspection.entry),
    status: inspection.status,
    message: inspection.message,
    health: inspection.health,
    state: inspection.state,
    actions: runtimeStatusActions(inspection),
  };
}

function serviceInspectionJson(inspection: ServiceInspection | undefined): Record<string, unknown> {
  if (!inspection) {
    return {
      status: "not-running",
      actions: ["Run opencanon service start."],
    };
  }
  return {
    entry: serviceEntryJson(inspection.entry),
    status: inspection.status,
    message: inspection.message,
    health: inspection.health,
    actions: serviceStatusActions(inspection),
  };
}

function runtimeEntryJson(entry: RuntimeRegistryEntry): Omit<RuntimeRegistryEntry, "authToken"> {
  return {
    rootDir: entry.rootDir,
    host: entry.host,
    port: entry.port,
    url: entry.url,
    pipeEndpoint: entry.pipeEndpoint,
    pid: entry.pid,
    leaseId: entry.leaseId,
    lifecycle: entry.lifecycle,
    startedAt: entry.startedAt,
    logPath: entry.logPath,
    transport: entry.transport,
    protocolVersion: entry.protocolVersion,
    runtimeVersion: entry.runtimeVersion,
    runtimeFingerprint: entry.runtimeFingerprint,
    cliPath: entry.cliPath,
  };
}

function serviceEntryJson(entry: ServiceRegistryEntry): Omit<ServiceRegistryEntry, "authToken"> {
  const output: Omit<ServiceRegistryEntry, "authToken"> = {
    host: entry.host,
    port: entry.port,
    url: entry.url,
    pipeEndpoint: entry.pipeEndpoint,
    pid: entry.pid,
    leaseId: entry.leaseId,
    lifecycle: entry.lifecycle,
    startedAt: entry.startedAt,
    logPath: entry.logPath,
    transport: entry.transport,
    protocolVersion: entry.protocolVersion,
    runtimeVersion: entry.runtimeVersion,
    runtimeFingerprint: entry.runtimeFingerprint,
    cliPath: entry.cliPath,
  };
  if (entry.ownerPid !== undefined) output.ownerPid = entry.ownerPid;
  return output;
}

function runtimeStatusActions(inspection: RuntimeInspection): string[] {
  if (inspection.status === RuntimeStatus.Starting) return ["Wait for runtime readiness, then rerun opencanon project status."];
  if (inspection.status === RuntimeStatus.Stale) return ["Run opencanon project start to recreate project runtime state."];
  if (inspection.status === RuntimeStatus.Unhealthy) return ["Run opencanon project stop, then opencanon project start."];
  if (!inspection.health) return [];
  return refreshNeedsManualAction(inspection.health.refresh)
    ? ["Run opencanon project index to refresh derived project knowledge now.", "Run opencanon project stop, then opencanon project start to restore live file watching."]
    : [];
}

function serviceStatusActions(inspection: ServiceInspection): string[] {
  if (inspection.status === RuntimeStatus.Stale) return ["Run opencanon service start to recreate service state."];
  if (inspection.status === RuntimeStatus.Unhealthy) return ["Run opencanon service stop, then opencanon service start."];
  return [];
}

function renderOpenCanonStatusSummary(service: ServiceInspection | undefined, project: RuntimeInspection | undefined, cwd: string): string {
  const lines: string[] = [];
  const serviceStatus = service?.status ?? "not-running";
  const projectStatus = project?.status ?? "not-running";
  lines.push(`Service: ${serviceStatus}`);
  if (service?.message) lines.push(`Service health: ${service.message}`);
  if (!service) lines.push("Service action: opencanon service start");
  for (const action of service ? serviceStatusActions(service) : []) lines.push(`Service action: ${action}`);
  lines.push("");
  lines.push(`Project: ${projectStatus}`);
  lines.push(`Root: ${project?.entry.rootDir ?? resolveRootDir(cwd)}`);
  if (project?.message) lines.push(`Project health: ${project.message}`);
  if (!project) lines.push("Project action: opencanon project start");
  for (const action of project ? runtimeStatusActions(project) : []) lines.push(`Project action: ${action}`);
  if (project?.health) {
    lines.push(`Runtime: ${project.health.status}`);
    lines.push(`Engine: ${project.health.engine.engineVersion}`);
    lines.push(`Refresh: ${formatRefreshStatus(project.health.refresh)}`);
  }
  if (project?.state) {
    lines.push(`Files: ${project.state.files}`);
    lines.push(`Findings: ${project.state.findings}`);
    if (project.state.staleFiles > 0) lines.push(`Stale files: ${project.state.staleFiles}`);
  }
  lines.push("");
  lines.push("Details: opencanon service status, opencanon project status, or opencanon status --format json");
  return lines.join("\n");
}

function refreshNeedsManualAction(refresh: { status: string; mode: string }): boolean {
  return refresh.status === ProjectRefreshStatusValue.Stale || refresh.mode === ProjectRefreshModeValue.Manual;
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
    writeJson({ projects: projects.map((project) => runtimeInspectionJson(project, process.cwd())), diagnostics });
    return;
  }
  console.log(renderRuntimeListMarkdown(projects, diagnostics));
}

async function runServiceStartCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon service start");
  cli.option("--host <host>", "Host to bind.");
  cli.option("--port <port>", "Port to bind.");
  cli.option(RuntimeCliOptionFlag.AllowRemote, "Allow binding outside loopback addresses.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon service start", options, ["help", "h", "host", "port", "allowRemote"]);
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
      ownerPid: serviceOwnerPidFromEnv(),
    },
    registryPath,
  );
  const stop = async () => {
    forgetServiceEntryForPid(process.pid, registryPath);
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(`OpenCanon service listening at ${server.url}`);
  console.log(`OpenCanon service pipe at ${server.pipeEndpoint}`);
  await new Promise(() => undefined);
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
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnexpectedCommandInput(parsed.args, "opencanon project index", options, ["help", "h", "format"]);
  if (options.help || options.h) {
    printProjectHelp();
    return;
  }
  await ensureProjectRuntimeViaService({ cwd });
  const inspection = await waitForProjectRuntimeReady(cwd, { timeoutMs: ProjectRuntimeReadyTimeoutMs });
  const snapshot = await requestLocalJson<{ state?: { semanticIndex?: SemanticIndexSnapshot }; semanticIndex?: SemanticIndexSnapshot | null }>(
    localProtocolEndpointFromEntry(inspection.entry),
    { method: "POST", path: ApiRoute.Index, body: { response: ProjectIndexResponseMode.SemanticIndex } },
  );
  const index = snapshot.state?.semanticIndex ?? snapshot.semanticIndex;
  if (formatOption(options.format) === Format.Json) {
    writeJson({ index: index ?? null });
    return;
  }
  console.log("# OpenCanon Project Index");
  console.log("");
  if (!index) {
    console.log("Reindex requested; no context index snapshot is available yet.");
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
  opencanon project start --port 4767
  opencanon project start --format json
  opencanon project start --foreground
  opencanon project index
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
  opencanon service start
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
  --format markdown|json  Status output format. Default: markdown.
`);
}
