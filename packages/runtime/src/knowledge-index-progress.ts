import type { SemanticIndexSnapshot } from "@opencanon/core";
import { requestLocalJson, streamLocalText, type LocalProtocolEndpoint } from "./local-protocol.ts";
import { ApiRoute, ProjectIndexResponseMode } from "./routes.ts";
import { StreamEventType } from "./server-events.ts";

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
          const event = JSON.parse(data) as { type?: string; progress?: { label?: string; current?: number; total?: number; unit?: string } };
          if (event.type !== StreamEventType.Indexing || !event.progress?.label) continue;
          const count = event.progress.current !== undefined && event.progress.total !== undefined
            ? ` (${event.progress.current}/${event.progress.total}${event.progress.unit ? ` ${event.progress.unit}` : ""})`
            : "";
          const line = `${event.progress.label}${count}`;
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
