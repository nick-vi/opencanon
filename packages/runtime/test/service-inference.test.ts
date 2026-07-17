import assert from "node:assert/strict";
import { test } from "vitest";
import { runtimeAuthHeaders } from "../src/auth.ts";
import {
  InferenceCoordinatorFailure,
  InferenceCoordinatorFailureCode,
  type InferenceCoordinator,
} from "../src/inference-coordinator.ts";
import { startServiceServer } from "../src/service-server.ts";
import { ServiceApiRoute } from "../src/service-types.ts";
import { testInferenceDescription } from "./service-support.ts";

test("service inference routes authenticate, validate contracts, and preserve failure semantics", async () => {
  let countCalls = 0;
  const coordinator: InferenceCoordinator = {
    describe: testInferenceDescription,
    async countTokens(request) {
      countCalls += 1;
      if (request.modelId === "unavailable") {
        throw new InferenceCoordinatorFailure(
          InferenceCoordinatorFailureCode.HostUnavailable,
          503,
          "Test inference host is unavailable.",
          true,
        );
      }
      return {
        model: modelIdentity(request.modelId),
        tokenCounts: request.texts.map((text) => text.split(/\s+/u).length),
      };
    },
    async embed(request) {
      return {
        model: modelIdentity(request.modelId),
        tokenCounts: request.texts.map((text) => text.split(/\s+/u).length),
        vectors: request.texts.map(() => [1, 0]),
        queueWaitMs: 0,
        modelLoadMs: 0,
        inferenceMs: 0,
        coldLoad: false,
      };
    },
    cancel: () => false,
    async stop() {},
  };
  const server = await startServiceServer({ port: 0, reconcileIntervalMs: false, inferenceCoordinator: coordinator });
  try {
    const unauthorized = await fetch(`${server.url}${ServiceApiRoute.InferenceDescribe}`);
    assert.equal(unauthorized.status, 401);

    const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };
    const health = await fetch(`${server.url}${ServiceApiRoute.Health}`, { headers }).then((response) => response.json()) as { data: { inference: unknown } };
    assert.deepEqual(health.data.inference, testInferenceDescription());

    const malformed = await fetch(`${server.url}${ServiceApiRoute.InferenceCountTokens}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operationId: "missing-fields" }),
    });
    assert.equal(malformed.status, 400);
    assert.equal(countCalls, 0);

    const validBody = inferenceRequest("jina-code-v2");
    const valid = await fetch(`${server.url}${ServiceApiRoute.InferenceCountTokens}`, {
      method: "POST",
      headers,
      body: JSON.stringify(validBody),
    });
    assert.equal(valid.status, 200, await valid.clone().text());
    assert.equal(countCalls, 1);

    const unavailable = await fetch(`${server.url}${ServiceApiRoute.InferenceCountTokens}`, {
      method: "POST",
      headers,
      body: JSON.stringify(inferenceRequest("unavailable")),
    });
    assert.equal(unavailable.status, 503);
    const unavailableBody = await unavailable.json() as { error: { diagnostics: Array<{ code: string }> } };
    assert.equal(unavailableBody.error.diagnostics[0]?.code, InferenceCoordinatorFailureCode.HostUnavailable);
  } finally {
    await server.stop();
  }
});

function inferenceRequest(modelId: string) {
  return {
    operationId: `operation-${modelId}`,
    rootDir: "/project",
    modelId,
    task: "document",
    priority: "background",
    texts: ["one two"],
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

function modelIdentity(modelId: string) {
  return {
    provider: "gguf" as const,
    modelId,
    modelDigest: `digest-${modelId}`,
    dimensions: 2,
    distance: "cosine" as const,
    pooling: "last" as const,
    documentPrefix: "document: ",
    queryPrefix: "query: ",
    maximumInputTokens: 512,
    maximumSequences: 16,
    chunkProfileId: "test-v1",
  };
}
