import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cac } from "cac";
import {
  ChangeCheckKind,
  ChangeCheckEventType,
  ChangeRenderKind,
  ChangeKind,
  ChangeLifecycleEventType,
  ChangeRenderStyle,
  ChangeTaskEventType,
  DefinitionTargetKind,
  buildDefinitionDiffGitArgs,
  buildDefinitionHistoryGitArgs,
  buildDefinitionVersionsGitArgs,
  buildRelatedDefinitionCommitsGitArgs,
  dedupeCommits,
  fail,
  Format,
  loadChangeHistoryTarget,
  parseConventionGitLog,
  relative,
  renderChange,
  resolveChangeGeneratedDocsPath,
  runGit,
  type ChangeHistoryTarget,
  type ConventionHistoryCommit,
  type DefinitionTarget,
  writeAtomicTextFileSync,
} from "@opencanon/core";
import { LocalTransportKind } from "@opencanon/runtime";
import { booleanOption, formatOption, positiveIntegerOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";
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

const CheckRunStatus = {
  Passed: "passed",
  Failed: "failed",
} as const;
type CheckRunStatus = (typeof CheckRunStatus)[keyof typeof CheckRunStatus];

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

type RunChangeCheckResultPayload = {
    changeId: string;
    taskId?: string;
    checkId: string;
    kind: string;
    status: CheckRunStatus;
    summary: string;
    output: string;
    exitCode?: number | string;
};

type RunChangeCheckResponse = {
  result: RunChangeCheckResultPayload;
  event: ChangeEvent;
  events: ChangeEvent[];
  results: RunChangeCheckResultPayload[];
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

type RenderAction = "unchanged" | "written" | "would-write";

type RenderedChangeFile = {
  id: string;
  path: string;
  style: string;
  action: RenderAction;
};

type RenderChangesResult = {
  dryRun: boolean;
  generated: number;
  changed: number;
  files: RenderedChangeFile[];
};

type ChangeLogResult = {
  command: "history" | "related-commits" | "versions";
  target: ChangeHistoryTarget;
  commits: ConventionHistoryCommit[];
};

type ChangeDiffResult = {
  command: "diff";
  target: ChangeHistoryTarget;
  from: string;
  to: string;
  diff: string;
};

type ChangeDraftResult = {
  id: string;
  source: string;
  nextCommands: string[];
};

type ChangesCommandOptions = {
  allowDefinitionCommands?: boolean;
  listCommandName?: string;
};

function withChangesRuntimeClient<T>(cwd: string, fn: (client: RuntimeClient) => Promise<T>): Promise<T> {
  return withRuntimeClient(cwd, fn, { localTransport: LocalTransportKind.Http });
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
  if (!options.allowDefinitionCommands && ["render", "draft", "history", "diff", "related-commits", "versions"].includes(command)) {
    fail(`Unknown changes command: ${command}. Use ${changesDefinitionCommandSuggestion(command)} instead.`);
  }
  if (command === "render") {
    await runChangesRenderCommand(rest, cwd);
    return;
  }
  if (command === "draft") {
    runChangesDraftCommand(rest);
    return;
  }
  if (command === "history") {
    await runChangesHistoryCommand(rest, cwd);
    return;
  }
  if (command === "diff") {
    await runChangesDiffCommand(rest, cwd);
    return;
  }
  if (command === "related-commits") {
    await runChangesRelatedCommitsCommand(rest, cwd);
    return;
  }
  if (command === "versions") {
    await runChangesVersionsCommand(rest, cwd);
    return;
  }
  if (command === "record") {
    await runChangesRecordCommand(rest, cwd);
    return;
  }
  fail(`Unknown changes command: ${command}`);
}

function changesDefinitionCommandSuggestion(command: string): string {
  if (command === "render") return "opencanon canon render changes";
  if (command === "draft") return "opencanon canon draft change <id>";
  return `opencanon canon ${command} change <id>`;
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

async function runChangesRenderCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon render changes");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--dry-run", "Show generated docs that would change without writing files.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "dryRun"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon render changes arguments: ${parsed.args.join(", ")}`);

  const result = await renderGeneratedChanges(cwd, { dryRun: booleanOption(options.dryRun) });
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangesMarkdown(result));
}

function runChangesDraftCommand(args: string[]): void {
  const cli = cac("opencanon canon draft change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--title <title>", "Change title.");
  cli.option("--kind <kind>", "Change kind: feature, fix, refactor, docs, chore, research. Default: feature.");
  cli.option("--summary <summary>", "Change summary.");
  cli.option("--problem <text>", "Problem statement.");
  cli.option("--outcome <text>", "Expected outcome.");
  cli.option("--why <text>", "Optional rationale.");
  cli.option("--file <glob>", "Scoped file or glob. Repeatable.");
  cli.option("--doc <path>", "Scoped doc path. Repeatable.");
  cli.option("--area <id>", "Area updated by this change. Repeatable.");
  cli.option("--spec <id>", "Spec updated by this change. Repeatable.");
  cli.option("--convention <id>", "Convention updated by this change. Repeatable.");
  cli.option("--surface <id>", "Impact surface updated by this change. Repeatable.");
  cli.option("--updates-doc <path>", "Documentation updated by this change. Repeatable.");
  cli.option("--check-command <id=command>", "Command check. Repeatable.");
  cli.option("--render <kind>", "Render kind: generated or none. Default: generated when --docs is set, otherwise none.");
  cli.option("--docs <path>", "Generated docs path.");
  cli.option("--style <style>", "Generated docs render style. Default: reference.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    "help",
    "h",
    "format",
    "title",
    "kind",
    "summary",
    "problem",
    "outcome",
    "why",
    "file",
    "doc",
    "area",
    "spec",
    "convention",
    "surface",
    "updatesDoc",
    "checkCommand",
    "render",
    "docs",
    "style",
  ]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon draft change");
  const title = stringOption(options.title, "--title");
  const problem = stringOption(options.problem, "--problem");
  const outcome = stringOption(options.outcome, "--outcome");
  const docs = stringOptionOptional(options.docs, "--docs");
  const renderKind = renderKindOption(options.render, docs);
  const style = changeRenderStyleOption(options.style);
  const updates = compactObject({
    areas: nonEmpty(stringValues(options.area)),
    specs: nonEmpty(stringValues(options.spec)),
    conventions: nonEmpty(stringValues(options.convention)),
    surfaces: nonEmpty(stringValues(options.surface)),
    docs: nonEmpty(stringValues(options.updatesDoc)),
  });
  const scope = [
    ...stringValues(options.file).map((file) => ({ kind: DefinitionTargetKind.File, path: file })),
    ...stringValues(options.doc).map((doc) => ({ kind: DefinitionTargetKind.Doc, path: doc })),
  ];
  const checks = stringValues(options.checkCommand).map(parseCommandCheck);
  const intent = compactObject({
    problem,
    outcome,
    why: stringOptionOptional(options.why, "--why"),
  });
  const definition: Record<string, unknown> = {
    id,
    title,
    kind: changeKindOption(options.kind),
    intent,
  };
  const summary = stringOptionOptional(options.summary, "--summary");
  if (summary) definition.summary = summary;
  if (Object.keys(updates).length > 0) definition.updates = updates;
  if (scope.length > 0) definition.scope = scope;
  if (checks.length > 0) definition.checks = checks;
  definition.render = renderDefinition(renderKind, docs, style);

  const source = `import { defineChange } from "@opencanon/core";

export default defineChange(${JSON.stringify(definition, null, 2)});
`;
  const result: ChangeDraftResult = {
    id,
    source,
    nextCommands: ["opencanon canon render changes", "opencanon doctor"],
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangeDraftMarkdown(result));
}

async function runChangesHistoryCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon history change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon history change");
  const target = await resolveChangeHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionHistoryGitArgs(target.files));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ChangeLogResult = {
    command: "history",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printChangeLogResult(result, formatOption(options.format));
}

async function runChangesDiffCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon diff change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--from <ref>", "Start ref. Default: <to>^.");
  cli.option("--to <ref>", "End ref. Default: HEAD.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "from", "to"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon diff change");
  const to = stringOptionOptional(options.to, "--to") ?? "HEAD";
  const from = stringOptionOptional(options.from, "--from") ?? `${to}^`;
  const target = await resolveChangeHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionDiffGitArgs({ from, to, files: target.files }));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ChangeDiffResult = {
    command: "diff",
    target,
    from,
    to,
    diff: git.stdout,
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangeDiffMarkdown(result));
}

async function runChangesRelatedCommitsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon related-commits change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon related-commits change");
  const target = await resolveChangeHistoryTarget(cwd, id);
  const argsBySource = buildRelatedDefinitionCommitsGitArgs({ id: target.id, files: target.files });
  const pathLog = runGit(cwd, argsBySource.path);
  if (pathLog.diagnostics.length > 0) fail(pathLog.diagnostics.join("\n"));
  const grepLog = runGit(cwd, argsBySource.grep);
  if (grepLog.diagnostics.length > 0) fail(grepLog.diagnostics.join("\n"));
  const result: ChangeLogResult = {
    command: "related-commits",
    target,
    commits: dedupeCommits([...parseConventionGitLog(pathLog.stdout), ...parseConventionGitLog(grepLog.stdout)]),
  };
  printChangeLogResult(result, formatOption(options.format));
}

async function runChangesVersionsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon versions change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon versions change");
  const target = await resolveChangeHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionVersionsGitArgs(target.definitionFiles));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ChangeLogResult = {
    command: "versions",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printChangeLogResult(result, formatOption(options.format));
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
  const result = await withChangesRuntimeClient(
    cwd,
    (client) =>
      client.post<RunChangeCheckResponse>(RuntimeApiRoute.ChangeChecksRun, {
        changeId: values[0],
        checkId: values[1],
        taskId: optionalStringOption(options.task, "--task"),
        all,
        actor: optionalStringOption(options.actor, "--actor"),
      }),
  );
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderRunChangeCheckMarkdown(result));
  process.exit(result.results.some((item) => item.status === CheckRunStatus.Failed) ? 1 : 0);
}

async function renderGeneratedChanges(cwd: string, options: { dryRun: boolean }): Promise<RenderChangesResult> {
  const project = await loadProjectContext(cwd);
  const files: RenderedChangeFile[] = [];

  for (const change of project.changes) {
    if (change.render.kind !== ChangeRenderKind.Generated) continue;
    const resolved = resolveChangeGeneratedDocsPath(project.paths, change);
    if (!resolved.ok) fail(resolved.diagnostics.join("\n"));

    const expected = renderChange(change, change.render.style);
    const current = existsSync(resolved.absolutePath) ? readFileSync(resolved.absolutePath, "utf8") : undefined;
    const changed = current !== expected;
    if (changed && !options.dryRun) writeAtomicTextFileSync(resolved.absolutePath, expected);

    files.push({
      id: change.id,
      path: relative(project.rootDir, resolved.absolutePath),
      style: change.render.style,
      action: changed ? (options.dryRun ? "would-write" : "written") : "unchanged",
    });
  }

  return {
    dryRun: options.dryRun,
    generated: files.length,
    changed: files.filter((file) => file.action !== "unchanged").length,
    files,
  };
}

function renderChangesMarkdown(result: RenderChangesResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Changes Render");
  lines.push("");
  lines.push(`Generated changes: ${result.generated}`);
  lines.push(`Changed files: ${result.changed}${result.dryRun ? " (dry-run)" : ""}`);
  for (const file of result.files) lines.push(`- [${file.action}] ${file.id} (${file.style}) -> ${file.path}`);
  return lines.join("\n");
}

async function resolveChangeHistoryTarget(cwd: string, id: string): Promise<ChangeHistoryTarget> {
  const result = await loadChangeHistoryTarget(cwd, id);
  if (!result.ok) fail(result.diagnostics.join("\n"));
  return result.target;
}

function printChangeLogResult(result: ChangeLogResult, format: Format): void {
  if (format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangeLogMarkdown(result));
}

function renderChangeLogMarkdown(result: ChangeLogResult): string {
  const lines: string[] = [];
  lines.push(`# ${changeLogTitle(result.command)}`);
  lines.push("");
  lines.push(`Change: ${result.target.id}`);
  lines.push(`Title: ${result.target.title}`);
  lines.push("");
  lines.push("Files:");
  for (const file of result.target.files) lines.push(`- ${file}`);
  lines.push("");
  lines.push("Commits:");
  if (result.commits.length === 0) lines.push("- <none>");
  for (const commit of result.commits) lines.push(`- ${commit.hash} ${commit.date} ${commit.author} - ${commit.subject}`);
  return lines.join("\n");
}

function renderChangeDiffMarkdown(result: ChangeDiffResult): string {
  return [
    "# Change Diff",
    "",
    `Change: ${result.target.id}`,
    `Title: ${result.target.title}`,
    `Refs: ${result.from}..${result.to}`,
    "",
    "Files:",
    ...result.target.files.map((file) => `- ${file}`),
    "",
    result.diff.trimEnd() || "No changes.",
  ].join("\n");
}

function renderChangeDraftMarkdown(result: ChangeDraftResult): string {
  return [
    "# OpenCanon Change Draft",
    "",
    `Change: ${result.id}`,
    "",
    "```ts",
    result.source.trimEnd(),
    "```",
    "",
    "Next:",
    ...result.nextCommands.map((command) => `- ${command}`),
  ].join("\n");
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

function changeLogTitle(command: ChangeLogResult["command"]): string {
  switch (command) {
    case "history":
      return "Change History";
    case "related-commits":
      return "Change Related Commits";
    case "versions":
      return "Change Versions";
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

function renderRunChangeCheckMarkdown(response: RunChangeCheckResponse): string {
  const lines = [
    "# OpenCanon Change Check",
    "",
    `Change: ${response.result.changeId}`,
  ];
  for (const result of response.results ?? [response.result]) {
    lines.push("", `Check: ${result.checkId}`, ...(result.taskId ? [`Task: ${result.taskId}`] : []), `Kind: ${result.kind}`, `Status: ${result.status}`, `Summary: ${result.summary}`);
    if (result.exitCode !== undefined) lines.push(`Exit code: ${String(result.exitCode)}`);
    if (result.output) {
      lines.push("", "Output:", "```", result.output, "```");
    }
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

function stringOptionOptional(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  return stringOption(value, flag);
}

function optionalStringOption(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") fail(`${flag} requires a value.`);
  return value.trim();
}

function renderKindOption(value: unknown, docs: string | undefined): ChangeRenderKind {
  const kind = value === undefined ? (docs ? ChangeRenderKind.Generated : ChangeRenderKind.None) : stringOptionOptional(value, "--render");
  if (kind === ChangeRenderKind.Generated || kind === ChangeRenderKind.None) return kind;
  fail(`Unsupported --render: ${String(kind)}`);
}

function changeRenderStyleOption(value: unknown): ChangeRenderStyle {
  const style = stringOptionOptional(value, "--style") ?? ChangeRenderStyle.Reference;
  if (Object.values(ChangeRenderStyle).includes(style as ChangeRenderStyle)) return style as ChangeRenderStyle;
  fail(`Unsupported --style: ${style}`);
}

function changeKindOption(value: unknown): ChangeKind {
  const kind = stringOptionOptional(value, "--kind") ?? ChangeKind.Feature;
  if (Object.values(ChangeKind).includes(kind as ChangeKind)) return kind as ChangeKind;
  fail(`Unsupported --kind: ${kind}`);
}

function renderDefinition(kind: ChangeRenderKind, docs: string | undefined, style: ChangeRenderStyle): Record<string, unknown> {
  if (kind === ChangeRenderKind.None) return { kind };
  if (!docs) fail("--docs is required when --render is generated.");
  assertGeneratedDocsPath(docs, "--docs");
  return { kind, docs, style };
}

function assertGeneratedDocsPath(docs: string, flag: string): void {
  if (docs.includes("#")) fail(`${flag} must be a generated Markdown file path, not a heading reference.`);
  if (!/\.md$/iu.test(docs)) fail(`${flag} must point at a Markdown file.`);
}

function parseCommandCheck(value: string): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) fail("--check-command must use id=command.");
  return { id: value.slice(0, separator), kind: ChangeCheckKind.Command, command: value.slice(separator + 1) };
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
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

function printChangesDefinitionHelp(): void {
  console.log(`Usage:
  opencanon canon draft change <id> --title <title> --problem <text> --outcome <text>
  opencanon canon render changes
  opencanon canon history change <id>
  opencanon canon diff change <id> [--from <ref>] [--to <ref>]
  opencanon canon related-commits change <id>
  opencanon canon versions change <id>

Commands:
  draft            Print a TypeScript defineChange snippet.
  render           Render every generated change document.
  history          Show commits that touched a change definition or doc.
  diff             Show change definition/doc changes between refs.
  related-commits  Show path and commit-message references to a change id.
  versions         List commits where the change definition changed.

Options:
  --format markdown|json  Output format. Default: markdown.
  --dry-run               Show generated docs that would change without writing files.
`);
}
