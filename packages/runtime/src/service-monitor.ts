import { RuntimeHealthSchema, RuntimeStateSchema, resolveRootDir, type RuntimeHealth, type RuntimeState } from "@opencanon/core";
import { localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";
import { ServiceApiRoute } from "./service-types.ts";
import {
  LocalControlProtocolVersion,
  LocalHealthWaitFailure,
  ProcessLifecycleScope,
  ProcessLifecycleStatus,
  RuntimeStatus,
  type ReadyRuntimeInspection,
  type RuntimeHealthWaitResult,
  type RuntimeInspection,
  type RuntimeRegistryEntry,
  type ServiceHealth,
  type ServiceHealthWaitResult,
  type ServiceInspection,
  type ServiceRegistryEntry,
} from "./service-types.ts";
import {
  isProcessRunning,
  readProjectRuntimeEntry,
  readRuntimeRegistry,
  readRuntimeRegistryFile,
  readServiceEntry,
  serviceRegistryPath,
  sleep,
  updateRuntimeLifecycle,
  writeRuntimeRegistry,
} from "./service-storage.ts";
import { retireRuntimeProcessLeases, runtimeProcessLeasesFromMalformedRegistryEntries } from "./service-process.ts";
import { withLifecycle } from "./service-lifecycle.ts";
import { resolveRuntimeCliEntrypoint } from "./service-entrypoint.ts";
import { runtimeIdentityForEntrypoint, runtimeIdentityMatches } from "./service-identity.ts";

export const RuntimeStartupHealthBudgetMs = 180_000;
const RuntimeStartupHealthIntervalMs = 250;
const RuntimeStartupHealthAttempts = Math.ceil(RuntimeStartupHealthBudgetMs / RuntimeStartupHealthIntervalMs);
const ServiceStartupHealthBudgetMs = 20_000;
const ServiceStartupHealthIntervalMs = 100;
const ServiceStartupHealthAttempts = Math.ceil(ServiceStartupHealthBudgetMs / ServiceStartupHealthIntervalMs);
const LocalHealthProbeTimeoutMs = 2_000;
const ServiceReconcileIntervalMs = 30_000;
export const RuntimeStartupGraceMs = RuntimeStartupHealthBudgetMs + ServiceReconcileIntervalMs;
export const RuntimeBusyBudgetMs = 30 * 60_000;

export async function inspectProjectRuntime(rootDir: string, registryPath = serviceRegistryPath()): Promise<RuntimeInspection | undefined> {
  const resolvedRoot = resolveRootDir(rootDir);
  const entry = readRuntimeRegistry(registryPath).find((item) => item.rootDir === resolvedRoot) ?? readProjectRuntimeEntry(resolvedRoot);
  return entry ? inspectRuntimeEntry(entry, registryPath) : undefined;
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
    if (inspection.status === RuntimeStatus.Failed || inspection.status === RuntimeStatus.Stale || inspection.status === RuntimeStatus.Unhealthy) {
      throw new Error(`Project runtime did not become ready: ${inspection.status}: ${inspection.message}`);
    }
    lastMessage = inspection.message;
    await sleep(intervalMs);
  }
  throw new Error(`Project runtime did not become ready within ${timeoutMs}ms: ${lastMessage}`);
}

export async function inspectService(registryPath = serviceRegistryPath(), rootDir = process.cwd()): Promise<ServiceInspection | undefined> {
  const entry = readServiceEntry(registryPath);
  if (!entry) return undefined;
  if (!isProcessRunning(entry.pid)) return { entry, status: RuntimeStatus.Stale, message: "Registered service process is not running." };
  if (!serviceRuntimeIdentityMatches(entry, rootDir)) {
    return {
      entry,
      status: RuntimeStatus.Stale,
      message: "Registered service was started by a different OpenCanon runtime. Run opencanon service start to recreate service state.",
    };
  }
  const service = await serviceStatus(entry);
  if (service.ok) return { entry, status: RuntimeStatus.Running, message: "OpenCanon service health endpoint is ready.", health: service.health };
  return { entry, status: RuntimeStatus.Unhealthy, message: service.message };
}

export async function inspectAllRuntimes(registryPath = serviceRegistryPath()): Promise<RuntimeInspection[]> {
  const registry = readRuntimeRegistryFile(registryPath);
  const malformedRuntimeLeases = runtimeProcessLeasesFromMalformedRegistryEntries(registryPath);
  await retireRuntimeProcessLeases(malformedRuntimeLeases, registryPath);
  const entries = registry.entries;
  const inspections = await Promise.all(entries.map((entry) => inspectRuntimeEntry(entry, registryPath)));
  if (registry.diagnostics.length > 0 || malformedRuntimeLeases.length > 0) writeRuntimeRegistry(inspections.map((inspection) => inspection.entry), registryPath);
  return inspections;
}

export async function inspectRuntimeEntry(entry: RuntimeRegistryEntry, registryPath?: string | undefined): Promise<RuntimeInspection> {
  if (!isProcessRunning(entry.pid)) {
    if (entry.lifecycle.status === ProcessLifecycleStatus.Failed) {
      return {
        entry,
        status: RuntimeStatus.Failed,
        message: entry.lifecycle.problem?.detail ?? entry.lifecycle.message ?? "Project runtime failed.",
        ...(entry.lifecycle.problem ? { problem: entry.lifecycle.problem } : {}),
      };
    }
    return { entry, status: RuntimeStatus.Stale, message: "Registered process is not running." };
  }
  if (!projectRuntimeIdentityMatches(entry)) {
    return {
      entry,
      status: RuntimeStatus.Stale,
      message: "Registered project runtime was started by a different OpenCanon runtime. Run opencanon project start to recreate project runtime state.",
    };
  }
  const nowMs = Date.now();
  const runtime = await projectRuntimeStatus(entry);
  const busyWithinBudget = runtimeBusyStillWithinBudget(entry, nowMs);
  if (runtime.ok) {
    if (busyWithinBudget) {
      return {
        entry,
        status: RuntimeStatus.Busy,
        message: entry.lifecycle.message ?? "Runtime is busy with project work.",
        health: runtime.health,
        state: runtime.state,
      };
    }
    const message = runtime.state ? "Runtime health and state endpoints are ready." : "Runtime health endpoint is ready.";
    const lifecycleCurrent = entry.lifecycle.status === ProcessLifecycleStatus.Running && entry.lifecycle.message === message;
    const normalizedEntry = lifecycleCurrent ? entry : withLifecycle(entry, ProcessLifecycleStatus.Running, message);
    const inspectedEntry = registryPath && !lifecycleCurrent ? updateRuntimeLifecycle(entry, normalizedEntry.lifecycle, registryPath) : normalizedEntry;
    return {
      entry: inspectedEntry,
      status: RuntimeStatus.Running,
      message,
      health: runtime.health,
      state: runtime.state,
    };
  }
  if (busyWithinBudget) {
    return { entry, status: RuntimeStatus.Busy, message: entry.lifecycle.message ?? "Runtime is busy with project work." };
  }
  if (runtimeStartupStillWithinGrace(entry, nowMs)) {
    return { entry, status: RuntimeStatus.Starting, message: "Runtime is still starting; waiting for health endpoint." };
  }
  return { entry, status: RuntimeStatus.Unhealthy, message: runtime.message };
}

function projectRuntimeIdentityMatches(entry: RuntimeRegistryEntry): boolean {
  return runtimeIdentityMatches(entry, runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(entry.rootDir)));
}

function serviceRuntimeIdentityMatches(entry: ServiceRegistryEntry, rootDir: string): boolean {
  return runtimeIdentityMatches(entry, runtimeIdentityForEntrypoint(resolveRuntimeCliEntrypoint(rootDir)));
}

export function runtimeStartupStillWithinGrace(entry: RuntimeRegistryEntry, nowMs: number): boolean {
  if (entry.lifecycle.status !== ProcessLifecycleStatus.Starting) return false;
  const startedAtMs = Date.parse(entry.startedAt || entry.lifecycle.updatedAt);
  return Number.isFinite(startedAtMs) && nowMs - startedAtMs < RuntimeStartupGraceMs;
}

export function runtimeBusyStillWithinBudget(entry: RuntimeRegistryEntry, nowMs: number): boolean {
  if (entry.lifecycle.status !== ProcessLifecycleStatus.Busy) return false;
  const updatedAtMs = Date.parse(entry.lifecycle.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < RuntimeBusyBudgetMs;
}

export async function waitForRuntimeHealth(entry: RuntimeRegistryEntry): Promise<boolean> {
  return (await waitForRuntimeHealthResult(entry)).ready;
}

export async function waitForRuntimeHealthResult(entry: RuntimeRegistryEntry): Promise<RuntimeHealthWaitResult> {
  for (let attempt = 0; attempt < RuntimeStartupHealthAttempts; attempt += 1) {
    if (!isProcessRunning(entry.pid)) return { ready: false, reason: LocalHealthWaitFailure.ProcessExited };
    if (await runtimeHealthOk(entry)) return { ready: true };
    await sleep(RuntimeStartupHealthIntervalMs);
  }
  return { ready: false, reason: LocalHealthWaitFailure.Timeout };
}

export async function waitForServiceHealth(entry: ServiceRegistryEntry): Promise<boolean> {
  return (await waitForServiceHealthResult(entry)).ready;
}

export async function waitForServiceHealthResult(entry: ServiceRegistryEntry): Promise<ServiceHealthWaitResult> {
  for (let attempt = 0; attempt < ServiceStartupHealthAttempts; attempt += 1) {
    if (!isProcessRunning(entry.pid)) return { ready: false, reason: LocalHealthWaitFailure.ProcessExited };
    if (await serviceHealthOk(entry)) return { ready: true };
    await sleep(ServiceStartupHealthIntervalMs);
  }
  return { ready: false, reason: LocalHealthWaitFailure.Timeout };
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
