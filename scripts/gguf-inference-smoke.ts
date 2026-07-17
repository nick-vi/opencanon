import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DefaultGgufSemanticEmbeddingModelId, semanticEmbeddingModel, type SemanticEmbeddingModelId } from "@opencanon/core";
import { InferencePriority, InferenceTaskKind } from "@opencanon/service-contracts";
import { createInferenceCoordinator, defaultMachineInferenceConfiguration } from "@opencanon/runtime";

const SmokeEnv = {
  Model: "OPENCANON_GGUF_INFERENCE_MODEL",
} as const;

if (process.argv.includes("--optional")) {
  console.log("Skipping GGUF inference smoke because --optional was provided.");
  process.exit(0);
}

const modelId = process.env[SmokeEnv.Model]?.trim() || DefaultGgufSemanticEmbeddingModelId;
const configuration = defaultMachineInferenceConfiguration();
const coordinator = createInferenceCoordinator({
  ...configuration,
  source: "default",
  path: "/smoke/inference-policy.json",
  policy: { ...configuration.policy, idleEvictionMs: 100 },
});

try {
  const first = await coordinator.embed(request("/smoke/project-one", modelId, "OpenCanon project conventions and specs"));
  const second = await coordinator.embed(request("/smoke/project-two", modelId, "Project Knowledge search and retrieval"));
  const batchTexts = Array.from(
    { length: configuration.profile.maximumSequences },
    (_value, index) => `Project Knowledge batch sequence ${index} ${"token ".repeat(40)}`,
  );
  const batched = await coordinator.embed(request("/smoke/project-one", modelId, batchTexts));
  for (const result of [first, second, batched]) {
    const vector = result.vectors[0] ?? [];
    assert(vector.length > 0 && vector.every(Number.isFinite), `GGUF inference returned an invalid vector for ${modelId}.`);
  }
  assert.equal(batched.vectors.length, batchTexts.length, "GGUF inference must preserve every sequence across physical micro-batches.");
  assert.equal(first.model.maximumInputTokens, semanticEmbeddingModel(modelId as SemanticEmbeddingModelId).config.maximumInputTokens);
  const shared = coordinator.describe();
  assert.equal(shared.metrics.hostStarts, 1, "Two projects must share one resident model host.");
  assert.equal(shared.residentModel?.modelId, modelId);
  assert.equal(first.coldLoad, true);
  assert.equal(second.coldLoad, false);
  assert.equal(second.modelLoadMs, 0);

  await new Promise((resolve) => setTimeout(resolve, 250));
  const evicted = coordinator.describe();
  assert.equal(evicted.status, "stopped");
  assert.equal(evicted.metrics.idleEvictions, 1);
  console.log(`GGUF inference smoke passed with ${modelId}: ${first.vectors[0]?.length ?? 0} dimensions, cold load ${first.modelLoadMs.toFixed(0)}ms, warm query ${second.inferenceMs.toFixed(0)}ms, ${batchTexts.length} batched sequences, one shared host, idle eviction confirmed.`);
} finally {
  await coordinator.stop();
}

function request(rootDir: string, selectedModelId: string, text: string | string[]) {
  return {
    operationId: randomUUID(),
    rootDir,
    modelId: selectedModelId,
    task: InferenceTaskKind.Query,
    priority: InferencePriority.Interactive,
    texts: Array.isArray(text) ? text : [text],
    deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}
