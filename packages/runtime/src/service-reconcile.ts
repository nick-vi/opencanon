import { createLifecycle, restartDue, runtimeFailureLifecycle } from "./service-lifecycle.ts";
import { parseOpenCanonProblemFromError } from "@opencanon/core";
import { inspectAllRuntimes, runtimeStartupStillWithinGrace } from "./service-monitor.ts";
import { repairRegisteredServiceProcessArtifacts, retireConflictingProjectWorkerLease } from "./service-process.ts";
import { startProjectRuntime } from "./service-start.ts";
import {
  appendLifecycleEvent,
  compareAndSetRuntimeLifecycle,
  serviceRegistryPath,
} from "./service-storage.ts";
import {
  ProcessLifecycleEventKind,
  ProcessLifecycleScope,
  ProcessLifecycleStatus,
  RuntimeStatus,
  StartProjectRuntimeStatus,
  defaultProjectRuntimeHealthConfirmationMs,
  defaultProjectRuntimeIdleTimeoutMs,
  type ReconcileProjectRuntimesResult,
  type RuntimeRegistryEntry,
} from "./service-types.ts";

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
      continue;
    }

    if (inspection.status === RuntimeStatus.Failed) {
      result.failed += 1;
      continue;
    }

    if (withinStartupGrace) {
      result.starting += 1;
      continue;
    }

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
    const failedLifecycle = runtimeFailureLifecycle(
      inspection.entry,
      inspection.message,
      nowMs,
      undefined,
      inspection.status === RuntimeStatus.Unhealthy
        ? { initialBackoffMs: defaultProjectRuntimeHealthConfirmationMs }
        : {},
    );
    const failureTransition = compareAndSetRuntimeLifecycle(inspection.entry, failedLifecycle, registryPath);
    if (!failureTransition.applied) {
      countConcurrentLifecycle(result, failureTransition.current);
      continue;
    }
    const failedEntry = failureTransition.entry;
    if (inspection.status === RuntimeStatus.Stale) result.stale += 1;
    if (inspection.status === RuntimeStatus.Unhealthy) result.unhealthy += 1;
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
      if (restarted.status === StartProjectRuntimeStatus.Started) result.restarted += 1;
      else result.running += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lifecycle = runtimeFailureLifecycle(failedEntry, message, nowMs + 1, parseOpenCanonProblemFromError(error));
      const restartFailureTransition = compareAndSetRuntimeLifecycle(failedEntry, lifecycle, registryPath);
      if (restartFailureTransition.applied) {
        if (lifecycle.status === ProcessLifecycleStatus.Failed) result.failed += 1;
        else result.backingOff += 1;
      }
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

function countConcurrentLifecycle(
  result: ReconcileProjectRuntimesResult,
  entry: RuntimeRegistryEntry | undefined,
): void {
  if (!entry) {
    result.stale += 1;
    return;
  }
  if (entry.lifecycle.status === ProcessLifecycleStatus.Running) result.running += 1;
  else if (entry.lifecycle.status === ProcessLifecycleStatus.Starting) result.starting += 1;
  else if (entry.lifecycle.status === ProcessLifecycleStatus.Failed) result.failed += 1;
  else if (entry.lifecycle.status === ProcessLifecycleStatus.BackingOff) result.backingOff += 1;
  else result.unhealthy += 1;
}
