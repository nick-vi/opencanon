import { z } from "zod";
import { formatOpenCanonProblem, isOpenCanonProblem, type OpenCanonProblem } from "./problem.ts";

export const openCanonErrorCodeValues = [
  "node-version-mismatch",
  "engine-binary-missing",
  "engine-version-mismatch",
  "sqlite-error",
  "sqlite-schema-mismatch",
  "state-path-unwritable",
  "watcher-error",
  "schema-migration-required",
  "validator-definition-invalid",
  "unsupported-language-facts",
  "docs-convention-schema-invalid",
  "runtime-not-running",
  "hook-runtime-unavailable",
  "invalid-runtime-response",
  "project-inventory-failed",
  "invalid-engine-payload",
  "inference-error",
  "runtime-manifest-invalid",
  "runtime-update-failed",
  "service-malformed-request",
  "service-route-not-found",
  "service-request-too-large",
  "service-internal-error",
  "config-invalid",
  "authoring-invalid",
] as const;

export const OpenCanonErrorCodeSchema = z.enum(openCanonErrorCodeValues);
export type OpenCanonErrorCode = z.infer<typeof OpenCanonErrorCodeSchema>;

export const OpenCanonDiagnosticSchema = z.object({
  code: OpenCanonErrorCodeSchema,
  message: z.string().min(1),
  details: z.array(z.string().min(1)).default([]),
  action: z.string().min(1).optional(),
  problem: z.custom<OpenCanonProblem>(isOpenCanonProblem).optional(),
});
export type OpenCanonDiagnostic = z.infer<typeof OpenCanonDiagnosticSchema>;

export const OpenCanonErrorPayloadKind = {
  Problem: "problem",
  Diagnostics: "diagnostics",
} as const;
export type OpenCanonErrorPayloadKind = (typeof OpenCanonErrorPayloadKind)[keyof typeof OpenCanonErrorPayloadKind];

export const OpenCanonProblemErrorPayloadSchema = z.object({
  kind: z.literal(OpenCanonErrorPayloadKind.Problem),
  problem: z.custom<OpenCanonProblem>(isOpenCanonProblem),
});
export type OpenCanonProblemErrorPayload = z.infer<typeof OpenCanonProblemErrorPayloadSchema>;

export const OpenCanonDiagnosticsErrorPayloadSchema = z.object({
  kind: z.literal(OpenCanonErrorPayloadKind.Diagnostics),
  diagnostics: z.array(OpenCanonDiagnosticSchema).min(1),
});
export type OpenCanonDiagnosticsErrorPayload = z.infer<typeof OpenCanonDiagnosticsErrorPayloadSchema>;

export const OpenCanonErrorPayloadSchema = z.discriminatedUnion("kind", [
  OpenCanonProblemErrorPayloadSchema,
  OpenCanonDiagnosticsErrorPayloadSchema,
]);
export type OpenCanonErrorPayload = z.infer<typeof OpenCanonErrorPayloadSchema>;

export const OpenCanonFailureSchema = z.object({
  ok: z.literal(false),
  error: OpenCanonErrorPayloadSchema,
});
export type OpenCanonFailure = z.infer<typeof OpenCanonFailureSchema>;

export class OpenCanonError extends Error {
  readonly diagnostics: OpenCanonDiagnostic[];

  constructor(diagnostics: OpenCanonDiagnostic[]) {
    super(formatOpenCanonDiagnostics(diagnostics));
    this.name = "OpenCanonError";
    this.diagnostics = diagnostics;
  }
}

export function createOpenCanonDiagnostic(input: {
  code: OpenCanonErrorCode;
  message: string;
  details?: string[];
  action?: string;
  problem?: OpenCanonProblem;
}): OpenCanonDiagnostic {
  return OpenCanonDiagnosticSchema.parse({
    code: input.code,
    message: input.message,
    details: input.details ?? [],
    action: input.action,
    problem: input.problem,
  });
}

export function createOpenCanonFailure(diagnostics: OpenCanonDiagnostic[]): OpenCanonFailure {
  return OpenCanonFailureSchema.parse({ ok: false, error: createOpenCanonDiagnosticsError(diagnostics) });
}

export function createOpenCanonProblemFailure(problem: OpenCanonProblem): OpenCanonFailure {
  return OpenCanonFailureSchema.parse({ ok: false, error: createOpenCanonProblemError(problem) });
}

export function createOpenCanonProblemError(problem: OpenCanonProblem): OpenCanonProblemErrorPayload {
  return OpenCanonProblemErrorPayloadSchema.parse({ kind: OpenCanonErrorPayloadKind.Problem, problem });
}

export function createOpenCanonDiagnosticsError(diagnostics: OpenCanonDiagnostic[]): OpenCanonDiagnosticsErrorPayload {
  return OpenCanonDiagnosticsErrorPayloadSchema.parse({ kind: OpenCanonErrorPayloadKind.Diagnostics, diagnostics });
}

export function parseOpenCanonErrorPayload(value: unknown): OpenCanonErrorPayload | undefined {
  if (typeof value === "string") {
    try {
      return parseOpenCanonErrorPayload(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  const parsed = OpenCanonErrorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function getOpenCanonErrorProblem(error: OpenCanonErrorPayload): OpenCanonProblem | undefined {
  if (error.kind === OpenCanonErrorPayloadKind.Problem) return error.problem;
  for (const diagnostic of error.diagnostics) {
    if (diagnostic.problem) return diagnostic.problem;
  }
  return undefined;
}

export function getOpenCanonErrorDiagnostics(error: OpenCanonErrorPayload): OpenCanonDiagnostic[] {
  if (error.kind === OpenCanonErrorPayloadKind.Diagnostics) return error.diagnostics;
  return [
    createOpenCanonDiagnostic({
      code: "invalid-runtime-response",
      message: error.problem.detail,
      details: error.problem.path ? [`Path: ${error.problem.path}`] : [],
      action: error.problem.action,
      problem: error.problem,
    }),
  ];
}

export function formatOpenCanonErrorPayload(error: OpenCanonErrorPayload): string {
  if (error.kind === OpenCanonErrorPayloadKind.Problem) return formatOpenCanonProblem(error.problem);
  return formatOpenCanonDiagnostics(error.diagnostics);
}

export function throwOpenCanonError(diagnostics: OpenCanonDiagnostic[]): never {
  throw new OpenCanonError(diagnostics);
}

export function formatOpenCanonDiagnostics(diagnostics: OpenCanonDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const lines = [`[${diagnostic.code}] ${diagnostic.message}`];
      for (const detail of diagnostic.details) lines.push(`  - ${detail}`);
      if (diagnostic.action) lines.push(`  Action: ${diagnostic.action}`);
      return lines.join("\n");
    })
    .join("\n");
}
