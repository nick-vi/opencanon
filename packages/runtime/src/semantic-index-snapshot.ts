import {
  DefaultSemanticIndexId,
  DiagnosticSeverity,
  SemanticChunkerVersion,
  SemanticIndexVersion,
  semanticChunkTreeHash,
  semanticEmbeddingIdentityHash,
  type SemanticChunkMetadata,
  type SemanticEmbeddingConfig,
  type SemanticEmbeddingProvider,
  type SemanticIndexDiagnostic,
  type SemanticIndexSnapshot,
} from "@opencanon/core";
import type { ProjectStore } from "./state.ts";
import { configuredSemanticEmbeddingProvider, semanticIndexProducerVersion } from "./semantic-index.ts";

const SemanticChunkMetadataPageSize = 500;

const SemanticIndexStatus = {
  Failed: "failed",
  Stale: "stale",
} as const;

export function listPreviousSemanticChunks(store: ProjectStore): SemanticChunkMetadata[] {
  const chunks: SemanticChunkMetadata[] = [];
  for (let offset = 0; ; offset += SemanticChunkMetadataPageSize) {
    const page = store.listSemanticChunks({
      indexId: DefaultSemanticIndexId,
      limit: SemanticChunkMetadataPageSize,
      offset,
    });
    chunks.push(...page.chunks);
    if (page.chunks.length < SemanticChunkMetadataPageSize) return chunks;
  }
}

export function cachedSemanticIndexSnapshot(input: {
  scan: { inventoryHash: string };
  store: ProjectStore;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
}): SemanticIndexSnapshot {
  const providerCheck = configuredSemanticEmbeddingProvider(input.semanticEmbedding);
  const previous = input.store.readSemanticIndexStatus({ indexId: DefaultSemanticIndexId }).index;
  if (hasSemanticIndexError(providerCheck.diagnostics)) {
    return failedSemanticIndexSnapshot({
      sourceInventoryHash: input.scan.inventoryHash,
      provider: providerCheck.provider,
      diagnostics: providerCheck.diagnostics,
    });
  }
  if (previous) {
    if (!semanticIndexCacheCompatible(previous, providerCheck.provider)) {
      return resetIncompatibleSemanticIndexSnapshot({
        sourceInventoryHash: input.scan.inventoryHash,
        semanticEmbedding: input.semanticEmbedding,
        previous,
      });
    }
    const sourceCurrent = previous.sourceInventoryHash === input.scan.inventoryHash;
    const current = sourceCurrent;
    return {
      ...previous,
      status: current ? previous.status : "stale",
      sourceInventoryHash: sourceCurrent ? previous.sourceInventoryHash : input.scan.inventoryHash,
      staleChunkCount: current ? previous.staleChunkCount : Math.max(previous.staleChunkCount, previous.chunkCount),
      diagnostics: current
        ? previous.diagnostics
        : [
            ...previous.diagnostics.filter((diagnostic) => diagnostic.code !== "semantic-index-stale-on-startup"),
            ...semanticProviderChangedDiagnostics(previous.provider, providerCheck.provider).filter(
              (diagnostic) => !previous.diagnostics.some((existing) => existing.code === diagnostic.code),
            ),
            {
              code: "semantic-index-stale-on-startup",
              message: "Project Knowledge is stale and needs an index run.",
              severity: DiagnosticSeverity.Info,
            },
          ],
    };
  }
  return missingSemanticIndexSnapshot(input.scan.inventoryHash, input.semanticEmbedding);
}

export function cachedStartupSemanticIndexSnapshot(
  store: ProjectStore,
  semanticEmbedding?: SemanticEmbeddingConfig | undefined,
): SemanticIndexSnapshot {
  const providerCheck = configuredSemanticEmbeddingProvider(semanticEmbedding);
  const previous = store.readSemanticIndexStatus({ indexId: DefaultSemanticIndexId }).index;
  if (hasSemanticIndexError(providerCheck.diagnostics)) {
    return failedSemanticIndexSnapshot({
      sourceInventoryHash: previous?.sourceInventoryHash ?? "startup-unscanned",
      provider: providerCheck.provider,
      diagnostics: providerCheck.diagnostics,
    });
  }
  if (previous) {
    if (!semanticIndexCacheCompatible(previous, providerCheck.provider)) {
      return resetIncompatibleSemanticIndexSnapshot({
        sourceInventoryHash: "startup-unscanned",
        semanticEmbedding,
        previous,
      });
    }
    const status = previous.status === SemanticIndexStatus.Failed ? SemanticIndexStatus.Failed : SemanticIndexStatus.Stale;
    return {
      ...previous,
      status,
      staleChunkCount: status === SemanticIndexStatus.Failed ? previous.staleChunkCount : Math.max(previous.staleChunkCount, previous.chunkCount),
      diagnostics: [
        ...previous.diagnostics.filter((diagnostic) => diagnostic.code !== "semantic-index-unverified-on-startup"),
        ...semanticProviderChangedDiagnostics(previous.provider, providerCheck.provider).filter(
          (diagnostic) => !previous.diagnostics.some((existing) => existing.code === diagnostic.code),
        ),
        {
          code: "semantic-index-unverified-on-startup",
        message: "Cached Project Knowledge was reused without a startup source scan. Run opencanon project index to verify Search and Ask freshness.",
          severity: DiagnosticSeverity.Info,
        },
      ],
    };
  }
  return missingSemanticIndexSnapshot("startup-unscanned", semanticEmbedding);
}

function missingSemanticIndexSnapshot(sourceInventoryHash: string, semanticEmbedding?: SemanticEmbeddingConfig | undefined): SemanticIndexSnapshot {
  const providerCheck = configuredSemanticEmbeddingProvider(semanticEmbedding);
  if (hasSemanticIndexError(providerCheck.diagnostics)) {
    return failedSemanticIndexSnapshot({
      sourceInventoryHash,
      provider: providerCheck.provider,
      diagnostics: providerCheck.diagnostics,
    });
  }
  const provider = providerCheck.provider;
  const producerVersion = semanticIndexProducerVersion();
  const identityHash = semanticEmbeddingIdentityHash({
    providerId: provider.id,
    modelId: provider.modelId,
    modelDigest: provider.modelDigest,
    dimensions: provider.dimensions,
    configHash: provider.configHash,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
  });
  return {
    id: DefaultSemanticIndexId,
    version: SemanticIndexVersion,
    status: "stale",
    provider,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
    sourceInventoryHash,
    chunkTreeHash: semanticChunkTreeHash([]),
    identityHash,
    chunkCount: 0,
    vectorCount: 0,
    staleChunkCount: 0,
    embeddingStats: {
      totalChunks: 0,
      embeddedChunks: 0,
      reusedChunks: 0,
    },
    indexedAt: new Date().toISOString(),
    diagnostics: [
      {
        code: "semantic-index-missing-on-startup",
        message: "Project Knowledge has not been built yet. Run opencanon project index to build Search and Ask retrieval.",
        severity: DiagnosticSeverity.Info,
      },
    ],
  };
}

function resetIncompatibleSemanticIndexSnapshot(input: {
  sourceInventoryHash: string;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
  previous: SemanticIndexSnapshot;
}): SemanticIndexSnapshot {
  const next = {
    ...missingSemanticIndexSnapshot(input.sourceInventoryHash, input.semanticEmbedding),
  };
  const diagnostics = [
    ...next.diagnostics,
    ...semanticIndexCacheResetDiagnostics(input.previous, next),
  ];
  return { ...next, diagnostics };
}

function failedSemanticIndexSnapshot(input: {
  sourceInventoryHash: string;
  provider: SemanticEmbeddingProvider;
  diagnostics: SemanticIndexDiagnostic[];
}): SemanticIndexSnapshot {
  const producerVersion = semanticIndexProducerVersion();
  const identityHash = semanticEmbeddingIdentityHash({
    providerId: input.provider.id,
    modelId: input.provider.modelId,
    modelDigest: input.provider.modelDigest,
    dimensions: input.provider.dimensions,
    configHash: input.provider.configHash,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
  });
  return {
    id: DefaultSemanticIndexId,
    version: SemanticIndexVersion,
    status: SemanticIndexStatus.Failed,
    provider: input.provider,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion,
    sourceInventoryHash: input.sourceInventoryHash,
    chunkTreeHash: semanticChunkTreeHash([]),
    identityHash,
    chunkCount: 0,
    vectorCount: 0,
    staleChunkCount: 0,
    embeddingStats: {
      totalChunks: 0,
      embeddedChunks: 0,
      reusedChunks: 0,
    },
    indexedAt: new Date().toISOString(),
    diagnostics: input.diagnostics,
  };
}

function semanticIndexCacheCompatible(index: SemanticIndexSnapshot, provider: SemanticEmbeddingProvider): boolean {
  return (
    index.version === SemanticIndexVersion &&
    index.chunkerVersion === SemanticChunkerVersion &&
    index.producerVersion === semanticIndexProducerVersion() &&
    semanticProvidersMatch(index.provider, provider)
  );
}

function semanticProvidersMatch(left: SemanticEmbeddingProvider, right: SemanticEmbeddingProvider): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.modelId === right.modelId &&
    left.modelDigest === right.modelDigest &&
    left.dimensions === right.dimensions &&
    left.configHash === right.configHash
  );
}

function semanticIndexCacheResetDiagnostics(previous: SemanticIndexSnapshot, current: SemanticIndexSnapshot): SemanticIndexDiagnostic[] {
  const diagnostics: SemanticIndexDiagnostic[] = [];
  if (previous.version !== SemanticIndexVersion) {
    diagnostics.push({
      code: "semantic-index-version-changed",
      message: `Project Knowledge version changed from ${previous.version} to ${SemanticIndexVersion}. Run opencanon project index --force to rebuild derived retrieval state.`,
      severity: DiagnosticSeverity.Info,
    });
  }
  if (previous.chunkerVersion !== SemanticChunkerVersion || previous.producerVersion !== semanticIndexProducerVersion()) {
    diagnostics.push({
      code: "semantic-index-pipeline-changed",
      message: "Project Knowledge indexing pipeline changed. Run opencanon project index --force to rebuild derived retrieval state.",
      severity: DiagnosticSeverity.Info,
    });
  }
  diagnostics.push(...semanticProviderChangedDiagnostics(previous.provider, current.provider));
  return diagnostics;
}

function semanticProviderChangedDiagnostics(previous: SemanticEmbeddingProvider, configured: SemanticEmbeddingProvider): SemanticIndexDiagnostic[] {
  if (semanticProvidersMatch(previous, configured)) return [];
  return [{
    code: "semantic-index-provider-changed",
    message: `Project Knowledge used ${previous.modelId}, but project config requires ${configured.modelId}. Run opencanon project index --force to rebuild derived retrieval state.`,
    severity: DiagnosticSeverity.Info,
  }];
}

function hasSemanticIndexError(diagnostics: SemanticIndexDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error);
}
