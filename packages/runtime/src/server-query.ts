import type { RuntimeSnapshot } from "./snapshot.ts";
import { validateRelativePath } from "./server-fs.ts";
import { diagnostic, diagnosticCodes, type RuntimeError, UrlSearchParam } from "./routes.ts";

const CodeGraphDirection = {
  Incoming: "incoming",
  Outgoing: "outgoing",
  Both: "both",
} as const;
type CodeGraphDirection = (typeof CodeGraphDirection)[keyof typeof CodeGraphDirection];

export function numberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function optionalStringParam(url: URL, key: string): string | undefined {
  const value = (url.searchParams.get(key) ?? "").trim();
  return value || undefined;
}

export function optionalRelativePathParam(url: URL, key: string): { ok: true; path?: string } | { ok: false; error: RuntimeError } {
  const requested = optionalStringParam(url, key);
  if (!requested) return { ok: true };
  const safe = validateRelativePath(requested, { allowEmpty: false });
  if (!safe.ok) return safe;
  return { ok: true, path: safe.path };
}

export function codeGraphDirectionParam(url: URL): { ok: true; direction?: CodeGraphDirection } | { ok: false; error: RuntimeError } {
  const value = optionalStringParam(url, UrlSearchParam.Direction);
  if (!value) return { ok: true };
  if (value === CodeGraphDirection.Incoming || value === CodeGraphDirection.Outgoing || value === CodeGraphDirection.Both) {
    return { ok: true, direction: value };
  }
  return {
    ok: false,
    error: diagnostic(diagnosticCodes.invalidRuntimeResponse, "Code graph direction must be incoming, outgoing, or both."),
  };
}

export function nonNegativeNumberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function validateRelatedSelectors(
  snapshot: RuntimeSnapshot,
  query: { conventionIds: string[]; validatorIds: string[]; findingIds: string[] },
): { status: number; error: RuntimeError } | undefined {
  const missingConvention = query.conventionIds.find((id) => !snapshot.conventions.some((convention) => convention.id === id));
  if (missingConvention) return { status: 404, error: diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown convention id: ${missingConvention}.`) };
  const missingValidator = query.validatorIds.find((id) => !snapshot.validators.some((validator) => validator.id === id));
  if (missingValidator) return { status: 404, error: diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown validator id: ${missingValidator}.`) };
  const missingFinding = query.findingIds.find((id) => !snapshot.findings.some((finding) => finding.id === id));
  if (missingFinding) return { status: 404, error: diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown finding id: ${missingFinding}.`) };
  return undefined;
}
