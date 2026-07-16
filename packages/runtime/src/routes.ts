import {
  OpenCanonDiagnosticSchema,
  ProtocolApiPathPrefix,
  ProtocolAuthorization,
  ProtocolRoute,
  createOpenCanonDiagnostic,
  createOpenCanonDiagnosticsError,
  findProtocolOperation,
  protocolMethodsForPath,
  type OpenCanonDiagnostic,
  type OpenCanonErrorPayload,
} from "@opencanon/core";
import { isAuthorizedRuntimeRequest } from "./auth.ts";

const HttpHeaderValue = {
  Json: "application/json; charset=utf-8",
} as const;

export const ApiRoute = ProtocolRoute;

export const ApiPathPrefix = ProtocolApiPathPrefix;

export const ProjectIndexResponseMode = {
  Snapshot: "snapshot",
  SemanticIndex: "semantic-index",
} as const;
export type ProjectIndexResponseMode = (typeof ProjectIndexResponseMode)[keyof typeof ProjectIndexResponseMode];

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
  TraceId: "traceId",
  ValidatorId: "validatorId",
  WithFindings: "withFindings",
} as const;

export const diagnosticCodes = {
  invalidRuntimeResponse: "invalid-runtime-response",
  lifecycleConflict: "lifecycle-conflict",
  operationCapacityExceeded: "operation-capacity-exceeded",
  requestCapacityExceeded: "request-capacity-exceeded",
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
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": HttpHeaderValue.Json },
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

export function validateMethod(pathname: string, method: string): { ok: true } | { ok: false; error: RuntimeError } {
  if (!pathname.startsWith(ApiPathPrefix)) return { ok: true };
  if (findProtocolOperation(method, pathname)) return { ok: true };
  const expected = protocolMethodsForPath(pathname);
  if (expected.length === 0) return { ok: true };
  return {
    ok: false,
    error: diagnostic(diagnosticCodes.invalidRuntimeResponse, `${pathname} requires ${expected.join(" or ")}.`),
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

export function validateRuntimeAuth(request: Request, url: URL, authToken: string): { ok: true } | { ok: false; error: RuntimeError } {
  if (!url.pathname.startsWith(ApiPathPrefix)) return { ok: true };
  const operation = findProtocolOperation(request.method, url.pathname);
  if (operation?.authorization === ProtocolAuthorization.Public) return { ok: true };
  if (isAuthorizedRuntimeRequest(request, url, authToken)) return { ok: true };
  return {
    ok: false,
    error: diagnostic(diagnosticCodes.invalidRuntimeResponse, "Runtime authorization is required."),
  };
}
