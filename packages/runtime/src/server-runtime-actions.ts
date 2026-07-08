import {
  BatchProducerPolicy,
  InteractiveProducerPolicy,
  ProducerRunProfile,
  createCommitApprovalRecord,
  createHookFeedback,
  createOpenCanonDiagnostic,
  createPaths,
  createProfiler,
  loadCommitApprovalsWithDiagnostics,
  loadPendingCommitGates,
  loadProjectContext,
  renderHookResponse,
  resolveCommitGates,
  runFeedback,
  runValidation,
  saveCommitApprovals,
  savePendingCommitGates,
  upsertCommitApproval,
  type FeedbackHost,
  type FixMode,
  type ProducerPolicy,
  type ValidationResultCache,
} from "@opencanon/core";
import { validateRelativePaths } from "./server-fs.ts";
import { diagnostic, diagnosticCodes, diagnosticsFailure, json } from "./routes.ts";

const FeedbackHostValue = {
  Manual: "manual",
  Codex: "codex",
  Claude: "claude",
  OpenCode: "opencode",
} as const;

const FixModeInput = {
  All: "all",
  Safe: "safe",
  Suggested: "suggested",
} as const;

export function runtimeInputDiagnostic(message: string) {
  return createOpenCanonDiagnostic({ code: diagnosticCodes.invalidRuntimeResponse, message });
}

export async function approveCommitGateFromRuntime(rootDir: string, request: Request): Promise<Response> {
  const parsed = await readJsonObjectBody(request);
  if (!parsed.ok) return malformedBodyResponse();
  const body = parsed.body;
  const gateId = stringBodyValue(body.gateId)?.trim();
  const summary = stringBodyValue(body.summary)?.trim();
  if (!gateId) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "gateId is required."), 400);
  if (!summary) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "summary is required."), 400);

  const paths = createPaths(rootDir);
  const pending = loadPendingCommitGates(paths);
  const matchingGates = pending.pending.filter((gate) => gate.id === gateId);
  if (matchingGates.length > 1) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `Commit gate id is ambiguous: ${gateId}.`), 400);
  const gate = matchingGates[0];
  if (!gate) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `No pending commit gate found with id: ${gateId}.`), 404);
  if (pending.context.rootDir && pending.context.rootDir !== rootDir) {
    return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "Pending gate cache belongs to a different project root."), 409);
  }

  const loadedApprovals = loadCommitApprovalsWithDiagnostics(paths);
  if (loadedApprovals.diagnostics.length > 0) return json(diagnosticsFailure(loadedApprovals.diagnostics), 400);
  const record = createCommitApprovalRecord({
    gate,
    summary,
    approvedBy: stringBodyValue(body.approvedBy),
    approvedVia: "manual",
    context: pending.context,
  });
  const approvals = upsertCommitApproval(loadedApprovals.approvals, record);
  saveCommitApprovals(paths, approvals);
  const resolved = resolveCommitGates([...pending.pending, ...pending.approved], approvals, pending.context);
  const gates = savePendingCommitGates(paths, {
    context: pending.context,
    gates: resolved,
    diagnostics: pending.diagnostics,
    governingConventions: pending.governingConventions,
  });
  return json({ ok: true, data: { approval: record, gates } });
}

export async function validateFromRuntime(rootDir: string, request: Request, resultCache: ValidationResultCache): Promise<Response> {
  const parsed = await readJsonObjectBody(request);
  if (!parsed.ok) return malformedBodyResponse();
  const body = parsed.body;
  // H2: the same containment guard every GET FS route uses. `files` may be empty
  // (whole-project run); only when paths are supplied must each be a contained,
  // non-escaping relative path — an absolute or `..` path is rejected with a 400
  // BEFORE any file read, so an authenticated client cannot read outside rootDir.
  const requestedFiles = stringArrayBodyValue(body.files);
  if (requestedFiles.length > 0) {
    const safeFiles = validateRelativePaths(requestedFiles);
    if (!safeFiles.ok) return json(safeFiles.error, 400);
  }
  const project = await loadProjectContext(rootDir);
  const profiler = createProfiler(booleanBodyValue(body.profile));
  const producerPolicy = producerPolicyBodyValue(body.producerPolicy);
  if (!producerPolicy.ok) return json(diagnosticsFailure(producerPolicy.diagnostics), 400);
  const data = await runValidation({
    rootDir: project.rootDir,
    paths: project.paths,
    conventions: project.conventions,
    validators: project.validators,
    files: requestedFiles,
    topics: stringArrayBodyValue(body.topics),
    validatorIds: stringArrayBodyValue(body.validatorIds),
    project: booleanBodyValue(body.project),
    fixMode: fixModeBodyValue(body.fixMode),
    dryRun: booleanBodyValue(body.dryRun),
    strictProducers: booleanBodyValue(body.strictProducers),
    producerPolicy: producerPolicy.policy,
    profiler,
    resultCache,
  });
  return json({ ok: true, data });
}

export async function feedbackFromRuntime(rootDir: string, request: Request, resultCache: ValidationResultCache): Promise<Response> {
  const parsed = await readJsonObjectBody(request);
  if (!parsed.ok) return malformedBodyResponse();
  const body = parsed.body;
  // H2: reject absolute/escaping paths before runFeedback reads any file.
  const requestedFiles = stringArrayBodyValue(body.files);
  if (requestedFiles.length > 0) {
    const safeFiles = validateRelativePaths(requestedFiles);
    if (!safeFiles.ok) return json(safeFiles.error, 400);
  }
  const data = await runFeedback({
    cwd: rootDir,
    files: requestedFiles,
    host: feedbackHostBodyValue(body.host),
    sessionId: stringBodyValue(body.sessionId),
    turnId: stringBodyValue(body.turnId),
    dedupeScope: feedbackDedupeScopeBodyValue(body.dedupeScope),
    resultCache,
  });
  return json({ ok: true, data });
}

export async function hookFeedbackFromRuntime(rootDir: string, request: Request) {
  const body = await readJsonBody(request);
  const feedback = await createHookFeedback(feedbackHostBodyValue(body.host), body.payload, rootDir);
  return {
    feedback,
    response: renderHookResponse(feedback),
  };
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Strict body parse for routes that DO real change (validate/feedback): an empty
 * body is valid (use defaults), but a non-empty body that is not a JSON object
 * is a client error and must 400 — never silently fall back to `{}` and run a
 * default (potentially expensive) validation, masking a malformed request.
 */
async function readJsonObjectBody(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const text = await request.text();
  if (text.trim().length === 0) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, body: parsed as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function malformedBodyResponse(): Response {
  return json(diagnosticsFailure(["Request body is not valid JSON."]), 400);
}

export function stringArrayBodyValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export function stringBodyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function booleanBodyValue(value: unknown): boolean {
  return value === true;
}

function fixModeBodyValue(value: unknown): FixMode | undefined {
  if (value === FixModeInput.Safe || value === FixModeInput.Suggested || value === FixModeInput.All) return value;
  return undefined;
}

function producerPolicyBodyValue(value: unknown): { ok: true; policy: ProducerPolicy } | { ok: false; diagnostics: string[] } {
  if (value === undefined) return { ok: true, policy: InteractiveProducerPolicy };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, diagnostics: ["producerPolicy must be an object with profile 'batch' or 'interactive'."] };
  }
  const profile = (value as { profile?: unknown }).profile;
  if (profile === ProducerRunProfile.Batch) return { ok: true, policy: BatchProducerPolicy };
  if (profile === ProducerRunProfile.Interactive) return { ok: true, policy: InteractiveProducerPolicy };
  return { ok: false, diagnostics: ["producerPolicy.profile must be 'batch' or 'interactive'."] };
}

function feedbackHostBodyValue(value: unknown): FeedbackHost {
  if (value === FeedbackHostValue.Codex || value === FeedbackHostValue.Claude || value === FeedbackHostValue.OpenCode || value === FeedbackHostValue.Manual) return value;
  return FeedbackHostValue.Manual;
}

function feedbackDedupeScopeBodyValue(value: unknown): "off" | "turn" | "session" | undefined {
  if (value === "off" || value === "turn" || value === "session") return value;
  return undefined;
}

