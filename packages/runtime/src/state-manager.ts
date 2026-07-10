import type { RuntimeSnapshot } from "./snapshot.ts";
import type { ProjectInventory } from "./server-fs.ts";
import type { ValidationResultCache } from "@opencanon/core";

export type RuntimeStateManager = {
  currentSnapshot(): RuntimeSnapshot;
  setSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot;
  currentProjectInventory(): ProjectInventory;
  validationResultCache(): ValidationResultCache;
  replaceValidationResultCache(cache: ValidationResultCache): void;
  rebuildAndPublish(summary: string, options?: RuntimeRebuildOptions): Promise<RuntimeSnapshot>;
  scheduleRebuild(summary: string, options?: RuntimeRebuildOptions): void;
  waitForIdle(): Promise<void>;
  stop(): void;
};

export type RuntimeRebuildOptions = Record<string, never>;

export type RuntimeStateManagerOptions = {
  initialSnapshot: RuntimeSnapshot;
  initialProjectInventory: ProjectInventory;
  initialValidationResultCache: ValidationResultCache;
  maxQueuedRebuilds: number;
  isStopped(): boolean;
  rebuildNow(summary: string, options: RuntimeRebuildOptions): Promise<RuntimeSnapshot>;
  readProjectInventory(): ProjectInventory;
  onRebuildError(error: unknown): void;
};

export function createRuntimeStateManager(options: RuntimeStateManagerOptions): RuntimeStateManager {
  let snapshot = options.initialSnapshot;
  let projectInventory = options.initialProjectInventory;
  let validationResultCache = options.initialValidationResultCache;
  let rebuildInFlight: Promise<RuntimeSnapshot> | undefined;
  let watchRebuildInFlight: Promise<void> | undefined;
  const queuedWatchRebuilds: Array<{ summary: string; options: RuntimeRebuildOptions }> = [];
  const queuedWatchSummarySet = new Set<string>();

  async function rebuildAndPublish(summary: string, inputOptions?: RuntimeRebuildOptions): Promise<RuntimeSnapshot> {
    const rebuildOptions = normalizeRebuildOptions(inputOptions);
    const previous = rebuildInFlight?.catch(() => undefined);
    const current = (async () => {
      await previous;
      const next = await options.rebuildNow(summary, rebuildOptions);
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

  function scheduleRebuild(summary: string, inputOptions?: RuntimeRebuildOptions): void {
    if (options.isStopped()) return;
    queueWatchRebuild(summary, normalizeRebuildOptions(inputOptions));
    startWatchRebuildLoop();
  }

  function queueWatchRebuild(summary: string, rebuildOptions: RuntimeRebuildOptions): void {
    if (queuedWatchSummarySet.has(summary)) return;
    if (queuedWatchRebuilds.length >= options.maxQueuedRebuilds) {
      const removed = queuedWatchRebuilds.shift();
      if (removed) queuedWatchSummarySet.delete(removed.summary);
    }
    queuedWatchRebuilds.push({ summary, options: rebuildOptions });
    queuedWatchSummarySet.add(summary);
  }

  function startWatchRebuildLoop(): void {
    if (watchRebuildInFlight) return;
    watchRebuildInFlight = runQueuedWatchRebuilds().finally(() => {
      watchRebuildInFlight = undefined;
      if (queuedWatchRebuilds.length > 0) startWatchRebuildLoop();
    });
  }

  async function runQueuedWatchRebuilds(): Promise<void> {
    while (queuedWatchRebuilds.length > 0) {
      const queued = queuedWatchRebuilds.shift();
      if (!queued) continue;
      queuedWatchSummarySet.delete(queued.summary);
      try {
        await rebuildAndPublish(queued.summary, queued.options);
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
      queuedWatchRebuilds.length = 0;
      queuedWatchSummarySet.clear();
    },
  };
}

function normalizeRebuildOptions(options: RuntimeRebuildOptions | undefined): Required<RuntimeRebuildOptions> {
  return options ?? {};
}
