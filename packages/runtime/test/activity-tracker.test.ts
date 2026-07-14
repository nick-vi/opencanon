import assert from "node:assert/strict";
import { test } from "vitest";
import { createRuntimeActivityTracker } from "../src/activity-tracker.ts";

test("runtime activity leases release exactly once", () => {
  let changes = 0;
  const tracker = createRuntimeActivityTracker(() => {
    changes += 1;
  });
  const release = tracker.begin("request");
  assert.equal(tracker.count(), 1);
  assert.deepEqual(tracker.labels(), ["request"]);
  release();
  release();
  assert.equal(tracker.count(), 0);
  assert.equal(changes, 2);
});

test("runtime activity leases track concurrent transports independently", () => {
  const tracker = createRuntimeActivityTracker();
  const releaseHttp = tracker.begin("http");
  const releasePipe = tracker.begin("pipe");
  assert.equal(tracker.count(), 2);
  releaseHttp();
  assert.deepEqual(tracker.labels(), ["pipe"]);
  releasePipe();
  assert.equal(tracker.count(), 0);
});
