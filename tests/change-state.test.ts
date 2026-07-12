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
  validateChangeLifecycleTransition,
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

test("Change closure requires every task to be closed and the parent to be in review", () => {
  const close = event("change-close", ChangeLifecycleEventType.Closed);
  assert.deepEqual(validateChangeLifecycleTransition({ change: BaseChange, event: close, events: [] }), [
    "All tasks must be closed before close: domain (planned), api (planned).",
    "Change status is planned; move it to review before closing.",
  ]);

  const closedTasks = [
    event("domain-close", ChangeTaskEventType.Closed, { taskIds: ["domain"] }),
    event("api-close", ChangeTaskEventType.Closed, { taskIds: ["api"] }),
    event("change-review", ChangeLifecycleEventType.Review),
  ];
  assert.deepEqual(validateChangeLifecycleTransition({ change: BaseChange, event: close, events: closedTasks }), []);
});

test("task transitions require dependencies, ownership state, review, and passing checks", () => {
  const checkedChange = {
    ...BaseChange,
    checks: [{ id: "domain-test", kind: "test", target: "tests/domain.test.ts" }],
    tasks: [
      { id: "domain", title: "Domain model", checks: ["domain-test"] },
      { id: "api", title: "API route", dependsOn: ["domain"] },
    ],
  } as const satisfies Change;
  const claimApi = event("claim-api", ChangeTaskEventType.Claimed, { taskIds: ["api"] });
  assert(validateChangeLifecycleTransition({ change: checkedChange, event: claimApi, events: [] })[1]?.includes("waits for domain"));

  const closeDomain = event("close-domain", ChangeTaskEventType.Closed, { taskIds: ["domain"] });
  const running = [
    event("claim-domain", ChangeTaskEventType.Claimed, { taskIds: ["domain"], timestamp: "2026-07-09T00:00:01.000Z" }),
    event("start-domain", ChangeTaskEventType.Started, { taskIds: ["domain"], timestamp: "2026-07-09T00:00:02.000Z" }),
  ];
  assert(validateChangeLifecycleTransition({ change: checkedChange, event: closeDomain, events: running }).some((issue) => issue.includes("domain-test (unknown)")));

  const reviewed = [
    event("review-domain", ChangeTaskEventType.Review, { taskIds: ["domain"], timestamp: "2026-07-09T00:00:04.000Z" }),
    event("check-domain", ChangeTaskEventType.CheckPassed, { taskIds: ["domain"], checkIds: ["domain-test"], timestamp: "2026-07-09T00:00:03.000Z" }),
    ...running,
  ];
  assert.deepEqual(validateChangeLifecycleTransition({ change: checkedChange, event: closeDomain, events: reviewed }), []);
});

test("closed Changes require an explicit ready event before further task activity", () => {
  const closed = [event("closed", ChangeLifecycleEventType.Closed)];
  const claim = event("claim", ChangeTaskEventType.Claimed, { taskIds: ["domain"] });
  assert.deepEqual(validateChangeLifecycleTransition({ change: BaseChange, event: claim, events: closed }), [
    "Change checkout-flow is closed. Mark the Change ready before recording more task activity.",
  ]);
  const reopened = [...closed, event("ready", ChangeLifecycleEventType.Ready)];
  assert.deepEqual(validateChangeLifecycleTransition({ change: BaseChange, event: claim, events: reopened }), []);
});

function event(
  id: string,
  type: CanonEvent["type"],
  input: {
    summary?: string;
    taskIds?: string[];
    checkIds?: string[];
    timestamp?: string;
  } = {},
): CanonEvent {
  return {
    id,
    type,
    timestamp: input.timestamp ?? "2026-07-09T00:00:00.000Z",
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
