import { performance } from "node:perf_hooks";
import {
  semanticEmbeddingConfigHash,
  semanticEmbeddingModel,
  type SemanticEmbeddingModelId,
} from "@opencanon/core";
import type { InferenceRuntimeDescription } from "@opencanon/engine";
import {
  InferenceHostStatus,
  InferenceOperationKind,
  InferencePriority,
  InferenceTaskKind,
  MaximumInferenceBatchSequences,
  type InferenceCancelRequest,
  type InferenceCountTokensRequest,
  type InferenceCountTokensResult,
  type InferenceDescribeResult,
  type InferenceEmbedRequest,
  type InferenceEmbedResult,
  type InferenceExecutionPolicy,
  type InferenceExecutionProfile,
  type InferenceModelIdentity,
} from "@opencanon/service-contracts";
import { startInferenceHost, type InferenceHost } from "./inference-host.ts";

type QueuedOperation = {
  request: InferenceCountTokensRequest | InferenceEmbedRequest;
  kind: InferenceOperationKind;
  enqueuedAt: number;
  bytes: number;
  controller: AbortController;
  resolve(value: InferenceCountTokensResult | InferenceEmbedResult): void;
  reject(error: Error): void;
};

export type InferenceCoordinator = {
  describe(): InferenceDescribeResult;
  countTokens(request: InferenceCountTokensRequest, signal?: AbortSignal): Promise<InferenceCountTokensResult>;
  embed(request: InferenceEmbedRequest, signal?: AbortSignal): Promise<InferenceEmbedResult>;
  cancel(request: InferenceCancelRequest): boolean;
  stop(): Promise<void>;
};

export const InferenceCoordinatorFailureCode = {
  Cancelled: "inference-cancelled",
  DeadlineExceeded: "inference-deadline-exceeded",
  DuplicateOperation: "inference-duplicate-operation",
  HostUnavailable: "inference-host-unavailable",
  InvalidRequest: "inference-invalid-request",
  ModelMismatch: "inference-model-mismatch",
  QueueFull: "inference-queue-full",
  RequestTooLarge: "inference-request-too-large",
  Stopped: "inference-coordinator-stopped",
  TokenBudgetExceeded: "inference-token-budget-exceeded",
} as const;
export type InferenceCoordinatorFailureCode = (typeof InferenceCoordinatorFailureCode)[keyof typeof InferenceCoordinatorFailureCode];

export class InferenceCoordinatorFailure extends Error {
  readonly code: InferenceCoordinatorFailureCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: InferenceCoordinatorFailureCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = "InferenceCoordinatorFailure";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function isInferenceCoordinatorFailure(value: unknown): value is InferenceCoordinatorFailure {
  return value instanceof InferenceCoordinatorFailure;
}

export function createInferenceCoordinator(input: {
  profile: InferenceExecutionProfile;
  policy: InferenceExecutionPolicy;
  source: "default" | "file";
  path: string;
  startHost?: typeof startInferenceHost;
  now?: () => number;
}): InferenceCoordinator {
  const interactive: QueuedOperation[] = [];
  const background: QueuedOperation[] = [];
  const byId = new Map<string, QueuedOperation>();
  const startHost = input.startHost ?? startInferenceHost;
  const now = input.now ?? performance.now.bind(performance);
  let host: InferenceHost | undefined;
  let residentModel: InferenceModelIdentity | undefined;
  let hostStatus: InferenceHostStatus = InferenceHostStatus.Stopped;
  let active: QueuedOperation | undefined;
  let queueBytes = 0;
  let draining = false;
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleEvictionAt: string | undefined;
  let lastFailure: string | undefined;
  let interactiveBurst = 0;
  const metrics = {
    completedOperations: 0,
    failedOperations: 0,
    cancelledOperations: 0,
    rejectedOperations: 0,
    coldLoads: 0,
    hostStarts: 0,
    hostRetirements: 0,
    idleEvictions: 0,
    totalQueueWaitMs: 0,
    totalModelLoadMs: 0,
    totalInferenceMs: 0,
  };

  return {
    describe() {
      refreshExitedHost();
      return {
        status: hostStatus,
        configurationSource: input.source,
        configurationPath: input.path,
        profile: input.profile,
        policy: input.policy,
        ...(residentModel ? { residentModel } : {}),
        ...(active ? { activeOperationId: active.request.operationId } : {}),
        queueRequests: interactive.length + background.length,
        queueBytes,
        metrics: { ...metrics },
        ...(idleEvictionAt ? { idleEvictionAt } : {}),
        ...(lastFailure ? { lastFailure } : {}),
      };
    },
    countTokens(request, signal) {
      return enqueue(InferenceOperationKind.CountTokens, request, signal) as Promise<InferenceCountTokensResult>;
    },
    embed(request, signal) {
      return enqueue(InferenceOperationKind.Embed, request, signal) as Promise<InferenceEmbedResult>;
    },
    cancel(request) {
      const operation = byId.get(request.operationId);
      if (!operation || operation.request.rootDir !== request.rootDir) return false;
      const failure = inferenceFailure(InferenceCoordinatorFailureCode.Cancelled, 409, "Inference operation was cancelled.");
      operation.controller.abort(failure);
      if (operation !== active) removeQueued(operation, failure);
      return true;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      const error = inferenceFailure(InferenceCoordinatorFailureCode.Stopped, 503, "Inference coordinator stopped.", true);
      for (const operation of [...interactive, ...background]) removeQueued(operation, error);
      active?.controller.abort(error);
      const current = host;
      host = undefined;
      residentModel = undefined;
      hostStatus = InferenceHostStatus.Stopped;
      await current?.stop(error.message);
    },
  };

  function enqueue(
    kind: QueuedOperation["kind"],
    request: QueuedOperation["request"],
    signal?: AbortSignal,
  ): Promise<InferenceCountTokensResult | InferenceEmbedResult> {
    try {
      validateRequest(request);
    } catch (error) {
      return rejectOperation(error instanceof Error ? error : new Error(String(error)));
    }
    if (stopped) return rejectOperation(inferenceFailure(InferenceCoordinatorFailureCode.Stopped, 503, "Inference coordinator is stopped.", true));
    if (signal?.aborted) return rejectOperation(inferenceFailure(InferenceCoordinatorFailureCode.Cancelled, 409, "Inference operation was cancelled."));
    if (byId.has(request.operationId)) return rejectOperation(inferenceFailure(InferenceCoordinatorFailureCode.DuplicateOperation, 409, `Inference operation ${request.operationId} already exists.`));
    const bytes = request.texts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
    if (bytes > input.policy.maximumRequestBytes) {
      return rejectOperation(inferenceFailure(InferenceCoordinatorFailureCode.RequestTooLarge, 413, `Inference request contains ${bytes} bytes; policy permits at most ${input.policy.maximumRequestBytes}.`));
    }
    if (interactive.length + background.length >= input.policy.maximumQueueRequests) {
      return rejectOperation(inferenceFailure(InferenceCoordinatorFailureCode.QueueFull, 429, `Inference queue is full at ${input.policy.maximumQueueRequests} requests.`, true));
    }
    if (queueBytes + bytes > input.policy.maximumQueueBytes) {
      return rejectOperation(inferenceFailure(InferenceCoordinatorFailureCode.QueueFull, 429, `Inference queue byte budget of ${input.policy.maximumQueueBytes} would be exceeded.`, true));
    }
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const operation: QueuedOperation = { request, kind, enqueuedAt: now(), bytes, controller, resolve, reject };
      const abortFromCaller = () => {
        controller.abort(signal?.reason);
        if (operation !== active) removeQueued(operation, inferenceFailure(InferenceCoordinatorFailureCode.Cancelled, 409, "Inference operation was cancelled."));
      };
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      controller.signal.addEventListener("abort", () => signal?.removeEventListener("abort", abortFromCaller), { once: true });
      byId.set(request.operationId, operation);
      (request.priority === InferencePriority.Interactive ? interactive : background).push(operation);
      queueBytes += bytes;
      clearIdleEviction();
      void drain();
    });
  }

  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        const operation = nextOperation();
        if (!operation) break;
        active = operation;
        queueBytes -= operation.bytes;
        const queue = operation.request.priority === InferencePriority.Interactive ? interactive : background;
        const queueIndex = queue.indexOf(operation);
        if (queueIndex >= 0) queue.splice(queueIndex, 1);
        try {
          const value = await execute(operation);
          metrics.completedOperations += 1;
          operation.resolve(value);
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          lastFailure = normalized.message;
          const abortReason = operation.controller.signal.reason;
          if (isInferenceCoordinatorFailure(abortReason) && abortReason.code === InferenceCoordinatorFailureCode.Cancelled) metrics.cancelledOperations += 1;
          else metrics.failedOperations += 1;
          operation.reject(normalized);
          if (operation.controller.signal.aborted || host?.alive === false) await retireHost("Inference host retired after an interrupted operation.");
        } finally {
          byId.delete(operation.request.operationId);
          active = undefined;
        }
      }
    } finally {
      draining = false;
      if (!active && interactive.length + background.length === 0 && !stopped) scheduleIdleEviction();
    }
  }

  function nextOperation(): QueuedOperation | undefined {
    if (interactive.length > 0 && (interactiveBurst < 4 || background.length === 0)) {
      interactiveBurst += 1;
      return interactive[0];
    }
    if (background.length > 0) {
      interactiveBurst = 0;
      return background[0];
    }
    return interactive[0];
  }

  async function execute(operation: QueuedOperation): Promise<InferenceCountTokensResult | InferenceEmbedResult> {
    const deadlineMs = new Date(operation.request.deadlineAt).getTime();
    const remaining = Math.min(input.policy.requestTimeoutMs, deadlineMs - Date.now());
    if (remaining <= 0) throw inferenceFailure(InferenceCoordinatorFailureCode.DeadlineExceeded, 408, "Inference operation deadline has passed.");
    const deadlineTimer = setTimeout(() => operation.controller.abort(inferenceFailure(InferenceCoordinatorFailureCode.DeadlineExceeded, 408, "Inference operation deadline exceeded.")), remaining);
    let inferenceStartedAt: number | undefined;
    try {
      const loadStartedAt = now();
      const queueWaitMs = Math.max(0, loadStartedAt - operation.enqueuedAt);
      metrics.totalQueueWaitMs += queueWaitMs;
      const coldLoad = !host || residentModel?.modelId !== operation.request.modelId;
      const currentHost = await ensureHost(operation.request.modelId);
      const modelLoadMs = coldLoad ? now() - loadStartedAt : 0;
      if (coldLoad) {
        metrics.coldLoads += 1;
        metrics.totalModelLoadMs += modelLoadMs;
      }
      inferenceStartedAt = now();
      const tokenResult = await currentHost.request<{
        model: InferenceRuntimeDescription;
        tokenCounts: number[];
      }>({ operation: InferenceOperationKind.CountTokens, task: operation.request.task, texts: operation.request.texts }, operation.controller.signal);
      const totalTokens = tokenResult.tokenCounts.reduce((sum, count) => sum + count, 0);
      if (totalTokens > input.policy.maximumRequestTokens) {
        throw inferenceFailure(InferenceCoordinatorFailureCode.TokenBudgetExceeded, 413, `Inference request contains ${totalTokens} tokens; policy permits at most ${input.policy.maximumRequestTokens}.`);
      }
      const model = modelIdentity(operation.request.modelId, tokenResult.model);
      if (operation.kind === InferenceOperationKind.CountTokens) return { model, tokenCounts: tokenResult.tokenCounts };
      const oversizedText = tokenResult.tokenCounts.findIndex((count) => count > model.maximumInputTokens);
      if (oversizedText >= 0) {
        throw inferenceFailure(
          InferenceCoordinatorFailureCode.TokenBudgetExceeded,
          413,
          `Inference text at index ${oversizedText} contains ${tokenResult.tokenCounts[oversizedText]} tokens; model ${model.modelId} permits at most ${model.maximumInputTokens}.`,
        );
      }
      if ("expectedModelDigest" in operation.request && operation.request.expectedModelDigest && operation.request.expectedModelDigest !== model.modelDigest) {
        throw inferenceFailure(InferenceCoordinatorFailureCode.ModelMismatch, 409, `Inference model digest changed for ${model.modelId}; rebuild Project Knowledge with the current model.`);
      }
      const result = await currentHost.request<{
        model: InferenceRuntimeDescription;
        tokenCounts: number[];
        vectors: number[][];
      }>({ operation: InferenceOperationKind.Embed, task: operation.request.task, texts: operation.request.texts }, operation.controller.signal);
      if (!result.vectors) throw inferenceFailure(InferenceCoordinatorFailureCode.HostUnavailable, 503, "Inference host returned no vectors.", true);
      const embeddedModel = modelIdentity(operation.request.modelId, result.model);
      if (embeddedModel.modelDigest !== model.modelDigest) throw inferenceFailure(InferenceCoordinatorFailureCode.ModelMismatch, 409, `Inference host changed model identity while processing ${model.modelId}.`);
      if (result.tokenCounts.length !== tokenResult.tokenCounts.length || result.tokenCounts.some((count, index) => count !== tokenResult.tokenCounts[index])) {
        throw inferenceFailure(InferenceCoordinatorFailureCode.HostUnavailable, 503, "Inference host returned inconsistent token counts between planning and embedding.", true);
      }
      if (result.vectors.length !== operation.request.texts.length || result.vectors.some((vector) => vector.length !== model.dimensions)) {
        throw inferenceFailure(InferenceCoordinatorFailureCode.HostUnavailable, 503, `Inference host returned vectors that do not match ${model.modelId}.`, true);
      }
      return {
        model,
        tokenCounts: tokenResult.tokenCounts,
        vectors: result.vectors,
        queueWaitMs,
        modelLoadMs,
        inferenceMs: now() - inferenceStartedAt,
        coldLoad,
      };
    } finally {
      if (inferenceStartedAt !== undefined) metrics.totalInferenceMs += Math.max(0, now() - inferenceStartedAt);
      clearTimeout(deadlineTimer);
    }
  }

  async function ensureHost(modelId: string): Promise<InferenceHost> {
    const model = semanticEmbeddingModel(modelId as SemanticEmbeddingModelId);
    const executionCapacity = Math.min(input.profile.contextTokens, input.profile.batchTokens, input.profile.microBatchTokens);
    if (executionCapacity < model.config.maximumInputTokens) {
      throw inferenceFailure(
        InferenceCoordinatorFailureCode.HostUnavailable,
        503,
        `Inference profile ${input.profile.id} permits ${executionCapacity} input tokens, but model ${model.id} requires ${model.config.maximumInputTokens}. Correct the machine inference policy before retrying.`,
      );
    }
    if (host?.alive && residentModel?.modelId === modelId) {
      hostStatus = InferenceHostStatus.Running;
      return host;
    }
    await retireHost("Inference model changed.");
    hostStatus = InferenceHostStatus.Loading;
    try {
      host = await startHost({
        configuration: {
          modelId,
          nGpuLayers: input.profile.gpuLayers,
          nThreads: input.profile.threads,
          nCtx: input.profile.contextTokens,
          nBatch: input.profile.batchTokens,
          nUbatch: input.profile.microBatchTokens,
          nSeqMax: input.profile.maximumSequences,
        },
        startupTimeoutMs: input.policy.hostStartupTimeoutMs,
        ownerPolicyPath: input.path,
      });
      metrics.hostStarts += 1;
      residentModel = modelIdentity(modelId, host.model);
      hostStatus = InferenceHostStatus.Running;
      lastFailure = undefined;
      return host;
    } catch (error) {
      hostStatus = InferenceHostStatus.Failed;
      lastFailure = error instanceof Error ? error.message : String(error);
      if (isInferenceCoordinatorFailure(error)) throw error;
      throw inferenceFailure(InferenceCoordinatorFailureCode.HostUnavailable, 503, error instanceof Error ? error.message : String(error), true);
    }
  }

  async function retireHost(reason: string, idle = false): Promise<void> {
    const current = host;
    host = undefined;
    residentModel = undefined;
    idleEvictionAt = undefined;
    if (!current) {
      if (!stopped) hostStatus = InferenceHostStatus.Stopped;
      return;
    }
    metrics.hostRetirements += 1;
    if (idle) metrics.idleEvictions += 1;
    await current.stop(reason);
    if (!stopped) hostStatus = InferenceHostStatus.Stopped;
  }

  function removeQueued(operation: QueuedOperation, error: Error): void {
    const queue = operation.request.priority === InferencePriority.Interactive ? interactive : background;
    const index = queue.indexOf(operation);
    if (index < 0) return;
    queue.splice(index, 1);
    queueBytes -= operation.bytes;
    byId.delete(operation.request.operationId);
    if (isInferenceCoordinatorFailure(error) && error.code === InferenceCoordinatorFailureCode.Cancelled) metrics.cancelledOperations += 1;
    operation.reject(error);
  }

  function scheduleIdleEviction(): void {
    if (!host || idleTimer || stopped) return;
    idleEvictionAt = new Date(Date.now() + input.policy.idleEvictionMs).toISOString();
    hostStatus = InferenceHostStatus.Idle;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void retireHost("Inference host reached its idle timeout.", true);
    }, input.policy.idleEvictionMs);
    idleTimer.unref?.();
  }

  function clearIdleEviction(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    idleEvictionAt = undefined;
    if (host) hostStatus = InferenceHostStatus.Ready;
  }

  function refreshExitedHost(): void {
    if (!host || host.alive) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    idleEvictionAt = undefined;
    lastFailure = host.failure ?? "Inference host exited unexpectedly.";
    host = undefined;
    residentModel = undefined;
    hostStatus = InferenceHostStatus.Failed;
    metrics.hostRetirements += 1;
  }

  function rejectOperation<T>(error: Error): Promise<T> {
    metrics.rejectedOperations += 1;
    return Promise.reject(error);
  }
}

function validateRequest(request: InferenceCountTokensRequest | InferenceEmbedRequest): void {
  if (!request || typeof request !== "object") throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference request must be an object.");
  if (typeof request.operationId !== "string" || typeof request.rootDir !== "string" || typeof request.modelId !== "string") {
    throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference operation, project, and model ids are required.");
  }
  if (!request.operationId.trim() || !request.rootDir.trim() || !request.modelId.trim()) throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference operation, project, and model ids are required.");
  try {
    semanticEmbeddingModel(request.modelId as SemanticEmbeddingModelId);
  } catch {
    throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, `Unknown GGUF inference model ${request.modelId}.`);
  }
  if (request.task !== InferenceTaskKind.Document && request.task !== InferenceTaskKind.Query) throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference task must be document or query.");
  if (request.priority !== InferencePriority.Background && request.priority !== InferencePriority.Interactive) throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference priority must be background or interactive.");
  if (!Array.isArray(request.texts) || !request.texts.length || request.texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference request texts must be non-empty strings.");
  }
  if (request.texts.length > MaximumInferenceBatchSequences) {
    throw inferenceFailure(InferenceCoordinatorFailureCode.RequestTooLarge, 413, `Inference request contains ${request.texts.length} texts; at most ${MaximumInferenceBatchSequences} are permitted.`);
  }
  if (typeof request.deadlineAt !== "string") throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference request deadline is invalid.");
  if (!Number.isFinite(new Date(request.deadlineAt).getTime())) throw inferenceFailure(InferenceCoordinatorFailureCode.InvalidRequest, 400, "Inference request deadline is invalid.");
}

function inferenceFailure(code: InferenceCoordinatorFailureCode, status: number, message: string, retryable = false): InferenceCoordinatorFailure {
  return new InferenceCoordinatorFailure(code, status, message, retryable);
}

function modelIdentity(modelId: string, description: InferenceRuntimeDescription): InferenceModelIdentity {
  const model = semanticEmbeddingModel(modelId as SemanticEmbeddingModelId);
  const maximumInputTokens = model.config.maximumInputTokens;
  if (
    description.modelId !== model.id
    || description.dimensions !== model.dimensions
    || description.maximumInputTokens !== maximumInputTokens
    || description.maximumSequences !== MaximumInferenceBatchSequences
  ) {
    throw inferenceFailure(InferenceCoordinatorFailureCode.ModelMismatch, 409, `Inference host model identity mismatch for ${modelId}.`);
  }
  return {
    provider: model.providerKind,
    modelId: model.id,
    modelDigest: semanticEmbeddingConfigHash(model.config),
    dimensions: model.dimensions,
    distance: model.distance,
    pooling: "last",
    documentPrefix: model.config.documentPrefix,
    queryPrefix: model.config.queryPrefix,
    maximumInputTokens,
    maximumSequences: description.maximumSequences,
    chunkProfileId: model.config.chunkProfileId,
  };
}
