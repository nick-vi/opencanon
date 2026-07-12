import { CanonEventQueryMode, type CanonEvent, type CanonEventQuery } from "@opencanon/core";
import type { ProjectStore } from "./state.ts";
import { listGlobalCanonEvents, mergeCanonEvents, writeGlobalCanonEvent } from "./worktree-coordination.ts";

export function writeRuntimeEvent(rootDir: string, store: ProjectStore, event: CanonEvent): void {
  store.writeEvent(event);
  writeGlobalCanonEvent(rootDir, event);
}

export function listRuntimeEvents(rootDir: string, store: ProjectStore, query: CanonEventQuery): CanonEvent[] {
  const events = mergeCanonEvents([...store.listEvents(query), ...listGlobalCanonEvents(rootDir, query)], Number.MAX_SAFE_INTEGER);
  return query.mode === CanonEventQueryMode.Recent ? events.slice(0, query.limit) : events;
}

export function listChangeEvents(rootDir: string, store: ProjectStore, input: { changeId?: string; taskId?: string; checkId?: string; limit: number }): CanonEvent[] {
  return listRuntimeEvents(rootDir, store, {
    mode: CanonEventQueryMode.Recent,
    limit: input.limit,
    ...(input.changeId ? { changeId: input.changeId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.checkId ? { checkId: input.checkId } : {}),
  });
}

export function listCompleteChangeHistory(rootDir: string, store: ProjectStore, changeId: string): CanonEvent[] {
  return listRuntimeEvents(rootDir, store, { mode: CanonEventQueryMode.ChangeHistory, changeId });
}
