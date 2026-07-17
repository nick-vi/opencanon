export const InferenceProviderKind = {
  Gguf: "gguf",
} as const;
export type InferenceProviderKind = (typeof InferenceProviderKind)[keyof typeof InferenceProviderKind];

export const InferenceBackendKind = {
  Cpu: "cpu",
  Metal: "metal",
} as const;
export type InferenceBackendKind = (typeof InferenceBackendKind)[keyof typeof InferenceBackendKind];

export const InferenceTaskKind = {
  Document: "document",
  Query: "query",
} as const;
export type InferenceTaskKind = (typeof InferenceTaskKind)[keyof typeof InferenceTaskKind];

export const InferenceOperationKind = {
  CountTokens: "count-tokens",
  Embed: "embed",
} as const;
export type InferenceOperationKind = (typeof InferenceOperationKind)[keyof typeof InferenceOperationKind];

export const InferencePriority = {
  Background: "background",
  Interactive: "interactive",
} as const;
export type InferencePriority = (typeof InferencePriority)[keyof typeof InferencePriority];

export const InferenceHostStatus = {
  Failed: "failed",
  Idle: "idle",
  Loading: "loading",
  Ready: "ready",
  Running: "running",
  Stopped: "stopped",
} as const;
export type InferenceHostStatus = (typeof InferenceHostStatus)[keyof typeof InferenceHostStatus];

// Leaves room for JSON escaping and protocol framing under the 1 MiB local-service frame limit.
export const MaximumInferenceRequestBytes = 128 * 1024;
export const MaximumInferenceBatchSequences = 16;

export type InferenceModelIdentity = {
  provider: InferenceProviderKind;
  modelId: string;
  modelDigest: string;
  dimensions: number;
  distance: "cosine";
  pooling: "last";
  documentPrefix: string;
  queryPrefix: string;
  maximumInputTokens: number;
  maximumSequences: number;
  chunkProfileId: string;
};

export type InferenceExecutionProfile = {
  id: string;
  provider: InferenceProviderKind;
  backend: InferenceBackendKind;
  contextTokens: number;
  batchTokens: number;
  microBatchTokens: number;
  maximumSequences: number;
  threads: number;
  gpuLayers: number;
};

export type InferenceExecutionPolicy = {
  version: 1;
  profileId: string;
  maximumRequestBytes: number;
  maximumQueueRequests: number;
  maximumQueueBytes: number;
  maximumRequestTokens: number;
  maximumConcurrentOperations: number;
  maximumResidentModels: 1;
  idleEvictionMs: number;
  requestTimeoutMs: number;
  hostStartupTimeoutMs: number;
};

export type InferenceMetrics = {
  completedOperations: number;
  failedOperations: number;
  cancelledOperations: number;
  rejectedOperations: number;
  coldLoads: number;
  hostStarts: number;
  hostRetirements: number;
  idleEvictions: number;
  totalQueueWaitMs: number;
  totalModelLoadMs: number;
  totalInferenceMs: number;
};

export type InferenceDescribeResult = {
  status: InferenceHostStatus;
  configurationSource: "default" | "file";
  configurationPath: string;
  profile: InferenceExecutionProfile;
  policy: InferenceExecutionPolicy;
  residentModel?: InferenceModelIdentity;
  activeOperationId?: string;
  queueRequests: number;
  queueBytes: number;
  metrics: InferenceMetrics;
  idleEvictionAt?: string;
  lastFailure?: string;
};

export type InferenceRequestBase = {
  operationId: string;
  rootDir: string;
  modelId: string;
  task: InferenceTaskKind;
  priority: InferencePriority;
  texts: string[];
  deadlineAt: string;
};

export type InferenceCountTokensRequest = InferenceRequestBase;

export type InferenceCountTokensResult = {
  model: InferenceModelIdentity;
  tokenCounts: number[];
};

export type InferenceEmbedRequest = InferenceRequestBase & {
  expectedModelDigest?: string;
};

export type InferenceEmbedResult = InferenceCountTokensResult & {
  vectors: number[][];
  queueWaitMs: number;
  modelLoadMs: number;
  inferenceMs: number;
  coldLoad: boolean;
};

export type InferenceCancelRequest = {
  operationId: string;
  rootDir: string;
};

export type InferenceContractParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export function parseInferenceCountTokensRequest(value: unknown): InferenceContractParseResult<InferenceCountTokensRequest> {
  return parseInferenceRequest(value, false);
}

export function parseInferenceEmbedRequest(value: unknown): InferenceContractParseResult<InferenceEmbedRequest> {
  return parseInferenceRequest(value, true);
}

export function parseInferenceCancelRequest(value: unknown): InferenceContractParseResult<InferenceCancelRequest> {
  if (!isRecord(value)) return invalid("Inference cancellation request must be an object.");
  const operationId = requiredString(value.operationId);
  const rootDir = requiredString(value.rootDir);
  if (!operationId || !rootDir) return invalid("Inference cancellation requires operationId and rootDir.");
  return { ok: true, value: { operationId, rootDir } };
}

export function isInferenceDescribeResult(value: unknown): value is InferenceDescribeResult {
  if (!isRecord(value) || !Object.values(InferenceHostStatus).includes(value.status as InferenceHostStatus)) return false;
  if (value.configurationSource !== "default" && value.configurationSource !== "file") return false;
  if (!requiredString(value.configurationPath) || !isExecutionProfile(value.profile) || !isExecutionPolicy(value.policy)) return false;
  if (value.profile.id !== value.policy.profileId) return false;
  if (!nonNegativeInteger(value.queueRequests) || !nonNegativeInteger(value.queueBytes)) return false;
  if (!isMetrics(value.metrics)) return false;
  if (value.activeOperationId !== undefined && !requiredString(value.activeOperationId)) return false;
  if (value.idleEvictionAt !== undefined && (!requiredString(value.idleEvictionAt) || !Number.isFinite(Date.parse(value.idleEvictionAt as string)))) return false;
  if (value.lastFailure !== undefined && !requiredString(value.lastFailure)) return false;
  return value.residentModel === undefined || isModelIdentity(value.residentModel);
}

function parseInferenceRequest(value: unknown, embed: false): InferenceContractParseResult<InferenceCountTokensRequest>;
function parseInferenceRequest(value: unknown, embed: true): InferenceContractParseResult<InferenceEmbedRequest>;
function parseInferenceRequest(value: unknown, embed: boolean): InferenceContractParseResult<InferenceCountTokensRequest | InferenceEmbedRequest> {
  if (!isRecord(value)) return invalid("Inference request must be an object.");
  const operationId = requiredString(value.operationId);
  const rootDir = requiredString(value.rootDir);
  const modelId = requiredString(value.modelId);
  if (!operationId || !rootDir || !modelId) return invalid("Inference request requires operationId, rootDir, and modelId.");
  if (!Object.values(InferenceTaskKind).includes(value.task as InferenceTaskKind)) return invalid("Inference task must be document or query.");
  if (!Object.values(InferencePriority).includes(value.priority as InferencePriority)) return invalid("Inference priority must be background or interactive.");
  if (!Array.isArray(value.texts) || value.texts.length === 0 || value.texts.some((text) => typeof text !== "string" || !text.trim())) {
    return invalid("Inference texts must be a non-empty array of non-empty strings.");
  }
  if (value.texts.length > MaximumInferenceBatchSequences) {
    return invalid(`Inference request may contain at most ${MaximumInferenceBatchSequences} texts.`);
  }
  const deadlineAt = requiredString(value.deadlineAt);
  if (!deadlineAt || !Number.isFinite(Date.parse(deadlineAt))) return invalid("Inference deadlineAt must be a valid timestamp.");
  const base: InferenceCountTokensRequest = {
    operationId,
    rootDir,
    modelId,
    task: value.task as InferenceTaskKind,
    priority: value.priority as InferencePriority,
    texts: value.texts as string[],
    deadlineAt,
  };
  if (!embed) return { ok: true, value: base };
  if (value.expectedModelDigest !== undefined && !requiredString(value.expectedModelDigest)) {
    return invalid("Inference expectedModelDigest must be a non-empty string when provided.");
  }
  return {
    ok: true,
    value: {
      ...base,
      ...(typeof value.expectedModelDigest === "string" ? { expectedModelDigest: value.expectedModelDigest.trim() } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isExecutionProfile(value: unknown): value is InferenceExecutionProfile {
  if (!isRecord(value)) return false;
  const contextTokens = value.contextTokens;
  const batchTokens = value.batchTokens;
  const microBatchTokens = value.microBatchTokens;
  return Boolean(requiredString(value.id)) && value.provider === InferenceProviderKind.Gguf
    && Object.values(InferenceBackendKind).includes(value.backend as InferenceBackendKind)
    && positiveInteger(contextTokens) && positiveInteger(batchTokens) && positiveInteger(microBatchTokens)
    && batchTokens <= contextTokens && microBatchTokens <= batchTokens
    && value.maximumSequences === MaximumInferenceBatchSequences
    && positiveInteger(value.threads) && nonNegativeInteger(value.gpuLayers);
}

function isExecutionPolicy(value: unknown): value is InferenceExecutionPolicy {
  if (!isRecord(value)) return false;
  return value.version === 1 && Boolean(requiredString(value.profileId))
    && positiveInteger(value.maximumRequestBytes) && value.maximumRequestBytes <= MaximumInferenceRequestBytes && positiveInteger(value.maximumQueueRequests)
    && positiveInteger(value.maximumQueueBytes) && positiveInteger(value.maximumRequestTokens)
    && value.maximumConcurrentOperations === 1 && value.maximumResidentModels === 1
    && positiveInteger(value.idleEvictionMs) && positiveInteger(value.requestTimeoutMs) && positiveInteger(value.hostStartupTimeoutMs);
}

function isModelIdentity(value: unknown): value is InferenceModelIdentity {
  if (!isRecord(value)) return false;
  return value.provider === InferenceProviderKind.Gguf && Boolean(requiredString(value.modelId))
    && Boolean(requiredString(value.modelDigest)) && positiveInteger(value.dimensions) && value.distance === "cosine"
    && value.pooling === "last" && typeof value.documentPrefix === "string" && typeof value.queryPrefix === "string"
    && positiveInteger(value.maximumInputTokens) && value.maximumSequences === MaximumInferenceBatchSequences
    && Boolean(requiredString(value.chunkProfileId));
}

function isMetrics(value: unknown): value is InferenceMetrics {
  if (!isRecord(value)) return false;
  return [
    value.completedOperations,
    value.failedOperations,
    value.cancelledOperations,
    value.rejectedOperations,
    value.coldLoads,
    value.hostStarts,
    value.hostRetirements,
    value.idleEvictions,
    value.totalQueueWaitMs,
    value.totalModelLoadMs,
    value.totalInferenceMs,
  ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
}

function invalid<T>(message: string): InferenceContractParseResult<T> {
  return { ok: false, message };
}
