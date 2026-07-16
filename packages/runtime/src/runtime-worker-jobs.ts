import { randomUUID } from "node:crypto";
import { RuntimeWorkerJobStatusValue, type RuntimeWorkerJob } from "@opencanon/core";

type WorkerJobPatch = Partial<Omit<RuntimeWorkerJob, "id" | "kind" | "status" | "startedAt">>;

export function createRuntimeWorkerJobTracker() {
  let current: RuntimeWorkerJob | undefined;
  let last: RuntimeWorkerJob | undefined;

  return {
    current: () => current,
    list(): RuntimeWorkerJob[] {
      const jobs = [current, last].filter((job): job is RuntimeWorkerJob => Boolean(job));
      return jobs.filter((job, index) => jobs.findIndex((item) => item.id === job.id) === index);
    },
    begin(input: { kind: RuntimeWorkerJob["kind"]; label: string; message?: string }): string {
      const now = new Date().toISOString();
      current = {
        id: `${input.kind}:${now}:${randomUUID()}`,
        kind: input.kind,
        status: RuntimeWorkerJobStatusValue.Running,
        label: input.label,
        startedAt: now,
        ...(input.message ? { message: input.message } : {}),
      };
      last = current;
      return current.id;
    },
    update(id: string, patch: WorkerJobPatch): void {
      if (!current || current.id !== id) return;
      current = { ...current, ...patch };
      last = current;
    },
    finish(
      id: string,
      status: typeof RuntimeWorkerJobStatusValue.Succeeded | typeof RuntimeWorkerJobStatusValue.Failed,
      patch: WorkerJobPatch = {},
    ): void {
      if (!current || current.id !== id) return;
      last = { ...current, ...patch, status, finishedAt: new Date().toISOString() };
      current = undefined;
    },
    cancel(id: string): void {
      if (current?.id !== id) return;
      current = undefined;
      if (last?.id === id) last = undefined;
    },
  };
}
