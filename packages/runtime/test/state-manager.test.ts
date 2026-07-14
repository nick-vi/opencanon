import assert from "node:assert/strict";
import { test } from "vitest";
import { createEphemeralValidationResultCache } from "@opencanon/core";
import type { RuntimeSnapshot } from "../src/snapshot.ts";
import { createRuntimeStateManager } from "../src/state-manager.ts";
import type { ProjectInventory } from "../src/server-fs.ts";

test("RuntimeStateManager serializes rebuilds and publishes only the latest observed revision", async () => {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let latestSummary = "initial";

  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
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
      return snapshot(summary);
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
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    isStopped: () => false,
    async rebuildNow(summary) {
      calls.push(summary);
      return snapshot(summary);
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

test("RuntimeStateManager exposes revision progress and deterministic readiness", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    isStopped: () => false,
    async rebuildNow(summary) {
      await blocked;
      return snapshot(summary);
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

test("RuntimeStateManager revision waits fail with lifecycle diagnostics", async () => {
  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    isStopped: () => false,
    async rebuildNow() {
      return await new Promise<RuntimeSnapshot>(() => undefined);
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

function inventory(id: string): ProjectInventory {
  return { ok: true, files: [`${id}.ts`] };
}

function snapshotId(input: RuntimeSnapshot): string {
  return (input as unknown as { id: string }).id;
}
