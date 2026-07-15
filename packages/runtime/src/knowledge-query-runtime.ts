import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeCommandForCliInvocation } from "./service-entrypoint.ts";
import { terminateSpawnedProcess } from "./process-tree.ts";
import { KnowledgeIndexWorkerMessageType } from "./knowledge-index-worker.ts";
import { ProjectRuntimeEnv } from "./service-types.ts";

type PendingQuery = {
  resolve(vector: number[]): void;
  reject(error: Error): void;
  cleanup(): void;
};

export type KnowledgeQueryRuntime = {
  query(text: string, signal?: AbortSignal): Promise<number[]>;
  reset(): Promise<void>;
  stop(): Promise<void>;
};

export function createKnowledgeQueryRuntime(input: { rootDir: string; statePath(): string }): KnowledgeQueryRuntime {
  let child: ChildProcessWithoutNullStreams | undefined;
  let stdout = "";
  let stderr = "";
  let stopping = false;
  const pending = new Map<string, PendingQuery>();

  return {
    async query(text, signal) {
      if (stopping) throw new Error("Project Knowledge query runtime is stopping.");
      const worker = ensureWorker();
      const id = randomUUID();
      return await new Promise<number[]>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          reject(new Error("Project Knowledge query was cancelled."));
        };
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        pending.set(id, { resolve, reject, cleanup });
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.stdin.write(`${JSON.stringify({ id, query: text })}\n`, (error) => {
          if (!error) return;
          const request = pending.get(id);
          pending.delete(id);
          request?.cleanup();
          request?.reject(new Error(`Could not send Project Knowledge query: ${error.message}`));
        });
      });
    },
    async reset() {
      await stopWorker("Project Knowledge query runtime reset.");
    },
    async stop() {
      stopping = true;
      await stopWorker("Project Knowledge query runtime stopped.");
    },
  };

  function ensureWorker(): ChildProcessWithoutNullStreams {
    if (child && child.exitCode === null && child.signalCode === null) return child;
    stdout = "";
    stderr = "";
    const next = spawn(nodeCommandForCliInvocation(), [knowledgeWorkerPath(), "--root", input.rootDir, "--query-server"], {
      cwd: input.rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, [ProjectRuntimeEnv.StatePath]: input.statePath() },
    });
    child = next;
    next.stdout.setEncoding("utf8");
    next.stderr.setEncoding("utf8");
    next.stdout.on("data", consumeOutput);
    next.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    next.once("error", (error) => failWorker(error));
    next.once("exit", (code, signal) => {
      if (child === next) child = undefined;
      if (!stopping && pending.size > 0) {
        const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exited with code ${String(code)}`);
        rejectPending(new Error(`Project Knowledge query worker ${detail}.`));
      }
    });
    return next;
  }

  function consumeOutput(chunk: string): void {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) consumeMessage(line);
      newline = stdout.indexOf("\n");
    }
  }

  function consumeMessage(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      failWorker(new Error(`Project Knowledge query worker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!value || typeof value !== "object" || !("type" in value) || !("id" in value)) {
      failWorker(new Error("Project Knowledge query worker returned an invalid message."));
      return;
    }
    const message = value as { type: unknown; id: unknown; vector?: unknown; message?: unknown };
    if (typeof message.id !== "string") {
      failWorker(new Error("Project Knowledge query worker returned a message without a request id."));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.cleanup();
    if (message.type === KnowledgeIndexWorkerMessageType.QueryFailed && typeof message.message === "string") {
      request.reject(new Error(message.message));
      return;
    }
    if (
      message.type === KnowledgeIndexWorkerMessageType.QueryReady
      && Array.isArray(message.vector)
      && message.vector.length > 0
      && message.vector.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      request.resolve(message.vector);
      return;
    }
    request.reject(new Error("Project Knowledge query worker returned an invalid result."));
  }

  function failWorker(error: Error): void {
    rejectPending(error);
    if (child?.pid) void terminateSpawnedProcess(child.pid);
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    pending.clear();
  }

  async function stopWorker(reason: string): Promise<void> {
    const active = child;
    child = undefined;
    rejectPending(new Error(reason));
    if (!active?.pid) return;
    await terminateSpawnedProcess(active.pid);
  }
}

function knowledgeWorkerPath(): string {
  const sourcePath = fileURLToPath(new URL("./knowledge-index-worker-main.ts", import.meta.url));
  return existsSync(sourcePath) ? sourcePath : fileURLToPath(new URL("./knowledge-index-worker-main.js", import.meta.url));
}
