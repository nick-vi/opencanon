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
import type { EngineProject } from "@opencanon/engine";
import { collectRuntimeKnowledgeChunks, knowledgeProducerIdentity, type RuntimeKnowledgeChunk } from "./knowledge-producers.ts";
import { semanticIndexAncestorNodeKeys, semanticIndexNodesForChunks } from "./semantic-index-nodes.ts";

const MaxEmbeddingBatchTexts = 128;
const MaxEmbeddingBatchChars = 256_000;

export type ProjectSemanticIndexBuildInput = {
  rootDir: string;
  scan: ScanAndDiffResult;
  facts: FileFacts[];
  project?: EngineProject | undefined;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
  previousChunks?: SemanticChunkMetadata[] | undefined;
};

export type ProjectSemanticIndexDeltaInput = ProjectSemanticIndexBuildInput & {
  previousIndex: SemanticIndexSnapshot;
  previousChunks: SemanticChunkMetadata[];
};

export function buildProjectSemanticIndex(input: ProjectSemanticIndexBuildInput): WriteSemanticIndexRequest {
  const backend = createSemanticEmbeddingBackend(input.project, input.semanticEmbedding);
  const provider = backend.provider;
  const producerVersion = semanticIndexProducerVersion();
  const diagnostics: SemanticIndexDiagnostic[] = [];
  diagnostics.push(...backend.diagnostics);
  const runtimeChunks = collectRuntimeSemanticChunks(input, diagnostics);

  const chunksWithEmbeddingHash = runtimeChunksWithEmbeddingHash(runtimeChunks, provider);
  const previousEmbeddingHashes = new Map((input.previousChunks ?? []).map((chunk) => [chunk.id, chunk.embeddingHash]));
  const chunksNeedingEmbedding = chunksWithEmbeddingHash.filter((chunk) => previousEmbeddingHashes.get(chunk.metadata.id) !== chunk.metadata.embeddingHash);
  const reusedChunkCount = chunksWithEmbeddingHash.length - chunksNeedingEmbedding.length;
  const vectorsByChunkId = new Map<string, number[]>();
  let vectors: number[][] = [];
  if (chunksNeedingEmbedding.length > 0 && !hasSemanticIndexError(diagnostics)) {
    try {
      vectors = embedDocumentsInBatches(backend, chunksNeedingEmbedding.map((chunk) => chunk.text));
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
    },
    indexedAt: new Date().toISOString(),
    diagnostics,
  };
  return { index, chunks, nodes: semanticIndexNodesForChunks(chunks.map((chunk) => chunk.metadata)) };
}

export function buildProjectSemanticIndexDelta(input: ProjectSemanticIndexDeltaInput): WriteSemanticIndexDeltaRequest {
  const backend = createSemanticEmbeddingBackend(input.project, input.semanticEmbedding);
  const provider = backend.provider;
  const producerVersion = semanticIndexProducerVersion();
  const diagnostics: SemanticIndexDiagnostic[] = [];
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
  const changedRuntimeChunks = collectRuntimeSemanticChunks(input, diagnostics, changedPaths);
  const changedChunksWithEmbeddingHash = runtimeChunksWithEmbeddingHash(changedRuntimeChunks, provider);
  const previousRetainedChunks = input.previousChunks.filter((chunk) => !changedPaths.has(chunk.path) && !deletedPaths.has(chunk.path));
  const finalMetadata = [...previousRetainedChunks, ...changedChunksWithEmbeddingHash.map((chunk) => chunk.metadata)]
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  const vectorsByChunkId = new Map<string, number[]>();
  let vectors: number[][] = [];
  if (changedChunksWithEmbeddingHash.length > 0 && !hasSemanticIndexError(diagnostics)) {
    try {
      vectors = embedDocumentsInBatches(backend, changedChunksWithEmbeddingHash.map((chunk) => chunk.text));
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

function embedDocumentsInBatches(backend: SemanticEmbeddingBackend, texts: string[]): number[][] {
  const vectors: number[][] = [];
  let batch: string[] = [];
  let batchChars = 0;
  for (const text of texts) {
    const textChars = text.length;
    const nextWouldExceedCount = batch.length >= MaxEmbeddingBatchTexts;
    const nextWouldExceedChars = batch.length > 0 && batchChars + textChars > MaxEmbeddingBatchChars;
    if (nextWouldExceedCount || nextWouldExceedChars) {
      vectors.push(...backend.embedDocuments(batch));
      batch = [];
      batchChars = 0;
    }
    batch.push(text);
    batchChars += textChars;
  }
  if (batch.length > 0) vectors.push(...backend.embedDocuments(batch));
  return vectors;
}

function uniquifySemanticChunkIds(chunks: RuntimeSemanticChunk[]): RuntimeSemanticChunk[] {
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
  input: Pick<ProjectSemanticIndexBuildInput, "rootDir" | "scan" | "facts">,
  diagnostics: SemanticIndexDiagnostic[],
  onlyPaths?: Set<string> | undefined,
): RuntimeSemanticChunk[] {
  return collectRuntimeKnowledgeChunks({ ...input, onlyPaths }, diagnostics);
}

function runtimeChunksWithEmbeddingHash(runtimeChunks: RuntimeSemanticChunk[], provider: SemanticEmbeddingProvider): Array<{
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

export function semanticSearchVectorForProvider(input: {
  query: string;
  provider?: SemanticEmbeddingProvider | null | undefined;
  project?: EngineProject | undefined;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
}): number[] {
  if (!input.provider) {
    throw new Error("Semantic search requires ready Project Knowledge. Run opencanon project index.");
  }
  if (input.provider.kind === SemanticEmbeddingProviderKind.Native) {
    if (!input.project) {
      throw new Error(`Semantic search index uses ${input.provider.modelId}, but no native engine project is available.`);
    }
    return nativeEmbeddingBackend(input.project, nativeSemanticEmbeddingConfig(input.provider, input.semanticEmbedding)).embedQuery(input.query);
  }
  throw new Error(`Unsupported semantic search provider ${input.provider.kind}.`);
}

export type SemanticEmbeddingBackend = {
  provider: SemanticEmbeddingProvider;
  diagnostics: SemanticIndexDiagnostic[];
  embedDocuments(texts: string[]): number[][];
  embedQuery(text: string): number[];
};

export function configuredSemanticEmbeddingProvider(inputConfig?: SemanticEmbeddingConfig | undefined): {
  provider: SemanticEmbeddingProvider;
  diagnostics: SemanticIndexDiagnostic[];
} {
  const selection = resolveSemanticEmbeddingConfig(inputConfig);
  if (!selection.ok) {
    return { provider: nativeEmbeddingProvider(DefaultSemanticEmbeddingConfig), diagnostics: selection.diagnostics };
  }
  return { provider: nativeEmbeddingProvider(selection.config), diagnostics: selection.diagnostics };
}

export function createSemanticEmbeddingBackend(project?: EngineProject | undefined, inputConfig?: SemanticEmbeddingConfig | undefined): SemanticEmbeddingBackend {
  const selection = resolveSemanticEmbeddingConfig(inputConfig);
  if (!selection.ok) {
    const provider = configuredSemanticEmbeddingProvider(inputConfig).provider;
    return unavailableEmbeddingBackend(provider, selection.diagnostics);
  }
  const modelId = selection.config.modelId;
  const model = semanticEmbeddingModel(modelId);
  if (model.providerKind === SemanticEmbeddingProviderKind.Native && project) {
    const backend = nativeEmbeddingBackend(project, selection.config);
    return { ...backend, diagnostics: selection.diagnostics };
  }
  return unavailableEmbeddingBackend(nativeEmbeddingProvider(selection.config), [
    ...selection.diagnostics,
    {
      code: "semantic-native-provider-unavailable",
      message: `Semantic embedding model ${modelId} requires a native engine project.`,
      severity: DiagnosticSeverity.Error,
    },
  ]);
}

function nativeEmbeddingBackend(project: EngineProject, config: SemanticEmbeddingConfig): SemanticEmbeddingBackend {
  const provider = nativeEmbeddingProvider(config);
  const requestOptions = nativeEmbeddingOptions(config);
  return {
    provider,
    diagnostics: [],
    embedDocuments(texts) {
      const result = project.embedSemanticTexts({
        modelId: config.modelId,
        task: "document",
        texts,
        ...requestOptions,
      });
      assertEmbeddingResult(provider, result.vectors);
      return result.vectors;
    },
    embedQuery(text) {
      const result = project.embedSemanticTexts({
        modelId: config.modelId,
        task: "query",
        texts: [text],
        ...requestOptions,
      });
      assertEmbeddingResult(provider, result.vectors);
      return result.vectors[0] ?? [];
    },
  };
}

function nativeEmbeddingProvider(config: SemanticEmbeddingConfig): SemanticEmbeddingProvider {
  const model = semanticEmbeddingModel(config.modelId);
  const options = nativeEmbeddingOptions(config);
  const modelDigest = semanticEmbeddingConfigHash(model.config);
  const configHash = semanticEmbeddingConfigHash({
    ...model.config,
    nCtx: options.nCtx ?? model.contextLength,
  });
  return {
    id: `opencanon-native-${model.id}`,
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
  if (config.mode !== model.providerKind) {
    return {
      ok: false,
      diagnostics: [{
        code: "semantic-embedding-config-invalid",
        message: `Semantic embedding mode ${config.mode} does not match model ${config.modelId}.`,
        severity: DiagnosticSeverity.Error,
      }],
    };
  }
  return { ok: true, config, diagnostics: [] };
}

function nativeSemanticEmbeddingConfig(provider: SemanticEmbeddingProvider, input?: SemanticEmbeddingConfig | undefined): SemanticEmbeddingConfig {
  const config = input ?? DefaultSemanticEmbeddingConfig;
  const ids = semanticEmbeddingModelIds();
  if (config.mode !== SemanticEmbeddingProviderKind.Native) {
    throw new Error(`Semantic search index uses native model ${provider.modelId}, but project semanticEmbedding is not native.`);
  }
  if (!ids.includes(config.modelId)) {
    throw new Error(`Unknown semantic embedding model ${config.modelId}.`);
  }
  if (config.modelId !== provider.modelId) {
    throw new Error(`Semantic search index uses ${provider.modelId}, but project config requires ${config.modelId}. Run opencanon project index.`);
  }
  return config;
}

function nativeEmbeddingOptions(config: SemanticEmbeddingConfig): {
  nGpuLayers?: number | undefined;
  nThreads?: number | undefined;
  nCtx?: number | undefined;
  showDownloadProgress: boolean;
} {
  return {
    nGpuLayers: config.nGpuLayers,
    nThreads: config.nThreads,
    nCtx: config.nCtx,
    showDownloadProgress: config.showDownloadProgress,
  };
}

function assertEmbeddingResult(provider: SemanticEmbeddingProvider, vectors: number[][]): void {
  for (const vector of vectors) {
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
