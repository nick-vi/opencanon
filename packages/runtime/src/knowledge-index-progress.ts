import { ProjectProtocolEventSchema, ProtocolDomain, type SemanticIndexSnapshot } from "@opencanon/core";
import { requestLocalJson, streamLocalText, type LocalProtocolEndpoint } from "./local-protocol.ts";
import { ApiRoute, ProjectIndexResponseMode } from "./routes.ts";
import { ProjectProtocolEventType } from "./server-events.ts";
import type { KnowledgeIndexProgress } from "./knowledge-index-manager.ts";

export function knowledgeIndexProtocolPhase(phase: KnowledgeIndexProgress["phase"]): string {
  switch (phase) {
    case "scan":
    case "diff":
      return "file-discovery";
    case "chunk":
      return "chunking";
    case "embed":
      return "embedding";
    case "write":
    case "prewarm":
      return "product-graph";
    case "ready":
      return "ready";
  }
}

export async function requestKnowledgeIndex(input: {
  endpoint: LocalProtocolEndpoint;
  force: boolean;
  onProgress(line: string): void;
}): Promise<{ state?: { semanticIndex?: SemanticIndexSnapshot }; semanticIndex?: SemanticIndexSnapshot | null }> {
  const controller = new AbortController();
  let streamOpened!: () => void;
  let streamOpenFailed!: (error: Error) => void;
  let streamIsOpen = false;
  const streamOpen = new Promise<void>((resolve, reject) => {
    streamOpened = resolve;
    streamOpenFailed = reject;
  });
  const parser = createKnowledgeProgressParser(input.onProgress);
  const stream = streamLocalText(input.endpoint, {
    method: "GET",
    path: ApiRoute.EventsStream,
    signal: controller.signal,
    onOpen() {
      streamIsOpen = true;
      streamOpened();
    },
    onChunk: parser.push,
  }).then(() => {
    if (!streamIsOpen && !controller.signal.aborted) throw new Error("OpenCanon Knowledge progress stream closed before opening.");
  }).catch((error) => {
    if (!streamIsOpen) {
      streamOpenFailed(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!controller.signal.aborted) throw error;
  });
  try {
    await streamOpen;
  } catch (error) {
    controller.abort();
    await stream.catch(() => undefined);
    throw error;
  }
  try {
    return await requestLocalJson(
      input.endpoint,
      { method: "POST", path: ApiRoute.Index, body: { response: ProjectIndexResponseMode.SemanticIndex, force: input.force } },
    );
  } finally {
    controller.abort();
    await stream;
  }
}

function createKnowledgeProgressParser(onProgress: (line: string) => void): { push(chunk: string): void } {
  let buffer = "";
  let lastLine = "";
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n/gu, "\n");
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) return;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const event = ProjectProtocolEventSchema.parse(JSON.parse(data));
          if (event.domain !== ProtocolDomain.Knowledge || event.type !== ProjectProtocolEventType.Progress || !event.progress) continue;
          const count = event.progress.total > 0
            ? ` (${event.progress.current}/${event.progress.total} ${event.progress.unit})`
            : "";
          const line = `${event.progress.message ?? event.summary}${count}`;
          if (line !== lastLine) {
            lastLine = line;
            onProgress(line);
          }
        } catch (error) {
          throw new Error(`OpenCanon returned malformed Knowledge progress: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
