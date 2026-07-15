import {
  createLifecycle,
  healthConfirmationDue,
  restartDue,
  runtimeFailureLifecycle,
  runtimeHealthConfirmationLifecycle,
} from "./service-lifecycle.ts";
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
  const requestedNowMs = input.nowMs;
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
    const nowMs = requestedNowMs ?? Date.now();
    result.inspected += 1;
    const withinStartupGrace = runtimeStartupStillWithinGrace(inspection.entry, nowMs);
    await retireConflictingProjectWorkerLease(inspection.entry.rootDir, registryPath, inspection.entry.pid);
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

    if (inspection.entry.lifecycle.status === ProcessLifecycleStatus.BackingOff) {
      if (!restartDue(inspection.entry.lifecycle, nowMs)) {
        result.backingOff += 1;
        continue;
      }
      await restartProjectRuntime(inspection.entry, result, registryPath, nowMs);
      continue;
    }

    if (
      inspection.status === RuntimeStatus.Unhealthy &&
      inspection.entry.lifecycle.status === ProcessLifecycleStatus.Unhealthy &&
      inspection.entry.lifecycle.healthConfirmation
    ) {
      if (!healthConfirmationDue(inspection.entry.lifecycle, nowMs)) {
        result.unhealthy += 1;
        continue;
      }
      result.unhealthy += 1;
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeHealthConfirmationFailed,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: inspection.entry.rootDir,
        pid: inspection.entry.pid,
        leaseId: inspection.entry.leaseId,
        message: inspection.message,
      });
      await restartProjectRuntime(inspection.entry, result, registryPath, nowMs);
      continue;
    }

    if (inspection.status === RuntimeStatus.Unhealthy) {
      const confirmationLifecycle = runtimeHealthConfirmationLifecycle(
        inspection.message,
        defaultProjectRuntimeHealthConfirmationMs,
        nowMs,
      );
      const confirmationTransition = compareAndSetRuntimeLifecycle(inspection.entry, confirmationLifecycle, registryPath);
      if (!confirmationTransition.applied) {
        countConcurrentLifecycle(result, confirmationTransition.current);
        continue;
      }
      result.unhealthy += 1;
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeUnhealthy,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: inspection.entry.rootDir,
        pid: inspection.entry.pid,
        leaseId: inspection.entry.leaseId,
        message: inspection.message,
      });
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeHealthConfirmationScheduled,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: inspection.entry.rootDir,
        pid: inspection.entry.pid,
        leaseId: inspection.entry.leaseId,
        message: `Confirm health after ${confirmationLifecycle.healthConfirmation?.confirmationDueAt}.`,
      });
      continue;
    }

    const failedLifecycle = runtimeFailureLifecycle(
      inspection.entry,
      inspection.message,
      nowMs,
    );
    const failureTransition = compareAndSetRuntimeLifecycle(inspection.entry, failedLifecycle, registryPath);
    if (!failureTransition.applied) {
      countConcurrentLifecycle(result, failureTransition.current);
      continue;
    }
    const failedEntry = failureTransition.entry;
    result.stale += 1;
    appendLifecycleEvent(registryPath, {
      kind: ProcessLifecycleEventKind.RuntimeStale,
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

    await restartProjectRuntime(failedEntry, result, registryPath, nowMs);
  }
  return result;
}

async function restartProjectRuntime(
  entry: RuntimeRegistryEntry,
  result: ReconcileProjectRuntimesResult,
  registryPath: string,
  nowMs: number,
): Promise<void> {
  appendLifecycleEvent(registryPath, {
    kind: ProcessLifecycleEventKind.RuntimeRestartScheduled,
    scope: ProcessLifecycleScope.Runtime,
    rootDir: entry.rootDir,
    pid: entry.pid,
    leaseId: entry.leaseId,
    message: "Runtime failure confirmed; restarting now.",
  });
  try {
    const restarted = await startProjectRuntime({
      cwd: entry.rootDir,
      host: entry.host,
      registryPath,
      idleTimeoutMs: defaultProjectRuntimeIdleTimeoutMs,
    });
    if (restarted.status === StartProjectRuntimeStatus.Started) {
      result.restarted += 1;
      appendLifecycleEvent(registryPath, {
        kind: ProcessLifecycleEventKind.RuntimeRestarted,
        scope: ProcessLifecycleScope.Runtime,
        rootDir: restarted.entry.rootDir,
        pid: restarted.entry.pid,
        leaseId: restarted.entry.leaseId,
        message: `Replaced runtime process ${entry.pid} (${entry.leaseId}).`,
      });
    } else result.running += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lifecycle = runtimeFailureLifecycle(entry, message, nowMs + 1, parseOpenCanonProblemFromError(error));
    const restartFailureTransition = compareAndSetRuntimeLifecycle(entry, lifecycle, registryPath);
    if (restartFailureTransition.applied) {
      if (lifecycle.status === ProcessLifecycleStatus.Failed) result.failed += 1;
      else result.backingOff += 1;
    }
    appendLifecycleEvent(registryPath, {
      kind: ProcessLifecycleEventKind.RuntimeRestartSkipped,
      scope: ProcessLifecycleScope.Runtime,
      rootDir: entry.rootDir,
      pid: entry.pid,
      leaseId: entry.leaseId,
      message,
    });
  }
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
