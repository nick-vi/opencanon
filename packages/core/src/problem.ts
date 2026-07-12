export const OpenCanonProblemSchemaId = "opencanon.problem.v1";

export const OpenCanonProblemCode = {
  ProjectDefinitionMissing: "project-definition-missing",
  ProjectNotFound: "project-not-found",
  RuntimePreflightFailed: "runtime-preflight-failed",
  ServiceUnavailable: "service-unavailable",
  RuntimeUnavailable: "runtime-unavailable",
  TransportFailed: "transport-failed",
  Unauthorized: "unauthorized",
  Unknown: "unknown",
} as const;
export type OpenCanonProblemCode = (typeof OpenCanonProblemCode)[keyof typeof OpenCanonProblemCode];

export const OpenCanonProblemSource = {
  Client: "client",
  Project: "project",
  Protocol: "protocol",
  Runtime: "runtime",
  Service: "service",
  Unknown: "unknown",
} as const;
export type OpenCanonProblemSource = (typeof OpenCanonProblemSource)[keyof typeof OpenCanonProblemSource];

export type OpenCanonProblem = {
  schema: typeof OpenCanonProblemSchemaId;
  code: OpenCanonProblemCode;
  title: string;
  detail: string;
  source: OpenCanonProblemSource;
  path?: string;
  action?: string;
  retryable?: boolean;
  status?: number;
  details?: Record<string, unknown>;
};

export type OpenCanonProblemInput = Omit<OpenCanonProblem, "schema">;

export function createOpenCanonProblem(input: OpenCanonProblemInput): OpenCanonProblem {
  return {
    schema: OpenCanonProblemSchemaId,
    code: input.code,
    title: input.title,
    detail: input.detail,
    source: input.source,
    ...(input.path ? { path: input.path } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.details ? { details: input.details } : {}),
  };
}

export function createProjectDefinitionMissingProblem(input: { rootDir: string; path: string }): OpenCanonProblem {
  return createOpenCanonProblem({
    code: OpenCanonProblemCode.ProjectDefinitionMissing,
    title: "Required Project Canon definition is missing",
    detail: "The project cannot start because a required Project Canon entrypoint is missing.",
    source: OpenCanonProblemSource.Project,
    path: input.path,
    action: `Run opencanon init --yes in ${input.rootDir} to restore required project files, then start the project again.`,
    retryable: false,
    status: 422,
    details: { rootDir: input.rootDir },
  });
}

export function isOpenCanonProblem(value: unknown): value is OpenCanonProblem {
  if (!isRecord(value)) return false;
  return (
    value.schema === OpenCanonProblemSchemaId &&
    isOpenCanonProblemCode(value.code) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.detail === "string" &&
    value.detail.trim().length > 0 &&
    isOpenCanonProblemSource(value.source)
  );
}

export function parseOpenCanonProblem(value: unknown): OpenCanonProblem | undefined {
  if (isOpenCanonProblem(value)) return value;
  if (typeof value === "string") {
    try {
      return parseOpenCanonProblem(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.error)) {
    const problem = parseOpenCanonProblem(value.error);
    if (problem) return problem;
  }
  if (value.kind === "problem") {
    const problem = parseOpenCanonProblem(value.problem);
    if (problem) return problem;
  }
  if (Array.isArray(value.diagnostics)) {
    for (const diagnostic of value.diagnostics) {
      const problem = parseOpenCanonProblemFromDiagnostic(diagnostic);
      if (problem) return problem;
    }
  }
  return undefined;
}

export function parseOpenCanonProblemFromError(error: unknown): OpenCanonProblem | undefined {
  if (isOpenCanonProblem(error)) return error;
  if (error instanceof Error) return parseOpenCanonProblem(error.message);
  return parseOpenCanonProblem(error);
}

export function serializeOpenCanonProblem(problem: OpenCanonProblem): string {
  return JSON.stringify(problem);
}

export function formatOpenCanonProblem(problem: OpenCanonProblem): string {
  const lines = [`[${problem.code}] ${problem.detail}`];
  if (problem.path) lines.push(`Path: ${problem.path}`);
  if (problem.action) lines.push(`Action: ${problem.action}`);
  return lines.join("\n");
}

function parseOpenCanonProblemFromDiagnostic(value: unknown): OpenCanonProblem | undefined {
  if (!isRecord(value)) return parseOpenCanonProblem(value);
  const direct = parseOpenCanonProblem(value.problem);
  if (direct) return direct;
  return parseOpenCanonProblem(value.details);
}

function isOpenCanonProblemCode(value: unknown): value is OpenCanonProblemCode {
  return typeof value === "string" && (Object.values(OpenCanonProblemCode) as string[]).includes(value);
}

function isOpenCanonProblemSource(value: unknown): value is OpenCanonProblemSource {
  return typeof value === "string" && (Object.values(OpenCanonProblemSource) as string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
