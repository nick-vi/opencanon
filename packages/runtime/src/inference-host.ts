import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InferenceRuntimeDescription, OpenInferenceRuntimeRequest } from "@opencanon/engine";
import type { InferenceOperationKind, InferenceTaskKind } from "@opencanon/service-contracts";
import { nodeCommandForCliInvocation } from "./service-entrypoint.ts";
import { terminateSpawnedProcess } from "./process-tree.ts";

export type InferenceHostRequest = {
  operation: InferenceOperationKind;
  task: InferenceTaskKind;
  texts: string[];
};

export type InferenceHost = {
  readonly model: InferenceRuntimeDescription;
  readonly alive: boolean;
  readonly failure?: string;
  request<T>(request: InferenceHostRequest, signal?: AbortSignal): Promise<T>;
  stop(reason?: string): Promise<void>;
};

export async function startInferenceHost(input: {
  configuration: OpenInferenceRuntimeRequest;
  startupTimeoutMs: number;
  ownerPolicyPath: string;
}): Promise<InferenceHost> {
  const child = spawn(nodeCommandForCliInvocation(), [inferenceHostPath(), "--policy", input.ownerPolicyPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCANON_INFERENCE_HOST_CONFIGURATION: JSON.stringify(input.configuration) },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let stopping = false;
  let alive = true;
  let failure: string | undefined;
  let rejectStartup: ((error: Error) => void) | undefined;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  const model = await new Promise<InferenceRuntimeDescription>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, value?: InferenceRuntimeDescription) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      rejectStartup = undefined;
      if (error && child.pid) void terminateSpawnedProcess(child.pid);
      error ? reject(error) : resolve(value!);
    };
    rejectStartup = (error) => finish(error);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(hostExitMessage(code, signal, stderr)));
    timer = setTimeout(() => finish(new Error(`Inference host did not load within ${input.startupTimeoutMs}ms.`)), input.startupTimeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", (chunk: string) => consume(chunk, (message) => {
      if (message.type === "ready" && isModelDescription(message.model)) finish(undefined, message.model);
      if (message.type === "startup-failed") finish(new Error(typeof message.message === "string" ? message.message : "Inference host failed to start."));
    }));
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-32_768);
    });
  });

  child.removeAllListeners("exit");
  child.removeAllListeners("error");
  child.stdout.removeAllListeners("data");
  child.stdout.on("data", (chunk: string) => consume(chunk, routeMessage));
  child.once("error", failAll);
  child.once("exit", (code, signal) => {
    alive = false;
    if (!stopping) {
      failure = hostExitMessage(code, signal, stderr);
      failAll(new Error(failure));
    }
  });

  return {
    model,
    get alive() {
      return alive;
    },
    get failure() {
      return failure;
    },
    async request<T>(request: InferenceHostRequest, signal?: AbortSignal) {
      if (stopping) throw new Error("Inference host is stopping.");
      const id = randomUUID();
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          cleanup();
          reject(signal?.reason instanceof Error ? signal.reason : new Error("Inference operation was cancelled."));
          alive = false;
          failure = signal?.reason instanceof Error ? signal.reason.message : "Inference operation was cancelled.";
          if (child.pid) void terminateSpawnedProcess(child.pid);
        };
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
          if (!error) return;
          const item = pending.get(id);
          pending.delete(id);
          item?.cleanup();
          item?.reject(new Error(`Could not write inference host request: ${error.message}`));
        });
      });
    },
    async stop(reason = "Inference host stopped.") {
      if (stopping) return;
      stopping = true;
      alive = false;
      failAll(new Error(reason));
      if (child.pid) await terminateSpawnedProcess(child.pid);
    },
  };

  function consume(chunk: string, onMessage: (message: Record<string, unknown>) => void): void {
    stdout += chunk;
    let newline = stdout.indexOf("\n");
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        try {
          const value = JSON.parse(line);
          if (value && typeof value === "object" && !Array.isArray(value)) onMessage(value as Record<string, unknown>);
          else throw new Error("Inference host returned a non-object message.");
        } catch (error) {
          const failure = new Error(`Inference host returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
          rejectStartup?.(failure);
          failAll(failure);
        }
      }
      newline = stdout.indexOf("\n");
    }
  }

  function routeMessage(message: Record<string, unknown>): void {
    if (typeof message.id !== "string") return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    item.cleanup();
    if (message.type === "completed") item.resolve(message.data);
    else item.reject(new Error(typeof message.message === "string" ? message.message : "Inference host request failed."));
  }

  function failAll(error: Error): void {
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    pending.clear();
  }
}

function inferenceHostPath(): string {
  const source = fileURLToPath(new URL("./inference-host-main.ts", import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL("./inference-host-main.js", import.meta.url));
}

function isModelDescription(value: unknown): value is InferenceRuntimeDescription {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.modelId === "string" && typeof record.dimensions === "number" && typeof record.maximumInputTokens === "number";
}

function hostExitMessage(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  return stderr.trim() || (signal ? `Inference host terminated by ${signal}.` : `Inference host exited with code ${String(code)}.`);
}
