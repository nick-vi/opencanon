import assert from "node:assert/strict";
import { test } from "vitest";
import { InferenceOperationKind, InferencePriority, InferenceTaskKind, type InferenceOperationKind as InferenceOperation } from "@opencanon/service-contracts";
import { createInferenceCoordinator } from "../src/inference-coordinator.ts";
import type { InferenceHost } from "../src/inference-host.ts";
import { defaultMachineInferenceConfiguration, parseMachineInferenceConfiguration } from "../src/inference-policy.ts";

const Root = "/project";

test("machine inference policy rejects contradictory execution limits", () => {
  const base = defaultMachineInferenceConfiguration();
  assert.throws(
    () => parseMachineInferenceConfiguration({
      ...base,
      profile: { ...base.profile, contextTokens: 512, batchTokens: 1024 },
    }),
    /batchTokens cannot exceed profile.contextTokens/u,
  );
  assert.throws(
    () => parseMachineInferenceConfiguration({
      ...base,
      policy: { ...base.policy, maximumConcurrentOperations: 2 },
    }),
    /maximumConcurrentOperations must be 1/u,
  );
  assert.throws(
    () => parseMachineInferenceConfiguration({
      ...base,
      profile: { ...base.profile, maximumSequences: 8 },
    }),
    /profile.maximumSequences must be 16/u,
  );
});

test("inference coordinator shares one resident model across projects and evicts it when idle", async () => {
  const base = defaultMachineInferenceConfiguration();
  let starts = 0;
  let stops = 0;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: { ...base.policy, idleEvictionMs: 10 },
    async startHost({ configuration }) {
      starts += 1;
      return fakeHost(configuration.modelId, () => { stops += 1; });
    },
  });
  try {
    const first = await coordinator.embed(request("first", Root, "document"));
    const second = await coordinator.embed(request("second", "/another-project", "document"));
    assert.equal(first.vectors[0].length, 896);
    assert.equal(second.vectors[0].length, 896);
    assert.equal(starts, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stops, 1);
    assert.equal(coordinator.describe().status, "stopped");
    assert.equal(coordinator.describe().metrics.completedOperations, 2);
    assert.equal(coordinator.describe().metrics.hostStarts, 1);
    assert.equal(coordinator.describe().metrics.coldLoads, 1);
    assert.equal(coordinator.describe().metrics.idleEvictions, 1);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator retires the resident host on model change", async () => {
  const base = defaultMachineInferenceConfiguration();
  const models: string[] = [];
  let stops = 0;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: base.policy,
    async startHost({ configuration }) {
      models.push(configuration.modelId);
      return fakeHost(configuration.modelId, () => { stops += 1; });
    },
  });
  try {
    await coordinator.embed(request("small", Root, "document"));
    await coordinator.embed({ ...request("large", Root, "document"), modelId: "jina-code-v2-large" });
    assert.deepEqual(models, ["jina-code-v2", "jina-code-v2-large"]);
    assert.equal(stops, 1);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator enforces token policy before embedding", async () => {
  const base = defaultMachineInferenceConfiguration();
  let embedCalls = 0;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: { ...base.policy, maximumRequestTokens: 2 },
    async startHost({ configuration }) {
      return fakeHost(configuration.modelId, () => undefined, () => { embedCalls += 1; });
    },
  });
  try {
    await assert.rejects(() => coordinator.embed({ ...request("too-large", Root, "document"), texts: ["one two three"] }), /permits at most 2/u);
    assert.equal(embedCalls, 0);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator enforces the model input contract before decode", async () => {
  const base = defaultMachineInferenceConfiguration();
  let embedCalls = 0;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: base.policy,
    async startHost({ configuration }) {
      return fakeHost(configuration.modelId, () => undefined, () => { embedCalls += 1; });
    },
  });
  try {
    const oversized = Array.from({ length: 513 }, () => "token").join(" ");
    const counted = await coordinator.countTokens({ ...request("count-oversized", Root, "document"), texts: [oversized] });
    assert.deepEqual(counted.tokenCounts, [513]);
    await assert.rejects(
      () => coordinator.embed({ ...request("embed-oversized", Root, "document"), texts: [oversized] }),
      /text at index 0 contains 513 tokens.*at most 512/u,
    );
    assert.equal(embedCalls, 0);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator rejects an incompatible execution profile before starting a host", async () => {
  const base = defaultMachineInferenceConfiguration();
  let starts = 0;
  const coordinator = createInferenceCoordinator({
    source: "file",
    path: "/inference-policy.json",
    profile: { ...base.profile, id: "undersized", microBatchTokens: 256 },
    policy: { ...base.policy, profileId: "undersized" },
    async startHost({ configuration }) {
      starts += 1;
      return fakeHost(configuration.modelId, () => undefined);
    },
  });
  try {
    await assert.rejects(
      () => coordinator.countTokens(request("undersized-profile", Root, "query")),
      /profile undersized permits 256 input tokens.*model jina-code-v2 requires 512/u,
    );
    assert.equal(starts, 0);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator rejects an individual request before it consumes queue capacity", async () => {
  const base = defaultMachineInferenceConfiguration();
  let starts = 0;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: { ...base.policy, maximumRequestBytes: 3 },
    async startHost({ configuration }) {
      starts += 1;
      return fakeHost(configuration.modelId, () => undefined);
    },
  });
  try {
    await assert.rejects(() => coordinator.embed({ ...request("too-many-bytes", Root, "document"), texts: ["four"] }), /at most 3/u);
    assert.equal(starts, 0);
    assert.equal(coordinator.describe().queueRequests, 0);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator rejects excessive sequences before starting a host", async () => {
  const base = defaultMachineInferenceConfiguration();
  let starts = 0;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: base.policy,
    async startHost({ configuration }) {
      starts += 1;
      return fakeHost(configuration.modelId, () => undefined);
    },
  });
  try {
    await assert.rejects(
      () => coordinator.embed({ ...request("too-many-sequences", Root, "document"), texts: Array.from({ length: 17 }, () => "text") }),
      /at most 16/u,
    );
    assert.equal(starts, 0);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator cancels an active operation and retires its host", async () => {
  const base = defaultMachineInferenceConfiguration();
  let stopped = false;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: base.policy,
    async startHost({ configuration }) {
      const host = fakeHost(configuration.modelId, () => { stopped = true; });
      return {
        ...host,
        async request<T>(_request: Parameters<InferenceHost["request"]>[0], signal?: AbortSignal): Promise<T> {
          return await new Promise<T>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          });
        },
      };
    },
  });
  try {
    const operation = coordinator.embed(request("cancel-me", Root, "query"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(coordinator.cancel({ operationId: "cancel-me", rootDir: Root }), true);
    await assert.rejects(() => operation, /cancelled/u);
    assert.equal(stopped, true);
    assert.equal(coordinator.describe().metrics.cancelledOperations, 1);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator exposes an unexpected host exit and repairs on the next request", async () => {
  const base = defaultMachineInferenceConfiguration();
  let hostAlive = true;
  let hostFailure: string | undefined;
  let starts = 0;
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: base.policy,
    async startHost({ configuration }) {
      starts += 1;
      const current = fakeHost(configuration.modelId, () => undefined);
      return {
        ...current,
        get alive() { return hostAlive; },
        get failure() { return hostFailure; },
      };
    },
  });
  try {
    await coordinator.countTokens(request("before-crash", Root, "query"));
    assert.equal(coordinator.describe().metrics.coldLoads, 1);
    hostFailure = "host crashed";
    hostAlive = false;
    const failed = coordinator.describe();
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastFailure, "host crashed");
    assert.equal(failed.residentModel, undefined);

    hostAlive = true;
    hostFailure = undefined;
    await coordinator.countTokens(request("after-crash", Root, "query"));
    assert.equal(starts, 2);
    assert.equal(coordinator.describe().metrics.coldLoads, 2);
  } finally {
    await coordinator.stop();
  }
});

test("inference coordinator bounds interactive priority so background work cannot starve", async () => {
  const base = defaultMachineInferenceConfiguration();
  const executionOrder: string[] = [];
  let releaseFirst!: () => void;
  let first = true;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const coordinator = createInferenceCoordinator({
    source: "default",
    path: "/inference-policy.json",
    profile: base.profile,
    policy: base.policy,
    async startHost({ configuration }) {
      const host = fakeHost(configuration.modelId, () => undefined);
      return {
        ...host,
        async request<T>(hostRequest: Parameters<InferenceHost["request"]>[0]): Promise<T> {
          if (first) {
            first = false;
            await firstBlocked;
          }
          if (hostRequest.operation === "embed") executionOrder.push(hostRequest.texts[0] ?? "");
          return await host.request<T>(hostRequest);
        },
      };
    },
  });
  try {
    const blocker = coordinator.embed({ ...request("blocker", Root, "document"), texts: ["blocker"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const background = coordinator.embed({ ...request("background", Root, "document"), texts: ["background"] });
    const interactive = Array.from({ length: 5 }, (_value, index) => coordinator.embed({
      ...request(`interactive-${index + 1}`, Root, "query"),
      texts: [`interactive-${index + 1}`],
    }));
    releaseFirst();
    await Promise.all([blocker, background, ...interactive]);
    assert.deepEqual(executionOrder, ["blocker", "interactive-1", "interactive-2", "interactive-3", "interactive-4", "background", "interactive-5"]);
  } finally {
    await coordinator.stop();
  }
});

function request(operationId: string, rootDir: string, task: "document" | "query") {
  return {
    operationId,
    rootDir,
    modelId: "jina-code-v2",
    task: task === "document" ? InferenceTaskKind.Document : InferenceTaskKind.Query,
    priority: task === "document" ? InferencePriority.Background : InferencePriority.Interactive,
    texts: ["one two"],
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function fakeHost(
  modelId: string,
  onStop: () => void,
  onEmbed: () => void = () => undefined,
): InferenceHost {
  let alive = true;
  const dimensions = modelId === "jina-code-v2-large" ? 1536 : 896;
  const model = {
    modelId,
    dimensions,
    maximumInputTokens: 512,
    contextTokens: 2048,
    batchTokens: 2048,
    microBatchTokens: 512,
    maximumSequences: 16,
    threads: 4,
    gpuLayers: 0,
  };
  return {
    model,
    get alive() { return alive; },
    async request<T>(request: { operation: InferenceOperation; texts: string[] }): Promise<T> {
      const tokenCounts = request.texts.map((text) => text.trim().split(/\s+/u).length);
      if (request.operation === InferenceOperationKind.Embed) onEmbed();
      return {
        model,
        tokenCounts,
        ...(request.operation === InferenceOperationKind.Embed
          ? { vectors: request.texts.map(() => Array.from({ length: dimensions }, (_value, index) => index === 0 ? 1 : 0)) }
          : {}),
      } as T;
    },
    async stop() {
      if (!alive) return;
      alive = false;
      onStop();
    },
  };
}
