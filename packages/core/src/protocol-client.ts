import { z } from "zod";
import {
  OpenCanonFailureSchema,
  formatOpenCanonErrorPayload,
  type OpenCanonFailure,
} from "./errors.ts";
import {
  DomainProtocolVersion,
  ProtocolHeader,
  ProtocolIdempotency,
  ProtocolOperationKind,
  type ProjectionResponse,
  type ProtocolInput,
  type ProtocolOperationDefinition,
} from "./protocol.ts";
import type { ProtocolOperationInput } from "./protocol-inputs.ts";
import {
  protocolOperationById,
  type ProtocolCommandOperationId,
  type ProtocolOperationId,
  type ProtocolQueryOperationId,
  type ProtocolStreamOperationId,
} from "./protocol-operations.ts";
import type { ProtocolOperationOutput } from "./protocol-projections.ts";

export const ProtocolTransportFailureCode = {
  Cancelled: "cancelled",
  Closed: "closed",
  Malformed: "malformed",
  Timeout: "timeout",
  Unavailable: "unavailable",
} as const;
export type ProtocolTransportFailureCode = (typeof ProtocolTransportFailureCode)[keyof typeof ProtocolTransportFailureCode];

export class ProtocolTransportFailure extends Error {
  readonly code: ProtocolTransportFailureCode;

  constructor(code: ProtocolTransportFailureCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "ProtocolTransportFailure";
    this.code = code;
  }
}

export class ProtocolResponseFailure extends Error {
  readonly status: number;
  readonly failure: OpenCanonFailure;

  constructor(status: number, failure: OpenCanonFailure) {
    super(formatOpenCanonErrorPayload(failure.error));
    this.name = "ProtocolResponseFailure";
    this.status = status;
    this.failure = failure;
  }
}

export type ProtocolTransportRequest = {
  operationId: ProtocolOperationId;
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ProtocolTransportResponse = {
  status: number;
  statusText: string;
  body: unknown;
};

export type ProtocolStreamRequest = ProtocolTransportRequest & {
  onOpen?(): void;
  onChunk(chunk: string): void;
};

export type ProtocolClientTransport = {
  request(request: ProtocolTransportRequest): Promise<ProtocolTransportResponse>;
  stream(request: ProtocolStreamRequest): Promise<void>;
};

export type ProtocolExecutionOptions = {
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ProtocolStreamOptions = ProtocolExecutionOptions & {
  onOpen?(): void;
  onChunk(chunk: string): void;
};

export type DomainProtocolClient = {
  query<TId extends ProtocolQueryOperationId>(operationId: TId, input?: ProtocolOperationInput<TId>, options?: ProtocolExecutionOptions): Promise<ProjectionResponse<ProtocolOperationOutput<TId>>>;
  command<TId extends ProtocolCommandOperationId>(operationId: TId, input?: ProtocolOperationInput<TId>, options?: ProtocolExecutionOptions): Promise<ProtocolOperationOutput<TId>>;
  stream<TId extends ProtocolStreamOperationId>(operationId: TId, input: ProtocolOperationInput<TId> | undefined, options: ProtocolStreamOptions): Promise<void>;
};

const SuccessEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict();
const MaxTransportAttempts = 2;

export function createDomainProtocolClient(input: {
  transport: ProtocolClientTransport;
  repair?(failure: ProtocolTransportFailure, operation: ProtocolOperationDefinition): Promise<void>;
}): DomainProtocolClient {
  return {
    async query<TId extends ProtocolQueryOperationId>(operationId: TId, operationInput: ProtocolOperationInput<TId> | undefined, options: ProtocolExecutionOptions = {}) {
      const operation = requireOperation(operationId, ProtocolOperationKind.Query);
      return await execute(input, operation, operationInput ?? {}, options) as ProjectionResponse<ProtocolOperationOutput<TId>>;
    },
    async command<TId extends ProtocolCommandOperationId>(operationId: TId, operationInput: ProtocolOperationInput<TId> | undefined, options: ProtocolExecutionOptions = {}) {
      const operation = requireOperation(operationId, ProtocolOperationKind.Command);
      return await execute(input, operation, operationInput ?? {}, options) as ProtocolOperationOutput<TId>;
    },
    async stream<TId extends ProtocolStreamOperationId>(operationId: TId, operationInput: ProtocolOperationInput<TId> | undefined, options: ProtocolStreamOptions) {
      const operation = requireOperation(operationId, ProtocolOperationKind.Stream);
      const request = protocolTransportRequest(operation, operationInput ?? {}, options);
      await withTransportRepair(input, operation, options, () => input.transport.stream({ ...request, ...options }));
    },
  };
}

export function protocolInputFromSearchParams<TId extends ProtocolOperationId>(operationId: TId, searchParams: URLSearchParams): ProtocolOperationInput<TId> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0]! : values;
  }
  const operation = protocolOperationById(operationId);
  if (!operation) throw new Error(`Unknown OpenCanon protocol operation: ${operationId}.`);
  return operation.inputSchema.parse(Object.keys(query).length > 0 ? { query } : {}) as ProtocolOperationInput<TId>;
}

export function isProtocolTransportFailure(error: unknown): error is ProtocolTransportFailure {
  return error instanceof ProtocolTransportFailure;
}

async function execute(
  client: { transport: ProtocolClientTransport; repair?(failure: ProtocolTransportFailure, operation: ProtocolOperationDefinition): Promise<void> },
  operation: ProtocolOperationDefinition,
  operationInput: ProtocolInput,
  options: ProtocolExecutionOptions,
): Promise<unknown> {
  const request = protocolTransportRequest(operation, operationInput, options);
  const response = await withTransportRepair(client, operation, options, () => client.transport.request(request));
  const success = SuccessEnvelopeSchema.safeParse(response.body);
  if (response.status >= 200 && response.status < 300 && success.success) {
    return operation.outputSchema.parse(success.data.data);
  }
  const failure = OpenCanonFailureSchema.safeParse(response.body);
  if (failure.success) throw new ProtocolResponseFailure(response.status, failure.data);
  throw new ProtocolTransportFailure(
    ProtocolTransportFailureCode.Malformed,
    `Operation ${operation.id} returned an invalid ${response.status} ${response.statusText || "response"} envelope.`,
  );
}

async function withTransportRepair<T>(
  client: { repair?(failure: ProtocolTransportFailure, operation: ProtocolOperationDefinition): Promise<void> },
  operation: ProtocolOperationDefinition,
  options: ProtocolExecutionOptions,
  run: () => Promise<T>,
): Promise<T> {
  const canRepair = operation.idempotency === ProtocolIdempotency.Safe
    || (operation.idempotency === ProtocolIdempotency.Keyed && Boolean(options.idempotencyKey));
  const attempts = canRepair && client.repair ? MaxTransportAttempts : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isProtocolTransportFailure(error) || attempt + 1 >= attempts || !client.repair) throw error;
      await client.repair(error, operation);
    }
  }
  throw new ProtocolTransportFailure(ProtocolTransportFailureCode.Unavailable, `Operation ${operation.id} did not complete.`);
}

function protocolTransportRequest(
  operation: ProtocolOperationDefinition,
  input: ProtocolInput,
  options: ProtocolExecutionOptions,
): ProtocolTransportRequest {
  const parsed = operation.inputSchema.parse(input) as ProtocolInput;
  const idempotencyKey = options.idempotencyKey?.trim();
  if (operation.idempotency === ProtocolIdempotency.Keyed && !idempotencyKey) {
    throw new Error(`Operation ${operation.id} requires an idempotency key.`);
  }
  if (operation.idempotency === ProtocolIdempotency.Keyed) {
    const identity = protocolIdentity(parsed, operation.idempotencyKey.path);
    if (identity !== idempotencyKey) {
      throw new Error(`Operation ${operation.id} requires its idempotency key to equal body.${operation.idempotencyKey.path.join(".")}.`);
    }
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return {
    operationId: operation.id as ProtocolOperationId,
    method: operation.method,
    path: `${operation.path}${suffix}`,
    headers: {
      [ProtocolHeader.Version]: String(DomainProtocolVersion),
      ...(idempotencyKey ? { [ProtocolHeader.IdempotencyKey]: idempotencyKey } : {}),
      ...(parsed.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
    },
    body: parsed.body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
}

function protocolIdentity(input: ProtocolInput, path: readonly string[]): string | undefined {
  let value: unknown = input.body;
  for (const segment of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireOperation(operationId: ProtocolOperationId, kind: ProtocolOperationDefinition["kind"]): ProtocolOperationDefinition {
  const operation = protocolOperationById(operationId);
  if (!operation) throw new Error(`Unknown OpenCanon protocol operation: ${operationId}.`);
  if (operation.kind !== kind) throw new Error(`Operation ${operationId} is ${operation.kind}, not ${kind}.`);
  return operation;
}
