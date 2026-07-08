import {
  ProcessLifecycleStatus,
  type ProcessLifecycleState,
  type ProcessRestartState,
  type RuntimeRegistryEntry,
} from "./service-types.ts";

const RestartFailureWindowMs = 5 * 60 * 1000;
const RestartBackoffBaseMs = 1_000;
const RestartBackoffMaxMs = 30_000;
const RestartMaxAttempts = 5;

export function createLifecycle(status: ProcessLifecycleStatus, message?: string, restart: ProcessRestartState = { attempts: 0 }): ProcessLifecycleState {
  return {
    status,
    updatedAt: new Date().toISOString(),
    ...(message ? { message } : {}),
    restart,
  };
}

export function withLifecycle<T extends { lifecycle: ProcessLifecycleState }>(entry: T, status: ProcessLifecycleStatus, message?: string, restart = entry.lifecycle.restart): T {
  return {
    ...entry,
    lifecycle: createLifecycle(status, message, restart),
  };
}

export function runtimeFailureLifecycle(entry: RuntimeRegistryEntry, message: string, nowMs = Date.now()): ProcessLifecycleState {
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

export function restartDue(lifecycle: ProcessLifecycleState, nowMs = Date.now()): boolean {
  if (lifecycle.status === ProcessLifecycleStatus.Failed) return false;
  const nextRestartAt = lifecycle.restart.nextRestartAt ? Date.parse(lifecycle.restart.nextRestartAt) : Number.NaN;
  return !Number.isFinite(nextRestartAt) || nextRestartAt <= nowMs;
}
