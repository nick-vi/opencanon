import { cac } from "cac";
import { fail, Format } from "@opencanon/core";
import { booleanOption, formatOption, positiveIntegerOption, rejectUnknownOptions } from "./options.ts";
import { withRuntimeClient } from "./runtime-client.ts";

type BriefPacket = {
  schema: string;
  mode: string;
  generatedAt: string;
  rootDir: string;
  xml: string;
  facts: Record<string, unknown>;
};

type BriefReadyQueue = {
  ready: Array<{
    kind: "change" | "task";
    changeId: string;
    changeTitle: string;
    taskId?: string;
    taskTitle?: string;
    checks: string[];
    files: string[];
    surfaces: string[];
    suggestedCommands: string[];
    reason: string;
  }>;
  blocked: Array<{
    kind: "change" | "task";
    changeId: string;
    changeTitle: string;
    taskId?: string;
    taskTitle?: string;
    blockedReasons: string[];
  }>;
};

type BriefNextAction = {
  title: string;
  command: string;
  reason: string;
};

const BriefWorkItemKind = {
  Change: "change",
  Task: "task",
} as const;

export async function runBriefCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon brief");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--limit <count>", "Maximum definitions/events in the context packet.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "limit"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printBriefHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected opencanon brief arguments: ${parsed.args.join(", ")}`);

  const limit = positiveIntegerOption(options.limit, "--limit", 25);
  const result = await withRuntimeClient(cwd, async (client) => {
    const [queue, packet] = await Promise.all([
      client.query<BriefReadyQueue>("changes.ready"),
      client.query<BriefPacket>("context.packet", { query: { mode: "agent-brief", limit: String(limit) } }),
    ]);
    return { queue, packet, nextActions: briefNextActions(queue) };
  });
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderBriefMarkdown(result));
}

function renderBriefMarkdown(result: { queue: BriefReadyQueue; packet: BriefPacket; nextActions: BriefNextAction[] }): string {
  const lines = ["# OpenCanon Agent Briefing", "", `Project: ${result.packet.rootDir}`, `Generated: ${result.packet.generatedAt}`, "", "Ready work:"];
  if (result.queue.ready.length === 0) lines.push("- <none>");
  for (const item of result.queue.ready) {
    lines.push(`- ${item.kind === BriefWorkItemKind.Task ? `${item.changeId}/${item.taskId}: ${item.taskTitle}` : `${item.changeId}: ${item.changeTitle}`}`);
    if (item.files.length > 0) lines.push(`  - files: ${item.files.join(", ")}`);
    if (item.surfaces.length > 0) lines.push(`  - surfaces: ${item.surfaces.join(", ")}`);
    if (item.checks.length > 0) lines.push(`  - checks: ${item.checks.join(", ")}`);
  }
  if (result.nextActions.length > 0) {
    lines.push("", "Next actions:");
    for (const action of result.nextActions) lines.push(`- ${action.title}: \`${action.command}\``);
  }
  if (result.queue.blocked.length > 0) {
    lines.push("", "Blocked:");
    for (const item of result.queue.blocked) {
      lines.push(`- ${item.kind === BriefWorkItemKind.Task ? `${item.changeId}/${item.taskId}: ${item.taskTitle}` : `${item.changeId}: ${item.changeTitle}`}`);
      for (const reason of item.blockedReasons) lines.push(`  - ${reason}`);
    }
  }
  lines.push("", "Context packet:", "```xml", result.packet.xml.trimEnd(), "```");
  return lines.join("\n");
}

function briefNextActions(queue: BriefReadyQueue): BriefNextAction[] {
  const first = queue.ready[0];
  if (!first) {
    return [
      {
        title: "Inspect project state",
        command: "opencanon status --format json",
        reason: "No ready Change work is currently available.",
      },
      {
        title: "Inspect Canon",
        command: "opencanon canon map --format json",
        reason: "Find missing or blocked Project Canon links before creating new work.",
      },
    ];
  }
  const label = first.kind === BriefWorkItemKind.Task ? `${first.changeId}/${first.taskId}` : first.changeId;
  return first.suggestedCommands.map((command, index) => ({
    title: index === 0 ? `Inspect ${label}` : `Continue ${label}`,
    command,
    reason: first.reason,
  }));
}

function printBriefHelp(): void {
  console.log(`Usage:
  opencanon brief
  opencanon brief --format json

Options:
  --format markdown|json  Output format. Default: markdown.
  --limit <count>         Maximum definitions/events in the context packet. Default: 25.
`);
}
