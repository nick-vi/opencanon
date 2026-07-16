import {
  ProjectRefreshModeValue,
  ProjectRefreshStatusValue,
  RuntimeWorkerJobStatusValue,
  type RuntimeWorkerJob,
} from "@opencanon/core";
import type { RuntimeSnapshot } from "./snapshot.ts";
import type { ProjectStore } from "./state.ts";

const RuntimeHealthStatusValue = {
  Failed: "failed",
  Indexing: "indexing",
  Ready: "ready",
  Stale: "stale",
} as const;

export function runtimeHealthStatus(snapshot: RuntimeSnapshot, jobs: RuntimeWorkerJob[]): RuntimeSnapshot["health"]["status"] {
  if (snapshot.health.status === RuntimeHealthStatusValue.Failed) return RuntimeHealthStatusValue.Failed;
  if (jobs.some((job) => job.status === RuntimeWorkerJobStatusValue.Running || job.status === RuntimeWorkerJobStatusValue.Queued)) {
    return RuntimeHealthStatusValue.Indexing;
  }
  if (snapshot.health.refresh.status === ProjectRefreshStatusValue.Stale) return RuntimeHealthStatusValue.Stale;
  return RuntimeHealthStatusValue.Ready;
}

export function refreshSnapshotRefreshStatus(snapshot: RuntimeSnapshot, store: ProjectStore, reason?: string): RuntimeSnapshot {
  const projectRefresh = store.project.status().refresh;
  const refresh = reason
    ? { ...projectRefresh, status: ProjectRefreshStatusValue.Stale, mode: ProjectRefreshModeValue.Manual, reason }
    : projectRefresh;
  const status: RuntimeSnapshot["health"]["status"] =
    snapshot.health.status === RuntimeHealthStatusValue.Failed
      ? RuntimeHealthStatusValue.Failed
      : refresh.status === ProjectRefreshStatusValue.Live
        ? RuntimeHealthStatusValue.Ready
        : RuntimeHealthStatusValue.Stale;
  const health = { ...snapshot.health, status, refresh };
  return { ...snapshot, health, state: { ...snapshot.state, health } };
}
