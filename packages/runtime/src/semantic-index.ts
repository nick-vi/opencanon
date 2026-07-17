import {
  createSemanticChunkId,
  DefaultSemanticIndexId,
  DiagnosticSeverity,
  semanticChunkTreeHash,
  DefaultSemanticEmbeddingConfig,
  semanticEmbeddingModel,
  semanticEmbeddingConfigHash,
  semanticEmbeddingIdentityHash,
  semanticEmbeddingRecordHash,
  semanticPreview,
  semanticTextHash,
  SemanticEmbeddingProviderKind,
  semanticEmbeddingModelIds,
  SemanticChunkerVersion,
  SemanticEmbeddingProducerVersion,
  SemanticIndexVersion,
  type FileFacts,
  type ScanAndDiffResult,
  type SemanticChunkEmbedding,
  type SemanticChunkMetadata,
  type SemanticEmbeddingConfig,
  type SemanticEmbeddingModelId,
  type SemanticEmbeddingProvider,
  type SemanticIndexDiagnostic,
  type SemanticIndexSnapshot,
  type WriteSemanticIndexDeltaRequest,
  type WriteSemanticIndexRequest,
} from "@opencanon/core";
import { InferencePriority, InferenceTaskKind, MaximumInferenceBatchSequences } from "@opencanon/service-contracts";
import { collectRuntimeKnowledgeChunks, knowledgeProducerIdentity, type RuntimeKnowledgeChunk } from "./knowledge-producers.ts";
import { semanticIndexAncestorNodeKeys, semanticIndexNodesForChunks } from "./semantic-index-nodes.ts";
import type { ServiceInferenceClient } from "./service-inference-client.ts";

const MaxEmbeddingBatchTexts = MaximumInferenceBatchSequences;
const MaxEmbeddingBatchChars = 64_000;

export type ProjectSemanticIndexBuildInput = {
  rootDir: string;
  scan: ScanAndDiffResult;
  facts: FileFacts[];
  inference: ServiceInferenceClient;
  signal?: AbortSignal | undefined;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
  previousChunks?: SemanticChunkMetadata[] | undefined;
  runtimeChunks?: RuntimeKnowledgeChunk[] | undefined;
  diagnostics?: SemanticIndexDiagnostic[] | undefined;
  onEmbeddingProgress?: ((completed: number, total: number) => void) | undefined;
};

export type ProjectSemanticIndexDeltaInput = ProjectSemanticIndexBuildInput & {
  previousIndex: SemanticIndexSnapshot;
  previousChunks: SemanticChunkMetadata[];
};

type PlannedKnowledgeChunk = {
  text: string;
  metadata: Omit<SemanticChunkMetadata, "embeddingHash">;
};

export async function buildProjectSemanticIndex(input: ProjectSemanticIndexBuildInput): Promise<WriteSemanticIndexRequest> {
  const backend = createSemanticEmbeddingBackend(input.inference, input.rootDir, input.semanticEmbedding, input.signal);
  const provider = backend.provider;
  const producerVersion = semanticIndexProducerVersion();
  const diagnostics: SemanticIndexDiagnostic[] = [...(input.diagnostics ?? [])];
  diagnostics.push(...backend.diagnostics);
  const sourceChunks = collectRuntimeSemanticChunks(input, diagnostics);
  let runtimeChunks: PlannedKnowledgeChunk[] = [];
  if (sourceChunks.length > 0 && !hasSemanticIndexError(diagnostics)) {
    try {
      runtimeChunks = await fitRuntimeChunksToTokenBudget(backend, sourceChunks);
    } catch (error) {
      diagnostics.push({
        code: "semantic-token-budget-failed",
        message: `Could not plan semantic chunks with ${provider.modelId}: ${error instanceof Error ? error.message : String(error)}`,
        severity: DiagnosticSeverity.Error,
      });
    }
  }

  const chunksWithEmbeddingHash = runtimeChunksWithEmbeddingHash(runtimeChunks, provider);
  const previousEmbeddingHashes = new Map((input.previousChunks ?? []).map((chunk) => [chunk.id, chunk.embeddingHash]));
  const chunksNeedingEmbedding = chunksWithEmbeddingHash.filter((chunk) => previousEmbeddingHashes.get(chunk.metadata.id) !== chunk.metadata.embeddingHash);
  const reusedChunkCount = chunksWithEmbeddingHash.length - chunksNeedingEmbedding.length;
  const vectorsByChunkId = new Map<string, number[]>();
  let vectors: number[][] = [];
  if (chunksNeedingEmbedding.length > 0 && !hasSemanticIndexError(diagnostics)) {
    try {
      vectors = await embedDocumentsInBatches(backend, chunksNeedingEmbedding.map((chunk) => chunk.text), input.onEmbeddingProgress);
    } catch (error) {
      diagnostics.push({
        code: "semantic-embedding-failed",
        message: `Could not embed semantic chunks with ${provider.modelId}: ${error instanceof Error ? error.message : String(error)}`,
        severity: DiagnosticSeverity.Error,
      });
    }
  }
  if (chunksNeedingEmbedding.length > 0 && vectors.length !== chunksNeedingEmbedding.length) {
    diagnostics.push({
      code: "semantic-vector-count-mismatch",
      message: `Semantic embedding provider returned ${vectors.length} vectors for ${chunksNeedingEmbedding.length} changed chunks.`,
      severity: DiagnosticSeverity.Error,
    });
    vectors = [];
  }
  for (const [index, chunk] of chunksNeedingEmbedding.entries()) {
    const vector = vectors[index];
    if (vector) vectorsByChunkId.set(chunk.metadata.id, vector);
  }

  const chunks: SemanticChunkEmbedding[] =
    hasSemanticIndexError(diagnostics)
      ? []
      : chunksWithEmbeddingHash.map((chunk) => {
        const canReuseVector = previousEmbeddingHashes.get(chunk.metadata.id) === chunk.metadata.embeddingHash;
        return {
          metadata: chunk.metadata,
          text: chunk.text,
          vector: canReuseVector ? [] : (vectorsByChunkId.get(chunk.metadata.id) ?? []),
        };
      });
  const identityHash = semanticEmbeddingIdentityHash({
    providerId: provider.id,
    modelId: provider.modelId,
    modelDigest: provider.modelDigest,
    dimensions: provider.dimensions,
    configHash: provider.configHash,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
  });
  const index: SemanticIndexSnapshot = {
    id: DefaultSemanticIndexId,
    version: SemanticIndexVersion,
    status: hasSemanticIndexError(diagnostics) ? "failed" : "ready",
    provider,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
    sourceInventoryHash: input.scan.inventoryHash,
    chunkTreeHash: semanticChunkTreeHash(chunks),
    identityHash,
    chunkCount: chunks.length,
    vectorCount: chunks.length,
    staleChunkCount: 0,
    embeddingStats: {
      totalChunks: chunksWithEmbeddingHash.length,
      embeddedChunks: chunksNeedingEmbedding.length,
      reusedChunks: reusedChunkCount,
      filesScanned: input.scan.files.length,
      filesChanged: input.scan.changedFiles.length,
      filesDeleted: input.scan.deletedFiles.length,
      chunksAdded: chunksWithEmbeddingHash.length,
      chunksChanged: 0,
      chunksRemoved: 0,
      vectorsWritten: chunksNeedingEmbedding.length,
      vectorsReused: reusedChunkCount,
    },
    indexedAt: new Date().toISOString(),
    diagnostics,
  };
  return { index, chunks, nodes: semanticIndexNodesForChunks(chunks.map((chunk) => chunk.metadata)) };
}

export async function buildProjectSemanticIndexDelta(input: ProjectSemanticIndexDeltaInput): Promise<WriteSemanticIndexDeltaRequest> {
  const backend = createSemanticEmbeddingBackend(input.inference, input.rootDir, input.semanticEmbedding, input.signal);
  const provider = backend.provider;
  const producerVersion = semanticIndexProducerVersion();
  const diagnostics: SemanticIndexDiagnostic[] = [...(input.diagnostics ?? [])];
  diagnostics.push(...backend.diagnostics);
  const identityHash = semanticEmbeddingIdentityHash({
    providerId: provider.id,
    modelId: provider.modelId,
    modelDigest: provider.modelDigest,
    dimensions: provider.dimensions,
    configHash: provider.configHash,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
  });
  if (input.previousIndex.identityHash !== identityHash) {
    diagnostics.push({
      code: "semantic-index-identity-changed",
      message: "Project Knowledge provider identity changed. Run opencanon project index --force to rebuild vectors with the configured model.",
      severity: DiagnosticSeverity.Error,
    });
  }

  const changedPaths = new Set(input.scan.changedFiles);
  const deletedPaths = new Set(input.scan.deletedFiles);
  const changedSourceChunks = collectRuntimeSemanticChunks(input, diagnostics, changedPaths);
  let changedRuntimeChunks: PlannedKnowledgeChunk[] = [];
  if (changedSourceChunks.length > 0 && !hasSemanticIndexError(diagnostics)) {
    try {
      changedRuntimeChunks = await fitRuntimeChunksToTokenBudget(backend, changedSourceChunks);
    } catch (error) {
      diagnostics.push({
        code: "semantic-token-budget-failed",
        message: `Could not plan changed semantic chunks with ${provider.modelId}: ${error instanceof Error ? error.message : String(error)}`,
        severity: DiagnosticSeverity.Error,
      });
    }
  }
  const changedChunksWithEmbeddingHash = runtimeChunksWithEmbeddingHash(changedRuntimeChunks, provider);
  const previousRemovedChunks = input.previousChunks.filter((chunk) => changedPaths.has(chunk.path) || deletedPaths.has(chunk.path));
  const previousRetainedChunks = input.previousChunks.filter((chunk) => !changedPaths.has(chunk.path) && !deletedPaths.has(chunk.path));
  const finalMetadata = [...previousRetainedChunks, ...changedChunksWithEmbeddingHash.map((chunk) => chunk.metadata)]
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  const vectorsByChunkId = new Map<string, number[]>();
  let vectors: number[][] = [];
  if (changedChunksWithEmbeddingHash.length > 0 && !hasSemanticIndexError(diagnostics)) {
    try {
      vectors = await embedDocumentsInBatches(backend, changedChunksWithEmbeddingHash.map((chunk) => chunk.text), input.onEmbeddingProgress);
    } catch (error) {
      diagnostics.push({
        code: "semantic-embedding-failed",
        message: `Could not embed semantic chunks with ${provider.modelId}: ${error instanceof Error ? error.message : String(error)}`,
        severity: DiagnosticSeverity.Error,
      });
    }
  }
  if (changedChunksWithEmbeddingHash.length > 0 && vectors.length !== changedChunksWithEmbeddingHash.length) {
    diagnostics.push({
      code: "semantic-vector-count-mismatch",
      message: `Semantic embedding provider returned ${vectors.length} vectors for ${changedChunksWithEmbeddingHash.length} changed chunks.`,
      severity: DiagnosticSeverity.Error,
    });
    vectors = [];
  }
  for (const [index, chunk] of changedChunksWithEmbeddingHash.entries()) {
    const vector = vectors[index];
    if (vector) vectorsByChunkId.set(chunk.metadata.id, vector);
  }
  const chunks: SemanticChunkEmbedding[] = hasSemanticIndexError(diagnostics)
    ? []
    : changedChunksWithEmbeddingHash.map((chunk) => ({
      metadata: chunk.metadata,
      text: chunk.text,
      vector: vectorsByChunkId.get(chunk.metadata.id) ?? [],
    }));
  const embeddedChunks = hasSemanticIndexError(diagnostics) ? 0 : changedChunksWithEmbeddingHash.length;
  const index: SemanticIndexSnapshot = {
    id: DefaultSemanticIndexId,
    version: SemanticIndexVersion,
    status: hasSemanticIndexError(diagnostics) ? "failed" : "ready",
    provider,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
    sourceInventoryHash: input.scan.inventoryHash,
    chunkTreeHash: semanticChunkTreeHash(finalMetadata.map((metadata) => ({ metadata }))),
    identityHash,
    chunkCount: finalMetadata.length,
    vectorCount: finalMetadata.length,
    staleChunkCount: hasSemanticIndexError(diagnostics) ? finalMetadata.length : 0,
    embeddingStats: {
      totalChunks: finalMetadata.length,
      embeddedChunks,
      reusedChunks: Math.max(0, finalMetadata.length - embeddedChunks),
      filesScanned: input.scan.files.length,
      filesChanged: input.scan.changedFiles.length,
      filesDeleted: input.scan.deletedFiles.length,
      chunksAdded: Math.max(0, changedChunksWithEmbeddingHash.length - previousRemovedChunks.length),
      chunksChanged: changedChunksWithEmbeddingHash.length,
      chunksRemoved: previousRemovedChunks.length,
      vectorsWritten: embeddedChunks,
      vectorsReused: Math.max(0, finalMetadata.length - embeddedChunks),
    },
    indexedAt: new Date().toISOString(),
    diagnostics,
  };
  return {
    index,
    chunks,
    removedPaths: [...new Set([...input.scan.deletedFiles, ...input.scan.changedFiles])],
    removedNodeKeys: semanticIndexAncestorNodeKeys([...input.scan.deletedFiles, ...input.scan.changedFiles]),
    nodes: semanticIndexNodesForChunks(finalMetadata),
  };
}

async function fitRuntimeChunksToTokenBudget(
  backend: SemanticEmbeddingBackend,
  chunks: RuntimeKnowledgeChunk[],
): Promise<PlannedKnowledgeChunk[]> {
  const counts: number[] = [];
  let maximumInputTokens = 0;
  for (let start = 0; start < chunks.length; start += MaxEmbeddingBatchTexts) {
    const batch = chunks.slice(start, start + MaxEmbeddingBatchTexts);
    const result = await backend.countDocuments(batch.map((chunk) => chunk.text));
    if (result.tokenCounts.length !== batch.length || result.maximumInputTokens < 1) {
      throw new Error("Inference service returned invalid token planning metadata.");
    }
    if (result.tokenCounts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
      throw new Error("Inference service returned invalid token counts.");
    }
    if (maximumInputTokens > 0 && maximumInputTokens !== result.maximumInputTokens) {
      throw new Error("Inference model token budget changed during Project Knowledge planning.");
    }
    maximumInputTokens = result.maximumInputTokens;
    counts.push(...result.tokenCounts);
  }
  const planned: PlannedKnowledgeChunk[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const count = counts[index];
    if (count === undefined) throw new Error(`Inference service omitted token count ${index}.`);
    if (count <= maximumInputTokens) {
      planned.push({ ...chunk, metadata: { ...chunk.metadata, tokenCount: count } });
      continue;
    }
    planned.push(...await splitRuntimeChunk(backend, chunk, maximumInputTokens));
  }
  const ordinals = new Map<string, number>();
  return planned.map((chunk) => {
    const ordinal = ordinals.get(chunk.metadata.path) ?? 0;
    ordinals.set(chunk.metadata.path, ordinal + 1);
    return { ...chunk, metadata: { ...chunk.metadata, ordinal } };
  });
}

async function splitRuntimeChunk(
  backend: SemanticEmbeddingBackend,
  chunk: RuntimeKnowledgeChunk,
  maximumInputTokens: number,
): Promise<PlannedKnowledgeChunk[]> {
  const parts: Array<{ text: string; tokenCount: number }> = [];
  let remaining = chunk.text.trim();
  while (remaining) {
    const complete = await backend.countDocuments([remaining]);
    const completeCount = complete.tokenCounts[0];
    if (completeCount === undefined) throw new Error("Inference service omitted an oversized chunk token count.");
    if (completeCount <= maximumInputTokens) {
      parts.push({ text: remaining, tokenCount: completeCount });
      break;
    }
    const boundary = await largestFittingBoundary(backend, remaining, maximumInputTokens);
    const preferred = preferredTextBoundary(remaining, boundary);
    const text = remaining.slice(0, preferred).trim();
    if (!text) throw new Error(`Could not split oversized semantic chunk ${chunk.metadata.id}.`);
    const counted = await backend.countDocuments([text]);
    const tokenCount = counted.tokenCounts[0];
    if (tokenCount === undefined || tokenCount > maximumInputTokens) {
      throw new Error(`Tokenizer split for ${chunk.metadata.id} exceeded the active model budget.`);
    }
    parts.push({ text, tokenCount });
    remaining = remaining.slice(preferred).trim();
  }
  return parts.map((part, index) => {
    const chunkHash = semanticTextHash(part.text);
    return {
      text: part.text,
      metadata: {
        ...chunk.metadata,
        id: createSemanticChunkId({
          path: chunk.metadata.path,
          key: `${chunk.metadata.id}:token-part:${index}`,
          chunkHash,
          startByte: chunk.metadata.range.start.byte,
          endByte: chunk.metadata.range.end.byte,
        }),
        chunkHash,
        tokenCount: part.tokenCount,
        preview: semanticPreview(part.text),
      },
    };
  });
}

async function largestFittingBoundary(
  backend: SemanticEmbeddingBackend,
  text: string,
  maximumInputTokens: number,
): Promise<number> {
  let low = 1;
  let high = text.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const result = await backend.countDocuments([text.slice(0, middle)]);
    const count = result.tokenCounts[0];
    if (count === undefined) throw new Error("Inference service omitted a token split count.");
    if (count <= maximumInputTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best < 1) throw new Error("The active embedding model cannot fit a single character after its document prefix.");
  return best;
}

function preferredTextBoundary(text: string, maximumBoundary: number): number {
  const newline = text.lastIndexOf("\n", maximumBoundary);
  if (newline >= Math.floor(maximumBoundary / 2)) return newline + 1;
  const whitespace = text.lastIndexOf(" ", maximumBoundary);
  if (whitespace >= Math.floor(maximumBoundary / 2)) return whitespace + 1;
  return maximumBoundary;
}

async function embedDocumentsInBatches(
  backend: SemanticEmbeddingBackend,
  texts: string[],
  onProgress?: ((completed: number, total: number) => void) | undefined,
): Promise<number[][]> {
  const vectors: number[][] = [];
  let batch: string[] = [];
  let batchChars = 0;
  for (const text of texts) {
    const textChars = text.length;
    const nextWouldExceedCount = batch.length >= MaxEmbeddingBatchTexts;
    const nextWouldExceedChars = batch.length > 0 && batchChars + textChars > MaxEmbeddingBatchChars;
    if (nextWouldExceedCount || nextWouldExceedChars) {
      vectors.push(...await backend.embedDocuments(batch));
      onProgress?.(vectors.length, texts.length);
      batch = [];
      batchChars = 0;
    }
    batch.push(text);
    batchChars += textChars;
  }
  if (batch.length > 0) {
    vectors.push(...await backend.embedDocuments(batch));
    onProgress?.(vectors.length, texts.length);
  }
  return vectors;
}

function uniquifySemanticChunkIds(chunks: PlannedKnowledgeChunk[]): PlannedKnowledgeChunk[] {
  const seenIds = new Set<string>();
  const duplicateCounts = new Map<string, number>();
  return chunks.map((chunk) => {
    if (!seenIds.has(chunk.metadata.id)) {
      seenIds.add(chunk.metadata.id);
      return chunk;
    }

    const duplicateIndex = (duplicateCounts.get(chunk.metadata.id) ?? 0) + 1;
    duplicateCounts.set(chunk.metadata.id, duplicateIndex);
    let nextId = createSemanticChunkId({
      path: chunk.metadata.path,
      key: `${chunk.metadata.id}:duplicate:${duplicateIndex}`,
      chunkHash: chunk.metadata.chunkHash,
      startByte: chunk.metadata.range.start.byte,
      endByte: chunk.metadata.range.end.byte,
    });
    let collisionIndex = duplicateIndex;
    while (seenIds.has(nextId)) {
      collisionIndex += 1;
      nextId = createSemanticChunkId({
        path: chunk.metadata.path,
        key: `${chunk.metadata.id}:duplicate:${collisionIndex}`,
        chunkHash: chunk.metadata.chunkHash,
        startByte: chunk.metadata.range.start.byte,
        endByte: chunk.metadata.range.end.byte,
      });
    }
    seenIds.add(nextId);
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        id: nextId,
      },
    };
  });
}

function collectRuntimeSemanticChunks(
  input: Pick<ProjectSemanticIndexBuildInput, "rootDir" | "scan" | "facts" | "runtimeChunks">,
  diagnostics: SemanticIndexDiagnostic[],
  onlyPaths?: Set<string> | undefined,
): RuntimeSemanticChunk[] {
  if (input.runtimeChunks) {
    return onlyPaths
      ? input.runtimeChunks.filter((chunk) => onlyPaths.has(chunk.metadata.path))
      : input.runtimeChunks;
  }
  return collectRuntimeKnowledgeChunks({ ...input, onlyPaths }, diagnostics);
}

function runtimeChunksWithEmbeddingHash(runtimeChunks: PlannedKnowledgeChunk[], provider: SemanticEmbeddingProvider): Array<{
  metadata: SemanticChunkMetadata;
  text: string;
}> {
  return uniquifySemanticChunkIds(runtimeChunks).map((chunk) => ({
    metadata: {
      ...chunk.metadata,
      embeddingHash: semanticEmbeddingRecordHash({
        chunkHash: chunk.metadata.chunkHash,
        providerId: provider.id,
        modelId: provider.modelId,
        modelDigest: provider.modelDigest,
        dimensions: provider.dimensions,
        configHash: provider.configHash,
        chunkerVersion: SemanticChunkerVersion,
        producerVersion: semanticIndexProducerVersion(),
      }),
    },
    text: chunk.text,
  }));
}

export async function semanticSearchVectorForProvider(input: {
  query: string;
  provider?: SemanticEmbeddingProvider | null | undefined;
  inference: ServiceInferenceClient;
  rootDir: string;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
  signal?: AbortSignal | undefined;
}): Promise<number[]> {
  if (!input.provider) {
    throw new Error("Semantic search requires ready Project Knowledge. Run opencanon project index.");
  }
  if (input.provider.kind === SemanticEmbeddingProviderKind.Gguf) {
    return await serviceEmbeddingBackend(input.inference, input.rootDir, ggufSemanticEmbeddingConfig(input.provider, input.semanticEmbedding), input.signal).embedQuery(input.query);
  }
  throw new Error(`Unsupported semantic search provider ${input.provider.kind}.`);
}

export type SemanticEmbeddingBackend = {
  provider: SemanticEmbeddingProvider;
  diagnostics: SemanticIndexDiagnostic[];
  countDocuments(texts: string[]): Promise<{ tokenCounts: number[]; maximumInputTokens: number }>;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export function configuredSemanticEmbeddingProvider(inputConfig?: SemanticEmbeddingConfig | undefined): {
  provider: SemanticEmbeddingProvider;
  diagnostics: SemanticIndexDiagnostic[];
} {
  const selection = resolveSemanticEmbeddingConfig(inputConfig);
  if (!selection.ok) {
    return { provider: ggufEmbeddingProvider(DefaultSemanticEmbeddingConfig), diagnostics: selection.diagnostics };
  }
  return { provider: ggufEmbeddingProvider(selection.config), diagnostics: selection.diagnostics };
}

export function createSemanticEmbeddingBackend(
  inference: ServiceInferenceClient,
  rootDir: string,
  inputConfig?: SemanticEmbeddingConfig | undefined,
  signal?: AbortSignal | undefined,
): SemanticEmbeddingBackend {
  const selection = resolveSemanticEmbeddingConfig(inputConfig);
  if (!selection.ok) {
    const provider = configuredSemanticEmbeddingProvider(inputConfig).provider;
    return unavailableEmbeddingBackend(provider, selection.diagnostics);
  }
  const modelId = selection.config.modelId;
  const model = semanticEmbeddingModel(modelId);
  if (model.providerKind === SemanticEmbeddingProviderKind.Gguf) {
    const backend = serviceEmbeddingBackend(inference, rootDir, selection.config, signal);
    return { ...backend, diagnostics: selection.diagnostics };
  }
  return unavailableEmbeddingBackend(ggufEmbeddingProvider(selection.config), [
    ...selection.diagnostics,
    {
      code: "semantic-service-provider-unavailable",
      message: `Semantic embedding model ${modelId} is not supported by the service inference provider.`,
      severity: DiagnosticSeverity.Error,
    },
  ]);
}

function serviceEmbeddingBackend(
  inference: ServiceInferenceClient,
  rootDir: string,
  config: SemanticEmbeddingConfig,
  signal?: AbortSignal | undefined,
): SemanticEmbeddingBackend {
  const provider = ggufEmbeddingProvider(config);
  return {
    provider,
    diagnostics: [],
    async countDocuments(texts) {
      const result = await inference.countTokens({
        rootDir,
        modelId: config.modelId,
        task: InferenceTaskKind.Document,
        priority: InferencePriority.Background,
        texts,
        signal,
      });
      return { tokenCounts: result.tokenCounts, maximumInputTokens: result.model.maximumInputTokens };
    },
    async embedDocuments(texts) {
      const result = await inference.embed({
        rootDir,
        modelId: config.modelId,
        task: InferenceTaskKind.Document,
        priority: InferencePriority.Background,
        texts,
        expectedModelDigest: provider.modelDigest,
        signal,
      });
      assertEmbeddingResult(provider, result);
      return result.vectors;
    },
    async embedQuery(text) {
      const result = await inference.embed({
        rootDir,
        modelId: config.modelId,
        task: InferenceTaskKind.Query,
        priority: InferencePriority.Interactive,
        texts: [text],
        expectedModelDigest: provider.modelDigest,
        signal,
      });
      assertEmbeddingResult(provider, result);
      return result.vectors[0] ?? [];
    },
  };
}

function ggufEmbeddingProvider(config: SemanticEmbeddingConfig): SemanticEmbeddingProvider {
  const model = semanticEmbeddingModel(config.modelId);
  const modelDigest = semanticEmbeddingConfigHash(model.config);
  const configHash = semanticEmbeddingConfigHash(model.config);
  return {
    id: `opencanon-gguf-${model.id}`,
    kind: model.providerKind,
    displayName: model.displayName,
    modelId: model.id,
    modelDigest,
    dimensions: model.dimensions,
    distance: model.distance,
    configHash,
  };
}

function unavailableEmbeddingBackend(provider: SemanticEmbeddingProvider, diagnostics: SemanticIndexDiagnostic[]): SemanticEmbeddingBackend {
  const message = diagnostics.map((diagnostic) => diagnostic.message).join(" ");
  return {
    provider,
    diagnostics,
    countDocuments() {
      throw new Error(message);
    },
    embedDocuments() {
      throw new Error(message);
    },
    embedQuery() {
      throw new Error(message);
    },
  };
}

function resolveSemanticEmbeddingConfig(input?: SemanticEmbeddingConfig | undefined): (
  | { ok: true; config: SemanticEmbeddingConfig; diagnostics: SemanticIndexDiagnostic[] }
  | { ok: false; diagnostics: SemanticIndexDiagnostic[] }
) {
  const config = input ?? DefaultSemanticEmbeddingConfig;
  const ids = semanticEmbeddingModelIds();
  if (!ids.includes(config.modelId as SemanticEmbeddingModelId)) {
    return {
      ok: false,
      diagnostics: [{
        code: "semantic-embedding-config-invalid",
        message: `Unknown semantic embedding model ${String(config.modelId)}. Set semanticEmbedding.modelId to one of: ${ids.join(", ")}.`,
        severity: DiagnosticSeverity.Error,
      }],
    };
  }
  const model = semanticEmbeddingModel(config.modelId);
  if (config.provider !== model.providerKind) {
    return {
      ok: false,
      diagnostics: [{
        code: "semantic-embedding-config-invalid",
        message: `Semantic embedding provider ${config.provider} does not match model ${config.modelId}.`,
        severity: DiagnosticSeverity.Error,
      }],
    };
  }
  return { ok: true, config, diagnostics: [] };
}

function ggufSemanticEmbeddingConfig(provider: SemanticEmbeddingProvider, input?: SemanticEmbeddingConfig | undefined): SemanticEmbeddingConfig {
  const config = input ?? DefaultSemanticEmbeddingConfig;
  const ids = semanticEmbeddingModelIds();
  if (config.provider !== SemanticEmbeddingProviderKind.Gguf) {
    throw new Error(`Semantic search index uses GGUF model ${provider.modelId}, but project semanticEmbedding is not GGUF.`);
  }
  if (!ids.includes(config.modelId)) {
    throw new Error(`Unknown semantic embedding model ${config.modelId}.`);
  }
  if (config.modelId !== provider.modelId) {
    throw new Error(`Semantic search index uses ${provider.modelId}, but project config requires ${config.modelId}. Run opencanon project index.`);
  }
  return config;
}

function assertEmbeddingResult(
  provider: SemanticEmbeddingProvider,
  result: { model: { modelId: string; modelDigest?: string; dimensions: number }; vectors: number[][] },
): void {
  if (result.model.modelId !== provider.modelId || result.model.dimensions !== provider.dimensions || result.model.modelDigest !== provider.modelDigest) {
    throw new Error(`Inference response identity does not match Project Knowledge provider ${provider.modelId}.`);
  }
  for (const vector of result.vectors) {
    if (vector.length !== provider.dimensions) {
      throw new Error(`Expected ${provider.dimensions} dimensions from ${provider.modelId}, got ${vector.length}.`);
    }
  }
}

function hasSemanticIndexError(diagnostics: SemanticIndexDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error);
}

type RuntimeSemanticChunk = RuntimeKnowledgeChunk;

export function semanticIndexProducerVersion(): string {
  return `${SemanticEmbeddingProducerVersion}:${knowledgeProducerIdentity()}`;
}
