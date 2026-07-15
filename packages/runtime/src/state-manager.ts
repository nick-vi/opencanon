import type { RuntimeSnapshot } from "./snapshot.ts";
import type { ProjectInventory } from "./server-fs.ts";
import { RuntimeLifecyclePhaseValue, type RuntimeLifecycleState, type RuntimeRevision, type ValidationResultCache } from "@opencanon/core";

export type RuntimeWaitOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RuntimeStateManager = {
  currentSnapshot(): RuntimeSnapshot;
  setSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot;
  currentProjectInventory(): ProjectInventory;
  validationResultCache(): ValidationResultCache;
  replaceValidationResultCache(cache: ValidationResultCache): void;
  lifecycle(): RuntimeLifecycleState;
  rebuildAndPublish(summary: string, options?: RuntimeRebuildOptions): Promise<RuntimeSnapshot>;
  scheduleRebuild(summary: string, options?: RuntimeRebuildOptions): number;
  waitForRevision(revision: number, options?: RuntimeWaitOptions): Promise<RuntimeSnapshot>;
  waitForIdle(options?: RuntimeWaitOptions): Promise<void>;
  hasPendingWork(): boolean;
  stop(): void;
};

export type RuntimeRebuildOptions = Record<string, never>;

export type RuntimeRebuildCandidate = {
  snapshot: RuntimeSnapshot;
  commit(): Promise<RuntimeSnapshot> | RuntimeSnapshot;
  discard?(): Promise<void> | void;
};

export type RuntimeStateManagerOptions = {
  initialSnapshot: RuntimeSnapshot;
  initialProjectInventory: ProjectInventory;
  initialValidationResultCache: ValidationResultCache;
  isStopped(): boolean;
  rebuildNow(summary: string, options: RuntimeRebuildOptions, signal: AbortSignal): Promise<RuntimeRebuildCandidate>;
  readProjectInventory(): ProjectInventory;
  onRebuildError(error: unknown): void;
};

type RebuildIntent = { revision: number; summary: string; options: RuntimeRebuildOptions };
type RevisionWaiter = {
  revision: number;
  resolve(snapshot: RuntimeSnapshot): void;
  reject(error: Error): void;
  cleanup(): void;
};

export function createRuntimeStateManager(options: RuntimeStateManagerOptions): RuntimeStateManager {
  let snapshot = options.initialSnapshot;
  let projectInventory = options.initialProjectInventory;
  let validationResultCache = options.initialValidationResultCache;
  let revision: RuntimeRevision = { observed: 1, accepted: 1, published: 1 };
  let phase: RuntimeLifecycleState["phase"] = RuntimeLifecyclePhaseValue.TransportReady;
  let active: RebuildIntent | undefined;
  let queued: RebuildIntent | undefined;
  let failure: RuntimeLifecycleState["failure"];
  let loop: Promise<void> | undefined;
  let activeAbortController: AbortController | undefined;
  let stopped = false;
  const waiters = new Set<RevisionWaiter>();

  function lifecycle(): RuntimeLifecycleState {
    return {
      phase,
      revision: { ...revision },
      settled: !active && !queued && revision.observed === revision.published && phase !== RuntimeLifecyclePhaseValue.Failed,
      ...(active ? { active: { revision: active.revision, summary: active.summary } } : {}),
      ...(queued ? { queued: { revision: queued.revision, summary: queued.summary } } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  function requestRebuild(summary: string, inputOptions?: RuntimeRebuildOptions): number {
    if (stopped || options.isStopped()) throw new Error("Project runtime is stopping; no new rebuild can be scheduled.");
    const nextRevision = revision.observed + 1;
    revision = { ...revision, observed: nextRevision, accepted: nextRevision };
    queued = { revision: nextRevision, summary, options: inputOptions ?? {} };
    failure = undefined;
    phase = RuntimeLifecyclePhaseValue.Refreshing;
    activeAbortController?.abort();
    startLoop();
    return nextRevision;
  }

  function startLoop(): void {
    if (loop || stopped) return;
    const running = runLoop().finally(() => {
      if (loop === running) loop = undefined;
      if (queued && !stopped) startLoop();
    });
    loop = running;
  }

  async function runLoop(): Promise<void> {
    while (queued && !stopped) {
      const intent = queued;
      queued = undefined;
      active = intent;
      const abortController = new AbortController();
      activeAbortController = abortController;
      phase = RuntimeLifecyclePhaseValue.Refreshing;
      try {
        const candidate = await options.rebuildNow(intent.summary, intent.options, abortController.signal);
        if (intent.revision === revision.observed) {
          const next = await candidate.commit();
          snapshot = next;
          projectInventory = options.readProjectInventory();
          revision = { ...revision, published: intent.revision };
          phase = RuntimeLifecyclePhaseValue.Ready;
          failure = undefined;
          resolvePublishedWaiters();
        } else {
          await candidate.discard?.();
        }
      } catch (error) {
        if (abortController.signal.aborted && queued) continue;
        const normalized = error instanceof Error ? error : new Error(String(error));
        failure = { revision: intent.revision, message: normalized.message };
        phase = RuntimeLifecyclePhaseValue.Failed;
        rejectWaitersThrough(intent.revision, normalized);
        options.onRebuildError(error);
      } finally {
        if (activeAbortController === abortController) activeAbortController = undefined;
        if (active?.revision === intent.revision) active = undefined;
      }
    }
    if (!stopped && !failure && revision.published === revision.observed) phase = RuntimeLifecyclePhaseValue.Ready;
  }

  function resolvePublishedWaiters(): void {
    for (const waiter of [...waiters]) {
      if (waiter.revision > revision.published) continue;
      waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve(snapshot);
    }
  }

  function rejectWaitersThrough(failedRevision: number, error: Error): void {
    for (const waiter of [...waiters]) {
      if (waiter.revision > failedRevision) continue;
      waiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(error);
    }
  }

  function waitForRevision(target: number, waitOptions: RuntimeWaitOptions = {}): Promise<RuntimeSnapshot> {
    if (!Number.isSafeInteger(target) || target < 1) return Promise.reject(new Error(`Invalid runtime revision: ${target}.`));
    if (revision.published >= target) return Promise.resolve(snapshot);
    if (stopped) return Promise.reject(new Error("Project runtime stopped before the requested revision was published."));
    if (failure && failure.revision >= target && !queued && !active) return Promise.reject(new Error(failure.message));
    return new Promise<RuntimeSnapshot>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish(new Error("Waiting for project runtime revision was cancelled."));
      const finish = (error: Error) => {
        if (!waiters.delete(waiter)) return;
        waiter.cleanup();
        reject(error);
      };
      const waiter: RevisionWaiter = {
        revision: target,
        resolve,
        reject,
        cleanup() {
          if (timer) clearTimeout(timer);
          waitOptions.signal?.removeEventListener("abort", onAbort);
        },
      };
      if (waitOptions.signal?.aborted) {
        reject(new Error("Waiting for project runtime revision was cancelled."));
        return;
      }
      waiters.add(waiter);
      waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
      if (waitOptions.timeoutMs && waitOptions.timeoutMs > 0) {
        timer = setTimeout(() => {
          const state = lifecycle();
          finish(new Error(`Project runtime did not publish revision ${target} within ${waitOptions.timeoutMs}ms. Current lifecycle: ${JSON.stringify(state)}.`));
        }, waitOptions.timeoutMs);
        timer.unref?.();
      }
    });
  }

  return {
    currentSnapshot: () => snapshot,
    setSnapshot(next) {
      snapshot = next;
      return snapshot;
    },
    currentProjectInventory: () => projectInventory,
    validationResultCache: () => validationResultCache,
    replaceValidationResultCache(next) {
      validationResultCache = next;
    },
    lifecycle,
    async rebuildAndPublish(summary, inputOptions) {
      const target = requestRebuild(summary, inputOptions);
      return await waitForRevision(target);
    },
    scheduleRebuild: requestRebuild,
    waitForRevision,
    async waitForIdle(waitOptions = {}) {
      const target = revision.observed;
      if (target > revision.published) await waitForRevision(target, waitOptions);
      while (loop) await loop.catch(() => undefined);
    },
    hasPendingWork() {
      return Boolean(active || queued || loop) || revision.observed !== revision.published;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      activeAbortController?.abort();
      phase = RuntimeLifecyclePhaseValue.Stopping;
      queued = undefined;
      const error = new Error("Project runtime stopped before the requested revision was published.");
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        waiter.cleanup();
        waiter.reject(error);
      }
      phase = RuntimeLifecyclePhaseValue.Stopped;
    },
  };
}
