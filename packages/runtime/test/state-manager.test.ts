import assert from "node:assert/strict";
import { test } from "vitest";
import { createEphemeralValidationResultCache } from "@opencanon/core";
import type { RuntimeSnapshot } from "../src/snapshot.ts";
import { createRuntimeStateManager } from "../src/state-manager.ts";
import type { ProjectInventory } from "../src/server-fs.ts";

test("RuntimeStateManager serializes rebuilds and refreshes owned state", async () => {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let latestSummary = "initial";

  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    maxQueuedRebuilds: 5,
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

  assert.equal(snapshotId(first), "first");
  assert.equal(snapshotId(second), "second");
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(maxActive, 1);
  assert.equal(snapshotId(manager.currentSnapshot()), "second");
  assert.deepEqual(manager.currentProjectInventory(), inventory("second"));
});

test("RuntimeStateManager runs queued watch rebuilds serially and publishes the latest state", async () => {
  const calls: string[] = [];

  const manager = createRuntimeStateManager({
    initialSnapshot: snapshot("initial"),
    initialProjectInventory: inventory("initial"),
    initialValidationResultCache: createEphemeralValidationResultCache(),
    maxQueuedRebuilds: 5,
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

  assert.deepEqual(calls, ["first", "second", "third"]);
  assert.equal(snapshotId(manager.currentSnapshot()), "third");
  assert.deepEqual(manager.currentProjectInventory(), inventory("third"));
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
