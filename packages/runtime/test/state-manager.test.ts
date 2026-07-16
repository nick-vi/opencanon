import assert from "node:assert/strict";
import { test } from "vitest";
import { DomainProtocolVersion, ProtocolDomain, createEphemeralValidationResultCache, type ProjectProtocolEvent } from "@opencanon/core";
import type { RuntimeChangeCatalog, RuntimeSnapshot } from "../src/snapshot.ts";
import { createRuntimeStateManager } from "../src/state-manager.ts";
import type { ProjectInventory } from "../src/server-fs.ts";

test("RuntimeStateManager serializes rebuilds and publishes only the latest observed revision", async () => {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let latestSummary = "initial";

  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push(summary);
      latestSummary = summary;
      active -= 1;
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory(latestSummary),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  const [first, second] = await Promise.all([
    manager.rebuildAndPublish("first"),
    manager.rebuildAndPublish("second"),
  ]);

  assert.equal(snapshotId(first), "second");
  assert.equal(snapshotId(second), "second");
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(maxActive, 1);
  assert.equal(snapshotId(manager.currentSnapshot()), "second");
  assert.deepEqual(manager.currentProjectInventory(), inventory("second"));
});

test("RuntimeStateManager coalesces queued watch rebuilds to the latest revision", async () => {
  const calls: string[] = [];

  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      calls.push(summary);
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory(calls.at(-1) ?? "initial"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  manager.scheduleRebuild("first");
  manager.scheduleRebuild("second");
  manager.scheduleRebuild("third");
  await manager.waitForIdle();

  assert.deepEqual(calls, ["first", "third"]);
  assert.equal(snapshotId(manager.currentSnapshot()), "third");
  assert.deepEqual(manager.currentProjectInventory(), inventory("third"));
});

test("RuntimeStateManager cancels superseded active analysis and publishes the newest revision", async () => {
  const calls: string[] = [];
  const aborted: string[] = [];
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary, _options, signal) {
      calls.push(summary);
      if (summary === "first") {
        firstStarted();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted.push(summary);
            reject(new Error("superseded"));
          }, { once: true });
        });
      }
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory(calls.at(-1) ?? "initial"),
    onRebuildError() {
      throw new Error("superseded analysis must not publish a failure");
    },
  });

  manager.scheduleRebuild("first");
  await started;
  const latestRevision = manager.scheduleRebuild("second");
  const published = await manager.waitForRevision(latestRevision, { timeoutMs: 1_000 });

  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(aborted, ["first"]);
  assert.equal(snapshotId(published), "second");
  assert.equal(manager.lifecycle().phase, "ready");
  assert.equal(manager.lifecycle().failure, undefined);
});

test("RuntimeStateManager commits only the accepted analysis candidate", async () => {
  const commits: string[] = [];
  const discards: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      if (summary === "first") await firstBlocked;
      const value = snapshot(summary);
      return {
        snapshot: value,
        changeCatalog: catalog(summary),
        commit(revision) {
          commits.push(summary);
          return { snapshot: value, event: publicationEvent(revision) };
        },
        discard() {
          discards.push(summary);
        },
      };
    },
    readProjectInventory: () => inventory("accepted"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  manager.scheduleRebuild("first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const acceptedRevision = manager.scheduleRebuild("second");
  releaseFirst();
  await manager.waitForRevision(acceptedRevision, { timeoutMs: 1_000 });

  assert.deepEqual(commits, ["second"]);
  assert.deepEqual(discards, ["first"]);
  assert.equal(snapshotId(manager.currentSnapshot()), "second");
  assert.equal(manager.currentChangeCatalog().changesPath, "second");
});

test("RuntimeStateManager exposes revision progress and deterministic readiness", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      await blocked;
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory("ready"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  const revision = manager.scheduleRebuild("observed-change");
  assert.deepEqual(manager.lifecycle().revision, { observed: 2, accepted: 2, published: 1 });
  assert.equal(manager.lifecycle().phase, "refreshing");
  assert.equal(manager.lifecycle().settled, false);

  release();
  const published = await manager.waitForRevision(revision, { timeoutMs: 1_000 });
  assert.equal(snapshotId(published), "observed-change");
  assert.deepEqual(manager.lifecycle().revision, { observed: 2, accepted: 2, published: 2 });
  assert.equal(manager.lifecycle().phase, "ready");
  assert.equal(manager.lifecycle().settled, true);
});

test("RuntimeStateManager continues persisted revisions and isolates post-publication observers", async () => {
  const notifications: string[] = [];
  const observerSnapshots: string[] = [];
  let committedRevision = 0;
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("persisted"),
    initialRevision: 7,
    initialChangeCatalog: catalog("persisted"),
    initialProjectInventory: inventory("persisted"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      const value = snapshot(summary);
      return {
        snapshot: value,
        changeCatalog: catalog(summary),
        commit(revision) {
          committedRevision = revision;
          return { snapshot: value, event: publicationEvent(revision) };
        },
        finalizePublished() {
          notifications.push("candidate");
          return snapshot("finalized");
        },
      };
    },
    readProjectInventory: () => inventory("next"),
    onPublished(publication) {
      notifications.push("observer");
      observerSnapshots.push(snapshotId(publication.snapshot));
      throw new Error("observer failed after commit");
    },
    onPublicationNotificationError() {
      notifications.push("reported");
      throw new Error("reporter failed");
    },
    onRebuildError() {
      throw new Error("a committed publication must not become a rebuild failure");
    },
  });

  const published = await manager.rebuildAndPublish("next");

  assert.equal(snapshotId(published), "finalized");
  assert.equal(snapshotId(manager.currentSnapshot()), "finalized");
  assert.equal(committedRevision, 8);
  assert.deepEqual(manager.lifecycle().revision, { observed: 8, accepted: 8, published: 8 });
  assert.deepEqual(notifications, ["candidate", "observer", "reported"]);
  assert.deepEqual(observerSnapshots, ["finalized"]);
});

test("RuntimeStateManager starts exclusive operations only after project analysis settles", async () => {
  const order: string[] = [];
  let releaseAnalysis!: () => void;
  let markAnalysisStarted!: () => void;
  const analysisBlocked = new Promise<void>((resolve) => {
    releaseAnalysis = resolve;
  });
  const analysisStarted = new Promise<void>((resolve) => {
    markAnalysisStarted = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      order.push(`analysis:${summary}`);
      markAnalysisStarted();
      await analysisBlocked;
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory("ready"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  manager.scheduleRebuild("initial-analysis");
  await analysisStarted;
  const operation = manager.runExclusiveOperation("Knowledge indexing", async () => {
    order.push("knowledge:index");
    return "ready";
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["analysis:initial-analysis"]);

  releaseAnalysis();
  assert.equal(await operation, "ready");
  assert.deepEqual(order, ["analysis:initial-analysis", "knowledge:index"]);
  assert.equal(manager.lifecycle().settled, true);
});

test("RuntimeStateManager queues project refresh behind an exclusive operation", async () => {
  const order: string[] = [];
  let releaseOperation!: () => void;
  let markOperationStarted!: () => void;
  const operationBlocked = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const operationStarted = new Promise<void>((resolve) => {
    markOperationStarted = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      order.push(`analysis:${summary}`);
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory("ready"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  const operation = manager.runExclusiveOperation("Knowledge indexing", async () => {
    order.push("knowledge:start");
    markOperationStarted();
    await operationBlocked;
    order.push("knowledge:finish");
  });
  await operationStarted;
  const revision = manager.scheduleRebuild("source-change");
  assert.equal(manager.lifecycle().settled, false);
  await assert.rejects(
    manager.runExclusiveOperation("Second index", async () => undefined),
    /Project operation already running: Knowledge indexing/u,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["knowledge:start"]);

  releaseOperation();
  await operation;
  await manager.waitForRevision(revision, { timeoutMs: 1_000 });
  assert.deepEqual(order, ["knowledge:start", "knowledge:finish", "analysis:source-change"]);
  assert.equal(manager.lifecycle().settled, true);
});

test("RuntimeStateManager revision waits fail with lifecycle diagnostics", async () => {
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow() {
      return await new Promise<ReturnType<typeof candidate>>(() => undefined);
    },
    readProjectInventory: () => inventory("never"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  const revision = manager.scheduleRebuild("blocked");
  await assert.rejects(
    manager.waitForRevision(revision, { timeoutMs: 10 }),
    /Current lifecycle:.*\"observed\":2.*\"published\":1/,
  );
  manager.beginShutdown();
});

test("RuntimeStateManager cancels active analysis and drops queued refreshes before shutdown waits", async () => {
  const calls: string[] = [];
  const rebuildErrors: unknown[] = [];
  let markStarted!: () => void;
  let markAborted!: () => void;
  let releaseCancellation!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const cancellationSettled = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary, _options, signal) {
      calls.push(summary);
      markStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          markAborted();
          void cancellationSettled.then(resolve);
        }, { once: true });
      });
      throw new Error("analysis cancelled");
    },
    readProjectInventory: () => inventory("never"),
    onRebuildError(error) {
      rebuildErrors.push(error);
    },
  });

  manager.scheduleRebuild("active");
  await started;
  const queuedRevision = manager.scheduleRebuild("queued");
  manager.beginShutdown();

  await aborted;
  assert.equal(manager.lifecycle().phase, "stopping");
  assert.equal(manager.lifecycle().failure, undefined);
  await assert.rejects(manager.waitForRevision(queuedRevision), /stopped before the requested revision/u);
  assert.throws(() => manager.scheduleRebuild("late"), /runtime is stopping/u);
  await assert.rejects(
    manager.runExclusiveOperation("late operation", async () => undefined),
    /runtime is stopping/u,
  );

  let idle = false;
  const waiting = manager.waitForIdle({ timeoutMs: 1_000 }).then(() => {
    idle = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(idle, false, "shutdown must wait for the cancelled callback to settle");
  releaseCancellation();
  await waiting;
  manager.finishShutdown();

  assert.deepEqual(calls, ["active"]);
  assert.deepEqual(rebuildErrors, []);
  assert.equal(manager.lifecycle().phase, "stopped");
  assert.equal(manager.hasPendingWork(), false);
});

test("RuntimeStateManager owns cancellation for an active exclusive operation", async () => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  let releaseCancellation!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const cancellationSettled = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory("ready"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  const operation = manager.runExclusiveOperation("Project Knowledge indexing", async (signal) => {
    markStarted();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        markAborted();
        void cancellationSettled.then(resolve);
      }, { once: true });
    });
    throw new Error("index cancelled");
  });
  await started;
  manager.beginShutdown();
  await aborted;
  assert.deepEqual(manager.lifecycle().operation, { label: "Project Knowledge indexing" });

  const rejected = assert.rejects(operation, /index cancelled/u);
  releaseCancellation();
  await rejected;
  await manager.waitForIdle({ timeoutMs: 1_000 });
  manager.finishShutdown();

  assert.equal(manager.lifecycle().operation, undefined);
  assert.equal(manager.lifecycle().phase, "stopped");
});

test("RuntimeStateManager reports an explicit timeout when owned work ignores cancellation", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialRevision: 1,
    initialChangeCatalog: catalog("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    async rebuildNow(summary) {
      return candidate(snapshot(summary));
    },
    readProjectInventory: () => inventory("ready"),
    onRebuildError() {
      throw new Error("unexpected rebuild error");
    },
  });

  void manager.runExclusiveOperation("Non-cooperative operation", async () => {
    markStarted();
    return await new Promise<never>(() => undefined);
  });
  await started;
  manager.beginShutdown();

  await assert.rejects(
    manager.waitForIdle({ timeoutMs: 10 }),
    /did not become idle within .*"operation":\{"label":"Non-cooperative operation"\}/u,
  );
  assert.throws(() => manager.finishShutdown(), /cannot finish shutdown while work is active/u);
  assert.equal(manager.lifecycle().phase, "stopping");
});

function snapshot(id: string): RuntimeSnapshot {
  return { id } as unknown as RuntimeSnapshot;
}

function candidate(value: RuntimeSnapshot) {
  const id = snapshotId(value);
  return {
    snapshot: value,
    changeCatalog: catalog(id),
    commit: (revision: number) => ({ snapshot: value, event: publicationEvent(revision) }),
  };
}

function publicationEvent(revision: number): ProjectProtocolEvent {
  return {
    protocolVersion: DomainProtocolVersion,
    sequence: revision,
    timestamp: "2026-07-16T14:00:00.000Z",
    revision,
    domain: ProtocolDomain.Project,
    type: "published",
    summary: "Published Project State.",
    ids: [],
  };
}

function catalog(id: string): RuntimeChangeCatalog {
  return { rootDir: "/project", changesPath: id, changes: [] };
}

function inventory(id: string): ProjectInventory {
  return { ok: true, files: [`${id}.ts`] };
}

function snapshotId(input: RuntimeSnapshot): string {
  return (input as unknown as { id: string }).id;
}
