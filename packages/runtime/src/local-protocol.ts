import { randomUUID, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import net, { type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  ProtocolHttpMethod,
  ProtocolResponseFailure,
  ProtocolTransportFailure,
  ProtocolTransportFailureCode,
  OpenCanonFailureSchema,
  createDomainProtocolClient,
  maximumProtocolRequestBytes,
  createOpenCanonDiagnostic,
  createOpenCanonDiagnosticsError,
  formatOpenCanonErrorPayload,
  getOpenCanonErrorProblem,
  parseOpenCanonErrorPayload,
  parseProjectionResponse,
  serializeOpenCanonProblem,
  type ProjectionResponse,
  type ProtocolOperationDefinition,
} from "@opencanon/core";
import { runtimeAuthHeaders } from "./auth.ts";

export const LocalTransportKind = {
  Http: "http",
  Pipe: "pipe",
} as const;
export type LocalTransportKind = (typeof LocalTransportKind)[keyof typeof LocalTransportKind];

export type LocalProtocolHttpEndpoint = {
  transport: typeof LocalTransportKind.Http;
  url: string;
  authToken?: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
};

export type LocalProtocolPipeEndpoint = {
  transport: typeof LocalTransportKind.Pipe;
  pipeEndpoint: string;
  url?: string;
  authToken?: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
};

export type LocalProtocolEndpoint = LocalProtocolHttpEndpoint | LocalProtocolPipeEndpoint;

export type LocalProtocolRequest = {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type LocalProtocolRawResponse = {
  status: number;
  statusText: string;
  body: unknown;
};

export type LocalProtocolTransport = {
  request(endpoint: LocalProtocolEndpoint, request: LocalProtocolRequest): Promise<LocalProtocolRawResponse>;
};

export type LocalProtocolStreamRequest = Omit<LocalProtocolRequest, "timeoutMs"> & {
  signal?: AbortSignal;
  onOpen?(): void;
  onChunk(chunk: string): void;
};

export type LocalProtocolPipeServer = {
  endpoint: string;
  stop(force?: boolean): Promise<void>;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: unknown;
};

type LocalProtocolEntry = {
  transport?: LocalTransportKind;
  url?: string;
  pipeEndpoint?: string;
  authToken?: string;
  protocolVersion?: number;
  runtimeVersion?: string;
  runtimeFingerprint?: string;
};

type PipeRequestFrame = {
  protocol: typeof PipeProtocolName;
  id: string;
  method: LocalProtocolRequest["method"];
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type PipeResponseFrame = {
  protocol: typeof PipeProtocolName;
  id: string;
  status: number;
  statusText: string;
  body: unknown;
};

type PipeStreamFrame = {
  protocol: typeof PipeProtocolName;
  id: string;
  status: number;
  statusText: string;
  stream: true;
  chunk?: string;
  done?: true;
};

type PipeErrorFrame = {
  protocol: typeof PipeProtocolName;
  id?: string;
  status: number;
  statusText: string;
  body: unknown;
};

const PipeProtocolName = "opencanon.local.v2";
const PipeFrameDelimiter = "\n";
const PipeFrameMaxBytes = 64 * 1024 * 1024;
const ProtocolPipeEnvelopeBytes = 64 * 1024;
export const ProjectProtocolPipeFrameMaxBytes = maximumProtocolRequestBytes() + ProtocolPipeEnvelopeBytes;
const PipeHost = "opencanon.local";
const PlatformName = {
  Win32: "win32",
} as const;

export const httpLoopbackTransport: LocalProtocolTransport = {
  async request(endpoint, request) {
    if (endpoint.transport !== LocalTransportKind.Http) {
      throw new Error(`Unsupported OpenCanon local transport: ${endpoint.transport}.`);
    }
    const timeout = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : undefined;
    const controller = timeout ? new AbortController() : undefined;
    const abortFromCaller = () => controller?.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    let timeoutFired = false;
    const timer = timeout ? setTimeout(() => {
      timeoutFired = true;
      controller?.abort();
    }, timeout) : undefined;
    try {
      const response = await fetch(`${endpoint.url.replace(/\/$/, "")}${request.path}`, {
        method: request.method,
        headers: {
          ...(endpoint.authToken ? runtimeAuthHeaders(endpoint.authToken) : {}),
          ...(request.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
          ...request.headers,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller?.signal ?? request.signal,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        body: await parseResponseBody(response),
      };
    } catch (error) {
      if (isAbortError(error) && request.signal?.aborted && !timeoutFired) {
        throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Cancelled, "OpenCanon local request was cancelled.", { cause: error });
      }
      if (isAbortError(error) && timeoutFired) {
        throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Timeout, `OpenCanon local request timed out after ${timeout}ms.`, { cause: error });
      }
      throw normalizeLocalTransportFailure(error);
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  },
};

export const pipeProtocolTransport: LocalProtocolTransport = {
  async request(endpoint, request) {
    if (endpoint.transport !== LocalTransportKind.Pipe) {
      throw new Error(`Unsupported OpenCanon local transport: ${endpoint.transport}.`);
    }
    const id = randomUUID();
    const frame: PipeRequestFrame = {
      protocol: PipeProtocolName,
      id,
      method: request.method,
      path: request.path,
      headers: {
        ...(endpoint.authToken ? runtimeAuthHeaders(endpoint.authToken) : {}),
        ...(request.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
        ...request.headers,
      },
      body: request.body,
    };
    const response = await sendPipeFrame(endpoint.pipeEndpoint, frame, request.timeoutMs, request.signal);
    if (response.id !== id) {
      throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Malformed, "OpenCanon pipe response id did not match the request id.");
    }
    return {
      status: response.status,
      statusText: response.statusText,
      body: response.body,
    };
  },
};

export const localProtocolTransport: LocalProtocolTransport = {
  async request(endpoint, request) {
    if (endpoint.transport === LocalTransportKind.Pipe) {
      return pipeProtocolTransport.request(endpoint, request);
    }
    return httpLoopbackTransport.request(endpoint, request);
  },
};

export function createLocalDomainProtocolClient(input: {
  endpoint(): LocalProtocolEndpoint;
  repair?(failure: ProtocolTransportFailure, operation: ProtocolOperationDefinition): Promise<void>;
  defaultTimeoutMs?: number;
}) {
  return createDomainProtocolClient({
    transport: {
      async request(request) {
        return await localProtocolTransport.request(input.endpoint(), {
          method: request.method,
          path: request.path,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          timeoutMs: request.timeoutMs ?? input.defaultTimeoutMs,
        });
      },
      async stream(request) {
        await streamLocalText(input.endpoint(), {
          method: request.method,
          path: request.path,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          onOpen: request.onOpen,
          onChunk: request.onChunk,
        });
      },
    },
    ...(input.repair ? { repair: input.repair } : {}),
  });
}

export async function requestLocalJson<T>(
  endpoint: LocalProtocolEndpoint,
  request: LocalProtocolRequest,
  transport: LocalProtocolTransport = localProtocolTransport,
): Promise<T> {
  const response = await transport.request(endpoint, request);
  const payload = isRecord(response.body) ? (response.body as ApiEnvelope<T>) : ({ ok: false } satisfies ApiEnvelope<T>);
  if (response.status >= 200 && response.status < 300 && payload.ok === true) return payload.data as T;
  const error = parseOpenCanonErrorPayload(payload.error) ?? createOpenCanonDiagnosticsError([
    createOpenCanonDiagnostic({
      code: "runtime-not-running",
      message: `OpenCanon runtime request failed: ${response.status} ${response.statusText}.`,
      action: "Run opencanon service start, or rerun the command so OpenCanon can start the service.",
    }),
  ]);
  const problem = getOpenCanonErrorProblem(error);
  if (problem) throw new Error(serializeOpenCanonProblem(problem));
  throw new Error(formatOpenCanonErrorPayload(error));
}

export async function requestLocalProjection<T>(
  endpoint: LocalProtocolEndpoint,
  request: LocalProtocolRequest,
  transport?: LocalProtocolTransport,
): Promise<ProjectionResponse<T>> {
  return parseProjectionResponse<T>(await requestLocalJson<unknown>(endpoint, request, transport));
}

export async function requestLocalProjectionData<T>(
  endpoint: LocalProtocolEndpoint,
  request: LocalProtocolRequest,
  transport?: LocalProtocolTransport,
): Promise<T> {
  return (await requestLocalProjection<T>(endpoint, request, transport)).data;
}

export async function streamLocalText(endpoint: LocalProtocolEndpoint, request: LocalProtocolStreamRequest): Promise<void> {
  try {
    if (endpoint.transport === LocalTransportKind.Pipe) {
      await streamPipeText(endpoint, request);
      return;
    }
    const response = await fetch(`${endpoint.url.replace(/\/$/, "")}${request.path}`, {
      method: request.method,
      headers: {
        ...(endpoint.authToken ? runtimeAuthHeaders(endpoint.authToken) : {}),
        ...(request.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    });
    if (!response.ok) throw protocolResponseFailure(response.status, await parseResponseBody(response));
    if (!response.body) throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Malformed, "OpenCanon event stream returned no body.");
    request.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) request.onChunk(chunk);
      }
      const trailing = decoder.decode();
      if (trailing) request.onChunk(trailing);
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (request.signal?.aborted) {
      throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Cancelled, "OpenCanon event stream was cancelled.", { cause: error });
    }
    if (error instanceof ProtocolResponseFailure) throw error;
    throw normalizeLocalTransportFailure(error);
  }
}

export function localProtocolEndpointFromEntry(entry: LocalProtocolEntry, input: { prefer?: LocalTransportKind } = {}): LocalProtocolEndpoint {
  const transport = input.prefer ?? ("transport" in entry ? entry.transport : undefined);
  if (transport === LocalTransportKind.Http) {
    if (!entry.url) throw new Error("OpenCanon local HTTP endpoint is missing url.");
    return {
      transport: LocalTransportKind.Http,
      url: entry.url,
      authToken: entry.authToken,
      protocolVersion: entry.protocolVersion,
      runtimeVersion: entry.runtimeVersion,
      runtimeFingerprint: entry.runtimeFingerprint,
    };
  }
  if (entry.pipeEndpoint) {
    return {
      transport: LocalTransportKind.Pipe,
      pipeEndpoint: entry.pipeEndpoint,
      url: entry.url,
      authToken: entry.authToken,
      protocolVersion: entry.protocolVersion,
      runtimeVersion: entry.runtimeVersion,
      runtimeFingerprint: entry.runtimeFingerprint,
    };
  }
  if (!entry.url) throw new Error("OpenCanon local endpoint is missing both pipeEndpoint and url.");
  return {
    transport: LocalTransportKind.Http,
    url: entry.url,
    authToken: entry.authToken,
    protocolVersion: entry.protocolVersion,
    runtimeVersion: entry.runtimeVersion,
    runtimeFingerprint: entry.runtimeFingerprint,
  };
}

export function localPipeEndpoint(input: { scope: "service" | "runtime"; key: string; pipeDir?: string }): string {
  const hash = createHash("sha256").update(input.key).digest("hex").slice(0, 24);
  if (process.platform === PlatformName.Win32) return `\\\\.\\pipe\\opencanon-${input.scope}-${hash}`;
  return path.join(input.pipeDir ?? defaultPipeDirectory(), `${input.scope}-${hash}.sock`);
}

export async function cleanupLocalPipeEndpoints(input: {
  pipeDir?: string;
  activeEndpoints?: string[];
  prefixes?: string[];
  maxAgeMs?: number;
  nowMs?: number;
} = {}): Promise<number> {
  if (process.platform === PlatformName.Win32) return 0;
  const pipeDir = input.pipeDir ?? defaultPipeDirectory();
  const activeEndpoints = new Set((input.activeEndpoints ?? []).map((endpoint) => path.resolve(endpoint)));
  const prefixes = input.prefixes ?? ["service-", "runtime-"];
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? 0;
  let entries: string[];
  try {
    entries = readdirSync(pipeDir);
  } catch {
    return 0;
  }
  const candidates = entries
    .filter((entry) => entry.endsWith(".sock") && prefixes.some((prefix) => entry.startsWith(prefix)))
    .map((entry) => path.join(pipeDir, entry))
    .filter((endpoint) => !activeEndpoints.has(path.resolve(endpoint)))
    .filter((endpoint) => {
      if (maxAgeMs <= 0) return true;
      try {
        return nowMs - statSync(endpoint).mtimeMs >= maxAgeMs;
      } catch {
        return false;
      }
    });
  const results = await Promise.all(candidates.map(async (endpoint) => {
    if (await pipeEndpointAcceptsConnections(endpoint)) return false;
    rmSync(endpoint, { force: true });
    return true;
  }));
  return results.filter(Boolean).length;
}

export async function serveLocalProtocolPipe(input: {
  endpoint: string;
  routeRequest(request: Request): Promise<Response>;
  host?: string;
  maxFrameBytes?: number;
  beginActivity?(): () => void;
  preflightRequest?(request: Request): Response | undefined;
  requestBodyLimit?(method: string, pathname: string): number;
}): Promise<LocalProtocolPipeServer> {
  const sockets = new Set<Socket>();
  const nodeServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    void handlePipeSocket(input, socket);
  });
  await listenPipeServer(nodeServer, input.endpoint);
  return {
    endpoint: input.endpoint,
    async stop(force = false) {
      if (force) {
        for (const socket of sockets) socket.destroy();
      }
      await closePipeServer(nodeServer);
      if (process.platform !== PlatformName.Win32) rmSync(input.endpoint, { force: true });
    },
  };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

async function sendPipeFrame(endpoint: string, frame: PipeRequestFrame, timeoutMs?: number, signal?: AbortSignal): Promise<PipeResponseFrame> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const onAbort = () => socket.destroy(new ProtocolTransportFailure(ProtocolTransportFailureCode.Cancelled, "OpenCanon local request was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs && timeoutMs > 0) {
      socket.setTimeout(timeoutMs, () => socket.destroy(new ProtocolTransportFailure(
        ProtocolTransportFailureCode.Timeout,
        `OpenCanon local request timed out after ${timeoutMs}ms.`,
      )));
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    socket.once("error", (error) => {
      cleanup();
      reject(normalizeLocalTransportFailure(error));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(frame)}${PipeFrameDelimiter}`);
    });
    readPipeFrame(socket, PipeFrameMaxBytes).then(
      (response) => {
        cleanup();
        socket.end();
        if (!isPipeResponseFrame(response)) {
          reject(new ProtocolTransportFailure(ProtocolTransportFailureCode.Malformed, "OpenCanon pipe returned a malformed response frame."));
          return;
        }
        resolve(response);
      },
      (error) => {
        cleanup();
        socket.destroy();
        reject(normalizeLocalTransportFailure(error));
      },
    );
  });
}

async function streamPipeText(endpoint: LocalProtocolPipeEndpoint, request: LocalProtocolStreamRequest): Promise<void> {
  const id = randomUUID();
  const frame: PipeRequestFrame = {
    protocol: PipeProtocolName,
    id,
    method: request.method,
    path: request.path,
    headers: {
      ...(endpoint.authToken ? runtimeAuthHeaders(endpoint.authToken) : {}),
      ...(request.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      ...request.headers,
    },
    body: request.body,
  };
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(endpoint.pipeEndpoint);
    let buffer = "";
    let settled = false;
    let opened = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      if (error && !request.signal?.aborted) reject(error);
      else resolve();
    };
    const onAbort = () => finish();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}${PipeFrameDelimiter}`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > PipeFrameMaxBytes) {
        finish(new Error("OpenCanon pipe stream frame exceeded the maximum allowed size."));
        return;
      }
      while (true) {
        const delimiterIndex = buffer.indexOf(PipeFrameDelimiter);
        if (delimiterIndex < 0) break;
        const text = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + PipeFrameDelimiter.length);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (isPipeResponseFrame(parsed) && parsed.id === id) {
          finish(protocolResponseFailure(parsed.status, parsed.body));
          return;
        }
        if (!isPipeStreamFrame(parsed) || parsed.id !== id) {
          finish(new Error("OpenCanon pipe returned a malformed stream frame."));
          return;
        }
        if (parsed.status < 200 || parsed.status >= 300) {
          finish(new ProtocolTransportFailure(ProtocolTransportFailureCode.Malformed, `OpenCanon event stream failed: ${parsed.status} ${parsed.statusText}.`));
          return;
        }
        if (!opened) {
          opened = true;
          request.onOpen?.();
        }
        if (parsed.chunk) {
          try {
            request.onChunk(parsed.chunk);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        if (parsed.done) {
          finish();
          return;
        }
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("OpenCanon pipe event stream ended before a terminal frame.")));
    socket.once("close", () => finish(new Error("OpenCanon pipe event stream closed before a terminal frame.")));
  });
}

async function handlePipeSocket(
  input: {
    routeRequest(request: Request): Promise<Response>;
    host?: string;
    maxFrameBytes?: number;
    beginActivity?(): () => void;
    preflightRequest?(request: Request): Response | undefined;
    requestBodyLimit?(method: string, pathname: string): number;
  },
  socket: Socket,
): Promise<void> {
  const endActivity = input.beginActivity?.();
  let requestId: string | undefined;
  try {
    const rawFrame = await readPipeFrame(socket, input.maxFrameBytes ?? PipeFrameMaxBytes);
    requestId = isRecord(rawFrame) && typeof rawFrame.id === "string" ? rawFrame.id : undefined;
    if (!isPipeRequestFrame(rawFrame)) {
      await endPipeFrame(socket, errorFrame(requestId, 400, "Bad Request", "Malformed OpenCanon pipe request."));
      return;
    }
    const preflightFailure = input.preflightRequest?.(
      pipeFrameToRequest({ ...rawFrame, body: undefined }, input.host ?? PipeHost),
    );
    if (preflightFailure) {
      await writePipeFrame(socket, {
        protocol: PipeProtocolName,
        id: rawFrame.id,
        status: preflightFailure.status,
        statusText: preflightFailure.statusText,
        body: await responseBodyValue(preflightFailure),
      });
      socket.end();
      return;
    }
    const pathname = new URL(rawFrame.path, `http://${input.host ?? PipeHost}`).pathname;
    const requestBodyBytes = rawFrame.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(rawFrame.body));
    const requestBodyLimit = input.requestBodyLimit?.(rawFrame.method, pathname);
    if (requestBodyLimit !== undefined && requestBodyBytes > requestBodyLimit) {
      await endPipeFrame(
        socket,
        errorFrame(requestId, 413, "Payload Too Large", `Request body exceeds the ${requestBodyLimit}-byte operation limit.`),
      );
      return;
    }
    const request = pipeFrameToRequest(rawFrame, input.host ?? PipeHost);
    const response = await input.routeRequest(request);
    if (isEventStreamResponse(response)) {
      await streamPipeResponse(socket, rawFrame.id, response);
      return;
    }
    const responseFrame: PipeResponseFrame = {
      protocol: PipeProtocolName,
      id: rawFrame.id,
      status: response.status,
      statusText: response.statusText,
      body: await responseBodyValue(response),
    };
    await writePipeFrame(socket, responseFrame);
    socket.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endPipeFrame(socket, errorFrame(requestId, 500, "Internal Server Error", message));
  } finally {
    endActivity?.();
  }
}

function pipeFrameToRequest(frame: PipeRequestFrame, host: string): Request {
  if (!frame.path.startsWith("/") || frame.path.startsWith("//")) {
    throw new Error("OpenCanon pipe request path must be an absolute API path.");
  }
  const headers = new Headers(frame.headers ?? {});
  const init: RequestInit & { duplex?: "half" } = { method: frame.method, headers };
  if (frame.body !== undefined && frame.method !== ProtocolHttpMethod.Get) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
    const body = JSON.stringify(frame.body);
    headers.set("content-length", String(Buffer.byteLength(body)));
    init.body = body;
  }
  return new Request(new URL(frame.path, `http://${host}`), init);
}

async function responseBodyValue(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  return text;
}

function isEventStreamResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

async function streamPipeResponse(socket: Socket, id: string, response: Response): Promise<void> {
  const status = response.status;
  const statusText = response.statusText;
  const emit = (frame: PipeStreamFrame) => writePipeFrame(socket, frame);
  const body = response.body;
  if (!body) {
    await emit({ protocol: PipeProtocolName, id, status, statusText, stream: true, done: true });
    socket.end();
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  socket.once("close", cancelReader);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        await emit({ protocol: PipeProtocolName, id, status, statusText, stream: true, chunk });
      }
    }
    const trailing = decoder.decode();
    if (trailing) {
      await emit({ protocol: PipeProtocolName, id, status, statusText, stream: true, chunk: trailing });
    }
    await emit({ protocol: PipeProtocolName, id, status, statusText, stream: true, done: true });
    socket.end();
  } finally {
    socket.off("close", cancelReader);
    reader.releaseLock();
  }
}

function writePipeFrame(socket: Socket, frame: PipeResponseFrame | PipeStreamFrame | PipeErrorFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || socket.writableEnded) {
      reject(new Error("OpenCanon pipe socket is already closed."));
      return;
    }
    socket.write(`${JSON.stringify(frame)}${PipeFrameDelimiter}`, "utf8", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function endPipeFrame(socket: Socket, frame: PipeResponseFrame | PipeStreamFrame | PipeErrorFrame): Promise<void> {
  await writePipeFrame(socket, frame).catch(() => undefined);
  if (!socket.destroyed && !socket.writableEnded) socket.end();
}

function readPipeFrame(socket: Socket, maxFrameBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let done = false;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const parseBuffer = () => {
      const delimiterIndex = buffer.indexOf(PipeFrameDelimiter);
      if (delimiterIndex < 0) return;
      const text = buffer.slice(0, delimiterIndex);
      try {
        finish(JSON.parse(text));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes) {
        fail(new ProtocolTransportFailure(ProtocolTransportFailureCode.Malformed, "OpenCanon pipe frame exceeded the maximum allowed size."));
        return;
      }
      parseBuffer();
    };
    const onEnd = () => fail(new ProtocolTransportFailure(ProtocolTransportFailureCode.Closed, "OpenCanon pipe closed before a complete frame was received."));
    const onClose = () => fail(new ProtocolTransportFailure(ProtocolTransportFailureCode.Closed, "OpenCanon pipe closed before a complete frame was received."));
    const onError = (error: Error) => fail(normalizeLocalTransportFailure(error));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function listenPipeServer(server: net.Server, endpoint: string): Promise<void> {
  if (process.platform !== PlatformName.Win32) {
    mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(endpoint), 0o700);
    rmSync(endpoint, { force: true });
  }
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
    server.listen(endpoint);
  });
}

function closePipeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function pipeEndpointAcceptsConnections(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    const done = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(100, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function errorFrame(id: string | undefined, status: number, statusText: string, message: string): PipeErrorFrame {
  return {
    protocol: PipeProtocolName,
    id,
    status,
    statusText,
    body: {
      ok: false,
      error: createOpenCanonDiagnosticsError([
        createOpenCanonDiagnostic({
          code: "invalid-runtime-response",
          message,
        }),
      ]),
    },
  };
}

function defaultPipeDirectory(): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const home = homedir();
  if (home) return path.join(home, ".opencanon", "ipc");
  return path.join("/tmp", `opencanon-${uid}`);
}

function isPipeRequestFrame(value: unknown): value is PipeRequestFrame {
  if (!isRecord(value)) return false;
  return (
    value.protocol === PipeProtocolName &&
    typeof value.id === "string" &&
    (value.method === ProtocolHttpMethod.Get || value.method === ProtocolHttpMethod.Post) &&
    typeof value.path === "string" &&
    (value.headers === undefined || isStringRecord(value.headers))
  );
}

function protocolResponseFailure(status: number, body: unknown): ProtocolResponseFailure | ProtocolTransportFailure {
  const failure = OpenCanonFailureSchema.safeParse(body);
  if (failure.success) return new ProtocolResponseFailure(status, failure.data);
  return new ProtocolTransportFailure(
    ProtocolTransportFailureCode.Malformed,
    `OpenCanon local protocol returned an invalid ${status} failure envelope.`,
  );
}

function normalizeLocalTransportFailure(error: unknown): ProtocolTransportFailure {
  if (error instanceof ProtocolTransportFailure) return error;
  if (isAbortError(error)) {
    return new ProtocolTransportFailure(ProtocolTransportFailureCode.Cancelled, "OpenCanon local request was cancelled.", { cause: error });
  }
  const code = nestedErrorCode(error);
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") {
    return new ProtocolTransportFailure(ProtocolTransportFailureCode.Closed, "OpenCanon local connection closed before the operation completed.", { cause: error });
  }
  if (code === "ECONNREFUSED" || code === "ENOENT") {
    return new ProtocolTransportFailure(ProtocolTransportFailureCode.Unavailable, "OpenCanon local endpoint is unavailable.", { cause: error });
  }
  return new ProtocolTransportFailure(ProtocolTransportFailureCode.Unavailable, "OpenCanon local transport failed.", { cause: error });
}

function nestedErrorCode(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) return undefined;
  seen.add(error);
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === "string" && record.code.trim()) return record.code;
  return nestedErrorCode(record.cause, seen);
}

function isPipeResponseFrame(value: unknown): value is PipeResponseFrame {
  if (!isRecord(value)) return false;
  return (
    value.protocol === PipeProtocolName &&
    typeof value.id === "string" &&
    typeof value.status === "number" &&
    typeof value.statusText === "string" &&
    "body" in value
  );
}

function isPipeStreamFrame(value: unknown): value is PipeStreamFrame {
  if (!isRecord(value)) return false;
  return (
    value.protocol === PipeProtocolName &&
    typeof value.id === "string" &&
    typeof value.status === "number" &&
    typeof value.statusText === "string" &&
    value.stream === true &&
    (value.chunk === undefined || typeof value.chunk === "string") &&
    (value.done === undefined || value.done === true)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
