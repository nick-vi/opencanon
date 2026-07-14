import type { CanonEvent, ChangeCheckRunEvent } from "@opencanon/core";
import type { RuntimeSnapshot } from "./snapshot.ts";

export const StreamEventType = { Error: "error", Indexing: "indexing", Operation: "operation", Snapshot: "snapshot" } as const;
export type StreamEventType = (typeof StreamEventType)[keyof typeof StreamEventType];
export type RuntimeStreamProgress = {
  phase:
    | "runtime-start"
    | "file-discovery"
    | "definitions"
    | "validator-graph"
    | "validation"
    | "chunking"
    | "embedding"
    | "product-graph"
    | "doctor"
    | "ready"
    | "failure";
  label?: string;
  current?: number;
  total?: number;
  unit?: string;
  indeterminate?: boolean;
};
export type RuntimeStreamEvent = {
  type: StreamEventType;
  timestamp: string;
  summary: string;
  progress?: RuntimeStreamProgress;
  operation?: ChangeCheckRunEvent;
  snapshot?: RuntimeSnapshot;
};

export type EventStreamOptions = {
  closeWhen?(event: RuntimeStreamEvent): boolean;
};

export function eventStream(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

/** Max events buffered per SSE client before it is treated as stalled and dropped. */
const StreamHighWaterMark = 32;

export function createEventBroadcaster() {
  const encoder = new TextEncoder();
  const clients = new Map<ReadableStreamDefaultController<Uint8Array>, { heartbeat?: ReturnType<typeof setInterval>; closeWhen?: EventStreamOptions["closeWhen"] }>();

  function encode(event: RuntimeStreamEvent): Uint8Array {
    return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function removeClient(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const client = clients.get(controller);
    if (client?.heartbeat) clearInterval(client.heartbeat);
    clients.delete(controller);
  }

  return {
    connect(initial: RuntimeStreamEvent | RuntimeStreamEvent[] | (() => RuntimeStreamEvent[]), options: EventStreamOptions = {}): ReadableStream<Uint8Array> {
      let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            activeController = controller;
            clients.set(controller, { closeWhen: options.closeWhen });
            const initialEvents = typeof initial === "function" ? initial() : Array.isArray(initial) ? initial : [initial];
            for (const event of initialEvents) {
              controller.enqueue(encode(event));
              if (options.closeWhen?.(event)) {
                removeClient(controller);
                controller.close();
                return;
              }
            }
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
              } catch {
                removeClient(controller);
              }
            }, 30_000);
            // Don't keep the runtime event loop alive solely for a client heartbeat.
            if (typeof heartbeat === "object" && "unref" in heartbeat) (heartbeat as { unref: () => void }).unref();
            clients.set(controller, { heartbeat, closeWhen: options.closeWhen });
          },
          cancel() {
            if (activeController) removeClient(activeController);
          },
        },
        // Bound per-client buffering: with highWaterMark 32, desiredSize drops to
        // <= 0 only once ~32 events are queued unpulled, which `broadcast` treats
        // as a stalled client and disconnects. Healthy clients (queue drained by
        // the socket) keep a positive desiredSize and are never dropped.
        new CountQueuingStrategy({ highWaterMark: StreamHighWaterMark }),
      );
    },
    broadcast(event: RuntimeStreamEvent): void {
      const payload = encode(event);
      for (const controller of [...clients.keys()]) {
        const client = clients.get(controller);
        const desiredSize = controller.desiredSize;
        if (desiredSize === null || desiredSize <= 0) {
          removeClient(controller);
          try {
            if (desiredSize === null) controller.close();
            else controller.error(new Error("OpenCanon event stream consumer fell behind; reconnect with the last event cursor."));
          } catch {
            // already closed/errored
          }
          continue;
        }
        try {
          controller.enqueue(payload);
          if (client?.closeWhen?.(event)) {
            removeClient(controller);
            controller.close();
          }
        } catch {
          removeClient(controller);
        }
      }
    },
    close(): void {
      for (const controller of [...clients.keys()]) {
        removeClient(controller);
        try {
          controller.close();
        } catch {
          continue;
        }
      }
      clients.clear();
    },
  };
}
export type EventBroadcaster = ReturnType<typeof createEventBroadcaster>;

export function snapshotEvent(snapshot: RuntimeSnapshot, summary: string): RuntimeStreamEvent {
  return {
    type: StreamEventType.Snapshot,
    timestamp: new Date().toISOString(),
    summary,
    progress: {
      phase: "ready",
      label: "Project context ready",
      current: snapshot.files.length,
      total: snapshot.files.length,
      unit: "files",
    },
    snapshot,
  };
}

export function indexingEvent(summary: string, progress?: RuntimeStreamProgress): RuntimeStreamEvent {
  return {
    type: StreamEventType.Indexing,
    timestamp: new Date().toISOString(),
    summary,
    progress: progress ?? { phase: "validation", label: summary, indeterminate: true },
  };
}

export function operationEvent(event: ChangeCheckRunEvent): RuntimeStreamEvent {
  return {
    type: StreamEventType.Operation,
    timestamp: event.timestamp,
    summary: `Change check ${event.runId} ${event.type}.`,
    operation: event,
  };
}

export function streamErrorEvent(summary: string): RuntimeStreamEvent {
  return {
    type: StreamEventType.Error,
    timestamp: new Date().toISOString(),
    summary,
    progress: { phase: "failure", label: "Project context update failed" },
  };
}

export function indexedEvent(snapshot: RuntimeSnapshot, summary: string): CanonEvent {
  const timestamp = new Date().toISOString();
  return {
    id: `indexed:${timestamp}`,
    type: "indexed",
    timestamp,
    files: [],
    changeIds: [],
    taskIds: [],
    checkIds: [],
    conventionIds: [],
    validatorIds: snapshot.validators.map((validator) => validator.id),
    findingIds: snapshot.findings.map((finding) => finding.id),
    summary,
  };
}
