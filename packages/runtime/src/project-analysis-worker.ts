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
import { buildRuntimeAnalysisOutcome } from "./snapshot.ts";
import { createProjectAnalysisStore } from "./state.ts";

export async function runProjectAnalysisWorkerCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const input = parseWorkerArgs(args);
  const rootDir = resolveRootDir(input.rootDir ?? cwd);
  const statePath = process.env[ProjectRuntimeEnv.StatePath];
  if (!statePath) throw new Error("Project analysis worker requires an explicit analysis-state path.");
  const paths = createPaths(rootDir);
  const prerequisites = assertRuntimePrerequisites();
  const store = createProjectAnalysisStore({
    rootDir,
    paths,
    engine: prerequisites.engine,
    statePath,
    codeGraphStatePath: input.codeGraphStatePath,
  });
  const engineAstProvider = engineProjectAstFactsProvider(store.project);
  const fixtureAst = createCliAstFactsProvider();
  setProjectAstFactsProviderFactory((queryRoot) => (queryRoot === rootDir ? engineAstProvider : fixtureAst.factory(queryRoot)));
  try {
    const outcome = await buildRuntimeAnalysisOutcome({
      cwd: rootDir,
      engine: prerequisites.engine,
      store,
      producerPolicy: BatchProducerPolicy,
      validationResultCache: createValidationResultCache(paths),
      previousAnalysisInputHash: input.previousAnalysisInputHash,
    });
    const result: ProjectAnalysisResult = {
      version: ProjectAnalysisProtocolVersion,
      requestId: input.requestId,
      outcome,
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

function parseWorkerArgs(args: string[]): {
  rootDir?: string;
  resultPath: string;
  requestId: string;
  codeGraphStatePath: string;
  previousAnalysisInputHash?: string;
} {
  let rootDir: string | undefined;
  let resultPath: string | undefined;
  let requestId: string | undefined;
  let codeGraphStatePath: string | undefined;
  let previousAnalysisInputHash: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1]?.trim();
    if (arg === "--root" && value) rootDir = value;
    else if (arg === "--result" && value) resultPath = path.resolve(value);
    else if (arg === "--request-id" && value) requestId = value;
    else if (arg === "--code-graph-state" && value) codeGraphStatePath = path.resolve(value);
    else if (arg === "--previous-analysis-input-hash" && value) previousAnalysisInputHash = value;
    else throw new Error(`Unknown or incomplete project analysis worker option: ${String(arg)}.`);
    index += 1;
  }
  if (!resultPath) throw new Error("Project analysis worker requires --result <path>.");
  if (!requestId) throw new Error("Project analysis worker requires --request-id <id>.");
  if (!codeGraphStatePath) throw new Error("Project analysis worker requires --code-graph-state <path>.");
  return { rootDir, resultPath, requestId, codeGraphStatePath, previousAnalysisInputHash };
}
