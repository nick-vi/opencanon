import { createServer, type IncomingMessage, type ServerResponse, type Server as NodeHttpServer } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { createOpenCanonDiagnostic, createOpenCanonDiagnosticsError, createOpenCanonProblem, createOpenCanonProblemError, OpenCanonProblemCode, OpenCanonProblemSource, type OpenCanonErrorCode, type OpenCanonErrorPayload, type OpenCanonProblem } from "@opencanon/core";
import { runtimeAuthHeaders } from "./auth.ts";
import { maxServiceRequestBodyBytes, type RuntimeRegistryEntry, type ServiceRecentProject } from "./service-types.ts";

export async function serveService(input: {
  host: string;
  port: number;
  routeRequest(request: Request): Promise<Response>;
}): Promise<{ port: number; stop(force?: boolean): Promise<void> }> {
  const sockets = new Set<Socket>();
  const nodeServer = createServer(async (nodeRequest, nodeResponse) => {
    await handleServiceNodeRequest(input, nodeRequest, nodeResponse);
  });
  nodeServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenNodeServer(nodeServer, input.host, input.port);
  const address = nodeServer.address();
  const port = typeof address === "object" && address ? address.port : input.port;
  return { port, stop: (force?: boolean) => closeNodeServer(nodeServer, sockets, Boolean(force)) };
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

async function handleServiceNodeRequest(
  input: { host: string; routeRequest(request: Request): Promise<Response> },
  nodeRequest: IncomingMessage,
  nodeResponse: ServerResponse,
): Promise<void> {
  try {
    const method = nodeRequest.method ?? "GET";
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const declared = Number(nodeRequest.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxServiceRequestBodyBytes) {
        respondServiceJson(nodeResponse, 413, serviceDiagnostic("service-request-too-large", "Request body exceeds the maximum allowed size."));
        return;
      }
      const read = await readBodyWithLimit(nodeRequest, maxServiceRequestBodyBytes);
      if (read === null) {
        respondServiceJson(nodeResponse, 413, serviceDiagnostic("service-request-too-large", "Request body exceeds the maximum allowed size."));
        return;
      }
      body = read;
    }
    const response = await input.routeRequest(incomingMessageToRequest(nodeRequest, input.host, body));
    await writeNodeResponse(response, nodeResponse);
  } catch (error) {
    console.error("[opencanon-service] unhandled request error:", error instanceof Error ? error.stack ?? error.message : String(error));
    if (!nodeResponse.headersSent) respondServiceJson(nodeResponse, 500, serviceDiagnostic("service-internal-error", "Internal service error."));
  }
}

function incomingMessageToRequest(nodeRequest: IncomingMessage, fallbackHost: string, body?: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const url = new URL(nodeRequest.url ?? "/", `http://${fallbackHost}`);
  const method = nodeRequest.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { headers, method };
  if (body && method !== "GET" && method !== "HEAD") init.body = new Uint8Array(body);
  return new Request(url, init);
}

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

async function writeNodeResponse(response: Response, nodeResponse: ServerResponse): Promise<void> {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => nodeResponse.setHeader(key, value));
  if (!response.body) {
    nodeResponse.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) nodeResponse.write(Buffer.from(value));
  }
  nodeResponse.end();
}

function respondServiceJson(nodeResponse: ServerResponse, status: number, payload: unknown): void {
  nodeResponse.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  nodeResponse.end(JSON.stringify(payload));
}

export function serviceJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function projectNotFoundProblem(input: { rootDir?: string; status?: number }): OpenCanonProblem {
  return createOpenCanonProblem({
    code: OpenCanonProblemCode.ProjectNotFound,
    title: "OpenCanon project not found",
    detail: "No OpenCanon project was discovered for the requested root.",
    source: OpenCanonProblemSource.Service,
    path: input.rootDir,
    action: "Run opencanon init --yes in that folder, or choose an initialized OpenCanon project.",
    retryable: false,
    status: input.status,
  });
}

export function runtimeUnavailableProblem(rootDir: string, error: unknown): OpenCanonProblem {
  return createOpenCanonProblem({
    code: OpenCanonProblemCode.RuntimeUnavailable,
    title: "Could not start the project runtime",
    detail: error instanceof Error ? error.message : String(error),
    source: OpenCanonProblemSource.Service,
    path: rootDir,
    action: "Open OpenCanon Health or project logs, fix the runtime startup issue, then retry this project.",
    retryable: true,
    status: 500,
    details: { logPath: path.join(rootDir, ".opencanon", "runtime.log") },
  });
}

export function isLocalProtocolTransportFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes("OpenCanon pipe closed before a complete frame was received") ||
    message.includes("OpenCanon pipe socket is already closed") ||
    message.includes("OpenCanon local request timed out") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE") ||
    message.includes("ENOENT") ||
    message.includes("No such file or directory")
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serviceProblem(problem: OpenCanonProblem): { ok: false; error: OpenCanonErrorPayload } {
  return {
    ok: false,
    error: createOpenCanonProblemError(problem),
  };
}

export function serviceDiagnostic(code: OpenCanonErrorCode, message: string): { ok: false; error: OpenCanonErrorPayload } {
  return { ok: false, error: createOpenCanonDiagnosticsError([createOpenCanonDiagnostic({ code, message })]) };
}

export async function proxyRuntimeEventStream(entry: RuntimeRegistryEntry): Promise<Response> {
  const url = new URL("/api/events/stream", entry.url);
  const upstream = await fetch(url, { headers: runtimeAuthHeaders(entry.authToken) });
  if (!upstream.ok || !upstream.body) {
    return serviceJson(serviceDiagnostic("runtime-not-running", `OpenCanon runtime event stream failed: ${upstream.status} ${upstream.statusText}.`), upstream.status || 502);
  }
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function serviceRequestMethod(value: unknown): "GET" | "POST" {
  return value === "POST" ? "POST" : "GET";
}

export function stringRecordBodyValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") output[key] = item;
  }
  return output;
}

export async function readServiceJsonObject(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, message: "Request body must be a JSON object." };
  return { ok: true, body: parsed as Record<string, unknown> };
}

export function stringBodyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function stringArrayBodyValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function recentProjectsBodyValue(value: unknown): ServiceRecentProject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const rootDir = stringBodyValue(record.rootDir);
    if (!rootDir) return [];
    const openedAt = stringBodyValue(record.openedAt);
    return [{ rootDir, ...(openedAt ? { openedAt } : {}) }];
  });
}

export function numberBodyValue(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

export function optionalPortBodyValue(value: unknown): { ok: true; value?: number } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535) return { ok: true, value: value as number };
  return { ok: false };
}

export function booleanBodyValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
