import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ChangeCheckEventType,
  ChangeLifecycleEventType,
  ChangeTaskEventType,
  ChangeWorkStatus,
  deriveChangeTaskStates,
  deriveChangeWorkQueue,
  deriveChangeWorkStatus,
  type CanonEvent,
  type Change,
} from "@opencanon/core";

const BaseChange = {
  id: "checkout-flow",
  title: "Checkout Flow",
  kind: "feature",
  intent: {
    problem: "Checkout work is not tracked.",
    outcome: "Checkout work is tracked by tasks.",
  },
  tasks: [
    { id: "domain", title: "Domain model" },
    { id: "api", title: "API route", dependsOn: ["domain"] },
  ],
  render: { kind: "none" },
} as const satisfies Change;

test("task lifecycle events do not close the parent Change", () => {
  const events = [
    event("task-1", ChangeTaskEventType.Closed, {
      taskIds: ["domain"],
      summary: "Closed domain task.",
    }),
  ];

  assert.equal(deriveChangeWorkStatus(BaseChange.id, events), ChangeWorkStatus.Planned);

  const tasks = deriveChangeTaskStates(BaseChange, events);
  assert.equal(tasks.find((task) => task.id === "domain")?.status, ChangeWorkStatus.Closed);
  assert.equal(tasks.find((task) => task.id === "api")?.ready, true);

  const queue = deriveChangeWorkQueue([BaseChange], events);
  assert.deepEqual(queue.ready.map((item) => item.taskId), ["api"]);
  assert.equal(queue.blocked.length, 0);
});

test("only Change-level lifecycle and check events move the parent Change", () => {
  assert.equal(deriveChangeWorkStatus(BaseChange.id, [event("change-start", ChangeLifecycleEventType.Started)]), ChangeWorkStatus.Running);
  assert.equal(deriveChangeWorkStatus(BaseChange.id, [event("change-close", ChangeLifecycleEventType.Closed)]), ChangeWorkStatus.Closed);
  assert.equal(deriveChangeWorkStatus(BaseChange.id, [event("check-pass", ChangeCheckEventType.Passed, { checkIds: ["release"] })]), ChangeWorkStatus.Ready);
});

function event(
  id: string,
  type: CanonEvent["type"],
  input: {
    summary?: string;
    taskIds?: string[];
    checkIds?: string[];
  } = {},
): CanonEvent {
  return {
    id,
    type,
    timestamp: "2026-07-09T00:00:00.000Z",
    files: [],
    changeIds: [BaseChange.id],
    taskIds: input.taskIds ?? [],
    checkIds: input.checkIds ?? [],
    conventionIds: [],
    validatorIds: [],
    findingIds: [],
    summary: input.summary ?? id,
  };
}
