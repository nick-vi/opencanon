import { randomUUID } from "node:crypto";
import {
  ChangeCheckRunEventSchema,
  ChangeCheckRunEventDraftSchema,
  ChangeCheckRunEventType,
  ChangeCheckRunSchema,
  ChangeCheckRunStatus,
  ChangeTaskEventType,
  ChangeCheckEventType,
  type Change,
  type ChangeCheck,
  type ChangeCheckRun,
  type ChangeCheckRunEvent,
  type ChangeCheckRunEventDraft,
  type ChangeCheckRunExecutor,
  type ChangeCheckRunPruneResult,
  type ChangeCheckRunQuery,
  type ValidationResultCache,
} from "@opencanon/core";
import type { SimpleTracer } from "@opencanon/observability";
import { SpanKind } from "@opencanon/observability";
import { activityChangedEvent, proofEvent, type EventBroadcaster } from "./server-events.ts";
import { writeRuntimeEvent } from "./server-canon-events.ts";
import { refreshChangeActivitySnapshot } from "./snapshot.ts";
import {
  ChangeEventType,
  ChangeCheckOutputStream,
  ChangeCheckResultStatus,
  createChangeCheckEvent,
  runChangeCheck,
} from "./server-change-runtime.ts";
import type { ProjectStore } from "./state.ts";
import type { RuntimeStateManager } from "./state-manager.ts";
import type { loadProjectContext } from "@opencanon/core";

const PersistedOutputLimitBytes = 1024 * 1024;
const OutputTailLimitBytes = 64 * 1024;
const OutputFlushBytes = 8 * 1024;
const OutputFlushIntervalMs = 100;
const ReplayEventLimit = 2_000;
const ActiveRunCapacity = 32;
const TerminalRunRetentionCount = 256;
const TerminalRunRetentionAgeMs = 30 * 24 * 60 * 60 * 1000;

export const ChangeCheckRunPolicy = Object.freeze({
  activeCapacity: ActiveRunCapacity,
  terminalRetentionCount: TerminalRunRetentionCount,
  terminalRetentionAgeMs: TerminalRunRetentionAgeMs,
});

type LoadedProject = Awaited<ReturnType<typeof loadProjectContext>>;
type ChangeTask = NonNullable<Change["tasks"]>[number];

type QueuedCheck = {
  project: LoadedProject;
  change: Change;
  task?: ChangeTask;
  check: ChangeCheck;
  runId: string;
};

type RunCompletion = {
  promise: Promise<ChangeCheckRun>;
  resolve(run: ChangeCheckRun): void;
};

export type ChangeCheckRunner = Awaited<ReturnType<typeof createChangeCheckRunner>>;

export async function createChangeCheckRunner(input: {
  rootDir: string;
  executor: ChangeCheckRunExecutor;
  tracer: SimpleTracer;
  events: EventBroadcaster;
  stateManager: RuntimeStateManager;
  store(): ProjectStore;
  validationResultCache(): ValidationResultCache;
  onActivity?(): void;
  onError?(error: unknown): void;
}) {
  const queue: QueuedCheck[] = [];
  const controllers = new Map<string, AbortController>();
  const completions = new Map<string, RunCompletion>();
  let drainPromise: Promise<void> | undefined;
  let stopping = false;

  const interruptedRuns = reconcileInterruptedRuns();
  await recordRetention("startup", interruptedRuns);

  return {
    start(request: { project: LoadedProject; change: Change; task?: ChangeTask; checks: ChangeCheck[]; actor?: string }) {
      if (stopping) throw new Error("Change check runner is stopping.");
      const batchId = randomUUID();
      const runs = request.checks.map((check) => {
        const now = new Date().toISOString();
        const run = ChangeCheckRunSchema.parse({
          id: randomUUID(),
          batchId,
          kind: "change-check",
          status: ChangeCheckRunStatus.Queued,
          changeId: request.change.id,
          ...(request.task ? { taskId: request.task.id } : {}),
          checkId: check.id,
          checkKind: check.kind,
          executor: input.executor,
          ...(request.actor ? { actor: request.actor } : {}),
          createdAt: now,
          updatedAt: now,
          outputTail: "",
          outputBytes: 0,
          outputTruncated: false,
        });
        return run;
      });
      const queuedEvents = runs.map((run) => createOperationEvent(run, ChangeCheckRunEventType.Queued, 1));
      const admission = input.store().admitJobs({ runs, events: queuedEvents, capacity: ActiveRunCapacity });
      if (!admission.accepted) return { ok: false as const, admission };
      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index]!;
        const event = queuedEvents[index]!;
        completions.set(run.id, createRunCompletion());
        input.events.broadcast(proofEvent(event));
        queue.push({ project: request.project, change: request.change, task: request.task, check: request.checks[index]!, runId: run.id });
      }
      input.onActivity?.();
      scheduleDrain();
      return { ok: true as const, batchId, runs };
    },
    list(query: ChangeCheckRunQuery): ChangeCheckRun[] {
      return input.store().listJobs(query);
    },
    describe(runId: string, afterSequence?: number): { run: ChangeCheckRun; latestSequence: number; events: ChangeCheckRunEvent[] } | null {
      const run = input.store().readJob(runId);
      if (!run) return null;
      return {
        run,
        latestSequence: latestPersistedSequence(runId),
        events: afterSequence === undefined ? [] : input.store().listJobEvents({ jobId: runId, afterSequence, limit: ReplayEventLimit, order: "asc" }),
      };
    },
    listEvents(runId: string, afterSequence = 0): ChangeCheckRunEvent[] {
      return input.store().listJobEvents({ jobId: runId, afterSequence, limit: ReplayEventLimit, order: "asc" });
    },
    hasActiveWork(): boolean {
      return queue.length > 0 || controllers.size > 0 || drainPromise !== undefined;
    },
    async cancel(runId: string): Promise<{ ok: true; run: ChangeCheckRun | null } | { ok: false; run: ChangeCheckRun }> {
      const run = input.store().readJob(runId);
      if (run && !isTerminal(run) && !isOwnedByCurrentExecutor(run)) return { ok: false as const, run };
      return { ok: true as const, run: await cancelRun(runId) };
    },
    async stop(): Promise<void> {
      stopping = true;
      for (const item of [...queue]) await cancelRun(item.runId);
      for (const controller of controllers.values()) controller.abort();
      await drainPromise;
    },
  };

  async function cancelRun(runId: string): Promise<ChangeCheckRun | null> {
    const run = input.store().readJob(runId);
    if (!run || isTerminal(run)) return run;
    const queuedIndex = queue.findIndex((item) => item.runId === runId);
    if (queuedIndex >= 0) {
      queue.splice(queuedIndex, 1);
      const cancelled = finishCancelled(run);
      completeRun(cancelled);
      await recordRetention("queued-cancellation", 0);
      return cancelled;
    }
    const completion = completions.get(runId)?.promise;
    controllers.get(runId)?.abort();
    return completion ? await completion : input.store().readJob(runId);
  }

  function scheduleDrain(): void {
    if (drainPromise) return;
    drainPromise = drain().finally(() => {
      drainPromise = undefined;
      if (!stopping && queue.length > 0) {
        scheduleDrain();
        return;
      }
    });
  }

  async function drain(): Promise<void> {
    while (!stopping && queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      try {
        await execute(item);
      } catch (error) {
        recoverUnexpectedRunFailure(item, error);
      }
    }
  }

  async function execute(item: QueuedCheck): Promise<void> {
    const queued = input.store().readJob(item.runId);
    if (!queued || queued.status !== ChangeCheckRunStatus.Queued) return;
    const startedAt = new Date().toISOString();
    let run = ChangeCheckRunSchema.parse({ ...queued, status: ChangeCheckRunStatus.Running, startedAt, updatedAt: startedAt });
    input.store().writeJob(run);
    appendEvent(run, ChangeCheckRunEventType.Started);
    const controller = new AbortController();
    controllers.set(run.id, controller);
    let completedRun: ChangeCheckRun | undefined;

    const started = createChangeCheckEvent({
      changeId: item.change.id,
      taskId: item.task?.id,
      checkId: item.check.id,
      type: item.task ? ChangeEventType.TaskCheckStarted : ChangeEventType.CheckStarted,
      actor: run.actor,
      summary: item.task ? `Task ${item.task.id} check ${item.check.id} started.` : `Check ${item.check.id} started.`,
    });
    writeRuntimeEvent(input.rootDir, input.store(), started);
    refreshActivityProjection(started.summary);

    const pendingOutput: Array<{ stream: ChangeCheckOutputStream; text: string }> = [];
    let pendingOutputBytes = 0;
    let outputFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let outputPersistenceError: unknown;
    const flushOutput = () => {
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      outputFlushTimer = undefined;
      pendingOutputBytes = 0;
      for (const chunk of pendingOutput.splice(0)) run = appendOutput(run, chunk.stream, chunk.text);
    };
    const queueOutput = (stream: ChangeCheckOutputStream, text: string) => {
      const previous = pendingOutput[pendingOutput.length - 1];
      if (previous?.stream === stream) previous.text += text;
      else pendingOutput.push({ stream, text });
      pendingOutputBytes += Buffer.byteLength(text, "utf8");
      if (pendingOutputBytes >= OutputFlushBytes) {
        flushOutput();
        return;
      }
      if (!outputFlushTimer) {
        outputFlushTimer = setTimeout(() => {
          try {
            flushOutput();
          } catch (error) {
            outputPersistenceError = error;
            controller.abort();
          }
        }, OutputFlushIntervalMs);
        outputFlushTimer.unref();
      }
    };

    try {
      const result = await input.tracer.span(
        "change.check.run",
        { kind: SpanKind.TASK, attributes: { changeId: item.change.id, taskId: item.task?.id, checkId: item.check.id, checkKind: item.check.kind, runId: run.id } },
        async (span) => {
          const checked = await runChangeCheck(
            input.rootDir,
            item.project,
            item.change,
            item.check,
            input.store(),
            input.validationResultCache(),
            item.task,
            {
              signal: controller.signal,
              onOutput: queueOutput,
            },
          );
          span.setOutput({ status: checked.status, runId: run.id });
          return checked;
        },
      );
      if (outputPersistenceError) throw outputPersistenceError;
      flushOutput();
      const latest = input.store().readJob(run.id) ?? run;
      const finishedAt = new Date().toISOString();
      const status = result.status === ChangeCheckResultStatus.Passed
        ? ChangeCheckRunStatus.Passed
        : result.status === ChangeCheckResultStatus.Cancelled
          ? ChangeCheckRunStatus.Cancelled
          : ChangeCheckRunStatus.Failed;
      const terminal = ChangeCheckRunSchema.parse({
        ...latest,
        status,
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
        summary: result.summary,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      });
      input.store().writeJob(terminal);
      appendEvent(terminal, terminalEventType(terminal));
      completedRun = terminal;
      recordTerminalCanonEvent(item, terminal);
    } catch (error) {
      flushOutput();
      const latest = input.store().readJob(run.id) ?? run;
      const finishedAt = new Date().toISOString();
      const failed = ChangeCheckRunSchema.parse({
        ...latest,
        status: ChangeCheckRunStatus.Failed,
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
        summary: `Check ${item.check.id} failed: ${errorMessage(error)}`,
      });
      input.store().writeJob(failed);
      appendEvent(failed, ChangeCheckRunEventType.Failed);
      completedRun = failed;
      recordTerminalCanonEvent(item, failed);
    } finally {
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      controllers.delete(run.id);
      if (completedRun) completeRun(completedRun);
    }
    await recordRetention("terminal-run", 0);
  }

  function recoverUnexpectedRunFailure(item: QueuedCheck, error: unknown): void {
    let current: ChangeCheckRun | null = null;
    try {
      current = input.store().readJob(item.runId);
    } catch (persistenceError) {
      input.onError?.(persistenceError);
    }
    if (current && !isTerminal(current)) {
      const finishedAt = new Date().toISOString();
      const failed = ChangeCheckRunSchema.parse({
        ...current,
        status: ChangeCheckRunStatus.Failed,
        startedAt: "startedAt" in current ? current.startedAt : current.createdAt,
        finishedAt,
        updatedAt: finishedAt,
        summary: `Check ${current.checkId} failed because its runtime state could not be persisted.`,
      });
      try {
        input.store().writeJob(failed);
        appendEvent(failed, ChangeCheckRunEventType.Failed);
        recordTerminalCanonEvent(item, failed);
      } catch (persistenceError) {
        input.onError?.(persistenceError);
      }
      completeRun(failed);
    }
    input.onError?.(error);
  }

  function appendOutput(run: ChangeCheckRun, stream: ChangeCheckOutputStream, text: string): ChangeCheckRun {
    const bytes = Buffer.byteLength(text, "utf8");
    const previousPersisted = Math.min(run.outputBytes, PersistedOutputLimitBytes);
    const remaining = Math.max(0, PersistedOutputLimitBytes - previousPersisted);
    const persistedText = remaining > 0 ? truncateUtf8(text, remaining) : "";
    const outputBytes = run.outputBytes + bytes;
    const next = ChangeCheckRunSchema.parse({
      ...run,
      updatedAt: new Date().toISOString(),
      outputTail: tailUtf8(run.outputTail + text, OutputTailLimitBytes),
      outputBytes,
      outputTruncated: run.outputTruncated || Buffer.byteLength(persistedText, "utf8") < bytes,
    });
    input.store().writeJob(next);
    if (persistedText) appendEvent(next, stream === ChangeCheckOutputStream.Stdout ? ChangeCheckRunEventType.Stdout : ChangeCheckRunEventType.Stderr, persistedText);
    return next;
  }

  function appendEvent(run: ChangeCheckRun, type: ChangeCheckRunEvent["type"], text?: string): ChangeCheckRunEvent {
    const event = input.store().appendJobEvent(createOperationEventDraft(run, type, text));
    input.events.broadcast(proofEvent(event));
    return event;
  }

  function latestPersistedSequence(runId: string): number {
    return input.store().listJobEvents({ jobId: runId, afterSequence: 0, limit: 1, order: "desc" })[0]?.sequence ?? 0;
  }

  function recordTerminalCanonEvent(item: QueuedCheck, run: ChangeCheckRun): void {
    const passed = run.status === ChangeCheckRunStatus.Passed;
    const finished = createChangeCheckEvent({
      changeId: item.change.id,
      taskId: item.task?.id,
      checkId: item.check.id,
      type: item.task
        ? (passed ? ChangeTaskEventType.CheckPassed : ChangeTaskEventType.CheckFailed)
        : (passed ? ChangeCheckEventType.Passed : ChangeCheckEventType.Failed),
      actor: run.actor,
      summary: "summary" in run ? run.summary : `Check ${item.check.id} ${run.status}.`,
    });
    writeRuntimeEvent(input.rootDir, input.store(), finished);
    refreshActivityProjection(finished.summary);
  }

  function refreshActivityProjection(summary: string): void {
    if (stopping) return;
    const snapshot = refreshChangeActivitySnapshot({
      snapshot: input.stateManager.currentSnapshot(),
      changeCatalog: input.stateManager.currentChangeCatalog(),
      store: input.store(),
    });
    input.stateManager.setSnapshot(snapshot);
    input.events.broadcast(activityChangedEvent(summary, snapshot.changes.map((change) => change.id)));
  }

  function finishCancelled(run: ChangeCheckRun): ChangeCheckRun {
    const finishedAt = new Date().toISOString();
    const cancelled = ChangeCheckRunSchema.parse({
      ...run,
      status: ChangeCheckRunStatus.Cancelled,
      finishedAt,
      updatedAt: finishedAt,
      summary: `Check ${run.checkId} cancelled before it started.`,
    });
    input.store().writeJob(cancelled);
    appendEvent(cancelled, ChangeCheckRunEventType.Cancelled);
    return cancelled;
  }

  function reconcileInterruptedRuns(): number {
    const activeRuns = input.store().listJobs({ mode: "active" }).filter(
      (run) =>
        run.executor.runtimeNamespace === input.executor.runtimeNamespace &&
        run.executor.leaseId !== input.executor.leaseId,
    );
    for (const run of activeRuns) {
      const finishedAt = new Date().toISOString();
      const failed = ChangeCheckRunSchema.parse({
        ...run,
        status: ChangeCheckRunStatus.Failed,
        startedAt: "startedAt" in run ? run.startedAt : run.createdAt,
        finishedAt,
        updatedAt: finishedAt,
        summary: `Check ${run.checkId} was interrupted when the project runtime stopped.`,
        interrupted: true,
      });
      input.store().writeJob(failed);
      appendEvent(failed, ChangeCheckRunEventType.Failed);
    }
    return activeRuns.length;
  }

  function isOwnedByCurrentExecutor(run: ChangeCheckRun): boolean {
    return run.executor.runtimeNamespace === input.executor.runtimeNamespace && run.executor.leaseId === input.executor.leaseId;
  }

  async function recordRetention(trigger: string, interruptedRuns: number): Promise<ChangeCheckRunPruneResult> {
    return input.tracer.span(
      "change.check.retention",
      { kind: SpanKind.INTERNAL, attributes: { trigger, interruptedRuns } },
      async (span) => {
        const result = input.store().pruneJobs({
          terminalBefore: new Date(Date.now() - TerminalRunRetentionAgeMs).toISOString(),
          maxTerminalCount: TerminalRunRetentionCount,
        });
        span.setOutput(result);
        return result;
      },
    );
  }

  function completeRun(run: ChangeCheckRun): void {
    const completion = completions.get(run.id);
    if (!completion) return;
    completions.delete(run.id);
    completion.resolve(run);
    input.onActivity?.();
  }
}

function createRunCompletion(): RunCompletion {
  let resolve!: (run: ChangeCheckRun) => void;
  const promise = new Promise<ChangeCheckRun>((completed) => {
    resolve = completed;
  });
  return { promise, resolve };
}

function createOperationEvent(
  run: ChangeCheckRun,
  type: ChangeCheckRunEvent["type"],
  sequence: number,
  text?: string,
): ChangeCheckRunEvent {
  return ChangeCheckRunEventSchema.parse({
    ...createOperationEventDraft(run, type, text),
    sequence,
  });
}

function createOperationEventDraft(
  run: ChangeCheckRun,
  type: ChangeCheckRunEvent["type"],
  text?: string,
): ChangeCheckRunEventDraft {
  return ChangeCheckRunEventDraftSchema.parse({
    runId: run.id,
    batchId: run.batchId,
    timestamp: new Date().toISOString(),
    type,
    ...(text ? { text } : {}),
    ...(type === ChangeCheckRunEventType.Passed || type === ChangeCheckRunEventType.Failed || type === ChangeCheckRunEventType.Cancelled ? { run } : {}),
  });
}

function terminalEventType(run: ChangeCheckRun): ChangeCheckRunEvent["type"] {
  if (run.status === ChangeCheckRunStatus.Passed) return ChangeCheckRunEventType.Passed;
  if (run.status === ChangeCheckRunStatus.Cancelled) return ChangeCheckRunEventType.Cancelled;
  return ChangeCheckRunEventType.Failed;
}

function isTerminal(run: ChangeCheckRun): boolean {
  return run.status === ChangeCheckRunStatus.Passed || run.status === ChangeCheckRunStatus.Failed || run.status === ChangeCheckRunStatus.Cancelled;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return decodeUtf8Boundary(Buffer.from(value, "utf8"), 0, maxBytes, "end");
}

function tailUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  return decodeUtf8Boundary(bytes, bytes.length - maxBytes, bytes.length, "start");
}

function decodeUtf8Boundary(bytes: Buffer, initialStart: number, initialEnd: number, adjust: "start" | "end"): string {
  let start = initialStart;
  let end = initialEnd;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (start < end) {
    try {
      return decoder.decode(bytes.subarray(start, end));
    } catch {
      if (adjust === "start") start += 1;
      else end -= 1;
    }
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
