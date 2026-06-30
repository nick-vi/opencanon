import type { ObservabilityExporter } from "@opencanon/observability";
import type { ProjectStore } from "./state.ts";

export function createProjectObservabilityExporter(
  store: Pick<ProjectStore, "writeObservabilityRecords">,
): ObservabilityExporter {
  return {
    awaited: true,
    onTraceStart(trace) {
      store.writeObservabilityRecords({ traces: [trace] });
    },
    onTraceEnd(trace) {
      store.writeObservabilityRecords({ traces: [trace] });
    },
    onSpanStart(span) {
      store.writeObservabilityRecords({ spans: [span] });
    },
    onSpanEnd(span) {
      store.writeObservabilityRecords({ spans: [span] });
    },
    onEvent(event) {
      store.writeObservabilityRecords({ events: [event] });
    },
  };
}
