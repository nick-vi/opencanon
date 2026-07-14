import { resolveRootDir } from "@opencanon/core";
import { createLifecycle, withLifecycle } from "./service-lifecycle.ts";
import { inspectProjectRuntime, inspectService } from "./service-monitor.ts";
import {
  removeInactiveLocalPipeEndpoint,
  repairServiceProcessArtifacts,
  serviceRegistryKeepPids,
  retireConflictingProjectWorkerLease,
  terminateSpawnedProcess,
} from "./service-process.ts";
import {
  appendLifecycleEvent,
  forgetRuntimeEntryIfPid,
  forgetServiceEntry,
  isProcessRunning,
  readProjectRuntimeEntry,
  readRuntimeRegistry,
  readServiceEntry,
  removeInactiveStartupLock,
  serviceRegistryPath,
  setRuntimeLifecycleForLease,
  startupLockScope,
  upsertServiceEntry,
} from "./service-storage.ts";
import {
  ProcessLifecycleEventKind,
  ProcessLifecycleScope,
  ProcessLifecycleStatus,
  type ServiceRepairResult,
  type StopProjectRuntimeResult,
  type StopServiceResult,
} from "./service-types.ts";

export async function repairServiceProcessState(input: {
  cwd?: string;
  registryPath?: string;
  cleanupPipeMaxAgeMs?: number;
  pipeDir?: string;
} = {}): Promise<ServiceRepairResult> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  return await repairServiceProcessArtifacts({
    registryPath,
    keepPids: serviceRegistryKeepPids(registryPath),
    cleanupPipeMaxAgeMs: input.cleanupPipeMaxAgeMs ?? 0,
    pipeDir: input.pipeDir,
  });
}

export async function stopService(registryPath = serviceRegistryPath()): Promise<StopServiceResult> {
  const entry = readServiceEntry(registryPath);
  let wasRunning = false;
  if (entry) {
    wasRunning = isProcessRunning(entry.pid);
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
  }

  const runtimeStops = await stopAllProjectRuntimes(registryPath);
  const repair = await repairServiceProcessArtifacts({
    registryPath,
    keepPids: new Set([process.pid]),
    cleanupPipeMaxAgeMs: 0,
  }).catch((error): ServiceRepairResult => ({
    retiredServiceProcesses: 0,
    retiredProjectRuntimes: 0,
    removedPipeEndpoints: 0,
    diagnostics: [error instanceof Error ? error.message : String(error)],
  }));

  if (!entry) {
    const removedStartupLock = removeInactiveStartupLock(registryPath, startupLockScope("service", registryPath));
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
  const entry = readRuntimeRegistry(registryPath).find((item) => item.rootDir === resolvedRoot) ?? readProjectRuntimeEntry(resolvedRoot, registryPath);
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
    setRuntimeLifecycleForLease(entry, createLifecycle(ProcessLifecycleStatus.Stopping, "Stopping project runtime.", entry.lifecycle.restart), registryPath);
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

export async function stopAllProjectRuntimes(registryPath: string): Promise<StopProjectRuntimeResult[]> {
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
