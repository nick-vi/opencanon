import { z } from "zod";

export const openCanonErrorCodeValues = [
  "bun-version-mismatch",
  "engine-binary-missing",
  "engine-version-mismatch",
  "sqlite-error",
  "sqlite-schema-mismatch",
  "state-path-unwritable",
  "watcher-error",
  "schema-migration-required",
  "validator-definition-invalid",
  "unsupported-language-facts",
  "docs-decision-schema-invalid",
  "daemon-not-running",
  "hook-daemon-unavailable",
  "invalid-daemon-response",
  "project-inventory-failed",
  "invalid-engine-payload",
  "runtime-manifest-invalid",
  "runtime-update-failed",
  "config-invalid",
  "studio-invalid",
] as const;

export const OpenCanonErrorCodeSchema = z.enum(openCanonErrorCodeValues);
export type OpenCanonErrorCode = z.infer<typeof OpenCanonErrorCodeSchema>;

export const OpenCanonDiagnosticSchema = z.object({
  code: OpenCanonErrorCodeSchema,
  message: z.string().min(1),
  details: z.array(z.string().min(1)).default([]),
  action: z.string().min(1).optional(),
});
export type OpenCanonDiagnostic = z.infer<typeof OpenCanonDiagnosticSchema>;

export const OpenCanonFailureSchema = z.object({
  ok: z.literal(false),
  diagnostics: z.array(OpenCanonDiagnosticSchema).min(1),
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
}): OpenCanonDiagnostic {
  return OpenCanonDiagnosticSchema.parse({
    code: input.code,
    message: input.message,
    details: input.details ?? [],
    action: input.action,
  });
}

export function createOpenCanonFailure(diagnostics: OpenCanonDiagnostic[]): OpenCanonFailure {
  return OpenCanonFailureSchema.parse({ ok: false, diagnostics });
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
