import type { CanonEvent } from "@opencanon/core";
import type { DaemonSnapshot } from "./snapshot.ts";

export const StreamEventType = { Indexing: "indexing", Snapshot: "snapshot" } as const;
export type StreamEventType = (typeof StreamEventType)[keyof typeof StreamEventType];
export type DaemonStreamEvent = { type: StreamEventType; timestamp: string; summary: string; snapshot?: DaemonSnapshot };

export function eventStream(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

export function createEventBroadcaster() {
  const encoder = new TextEncoder();
  const clients = new Map<ReadableStreamDefaultController<Uint8Array>, { heartbeat?: ReturnType<typeof setInterval> }>();

  function encode(event: DaemonStreamEvent): Uint8Array {
    return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function removeClient(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const client = clients.get(controller);
    if (client?.heartbeat) clearInterval(client.heartbeat);
    clients.delete(controller);
  }

  return {
    connect(initial: DaemonStreamEvent): ReadableStream<Uint8Array> {
      let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          activeController = controller;
          clients.set(controller, {});
          controller.enqueue(encode(initial));
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              removeClient(controller);
            }
          }, 30_000);
          clients.set(controller, { heartbeat });
        },
        cancel() {
          if (activeController) removeClient(activeController);
        },
      });
    },
    broadcast(event: DaemonStreamEvent): void {
      const payload = encode(event);
      for (const controller of [...clients.keys()]) {
        try {
          controller.enqueue(payload);
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

export function snapshotEvent(snapshot: DaemonSnapshot, summary: string): DaemonStreamEvent {
  return {
    type: StreamEventType.Snapshot,
    timestamp: new Date().toISOString(),
    summary,
    snapshot,
  };
}

export function indexedEvent(snapshot: DaemonSnapshot, summary: string): CanonEvent {
  const timestamp = new Date().toISOString();
  return {
    id: `indexed:${timestamp}`,
    type: "indexed",
    timestamp,
    files: [],
    decisionIds: [],
    validatorIds: snapshot.validators.map((validator) => validator.id),
    findingIds: snapshot.findings.map((finding) => finding.id),
    summary,
  };
}
