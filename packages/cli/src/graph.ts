import { fail, resolveRootDir, type CodeGraphEdge, type Format } from "@opencanon/core";
import { openCodeGraph } from "./code-graph.ts";

type GraphCommand = "callers" | "callees" | "impact";

type GraphQuery = {
  command: GraphCommand;
  query: string;
  limit: number;
  format: Format;
  help: boolean;
};

export async function runGraphCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const graph = openCodeGraph(rootDir);
  try {
    const result = graph.store.project.searchGraphEdges({
      query: query.query,
      kind: "call",
      direction: directionForCommand(query.command),
      limit: query.limit,
    });
    if (query.format === "json") console.log(JSON.stringify({ sourceFiles: graph.sourceFiles.length, command: query.command, query: query.query, edges: result.edges }, null, 2));
    else printEdges(query.command, result.edges, graph.sourceFiles.length, query.query);
  } finally {
    graph.close();
  }
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
      if (value !== "markdown" && value !== "json") fail(`Invalid --format: ${value}`);
      format = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`Unknown graph option: ${arg}`);
    positional.push(arg);
  }
  const command = positional[0] as GraphCommand | undefined;
  if (!command || !["callers", "callees", "impact"].includes(command)) fail(`Expected graph command: callers, callees, or impact.`);
  const query = positional[1];
  if (!query) fail(`Expected symbol name for graph ${command}.`);
  if (positional.length > 2) fail(`Unexpected graph arguments: ${positional.slice(2).join(", ")}`);
  return { command, query, limit, format, help };
}

function directionForCommand(command: GraphCommand): "incoming" | "outgoing" | "both" {
  if (command === "callers") return "incoming";
  if (command === "callees") return "outgoing";
  return "both";
}

function printEdges(command: GraphCommand, edges: CodeGraphEdge[], sourceCount: number, query: string): void {
  if (edges.length === 0) {
    console.log(`# No ${command} match ${query} across ${sourceCount} source files.`);
    return;
  }
  for (const edge of edges) {
    if (command === "callers") {
      console.log(`${edge.source.kind} ${edge.source.name} -> ${edge.target.name} ${edge.path}:${edge.range.start.line}:${edge.range.start.column}`);
    } else if (command === "callees") {
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
