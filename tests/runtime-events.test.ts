import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { localPipeEndpoint, serveLocalProtocolPipe } from "../packages/runtime/src/local-protocol.ts";
import { createEventBroadcaster, indexingEvent, streamErrorEvent } from "../packages/runtime/src/server-events.ts";

test("runtime indexing events carry structured optional progress", () => {
  const event = indexingEvent("Indexing repository.", {
    phase: "file-discovery",
    label: "Discovering project files",
    current: 2,
    total: 5,
    unit: "files",
  });

  assert.equal(event.type, "indexing");
  assert.equal(event.summary, "Indexing repository.");
  assert.deepEqual(event.progress, {
    phase: "file-discovery",
    label: "Discovering project files",
    current: 2,
    total: 5,
    unit: "files",
  });
});

test("runtime error events use the error channel and failure progress phase", () => {
  const event = streamErrorEvent("Could not rebuild Project Knowledge.");

  assert.equal(event.type, "error");
  assert.equal(event.summary, "Could not rebuild Project Knowledge.");
  assert.equal(event.progress?.phase, "failure");
});

test("event broadcaster emits the typed SSE envelope", async () => {
  const broadcaster = createEventBroadcaster();
  const stream = broadcaster.connect(indexingEvent("Connected.", { phase: "runtime-start", indeterminate: true }));
  const reader = stream.getReader();
  const first = await reader.read();
  broadcaster.close();

  assert.equal(first.done, false);
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /^event: indexing/m);
  assert.match(text, /"phase":"runtime-start"/);
});

test("local pipe protocol streams SSE responses as chunk frames", async () => {
  const pipeDir = mkdtempSync(path.join(tmpdir().startsWith("/var/") ? "/tmp" : tmpdir(), "oc-"));
  const endpoint = localPipeEndpoint({ scope: "runtime", key: "runtime", pipeDir });
  const pipeServer = await serveLocalProtocolPipe({
    endpoint,
    async routeRequest(request) {
      assert.equal(new URL(request.url).pathname, "/api/events/stream");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode("event: indexing\n"));
          controller.enqueue(encoder.encode('data: {"phase":"runtime-start"}\n\n'));
          controller.close();
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  try {
    const frames = await requestPipeFrames(endpoint, {
      protocol: "opencanon.local.v1",
      id: "stream-test",
      method: "GET",
      path: "/api/events/stream",
      headers: { accept: "text/event-stream" },
    });
    const streamText = frames.map((frame) => typeof frame.chunk === "string" ? frame.chunk : "").join("");

    assert.ok(frames.every((frame) => frame.protocol === "opencanon.local.v1"));
    assert.ok(frames.every((frame) => frame.id === "stream-test"));
    assert.ok(frames.every((frame) => frame.stream === true));
    assert.equal(frames.at(-1)?.done, true);
    assert.match(streamText, /^event: indexing/m);
    assert.match(streamText, /"phase":"runtime-start"/);
  } finally {
    await pipeServer.stop(true);
    rmSync(pipeDir, { recursive: true, force: true });
  }
});

type PipeStreamTestFrame = {
  protocol?: unknown;
  id?: unknown;
  stream?: unknown;
  chunk?: unknown;
  done?: unknown;
};

function requestPipeFrames(endpoint: string, frame: Record<string, unknown>): Promise<PipeStreamTestFrame[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const frames: PipeStreamTestFrame[] = [];
    let buffer = "";
    let finished = false;
    const timer = setTimeout(() => fail(new Error("Timed out waiting for OpenCanon pipe stream frames.")), 3000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      socket.end();
      resolve(frames);
    };
    function fail(error: Error) {
      if (finished) return;
      finished = true;
      cleanup();
      socket.destroy();
      reject(error);
    }
    function onEnd() {
      if (!finished) fail(new Error("OpenCanon pipe stream closed before a done frame."));
    }
    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      while (true) {
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        const text = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const response = JSON.parse(text) as PipeStreamTestFrame;
        frames.push(response);
        if (response.done === true) {
          finish();
          return;
        }
      }
    }
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
  });
}
