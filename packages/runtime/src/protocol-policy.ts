import {
  DomainProtocolVersion,
  OpenCanonFailureSchema,
  ProtocolAuthorization,
  ProtocolConsistency,
  ProtocolHeader,
  ProtocolHttpMethod,
  ProtocolIdempotency,
  ProtocolOperationKind,
  findProtocolOperation,
  protocolMethodsForPath,
  protocolProjection,
  type ProtocolOperationDefinition,
} from "@opencanon/core";
import { isAuthorizedRuntimeRequest } from "./auth.ts";
import { diagnostic, diagnosticCodes, diagnosticsFailure, json } from "./routes.ts";

export type RuntimeProtocolPolicy = {
  preflight(request: Request): Response | undefined;
  execute(request: Request, handler: (request: Request, url: URL) => Promise<Response>): Promise<Response>;
  requestBodyLimit(method: string, pathname: string): number;
};

type CapacityLease = { release(): void };

const UnknownRouteRequestBytes = 16 * 1024;
const StableReadAttempts = 2;

export function createRuntimeProtocolPolicy(input: {
  authToken: string;
  currentRevision(): number;
}): RuntimeProtocolPolicy {
  const activeByOperation = new Map<string, number>();
  const activeByPool = new Map<string, number>();

  return {
    preflight(request) {
      return preflightRequest(request, input.authToken);
    },
    requestBodyLimit(method, pathname) {
      return findProtocolOperation(method, pathname)?.limits.requestBytes ?? UnknownRouteRequestBytes;
    },
    async execute(request, handler) {
      const url = new URL(request.url);
      const preflightFailure = preflightRequest(request, input.authToken);
      if (preflightFailure) return preflightFailure;
      const operation = findProtocolOperation(request.method, url.pathname)!;
      const requestFailure = await validateOperationInput(request, url, operation);
      if (requestFailure) return requestFailure;

      const lease = acquireCapacity(operation, activeByOperation, activeByPool);
      if (!lease) return capacityResponse(operation);
      try {
        const response = await executeStableRequest(request, url, operation, handler, input.currentRevision);
        const bounded = await validateAndBoundResponse(operation, response.response, response.revision);
        return responseWithLease(bounded, lease);
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  };
}

function preflightRequest(request: Request, authToken: string): Response | undefined {
  const url = new URL(request.url);
  const operation = findProtocolOperation(request.method, url.pathname);
  if (!operation) return unknownOperationResponse(request.method, url.pathname);
  return authorizeRequest(request, url, operation, authToken)
    ?? validateProtocolVersion(request, operation)
    ?? validateDeclaredRequestSize(request, operation)
    ?? validateIdempotencyKey(request, operation);
}

async function executeStableRequest(
  request: Request,
  url: URL,
  operation: ProtocolOperationDefinition,
  handler: (request: Request, url: URL) => Promise<Response>,
  currentRevision: () => number,
): Promise<{ response: Response; revision: number }> {
  if (operation.kind !== ProtocolOperationKind.Query || operation.consistency !== ProtocolConsistency.Published) {
    const response = await handler(request.clone(), new URL(url));
    return { response, revision: currentRevision() };
  }

  for (let attempt = 0; attempt < StableReadAttempts; attempt += 1) {
    const before = currentRevision();
    const response = await handler(request.clone(), new URL(url));
    if (!isSuccessfulJsonResponse(response)) return { response, revision: before };
    const after = currentRevision();
    if (before === after) return { response, revision: before };
  }

  return {
    response: json(
      diagnosticsFailure([
        {
          code: diagnosticCodes.lifecycleConflict,
          message: "Project state changed repeatedly while the query was running.",
          action: "Retry the query against the newly published project revision.",
        },
      ], diagnosticCodes.lifecycleConflict),
      409,
    ),
    revision: currentRevision(),
  };
}

async function validateOperationInput(
  request: Request,
  url: URL,
  operation: ProtocolOperationDefinition,
): Promise<Response | undefined> {
  const body = await readJsonRequestBody(request);
  if (!body.ok) {
    return json(diagnostic(diagnosticCodes.invalidProtocolRequest, body.message), 400);
  }
  if (body.bytes > operation.limits.requestBytes) {
    return json(
      diagnostic(
        diagnosticCodes.requestTooLarge,
        `Operation ${operation.id} accepts at most ${operation.limits.requestBytes} request bytes.`,
      ),
      413,
    );
  }
  const query = queryInput(url.searchParams);
  const parsed = operation.inputSchema.safeParse({
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(body.value !== undefined ? { body: body.value } : {}),
  });
  if (parsed.success) return validateIdempotencyIdentity(request, operation, parsed.data);
  return json(
    diagnosticsFailure([
      {
        code: diagnosticCodes.invalidProtocolRequest,
        message: `Request does not match operation ${operation.id}.`,
        details: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      },
    ], diagnosticCodes.invalidProtocolRequest),
    400,
  );
}

function validateIdempotencyIdentity(
  request: Request,
  operation: ProtocolOperationDefinition,
  parsedInput: unknown,
): Response | undefined {
  if (operation.idempotency !== ProtocolIdempotency.Keyed) return undefined;
  const key = request.headers.get(ProtocolHeader.IdempotencyKey)?.trim();
  let value: unknown = parsedInput;
  for (const segment of [operation.idempotencyKey.source, ...operation.idempotencyKey.path]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value === "string" && value.trim() === key) return undefined;
  return json(
    diagnostic(
      diagnosticCodes.invalidProtocolRequest,
      `${ProtocolHeader.IdempotencyKey} for operation ${operation.id} must equal body.${operation.idempotencyKey.path.join(".")}.`,
    ),
    400,
  );
}

async function readJsonRequestBody(request: Request): Promise<{ ok: true; value: unknown; bytes: number } | { ok: false; message: string }> {
  if (request.method === ProtocolHttpMethod.Get) return { ok: true, value: undefined, bytes: 0 };
  const text = await request.clone().text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (!text.trim()) return { ok: true, value: undefined, bytes };
  try {
    return { ok: true, value: JSON.parse(text), bytes };
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }
}

function queryInput(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0]! : values;
  }
  return query;
}

function authorizeRequest(
  request: Request,
  url: URL,
  operation: ProtocolOperationDefinition,
  authToken: string,
): Response | undefined {
  if (operation.authorization === ProtocolAuthorization.Public) return undefined;
  if (isAuthorizedRuntimeRequest(request, url, authToken)) return undefined;
  return json(diagnostic(diagnosticCodes.invalidProtocolRequest, "Project authorization is required."), 401);
}

function validateProtocolVersion(request: Request, operation: ProtocolOperationDefinition): Response | undefined {
  if (operation.authorization === ProtocolAuthorization.Public) return undefined;
  const raw = request.headers.get(ProtocolHeader.Version);
  if (raw === String(DomainProtocolVersion)) return undefined;
  return json(
    diagnostic(
      diagnosticCodes.unsupportedProtocolVersion,
      raw
        ? `Domain protocol version ${raw} is not supported; this runtime requires ${DomainProtocolVersion}.`
        : `The ${ProtocolHeader.Version} header is required and must be ${DomainProtocolVersion}.`,
    ),
    400,
  );
}

function validateIdempotencyKey(request: Request, operation: ProtocolOperationDefinition): Response | undefined {
  if (operation.idempotency !== ProtocolIdempotency.Keyed) return undefined;
  const key = request.headers.get(ProtocolHeader.IdempotencyKey)?.trim();
  if (key && key.length <= 256) return undefined;
  return json(
    diagnostic(
      diagnosticCodes.invalidProtocolRequest,
      `${ProtocolHeader.IdempotencyKey} is required for operation ${operation.id} and must contain at most 256 characters.`,
    ),
    400,
  );
}

function validateDeclaredRequestSize(request: Request, operation: ProtocolOperationDefinition): Response | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) return undefined;
  const bytes = Number(raw);
  if (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= operation.limits.requestBytes) return undefined;
  return json(
    diagnostic(
      diagnosticCodes.requestTooLarge,
      `Operation ${operation.id} accepts at most ${operation.limits.requestBytes} request bytes.`,
    ),
    413,
  );
}

function acquireCapacity(
  operation: ProtocolOperationDefinition,
  activeByOperation: Map<string, number>,
  activeByPool: Map<string, number>,
): CapacityLease | undefined {
  const operationActive = activeByOperation.get(operation.id) ?? 0;
  const pool = `${operation.kind}:${operation.cost}`;
  const poolActive = activeByPool.get(pool) ?? 0;
  if (operationActive >= operation.limits.concurrency || poolActive >= operation.limits.concurrency) return undefined;
  activeByOperation.set(operation.id, operationActive + 1);
  activeByPool.set(pool, poolActive + 1);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      decrement(activeByOperation, operation.id);
      decrement(activeByPool, pool);
    },
  };
}

function decrement(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

function capacityResponse(operation: ProtocolOperationDefinition): Response {
  return json(
    diagnosticsFailure([
      {
        code: diagnosticCodes.operationCapacityExceeded,
        message: `Operation ${operation.id} is at its concurrency limit.`,
        action: "Wait for an active request to finish, then retry.",
      },
    ], diagnosticCodes.operationCapacityExceeded),
    503,
  );
}

async function validateAndBoundResponse(
  operation: ProtocolOperationDefinition,
  response: Response,
  revision: number,
): Promise<Response> {
  if (response.status < 200 || response.status >= 300) {
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
      return invalidOperationResponse(operation, "Operation failure did not return JSON.");
    }
    const failureBody = await response.clone().json().catch(() => undefined);
    const failure = OpenCanonFailureSchema.safeParse(failureBody);
    if (!failure.success) return invalidOperationResponse(operation, "Operation returned an invalid failure envelope.");
    return await enforceResponseBytes(operation, response);
  }
  if (operation.kind === ProtocolOperationKind.Stream) {
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
    return invalidOperationResponse(operation, "Stream operation did not return text/event-stream.");
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    return invalidOperationResponse(operation, "Operation did not return JSON.");
  }
  const body = await response.clone().json().catch(() => undefined) as { ok?: unknown; data?: unknown } | undefined;
  if (!body) return invalidOperationResponse(operation, "Operation returned malformed JSON.");
  if (body.ok !== true) {
    const failure = OpenCanonFailureSchema.safeParse(body);
    if (!failure.success) return invalidOperationResponse(operation, "Operation returned an invalid failure envelope.");
    return await enforceResponseBytes(operation, response);
  }

  const data = operation.kind === ProtocolOperationKind.Query
    ? protocolProjection(revision, body.data)
    : body.data;
  const parsed = operation.outputSchema.safeParse(data);
  if (!parsed.success) {
    console.error(`[opencanon-protocol] ${operation.id} returned invalid data:`, parsed.error.issues);
    return invalidOperationResponse(operation, "Operation output did not match its registered schema.");
  }
  return await enforceResponseBytes(operation, json({ ok: true, data: parsed.data }, response.status));
}

async function enforceResponseBytes(operation: ProtocolOperationDefinition, response: Response): Promise<Response> {
  const declared = Number(response.headers.get("content-length"));
  const bytes = Number.isSafeInteger(declared) && declared >= 0
    ? declared
    : (await response.clone().arrayBuffer()).byteLength;
  if (bytes <= operation.limits.responseBytes) return response;
  return json(
    diagnostic(
      diagnosticCodes.responseTooLarge,
      `Operation ${operation.id} exceeded its ${operation.limits.responseBytes}-byte response contract.`,
    ),
    500,
  );
}

function invalidOperationResponse(operation: ProtocolOperationDefinition, reason: string): Response {
  console.error(`[opencanon-protocol] ${operation.id}: ${reason}`);
  return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "OpenCanon produced an invalid protocol response."), 500);
}

function responseWithLease(response: Response, lease: CapacityLease): Response {
  if (!response.body) {
    lease.release();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const release = () => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    lease.release();
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            release();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          release();
        }
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

function unknownOperationResponse(method: string, pathname: string): Response {
  const methods = protocolMethodsForPath(pathname);
  if (methods.length > 0) {
    return json(
      diagnostic(diagnosticCodes.invalidProtocolRequest, `${pathname} requires ${methods.join(" or ")}; received ${method}.`),
      405,
    );
  }
  return json(diagnostic(diagnosticCodes.invalidProtocolRequest, `Unknown runtime operation: ${method} ${pathname}.`), 404);
}

function isSuccessfulJsonResponse(response: Response): boolean {
  return response.status >= 200 && response.status < 300 && (response.headers.get("content-type") ?? "").includes("application/json");
}
