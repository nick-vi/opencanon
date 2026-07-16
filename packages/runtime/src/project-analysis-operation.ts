import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectAnalysisResult } from "./project-analysis-protocol.ts";
import { terminateSpawnedProcess } from "./process-tree.ts";
import { nodeCommandForCliInvocation } from "./service-entrypoint.ts";
import { ProjectRuntimeEnv } from "./service-types.ts";
import type { RuntimeAnalysisOutcome } from "./snapshot.ts";

export type ProjectAnalysisOperationInput = {
  rootDir: string;
  analysisStatePath: string;
  previousAnalysisInputHash?: string;
  signal?: AbortSignal;
};

export async function runProjectAnalysisOperation(input: ProjectAnalysisOperationInput): Promise<RuntimeAnalysisOutcome> {
  if (input.signal?.aborted) throw new Error("Project analysis was superseded.");
  const requestId = randomUUID();
  const operationDir = await mkdtemp(path.join(os.tmpdir(), "opencanon-project-analysis-"));
  const resultPath = path.join(operationDir, "result.json");
  const childArgs = [
    projectAnalysisWorkerPath(),
    "--root",
    input.rootDir,
    "--result",
    resultPath,
    "--request-id",
    requestId,
    ...(input.previousAnalysisInputHash ? ["--previous-analysis-input-hash", input.previousAnalysisInputHash] : []),
  ];
  const child = spawn(nodeCommandForCliInvocation(), childArgs, {
    cwd: input.rootDir,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, [ProjectRuntimeEnv.StatePath]: input.analysisStatePath },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const onAbort = () => {
    if (child.pid) void terminateSpawnedProcess(child.pid);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    if (input.signal?.aborted) throw new Error("Project analysis was superseded.");
    if (code !== 0) {
      const detail = stderr.trim() || (signal ? `worker terminated by ${signal}` : `worker exited with code ${String(code)}`);
      throw new Error(`Project analysis worker failed: ${detail}.`);
    }
    const result = parseProjectAnalysisResult(await readProjectAnalysisResult(resultPath), requestId);
    return result.outcome;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null && child.pid) await terminateSpawnedProcess(child.pid).catch(() => undefined);
    await rm(operationDir, { recursive: true, force: true });
  }
}

async function readProjectAnalysisResult(resultPath: string): Promise<unknown> {
  const content = await readFile(resultPath, "utf8");
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Project analysis worker wrote an invalid result: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function projectAnalysisWorkerPath(): string {
  const sourcePath = fileURLToPath(new URL("./project-analysis-worker-main.ts", import.meta.url));
  return existsSync(sourcePath) ? sourcePath : fileURLToPath(new URL("./project-analysis-worker-main.js", import.meta.url));
}
