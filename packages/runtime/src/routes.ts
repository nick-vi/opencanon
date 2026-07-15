import {
  OpenCanonDiagnosticSchema,
  createOpenCanonDiagnostic,
  createOpenCanonDiagnosticsError,
  type OpenCanonDiagnostic,
  type OpenCanonErrorPayload,
} from "@opencanon/core";
import { isAuthorizedRuntimeRequest } from "./auth.ts";

const HttpHeaderValue = {
  Json: "application/json; charset=utf-8",
} as const;

export const ApiRoute = {
  CanonRelated: "/api/canon/related",
  CanonHistory: "/api/canon/history",
  Changes: "/api/changes",
  ChangeCheckRuns: "/api/changes/check-runs",
  ChangeCheckRunsCancel: "/api/changes/check-runs/cancel",
  ChangeEvents: "/api/changes/events",
  ChangeReady: "/api/changes/ready",
  CodeGraph: "/api/code/graph",
  CodeSymbols: "/api/code/symbols",
  ContextAsk: "/api/context/ask",
  ContextBacklinks: "/api/context/backlinks",
  ContextChunks: "/api/context/chunks",
  ContextCoverage: "/api/context/coverage",
  ContextPacket: "/api/context/packet",
  ContextSearch: "/api/context/search",
  ContextStatus: "/api/context/status",
  Doctor: "/api/doctor",
  Events: "/api/events",
  EventsStream: "/api/events/stream",
  Feedback: "/api/feedback",
  Findings: "/api/findings",
  FsFile: "/api/fs/file",
  FsTree: "/api/fs/tree",
  GitDiff: "/api/git/diff",
  GitHistory: "/api/git/history",
  GateApprove: "/api/gates/approve",
  GatePending: "/api/gates/pending",
  Health: "/api/health",
  HookFeedback: "/api/hook-feedback",
  Index: "/api/index",
  Observability: "/api/observability",
  Producers: "/api/producers",
  ProjectSummary: "/api/project/summary",
  Settings: "/api/settings",
  Snapshot: "/api/snapshot",
  State: "/api/state",
  AuthoringFactories: "/api/authoring/factories",
  AuthoringValidators: "/api/authoring/validators",
  AuthoringValidatorsApply: "/api/authoring/validators/apply",
  AuthoringValidatorsPreview: "/api/authoring/validators/preview",
  AuthoringValidatorsRunFixtures: "/api/authoring/validators/run-fixtures",
  ServiceProjects: "/api/service/projects",
  Validate: "/api/validate",
  Worktrees: "/api/worktrees",
} as const;

export const ApiPathPrefix = "/api/";

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
  inferenceError: "inference-error",
  projectInventoryFailed: "project-inventory-failed",
  semanticIndexBuildFailed: "semantic-index-build-failed",
  semanticIndexNotReady: "semantic-index-not-ready",
} as const;

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

const postApiRoutes = new Set<string>([
  ApiRoute.CanonRelated,
  ApiRoute.ChangeCheckRuns,
  ApiRoute.ChangeCheckRunsCancel,
  ApiRoute.ChangeEvents,
  ApiRoute.Feedback,
  ApiRoute.GateApprove,
  ApiRoute.HookFeedback,
  ApiRoute.Index,
  ApiRoute.AuthoringValidatorsApply,
  ApiRoute.AuthoringValidatorsPreview,
  ApiRoute.AuthoringValidatorsRunFixtures,
  ApiRoute.Validate,
]);
const publicApiRoutes = new Set<string>([ApiRoute.Health]);

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
  const expected = pathname === ApiRoute.Settings || pathname === ApiRoute.ChangeEvents || pathname === ApiRoute.ChangeCheckRuns || pathname === ApiRoute.CanonRelated ? ["GET", "POST"] : [postApiRoutes.has(pathname) ? "POST" : "GET"];
  if (expected.includes(method)) return { ok: true };
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
  if (!url.pathname.startsWith(ApiPathPrefix) || publicApiRoutes.has(url.pathname)) return { ok: true };
  if (isAuthorizedRuntimeRequest(request, url, authToken)) return { ok: true };
  return {
    ok: false,
    error: diagnostic(diagnosticCodes.invalidRuntimeResponse, "Runtime authorization is required."),
  };
}
