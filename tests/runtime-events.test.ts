import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  ProjectProtocolEventSchema,
  ProtocolDomain,
  type PersistedProjectProtocolEventDraft,
  type ProjectProtocolEvent,
} from "../packages/core/src/index.ts";
import { localPipeEndpoint, serveLocalProtocolPipe, streamLocalText } from "../packages/runtime/src/local-protocol.ts";
import { createEventBroadcaster, failureEvent, progressEvent } from "../packages/runtime/src/server-events.ts";
import { proxyRuntimeEventStream } from "../packages/runtime/src/service-http.ts";
import type { RuntimeRegistryEntry } from "../packages/runtime/src/service-types.ts";

test("runtime progress events carry bounded domain progress", () => {
  const event = progressEvent({
    domain: ProtocolDomain.Knowledge,
    operation: "knowledge-index",
    phase: "file-discovery",
    summary: "Discovering project files",
    current: 2,
    total: 5,
    unit: "files",
  });

  assert.equal(event.domain, ProtocolDomain.Knowledge);
  assert.equal(event.type, "progress");
  assert.equal(event.summary, "Discovering project files");
  assert.deepEqual(event.progress, {
    operation: "knowledge-index",
    phase: "file-discovery",
    current: 2,
    total: 5,
    unit: "files",
    message: "Discovering project files",
  });
});

test("runtime failure events identify their affected domain", () => {
  const event = failureEvent(ProtocolDomain.Knowledge, "Could not rebuild Project Knowledge.");

  assert.equal(event.domain, ProtocolDomain.Knowledge);
  assert.equal(event.type, "failed");
  assert.equal(event.summary, "Could not rebuild Project Knowledge.");
  assert.equal(event.progress, undefined);
});

test("event broadcaster persists and emits the typed SSE envelope without projections", async () => {
  const { broadcaster, persisted } = createTestBroadcaster();
  const connected = broadcaster.broadcast(progressEvent({
    domain: ProtocolDomain.Project,
    operation: "runtime-start",
    phase: "runtime-start",
    summary: "Connected.",
  }));
  const stream = broadcaster.connect([connected]);
  const reader = stream.getReader();
  const handshake = await reader.read();
  const first = await reader.read();
  broadcaster.close();

  assert.equal(new TextDecoder().decode(handshake.value).trim(), ": connected");
  assert.equal(first.done, false);
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /^id: 1$/m);
  assert.match(text, /^event: opencanon$/m);
  assert.match(text, /"phase":"runtime-start"/);
  assert.doesNotMatch(text, /"snapshot"/);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.sequence, 1);
});

test("event broadcaster closes finite streams on their declared terminal event", async () => {
  const { broadcaster } = createTestBroadcaster();
  const connected = broadcaster.broadcast(progressEvent({
    domain: ProtocolDomain.Proof,
    operation: "change-check",
    operationId: "run-1",
    phase: "queued",
    summary: "Connected.",
  }));
  const stream = broadcaster.connect(
    [connected],
    { closeWhen: (event) => event.summary === "Complete." },
  );
  const reader = stream.getReader();

  assert.equal(new TextDecoder().decode((await reader.read()).value).trim(), ": connected");
  assert.equal((await reader.read()).done, false);
  broadcaster.broadcast(progressEvent({ domain: ProtocolDomain.Proof, operation: "change-check", phase: "validation", summary: "Working." }));
  assert.equal((await reader.read()).done, false);
  broadcaster.broadcast(progressEvent({ domain: ProtocolDomain.Proof, operation: "change-check", phase: "ready", summary: "Complete." }));
  assert.equal((await reader.read()).done, false);
  assert.equal((await reader.read()).done, true);

  broadcaster.close();
});

test("event broadcaster disconnects a stalled consumer at its byte bound", async () => {
  const { broadcaster } = createTestBroadcaster({ maxQueuedBytes: 512, maxEventBytes: 500 });
  const connected = broadcaster.broadcast(failureEvent(ProtocolDomain.Project, "Connected."));
  const stream = broadcaster.connect([connected]);
  const reader = stream.getReader();
  broadcaster.broadcast(failureEvent(ProtocolDomain.Project, "x".repeat(200)));

  await assert.rejects(() => reader.read(), /consumer fell behind/);
  broadcaster.close();
});

test("event broadcaster rejects oversized events before persistence", () => {
  const { broadcaster, persisted } = createTestBroadcaster({ maxQueuedBytes: 512, maxEventBytes: 256 });
  assert.throws(
    () => broadcaster.broadcast(failureEvent(ProtocolDomain.Project, "x".repeat(200))),
    /exceeds the 256-byte event bound/,
  );
  assert.equal(persisted.length, 0);
  broadcaster.close();
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
      protocol: "opencanon.local.v2",
      id: "stream-test",
      method: "GET",
      path: "/api/events/stream",
      headers: { accept: "text/event-stream" },
    });
    const streamText = frames.map((frame) => typeof frame.chunk === "string" ? frame.chunk : "").join("");

    assert.ok(frames.every((frame) => frame.protocol === "opencanon.local.v2"));
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

test("local pipe stream client consumes SSE chunks and aborts explicitly", async () => {
  const pipeDir = mkdtempSync(path.join(tmpdir().startsWith("/var/") ? "/tmp" : tmpdir(), "oc-client-"));
  const endpoint = localPipeEndpoint({ scope: "runtime", key: "runtime-client", pipeDir });
  const pipeServer = await serveLocalProtocolPipe({
    endpoint,
    async routeRequest() {
      return new Response("event: operation\ndata: {\"ok\":true}\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    let output = "";
    let opens = 0;
    await streamLocalText({ transport: "pipe", pipeEndpoint: endpoint }, {
      method: "GET",
      path: "/api/events/stream",
      onOpen: () => { opens += 1; },
      onChunk: (chunk) => { output += chunk; },
    });
    assert.equal(opens, 1);
    assert.match(output, /event: operation/);
    assert.match(output, /"ok":true/);
  } finally {
    await pipeServer.stop(true);
    rmSync(pipeDir, { recursive: true, force: true });
  }
});

test("service event proxy preserves protocol cursors and removes service-only project selection", async () => {
  let requestPath = "";
  const upstream = createServer((request, response) => {
    requestPath = request.url ?? "";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("event: operation\ndata: {\"ok\":true}\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address === "object");
  try {
    const entry = { url: `http://127.0.0.1:${address.port}`, authToken: "runtime-token" } as RuntimeRegistryEntry;
    const response = await proxyRuntimeEventStream(entry, new URLSearchParams({ rootDir: "/repo", operationId: "run-1", afterSequence: "4" }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: operation/);
    assert.equal(requestPath, "/api/events/stream?operationId=run-1&afterSequence=4");
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

type PipeStreamTestFrame = {
  protocol?: unknown;
  id?: unknown;
  stream?: unknown;
  chunk?: unknown;
  done?: unknown;
};

function createTestBroadcaster(options: { maxQueuedBytes?: number; maxEventBytes?: number } = {}): {
  broadcaster: ReturnType<typeof createEventBroadcaster>;
  persisted: ProjectProtocolEvent[];
} {
  let sequence = 0;
  const persisted: ProjectProtocolEvent[] = [];
  const broadcaster = createEventBroadcaster({
    currentRevision: () => 3,
    append(event: PersistedProjectProtocolEventDraft) {
      const stored = ProjectProtocolEventSchema.parse({ ...event, sequence: ++sequence });
      persisted.push(stored);
      return stored;
    },
    ...options,
  });
  return { broadcaster, persisted };
}

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
