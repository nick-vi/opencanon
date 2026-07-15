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
} as const;

export type KnowledgeIndexWorkerMessage =
  | { type: typeof KnowledgeIndexWorkerMessageType.Progress; progress: KnowledgeIndexProgress }
  | { type: typeof KnowledgeIndexWorkerMessageType.Ready; index: SemanticIndexSnapshot; files: string[] }
  | { type: typeof KnowledgeIndexWorkerMessageType.QueryReady; vector: number[] };

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
    if (parsed.query !== undefined) {
      const project = await loadProjectContext(rootDir);
      const index = store.readSemanticIndexStatus({ indexId: "project" }).index;
      const vector = semanticSearchVectorForProvider({
        query: parsed.query,
        provider: index?.provider,
        project: store.project,
        semanticEmbedding: project.paths.semanticEmbedding,
      });
      writeWorkerMessage({ type: KnowledgeIndexWorkerMessageType.QueryReady, vector });
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

function parseWorkerArgs(args: string[]): { rootDir?: string; force: boolean; changedPaths: string[]; query?: string } {
  let rootDir: string | undefined;
  let force = false;
  let query: string | undefined;
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
    if (arg === "--query") {
      const value = args[index + 1]?.trim();
      if (!value) throw new Error("Project Knowledge worker requires text after --query.");
      query = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown Project Knowledge worker option: ${String(arg)}.`);
  }
  if (query !== undefined && (force || changedPaths.length > 0)) {
    throw new Error("Project Knowledge worker query mode cannot be combined with index options.");
  }
  return { rootDir, force, changedPaths, ...(query === undefined ? {} : { query }) };
}

function writeWorkerMessage(message: KnowledgeIndexWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
