import type { CanonEvent } from "@opencanon/core";
import type { ProjectStore } from "./state.ts";
import { listGlobalCanonEvents, mergeCanonEvents, writeGlobalCanonEvent } from "./worktree-coordination.ts";

export function writeRuntimeEvent(rootDir: string, store: ProjectStore, event: CanonEvent): void {
  store.writeEvent(event);
  writeGlobalCanonEvent(rootDir, event);
}

export function listRuntimeEvents(rootDir: string, store: ProjectStore, limit: number): CanonEvent[] {
  return mergeCanonEvents([...store.listEvents(limit), ...listGlobalCanonEvents(rootDir, limit)], limit);
}

export function listChangeEvents(rootDir: string, store: ProjectStore, input: { changeId?: string; taskId?: string; checkId?: string; limit: number }): CanonEvent[] {
  const events = listRuntimeEvents(rootDir, store, input.limit);
  return events.filter((event) => {
    if ((event.changeIds ?? []).length === 0) return false;
    if (input.changeId && !(event.changeIds ?? []).includes(input.changeId)) return false;
    if (input.taskId && !(event.taskIds ?? []).includes(input.taskId)) return false;
    if (input.checkId && !(event.checkIds ?? []).includes(input.checkId)) return false;
    return true;
  });
}

