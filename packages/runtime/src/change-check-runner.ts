import { randomUUID } from "node:crypto";
import {
  ChangeCheckRunEventSchema,
  ChangeCheckRunEventType,
  ChangeCheckRunSchema,
  ChangeCheckRunStatus,
  ChangeTaskEventType,
  ChangeCheckEventType,
  type Change,
  type ChangeCheck,
  type ChangeCheckRun,
  type ChangeCheckRunEvent,
  type ValidationResultCache,
} from "@opencanon/core";
import type { SimpleTracer } from "@opencanon/observability";
import { SpanKind } from "@opencanon/observability";
import { operationEvent, type EventBroadcaster } from "./server-events.ts";
import { writeRuntimeEvent } from "./server-canon-events.ts";
import {
  ChangeEventType,
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

type LoadedProject = Awaited<ReturnType<typeof loadProjectContext>>;
type ChangeTask = NonNullable<Change["tasks"]>[number];

type QueuedCheck = {
  project: LoadedProject;
  change: Change;
  task?: ChangeTask;
  check: ChangeCheck;
  runId: string;
};

export type ChangeCheckRunner = ReturnType<typeof createChangeCheckRunner>;

export function createChangeCheckRunner(input: {
  rootDir: string;
  tracer: SimpleTracer;
  events: EventBroadcaster;
  stateManager: RuntimeStateManager;
  store(): ProjectStore;
  validationResultCache(): ValidationResultCache;
}) {
  const queue: QueuedCheck[] = [];
  const controllers = new Map<string, AbortController>();
  const sequences = new Map<string, number>();
  let drainPromise: Promise<void> | undefined;
  let stopping = false;

  reconcileInterruptedRuns();

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
          ...(request.actor ? { actor: request.actor } : {}),
          createdAt: now,
          updatedAt: now,
          outputTail: "",
          outputBytes: 0,
          outputTruncated: false,
        });
        input.store().writeJob(run);
        appendEvent(run, ChangeCheckRunEventType.Queued);
        queue.push({ project: request.project, change: request.change, task: request.task, check, runId: run.id });
        return run;
      });
      scheduleDrain();
      return { batchId, runs };
    },
    get(runId: string): ChangeCheckRun | null {
      return input.store().readJob(runId);
    },
    listEvents(runId: string, afterSequence = 0): ChangeCheckRunEvent[] {
      return input.store().listJobEvents({ jobId: runId, afterSequence, limit: ReplayEventLimit });
    },
    async cancel(runId: string): Promise<ChangeCheckRun | null> {
      return cancelRun(runId);
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
      return finishCancelled(run);
    }
    controllers.get(runId)?.abort();
    return input.store().readJob(runId);
  }

  function scheduleDrain(): void {
    if (drainPromise) return;
    drainPromise = drain().finally(() => {
      drainPromise = undefined;
      if (!stopping && queue.length > 0) scheduleDrain();
    });
  }

  async function drain(): Promise<void> {
    while (!stopping && queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      await execute(item);
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

    const started = createChangeCheckEvent({
      changeId: item.change.id,
      taskId: item.task?.id,
      checkId: item.check.id,
      type: item.task ? ChangeEventType.TaskCheckStarted : ChangeEventType.CheckStarted,
      actor: run.actor,
      summary: item.task ? `Task ${item.task.id} check ${item.check.id} started.` : `Check ${item.check.id} started.`,
    });
    writeRuntimeEvent(input.rootDir, input.store(), started);
    await input.stateManager.rebuildAndPublish(started.summary);

    const pendingOutput: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    let pendingOutputBytes = 0;
    let outputFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushOutput = () => {
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      outputFlushTimer = undefined;
      pendingOutputBytes = 0;
      for (const chunk of pendingOutput.splice(0)) run = appendOutput(run, chunk.stream, chunk.text);
    };
    const queueOutput = (stream: "stdout" | "stderr", text: string) => {
      const previous = pendingOutput[pendingOutput.length - 1];
      if (previous?.stream === stream) previous.text += text;
      else pendingOutput.push({ stream, text });
      pendingOutputBytes += Buffer.byteLength(text, "utf8");
      if (pendingOutputBytes >= OutputFlushBytes) {
        flushOutput();
        return;
      }
      if (!outputFlushTimer) {
        outputFlushTimer = setTimeout(flushOutput, OutputFlushIntervalMs);
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
      flushOutput();
      const latest = input.store().readJob(run.id) ?? run;
      const finishedAt = new Date().toISOString();
      const status = result.status === "passed"
        ? ChangeCheckRunStatus.Passed
        : result.status === "cancelled"
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
      await recordTerminalCanonEvent(item, terminal);
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
      await recordTerminalCanonEvent(item, failed);
    } finally {
      if (outputFlushTimer) clearTimeout(outputFlushTimer);
      controllers.delete(run.id);
    }
  }

  function appendOutput(run: ChangeCheckRun, stream: "stdout" | "stderr", text: string): ChangeCheckRun {
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
    if (persistedText) appendEvent(next, stream === "stdout" ? ChangeCheckRunEventType.Stdout : ChangeCheckRunEventType.Stderr, persistedText);
    return next;
  }

  function appendEvent(run: ChangeCheckRun, type: ChangeCheckRunEvent["type"], text?: string): ChangeCheckRunEvent {
    const knownSequence = sequences.get(run.id) ?? latestPersistedSequence(run.id);
    const sequence = knownSequence + 1;
    const event = ChangeCheckRunEventSchema.parse({
      runId: run.id,
      batchId: run.batchId,
      sequence,
      timestamp: new Date().toISOString(),
      type,
      ...(text ? { text } : {}),
      ...(type === ChangeCheckRunEventType.Passed || type === ChangeCheckRunEventType.Failed || type === ChangeCheckRunEventType.Cancelled ? { run } : {}),
    });
    input.store().appendJobEvent(event);
    sequences.set(run.id, sequence);
    input.events.broadcast(operationEvent(event));
    return event;
  }

  function latestPersistedSequence(runId: string): number {
    const previous = input.store().listJobEvents({ jobId: runId, afterSequence: 0, limit: ReplayEventLimit });
    return previous[previous.length - 1]?.sequence ?? 0;
  }

  async function recordTerminalCanonEvent(item: QueuedCheck, run: ChangeCheckRun): Promise<void> {
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
    await input.stateManager.rebuildAndPublish(finished.summary);
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

  function reconcileInterruptedRuns(): void {
    for (const run of input.store().listJobs({ type: "change-check", limit: 500 })) {
      if (isTerminal(run)) continue;
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
  }
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
