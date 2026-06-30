import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server as NodeHttpServer } from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  OpenCanonProblemCode,
  OpenCanonProblemSource,
  ProjectRefreshModeValue,
  ProjectRefreshStatusValue,
  RuntimeProjectSummarySchema,
  RuntimeHealthSchema,
  RuntimeStateSchema,
  createOpenCanonDiagnostic,
  createOpenCanonDiagnosticsError,
  createOpenCanonProblem,
  createOpenCanonProblemError,
  resolveRootDir,
  serializeOpenCanonProblem,
  writeAtomicJsonFileSync,
  type OpenCanonErrorCode,
  type OpenCanonErrorPayload,
  type OpenCanonProblem,
  type RuntimeHealth,
  type RuntimeState,
} from "@opencanon/core";
import {
  ServiceActionCategory,
  ServiceActionId,
  ServiceActionScope,
  ServiceActionStatusValue,
  ServiceActionSurface,
  ServiceEffectKind,
  ServiceProjectStatusValue,
  type ServiceActionDefinition,
  type ServiceActionResult,
  type ServiceClientEffect,
  type ServiceProjectStatus,
} from "@opencanon/service-contracts";
import { assertSafeRuntimeHost, createRuntimeAuthToken, isAuthorizedRuntimeRequest, runtimeAuthHeaders, usableRuntimeAuthToken } from "./auth.ts";
import { cleanupLocalPipeEndpoints, LocalTransportKind, localPipeEndpoint, localProtocolEndpointFromEntry, localProtocolTransport, requestLocalJson, serveLocalProtocolPipe } from "./local-protocol.ts";
import { formatHttpBaseUrl } from "./runtime.ts";
import { ApiRoute, ProjectIndexResponseMode } from "./routes.ts";
import { discoverProjectRuntimeRunPeers, discoverServiceRunPeers, HiddenServiceRegistryArg } from "./service-peer-discovery.ts";

export type RuntimeRegistryEntry = {
  rootDir: string;
  host: string;
  port: number;
  url: string;
  pipeEndpoint: string;
  pid: number;
  leaseId: string;
  startedAt: string;
  logPath: string;
  authToken: string;
  lifecycle: ProcessLifecycleState;
  transport: LocalTransportKind;
  protocolVersion: number;
  runtimeVersion: string;
  runtimeFingerprint: string;
  cliPath: string;
};

export type ServiceRegistryEntry = {
  host: string;
  port: number;
  url: string;
  pipeEndpoint: string;
  pid: number;
  leaseId: string;
  startedAt: string;
  logPath: string;
  authToken: string;
  lifecycle: ProcessLifecycleState;
  transport: LocalTransportKind;
  protocolVersion: number;
  runtimeVersion: string;
  runtimeFingerprint: string;
  cliPath: string;
  ownerPid?: number;
};

// Single source of truth for runtime inspection statuses; reference members instead of inlining the strings.
export const RuntimeStatus = { Running: "running", Starting: "starting", Unhealthy: "unhealthy", Stale: "stale" } as const;
export type RuntimeStatus = (typeof RuntimeStatus)[keyof typeof RuntimeStatus];

export type ServiceRecentProject = {
  rootDir: string;
  openedAt?: string;
};

export type ServiceOverviewRequest = {
  discoveryRoots?: string[];
  recentProjects?: ServiceRecentProject[];
  currentRootDir?: string;
};

export type ServiceSummary = {
  url: string;
  status: RuntimeStatus | "unavailable";
  pipeEndpoint?: string;
  transport?: LocalTransportKind;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
  cliPath?: string;
};

export type ServiceProjectSummary = {
  id: string;
  rootDir: string;
  url: string;
  status: ServiceProjectStatus;
  pid?: number;
  port?: number;
  pipeEndpoint?: string;
  transport?: LocalTransportKind;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
  cliPath?: string;
  files?: number;
  findings?: number;
};

export type ServiceActivityItem = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail?: string;
  rootDir?: string;
};

export type ServiceOverview = {
  service: ServiceSummary;
  currentRootDir?: string;
  projects: ServiceProjectSummary[];
  activity: ServiceActivityItem[];
  actions: ServiceActionDefinition[];
  diagnostics: string[];
};

export const RuntimeCliInvocationKind = { NodeScript: "node-script", Executable: "executable" } as const;
export type RuntimeCliInvocationKind = (typeof RuntimeCliInvocationKind)[keyof typeof RuntimeCliInvocationKind];

export type RuntimeCliEntrypoint = {
  path: string;
  kind: RuntimeCliInvocationKind;
  source: string;
};

export type RuntimeInspection = {
  entry: RuntimeRegistryEntry;
  status: RuntimeStatus;
  message: string;
  health?: RuntimeHealth;
  state?: RuntimeState;
};

export type ReadyRuntimeInspection = RuntimeInspection & { status: typeof RuntimeStatus.Running };

export type StartProjectRuntimeResult = {
  status: "started" | "already-running";
  entry: RuntimeRegistryEntry;
  message: string;
};

export type StartServiceResult = {
  status: "started" | "already-running";
  entry: ServiceRegistryEntry;
  message: string;
};

export type EnsureProjectRuntimeResult = {
  service: ServiceRegistryEntry;
  project: StartProjectRuntimeResult;
};

export type StopProjectRuntimeResult = {
  status: "stopped" | "not-running" | "stale" | "unhealthy";
  rootDir: string;
  message: string;
};

export type StopServiceResult = {
  status: "stopped" | "not-running" | "stale" | "unhealthy";
  message: string;
};

export type ServiceRepairResult = {
  retiredServiceProcesses: number;
  retiredProjectRuntimes: number;
  removedPipeEndpoints: number;
  diagnostics: string[];
};

export type ServiceInspection = {
  entry: ServiceRegistryEntry;
  status: RuntimeStatus;
  message: string;
  health?: ServiceHealth;
};

export type ServiceServer = {
  url: string;
  pipeEndpoint: string;
  port: number;
  authToken: string;
  leaseId: string;
  stop(): Promise<void>;
};

export const ProcessLifecycleStatus = {
  Starting: "starting",
  Running: "running",
  BackingOff: "backing-off",
  Failed: "failed",
  Stopping: "stopping",
  Stopped: "stopped",
  Stale: "stale",
  Unhealthy: "unhealthy",
} as const;
export type ProcessLifecycleStatus = (typeof ProcessLifecycleStatus)[keyof typeof ProcessLifecycleStatus];

export const ProcessLifecycleEventKind = {
  ServiceStarted: "service-started",
  ServiceStopped: "service-stopped",
  ServiceStartupFailed: "service-startup-failed",
  RuntimeStarted: "runtime-started",
  RuntimeStopped: "runtime-stopped",
  RuntimeStartupFailed: "runtime-startup-failed",
  RuntimeUnhealthy: "runtime-unhealthy",
  RuntimeStale: "runtime-stale",
  RuntimeRestartScheduled: "runtime-restart-scheduled",
  RuntimeRestartSkipped: "runtime-restart-skipped",
} as const;
export type ProcessLifecycleEventKind = (typeof ProcessLifecycleEventKind)[keyof typeof ProcessLifecycleEventKind];

export const ProcessLifecycleScope = {
  Service: "service",
  Runtime: "runtime",
} as const;
export type ProcessLifecycleScope = (typeof ProcessLifecycleScope)[keyof typeof ProcessLifecycleScope];

export type ProcessRestartState = {
  attempts: number;
  firstFailureAt?: string;
  lastFailureAt?: string;
  nextRestartAt?: string;
  lastReason?: string;
};

export type ProcessLifecycleState = {
  status: ProcessLifecycleStatus;
  updatedAt: string;
  message?: string;
  restart: ProcessRestartState;
};

export type ProcessLifecycleEvent = {
  id: string;
  at: string;
  kind: ProcessLifecycleEventKind;
  scope: ProcessLifecycleScope;
  rootDir?: string;
  pid?: number;
  leaseId?: string;
  message?: string;
};

export type ServiceHealth = {
  status: "ready";
  protocolVersion: number;
  runtimeVersion: string;
  process: {
    kind: "service";
    pid: number;
    leaseId: string;
  };
};

export type ReconcileProjectRuntimesResult = {
  inspected: number;
  running: number;
  starting: number;
  restarted: number;
  backingOff: number;
  failed: number;
  stale: number;
  unhealthy: number;
  repair: ServiceRepairResult;
};

type RegistryFile = {
  version: 1;
  runtimes: RuntimeRegistryEntry[];
  service?: ServiceRegistryEntry;
  events: ProcessLifecycleEvent[];
};

type RegistryReadResult = {
  entries: RuntimeRegistryEntry[];
  service?: ServiceRegistryEntry;
  events: ProcessLifecycleEvent[];
  diagnostics: string[];
};

type RuntimeProcessLease = {
  rootDir: string;
  pid: number;
  source: string;
};

type ServiceProcessLease = {
  pid: number;
  source: string;
};

export type ProjectWorkerLease = {
  rootDir: string;
  pid: number;
  leaseId: string;
  acquiredAt: string;
  heartbeatAt: string;
  registryPath?: string;
};

export type ProjectWorkerLeaseHandle = {
  lease: ProjectWorkerLease;
  path: string;
  release(): void;
};

export const LocalControlProtocolVersion = 1;
const registryVersion = 1;
const defaultServicePort = 4766;
const defaultRuntimePort = 4767;
const maxPortOffset = 1000;
const AutoPortStartupAttempts = 3;
const defaultProjectRuntimeIdleTimeoutMs = 10 * 60 * 1000;
const maxServiceRequestBodyBytes = 1024 * 1024;
const discoveryRootChildLimit = 200;
const serviceCommandOutputLimit = 16_384;
const ServiceArg = {
  AllowRemote: "--allow-remote",
} as const;

const ServiceEnv = {
  AuthToken: "OPENCANON_SERVICE_TOKEN",
  LeaseId: "OPENCANON_SERVICE_LEASE_ID",
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  OwnerPid: "OPENCANON_SERVICE_OWNER_PID",
  PipeEndpoint: "OPENCANON_SERVICE_PIPE_ENDPOINT",
} as const;

const ProjectRuntimeEnv = {
  AuthToken: "OPENCANON_RUNTIME_TOKEN",
  LeaseId: "OPENCANON_RUNTIME_LEASE_ID",
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  PipeEndpoint: "OPENCANON_RUNTIME_PIPE_ENDPOINT",
} as const;

const LocalHealthWaitFailure = {
  ProcessExited: "process-exited",
  Timeout: "timeout",
} as const;
type LocalHealthWaitFailure = (typeof LocalHealthWaitFailure)[keyof typeof LocalHealthWaitFailure];
type RuntimeHealthWaitResult = { ready: true } | { ready: false; reason: LocalHealthWaitFailure };
type ServiceHealthWaitResult = { ready: true } | { ready: false; reason: LocalHealthWaitFailure };

const ServiceApiRoute = {
  ActionInvoke: "/api/actions/invoke",
  EnsureProject: "/api/projects/ensure",
  EventsStream: "/api/projects/events/stream",
  Health: "/api/health",
  Overview: "/api/overview",
  Request: "/api/projects/request",
  SetupProject: "/api/projects/setup",
  StopProject: "/api/projects/stop",
  Summary: "/api/projects/summary",
} as const;

const PlatformName = {
  Darwin: "darwin",
  Win32: "win32",
} as const;

const HiddenRegistryArg = HiddenServiceRegistryArg;
const LocalPipeCleanupAgeMs = 60_000;

type RuntimeIdentity = Pick<RuntimeRegistryEntry, "transport" | "protocolVersion" | "runtimeVersion" | "runtimeFingerprint" | "cliPath">;

export function openCanonRuntimeVersion(): string {
  const configured = nonEmptyString(process.env.OPENCANON_RUNTIME_VERSION);
  if (configured) return configured;
  const packageVersion = packageVersionFromAncestors(path.dirname(fileURLToPath(import.meta.url)));
  return packageVersion ?? "0.0.0-dev";
}

export function runtimeIdentityForEntrypoint(entrypoint: RuntimeCliEntrypoint): RuntimeIdentity {
  return {
    transport: LocalTransportKind.Pipe,
    protocolVersion: LocalControlProtocolVersion,
    runtimeVersion: openCanonRuntimeVersion(),
    runtimeFingerprint: runtimeFingerprintForEntrypoint(entrypoint),
    cliPath: entrypoint.path,
  };
}

function runtimeIdentityMatches(entry: Pick<RuntimeRegistryEntry, keyof RuntimeIdentity>, identity: RuntimeIdentity): boolean {
  return (
    entry.transport === identity.transport &&
    entry.protocolVersion === identity.protocolVersion &&
    entry.runtimeVersion === identity.runtimeVersion &&
    entry.runtimeFingerprint === identity.runtimeFingerprint &&
    entry.cliPath === identity.cliPath
  );
}

function runtimeFingerprintForEntrypoint(entrypoint: RuntimeCliEntrypoint): string {
  const hash = createHash("sha256");
  hash.update("opencanon-runtime-v1\0");
  hash.update(`${openCanonRuntimeVersion()}\0`);
  hash.update(`${entrypoint.kind}\0`);
  hash.update(`cli\0`);
  hashPathIdentity(hash, entrypoint.path);
  if (entrypoint.kind === RuntimeCliInvocationKind.NodeScript) {
    hash.update(`\0node\0`);
    hashPathIdentity(hash, nodeCommandForCliInvocation());
  }
  return `sha256:${hash.digest("hex")}`;
}

function hashPathIdentity(hash: ReturnType<typeof createHash>, entrypointPath: string): void {
  try {
    const resolved = realpathSync(entrypointPath);
    const stat = statSync(resolved);
    hash.update(`${resolved}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`);
  } catch {
    hash.update(entrypointPath);
  }
}

function ownerPidFromEnv(): number | undefined {
  const value = Number(process.env[ServiceEnv.OwnerPid]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function createProcessLeaseId(): string {
  return randomUUID();
}

function createLifecycle(status: ProcessLifecycleStatus, message?: string, restart: ProcessRestartState = { attempts: 0 }): ProcessLifecycleState {
  return {
    status,
    updatedAt: new Date().toISOString(),
    ...(message ? { message } : {}),
    restart,
  };
}

function withLifecycle<T extends { lifecycle: ProcessLifecycleState }>(entry: T, status: ProcessLifecycleStatus, message?: string, restart = entry.lifecycle.restart): T {
  return {
    ...entry,
    lifecycle: createLifecycle(status, message, restart),
  };
}

function runtimeFailureLifecycle(entry: RuntimeRegistryEntry, message: string, nowMs = Date.now()): ProcessLifecycleState {
  const previous = entry.lifecycle.restart;
  const previousFirstFailureMs = previous.firstFailureAt ? Date.parse(previous.firstFailureAt) : Number.NaN;
  const withinWindow = Number.isFinite(previousFirstFailureMs) && nowMs - previousFirstFailureMs <= RestartFailureWindowMs;
  const attempts = withinWindow ? previous.attempts + 1 : 1;
  const firstFailureAt = withinWindow && previous.firstFailureAt ? previous.firstFailureAt : new Date(nowMs).toISOString();
  const lastFailureAt = new Date(nowMs).toISOString();
  const backoffMs = attempts === 1 ? 0 : Math.min(RestartBackoffMaxMs, RestartBackoffBaseMs * 2 ** Math.max(0, attempts - 2));
  const restart: ProcessRestartState = {
    attempts,
    firstFailureAt,
    lastFailureAt,
    nextRestartAt: new Date(nowMs + backoffMs).toISOString(),
    lastReason: message,
  };
  return createLifecycle(attempts > RestartMaxAttempts ? ProcessLifecycleStatus.Failed : ProcessLifecycleStatus.BackingOff, message, restart);
}

function restartDue(lifecycle: ProcessLifecycleState, nowMs = Date.now()): boolean {
  if (lifecycle.status === ProcessLifecycleStatus.Failed) return false;
  const nextRestartAt = lifecycle.restart.nextRestartAt ? Date.parse(lifecycle.restart.nextRestartAt) : Number.NaN;
  return !Number.isFinite(nextRestartAt) || nextRestartAt <= nowMs;
}

function appendLifecycleEvent(
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

function updateRuntimeLifecycle(entry: RuntimeRegistryEntry, lifecycle: ProcessLifecycleState, registryPath = serviceRegistryPath()): RuntimeRegistryEntry {
  const next = { ...entry, lifecycle };
  upsertRuntimeEntry(next, registryPath);
  return next;
}

function packageVersionFromAncestors(startDir: string): string | undefined {
  for (const dir of ancestorPaths(startDir)) {
    const packageJsonPath = path.join(dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
      if ((parsed.name === "@opencanon/runtime" || parsed.name === "opencanon") && typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version;
      }
    } catch {
      // Ignore malformed package metadata; the runtime remains usable with a dev marker.
    }
  }
  return undefined;
}

export function serviceRegistryPath(homeDir = homedir()): string {
  if (homeDir === homedir()) {
    const configured = process.env[ServiceEnv.RegistryPath]?.trim();
    if (configured) return configured;
  }
  return path.join(homeDir, ".opencanon", "service.json");
}

export function projectRuntimePath(rootDir: string): string {
  return path.join(rootDir, ".opencanon", "runtime.json");
}

export function projectWorkerLeasePath(rootDir: string): string {
  return path.join(rootDir, ".opencanon", "worker.lock");
}

export function runtimeLogPath(rootDir: string): string {
  return path.join(rootDir, ".opencanon", "runtime.log");
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

function readRuntimeRegistryFile(registryPath = serviceRegistryPath()): RegistryReadResult {
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

async function retireUnsupportedRegistry(registryPath: string): Promise<void> {
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

export function writeRuntimeRegistry(entries: RuntimeRegistryEntry[], registryPath = serviceRegistryPath()): void {
  const registry = readRuntimeRegistryFile(registryPath);
  writeRuntimeRegistryFile(entries, registry.service, registryPath, registry.events);
}

function writeRuntimeRegistryFile(
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
    const entries = readRuntimeRegistry(registryPath).filter((item) => item.rootDir !== entry.rootDir);
    writeRuntimeRegistry([...entries, entry], registryPath);
  });
  writeProjectRuntimeEntry(entry);
}

export function upsertServiceEntry(entry: ServiceRegistryEntry, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    writeRuntimeRegistryFile(readRuntimeRegistry(registryPath), entry, registryPath);
  });
}

const RegistryLockStaleMs = 5000;
const RegistryLockTimeoutMs = 7000; // must exceed the stale threshold so a stale lock is stolen and acquired before we give up
const StartupLockStaleMs = 30000;
const StartupLockTimeoutMs = 45000;
const RuntimeStartupHealthBudgetMs = 180_000;
const RuntimeStartupHealthIntervalMs = 250;
const RuntimeStartupHealthAttempts = Math.ceil(RuntimeStartupHealthBudgetMs / RuntimeStartupHealthIntervalMs);
const ServiceStartupHealthBudgetMs = 20_000;
const ServiceStartupHealthIntervalMs = 100;
const ServiceStartupHealthAttempts = Math.ceil(ServiceStartupHealthBudgetMs / ServiceStartupHealthIntervalMs);
const LocalHealthProbeTimeoutMs = 2_000;
const ServiceReconcileIntervalMs = 30_000;
const RuntimeStartupGraceMs = RuntimeStartupHealthBudgetMs + ServiceReconcileIntervalMs;
const ProjectWorkerLeaseHeartbeatMs = 5_000;
const ProjectWorkerLeaseStaleMs = 15_000;
const MaxLifecycleEvents = 200;
const RestartFailureWindowMs = 5 * 60 * 1000;
const RestartBackoffBaseMs = 1_000;
const RestartBackoffMaxMs = 30_000;
const RestartMaxAttempts = 5;

type StartupLockMetadata = {
  pid: number;
  scope: string;
  startedAt: string;
  heartbeatAt: string;
};

/**
 * Serialize the read-modify-write of the shared service registry across processes with a
 * lockfile, so two concurrent runtime start/stop invocations can't lose an entry. The
 * individual file write is already atomic; this protects the read→filter→write sequence.
 * A stale lock (older than the stale threshold) is stolen. If acquisition still fails by
 * the deadline, we THROW rather than proceed unlocked — silently losing a registry update
 * is worse than a recoverable error. The timeout exceeds the stale threshold so a stuck
 * lock is always stolen well before the deadline.
 */
function withRegistryLock<T>(registryPath: string, fn: () => T): T {
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
        // lock vanished between open and stat — retry immediately
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

/** Synchronous sleep without busy-waiting (Atomics.wait on a throwaway buffer). */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function withStartupLock<T>(registryPath: string, scope: string, fn: () => Promise<T>): Promise<T> {
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

function removeInactiveStartupLock(registryPath: string, scope: string): boolean {
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

function startupLockScope(kind: "service" | "runtime", key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `opencanon-${kind}-${hash}`;
}

export function forgetRuntimeEntry(rootDir: string, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    writeRuntimeRegistry(readRuntimeRegistry(registryPath).filter((entry) => entry.rootDir !== rootDir), registryPath);
  });
  rmSync(projectRuntimePath(rootDir), { force: true });
}

export function forgetServiceEntry(registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    writeRuntimeRegistryFile(readRuntimeRegistry(registryPath), undefined, registryPath);
  });
}

function forgetRuntimeEntryIfPid(rootDir: string, pid: number, registryPath = serviceRegistryPath()): void {
  withRegistryLock(registryPath, () => {
    const entries = readRuntimeRegistry(registryPath);
    const existing = entries.find((entry) => entry.rootDir === rootDir);
    if (existing?.pid !== pid) return;
    writeRuntimeRegistry(entries.filter((entry) => entry.rootDir !== rootDir), registryPath);
  });
  const projectEntry = readProjectRuntimeEntry(rootDir);
  if (projectEntry?.pid === pid) rmSync(projectRuntimePath(rootDir), { force: true });
}

function forgetServiceEntryIfPid(pid: number, registryPath = serviceRegistryPath()): void {
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

export function writeProjectRuntimeEntry(entry: RuntimeRegistryEntry): void {
  const file = projectRuntimePath(entry.rootDir);
  ensurePrivateDirectory(path.dirname(file));
  writeAtomicJsonFileSync(file, entry);
  chmodSync(file, 0o600);
}

export function readProjectRuntimeEntry(rootDir: string): RuntimeRegistryEntry | undefined {
  const file = projectRuntimePath(rootDir);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  return isRegistryEntry(parsed) ? parsed : undefined;
}

export function readProjectWorkerLease(rootDir: string): ProjectWorkerLease | undefined {
  return readProjectWorkerLeaseFile(projectWorkerLeasePath(rootDir));
}

export function acquireProjectWorkerLease(input: { rootDir: string; leaseId: string; registryPath?: string }): ProjectWorkerLeaseHandle {
  const rootDir = resolveRootDir(input.rootDir);
  const lockPath = projectWorkerLeasePath(rootDir);
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
          try {
            closeSync(lockFd);
          } catch {
            // The descriptor may already be closed during process teardown.
          }
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

function releaseProjectWorkerLease(lockPath: string, lease: ProjectWorkerLease): void {
  const current = readProjectWorkerLeaseFile(lockPath);
  if (current?.pid !== lease.pid || current.leaseId !== lease.leaseId) return;
  rmSync(lockPath, { force: true });
}

function readProjectWorkerLeaseFile(lockPath: string): ProjectWorkerLease | undefined {
  if (!existsSync(lockPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
  return isProjectWorkerLease(parsed) ? parsed : undefined;
}

function projectWorkerLeaseHeartbeatStale(lockPath: string, nowMs = Date.now()): boolean {
  try {
    return nowMs - statSync(lockPath).mtimeMs > ProjectWorkerLeaseStaleMs;
  } catch {
    return true;
  }
}

export async function retireConflictingProjectWorkerLease(
  rootDir: string,
  registryPath: string,
  allowedPid?: number,
  options: { allowStaleAllowedPid?: boolean } = {},
): Promise<boolean> {
  const resolvedRoot = resolveRootDir(rootDir);
  const lockPath = projectWorkerLeasePath(resolvedRoot);
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
  forgetRuntimeEntryIfPid(resolvedRoot, lease.pid, registryPath);
  appendLifecycleEvent(registryPath, {
    kind: ProcessLifecycleEventKind.RuntimeStale,
    scope: ProcessLifecycleScope.Runtime,
    rootDir: resolvedRoot,
    pid: lease.pid,
    leaseId: lease.leaseId,
    message: running
      ? `Retired conflicting project worker lease for ${resolvedRoot}.`
      : `Removed stale project worker lease for ${resolvedRoot}.`,
  });
  return true;
}

function readProjectRuntimeLease(rootDir: string): RuntimeProcessLease | undefined {
  const file = projectRuntimePath(rootDir);
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

async function retireUnusableProjectRuntimeEntry(rootDir: string, registryPath: string): Promise<void> {
  const lease = readProjectRuntimeLease(rootDir);
  if (!lease) return;
  await retireRuntimeProcessLeases([lease], registryPath);
  const projectEntry = readProjectRuntimeEntry(rootDir);
  if (!projectEntry || projectEntry.pid === lease.pid) rmSync(projectRuntimePath(rootDir), { force: true });
}

export function discoverOpenCanonProject(cwd: string): { rootDir: string } | undefined {
  const rootDir = resolveRootDir(cwd);
  if (existsSync(path.join(rootDir, "opencanon.config.json"))) return { rootDir };
  if (existsSync(path.join(rootDir, "opencanon", "conventions", "index.ts"))) return { rootDir };
  return undefined;
}

export function discoverOpenCanonProjectsFromRoots(roots: string[]): Array<{ rootDir: string }> {
  const projects = new Map<string, { rootDir: string }>();
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    const rootPath = path.resolve(trimmed);
    if (!directoryExists(rootPath)) continue;
    addDiscoveredOpenCanonProject(projects, rootPath);
    for (const child of discoveryRootChildren(rootPath)) {
      addDiscoveredOpenCanonProject(projects, child);
    }
  }
  return [...projects.values()].sort((left, right) => left.rootDir.localeCompare(right.rootDir));
}

function addDiscoveredOpenCanonProject(projects: Map<string, { rootDir: string }>, candidate: string): void {
  if (!isOpenCanonProjectDirectory(candidate)) return;
  const rootDir = realpath(candidate);
  projects.set(rootDir, { rootDir });
}

function discoveryRootChildren(rootDir: string): string[] {
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, discoveryRootChildLimit)
      .map((entry) => path.join(rootDir, entry.name));
  } catch {
    return [];
  }
}

function isOpenCanonProjectDirectory(rootDir: string): boolean {
  return existsSync(path.join(rootDir, "opencanon.config.json")) || existsSync(path.join(rootDir, "opencanon", "conventions", "index.ts"));
}

function directoryExists(rootDir: string): boolean {
  try {
    return statSync(rootDir).isDirectory();
  } catch {
    return false;
  }
}

function realpath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export async function startProjectRuntime(input: {
  cwd: string;
  host?: string;
  port?: number;
  registryPath?: string;
  allowRemote?: boolean;
  idleTimeoutMs?: number;
  waitForReady?: boolean;
}): Promise<StartProjectRuntimeResult> {
  const rootDir = resolveRootDir(input.cwd);
  const host = input.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, input.allowRemote);
  const registryPath = input.registryPath ?? serviceRegistryPath();
  return await withStartupLock(registryPath, startupLockScope("runtime", rootDir), async () => {
  await retireUnsupportedRegistry(registryPath);
  await retireMalformedRegistryProcessLeases(registryPath);
  await retireUnusableProjectRuntimeEntry(rootDir, registryPath);
  const cli = runtimeCliInvocation(rootDir, ["project", "start", "--foreground", "--host", host, "--port", String(input.port ?? defaultRuntimePort)]);
  const runtimeIdentity = runtimeIdentityForEntrypoint(cli.entrypoint);
  const existing = await inspectProjectRuntime(rootDir, registryPath);
  await retireConflictingProjectWorkerLease(rootDir, registryPath, existing?.entry.pid, {
    allowStaleAllowedPid: existing ? runtimeStartupStillWithinGrace(existing.entry, Date.now()) : false,
  });
  if (existing && !runtimeIdentityMatches(existing.entry, runtimeIdentity)) {
    await stopProjectRuntime(rootDir, registryPath);
  } else if (existing?.status === RuntimeStatus.Starting) {
    if (input.waitForReady === false) {
      return {
        status: "already-running",
        entry: existing.entry,
        message: `OpenCanon project runtime is still starting for ${rootDir}.`,
      };
    }
    const ready = await waitForRuntimeHealth(existing.entry);
    if (ready) {
      const runningEntry = updateRuntimeLifecycle(existing.entry, createLifecycle(ProcessLifecycleStatus.Running, "Runtime health endpoint is ready."), registryPath);
      return {
        status: "already-running",
        entry: runningEntry,
        message: `OpenCanon project runtime already registered for ${rootDir}.`,
      };
    }
    await stopProjectRuntime(rootDir, registryPath);
  } else if (existing?.status === RuntimeStatus.Unhealthy) {
    await stopProjectRuntime(rootDir, registryPath);
  } else if (existing?.status === RuntimeStatus.Running) {
    return {
      status: "already-running",
      entry: existing.entry,
      message: `OpenCanon project runtime already registered for ${rootDir}.`,
    };
  }
  if (existing?.status === RuntimeStatus.Stale) forgetRuntimeEntry(rootDir, registryPath);
  await retireConflictingProjectWorkerLease(rootDir, registryPath);

  const attemptedPorts: number[] = [];
  const startupAttempts = input.port === undefined && input.waitForReady !== false ? AutoPortStartupAttempts : 1;
  let lastStartupError: Error | undefined;
  for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
    const port = await chooseRuntimePort({
      host,
      preferredPort: input.port,
      usedPorts: [...readRuntimeRegistry(registryPath).map((entry) => entry.port), ...attemptedPorts],
      rangeKey: portRangeKeyForRegistry(registryPath, rootDir),
    });
    attemptedPorts.push(port);
    const logPath = runtimeLogPath(rootDir);
    const authToken = createRuntimeAuthToken();
    const leaseId = createProcessLeaseId();
    const pipeEndpoint = localPipeEndpoint({ scope: "runtime", key: `${registryPath}:${rootDir}` });
    ensurePrivateDirectory(path.dirname(logPath));
    const logFd = openSync(logPath, "a", 0o600);
    chmodSync(logPath, 0o600);
    const cliArgs = [...cli.args];
    cliArgs.splice(cliArgs.indexOf("--port") + 1, 1, String(port));
    const idleTimeoutMs = input.idleTimeoutMs ?? defaultProjectRuntimeIdleTimeoutMs;
    if (idleTimeoutMs > 0) cliArgs.push("--idle-timeout-ms", String(idleTimeoutMs));
    if (input.allowRemote) cliArgs.push(ServiceArg.AllowRemote);
    cliArgs.push(HiddenRegistryArg, registryPath);
    const child = spawn(cli.command, cliArgs, {
      cwd: rootDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        OPENCANON_CLI: cli.entrypoint.path,
        [ProjectRuntimeEnv.AuthToken]: authToken,
        [ProjectRuntimeEnv.LeaseId]: leaseId,
        [ProjectRuntimeEnv.RegistryPath]: registryPath,
        [ProjectRuntimeEnv.PipeEndpoint]: pipeEndpoint,
      },
    });
    let childPid: number;
    try {
      childPid = await waitForChildSpawn(child, "OpenCanon project runtime");
      child.unref();
    } catch (error) {
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeStartupFailed,
        scope: ProcessLifecycleScope.Runtime,
        rootDir,
        leaseId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      closeFileDescriptor(logFd);
    }

    const entry: RuntimeRegistryEntry = {
      rootDir,
      host,
      port,
      url: formatHttpBaseUrl(host, port),
      pipeEndpoint,
      pid: childPid,
      leaseId,
      startedAt: new Date().toISOString(),
      logPath,
      authToken,
      lifecycle: createLifecycle(ProcessLifecycleStatus.Starting, "Waiting for runtime health endpoint."),
      ...runtimeIdentity,
    };
    upsertRuntimeEntry(entry, registryPath);
    appendLifecycleEvent(registryPath, {
      kind: ProcessLifecycleEventKind.RuntimeStarted,
      scope: ProcessLifecycleScope.Runtime,
      rootDir,
      pid: childPid,
      leaseId,
      message: "OpenCanon project runtime process spawned.",
    });

    if (input.waitForReady === false) {
      return {
        status: "started",
        entry,
        message: `OpenCanon project runtime started for ${rootDir}.`,
      };
    }

    const health = await waitForRuntimeHealthResult(entry);
    if (health.ready) {
      const runningEntry = updateRuntimeLifecycle(entry, createLifecycle(ProcessLifecycleStatus.Running, "Runtime health endpoint is ready."), registryPath);
      return {
        status: "started",
        entry: runningEntry,
        message: `OpenCanon project runtime started for ${rootDir}.`,
      };
    }

    forgetRuntimeEntryIfPid(rootDir, childPid, registryPath);
    await terminateSpawnedProcess(childPid);
    lastStartupError = new Error(`OpenCanon runtime did not become ready. See ${logPath}.`);
    appendLifecycleEvent(registryPath, {
      kind: ProcessLifecycleEventKind.RuntimeStartupFailed,
      scope: ProcessLifecycleScope.Runtime,
      rootDir,
      pid: childPid,
      leaseId,
      message: lastStartupError.message,
    });
    if (health.reason !== LocalHealthWaitFailure.ProcessExited || attempt === startupAttempts - 1) {
      throw lastStartupError;
    }
  }
  throw lastStartupError ?? new Error("OpenCanon runtime did not become ready.");
  });
}

export async function startService(input: {
  cwd: string;
  host?: string;
  port?: number;
  registryPath?: string;
  allowRemote?: boolean;
}): Promise<StartServiceResult> {
  const rootDir = resolveRootDir(input.cwd);
  const host = input.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, input.allowRemote);
  const registryPath = input.registryPath ?? serviceRegistryPath();
  return await withStartupLock(registryPath, startupLockScope("service", registryPath), async () => {
  await retireUnsupportedRegistry(registryPath);
  await retireMalformedRegistryProcessLeases(registryPath);
  const cli = runtimeCliInvocation(rootDir, ["service", "run", "--host", host, "--port", String(input.port ?? defaultServicePort)]);
  const runtimeIdentity = runtimeIdentityForEntrypoint(cli.entrypoint);
  await repairServiceProcessArtifacts({
    registryPath,
    entrypoint: cli.entrypoint,
    keepPids: serviceRegistryKeepPids(registryPath),
    cleanupPipeMaxAgeMs: LocalPipeCleanupAgeMs,
  });
  const existing = await inspectService(registryPath);
  if (existing?.status === RuntimeStatus.Running && runtimeIdentityMatches(existing.entry, runtimeIdentity)) {
    return {
      status: "already-running",
      entry: existing.entry,
      message: "OpenCanon service is already running.",
    };
  }
  if (existing?.status === RuntimeStatus.Running) await stopService(registryPath);
  if (existing?.status === RuntimeStatus.Unhealthy) await stopService(registryPath);
  if (existing?.status === RuntimeStatus.Stale) forgetServiceEntry(registryPath);

  const attemptedPorts: number[] = [];
  const startupAttempts = input.port === undefined ? AutoPortStartupAttempts : 1;
  let lastStartupError: Error | undefined;
  for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
    const port = await chooseAvailablePort({
      host,
      preferredPort: input.port,
      defaultPort: defaultServicePort,
      usedPorts: [...readRuntimeRegistry(registryPath).map((entry) => entry.port), ...attemptedPorts],
      rangeKey: portRangeKeyForRegistry(registryPath, registryPath),
    });
    attemptedPorts.push(port);
    const logPath = serviceLogPath(registryPath);
    const authToken = createRuntimeAuthToken();
    const leaseId = createProcessLeaseId();
    const pipeEndpoint = localPipeEndpoint({ scope: "service", key: registryPath });
    ensurePrivateDirectory(path.dirname(logPath));
    const logFd = openSync(logPath, "a", 0o600);
    chmodSync(logPath, 0o600);
    const cliArgs = [...cli.args];
    cliArgs.splice(cliArgs.indexOf("--port") + 1, 1, String(port));
    cliArgs.push(HiddenRegistryArg, registryPath);
    if (input.allowRemote) cliArgs.push(ServiceArg.AllowRemote);
    const child = spawn(cli.command, cliArgs, {
      cwd: rootDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        OPENCANON_CLI: cli.entrypoint.path,
        [ServiceEnv.AuthToken]: authToken,
        [ServiceEnv.LeaseId]: leaseId,
        [ServiceEnv.RegistryPath]: registryPath,
        [ServiceEnv.PipeEndpoint]: pipeEndpoint,
      },
    });
    let childPid: number;
    try {
      childPid = await waitForChildSpawn(child, "OpenCanon service");
      child.unref();
    } catch (error) {
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.ServiceStartupFailed,
        scope: ProcessLifecycleScope.Service,
        leaseId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      closeFileDescriptor(logFd);
    }

    const entry: ServiceRegistryEntry = {
      host,
      port,
      url: formatHttpBaseUrl(host, port),
      pipeEndpoint,
      pid: childPid,
      leaseId,
      startedAt: new Date().toISOString(),
      logPath,
      authToken,
      lifecycle: createLifecycle(ProcessLifecycleStatus.Starting, "Waiting for service health endpoint."),
      ...runtimeIdentity,
      ownerPid: ownerPidFromEnv(),
    };
    upsertServiceEntry(entry, registryPath);
    appendLifecycleEvent(registryPath, {
      kind: ProcessLifecycleEventKind.ServiceStarted,
      scope: ProcessLifecycleScope.Service,
      pid: childPid,
      leaseId,
      message: "OpenCanon service process spawned.",
    });

    const health = await waitForServiceHealthResult(entry);
    if (health.ready) {
      const runningEntry = withLifecycle(entry, ProcessLifecycleStatus.Running, "OpenCanon service health endpoint is ready.");
      upsertServiceEntry(runningEntry, registryPath);
      return {
        status: "started",
        entry: runningEntry,
        message: "OpenCanon service started.",
      };
    }

    forgetServiceEntryIfPid(childPid, registryPath);
    await terminateSpawnedProcess(childPid);
    lastStartupError = new Error(`OpenCanon service did not become ready. See ${logPath}.`);
    appendLifecycleEvent(registryPath, {
      kind: ProcessLifecycleEventKind.ServiceStartupFailed,
      scope: ProcessLifecycleScope.Service,
      pid: childPid,
      leaseId,
      message: lastStartupError.message,
    });
    if (health.reason !== LocalHealthWaitFailure.ProcessExited || attempt === startupAttempts - 1) {
      throw lastStartupError;
    }
  }
  throw lastStartupError ?? new Error("OpenCanon service did not become ready.");
  });
}

export async function ensureProjectRuntimeViaService(input: {
  cwd: string;
  host?: string;
  port?: number;
  registryPath?: string;
  allowRemote?: boolean;
  idleTimeoutMs?: number;
  waitForReady?: boolean;
}): Promise<EnsureProjectRuntimeResult> {
  const project = discoverOpenCanonProject(input.cwd);
  if (!project) {
    throw new Error(
      serializeOpenCanonProblem(
        projectNotFoundProblem({
          rootDir: path.resolve(input.cwd),
          status: 400,
        }),
      ),
    );
  }
  const registryPath = input.registryPath ?? serviceRegistryPath();
  let service = await startService({
    cwd: project.rootDir,
    registryPath,
  });
  const requestEnsureProject = async () => await requestLocalJson<{ project: StartProjectRuntimeResult }>(
    localProtocolEndpointFromEntry(service.entry),
    {
      method: "POST",
      path: ServiceApiRoute.EnsureProject,
      body: {
        rootDir: project.rootDir,
        host: input.host,
        port: input.port,
        allowRemote: input.allowRemote,
        idleTimeoutMs: input.idleTimeoutMs,
        waitForReady: input.waitForReady ?? false,
      },
    },
  );
  let payload: { project: StartProjectRuntimeResult };
  try {
    payload = await requestEnsureProject();
  } catch (error) {
    if (!isLocalProtocolTransportFailure(error)) throw error;
    await stopService(registryPath).catch(() => undefined);
    service = await startService({ cwd: project.rootDir, registryPath });
    try {
      payload = await requestEnsureProject();
    } catch (retryError) {
      throw new Error(`OpenCanon service request failed after repairing the service: ${errorMessage(retryError)}. Initial failure: ${errorMessage(error)}`);
    }
  }
  return { service: service.entry, project: payload.project };
}

export async function buildServiceOverview(input: ServiceOverviewRequest & { registryPath?: string } = {}): Promise<ServiceOverview> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const currentRootDir = canonicalOverviewRootDir(input.currentRootDir);
  const diagnostics = [...readRuntimeRegistryDiagnostics(registryPath)];
  try {
    await reconcileProjectRuntimes({ registryPath });
  } catch (error) {
    diagnostics.push(`Project runtime reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const projects: ServiceProjectSummary[] = [];
  const seen = new Set<string>();
  const pushProject = (project: ServiceProjectSummary) => {
    if (seen.has(project.rootDir)) return;
    seen.add(project.rootDir);
    projects.push(project);
  };

  const service = await inspectService(registryPath);
  for (const inspection of await inspectAllRuntimes(registryPath)) {
    pushProject(serviceProjectSummaryFromInspection(inspection, currentRootDir));
  }
  for (const project of discoverOpenCanonProjectsFromRoots(input.discoveryRoots ?? [])) {
    pushProject(serviceProjectSummaryFromRoot(project.rootDir, ServiceProjectStatusValue.Discovered, currentRootDir));
  }
  for (const project of input.recentProjects ?? []) {
    const rootDir = canonicalOverviewRootDir(project.rootDir) ?? path.resolve(project.rootDir);
    pushProject(serviceProjectSummaryFromRoot(rootDir, isOpenCanonProjectDirectory(rootDir) ? ServiceProjectStatusValue.Recent : ServiceProjectStatusValue.Stale, currentRootDir));
  }

  projects.sort((left, right) => projectStatusRank(left.status) - projectStatusRank(right.status) || left.rootDir.localeCompare(right.rootDir));
  return {
    service: service ? serviceSummaryFromInspection(service) : unavailableServiceSummary(registryPath),
    ...(currentRootDir ? { currentRootDir } : {}),
    projects,
    activity: readRuntimeLifecycleEvents(registryPath).slice(-10).reverse().map(serviceActivityItemFromLifecycleEvent),
    actions: serviceActionDefinitions(Boolean(currentRootDir)),
    diagnostics,
  };
}

export async function invokeServiceAction(input: { id: string; rootDir?: string; registryPath?: string }): Promise<ServiceActionResult> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const rootDir = canonicalOverviewRootDir(input.rootDir);
  switch (input.id) {
    case ServiceActionId.OpenProject:
      return serviceActionOk("Open project", "Choose an OpenCanon project folder.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.PickFolder }]);
    case ServiceActionId.SwitchProject:
      return serviceActionOk("Switch project", "Open the project switcher.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.Navigate, view: "command-palette" }]);
    case ServiceActionId.Settings:
      return serviceActionOk("Settings", "Open OpenCanon settings.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.Navigate, view: "settings" }]);
    case ServiceActionId.QuitClient:
      return serviceActionOk("Quit OpenCanon", "Quit the OpenCanon client.", [{ kind: ServiceEffectKind.QuitClient }]);
    case ServiceActionId.CheckUpdates:
      return serviceActionOk("Check updates", "Check runtime updates.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.CheckUpdates }]);
    case ServiceActionId.ExportDiagnostics:
      return serviceActionOk("Export diagnostics", "Write a local diagnostics report.", [{ kind: ServiceEffectKind.ShowClient }, { kind: ServiceEffectKind.ExportDiagnostics, ...(rootDir ? { rootDir } : {}) }]);
    case ServiceActionId.OpenLogs:
      return openLogsActionResult(rootDir, registryPath);
    case ServiceActionId.ProjectSelect:
      if (!rootDir) return serviceActionWarning("Project required", "Select a project before running this action.");
      return serviceActionOk("Select project", `Open ${path.basename(rootDir)}.`, [{ kind: ServiceEffectKind.SelectProject, rootDir }, { kind: ServiceEffectKind.ShowClient }]);
    case ServiceActionId.ProjectReindex:
      if (!rootDir) return serviceActionWarning("Project required", "Open a project before reindexing.");
      return invokeProjectRuntimeAction(rootDir, registryPath, ApiRoute.Index, "POST", "Project reindexed", "Refreshed project knowledge.", {
        response: ProjectIndexResponseMode.SemanticIndex,
      });
    case ServiceActionId.ProjectDoctor:
      if (!rootDir) return serviceActionWarning("Project required", "Open a project before running Doctor.");
      return invokeProjectRuntimeAction(rootDir, registryPath, `${ApiRoute.Doctor}?warm=1`, "GET", "Doctor completed", "Refreshed project health.");
    default:
      return {
        status: ServiceActionStatusValue.Error,
        title: "Unknown action",
        message: `Unknown OpenCanon action: ${input.id}.`,
      };
  }
}

function serviceSummaryFromInspection(inspection: ServiceInspection): ServiceSummary {
  return {
    url: inspection.entry.url,
    status: inspection.status,
    pipeEndpoint: inspection.entry.pipeEndpoint,
    transport: inspection.entry.transport,
    protocolVersion: inspection.entry.protocolVersion,
    runtimeVersion: inspection.entry.runtimeVersion,
    runtimeFingerprint: inspection.entry.runtimeFingerprint,
    cliPath: inspection.entry.cliPath,
  };
}

function unavailableServiceSummary(registryPath: string): ServiceSummary {
  return {
    url: formatHttpBaseUrl("127.0.0.1", defaultServicePort),
    status: "unavailable",
    pipeEndpoint: localPipeEndpoint({ scope: "service", key: registryPath }),
  };
}

function serviceProjectSummaryFromInspection(inspection: RuntimeInspection, currentRootDir: string | undefined): ServiceProjectSummary {
  const rootDir = canonicalOverviewRootDir(inspection.entry.rootDir) ?? inspection.entry.rootDir;
  return {
    id: rootDir,
    rootDir,
    url: inspection.entry.url,
    status: currentRootDir === rootDir ? ServiceProjectStatusValue.Current : inspection.status,
    pid: inspection.entry.pid,
    port: inspection.entry.port,
    pipeEndpoint: inspection.entry.pipeEndpoint,
    transport: inspection.entry.transport,
    protocolVersion: inspection.entry.protocolVersion,
    runtimeVersion: inspection.entry.runtimeVersion,
    runtimeFingerprint: inspection.entry.runtimeFingerprint,
    cliPath: inspection.entry.cliPath,
    files: inspection.state?.files,
    findings: inspection.state?.findings,
  };
}

function serviceProjectSummaryFromRoot(rootDir: string, status: ServiceProjectStatus, currentRootDir: string | undefined): ServiceProjectSummary {
  return {
    id: rootDir,
    rootDir,
    url: "",
    status: currentRootDir === rootDir ? ServiceProjectStatusValue.Current : status,
  };
}

function canonicalOverviewRootDir(rootDir: string | undefined): string | undefined {
  const trimmed = rootDir?.trim();
  if (!trimmed) return undefined;
  return realpath(path.resolve(trimmed));
}

function projectStatusRank(status: ServiceProjectStatus): number {
  if (status === ServiceProjectStatusValue.Current) return 0;
  if (status === ServiceProjectStatusValue.Running) return 1;
  if (status === ServiceProjectStatusValue.Starting) return 2;
  if (status === ServiceProjectStatusValue.Discovered) return 3;
  if (status === ServiceProjectStatusValue.Recent) return 4;
  if (status === ServiceProjectStatusValue.Unhealthy) return 5;
  return 6;
}

function serviceActivityItemFromLifecycleEvent(event: ProcessLifecycleEvent): ServiceActivityItem {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    title: lifecycleEventTitle(event),
    ...(event.message ? { detail: event.message } : {}),
    ...(event.rootDir ? { rootDir: event.rootDir } : {}),
  };
}

function lifecycleEventTitle(event: ProcessLifecycleEvent): string {
  const target = event.scope === ProcessLifecycleScope.Service ? "Service" : "Project runtime";
  return `${target} ${event.kind.replace(/-/g, " ")}`;
}

function serviceActionDefinitions(hasCurrentProject: boolean): ServiceActionDefinition[] {
  const projectDisabledReason = hasCurrentProject ? undefined : "Open a project first.";
  return [
    serviceActionDefinition(ServiceActionId.OpenProject, "Open Project...", ServiceActionCategory.Navigation, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.Dashboard, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.SwitchProject, "Switch Project...", ServiceActionCategory.Navigation, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.Settings, "Settings", ServiceActionCategory.Service, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.ProjectSelect, "Select Project", ServiceActionCategory.Project, ServiceActionScope.Project, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.ProjectReindex, "Reindex Project", ServiceActionCategory.Project, ServiceActionScope.Project, hasCurrentProject, [ServiceActionSurface.CommandPalette, ServiceActionSurface.Dashboard, ServiceActionSurface.StatusMenu], projectDisabledReason),
    serviceActionDefinition(ServiceActionId.ProjectDoctor, "Run Doctor", ServiceActionCategory.Diagnostics, ServiceActionScope.Project, hasCurrentProject, [ServiceActionSurface.CommandPalette, ServiceActionSurface.Dashboard, ServiceActionSurface.StatusMenu], projectDisabledReason),
    serviceActionDefinition(ServiceActionId.OpenLogs, "Open Logs", ServiceActionCategory.Diagnostics, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette, ServiceActionSurface.StatusMenu]),
    serviceActionDefinition(ServiceActionId.ExportDiagnostics, "Export Diagnostics", ServiceActionCategory.Diagnostics, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette]),
    serviceActionDefinition(ServiceActionId.CheckUpdates, "Check Updates", ServiceActionCategory.Service, ServiceActionScope.Service, true, [ServiceActionSurface.CommandPalette]),
    serviceActionDefinition(ServiceActionId.QuitClient, "Quit OpenCanon", ServiceActionCategory.Service, ServiceActionScope.Service, true, [ServiceActionSurface.StatusMenu]),
  ];
}

function serviceActionDefinition(
  id: ServiceActionId,
  label: string,
  category: ServiceActionCategory,
  scope: ServiceActionScope,
  enabled: boolean,
  surfaces: ServiceActionSurface[],
  disabledReason?: string,
): ServiceActionDefinition {
  return {
    id,
    label,
    category,
    scope,
    enabled,
    ...(disabledReason && !enabled ? { disabledReason } : {}),
    surfaces,
  };
}

function serviceActionOk(title: string, message: string, effects?: ServiceClientEffect[]): ServiceActionResult {
  return {
    status: ServiceActionStatusValue.Ok,
    title,
    message,
    ...(effects?.length ? { effects } : {}),
  };
}

function serviceActionWarning(title: string, message: string): ServiceActionResult {
  return {
    status: ServiceActionStatusValue.Warning,
    title,
    message,
  };
}

function openLogsActionResult(rootDir: string | undefined, registryPath: string): ServiceActionResult {
  const logPath = firstExistingLogPath(rootDir, registryPath);
  if (!logPath) {
    return serviceActionWarning("No logs yet", "OpenCanon has not written local logs for this project or service yet.");
  }
  return {
    status: ServiceActionStatusValue.Ok,
    title: "Opened logs",
    message: `Open ${logPath}.`,
    path: logPath,
    effects: [{ kind: ServiceEffectKind.RevealPath, path: logPath }],
  };
}

function firstExistingLogPath(rootDir: string | undefined, registryPath: string): string | undefined {
  const candidates: string[] = [];
  if (rootDir) {
    candidates.push(runtimeLogPath(rootDir));
    candidates.push(...readRuntimeRegistry(registryPath).filter((entry) => entry.rootDir === rootDir).map((entry) => entry.logPath));
  } else {
    candidates.push(serviceLogPath(registryPath));
    candidates.push(...readRuntimeRegistry(registryPath).map((entry) => entry.logPath));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

async function invokeProjectRuntimeAction(
  rootDir: string,
  registryPath: string,
  route: string,
  method: "GET" | "POST",
  title: string,
  message: string,
  body?: Record<string, unknown>,
): Promise<ServiceActionResult> {
  const project = discoverOpenCanonProject(rootDir);
  if (!project) {
    return {
      status: ServiceActionStatusValue.Error,
      title: "OpenCanon project not found",
      message: `No OpenCanon project was discovered for ${rootDir}.`,
    };
  }
  try {
    const started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
    const details = await requestLocalJson<unknown>(localProtocolEndpointFromEntry(started.entry), { method, path: route, body: method === "POST" ? body ?? {} : undefined });
    return {
      status: ServiceActionStatusValue.Ok,
      title,
      message,
      details,
    };
  } catch (error) {
    return {
      status: ServiceActionStatusValue.Error,
      title: `${title} failed`,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startServiceServer(options: {
  host?: string;
  port?: number;
  registryPath?: string;
  authToken?: string;
  leaseId?: string;
  allowRemote?: boolean;
  reconcileIntervalMs?: number | false;
} = {}): Promise<ServiceServer> {
  const host = options.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, options.allowRemote);
  const authToken = usableRuntimeAuthToken(options.authToken) ?? usableRuntimeAuthToken(process.env[ServiceEnv.AuthToken]) ?? createRuntimeAuthToken();
  const registryPath = options.registryPath ?? process.env[ServiceEnv.RegistryPath] ?? serviceRegistryPath();
  const pipeEndpoint = process.env[ServiceEnv.PipeEndpoint] ?? localPipeEndpoint({ scope: "service", key: registryPath });
  const leaseId = options.leaseId?.trim() || process.env[ServiceEnv.LeaseId]?.trim() || createProcessLeaseId();
  const serviceHealth: ServiceHealth = {
    status: "ready",
    protocolVersion: LocalControlProtocolVersion,
    runtimeVersion: openCanonRuntimeVersion(),
    process: {
      kind: "service",
      pid: process.pid,
      leaseId,
    },
  };
  const routeRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("OpenCanon local service exposes /api/* only.", { status: 404 });
    }

    if (!isAuthorizedRuntimeRequest(request, url, authToken)) {
      return serviceJson(
        serviceProblem(
          createOpenCanonProblem({
            code: OpenCanonProblemCode.Unauthorized,
            title: "OpenCanon service request is unauthorized",
            detail: "OpenCanon service request is unauthorized.",
            source: OpenCanonProblemSource.Service,
            retryable: false,
            status: 401,
          }),
        ),
        401,
      );
    }

    if (url.pathname === ServiceApiRoute.Health) {
      return serviceJson({ ok: true, data: serviceHealth });
    }

    if (url.pathname === ServiceApiRoute.Overview && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      return serviceJson({
        ok: true,
        data: await buildServiceOverview({
          discoveryRoots: stringArrayBodyValue(body.body.discoveryRoots),
          recentProjects: recentProjectsBodyValue(body.body.recentProjects),
          currentRootDir: stringBodyValue(body.body.currentRootDir),
          registryPath,
        }),
      });
    }

    if (url.pathname === ServiceApiRoute.ActionInvoke && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const id = stringBodyValue(body.body.id);
      if (!id) return serviceJson(serviceDiagnostic("service-malformed-request", "id is required."), 400);
      return serviceJson({
        ok: true,
        data: await invokeServiceAction({
          id,
          rootDir: stringBodyValue(body.body.rootDir),
          registryPath,
        }),
      });
    }

    if (url.pathname === ServiceApiRoute.SetupProject && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      if (!rootDir) return serviceJson(serviceDiagnostic("service-malformed-request", "rootDir is required."), 400);
      return serviceJson({ ok: true, data: await setupOpenCanonProject(rootDir) });
    }

    if (url.pathname === ServiceApiRoute.EnsureProject && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      const project = rootDir ? discoverOpenCanonProject(rootDir) : undefined;
      if (!project) {
        return serviceJson(
          serviceProblem(
            projectNotFoundProblem({
              rootDir: rootDir || undefined,
              status: 400,
            }),
          ),
          400,
        );
      }
      const port = optionalPortBodyValue(body.body.port);
      if (!port.ok) return serviceJson(serviceDiagnostic("service-malformed-request", "port must be an integer from 1 to 65535."), 400);
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({
          cwd: project.rootDir,
          host: stringBodyValue(body.body.host),
          port: port.value,
          registryPath,
          allowRemote: booleanBodyValue(body.body.allowRemote),
          idleTimeoutMs: numberBodyValue(body.body.idleTimeoutMs),
          waitForReady: booleanBodyValue(body.body.waitForReady) ?? false,
        });
      } catch (error) {
        return serviceJson(
          serviceProblem(runtimeUnavailableProblem(project.rootDir, error)),
          500,
        );
      }
      return serviceJson({ ok: true, data: { project: started } });
    }

    if (url.pathname === ServiceApiRoute.Request && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      const apiPath = stringBodyValue(body.body.path);
      if (!rootDir) return serviceJson(serviceDiagnostic("service-malformed-request", "rootDir is required."), 400);
      if (!apiPath?.startsWith("/api/")) return serviceJson(serviceDiagnostic("service-malformed-request", "path must be a project API path."), 400);
      const project = discoverOpenCanonProject(rootDir);
      if (!project) {
        return serviceJson(serviceProblem(projectNotFoundProblem({ rootDir, status: 400 })), 400);
      }
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
      } catch (error) {
        return serviceJson(serviceProblem(runtimeUnavailableProblem(project.rootDir, error)), 500);
      }
      const proxied = await localProtocolTransport.request(localProtocolEndpointFromEntry(started.entry), {
        method: serviceRequestMethod(body.body.method),
        path: apiPath,
        headers: stringRecordBodyValue(body.body.headers),
        body: body.body.body,
      });
      return serviceJson({ ok: true, data: { status: proxied.status, body: proxied.body } });
    }

    if (url.pathname === ServiceApiRoute.EventsStream && request.method === "GET") {
      const rootDir = url.searchParams.get("rootDir")?.trim() ?? "";
      const project = rootDir ? discoverOpenCanonProject(rootDir) : undefined;
      if (!project) {
        return serviceJson(serviceProblem(projectNotFoundProblem({ rootDir: rootDir || undefined, status: 400 })), 400);
      }
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
      } catch (error) {
        return serviceJson(serviceProblem(runtimeUnavailableProblem(project.rootDir, error)), 500);
      }
      return proxyRuntimeEventStream(started.entry);
    }

    if (url.pathname === ServiceApiRoute.Summary && request.method === "GET") {
      const rootDir = url.searchParams.get("rootDir")?.trim() ?? "";
      const project = rootDir ? discoverOpenCanonProject(rootDir) : undefined;
      if (!project) {
        return serviceJson(serviceProblem(projectNotFoundProblem({ rootDir: rootDir || undefined, status: 400 })), 400);
      }
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
      } catch (error) {
        return serviceJson(serviceProblem(runtimeUnavailableProblem(project.rootDir, error)), 500);
      }
      const summaryPayload = await requestLocalJson<unknown>(localProtocolEndpointFromEntry(started.entry), {
        method: "GET",
        path: ApiRoute.ProjectSummary,
      });
      const summary = RuntimeProjectSummarySchema.safeParse(summaryPayload);
      if (!summary.success) return serviceJson(serviceDiagnostic("invalid-runtime-response", "Project runtime returned an invalid summary payload."), 502);
      return serviceJson({ ok: true, data: summary.data });
    }

    if (url.pathname === ServiceApiRoute.StopProject && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      if (!rootDir) return serviceJson(serviceDiagnostic("service-malformed-request", "rootDir is required."), 400);
      return serviceJson({ ok: true, data: { project: await stopProjectRuntime(rootDir, registryPath) } });
    }

    return serviceJson(serviceDiagnostic("service-route-not-found", `Unknown OpenCanon service route: ${url.pathname}.`), 404);
  };
  const server = await serveService({ host, port: options.port ?? defaultServicePort, routeRequest });
  let pipeServer: Awaited<ReturnType<typeof serveLocalProtocolPipe>>;
  try {
    pipeServer = await serveLocalProtocolPipe({
      endpoint: pipeEndpoint,
      routeRequest,
      host: "opencanon.service",
      maxFrameBytes: maxServiceRequestBodyBytes,
    });
  } catch (error) {
    await server.stop(true).catch(() => undefined);
    throw error;
  }
  let stopped = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  const reconcileIntervalMs = options.reconcileIntervalMs === false ? undefined : options.reconcileIntervalMs ?? ServiceReconcileIntervalMs;
  const scheduleReconcile = () => {
    if (stopped || reconcileIntervalMs === undefined) return;
    reconcileTimer = setTimeout(() => {
      void reconcileProjectRuntimes({ registryPath }).catch(() => undefined).finally(scheduleReconcile);
    }, reconcileIntervalMs);
  };
  scheduleReconcile();
  return {
    url: formatHttpBaseUrl(host, server.port),
    pipeEndpoint: pipeServer.endpoint,
    port: server.port,
    authToken,
    leaseId,
    async stop() {
      stopped = true;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      await Promise.all([server.stop(true), pipeServer.stop(true)]);
    },
  };
}

export async function inspectProjectRuntime(rootDir: string, registryPath = serviceRegistryPath()): Promise<RuntimeInspection | undefined> {
  const resolvedRoot = resolveRootDir(rootDir);
  const entry = readRuntimeRegistry(registryPath).find((item) => item.rootDir === resolvedRoot) ?? readProjectRuntimeEntry(resolvedRoot);
  return entry ? inspectRuntimeEntry(entry) : undefined;
}

export async function waitForProjectRuntimeReady(
  rootDir: string,
  input: { registryPath?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<ReadyRuntimeInspection> {
  const timeoutMs = input.timeoutMs ?? RuntimeStartupHealthBudgetMs;
  const intervalMs = input.intervalMs ?? RuntimeStartupHealthIntervalMs;
  const startedAt = Date.now();
  let lastMessage = "Project runtime did not become ready.";
  while (Date.now() - startedAt < timeoutMs) {
    const inspection = await inspectProjectRuntime(rootDir, input.registryPath);
    if (inspection?.status === RuntimeStatus.Running) return inspection as ReadyRuntimeInspection;
    if (!inspection) throw new Error("Project runtime did not become ready: no project runtime is registered.");
    if (inspection.status === RuntimeStatus.Stale || inspection.status === RuntimeStatus.Unhealthy) {
      throw new Error(`Project runtime did not become ready: ${inspection.status}: ${inspection.message}`);
    }
    lastMessage = inspection.message;
    await sleep(intervalMs);
  }
  throw new Error(`Project runtime did not become ready within ${timeoutMs}ms: ${lastMessage}`);
}

export async function inspectService(registryPath = serviceRegistryPath()): Promise<ServiceInspection | undefined> {
  const entry = readServiceEntry(registryPath);
  if (!entry) return undefined;
  if (!isProcessRunning(entry.pid)) return { entry, status: RuntimeStatus.Stale, message: "Registered service process is not running." };
  const service = await serviceStatus(entry);
  if (service.ok) return { entry, status: RuntimeStatus.Running, message: "OpenCanon service health endpoint is ready.", health: service.health };
  return { entry, status: RuntimeStatus.Unhealthy, message: service.message };
}

export async function repairServiceProcessState(input: {
  cwd?: string;
  registryPath?: string;
  cleanupPipeMaxAgeMs?: number;
  pipeDir?: string;
} = {}): Promise<ServiceRepairResult> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const entrypoint = resolveRuntimeCliEntrypoint(input.cwd ?? process.cwd());
  return await repairServiceProcessArtifacts({
    registryPath,
    entrypoint,
    keepPids: serviceRegistryKeepPids(registryPath),
    cleanupPipeMaxAgeMs: input.cleanupPipeMaxAgeMs ?? 0,
    pipeDir: input.pipeDir,
  });
}

export async function inspectAllRuntimes(registryPath = serviceRegistryPath()): Promise<RuntimeInspection[]> {
  const registry = readRuntimeRegistryFile(registryPath);
  const malformedRuntimeLeases = runtimeProcessLeasesFromMalformedRegistryEntries(registryPath);
  await retireRuntimeProcessLeases(malformedRuntimeLeases, registryPath);
  const entries = registry.entries;
  const inspections = await Promise.all(entries.map(inspectRuntimeEntry));
  if (registry.diagnostics.length > 0 || malformedRuntimeLeases.length > 0) writeRuntimeRegistry(entries, registryPath);
  return inspections;
}

export async function reconcileProjectRuntimes(input: { registryPath?: string; nowMs?: number } = {}): Promise<ReconcileProjectRuntimesResult> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const nowMs = input.nowMs ?? Date.now();
  const repair = await repairRegisteredServiceProcessArtifacts(registryPath);
  const result: ReconcileProjectRuntimesResult = {
    inspected: 0,
    running: 0,
    starting: 0,
    restarted: 0,
    backingOff: 0,
    failed: 0,
    stale: 0,
    unhealthy: 0,
    repair,
  };

  const inspections = await inspectAllRuntimes(registryPath);
  for (const inspection of inspections) {
    result.inspected += 1;
    const withinStartupGrace = runtimeStartupStillWithinGrace(inspection.entry, nowMs);
    await retireConflictingProjectWorkerLease(inspection.entry.rootDir, registryPath, inspection.entry.pid, {
      allowStaleAllowedPid: withinStartupGrace,
    });
    if (inspection.status === RuntimeStatus.Running) {
      result.running += 1;
      if (inspection.entry.lifecycle.status !== ProcessLifecycleStatus.Running) {
        updateRuntimeLifecycle(inspection.entry, createLifecycle(ProcessLifecycleStatus.Running, inspection.message), registryPath);
      }
      continue;
    }

    if (withinStartupGrace) {
      result.starting += 1;
      continue;
    }

    if (inspection.status === RuntimeStatus.Stale) result.stale += 1;
    if (inspection.status === RuntimeStatus.Unhealthy) result.unhealthy += 1;

    if (inspection.entry.lifecycle.status === ProcessLifecycleStatus.BackingOff && !restartDue(inspection.entry.lifecycle, nowMs)) {
      result.backingOff += 1;
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeRestartScheduled,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: inspection.entry.rootDir,
        pid: inspection.entry.pid,
        leaseId: inspection.entry.leaseId,
        message: `Next restart at ${inspection.entry.lifecycle.restart.nextRestartAt}.`,
      });
      continue;
    }

    const eventKind = inspection.status === RuntimeStatus.Stale ? ProcessLifecycleEventKind.RuntimeStale : ProcessLifecycleEventKind.RuntimeUnhealthy;
    const failedLifecycle = runtimeFailureLifecycle(inspection.entry, inspection.message, nowMs);
    const failedEntry = updateRuntimeLifecycle(inspection.entry, failedLifecycle, registryPath);
    appendLifecycleEvent(registryPath, {
      kind: eventKind,
      scope: ProcessLifecycleScope.Runtime,
      rootDir: inspection.entry.rootDir,
      pid: inspection.entry.pid,
      leaseId: inspection.entry.leaseId,
      message: inspection.message,
    });

    if (failedLifecycle.status === ProcessLifecycleStatus.Failed) {
      result.failed += 1;
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeRestartSkipped,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: failedEntry.rootDir,
        pid: failedEntry.pid,
        leaseId: failedEntry.leaseId,
        message: `Restart limit reached after ${failedLifecycle.restart.attempts} attempts.`,
      });
      continue;
    }

    if (!restartDue(failedLifecycle, nowMs)) {
      result.backingOff += 1;
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeRestartScheduled,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: failedEntry.rootDir,
        pid: failedEntry.pid,
        leaseId: failedEntry.leaseId,
        message: `Next restart at ${failedLifecycle.restart.nextRestartAt}.`,
      });
      continue;
    }

    try {
      const restarted = await startProjectRuntime({
        cwd: failedEntry.rootDir,
        host: failedEntry.host,
        registryPath,
        idleTimeoutMs: defaultProjectRuntimeIdleTimeoutMs,
      });
      if (restarted.status === "started") result.restarted += 1;
      else result.running += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lifecycle = runtimeFailureLifecycle(failedEntry, message, nowMs + 1);
      updateRuntimeLifecycle(failedEntry, lifecycle, registryPath);
      if (lifecycle.status === ProcessLifecycleStatus.Failed) result.failed += 1;
      else result.backingOff += 1;
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeRestartSkipped,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: failedEntry.rootDir,
        pid: failedEntry.pid,
        leaseId: failedEntry.leaseId,
        message,
      });
    }
  }
  return result;
}

function runtimeStartupStillWithinGrace(entry: RuntimeRegistryEntry, nowMs: number): boolean {
  if (entry.lifecycle.status !== ProcessLifecycleStatus.Starting) return false;
  const startedAtMs = Date.parse(entry.startedAt || entry.lifecycle.updatedAt);
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs < RuntimeStartupGraceMs;
}

export async function stopService(registryPath = serviceRegistryPath()): Promise<StopServiceResult> {
  const runtimeStops = await stopAllProjectRuntimes(registryPath);
  const entry = readServiceEntry(registryPath);
  if (!entry) {
    const removedStartupLock = removeInactiveStartupLock(registryPath, startupLockScope("service", registryPath));
    const repair = await repairServiceProcessState({ registryPath, cleanupPipeMaxAgeMs: 0 }).catch((error): ServiceRepairResult => ({
      retiredServiceProcesses: 0,
      retiredProjectRuntimes: 0,
      removedPipeEndpoints: 0,
      diagnostics: [error instanceof Error ? error.message : String(error)],
    }));
    return {
      status: removedStartupLock || repair.retiredServiceProcesses > 0 || repair.retiredProjectRuntimes > 0 || repair.removedPipeEndpoints > 0 || runtimeStops.length > 0 ? "stale" : "not-running",
      message: serviceStopMessage({
        base: runtimeStops.length > 0
          ? `Stopped ${formatRuntimeStopCount(runtimeStops.length)}. No OpenCanon service was registered.`
          : "No OpenCanon service is registered.",
        repair,
        removedStartupLock,
      }),
    };
  }

  const wasRunning = isProcessRunning(entry.pid);
  if (wasRunning) {
    upsertServiceEntry(withLifecycle(entry, ProcessLifecycleStatus.Stopping, "Stopping OpenCanon service."), registryPath);
    await terminateSpawnedProcess(entry.pid);
  }
  removeInactiveLocalPipeEndpoint(entry.pipeEndpoint, entry.pid);
  forgetServiceEntry(registryPath);
  appendLifecycleEvent(registryPath, {
    kind: ProcessLifecycleEventKind.ServiceStopped,
    scope: ProcessLifecycleScope.Service,
    pid: entry.pid,
    leaseId: entry.leaseId,
    message: wasRunning ? "Stopped OpenCanon service." : "Removed stale OpenCanon service registration.",
  });
  const repair = await repairServiceProcessState({ registryPath, cleanupPipeMaxAgeMs: 0 }).catch((error): ServiceRepairResult => ({
    retiredServiceProcesses: 0,
    retiredProjectRuntimes: 0,
    removedPipeEndpoints: 0,
    diagnostics: [error instanceof Error ? error.message : String(error)],
  }));
  return {
    status: wasRunning ? "stopped" : "stale",
    message: serviceStopMessage({
      base: wasRunning
        ? `Stopped OpenCanon service${runtimeStops.length > 0 ? ` and ${formatRuntimeStopCount(runtimeStops.length)}` : ""}.`
        : `Removed stale OpenCanon service registration${runtimeStops.length > 0 ? ` and stopped ${formatRuntimeStopCount(runtimeStops.length)}` : ""}.`,
      repair,
      removedStartupLock: removeInactiveStartupLock(registryPath, startupLockScope("service", registryPath)),
    }),
  };
}

export async function stopProjectRuntime(rootDir: string, registryPath = serviceRegistryPath()): Promise<StopProjectRuntimeResult> {
  const resolvedRoot = resolveRootDir(rootDir);
  const entry = readRuntimeRegistry(registryPath).find((item) => item.rootDir === resolvedRoot) ?? readProjectRuntimeEntry(resolvedRoot);
  if (!entry) {
    const removedStartupLock = removeInactiveStartupLock(registryPath, startupLockScope("runtime", resolvedRoot));
    const retiredLease = await retireConflictingProjectWorkerLease(resolvedRoot, registryPath);
    if (retiredLease || removedStartupLock) {
      return {
        status: "stale",
        rootDir: resolvedRoot,
        message: removedRuntimeArtifactsMessage(resolvedRoot, { retiredLease, removedStartupLock }),
      };
    }
    return {
      status: "not-running",
      rootDir: resolvedRoot,
      message: `No OpenCanon runtime is registered for ${resolvedRoot}.`,
    };
  }

  const wasRunning = isProcessRunning(entry.pid);
  if (wasRunning) {
    updateRuntimeLifecycle(entry, createLifecycle(ProcessLifecycleStatus.Stopping, "Stopping project runtime.", entry.lifecycle.restart), registryPath);
    await terminateSpawnedProcess(entry.pid);
  }
  removeInactiveLocalPipeEndpoint(entry.pipeEndpoint, entry.pid);
  forgetRuntimeEntryIfPid(resolvedRoot, entry.pid, registryPath);
  await retireConflictingProjectWorkerLease(resolvedRoot, registryPath);
  removeInactiveStartupLock(registryPath, startupLockScope("runtime", resolvedRoot));
  appendLifecycleEvent(registryPath, {
    kind: ProcessLifecycleEventKind.RuntimeStopped,
    scope: ProcessLifecycleScope.Runtime,
    rootDir: resolvedRoot,
    pid: entry.pid,
    leaseId: entry.leaseId,
    message: wasRunning ? `Stopped OpenCanon runtime for ${resolvedRoot}.` : `Removed stale runtime registration for ${resolvedRoot}.`,
  });
  return {
    status: wasRunning ? "stopped" : "stale",
    rootDir: resolvedRoot,
    message: wasRunning
      ? `Stopped OpenCanon runtime for ${resolvedRoot}.`
      : `Removed stale runtime registration for ${resolvedRoot}.`,
  };
}

async function stopAllProjectRuntimes(registryPath: string): Promise<StopProjectRuntimeResult[]> {
  const entries = readRuntimeRegistry(registryPath);
  const results: StopProjectRuntimeResult[] = [];
  for (const entry of entries) {
    results.push(await stopProjectRuntime(entry.rootDir, registryPath));
  }
  return results;
}

function formatRuntimeStopCount(count: number): string {
  return `${count} project ${count === 1 ? "runtime" : "runtimes"}`;
}

function serviceStopMessage(input: { base: string; repair: ServiceRepairResult; removedStartupLock?: boolean }): string {
  const details: string[] = [input.base];
  if (input.repair.retiredServiceProcesses > 0) details.push(`Retired ${input.repair.retiredServiceProcesses} unregistered service ${input.repair.retiredServiceProcesses === 1 ? "process" : "processes"}.`);
  if (input.repair.retiredProjectRuntimes > 0) details.push(`Retired ${input.repair.retiredProjectRuntimes} unregistered project ${input.repair.retiredProjectRuntimes === 1 ? "runtime" : "runtimes"}.`);
  if (input.repair.removedPipeEndpoints > 0) details.push(`Removed ${input.repair.removedPipeEndpoints} stale local pipe ${input.repair.removedPipeEndpoints === 1 ? "endpoint" : "endpoints"}.`);
  if (input.removedStartupLock) details.push("Removed stale startup lock.");
  details.push(...input.repair.diagnostics);
  return details.join(" ");
}

function removedRuntimeArtifactsMessage(rootDir: string, input: { retiredLease: boolean; removedStartupLock: boolean }): string {
  const details: string[] = [];
  if (input.retiredLease) details.push("worker lease");
  if (input.removedStartupLock) details.push("startup lock");
  return `Removed stale OpenCanon ${details.join(" and ")} for ${rootDir}.`;
}

export async function chooseRuntimePort(input: { host: string; preferredPort?: number; usedPorts?: number[]; rangeKey?: string }): Promise<number> {
  return chooseAvailablePort({ ...input, defaultPort: defaultRuntimePort });
}

export async function inspectRuntimeEntry(entry: RuntimeRegistryEntry): Promise<RuntimeInspection> {
  if (!isProcessRunning(entry.pid)) {
    return { entry, status: "stale", message: "Registered process is not running." };
  }
  const runtime = await projectRuntimeStatus(entry);
  if (runtime.ok) {
    return {
      entry,
      status: "running",
      message: runtime.state ? "Runtime health and state endpoints are ready." : "Runtime health endpoint is ready.",
      health: runtime.health,
      state: runtime.state,
    };
  }
  if (runtimeStartupStillWithinGrace(entry, Date.now())) {
    return { entry, status: RuntimeStatus.Starting, message: "Runtime is still starting; waiting for health endpoint." };
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

export function renderRuntimeStatusMarkdown(inspection: RuntimeInspection | undefined, rootDir: string): string {
  if (!inspection) {
    return ["# OpenCanon Project Runtime Status", "", `Root: ${resolveRootDir(rootDir)}`, "Status: not-running", "", "Run: opencanon project start"].join("\n");
  }
  const lines = [
    "# OpenCanon Project Runtime Status",
    "",
    `Root: ${inspection.entry.rootDir}`,
    `Status: ${inspection.status}`,
    `Transport: ${inspection.entry.transport}`,
    `Pipe: ${inspection.entry.pipeEndpoint}`,
    `URL: ${inspection.entry.url}`,
    `PID: ${inspection.entry.pid}`,
    `Lease: ${inspection.entry.leaseId}`,
    `Lifecycle: ${formatLifecycle(inspection.entry.lifecycle)}`,
    `Started: ${inspection.entry.startedAt}`,
    `Log: ${inspection.entry.logPath}`,
    `Message: ${inspection.message}`,
  ];
  if (inspection.health) {
    lines.push(
      `Health: ${inspection.health.status}`,
      `Engine: ${inspection.health.engine.engineVersion} (package ${inspection.health.engine.packageVersion}, NAPI ${inspection.health.engine.napiVersion})`,
      `Refresh: ${formatRefreshStatus(inspection.health.refresh)}`,
    );
    if (refreshNeedsManualAction(inspection.health.refresh)) {
      lines.push("Action: Run opencanon project index to refresh derived project knowledge now; run opencanon project stop, then opencanon project start to restore live file watching.");
    }
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

export function renderRuntimeListMarkdown(inspections: RuntimeInspection[], diagnostics: string[] = []): string {
  const lines = ["# OpenCanon Project Runtimes", ""];
  if (inspections.length === 0) {
    lines.push("No project runtimes are registered.");
    if (diagnostics.length > 0) lines.push("", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
    return lines.join("\n");
  }
  for (const inspection of inspections) {
    lines.push(`- [${inspection.status}] ${inspection.entry.rootDir}`);
    lines.push(`  Transport: ${inspection.entry.transport}`);
    lines.push(`  Pipe: ${inspection.entry.pipeEndpoint}`);
    lines.push(`  URL: ${inspection.entry.url}`);
    lines.push(`  PID: ${inspection.entry.pid}`);
    lines.push(`  Lifecycle: ${formatLifecycle(inspection.entry.lifecycle)}`);
    if (inspection.health) lines.push(`  Health: ${inspection.health.status}; refresh ${formatRefreshStatus(inspection.health.refresh)}`);
    if (inspection.state) lines.push(`  State: ${inspection.state.files} files, ${inspection.state.findings} findings, ${inspection.state.staleFiles} stale`);
  }
  if (diagnostics.length > 0) lines.push("", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
  return lines.join("\n");
}

export function renderServiceStatusMarkdown(inspection: ServiceInspection | undefined): string {
  if (!inspection) return ["# OpenCanon Service", "", "Status: not-running", "", "Run: opencanon service start"].join("\n");
  return [
    "# OpenCanon Service",
    "",
    `Status: ${inspection.status}`,
    `Transport: ${inspection.entry.transport}`,
    `Pipe: ${inspection.entry.pipeEndpoint}`,
    `URL: ${inspection.entry.url}`,
    `PID: ${inspection.entry.pid}`,
    `Lease: ${inspection.entry.leaseId}`,
    `Lifecycle: ${formatLifecycle(inspection.entry.lifecycle)}`,
    `Started: ${inspection.entry.startedAt}`,
    `Log: ${inspection.entry.logPath}`,
    `Message: ${inspection.message}`,
  ].join("\n");
}

export function renderLifecycleEventsMarkdown(events: ProcessLifecycleEvent[], limit = 50): string {
  const lines = ["# OpenCanon Process Events", ""];
  const selected = events.slice(-limit).reverse();
  if (selected.length === 0) {
    lines.push("No process lifecycle events are registered.");
    return lines.join("\n");
  }
  for (const event of selected) {
    const parts = [`${event.at}`, event.scope, event.kind];
    if (event.rootDir) parts.push(event.rootDir);
    if (event.pid) parts.push(`pid ${event.pid}`);
    lines.push(`- ${parts.join(" | ")}${event.message ? `: ${event.message}` : ""}`);
  }
  return lines.join("\n");
}

export function openRuntimeUrl(url: string): void {
  const command = process.platform === PlatformName.Darwin ? "open" : process.platform === PlatformName.Win32 ? "cmd" : "xdg-open";
  const args = process.platform === PlatformName.Win32 ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {
    // Opening the browser is best-effort; status/open commands still report the runtime URL.
  });
  child.unref();
}

async function repairServiceProcessArtifacts(input: {
  registryPath: string;
  entrypoint: RuntimeCliEntrypoint;
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

async function repairRegisteredServiceProcessArtifacts(registryPath: string): Promise<ServiceRepairResult> {
  try {
    return await repairServiceProcessArtifacts({
      registryPath,
      entrypoint: repairEntrypointFromRegistry(registryPath),
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

function repairEntrypointFromRegistry(registryPath: string): RuntimeCliEntrypoint {
  const registry = readRuntimeRegistryFile(registryPath);
  const cliPath = registry.service?.cliPath || registry.entries.find((entry) => entry.cliPath)?.cliPath;
  if (cliPath) {
    return {
      path: cliPath,
      kind: isNodeScriptCli(cliPath) ? RuntimeCliInvocationKind.NodeScript : RuntimeCliInvocationKind.Executable,
      source: "registry",
    };
  }
  return resolveRuntimeCliEntrypoint(process.cwd());
}

function serviceRegistryKeepPids(registryPath: string): Set<number> {
  const keep = new Set<number>([process.pid]);
  const service = readServiceEntry(registryPath);
  if (service?.pid && isProcessRunning(service.pid)) keep.add(service.pid);
  for (const entry of readRuntimeRegistry(registryPath)) {
    if (entry.pid && isProcessRunning(entry.pid)) keep.add(entry.pid);
  }
  return keep;
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
  entrypoint: RuntimeCliEntrypoint;
  keepPids: Set<number>;
}): Promise<number> {
  let retired = 0;
  for (const peer of discoverServiceRunPeers({ registryPath: input.registryPath, entrypoint: input.entrypoint })) {
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
  entrypoint: RuntimeCliEntrypoint;
  keepPids: Set<number>;
}): Promise<number> {
  let retired = 0;
  for (const peer of discoverProjectRuntimeRunPeers({ registryPath: input.registryPath, entrypoint: input.entrypoint })) {
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

async function runtimeHealthOk(entry: RuntimeRegistryEntry): Promise<boolean> {
  return (await projectRuntimeStatus(entry)).ok;
}

async function serviceHealthOk(entry: ServiceRegistryEntry): Promise<boolean> {
  return (await serviceStatus(entry)).ok;
}

async function serviceStatus(entry: ServiceRegistryEntry): Promise<{ ok: true; health: ServiceHealth } | { ok: false; message: string }> {
  try {
    const body = await requestLocalJson<unknown>(localProtocolEndpointFromEntry(entry), {
      method: "GET",
      path: ServiceApiRoute.Health,
      timeoutMs: LocalHealthProbeTimeoutMs,
    });
    const health = serviceHealthFromValue(body);
    if (!health) return { ok: false, message: "Service process is running but health payload is invalid." };
    if (!serviceProcessIdentityMatches(entry, health)) {
      return { ok: false, message: "Service health endpoint responded for a different process lease." };
    }
    return { ok: true, health };
  } catch {
    return { ok: false, message: "OpenCanon service process is running but health endpoint did not respond." };
  }
}

async function projectRuntimeStatus(
  entry: RuntimeRegistryEntry,
): Promise<{ ok: true; health: RuntimeHealth; state?: RuntimeState } | { ok: false; message: string }> {
  try {
    const healthPayload = await requestLocalJson<unknown>(localProtocolEndpointFromEntry(entry), {
      method: "GET",
      path: "/api/health",
      timeoutMs: LocalHealthProbeTimeoutMs,
    });
    const health = RuntimeHealthSchema.safeParse(healthPayload);
    if (!health.success) return { ok: false, message: "Process is running but health payload is invalid." };
    if (!runtimeProcessIdentityMatches(entry, health.data)) {
      return { ok: false, message: "Runtime health endpoint responded for a different process lease." };
    }

    const state = await runtimeState(entry);
    if (!state.ok) return { ok: true, health: health.data };
    return { ok: true, health: health.data, state: state.state };
  } catch {
    return { ok: false, message: "Process is running but health endpoint did not respond." };
  }
}

function runtimeProcessIdentityMatches(entry: RuntimeRegistryEntry, health: RuntimeHealth): boolean {
  return health.process?.kind === ProcessLifecycleScope.Runtime && health.process.pid === entry.pid && health.process.leaseId === entry.leaseId;
}

function serviceProcessIdentityMatches(entry: ServiceRegistryEntry, health: ServiceHealth): boolean {
  return health.process.kind === ProcessLifecycleScope.Service && health.process.pid === entry.pid && health.process.leaseId === entry.leaseId;
}

function serviceHealthFromValue(value: unknown): ServiceHealth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== "ready") return undefined;
  if (record.protocolVersion !== LocalControlProtocolVersion) return undefined;
  if (typeof record.runtimeVersion !== "string" || !record.runtimeVersion.trim()) return undefined;
  const processRecord = record.process;
  if (!processRecord || typeof processRecord !== "object" || Array.isArray(processRecord)) return undefined;
  const processValue = processRecord as Record<string, unknown>;
  if (processValue.kind !== "service") return undefined;
  if (typeof processValue.pid !== "number" || !Number.isInteger(processValue.pid) || processValue.pid <= 0) return undefined;
  if (typeof processValue.leaseId !== "string" || !processValue.leaseId.trim()) return undefined;
  return {
    status: "ready",
    protocolVersion: LocalControlProtocolVersion,
    runtimeVersion: record.runtimeVersion,
    process: {
      kind: "service",
      pid: processValue.pid,
      leaseId: processValue.leaseId,
    },
  };
}

async function waitForRuntimeHealth(entry: RuntimeRegistryEntry): Promise<boolean> {
  return (await waitForRuntimeHealthResult(entry)).ready;
}

async function waitForRuntimeHealthResult(entry: RuntimeRegistryEntry): Promise<RuntimeHealthWaitResult> {
  for (let attempt = 0; attempt < RuntimeStartupHealthAttempts; attempt += 1) {
    if (!isProcessRunning(entry.pid)) return { ready: false, reason: LocalHealthWaitFailure.ProcessExited };
    if (await runtimeHealthOk(entry)) return { ready: true };
    await sleep(RuntimeStartupHealthIntervalMs);
  }
  return { ready: false, reason: LocalHealthWaitFailure.Timeout };
}

async function waitForServiceHealth(entry: ServiceRegistryEntry): Promise<boolean> {
  return (await waitForServiceHealthResult(entry)).ready;
}

async function waitForServiceHealthResult(entry: ServiceRegistryEntry): Promise<ServiceHealthWaitResult> {
  for (let attempt = 0; attempt < ServiceStartupHealthAttempts; attempt += 1) {
    if (!isProcessRunning(entry.pid)) return { ready: false, reason: LocalHealthWaitFailure.ProcessExited };
    if (await serviceHealthOk(entry)) return { ready: true };
    await sleep(ServiceStartupHealthIntervalMs);
  }
  return { ready: false, reason: LocalHealthWaitFailure.Timeout };
}

async function runtimeState(entry: RuntimeRegistryEntry): Promise<{ ok: true; state: RuntimeState } | { ok: false }> {
  try {
    const statePayload = await requestLocalJson<unknown>(localProtocolEndpointFromEntry(entry), {
      method: "GET",
      path: "/api/state",
      timeoutMs: LocalHealthProbeTimeoutMs,
    });
    const state = RuntimeStateSchema.safeParse(statePayload);
    return state.success ? { ok: true, state: state.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function formatRefreshStatus(refresh: RuntimeHealth["refresh"]): string {
  const details = [`mode ${refresh.mode}`, `buffered ${refresh.bufferedEvents}`];
  if (refresh.reason) details.push(refresh.reason);
  return `${refresh.status} (${details.join(", ")})`;
}

function formatLifecycle(lifecycle: ProcessLifecycleState): string {
  const details: string[] = [lifecycle.status];
  if (lifecycle.message) details.push(lifecycle.message);
  if (lifecycle.restart.attempts > 0) details.push(`restart attempts ${lifecycle.restart.attempts}`);
  if (lifecycle.restart.nextRestartAt) details.push(`next restart ${lifecycle.restart.nextRestartAt}`);
  return details.join("; ");
}

function refreshNeedsManualAction(refresh: RuntimeHealth["refresh"]): boolean {
  return refresh.status === ProjectRefreshStatusValue.Stale || refresh.mode === ProjectRefreshModeValue.Manual;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(50);
  }
  return !isProcessRunning(pid);
}

async function terminateSpawnedProcess(pid: number): Promise<void> {
  if (process.platform === PlatformName.Win32) {
    await terminateWindowsProcessTree(pid);
    return;
  }
  signalPosixProcessTree(pid, "SIGTERM");
  const stopped = await waitForProcessExit(pid, 1500);
  if (stopped || !isProcessRunning(pid)) return;
  signalPosixProcessTree(pid, "SIGKILL");
  await waitForProcessExit(pid, 1500);
}

function removeInactiveLocalPipeEndpoint(endpoint: string | undefined, pid: number): void {
  if (!endpoint || process.platform === PlatformName.Win32 || isProcessRunning(pid)) return;
  rmSync(endpoint, { force: true });
}

function signalPosixProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // The child may not be a process-group leader in tests or embedded callers; fall back to the pid.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process exited between the liveness check and the signal.
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) return;
  await new Promise<void>((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    child.once("exit", () => resolve());
    child.once("error", () => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process already exited or the platform rejected the signal.
      }
      resolve();
    });
  });
  if (!isProcessRunning(pid)) return;
  await waitForProcessExit(pid, 1500);
}

async function retireMalformedRegistryProcessLeases(registryPath: string): Promise<void> {
  await retireRuntimeProcessLeases(runtimeProcessLeasesFromMalformedRegistryEntries(registryPath), registryPath);
  await retireServiceProcessLeases(serviceProcessLeasesFromMalformedRegistryEntry(registryPath), registryPath);
}

async function retireRuntimeProcessLeases(leases: RuntimeProcessLease[], registryPath: string): Promise<void> {
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

async function retireServiceProcessLeases(leases: ServiceProcessLease[], registryPath: string): Promise<void> {
  const seen = new Set<number>();
  for (const lease of leases) {
    if (seen.has(lease.pid)) continue;
    seen.add(lease.pid);
    if (lease.pid === process.pid) continue;
    if (isProcessRunning(lease.pid)) await terminateSpawnedProcess(lease.pid);
    forgetServiceEntryIfPid(lease.pid, registryPath);
  }
}

function runtimeProcessLeasesFromMalformedRegistryEntries(registryPath: string): RuntimeProcessLease[] {
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

function runtimeProcessLeasesFromRegistryValue(value: unknown, registryPath: string): RuntimeProcessLease[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.runtimes)) return [];
  return record.runtimes.flatMap((entry, index) => {
    const lease = runtimeProcessLeaseFromValue(entry, `registry:${registryPath}:${index}`);
    return lease ? [lease] : [];
  });
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

async function chooseAvailablePort(input: { host: string; preferredPort?: number; defaultPort: number; usedPorts?: number[]; rangeKey?: string }): Promise<number> {
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

function portRangeKeyForRegistry(registryPath: string, key: string): string | undefined {
  return path.resolve(registryPath) === path.resolve(path.join(homedir(), ".opencanon", "service.json")) ? undefined : key;
}

function portSearchStartOffset(key: string | undefined): number {
  if (!key) return 0;
  return createHash("sha256").update(key).digest().readUInt32BE(0) % (maxPortOffset + 1);
}

async function serveService(input: {
  host: string;
  port: number;
  routeRequest(request: Request): Promise<Response>;
}): Promise<{ port: number; stop(force?: boolean): Promise<void> }> {
  const sockets = new Set<Socket>();
  const nodeServer = createServer(async (nodeRequest, nodeResponse) => {
    await handleServiceNodeRequest(input, nodeRequest, nodeResponse);
  });
  nodeServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenNodeServer(nodeServer, input.host, input.port);
  const address = nodeServer.address();
  const port = typeof address === "object" && address ? address.port : input.port;
  return { port, stop: (force?: boolean) => closeNodeServer(nodeServer, sockets, Boolean(force)) };
}

function listenNodeServer(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeNodeServer(server: NodeHttpServer, sockets: Set<Socket>, force: boolean): Promise<void> {
  if (force) {
    for (const socket of sockets) socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function handleServiceNodeRequest(
  input: { host: string; routeRequest(request: Request): Promise<Response> },
  nodeRequest: IncomingMessage,
  nodeResponse: ServerResponse,
): Promise<void> {
  try {
    const method = nodeRequest.method ?? "GET";
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const declared = Number(nodeRequest.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxServiceRequestBodyBytes) {
        respondServiceJson(nodeResponse, 413, serviceDiagnostic("service-request-too-large", "Request body exceeds the maximum allowed size."));
        return;
      }
      const read = await readBodyWithLimit(nodeRequest, maxServiceRequestBodyBytes);
      if (read === null) {
        respondServiceJson(nodeResponse, 413, serviceDiagnostic("service-request-too-large", "Request body exceeds the maximum allowed size."));
        return;
      }
      body = read;
    }
    const response = await input.routeRequest(incomingMessageToRequest(nodeRequest, input.host, body));
    await writeNodeResponse(response, nodeResponse);
  } catch (error) {
    console.error("[opencanon-service] unhandled request error:", error instanceof Error ? error.stack ?? error.message : String(error));
    if (!nodeResponse.headersSent) respondServiceJson(nodeResponse, 500, serviceDiagnostic("service-internal-error", "Internal service error."));
  }
}

function incomingMessageToRequest(nodeRequest: IncomingMessage, fallbackHost: string, body?: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const url = new URL(nodeRequest.url ?? "/", `http://${fallbackHost}`);
  const method = nodeRequest.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { headers, method };
  if (body && method !== "GET" && method !== "HEAD") init.body = new Uint8Array(body);
  return new Request(url, init);
}

function readBodyWithLimit(nodeRequest: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    nodeRequest.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        nodeRequest.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    nodeRequest.on("end", () => resolve(Buffer.concat(chunks)));
    nodeRequest.on("error", reject);
  });
}

async function writeNodeResponse(response: Response, nodeResponse: ServerResponse): Promise<void> {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => nodeResponse.setHeader(key, value));
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) nodeResponse.write(Buffer.from(value));
  }
  nodeResponse.end();
}

function respondServiceJson(nodeResponse: ServerResponse, status: number, payload: unknown): void {
  nodeResponse.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  nodeResponse.end(JSON.stringify(payload));
}

function serviceJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function projectNotFoundProblem(input: { rootDir?: string; status?: number }): OpenCanonProblem {
  return createOpenCanonProblem({
    code: OpenCanonProblemCode.ProjectNotFound,
    title: "OpenCanon project not found",
    detail: "No OpenCanon project was discovered for the requested root.",
    source: OpenCanonProblemSource.Service,
    path: input.rootDir,
    action: "Run opencanon init --yes in that folder, or choose an initialized OpenCanon project.",
    retryable: false,
    status: input.status,
  });
}

function runtimeUnavailableProblem(rootDir: string, error: unknown): OpenCanonProblem {
  return createOpenCanonProblem({
    code: OpenCanonProblemCode.RuntimeUnavailable,
    title: "Could not start the project runtime",
    detail: error instanceof Error ? error.message : String(error),
    source: OpenCanonProblemSource.Service,
    path: rootDir,
    action: "Open OpenCanon Health or project logs, fix the runtime startup issue, then retry this project.",
    retryable: true,
    status: 500,
    details: { logPath: path.join(rootDir, ".opencanon", "runtime.log") },
  });
}

function isLocalProtocolTransportFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("OpenCanon pipe closed before a complete frame was received") ||
    message.includes("OpenCanon pipe socket is already closed") ||
    message.includes("OpenCanon local request timed out") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE") ||
    message.includes("ENOENT") ||
    message.includes("No such file or directory")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serviceProblem(problem: OpenCanonProblem): { ok: false; error: OpenCanonErrorPayload } {
  return {
    ok: false,
    error: createOpenCanonProblemError(problem),
  };
}

function serviceDiagnostic(code: OpenCanonErrorCode, message: string): { ok: false; error: OpenCanonErrorPayload } {
  return { ok: false, error: createOpenCanonDiagnosticsError([createOpenCanonDiagnostic({ code, message })]) };
}

async function setupOpenCanonProject(rootDir: string): Promise<{ status: string; title: string; message: string; path?: string; details?: unknown }> {
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

async function proxyRuntimeEventStream(entry: RuntimeRegistryEntry): Promise<Response> {
  const url = new URL("/api/events/stream", entry.url);
  const upstream = await fetch(url, { headers: runtimeAuthHeaders(entry.authToken) });
  if (!upstream.ok || !upstream.body) {
    return serviceJson(serviceDiagnostic("runtime-not-running", `OpenCanon runtime event stream failed: ${upstream.status} ${upstream.statusText}.`), upstream.status || 502);
  }
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}

function serviceRequestMethod(value: unknown): "GET" | "POST" {
  return value === "POST" ? "POST" : "GET";
}

function stringRecordBodyValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") output[key] = item;
  }
  return output;
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

async function readServiceJsonObject(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, message: "Request body must be a JSON object." };
  return { ok: true, body: parsed as Record<string, unknown> };
}

function stringBodyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArrayBodyValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function recentProjectsBodyValue(value: unknown): ServiceRecentProject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const rootDir = stringBodyValue(record.rootDir);
    if (!rootDir) return [];
    const openedAt = stringBodyValue(record.openedAt);
    return [{ rootDir, ...(openedAt ? { openedAt } : {}) }];
  });
}

function numberBodyValue(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function optionalPortBodyValue(value: unknown): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535) return { ok: true, value: value as number };
  return { ok: false };
}

function booleanBodyValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

type RuntimeCliInvocation = {
  command: string;
  args: string[];
  entrypoint: RuntimeCliEntrypoint;
};

function runtimeCliInvocation(rootDir: string, args: string[]): RuntimeCliInvocation {
  const entrypoint = resolveRuntimeCliEntrypoint(rootDir);
  if (entrypoint.kind === RuntimeCliInvocationKind.NodeScript) {
    return { command: nodeCommandForCliInvocation(), args: [entrypoint.path, ...args], entrypoint };
  }
  return { command: entrypoint.path, args: [...args], entrypoint };
}

function nodeCommandForCliInvocation(): string {
  if (existsSync(process.execPath)) return process.execPath;
  return findExecutablePathOnPath("node") ?? process.execPath;
}

export function resolveRuntimeCliEntrypoint(rootDir: string): RuntimeCliEntrypoint {
  const envOverride = nonEmptyString(process.env.OPENCANON_CLI);
  if (envOverride) {
    const entrypoint = cliEntrypointFromCandidate(envOverride, "env");
    if (entrypoint) return entrypoint;
    throw new Error(`OPENCANON_CLI points at a missing OpenCanon CLI entrypoint: ${envOverride}.`);
  }

  const current = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (current && isKnownOpenCanonCliPath(current)) {
    const entrypoint = cliEntrypointFromCandidate(current, "current-argv");
    if (entrypoint) return entrypoint;
  }

  const pathEntrypoint = findCommandOnPath("opencanon");
  if (pathEntrypoint) return pathEntrypoint;

  for (const candidate of devCheckoutCliCandidates(rootDir)) {
    const entrypoint = cliEntrypointFromCandidate(candidate, "dev-checkout");
    if (entrypoint) return entrypoint;
  }

  throw new Error(`OpenCanon CLI not found for ${rootDir}. Install the OpenCanon runtime, make opencanon available on PATH, or set OPENCANON_CLI.`);
}

function cliEntrypointFromCandidate(candidate: string, source: string): RuntimeCliEntrypoint | undefined {
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  const resolved = realpathSync(candidate);
  return {
    path: resolved,
    kind: isNodeScriptCli(resolved) ? RuntimeCliInvocationKind.NodeScript : RuntimeCliInvocationKind.Executable,
    source,
  };
}

function devCheckoutCliCandidates(rootDir: string): string[] {
  return uniqueStrings([rootDir, process.cwd(), path.dirname(fileURLToPath(import.meta.url))]
    .flatMap((start) => ancestorPaths(start))
    .map((candidate) => path.join(candidate, "packages", "cli", "src", "index.ts")));
}

function ancestorPaths(rootDir: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(rootDir);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

function isKnownOpenCanonCliPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  return (
    normalized.endsWith("/packages/cli/src/index.ts") ||
    normalized.endsWith("/node_modules/.bin/opencanon") ||
    isInstalledRuntimeCli(candidate)
  );
}

function isInstalledRuntimeCli(candidate: string): boolean {
  if (path.basename(candidate) !== "cli.js") return false;
  const dir = path.dirname(candidate);
  if (!existsSync(path.join(dir, "runtime.js"))) return false;
  try {
    const packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; type?: string };
    return packageJson.name === "opencanon" && packageJson.type === "module";
  } catch {
    return false;
  }
}

function isNodeScriptCli(candidate: string): boolean {
  const extension = path.extname(candidate).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) return true;
  try {
    const firstLine = readFileSync(candidate, "utf8").split(/\r?\n/u, 1)[0] ?? "";
    return firstLine.startsWith("#!") && firstLine.includes("node");
  } catch {
    return false;
  }
}

function findCommandOnPath(command: string): RuntimeCliEntrypoint | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of executableNameCandidates(path.join(dir, command))) {
      const entrypoint = cliEntrypointFromCandidate(candidate, "path");
      if (entrypoint) return entrypoint;
    }
  }
  return undefined;
}

function findExecutablePathOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of executableNameCandidates(path.join(dir, command))) {
      try {
        if (statSync(candidate).isFile()) return realpathSync(candidate);
      } catch {
        // Keep searching PATH entries.
      }
    }
  }
  return undefined;
}

function executableNameCandidates(base: string): string[] {
  if (process.platform !== PlatformName.Win32 || path.extname(base)) return [base];
  return [base, `${base}.cmd`, `${base}.ps1`, `${base}.exe`];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = path.resolve(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function closeFileDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The descriptor may already be closed after a spawn failure; cleanup remains best-effort.
  }
}

function waitForChildSpawn(child: ChildProcess, description: string): Promise<number> {
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

function isRegistryEntry(value: unknown): value is RuntimeRegistryEntry {
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

function isServiceEntry(value: unknown): value is ServiceRegistryEntry {
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

function isLifecycleState(value: unknown): value is ProcessLifecycleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === "string" &&
    Object.values(ProcessLifecycleStatus).includes(record.status as ProcessLifecycleStatus) &&
    typeof record.updatedAt === "string" &&
    (record.message === undefined || typeof record.message === "string") &&
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
