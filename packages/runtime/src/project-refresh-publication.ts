import { RuntimeWorkerJobStatusValue, type RuntimeWorkerJob } from "@opencanon/core";
import { indexingEvent, type EventBroadcaster } from "./server-events.ts";
import type { RuntimeChangeCatalog, RuntimeSnapshot } from "./snapshot.ts";
import type { RuntimeRebuildCandidate } from "./state-manager.ts";

type WorkerJobPatch = Partial<Omit<RuntimeWorkerJob, "id" | "kind" | "status" | "startedAt">>;

export function unchangedProjectRefreshCandidate(input: {
  snapshot: RuntimeSnapshot;
  changeCatalog: RuntimeChangeCatalog;
  jobId: string;
  events: EventBroadcaster;
  finishWorkerJob(id: string, status: typeof RuntimeWorkerJobStatusValue.Succeeded, patch: WorkerJobPatch): void;
}): RuntimeRebuildCandidate {
  return {
    snapshot: input.snapshot,
    changeCatalog: input.changeCatalog,
    commit() {
      input.finishWorkerJob(input.jobId, RuntimeWorkerJobStatusValue.Succeeded, {
        label: "Project state current",
        current: input.snapshot.files.length,
        total: input.snapshot.files.length,
        unit: "files",
        message: "No project inputs changed.",
      });
      input.events.broadcast(indexingEvent("No project inputs changed.", {
        phase: "ready",
        label: "Project state current",
        current: input.snapshot.files.length,
        total: input.snapshot.files.length,
        unit: "files",
      }));
      return input.snapshot;
    },
  };
}
