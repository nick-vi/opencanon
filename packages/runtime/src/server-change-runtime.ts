import { exec as execShell } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  CanonEventSchema,
  ChangeCheckKind,
  ChangeCheckEventType,
  ChangeLifecycleEventType,
  ChangeTaskEventType,
  InteractiveProducerPolicy,
  TaskLeaseStatus,
  buildDoctorReport,
  definitionTargetFiles,
  getOpenCanonErrorDiagnostics,
  loadProjectContext,
  resolveProducerStatuses,
  runValidation,
  type CanonEvent,
  type Change,
  type ChangeCheck,
  type ValidationResultCache,
} from "@opencanon/core";
import { stopService } from "./service.ts";
import type { ProjectStore } from "./state.ts";
import { validateRelativePaths } from "./server-fs.ts";
import {
  booleanBodyValue,
  runtimeInputDiagnostic,
  stringArrayBodyValue,
  stringBodyValue,
} from "./server-runtime-actions.ts";
import {
  claimTaskLease,
  releaseTaskLease,
  requireTaskLeaseOwner,
} from "./worktree-coordination.ts";

const execCommand = promisify(execShell);
const CheckCommandTimeoutMs = 2 * 60 * 1000;
const CheckCommandMaxBuffer = 1024 * 1024;

const FindingSeverityValue = {
  Error: "error",
} as const;

export const ChangeEventType = {
  Started: ChangeLifecycleEventType.Started,
  Review: ChangeLifecycleEventType.Review,
  Blocked: ChangeLifecycleEventType.Blocked,
  Ready: ChangeLifecycleEventType.Ready,
  Closed: ChangeLifecycleEventType.Closed,
  CheckStarted: ChangeCheckEventType.Started,
  CheckPassed: ChangeCheckEventType.Passed,
  CheckFailed: ChangeCheckEventType.Failed,
  TaskClaimed: ChangeTaskEventType.Claimed,
  TaskStarted: ChangeTaskEventType.Started,
  TaskReview: ChangeTaskEventType.Review,
  TaskBlocked: ChangeTaskEventType.Blocked,
  TaskReady: ChangeTaskEventType.Ready,
  TaskClosed: ChangeTaskEventType.Closed,
  TaskCheckStarted: ChangeTaskEventType.CheckStarted,
  TaskCheckPassed: ChangeTaskEventType.CheckPassed,
  TaskCheckFailed: ChangeTaskEventType.CheckFailed,
} as const;
type ChangeEventType = (typeof ChangeEventType)[keyof typeof ChangeEventType];
const changeEventTypes = new Set<string>(Object.values(ChangeEventType));

export type RunChangeCheckResult = {
  changeId: string;
  taskId?: string;
  checkId: string;
  kind: ChangeCheck["kind"];
  status: "passed" | "failed";
  summary: string;
  output: string;
  exitCode?: number | string;
};

export function parseRunChangeCheckRequest(
  body: Record<string, unknown>,
  changes: Change[],
): { ok: true; change: Change; task?: NonNullable<Change["tasks"]>[number]; checks: ChangeCheck[]; actor?: string } | { ok: false; diagnostics: unknown[] } {
  const diagnostics: unknown[] = [];
  const changeId = stringBodyValue(body.changeId)?.trim();
  const checkId = stringBodyValue(body.checkId)?.trim();
  const taskId = stringBodyValue(body.taskId)?.trim();
  const runAll = booleanBodyValue(body.all);
  const actor = stringBodyValue(body.actor)?.trim();
  const change = changeId ? changes.find((item) => item.id === changeId) : undefined;
  const task = taskId ? change?.tasks?.find((item) => item.id === taskId) : undefined;
  const allowedCheckIds = task ? new Set(task.checks ?? []) : undefined;
  const checks = change
    ? runAll
      ? (change.checks ?? []).filter((item) => !allowedCheckIds || allowedCheckIds.has(item.id))
      : (checkId ? (change.checks ?? []).filter((item) => item.id === checkId && (!allowedCheckIds || allowedCheckIds.has(item.id))) : [])
    : [];

  if (!changeId) diagnostics.push(runtimeInputDiagnostic("changeId is required."));
  else if (!change) diagnostics.push(runtimeInputDiagnostic(`Unknown change id: ${changeId}.`));
  if (taskId && !task) diagnostics.push(runtimeInputDiagnostic(`Unknown task id for ${changeId ?? "change"}: ${taskId}.`));
  if (!runAll && !checkId) diagnostics.push(runtimeInputDiagnostic("checkId is required unless all is true."));
  if (runAll && checkId) diagnostics.push(runtimeInputDiagnostic("Use either checkId or all, not both."));
  if (change && task && (task.checks ?? []).length === 0) diagnostics.push(runtimeInputDiagnostic(`Task ${task.id} has no checks.`));
  if (change && checks.length === 0 && diagnostics.length === 0) {
    diagnostics.push(runtimeInputDiagnostic(task ? `No matching checks for task ${task.id}.` : `No matching checks for change ${change.id}.`));
  }
  if (diagnostics.length > 0 || !change || checks.length === 0) return { ok: false, diagnostics };
  return { ok: true, change, ...(task ? { task } : {}), checks, actor: actor || undefined };
}

export function createChangeCheckEvent(input: {
  changeId: string;
  taskId?: string;
  checkId: string;
  type: ChangeEventType;
  actor?: string;
  summary: string;
}): CanonEvent {
  const timestamp = new Date().toISOString();
  return CanonEventSchema.parse({
    id: `change:${input.changeId}:${input.checkId}:${input.type}:${timestamp}:${randomUUID().slice(0, 8)}`,
    type: input.type,
    timestamp,
    actor: input.actor,
    files: [],
    changeIds: [input.changeId],
    taskIds: input.taskId ? [input.taskId] : [],
    checkIds: [input.checkId],
    conventionIds: [],
    validatorIds: [],
    findingIds: [],
    summary: input.summary,
  });
}

export async function runChangeCheck(
  rootDir: string,
  project: Awaited<ReturnType<typeof loadProjectContext>>,
  change: Change,
  check: ChangeCheck,
  store: ProjectStore,
  resultCache: ValidationResultCache,
  task?: NonNullable<Change["tasks"]>[number],
): Promise<RunChangeCheckResult> {
  if (check.kind === ChangeCheckKind.Doctor) {
    const report = buildDoctorReport({
      paths: project.paths,
      areas: project.areas,
      specs: project.specs,
      changes: project.changes,
      conventions: project.conventions,
      validators: project.validators,
      producerStatuses: resolveProducerStatuses(rootDir),
      semanticIndex: store.readSemanticIndexStatus({ indexId: "project" }).index,
    });
    return {
      changeId: change.id,
      ...(task ? { taskId: task.id } : {}),
      checkId: check.id,
      kind: check.kind,
      status: report.status === "fail" ? "failed" : "passed",
      summary: report.status === "fail" ? `Check ${check.id} failed: doctor status fail.` : `Check ${check.id} passed: doctor status ${report.status}.`,
      output: trimCheckOutput(report.checks.map((item) => `${item.id}: ${item.status} - ${item.message}`).join("\n")),
    };
  }

  if (check.kind === ChangeCheckKind.Validator) {
    const validator = project.validators.find((item) => item.id === check.validatorId);
    if (!validator) {
      return {
        changeId: change.id,
        ...(task ? { taskId: task.id } : {}),
        checkId: check.id,
        kind: check.kind,
        status: "failed",
        summary: `Check ${check.id} failed: unknown validator ${check.validatorId}.`,
        output: "",
      };
    }
    const scopedFiles = task?.files && task.files.length > 0 ? task.files : definitionTargetFiles(change.scope);
    const validation = await runValidation({
      rootDir,
      paths: project.paths,
      conventions: project.conventions,
      validators: [validator],
      files: scopedFiles,
      project: scopedFiles.length === 0,
      producerPolicy: InteractiveProducerPolicy,
      resultCache,
    });
    const failed = validation.diagnostics.length > 0 || validation.findings.some((finding) => finding.severity === FindingSeverityValue.Error);
    return {
      changeId: change.id,
      ...(task ? { taskId: task.id } : {}),
      checkId: check.id,
      kind: check.kind,
      status: failed ? "failed" : "passed",
      summary: failed ? `Check ${check.id} failed: validator ${check.validatorId} reported issues.` : `Check ${check.id} passed: validator ${check.validatorId}.`,
      output: trimCheckOutput([
        ...validation.diagnostics,
        ...validation.findings.map((finding) => `${finding.file}:${finding.line} ${finding.severity} ${finding.message}`),
      ].join("\n")),
    };
  }

  if (check.kind === ChangeCheckKind.Command) {
    return runShellCheck(rootDir, change.id, task?.id, check.id, check.kind, check.command);
  }

  return runShellCheck(rootDir, change.id, task?.id, check.id, check.kind, testCommandForTarget(check.target));
}

function testCommandForTarget(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  const crateMatch = /^crates\/([^/]+)\//.exec(normalized);
  if (crateMatch) return `cargo test --manifest-path ${quoteShellArg(`crates/${crateMatch[1]}/Cargo.toml`)}`;
  return `npx vitest run ${quoteShellArg(target)}`;
}

async function runShellCheck(
  rootDir: string,
  changeId: string,
  taskId: string | undefined,
  checkId: string,
  kind: ChangeCheck["kind"],
  command: string,
): Promise<RunChangeCheckResult> {
  const checkRuntime = createIsolatedShellCheckRuntime(rootDir);
  try {
    const { stdout, stderr } = await execCommand(command, {
      cwd: rootDir,
      timeout: CheckCommandTimeoutMs,
      maxBuffer: CheckCommandMaxBuffer,
      env: checkRuntime.env,
    });
    const output = trimCheckOutput([stdout, stderr].filter(Boolean).join("\n"));
    return {
      changeId,
      ...(taskId ? { taskId } : {}),
      checkId,
      kind,
      status: "passed",
      summary: `Check ${checkId} passed.`,
      output,
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; signal?: string };
    const output = trimCheckOutput([failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n"));
    return {
      changeId,
      ...(taskId ? { taskId } : {}),
      checkId,
      kind,
      status: "failed",
      summary: `Check ${checkId} failed${failure.signal ? ` (${failure.signal})` : ""}.`,
      output,
      exitCode: failure.code,
    };
  } finally {
    await cleanupIsolatedShellCheckRuntime(checkRuntime);
  }
}

type IsolatedShellCheckRuntime = {
  dir: string;
  registryPath: string;
  env: NodeJS.ProcessEnv;
};

const ShellCheckRuntimeEnvKeys = [
  "OPENCANON_SERVICE_TOKEN",
  "OPENCANON_SERVICE_LEASE_ID",
  "OPENCANON_SERVICE_OWNER_PID",
  "OPENCANON_SERVICE_PIPE_ENDPOINT",
  "OPENCANON_RUNTIME_TOKEN",
  "OPENCANON_RUNTIME_LEASE_ID",
  "OPENCANON_RUNTIME_PIPE_ENDPOINT",
] as const;

function createIsolatedShellCheckRuntime(rootDir: string): IsolatedShellCheckRuntime {
  const parentDir = path.join(rootDir, ".opencanon");
  mkdirSync(parentDir, { recursive: true });
  const dir = mkdtempSync(path.join(parentDir, "check-"));
  const registryPath = path.join(dir, "service.json");
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: registryPath };
  for (const key of ShellCheckRuntimeEnvKeys) delete env[key];
  return { dir, registryPath, env };
}

async function cleanupIsolatedShellCheckRuntime(runtime: IsolatedShellCheckRuntime): Promise<void> {
  await stopService(runtime.registryPath).catch(() => undefined);
  rmSync(runtime.dir, { recursive: true, force: true });
}

function trimCheckOutput(output: string, maxChars = 6000): string {
  const text = output.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\nOutput truncated.`;
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function parseChangeEventRequest(
  body: Record<string, unknown>,
  changes: Change[],
): { ok: true; event: CanonEvent } | { ok: false; diagnostics: unknown[] } {
  const diagnostics: unknown[] = [];
  const changeId = stringBodyValue(body.changeId)?.trim();
  const taskId = stringBodyValue(body.taskId)?.trim();
  const checkId = stringBodyValue(body.checkId)?.trim();
  const type = stringBodyValue(body.type)?.trim();
  const summary = stringBodyValue(body.summary)?.trim();
  const actor = stringBodyValue(body.actor)?.trim();
  const id = stringBodyValue(body.id)?.trim();
  const files = stringArrayBodyValue(body.files);

  if (!changeId) diagnostics.push(runtimeInputDiagnostic("changeId is required."));
  else if (!changes.some((change) => change.id === changeId)) diagnostics.push(runtimeInputDiagnostic(`Unknown change id: ${changeId}.`));
  const change = changeId ? changes.find((item) => item.id === changeId) : undefined;
  const task = taskId ? change?.tasks?.find((item) => item.id === taskId) : undefined;
  const check = checkId ? change?.checks?.find((item) => item.id === checkId) : undefined;
  if (taskId && !task) diagnostics.push(runtimeInputDiagnostic(`Unknown task id for ${changeId ?? "change"}: ${taskId}.`));
  if (checkId && !check) diagnostics.push(runtimeInputDiagnostic(`Unknown check id for ${changeId ?? "change"}: ${checkId}.`));
  if (!type) diagnostics.push(runtimeInputDiagnostic("type is required."));
  else if (!changeEventTypes.has(type)) diagnostics.push(runtimeInputDiagnostic(`Unsupported change event type: ${type}.`));
  if (type && String(type).startsWith("task-") && !taskId) diagnostics.push(runtimeInputDiagnostic(`${type} requires taskId.`));
  if (type && String(type).includes("check") && !checkId) diagnostics.push(runtimeInputDiagnostic(`${type} requires checkId.`));
  if (!summary) diagnostics.push(runtimeInputDiagnostic("summary is required."));
  if (files.length > 0) {
    const safeFiles = validateRelativePaths(files);
    if (!safeFiles.ok) diagnostics.push(...getOpenCanonErrorDiagnostics(safeFiles.error.error));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const timestamp = new Date().toISOString();
  const event = CanonEventSchema.parse({
    id: id ?? `change:${changeId}:${type}:${timestamp}:${randomUUID().slice(0, 8)}`,
    type,
    timestamp,
    actor: actor || undefined,
    files,
    changeIds: [changeId],
    taskIds: taskId ? [taskId] : [],
    checkIds: checkId ? [checkId] : [],
    conventionIds: [],
    validatorIds: [],
    findingIds: [],
    summary,
  });
  return { ok: true, event };
}

export function applyTaskOwnershipEvent(rootDir: string, event: CanonEvent): { ok: true; event: CanonEvent } | { ok: false; status: number; diagnostics: unknown[] } {
  const changeId = event.changeIds[0];
  const taskId = event.taskIds[0];
  if (!changeId || !taskId) return { ok: true, event };

  if (event.type === ChangeTaskEventType.Claimed) {
    const claim = claimTaskLease({
      rootDir,
      changeId,
      taskId,
      agentId: event.actor,
      summary: event.summary,
    });
    if (!claim.ok) return { ok: false, status: claim.status, diagnostics: claim.diagnostics };
    return { ok: true, event: eventWithLeaseActor(event, claim.result.lease.agentId) };
  }

  if (event.type === ChangeTaskEventType.Closed || event.type === ChangeTaskEventType.Blocked) {
    const release = releaseTaskLease({
      rootDir,
      changeId,
      taskId,
      agentId: event.actor,
      status: event.type === ChangeTaskEventType.Blocked ? TaskLeaseStatus.Stale : TaskLeaseStatus.Released,
      summary: event.summary,
    });
    if (!release.ok) return { ok: false, status: release.status, diagnostics: release.diagnostics };
    return { ok: true, event: release.lease ? eventWithLeaseActor(event, release.lease.agentId) : event };
  }

  if (event.type === ChangeTaskEventType.Started || event.type === ChangeTaskEventType.Review || event.type === ChangeTaskEventType.Ready) {
    const owner = requireTaskLeaseOwner({
      rootDir,
      changeId,
      taskId,
      agentId: event.actor,
      summary: event.summary,
    });
    if (!owner.ok) return { ok: false, status: owner.status, diagnostics: owner.diagnostics };
    return { ok: true, event: eventWithLeaseActor(event, owner.lease.agentId) };
  }

  return { ok: true, event };
}

function eventWithLeaseActor(event: CanonEvent, agentId: string): CanonEvent {
  if (event.actor) return event;
  return CanonEventSchema.parse({ ...event, actor: agentId });
}
