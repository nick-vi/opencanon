import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { DaemonHealthSchema, DaemonStateSchema, resolveRootDir, writeAtomicJsonFileSync, type DaemonHealth, type DaemonState } from "@opencanon/core";
import { assertSafeDaemonHost, createDaemonAuthToken, daemonAuthHeaders } from "./auth.ts";

export type DaemonRegistryEntry = {
  rootDir: string;
  host: string;
  port: number;
  url: string;
  pid: number;
  startedAt: string;
  logPath: string;
  authToken: string;
};

export type DaemonStatus = "running" | "unhealthy" | "stale";

export type DaemonInspection = {
  entry: DaemonRegistryEntry;
  status: DaemonStatus;
  message: string;
  health?: DaemonHealth;
  state?: DaemonState;
};

export type StartSupervisedDaemonResult = {
  status: "started" | "already-running";
  entry: DaemonRegistryEntry;
  message: string;
};

export type StopDaemonResult = {
  status: "stopped" | "not-running" | "stale";
  rootDir: string;
  message: string;
};

type RegistryFile = {
  version: 1;
  daemons: DaemonRegistryEntry[];
};

type RegistryReadResult = {
  entries: DaemonRegistryEntry[];
  diagnostics: string[];
};

const registryVersion = 1;
const defaultDaemonPort = 4767;
const maxPortOffset = 100;
const SupervisorArg = {
  AllowRemote: "--allow-remote",
} as const;

const PlatformName = {
  Darwin: "darwin",
  Win32: "win32",
} as const;

export function supervisorRegistryPath(homeDir = homedir()): string {
  return path.join(homeDir, ".opencanon", "daemons.json");
}

export function projectDaemonPath(rootDir: string): string {
  return path.join(rootDir, ".opencanon", "daemon.json");
}

export function daemonLogPath(rootDir: string): string {
  return path.join(rootDir, ".opencanon", "daemon.log");
}

export function readDaemonRegistry(registryPath = supervisorRegistryPath()): DaemonRegistryEntry[] {
  return readDaemonRegistryFile(registryPath).entries;
}

export function readDaemonRegistryDiagnostics(registryPath = supervisorRegistryPath()): string[] {
  return readDaemonRegistryFile(registryPath).diagnostics;
}

function readDaemonRegistryFile(registryPath = supervisorRegistryPath()): RegistryReadResult {
  if (!existsSync(registryPath)) return { entries: [], diagnostics: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return { entries: [], diagnostics: [`Ignored malformed daemon registry: ${registryPath}.`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { entries: [], diagnostics: [`Ignored malformed daemon registry: ${registryPath}.`] };
  const registry = parsed as Partial<RegistryFile>;
  if (registry.version !== registryVersion || !Array.isArray(registry.daemons)) return { entries: [], diagnostics: [`Ignored malformed daemon registry: ${registryPath}.`] };
  const entries: DaemonRegistryEntry[] = [];
  const diagnostics: string[] = [];
  registry.daemons.forEach((entry, index) => {
    if (isRegistryEntry(entry)) {
      entries.push(entry);
      return;
    }
    diagnostics.push(`Ignored malformed daemon registry entry ${index + 1}. Run bun run opencanon daemon start to recreate daemon state for that project.`);
  });
  return { entries, diagnostics };
}

export function writeDaemonRegistry(entries: DaemonRegistryEntry[], registryPath = supervisorRegistryPath()): void {
  ensurePrivateDirectory(path.dirname(registryPath));
  const unique = new Map(entries.map((entry) => [entry.rootDir, entry]));
  const payload: RegistryFile = { version: registryVersion, daemons: [...unique.values()].sort((left, right) => left.rootDir.localeCompare(right.rootDir)) };
  writeAtomicJsonFileSync(registryPath, payload);
  chmodSync(registryPath, 0o600);
}

export function upsertDaemonEntry(entry: DaemonRegistryEntry, registryPath = supervisorRegistryPath()): void {
  const entries = readDaemonRegistry(registryPath).filter((item) => item.rootDir !== entry.rootDir);
  writeDaemonRegistry([...entries, entry], registryPath);
  writeProjectDaemonEntry(entry);
}

export function removeDaemonEntry(rootDir: string, registryPath = supervisorRegistryPath()): void {
  writeDaemonRegistry(readDaemonRegistry(registryPath).filter((entry) => entry.rootDir !== rootDir), registryPath);
  rmSync(projectDaemonPath(rootDir), { force: true });
}

export function writeProjectDaemonEntry(entry: DaemonRegistryEntry): void {
  const file = projectDaemonPath(entry.rootDir);
  ensurePrivateDirectory(path.dirname(file));
  writeAtomicJsonFileSync(file, entry);
  chmodSync(file, 0o600);
}

export function readProjectDaemonEntry(rootDir: string): DaemonRegistryEntry | undefined {
  const file = projectDaemonPath(rootDir);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return isRegistryEntry(parsed) ? parsed : undefined;
}

export async function startSupervisedDaemon(input: {
  cwd: string;
  host?: string;
  port?: number;
  serveUi?: boolean;
  registryPath?: string;
  allowRemote?: boolean;
}): Promise<StartSupervisedDaemonResult> {
  const rootDir = resolveRootDir(input.cwd);
  const host = input.host ?? "127.0.0.1";
  assertSafeDaemonHost(host, input.allowRemote);
  const registryPath = input.registryPath ?? supervisorRegistryPath();
  const existing = await inspectProjectDaemon(rootDir, registryPath);
  if (existing?.status === "running" || existing?.status === "unhealthy") {
    return {
      status: "already-running",
      entry: existing.entry,
      message: `OpenCanon daemon already registered for ${rootDir}.`,
    };
  }
  if (existing?.status === "stale") removeDaemonEntry(rootDir, registryPath);

  const port = await chooseDaemonPort({
    host,
    preferredPort: input.port,
    usedPorts: readDaemonRegistry(registryPath).map((entry) => entry.port),
  });
  const logPath = daemonLogPath(rootDir);
  const authToken = createDaemonAuthToken();
  ensurePrivateDirectory(path.dirname(logPath));
  const logFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  const args = [skillScriptPath(rootDir), "daemon", "serve", "--host", host, "--port", String(port)];
  if (input.allowRemote) args.push(SupervisorArg.AllowRemote);
  if (input.serveUi === false) args.push("--no-ui");
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, OPENCANON_DAEMON_TOKEN: authToken },
  });
  child.unref();
  closeSync(logFd);

  if (!child.pid) throw new Error("Could not start OpenCanon daemon process.");

  const entry: DaemonRegistryEntry = {
    rootDir,
    host,
    port,
    url: `http://${host}:${port}`,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
    authToken,
  };
  upsertDaemonEntry(entry, registryPath);

  const ready = await waitForDaemonHealth(entry);
  if (!ready) {
    removeDaemonEntry(rootDir, registryPath);
    throw new Error(`OpenCanon daemon did not become ready. See ${logPath}.`);
  }

  return {
    status: "started",
    entry,
    message: `OpenCanon daemon started for ${rootDir}.`,
  };
}

export async function inspectProjectDaemon(rootDir: string, registryPath = supervisorRegistryPath()): Promise<DaemonInspection | undefined> {
  const resolvedRoot = resolveRootDir(rootDir);
  const entry = readDaemonRegistry(registryPath).find((item) => item.rootDir === resolvedRoot) ?? readProjectDaemonEntry(resolvedRoot);
  return entry ? inspectDaemonEntry(entry) : undefined;
}

export async function inspectAllDaemons(registryPath = supervisorRegistryPath()): Promise<DaemonInspection[]> {
  const registry = readDaemonRegistryFile(registryPath);
  const entries = registry.entries;
  const inspections = await Promise.all(entries.map(inspectDaemonEntry));
  const liveEntries = inspections.filter((inspection) => inspection.status !== "stale").map((inspection) => inspection.entry);
  if (liveEntries.length !== entries.length || registry.diagnostics.length > 0) writeDaemonRegistry(liveEntries, registryPath);
  return inspections;
}

export async function stopProjectDaemon(rootDir: string, registryPath = supervisorRegistryPath()): Promise<StopDaemonResult> {
  const resolvedRoot = resolveRootDir(rootDir);
  const inspection = await inspectProjectDaemon(resolvedRoot, registryPath);
  if (!inspection) {
    return {
      status: "not-running",
      rootDir: resolvedRoot,
      message: `No OpenCanon daemon is registered for ${resolvedRoot}.`,
    };
  }

  if (inspection.status !== "stale") {
    process.kill(inspection.entry.pid, "SIGTERM");
    const stopped = await waitForProcessExit(inspection.entry.pid, 1500);
    if (!stopped && isProcessRunning(inspection.entry.pid)) process.kill(inspection.entry.pid, "SIGKILL");
  }

  removeDaemonEntry(resolvedRoot, registryPath);
  return {
    status: inspection.status === "stale" ? "stale" : "stopped",
    rootDir: resolvedRoot,
    message: inspection.status === "stale" ? `Removed stale daemon registration for ${resolvedRoot}.` : `Stopped OpenCanon daemon for ${resolvedRoot}.`,
  };
}

export async function chooseDaemonPort(input: { host: string; preferredPort?: number; usedPorts?: number[] }): Promise<number> {
  if (input.preferredPort !== undefined) {
    if (!(await isPortAvailable(input.host, input.preferredPort))) throw new Error(`Port ${input.preferredPort} is not available on ${input.host}.`);
    return input.preferredPort;
  }

  const used = new Set(input.usedPorts ?? []);
  for (let offset = 0; offset <= maxPortOffset; offset += 1) {
    const port = defaultDaemonPort + offset;
    if (used.has(port)) continue;
    if (await isPortAvailable(input.host, port)) return port;
  }
  throw new Error(`No daemon port is available in ${defaultDaemonPort}-${defaultDaemonPort + maxPortOffset}.`);
}

export async function inspectDaemonEntry(entry: DaemonRegistryEntry): Promise<DaemonInspection> {
  if (!isProcessRunning(entry.pid)) {
    return { entry, status: "stale", message: "Registered process is not running." };
  }
  const runtime = await daemonRuntimeStatus(entry);
  if (runtime.ok) {
    return {
      entry,
      status: "running",
      message: runtime.state ? "Daemon health and state endpoints are ready." : "Daemon health endpoint is ready.",
      health: runtime.health,
      state: runtime.state,
    };
  }
  return { entry, status: "unhealthy", message: runtime.message };
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function renderDaemonStatusMarkdown(inspection: DaemonInspection | undefined, rootDir: string): string {
  if (!inspection) {
    return ["# OpenCanon Daemon Status", "", `Root: ${resolveRootDir(rootDir)}`, "Status: not-running", "", "Run: bun run opencanon daemon start"].join("\n");
  }
  const lines = [
    "# OpenCanon Daemon Status",
    "",
    `Root: ${inspection.entry.rootDir}`,
    `Status: ${inspection.status}`,
    `URL: ${inspection.entry.url}`,
    `PID: ${inspection.entry.pid}`,
    `Started: ${inspection.entry.startedAt}`,
    `Log: ${inspection.entry.logPath}`,
    `Message: ${inspection.message}`,
  ];
  if (inspection.health) {
    lines.push(
      `Health: ${inspection.health.status}`,
      `Engine: ${inspection.health.engine.engineVersion} (package ${inspection.health.engine.packageVersion}, NAPI ${inspection.health.engine.napiVersion})`,
      `Watcher: ${formatWatcherStatus(inspection.health.watcher)}`,
    );
    if (inspection.health.validatorGraph) {
      lines.push(
        `Validator graph: ${inspection.health.validatorGraph.validatorCount} validators`,
        `Validator graph inputs: ${inspection.health.validatorGraph.dependencyFiles.length} files`,
        `Validator graph hash: ${inspection.health.validatorGraph.hash.slice(0, 12)}`,
        `Validator graph loaded: ${inspection.health.validatorGraph.loadedAt}`,
      );
    }
  }
  if (inspection.state) {
    lines.push(
      `Files: ${inspection.state.files}`,
      `Findings: ${inspection.state.findings}`,
      `Stale files: ${inspection.state.staleFiles}`,
      `Cache: ${inspection.state.cacheHits} hits, ${inspection.state.cacheMisses} misses`,
    );
  }
  return lines.join("\n");
}

export function renderDaemonListMarkdown(inspections: DaemonInspection[], diagnostics: string[] = []): string {
  const lines = ["# OpenCanon Daemons", ""];
  if (inspections.length === 0) {
    lines.push("No project daemons are registered.");
    if (diagnostics.length > 0) lines.push("", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
    return lines.join("\n");
  }
  for (const inspection of inspections) {
    lines.push(`- [${inspection.status}] ${inspection.entry.rootDir}`);
    lines.push(`  URL: ${inspection.entry.url}`);
    lines.push(`  PID: ${inspection.entry.pid}`);
    if (inspection.health) lines.push(`  Health: ${inspection.health.status}; watcher ${formatWatcherStatus(inspection.health.watcher)}`);
    if (inspection.state) lines.push(`  State: ${inspection.state.files} files, ${inspection.state.findings} findings, ${inspection.state.staleFiles} stale`);
  }
  if (diagnostics.length > 0) lines.push("", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
  return lines.join("\n");
}

export function openDaemonUrl(url: string): void {
  const command = process.platform === PlatformName.Darwin ? "open" : process.platform === PlatformName.Win32 ? "cmd" : "xdg-open";
  const args = process.platform === PlatformName.Win32 ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function daemonHealthOk(entry: DaemonRegistryEntry): Promise<boolean> {
  return (await daemonRuntimeStatus(entry)).ok;
}

async function daemonRuntimeStatus(
  entry: DaemonRegistryEntry,
): Promise<{ ok: true; health: DaemonHealth; state?: DaemonState } | { ok: false; message: string }> {
  try {
    const healthResponse = await fetch(`${entry.url}/api/health`);
    if (!healthResponse.ok) return { ok: false, message: `Process is running but health endpoint returned ${healthResponse.status}.` };
    const healthBody = (await healthResponse.json()) as { ok?: boolean; data?: unknown };
    if (healthBody.ok !== true) return { ok: false, message: "Process is running but health endpoint returned an invalid response." };
    const health = DaemonHealthSchema.safeParse(healthBody.data);
    if (!health.success) return { ok: false, message: "Process is running but health payload is invalid." };

    const state = await daemonState(entry);
    if (!state.ok) return { ok: true, health: health.data };
    return { ok: true, health: health.data, state: state.state };
  } catch {
    return { ok: false, message: "Process is running but health endpoint did not respond." };
  }
}

async function waitForDaemonHealth(entry: DaemonRegistryEntry): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await daemonHealthOk(entry)) return true;
    await sleep(100);
  }
  return false;
}

async function daemonState(entry: DaemonRegistryEntry): Promise<{ ok: true; state: DaemonState } | { ok: false }> {
  try {
    const response = await fetch(`${entry.url}/api/state`, { headers: daemonAuthHeaders(entry.authToken) });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { ok?: boolean; data?: unknown };
    if (body.ok !== true) return { ok: false };
    const state = DaemonStateSchema.safeParse(body.data);
    return state.success ? { ok: true, state: state.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function formatWatcherStatus(watcher: DaemonHealth["watcher"]): string {
  const status = watcher.running ? "running" : "stopped";
  const details = [`buffered ${watcher.bufferedEvents}`, watcher.stale ? "stale" : "fresh"];
  if (watcher.reason) details.push(watcher.reason);
  return `${status} (${details.join(", ")})`;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(50);
  }
  return !isProcessRunning(pid);
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function skillScriptPath(rootDir: string): string {
  return path.join(rootDir, ".agents", "skills", "opencanon", "scripts", "opencanon.ts");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function isRegistryEntry(value: unknown): value is DaemonRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.rootDir === "string" &&
    typeof record.host === "string" &&
    typeof record.port === "number" &&
    typeof record.url === "string" &&
    typeof record.pid === "number" &&
    typeof record.startedAt === "string" &&
    typeof record.logPath === "string" &&
    typeof record.authToken === "string" &&
    record.authToken.length > 0
  );
}
