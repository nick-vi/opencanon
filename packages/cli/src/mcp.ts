import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RelatedCanon, RuntimeSnapshot } from "@opencanon/runtime";
import type {
  DoctorReport,
  ListSemanticChunksResult,
  ProjectContextAskResult,
  ProjectContextBacklinksResult,
  ProjectContextCoverageResult,
  ProjectContextSearchResult,
  ValidationResult,
} from "@opencanon/core";
import { fail, resolveRootDir } from "@opencanon/core";
import { z } from "zod";
import { RuntimeApiRoute, withRuntimeClient } from "./runtime-client.ts";

const McpTool = {
  ContextAsk: "opencanon_context_ask",
  ContextBacklinks: "opencanon_context_backlinks",
  ContextChunks: "opencanon_context_chunks",
  ContextCoverage: "opencanon_context_coverage",
  ContextSearch: "opencanon_context_search",
  Doctor: "opencanon_doctor",
  Brief: "opencanon_brief",
  ReadyWork: "opencanon_ready_work",
  RelatedContext: "opencanon_related_context",
  Status: "opencanon_status",
  Validate: "opencanon_validate",
} as const;

const McpPermissionModel =
  "Permission model: this MCP server is read-first. Tools expose status, context, search, doctor, and dry-run proof. It has no setup, gate approval, or write tools.";

type McpQuery = {
  rootDir: string;
  help: boolean;
};

export async function runMcpCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args, cwd);
  if (query.help) {
    printHelp();
    return;
  }

  const server = new McpServer({
    name: "opencanon",
    version: "0.4.0",
  });

  server.registerTool(
    McpTool.Status,
    {
      title: "OpenCanon Status",
      description: `Read-only. Return the current project snapshot summary, runtime health, and Project Context index status. ${McpPermissionModel}`,
      inputSchema: {
        includeSnapshot: z.boolean().optional().describe("Include the full runtime snapshot. Defaults to false."),
      },
    },
    async ({ includeSnapshot }) => {
      const snapshot = await withRuntimeClient<RuntimeSnapshot>(query.rootDir, (client) => client.get(RuntimeApiRoute.Snapshot));
      const status = {
        rootDir: query.rootDir,
        health: snapshot.health,
        counts: {
          areas: snapshot.areas.length,
          specs: snapshot.specs.length,
          changes: snapshot.changes.length,
          conventions: snapshot.conventions.length,
          validators: snapshot.validators.length,
          findings: snapshot.findings.length,
          impactSurfaces: snapshot.impactSurfaces.length,
        },
        semanticIndex: snapshot.semanticIndex,
        snapshot: includeSnapshot ? snapshot : undefined,
      };
      return jsonToolResult(status);
    },
  );

  server.registerTool(
    McpTool.RelatedContext,
    {
      title: "OpenCanon Related Context",
      description: "Read-only. Return conventions, validators, docs, specs, changes, and surfaces related to files or topics.",
      inputSchema: {
        files: z.array(z.string().min(1)).optional().describe("Repository-relative files to explain."),
        topics: z.array(z.string().min(1)).optional().describe("OpenCanon topics to include."),
        conventionIds: z.array(z.string().min(1)).optional().describe("Convention ids to include."),
        validatorIds: z.array(z.string().min(1)).optional().describe("Validator ids to include."),
        findingIds: z.array(z.string().min(1)).optional().describe("Finding ids to include."),
      },
    },
    async (input) => {
      const result = await withRuntimeClient<RelatedCanon>(query.rootDir, (client) =>
        client.post(RuntimeApiRoute.CanonRelated, {
          files: input.files ?? [],
          topics: input.topics ?? [],
          conventionIds: input.conventionIds ?? [],
          validatorIds: input.validatorIds ?? [],
          findingIds: input.findingIds ?? [],
        }),
      );
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.ReadyWork,
    {
      title: "OpenCanon Ready Work",
      description: `Read-only. Return dependency-unblocked Changes and tasks that are ready for an agent to claim through the CLI. ${McpPermissionModel}`,
      inputSchema: {},
    },
    async () => {
      const result = await withRuntimeClient(query.rootDir, (client) => client.get(RuntimeApiRoute.ChangeReady));
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.Brief,
    {
      title: "OpenCanon Agent Brief",
      description: `Read-only. Return ready work plus an XML Project Canon context packet for agent session startup. ${McpPermissionModel}`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum definitions/events in the context packet. Defaults to 25."),
      },
    },
    async ({ limit }) => {
      const result = await withRuntimeClient(query.rootDir, async (client) => {
        const [queue, packet] = await Promise.all([
          client.get(RuntimeApiRoute.ChangeReady),
          client.get(`${RuntimeApiRoute.ContextPacket}?mode=agent-brief&limit=${limit ?? 25}`),
        ]);
        return { queue, packet };
      });
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.Validate,
    {
      title: "OpenCanon Validate",
      description: "Dry-run proof only. Run project convention validators through the same runtime validation route used by the CLI without applying fixes or approving gates.",
      inputSchema: {
        files: z.array(z.string().min(1)).optional().describe("Repository-relative files to validate."),
        topics: z.array(z.string().min(1)).optional().describe("Restrict validation to topics."),
        validatorIds: z.array(z.string().min(1)).optional().describe("Restrict validation to validator ids."),
        project: z.boolean().optional().describe("Validate the project instead of only listed files."),
        strictProducers: z.boolean().optional().describe("Fail when a required producer is not ready."),
      },
    },
    async (input) => {
      const files = input.files ?? [];
      const project = input.project ?? files.length === 0;
      const result = await withRuntimeClient<ValidationResult>(query.rootDir, (client) =>
        client.post(RuntimeApiRoute.Validate, {
          files,
          topics: input.topics ?? [],
          validatorIds: input.validatorIds ?? [],
          project,
          dryRun: true,
          strictProducers: input.strictProducers ?? false,
        }),
      );
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.ContextSearch,
    {
      title: "OpenCanon Project Context Search",
      description: "Read-only. Search ready Project Context and return grounded evidence, backlinks, freshness, and citations. If the index is stale, run `opencanon project index` outside MCP first.",
      inputSchema: {
        query: z.string().min(1).describe("Search text."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum results. Defaults to 20."),
        paths: z.array(z.string().min(1)).optional().describe("Optional exact repository-relative path filters."),
      },
    },
    async (input) => {
      const params = new URLSearchParams();
      params.set("query", input.query);
      params.set("limit", String(input.limit ?? 20));
      for (const item of input.paths ?? []) params.append("path", item);
      const result = await withRuntimeClient<ProjectContextSearchResult>(query.rootDir, (client) => client.get(`${RuntimeApiRoute.ContextSearch}?${params.toString()}`));
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.ContextAsk,
    {
      title: "OpenCanon Project Context Ask",
      description: "Read-only. Ask a grounded project question against a ready Project Context index. Answers are deterministic navigation evidence, not enforcement. If the index is stale, run `opencanon project index` outside MCP first.",
      inputSchema: {
        question: z.string().min(1).describe("Project question."),
      },
    },
    async (input) => {
      const params = new URLSearchParams();
      params.set("query", input.question);
      const result = await withRuntimeClient<ProjectContextAskResult>(query.rootDir, (client) => client.get(`${RuntimeApiRoute.ContextAsk}?${params.toString()}`));
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.ContextChunks,
    {
      title: "OpenCanon Project Context Chunks",
      description: "Read-only. List chunks from a ready Project Context index by optional file path or definition id. If the index is stale, run `opencanon project index` outside MCP first.",
      inputSchema: {
        paths: z.array(z.string().min(1)).optional().describe("Optional repository-relative paths."),
        definitions: z.array(z.string().min(1)).optional().describe("Optional definition ids whose covered files should provide chunks."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum chunks. Defaults to 100."),
        offset: z.number().int().min(0).optional().describe("Chunk offset. Defaults to 0."),
      },
    },
    async (input) => {
      const params = new URLSearchParams();
      params.set("limit", String(input.limit ?? 100));
      params.set("offset", String(input.offset ?? 0));
      for (const item of input.paths ?? []) params.append("path", item);
      for (const item of input.definitions ?? []) params.append("definition", item);
      const result = await withRuntimeClient<ListSemanticChunksResult>(query.rootDir, (client) => client.get(`${RuntimeApiRoute.ContextChunks}?${params.toString()}`));
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.ContextCoverage,
    {
      title: "OpenCanon Project Context Coverage",
      description: "Read-only. Return coverage from a ready Project Context index across indexed, governed, stale, and orphan files. If the index is stale, run `opencanon project index` outside MCP first.",
      inputSchema: {},
    },
    async () => {
      const result = await withRuntimeClient<ProjectContextCoverageResult>(query.rootDir, (client) => client.get(RuntimeApiRoute.ContextCoverage));
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.ContextBacklinks,
    {
      title: "OpenCanon Project Context Backlinks",
      description: "Read-only. Find definition and file backlinks for a definition id, file path, or text query.",
      inputSchema: {
        query: z.string().min(1).describe("Definition id, file path, or text query."),
      },
    },
    async (input) => {
      const params = new URLSearchParams();
      params.set("query", input.query);
      const result = await withRuntimeClient<ProjectContextBacklinksResult>(query.rootDir, (client) => client.get(`${RuntimeApiRoute.ContextBacklinks}?${params.toString()}`));
      return jsonToolResult(result);
    },
  );

  server.registerTool(
    McpTool.Doctor,
    {
      title: "OpenCanon Doctor",
      description: "Read-only. Run project health checks through the runtime doctor route without applying fixes.",
      inputSchema: {},
    },
    async () => {
      const result = await withRuntimeClient<DoctorReport>(query.rootDir, (client) => client.get(RuntimeApiRoute.Doctor));
      return jsonToolResult(result);
    },
  );

  await server.connect(new StdioServerTransport());
}

function parseArgs(args: string[], cwd: string): McpQuery {
  let root = cwd;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help" || arg === "help") {
      help = true;
      continue;
    }
    if (arg === "--root" || arg === "--cwd") {
      const value = args[index + 1];
      if (!value) fail(`${arg} requires a path.`);
      root = path.resolve(cwd, value);
      index += 1;
      continue;
    }
    fail(`Unknown mcp option: ${arg}`);
  }
  return { rootDir: resolveRootDir(root), help };
}

function jsonToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function printHelp(): void {
  console.log(`Usage:
  opencanon mcp
  opencanon mcp --root <project>

Options:
  --root <path>  Project root or a path inside the project. Defaults to the current directory.
  --cwd <path>   Alias for --root.

${McpPermissionModel}

Tools:
  ${McpTool.Status}           Project health, counts, and Project Context index status.
  ${McpTool.RelatedContext}  Related docs, conventions, validators, specs, changes, and surfaces.
  ${McpTool.Validate}         Runtime convention validation.
  ${McpTool.ContextSearch}  Project Context search with evidence.
  ${McpTool.ContextAsk}     Grounded Project Context question answering.
  ${McpTool.ContextChunks}  Indexed chunk listing.
  ${McpTool.ContextCoverage} Project Context coverage.
  ${McpTool.ContextBacklinks} Definition and file backlinks.
  ${McpTool.Doctor}           Project doctor checks.
`);
}
