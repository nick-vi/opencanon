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

export type CompleteChangeHistories = {
  events: CanonEvent[];
  byChangeId: ReadonlyMap<string, CanonEvent[]>;
};

export function listCompleteChangeHistories(rootDir: string, store: ProjectStore, changeIds: readonly string[]): CompleteChangeHistories {
  const normalizedIds = [...new Set(changeIds.map((value) => value.trim()).filter(Boolean))].sort();
  const byChangeId = new Map(normalizedIds.map((changeId) => [changeId, [] as CanonEvent[]]));
  if (normalizedIds.length === 0) return { events: [], byChangeId };

  const events = listRuntimeEvents(rootDir, store, { mode: CanonEventQueryMode.ChangeHistory, changeIds: normalizedIds });
  for (const event of events) {
    for (const changeId of event.changeIds) byChangeId.get(changeId)?.push(event);
  }
  return { events, byChangeId };
}
