import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BatchProducerPolicy,
  createPaths,
  createValidationResultCache,
  resolveRootDir,
  setProjectAstFactsProviderFactory,
} from "@opencanon/core";
import { createCliAstFactsProvider, engineProjectAstFactsProvider } from "./ast-facts-provider.ts";
import { ProjectAnalysisProtocolVersion, type ProjectAnalysisResult } from "./project-analysis-protocol.ts";
import { assertRuntimePrerequisites } from "./runtime.ts";
import { ProjectRuntimeEnv } from "./service-types.ts";
import { buildRuntimeAnalysis } from "./snapshot.ts";
import { createProjectStore } from "./state.ts";

export async function runProjectAnalysisWorkerCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const input = parseWorkerArgs(args);
  const rootDir = resolveRootDir(input.rootDir ?? cwd);
  const statePath = process.env[ProjectRuntimeEnv.StatePath];
  if (!statePath) throw new Error("Project analysis worker requires an explicit analysis-state path.");
  const paths = createPaths(rootDir);
  const prerequisites = assertRuntimePrerequisites();
  const store = createProjectStore({ rootDir, paths, engine: prerequisites.engine, statePath });
  const engineAstProvider = engineProjectAstFactsProvider(store.project);
  const fixtureAst = createCliAstFactsProvider();
  setProjectAstFactsProviderFactory((queryRoot) => (queryRoot === rootDir ? engineAstProvider : fixtureAst.factory(queryRoot)));
  try {
    const analysis = await buildRuntimeAnalysis({
      cwd: rootDir,
      engine: prerequisites.engine,
      store,
      producerPolicy: BatchProducerPolicy,
      validationResultCache: createValidationResultCache(paths),
    });
    const result: ProjectAnalysisResult = {
      version: ProjectAnalysisProtocolVersion,
      requestId: input.requestId,
      analysis,
    };
    await mkdir(path.dirname(input.resultPath), { recursive: true });
    const partialPath = `${input.resultPath}.partial`;
    await writeFile(partialPath, `${JSON.stringify(result)}\n`, "utf8");
    await rename(partialPath, input.resultPath);
  } finally {
    setProjectAstFactsProviderFactory(undefined);
    fixtureAst.dispose();
    store.close();
  }
}

function parseWorkerArgs(args: string[]): { rootDir?: string; resultPath: string; requestId: string } {
  let rootDir: string | undefined;
  let resultPath: string | undefined;
  let requestId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1]?.trim();
    if (arg === "--root" && value) rootDir = value;
    else if (arg === "--result" && value) resultPath = path.resolve(value);
    else if (arg === "--request-id" && value) requestId = value;
    else throw new Error(`Unknown or incomplete project analysis worker option: ${String(arg)}.`);
    index += 1;
  }
  if (!resultPath) throw new Error("Project analysis worker requires --result <path>.");
  if (!requestId) throw new Error("Project analysis worker requires --request-id <id>.");
  return { rootDir, resultPath, requestId };
}
