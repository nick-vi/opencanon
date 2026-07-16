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
    isStopped: () => false,
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
    isStopped: () => false,
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
    isStopped: () => false,
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
    isStopped: () => false,
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
    isStopped: () => false,
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
  let committedRevision = 0;
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("persisted"),
    initialRevision: 7,
    initialChangeCatalog: catalog("persisted"),
    initialProjectInventory: inventory("persisted"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    isStopped: () => false,
    async rebuildNow(summary) {
      const value = snapshot(summary);
      return {
        snapshot: value,
        changeCatalog: catalog(summary),
        commit(revision) {
          committedRevision = revision;
          return { snapshot: value, event: publicationEvent(revision) };
        },
        afterPublished() {
          notifications.push("candidate");
        },
      };
    },
    readProjectInventory: () => inventory("next"),
    onPublished() {
      notifications.push("observer");
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

  assert.equal(snapshotId(published), "next");
  assert.equal(committedRevision, 8);
  assert.deepEqual(manager.lifecycle().revision, { observed: 8, accepted: 8, published: 8 });
  assert.deepEqual(notifications, ["observer", "reported", "candidate"]);
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
    isStopped: () => false,
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
    isStopped: () => false,
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
    isStopped: () => false,
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
  manager.stop();
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
