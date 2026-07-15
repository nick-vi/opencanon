import { createInterface } from "node:readline";
import { createPaths, loadProjectContext, resolveRootDir, type SemanticIndexSnapshot } from "@opencanon/core";
import { assertRuntimePrerequisites } from "./runtime.ts";
import { createKnowledgeIndexManager, type KnowledgeIndexProgress } from "./knowledge-index-manager.ts";
import { createProjectStore } from "./state.ts";
import { ProjectRuntimeEnv } from "./service-types.ts";
import { semanticSearchVectorForProvider } from "./semantic-index.ts";

export const KnowledgeIndexWorkerMessageType = {
  Progress: "progress",
  Ready: "ready",
  QueryReady: "query-ready",
  QueryFailed: "query-failed",
} as const;

export type KnowledgeIndexWorkerMessage =
  | { type: typeof KnowledgeIndexWorkerMessageType.Progress; progress: KnowledgeIndexProgress }
  | { type: typeof KnowledgeIndexWorkerMessageType.Ready; index: SemanticIndexSnapshot; files: string[] }
  | { type: typeof KnowledgeIndexWorkerMessageType.QueryReady; id: string; vector: number[] }
  | { type: typeof KnowledgeIndexWorkerMessageType.QueryFailed; id: string; message: string };

export async function runKnowledgeIndexWorkerCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const parsed = parseWorkerArgs(args);
  const rootDir = resolveRootDir(parsed.rootDir ?? cwd);
  const paths = createPaths(rootDir);
  const runtime = assertRuntimePrerequisites();
  const store = createProjectStore({
    rootDir,
    paths,
    engine: runtime.engine,
    statePath: process.env[ProjectRuntimeEnv.StatePath],
  });
  try {
    if (parsed.queryServer) {
      await runQueryServer(rootDir, store);
      return;
    }
    const manager = createKnowledgeIndexManager({ rootDir, store });
    const result = await manager.index({
      force: parsed.force,
      changedPaths: parsed.changedPaths,
      onProgress(progress) {
        writeWorkerMessage({ type: KnowledgeIndexWorkerMessageType.Progress, progress });
      },
    });
    writeWorkerMessage({ type: KnowledgeIndexWorkerMessageType.Ready, index: result.index, files: result.scan.files.map((file) => file.path) });
  } finally {
    store.close();
  }
}

function parseWorkerArgs(args: string[]): { rootDir?: string; force: boolean; changedPaths: string[]; queryServer: boolean } {
  let rootDir: string | undefined;
  let force = false;
  let queryServer = false;
  const changedPaths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--root") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("Project Knowledge worker requires a path after --root.");
      rootDir = value;
      index += 1;
      continue;
    }
    if (arg === "--changed-path") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("Project Knowledge worker requires a path after --changed-path.");
      changedPaths.push(value);
      index += 1;
      continue;
    }
    if (arg === "--query-server") {
      queryServer = true;
      continue;
    }
    throw new Error(`Unknown Project Knowledge worker option: ${String(arg)}.`);
  }
  if (queryServer && (force || changedPaths.length > 0)) {
    throw new Error("Project Knowledge worker query mode cannot be combined with index options.");
  }
  return { rootDir, force, changedPaths, queryServer };
}

async function runQueryServer(rootDir: string, store: ReturnType<typeof createProjectStore>): Promise<void> {
  const project = await loadProjectContext(rootDir);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let request: { id: string; query: string };
    try {
      const value = JSON.parse(line) as { id?: unknown; query?: unknown };
      if (typeof value.id !== "string" || !value.id || typeof value.query !== "string" || !value.query.trim()) {
        throw new Error("Knowledge query request requires non-empty id and query strings.");
      }
      request = { id: value.id, query: value.query };
    } catch (error) {
      writeWorkerMessage({
        type: KnowledgeIndexWorkerMessageType.QueryFailed,
        id: "invalid-request",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      const index = store.readSemanticIndexStatus({ indexId: "project" }).index;
      const vector = semanticSearchVectorForProvider({
        query: request.query,
        provider: index?.provider,
        project: store.project,
        semanticEmbedding: project.paths.semanticEmbedding,
      });
      writeWorkerMessage({ type: KnowledgeIndexWorkerMessageType.QueryReady, id: request.id, vector });
    } catch (error) {
      writeWorkerMessage({
        type: KnowledgeIndexWorkerMessageType.QueryFailed,
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function writeWorkerMessage(message: KnowledgeIndexWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
