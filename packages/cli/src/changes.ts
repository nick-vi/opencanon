import { randomUUID } from "node:crypto";
import { cac } from "cac";
import {
  ChangeCheckEventType,
  ChangeCheckRunEventSchema,
  ChangeCheckRunEventType,
  ChangeCheckRunStatus,
  ChangeLifecycleEventType,
  ChangeTaskEventType,
  fail,
  Format,
  StartChangeCheckRunsResponseSchema,
  type ChangeCheckRun,
  type ChangeCheckRunEvent,
  type StartChangeCheckRunsResponse,
  type DefinitionTarget,
} from "@opencanon/core";
import { booleanOption, formatOption, positiveIntegerOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { changesDefinitionCommandSuggestion, isChangeDefinitionCommand, runChangesDefinitionCommand } from "./changes-definition.ts";
import { RuntimeApiRoute, withRuntimeClient, type RuntimeClient } from "./runtime-client.ts";

const ChangeEventType = {
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

const ChangeWorkItemKind = {
  Change: "change",
  Task: "task",
} as const;

type ChangeSummary = {
  id: string;
  title: string;
  kind: string;
  summary: string;
  boardColumn: string;
  taskCount: number;
  readyTaskCount: number;
  blockedTaskCount: number;
  tasks: ChangeTaskSummary[];
  checks: Array<{ id: string; kind: string }>;
  scope: DefinitionTarget[];
  lastEvent?: { type: string; timestamp: string; summary: string };
};

type ChangeTaskSummary = {
  id: string;
  title: string;
  detail?: string;
  files: string[];
  surfaces: string[];
  checks: string[];
  dependsOn: string[];
  blockedBy: string[];
  updates: {
    areas: string[];
    specs: string[];
    conventions: string[];
    surfaces: string[];
    docs: string[];
  };
  status: string;
  ready: boolean;
  blockedReasons: string[];
  checkStates: Array<{ id: string; kind: string; status: string; latestEvent?: { type: string; timestamp: string; summary: string } }>;
  latestEvent?: { type: string; timestamp: string; summary: string };
};

type ChangeEvent = {
  id: string;
  type: string;
  timestamp: string;
  actor?: string;
  files: string[];
  changeIds: string[];
  taskIds: string[];
  checkIds: string[];
  summary: string;
};

type RecordChangeEventResponse = {
  event: ChangeEvent;
  changes: ChangeSummary[];
};

type ChangeWorkQueue = {
  ready: Array<{
    kind: "change" | "task";
    changeId: string;
    changeTitle: string;
    taskId?: string;
    taskTitle?: string;
    checks: string[];
    files: string[];
    surfaces: string[];
    updates: {
      areas: string[];
      specs: string[];
      conventions: string[];
      surfaces: string[];
      docs: string[];
    };
    suggestedCommands: string[];
    reason: string;
  }>;
  blocked: Array<{
    kind: "change" | "task";
    changeId: string;
    changeTitle: string;
    taskId?: string;
    taskTitle?: string;
    checks: string[];
    files: string[];
    surfaces: string[];
    updates: {
      areas: string[];
      specs: string[];
      conventions: string[];
      surfaces: string[];
      docs: string[];
    };
    suggestedCommands: string[];
    reason: string;
    blockedReasons: string[];
  }>;
};

type ChangesCommandOptions = {
  allowDefinitionCommands?: boolean;
  listCommandName?: string;
};

function withChangesRuntimeClient<T>(cwd: string, fn: (client: RuntimeClient) => Promise<T>): Promise<T> {
  return withRuntimeClient(cwd, fn);
}

export async function runChangesCommand(args: string[], cwd: string, options: ChangesCommandOptions = {}): Promise<void> {
  const [command = "list", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    printChangesHelp();
    return;
  }
  if (command === "list") {
    await runChangesListCommand(rest, cwd, options.listCommandName ?? "opencanon changes list");
    return;
  }
  if (command === "ready") {
    await runChangesReadyCommand(rest, cwd);
    return;
  }
  if (command === "show") {
    await runChangesShowCommand(rest, cwd);
    return;
  }
  if (command === "events") {
    await runChangesEventsCommand(rest, cwd);
    return;
  }
  if (["claim", "start", "block", "review", "mark-ready", "close"].includes(command)) {
    await runChangesLifecycleCommand(command, rest, cwd);
    return;
  }
  if (command === "check") {
    await runChangesCheckCommand(rest, cwd);
    return;
  }
  if (!options.allowDefinitionCommands && isChangeDefinitionCommand(command)) {
    fail(`Unknown changes command: ${command}. Use ${changesDefinitionCommandSuggestion(command)} instead.`);
  }
  if (isChangeDefinitionCommand(command)) {
    await runChangesDefinitionCommand(command, rest, cwd);
    return;
  }
  if (command === "record") {
    await runChangesRecordCommand(rest, cwd);
    return;
  }
  fail(`Unknown changes command: ${command}`);
}

async function runChangesListCommand(args: string[], cwd: string, commandName: string): Promise<void> {
  const cli = cac(commandName);
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected ${commandName} arguments: ${parsed.args.join(", ")}`);

  const changes = await withChangesRuntimeClient(cwd, (client) => client.get<ChangeSummary[]>(RuntimeApiRoute.Changes));
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify({ changes }, null, 2));
  else console.log(renderChangesListMarkdown(changes));
}

async function runChangesReadyCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon changes ready");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected opencanon changes ready arguments: ${parsed.args.join(", ")}`);

  const queue = await withChangesRuntimeClient(cwd, (client) => client.get<ChangeWorkQueue>(RuntimeApiRoute.ChangeReady));
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(queue, null, 2));
  else console.log(renderChangesReadyMarkdown(queue));
}

async function runChangesShowCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon changes show");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--events <count>", "Recent events to include.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "events"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesHelp();
    return;
  }
  const changeId = requiredSingleArgument(parsed.args, "changes show");
  const limit = positiveIntegerOption(options.events, "--events", 25);
  const { changes, events } = await withChangesRuntimeClient(cwd, async (client) => ({
    changes: await client.get<ChangeSummary[]>(RuntimeApiRoute.Changes),
    events: await client.get<ChangeEvent[]>(`${RuntimeApiRoute.ChangeEvents}?changeId=${encodeURIComponent(changeId)}&limit=${limit}`),
  }));
  const change = changes.find((item) => item.id === changeId);
  if (!change) fail(`Unknown change id: ${changeId}`);
  const result = { change, events };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangesShowMarkdown(change, events));
}

async function runChangesEventsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon changes events");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--limit <count>", "Maximum events to return.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "limit"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesHelp();
    return;
  }
  const [changeId] = parsed.args;
  if (!changeId || parsed.args.length > 1) fail("Usage: opencanon changes events <change-id>");
  const limit = positiveIntegerOption(options.limit, "--limit", 50);
  const path = `${RuntimeApiRoute.ChangeEvents}?changeId=${encodeURIComponent(String(changeId))}&limit=${String(limit)}`;
  const events = await withChangesRuntimeClient(cwd, (client) => client.get<ChangeEvent[]>(path));
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify({ events }, null, 2));
  else console.log(renderChangeEventsMarkdown(String(changeId), events));
}

async function runChangesRecordCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon changes record");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--type <type>", "Change event type.");
  cli.option("--summary <summary>", "Event summary.");
  cli.option("--actor <actor>", "Event actor.");
  cli.option("--file <path>", "File touched by the event. Repeatable.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "type", "summary", "actor", "file"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesHelp();
    return;
  }
  const [changeId] = parsed.args;
  if (!changeId || parsed.args.length > 1) fail("Usage: opencanon changes record <change-id> --type <type> --summary <summary>");
  const type = stringOption(options.type, "--type") as ChangeEventType;
  if (!changeEventTypes.has(type)) fail(`Unsupported --type: ${type}`);
  const summary = stringOption(options.summary, "--summary");
  const actor = optionalStringOption(options.actor, "--actor");
  const files = stringValues(options.file);
  const eventId = createChangeRequestEventId(String(changeId), type);

  const result = await withChangesRuntimeClient(cwd, (client) =>
    client.post<RecordChangeEventResponse>(RuntimeApiRoute.ChangeEvents, {
      id: eventId,
      changeId: String(changeId),
      type,
      summary,
      actor,
      files,
    }),
  );
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderRecordedChangeEventMarkdown(result.event));
}

async function runChangesLifecycleCommand(command: string, args: string[], cwd: string): Promise<void> {
  const cli = cac(`opencanon changes ${command}`);
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--task <id>", "Task id.");
  cli.option("--summary <summary>", "Event summary.");
  cli.option("--actor <actor>", "Event actor.");
  cli.option("--agent <agent>", "Agent id recorded as the event actor.");
  cli.option("--file <path>", "File touched by the event. Repeatable.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "task", "summary", "actor", "agent", "file"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesHelp();
    return;
  }
  const changeId = requiredSingleArgument(parsed.args, `changes ${command}`);
  const taskId = optionalStringOption(options.task, "--task");
  const type = lifecycleEventType(command, taskId);
  const summary = optionalStringOption(options.summary, "--summary") ?? defaultLifecycleSummary(command, changeId, taskId);
  const eventId = createChangeRequestEventId(changeId, type);
  const result = await withChangesRuntimeClient(cwd, (client) =>
    client.post<RecordChangeEventResponse>(RuntimeApiRoute.ChangeEvents, {
      id: eventId,
      changeId,
      taskId,
      type,
      summary,
      actor: optionalStringOption(options.agent, "--agent") ?? optionalStringOption(options.actor, "--actor"),
      files: stringValues(options.file),
    }),
  );
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderRecordedChangeEventMarkdown(result.event));
}

async function runChangesCheckCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon changes check");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--task <id>", "Task id.");
  cli.option("--all", "Run every check for the change or task.");
  cli.option("--actor <actor>", "Actor recorded on check events.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "task", "all", "actor"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesHelp();
    return;
  }
  const values = parsed.args.map(String);
  if (values.length < 1 || values.length > 2 || !values[0]) fail("Usage: opencanon changes check <change-id> [check-id] [--task <task-id>] [--all]");
  const all = booleanOption(options.all);
  const format = formatOption(options.format);
  const result = await withChangesRuntimeClient(cwd, async (client) => {
    const started = StartChangeCheckRunsResponseSchema.parse(
      await client.post<StartChangeCheckRunsResponse>(RuntimeApiRoute.ChangeCheckRuns, {
        changeId: values[0],
        checkId: values[1],
        taskId: optionalStringOption(options.task, "--task"),
        all,
        actor: optionalStringOption(options.actor, "--actor"),
      }),
    );
    const runs: ChangeCheckRun[] = [];
    if (format !== Format.Json) {
      console.log(`# OpenCanon Change Check\n\nChange: ${values[0]}\nBatch: ${started.batchId}`);
    }
    for (const run of started.runs) {
      if (format !== Format.Json) console.log(`\nCheck: ${run.checkId}\nStatus: running\n`);
      runs.push(await followChangeCheckRun(client, run, format));
    }
    return { batchId: started.batchId, runs };
  });
  if (format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderRunChangeCheckMarkdown(result));
  process.exitCode = result.runs.some((item) => item.status !== ChangeCheckRunStatus.Passed) ? 1 : 0;
}

async function followChangeCheckRun(client: RuntimeClient, initial: ChangeCheckRun, format: Format): Promise<ChangeCheckRun> {
  let cursor = 0;
  let terminal: ChangeCheckRun | undefined;
  let cancelRequested = false;
  const onInterrupt = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void client.post(RuntimeApiRoute.ChangeCheckRunsCancel, { runId: initial.id }).catch((error) => {
      process.stderr.write(`Could not cancel Change check ${initial.checkId}: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  process.once("SIGINT", onInterrupt);
  try {
    for (let reconnect = 0; reconnect < 3 && !terminal; reconnect += 1) {
      const controller = new AbortController();
      const parser = createSseParser((event) => {
        if (event.runId !== initial.id || event.sequence <= cursor) return;
        cursor = event.sequence;
        if (event.type === ChangeCheckRunEventType.Stdout || event.type === ChangeCheckRunEventType.Stderr) {
          const output = format === Format.Json ? process.stderr : event.type === ChangeCheckRunEventType.Stdout ? process.stdout : process.stderr;
          output.write(event.text);
          return;
        }
        if (event.type === ChangeCheckRunEventType.Passed || event.type === ChangeCheckRunEventType.Failed || event.type === ChangeCheckRunEventType.Cancelled) {
          terminal = event.run;
          controller.abort();
        }
      });
      try {
        await client.stream(`${RuntimeApiRoute.EventsStream}?runId=${encodeURIComponent(initial.id)}&after=${cursor}`, {
          signal: controller.signal,
          onChunk: parser.push,
        });
      } catch (error) {
        if (terminal) break;
        if (reconnect >= 2) throw error;
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  if (!terminal) throw new Error(`Change check ${initial.checkId} event stream ended without a terminal result.`);
  return terminal;
}

function createSseParser(onOperation: (event: ChangeCheckRunEvent) => void): { push(chunk: string): void } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n/g, "\n");
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) return;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as { operation?: unknown };
          if (parsed.operation) onOperation(ChangeCheckRunEventSchema.parse(parsed.operation));
        } catch (error) {
          throw new Error(`OpenCanon returned a malformed Change check event: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}

function lifecycleEventType(command: string, taskId: string | undefined): ChangeEventType {
  switch (command) {
    case "claim":
      if (!taskId) fail("opencanon changes claim requires --task.");
      return ChangeEventType.TaskClaimed;
    case "start":
      return taskId ? ChangeEventType.TaskStarted : ChangeEventType.Started;
    case "block":
      return taskId ? ChangeEventType.TaskBlocked : ChangeEventType.Blocked;
    case "review":
      return taskId ? ChangeEventType.TaskReview : ChangeEventType.Review;
    case "mark-ready":
      return taskId ? ChangeEventType.TaskReady : ChangeEventType.Ready;
    case "close":
      return taskId ? ChangeEventType.TaskClosed : ChangeEventType.Closed;
    default:
      fail(`Unsupported changes lifecycle command: ${command}`);
  }
}

function createChangeRequestEventId(changeId: string, type: ChangeEventType): string {
  return `change:${changeId}:${type}:${new Date().toISOString()}:${randomUUID().slice(0, 8)}`;
}

function defaultLifecycleSummary(command: string, changeId: string, taskId: string | undefined): string {
  const target = taskId ? `task ${taskId} in ${changeId}` : `change ${changeId}`;
  switch (command) {
    case "claim":
      return `Claimed ${target}.`;
    case "start":
      return `Started ${target}.`;
    case "block":
      return `Blocked ${target}.`;
    case "review":
      return `Moved ${target} to review.`;
    case "mark-ready":
      return `Marked ${target} ready.`;
    case "close":
      return `Closed ${target}.`;
    default:
      return `Updated ${target}.`;
  }
}

function renderChangesListMarkdown(changes: ChangeSummary[]): string {
  const lines = ["# OpenCanon Changes", ""];
  if (changes.length === 0) {
    lines.push("No change definitions found.");
    return lines.join("\n");
  }
  for (const change of changes) {
    lines.push(`- [${change.boardColumn}] ${change.id}: ${change.title}`);
    lines.push(`  - kind: ${change.kind}`);
    lines.push(`  - checks: ${change.checks.length}`);
    if (change.taskCount > 0) lines.push(`  - tasks: ${change.taskCount} (${change.readyTaskCount} ready, ${change.blockedTaskCount} blocked)`);
    if (change.lastEvent) lines.push(`  - last event: ${change.lastEvent.type} at ${change.lastEvent.timestamp}`);
  }
  return lines.join("\n");
}

function renderChangesReadyMarkdown(queue: ChangeWorkQueue): string {
  const lines = ["# OpenCanon Ready Work", ""];
  if (queue.ready.length === 0) lines.push("No ready work.");
  for (const item of queue.ready) {
    lines.push(`- ${workItemLabel(item)}`);
    if (item.files.length > 0) lines.push(`  - files: ${item.files.join(", ")}`);
    if (item.surfaces.length > 0) lines.push(`  - surfaces: ${item.surfaces.join(", ")}`);
    if (item.checks.length > 0) lines.push(`  - checks: ${item.checks.join(", ")}`);
    if (item.suggestedCommands.length > 0) {
      lines.push("  - next:");
      for (const command of item.suggestedCommands) lines.push(`    - \`${command}\``);
    }
    lines.push(`  - reason: ${item.reason}`);
  }
  if (queue.blocked.length > 0) {
    lines.push("", "Blocked:");
    for (const item of queue.blocked) {
      lines.push(`- ${workItemLabel(item)}`);
      for (const reason of item.blockedReasons) lines.push(`  - ${reason}`);
    }
  }
  return lines.join("\n");
}

function renderChangesShowMarkdown(change: ChangeSummary, events: ChangeEvent[]): string {
  const lines = ["# OpenCanon Change", "", `Change: ${change.id}`, `Title: ${change.title}`, `Kind: ${change.kind}`, `Board: ${change.boardColumn}`, "", "Tasks:"];
  if (change.tasks.length === 0) lines.push("- <none>");
  for (const task of change.tasks) {
    lines.push(`- [${task.status}] ${task.id}: ${task.title}`);
    if (task.ready) lines.push("  - ready: true");
    if (task.dependsOn.length > 0) lines.push(`  - depends on: ${task.dependsOn.join(", ")}`);
    if (task.blockedReasons.length > 0) lines.push(`  - blocked: ${task.blockedReasons.join("; ")}`);
    if (task.checks.length > 0) lines.push(`  - checks: ${task.checks.join(", ")}`);
    if (task.files.length > 0) lines.push(`  - files: ${task.files.join(", ")}`);
    if (task.surfaces.length > 0) lines.push(`  - surfaces: ${task.surfaces.join(", ")}`);
  }
  lines.push("", "Checks:");
  if (change.checks.length === 0) lines.push("- <none>");
  for (const check of change.checks) lines.push(`- ${check.id} (${check.kind})`);
  lines.push("", "Recent events:");
  if (events.length === 0) lines.push("- <none>");
  for (const event of events) {
    lines.push(`- [${event.type}] ${event.timestamp}: ${event.summary}`);
    if (event.taskIds.length > 0) lines.push(`  - tasks: ${event.taskIds.join(", ")}`);
    if (event.checkIds.length > 0) lines.push(`  - checks: ${event.checkIds.join(", ")}`);
  }
  return lines.join("\n");
}

function workItemLabel(item: ChangeWorkQueue["ready"][number] | ChangeWorkQueue["blocked"][number]): string {
  return item.kind === ChangeWorkItemKind.Task
    ? `${item.changeId}/${item.taskId}: ${item.taskTitle}`
    : `${item.changeId}: ${item.changeTitle}`;
}

function renderChangeEventsMarkdown(changeId: string, events: ChangeEvent[]): string {
  const lines = ["# OpenCanon Change Events", "", `Change: ${changeId}`, ""];
  if (events.length === 0) {
    lines.push("No events recorded.");
    return lines.join("\n");
  }
  for (const event of events) {
    lines.push(`- [${event.type}] ${event.timestamp}: ${event.summary}`);
    if (event.actor) lines.push(`  - actor: ${event.actor}`);
    if (event.taskIds.length > 0) lines.push(`  - tasks: ${event.taskIds.join(", ")}`);
    if (event.checkIds.length > 0) lines.push(`  - checks: ${event.checkIds.join(", ")}`);
    if (event.files.length > 0) lines.push(`  - files: ${event.files.join(", ")}`);
  }
  return lines.join("\n");
}

function renderRecordedChangeEventMarkdown(event: ChangeEvent): string {
  return [
    "# OpenCanon Change Event",
    "",
    `Status: recorded`,
    `Change: ${event.changeIds.join(", ")}`,
    ...(event.taskIds.length > 0 ? [`Task: ${event.taskIds.join(", ")}`] : []),
    ...(event.checkIds.length > 0 ? [`Check: ${event.checkIds.join(", ")}`] : []),
    `Type: ${event.type}`,
    `Summary: ${event.summary}`,
    `Timestamp: ${event.timestamp}`,
  ].join("\n");
}

function renderRunChangeCheckMarkdown(response: { batchId: string; runs: ChangeCheckRun[] }): string {
  const lines = ["", "Results:"];
  for (const run of response.runs) {
    lines.push(`- ${run.checkId}: ${run.status}${"summary" in run ? ` - ${run.summary}` : ""}`);
    if ("exitCode" in run && run.exitCode !== undefined) lines.push(`  Exit code: ${String(run.exitCode)}`);
    if (run.outputTruncated) lines.push(`  Output was truncated after ${run.outputBytes} bytes.`);
  }
  return lines.join("\n");
}

function requiredSingleArgument(args: readonly unknown[], command: string): string {
  const values = args.map(String);
  if (values.length === 0 || !values[0]) fail(`Missing ${command} id.`);
  if (values.length > 1) fail(`Unexpected ${command} arguments: ${values.slice(1).join(", ")}`);
  return values[0];
}

function stringOption(value: unknown, flag: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${flag} requires a value.`);
  return value.trim();
}

function optionalStringOption(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") fail(`${flag} requires a value.`);
  return value.trim();
}

function printChangesHelp(): void {
  console.log(`Usage:
  opencanon changes list
  opencanon changes ready
  opencanon changes show <change-id>
  opencanon changes events <change-id>
  opencanon changes claim <change-id> --task <task-id> [--agent <id>]
  opencanon changes start <change-id> [--task <task-id>]
  opencanon changes block <change-id> [--task <task-id>] --summary <summary>
  opencanon changes review <change-id> [--task <task-id>]
  opencanon changes mark-ready <change-id> [--task <task-id>]
  opencanon changes close <change-id> [--task <task-id>]
  opencanon changes check <change-id> [check-id] [--task <task-id>] [--all]

Commands:
  list             Show typed change definitions with derived board state.
  ready            Show unblocked Changes or tasks ready for an agent to work.
  show             Show one Change, its tasks, checks, and recent events.
  events           Show SQLite-backed runtime events for one change.
  claim            Atomically claim a task in the current checkout.
  start            Mark a Change or task as started.
  block            Mark a Change or task as blocked.
  review           Mark a Change or task as ready for review.
  mark-ready       Mark a Change or task as ready.
  close            Close a Change or task.
  check            Run declared checks and record pass/fail events.
  record           Record a raw lifecycle event in generated runtime state.

Definition authoring and history:
  opencanon canon draft change <id> --title <title> --problem <text> --outcome <text>
  opencanon canon render changes
  opencanon canon history change <id>
  opencanon canon diff change <id> [--from <ref>] [--to <ref>]
  opencanon canon related-commits change <id>
  opencanon canon versions change <id>

Options:
  --format markdown|json  Output format. Default: markdown.
  --agent <id>            Agent id for task ownership events.
  --dry-run               Show generated docs that would change without writing files.

Event types:
  ${Object.values(ChangeEventType).join(", ")}
`);
}
