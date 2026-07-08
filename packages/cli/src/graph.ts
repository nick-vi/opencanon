import { fail, Format, resolveRootDir, type CodeGraphEdge } from "@opencanon/core";
import { RuntimeApiRoute, withRuntimeClient } from "./runtime-client.ts";

// Single source of truth for graph commands; reference members instead of inlining the strings.
const GraphCommand = { Callers: "callers", Callees: "callees", Impact: "impact" } as const;
type GraphCommand = (typeof GraphCommand)[keyof typeof GraphCommand];

type GraphQuery = {
  command: GraphCommand;
  query: string;
  limit: number;
  format: Format;
  help: boolean;
};

type CodeGraphResponse = {
  sourceFiles: number;
  edges: CodeGraphEdge[];
};

export async function runGraphCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const params = new URLSearchParams({
    query: query.query,
    kind: "call",
    direction: directionForCommand(query.command),
    limit: String(query.limit),
  });
  const result = await withRuntimeClient<CodeGraphResponse>(rootDir, (client) => client.get(`${RuntimeApiRoute.CodeGraph}?${params.toString()}`));
  if (query.format === Format.Json) console.log(JSON.stringify({ sourceFiles: result.sourceFiles, command: query.command, query: query.query, edges: result.edges }, null, 2));
  else printEdges(query.command, result.edges, result.sourceFiles, query.query);
}

function parseArgs(args: string[]): GraphQuery {
  let help = false;
  let limit = 50;
  let format: Format = "markdown";
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 1000) fail(`Invalid --limit: ${args[index + 1]}`);
      limit = value;
      index += 1;
      continue;
    }
    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== Format.Markdown && value !== Format.Json) fail(`Invalid --format: ${value}`);
      format = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown graph option: ${arg}`);
    positional.push(arg);
  }
  if (help && positional.length === 0) return { command: GraphCommand.Impact, query: "", limit, format, help };
  const command = positional[0] as GraphCommand | undefined;
  if (!command || !["callers", "callees", "impact"].includes(command)) fail(`Expected graph command: callers, callees, or impact.`);
  const query = positional[1];
  if (!query) fail(`Expected symbol name for graph ${command}.`);
  if (positional.length > 2) fail(`Unexpected graph arguments: ${positional.slice(2).join(", ")}`);
  return { command, query, limit, format, help };
}

function directionForCommand(command: GraphCommand): "incoming" | "outgoing" | "both" {
  if (command === GraphCommand.Callers) return "incoming";
  if (command === GraphCommand.Callees) return "outgoing";
  return "both";
}

function printEdges(command: GraphCommand, edges: CodeGraphEdge[], sourceCount: number, query: string): void {
  if (edges.length === 0) {
    console.log(`# No ${command} match ${query} across ${sourceCount} source files.`);
    return;
  }
  for (const edge of edges) {
    if (command === GraphCommand.Callers) {
      console.log(`${edge.source.kind} ${edge.source.name} -> ${edge.target.name} ${edge.path}:${edge.range.start.line}:${edge.range.start.column}`);
    } else if (command === GraphCommand.Callees) {
      console.log(`${edge.source.name} -> ${edge.target.kind} ${edge.target.name} ${edge.path}:${edge.range.start.line}:${edge.range.start.column}`);
    } else {
      console.log(`${edge.source.name} -> ${edge.target.name} ${edge.path}:${edge.range.start.line}:${edge.range.start.column}`);
    }
  }
}

function printHelp(): void {
  console.log(`Usage:
  opencanon graph callers <symbol>
  opencanon graph callees <symbol>
  opencanon graph impact <symbol>

Options:
  --limit <n>      Maximum results to return (default 50, max 1000).
  --format <fmt>   markdown or json. Default: markdown.
`);
}
