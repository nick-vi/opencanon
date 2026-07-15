import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeCommandForCliInvocation } from "./service-entrypoint.ts";
import { terminateSpawnedProcess } from "./process-tree.ts";
import {
  KnowledgeIndexWorkerMessageType,
  type KnowledgeIndexWorkerMessage,
} from "./knowledge-index-worker.ts";
import type { KnowledgeIndexProgress } from "./knowledge-index-manager.ts";
import type { SemanticIndexSnapshot } from "@opencanon/core";
import { ProjectRuntimeEnv } from "./service-types.ts";

const ReadySemanticIndexStatus = "ready";

export type KnowledgeIndexOperationInput = {
  rootDir: string;
  statePath: string;
  force?: boolean;
  changedPaths?: string[];
  signal?: AbortSignal;
  onProgress(progress: KnowledgeIndexProgress): void;
};

export type KnowledgeIndexOperationResult = {
  index: SemanticIndexSnapshot;
  files: string[];
};

export type KnowledgeQueryOperationInput = {
  rootDir: string;
  statePath: string;
  query: string;
  signal?: AbortSignal;
};

export async function runKnowledgeIndexOperation(input: KnowledgeIndexOperationInput): Promise<KnowledgeIndexOperationResult> {
  const changedPathArgs = (input.changedPaths ?? []).flatMap((file) => ["--changed-path", file]);
  let readyResult: KnowledgeIndexOperationResult | undefined;
  await runKnowledgeWorker({
    ...input,
    args: ["--root", input.rootDir, ...(input.force ? ["--force"] : []), ...changedPathArgs],
    operation: "index",
    onMessage(message) {
      if (message.type === KnowledgeIndexWorkerMessageType.Progress) input.onProgress(message.progress);
      if (message.type === KnowledgeIndexWorkerMessageType.Ready) readyResult = { index: message.index, files: message.files };
    },
  });
  if (!readyResult) throw new Error("Project Knowledge index worker exited without a ready result.");
  return readyResult;
}

export async function runKnowledgeQueryOperation(input: KnowledgeQueryOperationInput): Promise<number[]> {
  let vector: number[] | undefined;
  await runKnowledgeWorker({
    ...input,
    args: ["--root", input.rootDir, "--query", input.query],
    operation: "query",
    onMessage(message) {
      if (message.type !== KnowledgeIndexWorkerMessageType.QueryReady) throw new Error("Project Knowledge query worker returned an index message.");
      vector = message.vector;
    },
  });
  if (!vector) throw new Error("Project Knowledge query worker exited without a vector.");
  return vector;
}

async function runKnowledgeWorker(input: {
  rootDir: string;
  statePath: string;
  args: string[];
  operation: "index" | "query";
  signal?: AbortSignal;
  onMessage(message: KnowledgeIndexWorkerMessage): void;
}): Promise<void> {
  const child = spawn(nodeCommandForCliInvocation(), [knowledgeIndexWorkerPath(), ...input.args], {
    cwd: input.rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [ProjectRuntimeEnv.StatePath]: input.statePath },
  });
  let stdout = "";
  let stderr = "";
  let protocolError: Error | undefined;
  const onAbort = () => {
    if (child.pid) void terminateSpawnedProcess(child.pid);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        try {
          const message = parseWorkerMessage(line);
          input.onMessage(message);
        } catch (error) {
          protocolError = error instanceof Error ? error : new Error(String(error));
          if (child.pid) void terminateSpawnedProcess(child.pid);
          return;
        }
      }
      newline = stdout.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (input.signal?.aborted) throw new Error(`Project Knowledge ${input.operation} was cancelled.`);
    if (protocolError) throw protocolError;
    if (code !== 0) {
      const detail = stderr.trim() || (signal ? `worker terminated by ${signal}` : `worker exited with code ${String(code)}`);
      throw new Error(`Project Knowledge ${input.operation} worker failed: ${detail}.`);
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function knowledgeIndexWorkerPath(): string {
  const sourcePath = fileURLToPath(new URL("./knowledge-index-worker-main.ts", import.meta.url));
  return existsSync(sourcePath) ? sourcePath : fileURLToPath(new URL("./knowledge-index-worker-main.js", import.meta.url));
}

function parseWorkerMessage(line: string): KnowledgeIndexWorkerMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Project Knowledge worker returned invalid progress JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || !("type" in value)) throw new Error("Project Knowledge worker returned an invalid progress message.");
  const message = value as KnowledgeIndexWorkerMessage;
  if (
    message.type === KnowledgeIndexWorkerMessageType.Ready &&
    message.index?.status === ReadySemanticIndexStatus &&
    Array.isArray(message.files) &&
    message.files.every((file) => typeof file === "string")
  ) return message;
  if (
    message.type === KnowledgeIndexWorkerMessageType.QueryReady
    && Array.isArray(message.vector)
    && message.vector.length > 0
    && message.vector.every((value) => typeof value === "number" && Number.isFinite(value))
  ) return message;
  if (message.type === KnowledgeIndexWorkerMessageType.Progress && message.progress && typeof message.progress.label === "string") return message;
  throw new Error("Project Knowledge worker returned an unknown progress message.");
}
