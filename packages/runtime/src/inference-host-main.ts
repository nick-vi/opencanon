#!/usr/bin/env node
import { createInterface } from "node:readline";
import { loadEngine, type InferenceRuntime, type OpenInferenceRuntimeRequest } from "@opencanon/engine";
import {
  InferenceOperationKind,
  InferenceTaskKind,
  MaximumInferenceBatchSequences,
  type InferenceOperationKind as InferenceOperation,
  type InferenceTaskKind as InferenceTask,
} from "@opencanon/service-contracts";

type HostRequest = {
  id: string;
  operation: InferenceOperation;
  task: InferenceTask;
  texts: string[];
};

let runtime: InferenceRuntime;
try {
  const policyArg = process.argv.indexOf("--policy");
  if (policyArg < 0 || !process.argv[policyArg + 1]?.trim()) throw new Error("Inference host owner policy path is missing.");
  const encodedConfiguration = process.env.OPENCANON_INFERENCE_HOST_CONFIGURATION;
  if (!encodedConfiguration) throw new Error("Inference host configuration is missing.");
  const configuration = JSON.parse(encodedConfiguration) as OpenInferenceRuntimeRequest;
  runtime = loadEngine().openInferenceRuntime(configuration);
  write({ type: "ready", model: runtime.describe() });
} catch (error) {
  write({ type: "startup-failed", message: errorMessage(error) });
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request: HostRequest;
  try {
    request = parseRequest(line);
  } catch (error) {
    write({ type: "failed", id: "invalid-request", message: errorMessage(error) });
    continue;
  }
  try {
    const data = request.operation === InferenceOperationKind.Embed
      ? runtime.embed({ task: request.task, texts: request.texts })
      : runtime.countTokens({ task: request.task, texts: request.texts });
    write({ type: "completed", id: request.id, data });
  } catch (error) {
    write({ type: "failed", id: request.id, message: errorMessage(error) });
  }
}

function parseRequest(line: string): HostRequest {
  const value = JSON.parse(line) as Partial<HostRequest>;
  if (typeof value.id !== "string" || !value.id) throw new Error("Inference host request id is required.");
  if (value.operation !== InferenceOperationKind.CountTokens && value.operation !== InferenceOperationKind.Embed) throw new Error("Inference host operation is invalid.");
  if (value.task !== InferenceTaskKind.Document && value.task !== InferenceTaskKind.Query) throw new Error("Inference host task is invalid.");
  if (!Array.isArray(value.texts) || value.texts.length === 0 || value.texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("Inference host texts must be non-empty strings.");
  }
  if (value.texts.length > MaximumInferenceBatchSequences) throw new Error(`Inference host accepts at most ${MaximumInferenceBatchSequences} texts.`);
  return value as HostRequest;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
