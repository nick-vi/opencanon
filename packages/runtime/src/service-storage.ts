import type { ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isOpenCanonProblem, writeAtomicJsonFileSync, resolveRootDir } from "@opencanon/core";
import { LocalTransportKind } from "./local-protocol.ts";
import { createProcessLeaseId } from "./service-identity.ts";
import {
  LocalControlProtocolVersion,
  ProcessLifecycleEventKind,
  ProcessLifecycleScope,
  ProcessLifecycleStatus,
  ServiceEnv,
  registryVersion,
  type ProcessLifecycleEvent,
  type ProcessLifecycleState,
  type ProcessRestartState,
  type ProjectWorkerLease,
  type ProjectWorkerLeaseHandle,
  type RegistryFile,
  type RegistryReadResult,
  type RuntimeRegistryEntry,
  type ServiceRegistryEntry,
} from "./service-types.ts";
import { isProcessRunning } from "./process-tree.ts";
import { defaultServiceRegistryPath, projectProcessStateDirectory, runtimeNamespaceForRegistry } from "./service-namespace.ts";

export { isProcessRunning } from "./process-tree.ts";

const RegistryLockStaleMs = 5000;
const RegistryLockTimeoutMs = 7000;
const StartupLockStaleMs = 30000;
const StartupLockTimeoutMs = 45000;
const ProjectWorkerLeaseHeartbeatMs = 5_000;
const ProjectWorkerLeaseStaleMs = 15_000;
const MaxLifecycleEvents = 200;

export type StartupLockMetadata = {
  pid: number;
  scope: string;
  startedAt: string;
  heartbeatAt: string;
};

export type RuntimeLifecycleTransitionResult =
  | { applied: true; entry: RuntimeRegistryEntry }
  | { applied: false; current?: RuntimeRegistryEntry };

export function serviceRegistryPath(homeDir = homedir()): string {
  if (homeDir === homedir()) {
    const configured = process.env[ServiceEnv.RegistryPath]?.trim();
    if (configured) return path.resolve(configured);
  }
  return defaultServiceRegistryPath(homeDir);
}

export function runtimeProcessStateDirectory(rootDir: string, registryPath = serviceRegistryPath()): string {
  return projectProcessStateDirectory(rootDir, runtimeNamespaceForRegistry(registryPath));
}

export function projectRuntimePath(rootDir: string, registryPath = serviceRegistryPath()): string {
  return path.join(runtimeProcessStateDirectory(rootDir, registryPath), "runtime.json");
}

export function projectWorkerLeasePath(rootDir: string, registryPath = serviceRegistryPath()): string {
  return path.join(runtimeProcessStateDirectory(rootDir, registryPath), "worker.lock");
}

export function runtimeLogPath(rootDir: string, registryPath = serviceRegistryPath()): string {
  return path.join(runtimeProcessStateDirectory(rootDir, registryPath), "runtime.log");
}

export function serviceLogPath(registryPath = serviceRegistryPath()): string {
  return path.join(path.dirname(registryPath), "service.log");
}

export function readRuntimeRegistry(registryPath = serviceRegistryPath()): RuntimeRegistryEntry[] {
  return readRuntimeRegistryFile(registryPath).entries;
}

export function readRuntimeRegistryDiagnostics(registryPath = serviceRegistryPath()): string[] {
  return readRuntimeRegistryFile(registryPath).diagnostics;
}

export function readServiceEntry(registryPath = serviceRegistryPath()): ServiceRegistryEntry | undefined {
  return readRuntimeRegistryFile(registryPath).service;
}

export function readRuntimeLifecycleEvents(registryPath = serviceRegistryPath()): ProcessLifecycleEvent[] {
  return readRuntimeRegistryFile(registryPath).events;
}

export function readRuntimeRegistryFile(registryPath = serviceRegistryPath()): RegistryReadResult {
  if (!existsSync(registryPath)) return { entries: [], events: [], diagnostics: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return { entries: [], events: [], diagnostics: [`Ignored malformed OpenCanon service registry: ${registryPath}.`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { entries: [], events: [], diagnostics: [`Ignored malformed OpenCanon service registry: ${registryPath}.`] };
  const registry = parsed as Partial<RegistryFile>;
  if (registry.version !== registryVersion || !Array.isArray(registry.runtimes)) return { entries: [], events: [], diagnostics: [`Ignored unsupported OpenCanon service registry: ${registryPath}.`] };
  const entries: RuntimeRegistryEntry[] = [];
  const diagnostics: string[] = [];
  registry.runtimes.forEach((entry, index) => {
    if (isRegistryEntry(entry)) {
      entries.push(entry);
      return;
    }
    diagnostics.push(`Ignored malformed project registry entry ${index + 1}. Run opencanon project start to recreate project runtime state for that project.`);
  });
  const service = isServiceEntry(registry.service) ? registry.service : undefined;
  const events = Array.isArray(registry.events) ? registry.events.filter(isLifecycleEvent) : [];
  if (registry.service !== undefined && !service) diagnostics.push("Ignored malformed OpenCanon service registry entry. Run opencanon service start to recreate service state.");
  return { entries, service, events, diagnostics };
}

export function writeRuntimeRegistry(entries: RuntimeRegistryEntry[], registryPath = serviceRegistryPath()): void {
  const registry = readRuntimeRegistryFile(registryPath);
  writeRuntimeRegistryFile(entries, registry.service, registryPath, registry.events);
}

export function compactRuntimeRegistry(registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    const registry = readRuntimeRegistryFile(registryPath);
    writeRuntimeRegistryFile(registry.entries, registry.service, registryPath, registry.events);
  });
}

export function writeRuntimeRegistryFile(
  entries: RuntimeRegistryEntry[],
  service: ServiceRegistryEntry | undefined,
  registryPath = serviceRegistryPath(),
  events = readRuntimeRegistryFile(registryPath).events,
): void {
  ensurePrivateDirectory(path.dirname(registryPath));
  const unique = new Map(entries.map((entry) => [entry.rootDir, entry]));
  const payload: RegistryFile = {
    version: registryVersion,
    runtimes: [...unique.values()].sort((left, right) => left.rootDir.localeCompare(right.rootDir)),
    events: events.slice(-MaxLifecycleEvents),
  };
  if (service) payload.service = service;
  writeAtomicJsonFileSync(registryPath, payload);
  chmodSync(registryPath, 0o600);
}

export function upsertRuntimeEntry(entry: RuntimeRegistryEntry, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    const registry = readRuntimeRegistryFile(registryPath);
    const entries = registry.entries.filter((item) => item.rootDir !== entry.rootDir);
    writeRuntimeRegistryFile([...entries, entry], registry.service, registryPath, registry.events);
    writeProjectRuntimeEntry(entry, registryPath);
  });
}

export function upsertServiceEntry(entry: ServiceRegistryEntry, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    writeRuntimeRegistryFile(readRuntimeRegistry(registryPath), entry, registryPath);
  });
}

export function appendLifecycleEvent(
  registryPath: string,
  event: Omit<ProcessLifecycleEvent, "id" | "at"> & { at?: string },
): ProcessLifecycleEvent {
  const next: ProcessLifecycleEvent = {
    id: createProcessLeaseId(),
    at: event.at ?? new Date().toISOString(),
    kind: event.kind,
    scope: event.scope,
    ...(event.rootDir ? { rootDir: event.rootDir } : {}),
    ...(event.pid ? { pid: event.pid } : {}),
    ...(event.leaseId ? { leaseId: event.leaseId } : {}),
    ...(event.message ? { message: event.message } : {}),
  };
  withRegistryLock(registryPath, () => {
    const registry = readRuntimeRegistryFile(registryPath);
    writeRuntimeRegistryFile(registry.entries, registry.service, registryPath, [...registry.events, next]);
  });
  return next;
}

export function setRuntimeLifecycleForLease(
  entry: RuntimeRegistryEntry,
  lifecycle: ProcessLifecycleState,
  registryPath = serviceRegistryPath(),
): RuntimeLifecycleTransitionResult {
  return transitionRuntimeLifecycle(entry, lifecycle, registryPath, false);
}

export function compareAndSetRuntimeLifecycle(
  entry: RuntimeRegistryEntry,
  lifecycle: ProcessLifecycleState,
  registryPath = serviceRegistryPath(),
): RuntimeLifecycleTransitionResult {
  return transitionRuntimeLifecycle(entry, lifecycle, registryPath, true);
}

export function withRegistryLock<T>(registryPath: string, fn: () => T): T {
  ensurePrivateDirectory(path.dirname(registryPath));
  const lockPath = `${registryPath}.lock`;
  const deadline = Date.now() + RegistryLockTimeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > RegistryLockStaleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire the OpenCanon registry lock at ${lockPath} within ${RegistryLockTimeoutMs}ms.`);
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
}

export async function withStartupLock<T>(registryPath: string, scope: string, fn: () => Promise<T>): Promise<T> {
  ensurePrivateDirectory(path.dirname(registryPath));
  const lockPath = startupLockPath(registryPath, scope);
  const fd = await acquireStartupLock(lockPath);
  const startedAt = new Date().toISOString();
  writeStartupLockMetadata(lockPath, { pid: process.pid, scope, startedAt, heartbeatAt: startedAt });
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      writeStartupLockMetadata(lockPath, { pid: process.pid, scope, startedAt, heartbeatAt: now.toISOString() });
    } catch {
      // If the lock disappears, the operation itself will still resolve or fail.
    }
  }, Math.max(1000, Math.floor(StartupLockStaleMs / 3)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

export function removeInactiveStartupLock(registryPath: string, scope: string): boolean {
  const lockPath = startupLockPath(registryPath, scope);
  if (!existsSync(lockPath)) return false;
  try {
    if (!startupLockCanBeStolen(lockPath)) return false;
  } catch {
    return false;
  }
  rmSync(lockPath, { force: true });
  return true;
}

export function startupLockScope(kind: "service" | "runtime", key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `opencanon-${kind}-${hash}`;
}

export function forgetRuntimeEntry(rootDir: string, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    const registry = readRuntimeRegistryFile(registryPath);
    writeRuntimeRegistryFile(registry.entries.filter((entry) => entry.rootDir !== rootDir), registry.service, registryPath, registry.events);
    rmSync(projectRuntimePath(rootDir, registryPath), { force: true });
  });
}

export function forgetServiceEntry(registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    writeRuntimeRegistryFile(readRuntimeRegistry(registryPath), undefined, registryPath);
  });
}

export function forgetRuntimeEntryIfPid(rootDir: string, pid: number, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    const registry = readRuntimeRegistryFile(registryPath);
    const existing = registry.entries.find((entry) => entry.rootDir === rootDir);
    if (existing?.pid !== pid) return;
    writeRuntimeRegistryFile(registry.entries.filter((entry) => entry.rootDir !== rootDir), registry.service, registryPath, registry.events);
    const projectEntry = readProjectRuntimeEntry(rootDir, registryPath);
    if (projectEntry?.pid === pid) rmSync(projectRuntimePath(rootDir, registryPath), { force: true });
  });
}

export function forgetServiceEntryIfPid(pid: number, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    const registry = readRuntimeRegistryFile(registryPath);
    if (registry.service?.pid !== pid) return;
    writeRuntimeRegistryFile(registry.entries, undefined, registryPath);
  });
}

export function forgetRuntimeEntryForPid(rootDir: string, pid: number, registryPath = serviceRegistryPath()): void {
  forgetRuntimeEntryIfPid(rootDir, pid, registryPath);
}

export function forgetServiceEntryForPid(pid: number, registryPath = serviceRegistryPath()): void {
  forgetServiceEntryIfPid(pid, registryPath);
}

export function writeProjectRuntimeEntry(entry: RuntimeRegistryEntry, registryPath = serviceRegistryPath()): void {
  const file = projectRuntimePath(entry.rootDir, registryPath);
  ensurePrivateDirectory(path.dirname(file));
  writeAtomicJsonFileSync(file, entry);
  chmodSync(file, 0o600);
}

export function readProjectRuntimeEntry(rootDir: string, registryPath = serviceRegistryPath()): RuntimeRegistryEntry | undefined {
  const file = projectRuntimePath(rootDir, registryPath);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  return isRegistryEntry(parsed) ? parsed : undefined;
}

export function readProjectWorkerLease(rootDir: string, registryPath = serviceRegistryPath()): ProjectWorkerLease | undefined {
  return readProjectWorkerLeaseFile(projectWorkerLeasePath(rootDir, registryPath));
}

export function acquireProjectWorkerLease(input: { rootDir: string; leaseId: string; registryPath?: string }): ProjectWorkerLeaseHandle {
  const rootDir = resolveRootDir(input.rootDir);
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const lockPath = projectWorkerLeasePath(rootDir, registryPath);
  ensurePrivateDirectory(path.dirname(lockPath));
  while (true) {
    const now = new Date().toISOString();
    const lease: ProjectWorkerLease = {
      rootDir,
      pid: process.pid,
      leaseId: input.leaseId,
      acquiredAt: now,
      heartbeatAt: now,
      ...(input.registryPath ? { registryPath: input.registryPath } : {}),
    };
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, JSON.stringify(lease, null, 2));
      chmodSync(lockPath, 0o600);
      const lockFd = fd;
      const heartbeat = setInterval(() => {
        try {
          const timestamp = new Date();
          utimesSync(lockPath, timestamp, timestamp);
        } catch {
          // The release path removes the lock; heartbeat loss is reported by service reconciliation.
        }
      }, ProjectWorkerLeaseHeartbeatMs);
      heartbeat.unref();
      return {
        lease,
        path: lockPath,
        release() {
          clearInterval(heartbeat);
          closeFileDescriptor(lockFd);
          releaseProjectWorkerLease(lockPath, lease);
        },
      };
    } catch (error) {
      if (fd !== undefined) closeFileDescriptor(fd);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readProjectWorkerLeaseFile(lockPath);
      if (!owner || !isProcessRunning(owner.pid)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      throw new Error(`OpenCanon project worker is already running for ${rootDir} (pid ${owner.pid}). Stop or repair the project worker before starting another one.`);
    }
  }
}

export function readProjectWorkerLeaseFile(lockPath: string): ProjectWorkerLease | undefined {
  if (!existsSync(lockPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
  return isProjectWorkerLease(parsed) ? parsed : undefined;
}

export function projectWorkerLeaseHeartbeatStale(lockPath: string, nowMs = Date.now()): boolean {
  try {
    return nowMs - statSync(lockPath).mtimeMs > ProjectWorkerLeaseStaleMs;
  } catch {
    return true;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function closeFileDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The descriptor may already be closed after a spawn failure; cleanup remains best-effort.
  }
}

export function waitForChildSpawn(child: ChildProcess, description: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      if (child.pid) resolve(child.pid);
      else reject(new Error(`${description} started without a process id.`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`${description} could not start: ${error.message}`));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function isRegistryEntry(value: unknown): value is RuntimeRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.rootDir === "string" &&
    typeof record.host === "string" &&
    typeof record.port === "number" &&
    typeof record.url === "string" &&
    typeof record.pipeEndpoint === "string" &&
    record.pipeEndpoint.length > 0 &&
    typeof record.pid === "number" &&
    typeof record.leaseId === "string" &&
    record.leaseId.length > 0 &&
    typeof record.startedAt === "string" &&
    typeof record.logPath === "string" &&
    typeof record.authToken === "string" &&
    record.authToken.length > 0 &&
    isLifecycleState(record.lifecycle) &&
    record.transport === LocalTransportKind.Pipe &&
    record.protocolVersion === LocalControlProtocolVersion &&
    typeof record.runtimeVersion === "string" &&
    typeof record.runtimeFingerprint === "string" &&
    typeof record.cliPath === "string"
  );
}

export function isServiceEntry(value: unknown): value is ServiceRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.host === "string" &&
    typeof record.port === "number" &&
    typeof record.url === "string" &&
    typeof record.pipeEndpoint === "string" &&
    record.pipeEndpoint.length > 0 &&
    typeof record.pid === "number" &&
    typeof record.leaseId === "string" &&
    record.leaseId.length > 0 &&
    typeof record.startedAt === "string" &&
    typeof record.logPath === "string" &&
    typeof record.authToken === "string" &&
    record.authToken.length > 0 &&
    isLifecycleState(record.lifecycle) &&
    record.transport === LocalTransportKind.Pipe &&
    record.protocolVersion === LocalControlProtocolVersion &&
    typeof record.runtimeVersion === "string" &&
    typeof record.runtimeFingerprint === "string" &&
    typeof record.cliPath === "string" &&
    (record.ownerPid === undefined || typeof record.ownerPid === "number")
  );
}

function releaseProjectWorkerLease(lockPath: string, lease: ProjectWorkerLease): void {
  const current = readProjectWorkerLeaseFile(lockPath);
  if (current?.pid !== lease.pid || current.leaseId !== lease.leaseId) return;
  rmSync(lockPath, { force: true });
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function transitionRuntimeLifecycle(
  expected: RuntimeRegistryEntry,
  lifecycle: ProcessLifecycleState,
  registryPath: string,
  compareLifecycle: boolean,
): RuntimeLifecycleTransitionResult {
  let result: RuntimeLifecycleTransitionResult = { applied: false };
  withRegistryLock(registryPath, () => {
    const registry = readRuntimeRegistryFile(registryPath);
    const current = registry.entries.find((entry) => entry.rootDir === expected.rootDir);
    if (!current || current.pid !== expected.pid || current.leaseId !== expected.leaseId) {
      result = { applied: false, ...(current ? { current } : {}) };
      return;
    }
    if (compareLifecycle && !isDeepStrictEqual(current.lifecycle, expected.lifecycle)) {
      result = { applied: false, current };
      return;
    }
    const next = { ...current, lifecycle };
    writeRuntimeRegistryFile(
      registry.entries.map((entry) => entry.rootDir === next.rootDir ? next : entry),
      registry.service,
      registryPath,
      registry.events,
    );
    writeProjectRuntimeEntry(next, registryPath);
    result = { applied: true, entry: next };
  });
  return result;
}

async function acquireStartupLock(lockPath: string): Promise<number> {
  const deadline = Date.now() + StartupLockTimeoutMs;
  while (true) {
    try {
      return openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (startupLockCanBeStolen(lockPath)) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire the OpenCanon startup lock at ${lockPath} within ${StartupLockTimeoutMs}ms.${startupLockOwnerSuffix(lockPath)}`);
      }
      await sleep(50);
    }
  }
}

function startupLockPath(registryPath: string, scope: string): string {
  return path.join(path.dirname(registryPath), `${scope}.start.lock`);
}

function startupLockCanBeStolen(lockPath: string): boolean {
  const metadata = readStartupLockMetadata(lockPath);
  if (metadata && !isProcessRunning(metadata.pid)) return true;
  return Date.now() - statSync(lockPath).mtimeMs > StartupLockStaleMs;
}

function startupLockOwnerSuffix(lockPath: string): string {
  const metadata = readStartupLockMetadata(lockPath);
  if (!metadata) return "";
  return ` Active owner pid ${metadata.pid}, scope ${metadata.scope}, heartbeat ${metadata.heartbeatAt}.`;
}

function writeStartupLockMetadata(lockPath: string, metadata: StartupLockMetadata): void {
  writeFileSync(lockPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const now = new Date(metadata.heartbeatAt);
  if (!Number.isNaN(now.getTime())) utimesSync(lockPath, now, now);
}

function readStartupLockMetadata(lockPath: string): StartupLockMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
  if (typeof record.scope !== "string" || typeof record.startedAt !== "string" || typeof record.heartbeatAt !== "string") return undefined;
  return {
    pid: record.pid,
    scope: record.scope,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
  };
}

function isProjectWorkerLease(value: unknown): value is ProjectWorkerLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.rootDir === "string" &&
    record.rootDir.length > 0 &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.leaseId === "string" &&
    record.leaseId.length > 0 &&
    typeof record.acquiredAt === "string" &&
    record.acquiredAt.length > 0 &&
    typeof record.heartbeatAt === "string" &&
    record.heartbeatAt.length > 0 &&
    (record.registryPath === undefined || typeof record.registryPath === "string")
  );
}

function isLifecycleState(value: unknown): value is ProcessLifecycleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === "string" &&
    Object.values(ProcessLifecycleStatus).includes(record.status as ProcessLifecycleStatus) &&
    typeof record.updatedAt === "string" &&
    (record.message === undefined || typeof record.message === "string") &&
    (record.problem === undefined || isOpenCanonProblem(record.problem)) &&
    isRestartState(record.restart)
  );
}

function isRestartState(value: unknown): value is ProcessRestartState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.attempts === "number" &&
    Number.isInteger(record.attempts) &&
    record.attempts >= 0 &&
    (record.firstFailureAt === undefined || typeof record.firstFailureAt === "string") &&
    (record.lastFailureAt === undefined || typeof record.lastFailureAt === "string") &&
    (record.nextRestartAt === undefined || typeof record.nextRestartAt === "string") &&
    (record.lastReason === undefined || typeof record.lastReason === "string")
  );
}

function isLifecycleEvent(value: unknown): value is ProcessLifecycleEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.at === "string" &&
    typeof record.kind === "string" &&
    Object.values(ProcessLifecycleEventKind).includes(record.kind as ProcessLifecycleEventKind) &&
    typeof record.scope === "string" &&
    Object.values(ProcessLifecycleScope).includes(record.scope as ProcessLifecycleScope) &&
    (record.rootDir === undefined || typeof record.rootDir === "string") &&
    (record.pid === undefined || typeof record.pid === "number") &&
    (record.leaseId === undefined || typeof record.leaseId === "string") &&
    (record.message === undefined || typeof record.message === "string")
  );
}
