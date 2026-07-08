import type { RuntimeSnapshot } from "./snapshot.ts";
import type { ProjectInventory } from "./server-fs.ts";
import type { ValidationResultCache } from "@opencanon/core";

export type RuntimeStateManager = {
  currentSnapshot(): RuntimeSnapshot;
  setSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot;
  currentProjectInventory(): ProjectInventory;
  validationResultCache(): ValidationResultCache;
  replaceValidationResultCache(cache: ValidationResultCache): void;
  rebuildAndPublish(summary: string): Promise<RuntimeSnapshot>;
  scheduleRebuild(summary: string): void;
  waitForIdle(): Promise<void>;
  stop(): void;
};

export type RuntimeStateManagerOptions = {
  initialSnapshot: RuntimeSnapshot;
  initialProjectInventory: ProjectInventory;
  initialValidationResultCache: ValidationResultCache;
  maxQueuedRebuilds: number;
  isStopped(): boolean;
  rebuildNow(summary: string): Promise<RuntimeSnapshot>;
  readProjectInventory(): ProjectInventory;
  onRebuildError(error: unknown): void;
};

export function createRuntimeStateManager(options: RuntimeStateManagerOptions): RuntimeStateManager {
  let snapshot = options.initialSnapshot;
  let projectInventory = options.initialProjectInventory;
  let validationResultCache = options.initialValidationResultCache;
  let rebuildInFlight: Promise<RuntimeSnapshot> | undefined;
  let watchRebuildInFlight: Promise<void> | undefined;
  const queuedWatchSummaries: string[] = [];
  const queuedWatchSummarySet = new Set<string>();

  async function rebuildAndPublish(summary: string): Promise<RuntimeSnapshot> {
    const previous = rebuildInFlight?.catch(() => undefined);
    const current = (async () => {
      await previous;
      const next = await options.rebuildNow(summary);
      projectInventory = options.readProjectInventory();
      snapshot = next;
      return snapshot;
    })();
    const tracked = current.finally(() => {
      if (rebuildInFlight === tracked) rebuildInFlight = undefined;
    });
    rebuildInFlight = tracked;
    return tracked;
  }

  function scheduleRebuild(summary: string): void {
    if (options.isStopped()) return;
    queueWatchSummary(summary);
    startWatchRebuildLoop();
  }

  function queueWatchSummary(summary: string): void {
    if (queuedWatchSummarySet.has(summary)) return;
    if (queuedWatchSummaries.length >= options.maxQueuedRebuilds) {
      const removed = queuedWatchSummaries.shift();
      if (removed) queuedWatchSummarySet.delete(removed);
    }
    queuedWatchSummaries.push(summary);
    queuedWatchSummarySet.add(summary);
  }

  function startWatchRebuildLoop(): void {
    if (watchRebuildInFlight) return;
    watchRebuildInFlight = runQueuedWatchRebuilds().finally(() => {
      watchRebuildInFlight = undefined;
      if (queuedWatchSummaries.length > 0) startWatchRebuildLoop();
    });
  }

  async function runQueuedWatchRebuilds(): Promise<void> {
    while (queuedWatchSummaries.length > 0) {
      const summary = queuedWatchSummaries.shift();
      if (!summary) continue;
      queuedWatchSummarySet.delete(summary);
      try {
        await rebuildAndPublish(summary);
      } catch (error) {
        options.onRebuildError(error);
      }
    }
  }

  return {
    currentSnapshot() {
      return snapshot;
    },
    setSnapshot(next) {
      snapshot = next;
      return snapshot;
    },
    currentProjectInventory() {
      return projectInventory;
    },
    validationResultCache() {
      return validationResultCache;
    },
    replaceValidationResultCache(next) {
      validationResultCache = next;
    },
    rebuildAndPublish,
    scheduleRebuild,
    async waitForIdle() {
      if (rebuildInFlight) await rebuildInFlight.catch(() => undefined);
      if (watchRebuildInFlight) await watchRebuildInFlight.catch(() => undefined);
    },
    stop() {
      queuedWatchSummaries.length = 0;
      queuedWatchSummarySet.clear();
    },
  };
}
