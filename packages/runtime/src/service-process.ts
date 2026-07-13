import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { cleanupLocalPipeEndpoints } from "./local-protocol.ts";
import { isProcessRunning, terminateSpawnedProcess } from "./process-tree.ts";
import { discoverProjectRuntimeRunPeers, discoverServiceRunPeers } from "./service-peer-discovery.ts";
import { directoryExists } from "./service-discovery.ts";
import { runtimeCliInvocation } from "./service-entrypoint.ts";
import {
  appendLifecycleEvent,
  forgetRuntimeEntryIfPid,
  forgetServiceEntryIfPid,
  isRegistryEntry,
  isServiceEntry,
  projectRuntimePath,
  projectWorkerLeaseHeartbeatStale,
  projectWorkerLeasePath,
  readProjectRuntimeEntry,
  readProjectWorkerLeaseFile,
  readRuntimeRegistry,
  readRuntimeRegistryFile,
  readServiceEntry,
  removeInactiveStartupLock,
  serviceRegistryPath,
} from "./service-storage.ts";
import {
  LocalPipeCleanupAgeMs,
  PlatformName,
  ProcessLifecycleEventKind,
  ProcessLifecycleScope,
  defaultRuntimePort,
  maxPortOffset,
  registryVersion,
  serviceCommandOutputLimit,
  type RuntimeProcessLease,
  type ServiceProcessLease,
  type ServiceRepairResult,
} from "./service-types.ts";

export { isProcessRunning, terminateSpawnedProcess } from "./process-tree.ts";

export async function retireUnsupportedRegistry(registryPath: string): Promise<void> {
  if (!existsSync(registryPath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    rmSync(registryPath, { force: true });
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    rmSync(registryPath, { force: true });
    return;
  }
  const record = parsed as Record<string, unknown>;
  if (record.version === registryVersion && Array.isArray(record.runtimes)) return;
  await retireRuntimeProcessLeases(runtimeProcessLeasesFromRegistryValue(parsed, registryPath), registryPath);
  await retireServiceProcessLeases(serviceProcessLeasesFromRegistryValue(parsed, registryPath), registryPath);
  rmSync(registryPath, { force: true });
}

export async function retireUnusableProjectRuntimeEntry(rootDir: string, registryPath: string): Promise<void> {
  const lease = readProjectRuntimeLease(rootDir, registryPath);
  if (!lease) return;
  await retireRuntimeProcessLeases([lease], registryPath);
  const projectEntry = readProjectRuntimeEntry(rootDir, registryPath);
  if (!projectEntry || projectEntry.pid === lease.pid) rmSync(projectRuntimePath(rootDir, registryPath), { force: true });
}

export async function retireConflictingProjectWorkerLease(
  rootDir: string,
  registryPath: string,
  allowedPid?: number,
  options: { allowStaleAllowedPid?: boolean } = {},
): Promise<boolean> {
  const lockPath = projectWorkerLeasePath(rootDir, registryPath);
  const lease = readProjectWorkerLeaseFile(lockPath);
  if (!lease) {
    rmSync(lockPath, { force: true });
    return false;
  }
  if (
    allowedPid !== undefined &&
    lease.pid === allowedPid &&
    isProcessRunning(lease.pid) &&
    (options.allowStaleAllowedPid || !projectWorkerLeaseHeartbeatStale(lockPath))
  ) return false;

  const running = isProcessRunning(lease.pid);
  if (running && lease.pid !== process.pid) await terminateSpawnedProcess(lease.pid);
  if (lease.pid !== process.pid) rmSync(lockPath, { force: true });
  forgetRuntimeEntryIfPid(rootDir, lease.pid, registryPath);
  appendLifecycleEvent(registryPath, {
    kind: ProcessLifecycleEventKind.RuntimeStale,
    scope: ProcessLifecycleScope.Runtime,
    rootDir,
    pid: lease.pid,
    leaseId: lease.leaseId,
    message: running
      ? `Retired conflicting project worker lease for ${rootDir}.`
      : `Removed stale project worker lease for ${rootDir}.`,
  });
  return true;
}

export async function repairServiceProcessArtifacts(input: {
  registryPath: string;
  keepPids: Set<number>;
  cleanupPipeMaxAgeMs: number;
  pipeDir?: string;
}): Promise<ServiceRepairResult> {
  const diagnostics: string[] = [];
  await retireUnsupportedRegistry(input.registryPath);
  await retireMalformedRegistryProcessLeases(input.registryPath);
  let retiredServiceProcesses = 0;
  let retiredProjectRuntimes = 0;
  try {
    retiredServiceProcesses = await retireUnregisteredServicePeers(input);
  } catch (error) {
    diagnostics.push(`Service peer repair failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    retiredProjectRuntimes = await retireUnregisteredProjectRuntimePeers(input);
  } catch (error) {
    diagnostics.push(`Project runtime peer repair failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const activeEndpoints = activeRegisteredPipeEndpoints(input.registryPath);
  let removedPipeEndpoints = 0;
  try {
    removedPipeEndpoints = await cleanupLocalPipeEndpoints({
      activeEndpoints,
      maxAgeMs: input.cleanupPipeMaxAgeMs,
      pipeDir: input.pipeDir,
    });
  } catch (error) {
    diagnostics.push(`Local pipe cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { retiredServiceProcesses, retiredProjectRuntimes, removedPipeEndpoints, diagnostics };
}

export async function repairRegisteredServiceProcessArtifacts(registryPath: string): Promise<ServiceRepairResult> {
  try {
    return await repairServiceProcessArtifacts({
      registryPath,
      keepPids: serviceRegistryKeepPids(registryPath),
      cleanupPipeMaxAgeMs: LocalPipeCleanupAgeMs,
    });
  } catch (error) {
    return {
      retiredServiceProcesses: 0,
      retiredProjectRuntimes: 0,
      removedPipeEndpoints: 0,
      diagnostics: [`Process repair failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function serviceRegistryKeepPids(registryPath: string): Set<number> {
  const keep = new Set<number>([process.pid]);
  const service = readServiceEntry(registryPath);
  if (service?.pid && isProcessRunning(service.pid)) keep.add(service.pid);
  for (const entry of readRuntimeRegistry(registryPath)) {
    if (entry.pid && isProcessRunning(entry.pid)) keep.add(entry.pid);
  }
  return keep;
}

export async function retireMalformedRegistryProcessLeases(registryPath: string): Promise<void> {
  await retireRuntimeProcessLeases(runtimeProcessLeasesFromMalformedRegistryEntries(registryPath), registryPath);
  await retireServiceProcessLeases(serviceProcessLeasesFromMalformedRegistryEntry(registryPath), registryPath);
}

export async function retireRuntimeProcessLeases(leases: RuntimeProcessLease[], registryPath: string): Promise<void> {
  const seen = new Set<string>();
  for (const lease of leases) {
    const key = `${lease.rootDir}:${lease.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (lease.pid === process.pid) continue;
    if (isProcessRunning(lease.pid)) await terminateSpawnedProcess(lease.pid);
    forgetRuntimeEntryIfPid(lease.rootDir, lease.pid, registryPath);
  }
}

export async function retireServiceProcessLeases(leases: ServiceProcessLease[], registryPath: string): Promise<void> {
  const seen = new Set<number>();
  for (const lease of leases) {
    if (seen.has(lease.pid)) continue;
    seen.add(lease.pid);
    if (lease.pid === process.pid) continue;
    if (isProcessRunning(lease.pid)) await terminateSpawnedProcess(lease.pid);
    forgetServiceEntryIfPid(lease.pid, registryPath);
  }
}

export function runtimeProcessLeasesFromMalformedRegistryEntries(registryPath: string): RuntimeProcessLease[] {
  if (!existsSync(registryPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record.version !== registryVersion || !Array.isArray(record.runtimes)) return [];
  return record.runtimes
    .filter((entry) => !isRegistryEntry(entry))
    .flatMap((entry, index) => {
      const lease = runtimeProcessLeaseFromValue(entry, `registry:${registryPath}:${index}`);
      return lease ? [lease] : [];
    });
}

export async function chooseRuntimePort(input: { host: string; preferredPort?: number; usedPorts?: number[]; rangeKey?: string }): Promise<number> {
  return chooseAvailablePort({ ...input, defaultPort: defaultRuntimePort });
}

export async function chooseAvailablePort(input: { host: string; preferredPort?: number; defaultPort: number; usedPorts?: number[]; rangeKey?: string }): Promise<number> {
  if (input.preferredPort !== undefined) {
    if (!(await isPortAvailable(input.host, input.preferredPort))) throw new Error(`Port ${input.preferredPort} is not available on ${input.host}.`);
    return input.preferredPort;
  }

  const used = new Set(input.usedPorts ?? []);
  const startOffset = portSearchStartOffset(input.rangeKey);
  for (let offset = 0; offset <= maxPortOffset; offset += 1) {
    const port = input.defaultPort + ((startOffset + offset) % (maxPortOffset + 1));
    if (used.has(port)) continue;
    if (await isPortAvailable(input.host, port)) return port;
  }
  throw new Error(`No runtime port is available in ${input.defaultPort}-${input.defaultPort + maxPortOffset}.`);
}

export function portRangeKeyForRegistry(registryPath: string, key: string): string | undefined {
  return path.resolve(registryPath) === path.resolve(path.join(homedir(), ".opencanon", "service.json")) ? undefined : key;
}

export async function setupOpenCanonProject(rootDir: string): Promise<{ status: string; title: string; message: string; path?: string; details?: unknown }> {
  const absoluteRoot = path.resolve(rootDir);
  if (!directoryExists(absoluteRoot)) {
    return {
      status: "error",
      title: "Folder not found",
      message: `OpenCanon could not initialize ${absoluteRoot} because it is not an existing folder.`,
      path: absoluteRoot,
    };
  }

  const cli = runtimeCliInvocation(absoluteRoot, ["init", "--yes", "--no-runtime", "--format", "json"]);
  const output = await collectCommandOutput(cli.command, cli.args, {
    cwd: absoluteRoot,
    env: {
      ...process.env,
      OPENCANON_CLI: cli.entrypoint.path,
    },
  });
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
  const parsed = parseJsonObject(stdout);
  if (output.exitCode === 0) {
    return {
      status: "ok",
      title: "Project initialized",
      message: "OpenCanon init completed for the selected folder.",
      path: absoluteRoot,
      details: {
        exitCode: output.exitCode,
        stdout: truncateCommandOutput(stdout),
        stderr: truncateCommandOutput(stderr),
        json: parsed,
      },
    };
  }
  return {
    status: "error",
    title: "Project init failed",
    message: stderr || stdout || `OpenCanon init exited with status ${output.exitCode}.`,
    path: absoluteRoot,
    details: {
      exitCode: output.exitCode,
      stdout: truncateCommandOutput(stdout),
      stderr: truncateCommandOutput(stderr),
      json: parsed,
    },
  };
}

export function removeInactiveLocalPipeEndpoint(endpoint: string | undefined, pid: number): void {
  if (!endpoint || process.platform === PlatformName.Win32 || isProcessRunning(pid)) return;
  rmSync(endpoint, { force: true });
}

function activeRegisteredPipeEndpoints(registryPath: string): string[] {
  const registry = readRuntimeRegistryFile(registryPath);
  const endpoints: string[] = [];
  if (registry.service?.pipeEndpoint && isProcessRunning(registry.service.pid)) endpoints.push(registry.service.pipeEndpoint);
  for (const entry of registry.entries) {
    if (entry.pipeEndpoint && isProcessRunning(entry.pid)) endpoints.push(entry.pipeEndpoint);
  }
  return endpoints;
}

async function retireUnregisteredServicePeers(input: {
  registryPath: string;
  keepPids: Set<number>;
}): Promise<number> {
  let retired = 0;
  for (const peer of discoverServiceRunPeers({ registryPath: input.registryPath })) {
    if (input.keepPids.has(peer.pid)) continue;
    if (!isProcessRunning(peer.pid)) continue;
    await terminateSpawnedProcess(peer.pid);
    retired += 1;
    appendLifecycleEvent(input.registryPath, {
      kind: ProcessLifecycleEventKind.ServiceStopped,
      scope: ProcessLifecycleScope.Service,
      pid: peer.pid,
      message: `Retired unregistered OpenCanon service process from ${peer.source}.`,
    });
  }
  return retired;
}

async function retireUnregisteredProjectRuntimePeers(input: {
  registryPath: string;
  keepPids: Set<number>;
}): Promise<number> {
  let retired = 0;
  for (const peer of discoverProjectRuntimeRunPeers({ registryPath: input.registryPath })) {
    if (input.keepPids.has(peer.pid)) continue;
    if (!isProcessRunning(peer.pid)) continue;
    await terminateSpawnedProcess(peer.pid);
    retired += 1;
    appendLifecycleEvent(input.registryPath, {
      kind: ProcessLifecycleEventKind.RuntimeStopped,
      scope: ProcessLifecycleScope.Runtime,
      pid: peer.pid,
      message: `Retired unregistered OpenCanon project runtime process from ${peer.source}.`,
    });
  }
  return retired;
}

function runtimeProcessLeasesFromRegistryValue(value: unknown, registryPath: string): RuntimeProcessLease[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.runtimes)) return [];
  return record.runtimes.flatMap((entry, index) => {
    const lease = runtimeProcessLeaseFromValue(entry, `registry:${registryPath}:${index}`);
    return lease ? [lease] : [];
  });
}

function readProjectRuntimeLease(rootDir: string, registryPath = serviceRegistryPath()): RuntimeProcessLease | undefined {
  const file = projectRuntimePath(rootDir, registryPath);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (isRegistryEntry(parsed)) return undefined;
  return runtimeProcessLeaseFromValue(parsed, `project:${file}`);
}

function serviceProcessLeasesFromMalformedRegistryEntry(registryPath: string): ServiceProcessLease[] {
  if (!existsSync(registryPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record.version !== registryVersion || !Array.isArray(record.runtimes)) return [];
  if (isServiceEntry(record.service)) return [];
  const lease = serviceProcessLeaseFromValue(record.service, `service:${registryPath}`);
  return lease ? [lease] : [];
}

function serviceProcessLeasesFromRegistryValue(value: unknown, registryPath: string): ServiceProcessLease[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const lease = serviceProcessLeaseFromValue(record.service, `service:${registryPath}`);
  return lease ? [lease] : [];
}

function runtimeProcessLeaseFromValue(value: unknown, source: string): RuntimeProcessLease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.rootDir !== "string" || !record.rootDir.trim()) return undefined;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
  const rootDir = path.resolve(record.rootDir);
  if (!hasRuntimeProcessLeaseEvidence(record, rootDir)) return undefined;
  return { rootDir, pid: record.pid, source };
}

function hasRuntimeProcessLeaseEvidence(record: Record<string, unknown>, rootDir: string): boolean {
  const logPath = typeof record.logPath === "string" ? path.resolve(record.logPath) : undefined;
  const opencanonDir = path.join(rootDir, ".opencanon");
  return (
    Boolean(logPath && pathContains(opencanonDir, logPath)) ||
    (typeof record.pipeEndpoint === "string" && record.pipeEndpoint.includes("opencanon")) ||
    (typeof record.authToken === "string" && record.authToken.length > 0 && typeof record.startedAt === "string") ||
    typeof record.runtimeFingerprint === "string" ||
    typeof record.runtimeVersion === "string" ||
    typeof record.cliPath === "string" ||
    (typeof record.host === "string" && typeof record.port === "number" && typeof record.url === "string")
  );
}

function serviceProcessLeaseFromValue(value: unknown, source: string): ServiceProcessLease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
  if (!hasServiceProcessLeaseEvidence(record)) return undefined;
  return { pid: record.pid, source };
}

function hasServiceProcessLeaseEvidence(record: Record<string, unknown>): boolean {
  return (
    (typeof record.pipeEndpoint === "string" && record.pipeEndpoint.includes("opencanon")) ||
    (typeof record.authToken === "string" && record.authToken.length > 0 && typeof record.startedAt === "string") ||
    typeof record.runtimeFingerprint === "string" ||
    typeof record.runtimeVersion === "string" ||
    typeof record.cliPath === "string" ||
    (typeof record.host === "string" && typeof record.port === "number" && typeof record.url === "string") ||
    typeof record.leaseId === "string"
  );
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function portSearchStartOffset(key: string | undefined): number {
  if (!key) return 0;
  return createHash("sha256").update(key).digest().readUInt32BE(0) % (maxPortOffset + 1);
}

function collectCommandOutput(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= serviceCommandOutputLimit) return next;
  return next.slice(0, serviceCommandOutputLimit);
}

function truncateCommandOutput(value: string): string {
  if (value.length <= serviceCommandOutputLimit) return value;
  return `${value.slice(0, serviceCommandOutputLimit)}...`;
}

function parseJsonObject(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
