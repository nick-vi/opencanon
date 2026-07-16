import { ProtocolDomain, RuntimeWorkerJobStatusValue, type RuntimeWorkerJob } from "@opencanon/core";
import { progressEvent, projectPublishedEvent, type EventBroadcaster } from "./server-events.ts";
import type { RuntimeChangeCatalog, RuntimeSnapshot } from "./snapshot.ts";
import type { RuntimeRebuildCandidate } from "./state-manager.ts";
import type { ProjectStore } from "./state.ts";

type WorkerJobPatch = Partial<Omit<RuntimeWorkerJob, "id" | "kind" | "status" | "startedAt">>;

export function unchangedProjectRefreshCandidate(input: {
  snapshot: RuntimeSnapshot;
  changeCatalog: RuntimeChangeCatalog;
  jobId: string;
  events: EventBroadcaster;
  store: ProjectStore;
  summary: string;
  finishWorkerJob(id: string, status: typeof RuntimeWorkerJobStatusValue.Succeeded, patch: WorkerJobPatch): void;
  cancelWorkerJob(id: string): void;
  finalizeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot;
}): RuntimeRebuildCandidate {
  return {
    snapshot: input.snapshot,
    changeCatalog: input.changeCatalog,
    commit(revision) {
      const result = input.store.publishProjectState({
        revision,
        protocolEvent: input.events.prepare(projectPublishedEvent(input.summary), revision),
      });
      return { snapshot: input.snapshot, event: result.event };
    },
    finalizePublished(snapshot) {
      input.finishWorkerJob(input.jobId, RuntimeWorkerJobStatusValue.Succeeded, {
        label: "Project state current",
        current: input.snapshot.files.length,
        total: input.snapshot.files.length,
        unit: "files",
        message: "No project inputs changed.",
      });
      input.events.broadcast(progressEvent({
        domain: ProtocolDomain.Project,
        operation: "project-refresh",
        phase: "ready",
        summary: "No project inputs changed.",
        current: input.snapshot.files.length,
        total: input.snapshot.files.length,
        unit: "files",
      }));
      return input.finalizeSnapshot(snapshot);
    },
    discard() {
      input.cancelWorkerJob(input.jobId);
    },
  };
}
