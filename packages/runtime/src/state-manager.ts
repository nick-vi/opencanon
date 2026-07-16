import type { RuntimeChangeCatalog, RuntimeSnapshot } from "./snapshot.ts";
import type { ProjectInventory } from "./server-fs.ts";
import {
  RuntimeLifecyclePhaseValue,
  type ProjectProtocolEvent,
  type RuntimeLifecycleState,
  type RuntimeRevision,
  type ValidationResultCache,
} from "@opencanon/core";

export type RuntimeWaitOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RuntimeStateManager = {
  currentSnapshot(): RuntimeSnapshot;
  setSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot;
  currentChangeCatalog(): RuntimeChangeCatalog;
  currentProjectInventory(): ProjectInventory;
  validationResultCache(): ValidationResultCache;
  replaceValidationResultCache(cache: ValidationResultCache): void;
  lifecycle(): RuntimeLifecycleState;
  rebuildAndPublish(summary: string, options?: RuntimeRebuildOptions): Promise<RuntimeSnapshot>;
  scheduleRebuild(summary: string, options?: RuntimeRebuildOptions): number;
  runExclusiveOperation<T>(label: string, operation: (signal: AbortSignal) => Promise<T>, options?: RuntimeWaitOptions): Promise<T>;
  waitForRevision(revision: number, options?: RuntimeWaitOptions): Promise<RuntimeSnapshot>;
  waitForIdle(options?: RuntimeWaitOptions): Promise<void>;
  hasPendingWork(): boolean;
  beginShutdown(): void;
  finishShutdown(): void;
};

export type RuntimeRebuildOptions = Record<string, never>;

export type RuntimeRebuildCandidate = {
  snapshot: RuntimeSnapshot;
  changeCatalog: RuntimeChangeCatalog;
  commit(revision: number): RuntimeRebuildPublication;
  finalizePublished?(snapshot: RuntimeSnapshot): RuntimeSnapshot;
  discard?(): Promise<void> | void;
};

export type RuntimeRebuildPublication = {
  snapshot: RuntimeSnapshot;
  event: ProjectProtocolEvent;
};

export type RuntimeStateManagerOptions = {
  initialSnapshot: RuntimeSnapshot;
  initialRevision: number;
  initialChangeCatalog: RuntimeChangeCatalog;
  initialProjectInventory: ProjectInventory;
  initialValidationResultCache: ValidationResultCache;
  rebuildNow(summary: string, options: RuntimeRebuildOptions, signal: AbortSignal): Promise<RuntimeRebuildCandidate>;
  readProjectInventory(): ProjectInventory;
  onPublished?(input: { revision: number; snapshot: RuntimeSnapshot; summary: string; event: ProjectProtocolEvent }): void;
  onPublicationNotificationError?(error: unknown): void;
  onRebuildError(error: unknown): void;
};

type RebuildIntent = { revision: number; summary: string; options: RuntimeRebuildOptions };
type RevisionWaiter = {
  revision: number;
  resolve(snapshot: RuntimeSnapshot): void;
  reject(error: Error): void;
  cleanup(): void;
};
const RuntimeShutdownStateValue = {
  Running: "running",
  Stopping: "stopping",
  Stopped: "stopped",
} as const;
type RuntimeShutdownState = (typeof RuntimeShutdownStateValue)[keyof typeof RuntimeShutdownStateValue];
type ExclusiveOperation = {
  label: string;
  controller: AbortController;
  completion: Promise<void>;
  resolveCompletion(): void;
  detachCallerSignal(): void;
};

export function createRuntimeStateManager(options: RuntimeStateManagerOptions): RuntimeStateManager {
  let snapshot = options.initialSnapshot;
  let changeCatalog = options.initialChangeCatalog;
  let projectInventory = options.initialProjectInventory;
  let validationResultCache = options.initialValidationResultCache;
  if (!Number.isSafeInteger(options.initialRevision) || options.initialRevision < 1) {
    throw new Error("Project runtime initial revision must be a positive safe integer.");
  }
  let revision: RuntimeRevision = {
    observed: options.initialRevision,
    accepted: options.initialRevision,
    published: options.initialRevision,
  };
  let phase: RuntimeLifecycleState["phase"] = RuntimeLifecyclePhaseValue.TransportReady;
  let active: RebuildIntent | undefined;
  let queued: RebuildIntent | undefined;
  let failure: RuntimeLifecycleState["failure"];
  let loop: Promise<void> | undefined;
  let activeAbortController: AbortController | undefined;
  let exclusiveOperation: ExclusiveOperation | undefined;
  let shutdownState: RuntimeShutdownState = RuntimeShutdownStateValue.Running;
  const waiters = new Set<RevisionWaiter>();

  function lifecycle(): RuntimeLifecycleState {
    return {
      phase,
      revision: { ...revision },
      settled:
        phase === RuntimeLifecyclePhaseValue.Ready
        && !active
        && !queued
        && !exclusiveOperation
        && revision.observed === revision.published,
      ...(active ? { active: { revision: active.revision, summary: active.summary } } : {}),
      ...(queued ? { queued: { revision: queued.revision, summary: queued.summary } } : {}),
      ...(exclusiveOperation ? { operation: { label: exclusiveOperation.label } } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  function requestRebuild(summary: string, inputOptions?: RuntimeRebuildOptions): number {
    assertAcceptingWork("rebuild");
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
    if (loop || shutdownState !== RuntimeShutdownStateValue.Running || exclusiveOperation) return;
    const running = runLoop().finally(() => {
      if (loop === running) loop = undefined;
      if (queued && shutdownState === RuntimeShutdownStateValue.Running && !exclusiveOperation) startLoop();
    });
    loop = running;
  }

  async function runLoop(): Promise<void> {
    while (queued && shutdownState === RuntimeShutdownStateValue.Running && !exclusiveOperation) {
      const intent = queued;
      queued = undefined;
      active = intent;
      const abortController = new AbortController();
      activeAbortController = abortController;
      phase = RuntimeLifecyclePhaseValue.Refreshing;
      try {
        const candidate = await options.rebuildNow(intent.summary, intent.options, abortController.signal);
        if (shutdownState !== RuntimeShutdownStateValue.Running) {
          await candidate.discard?.();
        } else if (intent.revision === revision.observed) {
          const publication = candidate.commit(intent.revision);
          snapshot = publication.snapshot;
          changeCatalog = candidate.changeCatalog;
          projectInventory = options.readProjectInventory();
          revision = { ...revision, published: intent.revision };
          phase = RuntimeLifecyclePhaseValue.Ready;
          failure = undefined;
          try {
            if (candidate.finalizePublished) snapshot = candidate.finalizePublished(snapshot);
          } catch (error) {
            reportPublicationNotificationError(error);
          }
          try {
            options.onPublished?.({
              revision: intent.revision,
              snapshot,
              summary: intent.summary,
              event: publication.event,
            });
          } catch (error) {
            reportPublicationNotificationError(error);
          }
          resolvePublishedWaiters();
        } else {
          await candidate.discard?.();
        }
      } catch (error) {
        if (abortController.signal.aborted && (queued || shutdownState !== RuntimeShutdownStateValue.Running)) continue;
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
    if (shutdownState === RuntimeShutdownStateValue.Running && !failure && revision.published === revision.observed) phase = RuntimeLifecyclePhaseValue.Ready;
  }

  function resolvePublishedWaiters(): void {
    for (const waiter of [...waiters]) {
      if (waiter.revision > revision.published) continue;
      waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve(snapshot);
    }
  }

  function reportPublicationNotificationError(error: unknown): void {
    try {
      options.onPublicationNotificationError?.(error);
    } catch {
      // Publication is already durable; observer failures cannot roll it back or stop the coordinator.
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
    if (shutdownState !== RuntimeShutdownStateValue.Running) return Promise.reject(shutdownRevisionError());
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

  async function waitForRebuildIdle(waitOptions: RuntimeWaitOptions): Promise<void> {
    while (shutdownState === RuntimeShutdownStateValue.Running) {
      const target = revision.observed;
      if (target > revision.published) await waitForRevision(target, waitOptions);
      const runningLoop = loop;
      if (runningLoop) await awaitOperationSettlement(runningLoop, waitOptions, `Project analysis did not settle`);
      if (!active && !queued && revision.observed === revision.published) return;
    }
    throw new Error("Project runtime is stopping; no new project operation can start.");
  }

  function assertAcceptingWork(kind: string): void {
    if (shutdownState !== RuntimeShutdownStateValue.Running) throw new Error(`Project runtime is stopping; no new ${kind} can start.`);
  }

  function operationInProgress(): ExclusiveOperation | undefined {
    return exclusiveOperation;
  }

  return {
    currentSnapshot: () => snapshot,
    setSnapshot(next) {
      snapshot = next;
      return snapshot;
    },
    currentChangeCatalog: () => changeCatalog,
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
    async runExclusiveOperation(label, operation, waitOptions = {}) {
      assertAcceptingWork("project operation");
      const activeOperation = operationInProgress();
      if (activeOperation) throw new Error(`Project operation already running: ${activeOperation.label}.`);
      await waitForRebuildIdle(waitOptions);
      assertAcceptingWork("project operation");
      const concurrentOperation = operationInProgress();
      if (concurrentOperation) throw new Error(`Project operation already running: ${concurrentOperation.label}.`);
      if (waitOptions.signal?.aborted) throw new Error("Project operation was cancelled before it started.");
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort(waitOptions.signal?.reason);
      waitOptions.signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (waitOptions.signal?.aborted) controller.abort(waitOptions.signal.reason);
      let resolveCompletion!: () => void;
      const current: ExclusiveOperation = {
        label,
        controller,
        completion: new Promise<void>((resolve) => {
          resolveCompletion = resolve;
        }),
        resolveCompletion: () => resolveCompletion(),
        detachCallerSignal: () => waitOptions.signal?.removeEventListener("abort", onCallerAbort),
      };
      exclusiveOperation = current;
      try {
        return await operation(controller.signal);
      } finally {
        current.detachCallerSignal();
        if (exclusiveOperation === current) exclusiveOperation = undefined;
        current.resolveCompletion();
        if (queued && shutdownState === RuntimeShutdownStateValue.Running) startLoop();
      }
    },
    waitForRevision,
    async waitForIdle(waitOptions = {}) {
      const deadline = waitOptions.timeoutMs && waitOptions.timeoutMs > 0 ? Date.now() + waitOptions.timeoutMs : undefined;
      while (active || queued || loop || exclusiveOperation) {
        const pending = loop ?? exclusiveOperation?.completion;
        if (!pending) continue;
        const remaining = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
        await awaitOperationSettlement(
          pending,
          { ...waitOptions, ...(remaining === undefined ? {} : { timeoutMs: remaining }) },
          `Project runtime did not become idle`,
        );
      }
    },
    hasPendingWork() {
      return Boolean(active || queued || loop || exclusiveOperation)
        || (shutdownState === RuntimeShutdownStateValue.Running && revision.observed !== revision.published);
    },
    beginShutdown() {
      if (shutdownState !== RuntimeShutdownStateValue.Running) return;
      shutdownState = RuntimeShutdownStateValue.Stopping;
      phase = RuntimeLifecyclePhaseValue.Stopping;
      queued = undefined;
      activeAbortController?.abort();
      exclusiveOperation?.controller.abort();
      const error = shutdownRevisionError();
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        waiter.cleanup();
        waiter.reject(error);
      }
    },
    finishShutdown() {
      if (shutdownState === RuntimeShutdownStateValue.Running) throw new Error("Project runtime shutdown has not started.");
      if (active || queued || loop || exclusiveOperation) {
        throw new Error(`Project runtime cannot finish shutdown while work is active. Current lifecycle: ${JSON.stringify(lifecycle())}.`);
      }
      shutdownState = RuntimeShutdownStateValue.Stopped;
      phase = RuntimeLifecyclePhaseValue.Stopped;
    },
  };

  function shutdownRevisionError(): Error {
    return new Error("Project runtime stopped before the requested revision was published.");
  }

  async function awaitOperationSettlement(
    operation: Promise<unknown>,
    waitOptions: RuntimeWaitOptions,
    timeoutPrefix: string,
  ): Promise<void> {
    if (waitOptions.signal?.aborted) throw new Error("Waiting for project operations was cancelled.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Waiting for project operations was cancelled."));
      waitOptions.signal?.addEventListener("abort", onAbort, { once: true });
      if (waitOptions.timeoutMs && waitOptions.timeoutMs > 0) {
        timer = setTimeout(() => {
          reject(new Error(`${timeoutPrefix} within ${waitOptions.timeoutMs}ms. Current lifecycle: ${JSON.stringify(lifecycle())}.`));
        }, waitOptions.timeoutMs);
        timer.unref?.();
      }
    });
    try {
      await Promise.race([operation, interruption]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) waitOptions.signal?.removeEventListener("abort", onAbort);
    }
  }
}
