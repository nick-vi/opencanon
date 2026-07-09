import { createLifecycle, restartDue, runtimeFailureLifecycle } from "./service-lifecycle.ts";
import { inspectAllRuntimes, runtimeBusyStillWithinBudget, runtimeStartupStillWithinGrace } from "./service-monitor.ts";
import { repairRegisteredServiceProcessArtifacts, retireConflictingProjectWorkerLease } from "./service-process.ts";
import { startProjectRuntime } from "./service-start.ts";
import {
  appendLifecycleEvent,
  serviceRegistryPath,
  updateRuntimeLifecycle,
} from "./service-storage.ts";
import {
  ProcessLifecycleEventKind,
  ProcessLifecycleScope,
  ProcessLifecycleStatus,
  RuntimeStatus,
  defaultProjectRuntimeIdleTimeoutMs,
  type ReconcileProjectRuntimesResult,
} from "./service-types.ts";

export async function reconcileProjectRuntimes(input: { registryPath?: string; nowMs?: number } = {}): Promise<ReconcileProjectRuntimesResult> {
  const registryPath = input.registryPath ?? serviceRegistryPath();
  const nowMs = input.nowMs ?? Date.now();
  const repair = await repairRegisteredServiceProcessArtifacts(registryPath);
  const result: ReconcileProjectRuntimesResult = {
    inspected: 0,
    busy: 0,
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
    const withinBusyBudget = runtimeBusyStillWithinBudget(inspection.entry, nowMs);
    await retireConflictingProjectWorkerLease(inspection.entry.rootDir, registryPath, inspection.entry.pid, {
      allowStaleAllowedPid: withinStartupGrace || withinBusyBudget,
    });
    if (inspection.status === RuntimeStatus.Running) {
      result.running += 1;
      if (inspection.entry.lifecycle.status !== ProcessLifecycleStatus.Running) {
        updateRuntimeLifecycle(inspection.entry, createLifecycle(ProcessLifecycleStatus.Running, inspection.message), registryPath);
      }
      continue;
    }

    if (inspection.status === RuntimeStatus.Busy || withinBusyBudget) {
      result.busy += 1;
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
