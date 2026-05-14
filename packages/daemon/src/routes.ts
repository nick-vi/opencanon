import { createOpenCanonDiagnostic } from "@opencanon/core";
import { isAuthorizedDaemonRequest } from "./auth.ts";

const HttpHeaderValue = {
  Json: "application/json; charset=utf-8",
} as const;

export const ApiRoute = {
  CanonRelated: "/api/canon/related",
  Events: "/api/events",
  EventsStream: "/api/events/stream",
  Feedback: "/api/feedback",
  Findings: "/api/findings",
  FsFile: "/api/fs/file",
  FsTree: "/api/fs/tree",
  GitDiff: "/api/git/diff",
  GitHistory: "/api/git/history",
  Health: "/api/health",
  HookFeedback: "/api/hook-feedback",
  Index: "/api/index",
  Settings: "/api/settings",
  Snapshot: "/api/snapshot",
  State: "/api/state",
  StudioFactories: "/api/studio/factories",
  StudioValidators: "/api/studio/validators",
  StudioValidatorsApply: "/api/studio/validators/apply",
  StudioValidatorsPreview: "/api/studio/validators/preview",
  StudioValidatorsRunFixtures: "/api/studio/validators/run-fixtures",
  SupervisorProjects: "/api/supervisor/projects",
  Validate: "/api/validate",
} as const;

export const ApiPathPrefix = "/api/";

export const UrlSearchParam = {
  Commit: "commit",
  DecisionId: "decisionId",
  Dot: "dot",
  File: "file",
  FindingId: "findingId",
  Limit: "limit",
  Path: "path",
  Query: "query",
  Scope: "scope",
  Topic: "topic",
  ValidatorId: "validatorId",
} as const;

export const diagnosticCodes = {
  invalidDaemonResponse: "invalid-daemon-response",
  projectInventoryFailed: "project-inventory-failed",
} as const;

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

const postApiRoutes = new Set([
  ApiRoute.Feedback,
  ApiRoute.HookFeedback,
  ApiRoute.Index,
  ApiRoute.StudioValidatorsApply,
  ApiRoute.StudioValidatorsPreview,
  ApiRoute.StudioValidatorsRunFixtures,
  ApiRoute.Validate,
]);
const publicApiRoutes = new Set([ApiRoute.Health]);

type DiagnosticCode = (typeof diagnosticCodes)[keyof typeof diagnosticCodes];
type DaemonError = { ok: false; diagnostics: unknown[] };

export function json<T>(data: ApiSuccess<T> | DaemonError, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": HttpHeaderValue.Json },
  });
}

export function diagnostic(code: DiagnosticCode, message: string): DaemonError {
  return {
    ok: false,
    diagnostics: [createOpenCanonDiagnostic({ code, message })],
  };
}

export function validateMethod(pathname: string, method: string): { ok: true } | { ok: false; error: DaemonError } {
  if (!pathname.startsWith(ApiPathPrefix)) return { ok: true };
  const expected = pathname === ApiRoute.Settings ? ["GET", "POST"] : [postApiRoutes.has(pathname) ? "POST" : "GET"];
  if (expected.includes(method)) return { ok: true };
  return {
    ok: false,
    error: diagnostic(diagnosticCodes.invalidDaemonResponse, `${pathname} requires ${expected.join(" or ")}.`),
  };
}

export function validateDaemonAuth(request: Request, url: URL, authToken: string): { ok: true } | { ok: false; error: DaemonError } {
  if (!url.pathname.startsWith(ApiPathPrefix) || publicApiRoutes.has(url.pathname)) return { ok: true };
  if (isAuthorizedDaemonRequest(request, url, authToken)) return { ok: true };
  return {
    ok: false,
    error: diagnostic(diagnosticCodes.invalidDaemonResponse, "Daemon authorization is required."),
  };
}
