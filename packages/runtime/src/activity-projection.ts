import { snapshotEvent, streamErrorEvent, type EventBroadcaster } from "./server-events.ts";
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
    input.events.broadcast(snapshotEvent(snapshot, input.summary));
  } catch (error) {
    input.events.broadcast(streamErrorEvent(`Active work update failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}
