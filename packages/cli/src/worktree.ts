import { cac } from "cac";
import {
  Format,
  TaskLeaseStatus,
  fail,
  loadProjectContext,
  type WorktreeOverview,
} from "@opencanon/core";
import {
  createManagedWorktree,
  listWorktreeOverview,
  reapWorktrees,
  removeManagedWorktree,
  type CreateManagedWorktreeResult,
  type ReapWorktreesResult,
  type RemoveManagedWorktreeResult,
} from "@opencanon/runtime";
import { booleanOption, formatOption, rejectUnknownOptions } from "./options.ts";

export async function runWorktreeCommand(args: string[], cwd: string): Promise<void> {
  const [command = "list", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    printWorktreeHelp();
    return;
  }
  if (command === "list" || command === "status") {
    runWorktreeListCommand(rest, cwd);
    return;
  }
  if (command === "create") {
    await runWorktreeCreateCommand(rest, cwd);
    return;
  }
  if (command === "remove") {
    runWorktreeRemoveCommand(rest, cwd);
    return;
  }
  if (command === "reap") {
    runWorktreeReapCommand(rest, cwd);
    return;
  }
  fail(`Unknown worktree command: ${command}`);
}

function runWorktreeListCommand(args: string[], cwd: string): void {
  const cli = cac("opencanon worktree list");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printWorktreeHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected worktree list arguments: ${parsed.args.join(", ")}`);
  const overview = listWorktreeOverview(cwd);
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(overview, null, 2));
  else console.log(renderWorktreeOverviewMarkdown(overview));
}

async function runWorktreeCreateCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon worktree create");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--task <id>", "Task id to claim.");
  cli.option("--agent <id>", "Agent id recorded on the task lease.");
  cli.option("--path <path>", "Worktree path. Defaults to a managed path under ~/.opencanon/worktrees.");
  cli.option("--base <ref>", "Base ref for the worktree. Defaults to HEAD.");
  cli.option("--branch <name>", "Create and check out a branch instead of detached HEAD.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "task", "agent", "path", "base", "branch"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printWorktreeHelp();
    return;
  }
  const changeId = requiredSingleArgument(parsed.args, "worktree create");
  const taskId = optionalString(options.task, "--task");
  if (!taskId) fail("opencanon worktree create requires --task.");
  const project = await loadProjectContext(cwd);
  const change = project.changes.find((item) => item.id === changeId);
  if (!change) fail(`Unknown change id: ${changeId}.`);
  if (!change.tasks?.some((task) => task.id === taskId)) fail(`Unknown task id for ${changeId}: ${taskId}.`);

  const result = createManagedWorktree({
    rootDir: cwd,
    changeId,
    taskId,
    agentId: optionalString(options.agent, "--agent"),
    requestedPath: optionalString(options.path, "--path"),
    baseRef: optionalString(options.base, "--base"),
    branch: optionalString(options.branch, "--branch"),
  });
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderCreateManagedWorktreeMarkdown(result));
}

function runWorktreeRemoveCommand(args: string[], cwd: string): void {
  const cli = cac("opencanon worktree remove");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--force", "Remove even if the worktree has uncommitted changes.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "force"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printWorktreeHelp();
    return;
  }
  const idOrPath = requiredSingleArgument(parsed.args, "worktree remove");
  const result = removeManagedWorktree(cwd, idOrPath, { force: booleanOption(options.force) });
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderRemoveManagedWorktreeMarkdown(result));
}

function runWorktreeReapCommand(args: string[], cwd: string): void {
  const cli = cac("opencanon worktree reap");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printWorktreeHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected worktree reap arguments: ${parsed.args.join(", ")}`);
  const result = reapWorktrees(cwd);
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderReapWorktreesMarkdown(result));
}

function renderWorktreeOverviewMarkdown(overview: WorktreeOverview): string {
  const lines = [
    "# OpenCanon Worktrees",
    "",
    `Repository: ${overview.repository.repoKey}`,
    `Kind: ${overview.repository.vcs}`,
    "",
    "Active Leases:",
  ];
  const activeLeases = overview.leases.filter((lease) => lease.status === TaskLeaseStatus.Active);
  if (activeLeases.length === 0) lines.push("- <none>");
  for (const lease of activeLeases) lines.push(`- ${lease.changeId}/${lease.taskId} -> ${lease.agentId} at ${lease.worktreePath} (expires ${lease.expiresAt})`);
  lines.push("", "Worktrees:");
  if (overview.worktrees.length === 0) lines.push("- <none>");
  for (const worktree of overview.worktrees) lines.push(`- ${worktree.id} ${worktree.status} ${worktree.changeId}/${worktree.taskId} ${worktree.path}`);
  return lines.join("\n");
}

function renderCreateManagedWorktreeMarkdown(result: CreateManagedWorktreeResult): string {
  return [
    "# OpenCanon Worktree Created",
    "",
    `Worktree: ${result.worktree.path}`,
    `Task: ${result.worktree.changeId}/${result.worktree.taskId}`,
    `Agent: ${result.worktree.agentId}`,
    `Lease: ${result.lease.id}`,
    "",
    "Next:",
    ...result.commands.map((command) => `- ${command}`),
  ].join("\n");
}

function renderRemoveManagedWorktreeMarkdown(result: RemoveManagedWorktreeResult): string {
  return [
    "# OpenCanon Worktree Removed",
    "",
    `Worktree: ${result.worktree.path}`,
    `Status: ${result.worktree.status}`,
    `Released leases: ${result.releasedLeaseIds.length}`,
  ].join("\n");
}

function renderReapWorktreesMarkdown(result: ReapWorktreesResult): string {
  return [
    "# OpenCanon Worktree Reap",
    "",
    `Repository: ${result.repository.repoKey}`,
    `Stale leases: ${result.staleLeases.length}`,
    `Stale worktrees: ${result.staleWorktrees.length}`,
  ].join("\n");
}

function requiredSingleArgument(args: readonly unknown[], commandName: string): string {
  if (args.length !== 1 || typeof args[0] !== "string" || !args[0].trim()) fail(`opencanon ${commandName} requires exactly one argument.`);
  return args[0].trim();
}

function optionalString(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) fail(`${flag} requires a value.`);
  return value.trim();
}

function printWorktreeHelp(): void {
  console.log(`OpenCanon worktree commands

Usage:
  opencanon worktree create <change-id> --task <task-id>
  opencanon worktree list
  opencanon worktree status
  opencanon worktree remove <worktree-id|path>
  opencanon worktree reap

Commands:
  create  Create a managed Git worktree and atomically claim a Change task.
  list    Show managed worktrees and active task leases for this repository.
  status  Alias for list.
  remove  Remove a managed worktree and release its task leases.
  reap    Mark expired leases and missing worktrees stale.
`);
}
