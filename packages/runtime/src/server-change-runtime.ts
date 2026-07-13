import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
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
import { terminateSpawnedProcess } from "./service-process.ts";
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

const CheckCommandTimeoutMs = 2 * 60 * 1000;
const CheckCommandMaxBuffer = 1024 * 1024;

const FindingSeverityValue = {
  Error: "error",
} as const;

export const ChangeCheckResultStatus = {
  Passed: "passed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type ChangeCheckResultStatus = (typeof ChangeCheckResultStatus)[keyof typeof ChangeCheckResultStatus];

export const ChangeCheckOutputStream = {
  Stdout: "stdout",
  Stderr: "stderr",
} as const;
export type ChangeCheckOutputStream = (typeof ChangeCheckOutputStream)[keyof typeof ChangeCheckOutputStream];

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
  status: ChangeCheckResultStatus;
  summary: string;
  output: string;
  exitCode?: number | string;
};

export type RunChangeCheckOptions = {
  signal?: AbortSignal;
  onOutput?(stream: ChangeCheckOutputStream, text: string): void;
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
  options: RunChangeCheckOptions = {},
): Promise<RunChangeCheckResult> {
  if (options.signal?.aborted) return cancelledCheckResult(change.id, task?.id, check);
  if (check.kind === ChangeCheckKind.Doctor) {
    const report = buildDoctorReport({
      paths: project.paths,
      areas: project.areas,
      specs: project.specs,
      changes: project.changes,
      conventions: project.conventions,
      validators: project.validators,
      producerStatuses: resolveProducerStatuses(rootDir),
      knowledgeInspection: { kind: "available", index: store.readSemanticIndexStatus({ indexId: "project" }).index },
    });
    return {
      changeId: change.id,
      ...(task ? { taskId: task.id } : {}),
      checkId: check.id,
      kind: check.kind,
      status: report.status === "fail" ? ChangeCheckResultStatus.Failed : ChangeCheckResultStatus.Passed,
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
        status: ChangeCheckResultStatus.Failed,
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
      status: failed ? ChangeCheckResultStatus.Failed : ChangeCheckResultStatus.Passed,
      summary: failed ? `Check ${check.id} failed: validator ${check.validatorId} reported issues.` : `Check ${check.id} passed: validator ${check.validatorId}.`,
      output: trimCheckOutput([
        ...validation.diagnostics,
        ...validation.findings.map((finding) => `${finding.file}:${finding.line} ${finding.severity} ${finding.message}`),
      ].join("\n")),
    };
  }

  if (check.kind === ChangeCheckKind.Command) {
    return runShellCheck(rootDir, change.id, task?.id, check.id, check.kind, check.command, options);
  }

  return runShellCheck(rootDir, change.id, task?.id, check.id, check.kind, testCommandForTarget(check.target), options);
}

function cancelledCheckResult(changeId: string, taskId: string | undefined, check: ChangeCheck): RunChangeCheckResult {
  return {
    changeId,
    ...(taskId ? { taskId } : {}),
    checkId: check.id,
    kind: check.kind,
    status: ChangeCheckResultStatus.Cancelled,
    summary: `Check ${check.id} cancelled.`,
    output: "",
  };
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
  options: RunChangeCheckOptions,
): Promise<RunChangeCheckResult> {
  const checkRuntime = createIsolatedShellCheckRuntime(rootDir);
  try {
    return await spawnShellCheck({ rootDir, changeId, taskId, checkId, kind, command, env: checkRuntime.env, options });
  } finally {
    await cleanupIsolatedShellCheckRuntime(checkRuntime);
  }
}

function spawnShellCheck(input: {
  rootDir: string;
  changeId: string;
  taskId?: string;
  checkId: string;
  kind: ChangeCheck["kind"];
  command: string;
  env: NodeJS.ProcessEnv;
  options: RunChangeCheckOptions;
}): Promise<RunChangeCheckResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, {
      cwd: input.rootDir,
      env: input.env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (stream: ChangeCheckOutputStream, chunk: string) => {
      if (!chunk) return;
      if (stream === ChangeCheckOutputStream.Stdout) stdout = boundedCheckOutput(stdout, chunk);
      else stderr = boundedCheckOutput(stderr, chunk);
      input.options.onOutput?.(stream, chunk);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => append(ChangeCheckOutputStream.Stdout, chunk));
    child.stderr?.on("data", (chunk: string) => append(ChangeCheckOutputStream.Stderr, chunk));

    const terminate = () => {
      if (child.pid) void terminateSpawnedProcess(child.pid);
    };
    const onAbort = () => terminate();
    input.options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, CheckCommandTimeoutMs);
    timeout.unref();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.options.signal?.removeEventListener("abort", onAbort);
      if (error) append("stderr", `${error.message}\n`);
      const output = trimCheckOutput([stdout, stderr].filter(Boolean).join("\n"));
      const base = {
        changeId: input.changeId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        checkId: input.checkId,
        kind: input.kind,
        output,
        ...(exitCode === null ? {} : { exitCode }),
      };
      if (input.options.signal?.aborted) {
        resolve({ ...base, status: ChangeCheckResultStatus.Cancelled, summary: `Check ${input.checkId} cancelled.` });
      } else if (timedOut) {
        resolve({ ...base, status: ChangeCheckResultStatus.Failed, summary: `Check ${input.checkId} failed: timed out after ${CheckCommandTimeoutMs}ms.` });
      } else if (exitCode === 0 && !error) {
        resolve({ ...base, status: ChangeCheckResultStatus.Passed, summary: `Check ${input.checkId} passed.` });
      } else {
        resolve({ ...base, status: ChangeCheckResultStatus.Failed, summary: `Check ${input.checkId} failed${signal ? ` (${signal})` : ""}.` });
      }
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
}

function boundedCheckOutput(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= CheckCommandMaxBuffer) return next;
  return Buffer.from(next, "utf8").subarray(0, CheckCommandMaxBuffer).toString("utf8");
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
