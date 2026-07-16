import { ProtocolDomain } from "@opencanon/core";
import { activityChangedEvent, failureEvent, type EventBroadcaster } from "./server-events.ts";
import { refreshChangeActivitySnapshot } from "./snapshot.ts";
import type { RuntimeStateManager } from "./state-manager.ts";
import type { ProjectStore } from "./state.ts";

export function refreshActiveWorkProjection(input: {
  summary: string;
  stateManager: RuntimeStateManager;
  store: ProjectStore;
  events: EventBroadcaster;
}): void {
  try {
    const snapshot = refreshChangeActivitySnapshot({
      snapshot: input.stateManager.currentSnapshot(),
      changeCatalog: input.stateManager.currentChangeCatalog(),
      store: input.store,
    });
    input.stateManager.setSnapshot(snapshot);
    input.events.broadcast(activityChangedEvent(input.summary, snapshot.changes.map((change) => change.id)));
  } catch (error) {
    input.events.broadcast(failureEvent(ProtocolDomain.Activity, `Active work update failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}
