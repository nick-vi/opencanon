import { createPaths, resolveRootDir, type SemanticIndexSnapshot } from "@opencanon/core";
import { assertRuntimePrerequisites } from "./runtime.ts";
import { createKnowledgeIndexManager, type KnowledgeIndexProgress } from "./knowledge-index-manager.ts";
import { createProjectStore } from "./state.ts";
import { ProjectRuntimeEnv } from "./service-types.ts";
import { createServiceInferenceClient } from "./service-inference-client.ts";

export const KnowledgeIndexWorkerMessageType = {
  Progress: "progress",
  Ready: "ready",
} as const;

export type KnowledgeIndexWorkerMessage =
  | { type: typeof KnowledgeIndexWorkerMessageType.Progress; progress: KnowledgeIndexProgress }
  | { type: typeof KnowledgeIndexWorkerMessageType.Ready; index: SemanticIndexSnapshot; files: string[] };

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
    const registryPath = process.env[ProjectRuntimeEnv.RegistryPath];
    if (!registryPath) throw new Error("Project Knowledge worker requires the OpenCanon service registry path.");
    const manager = createKnowledgeIndexManager({ rootDir, store, inference: createServiceInferenceClient(registryPath) });
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

function parseWorkerArgs(args: string[]): { rootDir?: string; force: boolean; changedPaths: string[] } {
  let rootDir: string | undefined;
  let force = false;
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
    throw new Error(`Unknown Project Knowledge worker option: ${String(arg)}.`);
  }
  return { rootDir, force, changedPaths };
}

function writeWorkerMessage(message: KnowledgeIndexWorkerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
