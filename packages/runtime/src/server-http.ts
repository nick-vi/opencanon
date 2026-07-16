import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { diagnosticsFailure } from "./routes.ts";
import type { RuntimeRequestAdmission } from "./request-admission.ts";

export async function serveRuntime(input: {
  host: string;
  port: number;
  routeRequest(request: Request): Promise<Response>;
  beginActivity?(): () => void;
  requestAdmission?: RuntimeRequestAdmission;
}): Promise<{ port: number; stop(force?: boolean): Promise<void> }> {
  const sockets = new Set<Socket>();
  const nodeServer = createServer(async (nodeRequest, nodeResponse) => {
    await handleNodeRequest(input, nodeRequest, nodeResponse);
  });
  nodeServer.keepAliveTimeout = 255_000;
  nodeServer.headersTimeout = 256_000;
  nodeServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  try {
    await listenNodeServer(nodeServer, input.host, input.port);
    const address = nodeServer.address();
    const port = typeof address === "object" && address ? address.port : input.port;
    return { port, stop: (force?: boolean) => closeNodeServer(nodeServer, sockets, Boolean(force)) };
  } catch (error) {
    throw error;
  }
}

function listenNodeServer(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeNodeServer(server: NodeHttpServer, sockets: Set<Socket>, force: boolean): Promise<void> {
  if (force) {
    for (const socket of sockets) socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function handleNodeRequest(
  input: { host: string; routeRequest(request: Request): Promise<Response>; beginActivity?(): () => void; requestAdmission?: RuntimeRequestAdmission },
  nodeRequest: IncomingMessage,
  nodeResponse: ServerResponse,
): Promise<void> {
  const endActivity = input.beginActivity?.();
  const abortController = new AbortController();
  let responseFinished = false;
  nodeRequest.on("aborted", () => abortController.abort());
  nodeResponse.on("finish", () => {
    responseFinished = true;
  });
  nodeResponse.on("close", () => {
    if (!responseFinished) abortController.abort();
  });

  try {
    const method = nodeRequest.method ?? "GET";
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const declared = Number(nodeRequest.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MaxRequestBodyBytes) {
        respondJson(nodeResponse, 413, diagnosticsFailure(["Request body exceeds the maximum allowed size."]));
        return;
      }
      const read = await readBodyWithLimit(nodeRequest, MaxRequestBodyBytes);
      if (read === null) {
        respondJson(nodeResponse, 413, diagnosticsFailure(["Request body exceeds the maximum allowed size."]));
        return;
      }
      body = read;
    }
    const request = incomingMessageToRequest(nodeRequest, input.host, abortController.signal, body);
    const admission = input.requestAdmission?.admit(request);
    if (admission && !admission.ok) {
      await writeNodeResponse(admission.response, nodeResponse, abortController.signal);
      return;
    }
    try {
      const response = await input.routeRequest(request);
      await writeNodeResponse(response, nodeResponse, abortController.signal);
    } finally {
      admission?.release();
    }
  } catch (error) {
    if (abortController.signal.aborted) return;
    if (!nodeResponse.headersSent) {
      // Log the detail server-side; return a generic message so internal paths/state
      // (abs paths, git stderr, engine internals) never reach the client.
      console.error("[opencanon-runtime] unhandled request error:", error instanceof Error ? error.stack ?? error.message : String(error));
      respondJson(nodeResponse, 500, diagnosticsFailure(["Internal runtime error."]));
      return;
    }
    nodeResponse.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    endActivity?.();
  }
}

/** Maximum accepted request body. Bounds memory against an authenticated client posting
 * an unbounded body to validate/settings/authoring routes. */
export const MaxRequestBodyBytes = 64 * 1024 * 1024;

function respondJson(nodeResponse: ServerResponse, status: number, payload: unknown): void {
  nodeResponse.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  nodeResponse.end(JSON.stringify(payload));
}

/** Read the request stream into a Buffer, returning null if it exceeds `limit` (the
 * stream is destroyed). Guards against a missing/lying content-length header. */
function readBodyWithLimit(nodeRequest: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    nodeRequest.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        nodeRequest.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    nodeRequest.on("end", () => resolve(Buffer.concat(chunks)));
    nodeRequest.on("error", reject);
  });
}

function incomingMessageToRequest(nodeRequest: IncomingMessage, fallbackHost: string, signal: AbortSignal, body?: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  // Build the URL from the configured bind host, not the client-supplied Host header, so
  // routing/any future absolute-URL logic can't be steered by a forged Host.
  const url = new URL(nodeRequest.url ?? "/", `http://${fallbackHost}`);
  const method = nodeRequest.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { headers, method, signal };
  if (body && method !== "GET" && method !== "HEAD") {
    init.body = new Uint8Array(body);
  }
  return new Request(url, init);
}

async function writeNodeResponse(response: Response, nodeResponse: ServerResponse, signal: AbortSignal): Promise<void> {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) continue;
      if (!nodeResponse.write(chunk.value)) await waitForDrain(nodeResponse, signal);
    }
    if (!nodeResponse.destroyed) nodeResponse.end();
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function waitForDrain(nodeResponse: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || nodeResponse.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      nodeResponse.off("drain", onDrain);
      nodeResponse.off("close", onClose);
      nodeResponse.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    nodeResponse.once("drain", onDrain);
    nodeResponse.once("close", onClose);
    nodeResponse.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
