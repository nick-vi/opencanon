import type { CanonEvent } from "./contracts.ts";
import type { Change, ChangeCheck, ChangeTask } from "./change.ts";
import { TaskLeaseStatus, type TaskLeaseSummary } from "./worktree.ts";

export const ChangeTaskEventType = {
  Claimed: "task-claimed",
  Started: "task-started",
  Review: "task-review",
  Blocked: "task-blocked",
  Ready: "task-ready",
  Closed: "task-closed",
  CheckStarted: "task-check-started",
  CheckPassed: "task-check-passed",
  CheckFailed: "task-check-failed",
} as const;
export type ChangeTaskEventType = (typeof ChangeTaskEventType)[keyof typeof ChangeTaskEventType];

export const ChangeLifecycleEventType = {
  Started: "change-started",
  Review: "change-review",
  Blocked: "change-blocked",
  Ready: "change-ready",
  Closed: "change-closed",
} as const;
export type ChangeLifecycleEventType = (typeof ChangeLifecycleEventType)[keyof typeof ChangeLifecycleEventType];

export const ChangeCheckEventType = {
  Started: "check-started",
  Passed: "check-passed",
  Failed: "check-failed",
} as const;
export type ChangeCheckEventType = (typeof ChangeCheckEventType)[keyof typeof ChangeCheckEventType];

export const ChangeWorkStatus = {
  Planned: "planned",
  Claimed: "claimed",
  Running: "running",
  Review: "review",
  Blocked: "blocked",
  Ready: "ready",
  Closed: "closed",
} as const;
export type ChangeWorkStatus = (typeof ChangeWorkStatus)[keyof typeof ChangeWorkStatus];

export const ChangeCheckStatus = {
  Unknown: "unknown",
  Running: "running",
  Passed: "passed",
  Failed: "failed",
} as const;
export type ChangeCheckStatus = (typeof ChangeCheckStatus)[keyof typeof ChangeCheckStatus];

export type ChangeCheckState = {
  id: string;
  kind: ChangeCheck["kind"];
  status: ChangeCheckStatus;
  latestEvent?: ChangeEventSummary;
};

export type NormalizedChangeUpdates = {
  areas: string[];
  specs: string[];
  conventions: string[];
  surfaces: string[];
  docs: string[];
};

export type ChangeEventSummary = {
  id: string;
  type: CanonEvent["type"];
  timestamp: string;
  summary: string;
  actor?: string;
};

export type ChangeTaskState = {
  id: string;
  title: string;
  detail?: string;
  files: string[];
  surfaces: string[];
  checks: string[];
  dependsOn: string[];
  blockedBy: string[];
  updates: NormalizedChangeUpdates;
  status: ChangeWorkStatus;
  ready: boolean;
  blockedReasons: string[];
  lease?: TaskLeaseSummary;
  checkStates: ChangeCheckState[];
  latestEvent?: ChangeEventSummary;
};

export type ChangeReadyWorkItem = {
  kind: "change" | "task";
  changeId: string;
  changeTitle: string;
  taskId?: string;
  taskTitle?: string;
  checks: string[];
  files: string[];
  surfaces: string[];
  updates: NormalizedChangeUpdates;
  suggestedCommands: string[];
  reason: string;
};

export type ChangeBlockedWorkItem = ChangeReadyWorkItem & {
  blockedReasons: string[];
};

export type ChangeWorkQueue = {
  ready: ChangeReadyWorkItem[];
  blocked: ChangeBlockedWorkItem[];
};

export type ChangeLifecycleTransitionInput = {
  change: Change;
  event: CanonEvent;
  events: readonly CanonEvent[];
  leases?: readonly TaskLeaseSummary[];
};

const EmptyUpdates: NormalizedChangeUpdates = {
  areas: [],
  specs: [],
  conventions: [],
  surfaces: [],
  docs: [],
};

const taskLifecycleEventTypes = new Set<string>([
  ChangeTaskEventType.Claimed,
  ChangeTaskEventType.Started,
  ChangeTaskEventType.Review,
  ChangeTaskEventType.Blocked,
  ChangeTaskEventType.Ready,
  ChangeTaskEventType.Closed,
]);

const taskCheckEventTypes = new Set<string>([
  ChangeTaskEventType.CheckStarted,
  ChangeTaskEventType.CheckPassed,
  ChangeTaskEventType.CheckFailed,
]);

const changeLifecycleEventTypes = new Set<string>(Object.values(ChangeLifecycleEventType));
const changeCheckEventTypes = new Set<string>(Object.values(ChangeCheckEventType));

export function deriveChangeTaskStates(change: Change, events: readonly CanonEvent[], options: { leases?: readonly TaskLeaseSummary[] } = {}): ChangeTaskState[] {
  const tasks = change.tasks ?? [];
  const byId = new Map<string, ChangeTaskState>();
  const checkById = new Map((change.checks ?? []).map((check) => [check.id, check]));
  const leaseByTaskId = activeLeaseByTaskId(change.id, options.leases ?? []);

  for (const task of tasks) {
    const checkStates = (task.checks ?? []).map((checkId) => {
      const check = checkById.get(checkId);
      const latestEvent = latestEventForCheck(events, change.id, checkId, task.id);
      return {
        id: checkId,
        kind: check?.kind ?? "command",
        status: checkStatusFromEvent(latestEvent),
        ...(latestEvent ? { latestEvent: summarizeEvent(latestEvent) } : {}),
      } satisfies ChangeCheckState;
    });
    const latestEvent = latestEventForTask(events, change.id, task.id);
    const lease = leaseByTaskId.get(task.id);
    const status = taskStatusFromEvents(latestEvent, checkStates, lease);
    byId.set(task.id, {
      id: task.id,
      title: task.title,
      ...(task.detail ? { detail: task.detail } : {}),
      files: task.files ?? [],
      surfaces: task.surfaces ?? [],
      checks: task.checks ?? [],
      dependsOn: task.dependsOn ?? [],
      blockedBy: task.blockedBy ?? [],
      updates: normalizeTaskUpdates(task.updates),
      status,
      ready: false,
      blockedReasons: [],
      ...(lease ? { lease } : {}),
      checkStates,
      ...(latestEvent ? { latestEvent: summarizeEvent(latestEvent) } : {}),
    });
  }

  for (const task of byId.values()) {
    const blockedReasons = taskBlockers(task, byId);
    task.blockedReasons = blockedReasons;
    task.ready = task.status === ChangeWorkStatus.Planned && !task.lease && blockedReasons.length === 0;
  }

  return [...byId.values()];
}

export function deriveChangeWorkQueue(changes: readonly Change[], events: readonly CanonEvent[], options: { leases?: readonly TaskLeaseSummary[] } = {}): ChangeWorkQueue {
  const changeStatusById = new Map(changes.map((change) => [change.id, deriveChangeWorkStatus(change.id, events)]));
  const leases = options.leases ?? [];
  const ready: ChangeReadyWorkItem[] = [];
  const blocked: ChangeBlockedWorkItem[] = [];

  for (const change of changes) {
    const changeBlockers = changeDependencyBlockers(change, changeStatusById);
    if (change.tasks && change.tasks.length > 0) {
      const tasks = deriveChangeTaskStates(change, events, { leases });
      for (const task of tasks) {
        const reasons = [...changeBlockers, ...task.blockedReasons];
        const item = taskQueueItem(change, task);
        if (task.ready && reasons.length === 0) ready.push(item);
        else if (task.status !== ChangeWorkStatus.Closed && reasons.length > 0) blocked.push({ ...item, blockedReasons: reasons });
      }
      continue;
    }

    const status = changeStatusById.get(change.id) ?? ChangeWorkStatus.Planned;
    const item: ChangeReadyWorkItem = {
      kind: "change",
      changeId: change.id,
      changeTitle: change.title,
      checks: (change.checks ?? []).map((check) => check.id),
      files: [],
      surfaces: change.updates?.surfaces ?? [],
      updates: normalizeTaskUpdates(change.updates),
      suggestedCommands: [
        `opencanon changes show ${change.id} --format json`,
        `opencanon changes start ${change.id}`,
        ...(change.checks && change.checks.length > 0 ? [`opencanon changes check ${change.id} --all`] : []),
      ],
      reason: "Change has no task graph and no unresolved dependencies.",
    };
    if (status === ChangeWorkStatus.Planned && changeBlockers.length === 0) ready.push(item);
    else if (status !== ChangeWorkStatus.Closed && changeBlockers.length > 0) blocked.push({ ...item, blockedReasons: changeBlockers });
  }

  return { ready, blocked };
}

export function deriveChangeWorkStatus(changeId: string, events: readonly CanonEvent[]): ChangeWorkStatus {
  return changeStatusFromEvent(latestLifecycleOrCheckEventForChange(events, changeId));
}

export function validateChangeLifecycleTransition(input: ChangeLifecycleTransitionInput): string[] {
  const { change, event, events } = input;
  if (!(event.changeIds ?? []).includes(change.id)) return [`Event ${event.id} does not target Change ${change.id}.`];
  const changeStatus = deriveChangeWorkStatus(change.id, events);
  const taskId = event.taskIds?.[0];
  const taskStates = deriveChangeTaskStates(change, events, { leases: input.leases ?? [] });

  if (taskId) {
    const task = taskStates.find((item) => item.id === taskId);
    if (!task) return [`Unknown task ${taskId} for Change ${change.id}.`];
    if (changeStatus === ChangeWorkStatus.Closed) {
      return [`Change ${change.id} is closed. Mark the Change ready before recording more task activity.`];
    }
    if (task.status === ChangeWorkStatus.Closed) return [`Task ${task.id} in ${change.id} is already closed.`];

    const dependencyIssues = task.blockedReasons;
    switch (event.type) {
      case ChangeTaskEventType.Claimed:
        return task.status === ChangeWorkStatus.Planned && dependencyIssues.length === 0
          ? []
          : transitionIssues(change.id, task.id, "claim", task.status, dependencyIssues);
      case ChangeTaskEventType.Started:
        return task.status === ChangeWorkStatus.Claimed && dependencyIssues.length === 0
          ? []
          : transitionIssues(change.id, task.id, "start", task.status, dependencyIssues.length > 0 ? dependencyIssues : ["Claim the task before starting it."]);
      case ChangeTaskEventType.Review:
        return task.status === ChangeWorkStatus.Running || task.status === ChangeWorkStatus.Ready
          ? []
          : transitionIssues(change.id, task.id, "review", task.status, ["Start the task and complete its checks before review."]);
      case ChangeTaskEventType.Blocked:
        return [];
      case ChangeTaskEventType.Ready:
        return task.status === ChangeWorkStatus.Blocked || task.status === ChangeWorkStatus.Review
          ? []
          : transitionIssues(change.id, task.id, "mark ready", task.status, ["Only blocked or review tasks can be marked ready."]);
      case ChangeTaskEventType.Closed: {
        const failedChecks = task.checkStates.filter((check) => check.status !== ChangeCheckStatus.Passed).map((check) => `${check.id} (${check.status})`);
        const issues = [
          ...dependencyIssues,
          ...(task.status === ChangeWorkStatus.Review || task.status === ChangeWorkStatus.Ready ? [] : [`Task status is ${task.status}; move it to review before closing.`]),
          ...(failedChecks.length > 0 ? [`Checks must pass before closing: ${failedChecks.join(", ")}.`] : []),
        ];
        return issues.length === 0 ? [] : transitionIssues(change.id, task.id, "close", task.status, issues);
      }
      default:
        return [];
    }
  }

  switch (event.type) {
    case ChangeLifecycleEventType.Started:
      return changeStatus === ChangeWorkStatus.Closed ? [`Change ${change.id} is closed. Mark it ready before starting it again.`] : [];
    case ChangeLifecycleEventType.Review:
    case ChangeLifecycleEventType.Closed: {
      const unfinished = taskStates.filter((task) => task.status !== ChangeWorkStatus.Closed).map((task) => `${task.id} (${task.status})`);
      const action = event.type === ChangeLifecycleEventType.Closed ? "close" : "review";
      const issues = unfinished.length > 0 ? [`All tasks must be closed before ${action}: ${unfinished.join(", ")}.`] : [];
      if (event.type === ChangeLifecycleEventType.Closed && changeStatus !== ChangeWorkStatus.Review && changeStatus !== ChangeWorkStatus.Ready) {
        issues.push(`Change status is ${changeStatus}; move it to review before closing.`);
      }
      return issues;
    }
    case ChangeLifecycleEventType.Ready:
      return [];
    default:
      return changeStatus === ChangeWorkStatus.Closed ? [`Change ${change.id} is closed. Mark it ready before recording more lifecycle activity.`] : [];
  }
}

export function latestChangeEvent(events: readonly CanonEvent[], changeId: string): CanonEvent | undefined {
  return sortEvents(events.filter((event) => (event.changeIds ?? []).includes(changeId)))[0];
}

function latestEventForTask(events: readonly CanonEvent[], changeId: string, taskId: string): CanonEvent | undefined {
  return sortEvents(
    events.filter((event) =>
      (event.changeIds ?? []).includes(changeId) &&
      (event.taskIds ?? []).includes(taskId) &&
      (taskLifecycleEventTypes.has(event.type) || taskCheckEventTypes.has(event.type))
    ),
  )[0];
}

function latestEventForCheck(events: readonly CanonEvent[], changeId: string, checkId: string, taskId?: string): CanonEvent | undefined {
  return sortEvents(
    events.filter((event) =>
      (event.changeIds ?? []).includes(changeId) &&
      (event.checkIds ?? []).includes(checkId) &&
      (!taskId || (event.taskIds ?? []).includes(taskId)) &&
      (changeCheckEventTypes.has(event.type) || taskCheckEventTypes.has(event.type))
    ),
  )[0];
}

function latestLifecycleOrCheckEventForChange(events: readonly CanonEvent[], changeId: string): CanonEvent | undefined {
  return sortEvents(
    events.filter((event) =>
      (event.changeIds ?? []).includes(changeId) &&
      (changeLifecycleEventTypes.has(event.type) || changeCheckEventTypes.has(event.type))
    ),
  )[0];
}

function taskStatusFromEvents(latestEvent: CanonEvent | undefined, checks: ChangeCheckState[], lease?: TaskLeaseSummary): ChangeWorkStatus {
  if (lease?.status === TaskLeaseStatus.Active) {
    if (!latestEvent || latestEvent.type === ChangeTaskEventType.Claimed) return ChangeWorkStatus.Claimed;
  }
  if (latestEvent) {
    switch (latestEvent.type) {
      case ChangeTaskEventType.Closed:
        return ChangeWorkStatus.Closed;
      case ChangeTaskEventType.Ready:
        return ChangeWorkStatus.Ready;
      case ChangeTaskEventType.Review:
        return ChangeWorkStatus.Review;
      case ChangeTaskEventType.Blocked:
      case ChangeTaskEventType.CheckFailed:
        return ChangeWorkStatus.Blocked;
      case ChangeTaskEventType.Started:
      case ChangeTaskEventType.CheckStarted:
        return ChangeWorkStatus.Running;
      case ChangeTaskEventType.Claimed:
        return ChangeWorkStatus.Claimed;
    }
  }
  if (checks.some((check) => check.status === ChangeCheckStatus.Failed)) return ChangeWorkStatus.Blocked;
  if (checks.some((check) => check.status === ChangeCheckStatus.Running)) return ChangeWorkStatus.Running;
  if (checks.length > 0 && checks.every((check) => check.status === ChangeCheckStatus.Passed)) return ChangeWorkStatus.Ready;
  return ChangeWorkStatus.Planned;
}

function activeLeaseByTaskId(changeId: string, leases: readonly TaskLeaseSummary[]): Map<string, TaskLeaseSummary> {
  const byTaskId = new Map<string, TaskLeaseSummary>();
  for (const lease of leases) {
    if (lease.changeId !== changeId || lease.status !== TaskLeaseStatus.Active) continue;
    const existing = byTaskId.get(lease.taskId);
    if (!existing || lease.updatedAt > existing.updatedAt) byTaskId.set(lease.taskId, lease);
  }
  return byTaskId;
}

function changeStatusFromEvent(event: CanonEvent | undefined): ChangeWorkStatus {
  switch (event?.type) {
    case ChangeLifecycleEventType.Closed:
      return ChangeWorkStatus.Closed;
    case ChangeLifecycleEventType.Ready:
    case ChangeCheckEventType.Passed:
      return ChangeWorkStatus.Ready;
    case ChangeLifecycleEventType.Review:
      return ChangeWorkStatus.Review;
    case ChangeLifecycleEventType.Blocked:
    case ChangeCheckEventType.Failed:
      return ChangeWorkStatus.Blocked;
    case ChangeLifecycleEventType.Started:
    case ChangeCheckEventType.Started:
      return ChangeWorkStatus.Running;
    default:
      return ChangeWorkStatus.Planned;
  }
}

function checkStatusFromEvent(event: CanonEvent | undefined): ChangeCheckStatus {
  switch (event?.type) {
    case ChangeCheckEventType.Started:
    case ChangeTaskEventType.CheckStarted:
      return ChangeCheckStatus.Running;
    case ChangeCheckEventType.Passed:
    case ChangeTaskEventType.CheckPassed:
      return ChangeCheckStatus.Passed;
    case ChangeCheckEventType.Failed:
    case ChangeTaskEventType.CheckFailed:
      return ChangeCheckStatus.Failed;
    default:
      return ChangeCheckStatus.Unknown;
  }
}

function taskBlockers(task: ChangeTaskState, tasks: Map<string, ChangeTaskState>): string[] {
  const blockers: string[] = [];
  for (const dependencyId of [...task.dependsOn, ...task.blockedBy]) {
    const dependency = tasks.get(dependencyId);
    if (!dependency) {
      blockers.push(`Task ${task.id} references missing task ${dependencyId}.`);
      continue;
    }
    if (dependency.status !== ChangeWorkStatus.Closed) {
      blockers.push(`Task ${task.id} waits for ${dependencyId} to close.`);
    }
  }
  return blockers;
}

function transitionIssues(changeId: string, taskId: string, action: string, status: ChangeWorkStatus, issues: readonly string[]): string[] {
  return [`Cannot ${action} task ${taskId} in ${changeId} while its status is ${status}.`, ...issues];
}

function changeDependencyBlockers(change: Change, statusById: Map<string, ChangeWorkStatus>): string[] {
  const blockers: string[] = [];
  for (const dependencyId of [...(change.dependsOn ?? []), ...(change.blockedBy ?? [])]) {
    const status = statusById.get(dependencyId);
    if (!status) {
      blockers.push(`Change ${change.id} references missing change ${dependencyId}.`);
      continue;
    }
    if (status !== ChangeWorkStatus.Closed) blockers.push(`Change ${change.id} waits for ${dependencyId} to close.`);
  }
  return blockers;
}

function taskQueueItem(change: Change, task: ChangeTaskState): ChangeReadyWorkItem {
  return {
    kind: "task",
    changeId: change.id,
    changeTitle: change.title,
    taskId: task.id,
    taskTitle: task.title,
    checks: task.checks,
    files: task.files,
    surfaces: uniqueStrings([...task.surfaces, ...task.updates.surfaces]),
    updates: task.updates,
    suggestedCommands: [
      `opencanon changes show ${change.id} --format json`,
      `opencanon worktree create ${change.id} --task ${task.id}`,
      `opencanon changes claim ${change.id} --task ${task.id}`,
      `opencanon changes start ${change.id} --task ${task.id}`,
      ...(task.files.length > 0 ? [`opencanon context --files ${task.files.map(shellQuote).join(" ")}`] : []),
      ...(task.checks.length > 0 ? [`opencanon changes check ${change.id} --task ${task.id} --all`] : []),
    ],
    reason: task.dependsOn.length + task.blockedBy.length === 0 ? "Task has no unresolved dependencies." : "All task dependencies are closed.",
  };
}

function normalizeTaskUpdates(updates: ChangeTask["updates"]): NormalizedChangeUpdates {
  if (!updates) return EmptyUpdates;
  return {
    areas: updates.areas ?? [],
    specs: updates.specs ?? [],
    conventions: updates.conventions ?? [],
    surfaces: updates.surfaces ?? [],
    docs: updates.docs ?? [],
  };
}

function summarizeEvent(event: CanonEvent): ChangeEventSummary {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    summary: event.summary,
    ...(event.actor ? { actor: event.actor } : {}),
  };
}

function sortEvents(events: readonly CanonEvent[]): CanonEvent[] {
  return [...events].sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
