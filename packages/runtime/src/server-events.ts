import {
  DomainProtocolVersion,
  ProjectProtocolEventDraftSchema,
  ProjectProtocolEventSchema,
  ProtocolDomain,
  type CanonEvent,
  type ChangeCheckRunEvent,
  type PersistedProjectProtocolEventDraft,
  type ProjectProtocolEvent,
  type ProjectProtocolEventDraft,
  type ProtocolDomain as ProtocolDomainValue,
} from "@opencanon/core";
import type { RuntimeSnapshot } from "./snapshot.ts";

export const ProjectProtocolEventType = {
  Changed: "changed",
  Failed: "failed",
  Progress: "progress",
  Published: "published",
} as const;

const DefaultStreamQueueBytes = 256 * 1024;
const DefaultMaxEventBytes = 64 * 1024;
const HeartbeatIntervalMs = 30_000;
const ConnectedFrame = new TextEncoder().encode(": connected\n\n");

export type EventStreamOptions = {
  filter?(event: ProjectProtocolEvent): boolean;
  closeWhen?(event: ProjectProtocolEvent): boolean;
  closeAfterReplay?: boolean;
};

export type EventBroadcasterInput = {
  currentRevision(): number;
  append(event: PersistedProjectProtocolEventDraft): ProjectProtocolEvent;
  maxQueuedBytes?: number;
  maxEventBytes?: number;
};

type StreamClient = {
  heartbeat?: ReturnType<typeof setInterval>;
  filter?: EventStreamOptions["filter"];
  closeWhen?: EventStreamOptions["closeWhen"];
};

export function eventStream(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-store",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

export function createEventBroadcaster(input: EventBroadcasterInput) {
  const encoder = new TextEncoder();
  const maxQueuedBytes = input.maxQueuedBytes ?? DefaultStreamQueueBytes;
  const maxEventBytes = input.maxEventBytes ?? DefaultMaxEventBytes;
  const clients = new Map<ReadableStreamDefaultController<Uint8Array>, StreamClient>();

  if (!Number.isInteger(maxQueuedBytes) || maxQueuedBytes < 1) throw new Error("Event stream queue bytes must be positive.");
  if (!Number.isInteger(maxEventBytes) || maxEventBytes < 1 || maxEventBytes > maxQueuedBytes) {
    throw new Error("Event stream event bytes must be positive and no larger than the queue bound.");
  }

  function encode(event: ProjectProtocolEvent): Uint8Array {
    const payload = encoder.encode(`id: ${event.sequence}\nevent: opencanon\ndata: ${JSON.stringify(event)}\n\n`);
    if (payload.byteLength > maxEventBytes) {
      throw new Error(`OpenCanon protocol event ${event.sequence} exceeds the ${maxEventBytes}-byte event bound.`);
    }
    return payload;
  }

  function removeClient(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const client = clients.get(controller);
    if (client?.heartbeat) clearInterval(client.heartbeat);
    clients.delete(controller);
  }

  function failClient(controller: ReadableStreamDefaultController<Uint8Array>, message: string): void {
    removeClient(controller);
    try {
      controller.error(new Error(message));
    } catch {
      // The stream was already closed by its consumer.
    }
  }

  function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, payload: Uint8Array): boolean {
    const desiredSize = controller.desiredSize;
    if (desiredSize === null || desiredSize < payload.byteLength) {
      failClient(controller, "OpenCanon event stream consumer fell behind; reconnect with the last event sequence.");
      return false;
    }
    try {
      controller.enqueue(payload);
      return true;
    } catch {
      removeClient(controller);
      return false;
    }
  }

  return {
    connect(initial: ProjectProtocolEvent[] | (() => ProjectProtocolEvent[]), options: EventStreamOptions = {}): ReadableStream<Uint8Array> {
      let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            activeController = controller;
            clients.set(controller, { filter: options.filter, closeWhen: options.closeWhen });
            if (!enqueue(controller, ConnectedFrame)) return;
            const initialEvents = typeof initial === "function" ? initial() : initial;
            for (const eventValue of initialEvents) {
              const event = ProjectProtocolEventSchema.parse(eventValue);
              if (!enqueue(controller, encode(event))) return;
              if (options.closeWhen?.(event)) {
                removeClient(controller);
                controller.close();
                return;
              }
            }
            if (options.closeAfterReplay) {
              removeClient(controller);
              controller.close();
              return;
            }
            const heartbeat = setInterval(() => {
              enqueue(controller, encoder.encode(": heartbeat\n\n"));
            }, HeartbeatIntervalMs);
            if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
            clients.set(controller, { heartbeat, filter: options.filter, closeWhen: options.closeWhen });
          },
          cancel() {
            if (activeController) removeClient(activeController);
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: maxQueuedBytes }),
      );
    },
    broadcast(draftValue: ProjectProtocolEventDraft): ProjectProtocolEvent {
      const draft = ProjectProtocolEventDraftSchema.parse(draftValue);
      const persistedDraft = {
        ...draft,
        timestamp: new Date().toISOString(),
        revision: input.currentRevision(),
      } satisfies PersistedProjectProtocolEventDraft;
      encode(ProjectProtocolEventSchema.parse({ ...persistedDraft, sequence: Number.MAX_SAFE_INTEGER }));
      const persisted = input.append(persistedDraft);
      const event = ProjectProtocolEventSchema.parse(persisted);
      const payload = encode(event);
      for (const controller of [...clients.keys()]) {
        const client = clients.get(controller);
        if (client?.filter && !client.filter(event)) continue;
        if (!enqueue(controller, payload)) continue;
        if (client?.closeWhen?.(event)) {
          removeClient(controller);
          controller.close();
        }
      }
      return event;
    },
    close(): void {
      for (const controller of [...clients.keys()]) {
        removeClient(controller);
        try {
          controller.close();
        } catch {
          // The stream was already closed by its consumer.
        }
      }
      clients.clear();
    },
  };
}

export type EventBroadcaster = ReturnType<typeof createEventBroadcaster>;

export function projectPublishedEvent(summary: string, ids: string[] = []): ProjectProtocolEventDraft {
  return eventDraft(ProtocolDomain.Project, ProjectProtocolEventType.Published, summary, ids);
}

export function activityChangedEvent(summary: string, ids: string[]): ProjectProtocolEventDraft {
  return eventDraft(ProtocolDomain.Activity, ProjectProtocolEventType.Changed, summary, ids);
}

export function progressEvent(input: {
  domain: ProtocolDomainValue;
  operation: string;
  phase: string;
  summary: string;
  current?: number;
  total?: number;
  unit?: string;
  ids?: string[];
  operationId?: string;
}): ProjectProtocolEventDraft {
  return eventDraft(input.domain, ProjectProtocolEventType.Progress, input.summary, input.ids ?? [], {
    ...(input.operationId ? { operationId: input.operationId } : {}),
    progress: {
      operation: input.operation,
      phase: input.phase,
      current: input.current ?? 0,
      total: input.total ?? 0,
      unit: input.unit ?? "items",
      message: input.summary,
    },
  });
}

export function proofEvent(event: ChangeCheckRunEvent): ProjectProtocolEventDraft {
  const run = "run" in event ? event.run : undefined;
  return eventDraft(
    ProtocolDomain.Proof,
    event.type,
    `Change check ${event.runId} ${event.type}.`,
    [event.runId, event.batchId, run?.changeId, run?.taskId, run?.checkId].filter((id): id is string => Boolean(id)),
    { operationId: event.runId },
  );
}

export function failureEvent(domain: ProtocolDomainValue, summary: string, ids: string[] = []): ProjectProtocolEventDraft {
  return eventDraft(domain, ProjectProtocolEventType.Failed, summary, ids);
}

function eventDraft(
  domain: ProtocolDomainValue,
  type: string,
  summary: string,
  ids: string[],
  optional: Pick<ProjectProtocolEventDraft, "operationId" | "progress"> = {},
): ProjectProtocolEventDraft {
  return ProjectProtocolEventDraftSchema.parse({
    protocolVersion: DomainProtocolVersion,
    domain,
    type,
    summary,
    ids: [...new Set(ids.filter(Boolean))],
    ...optional,
  });
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
