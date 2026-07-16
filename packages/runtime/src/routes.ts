import {
  OpenCanonDiagnosticSchema,
  ProtocolApiPathPrefix,
  ProtocolRoute,
  createOpenCanonDiagnostic,
  createOpenCanonDiagnosticsError,
  type OpenCanonDiagnostic,
  type OpenCanonErrorPayload,
} from "@opencanon/core";

const HttpHeaderValue = {
  Json: "application/json; charset=utf-8",
} as const;

export const ApiRoute = ProtocolRoute;

export const ApiPathPrefix = ProtocolApiPathPrefix;

export const UrlSearchParam = {
  Commit: "commit",
  ChangeId: "changeId",
  CheckId: "checkId",
  ConventionId: "conventionId",
  Definition: "definition",
  Direction: "direction",
  Dot: "dot",
  File: "file",
  FindingId: "findingId",
  Id: "id",
  Kind: "kind",
  Limit: "limit",
  Mode: "mode",
  Offset: "offset",
  Path: "path",
  Query: "query",
  Scope: "scope",
  Source: "source",
  References: "references",
  SymbolId: "symbolId",
  Topic: "topic",
  TaskId: "taskId",
  RunId: "runId",
  Status: "status",
  After: "after",
  AfterSequence: "afterSequence",
  OperationId: "operationId",
  TraceId: "traceId",
  ValidatorId: "validatorId",
  WithFindings: "withFindings",
} as const;

export const diagnosticCodes = {
  invalidRuntimeResponse: "invalid-runtime-response",
  invalidProtocolRequest: "invalid-protocol-request",
  lifecycleConflict: "lifecycle-conflict",
  operationCapacityExceeded: "operation-capacity-exceeded",
  requestTooLarge: "request-too-large",
  responseTooLarge: "response-too-large",
  resyncRequired: "resync-required",
  unsupportedProtocolVersion: "unsupported-protocol-version",
  inferenceError: "inference-error",
  projectInventoryFailed: "project-inventory-failed",
  semanticIndexBuildFailed: "semantic-index-build-failed",
  semanticIndexNotReady: "semantic-index-not-ready",
} as const;

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

type DiagnosticCode = (typeof diagnosticCodes)[keyof typeof diagnosticCodes];
export type RuntimeError = { ok: false; error: OpenCanonErrorPayload };

export function json<T>(data: ApiSuccess<T> | RuntimeError, status = 200): Response {
  const body = JSON.stringify(data, null, 2);
  return new Response(body, {
    status,
    headers: {
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "content-type": HttpHeaderValue.Json,
    },
  });
}

export function diagnostic(code: DiagnosticCode, message: string): RuntimeError {
  return diagnosticsFailure([createOpenCanonDiagnostic({ code, message })], code);
}

export function diagnosticsFailure(diagnostics: unknown[], fallbackCode: DiagnosticCode = diagnosticCodes.invalidRuntimeResponse): RuntimeError {
  return {
    ok: false,
    error: createOpenCanonDiagnosticsError(normalizeDiagnostics(diagnostics, fallbackCode)),
  };
}

function normalizeDiagnostics(diagnostics: unknown[], fallbackCode: DiagnosticCode): OpenCanonDiagnostic[] {
  const normalized = diagnostics.map((item) => normalizeDiagnostic(item, fallbackCode));
  if (normalized.length > 0) return normalized;
  return [createOpenCanonDiagnostic({ code: fallbackCode, message: "OpenCanon runtime request failed." })];
}

function normalizeDiagnostic(input: unknown, fallbackCode: DiagnosticCode): OpenCanonDiagnostic {
  const parsed = OpenCanonDiagnosticSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  if (typeof input === "string") return createOpenCanonDiagnostic({ code: fallbackCode, message: input });
  if (isRecord(input)) {
    const message = typeof input.message === "string" && input.message.trim().length > 0 ? input.message : "OpenCanon runtime request failed.";
    const details = Array.isArray(input.details) ? input.details.filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0) : [];
    const action = typeof input.action === "string" && input.action.trim().length > 0 ? input.action : undefined;
    return createOpenCanonDiagnostic({ code: fallbackCode, message, details, action });
  }
  return createOpenCanonDiagnostic({ code: fallbackCode, message: "OpenCanon runtime request failed." });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
